import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app, registerUser, prisma } from './helpers.js';
import { clearLiveCache } from '../src/services/market/live.js';
import { clearDeadheadCache, ensureLoadRoute, routeQueueIdle, withRouteGeometry, ROUTE_INCLUDE } from '../src/services/fleet/route.js';
import { routeIsCurrent, routeMeta } from '../src/services/fleet/index.js';
import { measuredRoute } from '../src/services/fleet/progress.js';
import { encodePolyline, decodePolyline, segmentMiles } from '../src/services/fleet/polyline.js';
import { clearPaceCache, plansFor } from '../src/services/fleet/insights.js';
import { clearTodayCache } from '../src/services/fleet/today.js';
import { runCheckCalls } from '../src/jobs/extra/checkcalls.js';
import { backfillFleetFlags, refreshRoutes } from '../src/jobs/extra/fleet-backfill.js';

const pub = () => request(app);
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

function densify(points, stepMiles = 1.5) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const n = Math.max(1, Math.round(segmentMiles(a, b) / stepMiles));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}
// Dallas -> Texarkana -> Memphis and Dallas -> Nashville (OSRM answers with an encoded polyline).
const DAL_MEM = densify([[-96.797, 32.777], [-94.048, 33.425], [-90.049, 35.15]]);
const DAL_NSH = densify([[-96.797, 32.777], [-90.049, 35.15], [-86.781, 36.163]]);
const osrm = (pts, miles, minutes) => ({ code: 'Ok', routes: [{ distance: miles * 1609.344, duration: minutes * 60, geometry: encodePolyline(pts) }] });

