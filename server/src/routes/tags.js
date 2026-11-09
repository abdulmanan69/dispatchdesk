import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, notFound } from '../lib/errors.js';
import { parse, z, reqStr } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';

const r = Router();
r.use(requirePermission('crm.use'));

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #2563eb');

r.get('/', ah(async (req, res) => {
  const tags = await prisma.tag.findMany({ where: { ownerId: req.user.id }, orderBy: { name: 'asc' }, include: { _count: { select: { carriers: true } } } });
  res.json({ items: tags.map((t) => ({ id: t.id, name: t.name, color: t.color, carrierCount: t._count.carriers })) });
}));

r.post('/', ah(async (req, res) => {
  const body = parse(z.object({ name: reqStr(40), color: color.optional() }), req.body);
  const tag = await prisma.tag.create({ data: { ownerId: req.user.id, name: body.name, color: body.color || '#2563eb' } });
  res.status(201).json({ tag });
}));

async function own(req) {
  const tag = await prisma.tag.findFirst({ where: { id: req.params.id, ownerId: req.user.id } });
  if (!tag) throw notFound('Tag not found');
  return tag;
}

r.patch('/:id', ah(async (req, res) => {
  const tag = await own(req);
  const body = parse(z.object({ name: reqStr(40).optional(), color: color.optional() }), req.body);
  res.json({ tag: await prisma.tag.update({ where: { id: tag.id }, data: body }) });
}));

r.delete('/:id', ah(async (req, res) => {
  const tag = await own(req);
  await prisma.tag.delete({ where: { id: tag.id } });
  res.json({ ok: true });
}));

export default r;
