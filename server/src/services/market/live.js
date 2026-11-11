import cluster from 'node:cluster';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { getSetting } from '../../lib/settings.js';
import { HttpError } from '../../lib/errors.js';
import { STATES, locate, haversineMiles, ROAD_FACTOR, stateOf } from './geo.js';
import { decodePolyline, encodePolyline, simplifyToBudget } from '../fleet/polyline.js';

/**
 * Free, public real-time data adapters. Every one is verified against the live service, cached,
 * attributed in the UI, and fails honestly (an error message, never an invented number).
 *
 * No key:   Photon geocoder (komoot, OSM data), OSRM public demo router, Open-Meteo, NWS (api.weather.gov), Nager.Date.
 * Free key: FRED (St. Louis Fed), USDA AMS MARS (My Market News). EIA lives in ./index.js.
 */

export const USER_AGENT = `DispatchDesk/1.0 (+${config.appUrl})`;

// ---------------------------------------------------------------------------
// Source registry: status shown on the Market page "Data sources" section.
// ---------------------------------------------------------------------------
export const SOURCES = {
  eia: { name: 'EIA weekly fuel prices', provides: 'Diesel and gasoline, by region, weekly', terms: 'https://www.eia.gov/opendata/', key: 'eia.apiKey', keyUrl: 'https://www.eia.gov/opendata/register.php' },
  fmcsa: { name: 'FMCSA Company Census', provides: 'Active carriers per state', terms: 'https://data.transportation.gov/', key: null },
  photon: { name: 'Photon geocoder (OpenStreetMap)', provides: 'City and address search', terms: 'https://photon.komoot.io/', key: null, attribution: 'Data © OpenStreetMap contributors, ODbL' },
  osrm: { name: 'OSRM routing (public demo server)', provides: 'Road miles and drive time', terms: 'https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server', key: null, attribution: 'Routes © OpenStreetMap contributors, OSRM' },
  openmeteo: { name: 'Open-Meteo', provides: 'Current weather at a point', terms: 'https://open-meteo.com/en/terms', key: null, attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)' },
  nws: { name: 'National Weather Service', provides: 'Active weather alerts', terms: 'https://www.weather.gov/documentation/services-web-api', key: null },
  nager: { name: 'Nager.Date', provides: 'U.S. public holidays', terms: 'https://date.nager.at/', key: null },
  fred: { name: 'FRED, St. Louis Fed', provides: 'ATA truck tonnage index', terms: 'https://fred.stlouisfed.org/docs/api/terms_of_use.html', key: 'fred.apiKey', keyUrl: 'https://fred.stlouisfed.org/docs/api/api_key.html' },
  usda: { name: 'USDA AMS truck rates', provides: 'Refrigerated produce truck rates by shipping area', terms: 'https://mymarketnews.ams.usda.gov/mymarketnews-api', key: 'usda.marsApiKey', keyUrl: 'https://mymarketnews.ams.usda.gov/mymarketnews-api' },
};
const status = Object.fromEntries(Object.keys(SOURCES).map((k) => [k, { lastOkAt: null, lastErrorAt: null, lastError: null }]));
export function markOk(id) { if (status[id]) Object.assign(status[id], { lastOkAt: new Date().toISOString(), lastError: null }); }
export function markError(id, msg) { if (status[id]) Object.assign(status[id], { lastErrorAt: new Date().toISOString(), lastError: msg }); }

