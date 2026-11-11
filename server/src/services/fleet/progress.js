import { decodePolyline, segmentMiles } from './polyline.js';
import { simulate, clocksAt, freshClocks, normalizeClocks } from './hos.js';
import { locate } from '../market/geo.js';
import { DEFAULT_TZ, timezoneForState, startOfUserDay, endOfUserDay } from '../../lib/timezones.js';

/**
 * Trip progress, ETAs and on-time risk from data the app already has: the stored road route (Load.routeGeometry),
 * the truck's last position, recent GPS pings and the hours-of-service clocks the dispatcher or driver entered.
 * Everything here is plain in-process math: no routing call is made per ping or per page view.
 * All results are planning estimates and are labelled as such in the UI.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const MIN = 60_000;
/** Average truck speed assumed for legs without a stored road route (deadhead between trips). */
export const ESTIMATE_MPH = 50;
export const ROAD_FACTOR = 1.18;
/** A truck farther than this from its road route on two fixes in a row is off route. */
export const OFF_ROUTE_MILES = 5;
/** An arrival within this many minutes of the end of the appointment window is "at risk". */
export const RISK_SLACK_MIN = 60;

// ---------------------------------------------------------------------------
// Route geometry (decoded once per load and route version, then cached)
// ---------------------------------------------------------------------------
const ROUTE_CACHE_TTL = 30 * MIN;
// Bounded by memory, not entry count: a packed route costs 24 bytes per point (lng, lat, miles as float64).
const ROUTE_CACHE_BYTES = 24 * 1024 * 1024;

/**
 * Small LRU of measured routes bounded by total bytes, with expiry. Expired entries are dropped on every insert (from
 * the old end), not only when the cache is full. Shared by the trip-route and deadhead caches.
 */
export function routeLru({ maxBytes = ROUTE_CACHE_BYTES, ttlMs = ROUTE_CACHE_TTL } = {}) {
  const map = new Map(); // key -> { value, bytes, exp }
  let bytes = 0;
  const drop = (k) => { const e = map.get(k); if (e) { bytes -= e.bytes; map.delete(k); } };
  return {
    get(key, now = Date.now()) {
      const e = map.get(key);
      if (!e) return undefined;
      if (e.exp <= now) { drop(key); return undefined; }
      map.delete(key);
      map.set(key, e);
      return e.value;
    },
    set(key, value, size, now = Date.now()) {
      drop(key);
      map.set(key, { value, bytes: size, exp: now + ttlMs });
      bytes += size;
      for (const [k, e] of map) {
        if (bytes <= maxBytes && e.exp > now) break;
        if (k === key && bytes <= maxBytes) break;
        drop(k);
      }
    },
    clear() { map.clear(); bytes = 0; },
    get size() { return map.size; },
    get bytes() { return bytes; },
  };
}

const routeCache = routeLru();

/**
 * Decode and measure an encoded route: { pts, n, cum (miles from start), total, bytes }. Points are packed in one
 * Float64Array [lng0, lat0, lng1, lat1, ...] (about a third of the memory of an array of [lng, lat] arrays).
 */
export function measureRoute(encoded) {
  const points = decodePolyline(encoded);
  const n = points.length;
  const pts = new Float64Array(n * 2);
  const cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    pts[2 * i] = points[i][0];
    pts[2 * i + 1] = points[i][1];
    if (i) cum[i] = cum[i - 1] + segmentMiles(points[i - 1], points[i]);
  }
  return { pts, n, cum, total: n ? cum[n - 1] : 0, bytes: pts.byteLength + cum.byteLength + 64 };
}

/** measureRoute with a per-process cache keyed by load id and route version (byte-bounded LRU, 30 min expiry). */
export function measuredRoute(load) {
  if (!load?.routeGeometry) return null;
  const key = `${load.id}:${load.routeComputedAt ? new Date(load.routeComputedAt).getTime() : 0}:${load.routeGeometry.length}`;
  const hit = routeCache.get(key);
  if (hit) return hit;
  const value = measureRoute(load.routeGeometry);
  routeCache.set(key, value, value.bytes);
  return value;
}
export function clearRouteCache() { routeCache.clear(); }

