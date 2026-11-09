import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, notFound } from '../lib/errors.js';
import { parse, z, reqStr, optStr, paginate, pageResult, pageQuery } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { callWindow, localParts, timezoneForState } from '../lib/timezones.js';
import { stageByKey } from '../services/pipeline.js';
import { writableCarriers, listInclude, serializeCarrier } from '../services/carriers/query.js';
import { onlySent } from '../services/carriers/normalize.js';

const r = Router();
r.use(requirePermission('crm.use'));

// ---------------- Prospect lists ----------------

async function ownList(req, id = req.params.id) {
  const list = await prisma.prospectList.findFirst({ where: { id, ownerId: req.user.id } });
  if (!list) throw notFound('List not found');
  return list;
}

r.get('/lists', ah(async (req, res) => {
  const lists = await prisma.prospectList.findMany({ where: { ownerId: req.user.id }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { items: true } } } });
  res.json({ items: lists.map((l) => ({ id: l.id, name: l.name, description: l.description, count: l._count.items, createdAt: l.createdAt })) });
}));

r.post('/lists', ah(async (req, res) => {
  const body = parse(z.object({ name: reqStr(80), description: optStr(500), carrierIds: z.array(z.string()).max(1000).optional() }), req.body);
  const list = await prisma.prospectList.create({ data: { ownerId: req.user.id, name: body.name, description: body.description } });
  if (body.carrierIds?.length) {
    const carriers = await writableCarriers(req.user, body.carrierIds);
    await prisma.prospectListItem.createMany({ data: carriers.map((c) => ({ listId: list.id, carrierId: c.id })) });
  }
  res.status(201).json({ list });
}));

r.get('/lists/:id', ah(async (req, res) => {
  const list = await ownList(req);
  const q = parse(z.object(pageQuery), req.query);
  const [items, total] = await Promise.all([
    prisma.prospectListItem.findMany({ where: { listId: list.id }, include: { carrier: { include: listInclude } }, orderBy: { addedAt: 'desc' }, ...paginate(q) }),
    prisma.prospectListItem.count({ where: { listId: list.id } }),
  ]);
  res.json({ list, ...pageResult(items.map((i) => ({ addedAt: i.addedAt, carrier: serializeCarrier(i.carrier) })), total, q) });
}));

r.patch('/lists/:id', ah(async (req, res) => {
  const list = await ownList(req);
  const body = onlySent(parse(z.object({ name: reqStr(80).optional(), description: optStr(500) }), req.body), req.body);
  res.json({ list: await prisma.prospectList.update({ where: { id: list.id }, data: body }) });
}));

r.delete('/lists/:id', ah(async (req, res) => {
  const list = await ownList(req);
  await prisma.prospectList.delete({ where: { id: list.id } });
  res.json({ ok: true });
}));

r.post('/lists/:id/items', ah(async (req, res) => {
  const list = await ownList(req);
  const { carrierIds } = parse(z.object({ carrierIds: z.array(z.string()).min(1).max(1000) }), req.body);
  const carriers = await writableCarriers(req.user, carrierIds);
  let added = 0;
  for (const c of carriers) {
    await prisma.prospectListItem.upsert({ where: { listId_carrierId: { listId: list.id, carrierId: c.id } }, create: { listId: list.id, carrierId: c.id }, update: {} });
    added++;
  }
  // Adding to a prospect list starts prospecting for fresh leads.
  const lead = await stageByKey('lead');
  const prospecting = await stageByKey('prospecting');
  await prisma.carrier.updateMany({ where: { id: { in: carriers.map((c) => c.id) }, stageId: lead.id }, data: { stageId: prospecting.id, stageChangedAt: new Date() } });
  res.json({ added });
}));

r.delete('/lists/:id/items/:carrierId', ah(async (req, res) => {
  const list = await ownList(req);
  await prisma.prospectListItem.deleteMany({ where: { listId: list.id, carrierId: req.params.carrierId } });
  res.json({ ok: true });
}));

// ---------------- Daily call queue ----------------

/** End of the user's local day as a UTC Date. */
function endOfUserDay(tz, now = new Date()) {
  const p = localParts(tz || 'America/Chicago', now);
  const minutesLeft = 24 * 60 - (p.hour * 60 + p.minute);
  return new Date(now.getTime() + minutesLeft * 60000 - 1000);
}

