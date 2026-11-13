import fs from 'node:fs';
import { prisma } from '../../db.js';
import { notFound } from '../../lib/errors.js';
import { filePath } from '../../middleware/upload.js';
import { buildStatement, weekFromKey, weeklySummaries, isBilledLoad } from './statements.js';
import { statementHtml, brandLogo } from './print.js';

/**
 * What a carrier sees of one dispatcher's statements: shared by the token portal (/portal/:token) and the carrier
 * account (/carrier, signed in by FMCSA email). `customer` must include carrier and owner (customerForToken shape).
 * Only weekly dispatch-fee statements of the last WEEKS weeks and the rate con, BOL and POD of billed loads on them.
 */
export const WEEKS = 12;
const DOC_TYPES = ['rate_confirmation', 'bol', 'pod'];
const DAY = 86_400_000;

export const zoneOf = (customer) => customer.owner?.timezone || 'America/Chicago';
export const dispatcherOf = (customer) => ({
  name: customer.owner?.name || null,
  company: customer.owner?.teamMembership?.team?.name || null,
  email: customer.owner?.email || null,
  phone: customer.owner?.phone || null,
});

export async function portalSummary(customer) {
  const weeks = await weeklySummaries({ customer, carrier: customer.carrier, tz: zoneOf(customer), count: WEEKS });
  return {
    carrier: customer.carrier,
    dispatcher: dispatcherOf(customer),
    feePercent: customer.dispatchFeePercent ?? null,
    timezone: zoneOf(customer),
    expiresAt: customer.portalExpiresAt,
    weeks,
  };
}

/** Weeks older than the portal window (or in the future) are not reachable. */
function portalWeek(customer, key) {
  const week = weekFromKey(zoneOf(customer), key);
  if (week.end.getTime() < Date.now() - (WEEKS + 1) * 7 * DAY || week.start.getTime() > Date.now() + 7 * DAY) throw notFound('Statement not found');
  return week;
}

export async function portalStatement(customer, key) {
  const statement = await buildStatement({ customer, carrier: customer.carrier, week: portalWeek(customer, key), withDocuments: true });
  return { statement, timezone: zoneOf(customer) };
}

export async function portalPrintHtml(customer, key) {
  const statement = await buildStatement({ customer, carrier: customer.carrier, week: portalWeek(customer, key) });
  const d = dispatcherOf(customer);
  return statementHtml(statement, { from: { name: d.company || d.name }, tz: zoneOf(customer), logo: await brandLogo(customer.ownerId) });
}

/** Stream a rate con, BOL or POD of a billed load on a statement in the window; 404 otherwise. */
export async function sendPortalDocument(customer, documentId, res) {
  const doc = await prisma.document.findUnique({
    where: { id: String(documentId) },
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
}
