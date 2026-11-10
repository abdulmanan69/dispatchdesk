import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, Lock, MapPin, Monitor, Navigation, PackageCheck, PauseCircle, Radio, ShieldCheck, Smartphone, Truck, Warehouse } from 'lucide-react';
import { Logo } from '../../components/Logo.jsx';
import { Checkbox, cx } from '../../components/ui.jsx';

/**
 * Public driver page for a live-location link. No login: the secret token in the URL is the credential.
 * Location is sent only after the driver agrees, only while this page is open, and stops at any time.
 */
const SEND_EVERY_MS = 30_000;
const SEND_IF_MOVED_M = 200;
const MISMATCH = 'This link is already active on another phone. Ask your dispatcher for a new link.';

/*
 * Anti-forwarding: the first phone that claims the link receives a device secret. It is kept in this browser only and
 * sent with every request; the server stores just a hash, so a forwarded link does not work on another phone.
 */
const deviceKey = (token) => `dd-track-device:${token}`;
const getDevice = (token) => { try { return localStorage.getItem(deviceKey(token)) || ''; } catch { return ''; } };
const setDevice = (token, secret) => { try { if (secret) localStorage.setItem(deviceKey(token), secret); } catch { /* private mode: works until the tab closes */ } };

/** Signals the server uses to tell a phone from a computer. */
function deviceSignals() {
  const touch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
  const coarse = !!window.matchMedia?.('(pointer: coarse)').matches;
  return { touch, coarse, width: window.innerWidth };
}
const looksLikeComputer = () => { const s = deviceSignals(); return !s.touch && !s.coarse; };

class TrackError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.code = details?.code; this.details = details; }
}

