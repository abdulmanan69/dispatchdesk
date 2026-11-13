import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { clearCensusCache } from '../src/services/carriers/fmcsaCensus.js';
import { setProfileFetch, clearProfileCache } from '../src/services/carriers/profile.js';
import { assembleInspections, buildInspections, categoryOf, yearFromVin, makeLabel, clearInspectionCache, NATIONAL_AVG } from '../src/services/carriers/inspections.js';
import { assembleRelated, matchKeys, clearRelatedCache } from '../src/services/carriers/related.js';
import { parseCheckQuery, checkWhere } from '../src/services/carriers/carrierCheck.js';
import { setFmcsaFetch } from '../src/services/brokers/fmcsa.js';
import { clearAuthorityCache } from '../src/services/carriers/authority.js';
import { licensingFake } from './licensingFake.js';
import { normDot } from '../src/services/carriers/normalize.js';

const NOW = new Date('2026-11-13T12:00:00Z');
const ok = (rows) => ({ ok: true, rows });

// Rows in the column formats of the real MCMIS files (all text). USDOT 3636864 mirrors the carrier the user compared
// against CarrierChk: five inspections, one with an out-of-service fuel leak.
const AGG = [
  { insp_date: '20260731', insp_level_id: '2', n: '1', d_oos: '0', v_oos: '0', any_oos: '0', hm: '0', hm_oos: '0', wv: '1' },
  { insp_date: '20260721', insp_level_id: '2', n: '1', d_oos: '0', v_oos: '0', any_oos: '0', hm: '0', hm_oos: '0', wv: '1' },
  { insp_date: '20260205', insp_level_id: '1', n: '1', d_oos: '0', v_oos: '1', any_oos: '1', hm: '0', hm_oos: '0', wv: '1' },
];
const YEARLY = [
  { insp_date: '20260731', n: '1', any_oos: '0' }, { insp_date: '20260721', n: '1', any_oos: '0' }, { insp_date: '20260205', n: '1', any_oos: '1' },
  { insp_date: '20240716', n: '1', any_oos: '0' }, { insp_date: '20240130', n: '1', any_oos: '0' },
];
const RECENT = [
  { inspection_id: '88591735', insp_date: '20260731', report_number: 'PSC0881250', report_state: 'WV', location_desc: 'TRIADELPHIA WV', insp_level_id: '2', insp_facility: 'R', viol_total: '3', oos_total: '0', driver_oos_total: '0', vehicle_oos_total: '0', hazmat_oos_total: '0', hazmat_placard_req: 'N', post_acc_ind: 'N' },
  { inspection_id: '86979439', insp_date: '20260205', report_number: 'PA0001', report_state: 'PA', location_desc: 'CARNEGIE PA', insp_level_id: '1', insp_facility: 'F', viol_total: '2', oos_total: '1', driver_oos_total: '0', vehicle_oos_total: '1', hazmat_oos_total: '0', hazmat_placard_req: 'N', post_acc_ind: 'N' },
];
const VIOLATIONS = [
  { inspection_id: '88591735', insp_unit_id: 'U1', part_no: '393', part_no_section: '60C', viol_code: '393.60C', viol_desc: 'Windshield - Damaged or Discolored', out_of_service_indicator: 'N', citation_number: '' },
  { inspection_id: '88591735', insp_unit_id: 'U1', part_no: '392', part_no_section: '2-SLLTCD', viol_code: '392.2-SLLTCD', viol_desc: 'Failed to obey a traffic control device', out_of_service_indicator: 'N', citation_number: '0' },
  { inspection_id: '86979439', insp_unit_id: 'U2', part_no: '393', part_no_section: '65C', viol_code: '393.65C', viol_desc: 'Fuel leak', out_of_service_indicator: 'Y', citation_number: 'C123' },
  { inspection_id: '86979439', insp_unit_id: 'U2', part_no: '395', part_no_section: '8', viol_code: '395.8', viol_desc: 'No record of duty status', out_of_service_indicator: 'N', citation_number: '' },
];
const UNITS = [
  { inspection_id: '88591735', insp_unit_id: 'U1', insp_unit_type_id: '10', insp_unit_number: '1', insp_unit_make: 'INTERNATIO', insp_unit_license: 'VBP2763', insp_unit_license_state: 'PA', insp_unit_vehicle_id_number: '1HTMMAAM37H469630' },
  { inspection_id: '86979439', insp_unit_id: 'U2', insp_unit_type_id: '10', insp_unit_number: '1', insp_unit_make: 'FREIGHTLIN', insp_unit_license: 'VBW2660', insp_unit_license_state: 'PA', insp_unit_vehicle_id_number: '1FVACWCS87HX29343' },
];
const CRASH_AGG = [{ n: '1', fatal: '0', injury: '1', tow: '1' }];
const CRASHES = [{ report_date: '20260301', report_number: 'PA9', state: 'PA', city: 'PITTSBURGH', location: 'I-79', fatalities: '0', injuries: '1', tow_away: 'Y', hazmat_released: 'N', vehicles_in_accident: '2' }];

