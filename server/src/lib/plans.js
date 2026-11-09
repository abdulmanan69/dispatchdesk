import { prisma } from '../db.js';
import { paymentRequired } from './errors.js';

const LIVE = ['active', 'trialing'];

const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const startOfMonth = () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; };

/** Active subscription for the user directly, or through their team. Status comes only from verified Stripe events. */
export async function activeSubscription(user) {
  const teamId = user.teamMembership?.teamId;
  return prisma.subscription.findFirst({
    where: {
      status: { in: LIVE },
      AND: [
        { OR: [{ userId: user.id, teamId: null }, ...(teamId ? [{ teamId }] : [])] },
        // Plans granted by an admin (no Stripe subscription) stop at their end date; Stripe plans follow webhooks.
        { OR: [{ stripeSubscriptionId: { not: null } }, { currentPeriodEnd: null }, { currentPeriodEnd: { gt: new Date() } }] },
      ],
    },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function effectivePlan(user) {
  const sub = await activeSubscription(user);
  if (sub) return { plan: sub.plan, subscription: sub };
  const free = await prisma.plan.findUnique({ where: { key: 'free' } });
  return { plan: free, subscription: null };
}

export async function usage(user) {
  const [carriers, emailsToday, aiMonth, sequences, automations, discoveryToday, leadGen, leadGenerators] = await Promise.all([
    prisma.carrier.count({ where: { ownerId: user.id } }),
    prisma.email.count({ where: { userId: user.id, status: { in: ['sent', 'sending'] }, sentAt: { gte: startOfDay() } } }),
    prisma.aIMessage.count({ where: { role: 'user', conversation: { userId: user.id }, createdAt: { gte: startOfMonth() } } }),
    prisma.emailSequence.count({ where: { ownerId: user.id } }),
    prisma.automation.count({ where: { ownerId: user.id } }),
    prisma.carrier.count({ where: { ownerId: user.id, source: { in: ['fmcsa_census', 'fmcsa_qc'] }, createdAt: { gte: startOfDay() } } }),
    prisma.leadGenRun.aggregate({ where: { ownerId: user.id, createdAt: { gte: startOfMonth() } }, _sum: { created: true } }),
    prisma.leadGenerator.count({ where: { ownerId: user.id } }),
  ]);
  return { carriers, emailsToday, aiMonth, sequences, automations, discoveryToday, leadGenMonth: leadGen._sum.created || 0, leadGenerators };
}

const LIMITS = {
  carriers: ['maxCarriers', 'carriers', 'carrier records'],
  emailsToday: ['dailyEmailLimit', 'emailsToday', 'emails per day'],
  aiMonth: ['monthlyAiMessages', 'aiMonth', 'AI messages this month'],
  sequences: ['maxSequences', 'sequences', 'sequences'],
  automations: ['maxAutomations', 'automations', 'automations'],
  discoveryToday: ['maxDiscoveryPerDay', 'discoveryToday', 'discovered leads saved per day'],
  leadGenMonth: ['monthlyLeadGenLimit', 'leadGenMonth', 'generated leads per month'],
  leadGenerators: ['maxLeadGenerators', 'leadGenerators', 'lead generators'],
};

/** Throw 402 when adding `adding` units would exceed the plan limit. A limit of -1 means unlimited. */
export async function assertLimit(user, kind, adding = 1) {
  const [field, usageKey, label] = LIMITS[kind];
  const { plan } = await effectivePlan(user);
  const limit = plan?.[field] ?? 0;
  if (limit < 0) return;
  const u = await usage(user);
  if (u[usageKey] + adding > limit) {
    throw paymentRequired(`Your ${plan?.name || 'current'} plan allows ${limit} ${label}. Upgrade for higher limits.`, { kind, limit, used: u[usageKey] });
  }
}

export async function remaining(user, kind) {
  const [field, usageKey] = LIMITS[kind];
  const { plan } = await effectivePlan(user);
  const limit = plan?.[field] ?? 0;
  if (limit < 0) return Infinity;
  const u = await usage(user);
  return Math.max(0, limit - u[usageKey]);
}
