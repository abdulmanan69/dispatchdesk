import { prisma } from '../../db.js';
import { ACTIVE_TRIP_STATUSES } from './index.js';

/**
 * Carrier.isFleet marks the trucks a dispatcher runs (the fleet map, the Today board, truck posts), so those lists are
 * one indexed query on Carrier(ownerId, isFleet). Write paths set it (customer created, truck status or position set,
 * live link, trip assigned) and a one-time backfill set it for older rows. healFleetFlags() catches what slipped
 * through for these owners: carriers that are customers or have an active trip but no flag. Bounded queries only.
 * Returns the number of carriers flagged.
 */
export async function healFleetFlags(owners) {
  const [cust, loads] = await Promise.all([
    prisma.customer.findMany({ where: { ownerId: { in: owners } }, select: { carrierId: true }, take: 2000 }),
    prisma.load.findMany({ where: { ownerId: { in: owners }, status: { in: ACTIVE_TRIP_STATUSES }, carrierId: { not: null } }, select: { carrierId: true }, take: 2000 }),
  ]);
  const ids = [...new Set([...cust, ...loads].map((x) => x.carrierId).filter(Boolean))];
  if (!ids.length) return 0;
  const missing = await prisma.carrier.findMany({ where: { id: { in: ids }, isFleet: false }, select: { id: true } });
  if (!missing.length) return 0;
  const { count } = await prisma.carrier.updateMany({ where: { id: { in: missing.map((m) => m.id) } }, data: { isFleet: true } });
  return count;
}
