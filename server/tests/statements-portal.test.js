import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';

const mail = vi.hoisted(() => ({ sendMail: vi.fn(async (m) => ({ messageId: m?.messageId || '<st@test>', accepted: [m?.to], rejected: [] })) }));
vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => ({ verify: async () => true, sendMail: mail.sendMail, close: () => {} }));
  return { default: { createTransport }, createTransport };
});

const { registerUser, prisma, app } = await import('./helpers.js');
const { config } = await import('../src/config.js');
const { weekOf, weekFromKey, recentWeeks } = await import('../src/services/invoices/statements.js');

const docDir = path.join(config.uploadDir, 'documents');
fs.mkdirSync(docDir, { recursive: true });
let n = 0;
async function makeDoc(ownerId, loadId, type, carrierId = null) {
  n += 1;
  const storedName = `st-${Date.now()}-${n}.pdf`;
  fs.writeFileSync(path.join(docDir, storedName), Buffer.from(`%PDF-1.4 ${type}`));
  return prisma.document.create({ data: { ownerId, uploadedById: ownerId, loadId, carrierId, type, originalName: `${type}.pdf`, storedName, mimeType: 'application/pdf', sizeBytes: 20 } });
}

describe('statement weeks', () => {
  it('uses Monday-to-Monday weeks in the user time zone', () => {
    // Sunday 23:30 in Chicago is still the week that started Monday Nov 9.
    const w = weekOf('America/Chicago', new Date('2026-11-16T05:30:00Z'));
    expect(w.key).toBe('2026-11-09');
    expect(w.start.toISOString()).toBe('2026-11-09T06:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-11-16T06:00:00.000Z');
    expect(weekFromKey('America/Chicago', '2026-11-09').start.toISOString()).toBe('2026-11-09T06:00:00.000Z');
    expect(() => weekFromKey('America/Chicago', '2026-11-10')).toThrow(/Monday/);
    expect(() => weekFromKey('America/Chicago', 'last week')).toThrow();
    const weeks = recentWeeks('America/Chicago', 3, new Date('2026-11-12T12:00:00Z'));
    expect(weeks.map((x) => x.key)).toEqual(['2026-11-09', '2026-11-02', '2026-10-26']);
  });
});

