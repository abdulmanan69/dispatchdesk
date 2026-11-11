import { describe, it, expect, vi, afterEach } from 'vitest';

const lib = vi.hoisted(() => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }));
vi.mock('pdfjs-dist', () => lib);
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.js' }));
const { pdfPageImages, pdfToText, renderScale } = await import('./pdfText.js');

const pdfFile = () => new File(['%PDF-1.7'], 'scan.pdf', { type: 'application/pdf' });

function fakeDoc(pages) {
  const doc = {
    numPages: pages.length,
    destroy: vi.fn(),
    getPage: vi.fn(async (n) => {
      const [w, h] = pages[n - 1];
      return {
        getViewport: ({ scale }) => ({ width: w * scale, height: h * scale, scale }),
        getTextContent: async () => ({ items: [] }),
        render: vi.fn(() => ({ promise: Promise.resolve() })),
        cleanup: vi.fn(),
      };
    }),
  };
  lib.getDocument.mockReturnValue({ promise: Promise.resolve(doc) });
  return doc;
}

afterEach(() => vi.restoreAllMocks());

describe('rendering PDF pages for OCR', () => {
  it('uses 2x for normal pages and shrinks large ones to 4000 px on the longer side', () => {
    expect(renderScale(612, 792, 2, 4000)).toBe(2); // US Letter
    expect(renderScale(2448, 3168, 2, 4000)).toBeCloseTo(4000 / 3168); // a scanner that wrote 300 dpi pixels as points
  });

  it('draws pages on white canvases, decodes scanned images with our own wasm files and stops at the page limit', async () => {
    const ctx = {};
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    const doc = fakeDoc([[612, 792], [2448, 3168], [612, 792], [612, 792]]);
    const pdf = await pdfPageImages(pdfFile(), { maxPages: 3, scale: 2, maxSide: 4000, wasmUrl: '/ocr/pdfjs/' });

    expect(lib.getDocument.mock.calls[0][0]).toMatchObject({ isEvalSupported: false, wasmUrl: `${window.location.origin}/ocr/pdfjs/` });
    expect(pdf).toMatchObject({ total: 4, count: 3 });
    const first = await pdf.render(1);
    expect([first.width, first.height]).toEqual([1224, 1584]);
    const page = await doc.getPage.mock.results[0].value;
    expect(page.render).toHaveBeenCalledWith(expect.objectContaining({ canvasContext: ctx, canvas: first, background: '#ffffff' }));
    expect(page.cleanup).toHaveBeenCalled();
    const second = await pdf.render(2);
    expect(Math.max(second.width, second.height)).toBe(4000);
    pdf.close();
    expect(doc.destroy).toHaveBeenCalled();
  });

  it('keeps reading the text layer without the wasm decoders', async () => {
    fakeDoc([[612, 792]]);
    await pdfToText(pdfFile());
    expect(lib.getDocument.mock.calls.at(-1)[0].wasmUrl).toBeUndefined();
  });
});
