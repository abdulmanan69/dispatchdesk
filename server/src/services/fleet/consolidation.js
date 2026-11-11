import { prisma } from '../../db.js';
import { recordLoadEvent } from './events.js';
import { pointFor, routeIsCurrent } from './index.js';
import { multiStopRoute, ROUTE_INCLUDE } from './route.js';
import { decodePolyline, encodePolyline, segmentMiles, simplifyToBudget, routeGeometryOf } from './polyline.js';
import { stopWindow, riskFor, worstRisk, currentClocks, ESTIMATE_MPH, ROAD_FACTOR } from './progress.js';
import { simulate } from './hos.js';

/**
 * Consolidated trips: several customers' loads on one truck, driven in one stop order.
 *
 * Each load keeps its own rate, invoice, documents and status; the Consolidation row only groups them (Load.consolidationId)
 * for routing, stop order and an overall status:
 *   stops            JSON [{ loadId, kind: 'pickup' | 'delivery' }] in driving order; every load has exactly one pickup
 *                    and one delivery, and its pickup comes first. The driver's page reads this array as is.
 *   routeGeometry    encoded polyline through every stop in order (it passes exactly through each stop's point), with
 *   routeMiles/Min.  the totals. routeComputedAt is set only for a road route: a straight-line estimate (router down or
 *                    busy, or a stop known only by its state) leaves it null, and is tried again later.
 *   status           planned | in_transit | delivered | canceled, kept in step with the loads by syncConsolidation():
 *                    in_transit once any load is picked up, delivered when every load is delivered/invoiced/paid.
 *                    Canceled loads (and loads moved to another truck) drop out; with fewer than 2 loads left the trip
 *                    ends (status canceled, loads detached and back to plain trips).
 * Nothing here keeps state between requests except the background route queue, which is only a retry and never needed
 * for correctness (the next read schedules it again).
 */
export const MIN_LOADS = 2;
export const MAX_LOADS = 6;
export const ACTIVE_CONSOLIDATION = ['planned', 'in_transit'];
/** Load statuses that can join a consolidated trip. */
export const JOINABLE = ['planned', 'booked', 'in_transit'];
const FINISHED = ['delivered', 'invoiced', 'paid'];
const MIN = 60_000;
const near = (a, b, tol) => Math.abs(a.lat - b.lat) < tol && Math.abs(a.lng - b.lng) < tol;

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

/** The stored stops as [{ loadId, kind }] (anything malformed is dropped). */
export function parseStops(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { list = null; }
  }
  if (!Array.isArray(list)) return [];
  return list.filter((s) => s && typeof s.loadId === 'string' && (s.kind === 'pickup' || s.kind === 'delivery')).map((s) => ({ loadId: s.loadId, kind: s.kind }));
}

export const stopsJson = (stops) => JSON.stringify(stops.map(({ loadId, kind }) => ({ loadId, kind })));

/** When a stop is due, for ordering: the window start, else its end, else the appointment date; Infinity when unknown. */
export function stopTime(load, kind) {
  const p = kind === 'pickup';
  const v = p ? (load.pickupWindowStart ?? load.pickupWindowEnd ?? load.pickupDate) : (load.deliveryWindowStart ?? load.deliveryWindowEnd ?? load.deliveryDate);
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : Infinity;
}

/** Default stop order: every pickup by window start, then every delivery by window start (ties keep the loads' order). */
export function defaultStops(loads) {
  const order = (kind) => loads.map((l, i) => ({ l, i }))
    .sort((a, b) => (stopTime(a.l, kind) - stopTime(b.l, kind)) || a.i - b.i)
    .map(({ l }) => ({ loadId: l.id, kind }));
  return [...order('pickup'), ...order('delivery')];
}

export const loadLabel = (l) => (l?.referenceNumber ? `Load #${l.referenceNumber}` : l ? `Load ${l.originCity} → ${l.destCity}` : 'A load');

/**
 * Check a stop order for these loads: a permutation (every load exactly one pickup and one delivery, nothing else) with
 * every pickup before its delivery. { ok: true } or { ok: false, reason, loadId? }.
 */
