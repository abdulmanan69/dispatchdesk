import { describe, it, expect, vi, beforeEach } from 'vitest';

const mail = vi.hoisted(() => ({
  verify: vi.fn(async () => true),
  sendMail: vi.fn(async (m) => ({ messageId: m.messageId || '<x@test>', accepted: [m.to], rejected: [] })),
  created: 0,
}));
vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => { mail.created++; return { verify: mail.verify, sendMail: mail.sendMail, close: () => {} }; });
  return { default: { createTransport }, createTransport };
});

const { registerUser, prisma } = await import('./helpers.js');
const { runSchedulerTick, runFastTick, dueEmailEnrollmentIds, dueEmailWhere, LIMITS } = await import('../src/jobs/scheduler.js');
const { deliverEmail, capacity } = await import('../src/services/email/index.js');
const { enrollCarriers, advanceFrom } = await import('../src/services/sequenceEngine.js');
const { localDayKey } = await import('../src/lib/timezones.js');

let seq = 0;
async function makeCarrier(ownerId, data = {}) {
  const stage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
  seq += 1;
  return prisma.carrier.create({ data: { ownerId, stageId: stage.id, companyName: `Sched Carrier ${seq}`, email: `c${seq}.${Date.now()}@carrier.test`, ...data } });
}

async function connect(a, extra = {}) {
  const res = await a.post('/api/email/accounts/smtp').send({ provider: 'hostinger', fromEmail: `me${Date.now()}${Math.random().toString(36).slice(2, 6)}@dispatch.test`, password: 'pw', dailyLimit: 500, cooldownSeconds: 0, ...extra });
  expect(res.status).toBe(201);
  return res.body.account;
}

async function queueEmails(user, account, n, { at = new Date(Date.now() - 60000), subject = 'Bulk' } = {}) {
  await prisma.email.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      userId: user.id, emailAccountId: account.id, toEmail: `to${i}.${Date.now()}@x.test`, subject: `${subject} ${i}`, body: 'Hello', status: 'scheduled', scheduledAt: at,
    })),
  });
}

async function fullUser(id) {
  return prisma.user.findUnique({ where: { id }, include: { teamMembership: true } });
}

beforeEach(() => {
  mail.verify.mockReset().mockResolvedValue(true);
  mail.sendMail.mockReset().mockImplementation(async (m) => ({ messageId: m.messageId || '<x@test>', accepted: [m.to], rejected: [] }));
});

