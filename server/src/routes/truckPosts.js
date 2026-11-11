import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { parse, z, optStr, optDate } from '../lib/validate.js';
import { requirePermission, hasPermission } from '../middleware/auth.js';
import { readableOwnerIds } from '../lib/access.js';
import { healFleetFlags } from '../services/fleet/flags.js';
import { withLock, LockBusyError } from '../lib/locks.js';
import { audit } from '../lib/audit.js';
import { queueUserEmail } from '../services/email/compose.js';
import { pickAccount } from '../services/email/index.js';
import { renderContent, renderPreview } from '../services/email/render.js';
import { stateOf } from '../services/market/geo.js';
import * as census from '../services/carriers/fmcsaCensus.js';
import { accessChecker } from '../services/carriers/query.js';
import { logActivities } from '../services/carriers/bulk.js';
import { newId } from '../services/carriers/ids.js';
import { sendCapacity, capacityMessage } from '../services/carriers/outreach.js';
import {
  TRUCK_FIELDS, truckValues, defaultTruckPost, leftoverTokens, equipmentText, truckPlace, lanesText, detailsText, summarizeReloads,
} from '../services/carriers/truckPost.js';

/**
 * Post truck availability to brokers, and reload ideas for a delivery market.
 *   GET  /trucks          fleet trucks you can see, available ones first
 *   GET  /draft           merge values and a ready default email for one truck
 *   GET  /brokers         brokers with email, with the lanes and states you hauled for them (last 365 days)
 *   POST /preview         the email as each selected broker will get it
 *   POST /send            queue the emails (max MAX_BROKERS per post) from your own mailbox; one Activity per broker
 *   GET  /history         recent posts with each email's delivery status
 *   GET  /reload-ideas    brokers and lanes from your own loads out of a state, customers' lanes, FMCSA counts
 * Emails are queued, never sent inline: the scheduler sends them within the mailbox cooldown and daily limits.
 */
const r = Router();
r.use(requirePermission('crm.use'));

export const MAX_BROKERS = 30;
/** The same truck is not posted to the same broker twice within this window unless the user confirms. */
export const REPEAT_WINDOW_MS = 12 * 3600_000;
const DAY_MS = 86400000;
const SOON_MS = 48 * 3600_000;
const COUNTS_CACHE_MS = 12 * 3600_000;

const stateCode = z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z]{2}$/, 'Use a 2-letter state code'));
const optState = z.preprocess((v) => (v === '' || v == null ? undefined : String(v).trim().toUpperCase()), z.string().regex(/^[A-Z]{2}$/, 'Use a 2-letter state code').optional());

const truckSelect = {
  id: true, ownerId: true, assignedToId: true, companyName: true, mcNumber: true, dotNumber: true, phone: true, equipment: true,
  truckStatus: true, availableAt: true, locationCity: true, locationState: true, locationUpdatedAt: true, city: true, state: true, timezone: true,
  customer: {
    select: {
      id: true, status: true, minRatePerMile: true, trailerLengthFt: true, maxWeightLbs: true, hazmat: true, twic: true, teamDrivers: true,
      lanes: { select: { origin: true, destination: true }, orderBy: { createdAt: 'asc' }, take: 10 },
    },
  },
};

const availableWithin = (t, cutoff) => t.truckStatus !== 'maintenance' && t.truckStatus !== 'off_duty'
  && (t.availableAt ? new Date(t.availableAt) <= cutoff : t.truckStatus === 'available');

function truckView(t, now = new Date()) {
  return {
    id: t.id, companyName: t.companyName, mcNumber: t.mcNumber, dotNumber: t.dotNumber, phone: t.phone,
    equipment: t.equipment, equipmentText: equipmentText(t.equipment), truckStatus: t.truckStatus, availableAt: t.availableAt,
    available: availableWithin(t, new Date(now.getTime() + SOON_MS)),
    location: truckPlace(t) || null, locationState: t.locationState || t.state || null, locationCity: t.locationState ? t.locationCity : t.city,
    locationUpdatedAt: t.locationUpdatedAt, isCustomer: !!t.customer,
    lanes: (t.customer?.lanes || []).map((l) => ({ origin: l.origin, destination: l.destination })),
    lanesText: lanesText(t.customer?.lanes || []), minRatePerMile: t.customer?.minRatePerMile ?? null, details: detailsText(t.customer),
  };
}