/**
 * Snap a position onto a measured route. Returns { offMiles, alongMiles, remainingMiles, fraction, index, t, point: [lng, lat] }.
 * Local equirectangular distances around the position: exact enough at the scale of a few miles.
 */
export function projectOnRoute(route, p) {
  const pts = route?.pts;
  const n = route?.n ?? 0;
  if (!pts || n < 2 || p?.lat == null || p?.lng == null) return null;
  const kx = 69.172 * Math.cos((p.lat * Math.PI) / 180);
  const ky = 69.0;
  let best = Infinity;
  let bi = 0;
  let bt = 0;
  for (let i = 0; i < n - 1; i++) {
    const a0 = pts[2 * i];
    const a1 = pts[2 * i + 1];
    const ax = (a0 - p.lng) * kx;
    const ay = (a1 - p.lat) * ky;
    const dx = (pts[2 * i + 2] - a0) * kx;
    const dy = (pts[2 * i + 3] - a1) * ky;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const d2 = cx * cx + cy * cy;
    if (d2 < best) { best = d2; bi = i; bt = t; }
  }
  const a = [pts[2 * bi], pts[2 * bi + 1]];
  const b = [pts[2 * bi + 2], pts[2 * bi + 3]];
  const along = route.cum[bi] + bt * (route.cum[bi + 1] - route.cum[bi]);
  return {
    offMiles: Math.sqrt(best), alongMiles: along, remainingMiles: Math.max(0, route.total - along),
    fraction: route.total ? clamp(along / route.total, 0, 1) : 0, index: bi, t: bt,
    point: [a[0] + bt * (b[0] - a[0]), a[1] + bt * (b[1] - a[1])],
  };
}

// ---------------------------------------------------------------------------
// Recent pace from GPS pings
// ---------------------------------------------------------------------------
const haversine = (a, b) => segmentMiles([a.lng, a.lat], [b.lng, b.lat]);

/**
 * Moving speed from trusted pings (sorted oldest first): only stretches where the truck was moving count, so a fuel stop
 * does not drag the pace down (required breaks are added separately by the hours-of-service plan).
 * Returns { mph, movingMin, sampleMin, movingShare } (mph null with under 15 moving minutes in the window;
 * movingShare = moving time / time covered by pings, used to run the driving clocks forward since an hours report).
 */
export function paceFromPings(pings, { now = Date.now(), windowMin = 90 } = {}) {
  const from = now - windowMin * MIN;
  let miles = 0;
  let movingMs = 0;
  let sampleMs = 0;
  for (let i = 1; i < (pings?.length || 0); i++) {
    const a = pings[i - 1];
    const b = pings[i];
    if (String(b.flags || '').includes('impossible_jump') || String(a.flags || '').includes('impossible_jump')) continue;
    const ta = new Date(a.at).getTime();
    const tb = new Date(b.at).getTime();
    const dt = tb - ta;
    if (ta < from || dt < 5000 || dt > 20 * MIN) continue;
    const d = haversine(a, b);
    const mph = d / (dt / 3600_000);
    if (mph > 90) continue;
    sampleMs += dt;
    const moving = b.speed != null ? b.speed >= 2.2 : mph >= 5;
    if (!moving) continue;
    miles += d;
    movingMs += dt;
  }
  const movingMin = movingMs / MIN;
  return {
    mph: movingMin >= 15 ? Math.round((miles / (movingMs / 3600_000)) * 10) / 10 : null,
    movingMin: Math.round(movingMin),
    sampleMin: Math.round(sampleMs / MIN),
    movingShare: sampleMs >= 15 * MIN ? Math.round((movingMs / sampleMs) * 100) / 100 : null,
  };
}

// ---------------------------------------------------------------------------
// Appointment windows and risk
// ---------------------------------------------------------------------------
const ms = (d) => (d ? new Date(d).getTime() : null);

