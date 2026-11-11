import { prisma } from '../db.js';
import { notFound, forbidden } from './errors.js';

/**
 * Tenant isolation rules
 * - Every CRM record has an ownerId (the dispatcher whose pipeline it belongs to).
 * - A user always sees their own records.
 * - Team owners/managers (when team.managersSeeAll) and members granted canViewTeamData
 *   may READ records owned by other members of the same team.
 * - Writes are allowed for the owner, the assigned dispatcher, or a team owner/manager.
 * Platform admins do NOT get implicit access to private pipelines.
 */

export function teamRole(user) {
  return user.teamMembership?.role ?? null;
}

export function isTeamLead(user) {
  const r = teamRole(user);
  return r === 'owner' || r === 'manager';
}

export async function teamMemberIds(user) {
  if (!user.teamMembership) return [user.id];
  if (user._teamIds) return user._teamIds;
  const rows = await prisma.teamMember.findMany({ where: { teamId: user.teamMembership.teamId }, select: { userId: true } });
  user._teamIds = rows.map((r) => r.userId);
  return user._teamIds;
}

export function canViewTeam(user) {
  const m = user.teamMembership;
  if (!m) return false;
  if (m.canViewTeamData) return true;
  return isTeamLead(user) && (m.role === 'owner' || m.team?.managersSeeAll !== false);
}

/** Owner ids whose data the user may read, for scope "mine" | "team". */
export async function readableOwnerIds(user, scope = 'mine') {
  if (scope === 'team' && canViewTeam(user)) return teamMemberIds(user);
  return [user.id];
}

export async function ownerWhere(user, scope = 'mine', field = 'ownerId') {
  const ids = await readableOwnerIds(user, scope);
  return ids.length === 1 ? { [field]: ids[0] } : { [field]: { in: ids } };
}

export async function canReadOwner(user, ownerId) {
  if (ownerId === user.id) return true;
  if (!canViewTeam(user)) return false;
  return (await teamMemberIds(user)).includes(ownerId);
}

async function canWriteOwner(user, ownerId, assignedToId) {
  if (ownerId === user.id || assignedToId === user.id) return true;
  if (!isTeamLead(user)) return false;
  return (await teamMemberIds(user)).includes(ownerId);
}

/**
 * True when `user` may read `carrier` ({ ownerId, assignedToId }). `user` needs `teamMembership` (with `team`) loaded,
 * as the session user has. Used where no request user exists, e.g. a public link checked against the link's owner.
 */
export async function userCanReadCarrier(user, carrier) {
  if (!user || !carrier) return false;
  return carrier.assignedToId === user.id || canReadOwner(user, carrier.ownerId);
}

/** Load a carrier the user may access, or throw 404 (never leak existence). */
export async function loadCarrier(user, id, { write = false, include } = {}) {
  const carrier = await prisma.carrier.findUnique({ where: { id: String(id) }, include });
  if (!carrier) throw notFound('Carrier not found');
  const readable = (await canReadOwner(user, carrier.ownerId)) || carrier.assignedToId === user.id;
  if (!readable) throw notFound('Carrier not found');
  if (write && !(await canWriteOwner(user, carrier.ownerId, carrier.assignedToId))) throw forbidden('Read-only access to this carrier');
  return carrier;
}

/** Generic owned-record loader for models with an ownerId column. */
export async function loadOwned(model, user, id, { write = false, include, ownerField = 'ownerId' } = {}) {
  const row = await prisma[model].findUnique({ where: { id: String(id) }, include });
  if (!row) throw notFound();
  if (!(await canReadOwner(user, row[ownerField]))) throw notFound();
  if (write && !(await canWriteOwner(user, row[ownerField], null))) throw forbidden('Read-only access');
  return row;
}
