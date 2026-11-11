import { describe, it, expect, vi, beforeEach } from 'vitest';

const mail = vi.hoisted(() => ({
  verify: vi.fn(async () => true),
  sendMail: vi.fn(async (m) => ({ messageId: m.messageId || '<x@test>', accepted: [m.to], rejected: [] })),
}));
vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => ({ verify: mail.verify, sendMail: mail.sendMail, close: () => {} }));
  return { default: { createTransport }, createTransport };
});

// AI calls never leave the process: chat() is replaced, the rest of llm.js stays as it is.
const ai = vi.hoisted(() => ({
  chat: vi.fn(),
  parse: (text) => {
    const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(cleaned); } catch { return null; }
  },
}));
vi.mock('../src/services/ai/llm.js', async (importOriginal) => {
  let orig = {};
  try { orig = await importOriginal(); } catch { /* llm.js is being rewritten: chat and parseJsonReply are all we need */ }
  return { ...orig, chat: ai.chat, parseJsonReply: orig.parseJsonReply || ai.parse };
});

const { registerUser, prisma } = await import('./helpers.js');
const { runFastTick, dueEmailEnrollmentIds } = await import('../src/jobs/scheduler.js');
const { runAiSequenceEmails, dueAiEnrollmentIds, jobs } = await import('../src/jobs/extra/ai-sequence-email.js');
const { enrollCarriers, stopEnrollments, AI_NOTE_PREFIX } = await import('../src/services/sequenceEngine.js');
const { buildSequenceEmailPrompt, unsupportedClaims } = await import('../src/services/ai/sequenceEmail.js');
const { HttpError } = await import('../src/lib/errors.js');
const { localParts } = await import('../src/lib/timezones.js');

const quiet = { log: () => {} };
const later = () => new Date(Date.now() + 2000);
let n = 0;

async function makeCarrier(ownerId, data = {}) {
  const stage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
  n += 1;
  return prisma.carrier.create({ data: { ownerId, stageId: stage.id, companyName: `AI Carrier ${n} ${Date.now()}`, email: `ai${n}.${Date.now()}@carrier.test`, ...data } });
}

async function connect(a) {
  const res = await a.post('/api/email/accounts/smtp').send({ provider: 'hostinger', fromEmail: `me${Date.now()}${Math.random().toString(36).slice(2, 6)}@dispatch.test`, password: 'pw', dailyLimit: 500, cooldownSeconds: 0 });
  expect(res.status).toBe(201);
  return res.body.account;
}

const fullUser = (id) => prisma.user.findUnique({ where: { id }, include: { teamMembership: true } });

async function aiSequence(ownerId, steps, extra = {}) {
  n += 1;
  return prisma.emailSequence.create({
    data: { ownerId, name: `AI seq ${n}`, respectBusinessHours: false, ...extra, steps: { create: steps.map((s, i) => ({ order: i, dayOffset: 0, type: 'email', ...s })) } },
    include: { steps: { orderBy: { order: 'asc' } } },
  });
}

async function setup({ steps, carriers = 1, carrierData = {}, mailbox = true, extra } = {}) {
  const U = await registerUser();
  if (mailbox) await connect(U.agent);
  const seq = await aiSequence(U.user.id, steps, extra);
  const list = [];
  for (let i = 0; i < carriers; i++) list.push(await makeCarrier(U.user.id, carrierData));
  await enrollCarriers(await fullUser(U.user.id), seq.id, list);
  return { U, seq, carriers: list };
}

const companyIn = (messages) => /Company: (.*)/.exec(messages[1].content)?.[1];
function writes({ subject = (c) => `Dispatch help for ${c}`, body = (c) => `Hi there,\n\nI dispatch for small fleets like ${c}.\n\nBest,\nTest User` } = {}) {
  return async (messages) => JSON.stringify({ subject: subject(companyIn(messages)), body: body(companyIn(messages)) });
}
const aiError = (status, code) => new HttpError(status, code, { code }); // the shape llm.js throws (code in details)

