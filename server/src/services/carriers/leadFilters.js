import { z } from '../../lib/validate.js';

/**
 * Lead filters shared by the lead generator (criteria JSON) and Find carriers (query string), so the two never drift
 * apart. Filters the Company Census can answer go into its SoQL query (fmcsaCensus.buildWhere); the others are applied
 * to each fetched page (postFilter below, then the batched lookups in leadSignals.js).
 *
 * Census-side (SoQL): ZIP prefixes, county (FIPS code), interstate only, for-hire only, hazmat, drivers, CDL drivers,
 *   MCS-150 updated within N months, safety ratings to exclude, cell phone required, cell phone or email required,
 *   cargo-based equipment.
 * Page-side: miles per truck, equipment inferred from vehicle counts (hotshot, box truck), free-mail / company email,
 *   and (re-checked) every census-side filter, so a census answer that ignored part of the query never leaks through.
 * Lookups (leadSignals.js): shared contacts, MC age from authority history, insurer of the current BIPD policy.
 */

export const EQUIPMENT_TYPES = Object.freeze({
  dry_van: 'Dry van', reefer: 'Reefer', flatbed: 'Flatbed', car_hauler: 'Car hauler', tanker: 'Tanker', hotshot: 'Hotshot', box_truck: 'Box truck',
});
export const RATING_CODES = Object.freeze({ U: 'Unsatisfactory', C: 'Conditional' });
/** Insurer suggestions for the autocomplete (the most common BIPD writers in FMCSA's Motus insurance data). */
export const COMMON_INSURERS = Object.freeze([
  'Progressive', 'Great West', 'GEICO', 'Northland', 'Canal', 'National Interstate', 'Berkshire Hathaway', 'Sentry', 'Old Republic',
  'Accredited', 'Universal Casualty', 'Acuity', 'Lancer', 'Occidental Fire', 'Berkley', 'CarrierGuard', 'Highlander', 'Southlake',
  'MS Transverse', 'Star Mutual', 'Auto-Owners', 'Trisura', 'Arch', 'Hallmark', 'Prime Insurance',
]);

/** Comma lists and repeated query parameters both become arrays; empty items are dropped. */
const splitList = (v) => {
  if (v == null || v === '') return undefined;
  const items = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','));
  return items.map((s) => s.trim()).filter(Boolean);
};
const list = (item, max) => z.preprocess(splitList, z.array(item).max(max).optional());
const bool = (def) => z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v === '' ? undefined : v), z.boolean().optional()).transform((v) => v ?? def);
const count = (max) => z.preprocess((v) => (v === '' || v == null ? null : v), z.coerce.number().int().min(0).max(max).nullable()).optional();

/** Zod shapes of the shared filters (no state, cargo, fleet size or contact basics: each screen has its own). */
export const leadFilterFields = {
  zipPrefixes: list(z.string().regex(/^\d{3,5}$/, 'ZIP prefixes are 3 to 5 digits'), 20),
  counties: list(z.string().regex(/^\d{1,3}$/, 'Counties are FIPS county codes (up to 3 digits)').transform((s) => s.padStart(3, '0')), 20),
  interstateOnly: bool(false),
  forHireOnly: bool(false),
  hazmat: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.enum(['any', 'yes', 'no']).optional()).transform((v) => v ?? 'any'),
  minDrivers: count(100000),
  maxDrivers: count(100000),
  minCdlDrivers: count(100000),
  maxMilesPerTruck: count(500000),
  mcs150WithinMonths: count(120),
  // Default: exclude Unsatisfactory. 'none' (a query string cannot send an empty list) excludes nothing.
  excludeRatings: z.preprocess(splitList, z.array(z.enum(['U', 'C', 'none'])).max(3).optional())
    .transform((v) => (v == null ? ['U'] : [...new Set(v.filter((x) => x !== 'none'))].sort())),
  mcAgeMinDays: count(36500),
  mcAgeMaxDays: count(36500),
  requireCell: bool(false),
  requireCellOrEmail: bool(false),
  excludeSharedContacts: bool(true),
  excludeEmail: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.enum(['none', 'free', 'corporate']).optional()).transform((v) => v ?? 'none'),
  equipment: list(z.enum(Object.keys(EQUIPMENT_TYPES)), 7).transform((v) => v ?? []),
  insurers: list(z.string().max(60), 20).transform((v) => (v ?? []).map((s) => s.trim()).filter(Boolean)),
  insurerMode: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.enum(['include', 'exclude']).optional()).transform((v) => v ?? 'include'),
};

