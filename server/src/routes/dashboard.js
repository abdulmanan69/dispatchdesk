import { Router } from 'express';
import { prisma } from '../db.js';
import { ah } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { readableOwnerIds, canViewTeam } from '../lib/access.js';
import { localParts } from '../lib/timezones.js';
import { requirePermission } from '../middleware/auth.js';

const r = Router();
r.use(requirePermission('crm.use'));

const DAY = 86400000;

/** Ordered list of local date keys (YYYY-MM-DD) for the last `days` days in tz. */
function dayKeys(tz, days, now = new Date()) {
  const keys = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = localParts(tz, new Date(now.getTime() - i * DAY)).date;
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

function bucket(dates, tz, keys) {
  const counts = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const d of dates) {
    if (!d) continue;
    const k = localParts(tz, d).date;
    if (k in counts) counts[k] += 1;
  }
  return counts;
}

/** End of the current local day in tz (approximate to the minute). */
function endOfLocalDay(tz, now = new Date()) {
  const p = localParts(tz, now);
  return new Date(now.getTime() + ((23 - p.hour) * 60 + (59 - p.minute)) * 60000 + 59999);
}

/** Start of the local day `days - 1` days ago. */
function rangeStart(tz, days, now = new Date()) {
  const p = localParts(tz, now);
  const startToday = new Date(now.getTime() - (p.hour * 60 + p.minute) * 60000);
  startToday.setSeconds(0, 0);
  return new Date(startToday.getTime() - (days - 1) * DAY);
}

