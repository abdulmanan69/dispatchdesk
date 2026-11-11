import { describe, it, expect } from 'vitest';
import { registerUser, prisma } from './helpers.js';

const { logCall } = await import('../src/services/calls.js');
const { enrollCarriers, ENROLL_BATCH } = await import('../src/services/sequenceEngine.js');

let n = 0;
async function makeCarrier(ownerId) {
  const stage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
  n += 1;
  return prisma.carrier.create({
    data: { ownerId, stageId: stage.id, companyName: `Outcome Carrier ${n}`, state: 'TX', phone: `512555${String(1000 + n).slice(-4)}`, email: `oc${n}.${Date.now()}@carrier.test` },
  });
}

// Created directly: the free plan allows one sequence, and these tests need several per user.
async function sequence(owner, steps, name = `Seq ${Date.now()} ${Math.random().toString(36).slice(2, 7)}`) {
  return prisma.emailSequence.create({
    data: { ownerId: owner.user.id, name, respectBusinessHours: false, steps: { create: steps.map((st, i) => ({ order: i, ...st })) } },
  });
}

const fullUser = (id) => prisma.user.findUnique({ where: { id }, include: { teamMembership: true } });
const stageKey = async (carrierId) => (await prisma.carrier.findUnique({ where: { id: carrierId }, include: { stage: true } })).stage.key;

describe('call outcomes: do not call and wrong number', () => {
  it('do-not-call turns the flag on, stops active and paused sequences and cancels call and text follow-ups in one go', async () => {
    const A = await registerUser();
    const c = await makeCarrier(A.user.id);
    const calls = await sequence(A, [{ dayOffset: 0, type: 'call', instructions: 'Call' }, { dayOffset: 2, type: 'email', subject: 'Hi', body: 'Hello' }]);
    const other = await sequence(A, [{ dayOffset: 0, type: 'task', instructions: 'Research' }]);
    expect((await A.agent.post(`/api/sequences/${calls.id}/enroll`).send({ carrierIds: [c.id] })).body.enrolled).toBe(1);
    expect((await A.agent.post(`/api/sequences/${other.id}/enroll`).send({ carrierIds: [c.id] })).body.enrolled).toBe(1);
    const paused = await prisma.sequenceEnrollment.findFirst({ where: { carrierId: c.id, sequenceId: other.id } });
    expect((await A.agent.post(`/api/sequences/enrollments/${paused.id}/pause`).send({})).status).toBe(200);
    const due = new Date(Date.now() + 2 * 86400000).toISOString();
    const fu = {};
    for (const type of ['call', 'text', 'email']) {
      fu[type] = (await A.agent.post('/api/follow-ups').send({ carrierId: c.id, dueAt: due, type })).body.followUp;
    }

    const res = await A.agent.post('/api/calls').send({ carrierId: c.id, outcome: 'do_not_call', notes: 'Asked to be removed' });
    expect(res.status).toBe(201);
    expect(res.body.doNotCall).toBe(true);
    expect(res.body.followUp).toBeNull();

    expect((await prisma.carrier.findUnique({ where: { id: c.id } })).doNotCall).toBe(true);
    const enrollments = await prisma.sequenceEnrollment.findMany({ where: { carrierId: c.id } });
    expect(enrollments).toHaveLength(2);
    for (const e of enrollments) expect(e).toMatchObject({ status: 'stopped', stopReason: 'do_not_call', nextStepAt: null });
    const after = Object.fromEntries(await Promise.all(Object.entries(fu).map(async ([k, f]) => [k, (await prisma.followUp.findUnique({ where: { id: f.id } })).status])));
    expect(after).toEqual({ call: 'canceled', text: 'canceled', email: 'pending' });
    const note = await prisma.activity.findFirst({ where: { carrierId: c.id, summary: { startsWith: 'Do-not-call requested on a call at ' } } });
    expect(note).not.toBeNull();
    expect(note.summary).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // The carrier's queue no longer shows it, and the follow-up list carries the flag for the Text action.
    const list = await A.agent.get('/api/follow-ups').query({ carrierId: c.id, status: 'all' });
    expect(list.body.items.length).toBeGreaterThan(0);
    for (const item of list.body.items) expect(item.carrier.doNotCall).toBe(true);
  });

  it('wrong number and do-not-call never count as a first call (no lead -> prospecting move)', async () => {
    const A = await registerUser();
    const wrong = await makeCarrier(A.user.id);
    const dnc = await makeCarrier(A.user.id);
    const reached = await makeCarrier(A.user.id);
    const w = await A.agent.post('/api/calls').send({ carrierId: wrong.id, outcome: 'wrong_number' });
    expect(w.status).toBe(201);
    expect(w.body).toMatchObject({ doNotCall: false, stage: { key: 'lead' } });
    expect((await prisma.carrier.findUnique({ where: { id: wrong.id } })).doNotCall).toBe(false);
    expect((await A.agent.post('/api/calls').send({ carrierId: dnc.id, outcome: 'do_not_call' })).body.stage.key).toBe('lead');
    expect((await A.agent.post('/api/calls').send({ carrierId: reached.id, outcome: 'no_answer' })).body.stage.key).toBe('prospecting');
    expect(await stageKey(wrong.id)).toBe('lead');
    expect(await stageKey(dnc.id)).toBe('lead');
  });

  it('wrong number stops sequences that still call or text, and keeps email-only ones running', async () => {
    const A = await registerUser();
    const c = await makeCarrier(A.user.id);
    const phone = await sequence(A, [{ dayOffset: 0, type: 'email', subject: 'Hi', body: 'Hello' }, { dayOffset: 1, type: 'text', body: 'Still running trucks?' }]);
    const mail = await sequence(A, [{ dayOffset: 0, type: 'email', subject: 'Hi', body: 'Hello' }, { dayOffset: 3, type: 'email', subject: 'Again', body: 'Hello again' }]);
    await A.agent.post(`/api/sequences/${phone.id}/enroll`).send({ carrierIds: [c.id] });
    await A.agent.post(`/api/sequences/${mail.id}/enroll`).send({ carrierIds: [c.id] });

    const res = await A.agent.post('/api/calls').send({ carrierId: c.id, outcome: 'wrong_number' });
    expect(res.status).toBe(201);
    const byseq = Object.fromEntries((await prisma.sequenceEnrollment.findMany({ where: { carrierId: c.id } })).map((e) => [e.sequenceId, e]));
    expect(byseq[phone.id]).toMatchObject({ status: 'stopped', stopReason: 'wrong_number', nextStepAt: null });
    expect(byseq[mail.id]).toMatchObject({ status: 'active', currentStep: 0 });
  });
});