const carrierSelect = {
  id: true, companyName: true, phone: true, email: true, city: true, state: true, timezone: true, priority: true, doNotCall: true,
  dotNumber: true, mcNumber: true, fleetSize: true, equipment: true, lastContactedAt: true, ownerId: true, assignedToId: true,
  stage: { select: { key: true, name: true, color: true } },
};

r.get('/queue', ah(async (req, res) => {
  const q = parse(z.object({ includeHot: z.enum(['true', 'false']).default('true'), listId: optStr(40) }), req.query);
  const now = new Date();
  const end = endOfUserDay(req.user.timezone, now);
  const mine = { OR: [{ ownerId: req.user.id }, { assignedToId: req.user.id }] };
  const listFilter = q.listId ? { listItems: { some: { listId: q.listId } } } : {};

  const [enrollments, followUps, hot] = await Promise.all([
    prisma.sequenceEnrollment.findMany({
      where: { status: 'active', nextStepAt: { lte: end }, carrier: { ...mine, ...listFilter } },
      include: { sequence: { include: { steps: { orderBy: { order: 'asc' } } } }, carrier: { select: carrierSelect } },
      take: 500,
    }),
    prisma.followUp.findMany({
      where: { userId: req.user.id, status: 'pending', dueAt: { lte: end }, carrier: listFilter },
      include: { carrier: { select: carrierSelect } },
      take: 500,
    }),
    q.includeHot === 'true'
      ? prisma.carrier.findMany({
        // Two OR groups must be combined with AND; spreading both would let the second replace the ownership filter.
        where: { AND: [mine, { OR: [{ lastContactedAt: null }, { lastContactedAt: { lt: new Date(now.getTime() - 20 * 3600000) } }] }], ...listFilter, priority: { gte: 1 }, doNotCall: false, stage: { key: { in: ['lead', 'prospecting'] } } },
        select: carrierSelect, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], take: 25,
      })
      : [],
  ]);

  const items = [];
  const seen = new Set();
  for (const e of enrollments) {
    const step = e.sequence.steps[e.currentStep];
    if (!step || step.type === 'email') continue;
    if ((step.type === 'call' || step.type === 'text') && e.carrier.doNotCall) continue;
    items.push({ key: `seq:${e.id}`, kind: 'sequence', dueAt: e.nextStepAt, carrier: e.carrier,
      sequence: { id: e.sequence.id, name: e.sequence.name, enrollmentId: e.id, stepNumber: e.currentStep + 1, stepCount: e.sequence.steps.length, type: step.type, instructions: step.instructions, day: step.dayOffset + 1 } });
    seen.add(e.carrier.id);
  }
  for (const f of followUps) {
    if (f.type === 'call' && f.carrier.doNotCall) continue;
    items.push({ key: `fu:${f.id}`, kind: 'follow_up', dueAt: f.dueAt, carrier: f.carrier, followUp: { id: f.id, type: f.type, note: f.note } });
    seen.add(f.carrier.id);
  }
  for (const c of hot) {
    if (seen.has(c.id)) continue;
    items.push({ key: `hot:${c.id}`, kind: 'hot', dueAt: null, carrier: c });
  }
  for (const it of items) {
    it.callWindow = callWindow(it.carrier.timezone || timezoneForState(it.carrier.state), now);
    it.overdue = !!it.dueAt && new Date(it.dueAt) < new Date(now.getTime() - 15 * 60000);
  }
  items.sort((a, b) =>
    Number(b.overdue) - Number(a.overdue)
    || (b.carrier.priority || 0) - (a.carrier.priority || 0)
    || Number(b.callWindow.callable) - Number(a.callWindow.callable)
    || (a.dueAt ? new Date(a.dueAt).getTime() : Infinity) - (b.dueAt ? new Date(b.dueAt).getTime() : Infinity));

  const startOfDay = new Date(end.getTime() - 24 * 3600000 + 1000);
  const callsToday = await prisma.call.groupBy({ by: ['outcome'], where: { userId: req.user.id, calledAt: { gte: startOfDay } }, _count: { _all: true } });
  res.json({
    items,
    stats: {
      due: items.filter((i) => i.kind !== 'hot').length,
      overdue: items.filter((i) => i.overdue).length,
      callableNow: items.filter((i) => i.callWindow.callable).length,
      callsToday: callsToday.reduce((s, x) => s + x._count._all, 0),
      outcomesToday: Object.fromEntries(callsToday.map((x) => [x.outcome, x._count._all])),
    },
    generatedAt: now.toISOString(),
  });
}));

export default r;
