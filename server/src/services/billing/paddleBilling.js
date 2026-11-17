import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { badRequest, notFound, unavailable } from '../../lib/errors.js';
import { notify } from '../../lib/activity.js';
import { audit } from '../../lib/audit.js';
import { invalidatePlans } from '../../lib/plans.js';
import { withLock } from '../../lib/locks.js';
import { randomToken } from '../../lib/crypto.js';
import { paddleApi, paddleConfig, verifyPaddleSignature, paddleStatus, paddleCents } from '../paddle.js';

/**
 * Subscriptions sold through Paddle. Paddle IDs are kept in the subscription's provider-ID columns
 * (stripeSubscriptionId = Paddle sub_…, stripeCustomerId = ctm_…; Payment.stripeInvoiceId = txn_…) with
 * provider = 'paddle', so every "pays online" check in the app works the same for both providers.
 * As with Stripe, subscription state comes only from signed webhooks (or Paddle API responses), never from the browser.
 */
const d = (v) => (v ? new Date(v) : null);
const LIVE = ['active', 'trialing', 'past_due'];

/** What the browser needs to open Paddle's checkout for `plan` (Paddle.js overlay). */
export async function paddleCheckout(user, plan, { seats = 1, teamId = null } = {}) {
  const c = await paddleConfig();
  if (!c.apiKey || !c.clientToken) throw unavailable('Paddle is not set up yet. An administrator must add the Paddle keys in System settings → Billing.');
  if (!plan.paddlePriceId) throw unavailable(`The ${plan.name} plan is not linked to a Paddle price yet. An administrator must run "Set up Paddle" in Admin → Setup.`);
  const now = Date.now();
  // Abandoned checkouts are removed after two days.
  await prisma.subscription.deleteMany({ where: { userId: user.id, provider: 'paddle', status: 'incomplete', stripeSubscriptionId: null, createdAt: { lt: new Date(now - 2 * 86_400_000) } } });
  // The same checkout opened again within 15 minutes (a second tab, a retry) reuses its row and token, so paying twice
  // is caught as a duplicate (syncPaddleSubscription) instead of creating two plans.
  const recent = await prisma.subscription.findFirst({
    where: { userId: user.id, provider: 'paddle', status: 'incomplete', stripeSubscriptionId: null, planId: plan.id, seats, stripeCheckoutId: { not: null }, createdAt: { gte: new Date(now - 15 * 60_000) } },
    orderBy: { createdAt: 'desc' },
  });
  // The token is made here and kept on the row: a webhook attaches a subscription to this row only when its
  // custom_data carries the same token (custom_data comes from the browser and could be edited).
  const local = recent || await prisma.subscription.create({
    data: { userId: user.id, teamId, planId: plan.id, status: 'incomplete', seats, provider: 'paddle', stripeCheckoutId: `ddck_${randomToken(16)}` },
  });
  return {
    provider: 'paddle',
    localSubscriptionId: local.id,
    checkout: {
      environment: c.environment,
      clientToken: c.clientToken,
      items: [{ priceId: plan.paddlePriceId, quantity: seats }],
      customer: { email: user.email },
      customData: { userId: user.id, planKey: plan.key, teamId: teamId || '', localSubscriptionId: local.id, checkoutToken: local.stripeCheckoutId },
      successUrl: `${config.appUrl}/app/billing?checkout=success`,
    },
  };
}

/**
 * Mirror a Paddle subscription (from a signed webhook or the Paddle API) into the local row. The row is found by the
 * Paddle ID, else the pending checkout row named in custom_data, only when the checkout token matches the one this
 * server made. A subscription with no matching checkout is not attached to anyone. A second subscription paid from the
 * same checkout is canceled at once (duplicate). An ended subscription is never revived by an older event.
 */
