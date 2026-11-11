import { describe, it, expect, afterAll, vi } from 'vitest';
import { snapshotFrom, bestCensusRow, pickLicensing, lookupBroker, setFmcsaFetch } from '../src/services/brokers/fmcsa.js';
import { computeFlags } from '../src/services/brokers/flags.js';

const NOW = new Date('2026-11-11T08:00:00Z');
afterAll(() => { setFmcsaFetch(null); vi.restoreAllMocks(); });
const census = (o = {}) => ({ dot_number: '2226453', legal_name: 'C H ROBINSON COMPANY INC', status_code: 'A', carship: 'S;B', docket1prefix: 'MC', docket1: '384859', docket1_status_code: 'A', add_date: '20111119', ...o });
const lic = (o = {}) => ({ docket_number: 'MC384859', dot_number: '02226453', broker_stat: 'A', broker_app_pend: 'N', broker_rev_pend: 'N', common_stat: 'I', common_app_pend: 'N', contract_stat: 'N', contract_app_pend: 'N', bond_req: 'Y', bond_file: 'Y', bipd_file: '00000', min_cov_amount: '00000', ...o });

describe('broker authority and bond from the FMCSA licensing dataset', () => {
  it('maps a licensing row into the snapshot when QCMobile is not available', () => {
    const s = snapshotFrom(census(), { lic: lic(), checkedAt: NOW });
    expect(s).toMatchObject({ licensing: true, qc: false, brokerAuthority: 'active', bondRequired: true, bondOnFile: true, brokerRevocationPending: false, carrierAuthority: 'inactive' });
    expect(s.sources.map((x) => x.name)).toEqual(['FMCSA census', 'FMCSA licensing']);
    expect(computeFlags(s, { now: NOW }).map((f) => f.code)).toEqual([]);
  });

  it('flags missing bond, inactive authority and a pending revocation with the licensing source', () => {
    const s = snapshotFrom(census(), { lic: lic({ broker_stat: 'I', bond_file: 'N', broker_rev_pend: 'Y' }), checkedAt: NOW });
    const flags = computeFlags(s, { now: NOW });
    expect(flags.map((f) => f.code)).toEqual(expect.arrayContaining(['broker_authority', 'revocation_pending', 'no_bond']));
    expect(flags.every((f) => f.code === 'not_broker' || f.source === 'FMCSA licensing')).toBe(true);
  });

  it('reports a pending application as pending authority', () => {
    expect(snapshotFrom(census(), { lic: lic({ broker_stat: 'N', broker_app_pend: 'Y' }), checkedAt: NOW }).brokerAuthority).toBe('pending');
  });

  it('prefers QCMobile when it answered', () => {
    const s = snapshotFrom(census(), { qc: { brokerAuthorityStatus: 'I', bondInsuranceOnFile: 'N', bondInsuranceRequired: 'Y', allowedToOperate: 'Y' }, lic: lic(), checkedAt: NOW });
    expect(s).toMatchObject({ qc: true, licensing: false, brokerAuthority: 'inactive', bondOnFile: false });
  });

  it('picks the active census record when an MC docket is on an old inactive USDOT too', () => {
    const old = census({ dot_number: '881036', status_code: 'I', docket1_status_code: 'I', carship: 'C', add_date: '20000517' });
    const current = census();
    expect(bestCensusRow([old, current]).dot_number).toBe('2226453');
    expect(bestCensusRow([current, old]).dot_number).toBe('2226453');
  });

  it('retries soon (no 6-hour cache) when the licensing dataset did not answer, then caches the good answer', async () => {
    let licensingUp = false;
    let licCalls = 0;
    setFmcsaFetch(async (url) => {
      const u = String(url);
      if (u.includes('6eyk-hxee')) {
        licCalls += 1;
        if (!licensingUp) throw new Error('timeout');
        return { ok: true, status: 200, json: async () => [lic()] };
      }
      return { ok: true, status: 200, json: async () => [census()] };
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await lookupBroker({ mc: '384859' });
    expect(first.licensing).toBe(false);
    vi.useFakeTimers({ now: Date.now() + 3 * 60_000, toFake: ['Date'] }); // past the 2-minute retry window
    licensingUp = true;
    const second = await lookupBroker({ mc: '384859' });
    expect(second).toMatchObject({ licensing: true, brokerAuthority: 'active', bondOnFile: true });
    const third = await lookupBroker({ mc: '384859' }); // good answer is cached
    expect(third.licensing).toBe(true);
    expect(licCalls).toBe(2);
    vi.useRealTimers();
  });

  it('answers from the licensing dataset alone when the census is rate limited, without census-based flags', async () => {
    setFmcsaFetch(async (url) => {
      const u = String(url);
      if (u.includes('6eyk-hxee')) {
        return { ok: true, status: 200, json: async () => [lic({ docket_number: 'MC555001', dot_number: '05550001', legal_name: 'FALLBACK BROKER LLC', bus_street_po: '1 MAIN ST', bus_city: 'DALLAS', bus_state_code: 'TX', bus_zip_code: '75201', bus_telno: '2145550100' })] };
      }
      return { ok: false, status: 429, json: async () => ({ message: 'Too many requests' }) };
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await lookupBroker({ mc: '555001' }, { fresh: true });
    expect(s).toMatchObject({ found: true, censusUnavailable: true, licensing: true, legalName: 'FALLBACK BROKER LLC', mc: '555001', brokerAuthority: 'active', bondOnFile: true, usdotStatus: null, registeredBroker: null });
    expect(s.phones).toEqual(['2145550100']);
    expect(s.sources.map((x) => x.name)).toEqual(['FMCSA licensing']);
    expect(computeFlags(s, { now: NOW }).map((f) => f.code)).toEqual([]);
  });

  it('picks the licensing row for the MC docket first, then one with active broker authority', () => {
    const carrierDocket = lic({ docket_number: 'MC111', broker_stat: 'N' });
    const brokerDocket = lic({ docket_number: 'MC222', broker_stat: 'A' });
    expect(pickLicensing([carrierDocket, brokerDocket], { dot: '2226453', mc: '111' }).docket_number).toBe('MC111');
    expect(pickLicensing([carrierDocket, brokerDocket], { dot: '2226453' }).docket_number).toBe('MC222');
    expect(pickLicensing([lic({ dot_number: '09999999', docket_number: 'MC9' })], { dot: '2226453', mc: '384859' })).toBe(null);
  });
});
