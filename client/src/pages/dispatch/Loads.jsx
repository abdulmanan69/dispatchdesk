import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus, Calculator, Pencil, Trash2, Package, Paperclip, FileUp, AlertTriangle, MessageSquare, List, Columns3, CalendarDays } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { date, dollars, label, money, num, relative, US_STATES } from '../../lib/format.js';
import { Badge, Button, Card, DataTable, EmptyState, IconButton, Input, PageHeader, Pagination, QueryState, Select, StatCard, Switch, Tabs } from '../../components/ui.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import DocumentsPanel from '../../components/documents/DocumentsPanel.jsx';
import { LOAD_DOC_TYPES } from '../../components/documents/docTypes.js';
import TextLogModal from '../../components/carriers/TextLogModal.jsx';
import LoadFormModal from '../../components/dispatch/LoadForm.jsx';
import LoadDetailModal from '../../components/dispatch/LoadDetail.jsx';
import { LoadStatusSelect } from '../../components/dispatch/LoadStatus.jsx';
import { LOAD_STATUSES, LOAD_STATUS_COLOR } from '../../components/dispatch/calc.js';
import LoadBoard from '../../components/dispatch/LoadBoard.jsx';
import LoadCalendar from '../../components/dispatch/LoadCalendar.jsx';
import DedicatedLanes from '../../components/dispatch/LoadTemplates.jsx';

/** URL params that are page state, not list filters. */
const PAGE_PARAMS = ['load', 'tab', 'new', 'import', 'view', 'section', 'canceled'];

export { LoadStatusSelect };

/** RC / BOL / POD chips: filled when the file is on the load, outlined when it is missing. */
export function DocChips({ docs }) {
  if (!docs) return null;
  const chip = (on, text, title) => (
    <span key={text} title={`${title}: ${on ? 'on file' : 'missing'}`}
      className={on ? 'rounded border border-c-green/30 bg-c-green-soft px-1 text-[10.5px] font-medium leading-4 text-c-green' : 'rounded border border-dashed border-line-strong px-1 text-[10.5px] leading-4 text-muted'}>
      {text}<span className="sr-only">{on ? ' on file' : ' missing'}</span>
    </span>
  );
  return <span className="inline-flex gap-1">{[chip(docs.rateCon, 'RC', 'Rate con'), chip(docs.bol, 'BOL', 'BOL'), chip(docs.pod, 'POD', 'POD')]}</span>;
}

function FitFlag({ load }) {
  const n = load.fit?.warnings?.length || 0;
  if (!n || load.fit.acknowledgedAt) return null;
  return <span title={load.fit.warnings.map((w) => w.message).join('\n')} className="inline-flex items-center gap-0.5 text-xs text-c-amber"><AlertTriangle className="size-3.5" aria-hidden />{n}<span className="sr-only"> carrier-rules warning{n === 1 ? '' : 's'}</span></span>;
}

