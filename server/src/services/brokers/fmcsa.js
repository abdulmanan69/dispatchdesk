import { config } from '../../config.js';
import { query as censusQuery } from '../carriers/fmcsaCensus.js';
import { getSetting } from '../../lib/settings.js';
import { normDot, normMc, normPhone, dateOrNull } from '../carriers/normalize.js';

/**
 * FMCSA public data for broker vetting and the nightly watchlist (read-only, free):
 *   - Company Census (data.transportation.gov az4n-8mr2) through services/carriers/fmcsaCensus.js query():
 *     legal name, USDOT status, operation classification (carship: B = broker), phone, email, address, add date.
 *   - FMCSA Licensing & Insurance "Carrier" dataset (data.transportation.gov 6eyk-hxee, updated daily, no key):
 *     broker/common/contract authority status (active, inactive, pending), revocation pending, BMC-84/85 bond and
 *     BIPD insurance required / on file. Used whenever QCMobile is not available.
 *   - QCMobile (mobile.fmcsa.dot.gov), only when an admin saved the free webKey: the same authority and bond facts
 *     plus allowed to operate and out-of-service date. QCMobile refuses requests from outside the US (403), so a
 *     server hosted abroad relies on the licensing dataset.
 * Results are snapshots ({ found, ... , checkedAt }) with their sources. Per-process cache (6 h, 2,000 entries) with
 * in-flight de-duplication and at most 2 concurrent upstream calls per process; the shared copy of a snapshot lives on
 * the Broker / Carrier row (fmcsaSnapshot), so one lookup serves every page view of that row.
 */
const TTL_MS = 6 * 60 * 60_000;
// A snapshot made while the licensing dataset did not answer is kept only briefly, so the next view retries it.
const RETRY_TTL_MS = 2 * 60_000;
const MAX_ENTRIES = 2000;
const TIMEOUT_MS = 12_000;
const QC_BASE = 'https://mobile.fmcsa.dot.gov/qc/services';
export const LICENSING_URL = 'https://data.transportation.gov/resource/6eyk-hxee.json';
export const MOTUS_URL = 'https://data.transportation.gov/resource/inys-ebih.json';
const cache = new Map(); // key -> { at, value }
const inflight = new Map(); // key -> Promise
let fetchOverride = null;

/** Tests inject a fake fetch (and get a clean cache). */
export function setFmcsaFetch(fn) {
  fetchOverride = fn || null;
  cache.clear();
  inflight.clear();
}
// Tests never reach the real FMCSA services: they inject a fake fetch, otherwise lookups fail fast.
const doFetch = (...args) => {
  if (fetchOverride) return fetchOverride(...args);
  if (config.isTest) return Promise.reject(new Error('FMCSA lookups are disabled in tests'));
  return globalThis.fetch(...args);
};
const timedFetch = (url, opts = {}) => doFetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });

