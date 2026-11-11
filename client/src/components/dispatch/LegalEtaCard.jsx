import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Clock3, Gauge } from 'lucide-react';
import { api } from '../../lib/api.js';
import { num } from '../../lib/format.js';
import { Badge, Button, Input, cx } from '../ui.jsx';
import { hoursText, parseHours } from '../fleet/fleetApi.js';
import { formatAt } from './zoned.js';

/** Verdict of the legal ETA against the delivery appointment: badge color and words. */
export const VERDICT = {
  on_time: { label: 'On time', color: 'green', tone: 'text-c-green' },
  at_risk: { label: 'At risk', color: 'amber', tone: 'text-c-amber' },
  late: { label: 'Late', color: 'red', tone: 'text-c-red' },
  no_window: { label: 'No appointment', color: 'gray', tone: '' },
};

const LIMIT_MIN = { drive: 660, duty: 840, cycle: 4200 };

/**
 * Hours-left inputs ({ drive, duty, cycle } as typed: "6:30" or "6.5") as the API's hoursLeft (hours), with an error
 * message when something is unreadable or above the 11 / 14 / 70 hour limits. hoursLeft is null when nothing is typed.
 */
export function hoursLeftFrom(values = {}) {
  const mins = Object.fromEntries(Object.keys(LIMIT_MIN).map((k) => [k, parseHours(values[k])]));
  if (Object.values(mins).some((m) => Number.isNaN(m))) return { hoursLeft: null, error: 'Write hours as 6:30 or 6.5' };
  if (Object.entries(mins).some(([k, m]) => m != null && m > LIMIT_MIN[k])) return { hoursLeft: null, error: 'At most 11, 14 and 70 hours' };
  const typed = Object.entries(mins).filter(([, m]) => m != null);
  if (!typed.length) return { hoursLeft: null, error: null };
  return { hoursLeft: Object.fromEntries(typed.map(([k, m]) => [k, Math.round((m / 60) * 1000) / 1000])), error: null };
}

const WINDOW_KEYS = ['pickupWindowStart', 'pickupWindowEnd', 'deliveryWindowStart', 'deliveryWindowEnd'];
const placeReady = (p) => !!p && /^[A-Z]{2}$/.test(p.state || '') && (p.lat != null || !!String(p.city || '').trim());
const placeBody = (p) => {
  const out = { city: String(p.city || '').trim() || null, state: p.state };
  if (p.lat != null && p.lng != null) Object.assign(out, { lat: p.lat, lng: p.lng });
  return out;
};

/**
 * Request body for POST /api/plan-eta, or null until the pickup and delivery are known.
 * Appointment times may be ISO instants or facility-local wall times ("2026-11-12T08:00"); a window key present but
 * empty is sent as null so the server does not fall back to the saved load's value.
 */
export function planEtaBody(input, hoursLeft = null) {
  if (!input || !placeReady(input.origin) || !placeReady(input.dest)) return null;
  const body = { origin: placeBody(input.origin), dest: placeBody(input.dest) };
  for (const k of ['carrierId', 'loadId', 'startAt', 'dwellHours']) if (input[k] != null && input[k] !== '') body[k] = input[k];
  for (const k of WINDOW_KEYS) if (k in input) body[k] = input[k] || null;
  const from = input.deadhead?.from;
  if (from?.lat != null && from?.lng != null) body.deadhead = { from: { lat: from.lat, lng: from.lng } };
  if (hoursLeft) body.hoursLeft = hoursLeft;
  return body;
}

/** "452 mi · 6 h 50 min driving · 1 break · 1 reset · road route" */
export function summaryLine(d) {
  const parts = [`${num(d.miles)} mi`, `${hoursText(d.minutes)} driving`];
  if (d.breaks) parts.push(`${d.breaks} break${d.breaks === 1 ? '' : 's'}`);
  if (d.resets) parts.push(`${d.resets} 10 h reset${d.resets === 1 ? '' : 's'}`);
  if (d.restarts) parts.push('34 h restart');
  parts.push(d.routeSource === 'osrm' ? 'road route' : 'straight-line estimate');
  return parts.join(' · ');
}

const HOURS_NOTE = { entered: 'Hours left as entered', report: 'Hours from the latest report', assumed: 'Full hours assumed' };

/** A value that follows `value` once it has stopped changing for `ms`. */
export function useDebounced(value, ms = 500) {
  const [v, setV] = useState(value);
  useEffect(() => {
    if (v === value) return undefined;
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, v, ms]);
  return v;
}

