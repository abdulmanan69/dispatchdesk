import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { prisma } from '../db.js';
import { ah, badRequest, forbidden, notFound, conflict } from '../lib/errors.js';
import { parse, z, pageQuery, paginate, pageResult, optStr, optInt, clean } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { requirePermission, invalidateUserSessions } from '../middleware/auth.js';
import { hashPassword } from '../middleware/passwordHash.js';
import { invalidatePlans } from '../lib/plans.js';
import { LockBusyError } from '../lib/locks.js';
import { SETTING_DEFS, listSettingsForAdmin, setSetting, getSetting, getSettings } from '../lib/settings.js';
import { checkOAuthClient, OAUTH_PROVIDERS, redirectUri } from '../services/email/oauth.js';
import { getStripe } from '../services/stripe.js';
import { paddleApi, paddleConfig, billingProvider } from '../services/paddle.js';
import { polarApi, polarConfig } from '../services/polar.js';
import { approveManualPayment, rejectManualPayment, shapeClaim } from '../services/billing/manual.js';
import { grantPlan, planPhrase } from '../services/billing/grant.js';
import { trialSettings, trialState } from '../services/billing/trial.js';
import { COUPON_KINDS, DISCOUNT_DURATIONS, CODE_RE, normCode, createStripeDiscount, setStripeDiscountActive, stripeRedemptions, findCoupon } from '../services/billing/coupons.js';
import { notify } from '../lib/activity.js';
import { sendSystemMail } from '../services/email/system.js';
import { assertAccountDeletable, deleteAccount } from './settings.js';
import { invalidateLoadTrack } from '../services/fleet/loadShare.js';
import { testPlatformAi } from '../services/ai/llm.js';
import { config } from '../config.js';
import { escHtml, verifyEmailMessage, resetPasswordMessage, inviteMessage, carrierCodeMessage, adminMessage } from '../services/email/platformTemplate.js';
import { digestLayout } from '../services/email/digest.js';

const r = Router();
r.use(requirePermission('admin.access'));

const DAY = 86400000;
const ADMIN_ROLES = ['admin', 'super_admin'];
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
const monthKey = (d) => new Date(d).toISOString().slice(0, 7);

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
/**
 * Trial funnel for the overview: accounts on the free trial, trials ending within 7 days, trials that ended without a
 * plan (read-only now), paying and gifted subscriptions. Admin accounts are never on a trial.
 */
/** Why people canceled in the last 90 days, from the optional reason on POST /api/billing/cancel. */
async function cancelReasons() {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'billing.cancel_requested', createdAt: { gte: new Date(Date.now() - 90 * DAY) } },
    select: { details: true }, take: 5000,
  });
  const counts = new Map();
  for (const r of rows) {
    let reason = null;
    try { reason = JSON.parse(r.details || '{}').reason || null; } catch { /* old rows */ }
    const key = reason || 'none';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

async function billingFunnel(activeSubs, paidSubs, roles) {
  const t = await trialSettings();
  const out = { paying: paidSubs.length, gifted: activeSubs.length - paidSubs.length, trialDays: t.days, onTrial: 0, endingSoon: 0, ended: 0, cancelReasons: await cancelReasons() };
  if (!t.days) return out;
  const withPlan = new Set(activeSubs.map((s) => s.userId));
  const adminRoleIds = new Set();
  for (const r of await prisma.role.findMany({ include: { permissions: { include: { permission: true } } } })) {
    if (r.permissions.some((p) => p.permission.key === 'admin.access')) adminRoleIds.add(r.id);
  }
  const users = await prisma.user.findMany({ where: { status: 'active' }, select: { id: true, createdAt: true, roleId: true }, take: 100_000 });
  const now = new Date();
  for (const u of users) {
    if (withPlan.has(u.id) || adminRoleIds.has(u.roleId)) continue;
    const s = trialState(u, t.days, now);
    if (s.active) { out.onTrial += 1; if (s.daysLeft <= 7) out.endingSoon += 1; } else if (s.locked) out.ended += 1;
  }
  return out;
}

r.get('/stats', ah(async (req, res) => {
  const now = Date.now();
  const since30 = new Date(now - 30 * DAY);
  const since12m = new Date(new Date().getFullYear() - 1, new Date().getMonth() + 1, 1);
  const [
    usersTotal, usersActive, usersSuspended, newUsers, roleGroups, subsGroups, plans, activeSubs, payments,
    carriersTotal, carriers30, teamsTotal, openReports, newTrainingRequests, listings, posts,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { lastLoginAt: { gte: since30 } } }),
    prisma.user.count({ where: { status: 'suspended' } }),
    prisma.user.findMany({ where: { createdAt: { gte: since30 } }, select: { createdAt: true } }),
    prisma.user.groupBy({ by: ['roleId'], _count: { _all: true } }),
    prisma.subscription.groupBy({ by: ['planId', 'status'], _count: { _all: true } }),
    prisma.plan.findMany(),
    prisma.subscription.findMany({ where: { status: 'active' }, include: { plan: true } }),
    prisma.payment.findMany({ where: { status: 'paid', paidAt: { gte: since12m } }, select: { amountCents: true, paidAt: true } }),
    prisma.carrier.count(),
    prisma.carrier.count({ where: { createdAt: { gte: since30 } } }),
    prisma.team.count(),
    prisma.contentReport.count({ where: { status: 'open' } }),
    prisma.trainingRequest.count({ where: { status: 'new' } }),
    prisma.marketplaceListing.count({ where: { status: 'active' } }),
    prisma.communityPost.count({ where: { status: 'published' } }),
  ]);
  const roles = await prisma.role.findMany();
  const planById = Object.fromEntries(plans.map((p) => [p.id, p]));

  const regKeys = [];
  for (let i = 29; i >= 0; i--) regKeys.push(dayKey(now - i * DAY));
  const reg = Object.fromEntries(regKeys.map((k) => [k, 0]));
  newUsers.forEach((u) => { const k = dayKey(u.createdAt); if (k in reg) reg[k] += 1; });

  const months = [];
  for (let i = 11; i >= 0; i--) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); months.push(monthKey(d)); }
  const rev = Object.fromEntries(months.map((k) => [k, 0]));
  payments.forEach((p) => { const k = monthKey(p.paidAt); if (k in rev) rev[k] += p.amountCents; });

  // Paying = sold through a provider (Stripe or Paddle); gifted = granted by an admin or a code (no revenue).
  const paidSubs = activeSubs.filter((sub) => sub.stripeSubscriptionId);
  const mrrCents = paidSubs.reduce((s, sub) => {
    const monthly = sub.plan.interval === 'year' ? sub.plan.priceCents / 12 : sub.plan.priceCents;
    return s + monthly * (sub.plan.perSeat ? sub.seats : 1) + (sub.plan.basePriceCents || 0);
  }, 0);

  res.json({
    users: { total: usersTotal, active30d: usersActive, suspended: usersSuspended, new30d: newUsers.length },
    usersByRole: roleGroups.map((g) => ({ role: roles.find((x) => x.id === g.roleId)?.name, count: g._count._all })),
    registrations: regKeys.map((k) => ({ date: k, count: reg[k] })),
    subscriptions: subsGroups.map((g) => ({ plan: planById[g.planId]?.name, status: g.status, count: g._count._all })),
    activeSubscriptions: activeSubs.length,
    mrrCents: Math.round(mrrCents),
    billing: await billingFunnel(activeSubs, paidSubs, roles),
    revenueByMonth: months.map((k) => ({ month: k, cents: rev[k] })),
    revenue12mCents: payments.reduce((s, p) => s + p.amountCents, 0),
    carriers: { total: carriersTotal, new30d: carriers30 },
    teams: teamsTotal,
    openReports,
    newTrainingRequests,
    marketplaceListings: listings,
    communityPosts: posts,
  });
}));

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
r.get('/roles', requirePermission('admin.users'), ah(async (req, res) => {
  const roles = await prisma.role.findMany({ orderBy: { rank: 'desc' }, include: { permissions: { include: { permission: true } } } });
  res.json({ roles: roles.map((x) => ({ key: x.key, name: x.name, description: x.description, permissions: x.permissions.map((p) => p.permission.key) })) });
}));

