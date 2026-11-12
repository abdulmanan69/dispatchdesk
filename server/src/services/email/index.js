import { prisma } from '../../db.js';
import { logActivity } from '../../lib/activity.js';
import { effectivePlan, limitDayStart } from '../../lib/plans.js';
import { DEFAULT_TZ, localDayKey, startOfNextUserDay, startOfUserDay } from '../../lib/timezones.js';
import { sendSmtp, openSmtpTransport } from './smtp.js';
import { sendGmail } from './gmail.js';
import { sendOutlook } from './outlook.js';
import { toWire } from './render.js';
import { newMessageId } from './mime.js';
import { loadAttachmentFiles, AttachmentError } from './attachments.js';

export const MAX_ATTEMPTS = 3;
// Statuses deliverEmail may claim. 'sending' is never claimable: a row in flight belongs to whoever claimed it
// (rows stuck in 'sending' are released by the scheduler after 10 minutes).
const CLAIMABLE = ['scheduled', 'draft', 'failed'];

/**
 * Per-tick cache shared by every delivery in one scheduler batch: mailbox rows (kept in step after each send so
 * cooldown and daily counters are exact), one pooled SMTP connection per mailbox, and each user's plan.
 * Always closeSendContext() it.
 */
export function createSendContext({ accounts } = {}) {
  return { accounts: accounts || new Map(), transports: new Map(), plans: new Map() };
}

export function closeSendContext(ctx) {
  for (const t of ctx?.transports?.values() || []) {
    try { t.close?.(); } catch { /* already closed */ }
  }
  ctx?.transports?.clear();
}

/** Low-level provider dispatch. Resolves { ok, providerMessageId } only after provider acceptance; throws otherwise. */
export async function sendWithAccount(account, msg, ctx = null) {
  if (!account || account.status !== 'connected') throw new Error('Mailbox is not connected');
  switch (account.provider) {
    case 'gmail':
      return sendGmail(account, msg);
    case 'outlook':
      return sendOutlook(account, msg);
    default: {
      // Every SMTP preset (hostinger, yahoo, zoho, ...) and custom SMTP sends through SMTP.
      if (!account.smtpHost) throw new Error(`Unsupported provider ${account.provider}`);
      let transport;
      if (ctx) {
        transport = ctx.transports.get(account.id);
        if (!transport) {
          const opened = await openSmtpTransport(account);
          // Another send for this mailbox may have opened one while the server name was being checked: keep one.
          transport = ctx.transports.get(account.id);
          if (transport) opened.close?.();
          else ctx.transports.set(account.id, (transport = opened));
        }
      }
      return sendSmtp(account, msg, { transport });
    }
  }
}

