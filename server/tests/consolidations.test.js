import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { clearLiveCache } from '../src/services/market/live.js';
import { encodePolyline, decodePolyline, segmentMiles } from '../src/services/fleet/polyline.js';
import { multiStopRoute } from '../src/services/fleet/route.js';
import {
  checkStops, defaultStops, deriveStatus, insertStops, planStops, consolidationRoutesIdle, parseStops,
} from '../src/services/fleet/consolidation.js';

// Exact stop coordinates, so every leg can be checked against the stored line.
const P = {
  dallas: { city: 'Dallas', state: 'TX', lat: 32.7767, lng: -96.797 },
  fortWorth: { city: 'Fort Worth', state: 'TX', lat: 32.7555, lng: -97.3308 },
  memphis: { city: 'Memphis', state: 'TN', lat: 35.1495, lng: -90.049 },
  littleRock: { city: 'Little Rock', state: 'AR', lat: 34.7465, lng: -92.2896 },
  okc: { city: 'Oklahoma City', state: 'OK', lat: 35.4676, lng: -97.5164 },
  houston: { city: 'Houston', state: 'TX', lat: 29.7604, lng: -95.3698 },
};
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

/** OSRM stand-in: a bent line between the two requested points, 1.2 × the straight distance at 55 mph. */
function stubOsrm({ fail = false } = {}) {
  const fn = vi.fn(async (url) => {
    const u = String(url);
    if (!u.includes('router.project-osrm.org')) throw new Error(`unexpected fetch ${u}`);
    if (fail) return { ok: false, status: 500, json: async () => ({ message: 'down' }) };
    const m = u.match(/driving\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)/);
    const a = [Number(m[1]), Number(m[2])];
    const b = [Number(m[3]), Number(m[4])];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.05];
    const pts = [a, [(a[0] + mid[0]) / 2, (a[1] + mid[1]) / 2], mid, [(mid[0] + b[0]) / 2, (mid[1] + b[1]) / 2], b];
    const miles = segmentMiles(a, b) * 1.2;
    return ok({ code: 'Ok', routes: [{ distance: miles * 1609.344, duration: (miles / 55) * 3600, geometry: encodePolyline(pts) }] });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

let refN = 0;
async function makeLoad(owner, { from, to, carrierId = null, status = 'booked', pickup = null, delivery = null, ref } = {}) {
  refN += 1;
  return prisma.load.create({
    data: {
      ownerId: owner.user.id, carrierId, status, referenceNumber: ref || `CN-${refN}`,
      originCity: from.city, originState: from.state, originLat: from.lat, originLng: from.lng,
      destCity: to.city, destState: to.state, destLat: to.lat, destLng: to.lng,
      pickupWindowStart: pickup ? new Date(pickup) : null, deliveryWindowStart: delivery ? new Date(delivery) : null,
      rateCents: 150000, loadedMiles: 400,
    },
  });
}

/** True when the encoded line passes through the points, in order. */
function passesThrough(encoded, points) {
  const line = decodePolyline(encoded);
  let j = 0;
  for (const p of points) {
    while (j < line.length && !(Math.abs(line[j][0] - p.lng) < 2e-5 && Math.abs(line[j][1] - p.lat) < 2e-5)) j++;
    if (j >= line.length) return false;
  }
  return true;
}

describe('consolidation helpers', () => {
  const L = (id, p, d) => ({ id, referenceNumber: id, pickupWindowStart: p ? new Date(p) : null, deliveryWindowStart: d ? new Date(d) : null, originCity: 'A', destCity: 'B' });

  it('orders pickups by window start, then deliveries by window start', () => {
    const loads = [L('a', '2026-11-12T12:00Z', '2026-11-14T09:00Z'), L('b', '2026-11-12T08:00Z', '2026-11-13T09:00Z'), L('c', null, null)];
    expect(defaultStops(loads)).toEqual([
      { loadId: 'b', kind: 'pickup' }, { loadId: 'a', kind: 'pickup' }, { loadId: 'c', kind: 'pickup' },
      { loadId: 'b', kind: 'delivery' }, { loadId: 'a', kind: 'delivery' }, { loadId: 'c', kind: 'delivery' },
    ]);
  });

  it('accepts only a permutation with every pickup before its delivery', () => {
    const ids = ['a', 'b'];
    const good = [{ loadId: 'a', kind: 'pickup' }, { loadId: 'b', kind: 'pickup' }, { loadId: 'a', kind: 'delivery' }, { loadId: 'b', kind: 'delivery' }];
    expect(checkStops(good, ids)).toEqual({ ok: true });
    const backwards = [{ loadId: 'a', kind: 'delivery' }, { loadId: 'a', kind: 'pickup' }, { loadId: 'b', kind: 'pickup' }, { loadId: 'b', kind: 'delivery' }];
    expect(checkStops(backwards, ids, new Map([['a', { referenceNumber: '77' }]]))).toMatchObject({ ok: false, loadId: 'a', reason: 'Load #77 is delivered before it is picked up' });
    expect(checkStops(good.slice(0, 3), ids).ok).toBe(false);
    expect(checkStops([...good, { loadId: 'x', kind: 'pickup' }], ids).ok).toBe(false);
    expect(checkStops([good[0], good[0], good[2], good[3]], ids).ok).toBe(false);
  });

  it('inserts a new load by time, after the stops already done', () => {
    const a = L('a', '2026-11-12T08:00Z', '2026-11-13T08:00Z');
    const b = L('b', '2026-11-12T10:00Z', '2026-11-14T08:00Z');
    const c = L('c', '2026-11-12T09:00Z', '2026-11-13T12:00Z');
    const byId = new Map([[a.id, a], [b.id, b], [c.id, c]]);
    const stops = defaultStops([a, b]);
    expect(insertStops(stops, c, byId).map((s) => `${s.loadId}:${s.kind[0]}`)).toEqual(['a:p', 'c:p', 'b:p', 'a:d', 'c:d', 'b:d']);
    // a and b already picked up: c's pickup cannot go before them.
    expect(insertStops(stops, c, byId, (s) => s.kind === 'pickup').map((s) => `${s.loadId}:${s.kind[0]}`)).toEqual(['a:p', 'b:p', 'c:p', 'a:d', 'c:d', 'b:d']);
  });

  it('derives the trip status from its loads', () => {
    expect(deriveStatus([{ status: 'planned' }, { status: 'booked' }])).toBe('planned');
    expect(deriveStatus([{ status: 'in_transit' }, { status: 'booked' }])).toBe('in_transit');
    expect(deriveStatus([{ status: 'delivered' }, { status: 'booked' }])).toBe('in_transit');
    expect(deriveStatus([{ status: 'delivered' }, { status: 'paid' }, { status: 'canceled' }])).toBe('delivered');
    expect(deriveStatus([{ status: 'canceled' }])).toBe('canceled');
  });

  it('times the open stops in order and flags a stop that cannot make its window', () => {
    const now = Date.parse('2026-11-12T06:00:00Z');
    const mk = (id, from, to, pw, dw, status = 'booked') => ({
      id, status, freeTimeHours: 1, originCity: from.city, originState: from.state, originLat: from.lat, originLng: from.lng,
      destCity: to.city, destState: to.state, destLat: to.lat, destLng: to.lng,
      pickupWindowStart: new Date(pw), pickupWindowEnd: new Date(pw), deliveryWindowStart: new Date(dw), deliveryWindowEnd: new Date(dw),
    });
    const a = mk('a', P.dallas, P.memphis, '2026-11-12T08:00Z', '2026-11-13T08:00Z');
    // Fort Worth pickup at 08:30 cannot be made after a Dallas pickup at 08:00 plus an hour at the dock.
    const b = mk('b', P.fortWorth, P.littleRock, '2026-11-12T08:30Z', '2026-11-13T20:00Z');
    const byId = new Map([[a.id, a], [b.id, b]]);
    const stops = [{ loadId: 'a', kind: 'pickup' }, { loadId: 'b', kind: 'pickup' }, { loadId: 'b', kind: 'delivery' }, { loadId: 'a', kind: 'delivery' }];
    const out = planStops(stops, byId, { position: { lat: P.dallas.lat, lng: P.dallas.lng }, now, legMinutes: [40, 320, 150] });
    expect(out[0].eta.toISOString()).toBe('2026-11-12T06:00:00.000Z');
    expect(out[0].risk).toBe('on_time');
    // Waits for the 08:00 window, an hour at the dock, then 40 minutes of driving.
    expect(out[1].eta.toISOString()).toBe('2026-11-12T09:40:00.000Z');
    expect(out[1].risk).toBe('late');
    expect(out[3].eta > out[2].eta).toBe(true);
    // No truck position: no ETAs and no risk.
    expect(planStops(stops, byId, { now }).every((s) => s.eta == null && s.risk == null)).toBe(true);
    // A picked-up load's pickup is done and gets no ETA.
    const moving = new Map([[a.id, { ...a, status: 'in_transit' }], [b.id, b]]);
    expect(planStops(stops, moving, { position: { lat: P.dallas.lat, lng: P.dallas.lng }, now, legMinutes: [40, 320, 150] })[0].eta).toBeNull();
  });

  it('routes through every stop and reuses a known leg without a routing call', async () => {
    clearLiveCache();
    const f = stubOsrm();
    const pts = [P.dallas, P.fortWorth, P.littleRock, P.memphis];
    const r = await multiStopRoute(pts, { known: [undefined, { encoded: encodePolyline([[P.fortWorth.lng, P.fortWorth.lat], [-95, 33.5], [P.littleRock.lng, P.littleRock.lat]]), miles: 330, minutes: 300 }] });
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.estimate).toBe(false);
    expect(r.legs.map((l) => l.miles)[1]).toBe(330);
    expect(r.miles).toBe(r.legs.reduce((s, l) => s + l.miles, 0));
    expect(passesThrough(r.geometry, pts)).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('consolidated trips API', () => {
  let A; let B; let truck; let truck2; let truckB;
  beforeAll(async () => {
    A = await registerUser({ name: 'Cora Lane' });
    B = await registerUser();
    truck = (await A.agent.post('/api/carriers').send({ companyName: 'Two Rivers Freight', state: 'TX', phone: '2145550101' })).body.carrier;
    truck2 = (await A.agent.post('/api/carriers').send({ companyName: 'Hill Country Haulers', state: 'TX', phone: '2145550102' })).body.carrier;
    truckB = (await B.agent.post('/api/carriers').send({ companyName: 'Other Desk Trucking', state: 'TX', phone: '2145550103' })).body.carrier;
    await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ truckStatus: 'available', location: { city: 'Dallas', state: 'TX', lat: P.dallas.lat, lng: P.dallas.lng } });
  });
  beforeEach(() => { clearLiveCache(); });
  afterEach(async () => { await consolidationRoutesIdle(); vi.unstubAllGlobals(); });

  it('groups loads on one truck in pickup-then-delivery time order and stores one road route through every stop', async () => {
    const f = stubOsrm();
    const l1 = await makeLoad(A, { from: P.dallas, to: P.memphis, carrierId: truck.id, pickup: '2026-11-12T08:00Z', delivery: '2026-11-13T14:00Z' });
    const l2 = await makeLoad(A, { from: P.fortWorth, to: P.littleRock, carrierId: truck.id, pickup: '2026-11-12T10:00Z', delivery: '2026-11-13T09:00Z' });
    // A load with no truck yet is put on this one.
    const l3 = await makeLoad(A, { from: P.dallas, to: P.okc, status: 'planned', pickup: '2026-11-12T07:00Z', delivery: '2026-11-12T16:00Z' });
    const res = await A.agent.post('/api/consolidations').send({ carrierId: truck.id, loadIds: [l1.id, l2.id, l3.id], name: 'East run' });
    expect(res.status).toBe(201);
    const c = res.body.consolidation;
    expect(c.stops.map((s) => `${s.loadId}:${s.kind}`)).toEqual([
      `${l3.id}:pickup`, `${l1.id}:pickup`, `${l2.id}:pickup`, `${l3.id}:delivery`, `${l2.id}:delivery`, `${l1.id}:delivery`,
    ]);
    expect(c.stops.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(c).toMatchObject({ name: 'East run', status: 'planned', carrierId: truck.id });
    expect(c.route).toMatchObject({ estimate: false, current: true });
    expect(c.route.miles).toBeGreaterThan(500);
    expect(c.stops[1].eta).toBeTruthy(); // the truck has a position: ETAs per stop
    // The two Dallas pickups (l3, l1) are one point: 5 points, 4 legs, one routing call each.
    expect(f).toHaveBeenCalledTimes(4);
    const row = await prisma.consolidation.findUnique({ where: { id: c.id } });
    expect(row.routeComputedAt).not.toBeNull();
    expect(parseStops(row.stops)).toHaveLength(6);
    expect(passesThrough(row.routeGeometry, [P.dallas, P.fortWorth, P.okc, P.littleRock, P.memphis])).toBe(true);
    const loads = await prisma.load.findMany({ where: { id: { in: [l1.id, l2.id, l3.id] } } });
    expect(loads.every((l) => l.consolidationId === c.id && l.carrierId === truck.id)).toBe(true);
    const notes = await prisma.loadEvent.findMany({ where: { loadId: l3.id, type: 'note' } });
    expect(notes.map((n) => n.note)).toContain('Added to consolidated trip "East run" (stops 1 and 4 of 6)');
  });

  it('validates what can be grouped: 2 to 6 loads, own loads, one truck, open loads, one active trip at a time', async () => {
    const a = await makeLoad(A, { from: P.dallas, to: P.houston, carrierId: truck2.id });
    const b = await makeLoad(A, { from: P.fortWorth, to: P.houston, carrierId: truck2.id });
    const other = await makeLoad(A, { from: P.dallas, to: P.okc, carrierId: truck.id });
    const done = await makeLoad(A, { from: P.dallas, to: P.okc, carrierId: truck2.id, status: 'delivered' });
    const foreign = await makeLoad(B, { from: P.dallas, to: P.okc, carrierId: truckB.id });
    const post = (body) => A.agent.post('/api/consolidations').send(body);
    expect((await post({ carrierId: truck2.id, loadIds: [a.id] })).status).toBe(400);
    expect((await post({ carrierId: truck2.id, loadIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).status).toBe(400);
    expect((await post({ carrierId: truck2.id, loadIds: [a.id, a.id] })).status).toBe(400);
    expect((await post({ carrierId: truck2.id, loadIds: [a.id, foreign.id] })).status).toBe(404);
    expect((await post({ carrierId: truckB.id, loadIds: [a.id, b.id] })).status).toBe(404);
    const otherTruck = await post({ carrierId: truck2.id, loadIds: [a.id, other.id] });
    expect(otherTruck.status).toBe(400);
    expect(otherTruck.body.code).toBe('OTHER_TRUCK');
    expect((await post({ carrierId: truck2.id, loadIds: [a.id, done.id] })).body.code).toBe('LOAD_CLOSED');
    const bad = await post({ carrierId: truck2.id, loadIds: [a.id, b.id], stops: [{ loadId: a.id, kind: 'delivery' }, { loadId: a.id, kind: 'pickup' }, { loadId: b.id, kind: 'pickup' }, { loadId: b.id, kind: 'delivery' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('BAD_STOPS');
    // Nothing was grouped by the failed attempts.
    expect((await prisma.load.findUnique({ where: { id: a.id } })).consolidationId).toBeNull();
    const first = await post({ carrierId: truck2.id, loadIds: [a.id, b.id] });
    expect(first.status).toBe(201);
    const c = await makeLoad(A, { from: P.dallas, to: P.memphis, carrierId: truck2.id });
    const again = await post({ carrierId: truck2.id, loadIds: [b.id, c.id] });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('IN_CONSOLIDATION');
    await A.agent.delete(`/api/consolidations/${first.body.consolidation.id}`).expect(200);
  });

  it('reorders stops only as a permutation with each pickup before its delivery, and routes the new order', async () => {
    stubOsrm();
    const a = await makeLoad(A, { from: P.dallas, to: P.memphis, carrierId: truck2.id, pickup: '2026-11-12T08:00Z', delivery: '2026-11-13T08:00Z' });
    const b = await makeLoad(A, { from: P.fortWorth, to: P.littleRock, carrierId: truck2.id, pickup: '2026-11-12T09:00Z', delivery: '2026-11-13T07:00Z' });
    const c = (await A.agent.post('/api/consolidations').send({ carrierId: truck2.id, loadIds: [a.id, b.id] })).body.consolidation;
    const patch = (stops) => A.agent.patch(`/api/consolidations/${c.id}`).send({ stops });
    const S = (id, kind) => ({ loadId: id, kind });
    const early = await patch([S(a.id, 'pickup'), S(b.id, 'delivery'), S(b.id, 'pickup'), S(a.id, 'delivery')]);
    expect(early.status).toBe(400);
    expect(early.body.code).toBe('BAD_STOPS');
    expect((await patch([S(a.id, 'pickup'), S(b.id, 'pickup'), S(a.id, 'delivery')])).status).toBe(400);
    expect((await patch([S(a.id, 'pickup'), S(b.id, 'pickup'), S(a.id, 'delivery'), S(b.id, 'delivery'), S(b.id, 'delivery')])).status).toBe(400);
    const order = [S(b.id, 'pickup'), S(a.id, 'pickup'), S(a.id, 'delivery'), S(b.id, 'delivery')];
    const res = await patch(order);
    expect(res.status).toBe(200);
    expect(res.body.consolidation.stops.map((s) => `${s.loadId}:${s.kind}`)).toEqual(order.map((s) => `${s.loadId}:${s.kind}`));
    expect(res.body.consolidation.route).toMatchObject({ current: true, estimate: false });
    const row = await prisma.consolidation.findUnique({ where: { id: c.id } });
    expect(passesThrough(row.routeGeometry, [P.fortWorth, P.dallas, P.memphis, P.littleRock])).toBe(true);
    expect((await A.agent.patch(`/api/consolidations/${c.id}`).send({ name: 'Renamed' })).body.consolidation.title).toBe('Renamed');
    await A.agent.delete(`/api/consolidations/${c.id}`).expect(200);
  });

  it('stores a straight-line estimate when the router fails, and a road route on the next try', async () => {
    stubOsrm({ fail: true });
    const a = await makeLoad(A, { from: P.dallas, to: P.memphis, carrierId: truck2.id });
    const b = await makeLoad(A, { from: P.fortWorth, to: P.okc, carrierId: truck2.id });
    const res = await A.agent.post('/api/consolidations').send({ carrierId: truck2.id, loadIds: [a.id, b.id] });
    expect(res.status).toBe(201);
    const c = res.body.consolidation;
    expect(c.route).toMatchObject({ estimate: true, current: true });
    expect(c.route.miles).toBeGreaterThan(300);
    const row = await prisma.consolidation.findUnique({ where: { id: c.id } });
    expect(row.routeComputedAt).toBeNull();
    // Straight lines: one point per stop.
    expect(decodePolyline(row.routeGeometry)).toHaveLength(4);
    vi.unstubAllGlobals();
    clearLiveCache();
    stubOsrm();
    const { refreshConsolidationRoute } = await import('../src/services/fleet/consolidation.js');
    await refreshConsolidationRoute(c.id);
    const after = await A.agent.get(`/api/consolidations/${c.id}`);
    expect(after.body.consolidation.route).toMatchObject({ estimate: false, current: true });
    await A.agent.delete(`/api/consolidations/${c.id}`).expect(200);
  });

  it('keeps the trip status in step with its loads, holds the truck until the last delivery, and drops canceled loads', async () => {
    stubOsrm();
    const t = (await A.agent.post('/api/carriers').send({ companyName: 'Status Sync Lines', state: 'TX', phone: '2145550104' })).body.carrier;
    const a = await makeLoad(A, { from: P.dallas, to: P.memphis, carrierId: t.id, pickup: '2026-11-12T08:00Z', delivery: '2026-11-13T08:00Z' });
    const b = await makeLoad(A, { from: P.fortWorth, to: P.littleRock, carrierId: t.id, pickup: '2026-11-12T09:00Z', delivery: '2026-11-13T07:00Z' });
    const x = await makeLoad(A, { from: P.dallas, to: P.okc, carrierId: t.id, pickup: '2026-11-12T10:00Z', delivery: '2026-11-13T10:00Z' });
    const c = (await A.agent.post('/api/consolidations').send({ carrierId: t.id, loadIds: [a.id, b.id, x.id] })).body.consolidation;
    const status = async () => (await prisma.consolidation.findUnique({ where: { id: c.id } })).status;
    expect(await status()).toBe('planned');
    // Fleet board and Loads page both sync.
    expect((await A.agent.post(`/api/fleet/trips/${a.id}/status`).send({ status: 'in_transit' })).status).toBe(200);
    expect(await status()).toBe('in_transit');
    expect((await A.agent.post(`/api/loads/${b.id}/status`).send({ status: 'in_transit' })).status).toBe(200);
    // Canceled: the load leaves the trip with a timeline note; the trip goes on with 2 loads.
    expect((await A.agent.post(`/api/loads/${x.id}/status`).send({ status: 'canceled' })).status).toBe(200);
    expect((await prisma.load.findUnique({ where: { id: x.id } })).consolidationId).toBeNull();
    expect(parseStops((await prisma.consolidation.findUnique({ where: { id: c.id } })).stops).map((s) => s.loadId)).not.toContain(x.id);
    const left = await prisma.loadEvent.findMany({ where: { loadId: x.id, type: 'note' } });
    expect(left.some((e) => e.note.includes('the load was canceled'))).toBe(true);
    // First delivery: the truck moves there but stays busy (another load is still on board).
    const first = await A.agent.post(`/api/fleet/trips/${b.id}/status`).send({ status: 'delivered' });
    expect(first.body.truck).toMatchObject({ truckStatus: 'loaded', location: { city: 'Little Rock' } });
    expect(await status()).toBe('in_transit');
    const last = await A.agent.post(`/api/fleet/trips/${a.id}/status`).send({ status: 'delivered' });
    expect(last.body.truck).toMatchObject({ truckStatus: 'available', location: { city: 'Memphis' } });
    expect(await status()).toBe('delivered');
    // Invoiced and paid loads still count as delivered.
    await A.agent.post(`/api/loads/${a.id}/status`).send({ status: 'invoiced' }).expect(200);
    expect(await status()).toBe('delivered');
    const list = await A.agent.get('/api/consolidations?status=all');
    expect(list.body.items.find((i) => i.id === c.id)).toMatchObject({ status: 'delivered' });
  });

  it('ends the trip when fewer than 2 loads are left, and moves every load with one status call', async () => {
    stubOsrm();
    const t = (await A.agent.post('/api/carriers').send({ companyName: 'Two Stop Express', state: 'TX', phone: '2145550105' })).body.carrier;
    const a = await makeLoad(A, { from: P.dallas, to: P.memphis, carrierId: t.id });
    const b = await makeLoad(A, { from: P.fortWorth, to: P.littleRock, carrierId: t.id });
    const c = (await A.agent.post('/api/consolidations').send({ carrierId: t.id, loadIds: [a.id, b.id] })).body.consolidation;
    const moved = await A.agent.post(`/api/consolidations/${c.id}/status`).send({ status: 'in_transit' });
    expect(moved.status).toBe(200);
    expect(moved.body.changed.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(moved.body.consolidation.status).toBe('in_transit');
    expect((await prisma.load.findMany({ where: { id: { in: [a.id, b.id] } } })).every((l) => l.status === 'in_transit')).toBe(true);
    // A canceled load leaves one load: the trip ends and that load is a plain trip again.
    await A.agent.post(`/api/fleet/trips/${a.id}/status`).send({ status: 'canceled' }).expect(200);
    expect((await prisma.consolidation.findUnique({ where: { id: c.id } })).status).toBe('canceled');
    expect((await prisma.load.findUnique({ where: { id: b.id } })).consolidationId).toBeNull();
    expect((await prisma.load.findUnique({ where: { id: b.id } })).status).toBe('in_transit');
    expect((await A.agent.get(`/api/consolidations?carrierId=${t.id}`)).body.items).toHaveLength(0);
  });

  it('adds and removes loads, and ungroups without touching the loads', async () => {
    stubOsrm();
    const t = (await A.agent.post('/api/carriers').send({ companyName: 'Add Remove Freight', state: 'TX', phone: '2145550106' })).body.carrier;
    const a = await makeLoad(A, { from: P.dallas, to: P.memphis, carrierId: t.id, pickup: '2026-11-12T08:00Z', delivery: '2026-11-13T08:00Z' });
    const b = await makeLoad(A, { from: P.fortWorth, to: P.littleRock, carrierId: t.id, pickup: '2026-11-12T12:00Z', delivery: '2026-11-13T07:00Z' });
    const x = await makeLoad(A, { from: P.dallas, to: P.okc, pickup: '2026-11-12T10:00Z', delivery: '2026-11-12T18:00Z', status: 'planned' });
    const c = (await A.agent.post('/api/consolidations').send({ carrierId: t.id, loadIds: [a.id, b.id] })).body.consolidation;
    const cand = await A.agent.get(`/api/consolidations/candidates?carrierId=${t.id}`);
    expect(cand.body.loads.find((l) => l.id === a.id).consolidation.id).toBe(c.id);
    expect(cand.body.unassigned.map((l) => l.id)).toContain(x.id);
    const add = await A.agent.post(`/api/consolidations/${c.id}/loads`).send({ action: 'add', loadId: x.id });
    expect(add.status).toBe(200);
    expect(add.body.consolidation.stops.map((s) => `${s.loadId}:${s.kind}`)).toEqual([
      `${a.id}:pickup`, `${x.id}:pickup`, `${b.id}:pickup`, `${x.id}:delivery`, `${b.id}:delivery`, `${a.id}:delivery`,
    ]);
    expect((await prisma.load.findUnique({ where: { id: x.id } })).carrierId).toBe(t.id);
    const rm = await A.agent.post(`/api/consolidations/${c.id}/loads`).send({ action: 'remove', loadId: b.id });
    expect(rm.body.consolidation.loadIds.sort()).toEqual([a.id, x.id].sort());
    expect((await prisma.load.findUnique({ where: { id: b.id } })).consolidationId).toBeNull();
    expect((await prisma.loadEvent.findMany({ where: { loadId: b.id, type: 'note' } })).some((e) => e.note.startsWith('Removed from consolidated trip'))).toBe(true);
    await A.agent.delete(`/api/consolidations/${c.id}`).expect(200);
    expect(await prisma.consolidation.findUnique({ where: { id: c.id } })).toBeNull();
    const after = await prisma.load.findMany({ where: { id: { in: [a.id, x.id] } } });
    expect(after.every((l) => l.consolidationId === null && l.status !== 'canceled')).toBe(true);
  });

  it('a deleted load leaves its trip', async () => {
    stubOsrm();
    const t = (await A.agent.post('/api/carriers').send({ companyName: 'Delete Sync Co', state: 'TX', phone: '2145550107' })).body.carrier;
    const ids = [];
    for (const [from, to] of [[P.dallas, P.memphis], [P.fortWorth, P.littleRock], [P.dallas, P.okc]]) ids.push((await makeLoad(A, { from, to, carrierId: t.id })).id);
    const c = (await A.agent.post('/api/consolidations').send({ carrierId: t.id, loadIds: ids })).body.consolidation;
    await A.agent.delete(`/api/fleet/trips/${ids[2]}`).expect(200);
    const row = await prisma.consolidation.findUnique({ where: { id: c.id } });
    expect(parseStops(row.stops).map((s) => s.loadId)).not.toContain(ids[2]);
    // A load deleted on a path that does not sync is healed on the next read.
    await prisma.load.delete({ where: { id: ids[1] } });
    const res = await A.agent.get(`/api/consolidations/${c.id}`);
    expect(res.body.consolidation.status).toBe('canceled');
    expect((await prisma.load.findUnique({ where: { id: ids[0] } })).consolidationId).toBeNull();
  });

  it('keeps other dispatchers out (404)', async () => {
    stubOsrm();
    const a = await makeLoad(A, { from: P.dallas, to: P.memphis, carrierId: truck2.id });
    const b = await makeLoad(A, { from: P.fortWorth, to: P.littleRock, carrierId: truck2.id });
    const c = (await A.agent.post('/api/consolidations').send({ carrierId: truck2.id, loadIds: [a.id, b.id] })).body.consolidation;
    expect((await B.agent.get(`/api/consolidations/${c.id}`)).status).toBe(404);
    expect((await B.agent.patch(`/api/consolidations/${c.id}`).send({ name: 'x' })).status).toBe(404);
    expect((await B.agent.post(`/api/consolidations/${c.id}/status`).send({ status: 'canceled' })).status).toBe(404);
    expect((await B.agent.post(`/api/consolidations/${c.id}/loads`).send({ action: 'remove', loadId: a.id })).status).toBe(404);
    expect((await B.agent.delete(`/api/consolidations/${c.id}`)).status).toBe(404);
    expect((await B.agent.get(`/api/consolidations?carrierId=${truck2.id}`)).status).toBe(404);
    expect((await B.agent.get(`/api/consolidations/candidates?carrierId=${truck2.id}`)).status).toBe(404);
    expect((await B.agent.get('/api/consolidations?team=1')).body.items.map((i) => i.id)).not.toContain(c.id);
    const mine = await A.agent.get('/api/consolidations?geometry=1');
    const item = mine.body.items.find((i) => i.id === c.id);
    expect(item.route.geometry).toBeTruthy();
    expect(item.stops[0]).toMatchObject({ n: 1, kind: 'pickup' });
    await A.agent.delete(`/api/consolidations/${c.id}`).expect(200);
  });
});
