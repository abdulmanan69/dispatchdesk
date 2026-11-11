import { describe, it, expect, vi } from 'vitest';

vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => ({ verify: async () => true, sendMail: async (m) => ({ messageId: '<t@test>', accepted: [m.to], rejected: [] }), close: () => {} }));
  return { default: { createTransport }, createTransport };
});

const { registerUser, prisma } = await import('./helpers.js');

let n = 0;
async function makeCarrier(ownerId, data = {}) {
  const stage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
  n += 1;
  return prisma.carrier.create({ data: { ownerId, stageId: stage.id, companyName: `Mail Carrier ${n}`, state: 'TX', email: `mc${n}.${Date.now()}@carrier.test`, ...data } });
}

async function connect(a) {
  const res = await a.post('/api/email/accounts/smtp').send({ provider: 'hostinger', fromEmail: `me${Date.now()}${n}@dispatch.test`, password: 'pw', cooldownSeconds: 0 });
  expect(res.status).toBe(201);
  return res.body.account;
}

describe('email templates', () => {
  it('accepts the driver category and keeps the category on partial edits', async () => {
    const A = await registerUser();
    const created = await A.agent.post('/api/email/templates').send({ name: 'Check call', subject: 'Where are you, {{first_name}}?', body: 'Send your location.', category: 'driver' });
    expect(created.status).toBe(201);
    expect(created.body.template).toMatchObject({ category: 'driver', useCount: 0 });

    const renamed = await A.agent.patch(`/api/email/templates/${created.body.template.id}`).send({ name: 'Check call (morning)' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.template).toMatchObject({ name: 'Check call (morning)', category: 'driver', subject: 'Where are you, {{first_name}}?' });

    expect((await A.agent.post('/api/email/templates').send({ name: 'x', subject: 's', body: 'b', category: 'dispatch' })).status).toBe(400);
    expect((await A.agent.patch(`/api/email/templates/${created.body.template.id}`).send({ category: 'dispatch' })).status).toBe(400);
    const list = await A.agent.get('/api/email/templates').query({ category: 'driver' });
    expect(list.body.items.map((t) => t.id)).toEqual([created.body.template.id]);

    const B = await registerUser();
    expect((await B.agent.patch(`/api/email/templates/${created.body.template.id}`).send({ name: 'Stolen' })).status).toBe(404);
  });
});

describe('bulk email', () => {
  it('checks every recipient in one pass, skips blocked ones and counts one template use per send', async () => {
    const A = await registerUser();
    const B = await registerUser();
    await connect(A.agent);
    const t = (await A.agent.post('/api/email/templates').send({ name: 'Intro', subject: 'Trucks for {{company}}', body: 'Hi {{first_name}}', category: 'carrier' })).body.template;
    const ok = await makeCarrier(A.user.id);
    const noEmail = await makeCarrier(A.user.id, { email: null });
    const optedOut = await makeCarrier(A.user.id, { doNotEmail: true });
    const suppressed = await makeCarrier(A.user.id);
    await A.agent.post('/api/email/suppressions').send({ email: suppressed.email });
    const foreign = await makeCarrier(B.user.id);

    // A carrier the caller cannot read makes the whole request 404, and nothing is queued.
    const denied = await A.agent.post('/api/email/messages/bulk').send({ carrierIds: [ok.id, foreign.id], templateId: t.id });
    expect(denied.status).toBe(404);
    expect(await prisma.email.count({ where: { userId: A.user.id } })).toBe(0);

    const res = await A.agent.post('/api/email/messages/bulk').send({ carrierIds: [ok.id, noEmail.id, optedOut.id, suppressed.id, ok.id], templateId: t.id });
    expect(res.status).toBe(201);
    expect(res.body.queued).toBe(1);
    expect(res.body.skipped.map((s) => s.name).sort()).toEqual([noEmail.companyName, optedOut.companyName, suppressed.companyName].sort());
    const queued = await prisma.email.findMany({ where: { userId: A.user.id } });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ carrierId: ok.id, templateId: t.id, status: 'scheduled', subject: `Trucks for ${ok.companyName}` });
    let row = await prisma.emailTemplate.findUnique({ where: { id: t.id } });
    expect(row.useCount).toBe(1);
    expect(row.lastUsedAt).not.toBeNull();

    // Text picked through the template picker was counted when picked: sending it does not count again.
    const picked = await A.agent.post('/api/email/messages/bulk').send({ carrierIds: [ok.id], templateId: t.id, subject: 'Trucks for {{company}}', body: 'Hi again' });
    expect(picked.status).toBe(201);
    row = await prisma.emailTemplate.findUnique({ where: { id: t.id } });
    expect(row.useCount).toBe(1);

    // Brokers the caller cannot read are refused the same way.
    const broker = await prisma.broker.create({ data: { ownerId: B.user.id, companyName: 'Other Brokerage', email: 'ops@other.test' } });
    expect((await A.agent.post('/api/email/messages/bulk').send({ brokerIds: [broker.id], subject: 's', body: 'b' })).status).toBe(404);
  });
});