beforeEach(async () => {
  // Leftovers from earlier tests (and other files) must not join this test's due set.
  await prisma.sequenceEnrollment.updateMany({ where: { status: 'active' }, data: { status: 'paused' } });
  ai.chat.mockReset().mockImplementation(writes());
  mail.sendMail.mockReset().mockImplementation(async (m) => ({ messageId: m.messageId || '<x@test>', accepted: [m.to], rejected: [] }));
});

describe('hand-off from the fast loop', () => {
  it('the fast loop never renders an AI step; the AI job picks it up', async () => {
    const { seq, carriers: [c] } = await setup({ steps: [{ aiMode: 'auto', aiBrief: 'Offer dispatch for dry vans', subject: 'Template {{company}}', body: 'Template body' }] });
    const enr = await prisma.sequenceEnrollment.findFirst({ where: { sequenceId: seq.id } });
    expect(await dueEmailEnrollmentIds(later())).not.toContain(enr.id);
    expect(await dueAiEnrollmentIds(later())).toContain(enr.id);
    await runFastTick({ quiet: true, now: later() });
    expect(await prisma.email.count({ where: { carrierId: c.id } })).toBe(0);
    const after = await prisma.sequenceEnrollment.findUnique({ where: { id: enr.id } });
    expect(after.currentStep).toBe(0);
    expect(after.nextStepAt.getTime()).toBe(enr.nextStepAt.getTime()); // not leased or touched
    expect(ai.chat).not.toHaveBeenCalled();
  });

  it('is registered as a background job every 2 minutes', () => {
    expect(jobs[0]).toMatchObject({ name: 'ai-sequence-email', everyMs: 120000 });
  });
});

