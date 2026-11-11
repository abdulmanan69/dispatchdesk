import { describe, it, expect, beforeAll } from 'vitest';
import { registerUser, prisma } from './helpers.js';

let docN = 0;
async function makeDoc(ownerId, loadId, type) {
  docN += 1;
  return prisma.document.create({ data: { ownerId, uploadedById: ownerId, loadId, type, originalName: `${type}.pdf`, storedName: `lm-${Date.now()}-${docN}.pdf`, mimeType: 'application/pdf', sizeBytes: 10 } });
}

async function customerCarrier(user, agent, overrides = {}) {
  const stage = await prisma.pipelineStage.findUnique({ where: { key: 'prospecting' } });
  const carrier = await prisma.carrier.create({ data: { ownerId: user.id, stageId: stage.id, companyName: overrides.companyName || `Fit Carrier ${Math.random().toString(36).slice(2, 7)}`, equipment: 'dry_van,reefer', state: 'TX', email: 'ops@carrier.test' } });
  const res = await agent.post('/api/customers').send({ carrierId: carrier.id, dispatchFeePercent: 8 });
  expect(res.status).toBe(201);
  return { carrier, customer: res.body.customer };
}

const base = { originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', loadedMiles: 800, rateCents: 200000 };

describe('loads: carrier rules check, lanes and sorting', () => {
  let A;
  let B;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
  });

  it('stores carrier-rules warnings on save, records an acknowledgement and resets it when the warnings change', async () => {
    const { carrier, customer } = await customerCarrier(A.user, A.agent);
    expect((await prisma.carrier.findUnique({ where: { id: carrier.id } })).isFleet).toBe(true);
    const rules = await A.agent.patch(`/api/customers/${customer.id}`).send({ minRatePerMile: 2.6, maxWeightLbs: 44000, avoidStates: 'fl, ga', homeTimeDays: 'saturday sunday', costPerMileCents: 150, hazmat: false });
    expect(rules.status).toBe(200);
    expect(rules.body.customer).toMatchObject({ avoidStates: 'FL,GA', homeTimeDays: 'Sat,Sun' });
    expect((await A.agent.patch(`/api/customers/${customer.id}`).send({ avoidStates: 'Florida' })).status).toBe(400);
    expect((await A.agent.patch(`/api/customers/${customer.id}`).send({ minHaulMiles: 900, maxHaulMiles: 300 })).status).toBe(400);

    const ruleView = await A.agent.get(`/api/customers/rules?carrierId=${carrier.id}`);
    expect(ruleView.body.customer.rules).toMatchObject({ minRatePerMile: 2.6, avoidStates: 'FL,GA', equipment: 'dry_van,reefer' });
    expect((await B.agent.get(`/api/customers/rules?carrierId=${carrier.id}`)).status).toBe(404);

    const created = await A.agent.post('/api/loads').send({ ...base, carrierId: carrier.id, weightLbs: 46000 });
    expect(created.status).toBe(201);
    const codes = created.body.load.fit.warnings.map((w) => w.code).sort();
    expect(codes).toEqual(['avoid_state', 'min_rpm', 'weight']);
    const id = created.body.load.id;

    expect((await B.agent.post(`/api/loads/${id}/fit-ack`)).status).toBe(404);
    const ack = await A.agent.post(`/api/loads/${id}/fit-ack`);
    expect(ack.status).toBe(200);
    expect(ack.body.load.fit.acknowledgedAt).toBeTruthy();
    expect(ack.body.load.fit.acknowledgedBy).toBe(A.user.name);

    // Same warnings: the acknowledgement stays. Different warnings: it is cleared.
    const same = await A.agent.patch(`/api/loads/${id}`).send({ notes: 'Called broker' });
    expect(same.body.load.fit.acknowledgedAt).toBeTruthy();
    const changed = await A.agent.patch(`/api/loads/${id}`).send({ weightLbs: 40000 });
    expect(changed.body.load.fit.warnings.map((w) => w.code).sort()).toEqual(['avoid_state', 'min_rpm']);
    expect(changed.body.load.fit.acknowledgedAt).toBeNull();
    const fixed = await A.agent.patch(`/api/loads/${id}`).send({ destCity: 'Memphis', destState: 'TN', rateCents: 240000 });
    expect(fixed.body.load.fit.warnings).toEqual([]);
    expect((await A.agent.post(`/api/loads/${id}/fit-ack`)).status).toBe(400);
  });

  it('converts facility-local appointment times with the facility time zone (split states included)', async () => {
    const res = await A.agent.post('/api/loads').send({
      ...base, originCity: 'El Paso', originState: 'TX', pickupWindowStart: '2026-11-12T08:00', pickupWindowEnd: '2026-11-12T14:00',
      deliveryWindowStart: '2026-11-14T09:30', pickupFacility: 'Acme DC', freeTimeHours: 3,
    });
    expect(res.status).toBe(201);
    const l = res.body.load;
    expect(l.pickupTz).toBe('America/Denver');
    expect(l.deliveryTz).toBe('America/New_York');
    expect(new Date(l.pickupWindowStart).toISOString()).toBe('2026-11-12T15:00:00.000Z');
    expect(new Date(l.pickupWindowEnd).toISOString()).toBe('2026-11-12T21:00:00.000Z');
    expect(new Date(l.deliveryWindowStart).toISOString()).toBe('2026-11-14T14:30:00.000Z');
    expect(l.freeTimeHours).toBe(3);
    const bad = await A.agent.post('/api/loads').send({ ...base, pickupWindowStart: '2026-11-12T14:00', pickupWindowEnd: '2026-11-12T08:00' });
    expect(bad.status).toBe(400);
    expect((await A.agent.post('/api/loads').send({ ...base, pickupTz: 'Mars/Base' })).status).toBe(400);
    // Moving the pickup re-derives its zone.
    const moved = await A.agent.patch(`/api/loads/${l.id}`).send({ originCity: 'Pensacola', originState: 'FL' });
    expect(moved.body.load.pickupTz).toBe('America/Chicago');
  });

  it('sorts by rate per mile across pages in SQL and shows which paperwork each load has', async () => {
    const C = await registerUser();
    const mk = async (rate, miles) => (await C.agent.post('/api/loads').send({ ...base, rateCents: rate, loadedMiles: miles })).body.load;
    const low = await mk(150000, 1000); // 1.50
    const high = await mk(300000, 1000); // 3.00
    const mid = await mk(200000, 1000); // 2.00
    const p1 = await C.agent.get('/api/loads?sort=rpm&pageSize=1&page=1');
    const p2 = await C.agent.get('/api/loads?sort=rpm&pageSize=1&page=2');
    const p3 = await C.agent.get('/api/loads?sort=rpm&pageSize=1&page=3');
    expect([p1.body.items[0].id, p2.body.items[0].id, p3.body.items[0].id]).toEqual([high.id, mid.id, low.id]);
    expect(p1.body.total).toBe(3);
    expect((await C.agent.get('/api/loads?sort=rpm&q=Dallas&status=planned')).body.items.map((x) => x.id)).toEqual([high.id, mid.id, low.id]);

    await makeDoc(C.user.id, high.id, 'rate_confirmation');
    await makeDoc(C.user.id, high.id, 'pod');
    await makeDoc(C.user.id, mid.id, 'bol');
    const list = await C.agent.get('/api/loads');
    const byId = Object.fromEntries(list.body.items.map((x) => [x.id, x.docs]));
    expect(byId[high.id]).toEqual({ rateCon: true, bol: false, pod: true });
    expect(byId[mid.id]).toEqual({ rateCon: false, bol: true, pod: false });
    const missingPod = await C.agent.get('/api/loads?missing=pod');
    expect(missingPod.body.items.map((x) => x.id).sort()).toEqual([low.id, mid.id].sort());
    const missingRc = await C.agent.get('/api/loads?missing=rate_confirmation&sort=rpm');
    expect(missingRc.body.items.map((x) => x.id)).toEqual([mid.id, low.id]);
  });

  it('builds lane history and lane stats from one bounded aggregate', async () => {
    const D = await registerUser();
    await D.agent.post('/api/loads').send({ ...base, rateCents: 200000, loadedMiles: 800, pickupDate: new Date().toISOString() });
    await D.agent.post('/api/loads').send({ ...base, rateCents: 240000, loadedMiles: 800, pickupDate: new Date().toISOString() });
    await D.agent.post('/api/loads').send({ ...base, rateCents: 999900, loadedMiles: 800, status: 'canceled' });
    await D.agent.post('/api/loads').send({ ...base, rateCents: 100000, loadedMiles: 800, pickupDate: new Date(Date.now() - 400 * 86400000).toISOString() });
    const lanes = await D.agent.get('/api/loads/lanes');
    const txga = lanes.body.items.find((l) => l.originState === 'TX' && l.destState === 'GA');
    expect(txga).toMatchObject({ loads: 2, minRatePerMile: 2.5, maxRatePerMile: 3, avgRatePerMile: 2.75 });
    expect(lanes.body.days).toBe(365);
    const stats = await D.agent.get('/api/loads/lane-stats?originState=TX&destState=GA');
    expect(stats.body.stats).toMatchObject({ sampleSize: 2, avgRatePerMile: 2.75, days: 90 });
    const none = await D.agent.get('/api/loads/lane-stats?originState=CA&destState=NV');
    expect(none.body.stats).toMatchObject({ sampleSize: 0, avgRatePerMile: null });
    // A new load in this process refreshes the cached figures.
    await D.agent.post('/api/loads').send({ ...base, rateCents: 280000, loadedMiles: 800, pickupDate: new Date().toISOString() });
    expect((await D.agent.get('/api/loads/lane-stats?originState=TX&destState=GA')).body.stats.sampleSize).toBe(3);
    expect((await B.agent.get('/api/loads/lane-stats?originState=TX&destState=GA')).body.stats.sampleSize).toBe(0);
  });
});

