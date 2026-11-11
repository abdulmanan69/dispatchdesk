import { Router } from 'express';
import { ah, HttpError } from '../lib/errors.js';
import { linkLimiter } from '../middleware/security.js';
import { publicLoadTrack } from '../services/fleet/loadShare.js';

/**
 * Public read-only load tracking link for brokers and shippers (/t/:token). No session: the secret token is the credential.
 * app.js applies the shared per-link limiter (publicLinkLimiter) and exempts this path from CSRF; this router adds the
 * stricter per-link budget (linkLimiter, 60 a minute): the page refreshes once a minute, so even several people watching
 * one link stay far below it.
 * The response shows the load reference, pickup and delivery cities with their appointment windows, status, last
 * update, a city-level position (exact only when the dispatcher allowed it), the ETA marked as an estimate and whether
 * the POD is in. Never the driver's name or phone, rates, or anything else from the CRM.
 */
const r = Router();
r.use(linkLimiter);

const GONE = {
  invalid: 'This tracking link is not valid. Ask the carrier for a new one.',
  revoked: 'This tracking link was turned off by the carrier.',
  expired: 'This tracking link has expired. Ask the carrier for a new one if you still need updates.',
};

r.get('/:token', ah(async (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  const out = await publicLoadTrack(String(req.params.token));
  if (out.gone) throw new HttpError(out.gone === 'invalid' ? 404 : 410, GONE[out.gone], { code: out.gone.toUpperCase() });
  res.set('Cache-Control', 'private, no-cache');
  res.set('ETag', out.etag);
  if (req.get('if-none-match') === out.etag) return res.status(304).end();
  res.json(out.body);
}));

export default r;
