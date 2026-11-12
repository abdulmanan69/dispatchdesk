import { Router } from 'express';
import { stringify } from 'csv-stringify/sync';
import { prisma } from '../db.js';
import { ah, badRequest, conflict } from '../lib/errors.js';
import { parse, z, optStr, optDate, pageQuery, paginate, pageResult } from '../lib/validate.js';
import { requirePermission, refuseApiToken } from '../middleware/auth.js';
import { loadCarrier, loadOwned, ownerWhere, readableOwnerIds, userCanReadCarrier } from '../lib/access.js';
import { logActivity } from '../lib/activity.js';
import { withLock, LockBusyError } from '../lib/locks.js';
import { localDayKey } from '../lib/timezones.js';
import { queueUserEmail } from '../services/email/compose.js';
import { MAX_ATTACHMENTS } from '../services/email/attachments.js';
import { assertTransition, afterStatusChange } from '../services/loads/status.js';
import { invalidateToday } from '../services/fleet/today.js';
import {
  INVOICE_KINDS, OPEN_STATUSES, LINE_KINDS, DEFAULT_DUE_DAYS, DISPATCH_FEE_DUE_DAYS, PAYMENT_KINDS, PAYMENT_LABEL,
  parseInvoiceData, serializeInvoiceData, normalizeLines, totalOf, termsDays, linesForLoad, metaForLoad,
  createWithNumber, invoiceView, agingSummary, csvRows, QB_COLUMNS, effectiveDueAt, suggestedFactoring,
} from '../services/invoices/index.js';
import { stageFor } from '../services/invoices/reminders.js';
import { invoiceHtml, invoiceText, brandLogo, factoringEmail } from '../services/invoices/print.js';
import { invoicePdf, storeInvoicePdf, storedInvoicePdf } from '../services/invoices/pdf.js';

/**
 * Invoices and receivables.
 *   GET    /                 list (status: all|draft|open|overdue|paid|void, kind, q) + aging and totals
 *   GET    /export.csv       QuickBooks Online import layout (one row per line item)
 *   GET    /loads            delivered loads that can be invoiced (for the create dialog)
 *   POST   /                 { loadId, kind, remitTo? } -> draft prefilled from the load (409 when one already exists);
 *                            a freight invoice for a factored carrier gets the factoring company's remit-to
 *   GET    /:id              one invoice, the load's documents and the carrier's factoring terms (factoringTerms)
 *   PATCH  /:id              edit (line items only while draft)
 *   POST   /:id/send         email from the user's mailbox (queueUserEmail, with POD/BOL attachments) and mark sent
 *   POST   /:id/mark-sent    mark sent without emailing (e.g. sent through the factoring company)
 *   POST   /:id/payments     record a payment (partial or full); kind: payment | advance | reserve | fee (factoring)
 *   POST   /:id/void         void an unpaid invoice
 *   DELETE /:id              delete a draft
 *   GET    /:id/print        printable HTML page
 *   GET    /:id/pdf          PDF download
 *   GET    /:id/factoring-packet    what "Send to factoring" would send: to, attachments, missing paperwork, subject, body
 *   POST   /:id/send-to-factoring   email the invoice PDF and the load's paperwork to the carrier's factoring company
 * Freight invoices move their load forward: sent -> load invoiced (from delivered), paid in full -> load paid.
 */
const r = Router();
r.use(requirePermission('crm.use'));
// The Today board lists overdue invoices: drop its cached copy after any successful change here.
r.use((req, res, next) => {
  if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) invalidateToday(req.user.id); });
  next();
});

const DAY = 86_400_000;
// A second send of the same invoice within this time is treated as a double click and refused.
const RESEND_GAP_MS = 60_000;
const INVOICEABLE = ['delivered', 'invoiced', 'paid'];
const includeRefs = {
  load: { select: { id: true, referenceNumber: true, originCity: true, originState: true, destCity: true, destState: true, status: true, carrierId: true, brokerId: true } },
  broker: { select: { id: true, companyName: true, email: true } },
  carrier: { select: { id: true, companyName: true, email: true } },
};

/** Who an invoice is from: the carrier for freight invoices (prepared by the dispatcher), the dispatcher for fees. */
async function issuer(user, inv) {
  const teamName = user.teamMembership?.team?.name
    || (user.teamMembership?.teamId ? (await prisma.team.findUnique({ where: { id: user.teamMembership.teamId }, select: { name: true } }))?.name : null);
  const dispatcher = teamName || user.name;
  if (inv.kind === 'freight' && inv.meta?.carrier?.name) {
    const c = inv.meta.carrier;
    return { from: { name: c.name, lines: [c.address, [c.mc && `MC ${c.mc}`, c.dot && `USDOT ${c.dot}`].filter(Boolean).join(' · ')] }, preparedBy: dispatcher };
  }
  return { from: { name: dispatcher, lines: [user.email, user.phone].filter(Boolean) }, preparedBy: null };
}

