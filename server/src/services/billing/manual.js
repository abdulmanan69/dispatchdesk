import crypto from 'node:crypto';
import { prisma } from '../../db.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { getSettings } from '../../lib/settings.js';
import { notify } from '../../lib/activity.js';
import { invalidatePlans } from '../../lib/plans.js';

/**
 * Manual payments: plans paid outside the app (bank wire, USDT, Taptap Send). The customer starts a payment and gets
 * a reference, pays with it, then reports the transaction ID ("I've paid"). An admin checks the money arrived and
 * approves it, which activates the plan for the paid period (a provider "manual" subscription with an end date, like
 * a gift) and records a payment. Nothing activates without an admin's approval.
 */
const MONTH_MS = 30.44 * 86_400_000;
export const MANUAL_METHODS = [
  { key: 'bank', label: 'Bank wire (SWIFT)', setting: 'manual.bank' },
  { key: 'usdt', label: 'USDT (crypto)', setting: 'manual.usdt' },
  { key: 'taptapsend', label: 'Taptap Send', setting: 'manual.taptapsend' },
];
const LIVE = ['active', 'trialing', 'past_due'];

/** The payment methods the admin filled in, with their details, and the extra note. */
export async function manualMethods() {
  const s = await getSettings([...MANUAL_METHODS.map((m) => m.setting), 'manual.note']);
  return {
    methods: MANUAL_METHODS.filter((m) => String(s[m.setting] || '').trim()).map((m) => ({ key: m.key, label: m.label, details: String(s[m.setting]).trim() })),
    note: String(s['manual.note'] || '').trim() || null,
  };
}

/** 'live' when at least one payment method has details, else 'unconfigured'. */
export async function manualMode() {
  return (await manualMethods()).methods.length ? 'live' : 'unconfigured';
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
function newReference() {
  const bytes = crypto.randomBytes(6);
  return `DD-${[...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('')}`;
}

export const shapeClaim = (c) => c && ({
  id: c.id, reference: c.reference, status: c.status, planKey: c.plan?.key, planName: c.plan?.name, seats: c.seats, months: c.months,
  amountCents: c.amountCents, currency: c.currency, method: c.method, transactionRef: c.transactionRef, note: c.note,
  submittedAt: c.submittedAt, reviewedAt: c.reviewedAt, rejectReason: c.rejectReason, createdAt: c.createdAt,
});

/** Start (or reuse) a manual payment for `plan`: the amount, the period it buys and the reference to pay with. */
export async function startManualPayment(user, plan, { seats = 1, teamId = null } = {}) {
  if (!(await manualMethods()).methods.length) throw badRequest('Manual payment is not set up yet. An administrator must add the payment details in System settings → Billing.');
  const n = plan.perSeat ? Math.max(seats, plan.minSeats || 1) : 1;
  const amountCents = plan.priceCents * n;
  const months = plan.interval === 'year' ? 12 : 1;
  // The same plan started again within a week (a second tab, back later) keeps its reference.
  const recent = await prisma.manualPayment.findFirst({
    where: { userId: user.id, planId: plan.id, seats: n, status: 'awaiting', createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
    include: { plan: true }, orderBy: { createdAt: 'desc' },
  });
  if (recent) return recent;
  for (let i = 0; i < 5; i += 1) {
    try {
      return await prisma.manualPayment.create({
        data: { userId: user.id, teamId, planId: plan.id, seats: n, months, amountCents, reference: newReference() },
        include: { plan: true },
      });
    } catch (err) {
      if (err?.code !== 'P2002') throw err; // reference already taken: draw another
    }
  }
  throw new Error('Could not make a payment reference');
}

/** Admins who handle billing (in-app notification when a payment is reported). */
async function billingAdmins() {
  return prisma.user.findMany({
    where: { status: 'active', role: { permissions: { some: { permission: { key: 'admin.billing' } } } } },
    select: { id: true },
  });
}

/** The customer reports the payment ("I've paid") with the method and the transaction ID. */
export async function submitManualPayment(user, id, { method, transactionRef, note }) {
  const claim = await prisma.manualPayment.findFirst({ where: { id, userId: user.id }, include: { plan: true } });
  if (!claim) throw notFound('Payment not found');
  if (!['awaiting', 'submitted'].includes(claim.status)) throw conflict('This payment was already reviewed');
  const { methods } = await manualMethods();
  if (!methods.some((m) => m.key === method)) throw badRequest('Choose how you paid');
  const row = await prisma.manualPayment.update({
    where: { id: claim.id },
    data: { method, transactionRef, note: note || null, status: 'submitted', submittedAt: new Date() },
    include: { plan: true },
  });
  const who = user.name || user.email;
  for (const a of await billingAdmins()) {
    await notify(a.id, {
      type: 'billing', title: 'Payment to check',
      body: `${who} reports paying ${(row.amountCents / 100).toFixed(2)} ${row.currency.toUpperCase()} for ${row.plan.name} (${row.reference}).`,
      link: '/app/admin?tab=payments',
    });
  }
  return row;
}

export async function cancelManualPayment(user, id) {
  const claim = await prisma.manualPayment.findFirst({ where: { id, userId: user.id } });
  if (!claim) throw notFound('Payment not found');
  if (!['awaiting', 'submitted'].includes(claim.status)) throw conflict('This payment was already reviewed');
  return prisma.manualPayment.update({ where: { id: claim.id }, data: { status: 'canceled' } });
}

/**
 * An admin confirms the money arrived: the plan runs for the paid period (renewing the same plan early adds the period
 * to the current end date) and the payment is recorded. Refused while the user pays online (Stripe, Paddle or Polar).
 */
export async function approveManualPayment(adminId, id) {
  const claim = await prisma.manualPayment.findUnique({ where: { id }, include: { plan: true, user: { select: { id: true, name: true, email: true } } } });
  if (!claim) throw notFound('Payment not found');
  if (!['awaiting', 'submitted'].includes(claim.status)) throw conflict(`This payment is already ${claim.status}`);
  const online = await prisma.subscription.findFirst({ where: { userId: claim.userId, status: { in: LIVE }, stripeSubscriptionId: { not: null } }, select: { id: true } });
  if (online) throw conflict('This user already pays online. Cancel that subscription first, or reject this payment.');
  const now = new Date();
  const existing = await prisma.subscription.findFirst({
    where: { userId: claim.userId, stripeSubscriptionId: null, status: { in: ['active', 'trialing'] }, OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: now } }] },
    orderBy: { createdAt: 'desc' },
  });
  if (existing && existing.planId === claim.planId && !existing.currentPeriodEnd) throw conflict('This user already has this plan with no end date');
  const base = existing && existing.planId === claim.planId && existing.currentPeriodEnd > now ? existing.currentPeriodEnd : now;
  const end = new Date(base.getTime() + claim.months * MONTH_MS);
  const subData = {
    provider: 'manual', planId: claim.planId, status: 'active', seats: claim.seats, teamId: claim.teamId,
    currentPeriodStart: existing && base > now ? existing.currentPeriodStart || now : now, currentPeriodEnd: end, cancelAtPeriodEnd: true, canceledAt: null,
  };
  const out = await prisma.$transaction(async (tx) => {
    const taken = await tx.manualPayment.updateMany({ where: { id: claim.id, status: { in: ['awaiting', 'submitted'] } }, data: { status: 'approved', reviewedAt: now, reviewedById: adminId } });
    if (!taken.count) throw conflict('This payment was just reviewed by someone else');
    const sub = existing
      ? await tx.subscription.update({ where: { id: existing.id }, data: subData })
      : await tx.subscription.create({ data: { ...subData, userId: claim.userId } });
    const period = claim.months === 12 ? '1 year' : claim.months === 1 ? '1 month' : `${claim.months} months`;
    const method = MANUAL_METHODS.find((m) => m.key === claim.method)?.label || 'Manual payment';
    const payment = await tx.payment.create({
      data: {
        userId: claim.userId, subscriptionId: sub.id, provider: 'manual', stripeInvoiceId: `manual:${claim.id}`,
        amountCents: claim.amountCents, currency: claim.currency, status: 'paid',
        description: `${claim.plan.name}, ${period}${claim.seats > 1 ? `, ${claim.seats} seats` : ''} (${method}, ${claim.reference})`,
        periodStart: base, periodEnd: end, paidAt: now,
      },
    });
    await tx.manualPayment.update({ where: { id: claim.id }, data: { paymentId: payment.id } });
    return { sub, payment };
  });
  invalidatePlans();
  await notify(claim.userId, {
    type: 'billing', title: 'Payment confirmed',
    body: `Thank you. Your ${claim.plan.name} plan is active until ${end.toISOString().slice(0, 10)}.`,
    link: '/app/billing',
  });
  return { claim: { ...claim, status: 'approved' }, subscription: out.sub, payment: out.payment, endsAt: end };
}

