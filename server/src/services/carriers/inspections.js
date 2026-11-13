import { HttpError, badRequest } from '../../lib/errors.js';
import { normDot } from './normalize.js';
import { socrata, publicFetch, day } from './profile.js';

/**
 * Roadside inspections, violations, inspected vehicles and crashes for one USDOT number, from FMCSA MCMIS files
 * published on data.transportation.gov (updated daily, no key):
 *   fx4q-ay7w  Vehicle Inspection File        one row per inspection (date, state, level, violation and OOS counts)
 *   876r-jsdb  Vehicle Inspections and Violations   one row per violation (code, description, OOS, unit)
 *   wt8s-2hbx  Inspections Per Unit           one row per inspected unit (type, make, plate, VIN)
 *   aayw-vxb3  Crash File                     one row per reportable crash
 * Model year, make and model of inspected units come from NHTSA vPIC (VIN decoding, free, best effort).
 *
 * Rules (the same window and levels FMCSA uses):
 *   - 24 months back from today.
 *   - Vehicle OOS rate: inspections with a vehicle OOS violation / Level I, II, V and VI inspections.
 *     Driver OOS rate: driver OOS / Level I, II, III and VI. Hazmat OOS rate: hazmat OOS / placarded inspections.
 *   - A rate needs at least 5 inspections of its kind; fewer shows no rate (not 0%).
 *   - Totals and rates use every inspection in the window (server-side aggregates, so a 20,000-inspection fleet costs
 *     the same as a one-truck carrier). Violations by category, inspected vehicles and the record list use the 50 most
 *     recent inspections on file (the public file holds about 3 years); `detailCount` says how many that is.
 *   - Inspections by year cover everything in the public file, not only the 24-month window.
 *   - National averages: FMCSA's published averages (SAFER, Jan 2026) unless QCMobile returned newer ones.
 *
 * Every source is best effort: a failed part is reported in `sources` and its block is null, never a guess.
 * Reports are cached per process by USDOT number (6 h; 5 minutes when a part failed).
 */
const DS = { inspections: 'fx4q-ay7w', violations: '876r-jsdb', units: 'wt8s-2hbx', crashes: 'aayw-vxb3' };
const WINDOW_MONTHS = 24;
const DETAIL_LIMIT = 50;
const MIN_FOR_RATE = 5;
export const NATIONAL_AVG = { vehicle: 23.2, driver: 6.4, hazmat: 4.4, asOf: '2026-01-31' };
const VEHICLE_LEVELS = new Set(['1', '2', '5', '6']);
const DRIVER_LEVELS = new Set(['1', '2', '3', '6']);
const TTL_MS = 6 * 3600_000;
const PARTIAL_TTL_MS = 5 * 60_000;
const CACHE_MAX = 300;
const VPIC = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVINValuesBatch/';

