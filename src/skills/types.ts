// 對話式決策支援的共用型別
// 正式版：分流層與 skill 由地端 LLM 執行（理解問題、抽參數、寫說明），計算一律交給供需計算引擎
// Demo：用前端規則模擬 LLM 的「理解」與「寫說明」，計算是真的
import type { Model } from '../lib/engine';
import type { OrderModel } from '../order/engine';

export interface SkillContext { om: OrderModel; model: Model }

export interface ChatReply<R = unknown> {
  text: string[];            // 段落；以「・」開頭的行顯示成條列
  trace: string[];           // 系統動作（分流、抽參數、呼叫工具），給 demo 說明架構用
  result?: R;                // 有呼叫計算時附上，畫成結果卡
  chips?: string[];          // 建議的下一句
  switchTo?: { skill: string; name: string; text: string }; // 這句屬於另一個 skill 時，提供切換
}

export interface SkillDef {
  id: string;
  name: string;
  enabled: boolean;
  description: string;        // 給分流層判斷要不要交給這個 skill
  tools: { name: string; desc: string }[];
  triggers: RegExp;           // demo：用關鍵字模擬分流判斷
}

// 一個可以對話的 skill：只有邏輯，不含畫面
export interface ChatSkill<S, R> {
  def: SkillDef;
  greeting: string;
  placeholder: string;
  method: { steps: string[]; params: string; output: string };
  examples: (ctx: SkillContext) => string[];
  empty: () => S;
  run: (input: string, state: S, ctx: SkillContext) => { reply: ChatReply<R>; state: S };
  title: (state: S, ctx: SkillContext) => string | null;         // 對話標題；null ＝ 還沒有條件
  pills: (state: S, ctx: SkillContext) => [string, string][];     // 底部「沿用條件」
  clear: (state: S) => S;
}
