import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { clearCensusCache } from '../src/services/carriers/fmcsaCensus.js';
import { setFmcsaFetch } from '../src/services/brokers/fmcsa.js';
import { clearAuthorityCache } from '../src/services/carriers/authority.js';
import { stageByKey } from '../src/services/pipeline.js';
import { criteriaHash } from '../src/services/leadgen.js';
import { licensingFake, INACTIVE_ROW } from './licensingFake.js';

/*
 * Lead generator crawl cursor: each run continues each state's census list where the last run stopped, scans the head
 * of the list for carriers added since, and restarts from the top after reaching the end. Census and licensing are
 * fakes (no FMCSA request leaves the test).
 */

const DAY = 86400000;
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const censusRow = (state, dot, addDate, extra = {}) => ({
  dot_number: String(dot), legal_name: `CARRIER ${dot} LLC`, phone: `614555${String(dot).slice(-4)}`, email_address: `ops${dot}@carrier.test`,
  phy_city: 'AUSTIN', phy_state: state, phy_zip: '73301', power_units: '3', status_code: 'A', add_date: addDate,
  carrier_operation: 'A', docket1prefix: 'MC', docket1: String(dot + 1000000), crgo_genfreight: 'X', ...extra,
});
/** A state's census list as the API orders it: newest add date first (10 carriers a day), dot number ascending. */
const stateList = (state, n, dotBase, newest = '2026-10-01') => {
  const top = new Date(`${newest}T00:00:00Z`).getTime();
  return Array.from({ length: n }, (_, i) => censusRow(state, dotBase + i, ymd(new Date(top - Math.floor(i / 10) * DAY))));
};

/** Census fake serving `lists[state]` with $offset/$limit; records each request's state and offset. */
function censusFake(lists) {
  const calls = [];
  const fn = vi.fn(async (url) => {
    const u = new URL(String(url));
    const state = /phy_state='([A-Z]{2})'/.exec(u.searchParams.get('$where') || '')?.[1];
    const offset = Number(u.searchParams.get('$offset') || 0);
    const limit = Number(u.searchParams.get('$limit') || 50);
    calls.push({ state, offset });
    const rows = (lists[state] || []).slice(offset, offset + limit);
    return { ok: true, status: 200, json: async () => rows };
  });
  vi.stubGlobal('fetch', fn);
  return { calls, offsets: (state) => calls.filter((c) => c.state === state).map((c) => c.offset), reset: () => { calls.length = 0; } };
}

async function proUser() {
  const P = await registerUser();
  const plan = await prisma.plan.findUnique({ where: { key: 'pro' } });
  await prisma.subscription.create({ data: { userId: P.user.id, planId: plan.id, status: 'active', seats: 1 } });
  return P;
}

/** Put census rows in the user's CRM already (the lead generator skips them). */
async function inCrm(user, rows) {
  const stage = await stageByKey('lead');
  await prisma.carrier.createMany({
    data: rows.map((r) => ({ ownerId: user.id, stageId: stage.id, companyName: r.legal_name, dotNumber: r.dot_number, mcNumber: r.docket1 })),
  });
}

async function generator(P, name, criteria, extra = {}) {
  const res = await P.agent.post('/api/lead-generators').send({ name, criteria, batchSize: 10, minScore: 0, ...extra });
  expect(res.status).toBe(201);
  return res.body.generator;
}

const cursorOf = async (id) => JSON.parse((await prisma.leadGenerator.findUnique({ where: { id } })).cursor || 'null');
const run = async (P, g) => {
  const res = await P.agent.post(`/api/lead-generators/${g.id}/run`);
  expect(res.status).toBe(200);
  return res.body;
};
const TX = { states: ['TX'], requirePhone: true, requireMc: true };
const WIDEN = 'Widen the filters (more states, a longer authority age range, fewer contact requirements) to find more.';

