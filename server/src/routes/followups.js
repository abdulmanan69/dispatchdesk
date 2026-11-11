import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, notFound, badRequest } from '../lib/errors.js';
import { parse, z, optStr, paginate, pageResult } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { loadCarrier, canViewTeam, teamMemberIds } from '../lib/access.js';
import { logActivity } from '../lib/activity.js';
import { onlySent } from '../services/carriers/normalize.js';
import { addLocalDays, endOfUserDay, localParts, serverTimezone, startOfUserDay, zonedTimeToUtc, DEFAULT_TZ } from '../lib/timezones.js';
import { invalidateQueueCount } from '../services/sequenceEngine.js';
import { accessChecker } from '../services/carriers/query.js';
import { logActivities } from '../services/carriers/bulk.js';

const r = Router();
r.use(requirePermission('crm.use'));

export const FOLLOW_UP_TYPES = ['call', 'email', 'text', 'task', 'meeting'];
export const RECURRENCES = ['none', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly'];
const VIEWS = ['overdue', 'today', 'upcoming', 'done', 'all'];

// Reminder lead times (minutes). API values are snapped to the nearest one so the scheduler can find due reminders
// with one index range per lead time (jobs/scheduler.js).
export const REMIND_PRESETS = [0, 5, 10, 15, 30, 60, 120, 240, 480, 1440, 2880, 4320, 10080];
export function snapRemind(minutes) {
  const m = Math.max(0, Number(minutes) || 0);
  let best = 0;
  for (const p of REMIND_PRESETS) if (Math.abs(p - m) < Math.abs(best - m)) best = p;
  return best;
}

const DAY = 86400000;
// Due dates are bounded: a date centuries in the past would make recurrence catch-up loops pointless work.
const dueDate = z.coerce.date().refine((d) => {
  const t = d.getTime();
  return t >= Date.now() - 366 * DAY && t <= Date.now() + 5 * 366 * DAY;
}, { message: 'Pick a date within the last year and the next 5 years' });

const carrierSelect = { id: true, companyName: true, phone: true, email: true, state: true, city: true, timezone: true, dotNumber: true, mcNumber: true, doNotCall: true };

export async function syncNextFollowUp(carrierId) {
  const next = await prisma.followUp.findFirst({ where: { carrierId, status: 'pending' }, orderBy: { dueAt: 'asc' }, select: { dueAt: true } });
  await prisma.carrier.update({ where: { id: carrierId }, data: { nextFollowUpAt: next?.dueAt ?? null } }).catch(() => {});
}

/**
 * Next occurrence after `from` for a recurrence rule, on the local wall clock of `tz` (the follow-up owner's zone):
 * a 9:00 AM weekly call stays at 9:00 AM across DST, and "weekdays" skips the local Saturday and Sunday.
 * Without a zone the server's zone is used (the previous behavior).
 */
export function nextOccurrence(from, recurrence, tz = serverTimezone()) {
  const d = new Date(from);
  const p = localParts(tz, d);
  const at = (y, m, day) => new Date(zonedTimeToUtc(tz, y, m, day, p.hour, p.minute, p.second).getTime() + d.getUTCMilliseconds());
  switch (recurrence) {
    case 'daily': return at(p.year, p.month, p.day + 1);
    case 'weekly': return at(p.year, p.month, p.day + 7);
    case 'biweekly': return at(p.year, p.month, p.day + 14);
    case 'weekdays': {
      let add = 1;
      while ([0, 6].includes((p.weekdayIndex + add) % 7)) add++;
      return at(p.year, p.month, p.day + add);
    }
    case 'monthly': {
      const y = p.month === 12 ? p.year + 1 : p.year;
      const m = p.month === 12 ? 1 : p.month + 1;
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return at(y, m, Math.min(p.day, daysInMonth));
    }
    default: return null;
  }
}

/**
 * First occurrence strictly after `now`. Bounded work however old `from` is: fixed-length rules jump whole periods,
 * monthly jumps whole months, weekdays restarts a few days before now; then at most a handful of steps (capped).
 */
export function nextOccurrenceAfter(from, recurrence, now = new Date(), tz = serverTimezone()) {
  let due = nextOccurrence(from, recurrence, tz);
  if (!due || due > now) return due;
  const period = { daily: 1, weekly: 7, biweekly: 14 }[recurrence];
  if (period) {
    const behind = Math.floor((now.getTime() - due.getTime()) / DAY / period) * period;
    if (behind > 0) due = addLocalDays(tz, due, behind);
  } else if (recurrence === 'monthly') {
    const p = localParts(tz, due);
    const n = localParts(tz, now);
    const months = (n.year - p.year) * 12 + (n.month - p.month) - 1;
    if (months > 0) {
      const anchorDay = localParts(tz, new Date(from)).day;
      const total = p.month - 1 + months;
      const y = p.year + Math.floor(total / 12);
      const m = (total % 12) + 1;
      const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
      due = zonedTimeToUtc(tz, y, m, Math.min(anchorDay, dim), p.hour, p.minute, p.second);
    }
  } else if (recurrence === 'weekdays') {
    const p = localParts(tz, due);
    const n = localParts(tz, new Date(now.getTime() - 3 * DAY));
    const base = zonedTimeToUtc(tz, n.year, n.month, n.day, p.hour, p.minute, p.second);
    if (base > due) due = base;
  }
  for (let i = 0; i < 400 && due && due <= now; i++) due = nextOccurrence(due, recurrence, tz);
  return due && due > now ? due : null;
}

const viewWhere = (view, now, tz) => {
  const end = endOfUserDay(tz, now);
  switch (view) {
    case 'overdue': return { status: 'pending', dueAt: { lt: now } };
    case 'today': return { status: 'pending', dueAt: { gte: now, lte: end } };
    case 'upcoming': return { status: 'pending', dueAt: { gt: end } };
    case 'done': return { status: 'done' };
    default: return {};
  }
};

r.get('/', ah(async (req, res) => {
  const q = parse(z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(500).default(50),
    view: z.enum(VIEWS).optional(),
    status: z.enum(['pending', 'done', 'canceled', 'all']).optional(),
    range: z.enum(['overdue', 'today', 'upcoming', 'all']).optional(), // legacy alias of view
    type: z.enum(FOLLOW_UP_TYPES).optional(),
    priority: z.coerce.number().int().min(0).max(2).optional(),
    carrierId: optStr(40),
    q: optStr(100),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    scope: z.enum(['mine', 'team']).default('mine'),
  }), req.query);
  const now = new Date();
  const tz = req.user.timezone || DEFAULT_TZ; // Today/Upcoming split at the user's midnight, not the server's
  const owner = {};
  if (q.carrierId) owner.carrierId = (await loadCarrier(req.user, q.carrierId)).id;
  else if (q.scope === 'team' && canViewTeam(req.user)) owner.userId = { in: await teamMemberIds(req.user) };
  else owner.userId = req.user.id;

  const and = [owner];
  const view = q.view || q.range;
  if (view) {
    const vw = viewWhere(view, now, tz);
    // Legacy `range=today` included earlier-today items; the new `view=today` starts now (overdue is its own view).
    if (q.range && !q.view && view === 'today') vw.dueAt = { gte: startOfUserDay(tz, now), lte: endOfUserDay(tz, now) };
    if (q.range && !q.view) delete vw.status;
    and.push(vw);
  }
  const status = q.status ?? (q.view ? undefined : 'pending');
  if (status && status !== 'all') and.push({ status });
  if (q.type) and.push({ type: q.type });
  if (q.priority != null) and.push({ priority: q.priority });
  if (q.from || q.to) and.push({ dueAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } });
  if (q.q) and.push({ OR: [{ title: { contains: q.q } }, { note: { contains: q.q } }, { carrier: { companyName: { contains: q.q } } }] });
  const where = { AND: and };

  const countFor = (v) => prisma.followUp.count({ where: { AND: [owner, viewWhere(v, now, tz)] } });
  const [items, total, overdue, today, upcoming, done] = await Promise.all([
    prisma.followUp.findMany({
      where,
      orderBy: view === 'done' || status === 'done' ? [{ completedAt: 'desc' }] : [{ dueAt: 'asc' }, { priority: 'desc' }],
      ...paginate(q),
      include: { carrier: { select: carrierSelect }, user: { select: { id: true, name: true } } },
    }),
    prisma.followUp.count({ where }),
    countFor('overdue'), countFor('today'), countFor('upcoming'), countFor('done'),
  ]);
  res.json({ ...pageResult(items, total, q), counts: { overdue, today, upcoming, done } });
}));