export async function rejectManualPayment(adminId, id, reason) {
  const claim = await prisma.manualPayment.findUnique({ where: { id }, include: { plan: true } });
  if (!claim) throw notFound('Payment not found');
  if (!['awaiting', 'submitted'].includes(claim.status)) throw conflict(`This payment is already ${claim.status}`);
  const row = await prisma.manualPayment.update({ where: { id }, data: { status: 'rejected', reviewedAt: new Date(), reviewedById: adminId, rejectReason: reason }, include: { plan: true } });
  await notify(claim.userId, {
    type: 'billing', title: 'Payment not confirmed',
    body: `We could not confirm your payment ${claim.reference} for ${claim.plan.name}: ${reason}`,
    link: '/app/billing',
  });
  return row;
}

/**
 * Daily: manual plans ending within 3 days get one reminder per period to pay again (they do not renew by themselves).
 */
export async function runManualRenewalReminders(now = new Date()) {
  const soon = new Date(now.getTime() + 3 * 86_400_000);
  const subs = await prisma.subscription.findMany({
    where: { provider: 'manual', status: 'active', currentPeriodEnd: { gt: now, lte: soon } },
    include: { plan: true }, take: 2000,
  });
  let sent = 0;
  for (const s of subs) {
    const key = `billing.manualReminder.${s.id}`;
    const end = s.currentPeriodEnd.toISOString();
    const done = await prisma.systemSetting.findUnique({ where: { key } });
    if (done?.value === end) continue;
    await notify(s.userId, {
      type: 'billing', title: `Your ${s.plan.name} plan ends ${end.slice(0, 10)}`,
      body: 'Pay for the next period under Billing to keep working without a break.',
      link: '/app/billing',
    });
    await prisma.systemSetting.upsert({ where: { key }, create: { key, value: end, secret: false }, update: { value: end } });
    sent += 1;
  }
  return { checked: subs.length, sent };
}