/** { start, end, tz } for a stop: the appointment window, or the single appointment time; null when not scheduled. */
export function stopWindow(load, kind) {
  const p = kind === 'pickup';
  const s = ms(p ? load.pickupWindowStart : load.deliveryWindowStart);
  const e = ms(p ? load.pickupWindowEnd : load.deliveryWindowEnd);
  const d = ms(p ? load.pickupDate : load.deliveryDate);
  const tz = (p ? load.pickupTz : load.deliveryTz) || null;
  if (s == null && e == null) {
    if (d == null) return null;
    // Only a date (the load form stores it at local noon): the stop can happen any time that day at the facility, so
    // the window is the whole local day. Nothing is "late" before the day is over and no appointment time is invented.
    const zone = tz || timezoneForState(p ? load.originState : load.destState) || DEFAULT_TZ;
    return { start: startOfUserDay(zone, new Date(d)), end: endOfUserDay(zone, new Date(d)), tz: zone, dateOnly: true };
  }
  const start = s ?? e;
  const end = e ?? s;
  return { start: new Date(start), end: new Date(Math.max(start, end)), tz };
}

/** late | at_risk | on_time for an arrival against a window (null without either). */
export function riskFor(etaMs, window, slackMin = RISK_SLACK_MIN) {
  if (etaMs == null || !window?.end) return null;
  const end = new Date(window.end).getTime();
  if (etaMs > end) return 'late';
  if (etaMs > end - slackMin * MIN) return 'at_risk';
  return 'on_time';
}
const RISK_ORDER = { late: 3, at_risk: 2, on_time: 1 };
export const worstRisk = (list) => list.filter(Boolean).sort((a, b) => RISK_ORDER[b] - RISK_ORDER[a])[0] || null;

// ---------------------------------------------------------------------------
// Hours-of-service reports (stored in LoadEvent.data as { hos: { driveLeftMin, shiftLeftMin, cycleLeftMin, breakDueMin } })
// ---------------------------------------------------------------------------
export function hosFromEvent(ev) {
  if (!ev?.data) return null;
  try {
    const d = JSON.parse(ev.data);
    const clocks = normalizeClocks(d?.hos || {});
    return clocks ? { clocks, at: new Date(ev.at), source: ev.source, input: d.hos } : null;
  } catch { return null; }
}

/** Clocks to plan with now: the latest report run forward, or full clocks marked as assumed. */
export function currentClocks(hos, now, movingMinSince) {
  if (hos?.clocks && hos.at) {
    const c = clocksAt(hos.clocks, (now - hos.at.getTime()) / MIN, movingMinSince);
    if (c) return { clocks: c, assumed: false, stale: false, reportedAt: hos.at };
    return { clocks: freshClocks(), assumed: true, stale: true, reportedAt: hos.at };
  }
  return { clocks: freshClocks(), assumed: true, stale: false, reportedAt: null };
}

// ---------------------------------------------------------------------------
// Plan: progress on the current trip and ETAs for the next stops
// ---------------------------------------------------------------------------
const crowMiles = (a, b) => haversine(a, b);

/**
 * Route minutes for a load: the stored road route's (only while that route is current, i.e. `route` is given), else
 * straight line × road factor at the estimate speed, else the load's miles at that speed.
 */
function routeMinutesFor(load, route) {
  if (route && load.routeMinutes != null && load.routeMiles != null) return { minutes: load.routeMinutes, miles: load.routeMiles };
  if (route?.total) return { minutes: (route.total / ESTIMATE_MPH) * 60, miles: route.total };
  if (load.loadedMiles) return { minutes: (load.loadedMiles / ESTIMATE_MPH) * 60, miles: load.loadedMiles };
  return null;
}

/**
 * A stop's point for timing: exact coordinates, else the center of a known city (loads typed on the Loads page carry no
 * coordinates). A state's center point is too coarse to time a stop, so it gives null and the stop gets no ETA.
 */
function stopPoint(city, state, lat, lng) {
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  if (!city || !state) return null;
  const hit = locate(`${city}, ${state}`);
  return hit?.precision === 'city' ? { lat: hit.lat, lng: hit.lon } : null;
}

const endsOf = (load) => ({
  origin: stopPoint(load.originCity, load.originState, load.originLat, load.originLng),
  dest: stopPoint(load.destCity, load.destState, load.destLat, load.destLng),
});