export function loadColumns({ onEdit, onDelete, onDocs, onText, showBroker = true, showCarrier = true, editableStatus = true }) {
  return [
    {
      key: 'lane', header: 'Lane',
      render: (l) => (
        <div className="min-w-44">
          <div className="flex items-center gap-1.5 font-medium">{l.originCity}, {l.originState} → {l.destCity}, {l.destState} <FitFlag load={l} /></div>
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
    { key: 'docs', header: 'Paperwork', render: (l) => (l.docs ? <DocChips docs={l.docs} /> : <span className="text-muted">—</span>) },
    { key: 'status', header: 'Status', render: (l) => (editableStatus ? <LoadStatusSelect load={l} /> : <Badge color={LOAD_STATUS_COLOR[l.status]}>{label(l.status)}</Badge>) },
    (onEdit || onDelete || onDocs || onText) && {
      key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right',
      render: (l) => (
        <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
          {onText && l.carrier && <IconButton icon={MessageSquare} label="Text carrier" onClick={() => onText(l)} />}
          {onDocs && <IconButton icon={Paperclip} label="Documents" onClick={() => onDocs(l)} />}
          {onEdit && <IconButton icon={Pencil} label="Edit load" onClick={() => onEdit(l)} />}
          {onDelete && <IconButton icon={Trash2} label="Delete load" onClick={() => onDelete(l)} className="hover:text-red-600" />}
        </div>
      ),
    },
  ].filter(Boolean);
}

/** Phone layout of a load row: lane, money, paperwork and status stay on screen. */
export function loadMobileRow({ onEdit, onDocs, onText }) {
  return (l) => (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium">{l.originCity}, {l.originState} → {l.destCity}, {l.destState} <FitFlag load={l} /></p>
          <p className="truncate text-xs text-muted">{[l.referenceNumber && `#${l.referenceNumber}`, l.pickupDate && date(l.pickupDate, { month: 'short', day: 'numeric' }), l.broker?.companyName].filter(Boolean).join(' · ') || '—'}</p>
        </div>
        <span className="shrink-0 text-right text-sm tabular font-medium">{money(l.rateCents, { digits: 0 })}<span className="block text-xs font-normal text-muted">{l.calc?.ratePerMile != null ? `${dollars(l.calc.ratePerMile)}/mi` : ''}</span></span>
      </div>
      <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <LoadStatusSelect load={l} />
        <DocChips docs={l.docs} />
        <span className="ml-auto flex">
          {onText && l.carrier && <IconButton icon={MessageSquare} label="Text carrier" onClick={() => onText(l)} />}
          {onDocs && <IconButton icon={Paperclip} label="Documents" onClick={() => onDocs(l)} />}
          {onEdit && <IconButton icon={Pencil} label="Edit load" onClick={() => onEdit(l)} />}
        </span>
      </div>
    </div>
  );
}

function LoadsTab({ onOpen }) {
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const params = Object.fromEntries([...sp.entries()].filter(([k]) => !PAGE_PARAMS.includes(k)));
  const filters = { status: 'all', page: 1, sort: 'pickup', scope: 'mine', ...params };
  const setF = (patch) => setSp({ ...filters, page: 1, ...patch }, { replace: true });
  const q = useQuery({ queryKey: ['loads', 'list', filters], queryFn: () => api.get('/api/loads', { ...filters, pageSize: 25 }) });
  const [editing, setEditing] = useState(null);
  const [docsFor, setDocsFor] = useState(null);
  const [texting, setTexting] = useState(null);
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
        <div className="flex flex-wrap items-center gap-2 py-1">
          <Input type="search" placeholder="Search ref, city, commodity" defaultValue={filters.q || ''} className="h-8 w-full sm:w-52" aria-label="Search loads"
            onKeyDown={(e) => { if (e.key === 'Enter') setF({ q: e.target.value }); }} onBlur={(e) => e.target.value !== (filters.q || '') && setF({ q: e.target.value })} />
          <Select aria-label="Status" className="h-8 w-36" value={filters.status} onChange={(e) => setF({ status: e.target.value })}>
            <option value="all">All statuses</option><option value="active">Active</option>
            {LOAD_STATUSES.map((st) => <option key={st} value={st}>{label(st)}</option>)}
          </Select>
          <Select aria-label="Paperwork" className="h-8 w-40" value={filters.missing || ''} onChange={(e) => setF({ missing: e.target.value })}>
            <option value="">Any paperwork</option><option value="rate_confirmation">Missing rate con</option><option value="pod">Missing POD</option>
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
              <DataTable rows={data.items} columns={loadColumns({ onEdit: setEditing, onDelete, onDocs: setDocsFor, onText: setTexting })} onRowClick={(l) => onOpen(l.id)}
                mobileRow={loadMobileRow({ onEdit: setEditing, onDocs: setDocsFor, onText: setTexting })}
                empty={<EmptyState icon={Package} title="No loads match" action={<Button icon={Plus} onClick={() => setEditing({})}>Add a load</Button>}>Record booked loads to track revenue, rate per mile, paperwork and lane history.</EmptyState>} />
              <div className="border-t border-line px-3"><Pagination page={data.page} pages={data.pages} total={data.total} onPage={(p) => setSp({ ...filters, page: p })} /></div>
            </>
          )}
        </QueryState>
      </Card>
      <LoadFormModal open={!!editing} load={editing?.id ? editing : null} onClose={() => setEditing(null)} />
      <Modal open={!!docsFor} onClose={() => setDocsFor(null)} title={docsFor ? `Documents · ${docsFor.originCity} → ${docsFor.destCity}` : ''} size="lg">
        {docsFor && <DocumentsPanel loadId={docsFor.id} types={LOAD_DOC_TYPES} />}
      </Modal>
      {texting?.carrier && (
        <TextLogModal carrier={texting.carrier} loadId={texting.id} category="driver" title={`Text ${texting.carrier.companyName}`} onClose={() => setTexting(null)} />
      )}
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
              mobileRow={(l) => (
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium">{l.originState} → {l.destState}<span className="block text-xs font-normal text-muted">{l.loads} load{l.loads === 1 ? '' : 's'} · last {relative(l.lastLoadAt)}</span></span>
                  <span className="text-right tabular">{dollars(l.avgRatePerMile)}<span className="block text-xs text-muted">{dollars(l.minRatePerMile)} – {dollars(l.maxRatePerMile)}</span></span>
                </div>
              )}
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

const VIEWS = [
  { value: 'list', label: 'List', icon: List },
  { value: 'board', label: 'Board', icon: Columns3 },
  { value: 'calendar', label: 'Calendar', icon: CalendarDays },
];

/** Board and calendar: search, team scope and the canceled toggle (kept in the URL with the list filters). */
function ViewToolbar({ sp, setParams }) {
  const { user } = useAuth();
  const q = sp.get('q') || '';
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Input type="search" placeholder="Search ref, city, commodity" defaultValue={q} key={q} className="h-8 w-full sm:w-56" aria-label="Search loads"
        onKeyDown={(e) => { if (e.key === 'Enter') setParams({ q: e.target.value || null }); }} onBlur={(e) => e.target.value !== q && setParams({ q: e.target.value || null })} />
      {user?.team && (
        <Select aria-label="Scope" className="h-8 w-32" value={sp.get('scope') || 'mine'} onChange={(e) => setParams({ scope: e.target.value === 'mine' ? null : e.target.value })}>
          <option value="mine">My loads</option><option value="team">Team</option>
        </Select>
      )}
      <Switch checked={sp.get('canceled') === '1'} onChange={(on) => setParams({ canceled: on ? '1' : null })} label="Show canceled" />
    </div>
  );
}

