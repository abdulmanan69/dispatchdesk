import crypto from 'node:crypto';
import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { parse, z, optStr, optInt, optDate, clean } from '../lib/validate.js';
import { requirePermission, refuseApiToken } from '../middleware/auth.js';
import { loadCarrier, loadOwned, readableOwnerIds } from '../lib/access.js';
import { EQUIPMENT } from '../lib/constants.js';
import { logActivity } from '../lib/activity.js';
import { sha256 } from '../lib/crypto.js';
import { timezoneForState } from '../lib/timezones.js';
import { SHARE_HOURS, CLAIM_MINUTES, ACTIVE_SHARE, createShare, shareView, shareMessage, newPin, pinHashFor } from '../services/fleet/track.js';
import {
  TRUCK_STATUSES, ACTIVE_TRIP_STATUSES, TRIP_FLOW, pointFor, estimateMiles, crowMiles, searchPlaces, truckView, tripView, availableBy,
  routeIsCurrent, loadEnds, routable,
} from '../services/fleet/index.js';
import { ensureLoadRoute, scheduleLoadRoute, deadheadRoute } from '../services/fleet/route.js';
import { healFleetFlags } from '../services/fleet/flags.js';
import { encodePolyline, decodePolyline, simplifyToBudget } from '../services/fleet/polyline.js';
import { plansFor, planSummary, lastContacts, checkCallSettings, checkCallDue, saveCheckCallSettings, stopEvents, openDwell, latestHos, CHECKCALL_HOURS } from '../services/fleet/insights.js';
import { normalizeClocks, hoursText } from '../services/fleet/hos.js';
import { recordLoadEvent } from '../services/fleet/events.js';
import { afterStatusChange, assertTransition } from '../services/loads/status.js';
import { checkLoadFit } from '../services/loads/fit.js';
import { rulesOf } from '../services/loads/fitCheck.js';
import { invalidateToday } from '../services/fleet/today.js';
import { LINK_DAYS, newLoadShareToken, loadTrackUrl, defaultExpiry, loadShareView, invalidateLoadTrack } from '../services/fleet/loadShare.js';

/**
 * Fleet map: where each truck is, what it is doing, and the trips planned for it.
 * Trips are ordinary Load rows (status planned → booked → in_transit → delivered) linked to the carrier.
 * Trucks on the map are carriers with isFleet = true (a customer, or a truck with a status, position or trip);
 * the flag keeps the polled map query on the Carrier(ownerId, isFleet) index.
 */
const r = Router();
r.use(requirePermission('crm.use'));

const state = z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z]{2}$/, 'Use a 2-letter state code'));
const lat = z.coerce.number().min(-90).max(90);
const lng = z.coerce.number().min(-180).max(180);
const place = z.object({ city: z.string().trim().min(1).max(100), state, lat: lat.nullable().optional(), lng: lng.nullable().optional() });

const tripLoadInclude = { broker: { select: { id: true, companyName: true } } };
const truckInclude = {
  customer: { select: { id: true, status: true } },
  stage: { select: { key: true } },
  loads: { where: { status: { in: ACTIVE_TRIP_STATUSES } }, orderBy: [{ pickupDate: 'asc' }, { createdAt: 'asc' }], take: 10, include: tripLoadInclude },
  // 'locked' is included so the map can say why a link stopped working.
  locationShares: { where: { status: { in: ['pending', 'sharing', 'paused', 'locked'] } }, orderBy: { updatedAt: 'desc' }, take: 1 },
};

async function visibleWhere(user, scope) {
  const owners = await readableOwnerIds(user, scope === 'team' ? 'team' : 'mine');
  return { OR: [{ ownerId: { in: owners } }, { assignedToId: user.id }] };
}

/** Read access to a load: its owner's data is readable, or its truck is assigned to this dispatcher. */
async function readableLoadWhere(user) {
  const owners = await readableOwnerIds(user, 'team');
  return { OR: [{ ownerId: { in: owners } }, { carrier: { assignedToId: user.id } }] };
}

const isFleetCandidate = (c) => c.truckStatus !== 'unknown' || c.locationLat != null || c.locationState != null || !!c.customer || (c.loads || []).length > 0;

// ---------------------------------------------------------------------------
// Fleet list (polled every 20 s while drivers share GPS): a cheap version check answers 304 when nothing changed.
// ---------------------------------------------------------------------------

/**
 * Version of everything the fleet payload depends on: fleet carriers, active loads, live links and customers (counts and
 * newest update), plus a 5-minute bucket for the time-based fields (stale GPS, expired links).
 */
