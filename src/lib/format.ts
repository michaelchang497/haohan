const nf0 = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtInt = (n: number) => nf0.format(n);
export const fmtMoney = (n: number) => `${n < 0 ? '−' : ''}$${nf0.format(Math.abs(n))}`;
export const fmtPrice = (n: number) => `$${nf2.format(n)}`;
/** 以「萬」為單位 */
export const fmtWan = (n: number) => `${n < 0 ? '−' : ''}${nf1.format(Math.abs(n) / 1e4)} 萬`;
export const fmtPct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
export const fmtSignedPct = (x: number, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`;
export const fmtPt = (x: number, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)} pt`;
export const growth = (cur: number, base: number) => (base ? (cur - base) / Math.abs(base) : null);
export const monthLabel = (m: string) => `${m.slice(2, 4)}/${m.slice(5, 7)}`;
