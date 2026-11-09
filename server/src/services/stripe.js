import Stripe from 'stripe';
import { getSetting } from '../lib/settings.js';
import { unavailable } from '../lib/errors.js';

let cached = { key: null, client: null };

/** Stripe client built from the admin/env configured secret key, or null when not configured. */
export async function getStripe() {
  const key = await getSetting('stripe.secretKey');
  if (!key) return null;
  if (cached.key !== key) cached = { key, client: new Stripe(key, { maxNetworkRetries: 1, timeout: 20000 }) };
  return cached.client;
}

export async function requireStripe() {
  const s = await getStripe();
  if (!s) throw unavailable('Payments are not configured yet. An administrator must add a Stripe secret key (Admin → Settings → Billing).');
  return s;
}

export async function stripeMode() {
  const key = await getSetting('stripe.secretKey');
  if (!key) return 'unconfigured';
  return key.startsWith('sk_live') || key.startsWith('rk_live') ? 'live' : 'test';
}

/** For tests: inject a fake client. */
export function __setStripeClient(key, client) {
  cached = { key, client };
}
