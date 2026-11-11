import { z, optStr } from '../../lib/validate.js';
import { ownerWhere, canViewTeam, isTeamLead, teamMemberIds } from '../../lib/access.js';
import { digits } from './normalize.js';
import { prisma } from '../../db.js';

export const carrierFilterSchema = z.object({
  q: optStr(120),
  state: optStr(2),
  equipment: optStr(40),
  fleetMin: z.coerce.number().int().min(0).optional(),
  fleetMax: z.coerce.number().int().min(0).optional(),
  authorityStatus: optStr(20),
  authorityAgeMinMonths: z.coerce.number().int().min(0).optional(),
  authorityAgeMaxMonths: z.coerce.number().int().min(0).optional(),
  stage: optStr(20),
  tagId: optStr(40),
  assignedTo: optStr(40),
  source: optStr(30),
  hasPhone: z.enum(['true', 'false']).optional(),
  hasEmail: z.enum(['true', 'false']).optional(),
  // no_call | no_email | none (no call, email or text), optionally within the last `activityDays` days
  noActivity: z.enum(['any', 'no_call', 'no_email', 'none']).default('any'),
  activityDays: z.coerce.number().int().min(1).max(3650).optional(),
  scope: z.enum(['mine', 'team']).default('mine'),
});

const SORTS = { companyName: 'companyName', createdAt: 'createdAt', updatedAt: 'updatedAt', state: 'state', fleetSize: 'fleetSize', lastContactedAt: 'lastContactedAt', nextFollowUpAt: 'nextFollowUpAt', authorityDate: 'authorityDate', priority: 'priority' };

export function carrierOrder(sort, dir) {
  const field = SORTS[sort] || 'createdAt';
  return [{ [field]: dir === 'asc' ? 'asc' : 'desc' }, { id: 'asc' }];
}

const monthsAgo = (m) => { const d = new Date(); d.setMonth(d.getMonth() - m); return d; };

/**
 * Build a Prisma where clause for carriers visible to `user` under the given filters.
 * A user outside a team sees exactly their own rows: a plain `ownerId = ?` condition, so SQLite walks the
 * Carrier(ownerId, createdAt) / (ownerId, ...) indexes in order. Only team members get the extra "assigned to me" branch
 * (assignments only ever point at members of the owner's team, and leaving a team clears them).
 */
export async function carrierWhere(user, f) {
  const scope = f.scope === 'team' && canViewTeam(user) ? 'team' : 'mine';
  const base = await ownerWhere(user, scope);
  const and = [];
  // Records assigned to this user by a team lead are visible in "mine" too.
  if (scope === 'mine') and.push(user.teamMembership ? { OR: [base, { assignedToId: user.id }] } : base);
  else and.push(base);
  if (f.q) {
    const q = f.q.trim();
    const d = digits(q).replace(/^0+/, '');
    const or = [{ companyName: { contains: q } }, { dbaName: { contains: q } }, { email: { contains: q.toLowerCase() } }, { city: { contains: q } }];
    if (d.length >= 3) or.push({ dotNumber: { startsWith: d } }, { mcNumber: { startsWith: d } }, { phone: { contains: d } });
    and.push({ OR: or });
  }
  if (f.state) and.push({ state: f.state.toUpperCase() });
  if (f.equipment) and.push({ equipment: { contains: f.equipment } });
  if (f.fleetMin != null || f.fleetMax != null) and.push({ fleetSize: { ...(f.fleetMin != null ? { gte: f.fleetMin } : {}), ...(f.fleetMax != null ? { lte: f.fleetMax } : {}) } });
  if (f.authorityStatus) and.push({ authorityStatus: f.authorityStatus });
  // Authority age N months = authorityDate at least N months ago.
  if (f.authorityAgeMinMonths != null) and.push({ authorityDate: { lte: monthsAgo(f.authorityAgeMinMonths) } });
  if (f.authorityAgeMaxMonths != null) and.push({ authorityDate: { gte: monthsAgo(f.authorityAgeMaxMonths) } });
  if (f.stage) and.push({ stage: { key: f.stage } });
  if (f.tagId) and.push({ tags: { some: { tagId: f.tagId } } });
  if (f.assignedTo) and.push(f.assignedTo === 'unassigned' ? { assignedToId: null } : { assignedToId: f.assignedTo === 'me' ? user.id : f.assignedTo });
  if (f.source) and.push({ source: f.source });
  if (f.hasPhone === 'true') and.push({ phone: { not: null } });
  if (f.hasEmail === 'true') and.push({ email: { not: null } });
  if (f.noActivity && f.noActivity !== 'any') {
    const since = f.activityDays ? new Date(Date.now() - f.activityDays * 86400000) : null;
    const noCall = { calls: { none: since ? { calledAt: { gte: since } } : {} } };
    const noEmail = { emails: { none: { status: { in: ['sent', 'sending'] }, ...(since ? { sentAt: { gte: since } } : {}) } } };
    const noText = { activities: { none: { type: 'text', ...(since ? { createdAt: { gte: since } } : {}) } } };
    if (f.noActivity === 'no_call') and.push(noCall);
    else if (f.noActivity === 'no_email') and.push(noEmail);
    else and.push(noCall, noEmail, noText);
  }
  return and.length === 1 ? and[0] : { AND: and };
}

