import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';

const mail = vi.hoisted(() => ({
  sendMail: vi.fn(async (m) => ({ messageId: m.messageId || '<sys@test>', accepted: [m.to], rejected: [] })),
}));
vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => ({ verify: async () => true, sendMail: mail.sendMail, close: () => {} }));
  return { default: { createTransport }, createTransport };
});

const { registerUser, prisma } = await import('./helpers.js');
const { setSetting } = await import('../src/lib/settings.js');
const { buildDigest, sendDigest, runDigests, registerDigestSection } = await import('../src/services/email/digest.js');
const { sendSystemMail, platformMailStatus } = await import('../src/services/email/system.js');

// 10:00 UTC: 11:00 in Berlin (digest time), 04:00 in Chicago (the default zone of other test users: not yet).
const NOW = new Date('2026-11-10T10:00:00Z');
const ZONE = 'Europe/Berlin';

let i = 0;
async function makeCarrier(ownerId, name) {
  const stage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
  i += 1;
  return prisma.carrier.create({ data: { ownerId, stageId: stage.id, companyName: name || `Digest Carrier ${i}` } });
}

async function digestUser(extra = {}) {
  const u = await registerUser();
  await prisma.user.update({ where: { id: u.user.id }, data: { timezone: ZONE, emailVerifiedAt: new Date(), ...extra } });
  return u;
}
const full = (id) => prisma.user.findUnique({ where: { id } });

beforeAll(async () => {
  await setSetting('smtp.host', 'smtp.platform.test');
  await setSetting('smtp.from', 'DispatchDesk <no-reply@platform.test>');
});
afterAll(async () => {
  await setSetting('smtp.host', '');
  await setSetting('smtp.from', '');
  delete process.env.PLATFORM_MAIL_DAILY_LIMIT;
  await prisma.systemSetting.deleteMany({ where: { key: { in: ['mail.platformBudget', 'digest.state'] } } });
});
beforeEach(() => { mail.sendMail.mockClear(); });

