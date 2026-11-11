import { Router } from 'express';
import { ah, badRequest } from '../lib/errors.js';
import { parse, z, optStr } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { STAGE_KEYS } from '../lib/constants.js';
import * as census from '../services/carriers/fmcsaCensus.js';
import { providerStatuses, enrichLookup } from '../services/carriers/providers.js';
import { annotateRecords } from '../services/carriers/collisions.js';
import { saveCensusCarriers, activeSequence } from '../services/carriers/saveCensus.js';

const r = Router();
r.use(requirePermission('crm.use'));

/** Identical census searches within this window are answered from the shared per-process cache. */
const SEARCH_CACHE_MS = 15 * 60_000;

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

// The census filter uses whole dates (YYYYMMDD), so repeated searches on one day share a cache entry.
const monthsAgo = (m) => { const d = new Date(); d.setMonth(d.getMonth() - m); return d; };

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
  }, undefined, { cacheMs: SEARCH_CACHE_MS });
  const items = await annotateRecords(req.user, result.items);
  res.json({ ...result, items, offset: f.offset, limit: f.limit, hasMore: result.items.length === f.limit });
}));

r.get('/lookup', ah(async (req, res) => {
  const q = parse(z.object({ dot: optStr(12), mc: optStr(12) }), req.query);
  if (!q.dot && !q.mc) throw badRequest('Provide dot or mc');
  const { record, sources } = await enrichLookup({ dot: q.dot, mc: q.mc });
  if (!record) return res.json({ record: null, sources, retrievedAt: new Date().toISOString() });
  const [annotated] = await annotateRecords(req.user, [record]);
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
 * The response lists every requested USDOT with its carrier id (created or already in the CRM), so the client can
 * call a lead right after saving it and log the call against the record ("Save and call").
 */
r.post('/save', ah(async (req, res) => {
  const body = parse(saveSchema, req.body);
  if (!(body.dotNumbers || []).length) throw badRequest('Select at least one carrier');
  const sequence = await activeSequence(req.user, body.sequenceId);
  res.json(await saveCensusCarriers(req.user, body.dotNumbers, { stage: body.stage, sequence }));
}));

export default r;
