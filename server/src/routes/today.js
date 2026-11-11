import { Router } from 'express';
import { ah } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { canViewTeam } from '../lib/access.js';
import { todayBoard, todayCounts } from '../services/fleet/today.js';

/**
 * Today board: one prioritized action list for every load and truck (appointments, check calls, detention, empty trucks,
 * missing PODs, overdue invoices, follow-ups and paperwork). Built by services/fleet/today.js, cached 30 s per user.
 */
const r = Router();
r.use(requirePermission('crm.use'));

const query = z.object({ scope: z.enum(['mine', 'team']).default('mine') });

r.get('/', ah(async (req, res) => {
  const q = parse(query, req.query);
  const scope = q.scope === 'team' && canViewTeam(req.user) ? 'team' : 'mine';
  const board = await todayBoard(req.user, { scope });
  res.set('Cache-Control', 'private, no-store');
  res.json({ ...board, canViewTeam: canViewTeam(req.user) });
}));

/** Count of items that need action now (for a nav badge); only the two numbers are cached, not the whole board. */
r.get('/count', ah(async (req, res) => {
  res.json(await todayCounts(req.user));
}));

export default r;
