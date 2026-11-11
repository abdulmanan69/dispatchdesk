import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { ah, notFound, badRequest } from '../lib/errors.js';
import { parse, z, optStr, optInt, optNum, reqStr, pageQuery, paginate, pageResult, clean } from '../lib/validate.js';
import { requirePermission, refuseApiToken } from '../middleware/auth.js';
import { loadCarrier, ownerWhere } from '../lib/access.js';
import { CUSTOMER_STATUSES } from '../lib/constants.js';
import { logActivity } from '../lib/activity.js';
import { US_STATES } from '../lib/timezones.js';
import { changeStage } from '../services/pipeline.js';
import { withCalc } from '../services/loads/rateCalc.js';
import { homeDays } from '../services/loads/fit.js';
import { rulesOf, rulesForCarrier, RULE_FIELDS } from '../services/loads/fitCheck.js';
import { parseJson } from '../services/brokers/vetting.js';
import { buildStatement, weekFromKey, weekOf, weeklySummaries } from '../services/invoices/statements.js';
import { statementHtml, statementText } from '../services/invoices/print.js';
import { createPortalLink, revokePortalLink, portalStatus } from '../services/invoices/portal.js';
import { queueUserEmail } from '../services/email/compose.js';

const r = Router();
r.use(requirePermission('crm.use'));

export const REQUIRED_DOCS = ['agreement', 'mc_authority', 'w9', 'coi'];
const EXPIRING_DAYS = 30;
/** Loads whose dispatch fee is earned (hauled). Booked / in transit loads are reported separately; planned quotes never count. */
export const EARNED_STATUSES = ['delivered', 'invoiced', 'paid'];
const BOOKED_STATUSES = ['booked', 'in_transit'];

/** Compliance checklist from a carrier's documents: missing / on file / expiring / expired. */
/**
 * Required-document checklist. `signed` (optional) is the latest e-signed onboarding link for the carrier
 * ({ id, signedAt }): a dispatch agreement signed online counts as the agreement on file when no file was uploaded.
 */
export function docChecklist(documents, now = new Date(), signed = null) {
  return REQUIRED_DOCS.map((type) => {
    const docs = documents.filter((d) => d.type === type).sort((a, b) => b.createdAt - a.createdAt);
    const latest = docs[0];
    if (type === 'agreement' && !latest && signed) {
      return { type, status: 'on_file', documentId: null, expiresAt: null, signedOnline: true, onboardingLinkId: signed.id, signedAt: signed.signedAt };
    }
    let status = 'missing';
    if (latest) {
      status = 'on_file';
      if (latest.expiresAt) {
        const days = (new Date(latest.expiresAt) - now) / 86400000;
        if (days < 0) status = 'expired';
        else if (days <= EXPIRING_DAYS) status = 'expiring';
      }
    }
    return { type, status, documentId: latest?.id ?? null, expiresAt: latest?.expiresAt ?? null };
  });
}

const num = (v) => (v == null ? 0 : Number(v));

/**
 * Revenue per carrier from one aggregate over the given carriers' loads (no per-row load lists).
 * Gross = rate + detention pay; fee = gross x (the load's fee %, else the customer's). Earned = delivered,
 * invoiced or paid; booked = booked or in transit; planned and canceled loads are left out.
 */
