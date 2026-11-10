import { api } from '../../lib/api.js';

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

/** Place search: the market geocoder when available, else the built-in freight city table. */
export async function geocode(q) {
  try {
    const r = await api.get('/api/market/geocode', { q });
    if (Array.isArray(r?.items)) return { items: r.items, source: r.source || 'geocoder' };
  } catch { /* fall back */ }
  const r = await api.get('/api/fleet/places', { q });
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

/** Short tag shown under a truck pin: live GPS, stale GPS, or nothing for dispatcher-set positions. */
export function liveTag(t, now = Date.now()) {
  const l = t.live || {};
  if (l.source !== 'driver_link' || !l.lastAt) return null;
  if (l.stale) return { tone: 'stale', text: `Last seen ${sinceText(l.lastAt, now)}` };
  return { tone: 'live', text: `Live · ${sinceText(l.lastAt, now)}${l.speedMph ? ` · ${l.speedMph} mph` : ''}` };
}

export const SHARE_DURATIONS = [{ value: 8, label: '8 hours' }, { value: 24, label: '24 hours' }, { value: 72, label: '3 days' }, { value: 168, label: '7 days' }];
export const SHARE_STATUS = {
  pending: { label: 'Not opened yet', color: 'amber' },
  sharing: { label: 'Sharing', color: 'green' },
  paused: { label: 'Paused by driver', color: 'gray' },
  stopped: { label: 'Stopped', color: 'gray' },
  expired: { label: 'Expired', color: 'gray' },
};
