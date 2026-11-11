import { config } from '../../config.js';
import { signPayload } from '../../lib/crypto.js';
import { timezoneForState } from '../../lib/timezones.js';

/**
 * Merge fields shared by emails, text messages, sequences and call scripts.
 *
 * Canonical names are snake_case: {{company}}, {{first_name}}, {{my_name}}, {{pickup_city}} ...
 * Older names keep working through ALIASES ({{sender_name}} is {{my_name}}), and other spellings are
 * normalized ({{pickupCity}}, {{FIRST_NAME}}, {{companyName}}). Unknown tokens are left untouched so
 * users notice typos. A field whose source is missing (no load chosen, no phone on your profile) also
 * stays visible in previews (strict mode) so nothing is sent half-filled without a warning.
 *
 * group: contact (the carrier or broker), you (the sender), load, billing.
 * sample: shown only in previews labelled "sample data"; never sent.
 */
export const FIELDS = [
  { key: 'company', group: 'contact', label: 'Company name', sample: 'Red River Transport LLC' },
  { key: 'first_name', group: 'contact', label: 'Contact first name ("there" when unknown)', sample: 'Marcus' },
  { key: 'contact_name', group: 'contact', label: 'Contact full name', sample: 'Marcus Hill' },
  { key: 'mc', group: 'contact', label: 'MC number', sample: '1184420' },
  { key: 'dot', group: 'contact', label: 'USDOT number', sample: '3561982' },
  { key: 'city', group: 'contact', label: 'City', sample: 'Shreveport' },
  { key: 'state', group: 'contact', label: 'State', sample: 'LA' },
  { key: 'equipment', group: 'contact', label: 'Equipment types', sample: 'dry van, reefer' },
  { key: 'my_name', group: 'you', label: 'Your name', sample: 'Jordan Lee' },
  { key: 'my_first_name', group: 'you', label: 'Your first name', sample: 'Jordan' },
  { key: 'my_company', group: 'you', label: 'Your company (team name, or the company name in Settings)', sample: 'Lee Dispatch Services' },
  { key: 'my_phone', group: 'you', label: 'Your phone', sample: '(555) 010-0199' },
  { key: 'my_email', group: 'you', label: 'Your email (default mailbox)', sample: 'jordan@leedispatch.example' },
  { key: 'signature', group: 'you', label: 'Your email signature (your name when you have none)', sample: 'Jordan Lee\nLee Dispatch Services', channels: ['email'] },
  { key: 'carrier_company', group: 'load', label: 'Carrier you dispatch for (on broker emails)', sample: 'Red River Transport LLC' },
  { key: 'carrier_mc', group: 'load', label: "Carrier's MC number", sample: '1184420' },
  { key: 'carrier_dot', group: 'load', label: "Carrier's USDOT number", sample: '3561982' },
  { key: 'broker_company', group: 'load', label: 'Broker company', sample: 'Summit Freight Brokerage' },
  { key: 'load_ref', group: 'load', label: 'Load or reference number', sample: 'SF-48213' },
  { key: 'pickup_city', group: 'load', label: 'Pickup city and state', sample: 'Dallas, TX' },
  { key: 'pickup_date', group: 'load', label: 'Pickup date and appointment', sample: 'Tue, Nov 11, 8:00 AM CST' },
  { key: 'pickup_address', group: 'load', label: 'Pickup facility and address', sample: 'Acme Foods DC, 1200 Industrial Blvd, Dallas, TX' },
  { key: 'delivery_city', group: 'load', label: 'Delivery city and state', sample: 'Atlanta, GA' },
  { key: 'delivery_date', group: 'load', label: 'Delivery date and appointment', sample: 'Wed, Nov 12, 2:00 PM EST' },
  { key: 'delivery_address', group: 'load', label: 'Delivery facility and address', sample: 'Peach State Grocers, 455 Logistics Pkwy, Atlanta, GA' },
  { key: 'rate', group: 'load', label: 'Load rate', sample: '$2,450' },
  { key: 'rate_per_mile', group: 'load', label: 'Rate per loaded mile', sample: '$3.02/mi' },
  { key: 'miles', group: 'load', label: 'Loaded miles', sample: '812' },
  { key: 'commodity', group: 'load', label: 'Commodity', sample: 'Packaged foods' },
  { key: 'weight', group: 'load', label: 'Weight', sample: '38,000 lbs' },
  { key: 'track_link', group: 'load', label: 'Tracking or location link (filled where a link was just created)', sample: `${config.appUrl}/t/example-link` },
  { key: 'invoice_number', group: 'billing', label: 'Invoice number', sample: '1042' },
  { key: 'amount_due', group: 'billing', label: 'Invoice balance due', sample: '$245.00' },
  { key: 'invoice_due_date', group: 'billing', label: 'Invoice due date', sample: 'Nov 24, 2026' },
];
export const FIELD_KEYS = new Set(FIELDS.map((f) => f.key));

