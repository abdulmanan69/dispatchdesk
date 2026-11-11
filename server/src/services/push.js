import { generateVAPIDKeys, sendNotification } from 'web-push';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { encrypt, decrypt } from '../lib/crypto.js';

/**
 * Web Push (phone and desktop notifications) for in-app notifications.
 *
 * - VAPID keys are generated once and stored encrypted in SystemSetting ("push.vapid"); VAPID_PUBLIC_KEY +
 *   VAPID_PRIVATE_KEY (and optionally VAPID_SUBJECT) override them. The first worker to create the row wins, so every
 *   cluster worker signs with the same key pair.
 * - notify() calls enqueuePush(). Each worker keeps a small bounded queue and sends in batches (debounced 1.5 s), at
 *   most 10 requests at a time. Within a batch, notifications of the same user and type collapse into one push. The
 *   queue is best-effort: a lost push never loses the in-app notification, which is the record.
 * - Subscriptions that answer 404/410 are deleted; other failures count up and the subscription is deleted after
 *   MAX_FAILURES in a row. A success resets the count.
 * - Endpoints must belong to a known browser push service (https, default port), so a crafted endpoint cannot make
 *   the server call internal or arbitrary hosts.
 */

export const MAX_DEVICES = 5;
export const MAX_FAILURES = 5;
const MAX_QUEUE = 2000;
const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 1500;
const CONCURRENCY = 10;
const SEND_TIMEOUT_MS = 10_000;
const TTL_SECONDS = 24 * 3600;
const COLLAPSE_MS = 60_000;
const SETTING_KEY = 'push.vapid';

