// 排程人力 skill：檢查某一週手工線每天要幾個人、夠不夠，不夠時建議挪工作、加班或找臨時工
// Demo：理解問題用下面的規則、說明用模板，模擬地端 LLM；計算呼叫 weekPlan（供需計算引擎）
import { addDays } from '../../order/engine';
import { mondayOf, weekPlan, type DayPlan } from '../../order/scenarios';
import type { ChatReply, ChatSkill, SkillContext, SkillDef } from '../types';

export const scheduleSkill: SkillDef = {
  id: 'schedule',
  name: '排程人力',
  enabled: true,
  description: '檢查一週的生管排程與手工線出勤，判斷人力夠不夠，並建議挪工作、加班或找臨時工',
  tools: [
    { name: 'check_week_staffing', desc: '輸入週別與出勤異動，回傳每天需要人數、可出勤人數、缺口、加班費與建議' },
  ],
  triggers: /排班|排程|排了|人力|人手|請假|出勤|幾個人|臨時工|缺人|夠不夠人/,
};

export const SCHEDULE_METHOD = [
  '生管排程以手工線標準人數排定；需要人數 ＝ 當天排程工時 × 標準人數 ÷ 正常工時',
  '可出勤人數 ＝ 標準人數 − 已登記請假；使用者說的臨時請假再往下扣',
  '缺人時先找同一週有餘力的工作日挪工作（需確認交期允許）',
  '挪不動就全員加班，平日上限 2 小時、週六依規定費率計算；加班到上限仍不夠才找臨時工',
  '同一天有花生、芝麻兩種過敏原時提醒換線清洗時間',
];

export interface ScheduleState { week?: string; overrides: Record<string, number>; leave: Record<string, number>; focus?: string; last?: ScheduleResult }
export interface ScheduleResult {
  week: string; days: DayPlan[]; suggestions: { date: string; text: string; status: 'ok' | 'warn' | 'fail' }[];
  summary: { personHours: number; shortDays: number; otCost: number; tempWorkers: number };
  std: number; lineName: string; changed: string[]; focus?: string;
}
const empty = (): ScheduleState => ({ overrides: {}, leave: {} });

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const WK = ['日', '一', '二', '三', '四', '五', '六'];
const wd = (d: string) => WK[new Date(d + 'T00:00:00Z').getUTCDay()];
const CN: Record<string, number> = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const num = (s: string) => Number(s) || CN[s] || (s.startsWith('十') ? 10 + (CN[s[1]] ?? 0) : 0);
const WEEKDAY: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };
const pad = (n: number) => String(n).padStart(2, '0');
const weekLabel = (w: string) => `${md(w)}～${md(addDays(w, 5))} 這週`;

// ---------------- 理解問題（模擬 LLM 抽參數） ----------------
interface Parsed {
  week?: string; dates: string[];
  changes: { date: string; kind: 'set' | 'minus' | 'plus' | 'leave'; n: number }[];
  intent: 'evaluate' | 'why' | 'cost' | 'move' | 'plan' | 'reset' | 'help' | 'none';
  needDate?: boolean;
}

