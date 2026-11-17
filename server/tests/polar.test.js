import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

const { registerUser, createAdmin, prisma, app } = await import('./helpers.js');
const { setSetting } = await import('../src/lib/settings.js');
const { invalidatePlans } = await import('../src/lib/plans.js');
const { config } = await import('../src/config.js');
const { verifyPolarSignature, __setPolarFetch, POLAR_API_VERSION } = await import('../src/services/polar.js');
const { provisionPolar } = await import('../src/services/billing/polarProvision.js');

// A Standard Webhooks secret: "whsec_" + base64 key (what Polar issues since 2026-09-08).
const KEY = crypto.randomBytes(24);
const SECRET = `whsec_${KEY.toString('base64')}`;
const sign = (id, ts, body, key = KEY) => `v1,${crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;

// Fake Polar API: answers by method + path, records calls.
const polar = { calls: [], subs: new Map() };
const reply = (status, data) => ({ ok: status < 300, status, json: async () => data });
function fakeFetch(url, opts = {}) {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/v1/, '');
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  polar.calls.push({ method: opts.method, path: path + u.search, body, headers: opts.headers });
  const m = (re) => path.match(re);
  if (opts.method === 'GET' && path === '/products/') return reply(200, { items: [] });
  if (opts.method === 'POST' && path === '/products/') return reply(201, { id: `prod_${body.metadata.dispatchdesk_plan}`, ...body });
  if (opts.method === 'GET' && m(/^\/products\/([^/]+)$/)) return reply(200, { id: m(/^\/products\/([^/]+)$/)[1], is_archived: false });
  if (opts.method === 'GET' && path === '/webhooks/endpoints') return reply(200, { items: [] });
  if (opts.method === 'POST' && path === '/webhooks/endpoints') return reply(201, { id: 'we_1', secret: SECRET, ...body });
  if (opts.method === 'POST' && path === '/checkouts/') return reply(201, { id: 'co_1', url: 'https://polar.test/checkout/co_1', status: 'open', metadata: body.metadata });
  if (opts.method === 'GET' && m(/^\/subscriptions\/([^/]+)$/)) {
    const s = polar.subs.get(m(/^\/subscriptions\/([^/]+)$/)[1]);
    return s ? reply(200, s) : reply(404, { detail: 'Not found' });
  }
  if (opts.method === 'PATCH' && m(/^\/subscriptions\/([^/]+)$/)) {
    const id = m(/^\/subscriptions\/([^/]+)$/)[1];
    const s = { ...polar.subs.get(id), ...body };
    polar.subs.set(id, s);
    return reply(200, s);
  }
  if (opts.method === 'DELETE' && m(/^\/subscriptions\/([^/]+)$/)) return reply(204, null);
  if (opts.method === 'POST' && path === '/discounts/') return reply(201, { id: 'disc_1', ...body });
  if (opts.method === 'PATCH' && m(/^\/discounts\/([^/]+)$/)) return reply(200, { id: m(/^\/discounts\/([^/]+)$/)[1], ...body });
  if (opts.method === 'POST' && path === '/customer-sessions/') return reply(201, { token: 't', customer_portal_url: 'https://polar.test/portal/abc' });
  return reply(404, { detail: `no fake for ${opts.method} ${path}` });
}

const subscription = (over = {}) => ({
  id: 'sub_polar_1', status: 'active', customer_id: 'cus_polar_1', product_id: 'prod_pro', seats: null,
  current_period_start: '2026-11-18T00:00:00Z', current_period_end: '2026-12-18T00:00:00Z',
  cancel_at_period_end: false, canceled_at: null, ended_at: null, metadata: {}, ...over,
});

async function sendEvent(evt, { id = `msg_${crypto.randomUUID()}`, ts = Math.floor(Date.now() / 1000), sig } = {}) {
  const raw = JSON.stringify({ timestamp: new Date().toISOString(), api_version: POLAR_API_VERSION, ...evt });
  return request(app).post('/api/billing/polar/webhook').set('Content-Type', 'application/json')
    .set('webhook-id', id).set('webhook-timestamp', String(ts)).set('webhook-signature', sig ?? sign(id, ts, raw)).send(raw);
}

describe('Polar signature', () => {
  it('accepts Standard Webhooks and legacy secrets and refuses wrong, old or missing ones', () => {
    const body = '{"type":"order.paid"}';
    const ts = Math.floor(Date.now() / 1000);
    const h = (sig) => ({ id: 'msg_1', timestamp: String(ts), signature: sig });
    expect(verifyPolarSignature(body, h(sign('msg_1', ts, body)), SECRET)).toBe(true);
    expect(verifyPolarSignature(Buffer.from(body), h(`v1,bad v1,${sign('msg_1', ts, body).slice(3)}`), SECRET)).toBe(true);
    // Older endpoints: the key is the UTF-8 bytes of the whole secret.
    const legacy = 'whsec_legacysecretnotbase64!';
    expect(verifyPolarSignature(body, h(sign('msg_1', ts, body, Buffer.from(legacy))), legacy)).toBe(true);
    expect(verifyPolarSignature(`${body} `, h(sign('msg_1', ts, body)), SECRET)).toBe(false);
    expect(verifyPolarSignature(body, { id: 'msg_1', timestamp: String(ts - 3600), signature: sign('msg_1', ts - 3600, body) }, SECRET)).toBe(false);
    expect(verifyPolarSignature(body, h(''), SECRET)).toBe(false);
    expect(verifyPolarSignature(body, h(sign('msg_1', ts, body)), '')).toBe(false);
  });
});

describe('selling plans through Polar', () => {
  let A;
  beforeAll(async () => {
    __setPolarFetch(fakeFetch);
    for (const [k, v] of Object.entries({ 'billing.provider': 'polar', 'polar.environment': 'sandbox', 'polar.accessToken': 'polar_oat_test123', 'polar.webhookSecret': '', 'polar.products': '' })) await setSetting(k, v);
    invalidatePlans();
    A = await registerUser();
  });
  afterAll(async () => {
    __setPolarFetch(null);
    for (const k of ['billing.provider', 'polar.environment', 'polar.accessToken', 'polar.webhookSecret', 'polar.products']) await setSetting(k, '');
    invalidatePlans();
  });

  it('sets up products and the webhook once, pinning the API version', async () => {
    const appUrl = config.appUrl;
    try {
      await expect(provisionPolar(null)).rejects.toThrow(/https/);
      config.appUrl = 'https://dispatch.example.test';
      const report = await provisionPolar(null);
      expect(report).toMatchObject({ environment: 'sandbox', webhook: { action: 'created', secretSaved: true, url: 'https://dispatch.example.test/api/billing/polar/webhook' } });
      const pro = polar.calls.find((c) => c.method === 'POST' && c.path === '/products/' && c.body.metadata.dispatchdesk_plan === 'pro');
      expect(pro.body.prices[0]).toMatchObject({ amount_type: 'fixed', price_currency: 'usd' });
      const teams = polar.calls.find((c) => c.method === 'POST' && c.path === '/products/' && c.body.metadata.dispatchdesk_plan === 'teams');
      if (teams) expect(teams.body.prices[0]).toMatchObject({ amount_type: 'seat_based' });
      const hook = polar.calls.find((c) => c.method === 'POST' && c.path === '/webhooks/endpoints');
      expect(hook.body).toMatchObject({ format: 'raw', api_version: POLAR_API_VERSION });
      expect(hook.body.events).toEqual(expect.arrayContaining(['subscription.created', 'order.paid']));
      expect(polar.calls.every((c) => c.headers['Polar-Version'] === POLAR_API_VERSION)).toBe(true);

      const created = polar.calls.filter((c) => c.method === 'POST' && c.path === '/products/').length;
      const again = await provisionPolar(null);
      expect(again.plans.find((p) => p.plan === 'pro')).toMatchObject({ action: 'kept' });
      expect(polar.calls.filter((c) => c.method === 'POST' && c.path === '/products/').length).toBe(created);
    } finally {
      config.appUrl = appUrl;
    }
    const plans = await A.agent.get('/api/billing/plans');
    expect(plans.body).toMatchObject({ provider: 'polar', paymentsEnabled: true });
    expect(plans.body.plans.find((p) => p.key === 'pro').purchasable).toBe(true);
  });

  it('sends the buyer to Polar and activates the plan only from the signed webhook', async () => {
    const co = await A.agent.post('/api/billing/checkout').send({ planKey: 'pro' });
    expect(co.status).toBe(200);
    expect(co.body).toEqual({ provider: 'polar', url: 'https://polar.test/checkout/co_1' });
    const call = polar.calls.findLast((c) => c.method === 'POST' && c.path === '/checkouts/');
    expect(call.body).toMatchObject({ products: ['prod_pro'], customer_email: A.user.email, external_customer_id: A.user.id });
    const md = call.body.metadata;
    expect(md.checkoutToken).toMatch(/^ddck_/);
    expect((await A.agent.get('/api/billing/me')).body.subscription).toBeNull();

    // Wrong signature: refused. Edited metadata without the token: not attached to anyone.
    const remote = subscription({ metadata: md });
    polar.subs.set(remote.id, remote);
    expect((await sendEvent({ type: 'subscription.created', data: remote }, { sig: 'v1,bm9wZQ==' })).status).toBe(403);
    const forged = subscription({ id: 'sub_forged', customer_id: 'cus_attacker', metadata: { localSubscriptionId: md.localSubscriptionId } });
    polar.subs.set(forged.id, forged);
    expect((await sendEvent({ type: 'subscription.created', data: forged })).status).toBe(200);
    expect(await prisma.subscription.count({ where: { stripeSubscriptionId: 'sub_forged' } })).toBe(0);

    const ok = await sendEvent({ type: 'subscription.created', data: remote }, { id: 'msg_sub_1' });
    expect(ok.status).toBe(200);
    expect((await sendEvent({ type: 'subscription.created', data: remote }, { id: 'msg_sub_1' })).body.duplicate).toBe(true);
    const me = await A.agent.get('/api/billing/me');
    expect(me.body.plan.key).toBe('pro');
    expect(me.body.subscription).toMatchObject({ provider: 'polar', status: 'active' });
    expect(await prisma.notification.count({ where: { userId: A.user.id, title: 'Subscription active' } })).toBe(1);

    const order = { id: 'ord_1', status: 'paid', paid: true, total_amount: 999, currency: 'usd', billing_reason: 'subscription_create', customer_id: 'cus_polar_1', subscription_id: 'sub_polar_1', product: { name: 'DispatchDesk Pro' }, created_at: new Date().toISOString() };
    expect((await sendEvent({ type: 'order.paid', data: order })).status).toBe(200);
    const pay = (await A.agent.get('/api/billing/me')).body.payments[0];
    expect(pay).toMatchObject({ amountCents: 999, status: 'paid', currency: 'usd', description: 'DispatchDesk Pro' });
  });

  it('cancels at period end, resumes, opens the portal, and ends the plan when revoked', async () => {
    const cancel = await A.agent.post('/api/billing/cancel').send({ reason: 'too_expensive' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.cancelAtPeriodEnd).toBe(true);
    expect(polar.calls.findLast((c) => c.method === 'PATCH').body).toEqual({ cancel_at_period_end: true });
    const resume = await A.agent.post('/api/billing/resume');
    expect(resume.body.cancelAtPeriodEnd).toBe(false);
    const portal = await A.agent.post('/api/billing/portal');
    expect(portal.body.url).toBe('https://polar.test/portal/abc');
    expect(polar.calls.findLast((c) => c.path === '/customer-sessions/').body).toMatchObject({ customer_id: 'cus_polar_1' });

    const ended = subscription({ status: 'canceled', ended_at: new Date().toISOString(), canceled_at: new Date().toISOString() });
    polar.subs.set('sub_polar_1', ended);
    expect((await sendEvent({ type: 'subscription.revoked', data: ended })).status).toBe(200);
    expect((await A.agent.get('/api/billing/me')).body.plan.key).toBe('free');
  });

  it('creates discount codes in Polar (letters and digits only) and switches them off', async () => {
    const admin = await createAdmin();
    const bad = await admin.agent.post('/api/admin/coupons').send({ kind: 'discount', code: 'POLAR-25', percentOff: 25, duration: 'once' });
    expect(bad.status).toBe(400);
    const r = await admin.agent.post('/api/admin/coupons').send({ kind: 'discount', code: 'POLAR25', percentOff: 25, duration: 'repeating', durationMonths: 3, maxRedemptions: 50 });
    expect(r.status).toBe(201);
    expect(polar.calls.findLast((c) => c.path === '/discounts/').body).toMatchObject({ type: 'percentage', basis_points: 2500, code: 'POLAR25', duration: 'repeating', duration_in_months: 3, max_redemptions: 50 });
    const id = r.body.coupon.id;
    expect((await admin.agent.patch(`/api/admin/coupons/${id}`).send({ active: false })).status).toBe(200);
    expect(polar.calls.findLast((c) => c.method === 'PATCH' && c.path.startsWith('/discounts/')).body.ends_at).toBeTruthy();
  });
});
