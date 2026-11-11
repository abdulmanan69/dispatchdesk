import dns from 'node:dns/promises';
import net from 'node:net';
import { badRequest } from './errors.js';

/**
 * Outbound connections to servers a user types in (their SMTP and IMAP mail servers) must reach the public internet
 * only: never this server, the Docker network, the VPS's private network or other reserved ranges.
 *
 * resolvePublicHost(host) resolves the name ONCE, refuses when the lookup fails, returns nothing, or ANY address is
 * reserved, and returns the vetted address. Callers connect to that address (with the name as TLS servername, so the
 * certificate is still checked against the name). Connecting by name instead would resolve it again and let a
 * short-TTL record answer a public address for the check and a private one for the connection (DNS rebinding).
 */

// IPv4 ranges that are not public unicast (RFC 6890 and friends), as [first octets..., prefix length].
const V4_RESERVED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([a, bits]) => [v4Int(a), bits]);

function v4Int(ip) {
  return ip.split('.').reduce((n, p) => (n * 256) + Number(p), 0);
}

function reservedV4(ip) {
  const n = v4Int(ip);
  return V4_RESERVED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
}

/** 16 bytes of an IPv6 address (any textual form, including an embedded dotted IPv4 tail), or null. */
export function v6Bytes(ip) {
  let s = String(ip).split('%')[0].toLowerCase();
  const tail = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  let v4 = null;
  if (tail) {
    if (!net.isIPv4(tail[1])) return null;
    v4 = tail[1].split('.').map(Number);
    s = `${s.slice(0, -tail[1].length)}0:0`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (x) => (x ? x.split(':') : []);
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const bytes = groups.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 255]; });
  if (v4) bytes.splice(12, 4, ...v4);
  return bytes;
}

const v4Of = (b, at) => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;
const zero = (b, from, to) => b.slice(from, to).every((x) => x === 0);

function reservedV6(ip) {
  const b = v6Bytes(ip);
  if (!b) return true;
  // IPv4-mapped (::ffff:a.b.c.d, in any spelling) and IPv4-compatible (::a.b.c.d): judge the IPv4 address.
  if (zero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return reservedV4(v4Of(b, 12));
  if (zero(b, 0, 12)) return true; // ::, ::1 and the deprecated IPv4-compatible form
  // NAT64 well-known prefix 64:ff9b::/96 carries an IPv4 address; the local-use 64:ff9b:1::/48 is private.
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return zero(b, 4, 12) ? reservedV4(v4Of(b, 12)) : true;
  }
  // 6to4 (2002::/16) embeds an IPv4 address in bytes 2-5.
  if (b[0] === 0x20 && b[1] === 0x02) return reservedV4(v4Of(b, 2));
  // Only 2000::/3 is global unicast; everything else (ULA fc00::/7, link-local fe80::/10, multicast ff00::/8,
  // discard 100::/64, ...) is refused.
  if ((b[0] & 0xe0) !== 0x20) return true;
  // Teredo 2001::/32, ORCHID and benchmarking inside 2001::/23, documentation 2001:db8::/32 and 3fff::/20.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true;
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && (b[3] === 0x02 || (b[3] & 0xf0) === 0x10 || (b[3] & 0xf0) === 0x20)) return true;
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;
  if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0x00) return true;
  return false;
}

/** True when `ip` is not a public unicast address (or is not an IP at all). */
export function isReservedIp(ip) {
  const v = net.isIP(String(ip || ''));
  if (v === 4) return reservedV4(String(ip));
  if (v === 6) return reservedV6(String(ip));
  return true;
}

const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home|home\.arpa|intranet|corp|localdomain)$/;

let lookupImpl = (host) => dns.lookup(host, { all: true, verbatim: true });
/** Replace the resolver (tests run without network access). Returns the previous one. */
export function setNetLookup(fn) {
  const prev = lookupImpl;
  lookupImpl = fn;
  return prev;
}

/**
 * Resolve `host` once and vet every address. Returns { host, address, family, servername } where `address` is the
 * vetted address to connect to and `servername` the name for TLS (null for an IP literal). Throws a 400 otherwise.
 * `label` names the server in the error ("SMTP server", "IMAP server").
 */
export async function resolvePublicHost(host, { label = 'mail server' } = {}) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  const refuse = () => { throw badRequest(`Use the public ${label} of your email provider`); };
  if (!h || LOCAL_NAME.test(h)) refuse();
  const literal = h.replace(/^\[(.*)\]$/, '$1');
  if (net.isIP(literal)) {
    if (isReservedIp(literal)) refuse();
    return { host: h, address: literal, family: net.isIP(literal), servername: null };
  }
  let addrs = [];
  try { addrs = await lookupImpl(h); } catch { addrs = []; }
  if (!Array.isArray(addrs) || !addrs.length) throw badRequest(`Could not find the ${label} ${h}. Check the server name.`);
  if (addrs.some((a) => isReservedIp(a?.address))) refuse();
  // Prefer IPv4: many container networks have no IPv6 route out.
  const pick = addrs.find((a) => a.family === 4) || addrs[0];
  return { host: h, address: pick.address, family: pick.family, servername: h };
}
