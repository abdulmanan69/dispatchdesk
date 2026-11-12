/**
 * Invoice PDFs (pdf-lib, standard Helvetica fonts, US Letter) and storing one as a Document so it can be attached to
 * an email (queueUserEmail documentIds). The layout follows the printable page in print.js: issuer, invoice number and
 * dates, bill-to, load, remit-to, line items, total, payments and balance, notes.
 *
 * Standard PDF fonts only cover the Windows-1252 (WinAnsi) characters, so every string goes through a sanitizer:
 * arrows and math signs become ASCII, accented letters outside the set lose their accent, emoji and other symbols are
 * dropped. Nothing a user types can make the PDF fail.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { randomToken } from '../../lib/crypto.js';
import { filePath, removeFile } from '../../middleware/upload.js';
import { day, usd } from './print.js';
import { PAYMENT_LABEL } from './index.js';

const DOC_SUBDIR = 'documents';
const PAGE_W = 612; // US Letter, in points
const PAGE_H = 792;
const M = 48; // page margin
const CONTENT_W = PAGE_W - 2 * M;
const INK = rgb(0.106, 0.122, 0.141);
const MUTED = rgb(0.294, 0.333, 0.388);
const RULE = rgb(0.82, 0.85, 0.88);
const STATUS_LABEL = { draft: 'Draft', sent: 'Sent', partial: 'Partly paid', paid: 'Paid', void: 'Void' };

// Characters outside WinAnsi with a readable ASCII stand-in.
const REPLACE = {
  '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '−': '-', '‐': '-', '‑': '-', '⁃': '-',
  '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '✓': 'v', '✔': 'v', '✕': 'x', '✖': 'x',
  '′': "'", '″': '"', '∕': '/', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '\t': ' ',
};
const DROP = /[\p{Extended_Pictographic}\p{M}​-‏⁠︀-️﻿]/u;

/** A function that makes any string drawable with `font` (a pdf-lib standard font). */
export function winAnsiSanitizer(font) {
  const ok = new Set(font.getCharacterSet());
  const one = (ch) => {
    const cp = ch.codePointAt(0);
    if (ok.has(cp)) return ch;
    if (REPLACE[ch] !== undefined) return REPLACE[ch];
    if (DROP.test(ch)) return '';
    // Accented letters outside the set: keep the base letter (e.g. "ő" -> "o").
    const base = [...ch.normalize('NFKD')].filter((c) => ok.has(c.codePointAt(0))).join('');
    return base || '?';
  };
  return (value) => {
    let out = '';
    for (const ch of String(value ?? '').replace(/\r\n?/g, '\n')) out += ch === '\n' ? '\n' : one(ch);
    return out;
  };
}

/** Split text into lines no wider than `width` (explicit newlines kept, long words broken). */
function wrap(text, font, size, width) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    const words = para.split(/ +/);
    let line = '';
    for (let word of words) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) out.push(line);
      // A single word wider than the column: break it.
      while (font.widthOfTextAtSize(word, size) > width && word.length > 1) {
        let cut = word.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > width) cut -= 1;
        out.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      line = word;
    }
    out.push(line);
  }
  return out;
}

const qty = (q) => (Number.isInteger(Number(q)) ? String(Number(q)) : Number(q).toFixed(2));

/** pdf-lib drawing with a top-down cursor and page breaks. */
class Sheet {
  constructor(doc, fonts, clean) {
    this.doc = doc;
    this.fonts = fonts;
    this.clean = clean;
    this.pages = [];
    this.addPage();
  }

  addPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - M;
  }

  /** Start a new page unless `height` points still fit above the bottom margin. */
  room(height) {
    if (this.y - height < M + 16) this.addPage();
  }

  font(bold) { return bold ? this.fonts.bold : this.fonts.regular; }

  width(text, { size = 10, bold = false } = {}) { return this.font(bold).widthOfTextAtSize(this.clean(text), size); }

  /** Draw one line with its top at `top`. align: left (x is the left edge) or right (x is the right edge). */
  line(text, x, top, { size = 10, bold = false, color = INK, align = 'left' } = {}) {
    const s = this.clean(text);
    if (!s) return;
    const font = this.font(bold);
    const left = align === 'right' ? x - font.widthOfTextAtSize(s, size) : x;
    this.page.drawText(s, { x: left, y: top - size * 0.8, size, font, color });
  }

  /** Wrapped lines for a column. */
  lines(text, width, { size = 10, bold = false } = {}) { return wrap(this.clean(text), this.font(bold), size, width); }

  rule(top, { from = M, to = M + CONTENT_W, thickness = 0.75, color = RULE } = {}) {
    this.page.drawLine({ start: { x: from, y: top }, end: { x: to, y: top }, thickness, color });
  }
}

async function embedLogo(doc, logo) {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+=*)$/.exec(logo?.src || '');
  if (!m) return null;
  try {
    const bytes = Buffer.from(m[2], 'base64');
    return m[1] === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch {
    return null; // an unreadable logo never stops the invoice
  }
}

/**
 * Invoice PDF bytes (Uint8Array). `inv` is invoiceView(...) output; `from`, `preparedBy`, `tz` and `logo` as for
 * invoiceHtml (logo: { src: data:image/png|jpeg URI } or null).
 */