// At most 2 concurrent upstream calls per process.
let active = 0;
const waiting = [];
async function limited(fn) {
  if (active >= 2) await new Promise((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

const keyOf = ({ mc, dot }) => (normDot(dot) ? `dot:${normDot(dot)}` : normMc(mc) ? `mc:${normMc(mc)}` : null);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const str = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};

/** Normalized snapshot from a census row, plus an optional QCMobile carrier record or licensing (L&I) row. */
export function snapshotFrom(row, { qc = null, lic = null, query = {}, checkedAt = new Date() } = {}) {
  const at = iso(checkedAt);
  if (!row) return { v: 1, found: false, query, checkedAt: at, sources: [{ name: 'FMCSA census', dataset: 'az4n-8mr2', asOf: at }] };
  const carship = str(row.carship);
  const status = String(row.status_code || '').toUpperCase();
  const phones = [...new Set([row.phone, row.cell_phone, qc?.telephone].map(normPhone).filter((p) => p && p.length === 10))];
  const yn = (v) => (v == null || v === '' ? null : String(v).toUpperCase() === 'Y');
  const authority = (v) => {
    const s = String(v || '').toUpperCase();
    return s === 'A' ? 'active' : s === 'P' ? 'pending' : s === 'I' ? 'inactive' : s === 'N' ? 'none' : null;
  };
  // Licensing rows say A/I/N plus a separate "application pending" flag.
  const liAuthority = (stat, pending) => (yn(pending) && String(stat || '').toUpperCase() !== 'A' ? 'pending' : authority(stat));
  const li = !qc && lic ? lic : null;
  const common = qc ? authority(qc.commonAuthorityStatus) : li ? liAuthority(li.common_stat, li.common_app_pend) : null;
  const contract = qc ? authority(qc.contractAuthorityStatus) : li ? liAuthority(li.contract_stat, li.contract_app_pend) : null;
  const amount = (v) => (v == null || String(v).trim() === '' ? null : Number(v));
  return {
    v: 1,
    found: true,
    query,
    checkedAt: at,
    dot: normDot(row.dot_number),
    mc: row.docket1prefix === 'MC' ? normMc(row.docket1) : normMc(query.mc),
    legalName: str(row.legal_name),
    dbaName: str(row.dba_name),
    registeredBroker: carship ? carship.toUpperCase().includes('B') : null,
    usdotStatus: status === 'A' ? 'active' : status === 'I' ? 'inactive' : null,
    docketStatus: str(row.docket1_status_code),
    phones,
    email: str(row.email_address)?.toLowerCase() ?? null,
    address: { street: str(row.phy_street), city: str(row.phy_city), state: str(row.phy_state), zip: str(row.phy_zip) },
    addedAt: iso(dateOrNull(row.add_date)),
    mcs150Date: iso(dateOrNull(row.mcs150_date)),
    qc: !!qc,
    qcAsOf: qc ? at : null,
    licensing: !!li,
    licensingAsOf: li ? at : null,
    brokerAuthority: qc ? authority(qc.brokerAuthorityStatus) : li ? liAuthority(li.broker_stat, li.broker_app_pend) : null,
    carrierAuthority: (qc || li) ? (common === 'active' || contract === 'active' ? 'active' : common === 'pending' || contract === 'pending' ? 'pending' : common || contract) : null,
    brokerRevocationPending: li ? yn(li.broker_rev_pend) : null,
    bondOnFile: qc ? yn(qc.bondInsuranceOnFile) : li ? yn(li.bond_file) : null,
    bondRequired: qc ? yn(qc.bondInsuranceRequired) : li ? yn(li.bond_req) : null,
    insuranceOnFile: qc ? yn(qc.bipdInsuranceOnFile) : li ? (amount(li.bipd_file) == null ? null : amount(li.bipd_file) > 0) : null,
    insuranceRequired: qc ? yn(qc.bipdInsuranceRequired) : li ? (amount(li.min_cov_amount) == null ? null : amount(li.min_cov_amount) > 0) : null,
    allowedToOperate: qc ? yn(qc.allowedToOperate) : null,
    oosDate: qc?.oosDate ? iso(dateOrNull(qc.oosDate)) : null,
    sources: [
      { name: 'FMCSA census', dataset: 'az4n-8mr2', asOf: at },
      ...(qc ? [{ name: 'FMCSA QCMobile', asOf: at }] : []),
      ...(li ? [{ name: 'FMCSA licensing', dataset: '6eyk-hxee', asOf: at }] : []),
    ],
  };
}

/** Census rows for up to 200 USDOT and 200 MC numbers in one request. */
export async function censusRows({ dots = [], mcs = [] } = {}) {
  const d = [...new Set(dots.map(normDot).filter(Boolean))].slice(0, 200);
  const m = [...new Set(mcs.map(normMc).filter(Boolean))].slice(0, 200);
  if (!d.length && !m.length) return [];
  const parts = [];
  if (d.length) parts.push(`dot_number in(${d.map((x) => `'${x}'`).join(',')})`);
  if (m.length) parts.push(`(docket1prefix='MC' AND docket1 in(${m.map((x) => `'${x}'`).join(',')}))`);
  return limited(() => censusQuery({ $limit: String(Math.min(1000, (d.length + m.length) * 2)), $where: parts.join(' OR ') }, (url, opts) => timedFetch(url, opts)));
}

/**
 * Best census row among several for the same MC docket: an MC number can appear on an old, inactive USDOT record and
 * on the current one (e.g. a company that re-registered). Active USDOT first, then active docket, then the newest.
 */
export function bestCensusRow(rows) {
  const score = (r) => (String(r.status_code || '').toUpperCase() === 'A' ? 2 : 0) + (String(r.docket1_status_code || '').toUpperCase() === 'A' ? 1 : 0);
  return [...rows].sort((a, b) => score(b) - score(a) || String(b.add_date || '').localeCompare(String(a.add_date || '')))[0] || null;
}

/**
 * Snapshot from a licensing row alone, for when the census cannot be reached. Census-only facts (USDOT status,
 * broker classification, registration date, email) stay null so no flag is raised from missing data.
 */
export function snapshotFromLicensingOnly(lic, { query = {}, checkedAt = new Date() } = {}) {
  const docket = String(lic.docket_number || '').toUpperCase();
  const row = {
    dot_number: lic.dot_number, legal_name: lic.legal_name, dba_name: lic.dba_name,
    docket1prefix: docket.startsWith('MC') ? 'MC' : null, docket1: docket.startsWith('MC') ? docket.slice(2) : null,
    phone: lic.bus_telno, phy_street: lic.bus_street_po, phy_city: lic.bus_city, phy_state: lic.bus_state_code, phy_zip: lic.bus_zip_code,
  };
  const snap = snapshotFrom(row, { lic, query, checkedAt });
  return { ...snap, censusUnavailable: true, sources: snap.sources.filter((s) => s.name !== 'FMCSA census') };
}

const padDot = (d) => String(d).padStart(8, '0'); // the licensing dataset stores USDOT numbers as 8 digits

/**
 * One SODA request to a data.transportation.gov dataset, through the per-process limiter, with the Socrata app token
 * when one is set. Rows, or null when the dataset did not answer. An answer that fills the whole $limit may be cut
 * off, so it counts as no answer too (a missing row must never read as "no authority").
 */
async function sodaRows(base, where, limit, name) {
  const url = new URL(base);
  url.searchParams.set('$where', where);
  url.searchParams.set('$limit', String(limit));
  try {
    const token = await getSetting('fmcsa.socrataAppToken');
    const res = await limited(() => timedFetch(url.toString(), { headers: { Accept: 'application/json', ...(token ? { 'X-App-Token': token } : {}) } }));
    if (!res.ok) {
      console.warn(`[fmcsa] ${name} answered ${res.status}`);
      return null;
    }
    const rows = await res.json().catch(() => null);
    if (!Array.isArray(rows)) return null;
    if (rows.length >= limit) {
      console.warn(`[fmcsa] ${name} answer may be cut off at ${limit} rows`);
      return null;
    }
    return rows;
  } catch (err) {
    console.warn(`[fmcsa] ${name} unreachable: ${err.message}`);
    return null;
  }
}

/**
 * Licensing (L&I) rows for up to 200 USDOT and 200 MC numbers in one request. Best effort: null when the dataset did
 * not answer (the census facts still stand; callers retry sooner), [] when it answered with no rows.
 * The legacy L&I dataset does not hold carriers registered in FMCSA's newer Motus system: see motusRows().
 */
export async function licensingRows({ dots = [], mcs = [] } = {}) {
  const d = [...new Set(dots.map(normDot).filter(Boolean))].slice(0, 200);
  const m = [...new Set(mcs.map(normMc).filter(Boolean))].slice(0, 200);
  if (!d.length && !m.length) return [];
  const parts = [];
  if (d.length) parts.push(`dot_number in(${d.map((x) => `'${padDot(x)}'`).join(',')})`);
  if (m.length) parts.push(`docket_number in(${m.map((x) => `'MC${x}'`).join(',')})`);
  return sodaRows(LICENSING_URL, parts.join(' OR '), Math.min(5000, (d.length + m.length) * 5), 'licensing dataset');
}

/**
 * FMCSA Motus "Carrier" authority rows (data.transportation.gov inys-ebih, updated daily, no key) for up to 200 USDOT
 * and 200 MC numbers in one request: authorities registered in the newer Motus system, which the legacy L&I dataset
 * (licensingRows) does not contain. One row per docket and authority type (op_auth_type, op_auth_status 'Active' |
 * 'Pending' | 'Inactive' | 'Withdrawn', bipd_file in dollars). usdot_number is not zero-padded here.
 * null when the dataset did not answer, [] when it answered with no rows.
 */
export async function motusRows({ dots = [], mcs = [] } = {}) {
  const d = [...new Set(dots.map(normDot).filter(Boolean))].slice(0, 200);
  const m = [...new Set(mcs.map(normMc).filter(Boolean))].slice(0, 200);
  if (!d.length && !m.length) return [];
  const parts = [];
  if (d.length) parts.push(`usdot_number in(${d.map((x) => `'${x}'`).join(',')})`);
  if (m.length) parts.push(`docket_number in(${m.map((x) => `'MC${x}'`).join(',')})`);
  return sodaRows(MOTUS_URL, parts.join(' OR '), Math.min(5000, (d.length + m.length) * 8), 'Motus carrier dataset');
}

/** The licensing row that describes this company: its MC docket first, then a docket with active broker authority. */
export function pickLicensing(rows, { dot, mc } = {}) {
  const d = normDot(dot);
  const m = normMc(mc);
  const isMine = (r) => String(r.docket_number || '').toUpperCase() === `MC${m}`;
  const ours = rows.filter((r) => (m && isMine(r)) || (d && normDot(r.dot_number) === d));
  return ours.find((r) => m && isMine(r))
    || ours.find((r) => String(r.broker_stat || '').toUpperCase() === 'A')
    || ours[0] || null;
}

/** QCMobile carrier record (null when no webKey is configured, not found, or the service fails). */
export async function qcCarrier(dot) {
  const key = await getSetting('fmcsa.webKey');
  const n = normDot(dot);
  if (!key || !n) return null;
  try {
    const res = await limited(() => timedFetch(`${QC_BASE}/carriers/${n}?webKey=${encodeURIComponent(key)}`, { headers: { Accept: 'application/json' } }));
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return body?.content?.carrier || null;
  } catch {
    return null;
  }
}

export const qcConfigured = async () => !!(await getSetting('fmcsa.webKey'));

/** Snapshot already in this process's cache (no network), or null. */
export function cachedSnapshot(q) {
  const key = keyOf(q);
  const hit = key && cache.get(key);
  return hit && Date.now() - hit.at < (hit.ttl || TTL_MS) ? hit.value : null;
}

function remember(key, value, ttl = TTL_MS) {
  cache.delete(key);
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), ttl, value });
}