describe('writing AI steps', () => {
  it('queues exactly one email per step and advances once; a re-run writes nothing', async () => {
    const { seq, carriers: [c] } = await setup({ steps: [{ aiMode: 'auto', aiBrief: 'Introduce my dispatch service' }, { type: 'call', dayOffset: 2, instructions: 'Call' }] });
    const r1 = await runAiSequenceEmails(later(), quiet);
    expect(r1.written).toBe(1);
    const emails = await prisma.email.findMany({ where: { carrierId: c.id } });
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ status: 'scheduled', aiGenerated: true, toEmail: c.email, subject: `Dispatch help for ${c.companyName}` });
    const enr = await prisma.sequenceEnrollment.findFirst({ where: { sequenceId: seq.id } });
    expect(emails[0].enrollmentId).toBe(enr.id);
    expect(enr.currentStep).toBe(1);

    await runAiSequenceEmails(later(), quiet);
    expect(await prisma.email.count({ where: { carrierId: c.id } })).toBe(1);
    expect(ai.chat).toHaveBeenCalledTimes(1);

    // Sent by the scheduler like a template email: unsubscribe footer included.
    await runFastTick({ quiet: true });
    expect((await prisma.email.findFirst({ where: { carrierId: c.id } })).status).toBe('sent');
    const wire = mail.sendMail.mock.calls.find(([m]) => m.to === c.email)[0];
    expect(wire.text).toMatch(/Unsubscribe: http/);
  });

  it('two runs at the same time never write the same step twice', async () => {
    const { carriers } = await setup({ steps: [{ aiMode: 'auto', aiBrief: 'Introduce my dispatch service' }], carriers: 3 });
    ai.chat.mockImplementation(async (messages) => { await new Promise((r) => setTimeout(r, 30)); return writes()(messages); });
    await Promise.all([runAiSequenceEmails(later(), quiet), runAiSequenceEmails(later(), quiet)]);
    for (const c of carriers) expect(await prisma.email.count({ where: { carrierId: c.id } })).toBe(1);
    expect(ai.chat).toHaveBeenCalledTimes(3);
  });

  it('"AI writes, I approve" stores the email for review and never sends it', async () => {
    const { U, carriers: [c] } = await setup({ steps: [{ aiMode: 'review', aiBrief: 'Introduce my dispatch service' }] });
    const r = await runAiSequenceEmails(later(), quiet);
    expect(r.review).toBe(1);
    const e = await prisma.email.findFirst({ where: { carrierId: c.id } });
    expect(e).toMatchObject({ status: 'review', aiGenerated: true, scheduledAt: null });
    await runFastTick({ quiet: true });
    expect((await prisma.email.findUnique({ where: { id: e.id } })).status).toBe('review');
    expect(mail.sendMail.mock.calls.some(([m]) => m.to === c.email)).toBe(false);
    const note = await prisma.notification.findFirst({ where: { userId: U.user.id, type: 'ai_review_waiting' } });
    expect(note.link).toBe('/app/email?tab=review');
  });

  it('gives the model only the carrier facts, the sender and earlier emails of this sequence', async () => {
    const { U, carriers: [c] } = await setup({
      steps: [{ subject: 'First {{company}}', body: 'Hello from the template' }, { aiMode: 'auto', aiBrief: 'Follow up on my intro, offer a 10 minute call' }],
      carrierData: { mcNumber: '778899', dotNumber: '3344556', city: 'Tulsa', state: 'OK', equipment: 'dry_van,reefer', fleetSize: 4, phone: '9185550147', address: '12 Hidden Lane' },
    });
    await prisma.carrierContact.create({ data: { carrierId: c.id, name: 'Marcus Hill', phone: '9185550199', isPrimary: true } });
    await prisma.carrierNote.create({ data: { carrierId: c.id, authorId: U.user.id, body: 'Owes us money, secret note' } });
    await prisma.user.update({ where: { id: U.user.id }, data: { companyName: 'Lee Dispatch Services' } });
    await runFastTick({ quiet: true, now: later() }); // template step 1, sent
    await prisma.sequenceEnrollment.updateMany({ where: { carrierId: c.id }, data: { nextStepAt: new Date() } });
    await runAiSequenceEmails(later(), quiet);
    expect(ai.chat).toHaveBeenCalledTimes(1);
    const [messages, opts] = ai.chat.mock.calls[0];
    expect(opts).toMatchObject({ purpose: 'sequence_email', json: true });
    expect(opts.user.id).toBe(U.user.id);
    const [system, user] = messages;
    expect(system.role).toBe('system');
    expect(system.content).toMatch(/Never invent or estimate rates/);
    expect(system.content).toMatch(/no exclamation marks/);
    for (const fact of [c.companyName, 'Marcus', '778899', '3344556', 'Tulsa, OK', 'dry van, reefer', 'Fleet size (power units): 4', 'Lee Dispatch Services', 'Follow up on my intro', `First ${c.companyName}`]) {
      expect(user.content).toContain(fact);
    }
    for (const secret of ['9185550147', '9185550199', '12 Hidden Lane', 'secret note', 'Hill', c.email]) expect(user.content).not.toContain(secret);
    expect(user.content).toMatch(/email step 2 of 2/);
  });

  it('holds an email for approval when the AI writes a figure the inputs do not contain', async () => {
    ai.chat.mockImplementation(writes({ body: () => 'Hi there,\n\nOur carriers average $3.25 per mile and 20% more loads!\n\nBest,\nTest' }));
    const { carriers: [c] } = await setup({ steps: [{ aiMode: 'auto', aiBrief: 'Introduce my dispatch service, fee is 5%' }] });
    await runAiSequenceEmails(later(), quiet);
    const e = await prisma.email.findFirst({ where: { carrierId: c.id } });
    expect(e.status).toBe('review');
    expect(e.error).toMatch(/\$3\.25/);
    expect(e.body).not.toContain('!');
    expect(unsupportedClaims('Our fee is 5% flat', 'fee is 5%')).toEqual([]);
  });
});

