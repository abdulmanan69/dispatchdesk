import { Router } from 'express';
import fs from 'node:fs';
import { stringify } from 'csv-stringify/sync';
import { safeCell } from '../lib/csv.js';
import { prisma } from '../db.js';
import { ah, badRequest, conflict, notFound, forbidden } from '../lib/errors.js';
import { parse, z, optStr, optEmail, optInt, optDate, reqStr, paginate, pageResult, pageQuery } from '../lib/validate.js';
import { requirePermission, hasPermission, refuseApiToken } from '../middleware/auth.js';
import { loadCarrier, teamMemberIds, isTeamLead } from '../lib/access.js';
import { logActivity } from '../lib/activity.js';
import { assertLimit } from '../lib/plans.js';
import { audit } from '../lib/audit.js';
import { withLock, LockBusyError } from '../lib/locks.js';
import { callWindow, timezoneForState } from '../lib/timezones.js';
import { EQUIPMENT, AUTHORITY_STATUSES, STAGE_KEYS } from '../lib/constants.js';
import { uploader, verifyFileSignature, removeFile } from '../middleware/upload.js';
import { changeStage, stageByKey } from '../services/pipeline.js';
import { runAutomations } from '../services/automation.js';
import { normalizeCarrier, normEquipment, findDuplicates, normPhone, onlySent } from '../services/carriers/normalize.js';
import {
  carrierFilterSchema, carrierWhere, carrierOrder, listInclude, listSelect, serializeCarrier, writableCarriers, lastTouches,
  accessChecker, matchingCarrierIds, BULK_FILTER_CAP,
} from '../services/carriers/query.js';
import { mapHeaders, EXPORT_COLUMNS } from '../services/carriers/csv.js';
import { enrichLookup } from '../services/carriers/providers.js';
import { importCarriers, parseCsvText, IMPORT_MAX_ROWS } from '../services/carriers/importer.js';
import * as bulkOps from '../services/carriers/bulk.js';
import { sendCapacity, capacityMessage } from '../services/carriers/outreach.js';
import { leftoverTokens } from '../services/carriers/truckPost.js';
import { queueUserEmail } from '../services/email/compose.js';
import { recordReply } from '../services/email/replies.js';
import { shareForDispatcher } from '../services/carrierAccounts/index.js';
import { pickAccount } from '../services/email/index.js';
import { renderContent, renderPreview } from '../services/email/render.js';

const r = Router();
r.use(requirePermission('crm.use'));

const csvUpload = uploader('csv', 'imports', 10);

/** Rows returned per carrier-profile section; the profile also returns real totals (_count), so nothing is silently capped. */
export const DETAIL_LIMITS = { notes: 100, calls: 50, pendingFollowUps: 100, doneFollowUps: 20, enrollments: 50, contacts: 100, lists: 50 };
/** Recipients per bulk email request. */
export const BULK_EMAIL_MAX = 200;

/** Stored file names of documents attached to these carriers (deleted with them via cascade). */
async function carrierFiles(ids) {
  const docs = await prisma.document.findMany({ where: { carrierId: { in: ids } }, select: { storedName: true } });
  return docs.map((d) => d.storedName);
}

/** Accepts canonical keys (array or comma list) or free text like "Dry Van, Reefer". */
function canonicalEquipment(v) {
  if (v == null) return v;
  const parts = String(v).split(',').map((s) => s.trim()).filter(Boolean);
  const out = new Set();
  for (const p of parts) {
    if (EQUIPMENT.includes(p)) out.add(p);
    else normEquipment(p)?.split(',').forEach((k) => out.add(k));
  }
  return out.size ? [...out].join(',') : null;
}
const equipmentField = z.preprocess(
  (v) => (Array.isArray(v) ? v.join(',') : v === '' ? null : v),
  z.string().max(200).nullable().optional(),
).transform(canonicalEquipment);

const carrierFields = {
  companyName: reqStr(200),
  dbaName: optStr(200),
  dotNumber: optStr(20),
  mcNumber: optStr(20),
  phone: optStr(40),
  email: optEmail,
  address: optStr(300),
  city: optStr(100),
  state: optStr(2),
  zip: optStr(12),
  equipment: equipmentField,
  fleetSize: optInt(0, 100000),
  drivers: optInt(0, 100000),
  authorityStatus: z.preprocess((v) => (v === '' ? null : v), z.enum(AUTHORITY_STATUSES).nullable().optional()),
  authorityDate: optDate,
  operatingStatus: optStr(100),
  classification: optStr(200),
  priority: z.coerce.number().int().min(0).max(2).optional(),
  doNotCall: z.boolean().optional(),
  doNotEmail: z.boolean().optional(),
  timezone: optStr(60),
};

const createSchema = z.object({
  ...carrierFields,
  stage: z.enum(STAGE_KEYS).optional(),
  contactName: optStr(120),
  note: optStr(4000),
  tagIds: z.array(z.string()).max(20).optional(),
  allowDuplicate: z.boolean().optional(),
});