async function loadInvoice(user, id, write = false) {
  return loadOwned('invoice', user, id, { write, include: includeRefs });
}

/** Move a freight invoice's load forward (never backward) with the usual status side effects. */
async function advanceLoad(user, inv, to) {
  if (inv.kind !== 'freight' || !inv.loadId) return;
  const load = await prisma.load.findUnique({ where: { id: inv.loadId } });
  if (!load) return;
  const order = ['delivered', 'invoiced', 'paid'];
  if (order.indexOf(load.status) < 0 || order.indexOf(load.status) >= order.indexOf(to)) return;
  assertTransition(load.status, to);
  const updated = await prisma.load.update({ where: { id: load.id }, data: { status: to } });
  await afterStatusChange(user, load, updated, { source: 'system' });
}

/**
 * The carrier's customer record with its factoring company and terms, or null (not a customer, or a carrier the user
 * may not read).
 */
async function carrierFactoring(user, carrierId) {
  if (!carrierId) return null;
  const customer = await prisma.customer.findUnique({
    where: { carrierId },
    select: {
      id: true, ownerId: true, factoringClientNo: true, factoringAdvancePct: true, factoringFeePct: true, factoringRecourse: true,
      factoringCompany: { select: { id: true, name: true, submitEmail: true, remitTo: true, phone: true } },
      carrier: { select: { id: true, ownerId: true, assignedToId: true, companyName: true, mcNumber: true, dotNumber: true } },
    },
  });
  if (!customer || !(await userCanReadCarrier(user, customer.carrier))) return null;
  return customer;
}

/** The carrier's factoring terms for an invoice, with the amounts they suggest; null when the carrier does not factor. */
function factoringTermsView(customer, amountCents) {
  if (!customer) return null;
  const c = customer;
  if (!c.factoringCompany && c.factoringAdvancePct == null && c.factoringFeePct == null) return null;
  return {
    customerId: c.id,
    companyId: c.factoringCompany?.id ?? null,
    companyName: c.factoringCompany?.name ?? null,
    submitEmail: c.factoringCompany?.submitEmail ?? null,
    remitTo: c.factoringCompany?.remitTo ?? null,
    clientNo: c.factoringClientNo ?? null,
    advancePct: c.factoringAdvancePct ?? null,
    feePct: c.factoringFeePct ?? null,
    recourse: c.factoringRecourse ?? null,
    suggested: suggestedFactoring(amountCents, c.factoringAdvancePct, c.factoringFeePct),
  };
}

/** Why an invoice cannot go to a factoring company yet (a user-facing sentence), or null when it can. */
function factoringProblem(inv, customer) {
  if (inv.kind !== 'freight') return 'Only freight invoices go to a factoring company';
  if (!inv.carrierId) return 'Assign the carrier to the load first';
  if (!customer) return 'Make the carrier a customer and pick its factoring company on the customer profile first';
  if (!customer.factoringCompany) return 'Pick the carrier’s factoring company on its customer profile first';
  if (!customer.factoringCompany.submitEmail) return 'Add the factoring company’s submission email on the carrier’s profile';
  return null;
}

// What a factoring company needs with the invoice. Most reject a packet without the rate confirmation and the POD.
const PACKET_TYPES = ['rate_confirmation', 'bol', 'pod'];

/** The load's documents (generated invoice PDFs left out), the latest rate con, BOL and POD, and which are missing. */
async function packetDocuments(inv) {
  const docs = inv.loadId
    ? await prisma.document.findMany({ where: { loadId: inv.loadId, type: { not: 'invoice' } }, orderBy: { createdAt: 'desc' }, take: 200, select: { id: true, type: true, originalName: true, sizeBytes: true, createdAt: true } })
    : [];
  const picks = PACKET_TYPES.map((t) => docs.find((d) => d.type === t)).filter(Boolean);
  return { docs, picks, missing: PACKET_TYPES.filter((t) => !picks.some((d) => d.type === t)) };
}

/**
 * Change an invoice's meta without losing a change made at the same moment (a payment): compare-and-set on
 * updatedAt, retried with a fresh read.
 */
async function updateMeta(id, change) {
  for (let i = 0; i < 5; i += 1) {
    const cur = await prisma.invoice.findUnique({ where: { id } });
    const { items, meta } = parseInvoiceData(cur.lines);
    try {
      return await prisma.invoice.update({
        where: { id, updatedAt: cur.updatedAt },
        data: { lines: serializeInvoiceData({ items, meta: change(meta) }) },
        include: includeRefs,
      });
    } catch (err) {
      if (err?.code !== 'P2025') throw err;
    }
  }
  throw conflict('This invoice changed while it was being updated. Reload it and try again.');
}

