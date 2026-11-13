import { Router } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { ah, badRequest, HttpError } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { makeLimiter } from '../middleware/security.js';
import { loadCarrier } from '../lib/access.js';
import { normDot, normMc } from '../services/carriers/normalize.js';
import { buildProfile, peekProfile, storedMaxAgeMs, censusRows, PROFILE_VERSION } from '../services/carriers/profile.js';
import { buildInspections, peekInspections } from '../services/carriers/inspections.js';
import { buildRelated } from '../services/carriers/related.js';
import { parseCheckQuery, checkWhere, checkRow } from '../services/carriers/carrierCheck.js';
import { mapRecord } from '../services/carriers/fmcsaCensus.js';
import { annotateAuthority } from '../services/carriers/authority.js';
import { annotateRecords } from '../services/carriers/collisions.js';

/**
 * Full FMCSA carrier profile (services/carriers/profile.js).
 *   GET /dot/:dot              any USDOT number (leads before saving). 404 when FMCSA has no such carrier.
 *   GET /carrier/:carrierId    a saved carrier the user may read (404 otherwise). The profile is stored on the carrier
 *                              (Carrier.fmcsaSnapshot.profile) and reused for 24 hours (10 minutes when a source failed).
 *   GET /dot/:dot/inspections  roadside inspections, violations, inspected vehicles, crashes (services/carriers/inspections.js)
 *   GET /dot/:dot/related      other carriers sharing this carrier's phone, email or address (services/carriers/related.js)
 *   GET /search?q=             Carrier check: find carriers by USDOT, MC, name, phone or email (FMCSA census)
 *   POST /bulk                 Carrier check for up to 25 USDOT / MC numbers at once (census + live authority)
 * ?refresh=1 builds a new profile from FMCSA. Builds are limited per user (30 a minute, shared across cluster workers);
 * answers from the stored copy or the per-process cache do not count. API tokens may read (browser extension).
 *
 * Carrier.fmcsaSnapshot also holds the nightly FMCSA watchlist snapshot (top-level keys, services/brokers/watchlist.js).
 * The profile lives under its `profile` key and never changes the watchlist keys; fmcsaCheckedAt is the watchlist's
 * "last checked" time, so it is only set here for carriers the watchlist has not checked yet. Saving the profile does
 * not change Carrier.updatedAt (viewing a profile is not an edit).
 */
const r = Router();
r.use(requirePermission('crm.use'));

const buildLimiter = makeLimiter(
  'carrierprofile', 60_000,
  () => Number(process.env.CARRIER_PROFILE_RATE_LIMIT) || 30,
  'Too many FMCSA profile lookups. Try again in a minute.',
  {
    force: true,
    // Cached answers are free; tests (and RATE_LIMIT_DISABLED) skip the limit unless CARRIER_PROFILE_RATE_LIMIT is set.
    skip: (req) => req.profileCached === true || (!process.env.CARRIER_PROFILE_RATE_LIMIT && (config.rateLimitDisabled || config.isTest)),
  },
);

const wantsRefresh = (req) => ['1', 'true'].includes(String(req.query.refresh || ''));
const parseJson = (s) => {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
};
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A stored profile still fresh for this carrier's numbers. */
function storedFresh(profile, { dot, mc }) {
  if (!isObject(profile) || profile.v !== PROFILE_VERSION || !profile.fetchedAt) return false;
  if (dot ? profile.dot !== dot : profile.mc !== mc) return false;
  const age = Date.now() - Date.parse(profile.fetchedAt);
  return age >= 0 && age < storedMaxAgeMs(profile);
}

async function storeProfile(carrierId, profile) {
  const row = await prisma.carrier.findUnique({ where: { id: carrierId }, select: { fmcsaSnapshot: true, updatedAt: true } });
  if (!row) return;
  const prev = parseJson(row.fmcsaSnapshot);
  const base = isObject(prev) ? prev : {};
  const watched = Object.hasOwn(base, 'found');
  await prisma.carrier.updateMany({
    where: { id: carrierId },
    data: {
      fmcsaSnapshot: JSON.stringify({ ...base, profile }),
      ...(watched ? {} : { fmcsaCheckedAt: new Date(profile.fetchedAt) }),
      updatedAt: row.updatedAt,
    },
  });
}

r.get('/dot/:dot', (req, res, next) => {
  const dot = normDot(req.params.dot);
  if (!dot || dot.length > 9 || !/^\d+$/.test(String(req.params.dot).trim())) return next(badRequest('Enter a USDOT number'));
  const refresh = wantsRefresh(req);
  req.profileQuery = { dot, refresh };
  if (!refresh && peekProfile(dot)) req.profileCached = true;
  next();
}, buildLimiter, ah(async (req, res) => {
  const { dot, refresh } = req.profileQuery;
  const profile = await buildProfile({ dot }, { fresh: refresh });
  res.json({ profile, stored: false });
}));

/** A route USDOT parameter, or null after passing a 400 to `next`. */
function dotParam(req, next) {
  const dot = normDot(req.params.dot);
  if (!dot || dot.length > 9 || !/^\d+$/.test(String(req.params.dot).trim())) {
    next(badRequest('Enter a USDOT number'));
    return null;
  }
  return dot;
}

r.get('/dot/:dot/inspections', (req, res, next) => {
  const dot = dotParam(req, next);
  if (!dot) return;
  req.profileQuery = { dot, refresh: wantsRefresh(req) };
  if (!req.profileQuery.refresh && peekInspections(dot)) req.profileCached = true;
  next();
}, buildLimiter, ah(async (req, res) => {
  const { dot, refresh } = req.profileQuery;
  // QCMobile's national averages, when a cached profile has them, are newer than the built-in ones.
  const live = peekProfile(dot)?.safety?.inspections || null;
  const national = live?.vehicle?.nationalAvg != null ? {
    vehicle: live.vehicle.nationalAvg, driver: live.driver?.nationalAvg ?? null, hazmat: live.hazmat?.nationalAvg ?? null, asOf: live.nationalAvgYear || null,
  } : null;
  res.json({ report: await buildInspections(dot, { fresh: refresh, national }) });
}));

