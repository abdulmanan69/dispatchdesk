import { prisma } from '../../db.js';
import { routeIsCurrent } from './index.js';
import { measuredRoute, paceFromPings, planTruck, hosFromEvent, dwellFromEvents } from './progress.js';
import { scheduleLoadRoute } from './route.js';

/**
 * Database-backed inputs for trip plans (ETAs, risk, hours of service), check-call status and detention.
 * Every query here is bounded and uses an index: LoadEvent(loadId, at), LocationPing(shareId, at),
 * LocationShare(carrierId, status) and SystemSetting's primary key.
 */
const MIN = 60_000;
export const ACTIVE = ['planned', 'booked', 'in_transit'];

// ---------------------------------------------------------------------------
// Hours-of-service reports
// ---------------------------------------------------------------------------

/** Latest hours-of-service report per load: { [loadId]: { clocks, at, source } }. */
export async function latestHos(loadIds) {
  const ids = [...new Set(loadIds)].filter(Boolean);
  if (!ids.length) return {};
  const rows = await prisma.loadEvent.findMany({
    where: { loadId: { in: ids }, data: { contains: '"hos"' } },
    orderBy: { at: 'desc' }, take: Math.min(1000, ids.length * 25), select: { loadId: true, at: true, data: true, source: true },
  });
  const out = {};
  for (const r of rows) {
    if (out[r.loadId]) continue;
    const h = hosFromEvent(r);
    if (h) out[r.loadId] = h;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recent pace per live link (pings from the last 90 minutes, cached briefly per process)
// ---------------------------------------------------------------------------
const PACE_TTL = 90_000;
const PACE_MAX = 2000;
// Newest pings read per link: at most one every 10 s is stored, so 360 cover at least the last hour (pace needs 15 min).
const PINGS_PER_SHARE = 360;
const PACE_QUERY_CONCURRENCY = 8;
const paceCache = new Map();
export function clearPaceCache() { paceCache.clear(); }

export async function pacesFor(shareIds, now = Date.now()) {
  const out = {};
  const need = [];
  for (const id of new Set(shareIds.filter(Boolean))) {
    const hit = paceCache.get(id);
    if (hit && hit.exp > now) out[id] = hit.value;
    else need.push(id);
  }
  if (!need.length) return out;
  // Bounded per link, newest first (LocationPing(shareId, at) index), then put back in time order: a global row cap
  // over many trucks would cut the newest minutes of every truck and give stale pace and ETAs.
  const since = new Date(now - 95 * MIN);
  const by = new Map();
  for (let i = 0; i < need.length; i += PACE_QUERY_CONCURRENCY) {
    const part = need.slice(i, i + PACE_QUERY_CONCURRENCY);
    const lists = await Promise.all(part.map((id) => prisma.locationPing.findMany({
      where: { shareId: id, at: { gte: since } },
      orderBy: { at: 'desc' }, take: PINGS_PER_SHARE, select: { shareId: true, lat: true, lng: true, speed: true, at: true, flags: true },
    })));
    part.forEach((id, k) => by.set(id, lists[k].reverse()));
  }
  for (const [id, pings] of by) {
    const value = paceFromPings(pings, { now });
    if (paceCache.size >= PACE_MAX) paceCache.delete(paceCache.keys().next().value);
    paceCache.set(id, { value, exp: now + PACE_TTL });
    out[id] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plans for trucks
// ---------------------------------------------------------------------------
const tripOrder = (a, b) => (a.status === 'in_transit' ? -1 : 0) - (b.status === 'in_transit' ? -1 : 0)
  || (a.pickupDate ? new Date(a.pickupDate).getTime() : Infinity) - (b.pickupDate ? new Date(b.pickupDate).getTime() : Infinity)
  || new Date(a.createdAt) - new Date(b.createdAt);

/** Events of these loads that matter for plans and detention (check-ins and explicit detention marks). */
export async function stopEvents(loadIds) {
  const ids = [...new Set(loadIds)].filter(Boolean);
  if (!ids.length) return {};
  const rows = await prisma.loadEvent.findMany({
    where: { loadId: { in: ids }, type: { in: ['arrived_pickup', 'loaded', 'departed_pickup', 'arrived_delivery', 'delivered', 'detention_start', 'detention_stop'] } },
    orderBy: { at: 'asc' }, take: 3000, select: { loadId: true, type: true, at: true, lat: true, lng: true, source: true },
  });
  const out = {};
  for (const r of rows) (out[r.loadId] ||= []).push(r);
  return out;
}

/**
 * Plans for carrier rows that include `loads` (active, with route fields) and `locationShares` (latest first).
 * Returns { [carrierId]: plan } (see progress.planTruck). Only trucks with an active trip get a plan.
 */
export async function plansFor(carriers, { now = Date.now(), withEvents = true } = {}) {
  const withTrips = carriers.filter((c) => (c.loads || []).some((l) => ACTIVE.includes(l.status)));
  if (!withTrips.length) return {};
  const loadIds = withTrips.flatMap((c) => c.loads.filter((l) => ACTIVE.includes(l.status)).map((l) => l.id));
  const liveShares = withTrips.map((c) => (c.locationShares || [])[0]).filter((s) => s && s.status === 'sharing');
  const [hos, paces, events] = await Promise.all([
    latestHos(loadIds),
    pacesFor(liveShares.map((s) => s.id), now),
    withEvents ? stopEvents(loadIds) : Promise.resolve({}),
  ]);
  const out = {};
  for (const c of withTrips) {
    const trips = c.loads.filter((l) => ACTIVE.includes(l.status)).sort(tripOrder);
    const routes = {};
    for (const l of trips) {
      if (routeIsCurrent(l)) routes[l.id] = measuredRoute(l);
      // Pickup or delivery moved on another page: the stored road route is stale, so work it out again (bounded queue).
      else if (l.routeGeometry) scheduleLoadRoute(l);
    }
    // Hours belong to the driver: the newest report on any of the truck's loads counts.
    const report = trips.map((l) => hos[l.id]).filter(Boolean).sort((a, b) => b.at - a.at)[0] || null;
    const share = (c.locationShares || [])[0];
    const position = c.locationLat != null && c.locationLng != null ? { lat: c.locationLat, lng: c.locationLng, at: c.locationUpdatedAt } : null;
    out[c.id] = planTruck({ trips, position, routes, hos: report, pace: share && paces[share.id] ? paces[share.id] : null, now, events });
  }
  return out;
}

/** Compact plan summary for list views (the fleet map payload and the Today board). */
export function planSummary(plan) {
  if (!plan) return null;
  const current = plan.trips.find((t) => t.status === 'in_transit') || null;
  const next = plan.stops.find((s) => s.eta || s.legalEta) || plan.stops[0] || null;
  return {
    tripId: current?.id ?? next?.loadId ?? null,
    progress: current?.progress ? { ...current.progress, snapped: undefined } : null,
    nextStop: next ? { kind: next.kind, loadId: next.loadId, city: next.city, state: next.state, window: next.window, eta: next.eta, legalEta: next.legalEta, risk: next.risk } : null,
    risk: plan.risk,
    hosAssumed: plan.hos.assumed,
    paceMph: plan.pace?.mph ?? null,
  };
}

// ---------------------------------------------------------------------------
// Check calls
// ---------------------------------------------------------------------------
export const CHECKCALL_DEFAULT_HOURS = 4;
export const CHECKCALL_HOURS = [1, 2, 3, 4, 6, 8, 12];
const settingKey = (userId) => `user.${userId}.checkcalls`;

/** { [userId]: { hours, enabled } } from SystemSetting (defaults: every 4 hours, on). */
export async function checkCallSettings(userIds) {
  const ids = [...new Set(userIds)].filter(Boolean);
  const out = Object.fromEntries(ids.map((id) => [id, { hours: CHECKCALL_DEFAULT_HOURS, enabled: true }]));
  if (!ids.length) return out;
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: ids.map(settingKey) } }, select: { key: true, value: true } });
  for (const r of rows) {
    const id = r.key.slice(5, -'.checkcalls'.length);
    try {
      const v = JSON.parse(r.value);
      out[id] = { hours: CHECKCALL_HOURS.includes(Number(v.hours)) ? Number(v.hours) : CHECKCALL_DEFAULT_HOURS, enabled: v.enabled !== false };
    } catch { /* keep the default */ }
  }
  return out;
}

