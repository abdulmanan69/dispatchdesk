import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const mail = vi.hoisted(() => ({
  sendMail: vi.fn(async (m) => ({ messageId: m?.messageId || '<inv@test>', accepted: [m?.to], rejected: [] })),
}));
vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => ({ verify: async () => true, sendMail: mail.sendMail, close: () => {} }));
  return { default: { createTransport }, createTransport };
});

const { registerUser, prisma } = await import('./helpers.js');
const { runCollectionReminders, stageFor } = await import('../src/services/invoices/reminders.js');
const { csvRows, linesForLoad, termsDays, safeCell } = await import('../src/services/invoices/index.js');

const { config } = await import('../src/config.js');
const fs = await import('node:fs');
const path = await import('node:path');

const DAY = 86400000;
const docDir = path.join(config.uploadDir, 'documents');
fs.mkdirSync(docDir, { recursive: true });
let docN = 0;
async function makeDoc(ownerId, loadId, type) {
  docN += 1;
  const storedName = `inv-${Date.now()}-${docN}.pdf`;
  const bytes = Buffer.from('%PDF-1.4 proof of delivery');
  fs.writeFileSync(path.join(docDir, storedName), bytes);
  return prisma.document.create({ data: { ownerId, uploadedById: ownerId, loadId, type, originalName: `${type}.pdf`, storedName, mimeType: 'application/pdf', sizeBytes: bytes.length } });
}
async function connect(agent) {
  const res = await agent.post('/api/email/accounts/smtp').send({ provider: 'hostinger', fromEmail: `inv${Date.now()}${Math.random().toString(36).slice(2, 6)}@dispatch.test`, password: 'pw', cooldownSeconds: 0 });
  expect(res.status).toBe(201);
}

beforeEach(() => mail.sendMail.mockClear());