const LEVEL = {
  1: 'Level I · full', 2: 'Level II · walk-around', 3: 'Level III · driver only', 4: 'Level IV · special study',
  5: 'Level V · vehicle only', 6: 'Level VI · radioactive', 7: 'Level VII · jurisdictional', 8: 'Level VIII · electronic',
};
const FACILITY = { R: 'Roadside', F: 'Fixed site' };
// MCMIS unit type codes seen on nearly every tractor-trailer and box-truck inspection. Anything else is labeled by
// its position (unit 1 = power unit) rather than guessed.
const UNIT_TYPE = { 11: 'Truck tractor', 10: 'Straight truck', 9: 'Semi-trailer' };
export const CATEGORY = {
  unsafe_driving: 'Unsafe driving', hos: 'Hours of service', driver_fitness: 'Driver fitness', drugs_alcohol: 'Drugs and alcohol',
  vehicle_maintenance: 'Vehicle maintenance', hazmat: 'Hazardous materials', other: 'Other',
};
const MAKES = {
  INTERNATIO: 'International', INTERNATIONAL: 'International', FREIGHTLIN: 'Freightliner', FREIGHTLINER: 'Freightliner', 'WESTERN ST': 'Western Star',
  'GREAT DANE': 'Great Dane', KENWORTH: 'Kenworth', PETERBILT: 'Peterbilt', VOLVO: 'Volvo', MACK: 'Mack', UTILITY: 'Utility', WABASH: 'Wabash',
  HYUNDAI: 'Hyundai', STOUGHTON: 'Stoughton', FONTAINE: 'Fontaine', 'GREAT DAN': 'Great Dane', VANGUARD: 'Vanguard', ISUZU: 'Isuzu', HINO: 'Hino',
  'BIG TEX': 'Big Tex', 'PJ TRAILE': 'PJ Trailers', 'LOAD TRAI': 'Load Trail', FORD: 'Ford', CHEVROLET: 'Chevrolet', RAM: 'Ram', DODGE: 'Dodge',
  // NCIC vehicle make codes that some states report instead of the name.
  FRHT: 'Freightliner', INTL: 'International', KENW: 'Kenworth', PTRB: 'Peterbilt', PTB: 'Peterbilt', PETE: 'Peterbilt', VOLV: 'Volvo',
  WSTR: 'Western Star', GDAN: 'Great Dane', UTIL: 'Utility', WABA: 'Wabash', HYUN: 'Hyundai', STOU: 'Stoughton', CHEV: 'Chevrolet', INTE: 'International',
};

const str = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};
const up = (v) => String(v ?? '').trim().toUpperCase();
const int = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return String(v ?? '').trim() !== '' && Number.isFinite(n) ? Math.round(n) : null;
};
const pct = (n, d) => (d >= MIN_FOR_RATE ? Math.round((n / d) * 1000) / 10 : null);
const errorText = (err) => String(err?.message || err || 'Unknown error').slice(0, 200);
const titleCase = (s) => String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
export const makeLabel = (v) => {
  const s = up(v);
  if (!s || /^0+$/.test(s)) return null;
  return MAKES[s] || titleCase(s);
};

/** SMS-style category of a violation from its CFR part and section (49 CFR). */
export function categoryOf(part, section) {
  const p = String(part ?? '').trim();
  const s = up(section);
  if (p === '395') return 'hos';
  if (p === '391' || p === '383') return 'driver_fitness';
  if (p === '382') return 'drugs_alcohol';
  if (p === '392') {
    if (/^[45](\D|$)/.test(s)) return 'drugs_alcohol'; // 392.4 drugs, 392.5 alcohol
    if (/^9(\D|$)/.test(s)) return 'vehicle_maintenance'; // 392.9 cargo securement counts as vehicle maintenance in SMS
    return 'unsafe_driving';
  }
  if (p === '393' || p === '396') return 'vehicle_maintenance';
  if (p === '397' || p === '107' || /^1(7[1-9]|80)$/.test(p)) return 'hazmat';
  return 'other';
}

const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';
/** Model year from the 10th VIN character (30-year cycle; the most recent year not after next year). */
export function yearFromVin(vin, now = new Date()) {
  const v = up(vin);
  if (v.length !== 17) return null;
  const i = YEAR_CODES.indexOf(v[9]);
  if (i < 0) return null;
  const max = now.getUTCFullYear() + 1;
  let y = 1980 + i;
  while (y + 30 <= max) y += 30;
  return y;
}

/** 'YYYYMMDD' of the day `months` months before `now` (UTC). */
function monthsAgo(now, months) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// ---------------------------------------------------------------------------------------------------------------
// VIN decoding (NHTSA vPIC), cached per process
// ---------------------------------------------------------------------------------------------------------------

const vinCache = new Map(); // vin -> { year, make, model, body } | null
const VIN_CACHE_MAX = 5000;

