import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mail = vi.hoisted(() => ({
  sendMail: vi.fn(async (m) => ({ messageId: m?.messageId || '<neg@test>', accepted: [m?.to], rejected: [] })),
}));
vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => ({ verify: async () => true, sendMail: mail.sendMail, close: () => {} }));
  return { default: { createTransport }, createTransport };
});

// The AI is always mocked: drafts and classifications come from these queues (an Error item is thrown).
const ai = vi.hoisted(() => ({ drafts: [], classes: [], calls: [] }));
vi.mock('../src/services/ai/llm.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    chat: async (messages, opts = {}) => {
      ai.calls.push({ messages, opts });
      const classify = /Classify it/.test(messages[0]?.content || '');
      const next = (classify ? ai.classes : ai.drafts).shift()
        ?? (classify ? { intent: 'other', cents: null, summary: 'Unclear' } : { subject: 'Dallas to Atlanta load', body: 'Hi Sam,\n\nCan you do {{RATE}} all in?\n\nThanks', counterCents: null });
      if (next instanceof Error) throw next;
      return JSON.stringify(next);
    },
  };
});

const { app, registerUser, prisma } = await import('./helpers.js');
const { HttpError } = await import('../src/lib/errors.js');
const rules = await import('../src/services/negotiation/rules.js');
const { recordReply } = await import('../src/services/email/replies.js');
const { jobs } = await import('../src/jobs/extra/negotiations.js');