/** Range checks shared by both schemas (call on a parsed object; returns [{ path, message }]). */
export function leadFilterIssues(c) {
  const out = [];
  const range = (lo, hi, path, message) => { if (c[lo] != null && c[hi] != null && c[lo] > c[hi]) out.push({ path, message }); };
  range('minDrivers', 'maxDrivers', 'minDrivers', 'Minimum drivers is above the maximum');
  range('mcAgeMinDays', 'mcAgeMaxDays', 'mcAgeMinDays', 'Minimum MC age is above the maximum');
  return out;
}

/** Add leadFilterIssues to a zod object schema (both screens use this, so the rules match). */
export const withLeadFilterChecks = (schema) => schema.superRefine((c, ctx) => {
  for (const i of leadFilterIssues(c)) ctx.addIssue({ code: 'custom', path: [i.path], message: i.message });
});

const n = (v) => (v == null || v === '' ? null : Number(v));
/**
 * The shared filters of a stored criteria object with every default filled in (old generators have none of these keys).
 * Used for the crawl hash, so a criteria object with and without explicit defaults hash the same.
 */
export function normalizeLeadFilters(c = {}) {
  const sorted = (v) => [...new Set((v || []).map(String))].sort();
  return {
    zipPrefixes: sorted(c.zipPrefixes),
    counties: sorted(c.counties).map((s) => s.padStart(3, '0')),
    interstateOnly: !!c.interstateOnly,
    forHireOnly: !!c.forHireOnly,
    hazmat: c.hazmat === 'yes' || c.hazmat === 'no' ? c.hazmat : 'any',
    minDrivers: n(c.minDrivers), maxDrivers: n(c.maxDrivers), minCdlDrivers: n(c.minCdlDrivers),
    maxMilesPerTruck: n(c.maxMilesPerTruck),
    mcs150WithinMonths: n(c.mcs150WithinMonths),
    excludeRatings: Array.isArray(c.excludeRatings) ? sorted(c.excludeRatings) : ['U'],
    mcAgeMinDays: n(c.mcAgeMinDays), mcAgeMaxDays: n(c.mcAgeMaxDays),
    requireCell: !!c.requireCell,
    requireCellOrEmail: !!c.requireCellOrEmail,
    excludeSharedContacts: c.excludeSharedContacts !== false,
    excludeEmail: c.excludeEmail === 'free' || c.excludeEmail === 'corporate' ? c.excludeEmail : 'none',
    equipment: sorted(c.equipment),
    insurers: sorted((c.insurers || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean)),
    insurerMode: c.insurerMode === 'exclude' ? 'exclude' : 'include',
  };
}

const DAY = 86_400_000;
const monthsAgo = (m, now = new Date()) => { const d = new Date(now); d.setMonth(d.getMonth() - m); return d; };
// MC authority is granted after the USDOT registration, so "MC at least N days old" means "registered at least N days
// ago". The maximum has no exact census form (an old USDOT number can get a new MC); the crawl is limited to USDOT
// numbers registered within the maximum plus this slack, which keeps it on recent registrations.
export const MC_AGE_SLACK_DAYS = 730;

/** Census search filters (fmcsaCensus.buildWhere keys) for the shared filters and the authority age in months. */
export function censusLeadFilters(c, now = new Date()) {
  const f = normalizeLeadFilters(c);
  const out = {
    zipPrefixes: f.zipPrefixes, counties: f.counties, interstateOnly: f.interstateOnly, forHireOnly: f.forHireOnly, hazmat: f.hazmat,
    minDrivers: f.minDrivers ?? undefined, maxDrivers: f.maxDrivers ?? undefined, minCdlDrivers: f.minCdlDrivers ?? undefined,
    mcs150After: f.mcs150WithinMonths != null ? monthsAgo(f.mcs150WithinMonths, now) : undefined,
    excludeRatings: f.excludeRatings,
    hasCell: f.requireCell,
    hasCellOrEmail: f.requireCellOrEmail,
    equipmentCargo: cargoForEquipmentFilter(f.equipment),
  };
  // USDOT registration window: the census "authority age" in months (registration date) and the MC age in days
  // combine; the narrower bound wins.
  const before = [
    f.mcAgeMinDays != null && new Date(now.getTime() - f.mcAgeMinDays * DAY),
    n(c.authorityAgeMinMonths) != null && monthsAgo(n(c.authorityAgeMinMonths), now),
  ].filter(Boolean);
  const after = [
    f.mcAgeMaxDays != null && new Date(now.getTime() - (f.mcAgeMaxDays + MC_AGE_SLACK_DAYS) * DAY),
    n(c.authorityAgeMaxMonths) != null && monthsAgo(n(c.authorityAgeMaxMonths), now),
  ].filter(Boolean);
  if (before.length) out.addedBefore = new Date(Math.min(...before.map(Number)));
  if (after.length) out.addedAfter = new Date(Math.max(...after.map(Number)));
  return out;
}

