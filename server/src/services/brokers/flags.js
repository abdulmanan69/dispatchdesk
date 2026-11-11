/**
 * Broker vetting flags. Pure: no I/O and no clock (pass `now`).
 * Every flag comes from FMCSA public data, the previous snapshot, or the rate con the user pasted, and names its
 * source. Flags are levels of attention (red, amber, info), never a verdict: the card never calls a broker a fraud.
 *
 *   computeFlags(snapshot, { previous, rateCon: { phone, email }, known: { phones, emails }, now })
 *     -> [{ code, level, message, source, asOf }]
 */
export const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'mail.com', 'gmx.com', 'gmx.us', 'proton.me', 'protonmail.com', 'pm.me',
  'yandex.com', 'yandex.ru', 'zoho.com', 'zohomail.com', 'comcast.net', 'att.net', 'sbcglobal.net', 'verizon.net', 'bellsouth.net',
  'cox.net', 'charter.net', 'earthlink.net', 'juno.com', 'inbox.com', 'hushmail.com', 'tutanota.com', 'fastmail.com', 'mail.ru',
]);

const DAY = 86_400_000;
export const NEW_AUTHORITY_RED_DAYS = 180;
export const NEW_AUTHORITY_INFO_DAYS = 365;

export const digitsOf = (v) => {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d;
};
export const domainOf = (email) => {
  const m = String(email || '').trim().toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})$/);
  return m ? m[1].replace(/\.+$/, '') : null;
};
/** Registrable part of a domain ("ops.summit-logistics.com" -> "summit-logistics.com"); good enough for US broker domains. */
export const baseDomain = (domain) => {
  if (!domain) return null;
  const parts = domain.split('.');
  if (parts.length <= 2) return domain;
  const sld = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  return tld.length === 2 && /^(co|com|net|org|gov|ac)$/.test(sld) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
};

/** Damerau-Levenshtein distance (optimal string alignment): insert, delete, substitute, swap neighbours. */
export function editDistance(a, b) {
  a = String(a || '');
  b = String(b || '');
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const PO_BOX = /\b(p\.?\s*o\.?\s*box|post\s+office\s+box|pmb\s*\d|box\s+\d{1,6}\b)/i;
export const isPoBox = (street) => PO_BOX.test(String(street || ''));

const fmtPhone = (d) => (d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d);
const ymd = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
const addressKey = (a) => [a?.street, a?.city, a?.state, String(a?.zip || '').slice(0, 5)].map((x) => String(x || '').trim().toUpperCase().replace(/\s+/g, ' ')).join('|');

export function computeFlags(snapshot, { previous = null, rateCon = {}, known = {}, now = new Date() } = {}) {
  const flags = [];
  const asOf = snapshot?.checkedAt || null;
  const census = 'FMCSA census';
  const qc = 'FMCSA QCMobile';
  const add = (code, level, message, source, extra = {}) => flags.push({ code, level, message, source, asOf, ...extra });
  if (!snapshot) return flags;

  if (snapshot.found === false) {
    add('not_found', 'amber', `No FMCSA census record matches ${snapshot.query?.mc ? `MC ${snapshot.query.mc}` : `USDOT ${snapshot.query?.dot || ''}`}. Check the number with the broker.`, census);
  } else if (snapshot.found) {
    if (snapshot.usdotStatus === 'inactive') add('usdot_inactive', 'red', 'USDOT registration is inactive.', census);
    if (snapshot.registeredBroker === false) add('not_broker', 'amber', 'Not registered as a broker in the census (no broker code in the operation classification).', census);
    if (snapshot.brokerAuthority && snapshot.brokerAuthority !== 'active') {
      add('broker_authority', snapshot.brokerAuthority === 'pending' ? 'amber' : 'red', `Broker authority is ${snapshot.brokerAuthority}.`, qc);
    }
    if (snapshot.bondRequired === true && snapshot.bondOnFile === false) add('no_bond', 'red', 'A broker bond or trust (BMC-84/85) is required but none is on file.', qc);
    if (snapshot.allowedToOperate === false) add('not_allowed', 'red', 'FMCSA lists this company as not allowed to operate.', qc);
    if (snapshot.oosDate) add('out_of_service', 'red', `Out-of-service order dated ${ymd(snapshot.oosDate)}.`, qc);
    if (snapshot.addedAt) {
      const days = Math.floor((now.getTime() - new Date(snapshot.addedAt).getTime()) / DAY);
      if (days >= 0 && days < NEW_AUTHORITY_RED_DAYS) add('new_registration', 'amber', `USDOT number registered ${days} days ago (${ymd(snapshot.addedAt)}).`, census);
      else if (days >= 0 && days < NEW_AUTHORITY_INFO_DAYS) add('new_registration', 'info', `USDOT number registered less than a year ago (${ymd(snapshot.addedAt)}).`, census);
    }
    if (snapshot.address?.street && isPoBox(snapshot.address.street)) add('po_box', 'amber', 'The FMCSA address on file is a P.O. box.', census);

    if (previous?.found && previous.checkedAt) {
      const changed = [];
      const prevPhones = (previous.phones || []).join(',');
      if (prevPhones && prevPhones !== (snapshot.phones || []).join(',')) changed.push('phone');
      if (previous.email && previous.email !== snapshot.email) changed.push('email');
      if (previous.address && addressKey(previous.address) !== addressKey(snapshot.address)) changed.push('address');
      if (changed.length) {
        add('contact_changed', 'amber', `FMCSA ${changed.join(', ')} changed since ${ymd(previous.checkedAt)}.`, census, { changed });
      }
    }
  }

  // Rate-con contact block against FMCSA-listed and saved contacts.
  const listedPhones = new Set([...(snapshot.phones || []), ...((known.phones || []).map(digitsOf))].filter((p) => p && p.length >= 10));
  const rcPhone = digitsOf(rateCon.phone);
  if (rcPhone.length >= 10 && listedPhones.size && !listedPhones.has(rcPhone)) {
    const listed = [...(snapshot.phones || [])].map(fmtPhone).join(' or ');
    add('rate_con_phone', 'amber', `The rate con phone ${fmtPhone(rcPhone)} is not an FMCSA-listed or saved number for this broker.${listed ? ` Call back on ${listed} before dispatching.` : ''}`, 'Rate con');
  }
  const rcDomain = domainOf(rateCon.email);
  if (rcDomain) {
    const knownDomains = new Set([snapshot.email, ...(known.emails || [])].map(domainOf).filter(Boolean).map(baseDomain));
    const rcBase = baseDomain(rcDomain);
    if (FREE_MAIL_DOMAINS.has(rcDomain)) {
      add('free_mail', 'amber', `The rate con came from a free email address (${rcDomain}).`, 'Rate con');
    } else if (knownDomains.size && !knownDomains.has(rcBase)) {
      const close = [...knownDomains].filter((k) => !FREE_MAIL_DOMAINS.has(k)).find((k) => editDistance(k, rcBase) <= 2);
      if (close) add('lookalike_domain', 'red', `The rate con email domain ${rcDomain} looks like ${close} but is different.`, 'Rate con');
      else if ([...knownDomains].some((k) => !FREE_MAIL_DOMAINS.has(k))) add('other_domain', 'info', `The rate con email domain ${rcDomain} differs from the domain on file.`, 'Rate con');
    }
  }
  return flags;
}

/** Highest level among flags: 'red' | 'amber' | 'info' | null. */
export function topLevel(flags = []) {
  for (const level of ['red', 'amber', 'info']) if (flags.some((f) => f.level === level)) return level;
  return null;
}
