import { prisma } from '../../db.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { getStripe } from '../stripe.js';
import { billingProvider, paddleApi, paddleConfig } from '../paddle.js';
import { polarApi, polarConfig } from '../polar.js';
import { grantPlan, planPhrase } from './grant.js';

/**
 * Codes the admin hands out:
 * - discount: made with the active payment provider. Stripe: a coupon plus a promotion code with the same code
 *   (checkout sessions allow promotion codes). Paddle: a discount with that code, enabled for checkout. Customers
 *   type it on the checkout page; the provider counts and limits its redemptions.
 * - plan: redeemed in the app (Billing → "Have a code?") for a plan without payment, for `planMonths` months (null = no
 *   end), once per user, at most `maxRedemptions` times in all.
 */
export const COUPON_KINDS = ['discount', 'plan'];
export const DISCOUNT_DURATIONS = ['once', 'repeating', 'forever'];
export const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;
export const normCode = (c) => String(c || '').trim().toUpperCase().replace(/\s+/g, '');
const INVALID = 'That code is not valid or can no longer be used';

/** A Paddle discount for a discount code. Returns { provider, stripeCouponId: dsc_… }. */
async function createPaddleDiscount(c) {
  if (!(await paddleConfig()).apiKey) throw badRequest('Add the Paddle API key (Admin → System settings → Billing) before creating discount codes');
  try {
    const dsc = await paddleApi('POST', '/discounts', {
      description: c.description || c.code,
      type: c.percentOff ? 'percentage' : 'flat',
      amount: String(c.percentOff || c.amountOffCents),
      ...(c.percentOff ? {} : { currency_code: 'USD' }),
      enabled_for_checkout: true,
      code: c.code,
      recur: c.duration !== 'once',
      ...(c.duration === 'repeating' ? { maximum_recurring_intervals: c.durationMonths } : {}),
      ...(c.maxRedemptions ? { usage_limit: c.maxRedemptions } : {}),
      ...(c.expiresAt ? { expires_at: new Date(c.expiresAt).toISOString() } : {}),
      custom_data: { source: 'dispatchdesk' },
    });
    return { provider: 'paddle', stripeCouponId: dsc.id, stripePromotionCodeId: null };
  } catch (err) {
    throw badRequest(`Paddle refused the code: ${err.message.replace(/^Paddle: /, '')}`);
  }
}

/** A Polar discount for a discount code (Polar codes are letters and digits only). Returns { provider, stripeCouponId }. */
async function createPolarDiscount(c) {
  if (!(await polarConfig()).accessToken) throw badRequest('Add the Polar access token (Admin → System settings → Billing) before creating discount codes');
  if (!/^[A-Za-z0-9]{3,256}$/.test(c.code)) throw badRequest('Polar codes can use only letters and digits (3 or more)');
  try {
    const dsc = await polarApi('POST', '/discounts/', {
      name: (c.description || c.code).slice(0, 100),
      code: c.code,
      ...(c.percentOff ? { type: 'percentage', basis_points: Math.round(c.percentOff * 100) } : { type: 'fixed', amounts: { usd: c.amountOffCents } }),
      duration: c.duration,
      ...(c.duration === 'repeating' ? { duration_in_months: c.durationMonths } : {}),
      ...(c.maxRedemptions ? { max_redemptions: c.maxRedemptions } : {}),
      ...(c.expiresAt ? { ends_at: new Date(c.expiresAt).toISOString() } : {}),
      metadata: { source: 'dispatchdesk' },
    });
    return { provider: 'polar', stripeCouponId: dsc.id, stripePromotionCodeId: null };
  } catch (err) {
    throw badRequest(`Polar refused the code: ${err.message.replace(/^Polar: /, '')}`);
  }
}

/** Create the discount with the active payment provider (Stripe, Paddle or Polar). Returns the provider and its IDs. */
export async function createStripeDiscount(c) {
  const provider = await billingProvider();
  if (provider === 'paddle') return createPaddleDiscount(c);
  if (provider === 'polar') return createPolarDiscount(c);
  const stripe = await getStripe();
  if (!stripe) throw badRequest('Add the Stripe secret key (Admin → System settings → Billing) before creating discount codes');
  const coupon = await stripe.coupons.create({
    name: c.description || c.code,
    ...(c.percentOff ? { percent_off: c.percentOff } : { amount_off: c.amountOffCents, currency: 'usd' }),
    duration: c.duration,
    ...(c.duration === 'repeating' ? { duration_in_months: c.durationMonths } : {}),
    metadata: { source: 'dispatchdesk', code: c.code },
  });
  try {
    const promo = await stripe.promotionCodes.create({
      coupon: coupon.id,
      code: c.code,
      ...(c.maxRedemptions ? { max_redemptions: c.maxRedemptions } : {}),
      ...(c.expiresAt ? { expires_at: Math.floor(new Date(c.expiresAt).getTime() / 1000) } : {}),
      metadata: { source: 'dispatchdesk' },
    });
    return { provider: 'stripe', stripeCouponId: coupon.id, stripePromotionCodeId: promo.id };
  } catch (err) {
    await stripe.coupons.del(coupon.id).catch(() => {});
    throw badRequest(`Stripe refused the code: ${err.message}`);
  }
}

