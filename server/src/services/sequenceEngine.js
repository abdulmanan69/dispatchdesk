import { prisma } from '../db.js';
import { nextBusinessTime, timezoneForState } from '../lib/timezones.js';
import { logActivity } from '../lib/activity.js';

/**
 * Sequence model
 * - Steps are ordered; step.dayOffset = days after enrollment start (UI shows "Day dayOffset+1").
 * - enrollment.currentStep is the index of the NEXT step to perform; nextStepAt is when it is due.
 * - Call/task steps surface in the daily call queue; the user performs them (no auto-dialing).
 * - Email steps are executed by the scheduler only when a mailbox is connected and the carrier may be emailed.
 */

export const carrierTz = (carrier) => carrier?.timezone || timezoneForState(carrier?.state) || null;

export function stepDueAt(sequence, step, startedAt, carrier, notBefore = new Date()) {
  let due = new Date(new Date(startedAt).getTime() + step.dayOffset * 86400000);
  if (due < notBefore) due = new Date(notBefore);
  if (sequence.respectBusinessHours) {
    due = nextBusinessTime(carrierTz(carrier), due, sequence.windowStartHour, sequence.windowEndHour, sequence.skipWeekends);
  }
  return due;
}

async function loadSequence(sequenceId) {
  return prisma.emailSequence.findUnique({ where: { id: sequenceId }, include: { steps: { orderBy: { order: 'asc' } } } });
}

/** Enroll carriers (already access-checked) into a sequence. Skips carriers already enrolled. */
export async function enrollCarriers(user, sequenceId, carriers) {
  const sequence = await loadSequence(sequenceId);
  if (!sequence || !sequence.steps.length) return { enrolled: 0, skipped: carriers.length, reason: 'Sequence has no steps' };
  const existing = await prisma.sequenceEnrollment.findMany({
    where: { sequenceId, carrierId: { in: carriers.map((c) => c.id) } }, select: { carrierId: true, status: true, id: true },
  });
  const byCarrier = new Map(existing.map((e) => [e.carrierId, e]));
  const sequenceStage = await prisma.pipelineStage.findUnique({ where: { key: 'sequence' } });
  let enrolled = 0;
  let skipped = 0;
  const now = new Date();
  for (const carrier of carriers) {
    const prev = byCarrier.get(carrier.id);
    if (prev && prev.status === 'active') { skipped++; continue; }
    const nextStepAt = stepDueAt(sequence, sequence.steps[0], now, carrier, now);
    if (prev) {
      await prisma.sequenceEnrollment.update({
        where: { id: prev.id },
        data: { status: 'active', currentStep: 0, nextStepAt, startedAt: now, completedAt: null, stopReason: null, userId: user.id },
      });
    } else {
      await prisma.sequenceEnrollment.create({ data: { sequenceId, carrierId: carrier.id, userId: user.id, nextStepAt, startedAt: now } });
    }
    const stage = await prisma.pipelineStage.findUnique({ where: { id: carrier.stageId } });
    if (stage && ['lead', 'prospecting'].includes(stage.key)) {
      await prisma.carrier.update({ where: { id: carrier.id }, data: { stageId: sequenceStage.id, stageChangedAt: now } });
    }
    await logActivity(user, { type: 'sequence', carrierId: carrier.id, summary: `Enrolled ${carrier.companyName} in sequence "${sequence.name}"` });
    enrolled++;
  }
  return { enrolled, skipped };
}

/** Advance an enrollment past its current step. Completes it when no steps remain. */
export async function advanceEnrollment(enrollmentId, { now = new Date() } = {}) {
  const enr = await prisma.sequenceEnrollment.findUnique({ where: { id: enrollmentId }, include: { carrier: true } });
  if (!enr || enr.status !== 'active') return enr;
  const sequence = await loadSequence(enr.sequenceId);
  const nextIndex = enr.currentStep + 1;
  if (nextIndex >= sequence.steps.length) {
    return prisma.sequenceEnrollment.update({
      where: { id: enr.id }, data: { currentStep: nextIndex, status: 'completed', completedAt: now, nextStepAt: null },
    });
  }
  const nextStepAt = stepDueAt(sequence, sequence.steps[nextIndex], enr.startedAt, enr.carrier, now);
  return prisma.sequenceEnrollment.update({ where: { id: enr.id }, data: { currentStep: nextIndex, nextStepAt } });
}

export async function stopEnrollments(carrierId, reason) {
  return prisma.sequenceEnrollment.updateMany({
    where: { carrierId, status: { in: ['active', 'paused'] } },
    data: { status: 'stopped', stopReason: reason, nextStepAt: null },
  });
}

/**
 * After a call is logged, advance the carrier's active enrollment if its current step is a call.
 * Terminal outcomes stop the sequence.
 */
export async function onCallLogged(carrierId, outcome) {
  if (['not_interested', 'converted', 'interested'].includes(outcome)) {
    const reason = outcome === 'not_interested' ? 'not_interested' : 'replied_interested';
    await prisma.sequenceEnrollment.updateMany({
      where: { carrierId, status: 'active' },
      data: outcome === 'not_interested'
        ? { status: 'stopped', stopReason: reason, nextStepAt: null }
        : { status: 'completed', completedAt: new Date(), stopReason: reason, nextStepAt: null },
    });
    return;
  }
  const active = await prisma.sequenceEnrollment.findMany({ where: { carrierId, status: 'active' }, include: { sequence: { include: { steps: { orderBy: { order: 'asc' } } } } } });
  for (const enr of active) {
    const step = enr.sequence.steps[enr.currentStep];
    if (step && (step.type === 'call' || step.type === 'task')) await advanceEnrollment(enr.id);
  }
}

/** Current step object for an enrollment (with its sequence loaded). */
export function currentStep(enrollment) {
  return enrollment.sequence?.steps?.[enrollment.currentStep] ?? null;
}
