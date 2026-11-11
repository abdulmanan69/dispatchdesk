import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { ah, badRequest } from '../lib/errors.js';
import { parse, z, reqStr, optStr, optEmail, optInt, pageQuery, paginate, pageResult, clean } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { makeLimiter } from '../middleware/security.js';
import { loadOwned, ownerWhere } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { withCalc } from '../services/loads/rateCalc.js';
import { normDot, normMc } from '../services/carriers/normalize.js';
import { vet, verifyAndStore, setTeamFlag, vettingView, knownContacts, parseJson } from '../services/brokers/vetting.js';
import { qcConfigured } from '../services/brokers/fmcsa.js';

const r = Router();
r.use(requirePermission('crm.use'));

/** FMCSA checks per user (shared across cluster workers): FMCSA's free services are rate limited. */
const verifyLimiter = makeLimiter('brokerverify', 60_000, 30, 'Too many broker checks. Try again in a minute.');

const digitsOnly = (v) => (v === '' || v == null ? null : String(v).replace(/\D/g, '').replace(/^0+/, '') || null);
const brokerFields = {
  companyName: reqStr(200),
  contactName: optStr(120),
  email: optEmail,
  phone: optStr(40),
  address: optStr(200),
  city: optStr(100),
  state: z.preprocess((v) => (v === '' || v == null ? null : String(v).trim().toUpperCase()), z.string().length(2).nullable().optional()),
  zip: optStr(12),
  mcNumber: z.preprocess(digitsOnly, z.string().max(10).nullable().optional()),
  dotNumber: z.preprocess(digitsOnly, z.string().max(10).nullable().optional()),
  paymentTerms: optStr(120),
  daysToPay: optInt(0, 365),
  creditRating: optStr(40),
  creditLimitCents: optInt(0, 1e11),
  notes: optStr(5000),
  watch: z.boolean().optional(),
};

const n = (v) => (v == null ? 0 : Number(v));
const toDate = (v) => (v == null ? null : new Date(v));

/** Load stats per broker from one aggregate (canceled loads excluded). */
async function statsFor(brokerIds) {
  if (!brokerIds.length) return new Map();
  const rows = await prisma.$queryRaw`
    SELECT brokerId, COUNT(*) AS loads, SUM(rateCents) AS rateCents, SUM(loadedMiles) AS miles,
           SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
           MAX(COALESCE(pickupDate, createdAt)) AS lastAt
    FROM Load WHERE brokerId IN (${Prisma.join(brokerIds)}) AND status <> 'canceled'
    GROUP BY brokerId`;
  return new Map(rows.map((row) => [row.brokerId, row]));
}

export function statsView(row) {
  const loads = n(row?.loads);
  const revenueCents = n(row?.rateCents);
  const miles = n(row?.miles);
  return {
    loads,
    revenueCents,
    loadedMiles: miles,
    avgRatePerMile: miles ? Math.round((revenueCents / 100 / miles) * 100) / 100 : null,
    avgRateCents: loads ? Math.round(revenueCents / loads) : null,
    paidLoads: n(row?.paid),
    lastLoadAt: toDate(row?.lastAt),
  };
}

/** Real payment history from this workspace's paid freight invoices to the broker. */
async function paymentHistory(brokerId) {
  const [paid, open] = await Promise.all([
    prisma.invoice.findMany({
      where: { brokerId, kind: 'freight', status: 'paid', issuedAt: { not: null }, paidAt: { not: null } },
      select: { issuedAt: true, paidAt: true }, orderBy: { paidAt: 'desc' }, take: 200,
    }),
    prisma.invoice.aggregate({ where: { brokerId, status: { in: ['sent', 'partial'] } }, _sum: { amountCents: true, paidCents: true }, _count: true }),
  ]);
  const days = paid.map((i) => Math.max(0, (i.paidAt - i.issuedAt) / 86_400_000));
  return {
    paidInvoices: paid.length,
    avgDaysToPay: days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : null,
    openInvoices: open._count,
    openCents: n(open._sum.amountCents) - n(open._sum.paidCents),
  };
}

r.get('/', ah(async (req, res) => {
  const q = parse(z.object({
    ...pageQuery,
    q: z.string().trim().max(100).optional(),
    state: z.string().trim().max(2).optional(),
    mc: z.string().trim().max(12).optional(),
    scope: z.enum(['mine', 'team']).default('mine'),
    sort: z.enum(['name', 'created', 'updated']).default('name'),
  }), req.query);
  const where = { ...(await ownerWhere(req.user, q.scope)) };
  if (q.q) where.OR = [{ companyName: { contains: q.q } }, { contactName: { contains: q.q } }, { mcNumber: { contains: q.q } }, { email: { contains: q.q } }, { phone: { contains: q.q } }];
  if (q.state) where.state = q.state.toUpperCase();
  if (q.mc) where.mcNumber = normMc(q.mc) || '-';
  const orderBy = { name: { companyName: 'asc' }, created: { createdAt: 'desc' }, updated: { updatedAt: 'desc' } }[q.sort];
  const [rows, total] = await Promise.all([prisma.broker.findMany({ where, orderBy, ...paginate(q) }), prisma.broker.count({ where })]);
  const stats = await statsFor(rows.map((b) => b.id));
  const items = rows.map(({ fmcsaSnapshot, flags, ...b }) => {
    const v = vettingView({ fmcsaSnapshot, flags, fmcsaCheckedAt: b.fmcsaCheckedAt, watch: b.watch });
    return { ...b, stats: statsView(stats.get(b.id)), vetting: { level: v.level, checkedAt: v.checkedAt, doNotUse: !!v.teamFlag, flags: v.flags.length } };
  });
  res.json(pageResult(items, total, q));
}));

