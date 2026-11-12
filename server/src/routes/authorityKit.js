import { Router } from 'express';
import { ah, badRequest, conflict, notFound } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { STAGE_KEYS } from '../lib/constants.js';
import * as census from '../services/carriers/fmcsaCensus.js';
import * as qc from '../services/carriers/fmcsaQc.js';
import { annotateRecords, teamClaims, ownMatches, matchFor } from '../services/carriers/collisions.js';
import { saveCensusCarriers, activeSequence } from '../services/carriers/saveCensus.js';
import { MILESTONES, MILESTONE_KEYS, milestoneRange, ageDays, buildReadiness, readinessText } from '../services/carriers/readiness.js';
import { normDot, normMc } from '../services/carriers/normalize.js';
import { annotateAuthority, checkAuthority } from '../services/carriers/authority.js';

/**
 * New-authority prospecting kit.
 *   GET  /milestones   carriers by registration age (last 7/30/90/180 days, or reaching 90/180 days this week) for one
 *                      state, optionally one cargo class, from the public FMCSA census (cached 30 minutes per query).
 *                      Each row says whether it is already in your CRM or a teammate's (team collision guard), and
 *                      carries its operating authority from FMCSA licensing (active, pending, inactive; not filtered:
 *                      new carriers are often still pending, which is the point of this list).
 *   GET  /readiness/:dot  readiness report: registration and docket status (census), operating authority and liability
 *                      insurance (FMCSA licensing; QCMobile when a webKey is set, which also gives out-of-service status),
 *                      broker age notes and contact completeness, with sources. `text` is a plain summary for a
 *                      first-touch email.
 *   GET  /collisions   which USDOT numbers are already yours or a teammate's (for dialers and queues).
 *   POST /claim        add carriers to your CRM (re-verified with FMCSA, plan limits apply) and optionally enroll them in
 *                      a sequence. A teammate's carrier needs { force: true } after the user saw the warning. Authority
 *                      is checked and stored but does not block the claim (pending authority is expected here).
 * Nothing here dials, texts or emails anyone.
 */
const r = Router();
r.use(requirePermission('crm.use'));

const LIST_CACHE_MS = 30 * 60_000;
const LOOKUP_CACHE_MS = 10 * 60_000;
const state = z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z]{2}$/, 'Pick a state'));
const bool = (def) => z.enum(['true', 'false']).default(def).transform((v) => v === 'true');

const milestoneSchema = z.object({
  state,
  window: z.enum(MILESTONE_KEYS).default('new30'),
  cargo: z.string().refine((k) => Object.hasOwn(census.CARGO_LABELS, k), 'Unknown cargo type').optional(),
  // Equipment is inferred from cargo classes (the census has no equipment field), e.g. reefer = refrigerated food, meat, produce.
  equipment: z.enum(census.EQUIPMENT_FROM_CARGO).optional(),
  hasPhone: bool('true'),
  hasEmail: bool('false'),
  offset: z.coerce.number().int().min(0).max(2000).default(0),
  limit: z.coerce.number().int().min(10).max(100).default(50),
});

r.get('/milestones', ah(async (req, res) => {
  const q = parse(milestoneSchema, req.query);
  const now = new Date();
  const range = milestoneRange(q.window, now);
  const [result, newest] = await Promise.all([
    census.search({
      state: q.state, activeOnly: true, hasMc: true, hasPhone: q.hasPhone, hasEmail: q.hasEmail,
      cargo: q.cargo ? [q.cargo] : q.equipment ? census.cargoForEquipment(q.equipment) : [],
      addedAfter: range.addedAfter, addedBefore: range.addedBefore, order: 'newest', limit: q.limit, offset: q.offset,
    }, undefined, { cacheMs: LIST_CACHE_MS }),
    // Freshness of the census for this state (the file lags behind FMCSA's live systems); optional.
    census.newestAddDate(q.state).catch(() => null),
  ]);
  // Annotate only: never filter by authority here. Cached like the census page (a list view, not a save).
  const { items: checked } = await annotateAuthority(result.items, { cacheMs: LIST_CACHE_MS });
  const items = (await annotateRecords(req.user, checked)).map(({ _extra, ...rec }) => ({
    ...rec,
    cargo: _extra?.cargo || [],
    docketStatus: _extra?.docketStatus || null,
    ageDays: ageDays(rec.authorityDate, now),
  }));
  res.json({
    items,
    window: { key: q.window, label: MILESTONES[q.window].label, from: range.addedAfter, to: range.addedBefore || null },
    newestRecord: newest,
    source: result.source,
    retrievedAt: result.retrievedAt,
    note: result.note,
    offset: q.offset,
    limit: q.limit,
    hasMore: result.items.length === q.limit,
    milestones: MILESTONE_KEYS.map((k) => ({ key: k, label: MILESTONES[k].label })),
    cargoOptions: Object.entries(census.CARGO_LABELS).map(([value, label]) => ({ value, label })),
    equipmentOptions: census.EQUIPMENT_FROM_CARGO.map((value) => ({ value, cargo: census.cargoForEquipment(value).map((k) => census.CARGO_LABELS[k]) })),
  });
}));

