import { describe, it, expect, beforeAll } from 'vitest';
import { registerUser, prisma } from './helpers.js';

describe('prospecting, sequences, calls and follow-ups', () => {
  let A; let B; let c1; let c2; let seqId;

  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    c1 = (await A.agent.post('/api/carriers').send({ companyName: 'Prairie Freight', phone: '3165550111', state: 'KS', email: 'p@prairie.test' })).body.carrier;
    c2 = (await A.agent.post('/api/carriers').send({ companyName: 'Coastal Carriers', phone: '9045550112', state: 'FL' })).body.carrier;
  });

  it('manages prospect lists and moves leads into prospecting', async () => {
    const list = await A.agent.post('/api/prospecting/lists').send({ name: 'Kansas owner-operators' });
    expect(list.status).toBe(201);
    const add = await A.agent.post(`/api/prospecting/lists/${list.body.list.id}/items`).send({ carrierIds: [c1.id, c2.id] });
    expect(add.body.added).toBe(2);
    const detail = await A.agent.get(`/api/prospecting/lists/${list.body.list.id}`);
    expect(detail.body.total).toBe(2);
    expect(detail.body.items[0].carrier.stage.key).toBe('prospecting');
    const lists = await A.agent.get('/api/prospecting/lists');
    expect(lists.body.items[0].count).toBe(2);
    expect((await B.agent.get(`/api/prospecting/lists/${list.body.list.id}`)).status).toBe(404);
    expect((await A.agent.delete(`/api/prospecting/lists/${list.body.list.id}/items/${c2.id}`)).status).toBe(200);
  });

  it('creates a sequence with ordered steps and validates email steps', async () => {
    const bad = await A.agent.post('/api/sequences').send({ name: 'Bad', steps: [{ dayOffset: 0, type: 'email' }] });
    expect(bad.status).toBe(400);
    const res = await A.agent.post('/api/sequences').send({
      name: 'New authority outreach', respectBusinessHours: false,
      steps: [
        { dayOffset: 3, type: 'call', instructions: 'Second call' },
        { dayOffset: 0, type: 'call', instructions: 'Intro call' },
        { dayOffset: 1, type: 'email', subject: 'Following up', body: 'Hi {{companyName}}' },
        { dayOffset: 6, type: 'task', instructions: 'Final follow-up' },
      ],
    });
    expect(res.status).toBe(201);
    seqId = res.body.sequence.id;
    expect(res.body.sequence.steps.map((s) => s.dayOffset)).toEqual([0, 1, 3, 6]);
    // Free plan allows one sequence.
    const second = await A.agent.post('/api/sequences').send({ name: 'Two', steps: [{ dayOffset: 0, type: 'call' }] });
    expect(second.status).toBe(402);
    expect((await B.agent.get(`/api/sequences/${seqId}`)).status).toBe(404);
  });

  it('enrolls carriers, skips already-enrolled, and shows the first call in the queue', async () => {
    const res = await A.agent.post(`/api/sequences/${seqId}/enroll`).send({ carrierIds: [c1.id, c2.id] });
    expect(res.body).toMatchObject({ enrolled: 2, skipped: 0 });
    const again = await A.agent.post(`/api/sequences/${seqId}/enroll`).send({ carrierIds: [c1.id] });
    expect(again.body).toMatchObject({ enrolled: 0, skipped: 1 });
    const carrier = await prisma.carrier.findUnique({ where: { id: c1.id }, include: { stage: true } });
    expect(carrier.stage.key).toBe('sequence');
    const queue = await A.agent.get('/api/prospecting/queue');
    expect(queue.status).toBe(200);
    const item = queue.body.items.find((i) => i.carrier.id === c1.id && i.kind === 'sequence');
    expect(item.sequence).toMatchObject({ stepNumber: 1, type: 'call', day: 1 });
    expect(item.callWindow.timezone).toBe('America/Chicago');
    // Other user's queue never shows A's carriers.
    const qb = await B.agent.get('/api/prospecting/queue');
    expect(qb.body.items.length).toBe(0);
  });

  it('logs a no-answer call: activity, follow-up and sequence advance', async () => {
    const res = await A.agent.post('/api/calls').send({ carrierId: c1.id, outcome: 'no_answer', notes: 'Rang out', durationSec: 30 });
    expect(res.status).toBe(201);
    expect(res.body.followUp).not.toBeNull();
    const enr = await prisma.sequenceEnrollment.findFirst({ where: { carrierId: c1.id } });
    expect(enr.currentStep).toBe(1);
    const acts = await prisma.activity.findMany({ where: { carrierId: c1.id, type: 'call' } });
    expect(acts.length).toBe(1);
    const c = await prisma.carrier.findUnique({ where: { id: c1.id } });
    expect(c.lastContactedAt).not.toBeNull();
    expect(c.nextFollowUpAt).not.toBeNull();
    const calls = await A.agent.get(`/api/calls?carrierId=${c1.id}`);
    expect(calls.body.items[0].outcome).toBe('no_answer');
  });

  it('interested call moves to opportunity and completes the sequence', async () => {
    const res = await A.agent.post('/api/calls').send({ carrierId: c1.id, outcome: 'interested', autoFollowUp: false });
    expect(res.body.stage.key).toBe('opportunity');
    const enr = await prisma.sequenceEnrollment.findFirst({ where: { carrierId: c1.id } });
    expect(enr.status).toBe('completed');
    expect(await prisma.opportunity.findUnique({ where: { carrierId: c1.id } })).not.toBeNull();
  });

  it('not-interested call stops sequences and tags; archive is opt-in', async () => {
    const res = await A.agent.post('/api/calls').send({ carrierId: c2.id, outcome: 'not_interested', archive: true });
    expect(res.body.stage.key).toBe('archived');
    const enr = await prisma.sequenceEnrollment.findFirst({ where: { carrierId: c2.id } });
    expect(enr.status).toBe('stopped');
    const tags = await prisma.carrierTag.findMany({ where: { carrierId: c2.id }, include: { tag: true } });
    expect(tags.map((t) => t.tag.name)).toContain('Not interested');
  });

  it('pauses, resumes, completes and stops enrollments', async () => {
    const c3 = (await A.agent.post('/api/carriers').send({ companyName: 'Desert Haul', state: 'AZ' })).body.carrier;
    await A.agent.post(`/api/sequences/${seqId}/enroll`).send({ carrierIds: [c3.id] });
    const list = await A.agent.get(`/api/sequences/${seqId}/enrollments?status=active`);
    const e = list.body.items.find((x) => x.carrier.id === c3.id);
    expect((await A.agent.post(`/api/sequences/enrollments/${e.id}/pause`)).body.enrollment.status).toBe('paused');
    expect((await A.agent.post(`/api/sequences/enrollments/${e.id}/resume`)).body.enrollment.status).toBe('active');
    const done = await A.agent.post(`/api/sequences/enrollments/${e.id}/complete-step`);
    expect(done.body.enrollment.currentStep).toBe(1);
    expect(done.body.enrollment.step.type).toBe('email');
    expect((await B.agent.post(`/api/sequences/enrollments/${e.id}/stop`)).status).toBe(404);
    expect((await A.agent.post(`/api/sequences/enrollments/${e.id}/stop`)).body.enrollment.status).toBe('stopped');
  });

  it('updates sequence steps and re-times enrollments', async () => {
    const res = await A.agent.put(`/api/sequences/${seqId}`).send({ name: 'Renamed', respectBusinessHours: false, steps: [{ dayOffset: 0, type: 'call' }, { dayOffset: 2, type: 'task', instructions: 'LinkedIn' }] });
    expect(res.status).toBe(200);
    expect(res.body.sequence.steps.length).toBe(2);
    const detail = await A.agent.get(`/api/sequences/${seqId}`);
    expect(detail.body.sequence.name).toBe('Renamed');
  });

  it('follow-ups: create, list by range, complete, delete, isolation', async () => {
    const due = new Date(Date.now() - 3600000).toISOString();
    const res = await A.agent.post('/api/follow-ups').send({ carrierId: c1.id, dueAt: due, type: 'email', note: 'Send packet' });
    expect(res.status).toBe(201);
    const id = res.body.followUp.id;
    const overdue = await A.agent.get('/api/follow-ups?range=overdue');
    expect(overdue.body.items.map((f) => f.id)).toContain(id);
    expect(overdue.body.counts.overdue).toBeGreaterThanOrEqual(1);
    expect((await B.agent.post(`/api/follow-ups/${id}/complete`)).status).toBe(404);
    expect((await B.agent.post('/api/follow-ups').send({ carrierId: c1.id, dueAt: due })).status).toBe(404);
    const patched = await A.agent.patch(`/api/follow-ups/${id}`).send({ note: 'Send carrier packet' });
    expect(patched.body.followUp).toMatchObject({ note: 'Send carrier packet', type: 'email' });
    expect((await A.agent.post(`/api/follow-ups/${id}/complete`)).body.followUp.status).toBe('done');
    expect((await A.agent.post(`/api/follow-ups/${id}/complete`)).status).toBe(400);
    expect((await A.agent.delete(`/api/follow-ups/${id}`)).status).toBe(200);
  });

  it('converted call creates a customer', async () => {
    const res = await A.agent.post('/api/calls').send({ carrierId: c1.id, outcome: 'converted' });
    expect(res.body.stage.key).toBe('customer');
    expect(await prisma.customer.findUnique({ where: { carrierId: c1.id } })).not.toBeNull();
  });

  it('runs automations on call outcome', async () => {
    const c4 = (await A.agent.post('/api/carriers').send({ companyName: 'Auto Test Co', state: 'TX' })).body.carrier;
    await prisma.automation.create({ data: { ownerId: A.user.id, name: 'Tag voicemails', trigger: 'call_outcome', triggerValue: 'voicemail', action: 'add_tag', actionValue: 'Left VM' } });
    await A.agent.post('/api/calls').send({ carrierId: c4.id, outcome: 'voicemail' });
    const tags = await prisma.carrierTag.findMany({ where: { carrierId: c4.id }, include: { tag: true } });
    expect(tags.map((t) => t.tag.name)).toContain('Left VM');
  });
});
