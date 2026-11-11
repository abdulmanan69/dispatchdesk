import { useEffect, useState } from 'react';
import { Clock, LogIn, LogOut, Mail, Ban, Trash2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { money, label } from '../../lib/format.js';
import { Badge, Button, Card, Field, IconButton, Input, Textarea, cx } from '../ui.jsx';
import { useConfirm } from '../Modal.jsx';
import ComposeModal from '../email/ComposeModal.jsx';
import { formatAt, formatWindow } from './zoned.js';

const STOP = {
  pickup: { title: 'Pickup', arrive: 'arrived_pickup', depart: 'departed_pickup', facility: 'pickupFacility', start: 'pickupWindowStart', end: 'pickupWindowEnd', tz: 'pickupTz', city: ['originCity', 'originState'] },
  delivery: { title: 'Delivery', arrive: 'arrived_delivery', depart: 'delivered', facility: 'deliveryFacility', start: 'deliveryWindowStart', end: 'deliveryWindowEnd', tz: 'deliveryTz', city: ['destCity', 'destState'] },
};
const STATE_BADGE = { waiting: ['gray', 'Not arrived'], free_time: ['blue', 'In free time'], detention: ['amber', 'On detention'], departed: ['green', 'Departed'] };
const SOURCE = { driver_link: 'driver check-in', dispatcher: 'entered by dispatcher', system: 'system', broker_link: 'broker link' };

const hm = (hours) => {
  const mins = Math.max(0, Math.round(hours * 60));
  return `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min`;
};
const localInput = (d = new Date()) => {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 16);
};

/** Live view of a stop: re-computes the running clock every 30 seconds from the server's summary. */
function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function StopCard({ kind, load, stop, events, rateCents, onRecord, recording }) {
  const { user } = useAuth();
  const cfg = STOP[kind];
  const [custom, setCustom] = useState(null); // { type, at }
  const now = useNow(stop.running);
  // While the truck is on site, extend the server's figures to the current minute.
  const end = stop.departedAt ? new Date(stop.departedAt).getTime() : stop.running ? now : null;
  const freeEnds = stop.freeEndsAt ? new Date(stop.freeEndsAt).getTime() : null;
  const billable = end != null && freeEnds != null ? Math.max(0, (end - freeEnds) / 3_600_000) : 0;
  const state = stop.running && freeEnds != null && end > freeEnds ? 'detention' : stop.state;
  const [color, text] = STATE_BADGE[state] || STATE_BADGE.waiting;
  const where = [load[cfg.facility], [load[cfg.city[0]], load[cfg.city[1]]].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  const appt = load[cfg.start] ? formatWindow(load[cfg.start], load[cfg.end], load[cfg.tz], user?.timezone) : null;
  const tz = load[cfg.tz] || user?.timezone;
  const removable = events.filter((e) => [cfg.arrive, cfg.depart, ...(kind === 'pickup' ? ['loaded'] : [])].includes(e.type) && e.source === 'dispatcher');
  return (
    <div className="space-y-2.5 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{cfg.title}</p>
          <p className="truncate text-xs text-muted">{where || '—'}</p>
        </div>
        <Badge color={color}>{text}</Badge>
      </div>
      <dl className="grid gap-1.5 text-[13px] sm:grid-cols-2">
        <div><dt className="text-xs text-muted">Appointment</dt><dd>{appt || 'Not set'}</dd></div>
        <div><dt className="text-xs text-muted">Arrived</dt><dd>{stop.arrivedAt ? `${formatAt(stop.arrivedAt, tz)} · ${SOURCE[stop.arrivedSource] || stop.arrivedSource || ''}` : '—'}</dd></div>
        <div><dt className="text-xs text-muted">Free time ends</dt><dd>{stop.freeEndsAt ? formatAt(stop.freeEndsAt, tz) : '—'}</dd></div>
        <div><dt className="text-xs text-muted">Departed</dt><dd>{stop.departedAt ? `${formatAt(stop.departedAt, tz)} · ${SOURCE[stop.departedSource] || stop.departedSource || ''}` : '—'}</dd></div>
      </dl>
      {(state === 'detention' || billable > 0) && (
        <p className={cx('flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px]', stop.running ? 'bg-c-amber-soft' : 'bg-surface-2')}>
          <Clock className="size-4 shrink-0 text-c-amber" aria-hidden />
          Detention {hm(billable)}{rateCents ? ` · ${money(Math.round(billable * rateCents))}` : ' · set a detention rate to see the amount'}{stop.running ? ' and counting' : ''}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!stop.arrivedAt && <Button size="sm" variant="secondary" icon={LogIn} loading={recording === cfg.arrive} onClick={() => onRecord({ type: cfg.arrive })}>Arrived now</Button>}
        {stop.arrivedAt && !stop.departedAt && <Button size="sm" variant="secondary" icon={LogOut} loading={recording === cfg.depart} onClick={() => onRecord({ type: cfg.depart })}>Departed now</Button>}
        <Button size="sm" variant="ghost" onClick={() => setCustom(custom ? null : { type: stop.arrivedAt ? cfg.depart : cfg.arrive, at: localInput() })}>Enter a time</Button>
        {removable.map((e) => (
          <IconButton key={e.id} icon={Trash2} label={`Remove ${label(e.type)} entered ${formatAt(e.at, tz)}`} onClick={() => onRecord({ remove: e.id })} />
        ))}
      </div>
      {custom && (
        <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); onRecord({ type: custom.type, at: new Date(custom.at).toISOString() }); setCustom(null); }}>
          <div className="space-y-1">
            <p className="text-[13px] font-medium" id={`ev-${kind}`}>Event</p>
            <div className="flex gap-1" role="group" aria-labelledby={`ev-${kind}`}>
              {[cfg.arrive, cfg.depart].map((t) => (
                <Button key={t} size="sm" aria-pressed={custom.type === t} variant={custom.type === t ? 'primary' : 'secondary'} onClick={() => setCustom({ ...custom, type: t })}>{t === cfg.arrive ? 'Arrived' : 'Departed'}</Button>
              ))}
            </div>
          </div>
          <Field label="Time (your time)"><Input type="datetime-local" value={custom.at} onChange={(e) => setCustom({ ...custom, at: e.target.value })} required /></Field>
          <Button type="submit" size="md">Save time</Button>
        </form>
      )}
    </div>
  );
}

