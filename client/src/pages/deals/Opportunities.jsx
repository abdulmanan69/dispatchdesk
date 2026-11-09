import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus, Handshake } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { label, money, pct, relative } from '../../lib/format.js';
import { Badge, Button, Card, DataTable, EmptyState, Input, PageHeader, Pagination, QueryState, Select, StatCard, Tabs } from '../../components/ui.jsx';
import { NewOpportunityModal, OpportunityModal, OPP_COLOR } from '../../components/deals/OpportunityModal.jsx';

export default function Opportunities() {
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const filters = { status: 'active', sort: 'updated', page: 1, scope: 'mine', ...Object.fromEntries(sp.entries()) };
  const setF = (patch) => setSp({ ...filters, page: 1, ...patch }, { replace: true });
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['opportunities', 'list', filters], queryFn: () => api.get('/api/opportunities', { ...filters, pageSize: 25 }) });
  const s = q.data?.summary;
  const tabs = [
    { value: 'active', label: 'Active', count: s?.openCount },
    { value: 'open', label: 'Open', count: s?.byStatus.open },
    { value: 'negotiating', label: 'Negotiating', count: s?.byStatus.negotiating },
    { value: 'trial', label: 'Trial', count: s?.byStatus.trial },
    { value: 'won', label: 'Won', count: s?.byStatus.won },
    { value: 'lost', label: 'Lost', count: s?.byStatus.lost },
    { value: 'all', label: 'All' },
  ];
  return (
    <div>
      <PageHeader title="Opportunities" subtitle="Carriers you're in talks with — track value, negotiation stage and next steps."
        actions={<Button icon={Plus} onClick={() => setCreating(true)}>New opportunity</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Active opportunities" value={s?.openCount ?? '—'} icon={Handshake} />
        <StatCard label="Pipeline value / mo" value={s ? money(s.openValueCents, { digits: 0 }) : '—'} />
        <StatCard label="Weighted value / mo" value={s ? money(s.weightedValueCents, { digits: 0 }) : '—'} sub="Value × probability" tone="signal" />
        <StatCard label="Win rate" value={s?.winRate != null ? pct(s.winRate) : '—'} sub={s ? `${s.byStatus.won} won · ${s.byStatus.lost} lost` : undefined} tone="green" />
      </div>
      <Tabs className="mb-3" tabs={tabs} value={filters.status} onChange={(v) => setF({ status: v })} />
      <Card bodyClass="p-0" title={
        <div className="flex flex-wrap gap-2">
          <Input type="search" className="h-8 w-56" placeholder="Search carrier, MC, DOT" aria-label="Search opportunities" defaultValue={filters.q || ''}
            onKeyDown={(e) => { if (e.key === 'Enter') setF({ q: e.target.value }); }} onBlur={(e) => e.target.value !== (filters.q || '') && setF({ q: e.target.value })} />
          <Select aria-label="Sort" className="h-8 w-44" value={filters.sort} onChange={(e) => setF({ sort: e.target.value })}>
            <option value="updated">Recently updated</option><option value="value">Highest value</option><option value="followup">Next follow-up</option>
            <option value="probability">Highest probability</option><option value="created">Newest</option>
          </Select>
          {user?.team && (
            <Select aria-label="Scope" className="h-8 w-32" value={filters.scope} onChange={(e) => setF({ scope: e.target.value })}>
              <option value="mine">Mine</option><option value="team">Team</option>
            </Select>
          )}
        </div>
      }>
        <QueryState query={q}>
          {(data) => (
            <>
              <DataTable rows={data.items} onRowClick={(o) => setOpenId(o.id)}
                empty={<EmptyState icon={Handshake} title="No opportunities here" action={<Button icon={Plus} onClick={() => setCreating(true)}>New opportunity</Button>}>Move an interested carrier into Opportunities from its profile, the pipeline, or here.</EmptyState>}
                columns={[
                  { key: 'carrier', header: 'Carrier', render: (o) => <div><div className="font-medium">{o.carrier.companyName}</div><div className="text-xs text-muted">{[o.carrier.mcNumber && `MC ${o.carrier.mcNumber}`, o.carrier.state, o.carrier.fleetSize && `${o.carrier.fleetSize} trucks`].filter(Boolean).join(' · ') || '—'}</div></div> },
                  { key: 'status', header: 'Stage', render: (o) => <Badge color={OPP_COLOR[o.status]}>{label(o.status)}</Badge> },
                  { key: 'value', header: 'Value / mo', className: 'text-right', render: (o) => <span className="tabular">{money(o.estimatedValueCents, { digits: 0 })}</span> },
                  { key: 'prob', header: 'Prob.', className: 'text-right', render: (o) => <span className="tabular">{o.probability}%</span> },
                  { key: 'fee', header: 'Fee', className: 'text-right', render: (o) => <span className="tabular">{o.dispatchFeePercent != null ? `${o.dispatchFeePercent}%` : '—'}</span> },
                  { key: 'next', header: 'Next follow-up', render: (o) => (o.nextFollowUpAt ? <span className={new Date(o.nextFollowUpAt) < new Date() ? 'text-red-600' : ''}>{relative(o.nextFollowUpAt)}</span> : <span className="text-muted">—</span>) },
                  { key: 'owner', header: 'Owner', render: (o) => <span className="text-sm text-muted">{o.carrier.assignedTo?.name || o.owner?.name}</span> },
                  { key: 'updated', header: 'Updated', render: (o) => <span className="text-sm text-muted">{relative(o.updatedAt)}</span> },
                ]} />
              <div className="border-t border-line px-3"><Pagination page={data.page} pages={data.pages} total={data.total} onPage={(p) => setSp({ ...filters, page: p })} /></div>
            </>
          )}
        </QueryState>
      </Card>
      <OpportunityModal id={openId} onClose={() => setOpenId(null)} />
      <NewOpportunityModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
