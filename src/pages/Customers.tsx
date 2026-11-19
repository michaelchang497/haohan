import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '../context/AppContext';
import { contractRows } from '../lib/alerts';
import { groupSummary, inRange, summarize, type Summary } from '../lib/engine';
import { fmtInt, fmtPct, fmtPrice, fmtWan, growth, monthLabel } from '../lib/format';
import { Card, ChartTip, COLORS, DataTable, Delta, InlineBar, SeverityTag, axisProps } from '../components/ui';

export default function Customers() {
  const { model, lines, period, route, navigate } = useApp();
  const selected = route.params.get('id');
  const chParam = route.params.get('channel');
  const [showAllContracts, setShowAll] = useState(false);

  const contracts = useMemo(() => contractRows(model), [model]);
  const shownContracts = showAllContracts ? contracts : contracts.filter((c) => c.severity);

  const cur = useMemo(() => inRange(lines, period.cur), [lines, period]);
  const rows = useMemo(() => {
    const g = groupSummary(cur, (l) => l.customer_id);
    const gy = period.yoy ? groupSummary(inRange(lines, period.yoy), (l) => l.customer_id) : new Map<string, Summary>();
    return [...g].map(([id, s]) => ({ c: model.customers.get(id)!, s, y: gy.get(id) }))
      .filter((r) => !chParam || r.c.channel_id === chParam);
  }, [cur, lines, period, model, chParam]);
  const maxRev = Math.max(...rows.map((r) => r.s.revenue), 1);

  return (
    <div className="grid">
      <div className="page-title span-12">
        <h2>客戶損益</h2>
        <p>{period.label} · 客戶貢獻、毛利與合約報價檢查</p>
      </div>

      <Card className="span-12" title="ODM／B2B 合約報價檢查"
        subtitle={`以本月預估成本（BOM × 最新進價）重算目前毛利率；低於 12% 標示注意、低於 5% 標示嚴重`}
        actions={<label className="chk"><input type="checkbox" checked={showAllContracts} onChange={(e) => setShowAll(e.target.checked)} />顯示全部合約（{contracts.length}）</label>}>
        <DataTable rows={shownContracts} rowKey={(r) => `${r.customer_id}-${r.item_id}`}
          onRowClick={(r) => navigate(`#/customers?id=${r.customer_id}`)}
          empty="目前沒有毛利率低於門檻的合約"
          columns={[
            { key: 'sev', header: '狀態', render: (r) => (r.severity ? <SeverityTag s={r.severity} /> : <span className="muted">正常</span>) },
            { key: 'cust', header: '客戶', render: (r) => model.customers.get(r.customer_id)?.name },
            { key: 'item', header: '品項', render: (r) => <a href={`#/products?id=${r.item_id}`} onClick={(e) => e.stopPropagation()}>{model.items.get(r.item_id)?.name}</a> },
            { key: 'date', header: '報價月份', render: (r) => r.quoted_on.slice(0, 7) },
            { key: 'price', header: '合約單價', align: 'right', render: (r) => fmtPrice(r.price) },
            { key: 'qc', header: '報價時成本', align: 'right', render: (r) => fmtPrice(r.cost_at_quote) },
            { key: 'cc', header: '目前成本', align: 'right', render: (r) => fmtPrice(r.currentCost) },
            { key: 'cg', header: '成本變化', align: 'right', render: (r) => <Delta value={growth(r.currentCost, r.cost_at_quote)} invert /> },
            { key: 'qm', header: '報價時毛利率', align: 'right', render: (r) => fmtPct(r.quoteMargin) },
            { key: 'cm', header: '目前毛利率', align: 'right', render: (r) => <b>{fmtPct(r.currentMargin)}</b> },
          ]} />
      </Card>

      <Card className={selected ? 'span-6' : 'span-12'} title="客戶排行"
        subtitle={chParam ? <>通路：{model.channelName(chParam)} · <a href="#/customers">清除</a></> : '點擊客戶查看明細；欄位可排序'}>
        <DataTable rows={rows} rowKey={(r) => r.c.customer_id} selectedKey={selected}
          onRowClick={(r) => navigate(`#/customers?id=${r.c.customer_id}${chParam ? `&channel=${chParam}` : ''}`)}
          initialSort={{ key: 'rev', dir: 'desc' }} maxHeight={560}
          columns={[
            { key: 'name', header: '客戶', sort: (r) => r.c.name, render: (r) => r.c.name },
            ...(selected ? [] : [
              { key: 'ch', header: '通路', sort: (r: typeof rows[number]) => r.c.channel_id, render: (r: typeof rows[number]) => model.channelName(r.c.channel_id) },
              { key: 'rep', header: '業務', render: (r: typeof rows[number]) => model.repName(r.c.rep_id) },
              { key: 'bar', header: '', width: '14%', render: (r: typeof rows[number]) => <InlineBar value={r.s.revenue} max={maxRev} /> },
            ]),
            { key: 'rev', header: '營收', align: 'right', sort: (r) => r.s.revenue, render: (r) => fmtWan(r.s.revenue) },
            { key: 'yoy', header: 'YoY', align: 'right', sort: (r) => (r.y ? growth(r.s.revenue, r.y.revenue) ?? 0 : -9), render: (r) => <Delta value={r.y ? growth(r.s.revenue, r.y.revenue) : null} /> },
            { key: 'gp', header: '毛利', align: 'right', sort: (r) => r.s.gp, render: (r) => fmtWan(r.s.gp) },
            { key: 'gpp', header: '毛利率', align: 'right', sort: (r) => r.s.gpPct, render: (r) => fmtPct(r.s.gpPct) },
            { key: 'gppd', header: '毛利率變化', align: 'right', sort: (r) => (r.y ? r.s.gpPct - r.y.gpPct : -9), render: (r) => <Delta value={r.y ? r.s.gpPct - r.y.gpPct : null} kind="pt" /> },
          ]} />
      </Card>

      {selected && <CustomerDetail id={selected} onClose={() => navigate(`#/customers${chParam ? `?channel=${chParam}` : ''}`)} />}
    </div>
  );
}

function CustomerDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { model, lines, period, navigate } = useApp();
  const c = model.customers.get(id);
  const mine = useMemo(() => lines.filter((l) => l.customer_id === id), [lines, id]);
  const cur = inRange(mine, period.cur);
  const s = summarize(cur);
  const monthly = useMemo(() => {
    const g = groupSummary(mine, (l) => l.month);
    return model.months.map((m) => ({ month: m, revenue: g.get(m)?.revenue ?? 0, gp: g.get(m)?.gp ?? 0 }));
  }, [mine, model]);
  const byItem = useMemo(() => [...groupSummary(cur, (l) => l.item_id)].map(([iid, s]) => ({ iid, s })), [cur]);
  if (!c) return null;
  if (mine.length === 0) {
    return <Card className="span-6" title={c.name} actions={<button className="ghost" onClick={onClose}>關閉 ✕</button>}><p className="note">目前的公司／通路篩選下沒有這個客戶的交易。</p></Card>;
  }
  return (
    <Card className="span-6" title={c.name}
      subtitle={`${model.channelName(c.channel_id)} · ${model.companyName(c.company_id)} · 業務 ${model.repName(c.rep_id)} · ${c.region}`}
      actions={<button className="ghost" onClick={onClose}>關閉 ✕</button>}>
      <div className="mini-kpis">
        <div><span>營收</span><b>{fmtWan(s.revenue)}</b></div>
        <div><span>毛利</span><b>{fmtWan(s.gp)}</b></div>
        <div><span>毛利率</span><b>{fmtPct(s.gpPct)}</b></div>
      </div>
      <h4 className="mini-title">每月毛利</h4>
      <ResponsiveContainer width="100%" height={170}>
        <BarChart data={monthly} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke={COLORS.grid} />
          <XAxis dataKey="month" tickFormatter={monthLabel} {...axisProps} interval={2} />
          <YAxis tickFormatter={(v) => `${Math.round(v / 1e4)}萬`} {...axisProps} axisLine={false} width={48} />
          <Tooltip cursor={{ fill: 'rgba(11,11,11,0.04)' }} content={<ChartTip fmt={(v) => fmtWan(v)} />} />
          <Bar dataKey="gp" name="毛利" fill={COLORS.s1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
      <h4 className="mini-title">品項明細（{period.label}）</h4>
      <DataTable rows={byItem} rowKey={(r) => r.iid} initialSort={{ key: 'rev', dir: 'desc' }}
        onRowClick={(r) => navigate(`#/products?id=${r.iid}`)}
        columns={[
          { key: 'n', header: '品項', render: (r) => model.items.get(r.iid)?.name },
          { key: 'q', header: '數量', align: 'right', sort: (r) => r.s.qty, render: (r) => fmtInt(r.s.qty) },
          { key: 'p', header: '平均單價', align: 'right', render: (r) => fmtPrice(r.s.revenue / (r.s.qty || 1)) },
          { key: 'rev', header: '營收', align: 'right', sort: (r) => r.s.revenue, render: (r) => fmtWan(r.s.revenue) },
          { key: 'gpp', header: '毛利率', align: 'right', sort: (r) => r.s.gpPct, render: (r) => fmtPct(r.s.gpPct) },
        ]} />
    </Card>
  );
}