export async function invoicePdf(inv, { from, preparedBy, tz, logo } = {}) {
  const doc = await PDFDocument.create();
  const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const clean = winAnsiSanitizer(fonts.regular);
  const m = inv.meta || {};
  const title = inv.kind === 'dispatch_fee' ? 'Dispatch fee invoice' : 'Invoice';
  doc.setTitle(clean(`${title} ${inv.number}`));
  doc.setSubject(clean(`${title} #${inv.number} to ${inv.billToName || ''}`));
  doc.setAuthor(clean(from?.name || ''));
  doc.setCreator('DispatchDesk');
  doc.setProducer('DispatchDesk');
  const s = new Sheet(doc, fonts, clean);

  // Header: logo, title and issuer on the left; number, dates and status on the right.
  const image = await embedLogo(doc, logo);
  let left = s.y;
  if (image) {
    const scale = Math.min(160 / image.width, 50 / image.height, 1);
    const w = image.width * scale;
    const h = image.height * scale;
    s.page.drawImage(image, { x: M, y: left - h, width: w, height: h });
    left -= h + 10;
  }
  s.line(title, M, left, { size: 20, bold: true });
  left -= 28;
  for (const l of s.lines(from?.name || '', 300, { size: 11, bold: true })) { s.line(l, M, left, { size: 11, bold: true }); left -= 14; }
  for (const x of (from?.lines || []).filter(Boolean)) {
    for (const l of s.lines(x, 300, { size: 9 })) { s.line(l, M, left, { size: 9, color: MUTED }); left -= 12; }
  }
  const right = M + CONTENT_W;
  let top = s.y;
  s.line(`Invoice #${inv.number}`, right, top, { size: 12, bold: true, align: 'right' });
  top -= 17;
  s.line(`Issued ${day(inv.issuedAt || inv.createdAt, tz)}`, right, top, { size: 10, color: MUTED, align: 'right' });
  top -= 14;
  s.line(`Due ${day(inv.dueAt, tz)}${m.terms ? ` · ${m.terms}` : ''}`, right, top, { size: 10, color: MUTED, align: 'right' });
  top -= 14;
  s.line(STATUS_LABEL[inv.status] || inv.status || '', right, top, { size: 10, bold: true, align: 'right' });
  top -= 14;
  s.y = Math.min(left, top) - 6;
  s.rule(s.y, { thickness: 1.5, color: INK });
  s.y -= 18;

  // Bill to, load and remit-to boxes side by side.
  const boxes = [
    { head: 'Bill to', body: [inv.billToName, inv.billToEmail].filter(Boolean).join('\n'), boldFirst: true },
    { head: 'Load', body: [m.reference && `Reference ${m.reference}`, m.lane, m.pickupDate && `Picked up ${day(m.pickupDate)}`, m.deliveryDate && `Delivered ${day(m.deliveryDate)}`].filter(Boolean).join('\n') },
    { head: 'Remit to', body: m.remitTo || '' },
  ].filter((b) => b.body);
  if (!boxes.length) boxes.push({ head: 'Bill to', body: '-' });
  const gap = 12;
  const boxW = (CONTENT_W - gap * (boxes.length - 1)) / boxes.length;
  const laid = boxes.map((b) => ({ ...b, rows: s.lines(b.body, boxW - 20, { size: 9.5 }) }));
  const boxH = 30 + Math.max(...laid.map((b) => b.rows.length)) * 12.5;
  s.room(boxH);
  laid.forEach((b, i) => {
    const x = M + i * (boxW + gap);
    s.page.drawRectangle({ x, y: s.y - boxH, width: boxW, height: boxH, borderColor: RULE, borderWidth: 0.75 });
    s.line(b.head, x + 10, s.y - 10, { size: 8.5, bold: true, color: MUTED });
    b.rows.forEach((row, j) => s.line(row, x + 10, s.y - 25 - j * 12.5, { size: 9.5, bold: !!b.boldFirst && j === 0 }));
  });
  s.y -= boxH + 22;

  // Line items.
  const cols = { qty: M + CONTENT_W - 170, rate: M + CONTENT_W - 85, amount: M + CONTENT_W };
  const descW = CONTENT_W - 230;
  const head = () => {
    s.line('Description', M, s.y, { size: 9, bold: true, color: MUTED });
    s.line('Qty', cols.qty, s.y, { size: 9, bold: true, color: MUTED, align: 'right' });
    s.line('Rate', cols.rate, s.y, { size: 9, bold: true, color: MUTED, align: 'right' });
    s.line('Amount', cols.amount, s.y, { size: 9, bold: true, color: MUTED, align: 'right' });
    s.y -= 14;
    s.rule(s.y);
    s.y -= 8;
  };
  s.room(40);
  head();
  const items = inv.items || [];
  if (!items.length) {
    s.line('No line items', M, s.y, { size: 10, color: MUTED });
    s.y -= 20;
  }
  for (const l of items) {
    const rows = s.lines(l.description, descW);
    const h = rows.length * 13 + 8;
    if (s.y - h < M + 16) { s.addPage(); head(); }
    rows.forEach((row, j) => s.line(row, M, s.y - j * 13));
    s.line(qty(l.quantity), cols.qty, s.y, { align: 'right' });
    s.line(usd(l.unitCents), cols.rate, s.y, { align: 'right' });
    s.line(usd(l.amountCents), cols.amount, s.y, { align: 'right' });
    s.y -= h - 2;
    s.rule(s.y + 4, { thickness: 0.5 });
    s.y -= 6;
  }

  // Totals, payments and balance.
  const pays = m.payments || [];
  s.room(40 + pays.length * 14);
  s.y -= 6;
  const tx = M + CONTENT_W - 270;
  const total = (label, value, opts = {}) => {
    // The label gets the room left of the amount; a longer one is shortened with "...".
    const room = cols.amount - tx - s.width(value, opts) - 12;
    let text = s.clean(label);
    if (s.width(text, opts) > room) {
      while (text.length > 1 && s.width(`${text}...`, opts) > room) text = text.slice(0, -1);
      text = `${text.trimEnd()}...`;
    }
    s.line(text, tx, s.y, { size: 10, ...opts });
    s.line(value, cols.amount, s.y, { size: 10, ...opts, align: 'right' });
    s.y -= opts.size ? opts.size + 6 : 15;
  };
  total('Total', usd(inv.amountCents));
  for (const p of pays) {
    if (s.y < M + 40) s.addPage();
    const what = [`${PAYMENT_LABEL[p.kind] || 'Payment'} ${day(p.at, tz)}`, p.method, p.reference].filter(Boolean).join(' · ');
    total(what, `-${usd(p.amountCents)}`, { color: MUTED });
  }
  s.rule(s.y + 2, { from: tx, thickness: 1.5, color: INK });
  s.y -= 6;
  total('Balance due', usd(Math.max(0, (inv.amountCents || 0) - (inv.paidCents || 0))), { size: 13, bold: true });

  if (inv.notes) {
    s.y -= 12;
    const rows = s.lines(inv.notes, CONTENT_W);
    s.room(30);
    s.line('Notes', M, s.y, { size: 9, bold: true, color: MUTED });
    s.y -= 15;
    for (const row of rows) {
      s.room(14);
      s.line(row, M, s.y);
      s.y -= 13;
    }
  }
  if (preparedBy) {
    s.y -= 14;
    s.room(20);
    s.line(`Prepared by ${preparedBy}${inv.kind === 'freight' && m.carrier?.name ? ` on behalf of ${m.carrier.name}` : ''}.`, M, s.y, { size: 9, color: MUTED });
  }
  if (s.pages.length > 1) {
    s.pages.forEach((p, i) => {
      const label = `Invoice #${inv.number} · page ${i + 1} of ${s.pages.length}`;
      p.drawText(clean(label), { x: M + CONTENT_W - fonts.regular.widthOfTextAtSize(clean(label), 8), y: M - 20, size: 8, font: fonts.regular, color: MUTED });
    });
  }
  return doc.save();
}

