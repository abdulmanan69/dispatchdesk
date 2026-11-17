import { describe, it, expect, vi } from 'vitest';

vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => ({ verify: async () => true, sendMail: async (m) => ({ messageId: '<t@test>', accepted: [m.to], rejected: [] }), close: () => {} }));
  return { default: { createTransport }, createTransport };
});

const { registerUser, prisma } = await import('./helpers.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { deliverEmail, pickOutreachAccount, GMAIL_ONE_TO_ONE } = await import('../src/services/email/index.js');

let n = 0;
async function makeCarrier(ownerId) {
  const stage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
  n += 1;
  return prisma.carrier.create({ data: { ownerId, stageId: stage.id, companyName: `Gmail Rule Carrier ${n}`, state: 'TX', email: `gr${n}.${Date.now()}@carrier.test` } });
}
const gmail = (userId) => prisma.emailAccount.create({
  data: { userId, provider: 'gmail', label: 'G', fromEmail: `g${Date.now()}${n}@gmail.test`, status: 'connected', secretEnc: encrypt('refresh'), accessTokenEnc: encrypt('access'), tokenExpiresAt: new Date(Date.now() + 3600000), isDefault: true, cooldownSeconds: 0 },
});
async function smtp(agent) {
  const res = await agent.post('/api/email/accounts/smtp').send({ provider: 'hostinger', fromEmail: `me${Date.now()}${n}@dispatch.test`, password: 'pw', cooldownSeconds: 0 });
  expect(res.status).toBe(201);
  return res.body.account;
}

describe('Gmail sends one-to-one email only', () => {
  it('refuses bulk email through Gmail and uses the SMTP mailbox when there is one', async () => {
    const A = await registerUser();
    const g = await gmail(A.user.id);
    const c = await makeCarrier(A.user.id);
    const onlyGmail = await A.agent.post('/api/email/messages/bulk').send({ carrierIds: [c.id], subject: 'Trucks', body: 'Hi' });
    expect(onlyGmail.status).toBe(400);
    expect(onlyGmail.body.error).toBe(GMAIL_ONE_TO_ONE);
    expect(await prisma.email.count({ where: { userId: A.user.id } })).toBe(0);

    const s = await smtp(A.agent);
    expect((await A.agent.post('/api/email/messages/bulk').send({ carrierIds: [c.id], subject: 'Trucks', body: 'Hi', accountId: g.id })).status).toBe(400);
    const queued = await A.agent.post('/api/email/messages/bulk').send({ carrierIds: [c.id], subject: 'Trucks', body: 'Hi' });
    expect(queued.status).toBe(201);
    const row = await prisma.email.findFirst({ where: { userId: A.user.id } });
    expect(row.emailAccountId).toBe(s.id); // Gmail is the default mailbox, but bulk email goes through SMTP
    expect((await pickOutreachAccount(A.user.id))?.id).toBe(s.id);
  });

  it('never sends a sequence step through Gmail but still sends one-to-one email', async () => {
    const A = await registerUser();
    const g = await gmail(A.user.id);
    const c = await makeCarrier(A.user.id);
    const seq = await prisma.emailSequence.create({ data: { ownerId: A.user.id, name: 'Intro', steps: { create: [{ order: 0, type: 'email', dayOffset: 0, subject: 'Hi', body: 'Hello' }] } } });
    const enr = await prisma.sequenceEnrollment.create({ data: { sequenceId: seq.id, carrierId: c.id, userId: A.user.id, status: 'active', currentStep: 0, nextStepAt: new Date() } });
    const step = await prisma.email.create({ data: { userId: A.user.id, carrierId: c.id, enrollmentId: enr.id, emailAccountId: g.id, toEmail: c.email, subject: 'Hi', body: 'Hello', status: 'scheduled', scheduledAt: new Date() } });
    const r = await deliverEmail(step.id, { retry: false });
    expect(r.outcome).toBe('failed');
    expect(r.message).toBe(GMAIL_ONE_TO_ONE);

    // With an SMTP mailbox connected the same step goes out through it.
    const s = await smtp(A.agent);
    const again = await prisma.email.create({ data: { userId: A.user.id, carrierId: c.id, enrollmentId: enr.id, emailAccountId: g.id, toEmail: c.email, subject: 'Hi', body: 'Hello', status: 'scheduled', scheduledAt: new Date() } });
    const sent = await deliverEmail(again.id, { retry: false });
    expect(sent.outcome).toBe('sent');
    expect(sent.email.emailAccountId).toBe(s.id);

    // A one-to-one email the user writes still goes through Gmail.
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => { calls.push({ url, opts }); return { status: 200, json: async () => ({ id: 'gm1' }) }; }));
    try {
      const single = await A.agent.post('/api/email/messages').send({ toEmail: 'broker@x.test', subject: 'Load 123', body: 'Rate con attached', accountId: g.id, mode: 'send' });
      expect(single.status).toBe(201);
      expect(single.body.outcome).toBe('sent');
      expect(calls.some((x) => String(x.url).includes('gmail.googleapis.com'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
