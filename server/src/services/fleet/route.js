import { prisma } from '../../db.js';
import { routeEncoded } from '../market/live.js';
import { decodePolyline, encodePolyline, pinEnds } from './polyline.js';
import { measureRoute, projectOnRoute, routeLru } from './progress.js';
import { loadEnds, routeIsCurrent } from './index.js';

/**
 * Road routes for loads (pickup -> delivery) and for deadhead legs (truck -> pickup).
 *
 * A load's route is computed once through the OSRM-backed helper in services/market/live.js (cached, throttled to the
 * public server's fair-use budget, straight-line fallback marked as an estimate) and stored on the Load:
 * routeGeometry (encoded polyline whose first and last points are exactly the load's pickup and delivery coordinates),
 * routeMiles, routeMinutes, routeSource ('osrm' | 'estimate') and routeComputedAt. Moving the pickup or delivery makes
 * the stored route stale (routeIsCurrent() is false) and it is computed again.
 *
 *   ensureLoadRoute(load, { force }) -> stored fields | null   compute now (one in flight per load and process)
 *   scheduleLoadRoute(load)                                    same, in the background (bounded queue)
 *   deadheadRoute({ carrierId, loadId, from, to }) -> { encoded, miles, minutes, source, estimate }
 * routeIsCurrent(load) and routeMeta(load) live in ./index.js (they are part of the trip views).
 */

/** Route fields for a pickup/delivery pair, without writing anything. */
export async function computeRouteFields(from, to) {
  const r = await routeEncoded(from, to);
  return {
    routeGeometry: encodePolyline(pinEnds(decodePolyline(r.encoded), from, to)),
    routeMiles: r.miles,
    routeMinutes: r.minutes,
    routeSource: r.estimate ? 'estimate' : 'osrm',
    routeComputedAt: new Date(),
  };
}

const pending = new Map();

/**
 * Compute and store the load's road route when it is missing, stale or only an estimate.
 * Never replaces a current road route with an estimate (router down or busy), and writes only if the pickup and
 * delivery did not change while the route was being computed. Loads with a stop known only by its state are skipped.
 */
export async function ensureLoadRoute(load, { force = false } = {}) {
  if (!load) return null;
  const current = routeIsCurrent(load);
  if (!force && current && load.routeSource === 'osrm') return null;
  const { from, to } = loadEnds(load);
  if (!from || !to) return null;
  // A stop known only by its state has no real road route (see routable() in ./index.js): keep the straight estimate.
  if (from.precision === 'state' || to.precision === 'state') return null;
  if (pending.has(load.id)) return pending.get(load.id);
  const p = (async () => {
    const data = await computeRouteFields(from, to);
    if (data.routeSource === 'estimate' && current) return null;
    const { count } = await prisma.load.updateMany({
      where: { id: load.id, originLat: load.originLat ?? null, originLng: load.originLng ?? null, destLat: load.destLat ?? null, destLng: load.destLng ?? null },
      data,
    });
    return count ? data : null;
  })().finally(() => pending.delete(load.id));
  pending.set(load.id, p);
  return p;
}

// Background route computation: a small bounded queue per process, so a map with many old loads never fires a burst
// of routing calls (the router throttle answers with estimates when busy; the fleet backfill job retries those).
const queue = [];
const QUEUE_MAX = 200;
let running = 0;
const CONCURRENCY = 2;

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const load = queue.shift();
    running++;
    ensureLoadRoute(load)
      .catch((err) => console.error(`[fleet] route for load ${load.id} failed: ${err.message}`))
      .finally(() => { running--; pump(); });
  }
}

export function scheduleLoadRoute(load) {
  if (!load || pending.has(load.id) || queue.some((l) => l.id === load.id)) return false;
  if (queue.length >= QUEUE_MAX) return false;
  queue.push(load);
  setImmediate(pump);
  return true;
}

/**
 * Resolves true once this process has no queued or running route computation (or false after timeoutMs).
 * Lets tests and shutdown code wait for the background work instead of racing it.
 */
export async function routeQueueIdle({ timeoutMs = 10_000 } = {}) {
  const until = Date.now() + timeoutMs;
  const busy = () => queue.length > 0 || running > 0 || pending.size > 0;
  while (busy() && Date.now() < until) {
    await Promise.allSettled([...pending.values()]);
    if (busy()) await new Promise((r) => setTimeout(r, 5));
  }
  return !busy();
}

// ---------------------------------------------------------------------------
// Deadhead (truck -> pickup): computed on demand and cached per truck and load in this process. While the truck moves
// along the cached route it is reused (the map trims it at the truck), so a moving truck does not cost a routing call
// per position update; it is computed again when the truck leaves it or after a few hours.
// ---------------------------------------------------------------------------
const DEADHEAD_TTL = 6 * 3600_000;
const REUSE_OFF_MILES = 3;
// Byte-bounded like the trip-route cache: the measured route (packed points) plus the encoded string for the map.
const deadheads = routeLru({ maxBytes: 12 * 1024 * 1024, ttlMs: DEADHEAD_TTL });

export function clearDeadheadCache() { deadheads.clear(); }

export async function deadheadRoute({ carrierId, loadId, from, to, fetch = true }) {
  const key = `${carrierId}:${loadId}`;
  const now = Date.now();
  const hit = deadheads.get(key, now);
  if (hit && Math.abs(hit.to.lat - to.lat) < 1e-4 && Math.abs(hit.to.lng - to.lng) < 1e-4) {
    // An estimate (router was down or busy) is tried again after a few minutes.
    const retryEstimate = hit.route.estimate && fetch && now - hit.at > 5 * 60_000;
    const snap = retryEstimate ? null : projectOnRoute(hit.measured, from);
    if (snap && snap.offMiles <= REUSE_OFF_MILES) return { ...hit.route, cached: true };
  }
  if (!fetch) return { ...estimateFor(from, to), pending: true };
  const r = await routeEncoded(from, to);
  const route = {
    encoded: encodePolyline(pinEnds(decodePolyline(r.encoded), from, to)), miles: r.miles, minutes: r.minutes,
    source: r.estimate ? 'estimate' : 'osrm', estimate: !!r.estimate,
  };
  const measured = measureRoute(route.encoded);
  deadheads.set(key, { at: now, to, route, measured }, measured.bytes + route.encoded.length * 2, now);
  return route;
}

function estimateFor(from, to) {
  return { encoded: encodePolyline([[from.lng, from.lat], [to.lng, to.lat]]), miles: null, minutes: null, source: 'estimate', estimate: true };
}
