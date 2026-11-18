import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { EmptyState, PageHeader } from '../../components/ui.jsx';
import { AdminMenu, AdminMenuSelect, AdminSearch } from '../../components/admin/AdminNav.jsx';
import { currentItem, itemId, visibleMenu } from '../../components/admin/adminPages.js';
import Overview from '../../components/admin/Overview.jsx';
import AdminUsers from '../../components/admin/Users.jsx';
import AdminSubscriptions from '../../components/admin/Subscriptions.jsx';
import AdminPlans from '../../components/admin/Plans.jsx';
import Coupons from '../../components/admin/Coupons.jsx';
import ManualPayments from '../../components/admin/ManualPayments.jsx';
import Moderation from '../../components/admin/Moderation.jsx';
import SystemSettings from '../../components/admin/SystemSettings.jsx';
import AuditLog from '../../components/admin/AuditLog.jsx';
import AdminSetup from '../../components/admin/Setup.jsx';
import AdminSystem from '../../components/admin/System.jsx';

/**
 * Admin: a menu of pages in groups (Home, People, Billing, Settings, System) with a search for any page or setting,
 * and counts of what needs attention. The address keeps the place: ?tab=payments, ?tab=settings&section=billing,
 * and &focus=<setting key> to open a setting from the search.
 */
export default function Admin() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const menu = useMemo(() => visibleMenu(can), [can]);
  const current = currentItem(menu, params.get('tab'), params.get('section'));
  const attention = useQuery({ queryKey: ['admin', 'attention'], queryFn: () => api.get('/api/admin/attention'), refetchInterval: 60_000 });
  const counts = attention.data || {};

  const go = ({ item, settingKey }) => {
    if (item.to) return navigate(item.to);
    setParams({ tab: item.tab, ...(item.section ? { section: item.section } : {}), ...(settingKey ? { focus: settingKey } : {}) });
    if (!settingKey) window.scrollTo?.({ top: 0 });
  };
  const openTab = (tab, section) => setParams({ tab, ...(section ? { section } : {}) });

  if (!current) return <EmptyState title="No admin pages for your role">Ask a platform admin for access.</EmptyState>;
  const page = current.tab;
  return (
    <div>
      <PageHeader title="Admin" subtitle="Run the platform: people, billing, settings and system health" />
      <div className="grid gap-6 lg:grid-cols-[232px_minmax(0,1fr)]">
        <aside className="space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto lg:pb-4">
          <AdminSearch menu={menu} onGo={go} />
          <div className="hidden lg:block"><AdminMenu menu={menu} currentId={itemId(current)} counts={counts} onGo={go} /></div>
          <div className="lg:hidden"><AdminMenuSelect menu={menu} currentId={itemId(current)} counts={counts} onGo={go} /></div>
        </aside>
        <section aria-labelledby="admin-page-title" className="min-w-0 space-y-4">
          <header className="flex items-start gap-3">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-2"><current.icon className="size-[18px]" aria-hidden /></span>
            <div className="min-w-0">
              <h2 id="admin-page-title" className="text-lg font-medium">{current.label}</h2>
              <p className="text-sm text-fg-2">{current.desc}</p>
            </div>
          </header>
          {page === 'overview' && <Overview onTab={openTab} attention={attention.data} />}
          {page === 'setup' && <AdminSetup onTab={openTab} />}
          {page === 'users' && <AdminUsers />}
          {page === 'moderation' && <Moderation />}
          {page === 'payments' && <ManualPayments />}
          {page === 'subscriptions' && <AdminSubscriptions />}
          {page === 'plans' && <AdminPlans />}
          {page === 'codes' && <Coupons />}
          {page === 'settings' && <SystemSettings key={current.section} group={current.section} focus={params.get('focus')} />}
          {page === 'system' && <AdminSystem />}
          {page === 'audit' && <AuditLog />}
        </section>
      </div>
    </div>
  );
}
