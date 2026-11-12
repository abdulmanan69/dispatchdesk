import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { conflict } from '../../lib/errors.js';
import { calculateLoad } from '../loads/rateCalc.js';
import { safeCell } from '../../lib/csv.js';

/**
 * Invoices: freight invoices to the broker on behalf of the carrier, and dispatch-fee invoices to the carrier.
 *
 * Invoice.lines holds JSON { items: [{ kind, description, quantity, unitCents, amountCents }], meta: {...} }
 * (an older plain array of items is read too). meta keeps what the printed invoice needs and has no column:
 * reference, lane, dates, the carrier invoiced for, remit-to text, terms, autoRemind (opt-in reminder emails)
 * and payments [{ amountCents, at, method, reference, by }].
 * Numbers are sequential per owner (starting at 1001), allocated as max + 1 and protected by the unique
 * (ownerId, number) index: a concurrent create that loses the race retries with the next number.
 */
export const INVOICE_KINDS = ['freight', 'dispatch_fee'];
export const INVOICE_STATUSES = ['draft', 'sent', 'partial', 'paid', 'void'];
export const OPEN_STATUSES = ['sent', 'partial'];
export const LINE_KINDS = ['linehaul', 'detention', 'tonu', 'lumper', 'layover', 'fee', 'other'];
export const FIRST_NUMBER = 1001;
export const DISPATCH_FEE_DUE_DAYS = 7;
export const DEFAULT_DUE_DAYS = 30;
/**
 * Kinds of money recorded against an invoice (meta.payments[].kind; a missing kind is a plain payment). Factored
 * invoices settle in parts: the factoring company's advance, the reserve it releases later, and its fee, which it
 * keeps (the fee settles that part of the invoice but is not money received). All of them count toward paidCents.
 */
export const PAYMENT_KINDS = ['payment', 'advance', 'reserve', 'fee'];
export const PAYMENT_LABEL = { payment: 'Payment', advance: 'Advance from factoring', reserve: 'Reserve released', fee: 'Factoring fee' };
const DAY = 86_400_000;

