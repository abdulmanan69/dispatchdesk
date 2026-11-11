import { prisma } from '../../db.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { sha256 } from '../../lib/crypto.js';
import { userCanReadCarrier } from '../../lib/access.js';
import { logActivity, notify } from '../../lib/activity.js';
import { changeStage } from '../pipeline.js';
import { syncOpportunityFollowUp } from '../../routes/opportunities.js';
import { decodeSignature } from './signature.js';
import { dispatcherCompany, percentText } from './agreement.js';

/**
 * Carrier onboarding links: one secret link per agreement, where the carrier reviews and e-signs the dispatch agreement
 * and uploads its setup documents. Only sha256(token) is stored; the token is shown to the dispatcher once.
 */

/** Documents a link may ask for, with the CRM document type each one is filed as. */
export const DOC_KINDS = ['w9', 'coi', 'mc_authority', 'voided_check', 'noa'];
export const DOC_KIND_LABEL = {
  w9: 'W-9', coi: 'Certificate of insurance', mc_authority: 'MC authority letter', voided_check: 'Voided check', noa: 'Notice of assignment (factoring)',
};
/** The same names for use inside a sentence ("upload your W-9 and certificate of insurance"). */
export const DOC_KIND_PHRASE = {
  w9: 'W-9', coi: 'certificate of insurance', mc_authority: 'MC authority letter', voided_check: 'voided check', noa: 'notice of assignment',
};
// Each requested kind maps to its CRM document type (voided_check and noa have their own types).
export const DOC_KIND_TYPE = { w9: 'w9', coi: 'coi', mc_authority: 'mc_authority', voided_check: 'voided_check', noa: 'noa' };

export const LINK_DEFAULT_DAYS = 14;
export const LINK_MAX_DAYS = 30;
export const MAX_PENDING_PER_CARRIER = 5;
export const MAX_FILES_PER_LINK = 12;
export const MAX_FILE_MB = 15;
/** After signing, the carrier can still upload documents (and see the link) for this long. */
export const UPLOAD_DAYS_AFTER_SIGNING = 7;
const DAY = 86_400_000;

export const parseDocs = (s) => String(s || '').split(',').map((x) => x.trim()).filter((x) => DOC_KINDS.includes(x));

/**
 * "Ask for permission to call and text" is stored as one more token in the requestedDocs comma list (no schema
 * change): parseDocs ignores it, so it never counts as a document.
 */
export const CONTACT_CONSENT_FLAG = 'contact_consent';
export const asksContactConsent = (link) => String(link?.requestedDocs || '').split(',').map((x) => x.trim()).includes(CONTACT_CONSENT_FLAG);
/** The requestedDocs column value for a new link. */
export const encodeRequested = (docs, askContactConsent) => [...docs, ...(askContactConsent ? [CONTACT_CONSENT_FLAG] : [])].join(',') || null;

/**
 * Uploaded files are tied to their link through the stored file name: "onb-<linkId>-<kind>-<random>.<ext>".
 * (Document has no link column; the prefix keeps per-link status and the per-link cap exact.)
 */
export const storedPrefix = (linkId, kind) => `onb-${linkId}-${kind ? `${kind}-` : ''}`;
const STORED_RE = /^onb-[a-z0-9]+-(w9|coi|mc_authority|voided_check|noa)-/;
export const kindOfStored = (storedName) => STORED_RE.exec(String(storedName || ''))?.[1] ?? null;

export async function linkDocuments(link, select = { id: true, type: true, originalName: true, storedName: true, sizeBytes: true, mimeType: true, createdAt: true }) {
  return prisma.document.findMany({
    where: { carrierId: link.carrierId, source: 'onboarding', storedName: { startsWith: storedPrefix(link.id) } },
    orderBy: { createdAt: 'asc' }, select, take: 100,
  });
}

/** Status for the dispatcher: pending | viewed | signed | revoked | expired. */
export function linkStatus(link, now = new Date()) {
  if (link.status === 'revoked') return 'revoked';
  if (link.status === 'signed') return 'signed';
  if (new Date(link.expiresAt) <= now) return 'expired';
  return link.viewedAt ? 'viewed' : 'pending';
}

export const uploadsCloseAt = (link) => (link.signedAt
  ? new Date(new Date(link.signedAt).getTime() + UPLOAD_DAYS_AFTER_SIGNING * DAY)
  : new Date(link.expiresAt));

