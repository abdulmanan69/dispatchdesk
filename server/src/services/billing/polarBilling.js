import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { notFound, unavailable } from '../../lib/errors.js';
import { notify } from '../../lib/activity.js';
import { audit } from '../../lib/audit.js';
import { invalidatePlans } from '../../lib/plans.js';
import { withLock } from '../../lib/locks.js';
import { randomToken } from '../../lib/crypto.js';
import { polarApi, polarConfig, polarStatus, verifyPolarSignature } from '../polar.js';

/**
 * Subscriptions sold through Polar. Polar IDs are kept in the subscription's provider-ID columns
 * (stripeSubscriptionId = Polar subscription id, stripeCustomerId = Polar customer id; Payment.stripeInvoiceId = order
 * id) with provider = 'polar', so every "pays online" check in the app works the same for every provider.
 * The checkout session is made on the server, and the plan changes only from signed webhooks or Polar API responses.
 */
const d = (v) => (v ? new Date(v) : null);
const LIVE = ['active', 'trialing', 'past_due'];
const str = (v) => (v == null ? '' : String(v));

/** The plan whose Polar product is `productId` (from the saved { planKey: productId } map). */
async function planForProduct(productId) {
  if (!productId) return null;
  const { products } = await polarConfig();
  const key = Object.keys(products).find((k) => products[k] === productId);
  return key ? prisma.plan.findUnique({ where: { key } }) : null;
}

/** A Polar checkout session for `plan`; the browser is sent to its URL. */
export async function polarCheckout(user, plan, { seats = 1, teamId = null } = {}) {
  const c = await polarConfig();
  if (!c.accessToken) throw unavailable('Polar is not set up yet. An administrator must add the Polar access token in System settings → Billing.');
  const productId = c.products[plan.key];
  if (!productId) throw unavailable(`The ${plan.name} plan is not linked to a Polar product yet. An administrator must run "Set up Polar" in Admin → Setup.`);
  const now = Date.now();
  // Abandoned checkouts are removed after two days.
  await prisma.subscription.deleteMany({ where: { userId: user.id, provider: 'polar', status: 'incomplete', stripeSubscriptionId: null, createdAt: { lt: new Date(now - 2 * 86_400_000) } } });
  // The same checkout opened again within 15 minutes reuses its row and token, so paying twice is caught as a duplicate.
  const recent = await prisma.subscription.findFirst({
    where: { userId: user.id, provider: 'polar', status: 'incomplete', stripeSubscriptionId: null, planId: plan.id, seats, stripeCheckoutId: { not: null }, createdAt: { gte: new Date(now - 15 * 60_000) } },
    orderBy: { createdAt: 'desc' },
  });
  const local = recent || await prisma.subscription.create({
    data: { userId: user.id, teamId, planId: plan.id, status: 'incomplete', seats, provider: 'polar', stripeCheckoutId: `ddck_${randomToken(16)}` },
  });
  const session = await polarApi('POST', '/checkouts/', {
    products: [productId],
    success_url: `${config.appUrl}/app/billing?checkout=success`,
    return_url: `${config.appUrl}/app/billing`,
    customer_email: user.email,
    ...(user.name ? { customer_name: String(user.name).slice(0, 100) } : {}),
    external_customer_id: user.id,
    ...(plan.perSeat ? { seats, min_seats: Math.max(1, plan.minSeats || 1) } : {}),
    metadata: { userId: user.id, planKey: plan.key, teamId: str(teamId), localSubscriptionId: local.id, checkoutToken: local.stripeCheckoutId },
  });
  if (!session?.url) throw unavailable('Polar did not return a checkout link. Try again in a moment.');
  return { provider: 'polar', localSubscriptionId: local.id, url: session.url };
}

/**
 * Mirror a Polar subscription (from a signed webhook or the Polar API) into the local row. The row is found by the
 * Polar ID, else the pending checkout row named in the metadata, only when the checkout token matches the one this
 * server made. A second subscription paid from the same checkout is revoked at once (duplicate). An ended
 * subscription is never revived by an older event.
 */
