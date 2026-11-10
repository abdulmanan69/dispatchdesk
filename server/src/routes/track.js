import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, HttpError, badRequest } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { notify } from '../lib/activity.js';
import { randomToken } from '../lib/crypto.js';
import { trackLimiter } from '../middleware/security.js';
import {
  findShareByToken, MIN_PING_MS, MAX_PINGS_PER_DAY, PIN_MAX_ATTEMPTS, ALERT_EVERY_MS,
  checkPin, deviceMatches, deviceHashFor, describeDevice, coarseIp, addFlags, evaluateFix, referenceFor, flagText,
} from '../services/fleet/track.js';
import { truckUpdateForTrip, TRIP_FLOW, nearestPlace, pointFor } from '../services/fleet/index.js';

/**
 * Public driver endpoints. The secret token in the URL is the credential (no session, no CSRF), and once a phone has
 * claimed the link every request must also carry that phone's device secret in X-Track-Device.
 * Responses expose only what the driver needs: company, dispatcher first name and their own trip.
 */
const r = Router();
r.use(trackLimiter);

const GONE = {
  expired: 'This location link has expired. Ask your dispatcher for a new one.',
  unopened: 'This link was not opened in time and has expired. Ask your dispatcher for a new one.',
  stopped: 'Location sharing was turned off for this link.',
  locked: 'Too many wrong PINs. This link is locked. Ask your dispatcher for a new link.',
};
const gone = (reason) => new HttpError(410, GONE[reason] || 'This link is not valid.', { code: reason === 'locked' ? 'LOCKED' : 'GONE' });
const MISMATCH = 'This link is already active on another phone. Ask your dispatcher for a new link.';

async function resolve(req) {
  const { share, gone: reason } = await findShareByToken(req.params.token);
  if (reason) throw gone(reason);
  return share;
}

const signalsSchema = z.object({
  touch: z.boolean().optional(),
  coarse: z.boolean().optional(),
  width: z.coerce.number().int().min(0).max(20000).optional(),
}).partial().optional();

/**
 * Notify the dispatcher at most once per 30 minutes per link and kind (atomic across processes).
 * kind 'security' covers other-device attempts; kind 'gps' covers implausible positions.
 */
async function alertDispatcher(share, title, body, kind = 'security') {
  const now = new Date();
  const field = kind === 'gps' ? 'lastGpsAlertAt' : 'lastAlertAt';
  const { count } = await prisma.locationShare.updateMany({
    where: { id: share.id, OR: [{ [field]: null }, { [field]: { lt: new Date(now.getTime() - ALERT_EVERY_MS) } }] },
    data: { [field]: now },
  });
  if (count === 1) await notify(share.ownerId, { type: 'fleet_issue', title: title.slice(0, 200), body: body?.slice(0, 500) ?? null, link: '/app/fleet' });
}

async function recordFlags(share, items) {
  if (!items.length) return;
  const fresh = await prisma.locationShare.findUnique({ where: { id: share.id }, select: { flags: true } });
  await prisma.locationShare.update({ where: { id: share.id }, data: { flags: addFlags(fresh?.flags, items) } });
}

/**
 * Check the caller's device against the link. Returns 'ok' (this phone owns the link), 'unbound' (nobody claimed it yet)
 * or throws 409 DEVICE_MISMATCH after recording the attempt and alerting the dispatcher.
 */
async function deviceState(share, req) {
  if (!share.deviceHash) return 'unbound';
  if (deviceMatches(share, req.get('x-track-device'))) return 'ok';
  const dev = describeDevice(req.get('user-agent'));
  const net = coarseIp(req.ip);
  await recordFlags(share, [{ type: 'other_device', detail: `${dev.label}${net ? ` from ${net}` : ''}` }]);
  const who = share.driverName || share.carrier.companyName;
  await alertDispatcher(share, `${who}'s location link was opened on another device`, `${dev.label}${net ? ` from network ${net}` : ''}. The link stays locked to the first phone. If the driver changed phones, reset the device on the fleet map.`);
  throw new HttpError(409, MISMATCH, { code: 'DEVICE_MISMATCH' });
}

/**
 * Bind the link to this phone (first claim only). Returns the device secret once; only its hash is stored.
 * A conditional update makes the first claim win even when two phones race (cluster-safe).
 */
