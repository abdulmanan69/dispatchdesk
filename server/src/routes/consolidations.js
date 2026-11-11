import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest, conflict, notFound } from '../lib/errors.js';
import { parse, z, optStr } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { loadCarrier, loadOwned, readableOwnerIds } from '../lib/access.js';
import { logActivity } from '../lib/activity.js';
import { pointFor } from '../services/fleet/index.js';
import { latestHos } from '../services/fleet/insights.js';
import { invalidateToday } from '../services/fleet/today.js';
import { fitColumns } from '../services/loads/fitCheck.js';
import { STATUS_FLOW, assertTransition, afterStatusChange } from '../services/loads/status.js';
import {
  MIN_LOADS, MAX_LOADS, ACTIVE_CONSOLIDATION, JOINABLE, LOAD_VIEW_SELECT,
  parseStops, stopsJson, defaultStops, checkStops, insertStops, stopDone, deriveStatus, titleOf, loadLabel,
  consolidationView, refreshConsolidationRoute, syncConsolidation, dissolveConsolidation, recordMembership, needsSync, truckPosition,
} from '../services/fleet/consolidation.js';

/**
 * Consolidated trips (/api/consolidations): several customers' loads on one truck, driven in one stop order.
 * Each load keeps its own rate, invoice and documents; the trip groups them for the road route, the stop order and an
 * overall status (see services/fleet/consolidation.js). Reads are owner/team scoped like loads; anything else is a 404.
 *
 *   GET    /                 trips (active by default) of the user, or of one truck (?carrierId=, with ETAs per stop)
 *   GET    /candidates       open loads that can go on a truck's trip (?carrierId=), plus loads with no truck yet
 *   GET    /:id              one trip with its stops, ETAs and route
 *   POST   /                 { carrierId, loadIds (2-6), name?, stops? } group loads; default order: pickups then deliveries by window
 *   PATCH  /:id              { stops?, name? } reorder (a permutation, each pickup before its delivery) or rename
 *   POST   /:id/loads        { action: 'add' | 'remove', loadId, stops? } add or take off one load
 *   POST   /:id/status       { status, force? } move every load forward (booked, in transit, delivered), or end the trip (canceled)
 *   DELETE /:id              ungroup: the loads stay as plain trips
 */
const r = Router();
r.use(requirePermission('crm.use'));

const id = z.string().trim().min(1).max(40);
const flag = z.enum(['0', '1', 'true', 'false']).optional().transform((v) => v === '1' || v === 'true');
const stopSchema = z.object({ loadId: id, kind: z.enum(['pickup', 'delivery']) });
const stopList = z.array(stopSchema).max(MAX_LOADS * 2);
const pretty = (s) => String(s || '').replace(/_/g, ' ');
// Routing inside a request is bounded: legs not answered in time are estimates and are computed again in the background.
const ROUTE_DEADLINE_MS = 8000;

const loadsOf = (consolidationIds) => prisma.load.findMany({
  where: { consolidationId: { in: consolidationIds } }, select: LOAD_VIEW_SELECT, take: consolidationIds.length * 12,
});

/** A trip readable by the user (404 otherwise), synced with its loads first when it is out of step. */
async function readTrip(user, tripId, { write = false } = {}) {
  let c = await loadOwned('consolidation', user, tripId, { write });
  let loads = await loadsOf([c.id]);
  if (needsSync(c, loads)) {
    await syncConsolidation(c.id, { by: user.id });
    c = await prisma.consolidation.findUnique({ where: { id: c.id } });
    loads = await loadsOf([c.id]);
  }
  return { c, loads };
}

/** Truck position and the latest hours report of the trip's loads, for ETAs per stop. */
async function planInputs(carrierId, loadIds, carrier = null) {
  const truck = carrier || await prisma.carrier.findUnique({ where: { id: carrierId }, select: { locationCity: true, locationState: true, locationLat: true, locationLng: true } });
  const hos = Object.values(await latestHos(loadIds)).sort((a, b) => b.at - a.at)[0] || null;
  return { position: truckPosition(truck), hos };
}

async function fullView(c, loads, { geometry = true } = {}) {
  const plan = ACTIVE_CONSOLIDATION.includes(c.status) ? await planInputs(c.carrierId, loads.map((l) => l.id)) : null;
  return consolidationView(c, loads, { plan, geometry });
}

