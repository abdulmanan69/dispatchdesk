/**
 * Phone helpers. Carriers are stored as 10-digit US/CA numbers; dialing needs E.164.
 */
export const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');

/** E.164 for dialing: 10 digits → +1…, 11 digits starting with 1 → +1…, explicit +intl kept. Null when implausible. */
export function toE164(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  const d = digitsOf(s);
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (s.startsWith('+') && d.length >= 8 && d.length <= 15) return `+${d}`;
  return null;
}

/** The 10-digit form used for carrier.phone matching. */
export function toNational(raw) {
  const d = digitsOf(raw);
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length === 10 ? d : null;
}

export function prettyPhone(raw) {
  const n = toNational(raw);
  return n ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : String(raw ?? '');
}
