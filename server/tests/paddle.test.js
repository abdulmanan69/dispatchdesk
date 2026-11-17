import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

const { registerUser, createAdmin, prisma, app } = await import('./helpers.js');
const { setSetting } = await import('../src/lib/settings.js');
const { invalidatePlans } = await import('../src/lib/plans.js');
const { config } = await import('../src/config.js');
const { verifyPaddleSignature, __setPaddleFetch } = await import('../src/services/paddle.js');
const { provisionPaddle } = await import('../src/services/billing/paddleProvision.js');

const SECRET = 'pdl_ntfset_test_secret';
const sign = (body, ts = Math.floor(Date.now() / 1000), secret = SECRET) => `ts=${ts};h1=${crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex')}`;

// Fake Paddle API: answers by method + path, records calls.
const paddle = { calls: [], subs: new Map(), discounts: [] };
const reply = (status, data) => ({ ok: status < 300, status, json: async () => (status < 300 ? { data } : { error: data }) });
function fakeFetch(url, opts = {}) {
  const u = new URL(url);
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  paddle.calls.push({ method: opts.method, path: u.pathname + u.search, body });
  const m = (re) => u.pathname.match(re);
  if (u.pathname === '/event-types') return reply(200, []);
  if (opts.method === 'GET' && m(/^\/subscriptions\/([^/]+)$/)) return reply(200, paddle.subs.get(m(/^\/subscriptions\/([^/]+)$/)[1]));
  if (opts.method === 'POST' && m(/^\/subscriptions\/([^/]+)\/cancel$/)) {
    const id = m(/^\/subscriptions\/([^/]+)\/cancel$/)[1];
    const s = { ...paddle.subs.get(id), scheduled_change: { action: 'cancel', effective_at: '2099-01-01T00:00:00Z' } };
    paddle.subs.set(id, s);
    return reply(200, s);
  }
  if (u.pathname === '/products' && opts.method === 'GET') return reply(200, []);
  if (u.pathname === '/products' && opts.method === 'POST') return reply(201, { id: `pro_${body.custom_data.dispatchdesk_plan}`, ...body });
  if (u.pathname === '/prices' && opts.method === 'GET') return reply(200, []);
  if (opts.method === 'GET' && m(/^\/prices\/(.+)$/)) return m(/^\/prices\/pri_sandbox_old$/) ? reply(404, { code: 'entity_not_found', detail: 'price not found' }) : reply(200, { id: m(/^\/prices\/(.+)$/)[1] });
  if (u.pathname === '/prices' && opts.method === 'POST') return reply(201, { id: `pri_${body.custom_data.dispatchdesk_plan}`, ...body });
  if (u.pathname === '/notification-settings' && opts.method === 'GET') return reply(200, []);
  if (u.pathname === '/notification-settings' && opts.method === 'POST') return reply(201, { id: 'ntfset_1', endpoint_secret_key: 'pdl_ntfset_created', ...body });
  if (u.pathname === '/discounts' && opts.method === 'POST') { paddle.discounts.push(body); return reply(201, { id: 'dsc_1', ...body }); }
  return reply(404, { code: 'not_found', detail: `no fake for ${opts.method} ${u.pathname}` });
}

const subscription = (over = {}) => ({
  id: 'sub_01paddletest', status: 'active', customer_id: 'ctm_01test',
  items: [{ price: { id: 'pri_test_pro' }, quantity: 1 }],
  current_billing_period: { starts_at: '2026-11-17T00:00:00Z', ends_at: '2026-12-17T00:00:00Z' },
  scheduled_change: null, canceled_at: null, ...over,
});

async function sendEvent(evt, { sig } = {}) {
  const raw = JSON.stringify(evt);
  return request(app).post('/api/billing/paddle/webhook').set('Content-Type', 'application/json').set('Paddle-Signature', sig ?? sign(raw)).send(raw);
}