const updateSchema = z.object(Object.fromEntries(Object.entries(carrierFields).map(([k, v]) => [k, k === 'companyName' ? reqStr(200).optional() : v])))
  .extend({ assignedToId: z.string().nullable().optional() });

function applyNormalization(body) {
  const n = normalizeCarrier({ ...body, companyName: body.companyName ?? 'x' });
  const out = { ...body };
  for (const k of ['dotNumber', 'mcNumber', 'phone', 'email', 'state']) if (k in body) out[k] = n[k];
  if ('state' in body && !body.timezone) out.timezone = n.state ? timezoneForState(n.state) : null;
  return out;
}

async function assertAssignable(user, assigneeId) {
  if (!assigneeId || assigneeId === user.id) return;
  const ids = await teamMemberIds(user);
  if (!ids.includes(assigneeId)) throw badRequest('You can only assign carriers to yourself or members of your team');
  if (!isTeamLead(user)) throw forbidden('Only team owners and managers can assign carriers to other members');
}

/** Users this user may assign carriers to. */
r.get('/meta/assignees', ah(async (req, res) => {
  const ids = isTeamLead(req.user) ? await teamMemberIds(req.user) : [req.user.id];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } });
  res.json({ items: users });
}));

r.get('/', ah(async (req, res) => {
  const f = parse(carrierFilterSchema.extend({ ...pageQuery, sort: z.string().optional(), dir: z.enum(['asc', 'desc']).optional() }), req.query);
  const where = await carrierWhere(req.user, f);
  const [items, total] = await Promise.all([
    prisma.carrier.findMany({ where, select: listSelect, orderBy: carrierOrder(f.sort, f.dir), ...paginate(f) }),
    prisma.carrier.count({ where }),
  ]);
  const touches = await lastTouches(items.map((c) => c.id));
  res.json(pageResult(items.map((c) => ({ ...serializeCarrier(c), ...touches.get(c.id) })), total, f));
}));

const exportSelect = {
  id: true,
  ...Object.fromEntries(EXPORT_COLUMNS.filter(([k]) => k !== 'stage' && k !== 'tags').map(([k]) => [k, true])),
  stage: { select: { name: true } },
  tags: { select: { tag: { select: { name: true } } } },
};

/**
 * Most rows one export returns (default 50,000, the largest plan's carrier limit; CARRIER_EXPORT_MAX_ROWS overrides).
 * When more carriers match, the export is refused with a 400 asking to narrow the filters, never cut silently.
 */
const exportMaxRows = () => Math.max(1, Math.floor(Number(process.env.CARRIER_EXPORT_MAX_ROWS)) || 50_000);
const EXPORT_PAGE = 1000;

const exportRow = (c) => EXPORT_COLUMNS.map(([k]) => {
  if (k === 'stage') return c.stage?.name;
  if (k === 'tags') return c.tags.map((t) => t.tag.name).join('; ');
  const v = c[k];
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return v ?? '';
});

/** Wait until the response can take more data (or the client went away). */
const drained = (res) => new Promise((resolve) => {
  const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
  res.on('drain', done);
  res.on('close', done);
});

/**
 * CSV export, streamed: the matching ids are read first in the chosen order (one index walk), then full rows are
 * loaded, serialized and written 1,000 at a time with back-pressure, so memory stays flat for large exports and other
 * requests run between pages. One export per user at a time (DB lock, works across cluster workers).
 */
