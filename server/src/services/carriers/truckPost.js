import { formatAppointment } from '../email/render.js';
import { timezoneForState } from '../../lib/timezones.js';

/**
 * Truck availability posts and reload ideas: pure helpers (no database access) so they are easy to test.
 *
 * Merge fields for truck posts (passed to the email renderer as `extra`, so they work in any template):
 *   {{carrier_company}} {{carrier_mc}} {{carrier_dot}} {{equipment}} {{truck_location}} {{available_date}}
 *   {{preferred_lanes}} {{target_rate}} {{truck_details}}
 * The recipient fields ({{company}}, {{first_name}} ...) refer to the broker.
 */
export const TRUCK_FIELDS = [
  { key: 'equipment', label: 'Equipment' },
  { key: 'truck_location', label: 'Where the truck is empty' },
  { key: 'available_date', label: 'When it is available' },
  { key: 'preferred_lanes', label: 'Preferred lanes' },
  { key: 'target_rate', label: 'Target rate per mile' },
  { key: 'truck_details', label: 'Trailer, weight and endorsements' },
  { key: 'carrier_company', label: 'Carrier name' },
  { key: 'carrier_mc', label: 'Carrier MC' },
  { key: 'carrier_dot', label: 'Carrier USDOT' },
];

const EQUIPMENT_LABELS = {
  dry_van: 'Dry van', reefer: 'Reefer', flatbed: 'Flatbed', step_deck: 'Step deck', power_only: 'Power only', hotshot: 'Hotshot',
  box_truck: 'Box truck', tanker: 'Tanker', car_hauler: 'Car hauler', conestoga: 'Conestoga', lowboy: 'Lowboy', other: 'Other',
};
export const equipmentText = (eq) => String(eq || '').split(',').map((s) => s.trim()).filter(Boolean)
  .map((k) => EQUIPMENT_LABELS[k] || k.replace(/_/g, ' ')).join(', ');

const place = (city, state) => [city, state].filter(Boolean).join(', ');
const usd2 = (n) => `$${Number(n).toFixed(2)}`;

/** "TX to GA, Dallas, TX to Atlanta" from customer lanes (at most 5). */
export function lanesText(lanes = []) {
  return lanes.slice(0, 5).map((l) => `${String(l.origin || '').trim()} to ${String(l.destination || '').trim()}`).filter((s) => s.length > 4).join('; ');
}

/** "53 ft, max 44,000 lbs, hazmat, TWIC, team drivers" from a customer's rules. */
export function detailsText(customer) {
  if (!customer) return '';
  const parts = [];
  if (customer.trailerLengthFt) parts.push(`${customer.trailerLengthFt} ft trailer`);
  if (customer.maxWeightLbs) parts.push(`max ${Number(customer.maxWeightLbs).toLocaleString('en-US')} lbs`);
  if (customer.hazmat) parts.push('hazmat');
  if (customer.twic) parts.push('TWIC');
  if (customer.teamDrivers) parts.push('team drivers');
  return parts.join(', ');
}

/** Where the truck is: its last known location, else its home base. */
export function truckPlace(carrier) {
  return carrier.locationState ? place(carrier.locationCity, carrier.locationState) : place(carrier.city, carrier.state);
}

/**
 * Merge values for one truck. `overrides` (from the post form) win over stored data:
 * { location, availableAt, lanes, rate, details }. Values that are unknown are left out, so templates show the token.
 */
export function truckValues(carrier, overrides = {}, { now = new Date(), userTz } = {}) {
  const customer = carrier.customer || null;
  const v = {};
  const set = (k, val) => { const s = val == null ? '' : String(val).trim(); if (s) v[k] = s.slice(0, 300); };
  set('carrier_company', carrier.companyName);
  set('carrier_mc', carrier.mcNumber);
  set('carrier_dot', carrier.dotNumber);
  set('equipment', overrides.equipment || equipmentText(carrier.equipment));
  set('truck_location', overrides.location || truckPlace(carrier));
  const at = overrides.availableAt ? new Date(overrides.availableAt) : carrier.availableAt ? new Date(carrier.availableAt) : null;
  if (at && !Number.isNaN(at.getTime()) && at > now) {
    const tz = carrier.locationState ? timezoneForState(carrier.locationState) : carrier.timezone || timezoneForState(carrier.state) || userTz;
    set('available_date', formatAppointment(at, null, null, tz));
  } else if (at || carrier.truckStatus === 'available') {
    set('available_date', 'now');
  }
  set('preferred_lanes', overrides.lanes || lanesText(customer?.lanes || []));
  set('target_rate', overrides.rate || (customer?.minRatePerMile ? `${usd2(customer.minRatePerMile)}/mi` : ''));
  set('truck_details', overrides.details || detailsText(customer));
  return v;
}

/**
 * A ready-to-send default that only mentions what is known about the truck (no empty lines or unfilled fields).
 * Recipient fields refer to the broker. {{signature}} is the sender's signature (or name).
 */
