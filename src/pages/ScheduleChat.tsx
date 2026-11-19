import { useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { addDays } from '../order/engine';
import { mondayOf } from '../order/scenarios';
import { fmtInt, fmtMoney } from '../lib/format';
import { StatusIcon, Tip } from '../components/ui';
import SkillChat from '../components/SkillChat';
import { headlineOf, scheduleChat, verdictOf, type ScheduleResult } from '../skills/schedule/skill';

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const WK = ['日', '一', '二', '三', '四', '五', '六'];
const wd = (d: string) => WK[new Date(d + 'T00:00:00Z').getUTCDay()];

export default function ScheduleChat() {
  const { order } = useApp();
  const seeds = useMemo(() => {
    const w = addDays(mondayOf(order!.asOf), 21);
    return [{ text: `${md(addDays(w, 1))} 那週人手排得過來嗎？`, at: '今天 08:55' }];
  }, [order]);
  return <SkillChat skill={scheduleChat} Card={ScheduleCard} seeds={seeds} />;
}

// 一張結果卡：每天一格（需要／可出勤），缺人的日子標色；明細按需展開
export function ScheduleCard({ r }: { r: ScheduleResult }) {
  const { order, model } = useApp();
  const om = order!;
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const v = verdictOf(r);
  const manualId = om.lines.find((l) => l.line_type === '手工')!.line_id;
  const itemName = (id: string) => model.items.get(id)?.name.replace(/[（(].*$/, '') ?? id;
  const wkEnd = addDays(r.week, 5);
  return (
    <div className={`rmini rmini-${v}`}>
      <div className="rmini-top">
        <span className="v-dot" aria-hidden><StatusIcon s={v} /></span>
        <div>
          <b>{headlineOf(r)}</b>
          <span>{md(r.week)}～{md(wkEnd)}・{r.lineName}（標準 {r.std} 人）・需求 {fmtInt(r.summary.personHours)} 人時</span>
        </div>
      </div>
      <div className="days" style={{ gridTemplateColumns: `repeat(${Math.max(r.days.length, 5)}, minmax(0, 1fr))` }}>
        {r.days.map((d) => {
          const m = d.manual;
          const items = d.lines.find((l) => l.line_id === manualId)?.items ?? [];
          return (
            <Tip key={d.date} content={<>
              <b>{md(d.date)}（{wd(d.date)}）{d.dayType === '加班日' ? '・週六加班日' : ''}</b>
              <span>手工線：{items.length ? items.map((i) => `${itemName(i.item_id)} ${fmtInt(i.qty)}`).join('、') : '無排程'}</span>
              <span>{Math.round(m.personHours)} 人時 → 需要 {m.needed} 人，可出勤 {m.available} 人</span>
              {m.gap < 0 && <span>{m.tempWorkers ? `加班到上限仍不足，需臨時工 ${m.tempWorkers} 人` : `全員加班 ${m.otHours.toFixed(1)} 小時，約 ${fmtMoney(m.otCost)}`}</span>}
            </>}>
              <div className={`day day-${m.status} ${r.changed.includes(d.date) ? 'changed' : ''} ${r.focus === d.date ? 'focus' : ''}`}>
                <div className="day-h">{wd(d.date)} <span>{md(d.date)}</span></div>
                <div className="day-v"><b>{m.available}</b><span>／{m.needed}</span></div>
                <div className="day-s">{m.gap < 0 ? `少 ${-m.gap} 人` : m.needed ? `餘 ${m.gap} 人` : '無排程'}</div>
                {r.changed.includes(d.date) && <i className="day-tag">異動</i>}
              </div>
            </Tip>
          );
        })}
      </div>
      <div className="days-legend">每格：可出勤 ／ 需要人數</div>
      <div className="rmini-foot">
        <span>缺人 <b>{r.summary.shortDays} 天</b></span>
        <span>加班費 <b>{r.summary.otCost ? fmtMoney(r.summary.otCost) : '—'}</b></span>
        <span>臨時工 <b className={r.summary.tempWorkers ? 'neg' : ''}>{r.summary.tempWorkers ? `${r.summary.tempWorkers} 人次` : '—'}</b></span>
        <button className="ghost" onClick={() => setOpen((x) => !x)} aria-expanded={open}>{open ? '收起明細' : '看明細'}</button>
      </div>
      {open && (
        <div className="rmini-body sched-body">
          <div>
            <div className="rb-h">建議處理</div>
            {r.suggestions.length ? r.suggestions.map((s, i) => (
              <p key={i} className={`sugg-line sugg-${s.status}`}><StatusIcon s={s.status === 'ok' ? 'warn' : s.status} size={11} />{s.text}</p>
            )) : <p className="muted">人力足夠，不需要調整</p>}
          </div>
          <div>
            <div className="rb-h">每日明細（手工線）</div>
            <div className="rb-row rb-head"><span>日期</span><span className="rb-num">需要</span><span className="rb-num">可出勤</span><span className="rb-num">加班</span></div>
            {r.days.map((d) => (
              <div key={d.date} className="rb-row">
                <span>{md(d.date)}（{wd(d.date)}）</span>
                <span className="rb-num">{d.manual.needed}</span>
                <span className={`rb-num ${d.manual.gap < 0 ? 'neg' : ''}`}>{d.manual.available}</span>
                <span className="rb-num">{d.manual.otHours ? `${d.manual.otHours.toFixed(1)} h` : '—'}</span>
              </div>
            ))}
          </div>
          <div className="rb-actions">
            <button className="ghost" onClick={() => setNote('demo：已存成草稿')}>存成草稿</button>
            {note && <span className="muted">{note}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