describe('when AI cannot write', () => {
  it('sends the step template instead (503) and notifies once a day', async () => {
    ai.chat.mockRejectedValue(aiError(503, 'AI_NOT_CONFIGURED'));
    const { U, carriers } = await setup({ steps: [{ aiMode: 'auto', aiBrief: 'Intro', subject: 'Trucks for {{company}}', body: 'Hello {{company}}' }], carriers: 2 });
    const r = await runAiSequenceEmails(later(), quiet);
    expect(r.fallback).toBe(2);
    expect(ai.chat).toHaveBeenCalledTimes(1); // the second step of the same user does not call again
    for (const c of carriers) {
      const e = await prisma.email.findFirst({ where: { carrierId: c.id } });
      expect(e).toMatchObject({ status: 'scheduled', aiGenerated: false, subject: `Trucks for ${c.companyName}` });
    }
    const notes = await prisma.notification.findMany({ where: { userId: U.user.id, type: 'ai_sequence_failed' } });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toMatch(/^AI could not write 2 sequence emails/);

    // Same day, another failure (429): no second notification.
    ai.chat.mockRejectedValue(aiError(429, 'AI_QUOTA'));
    const seq2 = await aiSequence(U.user.id, [{ aiMode: 'auto', aiBrief: 'Intro', subject: 'S', body: 'B' }]);
    await enrollCarriers(await fullUser(U.user.id), seq2.id, [await makeCarrier(U.user.id)]);
    expect((await runAiSequenceEmails(later(), quiet)).fallback).toBe(1);
    expect(await prisma.notification.count({ where: { userId: U.user.id, type: 'ai_sequence_failed' } })).toBe(1);
  });

  it('without a template, waits for approval with the brief and a note; approving unchanged is refused', async () => {
    ai.chat.mockRejectedValue(aiError(429, 'AI_QUOTA'));
    const { U, carriers: [c] } = await setup({ steps: [{ aiMode: 'auto', aiBrief: 'Offer my dispatch service to {{company}}' }] });
    expect((await runAiSequenceEmails(later(), quiet)).note).toBe(1);
    const e = await prisma.email.findFirst({ where: { carrierId: c.id } });
    expect(e).toMatchObject({ status: 'review', aiGenerated: false, body: 'Offer my dispatch service to {{company}}' });
    expect(e.error.startsWith(AI_NOTE_PREFIX)).toBe(true);
    expect(e.error).toMatch(/usage limit/);
    const list = await U.agent.get('/api/email/review');
    expect(list.body.items.find((x) => x.id === e.id)).toMatchObject({ needsWriting: true, sequence: { ended: false } });
    expect((await U.agent.post(`/api/email/messages/${e.id}/approve`).send({})).status).toBe(400);
    const ok = await U.agent.post(`/api/email/messages/${e.id}/approve`).send({ body: 'Hi {{first_name}},\n\nI help {{company}} stay loaded.' });
    expect(ok.status).toBe(200);
    expect(ok.body.email).toMatchObject({ status: 'scheduled', error: null });
    expect(ok.body.email.body).toContain(`I help ${c.companyName} stay loaded.`);
  });

  it('treats an unusable reply as a failure without retrying', async () => {
    ai.chat.mockResolvedValue('not json at all');
    const { carriers: [c] } = await setup({ steps: [{ aiMode: 'review', aiBrief: 'Intro', subject: 'S {{company}}', body: 'B' }] });
    expect((await runAiSequenceEmails(later(), quiet)).fallback).toBe(1);
    expect((await prisma.email.findFirst({ where: { carrierId: c.id } })).status).toBe('scheduled');
    await runAiSequenceEmails(later(), quiet);
    expect(ai.chat).toHaveBeenCalledTimes(1);
  });
});