r.get('/users', requirePermission('admin.users'), ah(async (req, res) => {
  const q = parse(z.object({ ...pageQuery, q: z.string().max(100).optional(), role: z.string().max(30).optional(), status: z.enum(['active', 'suspended']).optional() }), req.query);
  const where = {};
  if (q.q) where.OR = [{ name: { contains: q.q } }, { email: { contains: q.q.toLowerCase() } }];
  if (q.role) where.role = { key: q.role };
  if (q.status) where.status = q.status;
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where, orderBy: { createdAt: 'desc' }, ...paginate(q),
      include: { role: true, teamMembership: { include: { team: { select: { name: true } } } }, _count: { select: { carriers: true } } },
    }),
    prisma.user.count({ where }),
  ]);
  res.json(pageResult(rows.map((u) => ({
    id: u.id, name: u.name, email: u.email, role: u.role.key, roleName: u.role.name, status: u.status, emailVerified: !!u.emailVerifiedAt,
    team: u.teamMembership?.team?.name ?? null, carriers: u._count.carriers, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
  })), total, q));
}));

r.patch('/users/:id', requirePermission('admin.users'), ah(async (req, res) => {
  const body = parse(z.object({ role: z.string().max(30).optional(), status: z.enum(['active', 'suspended']).optional(), emailVerified: z.boolean().optional() }), req.body);
  const target = await prisma.user.findUnique({ where: { id: String(req.params.id) }, include: { role: true } });
  if (!target) throw notFound('User not found');
  if (target.id === req.user.id && (body.role || body.status)) throw forbidden('You cannot change your own role or status');
  const touchesAdmin = ADMIN_ROLES.includes(target.role.key) || (body.role && ADMIN_ROLES.includes(body.role));
  if (touchesAdmin && !req.permissions.has('admin.roles')) throw forbidden('Only a super admin can change administrator accounts');
  const data = {};
  if (body.role) {
    const role = await prisma.role.findUnique({ where: { key: body.role } });
    if (!role) throw badRequest('Unknown role');
    data.roleId = role.id;
  }
  if (body.status) data.status = body.status;
  if (body.emailVerified !== undefined) data.emailVerifiedAt = body.emailVerified ? (target.emailVerifiedAt || new Date()) : null;
  const user = await prisma.user.update({ where: { id: target.id }, data, include: { role: true } });
  invalidateUserSessions(target.id);
  if (body.status === 'suspended') {
    await prisma.session.deleteMany({ where: { userId: target.id } });
    // Public tracking pages are cached for a minute per process; drop them so the account's links stop at once.
    invalidateLoadTrack();
  }
  await audit(req, 'admin.user_updated', { entityType: 'user', entityId: target.id, details: body });
  res.json({ user: { id: user.id, role: user.role.key, status: user.status, emailVerified: !!user.emailVerifiedAt } });
}));

/**
 * Set a one-time temporary password (for users who cannot reset by email, e.g. platform email is not configured).
 * The password is returned once to the admin, never stored in plain text, and every session of that user is signed out.
 */
r.post('/users/:id/temp-password', requirePermission('admin.users'), ah(async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: String(req.params.id) }, include: { role: true } });
  if (!target) throw notFound('User not found');
  if (ADMIN_ROLES.includes(target.role.key) && target.id !== req.user.id && !req.permissions.has('admin.roles')) throw forbidden('Only a super admin can reset administrator accounts');
  const password = `Tmp-${randomBytes(9).toString('base64url')}7`;
  await prisma.user.update({ where: { id: target.id }, data: { passwordHash: await hashPassword(password) } });
  await prisma.session.deleteMany({ where: { userId: target.id } });
  invalidateUserSessions(target.id);
  await audit(req, 'admin.user_temp_password', { entityType: 'user', entityId: target.id });
  res.json({ password, note: 'Share this once with the user. Ask them to change it in Settings → Security after signing in.' });
}));

r.delete('/users/:id', requirePermission('admin.users'), ah(async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: String(req.params.id) }, include: { role: true, teamMembership: true } });
  if (!target) throw notFound('User not found');
  if (target.id === req.user.id) throw forbidden('Use Settings → Data to delete your own account');
  if (ADMIN_ROLES.includes(target.role.key) && !req.permissions.has('admin.roles')) throw forbidden('Only a super admin can delete administrator accounts');
  // Every check runs before anything is deleted. Only Stripe subscriptions block; admin-granted plans end with the account.
  await assertAccountDeletable(target, { self: false });
  try {
    await deleteAccount(target);
  } catch (err) {
    if (err instanceof LockBusyError) throw conflict('This account is already being deleted.');
    throw err;
  }
  await audit(req, 'admin.user_deleted', { entityType: 'user', entityId: target.id, details: { email: target.email } });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Subscriptions & plans
