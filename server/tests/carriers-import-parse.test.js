import { describe, it, expect } from 'vitest';
import { parseCsvText } from '../src/services/carriers/importer.js';
import { newId } from '../src/services/carriers/ids.js';

const STEP = 256 * 1024;

describe('chunked CSV parsing', () => {
  it('parses a multi-chunk file and keeps characters split across chunk boundaries', async () => {
    const head = 'name,notes\n';
    const before = `${head}first,`;
    // Put a two-unit emoji exactly across the first 256 KB boundary.
    const filler = 'a'.repeat(STEP - 1 - before.length);
    const rows = Array.from({ length: 3000 }, (_, i) => `row ${i},note ${i}`);
    const text = `${before}${filler}😀\n${rows.join('\n')}\n`;
    expect(text.length).toBeGreaterThan(STEP);
    const records = await parseCsvText(text, { max: 5000 });
    expect(records).toHaveLength(3001);
    expect(records[0].notes.endsWith('a😀')).toBe(true);
    expect(records[3000]).toEqual({ name: 'row 2999', notes: 'note 2999' });
  });

  it('stops keeping rows past the limit (one extra, so the caller can tell)', async () => {
    const text = `name\n${Array.from({ length: 30 }, (_, i) => `c${i}`).join('\n')}`;
    expect(await parseCsvText(text, { max: 10 })).toHaveLength(11);
  });

  it('reports malformed CSV', async () => {
    await expect(parseCsvText('name,notes\n"unterminated,quote\n', { max: 10 })).rejects.toThrow();
  });

  it('generates collision-resistant cuid-shaped ids', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId()));
    expect(ids.size).toBe(5000);
    for (const id of [...ids].slice(0, 50)) expect(id).toMatch(/^c[0-9a-z]{24}$/);
  });
});
