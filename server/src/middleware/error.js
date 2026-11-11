import multer from 'multer';
import { HttpError } from '../lib/errors.js';
import { config } from '../config.js';

export function notFoundApi(req, res) {
  res.status(404).json({ error: `No API route for ${req.method} ${req.path}` });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    // A streamed response (export, download) failed midway: end it so the client sees an incomplete transfer.
    console.error('[error] after headers were sent', req.method, req.path, err?.message);
    res.destroy?.(err);
    return;
  }
  if (err instanceof HttpError) {
    // Machine-readable codes (EMAIL_UNVERIFIED, STORAGE_FULL, ...) are repeated at the top level for clients.
    return res.status(err.status).json({ error: err.message, details: err.details, ...(err.details?.code ? { code: err.details.code } : {}) });
  }
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is too large (max ${config.maxUploadMb} MB)` : err.message;
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: msg });
  }
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err?.code === 'P2002') {
    return res.status(409).json({ error: 'A record with these unique values already exists', details: err.meta });
  }
  if (err?.code === 'P2025') return res.status(404).json({ error: 'Record not found' });
  if (err?.code === 'LOCK_BUSY') return res.status(409).json({ error: 'This is already being processed. Try again in a moment.' });
  console.error('[error]', req.method, req.path, err);
  res.status(500).json({ error: 'Something went wrong on our side. The error has been logged.' });
}