// ---------------------------------------------------------------------------
r.get('/subscriptions', requirePermission('admin.billing'), ah(async (req, res) => {
  const q = parse(z.object({ ...pageQuery, status: z.string().max(20).optional(), plan: z.string().max(20).optional() }), req.query);
  const where = {};
  if (q.status) where.status = q.status;
  if (q.plan) where.plan = { key: q.plan };
  const [rows, total] = await Promise.all([
    prisma.subscription.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q), include: { plan: true, user: { select: { id: true, name: true, email: true } }, team: { select: { name: true } } } }),
    prisma.subscription.count({ where }),
  ]);
  res.json(pageResult(rows.map((s) => ({
    id: s.id, status: s.status, plan: s.plan.name, planKey: s.plan.key, seats: s.seats, user: s.user, team: s.team?.name ?? null,
    stripeSubscriptionId: s.stripeSubscriptionId, granted: !s.stripeSubscriptionId && !s.stripeCheckoutId, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, createdAt: s.createdAt,
  })), total, q));
}));

/**
 * Grant a plan without payment (comp, trial, partner, or before Stripe is set up).
 * Stored as a subscription with no Stripe IDs; it ends at `currentPeriodEnd` (null = no end) or when revoked.
 */
r.post('/subscriptions/grant', requirePermission('admin.billing'), ah(async (req, res) => {
  const body = parse(z.object({
    userId: z.string().min(1).max(40),
    planKey: z.string().min(1).max(30),
    months: z.coerce.number().int().min(1).max(120).nullable().optional(),
    seats: z.coerce.number().int().min(1).max(1000).optional(),
  }), req.body);
  const [user, plan] = await Promise.all([
    prisma.user.findUnique({ where: { id: body.userId } }),
    prisma.plan.findUnique({ where: { key: body.planKey } }),
  ]);
  if (!user) throw notFound('User not found');
  if (!plan || plan.key === 'free') throw badRequest('Pick a paid plan to grant');
  const out = await grantPlan({ userId: user.id, plan, months: body.months ?? null, seats: body.seats || 1 });
  if (out.skipped) throw conflict('This user already pays through Stripe. Change their plan there instead.');
  const sub = out.subscription;
  const existing = !out.created;
  const { seats } = sub;
  await audit(req, 'admin.plan_granted', { entityType: 'subscription', entityId: sub.id, details: { userId: user.id, plan: plan.key, months: body.months ?? null, seats } });
  res.status(existing ? 200 : 201).json({ subscription: { id: sub.id, planKey: plan.key, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd, seats } });
}));

function giftEmailText({ name, phrase, appName, message }) {
  return [
    `Hi ${name || 'there'},`, '',
    `You got ${phrase} on ${appName}. No payment needed.`,
    ...(message ? ['', message] : []), '',
    `Open your desk: ${config.appUrl}/app`,
  ].join('\n');
}

/** Manual payments to check (Admin → Payments): reported ones first, then the rest. */
r.get('/manual-payments', requirePermission('admin.billing'), ah(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['submitted', 'awaiting', 'approved', 'rejected', 'all']).default('submitted') }), req.query);
  const rows = await prisma.manualPayment.findMany({
    where: status === 'all' ? { status: { not: 'canceled' } } : { status },
    include: { plan: true, user: { select: { id: true, name: true, email: true } } },
    orderBy: [{ submittedAt: 'desc' }, { createdAt: 'desc' }], take: 200,
  });
  const counts = Object.fromEntries((await prisma.manualPayment.groupBy({ by: ['status'], _count: { _all: true } })).map((g) => [g.status, g._count._all]));
  res.json({ items: rows.map((r) => ({ ...shapeClaim(r), user: r.user })), counts });
}));

r.post('/manual-payments/:id/approve', requirePermission('admin.billing'), ah(async (req, res) => {
  const out = await approveManualPayment(req.user.id, req.params.id);
  await audit(req, 'admin.manual_payment_approved', { entityType: 'manual_payment', entityId: req.params.id, details: { userId: out.claim.userId, plan: out.claim.plan.key, amountCents: out.claim.amountCents, endsAt: out.endsAt } });
  res.json({ ok: true, endsAt: out.endsAt });
}));

r.post('/manual-payments/:id/reject', requirePermission('admin.billing'), ah(async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
  const row = await rejectManualPayment(req.user.id, req.params.id, reason);
  await audit(req, 'admin.manual_payment_rejected', { entityType: 'manual_payment', entityId: row.id, details: { userId: row.userId, reason } });
  res.json({ ok: true });
}));

/**
 * Email selected users from the platform address (Admin → Users → select → Email). Replies go to the support email.
 * Sent one by one as 'notice' mail, so the daily platform budget keeps room for sign-in and password emails.
 */
r.post('/users/email', requirePermission('admin.users'), ah(async (req, res) => {
  const body = parse(z.object({
    userIds: z.array(z.string().min(1).max(40)).min(1).max(200),
    subject: z.string().trim().min(1).max(150),
    message: z.string().trim().min(1).max(5000),
  }), req.body);
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(body.userIds)] } }, select: { id: true, name: true, email: true, status: true } });
  const s = await getSettings(['app.name', 'app.supportEmail']);
  const appName = s['app.name'] || 'DispatchDesk';
  let sent = 0;
  const failed = [];
  for (const u of users) {
    if (u.status !== 'active') { failed.push({ userId: u.id, name: u.name, reason: 'Account is not active' }); continue; }
    const m = adminMessage({ appName, name: u.name, subject: body.subject, message: body.message, appUrl: config.appUrl, supportEmail: s['app.supportEmail'] });
    const out = await sendSystemMail({ to: u.email, subject: m.subject, text: m.text, html: m.html, category: 'notice', replyTo: s['app.supportEmail'] || undefined });
    if (out.sent) sent += 1; else failed.push({ userId: u.id, name: u.name, reason: out.reason || 'Not sent' });
  }
  await audit(req, 'admin.users_emailed', { details: { subject: body.subject, requested: body.userIds.length, sent, failed: failed.length } });
  res.json({ sent, failed });
}));

