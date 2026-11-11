import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, GripVertical, MapPin, RotateCcw, Unlink, Warehouse } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { money } from '../../lib/format.js';
import { Badge, Button, ErrorState, Field, IconButton, Input, Loading, Select, cx } from '../ui.jsx';
import { Modal, useConfirm } from '../Modal.jsx';
import { useToast } from '../Toast.jsx';
import { windowText, hoursText } from './fleetApi.js';
import {
  MAX_LOADS, MIN_LOADS, checkStopOrder, defaultStopOrder, estimateOrder, loadsFromTrip, moveStop, normalizeCandidate, sameOrder, syncStopOrder,
} from './consolidationStops.js';

const INVALIDATE = [['fleet'], ['loads'], ['load'], ['today']];
const place = (p) => [p?.city, p?.state].filter(Boolean).join(', ');
const loadTitle = (l) => (l.ref ? `Load #${l.ref}` : `${l.pickup?.city || ''} → ${l.delivery?.city || ''}`);
const plainStops = (trip) => (trip?.stops || []).map(({ loadId, kind }) => ({ loadId, kind }));

/** Route totals: the saved road route when the order is the saved one, else a straight-line estimate for the new order. */
function Totals({ trip, stops, byId, saved }) {
  const r = trip?.route;
  if (saved && r?.miles != null) {
    return (
      <p className="text-[13px] text-fg-2">
        <span className="font-medium text-fg">{r.miles.toLocaleString('en-US')} {r.estimate ? 'mi (straight-line estimate)' : 'road mi'}</span>
        {r.minutes != null && ` · ${hoursText(r.minutes)} driving`}
        {r.estimate && !r.stateOnly && <span className="block text-xs text-muted">The routing service had no answer. The road route is tried again shortly.</span>}
      </p>
    );
  }
  const e = estimateOrder(stops, byId);
  if (!e) return null;
  return (
    <p className="text-[13px] text-fg-2">
      <span className="font-medium text-fg">About {e.miles.toLocaleString('en-US')} mi</span> · {hoursText(e.minutes)} driving
      <span className="block text-xs text-muted">Straight-line estimate. Road miles are worked out when you save.</span>
    </p>
  );
}

function StopRow({ stop, index, load, problem, locked, first, last, onMove, dragging, over, dragProps }) {
  const s = load?.[stop.kind];
  const Icon = stop.kind === 'pickup' ? Warehouse : MapPin;
  return (
    <li {...dragProps}
      className={cx('flex gap-2.5 rounded-lg border px-3 py-2 text-[12.5px] transition-ui', problem ? 'border-c-red/50 bg-c-red-soft' : 'border-line bg-surface',
        dragging && 'opacity-50', over && !dragging && 'ring-2 ring-brand-500/40')}>
      <span className="flex shrink-0 flex-col items-center gap-1">
        <span className="flex size-6 items-center justify-center rounded-full bg-fg text-[11px] font-semibold text-bg tabular">{index + 1}</span>
        <Icon className={cx('size-3.5', stop.kind === 'pickup' ? 'text-c-blue' : 'text-c-green')} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{stop.kind === 'pickup' ? 'Pickup' : 'Delivery'} · {place(s)}</span>
          {s?.done && <Badge color="green">Done</Badge>}
        </div>
        {s?.facility && <div className="truncate text-fg-2">{s.facility}</div>}
        <div className="text-muted">{windowText(s?.window)}</div>
        <div className="truncate text-fg-2">{load ? loadTitle(load) : 'Load'}{load?.broker ? ` · ${load.broker}` : ''}</div>
        {problem && <p className="mt-0.5 text-[12px] font-medium text-c-red">{problem}</p>}
      </div>
      {!locked && (
        <span className="flex shrink-0 flex-col items-center">
          <span className="hidden cursor-grab p-1 text-muted sm:block" aria-hidden><GripVertical className="size-4" /></span>
          <IconButton icon={ArrowUp} label={`Move stop ${index + 1} up`} className="size-7" disabled={first} onClick={() => onMove(index, index - 1)} />
          <IconButton icon={ArrowDown} label={`Move stop ${index + 1} down`} className="size-7" disabled={last} onClick={() => onMove(index, index + 1)} />
        </span>
      )}
    </li>
  );
}

