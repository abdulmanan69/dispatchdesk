import { licensingRows, motusRows } from '../brokers/fmcsa.js';
import { normDot, normMc } from './normalize.js';

/**
 * Operating authority of motor carriers from FMCSA's two public licensing datasets (data.transportation.gov, no key),
 * read through services/brokers/fmcsa.js:
 *   - Motus (inys-ebih, motusRows): FMCSA's current system, updated daily. One row per authority type,
 *     op_auth_status Active | Pending | Inactive | Withdrawn, BIPD on file in dollars (it can still read 0 for a
 *     freshly granted carrier whose policy is already filed).
 *   - legacy Licensing & Insurance (6eyk-hxee, licensingRows): FROZEN since May 14, 2026 ("no longer updated"), but it
 *     still holds many carriers Motus does not: common/contract authority A/I/N, application and revocation pending
 *     flags, BIPD on file in thousands of dollars.
 * Both are looked up by MC docket and by USDOT number (the census docket can lag).
 *
 * The Company Census (az4n-8mr2) only says whether the USDOT registration is active; its docket status lags and
 * ignores insurance. So every "authority" shown or used to pick leads comes from here. Rule:
 *   1. Motus holds a motor-carrier authority row for the carrier -> Motus decides (it is the live record):
 *        active   = any carrier authority Active (FMCSA only keeps authority active with liability insurance filed)
 *        pending  = none active, one pending
 *        inactive = all Inactive or Withdrawn
 *   2. Otherwise the legacy record (as of May 14, 2026) decides:
 *        active   = common or contract authority active, BIPD on file, no revocation pending
 *        pending  = not active, an application pending
 *        inactive = anything else, including "found in neither dataset"
 *   unknown = neither dataset answered (callers that pick leads fail closed on this)
 *   none    = no MC number at all (set by callers; such a carrier cannot haul for-hire interstate loads)
 * `complete` is false when the answer could still change with the dataset that did not answer (Motus missing, or
 * legacy missing without a Motus record): then only an "active" result is final, which is why the refresh job retries
 * incomplete non-active results instead of acting on them.
 * Address flags: in both datasets the undeliverable-mail columns hold Y = deliverable, N = undeliverable.
 */
export const AUTHORITY_LABELS = Object.freeze({
  active: 'Authority active · insurance on file',
  inactive: 'Authority inactive (FMCSA licensing)',
  pending: 'Authority pending',
  revocationPending: 'Revocation pending',
  noInsurance: 'No insurance on file',
  noRecord: 'No authority record (FMCSA licensing)',
  unknown: 'Authority not verified',
  none: 'No MC authority',
});

/**
 * Labels written only after a licensing dataset answered. Carrier.operatingStatus holding one of these means the
 * authority was checked against FMCSA licensing (at Carrier.verifiedAt); anything else has never been checked.
 */
export const CHECKED_LABELS = Object.freeze([
  AUTHORITY_LABELS.active, AUTHORITY_LABELS.inactive, AUTHORITY_LABELS.pending, AUTHORITY_LABELS.revocationPending,
  AUTHORITY_LABELS.noInsurance, AUTHORITY_LABELS.noRecord,
]);

export const AUTHORITY_UNAVAILABLE = 'Could not verify operating authority with FMCSA right now.';

/** Motus authority types that are motor-carrier (for-hire) authority; broker and freight forwarder rows are ignored. */
export const MOTUS_CARRIER_TYPES = Object.freeze([
  'Motor Carrier of Property (Except Household Goods)',
  'Motor Carrier of Household Goods',
  'Enterprise Motor Carrier of Property (Except Household Goods)',
  'Mexico Domiciled Motor Carrier of Property (Except Household Goods)',
]);

const SOURCE = 'FMCSA licensing';
const CHUNK = 200; // carriers per request, per dataset (each request takes at most 200 MC and 200 USDOT numbers)
const MAX_NUMBERS = 2000; // per checkAuthority call: at most 10 sequential chunks
const CACHE_MAX = 5000;

