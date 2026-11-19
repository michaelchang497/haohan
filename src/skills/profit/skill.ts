// 損益分析 skill：一個 skill、一組查詢工具，讓使用者在同一段對話裡自由追問
// 時效性：每個結果都記錄「資料截至哪天」與成本依據（月結實際／預估），資料更新後舊結果會標示過期
// Demo：理解問題用下面的規則、說明用模板，模擬地端 LLM；數字全部由 tools.ts 計算
import { contractRows } from '../../lib/alerts';
import { customerTable, itemTable, matchIn } from '../insert/parse';
import type { ChatReply, ChatSkill, SkillContext, SkillDef } from '../types';
import { alertList, periodOf, pricing, queryPnL, variance, type Basis, type GroupBy, type ProfitResult, type Scope } from './tools';

export const profitSkill: SkillDef = {
  id: 'profit',
  name: '損益分析',
  enabled: true,
  description: '查任意期間、公司、通路、客戶、產品的損益，拆解毛利變動原因，試算調價與原料漲價影響',
  tools: [
    { name: 'query_pnl', desc: '查損益：期間 × 公司／通路／客戶／產品，可依維度排名' },
    { name: 'explain_variance', desc: '變動拆解：把毛利變化拆成售價、單位成本、數量、產品組合，並找出影響最大的客戶與原料' },
    { name: 'price_simulation', desc: '調價試算：回到目標毛利要調多少、原料再漲會怎樣、一年影響多少' },
    { name: 'list_alerts', desc: '目前觸發的警示（合約毛利過低、原料大漲、客戶毛利下滑、實際與預估差異）' },
  ],
  triggers: /毛利|損益|營收|獲利|報價|調價|售價|定價|警示|異常/,
};

export const PROFIT_METHOD = [
  '每個數字都標明期間與成本依據：已月結月份用 ERP 月結實際成本，本月用 BOM × 最新進價的預估成本',
  '比較時用相同天數：本月至今對上月同期；完整月份對前一個月；今年至今對去年同期',
  '毛利變動拆成四個原因：售價、單位成本、數量、產品組合；本期是預估、比較期是實際時要提醒',
  '調價試算用本月預估成本；需要售價 ＝ 成本 ÷（1 − 目標毛利率）',
  '合併報表沖銷集團內部交易；資料更新後，舊的回答會標示過期，請重新計算',
];

export interface ProfitState {
  periodKey: string; yoy: boolean; scope: Scope; groupBy: GroupBy | null; sort: 'asc' | 'desc';
  target: number; shock: { material: string; pct: number } | null;
  intent?: 'query' | 'why' | 'pricing' | 'alerts'; last?: ProfitResult;
}
const empty = (): ProfitState => ({ periodKey: 'mtd', yoy: false, scope: { company: 'ALL', channel: 'ALL' }, groupBy: null, sort: 'desc', target: 0.15, shock: null });

const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n)).toLocaleString()}`;
const wan = (n: number) => `${n < 0 ? '−' : ''}${(Math.abs(n) / 1e4).toFixed(1)} 萬`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pt = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)} pt`;
const sgn = (n: number) => `${n >= 0 ? '+' : '−'}${wan(Math.abs(n)).replace('−', '')}`;
export const BASIS_LABEL: Record<Basis, string> = { actual: '月結實際成本', estimate: '預估成本（未月結）', mixed: '月結實際＋本月預估' };
const EFFECT_LABEL = { price: '售價', cost: '單位成本', volume: '數量', mix: '產品組合' } as const;
const CN: Record<string, number> = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };

// ---------------- 理解問題（模擬 LLM 抽參數） ----------------
interface Parsed {
  periodKey?: string; yoy?: boolean; company?: string; channel?: string; customer?: string | null; item?: string | null;
  groupBy?: GroupBy | null; sort?: 'asc' | 'desc'; target?: number; shock?: { material: string; pct: number } | null;
  intent: 'query' | 'why' | 'pricing' | 'alerts' | 'reset' | 'help' | 'none'; ambiguous?: string[];
}