r.get('/', ah(async (req, res) => {
  const q = parse(z.object({ range: z.enum(['7', '30', '90']).default('30'), scope: z.enum(['mine', 'team']).default('mine') }), req.query);
  const days = Number(q.range);
  const scope = q.scope === 'team' && canViewTeam(req.user) ? 'team' : 'mine';
  const ids = await readableOwnerIds(req.user, scope);
  const tz = req.user.timezone || 'America/Chicago';
  const now = new Date();
  const start = rangeStart(tz, days, now);
  const endToday = endOfLocalDay(tz, now);

  const owner = { ownerId: { in: ids } };
  const byUser = { userId: { in: ids } };

  const stages = await prisma.pipelineStage.findMany({ orderBy: { sortOrder: 'asc' } });
  const stageId = Object.fromEntries(stages.map((s) => [s.key, s.id]));

  const [
    totalCarriers, stageGroups, leadsInRange, activeOpps, pendingFollowUps, overdueFollowUps,
    callsInRange, emailsInRange, customersInRange, customersTotal, customersBefore, outcomeGroups,
    activities, dueEnrollmentsCount, dueEnrollments, upcomingFollowUps, recentCustomers,
    leadDates, callDates, emailDates, customerDates,
  ] = await Promise.all([
    prisma.carrier.count({ where: owner }),
    prisma.carrier.groupBy({ by: ['stageId'], where: owner, _count: { _all: true } }),
    prisma.carrier.count({ where: { ...owner, createdAt: { gte: start } } }),
    prisma.opportunity.count({ where: { ...owner, status: { in: ['open', 'negotiating', 'trial'] } } }),
    prisma.followUp.count({ where: { ...byUser, status: 'pending' } }),
    prisma.followUp.count({ where: { ...byUser, status: 'pending', dueAt: { lt: now } } }),
    prisma.call.count({ where: { ...byUser, calledAt: { gte: start } } }),
    prisma.email.count({ where: { ...byUser, status: 'sent', sentAt: { gte: start } } }),
    prisma.customer.count({ where: { ...owner, signedAt: { gte: start } } }),
    prisma.customer.count({ where: { ...owner, status: { not: 'churned' } } }),
    prisma.customer.count({ where: { ...owner, signedAt: { lt: start } } }),
    prisma.call.groupBy({ by: ['outcome'], where: { ...byUser, calledAt: { gte: start } }, _count: { _all: true } }),
    prisma.activity.findMany({
      where: byUser, orderBy: { createdAt: 'desc' }, take: 20,
      include: { user: { select: { id: true, name: true } }, carrier: { select: { id: true, companyName: true } } },
    }),
    prisma.sequenceEnrollment.count({ where: { ...byUser, status: 'active', nextStepAt: { lte: endToday } } }),
    prisma.sequenceEnrollment.findMany({
      where: { ...byUser, status: 'active', nextStepAt: { lte: endToday } }, orderBy: { nextStepAt: 'asc' }, take: 8,
      include: { carrier: { select: { id: true, companyName: true, phone: true, state: true } }, sequence: { select: { name: true, steps: { orderBy: { order: 'asc' }, select: { type: true, dayOffset: true } } } } },
    }),
    prisma.followUp.findMany({
      where: { ...byUser, status: 'pending' }, orderBy: { dueAt: 'asc' }, take: 8,
      include: { carrier: { select: { id: true, companyName: true, phone: true } } },
    }),
    prisma.customer.findMany({
      where: owner, orderBy: { signedAt: 'desc' }, take: 5,
      include: { carrier: { select: { id: true, companyName: true, mcNumber: true, state: true } } },
    }),
    prisma.carrier.findMany({ where: { ...owner, createdAt: { gte: start } }, select: { createdAt: true } }),
    prisma.call.findMany({ where: { ...byUser, calledAt: { gte: start } }, select: { calledAt: true } }),
    prisma.email.findMany({ where: { ...byUser, status: 'sent', sentAt: { gte: start } }, select: { sentAt: true } }),
    prisma.customer.findMany({ where: { ...owner, signedAt: { gte: start } }, select: { signedAt: true } }),
  ]);

  const stageCount = Object.fromEntries(stages.map((s) => [s.key, 0]));
  for (const g of stageGroups) {
    const s = stages.find((x) => x.id === g.stageId);
    if (s) stageCount[s.key] = g._count._all;
  }

  const keys = dayKeys(tz, days, now);
  const leads = bucket(leadDates.map((x) => x.createdAt), tz, keys);
  const calls = bucket(callDates.map((x) => x.calledAt), tz, keys);
  const emails = bucket(emailDates.map((x) => x.sentAt), tz, keys);
  const signed = bucket(customerDates.map((x) => x.signedAt), tz, keys);
  let running = customersBefore;
  const series = keys.map((k) => {
    running += signed[k];
    return { date: k, leads: leads[k], calls: calls[k], emails: emails[k], customers: signed[k], customersTotal: running };
  });

  const pipeline = stages.map((s) => ({ key: s.key, name: s.name, color: s.color, count: stageCount[s.key] }));
  const activeStages = pipeline.filter((p) => p.key !== 'archived');

  res.json({
    range: days,
    scope,
    canViewTeam: canViewTeam(req.user),
    timezone: tz,
    totals: {
      carriers: totalCarriers,
      newLeads: leadsInRange,
      prospecting: stageCount.prospecting ?? 0,
      inSequence: stageCount.sequence ?? 0,
      activeOpportunities: activeOpps,
      trials: stageCount.trial ?? 0,
      customers: customersTotal,
      customersInRange,
      pendingFollowUps,
      overdueFollowUps,
      callsCompleted: callsInRange,
      emailsSent: emailsInRange,
      conversionRate: leadsInRange ? Math.round((customersInRange / leadsInRange) * 1000) / 10 : null,
      overallConversionRate: totalCarriers ? Math.round(((stageCount.customer ?? 0) / totalCarriers) * 1000) / 10 : null,
      dueToday: dueEnrollmentsCount,
    },
    pipeline,
    funnel: activeStages,
    callOutcomes: outcomeGroups.map((g) => ({ outcome: g.outcome, count: g._count._all })).sort((a, b) => b.count - a.count),
    series,
    recentActivities: activities.map((a) => ({
      id: a.id, type: a.type, summary: a.summary, createdAt: a.createdAt,
      user: a.user, carrier: a.carrier, mine: a.userId === req.user.id,
    })),
    todaysSequence: dueEnrollments.map((e) => {
      const step = e.sequence.steps[e.currentStep];
      return { id: e.id, carrier: e.carrier, sequence: e.sequence.name, stepType: step?.type ?? null, day: step ? step.dayOffset + 1 : null, dueAt: e.nextStepAt, overdue: e.nextStepAt < now };
    }),
    upcomingFollowUps: upcomingFollowUps.map((f) => ({ id: f.id, dueAt: f.dueAt, type: f.type, note: f.note, carrier: f.carrier, overdue: f.dueAt < now })),
    recentCustomers: recentCustomers.map((c) => ({ id: c.id, signedAt: c.signedAt, status: c.status, carrier: c.carrier })),
    stageIds: stageId,
  });
}));

export default r;
