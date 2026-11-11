import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { parse, z, reqStr, optStr, optInt, optNum, optDate, pageQuery, paginate, pageResult, clean } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { loadCarrier, loadOwned, ownerWhere, readableOwnerIds } from '../lib/access.js';
import { LOAD_STATUSES, EQUIPMENT } from '../lib/constants.js';
import { logActivity } from '../lib/activity.js';
import { calculateLoad, withCalc } from '../services/loads/rateCalc.js';
import { parseLoadText } from '../services/loads/parser.js';
import { facilityTimezone, validTimezone } from '../services/loads/facilityTz.js';
import { fitColumns, fitView } from '../services/loads/fitCheck.js';
import { cachedLanes, laneStats, bumpLanes } from '../services/loads/lanes.js';
import { assertTransition, afterStatusChange } from '../services/loads/status.js';
import { detentionSummary } from '../services/loads/detention.js';
import { zonedTimeToUtc, DEFAULT_TZ } from '../lib/timezones.js';
import { invalidateToday } from '../services/fleet/today.js';
import { scheduleLoadRoute } from '../services/fleet/route.js';
import { ACTIVE_TRIP_STATUSES } from '../services/fleet/index.js';
import { recordLoadEvent, loadEvents } from '../services/fleet/events.js';
import { cachedVetting, knownContacts, parseJson, vettingView } from '../services/brokers/vetting.js';
import { computeFlags, topLevel } from '../services/brokers/flags.js';
import { normMc } from '../services/carriers/normalize.js';

const r = Router();
r.use(requirePermission('crm.use'));

const state = z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z]{2}$/, 'Use a 2-letter state code'));
const zeroIfNull = (schema) => schema.transform((v) => (v === null ? 0 : v));
const tz = z.preprocess((v) => (v === '' ? null : v), z.string().max(60).refine(validTimezone, 'Unknown time zone').nullable().optional());
/**
 * Appointment times: an ISO instant ("2026-11-12T14:00:00Z"), or a wall-clock time without an offset
 * ("2026-11-12T08:00"), which means facility-local time and is converted with the stop's time zone.
 */
const LOCAL_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const windowTime = z.preprocess((v) => (v === '' ? null : v), z.union([z.string().regex(LOCAL_DT), z.coerce.date()]).nullable().optional());
const WINDOW_KEYS = { pickupWindowStart: 'pickupTz', pickupWindowEnd: 'pickupTz', deliveryWindowStart: 'deliveryTz', deliveryWindowEnd: 'deliveryTz' };

function localToUtc(value, zone) {
  if (typeof value !== 'string') return value;
  const [d, t] = value.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  const out = zonedTimeToUtc(zone || DEFAULT_TZ, y, m, day, hh, mm, 0);
  if (Number.isNaN(out.getTime())) throw badRequest('Invalid appointment time');
  return out;
}

const calcFields = {
  rateCents: z.coerce.number().int().min(0).max(1e9),
  loadedMiles: z.coerce.number().int().min(1, 'Loaded miles must be at least 1').max(20000),
  deadheadMiles: zeroIfNull(optInt(0, 5000)),
  detentionHours: zeroIfNull(optNum(0, 500)),
  detentionRateCents: zeroIfNull(optInt(0, 1e6)),
  fuelPricePerGallon: optNum(0, 20),
  mpg: optNum(1, 30),
  otherCostsCents: zeroIfNull(optInt(0, 1e8)),
  dispatchFeePercent: optNum(0, 100),
};

const loadFields = {
  ...calcFields,
  referenceNumber: optStr(60),
  originCity: reqStr(100),
  originState: state,
  destCity: reqStr(100),
  destState: state,
  pickupDate: optDate,
  deliveryDate: optDate,
  pickupWindowStart: windowTime,
  pickupWindowEnd: windowTime,
  deliveryWindowStart: windowTime,
  deliveryWindowEnd: windowTime,
  pickupTz: tz,
  deliveryTz: tz,
  pickupFacility: optStr(120),
  pickupAddress: optStr(200),
  deliveryFacility: optStr(120),
  deliveryAddress: optStr(200),
  freeTimeHours: optNum(0, 48).transform((v) => (v === null ? 2 : v)),
  tonuCents: zeroIfNull(optInt(0, 1e7)),
  equipment: z.preprocess((v) => (v === '' ? null : v), z.enum(EQUIPMENT).nullable().optional()),
  commodity: optStr(120),
  weightLbs: optInt(0, 200000),
  status: z.enum(LOAD_STATUSES).optional(),
  notes: optStr(5000),
  brokerId: optStr(40),
  carrierId: optStr(40),
};

