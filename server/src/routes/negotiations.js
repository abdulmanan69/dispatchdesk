import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, forbidden } from '../lib/errors.js';
import { parse, z, optStr, optInt, optEmail, pageQuery, paginate, pageResult } from '../lib/validate.js';
import { ownerWhere } from '../lib/access.js';
import { EQUIPMENT } from '../lib/constants.js';
import { requirePermission, hasPermission } from '../middleware/auth.js';
import { aiLimiter } from '../middleware/security.js';
import { INTENTS, MAX_CENTS, MAX_ROUNDS_LIMIT, MODES, OPEN_STATUSES, STATUSES } from '../services/negotiation/rules.js';
import {
  acceptBook, approve, cancelNegotiation, getNegotiation, hydrate, negotiationView, pasteReply, previewLimits, proposeCounter,
  rejectProposal, startNegotiation, updateNegotiation, walkAway,
} from '../services/negotiation/index.js';

/**
 * AI-assisted rate negotiation with brokers by email (/api/negotiations). The dispatcher always approves the final
 * deal: the AI drafts emails and reads replies, the code enforces the limits (services/negotiation), and nothing is
 * accepted or booked without the dispatcher's click. Personal API tokens can read but never write.
 *
 *   GET    /defaults            limits a new negotiation would get (walk-away from carrier rules, target)
 *   POST   /                    start; returns the drafted opening email (waits for approval)
 *   GET    /                    list (owner/team scoped): status (one, 'open' or 'all'), brokerId, loadId, carrierId
 *   GET    /:id                 negotiation with history and emails
 *   POST   /:id/reply           broker reply pasted { text } or classified by hand { intent, cents }
 *   POST   /:id/approve         send the waiting proposal, optionally edited { subject, body, cents }
 *   POST   /:id/reject          discard the waiting proposal
 *   POST   /:id/counter         draft a counter at { cents } (inside the limits)
 *   PATCH  /:id                 mode, targetCents, floorCents, maxRounds
 *   POST   /:id/accept-book     agree, book the load, confirm by email
 *   POST   /:id/walk-away       close; optional polite email { sendEmail, subject, body }
 *   POST   /:id/cancel          close without emailing
 */
const r = Router();
r.use(requirePermission('crm.use', 'email.use'));
r.use((req, res, next) => (req.method !== 'GET' && req.apiToken ? next(forbidden('API tokens cannot negotiate rates')) : next()));

const cents = (min = 0) => optInt(min, MAX_CENTS);
const optState = z.preprocess(
  (v) => (v === '' || v == null ? undefined : typeof v === 'string' ? v.trim().toUpperCase() : v),
  z.string().regex(/^[A-Z]{2}$/, 'Use a 2-letter state code').optional(),
);
const optDay = z.preprocess(
  (v) => (v === '' || v == null ? undefined : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Use a date like 2026-11-14').transform((s) => s.slice(0, 10)).optional(),
);
const laneSchema = z.object({
  originCity: optStr(100), originState: optState, destCity: optStr(100), destState: optState,
  pickupDate: optDay, deliveryDate: optDay,
  equipment: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.enum(EQUIPMENT).optional()),
  weightLbs: optInt(0, 200000), miles: optInt(1, 20000), deadheadMiles: optInt(0, 5000),
  commodity: optStr(120), reference: optStr(60),
});
const emailText = z.string().max(5000).nullish();
const allowAi = (req) => hasPermission(req, 'ai.use');

/** Detail for the response after an action (same shape as GET /:id), plus the action's own fields. */
async function reply(req, res, id, extra = {}, status = 200) {
  const detail = await getNegotiation(req.user, id);
  res.status(status).json({ ...detail, ...extra });
}

r.get('/defaults', ah(async (req, res) => {
  const q = parse(laneSchema.extend({
    carrierId: z.string().max(40).optional(), loadId: z.string().max(40).optional(),
    offerCents: cents(0), targetCents: cents(1), floorCents: cents(1),
  }), req.query);
  const { carrierId, loadId, offerCents, targetCents, floorCents, ...lane } = q;
  res.json(await previewLimits(req.user, { carrierId: carrierId || null, loadId: loadId || null, lane, offerCents: offerCents ?? null, targetCents: targetCents ?? null, floorCents: floorCents ?? null }));
}));

r.post('/', aiLimiter, ah(async (req, res) => {
  const body = parse(z.object({
    brokerId: optStr(40), carrierId: optStr(40), loadId: optStr(40),
    lane: laneSchema.optional(),
    offerCents: cents(0), targetCents: cents(1), floorCents: cents(1),
    mode: z.enum(MODES).default('approve'),
    maxRounds: z.coerce.number().int().min(1).max(MAX_ROUNDS_LIMIT).default(3),
    toEmail: optEmail, accountId: optStr(40),
  }), req.body);
  const out = await startNegotiation(req.user, body, { allowAi: allowAi(req) });
  await reply(req, res, out.negotiation.id, { email: out.email, aiError: out.aiError, note: out.note, limits: out.limits }, 201);
}));