export function defaultTruckPost(values, user = {}) {
  const has = (k) => !!values[k];
  const subject = has('available_date')
    ? `Available ${values.available_date === 'now' ? 'now' : '{{available_date}}'}: {{equipment}} in {{truck_location}}`
    : 'Truck available: {{equipment}} in {{truck_location}}';
  const lines = [
    'Hi {{first_name}},',
    '',
    `I dispatch for {{carrier_company}}${has('carrier_mc') ? ' (MC {{carrier_mc}})' : ''}. We have a truck looking for a load out of {{truck_location}}.`,
    '',
    'Equipment: {{equipment}}',
    `Empty in: {{truck_location}}${has('available_date') ? ' (available {{available_date}})' : ''}`,
  ];
  if (has('preferred_lanes')) lines.push('Preferred lanes: {{preferred_lanes}}');
  if (has('target_rate')) lines.push('Target rate: {{target_rate}}');
  if (has('truck_details')) lines.push('Details: {{truck_details}}');
  lines.push('', `If you have freight that fits, reply to this email${user.phone ? ' or call me at {{my_phone}}' : ''}.`, '', 'Thanks,', '{{signature}}');
  const strip = (s) => (has('equipment') ? s : s.replace(/\{\{equipment\}\} in /g, 'Truck in ').replace(/^Equipment: \{\{equipment\}\}$/m, '').replace(/\n{3,}/g, '\n\n'));
  return { subject: strip(subject), body: strip(lines.join('\n')) };
}

const TOKEN = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;
/** Tokens still present after rendering (an email is never sent with these). */
export function leftoverTokens(...texts) {
  const out = new Set();
  for (const t of texts) for (const m of String(t || '').matchAll(TOKEN)) out.add(m[1]);
  return [...out];
}

const loadDate = (l) => l.pickupDate || l.createdAt;
const rpm = (rateCents, miles) => (miles > 0 && rateCents > 0 ? Math.round((rateCents / miles)) / 100 : null);

/**
 * Reload ideas from the workspace's own loads out of a state (newest first):
 * brokers that gave loads there (count, last date, last rate and RPM, average RPM, top destinations, city matches)
 * and the user's own lanes from that state (by destination).
 */
export function summarizeReloads(loads, { city, equipment } = {}) {
  const wantCity = String(city || '').trim().toLowerCase();
  const kinds = String(equipment || '').split(',').map((s) => s.trim()).filter(Boolean);
  const fits = (l) => !kinds.length || !l.equipment || kinds.includes(l.equipment);
  const brokers = new Map();
  const lanes = new Map();
  for (const l of loads) {
    if (!fits(l)) continue;
    const at = loadDate(l);
    const lane = lanes.get(l.destState) || { destState: l.destState, loads: 0, rateCents: 0, miles: 0, lastAt: null, cities: new Map() };
    lane.loads++;
    if (l.rateCents > 0 && l.loadedMiles > 0) { lane.rateCents += l.rateCents; lane.miles += l.loadedMiles; }
    if (!lane.lastAt || at > lane.lastAt) lane.lastAt = at;
    if (l.destCity) lane.cities.set(l.destCity, (lane.cities.get(l.destCity) || 0) + 1);
    lanes.set(l.destState, lane);
    if (!l.brokerId || !l.broker) continue;
    const b = brokers.get(l.brokerId) || {
      broker: l.broker, loads: 0, cityLoads: 0, lastAt: null, lastRateCents: null, lastMiles: null, rateCents: 0, miles: 0, dest: new Map(),
    };
    b.loads++;
    if (wantCity && String(l.originCity || '').trim().toLowerCase() === wantCity) b.cityLoads++;
    if (!b.lastAt || at > b.lastAt) { b.lastAt = at; b.lastRateCents = l.rateCents; b.lastMiles = l.loadedMiles; }
    if (l.rateCents > 0 && l.loadedMiles > 0) { b.rateCents += l.rateCents; b.miles += l.loadedMiles; }
    b.dest.set(l.destState, (b.dest.get(l.destState) || 0) + 1);
    brokers.set(l.brokerId, b);
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  return {
    brokers: [...brokers.values()]
      .sort((a, b) => (b.cityLoads > 0) - (a.cityLoads > 0) || b.lastAt - a.lastAt || b.loads - a.loads)
      .map((b) => ({
        broker: b.broker, loads: b.loads, cityLoads: b.cityLoads, lastLoadAt: b.lastAt,
        lastRateCents: b.lastRateCents, lastRpm: rpm(b.lastRateCents, b.lastMiles), avgRpm: rpm(b.rateCents, b.miles),
        topDestinations: top(b.dest, 3),
      })),
    lanes: [...lanes.values()]
      .sort((a, b) => b.loads - a.loads || b.lastAt - a.lastAt)
      .map((l) => ({ destState: l.destState, loads: l.loads, avgRpm: rpm(l.rateCents, l.miles), lastLoadAt: l.lastAt, topCities: top(l.cities, 3) })),
  };
}