export async function syncPolarSubscription(remote) {
  const plan = await planForProduct(remote.product_id || remote.product?.id);
  const md = remote.metadata || {};
  let local = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: remote.id } });
  if (!local && md.localSubscriptionId && md.checkoutToken) {
    const pending = await prisma.subscription.findUnique({ where: { id: String(md.localSubscriptionId) } });
    if (pending && pending.provider === 'polar' && pending.stripeCheckoutId === String(md.checkoutToken)) {
      if (!pending.stripeSubscriptionId) local = pending;
      else if (polarStatus(remote.status) !== 'canceled') return revokeDuplicate(remote, pending);
    }
  }
  const status = remote.ended_at && remote.status === 'canceled' ? 'canceled' : polarStatus(remote.status);
  if (local?.stripeSubscriptionId === remote.id && local.status === 'canceled' && status !== 'canceled') {
    console.warn(`[billing] ignored "${remote.status}" for ended Polar subscription ${remote.id} (out-of-order event)`);
    return { row: local, before: local.status };
  }
  const data = {
    provider: 'polar',
    stripeSubscriptionId: remote.id,
    stripeCustomerId: remote.customer_id || remote.customer?.id || null,
    status,
    seats: Number(remote.seats) > 0 ? Number(remote.seats) : 1,
    currentPeriodStart: d(remote.current_period_start),
    currentPeriodEnd: d(remote.current_period_end),
    trialEndsAt: status === 'trialing' ? d(remote.trial_end) : null,
    cancelAtPeriodEnd: !!remote.cancel_at_period_end,
    canceledAt: d(remote.canceled_at),
    ...(plan ? { planId: plan.id } : {}),
  };
  if (local) {
    const row = await prisma.subscription.update({ where: { id: local.id }, data });
    invalidatePlans();
    return { row, before: local.status };
  }
  console.warn('[billing] Polar subscription with no matching checkout (not attached to any account)', remote.id);
  return { row: null, before: null };
}

/** The same checkout was paid twice: the second subscription is revoked in Polar and the buyer is told. */
async function revokeDuplicate(remote, original) {
  console.warn(`[billing] duplicate Polar subscription ${remote.id} for checkout ${original.id}: revoking it`);
  try {
    await polarApi('DELETE', `/subscriptions/${encodeURIComponent(remote.id)}`);
  } catch (err) {
    console.error(`[billing] could not revoke duplicate Polar subscription ${remote.id}: ${err.message}`);
  }
  await notify(original.userId, {
    type: 'billing', title: 'Duplicate subscription canceled',
    body: 'The same checkout was paid twice, so the second subscription was canceled. Contact support to get the duplicate charge refunded.',
    link: '/app/billing',
  });
  await audit(null, 'billing.duplicate_canceled', { entityType: 'subscription', entityId: original.id, details: { polarSubscriptionId: remote.id } });
  return { row: null, before: null };
}

/** Record a Polar order as a payment ('paid' or 'refunded'); notifies when a payment arrives. */
export async function recordPolarOrder(order, status) {
  return withLock(`polar-order.${order.id}`, 60_000, async () => {
    const subId = order.subscription_id || order.subscription?.id || null;
    const local = subId ? await prisma.subscription.findUnique({ where: { stripeSubscriptionId: subId } }) : null;
    // Never from metadata alone: only a recorded subscription or a known Polar customer.
    const userId = local?.userId
      ?? (order.customer_id ? (await prisma.subscription.findFirst({ where: { stripeCustomerId: order.customer_id, provider: 'polar' } }))?.userId : null)
      ?? null;
    if (!userId) {
      // The order can arrive before subscription.created: fail so Polar delivers it again a little later.
      if (subId) throw new Error(`Polar subscription ${subId} is not recorded yet`);
      console.warn('[billing] Polar order for an unknown customer', order.id);
      return null;
    }
    const data = {
      userId, subscriptionId: local?.id ?? null, provider: 'polar',
      amountCents: Number.parseInt(order.total_amount ?? order.net_amount ?? 0, 10) || 0,
      currency: String(order.currency || 'usd').toLowerCase(),
      status,
      description: order.product?.name || order.description || null,
      invoiceUrl: null, invoicePdf: null,
      periodStart: d(order.subscription?.current_period_start), periodEnd: d(order.subscription?.current_period_end),
      paidAt: status === 'paid' ? d(order.created_at) || new Date() : null,
    };
    const previous = await prisma.payment.findUnique({ where: { stripeInvoiceId: order.id }, select: { status: true, paidAt: true } });
    if (previous?.status === 'refunded') return null;
    if (status === 'refunded' && previous) data.paidAt = previous.paidAt;
    const payment = await prisma.payment.upsert({ where: { stripeInvoiceId: order.id }, create: { ...data, stripeInvoiceId: order.id }, update: data });
    if (status === 'paid' && previous?.status !== 'paid') {
      await notify(userId, { type: 'billing', title: 'Payment received', body: `Paid: ${(data.amountCents / 100).toFixed(2)} ${data.currency.toUpperCase()}`, link: '/app/billing' });
    }
    return payment;
  });
}

/**
 * subscription.* events: one at a time per subscription, older events skipped (deliveries can arrive out of order and
 * failures are retried). The current subscription is fetched from Polar and applied instead of the payload.
 */