/**
 * Gift a plan to several users at once (Admin → Users → select → Gift a plan). Users who pay through Stripe are
 * skipped. With `notify`: an in-app notification (the app shows a welcome card once) and an email with the message.
 */
r.post('/subscriptions/gift', requirePermission('admin.billing'), ah(async (req, res) => {
  const body = parse(z.object({
    userIds: z.array(z.string().min(1).max(40)).min(1).max(500),
    planKey: z.string().min(1).max(30),
    months: z.coerce.number().int().min(1).max(120).nullable().optional(),
    notify: z.boolean().default(false),
    message: z.string().trim().max(500).optional(),
  }), req.body);
  const plan = await prisma.plan.findUnique({ where: { key: body.planKey } });
  if (!plan || plan.key === 'free') throw badRequest('Pick a paid plan to gift');
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(body.userIds)] } }, select: { id: true, name: true, email: true } });
  const months = body.months ?? null;
  const phrase = planPhrase(plan, months);
  const appName = (await getSetting('app.name')) || 'DispatchDesk';
  let granted = 0;
  const skipped = [];
  for (const u of users) {
    const out = await grantPlan({ userId: u.id, plan, months, extend: true });
    if (out.skipped) { skipped.push({ userId: u.id, name: u.name, reason: 'Pays online' }); continue; }
    if (out.kept) { skipped.push({ userId: u.id, name: u.name, reason: 'Already has a longer plan' }); continue; }
    granted += 1;
    if (!body.notify) continue;
    await notify(u.id, { type: 'plan_gift', title: `You got ${phrase}`, body: body.message || `A gift from ${appName}. No payment needed.`, link: `/app/billing?gift=${plan.key}` });
    sendSystemMail({ to: u.email, subject: `You got ${phrase}`, text: giftEmailText({ name: u.name, phrase, appName, message: body.message }), category: 'notice' })
      .catch((err) => console.error(`[gift] email to user ${u.id} failed: ${err.message}`));
  }
  await audit(req, 'admin.plan_gifted', { details: { plan: plan.key, months, granted, skipped: skipped.length, notify: body.notify } });
  res.json({ granted, skipped });
}));

r.post('/subscriptions/:id/revoke', requirePermission('admin.billing'), ah(async (req, res) => {
  const sub = await prisma.subscription.findUnique({ where: { id: String(req.params.id) } });
  if (!sub) throw notFound('Subscription not found');
  if (sub.stripeSubscriptionId) throw badRequest(`This plan is paid through ${sub.provider === 'paddle' ? 'Paddle' : 'Stripe'}. Cancel it there or from their billing page.`);
  await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'canceled', currentPeriodEnd: new Date() } });
  invalidatePlans();
  await audit(req, 'admin.plan_revoked', { entityType: 'subscription', entityId: sub.id });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Codes: discounts at Stripe checkout and free plan months (services/billing/coupons.js)
// ---------------------------------------------------------------------------
const planMap = async () => new Map((await prisma.plan.findMany()).map((p) => [p.key, p]));
const couponView = (c, plans, used = new Map()) => ({
  id: c.id, code: c.code, kind: c.kind, description: c.description, percentOff: c.percentOff, amountOffCents: c.amountOffCents,
  duration: c.duration, durationMonths: c.durationMonths, planKey: c.planKey, planName: plans.get(c.planKey)?.name || null,
  planMonths: c.planMonths, maxRedemptions: c.maxRedemptions, used: c.kind === 'plan' ? c.redemptions : (used.get(c.id) ?? null),
  expiresAt: c.expiresAt, active: c.active, createdAt: c.createdAt,
});

r.get('/coupons', requirePermission('admin.billing'), ah(async (req, res) => {
  const rows = await prisma.coupon.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
  const [plans, used] = await Promise.all([planMap(), stripeRedemptions(rows)]);
  res.json({ coupons: rows.map((c) => couponView(c, plans, used)) });
}));

r.post('/coupons', requirePermission('admin.billing'), ah(async (req, res) => {
  const b = parse(z.object({
    kind: z.enum(COUPON_KINDS),
    code: z.string().trim().min(3).max(40),
    description: optStr(120),
    percentOff: z.coerce.number().int().min(1).max(100).optional(),
    amountOffCents: z.coerce.number().int().min(1).max(10_000_000).optional(),
    duration: z.enum(DISCOUNT_DURATIONS).optional(),
    durationMonths: z.coerce.number().int().min(1).max(36).optional(),
    planKey: z.string().max(30).optional(),
    planMonths: z.coerce.number().int().min(1).max(120).nullable().optional(),
    maxRedemptions: z.coerce.number().int().min(1).max(1_000_000).optional(),
    expiresAt: z.coerce.date().optional(),
  }), req.body);
  const code = normCode(b.code);
  if (!CODE_RE.test(code)) throw badRequest('Use 3 to 40 letters, numbers, - or _ for the code');
  if (b.expiresAt && b.expiresAt <= new Date()) throw badRequest('The expiry date must be in the future');
  if (await prisma.coupon.findUnique({ where: { code } })) throw conflict(`The code ${code} already exists`);
  const data = { code, kind: b.kind, description: b.description || null, maxRedemptions: b.maxRedemptions ?? null, expiresAt: b.expiresAt ?? null, createdById: req.user.id };
  if (b.kind === 'discount') {
    if (!b.percentOff === !b.amountOffCents) throw badRequest('Give either a percent or a dollar amount off');
    const duration = b.duration || 'once';
    if (duration === 'repeating' && !b.durationMonths) throw badRequest('Say for how many months the discount applies');
    Object.assign(data, { percentOff: b.percentOff ?? null, amountOffCents: b.amountOffCents ?? null, duration, durationMonths: duration === 'repeating' ? b.durationMonths : null });
  } else {
    const plan = await prisma.plan.findUnique({ where: { key: b.planKey || '' } });
    if (!plan || plan.key === 'free') throw badRequest('Pick the plan this code unlocks');
    Object.assign(data, { planKey: plan.key, planMonths: b.planMonths ?? null });
  }
  // The row first (off until the provider has the code), so a failed save never leaves a live code at the provider
  // with no row here; the unique code also stops two admins creating the same one.
  let c;
  try {
    c = await prisma.coupon.create({ data: { ...data, active: data.kind !== 'discount' } });
  } catch (err) {
    if (err?.code === 'P2002') throw conflict(`The code ${code} already exists`);
    throw err;
  }
  if (c.kind === 'discount') {
    try {
      c = await prisma.coupon.update({ where: { id: c.id }, data: { ...(await createStripeDiscount(data)), active: true } });
    } catch (err) {
      await prisma.coupon.delete({ where: { id: c.id } }).catch(() => {});
      throw err;
    }
  }
  await audit(req, 'admin.coupon_created', { entityType: 'coupon', entityId: c.id, details: { code, kind: c.kind } });
  res.status(201).json({ coupon: couponView(c, await planMap()) });
}));

