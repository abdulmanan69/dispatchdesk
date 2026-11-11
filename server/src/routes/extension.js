import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { ah, unavailable } from '../lib/errors.js';
import { createZip, folderEntries } from '../services/zip.js';

/**
 * Browser extension distribution. The zip is built on the fly from the `extension/` folder
 * and includes a generated config.json pointing the extension at this server.
 */
const r = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function extensionDir() {
  const candidates = [
    process.env.EXTENSION_DIR,
    path.resolve(__dirname, '../../../extension'), // repo layout: server/src/routes → extension
    '/app/extension', // Docker runtime image
  ].filter(Boolean);
  return candidates.find((d) => fs.existsSync(path.join(d, 'manifest.json'))) || null;
}

function manifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

r.get('/info', ah(async (req, res) => {
  const dir = extensionDir();
  if (!dir) throw unavailable('The extension files are not available on this server');
  const m = manifest(dir);
  res.json({ name: m.name, version: m.version, appUrl: config.appUrl });
}));

// The zip only changes with the extension files (a new deploy restarts every process) or the app URL, so each
// process builds it once (deflate level 9 over the whole folder is too much CPU to repeat per download).
let built = null; // { key, zip, etag, root }

function buildZip(dir) {
  const m = manifest(dir);
  const key = `${dir}|${m.version}|${config.appUrl}|${fs.statSync(path.join(dir, 'manifest.json')).mtimeMs}`;
  if (built?.key === key) return built;
  const root = `dispatchdesk-clicker-${m.version}`;
  const entries = folderEntries(dir, root).filter((e) => !e.name.endsWith('/config.json'));
  entries.push({ name: `${root}/config.json`, data: Buffer.from(`${JSON.stringify({ appUrl: config.appUrl }, null, 2)}\n`) });
  const zip = createZip(entries);
  built = { key, zip, root, etag: `"${crypto.createHash('sha1').update(zip).digest('base64url')}"` };
  return built;
}

r.get('/download', ah(async (req, res) => {
  const dir = extensionDir();
  if (!dir) throw unavailable('The extension files are not available on this server');
  const { zip, root, etag } = buildZip(dir);
  res.set({ ETag: etag, 'Cache-Control': 'private, max-age=3600' });
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${root}.zip"`,
    'Content-Length': zip.length,
  });
  res.send(zip);
}));

export default r;
