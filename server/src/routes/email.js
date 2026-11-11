import { Router } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { ah, badRequest, notFound, unavailable } from '../lib/errors.js';
import { parse, z, reqStr, optStr, reqEmail, pageQuery, paginate, pageResult, clean } from '../lib/validate.js';
import { encrypt, signPayload, verifyPayload, randomToken } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { assertLimit, effectivePlan } from '../lib/plans.js';
import { loadCarrier, loadOwned, readableOwnerIds } from '../lib/access.js';
import { accessChecker, chunks } from '../services/carriers/query.js';
import { startOfUserDay } from '../lib/timezones.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { onlySent } from '../services/carriers/normalize.js';
import { SMTP_PRESETS, SMTP_PROVIDERS, SMTP_PROVIDER_KEYS, SMTP_PORTS, verifySmtp, smtpErrorMessage } from '../services/email/smtp.js';
import { sendWithAccount, pickAccount, blockedReason, deliverEmail, mailboxSentToday } from '../services/email/index.js';
import { renderContent, MERGE_FIELDS } from '../services/email/render.js';
import { OAUTH_PROVIDERS, buildAuthUrl, exchangeCode, oauthAvailability } from '../services/email/oauth.js';
import { resolveAttachments, parseAttachments, MAX_ATTACHMENTS } from '../services/email/attachments.js';
import { imapSupport, imapSettings, testImap, assertPublicHost } from '../services/email/imap.js';
import { recordReply } from '../services/email/replies.js';

const r = Router();

const serializeAccount = (a, tz) => {
  const imap = imapSupport(a);
  const s = imapSettings(a);
  return {
    id: a.id, provider: a.provider, label: a.label, fromEmail: a.fromEmail, fromName: a.fromName,
    smtpHost: a.smtpHost, smtpPort: a.smtpPort, smtpSecure: a.smtpSecure, smtpUser: a.smtpUser,
    status: a.status, lastError: a.lastError, lastVerifiedAt: a.lastVerifiedAt, dailyLimit: a.dailyLimit,
    cooldownSeconds: a.cooldownSeconds, lastSentAt: a.lastSentAt, isDefault: a.isDefault, createdAt: a.createdAt,
    hasCredentials: !!a.secretEnc,
    sentToday: mailboxSentToday(a, tz),
    // Reply and bounce detection (IMAP, opt-in).
    imapSupported: imap.supported, imapNote: imap.note, imapEnabled: !!a.imapEnabled && imap.supported,
    imapHost: s.host || null, imapPort: s.port, imapSecure: !!s.secure, imapCheckedAt: a.imapCheckedAt, imapError: a.imapError,
  };
};

/** A mailbox id from the client must be one of the caller's mailboxes (any status: drafts keep their choice). */
async function ownMailboxId(req, accountId) {
  if (!accountId) return null;
  const a = await prisma.emailAccount.findFirst({ where: { id: String(accountId), userId: req.user.id }, select: { id: true } });
  if (!a) throw badRequest('Selected mailbox is not connected');
  return a.id;
}

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
    prisma.email.count({ where: { userId: req.user.id, status: 'sent', sentAt: { gte: startOfUserDay(req.user.timezone) } } }),
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
  res.json({ items: rows.map((a) => serializeAccount(a, req.user.timezone)) });
}));

const IMAP_PORTS = [993, 143];
const hostName = z.preprocess((v) => (v === '' ? null : v), z.string().trim().toLowerCase().max(200).regex(/^[a-z0-9.-]+$/, 'Enter a server name such as imap.example.com').nullable().optional());
const imapFields = {
  imapEnabled: z.boolean().optional(),
  imapHost: hostName,
  imapPort: z.coerce.number().int().refine((p) => IMAP_PORTS.includes(p), 'IMAP uses port 993 (SSL) or 143').optional(),
  imapSecure: z.boolean().optional(),
};

