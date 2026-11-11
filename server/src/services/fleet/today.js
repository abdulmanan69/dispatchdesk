import { prisma } from '../../db.js';
import { broadcast, onBroadcast } from '../../lib/broadcast.js';
import { readableOwnerIds } from '../../lib/access.js';
import { startOfUserDay, addLocalDays } from '../../lib/timezones.js';
import { ACTIVE, plansFor, lastContacts, checkCallSettings, checkCallDue, stopEvents, openDwell } from './insights.js';
import { stopWindow } from './progress.js';
import { registerDigestSection } from '../email/digest.js';

/**
 * Today board: one prioritized list of what needs the dispatcher's attention now, built from data the app already has.
 * Each section is one bounded, indexed query (take <= 300). The result is cached 30 s per user and scope in this process;
 * the dispatcher's own actions (check call, status change, tracking link) drop the cached copy in every process.
 *
 * Priorities: 0 = act now (late or at-risk appointments, detention running, overdue check calls, overdue invoices),
 * 1 = today, 2 = soon or paperwork.
 */
const TTL = 30_000;
// Only users with the Today page open hit the board cache within 30 s; the nav badge keeps counts only (below).
const MAX = 300;
const COUNTS_MAX = 5000;
const cache = new Map();
const counts = new Map(); // userId -> { exp, value: { urgent, total } }
onBroadcast('today', (userId) => {
  if (!userId) { cache.clear(); counts.clear(); return; }
  for (const k of [...cache.keys()]) if (k.startsWith(`${userId}:`)) cache.delete(k);
  counts.delete(userId);
});
// Expired boards are dropped every minute, so a worker does not keep boards nobody is looking at.
const sweep = setInterval(() => {
  const t = Date.now();
  for (const [k, v] of cache) if (v.exp <= t) cache.delete(k);
  for (const [k, v] of counts) if (v.exp <= t) counts.delete(k);
}, 60_000);
sweep.unref?.();
/** Drop cached boards for these users in every process (call after a change the board shows). */
export function invalidateToday(...userIds) {
  for (const id of new Set(userIds.filter(Boolean))) broadcast('today', id);
}
export function clearTodayCache() { cache.clear(); counts.clear(); }

/**
 * { urgent, total } for the nav badge. Uses a fresh cached board when the user has the Today page open; otherwise it
 * builds the board without keeping it and caches only the two numbers (same TTL and invalidation as the board).
 */
export async function todayCounts(user, { now = new Date() } = {}) {
  const t = Date.now();
  const hit = counts.get(user.id);
  if (hit && hit.exp > t) return hit.value;
  const board = cache.get(`${user.id}:mine`);
  const b = board && board.exp > t ? board.value : await build(user, 'mine', now);
  const value = { urgent: b.urgent, total: b.items.length };
  counts.delete(user.id);
  if (counts.size >= COUNTS_MAX) counts.delete(counts.keys().next().value);
  counts.set(user.id, { exp: Date.now() + TTL, value });
  return value;
}

/**
 * The board for a user. `cache: false` builds it without reading or filling the cache (the morning digest builds one
 * board per user once, which would otherwise fill the scheduler worker's cache with boards nobody opens).
 */
