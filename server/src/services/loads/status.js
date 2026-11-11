import { prisma } from '../../db.js';
import { HttpError } from '../../lib/errors.js';
import { loadCarrier } from '../../lib/access.js';
import { logActivity } from '../../lib/activity.js';
import { LOAD_STATUSES } from '../../lib/constants.js';
import { truckUpdateForTrip } from '../fleet/index.js';
import { recordLoadEvent } from '../fleet/events.js';

/**
 * Load status changes, shared by every page that moves a load (Loads page, load detail, fleet trips).
 *   checkTransition(from, to, { force }) -> { ok, noop?, backward?, needsForce?, reason? }
 *   assertTransition(from, to, { force })  throws 409 CONFIRM_STATUS when a backward move or reopen needs `force`
 *   afterStatusChange(user, before, after, { source }) -> { truck, paperwork }
 *     moves the truck (truckUpdateForTrip: loaded on in_transit, available at the destination on delivered),
 *     records a LoadEvent of type 'status' and an activity, and reports missing paperwork (rate con when booked,
 *     POD when delivered) so the page can offer "Upload now" or "Remind me".
 */
export const STATUS_FLOW = ['planned', 'booked', 'in_transit', 'delivered', 'invoiced', 'paid'];
const ACTIVE = ['planned', 'booked', 'in_transit'];
const pretty = (s) => String(s || '').replace(/_/g, ' ');

export function checkTransition(from, to, { force = false } = {}) {
  if (!LOAD_STATUSES.includes(to)) return { ok: false, reason: `Unknown status "${to}"` };
  if (from === to) return { ok: true, noop: true };
  if (to === 'canceled') {
    if (ACTIVE.includes(from) || force) return { ok: true };
    return { ok: false, needsForce: true, reason: `This load is already ${pretty(from)}. Cancel it anyway?` };
  }
  if (from === 'canceled') {
    return force ? { ok: true, backward: true } : { ok: false, needsForce: true, reason: `This load was canceled. Reopen it as ${pretty(to)}?` };
  }
  const a = STATUS_FLOW.indexOf(from);
  const b = STATUS_FLOW.indexOf(to);
  if (b < a) {
    return force ? { ok: true, backward: true } : { ok: false, needsForce: true, reason: `Move this load back from ${pretty(from)} to ${pretty(to)}?` };
  }
  return { ok: true };
}

export function assertTransition(from, to, opts) {
  const c = checkTransition(from, to, opts);
  if (!c.ok) {
    throw new HttpError(c.needsForce ? 409 : 400, c.reason, { code: c.needsForce ? 'CONFIRM_STATUS' : 'BAD_STATUS', from, to });
  }
  return c;
}

/** Paperwork the next step needs that is not on file yet: rate con once booked, POD once delivered. */
export async function missingPaperwork(load) {
  const need = [];
  if (['booked', 'in_transit'].includes(load.status)) need.push('rate_confirmation');
  if (['delivered', 'invoiced', 'paid'].includes(load.status)) need.push('pod');
  if (!need.length) return [];
  const have = await prisma.document.findMany({ where: { loadId: load.id, type: { in: need } }, select: { type: true }, distinct: ['type'] });
  const got = new Set(have.map((d) => d.type));
  return need.filter((t) => !got.has(t));
}

export async function afterStatusChange(user, before, after, { source = 'dispatcher' } = {}) {
  let truck = null;
  if (after.carrierId) {
    const carrier = await loadCarrier(user, after.carrierId, { write: true }).catch(() => null);
    if (carrier) {
      const data = truckUpdateForTrip(before.status, after.status, after);
      // A delivered load moves the truck to the destination: a dispatcher-set position, not GPS.
      if (after.status === 'delivered') data.locationSource = 'manual';
      if (Object.keys(data).length) truck = await prisma.carrier.update({ where: { id: carrier.id }, data, select: { id: true, truckStatus: true, locationCity: true, locationState: true } });
    }
  }
  if (!ACTIVE.includes(after.status)) {
    // A finished or canceled trip no longer needs its road polyline (10+ KB in the Load row); miles and minutes stay.
    // A delivered load without a delivery date gets today, so date-bounded views (Today board, statements) see it.
    await prisma.load.updateMany({ where: { id: after.id, routeGeometry: { not: null } }, data: { routeGeometry: null } });
    if (after.status === 'delivered' && !after.deliveryDate) {
      await prisma.load.updateMany({ where: { id: after.id, deliveryDate: null }, data: { deliveryDate: new Date() } });
    }
  }
  await recordLoadEvent({
    loadId: after.id, ownerId: after.ownerId, type: 'status', source,
    note: `Status changed from ${pretty(before.status)} to ${pretty(after.status)}`,
    data: { from: before.status, to: after.status, by: user.id },
  });
  await logActivity(user, {
    type: 'load', carrierId: after.carrierId,
    summary: `Load ${after.referenceNumber || `${after.originCity} → ${after.destCity}`} is now ${pretty(after.status)}`,
  });
  const missing = await missingPaperwork(after);
  return { truck, paperwork: { missing } };
}
