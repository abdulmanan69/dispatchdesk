import { prisma } from '../../db.js';
import { readableOwnerIds } from '../../lib/access.js';
import { DEFAULT_TZ, zonedTimeToUtc } from '../../lib/timezones.js';
import { badRequest } from '../../lib/errors.js';
import { facilityTimezone } from '../loads/facilityTz.js';
import { routeEncoded, estimateRoute, geocode } from '../market/live.js';
import { ROAD_FACTOR } from '../market/geo.js';
import { ACTIVE_TRIP_STATUSES, pointFor, crowMiles } from './index.js';
import { latestHos } from './insights.js';
import { currentClocks } from './progress.js';
import { planTrip, clocksFromHours, hoursText, LIMITS } from './hos.js';

/**
 * Legal ETA for a trip that is not booked yet: "can this driver legally make the delivery appointment?".
 * One road-route lookup per request through the shared OSRM helper (cached, throttled, straight-line estimate when the
 * router is down or busy); the hours-of-service math is the pure planTrip() in ./hos.js. Nothing is stored and no
 * per-process state is kept here.
 */
const MIN = 60_000;
/** Average truck speed for legs without a road route (the same 50 mph the rest of the fleet code uses). */
const ESTIMATE_MPH = 50;
const LOCAL_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

/** Instant for an ISO value, or for a facility-local wall time ("2026-11-12T08:00") in `zone`. */
export function toInstant(value, zone) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' && LOCAL_DT.test(value)) {
    const [d, t] = value.split('T');
    const [y, m, day] = d.split('-').map(Number);
    const [hh, mm] = t.split(':').map(Number);
    const out = zonedTimeToUtc(zone || DEFAULT_TZ, y, m, day, hh, mm, 0);
    if (Number.isNaN(out.getTime())) throw badRequest('Invalid appointment time');
    return out;
  }
  const out = new Date(value);
  if (Number.isNaN(out.getTime())) throw badRequest('Invalid appointment time');
  return out;
}

/** { start, end } in ms from two values (a single time is a window of one instant); null when both are empty. */
export function windowOf(start, end, zone) {
  const s = toInstant(start, zone);
  const e = toInstant(end, zone);
  if (!s && !e) return null;
  const a = (s || e).getTime();
  const b = (e || s).getTime();
  if (b < a) throw badRequest('An appointment window ends before it starts');
  return { start: a, end: b };
}

/** Where a stop is: exact coordinates, a known city, the geocoder (cached), else the state's center. */
async function placeFor(p) {
  const exact = pointFor(p.city, p.state, p.lat ?? null, p.lng ?? null);
  if (exact && exact.precision !== 'state') return exact;
  if (p.city) {
    try {
      const g = await geocode(`${p.city}, ${p.state}`);
      const hit = (g?.items || []).find((x) => x.state === p.state && x.precision !== 'state' && Number.isFinite(x.lat));
      if (hit) return { lat: hit.lat, lng: hit.lng, precision: 'city' };
    } catch { /* fall back to the state center */ }
  }
  return exact;
}

const label = (p) => [p.city, p.state].filter(Boolean).join(', ');

/** Road miles and minutes (one routing call at most). A stop known only by its state is never routed. */
async function roadLeg(from, to) {
  if (from.precision === 'state' || to.precision === 'state') {
    const est = estimateRoute(from, to);
    return { miles: est.miles, minutes: est.minutes, routeSource: 'estimate', stateOnly: true };
  }
  let r;
  try {
    r = await routeEncoded(from, to);
  } catch {
    r = estimateRoute(from, to);
  }
  return { miles: r.miles, minutes: r.minutes, routeSource: r.estimate ? 'estimate' : 'osrm', stateOnly: false };
}

/** Latest hours-of-service report for the load, or for the carrier's active trips the user may read. */
async function reportedHos(user, { loadId, carrierId }) {
  const ids = [];
  if (loadId) ids.push(loadId);
  if (carrierId) {
    const owners = await readableOwnerIds(user, 'team');
    const rows = await prisma.load.findMany({
      where: { carrierId, status: { in: ACTIVE_TRIP_STATUSES }, OR: [{ ownerId: { in: owners } }, { carrier: { assignedToId: user.id } }] },
      select: { id: true }, orderBy: { updatedAt: 'desc' }, take: 10,
    });
    ids.push(...rows.map((x) => x.id));
  }
  if (!ids.length) return null;
  const by = await latestHos(ids);
  return Object.values(by).sort((a, b) => b.at - a.at)[0] || null;
}

