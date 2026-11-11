import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { monthBuckets } from './range.js';

/**
 * Profit reports over a workspace's loads, aggregated in SQLite (GROUP BY with bound parameters, bounded results):
 * no load rows are read into JS.
 *
 * Per-load money math is the one in calculateLoad() (services/loads/rateCalc.js), written as SQL so it can be summed:
 *   gross        = rate + ROUND(detention hours x detention rate)
 *   dispatch fee = ROUND(gross x fee % / 100), fee % = the load's own, else the customer's (as statements and "Fees
 *                  earned" do); loads with neither earn no fee and are counted in feeMissingLoads
 *   fuel         = ROUND((loaded + deadhead) / mpg x fuel price x 100) when mpg > 0 and a fuel price is set, else 0
 *                  (calculateLoad leaves fuel out the same way); fuelKnownLoads says how many loads have it
 *   est. profit  = gross - fuel - other costs (the carrier's operating margin before the dispatch fee)
 * A canceled load with a TONU earns only its TONU: gross = TONU, no detention, no miles, no fuel (the rule statements,
 * customer revenue and fee invoices use). tests/reports.test.js checks the SQL against calculateLoad on fixtures.
 *
 * Loads count when delivered, invoiced or paid (optionally in transit), or canceled with a TONU, and are dated by
 * delivery date, else pickup date, in the dispatcher's time zone.
 */
export const EARNED_STATUSES = ['delivered', 'invoiced', 'paid'];
export const GROUP_BYS = ['carrier', 'broker', 'lane', 'month'];
/** Rows returned per grouping; the rest are summed into one "others" row. */
export const TOP_N = 50;

const TONU = Prisma.sql`(l.status = 'canceled' AND l.tonuCents > 0)`;
const RAN = Prisma.sql`(NOT ${TONU})`;
const DETENTION = Prisma.sql`ROUND(l.detentionHours * l.detentionRateCents)`;
const GROSS = Prisma.sql`(CASE WHEN ${TONU} THEN l.tonuCents ELSE l.rateCents + ${DETENTION} END)`;
const FEE_PCT = Prisma.sql`COALESCE(l.dispatchFeePercent, cu.dispatchFeePercent)`;
const FEE = Prisma.sql`(CASE WHEN ${FEE_PCT} IS NULL THEN 0 ELSE ROUND(${GROSS} * ${FEE_PCT} / 100.0) END)`;
const TOTAL_MILES = Prisma.sql`(l.loadedMiles + l.deadheadMiles)`;
const FUEL_KNOWN = Prisma.sql`(${RAN} AND l.mpg > 0 AND l.fuelPricePerGallon IS NOT NULL)`;
const FUEL = Prisma.sql`(CASE WHEN ${FUEL_KNOWN} THEN ROUND(${TOTAL_MILES} * 1.0 / l.mpg * l.fuelPricePerGallon * 100) ELSE 0 END)`;
/** Delivery date, else pickup date. */
const DAY_OF = Prisma.sql`COALESCE(l.deliveryDate, l.pickupDate)`;
const FROM = Prisma.sql`Load l LEFT JOIN Customer cu ON cu.carrierId = l.carrierId`;

/** Raw sums every aggregate returns (combined by addition for "others" and month totals). */
const AGGS = Prisma.sql`
  COUNT(*) AS loads,
  SUM(${GROSS}) AS grossCents,
  SUM(CASE WHEN ${TONU} THEN 0 ELSE l.rateCents END) AS rateCents,
  SUM(CASE WHEN ${TONU} THEN 0 ELSE ${DETENTION} END) AS detentionCents,
  SUM(CASE WHEN ${TONU} THEN l.tonuCents ELSE 0 END) AS tonuCents,
  SUM(CASE WHEN ${TONU} THEN 1 ELSE 0 END) AS tonuLoads,
  SUM(${FEE}) AS feeCents,
  SUM(CASE WHEN ${FEE_PCT} IS NULL THEN 1 ELSE 0 END) AS feeMissing,
  SUM(${FUEL}) AS fuelCents,
  SUM(CASE WHEN ${FUEL_KNOWN} THEN 1 ELSE 0 END) AS fuelKnown,
  SUM(l.otherCostsCents) AS otherCostsCents,
  SUM(CASE WHEN ${RAN} THEN l.loadedMiles ELSE 0 END) AS loadedMiles,
  SUM(CASE WHEN ${RAN} THEN ${TOTAL_MILES} ELSE 0 END) AS totalMiles,
  SUM(CASE WHEN ${RAN} AND l.loadedMiles > 0 THEN l.rateCents ELSE 0 END) AS rpmRateCents,
  SUM(CASE WHEN ${RAN} AND ${TOTAL_MILES} > 0 THEN l.rateCents ELSE 0 END) AS allInRateCents`;
const RAW_KEYS = ['loads', 'grossCents', 'rateCents', 'detentionCents', 'tonuCents', 'tonuLoads', 'feeCents', 'feeMissing', 'fuelCents', 'fuelKnown', 'otherCostsCents', 'loadedMiles', 'totalMiles', 'rpmRateCents', 'allInRateCents'];

