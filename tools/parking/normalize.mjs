/**
 * Pure helpers for the truck parking build (tools/parking/build.mjs): classify OpenStreetMap elements, clean their
 * names, and reduce them to a compact, deduplicated point list for client/public/data/truck-parking.json.
 *
 * Output point: [lng, lat, kind, name, flags?, hgvSpaces?]
 *   kind      1 truck stop, 2 rest area or service plaza, 3 truck parking
 *   flags     bit mask, see FLAGS (left out when 0 and nothing follows)
 *   hgvSpaces mapped truck spaces (capacity:hgv), a static count, never live availability
 * No dependencies, so it runs in Node (the build) and in the tests alike.
 */

export const KIND = { truck_stop: 1, rest_area: 2, truck_parking: 3 };
export const KINDS = ['', 'truck_stop', 'rest_area', 'truck_parking'];
export const FLAGS = { open24h: 1, showers: 2, toilets: 4, paid: 8 };

// Truck stop chains (brand tag, matched whole and case-insensitive). Used in the Overpass query and here.
export const TRUCK_BRANDS = [
  'Pilot', 'Pilot Travel Center', 'Pilot Travel Centers', 'Pilot Flying J', 'Flying J', 'Flying J Travel Center',
  "Love's", "Love's Travel Stop", "Love's Travel Stops", 'Loves', 'TA', 'TA Express', 'TA Petro',
  'TravelCenters of America', 'Travel Centers of America', 'Petro', 'Petro Stopping Center', 'Petro Stopping Centers',
  'Sapp Bros.', 'Sapp Bros', "Roady's", "Roady's Truck Stop", 'AmBest', 'Road Ranger', 'Bosselman', 'Bosselman Travel Center',
];
// Names that say "truck stop" even without truck tags.
export const TRUCK_NAME_RE = /truck ?stop|truck ?plaza|travel ?(center|centre|plaza|stop)|flying j|pilot travel|love.?s travel/i;