async function revenueFor(carrierIds) {
  if (!carrierIds.length) return new Map();
  // A canceled load with a TONU earns its TONU amount (no miles), the same rule as statements and fee invoices.
  const tonu = Prisma.sql`(l.status = 'canceled' AND l.tonuCents > 0)`;
  const gross = Prisma.sql`(CASE WHEN ${tonu} THEN l.tonuCents ELSE (l.rateCents + ROUND(l.detentionHours * l.detentionRateCents)) END)`;
  const pct = Prisma.sql`COALESCE(l.dispatchFeePercent, c.dispatchFeePercent)`;
  const fee = Prisma.sql`(CASE WHEN ${pct} IS NULL THEN 0 ELSE ROUND(${gross} * ${pct} / 100.0) END)`;
  const earned = Prisma.sql`(l.status IN (${Prisma.join(EARNED_STATUSES)}) OR ${tonu})`;
  const booked = Prisma.sql`l.status IN (${Prisma.join(BOOKED_STATUSES)})`;
  const rows = await prisma.$queryRaw`
    SELECT l.carrierId AS carrierId,
           SUM(CASE WHEN ${earned} THEN 1 ELSE 0 END) AS loads,
           SUM(CASE WHEN ${earned} THEN ${gross} ELSE 0 END) AS grossCents,
           SUM(CASE WHEN ${earned} THEN ${fee} ELSE 0 END) AS feeCents,
           SUM(CASE WHEN ${earned} AND NOT ${tonu} THEN l.loadedMiles ELSE 0 END) AS miles,
           SUM(CASE WHEN ${earned} AND NOT ${tonu} THEN l.rateCents ELSE 0 END) AS rateCents,
           SUM(CASE WHEN ${booked} THEN 1 ELSE 0 END) AS bookedLoads,
           SUM(CASE WHEN ${booked} THEN ${fee} ELSE 0 END) AS bookedFeeCents,
           SUM(CASE WHEN l.status = 'paid' THEN ${fee} ELSE 0 END) AS paidFeeCents
    FROM Load l JOIN Customer c ON c.carrierId = l.carrierId
    WHERE l.carrierId IN (${Prisma.join(carrierIds)}) AND (l.status <> 'canceled' OR l.tonuCents > 0)
    GROUP BY l.carrierId`;
  return new Map(rows.map((row) => [row.carrierId, row]));
}

export function revenueView(row) {
  const miles = num(row?.miles);
  return {
    loads: num(row?.loads),
    grossCents: Math.round(num(row?.grossCents)),
    dispatchFeeCents: Math.round(num(row?.feeCents)),
    loadedMiles: miles,
    avgRatePerMile: miles ? Math.round((num(row?.rateCents) / 100 / miles) * 100) / 100 : null,
    booked: { loads: num(row?.bookedLoads), dispatchFeeCents: Math.round(num(row?.bookedFeeCents)) },
    paidLoadFeeCents: Math.round(num(row?.paidFeeCents)),
  };
}

/** FMCSA watchlist status for the customer list (from the nightly snapshot on the carrier). */
function fmcsaView(raw, checkedAt) {
  const s = parseJson(raw, null);
  if (!s) return null;
  return {
    found: s.found ?? null,
    usdotStatus: s.usdotStatus ?? null,
    authority: s.carrierAuthority ?? null,
    insuranceOnFile: s.insuranceOnFile ?? null,
    allowedToOperate: s.allowedToOperate ?? null,
    lastChange: s.lastChange ?? null,
    checkedAt: checkedAt ?? s.checkedAt ?? null,
  };
}

async function loadCustomer(user, id, write = false) {
  const customer = await prisma.customer.findUnique({ where: { id: String(id) } });
  if (!customer) throw notFound('Customer not found');
  const carrier = await loadCarrier(user, customer.carrierId, { write });
  return { customer, carrier };
}

