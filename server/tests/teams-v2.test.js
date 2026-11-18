import { describe, it, expect } from 'vitest';
import { registerUser, prisma } from './helpers.js';

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** A team with an owner and members invited with the given roles: { owner, members: { [role]: user } }. */
async function teamWith(roles) {
  const owner = await registerUser({ name: 'Owner Olivia' });
  expect((await owner.agent.post('/api/teams').send({ name: `Team ${uniq()}` })).status).toBe(201);
  const members = {};
  for (const [key, role, name] of roles) {
    const email = `${key}${uniq()}@example.test`;
    const inv = await owner.agent.post('/api/teams/invitations').send({ email, role });
    expect(inv.status).toBe(201);
    const u = await registerUser({ email, name });
    expect((await u.agent.post(`/api/teams/invitations/${inv.body.devToken}/accept`)).status).toBe(200);
    members[key] = u;
  }
  return { owner, members };
}

async function carrierFor(user, name, extra = {}) {
  const stage = await prisma.pipelineStage.findUnique({ where: { key: 'opportunity' } });
  return prisma.carrier.create({ data: { ownerId: user.user.id, stageId: stage.id, companyName: name, ...extra } });
}

describe('teams: sales and dispatch roles, work areas', () => {
  it('starts each role with its work area and lets the manager change them', async () => {
    const { owner, members: { sales, disp, mgr } } = await teamWith([
      ['sales', 'sales', 'Sales Sam'], ['disp', 'dispatcher', 'Dispatcher Dee'], ['mgr', 'manager', 'Manager Max'],
    ]);
    expect((await sales.agent.get('/api/auth/me')).body.user.team).toMatchObject({ role: 'sales', areas: ['sales'] });
    expect((await disp.agent.get('/api/auth/me')).body.user.team).toMatchObject({ role: 'dispatcher', areas: ['dispatch'] });
    expect((await mgr.agent.get('/api/auth/me')).body.user.team.areas).toEqual(['sales', 'dispatch']);

    // Each area's tools are closed to members without it; shared lists stay open.
    const loads = await sales.agent.get('/api/loads');
    expect(loads.status).toBe(403);
    expect(loads.body.code).toBe('AREA_OFF');
    expect((await disp.agent.get('/api/lead-generators')).status).toBe(403);
    expect((await disp.agent.get('/api/sequences')).status).toBe(200);
    expect((await disp.agent.post('/api/sequences').send({ name: 'Nope' })).status).toBe(403);
    expect((await disp.agent.get('/api/loads')).status).toBe(200);
    expect((await sales.agent.get('/api/carriers')).status).toBe(200);

    // The manager gives the dispatcher the sales tools; members cannot change their own or others' areas.
    expect((await disp.agent.patch(`/api/teams/members/${disp.user.id}`).send({ areas: ['sales', 'dispatch'] })).status).toBe(403);
    expect((await sales.agent.patch(`/api/teams/members/${disp.user.id}`).send({ areas: ['sales', 'dispatch'] })).status).toBe(403);
    const give = await mgr.agent.patch(`/api/teams/members/${disp.user.id}`).send({ areas: ['sales', 'dispatch'] });
    expect(give.status).toBe(200);
    expect(give.body.member.areas).toEqual(['sales', 'dispatch']);
    expect((await disp.agent.get('/api/lead-generators')).status).toBe(200);

    // Managers move people between sales and dispatch (areas follow the role) but cannot make managers.
    const move = await mgr.agent.patch(`/api/teams/members/${sales.user.id}`).send({ role: 'dispatcher' });
    expect(move.body.member).toMatchObject({ role: 'dispatcher', areas: ['dispatch'] });
    expect((await mgr.agent.patch(`/api/teams/members/${sales.user.id}`).send({ role: 'manager' })).status).toBe(403);
    expect((await owner.agent.patch(`/api/teams/members/${sales.user.id}`).send({ role: 'sales' })).body.member.areas).toEqual(['sales']);

    // Owners see all areas; the team page reports my areas.
    expect((await owner.agent.get('/api/teams/mine')).body.me).toMatchObject({ isLead: true, areas: ['sales', 'dispatch'] });
  });
});

