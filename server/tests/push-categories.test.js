import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { notify } from '../src/lib/activity.js';
import {
  setPushTransport, flushPushQueue, resetPushForTests, PUSH_CATEGORIES, PUSH_CATEGORY_KEYS, pushCategory, pushOffCategories, serializePushPrefs,
} from '../src/services/push.js';

const browserKeys = () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
};
let seq = 0;
const subscribe = (a) => a.post('/api/push/subscriptions').send({ endpoint: `https://fcm.googleapis.com/fcm/send/cat-${Date.now()}-${++seq}`, keys: browserKeys() });

function fakeTransport() {
  const sent = [];
  setPushTransport(async (sub, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; });
  return sent;
}

beforeEach(() => { resetPushForTests(); setPushTransport(null); });
afterAll(() => { setPushTransport(null); resetPushForTests(); });

describe('push categories', () => {
  it('maps every notification type the app sends to a category', () => {
    expect(pushCategory('fleet_issue')).toBe('driver_issues');
    expect(pushCategory('fleet')).toBe('driver_updates');
    expect(pushCategory('check_call_due')).toBe('driver_updates');
    expect(pushCategory('email_reply')).toBe('email_replies');
    expect(pushCategory('email_bounce')).toBe('email_replies');
    expect(pushCategory('follow_up_due')).toBe('follow_ups');
    expect(pushCategory('invoice_overdue')).toBe('invoices');
    for (const s of ['30', '7', '1', 'expired']) expect(pushCategory(`document_expiring_${s}`)).toBe('documents');
    expect(pushCategory('fmcsa_change')).toBe('fmcsa');
    expect(pushCategory('onboarding')).toBe('onboarding');
    expect(pushCategory('team')).toBe('team');
    expect(pushCategory('assignment')).toBe('team');
    for (const t of ['billing', 'automation', 'lead_generator', 'marketplace_message', 'something_new', '', null]) expect(pushCategory(t)).toBe('other');
    expect(new Set(PUSH_CATEGORY_KEYS).size).toBe(PUSH_CATEGORIES.length);
    for (const c of PUSH_CATEGORIES) expect(c.label).toMatch(/^[A-Z][^!]*$/);
  });

  it('reads stored settings defensively and stores only what is off', () => {
    expect([...pushOffCategories('{"invoices":false,"team":true,"bogus":false}')]).toEqual(['invoices']);
    expect(pushOffCategories('not json').size).toBe(0);
    expect(pushOffCategories('[false]').size).toBe(0);
    expect(pushOffCategories(null).size).toBe(0);
    expect(serializePushPrefs(new Set())).toBeNull();
    expect(JSON.parse(serializePushPrefs(new Set(['fmcsa', 'documents'])))).toEqual({ documents: false, fmcsa: false });
  });

  it('GET and PUT /api/push/preferences: every category on by default, known keys only, own account only', async () => {
    const A = await registerUser();
    const B = await registerUser();
    const first = await A.agent.get('/api/push/preferences');
    expect(first.status).toBe(200);
    expect(first.body.enabled).toBe(true);
    expect(first.body.categories.map((c) => c.key)).toEqual(PUSH_CATEGORY_KEYS);
    expect(first.body.categories.every((c) => c.on && c.label)).toBe(true);

    const put = await A.agent.put('/api/push/preferences').send({ categories: { invoices: false, documents: false } });
    expect(put.status).toBe(200);
    expect(put.body.categories.filter((c) => !c.on).map((c) => c.key)).toEqual(['invoices', 'documents']);
    expect(JSON.parse((await prisma.user.findUnique({ where: { id: A.user.id } })).pushPrefs)).toEqual({ invoices: false, documents: false });
    // The list form (what GET returns) works too; categories not sent keep their setting.
    const again = await A.agent.put('/api/push/preferences').send({ categories: [{ key: 'invoices', on: true, label: 'ignored' }] });
    expect(again.body.categories.filter((c) => !c.on).map((c) => c.key)).toEqual(['documents']);
    // The account-wide switch.
    const off = await A.agent.put('/api/push/preferences').send({ enabled: false });
    expect(off.body).toMatchObject({ enabled: false });
    expect((await A.agent.get('/api/auth/me')).body.user.notifyPush).toBe(false);
    expect((await A.agent.put('/api/push/preferences').send({ enabled: true })).body.enabled).toBe(true);

    // Validation: unknown categories, non-boolean values and unknown fields are refused and change nothing.
    for (const body of [{ categories: { bogus: false } }, { categories: { invoices: 'no' } }, { categories: [{ key: 'nope', on: false }] }, { enabled: 'yes' }, { pushPrefs: '{}' }]) {
      expect((await A.agent.put('/api/push/preferences').send(body)).status).toBe(400);
    }
    expect((await A.agent.get('/api/push/preferences')).body.categories.filter((c) => !c.on).map((c) => c.key)).toEqual(['documents']);
    // Another user's settings are separate.
    expect((await B.agent.get('/api/push/preferences')).body.categories.every((c) => c.on)).toBe(true);
  });

  it('skips the push for categories turned off, keeps the in-app notification, and applies changes at once', async () => {
    const sent = fakeTransport();
    const A = await registerUser();
    expect((await subscribe(A.agent)).status).toBe(201);
    await A.agent.put('/api/push/preferences').send({ categories: { invoices: false, documents: false, other: false } });
    await notify(A.user.id, { type: 'invoice_overdue', title: 'Invoice 1001 is past due' });
    await notify(A.user.id, { type: 'document_expiring_7', title: 'COI expires in 7 days' });
    await notify(A.user.id, { type: 'billing', title: 'Payment failed' });
    await notify(A.user.id, { type: 'fleet_issue', title: 'Truck 7 reported an issue' });
    await flushPushQueue();
    expect(sent.map((p) => p.title)).toEqual(['Truck 7 reported an issue']);
    expect(await prisma.notification.count({ where: { userId: A.user.id } })).toBe(4);

    // Turned back on: the next batch reads the user row again (no cache to invalidate).
    await A.agent.put('/api/push/preferences').send({ categories: { invoices: true } });
    await notify(A.user.id, { type: 'invoice_overdue', title: 'Invoice 1002 is past due' });
    await flushPushQueue();
    expect(sent.map((p) => p.title)).toContain('Invoice 1002 is past due');
  });

  it('category settings of one user never affect another user in the same batch', async () => {
    const sent = fakeTransport();
    const A = await registerUser();
    const B = await registerUser();
    await subscribe(A.agent);
    await subscribe(B.agent);
    await A.agent.put('/api/push/preferences').send({ categories: { email_replies: false } });
    await notify(A.user.id, { type: 'email_reply', title: 'Reply for A' });
    await notify(B.user.id, { type: 'email_reply', title: 'Reply for B' });
    await flushPushQueue();
    expect(sent.map((p) => p.title)).toEqual(['Reply for B']);
  });
});
