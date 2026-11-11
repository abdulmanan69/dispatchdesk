import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, HttpError, badRequest } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { notify } from '../lib/activity.js';
import { randomToken } from '../lib/crypto.js';
import { trackLimiter } from '../middleware/security.js';
import { uploader, verifyFileSignature } from '../middleware/upload.js';
import {
  findShareByToken, MIN_PING_MS, MAX_PINGS_PER_DAY, PIN_MAX_ATTEMPTS, ALERT_EVERY_MS,
  checkPin, deviceMatches, deviceHashFor, describeDevice, coarseIp, addFlags, evaluateFix, referenceFor, flagText,
} from '../services/fleet/track.js';
import { truckUpdateForTrip, TRIP_FLOW, nearestPlace, pointFor, routeIsCurrent } from '../services/fleet/index.js';
import { measuredRoute, projectOnRoute, OFF_ROUTE_MILES } from '../services/fleet/progress.js';
import { normalizeClocks, hoursText } from '../services/fleet/hos.js';
import { recordLoadEvent } from '../services/fleet/events.js';
import { invalidateToday } from '../services/fleet/today.js';

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
  if (count === 1) await notify(share.ownerId, { type: 'fleet_issue', title: title.slice(0, 200), body: body?.slice(0, 500) ?? null, link: `/app/fleet?truck=${share.carrierId}` });
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

const SHOWN_TRIP_DAYS = 3;

/**
 * The trip a driver's action belongs to. A link without a fixed trip moves on to the truck's next trip as soon as one is
 * delivered, so a second tap on "Delivered" would deliver the next trip, and the POD taken right after (or queued on the
 * phone without signal) would land on it. The page therefore sends the trip it showed (loadId), which is used when it
 * is this truck's load and still active or delivered in the last few days. Otherwise the link's current trip.
 */
async function shownTrip(share, current, loadId) {
  if (!loadId || share.loadId || loadId === current?.id) return current;
  const shown = await prisma.load.findFirst({
    where: {
      id: loadId, carrierId: share.carrierId,
      OR: [
        { status: { in: ['planned', 'booked', 'in_transit'] } },
        { status: { in: ['delivered', 'invoiced', 'paid'] }, updatedAt: { gte: new Date(Date.now() - SHOWN_TRIP_DAYS * 86400000) } },
      ],
    },
  });
  return shown || current;
}

const stopPublic = (l, kind) => {
  const p = kind === 'pickup';
  return {
    city: p ? l.originCity : l.destCity, state: p ? l.originState : l.destState,
    lat: p ? l.originLat : l.destLat, lng: p ? l.originLng : l.destLng,
    date: p ? l.pickupDate : l.deliveryDate,
    windowStart: (p ? l.pickupWindowStart : l.deliveryWindowStart) ?? null, windowEnd: (p ? l.pickupWindowEnd : l.deliveryWindowEnd) ?? null,
    tz: (p ? l.pickupTz : l.deliveryTz) ?? null,
    facility: (p ? l.pickupFacility : l.deliveryFacility) ?? null, address: (p ? l.pickupAddress : l.deliveryAddress) ?? null,
  };
};
const tripPublic = (l) => l && {
  id: l.id, status: l.status, referenceNumber: l.referenceNumber,
  pickup: stopPublic(l, 'pickup'), delivery: stopPublic(l, 'delivery'),
  equipment: l.equipment, commodity: l.commodity,
};

// Photos and scans from the driver: images and PDF only, 8 MB each, 20 per link and day.
export const DRIVER_DOC_TYPES = ['bol', 'pod', 'lumper_receipt', 'scale_ticket', 'fuel_receipt', 'other'];
const DOC_LABEL = { bol: 'BOL', pod: 'POD', lumper_receipt: 'lumper receipt', scale_ticket: 'scale ticket', fuel_receipt: 'fuel receipt', other: 'document' };
const MAX_DOC_MB = 8;
export const MAX_DOCS_PER_DAY = 20;

async function uploadsToday(share, trip) {
  return prisma.document.count({
    where: { source: 'driver_link', createdAt: { gte: new Date(Date.now() - 86400000) }, ...(trip ? { loadId: trip.id } : { carrierId: share.carrierId, loadId: null }) },
  });
}