r.get('/export.csv', ah(async (req, res) => {
  refuseApiToken(req, 'export carriers');
  const f = parse(carrierFilterSchema.extend({ sort: z.string().optional(), dir: z.enum(['asc', 'desc']).optional() }), req.query);
  const where = await carrierWhere(req.user, f);
  const max = exportMaxRows();
  try {
    await withLock(`carriers-export.${req.user.id}`, 10 * 60_000, async () => {
      // Keyset cursors would skip rows when the sort column has NULLs; an id list keeps the user's order exactly.
      const ids = (await prisma.carrier.findMany({ where, select: { id: true }, orderBy: carrierOrder(f.sort, f.dir), take: max + 1 }))
        .map((x) => x.id);
      if (ids.length > max) {
        throw badRequest(`More than ${max.toLocaleString('en-US')} carriers match these filters. Narrow the filters (for example by stage or state) and export in parts.`, { max });
      }
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="carriers-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.write(stringify([], { header: true, columns: EXPORT_COLUMNS.map(([, h]) => h) }));
      let written = 0;
      for (let i = 0; i < ids.length; i += EXPORT_PAGE) {
        if (res.destroyed) break; // client went away
        const part = ids.slice(i, i + EXPORT_PAGE);
        const rows = await prisma.carrier.findMany({ where: { id: { in: part } }, select: exportSelect });
        const byId = new Map(rows.map((c) => [c.id, c]));
        const data = part.map((id) => byId.get(id)).filter(Boolean).map((c) => exportRow(c).map(safeCell));
        written += data.length;
        if (!res.write(stringify(data))) await drained(res);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await audit(req, 'carriers.export', { details: { count: written } });
      res.end();
    });
  } catch (err) {
    if (err instanceof LockBusyError) throw conflict('An export is already running for your account. Try again when it finishes.');
    if (res.headersSent) { res.destroy(err); return; }
    throw err;
  }
}));

r.post('/', ah(async (req, res) => {
  const body = applyNormalization(parse(createSchema, req.body));
  await assertLimit(req.user, 'carriers', 1);
  const dups = await findDuplicates(prisma, req.user.id, body);
  const hardDup = dups.find((d) => (body.dotNumber && d.dotNumber === body.dotNumber) || (body.mcNumber && d.mcNumber === body.mcNumber));
  if (hardDup || (dups.length && !body.allowDuplicate)) {
    throw conflict(`Possible duplicate: ${dups[0].companyName}`, { duplicates: dups, existingId: dups[0].id, canOverride: !hardDup });
  }
  const stage = await stageByKey(body.stage || 'lead');
  const { contactName, note, tagIds, allowDuplicate, stage: _s, ...data } = body;
  const carrier = await prisma.carrier.create({
    data: {
      ...data, ownerId: req.user.id, stageId: stage.id, source: 'manual',
      contacts: contactName ? { create: { name: contactName, phone: data.phone, email: data.email, isPrimary: true } } : undefined,
      notes: note ? { create: { authorId: req.user.id, body: note } } : undefined,
    },
  });
  if (tagIds?.length) {
    const tags = await prisma.tag.findMany({ where: { id: { in: tagIds }, ownerId: req.user.id } });
    await prisma.carrierTag.createMany({ data: tags.map((t) => ({ carrierId: carrier.id, tagId: t.id })) });
  }
  await logActivity(req.user, { type: 'carrier_created', carrierId: carrier.id, summary: `Added carrier ${carrier.companyName}` });
  await runAutomations(req.user, 'carrier_created', { carrier });
  res.status(201).json({ carrier });
}));

r.post('/import', csvUpload.single('file'), ah(async (req, res) => {
  if (!req.file) throw badRequest('Attach a CSV file');
  const opts = parse(z.object({ mode: z.enum(['skip', 'update']).default('skip'), stage: z.enum(STAGE_KEYS).default('lead') }), req.body);
  let records;
  try {
    verifyFileSignature(req.file);
    const text = fs.readFileSync(req.file.path, 'utf8');
    records = await parseCsvText(text, { max: IMPORT_MAX_ROWS });
  } catch (err) {
    throw badRequest(`Could not read CSV: ${err.message}`);
  } finally {
    fs.rmSync(req.file.path, { force: true });
  }
  if (!records.length) throw badRequest('The CSV has no data rows');
  if (records.length > IMPORT_MAX_ROWS) throw badRequest('Import at most 5,000 rows per file');
  const { mapping, unmapped } = mapHeaders(Object.keys(records[0]));
  if (!Object.values(mapping).includes('companyName') && !Object.values(mapping).includes('dotNumber')) {
    throw badRequest('CSV needs a company name or USDOT column', { unmapped });
  }
  const out = await importCarriers(req.user, records, { mapping, mode: opts.mode, stageKey: opts.stage, fileName: req.file.originalname });
  const result = { ...out, errors: out.errors.slice(0, 200), errorCount: out.errors.length, mapping, unmapped };
  await logActivity(req.user, { type: 'import', summary: `Imported ${req.file.originalname}: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped, ${result.errorCount} errors` });
  await audit(req, 'carriers.import', { details: { file: req.file.originalname, created: result.created, updated: result.updated } });
  res.json(result);
}));

// ---- Bulk actions ----
// Target either explicit ids (a page selection, up to 1,000) or every carrier matching a list filter ("select all N
// matching", up to BULK_FILTER_CAP). Every target is access-checked in one query per 500 ids; read-only carriers are
// skipped and counted as inaccessible.
const bulkFilterSchema = carrierFilterSchema.extend({ sort: z.string().max(30).optional(), dir: z.enum(['asc', 'desc']).optional() });
const bulkTarget = {
  ids: z.array(z.string().max(60)).min(1).max(1000).optional(),
  filter: bulkFilterSchema.optional(),
};
const oneTarget = (b) => !!b.ids !== !!b.filter;
const TARGET_MESSAGE = { message: 'Send either ids or filter', path: ['ids'] };

const bulkSchema = z.object({
  action: z.enum(['move_stage', 'add_tag', 'remove_tag', 'assign', 'delete', 'add_to_list', 'enroll_sequence', 'set_do_not_call', 'set_do_not_email', 'call_list']),
  ...bulkTarget,
  value: z.any().optional(),
}).refine(oneTarget, TARGET_MESSAGE);

/** Resolve a bulk target to writable carriers. `max` rejects a larger selection before any row is loaded. */
async function bulkTargets(req, b, select = bulkOps.BULK_SELECT, { max, tooMany } = {}) {
  let ids = b.ids;
  if (b.filter) {
    // A leaked extension token must not be able to act on a whole filter at once.
    if (req.apiToken) throw forbidden('API tokens can only act on carriers selected by id');
    const found = await matchingCarrierIds(req.user, b.filter);
    if (found.overCap) throw badRequest(`More than ${BULK_FILTER_CAP.toLocaleString('en-US')} carriers match these filters. Narrow the filters and try again.`, { cap: BULK_FILTER_CAP });
    ids = found.ids;
  }
  if (max && new Set(ids).size > max) throw badRequest(tooMany, { max });
  return { requested: ids.length, carriers: await writableCarriers(req.user, ids, { select }) };
}

r.post('/bulk', ah(async (req, res) => {
  const b = parse(bulkSchema, req.body);
  const { action, value } = b;
  const { requested, carriers } = await bulkTargets(req, b);
  const base = { requested, inaccessible: requested - carriers.length };
  let affected = 0;
  switch (action) {
    case 'move_stage':
      affected = await bulkOps.moveStage(req.user, carriers, value);
      break;
    case 'add_tag':
      affected = await bulkOps.addTag(req.user, carriers, value);
      break;
    case 'remove_tag':
      affected = await bulkOps.removeTag(carriers, value);
      break;
    case 'assign': {
      const assignee = value ? String(value) : null;
      await assertAssignable(req.user, assignee);
      affected = await bulkOps.updateField(carriers, { assignedToId: assignee });
      break;
    }
    case 'delete':
      affected = await bulkOps.deleteCarriers(carriers);
      await audit(req, 'carriers.bulk_delete', { details: { count: affected, byFilter: !!b.filter } });
      break;
    case 'add_to_list':
      affected = await bulkOps.addToList(req.user, carriers, value);
      break;
    case 'enroll_sequence': {
      const out = await bulkOps.enrollSequence(req.user, carriers, value);
      return res.json({ ...base, affected: out.enrolled, skipped: out.skipped, reason: out.reason });
    }
    case 'set_do_not_call':
    case 'set_do_not_email':
      affected = await bulkOps.updateField(carriers, { [action === 'set_do_not_call' ? 'doNotCall' : 'doNotEmail']: value !== false });
      break;
    case 'call_list': {
      const out = await bulkOps.createCallList(req.user, carriers, typeof value === 'string' ? value : '');
      return res.json({ ...base, affected: out.added, ...out });
    }
    default:
      throw badRequest('Unknown action');
  }
  res.json({ ...base, affected });
}));

const bulkEmailSchema = z.object({
  ...bulkTarget,
  templateId: optStr(60),
  subject: z.string().trim().max(300).optional(),
  body: z.string().max(20000).optional(),
  accountId: optStr(60),
  dryRun: z.boolean().optional(),
}).refine(oneTarget, TARGET_MESSAGE);

const emailSelect = {
  ...bulkOps.BULK_SELECT, dbaName: true, city: true, equipment: true,
  contacts: { select: { name: true, isPrimary: true }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], take: 3 },
};

