import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const mail = vi.hoisted(() => ({
  sendMail: vi.fn(async (m) => ({ messageId: m?.messageId || '<fact@test>', accepted: [m?.to], rejected: [] })),
}));
vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => ({ verify: async () => true, sendMail: mail.sendMail, close: () => {} }));
  return { default: { createTransport }, createTransport };
});

const request = (await import('supertest')).default;
const { app, registerUser, prisma } = await import('./helpers.js');
const { config } = await import('../src/config.js');
const { suggestedFactoring, factoringSummary } = await import('../src/services/invoices/index.js');
const { winAnsiSanitizer } = await import('../src/services/invoices/pdf.js');
const parsePdf = (await import('pdf-parse/lib/pdf-parse.js')).default;
// pdf-parse's bundled pdf.js misreads Node Buffers: give it a plain Uint8Array copy.
const pdfParse = (buf) => parsePdf(new Uint8Array(buf));
const fs = await import('node:fs');
const path = await import('node:path');

const docDir = path.join(config.uploadDir, 'documents');
fs.mkdirSync(docDir, { recursive: true });
let docN = 0;
let mcN = 700000;
async function makeDoc(ownerId, { loadId = null, carrierId = null, type }) {
  docN += 1;
  const storedName = `fact-${Date.now()}-${docN}.pdf`;
  const bytes = Buffer.from(`%PDF-1.4 ${type}`);
  fs.writeFileSync(path.join(docDir, storedName), bytes);
  return prisma.document.create({ data: { ownerId, uploadedById: ownerId, loadId, carrierId, type, originalName: `${type}.pdf`, storedName, mimeType: 'application/pdf', sizeBytes: bytes.length } });
}
async function connect(agent) {
  const res = await agent.post('/api/email/accounts/smtp').send({ provider: 'hostinger', fromEmail: `fact${Date.now()}${Math.random().toString(36).slice(2, 6)}@dispatch.test`, password: 'pw', cooldownSeconds: 0 });
  expect(res.status).toBe(201);
}
async function makeTeam(owner, member) {
  expect((await owner.agent.post('/api/teams').send({ name: `Factor Team ${Date.now()}` })).status).toBe(201);
  const inv = await owner.agent.post('/api/teams/invitations').send({ email: member.email, role: 'dispatcher' });
  expect((await member.agent.post(`/api/teams/invitations/${inv.body.devToken}/accept`)).status).toBe(200);
}
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

/** A signed carrier with a broker and a delivered load. */
async function setup(who, { rateCents = 210000, ref = 'F-100' } = {}) {
  const broker = (await who.agent.post('/api/brokers').send({ companyName: 'Summit Logistics', email: 'ap@summit.test', paymentTerms: 'Net 30' })).body.broker;
  const stage = await prisma.pipelineStage.findUnique({ where: { key: 'prospecting' } });
  const carrier = await prisma.carrier.create({ data: { ownerId: who.user.id, stageId: stage.id, companyName: 'Blue Line Trucking', mcNumber: String(mcN += 1), email: 'owner@blueline.test', address: '9 Yard Rd', city: 'Dallas', state: 'TX' } });
  const customer = (await who.agent.post('/api/customers').send({ carrierId: carrier.id, dispatchFeePercent: 8 })).body.customer;
  const load = (await who.agent.post('/api/loads').send({
    brokerId: broker.id, carrierId: carrier.id, referenceNumber: ref, originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA',
    loadedMiles: 800, rateCents, status: 'delivered', deliveryDate: '2026-11-08T18:00:00Z',
  })).body.load;
  return { broker, carrier, customer, load };
}

beforeEach(() => mail.sendMail.mockClear());