r.get('/', ah(async (req, res) => {
  const q = parse(z.object({
    ...pageQuery,
    status: z.enum([...STATUSES, 'open', 'all']).default('all'),
    brokerId: z.string().max(40).optional(), loadId: z.string().max(40).optional(), carrierId: z.string().max(40).optional(),
    scope: z.enum(['mine', 'team']).default('mine'),
  }), req.query);
  const where = { ...(await ownerWhere(req.user, q.scope)) };
  if (q.status === 'open') where.status = { in: OPEN_STATUSES };
  else if (q.status !== 'all') where.status = q.status;
  if (q.brokerId) where.brokerId = q.brokerId;
  if (q.loadId) where.loadId = q.loadId;
  if (q.carrierId) where.carrierId = q.carrierId;
  const [rows, total] = await Promise.all([
    prisma.negotiation.findMany({
      where, orderBy: { updatedAt: 'desc' }, ...paginate(q),
      include: { broker: { select: { id: true, companyName: true } }, carrier: { select: { id: true, companyName: true } } },
    }),
    prisma.negotiation.count({ where }),
  ]);
  const items = rows.map((row) => {
    const { history, ...v } = negotiationView(hydrate(row), { user: req.user });
    return { ...v, steps: history.length };
  });
  res.json(pageResult(items, total, q));
}));

r.get('/:id', ah(async (req, res) => {
  res.json(await getNegotiation(req.user, req.params.id));
}));

r.post('/:id/reply', aiLimiter, ah(async (req, res) => {
  const body = parse(z.object({ text: optStr(20000), intent: z.enum(INTENTS).optional(), cents: cents(0) })
    .refine((b) => b.text || b.intent, { message: 'Paste the broker\'s reply', path: ['text'] }), req.body);
  const out = await pasteReply(req.user, req.params.id, { text: body.text || null, intent: body.intent || null, cents: body.cents ?? null }, { allowAi: allowAi(req) });
  await reply(req, res, req.params.id, { aiError: out.aiError, autoSent: out.autoSent });
}));

r.post('/:id/approve', ah(async (req, res) => {
  const body = parse(z.object({
    subject: optStr(200), body: emailText, cents: cents(1),
    sendEmail: z.boolean().optional(), loadedMiles: optInt(1, 20000),
  }), req.body);
  const out = await approve(req.user, req.params.id, {
    subject: body.subject ?? undefined, body: body.body ?? undefined, cents: body.cents ?? undefined,
    sendEmail: body.sendEmail, loadedMiles: body.loadedMiles ?? undefined,
  });
  await reply(req, res, req.params.id, { email: out.email || null, outcome: out.outcome, load: out.load, emailError: out.emailError });
}));

r.post('/:id/reject', ah(async (req, res) => {
  await rejectProposal(req.user, req.params.id);
  await reply(req, res, req.params.id);
}));

r.post('/:id/counter', aiLimiter, ah(async (req, res) => {
  const body = parse(z.object({ cents: z.coerce.number().int().min(1).max(MAX_CENTS) }), req.body);
  const out = await proposeCounter(req.user, req.params.id, body, { allowAi: allowAi(req) });
  await reply(req, res, req.params.id, { aiError: out.aiError });
}));

r.patch('/:id', ah(async (req, res) => {
  const body = parse(z.object({
    mode: z.enum(MODES).optional(), targetCents: cents(1), floorCents: cents(1), maxRounds: optInt(1, MAX_ROUNDS_LIMIT),
  }), req.body);
  await updateNegotiation(req.user, req.params.id, body);
  await reply(req, res, req.params.id);
}));

r.post('/:id/accept-book', ah(async (req, res) => {
  const body = parse(z.object({
    cents: cents(1), sendEmail: z.boolean().default(true), subject: optStr(200), body: emailText, loadedMiles: optInt(1, 20000),
  }), req.body);
  const out = await acceptBook(req.user, req.params.id, {
    cents: body.cents ?? undefined, sendEmail: body.sendEmail, subject: body.subject ?? undefined, body: body.body ?? undefined, loadedMiles: body.loadedMiles ?? undefined,
  });
  await reply(req, res, req.params.id, { load: out.load, email: out.email, emailError: out.emailError });
}));

r.post('/:id/walk-away', ah(async (req, res) => {
  const body = parse(z.object({ sendEmail: z.boolean().default(false), subject: optStr(200), body: emailText }), req.body);
  const out = await walkAway(req.user, req.params.id, { sendEmail: body.sendEmail, subject: body.subject ?? null, body: body.body ?? null });
  await reply(req, res, req.params.id, { email: out.email, emailError: out.emailError });
}));

r.post('/:id/cancel', ah(async (req, res) => {
  await cancelNegotiation(req.user, req.params.id);
  await reply(req, res, req.params.id);
}));

export default r;
