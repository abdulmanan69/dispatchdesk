import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const { registerUser, createAdmin, prisma } = await import('./helpers.js');
const { setSetting } = await import('../src/lib/settings.js');
const { invalidatePlans } = await import('../src/lib/plans.js');
const { runManualRenewalReminders } = await import('../src/services/billing/manual.js');
const { termsHtml } = await import('../src/content/legal.js');

describe('manual payments (bank wire, USDT, Taptap Send)', () => {
  let admin;
  beforeAll(async () => {
    admin = await createAdmin();
    await setSetting('billing.provider', 'manual');
    await setSetting('manual.usdt', 'USDT (TRC20): TExampleAddress123');
    await setSetting('manual.bank', '');
    invalidatePlans();
  });
  afterAll(async () => {
    for (const k of ['billing.provider', 'manual.usdt', 'manual.bank']) await setSetting(k, '');
    invalidatePlans();
  });

  it('shows only the methods that have details and sells every paid plan', async () => {
    const U = await registerUser();
    const plans = await U.agent.get('/api/billing/plans');
    expect(plans.body).toMatchObject({ provider: 'manual', paymentsEnabled: true });
    expect(plans.body.plans.find((p) => p.key === 'pro').purchasable).toBe(true);
    const me = await U.agent.get('/api/billing/me');
    expect(me.body.manual.methods).toEqual([{ key: 'usdt', label: 'USDT (crypto)', details: 'USDT (TRC20): TExampleAddress123' }]);
    expect(termsHtml({ provider: 'manual' })).toContain('does not renew by itself');
  });

  it('activates the plan only after an admin approves the reported payment', async () => {
    const U = await registerUser();
    const pro = await prisma.plan.findUnique({ where: { key: 'pro' } });
    const start = await U.agent.post('/api/billing/checkout').send({ planKey: 'pro' });
    expect(start.status).toBe(200);
    expect(start.body.provider).toBe('manual');
    const claim = start.body.claim;
    expect(claim).toMatchObject({ status: 'awaiting', amountCents: pro.priceCents, months: pro.interval === 'year' ? 12 : 1 });
    expect(claim.reference).toMatch(/^DD-[A-Z2-9]{6}$/);
    // Starting again keeps the same reference.
    expect((await U.agent.post('/api/billing/checkout').send({ planKey: 'pro' })).body.claim.reference).toBe(claim.reference);

    // A method that is not offered, or no transaction ID: refused.
    expect((await U.agent.post(`/api/billing/manual/${claim.id}/submit`).send({ method: 'bank', transactionRef: 'TX123456' })).status).toBe(400);
    expect((await U.agent.post(`/api/billing/manual/${claim.id}/submit`).send({ method: 'usdt', transactionRef: '' })).status).toBe(400);
    const sub = await U.agent.post(`/api/billing/manual/${claim.id}/submit`).send({ method: 'usdt', transactionRef: '0xabc123def456', note: 'Sent from Binance' });
    expect(sub.status).toBe(200);
    expect(sub.body.claim.status).toBe('submitted');
    expect((await U.agent.get('/api/billing/me')).body.plan.key).not.toBe('pro'); // nothing until an admin approves
    expect(await prisma.notification.count({ where: { userId: admin.user.id, title: 'Payment to check' } })).toBeGreaterThan(0);

    // Other users cannot touch it; only admins approve.
    const other = await registerUser();
    expect((await other.agent.post(`/api/billing/manual/${claim.id}/submit`).send({ method: 'usdt', transactionRef: 'stolen123' })).status).toBe(404);
    expect((await U.agent.post(`/api/admin/manual-payments/${claim.id}/approve`)).status).toBe(403);

    const list = await admin.agent.get('/api/admin/manual-payments');
    expect(list.body.items.find((i) => i.id === claim.id)).toMatchObject({ reference: claim.reference, transactionRef: '0xabc123def456', user: { email: U.user.email } });
    const ok = await admin.agent.post(`/api/admin/manual-payments/${claim.id}/approve`);
    expect(ok.status).toBe(200);
    expect((await admin.agent.post(`/api/admin/manual-payments/${claim.id}/approve`)).status).toBe(409);

    const me = await U.agent.get('/api/billing/me');
    expect(me.body.plan.key).toBe('pro');
    expect(me.body.subscription).toMatchObject({ provider: 'manual', cancelAtPeriodEnd: true });
    expect(me.body.payments[0]).toMatchObject({ amountCents: pro.priceCents, status: 'paid' });
    expect(me.body.payments[0].description).toContain(claim.reference);
    const end1 = new Date(me.body.subscription.currentPeriodEnd).getTime();
    expect(end1).toBeGreaterThan(Date.now() + 25 * 86_400_000);

    // Renewing early adds the new period to the current end date.
    const again = await U.agent.post('/api/billing/checkout').send({ planKey: 'pro' });
    expect(again.status).toBe(200);
    expect(again.body.claim.reference).not.toBe(claim.reference);
    await U.agent.post(`/api/billing/manual/${again.body.claim.id}/submit`).send({ method: 'usdt', transactionRef: '0xrenewal999' });
    expect((await admin.agent.post(`/api/admin/manual-payments/${again.body.claim.id}/approve`)).status).toBe(200);
    const after = await U.agent.get('/api/billing/me');
    const end2 = new Date(after.body.subscription.currentPeriodEnd).getTime();
    expect(end2 - end1).toBeGreaterThan(25 * 86_400_000);
    expect(after.body.payments.filter((p) => p.status === 'paid')).toHaveLength(2);
  });

  it('tells the customer when a payment is rejected and reminds before a paid period ends', async () => {
    const U = await registerUser();
    const claim = (await U.agent.post('/api/billing/checkout').send({ planKey: 'pro' })).body.claim;
    await U.agent.post(`/api/billing/manual/${claim.id}/submit`).send({ method: 'usdt', transactionRef: 'bad-ref-000' });
    expect((await admin.agent.post(`/api/admin/manual-payments/${claim.id}/reject`).send({ reason: 'No payment with this ID arrived' })).status).toBe(200);
    expect(await prisma.notification.count({ where: { userId: U.user.id, title: 'Payment not confirmed' } })).toBe(1);
    const me = await U.agent.get('/api/billing/me');
    expect(me.body.manual.claims[0]).toMatchObject({ status: 'rejected', rejectReason: 'No payment with this ID arrived' });

    // A manual plan ending in two days gets one reminder.
    const pro = await prisma.plan.findUnique({ where: { key: 'pro' } });
    const V = await registerUser();
    await prisma.subscription.create({ data: { userId: V.user.id, planId: pro.id, status: 'active', provider: 'manual', currentPeriodEnd: new Date(Date.now() + 2 * 86_400_000), cancelAtPeriodEnd: true } });
    await runManualRenewalReminders();
    await runManualRenewalReminders();
    expect(await prisma.notification.count({ where: { userId: V.user.id, title: { startsWith: 'Your Pro plan ends' } } })).toBe(1);
  });
});