r.get('/', ah(async (req, res) => {
  const q = parse(z.object({
    ...pageQuery,
    status: z.enum([...CUSTOMER_STATUSES, 'all']).default('all'),
    q: z.string().trim().max(100).optional(),
    scope: z.enum(['mine', 'team']).default('mine'),
    sort: z.enum(['signed', 'name', 'updated']).default('signed'),
  }), req.query);
  const where = { ...(await ownerWhere(req.user, q.scope)) };
  if (q.status !== 'all') where.status = q.status;
  if (q.q) where.carrier = { OR: [{ companyName: { contains: q.q } }, { mcNumber: { contains: q.q } }, { dotNumber: { contains: q.q } }, { phone: { contains: q.q } }] };
  const orderBy = { signed: { signedAt: 'desc' }, name: { carrier: { companyName: 'asc' } }, updated: { updatedAt: 'desc' } }[q.sort];
  const [rows, total, statusCounts] = await Promise.all([
    prisma.customer.findMany({
      where, orderBy, ...paginate(q),
      include: {
        carrier: {
          select: {
            id: true, companyName: true, mcNumber: true, dotNumber: true, phone: true, email: true, city: true, state: true, equipment: true, fleetSize: true,
            fmcsaSnapshot: true, fmcsaCheckedAt: true,
            assignedTo: { select: { id: true, name: true } },
            documents: { where: { type: { in: REQUIRED_DOCS } }, select: { id: true, type: true, expiresAt: true, createdAt: true } },
          },
        },
        owner: { select: { id: true, name: true } },
      },
    }),
    prisma.customer.count({ where }),
    prisma.customer.groupBy({ by: ['status'], where: await ownerWhere(req.user, q.scope), _count: true }),
  ]);
  const [revenue, signedLinks] = await Promise.all([
    revenueFor(rows.map((c) => c.carrierId)),
    signedAgreements(rows.map((c) => c.carrierId)),
  ]);
  const items = rows.map(({ carrier, portalTokenHash, ...c }) => {
    const { documents, fmcsaSnapshot, fmcsaCheckedAt, ...carrierInfo } = carrier;
    const checklist = docChecklist(documents, new Date(), signedLinks.get(c.carrierId));
    return {
      ...c, carrier: carrierInfo,
      compliance: { missing: checklist.filter((x) => x.status === 'missing').length, expiring: checklist.filter((x) => x.status === 'expiring' || x.status === 'expired').length },
      revenue: revenueView(revenue.get(c.carrierId)),
      fmcsa: fmcsaView(fmcsaSnapshot, fmcsaCheckedAt),
    };
  });
  res.json({ ...pageResult(items, total, q), summary: Object.fromEntries(statusCounts.map((s) => [s.status, s._count])) });
}));

/** Latest e-signed onboarding link per carrier ({ id, signedAt }), one indexed query for a page of carriers. */
async function signedAgreements(carrierIds) {
  const ids = [...new Set(carrierIds)].filter(Boolean);
  const out = new Map();
  if (!ids.length) return out;
  const rows = await prisma.onboardingLink.findMany({
    where: { carrierId: { in: ids }, status: 'signed' },
    orderBy: { signedAt: 'desc' },
    select: { id: true, carrierId: true, signedAt: true },
  });
  for (const r of rows) if (!out.has(r.carrierId)) out.set(r.carrierId, { id: r.id, signedAt: r.signedAt });
  return out;
}

/** Carrier rules for the load check card (null customer when the carrier is not a customer). */
r.get('/rules', ah(async (req, res) => {
  const { carrierId } = parse(z.object({ carrierId: z.string().min(1).max(40) }), req.query);
  const carrier = await loadCarrier(req.user, carrierId);
  const found = await rulesForCarrier(carrier.id);
  // The truck's last known position lets the load form estimate deadhead to the pickup.
  const truck = carrier.locationLat != null && carrier.locationLng != null
    ? { lat: carrier.locationLat, lng: carrier.locationLng, city: carrier.locationCity, state: carrier.locationState, updatedAt: carrier.locationUpdatedAt, status: carrier.truckStatus }
    : null;
  res.json({ carrier: { id: carrier.id, companyName: carrier.companyName, equipment: carrier.equipment, truck }, customer: found });
}));

/** Make a carrier a customer directly (without an opportunity). */
r.post('/', ah(async (req, res) => {
  const body = parse(z.object({ carrierId: z.string().min(1).max(40), dispatchFeePercent: optNum(0, 100) }), req.body);
  const carrier = await loadCarrier(req.user, body.carrierId, { write: true });
  await changeStage(req.user, carrier, 'customer', { reason: 'added as customer' });
  const customer = await prisma.customer.update({
    where: { carrierId: carrier.id },
    data: { status: 'active', ...(body.dispatchFeePercent != null ? { dispatchFeePercent: body.dispatchFeePercent } : {}) },
  });
  await prisma.carrier.update({ where: { id: carrier.id }, data: { isFleet: true } });
  await logActivity(req.user, { type: 'customer', carrierId: carrier.id, summary: `${carrier.companyName} added as a customer` });
  const { portalTokenHash, ...out } = customer;
  res.status(201).json({ customer: out });
}));

