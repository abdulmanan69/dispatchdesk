import { Router } from 'express';
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

r.get('/download', ah(async (req, res) => {
  const dir = extensionDir();
  if (!dir) throw unavailable('The extension files are not available on this server');
  const m = manifest(dir);
  const root = `dispatchdesk-clicker-${m.version}`;
  const entries = folderEntries(dir, root).filter((e) => !e.name.endsWith('/config.json'));
  entries.push({ name: `${root}/config.json`, data: Buffer.from(`${JSON.stringify({ appUrl: config.appUrl }, null, 2)}\n`) });
  const zip = createZip(entries);
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${root}.zip"`,
    'Content-Length': zip.length,
    'Cache-Control': 'no-store',
  });
  res.send(zip);
}));

export default r;
