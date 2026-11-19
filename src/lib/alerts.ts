// 異常警示規則（第一版：規則式；之後可替換或加上 AI 偵測）
import { addMonths, groupSummary, monthList, summarize, type Model, type ViewLine } from './engine';
import { fmtPct, fmtPt, fmtSignedPct } from './format';

export type Severity = 'critical' | 'serious' | 'warning';
export interface Alert {
  id: string;
  severity: Severity;
  kind: '報價' | '原料' | '客戶' | '成本差異';
  title: string;
  detail: string;
  link: string; // hash route
}

export const THRESHOLDS = {
  contractMarginWarn: 0.12,
  contractMarginCritical: 0.05,
  materialRise: 0.1,
  customerDropPt: 0.04,
  actualVsEstimate: 0.05,
};

export interface ContractRow {
  customer_id: string; item_id: string; price: number; quoted_on: string;
  cost_at_quote: number; quoteMargin: number; currentCost: number; currentMargin: number;
  severity: Severity | null;
}

export function contractRows(model: Model): ContractRow[] {
  return model.latestContracts()
    .filter((c) => !model.customers.get(c.customer_id)?.is_intercompany)
    .map((c) => {
      const currentCost = model.unitCost(c.item_id, model.currentMonth).total;
      const currentMargin = (c.price - currentCost) / c.price;
      const severity: Severity | null = currentMargin < THRESHOLDS.contractMarginCritical ? 'critical'
        : currentMargin < THRESHOLDS.contractMarginWarn ? 'serious' : null;
      return { ...c, quoteMargin: (c.price - c.cost_at_quote) / c.price, currentCost, currentMargin, severity };
    })
    .sort((a, b) => a.currentMargin - b.currentMargin);
}

export function buildAlerts(model: Model, lines: ViewLine[]): Alert[] {
  const out: Alert[] = [];
  const itemName = (id: string) => model.items.get(id)?.name ?? id;
  const custName = (id: string) => model.customers.get(id)?.name ?? id;

  // 1. 合約報價毛利過低
  for (const r of contractRows(model)) {
    if (!r.severity) continue;
    out.push({
      id: `c-${r.customer_id}-${r.item_id}`, severity: r.severity, kind: '報價',
      title: `${custName(r.customer_id)}｜${itemName(r.item_id)} 毛利率剩 ${fmtPct(r.currentMargin)}`,
      detail: `報價時 ${fmtPct(r.quoteMargin)}（${r.quoted_on.slice(0, 7)}），原料上漲後成本由 $${r.cost_at_quote.toFixed(1)} 升至 $${r.currentCost.toFixed(1)}`,
      link: `#/customers?id=${r.customer_id}`,
    });
  }

  // 2. 原料近 6 個月漲幅
  const cm = model.currentMonth;
  for (const it of model.raw.items) {
    if (it.type !== '原料') continue;
    const now = model.price(it.item_id, cm);
    const before = model.price(it.item_id, addMonths(cm, -6));
    const g = (now - before) / before;
    if (g >= THRESHOLDS.materialRise) {
      out.push({
        id: `m-${it.item_id}`, severity: 'warning', kind: '原料',
        title: `${it.name} 近 6 個月進價 ${fmtSignedPct(g)}`,
        detail: `影響 ${model.usedBy(it.item_id).length} 項成品，目前 $${now.toFixed(1)}/${it.unit}`,
        link: `#/materials?id=${it.item_id}`,
      });
    }
  }

  // 3. 客戶毛利率下滑（最近 3 個已結月 vs 去年同期）
  const last = model.lastClosedMonth;
  const recent = new Set(monthList(addMonths(last, -2), last));
  const base = new Set([...recent].map((m) => addMonths(m, -12)));
  const rec = groupSummary(lines.filter((l) => recent.has(l.month)), (l) => l.customer_id);
  const prev = groupSummary(lines.filter((l) => base.has(l.month)), (l) => l.customer_id);
  for (const [cid, s] of rec) {
    const p = prev.get(cid);
    if (!p || p.revenue < 100000) continue;
    const d = s.gpPct - p.gpPct;
    if (d <= -THRESHOLDS.customerDropPt) {
      out.push({
        id: `cu-${cid}`, severity: d <= -0.08 ? 'serious' : 'warning', kind: '客戶',
        title: `${custName(cid)} 毛利率 ${fmtPt(d)}`,
        detail: `近 3 個月 ${fmtPct(s.gpPct)}，去年同期 ${fmtPct(p.gpPct)}`,
        link: `#/customers?id=${cid}`,
      });
    }
  }

  // 4. 月結實際成本 vs 預估成本
  const soldLast = summarizeByItem(lines.filter((l) => l.month === last));
  for (const [iid] of soldLast) {
    const act = model.actualUnitCost(iid, last);
    const est = model.unitCost(iid, last).total;
    if (!act) continue;
    const v = act / est - 1;
    if (v >= THRESHOLDS.actualVsEstimate) {
      out.push({
        id: `v-${iid}`, severity: 'serious', kind: '成本差異',
        title: `${itemName(iid)} ${last.slice(5)}月實際成本高於預估 ${fmtSignedPct(v)}`,
        detail: `預估 $${est.toFixed(1)}、實際 $${act.toFixed(1)}：可能是損耗偏高或 BOM 用量過時`,
        link: `#/products?id=${iid}`,
      });
    }
  }

  const rank: Record<Severity, number> = { critical: 0, serious: 1, warning: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function summarizeByItem(lines: ViewLine[]) {
  return groupSummary(lines, (l) => l.item_id);
}
export { summarize };