function parse(raw: string, st: ScheduleState, { om }: SkillContext): Parsed {
  const asOf = om.asOf; const y0 = Number(asOf.slice(0, 4));
  const thisMon = mondayOf(asOf);
  const out: Parsed = { dates: [], changes: [], intent: 'none' };
  const text = raw.replace(/\s+/g, '');

  // 週別
  if (/下下(週|周|禮拜|星期)(?![一二三四五六日天])/.test(text)) out.week = addDays(thisMon, 14);
  else if (/(下一|再下一|後一)(週|周)|下週呢|下周呢/.test(text) && st.week) out.week = addDays(st.week, 7);
  else if (/(上一)(週|周)/.test(text) && st.week) out.week = addDays(st.week, -7);
  else if (/下(週|周|禮拜|星期)(?![一二三四五六日天])/.test(text)) out.week = addDays(thisMon, 7);
  else if (/(這|本)(週|周|禮拜|星期)(?![一二三四五六日天])/.test(text)) out.week = thisMon;

  // 日期：12/8、12月8日、週三／下週三、明天
  const dateAt: { date: string; idx: number }[] = [];
  for (const m of text.matchAll(/(\d{1,2})[/月](\d{1,2})[日號]?/g)) {
    let d = `${y0}-${pad(+m[1])}-${pad(+m[2])}`;
    if (d < thisMon) d = `${y0 + 1}-${pad(+m[1])}-${pad(+m[2])}`;
    dateAt.push({ date: d, idx: m.index ?? 0 });
  }
  for (const m of text.matchAll(/(下下|下|這|本)?(?:週|周|星期|禮拜)([一二三四五六日天])/g)) {
    const base = m[1] === '下下' ? addDays(thisMon, 14) : m[1] === '下' ? addDays(thisMon, 7) : m[1] ? thisMon : (out.week ?? st.week ?? thisMon);
    dateAt.push({ date: addDays(base, WEEKDAY[m[2]]), idx: m.index ?? 0 });
  }
  for (const m of text.matchAll(/(今天|明天|後天)/g)) dateAt.push({ date: addDays(asOf, { 今天: 0, 明天: 1, 後天: 2 }[m[1] as '今天']), idx: m.index ?? 0 });
  dateAt.sort((a, b) => a.idx - b.idx);
  out.dates = dateAt.map((x) => x.date);
  if (!out.week && out.dates.length) out.week = mondayOf(out.dates[0]);

  // 出勤異動：「12/8 只剩 9 人」「12/15 有 3 人請假」「週三少 2 人」，可一次說好幾天
  for (const m of text.matchAll(/(\d+|十?[一二兩三四五六七八九十])個?人/g)) {
    const idx = m.index ?? 0; const n = num(m[1]);
    const before = text.slice(Math.max(0, idx - 8), idx); const after = text.slice(idx, idx + m[0].length + 4);
    const near = dateAt.filter((x) => x.idx <= idx).pop() ?? (st.focus ? { date: st.focus, idx: -1 } : undefined);
    const kind = /請假|請了/.test(after + before) ? 'leave' : /少|缺|減/.test(before) ? 'minus' : /多|加|增/.test(before) ? 'plus' : /剩|只有|出勤|來|上班|有/.test(before) ? 'set' : null;
    if (!kind || !n) continue;
    if (!near) { out.needDate = true; continue; }
    out.changes.push({ date: near.date, kind, n });
  }

  if (/重新|重來|清除|另一週/.test(text)) out.intent = 'reset';
  else if (/你能|可以做什麼|怎麼用/.test(text)) out.intent = 'help';
  else if (out.changes.length) out.intent = 'evaluate';
  else {
    // 追問上一週的結果（句子裡提到的日期仍在同一週）→ 不重算
    const follow = st.last && (!out.week || out.week === st.week);
    if (follow && /為什麼|原因|怎麼會/.test(text)) out.intent = 'why';
    else if (follow && /多少錢|費用|加班費|成本|花多少/.test(text)) out.intent = 'cost';
    else if (follow && /挪|調到|移到|換到|改到|搬/.test(text)) out.intent = 'move';
    else if (follow && /排了什麼|排什麼|做什麼|生產什麼|排程內容|在做/.test(text)) out.intent = 'plan';
    else if (out.week || scheduleSkill.triggers.test(text) || /夠嗎|夠不夠|來得及/.test(text)) out.intent = 'evaluate';
  }
  return out;
}

// ---------------- 呼叫計算工具 ----------------
function compute(ctx: SkillContext, week: string, overrides: Record<string, number>, changed: string[], focus?: string): ScheduleResult {
  const { om, model } = ctx;
  const wp = weekPlan(om, model, week, overrides);
  const days = wp.days.filter((d) => d.date >= om.asOf); // 已經過去的日子不檢查
  const suggestions = wp.suggestions.filter((s) => s.date >= om.asOf);
  const summary = {
    personHours: days.reduce((s, d) => s + d.manual.personHours, 0),
    shortDays: days.filter((d) => d.manual.gap < 0).length,
    otCost: days.reduce((s, d) => s + d.manual.otCost, 0),
    tempWorkers: days.reduce((s, d) => s + d.manual.tempWorkers, 0),
  };
  return { week, days, suggestions, summary, std: wp.manualLine.std_headcount, lineName: wp.manualLine.name, changed, focus };
}

