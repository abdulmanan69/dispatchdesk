/**
 * Stop order for consolidated trips (several loads on one truck), on the client. Same rules as the server
 * (server/src/services/fleet/consolidation.js): every load has exactly one pickup and one delivery, the pickup first.
 * Stops are { loadId, kind: 'pickup' | 'delivery' }. Loads here are the dialog's normalized loads (see normalizeLoad).
 */
import { crowMiles, ROAD_FACTOR } from './fleetApi.js';

export const MIN_LOADS = 2;
export const MAX_LOADS = 6;
const ESTIMATE_MPH = 50;

const ms = (v) => {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : Infinity;
};

/** When a stop is due, for ordering: its window start (Infinity when unknown). */
export const stopTime = (load, kind) => ms(load?.[kind]?.window?.start);

/** Default order: every pickup by window start, then every delivery by window start (ties keep the loads' order). */
export function defaultStopOrder(loads) {
  const order = (kind) => loads.map((l, i) => ({ l, i }))
    .sort((a, b) => (stopTime(a.l, kind) - stopTime(b.l, kind)) || a.i - b.i)
    .map(({ l }) => ({ loadId: l.id, kind }));
  return [...order('pickup'), ...order('delivery')];
}

const loadName = (l) => (l?.ref ? `Load #${l.ref}` : l ? `The ${l.pickup?.city || ''} load` : 'A load');

/**
 * Check an order: { ok, message, problems: { [index]: text } } where problems mark the stops to fix (a delivery placed
 * before its pickup, a missing or doubled stop).
 */
export function checkStopOrder(stops, loadIds, loadsById = new Map()) {
  const ids = new Set(loadIds);
  const problems = {};
  const at = new Map();
  let message = null;
  const flag = (i, text) => { problems[i] = text; message = message || text; };
  stops.forEach((s, i) => {
    if (!ids.has(s.loadId)) { flag(i, 'This load is not on the trip'); return; }
    const e = at.get(s.loadId) || {};
    if (e[s.kind] != null) flag(i, `${loadName(loadsById.get(s.loadId))} has two ${s.kind} stops`);
    else e[s.kind] = i;
    at.set(s.loadId, e);
  });
  for (const id of ids) {
    const e = at.get(id) || {};
    const name = loadName(loadsById.get(id));
    if (e.pickup == null || e.delivery == null) { message = message || `${name} needs both its pickup and its delivery`; continue; }
    if (e.delivery < e.pickup) flag(e.delivery, `${name} is delivered before it is picked up. Move the delivery below its pickup.`);
  }
  return { ok: !message, message, problems };
}

/** The order with the stop at `from` moved to `to` (indexes clamped). */
export function moveStop(stops, from, to) {
  const out = stops.slice();
  if (from < 0 || from >= out.length) return out;
  const dest = Math.max(0, Math.min(out.length - 1, to));
  const [s] = out.splice(from, 1);
  out.splice(dest, 0, s);
  return out;
}

/**
 * Keep the dispatcher's order when the picked loads change: stops of loads no longer picked go away, a newly picked
 * load's pickup goes before the first later-due stop and its delivery before the first later-due stop after it.
 */
export function syncStopOrder(stops, loads) {
  const byId = new Map(loads.map((l) => [l.id, l]));
  const out = stops.filter((s) => byId.has(s.loadId));
  const dueAfter = (from, t) => {
    for (let i = from; i < out.length; i++) if (stopTime(byId.get(out[i].loadId), out[i].kind) > t) return i;
    return out.length;
  };
  for (const l of loads) {
    if (out.some((s) => s.loadId === l.id)) continue;
    const p = dueAfter(0, stopTime(l, 'pickup'));
    out.splice(p, 0, { loadId: l.id, kind: 'pickup' });
    out.splice(dueAfter(p + 1, stopTime(l, 'delivery')), 0, { loadId: l.id, kind: 'delivery' });
  }
  return out;
}

export const sameOrder = (a, b) => a.length === b.length && a.every((s, i) => s.loadId === b[i].loadId && s.kind === b[i].kind);

/** Straight-line estimate for an order (miles × road factor, 50 mph): { miles, minutes }, or null without coordinates. */
export function estimateOrder(stops, loadsById) {
  let miles = 0;
  let prev = null;
  for (const s of stops) {
    const p = loadsById.get(s.loadId)?.[s.kind];
    if (p?.lat == null || p?.lng == null) return null;
    if (prev) miles += crowMiles(prev, p) * ROAD_FACTOR;
    prev = p;
  }
  return { miles: Math.round(miles), minutes: Math.round((miles / ESTIMATE_MPH) * 60) };
}

/** Appointment window for a stop from load columns: { start, end, tz, dateOnly? } or null. */
function windowOf(start, end, date, tz) {
  if (start || end) return { start: start || end, end: end || start, tz: tz || null };
  return date ? { start: date, end: date, tz: tz || null, dateOnly: true } : null;
}

/** A load from GET /api/consolidations/candidates in the dialog's shape. */
export function normalizeCandidate(l) {
  return {
    id: l.id, ref: l.referenceNumber || null, status: l.status, broker: l.broker?.companyName || null, rateCents: l.rateCents,
    onTruck: !!l.carrierId, trip: l.consolidation || null,
    pickup: { city: l.origin.city, state: l.origin.state, lat: l.origin.lat, lng: l.origin.lng, facility: l.origin.facility || null, window: windowOf(l.pickupWindowStart, l.pickupWindowEnd, l.pickupDate, l.pickupTz) },
    delivery: { city: l.dest.city, state: l.dest.state, lat: l.dest.lat, lng: l.dest.lng, facility: l.dest.facility || null, window: windowOf(l.deliveryWindowStart, l.deliveryWindowEnd, l.deliveryDate, l.deliveryTz) },
  };
}

/** The loads of a consolidated trip (API view) in the dialog's shape, in trip order. */
export function loadsFromTrip(trip) {
  const byId = new Map();
  for (const s of trip?.stops || []) {
    const l = byId.get(s.loadId) || {
      id: s.loadId, ref: s.load?.referenceNumber || null, status: s.load?.status, broker: s.load?.broker?.companyName || null,
      rateCents: s.load?.rateCents, onTruck: true, trip: { id: trip.id, name: trip.name },
    };
    l[s.kind] = { city: s.city, state: s.state, lat: s.lat, lng: s.lng, facility: s.facility || null, window: s.window || null, done: !!s.done };
    byId.set(s.loadId, l);
  }
  return [...byId.values()];
}
