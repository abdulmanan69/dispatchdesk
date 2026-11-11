import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { date, dollars, label, money, phoneFmt } from '../../lib/format.js';
import { Badge, Button, Card, DataTable, EmptyState, Input, PageHeader, Pagination, QueryState, Select, Tabs } from '../../components/ui.jsx';

export const CUSTOMER_COLOR = { active: 'green', paused: 'amber', churned: 'gray' };

/** FMCSA watchlist status from the nightly check (never a guess: "Not checked" until a check ran). */
export function FmcsaBadge({ fmcsa }) {
  if (!fmcsa) return <Badge color="gray">Not checked</Badge>;
  if (fmcsa.found === false) return <Badge color="amber">Not in census</Badge>;
  const bad = fmcsa.usdotStatus === 'inactive' || fmcsa.authority === 'inactive' || fmcsa.allowedToOperate === false || fmcsa.insuranceOnFile === false;
  const recent = fmcsa.lastChange && Date.now() - new Date(fmcsa.lastChange.at).getTime() < 14 * 86400000;
  if (bad) return <Badge color="red">{fmcsa.insuranceOnFile === false ? 'No insurance on file' : 'Inactive'}</Badge>;
  if (recent) return <Badge color="amber" className="whitespace-nowrap">Changed {date(fmcsa.lastChange.at, { month: 'short', day: 'numeric' })}</Badge>;
  return <Badge color="green">{fmcsa.authority === 'active' ? 'Authority active' : 'USDOT active'}</Badge>;
}

function Paperwork({ c }) {
  return c.compliance.missing || c.compliance.expiring
    ? <span className="inline-flex items-center gap-1 text-xs text-c-amber"><AlertTriangle className="size-3.5" aria-hidden />{[c.compliance.missing && `${c.compliance.missing} missing`, c.compliance.expiring && `${c.compliance.expiring} expiring`].filter(Boolean).join(', ')}</span>
    : <Badge color="green">Complete</Badge>;
}

export default function Customers() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const filters = { status: 'all', sort: 'signed', page: 1, scope: 'mine', ...Object.fromEntries(sp.entries()) };
  const setF = (patch) => setSp({ ...filters, page: 1, ...patch }, { replace: true });
  const q = useQuery({ queryKey: ['customers', 'list', filters], queryFn: () => api.get('/api/customers', { ...filters, pageSize: 25 }) });
  const s = q.data?.summary || {};
  const total = Object.values(s).reduce((a, b) => a + b, 0);
  return (
    <div>
      <PageHeader title="Customers" subtitle="Signed carriers: paperwork, rules, statements, FMCSA status and load history."
        actions={<Button variant="secondary" to="/app/opportunities">View opportunities</Button>} />
      <Tabs className="mb-3" value={filters.status} onChange={(v) => setF({ status: v })}
        tabs={[{ value: 'all', label: 'All', count: total }, { value: 'active', label: 'Active', count: s.active ?? 0 }, { value: 'paused', label: 'Paused', count: s.paused ?? 0 }, { value: 'churned', label: 'Churned', count: s.churned ?? 0 }]} />
      <Card bodyClass="p-0" title={
        <div className="flex flex-wrap gap-2 py-1">
          <Input type="search" className="h-8 w-full sm:w-56" placeholder="Search name, MC, DOT, phone" aria-label="Search customers" defaultValue={filters.q || ''}
            onKeyDown={(e) => { if (e.key === 'Enter') setF({ q: e.target.value }); }} onBlur={(e) => e.target.value !== (filters.q || '') && setF({ q: e.target.value })} />
          <Select aria-label="Sort" className="h-8 w-40" value={filters.sort} onChange={(e) => setF({ sort: e.target.value })}>
            <option value="signed">Recently signed</option><option value="name">Name A–Z</option><option value="updated">Recently updated</option>
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
              <p className="border-b border-line px-4 py-2 text-xs text-muted">Fees earned count delivered, invoiced and paid loads only. Booked loads and saved quotes are not included.</p>
              <DataTable rows={data.items} onRowClick={(c) => navigate(`/app/customers/${c.id}`)}
                empty={<EmptyState icon={BadgeCheck} title="No customers yet">Convert a won opportunity, or move a carrier to the Customers stage in the pipeline.</EmptyState>}
                mobileRow={(c) => (
                  <div className="space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">{c.carrier.companyName}</span>
                      <Badge color={CUSTOMER_COLOR[c.status]}>{label(c.status)}</Badge>
                    </div>
                    <p className="text-xs text-muted">{[c.carrier.mcNumber && `MC ${c.carrier.mcNumber}`, `${c.revenue.loads} hauled`, `fees ${money(c.revenue.dispatchFeeCents, { digits: 0 })}`].filter(Boolean).join(' · ')}</p>
                    <div className="flex flex-wrap items-center gap-2"><FmcsaBadge fmcsa={c.fmcsa} /><Paperwork c={c} /></div>
                  </div>
                )}
                columns={[
                  { key: 'carrier', header: 'Carrier', render: (c) => <div><div className="font-medium">{c.carrier.companyName}</div><div className="text-xs text-muted">{[c.carrier.mcNumber && `MC ${c.carrier.mcNumber}`, c.carrier.city && c.carrier.state ? `${c.carrier.city}, ${c.carrier.state}` : c.carrier.state, c.carrier.equipment && label(c.carrier.equipment.split(',')[0])].filter(Boolean).join(' · ')}</div></div> },
                  { key: 'phone', header: 'Phone', render: (c) => (c.carrier.phone ? <a href={`tel:${c.carrier.phone}`} onClick={(e) => e.stopPropagation()} className="whitespace-nowrap hover:underline">{phoneFmt(c.carrier.phone)}</a> : '—') },
                  { key: 'status', header: 'Status', render: (c) => <Badge color={CUSTOMER_COLOR[c.status]}>{label(c.status)}</Badge> },
                  { key: 'fmcsa', header: 'FMCSA', render: (c) => <FmcsaBadge fmcsa={c.fmcsa} /> },
                  { key: 'docs', header: 'Paperwork', render: (c) => <Paperwork c={c} /> },
                  { key: 'fee', header: 'Fee', className: 'text-right', render: (c) => <span className="tabular">{c.dispatchFeePercent != null ? `${c.dispatchFeePercent}%` : '—'}</span> },
                  { key: 'loads', header: 'Hauled', className: 'text-right', render: (c) => <span className="tabular">{c.revenue.loads}{c.revenue.booked?.loads ? <span className="text-xs text-muted"> +{c.revenue.booked.loads} booked</span> : null}</span> },
                  { key: 'gross', header: 'Gross', className: 'text-right', render: (c) => <span className="tabular">{money(c.revenue.grossCents, { digits: 0 })}</span> },
                  { key: 'earned', header: 'Fees earned', className: 'text-right', render: (c) => <span className="tabular font-medium">{money(c.revenue.dispatchFeeCents, { digits: 0 })}</span> },
                  { key: 'rpm', header: 'Avg RPM', className: 'text-right', render: (c) => <span className="tabular">{c.revenue.avgRatePerMile != null ? dollars(c.revenue.avgRatePerMile) : '—'}</span> },
                  { key: 'signed', header: 'Signed', render: (c) => <span className="whitespace-nowrap text-sm text-muted">{date(c.signedAt)}</span> },
                ]} />
              <div className="border-t border-line px-3"><Pagination page={data.page} pages={data.pages} total={data.total} onPage={(p) => setSp({ ...filters, page: p })} /></div>
            </>
          )}
        </QueryState>
      </Card>
    </div>
  );
}
