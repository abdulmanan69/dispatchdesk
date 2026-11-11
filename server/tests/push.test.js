import crypto from 'node:crypto';
import request from 'supertest';
import { generateVAPIDKeys } from 'web-push';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { app, registerUser, agent, prisma } from './helpers.js';
import { notify } from '../src/lib/activity.js';
import {
  setPushTransport, flushPushQueue, resetPushForTests, getVapidKeys, validEndpoint, validKeys, MAX_DEVICES, MAX_FAILURES,
} from '../src/services/push.js';

const browserKeys = () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
};
let seq = 0;
const endpoint = (host = 'fcm.googleapis.com') => `https://${host}/fcm/send/test-${Date.now()}-${++seq}`;

/** Capture sends; `fail` maps endpoint -> HTTP status to reject with. */
function fakeTransport() {
  const sent = [];
  const fail = new Map();
  setPushTransport(async (sub, payload, options) => {
    const status = fail.get(sub.endpoint);
    if (status) {
      const err = new Error('Received unexpected response code');
      err.statusCode = status;
      throw err;
    }
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), options });
    return { statusCode: 201 };
  });
  return { sent, fail };
}

async function subscribe(a, ep = endpoint(), keys = browserKeys()) {
  const res = await a.post('/api/push/subscriptions').set('User-Agent', 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile').send({ endpoint: ep, keys });
  return { res, endpoint: ep };
}

beforeEach(() => { resetPushForTests(); setPushTransport(null); });
afterAll(() => { setPushTransport(null); resetPushForTests(); });

describe('push: VAPID keys', () => {
  it('generates one key pair, stores the private key encrypted and returns the same public key', async () => {
    const A = await registerUser();
    const r1 = await A.agent.get('/api/push/vapid-public-key');
    expect(r1.status).toBe(200);
    expect(Buffer.from(r1.body.publicKey, 'base64url').length).toBe(65);
    const row = await prisma.systemSetting.findUnique({ where: { key: 'push.vapid' } });
    expect(row.secret).toBe(true);
    expect(row.value.startsWith('v1.')).toBe(true);
    expect(row.value).not.toContain(r1.body.publicKey);
    resetPushForTests(); // a new process reads the stored keys
    const r2 = await A.agent.get('/api/push/vapid-public-key');
    expect(r2.body.publicKey).toBe(r1.body.publicKey);
  });

  it('uses VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY from the environment when both are set', async () => {
    const env = generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = env.publicKey;
    process.env.VAPID_PRIVATE_KEY = env.privateKey;
    try {
      resetPushForTests();
      const keys = await getVapidKeys();
      expect(keys.publicKey).toBe(process.env.VAPID_PUBLIC_KEY);
      expect(keys.source).toBe('environment');
      expect(keys.subject).toMatch(/^(mailto:|https:\/\/)/);
    } finally {
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
      resetPushForTests();
    }
  });
});

describe('push: endpoint and key validation', () => {
  it('accepts only https endpoints of known push services', () => {
    expect(validEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(validEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(validEndpoint('https://web.push.apple.com/QK7abc')).toBe(true);
    expect(validEndpoint('https://wns2-par02p.notify.windows.com/w/?token=abc')).toBe(true);
    expect(validEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(validEndpoint('https://fcm.googleapis.com:8443/fcm/send/abc')).toBe(false);
    expect(validEndpoint('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(validEndpoint('https://localhost/push')).toBe(false);
    expect(validEndpoint('https://fcm.googleapis.com.evil.example/x')).toBe(false);
    expect(validEndpoint('https://user:pw@fcm.googleapis.com/x')).toBe(false);
    expect(validEndpoint('not a url')).toBe(false);
  });

  it('checks the p256dh point and auth secret sizes', () => {
    expect(validKeys(browserKeys())).toBe(true);
    expect(validKeys({ p256dh: 'abc', auth: crypto.randomBytes(16).toString('base64url') })).toBe(false);
    expect(validKeys({ p256dh: browserKeys().p256dh, auth: 'short' })).toBe(false);
    expect(validKeys({ p256dh: '<script>', auth: '"' })).toBe(false);
    expect(validKeys(null)).toBe(false);
  });

  it('rejects bad subscriptions with 400', async () => {
    const A = await registerUser();
    const bad = [
      { endpoint: 'http://fcm.googleapis.com/fcm/send/x', keys: browserKeys() },
      { endpoint: 'https://internal.example/push', keys: browserKeys() },
      { endpoint: endpoint(), keys: { p256dh: 'nope', auth: 'nope' } },
      { endpoint: endpoint() },
      {},
    ];
    for (const body of bad) expect((await A.agent.post('/api/push/subscriptions').send(body)).status).toBe(400);
    expect((await A.agent.get('/api/push/subscriptions')).body.items).toHaveLength(0);
  });
});

describe('push: devices', () => {
  it('saves, lists (without endpoints), re-saves idempotently and removes devices', async () => {
    const A = await registerUser();
    const { res, endpoint: ep } = await subscribe(A.agent);
    expect(res.status).toBe(201);
    const again = await A.agent.post('/api/push/subscriptions').send({ endpoint: ep, keys: browserKeys() });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(res.body.id);
    const list = await A.agent.get('/api/push/subscriptions');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.max).toBe(MAX_DEVICES);
    expect(list.body.notifyPush).toBe(true);
    expect(list.body.items[0].userAgent).toContain('Android');
    expect(JSON.stringify(list.body)).not.toContain(ep);

    const byEndpoint = await A.agent.delete('/api/push/subscriptions').send({ endpoint: ep });
    expect(byEndpoint.body.removed).toBe(1);
    const { res: second } = await subscribe(A.agent);
    expect((await A.agent.delete(`/api/push/subscriptions/${second.body.id}`)).status).toBe(200);
    expect((await A.agent.get('/api/push/subscriptions')).body.items).toHaveLength(0);
  });

  it('keeps other users out: 404 on their devices, separate lists', async () => {
    const A = await registerUser();
    const B = await registerUser();
    const { res } = await subscribe(A.agent);
    expect((await B.agent.delete(`/api/push/subscriptions/${res.body.id}`)).status).toBe(404);
    expect((await B.agent.post('/api/push/test').send({ id: res.body.id })).status).toBe(404);
    expect((await B.agent.get('/api/push/subscriptions')).body.items).toHaveLength(0);
    expect((await A.agent.get('/api/push/subscriptions')).body.items).toHaveLength(1);
  });

  it('moves a browser to the account that subscribed last on it', async () => {
    const A = await registerUser();
    const B = await registerUser();
    const { endpoint: ep } = await subscribe(A.agent);
    const moved = await B.agent.post('/api/push/subscriptions').send({ endpoint: ep, keys: browserKeys() });
    expect(moved.status).toBe(201);
    expect((await A.agent.get('/api/push/subscriptions')).body.items).toHaveLength(0);
    expect((await B.agent.get('/api/push/subscriptions')).body.items).toHaveLength(1);
  });

  it(`keeps at most ${MAX_DEVICES} devices per user, dropping the least recently used`, async () => {
    const A = await registerUser();
    const first = await subscribe(A.agent);
    for (let i = 0; i < MAX_DEVICES; i++) await subscribe(A.agent);
    const items = (await A.agent.get('/api/push/subscriptions')).body.items;
    expect(items).toHaveLength(MAX_DEVICES);
    expect(items.some((d) => d.id === first.res.body.id)).toBe(false);
  });

  it('replaces the previous endpoint when the browser rotates its subscription', async () => {
    const A = await registerUser();
    const old = await subscribe(A.agent);
    const fresh = endpoint();
    const res = await A.agent.post('/api/push/subscriptions').send({ endpoint: fresh, keys: browserKeys(), previousEndpoint: old.endpoint });
    expect(res.status).toBe(201);
    const items = (await A.agent.get('/api/push/subscriptions')).body.items;
    expect(items.map((d) => d.id)).toEqual([res.body.id]);
  });

  it('requires a session and refuses personal API tokens', async () => {
    const anon = await agent();
    expect((await anon.get('/api/push/subscriptions')).status).toBe(401);
    const A = await registerUser();
    const tok = await A.agent.post('/api/tokens').send({ name: 'ext' });
    const bearer = { Authorization: `Bearer ${tok.body.token}` };
    expect((await request(app).get('/api/push/vapid-public-key').set(bearer)).status).toBe(403);
    expect((await request(app).post('/api/push/subscriptions').set(bearer).send({ endpoint: endpoint(), keys: browserKeys() })).status).toBe(403);
  });
});

describe('push: delivery from notify()', () => {
  it('sends a push for a new notification, with a safe deep link', async () => {
    const t = fakeTransport();
    const A = await registerUser();
    const { endpoint: ep } = await subscribe(A.agent);
    await notify(A.user.id, { type: 'fleet_issue', title: 'Truck 12 reported an issue', body: 'Flat tire near Joplin', link: '/app/fleet' });
    await notify(A.user.id, { type: 'team', title: 'Bad link', link: 'https://evil.example/' });
    await flushPushQueue();
    expect(t.sent).toHaveLength(2);
    const issue = t.sent.find((s) => s.payload.tag === 'fleet_issue');
    expect(issue.endpoint).toBe(ep);
    expect(issue.payload).toMatchObject({ title: 'Truck 12 reported an issue', body: 'Flat tire near Joplin', url: '/app/fleet', renotify: true, count: 1 });
    expect(issue.options.urgency).toBe('high');
    expect(issue.options.vapidDetails.publicKey).toBeTruthy();
    expect(t.sent.find((s) => s.payload.tag === 'team').payload.url).toBe('/app/notifications');
    // The in-app notification is the record either way.
    expect(await prisma.notification.count({ where: { userId: A.user.id } })).toBe(2);
  });

  it('collapses several notifications of one type into one push per device', async () => {
    const t = fakeTransport();
    const A = await registerUser();
    await subscribe(A.agent);
    await subscribe(A.agent);
    for (let i = 1; i <= 3; i++) await notify(A.user.id, { type: 'follow_up_due', title: `Follow-up due: Carrier ${i}`, body: 'Call back' });
    await flushPushQueue();
    expect(t.sent).toHaveLength(2); // one per device
    expect(t.sent[0].payload).toMatchObject({ title: 'Follow-up due: Carrier 3', count: 3 });
    expect(t.sent[0].payload.body).toContain('2 more like this');
    // A repeat within a minute updates the notification without a new sound.
    await notify(A.user.id, { type: 'follow_up_due', title: 'Follow-up due: Carrier 4' });
    await flushPushQueue();
    expect(t.sent.at(-1).payload.renotify).toBe(false);
  });

  it('respects the push preference', async () => {
    const t = fakeTransport();
    const A = await registerUser();
    await subscribe(A.agent);
    const off = await A.agent.patch('/api/push/preferences').send({ notifyPush: false });
    expect(off.body.notifyPush).toBe(false);
    expect((await A.agent.patch('/api/push/preferences').send({ notifyPush: 'no' })).status).toBe(400);
    await notify(A.user.id, { type: 'team', title: 'Muted' });
    await flushPushQueue();
    expect(t.sent).toHaveLength(0);
    await A.agent.patch('/api/push/preferences').send({ notifyPush: true });
    await notify(A.user.id, { type: 'team', title: 'Audible' });
    await flushPushQueue();
    expect(t.sent.map((s) => s.payload.title)).toEqual(['Audible']);
  });

  it('shows a push preference change in /api/auth/me at once, from either endpoint', async () => {
    const A = await registerUser();
    await A.agent.get('/api/auth/me'); // warm the session cache
    expect((await A.agent.patch('/api/push/preferences').send({ notifyPush: false })).status).toBe(200);
    expect((await A.agent.get('/api/auth/me')).body.user.notifyPush).toBe(false);
    // The Settings page saves the switch through the profile, which returns the whole user.
    const on = await A.agent.patch('/api/profile').send({ notifyPush: true });
    expect(on.status).toBe(200);
    expect(on.body.user.notifyPush).toBe(true);
    expect((await A.agent.get('/api/push/subscriptions')).body.notifyPush).toBe(true);
    expect((await A.agent.get('/api/auth/me')).body.user.notifyPush).toBe(true);
  });

  it('removes subscriptions the push service reports as gone and counts other failures', async () => {
    const t = fakeTransport();
    const A = await registerUser();
    const gone = await subscribe(A.agent);
    const flaky = await subscribe(A.agent);
    t.fail.set(gone.endpoint, 410);
    t.fail.set(flaky.endpoint, 503);
    await notify(A.user.id, { type: 'team', title: 'One' });
    await flushPushQueue();
    expect(await prisma.pushSubscription.findUnique({ where: { endpoint: gone.endpoint } })).toBeNull();
    expect((await prisma.pushSubscription.findUnique({ where: { endpoint: flaky.endpoint } })).failures).toBe(1);

    // A success resets the count.
    t.fail.delete(flaky.endpoint);
    await notify(A.user.id, { type: 'team', title: 'Two' });
    await flushPushQueue();
    const ok = await prisma.pushSubscription.findUnique({ where: { endpoint: flaky.endpoint } });
    expect(ok.failures).toBe(0);
    expect(ok.lastUsedAt).toBeTruthy();

    // MAX_FAILURES failures in a row remove it.
    t.fail.set(flaky.endpoint, 500);
    for (let i = 0; i < MAX_FAILURES; i++) {
      await notify(A.user.id, { type: `kind_${i}`, title: `Fail ${i}` });
      await flushPushQueue();
    }
    expect(await prisma.pushSubscription.findUnique({ where: { endpoint: flaky.endpoint } })).toBeNull();
  });

  it('does not send for notifications created in a transaction that rolled back', async () => {
    const t = fakeTransport();
    const A = await registerUser();
    await subscribe(A.agent);
    await prisma.$transaction(async (tx) => {
      await notify(A.user.id, { type: 'team', title: 'Rolled back' }, tx);
      throw new Error('rollback');
    }).catch(() => {});
    await notify(A.user.id, { type: 'team', title: 'Committed' }, prisma);
    await flushPushQueue();
    expect(t.sent.map((s) => s.payload.title)).toEqual(['Committed']);
  });
});

describe('push: test notification', () => {
  it('sends to every device, is rate limited, and needs a device', async () => {
    const t = fakeTransport();
    const A = await registerUser();
    expect((await A.agent.post('/api/push/test').send({})).status).toBe(404);
    await subscribe(A.agent);
    const res = await A.agent.post('/api/push/test').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 1, failed: 0, removed: 0 });
    expect(t.sent[0].payload.tag).toBe('test');
    expect((await A.agent.post('/api/push/test').send({})).status).toBe(429);
  });
});
