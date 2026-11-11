import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Receipt, FileText, ShieldAlert, MessageSquare, Layers, ListOrdered, Map as MapIcon } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { date, dollars, label, money, num } from '../../lib/format.js';
import { Badge, Button, ErrorState, Loading, Tabs, cx } from '../ui.jsx';
import { Modal } from '../Modal.jsx';
import { useToast } from '../Toast.jsx';
import DocumentsPanel from '../documents/DocumentsPanel.jsx';
import { LOAD_DOC_TYPES } from '../documents/docTypes.js';
import TextLogModal from '../carriers/TextLogModal.jsx';
import ConsolidateModal from '../fleet/ConsolidateModal.jsx';
import ReloadIdeas from '../carriers/ReloadIdeas.jsx';
import { LoadNegotiations } from '../negotiation/NegotiationList.jsx';
import DetentionPanel from './DetentionPanel.jsx';
import FitCard from './FitCard.jsx';
import LoadFormModal from './LoadForm.jsx';
import { LoadStatusSelect } from './LoadStatus.jsx';
import { LOAD_STATUS_COLOR } from './calc.js';
import { formatAt, formatWindow } from './zoned.js';

const EVENT_LABEL = {
  arrived_pickup: 'Arrived at pickup', loaded: 'Loaded', departed_pickup: 'Departed pickup', arrived_delivery: 'Arrived at delivery',
  delivered: 'Unloaded and departed', issue: 'Issue', check_call: 'Check call', detention_start: 'Detention started', detention_stop: 'Detention ended',
  document: 'Document', status: 'Status change', note: 'Note', pod_signed: 'POD signed',
};
const SOURCE = { driver_link: ['teal', 'Driver'], dispatcher: ['gray', 'Dispatcher'], system: ['purple', 'System'], broker_link: ['blue', 'Broker link'] };
const INVOICE_COLOR = { draft: 'gray', sent: 'blue', partial: 'amber', paid: 'green', void: 'red' };

function Row({ k, children }) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5 text-sm sm:flex-row sm:justify-between sm:gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 break-words sm:text-right">{children || '—'}</dd>
    </div>
  );
}

/** Loads that are booked or on the road: the truck empties at the delivery, so reload ideas there are timely. */
const RELOAD_STATUSES = ['booked', 'in_transit'];

