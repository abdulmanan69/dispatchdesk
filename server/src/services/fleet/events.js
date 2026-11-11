import { prisma } from '../../db.js';

/**
 * Load timeline events (LoadEvent). Shared contract used by fleet/driver links, loads (detention, status), and Today board.
 *   recordLoadEvent({ loadId, ownerId, type, at?, lat?, lng?, note?, source?, data? }) -> LoadEvent
 *   type: arrived_pickup | loaded | departed_pickup | arrived_delivery | delivered | issue | check_call |
 *         detention_start | detention_stop | document | status | note | pod_signed
 *   source: dispatcher | driver_link | broker_link | system
 * Callers must have already checked that the load belongs to ownerId.
 */
export const LOAD_EVENT_TYPES = ['arrived_pickup', 'loaded', 'departed_pickup', 'arrived_delivery', 'delivered', 'issue', 'check_call', 'detention_start', 'detention_stop', 'document', 'status', 'note', 'pod_signed'];

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

/** Stop and detention events: the detention clock needs them even when a long trip has many newer check calls. */
const MILESTONES = ['arrived_pickup', 'loaded', 'departed_pickup', 'arrived_delivery', 'delivered', 'detention_start', 'detention_stop'];

/**
 * A load's timeline in time order: the newest `take` events, plus every stop and detention milestone that is older,
 * so a load with more events than `take` keeps its latest updates and a correct detention clock.
 */
export async function loadEvents(loadId, { take = 200 } = {}) {
  const rows = await prisma.loadEvent.findMany({ where: { loadId }, orderBy: { at: 'desc' }, take });
  if (rows.length >= take) {
    const seen = new Set(rows.map((e) => e.id));
    const milestones = await prisma.loadEvent.findMany({ where: { loadId, type: { in: MILESTONES } }, orderBy: { at: 'asc' }, take: 100 });
    rows.push(...milestones.filter((e) => !seen.has(e.id)));
  }
  return rows.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
