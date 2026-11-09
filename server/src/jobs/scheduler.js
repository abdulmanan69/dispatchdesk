import { prisma } from '../db.js';
import { notify, logActivity } from '../lib/activity.js';
import { deliverEmail, pickAccount, blockedReason } from '../services/email/index.js';
import { renderContent } from '../services/email/render.js';
import { advanceEnrollment } from '../services/sequenceEngine.js';
import { ingestDocument } from '../services/ai/rag.js';
import { sendSystemMail } from '../services/email/system.js';
import { runDueGenerators } from '../services/leadgen.js';

/**
 * In-process background jobs (single container, no external queue):
 * 1. send due scheduled emails (limits/cooldown/retries handled by deliverEmail)
 * 2. execute due sequence EMAIL steps
 * 3. follow-up due reminders
 * 4. process pending knowledge documents
 * 5. scheduled lead generators (plans with leadGenAutoRun)
 * A re-entrancy guard prevents overlapping ticks.
 */
const TICK_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 30000);
const BATCH = 25;
let timer = null;
let running = false;

async function sendDueEmails(now, log) {
  const due = await prisma.email.findMany({
    where: {
      status: 'scheduled',
      AND: [
        { OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }] },
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      ],
    },
    orderBy: { scheduledAt: 'asc' },
    take: BATCH,
    select: { id: true },
  });
  const outcomes = {};
  for (const { id } of due) {
    try {
      const r = await deliverEmail(id, { retry: true });
      outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
    } catch (err) {
      log('email', id, err.message);
    }
  }
  // Rows stuck in "sending" (e.g. the process died mid-send) are released after 10 minutes.
  await prisma.email.updateMany({
    where: { status: 'sending', updatedAt: { lt: new Date(now.getTime() - 10 * 60000) } },
    data: { status: 'scheduled', nextAttemptAt: now, error: 'Send interrupted; retrying' },
  });
  return outcomes;
}

async function noMailboxNotice(userId) {
  const recent = await prisma.notification.findFirst({
    where: { userId, type: 'mailbox_required', createdAt: { gt: new Date(Date.now() - 86400000) } },
  });
  if (!recent) {
    await notify(userId, {
      type: 'mailbox_required',
      title: 'Sequence emails are waiting',
      body: 'Connect a mailbox so sequence email steps can be sent.',
      link: '/app/email?tab=mailboxes',
    });
  }
}

async function runSequenceEmailSteps(now, log) {
  const enrollments = await prisma.sequenceEnrollment.findMany({
    where: { status: 'active', nextStepAt: { lte: now }, sequence: { active: true } },
    include: {
      sequence: { include: { steps: { orderBy: { order: 'asc' }, include: { template: true } } } },
      carrier: { include: { contacts: true } },
      user: true,
    },
    take: BATCH * 2,
  });
  let created = 0;
  for (const enr of enrollments) {
    const step = enr.sequence.steps[enr.currentStep];
    if (!step || step.type !== 'email') continue; // call/task steps wait for the user
    try {
      const carrier = enr.carrier;
      const blocked = await blockedReason(enr.userId, carrier.email, carrier.id);
      if (blocked) {
        await logActivity(enr.user, { type: 'sequence', carrierId: carrier.id, summary: `Skipped sequence email to ${carrier.companyName}: ${blocked}` });
        await advanceEnrollment(enr.id, { now });
        continue;
      }
      const account = await pickAccount(enr.userId);
      if (!account) { await noMailboxNotice(enr.userId); continue; }

      // Per-sequence daily cap.
      const sod = new Date(now); sod.setHours(0, 0, 0, 0);
      const sentBySeq = await prisma.email.count({ where: { enrollment: { sequenceId: enr.sequenceId }, createdAt: { gte: sod } } });
      if (sentBySeq >= enr.sequence.maxEmailsPerDay) continue;

      const subject = step.subject || step.template?.subject || `Following up — ${carrier.companyName}`;
      const body = step.body || step.template?.body || '';
      if (!body.trim()) {
        await logActivity(enr.user, { type: 'sequence', carrierId: carrier.id, summary: `Sequence "${enr.sequence.name}" email step has no content; skipped` });
        await advanceEnrollment(enr.id, { now });
        continue;
      }
      const rendered = renderContent({ subject, body, carrier, user: enr.user });
      await prisma.email.create({
        data: {
          userId: enr.userId, carrierId: carrier.id, enrollmentId: enr.id, templateId: step.templateId, emailAccountId: account.id,
          toEmail: carrier.email, subject: rendered.subject, body: rendered.body, status: 'scheduled', scheduledAt: now,
        },
      });
      created++;
      await advanceEnrollment(enr.id, { now });
    } catch (err) {
      log('sequence', enr.id, err.message);
    }
  }
  return created;
}

