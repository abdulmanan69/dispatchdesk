import { Router } from 'express';
import fs from 'node:fs';
import { prisma } from '../db.js';
import { ah, notFound } from '../lib/errors.js';
import { filePath } from '../middleware/upload.js';
import { linkLimiter } from '../middleware/security.js';
import { customerForToken } from '../services/invoices/portal.js';
import { buildStatement, weekFromKey, weeklySummaries, isBilledLoad } from '../services/invoices/statements.js';
import { statementHtml, brandLogo } from '../services/invoices/print.js';

/**
 * Public carrier portal (token link, no session): the carrier's weekly dispatch-fee statements and the rate con,
 * BOL and POD files of the loads on those statements. Nothing else from the dispatcher's workspace is reachable.
 * Tokens are hashed, expiring and rotatable (routes/customers.js). app.js applies the shared per-link limiter (120 a
 * minute); this router adds the stricter per-link budget below.
 *   GET /:token                               carrier, dispatcher contact, recent weekly totals
 *   GET /:token/statements/:week              one week's loads (with document links)
 *   GET /:token/statements/:week/print        printable statement
 *   GET /:token/documents/:documentId         a rate con, BOL or POD of a load shown on a statement
 */
const r = Router();
const WEEKS = 12;
const DOC_TYPES = ['rate_confirmation', 'bol', 'pod'];
const DAY = 86_400_000;

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

const zoneOf = (customer) => customer.owner?.timezone || 'America/Chicago';
const dispatcherOf = (customer) => ({
  name: customer.owner?.name || null,
  company: customer.owner?.teamMembership?.team?.name || null,
  email: customer.owner?.email || null,
  phone: customer.owner?.phone || null,
});

r.get('/:token', ah(async (req, res) => {
  const customer = await portalCustomer(req.params.token);
  const weeks = await weeklySummaries({ customer, carrier: customer.carrier, tz: zoneOf(customer), count: WEEKS });
  res.json({
    carrier: customer.carrier,
    dispatcher: dispatcherOf(customer),
    feePercent: customer.dispatchFeePercent ?? null,
    timezone: zoneOf(customer),
    expiresAt: customer.portalExpiresAt,
    weeks,
  });
}));

/** Weeks older than the portal window are not reachable through the link. */
function portalWeek(customer, key) {
  const week = weekFromKey(zoneOf(customer), key);
  if (week.end.getTime() < Date.now() - (WEEKS + 1) * 7 * DAY || week.start.getTime() > Date.now() + 7 * DAY) throw notFound('Statement not found');
  return week;
}

r.get('/:token/statements/:week', ah(async (req, res) => {
  const customer = await portalCustomer(req.params.token);
  const statement = await buildStatement({ customer, carrier: customer.carrier, week: portalWeek(customer, req.params.week), withDocuments: true });
  res.json({ statement, timezone: zoneOf(customer) });
}));

r.get('/:token/statements/:week/print', ah(async (req, res) => {
  const customer = await portalCustomer(req.params.token);
  const statement = await buildStatement({ customer, carrier: customer.carrier, week: portalWeek(customer, req.params.week) });
  const d = dispatcherOf(customer);
  res.type('html').send(statementHtml(statement, { from: { name: d.company || d.name }, tz: zoneOf(customer), logo: await brandLogo(customer.ownerId) }));
}));

r.get('/:token/documents/:documentId', ah(async (req, res) => {
  const customer = await portalCustomer(req.params.token);
  const doc = await prisma.document.findUnique({
    where: { id: String(req.params.documentId) },
    include: { load: { select: { carrierId: true, status: true, tonuCents: true, deliveryDate: true, pickupDate: true } } },
  });
  const day = doc?.load ? doc.load.deliveryDate || doc.load.pickupDate : null;
  const ok = doc && DOC_TYPES.includes(doc.type) && doc.load && doc.load.carrierId === customer.carrierId
    && isBilledLoad(doc.load) && day && day.getTime() >= Date.now() - (WEEKS + 1) * 7 * DAY;
  if (!ok) throw notFound('Document not found');
  const p = filePath('documents', doc.storedName);
  if (!fs.existsSync(p)) throw notFound('File is missing from storage');
  res.set('Content-Type', doc.mimeType);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.originalName)}`);
  // A read error (file removed or unreadable after the check) must end this response, not crash the worker.
  const stream = fs.createReadStream(p);
  stream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.removeHeader('Content-Disposition');
    res.status(404).json({ error: 'File is missing from storage' });
  });
  stream.pipe(res);
}));

export default r;
