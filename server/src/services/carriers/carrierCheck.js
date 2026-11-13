import { normPhone } from './normalize.js';

/**
 * Carrier check search box: what a typed string means, and the FMCSA census filter for it.
 *   "MC 1248213", "mc-0647991"  -> { kind: 'mc' }      "USDOT 3636864", "DOT# 123" -> { kind: 'dot' }
 *   "3636864" (up to 9 digits)  -> { kind: 'number' }  (USDOT or MC, both are searched)
 *   "(516) 244-2068"            -> { kind: 'phone' }   "a@b.com" -> { kind: 'email' }   anything else -> { kind: 'name' }
 */
export function parseCheckQuery(input) {
  const raw = String(input ?? '').trim().slice(0, 120);
  if (!raw) return null;
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(raw)) return { kind: 'email', value: raw.toLowerCase() };
  const docket = /^(MC|MX|FF)[\s#:-]*0*(\d{1,8})$/i.exec(raw);
  if (docket) return { kind: 'mc', value: docket[2] };
  const usdot = /^(US\s*)?DOT[\s#:-]*0*(\d{1,9})$/i.exec(raw);
  if (usdot) return { kind: 'dot', value: usdot[2] };
  const digits = raw.replace(/[\s().+-]/g, '');
  if (/^\d+$/.test(digits)) {
    if (digits.length >= 10) {
      const phone = normPhone(digits);
      return phone && phone.length === 10 ? { kind: 'phone', value: phone } : null;
    }
    const n = digits.replace(/^0+/, '');
    return n ? { kind: 'number', value: n } : null;
  }
  const name = raw.toUpperCase().replace(/[%_'\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return name.length >= 2 ? { kind: 'name', value: name } : null;
}

const sq = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** Census $where for a parsed query; `dots` / `mcs` take an array (bulk check). Values are escaped here. */
export function checkWhere({ kind, value }) {
  switch (kind) {
    case 'email': return `email_address in(${sq(value)},${sq(value.toUpperCase())})`;
    case 'mc': return `docket1prefix='MC' AND docket1=${sq(value)}`;
    case 'dot': return `dot_number=${sq(value)}`;
    case 'phone': return `phone=${sq(value)} OR cell_phone=${sq(value)}`;
    case 'number': return `dot_number=${sq(value)} OR (docket1prefix='MC' AND docket1=${sq(value)})`;
    case 'dots': return `dot_number in(${value.map(sq).join(',')})`;
    case 'mcs': return `docket1prefix='MC' AND docket1 in(${value.map(sq).join(',')})`;
    default: {
      // "deans" also finds "DEAN'S": a trailing S may follow an apostrophe in the legal name.
      const words = String(value).split(' ').filter(Boolean).slice(0, 6).map((w) => (w.length > 3 && w.endsWith('S') ? `${w.slice(0, -1)}%` : w)).join('%');
      const like = `%${words}%`.replace(/%+/g, '%');
      return `upper(legal_name) like ${sq(like)} OR upper(dba_name) like ${sq(like)}`;
    }
  }
}

/** One search / bulk result row (census record annotated with authority and CRM state). */
export const checkRow = (rec) => ({
  dotNumber: rec.dotNumber,
  mcNumber: rec.mcNumber,
  companyName: rec.companyName,
  dbaName: rec.dbaName,
  city: rec.city,
  state: rec.state,
  usdotStatus: rec.usdotStatus,
  fleetSize: rec.fleetSize,
  drivers: rec.drivers,
  registeredAt: rec.authorityDate,
  mcs150Date: rec._extra?.mcs150Date || null,
  safetyRating: rec._extra?.safetyRating || null,
  carrierOperation: rec.carrierOperation,
  authority: rec.authority || null,
  authorityStatus: rec.authorityStatus || null,
  existsInCrm: rec.existsInCrm || false,
  existingId: rec.existingId || null,
});
