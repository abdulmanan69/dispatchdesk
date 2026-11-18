import { prisma } from '../db.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { logActivity, notify } from '../lib/activity.js';
import { memberAreas } from '../lib/teamAreas.js';

/**
 * Teams: carriers sales signs go to a dispatcher. A signed carrier waits in the manager's "To assign" list
 * (handoffStatus "pending") until a team lead picks a dispatcher, or goes straight to the next dispatcher in turn when
 * the team uses round robin. The carrier keeps its owner (the salesperson, who can still follow it) and soldById;
 * the dispatcher gets it through assignedToId, which grants read and write access (lib/access.js).
 */

const LEAD_ROLES = ['owner', 'manager'];

async function teamOf(userId) {
  return prisma.teamMember.findUnique({ where: { userId }, include: { team: true } });
}

/** Members who dispatch: the Dispatch area on, owners and managers excluded (they assign, they are not in the turn). */
export async function dispatchers(teamId) {
  const members = await prisma.teamMember.findMany({ where: { teamId }, include: { user: { select: { id: true, name: true, status: true } } }, orderBy: { joinedAt: 'asc' } });
  return members.filter((m) => !LEAD_ROLES.includes(m.role) && m.user.status === 'active' && memberAreas(m).includes('dispatch'));
}

/** Members a lead may assign a carrier to: anyone in the team with the Dispatch area (leads included). */
async function assignable(teamId) {
  const members = await prisma.teamMember.findMany({ where: { teamId }, include: { user: { select: { id: true, name: true, status: true } } } });
  return members.filter((m) => m.user.status === 'active' && memberAreas(m).includes('dispatch'));
}

async function leads(teamId) {
  return prisma.teamMember.findMany({ where: { teamId, role: { in: LEAD_ROLES } }, select: { userId: true } });
}

/** Give the carrier to `dispatcherId`: assignment, handoff done, notices to the dispatcher and the salesperson. */
async function giveTo(actor, carrier, dispatcherId, { auto = false } = {}) {
  const now = new Date();
  await prisma.carrier.update({ where: { id: carrier.id }, data: { assignedToId: dispatcherId, handoffStatus: 'assigned', handoffAt: now } });
  const dispatcher = await prisma.user.findUnique({ where: { id: dispatcherId }, select: { name: true } });
  if (dispatcherId !== actor.id) {
    await notify(dispatcherId, {
      type: 'assignment', title: `New carrier for you: ${carrier.companyName}`,
      body: carrier.soldById && carrier.soldById !== dispatcherId ? 'Signed by sales and handed to you to dispatch.' : 'Handed to you to dispatch.',
      link: `/app/carriers/${carrier.id}`,
    });
  }
  if (carrier.soldById && carrier.soldById !== actor.id && carrier.soldById !== dispatcherId) {
    await notify(carrier.soldById, { type: 'team', title: `${carrier.companyName} is with ${dispatcher?.name || 'a dispatcher'} now`, link: `/app/carriers/${carrier.id}` });
  }
  await logActivity(actor, {
    type: 'assignment', carrierId: carrier.id,
    summary: `${carrier.companyName} handed to ${dispatcher?.name || 'a dispatcher'} for dispatch${auto ? ' (in turn)' : ''}`,
  });
}

/** The next dispatcher in turn after the team's last one, or null when nobody dispatches. */
async function nextInTurn(team) {
  const list = await dispatchers(team.id);
  if (!list.length) return null;
  const i = list.findIndex((m) => m.userId === team.roundRobinLastId);
  const next = list[(i + 1) % list.length];
  await prisma.team.update({ where: { id: team.id }, data: { roundRobinLastId: next.userId } });
  return next.userId;
}

/**
 * Send a carrier to dispatch: round robin assigns it now; otherwise it waits in To assign and the team leads are told.
 * `actor` is who signed or handed it off. Returns { status: 'assigned' | 'pending', assignedToId? }.
 */