const brandSet = new Set(TRUCK_BRANDS.map((b) => b.toLowerCase().replace(/[’`]/g, "'")));
const yes = (v) => v === 'yes' || v === 'designated' || v === 'only';
const no = (v) => v === 'no' || v === 'private';
const GENERIC = new Set(['rest area', 'rest stop', 'parking', 'truck parking', 'parking lot', 'service area', 'services', 'fuel', 'gas station']);

export const isTruckBrand = (value) => !!value && brandSet.has(String(value).trim().toLowerCase().replace(/[’`]/g, "'"));

/** Number of truck spaces from capacity:hgv ("40", "~40", "40+"), or 0. */
export function hgvSpaces(tags = {}) {
  const m = String(tags['capacity:hgv'] ?? '').match(/\d+/);
  const n = m ? Number(m[0]) : 0;
  return n > 0 && n < 5000 ? n : 0;
}

/** Truck tags, a truck stop chain, or a truck stop name. */
const truckSignals = (tags) => yes(tags.hgv) || tags.truck_stop === 'yes' || tags['fuel:HGV_diesel'] === 'yes'
  || isTruckBrand(tags.brand) || TRUCK_NAME_RE.test(tags.name || '');

/** Fuel station that serves trucks: truck tags, a truck stop chain, or a truck stop name; never hgv=no. */
export function isTruckFuel(tags = {}) {
  if (no(tags.hgv)) return false;
  if (tags.amenity === 'truck_stop') return true;
  if (tags.amenity !== 'fuel') return false;
  return truckSignals(tags);
}

// highway=services is also put on single shops and offices; a real service plaza is an area or says so in its name.
const SERVICES_NAME_RE = /servic|plaza|rest|travel|welcome|turnpike|tollway|thruway|stop/i;
const SERVICES_AMENITY = new Set(['fuel', 'parking', 'toilets', 'restaurant', 'fast_food', 'cafe', 'truck_stop']);

/**
 * Kind code for an element's tags, or 0 when it is not a place for trucks. `type` is the OSM element type
 * (node, way, relation); it only matters for highway=services.
 */
export function classify(tags = {}, type = 'way') {
  if (tags.access === 'private' || tags.access === 'no') return 0;
  if (tags.highway === 'services') {
    if (no(tags.hgv)) return 0;
    // Truck stops are often mapped as a services area (Love's, Pilot, Flying J, TA with hgv=yes).
    if (truckSignals(tags)) return KIND.truck_stop;
    if (tags.amenity && !SERVICES_AMENITY.has(tags.amenity)) return 0;
    if (tags.name ? !SERVICES_NAME_RE.test(tags.name) : type === 'node') return 0;
    return KIND.rest_area;
  }
  if (tags.highway === 'rest_area') return no(tags.hgv) ? 0 : KIND.rest_area;
  if (tags.amenity === 'fuel' || tags.amenity === 'truck_stop') return isTruckFuel(tags) ? KIND.truck_stop : 0;
  if (tags.amenity === 'parking') {
    if (no(tags.hgv)) return 0;
    return yes(tags.hgv) || tags.parking === 'truck' || hgvSpaces(tags) > 0 ? KIND.truck_parking : 0;
  }
  return 0;
}

/** Display name: name, else brand; trimmed, single-spaced, at most 64 characters; generic names become ''. */
export function cleanName(tags = {}) {
  const raw = String(tags.name || tags.brand || '').replace(/\s+/g, ' ').trim();
  if (!raw || GENERIC.has(raw.toLowerCase())) return '';
  return raw.length > 64 ? `${raw.slice(0, 63).trimEnd()}…` : raw;
}

export function flagsOf(tags = {}) {
  let f = 0;
  if (String(tags.opening_hours || '').trim() === '24/7') f |= FLAGS.open24h;
  if (/^(yes|hot|customers)$/.test(tags.shower || tags['amenity:shower'] || '')) f |= FLAGS.showers;
  if (/^(yes|customers)$/.test(tags.toilets || '')) f |= FLAGS.toilets;
  if (tags.fee === 'yes' || tags['fee:conditional']) f |= FLAGS.paid;
  return f;
}

export const round4 = (n) => Math.round(n * 1e4) / 1e4;

/** One Overpass element (node with lat/lon, way or relation with center) to a point, or null. */
export function toPoint(el) {
  const tags = el?.tags || {};
  const kind = classify(tags, el.type);
  if (!kind) return null;
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lng: round4(lng), lat: round4(lat), kind, name: cleanName(tags), flags: flagsOf(tags), spaces: hgvSpaces(tags) };
}

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
/** Distance in meters (equirectangular, accurate to well under a meter at these ranges). */
export function meters(a, b) {
  const x = rad(b.lng - a.lng) * Math.cos(rad((a.lat + b.lat) / 2));
  const y = rad(b.lat - a.lat);
  return Math.sqrt(x * x + y * y) * R;
}

// Better records survive a merge: a name, then more detail.
const score = (p) => (p.name ? 4 : 0) + (p.spaces ? 2 : 0) + (p.flags ? 1 : 0);

function merge(into, from, takeName = true) {
  if (takeName && !into.name && from.name) into.name = from.name;
  into.flags |= from.flags;
  if (!into.spaces && from.spaces) into.spaces = from.spaces;
}

/** Grid of points for neighbor lookups within `radius` meters. */
function grid(radius) {
  const cell = radius / 111000; // degrees of latitude; longitude cells are narrower than that, never wider
  const cells = new Map();
  const key = (x, y) => `${x}:${y}`;
  return {
    add(p) {
      const k = key(Math.floor(p.lng / cell), Math.floor(p.lat / cell));
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(p);
    },
    near(p) {
      const cx = Math.floor(p.lng / cell);
      const cy = Math.floor(p.lat / cell);
      // A degree of longitude shrinks with latitude, so look further east and west.
      const span = Math.ceil(1 / Math.max(0.2, Math.cos(rad(p.lat))));
      const out = [];
      for (let dx = -span; dx <= span; dx++) for (let dy = -1; dy <= 1; dy++) out.push(...(cells.get(key(cx + dx, cy + dy)) || []));
      return out;
    },
  };
}

