import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';

/** First-time guided tours: which tours a user finished or skipped, stored as JSON on the user. */
export const TOUR_IDS = ['welcome', 'lead-generator', 'dialer', 'fleet', 'email', 'follow-ups', 'admin-setup', 'getting-started'];

const r = Router();

function readState(user) {
  try {
    const s = JSON.parse(user.tourState || '{}');
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

r.get('/', ah(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { tourState: true } });
  res.json({ state: readState(user), tours: TOUR_IDS });
}));

r.post('/reset', ah(async (req, res) => {
  await prisma.user.update({ where: { id: req.user.id }, data: { tourState: '{}' } });
  res.json({ state: {} });
}));

r.post('/:id', ah(async (req, res) => {
  if (!TOUR_IDS.includes(req.params.id)) throw badRequest('Unknown tour');
  const body = parse(z.object({ status: z.enum(['done', 'skipped', 'reset']) }), req.body);
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { tourState: true } });
  const state = readState(user);
  if (body.status === 'reset') delete state[req.params.id];
  else state[req.params.id] = { [body.status]: true, at: new Date().toISOString() };
  await prisma.user.update({ where: { id: req.user.id }, data: { tourState: JSON.stringify(state) } });
  res.json({ state });
}));

export default r;