describe('loads: status side effects, stop times, detention and TONU', () => {
  let A;
  let B;
  let carrier;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    ({ carrier } = await customerCarrier(A.user, A.agent, { companyName: 'Status Haulers' }));
  });

  it('runs the fleet side effects on status changes and asks before moving backwards', async () => {
    const load = (await A.agent.post('/api/loads').send({ ...base, carrierId: carrier.id, status: 'booked' })).body.load;
    const transit = await A.agent.post(`/api/loads/${load.id}/status`).send({ status: 'in_transit' });
    expect(transit.status).toBe(200);
    expect(transit.body.truck.truckStatus).toBe('loaded');
    expect(transit.body.paperwork.missing).toEqual(['rate_confirmation']);

    const delivered = await A.agent.patch(`/api/loads/${load.id}`).send({ status: 'delivered' });
    expect(delivered.status).toBe(200);
    expect(delivered.body.truck).toMatchObject({ truckStatus: 'available', locationCity: 'Atlanta', locationState: 'GA' });
    expect(delivered.body.paperwork.missing).toEqual(['pod']);

    const back = await A.agent.post(`/api/loads/${load.id}/status`).send({ status: 'planned' });
    expect(back.status).toBe(409);
    expect(back.body.code).toBe('CONFIRM_STATUS');
    const backPatch = await A.agent.patch(`/api/loads/${load.id}`).send({ status: 'booked' });
    expect(backPatch.status).toBe(409);
    const forced = await A.agent.post(`/api/loads/${load.id}/status`).send({ status: 'booked', force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.load.status).toBe('booked');

    const events = await prisma.loadEvent.findMany({ where: { loadId: load.id, type: 'status' }, orderBy: { at: 'asc' } });
    expect(events.map((e) => JSON.parse(e.data).to)).toEqual(['in_transit', 'delivered', 'booked']);
    expect((await B.agent.post(`/api/loads/${load.id}/status`).send({ status: 'paid' })).status).toBe(404);
  });

  it('records stop times, runs the detention clock and fills detention hours', async () => {
    const load = (await A.agent.post('/api/loads').send({ ...base, carrierId: carrier.id, status: 'in_transit', detentionRateCents: 5000, freeTimeHours: 2 })).body.load;
    const t = Date.now() - 6 * 3600000;
    const arrive = await A.agent.post(`/api/loads/${load.id}/events`).send({ type: 'arrived_delivery', at: new Date(t).toISOString() });
    expect(arrive.status).toBe(201);
    expect(arrive.body.detention.stops[1].state).toBe('detention');
    const depart = await A.agent.post(`/api/loads/${load.id}/events`).send({ type: 'delivered', at: new Date(t + 3.5 * 3600000).toISOString() });
    expect(depart.body.detention.stops[1]).toMatchObject({ state: 'departed', billableHours: 1.5, amountCents: 7500 });
    expect((await A.agent.post(`/api/loads/${load.id}/events`).send({ type: 'status' })).status).toBe(400);
    expect((await A.agent.post(`/api/loads/${load.id}/events`).send({ type: 'note', at: '2020-01-01T00:00:00Z' })).status).toBe(400);
    expect((await B.agent.post(`/api/loads/${load.id}/events`).send({ type: 'arrived_pickup' })).status).toBe(404);

    const detail = await A.agent.get(`/api/loads/${load.id}`);
    expect(detail.body.events.filter((e) => ['arrived_delivery', 'delivered'].includes(e.type))).toHaveLength(2);
    expect(detail.body.detention.billableHours).toBe(1.5);

    const applied = await A.agent.post(`/api/loads/${load.id}/detention/apply`).send({});
    expect(applied.status).toBe(200);
    expect(applied.body.load.detentionHours).toBe(1.5);
    expect(applied.body.load.calc.detentionPayCents).toBe(7500);

    const checkCall = await A.agent.post(`/api/loads/${load.id}/events`).send({ type: 'check_call', note: 'Driver 40 mi out' });
    expect(checkCall.status).toBe(201);
    expect((await prisma.load.findUnique({ where: { id: load.id } })).lastCheckCallAt).toBeTruthy();
    // Dispatcher entries can be removed; driver check-ins stay as evidence.
    expect((await A.agent.delete(`/api/loads/${load.id}/events/${checkCall.body.event.id}`)).status).toBe(200);
    const driver = await prisma.loadEvent.create({ data: { loadId: load.id, ownerId: A.user.id, type: 'arrived_pickup', source: 'driver_link' } });
    expect((await A.agent.delete(`/api/loads/${load.id}/events/${driver.id}`)).status).toBe(400);
    expect((await B.agent.delete(`/api/loads/${load.id}/events/${driver.id}`)).status).toBe(404);
  });

  it('records a TONU with its evidence note and cancels the load', async () => {
    const load = (await A.agent.post('/api/loads').send({ ...base, carrierId: carrier.id, status: 'in_transit' })).body.load;
    expect((await B.agent.post(`/api/loads/${load.id}/tonu`).send({ tonuCents: 15000 })).status).toBe(404);
    expect((await A.agent.post(`/api/loads/${load.id}/tonu`).send({ tonuCents: -5 })).status).toBe(400);
    const res = await A.agent.post(`/api/loads/${load.id}/tonu`).send({ tonuCents: 15000, note: 'Shipper canceled at 08:10 after the truck arrived' });
    expect(res.status).toBe(200);
    expect(res.body.load).toMatchObject({ status: 'canceled', tonuCents: 15000 });
    const notes = await prisma.loadEvent.findMany({ where: { loadId: load.id, type: 'note' } });
    expect(notes.some((n) => n.note.includes('TONU $150.00') && n.note.includes('Shipper canceled'))).toBe(true);
    expect((await prisma.carrier.findUnique({ where: { id: carrier.id } })).truckStatus).toBe('available');
  });

  it('parses a rate con and matches the broker by MC without waiting on FMCSA', async () => {
    const broker = (await A.agent.post('/api/brokers').send({ companyName: 'Summit Logistics', mcNumber: '123456', phone: '2145550199' })).body.broker;
    const text = 'Summit Logistics LLC\nMC# 123456\nPickup: Dallas, TX 75201  11/12 08:00-14:00\nDelivery: Atlanta, GA 30301  11/14\nRate: $2,350.00\nMiles: 781\nPhone: (972) 555-0100';
    const res = await A.agent.post('/api/loads/parse').send({ text });
    expect(res.status).toBe(200);
    expect(res.body.fields).toMatchObject({ originCity: 'Dallas', destCity: 'Atlanta', rateCents: 235000, brokerMc: '123456' });
    expect(res.body.broker.match.id).toBe(broker.id);
    expect(res.body.vetting).toEqual({ pending: true });
    const other = await B.agent.post('/api/loads/parse').send({ text });
    expect(other.body.broker.match).toBeNull();
  });
});

