// 插單評估 skill：把一句話拆成參數（demo 用規則模擬 LLM 抽參數）
import type { OptionResult } from '../../order/engine';
import type { SkillContext } from '../types';

export interface Slots { customer_id?: string; item_id?: string; qty?: number; due_date?: string }
export type Intent = 'evaluate' | 'option' | 'why' | 'margin' | 'reset' | 'help' | 'none';
export interface Parsed {
  slots: Slots;
  intent: Intent;
  option?: OptionResult['id'];
  dueShift?: number;                                   // 「延後一週」這類相對交期
  ambiguous?: { slot: 'customer_id' | 'item_id'; ids: string[] };
  badDate?: string;
}

// 品項別名：正式版放在品項主檔的「俗名」欄位，或寫在 skill 的知識檔裡
const ITEM_ALIAS: Record<string, string[]> = {
  FG01: ['芝麻麻糬', '芝麻經濟包', '芝麻'],
  FG02: ['花生麻糬', '花生經濟包', '花生'],
  FG03: ['紅豆麻糬', '紅豆精裝', '紅豆'],
  FG04: ['黑糖麻糬', '黑糖禮盒', '黑糖'],
  FG05: ['小麻糬', '綜合包'],
  FG06: ['芋頭麻糬', '芋頭'],
  FG07: ['綠豆冰粽', '冰粽'],
  FG08: ['紅豆冰粽', '冰粽'],
  FG09: ['草莓雪莓娘', '雪莓娘'],
  FG10: ['雪莓娘皮'],
  FG11: ['麥芽內餡', '3Q餅', '麥芽'],
  FG12: ['椰果果凍', '椰果'],
  FG13: ['中秋麻糬', '中秋禮盒'],
  FG14: ['抹茶大福', '抹茶', '大福'],
  FG15: ['岩烤海苔', '海苔'],
  FG16: ['米花福袋', '福袋'],
};
const CUST_SUFFIX = ['連鎖超商', '烘焙連鎖', '觀光工廠門市', '伴手禮通路', '伴手禮', '烘焙坊', '便利店', '（關係企業）', '食品', '量販', '餅舖', '超市', '電商', '團購'];

const CN: Record<string, number> = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const WEEKDAY: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

const D = (s: string) => new Date(s + 'T00:00:00Z');
const iso = (d: Date) => d.toISOString().slice(0, 10);
const plus = (s: string, n: number) => iso(new Date(D(s).getTime() + n * 86400000));
const pad = (n: number) => String(n).padStart(2, '0');

// 依關鍵字找出最長的命中；同長度命中多個就是有歧義
function bestMatch(text: string, table: { id: string; alias: string }[]) {
  let best = 0; let ids: string[] = []; let hit = '';
  for (const { id, alias } of table) {
    if (!alias || !text.includes(alias)) continue;
    if (alias.length > best) { best = alias.length; ids = [id]; hit = alias; }
    else if (alias.length === best && !ids.includes(id)) ids.push(id);
  }
  return { ids, hit };
}

function cnNumber(s: string): number | null {
  // 支援：三千、一千五、兩千五百、一萬二、五百
  const m = s.match(/^([一二兩三四五六七八九十])(萬|千|百)([一二兩三四五六七八九])?(千|百)?$/);
  if (!m) return null;
  const unit = { 萬: 10000, 千: 1000, 百: 100 } as const;
  const u1 = unit[m[2] as keyof typeof unit];
  let n = CN[m[1]] * u1;
  if (m[3]) n += CN[m[3]] * (m[4] ? unit[m[4] as keyof typeof unit] : u1 / 10);
  return n;
}