function parse(raw: string, ctx: SkillContext): Parsed {
  const { model } = ctx;
  const t0 = raw.replace(/\s+/g, '');
  const out: Parsed = { intent: 'none' };
  if (/去年同期|跟去年比|和去年比|比去年|年增|同期比/.test(t0)) out.yoy = true;
  else if (/上月同期|跟上個?月比|和上個?月比|比上個?月|月增/.test(t0)) out.yoy = false;
  // 比較用語不是期間：「跟上個月比」指的是比較基準
  const t = t0.replace(/(跟|和|比)(上個?月|去年)(同期)?(比)?|上月同期|去年同期/g, '');
  const cm = model.currentMonth; const y = Number(cm.slice(0, 4)); const mNow = Number(cm.slice(5));

  // 期間
  const mm = t.match(/(去年)?(\d{1,2}|十[一二]?|[一二三四五六七八九])月(?!底)/);
  if (mm) {
    const n = Number(mm[2]) || CN[mm[2]];
    if (n >= 1 && n <= 12) { const yy = mm[1] ? y - 1 : n > mNow ? y - 1 : y; out.periodKey = `${yy}-${String(n).padStart(2, '0')}`; }
  }
  if (!out.periodKey) {
    if (/這個月|本月|當月|這月/.test(t)) out.periodKey = 'mtd';
    else if (/上個月|上月/.test(t)) out.periodKey = 'lastMonth';
    else if (/本季|這季/.test(t)) out.periodKey = 'qtd';
    else if (/今年|年初至今|累計/.test(t)) out.periodKey = 'ytd';
    else if (/近(12|十二)個月|近一年|過去一年/.test(t)) out.periodKey = 'l12m';
    else if (/去年(?!同期)/.test(t)) out.periodKey = 'lastYear';
  }

  // 範圍：公司、通路、客戶、產品
  if (/示範觀光/.test(t)) out.company = 'YW';
  else if (/示範食品(?!集團)/.test(t) && !/集團/.test(t)) out.company = 'HH';
  else if (/集團|合併|全公司|兩家/.test(t)) out.company = 'ALL';
  const CH: [RegExp, string][] = [[/ODM|代工/i, 'ODM'], [/B2B|原料客戶|烘焙業/i, 'B2B'], [/零售|自有品牌/, 'RETAIL'], [/外銷|出口|海外/, 'EXPORT'], [/觀光|門市/, 'TOUR'], [/內部交易|集團內部/, 'IC']];
  for (const [re, id] of CH) if (re.test(t)) { out.channel = id; break; }
  if (/全部通路|所有通路|不分通路/.test(t)) out.channel = 'ALL';
  // 原料漲價要先判斷：「抹茶再漲 10%」的抹茶是原料，不是產品
  const mats = model.raw.items.filter((x) => x.type === '原料' || x.type === '包材').flatMap((x) => [{ id: x.item_id, alias: x.name }, { id: x.item_id, alias: x.name.replace(/(粉|醬)$/, '') }]);
  const pm = t.match(/(\d+(?:\.\d+)?)(%|％|趴)|([一二三四五])成/);
  const p = pm ? (pm[1] ? Number(pm[1]) / 100 : CN[pm[3]] / 10) : null;
  const mat = /漲|上升|貴/.test(t) ? matchIn(t, mats) : { ids: [] as string[], hit: '' };
  if (p != null && mat.ids.length === 1) out.shock = { material: mat.ids[0], pct: p };
  else if (p != null) out.target = p;
  const c = matchIn(t, customerTable(model));
  if (c.ids.length === 1) out.customer = c.ids[0];
  else if (c.ids.length > 1) out.ambiguous = c.ids.map((id) => model.customers.get(id)?.name ?? id);
  const i = matchIn(t.replace(c.hit || '\u0000', '').replace(out.shock ? mat.hit : '\u0000', ''), itemTable(model));
  if (i.ids.length === 1) out.item = i.ids[0];
  if (/全部客戶|所有客戶|不分客戶/.test(t)) out.customer = null;
  if (/全部產品|所有產品|全部品項|不分品項/.test(t)) out.item = null;

  // 排名
  if (/哪個客戶|哪些客戶|各客戶|客戶排名|依客戶|每個客戶/.test(t)) out.groupBy = 'customer';
  else if (/哪個產品|哪些產品|哪個品項|哪些品項|各產品|各品項|產品排名/.test(t)) out.groupBy = 'item';
  else if (/各通路|哪個通路|通路別|依通路/.test(t)) out.groupBy = 'channel';
  else if (/各公司|公司別/.test(t)) out.groupBy = 'company';
  else if (/類別|品類/.test(t)) out.groupBy = 'category';
  if (/最低|最差|最少|最不賺|虧/.test(t)) out.sort = 'asc'; else if (/最高|最賺|最好|最多/.test(t)) out.sort = 'desc';


  // 意圖
  if (/重新|重來|清除/.test(t)) out.intent = 'reset';
  else if (/你能|可以做什麼|怎麼用|能問什麼/.test(t)) out.intent = 'help';
  else if (/警示|要注意|異常|風險|有什麼問題|哪裡有問題/.test(t)) out.intent = 'alerts';
  else if (/調價|報價|報多少|調多少|售價|定價|要賣多少|保本|回到|目標/.test(t) || out.shock) out.intent = 'pricing';
  else if (/為什麼|原因|怎麼會|怎麼了|下滑|變差|衰退|變好|成長|拆解|差異|掉了|掉/.test(t0)) out.intent = 'why';
  else if (/多少|怎麼樣|如何|營收|毛利|賺|排名|哪個|各|狀況|表現/.test(t)) out.intent = 'query';
  return out;
}