describe('lead generator crawl cursor', () => {
  let fake;
  beforeAll(() => {
    fake = licensingFake();
    setFmcsaFetch(fake.fetch);
  });
  afterAll(() => setFmcsaFetch(null));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearCensusCache();
    clearAuthorityCache();
    fake.down = false;
    fake.rows = {};
  });

  describe('a big state whose newest 1,000 carriers are already in the CRM', () => {
    let P; let g; let census; let lists;
    beforeAll(async () => {
      P = await proUser();
      lists = { TX: stateList('TX', 1200, 5000000) };
      await inCrm(P.user, lists.TX.slice(0, 1000));
      g = await generator(P, 'Texas', TX);
    });

    it('first run reads 5 pages (1,000 rows), adds nothing and says the next run continues', async () => {
      census = censusFake(lists);
      const { run: r } = await run(P, g);
      expect(r).toMatchObject({ status: 'ok', created: 0, scanned: 1000, skipped: 1000 });
      expect(r.message).toBe('Added 0 new leads. Read 1,000 carriers this run; the next run continues where this one stopped.');
      expect(r.message).not.toMatch(/600/);
      expect(census.offsets('TX')).toEqual([0, 200, 400, 600, 800]);
      expect(await cursorOf(g.id)).toEqual({
        v: 1, criteriaHash: criteriaHash(TX, 0), states: { TX: { deepOffset: 1000, headSeenAt: '2026-10-01', exhaustedAt: null } },
      });
    });

    it('second run continues past the rows the first run read and creates new leads', async () => {
      census = censusFake(lists);
      const res = await run(P, g);
      expect(res.run).toMatchObject({ status: 'ok', created: 10, message: null });
      // Head scan of the newest day (already read, all in the CRM), then the deep scan from offset 1000.
      expect(census.offsets('TX')).toEqual([0, 1000]);
      expect(res.carriers.map((c) => Number(c.dotNumber)).sort()).toEqual(Array.from({ length: 10 }, (_, i) => 5001000 + i));
      // Rows verified but not picked (batch full) are read again next run.
      expect((await cursorOf(g.id)).states.TX).toMatchObject({ deepOffset: 1010, headSeenAt: '2026-10-01' });
    });

    it('the head scan picks up a carrier added at the top between runs', async () => {
      lists.TX.unshift(censusRow('TX', 5900000, '20261002'));
      census = censusFake(lists);
      const res = await run(P, g);
      expect(res.run.created).toBe(10);
      const dots = res.carriers.map((c) => c.dotNumber);
      expect(dots).toContain('5900000');
      // The new top row pushed the list down by one: the deep scan reads one row again (skipped), nothing is missed.
      expect(dots.filter((d) => d !== '5900000').map(Number).sort()).toEqual(Array.from({ length: 9 }, (_, i) => 5001010 + i));
      expect(census.offsets('TX')).toEqual([0, 1010]);
      expect((await cursorOf(g.id)).states.TX).toMatchObject({ deepOffset: 1020, headSeenAt: '2026-10-02' });
    });

    it('reaching the end says how many carriers match in all and what this run read, never 600', async () => {
      await P.agent.patch(`/api/lead-generators/${g.id}`).send({ batchSize: 200 }).expect(200);
      census = censusFake(lists);
      const { run: r } = await run(P, g);
      // 1,201 rows in the list; 1,020 handled by earlier runs; this run: the new top row (skipped) and the last 181.
      expect(r).toMatchObject({ status: 'exhausted', created: 181, skipped: 1, scanned: 182 });
      expect(r.message).toBe(`Added 181 new leads. All 1,201 carriers matching these filters were checked; this run read 182: 1 already in your CRM. ${WIDEN}`);
      expect(census.offsets('TX')).toEqual([0, 1020]);
      const cur = (await cursorOf(g.id)).states.TX;
      expect(cur).toMatchObject({ deepOffset: 0, headSeenAt: '2026-10-02' });
      expect(Date.now() - new Date(cur.exhaustedAt).getTime()).toBeLessThan(60_000);
    });

    it('after the end, the next run starts the deep scan again from the top', async () => {
      census = censusFake(lists);
      const { run: r } = await run(P, g);
      expect(census.offsets('TX')).toEqual([0, 200, 400, 600, 800]);
      expect(r).toMatchObject({ status: 'ok', created: 0, scanned: 1000, skipped: 1000 });
      expect(r.message).toMatch(/the next run continues where this one stopped\.$/);
      expect((await cursorOf(g.id)).states.TX.deepOffset).toBe(1000);
    });
  });

  it('a small state: the message lists the real counts of every matching carrier and never says 600', async () => {
    const P = await registerUser();
    const rows = stateList('OH', 14, 7100000);
    await inCrm(P.user, rows.slice(0, 9));
    for (const r of rows.slice(9)) fake.rows[r.docket1] = INACTIVE_ROW;
    const census = censusFake({ OH: rows });
    const g = await generator(P, 'Ohio', { ...TX, states: ['OH'] });
    const { run: r } = await run(P, g);
    expect(r).toMatchObject({ status: 'exhausted', created: 0, scanned: 14, skipped: 9, belowScore: 0, inactiveAuthority: 5 });
    expect(r.message).toBe(`All 14 carriers matching these filters were checked: 9 already in your CRM, 5 authority not active. ${WIDEN}`);
    expect(r.message).not.toMatch(/600/);
    expect(census.offsets('OH')).toEqual([0]);
    const history = (await P.agent.get('/api/lead-generators/runs')).body.items;
    expect(history[0]).toMatchObject({ status: 'exhausted', inactiveAuthority: 5, message: r.message });
    const cur = (await cursorOf(g.id)).states.OH;
    expect(cur.deepOffset).toBe(0);
    expect(cur.exhaustedAt).toBeTruthy();
  });

  it('a head scan that reaches the end of a short list ends that state without another request', async () => {
    const P = await registerUser();
    const rows = stateList('NM', 25, 7200000);
    await inCrm(P.user, rows);
    const census = censusFake({ NM: rows });
    const g = await generator(P, 'New Mexico', { ...TX, states: ['NM'] });
    const NM = { ...TX, states: ['NM'] };
    await prisma.leadGenerator.update({ where: { id: g.id }, data: { cursor: JSON.stringify({ v: 1, criteriaHash: criteriaHash(NM, 0), states: { NM: { deepOffset: 40, headSeenAt: '2026-09-01', exhaustedAt: null } } }) } });
    const { run: r } = await run(P, g);
    expect(census.offsets('NM')).toEqual([0]);
    expect(r).toMatchObject({ status: 'exhausted', created: 0, scanned: 25, skipped: 25 });
    expect(r.message).toBe(`All 25 carriers matching these filters were checked: 25 already in your CRM. ${WIDEN}`);
    expect((await cursorOf(g.id)).states.NM).toMatchObject({ deepOffset: 0, headSeenAt: '2026-10-01' });
  });

  it('old run messages are shown without the "first 600 census records" claim', async () => {
    const P = await registerUser();
    await prisma.leadGenRun.create({ data: { ownerId: P.user.id, status: 'exhausted', message: 'Found 0 new lead(s); no more matches in the first 600 census records per state. Widen the criteria for more. 5 skipped: authority not active.' } });
    const [old] = (await P.agent.get('/api/lead-generators/runs')).body.items;
    expect(old.message).toBe('Found 0 new lead(s); no more matches this run. Widen the filters to find more. 5 skipped: authority not active.');
    expect(old.inactiveAuthority).toBe(5);
  });

  it('two states interleave fairly and each keeps its own position', async () => {
    const P = await proUser();
    const lists = { TX: stateList('TX', 400, 5100000), OK: stateList('OK', 400, 5200000) };
    const g = await generator(P, 'TX + OK', { ...TX, states: ['TX', 'OK'] }, { batchSize: 20 });
    let census = censusFake(lists);
    const first = await run(P, g);
    expect(first.run.created).toBe(20);
    expect(first.carriers.filter((c) => c.state === 'TX')).toHaveLength(10);
    expect(first.carriers.filter((c) => c.state === 'OK')).toHaveLength(10);
    expect((await cursorOf(g.id)).states).toMatchObject({ TX: { deepOffset: 10 }, OK: { deepOffset: 10 } });

    census = censusFake(lists);
    const second = await run(P, g);
    expect(second.carriers.map((c) => Number(c.dotNumber)).sort()).toEqual([
      ...Array.from({ length: 10 }, (_, i) => 5100010 + i), ...Array.from({ length: 10 }, (_, i) => 5200010 + i),
    ]);
    expect(census.offsets('TX')).toEqual([0, 10]);
    expect(census.offsets('OK')).toEqual([0, 10]);
  });

  it('one state at its end and one at the page cap: status ok, each state keeps its own position', async () => {
    const P = await proUser();
    const lists = { TX: stateList('TX', 1200, 5300000), AR: stateList('AR', 6, 5400000) };
    await inCrm(P.user, lists.TX.slice(0, 1000));
    await inCrm(P.user, lists.AR);
    const census = censusFake(lists);
    const g = await generator(P, 'TX + AR', { ...TX, states: ['TX', 'AR'] });
    const { run: r } = await run(P, g);
    expect(r).toMatchObject({ status: 'ok', created: 0, scanned: 1006, skipped: 1006 });
    expect(r.message).toBe('Added 0 new leads. Read 1,006 carriers this run; the next run continues where this one stopped.');
    expect(census.offsets('AR')).toEqual([0]);
    expect(census.offsets('TX')).toEqual([0, 200, 400, 600, 800]);
    const { states } = await cursorOf(g.id);
    expect(states.TX).toMatchObject({ deepOffset: 1000, exhaustedAt: null });
    expect(states.AR.deepOffset).toBe(0);
    expect(states.AR.exhaustedAt).toBeTruthy();
  });

  describe('when the cursor is kept, reset or left alone', () => {
    let P; let g; let lists; let saved;
    const cursor = (hash, deepOffset = 200) => JSON.stringify({ v: 1, criteriaHash: hash, states: { TX: { deepOffset, headSeenAt: '2026-10-01', exhaustedAt: null } } });
    const setCursor = async (value) => { saved = value; await prisma.leadGenerator.update({ where: { id: g.id }, data: { cursor: value } }); };
    const stored = async () => (await prisma.leadGenerator.findUnique({ where: { id: g.id } })).cursor;
    beforeAll(async () => {
      P = await proUser();
      lists = { TX: stateList('TX', 400, 5500000) };
      g = await generator(P, 'Cursor rules', TX, { batchSize: 5 });
    });

    it('changing the filters or the minimum score resets it; renaming, batch size or the state list do not', async () => {
      await setCursor(cursor(criteriaHash(TX, 0)));
      await P.agent.patch(`/api/lead-generators/${g.id}`).send({ name: 'Renamed', batchSize: 25 }).expect(200);
      expect(await stored()).toBe(saved);
      await P.agent.patch(`/api/lead-generators/${g.id}`).send({ criteria: { ...TX } }).expect(200);
      expect(await stored()).toBe(saved);
      // Positions are per state: adding a state keeps Texas where it was.
      await P.agent.patch(`/api/lead-generators/${g.id}`).send({ criteria: { ...TX, states: ['TX', 'OK'] } }).expect(200);
      expect(await stored()).toBe(saved);
      await P.agent.patch(`/api/lead-generators/${g.id}`).send({ criteria: { ...TX, requireEmail: true } }).expect(200);
      expect(await stored()).toBeNull();

      await setCursor(cursor(criteriaHash({ ...TX, requireEmail: true }, 0)));
      await P.agent.patch(`/api/lead-generators/${g.id}`).send({ minScore: 40 }).expect(200);
      expect(await stored()).toBeNull();
      await P.agent.patch(`/api/lead-generators/${g.id}`).send({ criteria: TX, minScore: 0, batchSize: 5 }).expect(200);
    });

    it('a stored cursor saved for other filters is ignored: the run starts from the top', async () => {
      await setCursor(cursor('0123456789abcdef', 1000));
      const census = censusFake(lists);
      const { run: r } = await run(P, g);
      expect(r.created).toBe(5);
      expect(census.offsets('TX')).toEqual([0]);
      expect(await cursorOf(g.id)).toMatchObject({ criteriaHash: criteriaHash(TX, 0), states: { TX: { deepOffset: 5 } } });
    });

    it('a run that fails the authority check does not move the cursor', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await setCursor(cursor(criteriaHash(TX, 0)));
      censusFake(lists);
      fake.down = true;
      const { run: r } = await run(P, g);
      expect(r).toMatchObject({ status: 'error', created: 0 });
      expect(await stored()).toBe(saved);
    });

    it('a run that fails on the census does not move the cursor', async () => {
      await setCursor(cursor(criteriaHash(TX, 0)));
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ message: 'boom' }) })));
      const { run: r } = await run(P, g);
      expect(r).toMatchObject({ status: 'error', created: 0 });
      expect(await stored()).toBe(saved);
    });

    it('a preview reads only the first page from the top and never writes the cursor', async () => {
      await setCursor(cursor(criteriaHash(TX, 0)));
      const before = await prisma.leadGenerator.findUnique({ where: { id: g.id } });
      const census = censusFake(lists);
      const res = await P.agent.post('/api/lead-generators/preview').send({ criteria: TX });
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(25);
      expect(census.offsets('TX')).toEqual([0]);
      const after = await prisma.leadGenerator.findUnique({ where: { id: g.id } });
      expect(after.cursor).toBe(saved);
      expect(after.lastRunAt).toEqual(before.lastRunAt);
    });

    it('with a valid cursor the run scans the head, then continues from the saved offset', async () => {
      await P.agent.patch(`/api/lead-generators/${g.id}`).send({ batchSize: 10 }).expect(200);
      await setCursor(cursor(criteriaHash(TX, 0)));
      const census = censusFake(lists);
      const res = await run(P, g);
      expect(census.offsets('TX')).toEqual([0, 200]);
      // Head: the newest day again (5 of its 10 rows were added by an earlier run); deep: from offset 200.
      expect(res.carriers.map((c) => Number(c.dotNumber)).sort()).toEqual([5500005, 5500006, 5500007, 5500008, 5500009, 5500200, 5500201, 5500202, 5500203, 5500204]);
      expect((await cursorOf(g.id)).states.TX).toMatchObject({ deepOffset: 205, headSeenAt: '2026-10-01' });
    });
  });
});