describe('loads: small lookups for the load form', () => {
  it('returns the facility zone for a city and the truck position with the carrier rules', async () => {
    const A = await registerUser();
    expect((await A.agent.get('/api/loads/facility-tz?city=El%20Paso&state=TX')).body.timezone).toBe('America/Denver');
    expect((await A.agent.get('/api/loads/facility-tz?state=GA')).body.timezone).toBe('America/New_York');
    expect((await A.agent.get('/api/loads/facility-tz?state=Georgia')).status).toBe(400);
    const { carrier } = await customerCarrier(A.user, A.agent);
    expect((await A.agent.get(`/api/customers/rules?carrierId=${carrier.id}`)).body.carrier.truck).toBeNull();
    await prisma.carrier.update({ where: { id: carrier.id }, data: { locationLat: 32.78, locationLng: -96.8, locationCity: 'Dallas', locationState: 'TX' } });
    expect((await A.agent.get(`/api/customers/rules?carrierId=${carrier.id}`)).body.carrier.truck).toMatchObject({ lat: 32.78, lng: -96.8, city: 'Dallas', state: 'TX' });
  });
});

describe('loads: fleet map coordinates and the text action', () => {
  it('drops fleet-map coordinates only when a stop moves here, and returns the carrier fields the text action needs', async () => {
    const A = await registerUser();
    const B = await registerUser();
    const { carrier } = await customerCarrier(A.user, A.agent);
    await prisma.carrier.update({ where: { id: carrier.id }, data: { phone: '2145550100', timezone: 'America/Chicago' } });
    const created = await A.agent.post('/api/loads').send({ ...base, carrierId: carrier.id, status: 'booked' });
    expect(created.status).toBe(201);
    expect(created.body.load.carrier).toMatchObject({ id: carrier.id, phone: '2145550100', doNotCall: false, state: 'TX', timezone: 'America/Chicago' });
    const id = created.body.load.id;
    // Exact pins, as the fleet map stores them for a planned trip.
    await prisma.load.update({ where: { id }, data: { originLat: 32.7767, originLng: -96.797, destLat: 33.749, destLng: -84.388 } });
    const pins = async () => {
      const row = await prisma.load.findUnique({ where: { id } });
      return [row.originLat, row.originLng, row.destLat, row.destLng];
    };

    // Same stops (other casing) and other edits: the pins stay.
    const same = await A.agent.patch(`/api/loads/${id}`).send({ originCity: 'DALLAS', originState: 'tx', destCity: 'Atlanta', destState: 'GA', rateCents: 210000 });
    expect(same.status).toBe(200);
    expect(await pins()).toEqual([32.7767, -96.797, 33.749, -84.388]);

    // The delivery moves to another city: its old pin is dropped (the city decides now), the pickup pin stays.
    const moved = await A.agent.patch(`/api/loads/${id}`).send({ destCity: 'Memphis', destState: 'TN' });
    expect(moved.status).toBe(200);
    expect(await pins()).toEqual([32.7767, -96.797, null, null]);
    expect(moved.body.load.deliveryTz).toBe('America/Chicago');

    // Only the state changes: that is a move too.
    await prisma.load.update({ where: { id }, data: { originLat: 32.7767, originLng: -96.797 } });
    await A.agent.patch(`/api/loads/${id}`).send({ originState: 'OK' }).expect(200);
    expect((await pins()).slice(0, 2)).toEqual([null, null]);

    // The list carries the same carrier fields; other workspaces still get 404.
    const list = await A.agent.get('/api/loads?pageSize=100');
    expect(list.body.items.find((l) => l.id === id).carrier).toMatchObject({ phone: '2145550100', doNotCall: false });
    expect((await B.agent.patch(`/api/loads/${id}`).send({ destCity: 'Nashville', destState: 'TN' })).status).toBe(404);
  });
});

describe('loads: rate-per-mile sort with a pickup date range', () => {
  it('keeps the same loads as the default sort when filtering by pickup dates', async () => {
    const D = await registerUser();
    const mk = async (rate, pickupDate) => (await D.agent.post('/api/loads').send({ ...base, rateCents: rate, loadedMiles: 1000, pickupDate })).body.load;
    const early = await mk(300000, '2026-10-01');
    const inA = await mk(150000, '2026-10-10');
    const inB = await mk(250000, '2026-10-20');
    const late = await mk(400000, '2026-11-02');
    expect([early, inA, inB, late].every((l) => l?.id)).toBe(true);
    const range = 'from=2026-10-05&to=2026-10-20';
    const byPickup = await D.agent.get(`/api/loads?${range}`);
    const byRpm = await D.agent.get(`/api/loads?${range}&sort=rpm`);
    expect(byPickup.body.items.map((l) => l.id).sort()).toEqual([inA.id, inB.id].sort());
    expect(byRpm.body.items.map((l) => l.id)).toEqual([inB.id, inA.id]);
    expect(byRpm.body.total).toBe(2);
  });
});