/**
 * Email carriers from the list with a template or a written message, personalized per carrier.
 * dryRun: who would get it, who is skipped and why, today's sending capacity and three rendered samples.
 * Otherwise every eligible email is queued (never sent inline): the scheduler sends them from the user's own mailbox
 * within its cooldown and daily limit and the plan's daily limit. Emails with unfilled merge fields are not queued.
 */
r.post('/bulk/email', ah(async (req, res) => {
  if (!hasPermission(req, 'email.use')) throw forbidden('Your role cannot send email');
  if (req.apiToken) throw forbidden('API tokens cannot send bulk email');
  const b = parse(bulkEmailSchema, req.body);
  const template = b.templateId ? await prisma.emailTemplate.findFirst({ where: { id: b.templateId, ownerId: req.user.id } }) : null;
  if (b.templateId && !template) throw notFound('Template not found');
  const subject = b.subject ?? template?.subject ?? '';
  const body = b.body ?? template?.body ?? '';
  if (!subject.trim() || !body.trim()) throw badRequest('Choose a template or write a subject and message');
  const { requested, carriers } = await bulkTargets(req, b, emailSelect, {
    max: BULK_EMAIL_MAX, tooMany: `Email at most ${BULK_EMAIL_MAX} carriers at a time. Narrow the selection.`,
  });
  const account = await pickAccount(req.user.id, b.accountId || undefined);
  // A preview works without a mailbox (it says so); queueing needs one.
  if (!account && !b.dryRun) throw badRequest('Connect a mailbox first (Email, Mailboxes)');

  const emails = [...new Set(carriers.map((c) => c.email?.toLowerCase()).filter(Boolean))];
  const suppressed = new Set(emails.length
    ? (await prisma.emailSuppression.findMany({ where: { ownerId: req.user.id, email: { in: emails } }, select: { email: true } })).map((s) => s.email)
    : []);
  const skipped = [];
  const eligible = [];
  for (const c of carriers) {
    if (!c.email) skipped.push({ id: c.id, name: c.companyName, reason: 'No email address' });
    else if (c.doNotEmail) skipped.push({ id: c.id, name: c.companyName, reason: 'Do-not-email is on' });
    else if (suppressed.has(c.email.toLowerCase())) skipped.push({ id: c.id, name: c.companyName, reason: 'On your do-not-email list' });
    else eligible.push(c);
  }
  // Strict render per carrier (as the preview shows it): a field with no value for this carrier, or an unknown token,
  // keeps that email out of the queue. Sending renders known-but-empty fields as blanks, so without this check the
  // preview's "not queued" promise would not hold.
  const ready = [];
  const missingFields = new Set();
  const samples = [];
  for (const c of eligible) {
    const p = renderPreview({ subject, body, channel: 'email', carrier: c, user: req.user, account });
    const missing = [...p.unresolved, ...p.unknown];
    if (b.dryRun && samples.length < 3) {
      samples.push({ carrierId: c.id, name: c.companyName, toEmail: c.email, subject: p.subject, body: p.body, signature: p.signature, unresolved: p.unresolved, unknown: p.unknown });
    }
    if (missing.length) {
      missing.forEach((f) => missingFields.add(f));
      skipped.push({ id: c.id, name: c.companyName, reason: `Unfilled merge fields: ${missing.join(', ')}` });
    } else ready.push(c);
  }
  const capacity = account ? await sendCapacity(req.user, account) : null;
  const base = { requested, inaccessible: requested - carriers.length, recipients: ready.length, capacity, mailbox: account ? { id: account.id, fromEmail: account.fromEmail, label: account.label } : null };

  if (b.dryRun) {
    return res.json({ ...base, skipped: skipped.slice(0, 100), skippedCount: skipped.length, samples, missingFields: [...missingFields] });
  }

  let queued = 0;
  let stopped = null;
  const queueAll = async () => {
    for (const c of ready) {
      if (stopped) { skipped.push({ id: c.id, name: c.companyName, reason: stopped }); continue; }
      const out = renderContent({ subject, body, carrier: c, user: req.user, account });
      const left = leftoverTokens(out.subject, out.body);
      if (left.length) { skipped.push({ id: c.id, name: c.companyName, reason: `Unfilled merge fields: ${left.join(', ')}` }); continue; }
      try {
        await queueUserEmail({ user: req.user, toEmail: c.email, subject: out.subject, body: out.body, carrierId: c.id, templateId: template?.id ?? null, accountId: account.id, sendNow: false });
        queued++;
      } catch (err) {
        if (err.status === 402) { stopped = err.message; skipped.push({ id: c.id, name: c.companyName, reason: stopped }); } else skipped.push({ id: c.id, name: c.companyName, reason: err.message });
      }
    }
  };
  try {
    // One bulk send at a time per user across all workers, so a second tab or a repeated submit cannot queue the
    // same emails twice while the first request is still running.
    await withLock(`carriers.bulk-email.${req.user.id}`, 120_000, queueAll);
  } catch (err) {
    if (err instanceof LockBusyError) throw conflict('Your last bulk email is still being queued. Try again in a moment.');
    throw err;
  }
  // A template sent as stored counts one use here; text picked through the template picker was counted when picked.
  if (template && queued && b.subject == null && b.body == null) {
    await prisma.emailTemplate.updateMany({ where: { id: template.id, ownerId: req.user.id }, data: { useCount: { increment: 1 }, lastUsedAt: new Date() } });
  }
  await audit(req, 'carriers.bulk_email', { details: { queued, skipped: skipped.length, byFilter: !!b.filter } });
  res.status(queued ? 201 : 200).json({ ...base, queued, skipped: skipped.slice(0, 100), skippedCount: skipped.length, message: capacityMessage(queued, capacity) });
}));

