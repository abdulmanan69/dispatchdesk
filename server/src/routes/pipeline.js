import { Router } from 'express';
import { prisma } from '../db.js';
import { ah } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { stages } from '../services/pipeline.js';
import { carrierFilterSchema, carrierWhere, listSelect, serializeCarrier } from '../services/carriers/query.js';

const r = Router();
r.use(requirePermission('crm.use'));

r.get('/stages', ah(async (req, res) => {
  const f = parse(carrierFilterSchema, req.query);
  const where = await carrierWhere(req.user, { ...f, stage: undefined });
  const grouped = await prisma.carrier.groupBy({ by: ['stageId'], where, _count: { _all: true } });
  const counts = new Map(grouped.map((g) => [g.stageId, g._count._all]));
  res.json({ items: (await stages()).map((s) => ({ id: s.id, key: s.key, name: s.name, color: s.color, count: counts.get(s.id) || 0 })) });
}));

r.get('/board', ah(async (req, res) => {
  const f = parse(carrierFilterSchema.extend({ perStage: z.coerce.number().int().min(1).max(200).default(30), includeArchived: z.enum(['true', 'false']).default('false') }), req.query);
  const all = await stages();
  const list = f.includeArchived === 'true' ? all : all.filter((s) => s.key !== 'archived');
  const columns = await Promise.all(list.map(async (s) => {
    const where = await carrierWhere(req.user, { ...f, stage: s.key });
    const [items, total] = await Promise.all([
      // List columns only (no FMCSA snapshot JSON or location data on board cards).
      prisma.carrier.findMany({ where, select: { ...listSelect, opportunity: { select: { estimatedValueCents: true, status: true } } }, orderBy: [{ priority: 'desc' }, { stageChangedAt: 'desc' }], take: f.perStage }),
      prisma.carrier.count({ where }),
    ]);
    return { key: s.key, name: s.name, color: s.color, total, items: items.map(serializeCarrier) };
  }));
  res.json({ columns });
}));

export default r;
