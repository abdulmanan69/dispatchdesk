import { dtf } from '../../lib/format.js';

/**
 * Facility-local times for appointment windows.
 * The API stores instants (UTC) plus the facility's IANA zone (Load.pickupTz / deliveryTz). Forms edit wall-clock
 * strings ('YYYY-MM-DDTHH:mm', facility-local) and send them as they are: the server converts them with the
 * facility's zone, so the browser's own zone never shifts an appointment.
 */
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export function safeZone(tz) {
  if (!tz) return null;
  try { dtf({ timeZone: tz }); return tz; } catch { return null; }
}

/** 'YYYY-MM-DDTHH:mm' wall-clock value of an instant in `tz` (for <input type="datetime-local">). */
export function zonedInput(value, tz) {
  if (!value) return '';
  if (typeof value === 'string' && LOCAL.test(value) && !/(Z|[+-]\d{2}:?\d{2})$/.test(value)) return value.slice(0, 16);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const zone = safeZone(tz) || undefined;
  const parts = Object.fromEntries(dtf({ timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${String(Number(parts.hour) % 24).padStart(2, '0')}:${parts.minute}`;
}

/** Short zone name ('CST') of `tz` at `date`. */
export function zoneAbbr(tz, date = new Date()) {
  const zone = safeZone(tz);
  if (!zone) return '';
  return dtf({ timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(date)).find((p) => p.type === 'timeZoneName')?.value || '';
}

/** UTC instant of a facility-local wall time (mirror of the server's conversion, used for previews only). */
export function zonedToInstant(local, tz) {
  if (!local || !LOCAL.test(local)) return null;
  const [d, t] = local.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, day, hh, mm);
  const zone = safeZone(tz) || 'UTC';
  const offsetAt = (ms) => {
    const p = Object.fromEntries(dtf({ timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms) / 60000;
  };
  let ms = guess - offsetAt(guess) * 60000;
  const second = offsetAt(ms);
  if (second !== offsetAt(guess)) ms = guess - second * 60000;
  return new Date(ms);
}

const time = (d, zone) => dtf({ timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(d);
const day = (d, zone) => dtf({ timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' }).format(d);

/**
 * "Thu, Nov 12, 8:00 AM–2:00 PM MST · 9:00 AM your time" for a window (instants or facility-local strings).
 * The "your time" part appears only when the viewer's zone differs from the facility's.
 */
export function formatWindow(start, end, tz, userTz) {
  const zone = safeZone(tz) || safeZone(userTz) || undefined;
  const s = typeof start === 'string' && !/(Z|[+-]\d{2}:?\d{2})$/.test(start) ? zonedToInstant(start, zone) : start ? new Date(start) : null;
  if (!s || Number.isNaN(s.getTime())) return '';
  const e = end ? (typeof end === 'string' && !/(Z|[+-]\d{2}:?\d{2})$/.test(end) ? zonedToInstant(end, zone) : new Date(end)) : null;
  let text = `${day(s, zone)}, ${time(s, zone)}`;
  if (e && !Number.isNaN(e.getTime()) && e > s) text += day(e, zone) === day(s, zone) ? `–${time(e, zone)}` : ` to ${day(e, zone)}, ${time(e, zone)}`;
  const abbr = zoneAbbr(zone, s);
  if (abbr) text += ` ${abbr}`;
  const mine = safeZone(userTz);
  if (mine && zone && zoneAbbr(mine, s) !== abbr) text += ` · ${time(s, mine)} your time`;
  return text;
}

/** A date + time in a zone, e.g. "Nov 12, 8:02 AM CST". */
export function formatAt(value, tz) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const zone = safeZone(tz) || undefined;
  return `${dtf({ timeZone: zone, month: 'short', day: 'numeric' }).format(d)}, ${time(d, zone)} ${zoneAbbr(zone, d)}`.trim();
}