const smtpSchema = z.object({
  ...imapFields,
  provider: z.enum(SMTP_PROVIDER_KEYS).default('smtp'),
  label: optStr(100),
  fromEmail: reqEmail,
  fromName: optStr(100),
  host: optStr(200),
  port: z.coerce.number().int().refine((p) => SMTP_PORTS.includes(p), `SMTP uses port ${SMTP_PORTS.join(', ')}`).optional(),
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
    // Fixed text for connection and sign-in failures: a server banner, or refused versus timed out, must not reach
    // the user (that would turn this form into a port scanner).
    throw badRequest(`Could not sign in to ${host}:${port}. ${smtpErrorMessage(err)}`);
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
  const imap = b.imapEnabled ? imapSettings({ provider: b.provider }, { host: b.imapHost, port: b.imapPort, secure: b.imapSecure }) : null;
  if (imap && !imap.host) throw badRequest('Enter the IMAP server to detect replies and bounces');
  if (imap) await assertPublicHost(imap.host);
  const count = await prisma.emailAccount.count({ where: { userId: req.user.id, status: 'connected' } });
  const account = await prisma.emailAccount.create({
    data: {
      userId: req.user.id, provider: b.provider, label: b.label || `${preset.key === 'smtp' ? 'SMTP' : preset.name.replace(/ \(.*\)$/, '')} — ${b.fromEmail}`,
      fromEmail: b.fromEmail, fromName: b.fromName || req.user.name, smtpHost: host, smtpPort: port, smtpSecure: secure, smtpUser: user,
      secretEnc: encrypt(b.password), status: 'connected', lastVerifiedAt: new Date(), dailyLimit: b.dailyLimit,
      cooldownSeconds: b.cooldownSeconds, isDefault: count === 0,
      ...(imap ? { imapEnabled: true, imapHost: imap.host, imapPort: imap.port, imapSecure: !!imap.secure } : {}),
    },
  });
  await audit(req, 'email.account_connected', { entityType: 'email_account', entityId: account.id, details: { provider: b.provider, host, imap: !!imap } });
  res.status(201).json({ account: serializeAccount(account, req.user.timezone) });
}));

async function ownAccount(req) {
  const a = await prisma.emailAccount.findFirst({ where: { id: String(req.params.id), userId: req.user.id } });
  if (!a) throw notFound('Mailbox not found');
  return a;
}

/**
 * Sign in to the mailbox's IMAP server and open the inbox (read-only). Body may override { imapHost, imapPort,
 * imapSecure } to test settings before saving them. Nothing is stored except the result on success when asked.
 */
r.post('/accounts/:id/imap/test', ah(async (req, res) => {
  const a = await ownAccount(req);
  const sup = imapSupport(a);
  if (!sup.supported) throw badRequest(sup.note);
  const b = parse(z.object(imapFields), req.body || {});
  const settings = imapSettings(a, { host: b.imapHost, port: b.imapPort, secure: b.imapSecure });
  if (!settings.host) throw badRequest('Enter the IMAP server for this mailbox');
  if (!IMAP_PORTS.includes(settings.port)) throw badRequest('IMAP uses port 993 (SSL) or 143');
  await assertPublicHost(settings.host);
  const out = await testImap(a, settings);
  if (!out.ok) throw badRequest(out.message);
  res.json({ ok: true, message: out.message, settings: { host: settings.host, port: settings.port, secure: !!settings.secure } });
}));

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
    const message = a.smtpHost ? smtpErrorMessage(err) : String(err.message || 'Sending failed');
    await prisma.emailAccount.update({ where: { id: a.id }, data: { status: 'error', lastError: message.slice(0, 500) } });
    throw badRequest(`Test failed: ${message}`);
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
    // A new password may unlock IMAP again: clear the last IMAP error so the next poll retries right away.
    data: { secretEnc: encrypt(b.password), status: 'connected', lastError: null, lastVerifiedAt: new Date(), imapError: null },
  });
  await audit(req, 'email.account_reconnected', { entityType: 'email_account', entityId: a.id });
  res.json({ account: serializeAccount(row, req.user.timezone) });
}));