r.get('/:id', ah(async (req, res) => {
  const { customer } = await loadCustomer(req.user, req.params.id);
  const [carrier, lanes, documents, loads, activities, revenue] = await Promise.all([
    prisma.carrier.findUnique({
      where: { id: customer.carrierId },
      include: { contacts: { orderBy: { isPrimary: 'desc' } }, tags: { include: { tag: true } }, assignedTo: { select: { id: true, name: true } }, stage: true },
    }),
    prisma.customerLane.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: 'asc' } }),
    prisma.document.findMany({ where: { carrierId: customer.carrierId }, orderBy: { createdAt: 'desc' }, select: { id: true, type: true, originalName: true, expiresAt: true, createdAt: true, sizeBytes: true, mimeType: true } }),
    prisma.load.findMany({ where: { carrierId: customer.carrierId }, orderBy: [{ pickupDate: 'desc' }, { createdAt: 'desc' }], take: 100, include: { broker: { select: { id: true, companyName: true } } }, omit: { routeGeometry: true } }),
    prisma.activity.findMany({ where: { carrierId: customer.carrierId }, orderBy: { createdAt: 'desc' }, take: 20, include: { user: { select: { name: true } } } }),
    revenueFor([customer.carrierId]),
  ]);
  const loadsWithFee = loads.map((l) => withCalc({ ...l, dispatchFeePercent: l.dispatchFeePercent ?? customer.dispatchFeePercent }));
  // Brokers this carrier has hauled for, derived from load history.
  const brokers = new Map();
  for (const l of loads) if (l.broker) brokers.set(l.broker.id, { ...l.broker, loads: (brokers.get(l.broker.id)?.loads || 0) + 1 });
  const { fmcsaSnapshot, fmcsaCheckedAt, ...carrierInfo } = carrier;
  const { portalTokenHash, ...cust } = customer;
  res.json({
    customer: { ...cust, carrier: carrierInfo, lanes, rules: rulesOf(customer, carrier), portal: portalStatus(customer) },
    documents,
    checklist: docChecklist(documents, new Date(), (await signedAgreements([customer.carrierId])).get(customer.carrierId)),
    loads: loadsWithFee,
    revenue: revenueView(revenue.get(customer.carrierId)),
    brokers: [...brokers.values()],
    activities,
    fmcsa: fmcsaView(fmcsaSnapshot, fmcsaCheckedAt),
  });
}));

