/**
 * Road-route geometry on the client (same algorithms as server/src/services/fleet/polyline.js and progress.js).
 * Points are [lng, lat]. Routes arrive as encoded polylines (precision 5) and are decoded once per route version.
 */

/** Decode a polyline string to [[lng, lat], ...]; stops at the first malformed value. */
export function decodePolyline(str, precision = 5) {
  const s = typeof str === 'string' ? str : '';
  const f = 10 ** precision;
  const pts = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let shift = 0;
    let result = 0;
    let b;
    do {
      if (i >= s.length) return null;
      b = s.charCodeAt(i++) - 63;
      if (b < 0 || b > 63) return null;
      result += (b & 0x1f) * 2 ** shift;
      shift += 5;
    } while (b >= 0x20 && shift < 35);
    return result % 2 === 1 ? -(result + 1) / 2 : result / 2;
  };
  while (i < s.length) {
    const dLat = next();
    if (dLat == null) break;
    const dLng = next();
    if (dLng == null) break;
    lat += dLat;
    lng += dLng;
    if (Math.abs(lat / f) > 90 || Math.abs(lng / f) > 180) break;
    pts.push([lng / f, lat / f]);
  }
  return pts;
}

const toRad = (d) => (d * Math.PI) / 180;
export function segmentMiles(a, b) {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Nearest point of a route to p ({ lat, lng }): { index, t, point, offMiles }. */
export function projectOnRoute(points, p) {
  if (!points || points.length < 2 || p?.lat == null || p?.lng == null) return null;
  const kx = 69.172 * Math.cos(toRad(p.lat));
  const ky = 69.0;
  let best = Infinity;
  let bi = 0;
  let bt = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const ax = (a[0] - p.lng) * kx;
    const ay = (a[1] - p.lat) * ky;
    const dx = (b[0] - a[0]) * kx;
    const dy = (b[1] - a[1]) * ky;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const d2 = cx * cx + cy * cy;
    if (d2 < best) { best = d2; bi = i; bt = t; }
  }
  const a = points[bi];
  const b = points[bi + 1];
  return { index: bi, t: bt, point: [a[0] + bt * (b[0] - a[0]), a[1] + bt * (b[1] - a[1])], offMiles: Math.sqrt(best) };
}

/** Split a route at the point nearest to p: { done: [...], ahead: [...], snap } (both include the split point). */
export function splitRoute(points, p) {
  const snap = projectOnRoute(points, p);
  if (!snap) return { done: [], ahead: points || [], snap: null };
  const done = points.slice(0, snap.index + 1);
  done.push(snap.point);
  const ahead = [snap.point, ...points.slice(snap.index + 1)];
  return { done, ahead, snap };
}

/** Bounding box [[minLng, minLat], [maxLng, maxLat]] of several point lists, or null. */
export function boundsOf(...lists) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const list of lists) for (const [x, y] of list || []) {
    if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX) ? [[minX, minY], [maxX, maxY]] : null;
}