describe('daily digest', () => {
  it('lists overdue and today\'s follow-ups and sequence steps, or nothing', async () => {
    const A = await digestUser();
    expect(await buildDigest(await full(A.user.id), NOW)).toBeNull();
    const c = await makeCarrier(A.user.id, 'Blue Line Trucking');
    await prisma.followUp.create({ data: { carrierId: c.id, userId: A.user.id, dueAt: new Date(NOW.getTime() - 3600000), title: 'Call back about reefer lanes' } });
    await prisma.followUp.create({ data: { carrierId: c.id, userId: A.user.id, dueAt: new Date(NOW.getTime() + 3600000), type: 'email' } });
    await prisma.followUp.create({ data: { carrierId: c.id, userId: A.user.id, dueAt: new Date(NOW.getTime() + 3 * 86400000) } }); // later: not listed
    const s = await prisma.emailSequence.create({ data: { ownerId: A.user.id, name: 'Outreach', steps: { create: [{ order: 0, dayOffset: 0, type: 'call' }] } } });
    await prisma.sequenceEnrollment.create({ data: { sequenceId: s.id, carrierId: c.id, userId: A.user.id, nextStepAt: NOW } });
    const d = await buildDigest(await full(A.user.id), NOW);
    expect(d.subject).toBe('Your day: 1 follow-up due today, 1 overdue, 1 sequence step');
    expect(d.text).toContain('Overdue follow-ups (1)');
    expect(d.text).toContain('Blue Line Trucking: call, was due Tue 10:00 AM. Call back about reefer lanes');
    expect(d.text).toContain('Sequence steps due today (1)');
    expect(d.text).toContain('step 1 of "Outreach"');
    expect(d.html).toContain('<li style=');
    expect(d.html).toContain('Open your queue');
  });

  it('sends from the user\'s own mailbox without creating an email record', async () => {
    const A = await digestUser();
    const acc = (await A.agent.post('/api/email/accounts/smtp').send({ provider: 'hostinger', fromEmail: `own${Date.now()}@dispatch.test`, password: 'pw', cooldownSeconds: 0 })).body.account;
    const c = await makeCarrier(A.user.id);
    await prisma.followUp.create({ data: { carrierId: c.id, userId: A.user.id, dueAt: new Date(Date.now() - 60000) } });
    const r = await sendDigest(await full(A.user.id));
    expect(r).toEqual({ sent: 'mailbox' });
    const sent = mail.sendMail.mock.calls.at(-1)[0];
    expect(sent.to).toBe(A.email);
    expect(sent.headers['Auto-Submitted']).toBe('auto-generated');
    expect(await prisma.email.count({ where: { userId: A.user.id } })).toBe(0);
    expect((await prisma.emailAccount.findUnique({ where: { id: acc.id } })).sentToday).toBe(1);
  });

  it('falls back to platform email, which stays inside the daily budget kept for sign-in mail', async () => {
    process.env.PLATFORM_MAIL_DAILY_LIMIT = '10'; // reserve 3 for auth mail -> other mail stops at 7 sent today
    const A = await digestUser(); // registration sends a verification email (auth)
    const c = await makeCarrier(A.user.id);
    await prisma.followUp.create({ data: { carrierId: c.id, userId: A.user.id, dueAt: new Date(Date.now() - 60000) } });
    await prisma.systemSetting.deleteMany({ where: { key: 'mail.platformBudget' } }); // start the day's counter here
    expect(await sendDigest(await full(A.user.id))).toEqual({ sent: 'platform' });
    for (let k = 0; k < 6; k++) expect((await sendSystemMail({ to: `n${k}@x.test`, subject: 'Notice', text: 't', category: 'notice' })).sent).toBe(true);
    const refused = await sendSystemMail({ to: 'late@x.test', subject: 'Notice', text: 't', category: 'notice' });
    expect(refused).toMatchObject({ sent: false, budget: true });
    expect(await sendDigest(await full(A.user.id))).toMatchObject({ budget: true });
    // Verification / reset mail still goes out.
    expect((await sendSystemMail({ to: 'auth@x.test', subject: 'Reset your password', text: 't' })).sent).toBe(true);
    const status = await platformMailStatus();
    expect(status).toMatchObject({ limit: 10, reserve: 3, sent: 8, other: 7 });
    expect(status.refused).toBeGreaterThanOrEqual(2);
    delete process.env.PLATFORM_MAIL_DAILY_LIMIT;
  });

  it('respects the digest switch and unverified addresses', async () => {
    const off = await digestUser({ notifyDigest: false });
    const c = await makeCarrier(off.user.id);
    await prisma.followUp.create({ data: { carrierId: c.id, userId: off.user.id, dueAt: new Date(Date.now() - 60000) } });
    expect(await sendDigest(await full(off.user.id))).toMatchObject({ skipped: 'digest is off' });
    const unverified = await digestUser({ emailVerifiedAt: null });
    const c2 = await makeCarrier(unverified.user.id);
    await prisma.followUp.create({ data: { carrierId: c2.id, userId: unverified.user.id, dueAt: new Date(Date.now() - 60000) } });
    expect(await sendDigest(await full(unverified.user.id))).toMatchObject({ skipped: 'no mailbox connected' });
  });

  it('runs once per user per day after 7 AM local, and includes registered sections', async () => {
    registerDigestSection('test-extra', async (u) => (u.name.includes('Extra') ? { title: 'Loads delivering today (1)', lines: ['Load 1001 to Dallas, TX'] } : null));
    const A = await digestUser({ name: 'Extra Person' });
    const c = await makeCarrier(A.user.id);
    await prisma.followUp.create({ data: { carrierId: c.id, userId: A.user.id, dueAt: new Date(NOW.getTime() - 60000) } });
    await prisma.systemSetting.deleteMany({ where: { key: 'digest.state' } });
    const early = await runDigests(new Date('2026-11-10T05:00:00Z')); // 06:00 in Berlin
    expect(early.sent).toBe(0);
    const first = await runDigests(NOW);
    expect(first.sent).toBeGreaterThanOrEqual(1);
    const digestsToA = () => mail.sendMail.mock.calls.filter(([m]) => m.to === A.email && /^Your day/.test(m.subject));
    expect(digestsToA()).toHaveLength(1);
    expect(digestsToA()[0][0].text).toContain('Loads delivering today (1)');
    await runDigests(new Date(NOW.getTime() + 3600000));
    expect(digestsToA()).toHaveLength(1);
  });
});