// ---------------- 對話 ----------------
export function runProfit(input: string, st: ProfitState, ctx: SkillContext): { reply: ChatReply<ProfitResult>; state: ProfitState } {
  const { model } = ctx;
  const p = parse(input, ctx);
  const trace = ['分流：交給「損益分析」skill'];
  if (p.intent === 'reset') return { state: empty(), reply: { text: ['好，條件已清除。想看什麼？'], trace: [...trace, '清除對話中的條件'], chips: examples(ctx) } };
  if (p.intent === 'help') return { state: st, reply: { text: [
    '我可以查任意期間、公司、通路、客戶、產品的損益，拆解毛利為什麼變，以及試算調價。例如：',
    ...examples(ctx).map((x) => `・${x}`),
    '問完可以直接追問，例如「那上個月呢？」「只看外銷」「目標改 20% 呢？」，我會沿用前面的條件。',
  ], trace, chips: examples(ctx) } };
  if (p.ambiguous) return { state: st, reply: { text: ['是指哪一個客戶？'], trace: [...trace, `客戶有歧義：${p.ambiguous.join('／')}`], chips: p.ambiguous } };

  // 合併條件
  const scope: Scope = { ...st.scope };
  if (p.company) scope.company = p.company;
  if (p.channel) scope.channel = p.channel;
  if (p.customer !== undefined) scope.customer = p.customer ?? undefined;
  if (p.item !== undefined) scope.item = p.item ?? undefined;
  else if (p.customer) scope.item = undefined; // 只講客戶 → 看整個客戶，不沿用上一個品項
  // 新的完整問句不沿用排名方式；只是改條件的追問（「只看外銷」「那上個月呢」）才沿用
  const groupBy = p.groupBy !== undefined ? p.groupBy : p.intent !== 'none' ? null : st.groupBy;
  // 依某個維度排名時，那個維度的篩選要拿掉（例如在「外銷」裡看「各通路」沒有意義）
  if (groupBy === 'channel') scope.channel = 'ALL';
  if (groupBy === 'customer') scope.customer = undefined;
  if (groupBy === 'item') scope.item = undefined;
  if (groupBy === 'company') scope.company = 'ALL';
  const next: ProfitState = {
    ...st, scope, periodKey: p.periodKey ?? st.periodKey, yoy: p.yoy ?? (p.periodKey ? false : st.yoy),
    groupBy,
    sort: p.sort ?? st.sort, target: p.target ?? st.target, shock: p.shock !== undefined ? p.shock : p.intent === 'pricing' && !p.target ? st.shock : null,
  };
  const changedAny = p.periodKey || p.company || p.channel || p.customer !== undefined || p.item !== undefined || p.groupBy || p.target != null || p.shock || p.yoy !== undefined;
  const intent = p.intent !== 'none' ? p.intent : changedAny && st.intent ? st.intent : null;
  if (!intent) {
    return { state: st, reply: { text: ['我沒有看懂這句。可以問「這個月毛利怎麼樣？」「為什麼毛利掉了？」「日昇的抹茶大福要調多少？」，或「目前有什麼警示？」'], trace, chips: examples(ctx) } };
  }
  next.intent = intent;

  const custName = (id?: string) => (id ? model.customers.get(id)?.name ?? id : '');
  const itemName = (id?: string) => (id ? model.items.get(id)?.name ?? id : '');
  const scopeText = scopeLabel(next.scope, ctx);
  if (intent !== 'alerts') trace.push(`條件：${[intent === 'pricing' ? '' : periodOf(model, next.periodKey).label, scopeText || '全集團'].filter(Boolean).join('・')}`);

  let r: ProfitResult; let text: string[];
  if (intent === 'alerts') {
    trace.push('呼叫工具：list_alerts()');
    r = alertList(model); text = explainAlerts(r);
  } else if (intent === 'query') {
    trace.push(`呼叫工具：query_pnl(${next.periodKey}${next.groupBy ? `, 依${GROUP_LABEL[next.groupBy]}` : ''})`);
    r = queryPnL(model, next.scope, next.periodKey, next.groupBy); text = explainQuery(r, next, scopeText);
  } else if (intent === 'why') {
    trace.push(`呼叫工具：explain_variance(${next.periodKey}, 對${next.yoy ? '去年同期' : '前期'})`);
    r = variance(model, next.scope, next.periodKey, next.yoy); text = explainVariance(r, scopeText);
  } else {
    // 調價：需要品項；只有客戶時找那個客戶的合約
    let item = next.scope.item; const cust = next.scope.customer;
    if (!item) {
      const rows = contractRows(model).filter((x) => !cust || x.customer_id === cust);
      if (cust && rows.length === 1) item = rows[0].item_id;
      else {
        const opts = rows.slice(0, 4).map((x) => `${custName(x.customer_id)}的${itemName(x.item_id).replace(/[（(].*$/, '')}要調多少？`);
        return { state: next, reply: { text: [cust ? `${custName(cust)}有好幾張合約，要試算哪一個品項？` : '要試算哪個品項？可以指定客戶和品項。以下是目前毛利最低的合約：'], trace: [...trace, '缺少品項，先追問'], chips: opts } };
      }
      next.scope = { ...next.scope, item };
    }
    trace.push(`呼叫工具：price_simulation(${cust ?? '全部客戶'}, ${item}, 目標 ${pct(next.target)}${next.shock ? `, ${itemName(next.shock.material)} +${pct(next.shock.pct)}` : ''})`);
    r = pricing(model, item, cust, next.target, next.shock); text = explainPricing(r, ctx, p.target == null && !st.last);
  }
  trace.push('依輸出格式整理成結果卡，並寫成說明');
  next.last = r;
  return { state: next, reply: { text, trace, result: r, chips: chipsFor(r, next, ctx) } };
}

