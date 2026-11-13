import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { registerUser } from './helpers.js';
import { mapRecord, buildWhere, clearCensusCache, censusFacts, inferEquipment } from '../src/services/carriers/fmcsaCensus.js';
import { setFmcsaFetch } from '../src/services/brokers/fmcsa.js';
import { setSetting } from '../src/lib/settings.js';
import {
  scoreLead, tierOf, tierPriority, sharedContactCounts, sharedContactStep, authorityAges, mcAgeStep, mcAgeOf, currentInsurers, insurerStep,
  insurerMatches, qcSafety, qcBlocks, withQc, clearLeadSignalCaches, SHARED_THRESHOLD, QC_MAX_PER_RUN,
} from '../src/services/carriers/leadSignals.js';
import {
  emailKind, milesPerTruck, postFilter, censusLeadFilters, applyPlaybook, PLAYBOOKS, normalizeLeadFilters, DEFAULT_WEIGHTS, cargoForEquipmentFilter,
} from '../src/services/carriers/leadFilters.js';
import { licensingFake, MOTUS_PROPERTY } from './licensingFake.js';

/*
 * Lead signals and lead score v2 (services/carriers/leadSignals.js, leadFilters.js). FMCSA is a fake throughout.
 */

const NOW = new Date('2026-11-13T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const censusRow = (dot, extra = {}) => ({
  dot_number: String(dot), legal_name: `CARRIER ${dot} LLC`, phone: `713555${String(dot).slice(-4)}`, cell_phone: `832555${String(dot).slice(-4)}`,
  email_address: `owner${dot}@gmail.com`, phy_street: '7427 TETON CREEK TRCE', phy_city: 'RICHMOND', phy_state: 'TX', phy_zip: '77407-3529', phy_cnty: '157',
  power_units: '1', truck_units: '1', total_drivers: '1', total_cdl: '1', status_code: 'A', add_date: ymd(daysAgo(75)), mcs150_date: ymd(daysAgo(75)),
  mcs150_mileage: '0', mcs150_mileage_year: '2026', carrier_operation: 'A', classdef: 'AUTHORIZED FOR HIRE', hm_ind: 'N', docket1prefix: 'MC',
  docket1: String(68900000 + (Number(dot) % 100000)), crgo_coldfood: 'X', crgo_genfreight: 'X', owntract: '1', owntrail: '1', company_officer_1: 'ROBERT SMITH',
  ...extra,
});
const rec = (dot, extra = {}) => ({ ...mapRecord(censusRow(dot, extra)), authorityStatus: 'active' });
const grant = (date, reason = 'Granted', status = 'Active') => ({ op_auth_type: MOTUS_PROPERTY, op_auth_status: status, reason, status_change_date: date });
const keys = (s) => s.signals.map((x) => x.key);

