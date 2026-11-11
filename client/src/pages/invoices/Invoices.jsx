import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus, Download, Receipt, X } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { date, money } from '../../lib/format.js';
import { Button, Card, DataTable, EmptyState, Input, PageHeader, Pagination, QueryState, Select, StatCard, Tabs, cx } from '../../components/ui.jsx';
import { useToast } from '../../components/Toast.jsx';
import InvoiceEditor from '../../components/invoices/InvoiceEditor.jsx';
import { CreateInvoiceModal, StatusBadge } from '../../components/invoices/InvoiceModals.jsx';

const BUCKET_DOT = { '0_30': 'bg-c-green', '31_60': 'bg-c-amber', '61_90': 'bg-c-orange', '90_plus': 'bg-c-red' };
const KIND = { freight: 'Freight', dispatch_fee: 'Dispatch fee' };

/** Invoices and receivables: aging by days since issued, overdue totals, status tabs, CSV export for QuickBooks. */
export default function Invoices() {
  const { user } = useAuth();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const params = Object.fromEntries([...sp.entries()].filter(([k]) => k !== 'open'));
  const filters = { status: 'all', page: 1, scope: 'mine', ...params };
  const setF = (patch) => setSp({ ...filters, page: 1, ...patch }, { replace: true });
  // Links from a broker, carrier or load page narrow the list; say so and offer the full list.
  const narrowed = filters.brokerId ? 'one broker' : filters.carrierId ? 'one carrier' : filters.loadId ? 'one load' : null;
  const showAll = () => {
    const { brokerId, carrierId, loadId, ...rest } = filters;
    setSp({ ...rest, page: 1 }, { replace: true });
  };
  const openId = sp.get('open');
  const setOpen = (id) => {
    const next = new URLSearchParams(sp);
    if (id) next.set('open', id); else next.delete('open');
    setSp(next, { replace: !id });
  };
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const q = useQuery({ queryKey: ['invoices', 'list', filters], queryFn: () => api.get('/api/invoices', { ...filters, pageSize: 25 }) });
  const counts = q.data?.counts || {};
  const aging = q.data?.aging;

  const exportCsv = async () => {
    setExporting(true);
    try {
      await api.download(`/api/invoices/export.csv?status=issued${filters.kind ? `&kind=${filters.kind}` : ''}${filters.scope === 'team' ? '&scope=team' : ''}`, 'invoices.csv');
    } catch (err) {
      toast.error(err);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <PageHeader title="Invoices" subtitle="Freight invoices to brokers, dispatch-fee invoices to carriers, and what is still owed."
        actions={<>
          <Button variant="secondary" icon={Download} loading={exporting} onClick={exportCsv}>Export CSV for QuickBooks</Button>
          <Button icon={Plus} onClick={() => setCreating(true)}>New invoice</Button>
        </>} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open receivables" value={aging ? money(aging.openCents, { digits: 0 }) : '—'} sub={aging ? `${aging.openCount} invoice${aging.openCount === 1 ? '' : 's'} sent, not fully paid` : undefined} color="blue" />
        <StatCard label="Past due" value={aging ? money(aging.overdueCents, { digits: 0 }) : '—'} sub={aging ? `${aging.overdueCount} past the due date` : undefined} color="red" to="/app/invoices?status=overdue" />
        <StatCard label="Collected, last 30 days" value={q.data ? money(q.data.collected30d.cents, { digits: 0 }) : '—'} sub={q.data ? `${q.data.collected30d.count} paid in full` : undefined} color="green" />
        <StatCard label="Drafts" value={counts.draft ?? 0} sub="Not sent yet" color="gray" to="/app/invoices?status=draft" />
      </div>

      {aging && aging.openCount > 0 && (
        <Card className="mb-4" title="Aging (days since issued)" bodyClass="p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {aging.buckets.map((b) => (
              <div key={b.key} className="rounded-lg border border-line px-3 py-2">
                <p className="flex items-center gap-1.5 text-xs text-muted"><span className={cx('size-2 rounded-full', BUCKET_DOT[b.key])} aria-hidden />{b.label}</p>
                <p className="mt-1 text-lg font-medium tabular">{money(b.openCents, { digits: 0 })}</p>
                <p className="text-xs text-muted">{b.count} invoice{b.count === 1 ? '' : 's'}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Tabs className="mb-3" value={filters.status} onChange={(v) => setF({ status: v })} tabs={[
        { value: 'all', label: 'All' },
        { value: 'open', label: 'Open', count: (counts.sent || 0) + (counts.partial || 0) },
        { value: 'overdue', label: 'Past due', count: aging?.overdueCount },
        { value: 'draft', label: 'Drafts', count: counts.draft || 0 },
        { value: 'paid', label: 'Paid', count: counts.paid || 0 },
        { value: 'void', label: 'Void', count: counts.void || 0 },
      ]} />
      <Card bodyClass="p-0" title={
        <div className="flex flex-wrap gap-2 py-1">
          <Input type="search" className="h-8 w-full sm:w-56" placeholder="Search bill-to or invoice #" aria-label="Search invoices" defaultValue={filters.q || ''}
            onKeyDown={(e) => { if (e.key === 'Enter') setF({ q: e.target.value }); }} onBlur={(e) => e.target.value !== (filters.q || '') && setF({ q: e.target.value })} />
          <Select aria-label="Kind" className="h-8 w-44" value={filters.kind || ''} onChange={(e) => setF({ kind: e.target.value })}>
            <option value="">Freight and fees</option><option value="freight">Freight (to brokers)</option><option value="dispatch_fee">Dispatch fees (to carriers)</option>
          </Select>
          {user?.team && (
            <Select aria-label="Scope" className="h-8 w-32" value={filters.scope} onChange={(e) => setF({ scope: e.target.value })}>
              <option value="mine">Mine</option><option value="team">Team</option>
            </Select>
          )}
          {narrowed && (
            <Button size="sm" variant="secondary" icon={X} className="h-8" onClick={showAll}>
              Showing {narrowed} · show all
            </Button>
          )}
        </div>
      }>
        <QueryState query={q}>
          {(data) => (
            <>
              <DataTable rows={data.items} onRowClick={(i) => setOpen(i.id)}
                empty={<EmptyState icon={Receipt} title="No invoices here" action={<Button icon={Plus} onClick={() => setCreating(true)}>New invoice</Button>}>Create an invoice from a delivered load: freight to the broker, or your dispatch fee to the carrier.</EmptyState>}
                mobileRow={(i) => (
                  <div className="space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">#{i.number} · {i.billToName}</span>
                      <span className="shrink-0 text-sm tabular font-medium">{money(i.balanceCents || i.amountCents)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted"><StatusBadge invoice={i} />{KIND[i.kind]} · due {date(i.dueAt)}</div>
                  </div>
                )}
                columns={[
                  { key: 'number', header: '#', render: (i) => <span className="tabular font-medium">{i.number}</span> },
                  { key: 'bill', header: 'Bill to', render: (i) => <div><div className="font-medium">{i.billToName}</div><div className="text-xs text-muted">{KIND[i.kind]}{i.meta?.reference ? ` · ref ${i.meta.reference}` : ''}</div></div> },
                  { key: 'load', header: 'Load', render: (i) => <span className="text-sm">{i.meta?.lane || '—'}</span> },
                  { key: 'issued', header: 'Issued', render: (i) => <span className="whitespace-nowrap text-sm">{i.issuedAt ? date(i.issuedAt) : '—'}</span> },
                  { key: 'due', header: 'Due', render: (i) => <span className={cx('whitespace-nowrap text-sm', i.overdue && 'text-c-red')}>{date(i.dueAt)}</span> },
                  { key: 'amount', header: 'Amount', className: 'text-right', render: (i) => <span className="tabular">{money(i.amountCents)}</span> },
                  { key: 'balance', header: 'Balance', className: 'text-right', render: (i) => <span className="tabular font-medium">{i.status === 'void' ? '—' : money(i.balanceCents)}</span> },
                  { key: 'status', header: 'Status', render: (i) => <StatusBadge invoice={i} /> },
                ]} />
              <div className="border-t border-line px-3"><Pagination page={data.page} pages={data.pages} total={data.total} onPage={(p) => setSp({ ...filters, page: p })} /></div>
            </>
          )}
        </QueryState>
      </Card>

      <p className="mt-3 text-xs text-muted">The CSV uses the QuickBooks Online invoice import layout (one row per line item). Drafts and void invoices are left out.</p>
      {creating && <CreateInvoiceModal onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpen(id); }} />}
      <InvoiceEditor id={openId} onClose={() => setOpen(null)} />
    </div>
  );
}
