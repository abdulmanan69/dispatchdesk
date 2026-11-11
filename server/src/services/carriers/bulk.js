import { prisma } from '../../db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { STAGE_KEYS } from '../../lib/constants.js';
import { stages, stageByKey, changeStage } from '../pipeline.js';
import { enrollCarriers } from '../sequenceEngine.js';
import { removeFile } from '../../middleware/upload.js';
import { chunks, yieldToLoop } from './query.js';

/**
 * Bulk carrier actions without per-row round trips. Every function receives carriers the caller already
 * access-checked (query.writableCarriers) and works in batches of at most 500 rows, yielding to the event loop
 * between batches so a 5,000-carrier action never blocks other requests for long.
 */

/** Columns the bulk actions need (stage moves, sequence enrollment, call lists). */
export const BULK_SELECT = {
  id: true, ownerId: true, assignedToId: true, stageId: true, companyName: true, phone: true, email: true,
  doNotCall: true, doNotEmail: true, state: true, timezone: true, dotNumber: true, mcNumber: true,
};

/** Stages whose side effects create or change other records (opportunity, customer, enrollments). */
const SIDE_EFFECT_STAGES = new Set(['opportunity', 'trial', 'customer', 'archived']);

/** Prospect lists made for the power dialer hold at most this many carriers (the dialer loads one page of 200). */
export const CALL_LIST_MAX = 200;

async function teamIdOf(user) {
  if (user.teamMembership !== undefined) return user.teamMembership?.teamId ?? null;
  return (await prisma.teamMember.findUnique({ where: { userId: user.id }, select: { teamId: true } }))?.teamId ?? null;
}

/** Insert timeline rows in batches (same fields logActivity writes). */
export async function logActivities(user, rows) {
  if (!rows.length) return;
  const teamId = await teamIdOf(user);
  for (const part of chunks(rows, 500)) {
    await prisma.activity.createMany({
      data: part.map((r) => ({
        userId: user.id, teamId, carrierId: r.carrierId ?? null, type: r.type,
        summary: String(r.summary).slice(0, 500), metadata: r.metadata ? JSON.stringify(r.metadata).slice(0, 2000) : null,
      })),
    });
  }
}

/**
 * Move carriers to a stage. Plain moves (lead, prospecting, sequence) for owners without stage automations are one
 * UPDATE and one activity INSERT per 500 rows. Stages with side effects, and owners whose automations react to stage
 * changes, go through pipeline.changeStage one carrier at a time so every rule and record is applied as usual.
 */
export async function moveStage(user, carriers, stageKey) {
  if (!STAGE_KEYS.includes(stageKey)) throw badRequest('Choose a valid stage');
  const target = await stageByKey(stageKey);
  const byId = new Map((await stages()).map((s) => [s.id, s]));
  const owners = [...new Set(carriers.map((c) => c.ownerId))];
  const ruled = new Set((await prisma.automation.findMany({
    where: { ownerId: { in: owners }, trigger: 'stage_changed', active: true, OR: [{ triggerValue: null }, { triggerValue: '' }, { triggerValue: stageKey }] },
    select: { ownerId: true },
    distinct: ['ownerId'],
  })).map((a) => a.ownerId));
  const slow = carriers.filter((c) => SIDE_EFFECT_STAGES.has(stageKey) || ruled.has(c.ownerId));
  const slowIds = new Set(slow.map((c) => c.id));
  const moving = carriers.filter((c) => !slowIds.has(c.id) && c.stageId !== target.id);
  const now = new Date();
  for (const part of chunks(moving, 500)) {
    await prisma.carrier.updateMany({ where: { id: { in: part.map((c) => c.id) } }, data: { stageId: target.id, stageChangedAt: now } });
    await logActivities(user, part.map((c) => {
      const from = byId.get(c.stageId);
      return {
        type: 'stage_change', carrierId: c.id,
        summary: `Moved ${c.companyName} from ${from?.name ?? 'unknown'} to ${target.name} (bulk)`,
        metadata: { from: from?.key, to: target.key },
      };
    }));
    await yieldToLoop();
  }
  for (const [i, c] of slow.entries()) {
    await changeStage(user, c, stageKey, { reason: 'bulk' });
    if (i % 50 === 49) await yieldToLoop();
  }
  return carriers.length;
}

/** Add a tag (created for the acting user when new) to every carrier that does not have it yet. */
export async function addTag(user, carriers, rawName) {
  const name = String(rawName || '').trim().slice(0, 40);
  if (!name) throw badRequest('Tag name required');
  const tag = await prisma.tag.upsert({ where: { ownerId_name: { ownerId: user.id, name } }, create: { ownerId: user.id, name }, update: {} });
  for (const part of chunks(carriers.map((c) => c.id), 500)) {
    const have = new Set((await prisma.carrierTag.findMany({ where: { tagId: tag.id, carrierId: { in: part } }, select: { carrierId: true } })).map((r) => r.carrierId));
    const missing = part.filter((id) => !have.has(id));
    if (missing.length) await prisma.carrierTag.createMany({ data: missing.map((carrierId) => ({ carrierId, tagId: tag.id })) });
    await yieldToLoop();
  }
  return carriers.length;
}