describe('the same rules as template emails', () => {
  it('stop-on-reply stops AI steps, also while the AI is writing', async () => {
    const { U, carriers: [c] } = await setup({ steps: [{ aiMode: 'auto', aiBrief: 'Intro' }, { aiMode: 'auto', aiBrief: 'Follow up' }] });
    await runAiSequenceEmails(later(), quiet);
    await runFastTick({ quiet: true });
    const first = await prisma.email.findFirst({ where: { carrierId: c.id } });
    expect(first.status).toBe('sent');
    const replied = await U.agent.post(`/api/email/messages/${first.id}/replied`);
    expect(replied.body.stopped).toBe(1);
    await prisma.sequenceEnrollment.updateMany({ where: { carrierId: c.id }, data: { nextStepAt: new Date() } }); // stays stopped
    await runAiSequenceEmails(later(), quiet);
    expect(await prisma.email.count({ where: { carrierId: c.id } })).toBe(1);
    expect(ai.chat).toHaveBeenCalledTimes(1);

    // The reply arrives while the AI is writing: nothing is written.
    const other = await setup({ steps: [{ aiMode: 'auto', aiBrief: 'Intro' }] });
    const oc = other.carriers[0];
    ai.chat.mockImplementation(async (messages) => { await stopEnrollments(oc.id, 'replied'); return writes()(messages); });
    expect((await runAiSequenceEmails(later(), quiet)).skipped).toBe(1);
    expect(await prisma.email.count({ where: { carrierId: oc.id } })).toBe(0);
  });

  it('a do-not-email carrier is skipped without an AI call', async () => {
    const { seq, carriers: [c] } = await setup({ steps: [{ aiMode: 'auto', aiBrief: 'Intro' }], carrierData: { doNotEmail: true } });
    await runAiSequenceEmails(later(), quiet);
    expect(ai.chat).not.toHaveBeenCalled();
    expect(await prisma.email.count({ where: { carrierId: c.id } })).toBe(0);
    expect((await prisma.sequenceEnrollment.findFirst({ where: { sequenceId: seq.id } })).status).toBe('completed');
  });

  it('respects the daily cap, a missing mailbox and the send window', async () => {
    const capped = await setup({ steps: [{ aiMode: 'auto', aiBrief: 'Intro' }], carriers: 2, extra: { maxEmailsPerDay: 1 } });
    await runAiSequenceEmails(later(), quiet);
    const rows = await prisma.sequenceEnrollment.findMany({ where: { sequenceId: capped.seq.id } });
    expect(rows.filter((r) => r.status === 'completed')).toHaveLength(1);
    expect(rows.find((r) => r.status === 'active').nextStepAt.getTime()).toBeGreaterThan(Date.now() + 3600000);
    expect(ai.chat).toHaveBeenCalledTimes(1);

    const none = await setup({ steps: [{ aiMode: 'auto', aiBrief: 'Intro' }], mailbox: false });
    await runAiSequenceEmails(later(), quiet);
    const e = await prisma.sequenceEnrollment.findFirst({ where: { sequenceId: none.seq.id } });
    expect(e.currentStep).toBe(0);
    expect(e.nextStepAt.getTime()).toBeGreaterThan(Date.now() + 50 * 60000);
    expect(await prisma.notification.count({ where: { userId: none.U.user.id, type: 'mailbox_required' } })).toBe(1);

    // Closed window in the carrier's zone (state TX, America/Chicago): written when it opens, not now.
    const hour = localParts('America/Chicago', new Date()).hour;
    const start = (hour + 2) % 24 === 23 ? 21 : (hour + 2) % 24;
    const win = await setup({ steps: [{ aiMode: 'auto', aiBrief: 'Intro' }], carrierData: { state: 'TX' }, extra: { respectBusinessHours: true, windowStartHour: start, windowEndHour: start + 1, skipWeekends: false } });
    await prisma.sequenceEnrollment.updateMany({ where: { sequenceId: win.seq.id }, data: { nextStepAt: new Date() } });
    const calls = ai.chat.mock.calls.length;
    expect((await runAiSequenceEmails(later(), quiet)).deferred).toBeGreaterThanOrEqual(1);
    expect(ai.chat.mock.calls.length).toBe(calls);
    const w = await prisma.sequenceEnrollment.findFirst({ where: { sequenceId: win.seq.id } });
    expect(w.currentStep).toBe(0);
    expect(w.nextStepAt.getTime()).toBeGreaterThan(Date.now() + 30 * 60000);
  });

  it('the AI due query uses the enrollment index', async () => {
    const plan = (await prisma.$queryRawUnsafe(`EXPLAIN QUERY PLAN SELECT e.id FROM SequenceEnrollment e JOIN SequenceStep s ON s.sequenceId = e.sequenceId AND s."order" = e.currentStep WHERE e.status='active' AND e.nextStepAt > '2026' AND e.nextStepAt <= '2030' AND s.type='email' AND s.aiMode IN ('auto', 'review')`)).map((p) => p.detail).join(' | ');
    expect(plan).toMatch(/SequenceEnrollment_status_nextStepAt_idx/);
  });
});

