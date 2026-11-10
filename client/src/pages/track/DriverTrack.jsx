import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { AlertTriangle, CheckCircle2, Loader2, MapPin, Navigation, PackageCheck, PauseCircle, Radio, ShieldCheck, Truck, Warehouse } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Logo } from '../../components/Logo.jsx';
import { cx } from '../../components/ui.jsx';

/**
 * Public driver page for a live-location link. No login: the secret token in the URL is the credential.
 * Location is sent only after the driver agrees, only while this page is open, and stops at any time.
 */
const SEND_EVERY_MS = 30_000;
const SEND_IF_MOVED_M = 200;

function metersBetween(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
const fmtDate = (d) => (d ? new Date(d).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null);
const ago = (d) => {
  if (!d) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 1000));
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
};

function navLinks(stop) {
  const q = stop.lat != null ? `${stop.lat},${stop.lng}` : `${stop.city}, ${stop.state}`;
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}&travelmode=driving`,
    apple: `https://maps.apple.com/?daddr=${encodeURIComponent(q)}&dirflg=d`,
  };
}

function BigButton({ children, className, ...props }) {
  return (
    <button type="button" className={cx('flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl px-4 text-base font-medium transition-ui active:scale-[0.99] disabled:opacity-50', className)} {...props}>
      {children}
    </button>
  );
}

function Stop({ kind, stop }) {
  const links = navLinks(stop);
  const Icon = kind === 'Pickup' ? Warehouse : MapPin;
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl', kind === 'Pickup' ? 'bg-c-blue-soft text-c-blue' : 'bg-c-green-soft text-c-green')}><Icon className="size-5" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{kind}</p>
          <p className="text-lg font-medium">{stop.city}, {stop.state}</p>
          {stop.date && <p className="text-sm text-fg-2">{fmtDate(stop.date)}</p>}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <a href={links.google} target="_blank" rel="noopener noreferrer" className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-line-strong text-sm font-medium hover:bg-surface-2"><Navigation className="size-4" aria-hidden />Google Maps</a>
        <a href={links.apple} target="_blank" rel="noopener noreferrer" className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-line-strong text-sm font-medium hover:bg-surface-2"><Navigation className="size-4" aria-hidden />Apple Maps</a>
      </div>
    </div>
  );
}

