import crypto from 'node:crypto';
import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { broadcast, onBroadcast } from '../../lib/broadcast.js';
import { nearestPlace } from './index.js';
import { plansFor, ACTIVE } from './insights.js';
import { stopWindow } from './progress.js';
import { userCanReadCarrier } from '../../lib/access.js';

/**
 * Read-only tracking links for the broker or shipper of one load (LoadShare). The token is returned once; only its
 * sha256 is stored. Whether the page may show exact GPS is part of the token itself (first character "e" = exact,
 * "c" = city level), so it cannot be changed without invalidating the link: create a new link to change it.
 * The public page never shows driver identity, phone numbers, rates or any CRM data.
 */
export const LINK_DAYS = [1, 3, 7, 14];
const MAX_DAYS = 14;
const AFTER_DELIVERY_MS = 24 * 3600_000;
const DONE = ['delivered', 'invoiced', 'paid'];

export const loadTrackUrl = (token) => `${config.appUrl}/t/${token}`;
export const newLoadShareToken = (exact) => `${exact ? 'e' : 'c'}${randomToken(24)}`;
export const exactFromToken = (token) => String(token || '').startsWith('e');
const TOKEN_RE = /^[ce][A-Za-z0-9_-]{20,64}$/;

/** Default lifetime: until 24 hours after the delivery appointment (or now), at most 14 days. */
export function defaultExpiry(load, now = new Date()) {
  const end = stopWindow(load, 'delivery')?.end;
  const base = end && end > now ? end.getTime() : now.getTime();
  return new Date(Math.min(base + AFTER_DELIVERY_MS, now.getTime() + MAX_DAYS * 86400_000));
}

export function loadShareView(s, { exact = null } = {}) {
  const now = Date.now();
  const status = s.revokedAt ? 'revoked' : new Date(s.expiresAt).getTime() <= now ? 'expired' : 'active';
  return {
    id: s.id, loadId: s.loadId, label: s.label, status, exact,
    expiresAt: s.expiresAt, revokedAt: s.revokedAt, views: s.views, lastViewedAt: s.lastViewedAt, createdAt: s.createdAt,
  };
}

/** When the load was delivered (driver check-in or a status change), or null. */
export async function deliveredAt(load) {
  if (!DONE.includes(load.status)) return null;
  const ev = await prisma.loadEvent.findFirst({
    where: { loadId: load.id, OR: [{ type: 'delivered' }, { type: 'status', data: { contains: '"to":"delivered"' } }] },
    orderBy: { at: 'desc' }, select: { at: true },
  });
  return ev?.at || load.updatedAt || null;
}

// The link owner, with what lib/access.js needs to decide whether they may still see the truck.
const OWNER_SELECT = { id: true, status: true, teamMembership: { include: { team: true } } };

/**
 * Resolve a public token: { share, load } or { gone: 'invalid' | 'revoked' | 'expired' }. `share.owner` is loaded;
 * links of a suspended or deleted account stop working.
 */
export async function findLoadShare(token, now = new Date()) {
  if (!TOKEN_RE.test(String(token || ''))) return { gone: 'invalid' };
  const share = await prisma.loadShare.findUnique({ where: { tokenHash: sha256(token) }, include: { load: true, owner: { select: OWNER_SELECT } } });
  if (!share || !share.load) return { gone: 'invalid' };
  if (share.revokedAt || share.owner?.status !== 'active') return { gone: 'revoked' };
  if (share.expiresAt <= now) return { gone: 'expired' };
  const done = await deliveredAt(share.load);
  if (done && now.getTime() - new Date(done).getTime() > AFTER_DELIVERY_MS) return { gone: 'expired' };
  return { share, load: share.load };
}

const STATUS_LABEL = {
  planned: 'Scheduled', booked: 'Truck assigned', in_transit: 'In transit', delivered: 'Delivered', invoiced: 'Delivered', paid: 'Delivered', canceled: 'Canceled',
};
const EVENT_LABEL = {
  arrived_pickup: 'Arrived at pickup', loaded: 'Loaded', departed_pickup: 'Left pickup', arrived_delivery: 'Arrived at delivery', delivered: 'Delivered', check_call: 'Status checked with the driver',
};
// Positions older than this are not shown as "where the truck is".
const POSITION_MAX_AGE_MS = 12 * 3600_000;

