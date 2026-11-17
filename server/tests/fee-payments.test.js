import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => ({ verify: async () => true, sendMail: async (m) => ({ messageId: '<fee@test>', accepted: [m?.to], rejected: [] }), close: () => {} }));
  return { default: { createTransport }, createTransport };
});

const { registerUser, prisma } = await import('./helpers.js');
const { weekOf, weeklySummaries, feeState } = await import('../src/services/invoices/statements.js');

describe('fee state', () => {
  it('classifies a week by what was collected', () => {
    expect(feeState(0, 0)).toMatchObject({ status: 'none', owedCents: 0 });
    expect(feeState(1000, 0)).toMatchObject({ status: 'unpaid', owedCents: 1000 });
    expect(feeState(1000, 400)).toMatchObject({ status: 'partial', owedCents: 600 });
    expect(feeState(1000, 1200)).toMatchObject({ status: 'paid', owedCents: 0 });
  });
});

describe('dispatch fee payments on weekly statements', () => {
  let A; let B; let customer; let carrier; let week; let loadIn;
  const url = () => `/api/customers/${customer.id}/statements`;

  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    const stage = await prisma.pipelineStage.findUnique({ where: { key: 'prospecting' } });
    carrier = await prisma.carrier.create({ data: { ownerId: A.user.id, stageId: stage.id, companyName: 'Fee Test Freight LLC', email: 'owner@feetest.test' } });
    customer = (await A.agent.post('/api/customers').send({ carrierId: carrier.id, dispatchFeePercent: 10 })).body.customer;
    week = weekOf(A.user.timezone || 'America/Chicago');
    const inWeek = new Date(week.start.getTime() + 36 * 3600000).toISOString();
    const lane = { carrierId: carrier.id, originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', loadedMiles: 1000 };
    loadIn = (await A.agent.post('/api/loads').send({ ...lane, rateCents: 250000, status: 'delivered', deliveryDate: inWeek })).body.load; // fee 25,000
    await A.agent.post('/api/loads').send({ ...lane, rateCents: 150000, status: 'delivered', deliveryDate: inWeek, dispatchFeePercent: 5 }); // fee 7,500
  });

  it('shows each week as unpaid until payments are recorded, then partial, then paid', async () => {
    const before = await A.agent.get(`${url()}?weeks=4`);
    expect(before.status).toBe(200);
    expect(before.body.items[0]).toMatchObject({ weekStart: week.key, fees: { feeCents: 32500, collectedCents: 0, owedCents: 32500, status: 'unpaid' } });
    expect(before.body.items[1].fees).toMatchObject({ status: 'none', owedCents: 0 });
    expect(before.body.owedCents).toBe(32500);

    const paid = await A.agent.post(`${url()}/${week.key}/payments`).send({ amountCents: 20000, method: 'zelle', reference: 'ZL-1', note: 'Friday' });
    expect(paid.status).toBe(201);
    expect(paid.body.fees).toMatchObject({ collectedCents: 20000, recordedCents: 20000, owedCents: 12500, status: 'partial' });
    expect(paid.body.fees.payments).toHaveLength(1);
    expect(paid.body.fees.payments[0]).toMatchObject({ amountCents: 20000, method: 'zelle', reference: 'ZL-1', note: 'Friday' });
    expect(await prisma.activity.count({ where: { carrierId: carrier.id, summary: { contains: '$200.00 dispatch fee payment' } } })).toBe(1);

    // A payment on a per-load fee invoice counts toward the same week, so the fee is not owed twice.
    const inv = (await A.agent.post('/api/invoices').send({ loadId: loadIn.id, kind: 'dispatch_fee' })).body.invoice;
    expect((await A.agent.post(`/api/invoices/${inv.id}/mark-sent`)).status).toBe(200);
    expect((await A.agent.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 12500 })).status).toBeLessThan(300);
    const detail = await A.agent.get(`${url()}/${week.key}`);
    expect(detail.body.fees).toMatchObject({ feeCents: 32500, collectedCents: 32500, invoicePaidCents: 12500, owedCents: 0, status: 'paid' });
    expect((await A.agent.get(url())).body.owedCents).toBe(0);
  });

  it('validates the payment and keeps it to the owner', async () => {
    expect((await A.agent.post(`${url()}/${week.key}/payments`).send({ amountCents: 0 })).status).toBe(400);
    expect((await A.agent.post(`${url()}/${week.key}/payments`).send({ amountCents: 100, method: 'bitcoin' })).status).toBe(400);
    const future = new Date(Date.now() + 5 * 86400000).toISOString();
    expect((await A.agent.post(`${url()}/${week.key}/payments`).send({ amountCents: 100, paidAt: future })).status).toBe(400);
    expect((await A.agent.post(`${url()}/2026-11-11/payments`).send({ amountCents: 100 })).status).toBe(400); // not a Monday
    expect((await B.agent.post(`${url()}/${week.key}/payments`).send({ amountCents: 100 })).status).toBe(404);
    expect((await B.agent.get(`${url()}/${week.key}`)).status).toBe(404);
  });

  it('removes a payment, only for its own customer', async () => {
    const p = await prisma.feePayment.findFirst({ where: { customerId: customer.id } });
    expect((await B.agent.delete(`/api/customers/${customer.id}/fee-payments/${p.id}`)).status).toBe(404);
    const stage = await prisma.pipelineStage.findUnique({ where: { key: 'prospecting' } });
    const other = await prisma.carrier.create({ data: { ownerId: A.user.id, stageId: stage.id, companyName: 'Other Freight LLC' } });
    const otherCustomer = (await A.agent.post('/api/customers').send({ carrierId: other.id })).body.customer;
    expect((await A.agent.delete(`/api/customers/${otherCustomer.id}/fee-payments/${p.id}`)).status).toBe(404);
    const gone = await A.agent.delete(`/api/customers/${customer.id}/fee-payments/${p.id}`);
    expect(gone.status).toBe(200);
    expect(gone.body.fees).toMatchObject({ recordedCents: 0, collectedCents: 12500, owedCents: 20000, status: 'partial' });
    expect(await prisma.feePayment.count({ where: { id: p.id } })).toBe(0);
  });

  it('keeps fee collection out of the carrier-facing summaries', async () => {
    const items = await weeklySummaries({ customer, carrier, tz: A.user.timezone, count: 2 });
    expect(items[0]).not.toHaveProperty('fees');
    expect(items[0]).not.toHaveProperty('loadIds');
  });
});
