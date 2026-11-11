import { haversineMiles, ROAD_FACTOR, locate, STATES, CITIES } from '../market/geo.js';
import { trustFor } from './track.js';
import { decodePolyline, routeGeometryOf } from './polyline.js';

/**
 * Fleet helpers: truck positions, distance estimates and simple place lookup.
 * Distances here are straight-line × road factor estimates. The client asks /api/market/route
 * for real road miles when that service is available and sends them with the trip.
 */

export const TRUCK_STATUSES = ['unknown', 'available', 'loaded', 'off_duty', 'maintenance'];
export const ACTIVE_TRIP_STATUSES = ['planned', 'booked', 'in_transit'];
export const TRIP_FLOW = ['planned', 'booked', 'in_transit', 'delivered'];

const valid = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** Coordinates for a city/state pair; null when unknown. */
export function pointFor(city, state, lat, lng) {
  if (valid(lat, lng)) return { lat, lng, precision: 'exact' };
  if (!state) return null;
  const hit = locate(city ? `${city}, ${state}` : state);
  return hit ? { lat: hit.lat, lng: hit.lon, precision: hit.precision } : null;
}

/** Road-mile estimate between two points (rounded). */
export function estimateMiles(a, b) {
  if (!a || !b) return null;
  return Math.round(haversineMiles([a.lat, a.lng], [b.lat, b.lng]) * ROAD_FACTOR);
}

/** Straight-line miles, for ranking trucks by distance. */
export function crowMiles(a, b) {
  return haversineMiles([a.lat, a.lng], [b.lat, b.lng]);
}

/** Nearest bundled freight city to a GPS fix (for a readable "near Dallas, TX"), within maxMiles. */
export function nearestPlace(lat, lng, maxMiles = 75) {
  let best = null;
  for (const [key, [clat, clng]] of Object.entries(CITIES)) {
    const miles = haversineMiles([lat, lng], [clat, clng]);
    if (!best || miles < best.miles) best = { key, miles };
  }
  if (!best || best.miles > maxMiles) return null;
  const [city, st] = best.key.split(', ');
  return { city: city.replace(/\b\w/g, (c) => c.toUpperCase()), state: st.toUpperCase(), miles: Math.round(best.miles) };
}

/** Offline place search over the bundled freight-city and state-center tables (fallback for /api/market/geocode). */
export function searchPlaces(q, limit = 8) {
  const s = String(q || '').trim().toLowerCase();
  if (s.length < 2) return [];
  const out = [];
  for (const [key, [lat, lng]] of Object.entries(CITIES)) {
    if (key.includes(s) || key.replace(',', '').includes(s)) {
      const [city, st] = key.split(', ');
      const name = city.replace(/\b\w/g, (c) => c.toUpperCase());
      out.push({ label: `${name}, ${st.toUpperCase()}`, city: name, state: st.toUpperCase(), lat, lng, precision: 'city' });
    }
  }
  for (const [code, [name, lat, lng]] of Object.entries(STATES)) {
    if (code.toLowerCase() === s || name.toLowerCase().includes(s)) out.push({ label: `${name} (state center)`, city: null, state: code, lat, lng, precision: 'state' });
  }
  return out.slice(0, limit);
}

export const STALE_MS = 15 * 60000;

/** Live-location summary for a truck: where the position came from, how fresh it is, and any active driver link. */
export function liveView(c, now = Date.now()) {
  const raw = (c.locationShares || [])[0] || null;
  const expired = raw && new Date(raw.expiresAt).getTime() <= now;
  const share = raw && { ...raw, status: expired ? 'expired' : raw.status };
  const lastAt = share?.lastAt || (c.locationSource === 'driver_link' ? c.locationUpdatedAt : null);
  return {
    source: c.locationSource || (c.locationUpdatedAt ? 'manual' : null),
    sharing: share?.status === 'sharing',
    shareStatus: share?.status ?? null,
    shareId: share?.id ?? null,
    driverName: share?.driverName ?? null,
    lastAt: lastAt ?? null,
    speedMph: share?.lastSpeed != null ? Math.round(share.lastSpeed * 2.23694) : null,
    heading: share?.lastHeading ?? null,
    accuracyM: share?.lastAccuracy != null ? Math.round(share.lastAccuracy) : null,
    stale: lastAt ? now - new Date(lastAt).getTime() > STALE_MS : null,
    expiresAt: share?.expiresAt ?? null,
    // Anti-forwarding and plausibility: how much to trust this position, and why.
    ...(share ? (({ confidence, reasons, deviceLabel, pinVerified, pinEnabled, recentFlags }) => ({ confidence, reasons, deviceLabel, pinVerified, pinEnabled, recentFlags }))(trustFor(share, now)) : { confidence: null, reasons: [], deviceLabel: null, pinVerified: false, pinEnabled: false, recentFlags: [] }),
    // The latest fix when it failed the jump check: shown as unverified, never used as the truck's position.
    unverified: share?.lastAt && String(share.lastPingFlags || '').includes('impossible_jump')
      ? { lat: share.lastLat, lng: share.lastLng, at: share.lastAt }
      : null,
  };
}

