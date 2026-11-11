/**
 * Text recognition (OCR) for rate cons that have no text layer: scanned or faxed PDFs and photos (JPG, PNG, WebP).
 * Everything runs in the browser with tesseract.js; the file is never uploaded. tesseract.js itself is loaded with a
 * dynamic import (its own lazy chunk), and its worker, engine and English model are served by our app from /ocr/
 * (client/public/ocr, filled by tools/ocr/vendor.mjs), never from a CDN. The first scan downloads about 3.5 MB
 * (compressed); the model is then kept in the browser's IndexedDB and the engine in the HTTP cache.
 * One worker is created per file and terminated as soon as the text is read, the user cancels, or reading fails.
 */
import { pdfPageImages } from './pdfText.js';

export const OCR_MAX_PAGES = 6;
export const OCR_SCALE = 2;
export const OCR_MAX_SIDE = 4000;
export const OCR_BASE = '/ocr/';
// Bump with the model (tools/ocr/vendor.mjs) so browsers do not keep using an older cached model.
const MODEL_CACHE = 'dd-ocr/tessdata_fast-4.1.0';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// Fewer letters and digits than this (after scanner watermarks are dropped) means "no usable text layer".
const MIN_TEXT_CHARS = 80;
const WATERMARK = /^(scanned (with|by)\b.*|.*\bcamscanner\b.*|.*\badobe scan\b.*|page \d+( of \d+)?)$/i;
// No progress message for this long means the worker hung (tesseract.js never settles when its engine fails to start).
// Generous enough for the first ~3.5 MB download on a slow phone connection.
const STALL_MS = 90000;
// Full automatic page layout (tesseract.js defaults to one uniform block, which drops large headings such as
// "RATE CONFIRMATION"), keeping the spaces between words so side-by-side columns stay apart.
const OCR_PARAMS = { tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' };

const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp']);
/** For the file input: PDFs, photos and plain text. */
export const ACCEPT = 'application/pdf,.pdf,image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp,text/plain,.txt';

/** 'pdf' | 'image' | 'text' | null (not supported). */
export function fileKind(file) {
  if (!file) return null;
  const name = String(file.name || '');
  const type = String(file.type || '').toLowerCase();
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (IMAGE_TYPES.has(type) || (!type && /\.(jpe?g|png|webp)$/i.test(name))) return 'image';
  if (type.startsWith('text/') || /\.(txt|eml)$/i.test(name)) return 'text';
  return null;
}

/** True when text extracted from a PDF's text layer is enough to parse (not empty, not only a scanner watermark). */
export function hasTextLayer(text) {
  const kept = String(text || '').split('\n').filter((line) => !WATERMARK.test(line.trim())).join(' ');
  return (kept.match(/[a-z0-9]/gi) || []).length >= MIN_TEXT_CHARS;
}

/** Whether a file of this kind needs OCR: always for photos, and for PDFs whose text layer is missing or unusable. */
export function needsOcr(kind, pdfText = '') {
  return kind === 'image' || (kind === 'pdf' && !hasTextLayer(pdfText));
}

/**
 * OCR text in the shape the parser gets from pdf.js: a wide gap between words (side-by-side "Shipper / Consignee"
 * columns) becomes a tab, other runs of spaces one space, and blank lines collapse.
 */
export function tidyOcrText(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/ {3,}/g, '\t').replace(/ {2}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// An empty module: compiling it fails only when WebAssembly is missing or blocked (e.g. by a Content-Security-Policy).
const EMPTY_WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
async function wasmAllowed() {
  try {
    await WebAssembly.compile(EMPTY_WASM);
    return true;
  } catch {
    return false;
  }
}

// wasm-feature-detect's SIMD probe: a tiny module that uses a v128 instruction (validated, never run).
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
export function wasmSimd() {
  try {
    return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

/** tesseract.js worker options pointing at our self-hosted files (the core build is chosen like tesseract.js does). */
export function workerOptions({ simd = wasmSimd(), base = OCR_BASE, logger } = {}) {
  return {
    workerPath: `${base}worker.min.js`,
    corePath: `${base}${simd ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'}`,
    langPath: base.replace(/\/$/, ''), // tesseract.js appends /eng.traineddata.gz
    gzip: true,
    cachePath: MODEL_CACHE,
    // A worker started from our own URL (not a blob: wrapper), so it gets this site's CSP and same-origin fetches.
    workerBlobURL: false,
    logger,
    // Failures reject the pending promise; without a handler tesseract.js also throws them inside onmessage.
    errorHandler: () => {},
  };
}

export class OcrCancelled extends Error {
  constructor() {
    super('Text recognition was cancelled.');
    this.name = 'AbortError';
  }
}
export const isCancelled = (err) => err instanceof OcrCancelled || err?.name === 'AbortError';

const LOAD_STEPS = ['loading tesseract core', 'initializing tesseract', 'loading language traineddata', 'initializing api'];
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

/**
 * Start a tesseract.js worker and keep a handle on the Web Worker it spawns. createWorker() only resolves once the
 * engine and model are loaded, but it constructs the Worker synchronously, so a Cancel during that first download
 * can still terminate it right away.
 */
function startWorker(createWorker, options) {
  const Native = globalThis.Worker;
  let spawned = null;
  let promise;
  if (typeof Native === 'function') {
    globalThis.Worker = class extends Native {
      constructor(...args) {
        super(...args);
        spawned = this;
      }
    };
  }
  try {
    promise = createWorker('eng', 1, options); // 1 = OEM.LSTM_ONLY, the only model we ship
  } finally {
    if (typeof Native === 'function') globalThis.Worker = Native;
  }
  return { promise, kill: () => spawned?.terminate() };
}

// tesseract.js is CommonJS: depending on the bundler its API arrives as named exports or on `default`.
const defaultLoader = async () => {
  const mod = await import('tesseract.js');
  return { createWorker: mod.createWorker ?? mod.default?.createWorker };
};

/**
 * Read text from `count` page images with one tesseract.js worker.
 * getImage(n) returns the image for page n (Blob, File or canvas). onProgress receives
 * { phase: 'loading' | 'reading', page, count, percent } (percent of the current phase, 0-100).
 * Resolves with the text of all pages (see tidyOcrText); rejects with OcrCancelled when `signal` aborts, and with a
 * readable Error when the engine cannot start, fails, or reports no progress for stallMs. The worker is always
 * terminated before this returns.
 */
export async function recognizePages({ count, getImage, onProgress, signal, loadTesseract = defaultLoader, simd, stallMs = STALL_MS }) {
  let page = 0;
  let done = false;
  let worker = null;
  let kill = () => {};
  let rejectStop;
  let stallTimer = null;
  const stopped = new Promise((_, reject) => { rejectStop = reject; });
  stopped.catch(() => {});
  const stop = (err) => {
    kill();
    worker?.terminate();
    rejectStop(err);
  };
  const onAbort = () => stop(new OcrCancelled());
  // Every sign of life restarts the stall timer.
  const alive = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => stop(new Error(`No OCR progress for ${stallMs} ms`)), stallMs);
  };
  if (signal?.aborted) throw new OcrCancelled();
  signal?.addEventListener('abort', onAbort, { once: true });
  const race = (promise) => Promise.race([promise, stopped]);
  const report = (phase, fraction) => {
    if (done) return;
    alive();
    const overall = phase === 'reading' ? ((page - 1) + clamp01(fraction)) / count : clamp01(fraction);
    onProgress?.({ phase, page, count, percent: Math.round(overall * 100) });
  };
  const logger = (m) => {
    if (m?.status === 'recognizing text') report('reading', m.progress);
    else if (page === 0) {
      const step = LOAD_STEPS.indexOf(m?.status);
      if (step > -1) report('loading', (step + clamp01(m.progress)) / LOAD_STEPS.length);
    }
  };

  try {
    report('loading', 0);
    if (!(await race(wasmAllowed()))) throw new Error('WebAssembly is not available or is blocked on this page');
    const { createWorker } = await race(loadTesseract());
    const started = startWorker(createWorker, workerOptions({ simd: simd ?? wasmSimd(), logger }));
    kill = started.kill;
    // If the user cancels while the engine loads, terminate it once createWorker settles too.
    started.promise.then((w) => { if (done) w.terminate(); }, () => {});
    worker = await race(started.promise);
    await race(worker.setParameters(OCR_PARAMS));
    const texts = [];
    for (let n = 1; n <= count; n++) {
      page = n;
      report('reading', 0);
      const image = await race(getImage(n));
      alive();
      const { data } = await race(worker.recognize(image));
      texts.push(tidyOcrText(data?.text));
    }
    return texts.filter(Boolean).join('\n\n');
  } catch (err) {
    if (isCancelled(err) || signal?.aborted) throw new OcrCancelled();
    // tesseract.js rejects with bare strings ("Network error while fetching ...") that mean nothing to a dispatcher.
    throw new Error('The text in this file could not be read. Paste the text or type the details.', { cause: err });
  } finally {
    done = true;
    clearTimeout(stallTimer);
    signal?.removeEventListener('abort', onAbort);
    kill();
    worker?.terminate();
  }
}

const canvasToBlob = (canvas) => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('This page could not be drawn.'))), 'image/png');
});