export function checkStops(stops, loadIds, loadsById = new Map()) {
  const ids = new Set(loadIds);
  if (!Array.isArray(stops)) return { ok: false, reason: 'Stops are missing' };
  const at = new Map();
  for (const [i, s] of stops.entries()) {
    if (!s || !ids.has(s.loadId)) return { ok: false, reason: 'A stop belongs to a load that is not on this trip', loadId: s?.loadId ?? null };
    if (s.kind !== 'pickup' && s.kind !== 'delivery') return { ok: false, reason: 'Each stop is a pickup or a delivery' };
    const e = at.get(s.loadId) || {};
    if (e[s.kind] != null) return { ok: false, reason: `${loadLabel(loadsById.get(s.loadId))} has two ${s.kind} stops`, loadId: s.loadId };
    e[s.kind] = i;
    at.set(s.loadId, e);
  }
  for (const id of ids) {
    const e = at.get(id);
    if (!e || e.pickup == null || e.delivery == null) return { ok: false, reason: `${loadLabel(loadsById.get(id))} needs both its pickup and its delivery stop`, loadId: id };
    if (e.delivery < e.pickup) return { ok: false, reason: `${loadLabel(loadsById.get(id))} is delivered before it is picked up`, loadId: id };
  }
  return { ok: true };
}

/**
 * Stops with one more load: its pickup goes before the first later-due stop, its delivery before the first later-due
 * stop after that pickup (stops already done stay first). The dispatcher can reorder afterwards.
 */
export function insertStops(stops, load, loadsById, done = () => false) {
  const out = stops.slice();
  const firstOpen = Math.max(0, out.findLastIndex((s) => done(s)) + 1);
  const dueAfter = (from, t) => {
    for (let i = from; i < out.length; i++) {
      const l = loadsById.get(out[i].loadId);
      if (l && stopTime(l, out[i].kind) > t) return i;
    }
    return out.length;
  };
  const p = dueAfter(firstOpen, stopTime(load, 'pickup'));
  out.splice(p, 0, { loadId: load.id, kind: 'pickup' });
  const d = dueAfter(p + 1, stopTime(load, 'delivery'));
  out.splice(d, 0, { loadId: load.id, kind: 'delivery' });
  return out;
}

/** A stop is done once its load is picked up (in transit or later) or delivered. */
export function stopDone(load, kind) {
  if (!load) return false;
  return kind === 'pickup' ? load.status === 'in_transit' || FINISHED.includes(load.status) : FINISHED.includes(load.status);
}

/** Overall status from the loads still on the trip. */
export function deriveStatus(loads) {
  const live = loads.filter((l) => l.status !== 'canceled');
  if (!live.length) return 'canceled';
  if (live.every((l) => FINISHED.includes(l.status))) return 'delivered';
  if (live.some((l) => l.status === 'in_transit' || FINISHED.includes(l.status))) return 'in_transit';
  return 'planned';
}

const stopPoint = (load, kind) => (kind === 'pickup'
  ? pointFor(load.originCity, load.originState, load.originLat, load.originLng)
  : pointFor(load.destCity, load.destState, load.destLat, load.destLng));

/** Short name for a trip without one: first pickup city to last delivery city and the number of loads. */
export function autoTitle(stops, loadsById) {
  const first = stops.find((s) => s.kind === 'pickup');
  const last = [...stops].reverse().find((s) => s.kind === 'delivery');
  const a = first && loadsById.get(first.loadId);
  const b = last && loadsById.get(last.loadId);
  const n = new Set(stops.map((s) => s.loadId)).size;
  if (!a || !b) return 'Consolidated trip';
  return `${a.originCity}, ${a.originState} → ${b.destCity}, ${b.destState} · ${n} loads`;
}
export const titleOf = (c, stops, loadsById) => c.name || autoTitle(stops, loadsById);

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/**
 * Points to route through for these stops: consecutive stops at the same place are one point. stopIndex[i] is the
 * point of stop i. null when a stop has no place at all.
 */
export function routePoints(stops, loadsById) {
  const points = [];
  const stopIndex = [];
  for (const s of stops) {
    const l = loadsById.get(s.loadId);
    const p = l && stopPoint(l, s.kind);
    if (!p) return null;
    const last = points[points.length - 1];
    if (last && near(last, p, 1e-5)) { stopIndex.push(points.length - 1); continue; }
    points.push({ lat: p.lat, lng: p.lng, precision: p.precision });
    stopIndex.push(points.length - 1);
  }
  return { points, stopIndex, stateOnly: points.some((p) => p.precision === 'state') };
}

