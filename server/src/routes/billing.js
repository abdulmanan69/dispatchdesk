import { Router } from 'express';
import Stripe from 'stripe';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { ah, badRequest, conflict, forbidden, notFound, unavailable } from '../lib/errors.js';
import { parse, z, reqStr } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { notify } from '../lib/activity.js';
import { getSetting } from '../lib/settings.js';
import { effectivePlan, usage } from '../lib/plans.js';
import { requireAuth } from '../middleware/auth.js';
import { getStripe, requireStripe, stripeMode } from '../services/stripe.js';

const r = Router();
// Signature verification is a local HMAC check and needs no real API key.
const verifier = new Stripe('sk_test_signature_verification_only');

export function planFeatures(p) {
  const n = (v, unit) => (v < 0 ? `Unlimited ${unit}` : `${v.toLocaleString('en-US')} ${unit}`);
  const f = [
    n(p.maxCarriers, 'carrier records'),
    `${n(p.maxDiscoveryPerDay, 'FMCSA leads saved')} / day`,
    `Lead generator: ${n(p.monthlyLeadGenLimit, 'leads')} / month, ${n(p.maxLeadGenerators, p.maxLeadGenerators === 1 ? 'profile' : 'profiles')}${p.leadGenAutoRun ? ', scheduled runs' : ''}`,
    `${n(p.dailyEmailLimit, 'emails')} / day`,
    `${n(p.monthlyAiMessages, 'AI messages')} / month`,
    n(p.maxSequences, p.maxSequences === 1 ? 'sequence' : 'sequences'),
    p.maxAutomations === 0 ? 'No automations' : n(p.maxAutomations, 'automations'),
    'CRM, pipeline, prospecting & follow-ups',
  ];
  if (p.advancedReports) f.push('Advanced reporting');
  if (p.trainingIncluded) f.push('Dispatch training entitlement');
  if (p.teamFeatures) f.push('Team board, leaderboard & permissions');
  return f;
}

const publicPlan = (p) => ({
  id: p.id, key: p.key, name: p.name, description: p.description, priceCents: p.priceCents, interval: p.interval,
  perSeat: p.perSeat, minSeats: p.minSeats, trialDays: p.trialDays, purchasable: p.key !== 'free' && !!p.stripePriceId,
  limits: {
    maxCarriers: p.maxCarriers, dailyEmailLimit: p.dailyEmailLimit, monthlyAiMessages: p.monthlyAiMessages, maxSequences: p.maxSequences,
    maxAutomations: p.maxAutomations, maxDiscoveryPerDay: p.maxDiscoveryPerDay,
    monthlyLeadGenLimit: p.monthlyLeadGenLimit, maxLeadGenerators: p.maxLeadGenerators,
  },
  leadGenAutoRun: p.leadGenAutoRun,
  advancedReports: p.advancedReports, trainingIncluded: p.trainingIncluded, teamFeatures: p.teamFeatures,
  features: planFeatures(p),
});

r.get('/plans', ah(async (req, res) => {
  const plans = await prisma.plan.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
  res.json({ plans: plans.map(publicPlan), paymentsEnabled: (await stripeMode()) !== 'unconfigured' });
}));

r.use(requireAuth);

r.get('/me', ah(async (req, res) => {
  const [{ plan, subscription }, u, payments, pending, mode] = await Promise.all([
    effectivePlan(req.user),
    usage(req.user),
    prisma.payment.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.subscription.findFirst({ where: { userId: req.user.id, status: { in: ['incomplete', 'past_due', 'unpaid'] } }, include: { plan: true }, orderBy: { createdAt: 'desc' } }),
    stripeMode(),
  ]);
  const teamOwned = subscription?.teamId && subscription.userId !== req.user.id;
  res.json({
    plan: publicPlan(plan),
    subscription: subscription && {
      id: subscription.id, status: subscription.status, seats: subscription.seats, planKey: subscription.plan.key,
      currentPeriodEnd: subscription.currentPeriodEnd, trialEndsAt: subscription.trialEndsAt, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      managedByTeam: !!teamOwned, isOwner: subscription.userId === req.user.id, hasPortal: !!subscription.stripeCustomerId,
    },
    pendingSubscription: pending && { id: pending.id, status: pending.status, planKey: pending.plan.key, createdAt: pending.createdAt },
    usage: u,
    payments: payments.map((p) => ({ id: p.id, amountCents: p.amountCents, currency: p.currency, status: p.status, description: p.description, invoiceUrl: p.invoiceUrl, invoicePdf: p.invoicePdf, periodStart: p.periodStart, periodEnd: p.periodEnd, paidAt: p.paidAt, createdAt: p.createdAt })),
    stripeMode: mode,
  });
}));