describe('factoring helpers', () => {
  it('suggests advance, fee and reserve from the terms and summarizes factoring payments', () => {
    expect(suggestedFactoring(210000, 90, 3)).toEqual({ advanceCents: 189000, feeCents: 6300, reserveCents: 14700 });
    expect(suggestedFactoring(100001, 97, 3)).toEqual({ advanceCents: 97001, feeCents: 3000, reserveCents: 0 });
    expect(suggestedFactoring(210000, null, 3)).toEqual({ advanceCents: null, feeCents: 6300, reserveCents: null });
    expect(factoringSummary({ amountCents: 1000, paidCents: 0 }, { payments: [] })).toBeNull();
    expect(factoringSummary({ amountCents: 1000, paidCents: 900, status: 'partial' }, { payments: [{ kind: 'advance', amountCents: 900 }] }))
      .toEqual({ companyName: null, submittedAt: null, advancedCents: 900, feeCents: 0, reserveReleasedCents: 0, reservePendingCents: 100 });
  });

  it('turns any text into WinAnsi text the standard PDF fonts can draw', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const clean = winAnsiSanitizer(font);
    const out = clean('Dallas, TX → Atlanta, GA · “quoted” café − 5 😀 Ősz 東京\tx\r\nnext');
    expect(out).toBe('Dallas, TX -> Atlanta, GA · “quoted” café - 5  Osz ?? x\nnext');
    for (const line of out.split('\n')) expect(() => font.widthOfTextAtSize(line, 10)).not.toThrow();
  });
});

describe('factoring companies API', () => {
  let A; let M; let B;
  beforeAll(async () => {
    A = await registerUser();
    M = await registerUser();
    B = await registerUser();
    await makeTeam(A, M);
  });

  it('creates, lists, edits and deletes with validation', async () => {
    const bad = [
      {}, { name: 'x'.repeat(121) }, { name: 'Apex', submitEmail: 'not-an-email' }, { name: 'Apex', website: 'javascript:alert(1)' },
      { name: 'Apex', website: 'ftp://apex.test' }, { name: 'Apex', remitTo: 'x'.repeat(501) }, { name: 'Apex', notes: 'x'.repeat(2001) },
    ];
    for (const body of bad) expect((await A.agent.post('/api/factoring-companies').send(body)).status).toBe(400);
    const created = await A.agent.post('/api/factoring-companies').send({ name: '  Apex Capital ', submitEmail: 'Invoices@Apex.test', remitTo: 'PO Box 961029\nFort Worth, TX 76161', phone: '8005551000', website: 'https://apex.test', notes: '' });
    expect(created.status).toBe(201);
    expect(created.body.company).toMatchObject({ name: 'Apex Capital', submitEmail: 'invoices@apex.test', website: 'https://apex.test', notes: null, carrierCount: 0, ownerId: A.user.id });
    const id = created.body.company.id;
    const list = await A.agent.get('/api/factoring-companies');
    expect(list.body.items.map((c) => c.id)).toContain(id);
    const edit = await A.agent.patch(`/api/factoring-companies/${id}`).send({ phone: null, website: '' });
    expect(edit.status).toBe(200);
    expect(edit.body.company).toMatchObject({ phone: null, website: null, name: 'Apex Capital' });
    expect((await A.agent.patch(`/api/factoring-companies/${id}`).send({ name: '' })).status).toBe(400);
    expect((await A.agent.delete(`/api/factoring-companies/${id}`)).status).toBe(200);
    expect((await A.agent.get('/api/factoring-companies')).body.items.map((c) => c.id)).not.toContain(id);
  });

  it('keeps each workspace private and lets the team lead read and edit members’ companies', async () => {
    const mine = (await A.agent.post('/api/factoring-companies').send({ name: 'Lead Factor' })).body.company;
    const members = (await M.agent.post('/api/factoring-companies').send({ name: 'Member Factor' })).body.company;
    // Another workspace: hidden.
    expect((await B.agent.get('/api/factoring-companies')).body.items).toHaveLength(0);
    expect((await B.agent.patch(`/api/factoring-companies/${mine.id}`).send({ name: 'Mine now' })).status).toBe(404);
    expect((await B.agent.delete(`/api/factoring-companies/${mine.id}`)).status).toBe(404);
    expect((await B.agent.post('/api/factoring-companies').send({ name: 'Sneaky', ownerId: A.user.id })).status).toBe(404);
    // Team owner reads the team's companies and may edit a member's; a plain member sees only their own.
    const leadList = (await A.agent.get('/api/factoring-companies')).body.items.map((c) => c.name);
    expect(leadList).toEqual(expect.arrayContaining(['Lead Factor', 'Member Factor']));
    expect((await M.agent.get('/api/factoring-companies')).body.items.map((c) => c.name)).toEqual(['Member Factor']);
    expect((await A.agent.patch(`/api/factoring-companies/${members.id}`).send({ notes: 'Checked by the lead' })).status).toBe(200);
    expect((await M.agent.patch(`/api/factoring-companies/${mine.id}`).send({ name: 'x' })).status).toBe(404);
    const forMember = await A.agent.post('/api/factoring-companies').send({ name: 'Added for member', ownerId: M.user.id });
    expect(forMember.status).toBe(201);
    expect(forMember.body.company.ownerId).toBe(M.user.id);
    expect((await M.agent.post('/api/factoring-companies').send({ name: 'Not allowed', ownerId: A.user.id })).status).toBe(404);
  });
});

