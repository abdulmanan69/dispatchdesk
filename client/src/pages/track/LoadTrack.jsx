import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { CheckCircle2, Clock, FileCheck2, FileClock, Loader2, MapPin, Navigation, PauseCircle, Truck, Warehouse } from 'lucide-react';
import { Logo } from '../../components/Logo.jsx';
import { cx } from '../../components/ui.jsx';

/**
 * Public tracking page for the broker or shipper of one load (/t/:token). No login: the secret link is the credential.
 * It shows the load reference, stops and appointment windows, status, the city the truck is near, the ETA (an estimate)
 * and whether the POD is in. It never shows the driver, phone numbers, rates or anything else from the CRM.
 * It refreshes every minute while the tab is visible (unchanged data costs the server a 304).
 */
const REFRESH_MS = 60_000;

const fmtIn = (d, tz, opts) => {
  if (!d) return null;
  try { return new Date(d).toLocaleString([], { ...opts, ...(tz ? { timeZone: tz, timeZoneName: 'short' } : {}) }); } catch { return new Date(d).toLocaleString([], opts); }
};
const when = (d, tz) => fmtIn(d, tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function windowText(w) {
  if (!w?.start) return 'No appointment set';
  const opts = w.tz ? { timeZone: w.tz } : {};
  try {
    const day = new Date(w.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...opts });
    // Only a date was entered for this stop: the day, without a time.
    if (w.dateOnly) return day;
    const t = (d, zone) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...opts, ...(zone ? { timeZoneName: 'short' } : {}) });
    return Math.abs(new Date(w.end) - new Date(w.start)) < 60000 ? `${day}, ${t(w.start, true)}` : `${day}, ${t(w.start)}–${t(w.end, true)}`;
  } catch { return when(w.start); }
}
function ago(d) {
  if (!d) return '';
  const m = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

const TONE = {
  planned: 'bg-c-purple-soft text-c-purple', booked: 'bg-c-blue-soft text-c-blue', in_transit: 'bg-c-blue-soft text-c-blue',
  delivered: 'bg-c-green-soft text-c-green', invoiced: 'bg-c-green-soft text-c-green', paid: 'bg-c-green-soft text-c-green', canceled: 'bg-c-gray-soft text-fg-2',
};

function StopCard({ kind, stop, done, doneLabel, arrivedAt }) {
  const Icon = kind === 'Pickup' ? Warehouse : MapPin;
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl', kind === 'Pickup' ? 'bg-c-blue-soft text-c-blue' : 'bg-c-green-soft text-c-green')}><Icon className="size-5" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted">{kind}</p>
          <p className="text-lg font-medium">{stop.city}, {stop.state}</p>
          <p className="text-sm text-fg-2">{windowText(stop.window)}</p>
          {done ? (
            <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-c-green"><CheckCircle2 className="size-4" aria-hidden />{doneLabel} {when(done, stop.window?.tz)}</p>
          ) : arrivedAt ? (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-fg"><Clock className="size-4" aria-hidden />Arrived {when(arrivedAt, stop.window?.tz)}</p>
          ) : stop.eta ? (
            <p className="mt-1 text-sm text-fg">Estimated arrival {when(stop.legalEta || stop.eta, stop.window?.tz)}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function LoadTrack() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/public/load-track/${encodeURIComponent(token)}`, { headers: { Accept: 'application/json' }, credentials: 'omit' });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError({ gone: res.status === 404 || res.status === 410, message: body?.error || `Could not load this page (${res.status})` }); return; }
      setData(body);
      setError(null);
    } catch {
      setError((e) => e || { gone: false, message: 'No connection. The page will try again.' });
    }
  }, [token]);

  useEffect(() => {
    document.title = 'Load tracking';
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
    const vis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', vis);
    const clock = setInterval(() => tick((n) => n + 1), 30_000);
    return () => { clearInterval(t); clearInterval(clock); document.removeEventListener('visibilitychange', vis); };
  }, [load]);

  if (error?.gone || (error && !data)) {
    return (
      <Shell>
        <div className="rounded-2xl border border-line bg-surface p-6 text-center">
          <PauseCircle className="mx-auto size-10 text-muted" aria-hidden />
          <h1 className="mt-3 text-xl font-medium">{error.gone ? 'This tracking link is not active' : 'Could not load tracking'}</h1>
          <p className="mt-2 text-fg-2">{error.message}</p>
          {!error.gone && <button type="button" onClick={load} className="mt-4 text-sm font-medium text-brand-700 underline dark:text-brand-300">Try again</button>}
        </div>
      </Shell>
    );
  }
  if (!data) return <Shell><div className="flex justify-center py-20"><Loader2 className="size-8 animate-spin text-muted" aria-label="Loading" /></div></Shell>;

  const d = data;
  const done = ['delivered', 'invoiced', 'paid'].includes(d.status);
  return (
    <Shell>
      <section className="space-y-2">
        <p className="text-sm text-muted">Load tracking</p>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-medium leading-tight">{d.reference ? `Load ${d.reference}` : `${d.pickup.city} to ${d.delivery.city}`}</h1>
          <span className={cx('rounded-full px-2.5 py-1 text-xs font-medium', TONE[d.status] || TONE.planned)}>{d.statusLabel}</span>
        </div>
        <p className="text-[15px] text-fg-2">{d.pickup.city}, {d.pickup.state} → {d.delivery.city}, {d.delivery.state}</p>
        {d.lastUpdateAt && <p className="text-sm text-muted">Last update {ago(d.lastUpdateAt)}</p>}
      </section>

      {!done && (d.location || d.progress || d.delivery.eta) && (
        <section className="space-y-3 rounded-2xl border border-line bg-surface p-4">
          {d.location?.text && (
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-c-teal-soft text-c-teal"><Truck className="size-5" aria-hidden /></span>
              <div className="min-w-0">
                <p className="text-lg font-medium">{d.location.text}</p>
                <p className="text-sm text-fg-2">{d.location.source === 'gps' ? 'From the driver\'s phone' : 'Updated by dispatch'} {ago(d.location.at)}</p>
                {d.location.lat != null && (
                  <a href={`https://www.google.com/maps/search/?api=1&query=${d.location.lat},${d.location.lng}`} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"><Navigation className="size-4" aria-hidden />Open in Google Maps</a>
                )}
              </div>
            </div>
          )}
          {d.progress && (
            <div>
              <div className="mb-1 flex justify-between text-sm text-fg-2"><span>{d.progress.pct}% of the way</span><span>{d.progress.remainingMiles > 0 ? `About ${d.progress.remainingMiles.toLocaleString('en-US')} mi to go` : 'Less than 5 mi to go'}</span></div>
              <div className="fleet-progress text-c-blue" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={d.progress.pct} aria-label="Trip progress" style={{ height: 8, borderRadius: 9999, background: 'color-mix(in oklab, currentColor 14%, transparent)', overflow: 'hidden', position: 'relative' }}>
                <span style={{ position: 'absolute', inset: 0, width: `${d.progress.pct}%`, background: 'currentColor', borderRadius: 9999 }} />
              </div>
            </div>
          )}
          {(d.delivery.legalEta || d.delivery.eta) && (
            <p className="text-[15px]"><span className="font-medium">Estimated delivery</span> {when(d.delivery.legalEta || d.delivery.eta, d.delivery.window?.tz)}<span className="block text-xs text-muted">An estimate from the route, recent driving speed and driver rest rules. Not a guarantee.</span></p>
          )}
        </section>
      )}

      <StopCard kind="Pickup" stop={d.pickup} done={d.pickup.departedAt} doneLabel="Loaded" arrivedAt={d.pickup.arrivedAt} />
      <StopCard kind="Delivery" stop={d.delivery} done={d.delivery.deliveredAt} doneLabel="Delivered" arrivedAt={d.delivery.arrivedAt} />

      <section className={cx('flex items-center gap-3 rounded-2xl border p-4', d.pod.received ? 'border-c-green bg-c-green-soft' : 'border-line bg-surface')}>
        {d.pod.received ? <FileCheck2 className="size-6 shrink-0 text-c-green" aria-hidden /> : <FileClock className="size-6 shrink-0 text-muted" aria-hidden />}
        <p className="text-[15px]">{d.pod.received ? <>POD received {when(d.pod.at)}</> : done ? 'Delivered. POD not received yet.' : 'POD after delivery'}</p>
      </section>

      {d.timeline?.length > 0 && (
        <section className="rounded-2xl border border-line bg-surface p-4">
          <h2 className="mb-2 font-medium">Updates</h2>
          <ol className="space-y-2">
            {[...d.timeline].reverse().map((e, i) => (
              <li key={`${e.type}-${e.at}-${i}`} className="flex gap-2.5 text-sm">
                <span className="mt-1.5 size-2 shrink-0 rounded-full bg-c-blue" />
                <span><span className="font-medium">{e.label}</span>{e.place ? ` · ${e.place}` : ''}<span className="block text-xs text-muted">{when(e.at)}</span></span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <p className="pb-6 text-center text-xs text-muted">Refreshes every minute. {d.expiresAt ? `This link works until ${when(d.expiresAt)}.` : ''}</p>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-line bg-surface/95 px-4 backdrop-blur">
        <Logo compact />
        <span className="text-sm text-muted">Shipment status</span>
      </header>
      <main className="mx-auto max-w-md space-y-4 px-4 pt-5">{children}</main>
    </div>
  );
}
