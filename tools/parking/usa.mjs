/**
 * "Is this point in the United States?" for the parking build, from the us-atlas nation outline (1:10m) that the
 * client already depends on. Overpass boxes are rectangles, so they also catch Canada and Mexico; filtering here keeps
 * the Overpass query cheap (an area filter on the whole US made the public servers time out).
 * Needs client dependencies installed (cd client && npm install). Without them, nothing is filtered (with a warning).
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Rings with bounding boxes from a GeoJSON (Multi)Polygon geometry. */
export function ringsOf(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  const rings = [];
  for (const poly of polys) {
    for (const ring of poly) {
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (const [x, y] of ring) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
      rings.push({ ring, minX, minY, maxX, maxY });
    }
  }
  return rings;
}

/** Even-odd ray casting over all rings (holes included), in plain lng/lat. */
export function insideRings(rings, x, y) {
  let inside = false;
  for (const r of rings) {
    if (x < r.minX || x > r.maxX || y < r.minY || y > r.maxY) continue;
    const pts = r.ring;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * Point filter for the US. `buffer` degrees (about 2 km) keeps places on the shore that the generalized coastline
 * cuts off; the price is that a stop within ~2 km across the border can stay in.
 */
export function usFilter(rings, buffer = 0.02) {
  return (lng, lat) => insideRings(rings, lng, lat)
    || [[buffer, 0], [-buffer, 0], [0, buffer], [0, -buffer]].some(([dx, dy]) => insideRings(rings, lng + dx, lat + dy));
}

export function loadUSFilter() {
  try {
    const require = createRequire(path.resolve(here, '../../client/package.json'));
    const topo = require('us-atlas/nation-10m.json');
    const { feature } = require('topojson-client');
    const nation = feature(topo, topo.objects.nation);
    const geometry = nation.type === 'FeatureCollection' ? nation.features[0].geometry : nation.geometry;
    return usFilter(ringsOf(geometry));
  } catch (err) {
    console.warn(`US outline not available (${err.message}); keeping every point. Run npm install in client first.`);
    return null;
  }
}
