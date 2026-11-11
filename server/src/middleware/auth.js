import { createHash } from 'node:crypto';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { sha256, randomToken } from '../lib/crypto.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { broadcast, onBroadcast } from '../lib/broadcast.js';
import { getBool } from '../lib/settings.js';
import { systemMailConfigured } from '../services/email/system.js';

export const SESSION_COOKIE = 'dd_session';

/** Short fingerprint of the stored avatar file name: it changes only when the picture changes. */
export const avatarVersion = (avatarPath) => createHash('sha256').update(String(avatarPath)).digest('base64url').slice(0, 10);
/** Versioned avatar URL (served with a one-year immutable cache), or null without a picture. */
export const avatarUrl = (u) => (u?.avatarPath && u?.id ? `/api/profile/avatar/${u.id}?v=${avatarVersion(u.avatarPath)}` : null);

// Short-lived cache of session → user/permissions so each request does not re-join user, role and permissions.
// Entries live 10 s and are dropped immediately when a user is signed out, suspended, deleted or changes role/password.
const SESSION_TTL_MS = 10_000;
const sessionCache = new Map(); // sessionId -> { at, session }
function dropSessions(userId) {
  for (const [k, v] of sessionCache) if (!userId || v.session.userId === userId) sessionCache.delete(k);
}
onBroadcast('sessions', (userId) => dropSessions(userId));
/** Drop cached sessions for one user (or everyone when no id) in every process. */
export function invalidateUserSessions(userId) {
  broadcast('sessions', userId || null);
}
onBroadcast('session-token', (sid) => sessionCache.delete(sid));
function cachedSession(id) {
  const hit = sessionCache.get(id);
  if (hit && Date.now() - hit.at < SESSION_TTL_MS) return hit.session;
  if (hit) sessionCache.delete(id);
  return null;
}

const userInclude = {
  role: { include: { permissions: { include: { permission: true } } } },
  teamMembership: { include: { team: true } },
};

export function cookieOptions(maxAgeMs) {
  return { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/', maxAge: maxAgeMs };
}

export async function createSession(res, req, userId) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config.sessionDays * 86400000);
  await prisma.session.create({
    data: { id: sha256(token), userId, expiresAt, ip: req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 300) },
  });
  res.cookie(SESSION_COOKIE, token, cookieOptions(config.sessionDays * 86400000));
  return token;
}

export async function destroySession(req, res) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) broadcast('session-token', sha256(token));
  if (token) await prisma.session.deleteMany({ where: { id: sha256(token) } });
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

// Routes a personal API token (browser extension / integrations) may never reach.
const TOKEN_BLOCKED = [/^\/api\/admin/, /^\/api\/tokens/, /^\/api\/settings/, /^\/api\/auth\/(change-password|sessions|logout|resend-verification)/, /^\/api\/billing\/(checkout|portal|cancel|resume|change-plan)/, /^\/api\/teams/,
  // Device push subscriptions and the private calendar link are account secrets (both routers also refuse tokens).
  /^\/api\/push/, /^\/api\/calendar/,
  // Long-lived public links (carrier portal, broker tracking, driver location) and bulk exports or sends of financial
  // data. The handlers refuse tokens as well, so a router change cannot silently drop the guard.
  /^\/api\/customers\/[^/]+\/(portal|statements\/[^/]+\/send)(\/|$)/,
  /^\/api\/fleet\/(trips\/[^/]+\/tracking-links|carriers\/[^/]+\/share)(\/|$)/,
  /^\/api\/invoices\/(export\.csv|[^/]+\/send)(\/|$)/,
  /^\/api\/carriers\/export\.csv(\/|$)/];

/** Throw 403 when the request uses a personal API token (for routes that mint public links or export in bulk). */
export function refuseApiToken(req, what = 'this') {
  if (req.apiToken) throw forbidden(`API tokens cannot ${what}`);
}

/** Authenticate `Authorization: Bearer ddk_…` personal access tokens. */
async function loadApiToken(req, res, next, raw) {
  const row = await prisma.apiToken.findUnique({ where: { tokenHash: sha256(raw) }, include: { user: { include: userInclude } } });
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt < new Date()) || row.user.status !== 'active') {
    return res.status(401).json({ error: 'Invalid or revoked API token' });
  }
  // Compare a normalized path: lower-case and with repeated slashes collapsed, so case or slash tricks cannot skip the list.
  const p = req.path.toLowerCase().replace(/\/{2,}/g, '/');
  if (TOKEN_BLOCKED.some((r) => r.test(p))) return res.status(403).json({ error: 'API tokens cannot access this endpoint' });
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60000) {
    await prisma.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  req.apiToken = { id: row.id, name: row.name };
  req.user = row.user;
  req.permissions = new Set(row.user.role.permissions.map((rp) => rp.permission.key));
  next();
}

