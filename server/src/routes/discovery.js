import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest } from '../lib/errors.js';
import { parse, z, optStr } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { assertLimit, remaining } from '../lib/plans.js';
import { logActivity } from '../lib/activity.js';
import { STAGE_KEYS } from '../lib/constants.js';
import { stageByKey } from '../services/pipeline.js';
import { runAutomations } from '../services/automation.js';
import { enrollCarriers } from '../services/sequenceEngine.js';
import * as census from '../services/carriers/fmcsaCensus.js';
import { providerStatuses, enrichLookup } from '../services/carriers/providers.js';
import { normDot, normMc } from '../services/carriers/normalize.js';

const r = Router();
r.use(requirePermission('crm.use'));

r.get('/providers', ah(async (req, res) => {
  const items = (await providerStatuses()).map((p) => ({ ...p, key: p.id, description: p.note }));
  // `providers` is the shape the Settings page reads; `items` follows the list convention.
  res.json({ items, providers: items });
}));

const searchSchema = z.object({
  state: optStr(2),
  city: optStr(80),
  name: optStr(120),
  dot: optStr(12),
  mc: optStr(12),
  minPowerUnits: z.coerce.number().int().min(0).optional(),
  maxPowerUnits: z.coerce.number().int().min(0).optional(),
  activeOnly: z.enum(['true', 'false']).default('true'),
  hasMc: z.enum(['true', 'false']).default('false'),
  hasEmail: z.enum(['true', 'false']).default('false'),
  authorityAgeMinMonths: z.coerce.number().int().min(0).max(1200).optional(),
  authorityAgeMaxMonths: z.coerce.number().int().min(0).max(1200).optional(),
  order: z.enum(['dot', 'newest']).default('newest'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(50000).default(0),
});

const monthsAgo = (m) => { const d = new Date(); d.setMonth(d.getMonth() - m); return d; };

async function annotate(user, items) {
  const dots = items.map((i) => i.dotNumber).filter(Boolean);
  const mcs = items.map((i) => i.mcNumber).filter(Boolean);
  const existing = await prisma.carrier.findMany({
    where: { ownerId: user.id, OR: [{ dotNumber: { in: dots } }, { mcNumber: { in: mcs } }] },
    select: { id: true, dotNumber: true, mcNumber: true },
  });
  const byDot = new Map(existing.filter((e) => e.dotNumber).map((e) => [e.dotNumber, e.id]));
  const byMc = new Map(existing.filter((e) => e.mcNumber).map((e) => [e.mcNumber, e.id]));
  return items.map((i) => {
    const id = (i.dotNumber && byDot.get(i.dotNumber)) || (i.mcNumber && byMc.get(i.mcNumber)) || null;
    return { ...i, existsInCrm: !!id, existingId: id };
  });
}

r.get('/search', ah(async (req, res) => {
  const f = parse(searchSchema, req.query);
  if (!f.state && !f.name && !f.dot && !f.mc && !f.city) throw badRequest('Pick at least a state, city, name, USDOT or MC to search');
  const result = await census.search({
    ...f,
    activeOnly: f.activeOnly === 'true',
    hasMc: f.hasMc === 'true',
    hasEmail: f.hasEmail === 'true',
    // Authority age N months = record added at least N months ago.
    addedBefore: f.authorityAgeMinMonths != null ? monthsAgo(f.authorityAgeMinMonths) : undefined,
    addedAfter: f.authorityAgeMaxMonths != null ? monthsAgo(f.authorityAgeMaxMonths) : undefined,
  });
  const items = await annotate(req.user, result.items);
  res.json({ ...result, items, offset: f.offset, limit: f.limit, hasMore: result.items.length === f.limit });
}));

r.get('/lookup', ah(async (req, res) => {
  const q = parse(z.object({ dot: optStr(12), mc: optStr(12) }), req.query);
  if (!q.dot && !q.mc) throw badRequest('Provide dot or mc');
  const { record, sources } = await enrichLookup({ dot: q.dot, mc: q.mc });
  if (!record) return res.json({ record: null, sources, retrievedAt: new Date().toISOString() });
  const [annotated] = await annotate(req.user, [record]);
  res.json({ record: annotated, sources, retrievedAt: new Date().toISOString() });
}));

const saveSchema = z.object({
  dotNumbers: z.array(z.string().max(12)).max(200).optional(),
  stage: z.enum(STAGE_KEYS).default('lead'),
  sequenceId: z.string().max(40).nullable().optional(),
});

/**
 * Save discovered carriers. Records are always re-fetched from FMCSA by USDOT number on the
 * server — client-supplied carrier data is never trusted as "verified".
 */
r.post('/save', ah(async (req, res) => {
  const body = parse(saveSchema, req.body);
  const dots = [...new Set((body.dotNumbers || []).map(normDot).filter(Boolean))];
  if (!dots.length) throw badRequest('Select at least one carrier');
  const sequence = body.sequenceId ? await prisma.emailSequence.findFirst({ where: { id: body.sequenceId, ownerId: req.user.id } }) : null;
  if (body.sequenceId && !sequence) throw badRequest('Sequence not found');
  if (sequence && !sequence.active) throw badRequest('Activate the sequence before enrolling carriers');
  await assertLimit(req.user, 'discoveryToday', 1);
  const budget = Math.min(await remaining(req.user, 'discoveryToday'), await remaining(req.user, 'carriers'));
  const records = await census.lookupMany(dots);
  const existing = await prisma.carrier.findMany({
    where: { ownerId: req.user.id, OR: [{ dotNumber: { in: dots } }, { mcNumber: { in: records.map((x) => x.mcNumber).filter(Boolean) } }] },
    select: { dotNumber: true, mcNumber: true },
  });
  const haveDot = new Set(existing.map((e) => e.dotNumber).filter(Boolean));
  const haveMc = new Set(existing.map((e) => e.mcNumber).filter(Boolean));
  const stage = await stageByKey(body.stage);
  const now = new Date();
  const out = { requested: dots.length, created: 0, skipped: 0, notFound: 0, limited: 0, ids: [] };
  out.notFound = dots.filter((d) => !records.some((x) => x.dotNumber === d)).length;
  let left = budget;
  for (const rec of records) {
    if (haveDot.has(rec.dotNumber) || (rec.mcNumber && haveMc.has(normMc(rec.mcNumber)))) { out.skipped++; continue; }
    if (left <= 0) { out.limited++; continue; }
    const { _extra, ...fields } = rec;
    try {
      const c = await prisma.carrier.create({ data: { ...fields, ownerId: req.user.id, stageId: stage.id, source: 'fmcsa_census', sourceRef: `USDOT ${rec.dotNumber}`, verifiedAt: now } });
      out.created++;
      out.ids.push(c.id);
      left--;
      await runAutomations(req.user, 'carrier_created', { carrier: c });
    } catch (err) {
      if (err.code === 'P2002') out.skipped++;
      else throw err;
    }
  }
  if (out.created) await logActivity(req.user, { type: 'import', summary: `Saved ${out.created} carrier(s) from FMCSA Census` });
  if (sequence && out.ids.length) {
    const carriers = await prisma.carrier.findMany({ where: { id: { in: out.ids }, ownerId: req.user.id } });
    const enr = await enrollCarriers(req.user, sequence.id, carriers);
    out.enrolled = enr.enrolled;
    out.sequence = { id: sequence.id, name: sequence.name };
  }
  res.json(out);
}));

export default r;