/**
 * Plan the truck's next stops.
 *   trips: active loads of the truck, in_transit first, then booked/planned by pickup time (max 3 are planned)
 *   position: { lat, lng, at } | null (the truck's last known position)
 *   routes: { [loadId]: measured route } (from measuredRoute)
 *   hos: hosFromEvent(...) | null; pace: paceFromPings(...) | null
 *   events: { [loadId]: LoadEvent[] } to know whether a pickup already happened (optional)
 * Returns { trips: [{ id, status, progress, stops }], stops (flat), eta, legalEta, risk, hos, pace, legal }.
 */
export function planTruck({ trips, position, routes = {}, hos = null, pace = null, now = Date.now(), events = {} }) {
  const list = (trips || []).filter((t) => ['in_transit', 'booked', 'planned'].includes(t.status)).slice(0, 3);
  // Driving since the hours report: the share of recent GPS time spent moving, applied to the time since the report
  // (without GPS the driver is assumed to have driven the whole time, which errs on the late side).
  const sinceReportMin = hos?.at ? Math.max(0, (now - new Date(hos.at).getTime()) / MIN) : 0;
  const movingSince = pace?.movingShare != null ? sinceReportMin * pace.movingShare : null;
  const { clocks, assumed, stale, reportedAt } = currentClocks(hos, now, movingSince);
  const segments = [];
  const out = [];
  let cursor = position?.lat != null ? { lat: position.lat, lng: position.lng } : null;
  // Once a leg cannot be timed (no position, no route), later stops get no ETA rather than a made-up one.
  let ok = !!cursor;
  let prevDock = 0;
  for (const load of list) {
    const route = routes[load.id] || null;
    const rm = routeMinutesFor(load, route);
    const { origin, dest } = endsOf(load);
    const ev = events[load.id] || [];
    const pickedUp = load.status === 'in_transit' || ev.some((e) => e.type === 'loaded' || e.type === 'departed_pickup');
    const trip = { id: load.id, status: load.status, progress: null, stops: [], estimate: !route || load.routeSource !== 'osrm' };
    let paceFactor = 1;
    if (pace?.mph && rm?.minutes > 0 && rm.miles > 0) paceFactor = clamp((rm.miles / (rm.minutes / 60)) / pace.mph, 0.85, 1.5);

    if (pickedUp) {
      let driveMin = null;
      if (cursor && route && route.total > 0 && rm) {
        const snap = projectOnRoute(route, cursor);
        const remainingFrac = snap.remainingMiles / route.total;
        // Getting back to the route counts too (a detour, a truck stop off the highway).
        const back = snap.offMiles > 1 ? ((snap.offMiles * ROAD_FACTOR) / ESTIMATE_MPH) * 60 : 0;
        driveMin = rm.minutes * remainingFrac * paceFactor + back;
        trip.progress = {
          totalMiles: Math.round(route.total), doneMiles: Math.round(snap.alongMiles), remainingMiles: Math.round(snap.remainingMiles + snap.offMiles),
          pct: Math.round(snap.fraction * 100), offRouteMiles: Math.round(snap.offMiles * 10) / 10, offRoute: !trip.estimate && snap.offMiles > OFF_ROUTE_MILES,
          snapped: snap.point, paceFactor: Math.round(paceFactor * 100) / 100,
        };
      } else if (cursor && dest) {
        const miles = crowMiles(cursor, dest) * ROAD_FACTOR;
        driveMin = (miles / ESTIMATE_MPH) * 60;
        trip.progress = { totalMiles: rm ? Math.round(rm.miles) : null, doneMiles: null, remainingMiles: Math.round(miles), pct: null, offRouteMiles: null, offRoute: false, snapped: null, paceFactor: 1 };
      }
      if (ok && driveMin != null) segments.push({ drive: driveMin }, { mark: `${load.id}:delivery` });
      else ok = false;
      trip.stops.push({ kind: 'delivery', loadId: load.id });
    } else {
      // Unloading at the previous stop, deadhead to this pickup (straight line × road factor), the appointment, loading,
      // then the load itself.
      if (ok && prevDock) segments.push({ onDuty: prevDock });
      if (ok && cursor && origin) {
        const dh = crowMiles(cursor, origin);
        if (dh > 1) segments.push({ drive: ((dh * ROAD_FACTOR) / ESTIMATE_MPH) * 60 });
        segments.push({ mark: `${load.id}:pickup` });
        const pw = stopWindow(load, 'pickup');
        if (pw?.start) segments.push({ waitUntil: new Date(pw.start).getTime() });
        segments.push({ onDuty: (load.freeTimeHours ?? 2) * 60 });
      } else ok = false;
      if (ok && rm) segments.push({ drive: rm.minutes }, { mark: `${load.id}:delivery` });
      else ok = false;
      trip.stops.push({ kind: 'pickup', loadId: load.id }, { kind: 'delivery', loadId: load.id });
    }
    prevDock = (load.freeTimeHours ?? 2) * 60;
    cursor = dest;
    if (!dest) ok = false;
    trip.load = load;
    out.push(trip);
  }

  const plain = simulate(now, segments, null, { legal: false });
  const legal = simulate(now, segments, clocks, { legal: true });
  const flat = [];
  for (const trip of out) {
    for (const s of trip.stops) {
      const key = `${s.loadId}:${s.kind}`;
      const window = stopWindow(trip.load, s.kind);
      const eta = plain.marks[key] ?? null;
      const legalEta = legal.marks[key] ?? null;
      Object.assign(s, {
        city: s.kind === 'pickup' ? trip.load.originCity : trip.load.destCity,
        state: s.kind === 'pickup' ? trip.load.originState : trip.load.destState,
        window, eta: eta != null ? new Date(eta) : null, legalEta: legalEta != null ? new Date(legalEta) : null,
        risk: riskFor(legalEta ?? eta, window),
      });
      flat.push(s);
    }
    delete trip.load;
  }
  const next = flat.find((s) => s.eta);
  return {
    trips: out,
    stops: flat,
    eta: next?.eta || null,
    legalEta: next?.legalEta || null,
    risk: worstRisk(flat.map((s) => s.risk)),
    hos: { assumed, stale, reportedAt, clocks },
    pace: pace?.mph ? { mph: pace.mph, movingMin: pace.movingMin } : null,
    legal: { breaks: legal.breaks, rests: legal.rests, restarts: legal.restarts, events: legal.events.filter((e) => e.type !== 'drive').slice(0, 12).map((e) => ({ type: e.type, start: new Date(e.startMs), end: new Date(e.endMs) })) },
  };
}