async function fullInfo(share, bound) {
  const trip = await tripFor(share);
  const used = bound ? await uploadsToday(share, trip) : 0;
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
    uploads: { types: DRIVER_DOC_TYPES, maxMb: MAX_DOC_MB, perDay: MAX_DOCS_PER_DAY, left: Math.max(0, MAX_DOCS_PER_DAY - used) },
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
      await notify(share.ownerId, { type: 'fleet_issue', title: `${share.driverName || share.carrier.companyName}'s location link was locked`, body: `${PIN_MAX_ATTEMPTS} wrong PINs were entered. Create a new link if the driver still needs one.`, link: `/app/fleet?truck=${share.carrierId}` });
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

/** Distance (miles) from the trip's road route, when the trip is in transit and has a current road route. */
function offRouteMiles(trip, fix) {
  if (trip?.status !== 'in_transit' || trip.routeSource !== 'osrm' || !routeIsCurrent(trip)) return null;
  const snap = projectOnRoute(measuredRoute(trip), fix);
  return snap ? snap.offMiles : null;
}

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
  // Road-route distance is plain in-process math on the stored route: no routing call per ping.
  const off = offRouteMiles(trip, p);
  const tripPts = trip && {
    status: trip.status,
    origin: pointFor(trip.originCity, trip.originState, trip.originLat, trip.originLng),
    dest: pointFor(trip.destCity, trip.destState, trip.destLat, trip.destLng),
    offRouteMiles: off,
  };
  const kind = share.deviceKind === 'desktop' || describeDevice(req.get('user-agent')).kind === 'desktop' ? 'desktop' : share.deviceKind;
  const { flags, trusted } = evaluateFix({ fix: p, reference: referenceFor(share, share.carrier, now), trip: tripPts, deviceKind: kind, now });
  const flagTypes = flags.map((f) => f.type);

  // Off the road route: flagged on the fix; two fixes in a row start an episode that alerts the dispatcher once.
  const prev = new Set(String(share.lastPingFlags || '').split(',').filter(Boolean));
  const isOff = trusted && off != null && off > OFF_ROUTE_MILES;
  let alertOffRoute = false;
  const state = [];
  if (isOff) {
    state.push('off_route');
    if (prev.has('off_route')) {
      if (!prev.has('off_route_alerted')) alertOffRoute = true;
      state.push('off_route_alerted');
    }
  }
  const pingFlags = [...flagTypes, ...(isOff ? ['off_route'] : [])];

  const shareData = {
    status: 'sharing', lastLat: p.lat, lastLng: p.lng, lastAccuracy: p.accuracy ?? null, lastSpeed: p.speed ?? null, lastHeading: p.heading ?? null, lastAt: now,
    lastPingFlags: [...flagTypes, ...state].length ? [...flagTypes, ...state].join(',') : null,
    ...(flags.length ? { flags: addFlags(share.flags, flags, now) } : {}),
    // Only plausible fixes become the new reference point.
    ...(trusted ? { trustedLat: p.lat, trustedLng: p.lng, trustedAt: now } : {}),
  };
  const ops = [
    prisma.locationPing.create({ data: { shareId: share.id, lat: p.lat, lng: p.lng, accuracy: p.accuracy ?? null, speed: p.speed ?? null, heading: p.heading ?? null, flags: pingFlags.length ? pingFlags.join(',') : null, at: now } }),
    prisma.locationShare.update({ where: { id: share.id }, data: shareData }),
  ];
  const near = nearestPlace(p.lat, p.lng);
  if (trusted) {
    // An implausible jump never moves the truck on the dispatcher's map; it is kept as an unverified fix instead.
    const truck = { locationLat: p.lat, locationLng: p.lng, locationCity: near?.city ?? null, locationState: near?.state ?? null, locationUpdatedAt: now, locationSource: 'driver_link', isFleet: true };
    // A moving driver with a trip under way is loaded; otherwise leave the status the dispatcher set.
    if (trip?.status === 'in_transit') truck.truckStatus = 'loaded';
    ops.push(prisma.carrier.update({ where: { id: share.carrierId }, data: truck }));
  }
  await prisma.$transaction(ops);

  const who = share.driverName || share.carrier.companyName;
  const serious = flags.filter((f) => ['impossible_jump', 'far_from_trip', 'desktop'].includes(f.type));
  if (serious.length) {
    await alertDispatcher(share, `Check ${who}'s live location`, serious.map((f) => `${flagText(f.type)}${f.detail ? ` (${f.detail})` : ''}`).join('; '), 'gps');
  }
  if (alertOffRoute && trip) {
    const miles = Math.round(off);
    await recordLoadEvent({ loadId: trip.id, ownerId: trip.ownerId, type: 'issue', source: 'system', lat: p.lat, lng: p.lng, note: `Off the planned route by about ${miles} mi`, data: { kind: 'off_route', miles } });
    await notify(share.ownerId, {
      type: 'fleet_issue', title: `${who} is off the planned route`.slice(0, 200),
      body: `About ${miles} mi from the road route${near ? ` near ${near.city}, ${near.state}` : ''} (${trip.originCity} → ${trip.destCity}). Call the driver to check.`,
      link: `/app/fleet?truck=${share.carrierId}`,
    });
  }
  res.json({ ok: true, at: now, nextInSec: MIN_PING_MS / 1000 });
}));