/**
 * Group key, label and join. Names come only from carriers and brokers the owners hold (or, for carriers, are assigned
 * to), so a stray reference to another workspace's record shows as "Unknown carrier", never as that record's name.
 */
function groupOf(groupBy, ownerIds) {
  const owners = Prisma.join(ownerIds);
  if (groupBy === 'carrier') {
    return { key: Prisma.sql`COALESCE(l.carrierId, '')`, label: Prisma.sql`MAX(c.companyName)`, join: Prisma.sql`LEFT JOIN Carrier c ON c.id = l.carrierId AND (c.ownerId IN (${owners}) OR c.assignedToId IN (${owners}))` };
  }
  if (groupBy === 'broker') {
    return { key: Prisma.sql`COALESCE(l.brokerId, '')`, label: Prisma.sql`MAX(b.companyName)`, join: Prisma.sql`LEFT JOIN Broker b ON b.id = l.brokerId AND b.ownerId IN (${owners})` };
  }
  if (groupBy === 'lane') return { key: Prisma.sql`(UPPER(TRIM(l.originState)) || '>' || UPPER(TRIM(l.destState)))`, label: Prisma.sql`NULL`, join: Prisma.empty };
  throw new Error(`Unknown grouping ${groupBy}`);
}

const num = (v) => (v == null ? 0 : Number(v));
const r2 = (v) => Math.round(v * 100) / 100;

/** Owner, status and date conditions (index-friendly: ownerId IN + status IN, then the date window). */
export function loadWhere({ ownerIds, start, end, inTransit = false }) {
  const statuses = [...EARNED_STATUSES, ...(inTransit ? ['in_transit'] : []), 'canceled'];
  return Prisma.sql`l.ownerId IN (${Prisma.join(ownerIds)})
    AND l.status IN (${Prisma.join(statuses)}) AND (l.status <> 'canceled' OR l.tonuCents > 0)
    AND ((l.deliveryDate >= ${start} AND l.deliveryDate < ${end}) OR (l.deliveryDate IS NULL AND l.pickupDate >= ${start} AND l.pickupDate < ${end}))`;
}

function rawOf(row) {
  return Object.fromEntries(RAW_KEYS.map((k) => [k, Math.round(num(row?.[k]))]));
}
function addRaw(a, b, sign = 1) {
  return Object.fromEntries(RAW_KEYS.map((k) => [k, (a?.[k] || 0) + sign * (b?.[k] || 0)]));
}

/** Derived metrics from raw sums. Rates per mile use linehaul rate (as calculateLoad does), not detention. */
export function finish(raw) {
  const s = rawOf(raw);
  const costsCents = s.fuelCents + s.otherCostsCents;
  const profitCents = s.grossCents - costsCents;
  const per = (v) => (s.loads ? Math.round(v / s.loads) : null);
  return {
    loads: s.loads,
    grossCents: s.grossCents,
    rateCents: s.rateCents,
    detentionCents: s.detentionCents,
    tonuCents: s.tonuCents,
    tonuLoads: s.tonuLoads,
    feeCents: s.feeCents,
    feeMissingLoads: s.feeMissing,
    fuelCents: s.fuelCents,
    fuelKnownLoads: s.fuelKnown,
    otherCostsCents: s.otherCostsCents,
    costsCents,
    profitCents,
    carrierNetCents: profitCents - s.feeCents,
    loadedMiles: s.loadedMiles,
    totalMiles: s.totalMiles,
    ratePerMile: s.loadedMiles > 0 ? r2(s.rpmRateCents / 100 / s.loadedMiles) : null,
    allInRatePerMile: s.totalMiles > 0 ? r2(s.allInRateCents / 100 / s.totalMiles) : null,
    profitPerMile: s.totalMiles > 0 ? r2(profitCents / 100 / s.totalMiles) : null,
    avgGrossCents: per(s.grossCents),
    avgFeeCents: per(s.feeCents),
    avgProfitCents: per(profitCents),
    avgLoadedMiles: per(s.loadedMiles),
  };
}

function laneLabel(key) {
  const [o, d] = String(key || '').split('>');
  return `${o || '?'} → ${d || '?'}`;
}

const NONE_LABEL = { carrier: 'No carrier', broker: 'No broker' };
const UNKNOWN_LABEL = { carrier: 'Unknown carrier', broker: 'Unknown broker' };

/** Loads that pass the status filter but have neither a delivery nor a pickup date (left out of every range). */
async function undatedCount({ ownerIds, inTransit }) {
  return prisma.load.count({
    where: { ownerId: { in: ownerIds }, status: { in: [...EARNED_STATUSES, ...(inTransit ? ['in_transit'] : [])] }, deliveryDate: null, pickupDate: null },
  });
}

