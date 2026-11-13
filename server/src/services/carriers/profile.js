import { config } from '../../config.js';
import { getSetting } from '../../lib/settings.js';
import { HttpError, notFound, badRequest } from '../../lib/errors.js';
import { query as censusQuery, CARGO_LABELS } from './fmcsaCensus.js';
import { get as qcGet } from './fmcsaQc.js';
import { bestCensusRow } from '../brokers/fmcsa.js';
import { normDot, normMc, normPhone } from './normalize.js';

/**
 * Full FMCSA carrier profile (like the SAFER company snapshot) from free public sources, for saved carriers and for any
 * USDOT number before saving.
 *
 * Sources (data.transportation.gov Socrata datasets, no key; the admin's Socrata app token is sent when set):
 *   az4n-8mr2  Company Census: identity, contact, operation, cargo, fleet, equipment, drivers, mileage, MCS-150,
 *              safety rating and latest review.
 *   inys-ebih  Motus carrier: FMCSA's current registration system (authority type and status, BIPD required / on file).
 *   6eyk-hxee  Legacy licensing (L&I) carrier rows: common / contract / broker authority, pending, revocation pending.
 *   c5y8-a4uz  Motus insurance on file;  qh9u-swkp  legacy active / pending insurance.
 *   3uet-3z4i  Motus insurance history;  6sqe-dvqs  legacy insurance history (cancellations, replacements).
 *   yu5v-wbh6  Motus authority history;  9mw4-x3tu  legacy authority history (granted, revoked, reinstated).
 *   QCMobile   only when an admin saved the FMCSA webKey: allowed to operate, out-of-service date, crashes,
 *              inspections with national averages, SMS BASICs, cargo / operation classes, dockets, live authority.
 *
 * What the real data looks like (checked against the dataset metadata and sample rows, Nov 2026):
 *   - The legacy L&I datasets (6eyk-hxee, qh9u-swkp, 6sqe-dvqs, 9mw4-x3tu) stopped updating on 2026-05-14 (FMCSA moved
 *     to Motus). A docket that Motus knows supersedes its legacy row; facts that only the legacy rows hold are shown
 *     with that date. Motus does not hold every carrier: older authorities with no change since the move are legacy only.
 *   - Motus amounts (bipd_file, min_cov_amount, max_cov_amount) are dollars although the metadata says thousands;
 *     legacy amounts are thousands. Motus bipd_file can still be 0 on a freshly granted authority whose BIPD policy is
 *     already on file, so a current Motus BIPD policy also counts as insurance on file.
 *   - Address status flags (legacy undeliverable_mail, Motus *_undeliverable_mail): Y = deliverable, N = undeliverable.
 *     Census undeliv_phy: U = undeliverable. Dates: census and Motus YYYYMMDD, legacy MM/DD/YYYY.
 *
 * Each source is best effort: a failed one is { ok: false, error } in `sources` and its section says it is not
 * available, never a guess. At most 4 upstream calls per profile (12 per process) are in flight, 20 s each; a call not
 * started within 40 s of the build is reported as timed out. Profiles are cached per process by USDOT number (6 h,
 * 5 minutes when a source failed, 500 entries) with in-flight de-duplication, so many users opening the same carrier
 * cause one set of upstream calls. The cache only saves calls; nothing depends on it for correctness.
 */
export const PROFILE_VERSION = 1;
export const LEGACY_AS_OF = '2026-05-14';
const SOCRATA = 'https://data.transportation.gov/resource';
const TIMEOUT_MS = 20_000;
const BUILD_BUDGET_MS = 40_000;
const PER_PROFILE = 4;
const PER_PROCESS = 12;
const TTL_MS = 6 * 3600_000;
const PARTIAL_TTL_MS = 5 * 60_000;
const NOT_FOUND_TTL_MS = 30 * 60_000;
const CACHE_MAX = 500;

const SOURCES = [
  { key: 'census', name: 'Company Census', dataset: 'az4n-8mr2' },
  { key: 'motus', name: 'Operating authority (Motus)', dataset: 'inys-ebih' },
  { key: 'licensing', name: 'Operating authority (legacy)', dataset: '6eyk-hxee', legacy: true },
  { key: 'motusInsurance', name: 'Insurance on file (Motus)', dataset: 'c5y8-a4uz' },
  { key: 'insurance', name: 'Insurance on file (legacy)', dataset: 'qh9u-swkp', legacy: true },
  { key: 'motusAuthorityHistory', name: 'Authority history (Motus)', dataset: 'yu5v-wbh6' },
  { key: 'authorityHistory', name: 'Authority history (legacy)', dataset: '9mw4-x3tu', legacy: true },
  { key: 'motusInsuranceHistory', name: 'Insurance history (Motus)', dataset: '3uet-3z4i' },
  { key: 'insuranceHistory', name: 'Insurance history (legacy)', dataset: '6sqe-dvqs', legacy: true },
  { key: 'qcmobile', name: 'QCMobile (live status and safety)' },
];

// USDOT numbers: Motus stores them unpadded, the legacy datasets as 8 digits; ask for both forms everywhere.
const dotIn = (col, dot) => `${col} in('${dot}','${dot.padStart(8, '0')}')`;
const QUERIES = {
  motus: (dot) => ({ where: dotIn('usdot_number', dot), limit: 50 }),
  licensing: (dot) => ({ where: dotIn('dot_number', dot), limit: 50 }),
  motusInsurance: (dot) => ({ where: dotIn('usdot_number', dot), limit: 200 }),
  insurance: (dot) => ({ where: dotIn('dot_number', dot), limit: 200 }),
  motusAuthorityHistory: (dot) => ({ where: dotIn('usdot_number', dot), limit: 300, order: 'status_change_date DESC' }),
  authorityHistory: (dot) => ({ where: dotIn('dot_number', dot), limit: 500 }),
  motusInsuranceHistory: (dot) => ({ where: dotIn('usdot_number', dot), limit: 300, order: 'cancl_effective_date DESC' }),
  insuranceHistory: (dot) => ({ where: dotIn('dot_number', dot), limit: 500 }),
};

// ---------------------------------------------------------------------------------------------------------------
// Upstream calls
// ---------------------------------------------------------------------------------------------------------------

let fetchOverride = null;
/** Tests inject a fake fetch (and get a clean cache). */
export function setProfileFetch(fn) {
  fetchOverride = fn || null;
  clearProfileCache();
}
// Tests never reach FMCSA: without an injected fetch, lookups fail fast.
const doFetch = (...args) => {
  if (fetchOverride) return fetchOverride(...args);
  if (config.isTest) return Promise.reject(new Error('FMCSA lookups are disabled in tests'));
  return globalThis.fetch(...args);
};

/** Concurrency limit; a finishing task hands its slot straight to the next waiter. */
function semaphore(max) {
  let active = 0;
  const queue = [];
  return async (fn) => {
    if (active < max) active += 1;
    else await new Promise((resolve) => queue.push(resolve));
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active -= 1;
    }
  };
}
const processLimit = semaphore(PER_PROCESS);

