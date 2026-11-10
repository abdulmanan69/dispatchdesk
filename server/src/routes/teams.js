import { Router } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { ah, badRequest, forbidden, notFound, conflict, paymentRequired } from '../lib/errors.js';
import { parse, z, reqStr, reqEmail, pageQuery, paginate, pageResult } from '../lib/validate.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { logActivity, notify } from '../lib/activity.js';
import { canViewTeam } from '../lib/access.js';
import { requireAuth, requirePermission, invalidateUserSessions } from '../middleware/auth.js';
import { sendSystemMail } from '../services/email/system.js';
import { getSetting } from '../lib/settings.js';

const r = Router();
// Membership/role changes alter what users can see: drop cached sessions after any team write.
r.use((req, res, next) => { if (req.method !== 'GET') res.on('finish', () => invalidateUserSessions()); next(); });
const DAY = 86400000;

const memberInclude = { user: { select: { id: true, name: true, email: true, avatarPath: true, updatedAt: true, lastLoginAt: true, role: { select: { key: true, name: true } } } } };

async function myMembership(userId) {
  return prisma.teamMember.findUnique({ where: { userId }, include: { team: true } });
}

async function requireMembership(req) {
  const m = await myMembership(req.user.id);
  if (!m) throw notFound('You are not a member of a team');
  return m;
}

const isLead = (m) => m.role === 'owner' || m.role === 'manager';
const canManage = (m) => isLead(m) || m.canManageMembers;

