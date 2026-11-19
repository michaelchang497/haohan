import { useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import { addDays } from '../order/engine';
import { fmtInt } from '../lib/format';
import { Card, DataTable } from '../components/ui';
import { StatusTag } from './OrderInsert';

const md = (d: string | null) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '—');
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const wd = (d: string) => WEEK[new Date(d + 'T00:00:00Z').getUTCDay()];

// 負荷率 → 單一色相（藍）的深淺；文字一律顯示百分比，顏色只是輔助
const RAMP = ['#f4f3ef', '#cde2fb', '#9ec5f4', '#6da7ec', '#2a78d6', '#1c5cab'];
const rampOf = (p: number) => RAMP[p <= 0 ? 0 : p < 0.5 ? 1 : p < 0.75 ? 2 : p < 0.9 ? 3 : p <= 1.0001 ? 4 : 5];

export default function Capacity() {
  const { order, orderError, model } = useApp();
  const [weeks, setWeeks] = useState(4);
  const days = useMemo(() => {
    if (!order) return [];
    const out: string[] = [];
    for (let d = order.asOf; out.length < weeks * 5; d = addDays(d, 1)) if (order.isWork(d)) out.push(d);
    return out;
  }, [order, weeks]);
  const mats = useMemo(() => (order ? order.materialOverview() : []), [order]);

  if (orderError) return <div className="loading">插單資料載入失敗：{orderError}</div>;
  if (!order) return <div className="loading">載入中…</div>;

  const f = order.data.freezer;
  const freezerPct = f.current_used_pallets / f.capacity_pallets;
  const rank = { fail: 0, warn: 1, ok: 2 } as const;
  const sortedMats = [...mats].sort((a, b) => rank[a.status] - rank[b.status] || a.min / (a.safety || 1) - b.min / (b.safety || 1));
  const lineAvg = (lineId: string) => {
    const xs = days.map((d) => order.lineLoad(lineId, d)).filter((x) => x.cap > 0);
    return xs.reduce((s, x) => s + x.used, 0) / (xs.reduce((s, x) => s + x.cap, 0) || 1);
  };

  return (
    <div className="grid">
      <div className="page-title span-12">
        <h2>供需總覽</h2>
        <p>供需計算引擎的基準線：目前排程下，各產線的負荷與原料、包材的供需狀況（快照 {order.data.order_meta.snapshot_at}）。各情境都是在這個基準上做推算</p>
      </div>

      <div className="kpis span-12">
        <div className="kpi"><div className="kpi-label">未來 {weeks} 週最忙的產線</div>
          <div className="kpi-value">{(() => { const b = [...order.lines].sort((x, y) => lineAvg(y.line_id) - lineAvg(x.line_id))[0]; return `${b.name}`; })()}</div>
          <div className="kpi-deltas"><span className="kpi-dl">平均負荷 {Math.round(Math.max(...order.lines.map((l) => lineAvg(l.line_id))) * 100)}%</span></div></div>
        <div className="kpi"><div className="kpi-label">物料：交期內會缺</div><div className="kpi-value">{mats.filter((m) => m.status === 'fail').length} 項</div>
          <div className="kpi-deltas"><span className="kpi-dl">依目前排程，未來 8 週</span></div></div>
        <div className="kpi"><div className="kpi-label">物料：低於安全存量</div><div className="kpi-value">{mats.filter((m) => m.status === 'warn').length} 項</div>
          <div className="kpi-deltas"><span className="kpi-dl">插單時要特別注意</span></div></div>
        <div className="kpi"><div className="kpi-label">冷凍庫</div><div className="kpi-value">{Math.round(freezerPct * 100)}%</div>
          <div className="kpi-deltas"><span className="kpi-dl">{f.current_used_pallets}／{f.capacity_pallets} 板，安全水位 {Math.round(f.safe_level_ratio * 100)}%</span></div></div>
      </div>

      <Card className="span-12" title="產線負荷（正常工時）"
        subtitle="每格為當天已排工時 ÷ 正常工時；手工線另標示出勤人數。顏色越深越滿，超過 100% 代表已排加班"
        actions={<div className="seg">{[2, 4, 6].map((w) => <button key={w} className={weeks === w ? 'on' : ''} onClick={() => setWeeks(w)}>{w} 週</button>)}</div>}>
        <div className="table-wrap">
          <table className="heat">
            <thead>
              <tr><th className="sticky">產線</th>{days.map((d) => <th key={d} className={wd(d) === '一' ? 'wk' : ''}>{md(d)}<br /><span>{wd(d)}</span></th>)}<th>平均</th></tr>
            </thead>
            <tbody>
              {order.lines.map((l) => (
                <tr key={l.line_id}>
                  <th className="sticky">{l.name}<span className="muted">{l.line_type}</span></th>
                  {days.map((d) => {
                    const x = order.lineLoad(l.line_id, d);
                    const p = x.cap ? (x.used + x.ot) / x.cap : 0;
                    const dark = p >= 0.9;
                    return (
                      <td key={d} className={wd(d) === '一' ? 'wk' : ''} style={{ background: x.maint && !x.cap ? '#fdeee6' : rampOf(p), color: dark ? '#fff' : undefined }}
                        title={`${l.name} ${md(d)}：已排 ${(x.used + x.ot).toFixed(1)}／${x.cap} 小時${x.maint ? `（保養 ${x.maint} 小時）` : ''}${l.line_type === '手工' ? `，出勤 ${x.persons} 人` : ''}`}>
                        {x.maint && !x.cap ? '保養' : `${Math.round(p * 100)}`}
                        {l.line_type === '手工' && x.persons < l.std_headcount && <small>{x.persons}人</small>}
                      </td>
                    );
                  })}
                  <td className="avg">{Math.round(lineAvg(l.line_id) * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="legend heat-legend">
          {['0', '<50%', '50–75%', '75–90%', '90–100%', '>100%'].map((t, i) => <span key={t}><i style={{ background: RAMP[i], border: '1px solid rgba(11,11,11,.08)' }} />{t}</span>)}
          <span><i style={{ background: '#fdeee6' }} />設備保養</span>
        </div>
      </Card>

      <Card className="span-12" title="原料與包材供需" subtitle="依目前排程推算（庫存 ＋ 在途 － 排程用量）；最低結存為未來 8 週內最低的一天">
        <DataTable rows={sortedMats} rowKey={(m) => m.item.item_id} maxHeight={420}
          columns={[
            { key: 's', header: '狀態', render: (m) => <StatusTag s={m.status} label={m.status === 'fail' ? '會缺' : m.status === 'warn' ? '低於安全' : '正常'} /> },
            { key: 'n', header: '物料', sort: (m) => m.item.name, render: (m) => <>{m.item.name}<span className={`tag tag-${m.item.type}`}>{m.item.type}</span></> },
            { key: 'o', header: '目前庫存', align: 'right', sort: (m) => m.onHand, render: (m) => `${fmtInt(m.onHand)} ${m.item.unit}` },
            { key: 'd', header: '未來 4 週用量', align: 'right', sort: (m) => m.demand4w, render: (m) => fmtInt(m.demand4w) },
            { key: 'min', header: '最低結存', align: 'right', sort: (m) => m.min, render: (m) => <span className={m.min < 0 ? 'neg strong' : ''}>{fmtInt(m.min)}</span> },
            { key: 'md', header: '發生日', align: 'right', render: (m) => md(m.minDate) },
            { key: 'ss', header: '安全存量', align: 'right', render: (m) => fmtInt(m.safety) },
            { key: 'nx', header: '下一批到貨', align: 'right', render: (m) => md(m.next) },
            { key: 'lt', header: '前置天數', align: 'right', render: (m) => `${m.item.purchase_lead_days ?? '—'} 天` },
          ]} />
      </Card>

      <Card className="span-12" title="資料來源對照" subtitle="對應「資料確認清單／插單判斷_資料來源確認清單.xlsx」的編號；目前皆為模擬資料">
        <DataTable rows={order.data.sources} rowKey={(s) => s.code + s.file}
          columns={[
            { key: 'c', header: '編號', render: (s) => <b>{s.code}</b> },
            { key: 'n', header: '資料項目', render: (s) => s.name },
            { key: 't', header: '預期來源', render: (s) => <span className={`src src-${s.source_type === 'ERP' ? 'erp' : s.source_type === '新建' ? 'new' : 'other'}`}>{s.source_type}</span> },
            { key: 'e', header: 'ERP 參考表名', render: (s) => s.erp_ref ?? '—' },
            { key: 'f', header: 'Demo 資料檔', render: (s) => <code>{s.file}</code> },
          ]} />
        <p className="note">模擬資料共 {fmtInt(Object.values(order.data.order_meta.row_counts).reduce((s, x) => s + x, 0))} 筆；品項主檔 {model.raw.items.length} 筆。</p>
      </Card>
    </div>
  );
}
