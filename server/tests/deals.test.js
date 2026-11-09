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

  it('computes customer revenue from load history', async () => {
    const a = owner.agent;
    const carrier = await makeCarrier(owner.user.id);
    const opp = (await a.post('/api/opportunities').send({ carrierId: carrier.id })).body.opportunity;
    const cust = (await a.post(`/api/opportunities/${opp.id}/convert`).send({ dispatchFeePercent: 10 })).body.customer;
    await a.post('/api/loads').send({ carrierId: carrier.id, originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', loadedMiles: 800, rateCents: 200000 });
    await a.post('/api/loads').send({ carrierId: carrier.id, originCity: 'Atlanta', originState: 'GA', destCity: 'Dallas', destState: 'TX', loadedMiles: 800, rateCents: 160000, status: 'canceled' });
    const cd = await a.get(`/api/customers/${cust.id}`);
    expect(cd.body.loads).toHaveLength(2);
    expect(cd.body.revenue).toMatchObject({ loads: 1, grossCents: 200000, dispatchFeeCents: 20000, avgRatePerMile: 2.5 });
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
});
