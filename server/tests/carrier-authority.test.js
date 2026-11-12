import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { clearCensusCache } from '../src/services/carriers/fmcsaCensus.js';
import { setFmcsaFetch } from '../src/services/brokers/fmcsa.js';
import { AUTHORITY_LABELS, authorityFromLicensing, checkAuthority, clearAuthorityCache, combineAuthority } from '../src/services/carriers/authority.js';
import { runAuthorityRefresh } from '../src/services/carriers/authorityRefresh.js';
import { jobs as refreshJobs } from '../src/jobs/extra/carrier-authority-refresh.js';
import { ACTIVE_ROW, INACTIVE_ROW, PENDING_ROW, licensingFake, motusRow } from './licensingFake.js';

const DAY = 86_400_000;
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

// The production example: census says USDOT and docket active, FMCSA licensing says no authority and no insurance.
const MC_647991 = { docket_number: 'MC647991', dot_number: '01775913', legal_name: 'DERICK DORIAN MYRICK', dba_name: 'DAKOTA TRUCKING', common_stat: 'N', contract_stat: 'I', broker_stat: 'N', bipd_file: '00000', undeliverable_mail: 'Y' };

const censusRow = (dot, mc, extra = {}) => ({
  dot_number: String(dot), legal_name: `CARRIER ${dot} LLC`, phone: `61455${String(dot).slice(-5).padStart(5, '0')}`, email_address: `ops${dot}@carrier.test`,
  phy_street: '1 MAIN ST', phy_city: 'COLUMBUS', phy_state: 'OH', phy_zip: '43004', power_units: '3', status_code: 'A', add_date: ymd(new Date(Date.now() - 40 * DAY)),
  carrier_operation: 'A', ...(mc ? { docket1prefix: 'MC', docket1: String(mc), docket1_status_code: 'A' } : {}), crgo_genfreight: 'X', ...extra,
});

