import crypto from 'node:crypto';
import { config } from '../../config.js';
import { getSettings } from '../../lib/settings.js';
import { randomToken, encrypt, decrypt, safeEqual } from '../../lib/crypto.js';

/**
 * "Continue with Google": OpenID Connect sign-in with the same Google OAuth client that connects Gmail mailboxes
 * (Admin → Settings → google.clientId / google.clientSecret). Only the basic profile scopes are requested.
 *
 * Flow: authorization code + PKCE (S256). The state, nonce and PKCE verifier travel in a short-lived httpOnly cookie
 * (AES-GCM sealed, so it is both authenticated and unreadable). The ID token returned by the token endpoint is verified
 * here with node:crypto against Google's published keys (JWKS), cached for the max-age Google sends (bounded).
 */

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_SIGNIN_SCOPES = ['openid', 'email', 'profile'];
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export const FLOW_TTL_MS = 10 * 60 * 1000; // the sign-in cookie lives 10 minutes
const CLOCK_SKEW_S = 60;
const HTTP_TIMEOUT_MS = 10_000;
const JWKS_MIN_TTL_MS = 60_000;
const JWKS_MAX_TTL_MS = 24 * 3600_000;
const JWKS_DEFAULT_TTL_MS = 3600_000;
const JWKS_MAX_KEYS = 16;
const JWKS_REFETCH_GAP_MS = 60_000; // an unknown key id refetches at most once a minute
const UNUSABLE_PREFIX = '!google:';

/** A failure with a short code, sent to the login page as ?reason=<code>. */
export class GoogleSignInError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export const signInRedirectUri = () => `${config.appUrl}/api/auth/google/callback`;

/** The shared Google OAuth client, or null when the client id or secret is missing. */
export async function googleCredentials() {
  const s = await getSettings(['google.clientId', 'google.clientSecret']);
  const clientId = String(s['google.clientId'] || '').trim();
  const clientSecret = String(s['google.clientSecret'] || '').trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export async function googleSignInAvailable() {
  return !!(await googleCredentials());
}

/** Password hash for accounts created with Google: never matches (not a 60-character bcrypt hash). */
export const unusablePasswordHash = () => `${UNUSABLE_PREFIX}${randomToken(24)}`;
/** True when the account has a real password (bcrypt hashes are 60 characters, see middleware/passwordHash.js). */
export const hasUsablePassword = (hash) => typeof hash === 'string' && hash.length === 60 && hash.startsWith('$2');

/**
 * Same-site relative path to return to after sign-in, or the fallback. Refuses absolute and protocol-relative URLs,
 * backslashes, control characters and anything that normalizes to another origin, plus API paths.
 */
export function safeNextPath(raw, fallback = '/app') {
  if (typeof raw !== 'string' || !raw || raw.length > 512) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\s\u0000-\u001f\u007f]/.test(raw)) return fallback;
  const base = 'http://next.invalid';
  let u;
  try { u = new URL(raw, base); } catch { return fallback; }
  if (u.origin !== base) return fallback;
  const out = `${u.pathname}${u.search}${u.hash}`;
  if (!out.startsWith('/') || out.startsWith('//') || /^\/api(\/|$)/i.test(u.pathname)) return fallback;
  return out;
}

/** New state, nonce and PKCE pair for one sign-in attempt. */
export function newFlow() {
  const verifier = randomToken(48); // 64 characters, within PKCE's 43-128
  return {
    state: randomToken(24),
    nonce: randomToken(24),
    verifier,
    challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
  };
}

/** Cookie value for the sign-in attempt: AES-GCM sealed (tamper-proof and unreadable) with its own expiry. */
export function sealFlow(data) {
  return encrypt(JSON.stringify({ ...data, exp: Date.now() + FLOW_TTL_MS }));
}

export function openFlow(value) {
  if (!value || typeof value !== 'string' || value.length > 4096) return null;
  try {
    const obj = JSON.parse(decrypt(value));
    if (!obj || typeof obj !== 'object' || typeof obj.exp !== 'number' || obj.exp < Date.now()) return null;
    if (typeof obj.s !== 'string' || typeof obj.n !== 'string' || typeof obj.v !== 'string') return null;
    return obj;
  } catch {
    return null;
  }
}

