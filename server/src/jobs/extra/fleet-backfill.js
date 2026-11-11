import { prisma } from '../../db.js';
import { ensureLoadRoute, withRouteGeometry } from '../../services/fleet/route.js';
import { routable } from '../../services/fleet/index.js';

/**
 * Fleet maintenance:
 * - fleet-flag-backfill: one-time pass that sets Carrier.isFleet for trucks that were on the map before the flag existed
 *   (customer, a status, a position or an active trip). Runs in small rowid batches with a saved cursor and a time
 *   budget, so even a large table is done without long write locks; afterwards every run is a single key lookup.
 * - fleet-routes: computes road routes for active loads that have none yet or only a straight-line estimate (router was
 *   down or busy, or the load was created on another page). A few loads per run, within the router's fair-use budget.
 *   Loads with a stop known only by its state are marked routeSource 'none' and left as straight estimates.
 *   It walks users with a saved cursor (a few hundred per step, through the Load(ownerId, status) index) and stops as
 *   soon as it has enough candidates, so a run never reads or sorts every active load on the platform.
 * - route-geometry-cleanup: deletes the stored road polyline (LoadRoute row) of finished and canceled loads (status
 *   changes in the app already do; this catches the rest and older rows), walking LoadRoute in small rowid batches
 *   with a saved cursor and a time budget.
 */
const MIN = 60_000;
const BACKFILL_KEY = 'fleet.backfill.isFleet';
const ROUTES_KEY = 'fleet.routes.cursor';
const CLEANUP_KEY = 'fleet.routes.cleanup';
const BATCH = 2000;
// LoadRoute rows are 10-20 KB each: smaller delete batches keep each write lock short.
const ROUTE_BATCH = 500;
const ACTIVE = ['planned', 'booked', 'in_transit'];
const FINISHED = ['delivered', 'invoiced', 'paid', 'canceled'];

async function readState(key = BACKFILL_KEY) {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}
async function writeState(state, key = BACKFILL_KEY) {
  const value = JSON.stringify(state);
  await prisma.systemSetting.upsert({ where: { key }, create: { key, value, secret: false }, update: { value } });
}

export async function backfillFleetFlags({ budgetMs = 3000 } = {}) {
  const state = await readState();
  if (state.done) return { skipped: 'done', updated: 0 };
  const started = Date.now();
  let after = Number(state.after) || 0;
  let updated = 0;
  let done = false;
  while (Date.now() - started < budgetMs) {
    const [{ last } = {}] = await prisma.$queryRawUnsafe(`SELECT MAX(rid) AS "last" FROM (SELECT rowid AS rid FROM "Carrier" WHERE rowid > ? ORDER BY rowid LIMIT ${BATCH})`, after);
    if (last == null) { done = true; break; }
    updated += Number(await prisma.$executeRawUnsafe(
      `UPDATE "Carrier" SET "isFleet" = 1
       WHERE rowid > ? AND rowid <= ? AND "isFleet" = 0
         AND ("truckStatus" <> 'unknown' OR "locationLat" IS NOT NULL OR "locationState" IS NOT NULL
           OR EXISTS (SELECT 1 FROM "Customer" c WHERE c."carrierId" = "Carrier"."id")
           OR EXISTS (SELECT 1 FROM "Load" l WHERE l."carrierId" = "Carrier"."id" AND l."status" IN ('planned', 'booked', 'in_transit')))`,
      after, Number(last),
    ));
    after = Number(last);
  }
  await writeState({ after, done, ...(done ? { finishedAt: new Date().toISOString() } : {}) });
  return { updated, done, after };
}

const RETRY_ESTIMATE_MS = 30 * MIN;
const lastTry = (l) => (l.routeComputedAt ? new Date(l.routeComputedAt).getTime() : 0);

/**
 * Candidate loads (never routed, or only an estimate older than the retry interval), found by walking users from the
 * saved cursor in steps of `usersPerStep`: each step is one query on the Load(ownerId, status) index for those owners,
 * with no ORDER BY over the whole set. Stops once `want` candidates are found, after `maxUsers` users, or after one
 * full pass (the cursor wraps around). The cursor stays on a step that had more candidates than were taken, so the
 * next run continues there.
 */