r.patch('/coupons/:id', requirePermission('admin.billing'), ah(async (req, res) => {
  const b = parse(z.object({ active: z.boolean() }), req.body);
  const c = await findCoupon(req.params.id);
  if (c.kind === 'discount') await setStripeDiscountActive(c, b.active);
  const row = await prisma.coupon.update({ where: { id: c.id }, data: { active: b.active } });
  await audit(req, b.active ? 'admin.coupon_enabled' : 'admin.coupon_disabled', { entityType: 'coupon', entityId: c.id });
  res.json({ coupon: couponView(row, await planMap()) });
}));

r.get('/payments', requirePermission('admin.billing'), ah(async (req, res) => {
  const q = parse(z.object({ ...pageQuery }), req.query);
  const [rows, total] = await Promise.all([
    prisma.payment.findMany({ orderBy: { createdAt: 'desc' }, ...paginate(q), include: { user: { select: { name: true, email: true } } } }),
    prisma.payment.count(),
  ]);
  res.json(pageResult(rows, total, q));
}));

r.get('/plans', requirePermission('admin.billing'), ah(async (req, res) => {
  const plans = await prisma.plan.findMany({ orderBy: { sortOrder: 'asc' }, include: { _count: { select: { subscriptions: true } } } });
  res.json({ plans, provider: await billingProvider(), polarProducts: (await polarConfig()).products });
}));

const limit = optInt(-1, 10_000_000);
r.patch('/plans/:id', requirePermission('admin.billing', 'admin.settings'), ah(async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(1).max(60).optional(), description: optStr(500),
    priceCents: optInt(0, 100_000_000), basePriceCents: optInt(0, 100_000_000), interval: z.enum(['month', 'year']).optional(),
    trialDays: optInt(0, 365), minSeats: optInt(1, 1000), stripePriceId: optStr(120),
    maxCarriers: limit, dailyEmailLimit: limit, monthlyAiMessages: limit, maxSequences: limit, maxAutomations: limit, maxDiscoveryPerDay: limit, monthlyLeadGenLimit: limit, maxLeadGenerators: limit,
    leadGenAutoRun: z.boolean().optional(), advancedReports: z.boolean().optional(), trainingIncluded: z.boolean().optional(), teamFeatures: z.boolean().optional(),
    active: z.boolean().optional(), sortOrder: optInt(0, 100),
  }), req.body);
  const plan = await prisma.plan.findUnique({ where: { id: Number(req.params.id) } });
  if (!plan) throw notFound('Plan not found');
  if (plan.key === 'free' && body.active === false) throw badRequest('The Free plan cannot be deactivated (it is the fallback plan)');
  const data = clean(body);
  for (const k of Object.keys(data)) if (data[k] === null && k !== 'description' && k !== 'stripePriceId') delete data[k];
  if (data.stripePriceId && !/^price_[A-Za-z0-9]+$/.test(data.stripePriceId)) throw badRequest('Stripe price IDs look like price_123…');
  const updated = await prisma.plan.update({ where: { id: plan.id }, data });
  invalidatePlans();
  await audit(req, 'admin.plan_updated', { entityType: 'plan', entityId: String(plan.id), details: data });
  res.json({ plan: updated, note: 'Price changes here update what the app displays. Stripe charges the amount of the linked Stripe price — create a new Stripe price and link it to change what customers pay.' });
}));

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------
r.get('/reports', requirePermission('admin.moderate'), ah(async (req, res) => {
  const q = parse(z.object({ ...pageQuery, status: z.enum(['open', 'resolved', 'dismissed', 'all']).default('open') }), req.query);
  const where = q.status === 'all' ? {} : { status: q.status };
  const [rows, total] = await Promise.all([
    prisma.contentReport.findMany({
      where, orderBy: { createdAt: 'desc' }, ...paginate(q),
      include: {
        reporter: { select: { id: true, name: true, email: true } },
        resolvedBy: { select: { name: true } },
        listing: { select: { id: true, title: true, description: true, status: true, seller: { select: { id: true, name: true } } } },
        post: { select: { id: true, title: true, body: true, status: true, author: { select: { id: true, name: true } } } },
        comment: { select: { id: true, body: true, status: true, postId: true, author: { select: { id: true, name: true } }, post: { select: { title: true } } } },
      },
    }),
    prisma.contentReport.count({ where }),
  ]);
  res.json(pageResult(rows.map((x) => {
    // A comment report also stores its post (for the link): the comment is the reported content, so check it first.
    const isComment = !!x.commentId;
    const kind = isComment ? (x.comment ? 'comment' : 'deleted') : x.listing ? 'listing' : x.post ? 'post' : 'deleted';
    const t = isComment ? x.comment : x.listing || x.post;
    return {
      id: x.id, reason: x.reason, details: x.details, status: x.status, createdAt: x.createdAt, resolvedAt: x.resolvedAt, resolvedBy: x.resolvedBy?.name,
      reporter: x.reporter, kind,
      target: t ? {
        id: t.id, status: t.status, title: isComment ? null : x.listing?.title || x.post?.title || null,
        context: isComment && x.comment.post?.title ? `Comment on "${x.comment.post.title}"` : null,
        excerpt: String(isComment ? x.comment.body : x.listing?.description || x.post?.body || '').slice(0, 280),
        author: (isComment ? x.comment.author : x.listing?.seller || x.post?.author) ?? null,
        link: isComment ? `/community/${x.comment.postId}#c-${x.comment.id}` : x.listing ? `/marketplace/${t.id}` : `/community/${t.id}`,
      } : null,
    };
  }), total, q));
}));

