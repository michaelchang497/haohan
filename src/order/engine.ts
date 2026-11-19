// 供需計算引擎：現有的 ＋ 未來會進來的 － 已經答應出去的，再套用規則。各情境（插單、排程、採購、備貨）共用
import type { Model } from '../lib/engine';
import type { CustomerRule, InventoryLot, OrderData, ProductionLine, ScheduleRow } from './types';

export type Status = 'ok' | 'warn' | 'fail';

export interface InsertRequest { customer_id: string; item_id: string; qty: number; due_date: string }

export interface PlanRow { date: string; line_id: string; qty: number; hours: number; overtime: boolean; persons: number }

export interface MaterialCheck {
  item_id: string; need: number; onHand: number; safety: number;
  minBase: number; minAfter: number; firstShortDate: string | null; shortQty: number;
  nextReceipt: string | null; status: Status;
  kind: 'short' | 'rebuy' | 'safety' | null; // 前置天數內缺料／之後才缺或低於安全存量（追加採購即可）／前置天數內動用安全庫存
  leadDate: string;
  firstLowDate: string | null; // 這張單造成低於安全存量的第一天
}

export interface EvalResult {
  due: string; atp: number; eligibleStock: number; ineligibleLots: InventoryLot[];
  need: number; earliestProd: string; latestProd: string;
  plan: PlanRow[]; remaining: number;
  materials: MaterialCheck[];
  freezer: { status: Status; pallets: number; after: number; limit: number; capacity: number } | null;
  overtimeHours: number; overtimeCost: number;
  capacityOk: boolean; materialsOk: boolean; feasible: boolean;
}

export interface OptionResult {
  id: 'normal' | 'overtime' | 'rush_po' | 'bump' | 'split' | 'delay';
  title: string; feasible: boolean; date: string | null; extraCost: number; impact: string; recommended?: boolean;
}

export interface Assessment {
  req: InsertRequest;
  verdict: Status; headline: string;
  base: EvalResult; withOT: EvalResult;
  options: OptionResult[];
  checks: { key: string; label: string; status: Status; detail: string }[];
  margin: {
    price: number; priceSource: string; unitCost: number; varCost: number; revenue: number;
    gp: number; gpPct: number;                 // 全成本法（含分攤工費）
    contribution: number; contributionPct: number; // 增量法：營收 − 原料 − 包材（工費為固定成本）
    extraCost: number; incremental: number; incrementalPct: number; // 增量損益 ＝ 貢獻 − 額外成本
  };
  bottleneck: string | null; // 最需要注意的物料
  extraSupply: Record<string, { date: string; qty: number }[]>;
}

const DAY = 86400000;
const D = (s: string) => new Date(s + 'T00:00:00Z');
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => iso(new Date(D(s).getTime() + n * DAY));
const dow = (s: string) => D(s).getUTCDay();

export type OrderModel = ReturnType<typeof buildOrderModel>;

