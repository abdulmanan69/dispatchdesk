import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';

const mail = vi.hoisted(() => ({
  sendMail: vi.fn(async (m) => ({ messageId: m?.messageId || '<r@test>', accepted: [m?.to], rejected: [] })),
}));
vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => ({ verify: async () => true, sendMail: mail.sendMail, close: () => {} }));
  return { default: { createTransport }, createTransport };
});

const { app, registerUser, prisma } = await import('./helpers.js');
const { encodePolyline } = await import('../src/services/fleet/polyline.js');
const { clearFinishedGeometry } = await import('../src/jobs/extra/fleet-backfill.js');
const { runCheckCalls } = await import('../src/jobs/extra/checkcalls.js');
const { dueMailboxes, IMAP_LIMITS } = await import('../src/services/email/imap.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { overdueMs, jobLane, JOBS } = await import('../src/jobs/maintenance.js');
const { buildStatement, weekOf } = await import('../src/services/invoices/statements.js');
const { invoiceView, effectiveDueAt } = await import('../src/services/invoices/index.js');
const { measureRoute, projectOnRoute } = await import('../src/services/fleet/progress.js');

const DAY = 86400000;
const GEOMETRY = encodePolyline(Array.from({ length: 400 }, (_, i) => [-96.8 + i * 0.016, 32.78 + i * 0.006]));

async function stageId() {
  return (await prisma.pipelineStage.findUnique({ where: { key: 'lead' } })).id;
}
async function connect(agent) {
  const res = await agent.post('/api/email/accounts/smtp').send({ provider: 'hostinger', fromEmail: `rv${Date.now()}${Math.random().toString(36).slice(2, 6)}@dispatch.test`, password: 'pw', cooldownSeconds: 0 });
  expect(res.status).toBe(201);
}

beforeEach(() => mail.sendMail.mockClear());

describe('stored road polylines', () => {
  let A; let load; let broker; let carrier;
  beforeAll(async () => {
    A = await registerUser();
    broker = (await A.agent.post('/api/brokers').send({ companyName: 'Geo Brokerage' })).body.broker;
    carrier = await prisma.carrier.create({ data: { ownerId: A.user.id, stageId: await stageId(), companyName: 'Geo Carrier' } });
    await A.agent.post('/api/customers').send({ carrierId: carrier.id, dispatchFeePercent: 8 });
    load = await prisma.load.create({
      data: {
        ownerId: A.user.id, brokerId: broker.id, carrierId: carrier.id, originCity: 'Dallas', originState: 'TX', destCity: 'Memphis', destState: 'TN',
        rateCents: 100000, loadedMiles: 450, status: 'in_transit', routeMiles: 452, routeMinutes: 410, routeSource: 'osrm', routeComputedAt: new Date(),
        route: { create: { geometry: GEOMETRY } },
      },
    });
  });

  it('are never part of load, broker or customer API responses', async () => {
    const customer = await prisma.customer.findUnique({ where: { carrierId: carrier.id } });
    const bodies = [
      (await A.agent.get('/api/loads?status=all')).body,
      (await A.agent.get('/api/loads?status=all&sort=rpm')).body,
      (await A.agent.get(`/api/loads/${load.id}`)).body,
      (await A.agent.get(`/api/brokers/${broker.id}`)).body,
      (await A.agent.get(`/api/customers/${customer.id}`)).body,
    ];
    for (const b of bodies) {
      const text = JSON.stringify(b);
      expect(text).toContain(load.id);
      expect(text).not.toContain('routeGeometry');
      expect(text).not.toContain(GEOMETRY.slice(0, 40));
    }
  });

  it('are cleared when the trip is finished, by the status change and by the cleanup job', async () => {
    await A.agent.patch(`/api/loads/${load.id}`).send({ status: 'delivered' });
    const done = await prisma.load.findUnique({ where: { id: load.id }, include: { route: true } });
    expect(done).toMatchObject({ status: 'delivered', route: null, routeMiles: 452 });
    expect(done.deliveryDate).not.toBeNull();
    const other = await prisma.load.create({ data: { ownerId: A.user.id, originCity: 'A', originState: 'TX', destCity: 'B', destState: 'TX', rateCents: 1, loadedMiles: 1, status: 'paid', route: { create: { geometry: GEOMETRY } } } });
    const active = await prisma.load.create({ data: { ownerId: A.user.id, originCity: 'A', originState: 'TX', destCity: 'B', destState: 'TX', rateCents: 1, loadedMiles: 1, status: 'booked', route: { create: { geometry: GEOMETRY } } } });
    const routeOf = async (id) => (await prisma.loadRoute.findUnique({ where: { loadId: id } }))?.geometry ?? null;
    for (let i = 0; i < 20 && (await routeOf(other.id)); i++) await clearFinishedGeometry();
    expect(await routeOf(other.id)).toBeNull();
    expect(await routeOf(active.id)).toBe(GEOMETRY);
    expect((await prisma.load.findUnique({ where: { id: other.id } })).routeGeometry).toBeNull();
  });

  it('packed measured routes still snap positions', () => {
    const route = measureRoute(GEOMETRY);
    expect(route.pts).toBeInstanceOf(Float64Array);
    expect(route.n).toBe(400);
    const snap = projectOnRoute(route, { lat: 32.78 + 200 * 0.006, lng: -96.8 + 200 * 0.016 });
    expect(snap.offMiles).toBeLessThan(0.1);
    expect(snap.fraction).toBeGreaterThan(0.4);
    expect(snap.fraction).toBeLessThan(0.6);
  });
});

describe('check-call reminders', () => {
  it('reach every load of an owner with more loads in transit than one chunk', async () => {
    const A = await registerUser();
    const c = await prisma.carrier.create({ data: { ownerId: A.user.id, stageId: await stageId(), companyName: 'Many Trips Co' } });
    await prisma.load.createMany({ data: Array.from({ length: 7 }, (_, i) => ({ ownerId: A.user.id, carrierId: c.id, originCity: 'Dallas', originState: 'TX', destCity: `City ${i}`, destState: 'TN', rateCents: 1, loadedMiles: 1, status: 'in_transit', updatedAt: new Date(Date.now() - 6 * 3600_000) })) });
    for (let i = 0; i < 40; i++) {
      if (await prisma.notification.count({ where: { userId: A.user.id, type: 'check_call_due' } }) >= 7) break;
      await runCheckCalls(new Date(), { chunk: 5 });
    }
    expect(await prisma.notification.count({ where: { userId: A.user.id, type: 'check_call_due' } })).toBe(7);
  });
});

describe('reply detection scheduling', () => {
  it('mailboxes in back-off never fill the batch ahead of healthy ones', async () => {
    const A = await registerUser();
    const now = new Date();
    const base = { userId: A.user.id, provider: 'smtp', label: 'x', status: 'connected', secretEnc: encrypt('pw'), smtpHost: 'smtp.x.test', imapEnabled: true, imapHost: 'imap.x.test', imapLastUid: 10, lastSentAt: now };
    await prisma.emailAccount.createMany({
      data: Array.from({ length: IMAP_LIMITS.mailboxesPerRun + 5 }, (_, i) => ({ ...base, fromEmail: `stuck${i}@x.test`, imapError: 'Sign-in failed: no', imapCheckedAt: new Date(now.getTime() - 3600_000 - i) })),
    });
    const healthy = await prisma.emailAccount.create({ data: { ...base, fromEmail: 'ok@x.test', imapCheckedAt: new Date(now.getTime() - 20 * 60_000) } });
    const due = await dueMailboxes(now);
    expect(due.some((a) => a.id === healthy.id)).toBe(true);
    expect(due.some((a) => a.fromEmail?.startsWith('stuck'))).toBe(false);
  });
});

describe('maintenance lanes', () => {
  it('orders by how overdue a job is and puts latency-sensitive jobs on the priority lane', () => {
    const now = new Date('2026-11-11T12:00:00Z');
    expect(overdueMs({ everyMs: 60_000 }, new Date(now.getTime() - 90_000), now)).toBe(30_000);
    expect(overdueMs({ everyMs: 60_000 }, new Date(now.getTime() - 30_000), now)).toBeLessThan(0);
    expect(overdueMs({ dailyAtUtc: 3 }, new Date('2026-11-10T03:05:00Z'), now)).toBe(9 * 3600_000);
    expect(overdueMs({ dailyAtUtc: 3 }, new Date('2026-11-11T03:05:00Z'), now)).toBeLessThan(0);
    const lanes = Object.fromEntries(JOBS.map((j) => [j.name, jobLane(j)]));
    expect(lanes).toMatchObject({ 'check-calls': 'priority', 'email-digest': 'priority', 'imap-replies': 'priority' });
    expect(lanes['fleet-routes']).toBe('default');
  });
});

describe('calendar feed', () => {
  it("keeps today's load when the window holds more loads than the cap", async () => {
    const A = await registerUser();
    const now = Date.now();
    await prisma.load.createMany({ data: Array.from({ length: 230 }, (_, i) => ({ ownerId: A.user.id, originCity: 'Reno', originState: 'NV', destCity: 'Boise', destState: 'ID', rateCents: 1, loadedMiles: 1, status: 'booked', pickupDate: new Date(now + (30 + (i % 25)) * DAY) })) });
    await prisma.load.create({ data: { ownerId: A.user.id, referenceNumber: 'TODAY-1', originCity: 'Dallas', originState: 'TX', destCity: 'Austin', destState: 'TX', rateCents: 1, loadedMiles: 1, status: 'booked', pickupDate: new Date(now + 2 * 3600_000) } });
    const feed = (await A.agent.post('/api/calendar/token').send({})).body;
    const ics = (await request(app).get(new URL(feed.url).pathname + new URL(feed.url).search)).text;
    expect(ics).toContain('TODAY-1');
  });
});

describe('statements and TONU', () => {
  it('a canceled load with a TONU is on the statement at its TONU amount', async () => {
    const A = await registerUser();
    const c = await prisma.carrier.create({ data: { ownerId: A.user.id, stageId: await stageId(), companyName: 'Tonu Trucking' } });
    const customer = await prisma.customer.create({ data: { ownerId: A.user.id, carrierId: c.id, dispatchFeePercent: 10 } });
    const week = weekOf('America/Chicago', new Date());
    const day = new Date(week.start.getTime() + 12 * 3600_000);
    await prisma.load.create({ data: { ownerId: A.user.id, carrierId: c.id, originCity: 'A', originState: 'TX', destCity: 'B', destState: 'TX', rateCents: 300000, loadedMiles: 500, status: 'canceled', tonuCents: 25000, pickupDate: day } });
    await prisma.load.create({ data: { ownerId: A.user.id, carrierId: c.id, originCity: 'A', originState: 'TX', destCity: 'C', destState: 'TX', rateCents: 400000, loadedMiles: 500, status: 'canceled', pickupDate: day } });
    const st = await buildStatement({ customer, carrier: c, week });
    expect(st.lines).toHaveLength(1);
    expect(st.lines[0]).toMatchObject({ tonu: true, grossCents: 25000, feeCents: 2500, loadedMiles: 0, ratePerMile: null });
    const detail = (await A.agent.get(`/api/customers/${customer.id}`)).body;
    expect(JSON.stringify(detail)).toContain('2500');
  });
});

describe('invoices', () => {
  let A; let broker; let carrier;
  const mkLoad = (data = {}) => prisma.load.create({ data: { ownerId: A.user.id, brokerId: broker.id, carrierId: carrier.id, originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', rateCents: 200000, loadedMiles: 800, status: 'delivered', deliveryDate: new Date(), ...data } });
  beforeAll(async () => {
    A = await registerUser();
    await connect(A.agent);
    broker = (await A.agent.post('/api/brokers').send({ companyName: 'Quick Pay Brokerage', email: 'ap@quick.test', paymentTerms: 'Quick pay 2%', daysToPay: 15 })).body.broker;
    carrier = await prisma.carrier.create({ data: { ownerId: A.user.id, stageId: await stageId(), companyName: 'Inv Carrier' } });
  });

  it('two creates at once make one invoice', async () => {
    const load = await mkLoad();
    const [r1, r2] = await Promise.all([A.agent.post('/api/invoices').send({ loadId: load.id }), A.agent.post('/api/invoices').send({ loadId: load.id })]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    expect(await prisma.invoice.count({ where: { loadId: load.id } })).toBe(1);
  });

  it("the sent email shows the stored due date, from the broker's days to pay", async () => {
    const load = await mkLoad();
    const inv = (await A.agent.post('/api/invoices').send({ loadId: load.id })).body.invoice;
    // Drafted 10 days ago: the due date counts from the send date.
    await prisma.invoice.update({ where: { id: inv.id }, data: { createdAt: new Date(Date.now() - 10 * DAY), dueAt: new Date(Date.now() + 5 * DAY) } });
    const res = await A.agent.post(`/api/invoices/${inv.id}/send`).send({});
    expect(res.status).toBe(200);
    const stored = await prisma.invoice.findUnique({ where: { id: inv.id } });
    const days = Math.round((stored.dueAt - stored.issuedAt) / DAY);
    expect(days).toBe(15);
    const body = mail.sendMail.mock.calls.at(-1)?.[0]?.text || '';
    const shown = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' }).format(stored.dueAt);
    expect(body).toContain(shown);
    // A second send right after does not email the broker again.
    const again = await Promise.all([A.agent.post(`/api/invoices/${inv.id}/send`).send({}), A.agent.post(`/api/invoices/${inv.id}/send`).send({})]);
    expect(again.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
  });

  it('a new due date restarts collection reminders from the right stage', async () => {
    const load = await mkLoad();
    const inv = (await A.agent.post('/api/invoices').send({ loadId: load.id })).body.invoice;
    await A.agent.post(`/api/invoices/${inv.id}/mark-sent`).send({});
    await prisma.invoice.update({ where: { id: inv.id }, data: { reminderCount: 2, lastReminderAt: new Date() } });
    await A.agent.patch(`/api/invoices/${inv.id}`).send({ dueAt: new Date(Date.now() + 10 * DAY).toISOString() });
    expect(await prisma.invoice.findUnique({ where: { id: inv.id } })).toMatchObject({ reminderCount: 0, lastReminderAt: null });
    await A.agent.patch(`/api/invoices/${inv.id}`).send({ dueAt: new Date(Date.now() - 8 * DAY).toISOString() });
    expect((await prisma.invoice.findUnique({ where: { id: inv.id } })).reminderCount).toBe(2);
  });

  it('is past due as soon as the due date passes', () => {
    const now = new Date();
    const v = invoiceView({ status: 'sent', amountCents: 100, paidCents: 0, dueAt: new Date(now.getTime() - 2 * 3600_000), lines: '[]' }, now);
    expect(v).toMatchObject({ overdue: true, daysOverdue: 1 });
    expect(invoiceView({ status: 'sent', amountCents: 100, paidCents: 0, dueAt: new Date(now.getTime() + 3600_000), lines: '[]' }, now)).toMatchObject({ overdue: false, daysOverdue: 0 });
    const issued = new Date('2026-11-01T12:00:00Z');
    expect(effectiveDueAt({ kind: 'freight', lines: JSON.stringify({ items: [], meta: { terms: 'COD', dueDays: 15 } }) }, issued).toISOString()).toBe('2026-11-16T12:00:00.000Z');
  });
});
