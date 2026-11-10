import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, HttpError } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { notify } from '../lib/activity.js';
import { trackLimiter } from '../middleware/security.js';
import { findShareByToken, MIN_PING_MS, MAX_PINGS_PER_DAY } from '../services/fleet/track.js';
import { truckUpdateForTrip, TRIP_FLOW, nearestPlace } from '../services/fleet/index.js';

/**
 * Public driver endpoints. The secret token in the URL is the only credential (no session, no CSRF).
 * Responses expose only what the driver needs: company, dispatcher first name and their own trip.
 */
const r = Router();
r.use(trackLimiter);

const gone = (reason) => new HttpError(410, reason === 'expired' ? 'This location link has expired. Ask your dispatcher for a new one.' : reason === 'stopped' ? 'Location sharing was turned off for this link.' : 'This link is not valid.');

async function resolve(req) {
  const { share, gone: reason } = await findShareByToken(req.params.token);
  if (reason) throw gone(reason);
  return share;
}

async function tripFor(share) {
  const where = share.loadId
    ? { id: share.loadId, carrierId: share.carrierId }
    : { carrierId: share.carrierId, status: { in: ['booked', 'in_transit', 'planned'] } };
  return prisma.load.findFirst({ where, orderBy: [{ pickupDate: 'asc' }, { createdAt: 'asc' }] });
}

const tripPublic = (l) => l && {
  id: l.id, status: l.status, referenceNumber: l.referenceNumber,
  pickup: { city: l.originCity, state: l.originState, lat: l.originLat, lng: l.originLng, date: l.pickupDate },
  delivery: { city: l.destCity, state: l.destState, lat: l.destLat, lng: l.destLng, date: l.deliveryDate },
  equipment: l.equipment, commodity: l.commodity,
};

r.get('/:token', ah(async (req, res) => {
  const share = await resolve(req);
  const trip = await tripFor(share);
  res.json({
    company: share.carrier.companyName,
    dispatcher: (share.owner.name || '').split(/\s+/)[0] || 'Your dispatcher',
    driverName: share.driverName,
    status: share.status,
    consentAt: share.consentAt,
    expiresAt: share.expiresAt,
    lastAt: share.lastAt,
    minIntervalSec: MIN_PING_MS / 1000,
    trip: tripPublic(trip),
  });
}));

r.post('/:token/consent', ah(async (req, res) => {
  const share = await resolve(req);
  const updated = await prisma.locationShare.update({ where: { id: share.id }, data: { consentAt: share.consentAt || new Date(), status: 'sharing' } });
  res.json({ status: updated.status, consentAt: updated.consentAt });
}));

const pingSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  accuracy: z.coerce.number().min(0).max(100000).nullable().optional(),
  speed: z.coerce.number().min(0).max(100).nullable().optional(), // m/s
  heading: z.coerce.number().min(0).max(360).nullable().optional(),
});

r.post('/:token/ping', ah(async (req, res) => {
  const share = await resolve(req);
  if (!share.consentAt) throw new HttpError(409, 'Agree to share your location first.');
  const p = parse(pingSchema, req.body);
  const now = new Date();
  if (share.lastAt && now - share.lastAt < MIN_PING_MS) {
    return res.status(429).json({ error: 'Too soon', retryAfterSec: Math.ceil((MIN_PING_MS - (now - share.lastAt)) / 1000) });
  }
  const today = await prisma.locationPing.count({ where: { shareId: share.id, at: { gte: new Date(now.getTime() - 86400000) } } });
  if (today >= MAX_PINGS_PER_DAY) return res.status(429).json({ error: 'Daily location limit reached for this link.' });

  const trip = await tripFor(share);
  const near = nearestPlace(p.lat, p.lng);
  const truck = { locationLat: p.lat, locationLng: p.lng, locationCity: near?.city ?? null, locationState: near?.state ?? null, locationUpdatedAt: now, locationSource: 'driver_link' };
  // A moving driver with a trip under way is loaded; otherwise leave the status the dispatcher set.
  if (trip?.status === 'in_transit') truck.truckStatus = 'loaded';
  await prisma.$transaction([
    prisma.locationPing.create({ data: { shareId: share.id, lat: p.lat, lng: p.lng, accuracy: p.accuracy ?? null, speed: p.speed ?? null, heading: p.heading ?? null, at: now } }),
    prisma.locationShare.update({
      where: { id: share.id },
      data: { status: 'sharing', lastLat: p.lat, lastLng: p.lng, lastAccuracy: p.accuracy ?? null, lastSpeed: p.speed ?? null, lastHeading: p.heading ?? null, lastAt: now },
    }),
    prisma.carrier.update({ where: { id: share.carrierId }, data: truck }),
  ]);
  res.json({ ok: true, at: now, nextInSec: MIN_PING_MS / 1000 });
}));

r.post('/:token/stop', ah(async (req, res) => {
  const share = await resolve(req);
  await prisma.locationShare.update({ where: { id: share.id }, data: { status: 'paused' } });
  await notify(share.ownerId, { type: 'fleet', title: `${share.driverName || share.carrier.companyName} stopped sharing location`, link: '/app/fleet' });
  res.json({ status: 'paused' });
}));

const CHECKINS = {
  arrived_pickup: { label: 'Arrived at pickup', status: null },
  loaded: { label: 'Loaded', status: 'in_transit' },
  arrived_delivery: { label: 'Arrived at delivery', status: null },
  delivered: { label: 'Delivered', status: 'delivered' },
  issue: { label: 'Reported an issue', status: null },
};

r.post('/:token/checkin', ah(async (req, res) => {
  const share = await resolve(req);
  const body = parse(z.object({ event: z.enum(Object.keys(CHECKINS)), note: z.string().trim().max(500).optional() }), req.body);
  const def = CHECKINS[body.event];
  const trip = await tripFor(share);
  let tripStatus = trip?.status ?? null;
  if (trip && def.status && TRIP_FLOW.includes(trip.status) && TRIP_FLOW.indexOf(def.status) > TRIP_FLOW.indexOf(trip.status)) {
    await prisma.load.update({ where: { id: trip.id }, data: { status: def.status } });
    tripStatus = def.status;
    const data = truckUpdateForTrip(trip.status, def.status, trip);
    if (Object.keys(data).length) await prisma.carrier.update({ where: { id: share.carrierId }, data });
  }
  const who = share.driverName || share.carrier.companyName;
  const where = trip ? ` (${trip.originCity} → ${trip.destCity})` : '';
  const summary = `${who}: ${def.label}${where}${body.note ? ` · ${body.note}` : ''}`;
  const owner = await prisma.user.findUnique({ where: { id: share.ownerId }, select: { id: true } });
  const member = await prisma.teamMember.findUnique({ where: { userId: share.ownerId }, select: { teamId: true } });
  await prisma.activity.create({ data: { userId: owner.id, carrierId: share.carrierId, teamId: member?.teamId ?? null, type: 'checkin', summary: summary.slice(0, 500) } });
  await notify(share.ownerId, { type: body.event === 'issue' ? 'fleet_issue' : 'fleet', title: summary.slice(0, 200), link: '/app/fleet' });
  res.json({ ok: true, event: body.event, tripStatus });
}));

export default r;
