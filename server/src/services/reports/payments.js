import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';

/**
 * How fast brokers pay, measured from this workspace's own freight invoices (not industry or credit-agency data).
 * Aggregated in SQLite over the Invoice(ownerId, brokerId, paidAt) index, one GROUP BY per call.
 *
 *   invoices        sent, partly paid or paid (drafts and void invoices never count)
 *   days to pay     paidAt - issuedAt (sentAt when issuedAt is empty), never below 0, over paid invoices with both dates
 *   paid late       paid on a later calendar day (UTC) than the due date
 *   open balance    amount - paid on sent and partly paid invoices
 *   past due        open balance whose due date has passed
 *   oldest open     days since the oldest open invoice was issued (sent, else created)
 */
export const ISSUED_STATUSES = ['sent', 'partial', 'paid'];
const DAY = 86_400_000;
const JD_EPOCH = 2440587.5; // Julian day of 1970-01-01T00:00Z

/** Julian day of a stored DateTime: ISO text from the driver adapter, or epoch milliseconds from older rows. */
const jd = (col) => Prisma.sql`(CASE WHEN typeof(${col}) IN ('integer', 'real') THEN ${col} / 86400000.0 + ${JD_EPOCH} ELSE julianday(${col}) END)`;
const PAID_AT = Prisma.raw('i.paidAt');
const DUE_AT = Prisma.raw('i.dueAt');
const STARTED = Prisma.raw('COALESCE(i.issuedAt, i.sentAt)');
const OPENED = Prisma.raw('COALESCE(i.issuedAt, i.sentAt, i.createdAt)');

const OPEN = Prisma.sql`(i.status IN ('sent', 'partial'))`;
const MEASURED = Prisma.sql`(i.status = 'paid' AND i.paidAt IS NOT NULL AND ${STARTED} IS NOT NULL)`;
const DAYS = Prisma.sql`MAX(0, ${jd(PAID_AT)} - ${jd(STARTED)})`;
const LATE = Prisma.sql`(i.status = 'paid' AND i.paidAt IS NOT NULL AND i.dueAt IS NOT NULL AND CAST(${jd(PAID_AT)} + 0.5 AS INTEGER) > CAST(${jd(DUE_AT)} + 0.5 AS INTEGER))`;

const num = (v) => (v == null ? 0 : Number(v));
const jdToDate = (v) => (v == null ? null : new Date(Math.round((Number(v) - JD_EPOCH) * DAY)));
const nowJd = (now) => now.getTime() / DAY + JD_EPOCH;

function conditions(ownerIds, brokerIds) {
  const c = [
    Prisma.sql`i.ownerId IN (${Prisma.join(ownerIds)})`,
    Prisma.sql`i.kind = 'freight'`,
    Prisma.sql`i.status IN (${Prisma.join(ISSUED_STATUSES)})`,
    brokerIds ? Prisma.sql`i.brokerId IN (${Prisma.join(brokerIds)})` : Prisma.sql`i.brokerId IS NOT NULL`,
  ];
  return Prisma.join(c, ' AND ');
}

/** View of one aggregate row (also used for a broker with no invoices: zeros and nulls). */
export function paymentView(row, median = null, now = new Date()) {
  const measured = num(row?.measured);
  const oldest = row?.oldestOpenJd == null ? null : Number(row.oldestOpenJd);
  return {
    invoices: num(row?.invoices),
    paidInvoices: num(row?.paid),
    measuredInvoices: measured,
    avgDaysToPay: measured && row?.avgDays != null ? Math.round(Number(row.avgDays)) : null,
    medianDaysToPay: median == null ? null : Math.round(Number(median)),
    paidLate: num(row?.paidLate),
    openInvoices: num(row?.openCount),
    openCents: Math.round(num(row?.openCents)),
    pastDueInvoices: num(row?.pastDueCount),
    pastDueCents: Math.round(num(row?.pastDueCents)),
    oldestOpenDays: oldest == null ? null : Math.max(0, Math.floor(nowJd(now) - oldest)),
    lastPaidAt: jdToDate(row?.lastPaidJd),
  };
}

/**
 * Payment stats per broker in one GROUP BY. `brokerIds` limits it to those brokers (a list page); without it every
 * broker the owners invoiced is ranked by past-due, then open balance, then invoice count, and `limit` rows return.
 */
export async function brokerPaymentRows(ownerIds, { brokerIds, now = new Date(), limit = 100, withNames = false } = {}) {
  if (!ownerIds?.length || (brokerIds && !brokerIds.length)) return [];
  const pastDue = Prisma.sql`(${OPEN} AND i.dueAt IS NOT NULL AND ${jd(DUE_AT)} < ${nowJd(now)})`;
  return prisma.$queryRaw`
    SELECT i.brokerId AS brokerId, ${withNames ? Prisma.sql`MAX(b.companyName)` : Prisma.sql`NULL`} AS name,
           COUNT(*) AS invoices,
           SUM(CASE WHEN i.status = 'paid' THEN 1 ELSE 0 END) AS paid,
           SUM(CASE WHEN ${MEASURED} THEN 1 ELSE 0 END) AS measured,
           AVG(CASE WHEN ${MEASURED} THEN ${DAYS} END) AS avgDays,
           SUM(CASE WHEN ${LATE} THEN 1 ELSE 0 END) AS paidLate,
           SUM(CASE WHEN ${OPEN} THEN 1 ELSE 0 END) AS openCount,
           SUM(CASE WHEN ${OPEN} THEN i.amountCents - i.paidCents ELSE 0 END) AS openCents,
           SUM(CASE WHEN ${pastDue} THEN 1 ELSE 0 END) AS pastDueCount,
           SUM(CASE WHEN ${pastDue} THEN i.amountCents - i.paidCents ELSE 0 END) AS pastDueCents,
           MIN(CASE WHEN ${OPEN} THEN ${jd(OPENED)} END) AS oldestOpenJd,
           MAX(CASE WHEN i.status = 'paid' AND i.paidAt IS NOT NULL THEN ${jd(PAID_AT)} END) AS lastPaidJd
    FROM Invoice i ${withNames ? Prisma.sql`LEFT JOIN Broker b ON b.id = i.brokerId AND b.ownerId IN (${Prisma.join(ownerIds)})` : Prisma.empty}
    WHERE ${conditions(ownerIds, brokerIds)}
    GROUP BY i.brokerId
    ORDER BY pastDueCents DESC, openCents DESC, invoices DESC, i.brokerId ASC
    LIMIT ${limit}`;
}