describe('carrier factoring terms', () => {
  let A; let B; let ctx; let apex;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    ctx = await setup(A);
    apex = (await A.agent.post('/api/factoring-companies').send({ name: 'Apex Capital', submitEmail: 'invoices@apex.test', remitTo: 'PO Box 961029\nFort Worth, TX 76161', phone: '8005551000' })).body.company;
  });

  it('links a company, records terms and refuses another workspace’s company', async () => {
    const other = (await B.agent.post('/api/factoring-companies').send({ name: 'Other Factor' })).body.company;
    const refused = await A.agent.patch(`/api/customers/${ctx.customer.id}`).send({ factoringCompanyId: other.id });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('Pick one of your factoring companies');
    expect((await A.agent.patch(`/api/customers/${ctx.customer.id}`).send({ factoringAdvancePct: 101 })).status).toBe(400);
    expect((await A.agent.patch(`/api/customers/${ctx.customer.id}`).send({ factoringAdvancePct: 98, factoringFeePct: 3 })).status).toBe(400);
    expect((await A.agent.patch(`/api/customers/${ctx.customer.id}`).send({ factoringClientNo: 'x'.repeat(61) })).status).toBe(400);
    const ok = await A.agent.patch(`/api/customers/${ctx.customer.id}`).send({ factoringCompanyId: apex.id, factoringClientNo: 'BL-2231', factoringAdvancePct: 90, factoringFeePct: 3, factoringRecourse: false });
    expect(ok.status).toBe(200);
    expect(ok.body.customer).toMatchObject({ factoringCompanyId: apex.id, factoringClientNo: 'BL-2231', factoringAdvancePct: 90, factoringFeePct: 3, factoringRecourse: false, factoringCompany: { id: apex.id, name: 'Apex Capital' } });
    expect(ok.body.customer.portalTokenHash).toBeUndefined();
    // The other existing fields keep working.
    expect((await A.agent.patch(`/api/customers/${ctx.customer.id}`).send({ dispatchFeePercent: 7 })).body.customer).toMatchObject({ dispatchFeePercent: 7, factoringCompanyId: apex.id });

    let detail = (await A.agent.get(`/api/customers/${ctx.customer.id}`)).body.customer;
    expect(detail.factoringCompany).toEqual({ id: apex.id, name: 'Apex Capital', submitEmail: 'invoices@apex.test', remitTo: 'PO Box 961029\nFort Worth, TX 76161', phone: '8005551000' });
    expect(detail.noa).toEqual({ onFile: false, documentId: null, uploadedAt: null });
    const noa = await makeDoc(A.user.id, { carrierId: ctx.carrier.id, type: 'noa' });
    detail = (await A.agent.get(`/api/customers/${ctx.customer.id}`)).body.customer;
    expect(detail.noa).toMatchObject({ onFile: true, documentId: noa.id });
    const list = (await A.agent.get('/api/customers')).body.items.find((c) => c.id === ctx.customer.id);
    expect(list.factoringCompany.name).toBe('Apex Capital');
    expect(list.noa.onFile).toBe(true);
    const forCustomer = await A.agent.get(`/api/factoring-companies?customerId=${ctx.customer.id}`);
    expect(forCustomer.body.items.find((c) => c.id === apex.id).carrierCount).toBe(1);
    expect((await B.agent.get(`/api/factoring-companies?customerId=${ctx.customer.id}`)).status).toBe(404);
    // The carrier profile header shows who the carrier factors with.
    expect((await A.agent.get(`/api/carriers/${ctx.carrier.id}`)).body.carrier.customer.factoringCompany).toEqual({ id: apex.id, name: 'Apex Capital' });
  });

  it('deleting a company leaves its carriers working without it', async () => {
    const temp = (await A.agent.post('/api/factoring-companies').send({ name: 'Short Lived' })).body.company;
    const s2 = await setup(A, { ref: 'F-DEL' });
    expect((await A.agent.patch(`/api/customers/${s2.customer.id}`).send({ factoringCompanyId: temp.id })).status).toBe(200);
    const del = await A.agent.delete(`/api/factoring-companies/${temp.id}`);
    expect(del.body).toEqual({ ok: true, carriersCleared: 1 });
    const after = await A.agent.get(`/api/customers/${s2.customer.id}`);
    expect(after.status).toBe(200);
    expect(after.body.customer).toMatchObject({ factoringCompanyId: null, factoringCompany: null });
    expect((await A.agent.patch(`/api/customers/${s2.customer.id}`).send({ factoringCompanyId: null })).status).toBe(200);
  });
});

