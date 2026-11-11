import { prisma } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { STAGE_KEYS } from '../lib/constants.js';
import { logActivity } from '../lib/activity.js';
import { runAutomations } from './automation.js';

let stageCache = null;
export async function stages() {
  if (!stageCache) stageCache = await prisma.pipelineStage.findMany({ orderBy: { sortOrder: 'asc' } });
  return stageCache;
}
export async function stageByKey(key) {
  const s = (await stages()).find((x) => x.key === key);
  if (!s) throw badRequest(`Unknown pipeline stage "${key}"`);
  return s;
}
export async function stageById(id) {
  return (await stages()).find((x) => x.id === id);
}

/**
 * Move a carrier to a pipeline stage and apply the stage's side effects:
 * - opportunity/trial: ensure an Opportunity row exists (status open/trial)
 * - customer: ensure a Customer row exists and mark the opportunity won
 * - archived: stop active sequence enrollments
 * The caller must already have verified write access to the carrier.
 */
export async function changeStage(user, carrier, stageKey, { depth = 0, reason } = {}) {
  if (!STAGE_KEYS.includes(stageKey)) throw badRequest(`Unknown pipeline stage "${stageKey}"`);
  const target = await stageByKey(stageKey);
  const from = await stageById(carrier.stageId);
  const now = new Date();

  if (carrier.stageId !== target.id) {
    await prisma.carrier.update({ where: { id: carrier.id }, data: { stageId: target.id, stageChangedAt: now } });
  }

  if (stageKey === 'opportunity' || stageKey === 'trial') {
    await prisma.opportunity.upsert({
      where: { carrierId: carrier.id },
      create: {
        carrierId: carrier.id, ownerId: carrier.ownerId,
        status: stageKey === 'trial' ? 'trial' : 'open',
        trialStartedAt: stageKey === 'trial' ? now : null,
        probability: stageKey === 'trial' ? 60 : 25,
      },
      update: stageKey === 'trial' ? { status: 'trial', trialStartedAt: now, probability: 60 } : { status: 'open', closedAt: null },
    });
  }
  if (stageKey === 'customer') {
    const opp = await prisma.opportunity.findUnique({ where: { carrierId: carrier.id } });
    if (opp && opp.status !== 'won') await prisma.opportunity.update({ where: { id: opp.id }, data: { status: 'won', closedAt: now, probability: 100 } });
    await prisma.customer.upsert({
      where: { carrierId: carrier.id },
      create: { carrierId: carrier.id, ownerId: carrier.ownerId, dispatchFeePercent: opp?.dispatchFeePercent ?? null, signedAt: now },
      update: { status: 'active' },
    });
    // A signed carrier is a truck on the fleet map (Carrier.isFleet drives the indexed fleet query).
    if (!carrier.isFleet) await prisma.carrier.update({ where: { id: carrier.id }, data: { isFleet: true } });
  }
  if (stageKey === 'archived') {
    await prisma.sequenceEnrollment.updateMany({
      where: { carrierId: carrier.id, status: { in: ['active', 'paused'] } },
      data: { status: 'stopped', stopReason: 'archived', nextStepAt: null },
    });
  }

  if (carrier.stageId !== target.id) {
    await logActivity(user, {
      type: 'stage_change', carrierId: carrier.id,
      summary: `Moved ${carrier.companyName} from ${from?.name ?? 'unknown'} to ${target.name}${reason ? ` (${reason})` : ''}`,
      metadata: { from: from?.key, to: target.key },
    });
    await runAutomations(user, 'stage_changed', { carrier: { ...carrier, stageId: target.id }, value: stageKey, depth });
  }
  return target;
}
