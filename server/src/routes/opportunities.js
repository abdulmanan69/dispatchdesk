import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, notFound, badRequest } from '../lib/errors.js';
import { parse, z, optStr, optInt, optNum, optDate, pageQuery, paginate, pageResult, clean } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { loadCarrier, ownerWhere } from '../lib/access.js';
import { OPPORTUNITY_STATUSES } from '../lib/constants.js';
import { logActivity } from '../lib/activity.js';
import { changeStage } from '../services/pipeline.js';

const r = Router();
r.use(requirePermission('crm.use'));

const carrierSelect = {
  id: true, companyName: true, mcNumber: true, dotNumber: true, phone: true, email: true, city: true, state: true,
  equipment: true, fleetSize: true, ownerId: true, assignedToId: true,
  stage: { select: { key: true, name: true, color: true } },
  assignedTo: { select: { id: true, name: true } },
};

const OPEN = ['open', 'negotiating', 'trial'];

async function loadOpp(user, id, write = false) {
  const opp = await prisma.opportunity.findUnique({ where: { id: String(id) } });
  if (!opp) throw notFound('Opportunity not found');
  const carrier = await loadCarrier(user, opp.carrierId, { write });
  return { opp, carrier };
}

r.get('/', ah(async (req, res) => {
  const q = parse(z.object({
    ...pageQuery,
    status: z.enum([...OPPORTUNITY_STATUSES, 'active', 'all']).default('active'),
    q: z.string().trim().max(100).optional(),
    scope: z.enum(['mine', 'team']).default('mine'),
    sort: z.enum(['value', 'followup', 'updated', 'probability', 'created']).default('updated'),
  }), req.query);
  const base = await ownerWhere(req.user, q.scope);
  const where = { ...base };
  if (q.status === 'active') where.status = { in: OPEN };
  else if (q.status !== 'all') where.status = q.status;
  if (q.q) where.carrier = { OR: [{ companyName: { contains: q.q } }, { mcNumber: { contains: q.q } }, { dotNumber: { contains: q.q } }] };
  const orderBy = {
    value: [{ estimatedValueCents: 'desc' }],
    followup: [{ nextFollowUpAt: 'asc' }],
    updated: [{ updatedAt: 'desc' }],
    probability: [{ probability: 'desc' }],
    created: [{ createdAt: 'desc' }],
  }[q.sort];
  const [items, total, all] = await Promise.all([
    prisma.opportunity.findMany({ where, orderBy, ...paginate(q), include: { carrier: { select: carrierSelect }, owner: { select: { id: true, name: true } } } }),
    prisma.opportunity.count({ where }),
    prisma.opportunity.findMany({ where: base, select: { status: true, estimatedValueCents: true, probability: true } }),
  ]);
  const byStatus = Object.fromEntries(OPPORTUNITY_STATUSES.map((s) => [s, 0]));
  let openValueCents = 0;
  let weightedValueCents = 0;
  for (const o of all) {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    if (OPEN.includes(o.status)) {
      openValueCents += o.estimatedValueCents;
      weightedValueCents += Math.round((o.estimatedValueCents * o.probability) / 100);
    }
  }
  const closed = byStatus.won + byStatus.lost;
  res.json({
    ...pageResult(items, total, q),
    summary: { byStatus, openCount: byStatus.open + byStatus.negotiating + byStatus.trial, openValueCents, weightedValueCents, winRate: closed ? Math.round((byStatus.won / closed) * 1000) / 10 : null },
  });
}));

r.get('/:id', ah(async (req, res) => {
  const { opp } = await loadOpp(req.user, req.params.id);
  const [carrier, calls, emails, activities, followUps] = await Promise.all([
    prisma.carrier.findUnique({ where: { id: opp.carrierId }, select: { ...carrierSelect, contacts: true, address: true, zip: true } }),
    prisma.call.findMany({ where: { carrierId: opp.carrierId }, orderBy: { calledAt: 'desc' }, take: 10, include: { user: { select: { name: true } } } }),
    prisma.email.findMany({ where: { carrierId: opp.carrierId, status: { in: ['sent', 'scheduled', 'failed'] } }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, subject: true, status: true, sentAt: true, createdAt: true, toEmail: true } }),
    prisma.activity.findMany({ where: { carrierId: opp.carrierId }, orderBy: { createdAt: 'desc' }, take: 15, include: { user: { select: { name: true } } } }),
    prisma.followUp.findMany({ where: { carrierId: opp.carrierId, status: 'pending' }, orderBy: { dueAt: 'asc' } }),
  ]);
  res.json({ opportunity: { ...opp, carrier }, calls, emails, activities, followUps });
}));

