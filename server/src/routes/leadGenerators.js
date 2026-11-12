import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, notFound, paymentRequired, badRequest } from '../lib/errors.js';
import { parse, z, clean } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { assertLimit, effectivePlan, usage } from '../lib/plans.js';
import { STAGE_KEYS } from '../lib/constants.js';
import { CARGO_LABELS } from '../services/carriers/fmcsaCensus.js';
import { parseCriteria, previewLeads, runGenerator, nextRunFrom, inactiveAuthorityFrom, criteriaHash, runMessageText } from '../services/leadgen.js';

const r = Router();
r.use(requirePermission('crm.use'));

const months = z.coerce.number().int().min(0).max(1200).nullable().optional();
const units = z.coerce.number().int().min(0).max(100000).nullable().optional();
const criteriaSchema = z.object({
  states: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use 2-letter state codes')).min(1, 'Pick at least one state').max(15),
  cargo: z.array(z.string().refine((k) => Object.hasOwn(CARGO_LABELS, k), 'Unknown cargo type')).max(12).default([]),
  minPowerUnits: units,
  maxPowerUnits: units,
  authorityAgeMinMonths: months,
  authorityAgeMaxMonths: months,
  requirePhone: z.boolean().default(true),
  requireEmail: z.boolean().default(false),
  requireMc: z.boolean().default(true),
  activeOnly: z.boolean().default(true),
}).refine((c) => c.minPowerUnits == null || c.maxPowerUnits == null || c.minPowerUnits <= c.maxPowerUnits, { message: 'Minimum fleet size is above the maximum', path: ['minPowerUnits'] })
  .refine((c) => c.authorityAgeMinMonths == null || c.authorityAgeMaxMonths == null || c.authorityAgeMinMonths <= c.authorityAgeMaxMonths, { message: 'Minimum authority age is above the maximum', path: ['authorityAgeMinMonths'] });

// Field shapes without defaults. Zod fills .default() values even inside .partial(), so defaults live only in the
// create schema: a PATCH that sends { autoRun } must never reset batch size, stage, minimum score or frequency.
const generatorFields = {
  name: z.string().trim().min(1, 'Required').max(80),
  criteria: criteriaSchema,
  batchSize: z.coerce.number().int().min(1).max(200),
  stageKey: z.enum(STAGE_KEYS),
  listId: z.string().max(40).nullable().optional(),
  newListName: z.string().trim().max(80).nullable().optional(),
  sequenceId: z.string().max(40).nullable().optional(),
  minScore: z.coerce.number().int().min(0).max(100),
  autoRun: z.boolean(),
  frequency: z.enum(['daily', 'weekly']),
  active: z.boolean().optional(),
};
const generatorSchema = z.object({
  ...generatorFields,
  batchSize: generatorFields.batchSize.default(25),
  stageKey: generatorFields.stageKey.default('lead'),
  minScore: generatorFields.minScore.default(0),
  autoRun: generatorFields.autoRun.default(false),
  frequency: generatorFields.frequency.default('daily'),
});
const generatorPatchSchema = z.object(generatorFields).partial();

async function entitlements(user) {
  const [{ plan }, u] = await Promise.all([effectivePlan(user), usage(user)]);
  return {
    planKey: plan?.key, planName: plan?.name,
    monthlyLimit: plan?.monthlyLeadGenLimit ?? 0, usedThisMonth: u.leadGenMonth,
    maxGenerators: plan?.maxLeadGenerators ?? 0, generators: u.leadGenerators,
    autoRun: !!plan?.leadGenAutoRun,
  };
}

async function resolveList(user, body) {
  if (body.newListName) {
    const existing = await prisma.prospectList.findFirst({ where: { ownerId: user.id, name: body.newListName } });
    return (existing || await prisma.prospectList.create({ data: { ownerId: user.id, name: body.newListName, description: 'Filled by the lead generator' } })).id;
  }
  if (body.listId) {
    const list = await prisma.prospectList.findFirst({ where: { id: body.listId, ownerId: user.id } });
    if (!list) throw badRequest('Prospect list not found');
    return list.id;
  }
  return body.listId === null ? null : undefined;
}

