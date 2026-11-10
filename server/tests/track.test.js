import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app, registerUser, prisma } from './helpers.js';
import { prunePings, trustFor, evaluateFix, describeDevice, coarseIp, addFlags, parseFlags } from '../src/services/fleet/track.js';

const pub = () => request(app); // no cookies, no CSRF header: the token (and, once claimed, the device secret) is the credential
const tokenOf = (link) => link.split('/track/')[1];
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const as = (req, ua, device) => { let q = req.set('User-Agent', ua); if (device) q = q.set('X-Track-Device', device); return q; };
// Simulate time passing since the last fix (both the throttle clock and the trusted reference point).
const back = async (id, ms = 10 * 60_000) => {
  const s = await prisma.locationShare.findUnique({ where: { id } });
  await prisma.locationShare.update({ where: { id }, data: { lastAt: new Date(Date.now() - ms), ...(s.trustedAt ? { trustedAt: new Date(Date.now() - ms) } : {}) } });
};

describe('live location via driver links', () => {
  let A; let B; let truck; let trip; let token; let shareId; let device;
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
    const res = await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ driverName: 'Marco', driverPhone: '(214) 555-0111', hours: 24, loadId: trip.id, pin: false });
    expect(res.status).toBe(201);
    expect(res.body.link).toMatch(/\/track\/[A-Za-z0-9_-]{20,}$/);
    expect(res.body.pin).toBeNull();
    token = tokenOf(res.body.link);
    shareId = res.body.share.id;
    expect(res.body.share).toMatchObject({ status: 'pending', driverName: 'Marco', trust: { confidence: null, pinEnabled: false } });
    expect(res.body.message.text).toContain('Lone Star Haulers dispatch');
    expect(res.body.message.sms).toContain('+12145550111');
    const row = await prisma.locationShare.findUnique({ where: { id: shareId } });
    expect(row.tokenHash).not.toBe(token);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('rejects bad hours, bad claim windows and trips that are not this carrier\'s', async () => {
    expect((await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ hours: 5 })).status).toBe(400);
    expect((await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ claimMinutes: 45 })).status).toBe(400);
    expect((await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ loadId: 'nope' })).status).toBe(400);
  });

  it('other users cannot create, list, reset or stop shares', async () => {
    expect((await B.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({})).status).toBe(404);
    expect((await B.agent.get(`/api/fleet/carriers/${truck.id}/shares`)).status).toBe(404);
    expect((await B.agent.post(`/api/fleet/shares/${shareId}/stop`)).status).toBe(404);
    expect((await B.agent.post(`/api/fleet/shares/${shareId}/reset-device`)).status).toBe(404);
    expect((await B.agent.get(`/api/fleet/carriers/${truck.id}/trail`)).status).toBe(404);
  });

  it('driver page (no PIN) shows only company, dispatcher first name and the trip', async () => {
    const res = await pub().get(`/api/public/track/${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ company: 'Lone Star Haulers', dispatcher: 'Dana', status: 'pending', driverName: 'Marco', pinRequired: false, bound: false });
    expect(res.body.trip).toMatchObject({ status: 'booked', pickup: { city: 'Dallas', state: 'TX' }, delivery: { city: 'Memphis', state: 'TN' } });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(A.email);
    expect(body).not.toContain('2145550100');
    expect(body).not.toContain('rateCents');
    expect((await pub().get('/api/public/track/not-a-real-token-123456')).status).toBe(410);
  });

  it('consent claims the link for this phone; pings need that phone and are throttled', async () => {
    expect((await pub().post(`/api/public/track/${token}/ping`).send({ lat: 32.8, lng: -96.8 })).status).toBe(409);
    const consent = await as(pub().post(`/api/public/track/${token}/consent`), IPHONE).send({ signals: { touch: true, coarse: true, width: 390 } });
    expect(consent.body.status).toBe('sharing');
    device = consent.body.deviceSecret;
    expect(device).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const row = await prisma.locationShare.findUnique({ where: { id: shareId } });
    expect(row.deviceHash).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(device);
    expect(row).toMatchObject({ deviceLabel: 'iPhone · Safari', deviceKind: 'mobile' });
    // claiming starts the full duration (24 h)
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);

    expect((await as(pub().post(`/api/public/track/${token}/ping`), IPHONE, device).send({ lat: 95, lng: 0 })).status).toBe(400);
    const ok = await as(pub().post(`/api/public/track/${token}/ping`), IPHONE, device).send({ lat: 32.81, lng: -96.81, accuracy: 12, speed: 26.8, heading: 90, clientTime: Date.now() });
    expect(ok.status).toBe(200);
    const fleet = (await A.agent.get('/api/fleet')).body.trucks.find((t) => t.id === truck.id);
    expect(fleet.location.lat).toBeCloseTo(32.81, 3);
    expect(fleet.live).toMatchObject({ source: 'driver_link', sharing: true, driverName: 'Marco', speedMph: 60, stale: false, accuracyM: 12, deviceLabel: 'iPhone · Safari' });
    const soon = await as(pub().post(`/api/public/track/${token}/ping`), IPHONE, device).send({ lat: 32.82, lng: -96.82 });
    expect(soon.status).toBe(429);
    expect(soon.body.retryAfterSec).toBeGreaterThan(0);
    await back(shareId);
    expect((await as(pub().post(`/api/public/track/${token}/ping`), IPHONE, device).send({ lat: 32.9, lng: -96.75, accuracy: 15 })).status).toBe(200);
    const trail = (await A.agent.get(`/api/fleet/carriers/${truck.id}/trail?hours=24`)).body.items;
    expect(trail).toHaveLength(2);
    expect(trail[0]).toMatchObject({ lat: 32.81, speedMph: 60 });
  });

  it('a forwarded link does not work on a second phone: 409, nothing shown, flagged, dispatcher told once', async () => {
    const other = await as(pub().get(`/api/public/track/${token}`), ANDROID);
    expect(other.status).toBe(409);
    expect(other.body.details.code).toBe('DEVICE_MISMATCH');
    expect(JSON.stringify(other.body)).not.toContain('Memphis');
    const wrong = await as(pub().post(`/api/public/track/${token}/ping`), ANDROID, 'someone-elses-secret-123456').send({ lat: 39.7, lng: -104.9 });
    expect(wrong.status).toBe(409);
    expect((await as(pub().post(`/api/public/track/${token}/checkin`), ANDROID).send({ event: 'loaded' })).status).toBe(409);
    const row = await prisma.locationShare.findUnique({ where: { id: shareId } });
    const flags = parseFlags(row.flags).filter((f) => f.type === 'other_device');
    expect(flags.length).toBeGreaterThanOrEqual(1);
    expect(flags[0].detail).toContain('Android · Chrome');
    const alerts = await prisma.notification.findMany({ where: { userId: A.user.id, title: { contains: 'opened on another device' } } });
    expect(alerts).toHaveLength(1); // throttled to one per 30 minutes
    // the owner's phone is unaffected and the truck did not move to Denver
    expect((await as(pub().get(`/api/public/track/${token}`), IPHONE, device)).body).toMatchObject({ bound: true, company: 'Lone Star Haulers' });
    const t = (await A.agent.get('/api/fleet')).body.trucks.find((x) => x.id === truck.id);
    expect(t.location.lat).toBeCloseTo(32.9, 2);
    expect(t.live.confidence).toBe('medium');
    expect(t.live.reasons.join(' ')).toContain('another device');
  });

  it('check-ins from the claimed phone move the trip and the truck, and notify the dispatcher', async () => {
    const loaded = await as(pub().post(`/api/public/track/${token}/checkin`), IPHONE, device).send({ event: 'loaded' });
    expect(loaded.body).toMatchObject({ ok: true, tripStatus: 'in_transit' });
    let t = (await A.agent.get('/api/fleet')).body.trucks.find((x) => x.id === truck.id);
    expect(t.truckStatus).toBe('loaded');
    await as(pub().post(`/api/public/track/${token}/checkin`), IPHONE, device).send({ event: 'issue', note: 'Flat tire near Texarkana' });
    const delivered = await as(pub().post(`/api/public/track/${token}/checkin`), IPHONE, device).send({ event: 'delivered' });
    expect(delivered.body.tripStatus).toBe('delivered');
    t = (await A.agent.get('/api/fleet')).body.trucks.find((x) => x.id === truck.id);
    expect(t).toMatchObject({ truckStatus: 'available', location: { city: 'Memphis', state: 'TN' } });
    const notes = await prisma.notification.findMany({ where: { userId: A.user.id, type: { in: ['fleet', 'fleet_issue'] } } });
    expect(notes.some((n) => n.type === 'fleet_issue' && n.title.includes('Flat tire'))).toBe(true);
    const checkins = (await A.agent.get(`/api/fleet/carriers/${truck.id}/checkins`)).body.items;
    expect(checkins.some((c) => c.type === 'checkin' && c.summary.includes('Marco: Delivered'))).toBe(true);
    expect((await as(pub().post(`/api/public/track/${token}/checkin`), IPHONE, device).send({ event: 'teleported' })).status).toBe(400);
  });

  it('dispatcher can stop a link; the driver then gets 410', async () => {
    const stop = await A.agent.post(`/api/fleet/shares/${shareId}/stop`);
    expect(stop.body.share.status).toBe('stopped');
    expect((await as(pub().get(`/api/public/track/${token}`), IPHONE, device)).status).toBe(410);
    expect((await as(pub().post(`/api/public/track/${token}/ping`), IPHONE, device).send({ lat: 33, lng: -96 })).status).toBe(410);
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

describe('PIN-protected links', () => {
  let A; let truck;
  beforeAll(async () => {
    A = await registerUser({ name: 'Rosa Lin' });
    truck = (await A.agent.post('/api/carriers').send({ companyName: 'Prairie Freight', state: 'KS', phone: '3165550100' })).body.carrier;
  });

  it('PIN is on by default, shown once, never in the message; nothing but the company is shown before it', async () => {
    const res = await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ driverName: 'Ike', hours: 8 });
    expect(res.status).toBe(201);
    expect(res.body.pin).toMatch(/^\d{6}$/);
    expect(res.body.message.text).not.toContain(res.body.pin);
    expect(res.body.share.trust).toMatchObject({ pinEnabled: true, pinVerified: false });
    const row = await prisma.locationShare.findUnique({ where: { id: res.body.share.id } });
    expect(JSON.stringify(row)).not.toContain(res.body.pin);
    const token = tokenOf(res.body.link);
    const info = await pub().get(`/api/public/track/${token}`);
    expect(info.body).toEqual({ company: 'Prairie Freight', pinRequired: true, status: 'pending', claimBy: expect.any(String) });
    expect((await pub().post(`/api/public/track/${token}/consent`)).body.details.code).toBe('PIN_REQUIRED');
    expect((await pub().post(`/api/public/track/${token}/checkin`).send({ event: 'loaded' })).body.details.code).toBe('PIN_REQUIRED');
  });

  it('correct PIN claims the link, starts the full duration and verifies; wrong PINs count down', async () => {
    const res = await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ hours: 8, claimMinutes: 30 });
    const token = tokenOf(res.body.link);
    const wrong = res.body.pin === '000000' ? '111111' : '000000';
    const w1 = await as(pub().post(`/api/public/track/${token}/pin`), IPHONE).send({ pin: wrong });
    expect(w1.status).toBe(403);
    expect(w1.body.details).toMatchObject({ code: 'WRONG_PIN', attemptsLeft: 4 });
    const ok = await as(pub().post(`/api/public/track/${token}/pin`), IPHONE).send({ pin: res.body.pin, signals: { touch: true, coarse: true } });
    expect(ok.status).toBe(200);
    expect(ok.body.deviceSecret).toBeTruthy();
    expect(ok.body).toMatchObject({ company: 'Prairie Freight', bound: true, pinRequired: false });
    const row = await prisma.locationShare.findUnique({ where: { id: res.body.share.id } });
    expect(row.pinVerifiedAt).toBeTruthy();
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 7 * 3600_000);
    // after claiming, the PIN no longer opens it on another phone
    const second = await as(pub().post(`/api/public/track/${token}/pin`), ANDROID).send({ pin: res.body.pin });
    expect(second.status).toBe(409);
    expect(second.body.details.code).toBe('DEVICE_MISMATCH');
  });

  it('five wrong PINs lock the link and alert the dispatcher', async () => {
    const res = await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ hours: 8 });
    const token = tokenOf(res.body.link);
    const wrong = res.body.pin === '123456' ? '654321' : '123456';
    for (let i = 0; i < 4; i++) expect((await pub().post(`/api/public/track/${token}/pin`).send({ pin: wrong })).status).toBe(403);
    const last = await pub().post(`/api/public/track/${token}/pin`).send({ pin: wrong });
    expect(last.status).toBe(410);
    expect(last.body.details.code).toBe('LOCKED');
    expect((await pub().post(`/api/public/track/${token}/pin`).send({ pin: res.body.pin })).status).toBe(410);
    const row = await prisma.locationShare.findUnique({ where: { id: res.body.share.id } });
    expect(row.status).toBe('locked');
    expect(parseFlags(row.flags).filter((f) => f.type === 'wrong_pin')).toHaveLength(5);
    const n = await prisma.notification.findFirst({ where: { userId: A.user.id, title: { contains: 'was locked' } } });
    expect(n).toBeTruthy();
    // the map shows the locked link
    const list = (await A.agent.get(`/api/fleet/carriers/${truck.id}/shares`)).body.items;
    expect(list[0]).toMatchObject({ status: 'locked', pinAttemptsLeft: 0 });
  });

  it('links not opened within the claim window expire', async () => {
    const res = await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ hours: 72, claimMinutes: 30 });
    expect(new Date(res.body.share.claimBy).getTime()).toBeLessThan(Date.now() + 31 * 60_000);
    await prisma.locationShare.update({ where: { id: res.body.share.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const gone = await pub().get(`/api/public/track/${tokenOf(res.body.link)}`);
    expect(gone.status).toBe(410);
    expect(gone.body.error).toContain('not opened in time');
  });

  it('reset device: new PIN shown once, the old phone loses access, a new phone can claim it', async () => {
    const res = await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ hours: 24 });
    const token = tokenOf(res.body.link);
    const first = await as(pub().post(`/api/public/track/${token}/pin`), IPHONE).send({ pin: res.body.pin });
    const oldDevice = first.body.deviceSecret;
    const reset = await A.agent.post(`/api/fleet/shares/${res.body.share.id}/reset-device`);
    expect(reset.status).toBe(200);
    expect(reset.body.pin).toMatch(/^\d{6}$/);
    expect(reset.body.share).toMatchObject({ status: 'pending', trust: { confidence: null } });
    // the old phone now sees only the PIN screen and cannot ping
    expect((await as(pub().get(`/api/public/track/${token}`), IPHONE, oldDevice)).body.pinRequired).toBe(true);
    expect((await as(pub().post(`/api/public/track/${token}/ping`), IPHONE, oldDevice).send({ lat: 37.7, lng: -97.3 })).status).toBe(409);
    expect((await as(pub().post(`/api/public/track/${token}/pin`), ANDROID).send({ pin: res.body.pin })).status).toBe(403);
    const claimed = await as(pub().post(`/api/public/track/${token}/pin`), ANDROID).send({ pin: reset.body.pin, signals: { touch: true, coarse: true } });
    expect(claimed.status).toBe(200);
    const row = await prisma.locationShare.findUnique({ where: { id: res.body.share.id } });
    expect(row.deviceLabel).toBe('Android · Chrome');
  });
});

describe('trust signals', () => {
  let A; let truck; let token; let shareId; let device;
  beforeAll(async () => {
    A = await registerUser({ name: 'Ann Cole' });
    truck = (await A.agent.post('/api/carriers').send({ companyName: 'Gulf Coast Carriers', state: 'TX', phone: '7135550100' })).body.carrier;
    const res = await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ hours: 24 });
    token = tokenOf(res.body.link);
    shareId = res.body.share.id;
    device = (await as(pub().post(`/api/public/track/${token}/pin`), IPHONE).send({ pin: res.body.pin, signals: { touch: true, coarse: true } })).body.deviceSecret;
    await as(pub().post(`/api/public/track/${token}/consent`), IPHONE, device).send({});
  });

  it('a good phone fix with PIN and accurate GPS is high confidence', async () => {
    expect((await as(pub().post(`/api/public/track/${token}/ping`), IPHONE, device).send({ lat: 29.76, lng: -95.37, accuracy: 9, clientTime: Date.now() })).status).toBe(200);
    const t = (await A.agent.get('/api/fleet')).body.trucks.find((x) => x.id === truck.id);
    expect(t.live).toMatchObject({ confidence: 'high', pinVerified: true, deviceLabel: 'iPhone · Safari', unverified: null });
    expect(t.live.reasons).toEqual(expect.arrayContaining(['PIN checked']));
  });

  it('an impossible jump is flagged, does not move the truck or the trail, and alerts the dispatcher', async () => {
    await back(shareId);
    expect((await as(pub().post(`/api/public/track/${token}/ping`), IPHONE, device).send({ lat: 34.05, lng: -118.24, accuracy: 10 })).status).toBe(200);
    const t = (await A.agent.get('/api/fleet')).body.trucks.find((x) => x.id === truck.id);
    expect(t.location.lat).toBeCloseTo(29.76, 2); // still Houston
    expect(t.live.confidence).toBe('low');
    expect(t.live.unverified).toMatchObject({ lat: 34.05, lng: -118.24 });
    expect(t.live.recentFlags[0]).toMatchObject({ type: 'impossible_jump' });
    const trail = (await A.agent.get(`/api/fleet/carriers/${truck.id}/trail?hours=24`)).body;
    expect(trail.skipped).toBe(1);
    expect(trail.items.every((p) => p.lat < 31)).toBe(true);
    const ping = await prisma.locationPing.findFirst({ where: { shareId }, orderBy: { at: 'desc' } });
    expect(ping.flags).toContain('impossible_jump');
    expect(await prisma.notification.findFirst({ where: { userId: A.user.id, title: { contains: 'Check' } } })).toBeTruthy();
    // a plausible fix near the real position moves the truck again
    await back(shareId);
    await as(pub().post(`/api/public/track/${token}/ping`), IPHONE, device).send({ lat: 29.8, lng: -95.4, accuracy: 10 });
    const t2 = (await A.agent.get('/api/fleet')).body.trucks.find((x) => x.id === truck.id);
    expect(t2.location.lat).toBeCloseTo(29.8, 2);
    expect(t2.live.unverified).toBeNull();
    expect(t2.live.confidence).toBe('low'); // jumped within the last hour
  });

  it('low accuracy, wrong clock and computers lower confidence', async () => {
    await back(shareId);
    await as(pub().post(`/api/public/track/${token}/ping`), IPHONE, device).send({ lat: 29.81, lng: -95.41, accuracy: 2500, clientTime: Date.now() - 3600_000 });
    const row = await prisma.locationShare.findUnique({ where: { id: shareId } });
    expect(row.lastPingFlags.split(',')).toEqual(expect.arrayContaining(['low_accuracy', 'stale_clock']));
    expect(trustFor(row).confidence).toBe('low');
    expect(trustFor(row).reasons.join(' ')).toMatch(/Low accuracy/);

    const desk = (await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ hours: 8, pin: false })).body;
    const consent = await as(pub().post(`/api/public/track/${tokenOf(desk.link)}/consent`), WINDOWS).send({ signals: { touch: false, coarse: false, width: 1920 } });
    expect(consent.status).toBe(200);
    const d = await prisma.locationShare.findUnique({ where: { id: desk.share.id } });
    expect(d.deviceKind).toBe('desktop');
    expect(trustFor(d).confidence).toBe('low');
    expect(trustFor(d).reasons).toContain('Shared from a computer, not a phone');
  });

  it('a loaded truck far from its lane is flagged', async () => {
    const lone = (await A.agent.post('/api/carriers').send({ companyName: 'Far Lane Trucking', state: 'TX', phone: '2145550199' })).body.carrier;
    const tr = (await A.agent.post('/api/fleet/trips').send({ carrierId: lone.id, origin: { city: 'Dallas', state: 'TX' }, dest: { city: 'Memphis', state: 'TN' }, rateCents: 200000 })).body.trip;
    await A.agent.post(`/api/fleet/trips/${tr.id}/status`).send({ status: 'booked' });
    await A.agent.post(`/api/fleet/trips/${tr.id}/status`).send({ status: 'in_transit' });
    const sh = (await A.agent.post(`/api/fleet/carriers/${lone.id}/share`).send({ hours: 8, pin: false, loadId: tr.id })).body;
    const dev = (await as(pub().post(`/api/public/track/${tokenOf(sh.link)}/consent`), ANDROID).send({ signals: { touch: true, coarse: true } })).body.deviceSecret;
    expect((await as(pub().post(`/api/public/track/${tokenOf(sh.link)}/ping`), ANDROID, dev).send({ lat: 39.74, lng: -104.99, accuracy: 8 })).status).toBe(200);
    const row = await prisma.locationShare.findUnique({ where: { id: sh.share.id } });
    expect(row.lastPingFlags).toContain('far_from_trip');
    expect(trustFor(row).confidence).toBe('low');
  });
});

describe('trust helpers', () => {
  it('describes devices and coarsens IPs', () => {
    expect(describeDevice(IPHONE)).toEqual({ label: 'iPhone · Safari', kind: 'mobile' });
    expect(describeDevice(WINDOWS, { touch: false, coarse: false })).toEqual({ label: 'Windows · Chrome', kind: 'desktop' });
    // iPadOS reports a Mac user agent; touch + coarse pointer means a tablet
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', { touch: true, coarse: true }).kind).toBe('mobile');
    expect(coarseIp('203.0.113.77')).toBe('203.0.113.x');
    expect(coarseIp('::ffff:198.51.100.9')).toBe('198.51.100.x');
    expect(coarseIp('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(coarseIp('2001:db8::7')).toBe('2001:db8:0::/48');
    expect(coarseIp('::1')).toBe('this server');
  });

  it('ignores GPS noise and flags real jumps', () => {
    const now = new Date();
    const ref = { lat: 32.78, lng: -96.8, at: new Date(now.getTime() - 15_000), accuracy: 30 };
    expect(evaluateFix({ fix: { lat: 32.785, lng: -96.805, accuracy: 30 }, reference: ref, now }).trusted).toBe(true);
    const jump = evaluateFix({ fix: { lat: 35.2, lng: -101.8, accuracy: 10 }, reference: ref, now });
    expect(jump.trusted).toBe(false);
    expect(jump.flags[0].type).toBe('impossible_jump');
    // 400 miles in 6 hours is fine
    const slow = evaluateFix({ fix: { lat: 35.2, lng: -101.8, accuracy: 10 }, reference: { ...ref, at: new Date(now.getTime() - 6 * 3600_000) }, now });
    expect(slow.trusted).toBe(true);
  });

  it('caps and de-duplicates flags', () => {
    let raw = '[]';
    for (let i = 0; i < 60; i++) raw = addFlags(raw, [{ type: 'other_device', detail: `d${i}` }]);
    expect(parseFlags(raw)).toHaveLength(50);
    const once = addFlags(addFlags('[]', [{ type: 'desktop', detail: 'x' }]), [{ type: 'desktop', detail: 'x' }]);
    expect(parseFlags(once)).toHaveLength(1);
  });
});