/** Attach req.user / req.permissions when a valid session cookie (or API token) is present. */
export async function loadSession(req, res, next) {
  try {
    const auth = req.get('authorization') || '';
    if (auth.startsWith('Bearer ddk_')) return await loadApiToken(req, res, next, auth.slice(7).trim());
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return next();
    const sid = sha256(token);
    let session = cachedSession(sid);
    if (!session) {
      session = await prisma.session.findUnique({ where: { id: sid }, include: { user: { include: userInclude } } });
      if (session) {
        if (sessionCache.size > 20000) sessionCache.clear();
        sessionCache.set(sid, { at: Date.now(), session });
      }
    }
    if (!session || session.expiresAt < new Date()) {
      sessionCache.delete(sid);
      if (session) await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      return next();
    }
    if (session.user.status !== 'active') {
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      return next();
    }
    // Sliding expiration, written at most every 5 minutes.
    if (Date.now() - session.lastSeenAt.getTime() > 5 * 60000) {
      const expiresAt = new Date(Date.now() + config.sessionDays * 86400000);
      await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(), expiresAt } });
      session.lastSeenAt = new Date();
      res.cookie(SESSION_COOKIE, token, cookieOptions(config.sessionDays * 86400000));
    }
    req.sessionId = session.id;
    req.user = session.user;
    req.permissions = new Set(session.user.role.permissions.map((rp) => rp.permission.key));
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

// Writes an unverified account may still make while verification is required: signing in and out, verifying, the
// profile, deleting the account, stopping payments, its own UI state, and secret-link / signed provider endpoints.
const VERIFY_EXEMPT = [
  /^\/api\/auth\//, /^\/api\/profile(\/|$)/, /^\/api\/public\//, /^\/api\/telephony\/twilio\//,
  /^\/api\/billing\/(webhook|portal|cancel)$/, /^\/api\/settings\/account$/,
  /^\/api\/tours(\/|$)/, /^\/api\/notifications(\/|$)/, /^\/api\/push(\/|$)/,
];
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Enforce "Require email verification" (System settings → app.requireEmailVerification).
 * Only when the setting is on AND platform email is configured (otherwise nobody could verify): unverified accounts can
 * sign in and read everything, but API writes return 403 { code: 'EMAIL_UNVERIFIED' } until the email is verified.
 * Admins are never locked out. Runs after loadSession, for every /api request.
 */
export async function requireVerifiedEmail(req, res, next) {
  try {
    if (!req.user || req.user.emailVerifiedAt || READ_METHODS.has(req.method)) return next();
    const p = `${req.baseUrl || ''}${req.path || ''}`.toLowerCase().replace(/\/{2,}/g, '/');
    if (!p.startsWith('/api/') || VERIFY_EXEMPT.some((r) => r.test(p))) return next();
    if (req.permissions?.has('admin.access')) return next();
    if (!(await getBool('app.requireEmailVerification')) || !(await systemMailConfigured())) return next();
    res.status(403).json({
      error: 'Verify your email address to continue. Open the link we emailed you, or use "Resend link" at the top of the page.',
      code: 'EMAIL_UNVERIFIED',
      details: { code: 'EMAIL_UNVERIFIED' },
    });
  } catch (err) {
    next(err);
  }
}

/** True when the platform requires verified emails and can send the verification email. */
export async function emailVerificationRequired() {
  return (await getBool('app.requireEmailVerification')) && (await systemMailConfigured());
}

/**
 * Flags sent next to the user wherever the client receives its account (/api/auth/me, sign-in, profile updates), so
 * the verification banner keeps its state after a profile change. mailConfigured: platform email can be sent;
 * verificationRequired: unverified accounts cannot make changes yet.
 */
export async function mailFlags() {
  const [mailConfigured, verificationRequired] = await Promise.all([systemMailConfigured(), emailVerificationRequired()]);
  return { mailConfigured, verificationRequired };
}

export const hasPermission = (req, key) => !!req.permissions?.has(key);

/** Require every listed permission (checked on the server, independent of UI). */
export function requirePermission(...keys) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    for (const k of keys) if (!req.permissions.has(k)) return next(forbidden());
    next();
  };
}

/** Serialize the current user for the client — never includes the password hash. */
export function publicUser(user, permissions) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    bio: user.bio,
    companyName: user.companyName ?? null,
    avatarUrl: avatarUrl(user),
    role: user.role?.key,
    roleName: user.role?.name,
    permissions: permissions ? [...permissions] : [],
    emailVerified: !!user.emailVerifiedAt,
    theme: user.theme,
    timezone: user.timezone,
    emailSignature: user.emailSignature,
    notifyEmail: user.notifyEmail,
    notifyInApp: user.notifyInApp,
    notifyFollowUps: user.notifyFollowUps,
    notifyCommunity: user.notifyCommunity,
    notifyPush: user.notifyPush,
    notifyDigest: user.notifyDigest,
    team: user.teamMembership
      ? { id: user.teamMembership.teamId, name: user.teamMembership.team?.name, role: user.teamMembership.role, canViewTeamData: user.teamMembership.canViewTeamData, canManageMembers: user.teamMembership.canManageMembers }
      : null,
    createdAt: user.createdAt,
  };
}
