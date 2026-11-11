import { describe, it, expect, beforeAll } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { generateForTemplate, runRecurringLoads, planDays, loadTimes, MAX_TEMPLATES } from '../src/services/loads/templates.js';
import { localParts } from '../src/lib/timezones.js';

const fields = { originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', loadedMiles: 780, rateCents: 210000, equipment: 'dry_van' };

async function carrierFor(user, name = 'Lane Carrier') {
  const stage = await prisma.pipelineStage.findUnique({ where: { key: 'prospecting' } });
  return prisma.carrier.create({ data: { ownerId: user.id, stageId: stage.id, companyName: `${name} ${Math.random().toString(36).slice(2, 7)}` } });
}

/** A template row written directly (the job's view of it), with the owner's id. */
async function makeTemplate(ownerId, data = {}) {
  return prisma.loadTemplate.create({
    data: {
      ownerId, name: 'Lane', fields: JSON.stringify({ ...fields, ...(data.fields || {}) }),
      weekdays: '1,3,5', pickupTime: '08:00', leadDays: 7, active: true, ...data, ...(data.fields ? { fields: JSON.stringify({ ...fields, ...data.fields }) } : {}),
    },
  });
}
const loadsOf = (templateId) => prisma.load.findMany({ where: { templateId }, orderBy: { pickupDate: 'asc' } });
const reload = (id) => prisma.loadTemplate.findUnique({ where: { id } });

describe('load templates API', () => {
  let A;
  let B;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
  });

  it('validates fields with the load rules', async () => {
    const bad = [
      { name: 'x', fields: { ...fields, originCity: '' } },
      { name: 'x', fields: { ...fields, originState: 'Texas' } },
      { name: 'x', fields: { ...fields, loadedMiles: 0 } },
      { name: 'x', fields: { ...fields, equipment: 'spaceship' } },
      { name: 'x', fields: { ...fields, pickupWindowStart: '8am' } },
    ];
    for (const body of bad) expect((await A.agent.post('/api/load-templates').send(body)).status).toBe(400);
    expect((await A.agent.post('/api/load-templates').send({ name: '', fields })).status).toBe(400);
    expect((await A.agent.post('/api/load-templates').send({ name: 'x', fields, weekdays: [1, 7], pickupTime: '08:00' })).status).toBe(400);
    expect((await A.agent.post('/api/load-templates').send({ name: 'x', fields, weekdays: [1], pickupTime: '25:00' })).status).toBe(400);
    expect((await A.agent.post('/api/load-templates').send({ name: 'x', fields, weekdays: [1], pickupTime: '08:00', leadDays: 31 })).status).toBe(400);
    const noTime = await A.agent.post('/api/load-templates').send({ name: 'x', fields, weekdays: [1] });
    expect(noTime.status).toBe(400);
    expect(noTime.body.error || noTime.body.message).toMatch(/pickup time/i);
    const early = await A.agent.post('/api/load-templates').send({ name: 'x', fields: { ...fields, pickupWindowStart: '10:00', deliveryWindowStart: '06:00' } });
    expect(early.status).toBe(400);
  });

  it('creates, lists, updates and deletes a template scoped to its owner', async () => {
    const created = await A.agent.post('/api/load-templates').send({
      name: 'Dallas to Atlanta', fields: { ...fields, referenceNumber: 'DROP-ME', status: 'paid', pickupWindowStart: '08:00', deliveryWindowStart: '07:00', transitDays: 1, notes: 'Dock 4' },
    });
    expect(created.status).toBe(201);
    const t = created.body.template;
    expect(t).toMatchObject({ name: 'Dallas to Atlanta', recurring: false, active: true, leadDays: 7 });
    expect(t.fields).toMatchObject({ originCity: 'Dallas', pickupTz: 'America/Chicago', deliveryTz: 'America/New_York', transitDays: 1, notes: 'Dock 4' });
    expect(t.fields.referenceNumber).toBeUndefined();
    expect(t.fields.status).toBeUndefined();
    expect(created.body.generated).toBe(0);

    const list = await A.agent.get('/api/load-templates');
    expect(list.status).toBe(200);
    expect(list.body.items.map((x) => x.id)).toContain(t.id);
    expect(list.body.max).toBe(MAX_TEMPLATES);
    expect((await B.agent.get('/api/load-templates')).body.items.map((x) => x.id)).not.toContain(t.id);

    expect((await B.agent.get(`/api/load-templates/${t.id}`)).status).toBe(404);
    expect((await B.agent.patch(`/api/load-templates/${t.id}`).send({ name: 'Mine now' })).status).toBe(404);
    expect((await B.agent.delete(`/api/load-templates/${t.id}`)).status).toBe(404);

    const renamed = await A.agent.patch(`/api/load-templates/${t.id}`).send({ name: 'Renamed', fields: { ...fields, originCity: 'El Paso' } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.template.name).toBe('Renamed');
    expect(renamed.body.template.fields.pickupTz).toBe('America/Denver');
    expect(renamed.body.template.fields.notes).toBeUndefined();

    const load = await prisma.load.create({ data: { ownerId: A.user.id, templateId: t.id, originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', loadedMiles: 1, rateCents: 1 } });
    expect((await A.agent.delete(`/api/load-templates/${t.id}`)).status).toBe(200);
    expect(await reload(t.id)).toBeNull();
    expect((await prisma.load.findUnique({ where: { id: load.id } })).templateId).toBeNull();
    expect((await A.agent.get(`/api/load-templates/${t.id}`)).status).toBe(404);
  });

  it('never stores a carrier or broker the user cannot access', async () => {
    const theirs = await carrierFor(B.user);
    const theirBroker = await prisma.broker.create({ data: { ownerId: B.user.id, companyName: 'Other Broker' } });
    expect((await A.agent.post('/api/load-templates').send({ name: 'x', fields, carrierId: theirs.id })).status).toBe(404);
    expect((await A.agent.post('/api/load-templates').send({ name: 'x', fields, brokerId: theirBroker.id })).status).toBe(404);
    const mine = await carrierFor(A.user);
    const ok = await A.agent.post('/api/load-templates').send({ name: 'With carrier', fields, carrierId: mine.id });
    expect(ok.status).toBe(201);
    expect(ok.body.template.carrier).toMatchObject({ id: mine.id, companyName: mine.companyName });
    expect((await A.agent.patch(`/api/load-templates/${ok.body.template.id}`).send({ carrierId: theirs.id })).status).toBe(404);
    expect((await reload(ok.body.template.id)).carrierId).toBe(mine.id);
  });

  it(`keeps at most ${MAX_TEMPLATES} templates per user`, async () => {
    const C = await registerUser();
    await prisma.loadTemplate.createMany({ data: Array.from({ length: MAX_TEMPLATES }, (_, i) => ({ ownerId: C.user.id, name: `T${i}`, fields: JSON.stringify(fields) })) });
    const res = await C.agent.post('/api/load-templates').send({ name: 'One too many', fields });
    expect(res.status).toBe(400);
    expect(res.body.details?.code || res.body.code).toBe('TEMPLATE_LIMIT');
    expect((await C.agent.get('/api/load-templates')).body.items).toHaveLength(MAX_TEMPLATES);
  });

  it('a dedicated lane creates its planned loads as soon as it is saved', async () => {
    const res = await A.agent.post('/api/load-templates').send({
      name: 'Daily lane', fields: { ...fields, pickupWindowEnd: '10:00' }, weekdays: [0, 1, 2, 3, 4, 5, 6], pickupTime: '23:59', leadDays: 3,
    });
    expect(res.status).toBe(201);
    expect(res.body.template).toMatchObject({ recurring: true, weekdays: [0, 1, 2, 3, 4, 5, 6], pickupTime: '23:59' });
    expect(res.body.template.nextPickupAt).toBeTruthy();
    expect(res.body.generated).toBeGreaterThanOrEqual(3);
    expect(res.body.generated).toBeLessThanOrEqual(4);
    const loads = await loadsOf(res.body.template.id);
    expect(loads).toHaveLength(res.body.generated);
    for (const l of loads) {
      expect(l).toMatchObject({ ownerId: A.user.id, status: 'planned', originCity: 'Dallas', rateCents: 210000, pickupTz: 'America/Chicago' });
      expect(localParts('America/Chicago', l.pickupWindowStart).label).toBe('23:59');
      // 10:00 is before 23:59, so the window runs into the next morning.
      expect(localParts('America/Chicago', l.pickupWindowEnd).label).toBe('10:00');
      expect(l.pickupWindowEnd > l.pickupWindowStart).toBe(true);
    }
    // Pausing and editing never duplicates a day.
    await A.agent.patch(`/api/load-templates/${res.body.template.id}`).send({ active: false });
    const again = await A.agent.patch(`/api/load-templates/${res.body.template.id}`).send({ active: true });
    expect(again.body.generated).toBe(0);
    expect(await loadsOf(res.body.template.id)).toHaveLength(loads.length);
  });
});

describe('recurring load generation', () => {
  let U;
  beforeAll(async () => { U = await registerUser(); });
  const MON = new Date('2026-11-16T12:00:00Z'); // Monday 05:00 in El Paso (MST)

  it('creates loads on the weekdays in the pickup zone, leadDays ahead, and never twice', async () => {
    const t = await makeTemplate(U.user.id, { fields: { originCity: 'El Paso', originState: 'TX' } });
    expect(await generateForTemplate(t, { now: MON })).toBe(4); // Mon 16, Wed 18, Fri 20, Mon 23
    let loads = await loadsOf(t.id);
    expect(loads.map((l) => l.pickupWindowStart.toISOString())).toEqual([
      '2026-11-16T15:00:00.000Z', '2026-11-18T15:00:00.000Z', '2026-11-20T15:00:00.000Z', '2026-11-23T15:00:00.000Z',
    ]);
    expect(loads.every((l) => l.status === 'planned' && l.pickupTz === 'America/Denver' && l.templateId === t.id)).toBe(true);
    expect(loads[0].pickupDate.toISOString()).toBe('2026-11-16T19:00:00.000Z'); // noon at the facility
    const after = await reload(t.id);
    expect(after.generatedTo.toISOString()).toBe('2026-11-24T07:00:00.000Z'); // local midnight after Mon 23
    expect(after.lastRunAt.toISOString()).toBe(MON.toISOString());

    // Same time again: nothing new. Forgetting generatedTo: the day check still finds every load.
    expect(await generateForTemplate(after, { now: MON })).toBe(0);
    await prisma.loadTemplate.update({ where: { id: t.id }, data: { generatedTo: null } });
    expect(await generateForTemplate(await reload(t.id), { now: MON })).toBe(0);
    expect(await loadsOf(t.id)).toHaveLength(4);

    // A stale copy of the template (another run already moved it) does nothing.
    expect(await generateForTemplate(t, { now: MON })).toBeNull();

    // Two days later the window reaches Wed 25.
    expect(await generateForTemplate(await reload(t.id), { now: new Date('2026-11-18T12:00:00Z') })).toBe(1);
    loads = await loadsOf(t.id);
    expect(loads.at(-1).pickupWindowStart.toISOString()).toBe('2026-11-25T15:00:00.000Z');
  });

  it('uses the local weekday for late pickups and skips pickups already past', async () => {
    const la = await makeTemplate(U.user.id, { weekdays: '1', pickupTime: '23:30', fields: { originCity: 'Los Angeles', originState: 'CA', destCity: 'Phoenix', destState: 'AZ' } });
    expect(await generateForTemplate(la, { now: MON })).toBe(2);
    const loads = await loadsOf(la.id);
    // Monday 23:30 PST is Tuesday in UTC.
    expect(loads.map((l) => l.pickupWindowStart.toISOString())).toEqual(['2026-11-17T07:30:00.000Z', '2026-11-24T07:30:00.000Z']);
    expect(loads.every((l) => localParts('America/Los_Angeles', l.pickupWindowStart).weekday === 'Mon')).toBe(true);

    const late = await makeTemplate(U.user.id, { fields: { originCity: 'El Paso', originState: 'TX' } });
    expect(await generateForTemplate(late, { now: new Date('2026-11-16T20:00:00Z') })).toBe(3); // 08:00 today already passed
    expect((await loadsOf(late.id))[0].pickupWindowStart.toISOString()).toBe('2026-11-18T15:00:00.000Z');
  });

  it('respects leadDays and keeps local times across the DST change', async () => {
    const short = await makeTemplate(U.user.id, { weekdays: '0,1,2,3,4,5,6', leadDays: 2, fields: { originCity: 'El Paso', originState: 'TX' } });
    expect(await generateForTemplate(short, { now: MON })).toBe(3); // today + 2 days

    const dst = await makeTemplate(U.user.id, { weekdays: '0,1,2,3,4,5,6', leadDays: 5, fields: { originCity: 'El Paso', originState: 'TX' } });
    expect(await generateForTemplate(dst, { now: new Date('2026-10-29T12:00:00Z') })).toBe(6);
    const iso = (await loadsOf(dst.id)).map((l) => l.pickupWindowStart.toISOString());
    expect(iso[0]).toBe('2026-10-29T14:00:00.000Z'); // 08:00 MDT
    expect(iso.at(-1)).toBe('2026-11-03T15:00:00.000Z'); // 08:00 MST
  });

  it('sets delivery from transit days in the delivery zone', () => {
    const times = loadTimes({ transitDays: 1, deliveryWindowStart: '06:00', deliveryWindowEnd: '14:00', pickupWindowEnd: '10:00' }, {
      ymd: '2026-11-16', pickupTime: '08:00', pickupTz: 'America/Chicago', deliveryTz: 'America/New_York',
    });
    expect(times.pickupWindowStart.toISOString()).toBe('2026-11-16T14:00:00.000Z');
    expect(times.pickupWindowEnd.toISOString()).toBe('2026-11-16T16:00:00.000Z');
    expect(times.deliveryWindowStart.toISOString()).toBe('2026-11-17T11:00:00.000Z');
    expect(times.deliveryWindowEnd.toISOString()).toBe('2026-11-17T19:00:00.000Z');
    expect(times.deliveryDate.toISOString()).toBe('2026-11-17T17:00:00.000Z');
    const none = loadTimes({}, { ymd: '2026-11-16', pickupTime: '08:00', pickupTz: 'America/Chicago', deliveryTz: 'America/Chicago' });
    expect(none.deliveryDate).toBeNull();
    expect(planDays({ weekdays: [], pickupTime: '08:00', leadDays: 7, tz: 'America/Chicago', generatedTo: null, now: MON }).days).toEqual([]);
  });

  it('the hourly job skips paused templates and drops references the owner lost', async () => {
    const V = await registerUser();
    const paused = await makeTemplate(V.user.id, { active: false });
    const other = await registerUser();
    const foreign = await carrierFor(other.user);
    const lost = await makeTemplate(V.user.id, { carrierId: foreign.id });
    const out = await runRecurringLoads(MON);
    expect(out.failed).toBe(0);
    expect(out.templates).toBeGreaterThanOrEqual(1);
    expect(await loadsOf(paused.id)).toHaveLength(0);
    expect((await reload(paused.id)).generatedTo).toBeNull();
    const made = await loadsOf(lost.id);
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((l) => l.carrierId === null)).toBe(true);
    expect((await reload(lost.id)).carrierId).toBeNull();
    // Up to date: a second run in the same hour does not touch it.
    const before = (await reload(lost.id)).generatedTo.toISOString();
    await runRecurringLoads(MON);
    expect((await reload(lost.id)).generatedTo.toISOString()).toBe(before);
    expect(await loadsOf(lost.id)).toHaveLength(made.length);
  });
});

describe('loads list: calendar range and board columns', () => {
  let A;
  let B;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
  });
  const base = { originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', loadedMiles: 800, rateCents: 200000 };
  const mk = (owner, data) => prisma.load.create({ data: { ownerId: owner.user.id, ...base, ...data } });

  it('returns loads picked up or delivered in the range, light rows only, owner scoped', async () => {
    const inPickup = await mk(A, { pickupDate: new Date('2027-03-10T17:00:00Z'), referenceNumber: 'IN-P' });
    const inDelivery = await mk(A, { pickupDate: new Date('2027-02-27T17:00:00Z'), deliveryDate: new Date('2027-03-01T17:00:00Z'), referenceNumber: 'IN-D' });
    const outside = await mk(A, { pickupDate: new Date('2027-04-10T17:00:00Z') });
    const canceled = await mk(A, { pickupDate: new Date('2027-03-12T17:00:00Z'), status: 'canceled' });
    await mk(B, { pickupDate: new Date('2027-03-10T17:00:00Z') });

    const res = await A.agent.get('/api/loads?view=calendar&from=2027-03-01&to=2027-03-31');
    expect(res.status).toBe(200);
    const ids = res.body.items.map((l) => l.id);
    expect(ids.sort()).toEqual([inPickup.id, inDelivery.id].sort());
    expect(ids).not.toContain(outside.id);
    expect(res.body.tooMany).toBe(false);
    const row = res.body.items.find((l) => l.id === inPickup.id);
    expect(row).toMatchObject({ referenceNumber: 'IN-P', status: 'planned', ratePerMile: 2.5 });
    expect(row.notes).toBeUndefined();
    expect(row.fitWarnings).toBeUndefined();

    const withCanceled = await A.agent.get('/api/loads?view=calendar&from=2027-03-01&to=2027-03-31&canceled=true');
    expect(withCanceled.body.items.map((l) => l.id)).toContain(canceled.id);
    expect((await A.agent.get('/api/loads?view=calendar&from=2027-03-01&to=2027-03-31&status=canceled')).body.items.map((l) => l.id)).toEqual([canceled.id]);

    expect((await A.agent.get('/api/loads?view=calendar&from=2027-03-01')).status).toBe(400);
    expect((await A.agent.get('/api/loads?view=calendar&from=2027-01-01&to=2027-06-30')).status).toBe(400);
    expect((await A.agent.get('/api/loads?view=calendar&from=2027-03-31&to=2027-03-01')).status).toBe(400);
  });

  it('caps the calendar at 500 loads and says so', async () => {
    const C = await registerUser();
    const day = new Date('2027-05-05T17:00:00Z');
    await prisma.load.createMany({ data: Array.from({ length: 501 }, () => ({ ownerId: C.user.id, ...base, pickupDate: day })) });
    const res = await C.agent.get('/api/loads?view=calendar&from=2027-05-01&to=2027-05-31');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(500);
    expect(res.body.tooMany).toBe(true);
    expect(res.body.cap).toBe(500);
  });

  it('board: one column per status with totals, and a single column page for "load more"', async () => {
    const D = await registerUser();
    for (let i = 0; i < 3; i += 1) await mk(D, { status: 'booked', pickupDate: new Date(Date.UTC(2027, 0, 10 + i, 17)), referenceNumber: `BK${i}` });
    await mk(D, { status: 'paid' });
    await mk(D, { status: 'canceled' });
    const res = await D.agent.get('/api/loads?view=board');
    expect(res.status).toBe(200);
    expect(res.body.columns.map((c) => c.status)).toEqual(['planned', 'booked', 'in_transit', 'delivered', 'invoiced', 'paid']);
    const booked = res.body.columns.find((c) => c.status === 'booked');
    expect(booked.total).toBe(3);
    expect(booked.items.map((l) => l.referenceNumber)).toEqual(['BK0', 'BK1', 'BK2']); // soonest pickup first
    expect(booked.items[0].docs).toEqual({ rateCon: false, bol: false, pod: false });
    expect(booked.pageSize).toBe(50);

    const more = await D.agent.get('/api/loads?view=board&status=booked&page=2&pageSize=2');
    expect(more.body.columns).toHaveLength(1);
    expect(more.body.columns[0]).toMatchObject({ status: 'booked', total: 3, page: 2 });
    expect(more.body.columns[0].items.map((l) => l.referenceNumber)).toEqual(['BK2']);

    const all = await D.agent.get('/api/loads?view=board&canceled=true');
    expect(all.body.columns.at(-1)).toMatchObject({ status: 'canceled', total: 1 });
    expect((await B.agent.get('/api/loads?view=board')).body.columns.every((c) => c.items.every((l) => l.ownerId === B.user.id))).toBe(true);
  });
});
