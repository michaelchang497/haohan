import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { loadRawData } from '../data/loader';
import { buildModel, viewLines, type Filters, type Model, type ViewLine } from '../lib/engine';
import { periodInfo, type PeriodInfo, type PeriodKey } from '../lib/period';
import { buildAlerts, type Alert } from '../lib/alerts';
import { loadOrderData } from '../order/types';
import { buildOrderModel, type OrderModel } from '../order/engine';

export type PageId = 'overview' | 'customers' | 'products' | 'materials' | 'analysis' | 'scenarios' | 'capacity';

export const PAGE_GROUPS = [
  { id: 'pnl', name: '損益戰情' },
  { id: 'order', name: '供需計算引擎' },
] as const;

export const PAGES: { id: PageId; name: string; desc: string; group: 'pnl' | 'order' }[] = [
  { id: 'overview', name: '損益總覽', desc: '整體營收、毛利與警示', group: 'pnl' },
  { id: 'customers', name: '客戶損益', desc: '客戶貢獻與報價檢查', group: 'pnl' },
  { id: 'products', name: '產品損益', desc: '產品毛利與成本結構', group: 'pnl' },
  { id: 'materials', name: '原料成本', desc: '原料價格與影響模擬', group: 'pnl' },
  { id: 'analysis', name: '損益分析', desc: '對話追問：原因、調價試算', group: 'pnl' },
  { id: 'capacity', name: '供需總覽', desc: '產線負荷、物料供需現況', group: 'order' },
  { id: 'scenarios', name: '決策支援', desc: '插單、排程人力、採購、旺季備貨', group: 'order' },
];

// 角色只決定「預設首頁」與「常用頁面」標示；正式權限之後再設計
export const ROLES: { id: string; name: string; home: PageId; pages: PageId[] }[] = [
  { id: 'boss', name: '老闆／總經理', home: 'overview', pages: ['overview', 'customers', 'products', 'analysis'] },
  { id: 'finance', name: '財務', home: 'overview', pages: ['overview', 'products', 'analysis'] },
  { id: 'sales', name: '業務（林志明）', home: 'customers', pages: ['customers', 'products', 'scenarios'] },
  { id: 'purchase', name: '採購', home: 'materials', pages: ['materials', 'capacity', 'scenarios'] },
  { id: 'production', name: '生管', home: 'products', pages: ['products', 'materials', 'scenarios', 'capacity'] },
  { id: 'rd', name: '研發', home: 'products', pages: ['products', 'materials'] },
];

interface Route { page: PageId; params: URLSearchParams }
function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  const [p, q] = h.split('?');
  const params = new URLSearchParams(q ?? '');
  if (p === 'insert') { params.set('tab', 'insert'); return { page: 'scenarios', params }; } // 舊網址
  const page = (PAGES.find((x) => x.id === p)?.id ?? 'overview') as PageId;
  return { page, params };
}

interface Ctx {
  model: Model;
  filters: Filters;
  setFilters: (f: Partial<Filters>) => void;
  periodKey: PeriodKey;
  setPeriodKey: (k: PeriodKey) => void;
  period: PeriodInfo;
  lines: ViewLine[];
  alerts: Alert[];
  route: Route;
  navigate: (hash: string) => void;
  roleId: string;
  setRoleId: (id: string) => void;
  order: OrderModel | null;
  orderError: string | null;
}

const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => {
  const c = useContext(AppCtx);
  if (!c) throw new Error('useApp outside provider');
  return c;
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [model, setModel] = useState<Model | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setF] = useState<Filters>({ company: 'ALL', channel: 'ALL', eliminate: true });
  const [periodKey, setPeriodKey] = useState<PeriodKey>('ytd');
  const [route, setRoute] = useState<Route>(parseHash);
  const [roleId, setRole] = useState('boss');
  const [orderRaw, setOrderRaw] = useState<Awaited<ReturnType<typeof loadOrderData>> | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);

  useEffect(() => {
    loadRawData().then((raw) => setModel(buildModel(raw))).catch((e) => setError(String(e)));
    loadOrderData().then(setOrderRaw).catch((e) => setOrderError(String(e)));
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const lines = useMemo(() => (model ? viewLines(model, filters) : []), [model, filters]);
  const order = useMemo(() => (model && orderRaw ? buildOrderModel(model, orderRaw) : null), [model, orderRaw]);
  const alerts = useMemo(() => (model ? buildAlerts(model, lines) : []), [model, lines]);
  const period = useMemo(
    () => (model ? periodInfo(periodKey, model.raw.meta.data_through, `${model.months[0]}-01`) : null),
    [model, periodKey],
  );

  if (error) return <div className="loading">資料載入失敗：{error}<br />請先執行 <code>npm run mock</code> 產生模擬資料。</div>;
  if (!model || !period) return <div className="loading">載入資料中…</div>;

  const navigate = (hash: string) => { window.location.hash = hash; };
  const value: Ctx = {
    model, filters, setFilters: (f) => setF((p) => ({ ...p, ...f })), periodKey, setPeriodKey, period, lines, alerts,
    route, navigate, roleId, order, orderError,
    setRoleId: (id) => { setRole(id); const r = ROLES.find((x) => x.id === id); if (r) navigate(`#/${r.home}`); },
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
