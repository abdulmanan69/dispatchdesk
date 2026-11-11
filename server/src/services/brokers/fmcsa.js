import { config } from '../../config.js';
import { query as censusQuery } from '../carriers/fmcsaCensus.js';
import { getSetting } from '../../lib/settings.js';
import { normDot, normMc, normPhone, dateOrNull } from '../carriers/normalize.js';

/**
 * FMCSA public data for broker vetting and the nightly watchlist (read-only, free):
 *   - Company Census (data.transportation.gov az4n-8mr2) through services/carriers/fmcsaCensus.js query():
 *     legal name, USDOT status, operation classification (carship: B = broker), phone, email, address, add date.
 *   - QCMobile (mobile.fmcsa.dot.gov), only when an admin saved the free webKey: broker/common authority status,
 *     BMC-84/85 bond on file, BIPD insurance on file, allowed to operate, out-of-service date.
 * Results are snapshots ({ found, ... , checkedAt }) with their sources. Per-process cache (6 h, 2,000 entries) with
 * in-flight de-duplication and at most 2 concurrent upstream calls per process; the shared copy of a snapshot lives on
 * the Broker / Carrier row (fmcsaSnapshot), so one lookup serves every page view of that row.
 */
const TTL_MS = 6 * 60 * 60_000;
const MAX_ENTRIES = 2000;
const TIMEOUT_MS = 12_000;
const QC_BASE = 'https://mobile.fmcsa.dot.gov/qc/services';
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

/** Normalized snapshot from a census row (and an optional QCMobile carrier record). */
export function snapshotFrom(row, { qc = null, query = {}, checkedAt = new Date() } = {}) {
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
  const common = authority(qc?.commonAuthorityStatus);
  const contract = authority(qc?.contractAuthorityStatus);
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
    brokerAuthority: qc ? authority(qc.brokerAuthorityStatus) : null,
    carrierAuthority: qc ? (common === 'active' || contract === 'active' ? 'active' : common === 'pending' || contract === 'pending' ? 'pending' : common || contract) : null,
    bondOnFile: qc ? yn(qc.bondInsuranceOnFile) : null,
    bondRequired: qc ? yn(qc.bondInsuranceRequired) : null,
    insuranceOnFile: qc ? yn(qc.bipdInsuranceOnFile) : null,
    insuranceRequired: qc ? yn(qc.bipdInsuranceRequired) : null,
    allowedToOperate: qc ? yn(qc.allowedToOperate) : null,
    oosDate: qc?.oosDate ? iso(dateOrNull(qc.oosDate)) : null,
    sources: [
      { name: 'FMCSA census', dataset: 'az4n-8mr2', asOf: at },
      ...(qc ? [{ name: 'FMCSA QCMobile', asOf: at }] : []),
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
  return hit && Date.now() - hit.at < TTL_MS ? hit.value : null;
}

function remember(key, value) {
  cache.delete(key);
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
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
    const rows = await censusRows(normDot(dot) ? { dots: [dot] } : { mcs: [mc] });
    const row = rows.find((r) => (normDot(dot) ? normDot(r.dot_number) === normDot(dot) : normMc(r.docket1) === normMc(mc))) || rows[0] || null;
    const qc = row ? await qcCarrier(row.dot_number) : null;
    const snap = snapshotFrom(row, { qc, query: { mc: normMc(mc), dot: normDot(dot) }, checkedAt: now });
    remember(key, snap);
    if (snap.found && snap.dot) remember(`dot:${snap.dot}`, snap);
    if (snap.found && snap.mc) remember(`mc:${snap.mc}`, snap);
    return snap;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function resetFmcsaCache() {
  cache.clear();
  inflight.clear();
}