const listQuery = z.object({
  ...pageQuery,
  status: z.enum(['all', 'draft', 'open', 'overdue', 'paid', 'void']).default('all'),
  kind: z.enum(INVOICE_KINDS).optional(),
  q: z.string().trim().max(100).optional(),
  brokerId: z.string().max(40).optional(),
  carrierId: z.string().max(40).optional(),
  loadId: z.string().max(40).optional(),
  scope: z.enum(['mine', 'team']).default('mine'),
});

function listWhere(base, q, now) {
  const where = { ...base };
  if (q.status === 'draft' || q.status === 'paid' || q.status === 'void') where.status = q.status;
  else if (q.status === 'open') where.status = { in: OPEN_STATUSES };
  else if (q.status === 'overdue') Object.assign(where, { status: { in: OPEN_STATUSES }, dueAt: { lt: now } });
  if (q.kind) where.kind = q.kind;
  if (q.brokerId) where.brokerId = q.brokerId;
  if (q.carrierId) where.carrierId = q.carrierId;
  if (q.loadId) where.loadId = q.loadId;
  if (q.q) {
    const n = Number(q.q.replace(/^#/, ''));
    where.OR = [{ billToName: { contains: q.q } }, ...(Number.isInteger(n) && n > 0 ? [{ number: n }] : [])];
  }
  return where;
}

r.get('/', ah(async (req, res) => {
  const q = parse(listQuery, req.query);
  const now = new Date();
  const ids = await readableOwnerIds(req.user, q.scope);
  const base = ids.length === 1 ? { ownerId: ids[0] } : { ownerId: { in: ids } };
  const where = listWhere(base, q, now);
  const orderBy = ['open', 'overdue'].includes(q.status) ? [{ dueAt: 'asc' }, { number: 'desc' }] : [{ number: 'desc' }];
  const monthAgo = new Date(now.getTime() - 30 * DAY);
  const [rows, total, aging, counts, collected] = await Promise.all([
    prisma.invoice.findMany({ where, orderBy, ...paginate(q), include: includeRefs }),
    prisma.invoice.count({ where }),
    agingSummary(ids, { kind: q.kind, now }),
    prisma.invoice.groupBy({ by: ['status'], where: { ...base, ...(q.kind ? { kind: q.kind } : {}) }, _count: true }),
    prisma.invoice.aggregate({ where: { ...base, status: 'paid', paidAt: { gte: monthAgo }, ...(q.kind ? { kind: q.kind } : {}) }, _sum: { amountCents: true }, _count: true }),
  ]);
  res.json({
    ...pageResult(rows.map((inv) => invoiceView(inv, now)), total, q),
    aging,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    collected30d: { cents: collected._sum.amountCents || 0, count: collected._count },
  });
}));

r.get('/export.csv', ah(async (req, res) => {
  refuseApiToken(req, 'export invoices');
  const q = parse(z.object({
    status: z.enum(['issued', 'open', 'paid']).default('issued'),
    kind: z.enum(INVOICE_KINDS).optional(),
    from: optDate, to: optDate,
    scope: z.enum(['mine', 'team']).default('mine'),
  }), req.query);
  // Drafts and void invoices never go to the books.
  const where = { ...(await ownerWhere(req.user, q.scope)) };
  where.status = q.status === 'open' ? { in: OPEN_STATUSES } : q.status === 'paid' ? 'paid' : { in: ['sent', 'partial', 'paid'] };
  if (q.kind) where.kind = q.kind;
  if (q.from || q.to) where.issuedAt = { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: new Date(q.to.getTime() + DAY - 1) } : {}) };
  const rows = await prisma.invoice.findMany({ where, orderBy: { number: 'asc' }, take: 5000 });
  const csv = stringify([QB_COLUMNS, ...csvRows(rows, req.user.timezone)]);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', `attachment; filename="invoices-${localDayKey(req.user.timezone)}.csv"`);
  res.send(`﻿${csv}`);
}));

/** Loads that can be invoiced: delivered or later (or canceled with a TONU), newest first, with existing invoices. */
r.get('/loads', ah(async (req, res) => {
  const q = parse(z.object({ q: z.string().trim().max(100).optional(), scope: z.enum(['mine', 'team']).default('mine') }), req.query);
  const where = { ...(await ownerWhere(req.user, q.scope)), OR: [{ status: { in: INVOICEABLE } }, { status: 'canceled', tonuCents: { gt: 0 } }] };
  if (q.q) where.AND = [{ OR: [{ referenceNumber: { contains: q.q } }, { originCity: { contains: q.q } }, { destCity: { contains: q.q } }] }];
  const loads = await prisma.load.findMany({
    where, orderBy: [{ deliveryDate: 'desc' }, { createdAt: 'desc' }], take: 50,
    select: {
      id: true, referenceNumber: true, originCity: true, originState: true, destCity: true, destState: true, status: true, rateCents: true,
      deliveryDate: true, pickupDate: true, tonuCents: true,
      broker: { select: { id: true, companyName: true } }, carrier: { select: { id: true, companyName: true } },
      invoices: { where: { status: { not: 'void' } }, select: { id: true, number: true, kind: true, status: true } },
    },
  });
  res.json({ items: loads });
}));

