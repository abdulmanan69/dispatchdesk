import { prisma } from '../../db.js';
import { notify, logActivity } from '../../lib/activity.js';
import { blockedReason, pickAccount } from '../../services/email/index.js';
import { renderContent } from '../../services/email/render.js';
import { advanceFrom, carrierTz, isAiEmailStep, AI_NOTE_PREFIX } from '../../services/sequenceEngine.js';
import { nextBusinessTime, startOfNextUserDay, startOfUserDay, DEFAULT_TZ } from '../../lib/timezones.js';
import { writeSequenceEmail, isAiUnavailable, aiFailureReason } from '../../services/ai/sequenceEmail.js';

/**
 * AI sequence emails: email steps whose SequenceStep.aiMode is 'auto' (AI writes and sends) or 'review' (AI writes,
 * the user approves in Email -> Needs approval).
 *
 * Hand-off: the scheduler's fast loop (30 s, time-budgeted) leaves these steps out of its due query, because an AI
 * call takes seconds. This job (every 2 minutes, under the maintenance DB lock, about a 60 s budget) finds them with
 * the same index-friendly join (SequenceEnrollment(status, nextStepAt) + SequenceStep(sequenceId, order)), oldest due
 * first, at most AI_LIMITS.perUser per user and AI_LIMITS.perRun per run.
 *
 * Exactly once per step:
 *   1. lease: compare-and-set on (id, active, currentStep, nextStepAt) moves nextStepAt to now + leaseMs, so a second
 *      run, another worker or the dialer's "send now" cannot take the same step while the AI writes;
 *   2. write the email (slow, outside any transaction);
 *   3. one transaction: re-check the lease (same nextStepAt, still active on that step: a reply, pause, stop, edit or
 *      "send now" in the meantime wins and nothing is written), advance the enrollment, insert the Email row with
 *      enrollmentId. Either both happen or neither. A crash before 3 leaves the step due again when the lease expires.
 *
 * Sending is the normal path: 'scheduled' rows are sent by the scheduler (deliverEmail), so suppression, the
 * unsubscribe footer, mailbox and plan limits and cooldown apply exactly as for template emails. 'review' rows wait
 * for approval (routes/email.js). Quiet hours: a step that is processed outside the carrier's send window (backlog)
 * is put back to the next window instead of being written now. Stop-on-reply: replies stop the enrollment, and the
 * transaction in 3 then finds it inactive.
 *
 * When AI cannot write (not set up, over quota, provider error, unusable reply): the step's template is sent instead
 * when it has one; otherwise a 'review' email holds the brief with a note. Never retried; the user is notified at
 * most once a day.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

export const AI_LIMITS = {
  perRun: 40, // enrollments looked at per run
  perUser: 5, // per user per run (fairness)
  concurrency: 3, // users served side by side (one AI call in flight per user)
  budgetMs: 60_000, // no new email is started after this
  leaseMs: 15 * MIN, // a step being written is out of every due query this long
  windowMs: 48 * HOUR, // same scan window as the scheduler (its stale-step sweep re-arms older ones)
};

/** Due enrollments whose current step is an AI email step. Fair: at most `perUser` per user, oldest due first. */
export async function dueAiEnrollmentIds(now, { limit = AI_LIMITS.perRun, perUser = AI_LIMITS.perUser, windowMs = AI_LIMITS.windowMs } = {}) {
  const from = new Date(now.getTime() - windowMs);
  const rows = await prisma.$queryRaw`
    SELECT id FROM (
      SELECT e.id AS id, e.nextStepAt AS nextStepAt,
             ROW_NUMBER() OVER (PARTITION BY e.userId ORDER BY e.nextStepAt) AS rn
      FROM SequenceEnrollment e
      JOIN SequenceStep s ON s.sequenceId = e.sequenceId AND s."order" = e.currentStep
      JOIN EmailSequence q ON q.id = e.sequenceId
      WHERE e.status = 'active' AND e.nextStepAt > ${from} AND e.nextStepAt <= ${now}
        AND s.type = 'email' AND s.aiMode IN ('auto', 'review') AND q.active = 1
    ) WHERE rn <= ${perUser}
    ORDER BY nextStepAt ASC
    LIMIT ${limit}`;
  return rows.map((r) => r.id);
}