/** Pick the mailbox to send from: explicit (must be the user's), else default, else any connected. */
export async function pickAccount(userId, accountId) {
  if (accountId) {
    return prisma.emailAccount.findFirst({ where: { id: accountId, userId, status: 'connected' } });
  }
  return prisma.emailAccount.findFirst({ where: { userId, status: 'connected' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
}

/** Why an address may not be emailed by this owner (null = allowed). */
export async function blockedReason(ownerId, toEmail, carrierId) {
  const email = String(toEmail || '').trim().toLowerCase();
  if (!email) return 'No email address';
  const sup = await prisma.emailSuppression.findUnique({ where: { ownerId_email: { ownerId, email } } });
  if (sup) return `${email} is on your do-not-email list (${sup.reason})`;
  if (carrierId) {
    const c = await prisma.carrier.findUnique({ where: { id: carrierId }, select: { doNotEmail: true } });
    if (c?.doNotEmail) return 'Carrier is marked do-not-email';
  }
  return null;
}

/** Messages this mailbox sent today (its owner's local day), from the counter kept on the mailbox row. */
export const mailboxSentToday = (account, tz, now = new Date()) => (account.sentDay === localDayKey(tz || DEFAULT_TZ, now) ? account.sentToday || 0 : 0);

/**
 * The mailbox's sends today, made exact at the first check of each day: when the counter is from another day (or was
 * never set: new columns on deploy day, a time-zone change, a lost increment), it is seeded from one indexed count
 * of real sends since `since` (default: local midnight) and written with compare-and-set. Same day: the counter as is.
 */
export async function syncMailboxDay(account, tz, now = new Date(), { since = null } = {}) {
  const zone = tz || DEFAULT_TZ;
  const day = localDayKey(zone, now);
  if (account.sentDay === day) return account.sentToday || 0;
  const n = await prisma.email.count({ where: { emailAccountId: account.id, status: 'sent', sentAt: { gte: since || startOfUserDay(zone, now) } } });
  const res = await prisma.emailAccount.updateMany({ where: { id: account.id, OR: [{ sentDay: null }, { sentDay: { not: day } }] }, data: { sentDay: day, sentToday: n } });
  if (!res.count) {
    // Another process rolled the day over first: use its row.
    const row = await prisma.emailAccount.findUnique({ where: { id: account.id }, select: { sentDay: true, sentToday: true } });
    if (row?.sentDay === day) {
      account.sentDay = day;
      account.sentToday = row.sentToday || 0;
      return account.sentToday;
    }
  }
  account.sentDay = day;
  account.sentToday = n;
  return n;
}

/**
 * Capacity check for a mailbox right now. Returns null when sending is allowed,
 * otherwise { reason, retryAt, scope: 'account' | 'user', limit? } describing when to try again.
 * The mailbox check is O(1) (EmailAccount.sentDay/sentToday); the plan check is an index range over today's sends.
 */
export async function capacity(user, account, { now = new Date(), ctx = null } = {}) {
  const tz = user.timezone || DEFAULT_TZ;
  const tomorrow = startOfNextUserDay(tz, now);
  // Counted from the earliest recent local midnight, so a time-zone change cannot restart today's counts.
  const dayStart = await limitDayStart(user, now);
  if ((await syncMailboxDay(account, tz, now, { since: dayStart })) >= account.dailyLimit) {
    return { reason: `Mailbox daily limit reached (${account.dailyLimit})`, retryAt: tomorrow, limit: true, scope: 'account' };
  }
  let plan = ctx?.plans.get(user.id);
  if (plan === undefined) {
    plan = (await effectivePlan(user)).plan || null;
    ctx?.plans.set(user.id, plan);
  }
  const planLimit = plan?.dailyEmailLimit ?? 0;
  if (planLimit >= 0) {
    const userSent = await prisma.email.count({ where: { userId: user.id, status: 'sent', sentAt: { gte: dayStart } } });
    if (userSent >= planLimit) return { reason: `Daily plan limit reached (${planLimit} emails)`, retryAt: tomorrow, limit: true, scope: 'user' };
  }
  if (account.cooldownSeconds && account.lastSentAt) {
    const next = new Date(account.lastSentAt).getTime() + account.cooldownSeconds * 1000;
    if (next > now.getTime()) return { reason: `Mailbox cooldown (${account.cooldownSeconds}s between sends)`, retryAt: new Date(next), scope: 'account' };
  }
  return null;
}

/**
 * Count one accepted message on the mailbox: lastSentAt and the per-day counter in the same write.
 * Compare-and-set on sentDay, so concurrent sends never lose an increment, also at the day rollover.
 */
export async function recordMailboxSend(account, tz, sentAt = new Date()) {
  const day = localDayKey(tz || DEFAULT_TZ, sentAt);
  const base = { lastSentAt: sentAt, status: 'connected', lastError: null };
  let res = await prisma.emailAccount.updateMany({ where: { id: account.id, sentDay: day }, data: { ...base, sentToday: { increment: 1 } } });
  if (!res.count) {
    res = await prisma.emailAccount.updateMany({ where: { id: account.id, OR: [{ sentDay: null }, { sentDay: { not: day } }] }, data: { ...base, sentDay: day, sentToday: 1 } });
  }
  if (!res.count) await prisma.emailAccount.updateMany({ where: { id: account.id, sentDay: day }, data: { ...base, sentToday: { increment: 1 } } });
  account.sentToday = account.sentDay === day ? (account.sentToday || 0) + 1 : 1;
  account.sentDay = day;
  account.lastSentAt = sentAt;
  account.status = 'connected';
  account.lastError = null;
}

const later = (a, b) => (a && a > b ? a : b);

async function retryWrite(fn, tries = 4) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 100 * 3 ** i));
    }
  }
  throw err;
}

