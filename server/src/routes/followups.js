import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, notFound, badRequest } from '../lib/errors.js';
import { parse, z, optStr, paginate, pageResult } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { loadCarrier, canViewTeam, teamMemberIds } from '../lib/access.js';
import { logActivity } from '../lib/activity.js';
import { onlySent } from '../services/carriers/normalize.js';

const r = Router();
r.use(requirePermission('crm.use'));

export const FOLLOW_UP_TYPES = ['call', 'email', 'text', 'task', 'meeting'];
export const RECURRENCES = ['none', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly'];
const VIEWS = ['overdue', 'today', 'upcoming', 'done', 'all'];

const carrierSelect = { id: true, companyName: true, phone: true, email: true, state: true, city: true, timezone: true, dotNumber: true, mcNumber: true };

async function syncNextFollowUp(carrierId) {
  const next = await prisma.followUp.findFirst({ where: { carrierId, status: 'pending' }, orderBy: { dueAt: 'asc' } });
  await prisma.carrier.update({ where: { id: carrierId }, data: { nextFollowUpAt: next?.dueAt ?? null } });
}

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };

/** Next occurrence after `from` for a recurrence rule. Weekdays skips Saturday and Sunday. */
export function nextOccurrence(from, recurrence) {
  const d = new Date(from);
  switch (recurrence) {
    case 'daily': d.setDate(d.getDate() + 1); break;
    case 'weekdays': do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6); break;
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'biweekly': d.setDate(d.getDate() + 14); break;
    case 'monthly': {
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
      break;
    }
    default: return null;
  }
  return d;
}

const viewWhere = (view, now = new Date()) => {
  switch (view) {
    case 'overdue': return { status: 'pending', dueAt: { lt: now } };
    case 'today': return { status: 'pending', dueAt: { gte: now, lte: endOfToday() } };
    case 'upcoming': return { status: 'pending', dueAt: { gt: endOfToday() } };
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
  const owner = {};
  if (q.carrierId) owner.carrierId = (await loadCarrier(req.user, q.carrierId)).id;
  else if (q.scope === 'team' && canViewTeam(req.user)) owner.userId = { in: await teamMemberIds(req.user) };
  else owner.userId = req.user.id;

  const and = [owner];
  const view = q.view || q.range;
  if (view) {
    const vw = viewWhere(view, now);
    // Legacy `range=today` included earlier-today items; the new `view=today` starts now (overdue is its own view).
    if (q.range && !q.view && view === 'today') vw.dueAt = { gte: startOfToday(), lte: endOfToday() };
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

  const countFor = (v) => prisma.followUp.count({ where: { AND: [owner, viewWhere(v, now)] } });
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
  remindMinutesBefore: z.coerce.number().int().min(0).max(10080),
};

r.post('/', ah(async (req, res) => {
  const body = parse(z.object({
    carrierId: z.string().min(1), dueAt: z.coerce.date(),
    type: fields.type.default('call'), title: fields.title, note: fields.note,
    priority: fields.priority.default(0), recurrence: fields.recurrence.default('none'), remindMinutesBefore: fields.remindMinutesBefore.default(0),
  }), req.body);
  const carrier = await loadCarrier(req.user, body.carrierId, { write: true });
  const { carrierId, ...rest } = body;
  const fu = await prisma.followUp.create({ data: { ...rest, carrierId: carrier.id, userId: req.user.id }, include: { carrier: { select: carrierSelect } } });
  await syncNextFollowUp(carrier.id);
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
    dueAt: z.coerce.date().optional(), type: fields.type.optional(), title: fields.title, note: fields.note,
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
  res.json({ followUp: updated });
}));

/** Close a follow-up; recurring ones spawn their next occurrence. */
async function completeOne(user, fu, carrier, { outcome, note } = {}) {
  if (fu.status !== 'pending') throw badRequest('Follow-up is already closed');
  const now = new Date();
  const updated = await prisma.followUp.update({
    where: { id: fu.id },
    data: { status: 'done', completedAt: now, outcome: outcome ?? fu.outcome, note: note ? [fu.note, note].filter(Boolean).join('\n') : fu.note },
  });
  let next = null;
  if (fu.recurrence && fu.recurrence !== 'none') {
    let due = nextOccurrence(fu.dueAt, fu.recurrence);
    while (due && due <= now) due = nextOccurrence(due, fu.recurrence);
    if (due) {
      next = await prisma.followUp.create({
        data: {
          carrierId: fu.carrierId, userId: fu.userId, dueAt: due, type: fu.type, title: fu.title, note: fu.note,
          priority: fu.priority, recurrence: fu.recurrence, remindMinutesBefore: fu.remindMinutesBefore,
        },
      });
    }
  }
  await syncNextFollowUp(fu.carrierId);
  await logActivity(user, { type: 'follow_up', carrierId: carrier.id, summary: `Completed ${fu.type} follow-up with ${carrier.companyName}${outcome ? ` — ${outcome}` : ''}${note ? `: ${note.slice(0, 160)}` : ''}` });
  return { followUp: updated, next };
}

r.post('/:id/complete', ah(async (req, res) => {
  const { fu, carrier } = await loadFollowUp(req);
  const body = parse(z.object({ note: optStr(1000), outcome: optStr(500) }), req.body);
  res.json(await completeOne(req.user, fu, carrier, body));
}));

const snoozeSchema = z.object({ minutes: z.coerce.number().int().min(1).max(60 * 24 * 90).optional(), until: z.coerce.date().optional() })
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
  res.json({ followUp: updated });
}));