const up = (v) => String(v ?? '').trim().toUpperCase();
const yes = (v) => up(v) === 'Y';
// L&I / Motus mail flags: 'Y' = deliverable, 'N' = undeliverable (data dictionary; almost every row is 'Y').
const undeliverableFlag = (v) => up(v) === 'N';
const STAT = { A: 'active', I: 'inactive', N: 'none' };
const num = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const typeKey = (t) => up(t).replace(/\s+/g, ' ');
const CARRIER_TYPE_KEYS = new Set(MOTUS_CARRIER_TYPES.map(typeKey));
export const isMotusCarrierRow = (row) => CARRIER_TYPE_KEYS.has(typeKey(row?.op_auth_type));

/** Facts from legacy L&I rows (one per docket). */
function legacyFacts(rows) {
  const f = { found: rows.length > 0, activeInsured: false, activeUninsured: false, pending: false, revocationPending: false, amount: null, undeliverable: null, common: null, contract: null };
  let best = null;
  for (const r of rows) {
    const active = up(r.common_stat) === 'A' || up(r.contract_stat) === 'A';
    const amount = num(r.bipd_file); // thousands of dollars
    const insured = amount != null && amount > 0;
    if (amount != null) f.amount = Math.max(f.amount ?? 0, amount * 1000);
    if (active && insured) f.activeInsured = true;
    if (active && !insured) f.activeUninsured = true;
    if (active && (yes(r.common_rev_pend) || yes(r.contract_rev_pend))) f.revocationPending = true;
    if (!active && (yes(r.common_app_pend) || yes(r.contract_app_pend))) f.pending = true;
    if (r.undeliverable_mail != null && r.undeliverable_mail !== '') f.undeliverable = (f.undeliverable || false) || undeliverableFlag(r.undeliverable_mail);
    if (!best || (active && !(up(best.common_stat) === 'A' || up(best.contract_stat) === 'A'))) best = r;
  }
  if (best) { f.common = STAT[up(best.common_stat)] || null; f.contract = STAT[up(best.contract_stat)] || null; }
  return f;
}

/** Facts from Motus rows (only motor-carrier authority types count). */
function motusFacts(rows) {
  const f = { found: rows.length > 0, carrierFound: false, active: false, activeInsured: false, activeUninsured: false, pending: false, amount: null, undeliverable: null };
  for (const r of rows) {
    const undeliverable = [r.bus_undeliverable_mail, r.mail_undeliverable_mail].filter((v) => v != null && v !== '');
    if (undeliverable.length) f.undeliverable = (f.undeliverable || false) || undeliverable.some(undeliverableFlag);
    if (!isMotusCarrierRow(r)) continue;
    f.carrierFound = true;
    const status = up(r.op_auth_status);
    if (status === 'ACTIVE') f.active = true;
    const amount = num(r.bipd_file); // dollars, decimal text
    const insured = amount != null && amount > 0;
    if (amount != null) f.amount = Math.max(f.amount ?? 0, amount);
    if (status === 'ACTIVE' && insured) f.activeInsured = true;
    if (status === 'ACTIVE' && !insured) f.activeUninsured = true;
    if (status === 'PENDING') f.pending = true;
  }
  return f;
}

/**
 * Combined authority of one carrier. `legacy` and `motus` are that carrier's rows from each dataset: [] when the
 * dataset answered without any, null when it did not answer.
 * Returns { status, label, source, complete, common, contract, insuranceOnFile, insuranceAmount, revocationPending,
 * pending, undeliverableMail, datasets }.
 */