describe('lead signals and score v2', () => {
  let fake;
  beforeAll(() => { fake = licensingFake(); setFmcsaFetch(fake.fetch); });
  afterAll(() => setFmcsaFetch(null));
  afterEach(() => {
    clearCensusCache();
    clearLeadSignalCaches();
    Object.assign(fake, { signalsDown: false, signalCalls: [], qcCalls: [], qcPeak: 0, motusHistory: {}, history: {}, motusInsurance: {}, insurance: {}, sharedPhones: {}, sharedEmails: {}, qc: {} });
  });

  describe('scoring and tiers', () => {
    it('an owner-operator with a cell phone and a 60-day MC (Motus history) scores A, every point with its reason', () => {
      const r = { ...rec(1001), _lead: { history: { grantedAt: daysAgo(60).toISOString().slice(0, 10), source: 'motus' }, shared: { count: 1, checked: true } } };
      const s = scoreLead(r, { now: NOW, timezone: 'America/Chicago' });
      expect(s.tier).toBe('A');
      expect(s.score).toBeGreaterThanOrEqual(75);
      expect(s.signals.find((x) => x.key === 'new_authority')).toMatchObject({ label: 'New MC · 60 days', points: 25, group: 'need' });
      expect(keys(s)).toEqual(expect.arrayContaining(['owner_operator', 'cell_phone', 'free_mail', 'interstate_for_hire', 'eq_reefer', 'officer', 'your_time_zone', 'authority_active']));
      expect(s.signals.find((x) => x.key === 'officer').label).toBe('Officer: Robert Smith');
      // Groups never exceed their weight and add up to the score.
      for (const [g, w] of Object.entries(DEFAULT_WEIGHTS)) expect(s.groups[g]).toBeLessThanOrEqual(w);
      expect(Object.values(s.groups).reduce((a, b) => a + b, 0)).toBe(s.score);
      expect(s.reasons[0]).toBe('New MC · 60 days');
    });

    it('tiers: A >= 75, B 55-74, C below 55; priority follows the tier', () => {
      expect([tierOf(100), tierOf(75), tierOf(74), tierOf(55), tierOf(54), tierOf(0)]).toEqual(['A', 'A', 'B', 'B', 'C', 'C']);
      expect([tierPriority('A'), tierPriority('B'), tierPriority('C')]).toEqual([2, 1, 0]);
    });

    it('MC age buckets: new (0-90), broker-ready (90-180), young (6-18 months); an estimate from the registration date scores less', () => {
      const at = (days) => scoreLead({ ...rec(1002), _lead: { history: { grantedAt: daysAgo(days).toISOString().slice(0, 10), source: 'motus' } } }, { now: NOW });
      expect(at(45).signals.find((x) => x.key === 'new_authority').label).toBe('New MC · 45 days');
      expect(at(120).signals.find((x) => x.key === 'broker_ready')).toMatchObject({ label: 'Broker-ready · 120 days', points: 22 });
      expect(at(300).signals.find((x) => x.key === 'young')).toMatchObject({ label: 'Young authority · 9 months', points: 12 });
      expect(keys(at(900)).some((k) => ['new_authority', 'broker_ready', 'young'].includes(k))).toBe(false);
      const est = scoreLead(rec(1002), { now: NOW }); // no history: from add_date (75 days)
      expect(est.signals.find((x) => x.key === 'new_authority')).toMatchObject({ label: 'New MC · ~75 days (est.)', points: 20 });
      expect(mcAgeOf(rec(1002), NOW)).toMatchObject({ days: 75, estimated: true, source: 'census' });
    });

    it('a playbook moves weight between the groups and the score stays 0-100', () => {
      const r = { ...rec(1003), _lead: { history: { grantedAt: daysAgo(40).toISOString().slice(0, 10), source: 'motus' } } };
      const base = scoreLead(r, { now: NOW });
      const launch = scoreLead(r, { now: NOW, weights: PLAYBOOKS.find((p) => p.key === 'new_mc_launch').weights });
      expect(launch.signals.find((x) => x.key === 'new_authority').points).toBe(32); // 25 * 45 / 35
      expect(launch.groups.need).toBeGreaterThan(base.groups.need);
      expect(launch.score).toBeLessThanOrEqual(100);
      for (const p of PLAYBOOKS) expect(Object.values(p.weights).reduce((a, b) => a + b, 0)).toBe(100);
    });

    it('penalties: conditional rating, prior revoke, high crash rate, revoked before', () => {
      const s = scoreLead({ ...rec(1004, { safety_rating: 'C', prior_revoke_flag: 'Y', recordable_crash_rate: '2.3' }), _lead: { history: { grantedAt: '2025-01-01', lastRevokedAt: '2025-06-01', reinstatedAt: '2025-07-01', source: 'motus' } } }, { now: NOW });
      expect(s.signals.filter((x) => x.points < 0).map((x) => x.key).sort()).toEqual(['high_crash_rate', 'prior_revoke', 'rating_conditional', 'revoked_before']);
      expect(keys(s)).toContain('reinstated');
      expect(keys(s)).not.toContain('clean_history');
    });

    it('detects underused trucks only from a full recent mileage year', () => {
      const r = rec(1005, { power_units: '3', total_drivers: '3', mcs150_mileage: '90000', mcs150_mileage_year: '2025' });
      expect(milesPerTruck(r._extra.facts, NOW)).toBe(30000);
      expect(scoreLead(r, { now: NOW }).signals.find((x) => x.key === 'underused')).toMatchObject({ label: 'Underused truck · 30k mi/yr', points: 5 });
      // The current year is partial; a token mileage or one older than two years says nothing.
      expect(milesPerTruck(rec(1005, { mcs150_mileage: '1', mcs150_mileage_year: '2026' })._extra.facts, NOW)).toBeNull();
      expect(milesPerTruck(rec(1005, { mcs150_mileage: '500', mcs150_mileage_year: '2025' })._extra.facts, NOW)).toBeNull();
      expect(milesPerTruck(rec(1005, { mcs150_mileage: '90000', mcs150_mileage_year: '2022' })._extra.facts, NOW)).toBeNull();
      expect(keys(scoreLead(rec(1005, { power_units: '1', mcs150_mileage: '120000', mcs150_mileage_year: '2025' }), { now: NOW }))).not.toContain('underused');
    });

    it('free-mail detection: Gmail, Yahoo, Outlook, iCloud, AOL are owner-run; company domains are not', () => {
      expect(['a@gmail.com', 'b@yahoo.com', 'c@yahoo.co.uk', 'd@outlook.com', 'e@icloud.com', 'f@aol.com', 'G@Hotmail.com'].map(emailKind)).toEqual(Array(7).fill('free'));
      expect(emailKind('ops@acmetrucking.com')).toBe('corporate');
      expect(emailKind(null)).toBeNull();
      expect(scoreLead(rec(1006), { now: NOW }).signals.find((x) => x.key === 'free_mail').label).toBe('Gmail · owner-run');
      expect(keys(scoreLead(rec(1006, { email_address: 'dispatch@acmetrucking.com' }), { now: NOW }))).toContain('company_email');
    });

    it('equipment from cargo classes and vehicle counts: hotshot and box truck only for straight trucks without tractors', () => {
      expect(inferEquipment({ cargoKeys: ['crgo_genfreight'], straightTrucks: 1, tractors: 0, trailers: 1 })).toEqual(['hotshot']);
      expect(inferEquipment({ cargoKeys: ['crgo_genfreight'], straightTrucks: 2, tractors: null, trailers: null })).toEqual(['box_truck']);
      expect(inferEquipment({ cargoKeys: ['crgo_genfreight', 'crgo_bldgmat'], straightTrucks: 0, tractors: 2, trailers: 2 })).toEqual(['flatbed', 'dry_van']);
      expect(censusFacts(censusRow(1007)).equipment).toEqual(['reefer', 'dry_van']);
      // The CRM equipment column keeps the cargo-only mapping.
      expect(mapRecord(censusRow(1007)).equipment).toBe('reefer');
    });
  });

  describe('shared contacts', () => {
    it('3+ active carriers on the same phone: excluded by default, heavily penalised when kept', async () => {
      const a = rec(2001);
      const b = rec(2002);
      fake.sharedPhones[a.phone] = 7;
      fake.sharedEmails[b.email] = 2;
      const { kept, excluded } = await sharedContactStep([a, b], {});
      expect(excluded.map((r) => r.dotNumber)).toEqual(['2001']);
      expect(excluded[0]._lead.shared).toMatchObject({ count: 7, by: 'phone', checked: true });
      expect(kept.map((r) => r.dotNumber)).toEqual(['2002']);
      const off = await sharedContactStep([a], { excludeSharedContacts: false });
      expect(off.kept).toHaveLength(1);
      const s = scoreLead(off.kept[0], { now: NOW });
      expect(s.signals.find((x) => x.key === 'shared_contact')).toMatchObject({ label: 'Shared contact · 7 carriers', points: -20, tone: 'bad' });
      expect(SHARED_THRESHOLD).toBe(3);
    });

    it('asks the census in batches of at most 200 values, one request at a time', async () => {
      const recs = Array.from({ length: 450 }, (_, i) => rec(300000 + i, { phone: `71355${String(i).padStart(5, '0')}`, email_address: `o${i}@gmail.com` }));
      let inFlight = 0;
      let peak = 0;
      setFmcsaFetch(async (...args) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 3));
        try { return await fake.fetch(...args); } finally { inFlight--; }
      });
      try {
        await sharedContactCounts(recs);
      } finally {
        setFmcsaFetch(fake.fetch);
      }
      const phones = fake.signalCalls.filter((c) => c.dataset === 'sharedPhones').map((c) => c.values.length);
      const emails = fake.signalCalls.filter((c) => c.dataset === 'sharedEmails').map((c) => c.values.length);
      expect(phones).toEqual([200, 200, 50]);
      expect(emails).toEqual([200, 200, 50]);
      expect(peak).toBe(1);
    });

    it('fail-soft: when the census does not answer, every carrier stays, marked unchecked', async () => {
      fake.signalsDown = true;
      const { kept, excluded } = await sharedContactStep([rec(2003), rec(2004)], {});
      expect(excluded).toEqual([]);
      expect(kept.map((r) => r._lead.shared.checked)).toEqual([false, false]);
      expect(keys(scoreLead(kept[0], { now: NOW }))).toContain('shared_unchecked');
    });
  });

  describe('MC age from authority history', () => {
    it('Motus history beats legacy; legacy is asked only for dockets without a Motus grant', async () => {
      const a = rec(4001);
      const b = rec(4002);
      fake.motusHistory[a.mcNumber] = [grant('20260914'), grant('20260901', 'Initial Status', 'Pending')];
      fake.history[a.mcNumber] = [{ mod_col_1: 'COMMON', original_action_desc: 'GRANTED', orig_served_date: '01/15/2019' }];
      fake.history[b.mcNumber] = [{ mod_col_1: 'MOTOR PROPERTY COMMON CARRIER', original_action_desc: 'GRANTED', orig_served_date: '03/02/2026' }, { mod_col_1: 'BROKER', original_action_desc: 'GRANTED', orig_served_date: '01/01/2010' }];
      const ages = await authorityAges([a, b]);
      expect(ages.get(a.mcNumber)).toMatchObject({ grantedAt: '2026-09-14', source: 'motus' });
      expect(ages.get(b.mcNumber)).toMatchObject({ grantedAt: '2026-03-02', source: 'legacy' });
      const legacyAsked = fake.signalCalls.filter((c) => c.dataset === 'history').flatMap((c) => c.values);
      expect(legacyAsked).toEqual([`MC${b.mcNumber}`]);
      const { kept } = await mcAgeStep([a], {}, { now: NOW });
      expect(mcAgeOf(kept[0], NOW)).toMatchObject({ days: 60, estimated: false, source: 'motus' });
    });

    it('reinstatement after a revocation counts; the Motus consolidation fix (Issue #220) does not', async () => {
      const a = rec(4003);
      const b = rec(4004);
      fake.motusHistory[a.mcNumber] = [grant('20240101'), grant('20250301', 'Revoked', 'Inactive'), grant('20250401', 'Reinstated - insurance coverage restored')];
      fake.motusHistory[b.mcNumber] = [grant('20240101'), grant('20260520', 'Reinstated - legacy common/contract authority consolidation corrected (MOTUS Issue #220); active BIPD on file')];
      const ages = await authorityAges([a, b]);
      expect(ages.get(a.mcNumber)).toMatchObject({ lastRevokedAt: '2025-03-01', reinstatedAt: '2025-04-01' });
      expect(ages.get(b.mcNumber)).toMatchObject({ lastRevokedAt: null, reinstatedAt: null });
    });

    it('the MC age range filters on the real age; fail-soft falls back to the registration-date estimate', async () => {
      const young = rec(4005);
      const old = rec(4006);
      fake.motusHistory[young.mcNumber] = [grant(ymd(daysAgo(50)))];
      fake.motusHistory[old.mcNumber] = [grant(ymd(daysAgo(400)))];
      const range = { mcAgeMinDays: 30, mcAgeMaxDays: 120 };
      const { kept, excluded } = await mcAgeStep([young, old], range, { now: NOW });
      expect(kept.map((r) => r.dotNumber)).toEqual(['4005']);
      expect(excluded.map((r) => r.dotNumber)).toEqual(['4006']);
      clearLeadSignalCaches();
      fake.signalsDown = true;
      const soft = await mcAgeStep([young, old], range, { now: NOW });
      // Both registered 75 days ago: the estimate keeps both, and says it is an estimate.
      expect(soft.kept.map((r) => r.dotNumber)).toEqual(['4005', '4006']);
      expect(mcAgeOf(soft.kept[1], NOW)).toMatchObject({ estimated: true, days: 75 });
    });

    it('batches of at most 200 dockets per request', async () => {
      const recs = Array.from({ length: 401 }, (_, i) => rec(500000 + i, { docket1: String(50000000 + i) }));
      await authorityAges(recs);
      expect(fake.signalCalls.filter((c) => c.dataset === 'motusHistory').map((c) => c.values.length)).toEqual([200, 200, 1]);
      expect(fake.signalCalls.filter((c) => c.dataset === 'history').map((c) => c.values.length)).toEqual([200, 200, 1]);
    });
  });

  describe('insurer', () => {
    const motusPolicy = (name, extra = {}) => ({ ins_type_code: '1', ins_class_code: 'P', ins_form_code: 'BMC-91X', insurance_company_name: name, ...extra });

    it('matches the current primary BIPD insurer (Motus first, then legacy) case-insensitively, with brand aliases', async () => {
      const a = rec(6001);
      const b = rec(6002);
      const c = rec(6003);
      fake.motusInsurance[a.mcNumber] = [motusPolicy('UNITED FINANCIAL CASUALTY COMPANY'), motusPolicy('Some Excess Co', { ins_class_code: 'E' })];
      fake.insurance[b.mcNumber] = [
        { ins_form_code: '91X', mod_col_1: 'BIPD/Primary', name_company: 'NORTHLAND INSURANCE COMPANY', cancl_effective_date: '' },
        { ins_form_code: '91X', mod_col_1: 'BIPD/Primary', name_company: 'CANCELLED CARRIER INS', cancl_effective_date: '01/01/2026' },
      ];
      const found = await currentInsurers([a, b, c], { now: NOW });
      expect(found.get(a.mcNumber)).toEqual({ names: ['UNITED FINANCIAL CASUALTY COMPANY'], source: 'motus' });
      expect(found.get(b.mcNumber)).toEqual({ names: ['NORTHLAND INSURANCE COMPANY'], source: 'legacy' });
      expect(found.get(c.mcNumber)).toEqual({ names: [], source: null });
      expect(insurerMatches(['UNITED FINANCIAL CASUALTY COMPANY'], ['progressive'])).toBe(true);
      expect(insurerMatches(['ARTISAN & TRUCKERS CASUALTY COMPANY'], ['Progressive'])).toBe(true);
      expect(insurerMatches(['Great West Casualty Co'], ['great west'])).toBe(true);
      expect(insurerMatches(['Great West Casualty Co'], ['canal'])).toBe(false);

      const include = await insurerStep([a, b, c], { insurers: ['Progressive', 'Northland'] }, { now: NOW });
      expect(include.kept.map((r) => r.dotNumber)).toEqual(['6001', '6002']);
      const exclude = await insurerStep([a, b, c], { insurers: ['progressive'], insurerMode: 'exclude' }, { now: NOW });
      expect(exclude.kept.map((r) => r.dotNumber)).toEqual(['6002', '6003']);
      expect(scoreLead(include.kept[0], { now: NOW }).signals.find((x) => x.key === 'insurer').label).toBe('Insurer: United Financial Casualty Company');
    });

    it('fail-soft: an unanswered lookup keeps the carrier with "insurer not checked"', async () => {
      fake.signalsDown = true;
      const { kept, excluded } = await insurerStep([rec(6004)], { insurers: ['Canal'] }, { now: NOW });
      expect(excluded).toEqual([]);
      expect(kept[0]._lead.insurer.checked).toBe(false);
      expect(keys(scoreLead(kept[0], { now: NOW }))).toContain('insurer_unchecked');
    });

    it('no insurer filter: no lookup at all', async () => {
      const { kept } = await insurerStep([rec(6005)], {}, { now: NOW });
      expect(kept).toHaveLength(1);
      expect(fake.signalCalls).toEqual([]);
    });
  });

  describe('QCMobile live safety', () => {
    let admin;
    beforeAll(async () => { admin = await registerUser({ role: 'super_admin' }); });

    it('without a webKey nothing is requested and picks are marked "not checked"', async () => {
      const out = await qcSafety([rec(7001), rec(7002)]);
      expect(fake.qcCalls).toEqual([]);
      expect([...out.values()]).toEqual([{ checked: false }, { checked: false }]);
      expect(keys(scoreLead(withQc(rec(7001), out.get('7001')), { now: NOW }))).toContain('safety_not_checked');
    });

    it('with a webKey: capped, at most 2 in flight; out of service blocks; far-above-average OOS rates are penalised', async () => {
      await setSetting('fmcsa.webKey', 'test-web-key', admin.user.id);
      try {
        const recs = Array.from({ length: 60 }, (_, i) => rec(710000 + i));
        fake.qc['710000'] = { allowedToOperate: 'N', oosDate: '2026-10-01' };
        fake.qc['710001'] = { allowedToOperate: 'Y', vehicleInsp: '6', vehicleOosRate: '50', vehicleOosRateNationalAverage: '22.26', driverInsp: '6', driverOosRate: '0', driverOosRateNationalAverage: '6.67' };
        const out = await qcSafety(recs);
        expect(fake.qcCalls).toHaveLength(QC_MAX_PER_RUN);
        expect(out.size).toBe(QC_MAX_PER_RUN);
        expect(fake.qcPeak).toBeLessThanOrEqual(2);
        expect(qcBlocks(out.get('710000'))).toBe(true);
        expect(out.get('710002')).toEqual({ checked: false }); // 404: fail-open
        const s = scoreLead(withQc(recs[1], out.get('710001')), { now: NOW });
        expect(s.signals.find((x) => x.key === 'high_oos_vehicle')).toMatchObject({ label: 'Vehicle OOS 50% vs 22.26% avg', points: -5 });
        expect(keys(s)).toContain('allowed_to_operate');
      } finally {
        await setSetting('fmcsa.webKey', '', admin.user.id);
      }
    });
  });

  describe('filters', () => {
    it('census-side filters go into SoQL', () => {
      const f = censusLeadFilters({
        zipPrefixes: ['773', '75001'], counties: ['157'], interstateOnly: true, forHireOnly: true, hazmat: 'no', minDrivers: 1, maxDrivers: 3, minCdlDrivers: 1,
        mcs150WithinMonths: 6, excludeRatings: ['U', 'C'], requireCell: true, requireCellOrEmail: true, equipment: ['reefer'],
      }, NOW);
      const where = buildWhere({ state: 'TX', ...f });
      for (const part of [
        "(phy_zip like '75001%' OR phy_zip like '773%')", "phy_cnty in('157')", "carrier_operation='A'", "classdef like '%AUTHORIZED FOR HIRE%'",
        "(hm_ind IS NULL OR hm_ind!='Y')", 'total_drivers::number>=1', 'total_drivers::number<=3', 'total_cdl::number>=1', "mcs150_date>='20260513'",
        "(safety_rating IS NULL OR safety_rating not in('C','U'))", 'cell_phone IS NOT NULL', '(cell_phone IS NOT NULL OR email_address IS NOT NULL)',
        "(crgo_coldfood='X' OR crgo_meat='X' OR crgo_produce='X')",
      ]) expect(where).toContain(part);
      expect(buildWhere({ ...censusLeadFilters({ hazmat: 'yes' }, NOW) })).toContain("hm_ind='Y'");
      // Default: Unsatisfactory is excluded, unrated carriers stay.
      expect(buildWhere(censusLeadFilters({}, NOW))).toBe("(safety_rating IS NULL OR safety_rating not in('U'))");
      expect(buildWhere(censusLeadFilters({ excludeRatings: [] }, NOW))).toBe('');
      // Hotshot / box truck need vehicle counts: no cargo condition then.
      expect(cargoForEquipmentFilter(['reefer', 'hotshot'])).toEqual([]);
    });

    it('MC age bounds the USDOT registration window and combines with the authority age in months', () => {
      const f = censusLeadFilters({ mcAgeMinDays: 30, mcAgeMaxDays: 120 }, NOW);
      expect(f.addedBefore.toISOString().slice(0, 10)).toBe('2026-10-14');
      expect(f.addedAfter.toISOString().slice(0, 10)).toBe(daysAgo(120 + 730).toISOString().slice(0, 10));
      const both = censusLeadFilters({ mcAgeMinDays: 30, authorityAgeMinMonths: 3, authorityAgeMaxMonths: 12, mcAgeMaxDays: 120 }, NOW);
      expect(both.addedBefore.toISOString().slice(0, 10)).toBe('2026-08-13'); // 3 months is narrower than 30 days
      expect(both.addedAfter.toISOString().slice(0, 10)).toBe('2025-11-13'); // 12 months is narrower than 120 + 730 days
    });

    it('page-side filters: unsafe rating, location, operation, size, mileage, contact, equipment, email type', () => {
      const r = rec(8001);
      expect(postFilter(r, {}, NOW)).toBeNull();
      expect(postFilter(rec(8002, { safety_rating: 'U' }), {}, NOW)).toBe('unsafe');
      expect(postFilter(rec(8002, { safety_rating: 'U' }), { excludeRatings: [] }, NOW)).toBeNull();
      expect(postFilter(rec(8003, { safety_rating: 'C' }), { excludeRatings: ['U', 'C'] }, NOW)).toBe('unsafe');
      const cases = [
        [{ zipPrefixes: ['773'] }, 'filtered'], [{ zipPrefixes: ['7741', '75001'] }, 'filtered'], [{ zipPrefixes: ['773', '77407'] }, null], [{ zipPrefixes: ['774'] }, null],
        [{ counties: ['201'] }, 'filtered'], [{ counties: ['157'] }, null],
        [{ hazmat: 'yes' }, 'filtered'], [{ hazmat: 'no' }, null],
        [{ minDrivers: 2 }, 'filtered'], [{ maxDrivers: 1 }, null], [{ minCdlDrivers: 2 }, 'filtered'],
        [{ mcs150WithinMonths: 1 }, 'filtered'], [{ mcs150WithinMonths: 3 }, null],
        [{ maxMilesPerTruck: 60000 }, 'filtered'], // no full-year mileage on file
        [{ equipment: ['flatbed'] }, 'filtered'], [{ equipment: ['flatbed', 'reefer'] }, null],
        [{ excludeEmail: 'free' }, 'filtered'], [{ excludeEmail: 'corporate' }, null],
        [{ requireCell: true }, null],
      ];
      for (const [c, want] of cases) expect([c, postFilter(r, c, NOW)]).toEqual([c, want]);
      expect(postFilter(rec(8004, { cell_phone: undefined }), { requireCell: true }, NOW)).toBe('filtered');
      expect(postFilter(rec(8004, { cell_phone: undefined }), { requireCellOrEmail: true }, NOW)).toBeNull();
      expect(postFilter(rec(8005, { carrier_operation: 'C' }), { interstateOnly: true }, NOW)).toBe('filtered');
      expect(postFilter(rec(8006, { classdef: 'PRIVATE PROPERTY' }), { forHireOnly: true }, NOW)).toBe('filtered');
    });

    it('playbooks set their criteria on top of the form: states stay, other filters reset', () => {
      const c = applyPlaybook('new_mc_launch', { states: ['TX', 'OK'], zipPrefixes: ['773'], hazmat: 'yes', insurers: ['Canal'] });
      expect(c).toMatchObject({
        states: ['TX', 'OK'], playbook: 'new_mc_launch', mcAgeMinDays: 30, mcAgeMaxDays: 120, minPowerUnits: 1, maxPowerUnits: 5,
        requireCellOrEmail: true, zipPrefixes: [], hazmat: 'any', insurers: [], excludeSharedContacts: true,
      });
      expect(applyPlaybook('broker_ready', {})).toMatchObject({ mcAgeMinDays: 90, mcAgeMaxDays: 180 });
      expect(applyPlaybook('owner_operators', {})).toMatchObject({ minPowerUnits: 1, maxPowerUnits: 3, equipment: ['dry_van'], forHireOnly: true });
      expect(applyPlaybook('underused_trucks', {})).toMatchObject({ maxMilesPerTruck: 60000 });
      expect(applyPlaybook('growing_fleets', {})).toMatchObject({ minPowerUnits: 4, maxPowerUnits: 15, mcs150WithinMonths: 6 });
      expect(applyPlaybook('reefer', {}).equipment).toEqual(['reefer']);
      expect(applyPlaybook('flatbed', {}).equipment).toEqual(['flatbed']);
      expect(applyPlaybook('hotshot_box', {}).equipment).toEqual(['hotshot', 'box_truck']);
      expect(applyPlaybook('all_small', {})).toMatchObject({ minPowerUnits: 1, maxPowerUnits: 10, requirePhone: true });
      expect(PLAYBOOKS).toHaveLength(9);
      expect(applyPlaybook('nope', { states: ['TX'] })).toEqual({ states: ['TX'] });
    });

    it('normalization fills defaults so old criteria and explicit defaults compare equal', () => {
      expect(normalizeLeadFilters({})).toEqual(normalizeLeadFilters({ excludeRatings: ['U'], excludeSharedContacts: true, hazmat: 'any', excludeEmail: 'none', insurerMode: 'include' }));
      expect(normalizeLeadFilters({ insurers: [' Canal ', 'canal'] }).insurers).toEqual(['canal']);
    });
  });
});
