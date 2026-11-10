import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, ExternalLink, FileText, Lock, MessageSquare, Navigation, Pencil, Radio, Send, StickyNote, X } from 'lucide-react';
import { api } from '../../lib/api.js';
import { dateTime, label, money, relative } from '../../lib/format.js';
import { Badge, Button, LocalClock, cx } from '../ui.jsx';
import CallButton from '../calling/CallButton.jsx';
import ShareLocation, { CONFIDENCE } from './ShareLocation.jsx';
import { STATUS, TRIP_STATUS, NEXT_TRIP_STATUS, placeLabel, sinceText } from './fleetApi.js';

export function StatusChip({ status, className }) {
  const s = STATUS[status] || STATUS.unknown;
  return <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] font-medium', s.soft, className)}><span className="size-1.5 rounded-full" style={{ background: s.color }} />{s.label}</span>;
}

function TripLine({ trip, onAdvance, busy }) {
  if (!trip) return null;
  const next = NEXT_TRIP_STATUS[trip.status];
  const c = TRIP_STATUS[trip.status]?.color;
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px]" style={{ borderLeft: `3px solid ${c}` }}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: c }}><span className="size-2 rounded-full" style={{ background: c }} />{TRIP_STATUS[trip.status]?.label}</span>
        <span className="tabular text-xs text-muted">{money(trip.rateCents, { digits: 0 })}{trip.rpmAllIn != null ? ` · $${trip.rpmAllIn.toFixed(2)}/mi` : ''}</span>
      </div>
      <div className="mt-0.5 font-medium">{trip.origin.city}, {trip.origin.state} → {trip.dest.city}, {trip.dest.state}</div>
      <div className="text-xs text-muted">{trip.pickupDate ? `Pickup ${dateTime(trip.pickupDate)}` : 'Pickup not scheduled'}{trip.loadedMiles ? ` · ${trip.loadedMiles} mi` : ''}{trip.deadheadMiles ? ` + ${trip.deadheadMiles} empty` : ''}</div>
      {next && <Button size="sm" variant="secondary" className="mt-2" loading={busy} onClick={() => onAdvance(trip.id, next)}>Mark {TRIP_STATUS[next].label.toLowerCase()}</Button>}
    </div>
  );
}