/*
 * City-level links must not let the exact position be worked back: a distance from a known city to the mile, or miles
 * to go and an ETA to the minute along a known highway, pin the truck to about a mile. So distances are rounded to
 * 10 miles, progress to 5 %, and times to 15 minutes. Exact links show the position itself.
 */
const QUARTER_HOUR = 15 * 60_000;
const coarseTime = (d) => (d ? new Date(Math.round(new Date(d).getTime() / QUARTER_HOUR) * QUARTER_HOUR) : null);

function placeText(lat, lng, exact) {
  const near = nearestPlace(lat, lng, 250);
  if (!near) return null;
  if (near.miles <= 15) return `Near ${near.city}, ${near.state}`;
  return `About ${exact ? near.miles : Math.round(near.miles / 10) * 10} mi from ${near.city}, ${near.state}`;
}

// dateOnly: no appointment time was entered, only the day (the page shows the day without a time).
const windowOut = (w) => (w ? { start: w.start, end: w.end, tz: w.tz, ...(w.dateOnly ? { dateOnly: true } : {}) } : null);

/**
 * Which of the truck's active loads it is working on now: the in-transit one, else the first booked one (`loads` is
 * ordered by pickup). A booked load waiting behind another trip is not current: the truck carries someone else's freight.
 */
export function isCurrentTrip(load, loads) {
  if (load.status === 'in_transit') return true;
  if (load.status !== 'booked') return false;
  const current = loads.find((l) => l.status === 'in_transit') || loads.find((l) => l.status === 'booked');
  return !current || current.id === load.id;
}

/**
 * Everything the public page shows for one load. Bounded queries only.
 * `owner` is the link owner (findLoadShare loads it). The truck's position, progress and ETAs are shown only while that
 * owner may still read the carrier (a teammate who left the team keeps the load but not the truck), and the position
 * only while this load is the truck's current trip.
 */
