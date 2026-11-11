import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest, conflict, notFound } from '../lib/errors.js';
import { parse, z, reqStr, optStr, paginate, pageResult, pageQuery } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { loadCarrier, loadOwned, ownerWhere } from '../lib/access.js';
import { assertLimit } from '../lib/plans.js';
import { callWindowMemo, endOfUserDay, timezoneForState } from '../lib/timezones.js';
import { renderContent } from '../services/email/render.js';
import { blockedReason, deliverEmail, pickAccount } from '../services/email/index.js';
import { logActivity } from '../lib/activity.js';
import { audit } from '../lib/audit.js';
import { enrollCarriers, advanceFrom, stepDueAt, invalidateQueueCount } from '../services/sequenceEngine.js';
import { writableCarriers } from '../services/carriers/query.js';

const r = Router();
r.use(requirePermission('crm.use'));

const stepSchema = z.object({
  id: optStr(40), // existing step id (keeps carriers that are mid-sequence on the same step after an edit)
  dayOffset: z.coerce.number().int().min(0).max(365),
  type: z.enum(['call', 'email', 'text', 'task']),
  templateId: optStr(40),
  subject: optStr(300),
  body: optStr(20000),
  instructions: optStr(2000),
});

const sequenceSchema = z.object({
  name: reqStr(120),
  description: optStr(1000),
  active: z.boolean().default(true),
  respectBusinessHours: z.boolean().default(true),
  windowStartHour: z.coerce.number().int().min(0).max(23).default(9),
  windowEndHour: z.coerce.number().int().min(1).max(24).default(17),
  skipWeekends: z.boolean().default(true),
  maxEmailsPerDay: z.coerce.number().int().min(1).max(2000).default(50),
  steps: z.array(stepSchema).min(1, 'Add at least one step').max(30),
}).refine((s) => s.windowEndHour > s.windowStartHour, { message: 'Send window end must be after start', path: ['windowEndHour'] });

async function validateSteps(user, steps) {
  const sorted = [...steps].sort((a, b) => a.dayOffset - b.dayOffset);
  for (const [i, s] of sorted.entries()) {
    if (s.type === 'email') {
      if (s.templateId) {
        const t = await prisma.emailTemplate.findFirst({ where: { id: s.templateId, ownerId: user.id } });
        if (!t) throw badRequest(`Step ${i + 1}: template not found`);
      } else if (!s.subject || !s.body) throw badRequest(`Step ${i + 1}: email steps need a template or a subject and body`);
    }
    if (s.type === 'text' && !s.body) throw badRequest(`Step ${i + 1}: text steps need a message`);
  }
  return sorted.map((s, i) => ({ ...s, order: i }));
}

const stepData = (s, order) => ({
  order, dayOffset: s.dayOffset, type: s.type, templateId: s.type === 'email' ? s.templateId ?? null : null,
  subject: s.subject ?? null, body: s.body ?? null, instructions: s.instructions ?? null,
});

const stepInclude = { steps: { orderBy: { order: 'asc' }, include: { template: { select: { id: true, name: true } } } } };

r.get('/', ah(async (req, res) => {
  const where = await ownerWhere(req.user, req.query.scope === 'team' ? 'team' : 'mine');
  const list = await prisma.emailSequence.findMany({ where, orderBy: { createdAt: 'desc' }, include: { steps: { orderBy: { order: 'asc' }, select: { type: true, dayOffset: true } } } });
  const counts = await prisma.sequenceEnrollment.groupBy({ by: ['sequenceId', 'status'], where: { sequenceId: { in: list.map((s) => s.id) } }, _count: { _all: true } });
  res.json({
    items: list.map((s) => ({
      ...s,
      enrollments: Object.fromEntries(counts.filter((c) => c.sequenceId === s.id).map((c) => [c.status, c._count._all])),
    })),
  });
}));

