import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const pdf = vi.hoisted(() => ({ pdfPageImages: vi.fn() }));
vi.mock('./pdfText.js', () => pdf);
const { fileKind, hasTextLayer, needsOcr, workerOptions, recognizePages, imageForOcr, ocrFile, tidyOcrText, OcrCancelled, isCancelled } = await import('./ocr.js');

const file = (name, type, body = 'x') => new File([body], name, { type });
const RATE_CON = 'RATE CONFIRMATION\nLoad # 48213\nShipper: Big Box DC, Dallas, TX\nConsignee: Corner Market, Atlanta, GA\nRate: $2,350.00 flat\nBroker: Summit Logistics MC# 123456';

/**
 * A stand-in for tesseract.js: createWorker resolves (or waits for `gate`) with a worker whose recognize() reports
 * progress through the logger and answers with texts[n] (or waits for `hold` when set).
 */
function fakeTesseract({ texts = ['page one'], gate = null, hold = null, fail = null } = {}) {
  const t = { calls: [], workers: [], options: null };
  t.createWorker = vi.fn((lang, oem, options) => {
    t.options = options;
    t.calls.push([lang, oem]);
    new globalThis.Worker(options.workerPath); // tesseract.js spawns its Web Worker synchronously
    options.logger({ status: 'loading tesseract core', progress: 1 });
    options.logger({ status: 'loading language traineddata', progress: 0.5 });
    let n = 0;
    const worker = {
      terminate: vi.fn(async () => {}),
      setParameters: vi.fn(async (p) => p),
      recognize: vi.fn(async () => {
        options.logger({ status: 'recognizing text', progress: 0.5 });
        if (fail) throw fail;
        if (hold) await hold;
        const text = texts[n] ?? '';
        n += 1;
        return { data: { text } };
      }),
    };
    t.workers.push(worker);
    return (gate || Promise.resolve()).then(() => worker);
  });
  t.load = vi.fn(async () => ({ createWorker: t.createWorker }));
  return t;
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

let spawned;
beforeEach(() => {
  spawned = [];
  vi.stubGlobal('Worker', class {
    constructor(url) { this.url = url; this.terminate = vi.fn(); spawned.push(this); }
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('which files need OCR', () => {
  it('tells PDFs, photos and text apart', () => {
    expect(fileKind(file('rc.pdf', 'application/pdf'))).toBe('pdf');
    expect(fileKind(file('RC.PDF', ''))).toBe('pdf');
    expect(fileKind(file('IMG_2041.JPG', 'image/jpeg'))).toBe('image');
    expect(fileKind(file('scan.png', 'image/png'))).toBe('image');
    expect(fileKind(file('scan.webp', 'image/webp'))).toBe('image');
    expect(fileKind(file('photo.jpeg', ''))).toBe('image');
    expect(fileKind(file('email.txt', 'text/plain'))).toBe('text');
    expect(fileKind(file('IMG_2041.HEIC', 'image/heic'))).toBe(null);
    expect(fileKind(file('rc.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))).toBe(null);
    expect(fileKind(null)).toBe(null);
  });

  it('uses the text layer when a PDF has one and OCR when it is missing or only a scanner watermark', () => {
    expect(hasTextLayer(RATE_CON)).toBe(true);
    expect(needsOcr('pdf', RATE_CON)).toBe(false);
    expect(needsOcr('pdf', '')).toBe(true);
    expect(needsOcr('pdf', '   \n\n ')).toBe(true);
    expect(needsOcr('pdf', 'Scanned with CamScanner\n\nPage 1 of 2\nScanned with CamScanner\nPage 2 of 2')).toBe(true);
    expect(needsOcr('pdf', 'Rate $1,900')).toBe(true); // a stray stamp is not a rate con
    expect(needsOcr('image')).toBe(true);
    expect(needsOcr('image', RATE_CON)).toBe(true);
    expect(needsOcr('text', '')).toBe(false);
  });
});

describe('self-hosted tesseract files', () => {
  it('points the worker, engine and model at /ocr/ and never at a CDN', () => {
    const simd = workerOptions({ simd: true });
    expect(simd).toMatchObject({
      workerPath: '/ocr/worker.min.js', corePath: '/ocr/tesseract-core-simd-lstm.wasm.js', langPath: '/ocr', gzip: true, workerBlobURL: false,
    });
    expect(workerOptions({ simd: false }).corePath).toBe('/ocr/tesseract-core-lstm.wasm.js');
    expect(JSON.stringify(simd)).not.toMatch(/https?:|jsdelivr|unpkg/);
    expect(typeof simd.errorHandler).toBe('function');
  });
});

describe('OCR text for the parser', () => {
  it('turns wide gaps into tabs like the PDF text path, and tidies spaces and blank lines', () => {
    const raw = 'SHIPPER                         CONSIGNEE\n\n\n\nBig Box DC                  Corner Market\nWeight: 42,000 lbs  Miles: 781   \n\n';
    expect(tidyOcrText(raw)).toBe('SHIPPER\tCONSIGNEE\n\nBig Box DC\tCorner Market\nWeight: 42,000 lbs Miles: 781');
    expect(tidyOcrText(undefined)).toBe('');
  });
});

describe('recognizePages', () => {
  it('reads every page with one worker, reports progress per page and terminates the worker', async () => {
    const t = fakeTesseract({ texts: ['RATE CONFIRMATION\n', 'Total $2,350.00\n'] });
    const progress = [];
    const getImage = vi.fn(async (n) => new Blob([`page ${n}`]));
    const text = await recognizePages({ count: 2, getImage, onProgress: (p) => progress.push(p), loadTesseract: t.load, simd: true });

    expect(text).toBe('RATE CONFIRMATION\n\nTotal $2,350.00');
    expect(t.calls).toEqual([['eng', 1]]);
    expect(t.options.corePath).toBe('/ocr/tesseract-core-simd-lstm.wasm.js');
    // Automatic page layout (the tesseract.js default, one uniform block, drops big headings) with spacing kept.
    expect(t.workers[0].setParameters).toHaveBeenCalledWith({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
    expect(getImage.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    expect(t.workers[0].terminate).toHaveBeenCalled();
    expect(spawned[0].terminate).toHaveBeenCalled();
    expect(progress[0]).toEqual({ phase: 'loading', page: 0, count: 2, percent: 0 });
    expect(progress).toContainEqual({ phase: 'loading', page: 0, count: 2, percent: 25 });
    expect(progress).toContainEqual({ phase: 'reading', page: 1, count: 2, percent: 0 });
    expect(progress).toContainEqual({ phase: 'reading', page: 1, count: 2, percent: 25 });
    expect(progress).toContainEqual({ phase: 'reading', page: 2, count: 2, percent: 75 });
  });

  it('stops at once when cancelled while a page is being read', async () => {
    const hold = deferred();
    const t = fakeTesseract({ hold: hold.promise });
    const ctrl = new AbortController();
    const progress = [];
    const run = recognizePages({ count: 3, getImage: async () => new Blob(['p']), onProgress: (p) => progress.push(p), signal: ctrl.signal, loadTesseract: t.load });
    await vi.waitFor(() => expect(t.workers[0]?.recognize).toHaveBeenCalled());
    ctrl.abort();
    await expect(run).rejects.toBeInstanceOf(OcrCancelled);
    expect(spawned[0].terminate).toHaveBeenCalled();
    expect(t.workers[0].terminate).toHaveBeenCalled();
    const seen = progress.length;
    hold.resolve();
    await Promise.resolve();
    expect(progress.length).toBe(seen);
    expect(t.workers[0].recognize).toHaveBeenCalledTimes(1);
  });

  it('terminates the worker when cancelled while the engine is still downloading', async () => {
    const gate = deferred();
    const t = fakeTesseract({ gate: gate.promise });
    const ctrl = new AbortController();
    const run = recognizePages({ count: 1, getImage: async () => new Blob(['p']), signal: ctrl.signal, loadTesseract: t.load });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    ctrl.abort();
    await expect(run).rejects.toSatisfy(isCancelled);
    expect(spawned[0].terminate).toHaveBeenCalled(); // the real Web Worker, before createWorker resolves
    gate.resolve();
    await vi.waitFor(() => expect(t.workers[0].terminate).toHaveBeenCalled());
    expect(t.workers[0].recognize).not.toHaveBeenCalled();
  });

  it('does not start when already cancelled', async () => {
    const t = fakeTesseract();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(recognizePages({ count: 1, getImage: async () => new Blob(['p']), signal: ctrl.signal, loadTesseract: t.load })).rejects.toBeInstanceOf(OcrCancelled);
    expect(t.load).not.toHaveBeenCalled();
  });

  it('turns tesseract failures into a readable error and still terminates the worker', async () => {
    const t = fakeTesseract({ fail: 'Network error while fetching /ocr/eng.traineddata.gz. Response code: 404' });
    const run = recognizePages({ count: 1, getImage: async () => new Blob(['p']), loadTesseract: t.load });
    await expect(run).rejects.toThrow('The text in this file could not be read. Paste the text or type the details.');
    expect(t.workers[0].terminate).toHaveBeenCalled();
  });

  it('gives up with a readable error when the worker stops reporting progress (tesseract.js can hang forever)', async () => {
    const t = fakeTesseract({ gate: new Promise(() => {}) }); // the engine never finishes loading
    const run = recognizePages({ count: 1, getImage: async () => new Blob(['p']), loadTesseract: t.load, stallMs: 40 });
    await expect(run).rejects.toThrow('The text in this file could not be read.');
    expect(spawned[0].terminate).toHaveBeenCalled();
  });

  it('fails fast, before loading anything, when the page does not allow WebAssembly', async () => {
    vi.spyOn(WebAssembly, 'compile').mockRejectedValue(new WebAssembly.CompileError("Refused to compile: 'wasm-unsafe-eval' is not allowed"));
    const t = fakeTesseract();
    const run = recognizePages({ count: 1, getImage: async () => new Blob(['p']), loadTesseract: t.load });
    await expect(run).rejects.toThrow('The text in this file could not be read.');
    expect(t.load).not.toHaveBeenCalled();
  });

  it('reports a worker that cannot start (blocked or missing files) as a readable error', async () => {
    const load = async () => ({ createWorker: () => Promise.reject('Failed to load TesseractCore') });
    await expect(recognizePages({ count: 1, getImage: async () => new Blob(['p']), loadTesseract: load })).rejects.toThrow(/could not be read/);
  });
});

describe('photos', () => {
  const stubCanvas = () => {
    const ctx = { fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: '' };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    const sizes = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function toBlob(cb, type) {
      sizes.push([this.width, this.height, type]);
      cb(new Blob(['png'], { type }));
    });
    return { ctx, sizes };
  };

  it('applies the EXIF rotation, caps the longer side at 4000 px and enlarges small photos', async () => {
    const { ctx, sizes } = stubCanvas();
    const close = vi.fn();
    const bitmaps = [{ width: 6000, height: 4500, close }, { width: 900, height: 1200, close }];
    const createImageBitmap = vi.fn(async () => bitmaps.shift());
    vi.stubGlobal('createImageBitmap', createImageBitmap);

    const big = await imageForOcr(file('IMG_1.jpg', 'image/jpeg'));
    expect(big).toBeInstanceOf(Blob);
    expect(createImageBitmap.mock.calls[0][1]).toEqual({ imageOrientation: 'from-image' });
    await imageForOcr(file('IMG_2.jpg', 'image/jpeg'));
    expect(sizes).toEqual([[4000, 3000, 'image/png'], [1800, 2400, 'image/png']]);
    expect(ctx.drawImage).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('hands tesseract the original file when the browser cannot decode it', async () => {
    const photo = file('IMG_3.webp', 'image/webp');
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('unsupported'); }));
    expect(await imageForOcr(photo)).toBe(photo);
  });
});

describe('ocrFile', () => {
  it('renders at most 6 pages of a scanned PDF at 2x and frees the document', async () => {
    const close = vi.fn();
    const render = vi.fn(async () => ({ width: 1224, height: 1584, toBlob: (cb) => cb(new Blob(['png'], { type: 'image/png' })) }));
    pdf.pdfPageImages.mockResolvedValue({ total: 9, count: 6, render, close });
    const t = fakeTesseract({ texts: ['a', 'b', 'c', 'd', 'e', 'f'] });
    const res = await ocrFile(file('scan.pdf', 'application/pdf'), 'pdf', { loadTesseract: t.load });
    expect(pdf.pdfPageImages).toHaveBeenCalledWith(expect.any(File), { maxPages: 6, scale: 2, maxSide: 4000, wasmUrl: '/ocr/pdfjs/' });
    expect(render).toHaveBeenCalledTimes(6);
    expect(res).toEqual({ text: 'a\n\nb\n\nc\n\nd\n\ne\n\nf', pages: 9, truncated: true });
    expect(t.workers[0].recognize.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(close).toHaveBeenCalled();
  });

  it('frees the PDF when reading is cancelled', async () => {
    const close = vi.fn();
    pdf.pdfPageImages.mockResolvedValue({ total: 1, count: 1, render: async () => ({ toBlob: (cb) => cb(new Blob(['p'])) }), close });
    const ctrl = new AbortController();
    const t = fakeTesseract({ hold: new Promise(() => {}) });
    const run = ocrFile(file('scan.pdf', 'application/pdf'), 'pdf', { loadTesseract: t.load, signal: ctrl.signal });
    await vi.waitFor(() => expect(t.workers[0]?.recognize).toHaveBeenCalled());
    ctrl.abort();
    await expect(run).rejects.toBeInstanceOf(OcrCancelled);
    expect(close).toHaveBeenCalled();
  });

  it('refuses photos over 20 MB before loading anything', async () => {
    const t = fakeTesseract();
    const huge = file('IMG_4.jpg', 'image/jpeg');
    Object.defineProperty(huge, 'size', { value: 21 * 1024 * 1024 });
    await expect(ocrFile(huge, 'image', { loadTesseract: t.load })).rejects.toThrow('larger than 20 MB');
    expect(t.load).not.toHaveBeenCalled();
  });
});