r.post('/', ah(async (req, res) => {
  const body = parse(z.object({ loadId: z.string().min(1).max(40), kind: z.enum(INVOICE_KINDS).default('freight'), autoRemind: z.boolean().optional(), remitTo: optStr(500) }), req.body);
  const load = await loadOwned('load', req.user, body.loadId, { write: true, include: { broker: true, carrier: true } });
  const tonu = load.status === 'canceled' && load.tonuCents > 0;
  if (!INVOICEABLE.includes(load.status) && !tonu) throw badRequest('Invoice a load once it is delivered (or record a TONU first)');
  // One create at a time per load and kind (two tabs, a retry, two cluster workers): the existence check and the insert
  // run under a database lock, so a double click cannot make two invoices with different numbers.
  let inv;
  let billTo;
  try {
    ({ inv, billTo } = await withLock(`invoice.create.${load.id}.${body.kind}`, 30_000, () => createDraft(req.user, load, body)));
  } catch (err) {
    if (err instanceof LockBusyError) throw conflict('This invoice is being created already. Refresh in a moment.');
    throw err;
  }
  await logActivity(req.user, { type: 'load', carrierId: load.carrierId, summary: `Drafted ${body.kind === 'freight' ? 'freight' : 'dispatch fee'} invoice #${inv.number} for ${billTo.billToName}` });
  const full = await prisma.invoice.findUnique({ where: { id: inv.id }, include: includeRefs });
  res.status(201).json({ invoice: invoiceView(full) });
}));

async function createDraft(user, load, body) {
  const existing = await prisma.invoice.findFirst({ where: { loadId: load.id, kind: body.kind, status: { not: 'void' } }, select: { id: true, number: true } });
  if (existing) throw conflict(`Invoice #${existing.number} already exists for this load`, { invoiceId: existing.id });

  let billTo;
  let items;
  let dueDays;
  let terms = null;
  if (body.kind === 'freight') {
    if (!load.broker) throw badRequest('Add the broker to the load before invoicing it');
    billTo = { brokerId: load.broker.id, billToName: load.broker.companyName, billToEmail: load.broker.email || null };
    items = linesForLoad(load, 'freight');
    dueDays = termsDays(load.broker.paymentTerms, load.broker.daysToPay) ?? DEFAULT_DUE_DAYS;
    terms = load.broker.paymentTerms || `Net ${dueDays}`;
  } else {
    if (!load.carrier) throw badRequest('Assign the carrier to the load before billing the dispatch fee');
    await loadCarrier(user, load.carrier.id);
    const customer = await prisma.customer.findUnique({ where: { carrierId: load.carrier.id }, select: { dispatchFeePercent: true } });
    items = linesForLoad(load, 'dispatch_fee', { feePercent: customer?.dispatchFeePercent });
    if (!items.length) throw badRequest('Set a dispatch fee % on the load or the customer first');
    const primary = await prisma.carrierContact.findFirst({ where: { carrierId: load.carrier.id, email: { not: null } }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], select: { email: true } });
    billTo = { billToName: load.carrier.companyName, billToEmail: load.carrier.email || primary?.email || null };
    dueDays = DISPATCH_FEE_DUE_DAYS;
    terms = `Net ${dueDays}`;
  }
  const meta = metaForLoad(load, { carrier: load.carrier, terms, autoRemind: !!body.autoRemind });
  // The resolved term length (it may come from the broker's days-to-pay, which "Quick pay" or "COD" terms do not
  // spell out), so the due date set when the invoice is sent is the one the broker sees in the email.
  meta.dueDays = dueDays;
  if (body.kind === 'dispatch_fee') meta.remitTo = null;
  if (body.remitTo) meta.remitTo = body.remitTo;
  else if (body.kind === 'freight') {
    // A factored carrier's freight is paid to its factoring company: under a notice of assignment the invoice must say so.
    const company = (await carrierFactoring(user, load.carrierId))?.factoringCompany;
    if (company?.remitTo) meta.remitTo = `${company.name}\n${company.remitTo}`;
  }
  const inv = await createWithNumber({
    ownerId: load.ownerId, kind: body.kind, status: 'draft', loadId: load.id, carrierId: load.carrierId, ...billTo,
    lines: serializeInvoiceData({ items, meta }), amountCents: totalOf(items),
    dueAt: new Date(Date.now() + dueDays * DAY),
  });
  return { inv, billTo };
}

r.get('/:id', ah(async (req, res) => {
  const inv = await loadInvoice(req.user, req.params.id);
  const [docs, customer] = await Promise.all([
    inv.loadId
      ? prisma.document.findMany({ where: { loadId: inv.loadId }, orderBy: { createdAt: 'desc' }, select: { id: true, type: true, originalName: true, sizeBytes: true } })
      : [],
    inv.kind === 'freight' ? carrierFactoring(req.user, inv.carrierId) : null,
  ]);
  res.json({ invoice: invoiceView(inv), documents: docs, factoringTerms: factoringTermsView(customer, inv.amountCents) });
}));

