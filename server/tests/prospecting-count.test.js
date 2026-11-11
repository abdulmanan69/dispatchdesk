import { describe, it, expect } from 'vitest';
import { registerUser, prisma } from './helpers.js';

async function carrier(a, name) {
  return (await a.post('/api/carriers').send({ companyName: name, state: 'TX', phone: `512555${String(Math.floor(Math.random() * 9000) + 1000)}` })).body.carrier;
}

describe('queue badge counts', () => {
  it('counts due call steps and follow-ups, skips email steps, and is per user', async () => {
    const A = await registerUser();
    const B = await registerUser();
    const empty = await A.agent.get('/api/prospecting/queue/count');
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ queue: 0, followUps: 0, overdue: 0 });

    const seq = (await A.agent.post('/api/sequences').send({ name: 'Calls', respectBusinessHours: false, steps: [{ dayOffset: 0, type: 'call', instructions: 'Call' }] })).body.sequence;
    const c1 = await carrier(A.agent, 'Count One');
    const c2 = await carrier(A.agent, 'Count Two');
    await A.agent.post(`/api/sequences/${seq.id}/enroll`).send({ carrierIds: [c1.id, c2.id] });
    await prisma.sequenceEnrollment.updateMany({ where: { carrierId: c1.id }, data: { nextStepAt: new Date(Date.now() - 3600000) } }); // overdue
    // An email step due now is the scheduler's job, not a queue item.
    const emailSeq = await prisma.emailSequence.create({ data: { ownerId: A.user.id, name: 'Mail', steps: { create: [{ order: 0, dayOffset: 0, type: 'email', subject: 's', body: 'b' }] } } });
    const c3 = await carrier(A.agent, 'Count Three');
    await prisma.sequenceEnrollment.create({ data: { sequenceId: emailSeq.id, carrierId: c3.id, userId: A.user.id, nextStepAt: new Date() } });
    await A.agent.post('/api/follow-ups').send({ carrierId: c3.id, dueAt: new Date(Date.now() - 30 * 60000).toISOString() });

    const res = await A.agent.get('/api/prospecting/queue/count');
    expect(res.body).toMatchObject({ queue: 3, count: 3, followUps: 1, overdue: 2 });
    const full = await A.agent.get('/api/prospecting/queue?includeHot=false');
    expect(full.body.stats.due).toBe(res.body.queue);
    expect(full.body.items[0].overdue).toBe(true); // most overdue first
    expect((await B.agent.get('/api/prospecting/queue/count')).body).toMatchObject({ queue: 0, followUps: 0 });
  });

  it('caches for a minute and refreshes after the user\'s own changes', async () => {
    const A = await registerUser();
    const c = await carrier(A.agent, 'Cache Co');
    expect((await A.agent.get('/api/prospecting/queue/count')).body.followUps).toBe(0);
    await prisma.followUp.create({ data: { carrierId: c.id, userId: A.user.id, dueAt: new Date(Date.now() - 60000) } }); // bypasses the API
    expect((await A.agent.get('/api/prospecting/queue/count')).body.followUps).toBe(0); // cached
    await A.agent.post('/api/follow-ups').send({ carrierId: c.id, dueAt: new Date(Date.now() - 120000).toISOString() });
    expect((await A.agent.get('/api/prospecting/queue/count')).body.followUps).toBe(2);
    await A.agent.post('/api/calls').send({ carrierId: c.id, outcome: 'no_answer', autoFollowUp: false });
    expect((await A.agent.get('/api/prospecting/queue/count')).body.followUps).toBe(0); // the call completed both
  });

  it('includes steps on carriers assigned to the user', async () => {
    const A = await registerUser();
    const B = await registerUser();
    const seq = (await B.agent.post('/api/sequences').send({ name: 'B calls', respectBusinessHours: false, steps: [{ dayOffset: 0, type: 'call', instructions: 'Call' }] })).body.sequence;
    const cb = await carrier(B.agent, 'Assigned Freight');
    await B.agent.post(`/api/sequences/${seq.id}/enroll`).send({ carrierIds: [cb.id] });
    await prisma.carrier.update({ where: { id: cb.id }, data: { assignedToId: A.user.id } });
    const q = await A.agent.get('/api/prospecting/queue?includeHot=false');
    expect(q.body.items.map((i) => i.carrier.id)).toContain(cb.id);
    expect((await A.agent.get('/api/prospecting/queue/count')).body.queue).toBe(1);
  });

  it('never lists a carrier the user no longer owns or is assigned to, even on an enrollment they started', async () => {
    const A = await registerUser();
    const B = await registerUser();
    const seq = (await A.agent.post('/api/sequences').send({ name: 'Lost', respectBusinessHours: false, steps: [{ dayOffset: 0, type: 'call', instructions: 'Call' }] })).body.sequence;
    const c = await carrier(A.agent, 'Moved Away Freight');
    await A.agent.post(`/api/sequences/${seq.id}/enroll`).send({ carrierIds: [c.id] });
    expect((await A.agent.get('/api/prospecting/queue/count')).body.queue).toBe(1);
    // The carrier now belongs to someone else (e.g. A left the team that owns it).
    await prisma.carrier.update({ where: { id: c.id }, data: { ownerId: B.user.id, assignedToId: null } });
    await A.agent.post('/api/follow-ups').send({ carrierId: (await carrier(A.agent, 'Still Mine')).id, dueAt: new Date(Date.now() + 60000).toISOString() }); // clears the cached count
    const q = await A.agent.get('/api/prospecting/queue?includeHot=false');
    expect(q.body.items.map((i) => i.carrier.id)).not.toContain(c.id);
    expect((await A.agent.get('/api/prospecting/queue/count')).body).toMatchObject({ queue: 1, followUps: 1 });
  });

  it('matches the list for do-not-call carriers (their call steps and call follow-ups are not queue work)', async () => {
    const A = await registerUser();
    const seq = (await A.agent.post('/api/sequences').send({ name: 'DNC', respectBusinessHours: false, steps: [{ dayOffset: 0, type: 'call', instructions: 'Call' }] })).body.sequence;
    const ok = await carrier(A.agent, 'Callable Co');
    const dnc = await carrier(A.agent, 'Do Not Call Co');
    await A.agent.post(`/api/sequences/${seq.id}/enroll`).send({ carrierIds: [ok.id, dnc.id] });
    await prisma.carrier.update({ where: { id: dnc.id }, data: { doNotCall: true } });
    await prisma.followUp.create({ data: { carrierId: dnc.id, userId: A.user.id, dueAt: new Date(Date.now() - 60000), type: 'call' } });
    await prisma.followUp.create({ data: { carrierId: dnc.id, userId: A.user.id, dueAt: new Date(Date.now() - 60000), type: 'email' } });
    const full = await A.agent.get('/api/prospecting/queue?includeHot=false');
    const count = (await A.agent.get('/api/prospecting/queue/count')).body;
    expect(count).toMatchObject({ queue: 2, followUps: 1 });
    expect(full.body.stats.due).toBe(count.queue);
  });

  it('keeps the queue queries on per-user indexes (no scan of every tenant\'s due enrollments)', async () => {
    const { queueBranches } = await import('../src/routes/prospecting.js');
    const { Prisma } = await import('@prisma/client');
    const A = await registerUser();
    const user = await prisma.user.findUnique({ where: { id: A.user.id }, include: { teamMembership: true } });
    const [a, b] = await queueBranches(user, new Date(), 'some-list');
    const plan = async (from) => (await prisma.$queryRaw(Prisma.sql`EXPLAIN QUERY PLAN SELECT e.id ${from} ORDER BY +e.nextStepAt LIMIT 500`)).map((p) => p.detail).join(' | ');
    const check = async () => {
      const pa = await plan(a);
      const pb = await plan(b);
      expect(pa).toMatch(/SequenceEnrollment_userId_status_nextStepAt_idx/);
      expect(pb).toMatch(/Carrier_assignedToId_idx/);
      expect(pb).toMatch(/SequenceEnrollment_carrierId_status_idx/);
      expect(`${pa} ${pb}`).not.toMatch(/SequenceEnrollment_status_nextStepAt_idx|SCAN (SequenceEnrollment|Carrier|SequenceStep|c|e|s)\b/);
    };
    await check();
    // Production has planner statistics (the nightly PRAGMA optimize). When most carriers are unassigned they make
    // assignedToId look unselective; the queries must keep their indexes anyway. Other suites expect no statistics,
    // so they are removed again afterwards.
    await prisma.$executeRawUnsafe('ANALYZE');
    // The statistics of a large table where no carrier is assigned: one distinct assignedToId value. Without
    // INDEXED BY the planner then scans every carrier ("SCAN c") for the assigned-to-me branch.
    const statTables = async () => prisma.$queryRawUnsafe("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('sqlite_stat1', 'sqlite_stat4')");
    if ((await statTables()).some((t) => t.name === 'sqlite_stat4')) await prisma.$executeRawUnsafe("DELETE FROM sqlite_stat4 WHERE tbl = 'Carrier'");
    await prisma.$executeRawUnsafe("UPDATE sqlite_stat1 SET stat = '200000 200000' WHERE idx = 'Carrier_assignedToId_idx'");
    await prisma.$executeRawUnsafe("UPDATE sqlite_stat1 SET stat = '200000 1' WHERE tbl = 'Carrier' AND idx LIKE 'sqlite_autoindex_Carrier_%'");
    await prisma.$executeRawUnsafe('ANALYZE sqlite_schema'); // reload the edited statistics
    try {
      await check();
    } finally {
      for (const { name } of await statTables()) await prisma.$executeRawUnsafe(`DELETE FROM ${name}`);
      await prisma.$executeRawUnsafe('ANALYZE sqlite_schema'); // makes the planner reload the (now empty) statistics
    }
  });
});