export function buildOrderModel(model: Model, data: OrderData) {
  const asOf = data.order_meta.snapshot_at.slice(0, 10);
  const horizon = data.order_meta.horizon_end;
  const calMap = new Map(data.calendar.map((c) => [c.date, c]));
  const dayType = (d: string) => calMap.get(d)?.day_type ?? (dow(d) === 0 ? '休假' : dow(d) === 6 ? '加班日' : '工作日');
  const isWork = (d: string) => dayType(d) === '工作日';
  const prevWork = (d: string, n = 1) => { let x = d; let k = 0; while (k < n) { x = addDays(x, -1); if (isWork(x)) k++; } return x; };
  const nextWork = (d: string) => { let x = addDays(d, 1); while (!isWork(x)) x = addDays(x, 1); return x; };
  const addWork = (d: string, n: number) => { let x = d; for (let k = 0; k < n; k++) x = nextWork(x); return x; };

  const lines = new Map(data.production_lines.map((l) => [l.line_id, l]));
  const caps = data.line_capabilities;
  const capOf = (line: string, item: string) => caps.find((c) => c.line_id === line && c.item_id === item);
  const linesFor = (item: string) => caps.filter((c) => c.item_id === item).sort((a, b) => a.priority - b.priority);
  const attendance = new Map(data.staff_attendance.map((a) => [`${a.line_id}|${a.date}`, a.available_headcount]));
  const persons = (line: ProductionLine, d: string) => (line.line_type === '手工' ? attendance.get(`${line.line_id}|${d}`) ?? line.std_headcount : line.std_headcount);
  const rate = (lineId: string, item: string, d: string) => {
    const c = capOf(lineId, item)!; const l = lines.get(lineId)!;
    return c.rate_basis === '每人每小時' ? c.rate_per_hour * persons(l, d) : c.rate_per_hour;
  };

  const used = new Map<string, number>(); const otUsed = new Map<string, number>(); const dayItems = new Map<string, Set<string>>();
  for (const r of data.production_schedule) {
    const k = `${r.line_id}|${r.date}`;
    (r.overtime ? otUsed : used).set(k, ((r.overtime ? otUsed : used).get(k) ?? 0) + r.hours);
    if (!dayItems.has(k)) dayItems.set(k, new Set());
    dayItems.get(k)!.add(r.item_id);
  }
  const maint = (line: string, d: string) => data.maintenance.filter((m) => m.line_id === line && m.date === d).reduce((s, m) => s + m.hours, 0);
  const normalCap = (line: string, d: string) => (isWork(d) ? Math.max(0, lines.get(line)!.normal_hours - maint(line, d)) : 0);
  const normalFree = (line: string, d: string) => Math.max(0, normalCap(line, d) - (used.get(`${line}|${d}`) ?? 0));
  const otCap = (line: string, d: string) => {
    const l = lines.get(line)!; const t = dayType(d);
    const max = t === '工作日' ? l.max_overtime_weekday : t === '加班日' ? l.max_overtime_saturday : 0;
    return Math.max(0, max - (otUsed.get(`${line}|${d}`) ?? 0));
  };

  const rules = new Map<string, CustomerRule>(data.customer_rules.map((c) => [c.customer_id, c]));
  const ruleVal = (id: string) => data.planning_rules.find((r) => r.rule_id === id)?.value as Record<string, number> | undefined;
  const shipLead = (item: string) => ruleVal('R09')?.[model.items.get(item)?.storage ?? '常溫'] ?? (model.items.get(item)?.storage === '冷凍' ? 2 : 1);
  const maxAdvance = (item: string) => ruleVal('R11')?.[model.items.get(item)?.storage ?? '常溫'] ?? 10;
  const issueDate = (prodDate: string) => { const p = prevWork(prodDate); return p < asOf ? asOf : p; };
  // 換線排序只管控規則指定的過敏原（花生、芝麻）
  const controlled = data.changeover_rules.controlled_allergens;
  const allergensOf = (item: string) => (model.items.get(item)?.allergens ?? []).filter((a) => !controlled || controlled.includes(a));

  // ---- 物料基準：現有 ＋ 在途 － 已排程需求 ----
  const onHand = new Map<string, number>();
  for (const l of data.inventory) {
    const it = model.items.get(l.item_id);
    if (it && (it.type === '原料' || it.type === '包材')) onHand.set(l.item_id, (onHand.get(l.item_id) ?? 0) + l.qty);
  }
  const receipts = new Map<string, Map<string, number>>();
  for (const p of data.purchase_orders) {
    if (!receipts.has(p.item_id)) receipts.set(p.item_id, new Map());
    const m = receipts.get(p.item_id)!; m.set(p.expected_date, (m.get(p.expected_date) ?? 0) + p.qty - p.received_qty);
  }
  const baseDemand = new Map<string, Map<string, number>>();
  const addDemand = (target: Map<string, Map<string, number>>, rows: { date: string; item_id: string; qty: number }[]) => {
    for (const r of rows) {
      const d = issueDate(r.date);
      for (const [m, q] of Object.entries(model.leafQty(r.item_id))) {
        if (!target.has(m)) target.set(m, new Map());
        const x = target.get(m)!; x.set(d, (x.get(d) ?? 0) + q * r.qty);
      }
    }
  };
  addDemand(baseDemand, data.production_schedule);

  function projection(m: string, extraDemand?: Map<string, number>, extraSupply?: { date: string; qty: number }[]) {
    const dates = new Set<string>([asOf]);
    receipts.get(m)?.forEach((_, d) => dates.add(d));
    baseDemand.get(m)?.forEach((_, d) => dates.add(d));
    extraDemand?.forEach((_, d) => dates.add(d));
    extraSupply?.forEach((s) => dates.add(s.date));
    let bal = onHand.get(m) ?? 0; let balBase = bal;
    const out: { date: string; base: number; after: number }[] = [];
    for (const d of [...dates].sort()) {
      const rec = receipts.get(m)?.get(d) ?? 0;
      const sup = extraSupply?.filter((s) => s.date === d).reduce((s, x) => s + x.qty, 0) ?? 0;
      const dem = baseDemand.get(m)?.get(d) ?? 0;
      balBase += rec - dem;
      bal += rec + sup - dem - (extraDemand?.get(d) ?? 0);
      out.push({ date: d, base: balBase, after: bal });
    }
    return out;
  }

  // ---- 成品可承諾量（ATP），含允收期 ----
  function atpFor(item: string, cid: string, due: string) {
    const it = model.items.get(item)!; const rule = rules.get(cid);
    const ratio = rule?.acceptance_ratio ?? 0.5; const shelf = it.shelf_life_days ?? 365;
    const lots = data.inventory.filter((l) => l.item_id === item);
    const eligible: InventoryLot[] = []; const ineligible: InventoryLot[] = [];
    for (const l of lots) {
      const remain = l.exp_date ? (D(l.exp_date).getTime() - D(due).getTime()) / DAY : shelf;
      (remain / shelf >= ratio ? eligible : ineligible).push(l);
    }
    const eligibleStock = eligible.reduce((s, l) => s + l.qty, 0);
    const ev: { date: string; q: number }[] = [{ date: asOf, q: eligibleStock }];
    for (const r of data.production_schedule) if (r.item_id === item) ev.push({ date: addWork(r.date, shipLead(item)), q: r.qty });
    for (const o of data.sales_orders) if (o.item_id === item) ev.push({ date: o.due_date, q: -(o.qty - o.shipped_qty) });
    ev.sort((a, b) => (a.date === b.date ? b.q - a.q : a.date < b.date ? -1 : 1));
    let cum = 0; let minAfter = Infinity; let atBefore = 0;
    for (const e of ev) {
      cum += e.q;
      if (e.date <= due) atBefore = cum;
      else minAfter = Math.min(minAfter, cum);
    }
    const atp = Math.max(0, Math.min(atBefore, minAfter));
    return { atp, eligibleStock, ineligible };
  }

  // ---- 排產：從最晚可生產日往前填 ----
  function planProduction(item: string, need: number, earliest: string, latest: string, allowOT: boolean) {
    const rows: PlanRow[] = [];
    let rem = need;
    if (rem <= 0 || latest < earliest) return { rows, remaining: rem };
    const local = new Map<string, number>(); const touched = new Set<string>();
    const setupFor = (lineId: string, d: string) => {
      const k = `${lineId}|${d}`;
      if (touched.has(k)) return 0;
      const c = capOf(lineId, item)!;
      let h = c.setup_minutes / 60;
      const al = allergensOf(item);
      const others = [...(dayItems.get(k) ?? [])].filter((x) => x !== item);
      if (al.length && others.some((o) => allergensOf(o).some((a) => !al.includes(a)) || allergensOf(o).length === 0)) h += data.changeover_rules.allergen_cleaning_minutes / 60;
      return h;
    };
    const fill = (overtime: boolean) => {
      for (let d = latest; d >= earliest && rem > 0; d = addDays(d, -1)) {
        if (!overtime && !isWork(d)) continue;
        for (const c of linesFor(item)) {
          if (rem <= 0) break;
          const k = `${c.line_id}|${d}`;
          const capH = (overtime ? otCap(c.line_id, d) : normalFree(c.line_id, d)) - (local.get(`${k}|${overtime}`) ?? 0);
          const setup = setupFor(c.line_id, d);
          const avail = capH - setup;
          if (avail < 0.25) continue;
          const r = rate(c.line_id, item, d);
          const q = Math.min(rem, Math.floor(avail * r));
          if (q < Math.min(c.min_batch, rem)) continue;
          const hours = q / r + setup;
          local.set(`${k}|${overtime}`, (local.get(`${k}|${overtime}`) ?? 0) + hours);
          touched.add(k);
          rows.push({ date: d, line_id: c.line_id, qty: q, hours, overtime, persons: persons(lines.get(c.line_id)!, d) });
          rem -= q;
        }
      }
    };
    fill(false);
    if (allowOT && rem > 0) fill(true);
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.line_id.localeCompare(b.line_id)));
    return { rows, remaining: rem };
  }

  function checkMaterials(item: string, plan: PlanRow[], extraSupply: Record<string, { date: string; qty: number }[]>) {
    const extra = new Map<string, Map<string, number>>();
    addDemand(extra, plan.map((p) => ({ date: p.date, item_id: item, qty: p.qty })));
    const out: MaterialCheck[] = [];
    for (const m of Object.keys(model.leafQty(item))) {
      const it = model.items.get(m)!;
      const proj = projection(m, extra.get(m), extraSupply[m]);
      const need = [...(extra.get(m)?.values() ?? [])].reduce((s, q) => s + q, 0);
      const minBase = Math.min(...proj.map((p) => p.base));
      const minAfter = Math.min(...proj.map((p) => p.after));
      const leadDate = addDays(asOf, it.purchase_lead_days ?? 7);
      // 只算這張單造成的缺口；前置天數之後才缺的，今天補下單來得及
      const shortPt = need > 0 ? proj.find((p) => p.after < -0.5 && p.after < Math.min(0, p.base) - 0.5) : undefined;
      const firstShort = shortPt?.date ?? null;
      const nextReceipt = firstShort ? [...(receipts.get(m)?.keys() ?? [])].sort().find((d) => d > firstShort) ?? null : null;
      const safety = it.safety_stock ?? 0;
      const inLead = proj.filter((p) => p.date <= leadDate);
      const minAfterLead = Math.min(...inLead.map((p) => p.after)); const minBaseLead = Math.min(...inLead.map((p) => p.base));
      const shortQty = firstShort ? Math.max(0, -Math.min(...proj.filter((p) => p.date <= (firstShort <= leadDate ? leadDate : firstShort)).map((p) => p.after - Math.min(0, p.base)))) : 0;
      const lowPt = need > 0 ? proj.find((p) => p.after < safety && p.after < p.base - 0.5) : undefined;
      let kind: MaterialCheck['kind'] = null;
      if (firstShort && firstShort <= leadDate) kind = 'short';
      else if (firstShort) kind = 'rebuy';
      else if (need > 0 && minAfterLead < safety && minAfterLead < minBaseLead - 0.5) kind = 'safety';
      else if (lowPt) kind = 'rebuy';
      const status: Status = kind === 'short' ? 'fail' : kind ? 'warn' : 'ok';
      out.push({ item_id: m, need, onHand: onHand.get(m) ?? 0, safety, minBase, minAfter, firstShortDate: firstShort, shortQty, nextReceipt, status, kind, leadDate, firstLowDate: lowPt?.date ?? null });
    }
    const rank: Record<Status, number> = { fail: 0, warn: 1, ok: 2 };
    return out.sort((a, b) => rank[a.status] - rank[b.status] || b.need - a.need);
  }

  function evaluate(req: InsertRequest, opt: { allowOT: boolean; extraSupply?: Record<string, { date: string; qty: number }[]>; due?: string; qty?: number }): EvalResult {
    const due = opt.due ?? req.due_date; const qty = opt.qty ?? req.qty;
    const { atp, eligibleStock, ineligible } = atpFor(req.item_id, req.customer_id, due);
    const need = Math.max(0, qty - atp);
    const latestProd = prevWork(due, shipLead(req.item_id));
    const itm = model.items.get(req.item_id)!;
    const ratio = rules.get(req.customer_id)?.acceptance_ratio ?? 0.5;
    const fresh = addDays(due, -Math.floor((itm.shelf_life_days ?? 365) * (1 - ratio)));
    const advance = prevWork(latestProd, maxAdvance(req.item_id));
    const earliestProd = [nextWork(asOf), fresh, advance].sort().pop()!;
    const { rows, remaining } = planProduction(req.item_id, need, earliestProd, latestProd, opt.allowOT);
    const materials = checkMaterials(req.item_id, rows, opt.extraSupply ?? {});
    const it = model.items.get(req.item_id)!;
    let freezer: EvalResult['freezer'] = null;
    if (it.storage === '冷凍') {
      const f = data.freezer; const pallets = need / (it.pallet_qty ?? 400);
      const after = f.current_used_pallets + pallets; const limit = f.capacity_pallets * f.safe_level_ratio;
      freezer = { status: after > f.capacity_pallets ? 'fail' : after > limit ? 'warn' : 'ok', pallets, after, limit, capacity: f.capacity_pallets };
    }
    let overtimeHours = 0; let overtimeCost = 0;
    for (const r of rows) if (r.overtime) {
      overtimeHours += r.hours;
      const rateP = dayType(r.date) === '加班日' ? data.overtime_policy.saturday_rate_per_person_hour : data.overtime_policy.weekday_rate_per_person_hour;
      overtimeCost += r.hours * r.persons * rateP;
    }
    const capacityOk = remaining <= 0;
    const materialsOk = materials.every((m) => m.status !== 'fail');
    return { due, atp, eligibleStock, ineligibleLots: ineligible, need, earliestProd, latestProd, plan: rows, remaining, materials, freezer,
      overtimeHours, overtimeCost, capacityOk, materialsOk, feasible: capacityOk && materialsOk && freezer?.status !== 'fail' };
  }

  function priceFor(cid: string, item: string) {
    const c = model.latestContracts().find((x) => x.customer_id === cid && x.item_id === item);
    if (c) return { price: c.price, source: `合約價（${c.quoted_on.slice(0, 7)} 報價）` };
    const from = addDays(asOf, -90);
    const ls = model.lines.filter((l) => l.item_id === item && l.date >= from && l.qty > 0);
    const mine = ls.filter((l) => l.customer_id === cid);
    const pick = mine.length ? mine : ls;
    const q = pick.reduce((s, l) => s + l.qty, 0); const a = pick.reduce((s, l) => s + l.amount, 0);
    return { price: q ? a / q : model.items.get(item)!.std_cost * 1.4, source: mine.length ? '此客戶近 90 天平均售價' : '全通路近 90 天平均售價' };
  }

  function assess(req: InsertRequest): Assessment {
    const base = evaluate(req, { allowOT: false });
    const withOT = evaluate(req, { allowOT: true });
    const options: OptionResult[] = [];
    const custName = (id: string) => model.customers.get(id)?.name ?? id;
    const itemName = (id: string) => model.items.get(id)?.name ?? id;
    let extraSupply: Record<string, { date: string; qty: number }[]> = {};

    if (base.feasible) {
      options.push({ id: 'normal', title: '照常排入', feasible: true, date: req.due_date, extraCost: 0, impact: base.need > 0 ? `排入正常工時，生產 ${base.need.toLocaleString()}` : '直接由成品庫存出貨' });
    } else {
      if (withOT.feasible) {
        options.push({ id: 'overtime', title: '加班生產', feasible: true, date: req.due_date, extraCost: withOT.overtimeCost, impact: `加班 ${withOT.overtimeHours.toFixed(1)} 小時，不影響其他訂單` });
      }
      // 緊急採購：缺料時今天下單，依採購前置天數到貨
      const short = withOT.materials.filter((m) => m.status === 'fail');
      if (short.length) {
        extraSupply = Object.fromEntries(short.map((m) => {
          const it = model.items.get(m.item_id)!;
          return [m.item_id, [{ date: addDays(asOf, it.purchase_lead_days ?? 7), qty: Math.max(Math.ceil(m.shortQty * 1.05), it.moq ?? 0) }]];
        }));
        const rush = evaluate(req, { allowOT: true, extraSupply });
        const arr = short.map((m) => `${itemName(m.item_id)} ${extraSupply[m.item_id][0].date.slice(5).replace('-', '/')} 到貨`).join('、');
        options.push({ id: 'rush_po', title: '今天緊急下單補料', feasible: rush.feasible, date: rush.feasible ? req.due_date : null,
          extraCost: rush.overtimeCost, impact: rush.feasible ? `${arr}，需確認廠商可配合${rush.overtimeHours > 0 ? `；另需加班 ${rush.overtimeHours.toFixed(1)} 小時` : ''}` : `${arr}，仍趕不上交期` });
      }
      // 延後其他訂單：正常工時不夠、物料沒問題時（加班以外的另一條路）
      if (!base.capacityOk && withOT.materialsOk) {
        const lineIds = linesFor(req.item_id).map((c) => c.line_id);
        const r0 = rate(lineIds[0], req.item_id, base.latestProd);
        const needHours = base.remaining / r0;
        const cand = data.production_schedule.filter((r) => lineIds.includes(r.line_id) && r.date >= base.earliestProd && r.date <= base.latestProd && r.item_id !== req.item_id);
        let freed = 0; const affected = new Set<string>();
        for (const r of cand.sort((a, b) => (a.date > b.date ? -1 : 1))) {
          const orders = data.sales_orders.filter((o) => o.item_id === r.item_id && o.due_date >= r.date && o.due_date <= addDays(r.date, 7));
          if (orders.some((o) => !(rules.get(o.customer_id)?.can_delay ?? true))) continue;
          freed += r.hours;
          orders.forEach((o) => affected.add(`${custName(o.customer_id)}・${itemName(o.item_id)}（${o.due_date.slice(5).replace('-', '/')}）`));
          if (freed >= needHours) break;
        }
        const days = Math.max(1, Math.ceil(needHours / 8));
        options.push({ id: 'bump', title: '延後其他訂單', feasible: freed >= needHours, date: freed >= needHours ? req.due_date : null, extraCost: 0,
          impact: affected.size ? `約延後 ${days} 個工作天：${[...affected].slice(0, 3).join('、')}${affected.size > 3 ? ` 等 ${affected.size} 筆` : ''}` : '找不到可以延後的訂單（都屬於 A 級客戶）' });
      }
      // 分批交貨、延後交期：以「不加班」為準，加班可行時另外註明
      const maxQty = (allowOT: boolean) => {
        let lo = 0; let hi = req.qty;
        while (hi - lo > Math.max(10, req.qty * 0.01)) {
          const mid = Math.floor((lo + hi) / 2);
          if (evaluate(req, { allowOT, qty: mid }).feasible) lo = mid; else hi = mid;
        }
        return Math.floor(lo / 10) * 10;
      };
      const earliestDue = (allowOT: boolean) => {
        for (let d = addDays(req.due_date, 1); d <= horizon; d = addDays(d, 1)) {
          if (isWork(d) && evaluate(req, { allowOT, due: d }).feasible) return d;
        }
        return null;
      };
      const delayNormal = earliestDue(false);
      const delayOT = withOT.feasible ? null : earliestDue(true);
      const delayDate = delayNormal ?? delayOT;
      const partial = maxQty(false) || maxQty(true);
      const fmt = (d: string) => d.slice(5).replace('-', '/');
      if (partial > 0 && partial < req.qty) {
        options.push({ id: 'split', title: '分批交貨', feasible: !!delayDate, date: req.due_date, extraCost: 0,
          impact: `${fmt(req.due_date)} 先交 ${partial.toLocaleString()}，其餘 ${(req.qty - partial).toLocaleString()}${delayDate ? ` 於 ${fmt(delayDate)} 交` : ' 交期待定'}（需客戶同意）` });
      }
      const delayCost = delayDate ? evaluate(req, { allowOT: !delayNormal, due: delayDate }).overtimeCost : 0;
      options.push({ id: 'delay', title: '延後交期', feasible: !!delayDate, date: delayDate, extraCost: delayCost,
        impact: delayDate ? `最快 ${fmt(delayDate)} 可交全部數量${delayNormal ? '，不需加班' : '，需搭配加班'}${delayNormal && delayOT && delayOT < delayNormal ? `（加班可提前到 ${fmt(delayOT)}）` : ''}（需客戶同意）` : '涵蓋期間內都排不進去' });
    }

    // 預先算毛利，用來判斷加班划不划算
    const pr = priceFor(req.customer_id, req.item_id);
    const ucb = model.unitCost(req.item_id, model.currentMonth);
    const uc = ucb.total; const vc = ucb.material + ucb.packaging;
    const contrib0 = (pr.price - vc) * req.qty; // 插單決策看增量：正常工費不管接不接都要付
    for (const o of options) if (o.id === 'overtime' && contrib0 - o.extraCost <= 0) o.impact += '；⚠ 加班費超過這張單的貢獻，接了反而少賺';

    const atDue = options.filter((o) => o.feasible && o.date === req.due_date && o.id !== 'split');
    const verdict: Status = base.feasible ? 'ok' : atDue.length ? 'warn' : 'fail';
    const otLoses = options.some((o) => o.id === 'overtime' && contrib0 - o.extraCost <= 0);
    const pref: OptionResult['id'][] = otLoses ? ['normal', 'bump', 'rush_po', 'split', 'overtime', 'delay'] : ['normal', 'overtime', 'rush_po', 'bump', 'split', 'delay'];
    const rec = pref.map((id) => options.find((o) => o.id === id && o.feasible)).find(Boolean);
    if (rec) rec.recommended = true;

    const delay = options.find((o) => o.id === 'delay');
    const firstFail = withOT.materials.find((m) => m.status === 'fail');
    let headline: string;
    if (verdict === 'ok') headline = base.need > 0 ? '可以接：原料、產能都夠，排入正常工時即可' : '可以接：成品庫存就夠出貨';
    else if (verdict === 'warn') headline = `有條件可以：${rec?.title ?? ''}${rec?.extraCost ? `（約多花 $${Math.round(rec.extraCost).toLocaleString()}）` : ''}`;
    else headline = `交期內無法完成${firstFail ? `：缺「${itemName(firstFail.item_id)}」` : '：產能不足'}${delay?.date ? `，最快 ${delay.date.slice(5).replace('-', '/')}` : ''}`;

    // 檢查摘要
    const it = model.items.get(req.item_id)!;
    const ineligibleQty = base.ineligibleLots.reduce((s, l) => s + l.qty, 0);
    const matWarn = withOT.materials.filter((m) => m.status === 'warn');
    const checks: Assessment['checks'] = [
      { key: 'fg', label: '成品庫存與允收期', status: ineligibleQty > 0 ? 'warn' : 'ok',
        detail: `可承諾 ${base.atp.toLocaleString()}，需生產 ${base.need.toLocaleString()}${ineligibleQty ? `；${ineligibleQty.toLocaleString()} ${it.unit}效期不符此客戶允收期（${Math.round((rules.get(req.customer_id)?.acceptance_ratio ?? 0) * 100)}%）` : ''}` },
      { key: 'mat', label: '原料與包材', status: withOT.materialsOk ? (matWarn.length ? 'warn' : 'ok') : 'fail',
        detail: !withOT.materialsOk ? `缺 ${withOT.materials.filter((x) => x.status === 'fail').map((x) => itemName(x.item_id)).join('、')}`
          : matWarn.length ? [
            matWarn.some((x) => x.kind === 'rebuy') ? `需追加採購：${matWarn.filter((x) => x.kind === 'rebuy').map((x) => itemName(x.item_id)).join('、')}` : '',
            matWarn.some((x) => x.kind === 'safety') ? `動用安全庫存：${matWarn.filter((x) => x.kind === 'safety').map((x) => itemName(x.item_id)).join('、')}` : '',
          ].filter(Boolean).join('；') : '交期前都夠用' },
      { key: 'cap', label: '產能', status: base.capacityOk ? 'ok' : withOT.capacityOk ? 'warn' : 'fail',
        detail: base.need === 0 ? '不需生產' : base.capacityOk ? `正常工時可排入（${base.plan.length} 個班次）` : withOT.capacityOk ? `需加班 ${withOT.overtimeHours.toFixed(1)} 小時` : `加班後仍差 ${withOT.remaining.toLocaleString()} ${it.unit}` },
      { key: 'frz', label: '冷凍庫', status: base.freezer?.status ?? 'ok',
        detail: base.freezer ? `+${base.freezer.pallets.toFixed(1)} 板 → ${Math.round(base.freezer.after)}／${base.freezer.capacity} 板（安全水位 ${Math.round(base.freezer.limit)}）` : '常溫品，不需檢查' },
    ];

    const price = pr.price; const source = pr.source; const unitCost = uc;
    const revenue = price * req.qty; const gp = revenue - unitCost * req.qty;
    const extraCost = rec?.extraCost ?? 0;
    const contribution = revenue - vc * req.qty; const incremental = contribution - extraCost;
    const margin = { price, priceSource: source, unitCost, varCost: vc, revenue, gp, gpPct: revenue ? gp / revenue : 0,
      contribution, contributionPct: revenue ? contribution / revenue : 0, extraCost, incremental, incrementalPct: revenue ? incremental / revenue : 0 };
    checks.push({ key: 'gp', label: '這張單的損益', status: incremental <= 0 ? 'fail' : margin.gpPct < 0.12 ? 'warn' : 'ok',
      detail: `接單多賺 $${Math.round(incremental).toLocaleString()}${extraCost ? `（已扣加班 $${Math.round(extraCost).toLocaleString()}）` : ''}；全成本毛利率 ${(margin.gpPct * 100).toFixed(1)}%${margin.gpPct < 0.12 ? '，偏低' : ''}` });

    const bottleneck = (withOT.materials.find((m) => m.status === 'fail') ?? withOT.materials.find((m) => m.status === 'warn'))?.item_id ?? null;
    return { req, verdict, headline, base, withOT, options, checks, margin, bottleneck, extraSupply };
  }

  // ---- 總覽用 ----
  function lineLoad(lineId: string, d: string) {
    const cap = normalCap(lineId, d);
    const u = used.get(`${lineId}|${d}`) ?? 0; const ot = otUsed.get(`${lineId}|${d}`) ?? 0;
    return { cap, used: u, ot, pct: cap ? u / cap : 0, maint: maint(lineId, d), persons: persons(lines.get(lineId)!, d), dayType: dayType(d) };
  }
  function materialOverview() {
    return model.raw.items.filter((i) => (i.type === '原料' || i.type === '包材') && (baseDemand.has(i.item_id) || onHand.has(i.item_id))).map((i) => {
      const proj = projection(i.item_id);
      let min = Infinity; let minDate = asOf;
      for (const p of proj) if (p.base < min) { min = p.base; minDate = p.date; }
      const demand4w = [...(baseDemand.get(i.item_id)?.entries() ?? [])].filter(([d]) => d <= addDays(asOf, 28)).reduce((s, [, q]) => s + q, 0);
      const next = [...(receipts.get(i.item_id)?.keys() ?? [])].sort()[0] ?? null;
      const safety = i.safety_stock ?? 0;
      const status: Status = min < 0 ? 'fail' : min < safety ? 'warn' : 'ok';
      return { item: i, onHand: onHand.get(i.item_id) ?? 0, demand4w, min, minDate, safety, next, status };
    });
  }

  return {
    data, asOf, horizon, isWork, dayType, prevWork, nextWork, addWork, lines: data.production_lines,
    assess, evaluate, projection, lineLoad, materialOverview, rules, scheduleRows: data.production_schedule as ScheduleRow[],
    // 給其他情境共用的基礎函式
    linesFor, capOf, rate, persons: (lineId: string, d: string) => persons(lines.get(lineId)!, d), normalCap, normalFree, otCap,
    shipLead, maxAdvance, issueDate, allergensOf, receipts, onHand,
  };
}
