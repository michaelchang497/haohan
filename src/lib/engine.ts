// 計算層：把 Raw 資料轉成可分析的損益模型
// - 原料月價：當月進貨加權平均（沒進貨就沿用上個月）
// - 預估成本：BOM 逐階展開 × 當月原料價 ＋ 每階工費（含損耗率）
// - 實際成本：已月結月份使用 ERP 月結的實際單位成本
import type { Customer, Item, PriceContract, RawData, SalesLine } from '../data/types';

export interface CostBreakdown { material: number; packaging: number; labor: number; total: number }

export interface Line extends SalesLine {
  month: string;
  channel_id: string;
  rep_id: string;
  category: string;
  is_ic: boolean;
  revenue: number;
  costProd: number;     // 集團生產成本（合併視角）
  costCompany: number;  // 單一公司視角（示範觀光轉售示範食品產品 = 轉撥價）
  basis: 'actual' | 'estimate';
}

export interface Model {
  raw: RawData;
  months: string[];
  currentMonth: string;
  lastClosedMonth: string;
  items: Map<string, Item>;
  customers: Map<string, Customer>;
  channelName: (id: string) => string;
  companyName: (id: string) => string;
  repName: (id: string) => string;
  supplierName: (id: string) => string;
  price: (itemId: string, month: string) => number;
  unitCost: (itemId: string, month: string) => CostBreakdown;
  actualUnitCost: (itemId: string, month: string) => number | undefined;
  leafQty: (itemId: string) => Record<string, number>;
  usedBy: (leafId: string) => string[];
  bomOf: (itemId: string) => RawData['bom'];
  latestContracts: () => PriceContract[];
  lines: Line[];
}