const LANE = { originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', miles: 800, deadheadMiles: 50, pickupDate: '2026-11-20', equipment: 'dry_van', reference: 'R-77' };
const aiDown = () => new HttpError(503, 'AI is not set up', { code: 'AI_NOT_CONFIGURED' });
const aiQuota = () => new HttpError(429, 'AI limit reached for this month', { code: 'AI_QUOTA' });
let n = 0;

/**
 * A dispatcher with a mailbox, a broker with an email and a customer carrier whose rules give a walk-away of
 * $1,800 for 800 loaded miles (min $2.25/mi beats cost $1.50/mi x 850 mi = $1,275).
 */
async function setup() {
  n += 1;
  const U = await registerUser();
  const box = await U.agent.post('/api/email/accounts/smtp').send({ provider: 'hostinger', fromEmail: `neg${Date.now()}${n}@dispatch.test`, password: 'pw', dailyLimit: 500, cooldownSeconds: 0 });
  expect(box.status).toBe(201);
  const broker = (await U.agent.post('/api/brokers').send({ companyName: `Summit Logistics ${n}`, email: `loads${n}@summit.test`, contactName: 'Sam Reyes' })).body.broker;
  const stage = await prisma.pipelineStage.findUnique({ where: { key: 'customer' } }) || await prisma.pipelineStage.findFirst();
  const carrier = await prisma.carrier.create({ data: { ownerId: U.user.id, stageId: stage.id, companyName: `Blue Line ${n}`, mcNumber: `55${n}000`, equipment: 'dry_van' } });
  await prisma.customer.create({ data: { carrierId: carrier.id, ownerId: U.user.id, minRatePerMile: 2.25, costPerMileCents: 150 } });
  return { ...U, broker, carrier };
}

async function start(U, body = {}) {
  return U.agent.post('/api/negotiations').send({ brokerId: U.broker.id, carrierId: U.carrier.id, lane: LANE, offerCents: 190000, ...body });
}

/** Start and send the opening counter ($2,100): status active, rounds 1 (the send is cleared from the mail mock). */
async function opened(U, body = {}) {
  const s = await start(U, body);
  expect(s.status).toBe(201);
  const a = await U.agent.post(`/api/negotiations/${s.body.negotiation.id}/approve`).send({});
  expect(a.status).toBe(200);
  mail.sendMail.mockClear();
  return a.body.negotiation;
}

beforeEach(() => {
  mail.sendMail.mockClear();
  ai.drafts.length = 0;
  ai.classes.length = 0;
  ai.calls.length = 0;
});

describe('negotiation rules', () => {
  it('builds the limits: floor from carrier rules, target never below the floor', () => {
    expect(rules.computeLimits({ offerCents: 190000, walkAwayCents: 180000 })).toEqual({ floorCents: 180000, targetCents: 210000, floorBasis: 'carrier_rules', targetBasis: 'offer_plus_10' });
    // The lane average wins when it is higher; the floor wins over both.
    expect(rules.computeLimits({ offerCents: 190000, walkAwayCents: 180000, laneAvgCents: 230000 })).toMatchObject({ targetCents: 230000, targetBasis: 'lane_average' });
    expect(rules.computeLimits({ offerCents: 150000, walkAwayCents: 200000 })).toMatchObject({ targetCents: 200000, targetBasis: 'floor' });
    expect(rules.computeLimits({ offerCents: 190000, floorCents: 170000, walkAwayCents: 180000 })).toMatchObject({ floorCents: 170000, floorBasis: 'manual' });
    expect(rules.computeLimits({ offerCents: 190000 }).error).toMatch(/walk-away/);
    expect(rules.computeLimits({ offerCents: 190000, floorCents: 200000, targetCents: 195000 }).error).toMatch(/below the walk-away/);
    expect(rules.computeLimits({ offerCents: 190000, floorCents: 150000, targetCents: 185000 }).error).toMatch(/Book it at the offered rate/);
    expect(rules.computeLimits({ offerCents: 1900.5, floorCents: 150000 }).error).toMatch(/whole number/);
    expect(rules.round25(198000)).toBe(197500);
  });

  it('decides the next step in code', () => {
    const base = { floorCents: 180000, targetCents: 210000, lastCounterCents: 210000, rounds: 1, maxRounds: 3 };
    expect(rules.decide({ ...base, intent: 'accept' })).toMatchObject({ kind: 'accept', cents: 210000 });
    expect(rules.decide({ ...base, intent: 'counter', cents: 185000 })).toMatchObject({ kind: 'accept', cents: 185000 });
    expect(rules.decide({ ...base, intent: 'counter', cents: 170000 })).toMatchObject({ kind: 'counter', cents: 190000 });
    expect(rules.decide({ ...base, intent: 'counter', cents: 120000 })).toMatchObject({ kind: 'counter', cents: 180000 }); // never below the floor
    expect(rules.decide({ ...base, rounds: 3, intent: 'counter', cents: 170000 })).toMatchObject({ kind: 'walk_away', reason: 'rounds' });
    expect(rules.decide({ ...base, intent: 'decline' })).toMatchObject({ kind: 'walk_away', reason: 'declined' });
    expect(rules.decide({ ...base, intent: 'question' })).toMatchObject({ kind: 'answer' });
    expect(rules.decide({ ...base, intent: 'counter' })).toMatchObject({ kind: 'review' });
    expect(rules.amountsIn('Can you do $2,150 or $2.1k? Not $1,999.50')).toEqual([215000, 210000, 199950]);
    expect(rules.cleanClassification({ intent: 'counter', cents: 250, summary: 'x' })).toMatchObject({ intent: 'counter', cents: null });
    expect(rules.cleanClassification({ intent: 'hack' }).intent).toBe('other');
  });
});

describe('negotiations API', () => {
  it('starts with the floor from carrier rules and drafts the opening email for approval', async () => {
    const U = await setup();
    const res = await start(U);
    expect(res.status).toBe(201);
    const neg = res.body.negotiation;
    expect(neg).toMatchObject({ status: 'draft', mode: 'approve', floorCents: 180000, targetCents: 210000, offerCents: 190000, rounds: 0, maxRounds: 3, toEmail: U.broker.email });
    expect(res.body.limits).toMatchObject({ floorBasis: 'carrier_rules', walkAwayBasis: 'min_rpm' });
    expect(neg.nextAction).toMatchObject({ kind: 'counter', cents: 210000, aiWritten: true });
    expect(res.body.email).toMatchObject({ status: 'review', aiGenerated: true });
    expect(res.body.email.body).toContain('$2,100');
    const row = await prisma.email.findUnique({ where: { id: res.body.email.id } });
    expect(row.negotiationId).toBe(neg.id);
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(ai.calls[0].opts).toMatchObject({ purpose: 'negotiation', json: true });
    expect(ai.calls[0].opts.user.id).toBe(U.user.id);
    // One open negotiation per load is enforced; the defaults endpoint shows the same numbers.
    const d = await U.agent.get('/api/negotiations/defaults').query({ carrierId: U.carrier.id, miles: 800, deadheadMiles: 50, originState: 'TX', destState: 'GA', offerCents: 190000 });
    expect(d.body).toMatchObject({ floorCents: 180000, targetCents: 210000, rulesSet: true });
  });

  it('clamps the AI counter to the limits and drops AI text with invented amounts', async () => {
    const U = await setup();
    ai.drafts.push({ subject: 'Load', body: 'Hi Sam, can you do {{RATE}}?', counterCents: 9_999_999 });
    const high = await start(U);
    expect(high.body.negotiation.nextAction.cents).toBe(210000);
    expect(high.body.email.body).toContain('$2,100');

    const V = await setup();
    ai.drafts.push({ subject: 'Load', body: 'Hi Sam, can you do {{RATE}}?', counterCents: 100 });
    const low = await start(V);
    expect(low.body.negotiation.nextAction.cents).toBe(180000);

    const W = await setup();
    ai.drafts.push({ subject: 'Load', body: 'Market is at $2,600 on this lane, so {{RATE}} is fair.', counterCents: 210000 });
    const made = await start(W);
    expect(made.body.negotiation.nextAction).toMatchObject({ cents: 210000, aiWritten: false });
    expect(made.body.email.body).not.toContain('$2,600');
    expect(made.body.note).toMatch(/standard message/);
  });

  it('approves: sends the waiting email with the negotiation id; edits stay inside the limits', async () => {
    const U = await setup();
    const s = await start(U);
    const id = s.body.negotiation.id;
    const out = await U.agent.post(`/api/negotiations/${id}/approve`).send({ cents: 250000 });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/between \$1,800 and \$2,100/);
    const ok = await U.agent.post(`/api/negotiations/${id}/approve`).send({ cents: 205000 });
    expect(ok.status).toBe(200);
    expect(ok.body.negotiation).toMatchObject({ status: 'active', rounds: 1, lastCounterCents: 205000, nextAction: null });
    const sent = await prisma.email.findUnique({ where: { id: s.body.email.id } });
    expect(sent).toMatchObject({ status: 'sent', negotiationId: id, aiGenerated: true });
    expect(sent.body).toContain('$2,050');
    expect(sent.body).not.toContain('$2,100');
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(ok.body.emails.map((e) => e.status)).toEqual(['sent']);
    expect(ok.body.negotiation.history.map((h) => h.kind)).toEqual(['start', 'proposal', 'sent']);
  });

  it('reads broker replies: accept and counters at or above the floor wait for review, never booked', async () => {
    const U = await setup();
    const neg = await opened(U);
    ai.classes.push({ intent: 'counter', cents: 185000, summary: 'They offer $1,850' });
    const r1 = await U.agent.post(`/api/negotiations/${neg.id}/reply`).send({ text: 'Best I can do is 1850.' });
    expect(r1.status).toBe(200);
    expect(r1.body.negotiation).toMatchObject({ status: 'needs_review', offerCents: 185000, nextAction: { kind: 'accept', cents: 185000 } });
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(await prisma.load.count({ where: { ownerId: U.user.id } })).toBe(0);

    ai.classes.push({ intent: 'accept', cents: null, summary: 'Agreed' });
    const r2 = await U.agent.post(`/api/negotiations/${neg.id}/reply`).send({ text: 'Ok, 2100 works.' });
    expect(r2.body.negotiation.nextAction).toMatchObject({ kind: 'accept', cents: 210000 });
    expect(await prisma.load.count({ where: { ownerId: U.user.id } })).toBe(0);
  });

  it('counters below the floor between their number and ours, then walks away when rounds run out', async () => {
    const U = await setup();
    const neg = await opened(U, { maxRounds: 2 });
    ai.classes.push({ intent: 'counter', cents: 170000, summary: 'They offer $1,700' });
    ai.drafts.push({ body: 'Hi Sam,\n\nWe can come down to {{RATE}} from our side; you offered {{OFFER}}.\n\nThanks' });
    const r1 = await U.agent.post(`/api/negotiations/${neg.id}/reply`).send({ text: 'Can do 1700' });
    expect(r1.body.negotiation).toMatchObject({ status: 'needs_review', nextAction: { kind: 'counter', cents: 190000 } });
    const draft = r1.body.emails.find((e) => e.status === 'review');
    expect(draft.body).toContain('$1,900');
    expect(draft.body).toContain('$1,700');
    expect(mail.sendMail).not.toHaveBeenCalled();
    const sent = await U.agent.post(`/api/negotiations/${neg.id}/approve`).send({});
    expect(sent.body.negotiation).toMatchObject({ status: 'active', rounds: 2, lastCounterCents: 190000 });

    ai.classes.push({ intent: 'counter', cents: 175000, summary: 'They offer $1,750' });
    const r2 = await U.agent.post(`/api/negotiations/${neg.id}/reply`).send({ text: '1750 final' });
    expect(r2.body.negotiation.nextAction).toMatchObject({ kind: 'walk_away' });
    expect(r2.body.negotiation.nextAction.reason).toMatch(/all 2 rounds/);

    ai.classes.push({ intent: 'question', cents: null, summary: 'Asks for the MC number' });
    ai.drafts.push({ body: 'Hi Sam,\n\nWe will confirm the MC number and reply shortly.\n\nThanks' });
    const q = await U.agent.post(`/api/negotiations/${neg.id}/reply`).send({ text: 'What is your MC?' });
    expect(q.body.negotiation.nextAction).toMatchObject({ kind: 'answer', aiWritten: true });
    // The walk-away draft it replaced was canceled, never sent.
    expect(q.body.emails.filter((e) => e.status === 'canceled')).toHaveLength(1);

    ai.classes.push({ intent: 'decline', cents: null, summary: 'Load covered' });
    const d = await U.agent.post(`/api/negotiations/${neg.id}/reply`).send({ text: 'Covered, thanks' });
    expect(d.body.negotiation.nextAction).toMatchObject({ kind: 'walk_away' });
    const w = await U.agent.post(`/api/negotiations/${neg.id}/walk-away`).send({ sendEmail: true });
    expect(w.body.negotiation.status).toBe('walked_away');
    expect(mail.sendMail).toHaveBeenCalledTimes(2);
    expect((await U.agent.post(`/api/negotiations/${neg.id}/approve`).send({})).status).toBe(409);
  });

  it('auto mode sends counters inside the limits and never accepts', async () => {
    const U = await setup();
    const s = await start(U, { mode: 'auto' });
    expect(s.body.negotiation.status).toBe('draft'); // the opening email always waits
    expect(mail.sendMail).not.toHaveBeenCalled();
    await U.agent.post(`/api/negotiations/${s.body.negotiation.id}/approve`).send({});
    mail.sendMail.mockClear();
    const id = s.body.negotiation.id;

    ai.classes.push({ intent: 'counter', cents: 170000, summary: 'They offer $1,700' });
    const r1 = await U.agent.post(`/api/negotiations/${id}/reply`).send({ text: '1700?' });
    expect(r1.body.autoSent).toBe(true);
    expect(r1.body.negotiation).toMatchObject({ status: 'active', rounds: 2, lastCounterCents: 190000, nextAction: null });
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(r1.body.negotiation.history.at(-1)).toMatchObject({ kind: 'sent', auto: true, from: 'ai', cents: 190000 });
    const auto = await prisma.email.findFirst({ where: { negotiationId: id, status: 'sent' }, orderBy: { createdAt: 'desc' } });
    expect(auto).toMatchObject({ aiGenerated: true });

    // AI text that fails while writing a counter: it waits instead of going out.
    ai.classes.push({ intent: 'counter', cents: 175000, summary: 'They offer $1,750' });
    ai.drafts.push(aiDown());
    const r2 = await U.agent.post(`/api/negotiations/${id}/reply`).send({ text: '1750?' });
    expect(r2.body.autoSent).toBe(false);
    // Halfway between $1,750 and our $1,900, rounded to $25.
    expect(r2.body.negotiation.nextAction).toMatchObject({ kind: 'counter', cents: 182500, aiWritten: false });
    expect(mail.sendMail).toHaveBeenCalledTimes(1);

    ai.classes.push({ intent: 'counter', cents: 182500, summary: 'They offer $1,825' });
    const r3 = await U.agent.post(`/api/negotiations/${id}/reply`).send({ text: '1825 and we are done' });
    expect(r3.body.negotiation).toMatchObject({ status: 'needs_review', nextAction: { kind: 'accept', cents: 182500 } });
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(await prisma.load.count({ where: { ownerId: U.user.id } })).toBe(0);
  });

  it('accept & book creates a booked load at the agreed rate and confirms by email', async () => {
    const U = await setup();
    const neg = await opened(U);
    ai.classes.push({ intent: 'counter', cents: 195000, summary: 'They offer $1,950' });
    await U.agent.post(`/api/negotiations/${neg.id}/reply`).send({ text: '1950' });
    expect((await U.agent.post(`/api/negotiations/${neg.id}/accept-book`).send({ cents: 150000 })).status).toBe(400); // below the floor
    mail.sendMail.mockClear();
    const res = await U.agent.post(`/api/negotiations/${neg.id}/accept-book`).send({});
    expect(res.status).toBe(200);
    expect(res.body.negotiation).toMatchObject({ status: 'agreed', agreedCents: 195000, nextAction: null });
    const load = await prisma.load.findUnique({ where: { id: res.body.load.id } });
    expect(load).toMatchObject({
      ownerId: U.user.id, status: 'booked', rateCents: 195000, brokerId: U.broker.id, carrierId: U.carrier.id,
      originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', loadedMiles: 800, deadheadMiles: 50, equipment: 'dry_van', referenceNumber: 'R-77',
      pickupTz: 'America/Chicago', deliveryTz: 'America/New_York',
    });
    expect(res.body.negotiation.loadId).toBe(load.id);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    const confirm = await prisma.email.findFirst({ where: { negotiationId: neg.id }, orderBy: { createdAt: 'desc' } });
    expect(confirm).toMatchObject({ status: 'sent', aiGenerated: true });
    expect(confirm.body).toContain('$1,950');
    expect((await U.agent.post(`/api/negotiations/${neg.id}/cancel`).send({})).status).toBe(409);
  });

  it('accept & book on a linked load books that load', async () => {
    const U = await setup();
    const created = await U.agent.post('/api/loads').send({ brokerId: U.broker.id, carrierId: U.carrier.id, originCity: 'Tulsa', originState: 'OK', destCity: 'Wichita', destState: 'KS', loadedMiles: 180, rateCents: 60000 });
    expect(created.status).toBe(201);
    const s = await U.agent.post('/api/negotiations').send({ loadId: created.body.load.id, floorCents: 55000, targetCents: 75000 });
    expect(s.status).toBe(201);
    expect(s.body.negotiation).toMatchObject({ brokerId: U.broker.id, carrierId: U.carrier.id, offerCents: 60000, loadId: created.body.load.id });
    expect((await U.agent.post('/api/negotiations').send({ loadId: created.body.load.id, floorCents: 55000 })).status).toBe(409);
    await U.agent.post(`/api/negotiations/${s.body.negotiation.id}/approve`).send({});
    await U.agent.post(`/api/negotiations/${s.body.negotiation.id}/reply`).send({ intent: 'accept', cents: 72500 });
    const res = await U.agent.post(`/api/negotiations/${s.body.negotiation.id}/approve`).send({});
    expect(res.status).toBe(200);
    expect(res.body.negotiation.status).toBe('agreed');
    const load = await prisma.load.findUnique({ where: { id: created.body.load.id } });
    expect(load).toMatchObject({ status: 'booked', rateCents: 72500 });
    expect(await prisma.load.count({ where: { ownerId: U.user.id } })).toBe(1);
  });

  it('keeps working by hand when the AI is down or over quota', async () => {
    const U = await setup();
    ai.drafts.push(aiDown());
    const s = await start(U);
    expect(s.status).toBe(201);
    expect(s.body.aiError).toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    expect(s.body.negotiation.nextAction).toMatchObject({ kind: 'counter', cents: 210000, aiWritten: false });
    expect(s.body.email.body).toContain('$2,100');
    const id = s.body.negotiation.id;
    expect((await U.agent.post(`/api/negotiations/${id}/approve`).send({})).body.negotiation.status).toBe('active');

    ai.classes.push(aiQuota());
    const r = await U.agent.post(`/api/negotiations/${id}/reply`).send({ text: 'We can do 1700.' });
    expect(r.status).toBe(200);
    expect(r.body.aiError).toMatchObject({ code: 'AI_QUOTA' });
    expect(r.body.negotiation).toMatchObject({ status: 'needs_review', nextAction: null });
    ai.drafts.push(aiQuota());
    const manual = await U.agent.post(`/api/negotiations/${id}/reply`).send({ intent: 'counter', cents: 170000 });
    expect(manual.body.negotiation.nextAction).toMatchObject({ kind: 'counter', cents: 190000, aiWritten: false });
    const c = await U.agent.post(`/api/negotiations/${id}/counter`).send({ cents: 200000 });
    expect(c.body.negotiation.nextAction).toMatchObject({ kind: 'counter', cents: 200000 });
    expect((await U.agent.post(`/api/negotiations/${id}/counter`).send({ cents: 250000 })).status).toBe(400);
  });

  it('PATCH validates the limits and drops a waiting counter outside them', async () => {
    const U = await setup();
    const s = await start(U);
    const id = s.body.negotiation.id;
    expect((await U.agent.patch(`/api/negotiations/${id}`).send({ floorCents: 220000 })).status).toBe(400);
    const p = await U.agent.patch(`/api/negotiations/${id}`).send({ targetCents: 200000, mode: 'auto', maxRounds: 4 });
    expect(p.status).toBe(200);
    expect(p.body.negotiation).toMatchObject({ targetCents: 200000, mode: 'auto', maxRounds: 4, nextAction: null, status: 'draft' });
    expect((await prisma.email.findUnique({ where: { id: s.body.email.id } })).status).toBe('canceled');
  });

  it('syncs a proposal approved in the Email center', async () => {
    const U = await setup();
    const s = await start(U);
    await prisma.email.update({ where: { id: s.body.email.id }, data: { status: 'sent', sentAt: new Date() } });
    const g = await U.agent.get(`/api/negotiations/${s.body.negotiation.id}`);
    expect(g.body.negotiation).toMatchObject({ status: 'active', rounds: 1, lastCounterCents: 210000, nextAction: null });
  });

  it('routes a broker reply detected by email reply detection to the negotiation', async () => {
    const U = await setup();
    const neg = await opened(U);
    const user = await prisma.user.findUnique({ where: { id: U.user.id }, include: { teamMembership: true } });
    const email = await prisma.email.findFirst({ where: { negotiationId: neg.id, status: 'sent' } });
    // Headers only (what the IMAP poller has today): flagged for review, the dispatcher is asked to paste it.
    await recordReply({ user, email, fromEmail: U.broker.email, subject: 'Re: Dallas to Atlanta load' });
    let row = await prisma.negotiation.findUnique({ where: { id: neg.id } });
    expect(row.status).toBe('needs_review');
    expect(JSON.parse(row.history).at(-1)).toMatchObject({ from: 'broker', kind: 'reply', source: 'email', noBody: true });
    // With the reply text it is read like a pasted reply.
    ai.classes.push({ intent: 'counter', cents: 200000, summary: 'They offer $2,000' });
    await recordReply({ user, email, fromEmail: U.broker.email, subject: 'Re: Dallas to Atlanta load', text: 'We can do $2,000.' });
    row = await prisma.negotiation.findUnique({ where: { id: neg.id } });
    expect(JSON.parse(row.nextAction)).toMatchObject({ kind: 'accept', cents: 200000 });
    const notes = await prisma.notification.findMany({ where: { userId: U.user.id, link: { contains: neg.id } } });
    expect(notes.map((x) => x.title)).toContain(`${U.broker.companyName} is at $2,000: review and book`);
  });

  it('flags negotiations with no broker reply for 48 hours, once', async () => {
    const U = await setup();
    const neg = await opened(U);
    const later = new Date(Date.now() + 49 * 3600_000);
    const job = jobs.find((j) => j.name === 'negotiations-stale');
    expect(job.everyMs).toBe(30 * 60_000);
    await job.run(new Date(Date.now() + 47 * 3600_000));
    expect((await prisma.negotiation.findUnique({ where: { id: neg.id } })).status).toBe('active');
    const out = await job.run(later);
    expect(out.marked).toBeGreaterThanOrEqual(1);
    const row = await prisma.negotiation.findUnique({ where: { id: neg.id } });
    expect(row.status).toBe('needs_review');
    expect(JSON.parse(row.history).at(-1)).toMatchObject({ kind: 'no_reply' });
    await job.run(new Date(later.getTime() + 3600_000));
    expect(await prisma.notification.count({ where: { userId: U.user.id, type: 'negotiation' } })).toBe(1);
  });

  it('isolates owners and refuses API tokens on writes', async () => {
    const U = await setup();
    const B = await registerUser();
    const s = await start(U);
    const id = s.body.negotiation.id;
    expect((await B.agent.get(`/api/negotiations/${id}`)).status).toBe(404);
    expect((await B.agent.post(`/api/negotiations/${id}/approve`).send({})).status).toBe(404);
    expect((await B.agent.post(`/api/negotiations/${id}/reply`).send({ text: 'hi' })).status).toBe(404);
    expect((await B.agent.patch(`/api/negotiations/${id}`).send({ mode: 'auto' })).status).toBe(404);
    expect((await B.agent.post('/api/negotiations').send({ brokerId: U.broker.id, lane: LANE, floorCents: 100000 })).status).toBe(404);
    expect((await B.agent.get('/api/negotiations')).body.items).toEqual([]);
    const list = await U.agent.get('/api/negotiations').query({ brokerId: U.broker.id, status: 'open' });
    expect(list.body.items.map((i) => i.id)).toEqual([id]);

    const { body } = await U.agent.post('/api/tokens').send({ name: 'ext', expiresInDays: 30 });
    const auth = { Authorization: `Bearer ${body.token}` };
    expect((await request(app).get(`/api/negotiations/${id}`).set(auth)).status).toBe(200);
    expect((await request(app).post(`/api/negotiations/${id}/approve`).set(auth).send({})).status).toBe(403);
    expect((await request(app).post('/api/negotiations').set(auth).send({ brokerId: U.broker.id, lane: LANE, floorCents: 100000 })).status).toBe(403);
    expect((await prisma.email.findUnique({ where: { id: s.body.email.id } })).status).toBe('review');
  });
});