export async function syncPaddleSubscription(remote) {
  const item = remote.items?.[0];
  const priceId = item?.price?.id || item?.price_id || null;
  const plan = priceId ? await prisma.plan.findFirst({ where: { paddlePriceId: priceId } }) : null;
  const cd = remote.custom_data || {};
  let local = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: remote.id } });
  if (!local && cd.localSubscriptionId && cd.checkoutToken) {
    const pending = await prisma.subscription.findUnique({ where: { id: String(cd.localSubscriptionId) } });
    if (pending && pending.provider === 'paddle' && pending.stripeCheckoutId === String(cd.checkoutToken)) {
      if (!pending.stripeSubscriptionId) local = pending;
      else if (paddleStatus(remote.status) !== 'canceled') return cancelDuplicate(remote, pending);
    }
  }
  const status = paddleStatus(remote.status);
  if (local?.stripeSubscriptionId === remote.id && local.status === 'canceled' && status !== 'canceled') {
    console.warn(`[billing] ignored "${remote.status}" for ended Paddle subscription ${remote.id} (out-of-order event)`);
    return { row: local, before: local.status };
  }
  const period = remote.current_billing_period || {};
  const data = {
    provider: 'paddle',
    stripeSubscriptionId: remote.id,
    stripeCustomerId: remote.customer_id || null,
    status,
    seats: item?.quantity || 1,
    currentPeriodStart: d(period.starts_at),
    currentPeriodEnd: d(period.ends_at),
    trialEndsAt: status === 'trialing' ? d(item?.trial_dates?.ends_at || period.ends_at) : null,
    cancelAtPeriodEnd: remote.scheduled_change?.action === 'cancel',
    canceledAt: d(remote.canceled_at),
    ...(plan ? { planId: plan.id } : {}),
  };
  if (local) {
    const row = await prisma.subscription.update({ where: { id: local.id }, data });
    invalidatePlans();
    return { row, before: local.status };
  }
  console.warn('[billing] Paddle subscription with no matching checkout (not attached to any account)', remote.id);
  return { row: null, before: null };
}

/**
 * The same checkout was paid twice (two tabs): the second subscription is canceled at once in Paddle, and the buyer
 * is told so they can ask for a refund of the duplicate charge.
 */
async function cancelDuplicate(remote, original) {
  console.warn(`[billing] duplicate Paddle subscription ${remote.id} for checkout ${original.id}: canceling it`);
  try {
    await paddleApi('POST', `/subscriptions/${encodeURIComponent(remote.id)}/cancel`, { effective_from: 'immediately' });
  } catch (err) {
    console.error(`[billing] could not cancel duplicate Paddle subscription ${remote.id}: ${err.message}`);
  }
  await notify(original.userId, {
    type: 'billing', title: 'Duplicate subscription canceled',
    body: 'The same checkout was paid twice, so the second subscription was canceled. Contact support to get the duplicate charge refunded.',
    link: '/app/billing',
  });
  await audit(null, 'billing.duplicate_canceled', { entityType: 'subscription', entityId: original.id, details: { paddleSubscriptionId: remote.id } });
  return { row: null, before: null };
}

/** Record a Paddle transaction as a payment; notifies only when its status changes (paid / failed). */
export async function recordPaddleTransaction(txn, status) {
  return withLock(`paddle-txn.${txn.id}`, 60_000, async () => {
    const local = txn.subscription_id ? await prisma.subscription.findUnique({ where: { stripeSubscriptionId: txn.subscription_id } }) : null;
    // Never from custom_data (the browser could set it): only a recorded subscription or a known Paddle customer.
    const userId = local?.userId
      ?? (txn.customer_id ? (await prisma.subscription.findFirst({ where: { stripeCustomerId: txn.customer_id, provider: 'paddle' } }))?.userId : null)
      ?? null;
    if (!userId) {
      // The payment can arrive before subscription.created: fail so Paddle delivers it again a little later.
      if (txn.subscription_id) throw new Error(`Paddle subscription ${txn.subscription_id} is not recorded yet`);
      console.warn('[billing] Paddle transaction for an unknown customer', txn.id);
      return null;
    }
    const totals = txn.details?.totals || {};
    const line = txn.items?.[0];
    const data = {
      userId, subscriptionId: local?.id ?? null, provider: 'paddle',
      amountCents: paddleCents(totals.grand_total ?? totals.total),
      currency: String(txn.currency_code || 'USD').toLowerCase(),
      status,
      description: line?.price?.description || line?.price?.name || null,
      invoiceUrl: null, invoicePdf: null,
      periodStart: d(txn.billing_period?.starts_at), periodEnd: d(txn.billing_period?.ends_at),
      paidAt: status === 'paid' ? d(txn.billed_at) || new Date() : null,
    };
    const previous = await prisma.payment.findUnique({ where: { stripeInvoiceId: txn.id }, select: { status: true } });
    if (previous?.status === 'paid' && status !== 'paid') return null;
    const payment = await prisma.payment.upsert({ where: { stripeInvoiceId: txn.id }, create: { ...data, stripeInvoiceId: txn.id }, update: data });
    if (previous?.status !== status) {
      if (status === 'paid') await notify(userId, { type: 'billing', title: 'Payment received', body: `Paid: ${(data.amountCents / 100).toFixed(2)} ${data.currency.toUpperCase()}`, link: '/app/billing' });
      else await notify(userId, { type: 'billing', title: 'Payment failed', body: 'Update your payment method under Billing → Payment methods & invoices to keep your plan.', link: '/app/billing' });
    }
    return payment;
  });
}