function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(2, local.length - 1))}@${domain}`;
}

/** Active seat-limited subscription for a team, if any. */
async function teamSeatLimit(teamId) {
  const sub = await prisma.subscription.findFirst({ where: { teamId, status: { in: ['active', 'trialing'] } }, include: { plan: true }, orderBy: { createdAt: 'desc' } });
  return sub?.plan?.perSeat ? sub.seats : null;
}

async function assertSeat(teamId, { includePending = false } = {}) {
  const seats = await teamSeatLimit(teamId);
  if (seats == null) return;
  const members = await prisma.teamMember.count({ where: { teamId } });
  const pending = includePending ? await prisma.invitation.count({ where: { teamId, status: 'pending', expiresAt: { gt: new Date() } } }) : 0;
  if (members + pending >= seats) {
    throw paymentRequired(`Your team subscription has ${seats} seat${seats === 1 ? '' : 's'}. Add seats in Billing before inviting more members.`, { seats, members, pending });
  }
}

function serializeMember(m) {
  return {
    id: m.id, userId: m.userId, role: m.role, canViewTeamData: m.canViewTeamData, canManageMembers: m.canManageMembers, joinedAt: m.joinedAt,
    name: m.user.name, email: m.user.email, lastLoginAt: m.user.lastLoginAt, platformRole: m.user.role?.name,
    avatarUrl: m.user.avatarPath ? `/api/profile/avatar/${m.user.id}?v=${m.user.updatedAt.getTime()}` : null,
  };
}

// ---------------------------------------------------------------------------
// Public invitation preview (no session needed)
// ---------------------------------------------------------------------------
r.get('/invitations/:token', ah(async (req, res) => {
  const inv = await prisma.invitation.findUnique({
    where: { tokenHash: sha256(String(req.params.token)) },
    include: { team: { select: { name: true } }, invitedBy: { select: { name: true } } },
  });
  if (!inv) throw notFound('Invitation not found');
  const expired = inv.expiresAt < new Date();
  res.json({
    team: inv.team.name, invitedBy: inv.invitedBy.name, email: maskEmail(inv.email), role: inv.role,
    status: expired && inv.status === 'pending' ? 'expired' : inv.status, expiresAt: inv.expiresAt,
    emailMatches: req.user ? req.user.email === inv.email : null,
  });
}));

r.use(requireAuth);

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------
r.get('/mine', ah(async (req, res) => {
  const m = await myMembership(req.user.id);
  if (!m) {
    const invites = await prisma.invitation.findMany({
      where: { email: req.user.email, status: 'pending', expiresAt: { gt: new Date() } },
      include: { team: { select: { name: true } }, invitedBy: { select: { name: true } } },
    });
    return res.json({ team: null, canCreate: req.permissions.has('team.create'), invitationsForMe: invites.map((i) => ({ id: i.id, team: i.team.name, invitedBy: i.invitedBy.name, role: i.role, expiresAt: i.expiresAt })) });
  }
  const [members, invitations, seats] = await Promise.all([
    prisma.teamMember.findMany({ where: { teamId: m.teamId }, include: memberInclude, orderBy: { joinedAt: 'asc' } }),
    canManage(m) ? prisma.invitation.findMany({ where: { teamId: m.teamId, status: 'pending' }, orderBy: { createdAt: 'desc' }, include: { invitedBy: { select: { name: true } } } }) : [],
    teamSeatLimit(m.teamId),
  ]);
  res.json({
    team: { id: m.team.id, name: m.team.name, ownerId: m.team.ownerId, leaderboardEnabled: m.team.leaderboardEnabled, managersSeeAll: m.team.managersSeeAll, createdAt: m.team.createdAt },
    me: { role: m.role, canViewTeamData: m.canViewTeamData, canManageMembers: m.canManageMembers, canManage: canManage(m), canViewTeam: canViewTeam({ teamMembership: m }) },
    seats,
    members: members.map(serializeMember),
    invitations: invitations.map((i) => ({ id: i.id, email: i.email, role: i.role, status: i.expiresAt < new Date() ? 'expired' : i.status, expiresAt: i.expiresAt, invitedBy: i.invitedBy.name, createdAt: i.createdAt })),
  });
}));

r.post('/', requirePermission('team.create'), ah(async (req, res) => {
  const { name } = parse(z.object({ name: reqStr(80) }), req.body);
  if (await myMembership(req.user.id)) throw conflict('You are already in a team. Leave it before creating a new one.');
  const team = await prisma.team.create({
    data: { name, ownerId: req.user.id, members: { create: { userId: req.user.id, role: 'owner', canViewTeamData: true, canManageMembers: true } } },
  });
  // Existing activities become visible on the team feed.
  await prisma.activity.updateMany({ where: { userId: req.user.id, teamId: null }, data: { teamId: team.id } });
  await audit(req, 'team.created', { entityType: 'team', entityId: team.id });
  res.status(201).json({ team });
}));

r.patch('/mine', ah(async (req, res) => {
  const m = await requireMembership(req);
  if (!isLead(m)) throw forbidden('Only the team owner or a manager can change team settings');
  const body = parse(z.object({ name: reqStr(80).optional(), leaderboardEnabled: z.boolean().optional(), managersSeeAll: z.boolean().optional() }), req.body);
  if (body.managersSeeAll !== undefined && m.role !== 'owner') throw forbidden('Only the owner can change visibility rules');
  const team = await prisma.team.update({ where: { id: m.teamId }, data: body });
  await audit(req, 'team.updated', { entityType: 'team', entityId: team.id, details: body });
  res.json({ team });
}));

r.delete('/mine', ah(async (req, res) => {
  const m = await requireMembership(req);
  if (m.role !== 'owner') throw forbidden('Only the owner can delete the team');
  const { confirm } = parse(z.object({ confirm: z.string() }), req.body);
  if (confirm !== m.team.name) throw badRequest('Type the team name to confirm deletion');
  const live = await prisma.subscription.count({ where: { teamId: m.teamId, status: { in: ['active', 'trialing', 'past_due'] } } });
  if (live) throw conflict('Cancel the team subscription in Billing before deleting the team');
  await prisma.team.delete({ where: { id: m.teamId } });
  await audit(req, 'team.deleted', { entityType: 'team', entityId: m.teamId });
  res.json({ ok: true });
}));

r.post('/transfer', ah(async (req, res) => {
  const m = await requireMembership(req);
  if (m.role !== 'owner') throw forbidden('Only the owner can transfer ownership');
  const { userId } = parse(z.object({ userId: reqStr(60) }), req.body);
  if (userId === req.user.id) throw badRequest('You already own this team');
  const target = await prisma.teamMember.findFirst({ where: { teamId: m.teamId, userId } });
  if (!target) throw notFound('Member not found');
  await prisma.$transaction([
    prisma.teamMember.update({ where: { id: target.id }, data: { role: 'owner', canViewTeamData: true, canManageMembers: true } }),
    prisma.teamMember.update({ where: { id: m.id }, data: { role: 'manager' } }),
    prisma.team.update({ where: { id: m.teamId }, data: { ownerId: userId } }),
  ]);
  await notify(userId, { type: 'team', title: `You are now the owner of ${m.team.name}`, link: '/app/team' });
  await audit(req, 'team.ownership_transferred', { entityType: 'team', entityId: m.teamId, details: { to: userId } });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------
r.post('/invitations', ah(async (req, res) => {
  const m = await requireMembership(req);
  if (!canManage(m)) throw forbidden('You do not have permission to invite members');
  const body = parse(z.object({ email: reqEmail, role: z.enum(['manager', 'dispatcher']).default('dispatcher') }), req.body);
  if (body.role === 'manager' && m.role !== 'owner') throw forbidden('Only the owner can invite managers');
  const existingUser = await prisma.user.findUnique({ where: { email: body.email }, include: { teamMembership: true } });
  if (existingUser?.teamMembership?.teamId === m.teamId) throw conflict('That person is already a member of this team');
  const pending = await prisma.invitation.findFirst({ where: { teamId: m.teamId, email: body.email, status: 'pending', expiresAt: { gt: new Date() } } });
  if (pending) throw conflict('An invitation for this email is already pending. Revoke it to send a new one.');
  await assertSeat(m.teamId, { includePending: true });

  const token = randomToken(32);
  const inv = await prisma.invitation.create({
    data: { teamId: m.teamId, email: body.email, role: body.role, tokenHash: sha256(token), invitedById: req.user.id, expiresAt: new Date(Date.now() + 7 * DAY) },
  });
  const link = `${config.appUrl}/invite/${token}`;
  const appName = await getSetting('app.name');
  const mail = await sendSystemMail({
    to: body.email,
    subject: `${req.user.name} invited you to ${m.team.name} on ${appName}`,
    text: `${req.user.name} invited you to join the team "${m.team.name}" as ${body.role}.\n\nAccept the invitation:\n${link}\n\nThe link expires in 7 days.`,
  });
  await audit(req, 'team.invitation_sent', { entityType: 'invitation', entityId: inv.id, details: { email: body.email, role: body.role, emailSent: mail.sent } });
  res.status(201).json({
    invitation: { id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt },
    emailSent: mail.sent,
    emailError: mail.sent ? undefined : mail.reason,
    // The inviter can share this link manually when platform email is not configured.
    inviteLink: link,
    ...(config.exposeDevTokens ? { devToken: token } : {}),
  });
}));

r.delete('/invitations/:id', ah(async (req, res) => {
  const m = await requireMembership(req);
  if (!canManage(m)) throw forbidden();
  const inv = await prisma.invitation.findFirst({ where: { id: String(req.params.id), teamId: m.teamId } });
  if (!inv) throw notFound('Invitation not found');
  await prisma.invitation.update({ where: { id: inv.id }, data: { status: 'revoked' } });
  await audit(req, 'team.invitation_revoked', { entityType: 'invitation', entityId: inv.id });
  res.json({ ok: true });
}));

async function acceptInvitation(req, inv) {
  if (inv.status !== 'pending' || inv.expiresAt < new Date()) throw badRequest('This invitation is no longer valid');
  if (inv.email !== req.user.email) throw forbidden(`This invitation was sent to ${maskEmail(inv.email)}. Sign in with that email to accept it.`);
  if (await myMembership(req.user.id)) throw conflict('You are already in a team. Leave it before joining another.');
  await assertSeat(inv.teamId);
  await prisma.$transaction([
    prisma.teamMember.create({ data: { teamId: inv.teamId, userId: req.user.id, role: inv.role, canViewTeamData: inv.role === 'manager' } }),
    prisma.invitation.update({ where: { id: inv.id }, data: { status: 'accepted', acceptedAt: new Date() } }),
    prisma.activity.updateMany({ where: { userId: req.user.id, teamId: null }, data: { teamId: inv.teamId } }),
  ]);
  const team = await prisma.team.findUnique({ where: { id: inv.teamId } });
  await notify(inv.invitedById, { type: 'team', title: `${req.user.name} joined ${team.name}`, link: '/app/team' });
  await logActivity({ ...req.user, teamMembership: { teamId: inv.teamId } }, { type: 'team', summary: `${req.user.name} joined the team` });
  await audit(req, 'team.invitation_accepted', { entityType: 'team', entityId: inv.teamId });
  return team;
}

r.post('/invitations/:token/accept', ah(async (req, res) => {
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(String(req.params.token)) } });
  if (!inv) throw notFound('Invitation not found');
  const team = await acceptInvitation(req, inv);
  res.json({ ok: true, team: { id: team.id, name: team.name } });
}));

// Accept from the in-app list of invitations addressed to the user's email.
r.post('/invitations/:id/accept-by-id', ah(async (req, res) => {
  const inv = await prisma.invitation.findUnique({ where: { id: String(req.params.id) } });
  if (!inv) throw notFound('Invitation not found');
  const team = await acceptInvitation(req, inv);
  res.json({ ok: true, team: { id: team.id, name: team.name } });
}));

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------
r.patch('/members/:userId', ah(async (req, res) => {
  const m = await requireMembership(req);
  if (!canManage(m)) throw forbidden();
  const body = parse(z.object({ role: z.enum(['manager', 'dispatcher']).optional(), canViewTeamData: z.boolean().optional(), canManageMembers: z.boolean().optional() }), req.body);
  const target = await prisma.teamMember.findFirst({ where: { teamId: m.teamId, userId: String(req.params.userId) } });
  if (!target) throw notFound('Member not found');
  if (target.role === 'owner') throw forbidden('The owner\'s role cannot be changed. Transfer ownership instead.');
  if ((body.role !== undefined || body.canManageMembers !== undefined) && m.role !== 'owner') throw forbidden('Only the owner can change roles and member-management rights');
  if (target.userId === req.user.id && m.role !== 'owner') throw forbidden('You cannot change your own permissions');
  const updated = await prisma.teamMember.update({ where: { id: target.id }, data: body, include: memberInclude });
  await audit(req, 'team.member_updated', { entityType: 'teamMember', entityId: target.id, details: body });
  res.json({ member: serializeMember(updated) });
}));

r.delete('/members/:userId', ah(async (req, res) => {
  const m = await requireMembership(req);
  const targetId = req.params.userId === 'me' ? req.user.id : String(req.params.userId);
  const target = await prisma.teamMember.findFirst({ where: { teamId: m.teamId, userId: targetId } });
  if (!target) throw notFound('Member not found');
  if (target.role === 'owner') throw forbidden(targetId === req.user.id ? 'Transfer ownership or delete the team before leaving.' : 'The owner cannot be removed');
  if (targetId !== req.user.id) {
    if (!canManage(m)) throw forbidden();
    if (target.role === 'manager' && m.role !== 'owner') throw forbidden('Only the owner can remove a manager');
  }
  await prisma.teamMember.delete({ where: { id: target.id } });
  // Unassign carriers of other members that were assigned to the departing user.
  const memberIds = (await prisma.teamMember.findMany({ where: { teamId: m.teamId }, select: { userId: true } })).map((x) => x.userId);
  await prisma.carrier.updateMany({ where: { assignedToId: targetId, ownerId: { in: memberIds } }, data: { assignedToId: null } });
  if (targetId !== req.user.id) await notify(targetId, { type: 'team', title: `You were removed from ${m.team.name}` });
  await audit(req, targetId === req.user.id ? 'team.left' : 'team.member_removed', { entityType: 'team', entityId: m.teamId, details: { userId: targetId } });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Activity, leaderboard, board
// ---------------------------------------------------------------------------
r.get('/activity', ah(async (req, res) => {
  const m = await requireMembership(req);
  const q = parse(z.object({ ...pageQuery, type: z.string().max(40).optional() }), req.query);
  const visible = canViewTeam({ teamMembership: m });
  const where = visible ? { teamId: m.teamId } : { userId: req.user.id };
  if (q.type) where.type = q.type;
  const [items, total] = await Promise.all([
    prisma.activity.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q), include: { user: { select: { id: true, name: true } }, carrier: { select: { id: true, companyName: true, ownerId: true } } } }),
    prisma.activity.count({ where }),
  ]);
  res.json({ ...pageResult(items.map((a) => ({ ...a, metadata: undefined })), total, q), scope: visible ? 'team' : 'mine' });
}));

const METRICS = ['dials', 'downloaded', 'inTouch', 'followUps', 'opportunities', 'trials', 'customers'];

/** Activity metrics per user since `since`. */
export async function memberMetrics(userIds, since) {
  const g = (rows, key = 'userId') => Object.fromEntries(rows.map((x) => [x[key], x._count._all]));
  const [dials, downloaded, touchCalls, touchEmails, followUps, opps, trials, customers] = await Promise.all([
    prisma.call.groupBy({ by: ['userId'], where: { userId: { in: userIds }, calledAt: { gte: since } }, _count: { _all: true } }),
    prisma.carrier.groupBy({ by: ['ownerId'], where: { ownerId: { in: userIds }, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.call.groupBy({ by: ['userId'], where: { userId: { in: userIds }, calledAt: { gte: since }, outcome: { in: ['interested', 'call_back', 'follow_up', 'converted'] } }, _count: { _all: true } }),
    prisma.email.groupBy({ by: ['userId'], where: { userId: { in: userIds }, status: 'sent', sentAt: { gte: since } }, _count: { _all: true } }),
    prisma.followUp.groupBy({ by: ['userId'], where: { userId: { in: userIds }, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.opportunity.groupBy({ by: ['ownerId'], where: { ownerId: { in: userIds }, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.opportunity.groupBy({ by: ['ownerId'], where: { ownerId: { in: userIds }, trialStartedAt: { gte: since } }, _count: { _all: true } }),
    prisma.customer.groupBy({ by: ['ownerId'], where: { ownerId: { in: userIds }, signedAt: { gte: since } }, _count: { _all: true } }),
  ]);
  const maps = {
    dials: g(dials), downloaded: g(downloaded, 'ownerId'), touchCalls: g(touchCalls), touchEmails: g(touchEmails),
    followUps: g(followUps), opportunities: g(opps, 'ownerId'), trials: g(trials, 'ownerId'), customers: g(customers, 'ownerId'),
  };
  return Object.fromEntries(userIds.map((id) => [id, {
    dials: maps.dials[id] || 0,
    downloaded: maps.downloaded[id] || 0,
    inTouch: (maps.touchCalls[id] || 0) + (maps.touchEmails[id] || 0),
    followUps: maps.followUps[id] || 0,
    opportunities: maps.opportunities[id] || 0,
    trials: maps.trials[id] || 0,
    customers: maps.customers[id] || 0,
  }]));
}

const score = (x) => x.dials + x.downloaded * 0.25 + x.inTouch * 2 + x.followUps + x.opportunities * 5 + x.trials * 8 + x.customers * 15;

r.get('/leaderboard', ah(async (req, res) => {
  const q = parse(z.object({ range: z.enum(['week', 'month']).default('week'), mode: z.enum(['team', 'me']).default('team') }), req.query);
  const since = new Date(Date.now() - (q.range === 'week' ? 7 : 30) * DAY);
  const m = await myMembership(req.user.id);
  let members;
  if (q.mode === 'me' || !m) {
    members = [{ userId: req.user.id, role: m?.role ?? null, user: { name: req.user.name } }];
  } else {
    if (!m.team.leaderboardEnabled && !isLead(m)) throw forbidden('The leaderboard is turned off for this team');
    members = await prisma.teamMember.findMany({ where: { teamId: m.teamId }, include: { user: { select: { name: true } } } });
  }
  const metrics = await memberMetrics(members.map((x) => x.userId), since);
  const rows = members.map((x) => ({ userId: x.userId, name: x.user.name, role: x.role, me: x.userId === req.user.id, ...metrics[x.userId], score: Math.round(score(metrics[x.userId])) }))
    .sort((a, b) => b.score - a.score)
    .map((row, i) => ({ rank: i + 1, ...row }));
  const totals = Object.fromEntries(METRICS.map((k) => [k, rows.reduce((s, x) => s + x[k], 0)]));
  res.json({ range: q.range, mode: q.mode === 'me' || !m ? 'me' : 'team', since, rows, totals, team: m ? m.team.name : null });
}));

r.get('/board', ah(async (req, res) => {
  const m = await requireMembership(req);
  if (!m.team.leaderboardEnabled && !isLead(m)) throw forbidden('The team board is turned off for this team');
  const since = new Date(Date.now() - 7 * DAY);
  const members = await prisma.teamMember.findMany({ where: { teamId: m.teamId }, include: { user: { select: { name: true } } }, orderBy: { joinedAt: 'asc' } });
  const metrics = await memberMetrics(members.map((x) => x.userId), since);
  const rows = members.map((x) => ({ userId: x.userId, name: x.user.name, role: x.role, ...metrics[x.userId] }));
  const totals = Object.fromEntries(METRICS.map((k) => [k, rows.reduce((s, x) => s + x[k], 0)]));
  res.json({ team: m.team.name, since, rows, totals });
}));

export default r;
