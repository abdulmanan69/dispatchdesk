import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, notFound } from '../lib/errors.js';
import { parse, z, pageQuery, paginate, pageResult } from '../lib/validate.js';

const r = Router();

r.get('/', ah(async (req, res) => {
  const q = parse(z.object({ ...pageQuery, unread: z.enum(['0', '1', 'true', 'false']).optional(), type: z.string().max(40).optional() }), req.query);
  const where = { userId: req.user.id };
  if (q.unread === '1' || q.unread === 'true') where.readAt = null;
  if (q.type) where.type = q.type;
  const [items, total, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q) }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
  ]);
  res.json({ ...pageResult(items, total, q), unread });
}));

/** Unread count only (one indexed count): what the bell badge polls. The list is fetched when the menu opens. */
r.get('/unread-count', ah(async (req, res) => {
  const unread = await prisma.notification.count({ where: { userId: req.user.id, readAt: null } });
  res.set('Cache-Control', 'private, no-store');
  res.json({ unread });
}));

r.post('/read-all', ah(async (req, res) => {
  const result = await prisma.notification.updateMany({ where: { userId: req.user.id, readAt: null }, data: { readAt: new Date() } });
  res.json({ updated: result.count });
}));

r.post('/:id/read', ah(async (req, res) => {
  const result = await prisma.notification.updateMany({ where: { id: String(req.params.id), userId: req.user.id }, data: { readAt: new Date() } });
  if (!result.count) throw notFound('Notification not found');
  res.json({ ok: true });
}));

r.delete('/:id', ah(async (req, res) => {
  const result = await prisma.notification.deleteMany({ where: { id: String(req.params.id), userId: req.user.id } });
  if (!result.count) throw notFound('Notification not found');
  res.json({ ok: true });
}));

export default r;