describe('weekly statements and the carrier portal', () => {
  let A;
  let B;
  let customer;
  let carrier;
  let week;
  let loadIn;
  let loadOld;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    const stage = await prisma.pipelineStage.findUnique({ where: { key: 'prospecting' } });
    carrier = await prisma.carrier.create({ data: { ownerId: A.user.id, stageId: stage.id, companyName: 'Portal Freight LLC', mcNumber: '888111', email: 'owner@portalfreight.test' } });
    customer = (await A.agent.post('/api/customers').send({ carrierId: carrier.id, dispatchFeePercent: 10 })).body.customer;
    const broker = (await A.agent.post('/api/brokers').send({ companyName: 'Broker <One>' })).body.broker;
    week = weekOf(A.user.timezone || 'America/Chicago');
    const inWeek = new Date(week.start.getTime() + 36 * 3600000).toISOString();
    const lane = { carrierId: carrier.id, brokerId: broker.id, originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', loadedMiles: 1000 };
    loadIn = (await A.agent.post('/api/loads').send({ ...lane, rateCents: 250000, status: 'delivered', deliveryDate: inWeek, referenceNumber: 'W-1' })).body.load;
    await A.agent.post('/api/loads').send({ ...lane, rateCents: 150000, status: 'paid', deliveryDate: inWeek, dispatchFeePercent: 5 });
    await A.agent.post('/api/loads').send({ ...lane, rateCents: 999900, status: 'booked', deliveryDate: inWeek });
    loadOld = (await A.agent.post('/api/loads').send({ ...lane, rateCents: 100000, status: 'delivered', deliveryDate: new Date(Date.now() - 200 * 86400000).toISOString() })).body.load;
    await makeDoc(A.user.id, loadIn.id, 'pod');
    await makeDoc(A.user.id, loadIn.id, 'rate_confirmation');
  });

  it('builds the week from delivered loads with gross, fee and net', async () => {
    const list = await A.agent.get(`/api/customers/${customer.id}/statements?weeks=4`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(4);
    expect(list.body.items[0]).toMatchObject({ weekStart: week.key, totals: { loads: 2, grossCents: 400000, feeCents: 32500, netCents: 367500 } });
    const one = await A.agent.get(`/api/customers/${customer.id}/statements/${week.key}`);
    expect(one.body.statement.lines.map((l) => [l.feePercent, l.feeCents])).toEqual(expect.arrayContaining([[10, 25000], [5, 7500]]));
    expect((await A.agent.get(`/api/customers/${customer.id}/statements/2026-11-11`)).status).toBe(400);
    expect((await B.agent.get(`/api/customers/${customer.id}/statements/${week.key}`)).status).toBe(404);
    const page = await A.agent.get(`/api/customers/${customer.id}/statements/${week.key}/print`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Portal Freight LLC');
    expect(page.text).toContain('Broker &lt;One&gt;');
    expect(page.text).toContain('$3,675.00');
  });

  it('creates, uses, rotates and revokes a hashed portal link that shows only this carrier', async () => {
    expect((await B.agent.post(`/api/customers/${customer.id}/portal`)).status).toBe(404);
    const created = await A.agent.post(`/api/customers/${customer.id}/portal`).send({ days: 30 });
    expect(created.status).toBe(201);
    const token = created.body.url.split('/portal/')[1];
    expect(token.length).toBeGreaterThan(20);
    const stored = await prisma.customer.findUnique({ where: { id: customer.id } });
    expect(stored.portalTokenHash).not.toContain(token);
    expect(stored.portalTokenHash).toHaveLength(64);

    const pub = request(app);
    const home = await pub.get(`/api/public/portal/${token}`);
    expect(home.status).toBe(200);
    expect(home.headers['cache-control']).toMatch(/no-store/);
    expect(home.body.carrier.companyName).toBe('Portal Freight LLC');
    expect(home.body.weeks[0].totals.loads).toBe(2);
    expect(JSON.stringify(home.body)).not.toMatch(/portalTokenHash|notes|minRatePerMile/);

    const st = await pub.get(`/api/public/portal/${token}/statements/${week.key}`);
    expect(st.status).toBe(200);
    const line = st.body.statement.lines.find((l) => l.id === loadIn.id);
    expect(line.documents.map((d) => d.type).sort()).toEqual(['pod', 'rate_confirmation']);
    const dl = await pub.get(`/api/public/portal/${token}/documents/${line.documents[0].id}`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/attachment/);

    // Not reachable: carrier documents, documents of old loads, other carriers' files, old weeks.
    const w9 = await makeDoc(A.user.id, null, 'w9', carrier.id);
    expect((await pub.get(`/api/public/portal/${token}/documents/${w9.id}`)).status).toBe(404);
    const oldPod = await makeDoc(A.user.id, loadOld.id, 'pod');
    expect((await pub.get(`/api/public/portal/${token}/documents/${oldPod.id}`)).status).toBe(404);
    expect((await pub.get(`/api/public/portal/${token}/statements/2025-01-06`)).status).toBe(404);
    expect((await pub.get(`/api/public/portal/${token}/statements/${week.key}/print`)).status).toBe(200);
    expect((await pub.get('/api/public/portal/not-a-real-token-at-all-1234567')).status).toBe(404);

    const rotated = await A.agent.post(`/api/customers/${customer.id}/portal`).send({});
    const token2 = rotated.body.url.split('/portal/')[1];
    expect((await pub.get(`/api/public/portal/${token}`)).status).toBe(404);
    expect((await pub.get(`/api/public/portal/${token2}`)).status).toBe(200);
    await prisma.customer.update({ where: { id: customer.id }, data: { portalExpiresAt: new Date(Date.now() - 1000) } });
    expect((await pub.get(`/api/public/portal/${token2}`)).status).toBe(404);
    await A.agent.post(`/api/customers/${customer.id}/portal`).send({});
    expect((await A.agent.delete(`/api/customers/${customer.id}/portal`)).status).toBe(200);
    const detail = await A.agent.get(`/api/customers/${customer.id}`);
    expect(detail.body.customer.portal).toEqual({ active: false, expiresAt: null });
  });

  it('emails the statement from the user mailbox, optionally with a new portal link', async () => {
    const noBox = await A.agent.post(`/api/customers/${customer.id}/statements/${week.key}/send`).send({});
    expect(noBox.status).toBe(400);
    // A send that cannot go out must not replace the link the carrier already has.
    const existing = await A.agent.post(`/api/customers/${customer.id}/portal`).send({ days: 30 });
    const liveToken = existing.body.url.split('/portal/')[1];
    const failedRotate = await A.agent.post(`/api/customers/${customer.id}/statements/${week.key}/send`).send({ portalLink: true });
    expect(failedRotate.status).toBe(400);
    expect((await request(app).get(`/api/public/portal/${liveToken}`)).status).toBe(200);
    await A.agent.post('/api/email/accounts/smtp').send({ provider: 'hostinger', fromEmail: `st${Date.now()}@dispatch.test`, password: 'pw', cooldownSeconds: 0 });
    mail.sendMail.mockClear();
    const sent = await A.agent.post(`/api/customers/${customer.id}/statements/${week.key}/send`).send({ portalLink: true });
    expect(sent.status).toBe(200);
    expect(sent.body.outcome).toBe('sent');
    expect(sent.body.portal.url).toContain('/portal/');
    const msg = mail.sendMail.mock.calls.at(-1)[0];
    expect(msg.to).toContain('owner@portalfreight.test');
    const text = String(msg.text || msg.html);
    expect(text).toContain('Net to carrier: $3,675.00');
    expect(text).toContain(sent.body.portal.url);
    expect((await B.agent.post(`/api/customers/${customer.id}/statements/${week.key}/send`).send({})).status).toBe(404);
  });
});
