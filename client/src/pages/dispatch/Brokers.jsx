import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus, Building2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { dollars, money, phoneFmt, relative, US_STATES } from '../../lib/format.js';
import { Button, Card, DataTable, EmptyState, Input, PageHeader, Pagination, QueryState, Select } from '../../components/ui.jsx';
import BrokerFormModal from '../../components/dispatch/BrokerForm.jsx';

export default function Brokers() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const filters = { page: 1, sort: 'name', scope: 'mine', ...Object.fromEntries(sp.entries()) };
  const setF = (patch) => setSp({ ...filters, page: 1, ...patch }, { replace: true });
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['brokers', 'list', filters], queryFn: () => api.get('/api/brokers', { ...filters, pageSize: 25 }) });
  return (
    <div>
      <PageHeader title="Brokers" subtitle="Brokers you book freight with, their payment terms and history."
        actions={<Button icon={Plus} onClick={() => setCreating(true)}>Add broker</Button>} />
      <Card bodyClass="p-0" title={
        <div className="flex flex-wrap gap-2">
          <Input type="search" className="h-8 w-60" placeholder="Search name, contact, MC, email" aria-label="Search brokers" defaultValue={filters.q || ''}
            onKeyDown={(e) => { if (e.key === 'Enter') setF({ q: e.target.value }); }} onBlur={(e) => e.target.value !== (filters.q || '') && setF({ q: e.target.value })} />
          <Select aria-label="State" className="h-8 w-28" value={filters.state || ''} onChange={(e) => setF({ state: e.target.value })}>
            <option value="">All states</option>{US_STATES.map((s) => <option key={s}>{s}</option>)}
          </Select>
          <Select aria-label="Sort" className="h-8 w-36" value={filters.sort} onChange={(e) => setF({ sort: e.target.value })}>
            <option value="name">Name A–Z</option><option value="created">Recently added</option><option value="updated">Recently updated</option>
          </Select>
          {user?.team && (
            <Select aria-label="Scope" className="h-8 w-32" value={filters.scope} onChange={(e) => setF({ scope: e.target.value })}>
              <option value="mine">My brokers</option><option value="team">Team</option>
            </Select>
          )}
        </div>
      }>
        <QueryState query={q}>
          {(data) => (
            <>
              <DataTable rows={data.items} onRowClick={(b) => navigate(`/app/brokers/${b.id}`)}
                empty={<EmptyState icon={Building2} title="No brokers yet" action={<Button icon={Plus} onClick={() => setCreating(true)}>Add broker</Button>}>Keep broker contacts, MC numbers and payment terms in one place.</EmptyState>}
                columns={[
                  { key: 'name', header: 'Broker', render: (b) => <div><div className="font-medium">{b.companyName}</div><div className="text-xs text-muted">{[b.mcNumber && `MC ${b.mcNumber}`, b.city && b.state ? `${b.city}, ${b.state}` : b.state].filter(Boolean).join(' · ') || '—'}</div></div> },
                  { key: 'contact', header: 'Contact', render: (b) => <div className="text-sm"><div>{b.contactName || '—'}</div><div className="text-xs text-muted">{b.phone ? phoneFmt(b.phone) : b.email || ''}</div></div> },
                  { key: 'terms', header: 'Terms', render: (b) => <span className="text-sm">{b.paymentTerms || '—'}{b.daysToPay != null ? <span className="text-xs text-muted"> · {b.daysToPay}d</span> : null}</span> },
                  { key: 'loads', header: 'Loads', className: 'text-right', render: (b) => <span className="tabular">{b.stats.loads}</span> },
                  { key: 'rev', header: 'Revenue', className: 'text-right', render: (b) => <span className="tabular">{money(b.stats.revenueCents, { digits: 0 })}</span> },
                  { key: 'rpm', header: 'Avg RPM', className: 'text-right', render: (b) => <span className="tabular">{b.stats.avgRatePerMile != null ? dollars(b.stats.avgRatePerMile) : '—'}</span> },
                  { key: 'last', header: 'Last load', render: (b) => <span className="text-sm text-muted">{b.stats.lastLoadAt ? relative(b.stats.lastLoadAt) : '—'}</span> },
                ]} />
              <div className="border-t border-line px-3"><Pagination page={data.page} pages={data.pages} total={data.total} onPage={(p) => setSp({ ...filters, page: p })} /></div>
            </>
          )}
        </QueryState>
      </Card>
      <BrokerFormModal open={creating} onClose={() => setCreating(false)} onSaved={(b) => navigate(`/app/brokers/${b.id}`)} />
    </div>
  );
}
