import { Router } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { ah, badRequest, unauthorized, forbidden, conflict } from '../lib/errors.js';
import { parse, z, reqEmail, reqStr } from '../lib/validate.js';
import { randomToken, sha256, safeEqual } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { getBool, getSetting } from '../lib/settings.js';
import { createSession, destroySession, requireAuth, publicUser, invalidateUserSessions, mailFlags, refuseApiToken } from '../middleware/auth.js';
import { authLimiter, registerLimiter, mailLimiter, makeLimiter, ipOnlyKey } from '../middleware/security.js';
import { hashPassword, verifyPassword } from '../middleware/passwordHash.js';
import { sendSystemMail } from '../services/email/system.js';
import {
  GoogleSignInError, FLOW_TTL_MS, googleCredentials, googleSignInAvailable, safeNextPath, newFlow, sealFlow, openFlow,
  googleAuthUrl, exchangeGoogleCode, verifyGoogleIdToken, nameFromClaims, unusablePasswordHash, hasUsablePassword,
} from '../services/auth/google.js';

const r = Router();

// Google sign-in callback: per network address (the request carries no email), like the login limiter's address ceiling.
const googleLimiter = makeLimiter('googleauth', 15 * 60_000, Math.max(1, Number(process.env.RATE_LIMIT_GOOGLE_IP) || 60),
  'Too many sign-in attempts from this network. Try again in 15 minutes.', { key: ipOnlyKey });

const password = z.string().min(8, 'Use at least 8 characters').max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Include at least one letter and one number');

async function issueToken(userId, type, ttlMs) {
  const token = randomToken(32);
  await prisma.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.authToken.create({ data: { userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) } });
  return token;
}

async function consumeToken(token, type) {
  const row = await prisma.authToken.findUnique({ where: { tokenHash: sha256(String(token || '')) } });
  if (!row || row.type !== type || row.usedAt || row.expiresAt < new Date()) throw badRequest('This link is invalid or has expired');
  await prisma.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  return row;
}

async function sendVerification(user) {
  const token = await issueToken(user.id, 'verify_email', 48 * 3600 * 1000);
  const link = `${config.appUrl}/verify-email?token=${token}`;
  const appName = await getSetting('app.name');
  const mail = await sendSystemMail({
    to: user.email,
    subject: `Verify your ${appName} email`,
    text: `Hi ${user.name},\n\nConfirm your email address by opening this link:\n${link}\n\nThe link expires in 48 hours.`,
  });
  return { token, mail };
}

const devToken = (t) => (config.exposeDevTokens ? { devToken: t } : {});

async function meResponse(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { role: { include: { permissions: { include: { permission: true } } } }, teamMembership: { include: { team: true } } },
  });
  return { ...publicUser(user, user.role.permissions.map((p) => p.permission.key)), ...(await mailFlags()) };
}

r.get('/csrf', (req, res) => res.json({ ok: true }));

r.get('/me', ah(async (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: { ...publicUser(req.user, req.permissions), ...(await mailFlags()) } });
}));

r.post('/register', registerLimiter, ah(async (req, res) => {
  if (!(await getBool('app.registrationOpen'))) throw forbidden('Registration is currently closed');
  const body = parse(z.object({
    name: reqStr(120), email: reqEmail, password, phone: z.string().trim().max(40).optional(),
    acceptTerms: z.literal(true, { message: 'You must accept the terms' }),
  }), req.body);
  if (await prisma.user.findUnique({ where: { email: body.email } })) throw conflict('An account with this email already exists');
  const role = await prisma.role.findUnique({ where: { key: 'dispatcher' } });
  const user = await prisma.user.create({
    data: { name: body.name, email: body.email, phone: body.phone || null, passwordHash: await hashPassword(body.password), roleId: role.id },
  });
  const { token, mail } = await sendVerification(user);
  await createSession(res, req, user.id);
  await audit(req, 'auth.register', { entityType: 'user', entityId: user.id, actorId: user.id });
  res.status(201).json({ user: await meResponse(user.id), verificationEmailSent: mail.sent, ...devToken(token) });
}));

