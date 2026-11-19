// 分流層：判斷一句話屬於哪個 skill（demo 用關鍵字模擬 LLM 的判斷）
// 正式版：地端 LLM 讀各 skill 的 description 選一個；沒有合適的就明說不支援，不自己編答案
import type { SkillContext, SkillDef } from './types';
import { insertSkill } from './insert/skill';
import { parseInsert } from './insert/parse';
import { scheduleSkill } from './schedule/skill';
import { profitSkill } from './profit/skill';

export const SKILLS: SkillDef[] = [
  insertSkill,
  scheduleSkill,
  profitSkill,
  { id: 'purchase', name: '採購建議', enabled: false, description: '依排程用量與前置天數，列出該買的料與最晚下單日', tools: [], triggers: /採購|進貨|叫貨|要買|下採購|補貨|訂料/ },
  { id: 'season', name: '旺季備貨', enabled: false, description: '依去年同期與成長率，規劃檔期前的備貨與開工日', tools: [], triggers: /春節|旺季|備貨|過年|中秋|端午|檔期/ },
];

// 回傳這句話「明顯」屬於的 skill；不明顯就回傳 null，交給目前的 skill 處理（例如追問「為什麼？」）
export function detectSkill(input: string, ctx: SkillContext): string[] {
  const hits: string[] = [];
  // 百分比、月份不是數量，先拿掉再判斷是不是插單
  const p = parseInsert(input.replace(/\d+(\.\d+)?\s*(%|％|趴)/g, ' ').replace(/(\d{1,2})\s*月(?!\s*\d)/g, ' '), ctx);
  const headcount = /(\d+|[一二兩三四五六七八九十])\s*個?人/.test(input);
  // 插單：要有客戶或品項，再加上數量或交期（只講客戶名稱，可能是在問損益）
  if (((p.slots.customer_id || p.slots.item_id) && (p.slots.qty || p.slots.due_date)) || insertSkill.triggers.test(input)) hits.push('insert');
  if (!p.slots.customer_id && (scheduleSkill.triggers.test(input) || headcount)) hits.push('schedule');
  // 損益：要有明確的損益用語（期間、排名、原因、調價、警示），單純「賺多少」留給目前的 skill（例如插單的「這張單賺多少？」）
  const profitWords = /毛利|損益|營收|獲利/.test(input) && /月|今年|去年|本季|哪個|各|排名|為什麼|原因|掉|下滑|變/.test(input);
  if (!/這張單|這筆|接單/.test(input) && (profitWords || /調價|報價|售價|定價|警示|異常|回到\s*\d|目標毛利/.test(input)) && !hits.includes('schedule')) hits.push('profit');
  for (const s of SKILLS) if (!s.enabled && s.triggers.test(input) && !hits.length) hits.push(s.id);
  return hits;
}

// 每個 skill 的頁面位置（跨 skill 切換時用）
export const pathOf = (id: string) => (id === 'profit' ? '#/analysis' : `#/scenarios?tab=${id}`);
