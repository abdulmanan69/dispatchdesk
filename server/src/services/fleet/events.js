import { prisma } from '../../db.js';

/**
 * Load timeline events (LoadEvent). Shared contract used by fleet/driver links, loads (detention, status), and Today board.
 *   recordLoadEvent({ loadId, ownerId, type, at?, lat?, lng?, note?, source?, data? }) -> LoadEvent
 *   type: arrived_pickup | loaded | departed_pickup | arrived_delivery | delivered | issue | check_call |
 *         detention_start | detention_stop | document | status | note
 *   source: dispatcher | driver_link | broker_link | system
 * Callers must have already checked that the load belongs to ownerId.
 */
export const LOAD_EVENT_TYPES = ['arrived_pickup', 'loaded', 'departed_pickup', 'arrived_delivery', 'delivered', 'issue', 'check_call', 'detention_start', 'detention_stop', 'document', 'status', 'note'];

export async function recordLoadEvent({ loadId, ownerId, type, at = new Date(), lat = null, lng = null, note = null, source = 'dispatcher', data = null }) {
  if (!LOAD_EVENT_TYPES.includes(type)) throw new Error(`Unknown load event type: ${type}`);
  return prisma.loadEvent.create({
    data: {
      loadId, ownerId, type, at, lat, lng, source,
      note: note ? String(note).slice(0, 1000) : null,
      data: data == null ? null : JSON.stringify(data).slice(0, 4000),
    },
  });
}

export async function loadEvents(loadId, { take = 200 } = {}) {
  return prisma.loadEvent.findMany({ where: { loadId }, orderBy: { at: 'asc' }, take });
}
