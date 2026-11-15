import { query as censusQuery } from './fmcsaCensus.js';
import { sodaRows, limited, fmcsaFetch } from '../brokers/fmcsa.js';
import { normDot, normPhone } from './normalize.js';
import { normalizeLeadFilters } from './leadFilters.js';

/**
 * Authenticity checks for dispatch leads: is this a real carrier that runs trucks, reached at its own contact details?
 * Everything comes from free public FMCSA data on data.transportation.gov, in batches, one request at a time through
 * the FMCSA limiter, and every lookup is fail-soft (no answer: the carrier stays, marked unchecked).
 *
 *   Address mill    Company Census az4n-8mr2, active carriers per physical street + ZIP. Registration agents, virtual
 *                   offices and "carrier farms" put dozens of USDOT numbers on one suite (one Sheridan, WY suite holds
 *                   90). A lead there is rarely the owner's own yard.
 *   Linked inactive The same census, carriers that are inactive or had a USDOT revoked sharing the lead's exact street
 *                   (here) or its phone or email (sharedContactCounts in leadSignals.js): the usual trace of a carrier
 *                   that was shut down and came back under a new number. A reason to look closer, never proof.
 *   On the road     MCMIS Vehicle Inspection File fx4q-ay7w, roadside inspections in the last 12 and 24 months: trucks
 *                   that are inspected are trucks that run.
 * Contact checks (phone plausibility, toll-free lines, dispatch-service emails) need no lookup.
 */

export const ADDRESS_BATCH = 40; // addresses per census request (each is a starts_with clause in the URL)
export const DOT_BATCH = 100; // USDOT numbers per inspection request (each goes in twice: plain and zero-padded)
export const MILL_EXACT = 5; // active carriers on the very same street line (suite included)
export const MILL_BASE = 25; // active carriers on the same street address, any suite or unit
const DAY = 86_400_000;

const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
const esc = (s) => String(s).replace(/'/g, "''");
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

// ---------------------------------------------------------------------------------------------------------------
// Contact checks (no lookup)
// ---------------------------------------------------------------------------------------------------------------

const TOLL_FREE = new Set(['800', '833', '844', '855', '866', '877', '888']);
/**
 * 'ok', 'toll_free' or 'invalid' for a US phone number, null without one. Invalid: not 10 digits after the country
 * code, an area code or exchange starting with 0 or 1, an N11 service code, 555-01xx (reserved for fiction), one digit
 * repeated, or a counting run.
 */
export function phoneQuality(value) {
  if (value == null || String(value).trim() === '') return null;
  const p = normPhone(value);
  if (!p || p.length !== 10) return 'invalid';
  const area = p.slice(0, 3);
  const exch = p.slice(3, 6);
  if (/^[01]/.test(area) || /^[01]/.test(exch) || /^\d11$/.test(area) || /^\d11$/.test(exch)) return 'invalid';
  if (exch === '555' && p.slice(6, 8) === '01') return 'invalid';
  if (/^(\d)\1{9}$/.test(p) || p === '1234567890' || p === '0123456789' || /^(\d)\1{6}$/.test(p.slice(3))) return 'invalid';
  return TOLL_FREE.has(area) ? 'toll_free' : 'ok';
}

/** An email that belongs to a dispatch service or a dispatch desk ("dispatch@…", "…dispatching.com"). */
export function isDispatchEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return e.includes('@') && /dispatch/.test(e);
}

// ---------------------------------------------------------------------------------------------------------------
// Address mills
// ---------------------------------------------------------------------------------------------------------------

