import { Router } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { ah, badRequest, notFound, unavailable } from '../lib/errors.js';
import { parse, z, reqStr, optStr, reqEmail, pageQuery, paginate, pageResult, clean } from '../lib/validate.js';
import { encrypt, signPayload, verifyPayload, randomToken } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { assertLimit, effectivePlan } from '../lib/plans.js';
import { loadCarrier, loadOwned } from '../lib/access.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { SMTP_PRESETS, SMTP_PROVIDERS, SMTP_PROVIDER_KEYS, verifySmtp } from '../services/email/smtp.js';
import { sendWithAccount, pickAccount, blockedReason, deliverEmail } from '../services/email/index.js';
import { renderContent, MERGE_FIELDS } from '../services/email/render.js';
import { OAUTH_PROVIDERS, buildAuthUrl, exchangeCode, oauthAvailability } from '../services/email/oauth.js';

const r = Router();
const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

const serializeAccount = (a) => ({
  id: a.id, provider: a.provider, label: a.label, fromEmail: a.fromEmail, fromName: a.fromName,
  smtpHost: a.smtpHost, smtpPort: a.smtpPort, smtpSecure: a.smtpSecure, smtpUser: a.smtpUser,
  status: a.status, lastError: a.lastError, lastVerifiedAt: a.lastVerifiedAt, dailyLimit: a.dailyLimit,
  cooldownSeconds: a.cooldownSeconds, lastSentAt: a.lastSentAt, isDefault: a.isDefault, createdAt: a.createdAt,
  hasCredentials: !!a.secretEnc,
});

// ---------------------------------------------------------------------------
// OAuth callback (reached by browser redirect from Google / Microsoft).
// Authenticated by the signed, short-lived state AND the matching session.
// ---------------------------------------------------------------------------
r.get('/oauth/:provider/callback', ah(async (req, res) => {
  const provider = String(req.params.provider);
  const back = (q) => res.redirect(`/app/email?tab=mailboxes&${new URLSearchParams(q)}`);
  if (!OAUTH_PROVIDERS[provider]) return back({ error: 'Unknown provider' });
  const state = verifyPayload(String(req.query.state || ''));
  if (!state || state.p !== provider) return back({ error: 'Authorization state is invalid or expired. Try connecting again.' });
  if (!req.user || req.user.id !== state.u) return back({ error: 'Sign in with the account that started the connection, then try again.' });
  if (req.query.error) return back({ error: String(req.query.error_description || req.query.error).slice(0, 200) });
  if (!req.query.code) return back({ error: 'No authorization code returned' });
  try {
    const t = await exchangeCode(provider, String(req.query.code));
    const existing = await prisma.emailAccount.findFirst({ where: { userId: req.user.id, provider, fromEmail: t.email } });
    const count = await prisma.emailAccount.count({ where: { userId: req.user.id, status: 'connected' } });
    const data = {
      label: `${provider === 'gmail' ? 'Gmail' : 'Outlook'} — ${t.email}`,
      fromEmail: t.email,
      fromName: t.name || req.user.name,
      accessTokenEnc: encrypt(t.accessToken),
      tokenExpiresAt: t.expiresAt,
      status: 'connected',
      lastError: null,
      lastVerifiedAt: new Date(),
      ...(t.refreshToken ? { secretEnc: encrypt(t.refreshToken) } : {}),
    };
    if (!t.refreshToken && !existing?.secretEnc) throw new Error('Provider did not return a refresh token. Remove app access in your account settings and connect again.');
    const account = existing
      ? await prisma.emailAccount.update({ where: { id: existing.id }, data })
      : await prisma.emailAccount.create({ data: { ...data, userId: req.user.id, provider, isDefault: count === 0, dailyLimit: provider === 'gmail' ? 400 : 300 } });
    await audit(req, 'email.account_connected', { entityType: 'email_account', entityId: account.id, details: { provider, email: t.email } });
    return back({ connected: provider, email: t.email });
  } catch (err) {
    return back({ error: err.message.slice(0, 200) });
  }
}));

r.use(requireAuth, requirePermission('email.use'));

