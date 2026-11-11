import { describe, it, expect } from 'vitest';
import { agent, registerUser, prisma } from './helpers.js';

describe('GET /api/onboarding/status', () => {
  it('requires a session', async () => {
    const a = await agent();
    expect((await a.get('/api/onboarding/status')).status).toBe(401);
  });

  it('checks each step against the user\'s own records only', async () => {
    const me = await registerUser();
    const other = await registerUser();
    const empty = await me.agent.get('/api/onboarding/status');
    expect(empty.status).toBe(200);
    expect(empty.body.steps).toEqual({ calling: false, mailbox: false, sequence: false, leads: false, dialer: false, extension: false, fleet: false });

    // Someone else's data never counts for me.
    const stage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
    const theirs = await prisma.carrier.create({ data: { ownerId: other.user.id, stageId: stage.id, companyName: 'Their Freight', isFleet: true, truckStatus: 'available' } });
    await prisma.emailSequence.create({ data: { ownerId: other.user.id, name: 'Theirs' } });
    await prisma.call.create({ data: { carrierId: theirs.id, userId: other.user.id, outcome: 'no_answer' } });
    expect(Object.values((await me.agent.get('/api/onboarding/status')).body.steps).some(Boolean)).toBe(false);

    const mine = await prisma.carrier.create({ data: { ownerId: me.user.id, stageId: stage.id, companyName: 'My Freight' } });
    await prisma.emailSequence.create({ data: { ownerId: me.user.id, name: 'Mine' } });
    await prisma.call.create({ data: { carrierId: mine.id, userId: me.user.id, outcome: 'no_answer' } });
    const some = await me.agent.get('/api/onboarding/status');
    expect(some.body.steps).toMatchObject({ sequence: true, leads: true, dialer: true, fleet: false });

    // A truck with a status counts for the fleet step.
    await prisma.carrier.update({ where: { id: mine.id }, data: { isFleet: true, truckStatus: 'available' } });
    expect((await me.agent.get('/api/onboarding/status?steps=fleet,bogus')).body.steps).toEqual({ fleet: true });
  });

  it('counts a carrier assigned to me by a teammate as leads', async () => {
    const me = await registerUser();
    const owner = await registerUser();
    const stage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
    await prisma.carrier.create({ data: { ownerId: owner.user.id, stageId: stage.id, companyName: 'Assigned Freight', assignedToId: me.user.id } });
    expect((await me.agent.get('/api/onboarding/status?steps=leads')).body.steps).toEqual({ leads: true });
  });
});
