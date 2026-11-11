import { prisma } from '../../db.js';
import { z, optInt } from '../../lib/validate.js';
import { badRequest } from '../../lib/errors.js';
import { loadCarrier, loadOwned } from '../../lib/access.js';
import { DEFAULT_TZ, localDayKey, zonedTimeToUtc } from '../../lib/timezones.js';
import { loadFields } from '../../routes/loads.js';
import { facilityTimezone } from './facilityTz.js';
import { rulesForCarrier } from './fitCheck.js';
import { checkLoadFit } from './fit.js';
import { bumpLanes } from './lanes.js';
import { invalidateToday } from '../fleet/today.js';

/**
 * Load templates and recurring dedicated lanes.
 *
 * A template keeps the parts of a load that repeat (lane, facilities, money, equipment, carrier, broker) in
 * LoadTemplate.fields as JSON, validated with the same rules as a load. Appointment windows are facility-local times
 * of day ("08:00"), and transitDays says how many days after pickup the delivery is.
 *
 * A template with weekdays (0-6, Sun-Sat, in the pickup facility's time zone) and a pickupTime is a dedicated lane:
 * generateForTemplate() creates planned loads for every matching pickup day from today through today + leadDays.
 * LoadTemplate.generatedTo (local midnight of the first day not covered yet) moves forward in the same transaction
 * that creates the loads, guarded by its previous value, and a (templateId, pickup day) check skips days that already
 * have a load, so reruns, overlapping runs and edits never create duplicates.
 */

export const MAX_TEMPLATES = 100;
export const MAX_LEAD_DAYS = 30;
const DAY = 86_400_000;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

/** Load columns a template repeats. Reference numbers, dates, status and detention actuals are per load. */
export const TEMPLATE_LOAD_KEYS = [
  'originCity', 'originState', 'destCity', 'destState', 'pickupFacility', 'pickupAddress', 'deliveryFacility', 'deliveryAddress',
  'pickupTz', 'deliveryTz', 'freeTimeHours', 'equipment', 'commodity', 'weightLbs', 'loadedMiles', 'deadheadMiles', 'rateCents',
  'detentionRateCents', 'fuelPricePerGallon', 'mpg', 'otherCostsCents', 'dispatchFeePercent', 'notes',
];

const timeOfDay = z.preprocess((v) => (v === '' ? null : v), z.string().regex(HHMM, 'Use a 24-hour time like 08:00').nullable().optional());

/** Template fields: the load rules for the repeated columns, plus times of day for the windows. Unknown keys drop. */
export const templateFieldsSchema = z.object({
  ...pick(loadFields, TEMPLATE_LOAD_KEYS),
  pickupWindowStart: timeOfDay,
  pickupWindowEnd: timeOfDay,
  deliveryWindowStart: timeOfDay,
  deliveryWindowEnd: timeOfDay,
  transitDays: optInt(0, 14),
});

const weekdaysSchema = z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim() ? v.split(',').map((x) => x.trim()) : []) : v),
  z.array(z.coerce.number().int().min(0, 'Weekdays are 0 (Sunday) to 6 (Saturday)').max(6, 'Weekdays are 0 (Sunday) to 6 (Saturday)')).max(7).nullable().optional(),
);
const idField = z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(40).nullable().optional());

