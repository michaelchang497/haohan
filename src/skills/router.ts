// 分流層：判斷一句話屬於哪個 skill（demo 用關鍵字模擬 LLM 的判斷）
// 正式版：地端 LLM 讀各 skill 的 description 選一個；沒有合適的就明說不支援，不自己編答案
import type { SkillContext, SkillDef } from './types';
import { insertSkill } from './insert/skill';
import { parseInsert } from './insert/parse';
import { scheduleSkill } from './schedule/skill';

export const SKILLS: SkillDef[] = [
  insertSkill,
  scheduleSkill,
  { id: 'purchase', name: '採購建議', enabled: false, description: '依排程用量與前置天數，列出該買的料與最晚下單日', tools: [], triggers: /採購|進貨|叫貨|要買|下採購|補貨|訂料/ },
  { id: 'season', name: '旺季備貨', enabled: false, description: '依去年同期與成長率，規劃檔期前的備貨與開工日', tools: [], triggers: /春節|旺季|備貨|過年|中秋|端午|檔期/ },
];

// 回傳這句話「明顯」屬於的 skill；不明顯就回傳 null，交給目前的 skill 處理（例如追問「為什麼？」）
export function detectSkill(input: string, ctx: SkillContext): string[] {
  const hits: string[] = [];
  const p = parseInsert(input, ctx);
  const headcount = /(\d+|[一二兩三四五六七八九十])\s*個?人/.test(input);
  if (p.slots.customer_id || (p.slots.item_id && (p.slots.qty || p.slots.due_date)) || insertSkill.triggers.test(input)) hits.push('insert');
  if (!p.slots.customer_id && (scheduleSkill.triggers.test(input) || headcount)) hits.push('schedule');
  for (const s of SKILLS) if (!s.enabled && s.triggers.test(input) && !hits.length) hits.push(s.id);
  return hits;
}
