import { prisma } from '../../db.js';
import { badRequest } from '../../lib/errors.js';
import { assertLimit, remainingMany } from '../../lib/plans.js';
import { logActivity } from '../../lib/activity.js';
import { stageByKey } from '../pipeline.js';
import { runAutomations } from '../automation.js';
import { enrollCarriers } from '../sequenceEngine.js';
import * as census from './fmcsaCensus.js';
import { normDot, normMc } from './normalize.js';

/** Resolve an optional sequence id to one of the user's active sequences (400 otherwise). */
export async function activeSequence(user, sequenceId) {
  if (!sequenceId) return null;
  const sequence = await prisma.emailSequence.findFirst({ where: { id: String(sequenceId), ownerId: user.id } });
  if (!sequence) throw badRequest('Sequence not found');
  if (!sequence.active) throw badRequest('Activate the sequence before enrolling carriers');
  return sequence;
}

/**
 * Save carriers from the FMCSA census by USDOT number. Records are always re-fetched from FMCSA on the server (never
 * from the cache and never from client data), counted against the plan's daily discovery and carrier limits, and
 * de-duplicated against the user's CRM by USDOT and MC.
 * Returns { requested, created, skipped, notFound, limited, ids, items: [{ dotNumber, id, status }] } where status is
 * created | existing | limited | not_found. `existing` items carry the id of the carrier already in the CRM.
 */
export async function saveCensusCarriers(user, dotNumbers, { stage = 'lead', sequence = null, sourceRef = (dot) => `USDOT ${dot}`, activity = 'FMCSA Census' } = {}) {
  const dots = [...new Set((dotNumbers || []).map(normDot).filter(Boolean))].slice(0, 200);
  if (!dots.length) throw badRequest('Select at least one carrier');
  await assertLimit(user, 'discoveryToday', 1);
  const left = await remainingMany(user, ['discoveryToday', 'carriers']);
  let budget = Math.min(left.discoveryToday, left.carriers);
  const records = await census.lookupMany(dots);
  const mcs = records.map((x) => normMc(x.mcNumber)).filter(Boolean);
  const mine = user.teamMembership ? { OR: [{ ownerId: user.id }, { assignedToId: user.id }] } : { ownerId: user.id };
  const existing = await prisma.carrier.findMany({
    where: { AND: [mine, { OR: [{ dotNumber: { in: dots } }, ...(mcs.length ? [{ mcNumber: { in: mcs } }] : [])] }] },
    select: { id: true, dotNumber: true, mcNumber: true },
  });
  const haveDot = new Map(existing.filter((e) => e.dotNumber).map((e) => [e.dotNumber, e.id]));
  const haveMc = new Map(existing.filter((e) => e.mcNumber).map((e) => [e.mcNumber, e.id]));
  const target = await stageByKey(stage);
  const now = new Date();
  const out = { requested: dots.length, created: 0, skipped: 0, notFound: 0, limited: 0, ids: [], items: [] };
  const found = new Set(records.map((x) => x.dotNumber));
  for (const d of dots) if (!found.has(d)) { out.notFound++; out.items.push({ dotNumber: d, id: null, status: 'not_found' }); }
  const created = [];
  for (const rec of records) {
    const already = haveDot.get(rec.dotNumber) || (rec.mcNumber && haveMc.get(normMc(rec.mcNumber)));
    if (already) { out.skipped++; out.items.push({ dotNumber: rec.dotNumber, id: already, status: 'existing' }); continue; }
    if (budget <= 0) { out.limited++; out.items.push({ dotNumber: rec.dotNumber, id: null, status: 'limited' }); continue; }
    const { _extra, ...fields } = rec;
    try {
      const c = await prisma.carrier.create({
        data: { ...fields, ownerId: user.id, stageId: target.id, source: 'fmcsa_census', sourceRef: String(sourceRef(rec.dotNumber)).slice(0, 190), verifiedAt: now },
      });
      out.created++;
      out.ids.push(c.id);
      out.items.push({ dotNumber: rec.dotNumber, id: c.id, status: 'created' });
      created.push(c);
      budget--;
      await runAutomations(user, 'carrier_created', { carrier: c });
    } catch (err) {
      if (err.code !== 'P2002') throw err;
      // Saved by a parallel request a moment ago: report the existing record.
      const row = await prisma.carrier.findFirst({ where: { ownerId: user.id, dotNumber: rec.dotNumber }, select: { id: true } });
      out.skipped++;
      out.items.push({ dotNumber: rec.dotNumber, id: row?.id || null, status: 'existing' });
    }
  }
  if (out.created) await logActivity(user, { type: 'import', summary: `Saved ${out.created} carrier(s) from ${activity}` });
  if (sequence && created.length) {
    const fresh = await prisma.carrier.findMany({ where: { id: { in: created.map((c) => c.id) }, ownerId: user.id } });
    const enr = await enrollCarriers(user, sequence.id, fresh);
    out.enrolled = enr.enrolled;
    out.sequence = { id: sequence.id, name: sequence.name };
  }
  return out;
}
