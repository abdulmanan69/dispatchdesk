import { prisma } from '../db.js';
import { notify, logActivity } from '../lib/activity.js';
import { deliverEmail, pickAccount, blockedReason, MAX_ATTEMPTS, createSendContext, closeSendContext } from '../services/email/index.js';
import { renderContent } from '../services/email/render.js';
import { advanceFrom, carrierTz, invalidateQueueCount, isAiEmailStep } from '../services/sequenceEngine.js';
import { ingestDocument } from '../services/ai/rag.js';
import { runDueGenerators } from '../services/leadgen.js';
import { nextBusinessTime, startOfNextUserDay, startOfUserDay, DEFAULT_TZ } from '../lib/timezones.js';
import { runMaintenance } from './maintenance.js';

/**
 * Background jobs. They run in exactly one process (cluster.js starts the scheduler in one worker).
 *
 * Fast loop (every SCHEDULER_INTERVAL_MS, default 30 s), in this order, each with its own time budget:
 *   1. due sequence EMAIL steps (fair per user, compare-and-set on the step)
 *   2. due scheduled emails (fair per mailbox: the oldest few of each mailbox, never one user's backlog first)
 *   3. follow-up reminders (in-app notify(); one summary per user when many are due; no per-item email)
 * Slow loop (every SCHEDULER_SLOW_INTERVAL_MS, default 60 s), on its own timer and re-entrancy flag, so lead
 * generation, knowledge ingestion and maintenance (backup, digests, IMAP polling...) never delay email or reminders:
 *   4. pending knowledge documents
 *   5. scheduled lead generators
 *   6. maintenance jobs (jobs/maintenance.js + jobs/extra/*.js; DB-locked, at most 3 per tick)
 *
 * Every query is an index range scan (Email(status, scheduledAt), Email(emailAccountId, status, sentAt),
 * SequenceEnrollment(status, nextStepAt) + SequenceStep(sequenceId, order), FollowUp(status, notifiedAt, dueAt))
 * and every loop is bounded by a row limit and a deadline. Correctness never depends on this process's memory:
 * rows are claimed with compare-and-set writes, so a second scheduler (e.g. during a rolling deploy) is harmless.
 */
const TICK_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 30000);
const SLOW_TICK_MS = Number(process.env.SCHEDULER_SLOW_INTERVAL_MS || 60000);
const MIN = 60000;
const HOUR = 60 * MIN;

/** Limits per fast tick. */
export const LIMITS = {
  mailboxesPerTick: 40, // distinct mailboxes served per tick
  perMailbox: 10, // at most this many sends per mailbox per tick (fewer when its cooldown is longer)
  unassignedPerTick: 10, // scheduled rows without a mailbox (mailbox was removed)
  sendConcurrency: 4, // mailboxes sending in parallel (one message at a time per mailbox)
  enrollmentsPerTick: 60,
  enrollmentsPerUser: 5,
  enrollmentWindowMs: 48 * HOUR, // email steps are found among steps that became due in this window
  remindersPerPass: 300,
  emailBudgetMs: 15000,
  sequenceBudgetMs: 8000,
  reminderBudgetMs: 5000,
};

// Reminder lead times the UI offers (routes/followups.js snaps API values to these).
export const REMIND_PRESETS = [0, 5, 10, 15, 30, 60, 120, 240, 480, 1440, 2880, 4320, 10080];
const LONG_LEAD_EVERY_MS = 2.5 * MIN; // leads of 4 h and more are checked every few minutes, not every tick

let timer = null;
let slowTimer = null;
let laneTimers = [];
let fastRunning = false;
let slowRunning = false;
// Each slow lane has its own timer and re-entrancy flag, so one long job never holds up the others.
const laneRunning = { leads: false, maintenance: false, priority: false };
let lastLongLeadScan = 0;

const deadlineIn = (ms) => Date.now() + ms;
const pastDeadline = (deadline) => Date.now() > deadline;

// ---------------------------------------------------------------------------
// 2. Scheduled emails
// ---------------------------------------------------------------------------

// A range on Email(status, scheduledAt): every scheduled row has a scheduledAt (normalized in releaseStuckSends), and
// deferrals move scheduledAt forward, so rows waiting for a cooldown or tomorrow's limit are outside the scanned range.
export const dueEmailWhere = (now) => ({
  status: 'scheduled',
  scheduledAt: { lte: now },
  OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
});