const DETAIL_INCLUDE = {
  ...listInclude,
  contacts: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], take: DETAIL_LIMITS.contacts },
  notes: { orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }], take: DETAIL_LIMITS.notes, include: { author: { select: { id: true, name: true } } } },
  opportunity: true,
  // The factoring company's name shows in the profile header ("Factors with ...").
  customer: { omit: { portalTokenHash: true }, include: { factoringCompany: { select: { id: true, name: true } } } },
  calls: { orderBy: { calledAt: 'desc' }, take: DETAIL_LIMITS.calls, include: { user: { select: { id: true, name: true } } } },
  // Only what the profile shows: step types and timing, never the step bodies.
  enrollments: {
    orderBy: { startedAt: 'desc' }, take: DETAIL_LIMITS.enrollments,
    include: { sequence: { select: { id: true, name: true, steps: { orderBy: { order: 'asc' }, select: { type: true, dayOffset: true } } } } },
  },
  listItems: { take: DETAIL_LIMITS.lists, include: { list: { select: { id: true, name: true } } } },
  _count: { select: { emails: true, documents: true, loads: true, activities: true, calls: true, notes: true, contacts: true } },
};
const followUpUser = { user: { select: { id: true, name: true } } };

/**
 * The verdict of the FMCSA profile stored on a carrier (Carrier.fmcsaSnapshot.profile): its worst flag, or null when
 * no profile was ever opened. Same wording as the carrier check page; inspections and related carriers are not part
 * of the stored copy, so the chip says it is the profile's verdict and links to the full check.
 */