async function loadTruck(user, id, { write = false } = {}) {
  const t = await prisma.carrier.findUnique({ where: { id: String(id) }, select: truckSelect });
  const access = await accessChecker(user);
  if (!t || !access.readable(t)) throw notFound('Truck not found');
  if (write && !access.writable(t)) throw forbidden('Read-only access to this carrier');
  return t;
}

const brokerSelect = { id: true, ownerId: true, companyName: true, contactName: true, email: true, phone: true, city: true, state: true, mcNumber: true, daysToPay: true, paymentTerms: true };

/** Brokers by id that the user may read (own, or the team's when the user may view team data). Missing ids are dropped. */
async function loadBrokers(user, ids) {
  const owners = await readableOwnerIds(user, 'team');
  const rows = await prisma.broker.findMany({ where: { id: { in: [...new Set(ids)] }, ownerId: { in: owners } }, select: brokerSelect });
  return new Map(rows.map((b) => [b.id, b]));
}

/** Broker ids that got this truck in the last REPEAT_WINDOW_MS, with when (Activity(carrierId, createdAt) index). */
async function recentPosts(truckId, now = new Date()) {
  const rows = await prisma.activity.findMany({
    where: { carrierId: truckId, type: 'truck_post', createdAt: { gte: new Date(now.getTime() - REPEAT_WINDOW_MS) } },
    select: { createdAt: true, metadata: true }, orderBy: { createdAt: 'desc' }, take: 500,
  });
  const out = new Map();
  for (const a of rows) {
    try { const m = JSON.parse(a.metadata || '{}'); if (m.brokerId && !out.has(m.brokerId)) out.set(m.brokerId, a.createdAt); } catch { /* not ours */ }
  }
  return out;
}

r.get('/trucks', ah(async (req, res) => {
  const q = parse(z.object({ scope: z.enum(['mine', 'team']).default('mine') }), req.query);
  const owners = await readableOwnerIds(req.user, q.scope);
  const visible = req.user.teamMembership ? { OR: [{ ownerId: { in: owners } }, { assignedToId: req.user.id }] } : { ownerId: { in: owners } };
  // The fleet flag (Carrier(ownerId, isFleet) index), as on the fleet map; flags that slipped through are set first.
  await healFleetFlags(owners);
  const rows = await prisma.carrier.findMany({ where: { AND: [visible, { isFleet: true }] }, select: truckSelect, orderBy: { companyName: 'asc' }, take: 300 });
  const now = new Date();
  const items = rows.map((t) => truckView(t, now)).sort((a, b) => (b.available - a.available)
    || (a.availableAt ? new Date(a.availableAt) : Infinity) - (b.availableAt ? new Date(b.availableAt) : Infinity));
  res.json({ items, total: items.length, available: items.filter((t) => t.available).length });
}));

const detailsSchema = z.object({
  location: optStr(120), availableAt: optDate, lanes: optStr(300), rate: optStr(60), details: optStr(300), equipment: optStr(120),
}).partial();

r.get('/draft', ah(async (req, res) => {
  const q = parse(z.object({ carrierId: z.string().min(1).max(60) }), req.query);
  const truck = await loadTruck(req.user, q.carrierId);
  const values = truckValues(truck, {}, { userTz: req.user.timezone });
  res.json({ truck: truckView(truck), values, template: defaultTruckPost(values, req.user), fields: TRUCK_FIELDS, recent: Object.fromEntries(await recentPosts(truck.id)) });
}));

const brokerQuery = z.object({
  q: optStr(100),
  state: optState,
  lane: z.string().trim().regex(/^[A-Za-z]{2}-[A-Za-z]{2}$/, 'Lane looks like TX-GA').optional(),
  withinDays: z.coerce.number().int().min(1).max(730).optional(),
  scope: z.enum(['mine', 'team']).default('mine'),
  withEmail: z.enum(['true', 'false']).default('true'),
  carrierId: optStr(60),
});