async function resolveSequence(user, sequenceId) {
  if (sequenceId === undefined) return undefined;
  if (!sequenceId) return null;
  const seq = await prisma.emailSequence.findFirst({ where: { id: sequenceId, ownerId: user.id } });
  if (!seq) throw badRequest('Sequence not found');
  if (!seq.active) throw badRequest('Activate the sequence before using it in a generator');
  return seq.id;
}

const shape = (g) => ({
  id: g.id, name: g.name, criteria: parseCriteria(g.criteria), batchSize: g.batchSize, stageKey: g.stageKey, minScore: g.minScore,
  listId: g.listId, list: g.list ? { id: g.list.id, name: g.list.name } : null,
  sequenceId: g.sequenceId, sequence: g.sequence ? { id: g.sequence.id, name: g.sequence.name } : null, autoRun: g.autoRun, frequency: g.frequency,
  nextRunAt: g.nextRunAt, lastRunAt: g.lastRunAt, active: g.active, createdAt: g.createdAt,
  lastRun: g.runs?.[0] ? runShape(g.runs[0]) : null,
});
const runShape = (x) => ({
  id: x.id, generatorId: x.generatorId, trigger: x.trigger, status: x.status, scanned: x.scanned, created: x.created,
  skipped: x.skipped, belowScore: x.belowScore, message: runMessageText(x.message), createdAt: x.createdAt, carrierIds: JSON.parse(x.carrierIds || '[]'),
  // Candidates dropped because FMCSA licensing does not show active authority (stored in the message, no column).
  inactiveAuthority: x.inactiveAuthority ?? inactiveAuthorityFrom(x.message),
});

async function withLists(userId, gens) {
  const ids = [...new Set(gens.map((g) => g.listId).filter(Boolean))];
  const lists = ids.length ? await prisma.prospectList.findMany({ where: { id: { in: ids }, ownerId: userId }, select: { id: true, name: true } }) : [];
  const byId = new Map(lists.map((l) => [l.id, l]));
  const seqIds = [...new Set(gens.map((g) => g.sequenceId).filter(Boolean))];
  const seqs = seqIds.length ? await prisma.emailSequence.findMany({ where: { id: { in: seqIds }, ownerId: userId }, select: { id: true, name: true } }) : [];
  const seqById = new Map(seqs.map((x) => [x.id, x]));
  return gens.map((g) => ({ ...g, list: byId.get(g.listId) || null, sequence: seqById.get(g.sequenceId) || null }));
}

async function loadGen(req) {
  const g = await prisma.leadGenerator.findFirst({ where: { id: req.params.id, ownerId: req.user.id } });
  if (!g) throw notFound('Lead generator not found');
  return g;
}

