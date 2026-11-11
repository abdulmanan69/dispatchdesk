import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { ah, notFound } from '../lib/errors.js';
import { parse, z, reqStr, optStr, paginate, pageResult, pageQuery } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { teamMemberIds } from '../lib/access.js';
import { callWindowMemo, endOfUserDay, startOfUserDay, timezoneForState } from '../lib/timezones.js';
import { onBroadcast } from '../lib/broadcast.js';
import { stageByKey } from '../services/pipeline.js';
import { writableCarriers, listInclude, serializeCarrier } from '../services/carriers/query.js';
import { onlySent } from '../services/carriers/normalize.js';

const r = Router();
r.use(requirePermission('crm.use'));

// Sidebar badge counts, cached 60 s per user (bounded). Writes that change a user's queue call
// invalidateQueueCount(userId) (services/sequenceEngine.js), which broadcasts 'queue-count' to every process.
const COUNT_TTL_MS = 60000;
const COUNT_MAX = 5000;
const countCache = new Map(); // userId -> { at, value }
onBroadcast('queue-count', (data) => {
  if (data?.userId) countCache.delete(data.userId);
  else countCache.clear();
});

function cachedCount(userId) {
  const hit = countCache.get(userId);
  if (!hit) return null;
  if (Date.now() - hit.at > COUNT_TTL_MS) { countCache.delete(userId); return null; }
  return hit.value;
}

function storeCount(userId, value) {
  if (countCache.size >= COUNT_MAX) {
    const now = Date.now();
    for (const [k, v] of countCache) if (now - v.at > COUNT_TTL_MS) countCache.delete(k);
    if (countCache.size >= COUNT_MAX) countCache.delete(countCache.keys().next().value); // oldest insertion
  }
  countCache.set(userId, { at: Date.now(), value });
}

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

const carrierSelect = {
  id: true, companyName: true, phone: true, email: true, city: true, state: true, timezone: true, priority: true, doNotCall: true,
  dotNumber: true, mcNumber: true, fleetSize: true, equipment: true, lastContactedAt: true, ownerId: true, assignedToId: true,
  stage: { select: { key: true, name: true, color: true } },
};

/**
 * Due queue work from sequences: active enrollments on carriers the user owns or is assigned to (never a carrier the
 * user lost access to, e.g. after leaving a team), in an active sequence, whose current step is a call, text or task
 * (email steps are the scheduler's; call and text steps are skipped for do-not-call carriers).
 * Two raw SQL branches, each driven by its own index: a single Prisma query with an OR across the carrier join makes
 * SQLite range-scan the due enrollments of every tenant instead.
 * - A: enrolled by the user or a teammate: SequenceEnrollment(userId, status, nextStepAt), then carrier, sequence and
 *   step by key;
 * - B: enrolled by anyone else on a carrier assigned to the user: Carrier(assignedToId), then
 *   SequenceEnrollment(carrierId, status). CROSS JOIN fixes that join order; `+` keeps the planner off the
 *   platform-wide (status, nextStepAt) index.
 * Both return the same columns (e = enrollment), so callers add a SELECT and an ORDER BY or GROUP BY.
 */
