import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const { registerUser, createAdmin, prisma } = await import('./helpers.js');
const { setSetting } = await import('../src/lib/settings.js');
const { invalidatePlans } = await import('../src/lib/plans.js');

const DAY = 86_400_000;
const age = async (userId, days) => {
  await prisma.user.update({ where: { id: userId }, data: { createdAt: new Date(Date.now() - days * DAY) } });
  invalidatePlans();
};

describe('free trial, then read-only', () => {
  let admin;
  beforeAll(async () => {
    admin = await createAdmin();
    await setSetting('app.trialDays', '14');
  });
  // Back to the test default (no trial) for the files that run after this one.
  afterAll(async () => { await setSetting('app.trialDays', ''); invalidatePlans(); });

  it('gives a new account the trial plan for 14 days', async () => {
    const A = await registerUser();
    const me = await A.agent.get('/api/auth/me');
    expect(me.body.user.trial).toMatchObject({ enabled: true, active: true, locked: false, daysLeft: 14, planName: 'Pro' });
    const billing = await A.agent.get('/api/billing/me');
    expect(billing.body.plan.key).toBe('pro');
    expect(billing.body.trial).toMatchObject({ active: true });
    expect((await A.agent.post('/api/carriers').send({ companyName: 'Trial Freight LLC' })).status).toBe(201);
    const plans = await A.agent.get('/api/billing/plans');
    const card = plans.body.plans.find((p) => p.key === 'free');
    const pro = plans.body.plans.find((p) => p.key === 'pro');
    expect(card).toMatchObject({ name: 'Free trial', freeUnit: 'for 14 days', priceCents: 0, purchasable: false });
    // The comparison table reads limits: the trial column shows what the trial actually gives (the Pro limits).
    expect(card.limits).toEqual(pro.limits);
    expect(card.advancedReports).toBe(pro.advancedReports);
  });

  it('locks writes after the trial but keeps reading, billing and codes working', async () => {
    const B = await registerUser();
    await age(B.user.id, 20);
    const me = await B.agent.get('/api/auth/me');
    expect(me.body.user.trial).toMatchObject({ active: false, locked: true, daysLeft: 0 });
    const blocked = await B.agent.post('/api/carriers').send({ companyName: 'Late Freight LLC' });
    expect(blocked.status).toBe(402);
    expect(blocked.body.code).toBe('TRIAL_ENDED');
    expect((await B.agent.get('/api/carriers')).status).toBe(200);
    const billing = await B.agent.get('/api/billing/me');
    expect(billing.body.plan).toMatchObject({ key: 'free' });
    expect(billing.body.plan.limits.dailyEmailLimit).toBe(0);

    // A plan code unlocks the account again (billing routes stay open).
    await admin.agent.post('/api/admin/coupons').send({ kind: 'plan', code: 'UNLOCK1', planKey: 'pro', planMonths: 1 }).expect(201);
    const r = await B.agent.post('/api/billing/redeem').send({ code: 'unlock1' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ plan: { key: 'pro' }, phrase: 'Pro for 1 month' });
    expect((await B.agent.get('/api/auth/me')).body.user.trial).toBeNull();
    expect((await B.agent.post('/api/carriers').send({ companyName: 'Back Freight LLC' })).status).toBe(201);
  });

  it('never locks platform admins', async () => {
    await age(admin.user.id, 60);
    expect((await admin.agent.get('/api/auth/me')).body.user.trial).toBeNull();
    expect((await admin.agent.post('/api/carriers').send({ companyName: 'Admin Freight LLC' })).status).toBe(201);
  });

  it('keeps the Free plan forever when the trial is off', async () => {
    await setSetting('app.trialDays', '0');
    invalidatePlans();
    const C = await registerUser();
    await age(C.user.id, 90);
    expect((await C.agent.get('/api/auth/me')).body.user.trial).toBeNull();
    expect((await C.agent.post('/api/carriers').send({ companyName: 'Forever Free LLC' })).status).toBe(201);
    await setSetting('app.trialDays', '14');
    invalidatePlans();
  });
});

