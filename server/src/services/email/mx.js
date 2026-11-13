import dns from 'node:dns';

/**
 * Can this email address's domain receive mail? Used before the platform sends to an address nobody typed in themselves
 * (the FMCSA email of a carrier), because a hard bounce hurts the platform sender's reputation.
 *
 * mailDomainOk('a@b.com') -> true | false | null
 *   true   the domain has at least one usable MX record
 *   false  the domain does not exist, has no MX record, or publishes a "null MX" (RFC 7505: it accepts no mail)
 *   null   DNS did not answer (timeout, offline): unknown, so the caller decides (sign-in sends anyway)
 * Answers are cached for a few hours.
 */
const TTL_MS = 6 * 3_600_000;
const MAX_CACHED = 5000;
const cache = new Map(); // domain -> { ok, at }

let resolveMx = (domain) => dns.promises.resolveMx(domain);
/** Tests replace the DNS lookup (fn: domain -> MX records, or throws { code }). null restores the real one. */
export function setMxResolver(fn) {
  resolveMx = fn || ((domain) => dns.promises.resolveMx(domain));
  cache.clear();
}

const NO_MAIL = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

export async function mailDomainOk(email) {
  const domain = String(email || '').split('@').pop().trim().toLowerCase();
  if (!domain || !domain.includes('.')) return false;
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
  let ok;
  try {
    const records = await Promise.race([
      resolveMx(domain),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('DNS timeout'), { code: 'ETIMEOUT' })), 5000).unref?.()),
    ]);
    ok = Array.isArray(records) && records.some((r) => r?.exchange && r.exchange !== '.');
  } catch (err) {
    if (!NO_MAIL.has(err?.code)) return null; // unknown, not cached
    ok = false;
  }
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
  cache.set(domain, { ok, at: Date.now() });
  return ok;
}