r.post('/reports/:id/resolve', requirePermission('admin.moderate'), ah(async (req, res) => {
  const { action } = parse(z.object({ action: z.enum(['dismiss', 'hide_content', 'remove_content', 'restore_content']) }), req.body);
  const report = await prisma.contentReport.findUnique({ where: { id: String(req.params.id) } });
  if (!report) throw notFound('Report not found');
  if (action !== 'dismiss') {
    const status = action === 'hide_content' ? 'hidden' : action === 'remove_content' ? 'removed' : null;
    const s = (published) => status ?? published;
    // Comment reports also carry the post id: act on the comment only, never on the whole post.
    if (report.commentId) await prisma.communityComment.update({ where: { id: report.commentId }, data: { status: s('published') } });
    else if (report.listingId) await prisma.marketplaceListing.update({ where: { id: report.listingId }, data: { status: s('active') } });
    else if (report.postId) await prisma.communityPost.update({ where: { id: report.postId }, data: { status: s('published') } });
    // Close every other open report on the same content (for a post: post reports only, not reports on its comments).
    const same = report.commentId ? { commentId: report.commentId } : report.listingId ? { listingId: report.listingId } : { postId: report.postId, commentId: null };
    if (action !== 'restore_content') await prisma.contentReport.updateMany({ where: { ...same, status: 'open' }, data: { status: 'resolved', resolvedById: req.user.id, resolvedAt: new Date() } });
  }
  const updated = await prisma.contentReport.update({
    where: { id: report.id },
    data: { status: action === 'dismiss' ? 'dismissed' : 'resolved', resolvedById: req.user.id, resolvedAt: new Date() },
  });
  await audit(req, 'admin.report_resolved', { entityType: 'report', entityId: report.id, details: { action } });
  res.json({ report: updated });
}));

// ---------------------------------------------------------------------------
// System settings & integration tests
// ---------------------------------------------------------------------------
r.get('/settings', requirePermission('admin.settings'), ah(async (req, res) => {
  res.json({
    settings: await listSettingsForAdmin(), appUrl: config.appUrl, webhookUrl: `${config.appUrl}/api/billing/webhook`,
    oauth: {
      gmail: { redirectUri: redirectUri('gmail'), scopes: OAUTH_PROVIDERS.gmail.scope.split(' ') },
      outlook: { redirectUri: redirectUri('outlook'), scopes: OAUTH_PROVIDERS.outlook.scope.split(' ') },
    },
  });
}));

r.put('/settings', requirePermission('admin.settings'), ah(async (req, res) => {
  const body = parse(z.object({ values: z.record(z.string(), z.union([z.string().max(4000), z.boolean(), z.number()])).default({}), clear: z.array(z.string()).default([]) }), req.body);
  // Validate every value first, so one bad field never leaves a group half saved.
  const writes = [];
  for (const [key, raw] of Object.entries(body.values)) {
    const def = SETTING_DEFS[key];
    if (!def) throw badRequest(`Unknown setting ${key}`);
    const value = typeof raw === 'string' ? raw.trim() : String(raw);
    if (def.secret && value === '') continue; // blank secret field = keep existing value
    if (def.type === 'bool' && !['true', 'false'].includes(value)) throw badRequest(`${key} must be true or false`);
    if (key === 'smtp.port' && !/^\d{1,5}$/.test(value)) throw badRequest('SMTP port must be a number');
    // Empty = use PLATFORM_MAIL_DAILY_LIMIT or 300 (services/email/system.js).
    if (key === 'smtp.dailyLimit' && value && !/^[1-9]\d{0,6}$/.test(value)) throw badRequest('Platform emails per day must be a whole number of at least 1');
    if ((key === 'ai.baseUrl') && value && !/^https?:\/\//.test(value)) throw badRequest('AI base URL must start with http(s)://');
    if (key === 'search.provider' && !['', 'tavily', 'brave'].includes(value)) throw badRequest('Search provider must be tavily, brave or empty');
    if (key === 'ai.provider' && !['', 'openai', 'anthropic'].includes(value)) throw badRequest('AI provider must be openai or anthropic');
    if (key === 'app.supportEmail' && value && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value)) throw badRequest('Support email must be a valid email address');
    if (key === 'billing.provider' && !['', 'stripe', 'paddle'].includes(value)) throw badRequest('Billing provider must be stripe or paddle');
    if (key === 'paddle.environment' && !['', 'live', 'sandbox'].includes(value)) throw badRequest('Paddle environment must be live or sandbox');
    if (key === 'paddle.clientToken' && value && !/^(live|test)_[A-Za-z0-9]{8,}$/.test(value)) throw badRequest('The Paddle client-side token starts with live_ or test_');
    if (key === 'paddle.apiKey' && value && !/^pdl_(live|sdbx)_apikey_[A-Za-z0-9_]{10,}$/.test(value) && !/^[A-Za-z0-9_]{20,}$/.test(value)) throw badRequest('That does not look like a Paddle API key (pdl_live_apikey_…)');
    if (key === 'app.legalName' && value.length > 120) throw badRequest('Keep the legal name under 120 characters');
    if (key === 'app.trialDays' && value && !(/^\d{1,3}$/.test(value) && Number(value) <= 365)) throw badRequest('Free trial days must be a whole number from 0 to 365');
    if (key === 'app.trialPlan' && value && !(await prisma.plan.findUnique({ where: { key: value } }))) throw badRequest(`There is no plan with the key ${value}`);
    if (key === 'announcement.tone' && !['', 'info', 'success', 'warning'].includes(value)) throw badRequest('Announcement color must be info, success or warning');
    if (key === 'announcement.audience' && !['', 'everyone', 'app', 'public'].includes(value)) throw badRequest('Show the announcement to everyone, app or public');
    if (key === 'announcement.text' && value.length > 300) throw badRequest('Keep the announcement under 300 characters');
    if (key === 'announcement.linkLabel' && value.length > 40) throw badRequest('Keep the link text under 40 characters');
    if (key === 'announcement.linkUrl' && value && !/^(\/(?!\/)\S*|https:\/\/\S+)$/.test(value)) throw badRequest('The announcement link must be a page in the app (starting with /) or an https:// address');
    writes.push([key, value]);
  }
  for (const key of body.clear) {
    if (!SETTING_DEFS[key]) throw badRequest(`Unknown setting ${key}`);
    writes.push([key, '']);
  }
  const changed = [];
  for (const [key, value] of writes) {
    await setSetting(key, value, req.user.id);
    changed.push(key);
  }
  await audit(req, 'admin.settings_updated', { details: { keys: changed } }); // values are never logged
  res.json({ settings: await listSettingsForAdmin(), changed });
}));