export default function DriverTrack() {
  const { token } = useParams();
  const base = `/api/public/track/${encodeURIComponent(token)}`;
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null); // { gone, message }
  const [sharing, setSharing] = useState(false);
  const [geoError, setGeoError] = useState(null);
  const [last, setLast] = useState(null); // { at, accuracy }
  const [pending, setPending] = useState(false); // a fix is queued while offline
  const [, tick] = useState(0);
  const [busy, setBusy] = useState(null);
  const [done, setDone] = useState({});
  const [note, setNote] = useState('');
  const [issueOpen, setIssueOpen] = useState(false);
  const [wakeOn, setWakeOn] = useState(false);
  const watchId = useRef(null);
  const lastSent = useRef(null); // { lat, lng, t }
  const queued = useRef(null);
  const wakeLock = useRef(null);

  const load = useCallback(async () => {
    try {
      setInfo(await api.get(base));
      setError(null);
    } catch (e) {
      setError({ gone: e.status === 410, message: e.message });
    }
  }, [base]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 15000); return () => clearInterval(t); }, []);

  const send = useCallback(async (fix) => {
    try {
      const r = await api.post(`${base}/ping`, fix);
      lastSent.current = { lat: fix.lat, lng: fix.lng, t: Date.now() };
      queued.current = null;
      setPending(false);
      setLast({ at: r.at, accuracy: fix.accuracy });
    } catch (e) {
      if (e.status === 410) { stopWatching(); setError({ gone: true, message: e.message }); return; }
      if (e.status === 429) return; // too soon; the next fix goes through
      queued.current = fix; // offline or server unreachable: keep the latest fix and retry
      setPending(true);
    }
  }, [base]); // eslint-disable-line react-hooks/exhaustive-deps

  // Retry a queued fix when the connection comes back, and every 30 s while waiting.
  useEffect(() => {
    const retry = () => { if (queued.current) send(queued.current); };
    window.addEventListener('online', retry);
    const t = setInterval(retry, SEND_EVERY_MS);
    return () => { window.removeEventListener('online', retry); clearInterval(t); };
  }, [send]);

  const onFix = useCallback((pos) => {
    const fix = {
      lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null,
      speed: pos.coords.speed != null && pos.coords.speed >= 0 ? pos.coords.speed : null,
      heading: pos.coords.heading != null && !Number.isNaN(pos.coords.heading) ? pos.coords.heading : null,
    };
    setGeoError(null);
    const prev = lastSent.current;
    const due = !prev || Date.now() - prev.t >= SEND_EVERY_MS || metersBetween(prev, fix) >= SEND_IF_MOVED_M;
    if (due) send(fix);
    else queued.current = queued.current && fix; // keep only if already waiting on a retry
  }, [send]);

  const keepAwake = async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLock.current = await navigator.wakeLock.request('screen');
        setWakeOn(true);
        wakeLock.current.addEventListener('release', () => setWakeOn(false));
      }
    } catch { setWakeOn(false); }
  };
  // The browser releases the wake lock when the page is hidden; take it again when the driver comes back.
  useEffect(() => {
    const vis = () => { if (document.visibilityState === 'visible' && sharing) keepAwake(); };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, [sharing]);

  function stopWatching() {
    if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    wakeLock.current?.release?.().catch(() => {});
    setSharing(false);
  }
  useEffect(() => () => stopWatching(), []);

  const start = async () => {
    if (!('geolocation' in navigator)) { setGeoError('This browser cannot share location. Try Chrome or Safari on your phone.'); return; }
    setBusy('start');
    try {
      if (!info.consentAt) await api.post(`${base}/consent`);
      lastSent.current = null;
      watchId.current = navigator.geolocation.watchPosition(onFix, (err) => {
        setGeoError(err.code === 1 ? 'Location permission is blocked. Allow location for this site in your browser settings, then tap Start again.' : 'Could not get your location yet. Make sure location is on.');
        if (err.code === 1) stopWatching();
      }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
      setSharing(true);
      keepAwake();
      await load();
    } catch (e) {
      if (e.status === 410) setError({ gone: true, message: e.message });
      else setGeoError(e.message);
    } finally { setBusy(null); }
  };

  const stop = async () => {
    stopWatching();
    try { await api.post(`${base}/stop`); } catch { /* the link may have just expired */ }
    load();
  };

  const checkin = async (event) => {
    setBusy(event);
    try {
      const r = await api.post(`${base}/checkin`, { event, note: event === 'issue' ? note : undefined });
      setDone((d) => ({ ...d, [event]: new Date() }));
      if (event === 'issue') { setNote(''); setIssueOpen(false); }
      if (r.tripStatus) setInfo((i) => (i?.trip ? { ...i, trip: { ...i.trip, status: r.tripStatus } } : i));
    } catch (e) {
      if (e.status === 410) setError({ gone: true, message: e.message });
      else setGeoError(e.message);
    } finally { setBusy(null); }
  };

  if (error) {
    return (
      <Shell>
        <div className="rounded-2xl border border-line bg-surface p-6 text-center">
          <PauseCircle className="mx-auto size-10 text-muted" aria-hidden />
          <h1 className="mt-3 text-xl font-medium">{error.gone ? 'This link is no longer active' : 'Could not open this link'}</h1>
          <p className="mt-2 text-fg-2">{error.message}</p>
          {!error.gone && <button type="button" onClick={load} className="mt-4 text-sm font-medium text-brand-700 underline dark:text-brand-300">Try again</button>}
        </div>
      </Shell>
    );
  }
  if (!info) return <Shell><div className="flex justify-center py-20"><Loader2 className="size-8 animate-spin text-muted" aria-label="Loading" /></div></Shell>;

  const trip = info.trip;
  const expires = fmtDate(info.expiresAt);
  const tripDone = trip?.status === 'delivered';

  return (
    <Shell company={info.company}>
      <section className="space-y-1">
        <p className="text-sm text-muted">{info.driverName ? `Hi ${info.driverName}` : 'Hi'}</p>
        <h1 className="text-2xl font-medium leading-tight">{info.dispatcher} at {info.company} dispatch</h1>
      </section>

      {/* Sharing */}
      <section className={cx('rounded-2xl border p-4', sharing ? 'border-c-green bg-c-green-soft' : 'border-line bg-surface')}>
        {sharing ? (
          <>
            <div className="flex items-center gap-3">
              <span className="relative flex size-10 items-center justify-center rounded-full bg-c-green text-white">
                <span className="absolute inset-0 animate-ping rounded-full bg-c-green opacity-40" aria-hidden />
                <Radio className="relative size-5" aria-hidden />
              </span>
              <div>
                <p className="text-lg font-medium">Sharing your location</p>
                <p className="text-sm text-fg-2">
                  {pending ? 'No signal. Your latest location will be sent when you are back online.'
                    : last ? `Last sent ${fmtTime(last.at)} · ${ago(last.at)}${last.accuracy ? ` · within ${Math.round(last.accuracy)} m` : ''}` : 'Finding your location…'}
                </p>
              </div>
            </div>
            <p className="mt-3 rounded-xl bg-surface/70 px-3 py-2 text-sm text-fg-2">Keep this page open. Your phone stops sending when the page is closed or the screen turns off{wakeOn ? '; the screen is being kept on for you' : ''}.</p>
            <BigButton className="mt-3 border border-line-strong bg-surface text-fg" onClick={stop}><PauseCircle className="size-5" aria-hidden />Stop sharing</BigButton>
          </>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 size-6 shrink-0 text-c-green" aria-hidden />
              <p className="text-[15px] leading-relaxed text-fg-2">
                <span className="font-medium text-fg">{info.company}</span> will see your location while this page is open{expires ? <>, until <span className="font-medium text-fg">{expires}</span></> : ''}. Stop anytime.
              </p>
            </div>
            <BigButton className="mt-4 bg-brand-600 text-white hover:bg-brand-700" disabled={busy === 'start'} onClick={start}>
              {busy === 'start' ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Radio className="size-5" aria-hidden />}
              {info.consentAt ? 'Start sharing again' : 'Start sharing my location'}
            </BigButton>
          </>
        )}
        {geoError && <p className="mt-3 flex items-start gap-2 text-sm text-red-700 dark:text-red-300"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{geoError}</p>}
      </section>

      {/* Trip */}
      {trip ? (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Your trip</h2>
            <span className={cx('rounded-full px-2.5 py-1 text-xs font-medium', tripDone ? 'bg-c-green-soft text-c-green' : trip.status === 'in_transit' ? 'bg-c-blue-soft text-c-blue' : 'bg-c-purple-soft text-c-purple')}>
              {tripDone ? 'Delivered' : trip.status === 'in_transit' ? 'In transit' : trip.status === 'booked' ? 'Booked' : 'Planned'}
            </span>
          </div>
          {(trip.referenceNumber || trip.commodity) && <p className="text-sm text-muted">{[trip.referenceNumber && `Ref ${trip.referenceNumber}`, trip.commodity].filter(Boolean).join(' · ')}</p>}
          <Stop kind="Pickup" stop={trip.pickup} />
          <Stop kind="Delivery" stop={trip.delivery} />

          <h2 className="pt-2 text-lg font-medium">Check in</h2>
          <div className="grid grid-cols-2 gap-2">
            {[['arrived_pickup', 'Arrived at pickup', Warehouse], ['loaded', 'Loaded', Truck], ['arrived_delivery', 'Arrived at delivery', MapPin], ['delivered', 'Delivered', PackageCheck]].map(([key, text, Icon]) => (
              <BigButton key={key} disabled={!!busy || tripDone && key !== 'delivered'} onClick={() => checkin(key)}
                className={cx('flex-col gap-1 border py-3 text-sm', done[key] ? 'border-c-green bg-c-green-soft text-fg' : 'border-line-strong bg-surface text-fg hover:bg-surface-2')}>
                {busy === key ? <Loader2 className="size-5 animate-spin" aria-hidden /> : done[key] ? <CheckCircle2 className="size-5 text-c-green" aria-hidden /> : <Icon className="size-5" aria-hidden />}
                {text}
                {done[key] && <span className="text-xs text-muted">Sent {fmtTime(done[key])}</span>}
              </BigButton>
            ))}
          </div>
        </section>
      ) : (
        <section className="rounded-2xl border border-line bg-surface p-4 text-sm text-fg-2">No trip is attached to this link yet. Your dispatcher still sees your location while you share it.</section>
      )}

      {/* Issue */}
      <section className="rounded-2xl border border-line bg-surface p-4">
        {issueOpen ? (
          <div className="space-y-3">
            <label htmlFor="issue" className="block font-medium">What happened?</label>
            <textarea id="issue" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Breakdown, delay, detention, wrong address…"
              className="w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-base text-fg placeholder:text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/15" />
            <div className="grid grid-cols-2 gap-2">
              <BigButton className="border border-line-strong bg-surface text-fg" onClick={() => setIssueOpen(false)}>Cancel</BigButton>
              <BigButton className="bg-red-600 text-white hover:bg-red-700" disabled={!note.trim() || busy === 'issue'} onClick={() => checkin('issue')}>
                {busy === 'issue' && <Loader2 className="size-5 animate-spin" aria-hidden />}Send to dispatch
              </BigButton>
            </div>
          </div>
        ) : (
          <BigButton className="border border-red-300 bg-surface text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-900/20" onClick={() => setIssueOpen(true)}>
            <AlertTriangle className="size-5" aria-hidden />{done.issue ? 'Report another issue' : 'Report an issue'}
          </BigButton>
        )}
      </section>

      <p className="pb-6 text-center text-xs text-muted">Your location goes only to {info.company}. It is not shared with anyone else and is deleted after 30 days.</p>
    </Shell>
  );
}

function Shell({ children, company }) {
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-line bg-surface/95 px-4 backdrop-blur">
        <Logo compact />
        {company && <span className="truncate pl-3 text-sm text-muted">{company}</span>}
      </header>
      <main className="mx-auto max-w-md space-y-4 px-4 pt-5">{children}</main>
    </div>
  );
}