export async function sourceStatuses() {
  const out = [];
  for (const [id, s] of Object.entries(SOURCES)) {
    const st = status[id];
    const hasKey = s.key ? !!(await getSetting(s.key)) : true;
    const state = !hasKey ? 'needs_key' : st.lastError && (!st.lastOkAt || st.lastErrorAt > st.lastOkAt) ? 'error' : st.lastOkAt ? 'connected' : 'ready';
    out.push({ id, ...s, key: s.key || null, needsKey: !!s.key, state, lastOkAt: st.lastOkAt, lastError: st.lastError });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small TTL caches (per process, size-bounded), shared in-flight requests, and the JSON fetch helper
// ---------------------------------------------------------------------------
// Routes hold an encoded polyline (10-20 KB each), so that cache is kept smaller than the others.
const CACHE_MAX = { route: 400 };
const caches = new Map();
function cacheFor(name) {
  if (!caches.has(name)) caches.set(name, { max: CACHE_MAX[name] || 1000, map: new Map() });
  return caches.get(name);
}
function cget(name, key) {
  const c = cacheFor(name);
  const hit = c.map.get(key);
  if (!hit) return undefined;
  if (hit.exp < Date.now()) { c.map.delete(key); return undefined; }
  return hit.value;
}
function cset(name, key, value, ttlMs) {
  const c = cacheFor(name);
  c.map.delete(key);
  if (c.map.size >= c.max) c.map.delete(c.map.keys().next().value);
  c.map.set(key, { value, exp: Date.now() + ttlMs });
}

// Concurrent misses for the same key share one upstream request.
const inflight = new Map();
function single(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Cached call that also remembers failures for `failTtlMs`, so a provider that is down or rate limiting is not asked
 * again on every page view (the error is re-thrown from the cache until it expires).
 */
async function cachedCall(name, key, ttlMs, failTtlMs, fn) {
  const hit = cget(name, key);
  if (hit !== undefined) {
    if (hit && hit.failed) throw hit.error;
    return hit;
  }
  return single(`${name}:${key}`, async () => {
    try {
      const value = await fn();
      cset(name, key, value, ttlMs);
      return value;
    } catch (err) {
      cset(name, key, { failed: true, error: err }, failTtlMs);
      throw err;
    }
  });
}

// Free public services ask for about one request per second, for the whole server. A single process keeps the next free
// slot in memory. Cluster workers share one clock: the next free slot per service is one SystemSetting row
// (`throttle.<name>`) claimed with a compare-and-set, so all workers together stay at one request per second and each
// can use the whole budget when the others are idle. A request that would have to wait more than a few seconds is not
// queued: the caller uses its honest fallback and nothing is reserved.
const SLOT_GAP_MS = config.isTest ? 0 : 1000;
const SHARED_SLOTS = cluster.isWorker;
const nextSlot = { photon: 0, osrm: 0 };
// A stored slot further ahead than any real reservation can be (the clock was set back): treat it as free.
const MAX_AHEAD_MS = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reserveLocalSlot(name, gapMs, maxWaitMs, now = Date.now()) {
  const at = Math.max(now, nextSlot[name] || 0);
  const wait = at - now;
  if (wait > maxWaitMs) return -1;
  nextSlot[name] = at + gapMs;
  return wait;
}

/**
 * Reserve the next free request slot for `name` across every process sharing the database. Returns the milliseconds to
 * wait before calling the service, or -1 when the wait would exceed maxWaitMs (nothing is reserved then).
 */
export async function reserveSharedSlot(name, { gapMs = 1000, maxWaitMs = 4000 } = {}) {
  const key = `throttle.${name}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const now = Date.now();
    const row = await prisma.systemSetting.findUnique({ where: { key }, select: { value: true } });
    if (!row) {
      try {
        await prisma.systemSetting.create({ data: { key, value: String(now + gapMs), secret: false } });
        return 0;
      } catch (err) {
        if (err.code === 'P2002') continue; // another process created it first: read it again
        throw err;
      }
    }
    const stored = Number(row.value) || 0;
    const at = stored - now > MAX_AHEAD_MS ? now : Math.max(now, stored);
    const wait = at - now;
    if (wait > maxWaitMs) return -1;
    const { count } = await prisma.systemSetting.updateMany({ where: { key, value: row.value }, data: { value: String(at + gapMs) } });
    if (count === 1) return wait;
  }
  return -1; // lost the race every time: answer busy rather than queue
}

async function takeSlot(name, maxWaitMs = 4000) {
  if (!SLOT_GAP_MS) return true;
  let wait;
  try {
    wait = SHARED_SLOTS ? await reserveSharedSlot(name, { gapMs: SLOT_GAP_MS, maxWaitMs }) : reserveLocalSlot(name, SLOT_GAP_MS, maxWaitMs);
  } catch (err) {
    console.warn(`[market] ${name} throttle unavailable: ${err.message}`);
    return false;
  }
  if (wait < 0) return false;
  if (wait > 0) await sleep(wait);
  return true;
}

export function clearLiveCache() {
  caches.clear();
  inflight.clear();
  nextSlot.photon = 0;
  nextSlot.osrm = 0;
}

async function getJson(url, { label, headers = {}, timeout = 10000 } = {}) {
  // Tests never reach the internet: an external call only happens when the test stubs fetch.
  if (config.isTest && typeof globalThis.fetch?.mock !== 'object') throw new HttpError(502, `${label} unreachable: network calls are disabled in tests`);
  let res;
  try {
    res = await globalThis.fetch(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    throw new HttpError(502, `${label} unreachable: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(502, `${label} error (${res.status})${body?.detail || body?.message || body?.error_message ? `: ${String(body.detail || body.message || body.error_message).slice(0, 160)}` : ''}`);
  return body;
}

// ---------------------------------------------------------------------------
// Geocoding: Photon (OSM), US only, ~1 request/second across the cluster, cached 30 days. Falls back to bundled centroids.
// ---------------------------------------------------------------------------
const STATE_BY_NAME = Object.fromEntries(Object.entries(STATES).map(([code, [name]]) => [name.toLowerCase(), code]));

function fallbackGeocode(q) {
  const p = locate(q);
  if (!p?.state) return [];
  const name = STATES[p.state][0];
  const city = p.precision === 'city' ? String(q).split(',')[0].trim().replace(/\b\w/g, (c) => c.toUpperCase()) : null;
  return [{ label: city ? `${city}, ${p.state}` : name, city, state: p.state, lat: p.lat, lng: p.lon, precision: p.precision, source: 'centroid' }];
}

export async function geocode(q) {
  const query = String(q || '').trim();
  if (query.length < 2) return { items: [], source: null };
  const key = query.toLowerCase();
  const cached = cget('geocode', key);
  if (cached) return cached;
  return single(`geocode:${key}`, () => geocodeFresh(query, key));
}

async function geocodeFresh(query, key) {
  let out;
  try {
    if (!(await takeSlot('photon'))) throw new HttpError(503, 'Geocoder busy');
    const url = new URL('https://photon.komoot.io/api/');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', '8');
    url.searchParams.set('lang', 'en');
    // Bias toward the continental US.
    url.searchParams.set('lat', '39.5');
    url.searchParams.set('lon', '-98.35');
    const body = await getJson(url, { label: 'Photon geocoder', timeout: 8000 });
    const items = (body?.features || [])
      .filter((f) => f?.properties?.countrycode === 'US' && Array.isArray(f.geometry?.coordinates))
      .map((f) => {
        const p = f.properties;
        const state = STATE_BY_NAME[String(p.state || '').toLowerCase()] || stateOf(p.state || '') || null;
        const city = p.city || (['city', 'town', 'village', 'hamlet'].includes(p.osm_value) ? p.name : null) || p.name || null;
        const [lng, lat] = f.geometry.coordinates;
        const label = [p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street, city, state].filter(Boolean).join(', ') || p.name;
        return { label, city, state, lat, lng, precision: p.osm_value === 'state' ? 'state' : p.street ? 'address' : 'city', source: 'photon' };
      })
      .filter((x) => x.state);
    const seen = new Set();
    out = { items: items.filter((x) => (seen.has(x.label) ? false : seen.add(x.label))), source: 'photon', attribution: SOURCES.photon.attribution };
    markOk('photon');
  } catch (err) {
    // Our own throttle saying "busy" is not a provider error.
    if (err.status !== 503) markError('photon', err.message);
    out = { items: fallbackGeocode(query), source: 'centroid', note: `${err.message}. Showing approximate city or state centers.` };
    cset('geocode', key, out, err.status === 503 ? 60_000 : 10 * 60000);
    return out;
  }
  if (!out.items.length) {
    const fb = fallbackGeocode(query);
    if (fb.length) out = { ...out, items: fb, source: 'centroid' };
  }
  cset('geocode', key, out, 30 * 86400000);
  return out;
}

// ---------------------------------------------------------------------------
// Routing: OSRM public demo server (fair use, no SLA, ~1 request/second across the cluster). Full road geometry,
// simplified to at most a few thousand points and kept as an encoded polyline. Cached 7 days; one in-flight request per
// pair; failures are remembered for a couple of minutes. Fallback: straight line × road factor, marked as an estimate.
// ---------------------------------------------------------------------------
const round3 = (n) => Math.round(n * 1000) / 1000;
/** Average truck speed assumed when no road route is available (the same 50 mph the planner has always used). */
export const ESTIMATE_MPH = 50;

function estimateEncoded(from, to) {
  const miles = Math.round(haversineMiles([from.lat, from.lng], [to.lat, to.lng]) * ROAD_FACTOR);
  const minutes = Math.round((miles / ESTIMATE_MPH) * 60);
  return { miles, minutes, durationHours: Math.round((miles / ESTIMATE_MPH) * 10) / 10, encoded: encodePolyline([[from.lng, from.lat], [to.lng, to.lat]]), source: 'estimate', estimate: true };
}

export function estimateRoute(from, to) {
  const { encoded, ...rest } = estimateEncoded(from, to);
  return { ...rest, geometry: [[from.lng, from.lat], [to.lng, to.lat]] };
}

/**
 * Road route as { miles, minutes, durationHours, encoded, source: 'OSRM'|'estimate', estimate, note? }.
 * `encoded` is a polyline string of [lng, lat] points (see services/fleet/polyline.js).
 */
export async function routeEncoded(from, to) {
  const key = [from.lat, from.lng, to.lat, to.lng].map(round3).join(',');
  const cached = cget('route', key);
  if (cached) return cached;
  return single(`route:${key}`, async () => {
    try {
      if (!(await takeSlot('osrm'))) throw new HttpError(503, 'OSRM router busy');
      const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=polyline`;
      const body = await getJson(url, { label: 'OSRM router', timeout: 10000 });
      const r = body?.routes?.[0];
      if (body?.code !== 'Ok' || !r) throw new HttpError(502, `OSRM router: ${body?.message || body?.code || 'no route'}`);
      const raw = typeof r.geometry === 'string' ? decodePolyline(r.geometry) : (r.geometry?.coordinates || []);
      if (raw.length < 2) throw new HttpError(502, 'OSRM router: empty route geometry');
      const out = {
        miles: Math.round(r.distance / 1609.344), minutes: Math.round(r.duration / 60), durationHours: Math.round((r.duration / 3600) * 10) / 10,
        encoded: encodePolyline(simplifyToBudget(raw)), source: 'OSRM', estimate: false, attribution: SOURCES.osrm.attribution,
      };
      markOk('osrm');
      cset('route', key, out, 7 * 86400000);
      return out;
    } catch (err) {
      if (err.status !== 503) markError('osrm', err.message);
      const est = { ...estimateEncoded(from, to), note: `${err.message}. Straight-line estimate × ${ROAD_FACTOR}.` };
      cset('route', key, est, err.status === 503 ? 30_000 : 2 * 60_000);
      return est;
    }
  });
}

/** Road route for the API: same as routeEncoded but with `geometry` as [[lng, lat], ...]. */
export async function route(from, to) {
  const { encoded, ...rest } = await routeEncoded(from, to);
  return { ...rest, geometry: decodePolyline(encoded) };
}

// ---------------------------------------------------------------------------
// Weather: Open-Meteo current conditions + NWS alerts for the point. Cached 15 / 5 minutes.
// ---------------------------------------------------------------------------
const WMO = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers', 82: 'Violent rain showers',
  85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
};
const SEVERITY = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
const alertShape = (f) => {
  const p = f.properties || {};
  return { id: p.id || f.id, event: p.event, severity: p.severity || 'Unknown', urgency: p.urgency || null, headline: p.headline || p.event, areaDesc: p.areaDesc, expires: p.ends || p.expires || null, sender: p.senderName || null };
};
const sortAlerts = (list) => list.sort((a, b) => (SEVERITY[a.severity] ?? 4) - (SEVERITY[b.severity] ?? 4) || String(a.expires).localeCompare(String(b.expires)));

async function currentWeather(lat, lng) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  return cachedCall('meteo', key, 15 * 60000, 2 * 60000, () => fetchWeather(lat, lng));
}

async function fetchWeather(lat, lng) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lng));
  url.searchParams.set('current', 'temperature_2m,wind_speed_10m,wind_gusts_10m,weather_code,precipitation');
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('wind_speed_unit', 'mph');
  url.searchParams.set('precipitation_unit', 'inch');
  const body = await getJson(url, { label: 'Open-Meteo', timeout: 8000 });
  const c = body?.current;
  if (!c) throw new HttpError(502, 'Open-Meteo returned no current conditions');
  const out = {
    tempF: c.temperature_2m, windMph: c.wind_speed_10m, gustMph: c.wind_gusts_10m ?? null, precipIn: c.precipitation ?? null,
    code: c.weather_code, description: WMO[c.weather_code] || 'Unknown', observedAt: c.time,
  };
  return out;
}

async function nwsAlerts(query, cacheKey) {
  return cachedCall('nws', cacheKey, 5 * 60000, 2 * 60000, async () => {
    const url = new URL('https://api.weather.gov/alerts/active');
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const body = await getJson(url, { label: 'National Weather Service', headers: { Accept: 'application/geo+json' }, timeout: 10000 });
    return sortAlerts((body?.features || []).map(alertShape));
  });
}

export async function weather(lat, lng) {
  const result = { lat, lng, current: null, alerts: [], source: 'Open-Meteo, National Weather Service', attribution: SOURCES.openmeteo.attribution, errors: [] };
  const [cur, al] = await Promise.allSettled([currentWeather(lat, lng), nwsAlerts({ point: `${lat.toFixed(4)},${lng.toFixed(4)}` }, `pt:${lat.toFixed(2)},${lng.toFixed(2)}`)]);
  if (cur.status === 'fulfilled') { result.current = cur.value; markOk('openmeteo'); } else { result.errors.push(cur.reason.message); markError('openmeteo', cur.reason.message); }
  if (al.status === 'fulfilled') { result.alerts = al.value; markOk('nws'); } else { result.errors.push(al.reason.message); markError('nws', al.reason.message); }
  return result;
}

export async function alertsForStates(states) {
  const list = [...new Set(states.map((s) => String(s).toUpperCase()).filter((s) => STATES[s]))].sort().slice(0, 15);
  if (!list.length) return { states: [], items: [], source: 'National Weather Service', sourceUrl: 'https://alerts.weather.gov/' };
  try {
    const items = await nwsAlerts({ area: list.join(',') }, `area:${list.join(',')}`);
    markOk('nws');
    return { states: list, items: items.slice(0, 60), total: items.length, source: 'National Weather Service', sourceUrl: 'https://alerts.weather.gov/' };
  } catch (err) {
    markError('nws', err.message);
    return { states: list, items: [], total: 0, error: err.message, source: 'National Weather Service', sourceUrl: 'https://alerts.weather.gov/' };
  }
}

// ---------------------------------------------------------------------------
// Holidays: Nager.Date (public domain data), cached 24h.
// ---------------------------------------------------------------------------
const FREIGHT_NOTE = {
  "New Year's Day": 'Shippers and receivers mostly closed; tight capacity the week before.',
  'Memorial Day': 'Start of produce season; capacity tightens the week before.',
  'Independence Day': 'Many drivers off; spot rates often rise the week before.',
  'Labour Day': 'Long weekend; expect closed docks and higher rates the week before.',
  'Labor Day': 'Long weekend; expect closed docks and higher rates the week before.',
  'Thanksgiving Day': 'Retail peak; many docks closed Thursday and Friday.',
  'Christmas Day': 'Most docks closed; capacity tight the week before.',
};
export async function holidays() {
  try {
    return await cachedCall('nager', 'US', 86400000, 10 * 60000, async () => {
      const body = await getJson('https://date.nager.at/api/v3/NextPublicHolidays/US', { label: 'Nager.Date', timeout: 8000 });
      const items = (Array.isArray(body) ? body : []).filter((h) => h.global !== false).slice(0, 8)
        .map((h) => ({ date: h.date, name: h.name, note: FREIGHT_NOTE[h.name] || null }));
      markOk('nager');
      return { items, source: 'Nager.Date', sourceUrl: SOURCES.nager.terms, fetchedAt: new Date().toISOString() };
    });
  } catch (err) {
    markError('nager', err.message);
    return { items: [], source: 'Nager.Date', sourceUrl: SOURCES.nager.terms, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// FRED (free key): ATA truck tonnage index, monthly. Cached 12h.
// ---------------------------------------------------------------------------
export async function truckTonnage() {
  const base = { configured: false, series: 'TRUCKD11', title: 'Truck tonnage index (ATA, seasonally adjusted)', source: 'FRED, St. Louis Fed', sourceUrl: 'https://fred.stlouisfed.org/series/TRUCKD11', points: [] };
  const apiKey = await getSetting('fred.apiKey');
  if (!apiKey) return { ...base, error: 'Add a free FRED API key in Admin → Settings → Integrations.' };
  const hit = cget('fred', apiKey);
  if (hit) return hit;
  try {
    const url = new URL('https://api.stlouisfed.org/fred/series/observations');
    url.searchParams.set('series_id', 'TRUCKD11');
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('file_type', 'json');
    url.searchParams.set('sort_order', 'desc');
    url.searchParams.set('limit', '13');
    const body = await getJson(url, { label: 'FRED', timeout: 10000 });
    const points = (body?.observations || []).map((o) => ({ date: o.date, value: Number(o.value) })).filter((p) => Number.isFinite(p.value)).reverse();
    const last = points.at(-1);
    const prev = points.at(-2);
    const yearAgo = points.length >= 13 ? points[0] : null;
    const out = {
      ...base, configured: true, points, latest: last || null,
      change: last && prev ? Math.round((last.value - prev.value) * 10) / 10 : null,
      yoyPct: last && yearAgo ? Math.round(((last.value - yearAgo.value) / yearAgo.value) * 1000) / 10 : null,
      fetchedAt: new Date().toISOString(),
    };
    markOk('fred');
    cset('fred', apiKey, out, 12 * 3600000);
    return out;
  } catch (err) {
    markError('fred', err.message);
    return { ...base, configured: true, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// USDA AMS My Market News (MARS API, free key, HTTP Basic with the key as user name).
// Finds the specialty crops truck rate report and returns its latest rows as published.
// ---------------------------------------------------------------------------
export const USDA_PDF = 'https://www.ams.usda.gov/mnreports/fvwtrk.pdf';
const MARS = 'https://marsapi.ams.usda.gov/services/v1.2/reports';

export async function usdaTruckRates() {
  const base = { configured: false, title: 'Fruit and vegetable truck rate report', source: 'USDA AMS Market News', sourceUrl: USDA_PDF, rows: [] };
  const apiKey = await getSetting('usda.marsApiKey');
  if (!apiKey) return { ...base, error: 'Optional: add a free USDA My Market News API key to show these rates here. The weekly PDF is free to open.' };
  const hit = cget('usda', apiKey);
  if (hit) return hit;
  const headers = { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}` };
  try {
    const list = await getJson(MARS, { label: 'USDA MARS', headers, timeout: 15000 });
    const reports = Array.isArray(list) ? list : list?.results || [];
    const report = reports.find((r) => /truck rate/i.test(r.report_title || r.reportTitle || '') && /fruit|vegetable|specialty/i.test(`${r.report_title} ${r.market_types || ''} ${r.markets || ''}`))
      || reports.find((r) => /truck rate/i.test(r.report_title || r.reportTitle || ''));
    if (!report) throw new HttpError(502, 'USDA MARS: truck rate report not found in the report list');
    const slug = report.slug_id ?? report.slugId;
    const data = await getJson(`${MARS}/${encodeURIComponent(slug)}?lastReports=1`, { label: 'USDA MARS', headers, timeout: 15000 });
    const results = Array.isArray(data) ? data : data?.results || [];
    // Keep the report's own columns; drop bookkeeping fields.
    const DROP = /^(slug|report_title|published_date|office|market_type|final_ind|report_narrative|community|application|group)/i;
    const rows = results.slice(0, 60).map((r) => Object.fromEntries(Object.entries(r).filter(([k, v]) => !DROP.test(k) && v != null && v !== '')));
    const out = {
      ...base, configured: true, title: report.report_title || base.title, slug,
      reportDate: results[0]?.report_date || results[0]?.published_date || null, rows, fetchedAt: new Date().toISOString(),
    };
    markOk('usda');
    cset('usda', apiKey, out, 12 * 3600000);
    return out;
  } catch (err) {
    markError('usda', err.message);
    return { ...base, configured: true, error: err.message };
  }
}