r.post('/login', authLimiter, ah(async (req, res) => {
  const body = parse(z.object({ email: reqEmail, password: z.string().min(1).max(200) }), req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  // Unknown emails are compared against a dummy hash of the same cost, so timing does not reveal which accounts exist.
  // The comparison runs on a worker thread (middleware/passwordHash.js), not on the request thread.
  const ok = await verifyPassword(body.password, user?.passwordHash);
  if (!user || !ok) {
    await audit(req, 'auth.login_failed', { details: { email: body.email } });
    throw unauthorized('Incorrect email or password');
  }
  if (user.status !== 'active') throw forbidden('This account is suspended. Contact support.');
  await createSession(res, req, user.id);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit(req, 'auth.login', { entityType: 'user', entityId: user.id, actorId: user.id });
  res.json({ user: await meResponse(user.id) });
}));

r.post('/logout', ah(async (req, res) => {
  if (req.user) await audit(req, 'auth.logout');
  await destroySession(req, res);
  res.json({ ok: true });
}));

r.post('/verify-email', ah(async (req, res) => {
  const { token } = parse(z.object({ token: reqStr(200) }), req.body);
  const row = await consumeToken(token, 'verify_email');
  await prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } });
  invalidateUserSessions(row.userId);
  await audit(req, 'auth.email_verified', { entityType: 'user', entityId: row.userId, actorId: row.userId });
  res.json({ ok: true });
}));

r.post('/resend-verification', requireAuth, mailLimiter, ah(async (req, res) => {
  if (req.user.emailVerifiedAt) return res.json({ ok: true, alreadyVerified: true });
  const { token, mail } = await sendVerification(req.user);
  res.json({ ok: true, emailSent: mail.sent, reason: mail.reason, ...devToken(token) });
}));

r.post('/forgot-password', mailLimiter, ah(async (req, res) => {
  const { email } = parse(z.object({ email: reqEmail }), req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  let extra = {};
  if (user && user.status === 'active') {
    const token = await issueToken(user.id, 'reset_password', 3600 * 1000);
    const link = `${config.appUrl}/reset-password?token=${token}`;
    const mail = await sendSystemMail({
      to: user.email, subject: 'Reset your password',
      text: `Hi ${user.name},\n\nReset your password with this link (valid for 1 hour):\n${link}\n\nIf you did not request this, ignore this email.`,
    }).catch((err) => ({ sent: false, reason: err.message }));
    // The response stays the same either way (no account enumeration); a failed send is logged and audited so an
    // admin can see it (Admin → Audit log, and the platform email card in Admin → Setup).
    if (!mail.sent) console.warn(`[auth] password reset email for user ${user.id} not sent: ${mail.reason}`);
    await audit(req, 'auth.password_reset_requested', {
      entityType: 'user', entityId: user.id, actorId: user.id,
      details: mail.sent ? { emailSent: true } : { emailSent: false, reason: String(mail.reason || 'unknown').slice(0, 300) },
    });
    extra = devToken(token);
  }
  // Same response whether or not the account exists (prevents account enumeration).
  res.json({ ok: true, message: 'If an account exists for that email, a reset link has been sent.', ...extra });
}));

r.post('/reset-password', authLimiter, ah(async (req, res) => {
  const body = parse(z.object({ token: reqStr(200), password }), req.body);
  const row = await consumeToken(body.token, 'reset_password');
  await prisma.user.update({ where: { id: row.userId }, data: { passwordHash: await hashPassword(body.password) } });
  await prisma.session.deleteMany({ where: { userId: row.userId } });
  invalidateUserSessions(row.userId);
  await audit(req, 'auth.password_reset', { entityType: 'user', entityId: row.userId, actorId: row.userId });
  res.json({ ok: true });
}));

r.post('/change-password', requireAuth, ah(async (req, res) => {
  const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), req.body);
  if (!(await verifyPassword(body.currentPassword, req.user.passwordHash))) throw badRequest('Current password is incorrect');
  await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash: await hashPassword(body.newPassword) } });
  await prisma.session.deleteMany({ where: { userId: req.user.id, NOT: { id: req.sessionId } } });
  invalidateUserSessions(req.user.id);
  await audit(req, 'auth.password_changed');
  res.json({ ok: true });
}));

