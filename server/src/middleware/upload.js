import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../config.js';
import { randomToken } from '../lib/crypto.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { storageStatus, storageFullError } from '../lib/plans.js';
import { uploadLimiter } from './security.js';

const TYPES = {
  document: {
    '.pdf': ['application/pdf'], '.png': ['image/png'], '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.webp': ['image/webp'],
    '.doc': ['application/msword'], '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    '.xls': ['application/vnd.ms-excel'], '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    '.txt': ['text/plain'], '.csv': ['text/csv', 'application/vnd.ms-excel', 'text/plain'],
  },
  image: { '.png': ['image/png'], '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.webp': ['image/webp'], '.gif': ['image/gif'] },
  // Photos and scans sent from the driver link: images and PDF only.
  driver: { '.pdf': ['application/pdf'], '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.png': ['image/png'], '.webp': ['image/webp'] },
  csv: { '.csv': ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/octet-stream'] },
  knowledge: { '.pdf': ['application/pdf'], '.txt': ['text/plain'], '.md': ['text/markdown', 'text/plain', 'application/octet-stream'], '.csv': ['text/csv', 'text/plain', 'application/vnd.ms-excel'] },
  training: {
    '.pdf': ['application/pdf'], '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'], '.mp4': ['video/mp4'], '.webm': ['video/webm'],
    '.png': ['image/png'], '.jpg': ['image/jpeg'], '.txt': ['text/plain'],
  },
};

// Magic-byte signatures for binary formats; text formats are checked for NUL bytes.
const MAGIC = {
  '.pdf': [Buffer.from('%PDF')],
  '.png': [Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  '.jpg': [Buffer.from([0xff, 0xd8, 0xff])],
  '.jpeg': [Buffer.from([0xff, 0xd8, 0xff])],
  '.gif': [Buffer.from('GIF8')],
  '.webp': [Buffer.from('RIFF')],
  '.docx': [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  '.xlsx': [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  '.pptx': [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  '.doc': [Buffer.from([0xd0, 0xcf, 0x11, 0xe0])],
  '.xls': [Buffer.from([0xd0, 0xcf, 0x11, 0xe0])],
};
const TEXT = new Set(['.txt', '.csv', '.md']);
const WEBP_FORM = Buffer.from('WEBP'); // bytes 8-11 of a WebP file

const MB = 1024 * 1024;
// Kinds whose files stay on disk for the user and count toward their storage quota (see lib/plans.js STORAGE_MB).
const QUOTA_KINDS = new Set(['document', 'image', 'knowledge', 'driver']);
// Multipart framing and the other form fields around the file; a request bigger than the free space plus this is refused up front.
const MULTIPART_SLACK = 64 * 1024;

/**
 * Multer-compatible uploader: `uploader(kind, subdir, maxMb).single('file')` returns middleware that
 * 1. rate-limits uploads per user,
 * 2. checks the account's storage quota BEFORE the file is written (402 with a clear message when it is full, using
 *    Content-Length to refuse oversized requests without reading them) and caps the file at the free space left,
 * 3. writes the file with a random name and enforces the per-file size and type rules.
 *
 * Options: quota (default: on for document, image, knowledge and driver uploads), quotaUser(req) => user whose storage
 * is used (default req.user; public routes such as the driver link pass the link owner), quotaCredit(req) => bytes that
 * the upload replaces (an existing avatar or document), so replacing a file is not counted twice.
 */
export function uploader(kind, subdir, maxMb = config.maxUploadMb, { quota = QUOTA_KINDS.has(kind), quotaUser = null, quotaCredit = null } = {}) {
  const allowed = TYPES[kind];
  if (!allowed) throw new Error(`Unknown upload kind ${kind}`);
  const dir = path.join(config.uploadDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const maxBytes = Math.round(maxMb * MB);
  const storage = multer.diskStorage({
    destination: dir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${randomToken(12)}${path.extname(file.originalname).toLowerCase()}`),
  });
  const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed[ext]) return cb(badRequest(`File type ${ext || '(none)'} is not allowed. Allowed: ${Object.keys(allowed).join(', ')}`));
    if (!allowed[ext].includes(file.mimetype) && file.mimetype !== 'application/octet-stream') {
      return cb(badRequest(`File content type ${file.mimetype} does not match ${ext}`));
    }
    cb(null, true);
  };
  const build = (fileSize) => multer({ storage, limits: { fileSize, files: 1 }, fileFilter });
  const full = build(maxBytes);

  const single = (field) => {
    const fullSingle = full.single(field);
    return (req, res, next) => {
      uploadLimiter(req, res, async (limitErr) => {
        if (limitErr) return next(limitErr);
        try {
          let status = null;
          const owner = quota ? (quotaUser ? await quotaUser(req) : req.user) : null;
          if (owner) {
            status = await storageStatus(owner);
            const credit = quotaCredit ? Math.max(0, Number(await quotaCredit(req)) || 0) : 0;
            status = { ...status, remainingBytes: Math.max(0, status.limitBytes - status.usedBytes + credit) };
            const declared = Number(req.get('content-length')) || 0;
            if (status.remainingBytes <= 0 || declared > status.remainingBytes + MULTIPART_SLACK) {
              return next(storageFullError(status, declared > MULTIPART_SLACK ? declared - MULTIPART_SLACK : 0));
            }
          }
          const cap = status ? Math.min(maxBytes, status.remainingBytes) : maxBytes;
          const handler = cap === maxBytes ? fullSingle : build(cap).single(field);
          handler(req, res, (err) => {
            if (err?.code === 'LIMIT_FILE_SIZE') {
              if (status && cap < maxBytes) return next(storageFullError(status));
              return next(new HttpError(413, `File is too large (max ${maxMb} MB)`));
            }
            next(err);
          });
        } catch (err) {
          next(err);
        }
      });
    };
  };
  return { single };
}

/** After multer has written the file, verify its leading bytes match the extension. Deletes and throws on mismatch. */
export function verifyFileSignature(file) {
  if (!file) return;
  const ext = path.extname(file.originalname).toLowerCase();
  const fd = fs.openSync(file.path, 'r');
  const head = Buffer.alloc(512);
  const n = fs.readSync(fd, head, 0, 512, 0);
  fs.closeSync(fd);
  const buf = head.subarray(0, n);
  let ok = true;
  if (MAGIC[ext]) ok = MAGIC[ext].some((sig) => buf.subarray(0, sig.length).equals(sig));
  else if (TEXT.has(ext)) ok = !buf.includes(0);
  // WebP is a RIFF container: also require its form type, so a WAV or AVI file is not accepted as an image
  // (the driver link lets anyone holding the link upload).
  if (ok && ext === '.webp') ok = buf.subarray(8, 12).equals(WEBP_FORM);
  if (!ok) {
    fs.rmSync(file.path, { force: true });
    throw badRequest('File contents do not match its type');
  }
}

export function removeFile(subdir, storedName) {
  if (!storedName) return;
  const p = path.join(config.uploadDir, subdir, path.basename(storedName));
  fs.rmSync(p, { force: true });
}

export function filePath(subdir, storedName) {
  return path.join(config.uploadDir, subdir, path.basename(storedName));
}

/** Size in bytes of a stored file, or 0 when it is missing. */
export function storedFileSize(subdir, storedName) {
  if (!storedName) return 0;
  try { return fs.statSync(filePath(subdir, storedName)).size; } catch { return 0; }
}
