/**
 * Stops on the driver page. A consolidated trip (several loads on one truck) comes with its stops in the dispatcher's
 * order (trip.consolidation.stops); a single load has its pickup and delivery. Each stop carries its load's id and
 * status, so check-ins and the signed POD go to the load of the stop the driver is at.
 */
const PICKED_UP = ['in_transit', 'delivered', 'invoiced', 'paid'];
const DELIVERED = ['delivered', 'invoiced', 'paid'];

/** [{ loadId, kind: 'pickup' | 'delivery', referenceNumber, status, city, state, facility, address, ... }] */
export function tripStops(trip) {
  if (!trip) return [];
  if (trip.consolidation?.stops?.length) return trip.consolidation.stops;
  const own = { loadId: trip.id, referenceNumber: trip.referenceNumber ?? null, status: trip.status };
  return [{ ...own, kind: 'pickup', ...trip.pickup }, { ...own, kind: 'delivery', ...trip.delivery }];
}

/** A pickup is done once its load is under way; a delivery once its load is delivered. */
export const stopDone = (stop) => (stop.kind === 'pickup' ? PICKED_UP : DELIVERED).includes(stop.status);

/** The stop the driver is working on: the first one not done (the last stop when all are done). */
export function currentStopIndex(stops) {
  const i = stops.findIndex((s) => !stopDone(s));
  return i === -1 ? Math.max(0, stops.length - 1) : i;
}

export const stopKey = (stop) => `${stop.loadId}:${stop.kind}`;

/** The trip with one load's new status (after a check-in moved it), in the trip and in every stop of that load. */
export function withLoadStatus(trip, loadId, status) {
  if (!trip || !loadId || !status) return trip;
  return {
    ...trip,
    ...(trip.id === loadId ? { status } : {}),
    ...(trip.consolidation ? { consolidation: { ...trip.consolidation, stops: trip.consolidation.stops.map((s) => (s.loadId === loadId ? { ...s, status } : s)) } } : {}),
  };
}

/** Check-ins that belong to a stop: arrival and loaded at a pickup, arrival and delivered at a delivery. */
export const STOP_CHECKINS = {
  pickup: ['arrived_pickup', 'loaded'],
  delivery: ['arrived_delivery', 'delivered'],
};
