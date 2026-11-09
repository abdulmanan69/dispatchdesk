import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { clearLiveCache, USER_AGENT } from '../src/services/market/live.js';
import { clearMarketCache } from '../src/services/market/index.js';
import { invalidateSettings } from '../src/lib/settings.js';
import { encrypt } from '../src/lib/crypto.js';

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, body = {}) => ({ ok: false, status, json: async () => body });

const PHOTON = { features: [
  { properties: { name: 'Dallas', osm_value: 'city', state: 'Texas', countrycode: 'US' }, geometry: { coordinates: [-96.7968559, 32.7762719] } },
  { properties: { name: 'Dallas', osm_value: 'city', state: 'Oregon', countrycode: 'US' }, geometry: { coordinates: [-123.3, 44.9] } },
  { properties: { name: 'Dallas', osm_value: 'town', state: 'Ontario', countrycode: 'CA' }, geometry: { coordinates: [-80, 43] } },
] };
const OSRM = { code: 'Ok', routes: [{ distance: 1555417.5, duration: 61545.8, geometry: { coordinates: [[-96.79, 32.77], [-93.2, 33.9], [-87.63, 41.88]] } }] };
const METEO = { current: { time: '2026-11-09T22:00', temperature_2m: 69.4, wind_speed_10m: 2.9, wind_gusts_10m: 8.1, weather_code: 3, precipitation: 0 } };
const NWS = { features: [
  { properties: { id: 'a1', event: 'Flood Advisory', severity: 'Minor', headline: 'Flood Advisory for Kimble', areaDesc: 'Kimble, TX', ends: '2026-11-09T18:45:00-06:00' } },
  { properties: { id: 'a2', event: 'Tornado Warning', severity: 'Extreme', headline: 'Tornado Warning', areaDesc: 'Tulsa, OK', expires: '2026-11-09T19:00:00-06:00' } },
] };
const NAGER = [
  { date: '2026-11-11', name: 'Veterans Day', global: true },
  { date: '2026-11-26', name: 'Thanksgiving Day', global: true },
  { date: '2026-12-01', name: 'Some State Day', global: false },
];

