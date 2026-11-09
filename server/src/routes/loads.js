import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest } from '../lib/errors.js';
import { parse, z, reqStr, optStr, optInt, optNum, optDate, pageQuery, paginate, pageResult, clean } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { loadCarrier, loadOwned, ownerWhere } from '../lib/access.js';
import { LOAD_STATUSES, EQUIPMENT } from '../lib/constants.js';
import { logActivity } from '../lib/activity.js';
import { calculateLoad, withCalc } from '../services/loads/rateCalc.js';
import { parseLoadText } from '../services/loads/parser.js';

const r = Router();
r.use(requirePermission('crm.use'));

const state = z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z]{2}$/, 'Use a 2-letter state code'));
const zeroIfNull = (schema) => schema.transform((v) => (v === null ? 0 : v));

const calcFields = {
  rateCents: z.coerce.number().int().min(0).max(1e9),
  loadedMiles: z.coerce.number().int().min(1, 'Loaded miles must be at least 1').max(20000),
  deadheadMiles: zeroIfNull(optInt(0, 5000)),
  detentionHours: zeroIfNull(optNum(0, 500)),
  detentionRateCents: zeroIfNull(optInt(0, 1e6)),
  fuelPricePerGallon: optNum(0, 20),
  mpg: optNum(1, 30),
  otherCostsCents: zeroIfNull(optInt(0, 1e8)),
  dispatchFeePercent: optNum(0, 100),
};

const loadFields = {
  ...calcFields,
  referenceNumber: optStr(60),
  originCity: reqStr(100),
  originState: state,
  destCity: reqStr(100),
  destState: state,
  pickupDate: optDate,
  deliveryDate: optDate,
  equipment: z.preprocess((v) => (v === '' ? null : v), z.enum(EQUIPMENT).nullable().optional()),
  commodity: optStr(120),
  weightLbs: optInt(0, 200000),
  status: z.enum(LOAD_STATUSES).optional(),
  notes: optStr(5000),
  brokerId: optStr(40),
  carrierId: optStr(40),
};

const include = {
  broker: { select: { id: true, companyName: true, phone: true, email: true } },
  carrier: { select: { id: true, companyName: true, mcNumber: true } },
};

/** Validate that referenced broker / carrier belong to the user (or are writable through the team). */
async function checkRefs(user, body) {
  if (body.brokerId) await loadOwned('broker', user, body.brokerId);
  if (body.carrierId) await loadCarrier(user, body.carrierId);
}

function checkDates(body) {
  if (body.pickupDate && body.deliveryDate && body.deliveryDate < body.pickupDate) throw badRequest('Delivery date cannot be before pickup date');
}

r.post('/calculate', ah(async (req, res) => {
  const body = parse(z.object({ ...calcFields, loadedMiles: z.coerce.number().int().min(0).max(20000) }), req.body);
  res.json({ calc: calculateLoad(body) });
}));

r.post('/parse', ah(async (req, res) => {
  const { text } = parse(z.object({ text: z.string().min(5, 'Paste some load details first').max(20000) }), req.body);
  res.json(parseLoadText(text));
}));

r.get('/lanes', ah(async (req, res) => {
  const q = parse(z.object({ scope: z.enum(['mine', 'team']).default('mine'), originState: z.string().max(2).optional(), destState: z.string().max(2).optional() }), req.query);
  const where = { ...(await ownerWhere(req.user, q.scope)), status: { not: 'canceled' } };
  if (q.originState) where.originState = q.originState.toUpperCase();
  if (q.destState) where.destState = q.destState.toUpperCase();
  const rows = await prisma.load.findMany({ where, select: { originState: true, destState: true, originCity: true, destCity: true, rateCents: true, loadedMiles: true, pickupDate: true, createdAt: true } });
  const lanes = new Map();
  for (const l of rows) {
    const key = `${l.originState}-${l.destState}`;
    const rpm = l.loadedMiles > 0 ? l.rateCents / 100 / l.loadedMiles : null;
    const lane = lanes.get(key) || { originState: l.originState, destState: l.destState, loads: 0, totalRateCents: 0, totalMiles: 0, minRatePerMile: null, maxRatePerMile: null, lastLoadAt: null };
    lane.loads += 1;
    lane.totalRateCents += l.rateCents;
    lane.totalMiles += l.loadedMiles;
    if (rpm != null) {
      lane.minRatePerMile = lane.minRatePerMile == null ? rpm : Math.min(lane.minRatePerMile, rpm);
      lane.maxRatePerMile = lane.maxRatePerMile == null ? rpm : Math.max(lane.maxRatePerMile, rpm);
    }
    const when = l.pickupDate || l.createdAt;
    if (!lane.lastLoadAt || when > lane.lastLoadAt) lane.lastLoadAt = when;
    lanes.set(key, lane);
  }
  const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
  const items = [...lanes.values()]
    .map((l) => ({ ...l, avgRatePerMile: l.totalMiles ? r2(l.totalRateCents / 100 / l.totalMiles) : null, minRatePerMile: r2(l.minRatePerMile), maxRatePerMile: r2(l.maxRatePerMile) }))
    .sort((a, b) => b.loads - a.loads);
  res.json({ items, note: 'Lane history is computed only from loads recorded in this workspace — not market rates.' });
}));