function stubOsrm(handler) {
  const fn = vi.fn(async (url) => {
    const u = String(url);
    if (!u.includes('router.project-osrm.org')) throw new Error(`unexpected fetch ${u}`);
    return handler(u);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const byDest = (u) => (u.includes('-86.781') ? ok(osrm(DAL_NSH, 665, 600)) : ok(osrm(DAL_MEM, 452, 410)));

/** Run the route backfill job until it has reached the load (other suites' loads share the test database). */
async function routesUntil(id, done) {
  for (let i = 0; i < 10; i++) {
    await refreshRoutes(new Date(), { maxLoads: 50 });
    const row = await prisma.load.findUnique({ where: { id } });
    if (done(row)) return row;
  }
  return prisma.load.findUnique({ where: { id } });
}

describe('road routes on trips', () => {
  let A; let B; let truck; let trip;
  beforeAll(async () => {
    A = await registerUser({ name: 'Rita Moss' });
    B = await registerUser();
    truck = (await A.agent.post('/api/carriers').send({ companyName: 'Red River Freight', state: 'TX', phone: '2145550177' })).body.carrier;
    await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ truckStatus: 'available', location: { city: 'Dallas', state: 'TX' } });
  });
  beforeEach(() => { clearLiveCache(); clearDeadheadCache(); clearPaceCache(); clearTodayCache(); });
  afterEach(() => vi.unstubAllGlobals());

  it('planning a trip stores the road route with exact ends and road miles', async () => {
    const f = stubOsrm(byDest);
    const res = await A.agent.post('/api/fleet/trips').send({ carrierId: truck.id, origin: { city: 'Dallas', state: 'TX' }, dest: { city: 'Memphis', state: 'TN' }, rateCents: 210000, referenceNumber: 'RR-100' });
    expect(res.status).toBe(201);
    trip = res.body.trip;
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0][0])).toContain('overview=full');
    expect(trip.route).toMatchObject({ source: 'osrm', estimate: false, current: true, miles: 452, minutes: 410 });
    expect(trip.loadedMiles).toBe(452);
    const row = await prisma.load.findUnique({ where: { id: trip.id }, include: { route: true } });
    // The shape lives in LoadRoute; the deprecated column on Load stays empty.
    expect(row.routeGeometry).toBeNull();
    expect(row).toMatchObject({ routeSource: 'osrm', routeMiles: 452, routeMinutes: 410 });
    const pts = decodePolyline(row.route.geometry);
    expect(pts[0][1]).toBeCloseTo(row.originLat, 5);
    expect(pts.at(-1)[0]).toBeCloseTo(row.destLng, 5);
    expect(pts.length).toBeGreaterThan(2);
    expect(pts.length).toBeLessThan(DAL_MEM.length);
  });

  it('serves route geometry only to the owner', async () => {
    const mine = await A.agent.get(`/api/fleet/routes?ids=${trip.id}`);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({ id: trip.id, source: 'osrm', estimate: false, pending: false });
    expect(decodePolyline(mine.body.items[0].geometry).length).toBeGreaterThan(2);
    expect((await B.agent.get(`/api/fleet/routes?ids=${trip.id}`)).body.items).toHaveLength(0);
    expect((await pub().get(`/api/fleet/routes?ids=${trip.id}`)).status).toBe(401);
  });

  it('moving the delivery computes the route again', async () => {
    const f = stubOsrm(byDest);
    const res = await A.agent.patch(`/api/fleet/trips/${trip.id}`).send({ dest: { city: 'Nashville', state: 'TN' } });
    expect(res.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
    expect(res.body.trip.route).toMatchObject({ source: 'osrm', miles: 665, current: true });
    // and back, for the rest of the tests
    stubOsrm(byDest);
    expect((await A.agent.patch(`/api/fleet/trips/${trip.id}`).send({ dest: { city: 'Memphis', state: 'TN' } })).body.trip.route.miles).toBe(452);
  });

  it('a router failure gives a marked estimate and never replaces a road route', async () => {
    stubOsrm(() => { throw new TypeError('fetch failed'); });
    const res = await A.agent.post('/api/fleet/trips').send({ carrierId: truck.id, origin: { city: 'Dallas', state: 'TX' }, dest: { city: 'Atlanta', state: 'GA' }, rateCents: 300000 });
    expect(res.body.trip.route).toMatchObject({ source: 'estimate', estimate: true, current: true });
    expect(decodePolyline((await prisma.loadRoute.findUnique({ where: { loadId: res.body.trip.id } })).geometry)).toHaveLength(2);
    clearLiveCache();
    // A row read without its shape: ensureLoadRoute looks the stored route up itself before deciding.
    const row = await prisma.load.findUnique({ where: { id: trip.id } });
    const before = (await prisma.loadRoute.findUnique({ where: { loadId: trip.id } })).geometry;
    expect(await ensureLoadRoute(row, { force: true })).toBeNull();
    expect((await prisma.load.findUnique({ where: { id: trip.id } })).routeSource).toBe('osrm');
    expect((await prisma.loadRoute.findUnique({ where: { loadId: trip.id } })).geometry).toBe(before);
    await A.agent.delete(`/api/fleet/trips/${res.body.trip.id}`).expect(200);
  });

  it('deadhead from the truck to the pickup is routed and cached per truck', async () => {
    await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ location: { city: 'Fort Worth', state: 'TX' } });
    const f = stubOsrm(() => ok(osrm(densify([[-97.331, 32.755], [-96.797, 32.777]]), 32, 38)));
    const res = await A.agent.get(`/api/fleet/deadhead?pairs=${truck.id}:${trip.id}`);
    expect(res.body.items[0]).toMatchObject({ carrierId: truck.id, loadId: trip.id, source: 'osrm', miles: 32, estimate: false });
    await A.agent.get(`/api/fleet/deadhead?pairs=${truck.id}:${trip.id}`);
    expect(f).toHaveBeenCalledTimes(1);
    expect((await B.agent.get(`/api/fleet/deadhead?pairs=${truck.id}:${trip.id}`)).body.items).toHaveLength(0);
  });

  it('the fleet list answers 304 while nothing changed', async () => {
    const first = await A.agent.get('/api/fleet');
    const etag = first.headers.etag;
    expect(etag).toMatch(/^W\/"fleet-/);
    expect(first.body.trucks.find((t) => t.id === truck.id).trips[0].route.current).toBe(true);
    expect((await A.agent.get('/api/fleet').set('If-None-Match', etag)).status).toBe(304);
    await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ location: { city: 'Dallas', state: 'TX' } });
    expect((await A.agent.get('/api/fleet').set('If-None-Match', etag)).status).toBe(200);
    // another user never gets this user's version
    expect((await B.agent.get('/api/fleet').set('If-None-Match', etag)).status).toBe(200);
  });

  it('a customer signed on another page joins the map by itself', async () => {
    const c = (await A.agent.post('/api/carriers').send({ companyName: 'Signed Elsewhere LLC', state: 'OK' })).body.carrier;
    expect((await A.agent.get('/api/fleet')).body.trucks.map((t) => t.id)).not.toContain(c.id);
    await prisma.customer.create({ data: { carrierId: c.id, ownerId: A.user.id } });
    const list = (await A.agent.get('/api/fleet')).body.trucks;
    expect(list.find((t) => t.id === c.id)?.isCustomer).toBe(true);
    expect((await prisma.carrier.findUnique({ where: { id: c.id } })).isFleet).toBe(true);
  });

  it('nearby search filters located trucks inside the radius in SQL', async () => {
    const far = (await A.agent.post('/api/carriers').send({ companyName: 'Far Away Lines', state: 'WA' })).body.carrier;
    await A.agent.patch(`/api/fleet/carriers/${far.id}`).send({ truckStatus: 'available', location: { city: 'Seattle', state: 'WA' } });
    const res = await A.agent.get('/api/fleet/near?city=Dallas&state=TX&radius=100');
    expect(res.body.items.map((t) => t.id)).toContain(truck.id);
    expect(res.body.items.map((t) => t.id)).not.toContain(far.id);
    expect(res.body.items[0]).toMatchObject({ companyName: 'Red River Freight', location: { city: 'Dallas', state: 'TX' } });
  });

  it('plan: progress on the road route, drive ETA and legal ETA from the hours left', async () => {
    await A.agent.post(`/api/fleet/trips/${trip.id}/status`).send({ status: 'booked' });
    const transit = await A.agent.post(`/api/fleet/trips/${trip.id}/status`).send({ status: 'in_transit' });
    expect(transit.body.truck.truckStatus).toBe('loaded');
    const mid = DAL_MEM[Math.floor(DAL_MEM.length / 2)];
    await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ location: { city: 'Texarkana', state: 'TX', lat: mid[1], lng: mid[0] } });
    expect((await A.agent.post(`/api/fleet/trips/${trip.id}/hos`).send({ driveLeftMin: 60 })).status).toBe(201);
    expect((await A.agent.post(`/api/fleet/trips/${trip.id}/hos`).send({})).status).toBe(400);
    expect((await B.agent.post(`/api/fleet/trips/${trip.id}/hos`).send({ driveLeftMin: 60 })).status).toBe(404);
    const res = await A.agent.get(`/api/fleet/carriers/${truck.id}/plan`);
    expect(res.status).toBe(200);
    const t0 = res.body.plan.trips[0];
    expect(t0.id).toBe(trip.id);
    expect(t0.progress.pct).toBeGreaterThan(20);
    expect(t0.progress.pct).toBeLessThan(80);
    expect(t0.progress.offRoute).toBe(false);
    const stop = res.body.plan.stops[0];
    expect(stop).toMatchObject({ kind: 'delivery', city: 'Memphis' });
    expect(new Date(stop.legalEta) - new Date(stop.eta)).toBeGreaterThanOrEqual(10 * 3600_000);
    expect(res.body.plan.hos.assumed).toBe(false);
    expect(res.body.hosReport.input).toMatchObject({ driveLeftMin: 60 });
    expect((await B.agent.get(`/api/fleet/carriers/${truck.id}/plan`)).status).toBe(404);
    const listed = (await A.agent.get('/api/fleet')).body.trucks.find((t) => t.id === truck.id);
    expect(listed.plan.progress.remainingMiles).toBeGreaterThan(50);
    expect(listed.plan.nextStop).toMatchObject({ kind: 'delivery', city: 'Memphis' });
  });

  it('check calls: logged on the load timeline, isolated, validated; per-user interval', async () => {
    const res = await A.agent.post(`/api/fleet/trips/${trip.id}/check-call`).send({ note: 'Rolling past Hope, AR', hos: { driveLeftMin: 300, shiftLeftMin: 420 }, location: { city: 'Hope', state: 'AR' } });
    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({ type: 'check_call', source: 'dispatcher', hos: { driveLeftMin: 300 } });
    expect((await prisma.load.findUnique({ where: { id: trip.id } })).lastCheckCallAt).toBeTruthy();
    expect((await prisma.carrier.findUnique({ where: { id: truck.id } })).locationCity).toBe('Hope');
    expect((await B.agent.post(`/api/fleet/trips/${trip.id}/check-call`).send({})).status).toBe(404);
    expect((await A.agent.post(`/api/fleet/trips/${trip.id}/check-call`).send({ hos: { driveLeftMin: 9999 } })).status).toBe(400);
    const events = (await A.agent.get(`/api/fleet/trips/${trip.id}/events`)).body.items;
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['check_call', 'status', 'note']));
    expect((await B.agent.get(`/api/fleet/trips/${trip.id}/events`)).status).toBe(404);
    expect((await A.agent.get('/api/fleet/settings/check-calls')).body).toMatchObject({ hours: 4, enabled: true });
    expect((await A.agent.put('/api/fleet/settings/check-calls').send({ hours: 5, enabled: true })).status).toBe(400);
    expect((await A.agent.put('/api/fleet/settings/check-calls').send({ hours: 2, enabled: true })).body).toMatchObject({ hours: 2 });
    expect((await B.agent.get('/api/fleet/settings/check-calls')).body.hours).toBe(4);
  });
});

