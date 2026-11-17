import crypto from 'node:crypto';
import { getSettings } from '../lib/settings.js';
import { unavailable } from '../lib/errors.js';

/**
 * Paddle Billing (merchant of record): API client, settings and webhook signature check.
 * Paddle sells the subscription to the customer and pays the platform out (wire or Payoneer), so it works where
 * Stripe does not. Live and sandbox are separate Paddle accounts with separate keys (paddle.environment).
 */
const BASE = { live: 'https://api.paddle.com', sandbox: 'https://sandbox-api.paddle.com' };
export const PADDLE_EVENTS = [
  'subscription.created', 'subscription.updated', 'subscription.activated', 'subscription.trialing',
  'subscription.past_due', 'subscription.paused', 'subscription.resumed', 'subscription.canceled',
  'transaction.completed', 'transaction.payment_failed',
];

let fetchImpl = (...a) => globalThis.fetch(...a);
/** Tests replace the HTTP client. */
export function __setPaddleFetch(f) { fetchImpl = f || ((...a) => globalThis.fetch(...a)); }

export async function billingProvider() {
  const p = (await getSettings(['billing.provider']))['billing.provider'];
  return p === 'paddle' || p === 'polar' ? p : 'stripe';
}

export async function paddleConfig() {
  const s = await getSettings(['paddle.apiKey', 'paddle.clientToken', 'paddle.environment', 'paddle.webhookSecret']);
  return {
    apiKey: s['paddle.apiKey'] || '',
    clientToken: s['paddle.clientToken'] || '',
    environment: s['paddle.environment'] === 'sandbox' ? 'sandbox' : 'live',
    webhookSecret: s['paddle.webhookSecret'] || '',
  };
}

/** 'live' | 'sandbox' | 'unconfigured' (API key and client-side token both needed to sell). */
export async function paddleMode() {
  const c = await paddleConfig();
  return c.apiKey && c.clientToken ? c.environment : 'unconfigured';
}

/** Call the Paddle API. Returns `data`; throws with Paddle's own message on errors. */
export async function paddleApi(method, path, body) {
  const c = await paddleConfig();
  if (!c.apiKey) throw unavailable('Paddle is not set up: add the Paddle API key in Admin → System settings → Billing');
  const res = await fetchImpl(`${BASE[c.environment]}${path}`, {
    method,
    headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json', 'Paddle-Version': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json?.error?.detail || json?.error?.code || `HTTP ${res.status}`;
    throw Object.assign(new Error(`Paddle: ${detail}`), { status: res.status >= 500 ? 502 : res.status, paddle: json?.error || null, expose: true });
  }
  return json.data;
}

/**
 * Check a `Paddle-Signature` header ("ts=<unix>;h1=<hex>[;h1=<hex>]"): HMAC-SHA256 of `${ts}:${rawBody}` with the
 * notification destination's secret, compared in constant time. Events older than `toleranceSec` are refused
 * (replays); every event id is also processed once only (routes/billing.js).
 */
export function verifyPaddleSignature(rawBody, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!secret || !header) return false;
  const parts = String(header).split(';').map((p) => {
    const i = p.indexOf('=');
    return i > 0 ? [p.slice(0, i).trim(), p.slice(i + 1).trim()] : [p.trim(), ''];
  });
  const ts = Number(parts.find(([k]) => k === 'ts')?.[1]);
  const sigs = parts.filter(([k, v]) => k === 'h1' && v).map(([, v]) => v);
  if (!Number.isFinite(ts) || !sigs.length) return false;
  if (Math.abs(now / 1000 - ts) > toleranceSec) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex'));
  return sigs.some((s) => {
    const got = Buffer.from(s);
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

/** Paddle subscription status -> ours. Paused subscriptions do not bill, so the plan stops like a canceled one. */
export function paddleStatus(s) {
  return { active: 'active', trialing: 'trialing', past_due: 'past_due', paused: 'paused', canceled: 'canceled' }[s] || 'incomplete';
}

/** Amounts arrive as strings in the smallest unit ("2900" = $29.00). */
export const paddleCents = (v) => {
  const n = Number.parseInt(String(v ?? '0'), 10);
  return Number.isFinite(n) ? n : 0;
};