const STATE_SET = new Set(US_STATES);
const avoidStates = z.preprocess((v) => {
  if (v === '' || v == null) return v === '' ? null : v;
  const list = [...new Set(String(v).split(/[\s,;/]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
  return list.join(',');
}, z.string().max(160).refine((s) => s.split(',').every((x) => STATE_SET.has(x)), 'Use 2-letter state codes, e.g. FL, GA').nullable().optional());
const homeTime = z.preprocess((v) => {
  if (v === '' || v == null) return v === '' ? null : v;
  const days = homeDays(v);
  return days.length ? days.join(',') : '__invalid__';
}, z.string().max(40).refine((s) => s !== '__invalid__', 'Use day names, e.g. Sat, Sun').nullable().optional());

r.patch('/:id', ah(async (req, res) => {
  const { customer, carrier } = await loadCustomer(req.user, req.params.id, true);
  const body = parse(z.object({
    status: z.enum(CUSTOMER_STATUSES).optional(),
    dispatchFeePercent: optNum(0, 100),
    minRatePerMile: optNum(0, 100),
    maxDeadheadMiles: optInt(0, 5000),
    homeBase: optStr(200),
    notes: optStr(5000),
    maxWeightLbs: optInt(0, 200000),
    trailerLengthFt: optInt(0, 60),
    hazmat: z.boolean().optional(),
    twic: z.boolean().optional(),
    teamDrivers: z.boolean().optional(),
    avoidStates,
    homeTimeDays: homeTime,
    costPerMileCents: optInt(0, 100000),
    minHaulMiles: optInt(0, 5000),
    maxHaulMiles: optInt(0, 5000),
  }), req.body);
  const minHaul = body.minHaulMiles !== undefined ? body.minHaulMiles : customer.minHaulMiles;
  const maxHaul = body.maxHaulMiles !== undefined ? body.maxHaulMiles : customer.maxHaulMiles;
  if (minHaul && maxHaul && minHaul > maxHaul) throw badRequest('Minimum length of haul is more than the maximum');
  const updated = await prisma.customer.update({ where: { id: customer.id }, data: clean(body) });
  if (body.status && body.status !== customer.status) {
    await logActivity(req.user, { type: 'customer', carrierId: carrier.id, summary: `Customer ${carrier.companyName} status changed to ${body.status}` });
  }
  const { portalTokenHash, ...out } = updated;
  res.json({ customer: { ...out, rules: rulesOf(updated, carrier) } });
}));

r.delete('/:id', ah(async (req, res) => {
  const { customer, carrier } = await loadCustomer(req.user, req.params.id, true);
  await prisma.customer.delete({ where: { id: customer.id } });
  await changeStage(req.user, carrier, 'archived', { reason: 'customer removed' });
  res.json({ ok: true });
}));

const laneSchema = z.object({ origin: reqStr(120), destination: reqStr(120), notes: optStr(500) });

r.post('/:id/lanes', ah(async (req, res) => {
  const { customer } = await loadCustomer(req.user, req.params.id, true);
  const body = parse(laneSchema, req.body);
  const lane = await prisma.customerLane.create({ data: { ...body, customerId: customer.id } });
  res.status(201).json({ lane });
}));

r.patch('/:id/lanes/:laneId', ah(async (req, res) => {
  const { customer } = await loadCustomer(req.user, req.params.id, true);
  const body = parse(laneSchema.partial(), req.body);
  const lane = await prisma.customerLane.findFirst({ where: { id: String(req.params.laneId), customerId: customer.id } });
  if (!lane) throw notFound('Lane not found');
  res.json({ lane: await prisma.customerLane.update({ where: { id: lane.id }, data: clean(body) }) });
}));

r.delete('/:id/lanes/:laneId', ah(async (req, res) => {
  const { customer } = await loadCustomer(req.user, req.params.id, true);
  const result = await prisma.customerLane.deleteMany({ where: { id: String(req.params.laneId), customerId: customer.id } });
  if (!result.count) throw notFound('Lane not found');
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Weekly dispatch-fee statements and the carrier portal link
// ---------------------------------------------------------------------------

/** Who the statement is from: the dispatcher's team name, else their own name. */
async function senderName(user) {
  const teamName = user.teamMembership?.team?.name
    || (user.teamMembership?.teamId ? (await prisma.team.findUnique({ where: { id: user.teamMembership.teamId }, select: { name: true } }))?.name : null);
  return teamName || user.name;
}

r.get('/:id/statements', ah(async (req, res) => {
  const { customer, carrier } = await loadCustomer(req.user, req.params.id);
  const { weeks } = parse(z.object({ weeks: z.coerce.number().int().min(1).max(26).default(12) }), req.query);
  const items = await weeklySummaries({ customer, carrier, tz: req.user.timezone, count: weeks });
  res.json({ items, currentWeek: weekOf(req.user.timezone).key, timezone: req.user.timezone, portal: portalStatus(customer) });
}));

r.get('/:id/statements/:week', ah(async (req, res) => {
  const { customer, carrier } = await loadCustomer(req.user, req.params.id);
  const week = weekFromKey(req.user.timezone, req.params.week);
  res.json({ statement: await buildStatement({ customer, carrier, week }) });
}));

r.get('/:id/statements/:week/print', ah(async (req, res) => {
  const { customer, carrier } = await loadCustomer(req.user, req.params.id);
  const week = weekFromKey(req.user.timezone, req.params.week);
  const statement = await buildStatement({ customer, carrier, week });
  res.set('Cache-Control', 'private, no-store');
  res.type('html').send(statementHtml(statement, { from: { name: await senderName(req.user) }, tz: req.user.timezone }));
}));

/**
 * Email the weekly statement from the user's own mailbox. With portalLink: true a new carrier portal link is created
 * (replacing any earlier one) and added to the message.
 */
r.post('/:id/statements/:week/send', ah(async (req, res) => {
  refuseApiToken(req, 'send statements');
  const { customer, carrier } = await loadCustomer(req.user, req.params.id, true);
  const week = weekFromKey(req.user.timezone, req.params.week);
  const body = parse(z.object({
    toEmail: z.string().trim().toLowerCase().email().max(254).optional(),
    subject: z.string().trim().max(300).optional(),
    body: z.string().max(20000).optional(),
    portalLink: z.boolean().default(false),
    accountId: z.string().max(40).optional(),
  }), req.body);
  const toEmail = body.toEmail || carrier.email;
  if (!toEmail) throw badRequest('Add the carrier’s email address first');
  const statement = await buildStatement({ customer, carrier, week });
  const from = { name: await senderName(req.user) };
  let portal = null;
  if (body.portalLink) portal = await createPortalLink(customer);
  // When the email does not go out (no mailbox, blocked recipient, daily limit, delivery failure), the carrier never
  // received the new link: put the previous link back so the one they already have keeps working.
  const restoreLink = () => (portal
    ? prisma.customer.update({ where: { id: customer.id }, data: { portalTokenHash: customer.portalTokenHash, portalExpiresAt: customer.portalExpiresAt } })
    : null);
  let text = body.body?.trim() ? body.body : statementText(statement, { from, tz: req.user.timezone, portalUrl: portal?.url });
  if (portal && body.body?.trim() && !text.includes(portal.url)) text += `\n\nYour statements and load documents: ${portal.url}`;
  let result;
  try {
    result = await queueUserEmail({
      user: req.user, toEmail, carrierId: carrier.id,
      subject: body.subject || `Dispatch statement · week of ${statement.weekStart}`,
      body: text, accountId: body.accountId,
    });
  } catch (err) {
    await restoreLink();
    throw err;
  }
  if (result.outcome === 'failed') {
    await restoreLink();
    return res.json({ outcome: result.outcome, message: result.message, emailId: result.email?.id ?? null, portal: null });
  }
  await logActivity(req.user, { type: 'customer', carrierId: carrier.id, summary: `Sent the dispatch statement for the week of ${statement.weekStart} to ${toEmail}` });
  res.json({ outcome: result.outcome, message: result.message, emailId: result.email?.id ?? null, portal: portal ? { url: portal.url, expiresAt: portal.expiresAt } : null });
}));

/** Create (or rotate) the carrier portal link. The token is shown once; only its hash is stored. */
r.post('/:id/portal', ah(async (req, res) => {
  refuseApiToken(req, 'create portal links');
  const { customer, carrier } = await loadCustomer(req.user, req.params.id, true);
  const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(90) }), req.body);
  const link = await createPortalLink(customer, { days });
  await logActivity(req.user, { type: 'customer', carrierId: carrier.id, summary: `Created a carrier portal link for ${carrier.companyName} (expires ${link.expiresAt.toISOString().slice(0, 10)})` });
  res.status(201).json({ url: link.url, expiresAt: link.expiresAt });
}));

r.delete('/:id/portal', ah(async (req, res) => {
  const { customer, carrier } = await loadCustomer(req.user, req.params.id, true);
  await revokePortalLink(customer);
  await logActivity(req.user, { type: 'customer', carrierId: carrier.id, summary: `Turned off the carrier portal link for ${carrier.companyName}` });
  res.json({ ok: true });
}));

export { RULE_FIELDS };
export default r;
