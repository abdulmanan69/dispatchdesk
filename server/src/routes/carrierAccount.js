import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest, notFound, unauthorized, HttpError } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { makeLimiter } from '../middleware/security.js';
import { uploader, verifyFileSignature, filePath, removeFile } from '../middleware/upload.js';
import {
  SESSION_COOKIE, VAULT_DIR, VAULT_FILE_MB, MAX_VAULT_FILES, VAULT_TYPES, VAULT_LABEL, DEFAULT_SHARE,
  startLogin, verifyLogin, sessionCookieOptions, accountForSession, endSession, maskEmail,
  connectionsFor, currentDocuments, shareWith, stopSharing, fanOutUpload,
} from '../services/carrierAccounts/index.js';
import { portalSummary, portalStatement, portalPrintHtml, sendPortalDocument } from '../services/invoices/portalViews.js';

/**
 * Carrier account API (/api/public/carrier), for carriers, not dispatchers. Sign-in is a code sent to the email FMCSA
 * has on file for the USDOT number (services/carrierAccounts); the session is the httpOnly dd_carrier cookie. Writes
 * need the usual CSRF header (this path is not CSRF-exempt).
 *   POST /login/start { number }            send a code to the FMCSA email      POST /login/verify { number, code }
 *   POST /logout
 *   GET  /me                                 account, documents, connections (dispatchers that invited this carrier)
 *   DELETE /me                               delete the profile (sessions, shares, vault files)
 *   POST /documents (multipart file, type, expiresAt)   GET /documents/:id/file   DELETE /documents/:id
 *   PUT  /connections/:carrierId/share { docTypes, autoUpdate }    POST /connections/:carrierId/stop { hide }
 *   GET  /connections/:carrierId/statements[/:week[/print]]       GET /connections/:carrierId/documents/:documentId
 * A connection is a dispatcher's carrier record with this USDOT number and an agreement link or a customer profile.
 */
const r = Router();

r.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

const startLimiter = makeLimiter('carrier-login-start', 15 * 60_000, 10, 'Too many sign-in attempts. Try again in 15 minutes.');
const verifyLimiter = makeLimiter('carrier-login-verify', 15 * 60_000, 30, 'Too many sign-in attempts. Try again in 15 minutes.');

r.post('/login/start', startLimiter, ah(async (req, res) => {
  const { number } = parse(z.object({ number: z.string().trim().min(1, 'Enter your USDOT number').max(24) }).strict(), req.body);
  res.json(await startLogin({ number, ip: req.ip }));
}));

r.post('/login/verify', verifyLimiter, ah(async (req, res) => {
  const body = parse(z.object({ number: z.string().trim().min(1).max(24), code: z.string().trim().min(1, 'Enter the code').max(12) }).strict(), req.body);
  const { account, token } = await verifyLogin({ ...body, userAgent: req.get('user-agent') });
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
  res.json({ ok: true, dotNumber: account.dotNumber });
}));

r.post('/logout', ah(async (req, res) => {
  await endSession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
  res.json({ ok: true });
}));

// Everything below needs a signed-in carrier.
const signedIn = ah(async (req, res, next) => {
  const s = await accountForSession(req.cookies?.[SESSION_COOKIE]);
  if (!s) throw unauthorized('Sign in with your USDOT number.');
  req.carrierAccount = s.account;
  next();
});
r.use(signedIn);

const docView = (d) => ({
  id: d.id, type: d.type, label: VAULT_LABEL[d.type] || 'Document', originalName: d.originalName, mimeType: d.mimeType,
  sizeBytes: d.sizeBytes, expiresAt: d.expiresAt, createdAt: d.createdAt,
});

r.get('/me', ah(async (req, res) => {
  const a = req.carrierAccount;
  const [documents, connections] = await Promise.all([currentDocuments(a.id), connectionsFor(a)]);
  res.json({
    account: { dotNumber: a.dotNumber, legalName: a.legalName, email: maskEmail(a.verifiedEmail), verifiedAt: a.verifiedAt },
    documents: documents.map(docView),
    connections,
    types: VAULT_TYPES.map((t) => ({ value: t, label: VAULT_LABEL[t] })),
    defaultShare: DEFAULT_SHARE,
  });
}));

