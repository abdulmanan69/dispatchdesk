import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { registerUser, createAdmin, prisma } from './helpers.js';
import { clearMarketCache } from '../src/services/market/index.js';
import { stateOf, regionForState } from '../src/services/market/geo.js';
import { invalidateSettings } from '../src/lib/settings.js';
import { encrypt } from '../src/lib/crypto.js';

const eiaRow = (duoarea, period, value) => ({ period, duoarea, product: 'EPD2D', value: String(value), units: '$/GAL' });
const EIA = { response: { data: [
  eiaRow('NUS', '2026-11-02', 6.292), eiaRow('NUS', '2026-10-26', 6.35),
  eiaRow('R1X', '2026-11-02', 6.416), eiaRow('R1X', '2026-10-26', 6.4),
  eiaRow('R30', '2026-11-02', 5.9), eiaRow('SCA', '2026-11-02', 8.076),
] } };
const CENSUS = [{ phy_state: 'CA', n: '329273' }, { phy_state: 'TX', n: '194559' }, { phy_state: 'PR', n: '900' }, { phy_state: 'ON', n: '50' }];

function mockFetch() {
  const fn = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('api.eia.gov')) return { ok: true, status: 200, json: async () => EIA };
    return { ok: true, status: 200, json: async () => CENSUS };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function setEiaKey(value) {
  if (value) await prisma.systemSetting.upsert({ where: { key: 'eia.apiKey' }, create: { key: 'eia.apiKey', value: encrypt(value), secret: true }, update: { value: encrypt(value), secret: true } });
  else await prisma.systemSetting.deleteMany({ where: { key: 'eia.apiKey' } });
  invalidateSettings();
}

