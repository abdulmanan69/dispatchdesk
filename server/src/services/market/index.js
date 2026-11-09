import { getSetting } from '../../lib/settings.js';
import { HttpError } from '../../lib/errors.js';
import * as census from '../carriers/fmcsaCensus.js';
import { EIA_REGIONS, STATES, regionForState } from './geo.js';
import { markOk, markError } from './live.js';

/**
 * Market data from public sources only:
 * - EIA Open Data API v2: weekly No. 2 diesel retail prices (needs a free API key).
 * - FMCSA Company Census (data.transportation.gov): active carriers per state (no key).
 * Results are cached in memory; nothing is invented when a source fails.
 */
const EIA_URL = 'https://api.eia.gov/v2/petroleum/pri/gnd/data/';
export const EIA_SOURCE_URL = 'https://www.eia.gov/petroleum/gasdiesel/';
export const CENSUS_SOURCE_URL = 'https://data.transportation.gov/Trucking-and-Motorcoaches/Motor-Carrier-Registrations-Census-Files/az4n-8mr2';
const DIESEL_TTL = 6 * 3600000;
const CENSUS_TTL = 24 * 3600000;

const cache = { diesel: null, dieselAt: 0, dieselKey: '', census: null, censusAt: 0 };
export function clearMarketCache() { cache.diesel = null; cache.dieselAt = 0; cache.census = null; cache.censusAt = 0; }

async function fetchDiesel(apiKey, fetchImpl = globalThis.fetch) {
  const url = new URL(EIA_URL);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('frequency', 'weekly');
  url.searchParams.set('data[0]', 'value');
  // No. 2 diesel and regular gasoline, last ~13 weeks (current, change, and a 12-week history).
  url.searchParams.append('facets[product][]', 'EPD2D');
  url.searchParams.append('facets[product][]', 'EPMR');
  url.searchParams.set('start', new Date(Date.now() - 95 * 86400000).toISOString().slice(0, 10));
  for (const d of Object.keys(EIA_REGIONS)) url.searchParams.append('facets[duoarea][]', d);
  url.searchParams.set('sort[0][column]', 'period');
  url.searchParams.set('sort[0][direction]', 'desc');
  url.searchParams.set('length', '400');
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new HttpError(502, `EIA unreachable: ${err.message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(502, `EIA error (${res.status}): ${body?.error?.message || body?.error || 'request failed'}`);
  const rows = body?.response?.data || [];
  const byKey = {};
  for (const r of rows) {
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    const product = r.product || 'EPD2D';
    (byKey[`${product}:${r.duoarea}`] ||= []).push({ period: r.period, value: v });
  }
  const build = (product) => {
    const out = {};
    for (const [code, label] of Object.entries(EIA_REGIONS)) {
      const list = (byKey[`${product}:${code}`] || []).sort((a, b) => (a.period < b.period ? 1 : -1));
      if (!list.length) continue;
      const [cur, prev] = list;
      out[code] = {
        region: code, regionLabel: label, price: cur.value, period: cur.period,
        change: prev ? Math.round((cur.value - prev.value) * 1000) / 1000 : null, previousPeriod: prev?.period || null,
      };
    }
    return out;
  };
  const history = (byKey['EPD2D:NUS'] || []).sort((a, b) => (a.period < b.period ? -1 : 1)).slice(-12).map((p) => ({ period: p.period, price: p.value }));
  return { regions: build('EPD2D'), gasoline: build('EPMR'), history };
}

/** All EIA regions, cached. Returns { configured, regions, fetchedAt, error? }. */
export async function dieselRegions({ fetchImpl } = {}) {
  const apiKey = await getSetting('eia.apiKey');
  if (!apiKey) return { configured: false, regions: {}, gasoline: {}, history: [], error: 'Add a free EIA API key in Admin → Settings → Integrations to show diesel prices.' };
  if (cache.diesel && cache.dieselKey === apiKey && Date.now() - cache.dieselAt < DIESEL_TTL) return { configured: true, ...cache.diesel };
  try {
    const { regions, gasoline, history } = await fetchDiesel(apiKey, fetchImpl);
    cache.diesel = { regions, gasoline, history, fetchedAt: new Date().toISOString() };
    markOk('eia');
    cache.dieselAt = Date.now();
    cache.dieselKey = apiKey;
    return { configured: true, ...cache.diesel };
  } catch (err) {
    markError('eia', err.message);
    // Serve the last good value if we have one, and say it is stale.
    if (cache.diesel && cache.dieselKey === apiKey) return { configured: true, ...cache.diesel, error: `${err.message} (showing last fetched prices)` };
    return { configured: true, regions: {}, gasoline: {}, history: [], error: err.message };
  }
}

export async function dieselForState(state, opts) {
  const d = await dieselRegions(opts);
  const code = state ? regionForState(state) : 'NUS';
  const r = (code && d.regions[code]) || d.regions.NUS || null;
  return {
    configured: d.configured,
    price: r?.price ?? null, change: r?.change ?? null, period: r?.period ?? null,
    region: r?.region ?? code, regionLabel: r?.regionLabel ?? (code ? EIA_REGIONS[code] : null),
    source: 'EIA', sourceUrl: EIA_SOURCE_URL,
    ...(d.error ? { error: d.error } : {}),
  };
}

/** Active (USDOT status A) carriers per state from the FMCSA census, cached 24h. */
export async function carriersByState({ fetchImpl } = {}) {
  if (cache.census && Date.now() - cache.censusAt < CENSUS_TTL) return cache.census;
  try {
    const rows = await census.query({ $select: 'phy_state,count(*) as n', $where: "status_code='A'", $group: 'phy_state', $order: 'n DESC', $limit: '100' }, fetchImpl);
    const items = rows
      .map((r) => ({ state: String(r.phy_state || '').toUpperCase(), count: Number(r.n) || 0 }))
      // US states and DC only (the census also lists territories and Canadian/Mexican addresses).
      .filter((r) => STATES[r.state] && r.count > 0);
    cache.census = { items, source: 'FMCSA Company Census', sourceUrl: CENSUS_SOURCE_URL, fetchedAt: new Date().toISOString() };
    cache.censusAt = Date.now();
    markOk('fmcsa');
    return cache.census;
  } catch (err) {
    markError('fmcsa', err.message);
    if (cache.census) return { ...cache.census, error: `${err.message} (showing last fetched counts)` };
    return { items: [], source: 'FMCSA Company Census', sourceUrl: CENSUS_SOURCE_URL, fetchedAt: null, error: err.message };
  }
}