const include = {
  broker: { select: { id: true, companyName: true, phone: true, email: true, mcNumber: true, flags: true } },
  // phone / doNotCall / state / timezone: the load page's "Text carrier" action opens the messaging app with this
  // number and shows the do-not-call block without another request.
  carrier: { select: { id: true, companyName: true, mcNumber: true, phone: true, doNotCall: true, state: true, timezone: true } },
};

// The stored road polyline is not read for API views (it sits in overflow pages and the client never uses it here).
const NO_GEOMETRY = { routeGeometry: true };

const DOC_BADGES = ['rate_confirmation', 'bol', 'pod'];
const loadLabel = (l) => l.referenceNumber || `${l.originCity} → ${l.destCity}`;

/** API shape of a load: economics, stored fit warnings and the broker's flag level (no raw flag JSON). */
function view(l) {
  const out = withCalc(l);
  out.fit = fitView(l);
  delete out.fitWarnings;
  if (l.broker) {
    const flags = parseJson(l.broker.flags, []);
    const { flags: _f, ...broker } = l.broker;
    out.broker = { ...broker, flagLevel: Array.isArray(flags) && flags.some((f) => f.level === 'red') ? 'red' : Array.isArray(flags) && flags.some((f) => f.level === 'amber') ? 'amber' : null };
  }
  return out;
}

/** After a load write: fresh lane figures here, and the Today board drops its cached copy in every process. */
function changed(ownerId, user) {
  bumpLanes(ownerId);
  invalidateToday(ownerId, user.id);
}

/** Validate that referenced broker / carrier belong to the user (or are writable through the team). */
async function checkRefs(user, body) {
  if (body.brokerId) await loadOwned('broker', user, body.brokerId);
  if (body.carrierId) await loadCarrier(user, body.carrierId);
}

function checkDates(body) {
  if (body.pickupDate && body.deliveryDate && body.deliveryDate < body.pickupDate) throw badRequest('Delivery date cannot be before pickup date');
  for (const k of ['pickup', 'delivery']) {
    const s = body[`${k}WindowStart`];
    const e = body[`${k}WindowEnd`];
    if (s && e && e < s) throw badRequest(`The ${k} appointment window ends before it starts`);
  }
}

/** Facility time zones from city/state when the client did not send one (offline, split-state aware). */
function withZones(data, existing = {}) {
  const merged = { ...existing, ...data };
  const out = { ...data };
  const originMoved = data.originCity !== undefined || data.originState !== undefined;
  const destMoved = data.destCity !== undefined || data.destState !== undefined;
  if (data.pickupTz === undefined || data.pickupTz === null) {
    if (!existing.pickupTz || originMoved || data.pickupTz === null) out.pickupTz = facilityTimezone(merged.originCity, merged.originState);
  }
  if (data.deliveryTz === undefined || data.deliveryTz === null) {
    if (!existing.deliveryTz || destMoved || data.deliveryTz === null) out.deliveryTz = facilityTimezone(merged.destCity, merged.destState);
  }
  return out;
}

r.post('/calculate', ah(async (req, res) => {
  const body = parse(z.object({ ...calcFields, loadedMiles: z.coerce.number().int().min(0).max(20000) }), req.body);
  res.json({ calc: calculateLoad(body) });
}));

/**
 * Parse pasted or PDF-extracted rate-con text. Also matches the broker by MC in this workspace and returns any
 * vetting already known (the stored check on the broker, or this server's FMCSA cache). It never waits on FMCSA:
 * when nothing is known yet, `vetting` is { pending: true } and the client asks GET /api/brokers/verify.
 */
