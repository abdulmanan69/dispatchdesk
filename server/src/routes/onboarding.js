import { Router } from 'express';
import { prisma } from '../db.js';
import { ah } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';

/**
 * Getting-started checklist on the dashboard: one request with an indexed existence check per step, instead of the
 * client loading seven list endpoints (fleet map, sequences with steps, ...) just to see whether each is empty.
 * Every check is scoped to the signed-in user's own records.
 */
const r = Router();

const exists = async (p) => !!(await p);
const CHECKS = {
  calling: (u) => exists(prisma.callSettings.findUnique({ where: { userId: u.id }, select: { id: true } })),
  mailbox: (u) => exists(prisma.emailAccount.findFirst({ where: { userId: u.id }, select: { id: true } })),
  sequence: (u) => exists(prisma.emailSequence.findFirst({ where: { ownerId: u.id }, select: { id: true } })),
  // Two lookups instead of an OR, so each one stays on its own index.
  leads: async (u) => (await exists(prisma.carrier.findFirst({ where: { ownerId: u.id }, select: { id: true } })))
    || exists(prisma.carrier.findFirst({ where: { assignedToId: u.id }, select: { id: true } })),
  dialer: (u) => exists(prisma.call.findFirst({ where: { userId: u.id }, select: { id: true } })),
  extension: (u) => exists(prisma.apiToken.findFirst({ where: { userId: u.id }, select: { id: true } })),
  fleet: (u) => exists(prisma.carrier.findFirst({ where: { ownerId: u.id, isFleet: true, truckStatus: { not: 'unknown' } }, select: { id: true } })),
};
export const ONBOARDING_STEPS = Object.keys(CHECKS);

/** GET /api/onboarding/status?steps=calling,mailbox → { steps: { calling: true, mailbox: false } } (all steps when omitted). */
r.get('/status', ah(async (req, res) => {
  const q = parse(z.object({ steps: z.string().max(200).optional() }), req.query);
  const wanted = q.steps ? q.steps.split(',').filter((k) => CHECKS[k]) : ONBOARDING_STEPS;
  const values = await Promise.all(wanted.map((k) => CHECKS[k](req.user)));
  res.set('Cache-Control', 'private, no-store');
  res.json({ steps: Object.fromEntries(wanted.map((k, i) => [k, values[i]])) });
}));

export default r;
