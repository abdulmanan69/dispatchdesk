import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mapRecord, clearCensusCache } from '../src/services/carriers/fmcsaCensus.js';
import { setFmcsaFetch } from '../src/services/brokers/fmcsa.js';
import { scoreLead, sharedContactStep, clearLeadSignalCaches } from '../src/services/carriers/leadSignals.js';
import { postFilter, normalizeLeadFilters } from '../src/services/carriers/leadFilters.js';
import {
  phoneQuality, isDispatchEmail, streetKey, baseStreet, addressCounts, roadActivity, trustStep, isAddressMill, linkedInactive, ADDRESS_BATCH, DOT_BATCH,
} from '../src/services/carriers/leadTrust.js';
import { criteriaHash } from '../src/services/leadgen.js';
import { licensingFake } from './licensingFake.js';

/*
 * Lead authenticity (services/carriers/leadTrust.js): contact checks, address mills, links to inactive or revoked
 * carriers, road activity, and how they move the score and the filters. FMCSA is a fake throughout.
 */

const NOW = new Date('2026-11-16T12:00:00Z');
const DAY = 86400000;
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const censusRow = (dot, extra = {}) => ({
  dot_number: String(dot), legal_name: `CARRIER ${dot} LLC`, phone: `713${2000000 + dot}`, cell_phone: `832${3000000 + dot}`,
  email_address: `owner${dot}@gmail.com`, phy_street: `${dot} TETON CREEK TRCE`, phy_city: 'RICHMOND', phy_state: 'TX', phy_zip: '77407-3529',
  power_units: '1', total_drivers: '1', status_code: 'A', add_date: ymd(new Date(NOW - 75 * DAY)), mcs150_date: ymd(new Date(NOW - 75 * DAY)),
  carrier_operation: 'A', classdef: 'AUTHORIZED FOR HIRE', docket1prefix: 'MC', docket1: String(68000000 + dot), company_officer_1: 'ROBERT SMITH',
  ...extra,
});
const rec = (dot, extra = {}) => ({ ...mapRecord(censusRow(dot, extra)), authorityStatus: 'active' });
const keys = (s) => s.signals.map((x) => x.key);
const sig = (s, key) => s.signals.find((x) => x.key === key);