async function customerIdFor(user) {
  const prev = await prisma.subscription.findFirst({ where: { userId: user.id, stripeCustomerId: { not: null } }, orderBy: { createdAt: 'desc' } });
  return prev?.stripeCustomerId || null;
}

r.post('/checkout', ah(async (req, res) => {
  const body = parse(z.object({ planKey: reqStr(40), seats: z.coerce.number().int().min(1).max(500).optional() }), req.body);
  const plan = await prisma.plan.findUnique({ where: { key: body.planKey } });
  if (!plan || !plan.active) throw notFound('Plan not found');
  if (plan.key === 'free') throw badRequest('The Free plan does not need checkout');
  const { subscription: current } = await effectivePlan(req.user);
  if (current) throw conflict('You already have an active subscription. Use "Change plan" or manage it in the billing portal.');
  if (!plan.stripePriceId) throw unavailable(`The ${plan.name} plan is not linked to a Stripe price yet. An administrator must set its Stripe price ID (Admin → Plans).`);
  const stripe = await requireStripe();

  let teamId = null;
  let seats = 1;
  if (plan.perSeat) {
    const m = req.user.teamMembership;
    if (!m || m.role !== 'owner') throw forbidden('Create a team (Team page) and be its owner to buy a Teams plan');
    teamId = m.teamId;
    const members = await prisma.teamMember.count({ where: { teamId } });
    seats = Math.max(plan.minSeats, members, body.seats || 0);
  }

  const local = await prisma.subscription.create({ data: { userId: req.user.id, teamId, planId: plan.id, status: 'incomplete', seats } });
  const customer = await customerIdFor(req.user);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: plan.stripePriceId, quantity: seats }],
      ...(customer ? { customer } : { customer_email: req.user.email }),
      client_reference_id: req.user.id,
      metadata: { userId: req.user.id, planKey: plan.key, teamId: teamId || '', localSubscriptionId: local.id },
      subscription_data: {
        metadata: { userId: req.user.id, planKey: plan.key, teamId: teamId || '', localSubscriptionId: local.id },
        ...(plan.trialDays ? { trial_period_days: plan.trialDays } : {}),
      },
      allow_promotion_codes: true,
      success_url: `${config.appUrl}/app/billing?checkout=success`,
      cancel_url: `${config.appUrl}/app/billing?checkout=canceled`,
    });
    await prisma.subscription.update({ where: { id: local.id }, data: { stripeCheckoutId: session.id } });
    await audit(req, 'billing.checkout_started', { entityType: 'subscription', entityId: local.id, details: { plan: plan.key, seats } });
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    await prisma.subscription.delete({ where: { id: local.id } }).catch(() => {});
    if (err?.status) throw err;
    throw unavailable(`Stripe rejected the checkout request: ${err.message}`);
  }
}));

async function ownedLiveSubscription(user) {
  const sub = await prisma.subscription.findFirst({
    where: { userId: user.id, status: { in: ['active', 'trialing', 'past_due'] }, stripeSubscriptionId: { not: null } },
    include: { plan: true }, orderBy: { createdAt: 'desc' },
  });
  if (!sub) throw notFound('You have no subscription you manage. Team subscriptions are managed by the team owner.');
  return sub;
}

r.post('/portal', ah(async (req, res) => {
  const stripe = await requireStripe();
  const customer = await customerIdFor(req.user);
  if (!customer) throw notFound('No billing account yet — start a subscription first');
  const session = await stripe.billingPortal.sessions.create({ customer, return_url: `${config.appUrl}/app/billing` });
  res.json({ url: session.url });
}));

r.post('/cancel', ah(async (req, res) => {
  const stripe = await requireStripe();
  const sub = await ownedLiveSubscription(req.user);
  const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
  await syncSubscription(updated);
  await audit(req, 'billing.cancel_requested', { entityType: 'subscription', entityId: sub.id });
  res.json({ ok: true, cancelAtPeriodEnd: !!updated.cancel_at_period_end, message: 'Your subscription will end at the close of the current billing period.' });
}));