describe('invoice helpers', () => {
  it('builds lines from a load, reads terms, guards CSV cells and maps reminder stages', () => {
    const load = { originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA', referenceNumber: 'R-9', rateCents: 200000, loadedMiles: 800, detentionHours: 2, detentionRateCents: 5000, status: 'delivered' };
    expect(linesForLoad(load, 'freight').map((l) => [l.kind, l.amountCents])).toEqual([['linehaul', 200000], ['detention', 10000]]);
    expect(linesForLoad({ ...load, status: 'canceled', tonuCents: 15000 }, 'freight').map((l) => [l.kind, l.amountCents])).toEqual([['tonu', 15000]]);
    expect(linesForLoad(load, 'dispatch_fee', { feePercent: 10 })[0].amountCents).toBe(21000);
    expect(linesForLoad(load, 'dispatch_fee')).toEqual([]);
    expect(termsDays('Net 45', null)).toBe(45);
    expect(termsDays('Quick pay 2%', 3)).toBe(3);
    expect(termsDays('COD', null)).toBeNull();
    expect(safeCell('=HYPERLINK("x")')).toBe('\'=HYPERLINK("x")');
    expect(safeCell('-1+2')).toBe("'-1+2");
    expect(safeCell('+15551234567')).toBe("'+15551234567");
    // A credit line's amount stays a number for the QuickBooks import.
    expect(safeCell('-50.00')).toBe('-50.00');
    expect(safeCell(1001)).toBe('1001');
    expect([0, 6, 7, 14, 15, 29, 30, 90].map(stageFor)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });
});

describe('invoices API', () => {
  let A;
  let B;
  let broker;
  let carrier;
  let load;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    broker = (await A.agent.post('/api/brokers').send({ companyName: 'Summit <Logistics>', email: 'ap@summit.test', paymentTerms: 'Net 30', mcNumber: '123456' })).body.broker;
    const stage = await prisma.pipelineStage.findUnique({ where: { key: 'prospecting' } });
    carrier = await prisma.carrier.create({ data: { ownerId: A.user.id, stageId: stage.id, companyName: 'Blue Line Trucking', mcNumber: '765432', email: 'owner@blueline.test', address: '9 Yard Rd', city: 'Dallas', state: 'TX' } });
    await A.agent.post('/api/customers').send({ carrierId: carrier.id, dispatchFeePercent: 8 });
    load = (await A.agent.post('/api/loads').send({
      brokerId: broker.id, carrierId: carrier.id, referenceNumber: 'R-100', originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA',
      loadedMiles: 800, rateCents: 200000, detentionHours: 2, detentionRateCents: 5000, status: 'delivered', deliveryDate: '2026-11-08T18:00:00Z',
    })).body.load;
  });

  it('creates a numbered freight draft from a delivered load and refuses duplicates, undelivered loads and other tenants', async () => {
    const planned = (await A.agent.post('/api/loads').send({ brokerId: broker.id, originCity: 'A', originState: 'TX', destCity: 'B', destState: 'GA', loadedMiles: 10, rateCents: 1000 })).body.load;
    expect((await A.agent.post('/api/invoices').send({ loadId: planned.id })).status).toBe(400);
    expect((await B.agent.post('/api/invoices').send({ loadId: load.id })).status).toBe(404);

    const res = await A.agent.post('/api/invoices').send({ loadId: load.id, kind: 'freight' });
    expect(res.status).toBe(201);
    const inv = res.body.invoice;
    expect(inv).toMatchObject({ number: 1001, status: 'draft', kind: 'freight', billToName: 'Summit <Logistics>', billToEmail: 'ap@summit.test', amountCents: 210000 });
    expect(inv.items.map((l) => l.kind)).toEqual(['linehaul', 'detention']);
    expect(inv.meta).toMatchObject({ reference: 'R-100', terms: 'Net 30', carrier: { name: 'Blue Line Trucking', mc: '765432' } });
    const dup = await A.agent.post('/api/invoices').send({ loadId: load.id, kind: 'freight' });
    expect(dup.status).toBe(409);
    expect(dup.body.details.invoiceId).toBe(inv.id);

    const fee = await A.agent.post('/api/invoices').send({ loadId: load.id, kind: 'dispatch_fee' });
    expect(fee.status).toBe(201);
    expect(fee.body.invoice).toMatchObject({ number: 1002, billToName: 'Blue Line Trucking', billToEmail: 'owner@blueline.test', amountCents: 16800 });
    expect((await B.agent.get(`/api/invoices/${inv.id}`)).status).toBe(404);
    expect((await B.agent.get('/api/invoices')).body.items).toHaveLength(0);
  });

  it('numbers concurrent creates without gaps or duplicates', async () => {
    const C = await registerUser();
    const b = (await C.agent.post('/api/brokers').send({ companyName: 'Race Broker' })).body.broker;
    const loads = await Promise.all([1, 2, 3, 4, 5].map((i) => C.agent.post('/api/loads').send({ brokerId: b.id, originCity: 'A', originState: 'TX', destCity: 'B', destState: 'GA', loadedMiles: 100, rateCents: 10000 * i, status: 'delivered' })));
    const created = await Promise.all(loads.map((l) => C.agent.post('/api/invoices').send({ loadId: l.body.load.id })));
    expect(created.map((x) => x.status)).toEqual([201, 201, 201, 201, 201]);
    expect(created.map((x) => x.body.invoice.number).sort()).toEqual([1001, 1002, 1003, 1004, 1005]);
  });

  it('edits a draft, sends it from the user mailbox with POD attached, records payments and moves the load forward', async () => {
    const inv = (await A.agent.get(`/api/invoices?loadId=${load.id}&kind=freight`)).body.items[0];
    const edit = await A.agent.patch(`/api/invoices/${inv.id}`).send({
      items: [...inv.items, { kind: 'lumper', description: 'Lumper reimbursement (receipt attached)', quantity: 1, unitCents: 7500 }],
      notes: 'Thank you', autoRemind: true, remitTo: 'Blue Line Trucking\nPO Box 1, Dallas TX',
    });
    expect(edit.status).toBe(200);
    expect(edit.body.invoice.amountCents).toBe(217500);
    expect(edit.body.invoice.meta.autoRemind).toBe(true);
    expect((await A.agent.patch(`/api/invoices/${inv.id}`).send({ items: [] })).status).toBe(400);

    // No mailbox yet: nothing is marked sent.
    const noBox = await A.agent.post(`/api/invoices/${inv.id}/send`).send({});
    expect(noBox.status).toBe(400);
    expect((await prisma.invoice.findUnique({ where: { id: inv.id } })).status).toBe('draft');

    await connect(A.agent);
    const pod = await makeDoc(A.user.id, load.id, 'pod');
    const other = await makeDoc(B.user.id, null, 'other');
    const stolen = await A.agent.post(`/api/invoices/${inv.id}/send`).send({ documentIds: [other.id] });
    expect(stolen.status).toBe(400);
    expect(stolen.body.error).toMatch(/not found/);
    const sent = await A.agent.post(`/api/invoices/${inv.id}/send`).send({ documentIds: [pod.id] });
    expect(sent.status).toBe(200);
    expect(sent.body.outcome).toBe('sent');
    expect(sent.body.invoice.status).toBe('sent');
    expect(sent.body.invoice.issuedAt).toBeTruthy();
    const dueIn = (new Date(sent.body.invoice.dueAt) - new Date(sent.body.invoice.issuedAt)) / DAY;
    expect(Math.round(dueIn)).toBe(30);
    const msg = mail.sendMail.mock.calls.at(-1)[0];
    expect(msg.to).toContain('ap@summit.test');
    expect(msg.subject).toBe('Invoice #1001 · load R-100');
    expect(msg.attachments.map((a) => a.filename)).toEqual(['pod.pdf']);
    expect(String(msg.text || msg.html)).toContain('Balance due: $2,175.00');
    expect((await prisma.load.findUnique({ where: { id: load.id } })).status).toBe('invoiced');
    expect((await A.agent.patch(`/api/invoices/${inv.id}`).send({ items: [{ description: 'x', quantity: 1, unitCents: 1 }] })).status).toBe(400);

    expect((await A.agent.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 999999999 })).status).toBe(400);
    const part = await A.agent.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 100000, method: 'ACH', reference: 'TRX-1' });
    expect(part.body.invoice).toMatchObject({ status: 'partial', paidCents: 100000, balanceCents: 117500 });
    expect((await A.agent.post(`/api/invoices/${inv.id}/void`)).status).toBe(400);
    const full = await A.agent.post(`/api/invoices/${inv.id}/payments`).send({ full: true });
    expect(full.body.invoice).toMatchObject({ status: 'paid', paidCents: 217500, balanceCents: 0 });
    expect(full.body.invoice.meta.payments).toHaveLength(2);
    expect((await prisma.load.findUnique({ where: { id: load.id } })).status).toBe('paid');
    expect((await B.agent.post(`/api/invoices/${inv.id}/payments`).send({ full: true })).status).toBe(404);

    const bd = await A.agent.get(`/api/brokers/${broker.id}`);
    expect(bd.body.payments.paidInvoices).toBe(1);
    expect(bd.body.payments.avgDaysToPay).toBe(0);
  });

  it('prints an escaped invoice page and exports a QuickBooks CSV', async () => {
    const inv = (await A.agent.get(`/api/invoices?loadId=${load.id}&kind=freight`)).body.items[0];
    const page = await A.agent.get(`/api/invoices/${inv.id}/print`);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.text).toContain('Summit &lt;Logistics&gt;');
    expect(page.text).not.toContain('Summit <Logistics>');
    expect(page.text).toContain('Invoice #1001');
    expect(page.text).not.toMatch(/<script/i);
    expect((await B.agent.get(`/api/invoices/${inv.id}/print`)).status).toBe(404);

    const csv = await A.agent.get('/api/invoices/export.csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = csv.text.replace(/^﻿/, '').trim().split(/\r?\n/);
    expect(lines[0]).toBe('InvoiceNo,Customer,InvoiceDate,DueDate,Terms,Memo,Item(Product/Service),ItemDescription,ItemQuantity,ItemRate,ItemAmount,Service Date');
    expect(lines.filter((l) => l.startsWith('1001,'))).toHaveLength(3);
    expect(lines.some((l) => l.startsWith('1002,'))).toBe(false); // still a draft
    const rows = csvRows([{ number: 7, billToName: '=cmd', lines: JSON.stringify({ items: [], meta: {} }), amountCents: 500, kind: 'freight', createdAt: new Date() }], 'America/Chicago');
    expect(rows[0][1]).toBe("'=cmd");
  });

  it('reports aging buckets and overdue totals, and reminds once per stage in one notification per user', async () => {
    const D = await registerUser();
    const b = (await D.agent.post('/api/brokers').send({ companyName: 'Slow Pay Co', email: 'ap@slowpay.test' })).body.broker;
    const mk = async (rate) => {
      const l = (await D.agent.post('/api/loads').send({ brokerId: b.id, originCity: 'A', originState: 'TX', destCity: 'B', destState: 'GA', loadedMiles: 100, rateCents: rate, status: 'delivered' })).body.load;
      const inv = (await D.agent.post('/api/invoices').send({ loadId: l.id })).body.invoice;
      await D.agent.post(`/api/invoices/${inv.id}/mark-sent`);
      return inv;
    };
    const fresh = await mk(10000);
    const old = await mk(20000);
    const ancient = await mk(30000);
    const now = Date.now();
    await prisma.invoice.update({ where: { id: old.id }, data: { issuedAt: new Date(now - 45 * DAY), dueAt: new Date(now - 15 * DAY - 3600000) } });
    await prisma.invoice.update({ where: { id: ancient.id }, data: { issuedAt: new Date(now - 100 * DAY), dueAt: new Date(now - 70 * DAY) } });
    const list = await D.agent.get('/api/invoices?status=open');
    expect(list.body.aging.buckets.map((x) => [x.key, x.count, x.openCents])).toEqual([['0_30', 1, 10000], ['31_60', 1, 20000], ['61_90', 0, 0], ['90_plus', 1, 30000]]);
    expect(list.body.aging).toMatchObject({ openCents: 60000, overdueCents: 50000, overdueCount: 2 });
    expect((await D.agent.get('/api/invoices?status=overdue')).body.items.map((i) => i.id).sort()).toEqual([old.id, ancient.id].sort());

    await prisma.invoice.update({ where: { id: old.id }, data: { lines: JSON.stringify({ items: [{ kind: 'linehaul', description: 'x', quantity: 1, unitCents: 20000, amountCents: 20000 }], meta: { autoRemind: true } }) } });
    await connect(D.agent);
    const r1 = await runCollectionReminders(new Date());
    expect(r1.notified).toBeGreaterThanOrEqual(1);
    const notes = await prisma.notification.findMany({ where: { userId: D.user.id, type: 'invoice_overdue' } });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toMatch(/2 invoices are past due/);
    expect((await prisma.invoice.findUnique({ where: { id: old.id } })).reminderCount).toBe(3);
    expect((await prisma.invoice.findUnique({ where: { id: ancient.id } })).reminderCount).toBe(4);
    const queued = await prisma.email.findMany({ where: { userId: D.user.id, toEmail: 'ap@slowpay.test' } });
    expect(queued).toHaveLength(1);
    expect(queued[0].subject).toMatch(/Reminder: invoice #1002/);
    // Same day again: nothing new.
    await runCollectionReminders(new Date());
    expect(await prisma.notification.count({ where: { userId: D.user.id, type: 'invoice_overdue' } })).toBe(1);
  });

  it('keeps a due date picked on the draft, and bills TONU loads (fee on the TONU amount)', async () => {
    const F = await registerUser();
    const b = (await F.agent.post('/api/brokers').send({ companyName: 'Due Broker', paymentTerms: 'Net 15' })).body.broker;
    const stage = await prisma.pipelineStage.findUnique({ where: { key: 'prospecting' } });
    const c = await prisma.carrier.create({ data: { ownerId: F.user.id, stageId: stage.id, companyName: 'TONU Trucking' } });
    await F.agent.post('/api/customers').send({ carrierId: c.id, dispatchFeePercent: 10 });
    const l = (await F.agent.post('/api/loads').send({ brokerId: b.id, carrierId: c.id, originCity: 'A', originState: 'TX', destCity: 'B', destState: 'GA', loadedMiles: 100, rateCents: 50000, status: 'booked' })).body.load;
    await F.agent.post(`/api/loads/${l.id}/tonu`).send({ tonuCents: 20000, note: 'Canceled on arrival' });
    const freight = (await F.agent.post('/api/invoices').send({ loadId: l.id })).body.invoice;
    expect(freight.items.map((x) => [x.kind, x.amountCents])).toEqual([['tonu', 20000]]);
    const fee = (await F.agent.post('/api/invoices').send({ loadId: l.id, kind: 'dispatch_fee' })).body.invoice;
    expect(fee.amountCents).toBe(2000);
    const picked = new Date(Date.now() + 40 * DAY);
    await F.agent.patch(`/api/invoices/${freight.id}`).send({ dueAt: picked.toISOString() });
    const sent = await F.agent.post(`/api/invoices/${freight.id}/mark-sent`);
    expect(new Date(sent.body.invoice.dueAt).toISOString()).toBe(picked.toISOString());
    const sentFee = await F.agent.post(`/api/invoices/${fee.id}/mark-sent`);
    expect(Math.round((new Date(sentFee.body.invoice.dueAt) - new Date(sentFee.body.invoice.issuedAt)) / DAY)).toBe(7);
  });

  it('voids and deletes only when allowed', async () => {
    const E = await registerUser();
    const b = (await E.agent.post('/api/brokers').send({ companyName: 'Void Broker' })).body.broker;
    const l = (await E.agent.post('/api/loads').send({ brokerId: b.id, originCity: 'A', originState: 'TX', destCity: 'B', destState: 'GA', loadedMiles: 100, rateCents: 10000, status: 'delivered' })).body.load;
    const inv = (await E.agent.post('/api/invoices').send({ loadId: l.id })).body.invoice;
    expect((await E.agent.post(`/api/invoices/${inv.id}/payments`).send({ full: true })).status).toBe(400);
    await E.agent.post(`/api/invoices/${inv.id}/mark-sent`);
    expect((await E.agent.delete(`/api/invoices/${inv.id}`)).status).toBe(400);
    const v = await E.agent.post(`/api/invoices/${inv.id}/void`);
    expect(v.body.invoice.status).toBe('void');
    // A void invoice frees the load for a new one.
    expect((await E.agent.post('/api/invoices').send({ loadId: l.id })).status).toBe(201);
    const loads = await E.agent.get('/api/invoices/loads');
    expect(loads.body.items[0].invoices.length).toBe(1);
  });

  it('never loses a payment recorded at the same moment as another one', async () => {
    const G = await registerUser();
    const b = (await G.agent.post('/api/brokers').send({ companyName: 'Race Pay Broker' })).body.broker;
    const l = (await G.agent.post('/api/loads').send({ brokerId: b.id, originCity: 'A', originState: 'TX', destCity: 'B', destState: 'GA', loadedMiles: 100, rateCents: 100000, status: 'delivered' })).body.load;
    const inv = (await G.agent.post('/api/invoices').send({ loadId: l.id })).body.invoice;
    await G.agent.post(`/api/invoices/${inv.id}/mark-sent`);
    const results = await Promise.all([10000, 20000, 30000].map((amountCents) => G.agent.post(`/api/invoices/${inv.id}/payments`).send({ amountCents })));
    for (const r of results) expect([200, 409]).toContain(r.status);
    const accepted = [10000, 20000, 30000].filter((_, i) => results[i].status === 200);
    const row = await prisma.invoice.findUnique({ where: { id: inv.id } });
    // Whatever interleaving happened, the stored total equals the payments that were reported as recorded.
    expect(row.paidCents).toBe(accepted.reduce((s, x) => s + x, 0));
    expect(JSON.parse(row.lines).meta.payments).toHaveLength(accepted.length);
  });
});
