import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, Cell, Legend } from 'recharts';
import { useApp } from '../context/AppContext';
import { groupSummary, inRange, type Model } from '../lib/engine';
import { fmtInt, fmtPct, fmtPrice, fmtWan, monthLabel } from '../lib/format';
import { Card, ChartTip, COLORS, CostBar, CostLegend, DataTable, axisProps } from '../components/ui';

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

export default function Products() {
  const { model, lines, period, route, navigate } = useApp();
  const selected = route.params.get('id');
  const cur = useMemo(() => inRange(lines, period.cur), [lines, period]);
  const rows = useMemo(() => [...groupSummary(cur, (l) => l.item_id)].map(([iid, s]) => {
    const it = model.items.get(iid)!;
    return { it, s, cost: model.unitCost(iid, model.currentMonth) };
  }), [cur, model]);

  const medRev = median(rows.map((r) => r.s.revenue));
  const medGp = median(rows.map((r) => r.s.gpPct));
  const pts = rows.map((r) => ({ id: r.it.item_id, name: r.it.name, x: r.s.revenue / 1e4, y: r.s.gpPct * 100 }));

  return (
    <div className="grid">
      <div className="page-title span-12">
        <h2>產品損益</h2>
        <p>{period.label} · 每個產品的營收、毛利與成本結構</p>
      </div>

      <Card className="span-5" title="產品定位：營收 × 毛利率" subtitle="虛線分隔以中位數為準；點擊圓點查看產品">
        <div className="quad-wrap">
          <ResponsiveContainer width="100%" height={330}>
            <ScatterChart margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid stroke={COLORS.grid} />
              <XAxis type="number" dataKey="x" name="營收" unit="萬" {...axisProps} tickFormatter={(v) => fmtInt(v)} />
              <YAxis type="number" dataKey="y" name="毛利率" unit="%" {...axisProps} width={44} domain={['dataMin - 3', 'dataMax + 3']} tickFormatter={(v) => Math.round(v).toString()} />
              <ReferenceLine x={medRev / 1e4} stroke={COLORS.axis} />
              <ReferenceLine y={medGp * 100} stroke={COLORS.axis} />
              <Tooltip cursor={false} content={({ active, payload }) => active && payload?.length ? (
                <div className="tip"><div className="tip-title">{payload[0].payload.name}</div>
                  <div className="tip-row"><span>營收</span><b>{fmtInt(payload[0].payload.x)} 萬</b></div>
                  <div className="tip-row"><span>毛利率</span><b>{payload[0].payload.y.toFixed(1)}%</b></div></div>) : null} />
              <Scatter data={pts} isAnimationActive={false} onClick={(p: { id?: string; payload?: { id: string } }) => navigate(`#/products?id=${p.payload?.id ?? p.id}`)}>
                {pts.map((p) => <Cell key={p.id} fill={p.id === selected ? COLORS.s2 : COLORS.s1} stroke="#fcfcfb" strokeWidth={2} r={p.id === selected ? 8 : 6} cursor="pointer" />)}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
          <span className="quad q1">明星：高營收、高毛利</span>
          <span className="quad q2">潛力：毛利高、量小</span>
          <span className="quad q3">檢討：量小、毛利低</span>
          <span className="quad q4">走量：營收大、毛利低</span>
        </div>
      </Card>

      <Card className="span-7" title="產品排行" subtitle={<>單位成本為本月預估成本；<CostLegend /></>}>
        <DataTable rows={rows} rowKey={(r) => r.it.item_id} selectedKey={selected}
          onRowClick={(r) => navigate(`#/products?id=${r.it.item_id}`)}
          initialSort={{ key: 'rev', dir: 'desc' }} maxHeight={330}
          columns={[
            { key: 'n', header: '產品', sort: (r) => r.it.name, render: (r) => r.it.name },
            { key: 'cat', header: '分類', sort: (r) => r.it.category, render: (r) => <span className="muted">{r.it.category}</span> },
            { key: 'q', header: '數量', align: 'right', sort: (r) => r.s.qty, render: (r) => `${fmtInt(r.s.qty)} ${r.it.unit}` },
            { key: 'rev', header: '營收', align: 'right', sort: (r) => r.s.revenue, render: (r) => fmtWan(r.s.revenue) },
            { key: 'gpp', header: '毛利率', align: 'right', sort: (r) => r.s.gpPct, render: (r) => fmtPct(r.s.gpPct) },
            { key: 'uc', header: '單位成本', align: 'right', sort: (r) => r.cost.total, render: (r) => fmtPrice(r.cost.total) },
            { key: 'cb', header: '成本結構', width: 110, render: (r) => <CostBar {...r.cost} /> },
          ]} />
      </Card>

      {selected && model.items.get(selected) && <ProductDetail id={selected} />}
    </div>
  );
}