r.post('/:token/stop', ah(async (req, res) => {
  const share = await resolve(req);
  const dev = await deviceState(share, req);
  if (dev === 'unbound' && share.pinHash) throw new HttpError(409, 'Enter the PIN your dispatcher gave you first.', { code: 'PIN_REQUIRED' });
  await prisma.locationShare.update({ where: { id: share.id }, data: { status: 'paused' } });
  await notify(share.ownerId, { type: 'fleet', title: `${share.driverName || share.carrier.companyName} stopped sharing location`, link: `/app/fleet?truck=${share.carrierId}` });
  res.json({ status: 'paused' });
}));

const CHECKINS = {
  arrived_pickup: { label: 'Arrived at pickup', status: null },
  loaded: { label: 'Loaded', status: 'in_transit' },
  arrived_delivery: { label: 'Arrived at delivery', status: null },
  delivered: { label: 'Delivered', status: 'delivered' },
  issue: { label: 'Reported an issue', status: null },
};
const FRESH_FIX_MS = 15 * 60_000;

r.post('/:token/checkin', ah(async (req, res) => {
  const share = await resolve(req);
  const body = parse(z.object({
    event: z.enum(Object.keys(CHECKINS)),
    note: z.string().trim().max(500).optional(),
    signals: signalsSchema,
    lat: z.coerce.number().min(-90).max(90).nullable().optional(),
    lng: z.coerce.number().min(-180).max(180).nullable().optional(),
    accuracy: z.coerce.number().min(0).max(100000).nullable().optional(),
    loadId: z.string().trim().max(40).optional(),
  }), req.body);
  const dev = await deviceState(share, req);
  let deviceSecret = null;
  if (dev === 'unbound' && !isLegacy(share)) {
    if (share.pinHash) throw new HttpError(409, 'Enter the PIN your dispatcher gave you first.', { code: 'PIN_REQUIRED' });
    // Checking in without sharing location also claims the link for this phone.
    deviceSecret = await claimDevice(share, req, body.signals);
  }
  const def = CHECKINS[body.event];
  const now = new Date();
  const trip = await shownTrip(share, await tripFor(share), body.loadId);
  let tripStatus = trip?.status ?? null;
  if (trip && def.status && TRIP_FLOW.includes(trip.status) && TRIP_FLOW.indexOf(def.status) > TRIP_FLOW.indexOf(trip.status)) {
    await prisma.load.update({ where: { id: trip.id }, data: { status: def.status } });
    tripStatus = def.status;
    const data = truckUpdateForTrip(trip.status, def.status, trip);
    if (Object.keys(data).length) await prisma.carrier.update({ where: { id: share.carrierId }, data });
    await recordLoadEvent({
      loadId: trip.id, ownerId: trip.ownerId, type: 'status', source: 'driver_link', at: now,
      note: `Status changed from ${trip.status.replace('_', ' ')} to ${def.status.replace('_', ' ')} (driver check-in)`, data: { from: trip.status, to: def.status },
    });
  }
  // Where the check-in happened: the phone's position sent with it, else a recent trusted fix from this link.
  let at = null;
  if (body.lat != null && body.lng != null && !(body.accuracy > 5000)) at = { lat: body.lat, lng: body.lng };
  else if (share.trustedAt && now - share.trustedAt < FRESH_FIX_MS) at = { lat: share.trustedLat, lng: share.trustedLng };
  // A double tap within two minutes is one check-in (issues always count: each may say something new).
  const repeat = trip && body.event !== 'issue'
    ? await prisma.loadEvent.findFirst({ where: { loadId: trip.id, type: body.event, at: { gte: new Date(now.getTime() - 2 * 60_000) } }, select: { id: true } })
    : null;
  if (trip && !repeat) {
    await recordLoadEvent({
      loadId: trip.id, ownerId: trip.ownerId, type: body.event, source: 'driver_link', at: now, lat: at?.lat ?? null, lng: at?.lng ?? null,
      note: body.note || null, data: { shareId: share.id, ...(body.accuracy != null ? { accuracyM: Math.round(body.accuracy) } : {}) },
    });
  }
  // The repeated tap tells the dispatcher nothing new: no second activity row or notification.
  if (repeat) return res.json({ ok: true, event: body.event, tripStatus, at: now, repeat: true, ...(deviceSecret ? { deviceSecret } : {}) });
  const who = share.driverName || share.carrier.companyName;
  const where = trip ? ` (${trip.originCity} → ${trip.destCity})` : '';
  const summary = `${who}: ${def.label}${where}${body.note ? ` · ${body.note}` : ''}`;
  const member = await prisma.teamMember.findUnique({ where: { userId: share.ownerId }, select: { teamId: true } });
  await prisma.activity.create({
    data: {
      userId: share.ownerId, carrierId: share.carrierId, teamId: member?.teamId ?? null, type: 'checkin', summary: summary.slice(0, 500),
      metadata: JSON.stringify({ event: body.event, loadId: trip?.id ?? null, lat: at?.lat ?? null, lng: at?.lng ?? null }),
    },
  });
  await notify(share.ownerId, { type: body.event === 'issue' ? 'fleet_issue' : 'fleet', title: summary.slice(0, 200), link: `/app/fleet?truck=${share.carrierId}` });
  invalidateToday(share.ownerId);
  res.json({ ok: true, event: body.event, tripStatus, at: now, ...(deviceSecret ? { deviceSecret } : {}) });
}));