describe('teams: signed carriers handed to dispatch', () => {
  it('queues a carrier sales signs for the manager, who assigns a dispatcher', async () => {
    const { owner, members: { sales, disp } } = await teamWith([['sales', 'sales', 'Sales Sam'], ['disp', 'dispatcher', 'Dispatcher Dee']]);
    const c = await carrierFor(sales, 'Handoff Freight LLC');
    expect((await sales.agent.post(`/api/carriers/${c.id}/stage`).send({ stage: 'customer' })).status).toBe(200);
    const after = await prisma.carrier.findUnique({ where: { id: c.id } });
    expect(after).toMatchObject({ soldById: sales.user.id, handoffStatus: 'pending', assignedToId: null });
    expect(await prisma.notification.count({ where: { userId: owner.user.id, title: 'Handoff Freight LLC needs a dispatcher' } })).toBe(1);
    expect((await owner.agent.get('/api/teams/mine')).body.me.toAssign).toBe(1);

    // Only leads see the list and assign; only members with the Dispatch area can receive.
    expect((await sales.agent.get('/api/teams/handoffs')).status).toBe(403);
    const list = await owner.agent.get('/api/teams/handoffs');
    expect(list.body.pending.map((x) => x.id)).toContain(c.id);
    expect(list.body.pending.find((x) => x.id === c.id).soldBy).toMatchObject({ id: sales.user.id, name: 'Sales Sam' });
    expect(list.body.dispatchers.map((d) => d.userId)).toContain(disp.user.id);
    expect(list.body.dispatchers.map((d) => d.userId)).not.toContain(sales.user.id);
    expect((await owner.agent.post(`/api/teams/handoffs/${c.id}/assign`).send({ userId: sales.user.id })).status).toBe(400);
    expect((await sales.agent.post(`/api/teams/handoffs/${c.id}/assign`).send({ userId: disp.user.id })).status).toBe(403);

    const assign = await owner.agent.post(`/api/teams/handoffs/${c.id}/assign`).send({ userId: disp.user.id });
    expect(assign.status).toBe(200);
    expect(assign.body.carrier).toMatchObject({ assignedToId: disp.user.id, handoffStatus: 'assigned' });
    expect(await prisma.notification.count({ where: { userId: disp.user.id, title: 'New carrier for you: Handoff Freight LLC' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: sales.user.id, title: { startsWith: 'Handoff Freight LLC is with' } } })).toBe(1);

    // The dispatcher has it in their list and can work it; the salesperson still owns and sees it.
    const mine = await disp.agent.get('/api/carriers');
    expect(mine.body.items.map((x) => x.id)).toContain(c.id);
    expect((await disp.agent.patch(`/api/carriers/${c.id}`).send({ notes: 'Dispatching from Monday' })).status).toBe(200);
    expect((await sales.agent.get(`/api/carriers/${c.id}`)).status).toBe(200);
  });

  it('gives signed carriers to dispatchers in turn, and lets a member hand one off by hand', async () => {
    const { owner, members: { sales, d1, d2 } } = await teamWith([['sales', 'sales', 'Sales Sue'], ['d1', 'dispatcher', 'Dee One'], ['d2', 'dispatcher', 'Dee Two']]);
    expect((await owner.agent.patch('/api/teams/mine').send({ handoffMode: 'round_robin' })).status).toBe(200);
    const got = [];
    for (const name of ['Turn One LLC', 'Turn Two LLC', 'Turn Three LLC']) {
      const c = await carrierFor(sales, name);
      await sales.agent.post(`/api/carriers/${c.id}/stage`).send({ stage: 'customer' });
      got.push((await prisma.carrier.findUnique({ where: { id: c.id } })).assignedToId);
    }
    const name = (id) => (id === d1.user.id ? 'd1' : id === d2.user.id ? 'd2' : id);
    expect(got.map(name)).toEqual(['d1', 'd2', 'd1']);

    // A dispatcher signing their own carrier keeps it; a manual handoff sends it on.
    await owner.agent.patch('/api/teams/mine').send({ handoffMode: 'manager' });
    const own = await carrierFor(d1, 'Own Signing LLC');
    await d1.agent.post(`/api/carriers/${own.id}/stage`).send({ stage: 'customer' });
    expect((await prisma.carrier.findUnique({ where: { id: own.id } })).handoffStatus).toBeNull();
    const manual = await d1.agent.post(`/api/teams/handoffs/${own.id}`);
    expect(manual.body).toEqual({ status: 'pending' });
    expect((await d1.agent.post(`/api/teams/handoffs/${own.id}`)).status).toBe(409);
    // Assigning it on the carrier itself also clears the wait.
    expect((await owner.agent.patch(`/api/carriers/${own.id}`).send({ assignedToId: d2.user.id })).status).toBe(200);
    expect((await prisma.carrier.findUnique({ where: { id: own.id } })).handoffStatus).toBe('assigned');
  });
});