/**
 * Profit grouped by carrier, broker, lane or month over a resolved range (services/reports/range.js).
 * Carrier/broker/lane: top TOP_N by gross (ties by key), plus `others` summing the rest. Month: every month of the
 * range, oldest first (empty months included), no `others`.
 */
export async function profitReport({ ownerIds, range, groupBy = 'carrier', inTransit = false }) {
  const where = loadWhere({ ownerIds, start: range.start, end: range.end, inTransit });
  const undatedP = undatedCount({ ownerIds, inTransit });

  if (groupBy === 'month') {
    const buckets = monthBuckets(range);
    const key = buckets.length === 1
      ? Prisma.sql`${buckets[0].key}`
      : Prisma.sql`CASE ${Prisma.join(buckets.slice(1).map((b, i) => Prisma.sql`WHEN ${DAY_OF} < ${b.start} THEN ${buckets[i].key}`), ' ')} ELSE ${buckets.at(-1).key} END`;
    const rows = await prisma.$queryRaw`SELECT ${key} AS k, ${AGGS} FROM ${FROM} WHERE ${where} GROUP BY k`;
    const byKey = new Map(rows.map((row) => [row.k, rawOf(row)]));
    const total = rows.reduce((acc, row) => addRaw(acc, rawOf(row)), rawOf(null));
    return {
      rows: buckets.map((b) => ({ key: b.key, label: b.label, ...finish(byKey.get(b.key)) })),
      others: null,
      totals: finish(total),
      groups: buckets.length,
      undatedLoads: await undatedP,
    };
  }

  const g = groupOf(groupBy, ownerIds);
  const [rows, [tot]] = await Promise.all([
    prisma.$queryRaw`
      SELECT ${g.key} AS k, ${g.label} AS label, ${AGGS}
      FROM ${FROM} ${g.join}
      WHERE ${where}
      GROUP BY k
      ORDER BY grossCents DESC, k ASC
      LIMIT ${TOP_N}`,
    prisma.$queryRaw`SELECT COUNT(DISTINCT ${g.key}) AS groups, ${AGGS} FROM ${FROM} WHERE ${where}`,
  ]);
  const totalRaw = rawOf(tot);
  const groups = num(tot?.groups);
  const top = rows.map((row) => {
    if (groupBy === 'lane') return { key: row.k, id: null, label: laneLabel(row.k), raw: rawOf(row) };
    const known = !!(row.k && row.label != null);
    const label = !row.k ? NONE_LABEL[groupBy] : known ? row.label : UNKNOWN_LABEL[groupBy];
    return { key: row.k || 'none', id: known ? row.k : null, label, raw: rawOf(row) };
  });
  const shown = top.reduce((acc, row) => addRaw(acc, row.raw), rawOf(null));
  const rest = addRaw(totalRaw, shown, -1);
  const others = groups > top.length && rest.loads > 0
    ? { key: 'others', id: null, label: `Others (${groups - top.length})`, groups: groups - top.length, ...finish(rest) }
    : null;
  return {
    rows: top.map(({ raw, ...row }) => ({ ...row, ...finish(raw) })),
    others,
    totals: finish(totalRaw),
    groups,
    undatedLoads: await undatedP,
  };
}

const change = (now, before) => (now == null || before == null || before === 0 ? null : Math.round(((now - before) / Math.abs(before)) * 1000) / 10);

/**
 * KPI tiles: this calendar month against last month up to the same day (and the whole of last month for reference),
 * from one grouped query over [first of last month, first of next month).
 */
export async function profitSummary({ ownerIds, months, inTransit = false }) {
  const { thisMonth, lastMonth, lastMonthToDate } = months;
  const where = loadWhere({ ownerIds, start: lastMonth.start, end: thisMonth.end, inTransit });
  const rows = await prisma.$queryRaw`
    SELECT CASE WHEN ${DAY_OF} >= ${thisMonth.start} THEN 'this' WHEN ${DAY_OF} < ${lastMonthToDate.end} THEN 'lastToDate' ELSE 'lastRest' END AS k,
           ${AGGS}
    FROM ${FROM} WHERE ${where} GROUP BY k`;
  const raw = Object.fromEntries(rows.map((row) => [row.k, rawOf(row)]));
  const cur = finish(raw.this);
  const prevToDate = finish(raw.lastToDate);
  const prev = finish(addRaw(raw.lastToDate, raw.lastRest));
  const strip = ({ start, end, ...rest }) => rest;
  return {
    thisMonth: { ...strip(thisMonth), ...cur },
    lastMonth: { ...strip(lastMonth), ...prev },
    lastMonthToDate: { ...strip(lastMonthToDate), ...prevToDate },
    change: {
      grossCents: change(cur.grossCents, prevToDate.grossCents),
      feeCents: change(cur.feeCents, prevToDate.feeCents),
      profitCents: change(cur.profitCents, prevToDate.profitCents),
      loads: change(cur.loads, prevToDate.loads),
      ratePerMile: change(cur.ratePerMile, prevToDate.ratePerMile),
    },
  };
}
