import { useMemo, useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '../context/AppContext';
import { addDays } from '../order/engine';
import { purchaseSuggestions, seasonPlan } from '../order/scenarios';
import { fmtInt, fmtMoney } from '../lib/format';
import { Card, ChartTip, COLORS, DataTable, axisProps } from '../components/ui';
import { StatusTag } from './OrderInsert';
import InsertChat from './InsertChat';
import ScheduleChat from './ScheduleChat';
import { SKILLS } from '../skills/router';

const md = (d: string | null) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '—');
const URG = { late: ['fail', '來不及'], today: ['fail', '今天下單'], week: ['warn', '本週'], next: ['ok', '下週'], later: ['ok', '之後'] } as const;

const TABS = [
  { id: 'insert', n: 1, name: '插單評估', q: '這張單接不接得了？怎麼接？' },
  { id: 'schedule', n: 2, name: '排程人力', q: '這週怎麼排？手工線要幾個人？' },
  { id: 'purchase', n: 3, name: '採購建議', q: '該買什麼？最晚哪天下單？' },
  { id: 'season', n: 4, name: '旺季備貨', q: '春節禮盒要提前多久做？' },
] as const;

export default function Scenarios() {
  const { route, navigate, order, orderError } = useApp();
  const enabled = (id: string) => SKILLS.find((s) => s.id === id)?.enabled ?? false;
  const asked = (route.params.get('tab') ?? 'insert') as (typeof TABS)[number]['id'];
  const tab = enabled(asked) ? asked : 'insert'; // 未開放的情境一律回到插單評估
  if (orderError) return <div className="loading">資料載入失敗：{orderError}</div>;
  if (!order) return <div className="loading">載入中…</div>;
  return (
    <div className="grid">
      <div className="page-title span-12">
        <h2>決策支援</h2>
        <p>每個情境是一個獨立的 skill，共用同一個供需計算引擎與同一份資料（庫存、在途採購、訂單、排程、產能、規則）。目前開放插單評估、排程人力</p>
      </div>
      <div className="tabs span-12" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} aria-disabled={!enabled(t.id)} disabled={!enabled(t.id)}
            className={`tab ${tab === t.id ? 'on' : ''} ${enabled(t.id) ? '' : 'locked'}`} onClick={() => navigate(`#/scenarios?tab=${t.id}`)}
            title={enabled(t.id) ? undefined : '尚未開放'}>
            <span className="tab-n">{enabled(t.id) ? t.n : <LockIcon />}</span>
            <span><b>{t.name}{!enabled(t.id) && <i className="soon">尚未開放</i>}</b><em>{t.q}</em></span>
          </button>
        ))}
      </div>
      <div className="span-12">
        {tab === 'insert' && <InsertChat />}
        {tab === 'schedule' && <ScheduleChat />}
        {tab === 'purchase' && <PurchasePanel />}
        {tab === 'season' && <SeasonPanel />}
      </div>
    </div>
  );
}

function LockIcon() {
  return <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
}

// ======================= 3. 採購建議（尚未開放，表格版保留） =======================
function PurchasePanel() {
  const { order, model } = useApp();
  const om = order!;
  const [keepSafety, setKeep] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const list = useMemo(() => purchaseSuggestions(om, model, keepSafety), [om, model, keepSafety]);
  const name = (id: string) => model.items.get(id)?.name ?? id;
  const sup = (id: string | null) => (id ? model.supplierName(id) : '—');
  const count = (u: string[]) => list.filter((x) => u.includes(x.urgency)).length;
  const total = list.reduce((s, x) => s + x.amount, 0);

  return (
    <div className="grid">
      <Card className="span-12" title="採購建議" subtitle="依目前排程推算每種原料、包材的結存；找出會不夠（或低於安全存量）的日期，往前推採購前置天數，就是最晚下單日"
        actions={<label className="chk"><input type="checkbox" checked={keepSafety} onChange={(e) => setKeep(e.target.checked)} />保留安全存量（R02）</label>}>
        <div className="kpis kpis-inline">
          <div className="kpi"><div className="kpi-label">需要催貨／來不及</div><div className="kpi-value">{count(['late'])} 項</div></div>
          <div className="kpi"><div className="kpi-label">今天要下單</div><div className="kpi-value">{count(['today'])} 項</div></div>
          <div className="kpi"><div className="kpi-label">本週內要下單</div><div className="kpi-value">{count(['week'])} 項</div></div>
          <div className="kpi"><div className="kpi-label">建議採購金額</div><div className="kpi-value">{fmtMoney(total)}</div></div>
        </div>
      </Card>
      <Card className="span-12" title="建議清單" subtitle="依急迫程度排序；數量補足到需要日後約 2 週的用量，並依最小訂購量進位">
        <DataTable rows={list} rowKey={(x) => `${x.item_id}-${x.needDate}-${x.kind}`} empty="依目前計畫，未來 8 週都不需要追加採購"
          columns={[
            { key: 'u', header: '急迫程度', render: (x) => <StatusTag s={URG[x.urgency][0]} label={URG[x.urgency][1]} /> },
            { key: 'k', header: '動作', render: (x) => (x.kind === 'expedite' ? <b>請廠商提前</b> : '新採購單') },
            { key: 'n', header: '物料', render: (x) => <>{name(x.item_id)}<span className={`tag tag-${model.items.get(x.item_id)?.type}`}>{model.items.get(x.item_id)?.type}</span></> },
            { key: 's', header: '廠商', render: (x) => sup(x.supplier_id) },
            { key: 'o', header: '最晚下單日', align: 'right', render: (x) => md(x.orderBy) },
            { key: 'd', header: '需要日', align: 'right', render: (x) => md(x.needDate) },
            { key: 'q', header: '數量', align: 'right', render: (x) => `${fmtInt(x.qty)} ${model.items.get(x.item_id)?.unit}` },
            { key: 'a', header: '預估金額', align: 'right', render: (x) => (x.amount ? fmtMoney(x.amount) : '—') },
            { key: 'r', header: '原因', render: (x) => <span className="wrap">{x.reason}{x.po_no ? '' : ''}</span> },
          ]} />
        <div className="actions">
          <button className="primary" onClick={() => setNote('demo：正式版會依廠商產生採購單草稿，送採購主管確認')}>產生採購單草稿</button>
          {note && <span className="muted">{note}</span>}
        </div>
      </Card>
    </div>
  );
}

