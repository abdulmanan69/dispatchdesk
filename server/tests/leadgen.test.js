import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { clearCensusCache } from '../src/services/carriers/fmcsaCensus.js';
import { setFmcsaFetch } from '../src/services/brokers/fmcsa.js';
import { clearAuthorityCache } from '../src/services/carriers/authority.js';
import { scoreLead, runDueGenerators } from '../src/services/leadgen.js';
import { licensingFake } from './licensingFake.js';

const row = (dot, extra = {}) => ({
  dot_number: String(dot), legal_name: `CARRIER ${dot} LLC`, phone: `61455${String(dot).padStart(5, '0').slice(-5)}`, email_address: `ops${dot}@carrier.test`,
  phy_city: 'COLUMBUS', phy_state: 'OH', phy_zip: '43004', power_units: '3', status_code: 'A', add_date: '20260601',
  carrier_operation: 'A', docket1prefix: 'MC', docket1: String(900000 + Number(dot)), crgo_genfreight: 'X', ...extra,
});

function mockCensus(rows) {
  const fn = vi.fn(async (url) => {
    const offset = Number(new URL(String(url)).searchParams.get('$offset') || 0);
    return { ok: true, status: 200, json: async () => (offset === 0 ? rows : []) };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const criteria = { states: ['OH'], cargo: ['crgo_coldfood'], minPowerUnits: 1, maxPowerUnits: 10, authorityAgeMaxMonths: 24, requirePhone: true, requireMc: true };

async function subscribe(user, planKey) {
  const plan = await prisma.plan.findUnique({ where: { key: planKey } });
  await prisma.subscription.create({ data: { userId: user.id, planId: plan.id, status: 'active', seats: 1 } });
}

describe('lead generator', () => {
  let A; let B; let gen;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    // Every MC answers with active authority and insurance on file (authority rules: carrier-authority.test.js).
    setFmcsaFetch(licensingFake().fetch);
  });
  afterAll(() => setFmcsaFetch(null));
  afterEach(() => { vi.unstubAllGlobals(); clearCensusCache(); clearAuthorityCache(); });

  it('scores leads from real fields with reasons', () => {
    const s = scoreLead({ phone: '1', email: 'a@b.c', mcNumber: '1', authorityStatus: 'active', authorityDate: new Date(), fleetSize: 3 });
    expect(s.score).toBe(100);
    expect(s.reasons).toContain('Small fleet (1–10 trucks)');
    expect(scoreLead({}).score).toBe(0);
  });

  it('exposes plan entitlements and cargo options', async () => {
    const res = await A.agent.get('/api/lead-generators');
    expect(res.status).toBe(200);
    expect(res.body.entitlements).toMatchObject({ planKey: 'free', monthlyLimit: 50, maxGenerators: 1, autoRun: false, usedThisMonth: 0 });
    expect(res.body.cargoOptions.find((o) => o.value === 'crgo_coldfood').label).toBe('Refrigerated food');
  });

  it('validates criteria', async () => {
    const res = await A.agent.post('/api/lead-generators').send({ name: 'x', criteria: { states: [] } });
    expect(res.status).toBe(400);
    const bad = await A.agent.post('/api/lead-generators').send({ name: 'x', criteria: { states: ['OH'], cargo: ['crgo_nope'] } });
    expect(bad.status).toBe(400);
  });

  it('free plan cannot enable scheduled runs', async () => {
    const res = await A.agent.post('/api/lead-generators').send({ name: 'Auto', criteria, autoRun: true });
    expect(res.status).toBe(402);
  });

  it('creates a generator with a new prospect list', async () => {
    const res = await A.agent.post('/api/lead-generators').send({ name: 'Ohio reefers', criteria, batchSize: 3, newListName: 'Ohio reefer leads', minScore: 50 });
    expect(res.status).toBe(201);
    gen = res.body.generator;
    expect(gen.list.name).toBe('Ohio reefer leads');
    expect(gen.criteria.states).toEqual(['OH']);
  });

  it('enforces the generator count limit for the plan', async () => {
    const res = await A.agent.post('/api/lead-generators').send({ name: 'Second', criteria });
    expect(res.status).toBe(402);
  });

  it('preview shows matches without creating carriers', async () => {
    const fetchMock = mockCensus([row(1), row(2)]);
    const res = await A.agent.post('/api/lead-generators/preview').send({ criteria });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].score).toBeGreaterThan(0);
    const where = new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('$where');
    expect(where).toContain("phy_state='OH'");
    expect(where).toContain("(crgo_coldfood='X')");
    expect(where).toContain('phone IS NOT NULL');
    expect(await prisma.carrier.count({ where: { ownerId: A.user.id } })).toBe(0);
  });

  it('preview interleaves states so one state cannot fill the batch', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const where = new URL(String(url)).searchParams.get('$where');
      const st = where.includes("'TX'") ? 'TX' : 'OH';
      const base = st === 'TX' ? 700 : 800;
      return { ok: true, status: 200, json: async () => Array.from({ length: 30 }, (_, i) => row(base + i, { phy_state: st })) };
    }));
    const res = await A.agent.post('/api/lead-generators/preview').send({ criteria: { ...criteria, states: ['TX', 'OH'] } });
    expect(res.body.items).toHaveLength(25);
    expect(res.body.items.filter((x) => x.state === 'OH').length).toBeGreaterThanOrEqual(12);
  });

  it('runs: creates scored, de-duplicated leads, fills the list and counts usage', async () => {
    // existing carrier with DOT 2 must be skipped; DOT 4 has no contact data and falls below minScore 50
    await A.agent.post('/api/carriers').send({ companyName: 'Already have', dotNumber: '2' });
    mockCensus([row(1), row(2), row(3), row(4, { phone: undefined, email_address: undefined, docket1prefix: undefined, add_date: '20000101', power_units: '400' }), row(5), row(6)]);
    const res = await A.agent.post(`/api/lead-generators/${gen.id}/run`);
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ created: 3, skipped: 1, belowScore: 1, status: 'ok' });
    expect(res.body.carriers.map((c) => c.dotNumber).sort()).toEqual(['1', '3', '5']);
    const c = await prisma.carrier.findFirst({ where: { ownerId: A.user.id, dotNumber: '1' }, include: { notes: true } });
    expect(c.source).toBe('lead_generator');
    expect(c.notes[0].body).toMatch(/Lead score \d+\/100/);
    expect(await prisma.prospectListItem.count({ where: { listId: gen.listId } })).toBe(3);
    expect(res.body.entitlements.usedThisMonth).toBe(3);
  });

  it('a second run reports exhaustion honestly', async () => {
    mockCensus([row(1), row(3), row(5)]);
    const res = await A.agent.post(`/api/lead-generators/${gen.id}/run`);
    expect(res.body.run).toMatchObject({ created: 0, status: 'exhausted' });
    expect(res.body.run.message).toMatch(/Widen the criteria/);
  });

  it('stops at the monthly plan limit', async () => {
    const free = await prisma.plan.findUnique({ where: { key: 'free' } });
    await prisma.leadGenRun.create({ data: { ownerId: A.user.id, created: free.monthlyLeadGenLimit - 4, trigger: 'manual' } });
    mockCensus([row(11), row(12), row(13), row(14)]);
    await A.agent.patch(`/api/lead-generators/${gen.id}`).send({ batchSize: 10, minScore: 0 });
    const res = await A.agent.post(`/api/lead-generators/${gen.id}/run`);
    expect(res.body.run.created).toBe(1);
    expect(res.body.run.status).toBe('limited');
    const blocked = await A.agent.post(`/api/lead-generators/${gen.id}/run`);
    expect(blocked.status).toBe(402);
  });

  it('records census failures as an error run without inventing leads', async () => {
    const P = await registerUser();
    const g = (await P.agent.post('/api/lead-generators').send({ name: 'TX', criteria: { states: ['TX'] } })).body.generator;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ message: 'boom' }) })));
    const res = await P.agent.post(`/api/lead-generators/${g.id}/run`);
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ status: 'error', created: 0 });
    expect(res.body.run.message).toMatch(/FMCSA Census error/);
  });

  it('a failed census request stops the crawl: no new state requests start, at most 3 run at once', async () => {
    const P = await registerUser();
    const states = ['TX', 'OK', 'AR', 'LA', 'NM', 'KS'];
    const g = (await P.agent.post('/api/lead-generators').send({ name: 'South', criteria: { states } })).body.generator;
    let inFlight = 0;
    let peak = 0;
    const asked = [];
    const fetchMock = vi.fn(async (url) => {
      const st = /phy_state='([A-Z]{2})'/.exec(decodeURIComponent(String(url)))?.[1];
      asked.push(st);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, st === 'TX' ? 5 : 40));
      inFlight--;
      return st === 'TX'
        ? { ok: false, status: 500, json: async () => ({ message: 'boom' }) }
        : { ok: true, status: 200, json: async () => [] };
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await P.agent.post(`/api/lead-generators/${g.id}/run`);
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ status: 'error', created: 0 });
    // Requests that were already running finished before the run returned; nothing new starts afterwards.
    expect(inFlight).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect([...asked].sort()).toEqual(['AR', 'OK', 'TX']);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('generated priority leads appear only in the owner call queue', async () => {
    const mine = (await A.agent.get('/api/prospecting/queue')).body.items.filter((i) => i.kind === 'hot');
    expect(mine.length).toBeGreaterThan(0);
    const theirs = (await B.agent.get('/api/prospecting/queue')).body.items;
    expect(theirs.some((i) => i.carrier.ownerId === A.user.id || mine.some((m) => m.carrier.id === i.carrier.id))).toBe(false);
  });

  it('isolates generators between users', async () => {
    expect((await B.agent.post(`/api/lead-generators/${gen.id}/run`)).status).toBe(404);
    expect((await B.agent.patch(`/api/lead-generators/${gen.id}`).send({ name: 'x' })).status).toBe(404);
    expect((await B.agent.get('/api/lead-generators')).body.items).toHaveLength(0);
    expect((await B.agent.get(`/api/lead-generators/runs?generatorId=${gen.id}`)).body.items).toHaveLength(0);
  });

  it('paid plans can schedule runs; the scheduler runs due generators', async () => {
    const P = await registerUser();
    await subscribe(P.user, 'pro');
    const ent = (await P.agent.get('/api/lead-generators')).body.entitlements;
    expect(ent).toMatchObject({ planKey: 'pro', autoRun: true, monthlyLimit: 2000, maxGenerators: 10 });
    const g = (await P.agent.post('/api/lead-generators').send({ name: 'Daily OH', criteria, autoRun: true, frequency: 'daily', batchSize: 2 })).body.generator;
    expect(g.autoRun).toBe(true);
    expect(new Date(g.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    await prisma.leadGenerator.update({ where: { id: g.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    mockCensus([row(21), row(22), row(23)]);
    expect(await runDueGenerators()).toBe(1);
    const runs = (await P.agent.get('/api/lead-generators/runs')).body.items;
    expect(runs[0]).toMatchObject({ trigger: 'scheduled', created: 2, generatorName: 'Daily OH' });
    const n = await prisma.notification.findFirst({ where: { userId: P.user.id, type: 'lead_generator' } });
    expect(n.title).toMatch(/2 new lead/);
    const after = await prisma.leadGenerator.findUnique({ where: { id: g.id } });
    expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('pauses scheduled runs when the plan no longer allows them', async () => {
    const P = await registerUser();
    const g = await prisma.leadGenerator.create({ data: { ownerId: P.user.id, name: 'Old auto', criteria: JSON.stringify(criteria), autoRun: true, nextRunAt: new Date(Date.now() - 1000) } });
    const fetchMock = mockCensus([row(31)]);
    await runDueGenerators();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await prisma.leadGenerator.findUnique({ where: { id: g.id } })).autoRun).toBe(false);
  });

  it('enrolls generated leads in the linked sequence (owner-scoped)', async () => {
    const P = await registerUser();
    const seq = (await P.agent.post('/api/sequences').send({ name: 'Gen seq', steps: [{ dayOffset: 0, type: 'call' }] })).body.sequence;
    const foreign = (await B.agent.post('/api/sequences').send({ name: 'Not yours', steps: [{ dayOffset: 0, type: 'call' }] })).body.sequence;
    const denied = await P.agent.post('/api/lead-generators').send({ name: 'X', criteria, sequenceId: foreign.id });
    expect(denied.status).toBe(400);
    const g = (await P.agent.post('/api/lead-generators').send({ name: 'Seq gen', criteria, batchSize: 2, sequenceId: seq.id })).body.generator;
    expect(g.sequence).toMatchObject({ id: seq.id, name: 'Gen seq' });
    mockCensus([row(41), row(42)]);
    const res = await P.agent.post(`/api/lead-generators/${g.id}/run`);
    expect(res.body.run.created).toBe(2);
    expect(res.body.run.message).toMatch(/Enrolled 2 in "Gen seq"/);
    expect(await prisma.sequenceEnrollment.count({ where: { sequenceId: seq.id, status: 'active' } })).toBe(2);
    const cleared = await P.agent.patch(`/api/lead-generators/${g.id}`).send({ sequenceId: null });
    expect(cleared.body.generator.sequenceId).toBeNull();
  });

  it('public plans list the lead generator entitlement', async () => {
    const plans = (await A.agent.get('/api/billing/plans')).body.plans;
    const pro = plans.find((p) => p.key === 'pro');
    expect(pro.limits.monthlyLeadGenLimit).toBe(2000);
    expect(pro.features.some((f) => f.startsWith('Lead generator: 2,000 leads / month'))).toBe(true);
  });
});
