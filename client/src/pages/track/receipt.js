import { SIG_W, SIG_H } from '../onboard/signaturePad.js';

/**
 * Proof-of-delivery receipt composed on the driver's phone: a white, 1600 px wide JPEG with the delivery details, the
 * receiver's printed name and drawn signature, the driver and (when known) the GPS position. It is sent like a POD
 * photo, so it reaches dispatch even when the server never sees the strokes.
 *
 * receiptLayout() is a pure function of the data and a text measurer (tested without a canvas); drawReceipt() replays
 * the layout on a 2D context; composeReceipt() does both on a canvas and returns the JPEG.
 *
 * data: { reference, facility, address, city, state, tz, deliveredAt, receiverName, receiverTitle, pieces, exceptions,
 *         strokes (normalized 0..1 points of the pad, see signaturePad.js), driverName, company, position: { lat, lng, accuracy } | null }
 */
export const RECEIPT_W = 1600;
const PAD = 96;
const CONTENT_W = RECEIPT_W - PAD * 2;
// The signature keeps the pad's 3:1 shape.
export const SIG_BOX = { w: CONTENT_W, h: Math.round((CONTENT_W * SIG_H) / SIG_W) };
const FAMILY = 'Arial, "Helvetica Neue", Helvetica, sans-serif';
const INK = '#111111';
const MUTED = '#4a4a4a';
const RULE = '#bdbdbd';
const SIZE = { title: 72, sub: 34, label: 28, value: 40, foot: 26 };
const font = (size, bold = false) => `${bold ? '700' : '400'} ${size}px ${FAMILY}`;
const lineHeight = (size) => Math.round(size * 1.3);

/** "Wed, Nov 11, 2026, 3:42 PM CST" in the facility's time zone (the phone's zone when unknown or invalid). */
export function zonedDateTime(date, tz) {
  const d = new Date(date);
  const opts = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  if (tz) {
    try { return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz }).format(d); } catch { /* unknown zone: fall back to the phone's */ }
  }
  return new Intl.DateTimeFormat('en-US', opts).format(d);
}