export async function todayBoard(user, { scope = 'mine', now = new Date(), cache: useCache = true } = {}) {
  if (!useCache) return build(user, scope, now);
  const key = `${user.id}:${scope}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const value = await build(user, scope, now);
  cache.delete(key);
  if (cache.size >= MAX) {
    // Drop expired boards first; when every entry is still fresh, the oldest one goes.
    const t = Date.now();
    for (const [k, v] of cache) if (v.exp <= t) cache.delete(k);
    if (cache.size >= MAX) cache.delete(cache.keys().next().value);
  }
  cache.set(key, { exp: Date.now() + TTL, value });
  return value;
}

const DAY = 86400_000;
const place = (city, state) => [city, state].filter(Boolean).join(', ');
const loadRef = (l) => ({
  id: l.id, referenceNumber: l.referenceNumber, status: l.status,
  origin: { city: l.originCity, state: l.originState }, dest: { city: l.destCity, state: l.destState },
});
const carrierRef = (c) => (c ? { id: c.id, companyName: c.companyName, phone: c.phone || null } : null);
// Document types in sentence case (acronyms stay upper case).
const DOC_LABEL = {
  coi: 'COI', w9: 'W-9', mc_authority: 'MC authority', agreement: 'Agreement', permit: 'Permit', rate_confirmation: 'Rate confirmation',
  bol: 'BOL', pod: 'POD', lumper_receipt: 'Lumper receipt', scale_ticket: 'Scale ticket', fuel_receipt: 'Fuel receipt', other: 'Document',
};
const docLabel = (type) => DOC_LABEL[type] || `${type.charAt(0).toUpperCase()}${type.slice(1).replace(/_/g, ' ')}`;

const DELIVERED_SELECT = { id: true, referenceNumber: true, status: true, originCity: true, originState: true, destCity: true, destState: true, deliveryDate: true, updatedAt: true, carrier: { select: { id: true, companyName: true, phone: true } } };

/** Delivered loads of the last 14 days (newest first, at most 60), plus a few without a delivery date. */
async function recentDelivered(owners, nowMs) {
  const since = new Date(nowMs - 14 * DAY);
  const [dated, undated] = await Promise.all([
    prisma.load.findMany({
      where: { ownerId: { in: owners }, deliveryDate: { gte: since }, status: 'delivered' },
      orderBy: { deliveryDate: 'desc' }, take: 60, select: DELIVERED_SELECT,
    }),
    // Status changes fill in the delivery date; older rows without one are few and are bounded here.
    prisma.load.findMany({
      where: { ownerId: { in: owners }, status: 'delivered', deliveryDate: null, updatedAt: { gte: since } },
      take: 20, select: DELIVERED_SELECT,
    }),
  ]);
  return [...dated, ...undated].slice(0, 60);
}

async function build(user, scope, now) {
  const owners = await readableOwnerIds(user, scope === 'team' ? 'team' : 'mine');
  const tz = user.timezone || 'America/Chicago';
  const nowMs = now.getTime();
  const dayStart = startOfUserDay(tz, now);
  const tomorrowStart = addLocalDays(tz, dayStart, 1);
  const horizon = addLocalDays(tz, dayStart, 2);

  const [loads, trucks, delivered, invoices, followUps, docs, customers] = await Promise.all([
    prisma.load.findMany({
      where: { ownerId: { in: owners }, status: { in: ACTIVE } },
      orderBy: [{ pickupDate: 'asc' }, { createdAt: 'asc' }], take: 300,
      include: {
        carrier: { select: { id: true, companyName: true, phone: true, timezone: true, locationLat: true, locationLng: true, locationUpdatedAt: true, locationSource: true } },
        broker: { select: { id: true, companyName: true, email: true, phone: true } },
      },
    }),
    prisma.carrier.findMany({
      where: { ownerId: { in: owners }, isFleet: true, truckStatus: { notIn: ['off_duty', 'maintenance'] } },
      select: {
        id: true, companyName: true, phone: true, truckStatus: true, availableAt: true, locationCity: true, locationState: true,
        _count: { select: { loads: { where: { status: { in: ACTIVE } } } } },
      },
      take: 300,
    }),
    // Missing PODs: loads delivered in the last two weeks, on the Load(ownerId, deliveryDate) index (loads that stay
    // 'delivered' forever are not read or sorted). Older ones are on the Loads page (missing POD filter).
    recentDelivered(owners, nowMs),
    prisma.invoice.findMany({
      where: { ownerId: { in: owners }, status: { in: ['sent', 'partial'] }, dueAt: { lt: now } },
      orderBy: { dueAt: 'asc' }, take: 30,
      select: { id: true, number: true, billToName: true, amountCents: true, paidCents: true, dueAt: true, loadId: true, broker: { select: { id: true, phone: true } } },
    }),
    prisma.followUp.findMany({
      where: { userId: { in: owners }, status: 'pending', dueAt: { lt: tomorrowStart } },
      orderBy: { dueAt: 'asc' }, take: 40,
      select: { id: true, dueAt: true, type: true, title: true, note: true, priority: true, carrier: { select: { id: true, companyName: true, phone: true } } },
    }),
    prisma.document.findMany({
      where: { ownerId: { in: owners }, expiresAt: { gte: new Date(nowMs - 30 * DAY), lte: new Date(nowMs + 7 * DAY) } },
      orderBy: { expiresAt: 'asc' }, take: 30,
      select: { id: true, type: true, originalName: true, expiresAt: true, carrierId: true, loadId: true, carrier: { select: { id: true, companyName: true, phone: true } } },
    }),
    prisma.customer.findMany({ where: { ownerId: { in: owners }, status: 'active' }, select: { carrierId: true, carrier: { select: { id: true, companyName: true, phone: true } } }, take: 200 }),
  ]);

  const items = [];
  const loadsById = Object.fromEntries(loads.map((l) => [l.id, l]));

  // Plans (ETAs and risk) for every truck with an active load.
  const carrierIds = [...new Set(loads.map((l) => l.carrierId).filter(Boolean))];
  const shares = carrierIds.length
    ? await prisma.locationShare.findMany({ where: { carrierId: { in: carrierIds }, status: { in: ['pending', 'sharing', 'paused'] } }, orderBy: { updatedAt: 'desc' }, select: { id: true, carrierId: true, status: true, lastAt: true } })
    : [];
  const carriers = carrierIds.map((id) => {
    const own = loads.filter((l) => l.carrierId === id);
    return { ...own[0].carrier, loads: own, locationShares: shares.filter((s) => s.carrierId === id).slice(0, 1) };
  });
  const [plans, events] = await Promise.all([plansFor(carriers, { now: nowMs, withEvents: true }), stopEvents(loads.map((l) => l.id))]);
  const stopOf = (l, kind) => plans[l.carrierId]?.stops.find((s) => s.loadId === l.id && s.kind === kind) || null;

  // 1. Appointments today and tomorrow (and missed ones not done yet).
  for (const l of loads) {
    const pickedUp = l.status === 'in_transit' || (events[l.id] || []).some((e) => e.type === 'loaded' || e.type === 'departed_pickup');
    for (const kind of pickedUp ? ['delivery'] : ['pickup', 'delivery']) {
      const w = stopWindow(l, kind);
      if (!w) continue;
      const start = w.start.getTime();
      const end = w.end.getTime();
      const missed = end < nowMs;
      if (!missed && start >= horizon.getTime()) continue;
      if (missed && nowMs - end > 3 * DAY) continue;
      const stop = stopOf(l, kind);
      const risk = !l.carrierId && kind === 'pickup' ? 'no_truck' : missed ? 'late' : stop?.risk ?? null;
      const today = start < tomorrowStart.getTime();
      items.push({
        id: `appt:${l.id}:${kind}`, section: 'appointments', kind,
        priority: risk === 'late' || risk === 'at_risk' || risk === 'no_truck' ? 0 : today ? 1 : 2,
        at: w.start, day: today ? 'today' : 'tomorrow',
        title: `${kind === 'pickup' ? 'Pickup' : 'Delivery'} in ${place(kind === 'pickup' ? l.originCity : l.destCity, kind === 'pickup' ? l.originState : l.destState)}`,
        window: w, eta: stop?.eta ?? null, legalEta: stop?.legalEta ?? null, risk,
        load: loadRef(l), carrier: carrierRef(l.carrier), broker: l.broker ? { id: l.broker.id, companyName: l.broker.companyName, email: l.broker.email } : null,
      });
    }
  }

  // 2. Check calls due on loads in transit.
  const inTransit = loads.filter((l) => l.status === 'in_transit');
  if (inTransit.length) {
    const [contacts, settings] = await Promise.all([lastContacts(inTransit), checkCallSettings(inTransit.map((l) => l.ownerId))]);
    for (const l of inTransit) {
      const due = checkCallDue(l, contacts[l.id], settings[l.ownerId], nowMs);
      if (!due) continue;
      items.push({
        id: `checkcall:${l.id}`, section: 'check_calls', priority: 0, at: due.lastContactAt,
        title: `Check call due: ${l.carrier?.companyName || 'unassigned truck'}`,
        lastContactAt: due.lastContactAt, lastContactVia: due.via, everyHours: due.hours,
        load: loadRef(l), carrier: carrierRef(l.carrier), broker: l.broker ? { id: l.broker.id, companyName: l.broker.companyName, email: l.broker.email } : null,
      });
    }
  }

  // 3. Trucks at a dock: detention running, or the free time counting down.
  const dwell = openDwell(events, loadsById, nowMs);
  for (const [loadId, list] of Object.entries(dwell)) {
    const l = loadsById[loadId];
    for (const d of list) {
      items.push({
        id: `dwell:${loadId}:${d.stop}`, section: 'detention', priority: d.running ? 0 : 1, at: d.arrivedAt,
        title: d.running ? `Detention running at ${d.stop}` : `At ${d.stop} dock`,
        stop: d.stop, arrivedAt: d.arrivedAt, dwellMin: d.dwellMin, freeMin: d.freeMin, detentionMin: d.detentionMin, running: d.running,
        load: loadRef(l), carrier: carrierRef(l.carrier),
      });
    }
  }

  // 4. Trucks free today with nothing planned.
  for (const t of trucks) {
    if (t._count.loads > 0) continue;
    const ready = t.availableAt ? t.availableAt.getTime() < tomorrowStart.getTime() : t.truckStatus === 'available';
    if (!ready) continue;
    items.push({
      id: `truck:${t.id}`, section: 'available_trucks', priority: 1, at: t.availableAt,
      title: `${t.companyName} needs a load`, location: place(t.locationCity, t.locationState) || null,
      availableAt: t.availableAt, carrier: carrierRef(t),
    });
  }

  // 5. Delivered loads without a POD.
  if (delivered.length) {
    const pods = await prisma.document.findMany({ where: { loadId: { in: delivered.map((l) => l.id) }, type: 'pod' }, select: { loadId: true } });
    const have = new Set(pods.map((d) => d.loadId));
    for (const l of delivered) {
      if (have.has(l.id)) continue;
      items.push({
        id: `pod:${l.id}`, section: 'missing_pod', priority: 2, at: l.deliveryDate || l.updatedAt,
        title: `POD missing: ${place(l.originCity, l.originState)} → ${place(l.destCity, l.destState)}`,
        load: loadRef(l), carrier: carrierRef(l.carrier),
      });
    }
  }

  // 6. Overdue invoices.
  for (const inv of invoices) {
    items.push({
      id: `invoice:${inv.id}`, section: 'invoices', priority: 0, at: inv.dueAt,
      title: `Invoice #${inv.number} overdue: ${inv.billToName}`, invoice: { id: inv.id, number: inv.number, balanceCents: inv.amountCents - inv.paidCents, dueAt: inv.dueAt, loadId: inv.loadId },
      phone: inv.broker?.phone || null,
    });
  }

  // 7. Follow-ups due today or overdue.
  for (const f of followUps) {
    items.push({
      id: `followup:${f.id}`, section: 'follow_ups', priority: 1, at: f.dueAt,
      title: f.title || `${f.type === 'call' ? 'Call' : f.type === 'email' ? 'Email' : 'Follow up with'} ${f.carrier?.companyName || ''}`.trim(),
      followUp: { id: f.id, type: f.type, overdue: f.dueAt.getTime() < nowMs }, carrier: carrierRef(f.carrier),
    });
  }

  // 8. Paperwork: documents expiring within 7 days (or expired in the last 30), customers without a signed agreement.
  for (const d of docs) {
    const expired = d.expiresAt.getTime() < nowMs;
    items.push({
      id: `doc:${d.id}`, section: 'documents', priority: expired ? 1 : 2, at: d.expiresAt,
      title: `${docLabel(d.type)} ${expired ? 'expired' : 'expires soon'}${d.carrier ? `: ${d.carrier.companyName}` : ''}`,
      document: { id: d.id, type: d.type, name: d.originalName, expiresAt: d.expiresAt, loadId: d.loadId }, carrier: carrierRef(d.carrier),
    });
  }
  if (customers.length) {
    const agreements = await prisma.document.findMany({ where: { carrierId: { in: customers.map((c) => c.carrierId) }, type: 'agreement' }, select: { carrierId: true } });
    const signed = new Set(agreements.map((a) => a.carrierId));
    for (const c of customers.filter((x) => !signed.has(x.carrierId)).slice(0, 15)) {
      items.push({ id: `agreement:${c.carrierId}`, section: 'documents', priority: 2, at: null, title: `No signed agreement on file: ${c.carrier.companyName}`, carrier: carrierRef(c.carrier) });
    }
  }

  items.sort((a, b) => a.priority - b.priority || (a.at ? new Date(a.at).getTime() : Infinity) - (b.at ? new Date(b.at).getTime() : Infinity));
  const counts = {};
  for (const i of items) counts[i.section] = (counts[i.section] || 0) + 1;
  return { generatedAt: now, timezone: tz, scope, items, counts, urgent: items.filter((i) => i.priority === 0).length };
}

// Morning digest (services/email/digest.js): the board's urgent and today rows, so a dispatcher with trucks gets one
// email instead of a second morning message. Follow-ups and paperwork are left out (the digest lists follow-ups itself).
const DIGEST_SECTIONS = ['appointments', 'check_calls', 'detention', 'invoices', 'missing_pod', 'available_trucks'];
const digestLine = (i) => [
  i.title,
  i.carrier?.companyName && !i.title.includes(i.carrier.companyName) ? i.carrier.companyName : null,
  i.load?.referenceNumber ? `ref ${i.load.referenceNumber}` : null,
].filter(Boolean).join(' · ');

registerDigestSection('today_board', async (user, { now }) => {
  const board = await todayBoard(user, { now, cache: false });
  const rows = board.items.filter((i) => DIGEST_SECTIONS.includes(i.section) && (i.priority <= 1 || i.section === 'missing_pod'));
  if (!rows.length) return null;
  const urgent = rows.filter((i) => i.priority === 0).length;
  return {
    title: urgent ? `Loads and trucks (${urgent} need action now)` : 'Loads and trucks',
    count: rows.length,
    lines: rows.slice(0, 8).map(digestLine),
  };
});