describe('approval queue', () => {
  async function reviewEmails(U, count = 1, { step = { aiMode: 'review', aiBrief: 'Intro' }, steps } = {}) {
    const seq = await aiSequence(U.user.id, steps || [step]);
    const cs = [];
    for (let i = 0; i < count; i++) cs.push(await makeCarrier(U.user.id));
    await enrollCarriers(await fullUser(U.user.id), seq.id, cs);
    await runAiSequenceEmails(later(), quiet);
    return { seq, emails: await prisma.email.findMany({ where: { carrierId: { in: cs.map((c) => c.id) } }, orderBy: { createdAt: 'asc' } }) };
  }

  it('lists only the caller\'s waiting emails and keeps other users out (404)', async () => {
    const A = await registerUser();
    const B = await registerUser();
    await connect(A.agent);
    await connect(B.agent);
    const { emails: [e] } = await reviewEmails(A);
    const list = await A.agent.get('/api/email/review?pageSize=10');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ id: e.id, aiGenerated: true, status: 'review', sequence: { ended: false } });
    expect((await B.agent.get('/api/email/review')).body.total).toBe(0);
    expect((await B.agent.post(`/api/email/messages/${e.id}/approve`).send({})).status).toBe(404);
    expect((await B.agent.post(`/api/email/messages/${e.id}/reject`)).status).toBe(404);
    expect((await prisma.email.findUnique({ where: { id: e.id } })).status).toBe('review');
  });

  it('approve & send moves an edited email to scheduled now; a second approve is a conflict', async () => {
    const A = await registerUser();
    await connect(A.agent);
    const { emails: [e] } = await reviewEmails(A);
    const res = await A.agent.post(`/api/email/messages/${e.id}/approve`).send({ subject: 'Edited subject', body: 'Edited body' });
    expect(res.status).toBe(200);
    const row = await prisma.email.findUnique({ where: { id: e.id } });
    expect(row).toMatchObject({ status: 'scheduled', subject: 'Edited subject', body: 'Edited body', aiGenerated: true });
    expect(row.scheduledAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await A.agent.post(`/api/email/messages/${e.id}/approve`).send({})).status).toBe(409);
    await runFastTick({ quiet: true });
    expect((await prisma.email.findUnique({ where: { id: e.id } })).status).toBe('sent');
  });

  it('approve checks the plan\'s daily email limit again', async () => {
    const A = await registerUser();
    const acc = await connect(A.agent);
    const { emails: [e] } = await reviewEmails(A);
    const free = await prisma.plan.findUnique({ where: { key: 'free' } });
    await prisma.email.createMany({ data: Array.from({ length: free.dailyEmailLimit }, (_, i) => ({ userId: A.user.id, emailAccountId: acc.id, toEmail: `x${i}@sent.test`, subject: 's', body: 'b', status: 'sent', sentAt: new Date() })) });
    const res = await A.agent.post(`/api/email/messages/${e.id}/approve`).send({});
    expect(res.status).toBe(402);
    expect((await prisma.email.findUnique({ where: { id: e.id } })).status).toBe('review');
    expect((await A.agent.post('/api/email/review/approve-bulk').send({ ids: [e.id] })).status).toBe(402);
  });

  it('reject cancels the email, stops the carrier\'s run and cancels its other waiting emails', async () => {
    const A = await registerUser();
    await connect(A.agent);
    const steps = [{ aiMode: 'review', aiBrief: 'Intro' }, { aiMode: 'review', aiBrief: 'Follow up' }, { type: 'call', dayOffset: 3, instructions: 'Call' }];
    const { seq, emails: [e] } = await reviewEmails(A, 1, { steps });
    await runAiSequenceEmails(later(), quiet); // step 2 (also due today) waits for approval too
    const waiting = await prisma.email.findMany({ where: { enrollment: { sequenceId: seq.id } } });
    expect(waiting.map((w) => w.status)).toEqual(['review', 'review']);
    const res = await A.agent.post(`/api/email/messages/${e.id}/reject`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stopped: 1, canceled: 1 });
    expect((await A.agent.post(`/api/email/messages/${e.id}/reject`)).status).toBe(409);
    const after = await prisma.email.findMany({ where: { enrollment: { sequenceId: seq.id } } });
    expect(after.every((x) => x.status === 'canceled')).toBe(true);
    const enr = await prisma.sequenceEnrollment.findFirst({ where: { sequenceId: seq.id } });
    expect(enr).toMatchObject({ status: 'stopped', stopReason: 'email_rejected' });
  });

  it('refuses to approve after the carrier replied, also when the run already completed', async () => {
    const A = await registerUser();
    await connect(A.agent);
    const reply = async (carrierId) => {
      const sent = await prisma.email.create({ data: { userId: A.user.id, carrierId, toEmail: 'x@carrier.test', subject: 'Earlier', body: 'b', status: 'sent', sentAt: new Date() } });
      expect((await A.agent.post(`/api/email/messages/${sent.id}/replied`)).status).toBe(200);
    };
    // Run still going (a call step follows): the reply stops it.
    const { emails: [running] } = await reviewEmails(A, 1, { steps: [{ aiMode: 'review', aiBrief: 'Intro' }, { type: 'call', dayOffset: 3, instructions: 'Call' }] });
    await reply(running.carrierId);
    const res = await A.agent.post(`/api/email/messages/${running.id}/approve`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/sequence ended \(replied\)/);
    // Last step: the run completed when the email was written; the reply itself blocks it.
    const { emails: [last] } = await reviewEmails(A);
    expect((await prisma.sequenceEnrollment.findUnique({ where: { id: last.enrollmentId } })).status).toBe('completed');
    await reply(last.carrierId);
    expect((await A.agent.post(`/api/email/messages/${last.id}/approve`).send({})).status).toBe(409);
    const list = (await A.agent.get('/api/email/review')).body.items;
    expect(list.map((x) => x.sequence.endedReason)).toEqual(['replied', 'replied']);
    const bulk = await A.agent.post('/api/email/review/approve-bulk').send({ ids: [running.id, last.id] });
    expect(bulk.body.approved).toBe(0);
  });

  it('bulk approve sends what it can and says why the rest stayed', async () => {
    const A = await registerUser();
    const B = await registerUser();
    await connect(A.agent);
    await connect(B.agent);
    const { emails } = await reviewEmails(A, 2);
    ai.chat.mockRejectedValue(aiError(503, 'AI_NOT_CONFIGURED'));
    const { emails: [noted] } = await reviewEmails(A, 1, { step: { aiMode: 'auto', aiBrief: 'Write me' } });
    const { emails: [foreign] } = await (async () => { ai.chat.mockImplementation(writes()); return reviewEmails(B); })();
    const res = await A.agent.post('/api/email/review/approve-bulk').send({ ids: [...emails.map((x) => x.id), noted.id, foreign.id] });
    expect(res.status).toBe(200);
    expect(res.body.approved).toBe(2);
    expect(res.body.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: noted.id, reason: expect.stringMatching(/Needs writing/) }),
      expect.objectContaining({ id: foreign.id, reason: 'Not waiting for approval' }),
    ]));
    for (const x of emails) expect((await prisma.email.findUnique({ where: { id: x.id } })).status).toBe('scheduled');
    expect((await prisma.email.findUnique({ where: { id: foreign.id } })).status).toBe('review');
    expect((await A.agent.post('/api/email/review/approve-bulk').send({ ids: Array.from({ length: 101 }, (_, i) => `id${i}`) })).status).toBe(400);
  });
});

