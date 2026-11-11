import { prisma } from '../../db.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { parse, z, clean } from '../../lib/validate.js';
import { loadCarrier, loadOwned } from '../../lib/access.js';
import { logActivity } from '../../lib/activity.js';
import { loadFields } from '../../routes/loads.js';
import { fitColumns } from '../loads/fitCheck.js';
import { facilityTimezone } from '../loads/facilityTz.js';
import { bumpLanes } from '../loads/lanes.js';
import { afterStatusChange } from '../loads/status.js';
import { invalidateToday } from '../fleet/today.js';
import { scheduleLoadRoute } from '../fleet/route.js';

/**
 * "Accept & book": the Load for an agreed negotiation, created or updated through the same field rules as the loads
 * API (routes/loads.js loadFields), with the same derived columns and side effects as POST/PATCH /api/loads:
 * facility time zones, the carrier-rules check (fitWarnings), lane figures, the Today board, the road route and the
 * fleet flag. routes/loads.js exports no create/update helper, so these steps mirror its private ones (derived,
 * changed, afterLoadSave); keep them in step when that route changes.
 *
 * prepareBooking() validates everything first (nothing is written), commitBooking() writes.
 */

// Built on first use: routes/loads.js and this module can meet in an import cycle (email replies -> negotiation).
let schemas = null;
const loadSchemas = () => (schemas ||= { create: z.object(loadFields), update: z.object(loadFields).partial() });
const include = { broker: { select: { id: true, companyName: true } }, carrier: { select: { id: true, companyName: true } } };
const HELD = { delivered: 'already delivered', invoiced: 'already invoiced', paid: 'already paid', canceled: 'canceled. Reopen it first' };

/** Broker and carrier the user may still use (a reference that lost access is left off the load). */
async function refs(user, neg) {
  const brokerId = await loadOwned('broker', user, neg.brokerId).then(() => neg.brokerId, () => null);
  const carrierId = neg.carrierId ? await loadCarrier(user, neg.carrierId).then(() => neg.carrierId, () => null) : null;
  return { brokerId, carrierId };
}

function laneDay(v) {
  if (!v) return undefined;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s;
}

/**
 * Validate the booking. Returns { kind: 'create' | 'update', data, existing } or throws 400/409.
 * `loadedMiles` fills in a lane without miles (a load cannot be saved without them).
 */
export async function prepareBooking(user, neg, cents, { loadedMiles } = {}) {
  const lane = neg.lane || {};
  const { brokerId, carrierId } = await refs(user, neg);
  const existing = neg.loadId ? await loadOwned('load', user, neg.loadId, { write: true }).catch(() => null) : null;
  if (existing) {
    if (HELD[existing.status]) throw conflict(`This load is ${HELD[existing.status]}`);
    const data = parse(loadSchemas().update, clean({
      rateCents: cents,
      brokerId: brokerId || undefined,
      carrierId: carrierId || existing.carrierId || undefined,
      status: existing.status === 'planned' ? 'booked' : undefined,
    }));
    return { kind: 'update', data, existing };
  }
  const miles = loadedMiles ?? lane.miles;
  if (!miles) throw badRequest('Enter the loaded miles to book this load');
  const raw = clean({
    referenceNumber: lane.reference || undefined,
    originCity: lane.originCity, originState: lane.originState, destCity: lane.destCity, destState: lane.destState,
    pickupDate: laneDay(lane.pickupDate), deliveryDate: laneDay(lane.deliveryDate),
    equipment: lane.equipment || undefined, weightLbs: lane.weightLbs ?? undefined, commodity: lane.commodity || undefined,
    loadedMiles: miles, deadheadMiles: lane.deadheadMiles ?? 0, rateCents: cents, status: 'booked',
    brokerId: brokerId || undefined, carrierId: carrierId || undefined,
  });
  if (!raw.originCity || !raw.originState || !raw.destCity || !raw.destState) throw badRequest('Add the pickup and delivery city and state to book this load');
  const data = parse(loadSchemas().create, raw);
  if (data.pickupDate && data.deliveryDate && data.deliveryDate < data.pickupDate) throw badRequest('Delivery date cannot be before pickup date');
  return { kind: 'create', data, existing: null };
}

/** Write the load prepared by prepareBooking(). Returns the saved load (with broker and carrier names). */
export async function commitBooking(user, plan, { negotiationId } = {}) {
  if (plan.kind === 'update') {
    const { existing } = plan;
    const fit = await fitColumns({ ...existing, ...plan.data }, existing);
    const load = await prisma.load.update({ where: { id: existing.id }, data: { ...plan.data, ...fit }, include });
    bumpLanes(existing.ownerId);
    invalidateToday(existing.ownerId, user.id);
    await afterSave(load, existing);
    if (plan.data.status && plan.data.status !== existing.status) await afterStatusChange(user, existing, load);
    await logActivity(user, { type: 'load', carrierId: load.carrierId, summary: `Rate agreed with the broker: ${loadName(load)} booked at ${dollars(load.rateCents)}`, metadata: { loadId: load.id, negotiationId } });
    return load;
  }
  const data = { ...plan.data };
  data.pickupTz = facilityTimezone(data.originCity, data.originState);
  data.deliveryTz = facilityTimezone(data.destCity, data.destState);
  const fit = await fitColumns(data, null);
  const load = await prisma.load.create({ data: { ...data, ...fit, ownerId: user.id }, include });
  bumpLanes(user.id);
  invalidateToday(user.id, user.id);
  await afterSave(load, null);
  await logActivity(user, { type: 'load', carrierId: load.carrierId, summary: `Added load ${loadName(load)} at ${dollars(load.rateCents)} (rate agreed with the broker)`, metadata: { loadId: load.id, negotiationId } });
  return load;
}

const loadName = (l) => l.referenceNumber || `${l.originCity}, ${l.originState} → ${l.destCity}, ${l.destState}`;
const dollars = (cents) => `$${(cents / 100).toLocaleString('en-US')}`;

/** Same as the loads route: an active load gets its road route; its carrier becomes a truck on the fleet map. */
async function afterSave(load, existing) {
  const moved = !existing || ['originCity', 'originState', 'destCity', 'destState'].some((k) => existing[k] !== load[k]);
  if (moved) scheduleLoadRoute(load);
  if (load.carrierId && (!existing || existing.carrierId !== load.carrierId || existing.status === 'planned')) {
    await prisma.carrier.updateMany({ where: { id: load.carrierId, isFleet: false }, data: { isFleet: true } });
  }
}
