import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mail = vi.hoisted(() => ({
  sendMail: vi.fn(async (m) => ({ messageId: m.messageId, accepted: [m.to], rejected: [] })),
}));
vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => ({ verify: async () => true, sendMail: mail.sendMail, close: () => {} }));
  return { default: { createTransport }, createTransport };
});

const { registerUser, prisma } = await import('./helpers.js');
const { config } = await import('../src/config.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { buildMime } = await import('../src/services/email/mime.js');
const { queueUserEmail } = await import('../src/services/email/compose.js');
const { deliverEmail } = await import('../src/services/email/index.js');

const docDir = path.join(config.uploadDir, 'documents');
fs.mkdirSync(docDir, { recursive: true });

let n = 0;
async function makeDoc(ownerId, { bytes = Buffer.from('%PDF-1.4 test document'), name = 'rate-con.pdf', sizeBytes, write = true, carrierId = null } = {}) {
  n += 1;
  const storedName = `att-${Date.now()}-${n}.pdf`;
  if (write) fs.writeFileSync(path.join(docDir, storedName), bytes);
  return prisma.document.create({
    data: { ownerId, uploadedById: ownerId, carrierId, type: 'rate_confirmation', originalName: name, storedName, mimeType: 'application/pdf', sizeBytes: sizeBytes ?? bytes.length },
  });
}

async function connect(a) {
  const res = await a.post('/api/email/accounts/smtp').send({ provider: 'hostinger', fromEmail: `att${Date.now()}@dispatch.test`, password: 'pw', cooldownSeconds: 0 });
  expect(res.status).toBe(201);
  return res.body.account;
}

beforeEach(() => { mail.sendMail.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

describe('email attachments', () => {
  it('sends stored documents as attachments and records them on the email', async () => {
    const A = await registerUser();
    await connect(A.agent);
    const d1 = await makeDoc(A.user.id, { name: 'Rate con #1.pdf' });
    const d2 = await makeDoc(A.user.id, { name: 'POD.pdf', bytes: Buffer.from('%PDF-1.4 pod') });
    const res = await A.agent.post('/api/email/messages').send({ toEmail: 'ap@broker.test', subject: 'Invoice', body: 'Attached.', mode: 'send', documentIds: [d1.id, d2.id] });
    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe('sent');
    expect(res.body.email.attachments.map((a) => a.name)).toEqual(['Rate con #1.pdf', 'POD.pdf']);
    const sent = mail.sendMail.mock.calls[0][0];
    expect(sent.attachments).toHaveLength(2);
    expect(sent.attachments[0]).toMatchObject({ filename: 'Rate con #1.pdf', contentType: 'application/pdf' });
    expect(sent.attachments[1].content.toString()).toBe('%PDF-1.4 pod');
  });

  it('validates count, size and ownership', async () => {
    const A = await registerUser();
    const B = await registerUser();
    await connect(A.agent);
    const mine = await makeDoc(A.user.id);
    const theirs = await makeDoc(B.user.id);
    const six = await Promise.all(Array.from({ length: 6 }, () => makeDoc(A.user.id)));
    const big = await makeDoc(A.user.id, { sizeBytes: 11 * 1024 * 1024, write: false });
    const send = (documentIds) => A.agent.post('/api/email/messages').send({ toEmail: 'x@broker.test', subject: 's', body: 'b', mode: 'send', documentIds });
    expect((await send(six.map((d) => d.id))).status).toBe(400);
    const foreign = await send([mine.id, theirs.id]);
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toMatch(/not found/);
    expect((await send(['does-not-exist'])).status).toBe(400);
    const tooBig = await send([big.id]);
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toMatch(/10 MB/);
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('fails the email with a clear reason when a file is missing at send time', async () => {
    const A = await registerUser();
    const acc = await connect(A.agent);
    const gone = await makeDoc(A.user.id, { write: false, name: 'missing.pdf' });
    const email = await prisma.email.create({
      data: { userId: A.user.id, emailAccountId: acc.id, toEmail: 'y@broker.test', subject: 's', body: 'b', status: 'scheduled', scheduledAt: new Date(), attachments: JSON.stringify([{ documentId: gone.id, name: 'missing.pdf', size: 10 }]) },
    });
    const r = await deliverEmail(email.id, { retry: true });
    expect(r.outcome).toBe('failed');
    expect(r.email.error).toMatch(/missing\.pdf/);
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('drafts keep attachments and only accept the caller\'s own mailbox', async () => {
    const A = await registerUser();
    const B = await registerUser();
    await connect(A.agent);
    const accB = await connect(B.agent);
    const d = await makeDoc(A.user.id);
    const leak = await A.agent.post('/api/email/messages').send({ toEmail: 'z@x.test', subject: 'Draft', body: 'b', mode: 'draft', accountId: accB.id });
    expect(leak.status).toBe(400);
    const draft = await A.agent.post('/api/email/messages').send({ toEmail: 'z@x.test', subject: 'Draft', body: 'b', mode: 'draft', documentIds: [d.id] });
    expect(draft.status).toBe(201);
    expect(draft.body.email.attachments).toHaveLength(1);
    expect((await A.agent.patch(`/api/email/messages/${draft.body.email.id}`).send({ accountId: accB.id })).status).toBe(400);
    const cleared = await A.agent.patch(`/api/email/messages/${draft.body.email.id}`).send({ documentIds: [] });
    expect(cleared.body.email.attachments).toEqual([]);
    const got = await A.agent.get(`/api/email/messages/${draft.body.email.id}`);
    expect(got.body.email.emailAccount).toBeNull();
    expect((await B.agent.get(`/api/email/messages/${draft.body.email.id}`)).status).toBe(404);
  });

  it('queueUserEmail attaches documents for other features', async () => {
    const A = await registerUser();
    await connect(A.agent);
    const d = await makeDoc(A.user.id, { name: 'invoice-1001.pdf' });
    const user = await prisma.user.findUnique({ where: { id: A.user.id }, include: { teamMembership: true } });
    const out = await queueUserEmail({ user, toEmail: 'billing@broker.test', subject: 'Invoice 1001', body: 'Please find attached.', documentIds: [d.id] });
    expect(out.outcome).toBe('sent');
    expect(mail.sendMail.mock.calls[0][0].attachments[0].filename).toBe('invoice-1001.pdf');
  });

  it('builds multipart/mixed MIME with encoded file names', () => {
    const mime = buildMime({
      from: 'a@x.test', to: 'b@y.test', subject: 'Packet', text: 'hi', messageId: '<m1@x.test>',
      attachments: [{ filename: 'Résumé.pdf', content: Buffer.from('PDFDATA'), contentType: 'application/pdf' }],
    });
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="dm_/);
    expect(mime).toMatch(/Message-ID: <m1@x\.test>/);
    expect(mime).toContain("filename*=UTF-8''R%C3%A9sum%C3%A9.pdf");
    expect(mime).toContain(Buffer.from('PDFDATA').toString('base64'));
  });

  it('Gmail sends messages with attachments through the upload endpoint', async () => {
    const A = await registerUser();
    const acc = await prisma.emailAccount.create({
      data: { userId: A.user.id, provider: 'gmail', label: 'G', fromEmail: 'g@gmail.test', status: 'connected', secretEnc: encrypt('refresh'), accessTokenEnc: encrypt('access'), tokenExpiresAt: new Date(Date.now() + 3600000), isDefault: true, cooldownSeconds: 0 },
    });
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => { calls.push({ url, opts }); return { status: 200, json: async () => ({ id: 'gm1' }) }; }));
    const d = await makeDoc(A.user.id);
    const email = await prisma.email.create({ data: { userId: A.user.id, emailAccountId: acc.id, toEmail: 'r@x.test', subject: 's', body: 'b', status: 'scheduled', scheduledAt: new Date(), attachments: JSON.stringify([{ documentId: d.id, name: d.originalName, size: d.sizeBytes }]) } });
    const r = await deliverEmail(email.id, { retry: false });
    expect(r.outcome).toBe('sent');
    expect(calls[0].url).toMatch(/\/upload\/gmail\/v1\/users\/me\/messages\/send\?uploadType=media/);
    expect(calls[0].opts.headers['Content-Type']).toBe('message/rfc822');
    expect(calls[0].opts.body).toMatch(/multipart\/mixed/);
    expect(calls[0].opts.signal).toBeDefined();
  });

  it('Microsoft sends small attachments inline and large ones through an upload session', async () => {
    const A = await registerUser();
    const acc = await prisma.emailAccount.create({
      data: { userId: A.user.id, provider: 'outlook', label: 'O', fromEmail: 'o@outlook.test', status: 'connected', secretEnc: encrypt('refresh'), accessTokenEnc: encrypt('access'), tokenExpiresAt: new Date(Date.now() + 3600000), isDefault: true, cooldownSeconds: 0, dailyLimit: 100 },
    });
    const calls = [];
    const reply = (status, body = {}, headers = {}) => ({ status, ok: status < 300, json: async () => body, headers: { get: (k) => headers[k] ?? null } });
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      calls.push({ url, method: opts.method, opts });
      if (url.endsWith('/me/sendMail')) return reply(202, {}, { 'request-id': 'req-1' });
      if (url.endsWith('/me/messages')) return reply(201, { id: 'draft1', internetMessageId: '<graph-id@outlook.test>' });
      if (url.endsWith('/createUploadSession')) return reply(201, { uploadUrl: 'https://upload.test/session1' });
      if (url.startsWith('https://upload.test/')) return reply(opts.headers['Content-Range'].endsWith(`/${4 * 1024 * 1024}`) && opts.headers['Content-Range'].startsWith(`bytes ${4 * 1024 * 1024 - Number(opts.headers['Content-Length'])}`) ? 201 : 200);
      if (url.endsWith('/send')) return reply(202);
      return reply(404);
    }));
    const small = await makeDoc(A.user.id, { name: 'small.pdf' });
    const e1 = await prisma.email.create({ data: { userId: A.user.id, emailAccountId: acc.id, toEmail: 'r@x.test', subject: 's', body: 'b', status: 'scheduled', scheduledAt: new Date(), attachments: JSON.stringify([{ documentId: small.id, name: 'small.pdf', size: small.sizeBytes }]) } });
    expect((await deliverEmail(e1.id, { retry: false })).outcome).toBe('sent');
    const inline = JSON.parse(calls[0].opts.body);
    expect(inline.message.attachments[0]).toMatchObject({ '@odata.type': '#microsoft.graph.fileAttachment', name: 'small.pdf' });

    calls.length = 0;
    const large = await makeDoc(A.user.id, { name: 'large.pdf', bytes: Buffer.alloc(4 * 1024 * 1024, 7) });
    const e2 = await prisma.email.create({ data: { userId: A.user.id, emailAccountId: acc.id, toEmail: 'r2@x.test', subject: 's', body: 'b', status: 'scheduled', scheduledAt: new Date(), attachments: JSON.stringify([{ documentId: large.id, name: 'large.pdf', size: large.sizeBytes }]) } });
    const r2 = await deliverEmail(e2.id, { retry: false });
    expect(r2.outcome).toBe('sent');
    expect(calls.map((c) => c.url.replace('https://graph.microsoft.com/v1.0', ''))).toEqual(expect.arrayContaining(['/me/messages', '/me/messages/draft1/attachments/createUploadSession', '/me/messages/draft1/send']));
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.length).toBeGreaterThan(1);
    expect(puts.every((p) => !p.opts.headers.Authorization)).toBe(true);
    expect((await prisma.email.findUnique({ where: { id: e2.id } })).messageId).toBe('<graph-id@outlook.test>');
  });
});