export function verdictOfSnapshot(raw) {
  let profile = null;
  try { profile = raw ? JSON.parse(raw)?.profile : null; } catch { profile = null; }
  if (!profile || !Array.isArray(profile.flags)) return null;
  const red = profile.flags.filter((f) => f.level === 'red');
  const amber = profile.flags.filter((f) => f.level === 'amber');
  const base = { checkedAt: profile.fetchedAt || null };
  if (red.length) return { ...base, level: 'fail', label: 'Do not book', text: red[0].text, count: red.length + amber.length };
  if (amber.length) return { ...base, level: 'warn', label: 'Review before booking', text: amber[0].text, count: amber.length };
  return { ...base, level: 'pass', label: 'No red flags', text: 'FMCSA authority, insurance and safety checks found nothing to review', count: 0 };
}

r.get('/:id', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id, { include: DETAIL_INCLUDE });
  const [access, pending, done, pendingTotal, sentEmails, texts, onboarding, carrierProfile] = await Promise.all([
    accessChecker(req.user),
    prisma.followUp.findMany({ where: { carrierId: carrier.id, status: 'pending' }, orderBy: { dueAt: 'asc' }, take: DETAIL_LIMITS.pendingFollowUps, include: followUpUser }),
    prisma.followUp.findMany({ where: { carrierId: carrier.id, status: 'done' }, orderBy: [{ completedAt: 'desc' }, { dueAt: 'desc' }], take: DETAIL_LIMITS.doneFollowUps, include: followUpUser }),
    prisma.followUp.count({ where: { carrierId: carrier.id, status: 'pending' } }),
    prisma.email.count({ where: { carrierId: carrier.id, status: { in: ['sent', 'sending'] } } }),
    prisma.activity.count({ where: { carrierId: carrier.id, type: 'text' } }),
    prisma.onboardingLink.findFirst({
      where: { carrierId: carrier.id }, orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, createdAt: true, viewedAt: true, signedAt: true, expiresAt: true, revokedAt: true, requestedDocs: true },
    }),
    shareForDispatcher(carrier.id),
  ]);
  const out = serializeCarrier(carrier);
  out.enrollments = carrier.enrollments.map((e) => ({
    id: e.id, status: e.status, currentStep: e.currentStep, nextStepAt: e.nextStepAt, startedAt: e.startedAt, stopReason: e.stopReason,
    sequence: { id: e.sequence.id, name: e.sequence.name, stepCount: e.sequence.steps.length },
    step: e.sequence.steps[e.currentStep] ? { type: e.sequence.steps[e.currentStep].type, dayOffset: e.sequence.steps[e.currentStep].dayOffset, order: e.currentStep + 1 } : null,
  }));
  out.lists = carrier.listItems.map((li) => li.list);
  delete out.listItems;
  // The stored FMCSA profile (10-25 KB) has its own endpoint (/api/carrier-profile/carrier/:id); keep it off this payload.
  // Only its verdict travels here, for the header chip and the next step.
  out.fmcsaVerdict = verdictOfSnapshot(carrier.fmcsaSnapshot);
  delete out.fmcsaSnapshot;
  // Latest dispatch agreement link (the next step after an interested call is sending one).
  // The carrier's own DispatchDesk profile, as far as it concerns this record: what it shares with this dispatcher.
  out.carrierProfile = carrierProfile;
  out.onboarding = onboarding ? {
    id: onboarding.id, status: onboarding.revokedAt ? 'revoked' : onboarding.status === 'pending' && onboarding.expiresAt < new Date() ? 'expired' : onboarding.status,
    sentAt: onboarding.createdAt, viewedAt: onboarding.viewedAt, signedAt: onboarding.signedAt, expiresAt: onboarding.expiresAt,
    requestedDocs: (onboarding.requestedDocs || '').split(',').filter(Boolean),
  } : null;
  // Pending follow-ups first (soonest due), then the most recent completed ones; counts are real totals.
  out.followUps = [...pending, ...done];
  out.followUpCounts = { pending: pendingTotal };
  out.activityCounts = { calls: carrier._count.calls, emails: sentEmails, texts };
  out.limits = DETAIL_LIMITS;
  res.json({ carrier: out, callWindow: callWindow(carrier.timezone || timezoneForState(carrier.state)), canWrite: access.writable(carrier) });
}));

r.patch('/:id', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id, { write: true });
  const body = applyNormalization(onlySent(parse(updateSchema, req.body), req.body));
  if ('assignedToId' in body) await assertAssignable(req.user, body.assignedToId);
  if (body.dotNumber || body.mcNumber) {
    const dups = await findDuplicates(prisma, carrier.ownerId, { dotNumber: body.dotNumber, mcNumber: body.mcNumber }, carrier.id);
    if (dups.length) throw conflict(`Another carrier already uses this USDOT/MC: ${dups[0].companyName}`, { duplicates: dups });
  }
  const data = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
  const updated = await prisma.carrier.update({ where: { id: carrier.id }, data, include: listInclude });
  if (data.assignedToId && data.assignedToId !== carrier.assignedToId && data.assignedToId !== req.user.id) {
    const { notify } = await import('../lib/activity.js');
    await notify(data.assignedToId, { type: 'assignment', title: `${req.user.name} assigned you ${updated.companyName}`, link: `/app/carriers/${carrier.id}` });
  }
  res.json({ carrier: serializeCarrier(updated) });
}));

