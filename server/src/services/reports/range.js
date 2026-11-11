import { badRequest } from '../../lib/errors.js';
import { DEFAULT_TZ, localParts, zonedTimeToUtc } from '../../lib/timezones.js';

/**
 * Report date ranges, resolved in the dispatcher's time zone. A range is a pair of local calendar days (both
 * included); `start` and `end` are the UTC instants of the first day's midnight and of the midnight after the last day.
 */
export const RANGE_PRESETS = ['this_month', 'last_month', 'last_90', 'this_year', 'custom'];
/** Longest custom range (about five years), which also bounds the month chart to ~61 buckets. */
export const MAX_RANGE_DAYS = 1830;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');
const MONTH_LABEL = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const MONTH_LONG = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** YYYY-MM-DD of a calendar date; out-of-range parts roll over (day 0 is the last day of the previous month). */
export function dayKey(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

const partsOf = (key) => key.split('-').map(Number);
const utcOf = (key) => {
  const [y, m, d] = partsOf(key);
  return Date.UTC(y, m - 1, d);
};

export function isDayKey(key) {
  if (typeof key !== 'string' || !DAY_KEY.test(key)) return false;
  const [y, m, d] = partsOf(key);
  return y >= 2000 && y <= 2100 && dayKey(y, m, d) === key;
}

/** UTC instant of local midnight at the start of `key` in `tz`. */
export function startOfDayKey(tz, key) {
  const [y, m, d] = partsOf(key);
  return zonedTimeToUtc(tz, y, m, d, 0, 0, 0);
}

export const monthLabel = (y, m, long = false) => (long ? MONTH_LONG : MONTH_LABEL).format(new Date(Date.UTC(y, m - 1, 15)));

/**
 * { key, from, to, timezone, start, end } for a preset or a custom from/to pair (YYYY-MM-DD). From/to without a
 * preset means custom. 400 for bad or reversed dates and for custom ranges over MAX_RANGE_DAYS.
 */
export function resolveRange(tz, { range, from, to } = {}, now = new Date()) {
  const zone = tz || DEFAULT_TZ;
  const t = localParts(zone, now);
  const today = dayKey(t.year, t.month, t.day);
  const key = range || (from || to ? 'custom' : 'this_month');
  let f;
  let e;
  if (key === 'this_month') [f, e] = [dayKey(t.year, t.month, 1), today];
  else if (key === 'last_month') [f, e] = [dayKey(t.year, t.month - 1, 1), dayKey(t.year, t.month, 0)];
  else if (key === 'last_90') [f, e] = [dayKey(t.year, t.month, t.day - 89), today];
  else if (key === 'this_year') [f, e] = [dayKey(t.year, 1, 1), today];
  else if (key === 'custom') {
    if (!from || !to) throw badRequest('Pick a start and an end date');
    if (!isDayKey(from) || !isDayKey(to)) throw badRequest('Use dates as YYYY-MM-DD');
    if (from > to) throw badRequest('The start date is after the end date');
    if ((utcOf(to) - utcOf(from)) / DAY + 1 > MAX_RANGE_DAYS) throw badRequest('Pick a range of five years or less');
    [f, e] = [from, to];
  } else throw badRequest('Unknown date range');
  const [ey, em, ed] = partsOf(e);
  return { key, from: f, to: e, timezone: zone, start: startOfDayKey(zone, f), end: zonedTimeToUtc(zone, ey, em, ed + 1, 0, 0, 0) };
}

/**
 * Calendar-month buckets covering a resolved range, oldest first: [{ key: 'YYYY-MM', label: 'Nov 2026', start, end }].
 * The first bucket starts at the range start and the last ends at the range end, so partial months are partial.
 */
export function monthBuckets(range) {
  const [fy, fm] = partsOf(range.from);
  const [ty, tm] = partsOf(range.to);
  const out = [];
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push({ key: `${y}-${pad(m)}`, label: monthLabel(y, m), start: out.length ? zonedTimeToUtc(range.timezone, y, m, 1, 0, 0, 0) : range.start });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  out.forEach((b, i) => { b.end = out[i + 1]?.start ?? range.end; });
  return out;
}

/**
 * This month (the whole calendar month, so loads dated later today count), last month, and last month up to the same
 * day of the month as today (the fair comparison for a month in progress), in the dispatcher's time zone.
 */
export function monthComparison(tz, now = new Date()) {
  const zone = tz || DEFAULT_TZ;
  const t = localParts(zone, now);
  const lastDays = new Date(Date.UTC(t.year, t.month - 1, 0)).getUTCDate();
  const cutDay = Math.min(t.day, lastDays);
  const at = (m, d) => zonedTimeToUtc(zone, t.year, m, d, 0, 0, 0);
  const lastY = t.month === 1 ? t.year - 1 : t.year;
  const lastM = t.month === 1 ? 12 : t.month - 1;
  return {
    timezone: zone,
    today: dayKey(t.year, t.month, t.day),
    thisMonth: { key: `${t.year}-${pad(t.month)}`, label: monthLabel(t.year, t.month, true), from: dayKey(t.year, t.month, 1), to: dayKey(t.year, t.month + 1, 0), start: at(t.month, 1), end: at(t.month + 1, 1) },
    lastMonth: { key: `${lastY}-${pad(lastM)}`, label: monthLabel(lastY, lastM, true), from: dayKey(t.year, t.month - 1, 1), to: dayKey(t.year, t.month, 0), start: at(t.month - 1, 1), end: at(t.month, 1) },
    lastMonthToDate: { from: dayKey(t.year, t.month - 1, 1), to: dayKey(t.year, t.month - 1, cutDay), start: at(t.month - 1, 1), end: at(t.month - 1, cutDay + 1) },
  };
}