r.post('/', requirePermission('automation.use'), ah(async (req, res) => {
  const body = parse(sequenceSchema, req.body);
  await assertLimit(req.user, 'sequences', 1);
  const steps = await validateSteps(req.user, body.steps);
  const { steps: _s, ...fields } = body;
  const seq = await prisma.emailSequence.create({
    data: { ...fields, ownerId: req.user.id, steps: { create: steps.map((s) => stepData(s, s.order)) } },
    include: stepInclude,
  });
  await audit(req, 'sequence.create', { entityType: 'sequence', entityId: seq.id });
  res.status(201).json({ sequence: seq });
}));

r.get('/enrollments', ah(async (req, res) => {
  const q = parse(z.object({ ...pageQuery, carrierId: optStr(40), status: optStr(20) }), req.query);
  const where = { ...(q.status ? { status: q.status } : {}) };
  if (q.carrierId) where.carrierId = (await loadCarrier(req.user, q.carrierId)).id;
  else where.userId = req.user.id;
  const [items, total] = await Promise.all([
    prisma.sequenceEnrollment.findMany({ where, orderBy: { startedAt: 'desc' }, include: { sequence: { include: { steps: { orderBy: { order: 'asc' } } } }, carrier: { select: { id: true, companyName: true, phone: true, state: true } } }, ...paginate(q) }),
    prisma.sequenceEnrollment.count({ where }),
  ]);
  res.json(pageResult(items.map(shapeEnrollment), total, q));
}));

function shapeEnrollment(e) {
  const step = e.sequence?.steps?.[e.currentStep];
  return {
    id: e.id, status: e.status, currentStep: e.currentStep, nextStepAt: e.nextStepAt, startedAt: e.startedAt, completedAt: e.completedAt, stopReason: e.stopReason,
    carrier: e.carrier, sequence: e.sequence ? { id: e.sequence.id, name: e.sequence.name, stepCount: e.sequence.steps.length } : undefined,
    step: step ? { order: e.currentStep + 1, type: step.type, day: step.dayOffset + 1, instructions: step.instructions, subject: step.subject } : null,
  };
}

async function loadEnrollment(req) {
  const e = await prisma.sequenceEnrollment.findUnique({ where: { id: req.params.eid }, include: { sequence: { include: { steps: { orderBy: { order: 'asc' } } } }, carrier: true } });
  if (!e) throw notFound('Enrollment not found');
  await loadCarrier(req.user, e.carrierId, { write: true });
  return e;
}

// ---------------- Work session (power dialer) ----------------

const sessionCarrier = {
  id: true, companyName: true, phone: true, email: true, city: true, state: true, timezone: true, priority: true, doNotCall: true, doNotEmail: true,
  dotNumber: true, mcNumber: true, fleetSize: true, equipment: true, lastContactedAt: true, ownerId: true, assignedToId: true,
  contacts: true,
  stage: { select: { key: true, name: true, color: true } },
};
const sessionInclude = { sequence: { include: { steps: { orderBy: { order: 'asc' }, include: { template: true } } } }, carrier: { select: sessionCarrier } };

/** One enrollment as a power-dialer work item: the current step with merge fields already filled in. */
function sessionItem(e, user, now = new Date(), cw = callWindowMemo(now)) {
  const steps = e.sequence.steps;
  const step = steps[e.currentStep];
  const { contacts, ...carrier } = e.carrier;
  const base = {
    enrollmentId: e.id, status: e.status, dueAt: e.nextStepAt, carrier,
    sequence: { id: e.sequence.id, name: e.sequence.name, stepCount: steps.length },
    callWindow: cw(carrier.timezone || timezoneForState(carrier.state)),
  };
  if (!step || e.status !== 'active') return { ...base, step: null };
  const out = { ...base, step: { index: e.currentStep, number: e.currentStep + 1, type: step.type, day: step.dayOffset + 1, instructions: step.instructions } };
  if (step.type === 'email') {
    const r0 = renderContent({ subject: step.subject ?? step.template?.subject ?? '', body: step.body ?? step.template?.body ?? '', carrier: e.carrier, user });
    out.email = { to: carrier.email, subject: r0.subject, body: r0.body, blocked: carrier.doNotEmail ? 'Carrier is marked do-not-email' : null };
  } else if (step.type === 'text') {
    out.text = { to: carrier.phone, body: renderContent({ subject: '', body: step.body || '', carrier: e.carrier, user: { ...user, emailSignature: null } }).body };
  }
  return out;
}