const fields = {
  type: z.enum(FOLLOW_UP_TYPES),
  title: optStr(160),
  note: optStr(2000),
  priority: z.coerce.number().int().min(0).max(2),
  recurrence: z.enum(RECURRENCES),
  remindMinutesBefore: z.coerce.number().int().min(0).max(10080).transform(snapRemind),
};

r.post('/', ah(async (req, res) => {
  const body = parse(z.object({
    carrierId: z.string().min(1), dueAt: dueDate,
    type: fields.type.default('call'), title: fields.title, note: fields.note,
    priority: fields.priority.default(0), recurrence: fields.recurrence.default('none'), remindMinutesBefore: fields.remindMinutesBefore.default(0),
  }), req.body);
  const carrier = await loadCarrier(req.user, body.carrierId, { write: true });
  const { carrierId, ...rest } = body;
  const fu = await prisma.followUp.create({ data: { ...rest, carrierId: carrier.id, userId: req.user.id }, include: { carrier: { select: carrierSelect } } });
  await syncNextFollowUp(carrier.id);
  invalidateQueueCount(req.user.id);
  await logActivity(req.user, { type: 'follow_up', carrierId: carrier.id, summary: `Scheduled ${body.type} follow-up with ${carrier.companyName} for ${body.dueAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` });
  res.status(201).json({ followUp: fu });
}));

