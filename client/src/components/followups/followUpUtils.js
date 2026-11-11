import { CalendarClock, ListChecks, Mail, MessageSquare, Phone, Users } from 'lucide-react';
import { atLocalHour, nextMondayAt, zonedParts } from '../calling/callWindow.js';

export const TYPES = [
  { value: 'call', label: 'Call', icon: Phone, tone: 'bg-c-blue-soft text-c-blue' },
  { value: 'email', label: 'Email', icon: Mail, tone: 'bg-c-purple-soft text-c-purple' },
  { value: 'text', label: 'Text', icon: MessageSquare, tone: 'bg-c-green-soft text-c-green' },
  { value: 'task', label: 'Task', icon: ListChecks, tone: 'bg-c-amber-soft text-c-amber' },
  { value: 'meeting', label: 'Meeting', icon: Users, tone: 'bg-c-pink-soft text-c-pink' },
];
export const typeMeta = (t) => TYPES.find((x) => x.value === t) || { value: t, label: t, icon: CalendarClock, tone: 'bg-c-gray-soft text-c-gray' };

export const PRIORITIES = [
  { value: 0, label: 'Normal' },
  { value: 1, label: 'High' },
  { value: 2, label: 'Urgent' },
];

export const RECURRENCES = [
  ['none', 'Does not repeat'], ['daily', 'Every day'], ['weekdays', 'Every weekday'], ['weekly', 'Every week'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Every month'],
];

export const REMINDERS = [[0, 'At due time'], [5, '5 min before'], [15, '15 min before'], [30, '30 min before'], [60, '1 hour before'], [1440, '1 day before']];

export const OUTCOMES = ['Reached, interested', 'Reached, call back later', 'Left voicemail', 'No answer', 'Sent info', 'Booked a meeting', 'Not interested', 'Wrong number'];

const at = (d, h, m = 0) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const nextMonday = (from = new Date()) => { const d = addDays(from, ((8 - from.getDay()) % 7) || 7); return at(d, 9); };
const laterToday = () => {
  const n = new Date();
  const t = at(n, Math.max(15, n.getHours() + 3));
  return t.getDate() === n.getDate() && n.getHours() < 20 ? t : at(addDays(n, 1), 9);
};

/** "Later today" in the carrier's zone: 3 hours from now (not before 3 PM), or tomorrow 9:00 when it is late there. */
function laterTodayIn(tz) {
  const p = zonedParts(tz);
  return p.hour < 20 ? atLocalHour(tz, 0, Math.max(15, p.hour + 3)) : atLocalHour(tz, 1, 9);
}

/**
 * "When" presets for scheduling. Each get(tz?) returns a Date: with a time zone (the carrier's) the clock times
 * ("Tomorrow 9:00") are in that zone; without one they are in the browser's zone.
 */
export const WHEN_PRESETS = [
  { key: '1h', label: 'In 1 hour', get: () => new Date(Date.now() + 3600000) },
  { key: 'later', label: 'Later today', get: (tz) => (tz ? laterTodayIn(tz) : laterToday()) },
  { key: 'tomorrow', label: 'Tomorrow 9:00', get: (tz) => (tz ? atLocalHour(tz, 1, 9) : at(addDays(new Date(), 1), 9)) },
  { key: '2d', label: 'In 2 days', get: (tz) => (tz ? atLocalHour(tz, 2, 9) : at(addDays(new Date(), 2), 9)) },
  { key: 'week', label: 'Next week', get: (tz) => (tz ? nextMondayAt(tz, 9) : nextMonday()) },
];

/** Snooze presets: minutes, or an absolute `until`. */
export const SNOOZE_PRESETS = [
  { label: '15 minutes', body: () => ({ minutes: 15 }) },
  { label: '1 hour', body: () => ({ minutes: 60 }) },
  { label: '3 hours', body: () => ({ minutes: 180 }) },
  { label: 'Tomorrow 9:00', body: () => ({ until: at(addDays(new Date(), 1), 9).toISOString() }) },
  { label: 'Next Monday 9:00', body: () => ({ until: nextMonday().toISOString() }) },
];

export const startOfDay = (d) => at(d, 0);
export const startOfWeek = (d) => { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
export { addDays };

// Formatters are built once (building one per row on every render made long lists slow to type into).
const DAY_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
const DAY_YEAR_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

export function dayLabel(d, now = new Date()) {
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const x = new Date(d);
  return (x.getFullYear() === now.getFullYear() ? DAY_FMT : DAY_YEAR_FMT).format(x);
}
export const timeOf = (d) => TIME_FMT.format(new Date(d));

const digits = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 11 && d.startsWith('1') ? d.slice(1) : d; };
/**
 * Text link: Google Voice messages when that is the calling provider, otherwise the OS sms: handler.
 * The sms: link carries the message (`?&body=` works on iOS and Android); Google Voice has no body parameter,
 * so callers copy the message to the clipboard first.
 */
export function textHref(phone, provider, body) {
  const d = digits(phone);
  if (!d) return null;
  if (provider === 'google_voice') return `https://voice.google.com/u/0/messages?itemId=t.%2B1${d}`;
  return `sms:+1${d}${body ? `?&body=${encodeURIComponent(body)}` : ''}`;
}
/** Open a text link from a click: web links in a new tab, sms: in the OS messaging app. Never sends anything. */
export function openTextLink(href) {
  if (!href) return;
  if (/^https:\/\//i.test(href)) window.open(href, '_blank', 'noopener');
  else window.location.href = href;
}
/** Copy text; resolves false when the browser blocks the clipboard. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(String(text || '')); return true; } catch { return false; }
}