r.patch('/accounts/:id', ah(async (req, res) => {
  const a = await ownAccount(req);
  // Only fields the client sent are written (no schema defaults sneak into a partial update).
  const b = onlySent(parse(z.object({
    label: z.string().trim().min(1).max(100).optional(),
    fromName: optStr(100),
    dailyLimit: z.coerce.number().int().min(1).max(5000).optional(),
    cooldownSeconds: z.coerce.number().int().min(0).max(3600).optional(),
    isDefault: z.boolean().optional(),
    ...imapFields,
  }), req.body), req.body);
  const data = clean(b);
  const serverChanged = ['imapHost', 'imapPort', 'imapSecure'].some((k) => k in data && data[k] !== a[k]);
  if (data.imapEnabled || (a.imapEnabled && serverChanged)) {
    const sup = imapSupport(a);
    if (!sup.supported) throw badRequest(sup.note);
    const s = imapSettings(a, { host: data.imapHost, port: data.imapPort, secure: data.imapSecure });
    if (!s.host) throw badRequest('Enter the IMAP server to detect replies and bounces');
    await assertPublicHost(s.host);
    Object.assign(data, { imapHost: s.host, imapPort: s.port, imapSecure: !!s.secure });
  }
  // Turning detection on, or pointing it at another server, starts fresh from the newest messages.
  if ((data.imapEnabled && !a.imapEnabled) || serverChanged) Object.assign(data, { imapLastUid: null, imapError: null, imapCheckedAt: null });
  if (data.isDefault) await prisma.emailAccount.updateMany({ where: { userId: req.user.id }, data: { isDefault: false } });
  const row = await prisma.emailAccount.update({ where: { id: a.id }, data });
  if ('imapEnabled' in data && data.imapEnabled !== a.imapEnabled) {
    await audit(req, data.imapEnabled ? 'email.imap_enabled' : 'email.imap_disabled', { entityType: 'email_account', entityId: a.id });
  }
  res.json({ account: serializeAccount(row, req.user.timezone) });
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
    data: { status: 'disconnected', secretEnc: null, accessTokenEnc: null, tokenExpiresAt: null, isDefault: false, imapEnabled: false },
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
export const EMAIL_TEMPLATE_CATEGORIES = ['carrier', 'broker', 'driver', 'follow_up', 'other'];
// Per-user cap, the same as text templates (routes/templates.js): keeps the list and the picker bounded.
const MAX_EMAIL_TEMPLATES = 500;

const templateSchema = z.object({
  name: reqStr(120), subject: reqStr(300), body: reqStr(20000),
  category: z.enum(EMAIL_TEMPLATE_CATEGORIES).default('carrier'),
});

r.get('/templates', ah(async (req, res) => {
  const where = { ownerId: req.user.id, ...(req.query.category ? { category: String(req.query.category) } : {}) };
  res.json({ items: await prisma.emailTemplate.findMany({ where, orderBy: { updatedAt: 'desc' }, take: MAX_EMAIL_TEMPLATES }) });
}));
r.post('/templates', ah(async (req, res) => {
  const b = parse(templateSchema, req.body);
  const count = await prisma.emailTemplate.count({ where: { ownerId: req.user.id } });
  if (count >= MAX_EMAIL_TEMPLATES) throw badRequest(`You can keep up to ${MAX_EMAIL_TEMPLATES} email templates. Delete some you no longer use first.`);
  res.status(201).json({ template: await prisma.emailTemplate.create({ data: { ...b, ownerId: req.user.id } }) });
}));
async function ownTemplate(req, id = req.params.id) {
  const t = await prisma.emailTemplate.findFirst({ where: { id: String(id), ownerId: req.user.id } });
  if (!t) throw notFound('Template not found');
  return t;
}
r.patch('/templates/:id', ah(async (req, res) => {
  const t = await ownTemplate(req);
  // onlySent: .partial() keeps .default('carrier'), which would reset the category on every partial edit.
  const b = onlySent(parse(templateSchema.partial(), req.body), req.body);
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
    filter: z.enum(['replied', 'bounced']).optional(), // emails that got a reply / bounced (reply detection)
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
  if (q.filter === 'replied') where.repliedAt = { not: null };
  if (q.filter === 'bounced') where.bouncedAt = { not: null };
  if (q.q) where.OR = [{ subject: { contains: q.q } }, { toEmail: { contains: q.q } }];
  const [items, total] = await Promise.all([
    prisma.email.findMany({ where, include: messageInclude, orderBy: [q.filter === 'replied' ? { repliedAt: 'desc' } : { updatedAt: 'desc' }], ...paginate(q) }),
    prisma.email.count({ where }),
  ]);
  res.json(pageResult(items.map(shapeMessage), total, q));
}));

/** Email row for the client: attachments as a parsed list. */
function shapeMessage(m) {
  return { ...m, attachments: parseAttachments(m.attachments) };
}

async function ownMessage(req) {
  const m = await prisma.email.findFirst({ where: { id: String(req.params.id), userId: req.user.id }, include: messageInclude });
  if (!m) throw notFound('Email not found');
  return m;
}

r.get('/messages/:id', ah(async (req, res) => res.json({ email: shapeMessage(await ownMessage(req)) })));

const documentIds = z.array(z.string().trim().min(1).max(40)).max(MAX_ATTACHMENTS, `Attach at most ${MAX_ATTACHMENTS} files per email`).optional();

const composeSchema = z.object({
  accountId: optStr(60),
  documentIds, // stored Documents to attach (≤5, ≤10 MB total, access-checked)
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
  const attachments = await resolveAttachments(req.user, b.documentIds);
  const base = {
    userId: req.user.id, carrierId: carrier?.id ?? null, brokerId: broker?.id ?? null, templateId: template?.id ?? null,
    toEmail: toEmail || '', subject: rendered.subject, body: rendered.body, aiGenerated: !!b.aiGenerated, attachments,
  };

  if (b.mode === 'draft') {
    // The mailbox must be the caller's (otherwise its label and address would be readable through the draft).
    const email = await prisma.email.create({ data: { ...base, status: 'draft', emailAccountId: await ownMailboxId(req, b.accountId) } });
    return res.status(201).json({ email: shapeMessage(email), outcome: 'draft', message: 'Draft saved' });
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
    return res.status(201).json({ email: shapeMessage(email), outcome: 'scheduled', message: `Scheduled for ${b.scheduledAt.toISOString()}` });
  }

  await assertLimit(req.user, 'emailsToday');
  const created = await prisma.email.create({ data: { ...base, status: 'scheduled', scheduledAt: new Date(), emailAccountId: account.id } });
  const result = await deliverEmail(created.id, { retry: false });
  res.status(201).json({ email: shapeMessage(result.email), outcome: result.outcome, message: result.message });
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

  // Recipients are loaded and access-checked in one query per kind (same rules as loadCarrier / loadOwned:
  // any id the caller may not read makes the whole request 404, so nothing is half-queued).
  const carrierIds = [...new Set((b.carrierIds || []).map(String))];
  const brokerIds = [...new Set((b.brokerIds || []).map(String))];
  const recipients = [];
  if (carrierIds.length) {
    const { readable } = await accessChecker(req.user);
    const rows = await prisma.carrier.findMany({ where: { id: { in: carrierIds } }, include: { contacts: true } });
    const byId = new Map(rows.filter(readable).map((c) => [c.id, c]));
    if (byId.size !== carrierIds.length) throw notFound('Carrier not found');
    for (const id of carrierIds) recipients.push({ carrier: byId.get(id) });
  }
  if (brokerIds.length) {
    const owners = await readableOwnerIds(req.user, 'team');
    const rows = await prisma.broker.findMany({ where: { id: { in: brokerIds }, ownerId: { in: owners } } });
    const byId = new Map(rows.map((x) => [x.id, x]));
    if (byId.size !== brokerIds.length) throw notFound();
    for (const id of brokerIds) recipients.push({ broker: byId.get(id) });
  }
  if (!recipients.length) throw badRequest('Select at least one recipient');

  // Do-not-email list: one lookup for every address instead of one per recipient.
  const addresses = [...new Set(recipients.map((x) => String((x.carrier || x.broker).email || '').trim().toLowerCase()).filter(Boolean))];
  const suppressed = new Map((addresses.length
    ? await prisma.emailSuppression.findMany({ where: { ownerId: req.user.id, email: { in: addresses } }, select: { email: true, reason: true } })
    : []).map((s) => [s.email, s.reason]));

  const when = b.scheduledAt && b.scheduledAt > new Date() ? b.scheduledAt : new Date();
  const rows = [];
  const skipped = [];
  for (const rcp of recipients) {
    const entity = rcp.carrier || rcp.broker;
    const email = String(entity.email || '').trim().toLowerCase();
    if (!email) { skipped.push({ name: entity.companyName, reason: 'No email address' }); continue; }
    if (suppressed.has(email)) { skipped.push({ name: entity.companyName, reason: `${email} is on your do-not-email list (${suppressed.get(email)})` }); continue; }
    if (rcp.carrier?.doNotEmail) { skipped.push({ name: entity.companyName, reason: 'Carrier is marked do-not-email' }); continue; }
    const rendered = renderContent({ subject, body, carrier: rcp.carrier, broker: rcp.broker, user: req.user });
    rows.push({
      userId: req.user.id, carrierId: rcp.carrier?.id ?? null, brokerId: rcp.broker?.id ?? null, templateId: template?.id ?? null,
      toEmail: entity.email, subject: rendered.subject, body: rendered.body, status: 'scheduled', scheduledAt: when, emailAccountId: account.id,
    });
  }
  for (const part of chunks(rows, 100)) await prisma.email.createMany({ data: part });
  const queued = rows.length;
  // One use per bulk send, the same as the carrier list's bulk email and the template picker (POST /api/templates/render
  // with use: true). Text the caller sent for both parts came from the picker, which already counted it, or was typed.
  if (template && queued && (!b.subject || !b.body)) {
    await prisma.emailTemplate.updateMany({ where: { id: template.id, ownerId: req.user.id }, data: { useCount: { increment: 1 }, lastUsedAt: new Date() } });
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
    documentIds,
  }), req.body);
  const data = clean({ toEmail: b.toEmail === null ? '' : b.toEmail, subject: b.subject, body: b.body });
  if (b.accountId !== undefined) data.emailAccountId = await ownMailboxId(req, b.accountId);
  if (b.documentIds !== undefined) data.attachments = await resolveAttachments(req.user, b.documentIds);
  const email = await prisma.email.update({ where: { id: m.id }, data });
  res.json({ email: shapeMessage(email) });
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
  if (m.status === 'failed') await prisma.email.updateMany({ where: { id: m.id, status: 'failed' }, data: { attempts: 0 } });
  const result = await deliverEmail(m.id, { retry: false });
  res.json({ email: shapeMessage(result.email), outcome: result.outcome, message: result.message });
}));

