import { logout } from './components/Login';
import { useEffect } from 'react';
import { AppProvider, PAGE_GROUPS, PAGES, ROLES, useApp } from './context/AppContext';
import { PERIOD_OPTIONS } from './lib/period';
import Overview from './pages/Overview';
import Customers from './pages/Customers';
import Products from './pages/Products';
import Materials from './pages/Materials';
import Scenarios from './pages/Scenarios';
import ProfitChat from './pages/ProfitChat';
import Capacity from './pages/Capacity';
import RoleFocus from './components/RoleFocus';

function Sidebar() {
  const { route, navigate, roleId, setRoleId, alerts } = useApp();
  const role = ROLES.find((r) => r.id === roleId)!;
  return (
    <aside className="side">
      <div className="brand">
        <div className="brand-mark">示</div>
        <div><b>示範食品</b><span>經營決策平台 · Prototype</span></div>
      </div>
      <nav>
        {PAGE_GROUPS.map((g) => (
          <div key={g.id} className="nav-group">
            <div className="nav-group-name">{g.name}</div>
            {PAGES.filter((p) => p.group === g.id).map((p) => (
              <a key={p.id} href={`#/${p.id}`} className={route.page === p.id ? 'active' : ''}
                onClick={(e) => { e.preventDefault(); navigate(`#/${p.id}`); }}>
                <span className="nav-name">{p.name}{role.pages.includes(p.id) && <em title={`${role.name}常用`}>常用</em>}</span>
                <span className="nav-desc">{p.desc}</span>
                {p.id === 'overview' && alerts.length > 0 && <span className="nav-badge" title="警示數">{alerts.length}</span>}
              </a>
            ))}
          </div>
        ))}
      </nav>
      <div className="role">
        <label htmlFor="role">檢視角色（demo）</label>
        <select id="role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {ROLES.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      <button className="logout" onClick={logout}>登出</button>
    </aside>
  );
}

function FilterBar() {
  const { model, filters, setFilters, periodKey, setPeriodKey, period, route, order } = useApp();
  const meta = model.raw.meta;
  if (route.page === 'analysis') {
    return (
      <div className="filters">
        <span className="filters-title">損益分析</span>
        <span className="range">期間、公司、通路在對話中指定；預設本月、全集團（沖銷內部交易）</span>
        <div className="status" title={meta.source}>
          資料至 {meta.data_through.slice(5).replace('-', '/')} ・ ≤{Number(meta.last_closed_month.slice(5))}月 月結成本 ・ 本月 預估成本
        </div>
      </div>
    );
  }
  if (PAGES.find((p) => p.id === route.page)?.group === 'order') {
    return (
      <div className="filters">
        <span className="filters-title">供需計算引擎</span>
        <span className="range">依目前的庫存、在途採購、生產排程與規則即時計算</span>
        {order && <div className="status" title={order.data.order_meta.source}>
          資料快照 {order.data.order_meta.snapshot_at.slice(5).replace('-', '/')} ・ 涵蓋至 {order.horizon.replace(/-/g, '/')}
        </div>}
      </div>
    );
  }
  return (
    <div className="filters">
      <div className="seg" role="group" aria-label="期間">
        {PERIOD_OPTIONS.map((p) => (
          <button key={p.key} className={periodKey === p.key ? 'on' : ''} onClick={() => setPeriodKey(p.key)}>{p.label}</button>
        ))}
      </div>
      <span className="range">{period.cur.start.replace(/-/g, '/')} – {period.cur.end.replace(/-/g, '/')}</span>
      <select value={filters.company} onChange={(e) => setFilters({ company: e.target.value })} aria-label="公司">
        <option value="ALL">全集團</option>
        {model.raw.companies.map((c) => <option key={c.company_id} value={c.company_id}>{c.name}</option>)}
      </select>
      <select value={filters.channel} onChange={(e) => setFilters({ channel: e.target.value })} aria-label="通路">
        <option value="ALL">全部通路</option>
        {model.raw.channels.map((c) => <option key={c.channel_id} value={c.channel_id}>{c.name}</option>)}
      </select>
      <label className={`chk ${filters.company !== 'ALL' ? 'disabled' : ''}`} title="合併報表時，排除示範食品賣給示範觀光的內部交易，並以生產成本計算">
        <input type="checkbox" checked={filters.eliminate} disabled={filters.company !== 'ALL'}
          onChange={(e) => setFilters({ eliminate: e.target.checked })} />
        沖銷集團內部交易
      </label>
      <div className="status" title={meta.source}>
        資料至 {meta.data_through.slice(5).replace('-', '/')} ・ ≤{Number(meta.last_closed_month.slice(5))}月 月結成本 ・ 本月 預估成本
      </div>
    </div>
  );
}

function Page() {
  const { route, roleId } = useApp();
  useEffect(() => { window.scrollTo(0, 0); }, [route.page]);
  const isHome = ROLES.find((r) => r.id === roleId)?.home === route.page;
  const body = (() => {
    switch (route.page) {
      case 'customers': return <Customers />;
      case 'products': return <Products />;
      case 'materials': return <Materials />;
      case 'scenarios': return <Scenarios />;
      case 'analysis': return <ProfitChat />;
      case 'capacity': return <Capacity />;
      default: return <Overview />;
    }
  })();
  return <>{isHome && <RoleFocus />}{body}</>;
}

export default function App() {
  return (
    <AppProvider>
      <div className="shell">
        <Sidebar />
        <main>
          <FilterBar />
          <div className="page"><Page /></div>
          <footer>模擬資料：客戶、廠商、人名與金額均為虛構，僅供 prototype 展示</footer>
        </main>
      </div>
    </AppProvider>
  );
}
