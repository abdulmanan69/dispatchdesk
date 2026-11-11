import { prisma } from '../../db.js';
import { badRequest } from '../../lib/errors.js';
import { localParts, zonedTimeToUtc, DEFAULT_TZ } from '../../lib/timezones.js';
import { calculateLoad } from '../loads/rateCalc.js';

/**
 * Weekly dispatch-fee statements for a customer carrier: loads delivered in a Monday-to-Monday week in the
 * dispatcher's time zone, gross (rate + detention), fee % (the load's own, else the customer's), fee and net.
 * Computed on demand from the loads (bounded by the Load(carrierId) index and the week), never stored.
 */
export const BILLED_STATUSES = ['delivered', 'invoiced', 'paid'];
/**
 * Loads a statement (and "Fees earned") counts: delivered or later, and canceled loads with a TONU, which earn the
 * TONU amount (the same rule as dispatch-fee invoices, services/invoices/index.js linesForLoad).
 */
export const billedWhere = { OR: [{ status: { in: BILLED_STATUSES } }, { status: 'canceled', tonuCents: { gt: 0 } }] };
export const isBilledLoad = (l) => BILLED_STATUSES.includes(l?.status) || (l?.status === 'canceled' && (l.tonuCents || 0) > 0);
export const MAX_WEEKS = 26;
const WEEK_KEY = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
};

/** Week (Monday 00:00 to the next Monday, local) containing `date`: { key, start, end }. */
export function weekOf(tz, date = new Date()) {
  const zone = tz || DEFAULT_TZ;
  const p = localParts(zone, date);
  const back = (p.weekdayIndex + 6) % 7; // days since Monday
  return {
    key: keyOf(p.year, p.month, p.day - back),
    start: zonedTimeToUtc(zone, p.year, p.month, p.day - back, 0, 0, 0),
    end: zonedTimeToUtc(zone, p.year, p.month, p.day - back + 7, 0, 0, 0),
  };
}

/** Week from its Monday key ('2026-11-09'); 400 when the key is not a Monday. */
export function weekFromKey(tz, key) {
  if (!WEEK_KEY.test(String(key || ''))) throw badRequest('Use the week start date as YYYY-MM-DD');
  const [y, m, d] = key.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  if (Number.isNaN(probe.getTime()) || probe.getUTCDay() !== 1 || keyOf(y, m, d) !== key) throw badRequest('Statements start on a Monday');
  const zone = tz || DEFAULT_TZ;
  return { key, start: zonedTimeToUtc(zone, y, m, d, 0, 0, 0), end: zonedTimeToUtc(zone, y, m, d + 7, 0, 0, 0) };
}

/** The `count` most recent weeks, newest first. */
export function recentWeeks(tz, count = 12, now = new Date()) {
  const out = [];
  let w = weekOf(tz, now);
  for (let i = 0; i < Math.min(count, MAX_WEEKS); i++) {
    out.push(w);
    w = weekOf(tz, new Date(w.start.getTime() - 3_600_000)); // an hour before this Monday is in the previous week
  }
  return out;
}

const loadDay = (l) => l.deliveryDate || l.pickupDate || null;

const inRange = (start, end) => ({
  OR: [
    { deliveryDate: { gte: start, lt: end } },
    { deliveryDate: null, pickupDate: { gte: start, lt: end } },
  ],
});

/** One statement line per load. */
export function statementLine(l, customerFee) {
  const pct = l.dispatchFeePercent ?? customerFee ?? null;
  // A canceled load with a TONU earns only the TONU: no miles, no detention.
  const tonu = l.status === 'canceled';
  const basis = tonu ? { ...l, rateCents: l.tonuCents || 0, detentionHours: 0, loadedMiles: 0, deadheadMiles: 0 } : l;
  const c = calculateLoad({ ...basis, dispatchFeePercent: pct });
  return {
    id: l.id,
    date: loadDay(l),
    reference: l.referenceNumber || null,
    lane: `${l.originCity}, ${l.originState} → ${l.destCity}, ${l.destState}`,
    broker: l.broker?.companyName || null,
    status: l.status,
    tonu,
    rateCents: basis.rateCents,
    detentionCents: c.detentionPayCents,
    grossCents: c.grossCents,
    loadedMiles: basis.loadedMiles,
    deadheadMiles: basis.deadheadMiles || 0,
    ratePerMile: tonu ? null : c.ratePerMile,
    feePercent: pct,
    feeCents: c.dispatchFeeCents,
    netCents: c.grossCents - (c.dispatchFeeCents ?? 0),
    documents: (l.documents || []).map((d) => ({ id: d.id, type: d.type, originalName: d.originalName })),
  };
}

export function statementTotals(lines) {
  const sum = (k) => lines.reduce((s, l) => s + (l[k] || 0), 0);
  const miles = sum('loadedMiles');
  const rate = sum('rateCents');
  return {
    loads: lines.length,
    grossCents: sum('grossCents'),
    feeCents: sum('feeCents'),
    netCents: sum('netCents'),
    loadedMiles: miles,
    deadheadMiles: sum('deadheadMiles'),
    avgRatePerMile: miles ? Math.round((rate / 100 / miles) * 100) / 100 : null,
    missingFee: lines.filter((l) => l.feeCents == null).length,
  };
}

/**
 * Full statement for one week. `withDocuments` adds the rate con, BOL and POD files of each load (carrier portal).
 */
export async function buildStatement({ customer, carrier, week, withDocuments = false }) {
  const loads = await prisma.load.findMany({
    where: { carrierId: carrier.id, AND: [billedWhere, inRange(week.start, week.end)] },
    orderBy: [{ deliveryDate: 'asc' }, { pickupDate: 'asc' }],
    take: 500,
    include: {
      broker: { select: { companyName: true } },
      ...(withDocuments ? { documents: { where: { type: { in: ['rate_confirmation', 'bol', 'pod'] } }, select: { id: true, type: true, originalName: true }, orderBy: { createdAt: 'asc' } } } : {}),
    },
  });
  const lines = loads.map((l) => statementLine(l, customer.dispatchFeePercent));
  return {
    weekStart: week.key,
    periodStart: week.start,
    periodEnd: week.end,
    carrier: { id: carrier.id, companyName: carrier.companyName, mcNumber: carrier.mcNumber || null, dotNumber: carrier.dotNumber || null },
    feePercent: customer.dispatchFeePercent ?? null,
    lines,
    totals: statementTotals(lines),
  };
}

/** Totals for the most recent `count` weeks (newest first) with one bounded query. */
export async function weeklySummaries({ customer, carrier, tz, count = 12, now = new Date() }) {
  const weeks = recentWeeks(tz, count, now);
  if (!weeks.length) return [];
  const from = weeks[weeks.length - 1].start;
  const to = weeks[0].end;
  const loads = await prisma.load.findMany({
    where: { carrierId: carrier.id, AND: [billedWhere, inRange(from, to)] },
    select: { id: true, rateCents: true, tonuCents: true, loadedMiles: true, deadheadMiles: true, detentionHours: true, detentionRateCents: true, dispatchFeePercent: true, deliveryDate: true, pickupDate: true, originCity: true, originState: true, destCity: true, destState: true, referenceNumber: true, status: true },
    take: 5000,
  });
  return weeks.map((w) => {
    const lines = loads.filter((l) => {
      const t = new Date(loadDay(l)).getTime();
      return t >= w.start.getTime() && t < w.end.getTime();
    }).map((l) => statementLine(l, customer.dispatchFeePercent));
    return { weekStart: w.key, periodStart: w.start, periodEnd: w.end, totals: statementTotals(lines) };
  });
}
