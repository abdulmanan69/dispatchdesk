import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app, registerUser, prisma } from './helpers.js';
import { POD_LIMITS } from '../src/routes/track.js';

const pub = () => request(app);
const tokenOf = (link) => link.split('/track/')[1];
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const as = (req, device) => { let q = req.set('User-Agent', IPHONE); if (device) q = q.set('X-Track-Device', device); return q; };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);

/** POST a receipt image with form fields to the driver documents endpoint. */
function sendPod(token, device, fields) {
  let q = as(pub().post(`/api/public/track/${token}/documents`), device);
  for (const [k, v] of Object.entries(fields)) q = q.field(k, String(v));
  return q.attach('file', JPEG, { filename: 'pod-signed.jpg', contentType: 'image/jpeg' });
}

async function claim(token) {
  return (await as(pub().post(`/api/public/track/${token}/consent`)).send({ signals: { touch: true, coarse: true } })).body.deviceSecret;
}

describe('proof of delivery signed on the driver\'s phone', () => {
  let A; let truck; let trip; let token; let device;
  beforeAll(async () => {
    A = await registerUser({ name: 'Nora Diaz' });
    truck = (await A.agent.post('/api/carriers').send({ companyName: 'Blue Mesa Freight', state: 'AZ', phone: '6025550133' })).body.carrier;
    await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ truckStatus: 'available', location: { city: 'Phoenix', state: 'AZ' } });
    trip = (await A.agent.post('/api/fleet/trips').send({ carrierId: truck.id, origin: { city: 'Phoenix', state: 'AZ' }, dest: { city: 'El Paso', state: 'TX' }, rateCents: 180000, referenceNumber: 'BM-77' })).body.trip;
    await A.agent.post(`/api/fleet/trips/${trip.id}/status`).send({ status: 'booked' });
    const res = await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ driverName: 'Ray', hours: 24, loadId: trip.id, pin: false });
    token = tokenOf(res.body.link);
    device = await claim(token);
  });

  it('checks the signature fields strictly and stores nothing on a bad request', async () => {
    const before = await prisma.document.count({ where: { loadId: trip.id } });
    const cases = [
      { type: 'pod', receiverName: 'x'.repeat(POD_LIMITS.receiverName + 1) },
      { type: 'pod', receiverName: 'Ana Ruiz', receiverTitle: 'y'.repeat(POD_LIMITS.receiverTitle + 1) },
      { type: 'pod', receiverName: 'Ana Ruiz', pieces: 'z'.repeat(POD_LIMITS.pieces + 1) },
      { type: 'pod', receiverName: 'Ana Ruiz', exceptions: 'd'.repeat(POD_LIMITS.exceptions + 1) },
      { type: 'pod', receiverName: 'Ana\u0007Ruiz' },
      { type: 'pod', receiverName: 'Ana\nRuiz' },
      { type: 'pod', receiverName: 'Ana Ruiz', lat: 91, lng: 10 },
      { type: 'pod', receiverName: 'Ana Ruiz', signedAt: 'yesterday' },
      // Signature details without the receiver's name, or on something that is not a POD.
      { type: 'pod', exceptions: '2 cases short' },
      { type: 'bol', receiverName: 'Ana Ruiz' },
    ];
    for (const fields of cases) {
      const res = await sendPod(token, device, fields);
      expect(res.status, JSON.stringify(fields)).toBe(400);
    }
    expect(await prisma.document.count({ where: { loadId: trip.id } })).toBe(before);
    expect(await prisma.loadEvent.count({ where: { loadId: trip.id, type: 'pod_signed' } })).toBe(0);
    // Line breaks are fine in the exceptions, and blank optional fields are ignored.
    const ok = await sendPod(token, device, { type: 'pod', receiverName: 'Lee Wong', receiverTitle: '', pieces: ' ', exceptions: '1 pallet short\n2 cases crushed' });
    expect(ok.status).toBe(201);
    const ev = await prisma.loadEvent.findFirst({ where: { loadId: trip.id, type: 'pod_signed' } });
    expect(JSON.parse(ev.data)).toMatchObject({ receiverName: 'Lee Wong', receiverTitle: null, pieces: null, exceptions: '1 pallet short\n2 cases crushed' });
  });

  it('records a pod_signed event with the receiver, time and position, and notifies the dispatcher', async () => {
    const signedAt = Date.now() - 20 * 60_000; // signed without signal, sent later
    const res = await sendPod(token, device, {
      type: 'pod', loadId: trip.id, receiverName: '  Maria Lopez ', receiverTitle: 'Receiving clerk', pieces: '24 pallets', signedAt,
      lat: 31.7619, lng: -106.485, accuracy: 9,
    });
    expect(res.status).toBe(201);
    const doc = await prisma.document.findUnique({ where: { id: res.body.document.id } });
    expect(doc).toMatchObject({ type: 'pod', loadId: trip.id, source: 'driver_link', mimeType: 'image/jpeg' });
    expect(doc.originalName).toMatch(/^POD signed BM-77 /);
    const ev = await prisma.loadEvent.findFirst({ where: { loadId: trip.id, type: 'pod_signed', data: { contains: 'Maria Lopez' } } });
    expect(ev).toMatchObject({ source: 'driver_link', lat: 31.7619, lng: -106.485 });
    expect(ev.at.getTime()).toBe(signedAt);
    expect(ev.note).toBe('POD signed by Maria Lopez, Receiving clerk · 24 pallets');
    expect(JSON.parse(ev.data)).toMatchObject({
      documentId: doc.id, receiverName: 'Maria Lopez', receiverTitle: 'Receiving clerk', pieces: '24 pallets', exceptions: null, accuracyM: 9,
      signedAt: new Date(signedAt).toISOString(),
    });
    // The signed POD is one timeline entry, not also a plain document event.
    expect(await prisma.loadEvent.count({ where: { loadId: trip.id, type: 'document', data: { contains: doc.id } } })).toBe(0);
    const n = await prisma.notification.findFirst({ where: { userId: A.user.id, title: 'Ray sent a signed POD' }, orderBy: { createdAt: 'desc' } });
    expect(n).toMatchObject({ type: 'fleet' });
    expect(n.body).toContain('Received by Maria Lopez, Receiving clerk · 24 pallets');
    expect(n.body).toContain('ref BM-77');
    // Exceptions reach the dispatcher as a driver issue.
    expect(await prisma.notification.findFirst({ where: { userId: A.user.id, type: 'fleet_issue', title: 'Ray: POD signed with exceptions' } })).toBeTruthy();
  });

  it('ignores an implausible phone time and uses the server time', async () => {
    const res = await sendPod(token, device, { type: 'pod', receiverName: 'Future Person', signedAt: Date.now() + 3 * 86400000 });
    expect(res.status).toBe(201);
    const ev = await prisma.loadEvent.findFirst({ where: { loadId: trip.id, type: 'pod_signed', data: { contains: 'Future Person' } } });
    expect(Math.abs(ev.at.getTime() - Date.now())).toBeLessThan(60_000);
    expect(ev.lat).toBeNull();
  });

  it('a double tap or a retried upload within two minutes is one signed POD', async () => {
    const fields = { type: 'pod', receiverName: 'Sam Ortiz', pieces: '10', signedAt: Date.now() };
    const first = await sendPod(token, device, fields);
    expect(first.status).toBe(201);
    const docs = await prisma.document.count({ where: { loadId: trip.id } });
    const notes = await prisma.notification.count({ where: { userId: A.user.id, title: 'Ray sent a signed POD' } });
    const again = await sendPod(token, device, { ...fields, receiverName: 'sam ortiz' });
    expect(again.status).toBe(200);
    expect(again.body.repeat).toBe(true);
    expect(again.body.document.id).toBe(first.body.document.id);
    expect(await prisma.document.count({ where: { loadId: trip.id } })).toBe(docs);
    expect(await prisma.loadEvent.count({ where: { loadId: trip.id, type: 'pod_signed', data: { contains: 'Sam Ortiz' } } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: A.user.id, title: 'Ray sent a signed POD' } })).toBe(notes);
    // Another receiver is another signature.
    expect((await sendPod(token, device, { type: 'pod', receiverName: 'Dee Park' })).status).toBe(201);
    // After the window the same receiver can sign again.
    await prisma.loadEvent.updateMany({ where: { loadId: trip.id, type: 'pod_signed', data: { contains: 'Sam Ortiz' } }, data: { createdAt: new Date(Date.now() - 3 * 60_000) } });
    expect((await sendPod(token, device, fields)).status).toBe(201);
  });

  it('needs the phone that claimed the link', async () => {
    const res = await sendPod(token, 'not-the-right-device-secret-123', { type: 'pod', receiverName: 'Ana Ruiz' });
    expect(res.status).toBe(409);
  });
});

