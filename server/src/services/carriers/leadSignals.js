import { query as censusQuery } from './fmcsaCensus.js';
import {
  sodaRows, limited, fmcsaFetch, qcCarrier, qcConfigured, MOTUS_AUTH_HIST_URL, AUTH_HIST_URL, MOTUS_INSURANCE_URL, INSURANCE_URL,
} from '../brokers/fmcsa.js';
import { normMc, normPhone } from './normalize.js';
import { day } from './profile.js';
import {
  DEFAULT_WEIGHTS, EQUIPMENT_TYPES, emailKind, freeMailName, milesPerTruck, normalizeLeadFilters,
} from './leadFilters.js';

/**
 * Lead signals and lead score v2 for dispatch prospects. A great dispatch lead NEEDS a dispatcher now, FITS the
 * dispatcher's service, can be REACHED, is SAFE to work with, and is NOT already served by someone else.
 *
 * Data (all free, public; data.transportation.gov unless noted):
 *   Company Census az4n-8mr2      cell phone, officers, drivers, CDL, vehicle counts, MCS-150 date and mileage,
 *                                 operation, classification, hazmat, cargo, safety rating, crash rate, prior revoke,
 *                                 undeliverable address (fmcsaCensus.censusFacts); and count(*) grouped by phone and by
 *                                 email for the shared-contact check.
 *   Motus AuthHist yu5v-wbh6     MC grant date (Motus first: live, and its migrated GRANTED rows keep the original
 *                                 dates), revocations and reinstatements.
 *   Legacy AuthHist 9mw4-x3tu    the same for dockets Motus has no grant for (frozen since 2026-05-14).
 *   Motus Insur c5y8-a4uz / legacy ActPendInsur qh9u-swkp   insurer of the current primary BIPD policy.
 *   QCMobile (admin webKey)       allowed to operate, out of service, inspection out-of-service rates: only for the
 *                                 leads a run is about to save (at most QC_MAX_PER_RUN), never for the whole crawl.
 * Every lookup goes out in batches of at most 200 numbers, one request at a time, through the FMCSA limiter (2 calls in
 * flight per process, Socrata app token when set). Every one is fail-soft: a lookup that does not answer leaves its
 * signal out (and says so with an "unchecked" signal) instead of dropping the carrier. Only the operating-authority
 * check (authority.js) is fail-closed, and it is not in this file.
 *
 * Score: Need (35) + Fit (25) + Reachability (25) + Quality (15) = 0–100 (a playbook may move weight between the
 * groups; they always add up to 100). Each group is clamped to 0..its weight. Tiers: A >= 75, B 55–74, C < 55.
 */

export const BATCH = 200;
export const SHARED_THRESHOLD = 3;
export const QC_MAX_PER_RUN = 50;
export const UNDERUSED_MILES = 60_000;
export const HIGH_CRASH_RATE = 1.5; // recordable crashes per million miles (the safety-rating factor threshold)
const DAY = 86_400_000;

export const tierOf = (score) => (score >= 75 ? 'A' : score >= 55 ? 'B' : 'C');
/** Carrier.priority for a tier: A = hot, B = high, C = normal. */
export const tierPriority = (tier) => (tier === 'A' ? 2 : tier === 'B' ? 1 : 0);