async function loadFollowUp(req, id = req.params.id) {
  const fu = await prisma.followUp.findUnique({ where: { id } });
  if (!fu) throw notFound('Follow-up not found');
  const carrier = await loadCarrier(req.user, fu.carrierId, { write: fu.userId !== req.user.id });
  return { fu, carrier };
}

r.patch('/:id', ah(async (req, res) => {
  const { fu } = await loadFollowUp(req);
  const body = onlySent(parse(z.object({
    dueAt: dueDate.optional(), type: fields.type.optional(), title: fields.title, note: fields.note,
    priority: fields.priority.optional(), recurrence: fields.recurrence.optional(), remindMinutesBefore: fields.remindMinutesBefore.optional(),
    status: z.enum(['pending', 'done', 'canceled']).optional(), outcome: optStr(500),
  }), req.body), req.body);
  const data = { ...body };
  if (body.status === 'done' && fu.status !== 'done') data.completedAt = new Date();
  if (body.status === 'pending') data.completedAt = null;
  // Moving the due time re-arms the reminder.
  if (body.dueAt || body.remindMinutesBefore !== undefined) data.notifiedAt = null;
  const updated = await prisma.followUp.update({ where: { id: fu.id }, data, include: { carrier: { select: carrierSelect } } });
  await syncNextFollowUp(fu.carrierId);
  invalidateQueueCount(fu.userId);
  res.json({ followUp: updated });
}));

/**
 * Close a follow-up; recurring ones spawn their next occurrence (in the owner's time zone, after `now`).
 * Shared with services/calls.js (a logged call completes that carrier's due call follow-ups).
 * Options: quiet (no activity entry), sync=false (caller re-syncs Carrier.nextFollowUpAt itself).
 */
