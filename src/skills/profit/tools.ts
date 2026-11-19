// 損益分析 skill 的計算工具：全部用損益戰情既有的計算（BOM 成本、合約價、月別進價），不另外估數字
import { addMonths, inRange, summarize, viewLines, type Model, type Summary, type ViewLine } from '../../lib/engine';
import { buildAlerts, type Alert } from '../../lib/alerts';
import { periodInfo } from '../../lib/period';

export interface Scope { company: string; channel: string; customer?: string; item?: string }
export interface Period { label: string; start: string; end: string }
export type Basis = 'actual' | 'estimate' | 'mixed';
export type GroupBy = 'customer' | 'item' | 'channel' | 'company' | 'category';

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (m: string) => { const [y, mm] = m.split('-').map(Number); return `${m}-${pad(new Date(Date.UTC(y, mm, 0)).getUTCDate())}`; };
const mLabel = (m: string, yNow: number) => `${Number(m.slice(0, 4)) !== yNow ? `${m.slice(0, 4)} 年 ` : ''}${Number(m.slice(5, 7))} 月`;

// ---------- 期間 ----------
export function periodOf(model: Model, key: string): Period {
  const through = model.raw.meta.data_through; const cm = model.currentMonth; const yNow = Number(cm.slice(0, 4));
  if (/^\d{4}-\d{2}$/.test(key)) {
    if (key === cm) return { label: `${Number(cm.slice(5))} 月（1–${Number(through.slice(8))} 日）`, start: `${cm}-01`, end: through };
    return { label: mLabel(key, yNow), start: `${key}-01`, end: lastDay(key) };
  }
  const minDate = model.lines.reduce((m, l) => (l.date < m ? l.date : m), through);
  const p = periodInfo(key as Parameters<typeof periodInfo>[0], through, minDate);
  const label = { mtd: `${Number(cm.slice(5))} 月（1–${Number(through.slice(8))} 日）`, lastMonth: mLabel(addMonths(cm, -1), yNow), qtd: '本季至今', ytd: `${yNow} 年至今`, l12m: '近 12 個月', lastYear: `${yNow - 1} 年` }[p.key];
  return { label, ...p.cur };
}

// 比較基準：本月至今 → 上月同期；完整月份 → 前一個月；今年至今 → 去年同期
export function baseOf(model: Model, key: string, cur: Period, yoy: boolean): Period {
  const through = model.raw.meta.data_through;
  const minDate = model.lines.reduce((m, l) => (l.date < m ? l.date : m), through);
  const shiftDate = (d: string, n: number) => {
    const m = addMonths(d.slice(0, 7), n); const day = Math.min(Number(d.slice(8)), Number(lastDay(m).slice(8)));
    return `${m}-${pad(day)}`;
  };
  const months = yoy || key === 'ytd' || key === 'lastYear' ? 12 : key === 'qtd' ? 3 : key === 'l12m' ? 12 : 1;
  const fullMonth = cur.end === lastDay(cur.end.slice(0, 7));
  const start = shiftDate(cur.start, -months);
  const end = fullMonth ? lastDay(addMonths(cur.end.slice(0, 7), -months)) : shiftDate(cur.end, -months);
  const label = months === 12 ? '去年同期' : months === 3 ? '上季同期' : fullMonth ? '前一個月' : '上月同期';
  return { label: start < minDate ? `${label}（資料不足）` : label, start, end };
}

// ---------- 篩選 ----------
export function linesOf(model: Model, s: Scope, p: Period): ViewLine[] {
  return inRange(viewLines(model, { company: s.company, channel: s.channel, eliminate: true }), p)
    .filter((l) => (!s.customer || l.customer_id === s.customer) && (!s.item || l.item_id === s.item));
}
export const basisOf = (ls: ViewLine[]): Basis => (ls.every((l) => l.basis === 'actual') ? 'actual' : ls.every((l) => l.basis === 'estimate') ? 'estimate' : 'mixed');

const keyName = (model: Model, g: GroupBy, id: string) =>
  g === 'customer' ? model.customers.get(id)?.name ?? id : g === 'item' ? model.items.get(id)?.name ?? id
    : g === 'channel' ? model.channelName(id) : g === 'company' ? model.companyName(id) : id;
const keyOf = (g: GroupBy) => (l: ViewLine) => (g === 'customer' ? l.customer_id : g === 'item' ? l.item_id : g === 'channel' ? l.channel_id : g === 'company' ? l.company_id : l.category);

