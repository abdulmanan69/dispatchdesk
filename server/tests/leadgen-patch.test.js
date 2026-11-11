import { describe, it, expect, beforeAll } from 'vitest';
import { registerUser, prisma } from './helpers.js';

const criteria = { states: ['OH'], cargo: ['crgo_coldfood'], minPowerUnits: 1, maxPowerUnits: 10, requirePhone: true, requireMc: true };

describe('lead generator PATCH keeps settings it was not sent', () => {
  let P; let gen;
  beforeAll(async () => {
    P = await registerUser();
    const plan = await prisma.plan.findUnique({ where: { key: 'pro' } });
    await prisma.subscription.create({ data: { userId: P.user.id, planId: plan.id, status: 'active', seats: 1 } });
    const res = await P.agent.post('/api/lead-generators').send({
      name: 'Weekly OH', criteria, batchSize: 10, stageKey: 'prospecting', minScore: 60, autoRun: true, frequency: 'weekly',
    });
    expect(res.status).toBe(201);
    gen = res.body.generator;
  });

  it('toggling scheduled runs does not reset batch size, stage, minimum score or frequency', async () => {
    const off = await P.agent.patch(`/api/lead-generators/${gen.id}`).send({ autoRun: false });
    expect(off.status).toBe(200);
    expect(off.body.generator).toMatchObject({ autoRun: false, batchSize: 10, stageKey: 'prospecting', minScore: 60, frequency: 'weekly', nextRunAt: null });
    const on = await P.agent.patch(`/api/lead-generators/${gen.id}`).send({ autoRun: true });
    expect(on.body.generator).toMatchObject({ autoRun: true, batchSize: 10, stageKey: 'prospecting', minScore: 60, frequency: 'weekly' });
    // Weekly again: the next run is about a week out, not a day.
    expect(new Date(on.body.generator.nextRunAt).getTime() - Date.now()).toBeGreaterThan(6 * 86400000);
  });

  it('pausing and renaming touch only those fields', async () => {
    await P.agent.patch(`/api/lead-generators/${gen.id}`).send({ active: false });
    await P.agent.patch(`/api/lead-generators/${gen.id}`).send({ name: 'Renamed' });
    const row = await prisma.leadGenerator.findUnique({ where: { id: gen.id } });
    expect(row).toMatchObject({ name: 'Renamed', active: false, batchSize: 10, stageKey: 'prospecting', minScore: 60, frequency: 'weekly', autoRun: true });
    expect(JSON.parse(row.criteria).states).toEqual(['OH']);
  });

  it('still validates what is sent and creates with defaults', async () => {
    expect((await P.agent.patch(`/api/lead-generators/${gen.id}`).send({ batchSize: 0 })).status).toBe(400);
    expect((await P.agent.patch(`/api/lead-generators/${gen.id}`).send({ frequency: 'hourly' })).status).toBe(400);
    const created = await P.agent.post('/api/lead-generators').send({ name: 'Defaults', criteria });
    expect(created.body.generator).toMatchObject({ batchSize: 25, stageKey: 'lead', minScore: 0, autoRun: false, frequency: 'daily' });
  });

  it('deleting works through the API and other users get 404', async () => {
    const other = await registerUser();
    expect((await other.agent.delete(`/api/lead-generators/${gen.id}`)).status).toBe(404);
    expect((await P.agent.delete(`/api/lead-generators/${gen.id}`)).status).toBe(200);
    expect(await prisma.leadGenerator.findUnique({ where: { id: gen.id } })).toBeNull();
  });
});