r.post('/bulk', ah(async (req, res) => {
  const body = parse(z.object({
    ids: z.array(z.string().max(40)).min(1).max(200),
    action: z.enum(['complete', 'snooze', 'reschedule', 'delete', 'priority', 'cancel']),
    minutes: z.coerce.number().int().min(1).max(60 * 24 * 90).optional(),
    until: z.coerce.date().optional(),
    dueAt: z.coerce.date().optional(),
    priority: z.coerce.number().int().min(0).max(2).optional(),
    outcome: optStr(500),
  }), req.body);
  if (body.action === 'snooze' && !body.minutes && !body.until) throw badRequest('Give minutes or until');
  if (body.action === 'reschedule' && !body.dueAt) throw badRequest('Give dueAt');
  if (body.action === 'priority' && body.priority == null) throw badRequest('Give priority');
  const out = { updated: 0, skipped: 0, notFound: 0 };
  const touched = new Set();
  for (const id of [...new Set(body.ids)]) {
    let row;
    try { row = await loadFollowUp(req, id); } catch (err) { if (err.status === 404 || err.status === 403) { out.notFound++; continue; } throw err; }
    const { fu, carrier } = row;
    touched.add(fu.carrierId);
    if (body.action === 'delete') { await prisma.followUp.delete({ where: { id: fu.id } }); out.updated++; continue; }
    if (body.action === 'priority') { await prisma.followUp.update({ where: { id: fu.id }, data: { priority: body.priority } }); out.updated++; continue; }
    if (fu.status !== 'pending') { out.skipped++; continue; }
    if (body.action === 'complete') await completeOne(req.user, fu, carrier, { outcome: body.outcome });
    else if (body.action === 'cancel') await prisma.followUp.update({ where: { id: fu.id }, data: { status: 'canceled', completedAt: new Date() } });
    else if (body.action === 'snooze') await prisma.followUp.update({ where: { id: fu.id }, data: { dueAt: snoozedDue(fu, body), snoozeCount: { increment: 1 }, notifiedAt: null } });
    else if (body.action === 'reschedule') await prisma.followUp.update({ where: { id: fu.id }, data: { dueAt: body.dueAt, notifiedAt: null } });
    out.updated++;
  }
  for (const cid of touched) await syncNextFollowUp(cid);
  res.json(out);
}));

r.delete('/:id', ah(async (req, res) => {
  const { fu } = await loadFollowUp(req);
  await prisma.followUp.delete({ where: { id: fu.id } });
  await syncNextFollowUp(fu.carrierId);
  res.json({ ok: true });
}));

export default r;
