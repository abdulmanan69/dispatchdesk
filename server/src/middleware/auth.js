import { prisma } from '../db.js';
import { config } from '../config.js';
import { sha256, randomToken } from '../lib/crypto.js';
import { unauthorized, forbidden } from '../lib/errors.js';

export const SESSION_COOKIE = 'dd_session';

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
  if (token) await prisma.session.deleteMany({ where: { id: sha256(token) } });
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

// Routes a personal API token (browser extension / integrations) may never reach.
const TOKEN_BLOCKED = [/^\/api\/admin/, /^\/api\/tokens/, /^\/api\/settings/, /^\/api\/auth\/(change-password|sessions|logout|resend-verification)/, /^\/api\/billing\/(checkout|portal|cancel|resume|change-plan)/, /^\/api\/teams/];

/** Authenticate `Authorization: Bearer ddk_…` personal access tokens. */
async function loadApiToken(req, res, next, raw) {
  const row = await prisma.apiToken.findUnique({ where: { tokenHash: sha256(raw) }, include: { user: { include: userInclude } } });
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt < new Date()) || row.user.status !== 'active') {
    return res.status(401).json({ error: 'Invalid or revoked API token' });
  }
  if (TOKEN_BLOCKED.some((r) => r.test(req.path))) return res.status(403).json({ error: 'API tokens cannot access this endpoint' });
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
    const session = await prisma.session.findUnique({ where: { id: sha256(token) }, include: { user: { include: userInclude } } });
    if (!session || session.expiresAt < new Date()) {
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
    avatarUrl: user.avatarPath ? `/api/profile/avatar/${user.id}?v=${user.updatedAt?.getTime?.() ?? ''}` : null,
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
    team: user.teamMembership
      ? { id: user.teamMembership.teamId, name: user.teamMembership.team?.name, role: user.teamMembership.role, canViewTeamData: user.teamMembership.canViewTeamData, canManageMembers: user.teamMembership.canManageMembers }
      : null,
    createdAt: user.createdAt,
  };
}