/** Compute the road route now (bounded); a routing failure never fails the request. */
async function routeNow(tripId) {
  try {
    await refreshConsolidationRoute(tripId, { deadlineMs: ROUTE_DEADLINE_MS });
  } catch (err) {
    console.error(`[fleet] route for consolidated trip ${tripId} failed: ${err.message}`);
  }
}

/**
 * A load that may join a trip on `carrierId`: writable by the user, open (planned, booked or in transit), on that truck
 * or on no truck yet, and not on another active trip.
 */
async function joinable(user, loadId, carrierId, ownTripId = null) {
  const load = await loadOwned('load', user, loadId, { write: true });
  if (!JOINABLE.includes(load.status)) throw badRequest(`${loadLabel(load)} is ${pretty(load.status)}: only planned, booked or in-transit loads can share a trip`, { code: 'LOAD_CLOSED', loadId: load.id });
  if (load.carrierId && load.carrierId !== carrierId) throw badRequest(`${loadLabel(load)} is on another truck`, { code: 'OTHER_TRUCK', loadId: load.id });
  if (load.consolidationId && load.consolidationId !== ownTripId) {
    const other = await prisma.consolidation.findUnique({ where: { id: load.consolidationId }, select: { id: true, status: true } });
    if (other && ACTIVE_CONSOLIDATION.includes(other.status)) {
      throw conflict(`${loadLabel(load)} is already on another consolidated trip`, { code: 'IN_CONSOLIDATION', loadId: load.id, consolidationId: other.id });
    }
  }
  return load;
}

/** Where clause matching the given loads only while they are still free to join (guards the write against races). */
function stillFree(loads, carrierId, ownTripId = null) {
  const stale = [...new Set(loads.map((l) => l.consolidationId).filter((x) => x && x !== ownTripId))];
  return {
    id: { in: loads.map((l) => l.id) },
    status: { in: JOINABLE },
    AND: [
      { OR: [{ consolidationId: null }, ...(stale.length ? [{ consolidationId: { in: stale } }] : [])] },
      { OR: [{ carrierId: null }, { carrierId }] },
    ],
  };
}

/** Carrier columns for loads with no truck yet: the truck and its rules check (stored warnings, never blocking). */
async function assignColumns(loads, carrierId) {
  const out = new Map();
  for (const l of loads) if (!l.carrierId) out.set(l.id, { carrierId, ...(await fitColumns({ ...l, carrierId }, l)) });
  return out;
}

const clientStops = (stops) => stops.map(({ loadId, kind }) => ({ loadId, kind }));

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

r.get('/', ah(async (req, res) => {
  const q = parse(z.object({
    carrierId: optStr(40), status: z.enum(['active', 'all']).default('active'), team: flag, geometry: flag,
  }), req.query);
  let carrier = null;
  let where;
  if (q.carrierId) {
    carrier = await loadCarrier(req.user, q.carrierId);
    where = { carrierId: carrier.id, ownerId: { in: await readableOwnerIds(req.user, 'team') } };
  } else {
    where = { ownerId: { in: await readableOwnerIds(req.user, q.team ? 'team' : 'mine') } };
  }
  if (q.status === 'active') where.status = { in: ACTIVE_CONSOLIDATION };
  let rows = await prisma.consolidation.findMany({ where, orderBy: { updatedAt: 'desc' }, take: q.carrierId ? 20 : 200 });
  let loads = rows.length ? await loadsOf(rows.map((c) => c.id)) : [];
  // Heal trips out of step with their loads (a status changed on a path that does not sync, a load deleted).
  const stale = rows.filter((c) => needsSync(c, loads.filter((l) => l.consolidationId === c.id)));
  if (stale.length) {
    for (const c of stale) await syncConsolidation(c.id, { by: req.user.id });
    rows = await prisma.consolidation.findMany({ where, orderBy: { updatedAt: 'desc' }, take: q.carrierId ? 20 : 200 });
    loads = rows.length ? await loadsOf(rows.map((c) => c.id)) : [];
  }
  const byTrip = new Map(rows.map((c) => [c.id, []]));
  for (const l of loads) byTrip.get(l.consolidationId)?.push(l);
  const now = Date.now();
  const items = [];
  for (const c of rows) {
    const mine = byTrip.get(c.id);
    // ETAs only for one truck's trips (its panel): position and hours reports are per truck.
    const plan = carrier && ACTIVE_CONSOLIDATION.includes(c.status) ? await planInputs(c.carrierId, mine.map((l) => l.id), carrier) : null;
    items.push(consolidationView(c, mine, { plan, geometry: q.geometry, now }));
  }
  res.json({ items });
}));

