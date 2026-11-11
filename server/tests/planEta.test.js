import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { agent, registerUser } from './helpers.js';
import { clearLiveCache } from '../src/services/market/live.js';
import { haversineMiles, ROAD_FACTOR } from '../src/services/market/geo.js';
import { encodePolyline } from '../src/services/fleet/polyline.js';
import { planTrip, verdictFor, clocksFromHours, freshClocks } from '../src/services/fleet/hos.js';
import { explain, stopsText, windowOf } from '../src/services/fleet/planEta.js';

const MIN = 60_000;
const H = 60 * MIN;
const T0 = Date.UTC(2026, 10, 16, 14, 0); // Mon Nov 16 2026, 8:00 AM CST

/** planTrip with no loading time unless given, starting at T0; returns minutes from T0 to the legal ETA. */
const legalMin = (p) => (p.legalEtaMs - T0) / MIN;

describe('legal ETA math (planTrip)', () => {
  it('exactly 8 hours of driving needs no break; one minute more needs one', () => {
    const eight = planTrip({ startMs: T0, dwellMin: 0, driveMin: 480 });
    expect(eight).toMatchObject({ breaks: 0, resets: 0, restarts: 0, extraMin: 0 });
    expect(legalMin(eight)).toBe(480);
    const more = planTrip({ startMs: T0, dwellMin: 0, driveMin: 481 });
    expect(more.breaks).toBe(1);
    expect(legalMin(more)).toBe(511);
    expect((more.driveEtaMs - T0) / MIN).toBe(481);
  });

  it('exactly 11 hours fits one shift with a break; past 11 hours needs a 10-hour reset', () => {
    const eleven = planTrip({ startMs: T0, dwellMin: 0, driveMin: 660 });
    expect(eleven).toMatchObject({ breaks: 1, resets: 0 });
    expect(legalMin(eleven)).toBe(690);
    const over = planTrip({ startMs: T0, dwellMin: 0, driveMin: 661 });
    expect(over).toMatchObject({ breaks: 1, resets: 1 });
    expect(legalMin(over)).toBe(690 + 600 + 1);
  });

  it('loading counts toward the 14-hour window and as the break', () => {
    // 2 h loading + 11 h driving: the loading satisfies the 30-minute rule for the first 8 hours, the window holds.
    const usual = planTrip({ startMs: T0, dwellMin: 120, driveMin: 660 });
    expect(usual).toMatchObject({ breaks: 1, resets: 0 });
    expect(legalMin(usual)).toBe(120 + 690);
    // 4 h loading: the 14-hour window closes with 90 minutes still to drive.
    const long = planTrip({ startMs: T0, dwellMin: 240, driveMin: 660 });
    expect(long).toMatchObject({ breaks: 1, resets: 1 });
    expect(legalMin(long)).toBe(240 + 480 + 30 + 90 + 600 + 90);
  });

  it('plans a multi-day trip with a break each shift and a reset each night', () => {
    const p = planTrip({ startMs: T0, dwellMin: 0, driveMin: 2000 });
    expect(p).toMatchObject({ breaks: 3, resets: 3, restarts: 0 });
    expect(legalMin(p)).toBe(2000 + 3 * 30 + 3 * 600);
    expect(p.extraMin).toBe(3 * 30 + 3 * 600);
    expect(p.events.map((e) => e.type)).toEqual(['break', 'rest', 'break', 'rest', 'break', 'rest']);
  });

  it('a driver out of cycle hours takes a 34-hour restart first; a few hours left run out on the way', () => {
    const out = planTrip({ startMs: T0, dwellMin: 0, driveMin: 60, clocks: clocksFromHours({ cycle: 0 }) });
    expect(out).toMatchObject({ restarts: 1, resets: 0 });
    expect(legalMin(out)).toBe(34 * 60 + 60);
    const low = planTrip({ startMs: T0, dwellMin: 0, driveMin: 600, clocks: clocksFromHours({ cycle: 5 }) });
    expect(low.restarts).toBe(1);
    expect(legalMin(low)).toBe(300 + 34 * 60 + 300);
  });

  it('no hours entered means a rested driver with full clocks', () => {
    expect(clocksFromHours(null)).toBeNull();
    expect(clocksFromHours({})).toBeNull();
    expect(clocksFromHours({ drive: '', duty: null })).toBeNull();
    // 6.5 h of driving left = 4.5 h driven with no break yet: the break is due in 3.5 h.
    expect(clocksFromHours({ drive: 6.5 })).toEqual({ driveLeft: 390, shiftLeft: 840, cycleLeft: 4200, breakDue: 210 });
    expect(clocksFromHours({ drive: 99, duty: 20, cycle: 80 })).toMatchObject({ driveLeft: 660, shiftLeft: 840, cycleLeft: 4200 });
    const assumed = planTrip({ startMs: T0, driveMin: 900 });
    const full = planTrip({ startMs: T0, driveMin: 900, clocks: freshClocks() });
    expect(assumed.legalEtaMs).toBe(full.legalEtaMs);
  });

  it('entered hours that run short add a reset', () => {
    // 2 h left = 9 h driven with no break yet: a break first, 2 h, the reset, then the rest.
    const p = planTrip({ startMs: T0, dwellMin: 0, driveMin: 300, clocks: clocksFromHours({ drive: 2 }) });
    expect(p).toMatchObject({ breaks: 1, resets: 1 });
    expect(legalMin(p)).toBe(30 + 120 + 600 + 180);
  });

  it('a rested driver waiting at the pickup starts the day at the appointment', () => {
    const p = planTrip({ startMs: T0, pickupWindow: { start: T0 + 5 * H, end: T0 + 6 * H }, dwellMin: 120, driveMin: 660 });
    expect(p.startMs).toBe(T0 + 5 * H);
    expect(p.resets).toBe(0);
    expect(legalMin(p)).toBe(300 + 120 + 690);
  });

  it('hours reported earlier reset after 10 hours off before the start', () => {
    const tired = { driveLeft: 30, shiftLeft: 30, cycleLeft: 4200, breakDue: 30 };
    const rested = planTrip({ startMs: T0, dwellMin: 0, driveMin: 300, clocks: tired, clocksAtMs: T0 - 11 * H });
    expect(rested.resets).toBe(0);
    expect(legalMin(rested)).toBe(300);
    const notYet = planTrip({ startMs: T0, dwellMin: 0, driveMin: 300, clocks: tired, clocksAtMs: T0 - 2 * H });
    expect(notYet.resets).toBe(1);
  });

  it('checks pickup reachability after deadhead and waits for the pickup appointment', () => {
    const p = planTrip({ startMs: T0, deadheadMin: 300, pickupWindow: { start: T0 + 6 * H, end: T0 + 7 * H }, dwellMin: 60, driveMin: 120 });
    expect(p.pickup).toMatchObject({ verdict: 'on_time' });
    expect((p.pickup.legalEtaMs - T0) / MIN).toBe(300);
    expect(legalMin(p)).toBe(360 + 60 + 120);
    const late = planTrip({ startMs: T0, deadheadMin: 600, pickupWindow: { start: T0 + 6 * H, end: T0 + 7 * H }, driveMin: 60 });
    expect(late.pickup.verdict).toBe('late');
    expect(planTrip({ startMs: T0, driveMin: 60 }).pickup).toBeNull();
  });

  it('gives the verdict against the delivery window', () => {
    const end = T0 + 10 * H;
    expect(verdictFor(end - 61 * MIN, { start: T0, end })).toBe('on_time');
    expect(verdictFor(end - 60 * MIN, { start: T0, end })).toBe('on_time');
    expect(verdictFor(end - 59 * MIN, { start: T0, end })).toBe('at_risk');
    expect(verdictFor(end, { start: T0, end })).toBe('at_risk');
    expect(verdictFor(end + 1, { start: T0, end })).toBe('late');
    expect(verdictFor(end + 1, { start: end })).toBe('late');
    expect(verdictFor(end, null)).toBe('no_window');
    expect(verdictFor(null, { start: T0, end })).toBeNull();
    const p = planTrip({ startMs: T0, dwellMin: 0, driveMin: 661, deliveryWindow: { start: T0 + 20 * H, end: T0 + 23 * H } });
    expect(p.verdict).toBe('on_time');
    expect(p.slackMin).toBe(23 * 60 - 1291);
  });

  it('explains the result in one plain sentence', () => {
    expect(stopsText({ breaks: 1, resets: 2, restarts: 0 })).toBe('1 30-minute break and 2 10-hour resets');
    expect(stopsText({ breaks: 0, resets: 0, restarts: 0 })).toBe('');
    expect(explain({ verdict: 'late', slackMin: -150, breaks: 1, resets: 1, restarts: 0 }))
      .toBe('Driving legally, the driver arrives 2 h 30 min after the delivery appointment ends, with 1 30-minute break and 1 10-hour reset on the way.');
    expect(explain({ verdict: 'at_risk', slackMin: 40, breaks: 0, resets: 0, restarts: 0 }))
      .toBe('The driver can legally arrive only 40 min before the delivery appointment ends without a required stop, so any delay makes it late.');
    expect(explain({ verdict: 'no_window', extraMin: 630, breaks: 1, resets: 1, restarts: 0 })).toMatch(/^Hours-of-service rules add 10 h 30 min/);
    for (const v of ['late', 'at_risk', 'on_time', 'no_window']) {
      const s = explain({ verdict: v, slackMin: 30, extraMin: 0, breaks: 0, resets: 0, restarts: 0 });
      expect(s).not.toMatch(/!/);
      expect(s.endsWith('.')).toBe(true);
    }
  });

  it('reads appointment windows as instants or facility-local wall times', () => {
    expect(windowOf(null, null)).toBeNull();
    expect(windowOf('2026-11-20T08:00', null, 'America/Chicago')).toEqual({ start: Date.UTC(2026, 10, 20, 14), end: Date.UTC(2026, 10, 20, 14) });
    expect(windowOf('2026-11-20T14:00:00Z', '2026-11-20T10:00', 'America/New_York')).toEqual({ start: Date.UTC(2026, 10, 20, 14), end: Date.UTC(2026, 10, 20, 15) });
    expect(() => windowOf('2026-11-20T10:00', '2026-11-20T08:00', 'America/Chicago')).toThrow(/ends before it starts/);
  });
});