async function decodeChunk(want) {
  try {
    const res = await publicFetch(VPIC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ format: 'json', data: want.join(';') }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const body = res.ok ? await res.json().catch(() => null) : null;
    for (const r of body?.Results || []) {
      const vin = up(r.VIN);
      if (!vin) continue;
      const year = int(r.ModelYear);
      const out = { year: year && year > 1950 ? year : null, make: str(r.Make) ? titleCase(r.Make) : null, model: str(r.Model), body: str(r.BodyClass) };
      while (vinCache.size >= VIN_CACHE_MAX) vinCache.delete(vinCache.keys().next().value);
      vinCache.set(vin, out.year || out.make || out.model ? out : null);
    }
  } catch {
    // Best effort: units keep the make from the inspection report and the model year from the VIN.
  }
}

async function decodeVins(vins) {
  const want = [...new Set(vins.map(up).filter((v) => v.length === 17 && !vinCache.has(v)))].slice(0, 50);
  const chunks = [];
  for (let i = 0; i < want.length; i += 25) chunks.push(want.slice(i, i + 25));
  await Promise.all(chunks.map(decodeChunk));
  return new Map(vins.map((v) => [up(v), vinCache.get(up(v)) || null]));
}


// ---------------------------------------------------------------------------------------------------------------
// Assembly (pure; exported for tests)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Build the report from raw answers. `src` = { aggregate, states, recent, violations, units, crashAggregate, crashes }
 * where each is { ok, rows } or { ok: false, error }; `vins` maps VIN -> decoded vehicle.
 */
