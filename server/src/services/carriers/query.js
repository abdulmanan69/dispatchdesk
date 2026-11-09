import { z, optStr } from '../../lib/validate.js';
import { ownerWhere, canViewTeam } from '../../lib/access.js';
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

/** Build a Prisma where clause for carriers visible to `user` under the given filters. */
export async function carrierWhere(user, f) {
  const scope = f.scope === 'team' && canViewTeam(user) ? 'team' : 'mine';
  const base = await ownerWhere(user, scope);
  const and = [];
  // Records assigned to this user by a team lead are visible in "mine" too.
  and.push(scope === 'mine' ? { OR: [base, { assignedToId: user.id }] } : base);
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
  return { AND: and };
}

export const listInclude = {
  stage: { select: { key: true, name: true, color: true } },
  tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
  assignedTo: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true } },
};

/** Last call and last activity time for a page of carriers (two grouped queries, no N+1). */
export async function lastTouches(ids) {
  if (!ids.length) return new Map();
  const [calls, acts] = await Promise.all([
    prisma.call.groupBy({ by: ['carrierId'], where: { carrierId: { in: ids } }, _max: { calledAt: true } }),
    prisma.activity.groupBy({ by: ['carrierId'], where: { carrierId: { in: ids }, type: { in: ['call', 'email', 'text', 'note', 'stage_change', 'sequence'] } }, _max: { createdAt: true } }),
  ]);
  const out = new Map(ids.map((id) => [id, { lastCallAt: null, lastActivityAt: null }]));
  for (const c of calls) out.get(c.carrierId).lastCallAt = c._max.calledAt;
  for (const a of acts) if (a.carrierId) out.get(a.carrierId).lastActivityAt = a._max.createdAt;
  return out;
}

export function serializeCarrier(c) {
  if (!c) return c;
  const { tags, ...rest } = c;
  return { ...rest, tags: tags ? tags.map((t) => t.tag) : undefined };
}

/** Access-checked fetch of many carrier ids; silently drops ids the user cannot write. */
export async function writableCarriers(user, ids) {
  const { loadCarrier } = await import('../../lib/access.js');
  const out = [];
  for (const id of [...new Set(ids)]) {
    try { out.push(await loadCarrier(user, id, { write: true })); } catch { /* skip inaccessible */ }
  }
  return out;
}

export async function stageKeyOf(stageId) {
  const s = await prisma.pipelineStage.findUnique({ where: { id: stageId } });
  return s?.key;
}