// First word of a name, for "same business?" ("Pilot Travel Center" and "Pilot" match; "Pilot" and "Love's" do not).
const nameKey = (n) => {
  const s = String(n || '').toLowerCase();
  return s.replace(/[^a-z0-9 ]/g, '').trim().split(' ')[0] || s.trim();
};

/**
 * Remove duplicates of the same kind within `radius` meters (an OSM node and area for one place, overlapping
 * boxes, two pumps of one stop). Two places with different names are never merged (a Pilot across the road from a
 * Love's); two with the same name merge up to `sameNameRadius` meters apart (a big lot's center and its fuel node).
 * The best-described record survives and inherits the others' name, flags and spaces.
 */
export function dedupe(points, radius = 150, sameNameRadius = 300) {
  const kept = [];
  const g = grid(Math.max(radius, sameNameRadius));
  const twinOf = (p, q) => {
    if (q.kind !== p.kind) return false;
    const d = meters(p, q);
    if (!p.name || !q.name) return d <= radius;
    return nameKey(p.name) === nameKey(q.name) && d <= sameNameRadius;
  };
  for (const p of [...points].sort((a, b) => score(b) - score(a))) {
    const twin = g.near(p).find((q) => twinOf(p, q));
    if (twin) { merge(twin, p); continue; }
    const copy = { ...p };
    kept.push(copy);
    g.add(copy);
  }
  return kept;
}

/**
 * Truck parking lots that belong to a truck stop or rest area (within `radius` meters) fold into that place:
 * the place gets the lot's truck space count and fee flag, and the lot is not listed twice.
 */
export function absorbLots(points, radius = 250) {
  const g = grid(radius);
  for (const p of points) if (p.kind !== KIND.truck_parking) g.add(p);
  return points.filter((p) => {
    if (p.kind !== KIND.truck_parking) return true;
    const host = g.near(p).filter((q) => meters(p, q) <= radius).sort((a, b) => meters(p, a) - meters(p, b))[0];
    if (!host) return true;
    merge(host, p, false);
    return false;
  });
}

/** Compact array form, trailing empty fields left out. */
export function packPoint(p) {
  const out = [p.lng, p.lat, p.kind, p.name || ''];
  if (p.flags || p.spaces) out.push(p.flags || 0);
  if (p.spaces) out.push(p.spaces);
  return out;
}

/**
 * All Overpass elements (any number of responses) to the sorted, deduplicated point list.
 * `keep(lng, lat)` drops points outside the area of interest (the US outline in the build).
 */
export function normalize(elements, { keep } = {}) {
  const seen = new Set();
  const points = [];
  for (const el of elements) {
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue; // the same element from two overlapping boxes
    seen.add(id);
    const p = toPoint(el);
    if (p && (!keep || keep(p.lng, p.lat))) points.push(p);
  }
  return absorbLots(dedupe(points))
    .sort((a, b) => a.kind - b.kind || a.lng - b.lng || a.lat - b.lat)
    .map(packPoint);
}

/** The file written to client/public/data/truck-parking.json. */
export function buildFile(elements, { generatedAt = new Date().toISOString(), sample = false, keep } = {}) {
  const points = normalize(elements, { keep });
  return {
    version: 1,
    generatedAt,
    ...(sample ? { sample: true } : {}),
    source: '© OpenStreetMap contributors (ODbL)',
    license: 'https://www.openstreetmap.org/copyright',
    kinds: KINDS,
    flags: FLAGS,
    format: '[lng, lat, kind, name, flags?, hgvSpaces?]; hgvSpaces is the mapped number of truck spaces, not live availability',
    points,
  };
}

/** JSON text with one point per line: small, and readable in a diff. */
export function stringify(file) {
  const { points, ...head } = file;
  const top = JSON.stringify(head).slice(0, -1);
  return `${top},"points":[\n${points.map((p) => JSON.stringify(p)).join(',\n')}\n]}\n`;
}
