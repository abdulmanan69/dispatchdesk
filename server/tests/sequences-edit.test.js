import { describe, it, expect, vi } from 'vitest';

const mail = vi.hoisted(() => ({ sendMail: vi.fn(async (m) => ({ messageId: m.messageId, accepted: [m.to], rejected: [] })) }));
vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => ({ verify: async () => true, sendMail: mail.sendMail, close: () => {} }));
  return { default: { createTransport }, createTransport };
});

const { registerUser, prisma } = await import('./helpers.js');
const { runFastTick } = await import('../src/jobs/scheduler.js');
const { matchSteps } = await import('../src/routes/sequences.js');

let n = 0;
async function makeCarrier(a) {
  n += 1;
  return (await a.post('/api/carriers').send({ companyName: `Edit Carrier ${n}`, email: `edit${n}.${Date.now()}@carrier.test`, phone: `5550${String(100000 + n).slice(-6)}` })).body.carrier;
}

const base = { name: 'Edit me', respectBusinessHours: false };
const STEPS = [
  { dayOffset: 0, type: 'call', instructions: 'Intro call' },
  { dayOffset: 2, type: 'email', subject: 'Following up', body: 'Hi {{first_name}}' },
  { dayOffset: 5, type: 'call', instructions: 'Final call' },
];

async function enrollmentStep(carrierId) {
  const e = await prisma.sequenceEnrollment.findFirst({ where: { carrierId } });
  return { index: e.currentStep, status: e.status, e };
}