const GROUP_LABEL: Record<GroupBy, string> = { customer: '客戶', item: '產品', channel: '通路', company: '公司', category: '品類' };
export function scopeLabel(s: Scope, { model }: SkillContext) {
  return [
    s.company !== 'ALL' ? model.companyName(s.company) : '',
    s.channel !== 'ALL' ? model.channelName(s.channel) : '',
    s.customer ? model.customers.get(s.customer)?.name : '',
    s.item ? model.items.get(s.item)?.name : '',
  ].filter(Boolean).join('・');
}

// ---------------- 說明模板（數字全部來自工具） ----------------
function explainQuery(r: Extract<ProfitResult, { kind: 'query' }>, st: ProfitState, scope: string): string[] {
  const s = r.summary;
  if (!s.n) return [`${r.period.label}${scope ? `（${scope}）` : ''}沒有銷貨資料。`];
  const out = [`${r.period.label}${scope ? `・${scope}` : '・全集團（已沖銷內部交易）'}：營收 ${wan(s.revenue)}，毛利 ${wan(s.gp)}，毛利率 ${pct(s.gpPct)}${r.base ? `，比${r.baseLabel} ${pt(s.gpPct - r.base.gpPct)}` : ''}。成本依據：${BASIS_LABEL[r.basis]}。`];
  if (r.groupBy && r.groups.length) {
    const g = [...r.groups].sort((a, b) => (st.sort === 'asc' ? a.s.gpPct - b.s.gpPct : b.s.gp - a.s.gp)).slice(0, 5);
    out.push(`依${GROUP_LABEL[r.groupBy]}${st.sort === 'asc' ? '，毛利率由低到高' : '，毛利由高到低'}：`);
    for (const x of g) out.push(`・${x.name}：營收 ${wan(x.s.revenue)}、毛利率 ${pct(x.s.gpPct)}`);
  }
  return out;
}

