import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { clearCensusCache } from '../src/services/carriers/fmcsaCensus.js';
import { setFmcsaFetch } from '../src/services/brokers/fmcsa.js';
import { clearAuthorityCache } from '../src/services/carriers/authority.js';
import { clearLeadSignalCaches, QC_MAX_PER_RUN, tierPriority } from '../src/services/carriers/leadSignals.js';
import { criteriaHash } from '../src/services/leadgen.js';
import { setSetting } from '../src/lib/settings.js';
import { stageByKey } from '../src/services/pipeline.js';
import { licensingFake, MOTUS_PROPERTY } from './licensingFake.js';

/*
 * Lead generator and Find carriers with lead signals v2: exclusions per reason, scores saved on carriers, playbooks,
 * the shared filters, fail-soft lookups next to the fail-closed authority check, and QCMobile for picks only.
 * Census pages come from a stubbed global fetch; every other FMCSA dataset from licensingFake (setFmcsaFetch).
 */

const DAY = 86400000;
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const ago = (n) => new Date(Date.now() - n * DAY);
const row = (dot, extra = {}) => ({
  dot_number: String(dot), legal_name: `CARRIER ${dot} LLC`, phone: `713${String(dot).padStart(7, '0').slice(-7)}`, cell_phone: `832${String(dot).padStart(7, '0').slice(-7)}`,
  email_address: `owner${dot}@gmail.com`, phy_street: '1 MAIN ST', phy_city: 'HOUSTON', phy_state: 'TX', phy_zip: '77001', phy_cnty: '201',
  power_units: '1', total_drivers: '1', total_cdl: '1', status_code: 'A', add_date: ymd(ago(75)), mcs150_date: ymd(ago(75)), carrier_operation: 'A',
  classdef: 'AUTHORIZED FOR HIRE', hm_ind: 'N', docket1prefix: 'MC', docket1: String(60000000 + Number(dot) % 1000000), crgo_genfreight: 'X', owntract: '1', owntrail: '1',
  company_officer_1: 'PAT DRIVER', ...extra,
});
const mcOf = (r) => r.docket1;
const grant = (daysAgo) => ({ op_auth_type: MOTUS_PROPERTY, op_auth_status: 'Active', reason: 'Granted', status_change_date: ymd(ago(daysAgo)) });

/** Census fake: `rows` for the first page of any search, [] after; records each $where. */
function mockCensus(rows) {
  const wheres = [];
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = new URL(String(url));
    wheres.push(u.searchParams.get('$where') || '');
    const offset = Number(u.searchParams.get('$offset') || 0);
    return { ok: true, status: 200, json: async () => (offset === 0 ? rows : []) };
  }));
  return wheres;
}

async function proUser() {
  const P = await registerUser();
  const plan = await prisma.plan.findUnique({ where: { key: 'pro' } });
  await prisma.subscription.create({ data: { userId: P.user.id, planId: plan.id, status: 'active', seats: 1 } });
  return P;
}
async function generator(P, criteria, extra = {}) {
  const res = await P.agent.post('/api/lead-generators').send({ name: `Gen ${Math.random()}`, criteria: { states: ['TX'], ...criteria }, batchSize: 10, minScore: 0, ...extra });
  expect(res.status).toBe(201);
  return res.body.generator;
}
const runOf = async (P, g) => {
  const res = await P.agent.post(`/api/lead-generators/${g.id}/run`);
  expect(res.status).toBe(200);
  return res.body;
};

