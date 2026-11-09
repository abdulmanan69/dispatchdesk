import { CalendarClock, ListChecks, Mail, MessageSquare, Phone, Users } from 'lucide-react';

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

/** "When" presets for scheduling. Each returns a Date. */
export const WHEN_PRESETS = [
  { key: '1h', label: 'In 1 hour', get: () => new Date(Date.now() + 3600000) },
  { key: 'later', label: 'Later today', get: laterToday },
  { key: 'tomorrow', label: 'Tomorrow 9:00', get: () => at(addDays(new Date(), 1), 9) },
  { key: '2d', label: 'In 2 days', get: () => at(addDays(new Date(), 2), 9) },
  { key: 'week', label: 'Next week', get: () => nextMonday() },
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

export function dayLabel(d, now = new Date()) {
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return new Date(d).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: new Date(d).getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
export const timeOf = (d) => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const digits = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 11 && d.startsWith('1') ? d.slice(1) : d; };
/** Text link: Google Voice messages when that is the calling provider, otherwise the OS sms: handler. */
export function textHref(phone, provider) {
  const d = digits(phone);
  if (!d) return null;
  if (provider === 'google_voice') return `https://voice.google.com/u/0/messages?itemId=t.%2B1${d}`;
  return `sms:+1${d}`;
}