describe('factored invoices', () => {
  let A; let B; let ctx; let apex; let inv;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    ctx = await setup(A);
    apex = (await A.agent.post('/api/factoring-companies').send({ name: 'Apex Capital', remitTo: 'PO Box 961029\nFort Worth, TX 76161' })).body.company;
  });

  it('prefills the factoring company as remit-to on new freight invoices unless one is given', async () => {
    expect((await A.agent.patch(`/api/customers/${ctx.customer.id}`).send({ factoringCompanyId: apex.id, factoringClientNo: 'BL-2231', factoringAdvancePct: 90, factoringFeePct: 3 })).status).toBe(200);
    const created = await A.agent.post('/api/invoices').send({ loadId: ctx.load.id, kind: 'freight' });
    expect(created.status).toBe(201);
    inv = created.body.invoice;
    expect(inv.meta.remitTo).toBe('Apex Capital\nPO Box 961029\nFort Worth, TX 76161');
    const fee = await A.agent.post('/api/invoices').send({ loadId: ctx.load.id, kind: 'dispatch_fee' });
    expect(fee.body.invoice.meta.remitTo).toBeNull();
    const s2 = await setup(A, { ref: 'F-OWN' });
    await A.agent.patch(`/api/customers/${s2.customer.id}`).send({ factoringCompanyId: apex.id });
    const own = await A.agent.post('/api/invoices').send({ loadId: s2.load.id, remitTo: 'Blue Line Trucking\nPO Box 1, Dallas TX' });
    expect(own.body.invoice.meta.remitTo).toBe('Blue Line Trucking\nPO Box 1, Dallas TX');

    const one = await A.agent.get(`/api/invoices/${inv.id}`);
    expect(one.body.factoringTerms).toMatchObject({ companyId: apex.id, companyName: 'Apex Capital', clientNo: 'BL-2231', advancePct: 90, feePct: 3, suggested: { advanceCents: 189000, feeCents: 6300, reserveCents: 14700 } });
    expect(one.body.invoice.factoring).toBeNull();
  });

  it('downloads a PDF with the invoice number and total in its text, whatever characters the invoice holds', async () => {
    await A.agent.patch(`/api/invoices/${inv.id}`).send({ notes: 'Thanks “partner” → paid in 30 😀', items: [...inv.items, { kind: 'lumper', description: 'Lumper − receipt ✓ attached', quantity: 1, unitCents: 0 }] });
    const res = await A.agent.get(`/api/invoices/${inv.id}/pdf`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="invoice-${inv.number}.pdf"`);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.body.subarray(0, 4).toString()).toBe('%PDF');
    const { text } = await pdfParse(res.body);
    expect(text).toContain(`Invoice #${inv.number}`);
    expect(text).toContain('$2,100.00');
    expect(text).toContain('Summit Logistics');
    expect(text).toContain('Apex Capital');
    expect(text).toContain('Dallas, TX -> Atlanta, GA');
    expect((await B.agent.get(`/api/invoices/${inv.id}/pdf`)).status).toBe(404);
  });

  it('lists the packet with missing paperwork, then sends it to the factoring company and records the submission', async () => {
    // No submission email yet.
    let packet = (await A.agent.get(`/api/invoices/${inv.id}/factoring-packet`)).body;
    expect(packet.problem).toMatch(/submission email/);
    expect(packet.missing).toEqual(['rate_confirmation', 'bol', 'pod']);
    expect(packet.attachments).toEqual([{ id: null, type: 'invoice', name: `invoice-${inv.number}.pdf`, generated: true }]);
    const noEmail = await A.agent.post(`/api/invoices/${inv.id}/send-to-factoring`).send({});
    expect(noEmail.status).toBe(400);
    expect(noEmail.body.error).toBe('Add the factoring company’s submission email on the carrier’s profile');
    await A.agent.patch(`/api/factoring-companies/${apex.id}`).send({ submitEmail: 'invoices@apex.test' });

    await makeDoc(A.user.id, { loadId: ctx.load.id, type: 'rate_confirmation' });
    const pod = await makeDoc(A.user.id, { loadId: ctx.load.id, type: 'pod' });
    packet = (await A.agent.get(`/api/invoices/${inv.id}/factoring-packet`)).body;
    expect(packet.problem).toBeNull();
    expect(packet.to).toBe('invoices@apex.test');
    expect(packet.missing).toEqual(['bol']);
    expect(packet.attachments.map((a) => a.type)).toEqual(['invoice', 'rate_confirmation', 'pod']);
    expect(packet.subject).toBe(`Invoice #${inv.number} · Blue Line Trucking · client BL-2231 · load F-100`);
    expect(packet.body).toContain(`Blue Line Trucking (MC ${ctx.carrier.mcNumber})`);
    expect(packet.body).toContain('Client number: BL-2231');
    expect(packet.body).toContain('Amount: $2,100.00');
    expect(packet.body).toContain('Load: ref F-100 · Dallas, TX → Atlanta, GA');
    expect((await B.agent.get(`/api/invoices/${inv.id}/factoring-packet`)).status).toBe(404);
    await makeDoc(A.user.id, { loadId: ctx.load.id, type: 'bol' });

    // API tokens never send.
    const { body: tok } = await A.agent.post('/api/tokens').send({ name: 'ext', expiresInDays: 30 });
    expect((await request(app).post(`/api/invoices/${inv.id}/send-to-factoring`).set('Authorization', `Bearer ${tok.token}`).send({})).status).toBe(403);

    // No mailbox: nothing is marked.
    expect((await A.agent.post(`/api/invoices/${inv.id}/send-to-factoring`).send({})).status).toBe(400);
    expect((await prisma.invoice.findUnique({ where: { id: inv.id } })).status).toBe('draft');
    await connect(A.agent);
    const sent = await A.agent.post(`/api/invoices/${inv.id}/send-to-factoring`).send({});
    expect(sent.status).toBe(200);
    expect(sent.body.outcome).toBe('sent');
    expect(sent.body.invoice.status).toBe('sent');
    expect(sent.body.invoice.meta.factoring).toMatchObject({ companyId: apex.id, name: 'Apex Capital', toEmail: 'invoices@apex.test' });
    expect(sent.body.invoice.meta.factoring.emailId).toBeTruthy();
    expect(sent.body.invoice.factoring).toMatchObject({ companyName: 'Apex Capital', advancedCents: 0 });
    expect((await prisma.load.findUnique({ where: { id: ctx.load.id } })).status).toBe('invoiced');
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    const msg = mail.sendMail.mock.calls[0][0];
    expect(msg.to).toContain('invoices@apex.test');
    expect(msg.subject).toBe(`Invoice #${inv.number} · Blue Line Trucking · client BL-2231 · load F-100`);
    expect(msg.attachments.map((a) => a.filename)).toEqual([`invoice-${inv.number}.pdf`, 'rate_confirmation.pdf', 'bol.pdf', 'pod.pdf']);
    const attached = msg.attachments[0].content;
    expect(attached.subarray(0, 4).toString()).toBe('%PDF');
    expect((await pdfParse(attached)).text).toContain(`Invoice #${inv.number}`);
    const email = await prisma.email.findUnique({ where: { id: sent.body.invoice.meta.factoring.emailId } });
    expect(email).toMatchObject({ carrierId: null, aiGenerated: false, toEmail: 'invoices@apex.test' });
    expect(email.body).toContain('Client number: BL-2231');
    const stored = await prisma.document.findMany({ where: { ownerId: A.user.id, type: 'invoice' } });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: sent.body.documentId, carrierId: ctx.carrier.id, loadId: ctx.load.id, originalName: `invoice-${inv.number}.pdf`, mimeType: 'application/pdf' });
    expect(await prisma.activity.count({ where: { carrierId: ctx.carrier.id, summary: { contains: 'for factoring' } } })).toBe(1);

    // A second click right away is refused; nothing is emailed twice.
    const again = await A.agent.post(`/api/invoices/${inv.id}/send-to-factoring`).send({});
    expect(again.status).toBe(409);
    const both = await Promise.all([1, 2].map(() => A.agent.post(`/api/invoices/${inv.id}/send-to-factoring`).send({})));
    expect(both.map((r) => r.status)).toEqual([409, 409]);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);

    // Sent again later with a chosen attachment: the stored PDF is replaced, not piled up, and the sent invoice stays sent.
    const row = await prisma.invoice.findUnique({ where: { id: inv.id } });
    const data = JSON.parse(row.lines);
    data.meta.factoring.submittedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await prisma.invoice.update({ where: { id: inv.id }, data: { lines: JSON.stringify(data) } });
    const resend = await A.agent.post(`/api/invoices/${inv.id}/send-to-factoring`).send({ documentIds: [pod.id, stored[0].id], subject: 'Resubmitting', body: 'Second try' });
    expect(resend.status).toBe(200);
    const msg2 = mail.sendMail.mock.calls.at(-1)[0];
    expect(msg2.subject).toBe('Resubmitting');
    expect(msg2.attachments.map((a) => a.filename)).toEqual([`invoice-${inv.number}.pdf`, 'pod.pdf']);
    const storedAfter = await prisma.document.findMany({ where: { ownerId: A.user.id, type: 'invoice' } });
    expect(storedAfter.map((d) => d.id)).toEqual([stored[0].id]);
    expect(storedAfter[0].storedName).not.toBe(stored[0].storedName);
    expect(fs.existsSync(path.join(docDir, stored[0].storedName))).toBe(false);
    expect(fs.existsSync(path.join(docDir, storedAfter[0].storedName))).toBe(true);
    expect(resend.body.invoice.status).toBe('sent');
  });

  it('refuses invoices that cannot be factored and reports a failed delivery without marking anything', async () => {
    const C = await registerUser();
    const s = await setup(C, { ref: 'F-NO' });
    const draft = (await C.agent.post('/api/invoices').send({ loadId: s.load.id })).body.invoice;
    const noCompany = await C.agent.post(`/api/invoices/${draft.id}/send-to-factoring`).send({});
    expect(noCompany.status).toBe(400);
    expect(noCompany.body.error).toMatch(/factoring company on its customer profile/);
    const feeInv = (await C.agent.post('/api/invoices').send({ loadId: s.load.id, kind: 'dispatch_fee' })).body.invoice;
    expect((await C.agent.post(`/api/invoices/${feeInv.id}/send-to-factoring`).send({})).status).toBe(400);
    expect((await C.agent.get(`/api/invoices/${feeInv.id}/factoring-packet`)).status).toBe(400);

    const company = (await C.agent.post('/api/factoring-companies').send({ name: 'RTS', submitEmail: 'docs@rts.test' })).body.company;
    await C.agent.patch(`/api/customers/${s.customer.id}`).send({ factoringCompanyId: company.id });
    await connect(C.agent);
    const tooMany = await Promise.all([1, 2, 3, 4, 5].map((i) => makeDoc(C.user.id, { loadId: s.load.id, type: 'other' })));
    expect((await C.agent.post(`/api/invoices/${draft.id}/send-to-factoring`).send({ documentIds: tooMany.map((d) => d.id) })).status).toBe(400);
    mail.sendMail.mockRejectedValueOnce(new Error('550 mailbox unavailable'));
    const failed = await C.agent.post(`/api/invoices/${draft.id}/send-to-factoring`).send({});
    expect(failed.status).toBe(502);
    const row = await prisma.invoice.findUnique({ where: { id: draft.id } });
    expect(row.status).toBe('draft');
    expect(JSON.parse(row.lines).meta.factoring).toBeUndefined();
    expect((await prisma.load.findUnique({ where: { id: s.load.id } })).status).toBe('delivered');
    // An invoice already emailed to the broker keeps its status; only the submission is recorded.
    await C.agent.post(`/api/invoices/${draft.id}/mark-sent`);
    const sentBefore = (await prisma.invoice.findUnique({ where: { id: draft.id } })).sentAt;
    const ok = await C.agent.post(`/api/invoices/${draft.id}/send-to-factoring`).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.invoice.meta.factoring.name).toBe('RTS');
    expect(new Date(ok.body.invoice.sentAt).getTime()).toBe(new Date(sentBefore).getTime());
  });

  it('records advance, fee and reserve; paid in full moves the load to paid and overpaying is refused', async () => {
    expect((await A.agent.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 189000, kind: 'bogus' })).status).toBe(400);
    const adv = await A.agent.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 189000, kind: 'advance', method: 'ACH' });
    expect(adv.status).toBe(200);
    expect(adv.body.invoice).toMatchObject({ status: 'partial', paidCents: 189000, balanceCents: 21000 });
    expect(adv.body.invoice.factoring).toMatchObject({ companyName: 'Apex Capital', advancedCents: 189000, feeCents: 0, reserveReleasedCents: 0, reservePendingCents: 21000 });
    const fee = await A.agent.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 6300, kind: 'fee' });
    expect(fee.body.invoice.factoring).toMatchObject({ feeCents: 6300, reservePendingCents: 14700 });
    expect((await A.agent.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 14701, kind: 'reserve' })).status).toBe(400);
    const reserve = await A.agent.post(`/api/invoices/${inv.id}/payments`).send({ amountCents: 14700, kind: 'reserve' });
    expect(reserve.body.invoice).toMatchObject({ status: 'paid', paidCents: 210000, balanceCents: 0 });
    expect(reserve.body.invoice.factoring).toMatchObject({ advancedCents: 189000, feeCents: 6300, reserveReleasedCents: 14700, reservePendingCents: 0 });
    expect(reserve.body.invoice.meta.payments.map((p) => p.kind)).toEqual(['advance', 'fee', 'reserve']);
    expect((await prisma.load.findUnique({ where: { id: ctx.load.id } })).status).toBe('paid');
    // The factoring submission survives the payments.
    expect(reserve.body.invoice.meta.factoring.name).toBe('Apex Capital');
    const page = await A.agent.get(`/api/invoices/${inv.id}/print`);
    expect(page.text).toContain('Advance from factoring');
    expect(page.text).toContain('Factoring fee');

    const fees = (await A.agent.get(`/api/invoices?loadId=${ctx.load.id}&kind=dispatch_fee`)).body.items[0];
    await A.agent.post(`/api/invoices/${fees.id}/mark-sent`);
    expect((await A.agent.post(`/api/invoices/${fees.id}/payments`).send({ amountCents: 100, kind: 'advance' })).status).toBe(400);
  });

  it('includes factoring companies in the data export', async () => {
    const exp = await A.agent.get('/api/settings/export');
    expect(exp.status).toBe(200);
    const data = JSON.parse(exp.text);
    expect(data.factoringCompanies.map((c) => c.name)).toEqual(['Apex Capital']);
    expect(data.factoringCompanies[0].ownerId).toBe(A.user.id);
  });
});