const src = (over = {}) => ({
  aggregate: ok(AGG), yearly: ok(YEARLY), states: ok([{ report_state: 'PA', n: '2' }, { report_state: 'WV', n: '1' }]), recent: ok(RECENT),
  violations: ok(VIOLATIONS), units: ok(UNITS), crashAggregate: ok(CRASH_AGG), crashes: ok(CRASHES), ...over,
});

describe('inspection report (pure)', () => {
  it('maps violations to SMS categories by CFR part', () => {
    expect(categoryOf('395', '8')).toBe('hos');
    expect(categoryOf('391', '41A-F')).toBe('driver_fitness');
    expect(categoryOf('392', '2-SLLS2')).toBe('unsafe_driving');
    expect(categoryOf('392', '4A')).toBe('drugs_alcohol');
    expect(categoryOf('392', '9A3')).toBe('vehicle_maintenance');
    expect(categoryOf('393', '75A')).toBe('vehicle_maintenance');
    expect(categoryOf('397', '5')).toBe('hazmat');
    expect(categoryOf('390', '21')).toBe('other');
  });

  it('reads the model year from the VIN (latest year of the 30-year cycle, not after next year)', () => {
    expect(yearFromVin('1HTMMAAM37H469630', NOW)).toBe(2007);
    expect(yearFromVin('5PVNJ8JV4K4S70646', NOW)).toBe(2019);
    expect(yearFromVin('3AKJHPDV1VSXH0864', NOW)).toBe(2027);
    expect(yearFromVin('SHORT', NOW)).toBeNull();
    expect(makeLabel('INTERNATIO')).toBe('International');
    expect(makeLabel('PTB')).toBe('Peterbilt');
    expect(makeLabel('0000')).toBeNull();
  });

  it('builds totals, rates, years, states, categories, vehicles, records and crashes', () => {
    const vins = new Map([['1HTMMAAM37H469630', { year: 2007, make: 'International', model: 'MA025', body: 'Truck' }]]);
    const r = assembleInspections(src(), { dot: '3636864', now: NOW, vins });
    expect(r.summary).toMatchObject({ inspections: 3, withViolations: 3, oosInspections: 1 });
    // Fewer than 5 inspections: no rate (not 0%).
    expect(r.summary.vehicle).toMatchObject({ inspections: 3, oos: 1, oosRate: null, nationalAvg: NATIONAL_AVG.vehicle });
    expect(r.summary.driver).toMatchObject({ inspections: 3, oos: 0, oosRate: null });
    expect(r.byYear).toEqual([{ year: 2026, inspections: 3, oos: 1 }, { year: 2024, inspections: 2, oos: 0 }]);
    expect(r.byState[0]).toEqual({ state: 'PA', inspections: 2 });
    const cats = Object.fromEntries(r.violationsByCategory.map((c) => [c.key, c]));
    expect(cats.vehicle_maintenance).toMatchObject({ violations: 2, oos: 1, inspections: 2 });
    expect(cats.unsafe_driving.violations).toBe(1);
    expect(cats.hos.violations).toBe(1);
    expect(r.equipment).toHaveLength(2);
    expect(r.equipment.find((e) => e.vin === '1HTMMAAM37H469630')).toMatchObject({ year: 2007, make: 'International', model: 'MA025', type: 'Straight truck', decoded: true, inspections: 1, oosInspections: 0 });
    // Not decoded by NHTSA: make from the report, year from the VIN.
    expect(r.equipment.find((e) => e.vin === '1FVACWCS87HX29343')).toMatchObject({ year: 2007, make: 'Freightliner', decoded: false, oosInspections: 1 });
    expect(r.records[0]).toMatchObject({ id: '88591735', date: '2026-07-31', location: 'Triadelphia WV', levelLabel: 'Level II · walk-around', facility: 'Roadside', violations: 3 });
    expect(r.records[1].violationList.find((v) => v.code === '393.65C')).toMatchObject({ oos: true, citation: true, unit: 'Straight truck', categoryLabel: 'Vehicle maintenance' });
    expect(r.records[0].violationList.find((v) => v.code === '392.2-SLLTCD').citation).toBe(false);
    expect(r.crashes).toMatchObject({ total: 1, fatal: 0, injury: 1, tow: 1 });
    expect(r.crashes.records[0]).toMatchObject({ date: '2026-03-01', city: 'Pittsburgh', injuries: 1, towAway: true });
    expect(r.flags.map((f) => f.code)).toEqual(['crashes']);
    expect(r.complete).toBe(true);
  });

  it('flags an out-of-service rate above the national average (red at twice the average) and fatal crashes', () => {
    const agg = [{ insp_date: '20260101', insp_level_id: '1', n: '10', d_oos: '0', v_oos: '5', any_oos: '5', hm: '0', hm_oos: '0', wv: '8' }];
    const r = assembleInspections(src({ aggregate: ok(agg), crashAggregate: ok([{ n: '2', fatal: '1', injury: '0', tow: '1' }]) }), { dot: '1', now: NOW });
    expect(r.summary.vehicle).toMatchObject({ inspections: 10, oos: 5, oosRate: 50, aboveAverage: true });
    expect(r.summary.driver).toMatchObject({ inspections: 10, oos: 0, oosRate: 0, aboveAverage: false });
    expect(r.flags.map((f) => `${f.level}:${f.code}`)).toEqual(['red:oos_vehicle', 'red:fatal_crash']);
    // QCMobile's national averages win when given.
    const live = assembleInspections(src({ aggregate: ok(agg) }), { dot: '1', now: NOW, national: { vehicle: 60, driver: 6, hazmat: 4, asOf: '2026' } });
    expect(live.summary.vehicle.aboveAverage).toBe(false);
    expect(live.flags.some((f) => f.code === 'oos_vehicle')).toBe(false);
  });

  it('a failed file leaves only its block empty and marks the report incomplete', () => {
    const r = assembleInspections(src({ violations: { ok: false, error: 'Answered 500' }, crashAggregate: { ok: false, error: 'Timed out' } }), { dot: '3636864', now: NOW });
    expect(r.violationsByCategory).toBeNull();
    expect(r.crashes).toBeNull();
    expect(r.summary.inspections).toBe(3);
    expect(r.records).toHaveLength(2);
    expect(r.complete).toBe(false);
    expect(r.sources.filter((s) => !s.ok).map((s) => s.key)).toEqual(['violations', 'crashAggregate']);
  });
});