describe('codes', () => {
  let admin;
  beforeAll(async () => { admin = await createAdmin(); });

  it('redeems a plan code once per user and up to its limit', async () => {
    const created = await admin.agent.post('/api/admin/coupons').send({ kind: 'plan', code: 'Partner 3', planKey: 'pro', planMonths: 3, maxRedemptions: 1, description: 'Partner' });
    expect(created.status).toBe(201);
    expect(created.body.coupon).toMatchObject({ code: 'PARTNER3', kind: 'plan', planName: 'Pro', used: 0 });
    expect((await admin.agent.post('/api/admin/coupons').send({ kind: 'plan', code: 'PARTNER3', planKey: 'pro' })).status).toBe(409);

    const A = await registerUser();
    const B = await registerUser();
    expect((await A.agent.post('/api/billing/redeem').send({ code: 'PARTNER3' })).status).toBe(200);
    expect((await A.agent.get('/api/billing/me')).body.plan.key).toBe('pro');
    expect((await A.agent.post('/api/billing/redeem').send({ code: 'PARTNER3' })).status).toBe(409);
    const used = await B.agent.post('/api/billing/redeem').send({ code: 'PARTNER3' });
    expect(used.status).toBe(400);
    expect(used.body.error).toMatch(/not valid or can no longer be used/);
    expect((await B.agent.post('/api/billing/redeem').send({ code: 'NOPE-123' })).status).toBe(400);
    const list = await admin.agent.get('/api/admin/coupons');
    expect(list.body.coupons.find((c) => c.code === 'PARTNER3')).toMatchObject({ used: 1, maxRedemptions: 1 });
  });

  it('turns a code off, and refuses discount codes while Stripe is not set up', async () => {
    const c = (await admin.agent.post('/api/admin/coupons').send({ kind: 'plan', code: 'OFFCODE', planKey: 'pro' })).body.coupon;
    await admin.agent.patch(`/api/admin/coupons/${c.id}`).send({ active: false }).expect(200);
    const A = await registerUser();
    const r = await A.agent.post('/api/billing/redeem').send({ code: 'OFFCODE' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not valid or can no longer be used/);
    const d = await admin.agent.post('/api/admin/coupons').send({ kind: 'discount', code: 'SAVE20', percentOff: 20, duration: 'once' });
    expect(d.status).toBe(400);
    expect(d.body.error).toMatch(/Stripe secret key/);
    expect((await admin.agent.post('/api/admin/coupons').send({ kind: 'discount', code: 'BOTH', percentOff: 20, amountOffCents: 500 })).status).toBe(400);
    expect((await A.agent.get('/api/admin/coupons')).status).toBe(403);
  });
});

describe('plan gifts', () => {
  it('gifts a plan to selected users, skips Stripe payers, and celebrates once', async () => {
    const admin = await createAdmin();
    const A = await registerUser();
    const B = await registerUser();
    const C = await registerUser();
    const pro = await prisma.plan.findUnique({ where: { key: 'pro' } });
    await prisma.subscription.create({ data: { userId: C.user.id, planId: pro.id, status: 'active', stripeSubscriptionId: `sub_${Date.now()}` } });

    const r = await admin.agent.post('/api/admin/subscriptions/gift').send({ userIds: [A.user.id, B.user.id, C.user.id], planKey: 'pro', months: 3, notify: true, message: 'Thanks for testing' });
    expect(r.status).toBe(200);
    expect(r.body.granted).toBe(2);
    expect(r.body.skipped).toEqual([expect.objectContaining({ userId: C.user.id })]);
    expect((await A.agent.get('/api/billing/me')).body.plan.key).toBe('pro');

    const cel = await A.agent.get('/api/billing/celebration');
    expect(cel.body.celebration).toMatchObject({ plan: { key: 'pro' }, headline: 'You got Pro for 3 months', message: 'Thanks for testing' });
    await A.agent.post(`/api/notifications/${cel.body.celebration.notificationId}/read`).expect(200);
    expect((await A.agent.get('/api/billing/celebration')).body.celebration).toBeNull();

    // Without notify: the plan changes silently.
    const D = await registerUser();
    await admin.agent.post('/api/admin/subscriptions/gift').send({ userIds: [D.user.id], planKey: 'pro', months: null, notify: false }).expect(200);
    expect((await D.agent.get('/api/billing/celebration')).body.celebration).toBeNull();
    expect((await D.agent.get('/api/billing/me')).body.subscription).toMatchObject({ granted: true, currentPeriodEnd: null });
    expect((await A.agent.post('/api/admin/subscriptions/gift').send({ userIds: [A.user.id], planKey: 'pro' })).status).toBe(403);
  });
});

describe('announcement bar', () => {
  it('is set by an admin, shown publicly, and validated', async () => {
    const admin = await createAdmin();
    expect((await admin.agent.get('/api/public/announcement')).body.announcement).toBeNull();
    const bad = await admin.agent.put('/api/admin/settings').send({ values: { 'announcement.linkUrl': 'javascript:alert(1)' } });
    expect(bad.status).toBe(400);
    await admin.agent.put('/api/admin/settings').send({ values: {
      'announcement.enabled': 'true', 'announcement.text': 'New: fee payments on statements', 'announcement.linkUrl': '/app/billing',
      'announcement.linkLabel': 'See plans', 'announcement.tone': 'success', 'announcement.audience': 'everyone',
    } }).expect(200);
    const A = await registerUser();
    const a = (await A.agent.get('/api/public/announcement')).body.announcement;
    expect(a).toMatchObject({ text: 'New: fee payments on statements', linkUrl: '/app/billing', tone: 'success', audience: 'everyone' });
    expect(a.id).toMatch(/^[0-9a-f]{12}$/);
    await admin.agent.put('/api/admin/settings').send({ values: { 'announcement.enabled': 'false' } }).expect(200);
    expect((await A.agent.get('/api/public/announcement')).body.announcement).toBeNull();
  });
});
