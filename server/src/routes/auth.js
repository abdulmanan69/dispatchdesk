import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { ah, badRequest, unauthorized, forbidden, conflict } from '../lib/errors.js';
import { parse, z, reqEmail, reqStr } from '../lib/validate.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { getBool, getSetting } from '../lib/settings.js';
import { createSession, destroySession, requireAuth, publicUser } from '../middleware/auth.js';
import { authLimiter } from '../middleware/security.js';
import { sendSystemMail, systemMailConfigured } from '../services/email/system.js';

const r = Router();
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

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
  return { ...publicUser(user, user.role.permissions.map((p) => p.permission.key)), mailConfigured: await systemMailConfigured() };
}

r.get('/csrf', (req, res) => res.json({ ok: true }));

r.get('/me', ah(async (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: { ...publicUser(req.user, req.permissions), mailConfigured: await systemMailConfigured() } });
}));

r.post('/register', authLimiter, ah(async (req, res) => {
  if (!(await getBool('app.registrationOpen'))) throw forbidden('Registration is currently closed');
  const body = parse(z.object({
    name: reqStr(120), email: reqEmail, password, phone: z.string().trim().max(40).optional(),
    acceptTerms: z.literal(true, { message: 'You must accept the terms' }),
  }), req.body);
  if (await prisma.user.findUnique({ where: { email: body.email } })) throw conflict('An account with this email already exists');
  const role = await prisma.role.findUnique({ where: { key: 'dispatcher' } });
  const user = await prisma.user.create({
    data: { name: body.name, email: body.email, phone: body.phone || null, passwordHash: await bcrypt.hash(body.password, 12), roleId: role.id },
  });
  const { token, mail } = await sendVerification(user);
  await createSession(res, req, user.id);
  await audit(req, 'auth.register', { entityType: 'user', entityId: user.id, actorId: user.id });
  res.status(201).json({ user: await meResponse(user.id), verificationEmailSent: mail.sent, ...devToken(token) });
}));

r.post('/login', authLimiter, ah(async (req, res) => {
  const body = parse(z.object({ email: reqEmail, password: z.string().min(1).max(200) }), req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  // Compare against a dummy hash when the user doesn't exist to keep timing uniform.
  const ok = await bcrypt.compare(body.password, user?.passwordHash || DUMMY_HASH);
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
  await audit(req, 'auth.email_verified', { entityType: 'user', entityId: row.userId, actorId: row.userId });
  res.json({ ok: true });
}));

r.post('/resend-verification', requireAuth, authLimiter, ah(async (req, res) => {
  if (req.user.emailVerifiedAt) return res.json({ ok: true, alreadyVerified: true });
  const { token, mail } = await sendVerification(req.user);
  res.json({ ok: true, emailSent: mail.sent, reason: mail.reason, ...devToken(token) });
}));

r.post('/forgot-password', authLimiter, ah(async (req, res) => {
  const { email } = parse(z.object({ email: reqEmail }), req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  let extra = {};
  if (user && user.status === 'active') {
    const token = await issueToken(user.id, 'reset_password', 3600 * 1000);
    const link = `${config.appUrl}/reset-password?token=${token}`;
    await sendSystemMail({
      to: user.email, subject: 'Reset your password',
      text: `Hi ${user.name},\n\nReset your password with this link (valid for 1 hour):\n${link}\n\nIf you did not request this, ignore this email.`,
    });
    await audit(req, 'auth.password_reset_requested', { entityType: 'user', entityId: user.id, actorId: user.id });
    extra = devToken(token);
  }
  // Same response whether or not the account exists (prevents account enumeration).
  res.json({ ok: true, message: 'If an account exists for that email, a reset link has been sent.', ...extra });
}));

r.post('/reset-password', authLimiter, ah(async (req, res) => {
  const body = parse(z.object({ token: reqStr(200), password }), req.body);
  const row = await consumeToken(body.token, 'reset_password');
  await prisma.user.update({ where: { id: row.userId }, data: { passwordHash: await bcrypt.hash(body.password, 12) } });
  await prisma.session.deleteMany({ where: { userId: row.userId } });
  await audit(req, 'auth.password_reset', { entityType: 'user', entityId: row.userId, actorId: row.userId });
  res.json({ ok: true });
}));

r.post('/change-password', requireAuth, ah(async (req, res) => {
  const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), req.body);
  if (!(await bcrypt.compare(body.currentPassword, req.user.passwordHash))) throw badRequest('Current password is incorrect');
  await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash: await bcrypt.hash(body.newPassword, 12) } });
  await prisma.session.deleteMany({ where: { userId: req.user.id, NOT: { id: req.sessionId } } });
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
  await audit(req, 'auth.session_revoked');
  res.json({ revoked: result.count });
}));

r.post('/sessions/revoke-others', requireAuth, ah(async (req, res) => {
  const result = await prisma.session.deleteMany({ where: { userId: req.user.id, NOT: { id: req.sessionId } } });
  await audit(req, 'auth.sessions_revoked');
  res.json({ revoked: result.count });
}));

export default r;