async function fleetVersion(user, owners, base) {
  const [c, l, s, cust] = await Promise.all([
    prisma.carrier.aggregate({ where: { AND: [base, { isFleet: true }] }, _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.load.aggregate({ where: { ownerId: { in: owners }, status: { in: ACTIVE_TRIP_STATUSES } }, _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.locationShare.aggregate({ where: { ownerId: { in: owners }, status: { in: ['pending', 'sharing', 'paused', 'locked'] } }, _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.customer.count({ where: { ownerId: { in: owners } } }),
  ]);
  const stamp = (a) => [a._count._all, a._max.updatedAt ? new Date(a._max.updatedAt).getTime() : 0];
  const raw = JSON.stringify([user.id, owners, stamp(c), stamp(l), stamp(s), cust, Math.floor(Date.now() / 300_000)]);
  return `W/"fleet-${crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 24)}"`;
}

r.get('/', ah(async (req, res) => {
  const q = parse(z.object({ scope: z.enum(['fleet', 'all']).default('fleet'), team: z.enum(['true', 'false']).default('false') }), req.query);
  const owners = await readableOwnerIds(req.user, q.team === 'true' ? 'team' : 'mine');
  const base = { OR: [{ ownerId: { in: owners } }, { assignedToId: req.user.id }] };
  let etag = null;
  if (q.scope === 'fleet') {
    etag = await fleetVersion(req.user, owners, base);
    res.set('Cache-Control', 'private, no-cache');
    if (req.get('if-none-match') === etag) { res.set('ETag', etag); return res.status(304).end(); }
    if (await healFleetFlags(owners)) etag = await fleetVersion(req.user, owners, base);
  }
  const where = q.scope === 'all' ? base : { AND: [base, { isFleet: true }] };
  const [rows, open] = await Promise.all([
    prisma.carrier.findMany({ where, include: truckInclude, orderBy: [{ companyName: 'asc' }], take: 500 }),
    // Open loads (no carrier yet) are shown as origins on the map.
    prisma.load.findMany({
      where: { ownerId: req.user.id, carrierId: null, status: { in: ['planned', 'booked'] } },
      orderBy: { pickupDate: 'asc' }, take: 200, include: tripLoadInclude,
    }),
  ]);
  const plans = await plansFor(rows, { withEvents: false });
  const trucks = rows.map((c) => ({ ...truckView(c), plan: planSummary(plans[c.id]) }));
  const counts = Object.fromEntries(TRUCK_STATUSES.map((s) => [s, trucks.filter((t) => t.truckStatus === s).length]));
  if (etag) res.set('ETag', etag);
  res.json({ trucks, openLoads: open.map(tripView), counts, total: trucks.length });
}));

/** Offline place lookup (bundled freight cities + state centers). The client prefers /api/market/geocode when available. */
r.get('/places', ah(async (req, res) => {
  const q = parse(z.object({ q: z.string().trim().min(2).max(100) }), req.query);
  res.json({ items: searchPlaces(q.q), source: 'built-in city table' });
}));

const truckSchema = z.object({
  truckStatus: z.enum(TRUCK_STATUSES).optional(),
  location: z.object({ city: z.string().trim().max(100).nullable().optional(), state: state.nullable().optional(), lat: lat.nullable().optional(), lng: lng.nullable().optional() }).nullable().optional(),
  availableAt: optDate,
});

r.patch('/carriers/:id', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id, { write: true });
  const body = parse(truckSchema, req.body);
  const data = {};
  if (body.truckStatus) data.truckStatus = body.truckStatus;
  if (body.availableAt !== undefined) data.availableAt = body.availableAt;
  if (body.location !== undefined) {
    const l = body.location || {};
    if (l.lat != null && l.lng == null) throw badRequest('location.lng is required with location.lat');
    const pt = pointFor(l.city, l.state, l.lat ?? null, l.lng ?? null);
    if (body.location && !pt) throw badRequest('Give a city and state, or map coordinates');
    Object.assign(data, {
      locationCity: l.city || null, locationState: l.state || null,
      locationLat: body.location ? pt.lat : null, locationLng: body.location ? pt.lng : null,
      locationUpdatedAt: body.location ? new Date() : null,
      locationSource: body.location ? 'manual' : null,
    });
  }
  if ((data.truckStatus && data.truckStatus !== 'unknown') || body.location) data.isFleet = true;
  let updated = await prisma.carrier.update({ where: { id: carrier.id }, data, include: truckInclude });
  // Clearing the status and the position takes a truck off the map unless it is a customer or has a trip.
  if (updated.isFleet && !isFleetCandidate(updated)) updated = await prisma.carrier.update({ where: { id: carrier.id }, data: { isFleet: false }, include: truckInclude });
  if (data.truckStatus && data.truckStatus !== carrier.truckStatus) {
    await logActivity(req.user, { type: 'fleet', carrierId: carrier.id, summary: `Truck status: ${data.truckStatus.replace('_', ' ')}` });
  }
  if (body.location) {
    await logActivity(req.user, { type: 'fleet', carrierId: carrier.id, summary: `Truck location set to ${[data.locationCity, data.locationState].filter(Boolean).join(', ') || `${data.locationLat.toFixed(3)}, ${data.locationLng.toFixed(3)}`}` });
  }
  invalidateToday(carrier.ownerId, req.user.id);
  res.json({ truck: truckView(updated) });
}));

/**
 * Carrier-rules check of one load for each truck (the load check card's warnings, with the truck's estimated deadhead).
 * One query for every truck's Customer row; trucks that are not customers have no rules (fit: null).
 */
async function fitForTrucks(load, trucks) {
  if (!load || !trucks.length) return new Map();
  const customers = await prisma.customer.findMany({ where: { carrierId: { in: trucks.map((t) => t.id) } } });
  const byCarrier = new Map(customers.map((c) => [c.carrierId, c]));
  const out = new Map();
  for (const t of trucks) {
    const customer = byCarrier.get(t.id);
    if (!customer) continue;
    const { warnings, numbers } = checkLoadFit({ ...load, deadheadMiles: t.deadheadEstimate }, rulesOf(customer, t));
    out.set(t.id, {
      warnings,
      walkAwayCents: numbers.walkAwayCents, gapCents: numbers.gapCents, allInRatePerMile: numbers.allInRatePerMile,
    });
  }
  return out;
}

/**
 * Rank located trucks near a point: available ones first by distance, then the rest.
 * With loadId (an open load being covered), each customer truck also gets that load checked against its rules (fit).
 */
r.get('/near', ah(async (req, res) => {
  const q = parse(z.object({
    lat: lat.optional(), lng: lng.optional(), city: optStr(100), state: state.optional(),
    equipment: z.enum(EQUIPMENT).optional(), by: optDate, radius: z.coerce.number().min(1).max(3000).default(500),
    loadId: optStr(40),
  }), req.query);
  const load = q.loadId ? await loadOwned('load', req.user, q.loadId) : null;
  const pt = q.lat != null && q.lng != null ? { lat: q.lat, lng: q.lng } : pointFor(q.city, q.state);
  if (!pt) throw badRequest('Give a place (city and state) or coordinates');
  // Bounding box in SQL (1° latitude ≈ 69 mi; longitude degrees shrink with latitude), exact distance in JS.
  const dLat = q.radius / 69;
  const dLng = q.radius / (69.172 * Math.max(0.05, Math.cos((pt.lat * Math.PI) / 180)));
  const rows = await prisma.carrier.findMany({
    where: {
      AND: [await visibleWhere(req.user, 'mine'), {
        isFleet: true,
        locationLat: { gte: pt.lat - dLat, lte: pt.lat + dLat },
        locationLng: { gte: pt.lng - dLng, lte: pt.lng + dLng },
      }],
    },
    select: {
      id: true, companyName: true, mcNumber: true, dotNumber: true, phone: true, equipment: true, truckStatus: true, availableAt: true, timezone: true, state: true,
      locationCity: true, locationState: true, locationLat: true, locationLng: true, locationUpdatedAt: true, locationSource: true,
      loads: { where: { status: 'in_transit' }, select: { id: true }, take: 1 },
    },
    orderBy: { locationUpdatedAt: 'desc' },
    take: 500,
  });
  const cutoff = q.by || new Date(Date.now() + 86400000);
  const items = rows
    .filter((c) => !q.equipment || String(c.equipment || '').split(',').includes(q.equipment))
    .map((c) => {
      const location = { city: c.locationCity, state: c.locationState, lat: c.locationLat, lng: c.locationLng, updatedAt: c.locationUpdatedAt };
      const miles = Math.round(crowMiles(pt, location));
      const t = { id: c.id, companyName: c.companyName, mcNumber: c.mcNumber, dotNumber: c.dotNumber, phone: c.phone, equipment: c.equipment, truckStatus: c.truckStatus, availableAt: c.availableAt, timezone: c.timezone || timezoneForState(c.state), location, inTransit: c.loads.length > 0 };
      return { ...t, distanceMiles: miles, deadheadEstimate: estimateMiles(pt, location), availableInTime: availableBy(t, cutoff) && !t.inTransit };
    })
    .filter((t) => t.distanceMiles <= q.radius)
    .sort((a, b) => (b.availableInTime - a.availableInTime) || a.distanceMiles - b.distanceMiles)
    .slice(0, 50);
  if (load) {
    const fits = await fitForTrucks(load, items);
    for (const t of items) t.fit = fits.get(t.id) || null;
  }
  res.json({ point: pt, items, cutoff, ...(load ? { loadId: load.id } : {}) });
}));

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------
const tripSchema = z.object({
  carrierId: z.string().min(1).max(40),
  origin: place,
  dest: place,
  pickupDate: optDate,
  deliveryDate: optDate,
  rateCents: z.coerce.number().int().min(0).max(1e9),
  loadedMiles: optInt(1, 20000),
  deadheadMiles: optInt(0, 5000),
  equipment: z.preprocess((v) => (v === '' ? null : v), z.enum(EQUIPMENT).nullable().optional()),
  commodity: optStr(120),
  weightLbs: optInt(0, 200000),
  referenceNumber: optStr(60),
  brokerId: optStr(40),
  notes: optStr(5000),
  mpg: z.coerce.number().min(1).max(30).nullable().optional(),
  fuelPricePerGallon: z.coerce.number().min(0).max(20).nullable().optional(),
  status: z.enum(['planned', 'booked']).default('planned'),
});

function checkDates(b) {
  if (b.pickupDate && b.deliveryDate && b.deliveryDate < b.pickupDate) throw badRequest('Delivery cannot be before pickup');
}

/** Compute the road route now; a routing failure never fails the request (the backfill job retries estimates). */
async function routeNow(load) {
  try {
    await ensureLoadRoute(load, { force: true });
  } catch (err) {
    console.error(`[fleet] route for load ${load.id} failed: ${err.message}`);
  }
  return prisma.load.findUnique({ where: { id: load.id }, include: tripLoadInclude });
}

r.post('/trips', ah(async (req, res) => {
  const b = parse(tripSchema, req.body);
  checkDates(b);
  const carrier = await loadCarrier(req.user, b.carrierId, { write: true });
  if (b.brokerId) await loadOwned('broker', req.user, b.brokerId);
  const o = pointFor(b.origin.city, b.origin.state, b.origin.lat, b.origin.lng);
  const d = pointFor(b.dest.city, b.dest.state, b.dest.lat, b.dest.lng);
  if (!o || !d) throw badRequest('Unknown origin or destination');
  const truck = pointFor(carrier.locationCity, carrier.locationState, carrier.locationLat, carrier.locationLng);
  const deadheadMiles = b.deadheadMiles ?? (truck ? estimateMiles(truck, o) : 0);
  const created = await prisma.load.create({
    data: clean({
      ownerId: req.user.id, carrierId: carrier.id, brokerId: b.brokerId || null, status: b.status,
      originCity: b.origin.city, originState: b.origin.state, originLat: o.lat, originLng: o.lng,
      destCity: b.dest.city, destState: b.dest.state, destLat: d.lat, destLng: d.lng,
      // Appointment times are local to each stop: show them in the stop's time zone.
      pickupTz: timezoneForState(b.origin.state) || null, deliveryTz: timezoneForState(b.dest.state) || null,
      pickupDate: b.pickupDate ?? null, deliveryDate: b.deliveryDate ?? null, rateCents: b.rateCents,
      loadedMiles: b.loadedMiles ?? Math.max(1, estimateMiles(o, d)), deadheadMiles, equipment: b.equipment ?? null, commodity: b.commodity ?? null, weightLbs: b.weightLbs ?? null,
      referenceNumber: b.referenceNumber ?? null, notes: b.notes ?? null, mpg: b.mpg ?? null, fuelPricePerGallon: b.fuelPricePerGallon ?? null,
    }),
  });
  if (!carrier.isFleet) await prisma.carrier.update({ where: { id: carrier.id }, data: { isFleet: true } });
  let load = await routeNow(created);
  // Without miles from the planner, the road route's miles are better than the straight-line estimate.
  if (b.loadedMiles == null && load.routeSource === 'osrm' && load.routeMiles) {
    load = await prisma.load.update({ where: { id: load.id }, data: { loadedMiles: Math.max(1, Math.round(load.routeMiles)) }, include: tripLoadInclude });
  }
  await logActivity(req.user, {
    type: 'load', carrierId: carrier.id,
    summary: `Planned trip ${load.originCity}, ${load.originState} → ${load.destCity}, ${load.destState} at $${(load.rateCents / 100).toLocaleString('en-US')}`,
  });
  invalidateToday(load.ownerId, req.user.id);
  res.status(201).json({ trip: tripView(load), estimated: { loadedMiles: b.loadedMiles == null, deadheadMiles: b.deadheadMiles == null } });
}));

const tripPatch = tripSchema.omit({ carrierId: true, status: true }).partial();

r.patch('/trips/:id', ah(async (req, res) => {
  const existing = await loadOwned('load', req.user, req.params.id, { write: true });
  const b = parse(tripPatch, req.body);
  checkDates({ pickupDate: b.pickupDate ?? existing.pickupDate, deliveryDate: b.deliveryDate ?? existing.deliveryDate });
  if (b.brokerId) await loadOwned('broker', req.user, b.brokerId);
  const data = clean({
    pickupDate: b.pickupDate, deliveryDate: b.deliveryDate, rateCents: b.rateCents, loadedMiles: b.loadedMiles, deadheadMiles: b.deadheadMiles,
    equipment: b.equipment, commodity: b.commodity, weightLbs: b.weightLbs, referenceNumber: b.referenceNumber, brokerId: b.brokerId,
    notes: b.notes, mpg: b.mpg, fuelPricePerGallon: b.fuelPricePerGallon,
  });
  for (const [key, p] of [['origin', b.origin], ['dest', b.dest]]) {
    if (!p) continue;
    const pt = pointFor(p.city, p.state, p.lat, p.lng);
    if (!pt) throw badRequest(`Unknown ${key === 'origin' ? 'origin' : 'destination'}`);
    Object.assign(data, { [`${key}City`]: p.city, [`${key}State`]: p.state, [`${key}Lat`]: pt.lat, [`${key}Lng`]: pt.lng });
    if (p.state !== existing[`${key}State`]) data[key === 'origin' ? 'pickupTz' : 'deliveryTz'] = timezoneForState(p.state) || null;
  }
  let load = await prisma.load.update({ where: { id: existing.id }, data, include: tripLoadInclude });
  // Moving the pickup or delivery makes the stored road route stale: compute it again. Finished trips keep no road
  // route (it is cleared on delivery), so editing one does not route it again.
  if (ACTIVE_TRIP_STATUSES.includes(load.status) && !routeIsCurrent(load)) load = await routeNow(load);
  invalidateToday(load.ownerId, req.user.id);
  res.json({ trip: tripView(load) });
}));

/** Move a trip along planned → booked → in_transit → delivered (or cancel). The truck follows. */
r.post('/trips/:id/status', ah(async (req, res) => {
  const existing = await loadOwned('load', req.user, req.params.id, { write: true });
  const { status, force } = parse(z.object({ status: z.enum([...TRIP_FLOW, 'canceled']), force: z.boolean().optional() }), req.body);
  // Same rules as the Loads page: forward moves are free; moving back, reopening a canceled trip or canceling a
  // delivered one answers 409 CONFIRM_STATUS until the client confirms with force: true.
  assertTransition(existing.status, status, { force });
  if (status === existing.status) {
    const same = await prisma.load.findUnique({ where: { id: existing.id }, include: tripLoadInclude });
    return res.json({ trip: tripView(same), truck: null, paperwork: { missing: [] } });
  }
  const load = await prisma.load.update({ where: { id: existing.id }, data: { status }, include: tripLoadInclude });
  // Shared with the Loads page: moves the truck, records the status event and the activity, lists missing paperwork.
  const { truck: moved, paperwork } = await afterStatusChange(req.user, existing, load, { source: 'dispatcher' });
  let truck = null;
  if (moved && load.carrierId) {
    const row = await prisma.carrier.findUnique({ where: { id: load.carrierId }, include: truckInclude });
    if (row) truck = truckView(row);
  }
  invalidateToday(load.ownerId, req.user.id);
  res.json({ trip: tripView(load), truck, paperwork });
}));

r.delete('/trips/:id', ah(async (req, res) => {
  const load = await loadOwned('load', req.user, req.params.id, { write: true });
  if (!['planned', 'booked', 'canceled'].includes(load.status)) throw badRequest('Only planned, booked or canceled trips can be deleted');
  await prisma.load.delete({ where: { id: load.id } });
  invalidateToday(load.ownerId, req.user.id);
  res.json({ ok: true });
}));

/** Upcoming trips (a week by default) for the timeline. */
r.get('/trips', ah(async (req, res) => {
  const q = parse(z.object({ from: optDate, days: z.coerce.number().int().min(1).max(31).default(7), carrierId: optStr(40) }), req.query);
  const from = q.from || new Date(new Date().setHours(0, 0, 0, 0));
  const to = new Date(from.getTime() + q.days * 86400000);
  if (q.carrierId) await loadCarrier(req.user, q.carrierId);
  const rows = await prisma.load.findMany({
    where: {
      ownerId: req.user.id, carrierId: q.carrierId || { not: null }, status: { not: 'canceled' },
      OR: [{ pickupDate: { gte: from, lt: to } }, { deliveryDate: { gte: from, lt: to } }, { pickupDate: { lt: from }, deliveryDate: { gte: to } }, { pickupDate: null, status: { in: ACTIVE_TRIP_STATUSES } }],
    },
    orderBy: [{ pickupDate: 'asc' }], take: 300,
    include: { ...tripLoadInclude, carrier: { select: { id: true, companyName: true, timezone: true, state: true } } },
  });
  res.json({ from, to, items: rows.map((l) => ({ ...tripView(l), carrier: l.carrier ? { ...l.carrier, timezone: l.carrier.timezone || timezoneForState(l.carrier.state) } : null })) });
}));

// ---------------------------------------------------------------------------
// Road routes for the map
// ---------------------------------------------------------------------------
const idList = (max) => z.string().trim().max(5000).transform((v) => [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, max));

// Map display needs far fewer points than progress snapping: routes are served simplified, cached per route version
// in a bounded map (entries and total characters), so the server does not simplify the same route on every request.
const DISPLAY_POINTS = 400;
const DISPLAY_MAX_ENTRIES = 3000;
const DISPLAY_MAX_CHARS = 8_000_000;
const displayCache = new Map(); // `${id}:${computedAt}:${length}` -> encoded
let displayChars = 0;
function displayGeometry(l) {
  const key = `${l.id}:${new Date(l.routeComputedAt).getTime()}:${l.routeGeometry.length}`;
  const hit = displayCache.get(key);
  if (hit !== undefined) { displayCache.delete(key); displayCache.set(key, hit); return hit; }
  const pts = decodePolyline(l.routeGeometry);
  const out = pts.length > DISPLAY_POINTS ? encodePolyline(simplifyToBudget(pts, DISPLAY_POINTS, 100)) : l.routeGeometry;
  displayCache.set(key, out);
  displayChars += out.length;
  while (displayCache.size > DISPLAY_MAX_ENTRIES || displayChars > DISPLAY_MAX_CHARS) {
    const [k, v] = displayCache.entries().next().value;
    displayCache.delete(k);
    displayChars -= v.length;
  }
  return out;
}

/**
 * Road geometry (encoded polyline, simplified for display) for trips. A trip without a current road route gets a
 * straight line marked as an estimate while its route is computed in the background; the trip's route.computedAt
 * changes when it is ready. Finished trips keep no geometry (it is cleared on delivery): they get the straight line
 * with the stored road miles, and no routing is scheduled for them.
 */
r.get('/routes', ah(async (req, res) => {
  const q = parse(z.object({ ids: idList(100) }), req.query);
  if (!q.ids.length) return res.json({ items: [] });
  const rows = await prisma.load.findMany({ where: { AND: [{ id: { in: q.ids } }, await readableLoadWhere(req.user)] } });
  const items = [];
  for (const l of rows) {
    if (routeIsCurrent(l)) {
      items.push({ id: l.id, geometry: displayGeometry(l), miles: l.routeMiles != null ? Math.round(l.routeMiles) : null, minutes: l.routeMinutes, source: l.routeSource, estimate: l.routeSource !== 'osrm', computedAt: l.routeComputedAt, pending: false });
      if (l.routeSource !== 'osrm' && ACTIVE_TRIP_STATUSES.includes(l.status) && Date.now() - new Date(l.routeComputedAt).getTime() > 10 * 60_000) scheduleLoadRoute(l);
      continue;
    }
    const { from, to } = loadEnds(l);
    if (!from || !to) continue;
    // Active trips get their road route worked out now (queued, or already in progress); the map asks again shortly.
    // A stop known only by its state never gets one, so the straight line stays and is not reported as pending.
    const active = ACTIVE_TRIP_STATUSES.includes(l.status) && routable(l);
    if (active) scheduleLoadRoute(l);
    const done = !ACTIVE_TRIP_STATUSES.includes(l.status);
    items.push({ id: l.id, geometry: encodePolyline([[from.lng, from.lat], [to.lng, to.lat]]), miles: done && l.routeMiles != null ? Math.round(l.routeMiles) : null, minutes: done ? l.routeMinutes ?? null : null, source: 'estimate', estimate: true, computedAt: null, pending: active });
  }
  res.json({ items });
}));

/** Road route from each truck to its next pickup (deadhead), cached per truck and load. */
r.get('/deadhead', ah(async (req, res) => {
  const q = parse(z.object({ pairs: z.string().trim().max(5000) }), req.query);
  const pairs = [...new Set(q.pairs.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 50)
    .map((p) => p.split(':')).filter((p) => p.length === 2 && p[0] && p[1]);
  if (!pairs.length) return res.json({ items: [] });
  const carrierIds = [...new Set(pairs.map((p) => p[0]))];
  const loadIds = [...new Set(pairs.map((p) => p[1]))];
  const [carriers, loads] = await Promise.all([
    prisma.carrier.findMany({ where: { AND: [{ id: { in: carrierIds } }, await visibleWhere(req.user, 'team')] }, select: { id: true, locationLat: true, locationLng: true } }),
    prisma.load.findMany({ where: { id: { in: loadIds }, carrierId: { in: carrierIds }, status: { in: ['planned', 'booked'] } }, select: { id: true, carrierId: true, originCity: true, originState: true, originLat: true, originLng: true } }),
  ]);
  const cById = Object.fromEntries(carriers.map((c) => [c.id, c]));
  const lById = Object.fromEntries(loads.map((l) => [l.id, l]));
  const items = [];
  let fresh = 0;
  for (const [carrierId, loadId] of pairs) {
    const c = cById[carrierId];
    const l = lById[loadId];
    if (!c || !l || l.carrierId !== c.id || c.locationLat == null) continue;
    const to = pointFor(l.originCity, l.originState, l.originLat, l.originLng);
    if (!to) continue;
    const from = { lat: c.locationLat, lng: c.locationLng };
    // At most two new routing calls per request; the rest come back as estimates marked pending.
    const route = await deadheadRoute({ carrierId, loadId, from, to, fetch: fresh < 2 });
    if (!route.cached && !route.pending) fresh++;
    items.push({ carrierId, loadId, geometry: route.encoded, miles: route.miles, minutes: route.minutes, source: route.source, estimate: route.estimate, pending: !!route.pending });
  }
  res.json({ items });
}));

// ---------------------------------------------------------------------------
// Truck plan: progress, ETAs, legal ETA, stops, check calls and dwell
// ---------------------------------------------------------------------------
const eventView = (e) => {
  let data = null;
  try { data = e.data ? JSON.parse(e.data) : null; } catch { data = null; }
  return {
    id: e.id, type: e.type, at: e.at, note: e.note, source: e.source, lat: e.lat, lng: e.lng,
    hos: data?.hos || null, documentId: data?.documentId || null, documentType: data?.type || null, pages: data?.pages ?? null,
    kind: data?.kind || null, miles: data?.miles ?? null, from: data?.from ?? null, to: data?.to ?? null,
  };
};

r.get('/carriers/:id/plan', ah(async (req, res) => {
  await loadCarrier(req.user, req.params.id);
  const row = await prisma.carrier.findUnique({ where: { id: String(req.params.id) }, include: truckInclude });
  const now = Date.now();
  const plan = (await plansFor([row], { now }))[row.id] || null;
  const active = row.loads;
  const current = active.find((l) => l.status === 'in_transit') || null;
  let checkCall = null;
  if (current) {
    const [contacts, settings] = await Promise.all([lastContacts([current]), checkCallSettings([current.ownerId])]);
    const s = settings[current.ownerId];
    const due = checkCallDue(current, contacts[current.id], s, now);
    checkCall = { tripId: current.id, lastContactAt: contacts[current.id]?.at ?? null, via: contacts[current.id]?.via ?? null, everyHours: s.hours, enabled: s.enabled, due: !!due, lastCheckCallAt: current.lastCheckCallAt };
  }
  const [events, hos] = await Promise.all([stopEvents(active.map((l) => l.id)), latestHos(active.map((l) => l.id))]);
  const dwell = openDwell(events, Object.fromEntries(active.map((l) => [l.id, l])), now);
  const report = Object.values(hos).sort((a, b) => b.at - a.at)[0] || null;
  res.json({
    carrierId: row.id,
    plan,
    checkCall,
    dwell: Object.entries(dwell).flatMap(([loadId, list]) => list.map((d) => ({ loadId, ...d }))),
    hosReport: report ? { at: report.at, source: report.source, input: report.input } : null,
    generatedAt: new Date(now),
  });
}));

/** Load timeline (check-ins, check calls, documents, status changes) for the truck panel. */
r.get('/trips/:id/events', ah(async (req, res) => {
  const load = await loadOwned('load', req.user, req.params.id);
  const rows = await prisma.loadEvent.findMany({ where: { loadId: load.id }, orderBy: { at: 'desc' }, take: 100 });
  res.json({ items: rows.map(eventView) });
}));

const minutes = (max) => z.preprocess((v) => (v === '' || v === undefined ? null : v), z.coerce.number().int().min(0).max(max).nullable().optional());
const hosSchema = z.object({ driveLeftMin: minutes(660), shiftLeftMin: minutes(840), cycleLeftMin: minutes(4200), breakDueMin: minutes(480) })
  .refine((h) => h.driveLeftMin != null || h.shiftLeftMin != null || h.cycleLeftMin != null, 'Enter at least one of the hours left');

const hosNote = (h) => [h.driveLeftMin != null && `drive ${hoursText(h.driveLeftMin)}`, h.shiftLeftMin != null && `shift ${hoursText(h.shiftLeftMin)}`, h.cycleLeftMin != null && `cycle ${hoursText(h.cycleLeftMin)}`].filter(Boolean).join(' · ');

async function activeLoadForWrite(user, id) {
  const load = await loadOwned('load', user, id, { write: true });
  if (!ACTIVE_TRIP_STATUSES.includes(load.status)) throw badRequest('This trip is no longer active');
  return load;
}

/** Log a check call with the driver: sets Load.lastCheckCallAt and adds a check_call event (optionally hours left and position). */
r.post('/trips/:id/check-call', ah(async (req, res) => {
  const load = await activeLoadForWrite(req.user, req.params.id);
  const body = parse(z.object({
    note: optStr(500),
    hos: hosSchema.optional().nullable(),
    location: z.object({ city: z.string().trim().max(100).nullable().optional(), state: state.nullable().optional(), lat: lat.nullable().optional(), lng: lng.nullable().optional() }).optional().nullable(),
  }), req.body || {});
  const now = new Date();
  let pt = null;
  if (body.location && (body.location.state || body.location.lat != null)) {
    pt = pointFor(body.location.city, body.location.state, body.location.lat ?? null, body.location.lng ?? null);
    if (!pt) throw badRequest('Give a city and state, or map coordinates');
  }
  // Check access to the truck before writing anything, so a refused position does not leave half a check call behind.
  const carrier = pt && load.carrierId ? await loadCarrier(req.user, load.carrierId, { write: true }) : null;
  await prisma.load.update({ where: { id: load.id }, data: { lastCheckCallAt: now } });
  if (carrier) {
    await prisma.carrier.update({
      where: { id: carrier.id },
      data: { locationCity: body.location.city || null, locationState: body.location.state || null, locationLat: pt.lat, locationLng: pt.lng, locationUpdatedAt: now, locationSource: 'manual', isFleet: true },
    });
  }
  const hos = body.hos ? clean(body.hos) : null;
  const ev = await recordLoadEvent({
    loadId: load.id, ownerId: load.ownerId, type: 'check_call', at: now, lat: pt?.lat ?? null, lng: pt?.lng ?? null, source: 'dispatcher',
    note: [body.note, hos ? `Hours left: ${hosNote(hos)}` : null].filter(Boolean).join(' · ') || null,
    data: { by: req.user.id, ...(hos ? { hos } : {}), ...(body.location?.city || body.location?.state ? { place: [body.location.city, body.location.state].filter(Boolean).join(', ') } : {}) },
  });
  await logActivity(req.user, { type: 'load', carrierId: load.carrierId, summary: `Check call: ${body.note || 'driver reached'} (${load.originCity} → ${load.destCity})` });
  invalidateToday(load.ownerId, req.user.id);
  res.json({ ok: true, lastCheckCallAt: now, event: eventView(ev) });
}));

/** Hours left on the driver's 11/14/70 clocks (planning input for the legal ETA). */
r.post('/trips/:id/hos', ah(async (req, res) => {
  const load = await activeLoadForWrite(req.user, req.params.id);
  const hos = clean(parse(hosSchema, req.body));
  if (!normalizeClocks(hos)) throw badRequest('Enter at least one of the hours left');
  const ev = await recordLoadEvent({ loadId: load.id, ownerId: load.ownerId, type: 'note', source: 'dispatcher', note: `Hours left: ${hosNote(hos)}`, data: { by: req.user.id, hos } });
  invalidateToday(load.ownerId, req.user.id);
  res.status(201).json({ event: eventView(ev) });
}));

r.get('/settings/check-calls', ah(async (req, res) => {
  const s = (await checkCallSettings([req.user.id]))[req.user.id];
  res.json({ ...s, options: CHECKCALL_HOURS });
}));

r.put('/settings/check-calls', ah(async (req, res) => {
  const body = parse(z.object({ hours: z.coerce.number().int().refine((h) => CHECKCALL_HOURS.includes(h), `Pick ${CHECKCALL_HOURS.join(', ')} hours`), enabled: z.boolean() }), req.body);
  const s = await saveCheckCallSettings(req.user.id, body);
  invalidateToday(req.user.id);
  res.json({ ...s, options: CHECKCALL_HOURS });
}));

// ---------------------------------------------------------------------------
// Broker tracking links (read-only page at /t/:token)
// ---------------------------------------------------------------------------
async function linkSettings(loadId) {
  const rows = await prisma.loadEvent.findMany({ where: { loadId, type: 'note', data: { contains: '"tracking_link"' } }, select: { data: true }, take: 50 });
  const out = {};
  for (const r2 of rows) {
    try { const d = JSON.parse(r2.data); if (d.shareId) out[d.shareId] = !!d.exact; } catch { /* ignore */ }
  }
  return out;
}

r.post('/trips/:id/tracking-links', ah(async (req, res) => {
  refuseApiToken(req, 'create tracking links');
  const load = await loadOwned('load', req.user, req.params.id, { write: true, include: { broker: { select: { companyName: true, email: true } } } });
  if (['canceled'].includes(load.status)) throw badRequest('This load was canceled');
  // The link shows the truck: the caller must still be able to see that carrier (not only own the load).
  if (load.carrierId) await loadCarrier(req.user, load.carrierId);
  const body = parse(z.object({
    label: optStr(80),
    days: z.coerce.number().int().refine((d) => LINK_DAYS.includes(d), `Pick ${LINK_DAYS.join(', ')} days`).optional().nullable(),
    exact: z.boolean().default(false),
  }), req.body || {});
  const active = await prisma.loadShare.count({ where: { loadId: load.id, revokedAt: null, expiresAt: { gt: new Date() } } });
  if (active >= 10) throw badRequest('This load already has 10 active tracking links. Revoke one first.');
  const token = newLoadShareToken(body.exact);
  const expiresAt = body.days ? new Date(Date.now() + body.days * 86400000) : defaultExpiry(load);
  const label = body.label || load.broker?.companyName || null;
  const share = await prisma.loadShare.create({ data: { loadId: load.id, ownerId: load.ownerId, tokenHash: sha256(token), label, expiresAt } });
  await recordLoadEvent({
    loadId: load.id, ownerId: load.ownerId, type: 'note', source: 'dispatcher',
    note: `Tracking link created${label ? ` for ${label}` : ''}${body.exact ? ' (exact location)' : ''}`,
    data: { kind: 'tracking_link', shareId: share.id, exact: body.exact, label },
  });
  const link = loadTrackUrl(token);
  const ref = load.referenceNumber ? `load ${load.referenceNumber}` : `the load ${load.originCity}, ${load.originState} to ${load.destCity}, ${load.destState}`;
  const text = `Live status for ${ref}: ${link}`;
  invalidateToday(load.ownerId, req.user.id);
  res.status(201).json({
    share: loadShareView(share, { exact: body.exact }), link,
    message: {
      text,
      subject: `Tracking: ${load.referenceNumber ? `load ${load.referenceNumber}` : `${load.originCity} → ${load.destCity}`}`,
      sms: `sms:?&body=${encodeURIComponent(text)}`,
      toEmail: load.broker?.email || null,
    },
  });
}));

r.get('/trips/:id/tracking-links', ah(async (req, res) => {
  const load = await loadOwned('load', req.user, req.params.id);
  const [rows, exact] = await Promise.all([
    prisma.loadShare.findMany({ where: { loadId: load.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
    linkSettings(load.id),
  ]);
  res.json({ items: rows.map((s) => loadShareView(s, { exact: exact[s.id] ?? null })) });
}));

r.post('/tracking-links/:id/revoke', ah(async (req, res) => {
  const share = await prisma.loadShare.findUnique({ where: { id: String(req.params.id) } });
  if (!share) throw notFound('Tracking link not found');
  await loadOwned('load', req.user, share.loadId, { write: true });
  const updated = share.revokedAt ? share : await prisma.loadShare.update({ where: { id: share.id }, data: { revokedAt: new Date() } });
  invalidateLoadTrack(share.tokenHash);
  res.json({ share: loadShareView(updated) });
}));

// ---------------------------------------------------------------------------
// Live location (driver links)
// ---------------------------------------------------------------------------
const shareSchema = z.object({
  driverName: optStr(80),
  driverPhone: optStr(30),
  loadId: optStr(40),
  hours: z.coerce.number().int().refine((h) => SHARE_HOURS.includes(h), 'Pick 8, 24, 72 or 168 hours').default(24),
  // A PIN read to the driver separately stops a forwarded link from working on someone else's phone (on by default).
  pin: z.boolean().default(true),
  claimMinutes: z.coerce.number().int().refine((m) => CLAIM_MINUTES.includes(m), 'Pick 30, 120 or 360 minutes').default(120),
});

/** Create a driver link. The token is returned once; only its hash is stored. */
r.post('/carriers/:id/share', ah(async (req, res) => {
  refuseApiToken(req, 'create driver links');
  const carrier = await loadCarrier(req.user, req.params.id, { write: true });
  const body = parse(shareSchema, req.body);
  if (body.loadId) {
    const load = await prisma.load.findFirst({ where: { id: body.loadId, carrierId: carrier.id } });
    if (!load) throw badRequest('That trip is not assigned to this carrier');
  }
  // One live link per carrier: older active links are stopped so the map shows a single source.
  await prisma.locationShare.updateMany({ where: { carrierId: carrier.id, status: { in: ACTIVE_SHARE } }, data: { status: 'stopped' } });
  const { share, link, message, pin } = await createShare(req.user, carrier, { ...body });
  if (!carrier.isFleet) await prisma.carrier.update({ where: { id: carrier.id }, data: { isFleet: true } });
  await logActivity(req.user, { type: 'fleet', carrierId: carrier.id, summary: `Live location link created for ${share.driverName || 'the driver'} (${body.hours} h${pin ? ', PIN' : ''})` });
  // The link and PIN are returned only now; neither can be recovered later.
  res.status(201).json({ share: shareView(share), link, message, pin });
}));

r.get('/carriers/:id/shares', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id);
  const rows = await prisma.locationShare.findMany({ where: { carrierId: carrier.id }, orderBy: { createdAt: 'desc' }, take: 20 });
  res.json({ items: rows.map((x) => shareView(x)) });
}));

r.post('/shares/:id/stop', ah(async (req, res) => {
  const share = await prisma.locationShare.findUnique({ where: { id: String(req.params.id) } });
  if (!share) throw notFound('Share not found');
  await loadCarrier(req.user, share.carrierId, { write: true });
  const updated = await prisma.locationShare.update({ where: { id: share.id }, data: { status: 'stopped' } });
  res.json({ share: shareView(updated) });
}));

/**
 * Unlock a link from the phone that claimed it (the driver changed phones, or someone else claimed it first).
 * The next phone must claim it again; links with a PIN get a new PIN, shown once.
 */
r.post('/shares/:id/reset-device', ah(async (req, res) => {
  const share = await prisma.locationShare.findUnique({ where: { id: String(req.params.id) } });
  if (!share) throw notFound('Share not found');
  await loadCarrier(req.user, share.carrierId, { write: true });
  const view = shareView(share);
  if (!['pending', 'sharing', 'paused', 'locked'].includes(view.status)) throw badRequest('This link has ended. Create a new link instead.');
  const pin = share.pinHash ? newPin() : null;
  const now = new Date();
  const updated = await prisma.locationShare.update({
    where: { id: share.id },
    data: {
      deviceHash: null, deviceLabel: null, deviceKind: null, deviceBoundAt: null, firstSeenIp: null, pinVerifiedAt: null, pinAttempts: 0,
      consentAt: null, status: 'pending', lastPingFlags: null, trustedLat: null, trustedLng: null, trustedAt: null,
      ...(pin ? { pinHash: pinHashFor(share.tokenHash, pin) } : {}),
      // A link that was never claimed gets a fresh claim window; a claimed one keeps its end time.
      ...(!share.firstBoundAt ? { expiresAt: new Date(now.getTime() + share.claimMinutes * 60_000) } : {}),
    },
  });
  await logActivity(req.user, { type: 'fleet', carrierId: share.carrierId, summary: `Location link reset so ${share.driverName || 'the driver'} can open it on a new phone` });
  res.json({ share: shareView(updated), pin });
}));

/** Message text and send links again for an active share (the link itself cannot be recovered). */
r.get('/shares/:id/message', ah(async (req, res) => {
  const share = await prisma.locationShare.findUnique({ where: { id: String(req.params.id) } });
  if (!share) throw notFound('Share not found');
  const carrier = await loadCarrier(req.user, share.carrierId);
  res.json({ note: 'For security the link is shown only when it is created. Create a new link to send it again.', message: shareMessage({ companyName: carrier.companyName, link: '', driverPhone: share.driverPhone }) });
}));

/** GPS breadcrumbs for the last N hours. */
r.get('/carriers/:id/trail', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id);
  const q = parse(z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) }), req.query);
  const since = new Date(Date.now() - q.hours * 3600_000);
  const pings = await prisma.locationPing.findMany({
    where: { at: { gte: since }, share: { carrierId: carrier.id } },
    orderBy: { at: 'asc' }, take: 2000, select: { lat: true, lng: true, speed: true, heading: true, accuracy: true, at: true, flags: true },
  });
  // Implausible jumps are left out of the trail so it never draws a line to a position the truck could not have reached.
  const real = pings.filter((p) => !String(p.flags || '').includes('impossible_jump'));
  res.json({
    items: real.map((p) => ({ lat: p.lat, lng: p.lng, at: p.at, speedMph: p.speed != null ? Math.round(p.speed * 2.23694) : null, heading: p.heading })),
    skipped: pings.length - real.length,
  });
}));

/** Driver check-ins and other activity for the truck timeline. */
r.get('/carriers/:id/checkins', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id);
  const rows = await prisma.activity.findMany({ where: { carrierId: carrier.id, type: { in: ['checkin', 'fleet', 'load'] } }, orderBy: { createdAt: 'desc' }, take: 30 });
  res.json({ items: rows.map((a) => ({ id: a.id, type: a.type, summary: a.summary, createdAt: a.createdAt })) });
}));

export default r;