function explainVariance(r: Extract<ProfitResult, { kind: 'variance' }>, scope: string): string[] {
  if (!r.cur.n || !r.prev.n) return [`${r.period.label}或${r.base.label}沒有足夠的銷貨資料可以比較。`];
  const out = [`${r.period.label}${scope ? `・${scope}` : ''}毛利 ${wan(r.cur.gp)}，比${r.base.label} ${sgn(r.delta)}；毛利率 ${pct(r.cur.gpPct)}（${r.base.label} ${pct(r.prev.gpPct)}，${pt(r.cur.gpPct - r.prev.gpPct)}）。拆成四個原因：`];
  const effs = (Object.keys(r.effects) as (keyof typeof r.effects)[]).sort((a, b) => Math.abs(r.effects[b]) - Math.abs(r.effects[a]));
  const why = { price: '同樣的品項賣的價格', cost: '同樣的品項單位成本', volume: '整體出貨量', mix: '賣的品項或客戶組合' };
  for (const k of effs) out.push(Math.abs(r.effects[k]) < 500 ? `・${EFFECT_LABEL[k]} 持平：${why[k]}幾乎沒有變化` : `・${EFFECT_LABEL[k]} ${sgn(r.effects[k])}：${why[k]}${r.effects[k] >= 0 ? (k === 'cost' ? '下降' : '帶來增加') : (k === 'cost' ? '上升' : '造成減少')}`);
  const neg = r.contributors.filter((c) => c.delta < 0).slice(0, 3);
  if (neg.length) out.push(`拖累最多的${r.contributorBy === 'customer' ? '客戶' : '品項'}：${neg.map((c) => `${c.name}（${sgn(c.delta)}，主要是${c.main === 'volume' ? '數量' : EFFECT_LABEL[c.main]}）`).join('、')}。`);
  if (r.materials.length && r.effects.cost < 0) out.push(`成本上升主要來自：${r.materials.slice(0, 3).map((m) => `${m.name} ${pct(m.pct)}`).join('、')}（${r.base.end.slice(0, 7)} → ${r.period.end.slice(0, 7)} 進價）。`);
  if (r.curBasis !== r.baseBasis) out.push(`⚠ 本期是${BASIS_LABEL[r.curBasis]}、比較期是${BASIS_LABEL[r.baseBasis]}，「單位成本」的差異有一部分來自估算方式不同，月結後會更準。`);
  return out;
}

