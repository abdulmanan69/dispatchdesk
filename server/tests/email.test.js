import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mail = vi.hoisted(() => ({
  verify: vi.fn(async () => true),
  sendMail: vi.fn(async (m) => ({ messageId: `<${Math.random().toString(36).slice(2)}@test>`, accepted: [m.to], rejected: [] })),
}));
vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => ({ verify: mail.verify, sendMail: mail.sendMail, close: () => {} }));
  return { default: { createTransport }, createTransport };
});

const { agent, registerUser, prisma } = await import('./helpers.js');
const { runSchedulerTick } = await import('../src/jobs/scheduler.js');
const { setSetting } = await import('../src/lib/settings.js');
const { enrollCarriers } = await import('../src/services/sequenceEngine.js');

async function makeCarrier(ownerId, data = {}) {
  const stage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
  return prisma.carrier.create({ data: { ownerId, stageId: stage.id, companyName: 'Blue Line Trucking LLC', email: 'owner@blueline.test', mcNumber: '123456', state: 'TX', ...data } });
}

async function connectSmtp(a, extra = {}) {
  const res = await a.post('/api/email/accounts/smtp').send({
    provider: 'hostinger', fromEmail: 'me@mydispatch.test', fromName: 'Me', password: 'mailbox-secret-pass', dailyLimit: 50, cooldownSeconds: 0, ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.account;
}

beforeEach(() => {
  mail.verify.mockReset().mockResolvedValue(true);
  mail.sendMail.mockReset().mockImplementation(async (m) => ({ messageId: '<id@test>', accepted: [m.to], rejected: [] }));
});
afterEach(() => vi.unstubAllGlobals());

describe('mailboxes', () => {
  it('verifies SMTP before saving and stores the password encrypted', async () => {
    const { agent: a, user } = await registerUser();
    const acc = await connectSmtp(a);
    expect(acc).toMatchObject({ provider: 'hostinger', smtpHost: 'smtp.hostinger.com', smtpPort: 465, smtpSecure: true, status: 'connected', isDefault: true });
    expect(acc).not.toHaveProperty('secretEnc');
    const row = await prisma.emailAccount.findFirst({ where: { userId: user.id } });
    expect(row.secretEnc).toMatch(/^v1\./);
    expect(row.secretEnc).not.toContain('mailbox-secret-pass');
    const list = await a.get('/api/email/accounts');
    expect(JSON.stringify(list.body)).not.toContain('mailbox-secret-pass');
  });

  it('rejects mailboxes that fail verification', async () => {
    const { agent: a } = await registerUser();
    mail.verify.mockRejectedValueOnce(new Error('535 Authentication failed'));
    const res = await a.post('/api/email/accounts/smtp').send({ provider: 'smtp', host: 'smtp.example.test', port: 587, fromEmail: 'x@example.test', password: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/535/);
  });

  it('disconnect wipes credentials, second delete removes', async () => {
    const { agent: a } = await registerUser();
    const acc = await connectSmtp(a);
    await a.delete(`/api/email/accounts/${acc.id}`).expect(200);
    const row = await prisma.emailAccount.findUnique({ where: { id: acc.id } });
    expect(row.status).toBe('disconnected');
    expect(row.secretEnc).toBeNull();
    await a.delete(`/api/email/accounts/${acc.id}`).expect(200);
    expect(await prisma.emailAccount.findUnique({ where: { id: acc.id } })).toBeNull();
  });

  it('OAuth start reports missing configuration honestly, then builds a URL once configured', async () => {
    const { agent: a } = await registerUser();
    const res = await a.get('/api/email/oauth/gmail/start');
    expect(res.status).toBe(503);
    expect(res.body.details.missing).toEqual(['google.clientId', 'google.clientSecret']);
    await setSetting('google.clientId', 'test-client-id');
    await setSetting('google.clientSecret', 'test-client-secret');
    const ok = await a.get('/api/email/oauth/gmail/start');
    expect(ok.status).toBe(200);
    expect(ok.body.url).toContain('client_id=test-client-id');
    expect(ok.body.url).toContain('gmail.send');
    await setSetting('google.clientId', '');
    await setSetting('google.clientSecret', '');
  });

  it('OAuth callback rejects a forged state', async () => {
    const { agent: a } = await registerUser();
    const res = await a.get('/api/email/oauth/gmail/callback?code=abc&state=forged.state');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/error=/);
  });
});

describe('connect mailbox options', () => {
  it('lists OAuth availability and SMTP presets with how-to steps', async () => {
    const { agent: a } = await registerUser();
    const res = await a.get('/api/email/connect-options');
    expect(res.status).toBe(200);
    expect(res.body.oauth.map((o) => [o.key, o.available, o.fallback])).toEqual([['gmail', false, 'gmail_smtp'], ['outlook', false, 'outlook_smtp']]);
    const yahoo = res.body.smtp.find((p) => p.key === 'yahoo');
    expect(yahoo).toMatchObject({ host: 'smtp.mail.yahoo.com', port: 465, secure: true });
    expect(yahoo.steps.length).toBeGreaterThan(0);
  });

  it('verifies SMTP settings without saving, using preset servers', async () => {
    const { agent: a, user } = await registerUser();
    const res = await a.post('/api/email/accounts/smtp/verify').send({ provider: 'icloud', fromEmail: 'me@icloud.test', password: 'app-pass' });
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('smtp.mail.me.com:587');
    expect(await prisma.emailAccount.count({ where: { userId: user.id } })).toBe(0);
    mail.verify.mockRejectedValueOnce(new Error('535 Authentication failed'));
    const bad = await a.post('/api/email/accounts/smtp/verify').send({ provider: 'yahoo', fromEmail: 'me@yahoo.test', password: 'wrong' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/535/);
  });

  it('connects a preset mailbox, sends through SMTP and reconnects with a new password', async () => {
    const { agent: a } = await registerUser();
    const res = await a.post('/api/email/accounts/smtp').send({ provider: 'zoho', fromEmail: 'ops@zoho.test', password: 'first-pass', cooldownSeconds: 0 });
    expect(res.status).toBe(201);
    expect(res.body.account).toMatchObject({ provider: 'zoho', smtpHost: 'smtp.zoho.com', smtpPort: 465, label: 'Zoho Mail — ops@zoho.test' });
    const id = res.body.account.id;
    expect((await a.post(`/api/email/accounts/${id}/test`)).status).toBe(200);
    await prisma.emailAccount.update({ where: { id }, data: { status: 'error', lastError: '535 auth' } });
    mail.verify.mockRejectedValueOnce(new Error('535 Authentication failed'));
    expect((await a.post(`/api/email/accounts/${id}/credentials`).send({ password: 'wrong' })).status).toBe(400);
    const ok = await a.post(`/api/email/accounts/${id}/credentials`).send({ password: 'second-pass' });
    expect(ok.status).toBe(200);
    expect(ok.body.account.status).toBe('connected');
    const row = await prisma.emailAccount.findUnique({ where: { id } });
    expect(row.secretEnc).not.toContain('second-pass');
  });

  it('admin configuration check classifies OAuth client responses', async () => {
    const { checkOAuthClient } = await import('../src/services/email/oauth.js');
    expect((await checkOAuthClient('gmail')).ok).toBe(false);
    await setSetting('google.clientId', 'cid');
    await setSetting('google.clientSecret', 'secret');
    const good = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'Malformed auth code.' }) }));
    expect(await checkOAuthClient('gmail', good)).toMatchObject({ ok: true });
    const bad = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_client', error_description: 'The OAuth client was not found.' }) }));
    const r = await checkOAuthClient('gmail', bad);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/rejected the client/);
    await setSetting('google.clientId', '');
    await setSetting('google.clientSecret', '');
  });
});