export const verdictOf = (r: ScheduleResult) => (r.summary.tempWorkers > 0 ? 'fail' : r.summary.shortDays > 0 ? 'warn' : 'ok') as 'ok' | 'warn' | 'fail';
export function headlineOf(r: ScheduleResult) {
  const short = r.days.filter((d) => d.manual.gap < 0);
  if (!short.length) return '人力足夠：每天的出勤人數都排得完';
  const list = short.map((d) => `${md(d.date)} 少 ${-d.manual.gap} 人`).join('、');
  if (r.summary.tempWorkers > 0) return `${list}：光靠加班補不滿，要挪工作或找臨時工 ${r.summary.tempWorkers} 人次`;
  return `${list}：可挪工作或加班解決（加班約 $${Math.round(r.summary.otCost).toLocaleString()}）`;
}

// ---------------- 對話 ----------------
export function runSchedule(input: string, st: ScheduleState, ctx: SkillContext): { reply: ChatReply<ScheduleResult>; state: ScheduleState } {
  const { om, model } = ctx;
  const p = parse(input, st, ctx);
  const trace = ['分流：交給「排程人力」skill'];
  const thisMon = mondayOf(om.asOf);
  const lastMon = mondayOf(om.horizon);

  if (p.intent === 'reset') return { state: empty(), reply: { text: ['好，條件已清除。想看哪一週的人力？'], trace: [...trace, '清除對話中的條件'], chips: examples(ctx).slice(0, 2) } };
  if (p.intent === 'help') return { state: st, reply: { text: [
    '我可以檢查某一週手工線的人力夠不夠，並建議挪工作、加班或找臨時工。例如：',
    ...examples(ctx).slice(0, 3).map((x) => `・${x}`),
    '也可以直接告訴我臨時請假，例如「12/15 有 3 人請假」，我會用新的出勤人數重算。',
  ], trace, chips: examples(ctx).slice(0, 2) } };

  const last = st.last;
  if (last && ['why', 'cost', 'move', 'plan'].includes(p.intent)) {
    trace.push('沿用上一輪的檢查結果，不重新計算');
    const text = p.intent === 'why' ? explainWhy(last, ctx) : p.intent === 'cost' ? explainCost(last) : p.intent === 'move' ? explainMove(last) : explainPlan(last, ctx);
    return { state: st, reply: { text, trace, chips: chipsFor(last) } };
  }
  if (p.needDate && !p.changes.length) {
    return { state: st, reply: { text: ['是哪一天的出勤有變動？例如「12/15 有 3 人請假」。'], trace: [...trace, '有人數但沒有日期，先追問'] } };
  }
  if (p.intent === 'none' && !p.changes.length) {
    return { state: st, reply: { text: last
      ? ['我沒有看懂這句。可以說臨時請假（例如「12/9 再少 1 人」）、換一週（「下一週呢？」），或問「為什麼缺人？」「加班要多少錢？」']
      : ['想看哪一週的人力？例如「下週手工線人力夠嗎？」或「12/15 有 3 人請假怎麼辦？」'], trace, chips: last ? chipsFor(last) : examples(ctx).slice(0, 3) } };
  }

  // 合併條件
  const week = p.week ?? st.week ?? (p.changes[0] ? mondayOf(p.changes[0].date) : mondayOf(addDays(om.asOf, 7)));
  if (week < thisMon || week > lastMon) {
    return { state: st, reply: { text: [`${weekLabel(week)}不在可檢查的範圍內（目前排程資料涵蓋 ${md(om.asOf)}～${md(om.horizon)}），請換一週。`], trace: [...trace, '週別超出排程資料期間，不計算'] } };
  }
  const sameWeek = week === st.week;
  const overrides = sameWeek ? { ...st.overrides } : {};
  const leave = sameWeek ? { ...st.leave } : {};
  const changed: string[] = [];
  const notes: string[] = [];
  const std = om.lines.find((l) => l.line_type === '手工')!.std_headcount;
  const manualId = om.lines.find((l) => l.line_type === '手工')!.line_id;
  for (const c of p.changes) {
    if (mondayOf(c.date) !== week) { notes.push(`${md(c.date)} 不在 ${weekLabel(week)}，先略過`); continue; }
    const base = om.persons(manualId, c.date);
    const cur = overrides[c.date] ?? base;
    const next = c.kind === 'set' ? c.n : c.kind === 'plus' ? cur + c.n : cur - c.n;
    const v = Math.max(0, Math.min(std + 6, next));
    overrides[c.date] = v;
    if (c.kind === 'leave') leave[c.date] = (leave[c.date] ?? 0) + c.n;
    changed.push(c.date);
    notes.push(`${md(c.date)}（${wd(c.date)}）可出勤 ${cur} → ${v} 人${c.kind === 'leave' ? `（已登記請假 ${std - base} 人，再加臨時請假 ${c.n} 人）` : ''}`);
  }
  if (!sameWeek && st.week) trace.push(`換一週：${weekLabel(st.week)} → ${weekLabel(week)}`);
  else if (!st.week) trace.push(`抽出參數：${weekLabel(week)}`);
  if (notes.length) trace.push(`出勤異動：${notes.join('；')}`);
  trace.push(`呼叫工具：check_week_staffing(${week}${Object.keys(overrides).length ? `, ${JSON.stringify(Object.fromEntries(Object.entries(overrides).map(([d, v]) => [md(d), v])))}` : ''})`);
  const focus = p.dates[0] ?? (sameWeek ? st.focus : undefined);
  const r = compute(ctx, week, overrides, [...new Set([...(sameWeek ? Object.keys(st.overrides) : []), ...changed])], focus);
  trace.push('依輸出格式整理成結果卡，並寫成說明');
  void model;
  return { state: { week, overrides, leave, focus, last: r }, reply: { text: explain(r, notes.filter((n) => n.includes('略過'))), trace, result: r, chips: chipsFor(r) } };
}

