import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, notFound } from '../lib/errors.js';
import { parse, z, optStr, optInt, optNum, reqStr, pageQuery, paginate, pageResult, clean } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { loadCarrier, ownerWhere } from '../lib/access.js';
import { CUSTOMER_STATUSES } from '../lib/constants.js';
import { logActivity } from '../lib/activity.js';
import { changeStage } from '../services/pipeline.js';
import { withCalc, calculateLoad } from '../services/loads/rateCalc.js';

const r = Router();
r.use(requirePermission('crm.use'));

export const REQUIRED_DOCS = ['agreement', 'mc_authority', 'w9', 'coi'];
const EXPIRING_DAYS = 30;

/** Compliance checklist from a carrier's documents: missing / on file / expiring / expired. */
export function docChecklist(documents, now = new Date()) {
  return REQUIRED_DOCS.map((type) => {
    const docs = documents.filter((d) => d.type === type).sort((a, b) => b.createdAt - a.createdAt);
    const latest = docs[0];
    let status = 'missing';
    if (latest) {
      status = 'on_file';
      if (latest.expiresAt) {
        const days = (new Date(latest.expiresAt) - now) / 86400000;
        if (days < 0) status = 'expired';
        else if (days <= EXPIRING_DAYS) status = 'expiring';
      }
    }
    return { type, status, documentId: latest?.id ?? null, expiresAt: latest?.expiresAt ?? null };
  });
}

function revenueSummary(loads) {
  let grossCents = 0;
  let feeCents = 0;
  let miles = 0;
  let rateCents = 0;
  const counted = loads.filter((l) => l.status !== 'canceled');
  for (const l of counted) {
    const c = calculateLoad(l);
    grossCents += c.grossCents;
    feeCents += c.dispatchFeeCents ?? 0;
    miles += l.loadedMiles;
    rateCents += l.rateCents;
  }
  return { loads: counted.length, grossCents, dispatchFeeCents: feeCents, loadedMiles: miles, avgRatePerMile: miles ? Math.round((rateCents / 100 / miles) * 100) / 100 : null };
}

async function loadCustomer(user, id, write = false) {
  const customer = await prisma.customer.findUnique({ where: { id: String(id) } });
  if (!customer) throw notFound('Customer not found');
  const carrier = await loadCarrier(user, customer.carrierId, { write });
  return { customer, carrier };
}

r.get('/', ah(async (req, res) => {
  const q = parse(z.object({
    ...pageQuery,
    status: z.enum([...CUSTOMER_STATUSES, 'all']).default('all'),
    q: z.string().trim().max(100).optional(),
    scope: z.enum(['mine', 'team']).default('mine'),
    sort: z.enum(['signed', 'name', 'updated']).default('signed'),
  }), req.query);
  const where = { ...(await ownerWhere(req.user, q.scope)) };
  if (q.status !== 'all') where.status = q.status;
  if (q.q) where.carrier = { OR: [{ companyName: { contains: q.q } }, { mcNumber: { contains: q.q } }, { dotNumber: { contains: q.q } }, { phone: { contains: q.q } }] };
  const orderBy = { signed: { signedAt: 'desc' }, name: { carrier: { companyName: 'asc' } }, updated: { updatedAt: 'desc' } }[q.sort];
  const [rows, total, statusCounts] = await Promise.all([
    prisma.customer.findMany({
      where, orderBy, ...paginate(q),
      include: {
        carrier: {
          select: {
            id: true, companyName: true, mcNumber: true, dotNumber: true, phone: true, email: true, city: true, state: true, equipment: true, fleetSize: true,
            assignedTo: { select: { id: true, name: true } },
            documents: { where: { type: { in: REQUIRED_DOCS } }, select: { id: true, type: true, expiresAt: true, createdAt: true } },
            loads: { where: { status: { not: 'canceled' } }, select: { rateCents: true, loadedMiles: true, deadheadMiles: true, detentionHours: true, detentionRateCents: true, dispatchFeePercent: true, status: true } },
          },
        },
        owner: { select: { id: true, name: true } },
      },
    }),
    prisma.customer.count({ where }),
    prisma.customer.groupBy({ by: ['status'], where: await ownerWhere(req.user, q.scope), _count: true }),
  ]);
  const items = rows.map(({ carrier, ...c }) => {
    const { documents, loads, ...carrierInfo } = carrier;
    const checklist = docChecklist(documents);
    return {
      ...c, carrier: carrierInfo,
      compliance: { missing: checklist.filter((x) => x.status === 'missing').length, expiring: checklist.filter((x) => x.status === 'expiring' || x.status === 'expired').length },
      revenue: revenueSummary(loads.map((l) => ({ ...l, dispatchFeePercent: l.dispatchFeePercent ?? c.dispatchFeePercent }))),
    };
  });
  res.json({ ...pageResult(items, total, q), summary: Object.fromEntries(statusCounts.map((s) => [s.status, s._count])) });
}));

