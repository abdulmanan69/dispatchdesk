import { Router } from 'express';
import fs from 'node:fs';
import { prisma } from '../db.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { parse, z, optDate } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { loadCarrier, loadOwned } from '../lib/access.js';
import { DOCUMENT_TYPES } from '../lib/constants.js';
import { logActivity } from '../lib/activity.js';
import { audit } from '../lib/audit.js';
import { uploader, verifyFileSignature, removeFile, filePath } from '../middleware/upload.js';

const r = Router();
r.use(requirePermission('crm.use'));

const SUBDIR = 'documents';
const upload = uploader('document', SUBDIR);

const publicDoc = (d) => ({
  id: d.id, type: d.type, originalName: d.originalName, mimeType: d.mimeType, sizeBytes: d.sizeBytes, expiresAt: d.expiresAt,
  carrierId: d.carrierId, loadId: d.loadId, createdAt: d.createdAt, updatedAt: d.updatedAt,
  uploadedBy: d.uploadedBy ? { id: d.uploadedBy.id, name: d.uploadedBy.name } : undefined,
});

/** Resolve the parent (carrier or load) and verify access. Returns { ownerId, carrierId, loadId, label }. */
async function resolveParent(user, { carrierId, loadId }, write) {
  if (carrierId) {
    const c = await loadCarrier(user, carrierId, { write });
    return { ownerId: c.ownerId, carrierId: c.id, loadId: null, label: c.companyName };
  }
  if (loadId) {
    const l = await loadOwned('load', user, loadId, { write });
    return { ownerId: l.ownerId, carrierId: null, loadId: l.id, label: `load ${l.referenceNumber || `${l.originCity}, ${l.originState} → ${l.destCity}, ${l.destState}`}`, loadCarrierId: l.carrierId };
  }
  throw badRequest('carrierId or loadId is required');
}

/** Load a document the user may access (through its parent) or 404. */
async function loadDocument(user, id, write = false) {
  const doc = await prisma.document.findUnique({ where: { id: String(id) }, include: { uploadedBy: { select: { id: true, name: true } } } });
  if (!doc) throw notFound('Document not found');
  try {
    if (doc.carrierId) await loadCarrier(user, doc.carrierId, { write });
    else if (doc.loadId) await loadOwned('load', user, doc.loadId, { write });
    else if (doc.ownerId !== user.id) throw notFound();
  } catch (err) {
    if (err.status === 403) throw err;
    throw notFound('Document not found');
  }
  return doc;
}

/** Run after multer: on any failure remove the uploaded temp file. */
const cleanupOnError = (fn) => ah(async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    if (req.file?.path) fs.rmSync(req.file.path, { force: true });
    throw err;
  }
});

r.get('/', ah(async (req, res) => {
  const q = parse(z.object({ carrierId: z.string().optional(), loadId: z.string().optional(), types: z.string().optional() }), req.query);
  const parent = await resolveParent(req.user, q, false);
  const where = parent.carrierId ? { carrierId: parent.carrierId } : { loadId: parent.loadId };
  if (q.types) where.type = { in: q.types.split(',').filter((t) => DOCUMENT_TYPES.includes(t)) };
  const docs = await prisma.document.findMany({ where, orderBy: { createdAt: 'desc' }, include: { uploadedBy: { select: { id: true, name: true } } } });
  res.json({ items: docs.map(publicDoc) });
}));

r.post('/', upload.single('file'), cleanupOnError(async (req, res) => {
  if (!req.file) throw badRequest('Choose a file to upload');
  const body = parse(z.object({
    carrierId: z.string().optional(), loadId: z.string().optional(),
    type: z.enum(DOCUMENT_TYPES).default('other'), expiresAt: optDate,
  }), req.body);
  const parent = await resolveParent(req.user, body, true);
  verifyFileSignature(req.file);
  const doc = await prisma.document.create({
    data: {
      ownerId: parent.ownerId, uploadedById: req.user.id, carrierId: parent.carrierId, loadId: parent.loadId,
      type: body.type, originalName: req.file.originalname.slice(0, 200), storedName: req.file.filename,
      mimeType: req.file.mimetype, sizeBytes: req.file.size, expiresAt: body.expiresAt ?? null,
    },
    include: { uploadedBy: { select: { id: true, name: true } } },
  });
  await logActivity(req.user, {
    type: 'document', carrierId: parent.carrierId ?? parent.loadCarrierId ?? null,
    summary: `Uploaded ${body.type.replace(/_/g, ' ')} "${doc.originalName}" for ${parent.label}`,
  });
  res.status(201).json({ document: publicDoc(doc) });
}));

r.get('/:id/download', ah(async (req, res) => {
  const doc = await loadDocument(req.user, req.params.id);
  const p = filePath(SUBDIR, doc.storedName);
  if (!fs.existsSync(p)) throw notFound('File is missing from storage');
  const inline = req.query.inline === '1' && (doc.mimeType === 'application/pdf' || doc.mimeType.startsWith('image/'));
  res.set('Content-Type', doc.mimeType);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.originalName)}`);
  fs.createReadStream(p).pipe(res);
}));

r.put('/:id', upload.single('file'), cleanupOnError(async (req, res) => {
  const doc = await loadDocument(req.user, req.params.id, true);
  if (!req.file) throw badRequest('Choose a replacement file');
  verifyFileSignature(req.file);
  const body = parse(z.object({ type: z.enum(DOCUMENT_TYPES).optional(), expiresAt: optDate }), req.body);
  const updated = await prisma.document.update({
    where: { id: doc.id },
    data: {
      originalName: req.file.originalname.slice(0, 200), storedName: req.file.filename, mimeType: req.file.mimetype, sizeBytes: req.file.size,
      ...(body.type ? { type: body.type } : {}), ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
    },
    include: { uploadedBy: { select: { id: true, name: true } } },
  });
  removeFile(SUBDIR, doc.storedName);
  await logActivity(req.user, { type: 'document', carrierId: doc.carrierId, summary: `Replaced ${doc.type.replace(/_/g, ' ')} "${doc.originalName}" with "${updated.originalName}"` });
  res.json({ document: publicDoc(updated) });
}));

r.patch('/:id', ah(async (req, res) => {
  const doc = await loadDocument(req.user, req.params.id, true);
  const body = parse(z.object({ type: z.enum(DOCUMENT_TYPES).optional(), expiresAt: optDate }), req.body);
  const data = {};
  if (body.type) data.type = body.type;
  if (body.expiresAt !== undefined) data.expiresAt = body.expiresAt;
  const updated = await prisma.document.update({ where: { id: doc.id }, data, include: { uploadedBy: { select: { id: true, name: true } } } });
  res.json({ document: publicDoc(updated) });
}));

r.delete('/:id', ah(async (req, res) => {
  const doc = await loadDocument(req.user, req.params.id, true);
  await prisma.document.delete({ where: { id: doc.id } });
  removeFile(SUBDIR, doc.storedName);
  await logActivity(req.user, { type: 'document', carrierId: doc.carrierId, summary: `Deleted ${doc.type.replace(/_/g, ' ')} "${doc.originalName}"` });
  await audit(req, 'document.deleted', { entityType: 'document', entityId: doc.id, details: { name: doc.originalName } });
  res.json({ ok: true });
}));

export default r;