function route(handlers) {
  const fn = vi.fn(async (url, opts) => {
    const u = String(url);
    for (const [frag, h] of handlers) if (u.includes(frag)) return typeof h === 'function' ? h(u, opts) : h;
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function setKey(key, value) {
  if (value) await prisma.systemSetting.upsert({ where: { key }, create: { key, value: encrypt(value), secret: true }, update: { value: encrypt(value), secret: true } });
  else await prisma.systemSetting.deleteMany({ where: { key } });
  invalidateSettings();
}

describe('free real-time market data', () => {
  let A;
  beforeAll(async () => {
    A = await registerUser();
    await A.agent.post('/api/carriers').send({ companyName: 'OK Freight', state: 'OK' });
  });
  beforeEach(() => { clearLiveCache(); clearMarketCache(); });
  afterEach(() => vi.unstubAllGlobals());

  it('geocode: Photon results limited to the US, with 2-letter states, cached', async () => {
    const f = route([['photon.komoot.io', ok(PHOTON)]]);
    const res = await A.agent.get('/api/market/geocode?q=Dallas');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('photon');
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({ label: 'Dallas, TX', city: 'Dallas', state: 'TX', lat: 32.7762719, lng: -96.7968559 });
    expect(res.body.attribution).toMatch(/OpenStreetMap/);
    expect(f.mock.calls[0][1].headers['User-Agent']).toBe(USER_AGENT);
    await A.agent.get('/api/market/geocode?q=dallas');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('geocode: falls back to bundled city centers when Photon fails', async () => {
    route([['photon.komoot.io', fail(503)]]);
    const res = await A.agent.get('/api/market/geocode?q=Atlanta, GA');
    expect(res.body.source).toBe('centroid');
    expect(res.body.items[0]).toMatchObject({ state: 'GA' });
    expect(res.body.note).toMatch(/Photon geocoder error \(503\)/);
    expect((await A.agent.get('/api/market/geocode?q=a')).status).toBe(400);
  });

  it('route: OSRM road miles and geometry, cached; estimate fallback on failure', async () => {
    const f = route([['router.project-osrm.org', ok(OSRM)]]);
    const res = await A.agent.get('/api/market/route?from=32.7767,-96.797&to=41.8781,-87.6298');
    expect(res.body).toMatchObject({ miles: 966, durationHours: 17.1, source: 'OSRM', estimate: false });
    expect(res.body.geometry).toHaveLength(3);
    expect(String(f.mock.calls[0][0])).toContain('/route/v1/driving/-96.797,32.7767;-87.6298,41.8781');
    await A.agent.get('/api/market/route?from=32.7767,-96.797&to=41.8781,-87.6298');
    expect(f).toHaveBeenCalledTimes(1);

    clearLiveCache();
    route([['router.project-osrm.org', () => { throw new TypeError('fetch failed'); }]]);
    const est = await A.agent.get('/api/market/route?from=32.7767,-96.797&to=41.8781,-87.6298');
    expect(est.body).toMatchObject({ source: 'estimate', estimate: true });
    expect(est.body.miles).toBeGreaterThan(800);
    expect(est.body.note).toMatch(/OSRM router unreachable/);
    expect((await A.agent.get('/api/market/route?from=abc&to=1,2')).status).toBe(400);
  });

  it('weather: Open-Meteo current + NWS alerts sorted by severity; partial failure is reported', async () => {
    route([['api.open-meteo.com', ok(METEO)], ['api.weather.gov', ok(NWS)]]);
    const res = await A.agent.get('/api/market/weather?lat=32.78&lng=-96.8');
    expect(res.body.current).toMatchObject({ tempF: 69.4, windMph: 2.9, description: 'Overcast' });
    expect(res.body.alerts.map((a) => a.severity)).toEqual(['Extreme', 'Minor']);
    expect(res.body.alerts[1].expires).toBe('2026-11-09T18:45:00-06:00');
    expect(res.body.errors).toEqual([]);

    clearLiveCache();
    route([['api.open-meteo.com', ok(METEO)], ['api.weather.gov', fail(500, { detail: 'Unexpected Problem' })]]);
    const partial = await A.agent.get('/api/market/weather?lat=32.78&lng=-96.8');
    expect(partial.body.current.tempF).toBe(69.4);
    expect(partial.body.alerts).toEqual([]);
    expect(partial.body.errors[0]).toMatch(/National Weather Service error \(500\)/);
  });

  it('alerts: by states, defaulting to the user’s carrier states', async () => {
    const f = route([['api.weather.gov', ok(NWS)]]);
    const res = await A.agent.get('/api/market/alerts?states=tx,ok');
    expect(res.body.states).toEqual(['OK', 'TX']);
    expect(res.body.items[0].event).toBe('Tornado Warning');
    expect(new URL(String(f.mock.calls[0][0])).searchParams.get('area')).toBe('OK,TX');
    const mine = await A.agent.get('/api/market/alerts');
    expect(mine.body.states).toEqual(['OK']);
    expect((await A.agent.get('/api/market/alerts?states=ZZ')).status).toBe(400);
  });

  it('holidays: national holidays only, with freight notes, cached', async () => {
    const f = route([['date.nager.at', ok(NAGER)]]);
    const res = await A.agent.get('/api/market/holidays');
    expect(res.body.items.map((h) => h.name)).toEqual(['Veterans Day', 'Thanksgiving Day']);
    expect(res.body.items[1].note).toMatch(/Retail peak/);
    await A.agent.get('/api/market/holidays');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('indicators: FRED and USDA are honest without keys and never call out', async () => {
    await setKey('fred.apiKey', '');
    await setKey('usda.marsApiKey', '');
    const f = route([]);
    const res = await A.agent.get('/api/market/indicators');
    expect(res.body.truckTonnage).toMatchObject({ configured: false, points: [] });
    expect(res.body.usdaTruckRates).toMatchObject({ configured: false, pdfUrl: 'https://www.ams.usda.gov/mnreports/fvwtrk.pdf' });
    expect(f).not.toHaveBeenCalled();
  });

  it('indicators: FRED truck tonnage with a key; USDA report via MARS basic auth', async () => {
    await setKey('fred.apiKey', 'fredkey');
    await setKey('usda.marsApiKey', 'marskey');
    const obs = Array.from({ length: 13 }, (_, i) => ({ date: `2025-${String((i % 12) + 1).padStart(2, '0')}-01`, value: String(110 + i) })).reverse();
    const f = route([
      ['api.stlouisfed.org', ok({ observations: obs })],
      ['marsapi.ams.usda.gov/services/v1.2/reports/2999', ok({ results: [{ report_date: '11/06/2026', district: 'Arizona', commodity: 'Lettuce', destination: 'Atlanta', price_low: '7000', price_high: '7500', slug_id: 2999 }] })],
      ['marsapi.ams.usda.gov/services/v1.2/reports', ok([{ slug_id: 1, report_title: 'Daily Grain Report' }, { slug_id: 2999, report_title: 'National Fruit and Vegetable Truck Rate Report' }])],
    ]);
    const res = await A.agent.get('/api/market/indicators');
    expect(res.body.truckTonnage).toMatchObject({ configured: true, latest: { value: 122 }, change: 1, yoyPct: 10.9 });
    expect(new URL(String(f.mock.calls.find(([u]) => String(u).includes('stlouisfed'))[0])).searchParams.get('series_id')).toBe('TRUCKD11');
    expect(res.body.usdaTruckRates).toMatchObject({ configured: true, slug: 2999, reportDate: '11/06/2026' });
    expect(res.body.usdaTruckRates.rows[0]).toMatchObject({ district: 'Arizona', price_low: '7000' });
    expect(res.body.usdaTruckRates.rows[0].slug_id).toBeUndefined();
    const marsCall = f.mock.calls.find(([u]) => String(u).includes('marsapi'));
    expect(marsCall[1].headers.Authorization).toBe(`Basic ${Buffer.from('marskey:').toString('base64')}`);
  });

  it('indicators: provider errors are surfaced, not hidden', async () => {
    await setKey('fred.apiKey', 'badkey');
    await setKey('usda.marsApiKey', '');
    route([['api.stlouisfed.org', fail(400, { error_message: 'Bad Request.  The value for variable api_key is not registered.' })]]);
    const res = await A.agent.get('/api/market/indicators');
    expect(res.body.truckTonnage.error).toMatch(/FRED error \(400\).*api_key/);
    expect(res.body.truckTonnage.points).toEqual([]);
  });

  it('summary includes gasoline and a 12-week diesel history from one EIA call', async () => {
    await setKey('eia.apiKey', 'eiakey');
    const rows = [];
    for (let w = 0; w < 14; w++) {
      const d = new Date(Date.UTC(2026, 10, 2) - w * 7 * 86400000).toISOString().slice(0, 10);
      rows.push({ period: d, duoarea: 'NUS', product: 'EPD2D', value: String(6.3 - w * 0.01) });
      rows.push({ period: d, duoarea: 'NUS', product: 'EPMR', value: String(4.15 - w * 0.01) });
    }
    const f = route([['api.eia.gov', ok({ response: { data: rows } })], ['transportation.gov', ok([])]]);
    const res = await A.agent.get('/api/market/summary');
    expect(res.body.diesel.national.price).toBe(6.3);
    expect(res.body.diesel.history).toHaveLength(12);
    expect(res.body.diesel.history.at(-1)).toEqual({ period: '2026-11-02', price: 6.3 });
    expect(res.body.gasoline.national).toMatchObject({ price: 4.15, period: '2026-11-02' });
    const eiaUrl = new URL(String(f.mock.calls.find(([u]) => String(u).includes('eia.gov'))[0]));
    expect(eiaUrl.searchParams.getAll('facets[product][]')).toEqual(['EPD2D', 'EPMR']);
    expect(f.mock.calls.filter(([u]) => String(u).includes('eia.gov'))).toHaveLength(1);
  });

  it('sources lists every provider with status, key needs and terms links', async () => {
    await setKey('fred.apiKey', '');
    route([['date.nager.at', ok(NAGER)]]);
    await A.agent.get('/api/market/holidays');
    const res = await A.agent.get('/api/market/sources');
    const byId = Object.fromEntries(res.body.items.map((s) => [s.id, s]));
    expect(Object.keys(byId)).toEqual(expect.arrayContaining(['eia', 'fmcsa', 'photon', 'osrm', 'openmeteo', 'nws', 'nager', 'fred', 'usda']));
    expect(byId.nager.state).toBe('connected');
    expect(byId.fred.state).toBe('needs_key');
    expect(byId.osrm.terms).toMatch(/^https:\/\//);
    expect(JSON.stringify(res.body)).not.toMatch(/fredkey|marskey|eiakey/);
  });
});