async function sessionEnrollment(req) {
  const e = await prisma.sequenceEnrollment.findUnique({ where: { id: req.params.eid }, include: sessionInclude });
  if (!e) throw notFound('Enrollment not found');
  await loadCarrier(req.user, e.carrierId, { write: true });
  return e;
}

/** Due work for one sequence. Upcoming steps are included on request (e.g. right after enrolling outside business hours). */
r.get('/:id/session', ah(async (req, res) => {
  const seq = await loadOwned('emailSequence', req.user, req.params.id);
  const q = parse(z.object({ includeUpcoming: z.enum(['true', 'false']).default('false') }), req.query);
  const now = new Date();
  const end = endOfUserDay(req.user.timezone, now);
  const rows = await prisma.sequenceEnrollment.findMany({
    where: { sequenceId: seq.id, status: 'active', carrier: { OR: [{ ownerId: req.user.id }, { assignedToId: req.user.id }] } },
    include: sessionInclude, orderBy: { nextStepAt: 'asc' }, take: 500,
  });
  const due = rows.filter((e) => e.nextStepAt && e.nextStepAt <= end);
  const pick = q.includeUpcoming === 'true' ? rows : due;
  const cw = callWindowMemo(now);
  res.json({
    sequence: { id: seq.id, name: seq.name, active: seq.active },
    items: pick.map((e) => sessionItem(e, req.user, now, cw)).filter((i) => i.step),
    dueToday: due.length, upcoming: rows.length - due.length,
  });
}));

r.get('/enrollments/:eid', ah(async (req, res) => {
  res.json({ item: sessionItem(await sessionEnrollment(req), req.user) });
}));

/** Send the current email step now (instead of waiting for the scheduler) and advance the enrollment. */
r.post('/enrollments/:eid/send-email', ah(async (req, res) => {
  const b = parse(z.object({ subject: reqStr(300), body: z.string().trim().min(1, 'Required').max(20000), stepIndex: z.coerce.number().int().min(0), accountId: optStr(40) }), req.body);
  const e = await sessionEnrollment(req);
  const step = e.sequence.steps[e.currentStep];
  if (e.status !== 'active' || !step || step.type !== 'email' || e.currentStep !== b.stepIndex) throw conflict('This step was already completed or changed. Refresh and try again.');
  const to = e.carrier.email;
  if (!to) throw badRequest(`${e.carrier.companyName} has no email address`);
  const blocked = await blockedReason(req.user.id, to, e.carrierId);
  if (blocked) throw badRequest(blocked);
  const account = await pickAccount(req.user.id, b.accountId || undefined);
  if (!account) throw badRequest('Connect a mailbox first (Email → Mailboxes)', { code: 'no_mailbox' });
  await assertLimit(req.user, 'emailsToday');
  // Claim the step first (compare-and-set on step AND due time, which the scheduler's lease also changes), so the
  // scheduler and this request can never both send it.
  const claimed = await prisma.sequenceEnrollment.updateMany({
    where: { id: e.id, currentStep: e.currentStep, status: 'active', nextStepAt: e.nextStepAt },
    data: { nextStepAt: new Date(Date.now() + 3600000) },
  });
  if (!claimed.count) throw conflict('This step was already completed. Refresh and try again.');
  const created = await prisma.email.create({
    data: {
      userId: req.user.id, carrierId: e.carrierId, enrollmentId: e.id, templateId: step.templateId, emailAccountId: account.id,
      toEmail: to, subject: b.subject, body: b.body, status: 'scheduled', scheduledAt: new Date(),
    },
  });
  const result = await deliverEmail(created.id, { retry: false });
  const ok = result.outcome === 'sent' || result.outcome === 'deferred';
  if (ok) {
    await advanceFrom(e, e.sequence, { expectedStep: e.currentStep });
    await logActivity(req.user, { type: 'sequence', carrierId: e.carrierId, summary: `Sent step ${e.currentStep + 1} (email) of "${e.sequence.name}" to ${e.carrier.companyName}` });
  } else {
    // Not sent: put the step back on its schedule so nothing is lost.
    await prisma.sequenceEnrollment.updateMany({ where: { id: e.id, currentStep: e.currentStep, status: 'active' }, data: { nextStepAt: e.nextStepAt } });
  }
  const fresh = await prisma.sequenceEnrollment.findUnique({ where: { id: e.id }, include: sessionInclude });
  res.status(ok ? 200 : 502).json({ outcome: result.outcome, message: result.message, error: ok ? undefined : result.message, item: sessionItem(fresh, req.user) });
}));

