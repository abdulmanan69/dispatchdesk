import fs from 'node:fs/promises';
import { prisma } from '../../db.js';
import { badRequest } from '../../lib/errors.js';
import { loadCarrier, loadOwned } from '../../lib/access.js';
import { filePath } from '../../middleware/upload.js';

/**
 * Email attachments are stored Documents (routes/documents.js keeps the files under uploads/documents).
 * Email.attachments holds JSON [{ documentId, name, size, mimeType }]; delivery reads the files at send time.
 * Limits: 5 files and 10 MB per email (Gmail allows 25 MB, Microsoft Graph and many SMTP hosts less).
 */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DOC_SUBDIR = 'documents';

export class AttachmentError extends Error {}

/** May `user` attach this document? Owner, or anyone with read access to its carrier or load (team rules). */
async function canUse(user, doc) {
  if (doc.ownerId === user.id) return true;
  try {
    if (doc.carrierId) { await loadCarrier(user, doc.carrierId); return true; }
    if (doc.loadId) { await loadOwned('load', user, doc.loadId); return true; }
  } catch {
    return false;
  }
  return false;
}

/**
 * Validate attachment document ids for `user` and return the Email.attachments JSON string (null for none).
 * Throws 400 (never 404, so other tenants' ids reveal nothing) when an id is unknown or not accessible.
 */
export async function resolveAttachments(user, documentIds) {
  const ids = [...new Set((documentIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!ids.length) return null;
  if (ids.length > MAX_ATTACHMENTS) throw badRequest(`Attach at most ${MAX_ATTACHMENTS} files per email`);
  const docs = await prisma.document.findMany({
    where: { id: { in: ids } },
    select: { id: true, ownerId: true, carrierId: true, loadId: true, originalName: true, sizeBytes: true, mimeType: true },
  });
  if (docs.length !== ids.length) throw badRequest('One or more attachments were not found');
  for (const d of docs) if (!(await canUse(user, d))) throw badRequest('One or more attachments were not found');
  const total = docs.reduce((n, d) => n + (d.sizeBytes || 0), 0);
  if (total > MAX_ATTACHMENT_BYTES) throw badRequest('Attachments are limited to 10 MB per email');
  const byId = new Map(docs.map((d) => [d.id, d]));
  return JSON.stringify(ids.map((id) => {
    const d = byId.get(id);
    return { documentId: d.id, name: d.originalName, size: d.sizeBytes, mimeType: d.mimeType };
  }));
}

export function parseAttachments(json) {
  try {
    const a = JSON.parse(json || 'null');
    return Array.isArray(a) ? a.filter((x) => x && x.documentId) : [];
  } catch {
    return [];
  }
}

/**
 * Read the files for an email's attachments, re-checking access for the sender at send time.
 * Returns [{ filename, content: Buffer, contentType }]. Throws AttachmentError with a user-facing message.
 */
export async function loadAttachmentFiles(user, json) {
  const list = parseAttachments(json);
  if (!list.length) return [];
  const docs = await prisma.document.findMany({ where: { id: { in: list.map((a) => a.documentId) } } });
  const byId = new Map(docs.map((d) => [d.id, d]));
  const out = [];
  let total = 0;
  for (const a of list.slice(0, MAX_ATTACHMENTS)) {
    const d = byId.get(a.documentId);
    if (!d || !(await canUse(user, d))) throw new AttachmentError(`Attachment "${a.name || 'file'}" is no longer available`);
    let content;
    try {
      content = await fs.readFile(filePath(DOC_SUBDIR, d.storedName));
    } catch {
      throw new AttachmentError(`Attachment "${d.originalName}" is missing from storage`);
    }
    total += content.length;
    if (total > MAX_ATTACHMENT_BYTES) throw new AttachmentError('Attachments are limited to 10 MB per email');
    out.push({ filename: d.originalName, content, contentType: d.mimeType || 'application/octet-stream' });
  }
  return out;
}
