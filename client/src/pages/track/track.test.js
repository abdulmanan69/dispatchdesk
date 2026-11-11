import { describe, it, expect, beforeEach } from 'vitest';
import { fitSize } from './capture.js';
import { jpegsToPdf } from './pdf.js';
import { enqueue, list, remove, update, _reset } from './uploadQueue.js';

describe('driver photo helpers', () => {
  it('scales photos to 1600 px on the long side and never enlarges', () => {
    expect(fitSize(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(fitSize(3024, 4032)).toEqual({ width: 1200, height: 1600 });
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('writes a valid multi-page PDF around the JPEG bytes', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const pdf = jpegsToPdf([{ bytes: jpeg, width: 1200, height: 1600 }, { bytes: jpeg, width: 1600, height: 1200 }]);
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 2');
    expect(text).toContain('/Filter /DCTDecode');
    expect(text).toContain('/MediaBox [0 0 612 816]');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    // Every xref offset points at the start of its object.
    const start = Number(text.match(/startxref\n(\d+)/)[1]);
    const rows = text.slice(start).split('\n').slice(3).filter((l) => / 00000 n $/.test(l));
    rows.forEach((row, i) => {
      const at = Number(row.slice(0, 10));
      expect(text.slice(at, at + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`));
    });
    expect(() => jpegsToPdf([])).toThrow();
  });
});

describe('upload queue', () => {
  beforeEach(() => _reset());
  it('keeps waiting photos per link (memory fallback without IndexedDB)', async () => {
    const a = await enqueue({ token: 't1', type: 'pod', name: 'pod.jpg', blob: new Blob(['x']) });
    await enqueue({ token: 't2', type: 'bol', name: 'bol.jpg', blob: new Blob(['y']) });
    expect((await list('t1')).map((x) => x.id)).toEqual([a.id]);
    await update({ ...a, attempts: 2, error: 'No signal' });
    expect((await list('t1'))[0]).toMatchObject({ attempts: 2, error: 'No signal' });
    await remove(a.id);
    expect(await list('t1')).toEqual([]);
  });
});