/**
 * subscription.* events: one at a time per subscription, older events skipped (Paddle can deliver out of order and
 * retries failures). When the API key is set, the current subscription is fetched and applied instead of the payload.
 */
async function applySubscriptionEvent(evt) {
  const obj = evt.data;
  return withLock(`paddle-sub.${obj.id}`, 60_000, async () => {
    const key = `billing.subEvent.${obj.id}`;
    const marker = await prisma.systemSetting.findUnique({ where: { key } });
    const last = Number(marker?.value) || 0;
    const at = Date.parse(evt.occurred_at) || 0;
    if (at && last && at < last) return { row: null, before: null, skipped: 'stale' };
    let remote = obj;
    if (evt.event_type !== 'subscription.canceled' && (await paddleConfig()).apiKey) {
      try {
        const fresh = await paddleApi('GET', `/subscriptions/${encodeURIComponent(obj.id)}`);
        remote = { ...fresh, custom_data: fresh.custom_data ?? obj.custom_data };
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    const out = await syncPaddleSubscription(remote);
    if (at > last) await prisma.systemSetting.upsert({ where: { key }, create: { key, value: String(at), secret: false }, update: { value: String(at) } });
    return out;
  });
}

export async function handlePaddleEvent(evt) {
  switch (evt.event_type) {
    case 'subscription.created':
    case 'subscription.updated':
    case 'subscription.activated':
    case 'subscription.trialing':
    case 'subscription.past_due':
    case 'subscription.paused':
    case 'subscription.resumed':
    case 'subscription.canceled': {
      const { row, before } = await applySubscriptionEvent(evt);
      if (!row || before === row.status) break;
      if (LIVE.includes(row.status) && !LIVE.includes(before || '')) {
        await notify(row.userId, { type: 'billing', title: 'Subscription active', body: 'Thank you. Your plan is active.', link: '/app/billing' });
      } else if (['canceled', 'paused'].includes(row.status)) {
        await notify(row.userId, { type: 'billing', title: 'Subscription ended', body: 'Your paid plan has ended. Choose a plan under Billing to keep working.', link: '/app/billing' });
      }
      break;
    }
    case 'transaction.completed':
      await recordPaddleTransaction(evt.data, 'paid');
      break;
    case 'transaction.payment_failed':
      await recordPaddleTransaction(evt.data, 'failed');
      break;
    default:
      break;
  }
}

const PENDING = 'pending:';
const STALE_CLAIM_MS = 10 * 60_000;
/** Each Paddle event is processed once (shared table with Stripe events, ids prefixed "paddle:"). */
async function claimEvent(id, type, retry = true) {
  try {
    await prisma.stripeEvent.create({ data: { id, type: `${PENDING}${type}` } });
    return 'claimed';
  } catch (err) {
    if (err?.code !== 'P2002') throw err;
  }
  const row = await prisma.stripeEvent.findUnique({ where: { id } });
  if (!row) return retry ? claimEvent(id, type, false) : 'busy';
  if (!row.type.startsWith(PENDING)) return 'done';
  if (Date.now() - row.processedAt.getTime() < STALE_CLAIM_MS) return 'busy';
  const took = await prisma.stripeEvent.updateMany({ where: { id, processedAt: row.processedAt }, data: { processedAt: new Date() } });
  return took.count ? 'claimed' : 'busy';
}

/** POST /api/billing/paddle/webhook (raw body). */
export async function paddleWebhookHandler(req, res) {
  try {
    const { webhookSecret } = await paddleConfig();
    if (!webhookSecret) return res.status(503).json({ error: 'Paddle webhook secret is not configured' });
    if (!verifyPaddleSignature(req.body, req.get('paddle-signature'), webhookSecret)) {
      return res.status(400).json({ error: 'Webhook signature verification failed' });
    }
    let evt;
    try { evt = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body)); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    if (!evt?.event_id || !evt?.event_type || !evt?.data) return res.status(400).json({ error: 'Not a Paddle event' });
    const id = `paddle:${evt.event_id}`;
    const claim = await claimEvent(id, evt.event_type);
    if (claim === 'done') return res.json({ received: true, duplicate: true });
    if (claim === 'busy') return res.status(409).json({ error: 'This event is being processed', retry: true });
    try {
      await handlePaddleEvent(evt);
    } catch (err) {
      await prisma.stripeEvent.delete({ where: { id } }).catch(() => {});
      throw err;
    }
    await prisma.stripeEvent.update({ where: { id }, data: { type: evt.event_type } });
    await audit(null, 'billing.webhook', { entityType: 'paddle_event', entityId: evt.event_id, details: { type: evt.event_type } });
    res.json({ received: true });
  } catch (err) {
    console.error('[billing] Paddle webhook processing failed', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

// ---------------------------------------------------------------------------
// Managing a Paddle subscription from the Billing page
// ---------------------------------------------------------------------------
async function apply(sub, remote) {
  const { row } = await syncPaddleSubscription({ ...remote, custom_data: remote.custom_data ?? { userId: sub.userId } });
  return row;
}

export async function paddleCancel(sub) {
  return apply(sub, await paddleApi('POST', `/subscriptions/${encodeURIComponent(sub.stripeSubscriptionId)}/cancel`, { effective_from: 'next_billing_period' }));
}

export async function paddleResume(sub) {
  return apply(sub, await paddleApi('PATCH', `/subscriptions/${encodeURIComponent(sub.stripeSubscriptionId)}`, { scheduled_change: null }));
}

export async function paddleChangePlan(sub, plan, quantity) {
  if (!plan.paddlePriceId) throw unavailable(`The ${plan.name} plan is not linked to a Paddle price yet.`);
  return apply(sub, await paddleApi('PATCH', `/subscriptions/${encodeURIComponent(sub.stripeSubscriptionId)}`, {
    items: [{ price_id: plan.paddlePriceId, quantity }], proration_billing_mode: 'prorated_immediately',
  }));
}

/** Paddle's customer portal (payment methods, invoices, cancel) for the user's Paddle customer. */
export async function paddlePortalUrl(user) {
  const sub = await prisma.subscription.findFirst({ where: { userId: user.id, provider: 'paddle', stripeCustomerId: { not: null } }, orderBy: { createdAt: 'desc' } });
  if (!sub) throw notFound('No billing account yet — start a subscription first');
  const live = LIVE.includes(sub.status) && sub.stripeSubscriptionId ? [sub.stripeSubscriptionId] : [];
  const session = await paddleApi('POST', `/customers/${encodeURIComponent(sub.stripeCustomerId)}/portal-sessions`, live.length ? { subscription_ids: live } : {});
  return session?.urls?.general?.overview || null;
}

/** A temporary link to the PDF invoice of a Paddle transaction. */
export async function paddleInvoiceUrl(transactionId) {
  const out = await paddleApi('GET', `/transactions/${encodeURIComponent(transactionId)}/invoice`);
  if (!out?.url) throw badRequest('Paddle has no invoice for this payment yet');
  return out.url;
}
