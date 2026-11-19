// 供需計算引擎的情境：排程人力、採購建議、旺季備貨（插單評估在 engine.ts 的 assess）
// 全部共用同一份資料與同一組基礎函式（庫存、在途、排程、產能、規則）
import type { Model } from '../lib/engine';
import { addDays, type OrderModel, type Status } from './engine';

const DAY = 86400000;
const D = (s: string) => new Date(s + 'T00:00:00Z');
const daysBetween = (a: string, b: string) => Math.round((D(b).getTime() - D(a).getTime()) / DAY);
export const mondayOf = (d: string) => { let x = d; while (D(x).getUTCDay() !== 1) x = addDays(x, -1); return x; };

// =====================================================================
// 2. 排程人力：這週每條線排什麼、手工線每天要幾個人
// =====================================================================
export interface LineDay {
  line_id: string; cap: number; used: number; ot: number; pct: number; maint: number;
  items: { item_id: string; qty: number; hours: number; allergen: boolean }[];
}
export interface ManualDay {
  personHours: number; needed: number; planned: number; available: number; gap: number;
  otHours: number; otCost: number; tempWorkers: number; status: Status;
}
export interface DayPlan { date: string; dayType: string; lines: LineDay[]; manual: ManualDay }

export function weekPlan(om: OrderModel, model: Model, weekStart: string, override: Record<string, number>) {
  const manualLine = om.lines.find((l) => l.line_type === '手工')!;
  const pol = om.data.overtime_policy;
  const days: DayPlan[] = [];
  for (let i = 0; i < 6; i++) {
    const d = addDays(weekStart, i);
    const t = om.dayType(d);
    const rows = om.scheduleRows.filter((r) => r.date === d);
    if (t === '休假' || (t === '加班日' && rows.length === 0)) continue;
    const lines: LineDay[] = om.lines.map((l) => {
      const L = om.lineLoad(l.line_id, d);
      const rs = rows.filter((r) => r.line_id === l.line_id);
      const agg = new Map<string, { qty: number; hours: number }>();
      for (const r of rs) { const x = agg.get(r.item_id) ?? { qty: 0, hours: 0 }; x.qty += r.qty; x.hours += r.hours; agg.set(r.item_id, x); }
      const items = [...agg].map(([item_id, x]) => ({ item_id, ...x, allergen: om.allergensOf(item_id).length > 0 }))
        .sort((a, b) => Number(a.allergen) - Number(b.allergen)); // 過敏原排最後（R03）
      return { line_id: l.line_id, cap: L.cap, used: L.used, ot: L.ot, pct: L.cap ? (L.used + L.ot) / L.cap : 0, maint: L.maint, items };
    });
    // 手工線：排程是以標準人數排的 → 排程工時 × 標準人數 ＝ 需要的人時；再跟當天實際可出勤人數比
    const planned = manualLine.std_headcount;
    const personHours = rows.filter((r) => r.line_id === manualLine.line_id).reduce((s, r) => s + r.hours * planned, 0);
    const available = override[d] ?? om.persons(manualLine.line_id, d);
    const normal = manualLine.normal_hours;
    const needed = Math.ceil(personHours / normal - 1e-6);
    const gap = available - needed;
    let otHours = 0; let tempWorkers = 0;
    if (gap < 0 && available > 0) {
      otHours = personHours / available - normal;
      const maxOt = t === '加班日' ? manualLine.max_overtime_saturday : manualLine.max_overtime_weekday;
      if (otHours > maxOt) { tempWorkers = Math.ceil((personHours - available * (normal + maxOt)) / normal); otHours = maxOt; }
    }
    const rateP = t === '加班日' ? pol.saturday_rate_per_person_hour : pol.weekday_rate_per_person_hour;
    const otCost = otHours * available * rateP;
    const status: Status = tempWorkers > 0 ? 'fail' : gap < 0 ? 'warn' : 'ok';
    days.push({ date: d, dayType: t, lines, manual: { personHours, needed, planned, available, gap, otHours, otCost, tempWorkers, status } });
  }

  // 建議：人不夠的日子，先看同週有沒有人力有餘的日子可以挪；不行再加班或找臨時工
  const md = (x: string) => `${Number(x.slice(5, 7))}/${Number(x.slice(8, 10))}`;
  const suggestions: { date: string; text: string; status: Status }[] = [];
  const spareLeft = new Map(days.filter((x) => x.dayType === '工作日').map((x) => [x.date, x.manual.available * manualLine.normal_hours - x.manual.personHours]));
  for (const day of days) {
    const m = day.manual;
    if (m.gap >= 0) continue;
    const shortPH = m.personHours - m.available * manualLine.normal_hours;
    const spare = [...spareLeft].filter(([d, ph]) => d !== day.date && ph > 4).sort((a, b) => b[1] - a[1]);
    const parts: string[] = [];
    if (spare.length) {
      const moved = Math.min(shortPH, spare[0][1]);
      spareLeft.set(spare[0][0], spare[0][1] - moved);
      parts.push(`可把約 ${Math.round(moved)} 人時的工作挪到 ${md(spare[0][0])}（當天有餘力，需確認交期允許）`);
    }
    if (m.tempWorkers > 0) parts.push(`加班到上限仍不足，需要臨時工 ${m.tempWorkers} 人`);
    else parts.push(`或全員加班 ${m.otHours.toFixed(1)} 小時，約 $${Math.round(m.otCost).toLocaleString()}`);
    suggestions.push({ date: day.date, status: m.status, text: `${md(day.date)} 手工線少 ${-m.gap} 人（需 ${m.needed} 人、可出勤 ${m.available} 人）：${parts.join('；')}` });
  }
  for (const day of days) for (const l of day.lines) {
    if (l.items.filter((i) => i.allergen).length && l.items.some((i) => !i.allergen)) {
      // 已依規則排序，這裡只在同一天有多種過敏原時提醒
      const al = new Set(l.items.flatMap((i) => om.allergensOf(i.item_id)));
      if (al.size > 1) suggestions.push({ date: day.date, status: 'ok', text: `${md(day.date)} ${om.lines.find((x) => x.line_id === l.line_id)?.name}：同一天有 ${[...al].join('、')} 兩種過敏原，換口味時需清洗 ${om.data.changeover_rules.allergen_cleaning_minutes} 分鐘` });
    }
  }
  const summary = {
    personHours: days.reduce((s, d) => s + d.manual.personHours, 0),
    shortDays: days.filter((d) => d.manual.gap < 0).length,
    otCost: days.reduce((s, d) => s + d.manual.otCost, 0),
    tempWorkers: days.reduce((s, d) => s + d.manual.tempWorkers, 0),
  };
  void model;
  return { days, suggestions, summary, manualLine };
}

