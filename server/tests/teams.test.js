import { describe, it, expect } from 'vitest';
import { agent, registerUser, prisma } from './helpers.js';

describe('teams', () => {
  it('creates a team, invites by email, accepts, and enforces roles', async () => {
    const owner = await registerUser({ name: 'Owner' });
    const create = await owner.agent.post('/api/teams').send({ name: 'Fleet Co' });
    expect(create.status).toBe(201);
    const dup = await owner.agent.post('/api/teams').send({ name: 'Second' });
    expect(dup.status).toBe(409);

    const inviteEmail = `invitee${Date.now()}@example.test`;
    const inv = await owner.agent.post('/api/teams/invitations').send({ email: inviteEmail, role: 'dispatcher' });
    expect(inv.status).toBe(201);
    expect(inv.body.emailSent).toBe(false); // SMTP not configured in tests — reported honestly
    expect(inv.body.inviteLink).toContain('/invite/');
    const token = inv.body.devToken;

    // Public preview masks the email.
    const preview = await (await agent()).get(`/api/teams/invitations/${token}`);
    expect(preview.body.team).toBe('Fleet Co');
    expect(preview.body.email).not.toBe(inviteEmail);

    // Wrong account cannot accept.
    const stranger = await registerUser();
    expect((await stranger.agent.post(`/api/teams/invitations/${token}/accept`)).status).toBe(403);

    const member = await registerUser({ email: inviteEmail, name: 'Dispatcher Dan' });
    const accept = await member.agent.post(`/api/teams/invitations/${token}/accept`);
    expect(accept.status).toBe(200);
    expect((await member.agent.post(`/api/teams/invitations/${token}/accept`)).status).toBe(400);

    const mine = await owner.agent.get('/api/teams/mine');
    expect(mine.body.members).toHaveLength(2);

    // Dispatcher cannot invite or change roles.
    expect((await member.agent.post('/api/teams/invitations').send({ email: 'x@example.test' })).status).toBe(403);
    expect((await member.agent.patch(`/api/teams/members/${owner.user.id}`).send({ role: 'dispatcher' })).status).toBe(403);
    // Owner role is immutable.
    expect((await owner.agent.patch(`/api/teams/members/${owner.user.id}`).send({ role: 'dispatcher' })).status).toBe(403);
    // Owner promotes member.
    const promote = await owner.agent.patch(`/api/teams/members/${member.user.id}`).send({ role: 'manager', canViewTeamData: true });
    expect(promote.body.member.role).toBe('manager');

    // Stranger without team gets 404 on team endpoints.
    expect((await stranger.agent.get('/api/teams/board')).status).toBe(404);
    expect((await stranger.agent.get('/api/teams/activity')).status).toBe(404);
  });

  it('reports leaderboard metrics from real activity and supports leave/transfer', async () => {
    const owner = await registerUser();
    await owner.agent.post('/api/teams').send({ name: 'Metrics Team' });
    const email = `m${Date.now()}@example.test`;
    const inv = await owner.agent.post('/api/teams/invitations').send({ email });
    const member = await registerUser({ email });
    await member.agent.post(`/api/teams/invitations/${inv.body.devToken}/accept`);

    const stage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
    const carrier = await prisma.carrier.create({ data: { ownerId: member.user.id, stageId: stage.id, companyName: 'Board Test Trucking' } });
    await prisma.call.createMany({ data: [
      { carrierId: carrier.id, userId: member.user.id, outcome: 'no_answer' },
      { carrierId: carrier.id, userId: member.user.id, outcome: 'interested' },
    ] });

    const lb = await owner.agent.get('/api/teams/leaderboard?range=week&mode=team');
    expect(lb.status).toBe(200);
    const row = lb.body.rows.find((x) => x.userId === member.user.id);
    expect(row).toMatchObject({ dials: 2, downloaded: 1, inTouch: 1 });
    expect(lb.body.totals.dials).toBe(2);

    const me = await member.agent.get('/api/teams/leaderboard?mode=me');
    expect(me.body.rows).toHaveLength(1);

    const board = await member.agent.get('/api/teams/board');
    expect(board.body.rows).toHaveLength(2);

    // Owner cannot leave; member can.
    expect((await owner.agent.delete('/api/teams/members/me')).status).toBe(403);
    const transfer = await owner.agent.post('/api/teams/transfer').send({ userId: member.user.id });
    expect(transfer.status).toBe(200);
    expect((await owner.agent.delete('/api/teams/members/me')).status).toBe(200);
    const after = await member.agent.get('/api/teams/mine');
    expect(after.body.me.role).toBe('owner');
    expect(after.body.members).toHaveLength(1);
  });

  it('enforces seat limits of an active Teams subscription', async () => {
    const owner = await registerUser();
    const created = await owner.agent.post('/api/teams').send({ name: 'Seat Team' });
    const plan = await prisma.plan.findUnique({ where: { key: 'teams' } });
    await prisma.subscription.create({ data: { userId: owner.user.id, teamId: created.body.team.id, planId: plan.id, status: 'active', seats: 2 } });
    const ok = await owner.agent.post('/api/teams/invitations').send({ email: `s1${Date.now()}@example.test` });
    expect(ok.status).toBe(201);
    const full = await owner.agent.post('/api/teams/invitations').send({ email: `s2${Date.now()}@example.test` });
    expect(full.status).toBe(402);
  });

  it('requires a session for team management', async () => {
    const a = await agent();
    expect((await a.get('/api/teams/mine')).status).toBe(401);
  });
});