export function assembleInspections(src, { dot, now = new Date(), vins = new Map(), national = null } = {}) {
  const ok = (k) => !!src[k]?.ok;
  const rows = (k) => (ok(k) ? src[k].rows : []);
  const nat = national || NATIONAL_AVG;
  const since = monthsAgo(now, WINDOW_MONTHS);

  let summary = null;
  let byYear = null;
  let byMonth = null;
  if (ok('aggregate')) {
    const t = { inspections: 0, withViolations: 0, oos: 0, driver: [0, 0], vehicle: [0, 0], hazmat: [0, 0] };
    const years = new Map();
    const months = new Map();
    for (const r of rows('aggregate')) {
      const n = int(r.n) || 0;
      const level = String(r.insp_level_id ?? '').trim();
      const date = day(r.insp_date);
      t.inspections += n;
      t.withViolations += int(r.wv) || 0;
      t.oos += int(r.any_oos) || 0;
      if (DRIVER_LEVELS.has(level)) { t.driver[0] += n; t.driver[1] += int(r.d_oos) || 0; }
      if (VEHICLE_LEVELS.has(level)) { t.vehicle[0] += n; t.vehicle[1] += int(r.v_oos) || 0; }
      t.hazmat[0] += int(r.hm) || 0;
      t.hazmat[1] += int(r.hm_oos) || 0;
      if (date) {
        const m = months.get(date.slice(0, 7)) || { month: date.slice(0, 7), inspections: 0, oos: 0 };
        m.inspections += n;
        m.oos += int(r.any_oos) || 0;
        months.set(date.slice(0, 7), m);
      }
    }
    // Years: every inspection in the public file (about 3 years), so older ones still show for small carriers.
    for (const r of ok('yearly') ? rows('yearly') : rows('aggregate')) {
      const date = day(r.insp_date);
      if (!date) continue;
      const y = years.get(date.slice(0, 4)) || { year: Number(date.slice(0, 4)), inspections: 0, oos: 0 };
      y.inspections += int(r.n) || 0;
      y.oos += int(r.any_oos) || 0;
      years.set(date.slice(0, 4), y);
    }
    const rate = (k) => ({
      inspections: t[k][0],
      oos: t[k][1],
      oosRate: pct(t[k][1], t[k][0]),
      nationalAvg: nat[k] ?? null,
      aboveAverage: pct(t[k][1], t[k][0]) != null && nat[k] != null ? pct(t[k][1], t[k][0]) > nat[k] : null,
    });
    summary = {
      inspections: t.inspections,
      withViolations: t.withViolations,
      oosInspections: t.oos,
      cleanRate: t.inspections >= MIN_FOR_RATE ? Math.round(((t.inspections - t.withViolations) / t.inspections) * 1000) / 10 : null,
      driver: rate('driver'),
      vehicle: rate('vehicle'),
      hazmat: rate('hazmat'),
    };
    byYear = [...years.values()].sort((a, b) => b.year - a.year);
    byMonth = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  }

  const byState = ok('states')
    ? rows('states').map((r) => ({ state: str(r.report_state), inspections: int(r.n) || 0 })).filter((x) => x.state).sort((a, b) => b.inspections - a.inspections)
    : null;

  // Units and violations of the most recent inspections, keyed by inspection.
  const unitsByInsp = new Map();
  const unitById = new Map();
  for (const u of rows('units')) {
    const unit = {
      id: str(u.insp_unit_id),
      number: int(u.insp_unit_number) || 1,
      typeId: int(u.insp_unit_type_id),
      make: makeLabel(u.insp_unit_make),
      license: str(u.insp_unit_license) && !/^0+$/.test(String(u.insp_unit_license).trim()) ? up(u.insp_unit_license) : null,
      licenseState: str(u.insp_unit_license_state),
      vin: str(u.insp_unit_vehicle_id_number) && up(u.insp_unit_vehicle_id_number).length >= 6 ? up(u.insp_unit_vehicle_id_number) : null,
    };
    unit.type = UNIT_TYPE[unit.typeId] || (unit.number === 1 ? 'Power unit' : 'Trailer');
    const list = unitsByInsp.get(str(u.inspection_id)) || [];
    list.push(unit);
    unitsByInsp.set(str(u.inspection_id), list);
    if (unit.id) unitById.set(unit.id, unit);
  }
  const violsByInsp = new Map();
  const categories = Object.fromEntries(Object.keys(CATEGORY).map((k) => [k, { key: k, label: CATEGORY[k], violations: 0, oos: 0, inspections: new Set() }]));
  for (const v of rows('violations')) {
    const cat = categoryOf(v.part_no, v.part_no_section);
    const oosV = up(v.out_of_service_indicator) === 'Y';
    const item = {
      code: str(v.viol_code) || [str(v.part_no), str(v.part_no_section)].filter(Boolean).join('.'),
      description: str(v.viol_desc),
      category: cat,
      oos: oosV,
      unitId: str(v.insp_unit_id),
      citation: !!str(v.citation_number) && !/^0+$/.test(String(v.citation_number).trim()),
    };
    const list = violsByInsp.get(str(v.inspection_id)) || [];
    list.push(item);
    violsByInsp.set(str(v.inspection_id), list);
    categories[cat].violations += 1;
    if (oosV) categories[cat].oos += 1;
    categories[cat].inspections.add(str(v.inspection_id));
  }

  const recentRows = rows('recent');
  const records = ok('recent') ? recentRows.map((r) => {
    const id = str(r.inspection_id);
    const units = (unitsByInsp.get(id) || []).sort((a, b) => a.number - b.number);
    const viols = (violsByInsp.get(id) || []).map((v) => {
      const u = v.unitId ? unitById.get(v.unitId) : null;
      return { code: v.code, description: v.description, category: v.category, categoryLabel: CATEGORY[v.category], oos: v.oos, citation: v.citation, unit: u ? u.type : null };
    });
    return {
      id,
      date: day(r.insp_date),
      reportNumber: str(r.report_number),
      state: str(r.report_state),
      location: str(r.location_desc) ? titleCase(r.location_desc).replace(/\b([A-Z][a-z])$/, (m) => m.toUpperCase()) : null,
      level: int(r.insp_level_id),
      levelLabel: LEVEL[int(r.insp_level_id)] || null,
      facility: FACILITY[up(r.insp_facility)] || null,
      violations: int(r.viol_total) || 0,
      oosViolations: int(r.oos_total) || 0,
      driverOos: (int(r.driver_oos_total) || 0) > 0,
      vehicleOos: (int(r.vehicle_oos_total) || 0) > 0,
      hazmatOos: (int(r.hazmat_oos_total) || 0) > 0,
      hazmat: up(r.hazmat_placard_req) === 'Y',
      postCrash: up(r.post_acc_ind) === 'Y',
      units: units.map((u) => ({ type: u.type, make: u.make, license: u.license, licenseState: u.licenseState, vin: u.vin })),
      violationList: viols,
    };
  }) : null;

  // Vehicles seen at inspections: one row per VIN (or plate when the VIN is missing).
  let equipment = null;
  if (ok('units') && records) {
    const map = new Map();
    for (const rec of records) {
      const ids = (unitsByInsp.get(rec.id) || []);
      for (const u of ids) {
        const key = u.vin || (u.license ? `${u.license}|${u.licenseState || ''}` : null);
        if (!key) continue;
        const e = map.get(key) || { key, type: u.type, make: u.make, license: u.license, licenseState: u.licenseState, vin: u.vin, inspections: 0, oosInspections: 0, firstSeen: rec.date, lastSeen: rec.date };
        e.inspections += 1;
        if ((violsByInsp.get(rec.id) || []).some((v) => v.oos && v.unitId === u.id)) e.oosInspections += 1;
        if (rec.date && (!e.firstSeen || rec.date < e.firstSeen)) e.firstSeen = rec.date;
        if (rec.date && (!e.lastSeen || rec.date > e.lastSeen)) e.lastSeen = rec.date;
        if (!e.license && u.license) { e.license = u.license; e.licenseState = u.licenseState; }
        map.set(key, e);
      }
    }
    equipment = [...map.values()].map((e) => {
      const d = e.vin ? vins.get(e.vin) : null;
      return {
        type: e.type,
        year: d?.year || (e.vin ? yearFromVin(e.vin, now) : null),
        make: d?.make || e.make,
        model: d?.model || null,
        body: d?.body || null,
        decoded: !!d,
        license: e.license,
        licenseState: e.licenseState,
        vin: e.vin,
        inspections: e.inspections,
        oosInspections: e.oosInspections,
        firstSeen: e.firstSeen,
        lastSeen: e.lastSeen,
      };
    }).sort((a, b) => (a.type === b.type ? b.inspections - a.inspections : a.type.localeCompare(b.type) * -1));
  }

  const detailCount = records ? records.length : 0;
  const violationsByCategory = ok('violations') && records
    ? Object.values(categories).map((c) => ({ key: c.key, label: c.label, violations: c.violations, oos: c.oos, inspections: c.inspections.size })).filter((c) => c.violations > 0 || c.key !== 'other')
    : null;

  let crashes = null;
  if (ok('crashAggregate')) {
    const a = rows('crashAggregate')[0] || {};
    crashes = {
      total: int(a.n) || 0,
      fatal: int(a.fatal) || 0,
      injury: int(a.injury) || 0,
      tow: int(a.tow) || 0,
      records: ok('crashes') ? rows('crashes').map((c) => ({
        date: day(c.report_date),
        state: str(c.state) || str(c.report_state),
        city: str(c.city) ? titleCase(c.city) : null,
        location: str(c.location),
        fatalities: int(c.fatalities) || 0,
        injuries: int(c.injuries) || 0,
        towAway: up(c.tow_away) === 'Y',
        hazmatReleased: up(c.hazmat_released) === 'Y',
        vehicles: int(c.vehicles_in_accident),
        reportNumber: str(c.report_number),
      })) : null,
    };
  }

  const flags = [];
  if (summary) {
    for (const [k, labelText] of [['vehicle', 'Vehicle'], ['driver', 'Driver'], ['hazmat', 'Hazmat']]) {
      const x = summary[k];
      if (x.oosRate != null && x.nationalAvg != null && x.oosRate > x.nationalAvg) {
        flags.push({ level: x.oosRate >= x.nationalAvg * 2 ? 'red' : 'amber', code: `oos_${k}`, text: `${labelText} out-of-service rate ${x.oosRate}% vs ${x.nationalAvg}% national average (${x.inspections} inspections, 24 months)` });
      }
    }
    if (summary.inspections === 0) flags.push({ level: 'gray', code: 'no_inspections', text: 'No roadside inspections in the last 24 months' });
  }
  if (crashes?.fatal) flags.push({ level: 'red', code: 'fatal_crash', text: `${crashes.fatal} fatal crash${crashes.fatal === 1 ? '' : 'es'} in the last 24 months` });
  else if (crashes?.total) flags.push({ level: 'amber', code: 'crashes', text: `${crashes.total} reportable crash${crashes.total === 1 ? '' : 'es'} in the last 24 months` });

  const sources = Object.entries({
    aggregate: ['Inspection totals', DS.inspections], yearly: ['Inspections by year', DS.inspections], states: ['Inspections by state', DS.inspections], recent: ['Recent inspections', DS.inspections],
    violations: ['Violations', DS.violations], units: ['Inspected vehicles', DS.units], crashAggregate: ['Crash totals', DS.crashes], crashes: ['Recent crashes', DS.crashes],
  }).map(([key, [name, dataset]]) => ({ key, name, dataset, url: `https://data.transportation.gov/d/${dataset}`, ok: ok(key), error: ok(key) ? null : src[key]?.error || null }));

  return {
    dot,
    fetchedAt: now.toISOString(),
    windowMonths: WINDOW_MONTHS,
    since: day(since),
    minForRate: MIN_FOR_RATE,
    nationalAvgAsOf: nat.asOf || null,
    complete: sources.every((s) => s.ok),
    summary,
    byYear,
    byMonth,
    byState,
    violationsByCategory,
    detailCount,
    records,
    equipment,
    crashes,
    flags,
    sources,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------------------------------------------

const cache = new Map();
const inflight = new Map();
export function clearInspectionCache() {
  cache.clear();
  inflight.clear();
  vinCache.clear();
}
export function peekInspections(dot) {
  const hit = cache.get(dot);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) { cache.delete(dot); return null; }
  return hit.value;
}

/** One retry after a short pause for network blips and rate limits (several calls start at once). */
async function query(dataset, opts) {
  try {
    return await socrata(dataset, opts);
  } catch (err) {
    if (!/Unreachable|Rate limited|Timed out|Answered 5\d\d/.test(String(err?.message))) throw err;
    await new Promise((resolve) => { setTimeout(resolve, 800); });
    return socrata(dataset, opts);
  }
}
const settle = (p) => p.then((v) => ({ ok: true, rows: v.rows }), (err) => ({ ok: false, error: errorText(err) }));
const idList = (ids) => ids.map((x) => `'${String(x).replace(/[^\d]/g, '')}'`).join(',');

/** Run tasks at most `max` at a time (data.transportation.gov drops bursts of parallel calls). */
async function limited(max, thunks) {
  const out = new Array(thunks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(max, thunks.length) }, async () => {
    while (next < thunks.length) {
      const i = next++;
      out[i] = await thunks[i]();
    }
  }));
  return out;
}

