import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app, registerUser, prisma } from './helpers.js';
import { prunePings } from '../src/services/fleet/track.js';

const pub = () => request(app); // no cookies, no CSRF header: the token is the only credential
const tokenOf = (link) => link.split('/track/')[1];

describe('live location via driver links', () => {
  let A; let B; let truck; let trip; let token; let shareId;
  beforeAll(async () => {
    A = await registerUser({ name: 'Dana Ruiz' });
    B = await registerUser();
    truck = (await A.agent.post('/api/carriers').send({ companyName: 'Lone Star Haulers', state: 'TX', phone: '2145550100' })).body.carrier;
    await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ truckStatus: 'available', location: { city: 'Dallas', state: 'TX' } });
    trip = (await A.agent.post('/api/fleet/trips').send({
      carrierId: truck.id, origin: { city: 'Dallas', state: 'TX' }, dest: { city: 'Memphis', state: 'TN' }, rateCents: 240000,
    })).body.trip;
    await A.agent.post(`/api/fleet/trips/${trip.id}/status`).send({ status: 'booked' });
  });

  it('dispatcher creates a link: token returned once, only its hash stored, message links ready', async () => {
    const res = await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ driverName: 'Marco', driverPhone: '(214) 555-0111', hours: 24, loadId: trip.id });
    expect(res.status).toBe(201);
    expect(res.body.link).toMatch(/\/track\/[A-Za-z0-9_-]{20,}$/);
    token = tokenOf(res.body.link);
    shareId = res.body.share.id;
    expect(res.body.share).toMatchObject({ status: 'pending', driverName: 'Marco' });
    expect(res.body.message.text).toContain('Lone Star Haulers dispatch');
    expect(res.body.message.sms).toContain('+12145550111');
    const row = await prisma.locationShare.findUnique({ where: { id: shareId } });
    expect(row.tokenHash).not.toBe(token);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('rejects bad hours and trips that are not this carrier\'s', async () => {
    expect((await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ hours: 5 })).status).toBe(400);
    expect((await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ loadId: 'nope' })).status).toBe(400);
  });

  it('other users cannot create, list or stop shares', async () => {
    expect((await B.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({})).status).toBe(404);
    expect((await B.agent.get(`/api/fleet/carriers/${truck.id}/shares`)).status).toBe(404);
    expect((await B.agent.post(`/api/fleet/shares/${shareId}/stop`)).status).toBe(404);
    expect((await B.agent.get(`/api/fleet/carriers/${truck.id}/trail`)).status).toBe(404);
  });

  it('driver page shows only company, dispatcher first name and the trip', async () => {
    const res = await pub().get(`/api/public/track/${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ company: 'Lone Star Haulers', dispatcher: 'Dana', status: 'pending', driverName: 'Marco' });
    expect(res.body.trip).toMatchObject({ status: 'booked', pickup: { city: 'Dallas', state: 'TX' }, delivery: { city: 'Memphis', state: 'TN' } });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(A.email);
    expect(body).not.toContain('2145550100');
    expect(body).not.toContain('rateCents');
    expect((await pub().get('/api/public/track/not-a-real-token-123456')).status).toBe(410);
  });

  it('pings need consent first, then update the truck and are throttled', async () => {
    expect((await pub().post(`/api/public/track/${token}/ping`).send({ lat: 32.8, lng: -96.8 })).status).toBe(409);
    expect((await pub().post(`/api/public/track/${token}/consent`)).body.status).toBe('sharing');
    expect((await pub().post(`/api/public/track/${token}/ping`).send({ lat: 95, lng: 0 })).status).toBe(400);
    const ok = await pub().post(`/api/public/track/${token}/ping`).send({ lat: 32.81, lng: -96.81, accuracy: 12, speed: 26.8, heading: 90 });
    expect(ok.status).toBe(200);
    const fleet = (await A.agent.get('/api/fleet')).body.trucks.find((t) => t.id === truck.id);
    expect(fleet.location.lat).toBeCloseTo(32.81, 3);
    expect(fleet.live).toMatchObject({ source: 'driver_link', sharing: true, driverName: 'Marco', speedMph: 60, stale: false, accuracyM: 12 });
    const soon = await pub().post(`/api/public/track/${token}/ping`).send({ lat: 32.82, lng: -96.82 });
    expect(soon.status).toBe(429);
    expect(soon.body.retryAfterSec).toBeGreaterThan(0);
    // allow the next ping by moving the last fix back in time
    await prisma.locationShare.update({ where: { id: shareId }, data: { lastAt: new Date(Date.now() - 60_000) } });
    expect((await pub().post(`/api/public/track/${token}/ping`).send({ lat: 33.0, lng: -96.5 })).status).toBe(200);
    const trail = (await A.agent.get(`/api/fleet/carriers/${truck.id}/trail?hours=24`)).body.items;
    expect(trail).toHaveLength(2);
    expect(trail[0]).toMatchObject({ lat: 32.81, speedMph: 60 });
  });

  it('check-ins move the trip and the truck, and notify the dispatcher', async () => {
    const loaded = await pub().post(`/api/public/track/${token}/checkin`).send({ event: 'loaded' });
    expect(loaded.body).toMatchObject({ ok: true, tripStatus: 'in_transit' });
    let t = (await A.agent.get('/api/fleet')).body.trucks.find((x) => x.id === truck.id);
    expect(t.truckStatus).toBe('loaded');
    await pub().post(`/api/public/track/${token}/checkin`).send({ event: 'issue', note: 'Flat tire near Texarkana' });
    const delivered = await pub().post(`/api/public/track/${token}/checkin`).send({ event: 'delivered' });
    expect(delivered.body.tripStatus).toBe('delivered');
    t = (await A.agent.get('/api/fleet')).body.trucks.find((x) => x.id === truck.id);
    expect(t).toMatchObject({ truckStatus: 'available', location: { city: 'Memphis', state: 'TN' } });
    const notes = await prisma.notification.findMany({ where: { userId: A.user.id, type: { in: ['fleet', 'fleet_issue'] } } });
    expect(notes.some((n) => n.type === 'fleet_issue' && n.title.includes('Flat tire'))).toBe(true);
    const checkins = (await A.agent.get(`/api/fleet/carriers/${truck.id}/checkins`)).body.items;
    expect(checkins.some((c) => c.type === 'checkin' && c.summary.includes('Marco: Delivered'))).toBe(true);
    expect((await pub().post(`/api/public/track/${token}/checkin`).send({ event: 'teleported' })).status).toBe(400);
  });

  it('dispatcher can stop a link; the driver then gets 410', async () => {
    const stop = await A.agent.post(`/api/fleet/shares/${shareId}/stop`);
    expect(stop.body.share.status).toBe('stopped');
    expect((await pub().get(`/api/public/track/${token}`)).status).toBe(410);
    expect((await pub().post(`/api/public/track/${token}/ping`).send({ lat: 33, lng: -96 })).status).toBe(410);
  });

  it('expired links return 410; a new link stops the old one', async () => {
    const one = await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ hours: 8 });
    const two = await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ hours: 8 });
    expect((await pub().get(`/api/public/track/${tokenOf(one.body.link)}`)).status).toBe(410);
    await prisma.locationShare.update({ where: { id: two.body.share.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await pub().get(`/api/public/track/${tokenOf(two.body.link)}`)).status).toBe(410);
    const list = (await A.agent.get(`/api/fleet/carriers/${truck.id}/shares`)).body.items;
    expect(list[0].status).toBe('expired');
  });

  it('prunes pings older than 30 days', async () => {
    await prisma.locationPing.updateMany({ where: { share: { carrierId: truck.id } }, data: { at: new Date(Date.now() - 40 * 86400000) } });
    expect(await prunePings()).toBeGreaterThanOrEqual(2);
    expect(await prisma.locationPing.count({ where: { share: { carrierId: truck.id } } })).toBe(0);
  });
});