const lineSchema = z.object({
  kind: z.enum(LINE_KINDS).default('other'),
  description: z.string().trim().min(1, 'Describe each line').max(300),
  quantity: z.coerce.number().min(0).max(100000),
  unitCents: z.coerce.number().int().min(-1e9).max(1e9),
});

r.patch('/:id', ah(async (req, res) => {
  const inv = await loadInvoice(req.user, req.params.id, true);
  if (inv.status === 'void') throw badRequest('This invoice is void');
  const body = parse(z.object({
    items: z.array(lineSchema).min(1).max(50).optional(),
    billToName: z.string().trim().min(1).max(200).optional(),
    billToEmail: z.preprocess((v) => (v === '' ? null : v), z.string().trim().toLowerCase().email().max(254).nullable().optional()),
    dueAt: optDate,
    notes: optStr(2000),
    remitTo: optStr(500),
    terms: optStr(80),
    autoRemind: z.boolean().optional(),
  }), req.body);
  if (body.items && inv.status !== 'draft') throw badRequest('Line items can only change while the invoice is a draft. Void it and create a new one.');
  const { items, meta } = parseInvoiceData(inv.lines);
  const nextItems = body.items ? normalizeLines(body.items) : items;
  const amountCents = totalOf(nextItems);
  if (amountCents < 0) throw badRequest('The invoice total cannot be negative');
  const nextMeta = { ...meta };
  if (body.remitTo !== undefined) nextMeta.remitTo = body.remitTo;
  if (body.terms !== undefined) {
    nextMeta.terms = body.terms;
    // New terms on a draft set the term length when they name one ("Net 15"); otherwise the earlier length stays.
    const days = inv.status === 'draft' ? termsDays(body.terms, null) : null;
    if (days != null) nextMeta.dueDays = days;
  }
  if (body.autoRemind !== undefined) nextMeta.autoRemind = body.autoRemind;
  // A due date the user picks on a draft is kept when it is sent (otherwise it counts from the send date).
  if (body.dueAt !== undefined && inv.status === 'draft') nextMeta.dueFixed = body.dueAt != null;
  const data = { lines: serializeInvoiceData({ items: nextItems, meta: nextMeta }), amountCents };
  if (body.billToName !== undefined) data.billToName = body.billToName;
  if (body.billToEmail !== undefined) data.billToEmail = body.billToEmail;
  if (body.dueAt !== undefined) data.dueAt = body.dueAt;
  const dueChanged = body.dueAt !== undefined && (body.dueAt ? new Date(body.dueAt).getTime() : null) !== (inv.dueAt ? new Date(inv.dueAt).getTime() : null);
  if (dueChanged && inv.status !== 'draft') {
    // Collection reminders follow the new date: none sent yet for a future date, else the stage it is now at (a plain
    // reset would resend the "due" reminder at once for a date already past).
    const days = body.dueAt ? Math.floor((Date.now() - new Date(body.dueAt).getTime()) / DAY) : -1;
    data.reminderCount = body.dueAt && days >= 0 ? stageFor(days) : 0;
    data.lastReminderAt = null;
  }
  if (body.notes !== undefined) data.notes = body.notes;
  if (amountCents < inv.paidCents) throw badRequest('The total cannot be less than what has been paid');
  const updated = await prisma.invoice.update({ where: { id: inv.id }, data, include: includeRefs });
  res.json({ invoice: invoiceView(updated) });
}));

/** Mark sent: issue date (first time), due date from the terms unless the user picked one, status sent. */
async function markSent(user, inv, now = new Date()) {
  const issuedAt = inv.issuedAt || now;
  const data = { sentAt: now, issuedAt };
  if (inv.status === 'draft') {
    data.status = 'sent';
    // A draft's due date counts from the day it is issued, unless the user set one (effectiveDueAt).
    data.dueAt = effectiveDueAt(inv, issuedAt);
  }
  const updated = await prisma.invoice.update({ where: { id: inv.id }, data, include: includeRefs });
  await advanceLoad(user, updated, 'invoiced');
  return updated;
}

r.post('/:id/send', ah(async (req, res) => {
  refuseApiToken(req, 'send invoices');
  const first = await loadInvoice(req.user, req.params.id, true);
  // One send at a time per invoice (two clicks, two tabs, two workers): the broker never gets it twice.
  try {
    await withLock(`invoice.send.${first.id}`, 120_000, () => sendInvoice(req, res, first));
  } catch (err) {
    if (err instanceof LockBusyError) throw conflict('This invoice is being sent already.');
    throw err;
  }
}));