r.delete('/:id', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id, { write: true });
  const files = await carrierFiles([carrier.id]);
  await prisma.carrier.delete({ where: { id: carrier.id } });
  files.forEach((f) => removeFile('documents', f));
  await audit(req, 'carrier.delete', { entityType: 'carrier', entityId: carrier.id, details: { name: carrier.companyName } });
  res.json({ ok: true });
}));

r.post('/:id/stage', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id, { write: true });
  const { stage } = parse(z.object({ stage: z.enum(STAGE_KEYS) }), req.body);
  const target = await changeStage(req.user, carrier, stage);
  res.json({ ok: true, stage: { key: target.key, name: target.name, color: target.color } });
}));

r.post('/:id/enrich', ah(async (req, res) => {
  // dryRun: return the FMCSA differences without saving. fields: apply only these keys.
  const opts = parse(z.object({ dryRun: z.boolean().optional(), fields: z.array(z.string().max(40)).max(30).optional() }), req.body || {});
  const carrier = await loadCarrier(req.user, req.params.id, { write: true });
  if (!carrier.dotNumber && !carrier.mcNumber) throw badRequest('Add a USDOT or MC number first — enrichment looks the carrier up by those');
  const { record, sources } = await enrichLookup({ dot: carrier.dotNumber, mc: carrier.mcNumber });
  if (!record) throw notFound('No FMCSA record found for this USDOT/MC');
  const FIELDS = ['dbaName', 'dotNumber', 'mcNumber', 'phone', 'email', 'address', 'city', 'state', 'zip', 'timezone', 'fleetSize', 'drivers', 'authorityStatus', 'authorityDate', 'operatingStatus', 'classification', 'carrierOperation'];
  const changes = {};
  const data = {};
  for (const f of FIELDS) {
    const to = record[f];
    if (to == null || to === '') continue;
    // 'unknown' means FMCSA licensing did not answer: keep the authority on file instead of erasing it.
    if (f === 'authorityStatus' && to === 'unknown') continue;
    const from = carrier[f];
    const same = from instanceof Date ? to instanceof Date && from.getTime() === to.getTime() : from === to;
    if (!same) { changes[f] = { from: from ?? null, to }; data[f] = to; }
  }
  if (!carrier.equipment && record.equipment) { changes.equipment = { from: null, to: record.equipment }; data.equipment = record.equipment; }
  if (!carrier.companyName && record.companyName) data.companyName = record.companyName;
  if (data.mcNumber || data.dotNumber) {
    const dups = await findDuplicates(prisma, carrier.ownerId, { dotNumber: data.dotNumber, mcNumber: data.mcNumber }, carrier.id);
    if (dups.length) { delete data.mcNumber; delete data.dotNumber; delete changes.mcNumber; delete changes.dotNumber; }
  }
  if (opts.dryRun) {
    return res.json({ carrier: serializeCarrier(carrier), changes, sources, extra: record._extra ?? null, retrievedAt: new Date().toISOString(), dryRun: true });
  }
  if (opts.fields) {
    for (const k of Object.keys(changes)) if (!opts.fields.includes(k)) { delete changes[k]; delete data[k]; }
  }
  const updated = await prisma.carrier.update({ where: { id: carrier.id }, data: { ...data, verifiedAt: new Date() }, include: listInclude });
  await logActivity(req.user, { type: 'enrich', carrierId: carrier.id, summary: `Enriched from ${sources.filter((s) => !s.includes(':error')).join(' + ')} (${Object.keys(changes).length} field(s) changed)` });
  res.json({ carrier: serializeCarrier(updated), changes, sources, extra: record._extra ?? null, retrievedAt: new Date().toISOString() });
}));

r.get('/:id/activities', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id);
  const q = parse(z.object({ ...pageQuery, type: optStr(30) }), req.query);
  const where = { carrierId: carrier.id, ...(q.type ? { type: q.type } : {}) };
  const [items, total] = await Promise.all([
    prisma.activity.findMany({ where, orderBy: { createdAt: 'desc' }, include: { user: { select: { id: true, name: true } } }, ...paginate(q) }),
    prisma.activity.count({ where }),
  ]);
  res.json(pageResult(items, total, q));
}));

// ---- Texts (logged by hand: the app has no SMS provider and never sends texts itself) ----
r.post('/:id/texts', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id, { write: true });
  const body = parse(z.object({ body: z.string().trim().max(1000).optional(), direction: z.enum(['outbound', 'inbound']).default('outbound') }), req.body);
  if (body.direction === 'outbound' && carrier.doNotCall) throw badRequest('Do-not-call is on for this carrier');
  const now = new Date();
  await prisma.carrier.update({ where: { id: carrier.id }, data: { lastContactedAt: now } });
  await logActivity(req.user, {
    type: 'text', carrierId: carrier.id,
    summary: `${body.direction === 'inbound' ? 'Text received from' : 'Text sent to'} ${carrier.companyName}${body.body ? `: ${body.body.slice(0, 200)}` : ''}`,
    metadata: { direction: body.direction },
  });
  res.status(201).json({ ok: true });
}));