describe('broker tracking links', () => {
  let A; let B; let truck; let load; let coarse; let exact;
  beforeAll(async () => {
    A = await registerUser({ name: 'Omar Haddad' });
    B = await registerUser();
    truck = (await A.agent.post('/api/carriers').send({ companyName: 'Blue Ox Transport', state: 'TX', phone: '9725550142', email: 'ops@blueox.test' })).body.carrier;
    await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ truckStatus: 'available', location: { city: 'Dallas', state: 'TX' } });
    const broker = (await A.agent.post('/api/brokers').send({ companyName: 'Acme Logistics', email: 'track@acme.test' })).body.broker;
    load = (await A.agent.post('/api/fleet/trips').send({ carrierId: truck.id, origin: { city: 'Dallas', state: 'TX' }, dest: { city: 'Memphis', state: 'TN' }, rateCents: 222200, referenceNumber: 'ACME-778', brokerId: broker.id })).body.trip;
    await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ driverName: 'Marco Diaz', driverPhone: '2145550999', loadId: load.id, pin: false });
  });

  it('creates a link once: city-level by default, labelled with the broker', async () => {
    const res = await A.agent.post(`/api/fleet/trips/${load.id}/tracking-links`).send({});
    expect(res.status).toBe(201);
    expect(res.body.link).toMatch(/\/t\/c[A-Za-z0-9_-]{20,}$/);
    expect(res.body.share).toMatchObject({ label: 'Acme Logistics', status: 'active', exact: false, views: 0 });
    expect(res.body.message.toEmail).toBe('track@acme.test');
    coarse = res.body.link.split('/t/')[1];
    const row = await prisma.loadShare.findFirst({ where: { loadId: load.id } });
    expect(JSON.stringify(row)).not.toContain(coarse);
    exact = (await A.agent.post(`/api/fleet/trips/${load.id}/tracking-links`).send({ exact: true, days: 3, label: 'Acme dock' })).body.link.split('/t/')[1];
    expect(exact.startsWith('e')).toBe(true);
    expect((await A.agent.post(`/api/fleet/trips/${load.id}/tracking-links`).send({ days: 5 })).status).toBe(400);
    expect((await B.agent.post(`/api/fleet/trips/${load.id}/tracking-links`).send({})).status).toBe(404);
    const list = (await A.agent.get(`/api/fleet/trips/${load.id}/tracking-links`)).body.items;
    expect(list.map((s) => s.exact).sort()).toEqual([false, true]);
    expect((await B.agent.get(`/api/fleet/trips/${load.id}/tracking-links`)).status).toBe(404);
  });

  it('the public page shows the load, never the driver or CRM data, and counts views', async () => {
    await A.agent.post(`/api/fleet/trips/${load.id}/status`).send({ status: 'booked' });
    await A.agent.post(`/api/fleet/trips/${load.id}/status`).send({ status: 'in_transit' });
    const res = await pub().get(`/api/public/load-track/${coarse}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(res.body).toMatchObject({ reference: 'ACME-778', status: 'in_transit', statusLabel: 'In transit', pickup: { city: 'Dallas', state: 'TX' }, delivery: { city: 'Memphis', state: 'TN' }, pod: { received: false }, exact: false });
    expect(res.body.location.text).toMatch(/Dallas, TX/);
    expect(res.body.location.lat).toBeUndefined();
    expect(res.body.delivery.eta).toBeTruthy();
    // City level: the ETA is rounded to 15 minutes, so the position cannot be worked back from it.
    expect(new Date(res.body.delivery.eta).getTime() % (15 * 60_000)).toBe(0);
    const text = JSON.stringify(res.body);
    for (const secret of ['Marco', '2145550999', '9725550142', 'ops@blueox', '222200', 'Blue Ox', 'Omar', A.email]) expect(text).not.toContain(secret);
    const again = await pub().get(`/api/public/load-track/${coarse}`).set('If-None-Match', res.headers.etag);
    expect(again.status).toBe(304);
    const share = await prisma.loadShare.findFirst({ where: { loadId: load.id, label: 'Acme Logistics' } });
    expect(share.views).toBe(1);
    expect(share.lastViewedAt).toBeTruthy();
    const ex = await pub().get(`/api/public/load-track/${exact}`);
    expect(ex.body.location.lat).toBeCloseTo(32.777, 2);
  });

  it('revoked, expired and unknown links stop working', async () => {
    const share = await prisma.loadShare.findFirst({ where: { loadId: load.id, label: 'Acme Logistics' } });
    expect((await B.agent.post(`/api/fleet/tracking-links/${share.id}/revoke`)).status).toBe(404);
    expect((await A.agent.post(`/api/fleet/tracking-links/${share.id}/revoke`)).body.share.status).toBe('revoked');
    expect((await pub().get(`/api/public/load-track/${coarse}`)).status).toBe(410);
    const other = await prisma.loadShare.findFirst({ where: { loadId: load.id, label: 'Acme dock' } });
    await prisma.loadShare.update({ where: { id: other.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const { invalidateLoadTrack } = await import('../src/services/fleet/loadShare.js');
    invalidateLoadTrack(other.tokenHash);
    expect((await pub().get(`/api/public/load-track/${exact}`)).status).toBe(410);
    expect((await pub().get('/api/public/load-track/cNotARealTokenAtAll1234567890')).status).toBe(404);
    expect((await pub().get('/api/public/load-track/bad')).status).toBe(404);
  });
});

describe('Today board and check-call reminders', () => {
  let A; let B; let truck; let idle; let transit; let soon;
  beforeAll(async () => {
    A = await registerUser({ name: 'Tess Grant' });
    B = await registerUser();
    truck = (await A.agent.post('/api/carriers').send({ companyName: 'Prairie Wind Haul', state: 'KS', phone: '3165550111' })).body.carrier;
    idle = (await A.agent.post('/api/carriers').send({ companyName: 'Idle Wheels Inc', state: 'OK', phone: '4055550111' })).body.carrier;
    await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ truckStatus: 'available', location: { city: 'Wichita', state: 'KS' } });
    await A.agent.patch(`/api/fleet/carriers/${idle.id}`).send({ truckStatus: 'available', location: { city: 'Tulsa', state: 'OK' } });
    transit = (await A.agent.post('/api/fleet/trips').send({ carrierId: truck.id, origin: { city: 'Wichita', state: 'KS' }, dest: { city: 'Denver', state: 'CO' }, rateCents: 150000 })).body.trip;
    await A.agent.post(`/api/fleet/trips/${transit.id}/status`).send({ status: 'booked' });
    await A.agent.post(`/api/fleet/trips/${transit.id}/status`).send({ status: 'in_transit' });
    // No contact for 5 hours.
    await prisma.loadEvent.updateMany({ where: { loadId: transit.id }, data: { at: new Date(Date.now() - 5 * 3600_000) } });
    // A pickup due in 30 minutes for a truck far away: at risk or late.
    soon = (await A.agent.post('/api/fleet/trips').send({ carrierId: idle.id, origin: { city: 'Amarillo', state: 'TX' }, dest: { city: 'Albuquerque', state: 'NM' }, rateCents: 90000 })).body.trip;
    await prisma.load.update({ where: { id: soon.id }, data: { pickupWindowStart: new Date(Date.now() + 15 * 60_000), pickupWindowEnd: new Date(Date.now() + 30 * 60_000) } });
    const delivered = (await A.agent.post('/api/fleet/trips').send({ carrierId: idle.id, origin: { city: 'Tulsa', state: 'OK' }, dest: { city: 'Little Rock', state: 'AR' }, rateCents: 80000 })).body.trip;
    for (const s of ['booked', 'in_transit', 'delivered']) await A.agent.post(`/api/fleet/trips/${delivered.id}/status`).send({ status: s });
    await prisma.invoice.create({ data: { ownerId: A.user.id, number: 1, billToName: 'Slow Pay Brokerage', lines: '[]', amountCents: 120000, status: 'sent', dueAt: new Date(Date.now() - 3 * 86400000) } });
    await prisma.followUp.create({ data: { carrierId: idle.id, userId: A.user.id, dueAt: new Date(Date.now() - 3600_000), title: 'Call about rate sheet' } });
    await prisma.document.create({ data: { ownerId: A.user.id, uploadedById: A.user.id, carrierId: idle.id, type: 'coi', originalName: 'coi.pdf', storedName: `today-${Date.now()}.pdf`, mimeType: 'application/pdf', sizeBytes: 10, expiresAt: new Date(Date.now() + 3 * 86400000) } });
    clearTodayCache();
  });
  // A failed test must not leave its fetch stub for the next one.
  afterEach(() => vi.unstubAllGlobals());

  it('lists what needs action, most urgent first', async () => {
    const res = await A.agent.get('/api/today');
    expect(res.status).toBe(200);
    const by = (section) => res.body.items.filter((i) => i.section === section);
    expect(by('check_calls').map((i) => i.load.id)).toEqual([transit.id]);
    const appt = by('appointments').find((i) => i.load.id === soon.id && i.kind === 'pickup');
    expect(['late', 'at_risk']).toContain(appt.risk);
    expect(appt.carrier).toMatchObject({ id: idle.id, phone: '4055550111' });
    expect(by('missing_pod')).toHaveLength(1);
    expect(by('invoices')[0].invoice.balanceCents).toBe(120000);
    expect(by('follow_ups')[0].title).toBe('Call about rate sheet');
    expect(by('documents').some((i) => i.document?.type === 'coi')).toBe(true);
    expect(res.body.items[0].priority).toBe(0);
    expect(res.body.urgent).toBeGreaterThanOrEqual(3);
    expect((await A.agent.get('/api/today/count')).body.urgent).toBe(res.body.urgent);
    const other = await B.agent.get('/api/today');
    expect(other.body.items).toHaveLength(0);
  });

  it('a tracking link made for the broker is not news from the driver', async () => {
    expect((await A.agent.post(`/api/fleet/trips/${transit.id}/tracking-links`).send({})).status).toBe(201);
    const res = await A.agent.get('/api/today');
    expect(res.body.items.filter((i) => i.section === 'check_calls').map((i) => i.load.id)).toEqual([transit.id]);
  });

  it('logging the check call clears it from the board', async () => {
    await A.agent.post(`/api/fleet/trips/${transit.id}/check-call`).send({ note: 'All good' });
    const res = await A.agent.get('/api/today');
    expect(res.body.items.filter((i) => i.section === 'check_calls')).toHaveLength(0);
  });

  it('the reminder job notifies once per interval, never for fresh loads', async () => {
    await prisma.load.update({ where: { id: transit.id }, data: { lastCheckCallAt: new Date(Date.now() - 6 * 3600_000) } });
    await prisma.loadEvent.updateMany({ where: { loadId: transit.id }, data: { at: new Date(Date.now() - 6 * 3600_000) } });
    await prisma.systemSetting.deleteMany({ where: { key: 'fleet.checkcalls.cursor' } });
    const first = await runCheckCalls(new Date());
    expect(first.notified).toBeGreaterThanOrEqual(1);
    const notes = await prisma.notification.findMany({ where: { userId: A.user.id, type: 'check_call_due' } });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain('Prairie Wind Haul');
    await runCheckCalls(new Date());
    expect(await prisma.notification.count({ where: { userId: A.user.id, type: 'check_call_due' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: B.user.id, type: 'check_call_due' } })).toBe(0);
  });

  it('backfill jobs: fleet flags once, then road routes for loads made elsewhere', async () => {
    const legacy = (await A.agent.post('/api/carriers').send({ companyName: 'Legacy Truck Co', state: 'TX' })).body.carrier;
    await prisma.carrier.update({ where: { id: legacy.id }, data: { truckStatus: 'available', isFleet: false } });
    await prisma.systemSetting.deleteMany({ where: { key: 'fleet.backfill.isFleet' } });
    const r1 = await backfillFleetFlags();
    expect(r1.done).toBe(true);
    expect(r1.updated).toBeGreaterThanOrEqual(1);
    expect((await prisma.carrier.findUnique({ where: { id: legacy.id } })).isFleet).toBe(true);
    expect((await backfillFleetFlags()).skipped).toBe('done');

    // A load saved on the Loads page gets its road route queued right away.
    clearLiveCache();
    stubOsrm(byDest);
    const made = (await A.agent.post('/api/loads').send({ originCity: 'Dallas', originState: 'TX', destCity: 'Memphis', destState: 'TN', rateCents: 100000, loadedMiles: 450, carrierId: legacy.id, status: 'booked' })).body.load;
    expect(made.id).toBeTruthy();
    expect(await routeQueueIdle()).toBe(true);
    expect((await prisma.load.findUnique({ where: { id: made.id } })).routeSource).toBe('osrm');
    expect(await prisma.loadRoute.count({ where: { loadId: made.id } })).toBe(1);
    // One the queue missed (full, or the process restarted before it ran): the backfill job computes it.
    await prisma.loadRoute.deleteMany({ where: { loadId: made.id } });
    await prisma.load.update({ where: { id: made.id }, data: { routeMiles: null, routeMinutes: null, routeSource: null, routeComputedAt: null } });
    clearLiveCache();
    const r2 = await refreshRoutes(new Date(), { maxLoads: 20 });
    expect(r2.computed).toBeGreaterThanOrEqual(1);
    expect((await routesUntil(made.id, (r) => r.routeSource === 'osrm')).routeSource).toBe('osrm');
    expect(decodePolyline((await prisma.loadRoute.findUnique({ where: { loadId: made.id } })).geometry).length).toBeGreaterThan(2);
  });

  it('loads known only by their state get no road route; stale estimates are retried, recent ones wait', async () => {
    // Fontana, CA and Gainesville, GA are not in the built-in city table: only the states' center points are known.
    // The router has no answer while the loads are saved (the Loads page queues their routes at once).
    clearLiveCache();
    stubOsrm(() => { throw new TypeError('fetch failed'); });
    const vague = (await A.agent.post('/api/loads').send({ originCity: 'Fontana', originState: 'CA', destCity: 'Gainesville', destState: 'GA', rateCents: 400000, loadedMiles: 2200, carrierId: truck.id, status: 'booked' })).body.load;
    const typed = (await A.agent.post('/api/loads').send({ originCity: 'Dallas', originState: 'TX', destCity: 'Memphis', destState: 'TN', rateCents: 100000, loadedMiles: 450, carrierId: idle.id, status: 'booked' })).body.load;
    expect(vague?.id && typed?.id).toBeTruthy();
    expect(await routeQueueIdle()).toBe(true);
    // The router had no answer a few minutes ago: the load keeps an estimate until the retry interval has passed.
    clearLiveCache();
    await ensureLoadRoute(await prisma.load.findUnique({ where: { id: typed.id } }), { force: true });
    expect((await prisma.load.findUnique({ where: { id: typed.id } })).routeSource).toBe('estimate');
    const recent = new Date(Date.now() - 5 * 60_000);
    await prisma.load.update({ where: { id: typed.id }, data: { routeComputedAt: recent } });
    vi.unstubAllGlobals();
    clearLiveCache();
    const f = stubOsrm(byDest);
    expect(await routesUntil(vague.id, (r) => r.routeSource === 'none')).toMatchObject({ routeSource: 'none', routeGeometry: null });
    expect(await prisma.loadRoute.count({ where: { loadId: vague.id } })).toBe(0);
    expect(f.mock.calls.some(([u]) => String(u).includes('-119.47,37.18'))).toBe(false);
    const waiting = await prisma.load.findUnique({ where: { id: typed.id } });
    expect(waiting.routeSource).toBe('estimate');
    expect(waiting.routeComputedAt.getTime()).toBe(recent.getTime());
    await prisma.load.update({ where: { id: typed.id }, data: { routeComputedAt: new Date(Date.now() - 2 * 3600_000) } });
    expect((await routesUntil(typed.id, (r) => r.routeSource === 'osrm')).routeSource).toBe('osrm');
    // The map draws the vague load as a plain estimate that is not waiting for a road route.
    expect((await A.agent.get(`/api/fleet/routes?ids=${vague.id}`)).body.items[0]).toMatchObject({ estimate: true, pending: false });
    const listed = (await A.agent.get('/api/fleet')).body.trucks.find((t) => t.id === truck.id).trips.find((t) => t.id === vague.id);
    expect(listed.route).toMatchObject({ current: false, stateOnly: true });
    vi.unstubAllGlobals();
  });
});

describe('stored road routes live in LoadRoute', () => {
  let A; let B; let truck;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    truck = (await A.agent.post('/api/carriers').send({ companyName: 'Shape Freight', state: 'TX', phone: '2145550188' })).body.carrier;
    await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ truckStatus: 'available', location: { city: 'Dallas', state: 'TX' } });
  });
  beforeEach(() => { clearLiveCache(); clearDeadheadCache(); clearPaceCache(); clearTodayCache(); });
  afterEach(() => vi.unstubAllGlobals());

  it('withRouteGeometry attaches shapes in one query and leaves the rows it was given alone', async () => {
    stubOsrm(byDest);
    const t1 = (await A.agent.post('/api/fleet/trips').send({ carrierId: truck.id, origin: { city: 'Dallas', state: 'TX' }, dest: { city: 'Memphis', state: 'TN' }, rateCents: 150000 })).body.trip;
    const t2 = (await A.agent.post('/api/fleet/trips').send({ carrierId: truck.id, origin: { city: 'Dallas', state: 'TX' }, dest: { city: 'Nashville', state: 'TN' }, rateCents: 180000 })).body.trip;
    const never = await prisma.load.create({ data: { ownerId: A.user.id, carrierId: truck.id, originCity: 'Dallas', originState: 'TX', destCity: 'Memphis', destState: 'TN', rateCents: 1, loadedMiles: 1, status: 'planned' } });
    const rows = await prisma.load.findMany({ where: { id: { in: [t1.id, t2.id, never.id] } } });
    const attached = await withRouteGeometry(rows);
    for (const r of rows) expect(r.route).toBeUndefined();
    const byId = Object.fromEntries(attached.map((l) => [l.id, l]));
    expect(decodePolyline(byId[t1.id].route.geometry).at(-1)[0]).toBeCloseTo(-90.049, 3);
    expect(decodePolyline(byId[t2.id].route.geometry).at(-1)[0]).toBeCloseTo(-86.781, 3);
    expect(byId[never.id].route).toBeNull();
    // Rows that already carry their shape are passed through untouched.
    const again = await withRouteGeometry(attached);
    expect(again[0]).toBe(attached[0]);
    await prisma.load.delete({ where: { id: never.id } });
    await A.agent.post(`/api/fleet/trips/${t2.id}/status`).send({ status: 'canceled' });
  });

  it('route checks read the attached LoadRoute shape, never the deprecated column', async () => {
    const trip = await prisma.load.findFirst({ where: { carrierId: truck.id, status: 'planned' }, orderBy: { createdAt: 'asc' }, include: ROUTE_INCLUDE });
    expect(routeIsCurrent(trip)).toBe(true);
    expect(measuredRoute(trip).n).toBeGreaterThan(2);
    const { route, ...bare } = trip;
    expect(route.geometry.length).toBeGreaterThan(10);
    expect(routeIsCurrent(bare)).toBe(false);
    expect(measuredRoute(bare)).toBeNull();
    expect(routeIsCurrent({ ...bare, routeGeometry: route.geometry })).toBe(false);
    expect(routeMeta(trip)).toMatchObject({ current: true, miles: 452 });
  });

  it('plans read without shapes (Today board, tracking page) still use the road route', async () => {
    const trip = (await prisma.load.findFirst({ where: { carrierId: truck.id, status: 'planned' }, orderBy: { createdAt: 'asc' } }));
    // A row read without its LoadRoute, as services/fleet/today.js and loadShare.js read them.
    const carrier = await prisma.carrier.findUnique({ where: { id: truck.id }, include: { loads: { where: { status: { in: ['planned', 'booked', 'in_transit'] } } }, locationShares: true } });
    expect(carrier.loads.find((l) => l.id === trip.id).route).toBeUndefined();
    const plan = (await plansFor([carrier], { withEvents: false }))[truck.id];
    expect(plan.trips.find((t) => t.id === trip.id).estimate).toBe(false);
  });

  it('a finished trip drops its LoadRoute row, keeps its road miles and reads as not current', async () => {
    const trip = await prisma.load.findFirst({ where: { carrierId: truck.id, status: 'planned' }, orderBy: { createdAt: 'asc' } });
    expect(await prisma.loadRoute.count({ where: { loadId: trip.id } })).toBe(1);
    for (const status of ['booked', 'in_transit', 'delivered']) {
      expect((await A.agent.post(`/api/fleet/trips/${trip.id}/status`).send({ status })).status).toBe(200);
    }
    expect(await prisma.loadRoute.count({ where: { loadId: trip.id } })).toBe(0);
    expect(await prisma.load.findUnique({ where: { id: trip.id } })).toMatchObject({ routeMiles: 452, routeSource: 'osrm' });
    const item = (await A.agent.get(`/api/fleet/routes?ids=${trip.id}`)).body.items[0];
    expect(item).toMatchObject({ estimate: true, pending: false, miles: 452 });
    expect(decodePolyline(item.geometry)).toHaveLength(2);
    // Another user never sees it.
    expect((await B.agent.get(`/api/fleet/routes?ids=${trip.id}`)).body.items).toHaveLength(0);
  });

  it('deleting a load deletes its LoadRoute row', async () => {
    stubOsrm(byDest);
    const t = (await A.agent.post('/api/fleet/trips').send({ carrierId: truck.id, origin: { city: 'Dallas', state: 'TX' }, dest: { city: 'Memphis', state: 'TN' }, rateCents: 99000 })).body.trip;
    expect(await prisma.loadRoute.count({ where: { loadId: t.id } })).toBe(1);
    await A.agent.delete(`/api/fleet/trips/${t.id}`).expect(200);
    expect(await prisma.loadRoute.count({ where: { loadId: t.id } })).toBe(0);
  });
});
