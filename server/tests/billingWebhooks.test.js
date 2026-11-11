import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Stripe from 'stripe';
import { agent, registerUser, prisma } from './helpers.js';
import { setSetting } from '../src/lib/settings.js';
import { __setStripeClient } from '../src/services/stripe.js';
import { STRIPE_WEBHOOK_EVENTS } from '../src/routes/adminSetup.js';

const WHSEC = 'whsec_test_secret_for_webhook_order_tests';
const signer = new Stripe('sk_test_signer_only');
let n = 0;
const uid = (p) => `${p}_${Date.now()}_${++n}`;

async function send(event) {
  const payload = JSON.stringify(event);
  const header = signer.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
  const a = await agent();
  return a.raw.post('/api/billing/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', header).send(payload);
}

function remoteSub(id, { userId, status = 'active', priceId = 'price_pro_whtest' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id, object: 'subscription', status, customer: 'cus_whtest', cancel_at_period_end: false,
    current_period_start: now, current_period_end: now + 30 * 86400, trial_end: null, canceled_at: status === 'canceled' ? now : null,
    metadata: { userId }, items: { data: [{ id: 'si_whtest', quantity: 1, price: { id: priceId } }] },
  };
}

const subEvent = (type, sub, created) => ({ id: uid('evt'), type, created, data: { object: sub } });