async function bestEffort(what, fn) {
  try { await fn(); } catch (err) { console.error(`[email] ${what} failed after the provider accepted the message: ${err.message}`); }
}

/** Write a state change only if the row is still in the status we read (another process may have taken it). */
async function transition(email, data) {
  await prisma.email.updateMany({ where: { id: email.id, status: email.status }, data });
  return prisma.email.findUnique({ where: { id: email.id } });
}

/**
 * Deliver one stored Email row.
 * - Claims the row ('sending') with a compare-and-set from scheduled/draft/failed, so it is sent at most once.
 * - Marks 'sent' in its own statement right after provider acceptance; bookkeeping after that can never move the
 *   row back to scheduled or failed.
 * - On capacity limits: keeps/sets 'scheduled' with nextAttemptAt (no attempt consumed) and returns `deferAll`
 *   ({ emailAccountId | userId, until, reason }) so the scheduler can defer that mailbox's other due rows at once.
 * - On provider error: with retry=true reschedules with backoff until MAX_ATTEMPTS, then 'failed'; with retry=false fails.
 * - Attachments (Email.attachments) are read from document storage; a missing file fails the email with a clear reason.
 * Returns { email, outcome: 'sent'|'deferred'|'failed'|'blocked'|'skipped', message, deferAll? }.
 */