async function claimDevice(share, req, signals, { pinVerified = false } = {}) {
  const now = new Date();
  const secret = randomToken(24);
  const { label, kind } = describeDevice(req.get('user-agent'), signals || {});
  const data = {
    deviceHash: deviceHashFor(secret), deviceLabel: label, deviceKind: kind, deviceBoundAt: now, firstSeenIp: coarseIp(req.ip),
    ...(pinVerified ? { pinVerifiedAt: now } : {}),
    // The full duration starts when the link is first claimed.
    ...(!share.firstBoundAt ? { firstBoundAt: now, expiresAt: new Date(now.getTime() + share.durationHours * 3600_000) } : {}),
    ...(kind === 'desktop' ? { flags: addFlags(share.flags, [{ type: 'desktop', detail: label }], now) } : {}),
  };
  const { count } = await prisma.locationShare.updateMany({ where: { id: share.id, deviceHash: null }, data });
  if (count !== 1) {
    // Another phone claimed it a moment earlier: record the attempt like any other device, never hand out a secret.
    const fresh = await prisma.locationShare.findUnique({ where: { id: share.id } });
    if (fresh) await deviceState({ ...fresh, carrier: share.carrier }, req);
    throw new HttpError(409, MISMATCH, { code: 'DEVICE_MISMATCH' });
  }
  return secret;
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

async function fullInfo(share, bound) {
  const trip = await tripFor(share);
  return {
    company: share.carrier.companyName,
    dispatcher: (share.owner?.name || '').split(/\s+/)[0] || 'Your dispatcher',
    driverName: share.driverName,
    status: share.status,
    consentAt: share.consentAt,
    expiresAt: share.expiresAt,
    lastAt: share.lastAt,
    minIntervalSec: MIN_PING_MS / 1000,
    pinRequired: false,
    pinEnabled: !!share.pinHash,
    bound,
    trip: tripPublic(trip),
  };
}

r.get('/:token', ah(async (req, res) => {
  const share = await resolve(req);
  const dev = await deviceState(share, req);
  // With a PIN, nothing but the company name is shown until the PIN is entered on this phone.
  if (dev === 'unbound' && share.pinHash) {
    return res.json({ company: share.carrier.companyName, pinRequired: true, status: share.status, claimBy: share.firstBoundAt ? null : share.expiresAt });
  }
  res.json(await fullInfo(share, dev === 'ok'));
}));

r.post('/:token/pin', ah(async (req, res) => {
  const share = await resolve(req);
  const body = parse(z.object({ pin: z.string().trim().max(12), signals: signalsSchema }), req.body);
  if (!share.pinHash) throw badRequest('This link does not use a PIN.');
  if (share.deviceHash) {
    await deviceState(share, req); // throws for any other phone
    return res.json({ ...(await fullInfo(share, true)), deviceSecret: null });
  }
  if (!checkPin(share, body.pin)) {
    const upd = await prisma.locationShare.update({ where: { id: share.id }, data: { pinAttempts: { increment: 1 } } });
    const left = Math.max(0, PIN_MAX_ATTEMPTS - upd.pinAttempts);
    const dev = describeDevice(req.get('user-agent'));
    const net = coarseIp(req.ip);
    await recordFlags(share, [{ type: 'wrong_pin', detail: `attempt ${upd.pinAttempts} · ${dev.label}${net ? ` from ${net}` : ''}` }]);
    if (left === 0) {
      await prisma.locationShare.update({ where: { id: share.id }, data: { status: 'locked' } });
      await recordFlags(share, [{ type: 'locked', detail: `${PIN_MAX_ATTEMPTS} wrong PINs` }]);
      await notify(share.ownerId, { type: 'fleet_issue', title: `${share.driverName || share.carrier.companyName}'s location link was locked`, body: `${PIN_MAX_ATTEMPTS} wrong PINs were entered. Create a new link if the driver still needs one.`, link: '/app/fleet' });
      throw gone('locked');
    }
    throw new HttpError(403, `That PIN is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`, { code: 'WRONG_PIN', attemptsLeft: left });
  }
  const deviceSecret = await claimDevice(share, req, body.signals, { pinVerified: true });
  const fresh = await prisma.locationShare.findUnique({ where: { id: share.id }, include: { carrier: true, owner: { select: { id: true, name: true } } } });
  res.json({ ...(await fullInfo(fresh, true)), deviceSecret });
}));

r.post('/:token/consent', ah(async (req, res) => {
  const share = await resolve(req);
  const body = parse(z.object({ signals: signalsSchema }).partial(), req.body || {});
  const dev = await deviceState(share, req);
  let deviceSecret = null;
  if (dev === 'unbound') {
    if (share.pinHash) throw new HttpError(409, 'Enter the PIN your dispatcher gave you first.', { code: 'PIN_REQUIRED' });
    deviceSecret = await claimDevice(share, req, body.signals);
  }
  const updated = await prisma.locationShare.update({ where: { id: share.id }, data: { consentAt: share.consentAt || new Date(), status: 'sharing' } });
  res.json({ status: updated.status, consentAt: updated.consentAt, expiresAt: updated.expiresAt, ...(deviceSecret ? { deviceSecret } : {}) });
}));

const pingSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  accuracy: z.coerce.number().min(0).max(100000).nullable().optional(),
  speed: z.coerce.number().min(0).max(100).nullable().optional(), // m/s
  heading: z.coerce.number().min(0).max(360).nullable().optional(),
  clientTime: z.coerce.number().int().min(0).nullable().optional(), // the fix's timestamp from the phone (ms)
});

/** A link opened before phone locking existed (consented, never bound) keeps working without a device secret. */
const isLegacy = (share) => !share.deviceHash && !share.firstBoundAt && !!share.consentAt;

