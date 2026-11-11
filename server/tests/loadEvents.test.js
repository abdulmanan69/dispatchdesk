import { describe, it, expect } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { loadEvents } from '../src/services/fleet/events.js';

describe('loadEvents', () => {
  it('returns all events in time order when under the cap', async () => {
    const { user } = await registerUser();
    const load = await prisma.load.create({ data: { ownerId: user.id, originCity: 'Dallas', originState: 'TX', destCity: 'Memphis', destState: 'TN', loadedMiles: 450, rateCents: 150000 } });
    const t0 = Date.UTC(2026, 10, 1, 12);
    await prisma.loadEvent.createMany({ data: [
      { loadId: load.id, ownerId: user.id, type: 'check_call', at: new Date(t0 + 2 * 3600_000) },
      { loadId: load.id, ownerId: user.id, type: 'arrived_pickup', at: new Date(t0) },
      { loadId: load.id, ownerId: user.id, type: 'loaded', at: new Date(t0 + 3600_000) },
    ] });
    expect((await loadEvents(load.id, { take: 10 })).map((e) => e.type)).toEqual(['arrived_pickup', 'loaded', 'check_call']);
  });

  it('over the cap keeps the newest events and the older stop milestones', async () => {
    const { user } = await registerUser();
    const load = await prisma.load.create({ data: { ownerId: user.id, originCity: 'Dallas', originState: 'TX', destCity: 'Memphis', destState: 'TN', loadedMiles: 450, rateCents: 150000 } });
    const t0 = Date.UTC(2026, 10, 1, 12);
    const at = (h) => new Date(t0 + h * 3600_000);
    await prisma.loadEvent.createMany({ data: [
      { loadId: load.id, ownerId: user.id, type: 'arrived_pickup', at: at(0) },
      { loadId: load.id, ownerId: user.id, type: 'check_call', at: at(1) },
      { loadId: load.id, ownerId: user.id, type: 'check_call', at: at(2) },
      { loadId: load.id, ownerId: user.id, type: 'check_call', at: at(3) },
      { loadId: load.id, ownerId: user.id, type: 'arrived_delivery', at: at(4) },
      { loadId: load.id, ownerId: user.id, type: 'check_call', at: at(5) },
    ] });
    const rows = await loadEvents(load.id, { take: 3 });
    // Newest three (hours 3, 4, 5) plus the pickup arrival, which the detention clock needs; old check calls drop off.
    expect(rows.map((e) => e.at.getTime())).toEqual([at(0), at(3), at(4), at(5)].map((d) => d.getTime()));
    expect(rows[0].type).toBe('arrived_pickup');
  });
});
