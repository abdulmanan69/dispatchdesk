import { describe, it, expect, beforeAll } from 'vitest';
import { registerUser, prisma } from './helpers.js';

async function makeCarrier(userId, overrides = {}) {
  const stage = await prisma.pipelineStage.findUnique({ where: { key: overrides.stage || 'prospecting' } });
  return prisma.carrier.create({
    data: { ownerId: userId, stageId: stage.id, companyName: overrides.companyName || `Carrier ${Math.random().toString(36).slice(2, 8)}`, state: 'TX', phone: '2145550100', email: 'dispatch@carrier.test' },
  });
}
const stageOf = async (carrierId) => (await prisma.carrier.findUnique({ where: { id: carrierId }, include: { stage: true } })).stage.key;

describe('opportunities and customers', () => {
  let owner;
  let other;
  beforeAll(async () => {
    owner = await registerUser();
    other = await registerUser();
  });

  it('opens an opportunity from a carrier and moves it through the pipeline to customer', async () => {
    const a = owner.agent;
    const carrier = await makeCarrier(owner.user.id, { companyName: 'Lone Star Freight' });

    const created = await a.post('/api/opportunities').send({ carrierId: carrier.id, estimatedValueCents: 150000, dispatchFeePercent: 8, probability: 40 });
    expect(created.status).toBe(201);
    const opp = created.body.opportunity;
    expect(opp.status).toBe('open');
    expect(opp.estimatedValueCents).toBe(150000);
    expect(await stageOf(carrier.id)).toBe('opportunity');

    const dup = await a.post('/api/opportunities').send({ carrierId: carrier.id });
    expect(dup.status).toBe(400);

    const list = await a.get('/api/opportunities?status=active');
    expect(list.body.items.some((o) => o.id === opp.id)).toBe(true);
    expect(list.body.summary.openValueCents).toBeGreaterThanOrEqual(150000);
    expect(list.body.summary.weightedValueCents).toBeGreaterThanOrEqual(60000);

    const search = await a.get('/api/opportunities?q=Lone%20Star');
    expect(search.body.items.map((o) => o.id)).toContain(opp.id);

    const neg = await a.patch(`/api/opportunities/${opp.id}`).send({ status: 'negotiating', notes: 'Wants 7%' });
    expect(neg.body.opportunity.status).toBe('negotiating');

    const trial = await a.patch(`/api/opportunities/${opp.id}`).send({ status: 'trial' });
    expect(trial.body.opportunity.status).toBe('trial');
    expect(await stageOf(carrier.id)).toBe('trial');

    const detail = await a.get(`/api/opportunities/${opp.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.opportunity.carrier.companyName).toBe('Lone Star Freight');
    expect(detail.body.activities.length).toBeGreaterThan(0);

    const conv = await a.post(`/api/opportunities/${opp.id}/convert`).send({ dispatchFeePercent: 7 });
    expect(conv.status).toBe(200);
    expect(conv.body.customer.dispatchFeePercent).toBe(7);
    expect(await stageOf(carrier.id)).toBe('customer');
    const after = await prisma.opportunity.findUnique({ where: { id: opp.id } });
    expect(after.status).toBe('won');

    const customers = await a.get('/api/customers');
    const cust = customers.body.items.find((c) => c.carrierId === carrier.id);
    expect(cust).toBeTruthy();
    expect(cust.compliance.missing).toBe(4);

    const cd = await a.get(`/api/customers/${cust.id}`);
    expect(cd.body.checklist.map((c) => c.status)).toEqual(['missing', 'missing', 'missing', 'missing']);
    expect(cd.body.revenue.loads).toBe(0);

    const patched = await a.patch(`/api/customers/${cust.id}`).send({ minRatePerMile: 2.5, maxDeadheadMiles: 75, homeBase: 'Dallas, TX', status: 'paused' });
    expect(patched.body.customer).toMatchObject({ minRatePerMile: 2.5, maxDeadheadMiles: 75, homeBase: 'Dallas, TX', status: 'paused', dispatchFeePercent: 7 });

    const lane = await a.post(`/api/customers/${cust.id}/lanes`).send({ origin: 'Dallas, TX', destination: 'Atlanta, GA' });
    expect(lane.status).toBe(201);
    const lanePatch = await a.patch(`/api/customers/${cust.id}/lanes/${lane.body.lane.id}`).send({ notes: 'Weekly' });
    expect(lanePatch.body.lane.notes).toBe('Weekly');
    expect((await a.get(`/api/customers/${cust.id}`)).body.customer.lanes).toHaveLength(1);
    expect((await a.delete(`/api/customers/${cust.id}/lanes/${lane.body.lane.id}`)).status).toBe(200);
  });

  it('counts fees as earned only for delivered, invoiced and paid loads (planned quotes never count)', async () => {
    const a = owner.agent;
    const carrier = await makeCarrier(owner.user.id);
    const opp = (await a.post('/api/opportunities').send({ carrierId: carrier.id })).body.opportunity;
    const cust = (await a.post(`/api/opportunities/${opp.id}/convert`).send({ dispatchFeePercent: 10 })).body.customer;
    expect((await prisma.carrier.findUnique({ where: { id: carrier.id } })).isFleet).toBe(true);
    const lane = { carrierId: carrier.id, originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', loadedMiles: 800 };
    await a.post('/api/loads').send({ ...lane, rateCents: 200000, status: 'delivered', detentionHours: 2, detentionRateCents: 5000 });
    await a.post('/api/loads').send({ ...lane, rateCents: 180000, status: 'paid', dispatchFeePercent: 5 });
    await a.post('/api/loads').send({ ...lane, rateCents: 150000, status: 'booked' });
    await a.post('/api/loads').send({ ...lane, rateCents: 900000 }); // planned quote
    await a.post('/api/loads').send({ ...lane, rateCents: 160000, status: 'canceled' });
    const cd = await a.get(`/api/customers/${cust.id}`);
    expect(cd.body.loads).toHaveLength(5);
    // 2,000 + 100 detention at 10% = 210; 1,800 at the load's own 5% = 90.
    expect(cd.body.revenue).toMatchObject({ loads: 2, grossCents: 390000, dispatchFeeCents: 30000, avgRatePerMile: 2.38, booked: { loads: 1, dispatchFeeCents: 15000 } });
    const list = await a.get('/api/customers');
    const row = list.body.items.find((c) => c.id === cust.id);
    expect(row.revenue).toMatchObject({ loads: 2, dispatchFeeCents: 30000 });
    expect(row.portalTokenHash).toBeUndefined();
  });

  it("turns an opportunity's next follow-up into a real follow-up and cancels it when the deal closes", async () => {
    const a = owner.agent;
    const carrier = await makeCarrier(owner.user.id, { companyName: 'Follow Up Freight' });
    const due = new Date(Date.now() + 2 * 86400000);
    const opp = (await a.post('/api/opportunities').send({ carrierId: carrier.id, nextFollowUpAt: due.toISOString() })).body.opportunity;
    let pending = await prisma.followUp.findMany({ where: { carrierId: carrier.id, status: 'pending' } });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ title: 'Opportunity follow-up', type: 'call', userId: owner.user.id });
    expect(pending[0].dueAt.toISOString()).toBe(due.toISOString());
    expect((await prisma.carrier.findUnique({ where: { id: carrier.id } })).nextFollowUpAt.toISOString()).toBe(due.toISOString());

    const later = new Date(Date.now() + 5 * 86400000);
    await a.patch(`/api/opportunities/${opp.id}`).send({ nextFollowUpAt: later.toISOString() });
    pending = await prisma.followUp.findMany({ where: { carrierId: carrier.id, status: 'pending' } });
    expect(pending).toHaveLength(1);
    expect(pending[0].dueAt.toISOString()).toBe(later.toISOString());
    // The list shows the carrier's earliest pending follow-up, so a completed one no longer appears.
    const row = async () => (await a.get('/api/opportunities?status=all&q=Follow%20Up%20Freight')).body.items.find((o) => o.id === opp.id);
    expect(new Date((await row()).nextFollowUpAt).toISOString()).toBe(later.toISOString());
    await prisma.followUp.update({ where: { id: pending[0].id }, data: { status: 'done' } });
    expect((await row()).nextFollowUpAt).toBeNull();
    await a.patch(`/api/opportunities/${opp.id}`).send({ nextFollowUpAt: later.toISOString() });

    await a.patch(`/api/opportunities/${opp.id}`).send({ status: 'lost', lostReason: 'Went quiet' });
    expect(await prisma.followUp.count({ where: { carrierId: carrier.id, status: 'pending' } })).toBe(0);
    expect((await prisma.carrier.findUnique({ where: { id: carrier.id } })).nextFollowUpAt).toBeNull();
  });

  it('adds a carrier as a customer directly and refuses other tenants', async () => {
    const carrier = await makeCarrier(owner.user.id);
    expect((await other.agent.post('/api/customers').send({ carrierId: carrier.id })).status).toBe(404);
    const res = await owner.agent.post('/api/customers').send({ carrierId: carrier.id, dispatchFeePercent: 6 });
    expect(res.status).toBe(201);
    expect(res.body.customer).toMatchObject({ carrierId: carrier.id, dispatchFeePercent: 6, status: 'active' });
    expect(await stageOf(carrier.id)).toBe('customer');
    expect((await prisma.carrier.findUnique({ where: { id: carrier.id } })).isFleet).toBe(true);
  });

  it('marks an opportunity lost and archives the carrier when asked', async () => {
    const carrier = await makeCarrier(owner.user.id);
    const opp = (await owner.agent.post('/api/opportunities').send({ carrierId: carrier.id })).body.opportunity;
    const lost = await owner.agent.patch(`/api/opportunities/${opp.id}`).send({ status: 'lost', lostReason: 'Went with another dispatcher', archive: true });
    expect(lost.body.opportunity).toMatchObject({ status: 'lost', lostReason: 'Went with another dispatcher', probability: 0 });
    expect(lost.body.opportunity.closedAt).toBeTruthy();
    expect(await stageOf(carrier.id)).toBe('archived');
  });

  it('removing an opportunity returns the carrier to prospecting', async () => {
    const carrier = await makeCarrier(owner.user.id);
    const opp = (await owner.agent.post('/api/opportunities').send({ carrierId: carrier.id })).body.opportunity;
    expect((await owner.agent.delete(`/api/opportunities/${opp.id}`)).status).toBe(200);
    expect(await stageOf(carrier.id)).toBe('prospecting');
  });

  it("isolates tenants: another user cannot see or change someone else's deals", async () => {
    const carrier = await makeCarrier(owner.user.id);
    const opp = (await owner.agent.post('/api/opportunities').send({ carrierId: carrier.id })).body.opportunity;
    const b = other.agent;
    expect((await b.get(`/api/opportunities/${opp.id}`)).status).toBe(404);
    expect((await b.patch(`/api/opportunities/${opp.id}`).send({ status: 'lost' })).status).toBe(404);
    expect((await b.post(`/api/opportunities/${opp.id}/convert`)).status).toBe(404);
    expect((await b.post('/api/opportunities').send({ carrierId: carrier.id })).status).toBe(404);
    expect((await b.get('/api/opportunities?status=all')).body.items.find((o) => o.id === opp.id)).toBeUndefined();
    const cust = (await owner.agent.post(`/api/opportunities/${opp.id}/convert`)).body.customer;
    expect((await b.get(`/api/customers/${cust.id}`)).status).toBe(404);
    expect((await b.patch(`/api/customers/${cust.id}`).send({ notes: 'x' })).status).toBe(404);
    expect((await b.post(`/api/customers/${cust.id}/lanes`).send({ origin: 'A', destination: 'B' })).status).toBe(404);
    expect((await b.get('/api/customers')).body.items.find((c) => c.id === cust.id)).toBeUndefined();
  });

  it('lets a team owner read a member’s customers with scope=team, but not other teams', async () => {
    const lead = await registerUser();
    const member = await registerUser();
    const team = await prisma.team.create({ data: { name: 'Fleet Co', ownerId: lead.user.id } });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: lead.user.id, role: 'owner' } });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: member.user.id, role: 'dispatcher' } });
    const carrier = await makeCarrier(member.user.id);
    const opp = (await member.agent.post('/api/opportunities').send({ carrierId: carrier.id })).body.opportunity;
    // Sessions cache team membership per request, so a fresh request picks it up.
    const teamList = await lead.agent.get('/api/opportunities?scope=team&status=all');
    expect(teamList.body.items.map((o) => o.id)).toContain(opp.id);
    const mineList = await lead.agent.get('/api/opportunities?status=all');
    expect(mineList.body.items.map((o) => o.id)).not.toContain(opp.id);
    expect((await other.agent.get('/api/opportunities?scope=team&status=all')).body.items.map((o) => o.id)).not.toContain(opp.id);
  });

  it("moves or cancels a member's opportunity follow-up when the team lead changes the deal", async () => {
    const lead = await registerUser();
    const member = await registerUser();
    const team = await prisma.team.create({ data: { name: 'Lead Co', ownerId: lead.user.id } });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: lead.user.id, role: 'owner' } });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: member.user.id, role: 'dispatcher' } });
    const carrier = await makeCarrier(member.user.id, { companyName: 'Shared Deal Freight' });
    const due = new Date(Date.now() + 2 * 86400000);
    const opp = (await member.agent.post('/api/opportunities').send({ carrierId: carrier.id, nextFollowUpAt: due.toISOString() })).body.opportunity;
    const later = new Date(Date.now() + 4 * 86400000);
    expect((await lead.agent.patch(`/api/opportunities/${opp.id}`).send({ nextFollowUpAt: later.toISOString() })).status).toBe(200);
    let pending = await prisma.followUp.findMany({ where: { carrierId: carrier.id, status: 'pending' } });
    // Still one reminder, still the member's, at the new time.
    expect(pending).toHaveLength(1);
    expect(pending[0].userId).toBe(member.user.id);
    expect(pending[0].dueAt.toISOString()).toBe(later.toISOString());
    expect((await lead.agent.patch(`/api/opportunities/${opp.id}`).send({ status: 'lost', lostReason: 'Signed elsewhere' })).status).toBe(200);
    pending = await prisma.followUp.findMany({ where: { carrierId: carrier.id, status: 'pending' } });
    expect(pending).toHaveLength(0);
  });
});

describe('opportunities: follow-up time zone', () => {
  it("returns the carrier's stored time zone and state so the follow-up is typed in the carrier's local time", async () => {
    const { agent, user } = await registerUser();
    const carrier = await makeCarrier(user.id, { companyName: 'Desert Mile Freight' });
    await prisma.carrier.update({ where: { id: carrier.id }, data: { state: 'AZ', timezone: 'America/Phoenix' } });
    const opp = (await agent.post('/api/opportunities').send({ carrierId: carrier.id })).body.opportunity;
    const detail = await agent.get(`/api/opportunities/${opp.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.opportunity.carrier).toMatchObject({ state: 'AZ', timezone: 'America/Phoenix' });
    const list = await agent.get('/api/opportunities?status=all');
    expect(list.body.items.find((o) => o.id === opp.id).carrier.timezone).toBe('America/Phoenix');
  });
});