describe('related carriers (pure)', () => {
  const contact = { phone: '5162442068', cellPhone: null, email: 'Dean@Example.com', physicalAddress: { street: '533 E MAIN ST', city: 'CARNEGIE', state: 'PA', zip: '15106-1234' } };
  it('matches phone, email and street address; skips PO boxes and fake numbers', () => {
    expect(matchKeys(contact).map((k) => k.kind)).toEqual(['phone', 'email', 'address']);
    expect(matchKeys({ phone: '0000000000', physicalAddress: { street: 'PO BOX 12', zip: '15106' } })).toEqual([]);
  });
  it('lists carriers sharing a detail, flags inactive ones, and counts (not lists) service-company details', () => {
    const rows = [
      { dot_number: '3636864', phone: '5162442068' }, // itself
      { dot_number: '3228371', legal_name: 'A&D TRUCKING', phone: '5162442068', phy_street: '533 E MAIN ST', phy_zip: '15106', status_code: 'I', add_date: '20190103', phy_city: 'CARNEGIE', phy_state: 'PA' },
      { dot_number: '3000001', legal_name: 'OTHER LLC', email_address: 'DEAN@EXAMPLE.COM', status_code: 'A', add_date: '20200101' },
    ];
    const r = assembleRelated({ dot: '3636864', contact, rows, now: NOW });
    expect(r.carriers.map((c) => [c.dot, c.matches])).toEqual([['3228371', ['phone', 'address']], ['3000001', ['email']]]);
    expect(r.carriers[0]).toMatchObject({ name: 'A&D TRUCKING', usdotStatus: 'inactive', city: 'Carnegie' });
    expect(r.flags[0]).toMatchObject({ level: 'amber', code: 'related_inactive' });
    expect(r.flags[0].text).toMatch(/phone, address with 1 inactive/);

    const agent = Array.from({ length: 20 }, (_, i) => ({ dot_number: String(5000000 + i), phy_street: '533 E MAIN ST', phy_zip: '15106', status_code: 'A' }));
    const busy = assembleRelated({ dot: '3636864', contact, rows: agent, now: NOW });
    expect(busy.carriers).toEqual([]);
    expect(busy.serviceShared).toEqual([{ kind: 'address', count: 20 }]);
    expect(busy.flags).toEqual([]);
  });
});

