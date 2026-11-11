/**
 * Text from a rate-con PDF, extracted in the browser with pdf.js (loaded only when a PDF is picked).
 * The file never leaves the device for parsing: only the extracted text (20,000 characters at most) is sent to
 * POST /api/loads/parse. Items are rebuilt into lines by their vertical position; a wide horizontal gap becomes a
 * tab so side-by-side "Shipper / Consignee" columns stay apart for the parser.
 */
export const MAX_TEXT = 20000;
const MAX_PAGES = 8;
const MAX_BYTES = 15 * 1024 * 1024;

/** Rebuild lines from pdf.js text items ({ str, transform: [a, b, c, d, x, y], width, height }). */
export function itemsToLines(items) {
  const rows = [];
  for (const it of items) {
    const str = String(it.str ?? '');
    if (!str.trim()) continue;
    const x = it.transform?.[4] ?? 0;
    const y = it.transform?.[5] ?? 0;
    const h = Math.abs(it.height || it.transform?.[3] || 10);
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2, h * 0.4));
    if (!row) {
      row = { y, h, items: [] };
      rows.push(row);
    }
    row.items.push({ x, w: it.width || str.length * h * 0.5, str, h });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((row) => {
    row.items.sort((a, b) => a.x - b.x);
    let out = '';
    let end = null;
    for (const it of row.items) {
      if (end != null) {
        const gap = it.x - end;
        out += gap > it.h * 3 ? '\t' : gap > it.h * 0.15 && !out.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '';
      }
      out += it.str;
      end = it.x + it.w;
    }
    return out.replace(/[  ]+/g, ' ').trimEnd();
  }).filter(Boolean);
}

let loader = null;
async function pdfjs() {
  if (!loader) {
    loader = Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    }).catch((err) => {
      loader = null;
      throw err;
    });
  }
  return loader;
}

/** { text, pages, truncated } from a PDF File/Blob. Throws a readable Error when the file cannot be read. */
export async function pdfToText(file) {
  if (file.size > MAX_BYTES) throw new Error('This PDF is larger than 15 MB. Paste the text instead.');
  const lib = await pdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  let doc;
  try {
    doc = await lib.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  } catch (err) {
    throw new Error(err?.name === 'PasswordException' ? 'This PDF is password protected. Open it and paste the text instead.' : 'This file could not be read as a PDF.');
  }
  const lines = [];
  const total = doc.numPages;
  const pages = Math.min(total, MAX_PAGES);
  try {
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      lines.push(...itemsToLines(content.items), '');
      if (lines.join('\n').length > MAX_TEXT) break;
    }
  } finally {
    doc.destroy?.();
  }
  const full = lines.join('\n').trim();
  return { text: full.slice(0, MAX_TEXT), pages: total, truncated: full.length > MAX_TEXT || total > MAX_PAGES };
}