r.post('/enrollments/:eid/:action', ah(async (req, res) => {
  const { action } = parse(z.object({ action: z.enum(['pause', 'resume', 'stop', 'complete-step', 'skip-step']) }), req.params);
  // stepIndex: the step the user saw. When it no longer matches (the scheduler or another tab moved on) we refuse
  // with 409 instead of completing or skipping the wrong step.
  const b = parse(z.object({ stepIndex: z.coerce.number().int().min(0).optional() }), req.body || {});
  const e = await loadEnrollment(req);
  const now = new Date();
  const cas = (where, data) => prisma.sequenceEnrollment.updateMany({ where: { id: e.id, ...where }, data });
  if (action === 'pause') {
    if (e.status !== 'active' || !(await cas({ status: 'active' }, { status: 'paused' })).count) throw badRequest('Only active enrollments can be paused');
  } else if (action === 'resume') {
    if (e.status !== 'paused') throw badRequest('Only paused enrollments can be resumed');
    const step = e.sequence.steps[e.currentStep];
    const nextStepAt = step ? stepDueAt(e.sequence, step, e.startedAt, e.carrier, now) : null;
    const res0 = await cas({ status: 'paused', currentStep: e.currentStep }, { status: step ? 'active' : 'completed', nextStepAt, completedAt: step ? null : now });
    if (!res0.count) throw conflict('This enrollment changed. Refresh and try again.');
  } else if (action === 'stop') {
    await cas({ status: { in: ['active', 'paused'] } }, { status: 'stopped', stopReason: 'stopped_by_user', nextStepAt: null });
  } else {
    if (e.status !== 'active') throw badRequest('Enrollment is not active');
    const expected = b.stepIndex ?? e.currentStep;
    const step = e.sequence.steps[expected];
    const moved = expected === e.currentStep ? await advanceFrom(e, e.sequence, { now, expectedStep: expected }) : null;
    if (!moved) throw conflict('This step was already completed or changed. Refresh and try again.');
    await logActivity(req.user, {
      type: 'sequence', carrierId: e.carrierId,
      summary: `${action === 'skip-step' ? 'Skipped' : 'Completed'} step ${expected + 1} (${step?.type}) of "${e.sequence.name}" for ${e.carrier.companyName}`,
    });
  }
  invalidateQueueCount(e.userId);
  const fresh = await prisma.sequenceEnrollment.findUnique({ where: { id: e.id }, include: { sequence: { include: { steps: { orderBy: { order: 'asc' } } } }, carrier: { select: { id: true, companyName: true, phone: true, state: true } } } });
  res.json({ enrollment: shapeEnrollment(fresh) });
}));

// Email status counts per sequence, cached 60 s (bounded): counting goes through every enrollment of the sequence.
const STATS_TTL_MS = 60000;
const statsCache = new Map();
async function sequenceEmailStats(sequenceId) {
  const hit = statsCache.get(sequenceId);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.value;
  const rows = await prisma.email.groupBy({ by: ['status'], where: { enrollment: { sequenceId } }, _count: { _all: true } });
  const value = Object.fromEntries(rows.map((c) => [c.status, c._count._all]));
  if (statsCache.size >= 1000) statsCache.clear();
  statsCache.set(sequenceId, { at: Date.now(), value });
  return value;
}

r.get('/:id', ah(async (req, res) => {
  const seq = await loadOwned('emailSequence', req.user, req.params.id, { include: stepInclude });
  const counts = await prisma.sequenceEnrollment.groupBy({ by: ['status'], where: { sequenceId: seq.id }, _count: { _all: true } });
  const enrollments = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
  res.json({
    sequence: seq,
    enrollments,
    midSequence: (enrollments.active || 0) + (enrollments.paused || 0), // carriers an edit would re-time
    emails: await sequenceEmailStats(seq.id),
  });
}));

