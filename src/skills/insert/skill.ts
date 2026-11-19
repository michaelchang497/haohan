// 插單評估 skill
// 正式版一個 skill 包含：工具（可呼叫的計算函式）、方法說明（判斷原則）、輸入格式（缺什麼要追問）、輸出格式（結果卡＋說明）
// Demo：理解問題用 parse.ts 的規則、說明用下面的模板，模擬地端 LLM 的行為；計算直接呼叫供需計算引擎
import type { Assessment, InsertRequest, OptionResult } from '../../order/engine';
import type { ChatReply, ChatSkill, SkillContext, SkillDef } from '../types';
import { parseInsert, type Slots } from './parse';

export const insertSkill: SkillDef = {
  id: 'insert',
  name: '插單評估',
  enabled: true,
  description: '判斷一張追加或急單能不能在交期內完成，並提出接單方案與損益',
  tools: [
    { name: 'assess_insert_order', desc: '輸入客戶、品項、數量、交期，回傳可行性、缺料、產能、方案與增量損益' },
  ],
  triggers: /插單|追加|急單|加訂|能接|接得了|接不接|能不能接/,
};

// 方法說明：正式版是寫給 LLM 的 skill 說明檔，demo 顯示在畫面上
export const INSERT_METHOD = [
  '先扣掉已承諾的成品庫存，只有符合客戶允收期的批號才算數',
  '缺口量依 BOM 展開成原料、包材，對照在途採購與安全存量；要考慮採購前置天數',
  '產能從交期往前排，不能早於最長提前生產天數（常溫 8／冷凍 15 個工作天）',
  '先試正常工時，不夠再試加班；仍不行就提出催料、延後其他訂單、分批、延後交期',
  '損益看增量：營收 − 原料包材 − 額外成本（加班）；全成本毛利率只當參考',
];

const md = (d: string | null | undefined) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '—');
const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const SLOT_LABEL: Record<keyof Slots, string> = { customer_id: '客戶', item_id: '品項', qty: '數量', due_date: '交期' };
const SLOT_ASK: Record<keyof Slots, string> = { customer_id: '是哪個客戶？', item_id: '要哪個品項？', qty: '要多少數量？', due_date: '希望哪天交貨？' };

export interface InsertState { slots: Slots; last?: Assessment }
export const emptyInsertState = (): InsertState => ({ slots: {} });

export function examplePrompts(ctx: SkillContext) {
  const { om, model } = ctx;
  return om.data.insert_scenarios.map((s) => {
    const c = model.customers.get(s.customer_id)?.name ?? s.customer_id;
    const it = model.items.get(s.item_id)!;
    return `${c}要追加 ${s.qty.toLocaleString()} ${it.unit}${it.name.replace(/[（(].*$/, '')}，${md(s.due_date)} 交，能接嗎？`;
  });
}