describe('lead generator with lead signals', () => {
  let fake;
  beforeAll(() => { fake = licensingFake(); setFmcsaFetch(fake.fetch); });
  afterAll(() => setFmcsaFetch(null));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearCensusCache();
    clearAuthorityCache();
    clearLeadSignalCaches();
    Object.assign(fake, {
      down: false, signalsDown: false, rows: {}, signalCalls: [], qcCalls: [], qcPeak: 0, motusHistory: {}, history: {}, motusInsurance: {}, insurance: {},
      sharedPhones: {}, sharedEmails: {}, qc: {},
    });
  });

  it('saves leadScore, leadTier and leadSignals on each new carrier, with the score in the note; the result lists the best first', async () => {
    const P = await proUser();
    const strong = row(1001);
    const weak = row(1002, { cell_phone: undefined, email_address: 'dispatch@bigfleet.com', power_units: '9', total_drivers: '12', add_date: '20150101', mcs150_date: '20200101', company_officer_1: undefined });
    fake.motusHistory[mcOf(strong)] = [grant(45)];
    fake.history[mcOf(weak)] = [{ mod_col_1: 'COMMON', original_action_desc: 'GRANTED', orig_served_date: '02/01/2015' }];
    mockCensus([weak, strong]);
    const g = await generator(P, {});
    const res = await runOf(P, g);
    expect(res.run.created).toBe(2);
    expect(res.carriers.map((c) => c.dotNumber)).toEqual(['1001', '1002']);
    const [best, other] = res.carriers;
    expect(best).toMatchObject({ leadTier: 'A' });
    expect(best.leadScore).toBeGreaterThanOrEqual(75);
    expect(other.leadScore).toBeLessThan(best.leadScore);
    expect(best.leadSignals.find((s) => s.key === 'new_authority')).toMatchObject({ label: 'New MC · 45 days', points: 25, group: 'need' });

    const c = await prisma.carrier.findFirst({ where: { ownerId: P.user.id, dotNumber: '1001' }, include: { notes: true } });
    expect(c).toMatchObject({ leadTier: 'A', priority: tierPriority('A') });
    const stored = JSON.parse(c.leadSignals);
    expect(stored.every((s) => s.key && s.label && typeof s.points === 'number' && s.group && s.tone)).toBe(true);
    expect(c.notes[0].body).toMatch(new RegExp(`^Lead score ${c.leadScore}/100 \\(tier A\\): .*New MC · 45 days \\(\\+25\\)`));
    // Live safety is not configured here: the lead says so instead of guessing.
    expect(stored.map((s) => s.key)).toContain('safety_not_checked');
  });

  it('leaves out shared contacts, unsafe ratings, teammates and do-not-contact lists, with a count per reason', async () => {
    const P = await proUser();
    const mate = await registerUser();
    const team = await prisma.team.create({ data: { name: 'Crew', ownerId: P.user.id } });
    await prisma.teamMember.createMany({ data: [{ teamId: team.id, userId: P.user.id, role: 'owner' }, { teamId: team.id, userId: mate.user.id, role: 'dispatcher' }] });
    const stage = await stageByKey('lead');
    const shared = row(2001);
    const unsafe = row(2002, { safety_rating: 'U' });
    const dnc = row(2003);
    const suppressed = row(2004);
    const teammates = row(2005);
    const good = row(2006);
    fake.sharedPhones[shared.phone] = 9;
    await prisma.carrier.create({ data: { ownerId: P.user.id, stageId: stage.id, companyName: 'Old DNC record', dotNumber: '99992003', phone: dnc.phone, doNotCall: true } });
    await prisma.emailSuppression.create({ data: { ownerId: P.user.id, email: suppressed.email_address, reason: 'unsubscribed' } });
    await prisma.carrier.create({ data: { ownerId: mate.user.id, stageId: stage.id, companyName: 'Mate has it', dotNumber: '2005' } });
    mockCensus([shared, unsafe, dnc, suppressed, teammates, good]);
    const g = await generator(P, {});
    const { run, carriers } = await runOf(P, g);
    expect(carriers.map((c) => c.dotNumber)).toEqual(['2006']);
    expect(run).toMatchObject({ status: 'exhausted', created: 1, scanned: 6 });
    expect(run.exclusions).toMatchObject({ sharedContact: 1, unsafe: 1, suppressed: 2, teamClaimed: 1, inactiveAuthority: 0, outOfService: 0 });
    expect(run.message).toMatch(/1 with a teammate, 2 on your do-not-contact lists, 1 unsafe safety rating, 1 share a phone or email with other carriers/);
    // The shared-contact check asked for the candidates that passed the cheaper checks only, in one batch.
    const phones = fake.signalCalls.filter((c) => c.dataset === 'sharedPhones');
    expect(phones).toHaveLength(1);
    expect(phones[0].values.sort()).toEqual([shared.phone, good.phone].sort());
    const history = (await P.agent.get('/api/lead-generators/runs')).body.items[0];
    expect(history.exclusions).toMatchObject({ sharedContact: 1, unsafe: 1, suppressed: 2, teamClaimed: 1 });
  });

  it('optional lookups fail soft (leads still saved, marked unchecked); the authority check still fails closed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const P = await proUser();
    fake.signalsDown = true;
    mockCensus([row(3001), row(3002)]);
    const g = await generator(P, { insurers: ['Canal'] });
    const { run, carriers } = await runOf(P, g);
    expect(run).toMatchObject({ status: 'exhausted', created: 2 });
    const keys = carriers[0].leadSignals.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(['shared_unchecked', 'insurer_unchecked']));
    // No authority history: the MC age is the estimate from the USDOT registration date.
    expect(carriers[0].leadSignals.find((s) => s.key === 'new_authority').label).toBe('New MC · ~75 days (est.)');

    fake.signalsDown = false;
    fake.down = true;
    mockCensus([row(3003)]);
    const failed = await runOf(P, g);
    expect(failed.run).toMatchObject({ status: 'error', created: 0 });
    expect(failed.run.message).toMatch(/^Could not verify operating authority with FMCSA right now\./);
    expect(await prisma.carrier.findFirst({ where: { ownerId: P.user.id, dotNumber: '3003' } })).toBeNull();
  });

  it('MC age range: real grant dates from authority history, the estimate when history has no grant', async () => {
    const P = await proUser();
    const fresh = row(4001);
    const old = row(4002);
    const noGrant = row(4003);
    fake.motusHistory[mcOf(fresh)] = [grant(50)];
    fake.history[mcOf(old)] = [{ mod_col_1: 'COMMON', original_action_desc: 'GRANTED', orig_served_date: '01/10/2025' }];
    mockCensus([fresh, old, noGrant]);
    const g = await generator(P, { mcAgeMinDays: 30, mcAgeMaxDays: 120 });
    const { run, carriers } = await runOf(P, g);
    expect(carriers.map((c) => c.dotNumber).sort()).toEqual(['4001', '4003']);
    expect(run.exclusions.filtered).toBe(1);
  });

  it('insurer filter: include and exclude, matched on the current BIPD insurer', async () => {
    const P = await proUser();
    const a = row(5001);
    const b = row(5002);
    fake.motusInsurance[mcOf(a)] = [{ ins_type_code: '1', ins_class_code: 'P', insurance_company_name: 'PROGRESSIVE COUNTY MUTUAL' }];
    fake.motusInsurance[mcOf(b)] = [{ ins_type_code: '1', ins_class_code: 'P', insurance_company_name: 'Canal Insurance Company' }];
    mockCensus([a, b]);
    const inc = await runOf(P, await generator(P, { insurers: ['progressive'] }));
    expect(inc.carriers.map((c) => c.dotNumber)).toEqual(['5001']);
    expect(inc.run.exclusions.filtered).toBe(1);
    const Q = await proUser();
    mockCensus([a, b]);
    const exc = await runOf(Q, await generator(Q, { insurers: ['Progressive'], insurerMode: 'exclude' }));
    expect(exc.carriers.map((c) => c.dotNumber)).toEqual(['5002']);
  });

  it('QCMobile checks only the picks, at most 50 per run and 2 at a time; out-of-service picks are dropped and replaced', async () => {
    const admin = await registerUser({ role: 'super_admin' });
    await setSetting('fmcsa.webKey', 'test-web-key', admin.user.id);
    try {
      const P = await proUser();
      const rows = Array.from({ length: 80 }, (_, i) => row(600000 + i));
      fake.qc['600002'] = { allowedToOperate: 'N', oosDate: '2026-10-01' };
      for (const r of rows.slice(3, 10)) fake.qc[r.dot_number] = { allowedToOperate: 'Y' };
      mockCensus(rows);
      const g = await generator(P, {}, { batchSize: 60 });
      const { run, carriers } = await runOf(P, g);
      expect(run.created).toBe(60);
      expect(run.exclusions.outOfService).toBe(1);
      expect(carriers.some((c) => c.dotNumber === '600002')).toBe(false);
      expect(fake.qcCalls).toHaveLength(QC_MAX_PER_RUN);
      expect(fake.qcPeak).toBeLessThanOrEqual(2);
      // Only the first picks in crawl order were checked, never the rest of the crawl.
      expect(new Set(fake.qcCalls)).toEqual(new Set(rows.slice(0, QC_MAX_PER_RUN).map((r) => r.dot_number)));
      const checked = carriers.find((c) => c.dotNumber === '600005');
      expect(checked.leadSignals.map((s) => s.key)).toContain('allowed_to_operate');
      const unchecked = carriers.find((c) => c.dotNumber === '600060');
      expect(unchecked.leadSignals.map((s) => s.key)).toContain('safety_not_checked');
    } finally {
      await setSetting('fmcsa.webKey', '', admin.user.id);
    }
  });

  it('validates the new criteria', async () => {
    const P = await registerUser();
    const bad = [
      { zipPrefixes: ['77'] }, { zipPrefixes: ['abc'] }, { counties: ['1234'] }, { hazmat: 'maybe' }, { minDrivers: 5, maxDrivers: 2 },
      { mcAgeMinDays: 200, mcAgeMaxDays: 100 }, { excludeRatings: ['X'] }, { equipment: ['spaceship'] }, { excludeEmail: 'all' },
      { insurers: Array.from({ length: 21 }, (_, i) => `Insurer ${i}`) }, { insurerMode: 'only' }, { playbook: 'nope' }, { maxMilesPerTruck: -1 },
    ];
    for (const extra of bad) {
      const res = await P.agent.post('/api/lead-generators/preview').send({ criteria: { states: ['TX'], ...extra } });
      expect([extra, res.status]).toEqual([extra, 400]);
    }
    mockCensus([]);
    const ok = await P.agent.post('/api/lead-generators').send({ name: 'All filters', criteria: {
      states: ['TX'], zipPrefixes: ['773', '75001'], counties: ['1', '201'], interstateOnly: true, forHireOnly: true, hazmat: 'no', minDrivers: 1, maxDrivers: 3,
      minCdlDrivers: 1, maxMilesPerTruck: 60000, mcs150WithinMonths: 6, excludeRatings: ['U', 'C'], mcAgeMinDays: 30, mcAgeMaxDays: 120, requireCell: true,
      excludeSharedContacts: false, excludeEmail: 'corporate', equipment: ['reefer', 'hotshot'], insurers: ['Progressive'], insurerMode: 'exclude', playbook: 'new_mc_launch',
    } });
    expect(ok.status).toBe(201);
    expect(ok.body.generator.criteria).toMatchObject({ counties: ['001', '201'], excludeRatings: ['C', 'U'], equipment: ['reefer', 'hotshot'], playbook: 'new_mc_launch' });
    // Defaults are filled in for criteria that leave the new filters out.
    const plain = await P.agent.patch(`/api/lead-generators/${ok.body.generator.id}`).send({ criteria: { states: ['TX'] } });
    expect(plain.body.generator.criteria).toMatchObject({ excludeSharedContacts: true, excludeRatings: ['U'], hazmat: 'any', excludeEmail: 'none', equipment: [], insurers: [], insurerMode: 'include' });
  });

  it('a new filter value resets the crawl cursor; spelling out the defaults does not', async () => {
    const P = await proUser();
    const g = await generator(P, {});
    const stored = async () => (await prisma.leadGenerator.findUnique({ where: { id: g.id } })).cursor;
    const setCursor = async (criteria) => {
      const value = JSON.stringify({ v: 1, criteriaHash: criteriaHash(criteria, 0), states: { TX: { deepOffset: 200, headSeenAt: '2026-10-01', exhaustedAt: null } } });
      await prisma.leadGenerator.update({ where: { id: g.id }, data: { cursor: value } });
      return value;
    };
    const TX = { states: ['TX'] };
    let saved = await setCursor(TX);
    await P.agent.patch(`/api/lead-generators/${g.id}`).send({ criteria: { ...TX, excludeSharedContacts: true, excludeRatings: ['U'], hazmat: 'any', insurers: [] } }).expect(200);
    expect(await stored()).toBe(saved);
    for (const change of [
      { zipPrefixes: ['773'] }, { counties: ['201'] }, { interstateOnly: true }, { forHireOnly: true }, { hazmat: 'yes' }, { minDrivers: 1 }, { maxDrivers: 3 },
      { minCdlDrivers: 1 }, { maxMilesPerTruck: 60000 }, { mcs150WithinMonths: 6 }, { excludeRatings: ['U', 'C'] }, { mcAgeMinDays: 30 }, { mcAgeMaxDays: 120 },
      { requireCell: true }, { requireCellOrEmail: true }, { excludeSharedContacts: false }, { excludeEmail: 'free' }, { equipment: ['reefer'] },
      { insurers: ['Canal'] }, { insurers: ['Canal'], insurerMode: 'exclude' }, { playbook: 'all_small' },
    ]) {
      saved = await setCursor(TX);
      await P.agent.patch(`/api/lead-generators/${g.id}`).send({ criteria: { ...TX, ...change } }).expect(200);
      expect([change, await stored()]).toEqual([change, null]);
      await P.agent.patch(`/api/lead-generators/${g.id}`).send({ criteria: TX }).expect(200);
    }
  });

  it('lists the playbooks; every playbook produces criteria the generator accepts', async () => {
    const P = await registerUser();
    const res = await P.agent.get('/api/lead-generators');
    expect(res.body.playbooks.map((p) => p.key)).toEqual(['new_mc_launch', 'broker_ready', 'owner_operators', 'underused_trucks', 'growing_fleets', 'reefer', 'flatbed', 'hotshot_box', 'all_small']);
    expect(res.body.playbooks[0]).toMatchObject({ title: 'New MC launch', criteria: { mcAgeMinDays: 30, mcAgeMaxDays: 120, playbook: 'new_mc_launch' }, minScore: 55 });
    expect(res.body.equipmentOptions.map((o) => o.value)).toContain('hotshot');
    expect(res.body.insurerSuggestions).toEqual(expect.arrayContaining(['Progressive', 'Northland', 'Great West', 'Canal', 'National Interstate', 'Berkshire Hathaway']));
    mockCensus([]);
    for (const p of res.body.playbooks) {
      const preview = await P.agent.post('/api/lead-generators/preview').send({ criteria: { ...p.criteria, states: ['TX'] }, minScore: p.minScore });
      expect([p.key, preview.status]).toEqual([p.key, 200]);
    }
  });
});