function HoursLeftInputs({ values, onChange, error }) {
  const on = (k) => (e) => onChange({ ...values, [k]: e.target.value });
  // Enter here must not submit the surrounding load or trip form.
  const noSubmit = (e) => { if (e.key === 'Enter') e.preventDefault(); };
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-3 gap-2">
        {[['drive', 'Drive', '11'], ['duty', 'Duty', '14'], ['cycle', 'Cycle', '70']].map(([k, l, ph]) => (
          <label key={k} className="space-y-1 text-[11px] text-muted">{l}
            <Input inputMode="decimal" className="h-8" value={values[k]} onChange={on(k)} onKeyDown={noSubmit} placeholder={ph} aria-label={`${l} hours left`} />
          </label>
        ))}
      </div>
      {error ? <p className="text-xs text-c-red">{error}</p> : <p className="text-[11px] text-muted">Hours left on the driver’s clocks, as 6:30 or 6.5. Blank means full hours.</p>}
    </div>
  );
}

/**
 * Legal ETA card: can the driver legally make the delivery appointment? Drive ETA versus the ETA with the required
 * 30-minute breaks, 10-hour resets and the hours the driver has left, in the delivery facility's time zone.
 * `input`: { origin, dest, carrierId?, loadId?, startAt?, pickupWindowStart/End?, deliveryWindowStart/End?, deadhead? }.
 * Requests are debounced (500 ms) and cached by their inputs. Informational only: it never blocks saving.
 */
export default function LegalEtaCard({ input, className }) {
  const [hoursOpen, setHoursOpen] = useState(false);
  const [hours, setHours] = useState({ drive: '', duty: '', cycle: '' });
  const { hoursLeft, error } = useMemo(() => hoursLeftFrom(hours), [hours]);
  const key = useMemo(() => {
    const body = planEtaBody(input, hoursLeft);
    return body ? JSON.stringify(body) : '';
  }, [input, hoursLeft]);
  const debounced = useDebounced(key, 500);
  const q = useQuery({
    queryKey: ['plan-eta', debounced],
    queryFn: ({ signal }) => api.post('/api/plan-eta', JSON.parse(debounced), { signal }),
    enabled: !!debounced,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const d = key ? q.data : null;
  const v = d ? VERDICT[d.verdict] || VERDICT.no_window : null;
  const pv = d?.pickup ? VERDICT[d.pickup.verdict] : null;
  const busy = !!key && (key !== debounced || q.isFetching);

  return (
    <section className={cx('space-y-2 text-sm', className)} aria-label="Legal ETA" aria-busy={busy || undefined}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium"><Clock3 className="size-4 text-c-blue" aria-hidden />Legal ETA</h3>
        {v && <Badge color={v.color}>{v.label}</Badge>}
      </div>
      {!key ? (
        <p className="text-xs text-muted">Set the pickup and delivery to check the hours of service.</p>
      ) : !d ? (
        <p className="text-xs text-muted">{q.isError ? `Could not check the legal ETA: ${q.error.message}` : 'Checking hours of service…'}</p>
      ) : (
        <div className={cx('space-y-2 transition-opacity', busy && 'opacity-60')}>
          <dl className="grid grid-cols-2 gap-2">
            <div className="min-w-0 rounded-md bg-surface-2/60 px-2.5 py-1.5">
              <dt className="text-[11.5px] text-muted">Drive ETA</dt>
              <dd className="tabular text-[13px] font-medium">{formatAt(d.driveEta, d.deliveryTz)}</dd>
            </div>
            <div className="min-w-0 rounded-md bg-surface-2/60 px-2.5 py-1.5">
              <dt className="text-[11.5px] text-muted">Legal ETA</dt>
              <dd className={cx('tabular text-[13px] font-medium', v.tone)}>{formatAt(d.legalEta, d.deliveryTz)}</dd>
            </div>
          </dl>
          <p className="text-[11.5px] text-muted">{summaryLine(d)}</p>
          {d.pickup && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-fg-2">
              Pickup after about {num(d.pickup.miles)} mi deadhead: {formatAt(d.pickup.legalEta, d.pickupTz)}
              {pv && <Badge color={pv.color}>{pv.label}</Badge>}
            </p>
          )}
          <p className="text-[13px] text-fg-2">{d.explanation}</p>
          {d.assumptions?.length > 0 && (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer select-none">How this is worked out</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">{d.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
            </details>
          )}
        </div>
      )}
      <div className="border-t border-line pt-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs text-fg-2"><Gauge className="size-3.5 text-c-purple" aria-hidden />{hoursLeft ? HOURS_NOTE.entered : HOURS_NOTE[d?.hours?.source] || HOURS_NOTE.assumed}</span>
          <Button size="sm" variant="ghost" aria-expanded={hoursOpen} onClick={() => setHoursOpen((o) => !o)}>{hoursOpen ? 'Hide hours' : 'Hours left'}</Button>
        </div>
        {hoursOpen && <HoursLeftInputs values={hours} onChange={setHours} error={error} />}
      </div>
    </section>
  );
}