export async function completeFollowUp(user, fu, carrier, { outcome, note, quiet = false, sync = true, now = new Date() } = {}) {
  // Compare-and-set: two clicks (or a click and a logged call) complete it once and spawn one next occurrence.
  const claimed = await prisma.followUp.updateMany({
    where: { id: fu.id, status: 'pending' },
    data: { status: 'done', completedAt: now, outcome: outcome ?? fu.outcome, note: note ? [fu.note, note].filter(Boolean).join('\n') : fu.note },
  });
  if (!claimed.count) throw badRequest('Follow-up is already closed');
  const updated = await prisma.followUp.findUnique({ where: { id: fu.id } });
  let next = null;
  if (fu.recurrence && fu.recurrence !== 'none') {
    const tz = fu.userId === user.id
      ? user.timezone
      : (await prisma.user.findUnique({ where: { id: fu.userId }, select: { timezone: true } }))?.timezone;
    const due = nextOccurrenceAfter(fu.dueAt, fu.recurrence, now, tz || DEFAULT_TZ);
    if (due) {
      next = await prisma.followUp.create({
        data: {
          carrierId: fu.carrierId, userId: fu.userId, dueAt: due, type: fu.type, title: fu.title, note: fu.note,
          priority: fu.priority, recurrence: fu.recurrence, remindMinutesBefore: fu.remindMinutesBefore,
        },
      });
    }
  }
  if (sync) await syncNextFollowUp(fu.carrierId);
  invalidateQueueCount(fu.userId);
  if (!quiet) {
    await logActivity(user, { type: 'follow_up', carrierId: carrier.id, summary: `Completed ${fu.type} follow-up with ${carrier.companyName}${outcome ? ` — ${outcome}` : ''}${note ? `: ${note.slice(0, 160)}` : ''}` });
  }
  return { followUp: updated, next };
}

r.post('/:id/complete', ah(async (req, res) => {
  const { fu, carrier } = await loadFollowUp(req);
  if (fu.status !== 'pending') throw badRequest('Follow-up is already closed');
  const body = parse(z.object({ note: optStr(1000), outcome: optStr(500) }), req.body);
  res.json(await completeFollowUp(req.user, fu, carrier, body));
}));

const snoozeSchema = z.object({ minutes: z.coerce.number().int().min(1).max(60 * 24 * 90).optional(), until: dueDate.optional() })
  .refine((b) => b.minutes || b.until, { message: 'Give minutes or until' });

function snoozedDue(fu, body) {
  if (body.until) return body.until;
  const base = Math.max(Date.now(), new Date(fu.dueAt).getTime());
  return new Date(base + body.minutes * 60000);
}

r.post('/:id/snooze', ah(async (req, res) => {
  const { fu } = await loadFollowUp(req);
  if (fu.status !== 'pending') throw badRequest('Only pending follow-ups can be snoozed');
  const body = parse(snoozeSchema, req.body);
  const updated = await prisma.followUp.update({
    where: { id: fu.id }, data: { dueAt: snoozedDue(fu, body), snoozeCount: { increment: 1 }, notifiedAt: null },
    include: { carrier: { select: carrierSelect } },
  });
  await syncNextFollowUp(fu.carrierId);
  invalidateQueueCount(fu.userId);
  res.json({ followUp: updated });
}));

