import { describe, it, expect } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { changeStage } from '../src/services/pipeline.js';
import { runAutomations } from '../src/services/automation.js';

async function makeCarrier(ownerId, data = {}) {
  const stage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
  return prisma.carrier.create({ data: { ownerId, stageId: stage.id, companyName: 'Auto Freight Inc', ...data } });
}
const fullUser = (id) => prisma.user.findUnique({ where: { id }, include: { teamMembership: true } });

describe('automations', () => {
  it('validates trigger/action values and enforces the plan limit', async () => {
    const { agent: a } = await registerUser();
    const bad = await a.post('/api/automations').send({ name: 'x', trigger: 'stage_changed', triggerValue: 'nowhere', action: 'notify', actionValue: 'hi' });
    expect(bad.status).toBe(400);
    const missing = await a.post('/api/automations').send({ name: 'x', trigger: 'carrier_created', action: 'move_stage' });
    expect(missing.status).toBe(400);
    const ok = await a.post('/api/automations').send({ name: 'Opp follow-up', trigger: 'stage_changed', triggerValue: 'opportunity', action: 'create_follow_up', actionValue: 'Send agreement', delayDays: 1 });
    expect(ok.status).toBe(201);
    // Free plan allows 1 automation by default.
    const second = await a.post('/api/automations').send({ name: 'Second', trigger: 'carrier_created', action: 'add_tag', actionValue: 'new' });
    expect(second.status).toBe(402);
  });

  it('rejects sequences owned by another user', async () => {
    const A = await registerUser();
    const B = await registerUser();
    const seqA = await prisma.emailSequence.create({ data: { ownerId: A.user.id, name: 'A seq' } });
    const res = await B.agent.post('/api/automations').send({ name: 'steal', trigger: 'carrier_created', action: 'enroll_sequence', actionValue: seqA.id });
    expect(res.status).toBe(400);
  });

  it('runs on stage change: creates a follow-up and records the run', async () => {
    const { agent: a, user } = await registerUser();
    const created = await a.post('/api/automations').send({ name: 'Opp follow-up', trigger: 'stage_changed', triggerValue: 'opportunity', action: 'create_follow_up', actionValue: 'Send agreement', delayDays: 2 });
    const carrier = await makeCarrier(user.id);
    await changeStage(await fullUser(user.id), carrier, 'opportunity');
    const fu = await prisma.followUp.findFirst({ where: { carrierId: carrier.id } });
    expect(fu.note).toBe('Send agreement');
    expect(fu.dueAt.getTime()).toBeGreaterThan(Date.now() + 86400000);
    const list = await a.get('/api/automations');
    expect(list.body.items.find((i) => i.id === created.body.automation.id).runCount).toBe(1);
  });

  it('add_tag and notify actions; inactive rules do not run', async () => {
    const { agent: a, user } = await registerUser();
    await prisma.plan.update({ where: { key: 'free' }, data: { maxAutomations: 5 } });
    try {
      await a.post('/api/automations').send({ name: 'Tag', trigger: 'call_outcome', triggerValue: 'interested', action: 'add_tag', actionValue: 'hot' }).expect(201);
      const n = await a.post('/api/automations').send({ name: 'Ping', trigger: 'call_outcome', triggerValue: 'interested', action: 'notify', actionValue: 'Interested carrier!' });
      await a.patch(`/api/automations/${n.body.automation.id}`).send({ active: false }).expect(200);
      const carrier = await makeCarrier(user.id);
      await runAutomations(await fullUser(user.id), 'call_outcome', { carrier, value: 'interested' });
      const tags = await prisma.carrierTag.findMany({ where: { carrierId: carrier.id }, include: { tag: true } });
      expect(tags.map((t) => t.tag.name)).toEqual(['hot']);
      expect(await prisma.notification.count({ where: { userId: user.id, type: 'automation' } })).toBe(0);
      await runAutomations(await fullUser(user.id), 'call_outcome', { carrier, value: 'busy' });
      expect(await prisma.carrierTag.count({ where: { carrierId: carrier.id } })).toBe(1);
    } finally {
      await prisma.plan.update({ where: { key: 'free' }, data: { maxAutomations: 1 } });
    }
  });

  it('move_stage loops are bounded', async () => {
    const { user } = await registerUser();
    await prisma.automation.createMany({
      data: [
        { ownerId: user.id, name: 'a', trigger: 'stage_changed', triggerValue: 'prospecting', action: 'move_stage', actionValue: 'sequence' },
        { ownerId: user.id, name: 'b', trigger: 'stage_changed', triggerValue: 'sequence', action: 'move_stage', actionValue: 'prospecting' },
      ],
    });
    const carrier = await makeCarrier(user.id);
    await changeStage(await fullUser(user.id), carrier, 'prospecting');
    const runs = await prisma.automation.findMany({ where: { ownerId: user.id } });
    expect(runs.reduce((s, r) => s + r.runCount, 0)).toBeLessThanOrEqual(4);
  });

  it('isolates automations between users', async () => {
    const A = await registerUser();
    const B = await registerUser();
    const rule = await A.agent.post('/api/automations').send({ name: 'Mine', trigger: 'carrier_created', action: 'add_tag', actionValue: 'new' });
    expect((await B.agent.patch(`/api/automations/${rule.body.automation.id}`).send({ active: false })).status).toBe(404);
    expect((await B.agent.delete(`/api/automations/${rule.body.automation.id}`)).status).toBe(404);
    expect((await B.agent.get('/api/automations')).body.items).toHaveLength(0);
  });

  it('standard users (no automation.use) are forbidden', async () => {
    const { agent: a } = await registerUser({ role: 'user' });
    expect((await a.get('/api/automations')).status).toBe(403);
  });
});