/**
 * Put several loads on one truck as one trip (create), or change a trip's stop order, loads and name (edit).
 * Each load keeps its own rate, invoice and paperwork; the trip sets the order the truck drives the stops in.
 *   carrierId, carrierName   the truck
 *   trip                     an existing consolidated trip (GET /api/consolidations view): edit mode
 *   initialLoadIds           loads to start with (create mode), e.g. the load the dialog was opened from
 */
export default function ConsolidateModal({ carrierId, carrierName, trip: initialTrip = null, initialLoadIds = [], onClose, onSaved }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [trip, setTrip] = useState(initialTrip);
  const editing = !!trip;
  const [picked, setPicked] = useState(() => [...new Set(initialLoadIds)]);
  const [name, setName] = useState(initialTrip?.name || '');
  const [stops, setStops] = useState(() => plainStops(initialTrip));
  const [touched, setTouched] = useState(false);
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);

  const cand = useQuery({
    queryKey: ['fleet', 'consolidations', 'candidates', carrierId],
    queryFn: () => api.get('/api/consolidations/candidates', { carrierId }),
    enabled: !!carrierId,
  });
  const candidates = useMemo(() => [...(cand.data?.loads || []), ...(cand.data?.unassigned || [])].map(normalizeCandidate), [cand.data]);
  const loads = useMemo(() => (editing ? loadsFromTrip(trip) : picked.map((id) => candidates.find((c) => c.id === id)).filter(Boolean)), [editing, trip, picked, candidates]);
  const byId = useMemo(() => new Map(loads.map((l) => [l.id, l])), [loads]);

  // New trip: time order until the dispatcher moves a stop, then their order is kept as loads are picked or unpicked.
  useEffect(() => {
    if (!editing) setStops((s) => (touched ? syncStopOrder(s, loads) : defaultStopOrder(loads)));
  }, [editing, loads, touched]);
  // Saved trip: start again from the server's order after a load was added or taken off.
  useEffect(() => { if (trip) { setStops(plainStops(trip)); setTouched(false); } }, [trip]);

  const check = checkStopOrder(stops, loads.map((l) => l.id), byId);
  const saved = editing && sameOrder(stops, plainStops(trip));
  const done = (s) => !!byId.get(s.loadId)?.[s.kind]?.done;
  const firstOpen = stops.reduce((n, s, i) => (done(s) ? i + 1 : n), 0);
  const move = (from, to) => {
    if (to < firstOpen || from < firstOpen) return;
    setStops((s) => moveStop(s, from, to));
    setTouched(true);
  };

  const finish = (d, verb) => {
    const r = d?.consolidation?.route;
    toast.success(`${verb}${r?.miles != null ? `: ${r.miles.toLocaleString('en-US')} ${r.estimate ? 'mi (estimate)' : 'road mi'}${r.minutes != null ? `, ${hoursText(r.minutes)} driving` : ''}` : ''}`);
    onSaved?.(d.consolidation);
    onClose();
  };
  const create = useApiMutation(() => api.post('/api/consolidations', { carrierId, loadIds: loads.map((l) => l.id), name: name.trim() || null, stops }), {
    invalidate: INVALIDATE, onSuccess: (d) => finish(d, 'Consolidated trip saved'),
  });
  const save = useApiMutation(() => api.patch(`/api/consolidations/${trip.id}`, { stops, name: name.trim() || null }), {
    invalidate: INVALIDATE, onSuccess: (d) => finish(d, 'Stop order saved'),
  });
  const change = useApiMutation(({ action, loadId }) => api.post(`/api/consolidations/${trip.id}/loads`, { action, loadId }), {
    invalidate: INVALIDATE,
    onSuccess: (d, v) => {
      if (d.dissolved) { toast.success('Trip ended: fewer than 2 loads were left on it'); onSaved?.(null); onClose(); return; }
      toast.success(v.action === 'add' ? 'Load added to the trip' : 'Load taken off the trip');
      setTrip(d.consolidation);
    },
  });
  const ungroup = useApiMutation(() => api.del(`/api/consolidations/${trip.id}`), {
    invalidate: INVALIDATE, success: 'Trip ungrouped. The loads are separate trips again.', onSuccess: () => { onSaved?.(null); onClose(); },
  });

  const takeOff = async (l) => {
    const last = loads.length <= MIN_LOADS;
    const ok = await confirm({
      title: last ? 'End this trip?' : 'Take this load off the trip?',
      message: last ? `Taking ${loadTitle(l)} off leaves one load, so the consolidated trip ends. Both loads stay as separate trips.` : `${loadTitle(l)} stays on the truck as a separate trip.`,
      confirmLabel: last ? 'End trip' : 'Take off',
    });
    if (ok) change.mutate({ action: 'remove', loadId: l.id });
  };
  const doUngroup = async () => {
    const ok = await confirm({ title: 'Ungroup this trip?', message: 'The loads stay as they are, each as its own trip with its own route.', confirmLabel: 'Ungroup', danger: true });
    if (ok) ungroup.mutate();
  };
  const togglePick = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_LOADS ? p : [...p, id]));

  const enoughLoads = loads.length >= MIN_LOADS;
  const busy = create.isPending || save.isPending || change.isPending || ungroup.isPending;
  const canSave = enoughLoads && check.ok && !busy && (editing ? !saved || (name.trim() || null) !== (trip.name || null) : true);
  const addable = editing ? candidates.filter((c) => !byId.has(c.id) && !c.trip) : [];
  const title = editing ? `Consolidated trip · ${carrierName || 'truck'}` : `Consolidate loads on ${carrierName || 'this truck'}`;

  const footer = (
    <>
      {editing && <Button variant="ghost" icon={Unlink} className="mr-auto text-c-red" disabled={busy} loading={ungroup.isPending} onClick={doUngroup}>Ungroup</Button>}
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button disabled={!canSave} loading={create.isPending || save.isPending} onClick={() => (editing ? save.mutate() : create.mutate())}>
        {editing ? 'Save' : 'Create trip'}
      </Button>
    </>
  );

  return (
    <Modal open onClose={onClose} title={title} size="lg" footer={footer}>
      <div className="space-y-5">
        <p className="text-[13px] text-fg-2">Several loads on one truck, driven in the stop order below. Each load keeps its own rate, invoice and paperwork.</p>
        <Field label="Trip name" hint="Optional. Shown on the fleet map and the truck panel.">
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={editing ? trip.title : 'For example: Tuesday Texas run'} />
        </Field>

        {/* Loads */}
        <section className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">Loads</h3>
            <span className="text-xs text-muted tabular">{loads.length} of {MAX_LOADS}</span>
          </div>
          {editing ? (
            <>
              <ul className="space-y-1.5">
                {loads.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 text-[12.5px]">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{loadTitle(l)} · {place(l.pickup)} → {place(l.delivery)}</span>
                      <span className="block truncate text-muted">{[l.broker, l.rateCents != null && money(l.rateCents, { digits: 0 })].filter(Boolean).join(' · ')}</span>
                    </span>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => takeOff(l)}>Take off</Button>
                  </li>
                ))}
              </ul>
              {loads.length < MAX_LOADS && addable.length > 0 && (
                <Select aria-label="Add a load to this trip" value="" disabled={busy} className="h-9 text-[13px]" onChange={(e) => e.target.value && change.mutate({ action: 'add', loadId: e.target.value })}>
                  <option value="">Add a load to this trip</option>
                  {addable.map((c) => <option key={c.id} value={c.id}>{loadTitle(c)} · {place(c.pickup)} → {place(c.delivery)}{c.onTruck ? '' : ' (no truck yet)'}</option>)}
                </Select>
              )}
            </>
          ) : cand.isLoading ? <Loading className="py-4" /> : cand.isError ? <ErrorState error={cand.error} onRetry={cand.refetch} /> : (
            <CandidateList candidates={candidates} picked={picked} onToggle={togglePick} />
          )}
        </section>

        {/* Stop order */}
        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">Stop order</h3>
            {enoughLoads && <Button size="sm" variant="ghost" icon={RotateCcw} disabled={firstOpen > 0} onClick={() => { setStops(defaultStopOrder(loads)); setTouched(true); }}>Time order</Button>}
          </div>
          {!enoughLoads ? (
            <p className="text-[13px] text-muted">Pick at least {MIN_LOADS} loads to set the stop order.</p>
          ) : (
            <>
              <p className="text-xs text-muted">Drag a stop, or use the arrows. Every load is picked up before it is delivered.</p>
              <ol className="space-y-1.5">
                {stops.map((s, i) => {
                  const locked = i < firstOpen;
                  return (
                    <StopRow key={`${s.loadId}-${s.kind}`} stop={s} index={i} load={byId.get(s.loadId)} problem={check.problems[i]} locked={locked}
                      first={i <= firstOpen} last={i === stops.length - 1} onMove={move} dragging={drag === i} over={over === i}
                      dragProps={locked ? {} : {
                        draggable: true,
                        onDragStart: (e) => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); },
                        onDragOver: (e) => { e.preventDefault(); if (over !== i) setOver(i); },
                        onDrop: (e) => { e.preventDefault(); if (drag != null) move(drag, i); setDrag(null); setOver(null); },
                        onDragEnd: () => { setDrag(null); setOver(null); },
                      }} />
                  );
                })}
              </ol>
              {!check.ok && <p className="text-[13px] font-medium text-c-red" role="alert">{check.message}</p>}
              {check.ok && <Totals trip={trip} stops={stops} byId={byId} saved={saved} />}
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}