export async function removeTag(carriers, tagId) {
  let n = 0;
  for (const part of chunks(carriers.map((c) => c.id), 500)) {
    n += (await prisma.carrierTag.deleteMany({ where: { tagId: String(tagId || ''), carrierId: { in: part } } })).count;
  }
  return n;
}

export async function updateField(carriers, data) {
  let n = 0;
  for (const part of chunks(carriers.map((c) => c.id), 500)) {
    n += (await prisma.carrier.updateMany({ where: { id: { in: part } }, data })).count;
  }
  return n;
}

/** Delete carriers (cascade removes their notes, calls, follow-ups...) and then their stored document files. */
export async function deleteCarriers(carriers) {
  let n = 0;
  for (const part of chunks(carriers.map((c) => c.id), 500)) {
    const files = (await prisma.document.findMany({ where: { carrierId: { in: part } }, select: { storedName: true } })).map((d) => d.storedName);
    n += (await prisma.carrier.deleteMany({ where: { id: { in: part } } })).count;
    files.forEach((f) => removeFile('documents', f));
    await yieldToLoop();
  }
  return n;
}

async function addItems(listId, ids) {
  for (const part of chunks(ids, 500)) {
    const have = new Set((await prisma.prospectListItem.findMany({ where: { listId, carrierId: { in: part } }, select: { carrierId: true } })).map((r) => r.carrierId));
    const missing = part.filter((id) => !have.has(id));
    if (missing.length) await prisma.prospectListItem.createMany({ data: missing.map((carrierId) => ({ listId, carrierId })) });
  }
}

/** Add carriers to one of the user's prospect lists; new leads move to Prospecting (as before). */
export async function addToList(user, carriers, listId) {
  const list = await prisma.prospectList.findFirst({ where: { id: String(listId || ''), ownerId: user.id } });
  if (!list) throw notFound('Prospect list not found');
  const ids = carriers.map((c) => c.id);
  await addItems(list.id, ids);
  const [prospecting, lead] = await Promise.all([stageByKey('prospecting'), stageByKey('lead')]);
  for (const part of chunks(ids, 500)) {
    await prisma.carrier.updateMany({ where: { id: { in: part }, stageId: lead.id }, data: { stageId: prospecting.id, stageChangedAt: new Date() } });
  }
  return ids.length;
}

/** Enroll carriers in one of the user's sequences, 200 at a time. */
export async function enrollSequence(user, carriers, sequenceId) {
  const seq = await prisma.emailSequence.findFirst({ where: { id: String(sequenceId || ''), ownerId: user.id } });
  if (!seq) throw notFound('Sequence not found');
  const out = { enrolled: 0, skipped: 0, reason: undefined };
  for (const part of chunks(carriers, 200)) {
    const r = await enrollCarriers(user, seq.id, part);
    out.enrolled += r.enrolled;
    out.skipped += r.skipped;
    out.reason = out.reason || r.reason;
    await yieldToLoop();
  }
  return out;
}

const listStamp = (tz, now = new Date()) => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 16).replace('T', ' ');
  }
};

/**
 * Put the callable carriers (phone on file, not do-not-call) into a new prospect list for the power dialer.
 * Nothing is dialed: the dialer still needs a click for every call. No stage changes.
 */
export async function createCallList(user, carriers, name) {
  const callable = carriers.filter((c) => c.phone && !c.doNotCall);
  const chosen = callable.slice(0, CALL_LIST_MAX);
  if (!chosen.length) throw badRequest('None of the selected carriers can be called (no phone number, or do-not-call is on)');
  const base = String(name || '').trim().slice(0, 70) || `Call list · ${listStamp(user.timezone)}`;
  let list = null;
  for (let i = 0; i < 5 && !list; i++) {
    const candidate = i ? `${base} (${i + 1})` : base;
    try {
      list = await prisma.prospectList.create({ data: { ownerId: user.id, name: candidate, description: 'Made from the carrier list for the power dialer' } });
    } catch (err) {
      if (err.code !== 'P2002') throw err;
    }
  }
  if (!list) throw badRequest('A list with that name already exists. Choose another name.');
  await addItems(list.id, chosen.map((c) => c.id));
  return {
    list: { id: list.id, name: list.name },
    added: chosen.length,
    noPhone: carriers.filter((c) => !c.phone).length,
    doNotCall: carriers.filter((c) => c.phone && c.doNotCall).length,
    overLimit: callable.length - chosen.length,
  };
}