export function combineAuthority({ legacy = null, motus = null } = {}) {
  const L = legacy ? legacyFacts(legacy) : null;
  const M = motus ? motusFacts(motus) : null;
  const datasets = [L && 'L&I', M && 'Motus'].filter(Boolean);
  if (!L && !M) {
    return {
      status: 'unknown', label: AUTHORITY_LABELS.unknown, source: null, complete: false, common: null, contract: null, insuranceOnFile: null,
      insuranceAmount: null, revocationPending: null, pending: null, undeliverableMail: null, datasets,
    };
  }
  // Motus is the live record: when it holds a motor-carrier authority for this carrier, it decides alone (the legacy
  // flags, revocation pending included, stopped updating on May 14, 2026).
  const motusDecides = !!M?.carrierFound;
  const revocationPending = motusDecides ? false : !!L?.revocationPending;
  const pending = motusDecides ? M.pending && !M.active : !!L?.pending;
  const found = !!(L?.found || M?.found);
  let status;
  let label;
  if (motusDecides) {
    if (M.active) { status = 'active'; label = AUTHORITY_LABELS.active; }
    else if (M.pending) { status = 'pending'; label = AUTHORITY_LABELS.pending; }
    else { status = 'inactive'; label = AUTHORITY_LABELS.inactive; }
  } else if (L?.activeInsured && !revocationPending) { status = 'active'; label = AUTHORITY_LABELS.active; }
  else if (pending && !L?.activeInsured) { status = 'pending'; label = AUTHORITY_LABELS.pending; }
  else {
    status = 'inactive';
    label = revocationPending ? AUTHORITY_LABELS.revocationPending
      : L?.activeUninsured ? AUTHORITY_LABELS.noInsurance
        : found ? AUTHORITY_LABELS.inactive
          : AUTHORITY_LABELS.noRecord;
  }
  const amounts = [L?.amount, M?.amount].filter((v) => v != null);
  const undeliverable = [L?.undeliverable, M?.undeliverable].filter((v) => v != null);
  return {
    status,
    label,
    source: SOURCE,
    // Final when Motus decided, or when both datasets answered.
    complete: motusDecides || !!(L && M),
    common: L?.common ?? null,
    contract: L?.contract ?? null,
    // An active Motus authority means FMCSA accepted the liability filing, even while its bipd_file still reads 0.
    insuranceOnFile: motusDecides && M.active ? true : found && amounts.length ? Math.max(...amounts) > 0 : found ? false : null,
    insuranceAmount: amounts.length ? Math.max(...amounts) : null,
    revocationPending: L ? revocationPending : null,
    pending,
    undeliverableMail: undeliverable.length ? undeliverable.some(Boolean) : null,
    datasets,
  };
}

/**
 * Authority from one legacy L&I row alone (Motus not consulted). `answered` says whether the dataset answered: without
 * a row it then means the dataset has no record of the docket. By default a missing row means "did not answer".
 */
export function authorityFromLicensing(row, { answered = row != null } = {}) {
  return combineAuthority({ legacy: row ? [row] : answered ? [] : null, motus: null });
}

/** Authority for a carrier without an MC number. */
export const noMcAuthority = () => ({ ...combineAuthority(), status: 'none', label: AUTHORITY_LABELS.none });

// Opt-in per-process cache (callers that show lists may pass cacheMs; runs, saves and the refresh job never do).
// Only final answers are cached (both datasets answered, or active). It saves upstream calls; nothing depends on it.
const cache = new Map(); // mc -> { at, ttl, value }
export function clearAuthorityCache() { cache.clear(); }
function cached(mc, now) {
  const hit = cache.get(mc);
  if (!hit) return undefined;
  if (now - hit.at > hit.ttl) { cache.delete(mc); return undefined; }
  return hit.value;
}
function remember(mc, value, ttl) {
  cache.delete(mc);
  while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(mc, { at: Date.now(), ttl, value });
}

/** Rows of a dataset answer indexed by MC docket and by USDOT number. */
function indexRows(rows, dotField) {
  const byMc = new Map();
  const byDot = new Map();
  const push = (map, k, r) => { if (!k) return; if (!map.has(k)) map.set(k, []); map.get(k).push(r); };
  for (const r of rows) {
    const docket = up(r.docket_number);
    if (docket.startsWith('MC')) push(byMc, normMc(docket.slice(2)), r);
    push(byDot, normDot(r[dotField]), r);
  }
  return { byMc, byDot };
}
const rowsFor = (index, { mc, dot }) => (index ? [...new Set([...(index.byMc.get(mc) || []), ...(dot ? index.byDot.get(dot) || [] : [])])] : null);