// ---------------------------------------------------------------------------
// Status & helpers
// ---------------------------------------------------------------------------
r.get('/status', ah(async (req, res) => {
  const [mailboxes, sentToday, scheduled, { plan }, oauth] = await Promise.all([
    prisma.emailAccount.count({ where: { userId: req.user.id, status: 'connected' } }),
    prisma.email.count({ where: { userId: req.user.id, status: 'sent', sentAt: { gte: startOfDay() } } }),
    prisma.email.count({ where: { userId: req.user.id, status: 'scheduled' } }),
    effectivePlan(req.user),
    oauthAvailability(),
  ]);
  res.json({ mailboxesConnected: mailboxes, oauthAvailable: oauth, sentToday, scheduled, limit: plan?.dailyEmailLimit ?? 0, planName: plan?.name });
}));

r.get('/merge-fields', (req, res) => res.json({ fields: MERGE_FIELDS, presets: SMTP_PRESETS }));

/** Everything the "Connect mailbox" picker needs: which OAuth sign-ins are enabled and the SMTP presets. */
r.get('/connect-options', ah(async (req, res) => {
  const oauth = await oauthAvailability();
  res.json({
    oauth: [
      { key: 'gmail', name: 'Google', description: 'Gmail and Google Workspace', available: oauth.gmail, fallback: 'gmail_smtp' },
      { key: 'outlook', name: 'Microsoft', description: 'Outlook.com and Microsoft 365', available: oauth.outlook, fallback: 'outlook_smtp' },
    ],
    smtp: SMTP_PROVIDERS,
  });
}));

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------
r.get('/accounts', ah(async (req, res) => {
  const rows = await prisma.emailAccount.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'asc' } });
  const sent = await prisma.email.groupBy({ by: ['emailAccountId'], where: { userId: req.user.id, status: 'sent', sentAt: { gte: startOfDay() } }, _count: true });
  const byId = Object.fromEntries(sent.map((s) => [s.emailAccountId, s._count]));
  res.json({ items: rows.map((a) => ({ ...serializeAccount(a), sentToday: byId[a.id] || 0 })) });
}));

const smtpSchema = z.object({
  provider: z.enum(SMTP_PROVIDER_KEYS).default('smtp'),
  label: optStr(100),
  fromEmail: reqEmail,
  fromName: optStr(100),
  host: optStr(200),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  user: optStr(200),
  password: z.string().min(1, 'Password is required').max(500),
  dailyLimit: z.coerce.number().int().min(1).max(5000).default(50),
  cooldownSeconds: z.coerce.number().int().min(0).max(3600).default(30),
});

const presetFor = (key) => SMTP_PROVIDERS.find((p) => p.key === key) || SMTP_PROVIDERS.find((p) => p.key === 'smtp');

function smtpConfig(b) {
  const preset = presetFor(b.provider);
  const host = b.host || preset.host;
  const port = b.port || preset.port || 587;
  const secure = b.secure ?? (b.port ? port === 465 : preset.secure ?? port === 465);
  const user = b.user || b.fromEmail;
  if (!host) throw badRequest('SMTP host is required');
  return { preset, host, port, secure, user };
}

async function verifyOrThrow({ host, port, secure, user }, pass) {
  try {
    await verifySmtp({ host, port, secure, user, pass });
  } catch (err) {
    throw badRequest(`Could not sign in to ${host}:${port}: ${err.message}`);
  }
}

/** Test SMTP settings without saving anything. */
r.post('/accounts/smtp/verify', ah(async (req, res) => {
  const b = parse(smtpSchema, req.body);
  const c = smtpConfig(b);
  await verifyOrThrow(c, b.password);
  res.json({ ok: true, message: `Signed in to ${c.host}:${c.port} as ${c.user}` });
}));

r.post('/accounts/smtp', ah(async (req, res) => {
  const b = parse(smtpSchema, req.body);
  const { preset, host, port, secure, user } = smtpConfig(b);
  await verifyOrThrow({ host, port, secure, user }, b.password);
  const count = await prisma.emailAccount.count({ where: { userId: req.user.id, status: 'connected' } });
  const account = await prisma.emailAccount.create({
    data: {
      userId: req.user.id, provider: b.provider, label: b.label || `${preset.key === 'smtp' ? 'SMTP' : preset.name.replace(/ \(.*\)$/, '')} — ${b.fromEmail}`,
      fromEmail: b.fromEmail, fromName: b.fromName || req.user.name, smtpHost: host, smtpPort: port, smtpSecure: secure, smtpUser: user,
      secretEnc: encrypt(b.password), status: 'connected', lastVerifiedAt: new Date(), dailyLimit: b.dailyLimit,
      cooldownSeconds: b.cooldownSeconds, isDefault: count === 0,
    },
  });
  await audit(req, 'email.account_connected', { entityType: 'email_account', entityId: account.id, details: { provider: b.provider, host } });
  res.status(201).json({ account: serializeAccount(account) });
}));

