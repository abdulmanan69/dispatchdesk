import { describe, it, expect, beforeAll } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { calculateLoad } from '../src/services/loads/rateCalc.js';
import { parseLoadText } from '../src/services/loads/parser.js';

describe('rate calculator', () => {
  it('computes rate per mile = total rate / loaded miles', () => {
    const c = calculateLoad({ rateCents: 240000, loadedMiles: 1000 });
    expect(c.ratePerMile).toBe(2.4);
    expect(c.allInRatePerMile).toBe(2.4);
    expect(c.grossCents).toBe(240000);
    expect(c.fuelCostCents).toBeNull();
    expect(c.dispatchFeeCents).toBeNull();
  });

  it('includes deadhead, fuel, detention, other costs and dispatch fee', () => {
    const c = calculateLoad({
      rateCents: 300000, loadedMiles: 1100, deadheadMiles: 100, detentionHours: 3, detentionRateCents: 5000,
      fuelPricePerGallon: 3.9, mpg: 6.5, otherCostsCents: 10000, dispatchFeePercent: 8,
    });
    expect(c.totalMiles).toBe(1200);
    expect(c.ratePerMile).toBe(2.73); // 3000 / 1100
    expect(c.allInRatePerMile).toBe(2.5); // 3000 / 1200
    expect(c.deadheadPercent).toBe(8.33);
    expect(c.fuelGallons).toBe(184.62);
    expect(c.fuelCostCents).toBe(72000); // 1200/6.5*3.9 = 720.00
    expect(c.detentionPayCents).toBe(15000);
    expect(c.grossCents).toBe(315000);
    expect(c.dispatchFeeCents).toBe(25200);
    expect(c.estProfitCents).toBe(315000 - 72000 - 10000);
    expect(c.carrierNetCents).toBe(315000 - 72000 - 10000 - 25200);
    expect(c.profitPerMile).toBe(1.94);
  });

  it('returns null rate per mile when miles are zero instead of dividing by zero', () => {
    const c = calculateLoad({ rateCents: 100000, loadedMiles: 0 });
    expect(c.ratePerMile).toBeNull();
    expect(c.allInRatePerMile).toBeNull();
  });
});

describe('load text parser', () => {
  const now = new Date('2026-11-09T12:00:00Z');

  it('parses a labelled rate-confirmation style paste', () => {
    const r = parseLoadText(`Load #: ABC-12345
Broker: Summit Logistics LLC MC# 123456
Pickup: Dallas, TX 75201  11/12
Delivery: Atlanta, GA 30301  11/14
Equipment: Dry Van 53'
Commodity: Paper products
Weight: 42,000 lbs
Miles: 781
Rate: $2,350.00
DH-O 35
Contact: (214) 555-0199  ops@summit.test`, { now });
    expect(r.fields).toMatchObject({
      originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA',
      rateCents: 235000, loadedMiles: 781, deadheadMiles: 35, weightLbs: 42000, equipment: 'dry_van',
      commodity: 'Paper products', referenceNumber: 'ABC-12345', brokerMc: '123456', pickupDate: '2026-11-12', deliveryDate: '2026-11-14',
      brokerEmail: 'ops@summit.test',
    });
    expect(r.fields.brokerName).toBe('Summit Logistics LLC');
    expect(r.confidence).toBe(1);
  });

  it('parses a compact load-board row with codes', () => {
    const r = parseLoadText('11/20  Chicago, IL  (42)  Memphis, TN  R  38k lbs  532 mi  $1,450', { now });
    expect(r.fields).toMatchObject({ originCity: 'Chicago', originState: 'IL', destCity: 'Memphis', destState: 'TN', equipment: 'reefer', weightLbs: 38000, loadedMiles: 532, rateCents: 145000, pickupDate: '2026-11-20' });
  });

  it('computes the total from a posted rate per mile and handles arrows and month names', () => {
    const r = parseLoadText('Flatbed Phoenix AZ -> Denver CO, 820 miles, $2.75/mi, pick up Dec 3', { now });
    expect(r.fields).toMatchObject({ originCity: 'Phoenix', originState: 'AZ', destCity: 'Denver', destState: 'CO', equipment: 'flatbed', loadedMiles: 820, postedRatePerMile: 2.75, rateCents: 225500, pickupDate: '2026-12-03' });
    expect(r.notes.join(' ')).toMatch(/computed from posted rate/i);
  });

  it('rolls year-less dates in the past into next year and reports missing fields honestly', () => {
    const r = parseLoadText('Van load out of Reno, NV going to Boise, ID on 1/5', { now });
    expect(r.fields.pickupDate).toBe('2027-01-05');
    expect(r.missing).toContain('rateCents');
    expect(r.notes.join(' ')).toMatch(/No total rate/);
  });
});