r.get('/dot/:dot/related', (req, res, next) => {
  const dot = dotParam(req, next);
  if (!dot) return;
  req.profileQuery = { dot };
  next();
}, buildLimiter, ah(async (req, res) => {
  res.json({ related: await buildRelated(req.profileQuery.dot) });
}));

const censusUnavailable = (err) => (err?.status === 429 ? err : new HttpError(502, `FMCSA census is not available right now: ${String(err?.message || err).slice(0, 160)}`));

r.get('/search', ah(async (req, res) => {
  const { q } = parse(z.object({ q: z.string().trim().min(1, 'Enter a USDOT, MC, name, phone or email').max(120) }), req.query);
  const parsed = parseCheckQuery(q);
  if (!parsed) throw badRequest('Enter a USDOT, MC, name, phone or email');
  let rows;
  try {
    rows = await censusRows({ $where: checkWhere(parsed), $limit: '25', $order: 'status_code,dot_number' }, { cacheMs: 10 * 60_000 });
  } catch (err) {
    throw censusUnavailable(err);
  }
  const records = rows.map(mapRecord).filter((x) => x.dotNumber);
  const { items, answered } = records.length ? await annotateAuthority(records, { cacheMs: 30 * 60_000 }) : { items: [], answered: true };
  const annotated = await annotateRecords(req.user, items);
  res.json({ query: parsed, items: annotated.map(checkRow), authorityAnswered: answered });
}));

const bulkSchema = z.object({
  numbers: z.array(z.string().trim().max(24)).min(1, 'Paste at least one USDOT or MC number').max(25, 'Check up to 25 numbers at a time'),
}).strict();

r.post('/bulk', ah(async (req, res) => {
  const { numbers } = parse(bulkSchema, req.body);
  const wanted = numbers.map((raw) => {
    const p = parseCheckQuery(raw);
    return p && ['dot', 'mc', 'number'].includes(p.kind) ? { raw, ...p } : { raw, kind: 'invalid' };
  });
  const dots = [...new Set(wanted.filter((w) => w.kind === 'dot' || w.kind === 'number').map((w) => w.value))];
  const mcs = [...new Set(wanted.filter((w) => w.kind === 'mc' || w.kind === 'number').map((w) => w.value))];
  const clauses = [];
  if (dots.length) clauses.push(checkWhere({ kind: 'dots', value: dots }));
  if (mcs.length) clauses.push(checkWhere({ kind: 'mcs', value: mcs }));
  let rows = [];
  if (clauses.length) {
    try {
      rows = await censusRows({ $where: clauses.map((c) => `(${c})`).join(' OR '), $limit: '100' }, { cacheMs: 10 * 60_000 });
    } catch (err) {
      throw censusUnavailable(err);
    }
  }
  const records = rows.map(mapRecord).filter((x) => x.dotNumber);
  const { items, answered } = records.length ? await annotateAuthority(records, { cacheMs: 30 * 60_000 }) : { items: [], answered: true };
  const annotated = (await annotateRecords(req.user, items)).map(checkRow);
  const results = wanted.map((w) => {
    if (w.kind === 'invalid') return { input: w.raw, error: 'Not a USDOT or MC number' };
    const hit = (w.kind !== 'mc' && annotated.find((x) => x.dotNumber === normDot(w.value)))
      || (w.kind !== 'dot' && annotated.find((x) => x.mcNumber === normMc(w.value)));
    return hit ? { input: w.raw, carrier: hit } : { input: w.raw, error: 'No FMCSA record' };
  });
  res.json({ results, authorityAnswered: answered });
}));

r.get('/carrier/:carrierId', ah(async (req, res, next) => {
  const carrier = await loadCarrier(req.user, req.params.carrierId);
  const dot = normDot(carrier.dotNumber);
  const mc = normMc(carrier.mcNumber);
  if (!dot && !mc) throw badRequest('Add a USDOT number to see the FMCSA profile.');
  const refresh = wantsRefresh(req);
  const stored = parseJson(carrier.fmcsaSnapshot)?.profile || null;
  req.profileQuery = { carrierId: carrier.id, dot, mc, refresh, stored };
  if (!refresh && storedFresh(stored, { dot, mc })) req.profileQuery.useStored = true;
  if (!refresh && (req.profileQuery.useStored || (dot && peekProfile(dot)))) req.profileCached = true;
  next();
}), buildLimiter, ah(async (req, res) => {
  const { carrierId, dot, mc, refresh, stored, useStored } = req.profileQuery;
  if (useStored) return res.json({ profile: stored, stored: true });
  let profile;
  try {
    profile = await buildProfile({ dot, mc }, { fresh: refresh });
  } catch (err) {
    // FMCSA did not answer: the last stored copy (with its own date) beats an error page.
    if (err.status !== 404 && err.status !== 400 && isObject(stored) && stored.v === PROFILE_VERSION && (dot ? stored.dot === dot : stored.mc === mc)) {
      return res.json({ profile: stored, stored: true, stale: true, error: String(err.message || 'FMCSA did not answer').slice(0, 200) });
    }
    throw err;
  }
  if (stored?.fetchedAt !== profile.fetchedAt) await storeProfile(carrierId, profile);
  res.json({ profile, stored: false });
}));

export default r;