// =====================================================================
// 3. 採購建議：該買什麼、最晚哪天下單、買多少、哪張要催
// =====================================================================
export interface PurchaseSuggestion {
  item_id: string; supplier_id: string | null; kind: 'new' | 'expedite';
  urgency: 'late' | 'today' | 'week' | 'next' | 'later';
  needDate: string; orderBy: string; arrival: string; qty: number; amount: number; reason: string; po_no?: string;
}

export function purchaseSuggestions(om: OrderModel, model: Model, keepSafety: boolean): PurchaseSuggestion[] {
  const out: PurchaseSuggestion[] = [];
  const supplierOf = (m: string) => {
    const pos = om.data.purchase_orders.filter((p) => p.item_id === m);
    if (pos.length) return pos[pos.length - 1].supplier_id;
    const hist = model.raw.purchases.filter((p) => p.item_id === m);
    return hist.length ? hist[hist.length - 1].supplier_id : null;
  };
  const urgencyOf = (orderBy: string): PurchaseSuggestion['urgency'] => {
    const d = daysBetween(om.asOf, orderBy);
    return d < 0 ? 'late' : d <= 1 ? 'today' : d <= 7 ? 'week' : d <= 14 ? 'next' : 'later';
  };
  for (const it of model.raw.items.filter((i) => i.type === '原料' || i.type === '包材')) {
    const m = it.item_id;
    if (!om.onHand.has(m) && !om.receipts.has(m)) continue;
    const threshold = keepSafety ? it.safety_stock ?? 0 : 0;
    const lead = it.purchase_lead_days ?? 7;
    const supplies: { date: string; qty: number }[] = [];
    for (let round = 0; round < 3; round++) {
      const proj = om.projection(m, undefined, supplies);
      const needPt = proj.find((p) => p.after < threshold - 0.5);
      if (!needPt) break;
      const needDate = needPt.date;
      const orderBy = addDays(needDate, -lead);
      const windowEnd = addDays(needDate, 14);
      const minBal = Math.min(...proj.filter((p) => p.date >= needDate && p.date <= windowEnd).map((p) => p.after));
      const step = it.type === '包材' ? 100 : 10;
      let qty = Math.ceil(Math.max(threshold - minBal, 1) / step) * step;
      if (it.moq) qty = Math.max(qty, it.moq);
      const urgency = urgencyOf(orderBy);
      // 來不及：有沒有之後才到的在途採購單可以請廠商提早送？
      if (urgency === 'late') {
        const later = om.data.purchase_orders.filter((p) => p.item_id === m && p.expected_date > needDate).sort((a, b) => (a.expected_date < b.expected_date ? -1 : 1))[0];
        if (later) {
          out.push({ item_id: m, supplier_id: later.supplier_id, kind: 'expedite', urgency, needDate, orderBy: om.asOf, arrival: addDays(needDate, -1), qty: later.qty, amount: 0, po_no: later.po_no,
            reason: `${fmtD(needDate)} 會${threshold ? '低於安全存量' : '不夠'}；今天下新單要 ${fmtD(addDays(om.asOf, lead))} 才到，請廠商把 ${later.po_no}（原 ${fmtD(later.expected_date)} 到）提前` });
          supplies.push({ date: addDays(needDate, -1), qty: later.qty });
          continue;
        }
      }
      const arrival = urgency === 'late' ? addDays(om.asOf, lead) : needDate;
      out.push({ item_id: m, supplier_id: supplierOf(m), kind: 'new', urgency, needDate, orderBy: urgency === 'late' ? om.asOf : orderBy, arrival, qty,
        amount: qty * model.price(m, model.currentMonth),
        reason: `${fmtD(needDate)} 會${threshold ? `低於安全存量 ${Math.round(threshold).toLocaleString()}` : '不夠'}；前置 ${lead} 天${it.moq ? `，最小訂購量 ${it.moq.toLocaleString()}` : ''}${urgency === 'late' ? `；已來不及，最快 ${fmtD(arrival)} 到` : ''}` });
      supplies.push({ date: arrival, qty });
    }
  }
  const rank = { late: 0, today: 1, week: 2, next: 3, later: 4 };
  return out.sort((a, b) => rank[a.urgency] - rank[b.urgency] || (a.orderBy < b.orderBy ? -1 : 1));
}
const fmtD = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

