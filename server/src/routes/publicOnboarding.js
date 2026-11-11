import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest, conflict, HttpError } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { logActivity, notify } from '../lib/activity.js';
import { uploader, verifyFileSignature, filePath } from '../middleware/upload.js';
import {
  DOC_KINDS, DOC_KIND_LABEL, DOC_KIND_PHRASE, DOC_KIND_TYPE, MAX_FILES_PER_LINK, MAX_FILE_MB,
  resolvePublicLink, publicView, markViewed, linkDocuments, uploadsOpen, parseDocs, storedPrefix, afterSigned, gone, asksContactConsent,
} from '../services/onboarding/links.js';
import { normalizeSignaturePath, normalizeTypedSignature, encodeSignature, MAX_PATH_CHARS } from '../services/onboarding/signature.js';
import { onboardingConsentText, withContactConsent } from '../services/onboarding/contactConsent.js';
import { CHANNELS, normalizePhone, formatPhone, recordConsent } from '../services/consent/index.js';

/**
 * Public carrier onboarding link: GET /:token, consent, sign, document uploads. Token in the URL is the credential
 * (looked up by its sha256 only; no session, no CSRF). Rate limits are applied in app.js. Responses carry only what
 * the carrier's page needs: the carrier and dispatcher names, the agreement and the requested documents.
 */
const r = Router();

const docSelect = { id: true, storedName: true, createdAt: true };

r.get('/:token', ah(async (req, res) => {
  const link = await resolvePublicLink(req.params.token);
  await markViewed(link);
  const docs = await linkDocuments(link, docSelect);
  res.set('Cache-Control', 'no-store');
  res.json(await withContactConsent(publicView(link, docs), link));
}));

/** ESIGN / UETA: the carrier agrees to use electronic records and signatures. Required before signing. */
r.post('/:token/consent', ah(async (req, res) => {
  const link = await resolvePublicLink(req.params.token);
  parse(z.object({ agree: z.literal(true, { message: 'Check the box to agree' }) }), req.body);
  if (link.status === 'signed') throw conflict('This agreement is already signed.', { code: 'ALREADY_SIGNED' });
  if (!link.consentAt) {
    await prisma.onboardingLink.updateMany({ where: { id: link.id, consentAt: null }, data: { consentAt: new Date() } });
  }
  const fresh = await prisma.onboardingLink.findUnique({ where: { id: link.id }, select: { consentAt: true } });
  res.json({ consentAt: fresh.consentAt });
}));

const signSchema = z.object({
  signerName: z.string().trim().min(2, 'Enter your full name').max(120),
  signerTitle: z.string().trim().min(1, 'Enter your title').max(80),
  signerEmail: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
  signatureType: z.enum(['typed', 'drawn']),
  signatureData: z.string().min(1, 'Add your signature').max(MAX_PATH_CHARS, 'The drawn signature is too detailed. Clear it and sign again.'),
  agreementHash: z.string().regex(/^[a-f0-9]{64}$/, 'Reload the page and try again'),
  agree: z.literal(true, { message: 'Check the box to agree to the terms' }),
  // Optional and separate from the agreement: sent only when the carrier ticks the calls-and-texts box.
  contactConsent: z.object({
    agree: z.literal(true, { message: 'Check the box to agree to calls and texts, or leave it unticked' }),
    phone: z.string().trim().min(1, 'Enter the phone number for calls and texts').max(40),
    text: z.string().min(1).max(2000),
  }).strict().optional(),
}).strict();

/** Validate the optional consent before anything is written: { phone, text } to store, or null. */
function contactConsentInput(link, input) {
  if (!input) return null;
  if (!asksContactConsent(link)) throw badRequest('This link does not ask for permission to call and text.');
  const phone = normalizePhone(input.phone);
  if (!phone) throw badRequest('Enter a 10-digit US phone number for calls and texts, or untick that box.');
  const text = onboardingConsentText(link, phone);
  if (input.text !== text) {
    throw conflict('The calls and texts wording changed after you opened the page. Reload the page and try again.', { code: 'CONSENT_TEXT_CHANGED' });
  }
  return { phone, text };
}