export async function queueHandoff(actor, carrier, { membership = null } = {}) {
  const m = membership || (await teamOf(actor.id));
  if (!m) throw badRequest('Handing a carrier to dispatch needs a team');
  const soldById = carrier.soldById || actor.id;
  const fresh = { ...carrier, soldById };
  if (!carrier.soldById) await prisma.carrier.update({ where: { id: carrier.id }, data: { soldById } });
  // The session's copy of the team can be older than the last turn: read the mode and the turn from the database.
  const team = await prisma.team.findUnique({ where: { id: m.teamId } });
  if (team?.handoffMode === 'round_robin') {
    const next = await nextInTurn(team);
    if (next) {
      await giveTo(actor, fresh, next, { auto: true });
      return { status: 'assigned', assignedToId: next };
    }
  }
  await prisma.carrier.update({ where: { id: carrier.id }, data: { handoffStatus: 'pending', handoffAt: new Date() } });
  for (const l of await leads(m.teamId)) {
    if (l.userId === actor.id) continue;
    await notify(l.userId, {
      type: 'team', title: `${carrier.companyName} needs a dispatcher`,
      body: `${actor.name} signed it. Assign a dispatcher in Team → To assign.`,
      link: '/app/team?tab=assign',
    });
  }
  await logActivity(actor, { type: 'assignment', carrierId: carrier.id, summary: `${carrier.companyName} is waiting for a dispatcher` });
  return { status: 'pending' };
}

/**
 * When a carrier is signed (pipeline stage "customer"): remember who signed it, and send it to dispatch when the
 * signer does not dispatch it themselves (a salesperson, or anyone without the Dispatch area) and no dispatcher has it.
 */
export async function onCarrierSigned(user, carrier) {
  const m = user.teamMembership?.team ? user.teamMembership : await teamOf(user.id);
  if (!m) return null;
  const fresh = await prisma.carrier.findUnique({ where: { id: carrier.id }, select: { id: true, companyName: true, ownerId: true, assignedToId: true, soldById: true, handoffStatus: true } });
  if (!fresh) return null;
  if (!fresh.soldById) {
    // Credit the salesperson who owns it when a lead or dispatcher marks it signed; otherwise whoever signed it.
    const owner = fresh.ownerId !== user.id ? await prisma.teamMember.findFirst({ where: { teamId: m.teamId, userId: fresh.ownerId }, select: { role: true } }) : null;
    fresh.soldById = owner?.role === 'sales' ? fresh.ownerId : user.id;
    await prisma.carrier.update({ where: { id: fresh.id }, data: { soldById: fresh.soldById } });
  }
  if (fresh.handoffStatus) return null; // already waiting or handed over
  const dispatches = memberAreas(m).includes('dispatch') && m.role !== 'sales';
  if (dispatches) return null;
  if (fresh.assignedToId && fresh.assignedToId !== user.id) {
    const a = await prisma.teamMember.findFirst({ where: { teamId: m.teamId, userId: fresh.assignedToId } });
    if (a && memberAreas(a).includes('dispatch')) return null; // a dispatcher already has it
  }
  return queueHandoff(user, fresh, { membership: m });
}

/** A team lead assigns a waiting (or any team) carrier to a member who dispatches. */
export async function assignHandoff(actor, carrierId, dispatcherId) {
  const m = await teamOf(actor.id);
  if (!m || !LEAD_ROLES.includes(m.role)) throw forbidden('Only the team owner or a manager can assign carriers to dispatchers');
  const memberIds = (await prisma.teamMember.findMany({ where: { teamId: m.teamId }, select: { userId: true } })).map((x) => x.userId);
  const carrier = await prisma.carrier.findFirst({ where: { id: carrierId, ownerId: { in: memberIds } } });
  if (!carrier) throw notFound('Carrier not found in your team');
  const target = (await assignable(m.teamId)).find((x) => x.userId === dispatcherId);
  if (!target) throw badRequest('Choose a team member who has the Dispatch area');
  await giveTo(actor, carrier, dispatcherId);
  return prisma.carrier.findUnique({ where: { id: carrier.id }, select: { id: true, assignedToId: true, handoffStatus: true, handoffAt: true } });
}