/** Run fn over items, at most n at a time. */
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/** Same notice the scheduler gives for template steps (one per day per user). */
async function mailboxNotice(userId) {
  const recent = await prisma.notification.findFirst({ where: { userId, type: 'mailbox_required', createdAt: { gt: new Date(Date.now() - 86400000) } }, select: { id: true } });
  if (!recent) {
    await notify(userId, { type: 'mailbox_required', title: 'Sequence emails are waiting', body: 'Connect a mailbox so sequence email steps can be sent.', link: '/app/email?tab=mailboxes' });
  }
}

function nextCapWindow(sequence, carrier, now) {
  const tomorrow = startOfNextUserDay(sequence.owner?.timezone || DEFAULT_TZ, now);
  return sequence.respectBusinessHours
    ? nextBusinessTime(carrierTz(carrier), tomorrow, sequence.windowStartHour, sequence.windowEndHour, sequence.skipWeekends)
    : tomorrow;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function notifyFailures(failures) {
  for (const [userId, n] of failures) {
    const recent = await prisma.notification.findFirst({ where: { userId, type: 'ai_sequence_failed', createdAt: { gt: new Date(Date.now() - 86400000) } }, select: { id: true } });
    if (recent) continue;
    await notify(userId, {
      type: 'ai_sequence_failed',
      title: `AI could not write ${plural(n, 'sequence email')} — check AI settings`,
      body: 'Steps with a template were sent from the template. The others wait in Email, Needs approval, with your brief.',
      link: '/app/settings?tab=ai',
    });
  }
}

async function notifyReviews(reviews) {
  for (const [userId, n] of reviews) {
    // One unread reminder at a time: the Needs approval tab shows the live count.
    const unread = await prisma.notification.findFirst({ where: { userId, type: 'ai_review_waiting', readAt: null, createdAt: { gt: new Date(Date.now() - 86400000) } }, select: { id: true } });
    if (unread) continue;
    await notify(userId, {
      type: 'ai_review_waiting',
      title: `${plural(n, 'sequence email')} waiting for your approval`,
      body: 'Read, edit and approve them in Email, Needs approval. Nothing is sent until you approve.',
      link: '/app/email?tab=review',
    });
  }
}

/** One enrollment: lease, write, then insert + advance in one transaction. */
async function processOne(enr, ctx) {
  const { stats, sequences, sentToday, capLoads, accountFor, aiDown, failures, reviews, log } = ctx;
  const sequence = sequences.get(enr.sequenceId);
  const step = sequence?.steps[enr.currentStep];
  if (!sequence?.active || !isAiEmailStep(step)) return; // edited meanwhile: the fast loop takes template steps
  const carrier = enr.carrier;
  const leaseUntil = new Date(Date.now() + AI_LIMITS.leaseMs);
  const lease = await prisma.sequenceEnrollment.updateMany({
    where: { id: enr.id, status: 'active', currentStep: enr.currentStep, nextStepAt: enr.nextStepAt },
    data: { nextStepAt: leaseUntil },
  });
  if (!lease.count) { stats.skipped++; return; }
  const holdsLease = { id: enr.id, status: 'active', currentStep: enr.currentStep, nextStepAt: leaseUntil };
  const release = (at) => prisma.sequenceEnrollment.updateMany({ where: holdsLease, data: { nextStepAt: at } });
  let reserved = false;
  const unreserve = () => { if (reserved) { sentToday.set(sequence.id, sentToday.get(sequence.id) - 1); reserved = false; } };

  try {
    const blocked = await blockedReason(enr.userId, carrier.email, carrier.id);
    if (blocked) {
      if (await advanceFrom(enr, sequence, { now: new Date(), expectedStep: enr.currentStep })) {
        await logActivity(enr.user, { type: 'sequence', carrierId: carrier.id, summary: `Skipped sequence email to ${carrier.companyName}: ${blocked}` });
      }
      stats.skipped++;
      return;
    }
    // Quiet hours: after a backlog the step may come up outside the carrier's window; write it when the window opens.
    if (sequence.respectBusinessHours) {
      const t = new Date();
      const open = nextBusinessTime(carrierTz(carrier), t, sequence.windowStartHour, sequence.windowEndHour, sequence.skipWeekends);
      if (open.getTime() > t.getTime() + MIN) { await release(open); stats.deferred++; return; }
    }
    if (!accountFor.has(enr.userId)) accountFor.set(enr.userId, await pickAccount(enr.userId));
    const account = accountFor.get(enr.userId);
    if (!account) {
      await mailboxNotice(enr.userId);
      await release(new Date(Date.now() + HOUR));
      stats.deferred++;
      return;
    }
    // The sequence's daily cap, counted like the scheduler counts it (emails of this sequence created today).
    // Users run side by side and may share a sequence (team): the count is loaded once, then kept here.
    if (!sentToday.has(sequence.id)) {
      if (!capLoads.has(sequence.id)) {
        const dayStart = startOfUserDay(sequence.owner?.timezone || DEFAULT_TZ, new Date());
        capLoads.set(sequence.id, prisma.email.count({ where: { enrollment: { sequenceId: sequence.id }, createdAt: { gte: dayStart } } }));
      }
      const count = await capLoads.get(sequence.id);
      if (!sentToday.has(sequence.id)) sentToday.set(sequence.id, count);
    }
    if (sentToday.get(sequence.id) >= sequence.maxEmailsPerDay) {
      await release(nextCapWindow(sequence, carrier, new Date()));
      stats.deferred++;
      return;
    }
    sentToday.set(sequence.id, sentToday.get(sequence.id) + 1);
    reserved = true;

    // Earlier emails of this run of the sequence (not canceled or failed ones), latest three, oldest first.
    const previous = (await prisma.email.findMany({
      where: { enrollmentId: enr.id, status: { in: ['sent', 'sending', 'scheduled'] }, createdAt: { gte: enr.startedAt } },
      orderBy: { createdAt: 'desc' }, take: 3, select: { subject: true, body: true, sentAt: true },
    })).reverse();

    let draft = null;
    let failure = null;
    let reason = null;
    const brief = String(step.aiBrief || '').trim();
    if (!brief) failure = { code: 'AI_NO_BRIEF' };
    else if (aiDown.has(enr.userId)) failure = aiDown.get(enr.userId);
    else {
      try {
        draft = await writeSequenceEmail({ user: enr.user, carrier, brief, previous, stepNumber: enr.currentStep + 1, stepCount: sequence.steps.length });
      } catch (err) {
        failure = err;
        if (isAiUnavailable(err)) aiDown.set(enr.userId, err); // the user's other steps this run fail the same way: no more calls
        else log('ai-sequence-email', enr.id, err.message);
      }
    }

    let row;
    let kind;
    if (draft) {
      const hold = step.aiMode === 'review' || draft.flagged.length > 0;
      row = {
        subject: draft.subject, body: draft.body, aiGenerated: true, status: hold ? 'review' : 'scheduled', templateId: null,
        error: draft.flagged.length ? `Held for your approval: the AI wrote ${draft.flagged.join(', ')}, which is not in your brief or the carrier record. Check it before sending.` : null,
      };
      kind = hold ? 'review' : 'written';
    } else {
      reason = failure?.code === 'AI_NO_BRIEF' ? 'the step has no brief' : aiFailureReason(failure);
      const fallbackBody = step.body || step.template?.body || '';
      const fallbackSubject = step.subject || step.template?.subject || `Following up — ${carrier.companyName}`;
      if (fallbackBody.trim()) {
        const rendered = renderContent({ subject: fallbackSubject, body: fallbackBody, carrier, user: enr.user });
        row = { subject: rendered.subject, body: rendered.body, aiGenerated: false, status: 'scheduled', templateId: step.templateId, error: null };
        kind = 'fallback';
      } else {
        row = {
          subject: renderContent({ subject: fallbackSubject, body: '', carrier, user: enr.user }).subject,
          body: brief || 'Write this email before approving it.',
          aiGenerated: false, status: 'review', templateId: null,
          error: `${AI_NOTE_PREFIX} (${reason}). The text below is your brief: write the email, then approve it.`,
        };
        kind = 'note';
      }
      failures.set(enr.userId, (failures.get(enr.userId) || 0) + 1);
    }

    const created = await prisma.$transaction(async (tx) => {
      // Still ours? A reply, pause, stop, sequence edit or the dialer's "send now" while the AI was writing wins.
      const held = await tx.sequenceEnrollment.updateMany({ where: holdsLease, data: { nextStepAt: leaseUntil } });
      if (!held.count) return null;
      const moved = await advanceFrom(enr, sequence, { now: new Date(), expectedStep: enr.currentStep, db: tx });
      if (!moved) return null;
      return tx.email.create({
        data: {
          userId: enr.userId, carrierId: carrier.id, enrollmentId: enr.id, templateId: row.templateId, emailAccountId: account.id,
          toEmail: carrier.email, subject: row.subject, body: row.body, status: row.status,
          scheduledAt: row.status === 'scheduled' ? new Date() : null, aiGenerated: row.aiGenerated, error: row.error,
        },
      });
    });
    if (!created) { unreserve(); stats.skipped++; return; }
    reserved = false;
    stats[kind]++;
    if (row.status === 'review') reviews.set(enr.userId, (reviews.get(enr.userId) || 0) + 1);
    if (kind === 'fallback' || kind === 'note') {
      await logActivity(enr.user, {
        type: 'sequence', carrierId: carrier.id,
        summary: `AI could not write step ${enr.currentStep + 1} of "${sequence.name}" for ${carrier.companyName} (${reason}). ${kind === 'fallback' ? 'Sent the step\'s template instead.' : 'Your brief is waiting in Needs approval.'}`,
      }).catch(() => {});
    }
  } catch (err) {
    unreserve();
    log('ai-sequence-email', enr.id, err.message);
    stats.errors++;
    await release(new Date(Date.now() + 15 * MIN)).catch(() => {});
  }
}

/**
 * One run. Returns counts: written (AI, sent), review (AI, waiting for approval), fallback (template sent),
 * note (brief waiting for approval), deferred (window, cap, no mailbox), skipped (taken by someone else, blocked), errors.
 */
export async function runAiSequenceEmails(now = new Date(), { budgetMs = AI_LIMITS.budgetMs, limit = AI_LIMITS.perRun, perUser = AI_LIMITS.perUser, concurrency = AI_LIMITS.concurrency, log = (kind, id, msg) => console.error(`[${kind}] ${id}: ${msg}`) } = {}) {
  const stats = { due: 0, written: 0, review: 0, fallback: 0, note: 0, deferred: 0, skipped: 0, errors: 0 };
  const deadline = Date.now() + budgetMs;
  const ids = await dueAiEnrollmentIds(now, { limit, perUser });
  stats.due = ids.length;
  if (!ids.length) return stats;
  const enrollments = await prisma.sequenceEnrollment.findMany({
    where: { id: { in: ids }, status: 'active' },
    include: { carrier: { include: { contacts: true } }, user: { include: { teamMembership: { include: { team: true } } } } },
    orderBy: { nextStepAt: 'asc' },
  });
  const sequences = new Map((await prisma.emailSequence.findMany({
    where: { id: { in: [...new Set(enrollments.map((e) => e.sequenceId))] } },
    include: { steps: { orderBy: { order: 'asc' }, include: { template: true } }, owner: { select: { timezone: true } } },
  })).map((s) => [s.id, s]));
  const ctx = {
    stats, sequences, log,
    sentToday: new Map(), // sequenceId -> emails created today (reserved before the AI call, released when none is written)
    capLoads: new Map(), // sequenceId -> the pending count query (loaded once)
    accountFor: new Map(), // userId -> mailbox | null
    aiDown: new Map(), // userId -> the 503/429 error: no further AI calls for them this run
    failures: new Map(), // userId -> steps the AI could not write
    reviews: new Map(), // userId -> emails added to Needs approval
  };
  // One user's steps run one after another (their AI key is not hit in parallel, and once it reports "not set up" or
  // "over quota" their other steps fall back without another call); different users run side by side.
  const byUser = new Map();
  for (const enr of enrollments) {
    if (!byUser.has(enr.userId)) byUser.set(enr.userId, []);
    byUser.get(enr.userId).push(enr);
  }
  await pool([...byUser.values()], concurrency, async (list) => {
    for (const enr of list) {
      if (Date.now() > deadline) return;
      await processOne(enr, ctx);
    }
  });
  await notifyFailures(ctx.failures).catch((err) => log('ai-sequence-email', 'notify', err.message));
  await notifyReviews(ctx.reviews).catch((err) => log('ai-sequence-email', 'notify', err.message));
  return stats;
}

export const jobs = [
  {
    name: 'ai-sequence-email',
    label: `AI sequence emails: write due AI email steps (up to ${AI_LIMITS.perRun} per run, ${AI_LIMITS.perUser} per user)`,
    everyMs: 2 * MIN,
    run: (now) => runAiSequenceEmails(now),
  },
];