// Facility-local clock text ("Thu 3:40 PM CST"); one formatter per zone, bounded.
const FORMATTERS = new Map();
function at(ms, tz) {
  const zone = tz || DEFAULT_TZ;
  let f = FORMATTERS.get(zone);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); } catch { return new Date(ms).toISOString(); }
    if (FORMATTERS.size >= 50) FORMATTERS.clear();
    FORMATTERS.set(zone, f);
  }
  return f.format(new Date(ms));
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "1 30-minute break and 1 10-hour reset" (empty when the trip needs no stop). */
export function stopsText({ breaks = 0, resets = 0, restarts = 0 }) {
  const parts = [breaks && plural(breaks, '30-minute break'), resets && plural(resets, '10-hour reset'), restarts && plural(restarts, '34-hour restart')].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || '';
}

/** One plain sentence for the verdict. */
export function explain(plan) {
  const stops = stopsText(plan);
  const onTheWay = stops ? `, with ${stops} on the way` : ' without a required stop';
  if (plan.pickup?.verdict === 'late') {
    return 'The truck cannot legally reach the pickup before its appointment ends, so the delivery estimate starts from a late pickup.';
  }
  switch (plan.verdict) {
    case 'late':
      return `Driving legally, the driver arrives ${hoursText(-plan.slackMin)} after the delivery appointment ends${onTheWay}.`;
    case 'at_risk':
      return `The driver can legally arrive only ${hoursText(plan.slackMin)} before the delivery appointment ends${onTheWay}, so any delay makes it late.`;
    case 'on_time':
      return `The driver can legally arrive ${hoursText(plan.slackMin)} before the delivery appointment ends${onTheWay}.`;
    default:
      return stops
        ? `Hours-of-service rules add ${hoursText(plan.extraMin)} to the drive time (${stops}); add a delivery appointment to check it.`
        : 'The trip fits in one shift without a required stop; add a delivery appointment to check it.';
  }
}

/**
 * Compute the plan. `input` is the validated request body with access already checked (`load` is the owned load row,
 * or null). Returns the API response.
 */
