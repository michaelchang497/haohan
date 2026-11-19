import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '../context/AppContext';
import { addMonths, groupSummary } from '../lib/engine';
import { fmtInt, fmtPct, fmtPrice, fmtWan, growth, monthLabel } from '../lib/format';
import { Card, ChartTip, COLORS, DataTable, Delta, axisProps } from '../components/ui';

const SLOT_COLORS = [COLORS.s1, COLORS.s2, COLORS.s3, '#6250d6'];
const MAX_SEL = 4;

export default function Materials() {
  const { model, lines, route, navigate } = useApp();
  const paramId = route.params.get('id');
  const m = model.currentMonth;
  const base = model.months[0];

  // 選取的原料 → 固定顏色（取消其他項目時，顏色不會跟著變）
  const [slots, setSlots] = useState<Record<string, number>>(() => {
    const init = ['RM05', 'RM06', 'RM02'];
    if (paramId && !init.includes(paramId)) init[2] = paramId;
    return Object.fromEntries(init.map((id, i) => [id, i]));
  });
  const toggle = (id: string) => setSlots((s) => {
    if (id in s) { const n = { ...s }; delete n[id]; return n; }
    if (Object.keys(s).length >= MAX_SEL) return s;
    const used = new Set(Object.values(s));
    const free = [0, 1, 2, 3].find((i) => !used.has(i))!;
    return { ...s, [id]: free };
  });

  // 近 12 個月的銷量（作為年化影響的基礎）
  const l12 = useMemo(() => {
    const from = addMonths(m, -11);
    return groupSummary(lines.filter((l) => l.month >= from), (l) => l.item_id);
  }, [lines, m]);

  const rows = useMemo(() => model.raw.items.filter((i) => i.type === '原料' || i.type === '包材').map((it) => {
    const p0 = model.price(it.item_id, base);
    const p6 = model.price(it.item_id, addMonths(m, -6));
    const pn = model.price(it.item_id, m);
    const users = model.usedBy(it.item_id);
    const annualUse = users.reduce((s, f) => s + (l12.get(f)?.qty ?? 0) * (model.leafQty(f)[it.item_id] ?? 0), 0);
    return { it, p0, p6, pn, users, annualUse, impact: annualUse * (pn - p0) };
  }), [model, l12, base, m]);

  const indexData = useMemo(() => model.months.map((mm) => {
    const o: Record<string, number | string> = { month: mm };
    for (const id of Object.keys(slots)) o[id] = (model.price(id, mm) / model.price(id, base)) * 100;
    return o;
  }), [model, slots, base]);

  const whatIfId = paramId ?? 'RM05';
  const totalImpact = rows.reduce((s, r) => s + r.impact, 0);

  return (
    <div className="grid">
      <div className="page-title span-12">
        <h2>原料成本</h2>
        <p>原料、包材進價走勢，以及對產品成本與毛利的影響</p>
      </div>

      <Card className="span-7" title="進價指數走勢" subtitle={`${base.replace('-', '/')} = 100；從下表勾選，最多 ${MAX_SEL} 項`}>
        <div className="legend">
          {Object.entries(slots).map(([id, i]) => (
            <span key={id}><i style={{ background: SLOT_COLORS[i] }} />{model.items.get(id)?.name}
              <button className="x" onClick={() => toggle(id)} aria-label="移除">✕</button></span>
          ))}
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={indexData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={COLORS.grid} />
            <XAxis dataKey="month" tickFormatter={monthLabel} {...axisProps} interval={1} />
            <YAxis {...axisProps} axisLine={false} width={40} domain={['dataMin - 3', 'dataMax + 3']} tickFormatter={(v) => Math.round(v).toString()} />
            <ReferenceLine y={100} stroke={COLORS.axis} />
            <Tooltip content={<ChartTip fmt={(v) => v.toFixed(1)} />} />
            {Object.entries(slots).map(([id, i]) => (
              <Line key={id} dataKey={id} name={model.items.get(id)?.name} stroke={SLOT_COLORS[i]} strokeWidth={2} dot={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Card>

      <WhatIf id={whatIfId} l12={l12} />

      <Card className="span-12" title="原料與包材清單"
        subtitle={<>年化成本影響 = 近 12 個月用量 ×（目前進價 − {base.replace('-', '/')} 進價）。全部合計：<b>{fmtWan(totalImpact)}</b>／年。點擊列可做漲價模擬。</>}>
        <DataTable rows={rows} rowKey={(r) => r.it.item_id} selectedKey={whatIfId}
          onRowClick={(r) => navigate(`#/materials?id=${r.it.item_id}`)}
          initialSort={{ key: 'imp', dir: 'desc' }} maxHeight={420}
          columns={[
            { key: 'sel', header: '走勢', align: 'center', width: 48, render: (r) => (
              <input type="checkbox" checked={r.it.item_id in slots} aria-label="加入走勢圖"
                disabled={!(r.it.item_id in slots) && Object.keys(slots).length >= MAX_SEL}
                onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.it.item_id)} />) },
            { key: 'n', header: '品名', sort: (r) => r.it.name, render: (r) => r.it.name },
            { key: 't', header: '類型', sort: (r) => r.it.type, render: (r) => <span className={`tag tag-${r.it.type}`}>{r.it.type}</span> },
            { key: 'p0', header: `${base.replace('-', '/')} 進價`, align: 'right', render: (r) => `${fmtPrice(r.p0)}/${r.it.unit}` },
            { key: 'p6', header: '6 個月前', align: 'right', render: (r) => fmtPrice(r.p6) },
            { key: 'pn', header: '目前進價', align: 'right', render: (r) => <b>{fmtPrice(r.pn)}</b> },
            { key: 'g', header: '累計漲幅', align: 'right', sort: (r) => r.pn / r.p0, render: (r) => <Delta value={growth(r.pn, r.p0)} invert /> },
            { key: 'g6', header: '近 6 個月', align: 'right', sort: (r) => r.pn / r.p6, render: (r) => <Delta value={growth(r.pn, r.p6)} invert /> },
            { key: 'u', header: '用於產品數', align: 'right', sort: (r) => r.users.length, render: (r) => r.users.length },
            { key: 'au', header: '近 12 月用量', align: 'right', sort: (r) => r.annualUse, render: (r) => `${fmtInt(r.annualUse)} ${r.it.unit}` },
            { key: 'imp', header: '年化成本影響', align: 'right', sort: (r) => r.impact, render: (r) => fmtWan(r.impact) },
          ]} />
      </Card>
    </div>
  );
}

function WhatIf({ id, l12 }: { id: string; l12: Map<string, { revenue: number; qty: number; gp: number }> }) {
  const { model, navigate } = useApp();
  const [pct, setPct] = useState(10);
  const it = model.items.get(id)!;
  const m = model.currentMonth;
  const price = model.price(id, m);

  const rows = model.usedBy(id).map((f) => {
    const s = l12.get(f);
    const qty = s?.qty ?? 0;
    const avgPrice = s && s.qty ? s.revenue / s.qty : 0;
    const cost = model.unitCost(f, m).total;
    const delta = (model.leafQty(f)[id] ?? 0) * price * (pct / 100);
    const marginNow = avgPrice ? (avgPrice - cost) / avgPrice : 0;
    const marginNew = avgPrice ? (avgPrice - cost - delta) / avgPrice : 0;
    return { f, qty, avgPrice, cost, newCost: cost + delta, marginNow, marginNew, gpImpact: -qty * delta };
  }).filter((r) => r.qty > 0);
  const total = rows.reduce((s, r) => s + r.gpImpact, 0);

  return (
    <Card className="span-5" title={`漲價模擬：${it.name}`} subtitle={`目前進價 ${fmtPrice(price)}/${it.unit}；以近 12 個月銷量與平均售價估算（售價不變）`}>
      <div className="whatif-ctl">
        <input type="range" min={-20} max={50} step={1} value={pct} onChange={(e) => setPct(Number(e.target.value))} aria-label="價格變動百分比" />
        <b>{pct > 0 ? '+' : ''}{pct}%</b>
        <span className="muted">→ {fmtPrice(price * (1 + pct / 100))}/{it.unit}</span>
      </div>
      <div className="whatif-total">
        年毛利影響 <b className={total < 0 ? 'neg' : 'pos'}>{total < 0 ? '−' : '+'}{fmtWan(Math.abs(total))}</b>
        <span className="muted">（{rows.length} 項產品）</span>
      </div>
      <DataTable rows={rows} rowKey={(r) => r.f} initialSort={{ key: 'imp', dir: 'asc' }} maxHeight={210}
        onRowClick={(r) => navigate(`#/products?id=${r.f}`)}
        empty="近 12 個月沒有使用此原料的產品銷售"
        columns={[
          { key: 'n', header: '產品', render: (r) => model.items.get(r.f)?.name },
          { key: 'c', header: '單位成本', align: 'right', render: (r) => <>{fmtPrice(r.cost)} → {fmtPrice(r.newCost)}</> },
          { key: 'm', header: '毛利率', align: 'right', sort: (r) => r.marginNew, render: (r) => <>{fmtPct(r.marginNow)} → <b>{fmtPct(r.marginNew)}</b></> },
          { key: 'imp', header: '年毛利影響', align: 'right', sort: (r) => r.gpImpact, render: (r) => fmtWan(r.gpImpact) },
        ]} />
    </Card>
  );
}