/** Run `fn` over items with at most `n` in flight. */
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** How many messages one mailbox may send in one tick, given its cooldown. */
function perMailboxQuota(account) {
  if (!account) return 1;
  const cd = Number(account.cooldownSeconds) || 0;
  if (cd <= 0) return LIMITS.perMailbox;
  return Math.max(1, Math.min(LIMITS.perMailbox, Math.floor(TICK_MS / 1000 / cd)));
}

async function releaseStuckSends(now) {
  // Rows stuck in "sending" (the process died mid-send) are released after 10 minutes, or failed once out of attempts.
  const old = new Date(now.getTime() - 10 * MIN);
  await prisma.email.updateMany({
    where: { status: 'sending', updatedAt: { lt: old }, attempts: { gte: MAX_ATTEMPTS } },
    data: { status: 'failed', error: 'Send was interrupted. Check your mailbox Sent folder before retrying.', nextAttemptAt: null },
  });
  await prisma.email.updateMany({
    where: { status: 'sending', updatedAt: { lt: old } },
    data: { status: 'scheduled', nextAttemptAt: now, error: 'Send interrupted; retrying' },
  });
  // Older code could leave a scheduled row without scheduledAt; give it one so the due query stays a range scan.
  await prisma.email.updateMany({ where: { status: 'scheduled', scheduledAt: null }, data: { scheduledAt: now } });
}

async function sendDueEmails(now, log, { budgetMs = LIMITS.emailBudgetMs } = {}) {
  const deadline = deadlineIn(budgetMs);
  await releaseStuckSends(now);
  const where = dueEmailWhere(now);
  // Fairness: one group per mailbox, oldest waiting mailbox first. A 200-email bulk send occupies one slot, not 25.
  const groups = await prisma.email.groupBy({
    by: ['emailAccountId'], where, _min: { scheduledAt: true }, orderBy: { _min: { scheduledAt: 'asc' } }, take: LIMITS.mailboxesPerTick,
  });
  const outcomes = {};
  if (!groups.length) return outcomes;
  const accountIds = groups.map((g) => g.emailAccountId).filter(Boolean);
  const accounts = new Map((await prisma.emailAccount.findMany({ where: { id: { in: accountIds } } })).map((a) => [a.id, a]));
  const ctx = createSendContext({ accounts });
  const count = (o) => { outcomes[o] = (outcomes[o] || 0) + 1; };
  try {
    await pool(groups, LIMITS.sendConcurrency, async (g) => {
      if (pastDeadline(deadline)) return;
      const account = g.emailAccountId ? accounts.get(g.emailAccountId) : null;
      const take = g.emailAccountId ? perMailboxQuota(account) : LIMITS.unassignedPerTick;
      const rows = await prisma.email.findMany({
        where: { ...where, emailAccountId: g.emailAccountId },
        orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }], take, select: { id: true },
      });
      for (const { id } of rows) {
        if (pastDeadline(deadline)) break;
        try {
          const r = await deliverEmail(id, { retry: true, ctx });
          count(r.outcome);
          // A mailbox (or plan) limit or a cooldown applies to the whole group: deferred in one statement, stop here.
          if (r.outcome === 'deferred' && r.deferAll) {
            const n = await deferGroup(r.deferAll, where);
            if (n) outcomes.deferred = (outcomes.deferred || 0) + n;
            break;
          }
        } catch (err) {
          log('email', id, err.message);
        }
      }
      // After the last send of this tick the mailbox is in cooldown: park its remaining due rows until then.
      if (account && account.cooldownSeconds > 0 && account.lastSentAt && !pastDeadline(deadline)) {
        const until = new Date(account.lastSentAt.getTime() + account.cooldownSeconds * 1000);
        if (until > new Date()) {
          await deferGroup({ emailAccountId: account.id, until, reason: `Mailbox cooldown (${account.cooldownSeconds}s between sends)` }, where);
        }
      }
    });
  } finally {
    closeSendContext(ctx);
  }
  return outcomes;
}

