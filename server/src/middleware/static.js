import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

/**
 * Precompressed static assets.
 * Hashed client bundles (/assets/*) never change, so compressing them on every download wasted CPU in the shared libuv
 * thread pool, especially right after a deploy when every open tab downloads the new chunks at once. Instead:
 * - precompressAssets(dir) writes `<file>.br` (Brotli quality 11) and `<file>.gz` (gzip level 9) next to each
 *   compressible file once (skipping files whose siblings are already up to date). It runs at build time when the
 *   build calls it, and otherwise once per deploy in the background (see app.js).
 * - precompressedAssets(dir) serves the best sibling the browser accepts, with the right Content-Type and
 *   Content-Encoding, `Vary: Accept-Encoding` and a one-year immutable cache. Anything else falls through to
 *   express.static (with on-the-fly compression).
 * Zero dependencies: node:zlib only.
 */
const TYPES = {
  '.js': 'application/javascript; charset=UTF-8',
  '.mjs': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=UTF-8',
  '.map': 'application/json; charset=UTF-8',
  '.html': 'text/html; charset=UTF-8',
  '.txt': 'text/plain; charset=UTF-8',
  '.xml': 'application/xml; charset=UTF-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=UTF-8',
};
const MIN_BYTES = 1024;
const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const compressible = (name) => Object.hasOwn(TYPES, path.extname(name).toLowerCase());

async function walk(dir, base = dir, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, out);
    else if (e.isFile()) out.push(path.relative(base, p));
  }
  return out;
}

async function fresh(sibling, sourceMtimeMs) {
  try { return (await fsp.stat(sibling)).mtimeMs >= sourceMtimeMs; } catch { return false; }
}

async function writeAtomic(target, data) {
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, target);
}

/**
 * Write .br and .gz siblings for every compressible file under dir (sequentially, one file at a time, so it never
 * occupies more than one thread-pool thread). Returns { compressed, skipped, bytesIn, bytesBr }.
 */
export async function precompressAssets(dir, { minBytes = MIN_BYTES } = {}) {
  const report = { compressed: 0, skipped: 0, bytesIn: 0, bytesBr: 0 };
  for (const rel of await walk(dir)) {
    if (!compressible(rel)) continue;
    const file = path.join(dir, rel);
    const st = await fsp.stat(file);
    if (st.size < minBytes) continue;
    if ((await fresh(`${file}.br`, st.mtimeMs)) && (await fresh(`${file}.gz`, st.mtimeMs))) { report.skipped += 1; continue; }
    const data = await fsp.readFile(file);
    const br = await brotli(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
    const gz = await gzip(data, { level: 9 });
    // Keep a sibling only when it is actually smaller.
    if (br.length < data.length) await writeAtomic(`${file}.br`, br);
    if (gz.length < data.length) await writeAtomic(`${file}.gz`, gz);
    report.compressed += 1;
    report.bytesIn += data.length;
    report.bytesBr += Math.min(br.length, data.length);
  }
  return report;
}

/** Map of relative asset path -> { br, gz, type } for files that have precompressed siblings. */
function scanSync(dir) {
  const map = new Map();
  const visit = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    for (const e of entries) {
      if (e.isDirectory()) { visit(path.join(d, e.name)); continue; }
      if (!e.isFile() || !compressible(e.name)) continue;
      const br = names.has(`${e.name}.br`);
      const gz = names.has(`${e.name}.gz`);
      if (!br && !gz) continue;
      const rel = `/${path.relative(dir, path.join(d, e.name)).split(path.sep).join('/')}`;
      map.set(rel, { br, gz, type: TYPES[path.extname(e.name).toLowerCase()] });
    }
  };
  visit(dir);
  return map;
}

/**
 * Middleware for a directory of immutable, content-hashed files (mount it at the matching URL prefix, e.g. '/assets').
 * Serves `<file>.br` or `<file>.gz` when the browser accepts it, otherwise calls next(). `refresh()` rescans the
 * directory (after precompression finished in this or another process).
 */
export function precompressedAssets(dir) {
  let known = scanSync(dir);
  const mw = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel;
    try { rel = decodeURIComponent(req.path); } catch { return next(); }
    const entry = known.get(rel);
    if (!entry) return next();
    res.vary('Accept-Encoding');
    const accept = String(req.get('accept-encoding') || '');
    const enc = entry.br && /\bbr\b/i.test(accept) ? 'br' : entry.gz && /\bgzip\b/i.test(accept) ? 'gzip' : null;
    if (!enc) return next();
    res.set('Content-Type', entry.type);
    res.set('Content-Encoding', enc);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    const file = path.join(dir, `${rel.slice(1)}${enc === 'br' ? '.br' : '.gz'}`);
    res.sendFile(file, { dotfiles: 'deny' }, (err) => {
      if (!err) return;
      if (res.headersSent) { res.destroy?.(); return; }
      res.removeHeader('Content-Encoding');
      res.removeHeader('Content-Type');
      next(); // sibling vanished: let express.static serve the original
    });
  };
  mw.refresh = () => { known = scanSync(dir); return known.size; };
  mw.count = () => known.size;
  return mw;
}

// CLI: `node src/middleware/static.js <dist-dir>` (for a build step: precompress the client once at build time).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) { console.error('Usage: node src/middleware/static.js <dir>'); process.exit(2); }
  precompressAssets(path.resolve(target)).then((r) => {
    console.log(`[precompress] ${r.compressed} compressed, ${r.skipped} already fresh (${Math.round(r.bytesIn / 1024)} KB -> ${Math.round(r.bytesBr / 1024)} KB brotli)`);
  }).catch((err) => { console.error(err); process.exit(1); });
}