/**
 * The carrier replied (by email, phone or text) and reply detection did not catch it: stop its running sequences,
 * log the reply and create one "Reply from" follow-up. The newest sent email to the carrier is marked replied.
 */
r.post('/:id/replied', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id, { write: true });
  const email = await prisma.email.findFirst({
    where: { carrierId: carrier.id, userId: req.user.id, status: 'sent', repliedAt: null },
    orderBy: { sentAt: 'desc' },
  });
  const out = await recordReply({ user: req.user, carrier, email, fromEmail: carrier.email || null, subject: email ? `Re: ${email.subject}` : null, source: 'manual' });
  res.json({ ok: true, stopped: out.stopped, emailId: email?.id ?? null });
}));

// ---- Notes ----
r.post('/:id/notes', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id, { write: true });
  const body = parse(z.object({ body: reqStr(10000), pinned: z.boolean().optional() }), req.body);
  const note = await prisma.carrierNote.create({ data: { carrierId: carrier.id, authorId: req.user.id, body: body.body, pinned: !!body.pinned }, include: { author: { select: { id: true, name: true } } } });
  await logActivity(req.user, { type: 'note', carrierId: carrier.id, summary: `Note on ${carrier.companyName}: ${body.body.slice(0, 120)}` });
  res.status(201).json({ note });
}));

async function loadNote(req) {
  const carrier = await loadCarrier(req.user, req.params.id, { write: true });
  const note = await prisma.carrierNote.findFirst({ where: { id: req.params.noteId, carrierId: carrier.id } });
  if (!note) throw notFound('Note not found');
  if (note.authorId !== req.user.id && carrier.ownerId !== req.user.id && !isTeamLead(req.user)) throw forbidden('You can only edit your own notes');
  return note;
}
r.patch('/:id/notes/:noteId', ah(async (req, res) => {
  const note = await loadNote(req);
  const body = parse(z.object({ body: reqStr(10000).optional(), pinned: z.boolean().optional() }), req.body);
  res.json({ note: await prisma.carrierNote.update({ where: { id: note.id }, data: body, include: { author: { select: { id: true, name: true } } } }) });
}));
r.delete('/:id/notes/:noteId', ah(async (req, res) => {
  const note = await loadNote(req);
  await prisma.carrierNote.delete({ where: { id: note.id } });
  res.json({ ok: true });
}));

// ---- Contacts ----
const contactSchema = z.object({ name: reqStr(120), title: optStr(120), phone: optStr(40), email: optEmail, isPrimary: z.boolean().optional() });
r.post('/:id/contacts', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id, { write: true });
  const body = parse(contactSchema, req.body);
  if (body.isPrimary) await prisma.carrierContact.updateMany({ where: { carrierId: carrier.id }, data: { isPrimary: false } });
  const contact = await prisma.carrierContact.create({ data: { ...body, phone: body.phone ? normPhone(body.phone) ?? body.phone : null, carrierId: carrier.id } });
  res.status(201).json({ contact });
}));
r.patch('/:id/contacts/:contactId', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id, { write: true });
  const existing = await prisma.carrierContact.findFirst({ where: { id: req.params.contactId, carrierId: carrier.id } });
  if (!existing) throw notFound('Contact not found');
  const body = parse(contactSchema.partial(), req.body);
  if (body.isPrimary) await prisma.carrierContact.updateMany({ where: { carrierId: carrier.id }, data: { isPrimary: false } });
  res.json({ contact: await prisma.carrierContact.update({ where: { id: existing.id }, data: Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) }) });
}));
r.delete('/:id/contacts/:contactId', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id, { write: true });
  const out = await prisma.carrierContact.deleteMany({ where: { id: req.params.contactId, carrierId: carrier.id } });
  if (!out.count) throw notFound('Contact not found');
  res.json({ ok: true });
}));

// ---- Tags on a carrier ----
r.post('/:id/tags', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id, { write: true });
  const body = parse(z.object({ tagId: optStr(40), name: optStr(40), color: optStr(9) }), req.body);
  let tag;
  if (body.tagId) tag = await prisma.tag.findFirst({ where: { id: body.tagId, ownerId: carrier.ownerId } });
  else if (body.name) tag = await prisma.tag.upsert({ where: { ownerId_name: { ownerId: carrier.ownerId, name: body.name } }, create: { ownerId: carrier.ownerId, name: body.name, color: body.color || '#2563eb' }, update: {} });
  if (!tag) throw badRequest('Provide an existing tagId or a tag name');
  await prisma.carrierTag.upsert({ where: { carrierId_tagId: { carrierId: carrier.id, tagId: tag.id } }, create: { carrierId: carrier.id, tagId: tag.id }, update: {} });
  res.json({ tag });
}));
r.delete('/:id/tags/:tagId', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id, { write: true });
  await prisma.carrierTag.deleteMany({ where: { carrierId: carrier.id, tagId: req.params.tagId } });
  res.json({ ok: true });
}));

export default r;
