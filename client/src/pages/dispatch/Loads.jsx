import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus, Calculator, Pencil, Trash2, Package, Paperclip } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { date, dollars, label, money, num, relative, US_STATES } from '../../lib/format.js';
import { Badge, Button, Card, DataTable, EmptyState, IconButton, Input, PageHeader, Pagination, QueryState, Select, StatCard, Tabs } from '../../components/ui.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import DocumentsPanel from '../../components/documents/DocumentsPanel.jsx';
import LoadFormModal from '../../components/dispatch/LoadForm.jsx';
import { LOAD_STATUSES, LOAD_STATUS_COLOR } from '../../components/dispatch/calc.js';

export function LoadStatusSelect({ load }) {
  const update = useApiMutation((status) => api.patch(`/api/loads/${load.id}`, { status }), { success: (d) => `Load marked ${label(d.load.status)}`, invalidate: [['loads'], ['broker'], ['customer']] });
  return (
    <Select aria-label="Load status" value={load.status} disabled={update.isPending} onClick={(e) => e.stopPropagation()} onChange={(e) => update.mutate(e.target.value)}
      className="h-7 w-32 text-xs">
      {LOAD_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
    </Select>
  );
}

export function loadColumns({ onEdit, onDelete, onDocs, showBroker = true, showCarrier = true, editableStatus = true }) {
  return [
    {
      key: 'lane', header: 'Lane',
      render: (l) => (
        <div className="min-w-44">
          <div className="font-medium">{l.originCity}, {l.originState} → {l.destCity}, {l.destState}</div>
          <div className="text-xs text-muted">{[l.referenceNumber && `#${l.referenceNumber}`, l.equipment && label(l.equipment), l.commodity].filter(Boolean).join(' · ') || '—'}</div>
        </div>
      ),
    },
    { key: 'pickup', header: 'Pickup', render: (l) => <span className="whitespace-nowrap text-sm">{l.pickupDate ? date(l.pickupDate, { month: 'short', day: 'numeric' }) : '—'}</span> },
    showBroker && { key: 'broker', header: 'Broker', render: (l) => (l.broker ? <Link to={`/app/brokers/${l.broker.id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>{l.broker.companyName}</Link> : <span className="text-muted">—</span>) },
    showCarrier && { key: 'carrier', header: 'Carrier', render: (l) => (l.carrier ? <Link to={`/app/carriers/${l.carrier.id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>{l.carrier.companyName}</Link> : <span className="text-muted">—</span>) },
    { key: 'rate', header: 'Rate', className: 'text-right', render: (l) => <span className="tabular font-medium">{money(l.rateCents, { digits: 0 })}</span> },
    { key: 'miles', header: 'Miles', className: 'text-right', render: (l) => <span className="tabular">{num(l.loadedMiles)}{l.deadheadMiles ? <span className="text-xs text-muted"> +{l.deadheadMiles} DH</span> : null}</span> },
    { key: 'rpm', header: 'RPM', className: 'text-right', render: (l) => <span className="tabular font-medium">{l.calc?.ratePerMile != null ? dollars(l.calc.ratePerMile) : '—'}</span> },
    { key: 'status', header: 'Status', render: (l) => (editableStatus ? <LoadStatusSelect load={l} /> : <Badge color={LOAD_STATUS_COLOR[l.status]}>{label(l.status)}</Badge>) },
    (onEdit || onDelete || onDocs) && {
      key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right',
      render: (l) => (
        <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
          {onDocs && <IconButton icon={Paperclip} label="Documents" onClick={() => onDocs(l)} />}
          {onEdit && <IconButton icon={Pencil} label="Edit load" onClick={() => onEdit(l)} />}
          {onDelete && <IconButton icon={Trash2} label="Delete load" onClick={() => onDelete(l)} className="hover:text-red-600" />}
        </div>
      ),
    },
  ].filter(Boolean);
}

function LoadsTab() {
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const params = Object.fromEntries(sp.entries());
  const filters = { status: 'all', page: 1, sort: 'pickup', scope: 'mine', ...params };
  const setF = (patch) => setSp({ ...filters, page: 1, ...patch }, { replace: true });
  const q = useQuery({ queryKey: ['loads', 'list', filters], queryFn: () => api.get('/api/loads', { ...filters, pageSize: 25 }) });
  const [editing, setEditing] = useState(null);
  const [docsFor, setDocsFor] = useState(null);
  const confirm = useConfirm();
  const remove = useApiMutation((id) => api.del(`/api/loads/${id}`), { success: 'Load deleted', invalidate: [['loads']] });
  const onDelete = async (l) => {
    if (await confirm({ title: 'Delete load?', message: `${l.originCity}, ${l.originState} → ${l.destCity}, ${l.destState} and its attached documents will be removed.`, danger: true })) remove.mutate(l.id);
  };
  const s = q.data?.summary;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Loads (filtered)" value={num(s?.loads ?? 0)} />
        <StatCard label="Total rate" value={money(s?.rateCents ?? 0, { digits: 0 })} />
        <StatCard label="Loaded miles" value={num(s?.loadedMiles ?? 0)} sub={s?.deadheadMiles ? `${num(s.deadheadMiles)} deadhead` : undefined} />
        <StatCard label="Average RPM" value={s?.avgRatePerMile != null ? dollars(s.avgRatePerMile) : '—'} tone="signal" />
      </div>
      <Card bodyClass="p-0" title={
        <div className="flex flex-wrap items-center gap-2">
          <Input type="search" placeholder="Search ref, city, commodity" defaultValue={filters.q || ''} className="h-8 w-52" aria-label="Search loads"
            onKeyDown={(e) => { if (e.key === 'Enter') setF({ q: e.target.value }); }} onBlur={(e) => e.target.value !== (filters.q || '') && setF({ q: e.target.value })} />
          <Select aria-label="Status" className="h-8 w-36" value={filters.status} onChange={(e) => setF({ status: e.target.value })}>
            <option value="all">All statuses</option><option value="active">Active</option>
            {LOAD_STATUSES.map((st) => <option key={st} value={st}>{label(st)}</option>)}
          </Select>
          <Select aria-label="Origin state" className="h-8 w-28" value={filters.originState || ''} onChange={(e) => setF({ originState: e.target.value })}>
            <option value="">Origin: any</option>{US_STATES.map((st) => <option key={st}>{st}</option>)}
          </Select>
          <Select aria-label="Destination state" className="h-8 w-28" value={filters.destState || ''} onChange={(e) => setF({ destState: e.target.value })}>
            <option value="">Dest: any</option>{US_STATES.map((st) => <option key={st}>{st}</option>)}
          </Select>
          <Input type="date" aria-label="Pickup from" className="h-8 w-36" value={filters.from || ''} onChange={(e) => setF({ from: e.target.value })} />
          <Input type="date" aria-label="Pickup to" className="h-8 w-36" value={filters.to || ''} onChange={(e) => setF({ to: e.target.value })} />
          <Select aria-label="Sort" className="h-8 w-36" value={filters.sort} onChange={(e) => setF({ sort: e.target.value })}>
            <option value="pickup">Newest pickup</option><option value="created">Recently added</option><option value="rate">Highest rate</option><option value="rpm">Highest RPM</option>
          </Select>
          {user?.team && (
            <Select aria-label="Scope" className="h-8 w-32" value={filters.scope} onChange={(e) => setF({ scope: e.target.value })}>
              <option value="mine">My loads</option><option value="team">Team</option>
            </Select>
          )}
        </div>
      }>
        <QueryState query={q}>
          {(data) => (
            <>
              <DataTable rows={data.items} columns={loadColumns({ onEdit: setEditing, onDelete, onDocs: setDocsFor })} onRowClick={setEditing}
                empty={<EmptyState icon={Package} title="No loads match" action={<Button icon={Plus} onClick={() => setEditing({})}>Add a load</Button>}>Record booked loads to track revenue, rate per mile and lane history.</EmptyState>} />
              <div className="border-t border-line px-3"><Pagination page={data.page} pages={data.pages} total={data.total} onPage={(p) => setSp({ ...filters, page: p })} /></div>
            </>
          )}
        </QueryState>
      </Card>
      <LoadFormModal open={!!editing} load={editing?.id ? editing : null} onClose={() => setEditing(null)} />
      <Modal open={!!docsFor} onClose={() => setDocsFor(null)} title={docsFor ? `Documents · ${docsFor.originCity} → ${docsFor.destCity}` : ''} size="lg">
        {docsFor && <DocumentsPanel loadId={docsFor.id} types={['rate_confirmation', 'bol', 'pod', 'other']} />}
      </Modal>
    </div>
  );
}

function LanesTab() {
  const q = useQuery({ queryKey: ['loads', 'lanes'], queryFn: () => api.get('/api/loads/lanes') });
  return (
    <Card bodyClass="p-0">
      <QueryState query={q}>
        {(data) => (
          <>
            <p className="border-b border-line px-4 py-2.5 text-xs text-muted">{data.note}</p>
            <DataTable rows={data.items.map((l) => ({ ...l, id: `${l.originState}-${l.destState}` }))}
              empty={<EmptyState title="No lane history yet">Lanes appear as you record loads.</EmptyState>}
              columns={[
                { key: 'lane', header: 'Lane', render: (l) => <span className="font-medium">{l.originState} → {l.destState}</span> },
                { key: 'loads', header: 'Loads', className: 'text-right', render: (l) => <span className="tabular">{l.loads}</span> },
                { key: 'avg', header: 'Avg RPM', className: 'text-right', render: (l) => <span className="tabular font-medium">{dollars(l.avgRatePerMile)}</span> },
                { key: 'range', header: 'Range', className: 'text-right', render: (l) => <span className="tabular text-muted">{dollars(l.minRatePerMile)} – {dollars(l.maxRatePerMile)}</span> },
                { key: 'miles', header: 'Loaded miles', className: 'text-right', render: (l) => <span className="tabular">{num(l.totalMiles)}</span> },
                { key: 'last', header: 'Last load', render: (l) => relative(l.lastLoadAt) },
              ]} />
          </>
        )}
      </QueryState>
    </Card>
  );
}

export default function Loads() {
  const [newParam] = useSearchParams();
  const [tab, setTab] = useState('loads');
  const [creating, setCreating] = useState(() => newParam.get('new') === '1');
  return (
    <div>
      <PageHeader title="Loads" subtitle="Booked freight, rate per mile, paperwork and lane history."
        actions={<>
          <Button variant="secondary" icon={Calculator} to="/app/loads/calculator">Rate calculator</Button>
          <Button icon={Plus} onClick={() => setCreating(true)}>New load</Button>
        </>} />
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[{ value: 'loads', label: 'Loads' }, { value: 'lanes', label: 'Lane history' }]} />
      {tab === 'loads' ? <LoadsTab /> : <LanesTab />}
      <LoadFormModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