export function googleAuthUrl({ clientId, state, nonce, challenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: signInRedirectUri(),
    response_type: 'code',
    scope: GOOGLE_SIGNIN_SCOPES.join(' '),
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

/** Exchange the authorization code (with the PKCE verifier); returns the raw ID token. */
export async function exchangeGoogleCode({ clientId, clientSecret, code, verifier }) {
  let res;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier,
        grant_type: 'authorization_code', redirect_uri: signInRedirectUri(),
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GoogleSignInError('token', `Google token endpoint unreachable: ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleSignInError('token', `Google token request failed: ${data.error || res.status}`);
  if (typeof data.id_token !== 'string' || !data.id_token) throw new GoogleSignInError('token', 'Google did not return an ID token');
  return data.id_token;
}

// ---------------------------------------------------------------------------
// Google's signing keys (JWKS), cached for the response's max-age (bounded to 1 minute .. 24 hours)
// ---------------------------------------------------------------------------
let jwks = { keys: new Map(), expiresAt: 0, fetchedAt: 0 };
let jwksInflight = null;

/** For tests: forget the cached keys. */
export function resetGoogleKeys() {
  jwks = { keys: new Map(), expiresAt: 0, fetchedAt: 0 };
  jwksInflight = null;
}

function maxAgeMs(res) {
  const m = /(?:^|[,\s])max-age=(\d+)/i.exec(res.headers.get('cache-control') || '');
  const ms = m ? Number(m[1]) * 1000 : JWKS_DEFAULT_TTL_MS;
  return Math.min(JWKS_MAX_TTL_MS, Math.max(JWKS_MIN_TTL_MS, ms));
}

async function fetchKeys() {
  let res;
  try {
    res = await fetch(GOOGLE_JWKS_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    throw new GoogleSignInError('keys', `Google signing keys unreachable: ${err.message}`);
  }
  if (!res.ok) throw new GoogleSignInError('keys', `Google signing keys request failed: ${res.status}`);
  const body = await res.json().catch(() => null);
  const keys = new Map();
  for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
    if (keys.size >= JWKS_MAX_KEYS) break;
    if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || (jwk.use && jwk.use !== 'sig') || (jwk.alg && jwk.alg !== 'RS256')) continue;
    try {
      keys.set(jwk.kid, crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }));
    } catch { /* malformed key: skip */ }
  }
  if (!keys.size) throw new GoogleSignInError('keys', 'Google returned no usable signing keys');
  const now = Date.now();
  jwks = { keys, expiresAt: now + maxAgeMs(res), fetchedAt: now };
}

function refreshKeys() {
  if (!jwksInflight) jwksInflight = fetchKeys().finally(() => { jwksInflight = null; });
  return jwksInflight;
}

async function signingKey(kid) {
  const now = Date.now();
  if (now >= jwks.expiresAt) await refreshKeys();
  else if (!jwks.keys.has(kid) && now - jwks.fetchedAt >= JWKS_REFETCH_GAP_MS) await refreshKeys(); // rotated key
  const key = jwks.keys.get(kid);
  if (!key) throw new GoogleSignInError('signature', 'ID token signed with an unknown key');
  return key;
}

function decodePart(part) {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Verify a Google ID token: RS256 signature against Google's keys, issuer, audience (our client id), expiry and
 * issued-at with a small clock skew, the nonce we sent, and a verified email. Returns the claims.
 */
export async function verifyGoogleIdToken(idToken, { clientId, nonce, now = Date.now() }) {
  if (typeof idToken !== 'string' || idToken.length > 8192) throw new GoogleSignInError('invalid', 'Malformed ID token');
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new GoogleSignInError('invalid', 'Malformed ID token');
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  if (!header || !claims) throw new GoogleSignInError('invalid', 'Malformed ID token');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new GoogleSignInError('signature', 'Unexpected ID token algorithm');

  const key = await signingKey(header.kid);
  const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new GoogleSignInError('signature', 'ID token signature is invalid');

  if (!ISSUERS.has(claims.iss)) throw new GoogleSignInError('issuer', 'ID token issuer is not Google');
  const aud = claims.aud;
  const audOk = typeof aud === 'string' ? aud === clientId : Array.isArray(aud) && aud.includes(clientId) && claims.azp === clientId;
  if (!audOk) throw new GoogleSignInError('audience', 'ID token was issued for another app');
  const nowS = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) throw new GoogleSignInError('expired', 'ID token has expired');
  if (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_S > nowS) throw new GoogleSignInError('expired', 'ID token was issued in the future');
  if (typeof claims.nonce !== 'string' || !nonce || !safeEqual(claims.nonce, nonce)) throw new GoogleSignInError('nonce', 'ID token nonce does not match');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new GoogleSignInError('invalid', 'ID token has no subject');
  if (typeof claims.email !== 'string' || !claims.email.includes('@') || claims.email.length > 254) throw new GoogleSignInError('invalid', 'ID token has no email');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new GoogleSignInError('unverified', 'Google has not verified this email address');
  return claims;
}

/** Display name from the ID token, falling back to the email's local part. */
export function nameFromClaims(claims) {
  const full = typeof claims.name === 'string' ? claims.name : [claims.given_name, claims.family_name].filter((v) => typeof v === 'string').join(' ');
  const name = full.replace(/\s+/g, ' ').trim() || String(claims.email).split('@')[0];
  return name.slice(0, 120);
}