async function fetchAll(dot, now) {
  const since = monthsAgo(now, WINDOW_MONTHS);
  const byDot = `dot_number in('${dot}','${dot.padStart(8, '0')}')`;
  const where = `${byDot} AND insp_date>='${since}'`;
  const crashWhere = `${byDot} AND report_date>='${since}'`;
  const [aggregate, recent, yearly, states, crashAggregate, crashes] = await limited(3, [
    () => settle(query(DS.inspections, {
      where,
      select: [
        'insp_date', 'insp_level_id', 'count(*) as n',
        "sum(case(driver_oos_total>'0',1,true,0)) as d_oos",
        "sum(case(vehicle_oos_total>'0',1,true,0)) as v_oos",
        "sum(case(oos_total>'0',1,true,0)) as any_oos",
        "sum(case(hazmat_placard_req='Y',1,true,0)) as hm",
        "sum(case(hazmat_placard_req='Y' AND hazmat_oos_total>'0',1,true,0)) as hm_oos",
        "sum(case(viol_total>'0',1,true,0)) as wv",
      ].join(','),
      group: 'insp_date,insp_level_id',
      limit: 5000,
    })),
    // The most recent inspections on file, not only the 24-month window: a small carrier's older stops still show.
    () => settle(query(DS.inspections, {
      where: byDot,
      select: 'inspection_id,insp_date,report_number,report_state,location_desc,insp_level_id,insp_facility,viol_total,oos_total,driver_oos_total,vehicle_oos_total,hazmat_oos_total,hazmat_placard_req,post_acc_ind',
      order: 'insp_date DESC,inspection_id DESC',
      limit: DETAIL_LIMIT,
    })),
    () => settle(query(DS.inspections, { where: byDot, select: "insp_date,count(*) as n,sum(case(oos_total>'0',1,true,0)) as any_oos", group: 'insp_date', limit: 5000 })),
    () => settle(query(DS.inspections, { where, select: 'report_state,count(*) as n', group: 'report_state', order: 'n DESC', limit: 80 })),
    () => settle(query(DS.crashes, {
      where: crashWhere,
      select: "count(*) as n,sum(case(fatalities>'0',1,true,0)) as fatal,sum(case(injuries>'0',1,true,0)) as injury,sum(case(tow_away='Y',1,true,0)) as tow",
      limit: 1,
    })),
    () => settle(query(DS.crashes, {
      where: crashWhere,
      select: 'report_date,report_number,report_state,state,city,location,fatalities,injuries,tow_away,hazmat_released,vehicles_in_accident',
      order: 'report_date DESC',
      limit: 25,
    })),
  ]);
  const src = { aggregate, recent, yearly, states, crashAggregate, crashes };
  const ids = recent.ok ? recent.rows.map((r) => r.inspection_id).filter(Boolean) : [];
  if (ids.length) {
    const [violations, units] = await limited(2, [
      () => settle(query(DS.violations, { where: `inspection_id in(${idList(ids)})`, select: 'inspection_id,insp_unit_id,part_no,part_no_section,viol_code,viol_desc,out_of_service_indicator,citation_number,seq_no', order: 'inspection_id,seq_no', limit: 2000 })),
      () => settle(query(DS.units, { where: `inspection_id in(${idList(ids)})`, select: 'inspection_id,insp_unit_id,insp_unit_type_id,insp_unit_number,insp_unit_make,insp_unit_license,insp_unit_license_state,insp_unit_vehicle_id_number', limit: 500 })),
    ]);
    src.violations = violations;
    src.units = units;
  } else {
    // No inspection on file: nothing to look up, which is an answer, not a failure.
    src.violations = recent.ok ? { ok: true, rows: [] } : { ok: false, error: 'Recent inspections not available' };
    src.units = src.violations;
  }
  const vins = src.units.ok ? await decodeVins(src.units.rows.map((u) => u.insp_unit_vehicle_id_number).filter(Boolean)) : new Map();
  return { src, vins };
}

/** Inspection and crash report for a USDOT number. `national` overrides the national averages (QCMobile's). */
export async function buildInspections(dotInput, { fresh = false, now, national = null } = {}) {
  const dot = normDot(dotInput);
  if (!dot || dot.length > 9) throw badRequest('Enter a USDOT number');
  if (!fresh) {
    const hit = peekInspections(dot);
    if (hit) return hit;
  }
  if (inflight.has(dot)) return inflight.get(dot);
  const p = (async () => {
    const at = now || new Date();
    const { src, vins } = await fetchAll(dot, at);
    if (!src.aggregate.ok && !src.recent.ok && !src.crashAggregate.ok) {
      throw new HttpError(502, `FMCSA inspection data is not available right now. Try again in a few minutes. (${src.aggregate.error || 'no answer'})`);
    }
    const report = assembleInspections(src, { dot, now: at, vins, national });
    while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(dot, { at: Date.now(), ttl: report.complete ? TTL_MS : PARTIAL_TTL_MS, value: report });
    return report;
  })().finally(() => inflight.delete(dot));
  inflight.set(dot, p);
  return p;
}
