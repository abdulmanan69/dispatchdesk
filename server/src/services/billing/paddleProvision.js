import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { badRequest } from '../../lib/errors.js';
import { getSettings, setSetting } from '../../lib/settings.js';
import { invalidatePlans } from '../../lib/plans.js';
import { paddleApi, paddleConfig, PADDLE_EVENTS } from '../paddle.js';

export const paddleWebhookUrl = () => `${config.appUrl}/api/billing/paddle/webhook`;

/** Paddle products made earlier for a plan carry custom_data.dispatchdesk_plan. */
async function findProduct(planKey) {
  const list = await paddleApi('GET', '/products?status=active&per_page=200');
  return (list || []).find((p) => p.custom_data?.dispatchdesk_plan === planKey) || null;
}

async function createProduct(plan) {
  const body = { name: `DispatchDesk ${plan.name}`, description: plan.description || undefined, custom_data: { dispatchdesk_plan: plan.key } };
  try {
    return await paddleApi('POST', '/products', { ...body, tax_category: 'saas' });
  } catch (err) {
    // Some accounts need approval for the SaaS tax category; "standard" is always available.
    if (!/tax/i.test(err.message)) throw err;
    return paddleApi('POST', '/products', { ...body, tax_category: 'standard' });
  }
}

/**
 * Admin → Setup → "Set up Paddle": check the API key, create a product and a recurring USD price for every paid plan
 * that has none yet (reusing earlier ones), and create the webhook destination, saving its signing secret.
 * Safe to run again: it keeps what exists.
 */
export async function provisionPaddle(userId) {
  if (!config.appUrl.startsWith('https://')) throw badRequest('APP_URL must be a public https address before Paddle can send webhooks to it');
  const c = await paddleConfig();
  if (!c.apiKey) throw badRequest('Save the Paddle API key in System settings → Billing first');
  try {
    await paddleApi('GET', '/event-types');
  } catch (err) {
    throw badRequest(`Paddle rejected the API key (${c.environment}): ${err.message}`);
  }
  const report = { environment: c.environment, plans: [], webhook: null };

  const plans = await prisma.plan.findMany({ where: { active: true, key: { not: 'free' } }, orderBy: { sortOrder: 'asc' } });
  for (const plan of plans) {
    if (plan.paddlePriceId) {
      // A price from the other environment (sandbox → live) does not exist in this account: make a new one.
      const exists = await paddleApi('GET', `/prices/${encodeURIComponent(plan.paddlePriceId)}`).then(() => true, (err) => {
        if (err.status === 404) return false;
        throw err;
      });
      if (exists) { report.plans.push({ plan: plan.key, action: 'kept', priceId: plan.paddlePriceId }); continue; }
      plan.paddlePriceId = null;
    }
    if (!plan.priceCents) { report.plans.push({ plan: plan.key, action: 'skipped', reason: 'price is 0' }); continue; }
    if (plan.basePriceCents) { report.plans.push({ plan: plan.key, action: 'skipped', reason: 'plans with a base fee are not sold through Paddle yet' }); continue; }
    let product = await findProduct(plan.key);
    const productAction = product ? 'reused' : 'created';
    if (!product) product = await createProduct(plan);
    const interval = plan.interval === 'year' ? 'year' : 'month';
    const prices = await paddleApi('GET', `/prices?product_id=${encodeURIComponent(product.id)}&status=active&per_page=200`);
    let price = (prices || []).find((p) => p.unit_price?.amount === String(plan.priceCents) && p.unit_price?.currency_code === 'USD' && p.billing_cycle?.interval === interval);
    const priceAction = price ? 'reused' : 'created';
    if (!price) {
      price = await paddleApi('POST', '/prices', {
        product_id: product.id,
        description: `${plan.name}${plan.perSeat ? ' per user' : ''}, billed ${interval === 'year' ? 'yearly' : 'monthly'}`,
        name: plan.name,
        unit_price: { amount: String(plan.priceCents), currency_code: 'USD' },
        billing_cycle: { interval, frequency: 1 },
        ...(plan.trialDays ? { trial_period: { interval: 'day', frequency: plan.trialDays } } : {}),
        quantity: plan.perSeat ? { minimum: Math.max(1, plan.minSeats), maximum: 999 } : { minimum: 1, maximum: 1 },
        custom_data: { dispatchdesk_plan: plan.key },
      });
    }
    await prisma.plan.update({ where: { id: plan.id }, data: { paddlePriceId: price.id } });
    report.plans.push({ plan: plan.key, action: `product ${productAction}, price ${priceAction}`, productId: product.id, priceId: price.id, perSeat: plan.perSeat });
  }

  const url = paddleWebhookUrl();
  const destinations = await paddleApi('GET', '/notification-settings');
  const existing = (destinations || []).find((n) => n.destination === url && n.type === 'url');
  if (existing) {
    const have = new Set((existing.subscribed_events || []).map((e) => e.name || e));
    const missing = PADDLE_EVENTS.filter((e) => !have.has(e));
    if (missing.length) await paddleApi('PATCH', `/notification-settings/${existing.id}`, { subscribed_events: [...have, ...missing] });
    if (existing.endpoint_secret_key) await setSetting('paddle.webhookSecret', existing.endpoint_secret_key, userId);
    report.webhook = { action: missing.length ? 'reused, events added' : 'reused', id: existing.id, url, secretSaved: !!existing.endpoint_secret_key };
  } else {
    const created = await paddleApi('POST', '/notification-settings', {
      description: 'DispatchDesk billing', type: 'url', destination: url, subscribed_events: PADDLE_EVENTS, api_version: 1,
    });
    await setSetting('paddle.webhookSecret', created.endpoint_secret_key, userId);
    report.webhook = { action: 'created', id: created.id, url, secretSaved: true };
  }
  invalidatePlans();
  const s = await getSettings(['billing.provider']);
  report.providerActive = s['billing.provider'] === 'paddle';
  return report;
}