/** "31.76190, -106.48500 (within 9 m)" or null without a position. */
export function positionText(position) {
  if (!position || !Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return null;
  const acc = Number.isFinite(position.accuracy) ? ` (within ${Math.round(position.accuracy)} m)` : '';
  return `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}${acc}`;
}

/**
 * Break text into lines no wider than maxWidth. Explicit line breaks are kept; a word wider than a line (a long name
 * or reference without spaces) is split across lines.
 */
export function wrapText(text, maxWidth, measure) {
  const out = [];
  for (const para of String(text ?? '').split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { if (out.length) out.push(''); continue; }
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (measure(next) <= maxWidth) { line = next; continue; }
      if (line) out.push(line);
      line = '';
      let rest = word;
      while (measure(rest) > maxWidth && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && measure(rest.slice(0, cut)) > maxWidth) cut -= 1;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    if (line) out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * Lay out the receipt. measure(text, font) returns the width in px. Returns { width, height, ops } where ops are
 * { kind: 'text', text, x, y, font, color } (y is the baseline), { kind: 'rule', x, y, w } and
 * { kind: 'signature', x, y, w, h, strokes }.
 */
export function receiptLayout(data, measure) {
  const ops = [];
  let y = PAD;
  const lines = (text, size, { bold = false, color = INK, gapAfter = 0 } = {}) => {
    const f = font(size, bold);
    for (const t of wrapText(text, CONTENT_W, (s) => measure(s, f))) {
      y += lineHeight(size);
      ops.push({ kind: 'text', text: t, x: PAD, y: y - Math.round(size * 0.3), font: f, color });
    }
    y += gapAfter;
  };
  const rule = (gap = 28) => { y += gap; ops.push({ kind: 'rule', x: PAD, y, w: CONTENT_W }); y += gap; };
  // A label, then its values (the first in bold unless boldFirst is false); empty values are left out.
  const field = (label, values, { boldFirst = true } = {}) => {
    lines(label, SIZE.label, { color: MUTED, gapAfter: 4 });
    const shown = values.filter((v) => v != null && String(v).trim() !== '');
    (shown.length ? shown : ['Not given']).forEach((v, i) => lines(v, SIZE.value, { bold: boldFirst && i === 0 }));
    y += 22;
  };

  lines('Proof of delivery', SIZE.title, { bold: true });
  lines(data.reference ? `Load ${data.reference}` : 'Load reference not given', SIZE.sub, { color: MUTED });
  rule();

  field('Consignee', [data.facility, data.address, [data.city, data.state].filter(Boolean).join(', ')]);
  field('Delivered', [zonedDateTime(data.deliveredAt || new Date(), data.tz)]);
  field('Received by', [data.receiverName, data.receiverTitle]);
  if (String(data.pieces ?? '').trim()) field('Pieces or pallets received', [data.pieces]);
  field('Exceptions (over, short, damaged)', [String(data.exceptions ?? '').trim() || 'None noted'], { boldFirst: false });

  lines('Receiver\'s signature', SIZE.label, { color: MUTED, gapAfter: 12 });
  ops.push({ kind: 'signature', x: PAD, y, w: SIG_BOX.w, h: SIG_BOX.h, strokes: data.strokes || [] });
  y += SIG_BOX.h + 30;

  rule(8);
  field('Driver', [[data.driverName, data.company].filter(Boolean).join(', ')]);
  field('GPS position', [positionText(data.position) || 'Not available'], { boldFirst: false });
  lines('Signed electronically on the driver\'s phone. By signing, the receiver confirmed the shipment was received as described, with any exceptions noted above.', SIZE.foot, { color: MUTED });

  return { width: RECEIPT_W, height: Math.ceil(y + PAD), ops };
}

/** Paint a layout on a 2D context: white page, black text, the signature strokes inside a light frame. */
export function drawReceipt(ctx, layout) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.textBaseline = 'alphabetic';
  for (const op of layout.ops) {
    if (op.kind === 'text') {
      ctx.font = op.font;
      ctx.fillStyle = op.color;
      ctx.fillText(op.text, op.x, op.y);
    } else if (op.kind === 'rule') {
      ctx.fillStyle = RULE;
      ctx.fillRect(op.x, op.y, op.w, 2);
    } else if (op.kind === 'signature') {
      ctx.strokeStyle = RULE;
      ctx.lineWidth = 2;
      ctx.strokeRect(op.x, op.y, op.w, op.h);
      // Signature line, like on paper.
      ctx.fillStyle = RULE;
      ctx.fillRect(op.x + 40, op.y + op.h - 60, op.w - 80, 2);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const s of op.strokes) {
        if (!s?.length) continue;
        ctx.beginPath();
        ctx.moveTo(op.x + s[0].x * op.w, op.y + s[0].y * op.h);
        if (s.length === 1) ctx.lineTo(op.x + s[0].x * op.w + 0.5, op.y + s[0].y * op.h);
        for (let i = 1; i < s.length; i += 1) ctx.lineTo(op.x + s[i].x * op.w, op.y + s[i].y * op.h);
        ctx.stroke();
      }
    }
  }
}

const toJpeg = (canvas, quality) => new Promise((resolve, reject) => {
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('This phone could not save the receipt. Try again.'))), 'image/jpeg', quality);
});

/** Compose the receipt on a canvas: { blob (JPEG), width, height }. */
export async function composeReceipt(data, { createCanvas = () => document.createElement('canvas') } = {}) {
  const canvas = createCanvas();
  const ctx = canvas.getContext?.('2d');
  if (!ctx) throw new Error('This phone could not draw the receipt. Try again or send a photo of the paper POD.');
  const measure = (text, f) => { ctx.font = f; return ctx.measureText(text).width; };
  const layout = receiptLayout(data, measure);
  canvas.width = layout.width;
  canvas.height = layout.height;
  drawReceipt(ctx, layout);
  const blob = await toJpeg(canvas, 0.85);
  return { blob, width: layout.width, height: layout.height };
}
