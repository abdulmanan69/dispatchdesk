// Find leads -> add to sequence -> Start (dialer session) -> call -> email -> skip text.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

const mail = vi.hoisted(() => ({
  verify: vi.fn(async () => true),
  sendMail: vi.fn(async (m) => ({ messageId: `<${Math.random().toString(36).slice(2)}@test>`, accepted: [m.to], rejected: [] })),
}));
vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => ({ verify: mail.verify, sendMail: mail.sendMail, close: () => {} }));
  return { default: { createTransport }, createTransport };
});

const { registerUser, prisma } = await import('./helpers.js');
const { setFmcsaFetch } = await import('../src/services/brokers/fmcsa.js');
const { licensingFake } = await import('./licensingFake.js');

const CENSUS_ROW = {
  dot_number: '3456789', legal_name: 'RIVERBEND FREIGHT LLC', phone: '6145550199', email_address: 'ops@riverbend.test',
  phy_city: 'COLUMBUS', phy_state: 'OH', phy_zip: '43004', power_units: '3', status_code: 'A', add_date: '20260101',
  carrier_operation: 'A', docket1prefix: 'MC', docket1: '777111',
};

describe('find leads to dialer workflow', () => {
  let A; let B; let seq; let carrierId; let enrollmentId;
  beforeAll(async () => {
    A = await registerUser({ name: 'Dana Ruiz' });
    B = await registerUser();
    setFmcsaFetch(licensingFake().fetch); // saving re-checks operating authority with FMCSA licensing
  });
  afterAll(() => setFmcsaFetch(null));
  afterEach(() => vi.unstubAllGlobals());

  it('text steps need a message', async () => {
    const bad = await A.agent.post('/api/sequences').send({ name: 'Bad', steps: [{ dayOffset: 0, type: 'text' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/text steps need a message/);
  });

  it('creates a call, email, text sequence', async () => {
    const res = await A.agent.post('/api/sequences').send({
      name: 'New authority outreach', respectBusinessHours: false,
      steps: [
        { dayOffset: 0, type: 'call', instructions: 'Intro call' },
        { dayOffset: 0, type: 'email', subject: 'Dispatch for {{company}}', body: 'Hi {{first_name}}, this is {{sender_name}}.' },
        { dayOffset: 1, type: 'text', body: 'Hi, {{sender_name}} here about dispatch for {{company}}.' },
      ],
    });
    expect(res.status).toBe(201);
    seq = res.body.sequence;
    expect(seq.steps.map((s) => s.type)).toEqual(['call', 'email', 'text']);
  });

  it('saves FMCSA results and enrolls them in one step', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [CENSUS_ROW] })));
    const res = await A.agent.post('/api/discovery/save').send({ dotNumbers: ['3456789'], sequenceId: seq.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, enrolled: 1, sequence: { id: seq.id } });
    carrierId = res.body.ids[0];
    const bad = await B.agent.post('/api/discovery/save').send({ dotNumbers: ['3456789'], sequenceId: seq.id });
    expect(bad.status).toBe(400);
  });

  it('session lists the due call step with the carrier and calling window', async () => {
    const res = await A.agent.get(`/api/sequences/${seq.id}/session`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.carrier.id).toBe(carrierId);
    expect(item.step).toMatchObject({ number: 1, type: 'call' });
    expect(item.callWindow).toBeDefined();
    enrollmentId = item.enrollmentId;
    expect((await B.agent.get(`/api/sequences/${seq.id}/session`)).status).toBe(404);
    expect((await B.agent.get(`/api/sequences/enrollments/${enrollmentId}`)).status).toBe(404);
  });

  it('logging the call advances to the email step with merge fields filled', async () => {
    const call = await A.agent.post('/api/calls').send({ carrierId, outcome: 'voicemail', autoFollowUp: false });
    expect(call.status).toBe(201);
    const res = await A.agent.get(`/api/sequences/enrollments/${enrollmentId}`);
    expect(res.body.item.step).toMatchObject({ number: 2, type: 'email' });
    expect(res.body.item.email.subject).toBe('Dispatch for RIVERBEND FREIGHT LLC');
    expect(res.body.item.email.body).toContain('this is Dana Ruiz');
  });

  it('sending the email step needs a mailbox', async () => {
    const res = await A.agent.post(`/api/sequences/enrollments/${enrollmentId}/send-email`).send({ subject: 'Hi', body: 'Hello', stepIndex: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Connect a mailbox/);
    const still = await A.agent.get(`/api/sequences/enrollments/${enrollmentId}`);
    expect(still.body.item.step.number).toBe(2);
  });

  it('sends the email step through the mailbox and advances to the text step', async () => {
    const acc = await A.agent.post('/api/email/accounts/smtp').send({ provider: 'hostinger', fromEmail: 'dana@mydispatch.test', fromName: 'Dana', password: 'mailbox-secret', dailyLimit: 50, cooldownSeconds: 0 });
    expect(acc.status).toBe(201);
    const stale = await A.agent.post(`/api/sequences/enrollments/${enrollmentId}/send-email`).send({ subject: 'Hi', body: 'Hello', stepIndex: 0 });
    expect(stale.status).toBe(409);
    const res = await A.agent.post(`/api/sequences/enrollments/${enrollmentId}/send-email`).send({ subject: 'Dispatch for Riverbend', body: 'Hi there', stepIndex: 1 });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('sent');
    expect(mail.sendMail).toHaveBeenCalled();
    expect(res.body.item.step).toMatchObject({ number: 3, type: 'text' });
    expect(res.body.item.text.body).toBe('Hi, Dana Ruiz here about dispatch for RIVERBEND FREIGHT LLC.');
    const email = await prisma.email.findFirst({ where: { enrollmentId, status: 'sent' } });
    expect(email.toEmail).toBe('ops@riverbend.test');
  });

  it('text steps appear in the call queue and skipping completes the enrollment', async () => {
    await prisma.sequenceEnrollment.update({ where: { id: enrollmentId }, data: { nextStepAt: new Date() } });
    const q = await A.agent.get('/api/prospecting/queue');
    expect(q.body.items.find((i) => i.sequence?.enrollmentId === enrollmentId).sequence.type).toBe('text');
    const skip = await A.agent.post(`/api/sequences/enrollments/${enrollmentId}/skip-step`);
    expect(skip.body.enrollment.status).toBe('completed');
    const session = await A.agent.get(`/api/sequences/${seq.id}/session?includeUpcoming=true`);
    expect(session.body.items).toHaveLength(0);
  });
});