describe('lead authenticity', () => {
  let fake;
  beforeAll(() => { fake = licensingFake(); setFmcsaFetch(fake.fetch); });
  afterAll(() => setFmcsaFetch(null));
  afterEach(() => {
    clearCensusCache();
    clearLeadSignalCaches();
    Object.assign(fake, { signalsDown: false, signalCalls: [], sharedPhones: {}, sharedEmails: {}, sharedAddresses: {}, inspections: {} });
  });

  describe('contact checks', () => {
    it('phone numbers that cannot be real are invalid; toll-free lines are told apart', () => {
      expect(phoneQuality('(713) 262-4410')).toBe('ok');
      expect(phoneQuality('+1 713 262 4410')).toBe('ok');
      for (const bad of ['713-555-0142', '000-262-4410', '713-062-4410', '911-262-4410', '713-411-2000', '7777777777', '1234567890', '713-222-2222', '12345']) {
        expect(phoneQuality(bad), bad).toBe('invalid');
      }
      expect(phoneQuality('800-262-4410')).toBe('toll_free');
      expect(phoneQuality('')).toBeNull();
      expect(phoneQuality(null)).toBeNull();
    });

    it('scores only real numbers: a fake phone earns no reach points, a toll-free line a few', () => {
      const real = scoreLead(rec(1, { cell_phone: undefined }), { now: NOW });
      expect(sig(real, 'phone')).toMatchObject({ points: 8 });
      const fakePhone = scoreLead(rec(2, { phone: '7135550142', cell_phone: undefined }), { now: NOW });
      expect(keys(fakePhone)).not.toContain('phone');
      expect(sig(fakePhone, 'phone_invalid')).toMatchObject({ points: 0, tone: 'warn' });
      const tollFree = scoreLead(rec(3, { phone: '8882624410', cell_phone: undefined }), { now: NOW });
      expect(sig(tollFree, 'toll_free')).toMatchObject({ points: 3, tone: 'warn' });
      expect(real.score).toBeGreaterThan(tollFree.score);
      expect(tollFree.score).toBeGreaterThan(fakePhone.score);
    });

    it('"phone required" leaves out carriers whose only number cannot be real', () => {
      expect(postFilter(rec(4, { phone: '7135550142', cell_phone: undefined }), { requirePhone: true }, NOW)).toBe('filtered');
      expect(postFilter(rec(5, { phone: '7135550142' }), { requirePhone: true }, NOW)).toBeNull(); // the cell phone is real
      expect(postFilter(rec(6, { phone: '8882624410', cell_phone: undefined }), { requirePhone: true }, NOW)).toBeNull();
      expect(postFilter(rec(7, { phone: '7135550142', cell_phone: undefined }), {}, NOW)).toBeNull();
    });

    it('a dispatch email means someone may already dispatch for them', () => {
      expect(isDispatchEmail('dispatch@bigfleet.com')).toBe(true);
      expect(isDispatchEmail('ops@topdispatching.com')).toBe(true);
      expect(isDispatchEmail('owner@gmail.com')).toBe(false);
      const s = scoreLead(rec(8, { email_address: 'dispatch@redriver.test' }), { now: NOW });
      expect(sig(s, 'dispatch_email')).toMatchObject({ points: -12, group: 'need' });
    });

    it('an MCS-150 older than two years marks the contact details as possibly out of date', () => {
      const s = scoreLead(rec(9, { mcs150_date: '20220301' }), { now: NOW });
      expect(sig(s, 'mcs150_stale')).toMatchObject({ label: 'MCS-150 last updated 2022 · contact may be out of date', points: -3 });
      expect(keys(scoreLead(rec(10), { now: NOW }))).not.toContain('mcs150_stale');
    });
  });

  describe('address mills', () => {
    it('street keys drop suites and units; PO boxes and bare names are not matched', () => {
      expect(streetKey('30 n gould st  ste r')).toBe('30 N GOULD ST STE R');
      expect(baseStreet('30 N GOULD ST STE R')).toBe('30 N GOULD ST');
      expect(baseStreet('23050 MORTON RANCH RD APT 1241')).toBe('23050 MORTON RANCH RD');
      expect(baseStreet('1200 MAIN ST #4')).toBe('1200 MAIN ST');
      expect(streetKey('PO BOX 1234')).toBeNull();
      expect(streetKey('MAIN STREET')).toBeNull();
    });

    it('counts active carriers on the same suite and the same building, and inactive ones on the same suite', async () => {
      const mill = rec(11, { phy_street: '30 N GOULD ST STE R', phy_zip: '82801' });
      const home = rec(12, { phy_street: '412 OAK HOLLOW DR', phy_zip: '77407' });
      fake.sharedAddresses['30 N GOULD ST STE R|82801'] = { n: 90, r: 4 };
      fake.sharedAddresses['30 N GOULD ST|82801'] = 42;
      fake.sharedAddresses['412 OAK HOLLOW DR|77407'] = 1;
      const out = await addressCounts([mill, home]);
      expect(out.get('11')).toEqual({ exact: 90, base: 132, risky: 4, checked: true });
      expect(out.get('12')).toEqual({ exact: 1, base: 1, risky: 0, checked: true });
      expect(isAddressMill(out.get('11'))).toBe(true);
      expect(isAddressMill(out.get('12'))).toBe(false);
      // One request for both (the batch size is ADDRESS_BATCH), with the street base and ZIP of each.
      expect(fake.signalCalls.filter((c) => c.dataset === 'sharedAddresses')).toEqual([{ dataset: 'sharedAddresses', values: ['30 N GOULD ST|82801', '412 OAK HOLLOW DR|77407'] }]);
    });

    it('asks in batches of ADDRESS_BATCH addresses', async () => {
      const recs = Array.from({ length: ADDRESS_BATCH + 5 }, (_, i) => rec(1000 + i));
      await addressCounts(recs);
      expect(fake.signalCalls.filter((c) => c.dataset === 'sharedAddresses').map((c) => c.values.length)).toEqual([ADDRESS_BATCH, 5]);
    });

    it('an address mill is left out by default, kept and penalised when the filter is off', async () => {
      const mill = rec(13, { phy_street: '30 N GOULD ST STE R', phy_zip: '82801' });
      fake.sharedAddresses['30 N GOULD ST STE R|82801'] = 12;
      const on = await trustStep([mill, rec(14)], {}, { now: NOW });
      expect(on.excluded.addressMill.map((r) => r.dotNumber)).toEqual(['13']);
      expect(on.kept.map((r) => r.dotNumber)).toEqual(['14']);
      const off = await trustStep([mill], { excludeAddressMills: false }, { now: NOW });
      expect(off.kept).toHaveLength(1);
      expect(sig(scoreLead(off.kept[0], { now: NOW }), 'address_mill')).toMatchObject({ label: 'Shared address · 12 carriers (virtual office or agent)', points: -10 });
    });
  });

  describe('links to inactive or revoked carriers', () => {
    it('counts inactive or revoked carriers on the same phone, email or suite (the carrier itself not counted)', async () => {
      const a = rec(21);
      fake.sharedPhones[a.phone] = { n: 1, r: 2 };
      const shared = await sharedContactStep([a], {});
      const t = await trustStep(shared.kept, {}, { now: NOW });
      expect(linkedInactive(t.kept[0])).toEqual({ count: 2, by: ['phone'] });
      expect(sig(scoreLead(t.kept[0], { now: NOW }), 'linked_inactive')).toMatchObject({ label: 'Linked to 2 inactive or revoked carriers by phone', points: -6, tone: 'warn' });

      const b = rec(22, { prior_revoke_flag: 'Y' });
      fake.sharedPhones[b.phone] = { n: 1, r: 1 }; // only itself
      const own = await sharedContactStep([b], {});
      expect(own.kept[0]._lead.shared.risky).toBe(0);
    });

    it('kept by default (a family business can share details); left out when the filter is on', async () => {
      const a = rec(23, { phy_street: '9 RIVER RD', phy_zip: '77001' });
      fake.sharedAddresses['9 RIVER RD|77001'] = { n: 1, r: 1 };
      expect((await trustStep([a], {}, { now: NOW })).kept).toHaveLength(1);
      const on = await trustStep([a], { excludeLinkedInactive: true }, { now: NOW });
      expect(on.excluded.linkedInactive.map((r) => r.dotNumber)).toEqual(['23']);
    });
  });

  describe('road activity', () => {
    it('roadside inspections in 12 and 24 months, asked in batches of DOT_BATCH (plain and zero-padded USDOT)', async () => {
      fake.inspections['31'] = { n12: 3, n24: 5, last: '20261020' };
      const out = await roadActivity([rec(31), rec(32)], { now: NOW });
      expect(out.get('31')).toEqual({ n12: 3, n24: 5, last: '2026-10-20', checked: true });
      expect(out.get('32')).toEqual({ n12: 0, n24: 0, last: null, checked: true });
      fake.signalCalls = [];
      await roadActivity(Array.from({ length: DOT_BATCH + 1 }, (_, i) => rec(5000 + i)), { now: NOW });
      expect(fake.signalCalls.filter((c) => c.dataset === 'inspections').map((c) => c.values.length)).toEqual([DOT_BATCH, 1]);
    });

    it('a carrier on the road is marked verified; an old MC with no inspections in two years loses points; a new MC does not', async () => {
      fake.inspections['33'] = { n12: 2, n24: 4, last: '20260901' };
      const [onRoad] = (await trustStep([rec(33)], {}, { now: NOW })).kept;
      expect(sig(scoreLead(onRoad, { now: NOW }), 'on_the_road')).toMatchObject({ label: 'Verified on the road · 2 inspections in 12 mo', points: 0, tone: 'good' });

      const oldIdle = { ...rec(34), _lead: { history: { grantedAt: '2021-03-01', source: 'motus' } } };
      const [idle] = (await trustStep([oldIdle], {}, { now: NOW })).kept;
      expect(sig(scoreLead(idle, { now: NOW }), 'no_road_activity')).toMatchObject({ points: -4, tone: 'warn' });

      const fresh = { ...rec(35), _lead: { history: { grantedAt: '2026-09-01', source: 'motus' } } };
      const [newMc] = (await trustStep([fresh], {}, { now: NOW })).kept;
      expect(keys(scoreLead(newMc, { now: NOW }))).not.toContain('no_road_activity');
    });

    it('every check answered and nothing flagged: "Identity checks passed"', async () => {
      const shared = await sharedContactStep([rec(36)], {});
      const [r] = (await trustStep(shared.kept, {}, { now: NOW })).kept;
      expect(sig(scoreLead(r, { now: NOW }), 'identity_ok')).toMatchObject({ points: 0, tone: 'good' });
    });
  });

  it('fail-soft: when FMCSA does not answer, carriers stay, marked unchecked, and nothing is excluded', async () => {
    fake.signalsDown = true;
    const t = await trustStep([rec(41), rec(42)], {}, { now: NOW });
    expect(t.kept).toHaveLength(2);
    expect(t.excluded).toEqual({ addressMill: [], linkedInactive: [] });
    const s = scoreLead(t.kept[0], { now: NOW });
    expect(keys(s)).toEqual(expect.arrayContaining(['address_unchecked', 'activity_unchecked']));
    expect(keys(s)).not.toContain('identity_ok');
  });

  it('the new filters have defaults, and saved generators keep their crawl position (same hash at the defaults)', () => {
    expect(normalizeLeadFilters({})).toMatchObject({ excludeAddressMills: true, excludeLinkedInactive: false });
    const c = { states: ['TX'], requirePhone: true };
    expect(criteriaHash({ ...c, excludeAddressMills: true, excludeLinkedInactive: false })).toBe(criteriaHash(c));
    expect(criteriaHash({ ...c, excludeLinkedInactive: true })).not.toBe(criteriaHash(c));
  });
});
