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
// After a failure the source is not asked again for this long (the last good value, if any, is served meanwhile).
const FAIL_TTL = 10 * 60000;

const cache = { diesel: null, dieselAt: 0, dieselKey: '', dieselFail: null, census: null, censusAt: 0, censusFail: null };
// Concurrent requests share one upstream call per source.
const pending = { diesel: null, census: null };
export function clearMarketCache() {
  Object.assign(cache, { diesel: null, dieselAt: 0, dieselKey: '', dieselFail: null, census: null, censusAt: 0, censusFail: null });
  pending.diesel = null;
  pending.census = null;
}

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
    res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
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
  // EIA's public DEMO_KEY is used until an admin adds their own free key (it is rate limited; prices are cached 6 hours).
  const ownKey = await getSetting('eia.apiKey');
  const apiKey = ownKey || (process.env.EIA_DISABLE_DEMO_KEY === 'true' ? null : 'DEMO_KEY');
  if (!apiKey) return { configured: false, regions: {}, gasoline: {}, history: [], error: 'Add a free EIA API key in Admin → Settings → Integrations to show diesel prices.' };
  if (cache.diesel && cache.dieselKey === apiKey && Date.now() - cache.dieselAt < DIESEL_TTL) return { configured: true, demoKey: !ownKey, ...cache.diesel };
  const failed = (message) => {
    // Serve the last good value if we have one, and say it is stale.
    if (cache.diesel && cache.dieselKey === apiKey) return { configured: true, ...cache.diesel, error: `${message} (showing last fetched prices)` };
    return { configured: true, regions: {}, gasoline: {}, history: [], error: message };
  };
  if (cache.dieselFail && cache.dieselFail.key === apiKey && Date.now() - cache.dieselFail.at < FAIL_TTL) return failed(cache.dieselFail.message);
  if (!pending.diesel) {
    pending.diesel = (async () => {
      try {
        const { regions, gasoline, history } = await fetchDiesel(apiKey, fetchImpl);
        cache.diesel = { regions, gasoline, history, fetchedAt: new Date().toISOString() };
        markOk('eia');
        cache.dieselAt = Date.now();
        cache.dieselKey = apiKey;
        cache.dieselFail = null;
        return null;
      } catch (err) {
        markError('eia', err.message);
        cache.dieselFail = { key: apiKey, at: Date.now(), message: err.message };
        return err.message;
      } finally {
        pending.diesel = null;
      }
    })();
  }
  const error = await pending.diesel;
  if (error) return failed(error);
  return { configured: true, demoKey: !ownKey, ...cache.diesel };
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
  const failed = (message) => {
    if (cache.census) return { ...cache.census, error: `${message} (showing last fetched counts)` };
    return { items: [], source: 'FMCSA Company Census', sourceUrl: CENSUS_SOURCE_URL, fetchedAt: null, error: message };
  };
  if (cache.censusFail && Date.now() - cache.censusFail.at < FAIL_TTL) return failed(cache.censusFail.message);
  if (!pending.census) {
    pending.census = (async () => {
      try {
        const rows = await census.query({ $select: 'phy_state,count(*) as n', $where: "status_code='A'", $group: 'phy_state', $order: 'n DESC', $limit: '100' }, fetchImpl);
        const items = rows
          .map((r) => ({ state: String(r.phy_state || '').toUpperCase(), count: Number(r.n) || 0 }))
          // US states and DC only (the census also lists territories and Canadian/Mexican addresses).
          .filter((r) => STATES[r.state] && r.count > 0);
        cache.census = { items, source: 'FMCSA Company Census', sourceUrl: CENSUS_SOURCE_URL, fetchedAt: new Date().toISOString() };
        cache.censusAt = Date.now();
        cache.censusFail = null;
        markOk('fmcsa');
        return null;
      } catch (err) {
        markError('fmcsa', err.message);
        cache.censusFail = { at: Date.now(), message: err.message };
        return err.message;
      } finally {
        pending.census = null;
      }
    })();
  }
  const error = await pending.census;
  return error ? failed(error) : cache.census;
}
