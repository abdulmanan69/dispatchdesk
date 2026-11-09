import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Gift } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useConfirm } from '../Modal.jsx';
import GrantPlanModal from './GrantPlanModal.jsx';
import { date, label, money } from '../../lib/format.js';
import { Button, Card, Select, DataTable, Pagination, QueryState, Badge, EmptyState, Tabs } from '../ui.jsx';

const COLORS = { active: 'green', trialing: 'blue', past_due: 'amber', incomplete: 'amber', unpaid: 'red', canceled: 'gray' };

export default function AdminSubscriptions() {
  const [view, setView] = useState('subscriptions');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const subs = useQuery({ queryKey: ['admin', 'subs', status, page], queryFn: () => api.get('/api/admin/subscriptions', { status, page, pageSize: 25 }), enabled: view === 'subscriptions' });
  const [granting, setGranting] = useState(false);
  const confirm = useConfirm();
  const revoke = useApiMutation((id) => api.post(`/api/admin/subscriptions/${id}/revoke`), { success: 'Plan revoked', invalidate: [['admin', 'subs']] });
  const pays = useQuery({ queryKey: ['admin', 'payments', page], queryFn: () => api.get('/api/admin/payments', { page, pageSize: 25 }), enabled: view === 'payments' });
  return (
    <Card bodyClass="p-0">
      <div className="flex flex-wrap items-end justify-between gap-2 px-3 pt-1">
        <Tabs value={view} onChange={(v) => { setView(v); setPage(1); }} tabs={[{ value: 'subscriptions', label: 'Subscriptions' }, { value: 'payments', label: 'Payments' }]} className="border-0" />
        {view === 'subscriptions' && <Button size="sm" icon={Gift} className="mb-2 ml-auto" onClick={() => setGranting(true)}>Grant plan</Button>}
        {view === 'subscriptions' && (
          <Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="mb-2 w-40">
            <option value="">All statuses</option>
            {Object.keys(COLORS).map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </Select>
        )}
      </div>
      <div className="border-t border-line">
        {view === 'subscriptions' ? (
          <QueryState query={subs}>
            {(d) => (
              <>
                <DataTable rows={d.items} empty={<EmptyState title="No subscriptions" />} columns={[
                  { key: 'user', header: 'Customer', render: (s) => (<div><p className="font-medium">{s.user.name}</p><p className="text-xs text-muted">{s.user.email}{s.team ? ` · ${s.team}` : ''}</p></div>) },
                  { key: 'plan', header: 'Plan' },
                  { key: 'seats', header: 'Seats', className: 'tabular' },
                  { key: 'status', header: 'Status', render: (s) => <Badge color={COLORS[s.status]}>{label(s.status)}{s.cancelAtPeriodEnd ? ' · ending' : ''}</Badge> },
                  { key: 'currentPeriodEnd', header: 'Period end', render: (s) => date(s.currentPeriodEnd) },
                  { key: 'stripe', header: 'Source', render: (s) => (s.granted
                    ? <span className="flex items-center gap-2"><Badge color="purple">Granted</Badge>{['active', 'trialing'].includes(s.status) && <Button variant="ghost" size="sm" onClick={async () => { if (await confirm({ title: `Revoke ${s.plan} for ${s.user.name}?`, message: 'They move back to Free right away. Their data is kept.', confirmLabel: 'Revoke', danger: true })) revoke.mutate(s.id); }}>Revoke</Button>}</span>
                    : <span className="font-mono text-xs text-muted">{s.stripeSubscriptionId || '—'}</span>) },
                  { key: 'createdAt', header: 'Created', render: (s) => date(s.createdAt) },
                ]} />
                <div className="border-t border-line px-3"><Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} /></div>
              </>
            )}
          </QueryState>
        ) : (
          <QueryState query={pays}>
            {(d) => (
              <>
                <DataTable rows={d.items} empty={<EmptyState title="No payments recorded" />} columns={[
                  { key: 'user', header: 'Customer', render: (p) => (<div><p className="font-medium">{p.user.name}</p><p className="text-xs text-muted">{p.user.email}</p></div>) },
                  { key: 'description', header: 'Description', render: (p) => p.description || '—' },
                  { key: 'amount', header: 'Amount', className: 'text-right tabular', render: (p) => money(p.amountCents, { currency: p.currency.toUpperCase() }) },
                  { key: 'status', header: 'Status', render: (p) => <Badge color={p.status === 'paid' ? 'green' : 'red'}>{label(p.status)}</Badge> },
                  { key: 'paidAt', header: 'Date', render: (p) => date(p.paidAt || p.createdAt) },
                  { key: 'invoice', header: '', render: (p) => (p.invoiceUrl ? <a className="text-sm text-brand-700 hover:underline dark:text-brand-300" href={p.invoiceUrl} target="_blank" rel="noopener noreferrer">Invoice</a> : null) },
                ]} />
                <div className="border-t border-line px-3"><Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} /></div>
              </>
            )}
          </QueryState>
        )}
      </div>
      {granting && <GrantPlanModal onClose={() => setGranting(false)} />}
    </Card>
  );
}