describe('editing a running sequence', () => {
  it('keeps carriers on the same step when steps are inserted, moved or removed', async () => {
    const A = await registerUser();
    const created = await A.agent.post('/api/sequences').send({ ...base, steps: STEPS });
    expect(created.status).toBe(201);
    const seq = created.body.sequence;
    const ids = seq.steps.map((s) => s.id);
    const [c0, c1, c2] = [await makeCarrier(A.agent), await makeCarrier(A.agent), await makeCarrier(A.agent)];
    await A.agent.post(`/api/sequences/${seq.id}/enroll`).send({ carrierIds: [c0.id, c1.id, c2.id] });
    const list = (await A.agent.get(`/api/sequences/${seq.id}/enrollments?status=active`)).body.items;
    const eid = (cid) => list.find((x) => x.carrier.id === cid).id;
    expect((await A.agent.post(`/api/sequences/enrollments/${eid(c1.id)}/complete-step`).send({ stepIndex: 0 })).status).toBe(200);
    await A.agent.post(`/api/sequences/enrollments/${eid(c2.id)}/complete-step`).send({ stepIndex: 0 });
    await A.agent.post(`/api/sequences/enrollments/${eid(c2.id)}/skip-step`).send({ stepIndex: 1 });
    expect((await enrollmentStep(c1.id)).index).toBe(1);
    expect((await enrollmentStep(c2.id)).index).toBe(2);

    // Insert a step on day 1 (the editor sends the ids of existing steps).
    const withIds = seq.steps.map((s) => ({ id: s.id, dayOffset: s.dayOffset, type: s.type, subject: s.subject, body: s.body, instructions: s.instructions }));
    const put = await A.agent.put(`/api/sequences/${seq.id}`).send({ ...base, steps: [...withIds, { dayOffset: 1, type: 'task', instructions: 'LinkedIn' }] });
    expect(put.status).toBe(200);
    expect(put.body.sequence.steps.map((s) => s.id)).toEqual([ids[0], put.body.sequence.steps[1].id, ids[1], ids[2]]);
    expect(put.body.remapped.moved).toBe(2);
    expect((await enrollmentStep(c0.id)).index).toBe(0);
    expect((await enrollmentStep(c1.id)).index).toBe(2); // still on the email step
    expect((await enrollmentStep(c2.id)).index).toBe(3); // still on the final call

    // The same edit without ids (older editor): steps are matched by content.
    const noIds = put.body.sequence.steps.map(({ dayOffset, type, subject, body, instructions }) => ({ dayOffset, type, subject, body, instructions }));
    const again = await A.agent.put(`/api/sequences/${seq.id}`).send({ ...base, steps: noIds });
    expect(again.body.sequence.steps.map((s) => s.id)).toEqual(put.body.sequence.steps.map((s) => s.id));
    expect(again.body.remapped.moved).toBe(0);

    // Remove the email step: its carrier continues with the next step on or after that day.
    const withoutEmail = again.body.sequence.steps.filter((s) => s.type !== 'email').map(({ id, dayOffset, type, instructions }) => ({ id, dayOffset, type, instructions }));
    const removed = await A.agent.put(`/api/sequences/${seq.id}`).send({ ...base, steps: withoutEmail });
    expect(removed.status).toBe(200);
    expect((await enrollmentStep(c1.id)).index).toBe(2); // Final call (day 5)
    expect(removed.body.sequence.steps[2].instructions).toBe('Final call');

    // Remove the step a carrier is on when nothing follows it: that carrier completes.
    const firstTwo = removed.body.sequence.steps.slice(0, 2).map(({ id, dayOffset, type, instructions }) => ({ id, dayOffset, type, instructions }));
    const cut = await A.agent.put(`/api/sequences/${seq.id}`).send({ ...base, steps: firstTwo });
    expect(cut.body.remapped.completed).toBe(2);
    expect((await enrollmentStep(c2.id)).status).toBe('completed');
    expect((await enrollmentStep(c0.id)).index).toBe(0);
    const detail = await A.agent.get(`/api/sequences/${seq.id}`);
    expect(detail.body.midSequence).toBe(1);
  });

  it('remaps paused enrollments too, and refuses stale step actions with 409', async () => {
    const A = await registerUser();
    const seq = (await A.agent.post('/api/sequences').send({ ...base, steps: STEPS })).body.sequence;
    const c = await makeCarrier(A.agent);
    await A.agent.post(`/api/sequences/${seq.id}/enroll`).send({ carrierIds: [c.id] });
    const { e } = await enrollmentStep(c.id);
    expect((await A.agent.post(`/api/sequences/enrollments/${e.id}/complete-step`).send({ stepIndex: 1 })).status).toBe(409);
    await A.agent.post(`/api/sequences/enrollments/${e.id}/pause`).expect(200);
    const steps = seq.steps.map((s) => ({ id: s.id, dayOffset: s.dayOffset, type: s.type, subject: s.subject, body: s.body, instructions: s.instructions }));
    await A.agent.put(`/api/sequences/${seq.id}`).send({ ...base, steps: [{ dayOffset: 0, type: 'task', instructions: 'Research first' }, ...steps] }).expect(200);
    const after = await enrollmentStep(c.id);
    expect(after).toMatchObject({ index: 1, status: 'paused' });
    const B = await registerUser();
    expect((await B.agent.put(`/api/sequences/${seq.id}`).send({ ...base, steps })).status).toBe(404);
  });

  it('never sends an email step twice after an edit moves a carrier back onto it', async () => {
    const A = await registerUser();
    await A.agent.post('/api/email/accounts/smtp').send({ provider: 'hostinger', fromEmail: `seqedit${Date.now()}@dispatch.test`, password: 'pw', cooldownSeconds: 0 });
    const seq = (await A.agent.post('/api/sequences').send({ ...base, steps: [{ dayOffset: 0, type: 'email', subject: 'Hello', body: 'Hi' }, { dayOffset: 3, type: 'call', instructions: 'Call' }] })).body.sequence;
    const c = await makeCarrier(A.agent);
    await A.agent.post(`/api/sequences/${seq.id}/enroll`).send({ carrierIds: [c.id] });
    await runFastTick({ quiet: true });
    expect(await prisma.email.count({ where: { carrierId: c.id } })).toBe(1);
    expect((await enrollmentStep(c.id)).index).toBe(1);
    // New first step, and the email moved to day 3 (where the carrier is): the carrier lands on the email again.
    await A.agent.put(`/api/sequences/${seq.id}`).send({ ...base, steps: [{ dayOffset: 0, type: 'call', instructions: 'New intro' }, { dayOffset: 3, type: 'email', subject: 'Hello', body: 'Hi' }] }).expect(200);
    const { e } = await enrollmentStep(c.id);
    expect(e.currentStep).toBe(1);
    await prisma.sequenceEnrollment.update({ where: { id: e.id }, data: { nextStepAt: new Date(Date.now() - 60000) } });
    await runFastTick({ quiet: true });
    expect(await prisma.email.count({ where: { carrierId: c.id } })).toBe(1);
    expect((await enrollmentStep(c.id)).status).toBe('completed');
  });

  it('still sends a later email step that shares a subject line with an earlier one after an edit', async () => {
    const A = await registerUser();
    await A.agent.post('/api/email/accounts/smtp').send({ provider: 'hostinger', fromEmail: `samesubj${Date.now()}@dispatch.test`, password: 'pw', cooldownSeconds: 0 });
    const steps = [{ dayOffset: 0, type: 'email', subject: 'Trucks this week', body: 'First note' }, { dayOffset: 0, type: 'email', subject: 'Trucks this week', body: 'Second note' }];
    const seq = (await A.agent.post('/api/sequences').send({ ...base, steps })).body.sequence;
    const c = await makeCarrier(A.agent);
    await A.agent.post(`/api/sequences/${seq.id}/enroll`).send({ carrierIds: [c.id] });
    await runFastTick({ quiet: true });
    expect(await prisma.email.count({ where: { carrierId: c.id } })).toBe(1);
    // Any edit after the carrier started turns on the duplicate guard; it must not swallow the second, different email.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await A.agent.put(`/api/sequences/${seq.id}`).send({ ...base, name: 'Edited', steps: seq.steps.map(({ id, dayOffset, type, subject, body }) => ({ id, dayOffset, type, subject, body })) }).expect(200);
    const { e } = await enrollmentStep(c.id);
    await prisma.sequenceEnrollment.update({ where: { id: e.id }, data: { nextStepAt: new Date(Date.now() - 60000) } });
    await runFastTick({ quiet: true });
    const sent = await prisma.email.findMany({ where: { carrierId: c.id }, orderBy: { createdAt: 'asc' } });
    expect(sent.map((m) => m.body)).toEqual([expect.stringContaining('First note'), expect.stringContaining('Second note')]);
    expect((await enrollmentStep(c.id)).status).toBe('completed');
  });

  it('matches steps without ids by content first', () => {
    const old = [
      { id: 'a', type: 'call', dayOffset: 0, instructions: 'Intro', templateId: null, subject: null, body: null },
      { id: 'b', type: 'email', dayOffset: 2, instructions: null, templateId: null, subject: 'S', body: 'B' },
    ];
    expect(matchSteps(old, [{ type: 'email', dayOffset: 0, subject: 'S', body: 'B' }, { type: 'call', dayOffset: 2, instructions: 'Intro' }])).toEqual(['b', 'a']);
    expect(matchSteps(old, [{ type: 'task', dayOffset: 1, instructions: 'x' }])).toEqual([null]);
    expect(matchSteps(old, [{ id: 'zzz', type: 'call', dayOffset: 0, instructions: 'Intro' }])).toEqual([null]); // unknown ids are new steps
  });
});