// ======================= 4. 旺季備貨 =======================
function SeasonPanel() {
  const { order, model } = useApp();
  const om = order!;
  const candidates = ['FG04', 'FG12', 'FG03', 'FG05'];
  const [items, setItems] = useState<string[]>(['FG04', 'FG12']);
  const [growth, setGrowth] = useState(8);
  const [allowOT, setOT] = useState(false);
  const event = '2027-02-06'; const lastEvent = '2026-02-17';
  const sp = useMemo(() => seasonPlan(om, model, { items, growth: growth / 100, allowOT, event, lastEvent, weeks: 5 }), [om, model, items, growth, allowOT]);
  const [line, setLine] = useState<string | null>(null);
  const showLine = line && sp.mainLines.includes(line) ? line : sp.mainLines[0];
  const name = (id: string) => model.items.get(id)?.name ?? id;
  const unitOf = (id: string) => model.items.get(id)?.unit ?? '';
  const chart = sp.weeks.filter((w) => w.line_id === showLine).map((w) => ({
    label: md(w.week), existing: +w.existing.toFixed(1), season: +w.season.toFixed(1), seasonOT: +w.seasonOT.toFixed(1), capacity: w.capacity,
  }));
  const toggle = (id: string) => setItems((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  const s = sp.summary;

  return (
    <div className="grid">
      <Card className="span-12" title="旺季備貨：2027 春節（2/6）" subtitle={`預估量 ＝ 去年春節前 5 週（${md(addDays(lastEvent, -35))}–${md(addDays(lastEvent, -1))}）的實際銷量 × (1 + 成長率)，再扣掉已經接到的訂單`}>
        <div className="season-ctl">
          <div><span className="ctl-label">品項</span>
            {candidates.map((id) => <label key={id} className="chk"><input type="checkbox" checked={items.includes(id)} onChange={() => toggle(id)} />{name(id)}</label>)}
          </div>
          <div className="growth"><span className="ctl-label">成長率</span>
            <input type="range" min={-10} max={40} value={growth} onChange={(e) => setGrowth(Number(e.target.value))} aria-label="成長率" /><b>{growth > 0 ? '+' : ''}{growth}%</b>
          </div>
          <label className="chk"><input type="checkbox" checked={allowOT} onChange={(e) => setOT(e.target.checked)} />允許加班</label>
        </div>
        <div className="kpis kpis-inline">
          <div className="kpi"><div className="kpi-label">春節前 5 週預估</div><div className="kpi-value">{fmtInt(s.forecast)}</div><div className="kpi-deltas"><span className="kpi-dl">已接訂單 {fmtInt(s.booked)}，還要備 {fmtInt(s.extra)}</span></div></div>
          <div className="kpi"><div className="kpi-label">建議開工日</div><div className="kpi-value">{md(s.start)}</div><div className="kpi-deltas"><span className="kpi-dl">最早可開工 {md(s.earliestAllowed)}（效期與允收期限制）</span></div></div>
          <div className="kpi"><div className="kpi-label">排不進去的量</div><div className={`kpi-value ${s.shortfall ? 'neg' : ''}`}>{fmtInt(s.shortfall)}</div><div className="kpi-deltas"><span className="kpi-dl">{s.shortfall ? (allowOT ? '加班後仍不足' : '試試「允許加班」') : '全部排得進去'}</span></div></div>
          <div className="kpi"><div className="kpi-label">需要加班</div><div className="kpi-value">{s.otHours.toFixed(0)} 小時</div><div className="kpi-deltas"><span className="kpi-dl">{allowOT ? '' : '目前未允許加班'}</span></div></div>
        </div>
      </Card>

      <Card className="span-7" title="每週備貨計畫" subtitle="可生產期間：最早受效期與允收期限制（做太早到貨時效期不夠），最晚受出貨前置天數限制">
        <DataTable rows={sp.buckets} rowKey={(b) => `${b.item_id}-${b.k}`} maxHeight={400}
          columns={[
            { key: 'i', header: '品項', render: (b) => name(b.item_id) },
            { key: 'k', header: '交貨週', render: (b) => `春節前第 ${b.k} 週（${md(b.due)}）` },
            { key: 'l', header: '去年同期', align: 'right', render: (b) => fmtInt(b.lastYear) },
            { key: 'f', header: '今年預估', align: 'right', render: (b) => fmtInt(b.forecast) },
            { key: 'b', header: '已接單', align: 'right', render: (b) => fmtInt(b.booked) },
            { key: 'w', header: '可生產期間', align: 'right', render: (b) => `${md(b.earliest)}–${md(b.latest)}` },
            { key: 'p', header: '已安排', align: 'right', render: (b) => `${fmtInt(b.produced)} ${unitOf(b.item_id)}` },
            { key: 's', header: '缺口', align: 'right', render: (b) => (b.shortfall ? <span className="neg strong">{fmtInt(b.shortfall)}</span> : '—') },
          ]} />
      </Card>

      <Card className="span-5" title={`產線週負荷：${om.lines.find((l) => l.line_id === showLine)?.name ?? ''}`} subtitle="每週工時；灰色為既有排程，藍色、橘色為備貨"
        actions={sp.mainLines.length > 1 ? <div className="seg">{sp.mainLines.map((l) => <button key={l} className={showLine === l ? 'on' : ''} onClick={() => setLine(l)}>{om.lines.find((x) => x.line_id === l)?.name}</button>)}</div> : undefined}>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={4}>
            <CartesianGrid vertical={false} stroke={COLORS.grid} />
            <XAxis dataKey="label" {...axisProps} interval={0} tick={{ fill: COLORS.muted, fontSize: 10 }} />
            <YAxis {...axisProps} axisLine={false} width={32} />
            <Tooltip cursor={{ fill: 'rgba(11,11,11,0.04)' }} content={<ChartTip fmt={(v) => `${v} 小時`} labelFmt={(l) => `${l} 這週`} />} />
            <Legend wrapperStyle={{ fontSize: 12, color: COLORS.ink2 }} />
            <Bar dataKey="existing" name="既有排程" stackId="h" fill="#c3c2b7" isAnimationActive={false} />
            <Bar dataKey="season" name="備貨（正常工時）" stackId="h" fill={COLORS.s1} isAnimationActive={false} />
            <Bar dataKey="seasonOT" name="備貨（加班）" stackId="h" fill={COLORS.s2} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            <Line type="stepAfter" dataKey="capacity" name="正常工時上限" stroke={COLORS.ink2} strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
        {sp.beyondHorizon && <p className="note">{md(om.horizon)} 之後還沒有排程，既有負荷以目前非檔期品項的平均負荷估計。</p>}
      </Card>

      <Card className="span-12" title="備貨需要的原料與包材" subtitle="把備貨計畫的用量疊上目前的供需，找出要提前叫的料">
        <DataTable rows={sp.materials} rowKey={(m) => m.item_id} maxHeight={360}
          columns={[
            { key: 's', header: '狀態', render: (m) => <StatusTag s={m.status} label={m.status === 'fail' ? '來不及' : m.status === 'warn' ? '要提前叫' : '夠用'} /> },
            { key: 'n', header: '物料', render: (m) => <>{name(m.item_id)}<span className={`tag tag-${model.items.get(m.item_id)?.type}`}>{model.items.get(m.item_id)?.type}</span></> },
            { key: 't', header: '備貨用量', align: 'right', render: (m) => `${fmtInt(m.total)} ${unitOf(m.item_id)}` },
            { key: 'f', header: '開始使用', align: 'right', render: (m) => md(m.first) },
            { key: 'o', header: '最晚下單日', align: 'right', render: (m) => md(m.orderBy) },
            { key: 'l', header: '前置天數', align: 'right', render: (m) => `${m.lead} 天` },
            { key: 'd', header: '說明', render: (m) => <span className="wrap">{m.shortDate ? `${md(m.shortDate)} 會不夠` : m.lowDate ? `${md(m.lowDate)} 會低於安全存量` : '目前庫存與在途足夠'}{m.orderBy && m.status !== 'ok' ? `，請在 ${md(m.orderBy)} 前下單` : ''}</span> },
          ]} />
      </Card>
    </div>
  );
}
