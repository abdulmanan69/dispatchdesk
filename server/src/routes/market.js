import { Router } from 'express';
import { prisma } from '../db.js';
import { ah, badRequest } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { STATES, locate, haversineMiles, ROAD_FACTOR, EIA_REGIONS, CITIES } from '../services/market/geo.js';
import { dieselRegions, dieselForState, carriersByState } from '../services/market/index.js';
import { geocode, route, weather, alertsForStates, holidays, truckTonnage, usdaTruckRates, sourceStatuses, USDA_PDF } from '../services/market/live.js';

const r = Router();
r.use(requirePermission('crm.use'));

const DAT_TRENDLINES = 'https://www.dat.com/trendlines';
const RATE_KEYS = ['van', 'reefer', 'flatbed'];
// Per-user rates the dispatcher typed in, stored in the existing key-value table (not exposed in admin settings).
const ratesKey = (userId) => `user.${userId}.spotRates`;

async function manualRates(userId) {
  const row = await prisma.systemSetting.findUnique({ where: { key: ratesKey(userId) } });
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}
const spotRates = (manual) => ({ available: false, manual, link: DAT_TRENDLINES });

async function myCarriersByState(userId) {
  const rows = await prisma.carrier.groupBy({ by: ['state'], where: { ownerId: userId, state: { not: null } }, _count: { _all: true } });
  return rows.map((x) => ({ state: x.state, count: x._count._all })).sort((a, b) => b.count - a.count);
}

r.get('/diesel', ah(async (req, res) => {
  const q = parse(z.object({ state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional() }), req.query);
  if (q.state && !STATES[q.state]) throw badRequest('Unknown state');
  res.json(await dieselForState(q.state));
}));

r.get('/summary', ah(async (req, res) => {
  const [d, carriers, mine, manual] = await Promise.all([dieselRegions(), carriersByState(), myCarriersByState(req.user.id), manualRates(req.user.id)]);
  const nat = d.regions.NUS;
  res.json({
    diesel: {
      configured: d.configured,
      national: nat ? { price: nat.price, change: nat.change, period: nat.period } : null,
      regions: Object.keys(EIA_REGIONS).filter((k) => k !== 'NUS' && d.regions[k]).map((k) => d.regions[k]),
      history: d.history || [],
      source: 'EIA', sourceUrl: 'https://www.eia.gov/petroleum/gasdiesel/', fetchedAt: d.fetchedAt || null,
      ...(d.error ? { error: d.error } : {}),
    },
    gasoline: {
      configured: d.configured,
      national: d.gasoline?.NUS ? { price: d.gasoline.NUS.price, change: d.gasoline.NUS.change, period: d.gasoline.NUS.period } : null,
      regions: Object.keys(EIA_REGIONS).filter((k) => k !== 'NUS' && d.gasoline?.[k]).map((k) => d.gasoline[k]),
      product: 'Regular gasoline', source: 'EIA', sourceUrl: 'https://www.eia.gov/petroleum/gasdiesel/',
    },
    carriersByState: carriers,
    mine,
    spotRates: spotRates(manual),
  });
}));

r.get('/spot-rates', ah(async (req, res) => {
  res.json(spotRates(await manualRates(req.user.id)));
}));

const rate = z.preprocess((v) => (v === '' || v === undefined ? null : v), z.coerce.number().min(0.3).max(20).nullable());
r.put('/spot-rates', ah(async (req, res) => {
  const body = parse(z.object({ van: rate, reefer: rate, flatbed: rate }), req.body);
  if (RATE_KEYS.every((k) => body[k] == null)) {
    await prisma.systemSetting.deleteMany({ where: { key: ratesKey(req.user.id) } });
    return res.json(spotRates(null));
  }
  const manual = { ...body, updatedAt: new Date().toISOString() };
  const value = JSON.stringify(manual);
  await prisma.systemSetting.upsert({
    where: { key: ratesKey(req.user.id) },
    create: { key: ratesKey(req.user.id), value, secret: false, updatedById: req.user.id },
    update: { value, updatedById: req.user.id },
  });
  res.json(spotRates(manual));
}));

r.get('/states', ah(async (req, res) => {
  res.json({
    items: Object.entries(STATES).map(([code, [name, lat, lon, region]]) => ({ code, name, lat, lon, region, regionLabel: EIA_REGIONS[region] })),
    cities: Object.keys(CITIES).map((k) => k.replace(/(^|\s)\S/g, (c) => c.toUpperCase()).replace(/, (\w+)$/, (m, st) => `, ${st.toUpperCase()}`)),
  });
}));

