import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '../context/AppContext';
import { addDays, type Assessment, type InsertRequest, type Status } from '../order/engine';
import { fmtInt, fmtMoney, fmtPct, fmtPrice } from '../lib/format';
import { Card, ChartTip, COLORS, DataTable, StatusIcon, axisProps } from '../components/ui';

const md = (d: string | null) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '—');
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const wd = (d: string) => WEEK[new Date(d + 'T00:00:00Z').getUTCDay()];

export function StatusTag({ s, label }: { s: Status; label?: string }) {
  const m = { ok: '可以', warn: '注意', fail: '不行' }[s];
  return <span className={`st st-${s}`}><StatusIcon s={s} size={11} />{label ?? m}</span>;
}

export default function OrderInsert() {
  const { order, orderError, model } = useApp();
  const scenarios = order?.data.insert_scenarios ?? [];
  const first = scenarios[0];
  const [draft, setDraft] = useState<InsertRequest>(() => first
    ? { customer_id: first.customer_id, item_id: first.item_id, qty: first.qty, due_date: first.due_date }
    : { customer_id: 'C09', item_id: 'FG01', qty: 1000, due_date: '2026-12-04' });
  const [req, setReq] = useState<InsertRequest>(draft);
  const [scenarioId, setScenarioId] = useState<string | null>(first?.id ?? null);
  // 情境資料比畫面晚載入：載入後自動帶入第一個情境
  useEffect(() => {
    if (first && scenarioId === null && JSON.stringify(req) === JSON.stringify({ customer_id: 'C09', item_id: 'FG01', qty: 1000, due_date: '2026-12-04' })) {
      const r = { customer_id: first.customer_id, item_id: first.item_id, qty: first.qty, due_date: first.due_date };
      setDraft(r); setReq(r); setScenarioId(first.id);
    }
  }, [first]); // eslint-disable-line react-hooks/exhaustive-deps

  const result = useMemo(() => (order ? order.assess(req) : null), [order, req]);

  if (orderError) return <div className="loading">插單資料載入失敗：{orderError}<br />請執行 <code>npm run mock:order</code>。</div>;
  if (!order || !result) return <div className="loading">載入插單資料中…</div>;

  const customers = model.raw.customers.filter((c) => c.channel_id !== 'TOUR');
  const fgs = model.raw.items.filter((i) => i.type === '成品');
  const unit = model.items.get(draft.item_id)?.unit ?? '';
  const pick = (id: string) => {
    const s = scenarios.find((x) => x.id === id)!;
    const r = { customer_id: s.customer_id, item_id: s.item_id, qty: s.qty, due_date: s.due_date };
    setScenarioId(id); setDraft(r); setReq(r);
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(req);

  return (
    <div className="grid">
      <Card className="span-12" title="需求">
        <div className="scen">
          <span className="scen-label">demo 情境</span>
          {scenarios.map((s) => (
            <button key={s.id} className={`scen-btn ${scenarioId === s.id && !dirty ? 'on' : ''}`} onClick={() => pick(s.id)}>
              <b>{s.id}・{s.title}</b><span>{s.note}</span>
            </button>
          ))}
        </div>
        <form className="req" onSubmit={(e) => { e.preventDefault(); setReq(draft); setScenarioId(null); }}>
          <label>客戶
            <select value={draft.customer_id} onChange={(e) => setDraft({ ...draft, customer_id: e.target.value })}>
              {customers.map((c) => <option key={c.customer_id} value={c.customer_id}>{c.name}（{model.channelName(c.channel_id)}）</option>)}
            </select>
          </label>
          <label>品項
            <select value={draft.item_id} onChange={(e) => setDraft({ ...draft, item_id: e.target.value })}>
              {fgs.map((i) => <option key={i.item_id} value={i.item_id}>{i.name}</option>)}
            </select>
          </label>
          <label>數量
            <span className="qty"><input type="number" min={1} step={10} value={draft.qty} onChange={(e) => setDraft({ ...draft, qty: Math.max(1, Number(e.target.value)) })} /><em>{unit}</em></span>
          </label>
          <label>交期
            <input type="date" value={draft.due_date} min={addDays(order.asOf, 1)} max={order.horizon} onChange={(e) => setDraft({ ...draft, due_date: e.target.value })} />
          </label>
          <button type="submit" className={`primary ${dirty ? 'pulse' : ''}`}>開始評估</button>
        </form>
      </Card>

      <InsertDetail a={result} />
    </div>
  );
}

// 完整分析（表單版與對話版共用）
export function InsertDetail({ a }: { a: Assessment }) {
  const [note, setNote] = useState<string | null>(null);
  return (
    <>
      <Verdict a={a} />

      <div className="checks span-12">
        {a.checks.map((c) => (
          <div key={c.key} className={`check check-${c.status}`}>
            <div className="check-top"><span>{c.label}</span><StatusTag s={c.status} /></div>
            <p>{c.detail}</p>
          </div>
        ))}
      </div>

      <Card className="span-7" title="方案比較" subtitle="★ 為建議方案；方案由系統依規則計算，最後由生管與業務確認">
        <DataTable rows={a.options} rowKey={(o) => o.id}
          columns={[
            { key: 't', header: '方案', render: (o) => <span className={o.recommended ? 'strong' : ''}>{o.recommended ? '★ ' : ''}{o.title}</span> },
            { key: 'f', header: '可行', align: 'center', render: (o) => <StatusTag s={o.feasible ? (o.date === a.req.due_date ? 'ok' : 'warn') : 'fail'} label={o.feasible ? (o.date === a.req.due_date ? '準時' : '延後') : '不可行'} /> },
            { key: 'd', header: '可交日', align: 'right', render: (o) => md(o.date) },
            { key: 'c', header: '額外成本', align: 'right', render: (o) => (o.extraCost ? fmtMoney(o.extraCost) : '—') },
            { key: 'i', header: '說明與影響', render: (o) => <span className="wrap">{o.impact}</span> },
          ]} />
        <div className="actions">
          <button className="ghost" onClick={() => setNote('demo：已存成草稿')}>存成草稿</button>
          {note && <span className="muted">{note}</span>}
        </div>
      </Card>

      <MarginCard a={a} />

      <MaterialsCard a={a} />
      <CapacityCard a={a} />
    </>
  );
}

function Verdict({ a }: { a: Assessment }) {
  const { model } = useApp();
  const it = model.items.get(a.req.item_id)!;
  const rec = a.options.find((o) => o.recommended);
  return (
    <section className={`verdict verdict-${a.verdict} span-12`}>
      <div className="v-icon" aria-hidden><StatusIcon s={a.verdict} size={20} /></div>
      <div>
        <h3>{a.headline}</h3>
        <p>
          {model.customers.get(a.req.customer_id)?.name}・{it.name}・{fmtInt(a.req.qty)} {it.unit}・交期 {md(a.req.due_date)}（{wd(a.req.due_date)}）
          {rec && <> ｜ 建議：<b>{rec.title}</b></>}
        </p>
      </div>
    </section>
  );
}

function MarginCard({ a }: { a: Assessment }) {
  const m = a.margin;
  return (
    <Card className="span-5" title="這張單賺不賺" subtitle={`售價：${m.priceSource}；成本：本月預估成本（BOM × 最新進價）`}>
      <div className="mini-kpis">
        <div><span>營收</span><b>{fmtMoney(m.revenue)}</b></div>
        <div><span>接單多賺（增量）</span><b className={m.incremental <= 0 ? 'neg' : ''}>{fmtMoney(m.incremental)}</b></div>
        <div><span>全成本毛利率</span><b className={m.gpPct < 0.12 ? 'neg' : ''}>{fmtPct(m.gpPct)}</b></div>
      </div>
      <table className="dt kv">
        <tbody>
          <tr><td>單價</td><td>{fmtPrice(m.price)}</td></tr>
          <tr><td>原料＋包材（變動成本）</td><td>{fmtPrice(m.varCost)}／單位</td></tr>
          <tr><td>貢獻（營收 − 變動成本）</td><td>{fmtMoney(m.contribution)}（{fmtPct(m.contributionPct)}）</td></tr>
          <tr><td>建議方案的額外成本</td><td>{m.extraCost ? `− ${fmtMoney(m.extraCost)}` : '—'}</td></tr>
          <tr className="total"><td>接單多賺</td><td>{fmtMoney(m.incremental)}</td></tr>
          <tr><td className="muted">參考：全成本毛利（含分攤工費 {fmtPrice(m.unitCost - m.varCost)}／單位）</td><td className="muted">{fmtMoney(m.gp)}（{fmtPct(m.gpPct)}）</td></tr>
        </tbody>
      </table>
      <p className="note">插單決策看「增量」：正常工時的人工與製費不管接不接都要付，只有原料、包材和加班等額外支出是因為這張單才多花的。全成本毛利率則用來判斷這個品項、這張合約長期划不划算。</p>
      {m.gpPct < 0.12 && <p className="note">⚠ 全成本毛利率偏低，建議一併檢查合約報價（可到「客戶損益」查看）。</p>}
      {a.options.some((o) => o.id === 'overtime' && o.impact.includes('少賺')) && <p className="note">⚠ 加班費超過這張單的貢獻，所以系統改推薦其他方案。</p>}
    </Card>
  );
}

function MaterialsCard({ a }: { a: Assessment }) {
  const { model, order } = useApp();
  const ev = a.withOT;
  const name = (id: string) => model.items.get(id)?.name ?? id;
  const [sel, setSel] = useState<string | null>(null);
  const focus = sel && ev.materials.some((m) => m.item_id === sel) ? sel : a.bottleneck ?? ev.materials[0]?.item_id;
  const it = focus ? model.items.get(focus) : undefined;

  const series = useMemo(() => {
    if (!order || !focus) return [];
    const extra = new Map<string, number>();
    for (const p of ev.plan) {
      const d = order.prevWork(p.date) < order.asOf ? order.asOf : order.prevWork(p.date);
      extra.set(d, (extra.get(d) ?? 0) + p.qty * (model.leafQty(a.req.item_id)[focus] ?? 0));
    }
    const proj = order.projection(focus, extra);
    // 補齊每天，讓階梯線好讀
    const out: { date: string; base: number; after: number }[] = [];
    let i = 0; let last = proj[0];
    for (let d = order.asOf; d <= addDays(order.asOf, 42); d = addDays(d, 1)) {
      while (i < proj.length && proj[i].date <= d) { last = proj[i]; i++; }
      out.push({ date: d, base: Math.round(last.base), after: Math.round(last.after) });
    }
    return out;
  }, [order, focus, ev, a, model]);

  const desc = (m: Assessment['withOT']['materials'][number]) => {
    if (m.kind === 'short') return `${md(m.firstShortDate)} 開始不夠，缺約 ${fmtInt(m.shortQty)}；下一批 ${md(m.nextReceipt)} 到`;
    if (m.kind === 'rebuy') return `${md(m.firstShortDate ?? m.firstLowDate)} 後會${m.firstShortDate ? '不夠' : '低於安全存量'}；前置 ${model.items.get(m.item_id)?.purchase_lead_days} 天，今天追加採購來得及`;
    if (m.kind === 'safety') return `會低於安全存量 ${fmtInt(m.safety)}`;
    return '夠用';
  };

  return (
    <>
      <Card className="span-7" title="原料與包材檢查" subtitle="可用量 ＝ 目前庫存 ＋ 在途採購 － 已排程的用量；點選列可看供需走勢">
        <DataTable rows={ev.materials} rowKey={(m) => m.item_id} selectedKey={focus ?? null} onRowClick={(m) => setSel(m.item_id)} maxHeight={330}
          columns={[
            { key: 's', header: '狀態', render: (m) => <StatusTag s={m.status} /> },
            { key: 'n', header: '物料', render: (m) => <>{name(m.item_id)}<span className={`tag tag-${model.items.get(m.item_id)?.type}`}>{model.items.get(m.item_id)?.type}</span></> },
            { key: 'q', header: '這張單用量', align: 'right', render: (m) => `${fmtInt(m.need)} ${model.items.get(m.item_id)?.unit}` },
            { key: 'o', header: '目前庫存', align: 'right', render: (m) => fmtInt(m.onHand) },
            { key: 'a', header: '插單後最低結存', align: 'right', render: (m) => <span className={m.minAfter < 0 ? 'neg strong' : ''}>{fmtInt(m.minAfter)}</span> },
            { key: 'd', header: '說明', render: (m) => <span className="wrap">{desc(m)}</span> },
          ]} />
      </Card>
      <Card className="span-5" title={`供需走勢：${it?.name ?? ''}`} subtitle={`未來 6 週的預計結存（${it?.unit ?? ''}）；水平線為安全存量`}>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={COLORS.grid} />
            <XAxis dataKey="date" tickFormatter={md} {...axisProps} interval={6} />
            <YAxis {...axisProps} axisLine={false} width={52} tickFormatter={(v) => fmtInt(v)} />
            <ReferenceLine y={0} stroke={COLORS.axis} />
            {it?.safety_stock ? <ReferenceLine y={it.safety_stock} stroke="#d03b3b" strokeOpacity={0.6} label={{ value: '安全存量', position: 'insideTopRight', fill: COLORS.muted, fontSize: 11 }} /> : null}
            <Tooltip content={<ChartTip fmt={(v) => fmtInt(v)} labelFmt={(l) => `${md(l)}（${wd(l)}）`} />} />
            <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: COLORS.ink2 }} />
            <Line type="stepAfter" dataKey="base" name="目前計畫" stroke={COLORS.s1} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="stepAfter" dataKey="after" name="加入這張單後" stroke={COLORS.s2} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </Card>
    </>
  );
}