function Overview({ load, onEdit, onText }) {
  const { user } = useAuth();
  const pickup = load.pickupWindowStart ? formatWindow(load.pickupWindowStart, load.pickupWindowEnd, load.pickupTz, user?.timezone) : load.pickupDate ? date(load.pickupDate) : null;
  const delivery = load.deliveryWindowStart ? formatWindow(load.deliveryWindowStart, load.deliveryWindowEnd, load.deliveryTz, user?.timezone) : load.deliveryDate ? date(load.deliveryDate) : null;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="space-y-4">
          <dl className="divide-y divide-line">
            <Row k="Status"><LoadStatusSelect load={load} className="sm:ml-auto" /></Row>
            <Row k="Broker">{load.broker && (
              <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                <Link to={`/app/brokers/${load.broker.id}`} className="hover:underline">{load.broker.companyName}</Link>
                {load.broker.flagLevel && <Badge color={load.broker.flagLevel === 'red' ? 'red' : 'amber'}><ShieldAlert className="size-3" aria-hidden />Check flags</Badge>}
              </span>
            )}</Row>
            <Row k="Carrier">{load.carrier && <Link to={`/app/carriers/${load.carrier.id}`} className="hover:underline">{load.carrier.companyName}</Link>}</Row>
            <Row k="Pickup">{[load.pickupFacility, pickup].filter(Boolean).join(' · ')}{load.pickupAddress && <span className="block text-xs text-muted">{load.pickupAddress}</span>}</Row>
            <Row k="Delivery">{[load.deliveryFacility, delivery].filter(Boolean).join(' · ')}{load.deliveryAddress && <span className="block text-xs text-muted">{load.deliveryAddress}</span>}</Row>
            <Row k="Rate">{money(load.rateCents)}{load.calc?.ratePerMile != null && <span className="text-muted"> · {dollars(load.calc.ratePerMile)}/mi</span>}</Row>
            <Row k="Miles">{num(load.loadedMiles)} loaded{load.deadheadMiles ? ` · ${num(load.deadheadMiles)} deadhead` : ''}</Row>
            <Row k="Equipment / weight">{[load.equipment && label(load.equipment), load.weightLbs && `${num(load.weightLbs)} lb`, load.commodity].filter(Boolean).join(' · ')}</Row>
            <Row k="Gross / fee / carrier net">{`${money(load.calc?.grossCents)} · ${load.calc?.dispatchFeeCents != null ? money(load.calc.dispatchFeeCents) : 'no fee %'} · ${money(load.calc?.carrierNetCents)}`}</Row>
            {load.lastCheckCallAt && <Row k="Last check call">{formatAt(load.lastCheckCallAt, user?.timezone)}</Row>}
          </dl>
          {load.notes && <div className="whitespace-pre-wrap rounded-md border border-line bg-surface-2/40 p-3 text-sm">{load.notes}</div>}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={Pencil} onClick={onEdit}>Edit load</Button>
            {load.carrier && <Button variant="secondary" icon={MessageSquare} onClick={onText}>Text carrier</Button>}
          </div>
          <LoadNegotiations load={load} />
          <ConsolidationSection load={load} />
        </div>
        <div className="h-fit rounded-md border border-line bg-surface-2/40 p-3">
          <FitCard load={load} carrierId={load.carrierId} loadId={load.id} stored={load.fit} />
        </div>
      </div>
      {RELOAD_STATUSES.includes(load.status) && (
        <ReloadIdeas state={load.destState} city={load.destCity} equipment={load.equipment || undefined} compact title="Reload ideas near delivery" />
      )}
    </div>
  );
}

const OPEN_LOAD = ['planned', 'booked', 'in_transit'];
const TRIP_STATUS_TEXT = { planned: ['purple', 'Planned'], in_transit: ['blue', 'In transit'], delivered: ['green', 'Delivered'], canceled: ['gray', 'Ended'] };

/**
 * Consolidated trip this load is on (several loads on one truck, one stop order), or a way to start one with the
 * truck's other open loads. The load keeps its own rate, invoice and documents either way.
 */
