import { Router } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { ah, badRequest } from '../lib/errors.js';
import { requirePermission } from '../middleware/auth.js';
import { makeLimiter } from '../middleware/security.js';
import { loadCarrier } from '../lib/access.js';
import { normDot, normMc } from '../services/carriers/normalize.js';
import { buildProfile, peekProfile, storedMaxAgeMs, PROFILE_VERSION } from '../services/carriers/profile.js';

/**
 * Full FMCSA carrier profile (services/carriers/profile.js).
 *   GET /dot/:dot              any USDOT number (leads before saving). 404 when FMCSA has no such carrier.
 *   GET /carrier/:carrierId    a saved carrier the user may read (404 otherwise). The profile is stored on the carrier
 *                              (Carrier.fmcsaSnapshot.profile) and reused for 24 hours (10 minutes when a source failed).
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