r.get('/sessions', requireAuth, ah(async (req, res) => {
  const rows = await prisma.session.findMany({ where: { userId: req.user.id, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: 'desc' } });
  res.json({
    items: rows.map((s) => ({ id: s.id.slice(0, 12), current: s.id === req.sessionId, ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt })),
  });
}));

r.delete('/sessions/:prefix', requireAuth, ah(async (req, res) => {
  const prefix = String(req.params.prefix);
  if (prefix.length < 12) throw badRequest('Invalid session id');
  const result = await prisma.session.deleteMany({ where: { userId: req.user.id, id: { startsWith: prefix }, NOT: { id: req.sessionId } } });
  invalidateUserSessions(req.user.id);
  await audit(req, 'auth.session_revoked');
  res.json({ revoked: result.count });
}));

r.post('/sessions/revoke-others', requireAuth, ah(async (req, res) => {
  const result = await prisma.session.deleteMany({ where: { userId: req.user.id, NOT: { id: req.sessionId } } });
  invalidateUserSessions(req.user.id);
  await audit(req, 'auth.sessions_revoked');
  res.json({ revoked: result.count });
}));

// ---------------------------------------------------------------------------
// Continue with Google (OpenID Connect, services/auth/google.js)
// ---------------------------------------------------------------------------
const GOOGLE_COOKIE = 'dd_google_auth';
const GOOGLE_COOKIE_PATH = '/api/auth/google';

/** End a Google sign-in attempt on the login page with a short reason code; never signs anyone in. */
function googleFail(res, reason) {
  res.clearCookie(GOOGLE_COOKIE, { path: GOOGLE_COOKIE_PATH });
  res.set('Cache-Control', 'no-store');
  return res.redirect(`/login?${new URLSearchParams({ error: 'google', reason })}`);
}

/** Account by email, ignoring letter case (emails are stored lower-case; older rows may not be). */
async function userByEmail(email) {
  const exact = await prisma.user.findUnique({ where: { email } });
  if (exact) return exact;
  const rows = await prisma.$queryRaw`SELECT id FROM "User" WHERE lower(email) = ${email} LIMIT 1`;
  return rows[0] ? prisma.user.findUnique({ where: { id: rows[0].id } }) : null;
}

/**
 * Link a Google account to an existing account with the same (Google-verified) email. When that account's email was
 * never verified, whoever set its password never proved they own the address (someone could have registered it ahead
 * of the real owner): the password, other sessions and API tokens are revoked, so only the address owner keeps access.
 */
async function linkGoogle(req, user, sub) {
  const unverified = !user.emailVerifiedAt;
  const data = { googleSub: sub, ...(unverified ? { emailVerifiedAt: new Date(), passwordHash: unusablePasswordHash() } : {}) };
  const linked = await prisma.user.update({ where: { id: user.id }, data });
  if (unverified) {
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.apiToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  invalidateUserSessions(user.id);
  await audit(req, 'auth.google_linked', { entityType: 'user', entityId: user.id, actorId: user.id, details: { via: 'sign_in', ...(unverified ? { credentialsReset: true } : {}) } });
  return linked;
}

/** True when Google sign-in is configured (the login and register pages show the button only then). */
r.get('/providers', ah(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ google: await googleSignInAvailable() });
}));

r.get('/google/start', ah(async (req, res) => {
  const creds = await googleCredentials();
  if (!creds) return googleFail(res, 'not_configured');
  const mode = req.query.mode === 'register' ? 'register' : 'login';
  const next = safeNextPath(typeof req.query.next === 'string' ? req.query.next : '');
  const flow = newFlow();
  res.cookie(GOOGLE_COOKIE, sealFlow({ s: flow.state, n: flow.nonce, v: flow.verifier, m: mode, next }), {
    httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: GOOGLE_COOKIE_PATH, maxAge: FLOW_TTL_MS,
  });
  res.set('Cache-Control', 'no-store');
  res.redirect(googleAuthUrl({ clientId: creds.clientId, state: flow.state, nonce: flow.nonce, challenge: flow.challenge }));
}));

