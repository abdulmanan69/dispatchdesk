import { prisma } from '../../db.js';
import { badRequest } from '../../lib/errors.js';
import { assertLimit } from '../../lib/plans.js';
import { pickAccount, blockedReason, deliverEmail } from './index.js';

/**
 * Shared "send an email as this user" helper for server features (invoices, statements, detention notices,
 * truck posts, ...). It uses the user's own connected mailbox, respects suppression/opt-out, plan limits,
 * mailbox capacity and cooldown (inside deliverEmail), and records the Email row like the composer does.
 *
 * Contract (other modules rely on it):
 *   queueUserEmail({ user, toEmail, subject, body, carrierId?, brokerId?, templateId?, documentIds?, accountId?, sendNow = true })
 *     -> { email, outcome, message }   outcome: 'sent' | 'scheduled' | 'deferred' | 'failed' (from deliverEmail)
 *   Throws 400 when there is no mailbox, the recipient is blocked/suppressed, or required fields are missing,
 *   and 402 when the plan's daily email limit is reached.
 *   documentIds: owner-checked attachment ids (stored in Email.attachments; delivery attaches them).
 */
export async function queueUserEmail({ user, toEmail, subject, body, carrierId = null, brokerId = null, templateId = null, documentIds = [], accountId, sendNow = true }) {
  if (!toEmail) throw badRequest('Recipient email is required');
  if (!subject) throw badRequest('Subject is required');
  if (!String(body || '').trim()) throw badRequest('Body is required');
  const blocked = await blockedReason(user.id, toEmail, carrierId);
  if (blocked) throw badRequest(blocked);
  const account = await pickAccount(user.id, accountId || undefined);
  if (!account) throw badRequest('Connect a mailbox first (Email → Mailboxes)');

  let attachments = null;
  if (documentIds?.length) {
    const docs = await prisma.document.findMany({ where: { id: { in: documentIds.slice(0, 5) }, ownerId: user.id }, select: { id: true, originalName: true, sizeBytes: true } });
    if (docs.length !== Math.min(documentIds.length, 5)) throw badRequest('One or more attachments were not found');
    const total = docs.reduce((n, d) => n + d.sizeBytes, 0);
    if (total > 10 * 1024 * 1024) throw badRequest('Attachments are limited to 10 MB per email');
    attachments = JSON.stringify(docs.map((d) => ({ documentId: d.id, name: d.originalName, size: d.sizeBytes })));
  }

  await assertLimit(user, 'emailsToday');
  const created = await prisma.email.create({
    data: {
      userId: user.id, carrierId, brokerId, templateId, toEmail, subject, body, attachments,
      status: 'scheduled', scheduledAt: new Date(), emailAccountId: account.id,
    },
  });
  if (!sendNow) return { email: created, outcome: 'scheduled', message: 'Queued' };
  const result = await deliverEmail(created.id, { retry: false });
  return { email: result.email, outcome: result.outcome, message: result.message };
}
