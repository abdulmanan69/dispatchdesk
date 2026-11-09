import { describe, it, expect } from 'vitest';
import { agent, registerUser, createAdmin, prisma } from './helpers.js';

const ADMIN_GETS = ['/api/admin/stats', '/api/admin/users', '/api/admin/roles', '/api/admin/subscriptions', '/api/admin/payments', '/api/admin/plans', '/api/admin/reports', '/api/admin/settings', '/api/admin/audit'];

describe('admin panel', () => {
  it('denies every admin endpoint to non-admins', async () => {
    const { agent: a, user } = await registerUser();
    for (const url of ADMIN_GETS) expect((await a.get(url)).status, url).toBe(403);
    expect((await a.patch(`/api/admin/users/${user.id}`).send({ role: 'super_admin' })).status).toBe(403);
    expect((await a.put('/api/admin/settings').send({ values: { 'app.name': 'Hacked' } })).status).toBe(403);
    expect((await a.post('/api/admin/settings/test/smtp')).status).toBe(403);
    expect((await a.delete(`/api/admin/users/${user.id}`)).status).toBe(403);
  });

  it('lets a super admin read stats, manage users and audit', async () => {
    const admin = await createAdmin();
    for (const url of ADMIN_GETS) expect((await admin.agent.get(url)).status, url).toBe(200);
    const stats = await admin.agent.get('/api/admin/stats');
    expect(stats.body.users.total).toBeGreaterThan(0);
    expect(stats.body.registrations).toHaveLength(30);

    const target = await registerUser();
    const promote = await admin.agent.patch(`/api/admin/users/${target.user.id}`).send({ role: 'team_manager' });
    expect(promote.body.user.role).toBe('team_manager');
    const suspend = await admin.agent.patch(`/api/admin/users/${target.user.id}`).send({ status: 'suspended' });
    expect(suspend.body.user.status).toBe('suspended');
    expect((await target.agent.get('/api/auth/me')).body.user).toBeNull(); // sessions killed
    const login = await (await agent()).post('/api/auth/login').send({ email: target.email, password: target.password });
    expect(login.status).toBe(403);

    expect((await admin.agent.patch(`/api/admin/users/${admin.user.id}`).send({ role: 'user' })).status).toBe(403);

    const audit = await admin.agent.get('/api/admin/audit?action=admin.user_updated');
    expect(audit.body.items.length).toBeGreaterThanOrEqual(2);

    const del = await admin.agent.delete(`/api/admin/users/${target.user.id}`);
    expect(del.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: target.user.id } })).toBeNull();
  });

  it('prevents a plain admin from granting admin roles', async () => {
    const plainAdmin = await registerUser({ role: 'admin' });
    const target = await registerUser();
    const res = await plainAdmin.agent.patch(`/api/admin/users/${target.user.id}`).send({ role: 'super_admin' });
    expect(res.status).toBe(403);
    const ok = await plainAdmin.agent.patch(`/api/admin/users/${target.user.id}`).send({ role: 'team_manager' });
    expect(ok.status).toBe(200);
  });

  it('stores secret settings encrypted and masks them', async () => {
    const admin = await createAdmin();
    const res = await admin.agent.put('/api/admin/settings').send({ values: { 'ai.apiKey': 'sk-secret-value-1234', 'app.name': 'Test Desk' } });
    expect(res.status).toBe(200);
    const key = res.body.settings.find((s) => s.key === 'ai.apiKey');
    expect(key.value).toBe('');
    expect(key.preview).toBe('••••1234');
    const row = await prisma.systemSetting.findUnique({ where: { key: 'ai.apiKey' } });
    expect(row.value).not.toContain('sk-secret');
    // Blank secret keeps the stored value.
    await admin.agent.put('/api/admin/settings').send({ values: { 'ai.apiKey': '' } });
    expect((await prisma.systemSetting.findUnique({ where: { key: 'ai.apiKey' } })).value).toBe(row.value);
    await admin.agent.put('/api/admin/settings').send({ clear: ['ai.apiKey'], values: { 'app.name': 'DispatchDesk' } });
    expect((await admin.agent.put('/api/admin/settings').send({ values: { 'not.a.key': 'x' } })).status).toBe(400);
    // Integration test reports honestly when unconfigured.
    const t = await admin.agent.post('/api/admin/settings/test/smtp');
    expect(t.body.ok).toBe(false);
  });

  it('edits plan limits and moderates reports', async () => {
    const admin = await createAdmin();
    const plans = await admin.agent.get('/api/admin/plans');
    const free = plans.body.plans.find((p) => p.key === 'free');
    const upd = await admin.agent.patch(`/api/admin/plans/${free.id}`).send({ maxSequences: 2 });
    expect(upd.body.plan.maxSequences).toBe(2);
    expect((await admin.agent.patch(`/api/admin/plans/${free.id}`).send({ active: false })).status).toBe(400);
    expect((await admin.agent.patch(`/api/admin/plans/${free.id}`).send({ stripePriceId: 'bogus' })).status).toBe(400);
    await admin.agent.patch(`/api/admin/plans/${free.id}`).send({ maxSequences: 1 });

    const author = await registerUser();
    const post = await prisma.communityPost.create({ data: { authorId: author.user.id, title: 'Spam', body: 'Buy now' } });
    const report = await prisma.contentReport.create({ data: { reporterId: admin.user.id, postId: post.id, reason: 'spam' } });
    const list = await admin.agent.get('/api/admin/reports');
    expect(list.body.items.find((x) => x.id === report.id).target.title).toBe('Spam');
    const res = await admin.agent.post(`/api/admin/reports/${report.id}/resolve`).send({ action: 'hide_content' });
    expect(res.body.report.status).toBe('resolved');
    expect((await prisma.communityPost.findUnique({ where: { id: post.id } })).status).toBe('hidden');
  });
});