/** The team's handoffs: waiting ones first, then the last 30 days of assigned ones. */
export async function listHandoffs(teamId) {
  const memberIds = (await prisma.teamMember.findMany({ where: { teamId }, select: { userId: true } })).map((x) => x.userId);
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await prisma.carrier.findMany({
    where: { ownerId: { in: memberIds }, OR: [{ handoffStatus: 'pending' }, { handoffStatus: 'assigned', handoffAt: { gte: since } }] },
    select: {
      id: true, companyName: true, dotNumber: true, mcNumber: true, city: true, state: true, equipment: true, fleetSize: true,
      ownerId: true, soldById: true, assignedToId: true, handoffStatus: true, handoffAt: true,
      customer: { select: { signedAt: true, dispatchFeePercent: true } },
      assignedTo: { select: { id: true, name: true } },
    },
    orderBy: { handoffAt: 'desc' }, take: 300,
  });
  const names = Object.fromEntries((await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.soldById).filter(Boolean))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const shape = (r) => ({ ...r, soldBy: r.soldById ? { id: r.soldById, name: names[r.soldById] || 'Former member' } : null, signedAt: r.customer?.signedAt || null, dispatchFeePercent: r.customer?.dispatchFeePercent ?? null, customer: undefined });
  return {
    pending: rows.filter((r) => r.handoffStatus === 'pending').map(shape).reverse(), // oldest waiting first
    assigned: rows.filter((r) => r.handoffStatus === 'assigned').map(shape),
    dispatchers: (await assignable(teamId)).map((x) => ({ userId: x.userId, name: x.user.name, role: x.role })),
  };
}

/**
 * A member leaves the team: the work they added while in it stays with the team, handed to `toUserId`.
 * Carriers created since they joined move with the records that hang on them (customer, opportunity, documents,
 * loads, negotiations, onboarding links) and their open follow-ups. A carrier the receiver already has (same DOT or
 * MC number) stays with the member. Their own mailbox, settings and anything from before they joined stay theirs.
 */
export async function keepTeamWork(leaver, joinedAt, toUserId) {
  const carriers = await prisma.carrier.findMany({ where: { ownerId: leaver, createdAt: { gte: joinedAt } }, select: { id: true, dotNumber: true, mcNumber: true } });
  if (!carriers.length) return { carriers: 0, skipped: 0 };
  const dots = carriers.map((c) => c.dotNumber).filter(Boolean);
  const mcs = carriers.map((c) => c.mcNumber).filter(Boolean);
  const theirs = await prisma.carrier.findMany({ where: { ownerId: toUserId, OR: [{ dotNumber: { in: dots } }, { mcNumber: { in: mcs } }] }, select: { dotNumber: true, mcNumber: true } });
  const takenDot = new Set(theirs.map((c) => c.dotNumber).filter(Boolean));
  const takenMc = new Set(theirs.map((c) => c.mcNumber).filter(Boolean));
  const moving = carriers.filter((c) => !(c.dotNumber && takenDot.has(c.dotNumber)) && !(c.mcNumber && takenMc.has(c.mcNumber))).map((c) => c.id);
  if (!moving.length) return { carriers: 0, skipped: carriers.length };
  const onCarriers = { ownerId: leaver, carrierId: { in: moving } };
  await prisma.$transaction([
    prisma.carrier.updateMany({ where: { id: { in: moving } }, data: { ownerId: toUserId } }),
    // A carrier the leaver had assigned to themselves goes back to whoever gets it.
    prisma.carrier.updateMany({ where: { id: { in: moving }, assignedToId: leaver }, data: { assignedToId: null } }),
    prisma.customer.updateMany({ where: onCarriers, data: { ownerId: toUserId } }),
    prisma.opportunity.updateMany({ where: onCarriers, data: { ownerId: toUserId } }),
    prisma.document.updateMany({ where: onCarriers, data: { ownerId: toUserId } }),
    prisma.load.updateMany({ where: onCarriers, data: { ownerId: toUserId } }),
    prisma.negotiation.updateMany({ where: onCarriers, data: { ownerId: toUserId } }),
    prisma.onboardingLink.updateMany({ where: onCarriers, data: { ownerId: toUserId } }),
    prisma.followUp.updateMany({ where: { userId: leaver, carrierId: { in: moving }, status: 'pending' }, data: { userId: toUserId } }),
  ]);
  return { carriers: moving.length, skipped: carriers.length - moving.length };
}