export async function saveCheckCallSettings(userId, { hours, enabled }) {
  // The default needs no row (keeps the settings table small).
  if (hours === CHECKCALL_DEFAULT_HOURS && enabled) {
    await prisma.systemSetting.deleteMany({ where: { key: settingKey(userId) } });
    return { hours, enabled };
  }
  const value = JSON.stringify({ hours, enabled });
  await prisma.systemSetting.upsert({
    where: { key: settingKey(userId) },
    create: { key: settingKey(userId), value, secret: false, updatedById: userId },
    update: { value, updatedById: userId },
  });
  return { hours, enabled };
}

/**
 * Last time anyone heard from each load's truck: a dispatcher check call, a driver check-in or document, a GPS fix on the
 * truck's live link, a dispatcher status change or stop time, or hours left reported for the driver. System events
 * (alerts) and the dispatcher's own notes (tracking link made for the broker, detention, TONU) do not count.
 * loads: [{ id, carrierId, lastCheckCallAt, updatedAt }] -> { [loadId]: { at: Date|null, via } }
 */
export async function lastContacts(loads) {
  if (!loads.length) return {};
  const ids = loads.map((l) => l.id);
  const carrierIds = [...new Set(loads.map((l) => l.carrierId).filter(Boolean))];
  const [evs, shares] = await Promise.all([
    prisma.loadEvent.groupBy({
      by: ['loadId'],
      where: { loadId: { in: ids }, source: { not: 'system' }, OR: [{ type: { not: 'note' } }, { data: { contains: '"hos"' } }] },
      _max: { at: true },
    }),
    carrierIds.length
      ? prisma.locationShare.findMany({ where: { carrierId: { in: carrierIds }, status: { in: ['sharing', 'paused'] } }, select: { carrierId: true, lastAt: true } })
      : Promise.resolve([]),
  ]);
  const evAt = Object.fromEntries(evs.map((e) => [e.loadId, e._max.at]));
  const pingAt = {};
  for (const s of shares) if (s.lastAt && (!pingAt[s.carrierId] || s.lastAt > pingAt[s.carrierId])) pingAt[s.carrierId] = s.lastAt;
  const out = {};
  for (const l of loads) {
    const cands = [
      [l.lastCheckCallAt, 'check_call'],
      [evAt[l.id], 'event'],
      [l.carrierId ? pingAt[l.carrierId] : null, 'gps'],
    ].filter(([d]) => d);
    cands.sort((a, b) => new Date(b[0]) - new Date(a[0]));
    out[l.id] = cands.length ? { at: new Date(cands[0][0]), via: cands[0][1] } : { at: l.updatedAt ? new Date(l.updatedAt) : null, via: 'none' };
  }
  return out;
}

/** In-transit loads whose last contact is older than the owner's check-call interval. */
export function checkCallDue(load, contact, settings, now = Date.now()) {
  const s = settings || { hours: CHECKCALL_DEFAULT_HOURS, enabled: true };
  if (!s.enabled || load.status !== 'in_transit') return null;
  const last = contact?.at ? new Date(contact.at).getTime() : null;
  if (last && now - last < s.hours * 3600_000) return null;
  return { lastContactAt: contact?.at ?? null, via: contact?.via ?? 'none', hours: s.hours, overdueMin: last ? Math.round((now - last) / MIN - s.hours * 60) : null };
}

/** Running detention (or time at the dock) per load from check-ins: { [loadId]: dwell[] } with only open stops. */
export function openDwell(eventsByLoad, loadsById, now = Date.now()) {
  const out = {};
  for (const [id, evs] of Object.entries(eventsByLoad)) {
    const load = loadsById[id];
    if (!load) continue;
    const list = dwellFromEvents(evs, { freeTimeHours: load.freeTimeHours ?? 2, now }).filter((d) => !d.leftAt);
    if (list.length) out[id] = list;
  }
  return out;
}