describe('admin temporary password', () => {
  it('sets a one-time password, signs the user out, and the new password works', async () => {
    const admin = await createAdmin();
    const target = await registerUser();
    const res = await admin.agent.post(`/api/admin/users/${target.user.id}/temp-password`);
    expect(res.status).toBe(200);
    expect(res.body.password).toMatch(/^Tmp-/);
    expect((await target.agent.get('/api/auth/me')).body.user).toBeNull();
    const fresh = await agent();
    expect((await fresh.post('/api/auth/login').send({ email: target.email, password: res.body.password })).status).toBe(200);
    const stored = await prisma.user.findUnique({ where: { id: target.user.id } });
    expect(stored.passwordHash).not.toContain(res.body.password);
  });
  it('is admin-only', async () => {
    const a = await registerUser();
    const b = await registerUser();
    expect((await a.agent.post(`/api/admin/users/${b.user.id}/temp-password`)).status).toBe(403);
  });
});

describe('admin plan grants', () => {
  it('grants Pro without payment, limits apply, then revoke returns the user to Free', async () => {
    const admin = await createAdmin();
    const u = await registerUser();
    const res = await admin.agent.post('/api/admin/subscriptions/grant').send({ userId: u.user.id, planKey: 'pro', months: 3 });
    expect(res.status).toBe(201);
    const me = (await u.agent.get('/api/billing/me')).body;
    expect(me.plan.key).toBe('pro');
    expect(me.subscription).toMatchObject({ granted: true, status: 'active' });
    expect(new Date(me.subscription.currentPeriodEnd).getTime()).toBeGreaterThan(Date.now() + 80 * 86400000);
    // granting again updates the same subscription instead of stacking
    expect((await admin.agent.post('/api/admin/subscriptions/grant').send({ userId: u.user.id, planKey: 'teams', months: null })).status).toBe(200);
    expect((await u.agent.get('/api/billing/me')).body.plan.key).toBe('teams');
    const list = (await admin.agent.get('/api/admin/subscriptions')).body.items.find((s) => s.user.id === u.user.id);
    expect(list.granted).toBe(true);
    expect((await admin.agent.post(`/api/admin/subscriptions/${list.id}/revoke`)).status).toBe(200);
    expect((await u.agent.get('/api/billing/me')).body.plan.key).toBe('free');
  });

  it('granted plans stop at their end date', async () => {
    const admin = await createAdmin();
    const u = await registerUser();
    await admin.agent.post('/api/admin/subscriptions/grant').send({ userId: u.user.id, planKey: 'pro', months: 1 });
    await prisma.subscription.updateMany({ where: { userId: u.user.id }, data: { currentPeriodEnd: new Date(Date.now() - 1000) } });
    expect((await u.agent.get('/api/billing/me')).body.plan.key).toBe('free');
  });

  it('rejects free plan grants and non-admins', async () => {
    const admin = await createAdmin();
    const u = await registerUser();
    expect((await admin.agent.post('/api/admin/subscriptions/grant').send({ userId: u.user.id, planKey: 'free' })).status).toBe(400);
    expect((await u.agent.post('/api/admin/subscriptions/grant').send({ userId: u.user.id, planKey: 'pro' })).status).toBe(403);
  });
});
