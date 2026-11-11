/**
 * Signatures on onboarding links: a typed name, or a drawn signature sent as compact SVG path data.
 *
 * Drawn signatures are validated strictly: only absolute M, L, Q, C and Z commands with plain decimal numbers, each
 * command with a whole number of coordinate pairs, x within 0..SIG_W and y within 0..SIG_H (the client scales its
 * canvas to that box). The path is rebuilt from the parsed numbers, so nothing the browser sent is stored verbatim.
 * Stored form: "typed:<name>" or "drawn:<path>" in OnboardingLink.signatureData.
 */

export const SIG_W = 600;
export const SIG_H = 200;
export const MAX_PATH_CHARS = 20 * 1024;
export const MAX_TYPED_CHARS = 120;

const ARGS = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
const TOKEN = /[\s,]*([MLQCZ]|-?(?:\d+(?:\.\d+)?|\.\d+))/y;
const round = (n) => Math.round(n * 10) / 10;

/** Normalized path data, or null when the input is not an acceptable signature path. */
export function normalizeSignaturePath(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_PATH_CHARS) return null;
  if (!/^[MLQCZ0-9.,\s-]+$/.test(raw)) return null;
  const tokens = [];
  TOKEN.lastIndex = 0;
  let pos = 0;
  const s = raw.trimEnd();
  while (pos < s.length) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(s);
    if (!m) return null;
    tokens.push(m[1]);
    pos = TOKEN.lastIndex;
  }
  if (tokens[0] !== 'M') return null;
  const out = [];
  let cmd = null;
  let args = [];
  let points = 0;
  const flush = () => {
    if (!cmd) return true;
    const n = ARGS[cmd];
    if (n === 0 ? args.length !== 0 : args.length === 0 || args.length % n !== 0) return false;
    out.push(cmd, ...args.map(String));
    points += args.length / 2;
    return true;
  };
  for (const t of tokens) {
    if (t in ARGS) {
      if (!flush()) return null;
      cmd = t;
      args = [];
      continue;
    }
    const v = Number(t);
    if (!Number.isFinite(v)) return null;
    const isX = args.length % 2 === 0;
    if (v < 0 || v > (isX ? SIG_W : SIG_H)) return null;
    args.push(round(v));
  }
  if (!flush()) return null;
  // At least a start point and one more point: an empty or single-dot "signature" is refused.
  if (points < 2) return null;
  const path = out.join(' ');
  return path.length <= MAX_PATH_CHARS * 2 ? path : null;
}

/** A typed signature: a name in plain characters (no markup, no control characters). Null when invalid. */
export function normalizeTypedSignature(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.replace(/\s+/g, ' ').trim();
  if (v.length < 2 || v.length > MAX_TYPED_CHARS) return null;
  // eslint-disable-next-line no-control-regex
  if (/[<>{}\u0000-\u001f\u007f]/.test(v)) return null;
  if (!/\p{L}/u.test(v)) return null;
  return v;
}

export function encodeSignature(type, data) {
  return `${type}:${data}`;
}

/** { type: 'typed'|'drawn', value } from the stored column, re-validated; null when absent or unreadable. */
export function decodeSignature(stored) {
  if (!stored) return null;
  const s = String(stored);
  if (s.startsWith('typed:')) {
    const value = normalizeTypedSignature(s.slice(6));
    return value ? { type: 'typed', value } : null;
  }
  if (s.startsWith('drawn:')) {
    const value = normalizeSignaturePath(s.slice(6));
    return value ? { type: 'drawn', value } : null;
  }
  return null;
}

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline SVG for a drawn signature. The path is re-validated here, so only digits, spaces and M/L/Q/C/Z reach the markup. */
export function signatureSvg(pathData, { color = '#111111', width = 300 } = {}) {
  const d = normalizeSignaturePath(pathData);
  if (!d) return '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIG_W} ${SIG_H}" width="${width}" height="${Math.round((width * SIG_H) / SIG_W)}" role="img" aria-label="Drawn signature"><path d="${escAttr(d)}" fill="none" stroke="${escAttr(color)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