describe('carrier list: lead score and tier', () => {
  it('sorts by lead score (unscored last both ways), filters by tier and returns the signals on the profile', async () => {
    const U = await registerUser();
    const stage = await stageByKey('lead');
    const mk = (name, leadScore, leadTier) => prisma.carrier.create({ data: {
      ownerId: U.user.id, stageId: stage.id, companyName: name, leadScore, leadTier,
      leadSignals: leadTier ? JSON.stringify([{ key: 'cell_phone', label: 'Cell phone', points: 14, group: 'reach', tone: 'good' }]) : null,
    } });
    const top = await mk('Top', 90, 'A');
    await mk('Middle', 60, 'B');
    await mk('Low', 30, 'C');
    await mk('Unscored', null, null);
    const names = async (q) => (await U.agent.get(`/api/carriers?${q}`)).body.items.map((c) => c.companyName);
    expect(await names('sort=leadScore&dir=desc')).toEqual(['Top', 'Middle', 'Low', 'Unscored']);
    expect(await names('sort=leadScore&dir=asc')).toEqual(['Low', 'Middle', 'Top', 'Unscored']);
    expect(await names('leadTier=A')).toEqual(['Top']);
    expect(await names('leadTier=unscored')).toEqual(['Unscored']);
    expect((await U.agent.get('/api/carriers?leadTier=Z')).status).toBe(400);
    const list = (await U.agent.get('/api/carriers?leadTier=B')).body.items[0];
    expect(list).toMatchObject({ leadScore: 60, leadTier: 'B' });
    const detail = (await U.agent.get(`/api/carriers/${top.id}`)).body.carrier;
    expect(detail).toMatchObject({ leadScore: 90, leadTier: 'A', leadSignals: [{ key: 'cell_phone', label: 'Cell phone', points: 14 }] });
  });
});