// ---------------------------------------------------------------------------
// Hours left (driver's 11/14/70 clocks) for the legal ETA
// ---------------------------------------------------------------------------
const minutes = (max) => z.preprocess((v) => (v === '' || v === undefined ? null : v), z.coerce.number().int().min(0).max(max).nullable().optional());

/** Only the phone that claimed the link (or a pre-locking legacy link) may act on it. */
async function requireOwnPhone(share, req) {
  const dev = await deviceState(share, req);
  if (dev === 'unbound' && !isLegacy(share)) {
    if (share.pinHash) throw new HttpError(409, 'Enter the PIN your dispatcher gave you first.', { code: 'PIN_REQUIRED' });
    throw new HttpError(409, 'Open the link and agree first.', { code: 'CONSENT_REQUIRED' });
  }
}

r.post('/:token/hours', ah(async (req, res) => {
  const share = await resolve(req);
  await requireOwnPhone(share, req);
  const body = parse(z.object({ driveLeftMin: minutes(660), shiftLeftMin: minutes(840), cycleLeftMin: minutes(4200) }), req.body);
  if (!normalizeClocks(body)) throw badRequest('Enter at least one of the hours left.');
  const trip = await tripFor(share);
  if (!trip) throw badRequest('No trip is attached to this link yet.');
  const hos = Object.fromEntries(Object.entries(body).filter(([, v]) => v != null));
  const text = [hos.driveLeftMin != null && `drive ${hoursText(hos.driveLeftMin)}`, hos.shiftLeftMin != null && `shift ${hoursText(hos.shiftLeftMin)}`, hos.cycleLeftMin != null && `cycle ${hoursText(hos.cycleLeftMin)}`].filter(Boolean).join(' · ');
  await recordLoadEvent({ loadId: trip.id, ownerId: trip.ownerId, type: 'note', source: 'driver_link', note: `Driver hours left: ${text}`, data: { hos, shareId: share.id } });
  invalidateToday(share.ownerId);
  res.status(201).json({ ok: true, hos });
}));

// ---------------------------------------------------------------------------
// BOL, POD and receipts from the driver's phone
// ---------------------------------------------------------------------------