describe('fair email sending', () => {
  it('one user\'s bulk queue does not starve another user\'s email', async () => {
    const A = await registerUser();
    const B = await registerUser();
    const accA = await connect(A.agent);
    const accB = await connect(B.agent);
    await queueEmails(A.user, accA, 40, { at: new Date(Date.now() - 3600000) }); // older than B's
    await queueEmails(B.user, accB, 1, { subject: 'Single' });
    await runFastTick({ quiet: true });
    const b = await prisma.email.findFirst({ where: { userId: B.user.id } });
    expect(b.status).toBe('sent');
    const sentA = await prisma.email.count({ where: { userId: A.user.id, status: 'sent' } });
    expect(sentA).toBeGreaterThan(0);
    expect(sentA).toBeLessThanOrEqual(LIMITS.perMailbox); // a mailbox gets a bounded share of a tick
  });

  it('reuses one SMTP connection per mailbox within a tick', async () => {
    const A = await registerUser();
    const acc = await connect(A.agent);
    await queueEmails(A.user, acc, 5);
    // Leave only this mailbox due (earlier tests leave backlogs behind).
    await prisma.email.updateMany({ where: { status: 'scheduled', userId: { not: A.user.id } }, data: { status: 'canceled' } });
    const before = mail.created;
    await runFastTick({ quiet: true });
    expect(await prisma.email.count({ where: { userId: A.user.id, status: 'sent' } })).toBe(5);
    expect(mail.created - before).toBe(1);
  });

  it('defers a mailbox in cooldown with one write that moves its rows out of the due range', async () => {
    const A = await registerUser();
    const acc = await connect(A.agent, { cooldownSeconds: 600 });
    await queueEmails(A.user, acc, 4);
    await runFastTick({ quiet: true });
    const rows = await prisma.email.findMany({ where: { userId: A.user.id } });
    expect(rows.filter((r) => r.status === 'sent')).toHaveLength(1);
    const waiting = rows.filter((r) => r.status === 'scheduled');
    expect(waiting).toHaveLength(3);
    for (const w of waiting) {
      expect(w.error).toMatch(/cooldown/i);
      expect(w.scheduledAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60000);
    }
    // Nothing of this mailbox is due on the next tick.
    const due = await prisma.email.count({ where: { ...dueEmailWhere(new Date()), userId: A.user.id } });
    expect(due).toBe(0);
  });

  it('keeps an O(1) per-mailbox daily counter and defers at the mailbox limit until the next local day', async () => {
    const A = await registerUser();
    const acc = await connect(A.agent, { dailyLimit: 2 });
    await queueEmails(A.user, acc, 4);
    await runFastTick({ quiet: true });
    const row = await prisma.emailAccount.findUnique({ where: { id: acc.id } });
    expect(row.sentToday).toBe(2);
    expect(row.sentDay).toBe(localDayKey('America/Chicago'));
    expect(row.lastSentAt).not.toBeNull();
    const waiting = await prisma.email.findMany({ where: { userId: A.user.id, status: 'scheduled' } });
    expect(waiting).toHaveLength(2);
    expect(waiting[0].error).toMatch(/daily limit/i);
    expect(waiting[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    const list = await A.agent.get('/api/email/accounts');
    expect(list.body.items.find((x) => x.id === acc.id).sentToday).toBe(2);
    // capacity() reads the counter, not the Email table.
    const user = await fullUser(A.user.id);
    expect((await capacity(user, row)).reason).toMatch(/Mailbox daily limit/);
  });

  it('never sends the same email twice when two processes deliver it at once', async () => {
    const A = await registerUser();
    const acc = await connect(A.agent);
    const email = await prisma.email.create({ data: { userId: A.user.id, emailAccountId: acc.id, toEmail: 'once@x.test', subject: 'Once', body: 'b', status: 'scheduled', scheduledAt: new Date() } });
    let release;
    mail.sendMail.mockImplementationOnce(async (m) => { await new Promise((r) => { release = r; }); return { messageId: m.messageId, accepted: [m.to], rejected: [] }; });
    const first = deliverEmail(email.id, { retry: true });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const second = await deliverEmail(email.id, { retry: true }); // row is 'sending' now: not claimable
    expect(second.outcome).toBe('skipped');
    release();
    expect((await first).outcome).toBe('sent');
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  });

  it('stays sent when bookkeeping fails after the provider accepted the message', async () => {
    const A = await registerUser();
    const acc = await connect(A.agent);
    const carrier = await makeCarrier(A.user.id);
    const email = await prisma.email.create({ data: { userId: A.user.id, carrierId: carrier.id, emailAccountId: acc.id, toEmail: carrier.email, subject: 'Hi', body: 'b', status: 'scheduled', scheduledAt: new Date() } });
    // The carrier is deleted while the provider is sending: the carrier update and activity insert then fail.
    mail.sendMail.mockImplementationOnce(async (m) => { await prisma.carrier.delete({ where: { id: carrier.id } }); return { messageId: m.messageId, accepted: [m.to], rejected: [] }; });
    const r = await deliverEmail(email.id, { retry: true });
    expect(r.outcome).toBe('sent');
    const row = await prisma.email.findUnique({ where: { id: email.id } });
    expect(row.status).toBe('sent');
    expect(row.nextAttemptAt).toBeNull();
    await runFastTick({ quiet: true });
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  });

  it('stores a Message-ID on the sender domain and passes it to the provider', async () => {
    const A = await registerUser();
    await connect(A.agent);
    const res = await A.agent.post('/api/email/messages').send({ toEmail: 'mid@x.test', subject: 'Threading', body: 'b', mode: 'send' });
    expect(res.body.outcome).toBe('sent');
    const sent = mail.sendMail.mock.calls[0][0];
    expect(sent.messageId).toMatch(/^<dd\.[a-z0-9]+\.[0-9a-f]+@dispatch\.test>$/);
    expect((await prisma.email.findUnique({ where: { id: res.body.email.id } })).messageId).toBe(sent.messageId);
  });
});

describe('sequence email steps', () => {
  async function sequenceWith(ownerId, steps, extra = {}) {
    return prisma.emailSequence.create({
      data: { ownerId, name: `Seq ${Date.now()}`, respectBusinessHours: false, ...extra, steps: { create: steps.map((s, i) => ({ order: i, dayOffset: 0, ...s })) } },
      include: { steps: { orderBy: { order: 'asc' } } },
    });
  }

  it('due call steps never starve email steps (the batch only holds email steps)', async () => {
    const A = await registerUser();
    await connect(A.agent);
    const callSeq = await sequenceWith(A.user.id, [{ type: 'call', instructions: 'Call' }, { type: 'email', subject: 's', body: 'b', dayOffset: 3 }]);
    const user = await fullUser(A.user.id);
    const callers = await Promise.all(Array.from({ length: LIMITS.enrollmentsPerTick + 10 }, () => makeCarrier(A.user.id)));
    await enrollCarriers(user, callSeq.id, callers);
    await prisma.sequenceEnrollment.updateMany({ where: { sequenceId: callSeq.id }, data: { nextStepAt: new Date(Date.now() - 3600000) } });
    const emailSeq = await sequenceWith(A.user.id, [{ type: 'email', subject: 'Hello {{company}}', body: 'Hi' }]);
    const target = await makeCarrier(A.user.id);
    await enrollCarriers(user, emailSeq.id, [target]);
    const ids = await dueEmailEnrollmentIds(new Date());
    expect(ids.length).toBeGreaterThan(0);
    await runFastTick({ quiet: true });
    const email = await prisma.email.findFirst({ where: { carrierId: target.id } });
    expect(email).not.toBeNull();
    expect(email.subject).toBe(`Hello ${target.companyName}`);
    expect((await prisma.sequenceEnrollment.findFirst({ where: { carrierId: target.id } })).status).toBe('completed');
  });

  it('serves users fairly: a big enrollment does not hold back another user', async () => {
    const A = await registerUser();
    const B = await registerUser();
    await connect(A.agent);
    await connect(B.agent);
    const sA = await sequenceWith(A.user.id, [{ type: 'email', subject: 's', body: 'b' }]);
    const sB = await sequenceWith(B.user.id, [{ type: 'email', subject: 's', body: 'b' }]);
    const many = await Promise.all(Array.from({ length: 20 }, () => makeCarrier(A.user.id)));
    await enrollCarriers(await fullUser(A.user.id), sA.id, many);
    await prisma.sequenceEnrollment.updateMany({ where: { sequenceId: sA.id }, data: { nextStepAt: new Date(Date.now() - 7200000) } });
    const one = await makeCarrier(B.user.id);
    await enrollCarriers(await fullUser(B.user.id), sB.id, [one]);
    await runFastTick({ quiet: true });
    expect(await prisma.email.count({ where: { carrierId: one.id } })).toBe(1);
    expect(await prisma.email.count({ where: { userId: A.user.id, enrollmentId: { not: null } } })).toBeLessThanOrEqual(LIMITS.enrollmentsPerUser);
  });

  it('moves capped and mailbox-less steps out of the due set instead of retrying them every tick', async () => {
    const A = await registerUser();
    await connect(A.agent);
    const capped = await sequenceWith(A.user.id, [{ type: 'email', subject: 's', body: 'b' }], { maxEmailsPerDay: 1 });
    const cs = [await makeCarrier(A.user.id), await makeCarrier(A.user.id)];
    await enrollCarriers(await fullUser(A.user.id), capped.id, cs);
    await runFastTick({ quiet: true });
    const rows = await prisma.sequenceEnrollment.findMany({ where: { sequenceId: capped.id } });
    expect(rows.filter((r) => r.status === 'completed')).toHaveLength(1);
    const waiting = rows.find((r) => r.status === 'active');
    expect(waiting.nextStepAt.getTime()).toBeGreaterThan(Date.now() + 3600000);

    const N = await registerUser(); // no mailbox
    const s = await sequenceWith(N.user.id, [{ type: 'email', subject: 's', body: 'b' }]);
    const c = await makeCarrier(N.user.id);
    await enrollCarriers(await fullUser(N.user.id), s.id, [c]);
    await runFastTick({ quiet: true });
    const e = await prisma.sequenceEnrollment.findFirst({ where: { carrierId: c.id } });
    expect(e.currentStep).toBe(0);
    expect(e.nextStepAt.getTime()).toBeGreaterThan(Date.now() + 50 * 60000);
  });

  it('step advancement is compare-and-set: a stale step is never advanced twice', async () => {
    const A = await registerUser();
    const s = await sequenceWith(A.user.id, [{ type: 'call' }, { type: 'call', dayOffset: 1 }, { type: 'call', dayOffset: 2 }]);
    const c = await makeCarrier(A.user.id);
    await enrollCarriers(await fullUser(A.user.id), s.id, [c]);
    const enr = await prisma.sequenceEnrollment.findFirst({ where: { carrierId: c.id }, include: { carrier: true } });
    expect(await advanceFrom(enr, s, { expectedStep: 0 })).not.toBeNull();
    expect(await advanceFrom(enr, s, { expectedStep: 0 })).toBeNull(); // the same snapshot again
    expect((await prisma.sequenceEnrollment.findUnique({ where: { id: enr.id } })).currentStep).toBe(1);
  });
});

describe('follow-up reminders', () => {
  it('finds a one-day-ahead reminder even when hundreds of earlier follow-ups exist', async () => {
    const A = await registerUser();
    const c = await makeCarrier(A.user.id);
    const soon = new Date(Date.now() + 2 * 86400000);
    await prisma.followUp.createMany({ data: Array.from({ length: 600 }, () => ({ carrierId: c.id, userId: A.user.id, dueAt: soon })) });
    const target = await prisma.followUp.create({ data: { carrierId: c.id, userId: A.user.id, dueAt: new Date(Date.now() + 23 * 3600000), remindMinutesBefore: 1440, title: 'Day ahead' } });
    // Earlier-due rows of other users with a closer due time than the target.
    await prisma.followUp.createMany({ data: Array.from({ length: 600 }, () => ({ carrierId: c.id, userId: A.user.id, dueAt: new Date(Date.now() + 3 * 3600000) })) });
    const t0 = Date.now();
    await runFastTick({ quiet: true, longLeads: true });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((await prisma.followUp.findUnique({ where: { id: target.id } })).notifiedAt).not.toBeNull();
    const notes = await prisma.notification.findMany({ where: { userId: A.user.id, type: 'follow_up_due' } });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toMatch(/^Coming up: /);
    await prisma.followUp.deleteMany({ where: { carrierId: c.id } });
  });

  it('sends one summary notification for a backlog and never emails per reminder', async () => {
    const A = await registerUser();
    const c = await makeCarrier(A.user.id);
    await prisma.followUp.createMany({ data: Array.from({ length: 12 }, (_, i) => ({ carrierId: c.id, userId: A.user.id, dueAt: new Date(Date.now() - (i + 1) * 60000) })) });
    await runFastTick({ quiet: true });
    await runFastTick({ quiet: true });
    const notes = await prisma.notification.findMany({ where: { userId: A.user.id, type: 'follow_up_due' } });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('12 follow-ups are due');
    expect(await prisma.followUp.count({ where: { userId: A.user.id, notifiedAt: null } })).toBe(0);
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('respects the follow-up reminder switch', async () => {
    const A = await registerUser();
    await prisma.user.update({ where: { id: A.user.id }, data: { notifyFollowUps: false } });
    const c = await makeCarrier(A.user.id);
    const f = await prisma.followUp.create({ data: { carrierId: c.id, userId: A.user.id, dueAt: new Date(Date.now() - 1000) } });
    await runFastTick({ quiet: true });
    expect((await prisma.followUp.findUnique({ where: { id: f.id } })).notifiedAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { userId: A.user.id } })).toBe(0);
  });
});

describe('slow jobs', () => {
  it('leaves a knowledge upload that is still ingesting alone and claims abandoned ones once', async () => {
    const { runSlowTick } = await import('../src/jobs/scheduler.js');
    const A = await registerUser();
    const doc = (minutesAgo) => prisma.aIKnowledgeDocument.create({
      data: {
        ownerId: A.user.id, title: 'Rates', originalName: 'rates.txt', storedName: `missing-${Date.now()}-${minutesAgo}.txt`, mimeType: 'text/plain',
        status: 'processing', updatedAt: new Date(Date.now() - minutesAgo * 60000),
      },
    });
    const busy = await doc(2); // an upload request is still working on it
    const abandoned = await doc(30);
    await runSlowTick({ quiet: true });
    expect((await prisma.aIKnowledgeDocument.findUnique({ where: { id: busy.id } })).status).toBe('processing');
    expect((await prisma.aIKnowledgeDocument.findUnique({ where: { id: abandoned.id } })).status).not.toBe('processing'); // ingested (here: file missing, so error)
  });

  it('re-arms stale email steps of active sequences only', async () => {
    const { sweepStaleEmailSteps } = await import('../src/jobs/scheduler.js');
    const A = await registerUser();
    const mk = (active) => prisma.emailSequence.create({ data: { ownerId: A.user.id, name: `Sweep ${active}`, active, steps: { create: [{ order: 0, dayOffset: 0, type: 'email', subject: 's', body: 'b' }] } } });
    const [on, off] = [await mk(true), await mk(false)];
    const old = new Date(Date.now() - 5 * 86400000);
    const c1 = await makeCarrier(A.user.id);
    const c2 = await makeCarrier(A.user.id);
    const e1 = await prisma.sequenceEnrollment.create({ data: { sequenceId: on.id, carrierId: c1.id, userId: A.user.id, nextStepAt: old } });
    const e2 = await prisma.sequenceEnrollment.create({ data: { sequenceId: off.id, carrierId: c2.id, userId: A.user.id, nextStepAt: old } });
    const now = new Date();
    await sweepStaleEmailSteps(now);
    expect((await prisma.sequenceEnrollment.findUnique({ where: { id: e1.id } })).nextStepAt.getTime()).toBe(now.getTime());
    expect((await prisma.sequenceEnrollment.findUnique({ where: { id: e2.id } })).nextStepAt.getTime()).toBe(old.getTime());
  });
});

describe('scheduler shape', () => {
  it('registers the digest, reply-detection and retention jobs for Admin → Setup', async () => {
    const { JOBS, runJob } = await import('../src/jobs/maintenance.js');
    const names = JOBS.map((j) => j.name);
    expect(names).toEqual(expect.arrayContaining(['email-digest', 'imap-replies', 'activity-retention']));
    const A = await registerUser();
    const old = await prisma.activity.create({ data: { userId: A.user.id, type: 'sequence', summary: 'old', createdAt: new Date(Date.now() - 600 * 86400000) } });
    const oldPost = await prisma.activity.create({ data: { userId: A.user.id, type: 'truck_post', summary: 'old truck post', createdAt: new Date(Date.now() - 600 * 86400000) } });
    const newPost = await prisma.activity.create({ data: { userId: A.user.id, type: 'truck_post', summary: 'recent truck post', createdAt: new Date(Date.now() - 30 * 86400000) } });
    const keep = await prisma.activity.create({ data: { userId: A.user.id, type: 'call', summary: 'old call', createdAt: new Date(Date.now() - 600 * 86400000) } });
    const r = await runJob(JOBS.find((j) => j.name === 'activity-retention'));
    expect(r.ok).toBe(true);
    expect(await prisma.activity.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.activity.findUnique({ where: { id: oldPost.id } })).toBeNull();
    expect(await prisma.activity.findUnique({ where: { id: newPost.id } })).not.toBeNull();
    expect(await prisma.activity.findUnique({ where: { id: keep.id } })).not.toBeNull();
  });

  it('runs the fast work before the slow work and reports timings', async () => {
    const r = await runSchedulerTick({ quiet: true });
    expect(r).toHaveProperty('sequenceEmails');
    expect(r).toHaveProperty('emails');
    expect(r).toHaveProperty('reminders');
    expect(r).toHaveProperty('knowledge');
    expect(r.ms).toHaveProperty('emails');
  });

  it('scheduler queries use their indexes', async () => {
    const plan = async (sql) => (await prisma.$queryRawUnsafe(`EXPLAIN QUERY PLAN ${sql}`)).map((p) => p.detail).join(' | ');
    expect(await plan(`SELECT emailAccountId FROM Email WHERE status='scheduled' AND scheduledAt <= '2030' AND (nextAttemptAt IS NULL OR nextAttemptAt <= '2030') GROUP BY emailAccountId`))
      .toMatch(/Email_status_scheduledAt_idx \(status=\? AND scheduledAt<\?\)/);
    expect(await plan(`SELECT e.id FROM SequenceEnrollment e JOIN SequenceStep s ON s.sequenceId = e.sequenceId AND s."order" = e.currentStep WHERE e.status='active' AND e.nextStepAt > '2026' AND e.nextStepAt <= '2030' AND s.type='email'`))
      .toMatch(/SequenceEnrollment_status_nextStepAt_idx/);
    expect(await plan(`SELECT id FROM FollowUp WHERE status='pending' AND notifiedAt IS NULL AND remindMinutesBefore = 60 AND dueAt > '2026' AND dueAt <= '2030' ORDER BY dueAt LIMIT 300`))
      .toMatch(/FollowUp_status_notifiedAt_dueAt_idx/);
    expect(await plan(`SELECT COUNT(*) FROM Email WHERE userId='x' AND status='sent' AND sentAt >= '2026'`)).toMatch(/Email_userId_status_sentAt_idx/);
  });
});
