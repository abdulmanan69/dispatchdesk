import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app, registerUser, prisma } from './helpers.js';
import { clearCensusCache } from '../src/services/carriers/fmcsaCensus.js';
import { defaultTruckPost, truckValues, summarizeReloads, leftoverTokens } from '../src/services/carriers/truckPost.js';

const DAY = 86400000;

function stubCensusCounts() {
  const fn = vi.fn(async (input) => {
    const u = new URL(String(input));
    const where = u.searchParams.get('$where') || '';
    return { ok: true, status: 200, json: async () => [{ n: where.includes("carship like '%B%'") ? '15' : '900' }] };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('truck post helpers', () => {
  const truck = {
    companyName: 'Lone Star Haulers', mcNumber: '445566', dotNumber: '123', equipment: 'dry_van,reefer', truckStatus: 'available',
    locationCity: 'Dallas', locationState: 'TX', availableAt: null,
    customer: { minRatePerMile: 2.5, trailerLengthFt: 53, hazmat: true, lanes: [{ origin: 'TX', destination: 'GA' }] },
  };

  it('fills truck values from the carrier and customer rules, overrides win', () => {
    expect(truckValues(truck)).toEqual({
      carrier_company: 'Lone Star Haulers', carrier_mc: '445566', carrier_dot: '123', equipment: 'Dry van, Reefer', truck_location: 'Dallas, TX',
      available_date: 'now', preferred_lanes: 'TX to GA', target_rate: '$2.50/mi', truck_details: '53 ft trailer, hazmat',
    });
    const later = truckValues(truck, { location: 'Waco, TX', availableAt: new Date('2026-11-12T14:00:00Z') }, { now: new Date('2026-11-10T12:00:00Z') });
    expect(later.truck_location).toBe('Waco, TX');
    expect(later.available_date).toBe('Thu, Nov 12, 8:00 AM CST');
  });

  it('builds a default that only mentions known facts', () => {
    const values = truckValues({ companyName: 'Bare Bones', state: 'OK', city: 'Tulsa' });
    const t = defaultTruckPost(values, {});
    expect(t.subject).toBe('Truck available: Truck in {{truck_location}}');
    expect(t.body).not.toMatch(/Preferred lanes|Target rate|Equipment:|call me/);
    const full = defaultTruckPost(truckValues(truck), { phone: '2145550100' });
    expect(full.subject).toBe('Available now: {{equipment}} in {{truck_location}}');
    expect(full.body).toContain('Target rate: {{target_rate}}');
    expect(full.body).toContain('call me at {{my_phone}}');
    expect(leftoverTokens('Hi {{ first_name }}', 'x')).toEqual(['first_name']);
  });

  it('summarizes reload ideas from loads, with city matches first', () => {
    const now = Date.now();
    const b1 = { id: 'b1', companyName: 'One' };
    const b2 = { id: 'b2', companyName: 'Two' };
    const loads = [
      { brokerId: 'b2', broker: b2, originCity: 'Savannah', destState: 'FL', rateCents: 200000, loadedMiles: 400, pickupDate: new Date(now - DAY), equipment: 'dry_van' },
      { brokerId: 'b1', broker: b1, originCity: 'Atlanta', destState: 'TX', rateCents: 300000, loadedMiles: 1000, pickupDate: new Date(now - 3 * DAY), equipment: 'dry_van' },
      { brokerId: 'b1', broker: b1, originCity: 'Atlanta', destState: 'TX', rateCents: 100000, loadedMiles: 500, pickupDate: new Date(now - 9 * DAY), equipment: null },
      { brokerId: 'b2', broker: b2, originCity: 'Macon', destState: 'TX', rateCents: 90000, loadedMiles: 300, pickupDate: new Date(now - 2 * DAY), equipment: 'flatbed' },
    ];
    const s = summarizeReloads(loads, { city: 'atlanta', equipment: 'dry_van' });
    expect(s.brokers.map((b) => b.broker.id)).toEqual(['b1', 'b2']);
    expect(s.brokers[0]).toMatchObject({ loads: 2, cityLoads: 2, lastRpm: 3, avgRpm: 2.67, topDestinations: ['TX'] });
    expect(s.brokers[1]).toMatchObject({ loads: 1, lastRpm: 5 }); // the flatbed load does not fit a dry van
    expect(s.lanes.map((l) => l.destState)).toEqual(['TX', 'FL']);
  });
});

describe('truck posts API', () => {
  let U; let other; let truck; let idle; let b1; let b2; let noEmail; let foreign;
  beforeAll(async () => {
    U = await registerUser({ name: 'Dana Dispatch' });
    other = await registerUser();
    await prisma.user.update({ where: { id: U.user.id }, data: { phone: '2145550100' } });
    const lead = await prisma.pipelineStage.findUnique({ where: { key: 'customer' } });
    truck = await prisma.carrier.create({
      data: {
        ownerId: U.user.id, stageId: lead.id, companyName: 'Lone Star Haulers', mcNumber: '445566', equipment: 'dry_van', truckStatus: 'available',
        locationCity: 'Dallas', locationState: 'TX', state: 'TX',
        customer: { create: { ownerId: U.user.id, minRatePerMile: 2.5, trailerLengthFt: 53, lanes: { create: [{ origin: 'TX', destination: 'GA' }] } } },
      },
    });
    idle = await prisma.carrier.create({ data: { ownerId: U.user.id, stageId: lead.id, companyName: 'Just A Lead' } });
    b1 = await prisma.broker.create({ data: { ownerId: U.user.id, companyName: 'Peach Logistics', contactName: 'Ann Broker', email: 'ann@peach.test', state: 'GA' } });
    b2 = await prisma.broker.create({ data: { ownerId: U.user.id, companyName: 'Blue Freight', email: 'loads@blue.test', state: 'IL' } });
    noEmail = await prisma.broker.create({ data: { ownerId: U.user.id, companyName: 'Phone Only Brokerage', phone: '3125550000' } });
    foreign = await prisma.broker.create({ data: { ownerId: other.user.id, companyName: 'Not Yours', email: 'x@other.test' } });
    const base = { ownerId: U.user.id, carrierId: truck.id, status: 'delivered' };
    await prisma.load.createMany({
      data: [
        { ...base, brokerId: b1.id, originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', loadedMiles: 780, rateCents: 234000, pickupDate: new Date(Date.now() - 10 * DAY) },
        { ...base, brokerId: b1.id, originCity: 'Atlanta', originState: 'GA', destCity: 'Dallas', destState: 'TX', loadedMiles: 780, rateCents: 195000, pickupDate: new Date(Date.now() - 5 * DAY) },
        { ...base, brokerId: b1.id, originCity: 'Atlanta', originState: 'GA', destCity: 'Orlando', destState: 'FL', loadedMiles: 440, rateCents: 132000, pickupDate: new Date(Date.now() - 20 * DAY) },
        { ...base, brokerId: b2.id, originCity: 'Savannah', originState: 'GA', destCity: 'Chicago', destState: 'IL', loadedMiles: 1000, rateCents: 250000, pickupDate: new Date(Date.now() - 40 * DAY), status: 'canceled' },
        { ownerId: other.user.id, brokerId: foreign.id, originCity: 'Atlanta', originState: 'GA', destCity: 'Miami', destState: 'FL', loadedMiles: 660, rateCents: 200000, pickupDate: new Date(Date.now() - 2 * DAY) },
      ],
    });
    const cust = await prisma.customer.findUnique({ where: { carrierId: truck.id } });
    await prisma.customerLane.create({ data: { customerId: cust.id, origin: 'Atlanta, GA', destination: 'Dallas, TX' } });
  });
  afterEach(() => { vi.unstubAllGlobals(); clearCensusCache(); });

  const post = (extra = {}) => ({ carrierId: truck.id, brokerIds: [b1.id, b2.id, noEmail.id, foreign.id], subject: 'Available now: {{equipment}} in {{truck_location}}', body: 'Hi {{first_name}}, {{carrier_company}} (MC {{carrier_mc}}) is empty in {{truck_location}}. Lanes: {{preferred_lanes}}. {{signature}}', ...extra });

  it('lists fleet trucks only, available first, and isolates users', async () => {
    const res = await U.agent.get('/api/truck-posts/trucks');
    expect(res.status).toBe(200);
    expect(res.body.items.map((t) => t.id)).toEqual([truck.id]);
    expect(res.body.items[0]).toMatchObject({ available: true, location: 'Dallas, TX', lanesText: 'TX to GA; Atlanta, GA to Dallas, TX', minRatePerMile: 2.5 });
    expect(res.body.items.find((t) => t.id === idle.id)).toBeUndefined();
    expect((await other.agent.get('/api/truck-posts/trucks')).body.items).toHaveLength(0);
  });

  it('drafts a default post for a truck; others get 404', async () => {
    const res = await U.agent.get(`/api/truck-posts/draft?carrierId=${truck.id}`);
    expect(res.body.values).toMatchObject({ carrier_company: 'Lone Star Haulers', equipment: 'Dry van', truck_location: 'Dallas, TX', available_date: 'now', target_rate: '$2.50/mi', truck_details: '53 ft trailer' });
    expect(res.body.template.subject).toBe('Available now: {{equipment}} in {{truck_location}}');
    expect(res.body.template.body).toContain('call me at {{my_phone}}');
    expect((await other.agent.get(`/api/truck-posts/draft?carrierId=${truck.id}`)).status).toBe(404);
  });

  it('lists brokers with the lanes hauled for them and filters by state, lane and recency', async () => {
    const all = await U.agent.get('/api/truck-posts/brokers');
    expect(all.body.items.map((b) => b.companyName)).toEqual(['Peach Logistics', 'Blue Freight']);
    expect(all.body.items[0]).toMatchObject({ loads: 3, states: ['FL', 'GA', 'TX'] });
    expect(all.body.items[0].lanes[0]).toMatchObject({ loads: 1 });
    expect((await U.agent.get('/api/truck-posts/brokers?withEmail=false')).body.items).toHaveLength(3);
    expect((await U.agent.get('/api/truck-posts/brokers?state=fl')).body.items.map((b) => b.id)).toEqual([b1.id]);
    expect((await U.agent.get('/api/truck-posts/brokers?state=IL')).body.items.map((b) => b.id)).toEqual([b2.id]);
    expect((await U.agent.get('/api/truck-posts/brokers?lane=GA-TX')).body.items.map((b) => b.id)).toEqual([b1.id]);
    expect((await U.agent.get('/api/truck-posts/brokers?withinDays=3')).body.items).toHaveLength(0);
    expect((await U.agent.get('/api/truck-posts/brokers?lane=Texas')).status).toBe(400);
    expect((await other.agent.get('/api/truck-posts/brokers')).body.items.map((b) => b.id)).toEqual([foreign.id]);
    expect((await other.agent.get(`/api/truck-posts/brokers?carrierId=${truck.id}`)).status).toBe(404);
  });

  it('previews each broker\'s email with merge fields filled', async () => {
    const res = await U.agent.post('/api/truck-posts/preview').send(post());
    expect(res.status).toBe(200);
    const [ann, blue, phone, nope] = res.body.items;
    expect(ann).toMatchObject({ toEmail: 'ann@peach.test', subject: 'Available now: Dry van in Dallas, TX', unresolved: [] });
    expect(ann.body).toContain('Hi Ann, Lone Star Haulers (MC 445566) is empty in Dallas, TX. Lanes: TX to GA; Atlanta, GA to Dallas, TX.');
    expect(blue.body).toContain('Hi there');
    expect(phone.skip).toBe('No email address');
    expect(nope.skip).toBe('Broker not found');
    const tooMany = await U.agent.post('/api/truck-posts/preview').send(post({ brokerIds: Array.from({ length: 31 }, (_, i) => `b${i}`) }));
    expect(tooMany.status).toBe(400);
  });

  it('queues one email per broker with a timeline entry, and does not repeat within 12 hours', async () => {
    const none = await U.agent.post('/api/truck-posts/send').send(post());
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/Connect a mailbox/);
    await prisma.emailAccount.create({ data: { userId: U.user.id, provider: 'smtp', label: 'Work', fromEmail: 'dana@dispatch.test', smtpHost: 'smtp.test', status: 'connected', isDefault: true, dailyLimit: 50, cooldownSeconds: 30 } });
    const res = await U.agent.post('/api/truck-posts/send').send(post());
    expect(res.status).toBe(201);
    expect(res.body.queued).toBe(2);
    expect(res.body.skipped.map((s) => s.reason).sort()).toEqual(['Broker not found', 'No email address']);
    const emails = await prisma.email.findMany({ where: { userId: U.user.id }, orderBy: { toEmail: 'asc' } });
    expect(emails.map((e) => [e.toEmail, e.status, e.carrierId])).toEqual([['ann@peach.test', 'scheduled', null], ['loads@blue.test', 'scheduled', null]]);
    expect(emails[0].brokerId).toBe(b1.id);
    expect(emails[0].subject).toBe('Available now: Dry van in Dallas, TX');
    const acts = await prisma.activity.findMany({ where: { carrierId: truck.id, type: 'truck_post' } });
    expect(acts).toHaveLength(2);
    expect(JSON.parse(acts[0].metadata)).toMatchObject({ postId: res.body.postId });

    const again = await U.agent.post('/api/truck-posts/send').send(post({ brokerIds: [b1.id] }));
    expect(again.body.queued).toBe(0);
    expect(again.body.skipped[0].reason).toMatch(/last 12 hours/);
    const draft = await U.agent.get(`/api/truck-posts/draft?carrierId=${truck.id}`);
    expect(Object.keys(draft.body.recent)).toEqual(expect.arrayContaining([b1.id, b2.id]));
    const marked = await U.agent.get(`/api/truck-posts/brokers?carrierId=${truck.id}`);
    expect(marked.body.items.find((b) => b.id === b1.id).postedAt).toBeTruthy();
    const repeat = await U.agent.post('/api/truck-posts/send').send(post({ brokerIds: [b1.id], allowRepeat: true }));
    expect(repeat.body.queued).toBe(1);
  });

  it('never queues an email with unfilled merge fields and blocks API tokens and other users', async () => {
    const res = await U.agent.post('/api/truck-posts/send').send(post({ brokerIds: [b2.id], allowRepeat: true, subject: 'Load {{load_ref}}' }));
    expect(res.body.queued).toBe(0);
    expect(res.body.skipped[0].reason).toBe('Unfilled merge fields: load_ref');
    // A known field with no value for this broker (Blue Freight has no contact name) is not sent blank either.
    const blankBody = 'Attn {{contact_name}}: {{carrier_company}} is empty in {{truck_location}}.';
    const shown = await U.agent.post('/api/truck-posts/preview').send(post({ brokerIds: [b1.id, b2.id], body: blankBody }));
    expect(shown.body.items.map((i) => i.unresolved)).toEqual([[], ['contact_name']]);
    const blank = await U.agent.post('/api/truck-posts/send').send(post({ brokerIds: [b2.id], allowRepeat: true, body: blankBody }));
    expect(blank.body.queued).toBe(0);
    expect(blank.body.skipped).toEqual([{ brokerId: b2.id, name: 'Blue Freight', reason: 'Unfilled merge fields: contact_name' }]);
    expect(await prisma.email.count({ where: { userId: U.user.id, body: { startsWith: 'Attn ' } } })).toBe(0);
    expect((await other.agent.post('/api/truck-posts/send').send(post({ brokerIds: [foreign.id] }))).status).toBe(404);
    const { body } = await U.agent.post('/api/tokens').send({ name: 'ext', expiresInDays: 30 });
    expect((await request(app).post('/api/truck-posts/send').set({ Authorization: `Bearer ${body.token}` }).send(post())).status).toBe(403);
  });

  it('shows post history with each email\'s delivery status', async () => {
    const one = await prisma.email.findFirst({ where: { userId: U.user.id, toEmail: 'loads@blue.test' } });
    await prisma.email.update({ where: { id: one.id }, data: { status: 'sent', sentAt: new Date(), repliedAt: new Date() } });
    const res = await U.agent.get('/api/truck-posts/history');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(2);
    const first = res.body.items[res.body.items.length - 1];
    expect(first.truck).toEqual({ id: truck.id, companyName: 'Lone Star Haulers' });
    expect(first.recipients.map((r) => [r.brokerName, r.status]).sort()).toEqual([['Blue Freight', 'replied'], ['Peach Logistics', 'scheduled']]);
    expect((await other.agent.get('/api/truck-posts/history')).body.items).toHaveLength(0);
  });

  it('reload ideas come from the workspace\'s own loads out of the state', async () => {
    const fetchMock = stubCensusCounts();
    const res = await U.agent.get('/api/truck-posts/reload-ideas?state=ga&city=Atlanta&equipment=dry_van');
    expect(res.status).toBe(200);
    expect(res.body.loadsConsidered).toBe(2); // canceled and other users' loads are left out
    expect(res.body.brokers).toHaveLength(1);
    expect(res.body.brokers[0]).toMatchObject({ broker: { id: b1.id, companyName: 'Peach Logistics', email: 'ann@peach.test' }, loads: 2, cityLoads: 2, lastRpm: 2.5 });
    expect(res.body.lanes.map((l) => l.destState).sort()).toEqual(['FL', 'TX']);
    expect(res.body.customerLanes).toEqual([expect.objectContaining({ origin: 'Atlanta, GA', destination: 'Dallas, TX', carrier: expect.objectContaining({ id: truck.id }) })]);
    expect(res.body.fmcsa.state).toMatchObject({ state: 'GA', carriers: 900, brokers: 15 });
    expect(res.body.fmcsa.city).toMatchObject({ city: 'Atlanta' });
    const calls = fetchMock.mock.calls.length;
    await U.agent.get('/api/truck-posts/reload-ideas?state=GA&city=Atlanta');
    expect(fetchMock.mock.calls.length).toBe(calls); // counts are cached
    const theirs = await other.agent.get('/api/truck-posts/reload-ideas?state=GA');
    expect(theirs.body.brokers.map((b) => b.broker.id)).toEqual([foreign.id]);
    expect((await U.agent.get('/api/truck-posts/reload-ideas')).status).toBe(400);
  });

  it('reports FMCSA counts as unavailable when the census fails, without failing the panel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const res = await U.agent.get('/api/truck-posts/reload-ideas?state=TX');
    expect(res.status).toBe(200);
    expect(res.body.fmcsa).toMatchObject({ state: null, error: expect.stringContaining('FMCSA Census error') });
  });
});