r.get('/google/callback', googleLimiter, ah(async (req, res) => {
  const flow = openFlow(req.cookies?.[GOOGLE_COOKIE]);
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (!flow || !state || !safeEqual(state, flow.s)) return googleFail(res, 'state');
  if (req.query.error) return googleFail(res, req.query.error === 'access_denied' ? 'cancelled' : 'denied');
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code || code.length > 2048) return googleFail(res, 'failed');
  const creds = await googleCredentials();
  if (!creds) return googleFail(res, 'not_configured');

  let claims;
  try {
    const idToken = await exchangeGoogleCode({ ...creds, code, verifier: flow.v });
    claims = await verifyGoogleIdToken(idToken, { clientId: creds.clientId, nonce: flow.n });
  } catch (err) {
    const reason = err instanceof GoogleSignInError ? err.code : 'failed';
    if (!(err instanceof GoogleSignInError)) console.error('[auth] google sign-in failed', err);
    await audit(req, 'auth.login_failed', { details: { method: 'google', reason } });
    return googleFail(res, reason);
  }

  try {
    const email = claims.email.trim().toLowerCase();
    let user = await prisma.user.findUnique({ where: { googleSub: claims.sub } });
    let created = false;
    if (!user) {
      const match = await userByEmail(email);
      if (match) {
        if (match.status !== 'active') return googleFail(res, 'suspended');
        if (match.googleSub && match.googleSub !== claims.sub) return googleFail(res, 'linked_other');
        user = await linkGoogle(req, match, claims.sub);
      } else {
        if (!(await getBool('app.registrationOpen'))) return googleFail(res, 'closed');
        // Same defaults as /register (dispatcher role; plan and trial come from the default plan). The terms are
        // accepted by the consent line under the button; Google has verified the email address.
        const role = await prisma.role.findUnique({ where: { key: 'dispatcher' } });
        user = await prisma.user.create({
          data: { name: nameFromClaims(claims), email, passwordHash: unusablePasswordHash(), roleId: role.id, emailVerifiedAt: new Date(), googleSub: claims.sub },
        });
        created = true;
        await audit(req, 'auth.register', { entityType: 'user', entityId: user.id, actorId: user.id, details: { method: 'google', mode: flow.m } });
      }
    }
    if (user.status !== 'active') return googleFail(res, 'suspended');

    res.clearCookie(GOOGLE_COOKIE, { path: GOOGLE_COOKIE_PATH });
    await createSession(res, req, user.id);
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await audit(req, 'auth.login', { entityType: 'user', entityId: user.id, actorId: user.id, details: { method: 'google' } });
    const next = safeNextPath(flow.next);
    res.set('Cache-Control', 'no-store');
    res.redirect(created && next === '/app' ? '/app?welcome=1' : next);
  } catch (err) {
    console.error('[auth] google sign-in failed', err);
    return googleFail(res, 'failed');
  }
}));

/** Sign-in methods for Settings → Security. */
r.get('/google/status', requireAuth, ah(async (req, res) => {
  const row = await prisma.user.findUnique({ where: { id: req.user.id }, select: { googleSub: true, passwordHash: true } });
  res.json({ linked: !!row?.googleSub, hasPassword: hasUsablePassword(row?.passwordHash), available: await googleSignInAvailable() });
}));

/** Remove the Google link. Only with a password set, so the account can still be signed in to. */
r.post('/google/unlink', requireAuth, ah(async (req, res) => {
  refuseApiToken(req, 'change sign-in methods');
  const row = await prisma.user.findUnique({ where: { id: req.user.id }, select: { googleSub: true, passwordHash: true } });
  if (!row?.googleSub) throw badRequest('No Google account is linked');
  if (!hasUsablePassword(row.passwordHash)) throw badRequest('Set a password before unlinking Google, otherwise you could not sign in.');
  await prisma.user.update({ where: { id: req.user.id }, data: { googleSub: null } });
  invalidateUserSessions(req.user.id);
  await audit(req, 'auth.google_unlinked');
  res.json({ ok: true });
}));

export default r;
