import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, notFound, badRequest } from '../lib/errors.js';
import { parse, z, optStr, optInt, optNum, optDate, pageQuery, paginate, pageResult, clean } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { loadCarrier, ownerWhere } from '../lib/access.js';
import { OPPORTUNITY_STATUSES } from '../lib/constants.js';
import { logActivity } from '../lib/activity.js';
import { changeStage } from '../services/pipeline.js';
import { invalidateQueueCount } from '../services/sequenceEngine.js';
import { syncNextFollowUp } from './followups.js';

const r = Router();
r.use(requirePermission('crm.use'));

const carrierSelect = {
  id: true, companyName: true, mcNumber: true, dotNumber: true, phone: true, email: true, city: true, state: true,
  // timezone: the follow-up date is typed in the carrier's local time (state fallback when not stored).
  timezone: true, equipment: true, fleetSize: true, ownerId: true, assignedToId: true,
  stage: { select: { key: true, name: true, color: true } },
  assignedTo: { select: { id: true, name: true } },
};

const OPEN = ['open', 'negotiating', 'trial'];
/** Title of the follow-up an opportunity's "Next follow-up" date creates (one pending per carrier and user). */
export const OPP_FOLLOW_UP_TITLE = 'Opportunity follow-up';

/**
 * Keep the opportunity's next follow-up as a real FollowUp row, so reminders, the call queue, the nav badge and the
 * Follow-ups page all see it: a date creates or moves the pending opportunity follow-up; clearing it or closing the
 * opportunity cancels it. carrier.nextFollowUpAt is then recalculated from all pending follow-ups.
 */
export async function syncOpportunityFollowUp(user, carrier, dueAt) {
  // One opportunity per carrier, so its follow-up is found by carrier whoever created it: a teammate or team lead
  // who moves the date or closes the deal updates (or cancels) the owner's reminder instead of leaving it pending.
  const pending = await prisma.followUp.findMany({
    where: { carrierId: carrier.id, status: 'pending', title: OPP_FOLLOW_UP_TITLE },
    orderBy: [{ userId: 'asc' }, { dueAt: 'asc' }], select: { id: true, userId: true }, take: 20,
  });
  const keep = pending.find((f) => f.userId === user.id) || pending[0];
  const touched = new Set(pending.map((f) => f.userId));
  if (dueAt) {
    if (keep) {
      await prisma.followUp.update({ where: { id: keep.id }, data: { dueAt, notifiedAt: null } });
      const extra = pending.filter((f) => f.id !== keep.id).map((f) => f.id);
      if (extra.length) await prisma.followUp.updateMany({ where: { id: { in: extra } }, data: { status: 'canceled' } });
    } else {
      await prisma.followUp.create({
        data: { carrierId: carrier.id, userId: user.id, dueAt, type: 'call', priority: 1, title: OPP_FOLLOW_UP_TITLE, note: `Next step on the opportunity with ${carrier.companyName}` },
      });
      touched.add(user.id);
    }
  } else if (pending.length) {
    await prisma.followUp.updateMany({ where: { id: { in: pending.map((f) => f.id) } }, data: { status: 'canceled' } });
  } else {
    return;
  }
  await syncNextFollowUp(carrier.id);
  for (const id of touched) invalidateQueueCount(id);
}

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
  const [rows, total, groups] = await Promise.all([
    prisma.opportunity.findMany({ where, orderBy, ...paginate(q), include: { carrier: { select: carrierSelect }, owner: { select: { id: true, name: true } } } }),
    prisma.opportunity.count({ where }),
    // Totals from one bounded aggregate (at most statuses x probabilities rows), not every opportunity.
    prisma.opportunity.groupBy({ by: ['status', 'probability'], where: base, _count: { _all: true }, _sum: { estimatedValueCents: true } }),
  ]);
  const byStatus = Object.fromEntries(OPPORTUNITY_STATUSES.map((s) => [s, 0]));
  let openValueCents = 0;
  let weightedValueCents = 0;
  for (const g of groups) {
    byStatus[g.status] = (byStatus[g.status] || 0) + g._count._all;
    if (OPEN.includes(g.status)) {
      const sum = g._sum.estimatedValueCents || 0;
      openValueCents += sum;
      weightedValueCents += Math.round((sum * g.probability) / 100);
    }
  }
  // "Next follow-up" comes from the carrier's earliest pending follow-up (the one reminders act on).
  const pending = rows.length
    ? await prisma.followUp.groupBy({ by: ['carrierId'], where: { carrierId: { in: rows.map((o) => o.carrierId) }, status: 'pending' }, _min: { dueAt: true } })
    : [];
  const nextBy = new Map(pending.map((p) => [p.carrierId, p._min.dueAt]));
  const items = rows.map((o) => ({ ...o, nextFollowUpAt: nextBy.get(o.carrierId) ?? null }));
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
  if (body.nextFollowUpAt) await syncOpportunityFollowUp(req.user, carrier, body.nextFollowUpAt);
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
      await prisma.carrier.update({ where: { id: carrier.id }, data: { isFleet: true } });
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
  const closing = !!body.status && ['won', 'lost'].includes(body.status) && body.status !== opp.status;
  if (closing) data.nextFollowUpAt = null;
  const updated = await prisma.opportunity.update({ where: { id: opp.id }, data });
  if (closing) await syncOpportunityFollowUp(req.user, carrier, null);
  else if (body.nextFollowUpAt !== undefined) await syncOpportunityFollowUp(req.user, carrier, body.nextFollowUpAt);
  res.json({ opportunity: updated });
}));

r.post('/:id/convert', ah(async (req, res) => {
  const { opp, carrier } = await loadOpp(req.user, req.params.id, true);
  const body = parse(z.object({ dispatchFeePercent: optNum(0, 100) }), req.body);
  await changeStage(req.user, carrier, 'customer', { reason: 'converted from opportunity' });
  const fee = body.dispatchFeePercent ?? opp.dispatchFeePercent ?? null;
  const customer = await prisma.customer.update({ where: { carrierId: carrier.id }, data: { dispatchFeePercent: fee, status: 'active' } });
  // A customer's truck belongs on the fleet map.
  await prisma.carrier.update({ where: { id: carrier.id }, data: { isFleet: true } });
  if (opp.nextFollowUpAt) await prisma.opportunity.update({ where: { id: opp.id }, data: { nextFollowUpAt: null } });
  await syncOpportunityFollowUp(req.user, carrier, null);
  await logActivity(req.user, { type: 'customer', carrierId: carrier.id, summary: `${carrier.companyName} signed as a customer` });
  const { portalTokenHash, ...out } = customer;
  res.json({ customer: out });
}));

r.delete('/:id', ah(async (req, res) => {
  const { opp, carrier } = await loadOpp(req.user, req.params.id, true);
  await prisma.opportunity.delete({ where: { id: opp.id } });
  await syncOpportunityFollowUp(req.user, carrier, null);
  const stage = await prisma.pipelineStage.findUnique({ where: { id: carrier.stageId } });
  if (['opportunity', 'trial'].includes(stage?.key)) await changeStage(req.user, carrier, 'prospecting', { reason: 'opportunity removed' });
  res.json({ ok: true });
}));

export default r;
