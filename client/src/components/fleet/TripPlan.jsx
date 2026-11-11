import { useState } from 'react';
import { AlertTriangle, Clock, Gauge, MapPin, PhoneCall, Timer, Warehouse } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { relative } from '../../lib/format.js';
import { Badge, Button, Input, cx } from '../ui.jsx';
import { RISK, timeIn, windowText, hoursText, parseHours, hoursInput } from './fleetApi.js';

const VIA = { gps: 'GPS', check_call: 'check call', event: 'driver update', none: 'no contact yet' };

/** Progress bar, remaining miles and both ETAs for the trip under way. */
function Progress({ trip, stop, plan }) {
  const p = trip.progress;
  return (
    <div className="space-y-2 rounded-lg border border-line px-3 py-2.5 text-[13px]">
      {p?.pct != null && (
        <>
          <div className="flex items-center justify-between text-xs text-fg-2">
            <span>{p.doneMiles != null ? `${p.doneMiles.toLocaleString('en-US')} mi driven` : ''}</span>
            <span className="font-medium text-fg">{p.remainingMiles.toLocaleString('en-US')} mi to go</span>
          </div>
          <div className="fleet-progress text-c-blue" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.pct} aria-label="Trip progress"><span style={{ width: `${p.pct}%` }} /></div>
        </>
      )}
      {p?.pct == null && p?.remainingMiles != null && <p className="text-xs text-fg-2">About {p.remainingMiles.toLocaleString('en-US')} mi to go (straight-line estimate)</p>}
      {p?.offRoute && <p className="flex items-center gap-1.5 text-xs font-medium text-c-red"><AlertTriangle className="size-3.5" aria-hidden />{p.offRouteMiles} mi off the planned route</p>}
      {stop && (
        <dl className="grid grid-cols-[96px_1fr] gap-y-1 text-[12.5px]">
          <dt className="text-muted">Drive ETA</dt>
          <dd>{stop.eta ? timeIn(stop.eta, stop.window?.tz) : '—'}</dd>
          <dt className="text-muted">Legal ETA</dt>
          <dd>
            {stop.legalEta ? timeIn(stop.legalEta, stop.window?.tz) : '—'}
            {plan.legal && (plan.legal.breaks || plan.legal.rests || plan.legal.restarts) ? (
              <span className="block text-[11px] text-muted">
                {[plan.legal.breaks && `${plan.legal.breaks} × 30 min break`, plan.legal.rests && `${plan.legal.rests} × 10 h rest`, plan.legal.restarts && '34 h restart'].filter(Boolean).join(' · ')}
              </span>
            ) : null}
          </dd>
        </dl>
      )}
      <p className="text-[11px] text-muted">
        {trip.estimate ? 'No road route: straight-line estimate. ' : ''}
        {plan.pace?.mph ? `Recent pace ${Math.round(plan.pace.mph)} mph. ` : ''}
        {plan.hos?.assumed ? (plan.hos.stale ? 'Hours left are more than 10 h old; the legal ETA assumes full hours. ' : 'Legal ETA assumes full hours; enter hours left for a better estimate. ') : ''}
        Planning estimate, not a log.
      </p>
    </div>
  );
}