/** Delete the profile: sessions, shares and vault files. Copies dispatchers already received stay with them. */
r.delete('/me', ah(async (req, res) => {
  const a = req.carrierAccount;
  const files = await prisma.carrierVaultDocument.findMany({ where: { accountId: a.id }, select: { storedName: true } });
  await prisma.carrierAccount.delete({ where: { id: a.id } });
  files.forEach((f) => removeFile(VAULT_DIR, f.storedName));
  res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------------------------------------------
// Vault documents
// ---------------------------------------------------------------------------------------------------------------

const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png']);
const vaultUpload = uploader('driver', VAULT_DIR, VAULT_FILE_MB, { quota: false });
const cleanName = (s) => String(s || '').replace(/[^\w .()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
const beforeVaultUpload = ah(async (req, res, next) => {
  const count = await prisma.carrierVaultDocument.count({ where: { accountId: req.carrierAccount.id, replacedAt: null } });
  if (count >= MAX_VAULT_FILES) throw new HttpError(429, `Your profile can hold ${MAX_VAULT_FILES} documents. Delete old ones first.`);
  next();
});

r.post('/documents', beforeVaultUpload, vaultUpload.single('file'), ah(async (req, res) => {
  const a = req.carrierAccount;
  let stored = req.file?.path || null;
  try {
    if (!req.file) throw badRequest('Choose a PDF or photo to upload.');
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) throw badRequest('Upload a PDF, JPG or PNG file.');
    const body = parse(z.object({
      type: z.enum(VAULT_TYPES, { message: 'Pick which document this is' }),
      expiresAt: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the expiry date as YYYY-MM-DD').optional().or(z.literal('')),
    }), req.body || {});
    verifyFileSignature(req.file);
    const storedName = `cv-${a.id.slice(-8)}-${req.file.filename}`;
    fs.renameSync(req.file.path, filePath(VAULT_DIR, storedName));
    stored = filePath(VAULT_DIR, storedName);
    const mimeType = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg';
    const expiresAt = body.expiresAt ? new Date(`${body.expiresAt}T23:59:59Z`) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw badRequest('Enter a valid expiry date');
    // One current document per type (except "other"): the new upload replaces the previous one.
    const doc = await prisma.$transaction(async (tx) => {
      if (body.type !== 'other') await tx.carrierVaultDocument.updateMany({ where: { accountId: a.id, type: body.type, replacedAt: null }, data: { replacedAt: new Date() } });
      return tx.carrierVaultDocument.create({
        data: {
          accountId: a.id, type: body.type, storedName, mimeType, sizeBytes: req.file.size, expiresAt,
          originalName: `${cleanName(path.basename(req.file.originalname, path.extname(req.file.originalname))) || VAULT_LABEL[body.type]}${ext === '.jpeg' ? '.jpg' : ext}`,
        },
      });
    });
    stored = null;
    const sentTo = await fanOutUpload(a, doc).catch(() => 0);
    res.status(201).json({ document: docView(doc), sentTo });
  } catch (err) {
    if (stored) fs.rmSync(stored, { force: true });
    throw err;
  }
}));

async function ownDoc(req) {
  const d = await prisma.carrierVaultDocument.findFirst({ where: { id: String(req.params.id), accountId: req.carrierAccount.id } });
  if (!d) throw notFound('Document not found');
  return d;
}

r.get('/documents/:id/file', ah(async (req, res) => {
  const d = await ownDoc(req);
  const p = filePath(VAULT_DIR, d.storedName);
  if (!fs.existsSync(p)) throw notFound('File is missing from storage');
  res.set('Content-Type', d.mimeType);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(d.originalName)}`);
  fs.createReadStream(p).on('error', () => res.destroy()).pipe(res);
}));

r.delete('/documents/:id', ah(async (req, res) => {
  const d = await ownDoc(req);
  await prisma.carrierVaultDocument.delete({ where: { id: d.id } });
  removeFile(VAULT_DIR, d.storedName);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------------------------------------------
// Connections and sharing
// ---------------------------------------------------------------------------------------------------------------

r.put('/connections/:carrierId/share', ah(async (req, res) => {
  const body = parse(z.object({ docTypes: z.array(z.enum(VAULT_TYPES)).min(1, 'Pick at least one document to share').max(VAULT_TYPES.length), autoUpdate: z.boolean().default(true) }).strict(), req.body);
  const { copied } = await shareWith(req.carrierAccount, req.params.carrierId, body);
  res.json({ ok: true, copied, connections: await connectionsFor(req.carrierAccount) });
}));

r.post('/connections/:carrierId/stop', ah(async (req, res) => {
  const { hide } = parse(z.object({ hide: z.boolean().default(false) }).strict(), req.body || {});
  await stopSharing(req.carrierAccount, req.params.carrierId, { hide });
  res.json({ ok: true, connections: await connectionsFor(req.carrierAccount) });
}));

/** The customer behind a connection when its dispatcher turned on statements (a live portal link); 404 otherwise. */
async function statementCustomer(account, carrierId) {
  const customer = await prisma.customer.findFirst({
    where: { carrierId: String(carrierId), carrier: { dotNumber: account.dotNumber } },
    include: {
      carrier: { select: { id: true, companyName: true, mcNumber: true, dotNumber: true } },
      owner: { select: { id: true, name: true, email: true, phone: true, timezone: true, status: true, teamMembership: { select: { team: { select: { name: true } } } } } },
    },
  });
  const now = new Date();
  if (!customer || !customer.portalTokenHash || !customer.portalExpiresAt || customer.portalExpiresAt <= now || customer.status === 'churned' || customer.owner?.status !== 'active') {
    throw notFound('This dispatcher has not turned on statements for you. Ask them to share your portal.');
  }
  return customer;
}

r.get('/connections/:carrierId/statements', ah(async (req, res) => {
  res.json(await portalSummary(await statementCustomer(req.carrierAccount, req.params.carrierId)));
}));
r.get('/connections/:carrierId/statements/:week', ah(async (req, res) => {
  res.json(await portalStatement(await statementCustomer(req.carrierAccount, req.params.carrierId), req.params.week));
}));
r.get('/connections/:carrierId/statements/:week/print', ah(async (req, res) => {
  res.type('html').send(await portalPrintHtml(await statementCustomer(req.carrierAccount, req.params.carrierId), req.params.week));
}));
r.get('/connections/:carrierId/documents/:documentId', ah(async (req, res) => {
  await sendPortalDocument(await statementCustomer(req.carrierAccount, req.params.carrierId), req.params.documentId, res);
}));

export default r;