function explainPricing(r: Extract<ProfitResult, { kind: 'pricing' }>, { model }: SkillContext, defaultTarget: boolean): string[] {
  const who = `${r.customer ? `${model.customers.get(r.customer)?.name}・` : ''}${model.items.get(r.item)?.name}`;
  const out = [`${who}：目前${r.priceSource} $${r.price.toFixed(1)}，本月預估成本 $${r.cost.toFixed(1)}${r.shock ? `（已含${model.items.get(r.shock.material)?.name}再漲 ${pct(r.shock.pct)}，每單位 +$${r.shock.delta.toFixed(1)}）` : ''}，毛利率 ${pct(r.margin)}。`];
  if (r.costAtQuote) out.push(`・報價時成本 $${r.costAtQuote.toFixed(1)}，現在 $${r.cost.toFixed(1)}（${pct(r.cost / r.costAtQuote - 1)}）`);
  if (r.need > r.price) out.push(`要回到毛利率 ${pct(r.target)}${defaultTarget ? '（未指定目標，先用 15%）' : ''}，售價需調到 $${r.need.toFixed(1)}，調漲 ${pct(r.changePct)}。過去 12 個月出貨 ${Math.round(r.qty12).toLocaleString()}，等於一年毛利多 ${money(r.annualImpact)}。`);
  else out.push(`目前毛利率已高於目標 ${pct(r.target)}，不需要調價（目標售價 $${r.need.toFixed(1)}）。`);
  out.push(`保本價（毛利為 0）是 $${r.breakEven.toFixed(1)}。`);
  return out;
}

function explainAlerts(r: Extract<ProfitResult, { kind: 'alerts' }>): string[] {
  if (!r.alerts.length) return ['目前沒有觸發的警示。'];
  const sev = { critical: '嚴重', serious: '注意', warning: '提醒' } as const;
  return [`目前有 ${r.alerts.length} 則警示（與損益總覽相同）：`, ...r.alerts.slice(0, 8).map((a) => `・【${sev[a.severity]}】${a.title}`), r.alerts.length > 8 ? `其餘 ${r.alerts.length - 8} 則可在損益總覽查看。` : ''].filter(Boolean);
}

