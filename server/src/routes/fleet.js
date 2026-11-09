import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest } from '../lib/errors.js';
import { parse, z, optStr, optInt, optDate, clean } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { loadCarrier, loadOwned, readableOwnerIds } from '../lib/access.js';
import { EQUIPMENT } from '../lib/constants.js';
import { logActivity } from '../lib/activity.js';
import { timezoneForState } from '../lib/timezones.js';
import {
  TRUCK_STATUSES, ACTIVE_TRIP_STATUSES, TRIP_FLOW, pointFor, estimateMiles, crowMiles, searchPlaces, truckView, tripView, availableBy,
} from '../services/fleet/index.js';

/**
 * Fleet map: where each truck is, what it is doing, and the trips planned for it.
 * Trips are ordinary Load rows (status planned → booked → in_transit → delivered) linked to the carrier.
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
};

async function visibleWhere(user, scope) {
  const owners = await readableOwnerIds(user, scope === 'team' ? 'team' : 'mine');
  return { OR: [{ ownerId: { in: owners } }, { assignedToId: user.id }] };
}

r.get('/', ah(async (req, res) => {
  const q = parse(z.object({ scope: z.enum(['fleet', 'all']).default('fleet'), team: z.enum(['true', 'false']).default('false') }), req.query);
  const base = await visibleWhere(req.user, q.team === 'true' ? 'team' : 'mine');
  const fleetOnly = {
    OR: [{ customer: { isNot: null } }, { truckStatus: { not: 'unknown' } }, { locationState: { not: null } }, { locationLat: { not: null } },
      { loads: { some: { status: { in: ACTIVE_TRIP_STATUSES } } } }],
  };
  const where = q.scope === 'all' ? base : { AND: [base, fleetOnly] };
  const [rows, open] = await Promise.all([
    prisma.carrier.findMany({ where, include: truckInclude, orderBy: [{ companyName: 'asc' }], take: 500 }),
    // Open loads (no carrier yet) are shown as origins on the map.
    prisma.load.findMany({
      where: { ownerId: req.user.id, carrierId: null, status: { in: ['planned', 'booked'] } },
      orderBy: { pickupDate: 'asc' }, take: 200, include: tripLoadInclude,
    }),
  ]);
  const trucks = rows.map(truckView);
  const counts = Object.fromEntries(TRUCK_STATUSES.map((s) => [s, trucks.filter((t) => t.truckStatus === s).length]));
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
    });
  }
  const updated = await prisma.carrier.update({ where: { id: carrier.id }, data, include: truckInclude });
  if (data.truckStatus && data.truckStatus !== carrier.truckStatus) {
    await logActivity(req.user, { type: 'fleet', carrierId: carrier.id, summary: `Truck status: ${data.truckStatus.replace('_', ' ')}` });
  }
  if (body.location) {
    await logActivity(req.user, { type: 'fleet', carrierId: carrier.id, summary: `Truck location set to ${[data.locationCity, data.locationState].filter(Boolean).join(', ') || `${data.locationLat.toFixed(3)}, ${data.locationLng.toFixed(3)}`}` });
  }
  res.json({ truck: truckView(updated) });
}));

/** Rank trucks near a point: available ones first by distance, then the rest. */
r.get('/near', ah(async (req, res) => {
  const q = parse(z.object({
    lat: lat.optional(), lng: lng.optional(), city: optStr(100), state: state.optional(),
    equipment: z.enum(EQUIPMENT).optional(), by: optDate, radius: z.coerce.number().min(1).max(3000).default(500),
  }), req.query);
  const pt = q.lat != null && q.lng != null ? { lat: q.lat, lng: q.lng } : pointFor(q.city, q.state);
  if (!pt) throw badRequest('Give a place (city and state) or coordinates');
  const rows = await prisma.carrier.findMany({ where: await visibleWhere(req.user, 'mine'), include: truckInclude, take: 500 });
  const cutoff = q.by || new Date(Date.now() + 86400000);
  const items = rows.map(truckView)
    .filter((t) => t.location?.lat != null)
    .filter((t) => !q.equipment || String(t.equipment || '').split(',').includes(q.equipment))
    .map((t) => {
      const miles = Math.round(crowMiles(pt, t.location));
      return { ...t, distanceMiles: miles, deadheadEstimate: estimateMiles(pt, t.location), availableInTime: availableBy(t, cutoff) && !t.currentTrip };
    })
    .filter((t) => t.distanceMiles <= q.radius)
    .sort((a, b) => (b.availableInTime - a.availableInTime) || a.distanceMiles - b.distanceMiles)
    .slice(0, 50);
  res.json({ point: pt, items, cutoff });
}));

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