/** Detention notice text for the broker, with times in the facility's zone. */
export function detentionNotice(load, stop, cfg, rateCents, tz) {
  const ref = load.referenceNumber ? `load ${load.referenceNumber}` : `the ${load.originCity} → ${load.destCity} load`;
  const facility = load[cfg.facility] || `the ${cfg.title.toLowerCase()}`;
  const lines = [
    'Hi {{first_name}},',
    '',
    `Our truck on ${ref} arrived at ${facility} at ${formatAt(stop.arrivedAt, tz)}${load[cfg.start] ? ` for the ${formatAt(load[cfg.start], tz)} appointment` : ''}.`,
    `Free time (${load.freeTimeHours ?? 2} h) ${new Date(stop.freeEndsAt) <= new Date() ? 'ended' : 'ends'} at ${formatAt(stop.freeEndsAt, tz)}${rateCents ? `, and detention of ${money(rateCents)}/h applies after that per the rate confirmation` : ''}.`,
    stop.departedAt ? `The truck departed at ${formatAt(stop.departedAt, tz)}.` : 'The truck is still on site; I will send the out time when it leaves.',
    '',
    'Please confirm, and let me know if the facility shows different times.',
  ];
  return lines.join('\n');
}

/** Stop times, the detention clock, the broker notice and TONU for one load. */
export default function DetentionPanel({ load, detention, events, onChanged }) {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [notice, setNotice] = useState(null);
  const [tonu, setTonu] = useState({ amount: load.tonuCents ? String(load.tonuCents / 100) : '', note: '' });
  const inv = [['load', load.id], ['loads']];
  const record = useApiMutation(
    (v) => (v.remove ? api.del(`/api/loads/${load.id}/events/${v.remove}`) : api.post(`/api/loads/${load.id}/events`, { type: v.type, at: v.at })),
    { success: (d, v) => (v.remove ? 'Time removed' : 'Time recorded'), invalidate: inv, onSuccess: onChanged },
  );
  const apply = useApiMutation(() => api.post(`/api/loads/${load.id}/detention/apply`, {}), { success: (d) => `Detention set to ${d.detention.billableHours} h on the load`, invalidate: inv, onSuccess: onChanged });
  const saveTonu = useApiMutation((body) => api.post(`/api/loads/${load.id}/tonu`, body), { success: 'TONU recorded and the load canceled', invalidate: [...inv, ['fleet']], onSuccess: onChanged });
  const rate = load.detentionRateCents || 0;
  const recording = record.isPending ? record.variables?.type : null;

  const openNotice = (kind) => {
    const stop = detention.stops.find((s) => s.kind === kind);
    const cfg = STOP[kind];
    setNotice({
      subject: `Detention notice · ${load.referenceNumber ? `load ${load.referenceNumber}` : `${load.originCity} → ${load.destCity}`}`,
      body: detentionNotice(load, stop, cfg, rate, load[cfg.tz] || user?.timezone),
    });
  };
  const noticeable = detention.stops.filter((s) => s.arrivedAt && s.freeEndsAt && (s.state === 'detention' || s.billableHours > 0 || (s.running && new Date(s.freeEndsAt) <= new Date())));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-2">
        {detention.stops.map((s) => (
          <StopCard key={s.kind} kind={s.kind} load={load} stop={s} events={events} rateCents={rate} onRecord={(v) => record.mutate(v)} recording={recording} />
        ))}
      </div>
      <Card title="Detention" bodyClass="space-y-3 p-4">
        <p className="text-sm">
          Free time {load.freeTimeHours ?? 2} h per stop{rate ? ` · ${money(rate)}/h` : ' · no detention rate on the load yet'}.
          {' '}Recorded so far: <span className="font-medium tabular">{hm(detention.billableHours)}</span>{rate ? <> · <span className="font-medium tabular">{money(detention.amountCents)}</span></> : null}.
        </p>
        <p className="text-xs text-muted">Times come from driver check-ins and the times entered here. The clock starts at the appointment when the truck arrives early.</p>
        <div className="flex flex-wrap gap-2">
          {noticeable.map((s) => (
            <Button key={s.kind} size="sm" icon={Mail} variant="secondary" disabled={!load.broker} onClick={() => openNotice(s.kind)}>Detention notice for {s.kind}</Button>
          ))}
          <Button size="sm" variant="secondary" loading={apply.isPending} disabled={!detention.billableHours} onClick={() => apply.mutate()}>Put {detention.billableHours} h on the load</Button>
        </div>
        {!load.broker && noticeable.length > 0 && <p className="text-xs text-muted">Add the broker to the load to email a notice.</p>}
      </Card>
      <Card title="Truck ordered, not used (TONU)" bodyClass="space-y-3 p-4">
        {load.tonuCents > 0 && <p className="text-sm">TONU recorded: <span className="font-medium">{money(load.tonuCents)}</span>{load.status === 'canceled' ? ' · load canceled' : ''}. Bill it from Invoices.</p>}
        <form className="grid gap-3 sm:grid-cols-[160px_1fr_auto] sm:items-end" onSubmit={async (e) => {
          e.preventDefault();
          if (load.status !== 'canceled' && !(await confirm({ title: 'Record TONU?', message: 'This marks the load canceled and records the TONU amount and your note as evidence.', confirmLabel: 'Record TONU' }))) return;
          saveTonu.mutate({ tonuCents: Math.round(Number(tonu.amount || 0) * 100), note: tonu.note || null });
        }}>
          <Field label="TONU amount ($)"><Input type="number" min="0" step="0.01" value={tonu.amount} onChange={(e) => setTonu({ ...tonu, amount: e.target.value })} required /></Field>
          <Field label="Evidence note" hint="Who canceled, when the truck was dispatched or on site, what the broker agreed. Attach emails or photos under Documents.">
            <Textarea rows={2} value={tonu.note} onChange={(e) => setTonu({ ...tonu, note: e.target.value })} maxLength={2000} />
          </Field>
          <Button type="submit" variant="secondary" icon={Ban} loading={saveTonu.isPending}>Record TONU</Button>
        </form>
      </Card>
      <ComposeModal open={!!notice} onClose={() => setNotice(null)} brokerId={load.broker?.id} loadId={load.id} toEmail={load.broker?.email || ''}
        subject={notice?.subject} body={notice?.body} templateCategory="broker" onSent={() => onChanged?.()} />
    </div>
  );
}
