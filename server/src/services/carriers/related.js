import { HttpError } from '../../lib/errors.js';
import { normDot, normPhone } from './normalize.js';
import { census, day, buildProfile } from './profile.js';

/**
 * Related carriers: other USDOT numbers that share this carrier's phone, cell phone, email or street address in the
 * FMCSA Company Census (az4n-8mr2). It is the public data behind chameleon checks: a carrier that was shut down
 * and came back under a new USDOT number usually keeps its phone, email or yard.
 *
 * Shared contact details are a reason to look closer, never proof: family businesses, a fleet with several
 * authorities, and registration agents or factoring companies that put their own address on many filings all share
 * details legitimately. A detail shared by more than SERVICE_THRESHOLD carriers is reported as a likely service
 * company (counted, not listed). Flags are amber; nothing here is ever red on its own.
 */
const LIMIT = 60;
const SERVICE_THRESHOLD = 15;
const TTL_MS = 6 * 3600_000;
const CACHE_MAX = 300;
const USDOT_STATUS = { A: 'active', I: 'inactive', P: 'pending' };

const str = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};
const up = (v) => String(v ?? '').trim().toUpperCase();
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const titleCase = (s) => String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Census where-clauses for the contact details worth matching (empty when there is nothing distinctive). */
export function matchKeys(contact) {
  const keys = [];
  const phones = [...new Set([contact?.phone, contact?.cellPhone].map(normPhone).filter((p) => p && p.length === 10 && !/^(\d)\1{9}$/.test(p)))];
  if (phones.length) keys.push({ kind: 'phone', values: phones, where: `phone in(${phones.map(q).join(',')}) OR cell_phone in(${phones.map(q).join(',')})` });
  const email = str(contact?.email)?.toLowerCase();
  if (email && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) keys.push({ kind: 'email', values: [email], where: `email_address in(${q(email)},${q(email.toUpperCase())})` });
  const a = contact?.physicalAddress;
  const street = up(a?.street).replace(/\s+/g, ' ');
  const zip = String(a?.zip || '').slice(0, 5);
  // PO boxes and bare numbers are too common to mean anything.
  if (street && zip && /\d/.test(street) && /[A-Z]{2}/.test(street) && !/\bP\.?\s*O\.?\s*BOX\b/.test(street)) {
    keys.push({ kind: 'address', values: [street], where: `phy_street=${q(street)} AND starts_with(phy_zip,${q(zip)})` });
  }
  return keys;
}

/** Pure assembly from census rows (exported for tests). */
export function assembleRelated({ dot, contact, rows, now = new Date() }) {
  const keys = matchKeys(contact);
  const phones = new Set(keys.find((k) => k.kind === 'phone')?.values || []);
  const email = keys.find((k) => k.kind === 'email')?.values[0] || null;
  const street = keys.find((k) => k.kind === 'address')?.values[0] || null;
  const zip = String(contact?.physicalAddress?.zip || '').slice(0, 5);
  const seen = new Map();
  for (const r of rows) {
    const d = normDot(r.dot_number);
    if (!d || d === dot) continue;
    const reasons = [];
    if (phones.size && [normPhone(r.phone), normPhone(r.cell_phone)].some((p) => p && phones.has(p))) reasons.push('phone');
    if (email && str(r.email_address)?.toLowerCase() === email) reasons.push('email');
    if (street && up(r.phy_street).replace(/\s+/g, ' ') === street && String(r.phy_zip || '').startsWith(zip)) reasons.push('address');
    if (!reasons.length) continue;
    const prev = seen.get(d);
    if (prev) { prev.matches = [...new Set([...prev.matches, ...reasons])]; continue; }
    const docket = up(r.docket1prefix) === 'MC' && str(r.docket1) ? String(Number(r.docket1)) : null;
    seen.set(d, {
      dot: d,
      mc: docket,
      name: str(r.legal_name),
      dba: str(r.dba_name),
      city: str(r.phy_city) ? titleCase(r.phy_city) : null,
      state: str(r.phy_state),
      usdotStatus: USDOT_STATUS[up(r.status_code)] || null,
      registeredAt: day(r.add_date),
      powerUnits: Number.isFinite(Number(r.power_units)) && String(r.power_units ?? '').trim() !== '' ? Number(r.power_units) : null,
      priorRevoke: up(r.prior_revoke_flag) === 'Y',
      matches: reasons,
    });
  }
  const all = [...seen.values()];
  // A detail on many filings belongs to a service company (agent, factoring, accountant): count it, do not list it.
  const shared = {};
  for (const kind of ['phone', 'email', 'address']) shared[kind] = all.filter((x) => x.matches.includes(kind)).length;
  const serviceKinds = Object.keys(shared).filter((k) => shared[k] > SERVICE_THRESHOLD);
  const carriers = all
    .filter((x) => x.matches.some((m) => !serviceKinds.includes(m)))
    .sort((a, b) => b.matches.length - a.matches.length || String(b.registeredAt || '').localeCompare(String(a.registeredAt || '')));

  const flags = [];
  const inactive = carriers.filter((x) => x.usdotStatus === 'inactive' || x.priorRevoke);
  if (inactive.length) {
    const how = [...new Set(inactive.flatMap((x) => x.matches))].join(', ');
    flags.push({ level: 'amber', code: 'related_inactive', text: `Shares ${how} with ${inactive.length} inactive or revoked carrier${inactive.length === 1 ? '' : 's'}: check it is not a reincarnated carrier` });
  } else if (carriers.length) {
    flags.push({ level: 'gray', code: 'related_active', text: `Shares contact details with ${carriers.length} other carrier${carriers.length === 1 ? '' : 's'}` });
  }
  return {
    dot,
    fetchedAt: now.toISOString(),
    checked: keys.map((k) => k.kind),
    carriers: carriers.slice(0, 25),
    total: carriers.length,
    truncated: rows.length >= LIMIT,
    serviceShared: serviceKinds.map((k) => ({ kind: k, count: shared[k] })),
    flags,
  };
}

const cache = new Map();
export const clearRelatedCache = () => cache.clear();

/** Related carriers for a USDOT number. Uses the (cached) profile for the carrier's own contact details. */
export async function buildRelated(dotInput, { fresh = false } = {}) {
  const dot = normDot(dotInput);
  const hit = !fresh && cache.get(dot);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const profile = await buildProfile({ dot });
  const contact = profile.contact?.available ? profile.contact : null;
  const keys = matchKeys(contact);
  let rows = [];
  if (keys.length) {
    const where = `(${keys.map((k) => `(${k.where})`).join(' OR ')}) AND dot_number!=${q(dot)}`;
    try {
      rows = (await census(where, LIMIT)).rows;
    } catch (err) {
      throw new HttpError(502, `FMCSA census is not available right now: ${String(err?.message || err).slice(0, 160)}`);
    }
  }
  const value = assembleRelated({ dot, contact, rows });
  while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(dot, { at: Date.now(), value });
  return value;
}
