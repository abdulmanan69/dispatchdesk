import { Router } from 'express';
import { ah, notFound } from '../lib/errors.js';
import { linkLimiter } from '../middleware/security.js';
import { customerForToken } from '../services/invoices/portal.js';
import { portalSummary, portalStatement, portalPrintHtml, sendPortalDocument } from '../services/invoices/portalViews.js';

/**
 * Public carrier portal (token link, no session): the carrier's weekly dispatch-fee statements and the rate con,
 * BOL and POD files of the loads on those statements. Nothing else from the dispatcher's workspace is reachable.
 * Tokens are hashed, expiring and rotatable (routes/customers.js). app.js applies the shared per-link limiter (120 a
 * minute); this router adds the stricter per-link budget below. The views are shared with the signed-in carrier
 * account (routes/carrierAccount.js) through services/invoices/portalViews.js.
 *   GET /:token                               carrier, dispatcher contact, recent weekly totals
 *   GET /:token/statements/:week              one week's loads (with document links)
 *   GET /:token/statements/:week/print        printable statement
 *   GET /:token/documents/:documentId         a rate con, BOL or POD of a load shown on a statement
 */
const r = Router();

r.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});
// A carrier opens the portal a few times a week; 60 requests a minute per link is plenty, and a leaked link cannot be
// used to hammer the statement queries.
r.use(linkLimiter);

async function portalCustomer(token) {
  const customer = await customerForToken(token);
  if (!customer) throw notFound('This link is not valid. Ask your dispatcher for a new one.');
  return customer;
}

r.get('/:token', ah(async (req, res) => {
  res.json(await portalSummary(await portalCustomer(req.params.token)));
}));

r.get('/:token/statements/:week', ah(async (req, res) => {
  res.json(await portalStatement(await portalCustomer(req.params.token), req.params.week));
}));

r.get('/:token/statements/:week/print', ah(async (req, res) => {
  res.type('html').send(await portalPrintHtml(await portalCustomer(req.params.token), req.params.week));
}));

r.get('/:token/documents/:documentId', ah(async (req, res) => {
  await sendPortalDocument(await portalCustomer(req.params.token), req.params.documentId, res);
}));

export default r;