/**
 * Check operating authority. `carriers` are MC numbers or { mc, dot } (the USDOT number finds authority filed under a
 * docket the census does not show yet). Returns Map(normalized MC -> authority | null): null when neither dataset
 * answered for that carrier. Carriers go out in chunks of 200, one chunk at a time, with one request per dataset
 * (the two in parallel), at most 2,000 carriers per call. A dataset that does not answer is not asked again in this
 * call; once both have failed, the remaining carriers map to null without further requests.
 */
export async function checkAuthority(carriers, { cacheMs = 0 } = {}) {
  const wanted = new Map(); // mc -> dot
  for (const c of carriers || []) {
    const mc = normMc(typeof c === 'object' && c ? c.mc : c);
    if (mc && !wanted.has(mc)) wanted.set(mc, typeof c === 'object' && c ? normDot(c.dot) : null);
    if (wanted.size >= MAX_NUMBERS) break;
  }
  const out = new Map();
  const now = Date.now();
  const todo = [];
  for (const [mc, dot] of wanted) {
    const hit = cacheMs > 0 ? cached(mc, now) : undefined;
    if (hit) out.set(mc, hit);
    else todo.push({ mc, dot });
  }
  let legacyDown = false;
  let motusDown = false;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const part = todo.slice(i, i + CHUNK);
    if (legacyDown && motusDown) { for (const c of part) out.set(c.mc, null); continue; }
    const q = { mcs: part.map((c) => c.mc), dots: part.map((c) => c.dot).filter(Boolean) };
    const [legacy, motus] = await Promise.all([legacyDown ? null : licensingRows(q), motusDown ? null : motusRows(q)]);
    if (!legacy) legacyDown = true;
    if (!motus) motusDown = true;
    const L = legacy ? indexRows(legacy, 'dot_number') : null;
    const M = motus ? indexRows(motus, 'usdot_number') : null;
    for (const c of part) {
      if (!L && !M) { out.set(c.mc, null); continue; }
      const a = combineAuthority({ legacy: rowsFor(L, c), motus: rowsFor(M, c) });
      out.set(c.mc, a);
      if (cacheMs > 0 && (a.complete || a.status === 'active')) remember(c.mc, a, cacheMs);
    }
  }
  return out;
}

/** Carrier fields for an authority result: what the CRM stores (authorityStatus, operatingStatus). */
export const authorityFields = (a) => ({ authorityStatus: a.status, operatingStatus: a.label });

/** Public shape of an authority result for API rows. */
export function authorityView(a) {
  return a ? { status: a.status, label: a.label, insuranceOnFile: a.insuranceOnFile, revocationPending: a.revocationPending, source: a.source, complete: a.complete ?? null } : null;
}

/**
 * Annotate census records (mapRecord output) with their licensing authority in one batched check. Each record gets
 * `authority` ({ status, label, insuranceOnFile, ... }), authorityStatus and operatingStatus. A record without an MC
 * number gets status 'none'; a record neither dataset answered for gets 'unknown'.
 * Returns { items, answered } where answered is false when any check got no answer at all.
 */
export async function annotateAuthority(records, { cacheMs = 0 } = {}) {
  const results = await checkAuthority(records.filter((r) => normMc(r.mcNumber)).map((r) => ({ mc: r.mcNumber, dot: r.dotNumber })), { cacheMs });
  let answered = true;
  const items = records.map((rec) => {
    let a;
    if (!normMc(rec.mcNumber)) a = noMcAuthority();
    else {
      a = results.get(normMc(rec.mcNumber)) || null;
      if (!a) { answered = false; a = combineAuthority(); }
    }
    return { ...rec, ...authorityFields(a), authority: authorityView(a) };
  });
  return { items, answered };
}
