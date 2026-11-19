import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '../context/AppContext';
import { groupSummary, inRange, isConsolidated, summarize, type Summary } from '../lib/engine';
import { fmtPct, fmtWan, growth, monthLabel } from '../lib/format';
import { Card, ChartTip, COLORS, DataTable, Delta, InlineBar, KpiTile, SeverityTag, axisProps } from '../components/ui';

export default function Overview() {
  const { model, lines, period, filters, alerts, navigate } = useApp();

  const cur = useMemo(() => inRange(lines, period.cur), [lines, period]);
  const s = summarize(cur);
  const yoy = period.yoy ? summarize(inRange(lines, period.yoy)) : null;
  const prev = period.prev ? summarize(inRange(lines, period.prev)) : null;

  const monthly = useMemo(() => {
    const g = groupSummary(lines, (l) => l.month);
    return model.months.map((m) => {
      const x = g.get(m);
      return {
        month: m, revenue: x?.revenue ?? 0, gpPct: x ? x.gpPct * 100 : null,
        inPeriod: m >= period.cur.start.slice(0, 7) && m <= period.cur.end.slice(0, 7),
        estimate: m > model.lastClosedMonth,
      };
    });
  }, [lines, model, period]);

  const byChannel = useMemo(() => {
    const g = groupSummary(cur, (l) => l.channel_id);
    const gy = period.yoy ? groupSummary(inRange(lines, period.yoy), (l) => l.channel_id) : new Map<string, Summary>();
    return model.raw.channels.filter((c) => g.has(c.channel_id)).map((c) => ({ id: c.channel_id, name: c.name, s: g.get(c.channel_id)!, y: gy.get(c.channel_id) }));
  }, [cur, lines, period, model]);
  const maxCh = Math.max(...byChannel.map((x) => x.s.revenue), 1);

  const byCompany = useMemo(() => {
    // 公司別一律用「單一公司視角」，最後一列顯示合併沖銷後
    const all = model.lines.filter((l) => l.date >= period.cur.start && l.date <= period.cur.end && (filters.channel === 'ALL' || l.channel_id === filters.channel));
    const rows = model.raw.companies.map((c) => {
      const ls = all.filter((l) => l.company_id === c.company_id).map((l) => ({ ...l, cost: l.costCompany }));
      return { id: c.company_id, name: c.name, s: summarize(ls) };
    });
    const cons = summarize(all.filter((l) => !l.is_ic).map((l) => ({ ...l, cost: l.costProd })));
    const sum = rows.reduce((a, r) => ({ revenue: a.revenue + r.s.revenue, gp: a.gp + r.s.gp }), { revenue: 0, gp: 0 });
    const elimRev = cons.revenue - sum.revenue, elimGp = cons.gp - sum.gp;
    return [
      ...rows,
      { id: 'ELIM', name: '內部交易沖銷', s: { revenue: elimRev, cost: elimRev - elimGp, gp: elimGp, gpPct: NaN, qty: 0, n: 0 } as Summary },
      { id: 'CONS', name: '集團合併', s: cons },
    ];
  }, [model, period, filters.channel]);

  const scopeLabel = filters.company === 'ALL' ? (isConsolidated(filters) ? '集團合併（已沖銷內部交易）' : '集團加總（未沖銷）') : model.companyName(filters.company);

  return (
    <div className="grid">
      <div className="page-title span-12">
        <h2>損益總覽</h2>
        <p>{period.label} · {scopeLabel}{filters.channel !== 'ALL' && ` · ${model.channelName(filters.channel)}`}</p>
      </div>

      <div className="kpis span-12">
        <KpiTile label="營業收入" value={fmtWan(s.revenue)} deltas={[
          { label: '去年同期', value: yoy ? growth(s.revenue, yoy.revenue) : null },
          ...(prev ? [{ label: period.prevLabel, value: growth(s.revenue, prev.revenue) }] : []),
        ]} />
        <KpiTile label="銷貨成本" value={fmtWan(s.cost)} deltas={[
          { label: '去年同期', value: yoy ? growth(s.cost, yoy.cost) : null, invert: true },
          ...(prev ? [{ label: period.prevLabel, value: growth(s.cost, prev.cost), invert: true }] : []),
        ]} />
        <KpiTile label="毛利" value={fmtWan(s.gp)} deltas={[
          { label: '去年同期', value: yoy ? growth(s.gp, yoy.gp) : null },
          ...(prev ? [{ label: period.prevLabel, value: growth(s.gp, prev.gp) }] : []),
        ]} />
        <KpiTile label="毛利率" value={fmtPct(s.gpPct)} deltas={[
          { label: '去年同期', value: yoy ? s.gpPct - yoy.gpPct : null, kind: 'pt' },
          ...(prev ? [{ label: period.prevLabel, value: s.gpPct - prev.gpPct, kind: 'pt' as const }] : []),
        ]} />
      </div>

      <Card className="span-8" title="每月營業收入" subtitle="深色為目前選取期間；最後一個月為預估成本（未月結）">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={monthly} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={2}>
            <CartesianGrid vertical={false} stroke={COLORS.grid} />
            <XAxis dataKey="month" tickFormatter={monthLabel} {...axisProps} interval={1} />
            <YAxis tickFormatter={(v) => `${Math.round(v / 1e4)}萬`} {...axisProps} axisLine={false} width={52} />
            <Tooltip cursor={{ fill: 'rgba(11,11,11,0.04)' }} content={<ChartTip fmt={(v) => fmtWan(v)} labelFmt={(l, p) => `${l}${p?.estimate ? '（預估）' : ''}`} />} />
            <Bar dataKey="revenue" name="營收" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {monthly.map((m) => <Cell key={m.month} fill={m.inPeriod ? COLORS.s1 : COLORS.s1Light} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <h4 className="mini-title">每月毛利率</h4>
        <ResponsiveContainer width="100%" height={130}>
          <LineChart data={monthly} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={COLORS.grid} />
            <XAxis dataKey="month" tickFormatter={monthLabel} {...axisProps} interval={1} />
            <YAxis domain={['dataMin - 2', 'dataMax + 2']} tickFormatter={(v) => `${Math.round(v)}%`} {...axisProps} axisLine={false} width={52} />
            <Tooltip content={<ChartTip fmt={(v) => `${v.toFixed(1)}%`} />} />
            <Line dataKey="gpPct" name="毛利率" stroke={COLORS.s1} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      <Card className="span-4 alerts-card" title={`警示（${alerts.length}）`} subtitle="依目前公司／通路篩選；點擊查看明細">
        <ul className="alerts">
          {alerts.slice(0, 9).map((a) => (
            <li key={a.id} onClick={() => navigate(a.link)}>
              <div className="alert-top"><SeverityTag s={a.severity} /><span className="alert-kind">{a.kind}</span></div>
              <div className="alert-title">{a.title}</div>
              <div className="alert-detail">{a.detail}</div>
            </li>
          ))}
          {alerts.length > 9 && <li className="more">還有 {alerts.length - 9} 則…</li>}
        </ul>
      </Card>

      <Card className="span-7" title="通路別損益" subtitle={`${period.label}，與去年同期比較`}>
        <DataTable rows={byChannel} rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`#/customers?channel=${r.id}`)}
          initialSort={{ key: 'rev', dir: 'desc' }}
          columns={[
            { key: 'name', header: '通路', render: (r) => r.name },
            { key: 'bar', header: '', width: '22%', render: (r) => <InlineBar value={r.s.revenue} max={maxCh} /> },
            { key: 'rev', header: '營收', align: 'right', sort: (r) => r.s.revenue, render: (r) => fmtWan(r.s.revenue) },
            { key: 'yoy', header: '營收 YoY', align: 'right', sort: (r) => (r.y ? growth(r.s.revenue, r.y.revenue) ?? 0 : 0), render: (r) => <Delta value={r.y ? growth(r.s.revenue, r.y.revenue) : null} /> },
            { key: 'gp', header: '毛利', align: 'right', sort: (r) => r.s.gp, render: (r) => fmtWan(r.s.gp) },
            { key: 'gpp', header: '毛利率', align: 'right', sort: (r) => r.s.gpPct, render: (r) => fmtPct(r.s.gpPct) },
            { key: 'gppd', header: '毛利率變化', align: 'right', render: (r) => <Delta value={r.y ? r.s.gpPct - r.y.gpPct : null} kind="pt" /> },
          ]} />
      </Card>

      <Card className="span-5" title="公司別損益" subtitle="各公司以自身角度計算；示範觀光轉售示範食品產品以轉撥價為成本">
        <DataTable rows={byCompany} rowKey={(r) => r.id}
          columns={[
            { key: 'name', header: '公司', render: (r) => <span className={r.id === 'CONS' ? 'strong' : r.id === 'ELIM' ? 'muted' : ''}>{r.name}</span> },
            { key: 'rev', header: '營收', align: 'right', render: (r) => <span className={r.id === 'CONS' ? 'strong' : ''}>{fmtWan(r.s.revenue)}</span> },
            { key: 'gp', header: '毛利', align: 'right', render: (r) => <span className={r.id === 'CONS' ? 'strong' : ''}>{fmtWan(r.s.gp)}</span> },
            { key: 'gpp', header: '毛利率', align: 'right', render: (r) => (isNaN(r.s.gpPct) ? '—' : fmtPct(r.s.gpPct)) },
          ]} />
        <p className="note">沖銷列 = 示範食品賣給示範觀光的營收，以及示範觀光帳上轉撥價與實際生產成本之間的差額。</p>
      </Card>
    </div>
  );
}