// ---------- 工具 1：查損益 ----------
export interface QueryResult {
  kind: 'query'; scope: Scope; period: Period; basis: Basis; summary: Summary; base: Summary | null; baseLabel: string;
  groupBy: GroupBy | null; groups: { id: string; name: string; s: Summary }[]; asOf: string;
}
export function queryPnL(model: Model, scope: Scope, periodKey: string, groupBy: GroupBy | null): QueryResult {
  const period = periodOf(model, periodKey);
  const ls = linesOf(model, scope, period);
  const base = baseOf(model, periodKey, period, false);
  const bl = linesOf(model, scope, base);
  const groups: QueryResult['groups'] = [];
  if (groupBy) {
    const m = new Map<string, ViewLine[]>();
    for (const l of ls) { const k = keyOf(groupBy)(l); (m.get(k) ?? m.set(k, []).get(k)!).push(l); }
    for (const [id, arr] of m) groups.push({ id, name: keyName(model, groupBy, id), s: summarize(arr) });
    groups.sort((a, b) => b.s.revenue - a.s.revenue);
  }
  return { kind: 'query', scope, period, basis: basisOf(ls), summary: summarize(ls), base: bl.length ? summarize(bl) : null, baseLabel: base.label, groupBy, groups, asOf: model.raw.meta.data_through };
}

// ---------- 工具 2：變動拆解（價格、成本、數量、組合） ----------
export interface Effects { price: number; cost: number; volume: number; mix: number }
export interface VarianceResult {
  kind: 'variance'; scope: Scope; period: Period; base: Period; cur: Summary; prev: Summary; delta: number;
  effects: Effects; curBasis: Basis; baseBasis: Basis;
  contributors: { id: string; name: string; delta: number; main: keyof Effects; effects: Effects }[]; contributorBy: GroupBy;
  materials: { id: string; name: string; p0: number; p1: number; pct: number; impact: number }[]; asOf: string;
}
export function variance(model: Model, scope: Scope, periodKey: string, yoy: boolean): VarianceResult {
  const period = periodOf(model, periodKey);
  const base = baseOf(model, periodKey, period, yoy);
  const L1 = linesOf(model, scope, period); const L0 = linesOf(model, scope, base);
  const by: GroupBy = scope.customer ? 'item' : 'customer';
  type Agg = { q: number; r: number; c: number };
  const agg = (ls: ViewLine[]) => {
    const m = new Map<string, Agg>();
    for (const l of ls) { const k = `${l.customer_id}|${l.item_id}`; const a = m.get(k) ?? { q: 0, r: 0, c: 0 }; a.q += l.qty; a.r += l.revenue; a.c += l.cost; m.set(k, a); }
    return m;
  };
  const A1 = agg(L1); const A0 = agg(L0);
  const S1 = summarize(L1); const S0 = summarize(L0);
  const per = new Map<string, Effects & { qty: number }>();
  let r1AtBase = 0;
  for (const k of new Set([...A1.keys(), ...A0.keys()])) {
    const a = A1.get(k); const b = A0.get(k);
    const e = { price: 0, cost: 0, volume: 0, mix: 0, qty: 0 };
    if (a && b && a.q > 0 && b.q > 0) {
      const p1 = a.r / a.q, p0 = b.r / b.q, c1 = a.c / a.q, c0 = b.c / b.q;
      e.price = (p1 - p0) * a.q; e.cost = -(c1 - c0) * a.q; e.qty = (a.q - b.q) * (p0 - c0);
      r1AtBase += a.q * p0;
    } else if (a) { e.qty = a.r - a.c; r1AtBase += a.r; } else if (b) { e.qty = -(b.r - b.c); }
    per.set(k, e);
  }
  const qtyTotal = [...per.values()].reduce((s, e) => s + e.qty, 0);
  const volume = S0.revenue ? (r1AtBase / S0.revenue - 1) * S0.gp : 0;
  const effects: Effects = {
    price: [...per.values()].reduce((s, e) => s + e.price, 0),
    cost: [...per.values()].reduce((s, e) => s + e.cost, 0),
    volume, mix: qtyTotal - volume,
  };
  // 依客戶（或品項）彙總，找出影響最大的
  const groups = new Map<string, Effects>();
  for (const [k, e] of per) {
    const [cust, item] = k.split('|'); const g = by === 'customer' ? cust : item;
    const x = groups.get(g) ?? { price: 0, cost: 0, volume: 0, mix: 0 };
    x.price += e.price; x.cost += e.cost; x.volume += e.qty; groups.set(g, x);
  }
  const contributors = [...groups].map(([id, e]) => {
    const delta = e.price + e.cost + e.volume;
    const main = (['price', 'cost', 'volume'] as const).reduce((m, k) => (Math.abs(e[k]) > Math.abs(e[m]) ? k : m), 'price' as keyof Effects);
    return { id, name: keyName(model, by, id), delta, main, effects: e };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 6);
  // 成本變動背後的原料：本期銷量 × 每單位用量 × 單價變化
  const m1 = period.end.slice(0, 7); const m0 = base.end.slice(0, 7);
  const qtyByItem = new Map<string, number>();
  for (const l of L1) qtyByItem.set(l.item_id, (qtyByItem.get(l.item_id) ?? 0) + l.qty);
  const mat = new Map<string, number>();
  for (const [item, q] of qtyByItem) for (const [leaf, u] of Object.entries(model.leafQty(item))) {
    mat.set(leaf, (mat.get(leaf) ?? 0) + q * u * (model.price(leaf, m1) - model.price(leaf, m0)));
  }
  const materials = [...mat].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, impact]) => {
    const p0 = model.price(id, m0); const p1 = model.price(id, m1);
    return { id, name: model.items.get(id)?.name ?? id, p0, p1, pct: p0 ? p1 / p0 - 1 : 0, impact };
  });
  return { kind: 'variance', scope, period, base, cur: S1, prev: S0, delta: S1.gp - S0.gp, effects, curBasis: basisOf(L1), baseBasis: basisOf(L0), contributors, contributorBy: by, materials, asOf: model.raw.meta.data_through };
}

