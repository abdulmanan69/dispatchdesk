/**
 * Photo capture helpers for the driver page: everything runs on the phone, so the server never processes images.
 * Photos are turned upright (EXIF orientation), scaled to at most 1600 px on the long side and saved as JPEG of
 * roughly 300 KB; several pages become one PDF (see ./pdf.js).
 */
export const MAX_SIDE = 1600;
export const TARGET_BYTES = 300_000;

/** Scaled size that fits inside maxSide on the long edge (never enlarges). */
export function fitSize(width, height, maxSide = MAX_SIDE) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const scale = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** JPEG qualities to try, best first, until the file is near the target size. */
export const QUALITIES = [0.78, 0.68, 0.58, 0.5];

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

const toBlob = (canvas, quality) => (canvas.convertToBlob
  ? canvas.convertToBlob({ type: 'image/jpeg', quality })
  : new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read the photo'))), 'image/jpeg', quality)));

/**
 * Compress a photo: returns { blob, width, height }. Throws with a plain message when the file is not a readable image.
 */
export async function compressImage(file, { maxSide = MAX_SIDE, targetBytes = TARGET_BYTES } = {}) {
  let source;
  try { source = await decode(file); } catch { throw new Error('This photo could not be read. Try taking it again.'); }
  const { width, height } = fitSize(source.width, source.height, maxSide);
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  source.close?.();
  let blob = null;
  for (const q of QUALITIES) {
    blob = await toBlob(canvas, q);
    if (blob.size <= targetBytes * 1.3) break;
  }
  return { blob, width, height };
}