describe('sequence editor API', () => {
  const base = { name: 'AI sequence', active: true, respectBusinessHours: false, windowStartHour: 9, windowEndHour: 17, skipWeekends: true, maxEmailsPerDay: 50 };

  it('validates and stores aiMode and aiBrief and keeps step ids on edit', async () => {
    const A = await registerUser();
    const missing = await A.agent.post('/api/sequences').send({ ...base, steps: [{ dayOffset: 0, type: 'email', aiMode: 'auto' }] });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/Step 1: describe what the AI email should say/);
    const long = await A.agent.post('/api/sequences').send({ ...base, steps: [{ dayOffset: 0, type: 'email', aiMode: 'auto', aiBrief: 'x'.repeat(1001) }] });
    expect(long.status).toBe(400);
    const created = await A.agent.post('/api/sequences').send({ ...base, steps: [
      { dayOffset: 0, type: 'email', aiMode: 'review', aiBrief: 'Intro my service' },
      { dayOffset: 1, type: 'call', instructions: 'Call', aiMode: 'auto', aiBrief: 'ignored' },
    ] });
    expect(created.status).toBe(201);
    const [s1, s2] = created.body.sequence.steps;
    expect(s1).toMatchObject({ aiMode: 'review', aiBrief: 'Intro my service', subject: null });
    expect(s2).toMatchObject({ aiMode: null, aiBrief: null });
    const edited = await A.agent.put(`/api/sequences/${created.body.sequence.id}`).send({ ...base, steps: [
      { id: s1.id, dayOffset: 0, type: 'email', aiMode: 'off', aiBrief: 'Intro my service', subject: 'Hi {{company}}', body: 'Template' },
      { id: s2.id, dayOffset: 1, type: 'call', instructions: 'Call' },
    ] });
    expect(edited.status).toBe(200);
    expect(edited.body.sequence.steps[0]).toMatchObject({ id: s1.id, aiMode: null, aiBrief: 'Intro my service' });
    const noFallback = await A.agent.put(`/api/sequences/${created.body.sequence.id}`).send({ ...base, steps: [{ id: s1.id, dayOffset: 0, type: 'email', aiMode: 'off' }] });
    expect(noFallback.status).toBe(400);
  });

  it('previews an AI step for a carrier (one AI call) and keeps other users\' carriers out', async () => {
    const A = await registerUser();
    const B = await registerUser();
    const seq = await aiSequence(A.user.id, [{ aiMode: 'auto', aiBrief: 'Intro my service' }, { type: 'call', instructions: 'Call' }]);
    const c = await makeCarrier(A.user.id, { mcNumber: '123321' });
    const res = await A.agent.post(`/api/sequences/${seq.id}/steps/${seq.steps[0].id}/ai-preview`).send({ carrierId: c.id, aiBrief: 'Edited brief, not saved yet' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ subject: `Dispatch help for ${c.companyName}` });
    expect(res.body.body).toContain(c.companyName);
    expect(ai.chat).toHaveBeenCalledTimes(1);
    expect(ai.chat.mock.calls[0][1]).toMatchObject({ purpose: 'sequence_email' });
    expect(ai.chat.mock.calls[0][0][1].content).toContain('Edited brief, not saved yet');
    expect(ai.chat.mock.calls[0][0][1].content).toContain('123321');

    const foreign = await makeCarrier(B.user.id);
    expect((await A.agent.post(`/api/sequences/${seq.id}/steps/${seq.steps[0].id}/ai-preview`).send({ carrierId: foreign.id })).status).toBe(404);
    expect((await B.agent.post(`/api/sequences/${seq.id}/steps/${seq.steps[0].id}/ai-preview`).send({ carrierId: foreign.id })).status).toBe(404);
    expect((await A.agent.post(`/api/sequences/${seq.id}/steps/${seq.steps[1].id}/ai-preview`).send({ carrierId: c.id })).status).toBe(400);
    ai.chat.mockRejectedValueOnce(aiError(503, 'AI_NOT_CONFIGURED'));
    expect((await A.agent.post(`/api/sequences/${seq.id}/steps/${seq.steps[0].id}/ai-preview`).send({ carrierId: c.id })).status).toBe(503);
  });

  it('the prompt builder leaves out missing facts instead of guessing', () => {
    const [, user] = buildSequenceEmailPrompt({ brief: 'Intro', carrier: { companyName: 'Solo LLC', contacts: [] }, user: { name: 'Dana' } });
    expect(user.content).toContain('Company: Solo LLC');
    expect(user.content).not.toMatch(/MC number|Contact first name|Fleet size/);
    expect(user.content).toMatch(/none, this is the first email/);
  });
});