export function buildModel(raw: RawData): Model {
  const items = new Map(raw.items.map((i) => [i.item_id, i]));
  const customers = new Map(raw.customers.map((c) => [c.customer_id, c]));
  const nameMap = <T,>(arr: T[], k: keyof T, v: keyof T) => new Map(arr.map((x) => [String(x[k]), String(x[v])]));
  const channels = nameMap(raw.channels, 'channel_id', 'name');
  const companies = nameMap(raw.companies, 'company_id', 'name');
  const reps = nameMap(raw.sales_reps, 'rep_id', 'name');
  const sups = nameMap(raw.suppliers, 'supplier_id', 'name');

  const currentMonth = raw.meta.data_through.slice(0, 7);
  const months = monthList(raw.sales.reduce((m, s) => (s.date < m ? s.date : m), raw.meta.data_through).slice(0, 7), currentMonth);

  // ---- 原料月價 ----
  const agg = new Map<string, { q: number; a: number }>();
  for (const p of raw.purchases) {
    const k = `${p.item_id}|${p.date.slice(0, 7)}`;
    const v = agg.get(k) ?? { q: 0, a: 0 };
    v.q += p.qty; v.a += p.qty * p.unit_price;
    agg.set(k, v);
  }
  const priceTable = new Map<string, number>();
  for (const it of raw.items) {
    if (it.type !== '原料' && it.type !== '包材') continue;
    let last = it.std_cost;
    for (const m of months) {
      const v = agg.get(`${it.item_id}|${m}`);
      if (v && v.q > 0) last = v.a / v.q;
      priceTable.set(`${it.item_id}|${m}`, last);
    }
  }
  const clampMonth = (m: string) => (m < months[0] ? months[0] : m > currentMonth ? currentMonth : m);
  const price = (id: string, m: string) => priceTable.get(`${id}|${clampMonth(m)}`) ?? items.get(id)?.std_cost ?? 0;

  // ---- BOM ----
  const bomMap = new Map<string, RawData['bom']>();
  for (const b of raw.bom) {
    const arr = bomMap.get(b.parent_id) ?? [];
    arr.push(b);
    bomMap.set(b.parent_id, arr);
  }
  const bomOf = (id: string) => bomMap.get(id) ?? [];

  const costMemo = new Map<string, CostBreakdown>();
  const unitCost = (id: string, m: string): CostBreakdown => {
    const key = `${id}|${m}`;
    const hit = costMemo.get(key);
    if (hit) return hit;
    const it = items.get(id);
    let r: CostBreakdown;
    if (!it) r = { material: 0, packaging: 0, labor: 0, total: 0 };
    else if (it.type === '原料' || it.type === '包材') {
      const p = price(id, m);
      r = it.type === '原料' ? { material: p, packaging: 0, labor: 0, total: p } : { material: 0, packaging: p, labor: 0, total: p };
    } else {
      r = { material: 0, packaging: 0, labor: it.std_labor_overhead, total: 0 };
      for (const b of bomOf(id)) {
        const c = unitCost(b.component_id, m);
        const f = b.qty * (1 + b.loss_rate);
        r.material += c.material * f; r.packaging += c.packaging * f; r.labor += c.labor * f;
      }
      r.total = r.material + r.packaging + r.labor;
    }
    costMemo.set(key, r);
    return r;
  };

  const leafMemo = new Map<string, Record<string, number>>();
  const leafQty = (id: string): Record<string, number> => {
    const hit = leafMemo.get(id);
    if (hit) return hit;
    const acc: Record<string, number> = {};
    const walk = (x: string, q: number) => {
      const parts = bomOf(x);
      if (!parts.length) { acc[x] = (acc[x] ?? 0) + q; return; }
      for (const b of parts) walk(b.component_id, q * b.qty * (1 + b.loss_rate));
    };
    walk(id, 1);
    leafMemo.set(id, acc);
    return acc;
  };
  const finished = raw.items.filter((i) => i.type === '成品').map((i) => i.item_id);
  const usedBy = (leaf: string) => finished.filter((f) => (leafQty(f)[leaf] ?? 0) > 0);

  const actualMap = new Map(raw.monthly_actual_cost.map((a) => [`${a.item_id}|${a.month}`, a.actual_unit_cost]));
  const actualUnitCost = (id: string, m: string) => actualMap.get(`${id}|${m}`);

  // ---- 合約價 ----
  const contractsSorted = [...raw.price_contracts].sort((a, b) => (a.quoted_on < b.quoted_on ? 1 : -1));
  const contractAt = (cid: string, iid: string, date: string) =>
    contractsSorted.find((c) => c.customer_id === cid && c.item_id === iid && c.quoted_on <= date);
  const latestContracts = () => {
    const seen = new Set<string>();
    return contractsSorted.filter((c) => {
      const k = `${c.customer_id}|${c.item_id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const icCustomer = raw.customers.find((c) => c.is_intercompany);

  // ---- 銷貨明細加值 ----
  const lastClosedMonth = raw.meta.last_closed_month;
  const lines: Line[] = raw.sales.map((s) => {
    const month = s.date.slice(0, 7);
    const cust = customers.get(s.customer_id)!;
    const it = items.get(s.item_id)!;
    const actual = month <= lastClosedMonth ? actualUnitCost(s.item_id, month) : undefined;
    const unit = actual ?? unitCost(s.item_id, month).total;
    const costProd = unit * s.qty;
    let costCompany = costProd;
    if (it.company_id !== s.company_id && icCustomer) {
      const tp = contractAt(icCustomer.customer_id, s.item_id, s.date);
      if (tp) costCompany = tp.price * s.qty;
    }
    return {
      ...s, month, channel_id: cust.channel_id, rep_id: cust.rep_id, category: it.category,
      is_ic: cust.is_intercompany, revenue: s.amount, costProd, costCompany,
      basis: actual !== undefined ? 'actual' : 'estimate',
    };
  });

  return {
    raw, months, currentMonth, lastClosedMonth, items, customers,
    channelName: (id) => channels.get(id) ?? id,
    companyName: (id) => companies.get(id) ?? id,
    repName: (id) => reps.get(id) ?? id,
    supplierName: (id) => sups.get(id) ?? id,
    price, unitCost, actualUnitCost, leafQty, usedBy, bomOf, latestContracts, lines,
  };
}

// ---------- 篩選與彙總 ----------
export interface Filters {
  company: string;   // 'ALL' | company_id
  channel: string;   // 'ALL' | channel_id
  eliminate: boolean;// 合併時沖銷集團內部交易
}

export interface ViewLine extends Line { cost: number }

export function isConsolidated(f: Filters) { return f.company === 'ALL' && f.eliminate; }

export function viewLines(model: Model, f: Filters): ViewLine[] {
  const consolidated = isConsolidated(f);
  const out: ViewLine[] = [];
  for (const l of model.lines) {
    if (consolidated && l.is_ic) continue;
    if (f.company !== 'ALL' && l.company_id !== f.company) continue;
    if (f.channel !== 'ALL' && l.channel_id !== f.channel) continue;
    out.push({ ...l, cost: consolidated ? l.costProd : l.costCompany });
  }
  return out;
}

export interface Summary { revenue: number; cost: number; gp: number; gpPct: number; qty: number; n: number }

export function summarize(lines: ViewLine[]): Summary {
  let revenue = 0, cost = 0, qty = 0;
  for (const l of lines) { revenue += l.revenue; cost += l.cost; qty += l.qty; }
  const gp = revenue - cost;
  return { revenue, cost, gp, gpPct: revenue ? gp / revenue : 0, qty, n: lines.length };
}

export function groupSummary(lines: ViewLine[], key: (l: ViewLine) => string): Map<string, Summary> {
  const g = new Map<string, ViewLine[]>();
  for (const l of lines) {
    const k = key(l);
    const arr = g.get(k);
    if (arr) arr.push(l); else g.set(k, [l]);
  }
  return new Map([...g].map(([k, v]) => [k, summarize(v)]));
}

export function inRange(lines: ViewLine[], r: { start: string; end: string }) {
  return lines.filter((l) => l.date >= r.start && l.date <= r.end);
}

export function monthList(from: string, to: string) {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

export function addMonths(month: string, n: number) {
  let [y, m] = month.split('-').map(Number);
  m += n;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