/**
 * Snapshot for one broker by MC or USDOT number. Uses the per-process cache unless `fresh`.
 * Throws an HttpError (502/429) when FMCSA cannot be reached.
 */
export async function lookupBroker({ mc, dot }, { fresh = false, now = new Date() } = {}) {
  const key = keyOf({ mc, dot });
  if (!key) return null;
  if (!fresh) {
    const hit = cachedSnapshot({ mc, dot });
    if (hit) return hit;
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    let rows;
    try {
      rows = await censusRows(normDot(dot) ? { dots: [dot] } : { mcs: [mc] });
    } catch (err) {
      // The census dataset is rate limited or down: answer from the licensing dataset alone (legal name, address,
      // phone, authority, bond) and try the census again in a couple of minutes.
      const licOnly = await licensingRows(normDot(dot) ? { dots: [dot] } : { mcs: [mc] });
      const lic = licOnly && pickLicensing(licOnly, { dot, mc });
      if (!lic) throw err;
      const snap = snapshotFromLicensingOnly(lic, { query: { mc: normMc(mc), dot: normDot(dot) }, checkedAt: now });
      remember(key, snap, RETRY_TTL_MS);
      return snap;
    }
    const matches = rows.filter((r) => (normDot(dot) ? normDot(r.dot_number) === normDot(dot) : r.docket1prefix === 'MC' && normMc(r.docket1) === normMc(mc)));
    const row = bestCensusRow(matches.length ? matches : rows);
    const rowMc = row && row.docket1prefix === 'MC' ? row.docket1 : mc;
    const [qc, licRows] = row
      ? await Promise.all([qcCarrier(row.dot_number), licensingRows({ dots: [row.dot_number], mcs: rowMc ? [rowMc] : [] })])
      : [null, []];
    const lic = row ? pickLicensing(licRows || [], { dot: row.dot_number, mc: rowMc }) : null;
    const snap = snapshotFrom(row, { qc, lic, query: { mc: normMc(mc), dot: normDot(dot) }, checkedAt: now });
    const ttl = row && licRows === null && !qc ? RETRY_TTL_MS : TTL_MS;
    remember(key, snap, ttl);
    if (snap.found && snap.dot) remember(`dot:${snap.dot}`, snap, ttl);
    if (snap.found && snap.mc) remember(`mc:${snap.mc}`, snap, ttl);
    return snap;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function resetFmcsaCache() {
  cache.clear();
  inflight.clear();
}
