import { haversineMiles, ROAD_FACTOR, locate, STATES, CITIES } from '../market/geo.js';

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
  };
}

/** "available now / today / tomorrow" check in the server's clock (UI passes explicit cutoffs when needed). */
export function availableBy(truck, cutoff) {
  if (truck.truckStatus === 'maintenance' || truck.truckStatus === 'off_duty') return false;
  if (!truck.availableAt) return truck.truckStatus === 'available';
  return new Date(truck.availableAt) <= cutoff;
}