// ---------- 工具 3：調價試算 ----------
export interface PricingResult {
  kind: 'pricing'; customer?: string; item: string; price: number; priceSource: string; quotedOn: string | null;
  cost: number; costAtQuote: number | null; shock: { material: string; pct: number; delta: number } | null;
  margin: number; target: number; need: number; changePct: number; breakEven: number;
  qty12: number; annualImpact: number; asOf: string; costMonth: string;
}
export function pricing(model: Model, item: string, customer: string | undefined, target: number, shock: { material: string; pct: number } | null): PricingResult {
  const cm = model.currentMonth;
  const contract = customer ? model.latestContracts().find((c) => c.customer_id === customer && c.item_id === item) : undefined;
  const from = `${addMonths(cm, -11)}-01`;
  const hist = model.lines.filter((l) => l.item_id === item && (!customer || l.customer_id === customer) && l.date >= from && !l.is_ic);
  const recent = hist.filter((l) => l.date >= `${addMonths(cm, -2)}-01`);
  const avg = recent.reduce((s, l) => s + l.revenue, 0) / (recent.reduce((s, l) => s + l.qty, 0) || 1);
  const price = contract?.price ?? avg;
  const priceSource = contract ? `合約價（${contract.quoted_on.slice(0, 7)} 報價）` : `近 3 個月平均售價${customer ? '' : '（全部客戶）'}`;
  let cost = model.unitCost(item, cm).total;
  let sh: PricingResult['shock'] = null;
  if (shock) {
    const u = model.leafQty(item)[shock.material] ?? 0;
    const delta = u * model.price(shock.material, cm) * shock.pct;
    cost += delta; sh = { ...shock, delta };
  }
  const need = cost / (1 - target);
  const qty12 = hist.reduce((s, l) => s + l.qty, 0);
  return {
    kind: 'pricing', customer, item, price, priceSource, quotedOn: contract?.quoted_on ?? null, cost, costAtQuote: contract?.cost_at_quote ?? null,
    shock: sh, margin: price ? (price - cost) / price : 0, target, need, changePct: price ? need / price - 1 : 0, breakEven: cost,
    qty12, annualImpact: (need - price) * qty12, asOf: model.raw.meta.data_through, costMonth: cm,
  };
}

// ---------- 工具 4：警示清單 ----------
export interface AlertsResult { kind: 'alerts'; alerts: Alert[]; asOf: string }
// 與損益總覽相同的輸入（全部資料、全集團、沖銷內部交易），警示數量才會一致
export function alertList(model: Model): AlertsResult {
  const ls = viewLines(model, { company: 'ALL', channel: 'ALL', eliminate: true });
  return { kind: 'alerts', alerts: buildAlerts(model, ls), asOf: model.raw.meta.data_through };
}

export type ProfitResult = QueryResult | VarianceResult | PricingResult | AlertsResult;
