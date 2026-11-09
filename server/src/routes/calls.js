import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { parse, z, optStr, optDate, paginate, pageResult, pageQuery } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { loadCarrier, ownerWhere, canViewTeam } from '../lib/access.js';
import { CALL_OUTCOMES } from '../lib/constants.js';
import { logCall } from '../services/calls.js';

const r = Router();
r.use(requirePermission('crm.use'));

const callSchema = z.object({
  carrierId: z.string().min(1),
  outcome: z.enum(CALL_OUTCOMES),
  notes: optStr(4000),
  durationSec: z.coerce.number().int().min(0).max(36000).optional(),
  followUpAt: optDate,
  followUpNote: optStr(500),
  autoFollowUp: z.boolean().default(true),
  archive: z.boolean().default(false),
  attemptId: optStr(40), // telephony attempt this call came from (auto duration + provider)
});

/**
 * Log a call. Records the call, schedules the next step for the outcome, advances sequences,
 * moves the pipeline stage and runs automations (see services/calls.js).
 */
r.post('/', ah(async (req, res) => {
  const body = parse(callSchema, req.body);
  const carrier = await loadCarrier(req.user, body.carrierId, { write: true });
  let attempt = null;
  if (body.attemptId) {
    attempt = await prisma.callAttempt.findUnique({ where: { id: body.attemptId } });
    if (!attempt || attempt.userId !== req.user.id) throw notFound('Call attempt not found');
    if (attempt.callId) throw badRequest('This call was already logged');
  }
  const result = await logCall(req.user, carrier, body, { attempt });
  res.status(201).json(result);
}));

r.get('/', ah(async (req, res) => {
  const q = parse(z.object({
    ...pageQuery, carrierId: optStr(40), outcome: optStr(30), from: optDate, to: optDate, scope: z.enum(['mine', 'team']).default('mine'),
  }), req.query);
  const where = {
    ...(q.scope === 'team' && canViewTeam(req.user) ? await ownerWhere(req.user, 'team', 'userId') : { userId: req.user.id }),
    ...(q.outcome ? { outcome: q.outcome } : {}),
    ...(q.from || q.to ? { calledAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
  };
  if (q.carrierId) {
    const c = await loadCarrier(req.user, q.carrierId);
    delete where.userId;
    where.carrierId = c.id;
  }
  const [items, total] = await Promise.all([
    prisma.call.findMany({ where, orderBy: { calledAt: 'desc' }, include: { carrier: { select: { id: true, companyName: true, phone: true } }, user: { select: { id: true, name: true } } }, ...paginate(q) }),
    prisma.call.count({ where }),
  ]);
  res.json(pageResult(items, total, q));
}));

export default r;
