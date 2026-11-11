/**
 * Drawn signatures for the carrier onboarding page. Strokes are kept as points normalized to 0..1 of the pad (so a
 * phone rotation does not distort them) and exported as compact SVG path data in a 600 x 200 box using only absolute
 * M and L commands, which the server validates strictly (max 20 KB).
 */

export const SIG_W = 600;
export const SIG_H = 200;
export const MAX_PATH_CHARS = 20_000;

/** Font stack for typed signatures: script faces that ship with Windows, macOS and iOS, falling back to cursive. */
export const SCRIPT_FONT = '"Segoe Script", "Brush Script MT", "Snell Roundhand", "Apple Chancery", "URW Chancery L", cursive';

const fmt = (n) => {
  const v = Math.round(n * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};
const clamp = (v, max) => Math.min(max, Math.max(0, v));

/** Drop points closer than `tol` (in box units) to the last kept point; always keep the stroke's last point. */
function simplify(points, tol) {
  if (points.length <= 2) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const last = out[out.length - 1];
    if (Math.hypot(points[i][0] - last[0], points[i][1] - last[1]) >= tol) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

function build(strokes, tol) {
  const parts = [];
  for (const stroke of strokes) {
    if (!stroke.length) continue;
    const pts = simplify(stroke.map((p) => [clamp(p.x * SIG_W, SIG_W), clamp(p.y * SIG_H, SIG_H)]), tol);
    // A tap is a dot: repeat the point so the path has a visible segment.
    if (pts.length === 1) pts.push(pts[0]);
    parts.push(`M${fmt(pts[0][0])} ${fmt(pts[0][1])}`);
    for (let i = 1; i < pts.length; i += 1) parts.push(`L${fmt(pts[i][0])} ${fmt(pts[i][1])}`);
  }
  return parts.join('');
}

/** Path data for the strokes ('' when nothing was drawn), simplified further until it fits the size limit. */
export function strokesToPath(strokes) {
  const drawn = (strokes || []).filter((s) => s?.length);
  if (!drawn.length) return '';
  let tol = 1.5;
  let d = build(drawn, tol);
  while (d.length > MAX_PATH_CHARS && tol < 64) {
    tol *= 1.6;
    d = build(drawn, tol);
  }
  return d.length > MAX_PATH_CHARS ? '' : d;
}

/** Enough ink to count as a signature: at least 12 box units of total stroke length. */
export function hasInk(strokes) {
  let len = 0;
  for (const s of strokes || []) {
    for (let i = 1; i < s.length; i += 1) len += Math.hypot((s[i].x - s[i - 1].x) * SIG_W, (s[i].y - s[i - 1].y) * SIG_H);
  }
  return len >= 12;
}
