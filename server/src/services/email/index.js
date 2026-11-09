import { prisma } from '../../db.js';
import { logActivity } from '../../lib/activity.js';
import { effectivePlan } from '../../lib/plans.js';
import { sendSmtp } from './smtp.js';
import { sendGmail } from './gmail.js';
import { sendOutlook } from './outlook.js';
import { toWire } from './render.js';

export const MAX_ATTEMPTS = 3;
const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

/** Low-level provider dispatch. Resolves { ok, providerMessageId } only after provider acceptance; throws otherwise. */
export async function sendWithAccount(account, msg) {
  if (!account || account.status !== 'connected') throw new Error('Mailbox is not connected');
  switch (account.provider) {
    case 'gmail':
      return sendGmail(account, msg);
    case 'outlook':
      return sendOutlook(account, msg);
    default:
      // Every SMTP preset (hostinger, yahoo, zoho, ...) and custom SMTP sends through SMTP.
      if (account.smtpHost) return sendSmtp(account, msg);
      throw new Error(`Unsupported provider ${account.provider}`);
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

/**
 * Capacity check for a mailbox right now. Returns null when sending is allowed,
 * otherwise { reason, retryAt } describing when to try again.
 */
export async function capacity(user, account) {
  const sod = startOfDay();
  const tomorrow = new Date(sod.getTime() + 86400000);
  const [accountSent, userSent, { plan }] = await Promise.all([
    prisma.email.count({ where: { emailAccountId: account.id, status: 'sent', sentAt: { gte: sod } } }),
    prisma.email.count({ where: { userId: user.id, status: 'sent', sentAt: { gte: sod } } }),
    effectivePlan(user),
  ]);
  const planLimit = plan?.dailyEmailLimit ?? 0;
  if (planLimit >= 0 && userSent >= planLimit) return { reason: `Daily plan limit reached (${planLimit} emails)`, retryAt: tomorrow, limit: true };
  if (accountSent >= account.dailyLimit) return { reason: `Mailbox daily limit reached (${account.dailyLimit})`, retryAt: tomorrow, limit: true };
  if (account.cooldownSeconds && account.lastSentAt) {
    const next = account.lastSentAt.getTime() + account.cooldownSeconds * 1000;
    if (next > Date.now()) return { reason: `Mailbox cooldown (${account.cooldownSeconds}s between sends)`, retryAt: new Date(next) };
  }
  return null;
}

/**
 * Deliver one stored Email row.
 * - Marks 'sent' only after provider acceptance.
 * - On capacity limits: keeps/sets 'scheduled' with nextAttemptAt (no attempt consumed).
 * - On provider error: with retry=true reschedules with backoff until MAX_ATTEMPTS, then 'failed'; with retry=false fails immediately.
 * Returns the updated row plus { outcome: 'sent'|'deferred'|'failed'|'blocked', message }.
 */
export async function deliverEmail(emailId, { retry = true } = {}) {
  const email = await prisma.email.findUnique({ where: { id: emailId }, include: { user: { include: { teamMembership: true } } } });
  if (!email) throw new Error('Email not found');
  if (!['scheduled', 'draft', 'failed', 'sending'].includes(email.status)) return { email, outcome: 'skipped', message: `Email is ${email.status}` };
  const user = email.user;

  const blocked = await blockedReason(email.userId, email.toEmail, email.carrierId);
  if (blocked) {
    const row = await prisma.email.update({ where: { id: email.id }, data: { status: 'canceled', error: blocked } });
    return { email: row, outcome: 'blocked', message: blocked };
  }

  const account = email.emailAccountId
    ? await prisma.emailAccount.findFirst({ where: { id: email.emailAccountId, userId: email.userId } })
    : await pickAccount(email.userId);
  if (!account || account.status !== 'connected') {
    const msg = 'No connected mailbox — connect one in Email → Mailboxes';
    const row = await prisma.email.update({
      where: { id: email.id },
      data: retry ? { status: 'scheduled', error: msg, nextAttemptAt: new Date(Date.now() + 3600000) } : { status: 'failed', error: msg },
    });
    return { email: row, outcome: retry ? 'deferred' : 'failed', message: msg };
  }

  const cap = await capacity(user, account);
  if (cap) {
    const row = await prisma.email.update({
      where: { id: email.id },
      data: { status: 'scheduled', emailAccountId: account.id, nextAttemptAt: cap.retryAt, scheduledAt: email.scheduledAt ?? new Date(), error: cap.reason },
    });
    return { email: row, outcome: 'deferred', message: `${cap.reason}. Queued for ${cap.retryAt.toISOString()}.` };
  }

  // Claim the row so a concurrent tick cannot send it twice.
  const claimed = await prisma.email.updateMany({
    where: { id: email.id, status: email.status },
    data: { status: 'sending', emailAccountId: account.id, attempts: { increment: 1 } },
  });
  if (!claimed.count) return { email, outcome: 'skipped', message: 'Already being processed' };

  try {
    const wire = toWire({ ownerId: email.userId, to: email.toEmail, subject: email.subject, body: email.body });
    const result = await sendWithAccount(account, wire);
    const now = new Date();
    const row = await prisma.email.update({
      where: { id: email.id },
      data: { status: 'sent', sentAt: now, providerMessageId: result.providerMessageId, error: null, nextAttemptAt: null },
    });
    await prisma.emailAccount.update({ where: { id: account.id }, data: { lastSentAt: now, status: 'connected', lastError: null } });
    if (email.carrierId) await prisma.carrier.update({ where: { id: email.carrierId }, data: { lastContactedAt: now } }).catch(() => {});
    await logActivity(user, { type: 'email', carrierId: email.carrierId, summary: `Email sent to ${email.toEmail}: ${email.subject}`, metadata: { emailId: email.id } });
    return { email: row, outcome: 'sent', message: 'Accepted by the mail provider' };
  } catch (err) {
    const attempts = email.attempts + 1;
    const authProblem = /auth|credential|reconnect|invalid_grant|535|534/i.test(err.message);
    if (authProblem) await prisma.emailAccount.update({ where: { id: account.id }, data: { status: 'error', lastError: err.message.slice(0, 500) } });
    const giveUp = !retry || attempts >= MAX_ATTEMPTS || authProblem;
    const row = await prisma.email.update({
      where: { id: email.id },
      data: giveUp
        ? { status: 'failed', error: err.message.slice(0, 1000), nextAttemptAt: null }
        : { status: 'scheduled', error: err.message.slice(0, 1000), nextAttemptAt: new Date(Date.now() + 2 ** attempts * 60000) },
    });
    return { email: row, outcome: giveUp ? 'failed' : 'deferred', message: err.message };
  }
}
