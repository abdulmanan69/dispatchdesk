import { describe, it, expect } from 'vitest';
import { encodePolyline, decodePolyline, simplify, simplifyToBudget, pinEnds, routeMatches, segmentMiles } from '../src/services/fleet/polyline.js';
import { simulate, normalizeClocks, clocksAt, freshClocks, hoursText } from '../src/services/fleet/hos.js';
import { measureRoute, projectOnRoute, paceFromPings, planTruck, riskFor, stopWindow, dwellFromEvents } from '../src/services/fleet/progress.js';

const MIN = 60_000;
// Dallas -> Texarkana -> Memphis, densified to ~2 km steps (a stand-in for a road route).
const CORNERS = [[-96.797, 32.777], [-94.048, 33.425], [-90.049, 35.15]];
function densify(points, stepMiles = 1.2) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const n = Math.max(1, Math.round(segmentMiles(a, b) / stepMiles));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}
const ROUTE = densify(CORNERS);

describe('encoded polylines', () => {
  it('matches the reference encoding and round-trips', () => {
    const pts = [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]];
    expect(encodePolyline(pts)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    const back = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(back).toHaveLength(3);
    back.forEach((p, i) => { expect(p[0]).toBeCloseTo(pts[i][0], 5); expect(p[1]).toBeCloseTo(pts[i][1], 5); });
    const long = decodePolyline(encodePolyline(ROUTE));
    expect(long).toHaveLength(ROUTE.length);
    expect(long.at(-1)[0]).toBeCloseTo(-90.049, 5);
  });

  it('survives junk input', () => {
    expect(decodePolyline('')).toEqual([]);
    expect(decodePolyline(null)).toEqual([]);
    expect(decodePolyline('~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~').length).toBeLessThan(3);
  });

  it('simplifies straight stretches and keeps corners, within a point budget', () => {
    const s = simplify(ROUTE, 40);
    expect(s.length).toBeLessThan(10);
    expect(s[0]).toEqual(ROUTE[0]);
    expect(s.at(-1)).toEqual(ROUTE.at(-1));
    expect(s.some((p) => Math.abs(p[0] + 94.048) < 1e-6)).toBe(true);
    const zigzag = Array.from({ length: 6000 }, (_, i) => [-100 + i * 0.001, 35 + (i % 2 ? 0.01 : 0)]);
    expect(simplifyToBudget(zigzag, 2500).length).toBeLessThanOrEqual(2500);
  });

  it('pins the exact pickup and delivery points and checks them later', () => {
    const from = { lat: 32.7767, lng: -96.797 };
    const to = { lat: 35.1495, lng: -90.049 };
    const pinned = pinEnds([[-96.7961, 32.7771], [-90.0502, 35.1491]], from, to);
    expect(pinned).toHaveLength(4);
    const enc = encodePolyline(pinned);
    expect(routeMatches(enc, from, to)).toBe(true);
    expect(routeMatches(enc, from, { lat: 36.16, lng: -86.78 })).toBe(false);
  });
});

describe('hours of service', () => {
  it('adds the 30-minute break after 8 hours of driving', () => {
    const r = simulate(0, [{ drive: 600 }, { mark: 'end' }]);
    expect(r.breaks).toBe(1);
    expect(r.rests).toBe(0);
    expect(r.marks.end / MIN).toBe(630);
  });

  it('adds a 10-hour rest when the 11-hour driving limit runs out', () => {
    const r = simulate(0, [{ drive: 900 }, { mark: 'end' }]);
    expect(r).toMatchObject({ breaks: 1, rests: 1 });
    expect(r.marks.end / MIN).toBe(660 + 30 + 600 + 240);
  });

  it('respects the 14-hour window and the 70-hour cycle', () => {
    const shift = simulate(0, [{ drive: 300 }, { mark: 'end' }], { driveLeft: 600, shiftLeft: 120, cycleLeft: 4200, breakDue: 480 });
    expect(shift.rests).toBe(1);
    expect(shift.marks.end / MIN).toBe(120 + 600 + 180);
    const cycle = simulate(0, [{ drive: 120 }, { mark: 'end' }], { driveLeft: 660, shiftLeft: 840, cycleLeft: 60, breakDue: 480 });
    expect(cycle.restarts).toBe(1);
    expect(cycle.marks.end / MIN).toBe(60 + 34 * 60 + 60);
  });

  it('counts loading time toward the break and a long wait as a reset', () => {
    const r = simulate(0, [{ drive: 10 }, { onDuty: 30 }, { drive: 100 }], { driveLeft: 660, shiftLeft: 840, cycleLeft: 4200, breakDue: 10 });
    expect(r.breaks).toBe(0);
    const waited = simulate(0, [{ drive: 10 }, { waitUntil: 11 * 60 * MIN }, { drive: 600 }, { mark: 'end' }], { driveLeft: 10, shiftLeft: 20, cycleLeft: 4200, breakDue: 480 });
    expect(waited.rests).toBe(0);
    expect(simulate(0, [{ drive: 900 }], null, { legal: false }).endMs / MIN).toBe(900);
  });

  it('normalizes entered clocks and runs them forward', () => {
    expect(normalizeClocks({})).toBeNull();
    expect(normalizeClocks({ driveLeftMin: 300 })).toEqual({ driveLeft: 300, shiftLeft: 840, cycleLeft: 4200, breakDue: 120 });
    expect(normalizeClocks({ driveLeftMin: 9999, cycleLeftMin: -5 })).toMatchObject({ driveLeft: 660, cycleLeft: 0 });
    expect(clocksAt({ driveLeft: 300, shiftLeft: 600, cycleLeft: 1000, breakDue: 100 }, 60, 30)).toEqual({ driveLeft: 270, shiftLeft: 540, cycleLeft: 970, breakDue: 70 });
    expect(clocksAt(freshClocks(), 601)).toBeNull();
    expect(hoursText(150)).toBe('2 h 30 min');
  });
});

