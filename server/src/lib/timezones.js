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

export function timezoneForState(state) {
  return STATE_TZ[String(state || '').toUpperCase()] || null;
}

/** Local wall-clock parts of `date` in time zone `tz`. */
export function localParts(tz, date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const hour = Number(p.hour) % 24;
  return { hour, minute: Number(p.minute), weekday: p.weekday, label: `${String(hour).padStart(2, '0')}:${p.minute}`, date: `${p.year}-${p.month}-${p.day}` };
}

/** Minutes offset of tz from UTC at `date` (positive east). */
export function tzOffsetMinutes(tz, date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
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
 * Steps in 15 minute increments (bounded to 8 days) which is simple and DST-safe.
 */
export function nextBusinessTime(tz, date = new Date(), start = 9, end = 17, skipWeekends = true) {
  if (!tz) return date;
  let d = new Date(date);
  for (let i = 0; i < 8 * 24 * 4; i++) {
    if (isWithinBusinessHours(tz, start, end, d, skipWeekends)) return d;
    d = new Date(d.getTime() + 15 * 60000);
    d.setSeconds(0, 0);
  }
  return d;
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
