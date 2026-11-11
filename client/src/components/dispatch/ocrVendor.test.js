import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// client/public/ocr is filled by tools/ocr/vendor.mjs. If a package upgrade makes this fail, run
// `node tools/ocr/vendor.mjs` from the repository root: the worker and engine must match the tesseract.js that Vite
// bundles, and pdf.js's decoders must match pdfjs-dist.
// (Not `new URL(..., import.meta.url)`: Vite rewrites that pattern into an asset URL.)
const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ocr = (p) => path.join(CLIENT, 'public', 'ocr', p);
const pkg = (p) => path.join(CLIENT, 'node_modules', p);
const read = (p) => fs.readFileSync(p);
// A Windows checkout may turn LF into CRLF in the vendored scripts; that changes nothing for the browser.
const text = (p) => read(p).toString('utf8').replace(/\r\n/g, '\n');

describe('self-hosted OCR files', () => {
  it('match the installed tesseract.js, tesseract.js-core and pdfjs-dist', () => {
    const worker = text(pkg('tesseract.js/dist/worker.min.js')).replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n');
    expect(text(ocr('worker.min.js')) === worker, 'worker.min.js').toBe(true);
    for (const core of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']) {
      expect(text(ocr(core)) === text(pkg(`tesseract.js-core/${core}`)), core).toBe(true);
    }
    for (const wasm of ['jbig2.wasm', 'openjpeg.wasm']) {
      expect(read(ocr(`pdfjs/${wasm}`)).equals(read(pkg(`pdfjs-dist/wasm/${wasm}`))), wasm).toBe(true);
    }
  });

  it('ship the official tessdata_fast 4.1.0 English model, gzipped', () => {
    const model = zlib.gunzipSync(read(ocr('eng.traineddata.gz')));
    expect(model.length).toBe(4113088);
    expect(crypto.createHash('sha256').update(model).digest('hex')).toBe('7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2');
  });
});