/** Census stub (global fetch): list queries get `rows`, USDOT lookups get the matching rows. */
function mockCensus(rows) {
  const fn = vi.fn(async (input) => {
    const u = new URL(String(input));
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    const select = u.searchParams.get('$select') || '';
    if (select.startsWith('max(add_date)')) return ok([{ newest: ymd(new Date()) }]);
    const where = u.searchParams.get('$where') || '';
    const many = where.match(/dot_number in\(([^)]*)\)/);
    if (many) { const dots = many[1].split(',').map((x) => x.replace(/'/g, '')); return ok(rows.filter((r) => dots.includes(r.dot_number))); }
    const one = where.match(/dot_number='(\d+)'/);
    if (one) return ok(rows.filter((r) => r.dot_number === one[1]));
    return ok(Number(u.searchParams.get('$offset') || 0) === 0 ? rows : []);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

let fake;
beforeAll(() => {
  fake = licensingFake({
    // Legacy L&I. 7700001-7700003 are Motus-only carriers: no legacy record.
    rows: { 647991: MC_647991, 7000002: INACTIVE_ROW, 7000012: INACTIVE_ROW, 7000003: PENDING_ROW, 7700001: null, 7700002: null, 7700003: null, 7800001: null },
    // Census MC 7800001 is stale: the authority is filed under another docket, found through the USDOT number.
    byDot: { 9810001: [{ docket_number: 'MC7800009', ...ACTIVE_ROW }] },
    motus: { 7700001: motusRow('Active'), 7700002: motusRow('Withdrawn'), 7700003: [motusRow('Active', { op_auth_type: 'Broker of Property (Except Household Goods)' })] },
  });
  setFmcsaFetch(fake.fetch);
});
afterAll(() => setFmcsaFetch(null));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCensusCache();
  clearAuthorityCache();
  fake.down = false;
  fake.legacyDown = false;
  fake.motusDown = false;
  fake.calls.length = 0;
  fake.motusCalls.length = 0;
});

describe('authority rules (FMCSA licensing)', () => {
  it('MC 647991: census active, licensing says no authority and no insurance -> inactive', () => {
    const a = authorityFromLicensing(MC_647991);
    // undeliverable_mail 'Y' means the address is deliverable (FMCSA data dictionary).
    expect(a).toMatchObject({ status: 'inactive', common: 'none', contract: 'inactive', insuranceOnFile: false, revocationPending: false, pending: false, undeliverableMail: false, label: AUTHORITY_LABELS.inactive });
    expect(authorityFromLicensing({ ...MC_647991, undeliverable_mail: 'N' }).undeliverableMail).toBe(true);
  });

  it('active common authority with BIPD on file -> active', () => {
    expect(authorityFromLicensing({ ...ACTIVE_ROW, common_stat: 'A', bipd_file: '00750' })).toMatchObject({ status: 'active', insuranceOnFile: true, insuranceAmount: 750000, label: 'Authority active · insurance on file' });
    expect(authorityFromLicensing({ ...ACTIVE_ROW, common_stat: 'N', contract_stat: 'A' }).status).toBe('active');
  });

  it('active authority without insurance on file -> inactive (no insurance)', () => {
    expect(authorityFromLicensing({ ...ACTIVE_ROW, bipd_file: '00000' })).toMatchObject({ status: 'inactive', insuranceOnFile: false, label: 'No insurance on file' });
  });

  it('active authority with a revocation pending -> inactive', () => {
    expect(authorityFromLicensing({ ...ACTIVE_ROW, common_rev_pend: 'Y' })).toMatchObject({ status: 'inactive', revocationPending: true, label: 'Revocation pending' });
    expect(authorityFromLicensing({ ...ACTIVE_ROW, contract_stat: 'A', contract_rev_pend: 'Y' }).status).toBe('inactive');
  });

  it('only an application pending -> pending', () => {
    expect(authorityFromLicensing({ ...ACTIVE_ROW, common_stat: 'N', common_app_pend: 'Y', bipd_file: '00000' })).toMatchObject({ status: 'pending', pending: true, label: 'Authority pending' });
  });

  it('dataset did not answer -> unknown; answered without a row -> inactive', () => {
    expect(authorityFromLicensing(null)).toMatchObject({ status: 'unknown', label: AUTHORITY_LABELS.unknown });
    expect(authorityFromLicensing(null, { answered: true })).toMatchObject({ status: 'inactive', label: AUTHORITY_LABELS.noRecord });
  });

  it('checkAuthority batches 200 MC numbers per request, one request at a time', async () => {
    const mcs = Array.from({ length: 450 }, (_, i) => `MC-${8000000 + i}`);
    const res = await checkAuthority([...mcs, '647991', '0647991']);
    expect(fake.calls.map((c) => c.length)).toEqual([200, 200, 51]);
    expect(fake.motusCalls.map((c) => c.length)).toEqual([200, 200, 51]);
    expect(fake.calls[0][0]).toBe('MC8000000');
    expect(res.get('8000000').status).toBe('active');
    expect(res.get('647991').status).toBe('inactive');
  });

  it('checkAuthority maps unanswered numbers to null and stops sending after the first failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fake.down = true;
    const res = await checkAuthority(Array.from({ length: 450 }, (_, i) => 8100000 + i));
    expect(fake.calls).toHaveLength(1);
    expect(fake.motusCalls).toHaveLength(1);
    expect(res.size).toBe(450);
    expect([...res.values()].every((v) => v === null)).toBe(true);
  });

  it('an MC found in neither dataset is inactive', async () => {
    fake.rows['7999999'] = null;
    const res = await checkAuthority(['7999999']);
    expect(res.get('7999999')).toMatchObject({ status: 'inactive', label: AUTHORITY_LABELS.noRecord, complete: true });
    delete fake.rows['7999999'];
  });
});

describe('authority rules: legacy L&I and Motus combined', () => {
  it('Motus: an active carrier authority with BIPD on file is active even without a legacy record', () => {
    expect(combineAuthority({ legacy: [], motus: [motusRow('Active')] })).toMatchObject({ status: 'active', insuranceOnFile: true, insuranceAmount: 750000, complete: true });
  });

  it('Motus: active even while bipd_file still reads 0, broker rows ignored, withdrawn and inactive are not active', () => {
    // A freshly granted Motus carrier can show bipd_file 0 although its BIPD policy is filed; FMCSA only keeps authority
    // active with liability insurance, so an Active Motus authority counts as insured.
    expect(combineAuthority({ legacy: [], motus: [motusRow('Active', { bipd_file: '0.000000000000000000' })] })).toMatchObject({ status: 'active', insuranceOnFile: true });
    expect(combineAuthority({ legacy: [], motus: [motusRow('Active', { op_auth_type: 'Broker of Property (Except Household Goods)' })] })).toMatchObject({ status: 'inactive', label: AUTHORITY_LABELS.inactive });
    expect(combineAuthority({ legacy: [], motus: [motusRow('Active', { op_auth_type: 'Freight Forwarder of Property (Except Household Goods)' })] }).status).toBe('inactive');
    expect(combineAuthority({ legacy: [], motus: [motusRow('Withdrawn')] }).status).toBe('inactive');
    expect(combineAuthority({ legacy: [], motus: [motusRow('Inactive')] }).status).toBe('inactive');
    expect(combineAuthority({ legacy: [], motus: [motusRow('Pending')] })).toMatchObject({ status: 'pending', label: 'Authority pending' });
    expect(combineAuthority({ legacy: [], motus: [motusRow('Active', { op_auth_type: 'Motor Carrier of Household Goods' })] }).status).toBe('active');
  });

  it('Motus (live) decides when it holds a carrier authority; the frozen legacy record decides only otherwise', () => {
    expect(combineAuthority({ legacy: [INACTIVE_ROW], motus: [motusRow('Active')] }).status).toBe('active');
    // Legacy stopped updating on May 14, 2026: a later Motus withdrawal wins over an old legacy "active".
    expect(combineAuthority({ legacy: [ACTIVE_ROW], motus: [motusRow('Withdrawn')] })).toMatchObject({ status: 'inactive', complete: true });
    expect(combineAuthority({ legacy: [PENDING_ROW], motus: [motusRow('Active')] }).status).toBe('active');
    expect(combineAuthority({ legacy: [INACTIVE_ROW], motus: [motusRow('Pending')] }).status).toBe('pending');
    expect(combineAuthority({ legacy: [ACTIVE_ROW], motus: [] }).status).toBe('active');
    expect(combineAuthority({ legacy: [ACTIVE_ROW], motus: [motusRow('Active', { op_auth_type: 'Broker of Property (Except Household Goods)' })] }).status).toBe('active');
  });

  it('a legacy revocation pending blocks active only when Motus has no record', () => {
    expect(combineAuthority({ legacy: [{ ...ACTIVE_ROW, common_rev_pend: 'Y' }], motus: [] })).toMatchObject({ status: 'inactive', label: AUTHORITY_LABELS.revocationPending });
    expect(combineAuthority({ legacy: [{ ...ACTIVE_ROW, common_rev_pend: 'Y' }], motus: [motusRow('Active')] })).toMatchObject({ status: 'active', revocationPending: false });
  });

  it('one dataset down: a Motus record is final; legacy alone is incomplete; both down: unknown', () => {
    expect(combineAuthority({ legacy: null, motus: [motusRow('Active')] })).toMatchObject({ status: 'active', complete: true });
    expect(combineAuthority({ legacy: [], motus: null })).toMatchObject({ status: 'inactive', complete: false });
    expect(combineAuthority({ legacy: null, motus: null })).toMatchObject({ status: 'unknown', complete: false });
  });

  it('checkAuthority asks both datasets by MC and by USDOT, and finds authority filed under another docket', async () => {
    const res = await checkAuthority([{ mc: '7700001', dot: '9770001' }, { mc: '7700002', dot: '9770002' }, { mc: '7800001', dot: '9810001' }, { mc: '7700003', dot: '9770003' }]);
    expect(res.get('7700001')).toMatchObject({ status: 'active', complete: true }); // Motus only
    expect(res.get('7700002').status).toBe('inactive'); // Motus withdrawn
    expect(res.get('7800001').status).toBe('active'); // legacy row found by USDOT
    expect(res.get('7700003').status).toBe('inactive'); // Motus broker authority only
    expect(fake.calls).toHaveLength(1);
    expect(fake.motusCalls).toHaveLength(1);
  });

  it('checkAuthority with one dataset down still answers from the other', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fake.legacyDown = true;
    const res = await checkAuthority([{ mc: '7700001', dot: '9770001' }, { mc: '8200001', dot: '9820001' }]);
    expect(res.get('7700001')).toMatchObject({ status: 'active', complete: true }); // Motus record: final
    expect(res.get('8200001')).toMatchObject({ status: 'inactive', complete: false }); // only in legacy, which did not answer
  });
});

describe('lead generator: only active authority', () => {
  const criteria = { states: ['OH'], requireMc: true, requirePhone: true };
  let U;
  beforeAll(async () => { U = await registerUser(); });

  async function generator(user, name, extra = {}) {
    const res = await user.agent.post('/api/lead-generators').send({ name, criteria: { ...criteria, ...(extra.criteria || {}) }, batchSize: extra.batchSize || 10, minScore: 0 });
    expect(res.status).toBe(201);
    return res.body.generator;
  }

  it('drops inactive and pending candidates, counts them, and saves the rest with their licensing authority', async () => {
    // 7000002 inactive, 7000003 pending, 647991 = the production example; 7000001 and 7000004 active.
    mockCensus([censusRow(9100001, 7000001), censusRow(9100002, 7000002), censusRow(9100003, 7000003), censusRow(9100004, 647991), censusRow(9100005, 7000004)]);
    const g = await generator(U, 'Authority check');
    const res = await U.agent.post(`/api/lead-generators/${g.id}/run`);
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ created: 2, inactiveAuthority: 3 });
    expect(res.body.run.message).toMatch(/3 skipped: authority not active\./);
    expect(res.body.carriers.map((c) => c.dotNumber).sort()).toEqual(['9100001', '9100005']);
    const saved = await prisma.carrier.findMany({ where: { ownerId: U.user.id }, include: { notes: true } });
    expect(saved.map((c) => c.dotNumber).sort()).toEqual(['9100001', '9100005']);
    for (const c of saved) {
      expect(c).toMatchObject({ authorityStatus: 'active', operatingStatus: AUTHORITY_LABELS.active });
      expect(c.notes[0].body).toContain('Authority active, insurance on file (FMCSA licensing)');
      expect(c.notes[0].body).toContain('USDOT registration active (census)');
      expect(c.notes[0].body).not.toMatch(/USDOT active,/);
    }
    // One licensing request for the whole page of candidates.
    expect(fake.calls).toHaveLength(1);
    // Each test uses MC numbers of its own: the generator skips carriers already in the CRM by MC.
    const runs = (await U.agent.get('/api/lead-generators/runs')).body.items;
    expect(runs[0]).toMatchObject({ created: 2, inactiveAuthority: 3 });
  });

  it('a Motus-only carrier with active authority stays a lead; a withdrawn Motus authority is dropped', async () => {
    const P = await registerUser();
    mockCensus([censusRow(9150001, 7700001), censusRow(9150002, 7700002)]);
    const g = await generator(P, 'Motus');
    const res = await P.agent.post(`/api/lead-generators/${g.id}/run`);
    expect(res.body.run).toMatchObject({ created: 1, inactiveAuthority: 1 });
    expect(res.body.carriers.map((c) => c.dotNumber)).toEqual(['9150001']);
    expect(await prisma.carrier.findFirst({ where: { ownerId: P.user.id, dotNumber: '9150001' } })).toMatchObject({ mcNumber: '7700001', authorityStatus: 'active', operatingStatus: AUTHORITY_LABELS.active });
    expect(await prisma.carrier.count({ where: { ownerId: P.user.id, dotNumber: '9150002' } })).toBe(0);
  });

  it('preview shows only active authority and the count of the rest', async () => {
    mockCensus([censusRow(9200001, 7200001), censusRow(9200002, 7000002), censusRow(9200003, 647991)]);
    const res = await U.agent.post('/api/lead-generators/preview').send({ criteria });
    expect(res.status).toBe(200);
    expect(res.body.items.map((x) => x.dotNumber)).toEqual(['9200001']);
    expect(res.body.items[0]).toMatchObject({ authorityStatus: 'active', operatingStatus: AUTHORITY_LABELS.active, usdotStatus: 'active' });
    expect(res.body).toMatchObject({ inactiveAuthority: 2, authorityError: null });
  });

  it('no MC number: dropped when MC is required, kept as "No MC authority" when it is not', async () => {
    const rows = [censusRow(9300001, null), censusRow(9300002, 7300002)];
    mockCensus(rows);
    const required = await U.agent.post('/api/lead-generators/preview').send({ criteria });
    expect(required.body.items.map((x) => x.dotNumber)).toEqual(['9300002']);
    expect(required.body.inactiveAuthority).toBe(1);

    clearCensusCache();
    mockCensus(rows);
    const optional = await U.agent.post('/api/lead-generators/preview').send({ criteria: { ...criteria, requireMc: false } });
    expect(optional.body.items.map((x) => x.dotNumber).sort()).toEqual(['9300001', '9300002']);
    expect(optional.body.items.find((x) => x.dotNumber === '9300001')).toMatchObject({ authorityStatus: 'none', operatingStatus: 'No MC authority' });

    const P = await registerUser();
    mockCensus(rows);
    const g = await generator(P, 'No MC ok', { criteria: { requireMc: false } });
    const run = await P.agent.post(`/api/lead-generators/${g.id}/run`);
    expect(run.body.run.created).toBe(2);
    const noMc = await prisma.carrier.findFirst({ where: { ownerId: P.user.id, dotNumber: '9300001' } });
    expect(noMc).toMatchObject({ mcNumber: null, authorityStatus: 'none', operatingStatus: 'No MC authority' });
  });

  it('fails closed when FMCSA licensing does not answer: nothing saved, clear message', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const P = await registerUser();
    mockCensus([censusRow(9400001, 7000001), censusRow(9400002, 7000004)]);
    fake.down = true;
    const g = await generator(P, 'Down');
    const res = await P.agent.post(`/api/lead-generators/${g.id}/run`);
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ status: 'error', created: 0 });
    expect(res.body.run.message).toBe('Could not verify operating authority with FMCSA right now. No leads were added; try again in a few minutes.');
    expect(await prisma.carrier.count({ where: { ownerId: P.user.id } })).toBe(0);
    expect(await prisma.leadGenRun.count({ where: { ownerId: P.user.id, status: 'error' } })).toBe(1);
  });

  it('with only the Motus dataset down, legacy carriers are still checked and saved', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const P = await registerUser();
    mockCensus([censusRow(9450001, 7450001)]);
    fake.motusDown = true;
    const g = await generator(P, 'Motus down');
    const res = await P.agent.post(`/api/lead-generators/${g.id}/run`);
    expect(res.body.run).toMatchObject({ created: 1 });
  });

  it('preview fails closed too: the message instead of unverified rows', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockCensus([censusRow(9500001, 7500001)]);
    fake.down = true;
    const res = await U.agent.post('/api/lead-generators/preview').send({ criteria });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.authorityError).toMatch(/^Could not verify operating authority with FMCSA right now\./);
  });

  it('without "active only" every candidate is kept with its real authority', async () => {
    mockCensus([censusRow(9600001, 7600001), censusRow(9600002, 7000002)]);
    const res = await U.agent.post('/api/lead-generators/preview').send({ criteria: { ...criteria, activeOnly: false } });
    expect(res.body.items.map((x) => [x.dotNumber, x.authorityStatus])).toEqual([['9600001', 'active'], ['9600002', 'inactive']]);
    expect(res.body.inactiveAuthority).toBe(0);
  });
});

