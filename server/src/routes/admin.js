import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { prisma } from '../db.js';
import { ah, badRequest, forbidden, notFound, conflict } from '../lib/errors.js';
import { parse, z, pageQuery, paginate, pageResult, optStr, optInt, clean } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { requirePermission } from '../middleware/auth.js';
import { SETTING_DEFS, listSettingsForAdmin, setSetting, getSettings } from '../lib/settings.js';
import { checkOAuthClient, OAUTH_PROVIDERS, redirectUri } from '../services/email/oauth.js';
import { getStripe } from '../services/stripe.js';
import { deleteUserFiles } from './settings.js';
import { config } from '../config.js';

const r = Router();
r.use(requirePermission('admin.access'));

const DAY = 86400000;
const ADMIN_ROLES = ['admin', 'super_admin'];
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
const monthKey = (d) => new Date(d).toISOString().slice(0, 7);

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
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

  const mrrCents = activeSubs.reduce((s, sub) => {
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
  if (body.status === 'suspended') await prisma.session.deleteMany({ where: { userId: target.id } });
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
  await prisma.user.update({ where: { id: target.id }, data: { passwordHash: await bcrypt.hash(password, 12) } });
  await prisma.session.deleteMany({ where: { userId: target.id } });
  await audit(req, 'admin.user_temp_password', { entityType: 'user', entityId: target.id });
  res.json({ password, note: 'Share this once with the user. Ask them to change it in Settings → Security after signing in.' });
}));

