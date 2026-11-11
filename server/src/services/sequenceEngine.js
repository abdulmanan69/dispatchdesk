import { prisma } from '../db.js';
import { nextBusinessTime, timezoneForState } from '../lib/timezones.js';
import { broadcast } from '../lib/broadcast.js';

/**
 * Sequence model
 * - Steps are ordered; step.dayOffset = days after enrollment start (UI shows "Day dayOffset+1").
 * - enrollment.currentStep is the index of the NEXT step to perform; nextStepAt is when it is due.
 * - Call/task steps surface in the daily call queue; the user performs them (no auto-dialing).
 * - Email steps are executed by the scheduler only when a mailbox is connected and the carrier may be emailed.
 * - Every step change is a compare-and-set on (id, status 'active', currentStep), so two writers (the scheduler and
 *   a user in another process) can never both perform or skip the same step.
 */

export const carrierTz = (carrier) => carrier?.timezone || timezoneForState(carrier?.state) || null;

/**
 * Email steps written by AI (SequenceStep.aiMode): 'auto' = AI writes and sends, 'review' = AI writes, the user
 * approves. They are written by jobs/extra/ai-sequence-email.js (AI calls take seconds), never by the scheduler's
 * fast loop. null/'off' = the step's template, as before.
 */
export const AI_STEP_MODES = ['auto', 'review'];
export const isAiEmailStep = (step) => step?.type === 'email' && AI_STEP_MODES.includes(step?.aiMode);
/**
 * Start of Email.error on a 'review' email whose body is still the step's brief (the AI could not write it): it must
 * be rewritten before it can be approved (routes/email.js).
 */
export const AI_NOTE_PREFIX = 'AI could not write this email';

export function stepDueAt(sequence, step, startedAt, carrier, notBefore = new Date()) {
  let due = new Date(new Date(startedAt).getTime() + step.dayOffset * 86400000);
  if (due < notBefore) due = new Date(notBefore);
  if (sequence.respectBusinessHours) {
    due = nextBusinessTime(carrierTz(carrier), due, sequence.windowStartHour, sequence.windowEndHour, sequence.skipWeekends);
  }
  return due;
}

/**
 * The sidebar queue badge caches counts per user for 60 s (routes/prospecting.js). Call this after any write that
 * changes a user's due steps or follow-ups; it clears the cache in every process.
 */
export function invalidateQueueCount(userId) {
  if (userId) broadcast('queue-count', { userId });
}

async function loadSequence(sequenceId, db = prisma) {
  return db.emailSequence.findUnique({ where: { id: sequenceId }, include: { steps: { orderBy: { order: 'asc' } } } });
}

/** Carriers enrolled per transaction: keeps each SQLite write lock short when a caller passes up to 1,000. */
export const ENROLL_BATCH = 200;

/**
 * Enroll carriers (already access-checked) into a sequence. Skips carriers already enrolled (and repeated ids).
 * Per batch of ENROLL_BATCH carriers: one read of their existing enrollments, then one transaction with every write
 * (restarts, new enrollments, the lead/prospecting -> sequence stage move and the timeline entries) instead of three
 * or four statements per carrier. The event loop gets a turn between batches.
 */