/** Turn a discount code on or off with its provider too. */
export async function setStripeDiscountActive(c, active) {
  if (c.provider === 'paddle') {
    if (c.stripeCouponId) await paddleApi('PATCH', `/discounts/${encodeURIComponent(c.stripeCouponId)}`, { status: active ? 'active' : 'archived' });
    return;
  }
  if (c.provider === 'polar') {
    // A switched-off Polar code ends now; switched on again, it has no end date (or its original expiry).
    if (c.stripeCouponId) await polarApi('PATCH', `/discounts/${encodeURIComponent(c.stripeCouponId)}`, { ends_at: active ? (c.expiresAt ? new Date(c.expiresAt).toISOString() : null) : new Date().toISOString() });
    return;
  }
  if (!c.stripePromotionCodeId) return;
  const stripe = await getStripe();
  if (stripe) await stripe.promotionCodes.update(c.stripePromotionCodeId, { active });
}

/** How often each discount code was used, from Stripe (best effort; null when Stripe is unreachable). */
export async function stripeRedemptions(coupons) {
  const stripe = await getStripe().catch(() => null);
  const out = new Map();
  const paddle = coupons.filter((c) => c.provider === 'paddle' && c.stripeCouponId);
  if (paddle.length && (await paddleConfig()).apiKey) {
    await Promise.all(paddle.map(async (c) => {
      try { out.set(c.id, (await paddleApi('GET', `/discounts/${encodeURIComponent(c.stripeCouponId)}`)).times_used ?? null); } catch { /* unknown */ }
    }));
  }
  if (!stripe) return out;
  await Promise.all(coupons.filter((c) => !['paddle', 'polar'].includes(c.provider) && c.stripePromotionCodeId).map(async (c) => {
    try {
      const p = await stripe.promotionCodes.retrieve(c.stripePromotionCodeId);
      out.set(c.id, p.times_redeemed ?? null);
    } catch { /* leave unknown */ }
  }));
  return out;
}

/** Why a plan code cannot be used right now, or null. */
export function planCodeProblem(c, now = new Date()) {
  if (!c || c.kind !== 'plan') return 'That code is not valid';
  if (!c.active) return 'That code is no longer active';
  if (c.expiresAt && c.expiresAt <= now) return 'That code has expired';
  if (c.maxRedemptions != null && c.redemptions >= c.maxRedemptions) return 'That code has been used up';
  return null;
}

/**
 * Redeem a plan code for `user`. Each user may use a code once; the redemption count is raised atomically so the
 * last remaining use cannot be taken twice. Returns { plan, months, subscription }.
 */
export async function redeemPlanCode(user, rawCode) {
  const code = normCode(rawCode);
  if (!CODE_RE.test(code)) throw badRequest('Enter the code as it was given to you');
  const c = await prisma.coupon.findUnique({ where: { code } });
  if (c?.kind === 'discount' && c.active) throw badRequest('That is a discount code: enter it on the checkout page when you upgrade');
  if (c && await prisma.couponRedemption.findUnique({ where: { couponId_userId: { couponId: c.id, userId: user.id } } })) {
    throw conflict('You have already used this code');
  }
  // One answer for every unusable code (unknown, off, expired, used up), so codes cannot be probed by their errors.
  if (planCodeProblem(c)) throw badRequest(INVALID);
  const plan = await prisma.plan.findUnique({ where: { key: c.planKey || '' } });
  if (!plan || plan.key === 'free') throw badRequest(INVALID);

  const taken = await prisma.coupon.updateMany({
    where: {
      id: c.id, active: true,
      OR: [{ maxRedemptions: null }, { redemptions: { lt: prisma.coupon.fields.maxRedemptions } }],
    },
    data: { redemptions: { increment: 1 } },
  });
  if (!taken.count) throw badRequest(INVALID);
  let result;
  let redeemed = false;
  const undo = async () => {
    if (redeemed) await prisma.couponRedemption.deleteMany({ where: { couponId: c.id, userId: user.id } }).catch(() => {});
    await prisma.coupon.update({ where: { id: c.id }, data: { redemptions: { decrement: 1 } } }).catch(() => {});
  };
  try {
    await prisma.couponRedemption.create({ data: { couponId: c.id, userId: user.id } });
    redeemed = true;
    result = await grantPlan({ userId: user.id, plan, months: c.planMonths, extend: true });
  } catch (err) {
    await undo();
    if (err?.code === 'P2002') throw conflict('You have already used this code');
    throw err;
  }
  if (result.skipped || result.kept) {
    await undo();
    throw conflict(result.skipped
      ? 'You already pay for a plan online. Codes for free months apply to accounts without a paid plan.'
      : 'You already have a plan that lasts longer than this code gives, so the code was not used.');
  }
  await prisma.couponRedemption.updateMany({ where: { couponId: c.id, userId: user.id }, data: { subscriptionId: result.subscription.id } });
  return { plan, months: c.planMonths, subscription: result.subscription, phrase: planPhrase(plan, c.planMonths) };
}

export async function findCoupon(id) {
  const c = await prisma.coupon.findUnique({ where: { id: String(id) } });
  if (!c) throw notFound('Code not found');
  return c;
}