async function routeCandidates(now, { want, usersPerStep = 200, maxUsers = 5000, budgetMs = 2000 } = {}) {
  const cutoff = new Date(now.getTime() - RETRY_ESTIMATE_MS);
  const started = Date.now();
  const state = await readState(ROUTES_KEY);
  let cursor = typeof state.after === 'string' ? state.after : '';
  let wrapped = !cursor;
  let scanned = 0;
  const found = [];
  while (found.length < want && scanned < maxUsers && Date.now() - started < budgetMs) {
    const users = await prisma.user.findMany({ where: { id: { gt: cursor } }, select: { id: true }, orderBy: { id: 'asc' }, take: usersPerStep });
    if (!users.length) {
      cursor = '';
      if (wrapped) break;
      wrapped = true;
      continue;
    }
    scanned += users.length;
    const left = want - found.length;
    const rows = await prisma.load.findMany({
      where: {
        ownerId: { in: users.map((u) => u.id) }, status: { in: ACTIVE },
        OR: [{ routeComputedAt: null }, { routeSource: 'estimate', routeComputedAt: { lt: cutoff } }, { routeSource: null, routeComputedAt: { lt: cutoff } }],
      },
      select: { id: true }, take: left + 1,
    });
    found.push(...rows.slice(0, left).map((r) => r.id));
    // More candidates than taken in this step: stay on it (handled loads drop out once their attempt is noted).
    if (rows.length > left) break;
    cursor = users[users.length - 1].id;
  }
  await writeState({ after: cursor }, ROUTES_KEY);
  return found;
}

export async function refreshRoutes(now = new Date(), { maxLoads = 8, budgetMs = 20000 } = {}) {
  const started = Date.now();
  // Never-routed loads and loads with an old estimate, oldest attempt first within the batch: loads the router keeps
  // failing on take their turn instead of holding the batch, so every load is reached.
  const ids = await routeCandidates(now, { want: Math.max(maxLoads * 3, 24) });
  if (!ids.length) return { candidates: 0, computed: 0, roads: 0, stateOnly: 0 };
  const loads = await prisma.load.findMany({ where: { id: { in: ids } } });
  // A stop known only by its state gets no road route: mark those once ('none') so later runs skip them. If a real place
  // is entered later, the fleet map's route request works the route out (routeIsCurrent() is false without geometry).
  const stateOnly = loads.filter((l) => !routable(l)).map((l) => l.id);
  if (stateOnly.length) await prisma.load.updateMany({ where: { id: { in: stateOnly } }, data: { routeSource: 'none', routeComputedAt: now } });
  const skip = new Set(stateOnly);
  // The stored shapes of the batch in one query (ensureLoadRoute compares them with the stops).
  const due = await withRouteGeometry(loads
    .filter((l) => !skip.has(l.id))
    .sort((a, b) => lastTry(a) - lastTry(b) || new Date(a.createdAt) - new Date(b.createdAt))
    .slice(0, maxLoads));
  let computed = 0;
  let roads = 0;
  for (const l of due) {
    if (Date.now() - started > budgetMs) break;
    const res = await ensureLoadRoute(l, { force: true });
    if (res) { computed++; if (res.routeSource === 'osrm') roads++; }
    // The router still had no answer: note the attempt (estimate kept, or nothing stored yet), so the next runs reach
    // other loads and retry this one after the retry interval.
    else await prisma.load.updateMany({ where: { id: l.id, OR: [{ routeSource: 'estimate' }, { routeSource: null }] }, data: { routeComputedAt: new Date() } });
  }
  return { candidates: ids.length, computed, roads, stateOnly: stateOnly.length };
}

/**
 * Delete the stored road route (LoadRoute row) of finished and canceled loads, walking LoadRoute by rowid from a saved
 * cursor (wraps around). Miles, minutes and the route source stay on the Load. Returns { cleared, after, wrapped }.
 */
export async function clearFinishedGeometry({ budgetMs = 3000 } = {}) {
  const state = await readState(CLEANUP_KEY);
  const started = Date.now();
  let after = Number(state.after) || 0;
  let cleared = 0;
  let wrapped = false;
  const statuses = FINISHED.map((x) => `'${x}'`).join(', ');
  while (Date.now() - started < budgetMs) {
    const [{ last } = {}] = await prisma.$queryRawUnsafe(`SELECT MAX(rid) AS "last" FROM (SELECT rowid AS rid FROM "LoadRoute" WHERE rowid > ? ORDER BY rowid LIMIT ${ROUTE_BATCH})`, after);
    if (last == null) { after = 0; wrapped = true; break; }
    // One primary-key lookup on Load per route row (correlated EXISTS, never a scan of all finished loads).
    cleared += Number(await prisma.$executeRawUnsafe(
      `DELETE FROM "LoadRoute" WHERE rowid > ? AND rowid <= ?
         AND EXISTS (SELECT 1 FROM "Load" l WHERE l."id" = "LoadRoute"."loadId" AND l."status" IN (${statuses}))`,
      after, Number(last),
    ));
    after = Number(last);
  }
  await writeState({ after }, CLEANUP_KEY);
  return { cleared, after, wrapped };
}

export const jobs = [
  { name: 'fleet-flag-backfill', label: 'Mark existing trucks for the fast fleet map query (one-time)', everyMs: 10 * MIN, run: () => backfillFleetFlags() },
  { name: 'fleet-routes', label: 'Compute road routes for active loads that have none yet', everyMs: 10 * MIN, run: (now) => refreshRoutes(now) },
  { name: 'route-geometry-cleanup', label: 'Clear stored road routes of finished and canceled loads', everyMs: 60 * MIN, run: () => clearFinishedGeometry() },
];
