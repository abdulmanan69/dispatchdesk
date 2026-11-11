/**
 * Truck parking along a road route, computed in the browser (no service calls).
 * Parking points are the packed rows of /data/truck-parking.json: [lng, lat, kind, name, flags?, hgvSpaces?].
 * Route lines are [[lng, lat], ...] from polyline.js. Distances are in miles.
 */
import { splitRoute } from './polyline.js';

export const CORRIDOR_MILES = 10;
const CELL = 0.25; // grid cell in degrees (about 17 miles north-south)
const KY = 69.0; // miles per degree of latitude
const toRad = (d) => (d * Math.PI) / 180;
const cellKey = (x, y) => (x + 2000) * 4000 + (y + 2000);

/** Grid index of points by cell, so a route only looks at points near it. */
export function buildIndex(points, cell = CELL) {
  const cells = new Map();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const k = cellKey(Math.floor(p[0] / cell), Math.floor(p[1] / cell));
    const list = cells.get(k);
    if (list) list.push(i); else cells.set(k, [i]);
  }
  return { cell, cells };
}

const indexes = new WeakMap();
function indexFor(points) {
  let idx = indexes.get(points);
  if (!idx) { idx = buildIndex(points); indexes.set(points, idx); }
  return idx;
}

/** Drop route vertices closer than `minMiles` to the previous kept one (road routes carry thousands of them). */
export function thinLine(line, minMiles = 0.25) {
  if (!line || line.length < 3) return line || [];
  const out = [line[0]];
  for (let i = 1; i < line.length - 1; i++) {
    const a = out[out.length - 1];
    const b = line[i];
    const kx = 69.172 * Math.cos(toRad(a[1]));
    if (Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * KY) >= minMiles) out.push(b);
  }
  out.push(line[line.length - 1]);
  return out;
}

/**
 * Parking within `miles` of a route line, in the order the truck reaches it.
 * Returns [{ i, ahead, off }]: i is the index into `points`, ahead the miles along the route to the spot nearest the
 * point, off the miles between that spot and the point. Points behind the start of the line are left out. Where the
 * route passes a point twice, the first pass counts.
 */
export function parkingAlongRoute(points, line, { miles = CORRIDOR_MILES, index } = {}) {
  if (!points?.length || !line || line.length < 2) return [];
  const { cell, cells } = index || indexFor(points);
  const path = thinLine(line);
  const best = new Map();
  let cum = 0;
  for (let s = 0; s < path.length - 1; s++) {
    const a = path[s];
    const b = path[s + 1];
    const kx = 69.172 * Math.cos(toRad((a[1] + b[1]) / 2));
    const dx = (b[0] - a[0]) * kx;
    const dy = (b[1] - a[1]) * KY;
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2);
    const padLng = miles / Math.max(kx, 1);
    const padLat = miles / KY;
    const x0 = Math.floor((Math.min(a[0], b[0]) - padLng) / cell);
    const x1 = Math.floor((Math.max(a[0], b[0]) + padLng) / cell);
    const y0 = Math.floor((Math.min(a[1], b[1]) - padLat) / cell);
    const y1 = Math.floor((Math.max(a[1], b[1]) + padLat) / cell);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const list = cells.get(cellKey(x, y));
        if (!list) continue;
        for (const j of list) {
          const p = points[j];
          const px = (p[0] - a[0]) * kx;
          const py = (p[1] - a[1]) * KY;
          const raw = len2 ? (px * dx + py * dy) / len2 : 0;
          const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
          const off = Math.hypot(px - t * dx, py - t * dy);
          if (off > miles) continue;
          // Nearest to the start from before it: behind the truck (decided once the closest segment is known).
          const behind = s === 0 && raw < 0;
          const ahead = cum + t * len;
          const prev = best.get(j);
          if (!prev) best.set(j, { i: j, ahead, off, behind });
          else if (off < prev.off && ahead - prev.ahead < miles * 3) { prev.off = off; prev.ahead = ahead; prev.behind = behind; }
        }
      }
    }
    cum += len;
  }
  // A place within a mile of the start still counts (the truck may be parked next to it).
  return [...best.values()]
    .filter((r) => !(r.behind && r.off > 1))
    .map(({ i, ahead, off }) => ({ i, ahead, off }))
    .sort((a, b) => a.ahead - b.ahead);
}

/**
 * The road ahead of a truck, for "Along this route": the rest of the trip it is hauling (from its position), or the
 * empty miles to its next pickup followed by that trip. Only road routes count; straight-line estimates do not.
 * `from` says where the miles count from: the truck, or the pickup when the truck's position or empty route is unknown.
 */
export function routeAhead(truck, routes, deadheads) {
  if (!truck) return null;
  const trip = truck.currentTrip || truck.nextTrip;
  if (!trip) return null;
  const pos = truck.location?.lat != null ? { lat: truck.location.lat, lng: truck.location.lng } : null;
  const r = routes?.get?.(trip.id);
  const road = r?.points?.length > 1 && !r.estimate ? r.points : null;
  let points;
  let from;
  if (truck.currentTrip) {
    if (!road) return null;
    points = pos ? splitRoute(road, pos).ahead : road;
    from = pos ? 'truck' : 'pickup';
  } else {
    const dh = pos ? deadheads?.get?.(`${truck.id}:${trip.id}`) : null;
    const lead = dh?.points?.length > 1 && !dh.estimate ? splitRoute(dh.points, pos).ahead : [];
    points = [...lead, ...(road || [])];
    from = lead.length ? 'truck' : 'pickup';
  }
  if (!points || points.length < 2) return null;
  const place = (p) => p?.city || p?.state || '';
  return { key: `${truck.id}:${trip.id}`, points, from, label: [place(trip.origin), place(trip.dest)].filter(Boolean).join(' → ') };
}
