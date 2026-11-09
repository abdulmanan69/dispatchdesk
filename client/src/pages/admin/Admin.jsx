import { useSearchParams } from 'react-router';
import { GraduationCap } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { PageHeader, Tabs, Button } from '../../components/ui.jsx';
import Overview from '../../components/admin/Overview.jsx';
import AdminUsers from '../../components/admin/Users.jsx';
import AdminSubscriptions from '../../components/admin/Subscriptions.jsx';
import AdminPlans from '../../components/admin/Plans.jsx';
import Moderation from '../../components/admin/Moderation.jsx';
import SystemSettings from '../../components/admin/SystemSettings.jsx';
import AuditLog from '../../components/admin/AuditLog.jsx';
import AdminSetup from '../../components/admin/Setup.jsx';

const TABS = [
  { value: 'setup', label: 'Setup', perm: 'admin.settings' },
  { value: 'overview', label: 'Overview', perm: 'admin.access' },
  { value: 'users', label: 'Users', perm: 'admin.users' },
  { value: 'subscriptions', label: 'Subscriptions', perm: 'admin.billing' },
  { value: 'plans', label: 'Plans', perm: 'admin.billing' },
  { value: 'moderation', label: 'Moderation', perm: 'admin.moderate' },
  { value: 'settings', label: 'System settings', perm: 'admin.settings' },
  { value: 'audit', label: 'Audit log', perm: 'admin.audit' },
];

export default function Admin() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter((t) => can(t.perm));
  const tab = tabs.some((t) => t.value === params.get('tab')) ? params.get('tab') : (tabs[0]?.value || 'overview');
  const setTab = (v) => setParams({ tab: v });
  return (
    <div className="space-y-5">
      <PageHeader title="Admin" subtitle="Platform users, billing, moderation and configuration"
        actions={can('training.manage') && <Button variant="secondary" icon={GraduationCap} to="/app/admin/training">Training admin</Button>} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'setup' && <AdminSetup onTab={setTab} />}
      {tab === 'overview' && <Overview onTab={setTab} />}
      {tab === 'users' && <AdminUsers />}
      {tab === 'subscriptions' && <AdminSubscriptions />}
      {tab === 'plans' && <AdminPlans />}
      {tab === 'moderation' && <Moderation />}
      {tab === 'settings' && <SystemSettings />}
      {tab === 'audit' && <AuditLog />}
    </div>
  );
}