export function runInsert(input: string, state: InsertState, ctx: SkillContext): { reply: ChatReply<Assessment>; state: InsertState } {
  const { om, model } = ctx;
  const p = parseInsert(input, ctx, state.slots.due_date);
  const cName = (id?: string) => (id ? model.customers.get(id)?.name ?? id : '');
  const iName = (id?: string) => (id ? model.items.get(id)?.name ?? id : '');
  const fmtSlot = (k: keyof Slots, v: Slots[keyof Slots]) =>
    k === 'customer_id' ? cName(v as string) : k === 'item_id' ? iName(v as string) : k === 'qty' ? Number(v).toLocaleString() : md(v as string);
  const trace = ['分流：交給「插單評估」skill'];

  if (p.intent === 'reset') {
    return { state: emptyInsertState(), reply: { text: ['好，條件已清除。請描述新的需求：客戶、品項、數量、交期。'], trace: [...trace, '清除對話中的條件'], chips: examplePrompts(ctx).slice(0, 2) } };
  }
  if (p.intent === 'help') {
    return { state, reply: { text: [
      '我可以評估一張插單能不能接、該怎麼接。請用一句話告訴我客戶、品項、數量和交期，例如：',
      `・${examplePrompts(ctx)[0]}`,
      '評估完可以接著問：「加班呢？」「為什麼不行？」「改成 12/15 交呢？」「這張單賺多少？」',
    ], trace, chips: examplePrompts(ctx).slice(0, 2) } };
  }

  // ---- 追問上一張單（不改條件） ----
  const last = state.last;
  if (last && (p.intent === 'option' || p.intent === 'why' || p.intent === 'margin')) {
    trace.push('沿用上一輪的評估結果，不重新計算');
    const text = p.intent === 'option' ? explainOption(last, p.option!) : p.intent === 'why' ? explainWhy(last, iName) : explainMargin(last);
    return { state, reply: { text, trace, chips: followChips(last, ctx) } };
  }

  // ---- 合併條件 ----
  if (p.ambiguous) {
    const label = p.ambiguous.slot === 'item_id' ? '品項' : '客戶';
    const names = p.ambiguous.ids.map((id) => (p.ambiguous!.slot === 'item_id' ? iName(id) : cName(id)));
    const merged = { ...state.slots, ...p.slots };
    return { state: { ...state, slots: merged }, reply: { text: [`「${label}」有好幾個可能，是指哪一個？`], trace: [...trace, `${label}有歧義：${names.join('／')}`], chips: names } };
  }
  if (p.badDate) {
    return { state: { ...state, slots: { ...state.slots, ...p.slots } }, reply: { text: [`「${p.badDate}」看起來不是有效的日期，請再確認交期。`], trace } };
  }
  const prev = state.slots;
  const slots: Slots = { ...prev, ...p.slots };
  if (p.dueShift && prev.due_date) slots.due_date = om.nextWork(addDaysLocal(prev.due_date, p.dueShift - 1));
  const changed = (Object.keys(SLOT_LABEL) as (keyof Slots)[]).filter((k) => slots[k] !== undefined && slots[k] !== prev[k]);

  if (!changed.length && p.intent === 'none') {
    return { state, reply: { text: last
      ? ['我沒有看懂這句。可以改條件（例如「改成 2000 盒」「延後一週」），或問「加班呢？」「為什麼？」「賺多少？」']
      : ['目前開放的是「插單評估」。請告訴我客戶、品項、數量、交期，我來算能不能接。'], trace, chips: last ? followChips(last, ctx) : examplePrompts(ctx).slice(0, 2) } };
  }
  if (changed.length) {
    trace.push(prev.customer_id || prev.item_id
      ? `沿用上一輪條件，修改：${changed.map((k) => `${SLOT_LABEL[k]} ${prev[k] !== undefined ? `${fmtSlot(k, prev[k])} → ` : ''}${fmtSlot(k, slots[k])}`).join('、')}`
      : `抽出參數：${changed.map((k) => `${SLOT_LABEL[k]}＝${fmtSlot(k, slots[k])}`).join('、')}`);
  }

  // ---- 檢查必要參數 ----
  const missing = (Object.keys(SLOT_LABEL) as (keyof Slots)[]).filter((k) => slots[k] === undefined);
  if (missing.length) {
    const got = (Object.keys(SLOT_LABEL) as (keyof Slots)[]).filter((k) => slots[k] !== undefined).map((k) => `${SLOT_LABEL[k]}：${fmtSlot(k, slots[k])}`);
    const chips = missing[0] === 'customer_id' ? model.raw.customers.filter((c) => c.channel_id !== 'TOUR').slice(0, 4).map((c) => c.name)
      : missing[0] === 'due_date' ? [om.addWork(om.asOf, 5), om.addWork(om.asOf, 10), om.addWork(om.asOf, 15)].map((d) => `${md(d)} 交`)
      : missing[0] === 'qty' ? ['1000', '2000', '3000'].map((x) => `${x} ${model.items.get(slots.item_id ?? '')?.unit ?? '盒'}`) : [];
    return { state: { ...state, slots }, reply: { text: [
      got.length ? `收到，${got.join('、')}。` : '',
      `還需要知道：${missing.map((k) => SLOT_ASK[k]).join('')}`,
    ].filter(Boolean), trace: [...trace, `缺少參數：${missing.map((k) => SLOT_LABEL[k]).join('、')}，先追問、不計算`], chips } };
  }
  if (slots.due_date! <= om.asOf || slots.due_date! > om.horizon) {
    return { state: { ...state, slots: { ...slots, due_date: prev.due_date } }, reply: { text: [
      `交期 ${md(slots.due_date)} 不在可評估的範圍內（${md(om.addWork(om.asOf, 1))}～${md(om.horizon)}，依目前排程與訂單資料的涵蓋期間）。請換一個日期。`,
    ], trace: [...trace, '交期超出資料涵蓋期間，不計算'] } };
  }

  // ---- 呼叫計算工具 ----
  const req: InsertRequest = { customer_id: slots.customer_id!, item_id: slots.item_id!, qty: slots.qty!, due_date: slots.due_date! };
  trace.push(`呼叫工具：assess_insert_order(${req.customer_id}, ${req.item_id}, ${req.qty}, ${req.due_date})`);
  const a = om.assess(req);
  trace.push('依輸出格式整理成結果卡，並寫成說明');
  return { state: { slots, last: a }, reply: { text: explainResult(a), trace, result: a, chips: followChips(a, ctx) } };
}