export const templateBodySchema = z.object({
  name: z.string().trim().min(1, 'Give the template a name').max(80),
  fields: templateFieldsSchema,
  carrierId: idField,
  brokerId: idField,
  weekdays: weekdaysSchema,
  pickupTime: timeOfDay,
  leadDays: z.coerce.number().int().min(1, 'Create loads at least 1 day ahead').max(MAX_LEAD_DAYS, `Create loads at most ${MAX_LEAD_DAYS} days ahead`).optional(),
  active: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Calendar helpers (plain YYYY-MM-DD days, so no host time zone is involved)
// ---------------------------------------------------------------------------

const ymdParts = (ymd) => ymd.split('-').map(Number);
export function addDaysYmd(ymd, n) {
  const [y, m, d] = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const weekdayOfYmd = (ymd) => {
  const [y, m, d] = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
/** UTC instant of `hhmm` on local day `ymd` in `tz`. */
export function localAt(tz, ymd, hhmm = '00:00') {
  const [y, m, d] = ymdParts(ymd);
  const [hh, mm] = hhmm.split(':').map(Number);
  return zonedTimeToUtc(tz, y, m, d, hh, mm, 0);
}

export function parseWeekdays(value) {
  if (!value) return [];
  return [...new Set(String(value).split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
}

export function parseFields(json) {
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Facility zones for a template's loads: the stored ones, else from city/state, else the owner's zone. */
export function templateZones(fields, ownerTz) {
  const fallback = ownerTz || DEFAULT_TZ;
  return {
    pickupTz: fields.pickupTz || facilityTimezone(fields.originCity, fields.originState) || fallback,
    deliveryTz: fields.deliveryTz || facilityTimezone(fields.destCity, fields.destState) || fallback,
  };
}

/**
 * Pickup days to create: local days (pickup zone) from the later of today and generatedTo through today + leadDays,
 * on the template's weekdays, whose pickup time is still ahead of `now`. `until` is the new generatedTo: local midnight
 * after the last day considered (never earlier than the current one).
 */
export function planDays({ weekdays, pickupTime, leadDays, tz, generatedTo, now }) {
  const today = localDayKey(tz, now);
  const last = addDaysYmd(today, Math.min(Math.max(1, leadDays || 1), MAX_LEAD_DAYS));
  let start = today;
  if (generatedTo) {
    const g = localDayKey(tz, new Date(generatedTo));
    if (g > start) start = g;
  }
  const days = [];
  if (weekdays.length && pickupTime) {
    for (let d = start; d <= last; d = addDaysYmd(d, 1)) {
      if (weekdays.includes(weekdayOfYmd(d)) && localAt(tz, d, pickupTime) > now) days.push(d);
    }
  }
  const until = localAt(tz, addDaysYmd(last, 1));
  return { days, until: generatedTo && new Date(generatedTo) > until ? new Date(generatedTo) : until };
}

/** Next `count` pickup instants of a dedicated lane after `now` (for "Next pickup" on the page). */
export function nextPickups({ weekdays, pickupTime, tz, now, count = 1 }) {
  const out = [];
  if (!weekdays.length || !pickupTime) return out;
  let d = localDayKey(tz, now);
  for (let i = 0; i < 15 && out.length < count; i += 1, d = addDaysYmd(d, 1)) {
    if (!weekdays.includes(weekdayOfYmd(d))) continue;
    const at = localAt(tz, d, pickupTime);
    if (at > now) out.push(at);
  }
  return out;
}

/** Times of a load made from template fields for pickup day `ymd`: windows in each facility's zone. */
export function loadTimes(fields, { ymd, pickupTime, pickupTz, deliveryTz }) {
  const start = pickupTime || fields.pickupWindowStart || null;
  const pickupWindowStart = start ? localAt(pickupTz, ymd, start) : null;
  let pickupWindowEnd = fields.pickupWindowEnd && pickupWindowStart ? localAt(pickupTz, ymd, fields.pickupWindowEnd) : null;
  if (pickupWindowEnd && pickupWindowEnd <= pickupWindowStart) pickupWindowEnd = localAt(pickupTz, addDaysYmd(ymd, 1), fields.pickupWindowEnd);
  const hasDelivery = fields.transitDays != null || !!fields.deliveryWindowStart;
  const dDay = addDaysYmd(ymd, fields.transitDays || 0);
  let deliveryWindowStart = fields.deliveryWindowStart ? localAt(deliveryTz, dDay, fields.deliveryWindowStart) : null;
  let deliveryWindowEnd = deliveryWindowStart && fields.deliveryWindowEnd ? localAt(deliveryTz, dDay, fields.deliveryWindowEnd) : null;
  if (deliveryWindowEnd && deliveryWindowEnd <= deliveryWindowStart) deliveryWindowEnd = localAt(deliveryTz, addDaysYmd(dDay, 1), fields.deliveryWindowEnd);
  // A delivery window that would start before the pickup (same day, earlier hour) is left for the dispatcher to set.
  if (deliveryWindowStart && pickupWindowStart && deliveryWindowStart < pickupWindowStart) {
    deliveryWindowStart = null;
    deliveryWindowEnd = null;
  }
  // Dates are noon at the facility, so they read as the same day in every US zone.
  const pickupDate = localAt(pickupTz, ymd, '12:00');
  let deliveryDate = hasDelivery ? localAt(deliveryTz, dDay, '12:00') : null;
  if (deliveryDate && deliveryDate < pickupDate) deliveryDate = pickupDate;
  return { pickupDate, deliveryDate, pickupWindowStart, pickupWindowEnd, deliveryWindowStart, deliveryWindowEnd };
}

/** Prisma data for one generated load. */
export function buildLoad(template, fields, ymd, zones, refs = template) {
  const { pickupWindowStart: _a, pickupWindowEnd: _b, deliveryWindowStart: _c, deliveryWindowEnd: _d, transitDays: _t, pickupTz: _p, deliveryTz: _q, ...rest } = fields;
  const columns = Object.fromEntries(Object.entries(pick(rest, TEMPLATE_LOAD_KEYS)).filter(([, v]) => v !== undefined));
  return {
    ...columns,
    ownerId: template.ownerId,
    templateId: template.id,
    status: 'planned',
    carrierId: refs.carrierId || null,
    brokerId: refs.brokerId || null,
    pickupTz: zones.pickupTz,
    deliveryTz: zones.deliveryTz,
    ...loadTimes(fields, { ymd, pickupTime: template.pickupTime, ...zones }),
  };
}

// ---------------------------------------------------------------------------
// Saving a template
// ---------------------------------------------------------------------------

/** Owner (with team membership, as access.js expects) for checks made outside a request. */
async function ownerUser(ownerId) {
  return prisma.user.findUnique({ where: { id: ownerId }, include: { teamMembership: { include: { team: true } } } });
}

/** 404 unless the user may use the referenced carrier / broker (same rule as saving a load). */
export async function checkTemplateRefs(user, { carrierId, brokerId }) {
  if (brokerId) await loadOwned('broker', user, brokerId);
  if (carrierId) await loadCarrier(user, carrierId);
}

/**
 * Normalize a validated body into LoadTemplate columns. `existing` is the current row on an update. Fields keep their
 * resolved facility zones, so the schedule shown and the loads created use the same zone.
 */
export function templateColumns(body, existing = null, ownerTz = DEFAULT_TZ) {
  const out = {};
  if (body.name !== undefined) out.name = body.name;
  let fields = existing ? parseFields(existing.fields) : null;
  if (body.fields !== undefined) {
    fields = Object.fromEntries(Object.entries(body.fields).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    const zones = templateZones({ ...fields, pickupTz: body.fields.pickupTz, deliveryTz: body.fields.deliveryTz }, ownerTz);
    fields.pickupTz = zones.pickupTz;
    fields.deliveryTz = zones.deliveryTz;
    out.fields = JSON.stringify(fields);
  }
  if (body.carrierId !== undefined) out.carrierId = body.carrierId || null;
  if (body.brokerId !== undefined) out.brokerId = body.brokerId || null;
  if (body.leadDays !== undefined) out.leadDays = body.leadDays;
  if (body.active !== undefined) out.active = body.active;
  if (body.weekdays !== undefined) {
    const days = [...new Set(body.weekdays || [])].sort((a, b) => a - b);
    out.weekdays = days.length ? days.join(',') : null;
  }
  if (body.pickupTime !== undefined) out.pickupTime = body.pickupTime || null;

  const weekdays = out.weekdays !== undefined ? out.weekdays : existing?.weekdays ?? null;
  let pickupTime = out.pickupTime !== undefined ? out.pickupTime : existing?.pickupTime ?? null;
  if (weekdays && !pickupTime && fields?.pickupWindowStart) {
    pickupTime = fields.pickupWindowStart;
    out.pickupTime = pickupTime;
  }
  if (weekdays && !pickupTime) throw badRequest('Set a pickup time for the weekly schedule');

  // Delivery must not land before pickup (checked on a sample day in each facility's zone).
  if (fields && (pickupTime || fields.pickupWindowStart) && fields.deliveryWindowStart && !fields.transitDays) {
    const zones = templateZones(fields, ownerTz);
    const sample = '2026-01-14';
    const p = localAt(zones.pickupTz, sample, pickupTime || fields.pickupWindowStart);
    const d = localAt(zones.deliveryTz, sample, fields.deliveryWindowStart);
    if (d < p) throw badRequest('Delivery starts before pickup on the same day. Add transit days or change the times.');
  }

  // A new schedule or zone starts over from today (days that already have a load are still skipped).
  if (existing) {
    const before = parseFields(existing.fields);
    const zoneMoved = fields && (before.pickupTz !== fields.pickupTz);
    const turnedOn = out.active === true && !existing.active;
    if ((out.weekdays !== undefined && out.weekdays !== existing.weekdays) || (out.pickupTime !== undefined && out.pickupTime !== existing.pickupTime) || zoneMoved || turnedOn) {
      out.generatedTo = null;
    }
  }
  return out;
}

/** API shape of a template. `names` maps carrier and broker ids to { id, companyName }. */
export function templateView(t, { now = new Date(), names = new Map(), ownerTz } = {}) {
  const fields = parseFields(t.fields);
  const weekdays = parseWeekdays(t.weekdays);
  const zones = templateZones(fields, ownerTz);
  const next = t.active ? nextPickups({ weekdays, pickupTime: t.pickupTime, tz: zones.pickupTz, now })[0] ?? null : null;
  return {
    id: t.id, name: t.name, fields, carrierId: t.carrierId, brokerId: t.brokerId,
    carrier: t.carrierId ? names.get(`c:${t.carrierId}`) ?? null : null,
    broker: t.brokerId ? names.get(`b:${t.brokerId}`) ?? null : null,
    weekdays, pickupTime: t.pickupTime, leadDays: t.leadDays, active: t.active, recurring: weekdays.length > 0,
    pickupTz: zones.pickupTz, generatedTo: t.generatedTo, lastRunAt: t.lastRunAt, nextPickupAt: next,
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

/** Carrier and broker names for a page of templates (two queries at most). */
export async function templateNames(rows) {
  const carrierIds = [...new Set(rows.map((t) => t.carrierId).filter(Boolean))];
  const brokerIds = [...new Set(rows.map((t) => t.brokerId).filter(Boolean))];
  const [carriers, brokers] = await Promise.all([
    carrierIds.length ? prisma.carrier.findMany({ where: { id: { in: carrierIds } }, select: { id: true, companyName: true } }) : [],
    brokerIds.length ? prisma.broker.findMany({ where: { id: { in: brokerIds } }, select: { id: true, companyName: true } }) : [],
  ]);
  const names = new Map();
  for (const c of carriers) names.set(`c:${c.id}`, c);
  for (const b of brokers) names.set(`b:${b.id}`, b);
  return names;
}

// ---------------------------------------------------------------------------
// Generating loads
// ---------------------------------------------------------------------------

/**
 * Carrier and broker the owner may still use. A reference that lost access (the owner left the team, the record was
 * deleted) is cleared on the template and left off the new loads, so a load never points at someone else's record.
 */
async function currentRefs(t, owner) {
  let { carrierId, brokerId } = t;
  if (!carrierId && !brokerId) return { carrierId: null, brokerId: null };
  if (carrierId) carrierId = await loadCarrier(owner, carrierId).then(() => carrierId, () => null);
  if (brokerId) brokerId = await loadOwned('broker', owner, brokerId).then(() => brokerId, () => null);
  if (carrierId !== t.carrierId || brokerId !== t.brokerId) {
    await prisma.loadTemplate.update({ where: { id: t.id }, data: { carrierId, brokerId } });
  }
  return { carrierId, brokerId };
}

/**
 * Create the planned loads a dedicated lane needs now. Returns the number created, or null when another run (or an
 * edit) moved the template first. Safe to call from a request and from the job at the same time.
 */
export async function generateForTemplate(template, { now = new Date(), owner = null } = {}) {
  const t = template;
  const weekdays = parseWeekdays(t.weekdays);
  if (!t.active || !weekdays.length || !t.pickupTime) return 0;
  const parsed = templateFieldsSchema.safeParse(parseFields(t.fields));
  if (!parsed.success) {
    // Stored fields that no longer pass the load rules: stop the schedule instead of retrying every hour.
    await prisma.loadTemplate.updateMany({ where: { id: t.id }, data: { active: false, lastRunAt: now } });
    return 0;
  }
  const fields = parsed.data;
  const user = owner || (await ownerUser(t.ownerId));
  if (!user || user.status === 'suspended') return 0;
  const zones = templateZones(fields, user.timezone);
  const { days, until } = planDays({ weekdays, pickupTime: t.pickupTime, leadDays: t.leadDays, tz: zones.pickupTz, generatedTo: t.generatedTo, now });
  const refs = days.length ? await currentRefs(t, user) : t;
  const fit = days.length && refs.carrierId ? await rulesForCarrier(refs.carrierId) : null;

  const created = await prisma.$transaction(async (tx) => {
    // Claim: only the run that still sees the old generatedTo goes on.
    const claim = await tx.loadTemplate.updateMany({ where: { id: t.id, active: true, generatedTo: t.generatedTo ?? null }, data: { generatedTo: until, lastRunAt: now } });
    if (!claim.count) return null;
    if (!days.length) return 0;
    const existing = await tx.load.findMany({
      where: { templateId: t.id, pickupDate: { gte: new Date(localAt(zones.pickupTz, days[0]).getTime() - DAY), lt: new Date(localAt(zones.pickupTz, days[days.length - 1]).getTime() + 2 * DAY) } },
      select: { pickupDate: true },
      take: 200,
    });
    const have = new Set(existing.map((l) => localDayKey(zones.pickupTz, l.pickupDate)));
    const rows = days.filter((d) => !have.has(d)).map((d) => {
      const data = buildLoad(t, fields, d, zones, refs);
      const warnings = fit ? checkLoadFit(data, fit.rules).warnings : [];
      return { ...data, fitWarnings: warnings.length ? JSON.stringify(warnings) : null };
    });
    if (rows.length) await tx.load.createMany({ data: rows });
    return rows.length;
  });

  if (created) {
    bumpLanes(t.ownerId);
    invalidateToday(t.ownerId);
    // A carrier with an active load is a truck on the fleet map (same rule as saving a load).
    if (refs.carrierId) await prisma.carrier.updateMany({ where: { id: refs.carrierId, isFleet: false }, data: { isFleet: true } });
  }
  return created;
}

/**
 * Templates that need loads now: never generated, or covered up to less than leadDays ahead. Exact per lead time,
 * so every selected template has work and none starves behind templates that are already up to date.
 */
export function dueWhere(now) {
  const ahead = Array.from({ length: MAX_LEAD_DAYS }, (_, i) => ({ leadDays: i + 1, generatedTo: { lt: new Date(now.getTime() + (i + 1) * DAY) } }));
  return { active: true, weekdays: { not: null }, owner: { status: 'active' }, OR: [{ generatedTo: null }, ...ahead] };
}

/**
 * Hourly job: up to `rounds` batches of `batch` templates (most behind first, Load(templateId, pickupDate) and
 * LoadTemplate(active, generatedTo) indexes), within a time budget.
 */
export async function runRecurringLoads(now = new Date(), { batch = 200, rounds = 5, budgetMs = 20_000 } = {}) {
  const started = Date.now();
  const seen = new Set();
  let templates = 0;
  let created = 0;
  let failed = 0;
  for (let round = 0; round < rounds && Date.now() - started < budgetMs; round += 1) {
    const where = dueWhere(now);
    if (seen.size) where.id = { notIn: [...seen] };
    const rows = await prisma.loadTemplate.findMany({ where, orderBy: [{ generatedTo: 'asc' }, { id: 'asc' }], take: batch });
    if (!rows.length) break;
    const owners = new Map();
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((t) => t.ownerId))] } }, include: { teamMembership: { include: { team: true } } } });
    for (const u of users) owners.set(u.id, u);
    for (const t of rows) {
      seen.add(t.id);
      templates += 1;
      try {
        created += (await generateForTemplate(t, { now, owner: owners.get(t.ownerId) })) || 0;
      } catch (err) {
        failed += 1;
        console.error(`[recurring-loads] template ${t.id}: ${err.message}`);
      }
      if (Date.now() - started >= budgetMs) break;
    }
    if (rows.length < batch) break;
  }
  return { templates, created, failed };
}