r.get('/', ah(async (req, res) => {
  const q = parse(z.object({
    ...pageQuery,
    status: z.enum([...LOAD_STATUSES, 'active', 'all']).default('all'),
    brokerId: z.string().optional(),
    carrierId: z.string().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    originState: z.string().max(2).optional(),
    destState: z.string().max(2).optional(),
    q: z.string().trim().max(100).optional(),
    scope: z.enum(['mine', 'team']).default('mine'),
    sort: z.enum(['pickup', 'created', 'rate', 'rpm']).default('pickup'),
  }), req.query);
  const where = { ...(await ownerWhere(req.user, q.scope)) };
  if (q.status === 'active') where.status = { in: ['planned', 'booked', 'in_transit'] };
  else if (q.status !== 'all') where.status = q.status;
  if (q.brokerId) where.brokerId = q.brokerId;
  if (q.carrierId) where.carrierId = q.carrierId;
  if (q.from || q.to) where.pickupDate = { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: new Date(q.to.getTime() + 86399999) } : {}) };
  if (q.originState) where.originState = q.originState.toUpperCase();
  if (q.destState) where.destState = q.destState.toUpperCase();
  if (q.q) where.OR = [{ referenceNumber: { contains: q.q } }, { commodity: { contains: q.q } }, { originCity: { contains: q.q } }, { destCity: { contains: q.q } }];
  const orderBy = { pickup: [{ pickupDate: 'desc' }, { createdAt: 'desc' }], created: [{ createdAt: 'desc' }], rate: [{ rateCents: 'desc' }], rpm: [{ createdAt: 'desc' }] }[q.sort];
  const [rows, total, agg] = await Promise.all([
    prisma.load.findMany({ where, orderBy, ...paginate(q), include }),
    prisma.load.count({ where }),
    prisma.load.aggregate({ where: { ...where, ...(q.status === 'all' ? { status: { not: 'canceled' } } : {}) }, _sum: { rateCents: true, loadedMiles: true, deadheadMiles: true }, _count: true }),
  ]);
  let items = rows.map(withCalc);
  if (q.sort === 'rpm') items = items.sort((a, b) => (b.calc.ratePerMile ?? 0) - (a.calc.ratePerMile ?? 0));
  const miles = agg._sum.loadedMiles || 0;
  res.json({
    ...pageResult(items, total, q),
    summary: {
      loads: agg._count, rateCents: agg._sum.rateCents || 0, loadedMiles: miles, deadheadMiles: agg._sum.deadheadMiles || 0,
      avgRatePerMile: miles ? Math.round(((agg._sum.rateCents || 0) / 100 / miles) * 100) / 100 : null,
    },
  });
}));

r.get('/:id', ah(async (req, res) => {
  const load = await loadOwned('load', req.user, req.params.id);
  const full = await prisma.load.findUnique({ where: { id: load.id }, include: { ...include, documents: { orderBy: { createdAt: 'desc' }, select: { id: true, type: true, originalName: true, createdAt: true } } } });
  res.json({ load: withCalc(full) });
}));

r.post('/', ah(async (req, res) => {
  const body = parse(z.object(loadFields), req.body);
  checkDates(body);
  await checkRefs(req.user, body);
  const load = await prisma.load.create({ data: { ...clean(body), ownerId: req.user.id }, include });
  await logActivity(req.user, {
    type: 'load', carrierId: load.carrierId,
    summary: `Added load ${load.originCity}, ${load.originState} → ${load.destCity}, ${load.destState} at $${(load.rateCents / 100).toLocaleString('en-US')}`,
  });
  res.status(201).json({ load: withCalc(load) });
}));

r.patch('/:id', ah(async (req, res) => {
  const existing = await loadOwned('load', req.user, req.params.id, { write: true });
  const body = parse(z.object(loadFields).partial(), req.body);
  checkDates({ pickupDate: body.pickupDate ?? existing.pickupDate, deliveryDate: body.deliveryDate ?? existing.deliveryDate });
  await checkRefs(req.user, body);
  const load = await prisma.load.update({ where: { id: existing.id }, data: clean(body), include });
  if (body.status && body.status !== existing.status) {
    await logActivity(req.user, { type: 'load', carrierId: load.carrierId, summary: `Load ${load.referenceNumber || `${load.originCity} → ${load.destCity}`} is now ${body.status.replace('_', ' ')}` });
  }
  res.json({ load: withCalc(load) });
}));

r.delete('/:id', ah(async (req, res) => {
  const load = await loadOwned('load', req.user, req.params.id, { write: true });
  const docs = await prisma.document.findMany({ where: { loadId: load.id }, select: { storedName: true } });
  await prisma.load.delete({ where: { id: load.id } });
  const { removeFile } = await import('../middleware/upload.js');
  for (const d of docs) removeFile('documents', d.storedName);
  res.json({ ok: true });
}));

export default r;
