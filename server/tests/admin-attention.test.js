import { describe, it, expect } from 'vitest';

const { registerUser, createAdmin, prisma } = await import('./helpers.js');

describe('admin attention counts', () => {
  it('counts payments to check, open reports, setup steps and failing jobs for admins only', async () => {
    const admin = await createAdmin();
    const before = (await admin.agent.get('/api/admin/attention')).body;
    for (const k of ['paymentsToCheck', 'openReports', 'setupTodo', 'failedJobs']) expect(typeof before[k]).toBe('number');

    const U = await registerUser();
    const pro = await prisma.plan.findUnique({ where: { key: 'pro' } });
    await prisma.manualPayment.create({ data: { userId: U.user.id, planId: pro.id, amountCents: pro.priceCents, reference: `DD-AT${Date.now().toString(36).slice(-4).toUpperCase()}`, status: 'submitted', method: 'bank', transactionRef: 'TX-ATTN-1', submittedAt: new Date() } });
    expect((await admin.agent.get('/api/admin/attention')).body.paymentsToCheck).toBe(before.paymentsToCheck + 1);

    expect((await U.agent.get('/api/admin/attention')).status).toBe(403);
  });
});