describe('Paddle signature', () => {
  it('accepts a correct signature and refuses wrong, old or missing ones', () => {
    const body = '{"event_id":"evt_1"}';
    expect(verifyPaddleSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyPaddleSignature(Buffer.from(body), sign(body), SECRET)).toBe(true);
    expect(verifyPaddleSignature(body, sign(body, undefined, 'other'), SECRET)).toBe(false);
    expect(verifyPaddleSignature(`${body} `, sign(body), SECRET)).toBe(false);
    expect(verifyPaddleSignature(body, sign(body, Math.floor(Date.now() / 1000) - 3600), SECRET)).toBe(false);
    // During secret rotation the header carries two h1 values; either may match.
    const ts = Math.floor(Date.now() / 1000);
    const good = crypto.createHmac('sha256', SECRET).update(`${ts}:${body}`).digest('hex');
    expect(verifyPaddleSignature(body, `ts=${ts};h1=${'0'.repeat(64)};h1=${good}`, SECRET)).toBe(true);
    expect(verifyPaddleSignature(body, '', SECRET)).toBe(false);
  });
});

describe('selling plans through Paddle', () => {
  let A;
  let pro;
  beforeAll(async () => {
    __setPaddleFetch(fakeFetch);
    for (const [k, v] of Object.entries({ 'billing.provider': 'paddle', 'paddle.environment': 'sandbox', 'paddle.apiKey': 'pdl_sdbx_apikey_testkey1234567890', 'paddle.clientToken': 'test_clienttoken123', 'paddle.webhookSecret': SECRET })) await setSetting(k, v);
    pro = await prisma.plan.update({ where: { key: 'pro' }, data: { paddlePriceId: 'pri_test_pro' } });
    invalidatePlans();
    A = await registerUser();
  });
  afterAll(async () => {
    __setPaddleFetch(null);
    for (const k of ['billing.provider', 'paddle.environment', 'paddle.apiKey', 'paddle.clientToken', 'paddle.webhookSecret']) await setSetting(k, '');
    await prisma.plan.updateMany({ data: { paddlePriceId: null } });
    invalidatePlans();
  });

  it('hands the browser a Paddle checkout and activates the plan only from the signed webhook', async () => {
    const plans = await A.agent.get('/api/billing/plans');
    expect(plans.body).toMatchObject({ provider: 'paddle', paymentsEnabled: true });
    expect(plans.body.plans.find((p) => p.key === 'pro').purchasable).toBe(true);

    const co = await A.agent.post('/api/billing/checkout').send({ planKey: 'pro' });
    expect(co.status).toBe(200);
    expect(co.body).toMatchObject({ provider: 'paddle', checkout: { environment: 'sandbox', clientToken: 'test_clienttoken123', items: [{ priceId: 'pri_test_pro', quantity: 1 }], customer: { email: A.user.email } } });
    const { customData } = co.body.checkout;
    expect(customData).toMatchObject({ userId: A.user.id, planKey: 'pro' });
    expect((await A.agent.get('/api/billing/me')).body.subscription).toBeNull(); // nothing active from the browser alone

    const remote = subscription({ custom_data: customData });
    paddle.subs.set(remote.id, remote);
    expect((await sendEvent({ event_id: 'evt_bad', event_type: 'subscription.created', occurred_at: new Date().toISOString(), data: remote }, { sig: sign('{}') })).status).toBe(400);
    const ok = await sendEvent({ event_id: 'evt_1', event_type: 'subscription.created', occurred_at: new Date().toISOString(), data: remote });
    expect(ok.status).toBe(200);
    expect((await sendEvent({ event_id: 'evt_1', event_type: 'subscription.created', occurred_at: new Date().toISOString(), data: remote })).body.duplicate).toBe(true);

    const me = await A.agent.get('/api/billing/me');
    expect(me.body.plan.key).toBe('pro');
    expect(me.body.subscription).toMatchObject({ provider: 'paddle', status: 'active', granted: false });
    const row = await prisma.subscription.findUnique({ where: { id: customData.localSubscriptionId } });
    expect(row).toMatchObject({ provider: 'paddle', stripeSubscriptionId: 'sub_01paddletest', stripeCustomerId: 'ctm_01test', status: 'active' });
    expect(await prisma.notification.count({ where: { userId: A.user.id, title: 'Subscription active' } })).toBe(1);
  });

  it('records payments, cancels at period end, and ends the plan on cancellation', async () => {
    const txn = { id: 'txn_01test', status: 'completed', customer_id: 'ctm_01test', subscription_id: 'sub_01paddletest', currency_code: 'USD', billed_at: new Date().toISOString(), details: { totals: { grand_total: String(pro.priceCents) } }, items: [{ price: { description: 'Pro, billed monthly' } }], billing_period: { starts_at: '2026-11-17T00:00:00Z', ends_at: '2026-12-17T00:00:00Z' } };
    expect((await sendEvent({ event_id: 'evt_txn', event_type: 'transaction.completed', occurred_at: new Date().toISOString(), data: txn })).status).toBe(200);
    const me = await A.agent.get('/api/billing/me');
    const pay = me.body.payments[0];
    expect(pay).toMatchObject({ amountCents: pro.priceCents, status: 'paid', currency: 'usd' });
    expect(pay.invoiceUrl).toBe(`/api/billing/payments/${pay.id}/invoice`);

    const cancel = await A.agent.post('/api/billing/cancel');
    expect(cancel.status).toBe(200);
    expect(cancel.body.cancelAtPeriodEnd).toBe(true);
    expect(paddle.calls.some((c) => c.method === 'POST' && c.path === '/subscriptions/sub_01paddletest/cancel' && c.body.effective_from === 'next_billing_period')).toBe(true);

    const ended = subscription({ status: 'canceled', canceled_at: new Date().toISOString() });
    expect((await sendEvent({ event_id: 'evt_end', event_type: 'subscription.canceled', occurred_at: new Date().toISOString(), data: ended })).status).toBe(200);
    expect((await A.agent.get('/api/billing/me')).body.plan.key).toBe('free');
    // A late "active" event never revives an ended subscription.
    paddle.subs.set('sub_01paddletest', subscription());
    await sendEvent({ event_id: 'evt_late', event_type: 'subscription.updated', occurred_at: new Date(Date.now() - 3600_000).toISOString(), data: subscription() });
    expect((await prisma.subscription.findFirst({ where: { stripeSubscriptionId: 'sub_01paddletest' } })).status).toBe('canceled');
  });

  it('creates discount codes in Paddle', async () => {
    const admin = await createAdmin();
    const r = await admin.agent.post('/api/admin/coupons').send({ kind: 'discount', code: 'LAUNCH20', percentOff: 20, duration: 'repeating', durationMonths: 3, maxRedemptions: 50 });
    expect(r.status).toBe(201);
    expect(paddle.discounts.at(-1)).toMatchObject({ code: 'LAUNCH20', type: 'percentage', amount: '20', enabled_for_checkout: true, recur: true, maximum_recurring_intervals: 3, usage_limit: 50 });
    expect(await prisma.coupon.findUnique({ where: { code: 'LAUNCH20' } })).toMatchObject({ provider: 'paddle', stripeCouponId: 'dsc_1' });
  });

  it('sets up products, prices and the webhook in Paddle', async () => {
    await prisma.plan.updateMany({ data: { paddlePriceId: null } });
    await setSetting('paddle.webhookSecret', '');
    const appUrl = config.appUrl;
    try {
      await expect(provisionPaddle(null)).rejects.toThrow(/https/);
      config.appUrl = 'https://dispatch.example.test';
      const report = await provisionPaddle(null);
      expect(report.environment).toBe('sandbox');
      expect(report.webhook).toMatchObject({ action: 'created', secretSaved: true, url: 'https://dispatch.example.test/api/billing/paddle/webhook' });
      const linked = await prisma.plan.findMany({ where: { paddlePriceId: { not: null } } });
      expect(linked.length).toBeGreaterThan(0);
      const priceCall = paddle.calls.find((c) => c.method === 'POST' && c.path === '/prices' && c.body.custom_data.dispatchdesk_plan === 'pro');
      expect(priceCall.body).toMatchObject({ unit_price: { amount: String(pro.priceCents), currency_code: 'USD' }, billing_cycle: { interval: pro.interval === 'year' ? 'year' : 'month', frequency: 1 } });
      const hook = paddle.calls.find((c) => c.method === 'POST' && c.path === '/notification-settings');
      expect(hook.body.subscribed_events).toEqual(expect.arrayContaining(['subscription.created', 'transaction.completed']));

      // Moving from sandbox to live: a saved price the account does not know is replaced; a known one is kept.
      await prisma.plan.update({ where: { key: 'pro' }, data: { paddlePriceId: 'pri_sandbox_old' } });
      const again = await provisionPaddle(null);
      expect(again.plans.find((p) => p.plan === 'pro')).toMatchObject({ action: expect.stringContaining('price created'), priceId: 'pri_pro' });
      expect(again.plans.find((p) => p.plan === 'annual')).toMatchObject({ action: 'kept' });
    } finally {
      config.appUrl = appUrl;
    }
  });
});