r.get('/brokers', ah(async (req, res) => {
  const q = parse(brokerQuery, req.query);
  const owners = await readableOwnerIds(req.user, q.scope);
  const where = { ownerId: { in: owners } };
  if (q.withEmail === 'true') where.email = { not: null };
  if (q.q) where.OR = [{ companyName: { contains: q.q } }, { contactName: { contains: q.q } }, { email: { contains: q.q.toLowerCase() } }, { mcNumber: { contains: q.q } }];
  const [rows, total] = await Promise.all([
    prisma.broker.findMany({ where, select: brokerSelect, orderBy: { companyName: 'asc' }, take: 500 }),
    prisma.broker.count({ where }),
  ]);
  const ids = rows.map((b) => b.id);
  const since = new Date(Date.now() - 365 * DAY_MS);
  const groups = ids.length ? await prisma.load.groupBy({
    by: ['brokerId', 'originState', 'destState'],
    where: { brokerId: { in: ids }, ownerId: { in: owners }, status: { not: 'canceled' }, createdAt: { gte: since } },
    _count: { _all: true }, _max: { pickupDate: true, createdAt: true },
  }) : [];
  const stats = new Map();
  for (const g of groups) {
    const s = stats.get(g.brokerId) || { loads: 0, lanes: [], states: new Set(), lastLoadAt: null };
    s.loads += g._count._all;
    s.lanes.push({ from: g.originState, to: g.destState, loads: g._count._all });
    s.states.add(g.originState); s.states.add(g.destState);
    const last = g._max.pickupDate || g._max.createdAt;
    if (last && (!s.lastLoadAt || last > s.lastLoadAt)) s.lastLoadAt = last;
    stats.set(g.brokerId, s);
  }
  const recent = q.carrierId ? await recentPosts((await loadTruck(req.user, q.carrierId)).id) : new Map();
  const cutoff = q.withinDays ? new Date(Date.now() - q.withinDays * DAY_MS) : null;
  const [laneFrom, laneTo] = q.lane ? q.lane.toUpperCase().split('-') : [];
  const items = rows.map((b) => {
    const s = stats.get(b.id);
    return {
      ...b,
      loads: s?.loads || 0,
      lanes: (s?.lanes || []).sort((x, y) => y.loads - x.loads).slice(0, 5),
      states: s ? [...s.states].sort() : [],
      lastLoadAt: s?.lastLoadAt || null,
      postedAt: recent.get(b.id) || null,
    };
  }).filter((b) => (!q.state || b.state === q.state || b.states.includes(q.state))
    && (!q.lane || b.lanes.some((l) => l.from === laneFrom && l.to === laneTo))
    && (!cutoff || (b.lastLoadAt && b.lastLoadAt >= cutoff)))
    .sort((a, b) => (b.lastLoadAt ? 1 : 0) - (a.lastLoadAt ? 1 : 0) || (b.lastLoadAt || 0) - (a.lastLoadAt || 0) || a.companyName.localeCompare(b.companyName));
  res.json({ items, total, limited: total > rows.length });
}));

const postSchema = z.object({
  carrierId: z.string().min(1).max(60),
  brokerIds: z.array(z.string().max(60)).min(1, 'Pick at least one broker').max(MAX_BROKERS, `Post to at most ${MAX_BROKERS} brokers at a time`),
  subject: z.string().trim().min(1, 'Subject is required').max(300),
  body: z.string().trim().min(1, 'Message is required').max(20000),
  templateId: optStr(60),
  accountId: optStr(60),
  details: detailsSchema.optional(),
  allowRepeat: z.boolean().optional(),
});

function requireEmail(req) {
  if (!hasPermission(req, 'email.use')) throw forbidden('Your role cannot send email');
}

r.post('/preview', ah(async (req, res) => {
  requireEmail(req);
  const b = parse(postSchema, req.body);
  const truck = await loadTruck(req.user, b.carrierId);
  const brokers = await loadBrokers(req.user, b.brokerIds);
  const account = await pickAccount(req.user.id);
  const values = truckValues(truck, b.details || {}, { userTz: req.user.timezone });
  const recent = await recentPosts(truck.id);
  const items = b.brokerIds.map((id) => {
    const broker = brokers.get(id);
    if (!broker) return { brokerId: id, skip: 'Broker not found' };
    const p = renderPreview({ subject: b.subject, body: b.body, channel: 'email', broker, user: req.user, extra: values, account });
    return {
      brokerId: id, brokerName: broker.companyName, toEmail: broker.email, subject: p.subject, body: p.body, signature: p.signature,
      unresolved: p.unresolved, unknown: p.unknown, postedAt: recent.get(id) || null,
      skip: !broker.email ? 'No email address' : null,
    };
  });
  res.json({ items, values, mailbox: account ? { id: account.id, fromEmail: account.fromEmail, label: account.label } : null, capacity: account ? await sendCapacity(req.user, account) : null });
}));