// ---------------- 建議的下一句 ----------------
function chipsFor(r: ProfitResult, st: ProfitState, { model }: SkillContext): string[] {
  const short = (id: string) => (model.customers.get(id)?.name ?? model.items.get(id)?.name ?? id).replace(/[（(].*$/, '');
  if (r.kind === 'query') return [r.base ? '為什麼毛利變了？' : '', st.groupBy !== 'customer' ? '哪個客戶毛利最低？' : '哪個產品毛利最低？', st.periodKey !== 'lastMonth' ? '看上個月' : '看今年', st.scope.channel === 'ALL' ? '只看外銷' : '全部通路'].filter(Boolean);
  if (r.kind === 'variance') {
    const worst = r.contributors.find((c) => c.delta < 0);
    const c = worst ? (r.contributorBy === 'customer' ? `${short(worst.id)}為什麼變差？` : `${short(worst.id)}要調多少？`) : '';
    return [c, st.yoy ? '跟上月同期比呢？' : '跟去年同期比呢？', r.materials[0] ? `${short(r.materials[0].id)}再漲 10% 會怎樣？` : '', '有什麼警示？'].filter(Boolean);
  }
  if (r.kind === 'pricing') {
    const lead = Object.entries(model.leafQty(r.item)).map(([id, u]) => [id, u * model.price(id, model.currentMonth)] as const).filter(([id]) => model.items.get(id)?.type === '原料').sort((a, b) => b[1] - a[1])[0];
    return [`目標改成 ${Math.round(r.target * 100) + 5}% 呢？`, lead ? `${short(lead[0])}再漲 10% 呢？` : '', r.customer ? `${short(r.customer)}今年賺多少？` : '', '有什麼警示？'].filter(Boolean);
  }
  // 從警示帶出下一步：前兩則合約調價 ＋ 一則客戶毛利下滑
  const price = r.alerts.filter((a) => a.kind === '報價').slice(0, 2).map((a) => {
    const m1 = a.title.match(/^(.+?)｜(.+?) 毛利率/);
    return m1 ? `${m1[1]}的${m1[2].replace(/[（(].*$/, '')}要調多少？` : '';
  });
  const cust = r.alerts.filter((a) => a.kind === '客戶').slice(0, 1).map((a) => `${a.title.split(' ')[0]}為什麼變差？`);
  return [...price, ...cust].filter(Boolean).concat('這個月毛利怎麼樣？').slice(0, 4);
}

function examples(_: SkillContext): string[] {
  return ['這個月毛利怎麼樣？', '為什麼毛利跟上個月比掉了？', '日昇的抹茶大福要調多少才有 15%？', '今年哪個客戶毛利最低？'];
}

// 開場：依目前資料主動給出重點（模擬月結後的主動提醒）
function greeting(ctx: SkillContext): string[] {
  const { model } = ctx;
  const q = queryPnL(model, { company: 'ALL', channel: 'ALL' }, 'mtd', null);
  const a = alertList(model).alerts;
  const crit = a.filter((x) => x.severity === 'critical');
  const meta = model.raw.meta;
  return [
    `你好，我是損益分析助理。目前資料截至 ${Number(meta.data_through.slice(5, 7))}/${Number(meta.data_through.slice(8))}：${Number(meta.last_closed_month.slice(5))} 月以前是月結實際成本，${Number(model.currentMonth.slice(5))} 月是預估成本。`,
    `${q.period.label}毛利率 ${pct(q.summary.gpPct)}${q.base ? `，比${q.baseLabel} ${pt(q.summary.gpPct - q.base.gpPct)}` : ''}；目前有 ${a.length} 則警示${crit.length ? `，其中 ${crit.length} 則嚴重（${crit[0].title}）` : ''}。`,
    '想從哪裡開始？',
  ];
}

export const profitChat: ChatSkill<ProfitState, ProfitResult> = {
  def: profitSkill,
  greeting,
  placeholder: '例如：為什麼這個月毛利掉了？',
  method: { steps: PROFIT_METHOD, params: '都可省略：期間（預設本月）、公司、通路、客戶、產品、目標毛利率（預設 15%）；追問時沿用前面的條件', output: '依問題類型顯示固定格式的結果卡（損益摘要／變動拆解／調價試算／警示），卡片標示資料截至日與成本依據' },
  examples,
  empty,
  run: runProfit,
  title: (st, ctx) => {
    if (!st.intent) return null;
    const s = scopeLabel(st.scope, ctx).replace(/[（(][^）)]*[）)]/g, '');
    const k = { query: '損益', why: '毛利變動', pricing: '調價試算', alerts: '警示' }[st.intent];
    if (st.intent === 'alerts') return '目前警示';
    if (st.intent === 'pricing') return `${s} ${k}`;
    const per = st.last && 'period' in st.last ? (st.last as { period: { label: string } }).period.label.replace(/（.*）/, '') : '';
    return `${s || '全集團'} ${per}${k}`;
  },
  pills: (st, ctx) => {
    if (st.intent === 'alerts') return [];
    const r = st.last;
    const per = r && 'period' in r ? (r as { period: { label: string } }).period.label : null;
    return ([
      ['期間', st.intent && st.intent !== 'pricing' ? per : null],
      ['範圍', scopeLabel({ ...st.scope, customer: undefined, item: undefined }, ctx) || null],
      ['客戶', st.scope.customer ? ctx.model.customers.get(st.scope.customer)?.name : null],
      ['產品', st.scope.item ? ctx.model.items.get(st.scope.item)?.name : null],
      ['目標毛利', st.intent === 'pricing' ? pct(st.target) : null],
      ['比較', st.intent === 'why' ? (st.yoy ? '去年同期' : '前期') : null],
    ].filter(([, v]) => v) as [string, string][]);
  },
  clear: () => empty(),
};