async function ownAccount(req) {
  const a = await prisma.emailAccount.findFirst({ where: { id: String(req.params.id), userId: req.user.id } });
  if (!a) throw notFound('Mailbox not found');
  return a;
}

r.post('/accounts/:id/test', ah(async (req, res) => {
  const a = await ownAccount(req);
  if (a.status === 'disconnected') throw badRequest('Mailbox is disconnected');
  try {
    const result = await sendWithAccount({ ...a, status: 'connected' }, {
      to: req.user.email,
      subject: 'DispatchDesk mailbox test',
      text: `This is a test message from your "${a.label}" mailbox connection. If you can read this, sending works.`,
    });
    await prisma.emailAccount.update({ where: { id: a.id }, data: { status: 'connected', lastError: null, lastVerifiedAt: new Date() } });
    res.json({ ok: true, to: req.user.email, providerMessageId: result.providerMessageId });
  } catch (err) {
    await prisma.emailAccount.update({ where: { id: a.id }, data: { status: 'error', lastError: err.message.slice(0, 500) } });
    throw badRequest(`Test failed: ${err.message}`);
  }
}));

/** Reconnect an SMTP mailbox with a new password (verified before it is saved). */
r.post('/accounts/:id/credentials', ah(async (req, res) => {
  const a = await ownAccount(req);
  if (a.provider === 'gmail' || a.provider === 'outlook') throw badRequest('Reconnect this mailbox with the sign-in button');
  if (!a.smtpHost) throw badRequest('This mailbox has no SMTP settings');
  const b = parse(z.object({ password: z.string().min(1, 'Password is required').max(500) }), req.body);
  await verifyOrThrow({ host: a.smtpHost, port: a.smtpPort, secure: a.smtpSecure, user: a.smtpUser || a.fromEmail }, b.password);
  const row = await prisma.emailAccount.update({
    where: { id: a.id },
    data: { secretEnc: encrypt(b.password), status: 'connected', lastError: null, lastVerifiedAt: new Date() },
  });
  await audit(req, 'email.account_reconnected', { entityType: 'email_account', entityId: a.id });
  res.json({ account: serializeAccount(row) });
}));

r.patch('/accounts/:id', ah(async (req, res) => {
  const a = await ownAccount(req);
  const b = parse(z.object({
    label: z.string().trim().min(1).max(100).optional(),
    fromName: optStr(100),
    dailyLimit: z.coerce.number().int().min(1).max(5000).optional(),
    cooldownSeconds: z.coerce.number().int().min(0).max(3600).optional(),
    isDefault: z.boolean().optional(),
  }), req.body);
  if (b.isDefault) await prisma.emailAccount.updateMany({ where: { userId: req.user.id }, data: { isDefault: false } });
  const row = await prisma.emailAccount.update({ where: { id: a.id }, data: clean(b) });
  res.json({ account: serializeAccount(row) });
}));

/** First DELETE disconnects (wipes credentials); deleting a disconnected mailbox removes it. */
r.delete('/accounts/:id', ah(async (req, res) => {
  const a = await ownAccount(req);
  await prisma.email.updateMany({ where: { emailAccountId: a.id, status: { in: ['scheduled', 'draft'] } }, data: { emailAccountId: null } });
  if (a.status === 'disconnected') {
    await prisma.emailAccount.delete({ where: { id: a.id } });
    await audit(req, 'email.account_removed', { entityType: 'email_account', entityId: a.id });
    return res.json({ removed: true });
  }
  await prisma.emailAccount.update({
    where: { id: a.id },
    data: { status: 'disconnected', secretEnc: null, accessTokenEnc: null, tokenExpiresAt: null, isDefault: false },
  });
  await audit(req, 'email.account_disconnected', { entityType: 'email_account', entityId: a.id });
  res.json({ disconnected: true });
}));

