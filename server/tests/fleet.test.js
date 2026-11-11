import { describe, it, expect, beforeAll } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { searchPlaces, estimateMiles, pointFor } from '../src/services/fleet/index.js';

describe('fleet helpers', () => {
  it('finds built-in places and estimates road miles', () => {
    const dallas = searchPlaces('dallas')[0];
    expect(dallas).toMatchObject({ city: 'Dallas', state: 'TX', precision: 'city' });
    const chicago = pointFor('Chicago', 'IL');
    const miles = estimateMiles({ lat: dallas.lat, lng: dallas.lng }, chicago);
    expect(miles).toBeGreaterThan(850);
    expect(miles).toBeLessThan(1050);
    expect(pointFor('Nowhere', 'TX').precision).toBe('state');
    expect(searchPlaces('x')).toEqual([]);
  });
});

describe('fleet map API', () => {
  let A; let B; let truck; let other; let tripId;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    truck = (await A.agent.post('/api/carriers').send({ companyName: 'Lone Star Haulers', state: 'TX', phone: '2145550100', equipment: 'reefer' })).body.carrier;
    other = (await A.agent.post('/api/carriers').send({ companyName: 'Not In Fleet LLC', state: 'OH' })).body.carrier;
  });

  it('starts empty, then lists trucks once they have a status or location', async () => {
    expect((await A.agent.get('/api/fleet')).body.trucks).toHaveLength(0);
    expect((await A.agent.get('/api/fleet?scope=all')).body.trucks.length).toBe(2);
    const res = await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ truckStatus: 'available', location: { city: 'Dallas', state: 'TX' } });
    expect(res.status).toBe(200);
    expect(res.body.truck).toMatchObject({ truckStatus: 'available', location: { city: 'Dallas', state: 'TX' } });
    expect(res.body.truck.location.lat).toBeCloseTo(32.777, 2);
    const list = (await A.agent.get('/api/fleet')).body;
    expect(list.trucks.map((t) => t.id)).toEqual([truck.id]);
    expect(list.counts.available).toBe(1);
  });

  it('accepts exact map coordinates and validates input', async () => {
    const ok = await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ location: { city: 'Dallas', state: 'TX', lat: 32.9, lng: -96.9 } });
    expect(ok.body.truck.location).toMatchObject({ lat: 32.9, lng: -96.9, precision: 'exact' });
    expect((await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ truckStatus: 'flying' })).status).toBe(400);
    expect((await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ location: { lat: 95, lng: 0 } })).status).toBe(400);
  });

  it('isolates trucks between users', async () => {
    expect((await B.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ truckStatus: 'loaded' })).status).toBe(404);
    expect((await B.agent.get('/api/fleet?scope=all')).body.trucks).toHaveLength(0);
    expect((await B.agent.get('/api/fleet/near?city=Dallas&state=TX')).body.items).toHaveLength(0);
  });

  it('plans a trip with estimated deadhead and loaded miles', async () => {
    const res = await A.agent.post('/api/fleet/trips').send({
      carrierId: truck.id, origin: { city: 'Fort Worth', state: 'TX' }, dest: { city: 'Chicago', state: 'IL' },
      pickupDate: '2026-11-12T14:00:00Z', deliveryDate: '2026-11-13T20:00:00Z', rateCents: 250000, equipment: 'reefer',
    });
    expect(res.status).toBe(201);
    tripId = res.body.trip.id;
    expect(res.body.trip.status).toBe('planned');
    expect(res.body.trip.loadedMiles).toBeGreaterThan(800);
    expect(res.body.trip.deadheadMiles).toBeGreaterThan(5);
    expect(res.body.trip.deadheadMiles).toBeLessThan(60);
    expect(res.body.estimated).toEqual({ loadedMiles: true, deadheadMiles: true });
    const fleet = (await A.agent.get('/api/fleet')).body.trucks[0];
    expect(fleet.nextTrip.id).toBe(tripId);
  });

  it('uses road miles sent by the client and rejects bad dates or foreign carriers', async () => {
    const res = await A.agent.post('/api/fleet/trips').send({ carrierId: truck.id, origin: { city: 'Dallas', state: 'TX' }, dest: { city: 'Houston', state: 'TX' }, rateCents: 90000, loadedMiles: 239, deadheadMiles: 12 });
    expect(res.body.trip).toMatchObject({ loadedMiles: 239, deadheadMiles: 12, rpmLoaded: 3.77 });
    expect(res.body.estimated).toEqual({ loadedMiles: false, deadheadMiles: false });
    await A.agent.delete(`/api/fleet/trips/${res.body.trip.id}`).expect(200);
    const bad = await A.agent.post('/api/fleet/trips').send({ carrierId: truck.id, origin: { city: 'Dallas', state: 'TX' }, dest: { city: 'Houston', state: 'TX' }, rateCents: 1, pickupDate: '2026-11-12', deliveryDate: '2026-11-10' });
    expect(bad.status).toBe(400);
    expect((await B.agent.post('/api/fleet/trips').send({ carrierId: truck.id, origin: { city: 'Dallas', state: 'TX' }, dest: { city: 'Houston', state: 'TX' }, rateCents: 1 })).status).toBe(404);
  });

  it('finds trucks near a load origin, available ones first', async () => {
    await A.agent.patch(`/api/fleet/carriers/${other.id}`).send({ truckStatus: 'maintenance', location: { city: 'Houston', state: 'TX' } });
    const res = await A.agent.get('/api/fleet/near?city=Austin&state=TX');
    expect(res.status).toBe(200);
    expect(res.body.items.map((t) => t.id)).toEqual([truck.id, other.id]);
    expect(res.body.items[0].availableInTime).toBe(true);
    expect(res.body.items[1].availableInTime).toBe(false);
    expect((await A.agent.get('/api/fleet/near?city=Austin&state=TX&equipment=flatbed')).body.items).toHaveLength(0);
  });

  it('moves the truck along with the trip status', async () => {
    expect((await A.agent.post(`/api/fleet/trips/${tripId}/status`).send({ status: 'booked' })).status).toBe(200);
    const transit = await A.agent.post(`/api/fleet/trips/${tripId}/status`).send({ status: 'in_transit' });
    expect(transit.body.truck.truckStatus).toBe('loaded');
    // Same rules as the Loads page: moving back asks first (409 CONFIRM_STATUS) and changes nothing until confirmed.
    const back = await A.agent.post(`/api/fleet/trips/${tripId}/status`).send({ status: 'planned' });
    expect(back.status).toBe(409);
    expect(back.body.code).toBe('CONFIRM_STATUS');
    expect((await prisma.load.findUnique({ where: { id: tripId } })).status).toBe('in_transit');
    const done = await A.agent.post(`/api/fleet/trips/${tripId}/status`).send({ status: 'delivered' });
    expect(done.body.truck).toMatchObject({ truckStatus: 'available', location: { city: 'Chicago', state: 'IL' } });
    // The shared status code records each change on the load timeline and points out the missing POD.
    expect(done.body.paperwork.missing).toEqual(['pod']);
    const moves = await prisma.loadEvent.findMany({ where: { loadId: tripId, type: 'status' } });
    expect(moves.map((e) => JSON.parse(e.data).to).sort()).toEqual(['booked', 'delivered', 'in_transit']);
    expect(done.body.truck.currentTrip).toBeNull();
    expect((await A.agent.delete(`/api/fleet/trips/${tripId}`)).status).toBe(400);
    expect((await B.agent.post(`/api/fleet/trips/${tripId}/status`).send({ status: 'canceled' })).status).toBe(404);
  });

  it('lists trips for the week timeline and serves offline places', async () => {
    const res = await A.agent.get('/api/fleet/trips?from=2026-11-10T00:00:00Z&days=7');
    expect(res.body.items.map((t) => t.id)).toContain(tripId);
    expect(res.body.items[0].carrier.companyName).toBe('Lone Star Haulers');
    expect((await B.agent.get('/api/fleet/trips?from=2026-11-10T00:00:00Z')).body.items).toHaveLength(0);
    const places = await A.agent.get('/api/fleet/places?q=memph');
    expect(places.body.items[0]).toMatchObject({ city: 'Memphis', state: 'TN' });
  });

  it('shows customers on the fleet map and open loads as origins', async () => {
    const c = await prisma.carrier.findUnique({ where: { id: other.id } });
    // Writing the row directly bypasses the API, so the denormalized fleet flag is reset by hand too.
    await prisma.carrier.update({ where: { id: c.id }, data: { truckStatus: 'unknown', locationState: null, locationLat: null, locationLng: null, locationCity: null, isFleet: false } });
    expect((await A.agent.get('/api/fleet')).body.trucks.map((t) => t.id)).not.toContain(other.id);
    await prisma.customer.create({ data: { carrierId: other.id, ownerId: A.user.id } });
    expect((await A.agent.get('/api/fleet')).body.trucks.find((t) => t.id === other.id).isCustomer).toBe(true);
    await A.agent.post('/api/loads').send({ originCity: 'Memphis', originState: 'TN', destCity: 'Atlanta', destState: 'GA', rateCents: 120000, loadedMiles: 390 });
    const open = (await A.agent.get('/api/fleet')).body.openLoads;
    expect(open[0].origin).toMatchObject({ city: 'Memphis', state: 'TN' });
    expect(open[0].origin.lat).toBeCloseTo(35.15, 1);
  });
});