r.post('/bulk', ah(async (req, res) => {
  const body = parse(z.object({
    ids: z.array(z.string().max(40)).min(1).max(200),
    action: z.enum(['complete', 'snooze', 'reschedule', 'delete', 'priority', 'cancel']),
    minutes: z.coerce.number().int().min(1).max(60 * 24 * 90).optional(),
    until: dueDate.optional(),
    dueAt: dueDate.optional(),
    priority: z.coerce.number().int().min(0).max(2).optional(),
    outcome: optStr(500),
  }), req.body);
  if (body.action === 'snooze' && !body.minutes && !body.until) throw badRequest('Give minutes or until');
  if (body.action === 'reschedule' && !body.dueAt) throw badRequest('Give dueAt');
  if (body.action === 'priority' && body.priority == null) throw badRequest('Give priority');
  const out = { updated: 0, skipped: 0, notFound: 0 };
  const now = new Date();
  const ids = [...new Set(body.ids)];

  // One query loads every row with its carrier; access uses the same rules as loadFollowUp (read the carrier; write
  // access when the follow-up belongs to someone else), evaluated in memory.
  const rows = await prisma.followUp.findMany({
    where: { id: { in: ids } },
    include: { carrier: { select: { id: true, companyName: true, ownerId: true, assignedToId: true } } },
  });
  const { readable, writable } = await accessChecker(req.user);
  const allowed = rows.filter((fu) => (fu.userId === req.user.id ? readable(fu.carrier) : writable(fu.carrier)));
  out.notFound = ids.length - allowed.length;
  const touched = new Set(allowed.map((fu) => fu.carrierId));
  const owners = new Set(allowed.map((fu) => fu.userId));
  const allIds = allowed.map((fu) => fu.id);

  if (body.action === 'delete') {
    out.updated = (await prisma.followUp.deleteMany({ where: { id: { in: allIds } } })).count;
  } else if (body.action === 'priority') {
    out.updated = (await prisma.followUp.updateMany({ where: { id: { in: allIds } }, data: { priority: body.priority } })).count;
  } else {
    const pending = allowed.filter((fu) => fu.status === 'pending');
    out.skipped = allowed.length - pending.length;
    const pendingIds = pending.map((fu) => fu.id);
    if (body.action === 'complete') {
      // Recurring rows go through completeFollowUp (it schedules the next occurrence); one-off rows are closed with
      // one compare-and-set UPDATE and their timeline entries are inserted in one batch.
      const recurring = pending.filter((fu) => fu.recurrence && fu.recurrence !== 'none');
      for (const fu of recurring) {
        try {
          await completeFollowUp(req.user, fu, fu.carrier, { outcome: body.outcome, sync: false, now });
          out.updated++;
        } catch (err) { if (err.status === 400) { out.skipped++; continue; } throw err; }
      }
      const single = pending.filter((fu) => !fu.recurrence || fu.recurrence === 'none');
      if (single.length) {
        const claimed = await prisma.followUp.updateMany({
          where: { id: { in: single.map((fu) => fu.id) }, status: 'pending' },
          data: { status: 'done', completedAt: now, ...(body.outcome !== undefined ? { outcome: body.outcome } : {}) },
        });
        out.updated += claimed.count;
        out.skipped += single.length - claimed.count;
        // Rows this request closed carry exactly `now` as completedAt (a concurrent close would not).
        const closed = claimed.count === single.length
          ? single
          : await prisma.followUp.findMany({ where: { id: { in: single.map((fu) => fu.id) }, completedAt: now }, include: { carrier: { select: { id: true, companyName: true } } } });
        await logActivities(req.user, closed.map((fu) => ({
          type: 'follow_up', carrierId: fu.carrierId,
          summary: `Completed ${fu.type} follow-up with ${fu.carrier.companyName}${body.outcome ? ` — ${body.outcome}` : ''}`,
        })));
      }
    } else if (body.action === 'cancel') {
      const res0 = await prisma.followUp.updateMany({ where: { id: { in: pendingIds }, status: 'pending' }, data: { status: 'canceled', completedAt: now } });
      out.updated = res0.count;
      out.skipped += pendingIds.length - res0.count;
    } else if (body.action === 'reschedule') {
      out.updated = (await prisma.followUp.updateMany({ where: { id: { in: pendingIds }, status: 'pending' }, data: { dueAt: body.dueAt, notifiedAt: null } })).count;
      out.skipped += pendingIds.length - out.updated;
    } else if (body.action === 'snooze') {
      // The new due time depends on each row's due time; the writes go in one transaction.
      const results = await prisma.$transaction(pending.map((fu) => prisma.followUp.updateMany({
        where: { id: fu.id, status: 'pending' },
        data: { dueAt: snoozedDue(fu, body), snoozeCount: { increment: 1 }, notifiedAt: null },
      })));
      out.updated = results.reduce((n, x) => n + x.count, 0);
      out.skipped += pending.length - out.updated;
    }
  }
  await syncNextFollowUps([...touched]);
  for (const uid of owners) invalidateQueueCount(uid);
  res.json(out);
}));

/** syncNextFollowUp for many carriers: one grouped read, then the writes in one transaction. */
async function syncNextFollowUps(carrierIds) {
  if (!carrierIds.length) return;
  const next = await prisma.followUp.groupBy({ by: ['carrierId'], where: { carrierId: { in: carrierIds }, status: 'pending' }, _min: { dueAt: true } });
  const byCarrier = new Map(next.map((g) => [g.carrierId, g._min.dueAt]));
  await prisma.$transaction(carrierIds.map((id) => prisma.carrier.updateMany({ where: { id }, data: { nextFollowUpAt: byCarrier.get(id) ?? null } })));
}

r.delete('/:id', ah(async (req, res) => {
  const { fu } = await loadFollowUp(req);
  await prisma.followUp.delete({ where: { id: fu.id } });
  await syncNextFollowUp(fu.carrierId);
  invalidateQueueCount(fu.userId);
  res.json({ ok: true });
}));

export default r;