function ProductDetail({ id }: { id: string }) {
  const { model, lines, navigate } = useApp();
  const it = model.items.get(id)!;
  const m = model.currentMonth;

  const trend = useMemo(() => {
    const g = groupSummary(lines.filter((l) => l.item_id === id && l.qty > 0), (l) => l.month);
    return model.months.map((mm) => {
      const s = g.get(mm);
      return {
        month: mm,
        price: s ? s.revenue / s.qty : null,
        est: model.unitCost(id, mm).total,
        actual: model.actualUnitCost(id, mm) ?? null,
      };
    });
  }, [lines, id, model]);

  return (
    <>
      <Card className="span-7" title={`${it.name}｜配方成本展開（BOM）`}
        subtitle={`本月預估：每 1 ${it.unit}，用量含損耗率 × 最新進價；點擊原料查看價格走勢`}
        actions={<button className="ghost" onClick={() => navigate('#/products')}>關閉 ✕</button>}>
        <BomTree model={model} id={id} month={m} />
      </Card>
      <Card className="span-5" title="單位成本與售價走勢" subtitle="已月結月份另列實際成本；與預估的差距代表損耗或 BOM 用量偏差">
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={trend} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={COLORS.grid} />
            <XAxis dataKey="month" tickFormatter={monthLabel} {...axisProps} interval={2} />
            <YAxis {...axisProps} axisLine={false} width={48} tickFormatter={(v) => `$${Math.round(v)}`} domain={[0, 'auto']} />
            <Tooltip content={<ChartTip fmt={(v) => fmtPrice(v)} />} />
            <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: COLORS.ink2 }} />
            <Line dataKey="price" name="平均售價" stroke={COLORS.s1} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
            <Line dataKey="est" name="預估成本" stroke={COLORS.s2} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="actual" name="月結實際成本" stroke={COLORS.s3} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </Card>
    </>
  );
}

function BomTree({ model, id, month }: { model: Model; id: string; month: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const total = model.unitCost(id, month);
  const rows: JSX.Element[] = [];
  const walk = (pid: string, mult: number, depth: number, path: string) => {
    for (const b of model.bomOf(pid)) {
      const it = model.items.get(b.component_id)!;
      const key = `${path}/${b.component_id}`;
      const q = b.qty * mult;
      const qWithLoss = q * (1 + b.loss_rate);
      const unit = model.unitCost(b.component_id, month);
      const cost = qWithLoss * unit.total;
      const hasKids = model.bomOf(b.component_id).length > 0;
      const isOpen = open[key] ?? depth === 0;
      const leaf = it.type === '原料' || it.type === '包材';
      rows.push(
        <tr key={key} className={leaf ? 'clickable' : ''} onClick={leaf ? () => { window.location.hash = `#/materials?id=${it.item_id}`; } : undefined}>
          <td style={{ paddingLeft: 10 + depth * 20 }}>
            {hasKids ? <button className="twisty" onClick={(e) => { e.stopPropagation(); setOpen((o) => ({ ...o, [key]: !isOpen })); }}>{isOpen ? '▾' : '▸'}</button> : <span className="twisty-sp" />}
            {it.name} <span className={`tag tag-${it.type}`}>{it.type}</span>
          </td>
          <td style={{ textAlign: 'right' }}>{q < 0.1 ? q.toFixed(4) : q.toFixed(3)} {b.unit}</td>
          <td style={{ textAlign: 'right' }}>{(b.loss_rate * 100).toFixed(0)}%</td>
          <td style={{ textAlign: 'right' }}>{fmtPrice(unit.total)}</td>
          <td style={{ textAlign: 'right' }}><b>{fmtPrice(cost)}</b></td>
          <td style={{ textAlign: 'right' }}>{((cost / total.total) * 100).toFixed(1)}%</td>
        </tr>,
      );
      if (hasKids && isOpen) walk(b.component_id, qWithLoss, depth + 1, key);
    }
  };
  walk(id, 1, 0, id);
  const labor = model.items.get(id)!.std_labor_overhead;
  return (
    <div className="table-wrap" style={{ maxHeight: 360 }}>
      <table className="dt bom">
        <thead><tr><th>元件</th><th style={{ textAlign: 'right' }}>用量</th><th style={{ textAlign: 'right' }}>損耗率</th><th style={{ textAlign: 'right' }}>單價／單位成本</th><th style={{ textAlign: 'right' }}>成本</th><th style={{ textAlign: 'right' }}>占比</th></tr></thead>
        <tbody>
          {rows}
          <tr><td style={{ paddingLeft: 10 }}><span className="twisty-sp" />本階工費（人工＋製費）</td><td /><td /><td /><td style={{ textAlign: 'right' }}><b>{fmtPrice(labor)}</b></td><td style={{ textAlign: 'right' }}>{((labor / total.total) * 100).toFixed(1)}%</td></tr>
          <tr className="total"><td>合計單位成本</td><td colSpan={3} className="muted" style={{ textAlign: 'right' }}>原料 {fmtPrice(total.material)}・包材 {fmtPrice(total.packaging)}・工費 {fmtPrice(total.labor)}</td><td style={{ textAlign: 'right' }}>{fmtPrice(total.total)}</td><td style={{ textAlign: 'right' }}>100%</td></tr>
        </tbody>
      </table>
    </div>
  );
}