r.post('/send', ah(async (req, res) => {
  requireEmail(req);
  if (req.apiToken) throw forbidden('API tokens cannot send truck posts');
  const b = parse(postSchema, req.body);
  try {
    // One post at a time per user across all workers, so a double click cannot queue the same emails twice.
    const out = await withLock(`truck-post.${req.user.id}`, 120_000, () => sendPost(req, b));
    res.status(out.queued ? 201 : 200).json(out);
  } catch (err) {
    if (err instanceof LockBusyError) throw conflict('A truck post is already being sent. Try again in a moment.');
    throw err;
  }
}));

async function sendPost(req, b) {
  const user = req.user;
  const truck = await loadTruck(user, b.carrierId, { write: true });
  const account = await pickAccount(user.id, b.accountId || undefined);
  if (!account) throw badRequest('Connect a mailbox first (Email, Mailboxes)');
  const template = b.templateId ? await prisma.emailTemplate.findFirst({ where: { id: b.templateId, ownerId: user.id }, select: { id: true } }) : null;
  const brokers = await loadBrokers(user, b.brokerIds);
  const values = truckValues(truck, b.details || {}, { userTz: user.timezone });
  const recent = await recentPosts(truck.id);
  const postId = newId();
  const skipped = [];
  const activities = [];
  let stopped = null;
  for (const id of [...new Set(b.brokerIds)]) {
    const broker = brokers.get(id);
    const name = broker?.companyName || 'Unknown broker';
    if (!broker) { skipped.push({ brokerId: id, name, reason: 'Broker not found' }); continue; }
    if (stopped) { skipped.push({ brokerId: id, name, reason: stopped }); continue; }
    if (!broker.email) { skipped.push({ brokerId: id, name, reason: 'No email address' }); continue; }
    if (recent.has(id) && !b.allowRepeat) { skipped.push({ brokerId: id, name, reason: 'Already got this truck in the last 12 hours' }); continue; }
    // Strict render (as the preview shows it): a field with no value for this broker or truck, or an unknown token,
    // keeps the email out of the queue. Sending renders known-but-empty fields as blanks, which the preview says never happens.
    const strict = renderPreview({ subject: b.subject, body: b.body, channel: 'email', broker, user, extra: values, account });
    const missing = [...strict.unresolved, ...strict.unknown];
    if (missing.length) { skipped.push({ brokerId: id, name, reason: `Unfilled merge fields: ${missing.join(', ')}` }); continue; }
    const out = renderContent({ subject: b.subject, body: b.body, broker, user, extra: values, account });
    const left = leftoverTokens(out.subject, out.body);
    if (left.length) { skipped.push({ brokerId: id, name, reason: `Unfilled merge fields: ${left.join(', ')}` }); continue; }
    try {
      const { email } = await queueUserEmail({ user, toEmail: broker.email, subject: out.subject, body: out.body, brokerId: broker.id, templateId: template?.id ?? null, accountId: account.id, sendNow: false });
      activities.push({
        type: 'truck_post', carrierId: truck.id,
        summary: `Truck availability emailed to ${broker.companyName} (${broker.email})`,
        metadata: { postId, brokerId: broker.id, brokerName: broker.companyName, toEmail: broker.email, emailId: email.id, location: values.truck_location || null },
      });
    } catch (err) {
      if (err.status === 402) { stopped = err.message; skipped.push({ brokerId: id, name, reason: stopped }); } else skipped.push({ brokerId: id, name, reason: err.message });
    }
  }
  await logActivities(user, activities);
  // The template picker counts a template's use when it is picked, so nothing is counted again here.
  const capacity = await sendCapacity(user, account);
  await audit(req, 'truck_post.send', { entityType: 'carrier', entityId: truck.id, details: { queued: activities.length, skipped: skipped.length } });
  return { postId, queued: activities.length, skipped, capacity, message: capacityMessage(activities.length, { ...capacity, sendableToday: capacity.sendableToday + activities.length }) };
}