// 給其他 skill 共用：從一句話找出客戶、成品（最長命中；同長度多個 → 有歧義）
export function customerTable(model: SkillContext['model']) {
  return model.raw.customers.filter((c) => c.channel_id !== 'TOUR').flatMap((c) => {
    let short = c.name;
    for (const s of CUST_SUFFIX) short = short.replace(s, '');
    const en = c.name.match(/^[A-Za-z]+/)?.[0];
    return [{ id: c.customer_id, alias: c.name }, { id: c.customer_id, alias: short.length >= 2 ? short : '' }, ...(en ? [{ id: c.customer_id, alias: en }] : [])];
  });
}
export function itemTable(model: SkillContext['model']) {
  return model.raw.items.filter((i) => i.type === '成品').flatMap((i) => [
    { id: i.item_id, alias: i.name }, { id: i.item_id, alias: i.name.replace(/[（(].*$/, '') },
    ...(ITEM_ALIAS[i.item_id] ?? []).map((a) => ({ id: i.item_id, alias: a })),
  ]);
}
export const matchIn = (text: string, table: { id: string; alias: string }[]) => bestMatch(text, table);

export function parseInsert(raw: string, ctx: SkillContext, prevDue?: string): Parsed {
  const { om, model } = ctx;
  const asOf = om.asOf;
  let text = raw.replace(/\s+/g, ' ').replace(/[，,](?=\d{3})/g, '');
  const slots: Slots = {};
  const out: Parsed = { slots, intent: 'none' };

  // ---- 客戶 ----
  const custTable = model.raw.customers.filter((c) => c.channel_id !== 'TOUR').flatMap((c) => {
    let short = c.name;
    for (const s of CUST_SUFFIX) short = short.replace(s, '');
    const en = c.name.match(/^[A-Za-z]+/)?.[0];
    return [{ id: c.customer_id, alias: c.name }, { id: c.customer_id, alias: short.length >= 2 ? short : '' }, ...(en ? [{ id: c.customer_id, alias: en }] : [])];
  });
  const cm = bestMatch(text, custTable);
  if (cm.ids.length === 1) slots.customer_id = cm.ids[0];
  else if (cm.ids.length > 1) out.ambiguous = { slot: 'customer_id', ids: cm.ids };
  if (cm.hit) text = text.replace(cm.hit, ' ');

  // ---- 品項 ----
  const itemTable = model.raw.items.filter((i) => i.type === '成品').flatMap((i) => [
    { id: i.item_id, alias: i.name }, { id: i.item_id, alias: i.name.replace(/[（(].*$/, '') },
    ...(ITEM_ALIAS[i.item_id] ?? []).map((a) => ({ id: i.item_id, alias: a })),
  ]);
  const im = bestMatch(text, itemTable);
  if (im.ids.length === 1) slots.item_id = im.ids[0];
  else if (im.ids.length > 1) out.ambiguous = { slot: 'item_id', ids: im.ids };
  if (im.hit) text = text.replace(im.hit, ' ');
  text = text.replace(/[（(]?\d+\s*入[）)]?/g, ' ');

  // ---- 交期 ----
  const fix = (y: number, m: number, d: number) => {
    let s = `${y}-${pad(m)}-${pad(d)}`;
    if (Number.isNaN(D(s).getTime()) || D(s).getUTCDate() !== d) return null;
    if (s <= asOf) s = `${y + 1}-${pad(m)}-${pad(d)}`; // 沒寫年份且日期已過，視為明年
    return s;
  };
  const y0 = Number(asOf.slice(0, 4)); const m0 = Number(asOf.slice(5, 7));
  const take = (re: RegExp, f: (m: RegExpMatchArray) => string | null) => {
    if (slots.due_date) return;
    const m = text.match(re);
    if (!m) return;
    const r = f(m);
    if (r) slots.due_date = r; else out.badDate = m[0];
    text = text.replace(m[0], ' ');
  };
  take(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/, (m) => { const s = `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`; return D(s).getUTCDate() === +m[3] ? s : null; });
  take(/(\d{1,2})\s*[/月]\s*(\d{1,2})\s*[日號]?/, (m) => fix(y0, +m[1], +m[2]));
  take(/(下下|下)?(?:個)?(?:週|周|星期|禮拜)([一二三四五六日天])/, (m) => {
    const target = WEEKDAY[m[2]]; const cur = D(asOf).getUTCDay();
    const toMon = ((1 - cur + 7) % 7) || 7; // 下週一
    if (!m[1]) { const diff = (target - cur + 7) % 7; return plus(asOf, diff || 7); }
    const base = plus(asOf, toMon + (m[1] === '下下' ? 7 : 0));
    return plus(base, (target + 6) % 7);
  });
  take(/(下個?月)?月底/, (m) => { const mm = m[1] ? m0 + 1 : m0; const y = mm > 12 ? y0 + 1 : y0; const mo = ((mm - 1) % 12) + 1; return iso(new Date(Date.UTC(y, mo, 0))); });
  take(/(明天|後天)/, (m) => plus(asOf, m[1] === '明天' ? 1 : 2));
  take(/(\d+|[一二兩三四五六七八九十])\s*(天|週|周|個禮拜)(?:後|內)/, (m) => plus(asOf, (Number(m[1]) || CN[m[1]]) * (m[2] === '天' ? 1 : 7)));
  take(/(\d{1,2})\s*[日號]/, (m) => fix(y0, +m[1] >= Number(asOf.slice(8, 10)) ? m0 : m0 + 1 > 12 ? 1 : m0 + 1, +m[1]));
  // 相對交期：「延後一週」「晚 3 天」
  const shift = text.match(/(?:延後|延|晚|往後)\s*(\d+|[一二兩三四五六七八九十])\s*(天|週|周|個禮拜)/);
  if (shift && prevDue && !slots.due_date) { out.dueShift = (Number(shift[1]) || CN[shift[1]]) * (shift[2] === '天' ? 1 : 7); text = text.replace(shift[0], ' '); }

  // ---- 數量 ----
  const q1 = text.match(/(\d+(?:\.\d+)?)\s*(萬|千|k|K)?\s*(盒|包|箱|個|份|組|入|件)?/);
  const q2 = text.match(/([一二兩三四五六七八九十][萬千百][一二兩三四五六七八九]?[千百]?)/);
  if (q1) { const n = Number(q1[1]) * ({ 萬: 10000, 千: 1000, k: 1000, K: 1000 }[q1[2] ?? ''] ?? 1); if (n >= 10) slots.qty = Math.round(n); }
  else if (q2) { const n = cnNumber(q2[1]); if (n) slots.qty = n; }

  // ---- 意圖 ----
  const has = Object.keys(slots).length > 0 || out.dueShift != null;
  if (/重新|另一張|新的一張|換一張|清除|重來/.test(raw)) out.intent = 'reset';
  else if (/你能|可以做什麼|怎麼用|能幫我什麼|help/i.test(raw)) out.intent = 'help';
  else if (!has && /為什麼|原因|卡在|瓶頸|哪裡不夠|缺什麼|不行嗎/.test(raw)) out.intent = 'why';
  else if (!has && /賺|毛利|損益|划算|利潤|虧/.test(raw)) out.intent = 'margin';
  else if (!has && /加班|分批|延後交期|延期|晚點交|緊急|催|補料|叫料|延後其他|挪|讓/.test(raw)) {
    out.intent = 'option';
    out.option = /加班/.test(raw) ? 'overtime' : /分批/.test(raw) ? 'split' : /緊急|催|補料|叫料/.test(raw) ? 'rush_po' : /其他|挪|讓/.test(raw) ? 'bump' : 'delay';
  } else if (has || /接|可以|行嗎|能不能|評估/.test(raw)) out.intent = 'evaluate';
  return out;
}