r.post('/parse', ah(async (req, res) => {
  const { text } = parse(z.object({ text: z.string().min(5, 'Paste some load details first').max(20000) }), req.body);
  const result = parseLoadText(text);
  const mc = normMc(result.fields.brokerMc);
  let brokerMatch = null;
  let vetting = null;
  if (mc) {
    const where = { ...(await ownerWhere(req.user, 'team')), mcNumber: mc };
    const b = await prisma.broker.findFirst({ where, orderBy: { updatedAt: 'desc' } });
    const rateCon = { phone: result.fields.brokerPhone, email: result.fields.brokerEmail };
    if (b) brokerMatch = { id: b.id, companyName: b.companyName, mcNumber: b.mcNumber, phone: b.phone, email: b.email, ...vettingView(b) };
    vetting = cachedVetting({ mc, rateCon, known: knownContacts(b), previous: parseJson(b?.fmcsaSnapshot, null) });
    // A saved broker checked in the last day: compare the rate con with that stored snapshot.
    const stored = parseJson(b?.fmcsaSnapshot, null);
    if (!vetting && stored?.checkedAt && Date.now() - new Date(stored.checkedAt).getTime() < 86_400_000) {
      const flags = computeFlags(stored, { rateCon, known: knownContacts(b) });
      vetting = { snapshot: stored, flags, level: topLevel(flags) };
    }
    if (!vetting) vetting = { pending: true };
  }
  res.json({ ...result, broker: { mc, match: brokerMatch }, vetting });
}));

/** Lane history: one bounded aggregate over the last 365 days, cached 5 minutes. */
r.get('/lanes', ah(async (req, res) => {
  const q = parse(z.object({ scope: z.enum(['mine', 'team']).default('mine'), originState: z.string().max(2).optional(), destState: z.string().max(2).optional() }), req.query);
  const ids = await readableOwnerIds(req.user, q.scope);
  const items = await cachedLanes(ids, { originState: q.originState?.toUpperCase(), destState: q.destState?.toUpperCase(), days: 365 });
  res.json({ items, days: 365, note: 'Lane history is computed only from loads recorded in this workspace in the last 12 months, not market rates.' });
}));

/** Facility time zone for a city and state (offline lookup, split states included); used by the load form. */
r.get('/facility-tz', ah(async (req, res) => {
  const q = parse(z.object({ city: z.string().trim().max(100).optional(), state }), req.query);
  res.json({ timezone: facilityTimezone(q.city, q.state) });
}));

/** Lane context for the load check card: last 90 days on one state pair, with the sample size. */
r.get('/lane-stats', ah(async (req, res) => {
  const q = parse(z.object({ scope: z.enum(['mine', 'team']).default('team'), originState: state, destState: state }), req.query);
  const ids = await readableOwnerIds(req.user, q.scope);
  res.json({ stats: await laneStats(ids, q.originState, q.destState, { days: 90 }), note: 'From your own loads only. Not a market rate.' });
}));

const listQuery = z.object({
  ...pageQuery,
  status: z.enum([...LOAD_STATUSES, 'active', 'all']).default('all'),
  brokerId: z.string().optional(),
  carrierId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  originState: z.string().max(2).optional(),
  destState: z.string().max(2).optional(),
  q: z.string().trim().max(100).optional(),
  missing: z.enum(['rate_confirmation', 'pod']).optional(),
  scope: z.enum(['mine', 'team']).default('mine'),
  sort: z.enum(['pickup', 'created', 'rate', 'rpm']).default('pickup'),
});
const ACTIVE = ['planned', 'booked', 'in_transit'];
const endOfDay = (d) => new Date(d.getTime() + 86399999);