describe('find carriers (discovery): authority annotations and save guard', () => {
  let U;
  beforeAll(async () => { U = await registerUser(); });

  it('annotates each result, hides non-active ones when "active only" is on, and says how many', async () => {
    mockCensus([censusRow(9700001, 7000001), censusRow(9700002, 647991), censusRow(9700003, 7000003)]);
    const res = await U.agent.get('/api/discovery/search?state=OH');
    expect(res.status).toBe(200);
    expect(res.body.items.map((x) => x.dotNumber)).toEqual(['9700001']);
    expect(res.body.items[0]).toMatchObject({ authorityStatus: 'active', usdotStatus: 'active', authority: { status: 'active', label: AUTHORITY_LABELS.active } });
    expect(res.body).toMatchObject({ hiddenInactive: 2, hiddenUnverified: 0, authorityError: null });
    expect(fake.calls).toHaveLength(1);

    clearCensusCache();
    mockCensus([censusRow(9700001, 7000001), censusRow(9700002, 647991), censusRow(9700003, 7000003)]);
    const all = await U.agent.get('/api/discovery/search?state=OH&activeOnly=false');
    expect(all.body.items.map((x) => [x.dotNumber, x.authorityStatus])).toEqual([['9700001', 'active'], ['9700002', 'inactive'], ['9700003', 'pending']]);
    expect(all.body.hiddenInactive).toBe(0);
  });

  it('hides unverified results when licensing does not answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockCensus([censusRow(9710001, 7100001)]);
    fake.down = true;
    const res = await U.agent.get('/api/discovery/search?state=OH');
    expect(res.body.items).toEqual([]);
    expect(res.body.hiddenUnverified).toBe(1);
    expect(res.body.authorityError).toMatch(/Could not verify operating authority/);
  });

  it('save refuses a carrier with inactive authority unless the user saves it anyway', async () => {
    mockCensus([censusRow(9720001, 647991), censusRow(9720002, 7000001)]);
    const res = await U.agent.post('/api/discovery/save').send({ dotNumbers: ['9720001', '9720002'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, inactiveAuthority: 1 });
    expect(res.body.items.find((i) => i.dotNumber === '9720001')).toMatchObject({ id: null, status: 'inactive_authority', authority: { status: 'inactive', label: AUTHORITY_LABELS.inactive } });
    expect(await prisma.carrier.findFirst({ where: { ownerId: U.user.id, dotNumber: '9720001' } })).toBeNull();
    expect(await prisma.carrier.findFirst({ where: { ownerId: U.user.id, dotNumber: '9720002' } })).toMatchObject({ authorityStatus: 'active', operatingStatus: AUTHORITY_LABELS.active });

    const anyway = await U.agent.post('/api/discovery/save').send({ dotNumbers: ['9720001'], allowInactive: true });
    expect(anyway.body).toMatchObject({ created: 1, inactiveAuthority: 0 });
    expect(await prisma.carrier.findFirst({ where: { ownerId: U.user.id, dotNumber: '9720001' } })).toMatchObject({ authorityStatus: 'inactive', operatingStatus: AUTHORITY_LABELS.inactive });
  });

  it('save does not save carriers it could not verify', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockCensus([censusRow(9730001, 7300001)]);
    fake.down = true;
    const res = await U.agent.post('/api/discovery/save').send({ dotNumbers: ['9730001'] });
    expect(res.body).toMatchObject({ created: 0, unverified: 1, items: [{ dotNumber: '9730001', status: 'unverified' }] });
    expect(await prisma.carrier.count({ where: { ownerId: U.user.id, dotNumber: '9730001' } })).toBe(0);
  });

  it('quick lookup shows the licensing authority, not the census status', async () => {
    mockCensus([censusRow(9740001, 647991)]);
    const res = await U.agent.get('/api/discovery/lookup?dot=9740001');
    expect(res.body.record).toMatchObject({ usdotStatus: 'active', authorityStatus: 'inactive', operatingStatus: AUTHORITY_LABELS.inactive });
    expect(res.body.sources).toContain('fmcsa_licensing');
  });
});

