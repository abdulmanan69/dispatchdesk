import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app, registerUser, prisma } from './helpers.js';
import { config } from '../src/config.js';
import { clearLiveCache } from '../src/services/market/live.js';
import { encodePolyline, segmentMiles } from '../src/services/fleet/polyline.js';
import { MAX_DOCS_PER_DAY } from '../src/routes/track.js';

const pub = () => request(app);
const tokenOf = (link) => link.split('/track/')[1];
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const as = (req, ua, device) => { let q = req.set('User-Agent', ua); if (device) q = q.set('X-Track-Device', device); return q; };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1000, 32), Buffer.from('\n%%EOF')]);
const back = async (id, ms = 10 * 60_000) => {
  const s = await prisma.locationShare.findUnique({ where: { id } });
  await prisma.locationShare.update({ where: { id }, data: { lastAt: new Date(Date.now() - ms), ...(s.trustedAt ? { trustedAt: new Date(Date.now() - ms) } : {}) } });
};

describe('driver documents, hours and check-in events', () => {
  let A; let truck; let trip; let token; let device; let shareId;
  beforeAll(async () => {
    A = await registerUser({ name: 'Lena Park' });
    truck = (await A.agent.post('/api/carriers').send({ companyName: 'Cedar Creek Carriers', state: 'TX', phone: '2145550188' })).body.carrier;
    await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ truckStatus: 'available', location: { city: 'Dallas', state: 'TX' } });
    trip = (await A.agent.post('/api/fleet/trips').send({ carrierId: truck.id, origin: { city: 'Dallas', state: 'TX' }, dest: { city: 'Memphis', state: 'TN' }, rateCents: 200000, referenceNumber: 'CC-55' })).body.trip;
    await A.agent.post(`/api/fleet/trips/${trip.id}/status`).send({ status: 'booked' });
    const res = await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ driverName: 'Sam', hours: 24, loadId: trip.id, pin: false });
    token = tokenOf(res.body.link);
    shareId = res.body.share.id;
  });

  it('documents need the claimed phone', async () => {
    const unclaimed = await pub().post(`/api/public/track/${token}/documents`).field('type', 'pod').attach('file', JPEG, { filename: 'pod.jpg', contentType: 'image/jpeg' });
    expect(unclaimed.status).toBe(409);
    expect(unclaimed.body.details.code).toBe('CONSENT_REQUIRED');
    device = (await as(pub().post(`/api/public/track/${token}/consent`), IPHONE).send({ signals: { touch: true, coarse: true } })).body.deviceSecret;
    const other = await as(pub().post(`/api/public/track/${token}/documents`), ANDROID, 'not-the-right-device-secret-123').field('type', 'pod').attach('file', JPEG, { filename: 'pod.jpg', contentType: 'image/jpeg' });
    expect(other.status).toBe(409);
    expect(other.body.details.code).toBe('DEVICE_MISMATCH');
  });

  it('a photo lands on the load as the dispatcher\'s document, on the timeline, with a notification', async () => {
    const res = await as(pub().post(`/api/public/track/${token}/documents`), IPHONE, device).field('type', 'bol').field('pages', '1').attach('file', JPEG, { filename: 'bol.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    expect(res.body.document).toMatchObject({ type: 'bol' });
    expect(res.body.uploadsLeft).toBe(MAX_DOCS_PER_DAY - 1);
    const doc = await prisma.document.findUnique({ where: { id: res.body.document.id } });
    expect(doc).toMatchObject({ ownerId: A.user.id, uploadedById: A.user.id, loadId: trip.id, carrierId: null, source: 'driver_link', mimeType: 'image/jpeg' });
    expect(doc.originalName).toMatch(/^BOL CC-55 \d{4}-\d{2}-\d{2} /);
    expect(fs.existsSync(path.join(config.uploadDir, 'documents', doc.storedName))).toBe(true);
    const ev = await prisma.loadEvent.findFirst({ where: { loadId: trip.id, type: 'document' } });
    expect(JSON.parse(ev.data)).toMatchObject({ documentId: doc.id, type: 'bol', pages: 1 });
    expect(await prisma.notification.findFirst({ where: { userId: A.user.id, title: { contains: 'Sam sent a BOL' } } })).toBeTruthy();
    // The dispatcher can open it like any load document.
    const list = (await A.agent.get(`/api/documents?loadId=${trip.id}`)).body.items;
    expect(list.map((d) => d.id)).toContain(doc.id);
    expect((await A.agent.get(`/api/documents/${doc.id}/download`)).status).toBe(200);
  });

  it('multi-page scans arrive as one PDF; types, extensions and contents are checked', async () => {
    const pdf = await as(pub().post(`/api/public/track/${token}/documents`), IPHONE, device).field('type', 'pod').field('pages', '3').attach('file', PDF, { filename: 'pod.pdf', contentType: 'application/pdf' });
    expect(pdf.status).toBe(201);
    expect(await prisma.notification.findFirst({ where: { userId: A.user.id, title: { contains: 'POD (3 pages)' } } })).toBeTruthy();
    const fake = await as(pub().post(`/api/public/track/${token}/documents`), IPHONE, device).field('type', 'pod').attach('file', Buffer.from('<html>not a photo</html>'), { filename: 'pod.jpg', contentType: 'image/jpeg' });
    expect(fake.status).toBe(400);
    const exe = await as(pub().post(`/api/public/track/${token}/documents`), IPHONE, device).field('type', 'pod').attach('file', Buffer.from('MZ'), { filename: 'run.exe', contentType: 'application/octet-stream' });
    expect(exe.status).toBe(400);
    const badType = await as(pub().post(`/api/public/track/${token}/documents`), IPHONE, device).field('type', 'selfie').attach('file', JPEG, { filename: 'x.jpg', contentType: 'image/jpeg' });
    expect(badType.status).toBe(400);
    expect(await prisma.document.count({ where: { loadId: trip.id, source: 'driver_link' } })).toBe(2);
  });

  it('caps uploads per link and day', async () => {
    const used = await prisma.document.count({ where: { loadId: trip.id, source: 'driver_link' } });
    const rows = Array.from({ length: MAX_DOCS_PER_DAY - used }, (_, i) => ({
      ownerId: A.user.id, uploadedById: A.user.id, loadId: trip.id, type: 'other', originalName: `x${i}.jpg`, storedName: `cap-${Date.now()}-${i}.jpg`, mimeType: 'image/jpeg', sizeBytes: 10, source: 'driver_link',
    }));
    await prisma.document.createMany({ data: rows });
    const res = await as(pub().post(`/api/public/track/${token}/documents`), IPHONE, device).field('type', 'pod').attach('file', JPEG, { filename: 'pod.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(429);
    expect(res.body.details.code).toBe('UPLOAD_CAP');
    expect((await as(pub().get(`/api/public/track/${token}`), IPHONE, device)).body.uploads.left).toBe(0);
    await prisma.document.deleteMany({ where: { storedName: { startsWith: 'cap-' } } });
  });

  it('hours left from the driver feed the legal ETA', async () => {
    const res = await as(pub().post(`/api/public/track/${token}/hours`), IPHONE, device).send({ driveLeftMin: 420, shiftLeftMin: 600, cycleLeftMin: 2400 });
    expect(res.status).toBe(201);
    const ev = await prisma.loadEvent.findFirst({ where: { loadId: trip.id, type: 'note', source: 'driver_link' } });
    expect(JSON.parse(ev.data).hos).toEqual({ driveLeftMin: 420, shiftLeftMin: 600, cycleLeftMin: 2400 });
    expect((await as(pub().post(`/api/public/track/${token}/hours`), IPHONE, device).send({})).status).toBe(400);
    expect((await as(pub().post(`/api/public/track/${token}/hours`), IPHONE, device).send({ driveLeftMin: 999 })).status).toBe(400);
    expect((await as(pub().post(`/api/public/track/${token}/hours`), ANDROID, 'wrong-device-secret-abcdefgh').send({ driveLeftMin: 60 })).status).toBe(409);
    const plan = (await A.agent.get(`/api/fleet/carriers/${truck.id}/plan`)).body;
    expect(plan.hosReport).toMatchObject({ source: 'driver_link', input: { driveLeftMin: 420 } });
  });

  it('check-ins are stored as load events with where they happened', async () => {
    const arrived = await as(pub().post(`/api/public/track/${token}/checkin`), IPHONE, device).send({ event: 'arrived_pickup', lat: 32.78, lng: -96.8, accuracy: 12 });
    expect(arrived.status).toBe(200);
    const loaded = await as(pub().post(`/api/public/track/${token}/checkin`), IPHONE, device).send({ event: 'loaded' });
    expect(loaded.body.tripStatus).toBe('in_transit');
    const events = await prisma.loadEvent.findMany({ where: { loadId: trip.id }, orderBy: { at: 'asc' } });
    const a = events.find((e) => e.type === 'arrived_pickup');
    expect(a).toMatchObject({ source: 'driver_link', lat: 32.78, lng: -96.8 });
    expect(events.find((e) => e.type === 'loaded')).toBeTruthy();
    expect(events.some((e) => e.type === 'status' && JSON.parse(e.data).to === 'in_transit' && e.source === 'driver_link')).toBe(true);
    const act = await prisma.activity.findFirst({ where: { carrierId: truck.id, type: 'checkin' }, orderBy: { createdAt: 'desc' } });
    expect(JSON.parse(act.metadata)).toMatchObject({ event: 'loaded', loadId: trip.id });
  });

  it('a POD sent after "Delivered" stays with the delivered trip on a link without a fixed trip', async () => {
    const t2 = (await A.agent.post('/api/carriers').send({ companyName: 'Two Loads Trucking', state: 'TX' })).body.carrier;
    await A.agent.patch(`/api/fleet/carriers/${t2.id}`).send({ truckStatus: 'available', location: { city: 'Dallas', state: 'TX' } });
    const soon = new Date(Date.now() + 3600_000).toISOString();
    const later = new Date(Date.now() + 3 * 86400000).toISOString();
    const first = (await A.agent.post('/api/fleet/trips').send({ carrierId: t2.id, origin: { city: 'Dallas', state: 'TX' }, dest: { city: 'Houston', state: 'TX' }, rateCents: 90000, pickupDate: soon, status: 'booked' })).body.trip;
    const second = (await A.agent.post('/api/fleet/trips').send({ carrierId: t2.id, origin: { city: 'Houston', state: 'TX' }, dest: { city: 'Atlanta', state: 'GA' }, rateCents: 150000, pickupDate: later })).body.trip;
    const sh = (await A.agent.post(`/api/fleet/carriers/${t2.id}/share`).send({ hours: 24, pin: false })).body;
    const tok = tokenOf(sh.link);
    const dev = (await as(pub().post(`/api/public/track/${tok}/consent`), IPHONE).send({ signals: { touch: true, coarse: true } })).body.deviceSecret;
    expect((await as(pub().get(`/api/public/track/${tok}`), IPHONE, dev)).body.trip.id).toBe(first.id);
    for (const event of ['loaded', 'delivered']) expect((await as(pub().post(`/api/public/track/${tok}/checkin`), IPHONE, dev).send({ event, loadId: first.id })).status).toBe(200);
    // A double tap on Delivered (the page sends the trip it shows) is one check-in: it never delivers the next trip and
    // sends no second notification.
    expect((await as(pub().post(`/api/public/track/${tok}/checkin`), IPHONE, dev).send({ event: 'delivered', loadId: first.id })).body.repeat).toBe(true);
    expect((await prisma.load.findUnique({ where: { id: second.id } })).status).toBe('planned');
    expect(await prisma.notification.count({ where: { userId: A.user.id, title: { contains: 'Two Loads Trucking: Delivered' } } })).toBe(1);
    // The link has moved on to the next trip, but the page still showed the delivered one when the photo was taken.
    expect((await as(pub().get(`/api/public/track/${tok}`), IPHONE, dev)).body.trip.id).toBe(second.id);
    const pod = await as(pub().post(`/api/public/track/${tok}/documents`), IPHONE, dev).field('type', 'pod').field('loadId', first.id).attach('file', JPEG, { filename: 'pod.jpg', contentType: 'image/jpeg' });
    expect(pod.status).toBe(201);
    expect((await prisma.document.findUnique({ where: { id: pod.body.document.id } })).loadId).toBe(first.id);
    // Another truck's load is never a target: the file goes to the link's current trip.
    const bol = await as(pub().post(`/api/public/track/${tok}/documents`), IPHONE, dev).field('type', 'bol').field('loadId', trip.id).attach('file', JPEG, { filename: 'bol.jpg', contentType: 'image/jpeg' });
    expect(bol.status).toBe(201);
    expect((await prisma.document.findUnique({ where: { id: bol.body.document.id } })).loadId).toBe(second.id);
  });

  it('documents without a trip attach to the carrier', async () => {
    const solo = (await A.agent.post('/api/carriers').send({ companyName: 'No Trip Trucking', state: 'TX' })).body.carrier;
    const sh = (await A.agent.post(`/api/fleet/carriers/${solo.id}/share`).send({ hours: 8, pin: false })).body;
    const dev = (await as(pub().post(`/api/public/track/${tokenOf(sh.link)}/consent`), ANDROID).send({ signals: { touch: true, coarse: true } })).body.deviceSecret;
    const res = await as(pub().post(`/api/public/track/${tokenOf(sh.link)}/documents`), ANDROID, dev).field('type', 'lumper_receipt').attach('file', JPEG, { filename: 'r.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    expect(await prisma.document.findUnique({ where: { id: res.body.document.id } })).toMatchObject({ carrierId: solo.id, loadId: null, type: 'lumper_receipt' });
    expect((await as(pub().post(`/api/public/track/${tokenOf(sh.link)}/hours`), ANDROID, dev).send({ driveLeftMin: 60 })).status).toBe(400);
  });
});

describe('off-route detection on the road route', () => {
  let A; let truck; let trip; let token; let device; let shareId;
  afterEach(() => vi.unstubAllGlobals());
  beforeAll(async () => {
    A = await registerUser({ name: 'Kai West' });
    truck = (await A.agent.post('/api/carriers').send({ companyName: 'Off Lane Freight', state: 'TX', phone: '2145550166' })).body.carrier;
    await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ truckStatus: 'available', location: { city: 'Dallas', state: 'TX' } });
    // Dallas -> Texarkana -> Memphis road route from the (stubbed) router.
    const corners = [[-96.797, 32.777], [-94.048, 33.425], [-90.049, 35.15]];
    const pts = [corners[0]];
    for (let i = 1; i < corners.length; i++) {
      const n = Math.round(segmentMiles(corners[i - 1], corners[i]) / 1.5);
      for (let k = 1; k <= n; k++) pts.push([corners[i - 1][0] + ((corners[i][0] - corners[i - 1][0]) * k) / n, corners[i - 1][1] + ((corners[i][1] - corners[i - 1][1]) * k) / n]);
    }
    clearLiveCache();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [{ distance: 452 * 1609.344, duration: 410 * 60, geometry: encodePolyline(pts) }] }) })));
    trip = (await A.agent.post('/api/fleet/trips').send({ carrierId: truck.id, origin: { city: 'Dallas', state: 'TX' }, dest: { city: 'Memphis', state: 'TN' }, rateCents: 200000 })).body.trip;
    vi.unstubAllGlobals();
    expect(trip.route.source).toBe('osrm');
    await A.agent.post(`/api/fleet/trips/${trip.id}/status`).send({ status: 'booked' });
    await A.agent.post(`/api/fleet/trips/${trip.id}/status`).send({ status: 'in_transit' });
    const res = await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ driverName: 'Jo', hours: 24, loadId: trip.id, pin: false });
    token = tokenOf(res.body.link);
    shareId = res.body.share.id;
    device = (await as(pub().post(`/api/public/track/${token}/consent`), IPHONE).send({ signals: { touch: true, coarse: true } })).body.deviceSecret;
  });

  const ping = (lat, lng) => as(pub().post(`/api/public/track/${token}/ping`), IPHONE, device).send({ lat, lng, accuracy: 10, clientTime: Date.now() });

  it('two fixes off the road route alert the dispatcher once; back on route ends it', async () => {
    // The dispatcher last placed the truck near Texarkana; the first fix is on the route there.
    await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ location: { city: 'Texarkana', state: 'TX', lat: 33.43, lng: -94.05 } });
    expect((await ping(33.43, -94.05)).status).toBe(200);
    let row = await prisma.locationShare.findUnique({ where: { id: shareId } });
    expect(row.lastPingFlags || '').not.toContain('off_route');
    // ~20 miles north of the route, twice (half an hour apart, a plausible detour).
    await back(shareId, 30 * 60_000);
    await ping(33.72, -94.05);
    row = await prisma.locationShare.findUnique({ where: { id: shareId } });
    expect(row.lastPingFlags).toContain('off_route');
    expect(await prisma.notification.count({ where: { userId: A.user.id, title: { contains: 'off the planned route' } } })).toBe(0);
    await back(shareId, 30 * 60_000);
    await ping(33.73, -94.05);
    expect(await prisma.notification.count({ where: { userId: A.user.id, title: { contains: 'off the planned route' } } })).toBe(1);
    const ev = await prisma.loadEvent.findFirst({ where: { loadId: trip.id, type: 'issue', source: 'system' } });
    expect(JSON.parse(ev.data)).toMatchObject({ kind: 'off_route' });
    await back(shareId, 30 * 60_000);
    await ping(33.74, -94.05);
    expect(await prisma.notification.count({ where: { userId: A.user.id, title: { contains: 'off the planned route' } } })).toBe(1);
    // Trust is not lowered by a detour, only by implausible positions.
    const t = (await A.agent.get('/api/fleet')).body.trucks.find((x) => x.id === truck.id);
    expect(t.live.confidence).not.toBe('low');
    expect(t.plan.progress.offRoute).toBe(true);
    // Back on the route.
    await back(shareId, 30 * 60_000);
    await ping(33.43, -94.05);
    row = await prisma.locationShare.findUnique({ where: { id: shareId } });
    expect(row.lastPingFlags || '').not.toContain('off_route');
    const pingRow = await prisma.locationPing.findFirst({ where: { shareId, flags: { contains: 'off_route' } } });
    expect(pingRow).toBeTruthy();
  });
});
