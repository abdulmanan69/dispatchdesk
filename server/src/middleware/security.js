import cluster from 'node:cluster';
import { createHash } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { ClusterMemoryStoreWorker } from '@express-rate-limit/cluster-memory-store';
import { config } from '../config.js';
import { randomToken, safeEqual } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';

// Every cluster rate-limit store adds one 'message' listener to this worker (about 15 limiters, a fixed number set up
// at startup), which is more than Node's default warning threshold of 10.
if (cluster.isWorker) cluster.worker.setMaxListeners(Math.max(cluster.worker.getMaxListeners(), 50));

export const CSRF_COOKIE = 'dd_csrf';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
// Endpoints authenticated by other means (signatures) are exempt.
// Twilio callbacks are authenticated by X-Twilio-Signature instead.
const EXEMPT = [/^\/api\/billing\/webhook$/, /^\/api\/public\/unsubscribe/, /^\/api\/telephony\/twilio\//, /^\/api\/public\/track\//, /^\/api\/public\/load-track\//, /^\/api\/public\/portal\//, /^\/api\/public\/calendar\//]; // track: the secret link token is the credential

/** Lower-case path with repeated slashes collapsed, for security checks that must not be skipped by case or slash tricks. */
export const normalizedPath = (req) => String(req.path || '').toLowerCase().replace(/\/{2,}/g, '/');

/**
 * Double-submit CSRF protection: a random token is set in a readable cookie and
 * must be echoed in the X-CSRF-Token header on every state-changing request.
 * Combined with SameSite=Lax session cookies.
 */
export function csrf(req, res, next) {
  let token = req.cookies?.[CSRF_COOKIE];
  if (!token) {
    token = randomToken(24);
    res.cookie(CSRF_COOKIE, token, { httpOnly: false, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
    req.cookies[CSRF_COOKIE] = token;
  }
  const p = normalizedPath(req); // case/slash variants must not skip the check
  if (SAFE.has(req.method) || !p.startsWith('/api/') || EXEMPT.some((r) => r.test(p))) return next();
  // Bearer-token requests carry no ambient credentials (no cookies), so CSRF does not apply.
  if ((req.get('authorization') || '').startsWith('Bearer ddk_') && !req.cookies?.dd_session) return next();
  const header = req.get('x-csrf-token');
  if (!header || !safeEqual(header, token)) return next(new HttpError(403, 'Invalid or missing CSRF token. Refresh the page and try again.'));
  next();
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

const shortHash = (s) => createHash('sha256').update(String(s)).digest('base64url').slice(0, 22);

/**
 * Rate-limit key for an IP address. IPv4 addresses are used as they are; IPv6 addresses are grouped by their /64
 * prefix, which is what one home, office or phone network gets (otherwise a single client could rotate addresses).
 */
export function ipKey(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (s.startsWith('::ffff:') && s.includes('.')) return s.slice(7); // IPv4-mapped IPv6
  if (!s.includes(':')) return s;
  s = s.split('%')[0]; // zone index
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = s.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '') || '0').join(':')}::/64`;
}

/** Signed-in requests count against the user (or API token owner); anonymous ones against the network address. */
export const userOrIpKey = (req) => (req.user ? `u:${req.user.id}` : `ip:${ipKey(req.ip)}`);
export const ipOnlyKey = (req) => `ip:${ipKey(req.ip)}`;

/**
 * Sign-in style endpoints: per network address + account email, so one office behind a NAT does not share a single
 * budget, while guessing passwords for one account stays slow. Signed-in callers count per user.
 */
export function authKey(req) {
  if (req.user) return `u:${req.user.id}`;
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return email ? `ip:${ipKey(req.ip)}|e:${shortHash(email)}` : `ip:${ipKey(req.ip)}`;
}

/**
 * Secret-link endpoints (/api/public/<kind>/<token>/...): each link gets its own budget, so drivers on one carrier
 * network (CGNAT) do not throttle each other. Falls back to the address when the path has no token.
 */
export function linkTokenKey(req) {
  const full = `${req.baseUrl || ''}${req.path || ''}`;
  const m = full.match(/^\/api\/public\/[a-z-]+\/([^/]{16,})/i);
  return m ? `t:${shortHash(m[1])}` : `ip:${ipKey(req.ip)}`;
}

const isPublicLinkPath = (req) => /^\/api\/public\/(track|load-track|portal|calendar)\//i.test(`${req.baseUrl || ''}${req.path || ''}`);

/**
 * Create a rate limiter. In cluster mode the counters live in the primary process (one store per limiter, with its own
 * prefix), so every worker shares one limit per key. Disabled in tests and when RATE_LIMIT_DISABLED=true, unless `force`.
 * Create limiters at module load, never inside a request handler.
 */
export function makeLimiter(name, windowMs, limit, message, { key = userOrIpKey, skip = null, force = false, countOnly = null } = {}) {
  return rateLimit({
    windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
    ...(cluster.isWorker ? { store: new ClusterMemoryStoreWorker({ prefix: `${name}:` }) } : {}),
    // countOnly(res): only responses it returns true for use up the budget (the others are handed back when they finish).
    ...(countOnly ? { skipSuccessfulRequests: true, requestWasSuccessful: (req, res) => !countOnly(res) } : {}),
    keyGenerator: key,
    skip: (req, res) => (!force && (config.rateLimitDisabled || config.isTest)) || (skip ? !!skip(req, res) : false),
    handler: (req, res) => res.status(429).json({ error: message }),
  });
}

/** Run several middlewares in order as one (route definitions take a single limiter). */
export function chain(...mws) {
  return (req, res, next) => {
    let i = 0;
    const step = (err) => {
      if (err) return next(err);
      const mw = mws[i++];
      if (!mw) return next();
      try { mw(req, res, step); } catch (e) { next(e); }
    };
    step();
  };
}

const envInt = (name, fallback) => Math.max(1, Number(process.env[name]) || fallback);

/** Loose per-address ceiling against floods; runs before the session lookup so junk cookies cannot hammer the database. */
export const ipFloodLimiter = makeLimiter('ipflood', 60_000, envInt('RATE_LIMIT_IP_PER_MIN', 3000), 'Too many requests from this network. Try again in a minute.', { key: ipOnlyKey });
/** Main API budget, per signed-in user (address for anonymous calls). Secret-link endpoints have their own limiters. */
export const apiLimiter = makeLimiter('api', 60_000, envInt('RATE_LIMIT_USER_PER_MIN', 600), 'Too many requests. Slow down and try again in a minute.', { key: userOrIpKey, skip: isPublicLinkPath });

const authIpLimiter = makeLimiter('authip', 15 * 60_000, envInt('RATE_LIMIT_AUTH_IP', 200), 'Too many sign-in attempts from this network. Try again in 15 minutes.', { key: ipOnlyKey });
const authAccountLimiter = makeLimiter('auth', 15 * 60_000, envInt('RATE_LIMIT_AUTH_ACCOUNT', 20), 'Too many authentication attempts. Try again in 15 minutes.', { key: authKey });
/** Login and password reset: per address + email, with a looser per-address ceiling. */
export const authLimiter = chain(authIpLimiter, authAccountLimiter);
// Endpoints that send a platform email (password-reset link, verification link). Tighter, so nobody can use them to
// spam an inbox or burn the free SMTP provider's daily quota that verification and reset emails depend on.
const mailIpLimiter = makeLimiter('mailip', 60 * 60_000, envInt('RATE_LIMIT_MAIL_IP', 30), 'Too many emails requested from this network. Try again later.', { key: ipOnlyKey });
const mailAccountLimiter = makeLimiter('mail', 60 * 60_000, envInt('RATE_LIMIT_MAIL_ACCOUNT', 5), 'Too many emails requested for this account. Try again in an hour.', { key: authKey });
export const mailLimiter = chain(mailIpLimiter, mailAccountLimiter);
/** New accounts: per network address only (each signup has a new email, so email keys would not limit bots). */
export const registerLimiter = makeLimiter('register', 60 * 60_000, envInt('RATE_LIMIT_REGISTER_IP', 30), 'Too many new accounts from this network. Try again later.', { key: ipOnlyKey });

export const aiLimiter = makeLimiter('ai', 60_000, 30, 'Too many AI requests. Try again in a minute.', { key: userOrIpKey });
/** Driver link: per link token (drivers behind one carrier NAT keep separate budgets). */
export const trackLimiter = makeLimiter('track', 60_000, 30, 'Too many location updates. Try again in a minute.', { key: linkTokenKey });
/** Generic secret-link limiter a router can add for its own stricter budget: per link token. Mount with r.use(linkLimiter). */
export const linkLimiter = makeLimiter('link', 60_000, 60, 'Too many requests for this link. Try again in a minute.', { key: linkTokenKey });
/**
 * Applied by app.js to /api/public/{load-track,portal,calendar}/ (which skip the per-user API budget): per link token,
 * so a broker or carrier refreshing a shared link never shares a budget with other links on the same network.
 */
export const publicLinkLimiter = makeLimiter('publiclink', 60_000, envInt('RATE_LIMIT_LINK_PER_MIN', 120), 'Too many requests for this link. Try again in a minute.', { key: linkTokenKey });
/**
 * Per-token budgets give every guessed token a fresh bucket, so app.js also applies this per-address budget to all
 * /api/public/{track,load-track,portal,calendar}/ requests. Only unknown or expired links (404/410) count, so viewers
 * and drivers of real links behind one carrier or office network (CGNAT) are never throttled by it.
 */
export const linkMissLimiter = makeLimiter('linkmiss', 60_000, envInt('RATE_LIMIT_LINK_MISS_IP', 60), 'Too many invalid links from this network. Try again in a minute.', {
  key: ipOnlyKey, countOnly: (res) => res.statusCode === 404 || res.statusCode === 410,
});
export const publicFormLimiter = makeLimiter('public', 60 * 60_000, 20, 'Too many submissions. Try again later.', { key: ipOnlyKey });
/** File uploads (documents, avatars, knowledge files, listing images), per user, or per link for driver-link uploads. Applied by middleware/upload.js. */
export const uploadLimiter = makeLimiter('upload', 60_000, envInt('RATE_LIMIT_UPLOADS_PER_MIN', 30), 'Too many uploads. Try again in a minute.', { key: (req) => (req.user ? `u:${req.user.id}` : linkTokenKey(req)) });