// =====================================================================
// 4. 旺季備貨：春節禮盒要從哪天開始做、每週做多少、要先叫哪些料
// =====================================================================
export interface SeasonOpts { items: string[]; growth: number; allowOT: boolean; event: string; lastEvent: string; weeks: number }
export interface SeasonBucket {
  item_id: string; k: number; due: string; lastYear: number; forecast: number; booked: number; extra: number;
  earliest: string; latest: string; produced: number; shortfall: number; ratio: number;
}

export function seasonPlan(om: OrderModel, model: Model, o: SeasonOpts) {
  // 預估：去年同期（檔期前 N 週）每週實際銷量 × (1 + 成長率)
  const buckets: SeasonBucket[] = [];
  for (const item of o.items) {
    const it = model.items.get(item)!;
    const last = model.lines.filter((l) => l.item_id === item && !l.is_ic && l.qty > 0 && l.date < o.lastEvent && l.date >= addDays(o.lastEvent, -7 * o.weeks));
    const buyers = new Set(last.map((l) => l.customer_id));
    const ratio = Math.max(...[...buyers].map((c) => om.rules.get(c)?.acceptance_ratio ?? 0.5), 0.33);
    for (let k = o.weeks; k >= 1; k--) {
      const from = addDays(o.lastEvent, -7 * k); const to = addDays(from, 6);
      const lastYear = last.filter((l) => l.date >= from && l.date <= to).reduce((s, l) => s + l.qty, 0);
      let due = addDays(o.event, -7 * k + 3);
      while (!om.isWork(due)) due = addDays(due, -1);
      const wFrom = addDays(o.event, -7 * k); const wTo = addDays(wFrom, 6);
      const booked = om.data.sales_orders.filter((s) => s.item_id === item && s.due_date >= wFrom && s.due_date <= wTo).reduce((s, x) => s + x.qty, 0);
      const forecast = Math.round(lastYear * (1 + o.growth) / 10) * 10;
      const latest = om.prevWork(due, om.shipLead(item));
      const fresh = addDays(due, -Math.floor((it.shelf_life_days ?? 365) * (1 - ratio)));
      const earliest = [om.nextWork(om.asOf), fresh].sort().pop()!;
      buckets.push({ item_id: item, k, due, lastYear, forecast, booked, extra: Math.max(0, forecast - booked), earliest, latest, produced: 0, shortfall: 0, ratio });
    }
  }

  // 涵蓋期間之後還沒有排程：用現有排程中「非檔期品項」的平均負荷估計
  const seasonSet = new Set(o.items);
  const baseline = new Map<string, number>();
  for (const l of om.lines) {
    const rs = om.scheduleRows.filter((r) => r.line_id === l.line_id && !seasonSet.has(r.item_id) && r.date >= addDays(om.asOf, 7));
    const ds = new Set(rs.map((r) => r.date));
    baseline.set(l.line_id, ds.size ? rs.reduce((s, r) => s + r.hours, 0) / ds.size : 0);
  }
  const usedBySeason = new Map<string, number>();
  const free = (line: string, d: string, ot: boolean) => {
    const k = `${line}|${d}|${ot}`;
    const taken = usedBySeason.get(k) ?? 0;
    if (d <= om.horizon) return (ot ? om.otCap(line, d) : om.normalFree(line, d)) - taken;
    const L = om.lines.find((x) => x.line_id === line)!;
    const t = om.dayType(d);
    if (ot) return (t === '工作日' ? L.max_overtime_weekday : t === '加班日' ? L.max_overtime_saturday : 0) - taken;
    return t === '工作日' ? Math.max(0, L.normal_hours - (baseline.get(line) ?? 0)) - taken : 0;
  };
  const plan: { date: string; line_id: string; item_id: string; qty: number; hours: number; overtime: boolean; k: number }[] = [];
  const order = [...buckets].sort((a, b) => (a.due < b.due ? -1 : 1));
  const fill = (b: SeasonBucket, ot: boolean) => {
    let rem = b.extra - b.produced;
    for (let d = b.latest; d >= b.earliest && rem > 0; d = addDays(d, -1)) {
      for (const c of om.linesFor(b.item_id)) {
        if (rem <= 0) break;
        const h = free(c.line_id, d, ot) - c.setup_minutes / 60;
        if (h < 0.5) continue;
        const r = om.rate(c.line_id, b.item_id, d);
        const q = Math.min(rem, Math.floor(h * r));
        if (q <= 0) continue;
        const hours = q / r + c.setup_minutes / 60;
        const k = `${c.line_id}|${d}|${ot}`; usedBySeason.set(k, (usedBySeason.get(k) ?? 0) + hours);
        plan.push({ date: d, line_id: c.line_id, item_id: b.item_id, qty: q, hours, overtime: ot, k: b.k });
        rem -= q; b.produced += q;
      }
    }
  };
  for (const b of order) fill(b, false);
  if (o.allowOT) for (const b of order) fill(b, true);
  for (const b of buckets) b.shortfall = Math.max(0, b.extra - b.produced);
  plan.sort((a, b) => (a.date < b.date ? -1 : 1));

  // 每週產線負荷（以檔期品項的主要產線為主）
  const mainLines = [...new Set(o.items.map((i) => om.linesFor(i)[0]?.line_id).filter(Boolean))] as string[];
  const weeks: { week: string; line_id: string; capacity: number; existing: number; season: number; seasonOT: number }[] = [];
  for (let w = mondayOf(addDays(om.asOf, 7)); w < o.event; w = addDays(w, 7)) {
    for (const line of mainLines) {
      let capacity = 0; let existing = 0;
      for (let i = 0; i < 5; i++) {
        const d = addDays(w, i);
        if (!om.isWork(d)) continue;
        const L = om.lines.find((x) => x.line_id === line)!;
        capacity += L.normal_hours;
        existing += d <= om.horizon ? om.lineLoad(line, d).used : baseline.get(line) ?? 0;
      }
      const ps = plan.filter((p) => p.line_id === line && mondayOf(p.date) === w);
      weeks.push({ week: w, line_id: line, capacity, existing, season: ps.filter((p) => !p.overtime).reduce((s, p) => s + p.hours, 0), seasonOT: ps.filter((p) => p.overtime).reduce((s, p) => s + p.hours, 0) });
    }
  }

  // 物料：備貨計畫需要的料，哪些要提前叫
  const extra = new Map<string, Map<string, number>>();
  for (const p of plan) {
    const d = om.issueDate(p.date);
    for (const [m, q] of Object.entries(model.leafQty(p.item_id))) {
      if (!extra.has(m)) extra.set(m, new Map());
      const x = extra.get(m)!; x.set(d, (x.get(d) ?? 0) + q * p.qty);
    }
  }
  const materials = [...extra].map(([m, dem]) => {
    const it = model.items.get(m)!;
    const proj = om.projection(m, dem);
    const total = [...dem.values()].reduce((s, q) => s + q, 0);
    const first = [...dem.keys()].sort()[0];
    const shortPt = proj.find((p) => p.after < -0.5);
    const lowPt = proj.find((p) => p.after < (it.safety_stock ?? 0));
    const lead = it.purchase_lead_days ?? 7;
    const pt = shortPt ?? lowPt;
    const orderBy = pt ? addDays(pt.date, -lead) : null;
    const status: Status = shortPt && orderBy! < om.asOf ? 'fail' : pt ? 'warn' : 'ok';
    return { item_id: m, total, first, shortDate: shortPt?.date ?? null, lowDate: lowPt?.date ?? null, orderBy, lead, status,
      minAfter: Math.min(...proj.map((p) => p.after)) };
  }).sort((a, b) => ({ fail: 0, warn: 1, ok: 2 }[a.status] - { fail: 0, warn: 1, ok: 2 }[b.status]) || (a.orderBy ?? '9') .localeCompare(b.orderBy ?? '9'));

  const start = plan[0]?.date ?? null;
  const earliestAllowed = buckets.length ? buckets.map((b) => b.earliest).sort()[0] : null;
  const summary = {
    forecast: buckets.reduce((s, b) => s + b.forecast, 0),
    booked: buckets.reduce((s, b) => s + b.booked, 0),
    extra: buckets.reduce((s, b) => s + b.extra, 0),
    produced: buckets.reduce((s, b) => s + b.produced, 0),
    shortfall: buckets.reduce((s, b) => s + b.shortfall, 0),
    otHours: plan.filter((p) => p.overtime).reduce((s, p) => s + p.hours, 0),
    start, earliestAllowed,
  };
  return { buckets, plan, weeks, materials, summary, mainLines, beyondHorizon: plan.some((p) => p.date > om.horizon) };
}