/**
 * Route columns for these stops, computed now: { routeGeometry, routeMiles, routeMinutes, routeComputedAt, estimate }.
 * A pickup followed directly by its own delivery reuses the load's stored road route (no routing call). A stop known
 * only by its state gives a straight-line estimate without asking the router (its center point is not a real place).
 */
export async function computeRoute(stops, loadsById, { deadlineMs = 8000 } = {}) {
  const rp = routePoints(stops, loadsById);
  if (!rp) return null;
  if (rp.points.length < 2) {
    return { routeGeometry: null, routeMiles: 0, routeMinutes: 0, routeComputedAt: rp.points.length ? new Date() : null, estimate: !rp.points.length };
  }
  const known = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (a.loadId !== b.loadId || a.kind !== 'pickup' || b.kind !== 'delivery' || rp.stopIndex[i] === rp.stopIndex[i + 1]) continue;
    const l = loadsById.get(a.loadId);
    if (l?.route?.geometry && l.routeSource === 'osrm' && l.routeMiles != null && l.routeMinutes != null && routeIsCurrent(l)) {
      known[rp.stopIndex[i]] = { encoded: routeGeometryOf(l), miles: l.routeMiles, minutes: l.routeMinutes };
    }
  }
  const r = await multiStopRoute(rp.points, { known, deadlineMs: rp.stateOnly ? 0 : deadlineMs });
  return {
    routeGeometry: r.geometry, routeMiles: r.miles, routeMinutes: r.minutes,
    routeComputedAt: r.estimate ? null : new Date(), estimate: r.estimate,
  };
}

// Decoded stored lines, per row version (any write changes updatedAt), so list views do not decode the same line again.
const lineMemo = new Map();
const LINE_MEMO_MAX = 300;
function storedLine(c) {
  if (!c.routeGeometry) return null;
  const key = `${c.id}:${new Date(c.updatedAt).getTime()}:${c.routeGeometry.length}`;
  let pts = lineMemo.get(key);
  if (!pts) {
    pts = decodePolyline(c.routeGeometry);
    if (lineMemo.size >= LINE_MEMO_MAX) lineMemo.delete(lineMemo.keys().next().value);
    lineMemo.set(key, pts);
  }
  return pts;
}

/** Index in `line` of each point, in order, or null when the line does not pass through every point. */
function matchPoints(line, points) {
  const idx = [];
  let j = 0;
  for (const p of points) {
    while (j < line.length && !(Math.abs(line[j][0] - p.lng) < 2e-5 && Math.abs(line[j][1] - p.lat) < 2e-5)) j++;
    if (j >= line.length) return null;
    idx.push(j);
  }
  return idx;
}

/**
 * The stored route against the stops as they are now:
 *   current   the line passes through every stop's point in order (stops not moved or reordered since)
 *   estimate  straight-line estimate (no road route yet) or not current
 *   legMinutes[i]  drive minutes from stop i to stop i + 1 (0 at the same place): miles along the stored line at the
 *             route's average pace, or straight line × road factor at 50 mph when there is no current route.
 */
export function routeInfo(c, stops, loadsById) {
  const rp = routePoints(stops, loadsById);
  const line = storedLine(c);
  let idx = null;
  if (rp && rp.points.length < 2) idx = rp.points.map(() => 0);
  else if (rp && line && line.length >= 2) idx = matchPoints(line, rp.points);
  const current = !!idx && (rp.points.length < 2 || c.routeMiles != null);
  const cum = [];
  if (current && line && rp.points.length >= 2) {
    let acc = 0;
    cum.push(0);
    for (let i = 1; i < line.length; i++) { acc += segmentMiles(line[i - 1], line[i]); cum.push(acc); }
  }
  const lineMiles = cum.length ? cum[cum.length - 1] : 0;
  const pace = current && lineMiles > 0 && c.routeMinutes != null ? c.routeMinutes / lineMiles : null;
  const legMinutes = [];
  for (let i = 0; i < stops.length - 1; i++) {
    if (!rp) { legMinutes.push(null); continue; }
    const a = rp.stopIndex[i];
    const b = rp.stopIndex[i + 1];
    if (a === b) { legMinutes.push(0); continue; }
    if (pace != null) { legMinutes.push((cum[idx[b]] - cum[idx[a]]) * pace); continue; }
    const pa = rp.points[a];
    const pb = rp.points[b];
    legMinutes.push(((segmentMiles([pa.lng, pa.lat], [pb.lng, pb.lat]) * ROAD_FACTOR) / ESTIMATE_MPH) * 60);
  }
  return {
    current,
    estimate: !current || !c.routeComputedAt,
    stateOnly: !!rp?.stateOnly,
    legMinutes,
    points: rp?.points || [],
  };
}