r.get('/oauth/:provider/start', ah(async (req, res) => {
  const provider = String(req.params.provider);
  if (!OAUTH_PROVIDERS[provider]) throw notFound('Unknown provider');
  const state = signPayload({ u: req.user.id, p: provider, n: randomToken(8) }, 600);
  const out = await buildAuthUrl(provider, state);
  if (out.missing) throw unavailable(`${provider === 'gmail' ? 'Gmail' : 'Outlook'} connection is not configured. An admin must set ${out.missing.join(' and ')} in Admin → Settings.`, { missing: out.missing });
  res.json({ url: out.url, redirectUri: `${config.appUrl}/api/email/oauth/${provider}/callback` });
}));

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
const templateSchema = z.object({
  name: reqStr(120), subject: reqStr(300), body: reqStr(20000),
  category: z.enum(['carrier', 'broker', 'follow_up', 'other']).default('carrier'),
});

r.get('/templates', ah(async (req, res) => {
  const where = { ownerId: req.user.id, ...(req.query.category ? { category: String(req.query.category) } : {}) };
  res.json({ items: await prisma.emailTemplate.findMany({ where, orderBy: { updatedAt: 'desc' } }) });
}));
r.post('/templates', ah(async (req, res) => {
  const b = parse(templateSchema, req.body);
  res.status(201).json({ template: await prisma.emailTemplate.create({ data: { ...b, ownerId: req.user.id } }) });
}));
async function ownTemplate(req, id = req.params.id) {
  const t = await prisma.emailTemplate.findFirst({ where: { id: String(id), ownerId: req.user.id } });
  if (!t) throw notFound('Template not found');
  return t;
}
r.patch('/templates/:id', ah(async (req, res) => {
  const t = await ownTemplate(req);
  const b = parse(templateSchema.partial(), req.body);
  res.json({ template: await prisma.emailTemplate.update({ where: { id: t.id }, data: clean(b) }) });
}));
r.delete('/templates/:id', ah(async (req, res) => {
  const t = await ownTemplate(req);
  await prisma.emailTemplate.delete({ where: { id: t.id } });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
const messageInclude = {
  carrier: { select: { id: true, companyName: true } },
  broker: { select: { id: true, companyName: true } },
  emailAccount: { select: { id: true, label: true, fromEmail: true, provider: true } },
};

r.get('/messages', ah(async (req, res) => {
  const q = parse(z.object({
    ...pageQuery,
    status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'failed', 'canceled']).optional(),
    carrierId: z.string().optional(), brokerId: z.string().optional(), q: z.string().max(200).optional(),
  }), req.query);
  let where;
  if (q.carrierId) {
    await loadCarrier(req.user, q.carrierId); // team leads may see a member carrier's history
    where = { carrierId: q.carrierId };
  } else if (q.brokerId) {
    await loadOwned('broker', req.user, q.brokerId);
    where = { brokerId: q.brokerId };
  } else where = { userId: req.user.id };
  if (q.status) where.status = q.status;
  if (q.q) where.OR = [{ subject: { contains: q.q } }, { toEmail: { contains: q.q } }];
  const [items, total] = await Promise.all([
    prisma.email.findMany({ where, include: messageInclude, orderBy: [{ updatedAt: 'desc' }], ...paginate(q) }),
    prisma.email.count({ where }),
  ]);
  res.json(pageResult(items, total, q));
}));

async function ownMessage(req) {
  const m = await prisma.email.findFirst({ where: { id: String(req.params.id), userId: req.user.id }, include: messageInclude });
  if (!m) throw notFound('Email not found');
  return m;
}

r.get('/messages/:id', ah(async (req, res) => res.json({ email: await ownMessage(req) })));

const composeSchema = z.object({
  accountId: optStr(60),
  toEmail: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().toLowerCase().email().max(254).optional()),
  subject: z.string().trim().max(300).optional(),
  body: z.string().max(50000).optional(),
  carrierId: optStr(60),
  brokerId: optStr(60),
  templateId: optStr(60),
  mode: z.enum(['draft', 'send', 'schedule']).default('draft'),
  scheduledAt: z.preprocess((v) => (v ? new Date(v) : undefined), z.date().optional()),
  aiGenerated: z.boolean().optional(),
});

async function resolveContext(req, b) {
  const carrier = b.carrierId ? await loadCarrier(req.user, b.carrierId, { include: { contacts: true } }) : null;
  const broker = b.brokerId ? await loadOwned('broker', req.user, b.brokerId) : null;
  const template = b.templateId ? await ownTemplate(req, b.templateId) : null;
  return { carrier, broker, template };
}

