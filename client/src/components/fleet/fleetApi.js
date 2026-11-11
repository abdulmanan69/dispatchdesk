import { api } from '../../lib/api.js';
import { dtf } from '../../lib/format.js';

/** Truck status palette: meaningful colors used on the map, in chips and in the list. */
export const STATUS = {
  available: { label: 'Available', color: '#16a34a', soft: 'bg-green-50 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-900' },
  loaded: { label: 'Loaded', color: '#2563eb', soft: 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-900' },
  off_duty: { label: 'Off duty', color: '#6b7280', soft: 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700' },
  maintenance: { label: 'Maintenance', color: '#dc2626', soft: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-900' },
  unknown: { label: 'No status', color: '#d97706', soft: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-900' },
};
export const STATUS_KEYS = ['available', 'loaded', 'off_duty', 'maintenance', 'unknown'];

export const TRIP_STATUS = {
  planned: { label: 'Planned', color: '#7c3aed' },
  booked: { label: 'Booked', color: '#0891b2' },
  in_transit: { label: 'In transit', color: '#2563eb' },
  delivered: { label: 'Delivered', color: '#16a34a' },
  canceled: { label: 'Canceled', color: '#6b7280' },
};
export const NEXT_TRIP_STATUS = { planned: 'booked', booked: 'in_transit', in_transit: 'delivered' };

export const MAP_STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

export const ROAD_FACTOR = 1.18;
export function crowMiles(a, b) {
  const R = 3958.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Place search: the market geocoder when available, else the built-in freight city table. `signal` cancels it. */
export async function geocode(q, { signal } = {}) {
  try {
    const r = await api.get('/api/market/geocode', { q }, { signal });
    if (Array.isArray(r?.items)) return { items: r.items, source: r.source || 'geocoder' };
  } catch (err) {
    if (signal?.aborted) throw err;
    /* fall back */
  }
  const r = await api.get('/api/fleet/places', { q }, { signal });
  return { items: r.items, source: r.source };
}

/** Road route between two points; falls back to a straight-line estimate (labelled) when routing is unavailable. */
export async function route(from, to) {
  if (!from?.lat || !to?.lat) return null;
  try {
    const r = await api.get('/api/market/route', { from: `${from.lat},${from.lng}`, to: `${to.lat},${to.lng}` });
    if (r && Number.isFinite(r.miles)) return r;
  } catch { /* fall back */ }
  const miles = Math.round(crowMiles(from, to) * ROAD_FACTOR);
  return { miles, durationHours: miles / 50, geometry: [[from.lng, from.lat], [to.lng, to.lat]], source: 'estimate', estimate: true };
}

export async function weather(pt) {
  if (!pt?.lat) return null;
  try { return await api.get('/api/market/weather', { lat: pt.lat, lng: pt.lng }); } catch { return null; }
}

export async function diesel(state) {
  if (!state) return null;
  try { return await api.get('/api/market/diesel', { state }); } catch { return null; }
}

export const placeLabel = (p) => (p ? [p.city, p.state].filter(Boolean).join(', ') || (p.lat != null ? `${p.lat.toFixed(3)}, ${p.lng.toFixed(3)}` : '') : '');
export const initials = (name = '') => name.replace(/\b(LLC|INC|CORP|CO|LTD|TRUCKING|TRANSPORT(ATION)?|LOGISTICS)\b\.?/gi, '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

/** "3 min ago" style relative time for live positions. */
export function sinceText(d, now = Date.now()) {
  if (!d) return '';
  const s = Math.max(0, Math.round((now - new Date(d).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** A driver-link position older than 15 minutes is stale (worked out here, so a cached fleet response never looks live). */
export const STALE_MS = 15 * 60000;
export const isStale = (l, now = Date.now()) => !!l?.lastAt && now - new Date(l.lastAt).getTime() > STALE_MS;

/** Short tag shown under a truck pin: live GPS, stale GPS, or nothing for dispatcher-set positions. */
export function liveTag(t, now = Date.now()) {
  const l = t.live || {};
  if (l.source !== 'driver_link' || !l.lastAt) return null;
  if (isStale(l, now)) return { tone: 'stale', text: `Last seen ${sinceText(l.lastAt, now)}` };
  return { tone: 'live', text: `Live · ${sinceText(l.lastAt, now)}${l.speedMph ? ` · ${l.speedMph} mph` : ''}` };
}

// ---------------------------------------------------------------------------
// Routes, ETAs and appointments
// ---------------------------------------------------------------------------
export const fetchRoutes = (ids, opts) => api.get('/api/fleet/routes', { ids: ids.join(',') }, opts);
export const fetchDeadheads = (pairs, opts) => api.get('/api/fleet/deadhead', { pairs: pairs.join(',') }, opts);

/** On-time risk for a stop: badge color and words. */
export const RISK = {
  on_time: { label: 'On time', color: 'green' },
  at_risk: { label: 'At risk', color: 'amber' },
  late: { label: 'Late', color: 'red' },
  no_truck: { label: 'No truck', color: 'red' },
};

function fmt(d, opts, tz) {
  if (!d) return '—';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '—';
  try { return dtf({ ...opts, ...(tz ? { timeZone: tz } : {}) }).format(x); } catch { return dtf(opts).format(x); }
}

/** "Tue 3:40 PM CST" in a time zone (the stop's when known, else the browser's). */
export const timeIn = (d, tz) => fmt(d, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }, tz);

/** Appointment window text: "Nov 12, 8:00–10:00 AM CST" or "Nov 12, 9:00 AM CST". */
export function windowText(w) {
  if (!w?.start) return 'No appointment set';
  const start = new Date(w.start);
  const end = new Date(w.end || w.start);
  const day = fmt(start, { weekday: 'short', month: 'short', day: 'numeric' }, w.tz);
  // Only a date was entered: show the day, never an invented time.
  if (w.dateOnly) return `${day}, no set time`;
  const t = (d, zone) => fmt(d, { hour: 'numeric', minute: '2-digit', ...(zone ? { timeZoneName: 'short' } : {}) }, w.tz);
  return Math.abs(end - start) < 60000 ? `${day}, ${t(start, true)}` : `${day}, ${t(start)}–${t(end, true)}`;
}

/** "6 h 30 min" for minutes. */
export function hoursText(min) {
  if (min == null) return '—';
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r} min`;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** Minutes from "6:30", "6.5" or "6" (hours); null when empty, NaN when unreadable. */
export function parseHours(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) return Number(m[1]) * 60 + Number(m[2] || 0);
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 60) : NaN;
}
const pad2 = (n) => String(n).padStart(2, '0');
export const hoursInput = (min) => (min == null ? '' : `${Math.floor(min / 60)}:${pad2(Math.round(min % 60))}`);

export const SHARE_DURATIONS = [{ value: 8, label: '8 hours' }, { value: 24, label: '24 hours' }, { value: 72, label: '3 days' }, { value: 168, label: '7 days' }];
export const SHARE_STATUS = {
  pending: { label: 'Not opened yet', color: 'amber' },
  sharing: { label: 'Sharing', color: 'green' },
  paused: { label: 'Paused by driver', color: 'gray' },
  stopped: { label: 'Stopped', color: 'gray' },
  expired: { label: 'Expired', color: 'gray' },
};