const timeout = (ms = 10000) => AbortSignal.timeout(ms);

const TESTS = {
  google: () => checkOAuthClient('gmail'),
  microsoft: () => checkOAuthClient('outlook'),
  async smtp() {
    const s = await getSettings(['smtp.host', 'smtp.port', 'smtp.secure', 'smtp.user', 'smtp.pass', 'smtp.from', 'brevo.apiKey']);
    if (s['brevo.apiKey']) {
      const res = await fetch('https://api.brevo.com/v3/account', { headers: { 'api-key': s['brevo.apiKey'], accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, message: `Brevo refused the API key: ${body.message || res.status}` };
      return { ok: true, message: `Brevo API key works${body.companyName ? ` (${body.companyName})` : ''}${s['smtp.from'] ? '' : ' — note: "From" address is not set'}` };
    }
    if (!s['smtp.host']) return { ok: false, message: 'SMTP host is not set' };
    const t = nodemailer.createTransport({ host: s['smtp.host'], port: Number(s['smtp.port'] || 587), secure: s['smtp.secure'] === 'true', auth: s['smtp.user'] ? { user: s['smtp.user'], pass: s['smtp.pass'] } : undefined, connectionTimeout: 10000 });
    await t.verify();
    return { ok: true, message: `Connected and authenticated to ${s['smtp.host']}${s['smtp.from'] ? '' : ' — note: "From" address is not set'}` };
  },
  // One tiny real call through the platform provider (OpenAI-compatible or Claude), as users' calls would make.
  ai: () => testPlatformAi(),
  async stripe() {
    const stripe = await getStripe();
    if (!stripe) return { ok: false, message: 'Stripe secret key is not set' };
    const bal = await stripe.balance.retrieve();
    const wh = (await getSettings(['stripe.webhookSecret']))['stripe.webhookSecret'];
    return { ok: true, message: `Connected (${bal.livemode ? 'live' : 'test'} mode).${wh ? '' : ' Webhook secret is NOT set — subscriptions will not activate until it is.'}` };
  },
  async paddle() {
    const c = await paddleConfig();
    if (!c.apiKey) return { ok: false, message: 'Paddle API key is not set' };
    await paddleApi('GET', '/event-types');
    const missing = [!c.clientToken && 'client-side token', !c.webhookSecret && 'webhook secret (press Set up Paddle in Admin → Setup)'].filter(Boolean);
    const tokenEnv = c.clientToken.startsWith('test_') ? 'sandbox' : c.clientToken.startsWith('live_') ? 'live' : null;
    const clash = tokenEnv && tokenEnv !== c.environment ? ` The client-side token is a ${tokenEnv} token but the environment is ${c.environment}.` : '';
    return { ok: !clash, message: `Connected to Paddle (${c.environment}).${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}${clash}` };
  },
  async polar() {
    const c = await polarConfig();
    if (!c.accessToken) return { ok: false, message: 'Polar access token is not set' };
    await polarApi('GET', '/products/?limit=1');
    const missing = !c.webhookSecret ? ' Missing: webhook secret (press Set up Polar in Admin → Setup).' : '';
    return { ok: true, message: `Connected to Polar (${c.environment}).${missing}` };
  },
  async search() {
    const s = await getSettings(['search.provider', 'search.apiKey']);
    if (!s['search.provider'] || !s['search.apiKey']) return { ok: false, message: 'Search provider or API key is not set' };
    if (s['search.provider'] === 'tavily') {
      const res = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s['search.apiKey']}` }, body: JSON.stringify({ query: 'FMCSA motor carrier authority', max_results: 1 }), signal: timeout() });
      return res.ok ? { ok: true, message: 'Tavily search responded successfully' } : { ok: false, message: `Tavily responded ${res.status}` };
    }
    const res = await fetch('https://api.search.brave.com/res/v1/web/search?q=FMCSA&count=1', { headers: { 'X-Subscription-Token': s['search.apiKey'], Accept: 'application/json' }, signal: timeout() });
    return res.ok ? { ok: true, message: 'Brave Search responded successfully' } : { ok: false, message: `Brave Search responded ${res.status}` };
  },
  async fmcsa() {
    const s = await getSettings(['fmcsa.webKey', 'fmcsa.socrataAppToken']);
    const headers = s['fmcsa.socrataAppToken'] ? { 'X-App-Token': s['fmcsa.socrataAppToken'] } : {};
    const census = await fetch(`${config.fmcsa.censusUrl}?$limit=1`, { headers, signal: timeout() });
    const parts = [census.ok ? 'FMCSA Census dataset reachable' : `FMCSA Census responded ${census.status}`];
    const lic = await fetch('https://data.transportation.gov/resource/6eyk-hxee.json?$limit=1', { headers, signal: timeout() }).catch(() => null);
    parts.push(lic?.ok ? 'FMCSA licensing dataset reachable (broker authority and bond, no key needed)' : `FMCSA licensing dataset responded ${lic ? lic.status : 'with no answer'}`);
    const ok = census.ok && !!lic?.ok;
    if (s['fmcsa.webKey']) {
      const qc = await fetch(`https://mobile.fmcsa.dot.gov/qc/services/carriers/1?webKey=${encodeURIComponent(s['fmcsa.webKey'])}`, { signal: timeout() }).catch(() => null);
      // QCMobile blocks requests from outside the US; authority and bond then come from the licensing dataset.
      parts.push(qc?.ok ? 'QCMobile webKey accepted' : qc?.status === 403 ? 'QCMobile refused this server (403: it only answers US addresses). Not needed: the licensing dataset covers authority and bond' : `QCMobile responded ${qc ? qc.status : 'with no answer'} (optional)`);
    } else parts.push('QCMobile webKey not set (optional)');
    return { ok, message: parts.join('. ') };
  },
};

r.post('/settings/test/:service', requirePermission('admin.settings'), ah(async (req, res) => {
  const fn = TESTS[req.params.service];
  if (!fn) throw notFound('Unknown integration');
  let result;
  try {
    result = await fn();
  } catch (err) {
    result = { ok: false, message: err?.name === 'TimeoutError' ? 'Timed out after 10 seconds' : err.message };
  }
  await audit(req, 'admin.integration_tested', { details: { service: req.params.service, ok: result.ok } });
  res.json({ service: req.params.service, testedAt: new Date(), ...result });
}));

// ---------------------------------------------------------------------------
// Platform email previews: exactly what DispatchDesk itself sends, with sample data. Nothing is sent.
// GET /email-previews (all of them, side by side with the plain-text part) and GET /email-previews/:kind (one, as HTML).
// ---------------------------------------------------------------------------
async function previewSamples() {
  const appName = await getSetting('app.name');
  const url = (p) => `${config.appUrl}${p}`;
  const sample = 'sample-token-not-valid';
  const first = { first: 'Tina', queueUrl: url('/app/prospecting'), settingsUrl: url('/app/settings?tab=notifications') };
  const digest = digestLayout({
    ...first,
    list: [
      { title: 'Overdue follow-ups (1)', count: 1, lines: ['Blue Line Trucking: call, was due Tue 10:00 AM. Call back about reefer lanes'] },
      { title: 'Follow-ups due today (2)', count: 2, lines: ['Cedar Creek Carriers: email at 11:30 AM', 'Lone Star Haulers: call at 2:00 PM'] },
      { title: 'Sequence steps due today (1)', count: 1, lines: ['Prairie Wind Freight: call, step 2 of "New authority outreach"'] },
    ],
  });
  return {
    verify: { label: 'Verify email', when: 'A dispatcher signs up or asks for a new link', ...verifyEmailMessage({ appName, name: 'Tina Ramirez', email: 'tina@bluelinedispatch.com', link: url(`/verify-email?token=${sample}`) }) },
    reset: { label: 'Password reset', when: 'Someone uses "Forgot password"', ...resetPasswordMessage({ appName, name: 'Tina Ramirez', link: url(`/reset-password?token=${sample}`) }) },
    invite: { label: 'Team invitation', when: 'A team owner invites a dispatcher', ...inviteMessage({ appName, inviter: 'Tina Ramirez', team: 'Blue Line Dispatch', role: 'member', link: url(`/invite/${sample}`) }) },
    carrier_code: { label: 'Carrier sign-in code', when: 'A trucker signs in at /carrier (sent to the FMCSA email of the USDOT number)', ...carrierCodeMessage({ appName, code: '482913', name: "DEAN'S LOGISTICS LLC", dot: '3636864', signInUrl: url('/carrier') }) },
    digest: { label: 'Daily digest', when: '7 AM in the dispatcher\'s time zone when something is due (sent from their own mailbox when one is connected)', subject: 'Your day: 2 follow-ups due today, 1 overdue, 1 sequence step', text: '(The plain-text part lists the same items.)', html: digest.html },
  };
}

const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

r.get('/email-previews/:kind', requirePermission('admin.settings'), ah(async (req, res) => {
  const m = (await previewSamples())[req.params.kind];
  if (!m) throw notFound('Unknown email');
  res.set({ 'Content-Security-Policy': PREVIEW_CSP, 'Cache-Control': 'no-store' });
  res.type('html').send(m.html);
}));

r.get('/email-previews', requirePermission('admin.settings'), ah(async (req, res) => {
  const samples = await previewSamples();
  const from = (await getSetting('smtp.from')) || '(From address not set)';
  const cards = Object.entries(samples).map(([kind, m]) => `
    <section>
      <h2>${escHtml(m.label)}</h2>
      <p class="meta">${escHtml(m.when)}</p>
      <dl><dt>From</dt><dd>${escHtml(from)}</dd><dt>Subject</dt><dd>${escHtml(m.subject)}</dd></dl>
      <iframe src="email-previews/${kind}" title="${escHtml(m.label)}" loading="lazy"></iframe>
      <details><summary>Plain-text part</summary><pre>${escHtml(m.text)}</pre></details>
    </section>`).join('');
  res.set({ 'Content-Security-Policy': `${PREVIEW_CSP}; frame-src 'self'`, 'Cache-Control': 'no-store' });
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Platform email previews</title>
<style>
  body{margin:0;background:#f8f8f7;color:#111827;font:14px/1.5 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  main{max-width:720px;margin:0 auto;padding:32px 16px 64px}
  h1{font-size:22px;font-weight:600;margin:0 0 4px} .lead{color:#4b5563;margin:0 0 24px}
  section{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px;margin:0 0 24px}
  h2{font-size:16px;font-weight:600;margin:0} .meta{color:#6b7280;margin:2px 0 12px}
  dl{display:grid;grid-template-columns:72px 1fr;gap:2px 12px;margin:0 0 12px} dt{color:#6b7280} dd{margin:0;word-break:break-word}
  iframe{width:100%;height:640px;border:1px solid #e5e7eb;border-radius:8px;background:#f4f5f4}
  details{margin-top:8px} summary{cursor:pointer;color:#0f766e} pre{white-space:pre-wrap;background:#f8f8f7;border-radius:8px;padding:12px;font-size:13px}
</style></head><body><main>
<h1>Platform email previews</h1>
<p class="lead">What ${escHtml(await getSetting('app.name'))} itself sends, shown with sample data. Nothing is sent from this page. Mail from dispatchers to carriers goes out from their own connected mailbox and is written by them, so it is not listed here.</p>
${cards}
</main></body></html>`);
}));

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
r.get('/audit', requirePermission('admin.audit'), ah(async (req, res) => {
  const q = parse(z.object({ ...pageQuery, action: z.string().max(80).optional(), actor: z.string().max(120).optional(), from: z.string().optional(), to: z.string().optional() }), req.query);
  const where = {};
  if (q.action) where.action = { contains: q.action };
  if (q.actor) where.actor = { OR: [{ email: { contains: q.actor.toLowerCase() } }, { name: { contains: q.actor } }] };
  const createdAt = {};
  if (q.from && !Number.isNaN(Date.parse(q.from))) createdAt.gte = new Date(q.from);
  if (q.to && !Number.isNaN(Date.parse(q.to))) createdAt.lte = new Date(new Date(q.to).getTime() + DAY - 1);
  if (Object.keys(createdAt).length) where.createdAt = createdAt;
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q), include: { actor: { select: { id: true, name: true, email: true } } } }),
    prisma.auditLog.count({ where }),
  ]);
  res.json(pageResult(rows.map((x) => ({ ...x, details: x.details ? safeJson(x.details) : null })), total, q));
}));

function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }

export default r;
