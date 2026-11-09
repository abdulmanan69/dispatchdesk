import { config } from '../../config.js';
import { signPayload } from '../../lib/crypto.js';

export const MERGE_FIELDS = {
  company: 'Carrier or broker company name',
  first_name: 'Primary contact first name (falls back to "there")',
  contact_name: 'Primary contact full name',
  mc: 'MC number',
  dot: 'USDOT number',
  city: 'City',
  state: 'State',
  equipment: 'Equipment types',
  sender_name: 'Your name',
  sender_phone: 'Your phone',
  signature: 'Your email signature',
};

function contactName(entity) {
  const primary = entity?.contacts?.find((c) => c.isPrimary) || entity?.contacts?.[0];
  return primary?.name || entity?.contactName || '';
}

export function mergeValues({ carrier, broker, user }) {
  const entity = carrier || broker || {};
  const full = contactName(entity);
  return {
    company: entity.companyName || '',
    first_name: full ? full.split(/\s+/)[0] : 'there',
    contact_name: full || '',
    mc: entity.mcNumber || '',
    dot: entity.dotNumber || '',
    city: entity.city || '',
    state: entity.state || '',
    equipment: (carrier?.equipment || '').split(',').filter(Boolean).map((e) => e.replace(/_/g, ' ')).join(', '),
    sender_name: user?.name || '',
    sender_phone: user?.phone || '',
    signature: user?.emailSignature || '',
  };
}

/** Replace {{field}} tokens. Unknown tokens are left untouched so users notice typos. */
export function applyMerge(text, values) {
  return String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, key) => {
    const k = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(values, k) ? values[k] : m;
  });
}

/** Resolve merge fields and append the signature if the body didn't place it. */
export function renderContent({ subject, body, carrier, broker, user }) {
  const values = mergeValues({ carrier, broker, user });
  let text = applyMerge(body, values);
  if (user?.emailSignature && !/\{\{\s*signature\s*\}\}/i.test(body || '') && !text.includes(user.emailSignature)) {
    text = `${text.trimEnd()}\n\n${user.emailSignature}`;
  }
  return { subject: applyMerge(subject, values).slice(0, 300), body: text };
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