/** The stored-name prefix of an invoice's generated PDF (one Document per invoice). */
const pdfPrefix = (inv) => `invoice-${inv.id}-`;

/** The Document holding an invoice's generated PDF, or null. */
export async function storedInvoicePdf(inv) {
  return prisma.document.findFirst({
    where: { ownerId: inv.ownerId, type: 'invoice', storedName: { startsWith: pdfPrefix(inv) } },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Store PDF bytes as the invoice's Document (type 'invoice', on the invoice's carrier and load, named
 * invoice-<number>.pdf). An earlier stored PDF of the same invoice is replaced in place (same document id, so an email
 * still waiting to be sent attaches the newest copy), never piled up. Returns the Document.
 */
export async function storeInvoicePdf(user, inv, bytes) {
  const dir = path.join(config.uploadDir, DOC_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  const storedName = `${pdfPrefix(inv)}${Date.now()}-${randomToken(6)}.pdf`;
  const buf = Buffer.from(bytes);
  await fsp.writeFile(filePath(DOC_SUBDIR, storedName), buf);
  const data = { originalName: `invoice-${inv.number}.pdf`, storedName, mimeType: 'application/pdf', sizeBytes: buf.length };
  try {
    const existing = await prisma.document.findMany({
      where: { ownerId: inv.ownerId, type: 'invoice', storedName: { startsWith: pdfPrefix(inv) } },
      orderBy: { createdAt: 'desc' }, select: { id: true, storedName: true },
    });
    const [keep, ...extra] = existing;
    let doc;
    if (keep) {
      doc = await prisma.document.update({ where: { id: keep.id }, data: { ...data, uploadedById: user.id, carrierId: inv.carrierId || null, loadId: inv.loadId || null } });
      removeFile(DOC_SUBDIR, keep.storedName);
    } else {
      doc = await prisma.document.create({
        data: { ...data, ownerId: inv.ownerId, uploadedById: user.id, carrierId: inv.carrierId || null, loadId: inv.loadId || null, type: 'invoice', source: 'generated' },
      });
    }
    // Copies left by two stores at the same moment: keep one.
    if (extra.length) {
      await prisma.document.deleteMany({ where: { id: { in: extra.map((d) => d.id) } } });
      for (const d of extra) removeFile(DOC_SUBDIR, d.storedName);
    }
    return doc;
  } catch (err) {
    removeFile(DOC_SUBDIR, storedName);
    throw err;
  }
}