r.get('/', ah(async (req, res) => {
  const gens = await prisma.leadGenerator.findMany({
    where: { ownerId: req.user.id }, orderBy: { createdAt: 'desc' },
    include: { runs: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  res.json({
    items: (await withLists(req.user.id, gens)).map(shape),
    entitlements: await entitlements(req.user),
    cargoOptions: Object.entries(CARGO_LABELS).map(([value, label]) => ({ value, label })),
  });
}));

r.post('/preview', ah(async (req, res) => {
  const body = parse(z.object({ criteria: criteriaSchema, minScore: z.coerce.number().int().min(0).max(100).default(0) }), req.body);
  res.json(await previewLeads(req.user, body.criteria, body.minScore));
}));

async function assertAutoRun(user, autoRun) {
  if (!autoRun) return;
  const { plan } = await effectivePlan(user);
  if (!plan?.leadGenAutoRun) throw paymentRequired(`Scheduled lead generation is not included in the ${plan?.name || 'current'} plan. Upgrade, or run the generator by hand.`, { kind: 'leadGenAutoRun' });
}

r.post('/', ah(async (req, res) => {
  const body = parse(generatorSchema, req.body);
  await assertLimit(req.user, 'leadGenerators', 1);
  await assertAutoRun(req.user, body.autoRun);
  const listId = await resolveList(req.user, body);
  const sequenceId = await resolveSequence(req.user, body.sequenceId);
  const g = await prisma.leadGenerator.create({
    data: {
      ownerId: req.user.id, name: body.name, criteria: JSON.stringify(body.criteria), batchSize: body.batchSize, stageKey: body.stageKey,
      listId: listId ?? null, sequenceId: sequenceId ?? null, minScore: body.minScore, autoRun: body.autoRun, frequency: body.frequency,
      nextRunAt: body.autoRun ? nextRunFrom(body.frequency) : null,
    },
  });
  const [withList] = await withLists(req.user.id, [g]);
  res.status(201).json({ generator: shape(withList) });
}));

r.patch('/:id', ah(async (req, res) => {
  const g = await loadGen(req);
  // Only keys the client sent (no defaults, see generatorFields).
  const body = parse(generatorPatchSchema, req.body);
  for (const k of Object.keys(body)) if (!Object.prototype.hasOwnProperty.call(req.body || {}, k)) delete body[k];
  await assertAutoRun(req.user, body.autoRun);
  const listId = await resolveList(req.user, body);
  const sequenceId = await resolveSequence(req.user, body.sequenceId);
  const autoRun = body.autoRun ?? g.autoRun;
  const frequency = body.frequency ?? g.frequency;
  const data = clean({
    name: body.name, batchSize: body.batchSize, stageKey: body.stageKey, minScore: body.minScore, autoRun: body.autoRun, frequency: body.frequency, active: body.active,
    criteria: body.criteria ? JSON.stringify(body.criteria) : undefined, listId, sequenceId,
  });
  if (body.autoRun !== undefined || body.frequency !== undefined) data.nextRunAt = autoRun ? nextRunFrom(frequency) : null;
  // New filters or a new minimum score: the saved crawl position no longer applies, the next run starts from the top.
  if ((body.criteria || body.minScore !== undefined)
    && criteriaHash(body.criteria ?? g.criteria, body.minScore ?? g.minScore) !== criteriaHash(g.criteria, g.minScore)) data.cursor = null;
  const updated = await prisma.leadGenerator.update({ where: { id: g.id }, data });
  const [withList] = await withLists(req.user.id, [updated]);
  res.json({ generator: shape(withList) });
}));

r.delete('/:id', ah(async (req, res) => {
  const g = await loadGen(req);
  await prisma.leadGenerator.delete({ where: { id: g.id } });
  res.json({ ok: true });
}));

r.post('/:id/run', ah(async (req, res) => {
  const g = await loadGen(req);
  await assertLimit(req.user, 'leadGenMonth', 1);
  const run = await runGenerator(req.user, g, { trigger: 'manual' });
  const shaped = runShape(run);
  const carriers = shaped.carrierIds.length ? await prisma.carrier.findMany({
    where: { id: { in: shaped.carrierIds }, ownerId: req.user.id },
    select: { id: true, companyName: true, dotNumber: true, mcNumber: true, state: true, city: true, phone: true, email: true, fleetSize: true, priority: true, authorityStatus: true, operatingStatus: true },
  }) : [];
  res.json({ run: shaped, carriers, entitlements: await entitlements(req.user) });
}));

r.get('/runs', ah(async (req, res) => {
  const q = parse(z.object({ generatorId: z.string().max(40).optional() }), req.query);
  const runs = await prisma.leadGenRun.findMany({
    where: { ownerId: req.user.id, ...(q.generatorId ? { generatorId: q.generatorId } : {}) },
    orderBy: { createdAt: 'desc' }, take: 50, include: { generator: { select: { name: true } } },
  });
  res.json({ items: runs.map((x) => ({ ...runShape(x), generatorName: x.generator?.name || 'Deleted generator' })) });
}));

export default r;