r.post('/resume', ah(async (req, res) => {
  const stripe = await requireStripe();
  const sub = await ownedLiveSubscription(req.user);
  const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: false });
  await syncSubscription(updated);
  await audit(req, 'billing.resumed', { entityType: 'subscription', entityId: sub.id });
  res.json({ ok: true, cancelAtPeriodEnd: !!updated.cancel_at_period_end });
}));

r.post('/change-plan', ah(async (req, res) => {
  const { planKey, seats } = parse(z.object({ planKey: reqStr(40), seats: z.coerce.number().int().min(1).max(500).optional() }), req.body);
  const stripe = await requireStripe();
  const sub = await ownedLiveSubscription(req.user);
  const plan = await prisma.plan.findUnique({ where: { key: planKey } });
  if (!plan || !plan.active || plan.key === 'free') throw badRequest('Choose a paid plan. To move to Free, cancel your subscription.');
  if (!plan.stripePriceId) throw unavailable(`The ${plan.name} plan is not linked to a Stripe price yet.`);
  if (plan.perSeat !== sub.plan.perSeat) throw badRequest('Switching between individual and team plans requires canceling and starting a new subscription.');
  if (plan.id === sub.planId && !seats) throw badRequest('You are already on this plan');
  const remote = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
  const item = remote.items.data[0];
  let quantity = item.quantity || 1;
  if (plan.perSeat && seats) {
    const members = await prisma.teamMember.count({ where: { teamId: sub.teamId } });
    if (seats < Math.max(plan.minSeats, members)) throw badRequest(`Seats must be at least ${Math.max(plan.minSeats, members)} (current members / plan minimum)`);
    quantity = seats;
  }
  const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
    items: [{ id: item.id, price: plan.stripePriceId, quantity }],
    proration_behavior: 'create_prorations',
    metadata: { ...remote.metadata, planKey: plan.key },
  });
  await syncSubscription(updated);
  await audit(req, 'billing.plan_changed', { entityType: 'subscription', entityId: sub.id, details: { from: sub.plan.key, to: plan.key, quantity } });
  res.json({ ok: true, status: updated.status });
}));

// ---------------------------------------------------------------------------
// Webhooks — the ONLY place subscription/payment state is created from Stripe events.
// ---------------------------------------------------------------------------
const ts = (s) => (s ? new Date(s * 1000) : null);

/** Mirror a Stripe subscription object (verified: from a signed webhook or a Stripe API response) into our DB. */
export async function syncSubscription(remote) {
  const item = remote.items?.data?.[0];
  const priceId = item?.price?.id;
  const plan = priceId ? await prisma.plan.findFirst({ where: { stripePriceId: priceId } }) : null;
  let local = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: remote.id } });
  if (!local && remote.metadata?.localSubscriptionId) local = await prisma.subscription.findUnique({ where: { id: remote.metadata.localSubscriptionId } });
  const data = {
    stripeSubscriptionId: remote.id,
    stripeCustomerId: typeof remote.customer === 'string' ? remote.customer : remote.customer?.id,
    status: remote.status,
    seats: item?.quantity || 1,
    currentPeriodStart: ts(remote.current_period_start ?? item?.current_period_start),
    currentPeriodEnd: ts(remote.current_period_end ?? item?.current_period_end),
    trialEndsAt: ts(remote.trial_end),
    cancelAtPeriodEnd: !!remote.cancel_at_period_end,
    canceledAt: ts(remote.canceled_at),
    ...(plan ? { planId: plan.id } : {}),
  };
  if (local) return prisma.subscription.update({ where: { id: local.id }, data });
  const userId = remote.metadata?.userId;
  if (!userId || !plan || !(await prisma.user.findUnique({ where: { id: userId } }))) {
    console.warn('[billing] subscription event for unknown user/plan', remote.id);
    return null;
  }
  return prisma.subscription.create({ data: { ...data, userId, teamId: remote.metadata?.teamId || null, planId: plan.id } });
}

function invoiceSubscriptionId(inv) {
  return inv.subscription?.id ?? inv.subscription ?? inv.parent?.subscription_details?.subscription ?? null;
}