// Census cargo classes behind each equipment type the census can imply by cargo alone.
const EQUIPMENT_CARGO = {
  reefer: ['crgo_coldfood', 'crgo_meat', 'crgo_produce'],
  flatbed: ['crgo_logpole', 'crgo_bldgmat', 'crgo_metalsheet', 'crgo_machlrg'],
  car_hauler: ['crgo_motoveh', 'crgo_drivetow'],
  tanker: ['crgo_liqgas', 'crgo_chem'],
  dry_van: ['crgo_genfreight', 'crgo_paperprod', 'crgo_beverages'],
};
/**
 * Cargo classes for an equipment filter, or [] when the filter needs vehicle counts (hotshot, box truck): those are
 * checked on the page only, and then no cargo condition may narrow the census query.
 */
export function cargoForEquipmentFilter(equipment = []) {
  if (!equipment.length || equipment.some((e) => !EQUIPMENT_CARGO[e])) return [];
  return [...new Set(equipment.flatMap((e) => EQUIPMENT_CARGO[e]))];
}

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'protonmail.com', 'proton.me', 'gmx.com', 'mail.com', 'zoho.com', 'yandex.com', 'comcast.net', 'att.net',
  'sbcglobal.net', 'bellsouth.net', 'verizon.net', 'charter.net', 'cox.net', 'earthlink.net',
]);
const FREE_MAIL_NAMES = { 'gmail.com': 'Gmail', 'googlemail.com': 'Gmail', 'yahoo.com': 'Yahoo', 'ymail.com': 'Yahoo', 'outlook.com': 'Outlook', 'hotmail.com': 'Hotmail', 'live.com': 'Outlook', 'icloud.com': 'iCloud', 'me.com': 'iCloud', 'aol.com': 'AOL' };
/** 'free' (Gmail, Yahoo, Outlook, iCloud, AOL...: an owner-run small carrier), 'corporate', or null without an email. */
export function emailKind(email) {
  const domain = String(email || '').toLowerCase().split('@')[1]?.trim();
  if (!domain) return null;
  return FREE_MAIL.has(domain) || /^yahoo\.[a-z.]+$/.test(domain) || /^hotmail\.[a-z.]+$/.test(domain) ? 'free' : 'corporate';
}
export const freeMailName = (email) => FREE_MAIL_NAMES[String(email || '').toLowerCase().split('@')[1]] || 'Free email';

/** Miles per power unit from the MCS-150 mileage, only when it covers a full recent year (null otherwise). */
export function milesPerTruck(facts, now = new Date()) {
  const year = facts?.mileageYear;
  const miles = facts?.mileage;
  const units = facts?.powerUnits;
  const thisYear = now.getUTCFullYear();
  // The current year's figure is a partial year (new carriers report 0 or 1); older than two years says little now.
  if (!year || year >= thisYear || year < thisYear - 2 || !miles || miles < 1000 || !units || units < 1) return null;
  return Math.round(miles / units);
}

/**
 * Page-side check of one mapped census record against the shared filters. Returns null when it passes, otherwise the
 * reason: 'unsafe' (an excluded safety rating) or 'filtered' (anything else).
 */