describe('new-authority kit: annotate, never filter', () => {
  let U;
  beforeAll(async () => { U = await registerUser(); });

  it('lists active, pending and inactive carriers with their authority', async () => {
    mockCensus([censusRow(9800001, 7000001), censusRow(9800002, 7000003), censusRow(9800003, 647991)]);
    const res = await U.agent.get('/api/authority-kit/milestones?state=OH&window=new90');
    expect(res.status).toBe(200);
    expect(res.body.items.map((x) => [x.dotNumber, x.authority.status])).toEqual([['9800001', 'active'], ['9800002', 'pending'], ['9800003', 'inactive']]);
    expect(res.body.items[1]).toMatchObject({ authorityStatus: 'pending', operatingStatus: 'Authority pending' });
  });

  it('claims a pending carrier and stores its authority', async () => {
    mockCensus([censusRow(9800002, 7000003)]);
    const res = await U.agent.post('/api/authority-kit/claim').send({ dotNumbers: ['9800002'] });
    expect(res.body).toMatchObject({ created: 1 });
    expect(await prisma.carrier.findFirst({ where: { ownerId: U.user.id, dotNumber: '9800002' } })).toMatchObject({ authorityStatus: 'pending', operatingStatus: 'Authority pending' });
  });

  it('readiness reports operating authority and insurance from licensing', async () => {
    mockCensus([censusRow(9800003, 647991)]);
    const res = await U.agent.get('/api/authority-kit/readiness/9800003');
    const by = Object.fromEntries(res.body.checks.map((c) => [c.key, c]));
    expect(by.usdot.status).toBe('pass');
    expect(by.authority).toMatchObject({ status: 'fail', detail: AUTHORITY_LABELS.inactive, source: 'FMCSA licensing' });
    expect(by.bipd).toMatchObject({ status: 'fail', detail: 'None on file with FMCSA' });
    expect(res.body.authority).toMatchObject({ usdotStatus: 'active', live: 'inactive' });
  });
});