export const listInclude = {
  stage: { select: { key: true, name: true, color: true } },
  tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
  assignedTo: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true } },
};

/**
 * Columns the carrier list, pickers, the command palette and the browser extension read from GET /api/carriers.
 * Large or map-only columns (FMCSA snapshot JSON, truck location, classification text...) stay out of list payloads.
 */
export const listSelect = {
  id: true, ownerId: true, assignedToId: true, stageId: true,
  companyName: true, dbaName: true, dotNumber: true, mcNumber: true, phone: true, email: true,
  address: true, city: true, state: true, zip: true, timezone: true,
  equipment: true, fleetSize: true, drivers: true, authorityStatus: true, authorityDate: true, operatingStatus: true,
  source: true, verifiedAt: true, doNotCall: true, doNotEmail: true, priority: true, truckStatus: true,
  lastContactedAt: true, nextFollowUpAt: true, stageChangedAt: true, createdAt: true, updatedAt: true,
  ...listInclude,
};

/** At most this many carriers get last-touch lookups in one call (a list page is 200 at most). */
export const LAST_TOUCH_MAX = 200;

/** Last call and last activity time for a page of carriers (two grouped queries, no N+1). */
export async function lastTouches(ids) {
  const list = [...new Set(ids)].slice(0, LAST_TOUCH_MAX);
  if (!list.length) return new Map();
  const [calls, acts] = await Promise.all([
    prisma.call.groupBy({ by: ['carrierId'], where: { carrierId: { in: list } }, _max: { calledAt: true } }),
    prisma.activity.groupBy({ by: ['carrierId'], where: { carrierId: { in: list }, type: { in: ['call', 'email', 'text', 'note', 'stage_change', 'sequence'] } }, _max: { createdAt: true } }),
  ]);
  const out = new Map(list.map((id) => [id, { lastCallAt: null, lastActivityAt: null }]));
  for (const c of calls) out.get(c.carrierId).lastCallAt = c._max.calledAt;
  for (const a of acts) if (a.carrierId) out.get(a.carrierId).lastActivityAt = a._max.createdAt;
  return out;
}

export function serializeCarrier(c) {
  if (!c) return c;
  const { tags, ...rest } = c;
  return { ...rest, tags: tags ? tags.map((t) => t.tag) : undefined };
}

/** Split a list into chunks (SQLite bound-variable limits, and short write bursts). */
export function chunks(list, size = 500) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Let other requests run between batches of a long bulk job. */
export const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The same read/write rules as access.loadCarrier, evaluated in memory for rows already loaded:
 * readable = own, assigned to the user, or a team member's when the user may view team data;
 * writable = readable and (own, assigned, or the user is a team lead and the owner is in the team).
 */
export async function accessChecker(user) {
  const viewTeam = canViewTeam(user);
  const lead = isTeamLead(user);
  const team = viewTeam || lead ? new Set(await teamMemberIds(user)) : new Set([user.id]);
  const readable = (c) => c.ownerId === user.id || c.assignedToId === user.id || (viewTeam && team.has(c.ownerId));
  const writable = (c) => readable(c) && (c.ownerId === user.id || c.assignedToId === user.id || (lead && team.has(c.ownerId)));
  return { readable, writable };
}

/**
 * Access-checked fetch of many carrier ids; silently drops ids the user cannot write.
 * One query per 500 ids and one team lookup in total (instead of one findUnique per id).
 * `select` limits the columns (ownerId and assignedToId are always loaded for the access check). Input order is kept.
 */
export async function writableCarriers(user, ids, { select } = {}) {
  const uniq = [...new Set(ids.map(String))];
  if (!uniq.length) return [];
  const { writable } = await accessChecker(user);
  const sel = select ? { ...select, id: true, ownerId: true, assignedToId: true } : undefined;
  const rows = [];
  for (const part of chunks(uniq, 500)) {
    rows.push(...await prisma.carrier.findMany({ where: { id: { in: part } }, ...(sel ? { select: sel } : {}) }));
  }
  const byId = new Map(rows.filter(writable).map((c) => [c.id, c]));
  return uniq.map((id) => byId.get(id)).filter(Boolean);
}

/** Largest "select all matching" set a bulk action accepts. */
export const BULK_FILTER_CAP = 5000;

/**
 * Ids of every carrier matching a list filter (the "select all N matching" bulk mode), newest first.
 * Throws a 400 when more than `cap` match, so a bulk action never silently covers only part of a selection.
 */
export async function matchingCarrierIds(user, filter, cap = BULK_FILTER_CAP) {
  const where = await carrierWhere(user, filter);
  const rows = await prisma.carrier.findMany({ where, select: { id: true }, orderBy: carrierOrder(filter.sort, filter.dir), take: cap + 1 });
  return { ids: rows.slice(0, cap).map((r) => r.id), overCap: rows.length > cap };
}

export async function stageKeyOf(stageId) {
  const s = await prisma.pipelineStage.findUnique({ where: { id: stageId } });
  return s?.key;
}
