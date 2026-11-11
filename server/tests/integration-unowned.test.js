// Cross-group follow-ups in shared files: automations PATCH, do-not-call automations, extension zip caching,
// versioned training avatars and the customer stage marking a carrier as fleet.
import { describe, it, expect } from 'vitest';
import { registerUser, createAdmin, prisma } from './helpers.js';
import { changeStage } from '../src/services/pipeline.js';
import { runAutomations } from '../src/services/automation.js';
import { avatarVersion } from '../src/middleware/auth.js';

async function makeCarrier(ownerId, data = {}) {
  const stage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
  return prisma.carrier.create({ data: { ownerId, stageId: stage.id, companyName: 'Integration Freight LLC', phone: '6145550188', state: 'OH', ...data } });
}
const fullUser = (id) => prisma.user.findUnique({ where: { id }, include: { teamMembership: true } });
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('automations PATCH', () => {
  it('changes only the fields sent (no schema defaults reapplied)', async () => {
    const { agent: a } = await registerUser();
    const created = await a.post('/api/automations').send({
      name: 'Check in', trigger: 'stage_changed', triggerValue: 'opportunity', action: 'create_follow_up', actionValue: 'Send agreement', delayDays: 3,
    });
    expect(created.status).toBe(201);
    const id = created.body.automation.id;

    const off = await a.patch(`/api/automations/${id}`).send({ active: false });
    expect(off.status).toBe(200);
    expect(off.body.automation).toMatchObject({ active: false, delayDays: 3, actionValue: 'Send agreement', triggerValue: 'opportunity' });

    const later = await a.patch(`/api/automations/${id}`).send({ delayDays: 5 });
    expect(later.status).toBe(200);
    expect(later.body.automation).toMatchObject({ active: false, delayDays: 5 });
  });
});

describe('automations and do-not-call carriers', () => {
  it('never creates a call follow-up for a do-not-call carrier, and does not count the run', async () => {
    const { agent: a, user } = await registerUser();
    const rule = await a.post('/api/automations').send({ name: 'Call again', trigger: 'call_outcome', action: 'create_follow_up', delayDays: 1 });
    expect(rule.status).toBe(201);
    const dnc = await makeCarrier(user.id, { doNotCall: true });

    const results = await runAutomations(await fullUser(user.id), 'call_outcome', { carrier: dnc, value: 'busy' });
    expect(results).toEqual([{ id: rule.body.automation.id, ok: true, skipped: 'do_not_call' }]);
    expect(await prisma.followUp.count({ where: { carrierId: dnc.id } })).toBe(0);
    expect((await prisma.automation.findUnique({ where: { id: rule.body.automation.id } })).runCount).toBe(0);

    // A partial carrier object (no doNotCall field) is checked against the database.
    const partial = { id: dnc.id, ownerId: dnc.ownerId, companyName: dnc.companyName, stageId: dnc.stageId };
    await runAutomations(await fullUser(user.id), 'call_outcome', { carrier: partial, value: 'busy' });
    expect(await prisma.followUp.count({ where: { carrierId: dnc.id } })).toBe(0);

    // Callable carriers still get the follow-up.
    const ok = await makeCarrier(user.id);
    await runAutomations(await fullUser(user.id), 'call_outcome', { carrier: ok, value: 'busy' });
    expect(await prisma.followUp.count({ where: { carrierId: ok.id, type: 'call' } })).toBe(1);
  });

  it('a do_not_call call outcome leaves no pending call follow-up even with an "any outcome" automation', async () => {
    const { agent: a, user } = await registerUser();
    await a.post('/api/automations').send({ name: 'After every call', trigger: 'call_outcome', action: 'create_follow_up', delayDays: 2 }).expect(201);
    const carrier = await makeCarrier(user.id);
    const res = await a.post('/api/calls').send({ carrierId: carrier.id, outcome: 'do_not_call' });
    expect(res.status).toBe(201);
    expect(res.body.doNotCall).toBe(true);
    expect((await prisma.carrier.findUnique({ where: { id: carrier.id } })).doNotCall).toBe(true);
    expect(await prisma.followUp.count({ where: { carrierId: carrier.id, status: 'pending' } })).toBe(0);
  });
});

describe('browser extension zip caching', () => {
  it('serves the same build with an ETag, a private one-hour cache and 304 for a matching If-None-Match', async () => {
    const { agent: a } = await registerUser();
    const first = await a.get('/api/extension/download').buffer(true).parse(binary);
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('private, max-age=3600');
    const etag = first.headers.etag;
    expect(etag).toMatch(/^"[\w-]+"$/);

    const again = await a.get('/api/extension/download').buffer(true).parse(binary);
    expect(again.headers.etag).toBe(etag);
    expect(Buffer.compare(again.body, first.body)).toBe(0);

    const cached = await a.get('/api/extension/download').set('If-None-Match', etag);
    expect(cached.status).toBe(304);
    expect(cached.headers.etag).toBe(etag);

    const stale = await a.get('/api/extension/download').set('If-None-Match', '"something-else"').buffer(true).parse(binary);
    expect(stale.status).toBe(200);
  });
});

describe('training avatars', () => {
  it('uses versioned avatar URLs for message authors and the trainer inbox', async () => {
    const student = await registerUser();
    await prisma.user.update({ where: { id: student.user.id }, data: { avatarPath: 'avatars/integration-test.png' } });
    const expected = `/api/profile/avatar/${student.user.id}?v=${avatarVersion('avatars/integration-test.png')}`;

    const sent = await student.agent.post('/api/training/messages').send({ body: 'How do I read a rate confirmation?' });
    expect(sent.status).toBe(201);
    expect(sent.body.message.author).toEqual({ id: student.user.id, name: student.user.name, avatarUrl: expected });

    const mine = await student.agent.get('/api/training/messages');
    expect(mine.body.items.at(-1).author.avatarUrl).toBe(expected);

    const admin = await createAdmin();
    const threads = await admin.agent.get('/api/training/admin/threads');
    expect(threads.status).toBe(200);
    expect(threads.body.items.find((t) => t.userId === student.user.id).avatarUrl).toBe(expected);

    const thread = await admin.agent.get(`/api/training/admin/threads/${student.user.id}`);
    expect(thread.body.items.at(-1).author.avatarUrl).toBe(expected);
    // Author rows carry only what the response needs (no password hash or email).
    expect(Object.keys(thread.body.items.at(-1).author).sort()).toEqual(['avatarUrl', 'id', 'name']);
  });
});

describe('customer stage', () => {
  it('marks the carrier as a fleet truck when it becomes a customer', async () => {
    const { user } = await registerUser();
    const carrier = await makeCarrier(user.id);
    expect(carrier.isFleet).toBe(false);
    await changeStage(await fullUser(user.id), carrier, 'customer');
    const after = await prisma.carrier.findUnique({ where: { id: carrier.id }, include: { customer: true } });
    expect(after.isFleet).toBe(true);
    expect(after.customer?.status).toBe('active');
  });
});