export async function deliverEmail(emailId, { retry = true, ctx = null } = {}) {
  const email = await prisma.email.findUnique({ where: { id: emailId }, include: { user: { include: { teamMembership: true } } } });
  if (!email) throw new Error('Email not found');
  if (!CLAIMABLE.includes(email.status)) return { email, outcome: 'skipped', message: `Email is ${email.status}` };
  const user = email.user;
  const now = new Date();
  const tz = user.timezone || DEFAULT_TZ;

  const blocked = await blockedReason(email.userId, email.toEmail, email.carrierId);
  if (blocked) {
    const row = await transition(email, { status: 'canceled', error: blocked });
    return { email: row, outcome: 'blocked', message: blocked };
  }

  let account = email.emailAccountId
    ? (ctx?.accounts.get(email.emailAccountId) || await prisma.emailAccount.findFirst({ where: { id: email.emailAccountId, userId: email.userId } }))
    : await pickAccount(email.userId);
  if (account && account.userId !== email.userId) account = null; // never send through another user's mailbox
  if (account && ctx && !ctx.accounts.has(account.id)) ctx.accounts.set(account.id, account);
  if (!account || account.status !== 'connected') {
    const msg = 'No connected mailbox — connect one in Email → Mailboxes';
    const until = new Date(now.getTime() + 3600000);
    const row = await transition(email, retry
      ? { status: 'scheduled', error: msg, nextAttemptAt: until, scheduledAt: later(email.scheduledAt, until) }
      : { status: 'failed', error: msg });
    return {
      email: row, outcome: retry ? 'deferred' : 'failed', message: msg,
      ...(retry && email.emailAccountId ? { deferAll: { emailAccountId: email.emailAccountId, until, reason: msg } } : {}),
    };
  }

  const cap = await capacity(user, account, { now, ctx });
  if (cap) {
    const row = await transition(email, {
      status: 'scheduled', emailAccountId: account.id, nextAttemptAt: cap.retryAt, scheduledAt: later(email.scheduledAt, cap.retryAt), error: cap.reason,
    });
    return {
      email: row, outcome: 'deferred', message: `${cap.reason}. Queued for ${cap.retryAt.toISOString()}.`,
      deferAll: cap.scope === 'user' ? { userId: user.id, until: cap.retryAt, reason: cap.reason } : { emailAccountId: account.id, until: cap.retryAt, reason: cap.reason },
    };
  }

  let attachments = [];
  try {
    attachments = await loadAttachmentFiles(user, email.attachments);
  } catch (err) {
    if (!(err instanceof AttachmentError)) throw err;
    const row = await transition(email, { status: 'failed', error: err.message, nextAttemptAt: null });
    return { email: row, outcome: 'failed', message: err.message };
  }

  // Claim the row so no other process (scheduler, a second click, another worker) sends it too.
  const messageId = email.messageId || newMessageId(account.fromEmail);
  const claimed = await prisma.email.updateMany({
    where: { id: email.id, status: email.status },
    data: { status: 'sending', emailAccountId: account.id, attempts: { increment: 1 }, messageId },
  });
  if (!claimed.count) return { email, outcome: 'skipped', message: 'Already being processed' };

  let result;
  try {
    const wire = toWire({ ownerId: email.userId, to: email.toEmail, subject: email.subject, body: email.body, mailingAddress: user.mailingAddress });
    result = await sendWithAccount(account, { ...wire, messageId, attachments }, ctx);
  } catch (err) {
    const attempts = email.attempts + 1;
    const authProblem = /auth|credential|reconnect|invalid_grant|535|534/i.test(err.message);
    if (authProblem) {
      await prisma.emailAccount.update({ where: { id: account.id }, data: { status: 'error', lastError: err.message.slice(0, 500) } }).catch(() => {});
      account.status = 'error';
      account.lastError = err.message.slice(0, 500);
    }
    const giveUp = !retry || attempts >= MAX_ATTEMPTS || authProblem;
    const row = await prisma.email.update({
      where: { id: email.id },
      data: giveUp
        ? { status: 'failed', error: err.message.slice(0, 1000), nextAttemptAt: null }
        : { status: 'scheduled', error: err.message.slice(0, 1000), nextAttemptAt: new Date(Date.now() + 2 ** attempts * 60000) },
    });
    return { email: row, outcome: giveUp ? 'failed' : 'deferred', message: err.message };
  }

  // Accepted by the provider. From here on the row is never rescheduled or failed.
  const sentAt = new Date();
  // Microsoft Graph assigns its own Message-ID (returned only for the draft path); for the others ours was used.
  // Stored in lower case: reply and bounce matching (services/email/imap.js) compares lower-cased ids.
  const finalMessageId = result.internetMessageId ? String(result.internetMessageId).toLowerCase() : (account.provider === 'outlook' ? null : messageId);
  let row;
  try {
    row = await retryWrite(() => prisma.email.update({
      where: { id: email.id },
      data: { status: 'sent', sentAt, providerMessageId: result.providerMessageId, messageId: finalMessageId, error: null, nextAttemptAt: null },
    }));
  } catch (err) {
    console.error(`[email] ${email.id} was accepted by the provider but could not be marked sent: ${err.message}`);
    row = { ...email, status: 'sent', sentAt, providerMessageId: result.providerMessageId, messageId: finalMessageId, user: undefined };
  }
  await bestEffort('mailbox counter', () => recordMailboxSend(account, tz, sentAt));
  if (email.carrierId) await bestEffort('carrier last contact', () => prisma.carrier.update({ where: { id: email.carrierId }, data: { lastContactedAt: sentAt } }));
  await bestEffort('activity', () => logActivity(user, {
    type: 'email', carrierId: email.carrierId, summary: `Email sent to ${email.toEmail}: ${email.subject}`,
    metadata: { emailId: email.id, ...(attachments.length ? { attachments: attachments.length } : {}) },
  }));
  return { email: row, outcome: 'sent', message: 'Accepted by the mail provider' };
}