export async function loadShareSnapshot(load, { exact = false, now = Date.now(), owner = null } = {}) {
  const [carrierRow, events, pod] = await Promise.all([
    load.carrierId ? prisma.carrier.findUnique({
      where: { id: load.carrierId },
      select: {
        id: true, ownerId: true, assignedToId: true, locationLat: true, locationLng: true, locationUpdatedAt: true, locationSource: true,
        loads: { where: { status: { in: ACTIVE } }, orderBy: [{ pickupDate: 'asc' }, { createdAt: 'asc' }], take: 10 },
        locationShares: { where: { status: { in: ['pending', 'sharing', 'paused'] } }, orderBy: { updatedAt: 'desc' }, take: 1, select: { id: true, status: true, lastAt: true } },
      },
    }) : null,
    prisma.loadEvent.findMany({
      where: { loadId: load.id, type: { in: Object.keys(EVENT_LABEL) } }, orderBy: { at: 'asc' }, take: 60,
      select: { type: true, at: true, lat: true, lng: true },
    }),
    prisma.document.findFirst({ where: { loadId: load.id, type: 'pod' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ]);

  const carrier = carrierRow && (await userCanReadCarrier(owner, carrierRow)) ? carrierRow : null;
  const active = ACTIVE.includes(load.status);
  // Decided before the load is added to the truck's trips below.
  const current = !!carrier && isCurrentTrip(load, carrier.loads);
  let stops = [];
  let progress = null;
  if (carrier && active) {
    // The load itself may not be in the truck's first three trips; make sure it is planned.
    if (!carrier.loads.some((l) => l.id === load.id)) carrier.loads.push(load);
    const plan = (await plansFor([carrier], { now }))[carrier.id];
    stops = plan?.stops.filter((s) => s.loadId === load.id) || [];
    progress = plan?.trips.find((t) => t.id === load.id)?.progress || null;
  }
  const stopFor = (kind) => stops.find((s) => s.kind === kind) || null;

  let location = null;
  const posAt = carrier?.locationUpdatedAt ? new Date(carrier.locationUpdatedAt).getTime() : null;
  if (carrier && active && current && carrier.locationLat != null && posAt && now - posAt < POSITION_MAX_AGE_MS) {
    location = {
      text: placeText(carrier.locationLat, carrier.locationLng, exact),
      at: carrier.locationUpdatedAt,
      source: carrier.locationSource === 'driver_link' ? 'gps' : 'dispatcher',
      ...(exact ? { lat: Math.round(carrier.locationLat * 1000) / 1000, lng: Math.round(carrier.locationLng * 1000) / 1000 } : {}),
    };
  }
  const updates = [load.lastCheckCallAt, events.at(-1)?.at, location?.at].filter(Boolean).map((d) => new Date(d).getTime());
  const happened = (type) => events.filter((e) => e.type === type).at(-1)?.at || null;
  const pickup = stopFor('pickup');
  const delivery = stopFor('delivery');
  const eta = (d) => (exact ? d ?? null : coarseTime(d));
  return {
    reference: load.referenceNumber || null,
    status: load.status,
    statusLabel: STATUS_LABEL[load.status] || load.status,
    pickup: {
      city: load.originCity, state: load.originState, window: windowOut(stopWindow(load, 'pickup')),
      arrivedAt: happened('arrived_pickup'), departedAt: happened('loaded') || happened('departed_pickup'),
      eta: eta(pickup?.eta), risk: pickup?.risk ?? null,
    },
    delivery: {
      city: load.destCity, state: load.destState, window: windowOut(stopWindow(load, 'delivery')),
      arrivedAt: happened('arrived_delivery'), deliveredAt: happened('delivered') || (DONE.includes(load.status) ? await deliveredAt(load) : null),
      eta: eta(delivery?.eta), legalEta: eta(delivery?.legalEta), risk: delivery?.risk ?? null,
    },
    progress: progress && progress.pct != null ? {
      pct: exact ? progress.pct : Math.round(progress.pct / 5) * 5,
      remainingMiles: exact ? progress.remainingMiles : Math.round(progress.remainingMiles / 10) * 10,
      totalMiles: progress.totalMiles,
    } : null,
    location,
    lastUpdateAt: updates.length ? new Date(Math.max(...updates)) : null,
    pod: { received: !!pod, at: pod?.createdAt ?? null },
    timeline: events.map((e) => ({ type: e.type, label: EVENT_LABEL[e.type], at: e.at, place: e.lat != null ? placeText(e.lat, e.lng, exact) : null })),
    exact,
    generatedAt: new Date(now),
  };
}

export const snapshotEtag = (body) => `W/"lt-${crypto.createHash('sha1').update(JSON.stringify({ ...body, generatedAt: undefined })).digest('base64url').slice(0, 22)}"`;

// ---------------------------------------------------------------------------
// Public page cache: one snapshot per link for 60 s in each process (bounded), dropped everywhere on revoke.
// ---------------------------------------------------------------------------
const SNAP_TTL = 60_000;
const SNAP_MAX = 2000;
const snaps = new Map();
onBroadcast('loadtrack', (tokenHash) => { if (tokenHash) snaps.delete(tokenHash); else snaps.clear(); });
export function invalidateLoadTrack(tokenHash) { broadcast('loadtrack', tokenHash || null); }

/**
 * Public view for a token: { body, etag, shareId } or { gone }. Views are counted at most once a minute per link and
 * process, so a page left open (it refreshes every minute) does not inflate the count.
 */
export async function publicLoadTrack(token, now = Date.now()) {
  const key = sha256(token);
  let hit = snaps.get(key);
  if (!hit || hit.exp <= now) {
    const { share, load, gone } = await findLoadShare(token, new Date(now));
    if (gone) { snaps.delete(key); return { gone }; }
    const body = { ...(await loadShareSnapshot(load, { exact: exactFromToken(token), now, owner: share.owner })), expiresAt: share.expiresAt };
    hit = { exp: now + SNAP_TTL, body, etag: snapshotEtag(body), shareId: share.id, countedAt: hit?.countedAt || 0 };
    snaps.delete(key);
    if (snaps.size >= SNAP_MAX) snaps.delete(snaps.keys().next().value);
    snaps.set(key, hit);
  }
  if (now - hit.countedAt > 60_000) {
    hit.countedAt = now;
    await prisma.loadShare.updateMany({
      where: { id: hit.shareId, OR: [{ lastViewedAt: null }, { lastViewedAt: { lt: new Date(now - 60_000) } }] },
      data: { views: { increment: 1 }, lastViewedAt: new Date(now) },
    });
  }
  return hit;
}