describe('consolidated stops on the driver page', () => {
  let A; let B; let truck; let other; let loadA; let loadB; let loadC; let foreign; let cons; let token; let device;
  const mkTrip = async (agent, carrierId, origin, dest, ref, extra = {}) => {
    const t = (await agent.post('/api/fleet/trips').send({ carrierId, origin, dest, rateCents: 123456, referenceNumber: ref })).body.trip;
    await agent.post(`/api/fleet/trips/${t.id}/status`).send({ status: 'booked' });
    if (Object.keys(extra).length) await prisma.load.update({ where: { id: t.id }, data: extra });
    return t;
  };

  beforeAll(async () => {
    A = await registerUser({ name: 'Ivy Chen' });
    B = await registerUser({ name: 'Other Dispatcher' });
    truck = (await A.agent.post('/api/carriers').send({ companyName: 'Granite Peak Hauling', state: 'CO' })).body.carrier;
    other = (await A.agent.post('/api/carriers').send({ companyName: 'Second Truck LLC', state: 'CO' })).body.carrier;
    const brokerB = await prisma.broker.create({ data: { ownerId: A.user.id, companyName: 'Secret Broker Brothers' } });
    await A.agent.patch(`/api/fleet/carriers/${truck.id}`).send({ truckStatus: 'available', location: { city: 'Denver', state: 'CO' } });
    const day = 86400000;
    loadA = await mkTrip(A.agent, truck.id, { city: 'Denver', state: 'CO' }, { city: 'Omaha', state: 'NE' }, 'GP-A', {
      pickupFacility: 'Front Range Foods DC', pickupAddress: '100 Dock Rd', deliveryFacility: 'Omaha Grocers', deliveryAddress: '9 Market St',
      deliveryTz: 'America/Chicago', deliveryWindowStart: new Date(Date.now() + 2 * day), deliveryWindowEnd: new Date(Date.now() + 2 * day + 7200_000),
      pickupDate: new Date(Date.now() + 3600_000),
    });
    loadB = await mkTrip(A.agent, truck.id, { city: 'Boulder', state: 'CO' }, { city: 'Lincoln', state: 'NE' }, 'GP-B', {
      pickupFacility: 'Flatiron Paper', deliveryFacility: 'Lincoln Office Supply', deliveryAddress: '55 O St', brokerId: brokerB.id,
      pickupDate: new Date(Date.now() + 2 * 3600_000), notes: 'internal note: margin is thin',
    });
    loadC = await mkTrip(A.agent, other.id, { city: 'Pueblo', state: 'CO' }, { city: 'Wichita', state: 'KS' }, 'GP-C');
    const otherTruckB = (await B.agent.post('/api/carriers').send({ companyName: 'Elsewhere Inc', state: 'TX' })).body.carrier;
    foreign = await mkTrip(B.agent, otherTruckB.id, { city: 'Austin', state: 'TX' }, { city: 'Waco', state: 'TX' }, 'X-1');
    // Pickups first (B, then A), then deliveries (A, then B).
    cons = await prisma.consolidation.create({
      data: {
        ownerId: A.user.id, carrierId: truck.id,
        stops: JSON.stringify([{ loadId: loadB.id, kind: 'pickup' }, { loadId: loadA.id, kind: 'pickup' }, { loadId: loadA.id, kind: 'delivery' }, { loadId: loadB.id, kind: 'delivery' }]),
      },
    });
    await prisma.load.updateMany({ where: { id: { in: [loadA.id, loadB.id] } }, data: { consolidationId: cons.id } });
    const sh = (await A.agent.post(`/api/fleet/carriers/${truck.id}/share`).send({ driverName: 'Jo', hours: 24, loadId: loadA.id, pin: false })).body;
    token = tokenOf(sh.link);
    device = await claim(token);
  });

  it('lists every stop in the consolidation order with only stop details', async () => {
    const res = await as(pub().get(`/api/public/track/${token}`), device);
    expect(res.status).toBe(200);
    const stops = res.body.trip.consolidation.stops;
    expect(stops.map((s) => `${s.loadId === loadA.id ? 'A' : 'B'}:${s.kind}`)).toEqual(['B:pickup', 'A:pickup', 'A:delivery', 'B:delivery']);
    expect(stops[0]).toMatchObject({ referenceNumber: 'GP-B', status: 'booked', facility: 'Flatiron Paper', city: 'Boulder', state: 'CO' });
    expect(stops[2]).toMatchObject({ facility: 'Omaha Grocers', address: '9 Market St', tz: 'America/Chicago' });
    expect(stops[2].windowStart).toBeTruthy();
    expect(Object.keys(stops[0]).sort()).toEqual(['address', 'city', 'date', 'facility', 'kind', 'lat', 'lng', 'loadId', 'referenceNumber', 'state', 'status', 'tz', 'windowEnd', 'windowStart']);
    // Data minimization: no rates, broker or internal notes anywhere in the public payload.
    const raw = JSON.stringify(res.body);
    for (const secret of ['rateCents', '123456', 'brokerId', 'Secret Broker Brothers', 'margin is thin', 'dispatchFee', 'otherCosts']) expect(raw).not.toContain(secret);
  });

  it('a stop that leaves the stop list or is canceled drops out; a lone load is not shown as consolidated', async () => {
    await prisma.consolidation.update({ where: { id: cons.id }, data: { stops: JSON.stringify([{ loadId: loadA.id, kind: 'pickup' }, { loadId: 'nope', kind: 'pickup' }, { loadId: loadA.id, kind: 'teleport' }]) } });
    let stops = (await as(pub().get(`/api/public/track/${token}`), device)).body.trip.consolidation.stops;
    // Loads the list misses still show, after the listed ones.
    expect(stops.map((s) => `${s.loadId === loadA.id ? 'A' : 'B'}:${s.kind}`)).toEqual(['A:pickup', 'A:delivery', 'B:pickup', 'B:delivery']);
    await prisma.load.update({ where: { id: loadB.id }, data: { status: 'canceled' } });
    expect((await as(pub().get(`/api/public/track/${token}`), device)).body.trip.consolidation).toBeNull();
    await prisma.load.update({ where: { id: loadB.id }, data: { status: 'booked' } });
    await prisma.consolidation.update({ where: { id: cons.id }, data: { stops: 'not json' } });
    stops = (await as(pub().get(`/api/public/track/${token}`), device)).body.trip.consolidation.stops;
    expect(stops).toHaveLength(4);
    await prisma.consolidation.update({ where: { id: cons.id }, data: { stops: JSON.stringify([{ loadId: loadB.id, kind: 'pickup' }, { loadId: loadA.id, kind: 'pickup' }, { loadId: loadA.id, kind: 'delivery' }, { loadId: loadB.id, kind: 'delivery' }]) } });
  });

  it('check-ins and photos apply to a sibling stop of the same consolidation', async () => {
    const res = await as(pub().post(`/api/public/track/${token}/checkin`), device).send({ event: 'loaded', loadId: loadB.id });
    expect(res.status).toBe(200);
    expect(res.body.tripStatus).toBe('in_transit');
    expect((await prisma.load.findUnique({ where: { id: loadB.id } })).status).toBe('in_transit');
    expect((await prisma.load.findUnique({ where: { id: loadA.id } })).status).toBe('booked');
    expect(await prisma.loadEvent.findFirst({ where: { loadId: loadB.id, type: 'loaded', source: 'driver_link' } })).toBeTruthy();
    const pod = await sendPod(token, device, { type: 'pod', loadId: loadB.id, receiverName: 'Pat Kim' });
    expect(pod.status).toBe(201);
    expect((await prisma.document.findUnique({ where: { id: pod.body.document.id } })).loadId).toBe(loadB.id);
    expect(await prisma.loadEvent.findFirst({ where: { loadId: loadB.id, type: 'pod_signed' } })).toBeTruthy();
  });

  it('delivering one stop keeps the truck on the trip while other stops are ahead', async () => {
    expect((await as(pub().post(`/api/public/track/${token}/checkin`), device).send({ event: 'delivered', loadId: loadB.id })).status).toBe(200);
    expect((await prisma.carrier.findUnique({ where: { id: truck.id } })).truckStatus).toBe('loaded');
    await as(pub().post(`/api/public/track/${token}/checkin`), device).send({ event: 'loaded', loadId: loadA.id });
    expect((await as(pub().post(`/api/public/track/${token}/checkin`), device).send({ event: 'delivered', loadId: loadA.id })).status).toBe(200);
    expect((await prisma.carrier.findUnique({ where: { id: truck.id } })).truckStatus).toBe('available');
    const stops = (await as(pub().get(`/api/public/track/${token}`), device)).body.trip.consolidation.stops;
    expect(stops.every((s) => s.status === 'delivered')).toBe(true);
  });

  it('refuses loads outside the consolidation: 403 for this dispatcher\'s other loads, 404 for anyone else\'s', async () => {
    const before = await prisma.loadEvent.count({ where: { loadId: { in: [loadC.id, foreign.id] } } });
    const other = await as(pub().post(`/api/public/track/${token}/checkin`), device).send({ event: 'arrived_pickup', loadId: loadC.id });
    expect(other.status).toBe(403);
    expect(other.body.details.code).toBe('STOP_NOT_ON_TRIP');
    const notMine = await as(pub().post(`/api/public/track/${token}/checkin`), device).send({ event: 'arrived_pickup', loadId: foreign.id });
    expect(notMine.status).toBe(404);
    expect((await as(pub().post(`/api/public/track/${token}/checkin`), device).send({ event: 'arrived_pickup', loadId: 'does-not-exist' })).status).toBe(404);
    // Same consolidation id but on another truck: still refused.
    await prisma.load.update({ where: { id: loadC.id }, data: { consolidationId: cons.id } });
    expect((await as(pub().post(`/api/public/track/${token}/checkin`), device).send({ event: 'arrived_pickup', loadId: loadC.id })).status).toBe(403);
    await prisma.load.update({ where: { id: loadC.id }, data: { consolidationId: null } });
    expect((await sendPod(token, device, { type: 'pod', loadId: loadC.id, receiverName: 'Pat Kim' })).status).toBe(403);
    expect((await sendPod(token, device, { type: 'bol', loadId: foreign.id })).status).toBe(404);
    expect(await prisma.loadEvent.count({ where: { loadId: { in: [loadC.id, foreign.id] } } })).toBe(before);
    expect(await prisma.document.count({ where: { loadId: { in: [loadC.id, foreign.id] } } })).toBe(0);
  });
});