const errorText = (err) => String(err?.message || err || 'Unknown error').replace(/webKey=[^&\s]+/gi, 'webKey=***').slice(0, 200);
const lastModified = (res) => {
  const h = res?.headers?.get?.('last-modified');
  const d = h ? new Date(h) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

/** One SODA query against a data.transportation.gov dataset. Exported for the inspection and related-carrier reports. */
export async function socrata(dataset, { where, limit, order, select, group, timeoutMs = TIMEOUT_MS }) {
  const url = new URL(`${SOCRATA}/${dataset}.json`);
  url.searchParams.set('$where', where);
  url.searchParams.set('$limit', String(limit));
  if (order) url.searchParams.set('$order', order);
  if (select) url.searchParams.set('$select', select);
  if (group) url.searchParams.set('$group', group);
  const token = await getSetting('fmcsa.socrataAppToken');
  let res;
  try {
    res = await doFetch(url.toString(), { headers: { Accept: 'application/json', ...(token ? { 'X-App-Token': token } : {}) }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(err?.name === 'TimeoutError' ? 'Timed out' : `Unreachable: ${errorText(err)}`);
  }
  if (res.status === 429) throw new Error('Rate limited by data.transportation.gov');
  if (!res.ok) throw new Error(`Answered ${res.status}`);
  const rows = await res.json().catch(() => null);
  if (!Array.isArray(rows)) throw new Error('Unexpected answer');
  return { rows, asOf: lastModified(res) };
}

/** Any other public data call (NHTSA vPIC) through the same test hook: tests inject one fake fetch for everything. */
export const publicFetch = (...args) => doFetch(...args);

/** Raw census query (any SoQL params) through the same fetch hook; `cacheMs` uses the census module's shared cache. */
export const censusRows = (params, { cacheMs = 0 } = {}) => censusQuery(params, (url, opts) => doFetch(url, opts), { cacheMs });

/** Census rows through fmcsaCensus.query (admin census URL, shared 429 back-off). */
export async function census(where, limit = 5) {
  let asOf = null;
  const rows = await censusQuery({ $where: where, $limit: String(limit) }, async (url, opts) => {
    const res = await doFetch(url, opts);
    asOf = lastModified(res);
    return res;
  });
  return { rows, asOf };
}

const qcFetch = (url, opts) => doFetch(url, opts);
const QC_PARTS = { basics: 'basics', cargo: 'cargo-classification', operations: 'operation-classification', dockets: 'docket-numbers', authority: 'authority' };
const asList = (body) => (Array.isArray(body?.content) ? body.content : body?.content ? [body.content] : []);

async function qcAll(dot, run) {
  const qc = { ok: false, skipped: false, error: null, found: false, carrier: null, basics: null, cargo: null, operations: null, dockets: null, authority: null, partErrors: {} };
  try {
    const body = await run(() => qcGet(`/carriers/${dot}`, qcFetch));
    qc.carrier = body?.content?.carrier || null;
    qc.found = !!qc.carrier;
    qc.ok = true;
  } catch (err) {
    qc.error = errorText(err);
    return qc;
  }
  if (!qc.carrier) return qc;
  await Promise.all(Object.entries(QC_PARTS).map(([k, path]) => run(() => qcGet(`/carriers/${dot}/${path}`, qcFetch))
    .then((body) => { qc[k] = asList(body); }, (err) => { qc.partErrors[k] = errorText(err); })));
  return qc;
}

/** Fetch every source for one USDOT number. Returns { [key]: { ok, rows, asOf } | { ok: false, error } , qcmobile }. */
async function fetchSources(dot, { censusResult = null } = {}) {
  const started = Date.now();
  const local = semaphore(PER_PROFILE);
  const run = (fn) => local(() => processLimit(async () => {
    if (Date.now() - started > BUILD_BUDGET_MS) throw new Error('Timed out');
    return fn();
  }));
  const out = {};
  const settle = (key, p) => p.then((v) => { out[key] = { ok: true, ...v }; }, (err) => { out[key] = { ok: false, error: errorText(err) }; });
  const tasks = [];
  if (censusResult) out.census = { ok: true, ...censusResult };
  else tasks.push(settle('census', run(() => census(`dot_number='${dot}'`))));
  const webKey = await getSetting('fmcsa.webKey');
  // Queue order = priority: authority and insurance first, history last.
  for (const key of ['motus', 'licensing']) tasks.push(settle(key, run(() => socrata(SOURCES.find((s) => s.key === key).dataset, QUERIES[key](dot)))));
  if (webKey) tasks.push(qcAll(dot, run).then((qc) => { out.qcmobile = qc; }));
  else out.qcmobile = { ok: false, skipped: true, error: 'Not set up (needs the FMCSA web key)' };
  for (const key of ['motusInsurance', 'insurance', 'motusAuthorityHistory', 'authorityHistory', 'motusInsuranceHistory', 'insuranceHistory']) {
    tasks.push(settle(key, run(() => socrata(SOURCES.find((s) => s.key === key).dataset, QUERIES[key](dot)))));
  }
  await Promise.all(tasks);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------------------------------------------

const str = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};
const up = (v) => String(v ?? '').trim().toUpperCase();
const yn = (v) => (up(v) === 'Y' ? true : up(v) === 'N' ? false : null);
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim();
  if (!s || !/\d/.test(s)) return null;
  const n = Number(s.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const int = (v) => {
  const n = num(v);
  return n == null ? null : Math.round(n);
};
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
/** Thousands of dollars (legacy L&I, QCMobile) to dollars; 0 = nothing on file. */
const kDollars = (v) => {
  const n = num(v);
  return n == null ? null : Math.round(n * 1000);
};
/** Dollars (Motus). */
const dollars = (v) => {
  const n = num(v);
  return n == null ? null : Math.round(n);
};
const positive = (n) => (n != null && n > 0 ? n : null);
const ACRONYMS = /\b(fmcsa|boc-3|bipd|mcs-150|usdot|ctfr|rp-06|eta|llc)\b/g;
/** Sentence case for FMCSA's text ("AUTHORIZED FOR HIRE" -> "Authorized for hire"), keeping its acronyms. */
const sentence = (v) => {
  const s = str(v);
  if (!s) return null;
  const lower = s.toLowerCase().replace(ACRONYMS, (m) => m.toUpperCase()).replace(/\bmotus\b/g, 'Motus');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
};
/** FMCSA dates: YYYYMMDD (census, Motus), MM/DD/YYYY (legacy L&I), ISO (QCMobile). Returns 'YYYY-MM-DD' or null. */
export function day(v) {
  const s = String(v ?? '').trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  let y; let mo; let d;
  if (m) [, y, mo, d] = m;
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s))) [, mo, d, y] = m;
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) [, y, mo, d] = m;
  else return null;
  const yy = Number(y); const mm = Number(mo); const dd = Number(d);
  if (yy < 1900 || yy > 2100 || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
const DAY_MS = 86_400_000;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
const monthsBetween = (a, now) => {
  const x = new Date(`${a}T00:00:00Z`);
  let months = (now.getUTCFullYear() - x.getUTCFullYear()) * 12 + (now.getUTCMonth() - x.getUTCMonth());
  if (now.getUTCDate() < x.getUTCDate()) months -= 1;
  return Math.max(0, months);
};
/** "MC647991", "MC0647991" or a bare number -> { prefix, number, docket }. */
const docketOf = (v, prefix = 'MC') => {
  const s = up(v).replace(/[\s-]/g, '');
  const m = /^([A-Z]{2})0*(\d+)$/.exec(s);
  if (m) return { prefix: m[1], number: m[2], docket: `${m[1]}${m[2]}` };
  const n = normMc(s);
  return n ? { prefix, number: n, docket: `${prefix}${n}` } : null;
};
const addressOf = (street, city, state, zip, country) => {
  const a = { street: str(street), city: str(city), state: str(state), zip: str(zip), country: str(country) };
  return a.street || a.city || a.state || a.zip ? a : null;
};
const sameAddress = (a, b) => !!a && !!b && [a.street, a.city, a.state].map(up).join('|') === [b.street, b.city, b.state].map(up).join('|');
const STATUS_RANK = { active: 0, pending: 1, inactive: 2, withdrawn: 3, none: 4 };
/** Authority kind from an authority type text. */
const kindOf = (t) => (/broker/i.test(t || '') ? 'broker' : /forwarder/i.test(t || '') ? 'forwarder' : 'carrier');
const cleanReason = (v) => str(String(v ?? '').replace(/\s*\bby\s+\S+@\S+/gi, '').replace(/\S+@\S+/g, '').replace(/\s+/g, ' '));

const USDOT_STATUS = { A: 'active', I: 'inactive', P: 'pending' };
const DOCKET_STATUS = { A: 'active', I: 'inactive', P: 'pending' };
const OPERATION = { A: 'Interstate', B: 'Intrastate hazmat', C: 'Intrastate non-hazmat' };
const ENTITY = { C: 'Carrier', S: 'Shipper', B: 'Broker', R: 'Registrant', F: 'Freight forwarder', I: 'Intermodal equipment provider', T: 'Cargo tank' };
const RATING = { S: 'Satisfactory', C: 'Conditional', U: 'Unsatisfactory' };
// Census data dictionary (MCMIS Company Census, rev 8), latest review type.
const REVIEW = {
  C: 'Compliance review', H: 'Shipper review', N: 'Non-ratable review', A: 'Safety audit', S: 'Safety review', E: 'Educational contact',
  U: 'Historical audit record', K: 'Automatic safety assessment review', F: 'Cargo tank facility review', G: 'Compliance and cargo tank review',
  I: 'Carrier inactivated', J: 'Compliance and security contact review',
};
const INS_CATEGORY_BY_TYPE = { 1: 'bipd', 2: 'cargo', 3: 'bond', 4: 'trust' };
const INS_LABEL = { bipd: 'BIPD', cargo: 'Cargo', bond: 'Surety bond', trust: 'Trust fund' };
const INS_ORDER = { bipd: 0, cargo: 1, bond: 2, trust: 3, other: 4 };
const insCategoryByForm = (form) => {
  const f = up(form).replace(/^BMC-?/, '');
  if (/^(91X?|82)$/.test(f)) return 'bipd';
  if (/^(34|83)$/.test(f)) return 'cargo';
  if (f === '84') return 'bond';
  if (f === '85') return 'trust';
  return null;
};
const insCategoryByText = (t) => {
  const s = up(t);
  if (s.startsWith('BIPD') || s.startsWith('BI&PD')) return 'bipd';
  if (s.startsWith('CARGO')) return 'cargo';
  if (s.startsWith('SURETY') || s.startsWith('BOND')) return 'bond';
  if (s.startsWith('TRUST')) return 'trust';
  return null;
};
const CLASS_LABEL = { P: 'primary', E: 'excess', 1: 'full security', 2: 'full security' };
/** "BIPD (primary)" from a legacy description like "BIPD/Primary" or a Motus class code. */
const insTypeLabel = (category, classCode, desc) => {
  const base = INS_LABEL[category] || sentence(desc) || 'Insurance';
  let cls = CLASS_LABEL[up(classCode)] || null;
  const m = /\/\s*(primary|excess|full)/i.exec(String(desc || ''));
  if (!cls && m) cls = m[1].toLowerCase() === 'full' ? 'full security' : m[1].toLowerCase();
  return category === 'bipd' && cls ? `${base} (${cls})` : base;
};
const REASON = { CANCEL: 'Cancelled', CANCELLED: 'Cancelled', 'TERM/CANCL': 'Cancelled', 'TERM/REPL': 'Replaced', REPLACED: 'Replaced', 'NAME CHANGE': 'Name change', NC: 'Name change', TRANSFERRED: 'Transferred', TR: 'Transferred' };
const reasonLabel = (v) => REASON[up(v)] || sentence(v);
const policyKey = (p) => up(p).replace(/[^A-Z0-9]/g, '');

// ---------------------------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------------------------

function censusDockets(c) {
  const out = [];
  for (const i of [1, 2, 3]) {
    const prefix = up(c[`docket${i}prefix`]);
    const number = normMc(c[`docket${i}`]);
    if (prefix && number) out.push({ prefix, number, docket: `${prefix}${number}`, status: DOCKET_STATUS[up(c[`docket${i}_status_code`])] || null, source: 'census' });
  }
  return out;
}

/** Motus first (current system), then legacy rows: business phone and addresses on file with FMCSA licensing. */
function licensingContact(motusRows, licRows) {
  const row = (motusRows || [])[0] || (licRows || [])[0];
  if (!row) return null;
  const motus = !!(motusRows || [])[0];
  const undeliverable = motus
    ? (yn(row.bus_undeliverable_mail) === false || yn(row.mail_undeliverable_mail) === false ? true : yn(row.bus_undeliverable_mail) === true ? false : null)
    : (yn(row.undeliverable_mail) === false ? true : yn(row.undeliverable_mail) === true ? false : null);
  return {
    legalName: str(row.legal_name),
    dbaName: str(row.dba_name),
    phone: normPhone(row.bus_telno),
    businessAddress: addressOf(row.bus_street_po, row.bus_city, row.bus_state_code, row.bus_zip_code, row.bus_ctry_code),
    mailingAddress: addressOf(row.mail_street_po, row.mail_city, row.mail_state_code, row.mail_zip_code, row.mail_ctry_code),
    undeliverable,
    source: motus ? 'motus' : 'legacy',
  };
}

/** Insurance policies on file (Motus first, legacy policies the Motus list does not have). */
function insuranceOnFile(motusRows, legacyRows, today) {
  if (!motusRows && !legacyRows) return { onFile: null, ended: [] };
  const seen = new Set();
  const onFile = [];
  const ended = [];
  for (const r of motusRows || []) {
    const category = INS_CATEGORY_BY_TYPE[up(r.ins_type_code)] || insCategoryByForm(r.ins_form_code) || 'other';
    const p = {
      category, type: insTypeLabel(category, r.ins_class_code), form: str(r.ins_form_code), company: str(r.insurance_company_name), policy: str(r.policy_no),
      coverage: positive(dollars(r.max_cov_amount)), underlying: positive(dollars(r.underl_lim_amount)), effective: day(r.effective_date), cancelEffective: null,
      postedAt: day(r.trans_date), docket: docketOf(r.docket_number)?.docket || null, source: 'motus',
    };
    const key = `${category}|${policyKey(p.policy)}|${p.effective}`;
    if (seen.has(key)) continue;
    seen.add(key);
    onFile.push(p);
  }
  for (const r of legacyRows || []) {
    const category = insCategoryByForm(r.ins_form_code) || insCategoryByText(r.mod_col_1) || 'other';
    const p = {
      category, type: insTypeLabel(category, null, r.mod_col_1), form: str(r.ins_form_code), company: str(r.name_company), policy: str(r.policy_no),
      coverage: positive(kDollars(r.max_cov_amount)), underlying: positive(kDollars(r.underl_lim_amount)), effective: day(r.effective_date), cancelEffective: day(r.cancl_effective_date),
      postedAt: day(r.trans_date), docket: docketOf(r.docket_number)?.docket || null, source: 'legacy',
    };
    const key = `${category}|${policyKey(p.policy)}|${p.effective}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The legacy list stopped updating: a policy whose cancellation already took effect is history, not on file.
    if (p.cancelEffective && p.cancelEffective < today) ended.push({ ...p, reason: 'Cancelled' });
    else onFile.push(p);
  }
  onFile.sort((a, b) => INS_ORDER[a.category] - INS_ORDER[b.category] || String(b.effective || '').localeCompare(String(a.effective || '')));
  return { onFile: onFile.slice(0, 20), ended };
}

function insuranceHistory(motusRows, legacyRows, ended) {
  if (!motusRows && !legacyRows) return null;
  const seen = new Set();
  const out = [];
  const add = (p) => {
    const key = `${p.category}|${policyKey(p.policy)}|${p.effective}|${p.cancelEffective}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  for (const r of motusRows || []) {
    const category = INS_CATEGORY_BY_TYPE[up(r.ins_type_code)] || insCategoryByForm(r.ins_form_code) || insCategoryByText(r.ins_type_desc) || 'other';
    add({
      category, type: insTypeLabel(category, r.ins_class_code, r.ins_type_desc), company: str(r.insurance_company_name), policy: str(r.policy_no),
      coverage: positive(dollars(r.max_cov_amount)), effective: day(r.effective_date), cancelEffective: day(r.cancl_effective_date),
      reason: reasonLabel(r.filing_status_reason), docket: docketOf(r.docket_number)?.docket || null, source: 'motus',
    });
  }
  for (const r of legacyRows || []) {
    // Legacy InsHist: mod_col_1 = cancellation method, mod_col_3 = insurance type, mod_col_5 = max coverage (thousands).
    const category = insCategoryByForm(r.ins_form_code) || insCategoryByText(r.mod_col_3) || 'other';
    add({
      category, type: insTypeLabel(category, r.ins_class_code, r.mod_col_3), company: str(r.name_company), policy: str(r.policy_no),
      coverage: positive(kDollars(r.mod_col_5)), effective: day(r.effective_date), cancelEffective: day(r.cancl_effective_date),
      reason: reasonLabel(r.mod_col_1) || reasonLabel(r.cancl_method), docket: docketOf(r.docket_number)?.docket || null, source: 'legacy',
    });
  }
  for (const p of ended) add({ category: p.category, type: p.type, company: p.company, policy: p.policy, coverage: p.coverage, effective: p.effective, cancelEffective: p.cancelEffective, reason: p.reason, docket: p.docket, source: p.source });
  out.sort((a, b) => String(b.cancelEffective || '').localeCompare(String(a.cancelEffective || '')) || String(b.effective || '').localeCompare(String(a.effective || '')));
  return out;
}

/** Gaps in primary BIPD coverage, from policies on file and history: [{ from, to, days }], newest first. */
function bipdLapses(onFile, history) {
  const spans = [...(onFile || []), ...(history || [])]
    .filter((p) => p.category === 'bipd' && !/excess/i.test(p.type) && p.effective)
    .map((p) => [p.effective, p.cancelEffective && p.cancelEffective >= p.effective ? p.cancelEffective : '9999-12-31'])
    .sort((a, b) => a[0].localeCompare(b[0]));
  const lapses = [];
  let end = null;
  for (const [s, e] of spans) {
    if (end && s > end && daysBetween(end, s) > 1) lapses.push({ from: end, to: s, days: daysBetween(end, s) });
    if (!end || e > end) end = e;
  }
  return lapses.reverse().slice(0, 10);
}

/**
 * Operating authority. Per docket, a Motus row supersedes the legacy row (the legacy dataset stopped updating).
 *   active   = an active carrier authority with BIPD insurance on file and no revocation pending
 *   pending  = an authority application is pending and none is active
 *   inactive = everything else the sources answered, including "no authority on file"
 *   unknown  = the sources needed to tell did not answer
 * When only legacy rows describe the carrier and QCMobile answered, QCMobile's live authority decides.
 */
function authoritySection({ motus, licensing, motusInsurance, qc, history, now }) {
  const today = now.toISOString().slice(0, 10);
  const motusRows = motus.ok ? motus.rows : null;
  const licRows = licensing.ok ? licensing.rows : null;
  const motusDockets = new Set((motusRows || []).map((r) => docketOf(r.docket_number)?.docket).filter(Boolean));
  const types = [];
  const dockets = new Map(); // docket -> carrier-authority summary
  const summary = (docket, source) => {
    if (!dockets.has(docket)) dockets.set(docket, { docket, source, active: false, pending: false, bipdOnFile: null, revocationPending: null, required: null, filed: null });
    return dockets.get(docket);
  };
  const motusBipdPolicy = (docket) => (motusInsurance.ok ? motusInsurance.rows : []).some((r) => {
    const cat = INS_CATEGORY_BY_TYPE[up(r.ins_type_code)] || insCategoryByForm(r.ins_form_code);
    const eff = day(r.effective_date);
    return cat === 'bipd' && docketOf(r.docket_number)?.docket === docket && (!eff || eff <= today);
  });
  for (const r of motusRows || []) {
    const d = docketOf(r.docket_number);
    if (!d) continue;
    const status = String(r.op_auth_status || '').trim().toLowerCase() || null;
    const kind = kindOf(r.op_auth_type);
    types.push({ docket: d.docket, type: sentence(r.op_auth_type), kind, status, source: 'motus' });
    if (kind !== 'carrier') continue;
    const s = summary(d.docket, 'motus');
    const bipd = dollars(r.bipd_file);
    const onFile = (bipd != null && bipd > 0) || motusBipdPolicy(d.docket);
    if (status === 'active') { s.active = true; s.bipdOnFile = onFile || s.bipdOnFile === true; }
    else if (s.bipdOnFile == null) s.bipdOnFile = onFile;
    if (status === 'pending') s.pending = true;
    s.required = s.required || { bipd: positive(dollars(r.min_cov_amount)), cargo: yn(r.cargo_req), bond: yn(r.bond_req) };
    s.filed = s.filed || { bipd, cargo: yn(r.cargo_file), bond: yn(r.bond_file) };
  }
  for (const r of licRows || []) {
    const d = docketOf(r.docket_number);
    if (!d || motusDockets.has(d.docket)) continue;
    const scope = [yn(r.property_chk) && 'property', yn(r.passenger_chk) && 'passengers', yn(r.hhg_chk) && 'household goods'].filter(Boolean).join(', ') || null;
    const entry = (label, stat, pend, kind) => {
      const st = up(stat) === 'A' ? 'active' : yn(pend) ? 'pending' : up(stat) === 'I' ? 'inactive' : null;
      if (st) types.push({ docket: d.docket, type: scope && kind === 'carrier' ? `${label} (${scope})` : label, kind, status: st, source: 'legacy' });
      return st;
    };
    // Freight forwarder dockets (FF) hold forwarder authority in the common / contract columns: not carrier authority.
    const ownKind = d.prefix === 'FF' ? 'forwarder' : 'carrier';
    const common = entry(ownKind === 'carrier' ? 'Common carrier' : 'Freight forwarder', r.common_stat, r.common_app_pend, ownKind);
    const contract = entry(ownKind === 'carrier' ? 'Contract carrier' : 'Freight forwarder (contract)', r.contract_stat, r.contract_app_pend, ownKind);
    entry('Broker', r.broker_stat, r.broker_app_pend, 'broker');
    if (ownKind !== 'carrier' || (!common && !contract)) continue;
    const s = summary(d.docket, 'legacy');
    const bipd = kDollars(r.bipd_file);
    s.active = s.active || common === 'active' || contract === 'active';
    s.pending = s.pending || common === 'pending' || contract === 'pending';
    s.bipdOnFile = (bipd != null && bipd > 0) || motusBipdPolicy(d.docket);
    s.revocationPending = yn(r.common_rev_pend) === true || yn(r.contract_rev_pend) === true;
    s.required = { bipd: positive(kDollars(r.min_cov_amount)), cargo: yn(r.cargo_req), bond: yn(r.bond_req) };
    s.filed = { bipd, cargo: yn(r.cargo_file), bond: yn(r.bond_file) };
  }
  types.sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9));

  const list = [...dockets.values()];
  const pick = list.find((s) => s.active && s.bipdOnFile === true && s.revocationPending !== true)
    || list.find((s) => s.active) || list.find((s) => s.pending) || list[0] || null;
  let status;
  let label;
  let code;
  if (pick?.active && pick.bipdOnFile === true && pick.revocationPending !== true) { status = 'active'; code = 'active'; label = 'Authority active, insurance on file'; }
  else if (pick?.active && pick.revocationPending) { status = 'inactive'; code = 'revocation_pending'; label = 'Revocation pending'; }
  else if (pick?.active) { status = 'inactive'; code = 'no_insurance'; label = 'Authority active but no liability insurance on file'; }
  else if (list.some((s) => s.pending)) { status = 'pending'; code = 'pending'; label = 'Authority pending'; }
  else if (list.length) { status = 'inactive'; code = 'inactive'; label = 'Authority inactive'; }
  else if (motusRows && licRows) { status = 'inactive'; code = 'none'; label = 'No for-hire operating authority on file'; }
  else { status = 'unknown'; code = 'unknown'; label = 'Authority could not be checked right now'; }
  let basis = pick ? pick.source : motusRows && licRows ? 'motus+legacy' : null;
  let qcOverride = null;
  // Only legacy rows (frozen) or nothing answered: QCMobile's live authority, when it answered, decides.
  const qcAuth = (qc?.authority || []).map((x) => x.carrierAuthority || x).filter(Boolean);
  if (qc?.carrier && qcAuth.length && (basis === 'legacy' || status === 'unknown')) {
    const st = qcAuth.flatMap((a) => [up(a.commonAuthorityStatus), up(a.contractAuthorityStatus)]);
    const bipd = kDollars(qc.carrier.bipdInsuranceOnFile);
    status = st.includes('A') ? (bipd != null && bipd > 0 ? 'active' : 'inactive') : st.includes('P') ? 'pending' : 'inactive';
    basis = 'qcmobile';
    code = status === 'active' ? 'active' : status === 'pending' ? 'pending' : st.includes('A') ? 'no_insurance' : 'inactive';
    label = { active: 'Authority active, insurance on file', pending: 'Authority pending', no_insurance: 'Authority active but no liability insurance on file', inactive: 'Authority inactive' }[code];
    qcOverride = { insuranceOnFile: bipd == null ? null : bipd > 0 };
  }

  // History, age and revocations (carrier authorities only).
  const carrierEvents = (history.events || []).filter((e) => e.kind === 'carrier');
  const grants = carrierEvents.filter((e) => e.grant).map((e) => e.date).filter(Boolean).sort();
  const since = grants[0] || null;
  const revoked = carrierEvents.filter((e) => e.revoked).map((e) => e.date).filter(Boolean).sort();
  const ageDays = since ? Math.max(0, daysBetween(since, today)) : null;
  return {
    available: !!(motusRows || licRows || (qc?.carrier && qcAuth.length)),
    partial: !motusRows || !licRows,
    status, code, label, basis,
    legacyAsOf: basis === 'legacy' ? LEGACY_AS_OF : null,
    docket: pick?.docket || null,
    types,
    insuranceOnFile: qcOverride ? qcOverride.insuranceOnFile : pick ? pick.bipdOnFile : null,
    revocationPending: qcOverride ? null : pick ? pick.revocationPending : null,
    pending: list.some((s) => s.pending),
    required: pick?.required || null,
    filed: pick?.filed || null,
    since,
    ageDays,
    ageYears: ageDays == null ? null : round1(ageDays / 365.25),
    history: history.events ? history.events.slice(0, 60).map(({ grant, revoked: r, ...e }) => e) : null,
    historyPartial: history.partial,
    revokedBefore: history.events ? revoked.length > 0 : null,
    lastRevokedAt: revoked.at(-1) || null,
    revocations: history.events ? revoked.length : null,
  };
}

const REVOKED_ACTIONS = /^(revoked|safety revocation)$/i;
function authorityHistory(motusHist, legacyHist) {
  if (!motusHist.ok && !legacyHist.ok) return { events: null, partial: true };
  const events = [];
  for (const r of motusHist.ok ? motusHist.rows : []) {
    const status = String(r.op_auth_status || '').trim().toLowerCase() || null;
    const reason = cleanReason(r.reason);
    const kind = kindOf(r.op_auth_type);
    events.push({
      date: day(r.status_change_date), docket: docketOf(r.docket_number)?.docket || null, type: sentence(r.op_auth_type), kind, status,
      action: reason ? sentence(reason) : sentence(status), source: 'motus',
      grant: status === 'active' && /grant/i.test(reason || ''),
      revoked: /\brevoked\b/i.test(reason || '') && !/discontinued/i.test(reason || ''),
    });
  }
  for (const r of legacyHist.ok ? legacyHist.rows : []) {
    const type = sentence(r.mod_col_1);
    const kind = kindOf(r.mod_col_1);
    const docket = docketOf(r.docket_number)?.docket || null;
    const orig = str(r.original_action_desc);
    if (orig) {
      events.push({
        date: day(r.orig_served_date), docket, type, kind, status: null, action: sentence(orig), source: 'legacy',
        grant: /^granted$/i.test(orig), revoked: false,
      });
    }
    const disp = str(r.disp_action_desc);
    if (disp) {
      events.push({
        date: day(r.disp_served_date) || day(r.disp_decided_date), docket, type, kind, status: null, action: sentence(disp), source: 'legacy',
        grant: false, revoked: REVOKED_ACTIONS.test(disp),
      });
    }
  }
  events.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return { events, partial: !motusHist.ok || !legacyHist.ok };
}

const ownership = (r, key) => ({ owned: int(r[`own${key}`]) ?? 0, termLeased: int(r[`trm${key}`]) ?? 0, tripLeased: int(r[`trp${key}`]) ?? 0 });
const sumOwnership = (r, keys) => keys.map((k) => ownership(r, k)).reduce((a, b) => ({ owned: a.owned + b.owned, termLeased: a.termLeased + b.termLeased, tripLeased: a.tripLeased + b.tripLeased }));

function equipmentSection(c) {
  const rows = [
    { kind: 'Trucks', ...ownership(c, 'truck') },
    { kind: 'Tractors', ...ownership(c, 'tract') },
    { kind: 'Trailers', ...ownership(c, 'trail') },
  ];
  const passenger = [
    { kind: 'Motor coaches', ...ownership(c, 'coach') },
    { kind: 'School buses', ...sumOwnership(c, ['school_1_8', 'school_9_15', 'school_16']) },
    { kind: 'Buses (16+ seats)', ...ownership(c, 'bus_16') },
    { kind: 'Vans', ...sumOwnership(c, ['van_1_8', 'van_9_15']) },
    { kind: 'Limousines', ...sumOwnership(c, ['limo_1_8', 'limo_9_15', 'limo_16']) },
  ].filter((r) => r.owned || r.termLeased || r.tripLeased);
  return { available: true, rows: [...rows, ...passenger] };
}

function basicsOf(list) {
  return list.map((x) => x?.basic || x).filter(Boolean).map((b) => {
    const exceeded = yn(b.exceededFMCSAInterventionThreshold) === true;
    const roadside = yn(b.onRoadPerformanceThresholdViolationIndicator) === true;
    const serious = yn(b.seriousViolationFromInvestigationPast12MonthIndicator) === true;
    return {
      name: str(b.basicsType?.basicsShortDesc) || str(b.basicsType?.basicsCode) || 'BASIC',
      percentile: num(b.basicsPercentile),
      threshold: num(b.basicsViolationThreshold),
      measure: num(b.measureValue),
      inspectionsWithViolations: int(b.totalInspectionWithViolation),
      violations: int(b.totalViolation),
      alert: exceeded || roadside || serious,
      seriousViolation: serious,
      runDate: day(b.basicsRunDate),
    };
  });
}

function inspection(c, prefix) {
  const inspections = int(c[`${prefix}Insp`]);
  const oos = int(c[`${prefix}OosInsp`]);
  const rate = num(c[`${prefix}OosRate`]);
  return {
    inspections,
    oos,
    oosRate: rate != null ? round1(rate) : inspections ? round1((oos || 0) / inspections * 100) : null,
    nationalAvg: round1(num(c[`${prefix}OosRateNationalAverage`])),
  };
}

function safetySection(c, qc, censusOk) {
  const q = qc?.carrier || null;
  const code = up(q?.safetyRating) || up(c?.safety_rating);
  const reviewCode = up(c?.review_type) || up(q?.reviewType);
  const reviewDate = day(c?.review_date) || day(q?.reviewDate);
  return {
    available: censusOk || !!q,
    live: !!q,
    liveStatus: q ? 'ok' : qc?.skipped ? 'not_configured' : qc?.ok ? 'not_found' : 'failed',
    rating: RATING[code] || null,
    ratingCode: code || null,
    ratingDate: day(q?.safetyRatingDate) || day(c?.safety_rating_date),
    review: reviewCode || reviewDate ? { type: REVIEW[reviewCode] || (reviewCode ? `Review (${reviewCode})` : null), code: reviewCode || null, date: reviewDate } : null,
    recordableCrashRate: c && reviewCode ? num(c.recordable_crash_rate) : null,
    allowedToOperate: q ? yn(q.allowedToOperate) : null,
    oosDate: q ? day(q.oosDate) : null,
    crashes: q ? { fatal: int(q.fatalCrash), injury: int(q.injCrash), tow: int(q.towawayCrash), total: int(q.crashTotal) } : null,
    inspections: q ? { driver: inspection(q, 'driver'), vehicle: inspection(q, 'vehicle'), hazmat: inspection(q, 'hazmat'), nationalAvgYear: str(q.oosRateNationalAverageYear) } : null,
    basics: q && qc.basics ? basicsOf(qc.basics) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------------------------

const fmt = (d) => {
  const x = new Date(`${d}T00:00:00Z`);
  return Number.isNaN(x.getTime()) ? d : x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

function flagsFor(p, { now }) {
  const out = [];
  const add = (level, code, text) => out.push({ level, code, text });
  const a = p.authority;
  const today = now.toISOString().slice(0, 10);
  if (p.identity.usdotStatus === 'inactive') add('red', 'usdot_inactive', 'USDOT number inactive');
  if (a.available) {
    if (a.code === 'inactive') add('red', 'authority_inactive', 'Operating authority inactive');
    else if (a.code === 'none') add('red', 'no_authority', 'No for-hire operating authority on file');
    else if (a.code === 'revocation_pending') add('red', 'revocation_pending', 'Authority revocation pending');
    else if (a.code === 'pending') add('amber', 'authority_pending', 'Authority pending');
    else if (a.code === 'unknown') add('amber', 'authority_unknown', 'Authority could not be checked right now');
    // Expected while an application is pending (insurance is filed before the grant), so amber then.
    if (a.insuranceOnFile === false && a.code !== 'none') add(a.code === 'pending' ? 'amber' : 'red', 'no_insurance', 'No liability (BIPD) insurance on file');
  } else {
    add('amber', 'authority_unknown', 'Authority could not be checked right now');
  }
  if (p.safety.allowedToOperate === false) add('red', 'not_allowed', 'Not allowed to operate (FMCSA)');
  if (p.safety.oosDate) add('red', 'out_of_service', `Out of service since ${fmt(p.safety.oosDate)}`);
  if (p.safety.rating === 'Unsatisfactory') add('red', 'rating_unsatisfactory', 'Unsatisfactory safety rating');
  if (p.safety.rating === 'Conditional') add('amber', 'rating_conditional', 'Conditional safety rating');
  if (p.compliance.outdated) add('amber', 'mcs150_outdated', `MCS-150 not updated in ${p.compliance.mcs150AgeMonths} months`);
  if (p.contact.physicalUndeliverable || p.contact.mailingUndeliverableSince || p.contact.licensing?.undeliverable) add('amber', 'undeliverable', 'Address marked undeliverable by FMCSA');
  for (const [k, labelText] of [['driver', 'Driver'], ['vehicle', 'Vehicle'], ['hazmat', 'Hazmat']]) {
    const i = p.safety.inspections?.[k];
    if (i && i.inspections >= 3 && i.oosRate != null && i.nationalAvg != null && i.oosRate > i.nationalAvg) {
      add('amber', `high_oos_${k}`, `${labelText} out-of-service rate ${i.oosRate}% vs ${i.nationalAvg}% national average`);
    }
  }
  const alerts = (p.safety.basics || []).filter((b) => b.alert).map((b) => b.name);
  if (alerts.length) add('amber', 'basic_alert', `BASIC alert: ${alerts.join(', ')}`);
  if (a.since && a.ageDays != null && a.ageDays < 90) add('amber', 'new_authority', `New authority: granted ${a.ageDays} days ago`);
  // Revocations decades ago say little about a carrier today: flag the last 10 years (the section lists them all).
  if (a.revokedBefore && a.lastRevokedAt && daysBetween(a.lastRevokedAt, today) <= 3653) add('amber', 'revoked_before', `Authority revoked before (${fmt(a.lastRevokedAt)})`);
  if (p.compliance.priorRevoke?.flag) add('amber', 'prior_usdot_revoked', `Prior USDOT number revoked${p.compliance.priorRevoke.dot ? ` (USDOT ${p.compliance.priorRevoke.dot})` : ''}`);
  const cancelling = (p.insurance.onFile || []).find((x) => x.category === 'bipd' && x.cancelEffective && x.cancelEffective >= today && daysBetween(today, x.cancelEffective) <= 45);
  if (cancelling) add('amber', 'insurance_cancelling', `BIPD policy cancels ${fmt(cancelling.cancelEffective)}`);
  const recentLapse = (p.insurance.lapses || []).find((l) => daysBetween(l.to, today) <= 365);
  if (recentLapse) add('amber', 'insurance_lapse', `Insurance lapse of ${recentLapse.days} days in the last year`);
  if (a.code === 'active') add('green', 'authority_active', 'Authority active, insurance on file');
  if (a.code === 'active' && a.ageYears != null && a.ageYears >= 2) add('green', 'authority_age', `Authority for ${Math.floor(a.ageYears)} years`);
  if (p.safety.rating === 'Satisfactory') add('green', 'rating_satisfactory', 'Satisfactory safety rating');
  // QCMobile's allowedToOperate only says the USDOT number is not out of service; it is green only alongside active
  // for-hire authority, so it never reads as "good to haul" for a carrier whose MC authority is inactive.
  if (p.safety.allowedToOperate === true && !p.safety.oosDate && p.authority?.status === 'active') add('green', 'allowed', 'Allowed to operate');
  const rank = { red: 0, amber: 1, green: 2 };
  return out.sort((x, y) => rank[x.level] - rank[y.level]);
}

// ---------------------------------------------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------------------------------------------

const SKIP = { ok: false, error: 'Not requested' };

/**
 * Normalized profile from raw source answers (pure; exported for tests). `src[key]` is { ok, rows, asOf } or
 * { ok: false, error }; `src.qcmobile` is the QCMobile bundle. Returns null when no source identifies the carrier.
 */
export function assembleProfile(src, { dot, mc = null, now = new Date() } = {}) {
  const s = (k) => src[k] || SKIP;
  const today = now.toISOString().slice(0, 10);
  const censusOk = !!s('census').ok;
  const rows = censusOk ? s('census').rows.filter((r) => normDot(r.dot_number) === dot) : [];
  const c = bestCensusRow(rows);
  const qc = src.qcmobile || { ok: false, skipped: true };
  const q = qc.carrier || null;
  const motusRows = s('motus').ok ? s('motus').rows : null;
  const licRows = s('licensing').ok ? s('licensing').rows : null;
  const lic = licensingContact(motusRows, licRows);
  if (!c && !lic && !q) return null;

  const dockets = c ? censusDockets(c) : [];
  const addDocket = (d, source) => { if (d && !dockets.some((x) => x.docket === d.docket)) dockets.push({ ...d, status: null, source }); };
  for (const r of motusRows || []) addDocket(docketOf(r.docket_number), 'motus');
  for (const r of licRows || []) addDocket(docketOf(r.docket_number), 'legacy');
  for (const r of qc.dockets || []) addDocket(docketOf(`${r.prefix || 'MC'}${r.docketNumber ?? ''}`), 'qcmobile');
  const primaryMc = dockets.find((d) => d.prefix === 'MC')?.number || normMc(mc);

  const identity = c ? {
    available: true,
    legalName: str(c.legal_name), dbaName: str(c.dba_name),
    usdotStatus: USDOT_STATUS[up(c.status_code)] || null,
    registeredAt: day(c.add_date),
    businessType: sentence(c.business_org_desc),
    officers: [c.company_officer_1, c.company_officer_2].map(str).filter(Boolean),
    dunsNumber: str(c.dun_bradstreet_no),
    dockets,
    source: 'census',
  } : {
    available: true, partial: true,
    legalName: lic?.legalName || str(q?.legalName), dbaName: lic?.dbaName || str(q?.dbaName),
    usdotStatus: q ? USDOT_STATUS[up(q.statusCode)] || null : null,
    registeredAt: null, businessType: null, officers: [], dunsNumber: null, dockets,
    source: lic ? lic.source : 'qcmobile',
  };

  const contact = c ? {
    available: true,
    phone: normPhone(c.phone), cellPhone: normPhone(c.cell_phone), fax: normPhone(c.fax),
    email: str(c.email_address)?.toLowerCase() ?? null,
    physicalAddress: addressOf(c.phy_street, c.phy_city, c.phy_state, c.phy_zip, c.phy_country),
    mailingAddress: addressOf(c.carrier_mailing_street, c.carrier_mailing_city, c.carrier_mailing_state, c.carrier_mailing_zip, c.carrier_mailing_country),
    physicalUndeliverable: up(c.undeliv_phy) === 'U',
    mailingUndeliverableSince: day(c.carrier_mailing_und_date),
    licensing: lic,
  } : lic ? {
    available: true, partial: true,
    phone: lic.phone, cellPhone: null, fax: null, email: null,
    physicalAddress: lic.businessAddress, mailingAddress: lic.mailingAddress,
    physicalUndeliverable: null, mailingUndeliverableSince: null, licensing: lic,
  } : { available: false };
  if (contact.available && contact.licensing) contact.licensing.sameAsCensus = sameAddress(contact.physicalAddress, lic.businessAddress);

  const history = authorityHistory(s('motusAuthorityHistory'), s('authorityHistory'));
  const authority = authoritySection({ motus: s('motus'), licensing: s('licensing'), motusInsurance: s('motusInsurance'), qc, history, now });

  const motusIns = s('motusInsurance').ok ? s('motusInsurance').rows : null;
  const legacyIns = s('insurance').ok ? s('insurance').rows : null;
  const { onFile, ended } = insuranceOnFile(motusIns, legacyIns, today);
  const insHist = insuranceHistory(s('motusInsuranceHistory').ok ? s('motusInsuranceHistory').rows : null, s('insuranceHistory').ok ? s('insuranceHistory').rows : null, ended);
  const qcRequired = q ? { bipd: positive(kDollars(q.bipdRequiredAmount)), cargo: yn(q.cargoInsuranceRequired), bond: yn(q.bondInsuranceRequired) } : null;
  const has = (v) => {
    const n = kDollars(v);
    return n == null ? null : n > 0;
  };
  const qcFiled = q ? { bipd: kDollars(q.bipdInsuranceOnFile), cargo: has(q.cargoInsuranceOnFile), bond: has(q.bondInsuranceOnFile) } : null;
  const insurance = {
    available: onFile != null || insHist != null || !!authority.required || !!qcRequired,
    partial: onFile == null || insHist == null || !motusIns || !legacyIns,
    onFile,
    required: authority.required || qcRequired,
    filed: authority.filed || qcFiled,
    history: insHist ? insHist.slice(0, 30) : null,
    historyCount: insHist ? insHist.length : null,
    lapses: insHist ? bipdLapses(onFile, insHist) : null,
    legacyAsOf: legacyIns || s('insuranceHistory').ok ? LEGACY_AS_OF : null,
  };

  const cargoLabels = c ? [
    ...Object.keys(CARGO_LABELS).filter((k) => up(c[k]) === 'X').map((k) => CARGO_LABELS[k]),
    ...(up(c.crgo_cargoothr) === 'X' ? [str(c.crgo_cargoothr_desc) ? `Other: ${sentence(c.crgo_cargoothr_desc)}` : 'Other'] : []),
  ] : null;
  const qcCargo = qc.cargo ? qc.cargo.map((x) => str(x.cargoClassDesc)).filter(Boolean) : null;
  const cargo = cargoLabels ?? qcCargo;

  const classes = new Map();
  for (const t of String(c?.classdef || '').split(';').map(sentence).filter(Boolean)) classes.set(t.toLowerCase(), t);
  for (const t of (qc.operations || []).map((x) => sentence(x.operationClassDesc)).filter(Boolean)) if (!classes.has(t.toLowerCase())) classes.set(t.toLowerCase(), t);
  const operation = c || q ? {
    available: true, partial: !c,
    carrierOperation: c ? OPERATION[up(c.carrier_operation)] || str(c.carrier_operation) : str(q?.carrierOperation?.carrierOperationDesc),
    classifications: [...classes.values()],
    entityTypes: c ? [...new Set(up(c.carship).replace(/[^A-Z]/g, '').split('').map((x) => ENTITY[x]).filter(Boolean))] : [],
    hazmat: c ? up(c.hm_ind) === 'Y' : null,
  } : { available: false };

  const fleet = c ? { available: true, powerUnits: int(c.power_units), trucks: int(c.truck_units), buses: int(c.bus_units) }
    : q ? { available: true, partial: true, powerUnits: int(q.totalPowerUnits), trucks: null, buses: null } : { available: false };
  const equipment = c ? equipmentSection(c) : { available: false };
  const drivers = c ? {
    available: true,
    total: int(c.total_drivers), cdl: int(c.total_cdl), interstate: int(c.driver_inter_total), intrastate: int(c.total_intrastate_drivers),
    avgLeasedPerMonth: int(c.avg_drivers_leased_per_month),
    interstateWithin100: int(c.interstate_within_100_miles), interstateBeyond100: int(c.interstate_beyond_100_miles),
    intrastateWithin100: int(c.intrastate_within_100_miles), intrastateBeyond100: int(c.intrastate_beyond_100_miles),
  } : q ? { available: true, partial: true, total: int(q.totalDrivers) } : { available: false };
  const mileage = c ? { available: true, miles: positive(int(c.mcs150_mileage)), year: int(c.mcs150_mileage_year) } : { available: false };

  const safety = safetySection(c, qc, !!c);
  const mcs150Date = c ? day(c.mcs150_date) : null;
  const ageMonths = mcs150Date ? monthsBetween(mcs150Date, now) : null;
  const compliance = c ? {
    available: true,
    mcs150Date,
    mcs150AgeMonths: ageMonths,
    outdated: ageMonths == null ? null : ageMonths > 24,
    priorRevoke: { flag: yn(c.prior_revoke_flag), dot: normDot(c.prior_revoke_dot_number) },
    region: str(c.phy_omc_region),
  } : { available: false };

  const fetchedAt = now.toISOString();
  const sources = SOURCES.map((def) => {
    const r = def.key === 'qcmobile' ? qc : s(def.key);
    const status = r.ok ? 'ok' : r.skipped ? 'skipped' : 'failed';
    return {
      key: def.key, name: def.name, dataset: def.dataset || null,
      url: def.dataset ? `https://data.transportation.gov/d/${def.dataset}` : null,
      ok: !!r.ok, status, error: r.ok ? null : r.error || null,
      asOf: !r.ok ? null : def.legacy ? LEGACY_AS_OF : r.asOf || fetchedAt,
      note: def.legacy ? 'No longer updated by FMCSA after May 14, 2026' : def.key === 'qcmobile' && r.ok && !r.found ? 'No record' : null,
    };
  });

  const profile = {
    v: PROFILE_VERSION, found: true, dot, mc: primaryMc || null, fetchedAt,
    complete: sources.every((x) => x.status !== 'failed') && !Object.keys(qc.partErrors || {}).length,
    identity, contact, authority, insurance, operation, fleet, equipment, drivers, mileage, cargo, safety, compliance,
    flags: [], sources,
    saferUrl: `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${dot}`,
  };
  profile.flags = flagsFor(profile, { now });
  return profile;
}

// ---------------------------------------------------------------------------------------------------------------
// Cache and entry point
// ---------------------------------------------------------------------------------------------------------------

const NOT_FOUND = Object.freeze({ notFound: true });
const cache = new Map(); // dot -> { at, ttl, value }
const inflight = new Map(); // dot -> Promise<profile>

export function clearProfileCache() {
  cache.clear();
  inflight.clear();
}
function remember(dot, value, ttl) {
  cache.delete(dot);
  while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(dot, { at: Date.now(), ttl, value });
}
/** Cached answer for a USDOT number without any network call: a profile, { notFound: true }, or null. */
export function peekProfile(dot) {
  const d = normDot(dot);
  const hit = d && cache.get(d);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) { cache.delete(d); return null; }
  return hit.value;
}

const notInCensus = (dot) => notFound(`No FMCSA census record for USDOT ${dot}`);

/**
 * Profile for a USDOT number (or an MC number, resolved through the census). Throws 404 when the census has no such
 * carrier, 502 when the census did not answer and no other source knows the number. `fresh` skips the cache.
 */
export async function buildProfile({ dot, mc } = {}, { fresh = false, now } = {}) {
  let d = normDot(dot);
  const m = normMc(mc);
  if (!d && !m) throw badRequest('Enter a USDOT number');
  if (d && d.length > 9) throw badRequest('Enter a valid USDOT number');
  let censusResult = null;
  if (!d) {
    let res;
    try {
      res = await census(`docket1prefix='MC' AND docket1='${m}'`, 10);
    } catch (err) {
      throw new HttpError(502, `FMCSA census is not available right now: ${errorText(err)}`);
    }
    const row = bestCensusRow(res.rows);
    if (!row || !normDot(row.dot_number)) throw notFound(`No FMCSA census record for MC ${m}`);
    d = normDot(row.dot_number);
    censusResult = { rows: [row], asOf: res.asOf };
  }
  if (!fresh) {
    const hit = peekProfile(d);
    if (hit === NOT_FOUND || hit?.notFound) throw notInCensus(d);
    if (hit) return hit;
  }
  if (inflight.has(d)) return inflight.get(d);
  const p = (async () => {
    const src = await fetchSources(d, { censusResult });
    const profile = assembleProfile(src, { dot: d, mc: m, now: now || new Date() });
    if (!profile) {
      // The census answered without this number and no licensing source knows it either.
      if (src.census.ok) {
        remember(d, NOT_FOUND, NOT_FOUND_TTL_MS);
        throw notInCensus(d);
      }
      throw new HttpError(502, `FMCSA data is not available right now. Try again in a few minutes. (${src.census.error || 'no source answered'})`);
    }
    remember(d, profile, profile.complete ? TTL_MS : PARTIAL_TTL_MS);
    return profile;
  })().finally(() => inflight.delete(d));
  inflight.set(d, p);
  return p;
}

/** How long a stored copy (Carrier.fmcsaSnapshot.profile) stays fresh: 24 h, or 10 minutes when a source failed. */
export const storedMaxAgeMs = (profile) => (profile?.complete ? 24 * 3600_000 : 10 * 60_000);
