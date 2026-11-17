import crypto from 'node:crypto';
import { getSettings } from '../lib/settings.js';
import { unavailable } from '../lib/errors.js';

/**
 * Polar (merchant of record): API client, settings and webhook signature check. Polar sells the subscription to the
 * customer and pays the platform out through Stripe Connect Express, which reaches countries Stripe Payments does not
 * serve (Pakistan included). Production and sandbox are separate Polar organizations with separate access tokens.
 * Every call pins the API version (Polar versions its API by date; omitting it means "current", which moves quarterly).
 */
const BASE = { production: 'https://api.polar.sh/v1', sandbox: 'https://sandbox-api.polar.sh/v1' };
export const POLAR_API_VERSION = '2026-10';
export const POLAR_EVENTS = [
  'subscription.created', 'subscription.updated', 'subscription.active', 'subscription.canceled', 'subscription.uncanceled',
  'subscription.revoked', 'subscription.past_due', 'order.paid', 'order.refunded',
];

let fetchImpl = (...a) => globalThis.fetch(...a);
/** Tests replace the HTTP client. */
export function __setPolarFetch(f) { fetchImpl = f || ((...a) => globalThis.fetch(...a)); }

/** { planKey: productId } saved by "Set up Polar". */
export function parseProducts(raw) {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

export async function polarConfig() {
  const s = await getSettings(['polar.accessToken', 'polar.environment', 'polar.webhookSecret', 'polar.products']);
  return {
    accessToken: s['polar.accessToken'] || '',
    environment: s['polar.environment'] === 'sandbox' ? 'sandbox' : 'production',
    webhookSecret: s['polar.webhookSecret'] || '',
    products: parseProducts(s['polar.products']),
  };
}

/** 'live' | 'sandbox' | 'unconfigured' (the access token is enough to sell; products come from "Set up Polar"). */
export async function polarMode() {
  const c = await polarConfig();
  if (!c.accessToken) return 'unconfigured';
  return c.environment === 'sandbox' ? 'sandbox' : 'live';
}

/** Call the Polar API. Returns the JSON body (null for 204); throws with Polar's own message on errors. */
export async function polarApi(method, path, body) {
  const c = await polarConfig();
  if (!c.accessToken) throw unavailable('Polar is not set up: add the Polar access token in Admin → System settings → Billing');
  const res = await fetchImpl(`${BASE[c.environment]}${path}`, {
    method,
    headers: { Authorization: `Bearer ${c.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Polar-Version': POLAR_API_VERSION },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof json?.detail === 'string' ? json.detail
      : Array.isArray(json?.detail) ? json.detail.map((x) => x?.msg).filter(Boolean).join('; ')
        : json?.error || `HTTP ${res.status}`;
    throw Object.assign(new Error(`Polar: ${detail || `HTTP ${res.status}`}`), { status: res.status >= 500 ? 502 : res.status, polar: json || null, expose: true });
  }
  return json;
}

/**
 * Check a Polar webhook (Standard Webhooks): headers webhook-id, webhook-timestamp and webhook-signature
 * ("v1,<base64> [v1,<base64>…]"), HMAC-SHA256 of `${id}.${timestamp}.${rawBody}`, at most `toleranceSec` old.
 * Secrets made since 2026-09-08 are "whsec_" + base64 key; older ones are used as their UTF-8 bytes. Both are tried,
 * as Polar's own SDK does. Every event id is also processed once only (polarBilling.js).
 */
export function verifyPolarSignature(rawBody, { id, timestamp, signature } = {}, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceSec) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const signed = `${id}.${Math.floor(ts)}.${body}`;
  const keys = [Buffer.from(secret, 'utf8')];
  if (secret.startsWith('whsec_')) {
    const k = Buffer.from(secret.slice(6), 'base64');
    if (k.length) keys.unshift(k);
  }
  const sigs = String(signature).split(' ').map((p) => p.trim()).filter((p) => p.startsWith('v1,')).map((p) => Buffer.from(p.slice(3)));
  return keys.some((key) => {
    const expected = Buffer.from(crypto.createHmac('sha256', key).update(signed).digest('base64'));
    return sigs.some((got) => got.length === expected.length && crypto.timingSafeEqual(got, expected));
  });
}

/** Polar subscription status -> ours. */
export function polarStatus(s) {
  return {
    active: 'active', trialing: 'trialing', past_due: 'past_due', unpaid: 'past_due', paused: 'paused',
    canceled: 'canceled', incomplete_expired: 'canceled', incomplete: 'incomplete',
  }[s] || 'incomplete';
}
