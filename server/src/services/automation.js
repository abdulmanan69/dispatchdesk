import { prisma } from '../db.js';
import { notify, logActivity } from '../lib/activity.js';

export const AUTOMATION_TRIGGERS = ['carrier_created', 'stage_changed', 'call_outcome'];
export const AUTOMATION_ACTIONS = ['create_follow_up', 'enroll_sequence', 'move_stage', 'add_tag', 'notify'];

/**
 * Execute the carrier owner's active automations matching a trigger.
 * Automations belong to the carrier owner, so team leads acting on a member's
 * carrier trigger the member's rules. depth guards against move_stage loops.
 * Failures are logged and never break the originating request.
 */
export async function runAutomations(user, trigger, { carrier, value = null, depth = 0 }) {
  if (!carrier || depth > 2) return [];
  let rules;
  try {
    rules = await prisma.automation.findMany({
      where: { ownerId: carrier.ownerId, trigger, active: true, OR: [{ triggerValue: null }, { triggerValue: '' }, { triggerValue: value ?? '' }] },
    });
  } catch (err) {
    console.error('[automation] load failed', err.message);
    return [];
  }
  const results = [];
  for (const rule of rules) {
    try {
      await execute(user, rule, carrier, depth);
      await prisma.automation.update({ where: { id: rule.id }, data: { runCount: { increment: 1 }, lastRunAt: new Date() } });
      results.push({ id: rule.id, ok: true });
    } catch (err) {
      console.error('[automation] rule failed', rule.id, err.message);
      results.push({ id: rule.id, ok: false, error: err.message });
    }
  }
  return results;
}

async function execute(user, rule, carrier, depth) {
  const due = new Date(Date.now() + (rule.delayDays || 0) * 86400000);
  switch (rule.action) {
    case 'create_follow_up': {
      await prisma.followUp.create({ data: { carrierId: carrier.id, userId: carrier.assignedToId || carrier.ownerId, dueAt: due, type: 'call', note: rule.actionValue || `Automation: ${rule.name}` } });
      await prisma.carrier.update({ where: { id: carrier.id }, data: { nextFollowUpAt: due } });
      break;
    }
    case 'enroll_sequence': {
      const seq = await prisma.emailSequence.findFirst({ where: { id: rule.actionValue || '', ownerId: carrier.ownerId } });
      if (!seq) throw new Error('Sequence not found');
      const { enrollCarriers } = await import('./sequenceEngine.js');
      const fresh = await prisma.carrier.findUnique({ where: { id: carrier.id } });
      await enrollCarriers({ ...user, id: carrier.ownerId }, seq.id, [fresh]);
      break;
    }
    case 'move_stage': {
      const { changeStage } = await import('./pipeline.js');
      const fresh = await prisma.carrier.findUnique({ where: { id: carrier.id } });
      await changeStage(user, fresh, rule.actionValue, { depth: depth + 1, reason: `automation "${rule.name}"` });
      break;
    }
    case 'add_tag': {
      const name = (rule.actionValue || '').trim().slice(0, 40);
      if (!name) throw new Error('Tag name missing');
      const tag = await prisma.tag.upsert({ where: { ownerId_name: { ownerId: carrier.ownerId, name } }, create: { ownerId: carrier.ownerId, name }, update: {} });
      await prisma.carrierTag.upsert({ where: { carrierId_tagId: { carrierId: carrier.id, tagId: tag.id } }, create: { carrierId: carrier.id, tagId: tag.id }, update: {} });
      break;
    }
    case 'notify': {
      await notify(carrier.ownerId, { type: 'automation', title: rule.actionValue || rule.name, body: `${carrier.companyName}`, link: `/app/carriers/${carrier.id}` });
      break;
    }
    default:
      throw new Error(`Unknown action ${rule.action}`);
  }
  await logActivity({ ...user, id: carrier.ownerId, teamMembership: undefined }, { type: 'automation', carrierId: carrier.id, summary: `Automation "${rule.name}" ran (${rule.action.replace('_', ' ')})` });
}
