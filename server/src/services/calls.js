import { prisma } from '../db.js';
import { logActivity } from '../lib/activity.js';
import { nextBusinessTime, timezoneForState } from '../lib/timezones.js';
import { changeStage, stageById } from './pipeline.js';
import { onCallLogged } from './sequenceEngine.js';
import { runAutomations } from './automation.js';
import { label } from './carriers/labels.js';

const EARLY_STAGES = ['lead', 'prospecting', 'sequence'];

/**
 * Record a call and apply its consequences: activity, satisfied follow-ups, next-step follow-up,
 * sequence advancement, pipeline movement and automations. Used by POST /api/calls and by the
 * telephony bridge when an unanswered call is logged automatically.
 * The caller must have verified write access to `carrier`.
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
  if (attempt) await prisma.callAttempt.update({ where: { id: attempt.id }, data: { callId: call.id } });
  await prisma.carrier.update({ where: { id: carrier.id }, data: { lastContactedAt: now } });
  await logActivity(user, {
    type: 'call', carrierId: carrier.id,
    summary: `Called ${carrier.companyName}: ${label(body.outcome)}${body.notes ? ` — ${body.notes.slice(0, 120)}` : ''}`,
    metadata: { outcome: body.outcome, callId: call.id, ...(attempt ? { provider: attempt.provider, automatic: !!body.automatic } : {}) },
  });

  // Due follow-ups for this carrier are satisfied by this call.
  await prisma.followUp.updateMany({
    where: { carrierId: carrier.id, userId: user.id, status: 'pending', dueAt: { lte: new Date(now.getTime() + 12 * 3600000) } },
    data: { status: 'done', completedAt: now },
  });

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
  } else if (current.key === 'lead') stage = await changeStage(user, fresh, 'prospecting', { reason: 'first call' });

  await runAutomations(user, 'call_outcome', { carrier: { ...fresh, stageId: stage.id }, value: body.outcome });
  return { call, followUp, stage: { key: stage.key, name: stage.name } };
}