/**
 * Carrier fields to change when a trip moves to `status` (shared by the dispatcher and the driver check-in).
 * in_transit → loaded; delivered → truck sits at the destination and is available; canceled in transit → available.
 */
export function truckUpdateForTrip(prevStatus, status, load) {
  const data = {};
  if (status === 'in_transit') data.truckStatus = 'loaded';
  if (status === 'delivered') {
    const pt = pointFor(load.destCity, load.destState, load.destLat, load.destLng);
    Object.assign(data, {
      truckStatus: 'available', locationCity: load.destCity, locationState: load.destState,
      locationLat: pt?.lat ?? null, locationLng: pt?.lng ?? null, locationUpdatedAt: new Date(),
      availableAt: load.deliveryDate && load.deliveryDate > new Date() ? load.deliveryDate : new Date(),
    });
  }
  if (status === 'canceled' && prevStatus === 'in_transit') data.truckStatus = 'available';
  // A truck with a status, a position or a trip belongs on the fleet map (Carrier.isFleet keeps the map query indexed).
  if (Object.keys(data).length) data.isFleet = true;
  return data;
}

/** Pickup and delivery points of a load (exact coordinates, else the city or state center). */
export function loadEnds(load) {
  return {
    from: pointFor(load.originCity, load.originState, load.originLat, load.originLng),
    to: pointFor(load.destCity, load.destState, load.destLat, load.destLng),
  };
}

/**
 * True when both ends are real places: exact coordinates or a known city. A stop known only by its state (a load typed
 * on the Loads page with a city outside the built-in table) would be routed from the state's center point, which gives
 * made-up road miles and ETAs and false off-route alerts once the truck moves, so such loads get no road route.
 */
export function routable(load) {
  const { from, to } = loadEnds(load);
  return !!from && !!to && from.precision !== 'state' && to.precision !== 'state';
}

// First and last point of stored routes, memoized per load and route version (decoding a long route on every poll adds up).
const endsMemo = new Map();
const ENDS_MEMO_MAX = 4000;
function storedRouteEnds(load, geometry) {
  const key = `${load.id}:${new Date(load.routeComputedAt).getTime()}:${geometry.length}`;
  if (endsMemo.has(key)) return endsMemo.get(key);
  const pts = decodePolyline(geometry);
  const v = pts.length >= 2 ? { first: pts[0], last: pts[pts.length - 1] } : null;
  if (endsMemo.size >= ENDS_MEMO_MAX) endsMemo.delete(endsMemo.keys().next().value);
  endsMemo.set(key, v);
  return v;
}

/**
 * True when the stored road route still starts at the pickup and ends at the delivery. The shape (LoadRoute) must be
 * attached to the row as load.route (ROUTE_INCLUDE or withRouteGeometry() in ./route.js); without it this is false.
 */
export function routeIsCurrent(load) {
  const geometry = routeGeometryOf(load);
  if (!geometry || !load.routeComputedAt) return false;
  const { from, to } = loadEnds(load);
  const ends = storedRouteEnds(load, geometry);
  if (!ends || !from || !to) return false;
  const near = (p, q) => Math.abs(p[0] - q.lng) < 2e-5 && Math.abs(p[1] - q.lat) < 2e-5;
  return near(ends.first, from) && near(ends.last, to);
}

