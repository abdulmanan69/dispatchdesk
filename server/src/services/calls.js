import { prisma } from '../db.js';
import { logActivity } from '../lib/activity.js';
import { badRequest } from '../lib/errors.js';
import { nextBusinessTime, timezoneForState } from '../lib/timezones.js';
import { changeStage, stageById } from './pipeline.js';
import { onCallLogged, invalidateQueueCount } from './sequenceEngine.js';
import { runAutomations } from './automation.js';
import { label } from './carriers/labels.js';
import { completeFollowUp } from '../routes/followups.js';

const EARLY_STAGES = ['lead', 'prospecting', 'sequence'];
// Outcomes that say nothing about the carrier's interest: no "first call" stage move.
const NO_CONTACT_OUTCOMES = ['wrong_number', 'do_not_call'];

/**
 * The carrier asked not to be called again. In one transaction: turn on do-not-call, stop its active and paused
 * sequences and cancel its pending call and text follow-ups (a recurring call follow-up must not schedule a next one).
 */
async function applyDoNotCall(user, carrier, now) {
  const affected = await prisma.sequenceEnrollment.findMany({
    where: { carrierId: carrier.id, status: { in: ['active', 'paused'] } }, select: { userId: true },
  });
  await prisma.$transaction([
    prisma.carrier.update({ where: { id: carrier.id }, data: { doNotCall: true } }),
    prisma.sequenceEnrollment.updateMany({
      where: { carrierId: carrier.id, status: { in: ['active', 'paused'] } },
      data: { status: 'stopped', stopReason: 'do_not_call', nextStepAt: null },
    }),
    prisma.followUp.updateMany({
      where: { carrierId: carrier.id, status: 'pending', type: { in: ['call', 'text'] } },
      data: { status: 'canceled' },
    }),
  ]);
  for (const uid of new Set([user.id, ...affected.map((r) => r.userId)])) invalidateQueueCount(uid);
  await logActivity(user, {
    type: 'note', carrierId: carrier.id,
    summary: `Do-not-call requested on a call at ${now.toISOString()}`,
    metadata: { doNotCall: true, source: 'call' },
  });
}

/**
 * Record a call and apply its consequences: activity, satisfied follow-ups, next-step follow-up,
 * sequence advancement, pipeline movement and automations. Used by POST /api/calls and by the
 * telephony bridge when an unanswered call is logged automatically.
 * The caller must have verified write access to `carrier`.
 * Outcome 'do_not_call' turns on do-not-call, stops sequences and cancels call/text follow-ups; the result then
 * carries doNotCall: true so the client does not apply it again.
 */
export async function logCall(user, carrier, body, { attempt = null } = {}) {
  const now = new Date();
  const tz = carrier.timezone || timezoneForState(carrier.state);
  const durationSec = body.durationSec ?? attempt?.durationSec ?? null;

  const call = await prisma.call.create({
    data: {
      carrierId: carrier.id, userId: user.id, outcome: body.outcome, notes: body.notes ?? null,
      durationSec, calledAt: attempt?.createdAt ?? now, provider: attempt?.provider ?? body.provider ?? null,
    },
  });
  if (attempt) {
    // Claim the telephony attempt atomically: the dispatcher's Save and Twilio's automatic log can race, and only one
    // of them may link a call to it. The loser removes its call before any other side effect.
    const claim = await prisma.callAttempt.updateMany({ where: { id: attempt.id, callId: null }, data: { callId: call.id } });
    if (claim.count === 0) {
      await prisma.call.delete({ where: { id: call.id } });
      throw badRequest('This call was already logged');
    }
  }
  await prisma.carrier.update({ where: { id: carrier.id }, data: { lastContactedAt: now } });
  await logActivity(user, {
    type: 'call', carrierId: carrier.id,
    summary: `Called ${carrier.companyName}: ${label(body.outcome)}${body.notes ? ` — ${body.notes.slice(0, 120)}` : ''}`,
    metadata: { outcome: body.outcome, callId: call.id, ...(attempt ? { provider: attempt.provider, automatic: !!body.automatic } : {}) },
  });
  const doNotCall = body.outcome === 'do_not_call';
  if (doNotCall) await applyDoNotCall(user, carrier, now);

  // Due call follow-ups for this carrier are satisfied by this call. They are completed one by one so recurring
  // follow-ups schedule their next occurrence (a weekly check-in must not end the first time the carrier is called).
  const satisfied = await prisma.followUp.findMany({
    where: { carrierId: carrier.id, userId: user.id, status: 'pending', type: 'call', dueAt: { lte: new Date(now.getTime() + 12 * 3600000) } },
    orderBy: { dueAt: 'asc' }, take: 20,
  });
  for (const fu of satisfied) {
    await completeFollowUp(user, fu, carrier, { outcome: label(body.outcome), quiet: true, sync: false, now }).catch((err) => {
      if (err.status !== 400) throw err; // 400 = already closed by someone else
    });
  }

  // Next step.
  const autoFollowUp = body.autoFollowUp ?? true;
  let followUp = null;
  let due = null;
  if (['no_answer', 'busy', 'voicemail'].includes(body.outcome) && autoFollowUp) {
    due = body.followUpAt || nextBusinessTime(tz, new Date(now.getTime() + 24 * 3600000), 9, 17, true);
  } else if (['call_back', 'follow_up', 'interested'].includes(body.outcome) && (autoFollowUp || body.followUpAt)) {
    due = body.followUpAt || nextBusinessTime(tz, new Date(now.getTime() + 24 * 3600000), 9, 17, true);
  }
  if (due) {
    followUp = await prisma.followUp.create({
      data: { carrierId: carrier.id, userId: user.id, dueAt: due, type: 'call', note: body.followUpNote || `${label(body.outcome)} — call again` },
    });
  }
  const nextPending = await prisma.followUp.findFirst({ where: { carrierId: carrier.id, status: 'pending' }, orderBy: { dueAt: 'asc' } });
  await prisma.carrier.update({ where: { id: carrier.id }, data: { nextFollowUpAt: nextPending?.dueAt ?? null } });

  await onCallLogged(carrier.id, body.outcome);
  invalidateQueueCount(user.id);

  // Pipeline movement.
  const current = await stageById(carrier.stageId);
  let stage = current;
  const fresh = await prisma.carrier.findUnique({ where: { id: carrier.id } });
  if (body.outcome === 'converted') stage = await changeStage(user, fresh, 'customer', { reason: 'call converted' });
  else if (body.outcome === 'interested' && EARLY_STAGES.includes(current.key)) stage = await changeStage(user, fresh, 'opportunity', { reason: 'interested on call' });
  else if (body.outcome === 'not_interested') {
    const tag = await prisma.tag.upsert({ where: { ownerId_name: { ownerId: carrier.ownerId, name: 'Not interested' } }, create: { ownerId: carrier.ownerId, name: 'Not interested', color: '#9ca3af' }, update: {} });
    await prisma.carrierTag.upsert({ where: { carrierId_tagId: { carrierId: carrier.id, tagId: tag.id } }, create: { carrierId: carrier.id, tagId: tag.id }, update: {} });
    if (body.archive) stage = await changeStage(user, fresh, 'archived', { reason: 'not interested' });
  } else if (current.key === 'lead' && !NO_CONTACT_OUTCOMES.includes(body.outcome)) stage = await changeStage(user, fresh, 'prospecting', { reason: 'first call' });

  await runAutomations(user, 'call_outcome', { carrier: { ...fresh, stageId: stage.id }, value: body.outcome });
  return { call, followUp, stage: { key: stage.key, name: stage.name }, doNotCall };
}