/** Open loads for the Consolidate dialog: the truck's own (planned, booked, in transit) and loads with no truck yet. */
r.get('/candidates', ah(async (req, res) => {
  const q = parse(z.object({ carrierId: id }), req.query);
  const carrier = await loadCarrier(req.user, q.carrierId);
  const owners = await readableOwnerIds(req.user, 'team');
  const select = { ...LOAD_VIEW_SELECT, consolidation: { select: { id: true, name: true, status: true } } };
  const [onTruck, unassigned] = await Promise.all([
    prisma.load.findMany({ where: { carrierId: carrier.id, ownerId: { in: owners }, status: { in: JOINABLE } }, select, orderBy: [{ pickupDate: 'asc' }, { createdAt: 'asc' }], take: 30 }),
    prisma.load.findMany({ where: { ownerId: req.user.id, carrierId: null, status: { in: ['planned', 'booked'] } }, select, orderBy: [{ pickupDate: 'asc' }, { createdAt: 'desc' }], take: 30 }),
  ]);
  const view = (l) => {
    const o = pointFor(l.originCity, l.originState, l.originLat, l.originLng);
    const d = pointFor(l.destCity, l.destState, l.destLat, l.destLng);
    const trip = l.consolidation && ACTIVE_CONSOLIDATION.includes(l.consolidation.status) ? { id: l.consolidation.id, name: l.consolidation.name } : null;
    return {
      id: l.id, referenceNumber: l.referenceNumber, status: l.status, carrierId: l.carrierId,
      origin: { city: l.originCity, state: l.originState, lat: o?.lat ?? null, lng: o?.lng ?? null, facility: l.pickupFacility || null },
      dest: { city: l.destCity, state: l.destState, lat: d?.lat ?? null, lng: d?.lng ?? null, facility: l.deliveryFacility || null },
      pickupDate: l.pickupDate, deliveryDate: l.deliveryDate,
      pickupWindowStart: l.pickupWindowStart, pickupWindowEnd: l.pickupWindowEnd, deliveryWindowStart: l.deliveryWindowStart, deliveryWindowEnd: l.deliveryWindowEnd,
      pickupTz: l.pickupTz, deliveryTz: l.deliveryTz,
      rateCents: l.rateCents, loadedMiles: l.loadedMiles, broker: l.broker ? { id: l.broker.id, companyName: l.broker.companyName } : null,
      consolidation: trip,
    };
  };
  res.json({ carrier: { id: carrier.id, companyName: carrier.companyName }, loads: onTruck.map(view), unassigned: unassigned.map(view), maxLoads: MAX_LOADS });
}));

r.get('/:id', ah(async (req, res) => {
  const { c, loads } = await readTrip(req.user, req.params.id);
  res.json({ consolidation: await fullView(c, loads) });
}));

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const createSchema = z.object({
  carrierId: id,
  loadIds: z.array(id).min(MIN_LOADS, `Pick at least ${MIN_LOADS} loads`).max(MAX_LOADS, `At most ${MAX_LOADS} loads fit one consolidated trip`)
    .refine((v) => new Set(v).size === v.length, 'Each load can be picked once'),
  name: optStr(80),
  stops: stopList.optional(),
});

r.post('/', ah(async (req, res) => {
  const b = parse(createSchema, req.body);
  const carrier = await loadCarrier(req.user, b.carrierId, { write: true });
  const loads = [];
  for (const loadId of b.loadIds) loads.push(await joinable(req.user, loadId, carrier.id));
  const owners = new Set(loads.map((l) => l.ownerId));
  if (owners.size > 1) throw badRequest('These loads belong to different dispatchers: a consolidated trip holds one dispatcher\'s loads', { code: 'MIXED_OWNERS' });
  const ownerId = loads[0].ownerId;
  const byId = new Map(loads.map((l) => [l.id, l]));
  const stops = b.stops ? clientStops(b.stops) : defaultStops(loads);
  const check = checkStops(stops, b.loadIds, byId);
  if (!check.ok) throw badRequest(check.reason, { code: 'BAD_STOPS', loadId: check.loadId ?? null });
  const assign = await assignColumns(loads, carrier.id);
  const created = await prisma.$transaction(async (tx) => {
    const c = await tx.consolidation.create({
      data: { ownerId, carrierId: carrier.id, name: b.name ?? null, status: deriveStatus(loads), stops: stopsJson(stops) },
    });
    const { count } = await tx.load.updateMany({ where: stillFree(loads, carrier.id), data: { consolidationId: c.id } });
    if (count !== loads.length) throw conflict('Some of these loads changed while the trip was being saved. Check them and try again.', { code: 'LOADS_CHANGED' });
    for (const [loadId, data] of assign) await tx.load.update({ where: { id: loadId }, data });
    await tx.carrier.updateMany({ where: { id: carrier.id, isFleet: false }, data: { isFleet: true } });
    return c;
  });
  const title = titleOf(created, stops, byId);
  for (const l of loads) await recordMembership(l, created, { action: 'joined', title, by: req.user.id, stops });
  await logActivity(req.user, { type: 'load', carrierId: carrier.id, summary: `Put ${loads.length} loads on one trip: ${title}` });
  await routeNow(created.id);
  invalidateToday(ownerId, req.user.id);
  const { c, loads: fresh } = await readTrip(req.user, created.id);
  res.status(201).json({ consolidation: await fullView(c, fresh) });
}));