/** Older or alternative names -> canonical field. Keys are already normalized (snake_case, lower case). */
export const ALIASES = {
  sender_name: 'my_name', sender_first_name: 'my_first_name', sender_phone: 'my_phone', sender_email: 'my_email', sender_company: 'my_company',
  your_name: 'my_name', my_phone_number: 'my_phone', my_company_name: 'my_company',
  company_name: 'company', carrier_name: 'carrier_company', carrier_mc_number: 'carrier_mc', carrier_dot_number: 'carrier_dot',
  firstname: 'first_name', contact_first_name: 'first_name', contact_full_name: 'contact_name',
  mc_number: 'mc', dot_number: 'dot', usdot: 'dot',
  broker: 'broker_company', broker_name: 'broker_company',
  load_number: 'load_ref', reference: 'load_ref', reference_number: 'load_ref', ref: 'load_ref',
  origin: 'pickup_city', origin_city: 'pickup_city', destination: 'delivery_city', dest_city: 'delivery_city',
  pickup_appt: 'pickup_date', pickup_time: 'pickup_date', delivery_appt: 'delivery_date', delivery_time: 'delivery_date',
  status_link: 'track_link', tracking_link: 'track_link', location_link: 'track_link',
  invoice_no: 'invoice_number', balance_due: 'amount_due',
};

/** Field descriptions keyed by canonical name (GET /api/email/merge-fields). */
export const MERGE_FIELDS = Object.fromEntries(FIELDS.map((f) => [f.key, f.label]));

const TOKEN = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;
const normalize = (key) => String(key).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
/** Canonical field name for any accepted spelling ({{pickupCity}} -> pickup_city, {{sender_name}} -> my_name). */
export const canonicalField = (key) => { const k = normalize(key); return ALIASES[k] || k; };

function primaryContact(entity) {
  const list = entity?.contacts || [];
  return list.find((c) => c.isPrimary) || list[0] || null;
}
function contactName(entity) {
  return primaryContact(entity)?.name || entity?.contactName || '';
}

const usd = (cents) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2,
}).format(cents / 100);
const usd2 = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(cents / 100);

function safeTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return tz; } catch { return 'America/Chicago'; }
}
const dayFmt = (tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
const timeFmt = (tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
function zoneAbbr(tz, d) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || '';
}

/** "Tue, Nov 11, 8:00 AM–10:00 AM CST" from an appointment window, or "Tue, Nov 11" from a plain date. */
export function formatAppointment(start, end, date, tz) {
  const zone = safeTz(tz || 'America/Chicago');
  const s = start ? new Date(start) : null;
  if (s && !Number.isNaN(s.getTime())) {
    const day = dayFmt(zone).format(s);
    const e = end ? new Date(end) : null;
    const abbr = zoneAbbr(zone, s);
    if (e && !Number.isNaN(e.getTime()) && e > s) {
      const endDay = dayFmt(zone).format(e);
      return endDay === day
        ? `${day}, ${timeFmt(zone).format(s)}–${timeFmt(zone).format(e)} ${abbr}`.trim()
        : `${day}, ${timeFmt(zone).format(s)} to ${endDay}, ${timeFmt(zone).format(e)} ${abbr}`.trim();
    }
    return `${day}, ${timeFmt(zone).format(s)} ${abbr}`.trim();
  }
  const d = date ? new Date(date) : null;
  if (d && !Number.isNaN(d.getTime())) return dayFmt(zone).format(d);
  return '';
}

const place = (city, state) => [city, state].filter(Boolean).join(', ');
/** "(214) 555-0101" for US numbers; anything else as typed. */
export function prettyPhone(p) {
  const raw = String(p || '').trim();
  const d = raw.replace(/\D/g, '');
  const n = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return n.length === 10 && !/[a-z]/i.test(raw) ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : raw;
}

/** {{my_company}}: the team name when the user is in a team, else User.companyName, else null (left unresolved). */
export function myCompany(user) {
  const team = String(user?.teamMembership?.team?.name || '').trim();
  if (team) return team;
  const own = String(user?.companyName || '').trim();
  return own || null;
}

/**
 * Values for every field the context can fill.
 * Base fields (carrier/broker and your own) are always present outside strict mode so old templates render
 * exactly as before ('' when missing). In strict mode (previews and the template picker) empty values are left
 * out so their tokens stay visible. Load, billing and link fields exist only when that context was given.
 */
export function mergeValues({ carrier, broker, user, load, invoice, extra, account, channel = 'email', strict = false } = {}) {
  const v = {};
  const base = (k, val) => {
    const s = val == null ? '' : String(val);
    if (s || !strict) v[k] = s;
  };
  const opt = (k, val) => { const s = val == null ? '' : String(val); if (s) v[k] = s; };

  const theBroker = broker || load?.broker || invoice?.broker || null;
  const theCarrier = carrier || load?.carrier || invoice?.carrier || null;
  // The recipient: an explicitly chosen carrier or broker first, then the load's carrier or broker.
  const entity = carrier || broker || theCarrier || theBroker || null;
  const full = contactName(entity);
  base('company', entity?.companyName);
  if (full) v.first_name = full.split(/\s+/)[0];
  else if (entity || !strict) v.first_name = 'there';
  base('contact_name', full);
  base('mc', entity?.mcNumber);
  base('dot', entity?.dotNumber);
  base('city', entity?.city);
  base('state', entity?.state);
  base('equipment', String(theCarrier?.equipment || '').split(',').filter(Boolean).map((e) => e.replace(/_/g, ' ')).join(', '));

  base('my_name', user?.name);
  base('my_first_name', String(user?.name || '').split(/\s+/)[0]);
  // The team name for team members, else the company name from Settings. Without either it is blank when sending
  // and flagged in previews.
  base('my_company', myCompany(user));
  base('my_phone', prettyPhone(user?.phone));
  opt('my_email', account?.fromEmail || user?.email);
  if (channel === 'email') base('signature', user?.emailSignature || user?.name);
  else v.signature = '';

  opt('carrier_company', theCarrier?.companyName);
  opt('carrier_mc', theCarrier?.mcNumber);
  opt('carrier_dot', theCarrier?.dotNumber);
  opt('broker_company', theBroker?.companyName);
  const theLoad = load || invoice?.load || null;
  if (theLoad) {
    const pTz = theLoad.pickupTz || timezoneForState(theLoad.originState) || user?.timezone;
    const dTz = theLoad.deliveryTz || timezoneForState(theLoad.destState) || user?.timezone;
    opt('load_ref', theLoad.referenceNumber);
    opt('pickup_city', place(theLoad.originCity, theLoad.originState));
    opt('pickup_date', formatAppointment(theLoad.pickupWindowStart, theLoad.pickupWindowEnd, theLoad.pickupDate, pTz));
    opt('pickup_address', [theLoad.pickupFacility, theLoad.pickupAddress].filter(Boolean).join(', '));
    opt('delivery_city', place(theLoad.destCity, theLoad.destState));
    opt('delivery_date', formatAppointment(theLoad.deliveryWindowStart, theLoad.deliveryWindowEnd, theLoad.deliveryDate, dTz));
    opt('delivery_address', [theLoad.deliveryFacility, theLoad.deliveryAddress].filter(Boolean).join(', '));
    if (Number.isFinite(theLoad.rateCents) && theLoad.rateCents > 0) {
      v.rate = usd(theLoad.rateCents);
      if (theLoad.loadedMiles > 0) v.rate_per_mile = `${usd2(Math.round(theLoad.rateCents / theLoad.loadedMiles))}/mi`;
    }
    if (theLoad.loadedMiles > 0) v.miles = new Intl.NumberFormat('en-US').format(theLoad.loadedMiles);
    opt('commodity', theLoad.commodity);
    if (theLoad.weightLbs > 0) v.weight = `${new Intl.NumberFormat('en-US').format(theLoad.weightLbs)} lbs`;
  }
  if (invoice) {
    opt('invoice_number', invoice.number);
    v.amount_due = usd2(Math.max(0, (invoice.amountCents || 0) - (invoice.paidCents || 0)));
    if (invoice.dueAt) v.invoice_due_date = new Intl.DateTimeFormat('en-US', { timeZone: safeTz(user?.timezone || 'America/Chicago'), month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(invoice.dueAt));
  }

  // Caller-supplied values (a link that was just created, a custom offer...). Keys use any accepted spelling.
  for (const [k, val] of Object.entries(extra || {})) {
    const s = val == null ? '' : String(val).trim();
    if (s) v[canonicalField(k)] = s.slice(0, 1000);
  }
  return v;
}

/** Sample values for previews: the sender's own details when known, sample data for everything else. */
export function sampleValues({ user, channel = 'email' } = {}) {
  const v = Object.fromEntries(FIELDS.map((f) => [f.key, f.sample]));
  if (user?.name) { v.my_name = user.name; v.my_first_name = user.name.split(/\s+/)[0]; }
  if (user?.phone) v.my_phone = prettyPhone(user.phone);
  if (user?.email) v.my_email = user.email;
  if (myCompany(user)) v.my_company = myCompany(user);
  v.signature =channel === 'email' ? (user?.emailSignature || user?.name || v.signature) : '';
  return v;
}

/**
 * Replace {{field}} tokens. Unknown tokens are left untouched so users notice typos.
 * `report` (optional) collects { unresolved: Set (known field, no value here), unknown: Set (not a field) }.
 */
export function applyMerge(text, values, report) {
  return String(text || '').replace(TOKEN, (m, key) => {
    const k = canonicalField(key);
    if (Object.prototype.hasOwnProperty.call(values, k)) return values[k];
    if (report) {
      if (FIELD_KEYS.has(k)) report.unresolved.add(k);
      else report.unknown.add(key);
    }
    return m;
  });
}

/** Resolve merge fields and append the signature to emails if the body didn't place it. Used when sending. */
export function renderContent({ subject, body, carrier, broker, user, load, invoice, extra, account, channel = 'email' }) {
  const values = mergeValues({ carrier, broker, user, load, invoice, extra, account, channel });
  // Sending: a known field this context cannot fill (a load or invoice field in a sequence or bulk email) goes out
  // blank, never as a raw {{token}}. Unknown tokens (typos) stay, as before; previews flag both.
  for (const k of FIELD_KEYS) if (!Object.prototype.hasOwnProperty.call(values, k)) values[k] = '';
  let text = applyMerge(body, values);
  if (channel === 'email' && user?.emailSignature && !/\{\{\s*signature\s*\}\}/i.test(body || '') && !text.includes(user.emailSignature)) {
    text = `${text.trimEnd()}\n\n${user.emailSignature}`;
  }
  return { subject: applyMerge(subject, values).slice(0, 300), body: text };
}

/**
 * Render for a preview or the template picker (strict): tokens without a value stay visible and are reported.
 * The email signature is not appended to `body`; it is returned as `signature` (sending adds it automatically).
 * -> { subject, body, signature, unresolved: [field], unknown: [token], fallbacks: [field] }
 */
export function renderPreview({ subject, body, channel = 'email', sample = false, ...ctx }) {
  const values = sample ? sampleValues({ user: ctx.user, channel }) : mergeValues({ ...ctx, channel, strict: true });
  const report = { unresolved: new Set(), unknown: new Set() };
  const outBody = applyMerge(body, values, report);
  const outSubject = channel === 'email' ? applyMerge(subject, values, report).slice(0, 300) : undefined;
  // Sending appends the saved signature when the body does not place {{signature}}; show the same here.
  const placed = /\{\{\s*signature\s*\}\}/i.test(`${body || ''}`);
  const entity = ctx.carrier || ctx.broker || ctx.load?.carrier || ctx.load?.broker || ctx.invoice?.carrier || ctx.invoice?.broker;
  const usesFirstName = fieldsIn(`${subject || ''} ${body || ''}`).has('first_name');
  const fallbacks = !sample && entity && !contactName(entity) && usesFirstName ? ['first_name'] : [];
  return {
    ...(outSubject !== undefined ? { subject: outSubject } : {}),
    body: outBody,
    signature: channel === 'email' && !placed ? (ctx.user?.emailSignature || null) : null,
    unresolved: [...report.unresolved],
    unknown: [...report.unknown],
    fallbacks,
  };
}

/** Canonical field names used in a text (to load only the context it needs). */
export function fieldsIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(TOKEN)) out.add(canonicalField(m[1]));
  return out;
}

export function unsubscribeUrl(ownerId, email) {
  return `${config.appUrl}/unsubscribe?token=${encodeURIComponent(signPayload({ o: ownerId, e: String(email).toLowerCase() }))}`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Final wire format: text + simple HTML, unsubscribe footer and List-Unsubscribe headers. */
export function toWire({ ownerId, to, subject, body }) {
  const unsub = unsubscribeUrl(ownerId, to);
  // RFC 8058 one-click endpoint (POST) lives on the API; the body link opens the confirmation page.
  const oneClick = unsub.replace('/unsubscribe?', '/api/public/unsubscribe?');
  const text = `${body}\n\n--\nDon't want these emails? Unsubscribe: ${unsub}`;
  const htmlBody = esc(body)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\r?\n/g, '<br>');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937">${htmlBody}`
    + `<p style="margin-top:24px;font-size:12px;color:#6b7280">Don't want these emails? <a href="${esc(unsub)}">Unsubscribe</a></p></div>`;
  return {
    to, subject, text, html,
    headers: { 'List-Unsubscribe': `<${oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'X-DispatchDesk': '1' },
  };
}