async function sendInvoice(req, res, first) {
  const inv = await loadInvoice(req.user, first.id, true);
  // Sent by another request since this one started, or a moment ago (a double click, a retried request): do not email
  // the broker again. Sending it again later is allowed.
  const sentMs = inv.sentAt ? new Date(inv.sentAt).getTime() : null;
  if (sentMs && ((first.sentAt ? new Date(first.sentAt).getTime() : null) !== sentMs || Date.now() - sentMs < RESEND_GAP_MS)) {
    throw conflict('This invoice was just sent. Try again in a minute to send it again.', { invoiceId: inv.id });
  }
  if (['void', 'paid'].includes(inv.status)) throw badRequest(`This invoice is ${inv.status}`);
  if (!inv.amountCents) throw badRequest('Add at least one line with an amount before sending');
  const body = parse(z.object({
    toEmail: z.string().trim().toLowerCase().email().max(254).optional(),
    subject: z.string().trim().max(300).optional(),
    body: z.string().max(20000).optional(),
    documentIds: z.array(z.string().max(40)).max(5).optional(),
    accountId: z.string().max(40).optional(),
  }), req.body);
  const toEmail = body.toEmail || inv.billToEmail;
  if (!toEmail) throw badRequest('Add the bill-to email address first');
  const view = invoiceView(inv);
  const who = await issuer(req.user, view);
  // Issue date and due date as markSent will store them, so the email and the record agree.
  const issuedAt = inv.issuedAt || new Date();
  const preview = { ...view, issuedAt, dueAt: inv.status === 'draft' ? effectiveDueAt(inv, issuedAt) : inv.dueAt };
  const result = await queueUserEmail({
    user: req.user, toEmail,
    brokerId: inv.kind === 'freight' ? inv.brokerId : null,
    carrierId: inv.kind === 'dispatch_fee' ? inv.carrierId : null,
    subject: body.subject || `Invoice #${inv.number}${view.meta.reference ? ` · load ${view.meta.reference}` : ''}`,
    body: body.body?.trim() ? body.body : invoiceText(preview, { from: who.from, tz: req.user.timezone }),
    documentIds: body.documentIds || [],
    accountId: body.accountId,
  });
  if (result.outcome === 'failed') return res.status(502).json({ error: result.message || 'The email could not be sent', outcome: result.outcome, invoice: view });
  const updated = await markSent(req.user, { ...inv, issuedAt });
  if (body.toEmail && !inv.billToEmail) await prisma.invoice.update({ where: { id: inv.id }, data: { billToEmail: body.toEmail } });
  await logActivity(req.user, { type: 'load', carrierId: inv.carrierId, summary: `Sent invoice #${inv.number} to ${toEmail}` });
  return res.json({ invoice: invoiceView(updated), outcome: result.outcome, message: result.message });
}

r.post('/:id/mark-sent', ah(async (req, res) => {
  const inv = await loadInvoice(req.user, req.params.id, true);
  if (inv.status !== 'draft') throw badRequest('Only a draft can be marked sent');
  if (!inv.amountCents) throw badRequest('Add at least one line with an amount first');
  res.json({ invoice: invoiceView(await markSent(req.user, inv)) });
}));

r.post('/:id/payments', ah(async (req, res) => {
  const inv = await loadInvoice(req.user, req.params.id, true);
  if (!OPEN_STATUSES.includes(inv.status)) throw badRequest(inv.status === 'draft' ? 'Send the invoice (or mark it sent) before recording payments' : `This invoice is ${inv.status}`);
  const balance = inv.amountCents - inv.paidCents;
  const body = parse(z.object({
    amountCents: z.coerce.number().int().min(1, 'Enter the amount received').max(1e9).optional(),
    full: z.boolean().optional(),
    paidAt: optDate,
    method: optStr(40),
    reference: optStr(80),
    // payment: money received (default). Factored invoices: advance (from the factoring company), reserve (released
    // later), fee (kept by the factoring company: it settles that part of the invoice but is not money received).
    kind: z.enum(PAYMENT_KINDS).default('payment'),
  }), req.body);
  if (body.kind !== 'payment' && inv.kind !== 'freight') throw badRequest('Factoring amounts apply to freight invoices only');
  const amount = body.full ? balance : body.amountCents;
  if (!amount) throw badRequest(body.kind === 'fee' ? 'Enter the fee amount' : 'Enter the amount received');
  if (amount > balance) throw badRequest(`That is more than the open balance of $${(balance / 100).toFixed(2)}`);
  const at = body.paidAt || new Date();
  const { items, meta } = parseInvoiceData(inv.lines);
  const payments = [...(meta.payments || []), { amountCents: amount, at: at.toISOString(), method: body.method || null, reference: body.reference || null, by: req.user.name, kind: body.kind }].slice(-50);
  const paidCents = inv.paidCents + amount;
  const paid = paidCents >= inv.amountCents;
  // Optimistic guard: a payment recorded at the same moment (another tab or worker) must not be overwritten, nor a
  // change to the invoice's other details (a factoring submission) made since it was read.
  const updated = await prisma.invoice.update({
    where: { id: inv.id, paidCents: inv.paidCents, status: inv.status, updatedAt: inv.updatedAt },
    data: { paidCents, status: paid ? 'paid' : 'partial', paidAt: paid ? at : null, lines: serializeInvoiceData({ items, meta: { ...meta, payments } }) },
    include: includeRefs,
  }).catch((err) => {
    if (err?.code === 'P2025') throw conflict('This invoice changed while the payment was being recorded. Reload it and try again.');
    throw err;
  });
  if (paid) await advanceLoad(req.user, updated, 'paid');
  const what = body.kind === 'payment' ? 'paid' : PAYMENT_LABEL[body.kind].toLowerCase();
  await logActivity(req.user, { type: 'load', carrierId: inv.carrierId, summary: `Recorded $${(amount / 100).toFixed(2)} ${what} on invoice #${inv.number}${paid ? ' (paid in full)' : ''}` });
  res.json({ invoice: invoiceView(updated) });
}));