/** Open loads to pick from: the truck's own, then loads with no truck yet (they are put on this truck). */
function CandidateList({ candidates, picked, onToggle }) {
  const onTruck = candidates.filter((c) => c.onTruck);
  const free = candidates.filter((c) => !c.onTruck);
  if (!candidates.length) return <p className="text-[13px] text-muted">No open loads on this truck yet. Plan or book loads for it first.</p>;
  const full = picked.length >= MAX_LOADS;
  const row = (c) => {
    const taken = !!c.trip && !picked.includes(c.id);
    const disabled = taken || (full && !picked.includes(c.id));
    return (
      <li key={c.id}>
        <label className={cx('flex items-start gap-2.5 rounded-lg border px-3 py-2 text-[12.5px] transition-ui', picked.includes(c.id) ? 'border-brand-500/60 bg-brand-500/5' : 'border-line', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-surface-2')}>
          <input type="checkbox" className="dd-check mt-0.5 size-4 shrink-0 cursor-pointer rounded accent-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
            checked={picked.includes(c.id)} disabled={disabled} onChange={() => onToggle(c.id)} aria-label={`Pick ${loadTitle(c)}`} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="font-medium">{loadTitle(c)} · {place(c.pickup)} → {place(c.delivery)}</span>
              {c.rateCents != null && <span className="tabular text-muted">{money(c.rateCents, { digits: 0 })}</span>}
            </span>
            <span className="block text-muted">Pickup {windowText(c.pickup.window)}{c.broker ? ` · ${c.broker}` : ''}</span>
            {taken && <span className="block text-c-amber">On another consolidated trip</span>}
          </span>
        </label>
      </li>
    );
  };
  return (
    <div className="space-y-3">
      {onTruck.length > 0 && <ul className="space-y-1.5">{onTruck.map(row)}</ul>}
      {free.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted">Loads with no truck yet. Picked ones are assigned to this truck.</p>
          <ul className="space-y-1.5">{free.map(row)}</ul>
        </div>
      )}
    </div>
  );
}
