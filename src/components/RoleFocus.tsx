// 角色首頁「關鍵焦點」：依角色顯示專屬重點卡片與相關警示
import { useMemo, type ReactNode } from 'react';
import { useApp } from '../context/AppContext';
import { contractRows, type Alert } from '../lib/alerts';
import { addMonths, groupSummary, inRange, summarize, type Model, type ViewLine } from '../lib/engine';
import { fmtPct, fmtPrice, fmtSignedPct, fmtWan, growth } from '../lib/format';
import { Delta, SeverityTag } from './ui';

interface Focus { cards: { label: string; value: ReactNode; sub?: ReactNode; link?: string }[]; alerts: Alert[]; who: string }

export const SALES_REP = 'R1'; // demo：業務角色以林志明（ODM 負責人）登入

export default function RoleFocus() {
  const ctx = useApp();
  const { roleId, navigate } = ctx;
  const focus = useMemo(() => buildFocus(roleId, ctx.model, ctx.lines, ctx.period, ctx.alerts), [roleId, ctx.model, ctx.lines, ctx.period, ctx.alerts]);

  return (
    <section className="focus">
      <header>
        <h3>關鍵焦點</h3>
        <span className="focus-hint">切換左下角角色，這一區的內容會跟著變</span>
      </header>
      <div className="focus-body">
        <div className="focus-cards">
          {focus.cards.map((c) => (
            <div key={c.label} className={`focus-card ${c.link ? 'clickable' : ''}`} onClick={c.link ? () => navigate(c.link!) : undefined}>
              <span>{c.label}</span>
              <b>{c.value}</b>
              {c.sub && <small>{c.sub}</small>}
            </div>
          ))}
        </div>
        <ul className="focus-alerts">
          {focus.alerts.length === 0 && <li className="muted">目前沒有需要處理的警示</li>}
          {focus.alerts.slice(0, 4).map((a) => (
            <li key={a.id} onClick={() => navigate(a.link)}><SeverityTag s={a.severity} /><span>{a.title}</span></li>
          ))}
          {focus.alerts.length > 4 && <li className="muted">還有 {focus.alerts.length - 4} 則</li>}
        </ul>
      </div>
    </section>
  );
}

function last12(model: Model, lines: ViewLine[]) {
  const from = addMonths(model.currentMonth, -11);
  return lines.filter((l) => l.month >= from);
}

/** 報價缺口：要回到報價時毛利率，近 12 個月的量需要多賺多少 */
function contractGap(model: Model, lines: ViewLine[], filter: (cid: string) => boolean) {
  const l12 = groupSummary(last12(model, lines), (l) => `${l.customer_id}|${l.item_id}`);
  const rows = contractRows(model).filter((r) => r.severity && filter(r.customer_id));
  const gap = rows.reduce((s, r) => {
    const target = r.currentCost / (1 - r.quoteMargin);
    return s + Math.max(0, target - r.price) * (l12.get(`${r.customer_id}|${r.item_id}`)?.qty ?? 0);
  }, 0);
  return { rows, gap };
}