// ---------------------------------------------------------------------------
// Dwell and detention from load events
// ---------------------------------------------------------------------------

/**
 * Time at the dock per stop from check-ins: arrived -> loaded/departed (pickup) or arrived -> delivered (delivery).
 * Explicit detention_start / detention_stop events override the computed start and end.
 * Returns [{ stop, arrivedAt, leftAt, dwellMin, freeMin, detentionMin, running }].
 */
export function dwellFromEvents(events, { freeTimeHours = 2, now = Date.now() } = {}) {
  const evs = [...(events || [])].sort((a, b) => new Date(a.at) - new Date(b.at));
  const first = (types, after = 0) => evs.find((e) => types.includes(e.type) && new Date(e.at).getTime() >= after);
  const freeMin = Math.round((freeTimeHours ?? 2) * 60);
  const out = [];
  for (const [stop, arrive, leave] of [['pickup', ['arrived_pickup'], ['loaded', 'departed_pickup']], ['delivery', ['arrived_delivery'], ['delivered']]]) {
    const a = [...evs].reverse().find((e) => arrive.includes(e.type));
    if (!a) continue;
    const at = new Date(a.at).getTime();
    const l = first(leave, at);
    const startEv = evs.find((e) => e.type === 'detention_start' && new Date(e.at).getTime() >= at && (!l || new Date(e.at).getTime() <= new Date(l.at).getTime()));
    const stopEv = startEv ? first(['detention_stop'], new Date(startEv.at).getTime()) : null;
    const end = l ? new Date(l.at).getTime() : now;
    const dwellMin = Math.max(0, Math.round((end - at) / MIN));
    const detStart = startEv ? new Date(startEv.at).getTime() : at + freeMin * MIN;
    const detEnd = stopEv ? new Date(stopEv.at).getTime() : end;
    const detentionMin = Math.max(0, Math.round((detEnd - detStart) / MIN));
    out.push({ stop, arrivedAt: new Date(at), leftAt: l ? new Date(l.at) : null, dwellMin, freeMin, detentionMin, running: !l && !stopEv && detentionMin > 0 });
  }
  return out;
}