export async function enrollCarriers(user, sequenceId, carriers) {
  const sequence = await loadSequence(sequenceId);
  if (!sequence || !sequence.steps.length) return { enrolled: 0, skipped: carriers.length, reason: 'Sequence has no steps' };
  const stages = await prisma.pipelineStage.findMany({ select: { id: true, key: true } });
  const sequenceStage = stages.find((s) => s.key === 'sequence');
  const earlyStageIds = stages.filter((s) => ['lead', 'prospecting'].includes(s.key)).map((s) => s.id);
  const teamId = user.teamMembership !== undefined
    ? user.teamMembership?.teamId ?? null
    : (await prisma.teamMember.findUnique({ where: { userId: user.id }, select: { teamId: true } }))?.teamId ?? null;
  const now = new Date();
  const seen = new Set();
  let enrolled = 0;
  let skipped = 0;
  for (let i = 0; i < carriers.length; i += ENROLL_BATCH) {
    if (i) await new Promise((resolve) => setImmediate(resolve));
    const part = [];
    for (const c of carriers.slice(i, i + ENROLL_BATCH)) {
      if (seen.has(c.id)) skipped++;
      else { seen.add(c.id); part.push(c); }
    }
    if (!part.length) continue;
    const existing = await prisma.sequenceEnrollment.findMany({
      where: { sequenceId, carrierId: { in: part.map((c) => c.id) } }, select: { carrierId: true, status: true, id: true },
    });
    const byCarrier = new Map(existing.map((e) => [e.carrierId, e]));
    const restarts = [];
    const creates = [];
    const moveIds = [];
    const activities = [];
    for (const carrier of part) {
      const prev = byCarrier.get(carrier.id);
      if (prev && prev.status === 'active') { skipped++; continue; }
      const nextStepAt = stepDueAt(sequence, sequence.steps[0], now, carrier, now);
      if (prev) {
        // updateMany: never throws when the row was deleted meanwhile, and never resets one that became active again.
        restarts.push(prisma.sequenceEnrollment.updateMany({
          where: { id: prev.id, status: { not: 'active' } },
          data: { status: 'active', currentStep: 0, nextStepAt, startedAt: now, completedAt: null, stopReason: null, userId: user.id },
        }));
      } else {
        creates.push({ sequenceId, carrierId: carrier.id, userId: user.id, nextStepAt, startedAt: now });
      }
      if (sequenceStage && earlyStageIds.includes(carrier.stageId)) moveIds.push(carrier.id);
      activities.push({ userId: user.id, teamId, carrierId: carrier.id, type: 'sequence', summary: `Enrolled ${carrier.companyName} in sequence "${sequence.name}"`.slice(0, 500) });
    }
    if (!activities.length) continue;
    await prisma.$transaction([
      ...restarts,
      ...(creates.length ? [prisma.sequenceEnrollment.createMany({ data: creates })] : []),
      // Only carriers still in an early stage move (the stage may have changed since the caller loaded them).
      ...(moveIds.length ? [prisma.carrier.updateMany({
        where: { id: { in: moveIds }, stageId: { in: earlyStageIds } }, data: { stageId: sequenceStage.id, stageChangedAt: now },
      })] : []),
      prisma.activity.createMany({ data: activities }),
    ]);
    enrolled += activities.length;
  }
  if (enrolled) invalidateQueueCount(user.id);
  return { enrolled, skipped };
}

/**
 * Write the move past step `expectedStep` with a compare-and-set. Returns the updated row, or null when the
 * enrollment is no longer active on that step (someone else already moved it).
 * `sequence` must include its ordered steps; `carrier` needs state/timezone. `db` may be a transaction client.
 */
export async function advanceFrom(enr, sequence, { now = new Date(), expectedStep = enr.currentStep, carrier = enr.carrier, db = prisma } = {}) {
  const nextIndex = expectedStep + 1;
  const done = nextIndex >= sequence.steps.length;
  const data = done
    ? { currentStep: nextIndex, status: 'completed', completedAt: now, nextStepAt: null }
    : { currentStep: nextIndex, nextStepAt: stepDueAt(sequence, sequence.steps[nextIndex], enr.startedAt, carrier, now) };
  const res = await db.sequenceEnrollment.updateMany({ where: { id: enr.id, status: 'active', currentStep: expectedStep }, data });
  if (!res.count) return null;
  invalidateQueueCount(enr.userId);
  return { ...enr, ...data };
}

/**
 * Advance an enrollment past its current step. Completes it when no steps remain.
 * Pass `expectedStep` (the step the caller acted on) to make the move conditional: when the enrollment already moved,
 * nothing is written and null is returned.
 */
