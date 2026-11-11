import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { broadcast, onBroadcast } from '../../lib/broadcast.js';

/**
 * Lane history from the workspace's own loads (never market rates).
 * One bounded aggregate per request: GROUP BY origin/destination state over a date window, using the
 * Load(ownerId, originState, destState) index. Results are cached for 5 minutes per owner set and filter; a load
 * write bumps the owner's generation in every worker (lib/broadcast.js), so the next read is fresh wherever it lands.
 */
const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 2000;
const cache = new Map(); // key -> { at, value }
const generation = new Map(); // ownerId -> n

function bumpLocal(ownerId) {
  if (!ownerId || typeof ownerId !== 'string') return;
  if (generation.size > 20_000) generation.clear();
  generation.set(ownerId, (generation.get(ownerId) || 0) + 1);
}
onBroadcast('lanes', bumpLocal);

export function bumpLanes(ownerId) {
  if (ownerId) broadcast('lanes', ownerId);
}

const DAY = 86_400_000;
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const toDate = (v) => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(typeof v === 'bigint' ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const n = (v) => (v == null ? 0 : Number(v));

/**
 * [{ originState, destState, loads, totalRateCents, totalMiles, avgRatePerMile, minRatePerMile, maxRatePerMile, lastLoadAt }]
 * for loads that are not canceled, picked up (or created, when there is no pickup date) within `days`.
 */
export async function laneAggregates(ownerIds, { originState, destState, days = 365, limit = 300, now = new Date() } = {}) {
  if (!ownerIds.length) return [];
  const since = new Date(now.getTime() - days * DAY);
  const where = [
    Prisma.sql`ownerId IN (${Prisma.join(ownerIds)})`,
    Prisma.sql`status <> 'canceled'`,
    Prisma.sql`COALESCE(pickupDate, createdAt) >= ${since}`,
  ];
  if (originState) where.push(Prisma.sql`originState = ${originState}`);
  if (destState) where.push(Prisma.sql`destState = ${destState}`);
  const rows = await prisma.$queryRaw`
    SELECT originState, destState, COUNT(*) AS loads, SUM(rateCents) AS rateCents, SUM(loadedMiles) AS miles,
           MIN(CASE WHEN loadedMiles > 0 THEN rateCents * 1.0 / loadedMiles END) AS minRpmCents,
           MAX(CASE WHEN loadedMiles > 0 THEN rateCents * 1.0 / loadedMiles END) AS maxRpmCents,
           MAX(COALESCE(pickupDate, createdAt)) AS lastAt
    FROM Load
    WHERE ${Prisma.join(where, ' AND ')}
    GROUP BY originState, destState
    ORDER BY loads DESC
    LIMIT ${limit}`;
  return rows.map((row) => {
    const miles = n(row.miles);
    const rate = n(row.rateCents);
    return {
      originState: row.originState,
      destState: row.destState,
      loads: n(row.loads),
      totalRateCents: rate,
      totalMiles: miles,
      avgRatePerMile: miles ? r2(rate / 100 / miles) : null,
      minRatePerMile: row.minRpmCents == null ? null : r2(Number(row.minRpmCents) / 100),
      maxRatePerMile: row.maxRpmCents == null ? null : r2(Number(row.maxRpmCents) / 100),
      lastLoadAt: toDate(row.lastAt),
    };
  });
}

/** Cached laneAggregates for a set of owners. */
export async function cachedLanes(ownerIds, opts = {}) {
  const ids = [...ownerIds].sort();
  const key = JSON.stringify([ids.map((id) => `${id}:${generation.get(id) || 0}`), opts.originState || '', opts.destState || '', opts.days || 365, opts.limit || 300]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await laneAggregates(ids, opts);
  cache.delete(key);
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Lane context for the load check card: the workspace's last-90-day history on one state pair, with sample size. */
export async function laneStats(ownerIds, originState, destState, { days = 90 } = {}) {
  const [row] = await cachedLanes(ownerIds, { originState, destState, days, limit: 1 });
  return {
    originState, destState, days,
    sampleSize: row?.loads ?? 0,
    avgRatePerMile: row?.avgRatePerMile ?? null,
    minRatePerMile: row?.minRatePerMile ?? null,
    maxRatePerMile: row?.maxRatePerMile ?? null,
    lastLoadAt: row?.lastLoadAt ?? null,
  };
}

export function resetLaneCache() {
  cache.clear();
  generation.clear();
}