export async function queueBranches(user, end, listId = null) {
  const me = user.id;
  const members = Prisma.join(await teamMemberIds(user));
  const list = listId
    ? Prisma.sql`AND EXISTS (SELECT 1 FROM ProspectListItem li WHERE li.listId = ${listId} AND li.carrierId = e.carrierId)`
    : Prisma.empty;
  const work = Prisma.sql`s.type <> 'email' AND NOT (c.doNotCall = 1 AND s.type IN ('call', 'text'))`;
  return [
    Prisma.sql`FROM SequenceEnrollment e
      JOIN Carrier c ON c.id = e.carrierId
      JOIN EmailSequence q ON q.id = e.sequenceId
      JOIN SequenceStep s ON s.sequenceId = e.sequenceId AND s."order" = e.currentStep
      WHERE e.userId IN (${members}) AND e.status = 'active' AND e.nextStepAt <= ${end}
        AND (c.ownerId = ${me} OR c.assignedToId = ${me}) AND q.active = 1 AND ${work} ${list}`,
    // INDEXED BY: once ANALYZE has run (the nightly PRAGMA optimize), a table where most carriers are unassigned makes
    // assignedToId look unselective and SQLite would scan every tenant's carriers here on each badge refresh.
    Prisma.sql`FROM Carrier c INDEXED BY Carrier_assignedToId_idx CROSS JOIN SequenceEnrollment e CROSS JOIN EmailSequence q CROSS JOIN SequenceStep s
      WHERE c.assignedToId = ${me} AND e.carrierId = c.id AND e.status = 'active' AND +e.nextStepAt <= ${end}
        AND e.userId NOT IN (${members}) AND q.id = e.sequenceId AND q.active = 1
        AND s.sequenceId = e.sequenceId AND s."order" = e.currentStep AND ${work} ${list}`,
  ];
}

/** Ids of the user's due queue enrollments, the most overdue first (at most `limit`). */
async function dueQueueEnrollmentIds(user, end, listId, limit = 500) {
  const branches = await queueBranches(user, end, listId);
  const rows = (await Promise.all(branches.map((from) => prisma.$queryRaw`SELECT e.id AS id ${from} ORDER BY +e.nextStepAt LIMIT ${limit}`))).flat();
  return [...new Set(rows.map((x) => x.id))];
}

/** Due queue enrollments grouped by (sequence, step): [{ sequenceId, currentStep, due, late }] (late = due before `late`). */
async function dueQueueGroups(user, end, late) {
  const branches = await queueBranches(user, end);
  const rows = (await Promise.all(branches.map((from) => prisma.$queryRaw`
    SELECT e.sequenceId AS sequenceId, e.currentStep AS currentStep, COUNT(*) AS due,
           SUM(CASE WHEN e.nextStepAt < ${late} THEN 1 ELSE 0 END) AS late
    ${from} GROUP BY e.sequenceId, e.currentStep`))).flat();
  return rows.map((g) => ({ sequenceId: g.sequenceId, currentStep: Number(g.currentStep), due: Number(g.due || 0), late: Number(g.late || 0) }));
}

/** Steps (type, instructions, dayOffset) of the given sequences, loaded once per sequence instead of once per row. */
async function stepsBySequence(sequenceIds) {
  if (!sequenceIds.length) return new Map();
  const steps = await prisma.sequenceStep.findMany({
    where: { sequenceId: { in: sequenceIds } }, orderBy: [{ sequenceId: 'asc' }, { order: 'asc' }],
    select: { sequenceId: true, order: true, type: true, instructions: true, dayOffset: true },
  });
  const out = new Map();
  for (const s of steps) {
    if (!out.has(s.sequenceId)) out.set(s.sequenceId, []);
    out.get(s.sequenceId).push(s);
  }
  return out;
}

/**
 * GET /api/prospecting/queue/count -> { queue, count (= queue), followUps, overdue, generatedAt }
 * - queue: due sequence call/text/task steps plus pending follow-ups due by the end of the user's day
 *   (the same items as /queue without the "hot" leads),
 * - followUps: the follow-up part of that,
 * - overdue: items more than 15 minutes past due.
 * Cheap: grouped counts over the index-driven branches of queueBranches() and FollowUp(userId, status, dueAt);
 * cached 60 s per user and cleared when the user's queue changes. Matches /queue's `stats.due`.
 */