export async function advanceEnrollment(enrollmentId, { now = new Date(), expectedStep } = {}) {
  const enr = await prisma.sequenceEnrollment.findUnique({ where: { id: enrollmentId }, include: { carrier: { select: { id: true, state: true, timezone: true } } } });
  if (!enr || enr.status !== 'active') return expectedStep === undefined ? enr : null;
  const step = expectedStep ?? enr.currentStep;
  if (step !== enr.currentStep) return null;
  const sequence = await loadSequence(enr.sequenceId);
  return advanceFrom(enr, sequence, { now, expectedStep: step });
}

export async function stopEnrollments(carrierId, reason) {
  const rows = await prisma.sequenceEnrollment.findMany({ where: { carrierId, status: { in: ['active', 'paused'] } }, select: { userId: true } });
  const res = await prisma.sequenceEnrollment.updateMany({
    where: { carrierId, status: { in: ['active', 'paused'] } },
    data: { status: 'stopped', stopReason: reason, nextStepAt: null },
  });
  for (const uid of new Set(rows.map((r) => r.userId))) invalidateQueueCount(uid);
  return res;
}

/**
 * After a call is logged, advance the carrier's active enrollment if its current step is a call.
 * Terminal outcomes stop the sequence:
 * - do_not_call stops active and paused enrollments (logCall has usually done it already in its transaction);
 * - wrong_number stops enrollments that still have call or text steps ahead, instead of advancing into steps that
 *   would use the same bad number. Email-only remainders keep running.
 */
export async function onCallLogged(carrierId, outcome) {
  if (outcome === 'do_not_call') {
    await stopEnrollments(carrierId, 'do_not_call');
    return;
  }
  if (outcome === 'wrong_number') {
    const live = await prisma.sequenceEnrollment.findMany({
      where: { carrierId, status: 'active' },
      select: { id: true, userId: true, currentStep: true, sequence: { select: { steps: { select: { type: true, order: true }, orderBy: { order: 'asc' } } } } },
    });
    const usesPhone = live.filter((e) => e.sequence.steps.slice(e.currentStep).some((s) => s.type === 'call' || s.type === 'text'));
    if (usesPhone.length) {
      await prisma.sequenceEnrollment.updateMany({
        where: { id: { in: usesPhone.map((e) => e.id) }, status: 'active' },
        data: { status: 'stopped', stopReason: 'wrong_number', nextStepAt: null },
      });
      for (const uid of new Set(usesPhone.map((e) => e.userId))) invalidateQueueCount(uid);
    }
    return;
  }
  if (['not_interested', 'converted', 'interested'].includes(outcome)) {
    const reason = outcome === 'not_interested' ? 'not_interested' : 'replied_interested';
    const rows = await prisma.sequenceEnrollment.findMany({ where: { carrierId, status: 'active' }, select: { userId: true } });
    await prisma.sequenceEnrollment.updateMany({
      where: { carrierId, status: 'active' },
      data: outcome === 'not_interested'
        ? { status: 'stopped', stopReason: reason, nextStepAt: null }
        : { status: 'completed', completedAt: new Date(), stopReason: reason, nextStepAt: null },
    });
    for (const uid of new Set(rows.map((r) => r.userId))) invalidateQueueCount(uid);
    return;
  }
  const active = await prisma.sequenceEnrollment.findMany({
    where: { carrierId, status: 'active' },
    include: { sequence: { include: { steps: { orderBy: { order: 'asc' } } } }, carrier: { select: { id: true, state: true, timezone: true } } },
  });
  for (const enr of active) {
    const step = enr.sequence.steps[enr.currentStep];
    if (step && (step.type === 'call' || step.type === 'task')) await advanceFrom(enr, enr.sequence, { expectedStep: enr.currentStep });
  }
}

/** Current step object for an enrollment (with its sequence loaded). */
export function currentStep(enrollment) {
  return enrollment.sequence?.steps?.[enrollment.currentStep] ?? null;
}