async function followUpReminders(now, log) {
  // Reminders fire `remindMinutesBefore` ahead of the due time (lead time is at most 7 days).
  const candidates = await prisma.followUp.findMany({
    where: { status: 'pending', dueAt: { lte: new Date(now.getTime() + 7 * 86400000) }, notifiedAt: null },
    include: { carrier: { select: { id: true, companyName: true } }, user: { select: { id: true, email: true, name: true, notifyFollowUps: true, notifyInApp: true, notifyEmail: true } } },
    orderBy: { dueAt: 'asc' },
    take: 500,
  });
  const due = candidates.filter((f) => f.dueAt.getTime() - (f.remindMinutesBefore || 0) * 60000 <= now.getTime()).slice(0, 100);
  for (const f of due) {
    try {
      const early = f.dueAt > now;
      const what = f.title || `${f.type} follow-up`;
      const when = early ? ` in ${Math.max(1, Math.round((f.dueAt - now) / 60000))} min` : '';
      const subject = `${early ? 'Coming up' : 'Follow-up due'}: ${f.carrier.companyName}${when}`;
      if (f.user.notifyFollowUps && f.user.notifyInApp) {
        await notify(f.userId, { type: 'follow_up_due', title: subject, body: f.note || what, link: '/app/follow-ups' });
      }
      if (f.user.notifyFollowUps && f.user.notifyEmail) {
        await sendSystemMail({
          to: f.user.email, subject,
          text: `Hi ${f.user.name},\n\nYour ${what} with ${f.carrier.companyName} is due${when}.${f.note ? `\n\nNote: ${f.note}` : ''}`,
        });
      }
      await prisma.followUp.update({ where: { id: f.id }, data: { notifiedAt: now } });
    } catch (err) {
      log('follow-up', f.id, err.message);
    }
  }
  return due.length;
}

async function processKnowledge(now) {
  const pending = await prisma.aIKnowledgeDocument.findMany({
    where: { status: 'processing', updatedAt: { lt: new Date(now.getTime() - 60000) } }, take: 3, select: { id: true },
  });
  for (const d of pending) await ingestDocument(d.id);
  return pending.length;
}

/** One pass of every job. Exported for tests and manual triggering. */
export async function runSchedulerTick({ now = new Date(), quiet = false } = {}) {
  if (running) return { skipped: true };
  running = true;
  const log = (kind, id, msg) => !quiet && console.error(`[scheduler] ${kind} ${id}: ${msg}`);
  try {
    const sequenceEmails = await runSequenceEmailSteps(now, log);
    const emails = await sendDueEmails(now, log);
    const reminders = await followUpReminders(now, log);
    const knowledge = await processKnowledge(now);
    const leadGenerators = await runDueGenerators(now, log);
    return { sequenceEmails, emails, reminders, knowledge, leadGenerators };
  } catch (err) {
    log('tick', '-', err.message);
    return { error: err.message };
  } finally {
    running = false;
  }
}

export function startScheduler() {
  if (timer) return;
  console.log(`[scheduler] started (every ${Math.round(TICK_MS / 1000)}s)`);
  timer = setInterval(() => { runSchedulerTick(); }, TICK_MS);
  timer.unref?.();
  setTimeout(() => runSchedulerTick(), 5000).unref?.();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