r.post('/trips', ah(async (req, res) => {
  const b = parse(tripSchema, req.body);
  checkDates(b);
  const carrier = await loadCarrier(req.user, b.carrierId, { write: true });
  if (b.brokerId) await loadOwned('broker', req.user, b.brokerId);
  const o = pointFor(b.origin.city, b.origin.state, b.origin.lat, b.origin.lng);
  const d = pointFor(b.dest.city, b.dest.state, b.dest.lat, b.dest.lng);
  if (!o || !d) throw badRequest('Unknown origin or destination');
  const truck = pointFor(carrier.locationCity, carrier.locationState, carrier.locationLat, carrier.locationLng);
  const loadedMiles = b.loadedMiles ?? Math.max(1, estimateMiles(o, d));
  const deadheadMiles = b.deadheadMiles ?? (truck ? estimateMiles(truck, o) : 0);
  const load = await prisma.load.create({
    data: clean({
      ownerId: req.user.id, carrierId: carrier.id, brokerId: b.brokerId || null, status: b.status,
      originCity: b.origin.city, originState: b.origin.state, originLat: o.lat, originLng: o.lng,
      destCity: b.dest.city, destState: b.dest.state, destLat: d.lat, destLng: d.lng,
      pickupDate: b.pickupDate ?? null, deliveryDate: b.deliveryDate ?? null, rateCents: b.rateCents,
      loadedMiles, deadheadMiles, equipment: b.equipment ?? null, commodity: b.commodity ?? null, weightLbs: b.weightLbs ?? null,
      referenceNumber: b.referenceNumber ?? null, notes: b.notes ?? null, mpg: b.mpg ?? null, fuelPricePerGallon: b.fuelPricePerGallon ?? null,
    }),
    include: tripLoadInclude,
  });
  await logActivity(req.user, {
    type: 'load', carrierId: carrier.id,
    summary: `Planned trip ${load.originCity}, ${load.originState} → ${load.destCity}, ${load.destState} at $${(load.rateCents / 100).toLocaleString('en-US')}`,
  });
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
  }
  const load = await prisma.load.update({ where: { id: existing.id }, data, include: tripLoadInclude });
  res.json({ trip: tripView(load) });
}));

/** Move a trip along planned → booked → in_transit → delivered (or cancel). The truck follows. */
r.post('/trips/:id/status', ah(async (req, res) => {
  const existing = await loadOwned('load', req.user, req.params.id, { write: true });
  const { status } = parse(z.object({ status: z.enum([...TRIP_FLOW, 'canceled']) }), req.body);
  if (['delivered', 'invoiced', 'paid', 'canceled'].includes(existing.status) && status !== existing.status) {
    throw badRequest(`This trip is already ${existing.status}`);
  }
  if (status !== 'canceled' && TRIP_FLOW.indexOf(status) < TRIP_FLOW.indexOf(existing.status)) throw badRequest('Trips only move forward');
  const load = await prisma.load.update({ where: { id: existing.id }, data: { status }, include: tripLoadInclude });
  let truck = null;
  if (existing.carrierId) {
    const carrier = await loadCarrier(req.user, existing.carrierId, { write: true }).catch(() => null);
    if (carrier) {
      const data = {};
      if (status === 'in_transit') data.truckStatus = 'loaded';
      if (status === 'delivered') {
        const pt = pointFor(load.destCity, load.destState, load.destLat, load.destLng);
        Object.assign(data, {
          truckStatus: 'available', locationCity: load.destCity, locationState: load.destState,
          locationLat: pt?.lat ?? null, locationLng: pt?.lng ?? null, locationUpdatedAt: new Date(),
          availableAt: load.deliveryDate && load.deliveryDate > new Date() ? load.deliveryDate : new Date(),
        });
      }
      if (status === 'canceled' && existing.status === 'in_transit') data.truckStatus = 'available';
      if (Object.keys(data).length) {
        const updated = await prisma.carrier.update({ where: { id: carrier.id }, data, include: truckInclude });
        truck = truckView(updated);
      }
    }
  }
  await logActivity(req.user, { type: 'load', carrierId: load.carrierId, summary: `Trip ${load.originCity} → ${load.destCity} is now ${status.replace('_', ' ')}` });
  res.json({ trip: tripView(load), truck });
}));

r.delete('/trips/:id', ah(async (req, res) => {
  const load = await loadOwned('load', req.user, req.params.id, { write: true });
  if (!['planned', 'booked', 'canceled'].includes(load.status)) throw badRequest('Only planned, booked or canceled trips can be deleted');
  await prisma.load.delete({ where: { id: load.id } });
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

export default r;