function buildFocus(roleId: string, model: Model, lines: ViewLine[], period: ReturnType<typeof useApp>['period'], alerts: Alert[]): Focus {
  const cur = inRange(lines, period.cur);
  const yoyLines = period.yoy ? inRange(lines, period.yoy) : [];
  const custName = (id: string) => model.customers.get(id)?.name ?? id;
  const itemName = (id: string) => model.items.get(id)?.name ?? id;
  const cm = model.currentMonth;

  const materialMoves = model.raw.items.filter((i) => i.type === '原料').map((i) => ({
    i, g: model.price(i.item_id, cm) / model.price(i.item_id, addMonths(cm, -6)) - 1,
  })).sort((a, b) => b.g - a.g);

  const l12 = groupSummary(last12(model, lines), (l) => l.item_id);
  const annualMaterialImpact = model.raw.items.filter((i) => i.type === '原料' || i.type === '包材').reduce((s, it) => {
    const use = model.usedBy(it.item_id).reduce((u, f) => u + (l12.get(f)?.qty ?? 0) * (model.leafQty(f)[it.item_id] ?? 0), 0);
    return s + use * (model.price(it.item_id, cm) - model.price(it.item_id, model.months[0]));
  }, 0);

  const last = model.lastClosedMonth;
  const variance = [...groupSummary(lines.filter((l) => l.month === last), (l) => l.item_id)].map(([iid, s]) => {
    const act = model.actualUnitCost(iid, last) ?? 0;
    const est = model.unitCost(iid, last).total;
    return { iid, v: act / est - 1, amount: (act - est) * s.qty };
  }).sort((a, b) => b.v - a.v);

  switch (roleId) {
    case 'finance': {
      const varTotal = variance.reduce((s, x) => s + x.amount, 0);
      const ic = model.lines.filter((l) => l.is_ic && l.date >= period.cur.start && l.date <= period.cur.end).reduce((s, l) => s + l.revenue, 0);
      const est = cur.filter((l) => l.basis === 'estimate');
      const s = summarize(cur);
      const y = summarize(yoyLines);
      return {
        who: '', alerts: alerts.filter((a) => a.kind === '成本差異' || a.severity === 'critical'),
        cards: [
          { label: `${Number(last.slice(5))}月 實際 − 預估成本`, value: fmtWan(varTotal), sub: '正數 = 實際花得比預估多', link: '#/products' },
          { label: '本期內部交易（沖銷）', value: fmtWan(ic), sub: '示範食品 → 示範觀光' },
          { label: '尚未月結的營收', value: fmtWan(summarize(est).revenue), sub: '這部分毛利為預估值' },
          { label: '毛利率 vs 去年同期', value: fmtPct(s.gpPct), sub: <Delta value={period.yoy ? s.gpPct - y.gpPct : null} kind="pt" /> },
        ],
      };
    }
    case 'sales': {
      const mine = (cid: string) => model.customers.get(cid)?.rep_id === SALES_REP;
      const myCur = cur.filter((l) => mine(l.customer_id));
      const s = summarize(myCur);
      const y = summarize(yoyLines.filter((l) => mine(l.customer_id)));
      const { rows, gap } = contractGap(model, lines, mine);
      const myCustIds = new Set(model.raw.customers.filter((c) => c.rep_id === SALES_REP).map((c) => c.customer_id));
      return {
        who: model.repName(SALES_REP), alerts: alerts.filter((a) => (a.kind === '報價' || a.kind === '客戶') && [...myCustIds].some((id) => a.link.includes(`id=${id}`))),
        cards: [
          { label: '我的客戶營收', value: fmtWan(s.revenue), sub: <>去年同期 <Delta value={period.yoy ? growth(s.revenue, y.revenue) : null} /></> },
          { label: '我的客戶毛利率', value: fmtPct(s.gpPct), sub: <>去年同期 <Delta value={period.yoy ? s.gpPct - y.gpPct : null} kind="pt" /></> },
          { label: '需重新議價的合約', value: `${rows.length} 張`, sub: rows.slice(0, 2).map((r) => `${custName(r.customer_id)}・${itemName(r.item_id)}`).join('、') || '—', link: '#/customers' },
          { label: '議價可補回毛利（年）', value: fmtWan(gap), sub: '回到報價時毛利率所需', link: '#/customers' },
        ],
      };
    }
    case 'purchase': {
      const top = materialMoves.slice(0, 3);
      return {
        who: '', alerts: alerts.filter((a) => a.kind === '原料'),
        cards: [
          ...top.map((m, i) => ({ label: `近 6 個月漲幅第 ${i + 1}`, value: m.i.name, sub: `${fmtSignedPct(m.g)}・目前 ${fmtPrice(model.price(m.i.item_id, cm))}/${m.i.unit}`, link: `#/materials?id=${m.i.item_id}` })),
          { label: '原料漲價年化影響', value: fmtWan(annualMaterialImpact), sub: `相較 ${model.months[0].replace('-', '/')} 進價`, link: '#/materials' },
        ],
      };
    }
    case 'production': {
      const bad = variance.filter((x) => x.v >= 0.03);
      return {
        who: '', alerts: alerts.filter((a) => a.kind === '成本差異'),
        cards: [
          { label: `${Number(last.slice(5))}月 實際成本超標品項`, value: `${bad.length} 項`, sub: '實際高於預估 3% 以上' },
          ...variance.slice(0, 3).map((x, i) => ({ label: `差異第 ${i + 1}`, value: itemName(x.iid), sub: `${fmtSignedPct(x.v)}・多花 ${fmtWan(x.amount)}`, link: `#/products?id=${x.iid}` })),
        ],
      };
    }
    case 'rd': {
      const fg = model.raw.items.filter((i) => i.type === '成品').map((i) => ({
        i, g: model.unitCost(i.item_id, cm).total / model.unitCost(i.item_id, addMonths(cm, -12)).total - 1,
      })).sort((a, b) => b.g - a.g);
      return {
        who: '', alerts: alerts.filter((a) => a.kind === '原料' || a.kind === '成本差異'),
        cards: [
          ...fg.slice(0, 3).map((x, i) => ({ label: `配方成本漲幅第 ${i + 1}（近 12 月）`, value: x.i.name, sub: `${fmtSignedPct(x.g)}・目前 ${fmtPrice(model.unitCost(x.i.item_id, cm).total)}`, link: `#/products?id=${x.i.item_id}` })),
          { label: '漲最多的原料', value: materialMoves[0].i.name, sub: `近 6 個月 ${fmtSignedPct(materialMoves[0].g)}，可評估替代配方`, link: `#/materials?id=${materialMoves[0].i.item_id}` },
        ],
      };
    }
    default: { // boss
      const decide = alerts.filter((a) => a.severity !== 'warning');
      const { gap } = contractGap(model, lines, () => true);
      const g = groupSummary(cur, (l) => l.customer_id);
      const gy = groupSummary(yoyLines, (l) => l.customer_id);
      const moves = [...g].map(([id, s]) => ({ id, d: s.gp - (gy.get(id)?.gp ?? 0) })).sort((a, b) => a.d - b.d);
      const worst = moves[0];
      return {
        who: '', alerts: decide,
        cards: [
          { label: '待決策事項', value: `${decide.length} 項`, sub: '嚴重與注意等級的警示' },
          { label: '合約議價可補回毛利（年）', value: fmtWan(gap), sub: '低毛利合約回到報價時毛利率', link: '#/customers' },
          { label: '原料漲價年化影響', value: fmtWan(annualMaterialImpact), sub: `相較 ${model.months[0].replace('-', '/')} 進價`, link: '#/materials' },
          { label: '毛利衰退最多的客戶', value: worst ? custName(worst.id) : '—', sub: worst && period.yoy ? `vs 去年同期 ${fmtWan(worst.d)}` : '—', link: worst ? `#/customers?id=${worst.id}` : undefined },
        ],
      };
    }
  }
}
