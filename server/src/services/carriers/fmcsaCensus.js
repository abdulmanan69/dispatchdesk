import { config } from '../../config.js';
import { getSetting } from '../../lib/settings.js';
import { HttpError } from '../../lib/errors.js';
import { normDot, normMc, normPhone, normState, intOrNull, dateOrNull, trimOrNull } from './normalize.js';
import { timezoneForState } from '../../lib/timezones.js';

/**
 * FMCSA Company Census File (public, data.transportation.gov dataset az4n-8mr2) via the Socrata SODA API.
 * No key required; an optional Socrata app token raises rate limits.
 * The census has no equipment field. Cargo flags are mapped to equipment only where unambiguous.
 */
export const id = 'fmcsa_census';
export const label = 'FMCSA Company Census (public)';

const CARGO_EQUIPMENT = {
  crgo_coldfood: 'reefer',
  crgo_meat: 'reefer',
  crgo_produce: 'reefer',
  crgo_motoveh: 'car_hauler',
  crgo_drivetow: 'car_hauler',
  crgo_liqgas: 'tanker',
  crgo_chem: 'tanker',
  crgo_logpole: 'flatbed',
  crgo_bldgmat: 'flatbed',
  crgo_metalsheet: 'flatbed',
  crgo_machlrg: 'flatbed',
};
export const CARGO_LABELS = {
  crgo_genfreight: 'General freight', crgo_household: 'Household goods', crgo_metalsheet: 'Metal/sheets/coils', crgo_motoveh: 'Motor vehicles',
  crgo_drivetow: 'Drive/tow away', crgo_logpole: 'Logs/poles/lumber', crgo_bldgmat: 'Building materials', crgo_mobilehome: 'Mobile homes',
  crgo_machlrg: 'Machinery/large objects', crgo_produce: 'Fresh produce', crgo_liqgas: 'Liquids/gases', crgo_intermodal: 'Intermodal containers',
  crgo_passengers: 'Passengers', crgo_oilfield: 'Oilfield equipment', crgo_livestock: 'Livestock', crgo_grainfeed: 'Grain/feed/hay',
  crgo_coalcoke: 'Coal/coke', crgo_meat: 'Meat', crgo_garbage: 'Garbage/refuse', crgo_usmail: 'US mail', crgo_chem: 'Chemicals',
  crgo_drybulk: 'Dry bulk', crgo_coldfood: 'Refrigerated food', crgo_beverages: 'Beverages', crgo_paperprod: 'Paper products',
  crgo_utility: 'Utilities', crgo_farmsupp: 'Farm supplies', crgo_construct: 'Construction', crgo_waterwell: 'Water well',
};
const OPERATION = { A: 'Interstate', B: 'Intrastate hazmat', C: 'Intrastate non-hazmat' };

/** Equipment the census can imply (through cargo classes), and the cargo classes that imply it. */
export const EQUIPMENT_FROM_CARGO = [...new Set(Object.values(CARGO_EQUIPMENT))];
export const cargoForEquipment = (eq) => Object.keys(CARGO_EQUIPMENT).filter((k) => CARGO_EQUIPMENT[k] === eq);

export async function status() {
  const token = await getSetting('fmcsa.socrataAppToken');
  return { id, label, available: true, configured: true, requiresKey: false, note: token ? 'Using Socrata app token (higher rate limit).' : 'Anonymous access — rate limited. Add a Socrata app token in Admin → Integrations for higher limits.' };
}

/** Map a census row into DispatchDesk carrier fields (plus display-only extras). */
export function mapRecord(r) {
  const state = normState(r.phy_state);
  const cargo = Object.keys(CARGO_LABELS).filter((k) => String(r[k] || '').toUpperCase() === 'X');
  const equipment = [...new Set(cargo.map((k) => CARGO_EQUIPMENT[k]).filter(Boolean))];
  const mc = r.docket1prefix === 'MC' ? normMc(r.docket1) : null;
  const statusCode = String(r.status_code || '').toUpperCase();
  return {
    companyName: trimOrNull(r.legal_name, 200) || `USDOT ${r.dot_number}`,
    dbaName: trimOrNull(r.dba_name, 200),
    dotNumber: normDot(r.dot_number),
    mcNumber: mc,
    phone: normPhone(r.phone),
    email: trimOrNull(r.email_address, 254)?.toLowerCase() ?? null,
    address: trimOrNull(r.phy_street, 300),
    city: trimOrNull(r.phy_city, 100),
    state,
    zip: trimOrNull(r.phy_zip, 12),
    timezone: timezoneForState(state),
    fleetSize: intOrNull(r.power_units),
    drivers: intOrNull(r.total_drivers ?? r.driver_inter_total),
    // Census status_code is USDOT registration status (A=active, I=inactive), not operating-authority status.
    authorityStatus: statusCode === 'A' ? 'active' : statusCode === 'I' ? 'inactive' : 'unknown',
    authorityDate: dateOrNull(r.add_date),
    operatingStatus: statusCode === 'A' ? 'USDOT active' : statusCode === 'I' ? 'USDOT inactive' : null,
    classification: trimOrNull(r.classdef, 200),
    carrierOperation: OPERATION[r.carrier_operation] || trimOrNull(r.carrier_operation, 40),
    equipment: equipment.length ? equipment.join(',') : null,
    _extra: {
      cargo: cargo.map((k) => CARGO_LABELS[k]),
      mcs150Date: dateOrNull(r.mcs150_date),
      safetyRating: r.safety_rating || null,
      hazmat: r.hm_ind === 'Y',
      docket: r.docket1prefix && r.docket1 ? `${r.docket1prefix}-${r.docket1}` : null,
      // Status of the first docket (MC) in the census: A active, I inactive, P pending. Not a live authority check.
      docketStatus: DOCKET_STATUS[String(r.docket1_status_code || '').toUpperCase()] || null,
    },
  };
}
const DOCKET_STATUS = { A: 'active', I: 'inactive', P: 'pending' };