describe('authority refresh job', () => {
  let U; let seq; let lead; let stale;
  const ids = {};

  async function carrier(user, data) {
    const c = await prisma.carrier.create({ data: { ownerId: user.user.id, stageId: lead.id, source: 'lead_generator', ...data } });
    return c.id;
  }

  beforeAll(async () => {
    lead = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
    U = await registerUser();
    stale = new Date(Date.now() - 10 * DAY);
    // Saved before the fix: census "USDOT active" read as authority. Licensing now says inactive.
    ids.lapsed = await carrier(U, { companyName: 'Lapsed Freight', dotNumber: '9900001', mcNumber: '647991', authorityStatus: 'active', operatingStatus: 'USDOT active', verifiedAt: new Date() });
    ids.lapsed2 = await carrier(U, { companyName: 'Gone Freight', dotNumber: '9900007', mcNumber: '7000002', authorityStatus: 'active', operatingStatus: AUTHORITY_LABELS.active, verifiedAt: stale });
    ids.good = await carrier(U, { companyName: 'Good Freight', dotNumber: '9900002', mcNumber: '7900002', authorityStatus: 'active', operatingStatus: 'USDOT active', verifiedAt: stale });
    ids.customer = await carrier(U, { companyName: 'Customer Freight', dotNumber: '9900003', mcNumber: '7000012', authorityStatus: 'active', operatingStatus: 'USDOT active' });
    await prisma.customer.create({ data: { carrierId: ids.customer, ownerId: U.user.id } });
    ids.fresh = await carrier(U, { companyName: 'Fresh Check', dotNumber: '9900004', mcNumber: '7900004', authorityStatus: 'active', operatingStatus: AUTHORITY_LABELS.active, verifiedAt: new Date(Date.now() - DAY) });
    ids.noMc = await carrier(U, { companyName: 'No MC', dotNumber: '9900005' });
    ids.pending = await carrier(U, { companyName: 'Pending Freight', dotNumber: '9900006', mcNumber: '7000003', authorityStatus: 'active', operatingStatus: AUTHORITY_LABELS.active, verifiedAt: stale });
    seq = (await U.agent.post('/api/sequences').send({ name: 'Outreach', steps: [{ dayOffset: 0, type: 'call' }] })).body.sequence;
    const enr = await U.agent.post(`/api/sequences/${seq.id}/enroll`).send({ carrierIds: [ids.lapsed, ids.good, ids.pending] });
    expect(enr.status).toBe(200);
  });

  it('is a daily maintenance job', () => {
    expect(refreshJobs).toEqual([expect.objectContaining({ name: 'carrier-authority-refresh', dailyAtUtc: expect.any(Number), run: expect.any(Function) })]);
  });

  it('updates statuses, stops sequences of carriers that lost authority, notifies once, skips customers and recent checks', async () => {
    const now = new Date();
    const out = await runAuthorityRefresh(now, { ownerIds: [U.user.id] });
    expect(out).toMatchObject({ due: 4, checked: 4, turnedInactive: 2, sequencesStopped: 1, notified: 1, unanswered: 0 });
    const rows = Object.fromEntries((await prisma.carrier.findMany({ where: { ownerId: U.user.id } })).map((c) => [c.id, c]));
    expect(rows[ids.lapsed]).toMatchObject({ authorityStatus: 'inactive', operatingStatus: AUTHORITY_LABELS.inactive });
    expect(rows[ids.lapsed].verifiedAt.getTime()).toBe(now.getTime());
    expect(rows[ids.lapsed2]).toMatchObject({ authorityStatus: 'inactive' });
    expect(rows[ids.good]).toMatchObject({ authorityStatus: 'active', operatingStatus: AUTHORITY_LABELS.active });
    expect(rows[ids.pending]).toMatchObject({ authorityStatus: 'pending', operatingStatus: 'Authority pending' });
    expect(rows[ids.customer]).toMatchObject({ authorityStatus: 'active', operatingStatus: 'USDOT active' }); // customers: FMCSA watchlist
    expect(rows[ids.fresh].verifiedAt.getTime()).toBeLessThan(now.getTime() - DAY / 2); // checked yesterday: not due
    expect(rows[ids.noMc].authorityStatus).toBeNull();
    expect(await prisma.carrier.count({ where: { ownerId: U.user.id } })).toBe(7); // never deleted

    const enrollments = Object.fromEntries((await prisma.sequenceEnrollment.findMany({ where: { sequenceId: seq.id } })).map((e) => [e.carrierId, e]));
    expect(enrollments[ids.lapsed]).toMatchObject({ status: 'stopped', stopReason: 'authority_inactive', nextStepAt: null });
    expect(enrollments[ids.good].status).toBe('active');
    expect(enrollments[ids.pending].status).toBe('active'); // pending authority does not stop outreach

    const notes = await prisma.notification.findMany({ where: { userId: U.user.id, type: 'fmcsa_change' } });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('2 leads lost their operating authority — sequences stopped');
    expect(notes[0].body).toMatch(/Lapsed Freight/);
    expect(notes[0].link).toBe('/app/carriers?authorityStatus=inactive');

    // A second run right away has nothing to do and does not notify again.
    const again = await runAuthorityRefresh(new Date(), { ownerIds: [U.user.id] });
    expect(again).toMatchObject({ due: 0, checked: 0, notified: 0 });
    expect(await prisma.notification.count({ where: { userId: U.user.id, type: 'fmcsa_change' } })).toBe(1);
  });

  it('respects the batch limits: at most `max` carriers, `batch` per licensing request, never-checked first', async () => {
    const V = await registerUser();
    for (let i = 0; i < 5; i++) {
      await carrier(V, { companyName: `Batch ${i}`, dotNumber: `99100${i}`, mcNumber: `79100${i}`, authorityStatus: 'active', operatingStatus: i === 0 ? AUTHORITY_LABELS.active : 'USDOT active', verifiedAt: new Date(Date.now() - (20 - i) * DAY) });
    }
    const first = await runAuthorityRefresh(new Date(), { max: 3, batch: 2, ownerIds: [V.user.id] });
    expect(first).toMatchObject({ due: 3, checked: 3 });
    expect(fake.calls.map((c) => c.length)).toEqual([2, 1]);
    // The licensing-checked one (Batch 0) waits: never-checked carriers go first, oldest check first.
    expect(fake.calls.flat()).toEqual(['MC791001', 'MC791002', 'MC791003']);
    fake.calls.length = 0;
    const second = await runAuthorityRefresh(new Date(), { max: 3, batch: 2, ownerIds: [V.user.id] });
    expect(second).toMatchObject({ due: 2, checked: 2 });
    expect(fake.calls.flat().sort()).toEqual(['MC791000', 'MC791004']);
  });

  it('with one dataset down, acts only on active results and retries the rest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const X = await registerUser();
    const motusOnly = await carrier(X, { companyName: 'Motus Only', dotNumber: '9930001', mcNumber: '7700001', authorityStatus: 'active', operatingStatus: 'USDOT active' });
    const legacyOnly = await carrier(X, { companyName: 'Legacy Only', dotNumber: '9930002', mcNumber: '7930002', authorityStatus: 'active', operatingStatus: 'USDOT active' });
    fake.legacyDown = true;
    const out = await runAuthorityRefresh(new Date(), { ownerIds: [X.user.id] });
    expect(out).toMatchObject({ due: 2, checked: 1, unanswered: 1, turnedInactive: 0 });
    expect(await prisma.carrier.findUnique({ where: { id: motusOnly } })).toMatchObject({ authorityStatus: 'active', operatingStatus: AUTHORITY_LABELS.active });
    // Not in Motus, and legacy did not answer: not marked inactive.
    expect(await prisma.carrier.findUnique({ where: { id: legacyOnly } })).toMatchObject({ authorityStatus: 'active', operatingStatus: 'USDOT active' });
  });

  it('leaves carriers unchanged when licensing does not answer and retries them next run', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const W = await registerUser();
    const id = await carrier(W, { companyName: 'Unverified', dotNumber: '9920001', mcNumber: '647991', authorityStatus: 'active', operatingStatus: 'USDOT active' });
    fake.down = true;
    const out = await runAuthorityRefresh(new Date(), { ownerIds: [W.user.id] });
    expect(out).toMatchObject({ due: 1, checked: 0, unanswered: 1, turnedInactive: 0 });
    expect(await prisma.carrier.findUnique({ where: { id } })).toMatchObject({ authorityStatus: 'active', operatingStatus: 'USDOT active', verifiedAt: null });
    fake.down = false;
    expect(await runAuthorityRefresh(new Date(), { ownerIds: [W.user.id] })).toMatchObject({ checked: 1, turnedInactive: 1 });
  });
});
