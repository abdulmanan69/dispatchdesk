import { prisma } from '../../db.js';
import { invalidatePlans } from '../../lib/plans.js';

const MONTH_MS = 30.44 * 86_400_000;

/**
 * Give a user a plan without payment (admin grant, gift, or a plan code). Stored as a subscription with no Stripe IDs
 * that ends at `currentPeriodEnd` (null = no end). A user who pays through Stripe is left alone: returns
 * { skipped: 'paying' }. An existing granted plan is replaced; with `extend`, the later of the two end dates is kept
 * (a code or gift never shortens a plan the user already has).
 */
export async function grantPlan({ userId, plan, months = null, seats = 1, extend = false }) {
  const paying = await prisma.subscription.findFirst({
    where: { userId, status: { in: ['active', 'trialing', 'past_due'] }, stripeSubscriptionId: { not: null } }, select: { id: true },
  });
  if (paying) return { skipped: 'paying' };
  let end = months ? new Date(Date.now() + months * MONTH_MS) : null;
  const existing = await prisma.subscription.findFirst({ where: { userId, stripeSubscriptionId: null, status: { in: ['active', 'trialing'] } } });
  if (extend && existing && existing.planId === plan.id && end) {
    if (!existing.currentPeriodEnd) end = null; // already without an end date
    else if (existing.currentPeriodEnd > end) end = existing.currentPeriodEnd;
  }
  const n = Math.max(seats || 1, plan.perSeat ? plan.minSeats : 1);
  const data = { planId: plan.id, status: 'active', seats: n, currentPeriodEnd: end, cancelAtPeriodEnd: !!end };
  const subscription = existing
    ? await prisma.subscription.update({ where: { id: existing.id }, data })
    : await prisma.subscription.create({ data: { ...data, userId } });
  invalidatePlans();
  return { subscription, created: !existing };
}

/** "Pro for 3 months" / "Pro with no end date". */
export const planPhrase = (plan, months) => `${plan.name} ${months ? `for ${months} month${months === 1 ? '' : 's'}` : 'with no end date'}`;
