import { describe, it, expect } from 'vitest';
import { registerUser, prisma, agent } from './helpers.js';

async function seedPipeline(userId) {
  const stages = Object.fromEntries((await prisma.pipelineStage.findMany()).map((s) => [s.key, s.id]));
  const mk = (name, stage) => prisma.carrier.create({ data: { ownerId: userId, stageId: stages[stage], companyName: name, state: 'TX' } });
  const a = await mk('Alpha Freight', 'lead');
  const b = await mk('Bravo Haul', 'prospecting');
  const c = await mk('Charlie Lines', 'customer');
  await prisma.customer.create({ data: { carrierId: c.id, ownerId: userId } });
  await prisma.opportunity.create({ data: { carrierId: b.id, ownerId: userId, status: 'negotiating' } });
  await prisma.call.create({ data: { carrierId: a.id, userId, outcome: 'interested' } });
  await prisma.followUp.create({ data: { carrierId: a.id, userId, dueAt: new Date(Date.now() - 3600000) } });
  await prisma.email.create({ data: { userId, carrierId: a.id, toEmail: 'a@example.test', subject: 'Hi', body: 'x', status: 'sent', sentAt: new Date() } });
  await prisma.email.create({ data: { userId, carrierId: a.id, toEmail: 'a@example.test', subject: 'Draft', body: 'x', status: 'draft' } });
  await prisma.activity.create({ data: { userId, carrierId: a.id, type: 'call', summary: 'Called Alpha' } });
}

describe('dashboard', () => {
  it('computes statistics from the database for the current user only', async () => {
    const u = await registerUser();
    const other = await registerUser();
    await seedPipeline(u.user.id);
    await seedPipeline(other.user.id);

    const res = await u.agent.get('/api/dashboard?range=30');
    expect(res.status).toBe(200);
    const t = res.body.totals;
    expect(t.carriers).toBe(3);
    expect(t.newLeads).toBe(3);
    expect(t.prospecting).toBe(1);
    expect(t.customers).toBe(1);
    expect(t.activeOpportunities).toBe(1);
    expect(t.callsCompleted).toBe(1);
    expect(t.emailsSent).toBe(1); // drafts not counted
    expect(t.pendingFollowUps).toBe(1);
    expect(t.overdueFollowUps).toBe(1);
    expect(t.conversionRate).toBeCloseTo(33.3, 1);
    expect(res.body.series).toHaveLength(30);
    expect(res.body.series.reduce((s, d) => s + d.leads, 0)).toBe(3);
    expect(res.body.recentActivities.every((a) => a.mine)).toBe(true);
    expect(res.body.callOutcomes).toEqual([{ outcome: 'interested', count: 1 }]);

    // Team scope falls back to "mine" without team rights.
    const team = await u.agent.get('/api/dashboard?scope=team');
    expect(team.body.scope).toBe('mine');
  });

  it('requires authentication and validates the range', async () => {
    expect((await (await agent()).get('/api/dashboard')).status).toBe(401);
    const u = await registerUser();
    expect((await u.agent.get('/api/dashboard?range=13')).status).toBe(400);
  });

  it('notifications: list, unread count, mark read, delete', async () => {
    const u = await registerUser();
    const other = await registerUser();
    const n1 = await prisma.notification.create({ data: { userId: u.user.id, type: 'test', title: 'One' } });
    await prisma.notification.create({ data: { userId: u.user.id, type: 'test', title: 'Two' } });
    const foreign = await prisma.notification.create({ data: { userId: other.user.id, type: 'test', title: 'Not yours' } });
    let list = await u.agent.get('/api/notifications');
    expect(list.body.unread).toBe(2);
    expect((await u.agent.post(`/api/notifications/${foreign.id}/read`)).status).toBe(404);
    await u.agent.post(`/api/notifications/${n1.id}/read`);
    list = await u.agent.get('/api/notifications?unread=1');
    expect(list.body.items).toHaveLength(1);
    await u.agent.post('/api/notifications/read-all');
    expect((await u.agent.get('/api/notifications')).body.unread).toBe(0);
    expect((await u.agent.delete(`/api/notifications/${n1.id}`)).status).toBe(200);
  });

  it('settings: exports own data only and deletes the account with confirmation', async () => {
    const u = await registerUser();
    const other = await registerUser();
    await seedPipeline(u.user.id);
    await seedPipeline(other.user.id);
    const exp = await u.agent.get('/api/settings/export');
    expect(exp.status).toBe(200);
    const data = JSON.parse(exp.text);
    expect(data.carriers).toHaveLength(3);
    expect(data.profile.passwordHash).toBeUndefined();
    expect(exp.text).not.toContain(other.email);

    expect((await u.agent.delete('/api/settings/account').send({ password: u.password, confirm: 'nope' })).status).toBe(400);
    expect((await u.agent.delete('/api/settings/account').send({ password: 'wrong', confirm: 'DELETE' })).status).toBe(400);
    const del = await u.agent.delete('/api/settings/account').send({ password: u.password, confirm: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: u.user.id } })).toBeNull();
    expect(await prisma.carrier.count({ where: { ownerId: other.user.id } })).toBe(3);
  });
});
