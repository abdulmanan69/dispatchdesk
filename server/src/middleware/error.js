import multer from 'multer';
import { HttpError } from '../lib/errors.js';
import { config } from '../config.js';

export function notFoundApi(req, res) {
  res.status(404).json({ error: `No API route for ${req.method} ${req.path}` });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is too large (max ${config.maxUploadMb} MB)` : err.message;
    return res.status(400).json({ error: msg });
  }
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err?.code === 'P2002') {
    return res.status(409).json({ error: 'A record with these unique values already exists', details: err.meta });
  }
  if (err?.code === 'P2025') return res.status(404).json({ error: 'Record not found' });
  console.error('[error]', req.method, req.path, err);
  res.status(500).json({ error: 'Something went wrong on our side. The error has been logged.' });
}