const stopSchema = z.union([z.string().trim().min(1).max(120), z.object({ place: z.string().trim().min(1).max(120) })]);
r.post('/trip', ah(async (req, res) => {
  const body = parse(z.object({
    stops: z.array(stopSchema).min(2, 'Add an origin and a destination').max(10),
    mpg: z.coerce.number().min(2).max(20).default(6.5),
    tankGallons: z.coerce.number().min(20).max(500).default(150),
    dieselPrice: z.coerce.number().min(0.5).max(20).nullable().optional(),
    miles: z.coerce.number().min(1).max(10000).nullable().optional(),
    equipment: z.enum(RATE_KEYS).default('van'),
    ratePerMile: z.coerce.number().min(0.3).max(20).nullable().optional(),
  }), req.body);
  const places = body.stops.map((s) => (typeof s === 'string' ? s : s.place));
  const points = places.map(locate);
  const states = points.map((p) => p?.state || null);
  const bad = places.filter((_, i) => !states[i]);
  if (bad.length) throw badRequest(`Could not find a US state in: ${bad.join(', ')}. Use "City, ST" or a state name.`);

  const legs = [];
  for (let i = 1; i < states.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const miles = Math.round(haversineMiles([a.lat, a.lon], [b.lat, b.lon]) * ROAD_FACTOR);
    legs.push({ from: places[i - 1], to: places[i], fromState: a.state, toState: b.state, miles, precision: a.precision === 'city' && b.precision === 'city' ? 'city' : 'state' });
  }
  const estimated = legs.reduce((s, l) => s + l.miles, 0);
  const miles = body.miles ?? estimated;

  let price = body.dieselPrice ?? null;
  let priceSource = price != null ? 'entered' : null;
  if (price == null) {
    const d = await dieselForState(states[0]);
    if (d.price != null) { price = d.price; priceSource = `EIA ${d.regionLabel}, week of ${d.period}`; }
  }
  const gallons = miles / body.mpg;
  const fuelCost = price != null ? Math.round(gallons * price * 100) / 100 : null;
  // Revenue side: a rate the user typed for this trip, else their saved weekly rate for the equipment.
  const manual = await manualRates(req.user.id);
  const ratePerMile = body.ratePerMile ?? manual?.[body.equipment] ?? null;
  const revenue = ratePerMile != null ? Math.round(miles * ratePerMile * 100) / 100 : null;
  res.json({
    stops: places.map((p, i) => ({ place: p, state: states[i], precision: points[i].precision, lat: points[i].lat, lon: points[i].lon })),
    legs,
    miles,
    estimatedMiles: estimated,
    estimate: body.miles == null,
    method: body.miles == null ? `Straight-line distance × ${ROAD_FACTOR} road factor, between city centers when the city is known, otherwise state centers. Enter real miles for an exact cost.` : 'Miles entered by you',
    mpg: body.mpg,
    tankGallons: body.tankGallons,
    gallons: Math.round(gallons * 10) / 10,
    dieselPrice: price,
    priceSource,
    fuelCost,
    equipment: body.equipment,
    ratePerMile,
    rateSource: body.ratePerMile != null ? 'entered' : ratePerMile != null ? `Your ${body.equipment} rate · ${manual.updatedAt.slice(0, 10)}` : null,
    revenue,
    afterFuel: revenue != null && fuelCost != null ? Math.round((revenue - fuelCost) * 100) / 100 : null,
    fuelShare: revenue && fuelCost != null ? Math.round((fuelCost / revenue) * 1000) / 1000 : null,
    fuelCostPerMile: price != null ? Math.round((price / body.mpg) * 1000) / 1000 : null,
    fuelStops: Math.max(0, Math.ceil(gallons / body.tankGallons) - 1),
  });
}));

// ---------------------------------------------------------------------------
// Free real-time data (see services/market/live.js for sources and caching)
// ---------------------------------------------------------------------------
const lat = z.coerce.number().min(-90).max(90);
const lng = z.coerce.number().min(-180).max(180);
const point = z.string().trim().regex(/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/, 'Use lat,lng').transform((v) => {
  const [a, b] = v.split(',').map(Number);
  return { lat: a, lng: b };
}).refine((p) => Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180, 'Coordinates out of range');

r.get('/geocode', ah(async (req, res) => {
  const q = parse(z.object({ q: z.string().trim().min(2, 'Type at least 2 characters').max(120) }), req.query);
  res.json(await geocode(q.q));
}));

r.get('/route', ah(async (req, res) => {
  const q = parse(z.object({ from: point, to: point }), req.query);
  res.json(await route(q.from, q.to));
}));

r.get('/weather', ah(async (req, res) => {
  const q = parse(z.object({ lat, lng }), req.query);
  res.json(await weather(q.lat, q.lng));
}));

r.get('/alerts', ah(async (req, res) => {
  const q = parse(z.object({ states: z.string().trim().max(200).optional() }), req.query);
  let states = (q.states || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  // Default: the states where this user's carriers are.
  if (!states.length) states = (await myCarriersByState(req.user.id)).map((x) => x.state).slice(0, 10);
  const bad = states.filter((x) => !STATES[x]);
  if (bad.length) throw badRequest(`Unknown state: ${bad.join(', ')}`);
  res.json(await alertsForStates(states));
}));

r.get('/holidays', ah(async (req, res) => {
  res.json(await holidays());
}));

r.get('/indicators', ah(async (req, res) => {
  const [tonnage, usda] = await Promise.all([truckTonnage(), usdaTruckRates()]);
  res.json({ truckTonnage: tonnage, usdaTruckRates: { ...usda, pdfUrl: USDA_PDF } });
}));

r.get('/sources', ah(async (req, res) => {
  res.json({ items: await sourceStatuses() });
}));

export default r;
