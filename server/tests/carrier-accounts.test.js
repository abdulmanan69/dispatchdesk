import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';

// Platform mail is captured: the sign-in code is read from the subject line.
const sent = [];
vi.mock('../src/services/email/system.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sendSystemMail: vi.fn(async (msg) => { sent.push(msg); return { sent: true, messageId: `m${sent.length}` }; }),
}));

const { app, agent, registerUser, prisma } = await import('./helpers.js');
const { setProfileFetch, clearProfileCache } = await import('../src/services/carriers/profile.js');
const { clearCensusCache } = await import('../src/services/carriers/fmcsaCensus.js');
const { maskEmail, parseNumber } = await import('../src/services/carrierAccounts/index.js');

const DOT = '3636864';
const CENSUS = { dot_number: DOT, legal_name: "DEAN'S LOGISTICS LLC", email_address: 'DeanGordon015@Gmail.com', docket1prefix: 'MC', docket1: '1248213', status_code: 'A' };
const NO_EMAIL = { dot_number: '4000001', legal_name: 'NO MAIL TRUCKING', email_address: '', status_code: 'A' };
const reply = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });

function fakeCensus() {
  setProfileFetch(vi.fn(async (input) => {
    const u = new URL(String(input));
    const where = u.searchParams.get('$where') || '';
    if (where.includes(`'${DOT}'`) || where.includes("docket1='1248213'")) return reply([CENSUS]);
    if (where.includes("'4000001'")) return reply([NO_EMAIL]);
    return reply([]);
  }));
}
const codeOf = (mail) => /^(\d{6}) /.exec(mail.subject)?.[1];
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

async function signIn(number = DOT) {
  const a = await agent();
  const start = await a.post('/api/public/carrier/login/start').send({ number });
  expect(start.status).toBe(200);
  const code = codeOf(sent.at(-1));
  const res = await a.post('/api/public/carrier/login/verify').send({ number, code });
  expect(res.status).toBe(200);
  return a;
}
const upload = (a, type, expiresAt = '') => a.post('/api/public/carrier/documents').field('type', type).field('expiresAt', expiresAt).attach('file', PDF, { filename: `${type}.pdf`, contentType: 'application/pdf' });

let stageId;
beforeAll(async () => {
  stageId = (await prisma.pipelineStage.findUnique({ where: { key: 'lead' } })).id;
});
afterAll(() => setProfileFetch(null));
beforeEach(async () => {
  sent.length = 0;
  clearCensusCache();
  clearProfileCache();
  fakeCensus();
  await prisma.carrierLoginCode.deleteMany({});
});

const makeCarrier = (ownerId, data = {}) => prisma.carrier.create({ data: { ownerId, stageId, companyName: "Dean's Logistics", dotNumber: DOT, ...data } });
const makeLink = (owner, carrier) => prisma.onboardingLink.create({
  data: {
    ownerId: owner.id, carrierId: carrier.id, tokenHash: `h${Date.now()}${Math.random()}`, agreementTitle: 'Dispatch agreement', agreementBody: 'Terms',
    agreementHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 7 * 86_400_000),
  },
});

