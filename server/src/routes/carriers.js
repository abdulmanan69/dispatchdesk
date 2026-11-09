import { Router } from 'express';
import fs from 'node:fs';
import { parse as parseCsv } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { prisma } from '../db.js';
import { ah, badRequest, conflict, notFound, forbidden } from '../lib/errors.js';
import { parse, z, optStr, optEmail, optInt, optDate, reqStr, paginate, pageResult, pageQuery } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { loadCarrier, teamMemberIds, isTeamLead } from '../lib/access.js';
import { logActivity } from '../lib/activity.js';
import { assertLimit, remaining } from '../lib/plans.js';
import { audit } from '../lib/audit.js';
import { callWindow, timezoneForState } from '../lib/timezones.js';
import { EQUIPMENT, AUTHORITY_STATUSES, STAGE_KEYS } from '../lib/constants.js';
import { uploader, verifyFileSignature, removeFile } from '../middleware/upload.js';
import { changeStage, stageByKey } from '../services/pipeline.js';
import { runAutomations } from '../services/automation.js';
import { enrollCarriers } from '../services/sequenceEngine.js';
import { normalizeCarrier, normEquipment, findDuplicates, normDot, normPhone, onlySent } from '../services/carriers/normalize.js';
import { carrierFilterSchema, carrierWhere, carrierOrder, listInclude, serializeCarrier, writableCarriers, lastTouches } from '../services/carriers/query.js';
import { mapHeaders, rowToCarrier, EXPORT_COLUMNS } from '../services/carriers/csv.js';
import { enrichLookup } from '../services/carriers/providers.js';

const r = Router();
r.use(requirePermission('crm.use'));

const csvUpload = uploader('csv', 'imports', 10);

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
    prisma.carrier.findMany({ where, include: listInclude, orderBy: carrierOrder(f.sort, f.dir), ...paginate(f) }),
    prisma.carrier.count({ where }),
  ]);
  const touches = await lastTouches(items.map((c) => c.id));
  res.json(pageResult(items.map((c) => ({ ...serializeCarrier(c), ...touches.get(c.id) })), total, f));
}));