r.post('/messages/:id/cancel', ah(async (req, res) => {
  const m = await ownMessage(req);
  if (m.status !== 'scheduled') throw badRequest('Only scheduled emails can be canceled');
  // Compare-and-set: an email the scheduler already claimed (sending) or sent cannot be canceled any more.
  const res0 = await prisma.email.updateMany({ where: { id: m.id, status: 'scheduled' }, data: { status: 'canceled', nextAttemptAt: null } });
  if (!res0.count) throw badRequest('This email is already being sent');
  res.json({ email: shapeMessage(await prisma.email.findUnique({ where: { id: m.id } })) });
}));

/**
 * Mark a sent email as replied by hand (when reply detection is off or the reply came another way).
 * Stops the carrier's running sequences, logs the reply and creates a "Reply from" follow-up. Idempotent.
 */
r.post('/messages/:id/replied', ah(async (req, res) => {
  const m = await ownMessage(req);
  if (m.status !== 'sent') throw badRequest('Only sent emails can be marked as replied');
  if (m.repliedAt) return res.json({ email: shapeMessage(m), stopped: 0, already: true });
  const out = await recordReply({ user: req.user, email: m, fromEmail: m.toEmail, subject: `Re: ${m.subject}`, source: 'manual' });
  res.json({ email: shapeMessage(await prisma.email.findUnique({ where: { id: m.id }, include: messageInclude })), stopped: out.stopped });
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