r.get('/readiness/:dot', ah(async (req, res) => {
  const dot = normDot(req.params.dot);
  if (!dot || dot.length > 9) throw badRequest('Enter a USDOT number');
  const record = await census.lookup({ dot }, undefined, { cacheMs: LOOKUP_CACHE_MS });
  if (!record) throw notFound('No FMCSA census record for this USDOT number');
  const qcStatus = await qc.status();
  let details = null;
  let qcError = null;
  if (qcStatus.configured) {
    try { details = await qc.readinessDetails(dot); } catch (err) { qcError = String(err.message || err).slice(0, 200); }
  }
  const now = new Date();
  const mc = normMc(record.mcNumber);
  // Operating authority and BIPD from FMCSA licensing, legacy and Motus (null when neither dataset answered).
  const licensing = mc ? (await checkAuthority([{ mc, dot: record.dotNumber }], { cacheMs: LOOKUP_CACHE_MS })).get(mc) || null : null;
  const report = buildReadiness(record, details, { now, qcConfigured: qcStatus.configured, qcError, censusRetrievedAt: now, qcRetrievedAt: qcStatus.configured ? now : null, licensing });
  const [annotated] = await annotateRecords(req.user, [record]);
  res.json({
    ...report,
    crm: { existsInCrm: annotated.existsInCrm, carrierId: annotated.existingId, teamClaims: annotated.teamClaims },
    text: readinessText(report),
  });
}));

r.get('/collisions', ah(async (req, res) => {
  const q = parse(z.object({ dots: z.string().max(4000) }), req.query);
  const dots = [...new Set(q.dots.split(',').map(normDot).filter(Boolean))].slice(0, 200);
  const [own, team] = await Promise.all([ownMatches(req.user, { dots }), teamClaims(req.user, { dots })]);
  res.json({ items: dots.map((d) => ({ dotNumber: d, carrierId: matchFor(own, { dotNumber: d })?.id || null, teamClaims: matchFor(team, { dotNumber: d }) || [] })) });
}));

const claimSchema = z.object({
  dotNumbers: z.array(z.string().max(12)).min(1, 'Select at least one carrier').max(50),
  stage: z.enum(STAGE_KEYS).default('lead'),
  sequenceId: z.string().max(40).nullable().optional(),
  force: z.boolean().optional(),
});

r.post('/claim', ah(async (req, res) => {
  const b = parse(claimSchema, req.body);
  const dots = [...new Set(b.dotNumbers.map(normDot).filter(Boolean))];
  if (!dots.length) throw badRequest('Select at least one carrier');
  const sequence = await activeSequence(req.user, b.sequenceId);
  if (!b.force) {
    const team = await teamClaims(req.user, { dots });
    const collisions = dots.map((d) => ({ dotNumber: d, teamClaims: matchFor(team, { dotNumber: d }) || [] })).filter((x) => x.teamClaims.length);
    if (collisions.length) {
      const who = collisions[0].teamClaims[0].ownerName;
      throw conflict(`${collisions.length === 1 ? `${who} already has this carrier` : `${collisions.length} of these carriers are already with teammates`}. Check with them before adding.`, { collisions });
    }
  }
  const out = await saveCensusCarriers(req.user, dots, {
    stage: b.stage, sequence, sourceRef: (dot) => `USDOT ${dot} · New authority`, activity: 'the new-authority kit', requireActive: false,
  });
  res.json(out);
}));

export default r;