// 日期統一寫成 12/9（引擎有些地方會寫 12/09）
export const normDates = (s: string) => s.replace(/(^|[^\d])0?(\d{1,2})\/0?(\d{1,2})(?!\d)/g, (_, p, a, b) => `${p}${+a}/${+b}`);
const addDaysLocal = (s: string, n: number) => new Date(new Date(s + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

// ---------------- 說明模板（模擬 LLM 的寫作；數字全部來自計算結果） ----------------
function explainResult(a: Assessment): string[] {
  const rec = a.options.find((o) => o.recommended);
  const out: string[] = [];
  const rest = a.headline.replace(/^[^：]*：/, '');
  out.push(a.verdict === 'ok' ? `可以接。${rest}。` : a.verdict === 'warn' ? `可以接，但要${rec?.title ?? '調整'}。` : `照原本的交期接不了。${rest}。`);
  const issues = a.checks.filter((c) => c.status !== 'ok' && c.key !== 'gp');
  if (issues.length) out.push(...issues.map((c) => `・${c.label}：${c.detail}`));
  if (rec && a.verdict !== 'ok') out.push(`建議「${rec.title}」${rec.date ? `，可在 ${md(rec.date)} 交` : ''}${rec.extraCost ? `，約多花 ${money(rec.extraCost)}` : ''}。${rec.impact}。`);
  const alts = a.options.filter((o) => o.feasible && !o.recommended && o.id !== 'normal');
  if (alts.length) out.push(`其他做法：${alts.map((o) => `${o.title}${o.date ? `（${md(o.date)}）` : ''}`).join('、')}。`);
  const m = a.margin;
  out.push(`損益：營收 ${money(m.revenue)}，扣掉原料包材${m.extraCost ? '和加班' : ''}後，接這張單多賺 ${money(m.incremental)}${m.gpPct < 0.12 ? `；全成本毛利率只有 ${(m.gpPct * 100).toFixed(1)}%，報價偏低` : ''}。`);
  return out.map(normDates);
}

function explainOption(a: Assessment, id: OptionResult['id']): string[] {
  const o = a.options.find((x) => x.id === id);
  const name = { overtime: '加班', split: '分批交貨', delay: '延後交期', rush_po: '緊急補料', bump: '延後其他訂單', normal: '照常排入' }[id];
  if (a.verdict === 'ok') return [`這張單用正常工時就做得完，不需要${name}。`];
  if (!o) {
    if (id === 'overtime') {
      const short = a.withOT.materials.filter((m) => m.status === 'fail');
      const alts = a.options.filter((x) => x.feasible).map((x) => `「${x.title}」`).join('、');
      return [short.length ? '加班也沒有用：卡住的是物料，不是產能，要等補貨到了才能生產。' : '加班到上限仍排不完。',
        alts ? `可行的做法有${alts}，可以問我其中一個。` : '目前沒有可行的方案。'];
    }
    return [`這張單沒有「${name}」的方案。${id === 'bump' ? '產能不是瓶頸，或可以延後的都是 A 級客戶的訂單。' : ''}`];
  }
  const txt = [`${o.feasible ? '可行' : '不可行'}：${o.impact}。`];
  if (o.date) txt.push(`可交日 ${md(o.date)}${o.extraCost ? `，額外成本 ${money(o.extraCost)}` : '，不需額外成本'}。`);
  if (id === 'overtime' && o.extraCost) {
    const inc = a.margin.contribution - o.extraCost;
    txt.push(`扣掉加班費後，這張單${inc > 0 ? `仍多賺 ${money(inc)}，划算` : `會少賺 ${money(-inc)}，不建議`}。`);
  }
  if (o.recommended) txt.push('這也是系統建議的方案。');
  return txt.map(normDates);
}

function explainWhy(a: Assessment, iName: (id?: string) => string): string[] {
  if (a.verdict === 'ok') return ['沒有卡住的地方：庫存、物料、產能都在交期內排得進去。'];
  const out: string[] = [];
  const fail = a.withOT.materials.filter((m) => m.status === 'fail');
  for (const m of fail) {
    out.push(`・${iName(m.item_id)}：${md(m.firstShortDate)} 起不夠，差 ${Math.ceil(m.shortQty).toLocaleString()}；下一批到貨 ${md(m.nextReceipt)}，今天下單最快 ${md(m.leadDate)} 到。`);
  }
  if (!a.base.capacityOk) out.push(`・產能：正常工時排不完，${a.withOT.capacityOk ? `需要加班 ${a.withOT.overtimeHours.toFixed(1)} 小時` : `加班到上限仍差 ${a.withOT.remaining.toLocaleString()}`}。`);
  if (a.base.ineligibleLots.length) out.push(`・成品庫存有 ${a.base.ineligibleLots.reduce((s, l) => s + l.qty, 0).toLocaleString()} 不符合這個客戶的允收期，不能拿來出貨。`);
  return [`主要卡在${fail.length ? '物料' : '產能'}：`, ...out];
}

function explainMargin(a: Assessment): string[] {
  const m = a.margin;
  return [
    `單價 $${m.price.toFixed(1)}（${m.priceSource}），營收 ${money(m.revenue)}。`,
    `・原料＋包材每單位 $${m.varCost.toFixed(1)}，貢獻 ${money(m.contribution)}（${(m.contributionPct * 100).toFixed(1)}%）`,
    `・建議方案的額外成本 ${m.extraCost ? money(m.extraCost) : '無'}`,
    `・接單多賺 ${money(m.incremental)}`,
    `正常工時的人工和製費不管接不接都要付，所以插單看增量。全成本毛利率 ${(m.gpPct * 100).toFixed(1)}% 只當參考，用來判斷這個品項長期報價合不合理。`,
  ];
}

function followChips(a: Assessment, ctx: SkillContext): string[] {
  const chips: string[] = [];
  if (a.verdict !== 'ok') chips.push('為什麼不行？');
  if (a.options.some((o) => o.id === 'overtime') || (a.verdict === 'fail' && !a.base.capacityOk)) chips.push('加班呢？');
  if (a.options.some((o) => o.id === 'split' && o.feasible)) chips.push('分批怎麼交？');
  const delay = a.options.find((o) => o.id === 'delay' && o.date);
  if (delay) chips.push(`改成 ${md(delay.date)} 交呢？`);
  else chips.push(`改成 ${md(ctx.om.addWork(a.req.due_date, 3))} 交呢？`);
  chips.push(`改成 ${Math.round(a.req.qty / 2 / 100) * 100} 呢？`);
  chips.push('這張單賺多少？');
  return chips.slice(0, 5);
}

const shortName = (s: string) => s.replace(/[（(].*$/, '');
export const insertChat: ChatSkill<InsertState, Assessment> = {
  def: insertSkill,
  greeting: '你好，我是插單評估助理。請用一句話告訴我：哪個客戶、什麼品項、多少數量、哪天要交，我會算出能不能接、該怎麼接，以及接了多賺多少。',
  placeholder: '例如：京禾要加 1500 盒黑糖禮盒，12/11 交，能接嗎？',
  method: { steps: INSERT_METHOD, params: '客戶、品項、數量、交期；缺少的會先追問，不會用猜的', output: '固定格式的結果卡（判定、五項檢查、建議方案、接單多賺），加上一段白話說明' },
  examples: examplePrompts,
  empty: emptyInsertState,
  run: runInsert,
  title: (st, { model }) => {
    const c = st.slots.customer_id ? shortName(model.customers.get(st.slots.customer_id)?.name ?? '') : '';
    const i = st.slots.item_id ? shortName(model.items.get(st.slots.item_id)?.name ?? '') : '';
    if (!c && !i) return null;
    return [c, i].filter(Boolean).join('・') + (st.slots.qty ? ` ${st.slots.qty.toLocaleString()}` : '');
  },
  pills: (st, { model }) => ([
    ['客戶', st.slots.customer_id ? model.customers.get(st.slots.customer_id)?.name : null],
    ['品項', st.slots.item_id ? model.items.get(st.slots.item_id)?.name : null],
    ['數量', st.slots.qty ? st.slots.qty.toLocaleString() : null],
    ['交期', st.slots.due_date ? md(st.slots.due_date) : null],
  ].filter(([, v]) => v) as [string, string][]),
  clear: () => emptyInsertState(),
};