r.post('/:token/sign', ah(async (req, res) => {
  const link = await resolvePublicLink(req.params.token);
  if (link.status === 'signed') throw conflict('This agreement is already signed.', { code: 'ALREADY_SIGNED' });
  const body = parse(signSchema, req.body);
  if (!link.consentAt) throw conflict('Agree to sign electronically first.', { code: 'CONSENT_REQUIRED' });
  if (body.agreementHash !== link.agreementHash) {
    throw conflict('The agreement changed after you opened it. Reload the page to read the current version.', { code: 'AGREEMENT_CHANGED' });
  }
  const sig = body.signatureType === 'typed' ? normalizeTypedSignature(body.signatureData) : normalizeSignaturePath(body.signatureData);
  if (!sig) throw badRequest(body.signatureType === 'typed' ? 'Type your name as your signature' : 'The drawn signature could not be read. Clear it and sign again.');
  const contactConsent = contactConsentInput(link, body.contactConsent);

  const signedAt = new Date();
  const ip = String(req.ip || '').slice(0, 64) || null;
  const userAgent = String(req.get('user-agent') || '').slice(0, 500) || null;
  // Atomic: only a pending, unexpired link can be signed, once (two taps or two phones cannot both sign). The optional
  // consent to calls and texts is written in the same transaction, so it exists exactly when the signature does.
  const { count, consentId } = await prisma.$transaction(async (tx) => {
    const res2 = await tx.onboardingLink.updateMany({
      where: { id: link.id, status: 'pending', signedAt: null, expiresAt: { gt: signedAt } },
      data: {
        status: 'signed', signedAt, signerName: body.signerName, signerTitle: body.signerTitle, signerEmail: body.signerEmail,
        signatureData: encodeSignature(body.signatureType, sig), signerIp: ip, signerUserAgent: userAgent,
      },
    });
    if (!res2.count || !contactConsent) return { count: res2.count, consentId: null };
    const row = await recordConsent({
      ownerId: link.carrier.ownerId, carrierId: link.carrierId, phone: contactConsent.phone, channels: CHANNELS, source: 'onboarding',
      consentText: contactConsent.text, onboardingLinkId: link.id, grantedAt: signedAt, grantedByName: body.signerName, ip, userAgent,
    }, tx);
    return { count: res2.count, consentId: row.id };
  });
  if (!count) {
    const now = await prisma.onboardingLink.findUnique({ where: { id: link.id }, select: { status: true } });
    if (now?.status === 'signed') throw conflict('This agreement is already signed.', { code: 'ALREADY_SIGNED' });
    if (now?.status === 'revoked') throw gone('revoked');
    throw gone('expired');
  }
  const signed = await prisma.onboardingLink.findUnique({ where: { id: link.id }, include: { carrier: { select: { id: true, companyName: true, ownerId: true, assignedToId: true } } } });
  await afterSigned({ ...signed, owner: link.owner });
  if (consentId) {
    await logActivity(link.owner, {
      type: 'consent', carrierId: link.carrierId,
      summary: `${body.signerName} agreed to automated calls and texts at ${formatPhone(contactConsent.phone)} when signing the dispatch agreement`.slice(0, 500),
      metadata: { contactConsentId: consentId, action: 'recorded', onboardingLinkId: link.id },
    }).catch(() => {});
  }
  const docs = await linkDocuments(signed, docSelect);
  const view = { ...signed, owner: link.owner };
  res.json(await withContactConsent(publicView(view, docs), view));
}));

// ---------------------------------------------------------------------------
// Document uploads (W-9, insurance, authority, voided check, notice of assignment)
// ---------------------------------------------------------------------------

const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png']);

/** Before the file is read: valid link, uploads open, under the per-link cap. The file counts toward the dispatcher's storage. */
const beforeUpload = ah(async (req, res, next) => {
  const link = await resolvePublicLink(req.params.token);
  if (!uploadsOpen(link)) throw gone('closed');
  if (!parseDocs(link.requestedDocs).length) throw badRequest('This link does not ask for documents.');
  const used = await prisma.document.count({ where: { carrierId: link.carrierId, source: 'onboarding', storedName: { startsWith: storedPrefix(link.id) } } });
  if (used >= MAX_FILES_PER_LINK) {
    throw new HttpError(429, `This link can take ${MAX_FILES_PER_LINK} files. Send anything else to your dispatcher directly.`, { code: 'UPLOAD_CAP' });
  }
  req.onboardingLink = link;
  next();
});
const docUpload = uploader('driver', 'documents', MAX_FILE_MB, { quotaUser: (req) => req.onboardingLink.owner });

const cleanName = (s) => String(s || '').replace(/[^\w .()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

r.post('/:token/documents', beforeUpload, docUpload.single('file'), ah(async (req, res) => {
  const link = req.onboardingLink;
  let stored = req.file?.path || null;
  try {
    if (!req.file) throw badRequest('Choose a PDF or photo to upload.');
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) throw badRequest('Upload a PDF, JPG or PNG file.');
    const { type: kind } = parse(z.object({ type: z.enum(DOC_KINDS, { message: 'Pick which document this is' }) }), req.body || {});
    if (!parseDocs(link.requestedDocs).includes(kind)) throw badRequest('Your dispatcher did not ask for this document on this link.');
    verifyFileSignature(req.file);
    // Bind the file to this link and document kind through its stored name (see services/onboarding/links.js).
    const storedName = `${storedPrefix(link.id, kind)}${req.file.filename}`;
    fs.renameSync(req.file.path, filePath('documents', storedName));
    stored = filePath('documents', storedName);
    const used = await prisma.document.count({ where: { carrierId: link.carrierId, source: 'onboarding', storedName: { startsWith: storedPrefix(link.id) } } });
    if (used >= MAX_FILES_PER_LINK) throw new HttpError(429, `This link can take ${MAX_FILES_PER_LINK} files. Send anything else to your dispatcher directly.`, { code: 'UPLOAD_CAP' });
    const mimeType = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg';
    const doc = await prisma.document.create({
      data: {
        ownerId: link.ownerId, uploadedById: link.ownerId, carrierId: link.carrierId, type: DOC_KIND_TYPE[kind],
        originalName: `${cleanName(`${DOC_KIND_LABEL[kind]} - ${link.carrier.companyName}`)}${ext === '.jpeg' ? '.jpg' : ext}`,
        storedName, mimeType, sizeBytes: req.file.size, source: 'onboarding',
      },
    });
    stored = null;
    await notify(link.ownerId, {
      type: 'onboarding', title: `${link.carrier.companyName} uploaded their ${DOC_KIND_PHRASE[kind]}`.slice(0, 200),
      body: 'From the onboarding link', link: `/app/carriers/${link.carrierId}`,
    }).catch(() => {});
    await logActivity(link.owner, { type: 'document', carrierId: link.carrierId, summary: `${link.carrier.companyName} uploaded their ${DOC_KIND_PHRASE[kind]} from the onboarding link` }).catch(() => {});
    const docs = await linkDocuments(link, docSelect);
    res.status(201).json({ document: { id: doc.id, kind, createdAt: doc.createdAt }, ...(await withContactConsent(publicView(link, docs), link)) });
  } catch (err) {
    if (stored) fs.rmSync(stored, { force: true });
    throw err;
  }
}));

export default r;