describe('composing and sending', () => {
  it('sends through the provider, records activity and adds unsubscribe headers', async () => {
    const { agent: a, user } = await registerUser({ name: 'Dana Dispatcher' });
    await connectSmtp(a);
    const carrier = await makeCarrier(user.id);
    await prisma.carrierContact.create({ data: { carrierId: carrier.id, name: 'Mike Ross', isPrimary: true } });
    const res = await a.post('/api/email/messages').send({
      carrierId: carrier.id, subject: 'Loads for {{company}}', body: 'Hi {{first_name}}, I dispatch for MC {{mc}}. — {{sender_name}}', mode: 'send',
    });
    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe('sent');
    expect(res.body.email.status).toBe('sent');
    expect(res.body.email.subject).toBe('Loads for Blue Line Trucking LLC');
    expect(res.body.email.body).toContain('Hi Mike, I dispatch for MC 123456. — Dana Dispatcher');
    const sent = mail.sendMail.mock.calls[0][0];
    expect(sent.to).toBe('owner@blueline.test');
    expect(sent.headers['List-Unsubscribe']).toMatch(/\/api\/public\/unsubscribe\?token=/);
    expect(sent.text).toMatch(/Unsubscribe:/);
    const act = await prisma.activity.findFirst({ where: { carrierId: carrier.id, type: 'email' } });
    expect(act).toBeTruthy();
    expect((await prisma.carrier.findUnique({ where: { id: carrier.id } })).lastContactedAt).toBeTruthy();
  });

  it('never marks a failed send as sent', async () => {
    const { agent: a } = await registerUser();
    await connectSmtp(a);
    mail.sendMail.mockRejectedValueOnce(new Error('Connection timeout'));
    const res = await a.post('/api/email/messages').send({ toEmail: 'broker@example.test', subject: 'Hi', body: 'Hello', mode: 'send' });
    expect(res.body.outcome).toBe('failed');
    expect(res.body.email.status).toBe('failed');
    expect(res.body.email.sentAt).toBeNull();
    expect(res.body.email.error).toMatch(/timeout/i);
  });

  it('requires a connected mailbox to send', async () => {
    const { agent: a } = await registerUser();
    const res = await a.post('/api/email/messages').send({ toEmail: 'x@example.test', subject: 'Hi', body: 'Hello', mode: 'send' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Connect a mailbox/);
  });

  it('drafts can be edited, sent; scheduled can be canceled', async () => {
    const { agent: a } = await registerUser();
    await connectSmtp(a);
    const d = await a.post('/api/email/messages').send({ toEmail: 'x@example.test', subject: 'Draft', body: 'Body', mode: 'draft' });
    expect(d.body.email.status).toBe('draft');
    const e = await a.patch(`/api/email/messages/${d.body.email.id}`).send({ subject: 'Edited' });
    expect(e.body.email.subject).toBe('Edited');
    const s = await a.post(`/api/email/messages/${d.body.email.id}/send`);
    expect(s.body.outcome).toBe('sent');
    const sch = await a.post('/api/email/messages').send({ toEmail: 'y@example.test', subject: 'Later', body: 'Body', mode: 'schedule', scheduledAt: new Date(Date.now() + 3600000).toISOString() });
    expect(sch.body.email.status).toBe('scheduled');
    const c = await a.post(`/api/email/messages/${sch.body.email.id}/cancel`);
    expect(c.body.email.status).toBe('canceled');
    await a.delete(`/api/email/messages/${sch.body.email.id}`).expect(200);
    const list = await a.get('/api/email/messages?status=sent');
    expect(list.body.items.length).toBe(1);
  });

  it('templates CRUD', async () => {
    const { agent: a } = await registerUser();
    const t = await a.post('/api/email/templates').send({ name: 'Intro', subject: 'Hello {{company}}', body: 'Hi {{first_name}}' });
    expect(t.status).toBe(201);
    await a.patch(`/api/email/templates/${t.body.template.id}`).send({ name: 'Intro v2' }).expect(200);
    expect((await a.get('/api/email/templates')).body.items[0].name).toBe('Intro v2');
    await a.delete(`/api/email/templates/${t.body.template.id}`).expect(200);
  });
});

describe('opt-out', () => {
  it('suppression list and do-not-email block sending', async () => {
    const { agent: a, user } = await registerUser();
    await connectSmtp(a);
    await a.post('/api/email/suppressions').send({ email: 'Blocked@Example.test' }).expect(201);
    const res = await a.post('/api/email/messages').send({ toEmail: 'blocked@example.test', subject: 'Hi', body: 'x', mode: 'send' });
    expect(res.status).toBe(400);
    const carrier = await makeCarrier(user.id, { email: 'dne@example.test', doNotEmail: true, mcNumber: '999' });
    const res2 = await a.post('/api/email/messages').send({ carrierId: carrier.id, subject: 'Hi', body: 'x', mode: 'send' });
    expect(res2.status).toBe(400);
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('public unsubscribe link suppresses the address for that sender only', async () => {
    const { agent: a, user } = await registerUser();
    await connectSmtp(a);
    const carrier = await makeCarrier(user.id, { email: 'unsub@example.test', mcNumber: '777' });
    await a.post('/api/email/messages').send({ carrierId: carrier.id, subject: 'Hi', body: 'x', mode: 'send' });
    const header = mail.sendMail.mock.calls[0][0].headers['List-Unsubscribe'];
    const token = decodeURIComponent(header.match(/token=([^>]+)/)[1]);
    const anon = await agent();
    const preview = await anon.get(`/api/public/unsubscribe?token=${encodeURIComponent(token)}`);
    expect(preview.body).toMatchObject({ email: 'unsub@example.test', unsubscribed: false });
    // One-click POST from a mail client carries no CSRF token.
    const post = await anon.raw.post(`/api/public/unsubscribe?token=${encodeURIComponent(token)}`);
    expect(post.status).toBe(200);
    await anon.raw.post(`/api/public/unsubscribe?token=${encodeURIComponent(token)}`).expect(200); // idempotent
    expect((await prisma.carrier.findUnique({ where: { id: carrier.id } })).doNotEmail).toBe(true);
    expect(await prisma.emailSuppression.count({ where: { ownerId: user.id, email: 'unsub@example.test' } })).toBe(1);
    const other = await registerUser();
    expect(await prisma.emailSuppression.count({ where: { ownerId: other.user.id } })).toBe(0);
    const bad = await anon.raw.post('/api/public/unsubscribe?token=tampered.token');
    expect(bad.status).toBe(400);
  });
});

describe('tenant isolation', () => {
  it('users cannot see or use each other\'s emails, mailboxes or carriers', async () => {
    const A = await registerUser();
    const B = await registerUser();
    const accA = await connectSmtp(A.agent);
    const carrierA = await makeCarrier(A.user.id, { mcNumber: '4242' });
    const msg = await A.agent.post('/api/email/messages').send({ toEmail: 'z@example.test', subject: 'Private', body: 'x', mode: 'draft' });
    expect((await B.agent.get(`/api/email/messages/${msg.body.email.id}`)).status).toBe(404);
    expect((await B.agent.get(`/api/email/messages?carrierId=${carrierA.id}`)).status).toBe(404);
    expect((await B.agent.post(`/api/email/accounts/${accA.id}/test`)).status).toBe(404);
    const useA = await B.agent.post('/api/email/messages').send({ accountId: accA.id, toEmail: 'z@example.test', subject: 'x', body: 'x', mode: 'send' });
    expect(useA.status).toBe(400);
    const comp = await B.agent.post('/api/email/messages').send({ carrierId: carrierA.id, subject: 'x', body: 'x', mode: 'draft' });
    expect(comp.status).toBe(404);
    expect((await B.agent.get('/api/email/messages')).body.items).toHaveLength(0);
  });
});

describe('scheduler', () => {
  it('sends due scheduled emails, honors cooldown, and retries then fails', async () => {
    const { agent: a, user } = await registerUser();
    const acc = await connectSmtp(a, { cooldownSeconds: 600 });
    const past = new Date(Date.now() - 60000).toISOString();
    const future = new Date(Date.now() + 5 * 60000).toISOString();
    const one = await a.post('/api/email/messages').send({ toEmail: 'a1@example.test', subject: 'One', body: 'x', mode: 'schedule', scheduledAt: future });
    const two = await a.post('/api/email/messages').send({ toEmail: 'a2@example.test', subject: 'Two', body: 'x', mode: 'schedule', scheduledAt: future });
    await prisma.email.updateMany({ where: { id: { in: [one.body.email.id, two.body.email.id] } }, data: { scheduledAt: new Date(past) } });
    await runSchedulerTick({ quiet: true });
    const rows = await prisma.email.findMany({ where: { userId: user.id }, orderBy: { subject: 'asc' } });
    const statuses = rows.map((r) => r.status).sort();
    expect(statuses).toEqual(['scheduled', 'sent']); // second deferred by cooldown
    expect(rows.find((r) => r.status === 'scheduled').error).toMatch(/cooldown/i);

    await prisma.emailAccount.update({ where: { id: acc.id }, data: { cooldownSeconds: 0 } });
    mail.sendMail.mockRejectedValue(new Error('Temporary failure 451'));
    const pending = rows.find((r) => r.status === 'scheduled');
    for (let i = 0; i < 3; i++) {
      await prisma.email.update({ where: { id: pending.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await runSchedulerTick({ quiet: true });
    }
    const final = await prisma.email.findUnique({ where: { id: pending.id } });
    expect(final.status).toBe('failed');
    expect(final.attempts).toBe(3);
    expect(final.sentAt).toBeNull();
  });

  it('executes due sequence email steps and advances the enrollment', async () => {
    const { agent: a, user } = await registerUser();
    await connectSmtp(a);
    const carrier = await makeCarrier(user.id, { email: 'seq@example.test', mcNumber: '31337', state: null });
    const seq = await prisma.emailSequence.create({
      data: {
        ownerId: user.id, name: 'Intro', respectBusinessHours: false,
        steps: { create: [
          { order: 0, dayOffset: 0, type: 'email', subject: 'Hello {{company}}', body: 'Hi {{first_name}}' },
          { order: 1, dayOffset: 2, type: 'call', instructions: 'Call' },
        ] },
      },
    });
    const full = await prisma.user.findUnique({ where: { id: user.id } });
    await enrollCarriers(full, seq.id, [carrier]);
    await runSchedulerTick({ quiet: true });
    const email = await prisma.email.findFirst({ where: { carrierId: carrier.id } });
    expect(email.status).toBe('sent');
    expect(email.subject).toBe('Hello Blue Line Trucking LLC');
    const enr = await prisma.sequenceEnrollment.findFirst({ where: { carrierId: carrier.id } });
    expect(enr.currentStep).toBe(1);
    expect(enr.nextStepAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('leaves sequence emails due and notifies once when no mailbox is connected', async () => {
    const { user } = await registerUser();
    const carrier = await makeCarrier(user.id, { email: 'nomb@example.test', mcNumber: '5150' });
    const seq = await prisma.emailSequence.create({
      data: { ownerId: user.id, name: 'S', respectBusinessHours: false, steps: { create: [{ order: 0, dayOffset: 0, type: 'email', subject: 's', body: 'b' }] } },
    });
    await enrollCarriers(await prisma.user.findUnique({ where: { id: user.id } }), seq.id, [carrier]);
    await runSchedulerTick({ quiet: true });
    await runSchedulerTick({ quiet: true });
    expect(await prisma.email.count({ where: { carrierId: carrier.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: user.id, type: 'mailbox_required' } })).toBe(1);
    expect((await prisma.sequenceEnrollment.findFirst({ where: { carrierId: carrier.id } })).currentStep).toBe(0);
  });

  it('sends one follow-up reminder notification', async () => {
    const { user } = await registerUser();
    const carrier = await makeCarrier(user.id, { mcNumber: '8080' });
    await prisma.followUp.create({ data: { carrierId: carrier.id, userId: user.id, dueAt: new Date(Date.now() - 1000), note: 'Call back' } });
    await runSchedulerTick({ quiet: true });
    await runSchedulerTick({ quiet: true });
    expect(await prisma.notification.count({ where: { userId: user.id, type: 'follow_up_due' } })).toBe(1);
  });
});