export default function Loads() {
  const [sp, setSp] = useSearchParams();
  const section = ['lanes', 'history'].includes(sp.get('section')) ? sp.get('section') : 'loads';
  const view = VIEWS.some((v) => v.value === sp.get('view')) ? sp.get('view') : 'list';
  const [creating, setCreating] = useState(() => (sp.get('new') === '1' ? 'new' : sp.get('import') === '1' ? 'import' : null));
  const openId = sp.get('load');
  const setOpen = (id, detailTab) => {
    const next = new URLSearchParams(sp);
    if (id) { next.set('load', id); if (detailTab) next.set('tab', detailTab); else next.delete('tab'); } else { next.delete('load'); next.delete('tab'); }
    setSp(next, { replace: !id });
  };
  /** Set or clear (null) URL params, keeping the rest. */
  const setParams = (patch) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, v); }
    setSp(next, { replace: true });
  };
  const viewFilters = { q: sp.get('q') || undefined, scope: sp.get('scope') || undefined };
  return (
    <div>
      <PageHeader title="Loads" subtitle="Booked freight, rate per mile, paperwork, detention, dedicated lanes and lane history."
        actions={<>
          <Button variant="secondary" icon={Calculator} to="/app/loads/calculator">Rate calculator</Button>
          <Button variant="secondary" icon={FileUp} onClick={() => setCreating('import')}>Import rate con</Button>
          <Button icon={Plus} onClick={() => setCreating('new')}>New load</Button>
        </>} />
      <Tabs className="mb-4" value={section} onChange={(v) => setParams({ section: v === 'loads' ? null : v })}
        tabs={[{ value: 'loads', label: 'Loads' }, { value: 'lanes', label: 'Dedicated lanes' }, { value: 'history', label: 'Lane history' }]} />
      {section === 'loads' && (
        <>
          <div className="mb-3 flex w-fit rounded-md border border-line p-0.5" role="group" aria-label="View">
            {VIEWS.map((v) => (
              <Button key={v.value} size="sm" variant={view === v.value ? 'secondary' : 'ghost'} icon={v.icon} aria-pressed={view === v.value}
                onClick={() => setParams({ view: v.value === 'list' ? null : v.value })}>{v.label}</Button>
            ))}
          </div>
          {view !== 'list' && <ViewToolbar sp={sp} setParams={setParams} />}
          {view === 'list' && <LoadsTab onOpen={(id) => setOpen(id)} />}
          {view === 'board' && <LoadBoard filters={viewFilters} showCanceled={sp.get('canceled') === '1'} onOpen={(id) => setOpen(id)} />}
          {view === 'calendar' && <LoadCalendar filters={viewFilters} showCanceled={sp.get('canceled') === '1'} onOpen={(id) => setOpen(id)} />}
        </>
      )}
      {section === 'lanes' && <DedicatedLanes />}
      {section === 'history' && <LanesTab />}
      <LoadFormModal open={!!creating} importOpen={creating === 'import'} onClose={() => setCreating(null)} onSaved={(l) => l?.id && setOpen(l.id)} />
      <LoadDetailModal id={openId} initialTab={sp.get('tab') || 'overview'} onClose={() => setOpen(null)} />
    </div>
  );
}