async function requireMailbox(req, accountId) {
  const account = await pickAccount(req.user.id, accountId || undefined);
  if (!account) throw badRequest(accountId ? 'Selected mailbox is not connected' : 'Connect a mailbox first (Email → Mailboxes)');
  return account;
}

r.post('/messages', ah(async (req, res) => {
  const b = parse(composeSchema, req.body);
  const { carrier, broker, template } = await resolveContext(req, b);
  const toEmail = b.toEmail || carrier?.email || broker?.email;
  const rendered = renderContent({
    subject: b.subject ?? template?.subject ?? '',
    body: b.body ?? template?.body ?? '',
    carrier, broker, user: req.user,
  });
  const base = {
    userId: req.user.id, carrierId: carrier?.id ?? null, brokerId: broker?.id ?? null, templateId: template?.id ?? null,
    toEmail: toEmail || '', subject: rendered.subject, body: rendered.body, aiGenerated: !!b.aiGenerated,
  };

  if (b.mode === 'draft') {
    const email = await prisma.email.create({ data: { ...base, status: 'draft', emailAccountId: b.accountId || null } });
    return res.status(201).json({ email, outcome: 'draft', message: 'Draft saved' });
  }

  if (!toEmail) throw badRequest('Recipient email is required');
  if (!rendered.subject) throw badRequest('Subject is required');
  if (!rendered.body.trim()) throw badRequest('Body is required');
  const blocked = await blockedReason(req.user.id, toEmail, carrier?.id);
  if (blocked) throw badRequest(blocked);
  const account = await requireMailbox(req, b.accountId);

  if (b.mode === 'schedule') {
    if (!b.scheduledAt || b.scheduledAt.getTime() < Date.now() - 60000) throw badRequest('Pick a future send time');
    const email = await prisma.email.create({ data: { ...base, status: 'scheduled', scheduledAt: b.scheduledAt, emailAccountId: account.id } });
    return res.status(201).json({ email, outcome: 'scheduled', message: `Scheduled for ${b.scheduledAt.toISOString()}` });
  }

  await assertLimit(req.user, 'emailsToday');
  const created = await prisma.email.create({ data: { ...base, status: 'scheduled', scheduledAt: new Date(), emailAccountId: account.id } });
  const result = await deliverEmail(created.id, { retry: false });
  res.status(201).json({ email: result.email, outcome: result.outcome, message: result.message });
}));

r.post('/messages/bulk', ah(async (req, res) => {
  const b = parse(z.object({
    carrierIds: z.array(z.string()).max(200).optional(),
    brokerIds: z.array(z.string()).max(200).optional(),
    templateId: optStr(60),
    subject: z.string().trim().max(300).optional(),
    body: z.string().max(50000).optional(),
    accountId: optStr(60),
    scheduledAt: z.preprocess((v) => (v ? new Date(v) : undefined), z.date().optional()),
  }), req.body);
  const template = b.templateId ? await ownTemplate(req, b.templateId) : null;
  const subject = b.subject || template?.subject;
  const body = b.body || template?.body;
  if (!subject || !body) throw badRequest('Choose a template or provide a subject and body');
  const account = await requireMailbox(req, b.accountId);
  const recipients = [];
  for (const id of b.carrierIds || []) recipients.push({ carrier: await loadCarrier(req.user, id, { include: { contacts: true } }) });
  for (const id of b.brokerIds || []) recipients.push({ broker: await loadOwned('broker', req.user, id) });
  if (!recipients.length) throw badRequest('Select at least one recipient');
  const when = b.scheduledAt && b.scheduledAt > new Date() ? b.scheduledAt : new Date();
  let queued = 0;
  const skipped = [];
  for (const rcp of recipients) {
    const entity = rcp.carrier || rcp.broker;
    if (!entity.email) { skipped.push({ name: entity.companyName, reason: 'No email address' }); continue; }
    const blocked = await blockedReason(req.user.id, entity.email, rcp.carrier?.id);
    if (blocked) { skipped.push({ name: entity.companyName, reason: blocked }); continue; }
    const rendered = renderContent({ subject, body, carrier: rcp.carrier, broker: rcp.broker, user: req.user });
    await prisma.email.create({
      data: {
        userId: req.user.id, carrierId: rcp.carrier?.id ?? null, brokerId: rcp.broker?.id ?? null, templateId: template?.id ?? null,
        toEmail: entity.email, subject: rendered.subject, body: rendered.body, status: 'scheduled', scheduledAt: when, emailAccountId: account.id,
      },
    });
    queued++;
  }
  res.status(201).json({ queued, skipped, message: `${queued} email(s) queued. They send in the background, respecting your mailbox cooldown and daily limits.` });
}));