r.get('/export.csv', ah(async (req, res) => {
  const f = parse(carrierFilterSchema.extend({ sort: z.string().optional(), dir: z.enum(['asc', 'desc']).optional() }), req.query);
  const where = await carrierWhere(req.user, f);
  const rows = await prisma.carrier.findMany({ where, include: listInclude, orderBy: carrierOrder(f.sort, f.dir), take: 20000 });
  const data = rows.map((c) => EXPORT_COLUMNS.map(([k]) => {
    if (k === 'stage') return c.stage?.name;
    if (k === 'tags') return c.tags.map((t) => t.tag.name).join('; ');
    const v = c[k];
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    return v ?? '';
  }));
  const csv = stringify(data, { header: true, columns: EXPORT_COLUMNS.map(([, h]) => h) });
  await audit(req, 'carriers.export', { details: { count: rows.length } });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="carriers-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
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
    records = parseCsv(text, { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, trim: true });
  } catch (err) {
    throw badRequest(`Could not read CSV: ${err.message}`);
  } finally {
    fs.rmSync(req.file.path, { force: true });
  }
  if (!records.length) throw badRequest('The CSV has no data rows');
  if (records.length > 5000) throw badRequest('Import at most 5,000 rows per file');
  const { mapping, unmapped } = mapHeaders(Object.keys(records[0]));
  if (!Object.values(mapping).includes('companyName') && !Object.values(mapping).includes('dotNumber')) {
    throw badRequest('CSV needs a company name or USDOT column', { unmapped });
  }

  const existing = await prisma.carrier.findMany({ where: { ownerId: req.user.id }, select: { id: true, dotNumber: true, mcNumber: true, phone: true } });
  const byDot = new Map(existing.filter((c) => c.dotNumber).map((c) => [c.dotNumber, c.id]));
  const byMc = new Map(existing.filter((c) => c.mcNumber).map((c) => [c.mcNumber, c.id]));
  const byPhone = new Map(existing.filter((c) => c.phone).map((c) => [c.phone, c.id]));
  let budget = await remaining(req.user, 'carriers');
  const stage = await stageByKey(opts.stage);
  const result = { total: records.length, created: 0, updated: 0, skipped: 0, errors: [], mapping, unmapped };

  for (const [i, row] of records.entries()) {
    const line = i + 2;
    try {
      const raw = rowToCarrier(row, mapping);
      const n = normalizeCarrier({ ...raw, companyName: raw.companyName || (raw.dotNumber ? `USDOT ${normDot(raw.dotNumber)}` : '') });
      if (!n.companyName) { result.errors.push({ line, error: 'Missing company name' }); continue; }
      if (n.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(n.email)) n.email = null;
      const dupId = (n.dotNumber && byDot.get(n.dotNumber)) || (n.mcNumber && byMc.get(n.mcNumber)) || (n.phone && byPhone.get(n.phone));
      const fields = {
        ...n,
        equipment: raw.equipment, fleetSize: raw.fleetSize, drivers: raw.drivers,
        authorityStatus: raw.authorityStatus, authorityDate: raw.authorityDate,
      };
      if (dupId) {
        if (opts.mode === 'skip') { result.skipped++; continue; }
        const patch = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v != null && k !== 'companyName'));
        await prisma.carrier.update({ where: { id: dupId }, data: patch });
        result.updated++;
        continue;
      }
      if (budget <= 0) { result.errors.push({ line, error: 'Plan carrier limit reached — upgrade to import more' }); continue; }
      const created = await prisma.carrier.create({
        data: {
          ...fields, ownerId: req.user.id, stageId: stage.id, source: 'csv', sourceRef: req.file.originalname.slice(0, 200),
          contacts: raw.contactName ? { create: { name: raw.contactName, phone: n.phone, email: n.email, isPrimary: true } } : undefined,
          notes: raw.notes ? { create: { authorId: req.user.id, body: raw.notes } } : undefined,
        },
      });
      budget--;
      if (created.dotNumber) byDot.set(created.dotNumber, created.id);
      if (created.mcNumber) byMc.set(created.mcNumber, created.id);
      if (created.phone) byPhone.set(created.phone, created.id);
      result.created++;
    } catch (err) {
      result.errors.push({ line, error: err.code === 'P2002' ? 'Duplicate USDOT/MC in your list' : err.message.slice(0, 200) });
    }
  }
  result.errors = result.errors.slice(0, 200);
  await logActivity(req.user, { type: 'import', summary: `Imported ${req.file.originalname}: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped, ${result.errors.length} errors` });
  await audit(req, 'carriers.import', { details: { file: req.file.originalname, created: result.created, updated: result.updated } });
  res.json(result);
}));

const bulkSchema = z.object({
  action: z.enum(['move_stage', 'add_tag', 'remove_tag', 'assign', 'delete', 'add_to_list', 'enroll_sequence', 'set_do_not_call', 'set_do_not_email']),
  ids: z.array(z.string()).min(1).max(1000),
  value: z.any().optional(),
});

