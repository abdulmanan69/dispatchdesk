import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { parse, z, reqStr, optStr, clean } from '../lib/validate.js';
import { assertLimit } from '../lib/plans.js';
import { STAGE_KEYS, CALL_OUTCOMES } from '../lib/constants.js';
import { requirePermission } from '../middleware/auth.js';
import { AUTOMATION_TRIGGERS, AUTOMATION_ACTIONS } from '../services/automation.js';

const r = Router();
r.use(requirePermission('automation.use'));

const schema = z.object({
  name: reqStr(120),
  trigger: z.enum(AUTOMATION_TRIGGERS),
  triggerValue: optStr(60),
  action: z.enum(AUTOMATION_ACTIONS),
  actionValue: optStr(500),
  delayDays: z.coerce.number().int().min(0).max(365).default(0),
  active: z.boolean().default(true),
});

/** Validate trigger/action values against the user's own data. */
async function validate(userId, a) {
  if (a.trigger === 'stage_changed' && a.triggerValue && !STAGE_KEYS.includes(a.triggerValue)) throw badRequest('Unknown stage for trigger');
  if (a.trigger === 'call_outcome' && a.triggerValue && !CALL_OUTCOMES.includes(a.triggerValue)) throw badRequest('Unknown call outcome for trigger');
  if (a.trigger === 'carrier_created' && a.triggerValue) a.triggerValue = null;
  switch (a.action) {
    case 'move_stage':
      if (!STAGE_KEYS.includes(a.actionValue || '')) throw badRequest('Choose a stage to move to');
      if (a.trigger === 'stage_changed' && a.triggerValue === a.actionValue) throw badRequest('Trigger stage and target stage are the same');
      break;
    case 'enroll_sequence': {
      const seq = await prisma.emailSequence.findFirst({ where: { id: a.actionValue || '', ownerId: userId } });
      if (!seq) throw badRequest('Choose one of your sequences');
      break;
    }
    case 'add_tag':
      if (!a.actionValue?.trim()) throw badRequest('Enter a tag name');
      if (a.actionValue.length > 40) throw badRequest('Tag names are limited to 40 characters');
      break;
    case 'notify':
      if (!a.actionValue?.trim()) throw badRequest('Enter the notification text');
      break;
    default:
      break;
  }
  return a;
}

r.get('/', ah(async (req, res) => {
  const items = await prisma.automation.findMany({ where: { ownerId: req.user.id }, orderBy: { createdAt: 'desc' } });
  const seqIds = items.filter((i) => i.action === 'enroll_sequence').map((i) => i.actionValue);
  const seqs = seqIds.length ? await prisma.emailSequence.findMany({ where: { id: { in: seqIds } }, select: { id: true, name: true } }) : [];
  const names = Object.fromEntries(seqs.map((s) => [s.id, s.name]));
  res.json({
    items: items.map((i) => ({ ...i, actionLabel: i.action === 'enroll_sequence' ? names[i.actionValue] || '(deleted sequence)' : i.actionValue })),
    triggers: AUTOMATION_TRIGGERS, actions: AUTOMATION_ACTIONS,
  });
}));

r.post('/', ah(async (req, res) => {
  const b = await validate(req.user.id, parse(schema, req.body));
  await assertLimit(req.user, 'automations');
  const row = await prisma.automation.create({ data: { ...b, ownerId: req.user.id } });
  res.status(201).json({ automation: row });
}));

async function own(req) {
  const a = await prisma.automation.findFirst({ where: { id: String(req.params.id), ownerId: req.user.id } });
  if (!a) throw notFound('Automation not found');
  return a;
}

r.patch('/:id', ah(async (req, res) => {
  const a = await own(req);
  const b = parse(schema.partial(), req.body);
  const merged = await validate(req.user.id, { ...a, ...clean(b) });
  const row = await prisma.automation.update({
    where: { id: a.id },
    data: clean({ name: merged.name, trigger: merged.trigger, triggerValue: merged.triggerValue, action: merged.action, actionValue: merged.actionValue, delayDays: merged.delayDays, active: merged.active }),
  });
  res.json({ automation: row });
}));

r.delete('/:id', ah(async (req, res) => {
  const a = await own(req);
  await prisma.automation.delete({ where: { id: a.id } });
  res.json({ ok: true });
}));

export default r;