const money = (cents) => `$${(Math.round(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function parseInvoiceData(raw) {
  let v = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { v = null; }
  }
  if (Array.isArray(v)) return { items: v, meta: {} };
  if (v && typeof v === 'object') return { items: Array.isArray(v.items) ? v.items : [], meta: v.meta && typeof v.meta === 'object' ? v.meta : {} };
  return { items: [], meta: {} };
}
export const serializeInvoiceData = ({ items, meta }) => JSON.stringify({ items, meta: meta || {} });

/** Validated line items with amounts recomputed from quantity x unit price. */
export function normalizeLines(items = []) {
  return items.slice(0, 50).map((l) => {
    const quantity = Math.round((Number(l.quantity) || 0) * 100) / 100;
    const unitCents = Math.round(Number(l.unitCents) || 0);
    return {
      kind: LINE_KINDS.includes(l.kind) ? l.kind : 'other',
      description: String(l.description || '').trim().slice(0, 300) || 'Item',
      quantity,
      unitCents,
      amountCents: Math.round(quantity * unitCents),
    };
  });
}
export const totalOf = (items = []) => items.reduce((sum, l) => sum + (Number(l.amountCents) || 0), 0);

/** Days to pay from the broker: daysToPay, else "Net 30" style terms, else null. */
export function termsDays(paymentTerms, daysToPay) {
  if (Number.isFinite(daysToPay) && daysToPay >= 0) return daysToPay;
  const m = String(paymentTerms || '').match(/net\s*-?\s*(\d{1,3})/i);
  return m ? Number(m[1]) : null;
}

/**
 * The due date an invoice gets when it is issued on `issuedAt`: the date the user picked (meta.dueFixed), else
 * issuedAt plus the term length resolved when the draft was made (meta.dueDays, which includes the broker's days to
 * pay), else the length named in the terms ("Net 30"), else the default for the kind. Used both for the stored date and
 * for the email text, so the two never differ.
 */
export function effectiveDueAt(inv, issuedAt = new Date()) {
  const { meta } = parseInvoiceData(inv.lines);
  if (meta.dueFixed && inv.dueAt) return new Date(inv.dueAt);
  const days = (Number.isFinite(meta.dueDays) && meta.dueDays >= 0 ? meta.dueDays : null)
    ?? termsDays(meta.terms, null)
    ?? (inv.kind === 'dispatch_fee' ? DISPATCH_FEE_DUE_DAYS : DEFAULT_DUE_DAYS);
  return new Date(new Date(issuedAt).getTime() + days * DAY);
}

/**
 * Past due: open and the due date has passed (the same rule as the list filter, aging, the Today board and reminders).
 * Days past due count from 1 on the first day.
 */
export function pastDue(inv, now = new Date()) {
  const open = OPEN_STATUSES.includes(inv.status);
  if (!open || !inv.dueAt) return { overdue: false, days: 0 };
  const ms = now.getTime() - new Date(inv.dueAt).getTime();
  return ms > 0 ? { overdue: true, days: Math.max(1, Math.floor(ms / DAY)) } : { overdue: false, days: 0 };
}

const laneOf = (l) => `${l.originCity}, ${l.originState} → ${l.destCity}, ${l.destState}`;
const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/** Line items for a load. kind 'freight': rate, detention, TONU; 'dispatch_fee': the fee on the load's gross. */
export function linesForLoad(load, kind, { feePercent } = {}) {
  const ref = load.referenceNumber ? ` (ref ${load.referenceNumber})` : '';
  if (kind === 'dispatch_fee') {
    const pct = load.dispatchFeePercent ?? feePercent ?? null;
    // A canceled load earns only its TONU, so the fee is on the TONU amount.
    const tonu = load.status === 'canceled';
    const calc = calculateLoad({ ...load, ...(tonu ? { rateCents: load.tonuCents || 0, detentionHours: 0 } : {}), dispatchFeePercent: pct });
    if (pct == null || calc.dispatchFeeCents == null || !calc.grossCents) return [];
    return normalizeLines([{ kind: 'fee', description: `Dispatch fee ${pct}% of ${money(calc.grossCents)} ${tonu ? 'TONU' : 'gross'} · ${laneOf(load)}${ref}`, quantity: 1, unitCents: calc.dispatchFeeCents }]);
  }
  const items = [];
  if (load.status === 'canceled' && load.tonuCents > 0) {
    items.push({ kind: 'tonu', description: `Truck ordered not used · ${laneOf(load)}${ref}`, quantity: 1, unitCents: load.tonuCents });
    return normalizeLines(items);
  }
  items.push({ kind: 'linehaul', description: `Line haul · ${laneOf(load)}${ref}`, quantity: 1, unitCents: load.rateCents });
  if (load.detentionHours > 0 && load.detentionRateCents > 0) {
    items.push({ kind: 'detention', description: `Detention ${load.detentionHours} h at ${money(load.detentionRateCents)}/h`, quantity: load.detentionHours, unitCents: load.detentionRateCents });
  }
  return normalizeLines(items);
}

/** meta for a new invoice created from a load. */
export function metaForLoad(load, { carrier, terms, autoRemind = false } = {}) {
  return {
    reference: load.referenceNumber || null,
    lane: laneOf(load),
    pickupDate: ymd(load.pickupDate),
    deliveryDate: ymd(load.deliveryDate),
    carrier: carrier ? { name: carrier.companyName, mc: carrier.mcNumber || null, dot: carrier.dotNumber || null, address: [carrier.address, carrier.city, carrier.state, carrier.zip].filter(Boolean).join(', ') || null } : null,
    remitTo: carrier ? [carrier.companyName, [carrier.address, carrier.city, carrier.state, carrier.zip].filter(Boolean).join(', ')].filter(Boolean).join('\n') : null,
    terms: terms || null,
    autoRemind,
    payments: [],
  };
}

/** Create an invoice with the owner's next number (retries when a concurrent create took it). */
export async function createWithNumber(data, { attempts = 8 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const max = await prisma.invoice.aggregate({ where: { ownerId: data.ownerId }, _max: { number: true } });
    const number = Math.max(FIRST_NUMBER - 1, max._max.number ?? 0) + 1;
    try {
      return await prisma.invoice.create({ data: { ...data, number } });
    } catch (err) {
      if (err?.code !== 'P2002' && !/Unique constraint/i.test(String(err?.message))) throw err;
    }
  }
  throw conflict('Could not number the invoice. Try again.');
}

/**
 * Factoring summary of an invoice, or null when it was never submitted to a factoring company and has no factoring
 * payments. reservePendingCents is the open balance once an advance is recorded (the reserve the factoring company
 * still holds, before any fee not yet recorded), else 0.
 */
export function factoringSummary(inv, meta) {
  const payments = Array.isArray(meta?.payments) ? meta.payments : [];
  const factored = payments.some((p) => p?.kind && p.kind !== 'payment');
  if (!meta?.factoring && !factored) return null;
  const sum = (kind) => payments.filter((p) => p?.kind === kind).reduce((s, p) => s + (Number(p.amountCents) || 0), 0);
  const advancedCents = sum('advance');
  const balance = Math.max(0, (inv.amountCents || 0) - (inv.paidCents || 0));
  return {
    companyName: meta.factoring?.name ?? null,
    submittedAt: meta.factoring?.submittedAt ?? null,
    advancedCents,
    feeCents: sum('fee'),
    reserveReleasedCents: sum('reserve'),
    reservePendingCents: advancedCents > 0 && inv.status !== 'void' ? balance : 0,
  };
}

/**
 * Amounts a factored invoice usually settles in, from the carrier's terms: advance = amount x advance %, fee = amount x
 * fee %, reserve = amount - advance - fee (cents, rounded). Each is null when the terms it needs are missing.
 */
export function suggestedFactoring(amountCents, advancePct, feePct) {
  const amount = Number(amountCents) || 0;
  const advanceCents = advancePct != null ? Math.round((amount * advancePct) / 100) : null;
  const feeCents = feePct != null ? Math.round((amount * feePct) / 100) : null;
  const reserveCents = advanceCents != null && feeCents != null ? Math.max(0, amount - advanceCents - feeCents) : null;
  return { advanceCents, feeCents, reserveCents };
}

/** API view: items, meta, balance and age, and the factoring summary (null when not factored). */
export function invoiceView(inv, now = new Date()) {
  const { items, meta } = parseInvoiceData(inv.lines);
  const balanceCents = Math.max(0, (inv.amountCents || 0) - (inv.paidCents || 0));
  const open = OPEN_STATUSES.includes(inv.status);
  const due = pastDue(inv, now);
  const { lines, ...rest } = inv;
  return {
    ...rest,
    items,
    meta,
    balanceCents,
    overdue: due.overdue,
    daysOverdue: due.days,
    ageDays: open && inv.issuedAt ? Math.max(0, Math.floor((now.getTime() - new Date(inv.issuedAt).getTime()) / DAY)) : null,
    factoring: factoringSummary(inv, meta),
  };
}

export const AGING_BUCKETS = [
  { key: '0_30', label: '0-30 days' },
  { key: '31_60', label: '31-60 days' },
  { key: '61_90', label: '61-90 days' },
  { key: '90_plus', label: 'Over 90 days' },
];

/**
 * Receivables aging for open invoices (sent or partly paid), by days since the invoice was issued, plus what is
 * past its due date. One GROUP BY over the owner-bounded Invoice(ownerId, status, dueAt) index.
 */
export async function agingSummary(ownerIds, { kind, now = new Date() } = {}) {
  const b30 = new Date(now.getTime() - 30 * DAY);
  const b60 = new Date(now.getTime() - 60 * DAY);
  const b90 = new Date(now.getTime() - 90 * DAY);
  const where = [Prisma.sql`ownerId IN (${Prisma.join(ownerIds)})`, Prisma.sql`status IN ('sent', 'partial')`];
  if (kind) where.push(Prisma.sql`kind = ${kind}`);
  const rows = await prisma.$queryRaw`
    SELECT CASE WHEN issuedAt IS NULL OR issuedAt >= ${b30} THEN '0_30'
                WHEN issuedAt >= ${b60} THEN '31_60'
                WHEN issuedAt >= ${b90} THEN '61_90'
                ELSE '90_plus' END AS bucket,
           COUNT(*) AS n,
           SUM(amountCents - paidCents) AS openCents,
           SUM(CASE WHEN dueAt IS NOT NULL AND dueAt < ${now} THEN amountCents - paidCents ELSE 0 END) AS overdueCents,
           SUM(CASE WHEN dueAt IS NOT NULL AND dueAt < ${now} THEN 1 ELSE 0 END) AS overdueCount
    FROM Invoice
    WHERE ${Prisma.join(where, ' AND ')}
    GROUP BY bucket`;
  const byKey = new Map(rows.map((r) => [r.bucket, r]));
  const buckets = AGING_BUCKETS.map((b) => {
    const r = byKey.get(b.key);
    return { ...b, count: Number(r?.n ?? 0), openCents: Number(r?.openCents ?? 0) };
  });
  return {
    buckets,
    openCents: buckets.reduce((s, b) => s + b.openCents, 0),
    openCount: buckets.reduce((s, b) => s + b.count, 0),
    overdueCents: rows.reduce((s, r) => s + Number(r.overdueCents ?? 0), 0),
    overdueCount: rows.reduce((s, r) => s + Number(r.overdueCount ?? 0), 0),
  };
}

// ---------------------------------------------------------------------------
// CSV export (QuickBooks Online invoice import layout: one row per line item)
// ---------------------------------------------------------------------------

export const QB_COLUMNS = ['InvoiceNo', 'Customer', 'InvoiceDate', 'DueDate', 'Terms', 'Memo', 'Item(Product/Service)', 'ItemDescription', 'ItemQuantity', 'ItemRate', 'ItemAmount', 'Service Date'];
const QB_ITEM = { linehaul: 'Freight', detention: 'Detention', tonu: 'TONU', lumper: 'Lumper reimbursement', layover: 'Layover', fee: 'Dispatch fee', other: 'Other' };

function usDate(d, tz) {
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Chicago', month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(d));
  } catch {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(d));
  }
}
// Spreadsheet-formula guard (lib/csv.js, shared with the carrier export). A plain number such as "-50.00" (a credit
// line) is not a formula and stays numeric so QuickBooks imports the amount. Re-exported for existing importers.
export { safeCell };

export function csvRows(invoices, tz) {
  const rows = [];
  for (const inv of invoices) {
    const { items, meta } = parseInvoiceData(inv.lines);
    const memo = [meta.reference && `Ref ${meta.reference}`, meta.lane, meta.carrier?.name && inv.kind === 'freight' && `Carrier ${meta.carrier.name}`].filter(Boolean).join(' · ');
    const lines = items.length ? items : [{ kind: 'other', description: 'Invoice total', quantity: 1, unitCents: inv.amountCents, amountCents: inv.amountCents }];
    for (const l of lines) {
      rows.push([
        inv.number, inv.billToName, usDate(inv.issuedAt || inv.createdAt, tz), usDate(inv.dueAt, tz), meta.terms || '', memo,
        QB_ITEM[l.kind] || 'Other', l.description, l.quantity, (l.unitCents / 100).toFixed(2), (l.amountCents / 100).toFixed(2),
        meta.deliveryDate ? usDate(`${meta.deliveryDate}T12:00:00Z`, 'UTC') : '',
      ].map(safeCell));
    }
  }
  return rows;
}
