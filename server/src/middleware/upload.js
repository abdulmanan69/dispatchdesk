import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../config.js';
import { randomToken } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';

const TYPES = {
  document: {
    '.pdf': ['application/pdf'], '.png': ['image/png'], '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.webp': ['image/webp'],
    '.doc': ['application/msword'], '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    '.xls': ['application/vnd.ms-excel'], '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    '.txt': ['text/plain'], '.csv': ['text/csv', 'application/vnd.ms-excel', 'text/plain'],
  },
  image: { '.png': ['image/png'], '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.webp': ['image/webp'], '.gif': ['image/gif'] },
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

export function uploader(kind, subdir, maxMb = config.maxUploadMb) {
  const allowed = TYPES[kind];
  const dir = path.join(config.uploadDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (req, file, cb) => cb(null, `${Date.now()}-${randomToken(12)}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!allowed[ext]) return cb(badRequest(`File type ${ext || '(none)'} is not allowed. Allowed: ${Object.keys(allowed).join(', ')}`));
      if (!allowed[ext].includes(file.mimetype) && file.mimetype !== 'application/octet-stream') {
        return cb(badRequest(`File content type ${file.mimetype} does not match ${ext}`));
      }
      cb(null, true);
    },
  });
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