/** Page of load ids ordered by rate per loaded mile, in SQL (so the order holds across pages). */
async function rpmPageIds(ownerIds, q) {
  const where = [Prisma.sql`ownerId IN (${Prisma.join(ownerIds)})`];
  if (q.status === 'active') where.push(Prisma.sql`status IN (${Prisma.join(ACTIVE)})`);
  else if (q.status !== 'all') where.push(Prisma.sql`status = ${q.status}`);
  if (q.brokerId) where.push(Prisma.sql`brokerId = ${q.brokerId}`);
  if (q.carrierId) where.push(Prisma.sql`carrierId = ${q.carrierId}`);
  if (q.from) where.push(Prisma.sql`pickupDate >= ${q.from}`);
  if (q.to) where.push(Prisma.sql`pickupDate <= ${endOfDay(q.to)}`);
  if (q.originState) where.push(Prisma.sql`originState = ${q.originState.toUpperCase()}`);
  if (q.destState) where.push(Prisma.sql`destState = ${q.destState.toUpperCase()}`);
  if (q.q) {
    const pat = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(Prisma.sql`(referenceNumber LIKE ${pat} ESCAPE '\\' OR commodity LIKE ${pat} ESCAPE '\\' OR originCity LIKE ${pat} ESCAPE '\\' OR destCity LIKE ${pat} ESCAPE '\\')`);
  }
  if (q.missing) where.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM Document d WHERE d.loadId = Load.id AND d.type = ${q.missing})`);
  const { skip, take } = paginate(q);
  const rows = await prisma.$queryRaw`
    SELECT id FROM Load WHERE ${Prisma.join(where, ' AND ')}
    ORDER BY (CASE WHEN loadedMiles > 0 THEN rateCents * 1.0 / loadedMiles END) DESC NULLS LAST, createdAt DESC
    LIMIT ${take} OFFSET ${skip}`;
  return rows.map((row) => row.id);
}

/** Which paperwork each load on the page has: one groupBy over the page's ids. */
async function docBadges(ids) {
  if (!ids.length) return new Map();
  const rows = await prisma.document.groupBy({ by: ['loadId', 'type'], where: { loadId: { in: ids }, type: { in: DOC_BADGES } }, _count: { _all: true } });
  const out = new Map();
  for (const row of rows) {
    const cur = out.get(row.loadId) || {};
    cur[row.type] = row._count._all;
    out.set(row.loadId, cur);
  }
  return out;
}

r.get('/', ah(async (req, res) => {
  const q = parse(listQuery, req.query);
  const where = { ...(await ownerWhere(req.user, q.scope)) };
  if (q.status === 'active') where.status = { in: ACTIVE };
  else if (q.status !== 'all') where.status = q.status;
  if (q.brokerId) where.brokerId = q.brokerId;
  if (q.carrierId) where.carrierId = q.carrierId;
  if (q.from || q.to) where.pickupDate = { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: endOfDay(q.to) } : {}) };
  if (q.originState) where.originState = q.originState.toUpperCase();
  if (q.destState) where.destState = q.destState.toUpperCase();
  if (q.q) where.OR = [{ referenceNumber: { contains: q.q } }, { commodity: { contains: q.q } }, { originCity: { contains: q.q } }, { destCity: { contains: q.q } }];
  if (q.missing) where.documents = { none: { type: q.missing } };

  let rows;
  if (q.sort === 'rpm') {
    const ids = await rpmPageIds(await readableOwnerIds(req.user, q.scope), q);
    const found = ids.length ? await prisma.load.findMany({ where: { id: { in: ids } }, include, omit: NO_GEOMETRY }) : [];
    const byId = new Map(found.map((l) => [l.id, l]));
    rows = ids.map((id) => byId.get(id)).filter(Boolean);
  } else {
    const orderBy = { pickup: [{ pickupDate: 'desc' }, { createdAt: 'desc' }], created: [{ createdAt: 'desc' }], rate: [{ rateCents: 'desc' }] }[q.sort];
    rows = await prisma.load.findMany({ where, orderBy, ...paginate(q), include, omit: NO_GEOMETRY });
  }
  const [total, agg, badges] = await Promise.all([
    prisma.load.count({ where }),
    prisma.load.aggregate({ where: { ...where, ...(q.status === 'all' ? { status: { not: 'canceled' } } : {}) }, _sum: { rateCents: true, loadedMiles: true, deadheadMiles: true }, _count: true }),
    docBadges(rows.map((l) => l.id)),
  ]);
  const items = rows.map((l) => {
    const counts = badges.get(l.id) || {};
    return { ...view(l), docs: { rateCon: !!counts.rate_confirmation, bol: !!counts.bol, pod: !!counts.pod } };
  });
  const miles = agg._sum.loadedMiles || 0;
  res.json({
    ...pageResult(items, total, q),
    summary: {
      loads: agg._count, rateCents: agg._sum.rateCents || 0, loadedMiles: miles, deadheadMiles: agg._sum.deadheadMiles || 0,
      avgRatePerMile: miles ? Math.round(((agg._sum.rateCents || 0) / 100 / miles) * 100) / 100 : null,
    },
  });
}));

r.get('/:id', ah(async (req, res) => {
  const load = await loadOwned('load', req.user, req.params.id);
  const [full, events, invoices] = await Promise.all([
    prisma.load.findUnique({
      where: { id: load.id },
      include: { ...include, documents: { orderBy: { createdAt: 'desc' }, select: { id: true, type: true, originalName: true, sizeBytes: true, createdAt: true, source: true } } },
      omit: NO_GEOMETRY,
    }),
    loadEvents(load.id, { take: 300 }),
    prisma.invoice.findMany({
      where: { loadId: load.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, number: true, kind: true, status: true, amountCents: true, paidCents: true, dueAt: true, billToName: true },
    }),
  ]);
  const ackBy = full.fitAckById ? await prisma.user.findUnique({ where: { id: full.fitAckById }, select: { name: true } }) : null;
  const out = view(full);
  out.fit.acknowledgedBy = ackBy?.name ?? null;
  res.json({
    load: out,
    events: events.map((e) => ({ ...e, data: parseJson(e.data, null) })),
    detention: detentionSummary(full, events),
    invoices,
  });
}));

/**
 * Columns derived on every save: facility time zones, appointment times converted from facility-local wall time,
 * the date checks, and the carrier-rules check (stored warnings; never blocks).
 */
async function derived(data, existing, user) {
  const zoned = withZones(data, existing || {});
  for (const [key, zoneKey] of Object.entries(WINDOW_KEYS)) {
    if (typeof zoned[key] === 'string') zoned[key] = localToUtc(zoned[key], zoned[zoneKey] ?? existing?.[zoneKey] ?? user.timezone);
  }
  const merged = { ...(existing || {}), ...zoned };
  checkDates(merged);
  return { ...zoned, ...(await fitColumns(merged, existing)) };
}

const ROUTE_KEYS = ['originCity', 'originState', 'originLat', 'originLng', 'destCity', 'destState', 'destLat', 'destLng'];
const sameText = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/**
 * This page edits stops by city and state only. When one moves, drop the exact coordinates picked on the fleet map
 * (they still point at the old place and would win over the new city), so the map, ETAs and the road route follow the
 * new city.
 */
function dropMovedCoordinates(data, existing) {
  const out = { ...data };
  for (const p of ['origin', 'dest']) {
    const city = data[`${p}City`];
    const st = data[`${p}State`];
    const moved = (city !== undefined && !sameText(city, existing[`${p}City`])) || (st !== undefined && st !== existing[`${p}State`]);
    if (moved && (existing[`${p}Lat`] != null || existing[`${p}Lng`] != null)) {
      out[`${p}Lat`] = null;
      out[`${p}Lng`] = null;
    }
  }
  return out;
}

/**
 * After a save: an active load whose pickup or delivery is new or moved gets its road route computed in the
 * background (bounded queue; the fleet-routes job catches anything missed), and a carrier with an active load is a
 * truck on the fleet map (Carrier.isFleet drives the indexed fleet query).
 */
async function afterLoadSave(load, existing = null) {
  const active = ACTIVE_TRIP_STATUSES.includes(load.status);
  if (active && (!existing || ROUTE_KEYS.some((k) => (existing[k] ?? null) !== (load[k] ?? null)))) scheduleLoadRoute(load);
  if (active && load.carrierId && (!existing || existing.carrierId !== load.carrierId || !ACTIVE_TRIP_STATUSES.includes(existing.status))) {
    await prisma.carrier.updateMany({ where: { id: load.carrierId, isFleet: false }, data: { isFleet: true } });
  }
}

r.post('/', ah(async (req, res) => {
  const body = parse(z.object(loadFields), req.body);
  await checkRefs(req.user, body);
  const data = await derived(clean(body), null, req.user);
  const load = await prisma.load.create({ data: { ...data, ownerId: req.user.id }, include });
  changed(req.user.id, req.user);
  await afterLoadSave(load);
  await logActivity(req.user, {
    type: 'load', carrierId: load.carrierId,
    summary: `Added load ${load.originCity}, ${load.originState} → ${load.destCity}, ${load.destState} at $${(load.rateCents / 100).toLocaleString('en-US')}`,
  });
  res.status(201).json({ load: view(load) });
}));

r.patch('/:id', ah(async (req, res) => {
  const existing = await loadOwned('load', req.user, req.params.id, { write: true });
  const { force, ...raw } = req.body || {};
  const body = parse(z.object(loadFields).partial(), raw);
  await checkRefs(req.user, body);
  const statusChange = body.status && body.status !== existing.status;
  if (statusChange) assertTransition(existing.status, body.status, { force: force === true });
  const data = dropMovedCoordinates(await derived(clean(body), existing, req.user), existing);
  const load = await prisma.load.update({ where: { id: existing.id }, data, include });
  changed(existing.ownerId, req.user);
  await afterLoadSave(load, existing);
  let after = {};
  if (statusChange) after = await afterStatusChange(req.user, existing, load);
  res.json({ load: view(load), ...after });
}));

/** Status change with the same side effects as the fleet board (truck position, timeline, paperwork check). */
r.post('/:id/status', ah(async (req, res) => {
  const existing = await loadOwned('load', req.user, req.params.id, { write: true });
  const body = parse(z.object({ status: z.enum(LOAD_STATUSES), force: z.boolean().optional() }), req.body);
  const check = assertTransition(existing.status, body.status, { force: body.force === true });
  if (check.noop) return res.json({ load: view(await prisma.load.findUnique({ where: { id: existing.id }, include })), truck: null, paperwork: { missing: [] } });
  const load = await prisma.load.update({ where: { id: existing.id }, data: { status: body.status }, include });
  changed(existing.ownerId, req.user);
  await afterLoadSave(load, existing);
  const after = await afterStatusChange(req.user, existing, load);
  res.json({ load: view(load), ...after });
}));

/** Acknowledge the current carrier-rules warnings (they never block; this records who saw them). */
r.post('/:id/fit-ack', ah(async (req, res) => {
  const existing = await loadOwned('load', req.user, req.params.id, { write: true });
  if (!existing.fitWarnings) throw badRequest('This load has no carrier-rules warnings to acknowledge');
  const load = await prisma.load.update({ where: { id: existing.id }, data: { fitAckAt: new Date(), fitAckById: req.user.id }, include });
  const out = view(load);
  out.fit.acknowledgedBy = req.user.name;
  res.json({ load: out });
}));

const DISPATCHER_EVENTS = ['arrived_pickup', 'loaded', 'departed_pickup', 'arrived_delivery', 'delivered', 'check_call', 'issue', 'note'];
const EVENT_LABEL = {
  arrived_pickup: 'Arrived at pickup', loaded: 'Loaded', departed_pickup: 'Departed pickup', arrived_delivery: 'Arrived at delivery',
  delivered: 'Departed delivery (unloaded)', check_call: 'Check call', issue: 'Issue', note: 'Note',
};

/** Record a stop time or check call from the dispatcher (driver check-ins arrive from the driver link). */
r.post('/:id/events', ah(async (req, res) => {
  const load = await loadOwned('load', req.user, req.params.id, { write: true });
  const now = Date.now();
  const body = parse(z.object({
    type: z.enum(DISPATCHER_EVENTS),
    at: z.coerce.date().optional().refine((d) => !d || (d.getTime() <= now + 60 * 60_000 && d.getTime() >= now - 60 * 86_400_000), 'Pick a time within the last 60 days'),
    note: optStr(1000),
  }), req.body);
  const event = await recordLoadEvent({ loadId: load.id, ownerId: load.ownerId, type: body.type, at: body.at || new Date(), note: body.note || null, source: 'dispatcher', data: { by: req.user.id } });
  if (body.type === 'check_call') await prisma.load.update({ where: { id: load.id }, data: { lastCheckCallAt: event.at } });
  await logActivity(req.user, { type: 'load', carrierId: load.carrierId, summary: `${EVENT_LABEL[body.type]} · load ${loadLabel(load)}` });
  invalidateToday(load.ownerId, req.user.id);
  const events = await loadEvents(load.id, { take: 300 });
  res.status(201).json({ event, detention: detentionSummary(load, events) });
}));

/** Remove a time the dispatcher entered by mistake. Driver check-ins and system events stay as evidence. */
r.delete('/:id/events/:eventId', ah(async (req, res) => {
  const load = await loadOwned('load', req.user, req.params.id, { write: true });
  const event = await prisma.loadEvent.findFirst({ where: { id: String(req.params.eventId), loadId: load.id } });
  if (!event) throw notFound('Event not found');
  if (event.source !== 'dispatcher' || !DISPATCHER_EVENTS.includes(event.type)) throw badRequest('Only times you entered can be removed');
  await prisma.loadEvent.delete({ where: { id: event.id } });
  invalidateToday(load.ownerId, req.user.id);
  const events = await loadEvents(load.id, { take: 300 });
  res.json({ ok: true, detention: detentionSummary(load, events) });
}));

/** Fill Load.detentionHours (and optionally the rate) from the recorded stop times. */
r.post('/:id/detention/apply', ah(async (req, res) => {
  const existing = await loadOwned('load', req.user, req.params.id, { write: true });
  const body = parse(z.object({ detentionRateCents: optInt(0, 1e6), freeTimeHours: optNum(0, 48) }), req.body);
  const base = { ...existing, ...clean({ detentionRateCents: body.detentionRateCents ?? undefined, freeTimeHours: body.freeTimeHours ?? undefined }) };
  const events = await loadEvents(existing.id, { take: 300 });
  const det = detentionSummary(base, events);
  const load = await prisma.load.update({
    where: { id: existing.id },
    data: { detentionHours: det.billableHours, detentionRateCents: base.detentionRateCents, freeTimeHours: base.freeTimeHours },
    include,
  });
  await recordLoadEvent({
    loadId: load.id, ownerId: load.ownerId, type: 'note', source: 'dispatcher',
    note: `Detention set to ${det.billableHours} h from recorded stop times (${base.freeTimeHours} h free)`,
    data: { by: req.user.id, detention: { hours: det.billableHours, rateCents: base.detentionRateCents, amountCents: det.amountCents } },
  });
  invalidateToday(load.ownerId, req.user.id);
  res.json({ load: view(load), detention: det });
}));

/**
 * Record a truck-ordered-not-used: the TONU amount, an evidence note (who canceled, when the truck was dispatched,
 * what the broker said) and the cancellation. Documents (emails, screenshots) attach to the load as usual.
 */
r.post('/:id/tonu', ah(async (req, res) => {
  const existing = await loadOwned('load', req.user, req.params.id, { write: true });
  const body = parse(z.object({ tonuCents: z.coerce.number().int().min(0).max(1e7), note: optStr(2000), cancel: z.boolean().default(true) }), req.body);
  const data = { tonuCents: body.tonuCents };
  const cancel = body.cancel && existing.status !== 'canceled';
  if (cancel) {
    assertTransition(existing.status, 'canceled', { force: true });
    data.status = 'canceled';
  }
  const load = await prisma.load.update({ where: { id: existing.id }, data, include });
  await recordLoadEvent({
    loadId: load.id, ownerId: load.ownerId, type: 'note', source: 'dispatcher',
    note: `TONU $${(body.tonuCents / 100).toFixed(2)}${body.note ? `: ${body.note}` : ''}`,
    data: { by: req.user.id, tonu: { cents: body.tonuCents, note: body.note || null, statusBefore: existing.status } },
  });
  let after = {};
  if (cancel) after = await afterStatusChange(req.user, existing, load);
  changed(existing.ownerId, req.user);
  res.json({ load: view(load), ...after });
}));

r.delete('/:id', ah(async (req, res) => {
  const load = await loadOwned('load', req.user, req.params.id, { write: true });
  const docs = await prisma.document.findMany({ where: { loadId: load.id }, select: { storedName: true } });
  await prisma.load.delete({ where: { id: load.id } });
  changed(load.ownerId, req.user);
  const { removeFile } = await import('../middleware/upload.js');
  for (const d of docs) removeFile('documents', d.storedName);
  res.json({ ok: true });
}));

export default r;
