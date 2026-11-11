/**
 * Client mirror of server/src/services/loads/fit.js (carrier-rules check and negotiation numbers).
 * Everything below the SHARED marker must stay identical to the server file; server/tests/loadFit.test.js compares
 * them. Edit the server file first, then copy the shared part here.
 */

// ---- SHARED (identical in client/src/components/dispatch/fit.js) ----
const DAY_NAMES = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
const DAY_KEYS = Object.keys(DAY_NAMES);
const dayFormatters = new Map();

const toNum = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const usd = (dollarsValue, digits = 2) => `$${Number(dollarsValue).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const usdCents = (cents) => usd(Math.round(cents) / 100, 0);
const lbs = (n) => `${Math.round(n).toLocaleString('en-US')} lb`;
const miles = (n) => `${Math.round(n).toLocaleString('en-US')} mi`;
const words = (s) => String(s || '').replace(/_/g, ' ');

/** Comma/space separated list into normalized tokens ("FL, ga" -> ['FL', 'GA']). */
export function listOf(value, { upper = false } = {}) {
  return String(value || '')
    .split(/[\s,;/]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (upper ? s.toUpperCase() : s));
}

/** Three-letter weekday ('Sat') of a date in a time zone (UTC when unknown). A plain 'YYYY-MM-DD' is a calendar day. */
export function weekdayOf(date, tz) {
  if (!date) return null;
  const plainDay = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const d = new Date(plainDay ? `${date}T12:00:00Z` : date);
  if (Number.isNaN(d.getTime())) return null;
  const zone = plainDay ? 'UTC' : tz || 'UTC';
  let f = dayFormatters.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: zone });
    } catch {
      f = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
    }
    if (dayFormatters.size > 100) dayFormatters.clear();
    dayFormatters.set(zone, f);
  }
  return f.format(d);
}

/** Home-time days as weekday keys: 'Sat,Sun', 'saturday sunday', 'Fri-Sun' -> ['Sat', 'Sun', ...]. */
export function homeDays(value) {
  const out = new Set();
  for (const raw of String(value || '').split(/[,;/\s]+/).filter(Boolean)) {
    const range = raw.split('-');
    const key = (s) => DAY_KEYS.find((k) => s.toLowerCase().startsWith(k.toLowerCase()));
    if (range.length === 2 && key(range[0]) && key(range[1])) {
      let i = DAY_KEYS.indexOf(key(range[0]));
      const end = DAY_KEYS.indexOf(key(range[1]));
      for (let guard = 0; guard < 7; guard++) {
        out.add(DAY_KEYS[i]);
        if (i === end) break;
        i = (i + 1) % 7;
      }
    } else if (key(raw)) out.add(key(raw));
  }
  return [...out];
}

const textOf = (load) => `${load.commodity || ''} ${load.notes || ''}`;
export const needsHazmat = (load) => load.hazmat === true
  || (/\b(haz\s?mat|hazardous|placard(ed)?|UN\s?\d{4})\b/i.test(textOf(load)) && !/\bnon[- ]?haz/i.test(textOf(load)));
export const needsTwic = (load) => load.twic === true || /\bTWIC\b/i.test(textOf(load));
export const needsTeam = (load) => load.team === true || /\bteam\s+(drivers?|only|required|load|service)\b|\bteam\s+(?:is\s+)?required\b/i.test(textOf(load));
/** Trailer length the load needs: an explicit value, else "53 ft trailer" / "Trailer: 48'" in the notes or commodity. */
export function neededTrailerFt(load) {
  const explicit = toNum(load.trailerLengthFt);
  if (explicit != null && explicit > 0) return explicit;
  const m = textOf(load).match(/\b(53|48|45|40|28)\s*(?:'|’|ft\b|foot\b|feet\b)/i);
  return m ? Number(m[1]) : null;
}

/** Negotiation numbers from the carrier's own floors. All money in cents; null where the inputs are missing. */
export function negotiationNumbers(load = {}, rules = {}) {
  const rateCents = toNum(load.rateCents);
  const loaded = toNum(load.loadedMiles) ?? 0;
  const deadhead = toNum(load.deadheadMiles) ?? 0;
  const total = loaded + deadhead;
  const minRpm = toNum(rules.minRatePerMile);
  const cpmCents = toNum(rules.costPerMileCents);
  const fromRpm = minRpm != null && minRpm > 0 && loaded > 0 ? Math.round(minRpm * loaded * 100) : null;
  const fromCost = cpmCents != null && cpmCents > 0 && total > 0 ? Math.round(cpmCents * total) : null;
  let walkAwayCents = null;
  let walkAwayBasis = null;
  if (fromRpm != null || fromCost != null) {
    if ((fromRpm ?? -1) >= (fromCost ?? -1)) { walkAwayCents = fromRpm; walkAwayBasis = 'min_rpm'; } else { walkAwayCents = fromCost; walkAwayBasis = 'cost'; }
  }
  return {
    totalMiles: total,
    ratePerMile: rateCents != null && loaded > 0 ? Math.round((rateCents / loaded)) / 100 : null,
    allInRatePerMile: rateCents != null && total > 0 ? Math.round((rateCents / total)) / 100 : null,
    floorFromRpmCents: fromRpm,
    floorFromCostCents: fromCost,
    walkAwayCents,
    walkAwayBasis,
    walkAwayRatePerMile: walkAwayCents != null && loaded > 0 ? Math.round(walkAwayCents / loaded) / 100 : null,
    gapCents: walkAwayCents != null && rateCents != null ? rateCents - walkAwayCents : null,
  };
}

/** Check a load against a carrier's rules. Returns plain-language warnings plus the negotiation numbers. */
export function checkLoadFit(load = {}, rules = {}) {
  const warnings = [];
  const add = (code, message, level = 'warn') => warnings.push({ code, level, message });
  const who = rules.carrierName ? `${rules.carrierName}'s` : "this carrier's";
  const rateCents = toNum(load.rateCents);
  const loaded = toNum(load.loadedMiles) ?? 0;
  const deadhead = toNum(load.deadheadMiles) ?? 0;
  const numbers = negotiationNumbers(load, rules);

  const minRpm = toNum(rules.minRatePerMile);
  if (minRpm != null && minRpm > 0 && rateCents != null && loaded > 0) {
    const rpm = rateCents / 100 / loaded;
    if (rpm + 1e-9 < minRpm) add('min_rpm', `${usd(rpm)}/mi is below ${who} ${usd(minRpm)} floor`);
  }
  const maxDh = toNum(rules.maxDeadheadMiles);
  if (maxDh != null && deadhead > maxDh) add('deadhead', `Deadhead ${miles(deadhead)} is over the ${miles(maxDh)} max`);
  const maxWeight = toNum(rules.maxWeightLbs);
  const weight = toNum(load.weightLbs);
  if (maxWeight != null && maxWeight > 0 && weight != null && weight > maxWeight) add('weight', `${lbs(weight)} exceeds the ${lbs(maxWeight)} max`);
  const trailer = toNum(rules.trailerLengthFt);
  const needFt = neededTrailerFt(load);
  if (trailer != null && trailer > 0 && needFt != null && needFt > trailer) add('trailer', `Needs a ${needFt} ft trailer; the carrier runs ${trailer} ft`);

  const equipment = listOf(rules.equipment).map((e) => e.toLowerCase());
  if (equipment.length && load.equipment && !equipment.includes(String(load.equipment).toLowerCase())) {
    add('equipment', `Load needs ${words(load.equipment)}; the carrier runs ${equipment.map(words).join(', ')}`);
  }
  if (needsHazmat(load) && !rules.hazmat) add('hazmat', 'Hazmat load; the carrier is not set up for hazmat');
  if (needsTwic(load) && !rules.twic) add('twic', 'TWIC card required; the carrier has no TWIC drivers on file');
  if (needsTeam(load) && !rules.teamDrivers) add('team', 'Team drivers required; the carrier runs solo');

  const avoid = new Set(listOf(rules.avoidStates, { upper: true }));
  for (const st of [...new Set([load.originState, load.destState].filter(Boolean).map((s) => String(s).toUpperCase()))]) {
    if (avoid.has(st)) add('avoid_state', `${st} is on the avoid list`);
  }

  const home = homeDays(rules.homeTimeDays);
  if (home.length) {
    for (const [kind, date, tz] of [['Pickup', load.pickupDate, load.pickupTz], ['Delivery', load.deliveryDate, load.deliveryTz]]) {
      const day = weekdayOf(date, tz);
      if (day && home.includes(day)) add('home_time', `${DAY_NAMES[day]} ${kind.toLowerCase()} conflicts with home time (${home.join(', ')})`);
    }
  }

  const cpm = toNum(rules.costPerMileCents);
  if (cpm != null && cpm > 0 && rateCents != null && loaded + deadhead > 0) {
    const cost = Math.round(cpm * (loaded + deadhead));
    if (rateCents < cost) add('below_cost', `Rate ${usdCents(rateCents)} is below the carrier's cost of ${usdCents(cost)} for ${miles(loaded + deadhead)} (incl. deadhead)`);
  }
  const minHaul = toNum(rules.minHaulMiles);
  const maxHaul = toNum(rules.maxHaulMiles);
  if (minHaul != null && minHaul > 0 && loaded > 0 && loaded < minHaul) add('short_haul', `${miles(loaded)} haul is shorter than the ${miles(minHaul)} minimum`);
  if (maxHaul != null && maxHaul > 0 && loaded > maxHaul) add('long_haul', `${miles(loaded)} haul is longer than the ${miles(maxHaul)} maximum`);

  return { warnings, numbers };
}