describe('market data', () => {
  let A; let B;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    await A.agent.post('/api/carriers').send({ companyName: 'Lone Star LLC', state: 'TX' });
    await A.agent.post('/api/carriers').send({ companyName: 'Austin Haul', state: 'TX' });
    await B.agent.post('/api/carriers').send({ companyName: 'B carrier', state: 'CA' });
  });
  beforeEach(() => clearMarketCache());
  afterEach(() => vi.unstubAllGlobals());

  it('parses places into states and EIA regions', () => {
    expect(stateOf('Dallas, TX')).toBe('TX');
    expect(stateOf('Texas')).toBe('TX');
    expect(stateOf('Boston, MA 02110')).toBe('MA');
    expect(stateOf('nowhere')).toBeNull();
    expect(regionForState('MA')).toBe('R1X');
    expect(regionForState('CA')).toBe('SCA');
  });

  it('diesel is honestly unconfigured without an EIA key when the demo key is disabled', async () => {
    await setEiaKey('');
    process.env.EIA_DISABLE_DEMO_KEY = 'true';
    try {
      const fetchMock = mockFetch();
      const res = await A.agent.get('/api/market/diesel?state=MA');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ configured: false, price: null, source: 'EIA' });
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('eia.gov'))).toBe(false);
    } finally {
      delete process.env.EIA_DISABLE_DEMO_KEY;
    }
  });

  it('without its own key, diesel uses the public EIA DEMO_KEY', async () => {
    await setEiaKey('');
    const fetchMock = mockFetch();
    const res = await A.agent.get('/api/market/diesel?state=MA');
    expect(res.status).toBe(200);
    const eiaCall = fetchMock.mock.calls.find(([u]) => String(u).includes('eia.gov'));
    expect(eiaCall && new URL(String(eiaCall[0])).searchParams.get('api_key')).toBe('DEMO_KEY');
  });

  it('diesel by state uses the EIA region with week-over-week change', async () => {
    await setEiaKey('test-key');
    const fetchMock = mockFetch();
    const res = await A.agent.get('/api/market/diesel?state=MA');
    expect(res.body).toMatchObject({ configured: true, price: 6.416, period: '2026-11-02', region: 'R1X', regionLabel: 'New England', source: 'EIA' });
    expect(res.body.change).toBeCloseTo(0.016, 3);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('facets[product][]')).toBe('EPD2D');
    expect(url.searchParams.get('api_key')).toBe('test-key');
    // cached: second call does not refetch
    await A.agent.get('/api/market/diesel?state=TX');
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('eia.gov'))).toHaveLength(1);
  });

  it('summary combines diesel, FMCSA counts, own carriers and an honest spot-rate note', async () => {
    await setEiaKey('test-key');
    const fetchMock = mockFetch();
    const res = await A.agent.get('/api/market/summary');
    expect(res.status).toBe(200);
    expect(res.body.diesel.national).toMatchObject({ price: 6.292, period: '2026-11-02' });
    expect(res.body.diesel.regions.find((x) => x.region === 'SCA').price).toBe(8.076);
    expect(res.body.carriersByState.items).toEqual([{ state: 'CA', count: 329273 }, { state: 'TX', count: 194559 }]);
    expect(res.body.carriersByState.source).toBe('FMCSA Company Census');
    const census = fetchMock.mock.calls.map(([u]) => new URL(String(u))).find((u) => u.host.includes('transportation.gov'));
    expect(census.searchParams.get('$group')).toBe('phy_state');
    expect(res.body.mine).toEqual([{ state: 'TX', count: 2 }]);
    expect(res.body.spotRates).toEqual({ available: false, manual: null, link: 'https://www.dat.com/trendlines' });
  });

  it('own carrier counts are owner-scoped', async () => {
    mockFetch();
    const res = await B.agent.get('/api/market/summary');
    expect(res.body.mine).toEqual([{ state: 'CA', count: 1 }]);
  });

  it('reports source failures without inventing numbers', async () => {
    await setEiaKey('test-key');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'down' }) })));
    const res = await A.agent.get('/api/market/summary');
    expect(res.body.diesel.national).toBeNull();
    expect(res.body.diesel.error).toMatch(/EIA error/);
    expect(res.body.carriersByState.items).toEqual([]);
    expect(res.body.carriersByState.error).toBeTruthy();
  });

  it('trip estimate: miles, fuel, cost per mile and fuel stops', async () => {
    await setEiaKey('test-key');
    mockFetch();
    const res = await A.agent.post('/api/market/trip').send({ stops: ['Dallas, TX', { place: 'Atlanta, GA' }], mpg: 6.5, tankGallons: 150 });
    expect(res.status).toBe(200);
    expect(res.body.estimate).toBe(true);
    expect(res.body.miles).toBeGreaterThan(700);
    expect(res.body.miles).toBeLessThan(1000);
    expect(res.body.legs[0].precision).toBe('city');
    expect(res.body.dieselPrice).toBe(5.9);
    expect(res.body.fuelCostPerMile).toBeCloseTo(5.9 / 6.5, 3);
    const exact = await A.agent.post('/api/market/trip').send({ stops: ['TX', 'GA'], mpg: 6, tankGallons: 100, miles: 1200, dieselPrice: 6 });
    expect(exact.body).toMatchObject({ miles: 1200, estimate: false, gallons: 200, fuelCost: 1200, fuelStops: 1, priceSource: 'entered' });
    const bad = await A.agent.post('/api/market/trip').send({ stops: ['Atlantis', 'TX'] });
    expect(bad.status).toBe(400);
  });

  it('spot rates: entered per user, used in the trip calculator, private to the user', async () => {
    mockFetch();
    const put = await A.agent.put('/api/market/spot-rates').send({ van: 2.25, reefer: '2.7', flatbed: '' });
    expect(put.status).toBe(200);
    expect(put.body.manual).toMatchObject({ van: 2.25, reefer: 2.7, flatbed: null });
    expect(put.body.manual.updatedAt).toBeTruthy();
    expect((await A.agent.get('/api/market/summary')).body.spotRates.manual.van).toBe(2.25);
    expect((await B.agent.get('/api/market/spot-rates')).body.manual).toBeNull();
    const trip = await A.agent.post('/api/market/trip').send({ stops: ['TX', 'GA'], miles: 1000, mpg: 6, dieselPrice: 6, equipment: 'reefer' });
    expect(trip.body).toMatchObject({ ratePerMile: 2.7, revenue: 2700, fuelCost: 1000, afterFuel: 1700 });
    expect(trip.body.rateSource).toMatch(/Your reefer rate/);
    expect((await A.agent.put('/api/market/spot-rates').send({ van: 50 })).status).toBe(400);
    const cleared = await A.agent.put('/api/market/spot-rates').send({ van: null, reefer: null, flatbed: null });
    expect(cleared.body.manual).toBeNull();
  });

  it('admin can store the EIA key encrypted', async () => {
    const admin = await createAdmin();
    const list = await admin.agent.get('/api/admin/settings');
    expect(JSON.stringify(list.body)).toContain('eia.apiKey');
    // per-user spot rates never show up in the admin settings list
    expect(JSON.stringify(list.body)).not.toContain('spotRates');
  });

  it('requires auth', async () => {
    const { agent } = await import('./helpers.js');
    const anon = await agent();
    expect((await anon.get('/api/market/summary')).status).toBe(401);
  });
});