describe('carrier sign-in', () => {
  it('parses numbers and masks emails', () => {
    expect(parseNumber('USDOT 3636864')).toEqual({ dot: '3636864' });
    expect(parseNumber('MC-1248213')).toEqual({ mc: '1248213' });
    expect(parseNumber('hello')).toBeNull();
    expect(maskEmail('deangordon015@gmail.com')).toBe('de***********@gmail.com');
  });

  it('sends a code to the FMCSA email on file and signs in with it (by USDOT or MC)', async () => {
    const a = await agent();
    const start = await a.post('/api/public/carrier/login/start').send({ number: 'MC 1248213' });
    expect(start.status).toBe(200);
    expect(start.body).toEqual({ dot: DOT, maskedEmail: 'de***********@gmail.com', expiresInMinutes: 10 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('deangordon015@gmail.com');
    expect(sent[0].text).toContain("DEAN'S LOGISTICS LLC (USDOT 3636864)");
    const code = codeOf(sent[0]);

    const wrong = await a.post('/api/public/carrier/login/verify').send({ number: DOT, code: code === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/4 tries left/);

    const ok = await a.post('/api/public/carrier/login/verify').send({ number: DOT, code });
    expect(ok.status).toBe(200);
    expect(ok.headers['set-cookie'].join(';')).toMatch(/dd_carrier=[^;]+;.*HttpOnly/i);
    const me = await a.get('/api/public/carrier/me');
    expect(me.status).toBe(200);
    expect(me.body.account).toMatchObject({ dotNumber: DOT, legalName: "DEAN'S LOGISTICS LLC", email: 'de***********@gmail.com' });
    // A code works once.
    const again = await (await agent()).post('/api/public/carrier/login/verify').send({ number: DOT, code });
    expect(again.status).toBe(400);
  });

  it('refuses unknown numbers, carriers without an FMCSA email, and a 4th code within the hour', async () => {
    const a = await agent();
    expect((await a.post('/api/public/carrier/login/start').send({ number: '9999999' })).status).toBe(404);
    const noMail = await a.post('/api/public/carrier/login/start').send({ number: '4000001' });
    expect(noMail.status).toBe(422);
    expect(noMail.body.error).toMatch(/no email address on file/);
    for (let i = 0; i < 3; i++) expect((await a.post('/api/public/carrier/login/start').send({ number: DOT })).status).toBe(200);
    expect((await a.post('/api/public/carrier/login/start').send({ number: DOT })).status).toBe(429);
  });

  it('locks a code after 5 wrong tries', async () => {
    const a = await agent();
    await a.post('/api/public/carrier/login/start').send({ number: DOT });
    const code = codeOf(sent.at(-1));
    const bad = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await a.post('/api/public/carrier/login/verify').send({ number: DOT, code: bad });
    const locked = await a.post('/api/public/carrier/login/verify').send({ number: DOT, code });
    expect(locked.status).toBe(429);
  });

  it('needs a session (and the CSRF header for writes); logout ends it', async () => {
    expect((await request(app).get('/api/public/carrier/me')).status).toBe(401);
    const a = await signIn();
    const noCsrf = await a.raw.post('/api/public/carrier/logout');
    expect(noCsrf.status).toBe(403);
    expect((await a.post('/api/public/carrier/logout')).status).toBe(200);
    expect((await a.get('/api/public/carrier/me')).status).toBe(401);
  });
});

describe('carrier vault and sharing', () => {
  let A;
  let B;
  let C;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    C = await registerUser();
  });

  it('shows only dispatchers that invited the carrier; shares documents with one of them on request', async () => {
    const mine = await makeCarrier(A.user.id);
    await makeLink(A.user, mine);
    const lead = await makeCarrier(B.user.id); // B only has the carrier as a lead: never shown, never shared with
    const other = await makeCarrier(C.user.id, { dotNumber: '1111111' });
    await makeLink(C.user, other); // C invited a different USDOT number

    const a = await signIn();
    let me = (await a.get('/api/public/carrier/me')).body;
    expect(me.connections.map((x) => x.id)).toEqual([mine.id]);
    expect(me.connections[0]).toMatchObject({ relationship: 'invited', agreement: { status: 'pending' }, share: null, statements: false });

    // Upload a COI and a W-9, then share them with A.
    expect((await upload(a, 'coi', '2027-06-30')).status).toBe(201);
    expect((await upload(a, 'w9')).status).toBe(201);
    me = (await a.get('/api/public/carrier/me')).body;
    expect(me.documents.map((d) => d.type).sort()).toEqual(['coi', 'w9']);

    const share = await a.put(`/api/public/carrier/connections/${mine.id}/share`).send({ docTypes: ['coi', 'w9'], autoUpdate: true });
    expect(share.status).toBe(200);
    expect(share.body.copied).toBe(2);
    const docsA = await prisma.document.findMany({ where: { carrierId: mine.id, source: 'carrier_profile' } });
    expect(docsA.map((d) => d.type).sort()).toEqual(['coi', 'w9']);
    expect(docsA.find((d) => d.type === 'coi').expiresAt.toISOString().slice(0, 10)).toBe('2027-06-30');
    expect(await prisma.document.count({ where: { carrierId: lead.id } })).toBe(0);
    // Sharing again copies nothing new.
    expect((await a.put(`/api/public/carrier/connections/${mine.id}/share`).send({ docTypes: ['coi', 'w9'] })).body.copied).toBe(0);
    // Not a connection: 404.
    expect((await a.put(`/api/public/carrier/connections/${lead.id}/share`).send({ docTypes: ['coi'] })).status).toBe(404);

    // A renewed COI goes to A automatically and replaces the old one in the vault.
    const renewed = await upload(a, 'coi', '2028-06-30');
    expect(renewed.body.sentTo).toBe(1);
    expect(await prisma.document.count({ where: { carrierId: mine.id, source: 'carrier_profile', type: 'coi' } })).toBe(2);
    expect((await a.get('/api/public/carrier/me')).body.documents.filter((d) => d.type === 'coi')).toHaveLength(1);

    // A sees its own share on the carrier record; B (lead only) sees nothing.
    const recA = await A.agent.get(`/api/carriers/${mine.id}`);
    expect(recA.body.carrier.carrierProfile).toMatchObject({ active: true, docTypes: ['coi', 'w9'], autoUpdate: true });
    expect(recA.body.carrier.carrierProfile.verifiedAt).toBeTruthy();
    const recB = await B.agent.get(`/api/carriers/${lead.id}`);
    expect(recB.body.carrier.carrierProfile).toBeNull();

    // Stop sharing: the next upload is not sent; files A already has stay.
    expect((await a.post(`/api/public/carrier/connections/${mine.id}/stop`).send({})).status).toBe(200);
    expect((await upload(a, 'coi', '2029-06-30')).body.sentTo).toBe(0);
    expect(await prisma.document.count({ where: { carrierId: mine.id, source: 'carrier_profile' } })).toBe(3);
    expect((await A.agent.get(`/api/carriers/${mine.id}`)).body.carrier.carrierProfile.active).toBe(false);

    // Hide: the connection drops to the end of the list and is marked hidden.
    const hidden = await a.post(`/api/public/carrier/connections/${mine.id}/stop`).send({ hide: true });
    expect(hidden.body.connections[0].share.hidden).toBe(true);
  });

  it('downloads and deletes its own documents only', async () => {
    const a = await signIn();
    const up = await upload(a, 'noa');
    const id = up.body.document.id;
    const file = await a.get(`/api/public/carrier/documents/${id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect((await request(app).get(`/api/public/carrier/documents/${id}/file`)).status).toBe(401);
    expect((await a.delete(`/api/public/carrier/documents/${id}`)).status).toBe(200);
    expect((await a.get(`/api/public/carrier/documents/${id}/file`)).status).toBe(404);
    expect((await upload(a, 'not_a_type')).status).toBe(400);
  });

  it('a carrier can delete its profile; dispatchers keep the copies they received', async () => {
    const a = await signIn();
    const id = (await upload(a, 'cdl')).body.document.id;
    const doc = await prisma.carrierVaultDocument.findUnique({ where: { id } });
    expect((await a.delete('/api/public/carrier/me')).status).toBe(200);
    expect(await prisma.carrierAccount.findUnique({ where: { dotNumber: DOT } })).toBeNull();
    expect(await prisma.carrierVaultDocument.findUnique({ where: { id: doc.id } })).toBeNull();
    expect((await a.get('/api/public/carrier/me')).status).toBe(401);
  });

  it('shows statements only when the dispatcher turned on the portal for this customer', async () => {
    const rec = await makeCarrier(C.user.id, { companyName: 'Statement Carrier' });
    const customer = await prisma.customer.create({ data: { carrierId: rec.id, ownerId: C.user.id } });
    const a = await signIn();
    const conn = (await a.get('/api/public/carrier/me')).body.connections.find((x) => x.id === rec.id);
    expect(conn).toMatchObject({ relationship: 'customer', statements: false });
    expect((await a.get(`/api/public/carrier/connections/${rec.id}/statements`)).status).toBe(404);
    await prisma.customer.update({ where: { id: customer.id }, data: { portalTokenHash: `p${Date.now()}`, portalExpiresAt: new Date(Date.now() + 86_400_000) } });
    const st = await a.get(`/api/public/carrier/connections/${rec.id}/statements`);
    expect(st.status).toBe(200);
    expect(st.body.weeks).toHaveLength(12);
    expect(st.body.dispatcher.email).toBe(C.email);
  });
});