describe('Stripe webhooks: ordering and idempotency', () => {
  let fake;
  let savedPrice;
  beforeAll(async () => {
    await setSetting('stripe.webhookSecret', WHSEC);
    savedPrice = (await prisma.plan.findUnique({ where: { key: 'pro' } })).stripePriceId;
    await prisma.plan.update({ where: { key: 'pro' }, data: { stripePriceId: 'price_pro_whtest' } });
  });
  beforeEach(async () => {
    // Default: no Stripe API key, so events are applied from their (signed) payloads.
    await setSetting('stripe.secretKey', '');
    fake = null;
  });
  afterAll(async () => {
    await setSetting('stripe.webhookSecret', '');
    await setSetting('stripe.secretKey', '');
    await prisma.plan.update({ where: { key: 'pro' }, data: { stripePriceId: savedPrice } });
  });

  it('does not subscribe the duplicate invoice.payment_succeeded event', () => {
    expect(STRIPE_WEBHOOK_EVENTS).toContain('invoice.paid');
    expect(STRIPE_WEBHOOK_EVENTS).not.toContain('invoice.payment_succeeded');
  });

  it('a stale "updated" (active) after "deleted" never revives the plan', async () => {
    const { agent: a, user } = await registerUser();
    const subId = uid('sub');
    const t0 = Math.floor(Date.now() / 1000);
    expect((await send(subEvent('customer.subscription.created', remoteSub(subId, { userId: user.id }), t0))).status).toBe(200);
    expect((await a.get('/api/billing/me')).body.plan.key).toBe('pro');

    expect((await send(subEvent('customer.subscription.deleted', remoteSub(subId, { userId: user.id, status: 'canceled' }), t0 + 20))).status).toBe(200);
    expect((await a.get('/api/billing/me')).body.plan.key).toBe('free');
    const ended = await prisma.notification.count({ where: { userId: user.id, title: 'Subscription ended' } });
    expect(ended).toBe(1);

    // Delivered late (older created): skipped.
    expect((await send(subEvent('customer.subscription.updated', remoteSub(subId, { userId: user.id, status: 'active' }), t0 + 10))).status).toBe(200);
    expect((await a.get('/api/billing/me')).body.plan.key).toBe('free');
    // Even with a newer timestamp, an ended Stripe subscription is never moved back to active.
    expect((await send(subEvent('customer.subscription.updated', remoteSub(subId, { userId: user.id, status: 'active' }), t0 + 30))).status).toBe(200);
    expect((await prisma.subscription.findUnique({ where: { stripeSubscriptionId: subId } })).status).toBe('canceled');
    expect((await a.get('/api/billing/me')).body.plan.key).toBe('free');
  });

  it('applies events by their Stripe time: an older event never overwrites a newer state', async () => {
    const { user } = await registerUser();
    const subId = uid('sub');
    const t0 = Math.floor(Date.now() / 1000);
    await send(subEvent('customer.subscription.created', remoteSub(subId, { userId: user.id }), t0));
    await send(subEvent('customer.subscription.updated', remoteSub(subId, { userId: user.id, status: 'past_due' }), t0 + 50));
    await send(subEvent('customer.subscription.updated', remoteSub(subId, { userId: user.id, status: 'active' }), t0 + 40)); // late retry
    expect((await prisma.subscription.findUnique({ where: { stripeSubscriptionId: subId } })).status).toBe('past_due');
  });

  it('with a Stripe key, syncs from the current subscription instead of the payload', async () => {
    const { user } = await registerUser();
    const subId = uid('sub');
    fake = { subscriptions: { retrieve: async (id) => fake.subs[id] }, subs: {} };
    await setSetting('stripe.secretKey', 'sk_test_whtest_fake');
    __setStripeClient('sk_test_whtest_fake', fake);
    fake.subs[subId] = remoteSub(subId, { userId: user.id, status: 'past_due' });
    const t0 = Math.floor(Date.now() / 1000);
    // The payload says active, but Stripe's current state is past_due.
    await send(subEvent('customer.subscription.updated', remoteSub(subId, { userId: user.id, status: 'active' }), t0));
    expect((await prisma.subscription.findUnique({ where: { stripeSubscriptionId: subId } })).status).toBe('past_due');
  });

  it('a failed handler releases the event id so the retry is processed', async () => {
    const { user } = await registerUser();
    const subId = uid('sub');
    let calls = 0;
    fake = { subscriptions: { retrieve: async (id) => { calls += 1; if (calls === 1) throw Object.assign(new Error('Stripe is down'), { statusCode: 500 }); return remoteSub(id, { userId: user.id }); } } };
    await setSetting('stripe.secretKey', 'sk_test_whtest_fake2');
    __setStripeClient('sk_test_whtest_fake2', fake);
    const evt = subEvent('customer.subscription.created', remoteSub(subId, { userId: user.id }), Math.floor(Date.now() / 1000));
    const first = await send(evt);
    expect(first.status).toBe(500);
    expect(await prisma.stripeEvent.findUnique({ where: { id: evt.id } })).toBeNull();
    const retry = await send(evt);
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBeUndefined();
    expect((await prisma.subscription.findUnique({ where: { stripeSubscriptionId: subId } })).status).toBe('active');
    expect((await send(evt)).body.duplicate).toBe(true);
  });

  it('a fresh pending claim answers 409; a stale one is taken over and processed', async () => {
    const { user } = await registerUser();
    const subId = uid('sub');
    await prisma.subscription.create({ data: { userId: user.id, planId: (await prisma.plan.findUnique({ where: { key: 'pro' } })).id, status: 'active', seats: 1, stripeSubscriptionId: subId, stripeCustomerId: 'cus_whtest' } });
    const inv = { id: uid('in'), object: 'invoice', subscription: subId, customer: 'cus_whtest', amount_paid: 1500, currency: 'usd', lines: { data: [{ description: 'Pro', period: { start: 1, end: 2 } }] }, status_transitions: { paid_at: Math.floor(Date.now() / 1000) } };
    const evt = { id: uid('evt'), type: 'invoice.paid', created: Math.floor(Date.now() / 1000), data: { object: inv } };
    // Another worker claimed it a moment ago and is still working.
    await prisma.stripeEvent.create({ data: { id: evt.id, type: 'pending:invoice.paid' } });
    const busy = await send(evt);
    expect(busy.status).toBe(409);
    expect(await prisma.payment.count({ where: { stripeInvoiceId: inv.id } })).toBe(0);
    // That worker died: after 10 minutes the claim is stale and the next delivery processes the event.
    await prisma.stripeEvent.update({ where: { id: evt.id }, data: { processedAt: new Date(Date.now() - 11 * 60_000) } });
    const ok = await send(evt);
    expect(ok.status).toBe(200);
    expect(ok.body.duplicate).toBeUndefined();
    expect(await prisma.payment.count({ where: { stripeInvoiceId: inv.id } })).toBe(1);
    expect((await prisma.stripeEvent.findUnique({ where: { id: evt.id } })).type).toBe('invoice.paid');
  });

  it('concurrent deliveries of one event are processed once', async () => {
    const { user } = await registerUser();
    const subId = uid('sub');
    const local = await prisma.subscription.create({ data: { userId: user.id, planId: (await prisma.plan.findUnique({ where: { key: 'pro' } })).id, status: 'active', seats: 1, stripeSubscriptionId: subId, stripeCustomerId: 'cus_whtest' } });
    const inv = { id: uid('in'), object: 'invoice', subscription: subId, customer: 'cus_whtest', amount_paid: 1500, currency: 'usd', lines: { data: [{ description: 'Pro', period: { start: 1, end: 2 } }] }, status_transitions: { paid_at: Math.floor(Date.now() / 1000) } };
    const evt = { id: uid('evt'), type: 'invoice.paid', created: Math.floor(Date.now() / 1000), data: { object: inv } };
    const results = await Promise.all([send(evt), send(evt), send(evt)]);
    // One delivery processes the event. The others either find it done (200 duplicate) or still pending (409, so
    // Stripe retries instead of treating the event as delivered while the first attempt could still fail).
    expect(results.filter((r) => r.status === 200 && !r.body.duplicate).length).toBe(1);
    for (const r of results) expect(r.status === 409 || (r.status === 200)).toBe(true);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.retry)).toBe(true);
    expect((await send(evt)).body.duplicate).toBe(true);
    expect((await prisma.stripeEvent.findUnique({ where: { id: evt.id } })).type).toBe('invoice.paid');
    expect(await prisma.payment.count({ where: { stripeInvoiceId: inv.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: user.id, title: 'Payment received' } })).toBe(1);

    // invoice.payment_succeeded for the same invoice (older endpoints still send it): no second notification.
    await send({ id: uid('evt'), type: 'invoice.payment_succeeded', created: Math.floor(Date.now() / 1000), data: { object: inv } });
    expect(await prisma.notification.count({ where: { userId: user.id, title: 'Payment received' } })).toBe(1);
    // A late failure notice never turns a paid invoice into a failed one.
    await send({ id: uid('evt'), type: 'invoice.payment_failed', created: Math.floor(Date.now() / 1000), data: { object: { ...inv, amount_due: 1500 } } });
    expect((await prisma.payment.findUnique({ where: { stripeInvoiceId: inv.id } })).status).toBe('paid');
    expect(local.id).toBeTruthy();
  });
});
