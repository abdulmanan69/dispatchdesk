/**
 * Minimal PDF writer for scanned pages: each page is one JPEG drawn full page (DCTDecode, so the JPEG bytes are embedded
 * as they are; no re-encoding). Pages are 612 pt wide (US Letter width) with the height following the photo, so long
 * receipts are not squeezed. About 60 lines instead of a PDF library on the driver's phone.
 */
const enc = new TextEncoder();

/** pages: [{ bytes: Uint8Array (JPEG), width, height }] -> Uint8Array of a PDF file. */
export function jpegsToPdf(pages) {
  if (!pages?.length) throw new Error('No pages');
  const chunks = [];
  let length = 0;
  const offsets = [];
  const push = (part) => {
    const bytes = typeof part === 'string' ? enc.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n${body}\nendobj\n`); };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const pageIds = pages.map((_, i) => 3 + i * 3);
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  pages.forEach((p, i) => {
    const pageId = 3 + i * 3;
    const imgId = pageId + 1;
    const contentId = pageId + 2;
    const w = 612;
    const h = Math.max(1, Math.round((612 * p.height) / p.width));
    obj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im${i} ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    offsets[imgId] = length;
    push(`${imgId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`);
    push(p.bytes);
    push('\nendstream\nendobj\n');
    const draw = `q ${w} 0 0 ${h} 0 0 cm /Im${i} Do Q`;
    obj(contentId, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
  });
  const count = 3 + pages.length * 3;
  const xref = length;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(`${table}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
