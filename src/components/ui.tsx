import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Severity } from '../lib/alerts';

export const COLORS = {
  s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a',
  s1Light: '#9ec5f4',
  grid: '#e1e0d9', axis: '#c3c2b7', muted: '#898781', ink2: '#52514e',
};
export const COST_COLORS = { material: COLORS.s1, packaging: COLORS.s2, labor: COLORS.s3 };

export function Card({ title, subtitle, actions, children, className = '' }: {
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {subtitle && <div className="sub">{subtitle}</div>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** 變化量：帶正負號與箭頭，顏色只是輔助 */
export function Delta({ value, kind = 'pct', invert = false }: { value: number | null; kind?: 'pct' | 'pt'; invert?: boolean }) {
  if (value === null || !isFinite(value)) return <span className="delta na">—</span>;
  const good = invert ? value < 0 : value > 0;
  const flat = Math.abs(value) < 0.0005;
  const cls = flat ? 'flat' : good ? 'up' : 'down';
  const arrow = flat ? '' : value > 0 ? '▲' : '▼';
  const txt = kind === 'pt' ? `${Math.abs(value * 100).toFixed(1)} pt` : `${Math.abs(value * 100).toFixed(1)}%`;
  return <span className={`delta ${cls}`}>{arrow} {txt}</span>;
}

export function KpiTile({ label, value, foot, deltas }: {
  label: string; value: string; foot?: ReactNode;
  deltas: { label: string; value: number | null; kind?: 'pct' | 'pt'; invert?: boolean }[];
}) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-deltas">
        {deltas.map((d) => (
          <div key={d.label}><span className="kpi-dl">{d.label}</span><Delta value={d.value} kind={d.kind} invert={d.invert} /></div>
        ))}
      </div>
      {foot && <div className="kpi-foot">{foot}</div>}
    </div>
  );
}

const SEV: Record<Severity, { label: string }> = { critical: { label: '嚴重' }, serious: { label: '注意' }, warning: { label: '提醒' } };
export function SeverityTag({ s }: { s: Severity }) {
  return (
    <span className={`sev sev-${s}`}>
      {s === 'warning' ? <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden><circle cx="4" cy="4" r="3.2" fill="currentColor" /></svg>
        : <StatusIcon s={s === 'critical' ? 'fail' : 'warn'} size={11} />}
      {SEV[s].label}
    </span>
  );
}

export function InlineBar({ value, max, color = COLORS.s1 }: { value: number; max: number; color?: string }) {
  const w = max > 0 ? Math.max(0, (value / max) * 100) : 0;
  return <div className="ibar"><div style={{ width: `${w}%`, background: color }} /></div>;
}

export function CostBar({ material, packaging, labor }: { material: number; packaging: number; labor: number }) {
  const t = material + packaging + labor || 1;
  const segs = [
    ['原料', material, COST_COLORS.material], ['包材', packaging, COST_COLORS.packaging], ['工費', labor, COST_COLORS.labor],
  ] as const;
  return (
    <div className="costbar" title={segs.map(([n, v]) => `${n} ${((v / t) * 100).toFixed(0)}%`).join('、')}>
      {segs.map(([n, v, c]) => <div key={n} style={{ width: `${(v / t) * 100}%`, background: c }} />)}
    </div>
  );
}

export function CostLegend() {
  return (
    <div className="legend">
      <span><i style={{ background: COST_COLORS.material }} />原料</span>
      <span><i style={{ background: COST_COLORS.packaging }} />包材</span>
      <span><i style={{ background: COST_COLORS.labor }} />工費（人工＋製費）</span>
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  sort?: (row: T) => number | string;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
}

export function DataTable<T>({ rows, columns, rowKey, onRowClick, selectedKey, initialSort, maxHeight, empty = '沒有資料' }: {
  rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string; onRowClick?: (r: T) => void; selectedKey?: string | null;
  initialSort?: { key: string; dir: 'asc' | 'desc' }; maxHeight?: number; empty?: string;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const f = col.sort;
    return [...rows].sort((a, b) => {
      const x = f(a), y = f(b);
      const r = x < y ? -1 : x > y ? 1 : 0;
      return sort.dir === 'asc' ? r : -r;
    });
  }, [rows, columns, sort]);
  return (
    <div className="table-wrap" style={maxHeight ? { maxHeight } : undefined}>
      <table className="dt">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{ textAlign: c.align ?? 'left', width: c.width }}
                className={c.sort ? 'sortable' : ''}
                onClick={() => c.sort && setSort((s) => ({ key: c.key, dir: s?.key === c.key && s.dir === 'desc' ? 'asc' : 'desc' }))}>
                {c.header}{sort?.key === c.key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && <tr><td colSpan={columns.length} className="empty">{empty}</td></tr>}
          {sorted.map((r) => {
            const k = rowKey(r);
            return (
              <tr key={k} onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={`${onRowClick ? 'clickable' : ''} ${selectedKey === k ? 'selected' : ''}`}>
                {columns.map((c) => <td key={c.key} style={{ textAlign: c.align ?? 'left' }}>{c.render(r)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Recharts 自訂 tooltip */
export function ChartTip({ active, payload, label, fmt, labelFmt }: {
  active?: boolean; payload?: { name: string; value: number; color?: string; stroke?: string; fill?: string; payload?: Record<string, unknown> }[];
  label?: string; fmt: (v: number, name: string) => string; labelFmt?: (l: string, p?: Record<string, unknown>) => ReactNode;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tip">
      <div className="tip-title">{labelFmt ? labelFmt(String(label), payload[0].payload) : label}</div>
      {payload.map((p) => (
        <div key={p.name} className="tip-row">
          <i style={{ background: p.stroke && p.stroke !== 'none' ? p.stroke : p.fill ?? p.color }} />
          <span>{p.name}</span><b>{fmt(p.value, p.name)}</b>
        </div>
      ))}
    </div>
  );
}

export const axisProps = {
  tick: { fill: COLORS.muted, fontSize: 11 },
  axisLine: { stroke: COLORS.axis },
  tickLine: false,
} as const;

// 狀態圖示用 SVG 畫，避免 ⚠ 等符號在不同系統被換成彩色 emoji、無法置中
export function StatusIcon({ s, size = 14 }: { s: 'ok' | 'warn' | 'fail'; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      {s === 'ok' && <path d="M3.5 8.5l3 3 6-7" />}
      {s === 'fail' && <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />}
      {s === 'warn' && <><path d="M8 3.5v6" /><circle cx="8" cy="12.6" r="0.6" fill="currentColor" strokeWidth="1.4" /></>}
    </svg>
  );
}

// 彈窗：點背景或按 Esc 關閉
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h3>{title}</h3><button className="modal-x" onClick={onClose} aria-label="關閉">×</button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// 提示框：滑鼠移上去立即顯示（用 fixed 定位，不會被捲動區域裁掉）
export function Tip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const show = (e: React.MouseEvent | React.FocusEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const below = r.top < 120;
    setPos({ x: Math.min(Math.max(r.left + r.width / 2, 150), window.innerWidth - 150), y: below ? r.bottom + 8 : r.top - 8, below });
  };
  return (
    <span className="hover-tip" tabIndex={0} onMouseEnter={show} onMouseLeave={() => setPos(null)} onFocus={show} onBlur={() => setPos(null)}>
      {children}
      {pos && <span role="tooltip" className={`tip-box ${pos.below ? 'below' : ''}`} style={{ left: pos.x, top: pos.y }}>{content}</span>}
    </span>
  );
}
