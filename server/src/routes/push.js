import cluster from 'node:cluster';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { ClusterMemoryStoreWorker } from '@express-rate-limit/cluster-memory-store';
import { prisma } from '../db.js';
import { ah, badRequest, forbidden, notFound } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { invalidateUserSessions } from '../middleware/auth.js';
import {
  getVapidKeys, saveSubscription, sendTestPush, validEndpoint, validKeys, MAX_DEVICES,
  PUSH_CATEGORY_KEYS, pushOffCategories, serializePushPrefs, pushPreferencesView,
} from '../services/push.js';

/**
 * Web Push for the signed-in user: VAPID public key, this user's devices (subscriptions), the push on/off
 * preference and a test push. Endpoints are never returned to the browser; devices are addressed by id.
 */
const r = Router();

// Personal API tokens (browser extension, integrations) cannot register devices or change push settings.
r.use((req, res, next) => next(req.apiToken ? forbidden('API tokens cannot manage push notifications') : undefined));

r.get('/vapid-public-key', ah(async (req, res) => {
  const { publicKey } = await getVapidKeys();
  res.set('Cache-Control', 'private, max-age=3600');
  res.json({ publicKey });
}));

const deviceSelect = { id: true, userAgent: true, failures: true, lastUsedAt: true, createdAt: true };

r.get('/subscriptions', ah(async (req, res) => {
  const [items, user] = await Promise.all([
    prisma.pushSubscription.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: MAX_DEVICES * 2, select: deviceSelect }),
    prisma.user.findUnique({ where: { id: req.user.id }, select: { notifyPush: true } }),
  ]);
  res.json({ items, max: MAX_DEVICES, notifyPush: !!user?.notifyPush });
}));

const subscriptionSchema = z.object({
  endpoint: z.string().trim().min(10).max(1000),
  keys: z.object({ p256dh: z.string().trim().max(200), auth: z.string().trim().max(100) }),
  previousEndpoint: z.string().trim().max(1000).nullable().optional(),
});

r.post('/subscriptions', ah(async (req, res) => {
  const body = parse(subscriptionSchema, req.body);
  if (!validEndpoint(body.endpoint)) throw badRequest('This browser push service is not supported.');
  if (!validKeys(body.keys)) throw badRequest('The push subscription keys are not valid.');
  const before = await prisma.pushSubscription.findUnique({ where: { endpoint: body.endpoint }, select: { userId: true } });
  const row = await saveSubscription(req.user.id, {
    endpoint: body.endpoint,
    keys: body.keys,
    previousEndpoint: body.previousEndpoint || null,
    userAgent: String(req.get('user-agent') || '').slice(0, 300) || null,
  });
  res.status(before?.userId === req.user.id ? 200 : 201).json({ id: row.id });
}));

/** Remove this browser's subscription by endpoint (the browser knows its endpoint, not our id). */
r.delete('/subscriptions', ah(async (req, res) => {
  const body = parse(z.object({ endpoint: z.string().trim().min(10).max(1000) }), req.body);
  const del = await prisma.pushSubscription.deleteMany({ where: { endpoint: body.endpoint, userId: req.user.id } });
  res.json({ removed: del.count });
}));

r.delete('/subscriptions/:id', ah(async (req, res) => {
  const del = await prisma.pushSubscription.deleteMany({ where: { id: String(req.params.id), userId: req.user.id } });
  if (!del.count) throw notFound('Device not found');
  res.json({ ok: true });
}));

const prefsSelect = { notifyPush: true, pushPrefs: true };

/** The account-wide push switch and the per-category switches: { enabled, categories: [{ key, label, on }] }. */
r.get('/preferences', ah(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: prefsSelect });
  res.json(pushPreferencesView(user));
}));

const categoryKey = z.enum(PUSH_CATEGORY_KEYS);
const preferencesSchema = z.strictObject({
  enabled: z.boolean().optional(),
  // { "<category key>": true | false }, or the list GET returns ([{ key, on }]). Only known keys are accepted.
  categories: z.union([
    z.partialRecord(categoryKey, z.boolean()),
    z.array(z.object({ key: categoryKey, on: z.boolean() })).max(PUSH_CATEGORY_KEYS.length * 2),
  ]).optional(),
});

/** Change the push switch and/or categories; categories not sent keep their setting. Returns the GET shape. */
r.put('/preferences', ah(async (req, res) => {
  const body = parse(preferencesSchema, req.body || {});
  const data = {};
  if (body.enabled !== undefined) data.notifyPush = body.enabled;
  if (body.categories !== undefined) {
    const changes = Array.isArray(body.categories) ? body.categories.map((c) => [c.key, c.on]) : Object.entries(body.categories);
    const current = await prisma.user.findUnique({ where: { id: req.user.id }, select: { pushPrefs: true } });
    const off = pushOffCategories(current?.pushPrefs);
    for (const [key, on] of changes) { if (on) off.delete(key); else off.add(key); }
    data.pushPrefs = serializePushPrefs(off);
  }
  const user = Object.keys(data).length
    ? await prisma.user.update({ where: { id: req.user.id }, data, select: prefsSelect })
    : await prisma.user.findUnique({ where: { id: req.user.id }, select: prefsSelect });
  // Cached sessions carry notifyPush (GET /api/auth/me): drop them in every process. The send path reads the user row.
  if (data.notifyPush !== undefined) invalidateUserSessions(req.user.id);
  res.json(pushPreferencesView(user));
}));

/** Same field as PATCH /api/profile { notifyPush } (what the Settings page uses); kept for API clients. */
r.patch('/preferences', ah(async (req, res) => {
  const body = parse(z.object({ notifyPush: z.boolean() }), req.body);
  const user = await prisma.user.update({ where: { id: req.user.id }, data: { notifyPush: body.notifyPush }, select: { notifyPush: true } });
  // Cached sessions carry the user's preferences (GET /api/auth/me): drop them in every process.
  invalidateUserSessions(req.user.id);
  res.json({ notifyPush: user.notifyPush });
}));

// One test push per user every 10 seconds. In cluster mode the counter lives in the primary process, so the limit
// holds across workers. Failed requests (no device yet) do not use it up. Active in tests too.
const TEST_COOLDOWN_MS = 10_000;
const testLimiter = rateLimit({
  windowMs: TEST_COOLDOWN_MS,
  limit: 1,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipFailedRequests: true,
  keyGenerator: (req) => `u:${req.user.id}`,
  ...(cluster.isWorker ? { store: new ClusterMemoryStoreWorker({ prefix: 'pushtest:' }) } : {}),
  handler: (req, res) => res.status(429).json({ error: 'Wait a few seconds before sending another test.' }),
});

r.post('/test', testLimiter, ah(async (req, res) => {
  const body = parse(z.object({ id: z.string().trim().max(40).optional() }), req.body);
  const result = await sendTestPush(req.user.id, { subscriptionId: body.id });
  if (!result) throw notFound(body.id ? 'Device not found' : 'Turn on push on this device first.');
  res.json(result);
}));

export default r;