const UNIT = /\s+(?:STE|SUITE|UNIT|APT|APARTMENT|#|RM|ROOM|BLDG|BUILDING|FL|FLOOR|LOT|SPC|SPACE|TRLR|PMB|OFC|OFFICE|DEPT)\b.*$|\s+#.*$/;
/** Census street as stored (upper case, single spaces), or null for nothing worth matching (PO boxes, no number). */
export function streetKey(street) {
  const s = String(street || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!s || !/\d/.test(s) || !/[A-Z]{2}/.test(s) || /\bP\.?\s*O\.?\s*BOX\b/.test(s)) return null;
  return s;
}
/** The street without its suite, unit or apartment ("30 N GOULD ST STE R" -> "30 N GOULD ST"). */
export const baseStreet = (key) => (key ? key.replace(UNIT, '').trim() || key : null);
const zip5 = (z) => { const s = String(z || '').replace(/\D/g, '').slice(0, 5); return s.length === 5 ? s : null; };

/**
 * Carriers on each record's street. Map(dotNumber -> { exact, base, risky, checked }): exact = active carriers on the
 * very same street line, base = active carriers at the street address with any suite, risky = inactive or revoked
 * carriers on the very same line (the record itself not counted). Records without a usable street are { checked: true,
 * exact: 0 ... } (nothing to match); checked = false when the census did not answer.
 */
export async function addressCounts(recs, { cacheMs = 0 } = {}) {
  const out = new Map();
  const todo = new Map(); // "BASE|ZIP" -> { base, zip }
  for (const r of recs) {
    const key = streetKey(r.address);
    const zip = zip5(r.zip);
    if (!key || !zip) { out.set(r.dotNumber, { exact: 0, base: 0, risky: 0, checked: true, skipped: true }); continue; }
    const base = baseStreet(key);
    todo.set(`${base}|${zip}`, { base, zip });
  }
  const groups = new Map(); // "BASE|ZIP" -> [{ street, n, r }] | null (no answer)
  for (const part of chunks([...todo.values()], ADDRESS_BATCH)) {
    const where = part.map(({ base, zip }) => `(starts_with(phy_street,'${esc(base)}') AND starts_with(phy_zip,'${zip}'))`).join(' OR ');
    let rows = null;
    try {
      rows = await limited(() => censusQuery({
        $select: "phy_street as s, substring(phy_zip,1,5) as z, sum(case(status_code='A',1,true,0)) as n, sum(case(status_code!='A' OR prior_revoke_flag='Y',1,true,0)) as r",
        $where: where,
        $group: 'phy_street, substring(phy_zip,1,5)',
        $limit: '5000',
      }, fmcsaFetch, { cacheMs }));
    } catch { rows = null; }
    if (rows && rows.length >= 5000) rows = null; // cut off: no answer rather than a wrong count
    for (const { base, zip } of part) groups.set(`${base}|${zip}`, rows ? [] : null);
    for (const row of rows || []) {
      const street = streetKey(row.s);
      if (!street) continue;
      const k = `${baseStreet(street)}|${row.z}`;
      if (groups.has(k) && groups.get(k)) groups.get(k).push({ street, n: num(row.n), r: num(row.r) });
    }
  }
  for (const r of recs) {
    if (out.has(r.dotNumber)) continue;
    const key = streetKey(r.address);
    const list = groups.get(`${baseStreet(key)}|${zip5(r.zip)}`);
    if (!list) { out.set(r.dotNumber, { exact: 0, base: 0, risky: 0, checked: false }); continue; }
    const same = list.filter((g) => g.street === key);
    const self = r._extra?.facts?.priorRevoke ? 1 : 0;
    out.set(r.dotNumber, {
      exact: same.reduce((s, g) => s + g.n, 0),
      base: list.reduce((s, g) => s + g.n, 0),
      risky: Math.max(0, same.reduce((s, g) => s + g.r, 0) - self),
      checked: true,
    });
  }
  return out;
}

/** An address that registration agents, virtual offices or carrier farms use: many active carriers on it. */
export const isAddressMill = (a) => !!a?.checked && (a.exact >= MILL_EXACT || a.base >= MILL_BASE);

// ---------------------------------------------------------------------------------------------------------------
// On the road: roadside inspections
// ---------------------------------------------------------------------------------------------------------------

export const INSPECTIONS_URL = 'https://data.transportation.gov/resource/fx4q-ay7w.json';

/**
 * Roadside inspections per record. Map(dotNumber -> { n12, n24, last, checked }): inspections in the last 12 and 24
 * months and the latest date (YYYY-MM-DD). checked = false when the dataset did not answer.
 */
export async function roadActivity(recs, { now = new Date() } = {}) {
  const out = new Map();
  const since24 = ymd(new Date(now.getTime() - 730 * DAY));
  const since12 = ymd(new Date(now.getTime() - 365 * DAY));
  const dots = [...new Set(recs.map((r) => normDot(r.dotNumber)).filter(Boolean))];
  for (const part of chunks(dots, DOT_BATCH)) {
    const values = part.flatMap((d) => [`'${d}'`, `'${d.padStart(8, '0')}'`]);
    const rows = await sodaRows(INSPECTIONS_URL, `dot_number in(${values.join(',')}) AND insp_date>='${since24}'`, part.length * 2 + 10, 'inspection file', {
      select: `dot_number, count(*) as n24, sum(case(insp_date>='${since12}',1,true,0)) as n12, max(insp_date) as last`,
      group: 'dot_number',
    });
    for (const d of part) out.set(d, rows ? { n12: 0, n24: 0, last: null, checked: true } : { checked: false });
    for (const row of rows || []) {
      const d = normDot(row.dot_number);
      if (!out.has(d)) continue;
      const last = /^\d{8}$/.test(String(row.last || '')) ? `${row.last.slice(0, 4)}-${row.last.slice(4, 6)}-${row.last.slice(6, 8)}` : null;
      out.set(d, { n12: num(row.n12), n24: num(row.n24), last, checked: true });
    }
  }
  return new Map(recs.map((r) => [r.dotNumber, out.get(normDot(r.dotNumber)) || { checked: false }]));
}

// ---------------------------------------------------------------------------------------------------------------
// Step used by the lead generator and Find carriers
// ---------------------------------------------------------------------------------------------------------------

const withLead = (rec, patch) => ({ ...rec, _lead: { ...(rec._lead || {}), ...patch } });

/** Inactive or revoked carriers linked to a record, by what they share (after sharedContactStep and trustStep). */
export function linkedInactive(rec) {
  const by = [];
  let n = 0;
  const shared = rec._lead?.shared;
  if (shared?.risky > 0) { n += shared.risky; by.push(shared.riskyBy || 'phone or email'); }
  const addr = rec._lead?.address;
  if (addr?.risky > 0) { n += addr.risky; by.push('address'); }
  return { count: n, by };
}

/**
 * Trust step: annotates every record with its address counts and road activity, then drops address mills
 * (excludeAddressMills, on by default) and carriers linked to inactive or revoked ones (excludeLinkedInactive, off by
 * default). Returns { kept, excluded: { addressMill: [], linkedInactive: [] } }.
 */
export async function trustStep(recs, criteria, { cacheMs = 0, now = new Date() } = {}) {
  const excluded = { addressMill: [], linkedInactive: [] };
  if (!recs.length) return { kept: [], excluded };
  const f = normalizeLeadFilters(criteria);
  const addresses = await addressCounts(recs, { cacheMs });
  const kept = [];
  const candidates = [];
  for (const r of recs) {
    const rec = withLead(r, { address: addresses.get(r.dotNumber) || { checked: false } });
    if (f.excludeAddressMills && isAddressMill(rec._lead.address)) { excluded.addressMill.push(rec); continue; }
    if (f.excludeLinkedInactive && linkedInactive(rec).count > 0) { excluded.linkedInactive.push(rec); continue; }
    candidates.push(rec);
  }
  // Road activity only for the records still in the running.
  const activity = await roadActivity(candidates, { now });
  for (const rec of candidates) kept.push(withLead(rec, { activity: activity.get(rec.dotNumber) || { checked: false } }));
  return { kept, excluded };
}
