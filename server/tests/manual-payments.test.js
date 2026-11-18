import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const { registerUser, createAdmin, prisma } = await import('./helpers.js');
const { setSetting } = await import('../src/lib/settings.js');
const { invalidatePlans } = await import('../src/lib/plans.js');
const manualSvc = await import('../src/services/billing/manual.js');
const tronSvc = await import('../src/services/billing/tron.js');
const { runManualRenewalReminders } = manualSvc;
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

  it('lets an admin switch the billing provider to manual or polar from System settings', async () => {
    const save = (values) => admin.agent.put('/api/admin/settings').send({ values });
    expect((await save({ 'billing.provider': 'manual', 'manual.usdt': 'USDT (TRC20): TExampleAddress123' })).status).toBe(200);
    expect((await save({ 'billing.provider': 'polar' })).status).toBe(200);
    expect((await save({ 'billing.provider': 'bitcoin' })).status).toBe(400);
    expect((await save({ 'billing.provider': 'manual' })).status).toBe(200);
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

describe('USDT payments confirmed automatically on the TRON chain', () => {
  const WALLET = 'TXYZabcdefghijkmnopqrstuvwxyz12345'; // fictional, in TRON address format
  const { confirmUsdtPayments } = manualSvc;
  let transfers = [];
  let calls = 0;
  let admin;
  const txId = (n) => (BigInt(Date.now()) * 1000n + BigInt(n)).toString(16).padStart(64, '0');
  const transfer = (value, { id, at = Date.now(), to = WALLET, contract = tronSvc.USDT_TRC20, decimals = 6 } = {}) => ({
    transaction_id: id, token_info: { address: contract, decimals, symbol: 'USDT' }, block_timestamp: at,
    from: 'TSenderWalletExample1111111111111', to, type: 'Transfer', value: String(value),
  });
  const micros = (claim) => claim.cryptoAmount.replace('.', '').replace(/^0+/, '');
  const startPro = async (U) => (await U.agent.post('/api/billing/checkout').send({ planKey: 'pro' })).body.claim;

  beforeAll(async () => {
    admin = await createAdmin();
    await setSetting('billing.provider', 'manual');
    await setSetting('manual.usdt', `Network: TRON (TRC20) only\nAddress: ${WALLET}`);
    invalidatePlans();
    tronSvc.__setTronFetch(async (url) => {
      calls += 1;
      expect(String(url)).toContain(`/v1/accounts/${WALLET}/transactions/trc20?`);
      expect(String(url)).toContain(`contract_address=${tronSvc.USDT_TRC20}`);
      return { ok: true, status: 200, json: async () => ({ success: true, data: transfers, meta: {} }) };
    });
  });
  afterAll(async () => {
    tronSvc.__setTronFetch(null);
    for (const k of ['billing.provider', 'manual.usdt', 'manual.usdtAutoConfirm']) await setSetting(k, '');
    invalidatePlans();
  });

  it('gives each payment its own exact amount and starts the plan when that transfer arrives', async () => {
    const pro = await prisma.plan.findUnique({ where: { key: 'pro' } });
    const U = await registerUser();
    const claim = await startPro(U);
    expect(claim.cryptoAmount).toMatch(/^\d+\.\d{6}$/);
    const extra = Number(micros(claim)) - pro.priceCents * 10_000;
    expect(extra).toBeGreaterThanOrEqual(1);
    expect(extra).toBeLessThanOrEqual(9999);

    transfers = [];
    expect((await confirmUsdtPayments()).confirmed).toBe(0);
    // A look-alike token, another wallet, a rounded amount and a transfer from before the payment started: ignored.
    transfers = [
      transfer(micros(claim), { id: txId(1), contract: 'TFakeTetherTokenExample1111111111' }),
      transfer(micros(claim), { id: txId(2), to: 'TOtherWalletExample11111111111111' }),
      transfer(pro.priceCents * 10_000, { id: txId(3) }),
      transfer(micros(claim), { id: txId(4), at: Date.now() - 3_600_000 }),
    ];
    expect((await confirmUsdtPayments()).confirmed).toBe(0);
    expect((await U.agent.get('/api/billing/me')).body.plan.key).not.toBe('pro');

    const good = txId(5);
    transfers.push(transfer(micros(claim), { id: good }));
    expect((await confirmUsdtPayments()).confirmed).toBe(1);
    const me = await U.agent.get('/api/billing/me');
    expect(me.body.plan.key).toBe('pro');
    expect(me.body.subscription).toMatchObject({ provider: 'manual' });
    expect(me.body.payments[0].description).toContain('USDT');
    expect(me.body.manual.claims[0]).toMatchObject({ status: 'approved', autoConfirmed: true, chainTxId: good });
    expect(await prisma.notification.count({ where: { userId: admin.user.id, title: 'USDT payment confirmed' } })).toBeGreaterThan(0);
    // Running again changes nothing.
    expect((await confirmUsdtPayments()).confirmed).toBe(0);
  });

  it('approves at once when the customer reports a transfer that already confirmed, and never reuses a transfer', async () => {
    const U = await registerUser();
    const claim = await startPro(U);
    const id = txId(6);
    transfers = [transfer(micros(claim), { id })];
    const res = await U.agent.post(`/api/billing/manual/${claim.id}/submit`).send({ method: 'usdt', transactionRef: id });
    expect(res.status).toBe(200);
    expect(res.body.claim).toMatchObject({ status: 'approved', autoConfirmed: true, chainTxId: id, transactionRef: id });

    // Another payment given the same amount cannot be paid by the same transfer.
    const V = await registerUser();
    const other = await startPro(V);
    await prisma.manualPayment.update({ where: { id: other.id }, data: { cryptoAmount: micros(claim) } });
    expect((await confirmUsdtPayments()).confirmed).toBe(0);
    expect((await prisma.manualPayment.findUnique({ where: { id: other.id } })).status).toBe('awaiting');
  });

  it('leaves the payment to an admin when two open payments share an amount, or when the check is off', async () => {
    const A = await registerUser();
    const B = await registerUser();
    const a = await startPro(A);
    const b = await startPro(B);
    await prisma.manualPayment.update({ where: { id: b.id }, data: { cryptoAmount: micros(a) } });
    transfers = [transfer(micros(a), { id: txId(7) })];
    expect((await confirmUsdtPayments()).confirmed).toBe(0);

    await setSetting('manual.usdtAutoConfirm', 'false');
    calls = 0;
    const r = await confirmUsdtPayments();
    expect(r.off).toBe(true);
    expect(calls).toBe(0);
    await setSetting('manual.usdtAutoConfirm', '');
  });
});