r.post('/:token/ping', ah(async (req, res) => {
  const share = await resolve(req);
  const dev = await deviceState(share, req);
  if (dev === 'unbound' && !isLegacy(share)) {
    if (share.pinHash) throw new HttpError(409, 'Enter the PIN your dispatcher gave you first.', { code: 'PIN_REQUIRED' });
    throw new HttpError(409, 'Agree to share your location first.', { code: 'CONSENT_REQUIRED' });
  }
  if (!share.consentAt) throw new HttpError(409, 'Agree to share your location first.', { code: 'CONSENT_REQUIRED' });
  const p = parse(pingSchema, req.body);
  const now = new Date();
  if (share.lastAt && now - share.lastAt < MIN_PING_MS) {
    return res.status(429).json({ error: 'Too soon', retryAfterSec: Math.ceil((MIN_PING_MS - (now - share.lastAt)) / 1000) });
  }
  const today = await prisma.locationPing.count({ where: { shareId: share.id, at: { gte: new Date(now.getTime() - 86400000) } } });
  if (today >= MAX_PINGS_PER_DAY) return res.status(429).json({ error: 'Daily location limit reached for this link.' });

  const trip = await tripFor(share);
  const tripPts = trip && {
    status: trip.status,
    origin: pointFor(trip.originCity, trip.originState, trip.originLat, trip.originLng),
    dest: pointFor(trip.destCity, trip.destState, trip.destLat, trip.destLng),
  };
  const kind = share.deviceKind === 'desktop' || describeDevice(req.get('user-agent')).kind === 'desktop' ? 'desktop' : share.deviceKind;
  const { flags, trusted } = evaluateFix({ fix: p, reference: referenceFor(share, share.carrier, now), trip: tripPts, deviceKind: kind, now });
  const flagTypes = flags.map((f) => f.type);

  const shareData = {
    status: 'sharing', lastLat: p.lat, lastLng: p.lng, lastAccuracy: p.accuracy ?? null, lastSpeed: p.speed ?? null, lastHeading: p.heading ?? null, lastAt: now,
    lastPingFlags: flagTypes.length ? flagTypes.join(',') : null,
    ...(flags.length ? { flags: addFlags(share.flags, flags, now) } : {}),
    // Only plausible fixes become the new reference point.
    ...(trusted ? { trustedLat: p.lat, trustedLng: p.lng, trustedAt: now } : {}),
  };
  const ops = [
    prisma.locationPing.create({ data: { shareId: share.id, lat: p.lat, lng: p.lng, accuracy: p.accuracy ?? null, speed: p.speed ?? null, heading: p.heading ?? null, flags: flagTypes.length ? flagTypes.join(',') : null, at: now } }),
    prisma.locationShare.update({ where: { id: share.id }, data: shareData }),
  ];
  if (trusted) {
    // An implausible jump never moves the truck on the dispatcher's map; it is kept as an unverified fix instead.
    const near = nearestPlace(p.lat, p.lng);
    const truck = { locationLat: p.lat, locationLng: p.lng, locationCity: near?.city ?? null, locationState: near?.state ?? null, locationUpdatedAt: now, locationSource: 'driver_link' };
    // A moving driver with a trip under way is loaded; otherwise leave the status the dispatcher set.
    if (trip?.status === 'in_transit') truck.truckStatus = 'loaded';
    ops.push(prisma.carrier.update({ where: { id: share.carrierId }, data: truck }));
  }
  await prisma.$transaction(ops);

  const serious = flags.filter((f) => ['impossible_jump', 'far_from_trip', 'desktop'].includes(f.type));
  if (serious.length) {
    const who = share.driverName || share.carrier.companyName;
    await alertDispatcher(share, `Check ${who}'s live location`, serious.map((f) => `${flagText(f.type)}${f.detail ? ` (${f.detail})` : ''}`).join('; '), 'gps');
  }
  res.json({ ok: true, at: now, nextInSec: MIN_PING_MS / 1000 });
}));

r.post('/:token/stop', ah(async (req, res) => {
  const share = await resolve(req);
  const dev = await deviceState(share, req);
  if (dev === 'unbound' && share.pinHash) throw new HttpError(409, 'Enter the PIN your dispatcher gave you first.', { code: 'PIN_REQUIRED' });
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
  const body = parse(z.object({ event: z.enum(Object.keys(CHECKINS)), note: z.string().trim().max(500).optional(), signals: signalsSchema }), req.body);
  const dev = await deviceState(share, req);
  let deviceSecret = null;
  if (dev === 'unbound' && !isLegacy(share)) {
    if (share.pinHash) throw new HttpError(409, 'Enter the PIN your dispatcher gave you first.', { code: 'PIN_REQUIRED' });
    // Checking in without sharing location also claims the link for this phone.
    deviceSecret = await claimDevice(share, req, body.signals);
  }
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
  res.json({ ok: true, event: body.event, tripStatus, ...(deviceSecret ? { deviceSecret } : {}) });
}));

export default r;
