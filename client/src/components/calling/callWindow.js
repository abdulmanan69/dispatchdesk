/**
 * Calling hours and carrier-time helpers.
 * CALL_WINDOW matches the server rule (server/src/lib/timezones.js callWindow): weekdays, 8:00 to 19:00 in the
 * carrier's local time. Use these helpers anywhere the app says whether a carrier can be called now.
 */
export const CALL_WINDOW = { start: 8, end: 19, weekends: false };

export const STATE_TZ = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago', CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York', MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York', OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver', PR: 'America/Puerto_Rico',
  ON: 'America/Toronto', QC: 'America/Toronto', BC: 'America/Vancouver', AB: 'America/Edmonton', MB: 'America/Winnipeg',
};

/** The carrier's IANA time zone: stored zone first, then the state's main zone. */
export const tzOf = (c) => c?.timezone || STATE_TZ[String(c?.state || '').toUpperCase()] || null;

export function browserTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago'; } catch { return 'America/Chicago'; }
}

// Building Intl formatters is slow; keep one per zone and option set (bounded).
const cache = new Map();
function fmt(tz, opts) {
  const key = `${tz}|${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz });
    if (cache.size > 300) cache.clear();
    cache.set(key, f);
  }
  return f;
}

/** Wall-clock parts of `date` in `tz`. */
export function zonedParts(tz, date = new Date()) {
  const p = {};
  for (const x of fmt(tz, { hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date)) p[x.type] = x.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second, weekday: p.weekday };
}

function offsetMs(tz, t) {
  const p = zonedParts(tz, new Date(t));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

/** The instant whose wall-clock time in `tz` is y-m-d h:min (two passes settle DST changes). */
export function zonedToUtc(tz, y, m, d, h = 0, min = 0) {
  const wall = Date.UTC(y, m - 1, d, h, min);
  let t = wall;
  for (let i = 0; i < 2; i++) t = wall - offsetMs(tz, t);
  return new Date(t);
}

/** "YYYY-MM-DDTHH:mm" (a datetime-local value) read as wall-clock time in `tz`. */
export function zonedInputToDate(value, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  if (!tz) return new Date(value);
  return zonedToUtc(tz, +m[1], +m[2], +m[3], +m[4], +m[5]);
}

const pad = (n) => String(n).padStart(2, '0');
/** datetime-local value for `date` shown in `tz`. */
export function dateToZonedInput(date, tz) {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const p = zonedParts(tz || browserTz(), d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Local `hour`:00 in `tz`, `days` days from today in that zone. */
export function atLocalHour(tz, days, hour = 9, minute = 0, now = new Date()) {
  const zone = tz || browserTz();
  const p = zonedParts(zone, now);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedToUtc(zone, base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hour, minute);
}
/** Next 9:00 AM in the carrier's zone, `days` ahead. */
export const localNineAm = (tz, days) => atLocalHour(tz, days, 9);

const WEEKEND = new Set(['Sat', 'Sun']);
/** `hour`:00 local on the n-th business day after today in `tz` (weekends skipped, as in the calling rules). */
export function businessDayAt(tz, n = 1, hour = 9, now = new Date()) {
  const zone = tz || browserTz();
  let days = 0;
  let left = n;
  let d = atLocalHour(zone, 0, hour, 0, now);
  while (left > 0 && days < 14) {
    days += 1;
    d = atLocalHour(zone, days, hour, 0, now);
    if (!WEEKEND.has(zonedParts(zone, d).weekday)) left -= 1;
  }
  return d;
}
/** Next Monday at `hour`:00 local in `tz` (always in the coming week). */
export function nextMondayAt(tz, hour = 9, now = new Date()) {
  const zone = tz || browserTz();
  for (let days = 1; days <= 7; days++) {
    const d = atLocalHour(zone, days, hour, 0, now);
    if (zonedParts(zone, d).weekday === 'Mon') return d;
  }
  return atLocalHour(zone, 7, hour, 0, now);
}

/** Short zone label like "CT" or "ET" (falls back to the zone's own abbreviation). */
export function zoneAbbr(tz, date = new Date()) {
  if (!tz) return '';
  try {
    const name = fmt(tz, { timeZoneName: 'short' }).formatToParts(date).find((x) => x.type === 'timeZoneName')?.value || '';
    return /^[A-Z][SD]T$/.test(name) ? name.replace(/[SD]T$/, 'T') : name;
  } catch { return ''; }
}

/** "Wed 4:00 PM" in `tz`. */
export function formatInZone(date, tz, opts = { weekday: 'short', hour: 'numeric', minute: '2-digit' }) {
  try { return fmt(tz || browserTz(), opts).format(new Date(date)); } catch { return ''; }
}

/** Is `tz` inside calling hours at `date`? -> { callable, reason: null | 'weekend' | 'early' | 'late', hour } */
export function callableAt(tz, date = new Date()) {
  if (!tz) return { callable: true, reason: null, hour: null };
  let p;
  try { p = zonedParts(tz, date); } catch { return { callable: true, reason: null, hour: null }; }
  if (!CALL_WINDOW.weekends && (p.weekday === 'Sat' || p.weekday === 'Sun')) return { callable: false, reason: 'weekend', hour: p.hour };
  if (p.hour < CALL_WINDOW.start) return { callable: false, reason: 'early', hour: p.hour };
  if (p.hour >= CALL_WINDOW.end) return { callable: false, reason: 'late', hour: p.hour };
  return { callable: true, reason: null, hour: p.hour };
}

/** Calling guidance for a carrier, same wording as the dialer always used. */
export function windowFor(c, date = new Date()) {
  const tz = tzOf(c);
  if (!tz) return { callable: true, text: 'Time zone unknown' };
  const w = callableAt(tz, date);
  if (w.reason === 'weekend') return { callable: false, text: 'Weekend locally' };
  if (w.reason === 'early') return { callable: false, text: 'Too early locally' };
  if (w.reason === 'late') return { callable: false, text: 'After hours locally' };
  if (w.hour < 11) return { callable: true, text: 'Prime window' };
  return { callable: true, text: 'Good window' };
}