function Stops({ stops, dwell }) {
  if (!stops?.length) return null;
  return (
    <ol className="space-y-2">
      {stops.map((s) => {
        const risk = s.risk ? RISK[s.risk] : null;
        const d = dwell.find((x) => x.loadId === s.loadId && x.stop === s.kind);
        const Icon = s.kind === 'pickup' ? Warehouse : MapPin;
        return (
          <li key={`${s.loadId}-${s.kind}`} className="flex gap-2.5 rounded-lg border border-line px-3 py-2 text-[12.5px]">
            <span className={cx('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg', s.kind === 'pickup' ? 'bg-c-blue-soft text-c-blue' : 'bg-c-green-soft text-c-green')}><Icon className="size-3.5" aria-hidden /></span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{s.kind === 'pickup' ? 'Pickup' : 'Delivery'} · {s.city}, {s.state}</span>
                {risk && <Badge color={risk.color}>{risk.label}</Badge>}
              </div>
              <div className="text-muted">{windowText(s.window)}</div>
              {(s.legalEta || s.eta) && <div className="text-fg-2">ETA {timeIn(s.legalEta || s.eta, s.window?.tz)}</div>}
              {d && (
                <div className={cx('mt-0.5 flex items-center gap-1', d.running ? 'text-c-red' : 'text-fg-2')}>
                  <Timer className="size-3.5" aria-hidden />
                  {d.running ? `Detention running ${hoursText(d.detentionMin)} (free time ${hoursText(d.freeMin)})` : `At the dock ${hoursText(d.dwellMin)}; detention starts in ${hoursText(Math.max(0, d.freeMin - d.dwellMin))}`}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Hours left on the driver's 11/14/70 clocks, with a small inline form. */
function HoursLeft({ tripId, report }) {
  const [editing, setEditing] = useState(false);
  const input = report?.input || {};
  const [v, setV] = useState({ drive: hoursInput(input.driveLeftMin), shift: hoursInput(input.shiftLeftMin), cycle: hoursInput(input.cycleLeftMin) });
  const [error, setError] = useState(null);
  const save = useApiMutation((body) => api.post(`/api/fleet/trips/${tripId}/hos`, body), {
    success: 'Hours left saved', invalidate: [['fleet'], ['today']], onSuccess: () => setEditing(false),
  });
  const submit = (e) => {
    e.preventDefault();
    const body = { driveLeftMin: parseHours(v.drive), shiftLeftMin: parseHours(v.shift), cycleLeftMin: parseHours(v.cycle) };
    if (Object.values(body).some((x) => Number.isNaN(x))) { setError('Write hours as 6:30 or 6.5'); return; }
    if (Object.values(body).every((x) => x == null)) { setError('Enter at least one'); return; }
    if ((body.driveLeftMin ?? 0) > 660 || (body.shiftLeftMin ?? 0) > 840 || (body.cycleLeftMin ?? 0) > 4200) { setError('At most 11, 14 and 70 hours'); return; }
    setError(null);
    save.mutate(body);
  };
  return (
    <div className="rounded-lg border border-line px-3 py-2 text-[12.5px]">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium"><Gauge className="size-3.5 text-c-purple" aria-hidden />Hours left</span>
        {!editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>{report ? 'Update' : 'Enter'}</Button>}
      </div>
      {!editing && (report ? (
        <p className="mt-0.5 text-fg-2">
          Drive {hoursText(input.driveLeftMin)} · shift {hoursText(input.shiftLeftMin)} · cycle {hoursText(input.cycleLeftMin)}
          <span className="block text-[11px] text-muted">{report.source === 'driver_link' ? 'From the driver' : 'From dispatch'} {relative(report.at)}</span>
        </p>
      ) : <p className="mt-0.5 text-muted">Not entered. Ask the driver for the hours left on the 11, 14 and 70 hour clocks.</p>)}
      {editing && (
        <form onSubmit={submit} className="mt-2 space-y-2">
          <div className="grid grid-cols-3 gap-2">
            {[['drive', 'Drive'], ['shift', 'Shift'], ['cycle', 'Cycle']].map(([k, l]) => (
              <label key={k} className="space-y-1 text-[11px] text-muted">{l}
                <Input inputMode="decimal" className="h-8" value={v[k]} onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))} placeholder={k === 'cycle' ? '42' : '6:30'} aria-label={`${l} hours left`} />
              </label>
            ))}
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" type="submit" loading={save.isPending}>Save</Button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * Plan for the selected truck: progress on the road route, ETA and legal ETA, the next stops with appointment windows and
 * on-time risk, hours left, check-call status and time at the dock.
 */
export default function TripPlan({ data, onCheckCall }) {
  const plan = data?.plan;
  if (!plan) return null;
  const current = plan.trips.find((t) => t.status === 'in_transit') || null;
  const firstStop = current ? plan.stops.find((s) => s.loadId === current.id) : null;
  const cc = data.checkCall;
  const tripId = current?.id || plan.trips[0]?.id;
  return (
    <div className="space-y-3">
      {current && <Progress trip={current} stop={firstStop} plan={plan} />}
      {cc && (
        <div className={cx('flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[12.5px]', cc.due ? 'border-c-amber/40 bg-c-amber-soft' : 'border-line')}>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 font-medium"><Clock className="size-3.5" aria-hidden />{cc.due ? 'Check call due' : 'Last contact'}</span>
            <span className="text-fg-2">{cc.lastContactAt ? `${relative(cc.lastContactAt)} by ${VIA[cc.via] || cc.via}` : 'No contact yet'}{cc.enabled ? ` · reminder every ${cc.everyHours} h` : ''}</span>
          </span>
          <Button size="sm" variant={cc.due ? 'primary' : 'secondary'} icon={PhoneCall} onClick={onCheckCall}>Log check call</Button>
        </div>
      )}
      <Stops stops={plan.stops} dwell={data.dwell || []} />
      {tripId && <HoursLeft key={data.hosReport?.at || 'none'} tripId={tripId} report={data.hosReport} />}
    </div>
  );
}