describe('carrier check search box', () => {
  it('understands USDOT, MC, bare numbers, phones, emails and names', () => {
    expect(parseCheckQuery('MC 1248213')).toEqual({ kind: 'mc', value: '1248213' });
    expect(parseCheckQuery('mc-0647991')).toEqual({ kind: 'mc', value: '647991' });
    expect(parseCheckQuery('USDOT 3636864')).toEqual({ kind: 'dot', value: '3636864' });
    expect(parseCheckQuery('3636864')).toEqual({ kind: 'number', value: '3636864' });
    expect(parseCheckQuery('(516) 244-2068')).toEqual({ kind: 'phone', value: '5162442068' });
    expect(parseCheckQuery('Dean@Gmail.com')).toEqual({ kind: 'email', value: 'dean@gmail.com' });
    expect(parseCheckQuery("dean's logistics")).toEqual({ kind: 'name', value: 'DEAN S LOGISTICS' });
    expect(parseCheckQuery('x')).toBeNull();
    expect(parseCheckQuery('   ')).toBeNull();
  });
  it('escapes values and finds "DEAN\'S" from "deans"', () => {
    expect(checkWhere({ kind: 'number', value: '3636864' })).toBe("dot_number='3636864' OR (docket1prefix='MC' AND docket1='3636864')");
    expect(checkWhere({ kind: 'name', value: 'DEANS LOGISTICS' })).toBe("upper(legal_name) like '%DEAN%LOGISTIC%' OR upper(dba_name) like '%DEAN%LOGISTIC%'");
    expect(checkWhere({ kind: 'email', value: "o'neil@x.com" })).toBe("email_address in('o''neil@x.com','O''NEIL@X.COM')");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------------------------

const CENSUS = {
  dot_number: '3636864', legal_name: "DEAN'S LOGISTICS LLC", status_code: 'A', add_date: '20210517', phone: '5162442068', email_address: 'deangordon015@gmail.com',
  phy_street: '533 E MAIN ST', phy_city: 'CARNEGIE', phy_state: 'PA', phy_zip: '15106', docket1prefix: 'MC', docket1: '1248213', power_units: '1', carrier_operation: 'A',
};
const SISTER = { dot_number: '3228371', legal_name: 'A&D TRUCKING', status_code: 'I', add_date: '20190103', phone: '5162442068', phy_street: '1 OTHER RD', phy_zip: '15106' };

const reply = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body });
function fakeData() {
  const calls = [];
  const fn = vi.fn(async (input, opts) => {
    const u = new URL(String(input));
    if (u.host === 'vpic.nhtsa.dot.gov') {
      calls.push('vpic');
      return reply({ Results: [{ VIN: '1HTMMAAM37H469630', ModelYear: '2007', Make: 'INTERNATIONAL', Model: 'MA025', BodyClass: 'Truck' }] });
    }
    if (u.host !== 'data.transportation.gov') throw new Error(`unexpected request in a test: ${u.host}`);
    const id = u.pathname.split('/').pop().replace('.json', '');
    const where = u.searchParams.get('$where') || '';
    const select = u.searchParams.get('$select') || '';
    const group = u.searchParams.get('$group') || '';
    calls.push(`${id}:${select.slice(0, 20)}`);
    const has3636864 = where.includes("'3636864'");
    if (id === 'fx4q-ay7w') {
      if (!has3636864) return reply([]);
      if (group === 'insp_date,insp_level_id') return reply(AGG);
      if (group === 'insp_date') return reply(YEARLY);
      if (group === 'report_state') return reply([{ report_state: 'PA', n: '2' }]);
      return reply(RECENT);
    }
    if (id === '876r-jsdb') return reply(VIOLATIONS);
    if (id === 'wt8s-2hbx') return reply(UNITS);
    if (id === 'aayw-vxb3') return reply(select.startsWith('count') ? CRASH_AGG : CRASHES);
    if (id === 'az4n-8mr2') {
      if (/phone in|email_address in|phy_street=/.test(where) && where.includes("dot_number!='3636864'")) return reply([SISTER]);
      if (where.includes("dot_number='3636864'") || where.includes("docket1='1248213'") || where.includes("dot_number in('3636864'")) return reply([CENSUS]);
      if (where.includes('like')) return reply([CENSUS]);
      return reply([]);
    }
    return reply([]); // licensing / insurance / history datasets: nothing on file
  });
  setProfileFetch(fn);
  return { fn, calls };
}

afterAll(() => { setProfileFetch(null); setFmcsaFetch(null); });
beforeEach(() => { clearCensusCache(); clearProfileCache(); clearInspectionCache(); clearRelatedCache(); clearAuthorityCache(); });

describe('carrier check API', () => {
  let A;
  let stageId;
  beforeAll(async () => {
    A = await registerUser();
    stageId = (await prisma.pipelineStage.findUnique({ where: { key: 'lead' } })).id;
    setFmcsaFetch(licensingFake().fetch);
  });

  it('GET /dot/:dot/inspections builds the report once and serves the cache after', async () => {
    const { fn } = fakeData();
    const res = await A.agent.get('/api/carrier-profile/dot/3636864/inspections');
    expect(res.status).toBe(200);
    expect(res.body.report).toMatchObject({ dot: '3636864', summary: { inspections: 3 }, detailCount: 2, crashes: { total: 1 } });
    expect(res.body.report.equipment.find((e) => e.vin === '1HTMMAAM37H469630')).toMatchObject({ make: 'International', model: 'MA025', decoded: true });
    const n = fn.mock.calls.length;
    expect((await A.agent.get('/api/carrier-profile/dot/3636864/inspections')).status).toBe(200);
    expect(fn.mock.calls.length).toBe(n);
    expect((await A.agent.get('/api/carrier-profile/dot/abc/inspections')).status).toBe(400);
  });

  it('GET /dot/:dot/inspections says when FMCSA is down', async () => {
    setProfileFetch(vi.fn(async () => reply({ message: 'boom' }, 500)));
    const res = await A.agent.get('/api/carrier-profile/dot/3636864/inspections');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/inspection data is not available/);
  });

  it('GET /dot/:dot/related lists carriers sharing contact details', async () => {
    fakeData();
    const res = await A.agent.get('/api/carrier-profile/dot/3636864/related');
    expect(res.status).toBe(200);
    expect(res.body.related.carriers).toEqual([expect.objectContaining({ dot: '3228371', matches: ['phone'], usdotStatus: 'inactive' })]);
    expect(res.body.related.flags[0].code).toBe('related_inactive');
  });

  it('GET /search finds a carrier and says whether it is already in your list', async () => {
    fakeData();
    let res = await A.agent.get('/api/carrier-profile/search').query({ q: 'MC 1248213' });
    expect(res.status).toBe(200);
    expect(res.body.query).toEqual({ kind: 'mc', value: '1248213' });
    expect(res.body.items).toEqual([expect.objectContaining({ dotNumber: '3636864', mcNumber: '1248213', companyName: "DEAN'S LOGISTICS LLC", existsInCrm: false, authorityStatus: 'active' })]);
    const saved = await prisma.carrier.create({ data: { ownerId: A.user.id, stageId, companyName: "DEAN'S LOGISTICS LLC", dotNumber: '3636864' } });
    clearCensusCache();
    res = await A.agent.get('/api/carrier-profile/search').query({ q: 'deans logistics' });
    expect(res.body.query.kind).toBe('name');
    expect(res.body.items[0]).toMatchObject({ existsInCrm: true, existingId: saved.id });
    expect((await A.agent.get('/api/carrier-profile/search').query({ q: 'x' })).status).toBe(400);
  });

  it('POST /bulk checks up to 25 numbers and reports the ones FMCSA does not know', async () => {
    fakeData();
    const res = await A.agent.post('/api/carrier-profile/bulk').send({ numbers: ['3636864', 'MC 1248213', 'USDOT 9999991', 'hello'] });
    expect(res.status).toBe(200);
    expect(res.body.results.map((x) => x.carrier?.dotNumber || x.error)).toEqual(['3636864', '3636864', 'No FMCSA record', 'Not a USDOT or MC number']);
    const tooMany = await A.agent.post('/api/carrier-profile/bulk').send({ numbers: Array.from({ length: 26 }, (_, i) => String(100 + i)) });
    expect(tooMany.status).toBe(400);
  });

  it('requires a session', async () => {
    const { default: request } = await import('supertest');
    const { app } = await import('./helpers.js');
    expect((await request(app).get('/api/carrier-profile/search').query({ q: '3636864' })).status).toBe(401);
    expect(normDot('03636864')).toBe('3636864');
  });
});

describe('carrier header verdict (stored profile)', () => {
  it('takes the worst flag of the stored FMCSA profile', async () => {
    const { verdictOfSnapshot } = await import('../src/routes/carriers.js');
    const snap = (flags) => JSON.stringify({ found: true, profile: { fetchedAt: '2026-11-13T00:00:00Z', flags } });
    expect(verdictOfSnapshot(null)).toBeNull();
    expect(verdictOfSnapshot('{bad json')).toBeNull();
    expect(verdictOfSnapshot(JSON.stringify({ found: true }))).toBeNull();
    expect(verdictOfSnapshot(snap([{ level: 'amber', text: 'New authority' }, { level: 'red', text: 'No liability (BIPD) insurance on file' }])))
      .toMatchObject({ level: 'fail', label: 'Do not book', text: 'No liability (BIPD) insurance on file', count: 2, checkedAt: '2026-11-13T00:00:00Z' });
    expect(verdictOfSnapshot(snap([{ level: 'amber', text: 'New authority' }]))).toMatchObject({ level: 'warn', count: 1 });
    expect(verdictOfSnapshot(snap([{ level: 'green', text: 'Authority active' }]))).toMatchObject({ level: 'pass', count: 0 });
  });
});
