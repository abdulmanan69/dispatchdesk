// Intl formatters are expensive to build (tens of microseconds each) and these helpers run once per table cell,
// so each distinct set of options gets one cached formatter.
const nfCache = new Map();
const dtfCache = new Map();
const CACHE_MAX = 200;

function cached(cache, key, make) {
  let f = cache.get(key);
  if (!f) {
    if (cache.size >= CACHE_MAX) cache.clear();
    f = make();
    cache.set(key, f);
  }
  return f;
}

/** Cached Intl.NumberFormat for en-US. */
export const nf = (opts = {}) => cached(nfCache, JSON.stringify(opts), () => new Intl.NumberFormat('en-US', opts));
/** Cached Intl.DateTimeFormat for en-US (include timeZone in opts for zone clocks). Throws on an invalid zone. */
export const dtf = (opts = {}) => cached(dtfCache, JSON.stringify(opts), () => new Intl.DateTimeFormat('en-US', opts));
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export const money = (cents, opts = {}) =>
  cents == null ? '—' : nf({ style: 'currency', currency: opts.currency || 'USD', maximumFractionDigits: opts.digits ?? 2 }).format(cents / 100);

export const dollars = (n, digits = 2) =>
  n == null || Number.isNaN(n) ? '—' : nf({ style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);

export const num = (n, digits = 0) => (n == null ? '—' : nf({ maximumFractionDigits: digits }).format(n));
export const pct = (n, digits = 1) => (n == null ? '—' : `${Number(n).toFixed(digits)}%`);

const DATE_DEFAULT = { month: 'short', day: 'numeric', year: 'numeric' };
const DATETIME = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };

export function date(d, opts) {
  if (!d) return '—';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '—';
  return dtf(opts || DATE_DEFAULT).format(x);
}
export function dateTime(d) {
  if (!d) return '—';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '—';
  return dtf(DATETIME).format(x);
}
export function relative(d) {
  if (!d) return '—';
  const diff = (new Date(d).getTime() - Date.now()) / 1000;
  if (Number.isNaN(diff)) return '—';
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return date(d);
}

/** Clock parts in a time zone from one cached formatter: { time: '9:42', ampm: 'am', hour24: 9, abbr: 'CST' }. */
export function zoneClock(now, timeZone) {
  const parts = dtf({ timeZone, hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  const hour = Number(get('hour')) % 12;
  const pm = /pm/i.test(get('dayPeriod'));
  return { time: `${get('hour')}:${get('minute')}`, ampm: pm ? 'pm' : 'am', hour24: hour + (pm ? 12 : 0), abbr: get('timeZoneName') };
}

/** Value for <input type="datetime-local"> in the browser's local zone. */
export function toLocalInput(d) {
  if (!d) return '';
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 16);
}
export const toDateInput = (d) => (d ? toLocalInput(d).slice(0, 10) : '');

export const label = (key) => (key ? String(key).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—');
export const phoneFmt = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return p || '—';
};
export const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('') || '?';
export const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export const EQUIPMENT = ['dry_van', 'reefer', 'flatbed', 'step_deck', 'power_only', 'hotshot', 'box_truck', 'tanker', 'car_hauler', 'conestoga', 'lowboy', 'other'];
// Same order as server/src/lib/constants.js and components/calling/outcomes.js (dialer hotkeys 1-9, then 0).
export const CALL_OUTCOMES = ['no_answer', 'busy', 'voicemail', 'interested', 'not_interested', 'call_back', 'follow_up', 'converted', 'wrong_number', 'do_not_call'];
export const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
// Preset choices for fields that also accept a custom value (rendered with ComboInput).
export const PRESETS = {
  paymentTerms: ['Net 7', 'Net 15', 'Net 30', 'Net 45', 'Net 60', 'Quick pay 1%', 'Quick pay 2%', 'Quick pay 3%', 'Quick pay 5%', 'Factoring only', 'COD'],
  creditRating: ['A — pays on time', 'B — minor delays', 'C — slow payer', 'D — avoid', 'Not rated'],
  commodity: ['General freight', 'Dry goods', 'Packaged foods', 'Produce', 'Frozen foods', 'Meat', 'Beverages', 'Paper products', 'Building materials', 'Lumber', 'Steel', 'Machinery', 'Auto parts', 'Electronics', 'Furniture', 'Consumer goods', 'Retail', 'Plastics', 'Chemicals (non-hazmat)', 'Hazmat', 'Livestock feed'],
  lostReason: ['Signed with another dispatcher', 'Rate or fee too high', 'Not ready for dispatch', 'Dispatches themselves', 'Stopped responding', 'Authority inactive', 'Truck sold or parked', 'Bad timing — revisit later'],
  smtpPort: ['465', '587', '25', '2525'],
  smtpHost: ['smtp.hostinger.com', 'smtp.gmail.com', 'smtp.office365.com', 'smtp.zoho.com', 'smtp.mail.yahoo.com', 'smtp.sendgrid.net', 'smtp.mailgun.org'],
  mpg: ['5.5', '6', '6.5', '7', '7.5', '8'],
  detentionRate: ['25', '40', '50', '60', '75'],
  feePercent: ['5', '6', '7', '8', '10', '12'],
  tagNames: ['Hot', 'New authority', 'Owner-operator', 'Reefer', 'Flatbed', 'Call back', 'Spanish speaking', 'Needs factoring', 'Referred'],
};

export const DOCUMENT_TYPES = ['agreement', 'mc_authority', 'w9', 'coi', 'permit', 'rate_confirmation', 'bol', 'pod', 'lumper_receipt', 'scale_ticket', 'fuel_receipt', 'voided_check', 'noa', 'other'];