const routePending = new Map(); // `${id}|${stops}` -> promise

/**
 * Compute and store the trip's route for its stops as they are now. Writes only if the stops did not change meanwhile,
 * and never replaces a current road route with an estimate. Returns the stored fields or null.
 */
export async function refreshConsolidationRoute(id, { deadlineMs = 8000 } = {}) {
  const c = await prisma.consolidation.findUnique({ where: { id: String(id) } });
  if (!c || !ACTIVE_CONSOLIDATION.includes(c.status)) return null;
  const key = `${c.id}|${c.stops}`;
  if (routePending.has(key)) return routePending.get(key);
  const p = (async () => {
    const all = parseStops(c.stops);
    const loads = await prisma.load.findMany({
      where: { consolidationId: c.id, id: { in: [...new Set(all.map((s) => s.loadId))] } },
      include: ROUTE_INCLUDE, omit: { routeGeometry: true }, take: MAX_LOADS * 4,
    });
    const byId = new Map(loads.map((l) => [l.id, l]));
    const stops = all.filter((s) => byId.has(s.loadId));
    const fields = await computeRoute(stops, byId, { deadlineMs });
    if (!fields) return null;
    const before = routeInfo(c, stops, byId);
    if (fields.estimate && before.current && !before.estimate) return null;
    const { estimate, ...data } = fields;
    const { count } = await prisma.consolidation.updateMany({ where: { id: c.id, stops: c.stops }, data });
    return count ? { ...data, estimate } : null;
  })().finally(() => routePending.delete(key));
  routePending.set(key, p);
  return p;
}

// Background retries (estimates, moved stops): one at a time per process, bounded queue. Only a retry: every read
// schedules it again when needed, so a lost queue (restart, another worker) costs nothing but a later retry.
const routeQueue = [];
const ROUTE_QUEUE_MAX = 100;
let routeRunning = 0;

function pumpRoutes() {
  while (routeRunning < 1 && routeQueue.length) {
    const id = routeQueue.shift();
    routeRunning++;
    refreshConsolidationRoute(id, { deadlineMs: 30_000 })
      .catch((err) => console.error(`[fleet] route for consolidated trip ${id} failed: ${err.message}`))
      .finally(() => { routeRunning--; pumpRoutes(); });
  }
}

export function scheduleConsolidationRoute(id) {
  if (!id || routeQueue.includes(id) || routeQueue.length >= ROUTE_QUEUE_MAX) return false;
  routeQueue.push(id);
  setImmediate(pumpRoutes);
  return true;
}

/** Resolves true once no consolidated-trip route is queued or being computed in this process (tests, shutdown). */
export async function consolidationRoutesIdle({ timeoutMs = 10_000 } = {}) {
  const until = Date.now() + timeoutMs;
  const busy = () => routeQueue.length > 0 || routeRunning > 0 || routePending.size > 0;
  while (busy() && Date.now() < until) {
    await Promise.allSettled([...routePending.values()]);
    if (busy()) await new Promise((r) => setTimeout(r, 5));
  }
  return !busy();
}

const routeBusy = (id) => routeQueue.includes(id) || [...routePending.keys()].some((k) => k.startsWith(`${id}|`));

/**
 * Ask for a new route when the stored one no longer matches the stops, or is an estimate older than 5 minutes.
 * True when a route for the trip is on its way (queued or being computed in this process, or not current).
 */
function maybeReroute(c, info, now = Date.now()) {
  if (!ACTIVE_CONSOLIDATION.includes(c.status) || info.stateOnly || info.points.length < 2) return false;
  if (!info.current) { scheduleConsolidationRoute(c.id); return true; }
  if (info.estimate && now - new Date(c.updatedAt).getTime() > 5 * MIN) scheduleConsolidationRoute(c.id);
  return routeBusy(c.id);
}

// ---------------------------------------------------------------------------
// ETAs and on-time risk per stop
// ---------------------------------------------------------------------------

/**
 * ETAs for the stops still ahead, in the trip's order: from the truck's position (straight line × road factor at 50 mph
 * to the first open stop), then each leg's drive minutes, waiting for each appointment window to open and the load's
 * free time at each dock, through the hours-of-service rules (latest hours report, else full clocks). The same rules as
 * the single-trip plan (services/fleet/progress.js). Without a truck position no ETA is given.
 * Returns [{ eta, legalEta, risk }] aligned with `stops`.
 */