/** Minimal fetch for the public driver API: no session or CSRF, plus the device secret header. */
async function call(token, method, path, body, memorySecret) {
  const headers = { Accept: 'application/json' };
  const secret = getDevice(token) || memorySecret || '';
  if (secret) headers['X-Track-Device'] = secret;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`/api/public/track/${encodeURIComponent(token)}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'omit' });
  } catch {
    throw new TrackError(0, 'No connection. Check your signal and try again.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new TrackError(res.status, data?.error || `Request failed (${res.status})`, { ...(data?.details || {}), retryAfterSec: data?.retryAfterSec });
  return data;
}

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
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null); // { gone, mismatch, message }
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState(null);
  const [desktopOk, setDesktopOk] = useState(false);
  const memSecret = useRef(''); // fallback when this browser blocks localStorage
  const isComputer = useRef(looksLikeComputer()).current;
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

  const api = useCallback((method, path, body) => call(token, method, path, body, memSecret.current), [token]);
  const remember = (secret) => { if (secret) { memSecret.current = secret; setDevice(token, secret); } };
  const fail = (e) => {
    if (e.code === 'DEVICE_MISMATCH') { setError({ mismatch: true, message: MISMATCH }); return true; }
    if (e.status === 410) { setError({ gone: true, message: e.message }); return true; }
    return false;
  };

  const load = useCallback(async () => {
    try {
      setInfo(await api('GET', ''));
      setError(null);
    } catch (e) {
      if (!fail(e)) setError({ gone: false, message: e.message });
    }
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 15000); return () => clearInterval(t); }, []);

  const send = useCallback(async (fix) => {
    try {
      const r = await api('POST', '/ping', fix);
      lastSent.current = { lat: fix.lat, lng: fix.lng, t: Date.now() };
      queued.current = null;
      setPending(false);
      setLast({ at: r.at, accuracy: fix.accuracy });
    } catch (e) {
      if (e.status === 410 || e.code === 'DEVICE_MISMATCH') { stopWatching(); fail(e); return; }
      if (e.status === 429) return; // too soon; the next fix goes through
      if (e.status === 409) { stopWatching(); setGeoError(e.message); return; }
      queued.current = fix; // offline or server unreachable: keep the latest fix and retry
      setPending(true);
    }
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

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
      clientTime: Number.isFinite(pos.timestamp) ? Math.round(pos.timestamp) : null,
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
      const c = await api('POST', '/consent', { signals: deviceSignals() });
      remember(c.deviceSecret);
      lastSent.current = null;
      watchId.current = navigator.geolocation.watchPosition(onFix, (err) => {
        setGeoError(err.code === 1 ? 'Location permission is blocked. Allow location for this site in your browser settings, then tap Start again.' : 'Could not get your location yet. Make sure location is on.');
        if (err.code === 1) stopWatching();
      }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
      setSharing(true);
      keepAwake();
      await load();
    } catch (e) {
      if (!fail(e)) setGeoError(e.message);
    } finally { setBusy(null); }
  };

  const stop = async () => {
    stopWatching();
    try { await api('POST', '/stop', {}); } catch (e) { if (fail(e)) return; /* the link may have just expired */ }
    load();
  };

  const submitPin = async (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(pin)) { setPinError('Enter the 6 digits your dispatcher read to you.'); return; }
    setBusy('pin');
    setPinError(null);
    try {
      const r = await api('POST', '/pin', { pin, signals: deviceSignals() });
      remember(r.deviceSecret);
      const { deviceSecret, ...rest } = r; // eslint-disable-line no-unused-vars
      setInfo(rest);
      setPin('');
    } catch (err) {
      if (!fail(err)) setPinError(err.message);
    } finally { setBusy(null); }
  };

  const checkin = async (event) => {
    setBusy(event);
    try {
      const r = await api('POST', '/checkin', { event, note: event === 'issue' ? note : undefined, signals: deviceSignals() });
      remember(r.deviceSecret);
      setDone((d) => ({ ...d, [event]: new Date() }));
      if (event === 'issue') { setNote(''); setIssueOpen(false); }
      if (r.tripStatus) setInfo((i) => (i?.trip ? { ...i, trip: { ...i.trip, status: r.tripStatus } } : i));
    } catch (e) {
      if (!fail(e)) setGeoError(e.message);
    } finally { setBusy(null); }
  };

  if (error?.mismatch) {
    return (
      <Shell>
        <div className="rounded-2xl border border-line bg-surface p-6 text-center">
          <Smartphone className="mx-auto size-10 text-muted" aria-hidden />
          <h1 className="mt-3 text-xl font-medium">Already active on another phone</h1>
          <p className="mt-2 text-fg-2">{error.message}</p>
        </div>
      </Shell>
    );
  }
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

  if (info.pinRequired) {
    return (
      <Shell company={info.company}>
        <form onSubmit={submitPin} className="space-y-4 rounded-2xl border border-line bg-surface p-5">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-c-blue-soft text-c-blue"><KeyRound className="size-5" aria-hidden /></span>
            <div>
              <h1 className="text-xl font-medium leading-tight">{info.company}</h1>
              <p className="mt-1 text-[15px] text-fg-2">Enter the PIN your dispatcher gave you.</p>
            </div>
          </div>
          {isComputer && <DesktopWarning />}
          <label htmlFor="pin" className="sr-only">6-digit PIN</label>
          <input id="pin" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} value={pin} autoFocus
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="••••••"
            className="h-16 w-full rounded-2xl border border-line-strong bg-surface text-center font-mono text-3xl tracking-[0.5em] text-fg placeholder:text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/15" />
          {pinError && <p className="flex items-start gap-2 text-sm text-red-700 dark:text-red-300"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{pinError}</p>}
          <BigButton type="submit" className="bg-brand-600 text-white hover:bg-brand-700" disabled={busy === 'pin' || pin.length !== 6}>
            {busy === 'pin' ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Lock className="size-5" aria-hidden />}Continue
          </BigButton>
          <p className="text-center text-xs text-muted">After you continue, this link works only on this phone.</p>
        </form>
      </Shell>
    );
  }

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
            <p className="mt-3 flex items-center gap-2 text-sm font-medium text-c-green"><ShieldCheck className="size-4" aria-hidden />Shared only from this phone</p>
            <p className="mt-2 rounded-xl bg-surface/70 px-3 py-2 text-sm text-fg-2">Keep this page open. Your phone stops sending when the page is closed or the screen turns off{wakeOn ? '; the screen is being kept on for you' : ''}.</p>
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
            {isComputer && (
              <div className="mt-4 space-y-3">
                <DesktopWarning />
                <Checkbox checked={desktopOk} onChange={(e) => setDesktopOk(e.target.checked)} label={<span className="text-sm">I am in the truck with this device</span>} />
              </div>
            )}
            {info.bound && <p className="mt-3 flex items-center gap-2 text-sm text-fg-2"><ShieldCheck className="size-4 text-c-green" aria-hidden />This link works only on this phone.</p>}
            <BigButton className="mt-4 bg-brand-600 text-white hover:bg-brand-700" disabled={busy === 'start' || (isComputer && !desktopOk)} onClick={start}>
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

function DesktopWarning() {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
      <Monitor className="mt-0.5 size-5 shrink-0" aria-hidden />
      <p><span className="font-medium">Open this link on the phone in the truck.</span> A computer cannot report where the truck is, and your dispatcher will see this position as low confidence.</p>
    </div>
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
