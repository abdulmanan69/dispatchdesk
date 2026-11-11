import { prisma } from '../../db.js';

/**
 * ai-usage-retention: AI usage events (services/ai/llm.js) are kept 13 months: enough for this month's plan quota,
 * the admin cost overview and a year-over-year look back. Older rows are deleted in batches of 500 (short write
 * transactions) through the AiUsageEvent(createdAt) index, at most 50,000 per run; a backlog continues the next day.
 */
export const AI_USAGE_KEEP_MONTHS = 13;
const BATCH = 500;
const MAX_PER_RUN = 50_000;

/** The cutoff: the same day and time 13 calendar months before `now` (UTC). */
export function aiUsageCutoff(now = new Date()) {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - AI_USAGE_KEEP_MONTHS);
  return d;
}

export async function pruneAiUsage(now = new Date(), { batch = BATCH, max = MAX_PER_RUN } = {}) {
  const where = { createdAt: { lt: aiUsageCutoff(now) } };
  let deleted = 0;
  while (deleted < max) {
    const rows = await prisma.aiUsageEvent.findMany({ where, select: { id: true }, orderBy: { createdAt: 'asc' }, take: Math.min(batch, max - deleted) });
    if (!rows.length) break;
    const res = await prisma.aiUsageEvent.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    deleted += res.count;
    if (rows.length < batch) break;
  }
  return deleted;
}

export const jobs = [
  {
    name: 'ai-usage-retention',
    label: `Delete AI usage records older than ${AI_USAGE_KEEP_MONTHS} months`,
    dailyAtUtc: 8,
    run: async (now) => ({ deleted: await pruneAiUsage(now) }),
  },
];