describe('progress, ETA and risk', () => {
  const enc = encodePolyline(ROUTE);
  const route = measureRoute(enc);
  const now = Date.UTC(2026, 10, 10, 14, 0);

  it('snaps a position onto the route and measures what is left', () => {
    expect(route.total).toBeGreaterThan(400);
    const mid = ROUTE[Math.floor(ROUTE.length / 2)];
    const snap = projectOnRoute(route, { lat: mid[1], lng: mid[0] });
    expect(snap.offMiles).toBeLessThan(0.1);
    expect(snap.fraction).toBeGreaterThan(0.3);
    expect(snap.fraction).toBeLessThan(0.7);
    // ~10 miles north of the route
    const off = projectOnRoute(route, { lat: mid[1] + 0.145, lng: mid[0] });
    expect(off.offMiles).toBeGreaterThan(7);
    expect(off.offMiles).toBeLessThan(11);
  });

  it('measures moving pace from pings and ignores stops', () => {
    const pings = [];
    for (let i = 0; i <= 60; i++) pings.push({ lat: 32.78, lng: -96.8 + i * 0.0087, at: new Date(now - (60 - i) * 30_000), speed: 26.8 });
    for (let i = 1; i <= 20; i++) pings.push({ lat: 32.78, lng: -96.8 + 60 * 0.0087, at: new Date(now + i * 30_000), speed: 0 });
    const p = paceFromPings(pings, { now: now + 20 * 30_000 });
    expect(p.mph).toBeGreaterThan(55);
    expect(p.mph).toBeLessThan(65);
    expect(p.movingShare).toBeGreaterThan(0.6);
    expect(paceFromPings(pings.slice(0, 5), { now }).mph).toBeNull();
  });

  const load = (over = {}) => ({
    id: 'L1', status: 'in_transit', originCity: 'Dallas', originState: 'TX', destCity: 'Memphis', destState: 'TN',
    originLat: 32.777, originLng: -96.797, destLat: 35.15, destLng: -90.049, route: { geometry: enc }, routeMiles: route.total, routeMinutes: 600,
    routeSource: 'osrm', routeComputedAt: new Date(now), freeTimeHours: 2, createdAt: new Date(now - 86400000), ...over,
  });

  it('plans an in-transit trip: drive ETA, legal ETA with the break, and risk', () => {
    const late = planTruck({ trips: [load({ deliveryWindowEnd: new Date(now + 620 * MIN) })], position: { lat: 32.777, lng: -96.797 }, routes: { L1: route }, now });
    const stop = late.stops[0];
    expect(stop.kind).toBe('delivery');
    expect((stop.eta - now) / MIN).toBeCloseTo(600, 0);
    expect((stop.legalEta - now) / MIN).toBeCloseTo(630, 0);
    expect(stop.risk).toBe('late');
    expect(late.hos.assumed).toBe(true);
    expect(late.trips[0].progress).toMatchObject({ pct: 0, offRoute: false });
    const atRisk = planTruck({ trips: [load({ deliveryWindowEnd: new Date(now + 660 * MIN) })], position: { lat: 32.777, lng: -96.797 }, routes: { L1: route }, now });
    expect(atRisk.risk).toBe('at_risk');
    const fine = planTruck({ trips: [load({ deliveryDate: new Date(now + 900 * MIN) })], position: { lat: 32.777, lng: -96.797 }, routes: { L1: route }, now });
    expect(fine.risk).toBe('on_time');
  });

  it('uses the hours left the dispatcher entered', () => {
    const hos = { clocks: normalizeClocks({ driveLeftMin: 120, shiftLeftMin: 600, cycleLeftMin: 3000 }), at: new Date(now) };
    const plan = planTruck({ trips: [load()], position: { lat: 32.777, lng: -96.797 }, routes: { L1: route }, hos, now });
    expect(plan.hos.assumed).toBe(false);
    expect(plan.legal.rests).toBe(1);
    expect((plan.stops[0].legalEta - plan.stops[0].eta) / MIN).toBeGreaterThanOrEqual(600);
  });

  it('plans a booked trip: deadhead, waiting for the appointment, loading, then the load', () => {
    const booked = load({ status: 'booked', pickupWindowStart: new Date(now + 300 * MIN), pickupWindowEnd: new Date(now + 360 * MIN) });
    // ~100 miles west of Dallas
    const plan = planTruck({ trips: [booked], position: { lat: 32.777, lng: -98.52 }, routes: { L1: route }, now });
    const [pickup, delivery] = plan.stops;
    expect(pickup.kind).toBe('pickup');
    expect((pickup.eta - now) / MIN).toBeGreaterThan(120);
    expect((pickup.eta - now) / MIN).toBeLessThan(170);
    expect(pickup.risk).toBe('on_time');
    expect((delivery.eta - now) / MIN).toBeCloseTo(300 + 120 + 600, 0);
    const lost = planTruck({ trips: [booked], position: null, routes: { L1: route }, now });
    expect(lost.stops.every((s) => s.eta === null)).toBe(true);
  });

  it('times loads typed without coordinates from the city, never from a state center or a stale route', () => {
    // Loads from the Loads page carry only city and state; a stored route whose ends moved is not used.
    const typed = { id: 'L2', status: 'booked', originCity: 'Dallas', originState: 'TX', destCity: 'Memphis', destState: 'TN', loadedMiles: 452, routeMiles: 5, routeMinutes: 10, freeTimeHours: 2, createdAt: new Date(now) };
    const plan = planTruck({ trips: [typed], position: { lat: 32.9, lng: -97.1 }, now });
    const [pickup, delivery] = plan.stops;
    expect(pickup.eta).toBeTruthy();
    expect((delivery.eta - pickup.eta) / MIN).toBeCloseTo(120 + (452 / 50) * 60, 0);
    // Fontana, CA is not a known city: only California's center point, which is no place to time a stop from.
    const vague = planTruck({ trips: [{ ...typed, originCity: 'Fontana', originState: 'CA' }], position: { lat: 32.9, lng: -97.1 }, now });
    expect(vague.stops.every((s) => s.eta === null)).toBe(true);
  });

  it('reads appointment windows and judges arrivals', () => {
    // Only a date (stored at local noon): the whole local day at the facility, flagged so no time is shown or judged.
    const noon = Date.UTC(2026, 10, 12, 18, 0); // Nov 12, 12:00 in Chicago
    const day = stopWindow({ pickupDate: new Date(noon), originState: 'TX' }, 'pickup');
    expect(day).toMatchObject({ start: new Date(Date.UTC(2026, 10, 12, 6, 0)), dateOnly: true, tz: 'America/Chicago' });
    expect(day.end.getTime()).toBe(Date.UTC(2026, 10, 13, 6, 0) - 1);
    expect(riskFor(noon + 5 * 60 * MIN, day)).toBe('on_time'); // an afternoon arrival is not late
    expect(riskFor(Date.UTC(2026, 10, 13, 7, 0), day)).toBe('late');
    // A window that was entered keeps its times.
    expect(stopWindow({ pickupWindowStart: new Date(now), pickupWindowEnd: new Date(now + 60 * MIN), pickupDate: new Date(now) }, 'pickup')).toMatchObject({ start: new Date(now), end: new Date(now + 60 * MIN) });
    expect(stopWindow({ pickupWindowStart: new Date(now) }, 'pickup').dateOnly).toBeUndefined();
    expect(stopWindow({}, 'delivery')).toBeNull();
    const w = { start: new Date(now), end: new Date(now + 120 * MIN) };
    expect(riskFor(now + 30 * MIN, w)).toBe('on_time');
    expect(riskFor(now + 90 * MIN, w)).toBe('at_risk');
    expect(riskFor(now + 121 * MIN, w)).toBe('late');
  });

  it('times dwell and detention from check-ins', () => {
    const arrived = { type: 'arrived_pickup', at: new Date(now - 3 * 3600_000) };
    const open = dwellFromEvents([arrived], { freeTimeHours: 2, now });
    expect(open[0]).toMatchObject({ stop: 'pickup', dwellMin: 180, freeMin: 120, detentionMin: 60, running: true });
    const done = dwellFromEvents([arrived, { type: 'loaded', at: new Date(now - 3600_000) }], { freeTimeHours: 2, now });
    expect(done[0]).toMatchObject({ dwellMin: 120, detentionMin: 0, running: false });
  });
});