r.delete('/users/:id', requirePermission('admin.users'), ah(async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: String(req.params.id) }, include: { role: true, teamMembership: true } });
  if (!target) throw notFound('User not found');
  if (target.id === req.user.id) throw forbidden('Use Settings → Data to delete your own account');
  if (ADMIN_ROLES.includes(target.role.key) && !req.permissions.has('admin.roles')) throw forbidden('Only a super admin can delete administrator accounts');
  if (target.teamMembership?.role === 'owner') {
    const others = await prisma.teamMember.count({ where: { teamId: target.teamMembership.teamId, NOT: { userId: target.id } } });
    if (others) throw conflict('This user owns a team with other members. Transfer ownership first.');
    await prisma.team.delete({ where: { id: target.teamMembership.teamId } });
  }
  const live = await prisma.subscription.count({ where: { userId: target.id, status: { in: ['active', 'trialing', 'past_due'] } } });
  if (live) throw conflict('This user has a live Stripe subscription. Cancel it in Stripe first.');
  await prisma.team.deleteMany({ where: { ownerId: target.id } });
  await deleteUserFiles(target.id);
  await prisma.systemSetting.deleteMany({ where: { key: { startsWith: `user.${target.id}.` } } }); // per-user settings (e.g. spot rates)
  await prisma.user.delete({ where: { id: target.id } });
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
    stripeSubscriptionId: s.stripeSubscriptionId, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, createdAt: s.createdAt,
  })), total, q));
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
  res.json({ plans });
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
        comment: { select: { id: true, body: true, status: true, postId: true, author: { select: { id: true, name: true } } } },
      },
    }),
    prisma.contentReport.count({ where }),
  ]);
  res.json(pageResult(rows.map((x) => {
    const kind = x.listing ? 'listing' : x.post ? 'post' : x.comment ? 'comment' : 'deleted';
    const t = x.listing || x.post || x.comment;
    return {
      id: x.id, reason: x.reason, details: x.details, status: x.status, createdAt: x.createdAt, resolvedAt: x.resolvedAt, resolvedBy: x.resolvedBy?.name,
      reporter: x.reporter, kind,
      target: t ? {
        id: t.id, status: t.status, title: x.listing?.title || x.post?.title || null,
        excerpt: String(x.listing?.description || x.post?.body || x.comment?.body || '').slice(0, 280),
        author: (x.listing?.seller || x.post?.author || x.comment?.author) ?? null,
        link: x.listing ? `/marketplace/${t.id}` : x.post ? `/community/${t.id}` : `/community/${x.comment.postId}`,
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
    if (report.listingId) await prisma.marketplaceListing.update({ where: { id: report.listingId }, data: { status: s('active') } });
    else if (report.postId) await prisma.communityPost.update({ where: { id: report.postId }, data: { status: s('published') } });
    else if (report.commentId) await prisma.communityComment.update({ where: { id: report.commentId }, data: { status: s('published') } });
    // Close every other open report on the same content.
    const same = report.listingId ? { listingId: report.listingId } : report.postId ? { postId: report.postId } : { commentId: report.commentId };
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
  const changed = [];
  for (const [key, raw] of Object.entries(body.values)) {
    const def = SETTING_DEFS[key];
    if (!def) throw badRequest(`Unknown setting ${key}`);
    let value = typeof raw === 'string' ? raw.trim() : String(raw);
    if (def.secret && value === '') continue; // blank secret field = keep existing value
    if (def.type === 'bool' && !['true', 'false'].includes(value)) throw badRequest(`${key} must be true or false`);
    if (key === 'smtp.port' && !/^\d{1,5}$/.test(value)) throw badRequest('SMTP port must be a number');
    if ((key === 'ai.baseUrl') && value && !/^https?:\/\//.test(value)) throw badRequest('AI base URL must start with http(s)://');
    if (key === 'search.provider' && !['', 'tavily', 'brave'].includes(value)) throw badRequest('Search provider must be tavily, brave or empty');
    await setSetting(key, value, req.user.id);
    changed.push(key);
  }
  for (const key of body.clear) {
    if (!SETTING_DEFS[key]) throw badRequest(`Unknown setting ${key}`);
    await setSetting(key, '', req.user.id);
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
    const s = await getSettings(['smtp.host', 'smtp.port', 'smtp.secure', 'smtp.user', 'smtp.pass', 'smtp.from']);
    if (!s['smtp.host']) return { ok: false, message: 'SMTP host is not set' };
    const t = nodemailer.createTransport({ host: s['smtp.host'], port: Number(s['smtp.port'] || 587), secure: s['smtp.secure'] === 'true', auth: s['smtp.user'] ? { user: s['smtp.user'], pass: s['smtp.pass'] } : undefined, connectionTimeout: 10000 });
    await t.verify();
    return { ok: true, message: `Connected and authenticated to ${s['smtp.host']}${s['smtp.from'] ? '' : ' — note: "From" address is not set'}` };
  },
  async ai() {
    const s = await getSettings(['ai.baseUrl', 'ai.apiKey', 'ai.model']);
    if (!s['ai.apiKey']) return { ok: false, message: 'AI API key is not set' };
    const res = await fetch(`${s['ai.baseUrl'].replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${s['ai.apiKey']}` }, signal: timeout() });
    if (!res.ok) return { ok: false, message: `Provider responded ${res.status} ${res.statusText}` };
    const data = await res.json().catch(() => ({}));
    const ids = (data.data || []).map((m) => m.id);
    const hasModel = !ids.length || ids.includes(s['ai.model']);
    return { ok: true, message: `Authenticated. ${ids.length} models available${hasModel ? '' : ` — configured model "${s['ai.model']}" was not in the list`}.` };
  },
  async stripe() {
    const stripe = await getStripe();
    if (!stripe) return { ok: false, message: 'Stripe secret key is not set' };
    const bal = await stripe.balance.retrieve();
    const wh = (await getSettings(['stripe.webhookSecret']))['stripe.webhookSecret'];
    return { ok: true, message: `Connected (${bal.livemode ? 'live' : 'test'} mode).${wh ? '' : ' Webhook secret is NOT set — subscriptions will not activate until it is.'}` };
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
    let ok = census.ok;
    if (s['fmcsa.webKey']) {
      const qc = await fetch(`https://mobile.fmcsa.dot.gov/qc/services/carriers/1?webKey=${encodeURIComponent(s['fmcsa.webKey'])}`, { signal: timeout() });
      parts.push(qc.ok ? 'QCMobile webKey accepted' : `QCMobile responded ${qc.status}`);
      ok = ok && qc.ok;
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
