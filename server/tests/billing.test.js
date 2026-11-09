import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Stripe from 'stripe';
import { agent, registerUser, prisma } from './helpers.js';
import { setSetting } from '../src/lib/settings.js';
import { __setStripeClient } from '../src/services/stripe.js';

const WHSEC = 'whsec_test_secret_for_unit_tests';
const signer = new Stripe('sk_test_signer_only');

function signed(event) {
  const payload = JSON.stringify(event);
  return { payload, header: signer.webhooks.generateTestHeaderString({ payload, secret: WHSEC }) };
}

async function sendWebhook(event) {
  const a = await agent();
  const { payload, header } = signed(event);
  return a.raw.post('/api/billing/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', header).send(payload);
}

function remoteSub(id, { userId, priceId, status = 'active', localId, quantity = 1, cancel = false }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id, object: 'subscription', status, customer: 'cus_test_1', cancel_at_period_end: cancel,
    current_period_start: now, current_period_end: now + 30 * 86400, trial_end: null, canceled_at: null,
    metadata: { userId, localSubscriptionId: localId || '' },
    items: { data: [{ id: 'si_1', quantity, price: { id: priceId } }] },
  };
}

describe('billing', () => {
  let fake;
  beforeAll(async () => {
    await setSetting('stripe.webhookSecret', WHSEC);
    await setSetting('stripe.secretKey', 'sk_test_fake_key');
    await prisma.plan.update({ where: { key: 'pro' }, data: { stripePriceId: 'price_pro_test' } });
    fake = {
      checkout: { sessions: { create: async (args) => { fake.lastCheckout = args; return { id: `cs_test_${Date.now()}`, url: 'https://checkout.stripe.test/session' }; } } },
      subscriptions: {
        retrieve: async (id) => fake.subs[id],
        update: async (id, args) => { fake.subs[id] = { ...fake.subs[id], cancel_at_period_end: args.cancel_at_period_end ?? fake.subs[id].cancel_at_period_end }; return fake.subs[id]; },
      },
      billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.test/portal' }) } },
      subs: {},
    };
    __setStripeClient('sk_test_fake_key', fake);
  });
  afterAll(async () => {
    await setSetting('stripe.secretKey', '');
    await setSetting('stripe.webhookSecret', '');
  });

  it('lists plans publicly with features and limits', async () => {
    const res = await (await agent()).get('/api/billing/plans');
    expect(res.status).toBe(200);
    expect(res.body.plans.map((p) => p.key)).toEqual(expect.arrayContaining(['free', 'pro', 'annual', 'teams']));
    expect(res.body.plans.find((p) => p.key === 'pro').features.length).toBeGreaterThan(3);
  });

  it('refuses checkout for plans without a Stripe price', async () => {
    const { agent: a } = await registerUser();
    const res = await a.post('/api/billing/checkout').send({ planKey: 'annual' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/Stripe price/);
  });

  it('does not activate on checkout alone; activates only from verified webhooks', async () => {
    const { agent: a, user } = await registerUser();
    const checkout = await a.post('/api/billing/checkout').send({ planKey: 'pro' });
    expect(checkout.status).toBe(200);
    expect(checkout.body.url).toContain('checkout.stripe.test');
    expect(fake.lastCheckout.client_reference_id).toBe(user.id);

    let me = await a.get('/api/billing/me');
    expect(me.body.plan.key).toBe('free');
    expect(me.body.pendingSubscription.status).toBe('incomplete');
    const local = await prisma.subscription.findFirst({ where: { userId: user.id } });

    // Forged signature is rejected.
    const anon = await agent();
    const forged = await anon.raw.post('/api/billing/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', 't=1,v1=deadbeef').send('{"id":"evt_x"}');
    expect(forged.status).toBe(400);
    me = await a.get('/api/billing/me');
    expect(me.body.plan.key).toBe('free');

    const subId = `sub_${Date.now()}`;
    fake.subs[subId] = remoteSub(subId, { userId: user.id, priceId: 'price_pro_test', localId: local.id });
    const evt = {
      id: `evt_${Date.now()}`, type: 'checkout.session.completed',
      data: { object: { id: local.stripeCheckoutId, object: 'checkout.session', subscription: subId, customer: 'cus_test_1', client_reference_id: user.id, metadata: { localSubscriptionId: local.id } } },
    };
    expect((await sendWebhook(evt)).status).toBe(200);
    const dup = await sendWebhook(evt);
    expect(dup.body.duplicate).toBe(true);

    me = await a.get('/api/billing/me');
    expect(me.body.plan.key).toBe('pro');
    expect(me.body.subscription.status).toBe('active');

    // Invoice paid creates a payment record.
    const inv = await sendWebhook({
      id: `evt_inv_${Date.now()}`, type: 'invoice.paid',
      data: { object: { id: `in_${Date.now()}`, object: 'invoice', subscription: subId, customer: 'cus_test_1', amount_paid: 999, currency: 'usd', hosted_invoice_url: 'https://invoice.stripe.test/i', lines: { data: [{ description: '1 × Pro', period: { start: 1, end: 2 } }] }, status_transitions: { paid_at: Math.floor(Date.now() / 1000) } } },
    });
    expect(inv.status).toBe(200);
    me = await a.get('/api/billing/me');
    expect(me.body.payments[0]).toMatchObject({ amountCents: 999, status: 'paid' });

    // Cancel at period end (state from Stripe's response).
    const cancel = await a.post('/api/billing/cancel');
    expect(cancel.body.cancelAtPeriodEnd).toBe(true);

    // Subscription deleted → back to Free.
    await sendWebhook({ id: `evt_del_${Date.now()}`, type: 'customer.subscription.deleted', data: { object: { ...fake.subs[subId], status: 'canceled' } } });
    me = await a.get('/api/billing/me');
    expect(me.body.plan.key).toBe('free');
  });

  it('webhook returns 503 when no webhook secret is configured', async () => {
    await setSetting('stripe.webhookSecret', '');
    const { payload, header } = signed({ id: 'evt_none', type: 'ping', data: { object: {} } });
    const res = await (await agent()).raw.post('/api/billing/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', header).send(payload);
    expect(res.status).toBe(503);
    await setSetting('stripe.webhookSecret', WHSEC);
  });

  it('requires auth for account billing endpoints', async () => {
    const a = await agent();
    expect((await a.get('/api/billing/me')).status).toBe(401);
    expect((await a.post('/api/billing/checkout').send({ planKey: 'pro' })).status).toBe(401);
  });
});