const esc = (s) => String(s).replace(/'/g, "''");
const ymd = (d) => new Date(d).toISOString().slice(0, 10).replace(/-/g, '');

function buildWhere(f, { numeric = true } = {}) {
  const w = [];
  if (f.dot) w.push(`dot_number='${esc(normDot(f.dot))}'`);
  if (f.mc) w.push(`docket1prefix='MC' AND docket1='${esc(normMc(f.mc))}'`);
  if (f.state) w.push(`phy_state='${esc(String(f.state).toUpperCase())}'`);
  if (f.city) w.push(`upper(phy_city)='${esc(String(f.city).toUpperCase())}'`);
  if (f.name) w.push(`upper(legal_name) like '%${esc(String(f.name).toUpperCase().replace(/[%_]/g, ''))}%'`);
  if (f.activeOnly) w.push(`status_code='A'`);
  if (f.hasMc) w.push(`docket1prefix='MC'`);
  if (f.hasEmail) w.push('email_address IS NOT NULL');
  if (f.hasPhone) w.push('phone IS NOT NULL');
  const cargo = (f.cargo || []).filter((k) => Object.hasOwn(CARGO_LABELS, k));
  if (cargo.length) w.push(`(${cargo.map((k) => `${k}='X'`).join(' OR ')})`);
  if (f.addedAfter) w.push(`add_date>='${ymd(f.addedAfter)}'`);
  if (f.addedBefore) w.push(`add_date<='${ymd(f.addedBefore)}'`);
  if (numeric && f.minPowerUnits != null) w.push(`power_units::number>=${Number(f.minPowerUnits)}`);
  if (numeric && f.maxPowerUnits != null) w.push(`power_units::number<=${Number(f.maxPowerUnits)}`);
  return w.join(' AND ');
}

// ---------------------------------------------------------------------------
// Response cache (opt-in per call site)
// The census changes at most daily, and many users run the same state queries from one server IP. Callers that can
// accept slightly old data pass { cacheMs }: identical queries are then answered from a per-process cache, and
// concurrent identical queries share one upstream request (single-flight). The cache is bounded by entries and by
// total rows, so it cannot grow with traffic. It only saves upstream calls; nothing depends on it for correctness.
// Lead-generator runs and "save to CRM" verification never use it: they always read fresh data.
// After a 429 from Socrata, every query fails fast for RATE_LIMIT_BACKOFF_MS instead of hammering the API.
// ---------------------------------------------------------------------------
const CACHE_MAX_ENTRIES = 200;
const CACHE_MAX_ROWS = 5000;
const RATE_LIMIT_BACKOFF_MS = 30_000;
const RATE_LIMIT_MESSAGE = 'FMCSA Census rate limit reached. Wait a minute, or add a Socrata app token in Admin → Integrations.';
const cache = new Map(); // url -> { at, ttl, rows }
const inflight = new Map(); // url -> Promise<rows>
let cachedRows = 0;
let rateLimitedUntil = 0;

/** Drop cached responses and the rate-limit backoff (tests, or after an admin changes the census URL/token). */
export function clearCensusCache() {
  cache.clear();
  inflight.clear();
  cachedRows = 0;
  rateLimitedUntil = 0;
}

function cacheGet(key, now = Date.now()) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.at > hit.ttl) { cache.delete(key); cachedRows -= hit.rows.length; return null; }
  return hit.rows;
}

function cacheSet(key, rows, ttl) {
  if (rows.length > CACHE_MAX_ROWS) return;
  const old = cache.get(key);
  if (old) { cache.delete(key); cachedRows -= old.rows.length; }
  while (cache.size && (cache.size >= CACHE_MAX_ENTRIES || cachedRows + rows.length > CACHE_MAX_ROWS)) {
    const [k, v] = cache.entries().next().value;
    cache.delete(k);
    cachedRows -= v.rows.length;
  }
  cache.set(key, { at: Date.now(), ttl, rows });
  cachedRows += rows.length;
}

