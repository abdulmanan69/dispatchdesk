import { prisma } from '../../db.js';
import { badRequest } from '../../lib/errors.js';
import { assertLimit } from '../../lib/plans.js';
import { pickAccount, blockedReason, deliverEmail } from './index.js';
import { resolveAttachments } from './attachments.js';

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
 *   documentIds: up to 5 Document ids (10 MB total) the user may access (owner, or team access to the document's
 *   carrier/load). Stored in Email.attachments; delivery attaches the files (SMTP, Gmail and Microsoft mailboxes).
 *   `user` must be the full user row (teamMembership included when team access matters), e.g. req.user.
 */
export async function queueUserEmail({ user, toEmail, subject, body, carrierId = null, brokerId = null, templateId = null, documentIds = [], accountId, sendNow = true }) {
  if (!toEmail) throw badRequest('Recipient email is required');
  if (!subject) throw badRequest('Subject is required');
  if (!String(body || '').trim()) throw badRequest('Body is required');
  const blocked = await blockedReason(user.id, toEmail, carrierId);
  if (blocked) throw badRequest(blocked);
  const account = await pickAccount(user.id, accountId || undefined);
  if (!account) throw badRequest('Connect a mailbox first (Email → Mailboxes)');
  const attachments = await resolveAttachments(user, documentIds);

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
