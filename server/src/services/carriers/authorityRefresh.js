import { prisma } from '../../db.js';
import { notify } from '../../lib/activity.js';
import { stopEnrollments } from '../sequenceEngine.js';
import { CHECKED_LABELS, authorityFields, checkAuthority } from './authority.js';
import { normMc } from './normalize.js';

/**
 * Re-check the operating authority of leads already in CRMs (FMCSA licensing dataset), so a carrier whose authority
 * lapses stops getting outreach.
 *
 * Who: carriers with an MC number that are not customers (customers are watched by the FMCSA watchlist), owned by an
 * active user, whose authority was never checked against licensing or was checked more than 7 days ago. "Checked" is
 * Carrier.operatingStatus holding a licensing label (authority.js CHECKED_LABELS) at Carrier.verifiedAt; no schema
 * change. Never-checked carriers go first, then the oldest checks.
 * How much: at most `max` carriers per run (2,000), `batch` (200) carriers per licensing request, one batch at a time
 * (one request to each of the two licensing datasets, legacy L&I and Motus).
 * A batch the datasets did not fully answer ends the run: carriers without a final answer (neither dataset answered,
 * or only one did and it does not show active authority) keep their status and are retried on the next run.
 * What changes: authorityStatus, operatingStatus (the licensing label) and verifiedAt. When a carrier turns inactive
 * (it was not inactive by licensing before), its active and paused sequence enrollments stop (stopReason
 * 'authority_inactive') so no more emails go to it, and its owner gets one in-app notification per run. Pending
 * authority does not stop sequences (the new-authority kit enrolls pending carriers on purpose). Carriers are never
 * deleted.
 */
export const REFRESH_MAX = 2000;
export const REFRESH_BATCH = 200;
export const RECHECK_DAYS = 7;
const DAY = 86_400_000;

const select = { id: true, ownerId: true, companyName: true, dotNumber: true, mcNumber: true, authorityStatus: true, operatingStatus: true, verifiedAt: true };

/** Carriers due for a check: never checked first, then checks older than RECHECK_DAYS (oldest first). */
export async function dueCarriers(now = new Date(), { max = REFRESH_MAX, ownerIds = null } = {}) {
  const base = {
    mcNumber: { not: null },
    customer: { is: null },
    owner: { status: 'active' },
    ...(ownerIds ? { ownerId: { in: ownerIds } } : {}),
  };
  const never = await prisma.carrier.findMany({
    where: { ...base, OR: [{ verifiedAt: null }, { operatingStatus: null }, { operatingStatus: { notIn: [...CHECKED_LABELS] } }] },
    orderBy: [{ verifiedAt: 'asc' }, { id: 'asc' }],
    take: max,
    select,
  });
  if (never.length >= max) return never;
  const stale = await prisma.carrier.findMany({
    where: { ...base, operatingStatus: { in: [...CHECKED_LABELS] }, verifiedAt: { lt: new Date(now.getTime() - RECHECK_DAYS * DAY) } },
    orderBy: [{ verifiedAt: 'asc' }, { id: 'asc' }],
    take: max - never.length,
    select,
  });
  return [...never, ...stale];
}

/**
 * One refresh run. Returns { due, checked, changed, turnedInactive, sequencesStopped, notified, unanswered }.
 * `ownerIds` limits the run to some owners (tests).
 */
export async function runAuthorityRefresh(now = new Date(), { max = REFRESH_MAX, batch = REFRESH_BATCH, ownerIds = null } = {}) {
  const due = await dueCarriers(now, { max, ownerIds });
  const out = { due: due.length, checked: 0, changed: 0, turnedInactive: 0, sequencesStopped: 0, notified: 0, unanswered: 0 };
  const lost = new Map(); // ownerId -> { carriers: [names], stopped }
  for (let i = 0; i < due.length; i += batch) {
    const part = due.slice(i, i + batch);
    const results = await checkAuthority(part.map((c) => ({ mc: c.mcNumber, dot: c.dotNumber })), { cacheMs: 0 });
    const groups = new Map(); // "status|label" -> { data, ids }
    const inactiveNow = [];
    let unanswered = 0;
    for (const c of part) {
      const a = results.get(normMc(c.mcNumber));
      // Only one of the two datasets answered: only "active" is final then (the other might show the authority).
      if (!a || (!a.complete && a.status !== 'active')) { unanswered++; continue; }
      const data = authorityFields(a);
      const key = `${data.authorityStatus}|${data.operatingStatus}`;
      if (!groups.has(key)) groups.set(key, { data, ids: [] });
      groups.get(key).ids.push(c.id);
      out.checked++;
      if (c.authorityStatus !== data.authorityStatus || c.operatingStatus !== data.operatingStatus) out.changed++;
      // "Turned inactive": not already inactive by an earlier licensing check (census-era values do not count).
      const wasInactive = c.authorityStatus === 'inactive' && CHECKED_LABELS.includes(c.operatingStatus);
      if (a.status === 'inactive' && !wasInactive) inactiveNow.push(c);
    }
    if (groups.size) {
      await prisma.$transaction([...groups.values()].map((g) => prisma.carrier.updateMany({ where: { id: { in: g.ids } }, data: { ...g.data, verifiedAt: now } })));
    }
    for (const c of inactiveNow) {
      const res = await stopEnrollments(c.id, 'authority_inactive');
      out.turnedInactive++;
      out.sequencesStopped += res.count;
      if (!lost.has(c.ownerId)) lost.set(c.ownerId, { names: [], stopped: 0 });
      const entry = lost.get(c.ownerId);
      entry.names.push(c.companyName);
      entry.stopped += res.count;
    }
    if (unanswered) {
      // A licensing dataset did not answer: leave the rest for the next run instead of retrying now.
      out.unanswered = unanswered + (due.length - i - part.length);
      break;
    }
  }
  for (const [ownerId, { names, stopped }] of lost) {
    const n = names.length;
    const shown = names.slice(0, 5).join(', ');
    await notify(ownerId, {
      type: 'fmcsa_change',
      title: `${n} lead${n === 1 ? '' : 's'} lost ${n === 1 ? 'its' : 'their'} operating authority${stopped ? ' — sequences stopped' : ''}`,
      body: `FMCSA licensing no longer shows active operating authority for ${shown}${n > 5 ? ` and ${n - 5} more` : ''}.${stopped ? ` ${stopped} sequence enrollment${stopped === 1 ? ' was' : 's were'} stopped so no more emails go to ${n === 1 ? 'it' : 'them'}.` : ''} The leads stay in your list, marked "Authority inactive".`,
      link: '/app/carriers?authorityStatus=inactive',
    });
    out.notified++;
  }
  return out;
}