describe('teams: work stays with the team', () => {
  it('hands the carriers a member added while in the team to the owner or a chosen member when they leave', async () => {
    const { owner, members: { sales, disp } } = await teamWith([['sales', 'sales', 'Leaving Lee'], ['disp', 'dispatcher', 'Staying Stan']]);
    const joined = (await prisma.teamMember.findUnique({ where: { userId: sales.user.id } })).joinedAt;
    const before = await carrierFor(sales, 'Before Joining LLC', { createdAt: new Date(joined.getTime() - 86_400_000) });
    const during = await carrierFor(sales, 'During Team LLC', { dotNumber: `9${Date.now() % 10_000_000}` });
    const dup = await carrierFor(sales, 'Duplicate LLC', { dotNumber: `8${Date.now() % 10_000_000}` });
    await carrierFor(disp, 'Duplicate LLC (Stan)', { dotNumber: dup.dotNumber });
    await prisma.followUp.create({ data: { carrierId: during.id, userId: sales.user.id, dueAt: new Date(Date.now() + 86_400_000), title: 'Call back' } });

    const seq = await prisma.emailSequence.create({ data: { ownerId: sales.user.id, name: 'Leaver seq' } });
    const enr = await prisma.sequenceEnrollment.create({ data: { sequenceId: seq.id, carrierId: during.id, userId: sales.user.id, nextStepAt: new Date(Date.now() + 3600_000) } });

    const removed = await owner.agent.delete(`/api/teams/members/${sales.user.id}?transferTo=${disp.user.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.kept).toEqual({ carriers: 1, skipped: 1 });
    expect((await prisma.carrier.findUnique({ where: { id: during.id } })).ownerId).toBe(disp.user.id);
    expect((await prisma.carrier.findUnique({ where: { id: before.id } })).ownerId).toBe(sales.user.id);
    expect((await prisma.carrier.findUnique({ where: { id: dup.id } })).ownerId).toBe(sales.user.id);
    expect(await prisma.notification.count({ where: { userId: disp.user.id, title: { contains: 'from Leaving Lee are yours now' } } })).toBe(1);
    // Their sequence stops: it would keep emailing the team's carrier from their mailbox.
    expect((await prisma.sequenceEnrollment.findUnique({ where: { id: enr.id } })).status).toBe('stopped');
    const fu = await prisma.followUp.findFirst({ where: { carrierId: during.id } });
    expect(fu.userId).toBe(disp.user.id); // their open follow-up moves with the carrier
  });

  it('keeps work with the person when the owner turns it off; only the owner changes it', async () => {
    const { owner, members: { sales } } = await teamWith([['sales', 'sales', 'Keeper Kim']]);
    expect((await sales.agent.patch('/api/teams/mine').send({ keepWorkOnLeave: false })).status).toBe(403);
    expect((await owner.agent.patch('/api/teams/mine').send({ keepWorkOnLeave: false })).status).toBe(200);
    const c = await carrierFor(sales, 'Mine To Keep LLC');
    const left = await sales.agent.delete('/api/teams/members/me');
    expect(left.body.kept).toEqual({ carriers: 0, skipped: 0 });
    expect((await prisma.carrier.findUnique({ where: { id: c.id } })).ownerId).toBe(sales.user.id);
  });

  it('lets every member see all team carriers when the owner turns it on', async () => {
    const { owner, members: { sales, disp } } = await teamWith([['sales', 'sales', 'Seer Sal'], ['disp', 'dispatcher', 'Seer Dan']]);
    const c = await carrierFor(sales, 'Shared View LLC');
    expect((await disp.agent.get(`/api/carriers/${c.id}`)).status).toBe(404);
    expect((await owner.agent.patch('/api/teams/mine').send({ membersSeeAll: true })).status).toBe(200);
    expect((await disp.agent.get(`/api/carriers/${c.id}`)).status).toBe(200);
    const team = await disp.agent.get('/api/carriers?scope=team');
    expect(team.body.items.map((x) => x.id)).toContain(c.id);
  });
});

describe('teams: manager overview', () => {
  it('shows each member\'s sales and dispatch numbers to leads only', async () => {
    const { owner, members: { sales, disp } } = await teamWith([['sales', 'sales', 'Numbers Nia'], ['disp', 'dispatcher', 'Numbers Ned']]);
    const c = await carrierFor(sales, 'Overview Freight LLC');
    await sales.agent.post(`/api/carriers/${c.id}/stage`).send({ stage: 'customer' });
    await owner.agent.post(`/api/teams/handoffs/${c.id}/assign`).send({ userId: disp.user.id });
    expect((await sales.agent.get('/api/teams/overview')).status).toBe(403);
    const o = await owner.agent.get('/api/teams/overview?range=month');
    expect(o.status).toBe(200);
    const row = (id) => o.body.rows.find((r) => r.userId === id);
    expect(row(sales.user.id).sales.signed).toBe(1);
    expect(row(disp.user.id).dispatch.carriers).toBe(1);
    expect(o.body.totals.signed).toBe(1);
    expect(o.body.toAssign).toBe(0);
  });
});