const fields = {
  estimatedValueCents: optInt(0, 1e10),
  dispatchFeePercent: optNum(0, 100),
  probability: optInt(0, 100),
  nextFollowUpAt: optDate,
  notes: optStr(5000),
};

r.post('/', ah(async (req, res) => {
  const body = parse(z.object({ carrierId: z.string().min(1), ...fields }), req.body);
  const carrier = await loadCarrier(req.user, body.carrierId, { write: true });
  const existing = await prisma.opportunity.findUnique({ where: { carrierId: carrier.id } });
  if (existing && OPEN.includes(existing.status)) throw badRequest('This carrier already has an open opportunity');
  await changeStage(req.user, carrier, 'opportunity');
  const data = clean({ ...body, carrierId: undefined, status: 'open', closedAt: null, lostReason: null });
  if (data.estimatedValueCents === null) data.estimatedValueCents = 0;
  if (data.probability === null) delete data.probability;
  const opp = await prisma.opportunity.update({ where: { carrierId: carrier.id }, data });
  if (body.nextFollowUpAt) await prisma.carrier.update({ where: { id: carrier.id }, data: { nextFollowUpAt: body.nextFollowUpAt } });
  await logActivity(req.user, { type: 'opportunity', carrierId: carrier.id, summary: `Opened opportunity with ${carrier.companyName}` });
  res.status(201).json({ opportunity: opp });
}));

r.patch('/:id', ah(async (req, res) => {
  const { opp, carrier } = await loadOpp(req.user, req.params.id, true);
  const body = parse(z.object({ ...fields, status: z.enum(OPPORTUNITY_STATUSES).optional(), lostReason: optStr(500), archive: z.boolean().optional() }), req.body);
  const { archive, ...rest } = body;
  const data = clean(rest);
  if (data.estimatedValueCents === null) data.estimatedValueCents = 0;
  if (data.probability === null) delete data.probability;

  if (body.status && body.status !== opp.status) {
    if (body.status === 'won') {
      await changeStage(req.user, carrier, 'customer', { reason: 'opportunity won' });
    } else if (body.status === 'trial') {
      await changeStage(req.user, carrier, 'trial');
    } else if (body.status === 'open' || body.status === 'negotiating') {
      await changeStage(req.user, carrier, 'opportunity');
      data.closedAt = null;
    } else if (body.status === 'lost') {
      data.closedAt = new Date();
      data.probability = 0;
      if (archive) await changeStage(req.user, carrier, 'archived', { reason: 'opportunity lost' });
    }
    await logActivity(req.user, { type: 'opportunity', carrierId: carrier.id, summary: `Opportunity with ${carrier.companyName} marked ${body.status.replace('_', ' ')}${body.lostReason ? `: ${body.lostReason}` : ''}` });
  }
  const updated = await prisma.opportunity.update({ where: { id: opp.id }, data });
  if (body.nextFollowUpAt !== undefined) await prisma.carrier.update({ where: { id: carrier.id }, data: { nextFollowUpAt: body.nextFollowUpAt } });
  res.json({ opportunity: updated });
}));

r.post('/:id/convert', ah(async (req, res) => {
  const { opp, carrier } = await loadOpp(req.user, req.params.id, true);
  const body = parse(z.object({ dispatchFeePercent: optNum(0, 100) }), req.body);
  await changeStage(req.user, carrier, 'customer', { reason: 'converted from opportunity' });
  const fee = body.dispatchFeePercent ?? opp.dispatchFeePercent ?? null;
  const customer = await prisma.customer.update({ where: { carrierId: carrier.id }, data: { dispatchFeePercent: fee, status: 'active' } });
  await logActivity(req.user, { type: 'customer', carrierId: carrier.id, summary: `${carrier.companyName} signed as a customer` });
  res.json({ customer });
}));

r.delete('/:id', ah(async (req, res) => {
  const { opp, carrier } = await loadOpp(req.user, req.params.id, true);
  await prisma.opportunity.delete({ where: { id: opp.id } });
  const stage = await prisma.pipelineStage.findUnique({ where: { id: carrier.stageId } });
  if (['opportunity', 'trial'].includes(stage?.key)) await changeStage(req.user, carrier, 'prospecting', { reason: 'opportunity removed' });
  res.json({ ok: true });
}));

export default r;
