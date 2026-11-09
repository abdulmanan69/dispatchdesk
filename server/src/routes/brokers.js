import { Router } from 'express';
import { prisma } from '../db.js';
import { ah } from '../lib/errors.js';
import { parse, z, reqStr, optStr, optEmail, optInt, pageQuery, paginate, pageResult, clean } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { loadOwned, ownerWhere } from '../lib/access.js';
import { audit } from '../lib/audit.js';
import { withCalc } from '../services/loads/rateCalc.js';

const r = Router();
r.use(requirePermission('crm.use'));

const brokerFields = {
  companyName: reqStr(200),
  contactName: optStr(120),
  email: optEmail,
  phone: optStr(40),
  address: optStr(200),
  city: optStr(100),
  state: z.preprocess((v) => (v === '' || v == null ? null : String(v).trim().toUpperCase()), z.string().length(2).nullable().optional()),
  zip: optStr(12),
  mcNumber: z.preprocess((v) => (v === '' || v == null ? null : String(v).replace(/\D/g, '')), z.string().max(10).nullable().optional()),
  dotNumber: z.preprocess((v) => (v === '' || v == null ? null : String(v).replace(/\D/g, '')), z.string().max(10).nullable().optional()),
  paymentTerms: optStr(120),
  daysToPay: optInt(0, 365),
  creditRating: optStr(40),
  creditLimitCents: optInt(0, 1e11),
  notes: optStr(5000),
};

export function brokerStats(loads) {
  const counted = loads.filter((l) => l.status !== 'canceled');
  const revenueCents = counted.reduce((s, l) => s + l.rateCents, 0);
  const miles = counted.reduce((s, l) => s + l.loadedMiles, 0);
  const paid = counted.filter((l) => l.status === 'paid').length;
  return {
    loads: counted.length,
    revenueCents,
    loadedMiles: miles,
    avgRatePerMile: miles ? Math.round((revenueCents / 100 / miles) * 100) / 100 : null,
    avgRateCents: counted.length ? Math.round(revenueCents / counted.length) : null,
    paidLoads: paid,
    lastLoadAt: counted.map((l) => l.pickupDate || l.createdAt).sort((a, b) => b - a)[0] ?? null,
  };
}

r.get('/', ah(async (req, res) => {
  const q = parse(z.object({
    ...pageQuery,
    q: z.string().trim().max(100).optional(),
    state: z.string().trim().max(2).optional(),
    scope: z.enum(['mine', 'team']).default('mine'),
    sort: z.enum(['name', 'created', 'updated']).default('name'),
  }), req.query);
  const where = { ...(await ownerWhere(req.user, q.scope)) };
  if (q.q) where.OR = [{ companyName: { contains: q.q } }, { contactName: { contains: q.q } }, { mcNumber: { contains: q.q } }, { email: { contains: q.q } }, { phone: { contains: q.q } }];
  if (q.state) where.state = q.state.toUpperCase();
  const orderBy = { name: { companyName: 'asc' }, created: { createdAt: 'desc' }, updated: { updatedAt: 'desc' } }[q.sort];
  const [rows, total] = await Promise.all([
    prisma.broker.findMany({ where, orderBy, ...paginate(q), include: { loads: { select: { rateCents: true, loadedMiles: true, status: true, pickupDate: true, createdAt: true } } } }),
    prisma.broker.count({ where }),
  ]);
  const items = rows.map(({ loads, ...b }) => ({ ...b, stats: brokerStats(loads) }));
  res.json(pageResult(items, total, q));
}));

r.get('/:id', ah(async (req, res) => {
  const broker = await loadOwned('broker', req.user, req.params.id);
  const loads = await prisma.load.findMany({
    where: { brokerId: broker.id }, orderBy: [{ pickupDate: 'desc' }, { createdAt: 'desc' }], take: 200,
    include: { carrier: { select: { id: true, companyName: true } } },
  });
  const emails = await prisma.email.findMany({ where: { brokerId: broker.id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, subject: true, status: true, sentAt: true, createdAt: true, toEmail: true } });
  res.json({ broker, stats: brokerStats(loads), loads: loads.map(withCalc), emails });
}));

r.post('/', ah(async (req, res) => {
  const body = parse(z.object(brokerFields), req.body);
  const broker = await prisma.broker.create({ data: { ...clean(body), ownerId: req.user.id } });
  res.status(201).json({ broker });
}));

r.patch('/:id', ah(async (req, res) => {
  const broker = await loadOwned('broker', req.user, req.params.id, { write: true });
  const body = parse(z.object(brokerFields).partial(), req.body);
  res.json({ broker: await prisma.broker.update({ where: { id: broker.id }, data: clean(body) }) });
}));

r.delete('/:id', ah(async (req, res) => {
  const broker = await loadOwned('broker', req.user, req.params.id, { write: true });
  await prisma.broker.delete({ where: { id: broker.id } });
  await audit(req, 'broker.deleted', { entityType: 'broker', entityId: broker.id, details: { name: broker.companyName } });
  res.json({ ok: true });
}));

export default r;