r.get('/queue/count', ah(async (req, res) => {
  const userId = req.user.id;
  const hit = cachedCount(userId);
  if (hit) return res.json(hit);
  const now = new Date();
  const end = endOfUserDay(req.user.timezone, now);
  const late = new Date(now.getTime() - 15 * 60000);
  // The same follow-ups as /queue: call follow-ups on do-not-call carriers are left out there too.
  const fuWhere = (dueAt) => ({ userId, status: 'pending', dueAt, NOT: { type: 'call', carrier: { doNotCall: true } } });
  const [groups, followUps, lateFollowUps] = await Promise.all([
    dueQueueGroups(req.user, end, late), // call, text and task steps only (see queueBranches)
    prisma.followUp.count({ where: fuWhere({ lte: end }) }),
    prisma.followUp.count({ where: fuWhere({ lt: late }) }),
  ]);
  const queue = groups.reduce((n, g) => n + g.due, 0) + followUps;
  const overdue = groups.reduce((n, g) => n + g.late, 0) + lateFollowUps;
  // `count` is an alias of `queue` for badge code that reads a generic field name.
  const value = { queue, count: queue, followUps, overdue, generatedAt: now.toISOString() };
  storeCount(userId, value);
  res.json(value);
}));

r.get('/queue', ah(async (req, res) => {
  const q = parse(z.object({ includeHot: z.enum(['true', 'false']).default('true'), listId: optStr(40) }), req.query);
  const now = new Date();
  const end = endOfUserDay(req.user.timezone, now);
  const mine = { OR: [{ ownerId: req.user.id }, { assignedToId: req.user.id }] };
  const listFilter = q.listId ? { listItems: { some: { listId: q.listId } } } : {};

  const [enrollmentIds, followUps, hot] = await Promise.all([
    dueQueueEnrollmentIds(req.user, end, q.listId || null), // the most overdue first, so a long queue never hides them
    prisma.followUp.findMany({
      where: {
        userId: req.user.id, status: 'pending', dueAt: { lte: end }, ...(q.listId ? { carrier: listFilter } : {}),
        NOT: { type: 'call', carrier: { doNotCall: true } }, // as in /queue/count; never uses up the 500 rows
      },
      include: { carrier: { select: carrierSelect } },
      orderBy: { dueAt: 'asc' },
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

  const enrollmentRows = enrollmentIds.length
    ? (await prisma.sequenceEnrollment.findMany({
      where: { id: { in: enrollmentIds } },
      select: {
        id: true, sequenceId: true, currentStep: true, nextStepAt: true,
        sequence: { select: { id: true, name: true } },
        carrier: { select: carrierSelect },
      },
    })).sort((a, b) => a.nextStepAt - b.nextStepAt).slice(0, 500)
    : [];
  const stepMap = await stepsBySequence([...new Set(enrollmentRows.map((e) => e.sequenceId))]);
  const items = [];
  const seen = new Set();
  for (const e of enrollmentRows) {
    const steps = stepMap.get(e.sequenceId) || [];
    const step = steps[e.currentStep];
    if (!step || step.type === 'email') continue;
    if ((step.type === 'call' || step.type === 'text') && e.carrier.doNotCall) continue;
    items.push({ key: `seq:${e.id}`, kind: 'sequence', dueAt: e.nextStepAt, carrier: e.carrier,
      sequence: { id: e.sequence.id, name: e.sequence.name, enrollmentId: e.id, stepNumber: e.currentStep + 1, stepCount: steps.length, type: step.type, instructions: step.instructions, day: step.dayOffset + 1 } });
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
  const cw = callWindowMemo(now); // one computation per time zone, not per item
  for (const it of items) {
    it.callWindow = cw(it.carrier.timezone || timezoneForState(it.carrier.state));
    it.overdue = !!it.dueAt && new Date(it.dueAt) < new Date(now.getTime() - 15 * 60000);
  }
  items.sort((a, b) =>
    Number(b.overdue) - Number(a.overdue)
    || (b.carrier.priority || 0) - (a.carrier.priority || 0)
    || Number(b.callWindow.callable) - Number(a.callWindow.callable)
    || (a.dueAt ? new Date(a.dueAt).getTime() : Infinity) - (b.dueAt ? new Date(b.dueAt).getTime() : Infinity));

  const startOfDay = startOfUserDay(req.user.timezone, now);
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