export function postFilter(rec, c, now = new Date()) {
  const f = normalizeLeadFilters(c);
  const x = rec._extra?.facts || {};
  if (x.safetyRating && f.excludeRatings.includes(x.safetyRating)) return 'unsafe';
  const zip = String(rec.zip || '').replace(/\D/g, '');
  if (f.zipPrefixes.length && !f.zipPrefixes.some((p) => zip.startsWith(p))) return 'filtered';
  if (f.counties.length && !f.counties.includes(String(x.county || '').padStart(3, '0'))) return 'filtered';
  if (f.interstateOnly && x.operation !== 'A') return 'filtered';
  if (f.forHireOnly && !x.forHire) return 'filtered';
  if (f.hazmat === 'yes' && !x.hazmat) return 'filtered';
  if (f.hazmat === 'no' && x.hazmat) return 'filtered';
  const drivers = x.drivers ?? null;
  if (f.minDrivers != null && !(drivers != null && drivers >= f.minDrivers)) return 'filtered';
  if (f.maxDrivers != null && !(drivers != null && drivers <= f.maxDrivers)) return 'filtered';
  if (f.minCdlDrivers != null && !(x.cdlDrivers != null && x.cdlDrivers >= f.minCdlDrivers)) return 'filtered';
  if (f.mcs150WithinMonths != null) {
    const since = monthsAgo(f.mcs150WithinMonths, now);
    if (!(x.mcs150Date && new Date(`${x.mcs150Date}T00:00:00Z`) >= new Date(since.toISOString().slice(0, 10)))) return 'filtered';
  }
  if (f.maxMilesPerTruck != null) {
    const mpt = milesPerTruck(x, now);
    if (mpt == null || mpt > f.maxMilesPerTruck) return 'filtered';
  }
  if (f.requireCell && !x.cellPhone) return 'filtered';
  if (f.requireCellOrEmail && !x.cellPhone && !rec.email) return 'filtered';
  if (f.equipment.length && !f.equipment.some((e) => (x.equipment || []).includes(e))) return 'filtered';
  if (f.excludeEmail !== 'none' && emailKind(rec.email) === f.excludeEmail) return 'filtered';
  return null;
}

/** Playbook scoring weights per group (they always add up to 100). */
export const DEFAULT_WEIGHTS = Object.freeze({ need: 35, fit: 25, reach: 25, quality: 15 });

/**
 * Playbooks: one-click presets. `criteria` replaces the filters of the form (states stay); `weights` shift the score
 * toward what the playbook is about; `minScore` is the suggested minimum. The user can change anything afterwards.
 */
