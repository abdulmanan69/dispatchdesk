import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { registerUser, createAdmin, prisma } from './helpers.js';
import { config } from '../src/config.js';
import { setSetting, getSetting } from '../src/lib/settings.js';
import { __setStripeClient } from '../src/services/stripe.js';
import { STRIPE_WEBHOOK_EVENTS } from '../src/routes/adminSetup.js';

/** Minimal in-memory Stripe double covering what provisioning uses. */
function fakeStripe({ existingWebhookUrl } = {}) {
  const s = { products: [], prices: [], webhooks: [], deleted: [], n: 0 };
  const id = (p) => `${p}_${++s.n}`;
  if (existingWebhookUrl) s.webhooks.push({ id: 'we_old', url: existingWebhookUrl, enabled_events: ['checkout.session.completed'] });
  s.client = {
    balance: { retrieve: async () => ({ livemode: false }) },
    products: {
      search: async ({ query }) => ({ data: s.products.filter((p) => query.includes(`'${p.metadata.dispatchdesk_plan}'`)) }),
      list: async () => ({ data: s.products }),
      create: async (args) => { const p = { id: id('prod'), ...args }; s.products.push(p); return p; },
    },
    prices: {
      list: async ({ product }) => ({ data: s.prices.filter((p) => p.product === product) }),
      create: async (args) => { const p = { id: id('price'), ...args }; s.prices.push(p); return p; },
    },
    webhookEndpoints: {
      list: async () => ({ data: s.webhooks }),
      create: async (args) => { const w = { id: id('we'), secret: `whsec_${s.n}`, ...args }; s.webhooks.push(w); return w; },
      update: async (wid, args) => { const w = s.webhooks.find((x) => x.id === wid); Object.assign(w, args); return w; },
      del: async (wid) => { s.deleted.push(wid); s.webhooks = s.webhooks.filter((x) => x.id !== wid); return { deleted: true }; },
    },
  };
  return s;
}