r.post('/:id/void', ah(async (req, res) => {
  const inv = await loadInvoice(req.user, req.params.id, true);
  if (inv.status === 'void') return res.json({ invoice: invoiceView(inv) });
  if (inv.paidCents > 0) throw badRequest('This invoice has payments recorded and cannot be voided');
  const updated = await prisma.invoice.update({ where: { id: inv.id, paidCents: 0 }, data: { status: 'void' }, include: includeRefs }).catch((err) => {
    if (err?.code === 'P2025') throw conflict('A payment was just recorded on this invoice, so it cannot be voided.');
    throw err;
  });
  await logActivity(req.user, { type: 'load', carrierId: inv.carrierId, summary: `Voided invoice #${inv.number}` });
  res.json({ invoice: invoiceView(updated) });
}));

r.delete('/:id', ah(async (req, res) => {
  const inv = await loadInvoice(req.user, req.params.id, true);
  if (inv.status !== 'draft') throw badRequest('Only drafts can be deleted. Void a sent invoice instead.');
  await prisma.invoice.delete({ where: { id: inv.id } });
  res.json({ ok: true });
}));

r.get('/:id/print', ah(async (req, res) => {
  const inv = await loadInvoice(req.user, req.params.id);
  const view = invoiceView(inv);
  const who = await issuer(req.user, view);
  res.set('Cache-Control', 'private, no-store');
  // The dispatcher's logo goes on their own dispatch-fee invoices only: freight invoices are issued in the carrier's name.
  res.type('html').send(invoiceHtml(view, { ...who, tz: req.user.timezone, logo: inv.kind === 'dispatch_fee' ? await brandLogo(inv.ownerId) : null }));
}));

r.get('/:id/pdf', ah(async (req, res) => {
  const inv = await loadInvoice(req.user, req.params.id);
  const view = invoiceView(inv);
  const who = await issuer(req.user, view);
  // Same rule as the printable page: the dispatcher's logo only on their own dispatch-fee invoices.
  const pdf = await invoicePdf(view, { ...who, tz: req.user.timezone, logo: inv.kind === 'dispatch_fee' ? await brandLogo(inv.ownerId) : null });
  res.set('Content-Type', 'application/pdf');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', `attachment; filename="invoice-${inv.number}.pdf"`);
  res.send(Buffer.from(pdf));
}));

/**
 * What "Send to factoring" sends, for the confirmation dialog: the factoring company's submission address, the default
 * attachments (the invoice PDF, made at send time, and the load's latest rate con, BOL and POD), the other load
 * documents to choose from, the paperwork that is missing, and the default subject and body. `problem` says why it
 * cannot be sent yet (no factoring company or no submission email), else null.
 */
r.get('/:id/factoring-packet', ah(async (req, res) => {
  const inv = await loadInvoice(req.user, req.params.id);
  if (inv.kind !== 'freight') throw badRequest('Only freight invoices go to a factoring company');
  const [customer, packet] = await Promise.all([carrierFactoring(req.user, inv.carrierId), packetDocuments(inv)]);
  const view = invoiceView(inv);
  const company = customer?.factoringCompany || null;
  const email = factoringEmail(view, { carrier: customer?.carrier, clientNo: customer?.factoringClientNo });
  const doc = (d) => ({ id: d.id, type: d.type, name: d.originalName, sizeBytes: d.sizeBytes });
  res.json({
    to: company?.submitEmail || null,
    company: company ? { id: company.id, name: company.name, submitEmail: company.submitEmail } : null,
    customerId: customer?.id ?? null,
    clientNo: customer?.factoringClientNo ?? null,
    problem: factoringProblem(inv, customer),
    attachments: [{ id: null, type: 'invoice', name: `invoice-${inv.number}.pdf`, generated: true }, ...packet.picks.map(doc)],
    documents: packet.docs.map(doc),
    missing: packet.missing,
    maxAttachments: MAX_ATTACHMENTS,
    subject: email.subject,
    body: email.body,
    submitted: view.meta.factoring || null,
  });
}));