async function fetchRows(url, fetchImpl) {
  const token = await getSetting('fmcsa.socrataAppToken');
  let res;
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json', ...(token ? { 'X-App-Token': token } : {}) }, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new HttpError(502, `FMCSA Census service unreachable: ${err.message}`);
  }
  if (res.status === 429) {
    rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
    throw new HttpError(429, RATE_LIMIT_MESSAGE);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new HttpError(502, `FMCSA Census error (${res.status}): ${body?.message?.slice(0, 200) || 'unknown error'}`);
    err.upstreamStatus = res.status;
    throw err;
  }
  return Array.isArray(body) ? body : [];
}

/**
 * Low-level fetch; `fetchImpl` is injectable for tests.
 * opts.cacheMs > 0: answer identical queries from the bounded per-process cache for that long (see above).
 * Returned rows may be shared with other callers: treat them as read-only.
 */
export async function query(params, fetchImpl = globalThis.fetch, { cacheMs = 0 } = {}) {
  const url = new URL(config.fmcsa.censusUrl);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, v);
  const limited = () => Date.now() < rateLimitedUntil;
  if (!(cacheMs > 0)) {
    if (limited()) throw new HttpError(429, RATE_LIMIT_MESSAGE);
    return fetchRows(url, fetchImpl);
  }
  // Cached answers and requests already in flight are still served during the rate-limit backoff.
  const key = url.toString();
  const hit = cacheGet(key);
  if (hit) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;
  if (limited()) throw new HttpError(429, RATE_LIMIT_MESSAGE);
  const p = fetchRows(url, fetchImpl)
    .then((rows) => { cacheSet(key, rows, cacheMs); return rows; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Search the census. Numeric fleet filters use a SoQL ::number cast; if the endpoint rejects
 * the cast, we fall back to filtering the fetched page in memory (and say so).
 * opts.cacheMs: see query().
 */
export async function search(filters, fetchImpl, opts = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const base = { $limit: String(limit), $offset: String(offset), $order: filters.order === 'newest' ? 'add_date DESC, dot_number' : 'dot_number' };
  let rows;
  let note = null;
  try {
    rows = await query({ ...base, $where: buildWhere(filters) || undefined }, fetchImpl, opts);
  } catch (err) {
    if (err.upstreamStatus !== 400 || (filters.minPowerUnits == null && filters.maxPowerUnits == null)) throw err;
    rows = await query({ ...base, $limit: String(Math.min(limit * 4, 1000)), $where: buildWhere(filters, { numeric: false }) || undefined }, fetchImpl, opts);
    rows = rows.filter((r) => {
      const n = intOrNull(r.power_units) ?? 0;
      return (filters.minPowerUnits == null || n >= filters.minPowerUnits) && (filters.maxPowerUnits == null || n <= filters.maxPowerUnits);
    }).slice(0, limit);
    note = 'Fleet-size filter applied to the fetched page only.';
  }
  return { provider: id, source: label, retrievedAt: new Date().toISOString(), note, items: rows.map(mapRecord) };
}

export async function lookup({ dot, mc }, fetchImpl, opts = {}) {
  if (!dot && !mc) return null;
  const rows = await query({ $limit: '1', $where: buildWhere({ dot, mc }) }, fetchImpl, opts);
  return rows[0] ? mapRecord(rows[0]) : null;
}

/**
 * Public counts for context (cached): active registrations in a state (optionally one city) and how many of them list
 * brokerage (census `carship` contains B). Returns { carriers, brokers, newestAddDate } or null fields when unavailable.
 */
export async function stateCounts({ state, city }, fetchImpl, { cacheMs = 12 * 3600_000 } = {}) {
  const st = String(state || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(st)) return null;
  const where = [`phy_state='${esc(st)}'`, `status_code='A'`];
  if (city) where.push(`upper(phy_city)='${esc(String(city).toUpperCase().slice(0, 80))}'`);
  const count = async (extra) => {
    const rows = await query({ $select: 'count(*) as n', $where: [...where, ...extra].join(' AND ') }, fetchImpl, { cacheMs });
    const n = Number(rows[0]?.n);
    return Number.isFinite(n) ? n : null;
  };
  const [carriers, brokers] = await Promise.all([count([`carship like '%C%'`]), count([`carship like '%B%'`])]);
  return { state: st, city: city || null, carriers, brokers };
}

/** Newest USDOT registration date in the census for a state (the file lags behind real time). Cached. */
export async function newestAddDate(state, fetchImpl, { cacheMs = 6 * 3600_000 } = {}) {
  const st = String(state || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(st)) return null;
  const rows = await query({ $select: 'max(add_date) as newest', $where: `phy_state='${esc(st)}'` }, fetchImpl, { cacheMs });
  return dateOrNull(rows[0]?.newest);
}

export async function lookupMany(dots, fetchImpl) {
  const clean = [...new Set(dots.map(normDot).filter(Boolean))].slice(0, 200);
  if (!clean.length) return [];
  const rows = await query({ $limit: String(clean.length), $where: `dot_number in(${clean.map((d) => `'${d}'`).join(',')})` }, fetchImpl);
  return rows.map(mapRecord);
}