describe('telephony attempt claim', () => {
  it('links a dial attempt to one call only; a second log of the same attempt leaves no extra call behind', async () => {
    const A = await registerUser();
    const user = await fullUser(A.user.id);
    const carrier = await makeCarrier(A.user.id);
    const attempt = await prisma.callAttempt.create({ data: { userId: A.user.id, carrierId: carrier.id, provider: 'twilio', toNumber: '+15125550100', status: 'no_answer' } });

    const first = await logCall(user, carrier, { outcome: 'no_answer', automatic: true }, { attempt });
    expect((await prisma.callAttempt.findUnique({ where: { id: attempt.id } })).callId).toBe(first.call.id);
    const calls = await prisma.call.count({ where: { carrierId: carrier.id } });
    const activities = await prisma.activity.count({ where: { carrierId: carrier.id, type: 'call' } });

    // The dispatcher's Save raced the automatic log with the attempt it read before the link was written.
    await expect(logCall(user, carrier, { outcome: 'voicemail' }, { attempt })).rejects.toMatchObject({ status: 400, message: 'This call was already logged' });
    expect(await prisma.call.count({ where: { carrierId: carrier.id } })).toBe(calls);
    expect(await prisma.activity.count({ where: { carrierId: carrier.id, type: 'call' } })).toBe(activities);
    expect((await prisma.callAttempt.findUnique({ where: { id: attempt.id } })).callId).toBe(first.call.id);
  });
});

describe('batched enrollment', () => {
  it('enrolls many carriers in batches, skipping repeats and running enrollments, restarting stopped ones', async () => {
    const A = await registerUser();
    const user = await fullUser(A.user.id);
    const seq = await sequence(A, [{ dayOffset: 0, type: 'call', instructions: 'Call' }]);
    const lead = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
    const customer = await prisma.pipelineStage.findUnique({ where: { key: 'customer' } });
    const total = ENROLL_BATCH * 2 + 25;
    await prisma.carrier.createMany({
      data: Array.from({ length: total }, (_, i) => ({ ownerId: A.user.id, stageId: i === 0 ? customer.id : lead.id, companyName: `Batch ${i}`, state: 'TX' })),
    });
    const carriers = await prisma.carrier.findMany({ where: { ownerId: A.user.id, companyName: { startsWith: 'Batch ' } } });
    expect(carriers).toHaveLength(total);
    const named = (i) => carriers.find((c) => c.companyName === `Batch ${i}`);
    const running = named(1);
    const stopped = named(2);
    await prisma.sequenceEnrollment.create({ data: { sequenceId: seq.id, carrierId: running.id, userId: A.user.id, status: 'active', currentStep: 0, nextStepAt: new Date() } });
    const old = await prisma.sequenceEnrollment.create({
      data: { sequenceId: seq.id, carrierId: stopped.id, userId: A.user.id, status: 'stopped', stopReason: 'replied', currentStep: 1, nextStepAt: null, startedAt: new Date(Date.now() - 30 * 86400000) },
    });

    const input = [...carriers, carriers[5], carriers[ENROLL_BATCH + 3]]; // two repeats, one of them in a later batch
    const out = await enrollCarriers(user, seq.id, input);
    expect(out).toEqual({ enrolled: total - 1, skipped: 3 });

    const rows = await prisma.sequenceEnrollment.findMany({ where: { sequenceId: seq.id } });
    expect(rows).toHaveLength(total);
    expect(rows.every((r) => r.status === 'active' && r.userId === A.user.id)).toBe(true);
    const restarted = rows.find((r) => r.id === old.id);
    expect(restarted).toMatchObject({ currentStep: 0, stopReason: null, completedAt: null });
    expect(restarted.startedAt.getTime()).toBeGreaterThan(Date.now() - 60000);

    // lead -> sequence for everyone enrolled; the customer stays a customer; one timeline entry per enrollment.
    const stages = await prisma.carrier.groupBy({ by: ['stageId'], where: { ownerId: A.user.id, companyName: { startsWith: 'Batch ' } }, _count: true });
    const seqStage = await prisma.pipelineStage.findUnique({ where: { key: 'sequence' } });
    const counts = Object.fromEntries(stages.map((s) => [s.stageId, s._count]));
    expect(counts[customer.id]).toBe(1);
    expect(counts[seqStage.id]).toBe(total - 2); // the already-running carrier was skipped and keeps its stage
    expect(await prisma.activity.count({ where: { userId: A.user.id, type: 'sequence', summary: { contains: `in sequence "${seq.name}"` } } })).toBe(total - 1);

    // Enrolling again changes nothing.
    expect(await enrollCarriers(user, seq.id, carriers.slice(0, 10))).toEqual({ enrolled: 0, skipped: 10 });
  });
});