function CapacityCard({ a }: { a: Assessment }) {
  const { order, model } = useApp();
  const ev = a.base.capacityOk ? a.base : a.withOT;
  const otPlanShown = !a.base.capacityOk && ev.plan.some((p) => p.overtime);
  const lineIds = [...new Set(ev.plan.map((p) => p.line_id))];
  const caps = order!.data.line_capabilities.filter((c) => c.item_id === a.req.item_id).sort((x, y) => x.priority - y.priority);
  const mainLine = lineIds[0] ?? caps[0]?.line_id;
  const line = order!.lines.find((l) => l.line_id === mainLine);
  const days = useMemo(() => {
    if (!order || !mainLine) return [];
    const out = [];
    for (let d = addDays(ev.earliestProd, -2); d <= addDays(a.req.due_date, 1); d = addDays(d, 1)) {
      const t = order.dayType(d);
      if (t === '休假') continue;
      const L = order.lineLoad(mainLine, d);
      const ins = ev.plan.filter((p) => p.line_id === mainLine && p.date === d);
      const insN = ins.filter((p) => !p.overtime).reduce((s, p) => s + p.hours, 0);
      const insO = ins.filter((p) => p.overtime).reduce((s, p) => s + p.hours, 0);
      if (t === '加班日' && !insO && !L.ot) continue;
      out.push({ date: d, existing: +(L.used + L.ot + L.maint).toFixed(2), insert: +insN.toFixed(2), overtime: +insO.toFixed(2), cap: L.cap, label: `${md(d)}${t === '加班日' ? '六' : ''}` });
    }
    return out;
  }, [order, mainLine, ev, a]);

  return (
    <>
      <Card className="span-7" title={`產能：${line?.name ?? '—'}`} subtitle={`每日工時（小時）；正常工時 ${line?.normal_hours ?? 8} 小時，${line?.line_type === '手工' ? '手工線產能依當天出勤人數計算' : '超過的部分為加班'}。可生產期間：${md(ev.earliestProd)}–${md(ev.latestProd)}${otPlanShown ? '。正常工時已排滿，下圖為「加班方案」的排法' : ''}`}>
        {ev.need === 0 ? <p className="note">成品庫存足夠，不需要生產。</p> : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={days} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} barCategoryGap={3}>
              <CartesianGrid vertical={false} stroke={COLORS.grid} />
              <XAxis dataKey="label" {...axisProps} interval={0} tick={{ fill: COLORS.muted, fontSize: 10 }} />
              <YAxis {...axisProps} axisLine={false} width={32} domain={[0, 12]} />
              <ReferenceLine y={line?.normal_hours ?? 8} stroke={COLORS.ink2} label={{ value: '正常工時', position: 'insideTopLeft', fill: COLORS.muted, fontSize: 11 }} />
              <Tooltip cursor={{ fill: 'rgba(11,11,11,0.04)' }} content={<ChartTip fmt={(v) => `${v.toFixed(1)} 小時`} />} />
              <Legend wrapperStyle={{ fontSize: 12, color: COLORS.ink2 }} />
              <Bar dataKey="existing" name="已排程（含保養）" stackId="h" fill="#c3c2b7" isAnimationActive={false} />
              <Bar dataKey="insert" name="這張單（正常工時）" stackId="h" fill={COLORS.s1} isAnimationActive={false} />
              <Bar dataKey="overtime" name="這張單（加班）" stackId="h" fill={COLORS.s2} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>
      <Card className="span-5" title={otPlanShown ? '生產安排（加班方案）' : '生產安排'} subtitle={ev.need > 0 ? `需生產 ${fmtInt(ev.need)} ${model.items.get(a.req.item_id)?.unit}（成品可承諾 ${fmtInt(ev.atp)}）` : '由成品庫存出貨'}>
        <DataTable rows={ev.plan} rowKey={(p) => `${p.date}-${p.line_id}-${p.overtime}`} maxHeight={250} empty={ev.need ? '交期前排不進去' : '不需生產'}
          columns={[
            { key: 'd', header: '日期', render: (p) => `${md(p.date)}（${wd(p.date)}）` },
            { key: 'l', header: '產線', render: (p) => order!.lines.find((l) => l.line_id === p.line_id)?.name },
            { key: 'q', header: '數量', align: 'right', render: (p) => fmtInt(p.qty) },
            { key: 'h', header: '工時', align: 'right', render: (p) => `${p.hours.toFixed(1)} h` },
            { key: 't', header: '類型', render: (p) => (p.overtime ? <span className="st st-warn">加班・{p.persons} 人</span> : <span className="muted">正常</span>) },
          ]} />
        {ev.remaining > 0 && <p className="note">⚠ 還有 {fmtInt(ev.remaining)} 排不進交期前的產能。</p>}
      </Card>
    </>
  );
}