r.patch('/:id', ah(async (req, res) => {
  const b = parse(z.object({ stops: stopList.optional(), name: optStr(80) }), req.body);
  const { c, loads } = await readTrip(req.user, req.params.id, { write: true });
  const data = {};
  if (b.name !== undefined) data.name = b.name;
  if (b.stops) {
    if (!ACTIVE_CONSOLIDATION.includes(c.status)) throw badRequest('This trip is over: its stops can no longer be changed');
    const byId = new Map(loads.map((l) => [l.id, l]));
    const stops = clientStops(b.stops);
    const check = checkStops(stops, loads.map((l) => l.id), byId);
    if (!check.ok) throw badRequest(check.reason, { code: 'BAD_STOPS', loadId: check.loadId ?? null });
    const json = stopsJson(stops);
    if (json !== c.stops) data.stops = json;
  }
  if (Object.keys(data).length) {
    await prisma.consolidation.update({ where: { id: c.id }, data });
    if (data.stops) await routeNow(c.id);
  }
  const fresh = await readTrip(req.user, c.id);
  res.json({ consolidation: await fullView(fresh.c, fresh.loads) });
}));

/** Add one load to the trip (its stops go in by window time unless `stops` is sent), or take one off it. */
r.post('/:id/loads', ah(async (req, res) => {
  const b = parse(z.object({ action: z.enum(['add', 'remove']), loadId: id, stops: stopList.optional() }), req.body);
  const { c, loads } = await readTrip(req.user, req.params.id, { write: true });
  if (!ACTIVE_CONSOLIDATION.includes(c.status)) throw badRequest('This trip is over: loads can no longer be added or taken off');
  const byId = new Map(loads.map((l) => [l.id, l]));
  const stops = parseStops(c.stops);
  const title = titleOf(c, stops, byId);

  if (b.action === 'remove') {
    const load = byId.get(b.loadId);
    if (!load) throw notFound('This load is not on the trip');
    await loadOwned('load', req.user, load.id, { write: true });
    if (loads.length - 1 < MIN_LOADS) {
      await dissolveConsolidation(c, { reason: 'ended: fewer than 2 loads left on it', by: req.user.id, title });
      invalidateToday(c.ownerId, req.user.id);
      return res.json({ consolidation: null, dissolved: true });
    }
    const next = stops.filter((s) => s.loadId !== load.id);
    const rest = loads.filter((l) => l.id !== load.id);
    await prisma.$transaction([
      prisma.load.updateMany({ where: { id: load.id, consolidationId: c.id }, data: { consolidationId: null } }),
      prisma.consolidation.update({ where: { id: c.id }, data: { stops: stopsJson(next), status: deriveStatus(rest) } }),
    ]);
    await recordMembership(load, c, { action: 'left', title, by: req.user.id });
    await routeNow(c.id);
    invalidateToday(c.ownerId, req.user.id);
    const fresh = await readTrip(req.user, c.id);
    return res.json({ consolidation: await fullView(fresh.c, fresh.loads), dissolved: false });
  }

  if (byId.has(b.loadId)) throw badRequest('This load is already on the trip');
  if (loads.length >= MAX_LOADS) throw badRequest(`At most ${MAX_LOADS} loads fit one consolidated trip`, { code: 'TOO_MANY_LOADS' });
  const load = await joinable(req.user, b.loadId, c.carrierId, c.id);
  if (load.ownerId !== c.ownerId) throw badRequest('This load belongs to another dispatcher: a consolidated trip holds one dispatcher\'s loads', { code: 'MIXED_OWNERS' });
  const all = new Map([...byId, [load.id, load]]);
  const next = b.stops ? clientStops(b.stops) : insertStops(stops, load, all, (s) => stopDone(all.get(s.loadId), s.kind));
  const check = checkStops(next, [...all.keys()], all);
  if (!check.ok) throw badRequest(check.reason, { code: 'BAD_STOPS', loadId: check.loadId ?? null });
  const assign = await assignColumns([load], c.carrierId);
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.load.updateMany({ where: stillFree([load], c.carrierId, c.id), data: { consolidationId: c.id } });
    if (count !== 1) throw conflict('This load changed while the trip was being saved. Check it and try again.', { code: 'LOADS_CHANGED' });
    if (assign.has(load.id)) await tx.load.update({ where: { id: load.id }, data: assign.get(load.id) });
    await tx.consolidation.update({ where: { id: c.id }, data: { stops: stopsJson(next), status: deriveStatus([...loads, load]) } });
  });
  await recordMembership(load, c, { action: 'joined', title, by: req.user.id, stops: next });
  await routeNow(c.id);
  invalidateToday(c.ownerId, req.user.id);
  const fresh = await readTrip(req.user, c.id);
  res.json({ consolidation: await fullView(fresh.c, fresh.loads), dissolved: false });
}));