// ---------------- 說明模板（數字全部來自計算結果） ----------------
function explain(r: ScheduleResult, warnings: string[]): string[] {
  const out: string[] = [];
  const v = verdictOf(r);
  const need = r.days.map((d) => d.manual.needed).filter((n) => n > 0);
  if (v === 'ok') out.push(need.length
    ? `${weekLabel(r.week)}${r.lineName}人力足夠。有排程的日子每天需要 ${Math.min(...need) === Math.max(...need) ? Math.min(...need) : `${Math.min(...need)}～${Math.max(...need)}`} 人，可出勤人數都排得完，不需要加班。`
    : `${weekLabel(r.week)}${r.lineName}沒有排程，不需要人力。`);
  else {
    const hard = r.days.filter((d) => d.manual.tempWorkers > 0).length;
    out.push(`${weekLabel(r.week)}有 ${r.summary.shortDays} 天${r.lineName}人手不夠${hard ? `，其中 ${hard} 天光靠加班補不滿，要挪工作或找臨時工` : '，挪工作或加班都能解決'}：`);
  }
  for (const s of r.suggestions.filter((x) => x.status !== 'ok')) out.push(`・${s.text}`);
  if (v !== 'ok') out.push(`如果都用加班解決，全週加班費約 $${Math.round(r.summary.otCost).toLocaleString()}${r.summary.tempWorkers ? `，另需臨時工 ${r.summary.tempWorkers} 人次` : ''}。建議先挪工作，挪不動再加班。`);
  const al = r.suggestions.filter((x) => x.status === 'ok');
  if (al.length) out.push(`另外提醒：${al.map((x) => x.text).join('；')}。`);
  if (r.changed.length) out.push(`（已套用出勤異動：${r.changed.map((d) => `${md(d)} ${r.days.find((x) => x.date === d)?.manual.available ?? '—'} 人`).join('、')}）`);
  for (const w of warnings) out.push(`⚠ ${w}`);
  return out;
}

function explainWhy(r: ScheduleResult, { om, model }: SkillContext): string[] {
  const short = r.days.filter((d) => d.manual.gap < 0);
  if (!short.length) return ['這週沒有缺人：每天排程需要的人數都不超過可出勤人數。'];
  const manualId = om.lines.find((l) => l.line_type === '手工')!.line_id;
  return short.map((d) => {
    const list = d.lines.find((l) => l.line_id === manualId)?.items.map((i) => `${model.items.get(i.item_id)?.name.replace(/[（(].*$/, '') ?? i.item_id} ${i.qty.toLocaleString()}`).join('、') || '—';
    return `・${md(d.date)}（${wd(d.date)}）：手工線排了 ${list}，共 ${Math.round(d.manual.personHours)} 人時，要 ${d.manual.needed} 人才做得完；可出勤只有 ${d.manual.available} 人${r.changed.includes(d.date) ? '（含你說的臨時異動）' : '（有人請假）'}，少 ${-d.manual.gap} 人。`;
  }).concat(['生管排程是以標準人數排的，請假是排好之後才知道，所以這幾天會出現缺口。']);
}

