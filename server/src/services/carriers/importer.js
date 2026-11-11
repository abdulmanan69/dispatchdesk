import { parse as csvParse } from 'csv-parse';
import { prisma } from '../../db.js';
import { remaining } from '../../lib/plans.js';
import { stageByKey } from '../pipeline.js';
import { normalizeCarrier, normDot } from './normalize.js';
import { rowToCarrier } from './csv.js';
import { newId } from './ids.js';
import { yieldToLoop } from './query.js';

/** Rows written per batch: one multi-row INSERT (or one transaction of UPDATEs) per batch. */
export const IMPORT_BATCH = 250;
export const IMPORT_MAX_ROWS = 5000;

const PARSE_STEP = 256 * 1024;

/**
 * Parse CSV text (header row = column names) without blocking the event loop: the text is fed to csv-parse's
 * streaming parser in 256 KB slices with a yield after each. Keeps at most `max + 1` records (one extra, so the caller
 * can tell the file is over the limit). Throws the parser's error for malformed CSV.
 */
export async function parseCsvText(text, { max = IMPORT_MAX_ROWS } = {}) {
  const parser = csvParse({ columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, trim: true });
  const records = [];
  let failed = null;
  const done = new Promise((resolve, reject) => {
    parser.on('readable', () => {
      let rec;
      while ((rec = parser.read()) !== null) if (records.length <= max) records.push(rec);
    });
    parser.on('error', (err) => { failed = err; reject(err); });
    parser.on('end', resolve);
  });
  done.catch(() => {}); // observed below
  for (let i = 0; i < text.length && !failed;) {
    let end = Math.min(text.length, i + PARSE_STEP);
    // Never split a UTF-16 surrogate pair between two writes.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end += 1;
    parser.write(text.slice(i, end));
    i = end;
    await yieldToLoop();
  }
  if (!failed) parser.end();
  await done;
  return records;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Import parsed CSV records for `user` (validation and duplicate rules unchanged from the row-by-row version):
 * - a row needs a company name or a USDOT number (then "USDOT 123" is used as the name); bad emails are dropped;
 * - duplicates are found by USDOT, MC or phone among the user's carriers and the rows earlier in the same file;
 *   mode "skip" skips them, mode "update" fills in the non-empty fields (never the company name);
 * - new carriers stop at the plan's carrier limit.
 * New carriers (with their contact and note) are inserted with createMany in batches of IMPORT_BATCH; updates run in
 * one transaction per batch. When a batch hits a database constraint (e.g. a carrier added at the same moment),
 * that batch is retried row by row so only the offending rows are reported.
 */
/**
 * The user's carriers that share a USDOT, MC or phone with the file: only those keys are looked up (chunks of
 * KEY_CHUNK through the (ownerId, dotNumber), (ownerId, mcNumber) and (ownerId, phone) indexes), never the whole list.
 * Several carriers can share a phone: the first one found is used.
 */
const KEY_CHUNK = 500;
async function existingMatches(user, records, mapping) {
  const dots = new Set();
  const mcs = new Set();
  const phones = new Set();
  for (const row of records) {
    try {
      const raw = rowToCarrier(row, mapping);
      const n = normalizeCarrier({ ...raw, companyName: raw.companyName || 'x' });
      if (n.dotNumber) dots.add(n.dotNumber);
      if (n.mcNumber) mcs.add(n.mcNumber);
      if (n.phone) phones.add(n.phone);
    } catch { /* reported by the main loop */ }
  }
  const byDot = new Map();
  const byMc = new Map();
  const byPhone = new Map();
  const select = { id: true, dotNumber: true, mcNumber: true, phone: true };
  for (const [field, keys] of [['dotNumber', dots], ['mcNumber', mcs], ['phone', phones]]) {
    const list = [...keys];
    for (let i = 0; i < list.length; i += KEY_CHUNK) {
      const rows = await prisma.carrier.findMany({ where: { ownerId: user.id, [field]: { in: list.slice(i, i + KEY_CHUNK) } }, select, orderBy: { createdAt: 'asc' } });
      for (const c of rows) {
        if (c.dotNumber && !byDot.has(c.dotNumber)) byDot.set(c.dotNumber, c.id);
        if (c.mcNumber && !byMc.has(c.mcNumber)) byMc.set(c.mcNumber, c.id);
        if (c.phone && !byPhone.has(c.phone)) byPhone.set(c.phone, c.id);
      }
    }
  }
  return { byDot, byMc, byPhone };
}

export async function importCarriers(user, records, { mapping, mode = 'skip', stageKey = 'lead', fileName = 'import.csv' }) {
  const { byDot, byMc, byPhone } = await existingMatches(user, records, mapping);
  let budget = await remaining(user, 'carriers');
  const stage = await stageByKey(stageKey);
  const sourceRef = String(fileName).slice(0, 200);
  const result = { total: records.length, created: 0, updated: 0, skipped: 0, errors: [] };

  let creates = []; // { line, carrier, contact?, note? }
  const pending = new Map(); // id -> create entry not written yet (later duplicate rows merge into it)
  let updates = []; // { line, id, patch }

  const flushCreates = async () => {
    if (!creates.length) return;
    const batch = creates;
    creates = [];
    const ops = [prisma.carrier.createMany({ data: batch.map((b) => b.carrier) })];
    const contacts = batch.filter((b) => b.contact).map((b) => b.contact);
    const notes = batch.filter((b) => b.note).map((b) => b.note);
    if (contacts.length) ops.push(prisma.carrierContact.createMany({ data: contacts }));
    if (notes.length) ops.push(prisma.carrierNote.createMany({ data: notes }));
    try {
      await prisma.$transaction(ops);
      result.created += batch.length;
    } catch {
      for (const b of batch) {
        try {
          await prisma.carrier.create({
            data: {
              ...b.carrier,
              contacts: b.contact ? { create: { ...b.contact, carrierId: undefined } } : undefined,
              notes: b.note ? { create: { ...b.note, carrierId: undefined } } : undefined,
            },
          });
          result.created++;
        } catch (err) {
          budget++;
          result.errors.push({ line: b.line, error: err.code === 'P2002' ? 'Duplicate USDOT/MC in your list' : String(err.message).slice(0, 200) });
        }
      }
    }
    for (const b of batch) pending.delete(b.carrier.id);
    await yieldToLoop();
  };

  const flushUpdates = async () => {
    if (!updates.length) return;
    const batch = updates;
    updates = [];
    try {
      await prisma.$transaction(batch.map((u) => prisma.carrier.update({ where: { id: u.id }, data: u.patch })));
      result.updated += batch.length;
    } catch {
      for (const u of batch) {
        try {
          await prisma.carrier.update({ where: { id: u.id }, data: u.patch });
          result.updated++;
        } catch (err) {
          result.errors.push({ line: u.line, error: err.code === 'P2002' ? 'Duplicate USDOT/MC in your list' : String(err.message).slice(0, 200) });
        }
      }
    }
    await yieldToLoop();
  };

  for (const [i, row] of records.entries()) {
    const line = i + 2;
    try {
      const raw = rowToCarrier(row, mapping);
      const n = normalizeCarrier({ ...raw, companyName: raw.companyName || (raw.dotNumber ? `USDOT ${normDot(raw.dotNumber)}` : '') });
      if (!n.companyName) { result.errors.push({ line, error: 'Missing company name' }); continue; }
      if (n.email && !EMAIL_RE.test(n.email)) n.email = null;
      const dupId = (n.dotNumber && byDot.get(n.dotNumber)) || (n.mcNumber && byMc.get(n.mcNumber)) || (n.phone && byPhone.get(n.phone));
      const fields = {
        ...n,
        equipment: raw.equipment, fleetSize: raw.fleetSize, drivers: raw.drivers,
        authorityStatus: raw.authorityStatus, authorityDate: raw.authorityDate,
      };
      if (dupId) {
        if (mode === 'skip') { result.skipped++; continue; }
        const patch = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v != null && k !== 'companyName'));
        const queued = pending.get(dupId);
        if (queued) {
          // The duplicate is a row earlier in this file that is not written yet: merge into it.
          Object.assign(queued.carrier, patch);
          result.updated++;
        } else {
          updates.push({ line, id: dupId, patch });
          if (updates.length >= IMPORT_BATCH) await flushUpdates();
        }
        continue;
      }
      if (budget <= 0) { result.errors.push({ line, error: 'Plan carrier limit reached — upgrade to import more' }); continue; }
      const id = newId();
      const entry = {
        line,
        carrier: { ...fields, id, ownerId: user.id, stageId: stage.id, source: 'csv', sourceRef },
        contact: raw.contactName ? { carrierId: id, name: raw.contactName, phone: n.phone, email: n.email, isPrimary: true } : null,
        note: raw.notes ? { carrierId: id, authorId: user.id, body: raw.notes } : null,
      };
      creates.push(entry);
      pending.set(id, entry);
      budget--;
      if (n.dotNumber) byDot.set(n.dotNumber, id);
      if (n.mcNumber) byMc.set(n.mcNumber, id);
      if (n.phone) byPhone.set(n.phone, id);
      if (creates.length >= IMPORT_BATCH) await flushCreates();
    } catch (err) {
      result.errors.push({ line, error: String(err.message).slice(0, 200) });
    }
  }
  await flushCreates();
  await flushUpdates();
  result.errors.sort((a, b) => a.line - b.line);
  return result;
}