/**
 * Before the file is read: the link must be valid and claimed by this phone, under the daily cap, and the account must
 * have storage left (the upload counts toward the dispatcher's storage quota).
 */
const beforeUpload = ah(async (req, res, next) => {
  const share = await resolve(req);
  await requireOwnPhone(share, req);
  const trip = await tripFor(share);
  if ((await uploadsToday(share, trip)) >= MAX_DOCS_PER_DAY) {
    throw new HttpError(429, `This link can send ${MAX_DOCS_PER_DAY} files a day. Ask your dispatcher if you need to send more.`, { code: 'UPLOAD_CAP' });
  }
  const owner = await prisma.user.findUnique({ where: { id: share.ownerId }, include: { teamMembership: true } });
  if (!owner) throw gone('stopped');
  req.trackShare = share;
  req.trackTrip = trip;
  req.trackOwner = owner;
  next();
});
const driverUpload = uploader('driver', 'documents', MAX_DOC_MB, { quotaUser: (req) => req.trackOwner });

const cleanName = (s) => String(s || '').replace(/[^\w .()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

r.post('/:token/documents', beforeUpload, driverUpload.single('file'), ah(async (req, res) => {
  const share = req.trackShare;
  let trip = req.trackTrip;
  try {
    if (!req.file) throw badRequest('Choose a photo or PDF to send.');
    const body = parse(z.object({
      type: z.enum(DRIVER_DOC_TYPES).default('other'),
      pages: z.coerce.number().int().min(1).max(30).default(1),
      loadId: z.string().trim().max(40).optional(),
    }), req.body || {});
    verifyFileSignature(req.file);
    trip = await shownTrip(share, trip, body.loadId);
    if (trip?.id !== req.trackTrip?.id && (await uploadsToday(share, trip)) >= MAX_DOCS_PER_DAY) {
      throw new HttpError(429, `This link can send ${MAX_DOCS_PER_DAY} files a day. Ask your dispatcher if you need to send more.`, { code: 'UPLOAD_CAP' });
    }
    const ext = path.extname(req.file.originalname).toLowerCase();
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
    const name = `${cleanName(`${DOC_LABEL[body.type].replace(/^\w/, (c) => c.toUpperCase())} ${trip?.referenceNumber ? `${trip.referenceNumber} ` : ''}${stamp}`)}${ext}`;
    const doc = await prisma.document.create({
      data: {
        ownerId: share.ownerId, uploadedById: share.ownerId, carrierId: trip ? null : share.carrierId, loadId: trip?.id ?? null,
        type: body.type, originalName: name, storedName: req.file.filename, mimeType: req.file.mimetype === 'application/octet-stream' ? (ext === '.pdf' ? 'application/pdf' : `image/${ext === '.jpg' ? 'jpeg' : ext.slice(1)}`) : req.file.mimetype,
        sizeBytes: req.file.size, source: 'driver_link',
      },
    });
    const who = share.driverName || share.carrier.companyName;
    const what = `${DOC_LABEL[body.type]}${body.pages > 1 ? ` (${body.pages} pages)` : ''}`;
    if (trip) {
      await recordLoadEvent({
        loadId: trip.id, ownerId: trip.ownerId, type: 'document', source: 'driver_link', note: `Driver sent a ${what}`,
        data: { documentId: doc.id, type: body.type, pages: body.pages, shareId: share.id },
      });
    }
    await notify(share.ownerId, {
      type: 'fleet', title: `${who} sent a ${what}`.slice(0, 200),
      body: trip ? `${trip.originCity}, ${trip.originState} → ${trip.destCity}, ${trip.destState}${trip.referenceNumber ? ` · ref ${trip.referenceNumber}` : ''}` : null,
      link: `/app/fleet?truck=${share.carrierId}`,
    });
    invalidateToday(share.ownerId);
    const left = Math.max(0, MAX_DOCS_PER_DAY - (await uploadsToday(share, trip)));
    res.status(201).json({ document: { id: doc.id, type: doc.type, originalName: doc.originalName, sizeBytes: doc.sizeBytes, createdAt: doc.createdAt }, uploadsLeft: left });
  } catch (err) {
    if (req.file?.path) fs.rmSync(req.file.path, { force: true });
    throw err;
  }
}));

export default r;