/** How far to trust a driver-link position (one phone, PIN, plausibility checks), in plain words. */
function TrustRow({ live }) {
  const conf = live.confidence ? CONFIDENCE[live.confidence] : null;
  if (!conf) return null;
  const tone = live.confidence === 'high' ? 'text-c-green' : live.confidence === 'medium' ? 'text-amber-700 dark:text-amber-300' : 'text-red-700 dark:text-red-300';
  return (
    <div className="mt-1.5 border-t border-line pt-1.5">
      <span className={cx('flex items-center gap-1.5 font-medium', tone)}><conf.Icon className="size-3.5" aria-hidden />{conf.label}</span>
      {live.reasons?.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[12px] text-fg-2">
          {live.reasons.slice(0, 5).map((r) => <li key={r} className="flex gap-1.5"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-current opacity-50" />{r}</li>)}
        </ul>
      )}
    </div>
  );
}

function LiveRow({ truck }) {
  const l = truck.live || {};
  if (l.source !== 'driver_link' && !l.shareStatus) {
    return <p className="text-xs text-muted">Position set by dispatch{truck.location?.updatedAt ? ` ${relative(truck.location.updatedAt)}` : ''}. Share a live link to follow the driver's GPS.</p>;
  }
  if (l.shareStatus === 'locked') {
    return <p className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-[12.5px] text-red-700 dark:border-red-900 dark:text-red-300"><Lock className="size-3.5" aria-hidden />Link locked after 5 wrong PINs. Create a new link or reset the device.</p>;
  }
  const tone = l.sharing && !l.stale ? 'text-c-green' : 'text-muted';
  return (
    <div className="rounded-lg border border-line px-3 py-2 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={cx('flex items-center gap-1.5 font-medium', tone)}>
          <span className={cx('size-2 rounded-full', l.sharing && !l.stale ? 'animate-pulse bg-c-green' : 'bg-c-gray')} />
          {l.sharing && !l.stale ? 'Live GPS' : l.shareStatus === 'pending' ? 'Link sent, not opened' : l.shareStatus === 'paused' ? 'Driver paused sharing' : l.shareStatus === 'expired' ? 'Link expired' : 'GPS not updating'}
        </span>
        {l.lastAt && <span className="text-muted">{sinceText(l.lastAt)}</span>}
        {l.speedMph != null && <span className="tabular text-muted">{l.speedMph} mph</span>}
        {l.accuracyM != null && <span className="tabular text-muted">±{l.accuracyM} m</span>}
        {l.driverName && <span className="text-muted">{l.driverName}</span>}
        {l.deviceLabel && <span className="text-muted">{l.deviceLabel}</span>}
      </div>
      {l.unverified && (
        <p className="mt-1.5 text-[12px] text-red-700 dark:text-red-300">
          Unverified GPS fix {sinceText(l.unverified.at)} at {l.unverified.lat.toFixed(3)}, {l.unverified.lng.toFixed(3)} was ignored: it is too far from the last real position. The pin shows the last verified position.
        </p>
      )}
      <TrustRow live={l} />
    </div>
  );
}

function Timeline({ carrierId }) {
  const q = useQuery({ queryKey: ['fleet', 'checkins', carrierId], queryFn: () => api.get(`/api/fleet/carriers/${carrierId}/checkins`), refetchInterval: 60000 });
  const items = q.data?.items || [];
  if (!items.length) return <p className="text-xs text-muted">No check-ins yet. Drivers check in from their link at pickup and delivery.</p>;
  return (
    <ol className="space-y-2">
      {items.slice(0, 6).map((a) => (
        <li key={a.id} className="flex gap-2 text-[12.5px]">
          <span className={cx('mt-1 size-2 shrink-0 rounded-full', a.type === 'checkin' ? 'bg-c-green' : a.type === 'load' ? 'bg-c-blue' : 'bg-c-gray')} />
          <span className="min-w-0"><span className="block">{a.summary}</span><span className="text-[11px] text-muted">{relative(a.createdAt)}</span></span>
        </li>
      ))}
    </ol>
  );
}

/** Everything a dispatcher does for one truck: live position, trip, calls and messages, check-ins. */
export default function TruckPanel({ truck, onClose, onPlan, onEdit, onAdvance, advancing, onTrail, trailOn }) {
  const [share, setShare] = useState(null); // { tripId }
  const [tab, setTab] = useState('trip');
  const trip = truck.currentTrip || truck.nextTrip;
  const digits = String(truck.phone || '').replace(/\D/g, '');
  return (
    <div className="dd-enter absolute left-3 top-14 z-[5] flex max-h-[calc(100%-120px)] w-[min(380px,calc(100%-24px))] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
      <div className="border-b border-line p-4" style={{ borderTop: `3px solid ${(STATUS[truck.truckStatus] || STATUS.unknown).color}` }}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[15px] font-medium">{truck.companyName}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <StatusChip status={truck.truckStatus} />
              {truck.isCustomer && <Badge color="brand">Customer</Badge>}
              {truck.equipment && <Badge>{label(truck.equipment.split(',')[0])}</Badge>}
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Close"><X className="size-4" /></button>
        </div>
        <dl className="mt-3 grid grid-cols-[76px_1fr] gap-y-1 text-[13px]">
          <dt className="text-muted">Location</dt><dd className="truncate">{truck.location ? (truck.live?.source === 'driver_link' && truck.location.city ? `Near ${placeLabel(truck.location)}` : placeLabel(truck.location) || 'GPS position') : 'Not set'}</dd>
          <dt className="text-muted">Available</dt><dd>{truck.availableAt ? dateTime(truck.availableAt) : '—'}</dd>
          <dt className="text-muted">Local time</dt><dd>{truck.timezone ? <LocalClock timezone={truck.timezone} /> : '—'}</dd>
        </dl>
        <div className="mt-3"><LiveRow truck={truck} /></div>
        <div className="mt-3 flex flex-wrap gap-2">
          {truck.phone && <CallButton variant="button" phone={truck.phone} carrierId={truck.id} label="Call" size="sm" />}
          {digits && <Button size="sm" variant="secondary" icon={MessageSquare} href={`sms:+1${digits.slice(-10)}`}>Text</Button>}
          <Button size="sm" icon={Radio} onClick={() => setShare({})}>{truck.live?.sharing ? 'Live link' : 'Share live location'}</Button>
        </div>
      </div>

      <div className="flex border-b border-line px-2" role="tablist">
        {[['trip', 'Trip'], ['activity', 'Check-ins'], ['more', 'More']].map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cx('-mb-px border-b-2 px-3 py-2 text-[13px] transition-ui', tab === k ? 'border-brand-600 font-medium text-fg' : 'border-transparent text-muted hover:text-fg')}>{l}</button>
        ))}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {tab === 'trip' && (
          <>
            {trip ? <TripLine trip={trip} busy={advancing} onAdvance={onAdvance} /> : <p className="text-sm text-muted">No trip planned for this truck.</p>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={Navigation} onClick={onPlan}>Plan trip</Button>
              {trip && <Button size="sm" variant="secondary" icon={Send} onClick={() => setShare({ tripId: trip.id })}>Send trip to driver</Button>}
            </div>
          </>
        )}
        {tab === 'activity' && <Timeline carrierId={truck.id} />}
        {tab === 'more' && (
          <div className="grid gap-2">
            <Button size="sm" variant="secondary" icon={Pencil} onClick={onEdit}>Update status or location</Button>
            <Button size="sm" variant="secondary" icon={Activity} onClick={onTrail} aria-pressed={trailOn}>{trailOn ? 'Hide' : 'Show'} last 24 h trail</Button>
            <Button size="sm" variant="ghost" icon={StickyNote} to={`/app/carriers/${truck.id}`}>Notes</Button>
            <Button size="sm" variant="ghost" icon={FileText} to={`/app/carriers/${truck.id}`}>Documents</Button>
            <Button size="sm" variant="ghost" icon={ExternalLink} to={`/app/carriers/${truck.id}`}>Carrier profile</Button>
          </div>
        )}
      </div>
      {share && <ShareLocation truck={truck} tripId={share.tripId} onClose={() => setShare(null)} />}
    </div>
  );
}