const uniq = (list) => [...new Set(list)];
const chunks = (list, size = BATCH) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
const esc = (s) => String(s).replace(/'/g, "''");
const up = (v) => String(v ?? '').trim().toUpperCase();

/** Small per-process TTL cache for previews and Find carriers (cacheMs > 0); runs always read fresh data. */
function ttlCache(max = 5000) {
  const m = new Map();
  return {
    get(k) {
      const hit = m.get(k);
      if (!hit) return undefined;
      if (Date.now() - hit.at > hit.ttl) { m.delete(k); return undefined; }
      return hit.value;
    },
    set(k, value, ttl) {
      if (!(ttl > 0)) return;
      m.delete(k);
      while (m.size >= max) m.delete(m.keys().next().value);
      m.set(k, { at: Date.now(), ttl, value });
    },
    clear() { m.clear(); },
  };
}
const ageCache = ttlCache();
const insurerCache = ttlCache();
export function clearLeadSignalCaches() { ageCache.clear(); insurerCache.clear(); }

// ---------------------------------------------------------------------------------------------------------------
// Shared contacts: the same phone or email on many active census carriers is the hallmark of a dispatch service,
// agent or consultant listed as the contact, so the carrier most likely has a dispatcher already.
// ---------------------------------------------------------------------------------------------------------------

/** count(*) of active census carriers per value of `expr`, one request; null when the census did not answer. */
async function censusCounts(expr, values, cacheMs) {
  const params = {
    $select: `${expr} as v, count(*) as n`,
    $where: `status_code='A' AND ${expr} in(${values.map((v) => `'${esc(v)}'`).join(',')})`,
    $group: expr,
    $limit: String(values.length + 10),
  };
  try {
    return await limited(() => censusQuery(params, fmcsaFetch, { cacheMs }));
  } catch {
    return null;
  }
}

/**
 * Carriers sharing each record's phone and email. Returns Map(dotNumber -> { count, by, checked }): count = the most
 * active census carriers sharing its phone or email (itself included), by = 'phone' | 'email' | null, checked = false
 * when a lookup it needed did not answer. Phones and emails go out in batches of at most 200 values, sequentially.
 */
export async function sharedContactCounts(recs, { cacheMs = 0 } = {}) {
  const phoneOf = (r) => { const p = normPhone(r.phone); return p && p.length === 10 ? p : null; };
  const emailOf = (r) => { const e = String(r.email || '').trim().toLowerCase(); return e.includes('@') ? e : null; };
  const phones = new Map(); // value -> n | null (no answer)
  const emails = new Map();
  for (const part of chunks(uniq(recs.map(phoneOf).filter(Boolean)))) {
    const rows = await censusCounts('phone', part, cacheMs);
    for (const p of part) phones.set(p, rows ? 0 : null);
    for (const r of rows || []) if (phones.has(String(r.v)) && Number.isFinite(Number(r.n))) phones.set(String(r.v), Number(r.n));
  }
  for (const part of chunks(uniq(recs.map(emailOf).filter(Boolean)))) {
    const rows = await censusCounts('lower(email_address)', part, cacheMs);
    for (const e of part) emails.set(e, rows ? 0 : null);
    for (const r of rows || []) if (emails.has(String(r.v)) && Number.isFinite(Number(r.n))) emails.set(String(r.v), Number(r.n));
  }
  const out = new Map();
  for (const r of recs) {
    const p = phoneOf(r);
    const e = emailOf(r);
    const pn = p ? phones.get(p) : 0;
    const en = e ? emails.get(e) : 0;
    const count = Math.max(pn || 0, en || 0);
    out.set(r.dotNumber, { count, by: count >= SHARED_THRESHOLD ? ((pn || 0) >= (en || 0) ? 'phone' : 'email') : null, checked: pn !== null && en !== null });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// MC age from authority history (Motus first, legacy for dockets Motus has no grant for)
// ---------------------------------------------------------------------------------------------------------------

const isBrokerish = (t) => /broker|forwarder/i.test(t || '');
const docketIn = (mcs) => `docket_number in(${mcs.map((m) => `'MC${m}'`).join(',')})`;
const mcOfDocket = (d) => { const s = up(d).replace(/[\s-]/g, ''); return s.startsWith('MC') ? normMc(s.slice(2)) : null; };
const blank = () => ({ grants: [], revoked: [], reinstated: [] });

function motusEvents(rows) {
  const by = new Map();
  for (const r of rows) {
    const mc = mcOfDocket(r.docket_number);
    if (!mc || isBrokerish(r.op_auth_type)) continue;
    const reason = String(r.reason || '').trim();
    const date = day(r.status_change_date);
    if (!date) continue;
    if (!by.has(mc)) by.set(mc, blank());
    const e = by.get(mc);
    if (/^granted$/i.test(reason)) e.grants.push(date);
    // "Reinstated - legacy common/contract authority consolidation corrected (MOTUS Issue #220)" is a data fix, not a
    // reinstatement after a revocation.
    else if (/^reinstated\b/i.test(reason) && !/issue\s*#?\s*220|consolidation/i.test(reason)) e.reinstated.push(date);
    else if ((/\brevoked\b/i.test(reason) && !/discontinued/i.test(reason)) || /^involuntary suspension/i.test(reason)) e.revoked.push(date);
  }
  return by;
}

function legacyEvents(rows) {
  const by = new Map();
  for (const r of rows) {
    const mc = mcOfDocket(r.docket_number);
    if (!mc || isBrokerish(r.mod_col_1)) continue;
    if (!by.has(mc)) by.set(mc, blank());
    const e = by.get(mc);
    const orig = up(r.original_action_desc);
    const disp = up(r.disp_action_desc);
    if (orig === 'GRANTED' && day(r.orig_served_date)) e.grants.push(day(r.orig_served_date));
    if (orig === 'REINSTATED' && day(r.orig_served_date)) e.reinstated.push(day(r.orig_served_date));
    if ((disp === 'REVOKED' || disp === 'SAFETY REVOCATION') && (day(r.disp_served_date) || day(r.disp_decided_date))) e.revoked.push(day(r.disp_served_date) || day(r.disp_decided_date));
  }
  return by;
}

const earliest = (list) => [...list].sort()[0] || null;
const latest = (list) => [...list].sort().at(-1) || null;

/**
 * Authority history per MC docket. Returns Map(mc -> { grantedAt, source, lastRevokedAt, reinstatedAt }) for every MC
 * a dataset answered for (grantedAt null when no grant is on record); MCs no dataset answered for are missing.
 * Motus answers first (batches of 200 dockets); the legacy dataset is asked only for dockets without a Motus grant,
 * and only for grant / reinstatement / revocation rows.
 */
export async function authorityAges(recs, { cacheMs = 0 } = {}) {
  const mcs = uniq(recs.map((r) => normMc(r.mcNumber)).filter(Boolean));
  const out = new Map();
  const todo = [];
  for (const mc of mcs) {
    const hit = cacheMs > 0 ? ageCache.get(mc) : undefined;
    if (hit) out.set(mc, hit);
    else todo.push(mc);
  }
  const motus = new Map(); // mc -> events (answered)
  const motusAnswered = new Set();
  for (const part of chunks(todo)) {
    const rows = await sodaRows(MOTUS_AUTH_HIST_URL, docketIn(part), Math.min(5000, part.length * 25 + 25), 'Motus authority history');
    if (!rows) continue;
    for (const mc of part) motusAnswered.add(mc);
    for (const [mc, e] of motusEvents(rows)) motus.set(mc, e);
  }
  const needLegacy = todo.filter((mc) => !motus.get(mc)?.grants.length);
  const legacy = new Map();
  const legacyAnswered = new Set();
  for (const part of chunks(needLegacy)) {
    const where = `${docketIn(part)} AND (original_action_desc in('GRANTED','REINSTATED') OR disp_action_desc in('REVOKED','SAFETY REVOCATION'))`;
    const rows = await sodaRows(AUTH_HIST_URL, where, Math.min(5000, part.length * 25 + 25), 'legacy authority history');
    if (!rows) continue;
    for (const mc of part) legacyAnswered.add(mc);
    for (const [mc, e] of legacyEvents(rows)) legacy.set(mc, e);
  }
  for (const mc of todo) {
    const m = motus.get(mc) || blank();
    const l = legacy.get(mc) || blank();
    const hasMotusGrant = m.grants.length > 0;
    // Answered: Motus had a grant, or every dataset that was asked answered.
    const answered = hasMotusGrant || (motusAnswered.has(mc) && legacyAnswered.has(mc));
    if (!answered) continue;
    const revoked = latest([...m.revoked, ...l.revoked]);
    const reinstated = latest([...m.reinstated, ...l.reinstated]);
    const value = {
      grantedAt: hasMotusGrant ? earliest(m.grants) : earliest(l.grants),
      source: hasMotusGrant ? 'motus' : l.grants.length ? 'legacy' : null,
      lastRevokedAt: revoked,
      reinstatedAt: reinstated && revoked && reinstated >= revoked ? reinstated : null,
    };
    out.set(mc, value);
    ageCache.set(mc, value, cacheMs);
  }
  return out;
}

/**
 * MC age of a record in days: from authority history (rec._lead.history), otherwise estimated from the census USDOT
 * registration date (MC authority is granted after it, so the estimate is an upper bound). null without an MC number.
 */
export function mcAgeOf(rec, now = new Date()) {
  if (!normMc(rec.mcNumber)) return null;
  const h = rec._lead?.history;
  const days = (d) => Math.max(0, Math.floor((now - new Date(`${String(d).slice(0, 10)}T00:00:00Z`)) / DAY));
  if (h?.grantedAt) return { days: days(h.grantedAt), source: h.source, estimated: false, grantedAt: h.grantedAt };
  const added = rec._extra?.facts?.addDate || (rec.authorityDate ? new Date(rec.authorityDate).toISOString().slice(0, 10) : null);
  return added ? { days: days(added), source: 'census', estimated: true, grantedAt: null } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Insurer of the current primary BIPD policy (Motus first, legacy for dockets Motus has no BIPD policy for)
// ---------------------------------------------------------------------------------------------------------------

const legacyBipd = (r) => /^(BMC-?)?(91X?|82)$/i.test(String(r.ins_form_code || '').trim()) || /^BI&?PD/i.test(String(r.mod_col_1 || ''));
const motusBipd = (r) => String(r.ins_type_code || '').trim() === '1' || /^(BMC-?)?(91X?|82)$/i.test(String(r.ins_form_code || '').trim());

/**
 * Map(mc -> { names, source }) for every MC a dataset answered for (names [] when no primary BIPD policy is on file);
 * MCs no dataset answered for are missing.
 */
export async function currentInsurers(recs, { cacheMs = 0, now = new Date() } = {}) {
  const today = now.toISOString().slice(0, 10);
  const mcs = uniq(recs.map((r) => normMc(r.mcNumber)).filter(Boolean));
  const out = new Map();
  const todo = [];
  for (const mc of mcs) {
    const hit = cacheMs > 0 ? insurerCache.get(mc) : undefined;
    if (hit) out.set(mc, hit);
    else todo.push(mc);
  }
  const motus = new Map();
  const motusAnswered = new Set();
  for (const part of chunks(todo)) {
    const rows = await sodaRows(MOTUS_INSURANCE_URL, docketIn(part), Math.min(5000, part.length * 15 + 15), 'Motus insurance');
    if (!rows) continue;
    for (const mc of part) motusAnswered.add(mc);
    for (const r of rows) {
      const mc = mcOfDocket(r.docket_number);
      if (!mc || !motusBipd(r) || up(r.ins_class_code) === 'E') continue;
      const name = String(r.insurance_company_name || '').trim();
      if (!name) continue;
      if (!motus.has(mc)) motus.set(mc, []);
      motus.get(mc).push(name);
    }
  }
  const needLegacy = todo.filter((mc) => !motus.get(mc)?.length);
  const legacy = new Map();
  const legacyAnswered = new Set();
  for (const part of chunks(needLegacy)) {
    const rows = await sodaRows(INSURANCE_URL, docketIn(part), Math.min(5000, part.length * 15 + 15), 'legacy insurance');
    if (!rows) continue;
    for (const mc of part) legacyAnswered.add(mc);
    for (const r of rows) {
      const mc = mcOfDocket(r.docket_number);
      if (!mc || !legacyBipd(r) || /excess/i.test(String(r.mod_col_1 || ''))) continue;
      const cancel = day(r.cancl_effective_date);
      if (cancel && cancel < today) continue;
      const name = String(r.name_company || '').trim();
      if (!name) continue;
      if (!legacy.has(mc)) legacy.set(mc, []);
      legacy.get(mc).push(name);
    }
  }
  for (const mc of todo) {
    const m = motus.get(mc) || [];
    if (!m.length && !(motusAnswered.has(mc) && legacyAnswered.has(mc))) continue;
    const value = m.length ? { names: uniq(m), source: 'motus' } : { names: uniq(legacy.get(mc) || []), source: (legacy.get(mc) || []).length ? 'legacy' : null };
    out.set(mc, value);
    insurerCache.set(mc, value, cacheMs);
  }
  return out;
}

const normName = (s) => up(s).replace(/&/g, ' ').replace(/[^A-Z0-9]+/g, ' ').trim();
// Brand names that write trucking BIPD under other company names in FMCSA's data.
const INSURER_ALIASES = {
  PROGRESSIVE: ['PROGRESSIVE', 'UNITED FINANCIAL CASUALTY', 'ARTISAN TRUCKERS', 'DRIVE NEW JERSEY'],
  GEICO: ['GEICO'],
  'BERKSHIRE HATHAWAY': ['BERKSHIRE HATHAWAY'],
};
/** Whether any insurer name matches any term (case-insensitive "contains", with brand aliases). */
export function insurerMatches(names = [], terms = []) {
  const ns = names.map(normName);
  return terms.map(normName).filter(Boolean).some((t) => (INSURER_ALIASES[t] || [t]).some((a) => ns.some((n) => n.includes(a))));
}

// ---------------------------------------------------------------------------------------------------------------
// QCMobile live safety (picks only)
// ---------------------------------------------------------------------------------------------------------------

const qnum = (v) => { const n = Number(String(v ?? '').trim()); return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : null; };
export function qcFacts(c) {
  return {
    checked: true,
    allowed: up(c.allowedToOperate) === 'Y' ? true : up(c.allowedToOperate) === 'N' ? false : null,
    oosDate: day(c.oosDate),
    driver: { inspections: qnum(c.driverInsp), rate: qnum(c.driverOosRate), avg: qnum(c.driverOosRateNationalAverage) },
    vehicle: { inspections: qnum(c.vehicleInsp), rate: qnum(c.vehicleOosRate), avg: qnum(c.vehicleOosRateNationalAverage) },
  };
}
/** Out of service or not allowed to operate: never a lead. */
export const qcBlocks = (q) => !!q?.checked && (q.allowed === false || !!q.oosDate);
const farAbove = (i) => i && i.inspections >= 3 && i.rate != null && i.avg > 0 && i.rate > 2 * i.avg;

export const QC_CONCURRENCY = 2;
/**
 * Live QCMobile safety for at most `max` records (the leads about to be saved): QC_CONCURRENCY workers, each call also
 * through the FMCSA limiter. No call starts after `deadline` (ms timestamp). Map(dotNumber -> qcFacts |
 * { checked: false }); records past `max` are not in it. Nothing is requested when no webKey is set.
 */
export async function qcSafety(recs, { max = QC_MAX_PER_RUN, deadline = Infinity } = {}) {
  const out = new Map();
  const list = recs.slice(0, Math.max(0, max));
  if (!list.length) return out;
  if (!(await qcConfigured())) {
    for (const r of list) out.set(r.dotNumber, { checked: false });
    return out;
  }
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const r = list[next++];
      if (Date.now() >= deadline) { out.set(r.dotNumber, { checked: false }); continue; }
      const c = await qcCarrier(r.dotNumber).catch(() => null);
      out.set(r.dotNumber, c ? qcFacts(c) : { checked: false });
    }
  };
  await Promise.all(Array.from({ length: Math.min(QC_CONCURRENCY, list.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------------------------------------------

const GROUPS = ['need', 'fit', 'reach', 'quality'];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const titleCase = (s) => String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Lead score v2 for a mapped census record (or a plain carrier-like object). `rec._lead` holds lookup results:
 * { shared, history, insurer, qc } (see collectSignals). ctx: { now, timezone (the user's), weights, optimistic }.
 * `optimistic` scores the best the record could reach before any lookup (authority active when it has an MC, a brand
 * new MC, no shared contact): runs skip records whose best score is below the minimum without looking them up.
 * Returns { score, tier, signals: [{ key, label, points, group, tone }], reasons, groups }.
 */
export function scoreLead(rec, { now = new Date(), timezone = null, weights = DEFAULT_WEIGHTS, optimistic = false } = {}) {
  const x = rec._extra?.facts || {};
  const lead = rec._lead || {};
  const signals = [];
  const add = (group, key, label, points, tone) => signals.push({ key, label, points, group, tone: tone || (points > 0 ? 'good' : points < 0 ? 'bad' : 'info') });
  const hasMc = !!normMc(rec.mcNumber);

  // Need
  const age = optimistic ? (hasMc ? { days: 0, estimated: false } : null) : mcAgeOf(rec, now);
  if (age) {
    const est = age.estimated;
    const sfx = est ? ' (est.)' : '';
    if (age.days <= 90) add('need', 'new_authority', `New MC · ${est ? '~' : ''}${plural(age.days, 'day')}${sfx}`, est ? 20 : 25);
    else if (age.days <= 180) add('need', 'broker_ready', `Broker-ready · ${est ? '~' : ''}${age.days} days${sfx}`, est ? 18 : 22);
    else if (age.days <= 548) add('need', 'young', `Young authority · ${est ? '~' : ''}${plural(Math.floor(age.days / 30.44), 'month')}${sfx}`, est ? 10 : 12);
  }
  if (x.mcs150Date) {
    const d = Math.floor((now - new Date(`${x.mcs150Date}T00:00:00Z`)) / DAY);
    if (d >= 0 && d <= 183) {
      const m = Math.floor(d / 30.44);
      add('need', 'mcs150_recent', m < 1 ? 'MCS-150 updated this month' : `MCS-150 updated ${m} mo ago`, 5);
    }
  }
  const mpt = milesPerTruck(x, now);
  if (mpt != null && mpt < UNDERUSED_MILES) add('need', 'underused', `Underused truck · ${Math.round(mpt / 1000)}k mi/yr`, 5);
  if (!optimistic && lead.history?.reinstatedAt) add('need', 'reinstated', 'Reinstated after revocation', 3, 'warn');
  if (!optimistic && lead.shared) {
    if (lead.shared.count >= SHARED_THRESHOLD) add('need', 'shared_contact', `Shared contact · ${lead.shared.count} carriers`, -20);
    else if (!lead.shared.checked) add('need', 'shared_unchecked', 'Shared-contact check unavailable', 0);
  }

  // Fit
  const pu = x.powerUnits ?? rec.fleetSize ?? null;
  const drivers = x.drivers ?? rec.drivers ?? null;
  if (pu >= 1 && pu <= 3 && (drivers == null || drivers <= pu + 1)) add('fit', 'owner_operator', `Owner-operator · ${plural(pu, 'truck')}`, 10);
  else if (pu >= 1 && pu <= 10) add('fit', 'small_fleet', `Small fleet · ${plural(pu, 'truck')}`, 8);
  else if (pu >= 11 && pu <= 25) add('fit', 'mid_fleet', `Mid-size fleet · ${pu} trucks`, 3);
  const interstate = x.operation ? x.operation === 'A' : rec.carrierOperation === 'Interstate';
  const forHire = !!x.forHire || hasMc;
  if (interstate && forHire) add('fit', 'interstate_for_hire', 'Interstate for-hire', 7);
  else if (interstate) add('fit', 'interstate', 'Interstate', 4);
  else if (forHire) add('fit', 'for_hire', 'For-hire (intrastate)', 2);
  const equipment = x.equipment?.length ? x.equipment : String(rec.equipment || '').split(',').map((s) => s.trim()).filter(Boolean);
  equipment.forEach((e, i) => add('fit', `eq_${e}`, EQUIPMENT_TYPES[e] || titleCase(e.replace(/_/g, ' ')), i === 0 ? 5 : 0, 'good'));
  if (x.hazmat) add('fit', 'hazmat', 'Hazmat', 0);
  if (timezone && rec.timezone && rec.timezone === timezone) add('fit', 'your_time_zone', 'Your time zone', 3);

  // Reachability
  const phone = normPhone(rec.phone);
  if (x.cellPhone) add('reach', 'cell_phone', 'Cell phone', 14);
  else if (phone) add('reach', 'phone', 'Phone', 8);
  if (rec.email) {
    add('reach', 'email', 'Email', 5);
    if (emailKind(rec.email) === 'free') add('reach', 'free_mail', `${freeMailName(rec.email)} · owner-run`, 2);
    else add('reach', 'company_email', 'Company email domain', 0);
  }
  if (x.undeliverable) add('reach', 'address_undeliverable', 'Address undeliverable', -2, 'warn');
  else if (rec.address || rec.city) add('reach', 'address_ok', 'Deliverable address', 2);
  if (x.officer) add('reach', 'officer', `Officer: ${titleCase(x.officer)}`, 2);

  // Quality
  const authority = optimistic ? (hasMc ? 'active' : rec.authorityStatus) : rec.authorityStatus;
  if (authority === 'active') add('quality', 'authority_active', 'Authority active · insurance on file', 8);
  else if (authority === 'pending') add('quality', 'authority_pending', 'Authority pending', 0, 'warn');
  // Rating and history points need the census facts: a record without them earns none (nothing is assumed).
  const known = !!rec._extra?.facts;
  if (x.safetyRating === 'S') add('quality', 'rating_satisfactory', 'Satisfactory rating', 3);
  else if (x.safetyRating === 'C') add('quality', 'rating_conditional', 'Conditional rating', -5);
  else if (x.safetyRating === 'U') add('quality', 'rating_unsatisfactory', 'Unsatisfactory rating', -15);
  else if (known) add('quality', 'not_rated', 'No safety rating issues', 3);
  const highCrash = x.crashRate != null && x.crashRate > HIGH_CRASH_RATE;
  const revokedBefore = !optimistic && !!lead.history?.lastRevokedAt;
  if (x.priorRevoke) add('quality', 'prior_revoke', 'Prior USDOT revoked', -4, 'warn');
  if (highCrash) add('quality', 'high_crash_rate', `Crash rate ${x.crashRate} per million mi`, -4);
  if (revokedBefore) add('quality', 'revoked_before', 'Authority revoked before', -3, 'warn');
  if (known && !x.priorRevoke && !highCrash && !revokedBefore) add('quality', 'clean_history', 'No revocations or crash flags', 4);
  const qc = optimistic ? null : lead.qc;
  if (qc && !qc.checked) add('quality', 'safety_not_checked', 'Live safety not checked', 0);
  else if (qc?.checked) {
    if (qc.allowed === true && !qc.oosDate) add('quality', 'allowed_to_operate', 'Allowed to operate (QCMobile)', 0, 'good');
    if (qc.allowed === false || qc.oosDate) add('quality', 'out_of_service', 'Out of service', -15);
    if (farAbove(qc.vehicle)) add('quality', 'high_oos_vehicle', `Vehicle OOS ${qc.vehicle.rate}% vs ${qc.vehicle.avg}% avg`, -5);
    if (farAbove(qc.driver)) add('quality', 'high_oos_driver', `Driver OOS ${qc.driver.rate}% vs ${qc.driver.avg}% avg`, -5);
  }
  if (!optimistic && lead.insurer) {
    if (lead.insurer.names?.length) add('quality', 'insurer', `Insurer: ${titleCase(lead.insurer.names[0])}`, 0);
    else if (lead.insurer.checked === false) add('quality', 'insurer_unchecked', 'Insurer not checked', 0);
  }

  // Weights: a playbook moves weight between the groups; each signal's points scale with its group.
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const groups = {};
  for (const g of GROUPS) {
    const scale = w[g] / DEFAULT_WEIGHTS[g];
    let sum = 0;
    for (const s of signals) {
      if (s.group !== g) continue;
      if (scale !== 1) s.points = Math.round(s.points * scale);
      sum += s.points;
    }
    groups[g] = Math.max(0, Math.min(w[g], sum));
  }
  const score = Math.max(0, Math.min(100, GROUPS.reduce((n, g) => n + groups[g], 0)));
  // Strongest reasons first; warnings after the points they take away from.
  signals.sort((a, b) => (b.points > 0) - (a.points > 0) || Math.abs(b.points) - Math.abs(a.points));
  return { score, tier: tierOf(score), signals, reasons: signals.filter((s) => s.points > 0).map((s) => s.label), groups };
}

/** One line for a carrier note: "82/100 (tier A): New MC · 45 days (+25), Cell phone (+14), ...". */
export function scoreText({ score, tier, signals }) {
  const parts = signals.filter((s) => s.points !== 0).map((s) => `${s.label} (${s.points > 0 ? '+' : ''}${s.points})`);
  return `${score}/100 (tier ${tier}): ${parts.join(', ') || 'no signals'}`;
}

/** Stored form of the signals (Carrier.leadSignals). */
export const signalsJson = (signals) => JSON.stringify(signals.map(({ key, label, points, group, tone }) => ({ key, label, points, group, tone })));

// ---------------------------------------------------------------------------------------------------------------
// Steps used by the lead generator and Find carriers (each takes and returns mapped census records)
// ---------------------------------------------------------------------------------------------------------------

const withLead = (rec, patch) => ({ ...rec, _lead: { ...(rec._lead || {}), ...patch } });

/** Shared-contact step: annotates every record; with excludeSharedContacts, shared ones go to `excluded`. */
export async function sharedContactStep(recs, criteria, { cacheMs = 0 } = {}) {
  if (!recs.length) return { kept: [], excluded: [] };
  const exclude = normalizeLeadFilters(criteria).excludeSharedContacts;
  const counts = await sharedContactCounts(recs, { cacheMs });
  const kept = [];
  const excluded = [];
  for (const r of recs) {
    const rec = withLead(r, { shared: counts.get(r.dotNumber) || { count: 0, by: null, checked: false } });
    if (exclude && rec._lead.shared.count >= SHARED_THRESHOLD) excluded.push(rec);
    else kept.push(rec);
  }
  return { kept, excluded };
}

/**
 * MC age step: annotates history and applies the MC age range. A record whose history did not answer is judged by
 * the estimate from its USDOT registration date (fail-soft).
 */
export async function mcAgeStep(recs, criteria, { cacheMs = 0, now = new Date() } = {}) {
  if (!recs.length) return { kept: [], excluded: [] };
  const f = normalizeLeadFilters(criteria);
  const ages = await authorityAges(recs, { cacheMs });
  const kept = [];
  const excluded = [];
  for (const r of recs) {
    const h = ages.get(normMc(r.mcNumber));
    const rec = withLead(r, { history: h || null, historyChecked: !!h || !normMc(r.mcNumber) });
    if (f.mcAgeMinDays != null || f.mcAgeMaxDays != null) {
      const age = mcAgeOf(rec, now);
      if (!age || (f.mcAgeMinDays != null && age.days < f.mcAgeMinDays) || (f.mcAgeMaxDays != null && age.days > f.mcAgeMaxDays)) { excluded.push(rec); continue; }
    }
    kept.push(rec);
  }
  return { kept, excluded };
}

/** Insurer step (only when the criteria name insurers): fail-soft, an unanswered lookup keeps the record. */
export async function insurerStep(recs, criteria, { cacheMs = 0, now = new Date() } = {}) {
  const f = normalizeLeadFilters(criteria);
  if (!recs.length || !f.insurers.length) return { kept: recs, excluded: [] };
  const found = await currentInsurers(recs, { cacheMs, now });
  const kept = [];
  const excluded = [];
  for (const r of recs) {
    const mc = normMc(r.mcNumber);
    const hit = mc ? found.get(mc) : null;
    const rec = withLead(r, { insurer: hit ? { names: hit.names, source: hit.source, checked: true } : { names: [], checked: !mc } });
    if (!hit) {
      // No MC: no BIPD policy to match ("include" leaves it out). No answer: keep, marked unchecked.
      if (!mc && f.insurerMode === 'include') excluded.push(rec);
      else kept.push(rec);
      continue;
    }
    const match = insurerMatches(hit.names, f.insurers);
    if (f.insurerMode === 'include' ? match : !match) kept.push(rec);
    else excluded.push(rec);
  }
  return { kept, excluded };
}

/** Attach QCMobile results to records (Map from qcSafety). */
export const withQc = (rec, qc) => withLead(rec, { qc: qc || { checked: false } });

/** API shape of a picked candidate: the record without internals, with its score, tier and signals. */
export function leadView({ _extra, _lead, ...r }) {
  return {
    ...r,
    cargo: _extra?.cargo || [],
    cellPhone: _extra?.facts?.cellPhone || null,
    officer: _extra?.facts?.officer || null,
    equipmentInferred: _extra?.facts?.equipment || [],
    signals: (r.signals || []).map(({ key, label, points, group, tone }) => ({ key, label, points, group, tone })),
  };
}
