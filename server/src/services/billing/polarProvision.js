import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { badRequest } from '../../lib/errors.js';
import { getSettings, setSetting } from '../../lib/settings.js';
import { invalidatePlans } from '../../lib/plans.js';
import { polarApi, polarConfig, POLAR_EVENTS, POLAR_API_VERSION } from '../polar.js';

export const polarWebhookUrl = () => `${config.appUrl}/api/billing/polar/webhook`;

/** Polar product for a plan: a recurring product with one USD price (per seat for per-seat plans). */
function productBody(plan) {
  const interval = plan.interval === 'year' ? 'year' : 'month';
  const price = plan.perSeat
    ? { amount_type: 'seat_based', price_currency: 'usd', seat_tiers: { seat_tier_type: 'volume', tiers: [{ min_seats: 1, max_seats: null, price_per_seat: plan.priceCents }] } }
    : { amount_type: 'fixed', price_amount: plan.priceCents, price_currency: 'usd' };
  return {
    name: `DispatchDesk ${plan.name}`.slice(0, 64),
    ...(plan.description ? { description: plan.description } : {}),
    recurring_interval: interval,
    recurring_interval_count: 1,
    prices: [price],
    metadata: { dispatchdesk_plan: plan.key },
  };
}

const items = (list) => (Array.isArray(list) ? list : list?.items || []);

/**
 * Admin → Setup → "Set up Polar": check the access token, create a recurring product for every paid plan that has none
 * yet (keeping the ones already linked), and create the webhook endpoint, saving its signing secret.
 * Safe to run again: it keeps what exists.
 */
export async function provisionPolar(userId) {
  if (!config.appUrl.startsWith('https://')) throw badRequest('APP_URL must be a public https address before Polar can send webhooks to it');
  const c = await polarConfig();
  if (!c.accessToken) throw badRequest('Save the Polar access token in System settings → Billing first');
  try {
    await polarApi('GET', '/products/?limit=1');
  } catch (err) {
    throw badRequest(`Polar rejected the access token (${c.environment}): ${err.message}`);
  }
  const report = { environment: c.environment, plans: [], webhook: null };
  const products = { ...c.products };

  const plans = await prisma.plan.findMany({ where: { active: true, key: { not: 'free' } }, orderBy: { sortOrder: 'asc' } });
  for (const plan of plans) {
    if (products[plan.key]) {
      // A product from the other environment (sandbox → production) does not exist in this organization: make a new one.
      const exists = await polarApi('GET', `/products/${encodeURIComponent(products[plan.key])}`).then((p) => !!p?.id && !p.is_archived, (err) => {
        if (err.status === 404) return false;
        throw err;
      });
      if (exists) { report.plans.push({ plan: plan.key, action: 'kept', productId: products[plan.key] }); continue; }
      delete products[plan.key];
    }
    if (!plan.priceCents) { report.plans.push({ plan: plan.key, action: 'skipped', reason: 'price is 0' }); continue; }
    if (plan.basePriceCents) { report.plans.push({ plan: plan.key, action: 'skipped', reason: 'plans with a base fee are not sold through Polar yet' }); continue; }
    const product = await polarApi('POST', '/products/', productBody(plan));
    products[plan.key] = product.id;
    report.plans.push({ plan: plan.key, action: 'created', productId: product.id, perSeat: plan.perSeat });
  }
  await setSetting('polar.products', JSON.stringify(products), userId);

  const url = polarWebhookUrl();
  let existing = null;
  try {
    existing = items(await polarApi('GET', '/webhooks/endpoints?limit=100')).find((e) => e.url === url) || null;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (existing) {
    const have = new Set(existing.events || []);
    const missing = POLAR_EVENTS.filter((e) => !have.has(e));
    if (missing.length) await polarApi('PATCH', `/webhooks/endpoints/${encodeURIComponent(existing.id)}`, { events: [...have, ...missing] });
    let secret = c.webhookSecret;
    if (!secret) {
      // The secret is shown only when it is made: rotate it so this server knows it.
      const rotated = await polarApi('PATCH', `/webhooks/endpoints/${encodeURIComponent(existing.id)}/secret`);
      secret = rotated?.secret || '';
      if (secret) await setSetting('polar.webhookSecret', secret, userId);
    }
    report.webhook = { action: missing.length ? 'reused, events added' : 'reused', id: existing.id, url, secretSaved: !!secret };
  } else {
    const created = await polarApi('POST', '/webhooks/endpoints', { url, format: 'raw', events: POLAR_EVENTS, api_version: POLAR_API_VERSION, name: 'DispatchDesk billing' });
    if (created?.secret) await setSetting('polar.webhookSecret', created.secret, userId);
    report.webhook = { action: 'created', id: created?.id, url, secretSaved: !!created?.secret };
  }
  invalidatePlans();
  const s = await getSettings(['billing.provider']);
  report.providerActive = s['billing.provider'] === 'polar';
  return report;
}
