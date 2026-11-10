import cluster from 'node:cluster';
import rateLimit from 'express-rate-limit';
import { ClusterMemoryStoreWorker } from '@express-rate-limit/cluster-memory-store';
import { config } from '../config.js';
import { randomToken, safeEqual } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';

export const CSRF_COOKIE = 'dd_csrf';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
// Endpoints authenticated by other means (signatures) are exempt.
// Twilio callbacks are authenticated by X-Twilio-Signature instead.
const EXEMPT = [/^\/api\/billing\/webhook$/, /^\/api\/public\/unsubscribe/, /^\/api\/telephony\/twilio\//, /^\/api\/public\/track\//]; // track: the secret link token is the credential

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
  if (SAFE.has(req.method) || !req.path.startsWith('/api/') || EXEMPT.some((r) => r.test(req.path))) return next();
  // Bearer-token requests carry no ambient credentials (no cookies), so CSRF does not apply.
  if ((req.get('authorization') || '').startsWith('Bearer ddk_') && !req.cookies?.dd_session) return next();
  const header = req.get('x-csrf-token');
  if (!header || !safeEqual(header, token)) return next(new HttpError(403, 'Invalid or missing CSRF token. Refresh the page and try again.'));
  next();
}

// In cluster mode the counters live in the primary process, so every worker shares one limit per client.
const make = (name, windowMs, limit, message) =>
  rateLimit({
    windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
    ...(cluster.isWorker ? { store: new ClusterMemoryStoreWorker({ prefix: `${name}:` }) } : {}),
    skip: () => config.rateLimitDisabled || config.isTest,
    handler: (req, res) => res.status(429).json({ error: message }),
  });

export const apiLimiter = make('api', 60_000, 600, 'Too many requests. Slow down and try again in a minute.');
export const authLimiter = make('auth', 15 * 60_000, 30, 'Too many authentication attempts. Try again in 15 minutes.');
export const aiLimiter = make('ai', 60_000, 30, 'Too many AI requests. Try again in a minute.');
export const trackLimiter = make('track', 60_000, 30, 'Too many location updates. Try again in a minute.');
export const publicFormLimiter = make('public', 60 * 60_000, 20, 'Too many submissions. Try again later.');