async function recordInvoice(inv, status) {
  const subId = invoiceSubscriptionId(inv);
  const local = subId ? await prisma.subscription.findUnique({ where: { stripeSubscriptionId: subId } }) : null;
  const userId = local?.userId
    ?? (await prisma.subscription.findFirst({ where: { stripeCustomerId: typeof inv.customer === 'string' ? inv.customer : inv.customer?.id } }))?.userId;
  if (!userId) { console.warn('[billing] invoice for unknown customer', inv.id); return null; }
  const line = inv.lines?.data?.[0];
  const data = {
    userId, subscriptionId: local?.id ?? null,
    amountCents: status === 'paid' ? inv.amount_paid ?? inv.total ?? 0 : inv.amount_due ?? inv.total ?? 0,
    currency: inv.currency || 'usd', status,
    description: line?.description || inv.description || null,
    invoiceUrl: inv.hosted_invoice_url || null, invoicePdf: inv.invoice_pdf || null,
    periodStart: ts(line?.period?.start ?? inv.period_start), periodEnd: ts(line?.period?.end ?? inv.period_end),
    paidAt: status === 'paid' ? ts(inv.status_transitions?.paid_at) || new Date() : null,
  };
  const payment = await prisma.payment.upsert({ where: { stripeInvoiceId: inv.id }, create: { ...data, stripeInvoiceId: inv.id }, update: data });
  if (status === 'paid') await notify(userId, { type: 'billing', title: 'Payment received', body: `Invoice paid: ${(data.amountCents / 100).toFixed(2)} ${data.currency.toUpperCase()}`, link: '/app/billing' });
  else await notify(userId, { type: 'billing', title: 'Payment failed', body: 'Update your payment method in the billing portal to keep your plan.', link: '/app/billing' });
  return payment;
}

export async function handleStripeEvent(event, stripe) {
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed': {
      const local = await prisma.subscription.findFirst({ where: { OR: [{ stripeCheckoutId: obj.id }, ...(obj.metadata?.localSubscriptionId ? [{ id: obj.metadata.localSubscriptionId }] : [])] } });
      const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id;
      const customer = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      if (local) {
        const clash = subId ? await prisma.subscription.findUnique({ where: { stripeSubscriptionId: subId } }) : null;
        if (clash && clash.id !== local.id) {
          // customer.subscription.created already arrived and created the row: merge into it.
          await prisma.subscription.update({ where: { id: clash.id }, data: { stripeCheckoutId: obj.id, stripeCustomerId: customer } });
          await prisma.subscription.delete({ where: { id: local.id } }).catch(() => {});
        } else {
          await prisma.subscription.update({ where: { id: local.id }, data: { stripeSubscriptionId: subId ?? null, stripeCustomerId: customer ?? null } });
        }
      }
      // Status comes from Stripe's own subscription object, never from the redirect.
      if (subId && stripe) await syncSubscription(await stripe.subscriptions.retrieve(subId));
      const userId = local?.userId || obj.client_reference_id;
      if (userId) await notify(userId, { type: 'billing', title: 'Checkout completed', body: 'Your subscription is being activated.', link: '/app/billing' });
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const row = await syncSubscription(obj);
      if (row && event.type === 'customer.subscription.deleted') {
        await notify(row.userId, { type: 'billing', title: 'Subscription ended', body: 'Your account is now on the Free plan.', link: '/app/billing' });
      }
      break;
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      await recordInvoice(obj, 'paid');
      break;
    case 'invoice.payment_failed':
      await recordInvoice(obj, 'failed');
      break;
    default:
      break; // ignored event types are acknowledged
  }
}

export async function webhookHandler(req, res) {
  try {
    const secret = await getSetting('stripe.webhookSecret');
    if (!secret) return res.status(503).json({ error: 'Stripe webhook secret is not configured' });
    const signature = req.get('stripe-signature');
    if (!signature) return res.status(400).json({ error: 'Missing Stripe-Signature header' });
    const stripe = await getStripe();
    let event;
    try {
      event = verifier.webhooks.constructEvent(req.body, signature, secret);
    } catch (err) {
      return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
    }
    const seen = await prisma.stripeEvent.findUnique({ where: { id: event.id } });
    if (seen) return res.json({ received: true, duplicate: true });
    await handleStripeEvent(event, stripe);
    await prisma.stripeEvent.create({ data: { id: event.id, type: event.type } });
    await audit(null, 'billing.webhook', { entityType: 'stripe_event', entityId: event.id, details: { type: event.type } });
    res.json({ received: true });
  } catch (err) {
    console.error('[billing] webhook processing failed', err);
    // 500 makes Stripe retry later.
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

export default r;