async function applySubscriptionEvent(evt) {
  const obj = evt.data;
  return withLock(`polar-sub.${obj.id}`, 60_000, async () => {
    const key = `billing.subEvent.${obj.id}`;
    const marker = await prisma.systemSetting.findUnique({ where: { key } });
    const last = Number(marker?.value) || 0;
    const at = Date.parse(evt.timestamp) || 0;
    if (at && last && at < last) return { row: null, before: null, skipped: 'stale' };
    let remote = obj;
    if (evt.type !== 'subscription.revoked') {
      try {
        const fresh = await polarApi('GET', `/subscriptions/${encodeURIComponent(obj.id)}`);
        if (fresh?.id) remote = { ...fresh, metadata: fresh.metadata ?? obj.metadata };
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    const out = await syncPolarSubscription(remote);
    if (at > last) await prisma.systemSetting.upsert({ where: { key }, create: { key, value: String(at), secret: false }, update: { value: String(at) } });
    return out;
  });
}

export async function handlePolarEvent(evt) {
  if (String(evt.type).startsWith('subscription.')) {
    const { row, before } = await applySubscriptionEvent(evt);
    if (!row || before === row.status) return;
    if (LIVE.includes(row.status) && !LIVE.includes(before || '')) {
      await notify(row.userId, { type: 'billing', title: 'Subscription active', body: 'Thank you. Your plan is active.', link: '/app/billing' });
    } else if (['canceled', 'paused'].includes(row.status)) {
      await notify(row.userId, { type: 'billing', title: 'Subscription ended', body: 'Your paid plan has ended. Choose a plan under Billing to keep working.', link: '/app/billing' });
    }
    return;
  }
  if (evt.type === 'order.paid') await recordPolarOrder(evt.data, 'paid');
  else if (evt.type === 'order.refunded') await recordPolarOrder(evt.data, 'refunded');
}

const PENDING = 'pending:';
const STALE_CLAIM_MS = 10 * 60_000;
/** Each Polar delivery is processed once (shared table with the other providers, ids prefixed "polar:"). */
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

/** POST /api/billing/polar/webhook (raw body). */
export async function polarWebhookHandler(req, res) {
  try {
    const { webhookSecret } = await polarConfig();
    if (!webhookSecret) return res.status(503).json({ error: 'Polar webhook secret is not configured' });
    const headers = { id: req.get('webhook-id'), timestamp: req.get('webhook-timestamp'), signature: req.get('webhook-signature') };
    if (!verifyPolarSignature(req.body, headers, webhookSecret)) return res.status(403).json({ error: 'Webhook signature verification failed' });
    let evt;
    try { evt = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body)); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    if (!evt?.type || !evt?.data) return res.status(400).json({ error: 'Not a Polar event' });
    const id = `polar:${headers.id}`;
    const claim = await claimEvent(id, evt.type);
    if (claim === 'done') return res.json({ received: true, duplicate: true });
    if (claim === 'busy') return res.status(409).json({ error: 'This event is being processed', retry: true });
    try {
      await handlePolarEvent(evt);
    } catch (err) {
      await prisma.stripeEvent.delete({ where: { id } }).catch(() => {});
      throw err;
    }
    await prisma.stripeEvent.update({ where: { id }, data: { type: evt.type } });
    await audit(null, 'billing.webhook', { entityType: 'polar_event', entityId: headers.id, details: { type: evt.type } });
    res.json({ received: true });
  } catch (err) {
    console.error('[billing] Polar webhook processing failed', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

// ---------------------------------------------------------------------------
// Managing a Polar subscription from the Billing page
// ---------------------------------------------------------------------------
async function apply(sub, remote) {
  const { row } = await syncPolarSubscription({ ...remote, metadata: remote?.metadata ?? {} });
  return row;
}

const subPath = (sub) => `/subscriptions/${encodeURIComponent(sub.stripeSubscriptionId)}`;

/** The reason the customer gave stays in our audit log (POST /api/billing/cancel); Polar only gets the cancellation. */
export async function polarCancel(sub) {
  return apply(sub, await polarApi('PATCH', subPath(sub), { cancel_at_period_end: true }));
}

export async function polarResume(sub) {
  return apply(sub, await polarApi('PATCH', subPath(sub), { cancel_at_period_end: false }));
}

export async function polarChangePlan(sub, plan, quantity) {
  const { products } = await polarConfig();
  const productId = products[plan.key];
  if (!productId) throw unavailable(`The ${plan.name} plan is not linked to a Polar product yet.`);
  let remote = await polarApi('PATCH', subPath(sub), { product_id: productId, proration_behavior: 'prorate' });
  if (plan.perSeat && quantity && Number(remote?.seats) !== quantity) {
    remote = await polarApi('PATCH', subPath(sub), { seats: quantity, proration_behavior: 'prorate' });
  }
  return apply(sub, remote);
}

/** Polar's customer portal (payment method, invoices, cancel) for the user's Polar customer. */
export async function polarPortalUrl(user) {
  const sub = await prisma.subscription.findFirst({ where: { userId: user.id, provider: 'polar', stripeCustomerId: { not: null } }, orderBy: { createdAt: 'desc' } });
  if (!sub) throw notFound('No billing account yet — start a subscription first');
  const session = await polarApi('POST', '/customer-sessions/', { customer_id: sub.stripeCustomerId, return_url: `${config.appUrl}/app/billing` });
  return session?.customer_portal_url || null;
}