/** Stable key of a warning list (to tell whether an acknowledgement still applies). */
export const fitKey = (warnings = []) => warnings.map((w) => w.code).sort().join(',');

/** Short plain-language list of the rules a carrier has set (for the load check card). Empty when none are set. */
export function rulesSummary(rules = {}) {
  const out = [];
  const minRpm = toNum(rules.minRatePerMile);
  if (minRpm != null && minRpm > 0) out.push(`Min ${usd(minRpm)}/mi`);
  const maxDh = toNum(rules.maxDeadheadMiles);
  if (maxDh != null) out.push(`Deadhead up to ${miles(maxDh)}`);
  const maxWeight = toNum(rules.maxWeightLbs);
  if (maxWeight != null && maxWeight > 0) out.push(`Up to ${lbs(maxWeight)}`);
  const trailer = toNum(rules.trailerLengthFt);
  if (trailer != null && trailer > 0) out.push(`${trailer} ft trailer`);
  if (rules.hazmat) out.push('Hazmat');
  if (rules.twic) out.push('TWIC');
  if (rules.teamDrivers) out.push('Team drivers');
  const avoid = listOf(rules.avoidStates, { upper: true });
  if (avoid.length) out.push(`Avoids ${avoid.join(', ')}`);
  const home = homeDays(rules.homeTimeDays);
  if (home.length) out.push(`Home ${home.join(', ')}`);
  const cpm = toNum(rules.costPerMileCents);
  if (cpm != null && cpm > 0) out.push(`Cost ${usd(cpm / 100)}/mi`);
  const minHaul = toNum(rules.minHaulMiles);
  const maxHaul = toNum(rules.maxHaulMiles);
  if ((minHaul ?? 0) > 0 || (maxHaul ?? 0) > 0) out.push(`Haul ${minHaul ? miles(minHaul) : 'any'} to ${maxHaul ? miles(maxHaul) : 'any'}`);
  return out;
}
