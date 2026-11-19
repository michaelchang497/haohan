import { useApp } from '../context/AppContext';
import { fmtMoney, fmtPct, fmtWan } from '../lib/format';
import { SeverityTag, StatusIcon, Tip } from '../components/ui';
import SkillChat from '../components/SkillChat';
import { BASIS_LABEL, profitChat } from '../skills/profit/skill';
import type { AlertsResult, PricingResult, ProfitResult, QueryResult, VarianceResult } from '../skills/profit/tools';

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const pt = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)} pt`;
const sw = (n: number) => `${n >= 0 ? '+' : '−'}${fmtWan(Math.abs(n))}`;

export default function ProfitChat() {
  // demo：放一段「上週」的對話，示意資料更新後舊回答會標示過期（11/9 時 10 月還沒月結，是預估成本）
  const seeds = [{ text: '10 月毛利怎麼樣？', at: '11/10 09:20', patch: (r: ProfitResult) => ({ ...r, asOf: '2026-11-09', ...(r.kind === 'query' ? { basis: 'estimate' as const } : {}) }) }];
  return (
    <div className="grid">
      <div className="page-title span-12">
        <h2>損益分析</h2>
        <p>用對話追問損益：查任意期間與範圍、拆解毛利變動原因、試算調價。每個結果都標示資料截至日與成本依據，資料更新後舊的回答會提示重新計算</p>
      </div>
      <div className="span-12"><SkillChat skill={profitChat} Card={ProfitCard} seeds={seeds} /></div>
    </div>
  );
}

function ProfitCard({ r, rerun }: { r: ProfitResult; rerun?: () => void }) {
  const { model } = useApp();
  const now = model.raw.meta.data_through;
  const stale = r.asOf !== now;
  const basis = r.kind === 'query' ? BASIS_LABEL[r.basis] : r.kind === 'variance' ? BASIS_LABEL[r.curBasis] : r.kind === 'pricing' ? `${Number(r.costMonth.slice(5))} 月預估成本` : null;
  return (
    <div className="pcard">
      <div className="fresh">
        <span>資料截至 {md(r.asOf)}</span>
        {basis && <span>・成本依據：{basis}</span>}
      </div>
      {stale && (
        <div className="stale" role="status">
          <StatusIcon s="warn" size={12} />
          <span>這是依 {md(r.asOf)} 的資料算的，資料已更新到 {md(now)}，數字可能已經不同。</span>
          {rerun && <button className="ghost" onClick={rerun}>用最新資料重新計算</button>}
        </div>
      )}
      {r.kind === 'query' && <QueryCard r={r} />}
      {r.kind === 'variance' && <VarianceCard r={r} />}
      {r.kind === 'pricing' && <PricingCard r={r} />}
      {r.kind === 'alerts' && <AlertsCard r={r} />}
    </div>
  );
}

function Kpis({ items }: { items: { label: string; value: string; sub?: string; neg?: boolean }[] }) {
  return (
    <div className="pk">
      {items.map((x) => <div key={x.label}><span>{x.label}</span><b className={x.neg ? 'neg' : ''}>{x.value}</b>{x.sub && <em>{x.sub}</em>}</div>)}
    </div>
  );
}

function QueryCard({ r }: { r: QueryResult }) {
  const s = r.summary;
  const max = Math.max(...r.groups.map((g) => g.s.gpPct), 0.01);
  return (
    <>
      <div className="pcard-h">{r.period.label}</div>
      <Kpis items={[
        { label: '營收', value: fmtWan(s.revenue) },
        { label: '毛利', value: fmtWan(s.gp) },
        { label: '毛利率', value: fmtPct(s.gpPct), sub: r.base ? `比${r.baseLabel} ${pt(s.gpPct - r.base.gpPct)}` : undefined, neg: !!r.base && s.gpPct < r.base.gpPct },
      ]} />
      {r.groups.length > 1 && (
        <div className="pg">
          {[...r.groups].sort((a, b) => a.s.gpPct - b.s.gpPct).slice(0, 8).map((g) => (
            <Tip key={g.id} content={<><b>{g.name}</b><span>營收 {fmtWan(g.s.revenue)}・毛利 {fmtWan(g.s.gp)}・毛利率 {fmtPct(g.s.gpPct)}</span></>}>
              <div className="pg-row">
                <span className="pg-n">{g.name}</span>
                <span className="pg-bar"><i style={{ width: `${Math.max(2, (Math.max(g.s.gpPct, 0) / max) * 100)}%` }} /></span>
                <span className="pg-v">{fmtPct(g.s.gpPct)}</span>
              </div>
            </Tip>
          ))}
          <div className="pg-note">依毛利率由低到高，最多顯示 8 項</div>
        </div>
      )}
    </>
  );
}

const EFF = { price: '售價', cost: '單位成本', volume: '數量', mix: '產品組合' } as const;
function VarianceCard({ r }: { r: VarianceResult }) {
  const effs = (Object.keys(r.effects) as (keyof typeof EFF)[]);
  const max = Math.max(...effs.map((k) => Math.abs(r.effects[k])), 1);
  const neg = r.contributors.filter((c) => c.delta < 0).slice(0, 3);
  return (
    <>
      <div className="pcard-h">{r.period.label} vs {r.base.label}（{md(r.base.start)}–{md(r.base.end)}）</div>
      <Kpis items={[
        { label: `毛利（${r.base.label}）`, value: fmtWan(r.prev.gp), sub: `毛利率 ${fmtPct(r.prev.gpPct)}` },
        { label: '毛利（本期）', value: fmtWan(r.cur.gp), sub: `毛利率 ${fmtPct(r.cur.gpPct)}` },
        { label: '變動', value: sw(r.delta), sub: pt(r.cur.gpPct - r.prev.gpPct), neg: r.delta < 0 },
      ]} />
      <div className="div-bars" aria-label="毛利變動拆解">
        {effs.map((k) => {
          const v = r.effects[k]; const w = (Math.abs(v) / max) * 50;
          return (
            <div key={k} className="db-row">
              <span className="db-n">{EFF[k]}</span>
              <span className="db-track">
                <span className="db-mid" />
                <i className={v < 0 ? 'neg' : 'pos'} style={v < 0 ? { right: '50%', width: `${w}%` } : { left: '50%', width: `${w}%` }} />
              </span>
              <span className={`db-v ${v < 0 ? 'neg' : ''}`}>{Math.abs(v) < 500 ? '持平' : sw(v)}</span>
            </div>
          );
        })}
        <div className="db-legend"><span><i className="neg" />使毛利減少</span><span><i className="pos" />使毛利增加</span></div>
      </div>
      {(neg.length > 0 || r.materials.length > 0) && (
        <div className="pv-foot">
          {neg.length > 0 && <div><b>拖累最多的{r.contributorBy === 'customer' ? '客戶' : '品項'}</b>{neg.map((c) => <span key={c.id}>{c.name} {sw(c.delta)}</span>)}</div>}
          {r.materials.length > 0 && r.effects.cost < 0 && <div><b>漲最多的原料</b>{r.materials.slice(0, 3).map((m) => <span key={m.id}>{m.name} {m.pct >= 0 ? '+' : ''}{fmtPct(m.pct)}</span>)}</div>}
        </div>
      )}
      {r.curBasis !== r.baseBasis && <p className="pnote"><StatusIcon s="warn" size={11} />本期是{BASIS_LABEL[r.curBasis]}、比較期是{BASIS_LABEL[r.baseBasis]}，單位成本的差異有一部分來自估算方式不同</p>}
    </>
  );
}

function PricingCard({ r }: { r: PricingResult }) {
  const { model } = useApp();
  const lo = Math.min(r.breakEven, r.price, r.need) * 0.9; const hi = Math.max(r.breakEven, r.price, r.need) * 1.05;
  const x = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  const up = r.need > r.price;
  return (
    <>
      <div className="pcard-h">{r.customer ? `${model.customers.get(r.customer)?.name}・` : ''}{model.items.get(r.item)?.name}{r.shock ? `（假設${model.items.get(r.shock.material)?.name}再漲 ${fmtPct(r.shock.pct, 0)}）` : ''}</div>
      <Kpis items={[
        { label: '目前售價', value: `$${r.price.toFixed(1)}`, sub: r.priceSource },
        { label: '目前毛利率', value: fmtPct(r.margin), sub: `成本 $${r.cost.toFixed(1)}`, neg: r.margin < r.target },
        { label: `目標 ${fmtPct(r.target, 0)} 需要`, value: `$${r.need.toFixed(1)}`, sub: up ? `調漲 ${fmtPct(r.changePct)}` : '已達標，不需調價' },
        { label: '一年影響', value: up ? `+${fmtMoney(r.annualImpact)}` : '—', sub: `近 12 個月出貨 ${Math.round(r.qty12).toLocaleString()}` },
      ]} />
      <div className="ladder" aria-label="價格位置">
        <div className="ld-track" />
        {[
          { v: r.breakEven, label: '保本價', cls: 'be' },
          { v: r.price, label: '目前售價', cls: 'cur' },
          { v: r.need, label: `目標 ${fmtPct(r.target, 0)}`, cls: 'tgt' },
        ].map((m) => (
          <div key={m.cls} className={`ld-m ld-${m.cls}`} style={{ left: x(m.v) }}>
            <i /><span>{m.label}<b>${m.v.toFixed(1)}</b></span>
          </div>
        ))}
      </div>
    </>
  );
}

function AlertsCard({ r }: { r: AlertsResult }) {
  return (
    <>
      <div className="pcard-h">目前警示 {r.alerts.length} 則</div>
      <div className="pa">
        {r.alerts.slice(0, 8).map((a) => (
          <Tip key={a.id} content={<><b>{a.title}</b><span>{a.detail}</span></>}>
            <div className="pa-row"><SeverityTag s={a.severity} /><span className="pa-k">{a.kind}</span><span className="pa-t">{a.title}</span></div>
          </Tip>
        ))}
      </div>
    </>
  );
}
