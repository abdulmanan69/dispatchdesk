/**
 * Client-side merge helpers. The server (POST /api/templates/render) is the source of truth for emails and
 * texts; this file covers call scripts, which are filled in the browser from data already on screen.
 * Names and aliases match server/src/services/email/render.js.
 */
const TOKEN = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;

export const ALIASES = {
  sender_name: 'my_name', sender_first_name: 'my_first_name', sender_phone: 'my_phone', sender_email: 'my_email', sender_company: 'my_company',
  your_name: 'my_name', my_phone_number: 'my_phone', my_company_name: 'my_company',
  company_name: 'company', carrier_name: 'carrier_company',
  firstname: 'first_name', contact_first_name: 'first_name', contact_full_name: 'contact_name',
  mc_number: 'mc', dot_number: 'dot', usdot: 'dot',
};

const normalize = (key) => String(key).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
export const canonicalField = (key) => { const k = normalize(key); return ALIASES[k] || k; };

/** Canonical field names used in a text. */
export function tokensIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(TOKEN)) out.add(canonicalField(m[1]));
  return out;
}

/**
 * Fill {{tokens}}. `missing`: 'keep' leaves unknown or empty tokens as typed; 'bracket' shows them as [company]
 * so a preview reads naturally while still showing what is missing.
 */
export function mergeText(text, values = {}, { missing = 'keep' } = {}) {
  return String(text || '').replace(TOKEN, (m, key) => {
    const k = canonicalField(key);
    const v = values[k];
    if (v != null && v !== '') return String(v);
    return missing === 'bracket' ? `[${k.replace(/_/g, ' ')}]` : m;
  });
}

function primaryContact(contacts) {
  const list = contacts || [];
  return list.find((c) => c.isPrimary) || list[0] || null;
}

/** Values for call scripts from the carrier on screen (contacts optional) and the signed-in user. */
export function scriptValues({ carrier, contacts, user } = {}) {
  const contact = primaryContact(contacts || carrier?.contacts);
  const first = contact?.name ? contact.name.split(/\s+/)[0] : '';
  return {
    company: carrier?.companyName || '',
    first_name: first || (carrier ? 'there' : ''),
    contact_name: contact?.name || '',
    mc: carrier?.mcNumber || '',
    dot: carrier?.dotNumber || '',
    city: carrier?.city || '',
    state: carrier?.state || '',
    equipment: String(carrier?.equipment || '').split(',').filter(Boolean).map((e) => e.replace(/_/g, ' ')).join(', '),
    my_name: user?.name || '',
    my_first_name: String(user?.name || '').split(/\s+/)[0],
    my_phone: user?.phone || '',
    my_email: user?.email || '',
    my_company: myCompany(user),
  };
}

/** {{my_company}}: the team name for team members, else the company name from Settings, else '' (token left as typed). */
export function myCompany(user) {
  return String(user?.team?.name || '').trim() || String(user?.companyName || '').trim() || '';
}

// GSM 03.38 basic character set (plus the extension table, which counts double). Anything else forces UCS-2.
const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = '^{}\\[~]|€';

/** Length and SMS segment count (160/153 for plain text, 70/67 when the text needs Unicode). */
export function smsInfo(text) {
  const s = String(text || '');
  let units = 0;
  let unicode = false;
  for (const ch of s) {
    if (GSM_BASIC.includes(ch)) units += 1;
    else if (GSM_EXT.includes(ch)) units += 2;
    else { unicode = true; break; }
  }
  if (unicode) {
    const n = [...s].length;
    return { chars: n, unicode: true, segments: n === 0 ? 0 : n <= 70 ? 1 : Math.ceil(n / 67) };
  }
  return { chars: [...s].length, unicode: false, segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153) };
}