/** Row for the dispatcher's list (no token, no hash, no agreement text). */
export function linkListView(link, docs = [], now = new Date()) {
  return {
    id: link.id, carrierId: link.carrierId, status: linkStatus(link, now), agreementTitle: link.agreementTitle,
    feePercent: link.feePercent, requestedDocs: parseDocs(link.requestedDocs), askContactConsent: asksContactConsent(link),
    viewedAt: link.viewedAt, consentAt: link.consentAt, signedAt: link.signedAt, signerName: link.signerName,
    expiresAt: link.expiresAt, revokedAt: link.revokedAt, createdAt: link.createdAt,
    createdBy: link.owner ? { id: link.owner.id, name: link.owner.name } : undefined,
    documents: docs.length,
    uploadedDocs: [...new Set(docs.map((d) => kindOfStored(d.storedName)).filter(Boolean))],
  };
}

/** Everything that happened on the link, oldest first (dispatcher view and printable record). */
export function auditTrail(link, docs = []) {
  const ev = [{ at: link.createdAt, event: 'created', text: `Link created by ${link.owner?.name || 'the dispatcher'}` }];
  if (link.viewedAt) ev.push({ at: link.viewedAt, event: 'viewed', text: 'Carrier opened the link' });
  if (link.consentAt) ev.push({ at: link.consentAt, event: 'consent', text: 'Carrier agreed to use electronic records and signatures' });
  if (link.signedAt) {
    ev.push({ at: link.signedAt, event: 'signed', text: `Signed by ${link.signerName}${link.signerTitle ? `, ${link.signerTitle}` : ''}`, ip: link.signerIp, userAgent: link.signerUserAgent });
  }
  for (const d of docs) ev.push({ at: d.createdAt, event: 'document', text: `${DOC_KIND_LABEL[kindOfStored(d.storedName)] || 'Document'} uploaded`, documentId: d.id });
  if (link.revokedAt) ev.push({ at: link.revokedAt, event: 'revoked', text: 'Link turned off' });
  return ev.sort((a, b) => new Date(a.at) - new Date(b.at));
}

/** Full dispatcher view of one link, including the signature and the audit trail. */
export function linkDetailView(link, docs, now = new Date()) {
  const sig = decodeSignature(link.signatureData);
  return {
    ...linkListView(link, docs, now),
    agreementBody: link.agreementBody, agreementHash: link.agreementHash,
    signerTitle: link.signerTitle, signerEmail: link.signerEmail, signerIp: link.signerIp, signerUserAgent: link.signerUserAgent,
    signature: sig,
    uploadsCloseAt: uploadsCloseAt(link),
    documentList: docs.map((d) => ({ id: d.id, kind: kindOfStored(d.storedName), type: d.type, originalName: d.originalName, sizeBytes: d.sizeBytes, mimeType: d.mimeType, createdAt: d.createdAt })),
    audit: auditTrail(link, docs),
  };
}

// ---------------------------------------------------------------------------
// Public side
// ---------------------------------------------------------------------------

const GONE = {
  expired: 'This onboarding link has expired. Ask your dispatcher to send a new one.',
  revoked: 'This onboarding link was turned off by your dispatcher. Ask them for a new one if you still need to sign.',
  closed: 'This agreement is signed and the link has closed. Ask your dispatcher if you need a copy of the signed agreement.',
};
export const gone = (reason) => new HttpError(410, GONE[reason], { code: reason.toUpperCase(), state: reason === 'closed' ? 'signed' : reason });
const INVALID = 'This link is not valid. Check that you opened the whole link from your dispatcher.';

const ownerInclude = { teamMembership: { include: { team: true } } };

/**
 * Find a link by its token (hash lookup only) and check it can still be used. Throws 404 for unknown tokens and 410
 * for expired, revoked or closed links (also when the dispatcher no longer has access to the carrier).
 */
export async function resolvePublicLink(token) {
  const t = String(token || '');
  if (t.length < 20 || t.length > 200 || !/^[A-Za-z0-9_-]+$/.test(t)) throw notFound(INVALID);
  const link = await prisma.onboardingLink.findUnique({
    where: { tokenHash: sha256(t) },
    include: { carrier: { select: { id: true, companyName: true, ownerId: true, assignedToId: true, stageId: true, isFleet: true } }, owner: { include: ownerInclude } },
  });
  if (!link) throw notFound(INVALID);
  if (link.status === 'revoked') throw gone('revoked');
  if (link.owner.status !== 'active' || !(await userCanReadCarrier(link.owner, link.carrier))) throw gone('revoked');
  const now = new Date();
  if (link.status === 'signed') {
    if (uploadsCloseAt(link) <= now) throw gone('closed');
    return link;
  }
  if (new Date(link.expiresAt) <= now) throw gone('expired');
  return link;
}