/** A drawn page as a PNG, freeing the canvas memory right away (pages can be 16 MP). */
async function pageBlob(canvas) {
  try {
    return await canvasToBlob(canvas);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * A photo ready for OCR: decoded with its EXIF rotation applied, at most OCR_MAX_SIDE px on the longer side, and
 * small photos (screenshots, cropped snaps) enlarged 2x, which helps tesseract with small print. Browsers that cannot
 * decode it here get the original file, which tesseract decodes itself.
 */
export async function imageForOcr(file) {
  if (typeof createImageBitmap !== 'function') return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height, 1);
    const scale = Math.min(longest < 1500 ? 2 : 1, OCR_MAX_SIDE / longest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return file;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await pageBlob(canvas);
  } finally {
    bitmap.close?.();
  }
}

/**
 * OCR a scanned PDF (first OCR_MAX_PAGES pages) or a photo. Resolves { text, pages, truncated } like pdfToText;
 * rejects with OcrCancelled on cancel, or with a readable Error.
 */
export async function ocrFile(file, kind, { onProgress, signal, loadTesseract, simd, stallMs } = {}) {
  const options = { onProgress, signal, loadTesseract, simd, stallMs };
  if (kind === 'image') {
    if (file.size > MAX_IMAGE_BYTES) throw new Error('This photo is larger than 20 MB. Paste the text instead.');
    const text = await recognizePages({ count: 1, getImage: () => imageForOcr(file), ...options });
    return { text, pages: 1, truncated: false };
  }
  const pdf = await pdfPageImages(file, { maxPages: OCR_MAX_PAGES, scale: OCR_SCALE, maxSide: OCR_MAX_SIDE, wasmUrl: `${OCR_BASE}pdfjs/` });
  try {
    const text = await recognizePages({ count: pdf.count, getImage: async (n) => pageBlob(await pdf.render(n)), ...options });
    return { text, pages: pdf.total, truncated: pdf.total > pdf.count };
  } finally {
    pdf.close();
  }
}
