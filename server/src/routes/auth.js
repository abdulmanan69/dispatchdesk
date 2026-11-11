import { Router } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { ah, badRequest, unauthorized, forbidden, conflict } from '../lib/errors.js';
import { parse, z, reqEmail, reqStr } from '../lib/validate.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { getBool, getSetting } from '../lib/settings.js';
import { createSession, destroySession, requireAuth, publicUser, invalidateUserSessions, mailFlags } from '../middleware/auth.js';
import { authLimiter, registerLimiter, mailLimiter } from '../middleware/security.js';
import { hashPassword, verifyPassword } from '../middleware/passwordHash.js';
import { sendSystemMail } from '../services/email/system.js';

const r = Router();

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

export default r;