/**
 * Match submitted steps to existing ones so step ids survive an edit: explicit ids first, then identical content,
 * then the same content on another day, then the same type on the same day. Returns old ids (or null) per new step.
 */
export function matchSteps(oldSteps, newSteps) {
  const known = new Set(oldSteps.map((s) => s.id));
  const used = new Set();
  const match = new Array(newSteps.length).fill(null);
  newSteps.forEach((s, i) => {
    if (s.id && known.has(s.id) && !used.has(s.id)) { match[i] = s.id; used.add(s.id); }
  });
  const same = (a, b, keys) => keys.every((k) => (a[k] ?? null) === (b[k] ?? null));
  const passes = [
    ['type', 'dayOffset', 'templateId', 'subject', 'body', 'instructions'],
    ['type', 'templateId', 'subject', 'body', 'instructions'],
    ['type', 'dayOffset'],
  ];
  for (const keys of passes) {
    newSteps.forEach((s, i) => {
      if (match[i] || s.id) return;
      const o = oldSteps.find((x) => !used.has(x.id) && same(x, stepData(s, 0), keys));
      if (o) { match[i] = o.id; used.add(o.id); }
    });
  }
  return match;
}

const OPEN = ['active', 'paused'];
const PARK = 100000; // temporary offset so two-phase currentStep moves never collide