/**
 * FMCSA vetting for an MC/USDOT number without saving (rate-con flow and the broker form).
 * Optional rate-con contact (phone, email) is compared with FMCSA-listed and saved contacts; brokerId adds the saved
 * broker's contacts and its previous snapshot.
 */
r.get('/verify', verifyLimiter, ah(async (req, res) => {
  const q = parse(z.object({
    mc: z.string().max(12).optional(), dot: z.string().max(12).optional(),
    phone: z.string().max(40).optional(), email: z.string().max(254).optional(), brokerId: z.string().max(40).optional(),
  }), req.query);
  const mc = normMc(q.mc);
  const dot = normDot(q.dot);
  if (!mc && !dot) throw badRequest('Enter an MC or USDOT number');
  const broker = q.brokerId ? await loadOwned('broker', req.user, q.brokerId) : null;
  const result = await vet({ mc, dot, rateCon: { phone: q.phone, email: q.email }, known: knownContacts(broker), previous: parseJson(broker?.fmcsaSnapshot, null) });
  res.json({ vetting: { ...result, checkedAt: result.snapshot?.checkedAt ?? null, qcConfigured: await qcConfigured() } });
}));

r.get('/:id', ah(async (req, res) => {
  const broker = await loadOwned('broker', req.user, req.params.id);
  const [loads, statsMap, emails, payments] = await Promise.all([
    prisma.load.findMany({
      where: { brokerId: broker.id }, orderBy: [{ pickupDate: 'desc' }, { createdAt: 'desc' }], take: 100,
      include: { carrier: { select: { id: true, companyName: true } } },
      omit: { routeGeometry: true },
    }),
    statsFor([broker.id]),
    prisma.email.findMany({ where: { brokerId: broker.id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, subject: true, status: true, sentAt: true, createdAt: true, toEmail: true } }),
    paymentHistory(broker.id),
  ]);
  const { fmcsaSnapshot, flags, ...b } = broker;
  res.json({
    broker: b,
    vetting: { ...vettingView(broker), qcConfigured: await qcConfigured() },
    stats: statsView(statsMap.get(broker.id)),
    payments,
    loads: loads.map(withCalc),
    emails,
  });
}));

r.post('/', ah(async (req, res) => {
  const body = parse(z.object(brokerFields), req.body);
  const duplicates = body.mcNumber || body.dotNumber
    ? await prisma.broker.findMany({
      where: { ...(await ownerWhere(req.user, 'team')), OR: [body.mcNumber && { mcNumber: body.mcNumber }, body.dotNumber && { dotNumber: body.dotNumber }].filter(Boolean) },
      select: { id: true, companyName: true, mcNumber: true }, take: 3,
    })
    : [];
  const broker = await prisma.broker.create({ data: { ...clean(body), ownerId: req.user.id } });
  res.status(201).json({ broker, duplicates });
}));

r.patch('/:id', ah(async (req, res) => {
  const broker = await loadOwned('broker', req.user, req.params.id, { write: true });
  const body = parse(z.object(brokerFields).partial(), req.body);
  const updated = await prisma.broker.update({ where: { id: broker.id }, data: clean(body) });
  const { fmcsaSnapshot, flags, ...b } = updated;
  res.json({ broker: b, vetting: vettingView(updated) });
}));

/** Run the FMCSA check for a saved broker and store the snapshot and flags. */
r.post('/:id/verify', verifyLimiter, ah(async (req, res) => {
  const broker = await loadOwned('broker', req.user, req.params.id, { write: true });
  const body = parse(z.object({ phone: z.string().max(40).optional(), email: z.string().max(254).optional() }), req.body);
  if (!normMc(broker.mcNumber) && !normDot(broker.dotNumber)) throw badRequest('Add the broker’s MC or USDOT number first');
  const updated = await verifyAndStore(broker, { rateCon: { phone: body.phone, email: body.email } });
  const { fmcsaSnapshot, flags, ...b } = updated;
  res.json({ broker: b, vetting: { ...vettingView(updated), qcConfigured: await qcConfigured() } });
}));

/** The team's private "do not use" flag (visible only inside this workspace). */
r.patch('/:id/flag', ah(async (req, res) => {
  const broker = await loadOwned('broker', req.user, req.params.id, { write: true });
  const body = parse(z.object({ doNotUse: z.boolean(), reason: optStr(500) }), req.body);
  const updated = await setTeamFlag(broker, { doNotUse: body.doNotUse, reason: body.reason, user: req.user });
  await audit(req, body.doNotUse ? 'broker.flagged' : 'broker.unflagged', { entityType: 'broker', entityId: broker.id, details: { reason: body.reason || null } });
  res.json({ vetting: vettingView(updated) });
}));

r.delete('/:id', ah(async (req, res) => {
  const broker = await loadOwned('broker', req.user, req.params.id, { write: true });
  await prisma.broker.delete({ where: { id: broker.id } });
  await audit(req, 'broker.deleted', { entityType: 'broker', entityId: broker.id, details: { name: broker.companyName } });
  res.json({ ok: true });
}));

export default r;