r.patch('/messages/:id', ah(async (req, res) => {
  const m = await ownMessage(req);
  if (m.status !== 'draft') throw badRequest('Only drafts can be edited');
  const b = parse(z.object({
    toEmail: z.preprocess((v) => (v === '' ? null : v), z.string().trim().toLowerCase().email().max(254).nullable().optional()),
    subject: z.string().trim().max(300).optional(),
    body: z.string().max(50000).optional(),
    accountId: optStr(60),
  }), req.body);
  const email = await prisma.email.update({
    where: { id: m.id },
    data: clean({ toEmail: b.toEmail === null ? '' : b.toEmail, subject: b.subject, body: b.body, emailAccountId: b.accountId }),
  });
  res.json({ email });
}));

r.post('/messages/:id/send', ah(async (req, res) => {
  const m = await ownMessage(req);
  if (!['draft', 'failed', 'scheduled'].includes(m.status)) throw badRequest(`Cannot send an email that is ${m.status}`);
  if (!m.toEmail) throw badRequest('Recipient email is required');
  if (!m.subject) throw badRequest('Subject is required');
  const blocked = await blockedReason(req.user.id, m.toEmail, m.carrierId);
  if (blocked) throw badRequest(blocked);
  await requireMailbox(req, m.emailAccountId);
  await assertLimit(req.user, 'emailsToday');
  if (m.status === 'failed') await prisma.email.update({ where: { id: m.id }, data: { attempts: 0 } });
  const result = await deliverEmail(m.id, { retry: false });
  res.json({ email: result.email, outcome: result.outcome, message: result.message });
}));

r.post('/messages/:id/cancel', ah(async (req, res) => {
  const m = await ownMessage(req);
  if (m.status !== 'scheduled') throw badRequest('Only scheduled emails can be canceled');
  const email = await prisma.email.update({ where: { id: m.id }, data: { status: 'canceled', nextAttemptAt: null } });
  res.json({ email });
}));

r.delete('/messages/:id', ah(async (req, res) => {
  const m = await ownMessage(req);
  if (!['draft', 'canceled', 'failed'].includes(m.status)) throw badRequest('Sent and scheduled emails are kept for your records (cancel scheduled ones first)');
  await prisma.email.delete({ where: { id: m.id } });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Suppression (do-not-email) list
// ---------------------------------------------------------------------------
r.get('/suppressions', ah(async (req, res) => {
  const q = parse(z.object({ ...pageQuery, q: z.string().max(200).optional() }), req.query);
  const where = { ownerId: req.user.id, ...(q.q ? { email: { contains: q.q.toLowerCase() } } : {}) };
  const [items, total] = await Promise.all([
    prisma.emailSuppression.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q) }),
    prisma.emailSuppression.count({ where }),
  ]);
  res.json(pageResult(items, total, q));
}));

r.post('/suppressions', ah(async (req, res) => {
  const b = parse(z.object({ email: reqEmail, reason: z.enum(['manual', 'unsubscribed', 'bounced']).default('manual') }), req.body);
  const row = await prisma.emailSuppression.upsert({
    where: { ownerId_email: { ownerId: req.user.id, email: b.email } },
    create: { ownerId: req.user.id, email: b.email, reason: b.reason },
    update: {},
  });
  await prisma.carrier.updateMany({ where: { ownerId: req.user.id, email: b.email }, data: { doNotEmail: true } });
  await prisma.email.updateMany({ where: { userId: req.user.id, toEmail: b.email, status: 'scheduled' }, data: { status: 'canceled', error: 'Address suppressed' } });
  res.status(201).json({ suppression: row });
}));

r.delete('/suppressions/:id', ah(async (req, res) => {
  const row = await prisma.emailSuppression.findFirst({ where: { id: String(req.params.id), ownerId: req.user.id } });
  if (!row) throw notFound();
  await prisma.emailSuppression.delete({ where: { id: row.id } });
  res.json({ ok: true, note: 'Removed from your list. Carrier do-not-email flags are unchanged; edit the carrier to clear them.' });
}));

export default r;