/**
 * Email the invoice to the carrier's factoring company from the user's mailbox: the invoice PDF (generated now and
 * stored as the invoice's document) plus documentIds (default: the load's latest rate con, BOL and POD), at most 5
 * files in all. On success a draft is marked sent (load -> invoiced) and meta.factoring records the submission.
 */
r.post('/:id/send-to-factoring', ah(async (req, res) => {
  refuseApiToken(req, 'send invoices');
  const first = await loadInvoice(req.user, req.params.id, true);
  // Same lock as /send: one email about this invoice at a time, so a double click never submits it twice.
  try {
    await withLock(`invoice.send.${first.id}`, 120_000, () => sendToFactoring(req, res, first));
  } catch (err) {
    if (err instanceof LockBusyError) throw conflict('This invoice is being sent already.');
    throw err;
  }
}));

async function sendToFactoring(req, res, first) {
  const inv = await loadInvoice(req.user, first.id, true);
  const before = parseInvoiceData(first.lines).meta.factoring?.submittedAt || null;
  const last = parseInvoiceData(inv.lines).meta.factoring?.submittedAt || null;
  if (last && (last !== before || Date.now() - new Date(last).getTime() < RESEND_GAP_MS)) {
    throw conflict('This invoice was just sent to the factoring company. Try again in a minute to send it again.', { invoiceId: inv.id });
  }
  if (inv.kind !== 'freight') throw badRequest('Only freight invoices go to a factoring company');
  if (['void', 'paid'].includes(inv.status)) throw badRequest(`This invoice is ${inv.status}`);
  if (!inv.amountCents) throw badRequest('Add at least one line with an amount before sending');
  const body = parse(z.object({
    documentIds: z.array(z.string().max(40)).max(MAX_ATTACHMENTS).optional(),
    subject: z.string().trim().max(300).optional(),
    body: z.string().max(20000).optional(),
    accountId: z.string().max(40).optional(),
  }), req.body);
  const customer = await carrierFactoring(req.user, inv.carrierId);
  const problem = factoringProblem(inv, customer);
  if (problem) throw badRequest(problem);
  const company = customer.factoringCompany;

  // The invoice PDF always goes first; it is made now, so an earlier stored copy is not attached twice.
  const stored = await storedInvoicePdf(inv);
  const extra = body.documentIds
    ? [...new Set(body.documentIds.filter((id) => id && id !== stored?.id))]
    : (await packetDocuments(inv)).picks.map((d) => d.id);
  if (extra.length > MAX_ATTACHMENTS - 1) throw badRequest(`Attach at most ${MAX_ATTACHMENTS - 1} files besides the invoice PDF`);

  const view = invoiceView(inv);
  // Issue and due dates as markSent will store them, so the PDF and the record agree.
  const issuedAt = inv.issuedAt || new Date();
  const preview = { ...view, issuedAt, dueAt: inv.status === 'draft' ? effectiveDueAt(inv, issuedAt) : inv.dueAt };
  const who = await issuer(req.user, view);
  const pdf = await invoicePdf(preview, { ...who, tz: req.user.timezone });
  const doc = await storeInvoicePdf(req.user, inv, pdf);
  const email = factoringEmail(view, { carrier: customer.carrier, clientNo: customer.factoringClientNo });
  const result = await queueUserEmail({
    // Addressed to the factoring company, not the carrier: the carrier's do-not-email flag and last-contacted date stay
    // out of it. The invoice keeps the link (meta.factoring.emailId).
    user: req.user, toEmail: company.submitEmail, carrierId: null,
    subject: body.subject || email.subject,
    body: body.body?.trim() ? body.body : email.body,
    documentIds: [doc.id, ...extra],
    accountId: body.accountId,
    aiGenerated: false,
  });
  if (result.outcome === 'failed') return res.status(502).json({ error: result.message || 'The email could not be sent', outcome: result.outcome, invoice: view });

  // A draft is issued now (load -> invoiced); an invoice already sent to the broker only records the submission.
  if (inv.status === 'draft') await markSent(req.user, { ...inv, issuedAt });
  const factoring = { companyId: company.id, name: company.name, submittedAt: new Date().toISOString(), toEmail: company.submitEmail, emailId: result.email?.id ?? null };
  const updated = await updateMeta(inv.id, (meta) => ({ ...meta, factoring }));
  await logActivity(req.user, { type: 'load', carrierId: inv.carrierId, summary: `Sent invoice #${inv.number} to ${company.name} (${company.submitEmail}) for factoring` });
  return res.json({ invoice: invoiceView(updated), outcome: result.outcome, message: result.message, documentId: doc.id });
}

export default r;