/** Route summary for API views (the geometry itself is served by /api/fleet/routes). null when the row has no route fields. */
export function routeMeta(load) {
  if (!load || load.routeComputedAt === undefined) return null;
  const current = routeIsCurrent(load);
  return {
    miles: current && load.routeMiles != null ? Math.round(load.routeMiles) : null,
    minutes: current ? load.routeMinutes ?? null : null,
    source: current ? load.routeSource || 'estimate' : null,
    estimate: !current || load.routeSource !== 'osrm',
    computedAt: current ? load.routeComputedAt : null,
    current,
    // No road route will come: a stop is known only by its state (the map keeps the straight line marked Estimate).
    stateOnly: !current && !routable(load),
  };
}

/** Shape a carrier row (with loads) for the fleet map. */
export function truckView(c) {
  const point = pointFor(c.locationCity, c.locationState, c.locationLat, c.locationLng);
  const trips = (c.loads || []).map(tripView);
  return {
    id: c.id,
    companyName: c.companyName,
    mcNumber: c.mcNumber,
    dotNumber: c.dotNumber,
    phone: c.phone,
    email: c.email,
    equipment: c.equipment,
    fleetSize: c.fleetSize,
    homeCity: c.city,
    homeState: c.state,
    timezone: c.timezone,
    isCustomer: !!c.customer,
    stage: c.stage?.key ?? null,
    truckStatus: c.truckStatus,
    location: c.locationCity || c.locationState || valid(c.locationLat, c.locationLng)
      ? { city: c.locationCity, state: c.locationState, lat: point?.lat ?? null, lng: point?.lng ?? null, precision: point?.precision ?? null, updatedAt: c.locationUpdatedAt }
      : null,
    availableAt: c.availableAt,
    live: liveView(c),
    trips,
    currentTrip: trips.find((t) => t.status === 'in_transit') || null,
    nextTrip: trips.find((t) => t.status === 'planned' || t.status === 'booked') || null,
  };
}

export function tripView(l) {
  const origin = pointFor(l.originCity, l.originState, l.originLat, l.originLng);
  const dest = pointFor(l.destCity, l.destState, l.destLat, l.destLng);
  const miles = (l.loadedMiles || 0) + (l.deadheadMiles || 0);
  return {
    id: l.id,
    carrierId: l.carrierId,
    referenceNumber: l.referenceNumber,
    status: l.status,
    origin: { city: l.originCity, state: l.originState, lat: origin?.lat ?? null, lng: origin?.lng ?? null },
    dest: { city: l.destCity, state: l.destState, lat: dest?.lat ?? null, lng: dest?.lng ?? null },
    pickupDate: l.pickupDate,
    deliveryDate: l.deliveryDate,
    equipment: l.equipment,
    commodity: l.commodity,
    loadedMiles: l.loadedMiles,
    deadheadMiles: l.deadheadMiles,
    rateCents: l.rateCents,
    rpmLoaded: l.loadedMiles ? Math.round(l.rateCents / l.loadedMiles) / 100 : null,
    rpmAllIn: miles ? Math.round(l.rateCents / miles) / 100 : null,
    broker: l.broker ? { id: l.broker.id, companyName: l.broker.companyName } : null,
    notes: l.notes,
    pickupWindow: l.pickupWindowStart || l.pickupWindowEnd ? { start: l.pickupWindowStart ?? null, end: l.pickupWindowEnd ?? null, tz: l.pickupTz ?? null } : null,
    deliveryWindow: l.deliveryWindowStart || l.deliveryWindowEnd ? { start: l.deliveryWindowStart ?? null, end: l.deliveryWindowEnd ?? null, tz: l.deliveryTz ?? null } : null,
    pickupTz: l.pickupTz ?? null,
    deliveryTz: l.deliveryTz ?? null,
    freeTimeHours: l.freeTimeHours ?? 2,
    lastCheckCallAt: l.lastCheckCallAt ?? null,
    route: routeMeta(l),
  };
}

/** "available now / today / tomorrow" check in the server's clock (UI passes explicit cutoffs when needed). */
export function availableBy(truck, cutoff) {
  if (truck.truckStatus === 'maintenance' || truck.truckStatus === 'off_duty') return false;
  if (!truck.availableAt) return truck.truckStatus === 'available';
  return new Date(truck.availableAt) <= cutoff;
}