describe('find carriers: the same filters, scores and signals', () => {
  let fake;
  beforeAll(() => { fake = licensingFake(); setFmcsaFetch(fake.fetch); });
  afterAll(() => setFmcsaFetch(null));
  afterEach(() => { vi.unstubAllGlobals(); clearCensusCache(); clearAuthorityCache(); clearLeadSignalCaches(); });

  it('census-side filters go into SoQL; the rest hide rows on the page with "hidden by filters"', async () => {
    const U = await registerUser();
    const good = row(7001);
    const shared = row(7002);
    const conditional = row(7003, { safety_rating: 'C' });
    const canal = row(7004);
    const old = row(7005);
    fake.sharedPhones[shared.phone] = 4;
    for (const r of [good, shared, conditional, old]) fake.motusInsurance[mcOf(r)] = [{ ins_type_code: '1', ins_class_code: 'P', insurance_company_name: 'United Financial Casualty Company' }];
    fake.motusInsurance[mcOf(canal)] = [{ ins_type_code: '1', ins_class_code: 'P', insurance_company_name: 'Canal Insurance Company' }];
    fake.motusHistory[mcOf(good)] = [grant(40)];
    fake.motusHistory[mcOf(old)] = [grant(900)];
    const wheres = mockCensus([good, shared, conditional, canal, old]);
    const res = await U.agent.get('/api/discovery/search?state=TX&zipPrefixes=770,773&interstateOnly=true&excludeRatings=U,C&mcAgeMaxDays=120&insurers=Progressive&requireCell=true&order=score');
    expect(res.status).toBe(200);
    expect(wheres[0]).toContain("phy_state='TX'");
    expect(wheres[0]).toContain("(phy_zip like '770%' OR phy_zip like '773%')");
    expect(wheres[0]).toContain("carrier_operation='A'");
    expect(wheres[0]).toContain("(safety_rating IS NULL OR safety_rating not in('C','U'))");
    expect(wheres[0]).toContain('cell_phone IS NOT NULL');
    expect(res.body.items.map((i) => i.dotNumber)).toEqual(['7001']);
    expect(res.body.items[0]).toMatchObject({ tier: 'A', cellPhone: good.cell_phone });
    expect(res.body.items[0].score).toBeGreaterThanOrEqual(75);
    expect(res.body.items[0].signals.find((s) => s.key === 'new_authority').label).toBe('New MC · 40 days');
    expect(res.body).toMatchObject({ hiddenByFilters: 4, hiddenReasons: { unsafe: 1, sharedContact: 1, filtered: 2 }, hiddenInactive: 0 });
  });

  it('defaults keep shared contacts out and Unsatisfactory ratings out; "Best leads first" sorts the page by score', async () => {
    const U = await registerUser();
    const weak = row(7101, { cell_phone: undefined, email_address: undefined, power_units: '40', total_drivers: '60', add_date: '20100101', mcs150_date: '20190101' });
    const strong = row(7102);
    const unsat = row(7103, { safety_rating: 'U' });
    mockCensus([weak, strong, unsat]);
    const res = await U.agent.get('/api/discovery/search?state=TX&order=score');
    expect(res.body.items.map((i) => i.dotNumber)).toEqual(['7102', '7101']);
    expect(res.body.items[0].score).toBeGreaterThan(res.body.items[1].score);
    expect(res.body.hiddenReasons).toEqual({ unsafe: 1, filtered: 0, sharedContact: 0 });
    clearCensusCache();
    mockCensus([weak, strong, unsat]);
    const all = await U.agent.get('/api/discovery/search?state=TX&excludeRatings=none');
    expect(all.body.items.map((i) => i.dotNumber)).toEqual(['7101', '7102', '7103']);
    expect((await U.agent.get('/api/discovery/search?state=TX&zipPrefixes=7')).status).toBe(400);
    expect((await U.agent.get('/api/discovery/search?state=TX&minDrivers=5&maxDrivers=2')).status).toBe(400);
  });

  it('saving from Find carriers stores the lead score on the carrier', async () => {
    const U = await registerUser();
    const r = row(7201);
    fake.motusHistory[mcOf(r)] = [grant(20)];
    mockCensus([r]);
    const saved = await U.agent.post('/api/discovery/save').send({ dotNumbers: ['7201'] });
    expect(saved.body.created).toBe(1);
    const c = await prisma.carrier.findFirst({ where: { ownerId: U.user.id, dotNumber: '7201' } });
    expect(c.leadTier).toBe('A');
    expect(JSON.parse(c.leadSignals).find((s) => s.key === 'new_authority').label).toBe('New MC · 20 days');
  });
});