r.post('/bulk', ah(async (req, res) => {
  const { action, ids, value } = parse(bulkSchema, req.body);
  const carriers = await writableCarriers(req.user, ids);
  let affected = 0;
  switch (action) {
    case 'move_stage': {
      if (!STAGE_KEYS.includes(value)) throw badRequest('Choose a valid stage');
      for (const c of carriers) { await changeStage(req.user, c, value, { reason: 'bulk' }); affected++; }
      break;
    }
    case 'add_tag': {
      const name = String(value || '').trim().slice(0, 40);
      if (!name) throw badRequest('Tag name required');
      const tag = await prisma.tag.upsert({ where: { ownerId_name: { ownerId: req.user.id, name } }, create: { ownerId: req.user.id, name }, update: {} });
      for (const c of carriers) {
        await prisma.carrierTag.upsert({ where: { carrierId_tagId: { carrierId: c.id, tagId: tag.id } }, create: { carrierId: c.id, tagId: tag.id }, update: {} });
        affected++;
      }
      break;
    }
    case 'remove_tag': {
      const out = await prisma.carrierTag.deleteMany({ where: { tagId: String(value), carrierId: { in: carriers.map((c) => c.id) } } });
      affected = out.count;
      break;
    }
    case 'assign': {
      const assignee = value ? String(value) : null;
      await assertAssignable(req.user, assignee);
      const out = await prisma.carrier.updateMany({ where: { id: { in: carriers.map((c) => c.id) } }, data: { assignedToId: assignee } });
      affected = out.count;
      break;
    }
    case 'delete': {
      const ids = carriers.map((c) => c.id);
      const files = await carrierFiles(ids);
      const out = await prisma.carrier.deleteMany({ where: { id: { in: ids } } });
      files.forEach((f) => removeFile('documents', f));
      affected = out.count;
      await audit(req, 'carriers.bulk_delete', { details: { count: affected } });
      break;
    }
    case 'add_to_list': {
      const list = await prisma.prospectList.findFirst({ where: { id: String(value || ''), ownerId: req.user.id } });
      if (!list) throw notFound('Prospect list not found');
      for (const c of carriers) {
        await prisma.prospectListItem.upsert({ where: { listId_carrierId: { listId: list.id, carrierId: c.id } }, create: { listId: list.id, carrierId: c.id }, update: {} });
        affected++;
      }
      const prospecting = await stageByKey('prospecting');
      const lead = await stageByKey('lead');
      await prisma.carrier.updateMany({ where: { id: { in: carriers.map((c) => c.id) }, stageId: lead.id }, data: { stageId: prospecting.id, stageChangedAt: new Date() } });
      break;
    }
    case 'enroll_sequence': {
      const seq = await prisma.emailSequence.findFirst({ where: { id: String(value || ''), ownerId: req.user.id } });
      if (!seq) throw notFound('Sequence not found');
      const out = await enrollCarriers(req.user, seq.id, carriers);
      affected = out.enrolled;
      return res.json({ affected, skipped: out.skipped, requested: ids.length, reason: out.reason });
    }
    case 'set_do_not_call':
    case 'set_do_not_email': {
      const field = action === 'set_do_not_call' ? 'doNotCall' : 'doNotEmail';
      const out = await prisma.carrier.updateMany({ where: { id: { in: carriers.map((c) => c.id) } }, data: { [field]: value !== false } });
      affected = out.count;
      break;
    }
    default:
      throw badRequest('Unknown action');
  }
  res.json({ affected, requested: ids.length, inaccessible: ids.length - carriers.length });
}));

r.get('/:id', ah(async (req, res) => {
  const carrier = await loadCarrier(req.user, req.params.id, {
    include: {
      ...listInclude,
      contacts: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
      notes: { orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }], include: { author: { select: { id: true, name: true } } } },
      opportunity: true,
      customer: true,
      calls: { orderBy: { calledAt: 'desc' }, take: 50, include: { user: { select: { id: true, name: true } } } },
      followUps: { orderBy: { dueAt: 'asc' }, where: { status: { in: ['pending', 'done'] } }, take: 50, include: { user: { select: { id: true, name: true } } } },
      enrollments: { include: { sequence: { include: { steps: { orderBy: { order: 'asc' } } } } }, orderBy: { startedAt: 'desc' } },
      listItems: { include: { list: { select: { id: true, name: true } } } },
      _count: { select: { emails: true, documents: true, loads: true, activities: true } },
    },
  });
  let canWrite = true;
  try { await loadCarrier(req.user, carrier.id, { write: true }); } catch { canWrite = false; }
  const out = serializeCarrier(carrier);
  out.enrollments = carrier.enrollments.map((e) => ({
    id: e.id, status: e.status, currentStep: e.currentStep, nextStepAt: e.nextStepAt, startedAt: e.startedAt, stopReason: e.stopReason,
    sequence: { id: e.sequence.id, name: e.sequence.name, stepCount: e.sequence.steps.length },
    step: e.sequence.steps[e.currentStep] ? { type: e.sequence.steps[e.currentStep].type, dayOffset: e.sequence.steps[e.currentStep].dayOffset, order: e.currentStep + 1 } : null,
  }));
  out.lists = carrier.listItems.map((li) => li.list);
  delete out.listItems;
  const [sentEmails, texts] = await Promise.all([
    prisma.email.count({ where: { carrierId: carrier.id, status: { in: ['sent', 'sending'] } } }),
    prisma.activity.count({ where: { carrierId: carrier.id, type: 'text' } }),
  ]);
  out.activityCounts = { calls: carrier.calls.length, emails: sentEmails, texts };
  res.json({ carrier: out, callWindow: callWindow(carrier.timezone || timezoneForState(carrier.state)), canWrite });
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