function ConsolidationSection({ load }) {
  const [dialog, setDialog] = useState(null); // 'create' | 'edit'
  const q = useQuery({
    queryKey: ['fleet', 'consolidations', 'one', load.consolidationId],
    queryFn: () => api.get(`/api/consolidations/${load.consolidationId}`),
    enabled: !!load.consolidationId,
  });
  if (!load.consolidationId) {
    if (!load.carrierId || !OPEN_LOAD.includes(load.status)) return null;
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 text-muted">Room on the truck for more freight? Put this load on one trip with the carrier's other open loads.</span>
        <Button size="sm" variant="secondary" icon={Layers} onClick={() => setDialog('create')}>Consolidate</Button>
        {dialog && <ConsolidateModal carrierId={load.carrierId} carrierName={load.carrier?.companyName} initialLoadIds={[load.id]} onClose={() => setDialog(null)} />}
      </div>
    );
  }
  const t = q.data?.consolidation;
  if (!t) return q.isLoading ? <Loading className="py-2" /> : null;
  const [color, text] = TRIP_STATUS_TEXT[t.status] || ['gray', t.status];
  const r = t.route || {};
  return (
    <div className="space-y-2 rounded-md border border-line p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 font-medium"><Layers className="size-4 shrink-0 text-brand-600" aria-hidden />Consolidated trip · {t.title}</span>
        <Badge color={color}>{text}</Badge>
      </div>
      <p className="text-xs text-muted">
        {t.loads.length} loads on {load.carrier?.companyName || 'one truck'}
        {r.miles != null ? ` · ${num(r.miles)} ${r.estimate ? 'mi (estimate)' : 'road mi'}` : ''}. Rate, invoice and documents stay with each load.
      </p>
      <ol className="space-y-1">
        {t.stops.map((s) => {
          const mine = s.loadId === load.id;
          return (
            <li key={`${s.loadId}-${s.kind}`} className={cx('flex items-baseline gap-2 text-[13px]', mine ? 'font-medium' : 'text-fg-2', s.done && 'opacity-60')}>
              <span className={cx('flex size-5 shrink-0 items-center justify-center rounded-full text-[10.5px] font-semibold tabular', mine ? 'bg-brand-600 text-white' : 'bg-surface-2 text-fg-2')}>{s.n}</span>
              <span className="min-w-0">{s.kind === 'pickup' ? 'Pickup' : 'Delivery'} · {s.city}, {s.state}{mine ? ' · this load' : s.load.referenceNumber ? ` · #${s.load.referenceNumber}` : ''}{s.done ? ' · done' : ''}</span>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap gap-2">
        {['planned', 'in_transit'].includes(t.status) && <Button size="sm" variant="secondary" icon={ListOrdered} onClick={() => setDialog('edit')}>Edit stops</Button>}
        <Button size="sm" variant="ghost" icon={MapIcon} to={`/app/fleet?truck=${t.carrierId}&trip=${load.id}`}>Fleet map</Button>
      </div>
      {dialog && <ConsolidateModal carrierId={t.carrierId} carrierName={load.carrier?.companyName} trip={t} onClose={() => setDialog(null)} />}
    </div>
  );
}

function Timeline({ events, tz }) {
  if (!events.length) return <p className="py-6 text-center text-sm text-muted">No timeline entries yet. Status changes, check-ins and stop times appear here.</p>;
  return (
    <ol className="space-y-2.5">
      {[...events].reverse().map((e) => {
        const [color, who] = SOURCE[e.source] || ['gray', e.source];
        return (
          <li key={e.id} className="flex gap-3 border-l-2 border-line pl-3 text-sm">
            <span className="w-32 shrink-0 text-xs text-muted">{formatAt(e.at, tz)}</span>
            <span className="min-w-0">
              <span className="font-medium">{EVENT_LABEL[e.type] || label(e.type)}</span> <Badge color={color}>{who}</Badge>
              {e.note && <span className="block text-muted">{e.note}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Invoices({ load, invoices }) {
  const navigate = useNavigate();
  const toast = useToast();
  const create = useApiMutation((kind) => api.post('/api/invoices', { loadId: load.id, kind }), {
    success: (d) => `Draft invoice #${d.invoice.number} created`,
    invalidate: [['invoices'], ['load', load.id]],
    onSuccess: (d) => navigate(`/app/invoices?open=${d.invoice.id}`),
    onError: (err) => {
      if (err.status === 409 && err.details?.invoiceId) navigate(`/app/invoices?open=${err.details.invoiceId}`);
      else toast.error(err);
    },
  });
  const billable = ['delivered', 'invoiced', 'paid'].includes(load.status) || (load.status === 'canceled' && load.tonuCents > 0);
  return (
    <div className="space-y-3">
      {invoices.length ? (
        <ul className="divide-y divide-line rounded-md border border-line">
          {invoices.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <Link to={`/app/invoices?open=${i.id}`} className="font-medium hover:underline">#{i.number} · {i.kind === 'freight' ? 'Freight' : 'Dispatch fee'} · {i.billToName}</Link>
              <span className="flex items-center gap-2"><span className="tabular">{money(i.amountCents)}</span><Badge color={INVOICE_COLOR[i.status]}>{label(i.status)}</Badge></span>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted">No invoices for this load yet.</p>}
      {billable ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={Receipt} loading={create.isPending && create.variables === 'freight'} disabled={!load.broker} onClick={() => create.mutate('freight')}>Invoice the broker</Button>
          <Button size="sm" variant="secondary" icon={Receipt} loading={create.isPending && create.variables === 'dispatch_fee'} disabled={!load.carrier} onClick={() => create.mutate('dispatch_fee')}>Bill the dispatch fee</Button>
          {!load.broker && <span className="self-center text-xs text-muted">Add the broker to invoice it.</span>}
        </div>
      ) : <p className="text-xs text-muted">Invoices can be created once the load is delivered (or after a TONU).</p>}
    </div>
  );
}

/** Load detail: overview with the load check, stop times and detention, documents, invoices and the timeline. */
export default function LoadDetailModal({ id, onClose, initialTab = 'overview' }) {
  const { user } = useAuth();
  const [tab, setTab] = useState(initialTab);
  const [editing, setEditing] = useState(false);
  const [texting, setTexting] = useState(false);
  useEffect(() => { if (id) setTab(initialTab || 'overview'); }, [id, initialTab]);
  useEffect(() => { setTexting(false); }, [id]);
  const q = useQuery({ queryKey: ['load', id], queryFn: () => api.get(`/api/loads/${id}`), enabled: !!id });
  const d = q.data;
  const l = d?.load;
  return (
    <Modal open={!!id} onClose={onClose} size="xl"
      title={l ? `${l.originCity}, ${l.originState} → ${l.destCity}, ${l.destState}${l.referenceNumber ? ` · #${l.referenceNumber}` : ''}` : 'Load'}>
      {!id ? null : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} /> : !d ? <Loading /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge color={LOAD_STATUS_COLOR[l.status]}>{label(l.status)}</Badge>
            {l.fit?.warnings?.length > 0 && <Badge color={l.fit.acknowledgedAt ? 'gray' : 'amber'}>{l.fit.warnings.length} rule warning{l.fit.warnings.length === 1 ? '' : 's'}{l.fit.acknowledgedAt ? ' · acknowledged' : ''}</Badge>}
            {d.detention.running && <Badge color="amber">On detention</Badge>}
            <span className="text-muted">Added {date(l.createdAt)}</span>
          </div>
          <Tabs value={tab} onChange={setTab} tabs={[
            { value: 'overview', label: 'Overview' },
            { value: 'stops', label: 'Stops & detention' },
            { value: 'documents', label: 'Documents', count: l.documents?.length || 0 },
            { value: 'invoices', label: 'Invoices', count: d.invoices.length },
            { value: 'timeline', label: 'Timeline', count: d.events.length },
          ]} />
          {tab === 'overview' && <Overview load={l} onEdit={() => setEditing(true)} onText={() => setTexting(true)} />}
          {tab === 'stops' && <DetentionPanel load={l} detention={d.detention} events={d.events} onChanged={() => q.refetch()} />}
          {tab === 'documents' && (
            <div className="space-y-2">
              <p className="flex items-center gap-1.5 text-xs text-muted"><FileText className="size-3.5" aria-hidden />Rate con, BOL and POD files are shared on the carrier’s statement portal when the load is delivered.</p>
              <DocumentsPanel loadId={l.id} types={LOAD_DOC_TYPES} />
            </div>
          )}
          {tab === 'invoices' && <Invoices load={l} invoices={d.invoices} />}
          {tab === 'timeline' && <Timeline events={d.events} tz={user?.timezone} />}
        </div>
      )}
      <LoadFormModal open={editing} onClose={() => setEditing(false)} load={l} onSaved={() => q.refetch()} />
      {texting && l?.carrier && (
        <TextLogModal carrier={l.carrier} loadId={l.id} category="driver" title={`Text ${l.carrier.companyName}`} onClose={() => setTexting(false)} />
      )}
    </Modal>
  );
}
