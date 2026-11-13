import { Router } from 'express';
import { ah, badRequest } from '../lib/errors.js';
import { parse, z, optStr } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { STAGE_KEYS } from '../lib/constants.js';
import * as census from '../services/carriers/fmcsaCensus.js';
import { providerStatuses, enrichLookup } from '../services/carriers/providers.js';
import { annotateRecords } from '../services/carriers/collisions.js';
import { saveCensusCarriers, activeSequence } from '../services/carriers/saveCensus.js';
import { AUTHORITY_UNAVAILABLE, annotateAuthority } from '../services/carriers/authority.js';
import {
  leadFilterFields, withLeadFilterChecks, censusLeadFilters, postFilter, EQUIPMENT_TYPES, COMMON_INSURERS,
} from '../services/carriers/leadFilters.js';
import { scoreLead, sharedContactStep, mcAgeStep, insurerStep, leadView } from '../services/carriers/leadSignals.js';

const r = Router();
r.use(requirePermission('crm.use'));

/** Identical census searches within this window are answered from the shared per-process cache. */
const SEARCH_CACHE_MS = 15 * 60_000;

r.get('/providers', ah(async (req, res) => {
  const items = (await providerStatuses()).map((p) => ({ ...p, key: p.id, description: p.note }));
  // `providers` is the shape the Settings page reads; `items` follows the list convention.
  res.json({ items, providers: items });
}));

const searchSchema = withLeadFilterChecks(z.object({
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
  // 'score': the census page in newest-first order, shown best lead first.
  order: z.enum(['dot', 'newest', 'score']).default('newest'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(50000).default(0),
  // Shared with the lead generator (services/carriers/leadFilters.js).
  ...leadFilterFields,
}));

/** Options for the shared filter form (the lead generator sends the same in GET /api/lead-generators). */
r.get('/filter-options', ah(async (req, res) => {
  res.json({ equipmentOptions: Object.entries(EQUIPMENT_TYPES).map(([value, label]) => ({ value, label })), insurerSuggestions: COMMON_INSURERS });
}));

/**
 * Census search, one page at a time. Every row is annotated with its operating authority from FMCSA licensing (one
 * batched check per page). activeOnly (default): rows without active authority are hidden (`hiddenInactive`), and so
 * are rows the licensing dataset could not verify (`hiddenUnverified`, with `authorityError`); a row without an MC
 * number stays only when the search does not require one. Paging (`hasMore`) follows the census page, so hidden rows
 * never stop "Next".
 * The lead filters the census can answer are in the census query; the rest run on the page, as in the lead generator
 * (shared filters, shared contacts, MC age, insurer: the lookups are batched and fail-soft) and hide rows with a count
 * (`hiddenByFilters`, per reason in `hiddenReasons`). Every row shown carries its lead score, tier and signals.
 */
r.get('/search', ah(async (req, res) => {
  const f = parse(searchSchema, req.query);
  if (!f.state && !f.name && !f.dot && !f.mc && !f.city) throw badRequest('Pick at least a state, city, name, USDOT or MC to search');
  const activeOnly = f.activeOnly === 'true';
  const hasMc = f.hasMc === 'true';
  const now = new Date();
  const result = await census.search({
    ...f,
    // Lead filters, and the registration window: authority age N months = record added at least N months ago.
    ...censusLeadFilters(f, now),
    activeOnly,
    hasMc,
    hasEmail: f.hasEmail === 'true',
    order: f.order === 'score' ? 'newest' : f.order,
  }, undefined, { cacheMs: SEARCH_CACHE_MS });
  const { items: checked, answered } = await annotateAuthority(result.items, { cacheMs: SEARCH_CACHE_MS });
  let hiddenInactive = 0;
  let hiddenUnverified = 0;
  const visible = activeOnly ? checked.filter((x) => {
    if (x.authorityStatus === 'active' || (x.authorityStatus === 'none' && !hasMc)) return true;
    if (x.authorityStatus === 'unknown') hiddenUnverified++;
    else hiddenInactive++;
    return false;
  }) : checked;
  const hiddenReasons = { unsafe: 0, filtered: 0, sharedContact: 0 };
  const passed = visible.filter((rec) => {
    const why = postFilter(rec, f, now);
    if (why) hiddenReasons[why === 'unsafe' ? 'unsafe' : 'filtered']++;
    return !why;
  });
  const shared = await sharedContactStep(passed, f, { cacheMs: SEARCH_CACHE_MS });
  hiddenReasons.sharedContact += shared.excluded.length;
  const aged = await mcAgeStep(shared.kept, f, { cacheMs: SEARCH_CACHE_MS, now });
  hiddenReasons.filtered += aged.excluded.length;
  const insured = await insurerStep(aged.kept, f, { cacheMs: SEARCH_CACHE_MS, now });
  hiddenReasons.filtered += insured.excluded.length;
  const scored = insured.kept.map((rec) => {
    const s = scoreLead(rec, { now, timezone: req.user.timezone || null });
    return leadView({ ...rec, score: s.score, tier: s.tier, signals: s.signals, scoreReasons: s.reasons });
  });
  if (f.order === 'score') scored.sort((a, b) => b.score - a.score);
  const items = await annotateRecords(req.user, scored);
  res.json({
    ...result, items, offset: f.offset, limit: f.limit, hasMore: result.items.length === f.limit,
    hiddenInactive, hiddenUnverified,
    hiddenByFilters: hiddenReasons.unsafe + hiddenReasons.filtered + hiddenReasons.sharedContact, hiddenReasons,
    authorityError: answered ? null : `${AUTHORITY_UNAVAILABLE} ${activeOnly ? 'Carriers that could not be checked are hidden; search again in a few minutes.' : 'Their authority shows as not verified.'}`,
  });
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
  // The user saw "Authority is not active. Save anyway?" and confirmed.
  allowInactive: z.boolean().optional(),
});

/**
 * Save discovered carriers. Records are always re-fetched from FMCSA by USDOT number on the
 * server — client-supplied carrier data is never trusted as "verified".
 * Operating authority is re-checked with FMCSA licensing: carriers whose authority is not active (or could not be
 * verified) come back as `inactive_authority` / `unverified` items and are not saved unless `allowInactive` is true.
 * The response lists every requested USDOT with its carrier id (created or already in the CRM), so the client can
 * call a lead right after saving it and log the call against the record ("Save and call").
 */
r.post('/save', ah(async (req, res) => {
  const body = parse(saveSchema, req.body);
  if (!(body.dotNumbers || []).length) throw badRequest('Select at least one carrier');
  const sequence = await activeSequence(req.user, body.sequenceId);
  res.json(await saveCensusCarriers(req.user, body.dotNumbers, { stage: body.stage, sequence, allowInactive: !!body.allowInactive }));
}));

export default r;