// Chrome, Edge, Opera, Samsung (FCM), Firefox (Mozilla autopush), Safari and iOS 16.4+ (Apple), Windows (WNS).
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^(?:[a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];
const extraHosts = () => String(process.env.PUSH_EXTRA_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

/** True when `endpoint` is an https URL on a known browser push service. */
export function validEndpoint(endpoint) {
  let u;
  try { u = new URL(String(endpoint)); } catch { return false; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((re) => re.test(host)) || extraHosts().includes(host);
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
/** p256dh must be an uncompressed P-256 point (65 bytes, 0x04 prefix); auth is a 16-byte secret. */
export function validKeys(keys) {
  const p256dh = String(keys?.p256dh || '');
  const auth = String(keys?.auth || '');
  if (!B64URL.test(p256dh) || !B64URL.test(auth)) return false;
  const pk = Buffer.from(p256dh, 'base64url');
  return pk.length === 65 && pk[0] === 4 && Buffer.from(auth, 'base64url').length === 16;
}

// ---------------------------------------------------------------------------------------------------------------
// VAPID keys
// ---------------------------------------------------------------------------------------------------------------

/** Apple rejects VAPID subjects that are not https URLs or mailto addresses, and localhost URLs. */
function vapidSubject() {
  const env = String(process.env.VAPID_SUBJECT || '').trim();
  if (/^(mailto:|https:\/\/)/i.test(env)) return env;
  try {
    const u = new URL(config.appUrl);
    if (u.protocol === 'https:' && u.hostname !== 'localhost') return u.origin;
  } catch { /* fall through */ }
  if (config.admin.email) return `mailto:${config.admin.email}`;
  return 'mailto:admin@example.com';
}

let vapid = null;
let vapidLoading = null;

async function readStoredKeys() {
  const row = await prisma.systemSetting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) return null;
  try {
    const keys = JSON.parse(decrypt(row.value));
    if (keys?.publicKey && keys?.privateKey) return keys;
  } catch { /* APP_SECRET changed: the stored keys can no longer be read */ }
  return { unreadable: row.value };
}

async function loadVapid() {
  const subject = vapidSubject();
  const envPublic = String(process.env.VAPID_PUBLIC_KEY || '').trim();
  const envPrivate = String(process.env.VAPID_PRIVATE_KEY || '').trim();
  if (envPublic && envPrivate) return { publicKey: envPublic, privateKey: envPrivate, subject, source: 'environment' };

  let keys = await readStoredKeys();
  if (!keys) {
    const fresh = generateVAPIDKeys();
    try {
      await prisma.systemSetting.create({ data: { key: SETTING_KEY, value: encrypt(JSON.stringify(fresh)), secret: true } });
    } catch (err) {
      if (err.code !== 'P2002') throw err; // another worker created it first: use theirs
    }
    keys = await readStoredKeys();
  }
  if (keys?.unreadable) {
    // Replace unreadable keys once (compare-and-set). Browser subscriptions are tied to the old public key, so they
    // can never receive pushes again: remove them and let people enable push again.
    const fresh = generateVAPIDKeys();
    const swapped = await prisma.systemSetting.updateMany({ where: { key: SETTING_KEY, value: keys.unreadable }, data: { value: encrypt(JSON.stringify(fresh)) } });
    if (swapped.count === 1) {
      await prisma.pushSubscription.deleteMany({});
      console.warn('[push] stored VAPID keys could not be decrypted; generated new keys and removed old subscriptions');
    }
    keys = await readStoredKeys();
  }
  if (!keys?.publicKey) throw new Error('Push keys are not available');
  return { publicKey: keys.publicKey, privateKey: keys.privateKey, subject, source: 'database' };
}

/** { publicKey, privateKey, subject }, cached per process. */
export async function getVapidKeys() {
  if (vapid) return vapid;
  if (!vapidLoading) vapidLoading = loadVapid().then((v) => { vapid = v; return v; }).finally(() => { vapidLoading = null; });
  return vapidLoading;
}

// ---------------------------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------------------------

let transport = null;
/** Tests replace the network sender: fn(subscription, payload, options) resolves or rejects like web-push. */
export function setPushTransport(fn) { transport = fn || null; }

function deliver(sub, payload, options) {
  const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
  return transport ? transport(subscription, payload, options) : sendNotification(subscription, payload, options);
}

const topicFor = (type) => String(type || 'general').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'general';
const safeLink = (link) => (typeof link === 'string' && link.startsWith('/') && !link.startsWith('//') ? link.slice(0, 500) : '/app/notifications');
const URGENT = new Set(['fleet_issue', 'follow_up_due', 'call']);

/**
 * Send jobs [{ sub, payload, type }] with bounded concurrency, then record outcomes in a few writes.
 * Returns { sent, failed, removed }.
 */
async function sendAll(jobs) {
  const result = { sent: 0, failed: 0, removed: 0 };
  if (!jobs.length) return result;
  const keys = await getVapidKeys();
  const ok = new Map(); // id -> sub
  const gone = new Set();
  const failed = new Set();
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        await deliver(job.sub, job.payload, {
          vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: TTL_SECONDS,
          urgency: URGENT.has(job.type) ? 'high' : 'normal',
          topic: topicFor(job.type),
          timeout: SEND_TIMEOUT_MS,
        });
        result.sent += 1;
        ok.set(job.sub.id, job.sub);
      } catch (err) {
        result.failed += 1;
        if (err?.statusCode === 404 || err?.statusCode === 410) gone.add(job.sub.id);
        else failed.add(job.sub.id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

  const now = new Date();
  try {
    if (gone.size) {
      const del = await prisma.pushSubscription.deleteMany({ where: { id: { in: [...gone] } } });
      result.removed += del.count;
    }
    const failedIds = [...failed].filter((id) => !gone.has(id) && !ok.has(id));
    if (failedIds.length) {
      await prisma.pushSubscription.updateMany({ where: { id: { in: failedIds } }, data: { failures: { increment: 1 } } });
      const del = await prisma.pushSubscription.deleteMany({ where: { id: { in: failedIds }, failures: { gte: MAX_FAILURES } } });
      result.removed += del.count;
    }
    // Only rows that need it: a failure count to clear, or a last-used time older than 10 minutes.
    const touch = [...ok.values()].filter((s) => s.failures > 0 || !s.lastUsedAt || now - new Date(s.lastUsedAt) > 10 * 60000).map((s) => s.id);
    if (touch.length) await prisma.pushSubscription.updateMany({ where: { id: { in: touch } }, data: { failures: 0, lastUsedAt: now } });
  } catch (err) {
    console.error(`[push] could not record send results: ${err.message}`);
  }
  return result;
}

const subSelect = { id: true, userId: true, endpoint: true, p256dh: true, auth: true, failures: true, lastUsedAt: true, createdAt: true };

/** Send a test push to all of a user's devices (or one). Returns null when there is nothing to send to. */
export async function sendTestPush(userId, { subscriptionId } = {}) {
  const subs = await prisma.pushSubscription.findMany({
    where: { userId, ...(subscriptionId ? { id: subscriptionId } : {}) },
    orderBy: { createdAt: 'desc' }, take: MAX_DEVICES, select: subSelect,
  });
  if (!subs.length) return null;
  const payload = JSON.stringify({
    title: 'DispatchDesk test notification',
    body: 'Push notifications work on this device.',
    url: '/app/settings?tab=notifications', tag: 'test', renotify: true,
  });
  return sendAll(subs.map((sub) => ({ sub, payload, type: 'test' })));
}

// ---------------------------------------------------------------------------------------------------------------
// Queue (per process, bounded)
// ---------------------------------------------------------------------------------------------------------------

const queue = [];
let timer = null;
let draining = null;
const stats = { queued: 0, dropped: 0, batches: 0 };
const recent = new Map(); // `${userId}:${type}` -> last push time, so quick repeats update silently

function markRecent(key, now) {
  recent.delete(key);
  recent.set(key, now);
  if (recent.size > 5000) {
    for (const [k, t] of recent) {
      if (now - t < COLLAPSE_MS && recent.size <= 4000) break;
      recent.delete(k);
    }
  }
}

function buildPayload(latest, count, renotify) {
  const more = count > 1 ? `${count - 1} more like this` : '';
  const body = [latest.body ? String(latest.body).slice(0, 240) : '', more].filter(Boolean).join(' · ');
  return JSON.stringify({
    title: String(latest.title || 'DispatchDesk').slice(0, 200),
    body,
    url: safeLink(latest.link),
    tag: topicFor(latest.type),
    renotify,
    id: latest.id,
    count,
  });
}

async function drain() {
  const batch = queue.splice(0, BATCH_SIZE);
  if (!batch.length) return;
  stats.batches += 1;
  try {
    let items = batch;
    // Notifications created inside a transaction are sent only once the row is visible (the transaction committed).
    const txIds = items.filter((i) => i.inTx).map((i) => i.id);
    if (txIds.length) {
      const found = new Set((await prisma.notification.findMany({ where: { id: { in: txIds } }, select: { id: true } })).map((r) => r.id));
      items = items.filter((i) => !i.inTx || found.has(i.id));
    }
    const userIds = [...new Set(items.map((i) => i.userId))];
    if (!userIds.length) return;
    const subs = await prisma.pushSubscription.findMany({
      where: { userId: { in: userIds }, user: { notifyPush: true, status: 'active' } },
      orderBy: { createdAt: 'desc' }, select: subSelect,
    });
    if (!subs.length) return;
    const byUser = new Map();
    for (const s of subs) {
      const list = byUser.get(s.userId) || [];
      if (list.length < MAX_DEVICES) list.push(s);
      byUser.set(s.userId, list);
    }
    const groups = new Map();
    for (const item of items) {
      if (!byUser.has(item.userId)) continue;
      const key = `${item.userId}:${item.type}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const now = Date.now();
    const jobs = [];
    for (const [key, list] of groups) {
      const latest = list[list.length - 1];
      const renotify = !(recent.has(key) && now - recent.get(key) < COLLAPSE_MS);
      markRecent(key, now);
      const payload = buildPayload(latest, list.length, renotify);
      for (const sub of byUser.get(latest.userId)) jobs.push({ sub, payload, type: latest.type });
    }
    await sendAll(jobs);
  } catch (err) {
    console.error(`[push] batch failed: ${err.message}`);
  }
}

function schedule(delay = BATCH_DELAY_MS) {
  if (timer || draining) return;
  timer = setTimeout(() => {
    timer = null;
    draining = drain().finally(() => {
      draining = null;
      if (queue.length) schedule(0);
    });
  }, delay);
  timer.unref?.();
}

/**
 * Queue a Web Push for a freshly created notification row. Never throws and never waits on the network.
 * inTx: the row was created inside a transaction (the push waits until the row is visible).
 */
export function enqueuePush(notification, { inTx = false } = {}) {
  try {
    if (!notification?.id || !notification.userId) return;
    if (config.isTest && !transport) return; // test suites opt in by installing a transport
    if (queue.length >= MAX_QUEUE) { queue.shift(); stats.dropped += 1; }
    queue.push({
      id: notification.id, userId: notification.userId, type: notification.type,
      title: notification.title, body: notification.body, link: notification.link, inTx,
    });
    stats.queued += 1;
    schedule();
  } catch (err) {
    console.error(`[push] could not queue: ${err.message}`);
  }
}

/** Send everything queued now (tests, graceful shutdown). */
export async function flushPushQueue() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (draining) await draining;
  while (queue.length) {
    draining = drain();
    try { await draining; } finally { draining = null; }
  }
}

export function pushQueueStats() {
  return { ...stats, pending: queue.length };
}

/** Test helper: forget cached keys and queue state. */
export function resetPushForTests() {
  vapid = null;
  vapidLoading = null;
  queue.length = 0;
  recent.clear();
  if (timer) { clearTimeout(timer); timer = null; }
}

// ---------------------------------------------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------------------------------------------

/**
 * Save (upsert by endpoint) a browser subscription for a user. An endpoint belongs to one browser profile, so when
 * someone signs in to another account on the same browser the row moves to that account. Keeps at most MAX_DEVICES
 * per user by dropping the least recently used.
 */
export async function saveSubscription(userId, { endpoint, keys, userAgent = null, previousEndpoint = null }) {
  const data = { userId, p256dh: keys.p256dh, auth: keys.auth, failures: 0, ...(userAgent ? { userAgent } : {}) };
  let row;
  try {
    row = await prisma.pushSubscription.upsert({ where: { endpoint }, create: { endpoint, ...data }, update: data, select: { id: true } });
  } catch (err) {
    if (err.code !== 'P2002') throw err; // created concurrently: update the winner
    row = await prisma.pushSubscription.update({ where: { endpoint }, data, select: { id: true } });
  }
  if (previousEndpoint && previousEndpoint !== endpoint) {
    await prisma.pushSubscription.deleteMany({ where: { endpoint: previousEndpoint, userId } });
  }
  const all = await prisma.pushSubscription.findMany({ where: { userId }, select: { id: true, lastUsedAt: true, createdAt: true } });
  if (all.length > MAX_DEVICES) {
    const used = (s) => new Date(s.lastUsedAt || s.createdAt).getTime();
    const others = all.filter((s) => s.id !== row.id).sort((a, b) => used(b) - used(a));
    const drop = others.slice(MAX_DEVICES - 1).map((s) => s.id);
    if (drop.length) await prisma.pushSubscription.deleteMany({ where: { id: { in: drop }, userId } });
  }
  return row;
}
