/**
 * Road-route geometry helpers shared by the fleet map, the driver link and the broker tracking page.
 * Points are [lng, lat] (GeoJSON order) everywhere in this module.
 *
 * A load's road route is stored in LoadRoute.geometry (one row per load; Load.routeGeometry is deprecated and always
 * null) as an encoded polyline (Google's polyline algorithm, precision 5, about 1 m), simplified so a long-haul route
 * stays a few thousand points (10-20 KB) and decodes in well under a millisecond.
 */

/**
 * The stored road route of a load row: load.route.geometry, attached by the Prisma include ROUTE_INCLUDE
 * ({ route: { select: { geometry: true } } }, see ./route.js) or by withRouteGeometry() there. null when the load has
 * no stored route or it was not looked up.
 */
export const routeGeometryOf = (load) => load?.route?.geometry || null;

const R_MI = 3958.8;
const toRad = (d) => (d * Math.PI) / 180;

function encodeSigned(v) {
  let s = v < 0 ? ~(v * 2) : v * 2;
  let out = '';
  while (s >= 0x20) {
    out += String.fromCharCode((0x20 | (s & 0x1f)) + 63);
    s = Math.floor(s / 32);
  }
  return out + String.fromCharCode(s + 63);
}

/** Encode [[lng, lat], ...] as a polyline string. */
export function encodePolyline(points, precision = 5) {
  const f = 10 ** precision;
  let lastLat = 0;
  let lastLng = 0;
  let out = '';
  for (const p of points || []) {
    const lat = Math.round(p[1] * f);
    const lng = Math.round(p[0] * f);
    out += encodeSigned(lat - lastLat) + encodeSigned(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }
  return out;
}

/** Decode a polyline string to [[lng, lat], ...]. Stops at the first malformed value instead of throwing. */
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
    const la = lat / f;
    const ln = lng / f;
    if (Math.abs(la) > 90 || Math.abs(ln) > 180) break;
    pts.push([ln, la]);
  }
  return pts;
}

/** Great-circle miles between two [lng, lat] points. */
export function segmentMiles(a, b) {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Squared distance (m²) from p to segment a-b, all in local metres. */
function segDist2(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0];
  const y = a[1] + t * dy - p[1];
  return x * x + y * y;
}

/** Douglas-Peucker simplification with a tolerance in metres (iterative, keeps both ends). */
export function simplify(points, toleranceM = 40) {
  const n = points?.length || 0;
  if (n <= 2) return (points || []).slice();
  // Sinusoidal projection per point: accurate locally, which is all the tolerance test needs.
  const xy = points.map(([lng, lat]) => [lng * 111320 * Math.cos(toRad(lat)), lat * 110574]);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = toleranceM * toleranceM;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(xy[i], xy[a], xy[b]);
      if (d > max) { max = d; idx = i; }
    }
    if (idx !== -1 && max > tol2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

// About one point per 0.6 mi on a 600 mi trip: far more than progress snapping needs, and it keeps the stored polyline
// (a column on every Load row) and the decoded route caches small.
export const MAX_ROUTE_POINTS = 1000;

/** Simplify until the route has at most `maxPoints` points (40 m tolerance, doubled as needed). */
export function simplifyToBudget(points, maxPoints = MAX_ROUTE_POINTS, startToleranceM = 40) {
  let tol = startToleranceM;
  let out = simplify(points, tol);
  while (out.length > maxPoints && tol < 5000) {
    tol *= 2;
    out = simplify(points, tol);
  }
  return out;
}

const samePoint = (a, b) => Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;

/**
 * Make the route start and end exactly at the requested points (OSRM snaps them to the nearest road), so a stored route
 * can later be checked against the load's current pickup and delivery coordinates.
 */
export function pinEnds(points, from, to) {
  const out = (points || []).slice();
  const a = [from.lng, from.lat];
  const b = [to.lng, to.lat];
  if (!out.length || !samePoint(out[0], a)) out.unshift(a);
  if (!samePoint(out[out.length - 1], b)) out.push(b);
  return out;
}

/** True when an encoded route starts at `from` and ends at `to` (within about 1 m). */
export function routeMatches(encoded, from, to) {
  if (!encoded || !from || !to || from.lat == null || to.lat == null) return false;
  const pts = decodePolyline(encoded);
  if (pts.length < 2) return false;
  const near = (p, q) => Math.abs(p[0] - q.lng) < 2e-5 && Math.abs(p[1] - q.lat) < 2e-5;
  return near(pts[0], from) && near(pts[pts.length - 1], to);
}
