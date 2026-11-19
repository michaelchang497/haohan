// 期間選擇：本月、上月、本季、今年、近 12 個月、去年
export type PeriodKey = 'mtd' | 'lastMonth' | 'qtd' | 'ytd' | 'l12m' | 'lastYear';
export interface Range { start: string; end: string }
export interface PeriodInfo { key: PeriodKey; label: string; cur: Range; prev: Range | null; prevLabel: string; yoy: Range | null }

export const PERIOD_OPTIONS: { key: PeriodKey; label: string }[] = [
  { key: 'mtd', label: '本月' },
  { key: 'lastMonth', label: '上月' },
  { key: 'qtd', label: '本季' },
  { key: 'ytd', label: '今年' },
  { key: 'l12m', label: '近 12 個月' },
  { key: 'lastYear', label: '去年' },
];

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function shift(date: string, months: number) {
  let [y, m, d] = date.split('-').map(Number);
  m += months;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return `${y}-${pad(m)}-${pad(Math.min(d, lastDay(y, m)))}`;
}
const shiftRange = (r: Range, months: number, endIsMonthEnd = false): Range => {
  const end = shift(r.end, months);
  if (!endIsMonthEnd) return { start: shift(r.start, months), end };
  const [y, m] = end.split('-').map(Number);
  return { start: shift(r.start, months), end: `${y}-${pad(m)}-${pad(lastDay(y, m))}` };
};

export function periodInfo(key: PeriodKey, through: string, minDate: string): PeriodInfo {
  const [y, m] = through.split('-').map(Number);
  const label = PERIOD_OPTIONS.find((p) => p.key === key)!.label;
  let cur: Range; let prevMonths: number; let prevLabel: string; let fullMonths = false;
  switch (key) {
    case 'mtd': cur = { start: `${y}-${pad(m)}-01`, end: through }; prevMonths = 1; prevLabel = '上月同期'; break;
    case 'lastMonth': {
      const s = shift(`${y}-${pad(m)}-01`, -1); const [yy, mm] = s.split('-').map(Number);
      cur = { start: s, end: `${yy}-${pad(mm)}-${pad(lastDay(yy, mm))}` }; prevMonths = 1; prevLabel = '前一月'; fullMonths = true; break;
    }
    case 'qtd': { const qm = Math.floor((m - 1) / 3) * 3 + 1; cur = { start: `${y}-${pad(qm)}-01`, end: through }; prevMonths = 3; prevLabel = '上季同期'; break; }
    case 'ytd': cur = { start: `${y}-01-01`, end: through }; prevMonths = 0; prevLabel = ''; break;
    case 'l12m': cur = { start: shift(`${y}-${pad(m)}-01`, -11), end: through }; prevMonths = 12; prevLabel = '前 12 個月'; break;
    case 'lastYear': cur = { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` }; prevMonths = 0; prevLabel = ''; break;
  }
  const valid = (r: Range | null) => (r && r.start >= minDate ? r : null);
  const prev = prevMonths ? valid(shiftRange(cur, -prevMonths, fullMonths)) : null;
  const yoy = valid(shiftRange(cur, -12, fullMonths));
  return { key, label, cur, prev, prevLabel, yoy };
}