function explainCost(r: ScheduleResult): string[] {
  const short = r.days.filter((d) => d.manual.gap < 0);
  if (!short.length) return ['這週不需要加班。'];
  return [
    ...short.map((d) => `・${md(d.date)}：${d.manual.available} 人各加班 ${d.manual.otHours.toFixed(1)} 小時，約 $${Math.round(d.manual.otCost).toLocaleString()}${d.manual.tempWorkers ? `；加班到上限仍不夠，另需臨時工 ${d.manual.tempWorkers} 人` : ''}`),
    `全週合計約 $${Math.round(r.summary.otCost).toLocaleString()}。加班費率：平日每人每小時 $300、週六 $330；每人每月加班上限 46 小時。`,
  ];
}

function explainMove(r: ScheduleResult): string[] {
  const mv = r.suggestions.filter((s) => s.text.includes('挪到'));
  if (!mv.length) return r.summary.shortDays ? ['這週其他天也都排滿了，沒有地方可以挪，只能加班或找臨時工。'] : ['這週不用挪工作，人力都夠。'];
  return [...mv.map((s) => `・${s.text.replace(/：.*?可把/, '：可把').replace(/；或全員加班.*$/, '')}`), '挪之前要先跟業務確認，被挪動的那批貨交期是否允許；挪動後不需要額外成本。'];
}

function explainPlan(r: ScheduleResult, { om, model }: SkillContext): string[] {
  const out = [`${weekLabel(r.week)}各產線排程：`];
  for (const d of r.days) {
    const parts = d.lines.filter((l) => l.items.length).map((l) => `${om.lines.find((x) => x.line_id === l.line_id)?.name.replace(/（.*）/, '')}：${l.items.map((i) => `${model.items.get(i.item_id)?.name.replace(/[（(].*$/, '') ?? i.item_id}${i.allergen ? '⚠' : ''}`).join('、')}`);
    out.push(`・${md(d.date)}（${wd(d.date)}）${parts.join('｜') || '無排程'}`);
  }
  out.push('⚠ 為含花生或芝麻的品項，同一天會排在最後生產。');
  return out;
}

function chipsFor(r: ScheduleResult): string[] {
  const chips: string[] = [];
  const short = r.days.find((d) => d.manual.gap < 0);
  if (short) chips.push(`為什麼 ${md(short.date)} 缺人？`);
  if (r.suggestions.some((s) => s.text.includes('挪到'))) chips.push('可以挪到哪天？');
  if (short) chips.push('加班要多少錢？');
  const ok = r.days.find((d) => d.manual.gap >= 0 && d.dayType === '工作日');
  if (ok) chips.push(`${md(ok.date)} 有 2 人請假呢？`);
  chips.push('那週排了什麼？');
  chips.push('下一週呢？');
  return chips.slice(0, 5);
}

function examples({ om }: SkillContext): string[] {
  const next = addDays(mondayOf(om.asOf), 7);
  const w2 = addDays(next, 14);
  return [
    '下週手工線人力夠嗎？',
    `${md(addDays(w2, 1))} 那週人手排得過來嗎？`,
    `${md(addDays(next, 21 + 1))} 臨時有 3 人請假，怎麼辦？`,
    `下週三只剩 9 人，排得完嗎？`,
  ];
}

export const scheduleChat: ChatSkill<ScheduleState, ScheduleResult> = {
  def: scheduleSkill,
  greeting: '你好，我是排程人力助理。告訴我想看哪一週，我會對照生管排程和出勤，算出手工線每天要幾個人、夠不夠；有人臨時請假也可以直接告訴我。',
  placeholder: '例如：12/15 有 3 人請假，人力還夠嗎？',
  method: { steps: SCHEDULE_METHOD, params: '週別（必要）；出勤異動（選填，例如某天請假幾人、只剩幾人）', output: '固定格式的結果卡（判定、每日需要／可出勤、缺口、加班費、建議），加上一段白話說明' },
  examples,
  empty,
  run: runSchedule,
  title: (st) => (st.week ? `${md(st.week)} 週人力${Object.keys(st.overrides).length ? `（${Object.keys(st.overrides).length} 天異動）` : ''}` : null),
  pills: (st) => [
    ...(st.week ? [['週別', `${md(st.week)}～${md(addDays(st.week, 5))}`] as [string, string]] : []),
    ...Object.entries(st.overrides).sort().map(([d, v]) => [`${md(d)} 出勤`, `${v} 人`] as [string, string]),
  ],
  clear: () => empty(),
};