r.put('/:id', requirePermission('automation.use'), ah(async (req, res) => {
  const seq = await loadOwned('emailSequence', req.user, req.params.id, { write: true, include: { steps: { orderBy: { order: 'asc' } } } });
  const body = parse(sequenceSchema, req.body);
  const steps = await validateSteps(req.user, body.steps);
  const { steps: _s, ...fields } = body;
  const oldSteps = seq.steps;
  const match = matchSteps(oldSteps, steps);
  const newIndexOf = new Map(match.map((id, i) => [id, i]).filter(([id]) => id));
  // Where an enrollment on old step k continues: the same step (by id), else the first remaining step on or after
  // its day, else past the end (completed).
  const mapIndex = (k) => {
    if (k >= oldSteps.length) return steps.length;
    const id = oldSteps[k].id;
    if (newIndexOf.has(id)) return newIndexOf.get(id);
    const i = steps.findIndex((s) => s.dayOffset >= oldSteps[k].dayOffset);
    return i === -1 ? steps.length : i;
  };
  const timingChanged = ['respectBusinessHours', 'windowStartHour', 'windowEndHour', 'skipWeekends'].some((k) => seq[k] !== fields[k]);
  const now = new Date();
  const out = { moved: 0, completed: 0, retimed: 0 };
  const retime = new Set();

  await prisma.$transaction(async (tx) => {
    await tx.sequenceStep.updateMany({ where: { sequenceId: seq.id }, data: { order: { increment: PARK } } });
    await tx.sequenceStep.deleteMany({ where: { sequenceId: seq.id, id: { notIn: match.filter(Boolean) } } });
    for (const [i, s] of steps.entries()) {
      if (match[i]) await tx.sequenceStep.update({ where: { id: match[i] }, data: stepData(s, i) });
      else await tx.sequenceStep.create({ data: { ...stepData(s, i), sequenceId: seq.id } });
    }
    await tx.emailSequence.update({ where: { id: seq.id }, data: fields });

    const groups = await tx.sequenceEnrollment.groupBy({ by: ['currentStep'], where: { sequenceId: seq.id, status: { in: OPEN } }, _count: { _all: true } });
    const moves = [];
    for (const g of groups) {
      const to = mapIndex(g.currentStep);
      if (to !== g.currentStep) moves.push({ from: g.currentStep, to, n: g._count._all });
      const fromStep = oldSteps[g.currentStep];
      const toStep = steps[to];
      if (toStep && (timingChanged || !fromStep || match[to] !== fromStep.id || fromStep.dayOffset !== toStep.dayOffset)) retime.add(to);
    }
    for (const m of moves) await tx.sequenceEnrollment.updateMany({ where: { sequenceId: seq.id, status: { in: OPEN }, currentStep: m.from }, data: { currentStep: m.to + PARK } });
    for (const m of moves) {
      await tx.sequenceEnrollment.updateMany({ where: { sequenceId: seq.id, currentStep: m.to + PARK }, data: { currentStep: m.to } });
      out.moved += m.n;
    }
    const done = await tx.sequenceEnrollment.updateMany({
      where: { sequenceId: seq.id, status: { in: OPEN }, currentStep: { gte: steps.length } },
      data: { status: 'completed', completedAt: now, nextStepAt: null },
    });
    out.completed = done.count;
  });

  // Re-time only active enrollments whose step or timing changed, 200 per transaction, yielding between batches.
  const updated = await prisma.emailSequence.findUnique({ where: { id: seq.id }, include: stepInclude });
  if (retime.size) {
    let cursor;
    for (;;) {
      const batch = await prisma.sequenceEnrollment.findMany({
        where: { sequenceId: seq.id, status: 'active', currentStep: { in: [...retime] } },
        select: { id: true, currentStep: true, startedAt: true, carrier: { select: { state: true, timezone: true } } },
        orderBy: { id: 'asc' }, take: 200, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!batch.length) break;
      await prisma.$transaction(batch.map((e) => prisma.sequenceEnrollment.updateMany({
        where: { id: e.id, status: 'active', currentStep: e.currentStep },
        data: { nextStepAt: stepDueAt(updated, updated.steps[e.currentStep], e.startedAt, e.carrier, now) },
      })));
      out.retimed += batch.length;
      cursor = batch[batch.length - 1].id;
      if (batch.length < 200) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  statsCache.delete(seq.id);
  const owners = await prisma.sequenceEnrollment.groupBy({ by: ['userId'], where: { sequenceId: seq.id, status: { in: OPEN } } });
  for (const o of owners) invalidateQueueCount(o.userId);
  invalidateQueueCount(req.user.id);
  res.json({ sequence: updated, remapped: out });
}));

r.delete('/:id', requirePermission('automation.use'), ah(async (req, res) => {
  const seq = await loadOwned('emailSequence', req.user, req.params.id, { write: true });
  const owners = await prisma.sequenceEnrollment.groupBy({ by: ['userId'], where: { sequenceId: seq.id, status: { in: OPEN } } });
  await prisma.emailSequence.delete({ where: { id: seq.id } });
  statsCache.delete(seq.id);
  for (const o of owners) invalidateQueueCount(o.userId);
  await audit(req, 'sequence.delete', { entityType: 'sequence', entityId: seq.id });
  res.json({ ok: true });
}));

r.post('/:id/enroll', ah(async (req, res) => {
  const seq = await loadOwned('emailSequence', req.user, req.params.id);
  if (!seq.active) throw badRequest('Activate the sequence before enrolling carriers');
  const { carrierIds } = parse(z.object({ carrierIds: z.array(z.string()).min(1).max(1000) }), req.body);
  const carriers = await writableCarriers(req.user, carrierIds);
  const out = await enrollCarriers(req.user, seq.id, carriers);
  res.json({ ...out, inaccessible: carrierIds.length - carriers.length });
}));

r.get('/:id/enrollments', ah(async (req, res) => {
  const seq = await loadOwned('emailSequence', req.user, req.params.id);
  const q = parse(z.object({ ...pageQuery, status: optStr(20) }), req.query);
  const where = { sequenceId: seq.id, ...(q.status ? { status: q.status } : {}) };
  const [items, total] = await Promise.all([
    prisma.sequenceEnrollment.findMany({ where, orderBy: [{ status: 'asc' }, { nextStepAt: 'asc' }], include: { sequence: { include: { steps: { orderBy: { order: 'asc' } } } }, carrier: { select: { id: true, companyName: true, phone: true, state: true } } }, ...paginate(q) }),
    prisma.sequenceEnrollment.count({ where }),
  ]);
  res.json(pageResult(items.map(shapeEnrollment), total, q));
}));

export default r;