/** Median days to pay per broker (window functions over the brokers' measured invoices only). */
export async function medianDaysToPay(ownerIds, brokerIds) {
  if (!ownerIds?.length || !brokerIds?.length) return new Map();
  const rows = await prisma.$queryRaw`
    WITH d AS (
      SELECT i.brokerId AS brokerId, ${DAYS} AS days,
             ROW_NUMBER() OVER (PARTITION BY i.brokerId ORDER BY ${DAYS}) AS rn,
             COUNT(*) OVER (PARTITION BY i.brokerId) AS cnt
      FROM Invoice i
      WHERE ${conditions(ownerIds, brokerIds)} AND ${MEASURED}
    )
    SELECT brokerId, AVG(days) AS median FROM d WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2) GROUP BY brokerId`;
  return new Map(rows.map((r) => [r.brokerId, Number(r.median)]));
}

/** Compact stats for a page of brokers (the list's "Pays in" badge): one GROUP BY for the whole page. */
export async function paysInFor(ownerIds, brokerIds, now = new Date()) {
  const rows = await brokerPaymentRows(ownerIds, { brokerIds, now, limit: Math.max(1, brokerIds.length) });
  const byId = new Map(rows.map((r) => [r.brokerId, r]));
  return new Map(brokerIds.map((id) => {
    const v = paymentView(byId.get(id), null, now);
    return [id, { avgDaysToPay: v.avgDaysToPay, measuredInvoices: v.measuredInvoices, pastDueInvoices: v.pastDueInvoices, pastDueCents: v.pastDueCents, openCents: v.openCents }];
  }));
}

/** One invoice in a broker's recent history, with its days to pay (paid) or days open (open). */
export function invoiceHistoryView(inv, now = new Date()) {
  const startedAt = inv.issuedAt || inv.sentAt || null;
  const paid = inv.status === 'paid' && inv.paidAt;
  const open = inv.status === 'sent' || inv.status === 'partial';
  const utcDay = (d) => Math.floor(new Date(d).getTime() / DAY);
  return {
    id: inv.id,
    number: inv.number,
    status: inv.status,
    reference: inv.load?.referenceNumber || null,
    amountCents: inv.amountCents,
    balanceCents: Math.max(0, inv.amountCents - inv.paidCents),
    issuedAt: startedAt,
    dueAt: inv.dueAt,
    paidAt: inv.paidAt,
    daysToPay: paid && startedAt ? Math.max(0, Math.round((new Date(inv.paidAt) - new Date(startedAt)) / DAY)) : null,
    late: !!(paid && inv.dueAt && utcDay(inv.paidAt) > utcDay(inv.dueAt)),
    daysOpen: open ? Math.max(0, Math.floor((now - new Date(startedAt || inv.createdAt)) / DAY)) : null,
    pastDue: !!(open && inv.dueAt && new Date(inv.dueAt) < now),
  };
}

/** Full payment history for one broker page: stats, median and the last 10 issued invoices. */
export async function brokerPaymentDetail(ownerIds, brokerId, now = new Date()) {
  const [rows, medians, recent] = await Promise.all([
    brokerPaymentRows(ownerIds, { brokerIds: [brokerId], now, limit: 1 }),
    medianDaysToPay(ownerIds, [brokerId]),
    prisma.invoice.findMany({
      where: { ownerId: { in: ownerIds }, brokerId, kind: 'freight', status: { in: ISSUED_STATUSES } },
      orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }],
      take: 10,
      select: { id: true, number: true, status: true, amountCents: true, paidCents: true, issuedAt: true, sentAt: true, dueAt: true, paidAt: true, createdAt: true, load: { select: { referenceNumber: true } } },
    }),
  ]);
  return { ...paymentView(rows[0], medians.get(brokerId) ?? null, now), recent: recent.map((inv) => invoiceHistoryView(inv, now)) };
}

/** Broker payments report: up to `limit` brokers with their stats and medians, and how many brokers there are. */
export async function brokerPaymentsReport(ownerIds, { now = new Date(), limit = 100 } = {}) {
  const [rows, [count]] = await Promise.all([
    brokerPaymentRows(ownerIds, { now, limit, withNames: true }),
    prisma.$queryRaw`SELECT COUNT(DISTINCT i.brokerId) AS n FROM Invoice i WHERE ${conditions(ownerIds)}`,
  ]);
  const medians = await medianDaysToPay(ownerIds, rows.map((r) => r.brokerId));
  return {
    // A broker of another workspace (a stray reference) keeps its stats under "Unknown broker", never its name.
    rows: rows.map((r) => ({ brokerId: r.brokerId, name: r.name ?? null, known: r.name != null, ...paymentView(r, medians.get(r.brokerId) ?? null, now) })),
    total: num(count?.n),
  };
}
