// Primary IANA time zone per US state / territory (majority population zone).
const STATE_TZ = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago', CA: 'America/Los_Angeles',
  CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York',
  GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York',
  NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago',
  OH: 'America/New_York', OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver',
  VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York', WI: 'America/Chicago',
  WY: 'America/Denver', PR: 'America/Puerto_Rico',
  // Canada / Mexico common codes
  ON: 'America/Toronto', QC: 'America/Toronto', BC: 'America/Vancouver', AB: 'America/Edmonton', MB: 'America/Winnipeg',
};

export const US_STATES = Object.keys(STATE_TZ).filter((s) => s.length === 2).slice(0, 52);

/** Zone used when a user or carrier has none (the same default as User.timezone). */
export const DEFAULT_TZ = 'America/Chicago';

const SERVER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
})();

/** The process time zone (UTC in production containers). Used where older code relied on Date#setHours. */
export const serverTimezone = () => SERVER_TZ;

export function timezoneForState(state) {
  return STATE_TZ[String(state || '').toUpperCase()] || null;
}

/*
 * One Intl.DateTimeFormat per zone, built once. Constructing a formatter costs 100-300 µs; formatting with a
 * cached one costs a few µs. Only a few dozen zones are ever used, the map is still bounded.
 */
const FORMATTERS = new Map();
const MAX_FORMATTERS = 200;

function formatter(tz) {
  const key = tz || 'UTC';
  let f = FORMATTERS.get(key);
  if (f) return f;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: key, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    // Unknown zone name (bad data): use UTC instead of failing a request or a background job.
    if (key === 'UTC') throw new Error('Intl time zone support is missing');
    f = formatter('UTC');
  }
  if (FORMATTERS.size >= MAX_FORMATTERS) FORMATTERS.clear();
  FORMATTERS.set(key, f);
  return f;
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function rawParts(tz, date) {
  const out = {};
  for (const p of formatter(tz).formatToParts(date)) if (p.type !== 'literal') out[p.type] = p.value;
  return out;
}

/** Local wall-clock parts of `date` in time zone `tz`. */
export function localParts(tz, date = new Date()) {
  const p = rawParts(tz, date);
  const hour = Number(p.hour) % 24;
  return {
    hour, minute: Number(p.minute), second: Number(p.second), weekday: p.weekday, weekdayIndex: WEEKDAY_INDEX[p.weekday],
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    label: `${String(hour).padStart(2, '0')}:${p.minute}`, date: `${p.year}-${p.month}-${p.day}`,
  };
}

/** Minutes offset of tz from UTC at `date` (positive east). */
export function tzOffsetMinutes(tz, date = new Date()) {
  const p = rawParts(tz, date);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * UTC instant of a local wall-clock time in tz. Out-of-range days/hours roll over (day 32 = next month),
 * so callers can do calendar arithmetic directly. DST is corrected with a second offset lookup.
 */
export function zonedTimeToUtc(tz, year, month, day, hour = 0, minute = 0, second = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const off = tzOffsetMinutes(tz, new Date(guess));
  let t = guess - off * 60000;
  const off2 = tzOffsetMinutes(tz, new Date(t));
  if (off2 !== off) t = guess - off2 * 60000;
  return new Date(t);
}

/** YYYY-MM-DD of `date` in tz. */
export function localDayKey(tz, date = new Date()) {
  return localParts(tz || DEFAULT_TZ, date).date;
}

/** First instant of the local day containing `now`. */
export function startOfUserDay(tz, now = new Date()) {
  const zone = tz || DEFAULT_TZ;
  const p = localParts(zone, now);
  return zonedTimeToUtc(zone, p.year, p.month, p.day, 0, 0, 0);
}

/** First instant of the next local day (when a "per day" limit resets). */
export function startOfNextUserDay(tz, now = new Date()) {
  const zone = tz || DEFAULT_TZ;
  const p = localParts(zone, now);
  return zonedTimeToUtc(zone, p.year, p.month, p.day + 1, 0, 0, 0);
}

/** Last millisecond of the local day containing `now`. */
export function endOfUserDay(tz, now = new Date()) {
  return new Date(startOfNextUserDay(tz, now).getTime() - 1);
}

/** The same local wall-clock time `days` later (DST-safe: 9:00 stays 9:00). */
export function addLocalDays(tz, date, days) {
  const zone = tz || DEFAULT_TZ;
  const d = new Date(date);
  const p = localParts(zone, d);
  const t = zonedTimeToUtc(zone, p.year, p.month, p.day + days, p.hour, p.minute, p.second);
  return new Date(t.getTime() + d.getUTCMilliseconds());
}

const WEEKEND = new Set(['Sat', 'Sun']);

/** Is it currently within business hours (start..end, local) on a weekday in tz? */
export function isWithinBusinessHours(tz, start = 9, end = 17, date = new Date(), skipWeekends = true) {
  if (!tz) return true;
  const p = localParts(tz, date);
  if (skipWeekends && WEEKEND.has(p.weekday)) return false;
  return p.hour >= start && p.hour < end;
}

/**
 * Move `date` forward to the next moment inside the business window in tz.
 * Computed directly (at most three formatter calls): stay if inside the window, otherwise jump to the start hour
 * today or on the next allowed day, skipping weekend days whole. DST is handled by zonedTimeToUtc.
 */
export function nextBusinessTime(tz, date = new Date(), start = 9, end = 17, skipWeekends = true) {
  if (!tz) return date;
  const d = new Date(date);
  const p = localParts(tz, d);
  const allowed = (wd) => !skipWeekends || (wd !== 0 && wd !== 6);
  if (allowed(p.weekdayIndex) && p.hour >= start && p.hour < end) return d;
  let add = allowed(p.weekdayIndex) && p.hour < start ? 0 : 1;
  while (!allowed((p.weekdayIndex + add) % 7)) add++;
  return zonedTimeToUtc(tz, p.year, p.month, p.day + add, start, 0, 0);
}

/** Calling recommendation for a carrier based on local time. */
export function callWindow(tz, date = new Date()) {
  if (!tz) return { timezone: null, localTime: null, callable: true, recommendation: 'Time zone unknown — add a state to get local-time guidance.' };
  const p = localParts(tz, date);
  const weekend = WEEKEND.has(p.weekday);
  let recommendation;
  let callable = true;
  if (weekend) { callable = false; recommendation = 'Weekend locally — schedule for Monday 9–11 AM.'; }
  else if (p.hour < 8) { callable = false; recommendation = 'Too early locally — best window starts 8 AM.'; }
  else if (p.hour >= 19) { callable = false; recommendation = 'After hours locally — call tomorrow 8–11 AM.'; }
  else if (p.hour < 11) recommendation = 'Prime window (8–11 AM): owner-operators are planning the day.';
  else if (p.hour < 14) recommendation = 'Good window — keep calls short around lunch.';
  else if (p.hour < 17) recommendation = 'Good window — afternoon follow-ups.';
  else recommendation = 'Late — OK for callbacks you already scheduled.';
  return { timezone: tz, localTime: p.label, localWeekday: p.weekday, callable, recommendation };
}

/**
 * callWindow for many rows that share one `now` (list endpoints): computed once per zone.
 * Usage: const cw = callWindowMemo(now); items.forEach((it) => { it.callWindow = cw(tz); });
 */
export function callWindowMemo(now = new Date()) {
  const cache = new Map();
  return (tz) => {
    const k = tz || '';
    if (!cache.has(k)) cache.set(k, callWindow(tz || null, now));
    return cache.get(k);
  };
}