r.get('/history', ah(async (req, res) => {
  const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), carrierId: optStr(60) }), req.query);
  const since = new Date(Date.now() - 90 * DAY_MS);
  const acts = await prisma.activity.findMany({
    where: { userId: req.user.id, type: 'truck_post', createdAt: { gte: since }, ...(q.carrierId ? { carrierId: q.carrierId } : {}) },
    orderBy: { createdAt: 'desc' }, take: 600,
    select: { createdAt: true, carrierId: true, metadata: true, carrier: { select: { id: true, companyName: true } } },
  });
  const runs = new Map();
  for (const a of acts) {
    let m = {};
    try { m = JSON.parse(a.metadata || '{}'); } catch { /* keep empty */ }
    const key = m.postId || `${a.carrierId}-${a.createdAt.toISOString().slice(0, 16)}`;
    if (!runs.has(key)) {
      if (runs.size >= q.limit) continue;
      runs.set(key, { postId: key, at: a.createdAt, truck: a.carrier ? { id: a.carrier.id, companyName: a.carrier.companyName } : null, location: m.location || null, recipients: [] });
    }
    runs.get(key).recipients.push({ brokerId: m.brokerId || null, brokerName: m.brokerName || null, toEmail: m.toEmail || null, emailId: m.emailId || null });
  }
  const emailIds = [...runs.values()].flatMap((x) => x.recipients.map((r2) => r2.emailId)).filter(Boolean);
  const emails = emailIds.length ? await prisma.email.findMany({
    where: { id: { in: emailIds }, userId: req.user.id },
    select: { id: true, status: true, sentAt: true, error: true, repliedAt: true, bouncedAt: true, scheduledAt: true },
  }) : [];
  const byId = new Map(emails.map((e) => [e.id, e]));
  const items = [...runs.values()].map((run) => ({
    ...run,
    recipients: run.recipients.map((x) => {
      const e = x.emailId ? byId.get(x.emailId) : null;
      return { ...x, status: e ? (e.bouncedAt ? 'bounced' : e.repliedAt ? 'replied' : e.status) : 'removed', sentAt: e?.sentAt || null, scheduledAt: e?.scheduledAt || null, error: e?.error || null };
    }),
  }));
  res.json({ items });
}));

const reloadQuery = z.object({
  state: stateCode,
  city: optStr(80),
  equipment: optStr(120),
  days: z.coerce.number().int().min(30).max(730).default(365),
});

/**
 * Reload ideas for a truck delivering in (or empty in) a state: from the workspace's own loads out of that state
 * (the user's, plus the team's when the user may view team data), customers' preferred lanes from there, and FMCSA
 * public counts as context. Nothing is estimated or invented: empty sections stay empty.
 */
r.get('/reload-ideas', ah(async (req, res) => {
  const q = parse(reloadQuery, req.query);
  const owners = await readableOwnerIds(req.user, 'team');
  const since = new Date(Date.now() - q.days * DAY_MS);
  const [loads, customerLanes, fmcsa] = await Promise.all([
    prisma.load.findMany({
      where: { ownerId: { in: owners }, originState: q.state, status: { not: 'canceled' }, OR: [{ pickupDate: { gte: since } }, { pickupDate: null, createdAt: { gte: since } }] },
      select: {
        id: true, brokerId: true, originCity: true, destCity: true, destState: true, rateCents: true, loadedMiles: true, pickupDate: true, createdAt: true, equipment: true,
        broker: { select: { id: true, companyName: true, contactName: true, phone: true, email: true, daysToPay: true, paymentTerms: true } },
      },
      orderBy: [{ pickupDate: 'desc' }, { createdAt: 'desc' }],
      take: 1000,
    }),
    prisma.customerLane.findMany({
      where: { customer: { ownerId: { in: owners }, status: 'active' } },
      select: { origin: true, destination: true, notes: true, customer: { select: { id: true, carrier: { select: { id: true, companyName: true, equipment: true } } } } },
      take: 500,
    }),
    Promise.all([
      census.stateCounts({ state: q.state }, undefined, { cacheMs: COUNTS_CACHE_MS }),
      q.city ? census.stateCounts({ state: q.state, city: q.city }, undefined, { cacheMs: COUNTS_CACHE_MS }) : null,
    ]).then(([st, city]) => ({ state: st, city, source: census.label, error: null }))
      .catch((err) => ({ state: null, city: null, source: census.label, error: String(err.message || err).slice(0, 200) })),
  ]);
  const summary = summarizeReloads(loads, { city: q.city, equipment: q.equipment });
  const wantCity = String(q.city || '').trim().toLowerCase();
  const lanes = customerLanes
    .filter((l) => stateOf(l.origin) === q.state || (wantCity && String(l.origin || '').toLowerCase().includes(wantCity)))
    .slice(0, 10)
    .map((l) => ({ origin: l.origin, destination: l.destination, notes: l.notes, carrier: l.customer?.carrier || null }));
  res.json({
    state: q.state, city: q.city || null, equipment: q.equipment || null, days: q.days, loadsConsidered: loads.length,
    brokers: summary.brokers.slice(0, 15), lanes: summary.lanes.slice(0, 10), customerLanes: lanes, fmcsa, generatedAt: new Date(),
  });
}));

export default r;