export const PLAYBOOKS = Object.freeze([
  {
    key: 'new_mc_launch', title: 'New MC launch',
    why: 'MC granted 30–120 days ago. Brokers often turn them away, so they need a dispatcher most.',
    sets: '1–5 trucks · MC 30–120 days · cell phone or email',
    criteria: { minPowerUnits: 1, maxPowerUnits: 5, mcAgeMinDays: 30, mcAgeMaxDays: 120, requireMc: true, requireCellOrEmail: true, interstateOnly: true },
    weights: { need: 45, fit: 20, reach: 25, quality: 10 }, minScore: 55,
  },
  {
    key: 'broker_ready', title: 'Broker-ready 90–180 days',
    why: 'Crossing the authority age many brokers require: the moment they can finally book better freight.',
    sets: '1–10 trucks · MC 90–180 days · phone',
    criteria: { minPowerUnits: 1, maxPowerUnits: 10, mcAgeMinDays: 90, mcAgeMaxDays: 180, requireMc: true, requirePhone: true, interstateOnly: true },
    weights: { need: 40, fit: 25, reach: 25, quality: 10 }, minScore: 55,
  },
  {
    key: 'owner_operators', title: 'Owner-operators by equipment',
    why: 'One to three trucks and the owner drives: the classic dispatch customer. Pick the equipment you book.',
    sets: '1–3 trucks · interstate for-hire · pick equipment',
    criteria: { minPowerUnits: 1, maxPowerUnits: 3, interstateOnly: true, forHireOnly: true, requireMc: true, requirePhone: true, equipment: ['dry_van'] },
    weights: { need: 30, fit: 35, reach: 25, quality: 10 }, minScore: 55, pickEquipment: true,
  },
  {
    key: 'underused_trucks', title: 'Underused trucks',
    why: 'Fewer than 60,000 miles per truck last year: trucks sitting idle need more loads.',
    sets: '1–10 trucks · under 60k mi per truck',
    criteria: { minPowerUnits: 1, maxPowerUnits: 10, maxMilesPerTruck: 60000, requireMc: true, requirePhone: true },
    weights: { need: 40, fit: 25, reach: 25, quality: 10 }, minScore: 50,
  },
  {
    key: 'growing_fleets', title: 'Growing small fleets',
    why: 'Four to fifteen trucks with a fresh MCS-150: active businesses adding trucks faster than they can book them.',
    sets: '4–15 trucks · MCS-150 updated in 6 months',
    criteria: { minPowerUnits: 4, maxPowerUnits: 15, mcs150WithinMonths: 6, requireMc: true, requirePhone: true },
    weights: { need: 30, fit: 30, reach: 25, quality: 15 }, minScore: 50,
  },
  {
    key: 'reefer', title: 'Reefer specialists',
    why: 'Refrigerated carriers: higher rates and steady produce and food freight to book.',
    sets: '1–10 trucks · reefer',
    criteria: { minPowerUnits: 1, maxPowerUnits: 10, equipment: ['reefer'], requireMc: true, requirePhone: true },
    weights: { need: 30, fit: 35, reach: 25, quality: 10 }, minScore: 50,
  },
  {
    key: 'flatbed', title: 'Flatbed specialists',
    why: 'Flatbed and step-deck carriers hauling building materials, steel and machinery.',
    sets: '1–10 trucks · flatbed',
    criteria: { minPowerUnits: 1, maxPowerUnits: 10, equipment: ['flatbed'], requireMc: true, requirePhone: true },
    weights: { need: 30, fit: 35, reach: 25, quality: 10 }, minScore: 50,
  },
  {
    key: 'hotshot_box', title: 'Hotshot / box truck',
    why: 'Straight trucks only (no tractors): hotshots pull a trailer, box trucks do not. Inferred from FMCSA vehicle counts.',
    sets: '1–5 trucks · straight trucks only',
    criteria: { minPowerUnits: 1, maxPowerUnits: 5, equipment: ['hotshot', 'box_truck'], requireMc: true, requirePhone: true },
    weights: { need: 35, fit: 30, reach: 25, quality: 10 }, minScore: 50,
  },
  {
    key: 'all_small', title: 'All active small carriers',
    why: 'Every small carrier with active authority and a phone: the widest net, ranked by the lead score.',
    sets: '1–10 trucks · phone',
    criteria: { minPowerUnits: 1, maxPowerUnits: 10, requireMc: true, requirePhone: true },
    weights: { ...DEFAULT_WEIGHTS }, minScore: 40,
  },
]);
export const PLAYBOOK_KEYS = PLAYBOOKS.map((p) => p.key);
export const playbookByKey = (key) => PLAYBOOKS.find((p) => p.key === key) || null;
/** Scoring weights for a criteria object (its playbook's, or the defaults). */
export const weightsFor = (c) => playbookByKey(c?.playbook)?.weights || DEFAULT_WEIGHTS;

/** Defaults of every filter a playbook may set: applying a playbook first resets these, then sets its own. */
export const PLAYBOOK_RESET = Object.freeze({
  cargo: [], minPowerUnits: null, maxPowerUnits: null, authorityAgeMinMonths: null, authorityAgeMaxMonths: null,
  requirePhone: false, requireEmail: false, requireMc: true, activeOnly: true,
  zipPrefixes: [], counties: [], interstateOnly: false, forHireOnly: false, hazmat: 'any', minDrivers: null, maxDrivers: null, minCdlDrivers: null,
  maxMilesPerTruck: null, mcs150WithinMonths: null, excludeRatings: ['U'], mcAgeMinDays: null, mcAgeMaxDays: null, requireCell: false,
  requireCellOrEmail: false, excludeSharedContacts: true, excludeEmail: 'none', equipment: [], insurers: [], insurerMode: 'include',
});
/** Criteria a playbook produces on top of `base` (states and anything outside the filters stay). */
export function applyPlaybook(key, base = {}) {
  const p = playbookByKey(key);
  if (!p) return { ...base };
  return { ...base, ...PLAYBOOK_RESET, ...structuredClone(p.criteria), playbook: p.key };
}
/** Public shape for the client. */
export const playbookView = (p) => ({ key: p.key, title: p.title, why: p.why, sets: p.sets, criteria: applyPlaybook(p.key), weights: p.weights, minScore: p.minScore, pickEquipment: !!p.pickEquipment });
