#!/usr/bin/env node
/**
 * README: self-hosted files for in-browser OCR (scanned rate cons)
 * ---------------------------------------------------------------
 * The rate con import reads scanned PDFs and photos with tesseract.js in the user's browser. Every file it needs is
 * served by our own app from /ocr/ (client/public/ocr/), so nothing is loaded from a third-party CDN at runtime and
 * the server only serves static files (no OCR work on the server).
 *
 * Run from anywhere, after `npm install` in client/ (and again whenever tesseract.js, tesseract.js-core or pdfjs-dist
 * is upgraded; client/src/components/dispatch/ocrVendor.test.js fails until you do):
 *
 *   node tools/ocr/vendor.mjs                  copy from client/node_modules, download the English model if needed
 *   node tools/ocr/vendor.mjs --data <file>    use a local eng.traineddata instead of downloading it
 *
 * What it writes to client/public/ocr/:
 *   worker.min.js                     tesseract.js web worker (tesseract.js/dist, source map comment removed)
 *   tesseract-core-simd-lstm.wasm.js  OCR engine with WebAssembly SIMD (current browsers), LSTM only
 *   tesseract-core-lstm.wasm.js       same engine for browsers without WebAssembly SIMD
 *   eng.traineddata.gz                English LSTM model from tesseract-ocr/tessdata_fast 4.1.0 (integer "fast"
 *                                     model), checked against its SHA-256 and gzipped (tesseract.js gunzips it)
 *   pdfjs/jbig2.wasm, pdfjs/openjpeg.wasm
 *                                     pdf.js image decoders for scanned PDFs (JBIG2, CCITT fax, JPEG 2000), passed
 *                                     to pdf.js as `wasmUrl` when a page is rendered for OCR
 *   *LICENSE* files                   licenses of the above (Apache-2.0 / BSD)
 *
 * The client picks the SIMD or plain core at runtime (see client/src/components/dispatch/ocr.js). The script is
 * idempotent: it only rewrites files whose content changed and prints every file with its size.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULES = path.join(ROOT, 'client', 'node_modules');
const OUT = path.join(ROOT, 'client', 'public', 'ocr');

// tessdata_fast 4.1.0 is the current official release of the fast (integer) LSTM models.
const MODEL = {
  url: 'https://github.com/tesseract-ocr/tessdata_fast/raw/4.1.0/eng.traineddata',
  sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2',
  bytes: 4113088,
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const version = (pkg) => JSON.parse(fs.readFileSync(path.join(MODULES, pkg, 'package.json'), 'utf8')).version;
/** Source map comments point at files we do not ship. */
const stripSourceMap = (text) => text.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

function write(rel, data) {
  const target = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let same = false;
  try { same = fs.readFileSync(target).equals(data); } catch { /* new file */ }
  if (!same) fs.writeFileSync(target, data);
  return { rel, bytes: data.length, changed: !same };
}

function copy(fromRel, toRel, transform) {
  const src = path.join(MODULES, fromRel);
  if (!fs.existsSync(src)) throw new Error(`Missing ${src}. Run npm install in client/ first.`);
  let data = fs.readFileSync(src);
  if (transform) data = Buffer.from(transform(data.toString('utf8')), 'utf8');
  return write(toRel, data);
}

function checkModel(buf) {
  if (buf.length !== MODEL.bytes || sha256(buf) !== MODEL.sha256) {
    throw new Error(`eng.traineddata does not match tessdata_fast 4.1.0 (got ${buf.length} bytes, sha256 ${sha256(buf)}).`);
  }
  return buf;
}

/** The English model as { data, vendored }: vendored is true when client/public/ocr already holds this exact model. */
async function model() {
  const local = argValue('--data');
  if (local) return { data: checkModel(fs.readFileSync(path.resolve(local))), vendored: false };
  try {
    return { data: checkModel(zlib.gunzipSync(fs.readFileSync(path.join(OUT, 'eng.traineddata.gz')))), vendored: true };
  } catch { /* missing or different: download */ }
  console.log(`Downloading ${MODEL.url}`);
  const res = await fetch(MODEL.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  return { data: checkModel(Buffer.from(await res.arrayBuffer())), vendored: false };
}

async function main() {
  const results = [
    copy('tesseract.js/dist/worker.min.js', 'worker.min.js', stripSourceMap),
    copy('tesseract.js/dist/worker.min.js.LICENSE.txt', 'worker.min.js.LICENSE.txt'),
    copy('tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'),
    copy('tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'),
    copy('tesseract.js-core/LICENSE', 'LICENSE-tesseract.txt'),
    copy('pdfjs-dist/wasm/jbig2.wasm', 'pdfjs/jbig2.wasm'),
    copy('pdfjs-dist/wasm/openjpeg.wasm', 'pdfjs/openjpeg.wasm'),
    copy('pdfjs-dist/wasm/LICENSE_JBIG2', 'pdfjs/LICENSE_JBIG2.txt'),
    copy('pdfjs-dist/wasm/LICENSE_PDFJS_JBIG2', 'pdfjs/LICENSE_PDFJS_JBIG2.txt'),
    copy('pdfjs-dist/wasm/LICENSE_OPENJPEG', 'pdfjs/LICENSE_OPENJPEG.txt'),
    copy('pdfjs-dist/wasm/LICENSE_PDFJS_OPENJPEG', 'pdfjs/LICENSE_PDFJS_OPENJPEG.txt'),
  ];
  // gzip output differs slightly between zlib builds, so an already vendored model is kept as it is.
  const { data, vendored } = await model();
  results.push(vendored
    ? { rel: 'eng.traineddata.gz', bytes: fs.statSync(path.join(OUT, 'eng.traineddata.gz')).size, changed: false }
    : write('eng.traineddata.gz', zlib.gzipSync(data, { level: 9 })));

  console.log(`tesseract.js ${version('tesseract.js')}, tesseract.js-core ${version('tesseract.js-core')}, pdfjs-dist ${version('pdfjs-dist')}, eng.traineddata tessdata_fast 4.1.0`);
  let total = 0;
  for (const r of results) {
    total += r.bytes;
    console.log(`${r.changed ? 'wrote ' : 'same  '} ${r.rel.padEnd(36)} ${mb(r.bytes).padStart(9)}`);
  }
  console.log(`total  ${'client/public/ocr'.padEnd(36)} ${mb(total).padStart(9)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