export async function planEta(user, input, { load = null, now = Date.now() } = {}) {
  const pickupTz = input.pickupTz || load?.pickupTz || facilityTimezone(input.origin.city, input.origin.state) || DEFAULT_TZ;
  const deliveryTz = input.deliveryTz || load?.deliveryTz || facilityTimezone(input.dest.city, input.dest.state) || DEFAULT_TZ;
  // A field left out falls back to the saved load; an explicit null clears it.
  const pick = (k) => (input[k] !== undefined ? input[k] : load?.[k] ?? null);
  const pickupWindow = windowOf(pick('pickupWindowStart'), pick('pickupWindowEnd'), pickupTz);
  const deliveryWindow = windowOf(pick('deliveryWindowStart'), pick('deliveryWindowEnd'), deliveryTz);

  const [from, to] = await Promise.all([placeFor(input.origin), placeFor(input.dest)]);
  if (!from || !to) throw badRequest('Give a city and state for the pickup and the delivery');
  const leg = await roadLeg(from, to);

  let deadhead = null;
  if (input.deadhead?.from) {
    const miles = crowMiles(input.deadhead.from, from) * ROAD_FACTOR;
    deadhead = { miles: Math.round(miles), minutes: miles > 1 ? Math.round((miles / ESTIMATE_MPH) * 60) : 0 };
  }

  // Hours left: typed for this check, else the latest report on the load or the carrier's active trips (run forward to
  // now, as the live truck panel does), else a rested driver.
  let clocks = clocksFromHours(input.hoursLeft);
  let hours = clocks ? { source: 'entered', reportedAt: null } : null;
  if (!clocks && (load || input.carrierId)) {
    const report = await reportedHos(user, { loadId: load?.id, carrierId: input.carrierId || load?.carrierId || null });
    if (report) {
      const cur = currentClocks(report, now, null);
      if (!cur.assumed) {
        clocks = cur.clocks;
        hours = { source: 'report', reportedAt: report.at, by: report.source === 'driver_link' ? 'driver' : 'dispatcher' };
      } else hours = { source: 'assumed', stale: true, reportedAt: report.at };
    }
  }
  if (!hours) hours = { source: 'assumed', reportedAt: null };

  const startInput = toInstant(input.startAt, pickupTz);
  const startMs = startInput ? startInput.getTime() : deadhead ? now : pickupWindow?.start ?? now;
  const dwellMin = Math.round((input.dwellHours ?? 2) * 60);
  const plan = planTrip({
    startMs, deadheadMin: deadhead?.minutes || 0, pickupWindow, dwellMin, driveMin: leg.minutes, deliveryWindow,
    clocks, clocksAtMs: clocks ? now : null,
  });

  const assumptions = [];
  assumptions.push(leg.routeSource === 'osrm'
    ? `${leg.miles.toLocaleString('en-US')} road miles and ${hoursText(leg.minutes)} of driving from the road route (OSRM, no traffic).`
    : leg.stateOnly
      ? `${label(from.precision === 'state' ? input.origin : input.dest)} could not be placed on the map: straight-line miles from the state center × ${ROAD_FACTOR} at ${ESTIMATE_MPH} mph.`
      : `Routing was unavailable: straight-line miles × ${ROAD_FACTOR} at ${ESTIMATE_MPH} mph.`);
  if (deadhead) assumptions.push(`Deadhead of about ${deadhead.miles.toLocaleString('en-US')} miles from the truck's position, straight line × ${ROAD_FACTOR} at ${ESTIMATE_MPH} mph, leaving ${at(plan.startMs, pickupTz)}.`);
  else assumptions.push(`Driver at the pickup from ${at(plan.startMs, pickupTz)}.`);
  assumptions.push(`${hoursText(dwellMin)} on duty loading at the pickup.`);
  if (hours.source === 'entered') {
    assumptions.push(`Hours left as entered: drive ${hoursText(clocks.driveLeft)}, duty ${hoursText(clocks.shiftLeft)}, cycle ${hoursText(clocks.cycleLeft)}.`);
  } else if (hours.source === 'report') {
    assumptions.push(`Hours left from the ${hours.by}'s latest report, counted down since then as if driving: drive ${hoursText(clocks.driveLeft)}, duty ${hoursText(clocks.shiftLeft)}, cycle ${hoursText(clocks.cycleLeft)} now.`);
  } else {
    assumptions.push(`${hours.stale ? 'The last hours report is more than 10 hours old, so this' : 'No hours left entered: this'} assumes a rested driver with ${LIMITS.drive / 60} h drive, ${LIMITS.shift / 60} h duty and ${LIMITS.cycle / 60} h cycle.`);
  }
  assumptions.push('The driver drives whenever the rules allow; no sleeper-berth split, traffic, weather or extra stops.');

  return {
    miles: leg.miles,
    minutes: leg.minutes,
    routeSource: leg.routeSource,
    startAt: new Date(plan.startMs),
    driveEta: new Date(plan.driveEtaMs),
    legalEta: new Date(plan.legalEtaMs),
    breaks: plan.breaks,
    resets: plan.resets,
    restarts: plan.restarts,
    verdict: plan.verdict,
    slackMinutes: plan.slackMin,
    extraMinutes: plan.extraMin,
    deliveryWindow: deliveryWindow ? { start: new Date(deliveryWindow.start), end: new Date(deliveryWindow.end) } : null,
    pickupWindow: pickupWindow ? { start: new Date(pickupWindow.start), end: new Date(pickupWindow.end) } : null,
    pickupTz,
    deliveryTz,
    pickup: plan.pickup ? {
      miles: deadhead.miles, minutes: deadhead.minutes, routeSource: 'estimate',
      driveEta: new Date(plan.pickup.driveEtaMs), legalEta: new Date(plan.pickup.legalEtaMs), verdict: plan.pickup.verdict,
    } : null,
    hours: { source: hours.source, reportedAt: hours.reportedAt, clocks: clocks ? { driveLeft: clocks.driveLeft, shiftLeft: clocks.shiftLeft, cycleLeft: clocks.cycleLeft } : null },
    stops: plan.events.map((e) => ({ type: e.type === 'rest' ? 'reset' : e.type, start: new Date(e.startMs), end: new Date(e.endMs) })),
    explanation: explain(plan),
    assumptions,
  };
}