describe('brokers and loads API', () => {
  let me;
  let other;
  let broker;
  let carrier;
  beforeAll(async () => {
    me = await registerUser();
    other = await registerUser();
    const stage = await prisma.pipelineStage.findUnique({ where: { key: 'customer' } });
    carrier = await prisma.carrier.create({ data: { ownerId: me.user.id, stageId: stage.id, companyName: 'Blue Line Trucking' } });
  });

  it('creates, searches, updates and reads a broker with stats', async () => {
    const res = await me.agent.post('/api/brokers').send({ companyName: 'Summit Logistics', contactName: 'Ana', email: 'ANA@Summit.test', phone: '2145550199', state: 'tx', mcNumber: 'MC-123456', paymentTerms: 'Net 30', daysToPay: 28 });
    expect(res.status).toBe(201);
    broker = res.body.broker;
    expect(broker).toMatchObject({ email: 'ana@summit.test', state: 'TX', mcNumber: '123456' });
    expect((await me.agent.post('/api/brokers').send({ companyName: '' })).status).toBe(400);
    const list = await me.agent.get('/api/brokers?q=Summit');
    expect(list.body.items.map((b) => b.id)).toContain(broker.id);
    const upd = await me.agent.patch(`/api/brokers/${broker.id}`).send({ creditRating: 'A', notes: 'Fast pay' });
    expect(upd.body.broker).toMatchObject({ creditRating: 'A', notes: 'Fast pay', companyName: 'Summit Logistics' });
  });

  it('creates loads with computed economics, filters them and builds lane history', async () => {
    const l1 = await me.agent.post('/api/loads').send({
      brokerId: broker.id, carrierId: carrier.id, referenceNumber: 'R-1', originCity: 'Dallas', originState: 'tx', destCity: 'Atlanta', destState: 'GA',
      pickupDate: '2026-11-12', deliveryDate: '2026-11-14', equipment: 'dry_van', loadedMiles: 800, deadheadMiles: 50, rateCents: 200000,
      fuelPricePerGallon: 4, mpg: 6.25, dispatchFeePercent: 8, status: 'booked',
    });
    expect(l1.status).toBe(201);
    expect(l1.body.load.calc).toMatchObject({ ratePerMile: 2.5, totalMiles: 850, fuelCostCents: 54400, dispatchFeeCents: 16000 });
    await me.agent.post('/api/loads').send({ brokerId: broker.id, originCity: 'Dallas', originState: 'TX', destCity: 'Macon', destState: 'GA', loadedMiles: 850, rateCents: 170000, status: 'delivered' });

    const bad = await me.agent.post('/api/loads').send({ originCity: 'A', originState: 'TX', destCity: 'B', destState: 'GA', loadedMiles: 10, rateCents: 100, pickupDate: '2026-11-12', deliveryDate: '2026-11-10' });
    expect(bad.status).toBe(400);
    expect((await me.agent.post('/api/loads').send({ originCity: 'A', originState: 'Texas', destCity: 'B', destState: 'GA', loadedMiles: 10, rateCents: 100 })).status).toBe(400);

    const filtered = await me.agent.get(`/api/loads?brokerId=${broker.id}&status=booked`);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0].broker.companyName).toBe('Summit Logistics');
    const all = await me.agent.get('/api/loads?originState=TX');
    expect(all.body.summary).toMatchObject({ loads: 2, rateCents: 370000, loadedMiles: 1650 });

    const lanes = await me.agent.get('/api/loads/lanes');
    const txga = lanes.body.items.find((l) => l.originState === 'TX' && l.destState === 'GA');
    expect(txga).toMatchObject({ loads: 2, minRatePerMile: 2, maxRatePerMile: 2.5, avgRatePerMile: 2.24 });

    const patch = await me.agent.patch(`/api/loads/${l1.body.load.id}`).send({ status: 'in_transit' });
    expect(patch.body.load.status).toBe('in_transit');
    expect(patch.body.load.deadheadMiles).toBe(50); // untouched fields survive partial updates

    const bd = await me.agent.get(`/api/brokers/${broker.id}`);
    expect(bd.body.stats).toMatchObject({ loads: 2, revenueCents: 370000 });
    expect(bd.body.loads[0].calc).toBeTruthy();
  });

  it('calculate and parse endpoints are stateless helpers', async () => {
    const c = await me.agent.post('/api/loads/calculate').send({ rateCents: 150000, loadedMiles: 600 });
    expect(c.body.calc.ratePerMile).toBe(2.5);
    const p = await me.agent.post('/api/loads/parse').send({ text: 'Dallas, TX to Houston, TX 240 mi $900 Reefer' });
    expect(p.body.fields).toMatchObject({ originCity: 'Dallas', destCity: 'Houston', loadedMiles: 240, rateCents: 90000, equipment: 'reefer' });
    expect((await me.agent.post('/api/loads/parse').send({ text: '' })).status).toBe(400);
  });

  it('isolates brokers and loads between tenants', async () => {
    const load = (await me.agent.get('/api/loads')).body.items[0];
    const b = other.agent;
    expect((await b.get(`/api/brokers/${broker.id}`)).status).toBe(404);
    expect((await b.patch(`/api/brokers/${broker.id}`).send({ notes: 'x' })).status).toBe(404);
    expect((await b.delete(`/api/brokers/${broker.id}`)).status).toBe(404);
    expect((await b.get(`/api/loads/${load.id}`)).status).toBe(404);
    expect((await b.delete(`/api/loads/${load.id}`)).status).toBe(404);
    expect((await b.get('/api/loads')).body.items).toHaveLength(0);
    expect((await b.get('/api/brokers')).body.items).toHaveLength(0);
    // Cannot attach someone else's broker or carrier to your own load.
    const steal = await b.post('/api/loads').send({ brokerId: broker.id, originCity: 'A', originState: 'TX', destCity: 'B', destState: 'GA', loadedMiles: 10, rateCents: 100 });
    expect(steal.status).toBe(404);
    const steal2 = await b.post('/api/loads').send({ carrierId: carrier.id, originCity: 'A', originState: 'TX', destCity: 'B', destState: 'GA', loadedMiles: 10, rateCents: 100 });
    expect(steal2.status).toBe(404);
  });

  it('deletes a broker but keeps its loads (broker reference cleared)', async () => {
    const tmp = (await me.agent.post('/api/brokers').send({ companyName: 'Temp Broker' })).body.broker;
    const load = (await me.agent.post('/api/loads').send({ brokerId: tmp.id, originCity: 'A', originState: 'TX', destCity: 'B', destState: 'GA', loadedMiles: 10, rateCents: 100 })).body.load;
    expect((await me.agent.delete(`/api/brokers/${tmp.id}`)).status).toBe(200);
    const after = await me.agent.get(`/api/loads/${load.id}`);
    expect(after.body.load.brokerId).toBeNull();
    expect((await me.agent.delete(`/api/loads/${load.id}`)).status).toBe(200);
  });
});