// ---------------------------------------------------------------------------
// POST /api/plan-eta
// ---------------------------------------------------------------------------
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
function stubOsrm(handler) {
  const fn = vi.fn(async (url) => {
    const u = String(url);
    if (!u.includes('router.project-osrm.org')) throw new Error(`unexpected fetch ${u}`);
    return handler(u);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const DAL = { city: 'Dallas', state: 'TX' };
const MEM = { city: 'Memphis', state: 'TN' };
// Dallas -> Memphis: 452 road miles, 410 minutes (6 h 50 min).
const osrmDalMem = () => ok({ code: 'Ok', routes: [{ distance: 452 * 1609.344, duration: 410 * 60, geometry: encodePolyline([[-96.797, 32.777], [-94.048, 33.425], [-90.049, 35.15]]) }] });
const iso = (ms) => new Date(ms).toISOString();

describe('POST /api/plan-eta', () => {
  let A; let B; let carrierA; let carrierB; let tripA;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    carrierA = (await A.agent.post('/api/carriers').send({ companyName: 'Plan Eta Freight', state: 'TX', phone: '2145550190' })).body.carrier;
    carrierB = (await B.agent.post('/api/carriers').send({ companyName: 'Other Desk Freight', state: 'TX', phone: '2145550191' })).body.carrier;
    tripA = (await A.agent.post('/api/fleet/trips').send({ carrierId: carrierA.id, origin: DAL, dest: MEM, rateCents: 150000 })).body.trip;
  });
  beforeEach(() => clearLiveCache());
  afterEach(() => vi.unstubAllGlobals());

  it('needs a session', async () => {
    const anon = await agent();
    expect((await anon.post('/api/plan-eta').send({ origin: DAL, dest: MEM })).status).toBe(401);
  });

  it('validates the input', async () => {
    const bad = async (body) => (await A.agent.post('/api/plan-eta').send(body)).status;
    expect(await bad({ origin: DAL })).toBe(400);
    expect(await bad({ origin: { city: 'Dallas', state: 'Texas' }, dest: MEM })).toBe(400);
    expect(await bad({ origin: DAL, dest: { ...MEM, lat: 123 } })).toBe(400);
    expect(await bad({ origin: DAL, dest: MEM, hoursLeft: { drive: 12 } })).toBe(400);
    expect(await bad({ origin: DAL, dest: MEM, hoursLeft: { cycle: 'lots' } })).toBe(400);
    expect(await bad({ origin: DAL, dest: MEM, deliveryWindowStart: 'next tuesday' })).toBe(400);
    expect(await bad({ origin: DAL, dest: MEM, deliveryTz: 'Mars/Olympus' })).toBe(400);
    expect(await bad({ origin: DAL, dest: MEM, deliveryWindowStart: '2026-11-20T10:00', deliveryWindowEnd: '2026-11-20T08:00' })).toBe(400);
    expect(await bad({ origin: DAL, dest: MEM, deadhead: { from: { lat: 32.7 } } })).toBe(400);
  });

  it('returns 404 for a carrier or load of another workspace', async () => {
    const res = await B.agent.post('/api/plan-eta').send({ carrierId: carrierA.id, origin: DAL, dest: MEM });
    expect(res.status).toBe(404);
    expect((await B.agent.post('/api/plan-eta').send({ loadId: tripA.id, origin: DAL, dest: MEM })).status).toBe(404);
    expect((await A.agent.post('/api/plan-eta').send({ carrierId: carrierB.id, origin: DAL, dest: MEM })).status).toBe(404);
    expect((await A.agent.post('/api/plan-eta').send({ carrierId: carrierA.id, loadId: tripA.id, origin: DAL, dest: MEM })).status).toBe(200);
  });

  it('uses the road route (one lookup) and checks the delivery appointment', async () => {
    const f = stubOsrm(osrmDalMem);
    const start = T0;
    const res = await A.agent.post('/api/plan-eta').send({
      origin: DAL, dest: MEM, startAt: iso(start),
      // Single appointment 9 h after the start: 2 h loading + 6 h 50 min driving = 8 h 50 min, 10 min short of it.
      deliveryWindowStart: iso(start + 9 * H),
    });
    expect(res.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ miles: 452, minutes: 410, routeSource: 'osrm', breaks: 0, resets: 0, restarts: 0, verdict: 'at_risk', slackMinutes: 10 });
    expect(new Date(res.body.legalEta).getTime()).toBe(start + (120 + 410) * MIN);
    expect(new Date(res.body.driveEta).getTime()).toBe(start + (120 + 410) * MIN);
    expect(res.body.deliveryTz).toBe('America/Chicago');
    expect(res.body.explanation).toMatch(/only 10 min before the delivery appointment ends/);
    expect(res.body.assumptions.join(' ')).toMatch(/rested driver/);
    expect(res.body.hours.source).toBe('assumed');

    // The same pair again comes from the route cache: no second routing call.
    const again = await A.agent.post('/api/plan-eta').send({ origin: DAL, dest: MEM, startAt: iso(start), deliveryWindowStart: iso(start + 20 * H), deliveryWindowEnd: iso(start + 22 * H) });
    expect(again.body.verdict).toBe('on_time');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('falls back to the straight-line estimate when routing fails', async () => {
    stubOsrm(() => { throw new TypeError('fetch failed'); });
    const res = await A.agent.post('/api/plan-eta').send({ origin: DAL, dest: MEM, startAt: iso(T0) });
    expect(res.status).toBe(200);
    const miles = Math.round(haversineMiles([32.777, -96.797], [35.15, -90.049]) * ROAD_FACTOR);
    expect(res.body).toMatchObject({ routeSource: 'estimate', miles, minutes: Math.round((miles / 50) * 60), verdict: 'no_window' });
    expect(res.body.assumptions[0]).toMatch(/Routing was unavailable/);
  });

  it('reads facility-local appointment times in the facility time zone', async () => {
    stubOsrm(osrmDalMem);
    const res = await A.agent.post('/api/plan-eta').send({
      origin: DAL, dest: MEM, pickupWindowStart: '2026-11-20T09:00', pickupWindowEnd: '2026-11-20T11:00',
      deliveryWindowStart: '2026-11-20T18:00', deliveryWindowEnd: '2026-11-20T20:00',
    });
    expect(res.status).toBe(200);
    expect(res.body.pickupWindow.end).toBe('2026-11-20T17:00:00.000Z');
    expect(res.body.deliveryWindow.start).toBe('2026-11-21T00:00:00.000Z');
    // A rested driver starts at the pickup appointment (no deadhead given).
    expect(res.body.startAt).toBe('2026-11-20T15:00:00.000Z');
    expect(res.body.verdict).toBe('on_time');
  });

  it('uses the hours left passed in and checks the pickup after deadhead', async () => {
    stubOsrm(osrmDalMem);
    const start = Date.now();
    const res = await A.agent.post('/api/plan-eta').send({
      origin: DAL, dest: MEM, startAt: iso(start), hoursLeft: { drive: 3, duty: 4, cycle: 30 }, dwellHours: 1,
      pickupWindowStart: iso(start + 3 * H), pickupWindowEnd: iso(start + 5 * H),
      deliveryWindowStart: iso(start + 11 * H), deliveryWindowEnd: iso(start + 13 * H),
      deadhead: { from: { lat: 32.3513, lng: -95.3011 } }, // Tyler, TX: about 110 road miles east of Dallas
    });
    expect(res.status).toBe(200);
    expect(res.body.pickup).toMatchObject({ routeSource: 'estimate', verdict: 'on_time' });
    expect(res.body.pickup.miles).toBeGreaterThan(90);
    // 8 h already driven: a break before the deadhead; the 4-hour duty window closes at the dock, so a 10-hour reset.
    expect(res.body).toMatchObject({ verdict: 'late', breaks: 1, resets: 1, hours: { source: 'entered', clocks: { driveLeft: 180, shiftLeft: 240, cycleLeft: 1800 } } });
    expect(new Date(res.body.legalEta).getTime() - start).toBeCloseTo((180 + 60 + 600 + 410) * MIN, -4);
    expect(new Date(res.body.driveEta).getTime() - start).toBeCloseTo((180 + 60 + 410) * MIN, -4);
    expect(res.body.explanation).toMatch(/^Driving legally, the driver arrives .* after the delivery appointment ends, with 1 30-minute break and 1 10-hour reset on the way\.$/);
    expect(res.body.stops.map((s) => s.type)).toEqual(['break', 'reset']);
  });

  it('uses the latest hours report on the carrier’s trips when none are typed', async () => {
    const saved = await A.agent.post(`/api/fleet/trips/${tripA.id}/hos`).send({ driveLeftMin: 60, shiftLeftMin: 120, cycleLeftMin: 600 });
    expect(saved.status).toBe(201);
    stubOsrm(osrmDalMem);
    const res = await A.agent.post('/api/plan-eta').send({ carrierId: carrierA.id, origin: DAL, dest: MEM });
    expect(res.status).toBe(200);
    expect(res.body.hours.source).toBe('report');
    expect(res.body.hours.clocks.driveLeft).toBeLessThanOrEqual(60);
    expect(res.body.resets).toBeGreaterThanOrEqual(1);
    // Hours typed for the check win over the report.
    const typed = await A.agent.post('/api/plan-eta').send({ carrierId: carrierA.id, origin: DAL, dest: MEM, hoursLeft: { drive: 11 } });
    expect(typed.body.hours.source).toBe('entered');
  });
});