export function planStops(stops, loadsById, { position = null, hos = null, now = Date.now(), legMinutes = [] } = {}) {
  const { clocks } = currentClocks(hos, now, null);
  const segments = [];
  let ok = position?.lat != null && position?.lng != null;
  let cursor = ok ? { lat: position.lat, lng: position.lng } : null;
  let last = -1;
  let prevDock = 0;
  stops.forEach((s, i) => {
    const load = loadsById.get(s.loadId);
    if (!ok || !load || stopDone(load, s.kind)) return;
    const p = stopPoint(load, s.kind);
    if (!p || p.precision === 'state') { ok = false; return; }
    if (prevDock) segments.push({ onDuty: prevDock });
    const leg = last === i - 1 && last >= 0 ? legMinutes[last] : null;
    if (leg != null) segments.push({ drive: leg });
    else {
      const miles = segmentMiles([cursor.lng, cursor.lat], [p.lng, p.lat]);
      if (miles > 1) segments.push({ drive: ((miles * ROAD_FACTOR) / ESTIMATE_MPH) * 60 });
    }
    segments.push({ mark: String(i) });
    const w = stopWindow(load, s.kind);
    if (w?.start) segments.push({ waitUntil: new Date(w.start).getTime() });
    prevDock = (load.freeTimeHours ?? 2) * 60;
    cursor = p;
    last = i;
  });
  const plain = simulate(now, segments, null, { legal: false });
  const legal = simulate(now, segments, clocks, { legal: true });
  return stops.map((s, i) => {
    const load = loadsById.get(s.loadId);
    const eta = plain.marks[String(i)] ?? null;
    const legalEta = legal.marks[String(i)] ?? null;
    return {
      eta: eta != null ? new Date(eta) : null,
      legalEta: legalEta != null ? new Date(legalEta) : null,
      risk: load && !stopDone(load, s.kind) ? riskFor(legalEta ?? eta, stopWindow(load, s.kind)) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** Load columns the views need (no geometry). */
export const LOAD_VIEW_SELECT = Object.freeze({
  id: true, ownerId: true, carrierId: true, consolidationId: true, status: true, referenceNumber: true,
  originCity: true, originState: true, originLat: true, originLng: true, destCity: true, destState: true, destLat: true, destLng: true,
  pickupDate: true, deliveryDate: true, pickupWindowStart: true, pickupWindowEnd: true, deliveryWindowStart: true, deliveryWindowEnd: true,
  pickupTz: true, deliveryTz: true, pickupFacility: true, pickupAddress: true, deliveryFacility: true, deliveryAddress: true,
  freeTimeHours: true, rateCents: true, loadedMiles: true, commodity: true, weightLbs: true, equipment: true, createdAt: true,
  broker: { select: { id: true, companyName: true } },
});

export function loadSummary(l) {
  return {
    id: l.id, referenceNumber: l.referenceNumber, status: l.status, carrierId: l.carrierId,
    origin: { city: l.originCity, state: l.originState }, dest: { city: l.destCity, state: l.destState },
    rateCents: l.rateCents, loadedMiles: l.loadedMiles, commodity: l.commodity ?? null, weightLbs: l.weightLbs ?? null,
    broker: l.broker ? { id: l.broker.id, companyName: l.broker.companyName } : null,
  };
}

// Map display needs a few hundred points; simplified once per route version.
const DISPLAY_POINTS = 400;
const displayMemo = new Map();
const DISPLAY_MEMO_MAX = 500;
function displayGeometry(c) {
  const line = storedLine(c);
  if (!line) return null;
  if (line.length <= DISPLAY_POINTS) return c.routeGeometry;
  const key = `${c.id}:${new Date(c.updatedAt).getTime()}:${c.routeGeometry.length}`;
  let out = displayMemo.get(key);
  if (!out) {
    out = encodePolyline(simplifyToBudget(line, DISPLAY_POINTS, 100));
    if (displayMemo.size >= DISPLAY_MEMO_MAX) displayMemo.delete(displayMemo.keys().next().value);
    displayMemo.set(key, out);
  }
  return out;
}

/**
 * API shape of a consolidated trip. `loads` are the loads on it (LOAD_VIEW_SELECT). Options:
 *   plan: { position, hos, now } adds ETAs and on-time risk per open stop
 *   geometry: true adds route.geometry (simplified for the map)
 * A stored route that no longer matches the stops is reported as not current and computed again in the background.
 */
export function consolidationView(c, loads, { plan = null, geometry = false, now = Date.now() } = {}) {
  const byId = new Map(loads.map((l) => [l.id, l]));
  const stops = parseStops(c.stops).filter((s) => byId.has(s.loadId));
  const info = routeInfo(c, stops, byId);
  const pending = maybeReroute(c, info, now);
  const timing = plan && ACTIVE_CONSOLIDATION.includes(c.status) ? planStops(stops, byId, { ...plan, now, legMinutes: info.legMinutes }) : null;
  const views = stops.map((s, i) => {
    const l = byId.get(s.loadId);
    const p = s.kind === 'pickup';
    const pt = stopPoint(l, s.kind);
    const w = stopWindow(l, s.kind);
    return {
      n: i + 1, loadId: s.loadId, kind: s.kind, done: stopDone(l, s.kind),
      city: p ? l.originCity : l.destCity, state: p ? l.originState : l.destState,
      lat: pt?.lat ?? null, lng: pt?.lng ?? null,
      facility: (p ? l.pickupFacility : l.deliveryFacility) || null,
      address: (p ? l.pickupAddress : l.deliveryAddress) || null,
      window: w ? { start: w.start, end: w.end, tz: w.tz, ...(w.dateOnly ? { dateOnly: true } : {}) } : null,
      driveMinutesFromPrevious: i > 0 && info.legMinutes[i - 1] != null ? Math.round(info.legMinutes[i - 1]) : null,
      load: { id: l.id, referenceNumber: l.referenceNumber, status: l.status, rateCents: l.rateCents, broker: l.broker ? { id: l.broker.id, companyName: l.broker.companyName } : null },
      eta: timing?.[i]?.eta ?? null,
      legalEta: timing?.[i]?.legalEta ?? null,
      risk: timing?.[i]?.risk ?? null,
    };
  });
  const ordered = [...new Set(stops.map((s) => s.loadId))].map((id) => byId.get(id));
  return {
    id: c.id, ownerId: c.ownerId, carrierId: c.carrierId, name: c.name, title: titleOf(c, stops, byId), status: c.status,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
    loadIds: ordered.map((l) => l.id),
    loads: ordered.map(loadSummary),
    stops: views,
    risk: worstRisk(views.map((s) => s.risk)),
    route: {
      miles: c.routeMiles != null && info.current ? Math.round(c.routeMiles) : null,
      minutes: info.current ? c.routeMinutes ?? null : null,
      estimate: info.estimate,
      current: info.current,
      computedAt: info.current ? c.routeComputedAt : null,
      pending: !!pending,
      stateOnly: info.stateOnly,
      ...(geometry ? { geometry: info.current ? displayGeometry(c) : encodePolyline(info.points.map((p) => [p.lng, p.lat])) } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Membership and status sync
// ---------------------------------------------------------------------------

/** Timeline note on a load when it joins or leaves a consolidated trip. */
export function recordMembership(load, c, { action, title, note = null, by = null, source = 'dispatcher', stops = null }) {
  let text = note;
  if (!text) {
    if (action === 'joined') {
      const at = (stops || []).map((s, i) => (s.loadId === load.id ? i + 1 : null)).filter(Boolean);
      text = `Added to consolidated trip "${title}"${at.length === 2 ? ` (stops ${at[0]} and ${at[1]} of ${stops.length})` : ''}`;
    } else {
      text = `Removed from consolidated trip "${title}"`;
    }
  }
  return recordLoadEvent({
    loadId: load.id, ownerId: load.ownerId, type: 'note', source, note: text,
    data: { consolidation: { id: c.id, action }, ...(by ? { by } : {}) },
  });
}

/**
 * End a trip: every load is detached (back to a plain trip, nothing else about it changes) with a timeline note, and the
 * trip is kept as canceled. Returns the number of loads detached.
 */
export async function dissolveConsolidation(c, { reason, by = null, source = 'dispatcher', title = null } = {}) {
  const loads = await prisma.load.findMany({ where: { consolidationId: c.id }, select: { id: true, ownerId: true }, take: 50 });
  const name = title || c.name || 'consolidated trip';
  let n = 0;
  for (const l of loads) {
    const { count } = await prisma.load.updateMany({ where: { id: l.id, consolidationId: c.id }, data: { consolidationId: null } });
    if (!count) continue;
    n++;
    await recordMembership(l, c, { action: 'left', title: name, note: `Consolidated trip "${name}" ${reason}`, by, source });
  }
  await prisma.consolidation.update({ where: { id: c.id }, data: { status: 'canceled' } });
  return n;
}

/**
 * Keep a trip in step with its loads (call after a load's status, truck or existence changed):
 *   - canceled loads and loads moved to another truck leave the trip (timeline note on each)
 *   - stops of loads no longer on it are dropped; a load on it without stops gets them at the end
 *   - status follows the loads (deriveStatus); with fewer than 2 loads left the trip ends (dissolveConsolidation)
 * Safe to call from any process at any time. Returns { consolidation, dissolved, left } or null when there is no trip.
 */
export async function syncConsolidation(id, { by = null, source = 'system' } = {}) {
  if (!id) return null;
  const c = await prisma.consolidation.findUnique({ where: { id: String(id) } });
  if (!c) return null;
  if (c.status === 'canceled') return { consolidation: c, dissolved: false, left: [] };
  const loads = await prisma.load.findMany({
    where: { consolidationId: c.id },
    select: { id: true, ownerId: true, carrierId: true, status: true, referenceNumber: true, originCity: true, originState: true, destCity: true, destState: true, pickupWindowStart: true, pickupWindowEnd: true, pickupDate: true, deliveryWindowStart: true, deliveryWindowEnd: true, deliveryDate: true },
    take: 50,
  });
  const stops = parseStops(c.stops);
  const byId = new Map(loads.map((l) => [l.id, l]));
  const title = titleOf(c, stops.filter((s) => byId.has(s.loadId)), byId);
  const leaving = loads.filter((l) => l.status === 'canceled' || l.carrierId !== c.carrierId);
  const left = [];
  for (const l of leaving) {
    const { count } = await prisma.load.updateMany({ where: { id: l.id, consolidationId: c.id }, data: { consolidationId: null } });
    if (!count) continue;
    left.push(l.id);
    const why = l.status === 'canceled' ? 'the load was canceled' : 'the load moved to another truck';
    await recordMembership(l, c, { action: 'left', title, note: `Left consolidated trip "${title}": ${why}`, by, source });
  }
  const staying = loads.filter((l) => !leaving.includes(l));
  if (staying.length < MIN_LOADS) {
    await dissolveConsolidation(c, { reason: 'ended: fewer than 2 loads left on it', by, source, title });
    return { consolidation: { ...c, status: 'canceled' }, dissolved: true, left };
  }
  const ids = staying.map((l) => l.id);
  const stayingById = new Map(staying.map((l) => [l.id, l]));
  let next = stops.filter((s) => stayingById.has(s.loadId));
  for (const l of staying) {
    if (!next.some((s) => s.loadId === l.id)) next.push({ loadId: l.id, kind: 'pickup' }, { loadId: l.id, kind: 'delivery' });
  }
  if (!checkStops(next, ids, stayingById).ok) next = defaultStops(staying);
  const data = {};
  const json = stopsJson(next);
  if (json !== c.stops) data.stops = json;
  const status = deriveStatus(staying);
  if (status !== c.status) data.status = status;
  if (!Object.keys(data).length) return { consolidation: c, dissolved: false, left };
  const updated = await prisma.consolidation.update({ where: { id: c.id }, data });
  if (data.stops) scheduleConsolidationRoute(c.id);
  return { consolidation: updated, dissolved: false, left };
}

/** True when a trip read with its loads (LOAD_VIEW_SELECT) is out of step with them and needs syncConsolidation(). */
export function needsSync(c, loads) {
  if (c.status === 'canceled') return false;
  const staying = loads.filter((l) => l.status !== 'canceled' && l.carrierId === c.carrierId);
  if (staying.length !== loads.length || staying.length < MIN_LOADS) return true;
  if (deriveStatus(staying) !== c.status) return true;
  return !checkStops(parseStops(c.stops), staying.map((l) => l.id)).ok;
}

/** Truck position for ETAs: { lat, lng } from the carrier's last known location, or null. */
export function truckPosition(carrier) {
  if (!carrier) return null;
  const p = pointFor(carrier.locationCity, carrier.locationState, carrier.locationLat, carrier.locationLng);
  return p && p.precision !== 'state' ? { lat: p.lat, lng: p.lng } : null;
}
