import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { clearCensusCache } from '../src/services/carriers/fmcsaCensus.js';
import { setSetting, invalidateSettings } from '../src/lib/settings.js';
import { milestoneRange, brokerAcceptance, buildReadiness, readinessText } from '../src/services/carriers/readiness.js';

const DAY = 86400000;
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const daysAgo = (n) => new Date(Date.now() - n * DAY);

const row = (dot, ageDays, extra = {}) => ({
  dot_number: String(dot), legal_name: `NEW AUTHORITY ${dot} LLC`, phone: `61455${String(dot).slice(-5).padStart(5, '0')}`, email_address: `ops${dot}@new.test`,
  phy_street: '1 MAIN ST', phy_city: 'COLUMBUS', phy_state: 'OH', phy_zip: '43004', power_units: '1', status_code: 'A', add_date: ymd(daysAgo(ageDays)),
  carrier_operation: 'A', docket1prefix: 'MC', docket1: String(1500000 + Number(dot)), docket1_status_code: 'A', crgo_genfreight: 'X', ...extra,
});
const ROWS = [row(8100001, 12), row(8100002, 20), row(8100003, 25, { docket1_status_code: 'P', email_address: undefined })];

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

function stub({ qc = null } = {}) {
  const fn = vi.fn(async (input) => {
    const u = new URL(String(input));
    if (u.host.includes('mobile.fmcsa.dot.gov')) {
      if (!qc) return { ok: false, status: 404, json: async () => ({}) };
      return ok(u.pathname.endsWith('/authority') ? { content: [{ carrierAuthority: { commonAuthorityStatus: 'A' } }] } : { content: { carrier: qc } });
    }
    const select = u.searchParams.get('$select') || '';
    if (select.startsWith('max(add_date)')) return ok([{ newest: ymd(daysAgo(10)) }]);
    if (select.startsWith('count(')) return ok([{ n: '42' }]);
    const where = u.searchParams.get('$where') || '';
    const many = where.match(/dot_number in\(([^)]*)\)/);
    if (many) { const dots = many[1].split(',').map((s) => s.replace(/'/g, '')); return ok(ROWS.filter((r) => dots.includes(r.dot_number))); }
    const one = where.match(/dot_number='(\d+)'/);
    if (one) return ok(ROWS.filter((r) => r.dot_number === one[1]));
    return ok(ROWS);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function makeTeam(owner, member) {
  expect((await owner.agent.post('/api/teams').send({ name: `Kit Team ${Date.now()}` })).status).toBe(201);
  const inv = await owner.agent.post('/api/teams/invitations').send({ email: member.email, role: 'dispatcher' });
  expect((await member.agent.post(`/api/teams/invitations/${inv.body.devToken}/accept`)).status).toBe(200);
}

describe('new-authority kit helpers', () => {
  it('turns milestones into census date bounds', () => {
    const now = new Date('2026-11-10T15:00:00Z');
    expect(milestoneRange('new7', now)).toEqual({ addedAfter: new Date('2026-11-03T00:00:00Z'), addedBefore: undefined });
    expect(milestoneRange('turning90', now)).toEqual({ addedAfter: new Date('2026-08-12T00:00:00Z'), addedBefore: new Date('2026-08-19T00:00:00Z') });
  });

  it('phrases broker age minimums as days to go', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    expect(brokerAcceptance(new Date('2026-10-31T00:00:00Z'), now)).toMatchObject({ ageDays: 10 });
    expect(brokerAcceptance(new Date('2026-10-31T00:00:00Z'), now).note).toMatch(/90 days of authority become an option in 80 days/);
    expect(brokerAcceptance(null, now).ageDays).toBeNull();
  });

  it('marks insurance unknown without QCMobile instead of guessing', () => {
    const report = buildReadiness({ companyName: 'X', dotNumber: '1', mcNumber: '2', authorityStatus: 'active', phone: '1', _extra: { docketStatus: 'active' } }, null, { qcConfigured: false });
    expect(report.insuranceStatus).toBe('unknown');
    expect(report.checks.find((c) => c.key === 'bipd')).toMatchObject({ status: 'unknown' });
    expect(report.checks.find((c) => c.key === 'contact').detail).toMatch(/Missing: email, address/);
  });

  it('words a failed check as a problem in the text summary (an out-of-service order is not "missing")', () => {
    const qc = { authorityStatus: 'active', allowedToOperate: false, bipdOnFile: 750000, bipdRequired: 750000, cargoOnFile: 0, outOfServiceDate: '2026-10-01' };
    const report = buildReadiness({ companyName: 'X', dotNumber: '1', mcNumber: '2', authorityStatus: 'active', phone: '1', _extra: { docketStatus: 'active' } }, qc, { qcConfigured: true });
    expect(report.checks.find((c) => c.key === 'oos')).toMatchObject({ status: 'fail' });
    const text = readinessText(report);
    expect(text).toContain('- Out-of-service order: Problem. Out of service since 2026-10-01');
    expect(text).not.toMatch(/Out-of-service order: Missing/);
  });
});

describe('new-authority kit API', () => {
  let A; let T1; let T2; let stranger;
  beforeAll(async () => {
    A = await registerUser();
    T1 = await registerUser({ name: 'Tina Teammate' });
    T2 = await registerUser({ name: 'Theo Teammate' });
    stranger = await registerUser();
    await makeTeam(T1, T2);
    // A already has one of the carriers; T1 (T2's teammate) has another.
    stub();
    await A.agent.post('/api/carriers').send({ companyName: 'Mine Already', dotNumber: '8100001' });
    await T1.agent.post('/api/carriers').send({ companyName: 'Teammate Has It', dotNumber: '8100002' });
    vi.unstubAllGlobals();
  });
  afterEach(() => { vi.unstubAllGlobals(); clearCensusCache(); });

  it('validates the list query', async () => {
    stub();
    expect((await A.agent.get('/api/authority-kit/milestones')).status).toBe(400);
    expect((await A.agent.get('/api/authority-kit/milestones?state=OH&window=new3')).status).toBe(400);
    expect((await A.agent.get('/api/authority-kit/milestones?state=OH&cargo=crgo_nope')).status).toBe(400);
    expect((await A.agent.get('/api/authority-kit/milestones?state=OH&equipment=dry_van')).status).toBe(400);
  });

  it('filters by equipment through the cargo classes that imply it', async () => {
    const fetchMock = stub();
    const res = await A.agent.get('/api/authority-kit/milestones?state=OH&window=turning90&equipment=reefer');
    expect(res.status).toBe(200);
    const where = new URL(String(fetchMock.mock.calls.find(([u]) => !String(u).includes('max'))[0])).searchParams.get('$where');
    expect(where).toContain("(crgo_coldfood='X' OR crgo_meat='X' OR crgo_produce='X')");
    expect(where).toMatch(/add_date>='\d{8}' AND add_date<='\d{8}'/);
    expect(res.body.equipmentOptions.find((o) => o.value === 'reefer').cargo).toContain('Refrigerated food');
  });

  it('lists carriers by registration age with CRM status, census freshness and a short-lived cache', async () => {
    const fetchMock = stub();
    const res = await A.agent.get('/api/authority-kit/milestones?state=oh&window=new30&cargo=crgo_genfreight');
    expect(res.status).toBe(200);
    const where = new URL(String(fetchMock.mock.calls.find(([u]) => !String(u).includes('max'))[0])).searchParams.get('$where');
    expect(where).toContain("phy_state='OH'");
    expect(where).toContain("docket1prefix='MC'");
    expect(where).toContain('phone IS NOT NULL');
    expect(where).toContain("(crgo_genfreight='X')");
    expect(where).toMatch(/add_date>='\d{8}'/);
    expect(res.body.window).toMatchObject({ key: 'new30', label: 'Registered in the last 30 days' });
    expect(res.body.newestRecord).toBeTruthy();
    const [mine, team, fresh] = res.body.items;
    expect(mine).toMatchObject({ dotNumber: '8100001', existsInCrm: true, ageDays: 12 });
    expect(team).toMatchObject({ dotNumber: '8100002', existsInCrm: false, teamClaims: [] }); // A is not on T1's team
    expect(fresh).toMatchObject({ existsInCrm: false, docketStatus: 'pending' });
    const calls = fetchMock.mock.calls.length;
    await A.agent.get('/api/authority-kit/milestones?state=OH&window=new30&cargo=crgo_genfreight');
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('warns teammates about each other (team collision guard) without sharing record ids', async () => {
    stub();
    const res = await T2.agent.get('/api/authority-kit/milestones?state=OH');
    const team = res.body.items.find((i) => i.dotNumber === '8100002');
    expect(team.teamClaims).toEqual([expect.objectContaining({ ownerName: 'Tina Teammate', stage: { key: 'lead', name: expect.any(String) } })]);
    expect(team.teamClaims[0].carrierId).toBeUndefined();
    const col = await T2.agent.get('/api/authority-kit/collisions?dots=8100002,8100003');
    expect(col.body.items[0].teamClaims[0].ownerName).toBe('Tina Teammate');
    expect(col.body.items[1].teamClaims).toEqual([]);
    const outsider = await stranger.agent.get('/api/authority-kit/collisions?dots=8100002');
    expect(outsider.body.items[0]).toEqual({ dotNumber: '8100002', carrierId: null, teamClaims: [] });
  });

  it('claim refuses a teammate\'s carrier until confirmed, then saves a verified record', async () => {
    stub();
    const blocked = await T2.agent.post('/api/authority-kit/claim').send({ dotNumbers: ['8100002'] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/Tina Teammate already has this carrier/);
    expect(blocked.body.details.collisions[0].dotNumber).toBe('8100002');
    const forced = await T2.agent.post('/api/authority-kit/claim').send({ dotNumbers: ['8100002'], force: true });
    expect(forced.status).toBe(200);
    expect(forced.body).toMatchObject({ created: 1, items: [{ dotNumber: '8100002', status: 'created' }] });
    const saved = await prisma.carrier.findFirst({ where: { ownerId: T2.user.id, dotNumber: '8100002' } });
    expect(saved).toMatchObject({ source: 'fmcsa_census', sourceRef: 'USDOT 8100002 · New authority' });
    expect(saved.verifiedAt).not.toBeNull();
  });

  it('claim reports existing records with their id and enrolls new ones in a sequence', async () => {
    stub();
    const seq = (await A.agent.post('/api/sequences').send({ name: 'New authority', steps: [{ dayOffset: 0, type: 'call' }] })).body.sequence;
    const res = await A.agent.post('/api/authority-kit/claim').send({ dotNumbers: ['8100001', '8100003', '8199999'], sequenceId: seq.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, skipped: 1, notFound: 1, enrolled: 1 });
    const mine = await prisma.carrier.findFirst({ where: { ownerId: A.user.id, dotNumber: '8100001' } });
    expect(res.body.items.find((i) => i.dotNumber === '8100001')).toEqual({ dotNumber: '8100001', id: mine.id, status: 'existing' });
    expect((await stranger.agent.post('/api/authority-kit/claim').send({ dotNumbers: ['8100003'], sequenceId: seq.id })).status).toBe(400);
  });

  it('claim respects the daily discovery limit', async () => {
    stub();
    const L = await registerUser();
    const free = await prisma.plan.findUnique({ where: { key: 'free' } });
    const lead = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
    await prisma.carrier.createMany({ data: Array.from({ length: free.maxDiscoveryPerDay }, (_, i) => ({ ownerId: L.user.id, stageId: lead.id, companyName: `D ${i}`, source: 'fmcsa_census' })) });
    const res = await L.agent.post('/api/authority-kit/claim').send({ dotNumbers: ['8100003'] });
    expect(res.status).toBe(402);
  });

  it('readiness without a QCMobile key reports what the census shows and marks the rest unknown', async () => {
    stub();
    const res = await A.agent.get('/api/authority-kit/readiness/8100003');
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.checks.map((c) => [c.key, c]));
    expect(by.usdot.status).toBe('pass');
    expect(by.docket).toMatchObject({ status: 'warn', detail: expect.stringContaining('pending') });
    expect(by.authority.status).toBe('unknown');
    expect(by.bipd.status).toBe('unknown');
    expect(by.contact).toMatchObject({ status: 'warn', detail: 'Missing: email' });
    expect(res.body.authority.ageDays).toBe(25);
    expect(res.body.insuranceStatus).toBe('unknown');
    expect(res.body.text).toMatch(/Authority snapshot for NEW AUTHORITY 8100003 LLC/);
    expect(res.body.crm).toMatchObject({ existsInCrm: true }); // claimed in the test above
    expect((await A.agent.get('/api/authority-kit/readiness/8199999')).status).toBe(404);
    expect((await A.agent.get('/api/authority-kit/readiness/abc')).status).toBe(400);
  });

  it('readiness uses QCMobile insurance and authority when a webKey is set', async () => {
    await setSetting('fmcsa.webKey', 'test-web-key', A.user.id);
    invalidateSettings();
    try {
      stub({ qc: { allowedToOperate: 'Y', bipdInsuranceOnFile: '750', bipdRequiredAmount: '750', cargoInsuranceOnFile: '0', bondInsuranceOnFile: '0' } });
      const res = await A.agent.get('/api/authority-kit/readiness/8100002');
      const by = Object.fromEntries(res.body.checks.map((c) => [c.key, c]));
      expect(by.authority.status).toBe('pass');
      expect(by.bipd).toMatchObject({ status: 'pass', detail: '$750,000 on file, $750,000 required' });
      expect(by.cargo.status).toBe('warn');
      expect(by.oos.status).toBe('pass');
      expect(res.body.insuranceStatus).toBe('on_file');
    } finally {
      await setSetting('fmcsa.webKey', '', A.user.id);
      invalidateSettings();
    }
  });

  it('discovery save returns the id of a carrier that is already in the CRM (save and call)', async () => {
    stub();
    const res = await A.agent.post('/api/discovery/save').send({ dotNumbers: ['8100001'] });
    const mine = await prisma.carrier.findFirst({ where: { ownerId: A.user.id, dotNumber: '8100001' } });
    expect(res.body).toMatchObject({ created: 0, skipped: 1, items: [{ dotNumber: '8100001', id: mine.id, status: 'existing' }] });
  });
});
