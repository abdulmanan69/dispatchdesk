import { describe, it, expect } from 'vitest';
import { carrierResources } from './resources.js';

describe('carrierResources', () => {
  it('builds FMCSA, Google and Maps links from carrier fields', () => {
    const links = carrierResources({ companyName: 'Yaja Dynamic Logistics LLC', dotNumber: '04488656', mcNumber: 'MC-1773965', address: '1 Main St', city: 'Springfield', state: 'MA', zip: '01104' });
    const by = Object.fromEntries(links.map((l) => [l.key, l.href]));
    expect(by.safer).toBe('https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=4488656');
    expect(by.sms).toBe('https://ai.fmcsa.dot.gov/SMS/Carrier/4488656/CarrierRegistration.aspx');
    expect(by.li).toBe('https://li-public.fmcsa.dot.gov/LIVIEW/pkg_carrquery.prc_carrlist?n_dotno=4488656');
    expect(decodeURIComponent(by.google)).toContain('Yaja Dynamic Logistics LLC MC 1773965 MA');
    expect(decodeURIComponent(by.maps)).toContain('1 Main St, Springfield, MA, 01104');
  });

  it('skips FMCSA links without a USDOT number and maps without an address', () => {
    const links = carrierResources({ companyName: 'No Dot Trucking', state: 'TX' });
    expect(links.map((l) => l.key)).toEqual(['google']);
    expect(carrierResources({})).toEqual([]);
  });
});