/** Defer every due row of one mailbox (or one user, for the plan limit) with a single write. */
async function deferGroup({ emailAccountId, userId, until, reason }, where) {
  const scope = emailAccountId ? { emailAccountId } : { userId };
  const res = await prisma.email.updateMany({
    where: { ...where, ...scope },
    // scheduledAt moves too, so deferred rows leave the Email(status, scheduledAt) range that the due query scans.
    data: { nextAttemptAt: until, scheduledAt: until, error: String(reason).slice(0, 1000) },
  });
  return res.count;
}

// ---------------------------------------------------------------------------
// 1. Sequence email steps
// ---------------------------------------------------------------------------

async function noMailboxNotice(userId) {
  const recent = await prisma.notification.findFirst({
    where: { userId, type: 'mailbox_required', createdAt: { gt: new Date(Date.now() - 86400000) } }, select: { id: true },
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

/**
 * Due enrollments whose CURRENT step is an email step. Joining SequenceStep on (sequenceId, order) keeps call and task
 * steps (which wait for the user) from filling the batch. Fair: at most `perUser` rows per user per tick.
 * Range: steps that became due within the window; email steps that cannot run are always moved forward, so none stay
 * behind it (the daily sweep in sweepStaleEmailSteps re-arms any that do, e.g. after downtime).
 * AI-written steps (aiMode 'auto' | 'review') are left out: an AI call takes seconds, so they are handed off to the
 * ai-sequence-email job (jobs/extra/ai-sequence-email.js), which writes, queues and advances them itself.
 */
export async function dueEmailEnrollmentIds(now, { limit = LIMITS.enrollmentsPerTick, perUser = LIMITS.enrollmentsPerUser, windowMs = LIMITS.enrollmentWindowMs } = {}) {
  const from = new Date(now.getTime() - windowMs);
  const rows = await prisma.$queryRaw`
    SELECT id FROM (
      SELECT e.id AS id, e.nextStepAt AS nextStepAt,
             ROW_NUMBER() OVER (PARTITION BY e.userId ORDER BY e.nextStepAt) AS rn
      FROM SequenceEnrollment e
      JOIN SequenceStep s ON s.sequenceId = e.sequenceId AND s."order" = e.currentStep
      JOIN EmailSequence q ON q.id = e.sequenceId
      WHERE e.status = 'active' AND e.nextStepAt > ${from} AND e.nextStepAt <= ${now}
        AND s.type = 'email' AND (s.aiMode IS NULL OR s.aiMode NOT IN ('auto', 'review')) AND q.active = 1
    ) WHERE rn <= ${perUser}
    ORDER BY nextStepAt ASC
    LIMIT ${limit}`;
  return rows.map((r) => r.id);
}

/**
 * Email steps that fell behind the scan window (scheduler downtime): re-armed to now, in small batches.
 * Steps of turned-off sequences are left alone (keeping their due time); a later sweep re-arms them once the sequence
 * is active again.
 */
export async function sweepStaleEmailSteps(now, { windowMs = LIMITS.enrollmentWindowMs, limit = 500 } = {}) {
  const before = new Date(now.getTime() - windowMs);
  const rows = await prisma.$queryRaw`
    SELECT e.id AS id FROM SequenceEnrollment e
    JOIN SequenceStep s ON s.sequenceId = e.sequenceId AND s."order" = e.currentStep
    JOIN EmailSequence q ON q.id = e.sequenceId
    WHERE e.status = 'active' AND e.nextStepAt <= ${before} AND s.type = 'email' AND q.active = 1
    ORDER BY e.nextStepAt ASC LIMIT ${limit}`;
  if (!rows.length) return 0;
  const res = await prisma.sequenceEnrollment.updateMany({ where: { id: { in: rows.map((r) => r.id) }, status: 'active' }, data: { nextStepAt: now } });
  return res.count;
}

const sequenceDayStart = (sequence, now) => startOfUserDay(sequence.owner?.timezone || DEFAULT_TZ, now);

/** Next allowed send time after a per-day cap was hit: start of the owner's next day, inside the carrier's window. */
function nextCapWindow(sequence, carrier, now) {
  const tomorrow = startOfNextUserDay(sequence.owner?.timezone || DEFAULT_TZ, now);
  return sequence.respectBusinessHours
    ? nextBusinessTime(carrierTz(carrier), tomorrow, sequence.windowStartHour, sequence.windowEndHour, sequence.skipWeekends)
    : tomorrow;
}

/**
 * Has this enrollment already been sent this exact email (same subject and body)? Only checked for sequences edited
 * after the enrollment began, where an edit can move a carrier back onto a step it already had. Two steps that only
 * share a template or a subject line are different emails and are both sent.
 */
async function alreadySentStep(enr, sequence, rendered) {
  if (!(sequence.updatedAt > enr.startedAt)) return false;
  const prior = await prisma.email.findMany({ where: { enrollmentId: enr.id }, select: { subject: true, body: true }, take: 50 });
  return prior.some((p) => p.subject === rendered.subject && p.body === rendered.body);
}

async function runSequenceEmailSteps(now, log, { budgetMs = LIMITS.sequenceBudgetMs } = {}) {
  const deadline = deadlineIn(budgetMs);
  const ids = await dueEmailEnrollmentIds(now);
  if (!ids.length) return 0;
  const enrollments = await prisma.sequenceEnrollment.findMany({
    where: { id: { in: ids }, status: 'active' },
    include: { carrier: { include: { contacts: true } }, user: { include: { teamMembership: true } } },
    orderBy: { nextStepAt: 'asc' },
  });
  const sequences = new Map((await prisma.emailSequence.findMany({
    where: { id: { in: [...new Set(enrollments.map((e) => e.sequenceId))] } },
    include: { steps: { orderBy: { order: 'asc' }, include: { template: true } }, owner: { select: { timezone: true } } },
  })).map((s) => [s.id, s]));
  const sentToday = new Map(); // sequenceId -> emails created today (counted once per tick, then incremented locally)
  const accountFor = new Map(); // userId -> mailbox | null
  let created = 0;

  for (const enr of enrollments) {
    if (pastDeadline(deadline)) break;
    const sequence = sequences.get(enr.sequenceId);
    const step = sequence?.steps[enr.currentStep];
    if (!sequence?.active || !step || step.type !== 'email') continue;
    // Switched to AI after the query ran: left due for the ai-sequence-email job (never rendered from the template here).
    if (isAiEmailStep(step)) continue;
    const carrier = enr.carrier;
    // Lease the step (compare-and-set on step and due time): the dialer's "send now" and a second scheduler skip it.
    const lease = await prisma.sequenceEnrollment.updateMany({
      where: { id: enr.id, status: 'active', currentStep: enr.currentStep, nextStepAt: enr.nextStepAt },
      data: { nextStepAt: new Date(now.getTime() + 10 * MIN) },
    });
    if (!lease.count) continue;
    const release = (at) => prisma.sequenceEnrollment.updateMany({ where: { id: enr.id, status: 'active', currentStep: enr.currentStep }, data: { nextStepAt: at } });
    try {
      const blocked = await blockedReason(enr.userId, carrier.email, carrier.id);
      if (blocked) {
        await logActivity(enr.user, { type: 'sequence', carrierId: carrier.id, summary: `Skipped sequence email to ${carrier.companyName}: ${blocked}` });
        await advanceFrom(enr, sequence, { now, expectedStep: enr.currentStep });
        continue;
      }
      if (!accountFor.has(enr.userId)) accountFor.set(enr.userId, await pickAccount(enr.userId));
      const account = accountFor.get(enr.userId);
      if (!account) {
        await noMailboxNotice(enr.userId);
        await release(new Date(now.getTime() + HOUR)); // stays due-ish, re-checked hourly, never blocks the batch
        continue;
      }

      if (!sentToday.has(sequence.id)) {
        sentToday.set(sequence.id, await prisma.email.count({ where: { enrollment: { sequenceId: sequence.id }, createdAt: { gte: sequenceDayStart(sequence, now) } } }));
      }
      if (sentToday.get(sequence.id) >= sequence.maxEmailsPerDay) {
        await release(nextCapWindow(sequence, carrier, now));
        continue;
      }

      const subject = step.subject || step.template?.subject || `Following up — ${carrier.companyName}`;
      const body = step.body || step.template?.body || '';
      if (!body.trim()) {
        await logActivity(enr.user, { type: 'sequence', carrierId: carrier.id, summary: `Sequence "${sequence.name}" email step has no content; skipped` });
        await advanceFrom(enr, sequence, { now, expectedStep: enr.currentStep });
        continue;
      }
      const rendered = renderContent({ subject, body, carrier, user: enr.user });
      if (await alreadySentStep(enr, sequence, rendered)) {
        if (await advanceFrom(enr, sequence, { now, expectedStep: enr.currentStep })) {
          await logActivity(enr.user, { type: 'sequence', carrierId: carrier.id, summary: `Skipped step ${enr.currentStep + 1} of "${sequence.name}" for ${carrier.companyName}: this email was already sent before the sequence was edited` });
        }
        continue;
      }
      // Create the email and move past the step atomically: either both happen or neither.
      const ok = await prisma.$transaction(async (tx) => {
        const moved = await advanceFrom(enr, sequence, { now, expectedStep: enr.currentStep, db: tx });
        if (!moved) return false;
        await tx.email.create({
          data: {
            userId: enr.userId, carrierId: carrier.id, enrollmentId: enr.id, templateId: step.templateId, emailAccountId: account.id,
            toEmail: carrier.email, subject: rendered.subject, body: rendered.body, status: 'scheduled', scheduledAt: now,
          },
        });
        return true;
      });
      if (ok) {
        created++;
        sentToday.set(sequence.id, sentToday.get(sequence.id) + 1);
      }
    } catch (err) {
      log('sequence', enr.id, err.message);
      await release(new Date(now.getTime() + 15 * MIN)).catch(() => {});
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// 3. Follow-up reminders (in-app; email only as the daily digest, see services/email/digest.js)
// ---------------------------------------------------------------------------

const reminderSelect = {
  id: true, userId: true, carrierId: true, dueAt: true, type: true, title: true, note: true, remindMinutesBefore: true,
  carrier: { select: { companyName: true } },
};

/** Reminders that are due now: overdue/at-due-time rows, plus early ones whose lead time has started. */
async function dueReminders(now, { includeLongLeads }) {
  const take = LIMITS.remindersPerPass;
  const atDue = await prisma.followUp.findMany({
    where: { status: 'pending', notifiedAt: null, dueAt: { lte: now } }, orderBy: { dueAt: 'asc' }, take, select: reminderSelect,
  });
  const early = [];
  for (const lead of REMIND_PRESETS) {
    if (!lead || (lead >= 240 && !includeLongLeads)) continue;
    // Index range (status, notifiedAt, dueAt) limited to the next `lead` minutes; exact per lead, so nothing is cut off.
    const rows = await prisma.followUp.findMany({
      where: { status: 'pending', notifiedAt: null, remindMinutesBefore: lead, dueAt: { gt: now, lte: new Date(now.getTime() + lead * MIN) } },
      orderBy: { dueAt: 'asc' }, take, select: reminderSelect,
    });
    early.push(...rows);
  }
  return [...atDue, ...early];
}

function reminderTitle(f, now) {
  const early = f.dueAt > now;
  const when = early ? ` in ${Math.max(1, Math.round((f.dueAt - now) / 60000))} min` : '';
  return `${early ? 'Coming up' : 'Follow-up due'}: ${f.carrier?.companyName || 'carrier'}${when}`;
}

async function followUpReminders(now, log, { budgetMs = LIMITS.reminderBudgetMs, longLeads = false } = {}) {
  const deadline = deadlineIn(budgetMs);
  const includeLongLeads = longLeads || Date.now() - lastLongLeadScan >= LONG_LEAD_EVERY_MS;
  if (includeLongLeads) lastLongLeadScan = Date.now();
  const due = await dueReminders(now, { includeLongLeads });
  if (!due.length) return 0;
  const byUser = new Map();
  for (const f of due) {
    if (!byUser.has(f.userId)) byUser.set(f.userId, []);
    byUser.get(f.userId).push(f);
  }
  const users = new Map((await prisma.user.findMany({
    where: { id: { in: [...byUser.keys()] } }, select: { id: true, status: true, notifyFollowUps: true, notifyInApp: true, notifyPush: true },
  })).map((u) => [u.id, u]));
  let handled = 0;
  for (const [userId, list] of byUser) {
    if (pastDeadline(deadline)) break;
    try {
      const u = users.get(userId);
      const wants = u && u.status === 'active' && u.notifyFollowUps && (u.notifyInApp || u.notifyPush);
      const ids = list.map((f) => f.id);
      // Mark first (compare-and-set on notifiedAt null) so a crash never repeats a reminder; count what we claimed.
      const claimed = await prisma.followUp.updateMany({ where: { id: { in: ids }, notifiedAt: null }, data: { notifiedAt: now } });
      // A user with a large backlog (e.g. an import) is drained with one write instead of occupying every tick.
      const backlog = await prisma.followUp.updateMany({ where: { userId, status: 'pending', notifiedAt: null, dueAt: { lte: now } }, data: { notifiedAt: now } });
      handled += claimed.count + backlog.count;
      if (!wants || !claimed.count) continue;
      const total = claimed.count + backlog.count;
      if (total <= 3) {
        for (const f of list) {
          await notify(userId, { type: 'follow_up_due', title: reminderTitle(f, now), body: f.note || f.title || `${f.type} follow-up`, link: '/app/follow-ups' });
        }
      } else {
        const names = [...new Set(list.map((f) => f.carrier?.companyName).filter(Boolean))].slice(0, 3);
        await notify(userId, {
          type: 'follow_up_due',
          title: `${total} follow-ups are due`,
          body: names.length ? `Including ${names.join(', ')}${total > names.length ? ' and others' : ''}.` : null,
          link: '/app/follow-ups?view=overdue',
        });
      }
      invalidateQueueCount(userId);
    } catch (err) {
      log('follow-up', userId, err.message);
    }
  }
  return handled;
}

// ---------------------------------------------------------------------------
// Slow jobs
// ---------------------------------------------------------------------------

/**
 * Knowledge documents left in 'processing' (the upload request that ingests them died). The cutoff is well above the
 * PDF time limit plus embedding time, so an upload that is still ingesting is never raced, and each document is
 * claimed with a compare-and-set on updatedAt, so two schedulers never ingest the same one.
 */
async function processKnowledge(now) {
  const pending = await prisma.aIKnowledgeDocument.findMany({
    where: { status: 'processing', updatedAt: { lt: new Date(now.getTime() - 5 * MIN) } }, take: 3, select: { id: true, updatedAt: true },
  });
  let n = 0;
  for (const d of pending) {
    const claimed = await prisma.aIKnowledgeDocument.updateMany({ where: { id: d.id, status: 'processing', updatedAt: d.updatedAt }, data: { updatedAt: new Date() } });
    if (!claimed.count) continue;
    await ingestDocument(d.id); // PDF parsing runs in a worker thread (services/ai/rag.js)
    n++;
  }
  return n;
}

function makeLog(quiet) {
  return (kind, id, msg) => !quiet && console.error(`[scheduler] ${kind} ${id}: ${msg}`);
}

async function timed(name, fn, log, stats) {
  const t = Date.now();
  try {
    return await fn();
  } catch (err) {
    log(name, '-', err.message);
    return { error: err.message };
  } finally {
    stats[name] = Date.now() - t;
  }
}

/**
 * Email and reminder work. Never waits for lead generation, ingestion or maintenance.
 * `longLeads` forces the check of reminders set 4 hours or more ahead (normally every few minutes).
 */
export async function runFastTick({ now = new Date(), quiet = false, longLeads = false } = {}) {
  if (fastRunning) return { skipped: true };
  fastRunning = true;
  const log = makeLog(quiet);
  const ms = {};
  try {
    const sequenceEmails = await timed('sequenceEmails', () => runSequenceEmailSteps(now, log), log, ms);
    const emails = await timed('emails', () => sendDueEmails(now, log), log, ms);
    const reminders = await timed('reminders', () => followUpReminders(now, log, { longLeads }), log, ms);
    return { sequenceEmails, emails, reminders, ms };
  } finally {
    fastRunning = false;
  }
}

let lastSweep = 0;
/** Lead generation, knowledge ingestion and maintenance jobs. */
export async function runSlowTick({ now = new Date(), quiet = false } = {}) {
  if (slowRunning) return { skipped: true };
  slowRunning = true;
  const log = makeLog(quiet);
  const ms = {};
  try {
    if (Date.now() - lastSweep > 6 * HOUR) {
      lastSweep = Date.now();
      await timed('sweep', () => sweepStaleEmailSteps(now), log, ms);
    }
    const knowledge = await timed('knowledge', () => processKnowledge(now), log, ms);
    const leadGenerators = await timed('leadGenerators', () => runDueGenerators(now, log), log, ms);
    // Maintenance jobs on their own schedules (each checks if it is due; at most 3 per tick).
    const maintenance = process.env.NODE_ENV === 'test' ? [] : await timed('maintenance', () => runMaintenance(now, log), log, ms);
    return { knowledge, leadGenerators, maintenance, ms };
  } finally {
    slowRunning = false;
  }
}

/**
 * One slow lane on its own: 'leads' (scheduled lead generators, crawls of up to 2 minutes each), 'maintenance'
 * (backups, cleanups and other jobs, most overdue first, up to 3 side by side) or 'priority' (check-call reminders,
 * the morning digest and reply detection). Returns { skipped } while the same lane is still busy.
 */
export async function runLaneTick(lane, { now = new Date(), quiet = false } = {}) {
  // The priority lane may overlap itself: a long reply-detection run must not hold back the digest or check calls,
  // and runMaintenance never starts a job that is still running. The other lanes run one tick at a time.
  const exclusive = lane !== 'priority';
  if (exclusive && laneRunning[lane]) return { skipped: true };
  if (exclusive) laneRunning[lane] = true;
  const log = makeLog(quiet);
  const ms = {};
  try {
    if (lane === 'leads') return { leadGenerators: await timed('leadGenerators', () => runDueGenerators(now, log), log, ms), ms };
    const maintenance = await timed(lane, () => runMaintenance(now, log, { lane: lane === 'priority' ? 'priority' : 'default', maxJobs: 3, concurrency: 3 }), log, ms);
    return { maintenance, ms };
  } finally {
    if (exclusive) laneRunning[lane] = false;
  }
}

/** Knowledge ingestion and the stale-step sweep (the slow-tick work that is not in a lane of its own). */
async function runHousekeepingTick({ now = new Date(), quiet = false } = {}) {
  if (slowRunning) return { skipped: true };
  slowRunning = true;
  const log = makeLog(quiet);
  const ms = {};
  try {
    if (Date.now() - lastSweep > 6 * HOUR) {
      lastSweep = Date.now();
      await timed('sweep', () => sweepStaleEmailSteps(now), log, ms);
    }
    return { knowledge: await timed('knowledge', () => processKnowledge(now), log, ms), ms };
  } finally {
    slowRunning = false;
  }
}

/** One pass of every job: the fast work first, then the slow work. Exported for tests and manual triggering. */
export async function runSchedulerTick({ now = new Date(), quiet = false } = {}) {
  try {
    const fast = await runFastTick({ now, quiet });
    if (fast.skipped) return { skipped: true };
    const slow = await runSlowTick({ now, quiet });
    return { ...fast, ...(slow.skipped ? {} : slow), ms: { ...fast.ms, ...slow.ms } };
  } catch (err) {
    makeLog(quiet)('tick', '-', err.message);
    return { error: err.message };
  }
}

export function startScheduler() {
  if (timer) return;
  console.log(`[scheduler] started (email/reminders every ${Math.round(TICK_MS / 1000)}s, other jobs every ${Math.round(SLOW_TICK_MS / 1000)}s)`);
  timer = setInterval(() => { runFastTick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
  slowTimer = setInterval(() => { runHousekeepingTick().catch(() => {}); }, SLOW_TICK_MS);
  slowTimer.unref?.();
  // Lanes: lead generation, maintenance and latency-sensitive jobs each on their own timer (see runLaneTick).
  laneTimers = ['leads', 'maintenance', 'priority'].map((lane) => {
    const t = setInterval(() => { runLaneTick(lane).catch(() => {}); }, lane === 'priority' ? Math.min(SLOW_TICK_MS, 30_000) : SLOW_TICK_MS);
    t.unref?.();
    return t;
  });
  setTimeout(() => { runFastTick().catch(() => {}); }, 5000).unref?.();
  setTimeout(() => { runHousekeepingTick().catch(() => {}); }, 15000).unref?.();
  setTimeout(() => { for (const lane of ['priority', 'maintenance', 'leads']) runLaneTick(lane).catch(() => {}); }, 20000).unref?.();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  if (slowTimer) clearInterval(slowTimer);
  for (const t of laneTimers) clearInterval(t);
  laneTimers = [];
  timer = null;
  slowTimer = null;
}