r.get('/:id', ah(async (req, res) => {
  const { customer } = await loadCustomer(req.user, req.params.id);
  const [carrier, lanes, documents, loads, activities] = await Promise.all([
    prisma.carrier.findUnique({
      where: { id: customer.carrierId },
      include: { contacts: { orderBy: { isPrimary: 'desc' } }, tags: { include: { tag: true } }, assignedTo: { select: { id: true, name: true } }, stage: true },
    }),
    prisma.customerLane.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: 'asc' } }),
    prisma.document.findMany({ where: { carrierId: customer.carrierId }, orderBy: { createdAt: 'desc' }, select: { id: true, type: true, originalName: true, expiresAt: true, createdAt: true, sizeBytes: true, mimeType: true } }),
    prisma.load.findMany({ where: { carrierId: customer.carrierId }, orderBy: [{ pickupDate: 'desc' }, { createdAt: 'desc' }], take: 100, include: { broker: { select: { id: true, companyName: true } } } }),
    prisma.activity.findMany({ where: { carrierId: customer.carrierId }, orderBy: { createdAt: 'desc' }, take: 20, include: { user: { select: { name: true } } } }),
  ]);
  const loadsWithFee = loads.map((l) => withCalc({ ...l, dispatchFeePercent: l.dispatchFeePercent ?? customer.dispatchFeePercent }));
  // Brokers this carrier has hauled for, derived from load history.
  const brokers = new Map();
  for (const l of loads) if (l.broker) brokers.set(l.broker.id, { ...l.broker, loads: (brokers.get(l.broker.id)?.loads || 0) + 1 });
  res.json({
    customer: { ...customer, carrier, lanes },
    documents,
    checklist: docChecklist(documents),
    loads: loadsWithFee,
    revenue: revenueSummary(loadsWithFee),
    brokers: [...brokers.values()],
    activities,
  });
}));

r.patch('/:id', ah(async (req, res) => {
  const { customer, carrier } = await loadCustomer(req.user, req.params.id, true);
  const body = parse(z.object({
    status: z.enum(CUSTOMER_STATUSES).optional(),
    dispatchFeePercent: optNum(0, 100),
    minRatePerMile: optNum(0, 100),
    maxDeadheadMiles: optInt(0, 5000),
    homeBase: optStr(200),
    notes: optStr(5000),
  }), req.body);
  const updated = await prisma.customer.update({ where: { id: customer.id }, data: clean(body) });
  if (body.status && body.status !== customer.status) {
    await logActivity(req.user, { type: 'customer', carrierId: carrier.id, summary: `Customer ${carrier.companyName} status changed to ${body.status}` });
  }
  res.json({ customer: updated });
}));

r.delete('/:id', ah(async (req, res) => {
  const { customer, carrier } = await loadCustomer(req.user, req.params.id, true);
  await prisma.customer.delete({ where: { id: customer.id } });
  await changeStage(req.user, carrier, 'archived', { reason: 'customer removed' });
  res.json({ ok: true });
}));

const laneSchema = z.object({ origin: reqStr(120), destination: reqStr(120), notes: optStr(500) });

r.post('/:id/lanes', ah(async (req, res) => {
  const { customer } = await loadCustomer(req.user, req.params.id, true);
  const body = parse(laneSchema, req.body);
  const lane = await prisma.customerLane.create({ data: { ...body, customerId: customer.id } });
  res.status(201).json({ lane });
}));

r.patch('/:id/lanes/:laneId', ah(async (req, res) => {
  const { customer } = await loadCustomer(req.user, req.params.id, true);
  const body = parse(laneSchema.partial(), req.body);
  const lane = await prisma.customerLane.findFirst({ where: { id: String(req.params.laneId), customerId: customer.id } });
  if (!lane) throw notFound('Lane not found');
  res.json({ lane: await prisma.customerLane.update({ where: { id: lane.id }, data: clean(body) }) });
}));

r.delete('/:id/lanes/:laneId', ah(async (req, res) => {
  const { customer } = await loadCustomer(req.user, req.params.id, true);
  const result = await prisma.customerLane.deleteMany({ where: { id: String(req.params.laneId), customerId: customer.id } });
  if (!result.count) throw notFound('Lane not found');
  res.json({ ok: true });
}));

export default r;