/** Uploads are open while the link is pending and for UPLOAD_DAYS_AFTER_SIGNING days after signing. */
export const uploadsOpen = (link, now = new Date()) => link.status !== 'revoked' && uploadsCloseAt(link) > now;

/** What the carrier's page may show. Nothing else from the CRM leaves the server. */
export function publicView(link, docs, now = new Date()) {
  const counts = {};
  for (const d of docs) { const k = kindOfStored(d.storedName); if (k) counts[k] = (counts[k] || 0) + 1; }
  const open = uploadsOpen(link, now);
  return {
    state: link.status === 'signed' ? 'signed' : 'pending',
    carrier: { companyName: link.carrier.companyName },
    dispatcher: { name: link.owner.name, company: dispatcherCompany(link.owner) },
    agreement: { title: link.agreementTitle, body: link.agreementBody, hash: link.agreementHash },
    feePercent: link.feePercent != null ? percentText(link.feePercent) : null,
    requestedDocs: parseDocs(link.requestedDocs).map((kind) => ({ kind, label: DOC_KIND_LABEL[kind], uploaded: counts[kind] || 0 })),
    uploads: { open, closesAt: uploadsCloseAt(link), maxFiles: MAX_FILES_PER_LINK, used: docs.length, maxMb: MAX_FILE_MB, types: ['pdf', 'jpg', 'png'] },
    consentAt: link.consentAt,
    signedAt: link.signedAt,
    signerName: link.status === 'signed' ? link.signerName : null,
    expiresAt: link.expiresAt,
  };
}

/** Record the first time the carrier opens the link (atomic, so concurrent opens record one time). */
export async function markViewed(link) {
  if (link.viewedAt) return link.viewedAt;
  const at = new Date();
  const { count } = await prisma.onboardingLink.updateMany({ where: { id: link.id, viewedAt: null }, data: { viewedAt: at } });
  if (count) {
    link.viewedAt = at;
    await logActivity(link.owner, { type: 'onboarding', carrierId: link.carrierId, summary: `${link.carrier.companyName} opened the dispatch agreement link` }).catch(() => {});
  }
  return link.viewedAt;
}

/**
 * After a signature: make the carrier a customer at the agreed fee (the same path as converting an opportunity: the
 * pipeline moves it to Customer, marks an open opportunity won and puts the truck on the fleet map), log the activity
 * and notify the dispatcher. Each step is best effort: the signature is already recorded and must not be lost.
 */
export async function afterSigned(link) {
  const owner = link.owner;
  const carrier = await prisma.carrier.findUnique({ where: { id: link.carrierId } });
  let customer = null;
  try {
    await changeStage(owner, carrier, 'customer', { reason: 'signed the dispatch agreement' });
    customer = await prisma.customer.update({
      where: { carrierId: carrier.id },
      data: { status: 'active', ...(link.feePercent != null ? { dispatchFeePercent: link.feePercent } : {}) },
    });
    const opp = await prisma.opportunity.findUnique({ where: { carrierId: carrier.id }, select: { id: true, nextFollowUpAt: true } });
    if (opp?.nextFollowUpAt) await prisma.opportunity.update({ where: { id: opp.id }, data: { nextFollowUpAt: null } });
    if (opp) await syncOpportunityFollowUp(owner, carrier, null);
  } catch (err) {
    console.error('[onboarding] customer conversion failed', link.id, err?.message);
  }
  try {
    await logActivity(owner, {
      type: 'customer', carrierId: carrier.id,
      summary: `${carrier.companyName} signed the dispatch agreement (${link.signerName}${link.signerTitle ? `, ${link.signerTitle}` : ''})`,
      metadata: { onboardingLinkId: link.id },
    });
    await notify(owner.id, {
      type: 'onboarding', title: `${carrier.companyName} signed the dispatch agreement`,
      body: `Signed by ${link.signerName}${link.feePercent != null ? ` at ${percentText(link.feePercent)}%` : ''}.`,
      link: customer ? `/app/customers/${customer.id}` : `/app/carriers/${carrier.id}`,
    });
  } catch (err) {
    console.error('[onboarding] activity or notification failed', link.id, err?.message);
  }
  return customer;
}
