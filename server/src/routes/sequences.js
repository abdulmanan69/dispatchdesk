import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest, conflict, notFound } from '../lib/errors.js';
import { parse, z, reqStr, optStr, paginate, pageResult, pageQuery } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { loadCarrier, loadOwned, ownerWhere } from '../lib/access.js';
import { assertLimit } from '../lib/plans.js';
import { callWindow, localParts, timezoneForState } from '../lib/timezones.js';
import { renderContent } from '../services/email/render.js';
import { blockedReason, deliverEmail, pickAccount } from '../services/email/index.js';
import { logActivity } from '../lib/activity.js';
import { audit } from '../lib/audit.js';
import { enrollCarriers, advanceEnrollment, stepDueAt } from '../services/sequenceEngine.js';
import { writableCarriers } from '../services/carriers/query.js';

const r = Router();
r.use(requirePermission('crm.use'));

const stepSchema = z.object({
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
  const seq = await prisma.emailSequence.create({
    data: { ...body, ownerId: req.user.id, steps: { create: steps } },
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

function endOfUserDay(tz, now = new Date()) {
  const p = localParts(tz || 'America/Chicago', now);
  return new Date(now.getTime() + (24 * 60 - (p.hour * 60 + p.minute)) * 60000 - 1000);
}

/** One enrollment as a power-dialer work item: the current step with merge fields already filled in. */
function sessionItem(e, user, now = new Date()) {
  const steps = e.sequence.steps;
  const step = steps[e.currentStep];
  const { contacts, ...carrier } = e.carrier;
  const base = {
    enrollmentId: e.id, status: e.status, dueAt: e.nextStepAt, carrier,
    sequence: { id: e.sequence.id, name: e.sequence.name, stepCount: steps.length },
    callWindow: callWindow(carrier.timezone || timezoneForState(carrier.state), now),
  };
  if (!step || e.status !== 'active') return { ...base, step: null };
  const out = { ...base, step: { index: e.currentStep, number: e.currentStep + 1, type: step.type, day: step.dayOffset + 1, instructions: step.instructions } };
  if (step.type === 'email') {
    const r = renderContent({ subject: step.subject ?? step.template?.subject ?? '', body: step.body ?? step.template?.body ?? '', carrier: e.carrier, user });
    out.email = { to: carrier.email, subject: r.subject, body: r.body, blocked: carrier.doNotEmail ? 'Carrier is marked do-not-email' : null };
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
  res.json({
    sequence: { id: seq.id, name: seq.name, active: seq.active },
    items: pick.map((e) => sessionItem(e, req.user, now)).filter((i) => i.step),
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
  // Claim the step first so the scheduler cannot send the same step in parallel.
  const claimed = await prisma.sequenceEnrollment.updateMany({ where: { id: e.id, currentStep: e.currentStep, status: 'active' }, data: { nextStepAt: new Date(Date.now() + 3600000) } });
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
    await advanceEnrollment(e.id);
    await logActivity(req.user, { type: 'sequence', carrierId: e.carrierId, summary: `Sent step ${e.currentStep + 1} (email) of "${e.sequence.name}" to ${e.carrier.companyName}` });
  } else {
    // Not sent: put the step back on its schedule so nothing is lost.
    await prisma.sequenceEnrollment.update({ where: { id: e.id }, data: { nextStepAt: e.nextStepAt } });
  }
  const fresh = await prisma.sequenceEnrollment.findUnique({ where: { id: e.id }, include: sessionInclude });
  res.status(ok ? 200 : 502).json({ outcome: result.outcome, message: result.message, error: ok ? undefined : result.message, item: sessionItem(fresh, req.user) });
}));

r.post('/enrollments/:eid/:action', ah(async (req, res) => {
  const { action } = parse(z.object({ action: z.enum(['pause', 'resume', 'stop', 'complete-step', 'skip-step']) }), req.params);
  const e = await loadEnrollment(req);
  const now = new Date();
  let updated;
  if (action === 'pause') {
    if (e.status !== 'active') throw badRequest('Only active enrollments can be paused');
    updated = await prisma.sequenceEnrollment.update({ where: { id: e.id }, data: { status: 'paused' } });
  } else if (action === 'resume') {
    if (e.status !== 'paused') throw badRequest('Only paused enrollments can be resumed');
    const step = e.sequence.steps[e.currentStep];
    const nextStepAt = step ? stepDueAt(e.sequence, step, e.startedAt, e.carrier, now) : null;
    updated = await prisma.sequenceEnrollment.update({ where: { id: e.id }, data: { status: step ? 'active' : 'completed', nextStepAt, completedAt: step ? null : now } });
  } else if (action === 'stop') {
    updated = await prisma.sequenceEnrollment.update({ where: { id: e.id }, data: { status: 'stopped', stopReason: 'stopped_by_user', nextStepAt: null } });
  } else {
    if (e.status !== 'active') throw badRequest('Enrollment is not active');
    const step = e.sequence.steps[e.currentStep];
    updated = await advanceEnrollment(e.id, { now });
    await logActivity(req.user, {
      type: 'sequence', carrierId: e.carrierId,
      summary: `${action === 'skip-step' ? 'Skipped' : 'Completed'} step ${e.currentStep + 1} (${step?.type}) of "${e.sequence.name}" for ${e.carrier.companyName}`,
    });
  }
  const fresh = await prisma.sequenceEnrollment.findUnique({ where: { id: updated.id }, include: { sequence: { include: { steps: { orderBy: { order: 'asc' } } } }, carrier: { select: { id: true, companyName: true, phone: true, state: true } } } });
  res.json({ enrollment: shapeEnrollment(fresh) });
}));

r.get('/:id', ah(async (req, res) => {
  const seq = await loadOwned('emailSequence', req.user, req.params.id, { include: stepInclude });
  const counts = await prisma.sequenceEnrollment.groupBy({ by: ['status'], where: { sequenceId: seq.id }, _count: { _all: true } });
  const emailStats = await prisma.email.groupBy({ by: ['status'], where: { enrollment: { sequenceId: seq.id } }, _count: { _all: true } });
  res.json({
    sequence: seq,
    enrollments: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    emails: Object.fromEntries(emailStats.map((c) => [c.status, c._count._all])),
  });
}));

r.put('/:id', requirePermission('automation.use'), ah(async (req, res) => {
  const seq = await loadOwned('emailSequence', req.user, req.params.id, { write: true });
  const body = parse(sequenceSchema, req.body);
  const steps = await validateSteps(req.user, body.steps);
  const { steps: _s, ...fields } = body;
  await prisma.$transaction([
    prisma.sequenceStep.deleteMany({ where: { sequenceId: seq.id } }),
    prisma.emailSequence.update({ where: { id: seq.id }, data: { ...fields, steps: { create: steps } } }),
  ]);
  // Re-time active enrollments against the new steps; finish those past the last step.
  const updated = await prisma.emailSequence.findUnique({ where: { id: seq.id }, include: stepInclude });
  const active = await prisma.sequenceEnrollment.findMany({ where: { sequenceId: seq.id, status: 'active' }, include: { carrier: true } });
  const now = new Date();
  for (const e of active) {
    const step = updated.steps[e.currentStep];
    if (!step) await prisma.sequenceEnrollment.update({ where: { id: e.id }, data: { status: 'completed', completedAt: now, nextStepAt: null } });
    else await prisma.sequenceEnrollment.update({ where: { id: e.id }, data: { nextStepAt: stepDueAt(updated, step, e.startedAt, e.carrier, now) } });
  }
  res.json({ sequence: updated });
}));

r.delete('/:id', requirePermission('automation.use'), ah(async (req, res) => {
  const seq = await loadOwned('emailSequence', req.user, req.params.id, { write: true });
  await prisma.emailSequence.delete({ where: { id: seq.id } });
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