describe('admin setup checklist', () => {
  let admin; let originalUrl; let savedPrices;
  beforeAll(async () => {
    admin = await createAdmin();
    originalUrl = config.appUrl;
    savedPrices = await prisma.plan.findMany({ select: { id: true, stripePriceId: true } });
  });
  afterEach(async () => {
    config.appUrl = originalUrl;
    await setSetting('stripe.secretKey', '');
    await setSetting('stripe.webhookSecret', '');
    for (const p of savedPrices) await prisma.plan.update({ where: { id: p.id }, data: { stripePriceId: p.stripePriceId } });
  });
  afterAll(() => { config.appUrl = originalUrl; });

  it('lists every area with status, never returning secret values', async () => {
    await setSetting('stripe.secretKey', 'sk_test_supersecretvalue');
    await setSetting('stripe.webhookSecret', '');
    const prevEia = await getSetting('eia.apiKey');
    await setSetting('eia.apiKey', '');
    const res = await admin.agent.get('/api/admin/setup');
    expect(res.status).toBe(200);
    const keys = res.body.items.map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(['app_url', 'platform_email', 'stripe', 'google_oauth', 'microsoft_oauth', 'eia', 'ai', 'fmcsa', 'backups']));
    const stripe = res.body.items.find((i) => i.key === 'stripe');
    expect(stripe.status).toBe('partial');
    expect(stripe.values.find((v) => v.label === 'Webhook events').value).toBe(STRIPE_WEBHOOK_EVENTS.join(', '));
    expect(JSON.stringify(res.body)).not.toContain('supersecretvalue');
    expect(res.body.items.find((i) => i.key === 'app_url').status).toBe('todo'); // tests run on http
    expect(res.body.items.find((i) => i.key === 'eia').status).toBe('partial'); // demo key
    expect(res.body.progress.total).toBeGreaterThanOrEqual(3);
    await setSetting('eia.apiKey', prevEia || '');
  });

  it('marks platform email done when a Brevo API key and From address are set (no SMTP host)', async () => {
    const prev = { host: await getSetting('smtp.host'), from: await getSetting('smtp.from'), brevo: await getSetting('brevo.apiKey') };
    await setSetting('smtp.host', '');
    await setSetting('smtp.from', 'DispatchDesk <no-reply@example.com>');
    await setSetting('brevo.apiKey', 'xkeysib-test-secret');
    const res = await admin.agent.get('/api/admin/setup');
    const item = res.body.items.find((i) => i.key === 'platform_email');
    expect(item.status).toBe('done');
    expect(item.detail || item.description || JSON.stringify(item)).toContain('Brevo API');
    expect(JSON.stringify(res.body)).not.toContain('xkeysib-test-secret');
    await setSetting('smtp.host', prev.host || '');
    await setSetting('smtp.from', prev.from || '');
    await setSetting('brevo.apiKey', prev.brevo || '');
  });

  it('is admin-only', async () => {
    const u = await registerUser();
    expect((await u.agent.get('/api/admin/setup')).status).toBe(403);
    expect((await u.agent.post('/api/admin/setup/stripe/provision').send({})).status).toBe(403);
  });

  it('refuses to provision without https or without a key', async () => {
    await setSetting('stripe.secretKey', 'sk_test_x');
    expect((await admin.agent.post('/api/admin/setup/stripe/provision').send({})).status).toBe(400);
    config.appUrl = 'https://dispatch.example.test';
    await setSetting('stripe.secretKey', '');
    expect((await admin.agent.post('/api/admin/setup/stripe/provision').send({})).status).toBe(503);
  });

  it('creates products, prices and the webhook once, then reuses them', async () => {
    config.appUrl = 'https://dispatch.example.test';
    await setSetting('stripe.secretKey', 'sk_test_x');
    await prisma.plan.updateMany({ where: { key: { not: 'free' } }, data: { stripePriceId: null } });
    const fake = fakeStripe();
    __setStripeClient('sk_test_x', fake.client);

    const first = await admin.agent.post('/api/admin/setup/stripe/provision').send({});
    expect(first.status).toBe(200);
    expect(first.body.mode).toBe('test');
    const paid = await prisma.plan.findMany({ where: { active: true, key: { not: 'free' } } });
    for (const p of paid) expect(p.stripePriceId).toMatch(/^price_/);
    const pro = paid.find((p) => p.key === 'pro');
    const proPrice = fake.prices.find((x) => x.id === pro.stripePriceId);
    expect(proPrice).toMatchObject({ unit_amount: pro.priceCents, currency: 'usd', recurring: { interval: 'month', usage_type: 'licensed' } });
    const annual = paid.find((p) => p.key === 'annual');
    if (annual) expect(fake.prices.find((x) => x.id === annual.stripePriceId).recurring.interval).toBe('year');
    expect(first.body.webhook).toMatchObject({ action: 'created', url: 'https://dispatch.example.test/api/billing/webhook' });
    expect(fake.webhooks[0].enabled_events).toEqual(STRIPE_WEBHOOK_EVENTS);
    expect(await getSetting('stripe.webhookSecret')).toMatch(/^whsec_/);

    // Second run: nothing new.
    const counts = [fake.products.length, fake.prices.length, fake.webhooks.length];
    const second = await admin.agent.post('/api/admin/setup/stripe/provision').send({});
    expect(second.body.plans.every((p) => p.action === 'kept')).toBe(true);
    expect(second.body.webhook.action).toBe('reused');
    expect([fake.products.length, fake.prices.length, fake.webhooks.length]).toEqual(counts);

    // Plans unlinked again: existing products and prices are found and reused.
    await prisma.plan.updateMany({ where: { key: { not: 'free' } }, data: { stripePriceId: null } });
    const third = await admin.agent.post('/api/admin/setup/stripe/provision').send({});
    expect(third.body.plans.every((p) => p.action === 'product reused, price reused')).toBe(true);
    expect(fake.prices.length).toBe(counts[1]);
  });

  it('asks before replacing a webhook whose secret is unknown, and recreates it when confirmed', async () => {
    config.appUrl = 'https://dispatch.example.test';
    await setSetting('stripe.secretKey', 'sk_test_y');
    const fake = fakeStripe({ existingWebhookUrl: 'https://dispatch.example.test/api/billing/webhook' });
    __setStripeClient('sk_test_y', fake.client);
    const ask = await admin.agent.post('/api/admin/setup/stripe/provision').send({});
    expect(ask.body.webhook.action).toBe('needs_confirmation');
    expect(fake.deleted).toEqual([]);
    const redo = await admin.agent.post('/api/admin/setup/stripe/provision').send({ recreateWebhook: true });
    expect(redo.body.webhook.action).toBe('recreated');
    expect(fake.deleted).toEqual(['we_old']);
    expect(await getSetting('stripe.webhookSecret')).toMatch(/^whsec_/);
  });
});

describe('database backups', () => {
  it('creates, lists and downloads a consistent SQLite copy; blocks traversal and non-admins', async () => {
    const admin = await createAdmin();
    const made = await admin.agent.post('/api/admin/setup/backups');
    expect(made.status).toBe(201);
    expect(made.body.backup.name).toMatch(/^app-\d{4}-\d{2}-\d{2}-\d{6}\.db$/);
    const list = (await admin.agent.get('/api/admin/setup/backups')).body.items;
    expect(list.some((b) => b.name === made.body.backup.name)).toBe(true);
    const dl = await admin.agent.get(`/api/admin/setup/backups/${made.body.backup.name}`).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(dl.status).toBe(200);
    expect(dl.body.subarray(0, 15).toString()).toBe('SQLite format 3');
    expect((await admin.agent.get('/api/admin/setup/backups/..%2F..%2Fapp.db')).status).toBe(400);
    const user = await registerUser();
    expect((await user.agent.post('/api/admin/setup/backups')).status).toBe(403);
  });
});