/**
 * Move the whole trip: every load not yet at `status` moves forward to it with the same side effects as one load
 * (truck, timeline, paperwork), deliveries in stop order so the truck ends at the last one. Loads already at or past it
 * are left alone. `canceled` ends the trip itself: the loads are detached and keep their own status.
 */
r.post('/:id/status', ah(async (req, res) => {
  const b = parse(z.object({ status: z.enum(['booked', 'in_transit', 'delivered', 'canceled']), force: z.boolean().optional() }), req.body);
  const { c, loads } = await readTrip(req.user, req.params.id, { write: true });
  const stops = parseStops(c.stops);
  if (b.status === 'canceled') {
    if (c.status !== 'canceled') await dissolveConsolidation(c, { reason: 'was canceled; the loads are plain trips again', by: req.user.id, title: titleOf(c, stops, new Map(loads.map((l) => [l.id, l]))) });
    invalidateToday(c.ownerId, req.user.id);
    const ended = await prisma.consolidation.findUnique({ where: { id: c.id } });
    return res.json({ consolidation: consolidationView(ended, []), changed: [] });
  }
  if (!ACTIVE_CONSOLIDATION.includes(c.status)) throw badRequest('This trip is over: move its loads one by one instead');
  const kind = b.status === 'delivered' ? 'delivery' : 'pickup';
  const order = stops.filter((s) => s.kind === kind).map((s) => s.loadId);
  const target = STATUS_FLOW.indexOf(b.status);
  const changed = [];
  for (const loadId of order) {
    const before = await loadOwned('load', req.user, loadId, { write: true });
    if (before.consolidationId !== c.id || STATUS_FLOW.indexOf(before.status) === -1 || STATUS_FLOW.indexOf(before.status) >= target) continue;
    assertTransition(before.status, b.status, { force: b.force });
    const after = await prisma.load.update({ where: { id: before.id }, data: { status: b.status } });
    const { paperwork } = await afterStatusChange(req.user, before, after, { source: 'dispatcher', syncConsolidation: false });
    changed.push({ id: after.id, status: after.status, paperwork });
  }
  await syncConsolidation(c.id, { by: req.user.id });
  invalidateToday(c.ownerId, req.user.id);
  const fresh = await readTrip(req.user, c.id);
  res.json({ consolidation: await fullView(fresh.c, fresh.loads), changed });
}));

/** Ungroup: the loads stay (plain trips again, with a timeline note), the trip is removed. */
r.delete('/:id', ah(async (req, res) => {
  const c = await loadOwned('consolidation', req.user, req.params.id, { write: true });
  const loads = await loadsOf([c.id]);
  const title = titleOf(c, parseStops(c.stops), new Map(loads.map((l) => [l.id, l])));
  if (c.status !== 'canceled') await dissolveConsolidation(c, { reason: 'was ungrouped; the loads are plain trips again', by: req.user.id, title });
  await prisma.consolidation.delete({ where: { id: c.id } });
  invalidateToday(c.ownerId, req.user.id);
  res.json({ ok: true });
}));

export default r;
