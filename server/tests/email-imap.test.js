import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const mail = vi.hoisted(() => ({
  sendMail: vi.fn(async (m) => ({ messageId: m.messageId, accepted: [m.to], rejected: [] })),
}));
vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => ({ verify: async () => true, sendMail: mail.sendMail, close: () => {} }));
  return { default: { createTransport }, createTransport };
});

// Fake IMAP server: a mailbox with messages and raw sources, recording what the client asked for.
const imap = vi.hoisted(() => ({ mailbox: { uidNext: 1, exists: 0 }, messages: [], bodies: new Map(), connectError: null, fetches: [], opened: [], lastOpts: null }));
vi.mock('imapflow', () => ({
  ImapFlow: class {
    constructor(opts) { imap.lastOpts = opts; }
    async connect() { if (imap.connectError) throw imap.connectError; }
    async mailboxOpen(path, o) { imap.opened.push({ path, ...o }); return { ...imap.mailbox }; }
    async* fetch(range) {
      imap.fetches.push(range);
      const [a, b] = range.split(':').map(Number);
      for (const m of imap.messages) if (m.uid >= a && m.uid <= b) yield m;
    }
    async fetchOne(uid) { const src = imap.bodies.get(Number(uid)); return src ? { uid: Number(uid), source: Buffer.from(src) } : false; }
    async logout() {}
    close() {}
  },
}));

const { registerUser, prisma } = await import('./helpers.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { enrollCarriers } = await import('../src/services/sequenceEngine.js');
const imapLib = await import('../src/services/email/imap.js');
const { parseHeaders, messageIds, isAutoReply, looksLikeBounce, parseBounce, parseGoogleVoice, pollMailbox, dueMailboxes } = imapLib;

const msg = (uid, { from, subject = 'Re: Loads', headers = '', date = new Date() }) => ({
  uid, envelope: { from: [{ address: from }], subject }, headers: Buffer.from(headers), internalDate: date,
});

const dsn = (rcpt, messageId) => [
  'From: Mail Delivery System <MAILER-DAEMON@mx.test>', 'To: me@dispatch.test', 'Subject: Undelivered Mail Returned to Sender', 'MIME-Version: 1.0',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="B"', '',
  '--B', 'Content-Type: text/plain', '', 'This is the mail system. Your message could not be delivered.', '',
  '--B', 'Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; mx.test', '', `Final-Recipient: rfc822; ${rcpt}`, 'Action: failed', 'Status: 5.1.1', 'Diagnostic-Code: smtp; 550 5.1.1 User unknown', '',
  '--B', 'Content-Type: text/rfc822-headers', '', `Message-ID: ${messageId}`, 'From: me@dispatch.test', `To: ${rcpt}`, 'Subject: Hi', '',
  '--B--', '',
].join('\r\n');

let counter = 0;
async function makeCarrier(ownerId, data = {}) {
  const stage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
  counter += 1;
  return prisma.carrier.create({ data: { ownerId, stageId: stage.id, companyName: `Inbox Carrier ${counter}`, ...data } });
}

async function smtpAccount(a, extra = {}) {
  const res = await a.post('/api/email/accounts/smtp').send({ provider: 'hostinger', fromEmail: `box${Date.now()}${counter++}@dispatch.test`, password: 'pw', cooldownSeconds: 0, ...extra });
  expect(res.status).toBe(201);
  return res.body.account;
}

beforeEach(() => {
  mail.sendMail.mockClear();
  Object.assign(imap, { mailbox: { uidNext: 1, exists: 0 }, messages: [], bodies: new Map(), connectError: null, fetches: [], opened: [] });
});

describe('parsing helpers', () => {
  it('reads headers, message ids and automatic replies', () => {
    const h = parseHeaders('In-Reply-To: <A@x.test>\r\nReferences: <b@x.test>\r\n <c@x.test>\r\nAuto-Submitted: auto-replied\r\n');
    expect(messageIds(h.references)).toEqual(['<b@x.test>', '<c@x.test>']);
    expect(messageIds(h['in-reply-to'])).toEqual(['<a@x.test>']);
    expect(isAutoReply(h, 'Re: loads')).toBe(true);
    expect(isAutoReply({}, 'Out of Office: back Monday')).toBe(true);
    expect(isAutoReply({ 'auto-submitted': 'no' }, 'Re: rates')).toBe(false);
  });

  it('recognizes hard bounces and ignores delays', () => {
    expect(looksLikeBounce({ from: 'MAILER-DAEMON@mx.test', subject: 'x', headers: {} })).toBe(true);
    expect(looksLikeBounce({ from: 'carrier@x.test', subject: 'Re: hi', headers: {} })).toBe(false);
    const b = parseBounce({ text: 'Final-Recipient: rfc822; Bad@X.test\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 User unknown', originalHeaders: 'Message-ID: <Orig@x.test>' });
    expect(b).toMatchObject({ recipient: 'bad@x.test', status: '5.1.1', reason: '550 5.1.1 User unknown', originalMessageId: '<orig@x.test>' });
    expect(parseBounce({ text: 'Final-Recipient: rfc822; a@x.test\nAction: delayed\nStatus: 4.4.1' })).toBeNull();
  });

  it('reads Google Voice notices and nothing else', () => {
    expect(parseGoogleVoice({ from: 'voice-noreply@google.com', subject: 'New voicemail from (555) 123-4567 at 3:15 PM', text: 'Hi, call me back about the load\nPlay message' }))
      .toMatchObject({ kind: 'voicemail', phone: '5551234567', text: 'Hi, call me back about the load' });
    expect(parseGoogleVoice({ from: 'voice-noreply@google.com', subject: 'Missed call from John Smith (555) 222-3333', text: '' }))
      .toMatchObject({ kind: 'missed_call', phone: '5552223333', name: 'John Smith', text: null });
    expect(parseGoogleVoice({ from: '12345.6789@txt.voice.google.com', subject: 'New text message from (555) 444-5555', text: 'Is the truck empty?' }))
      .toMatchObject({ kind: 'text', phone: '5554445555' });
    expect(parseGoogleVoice({ from: 'someone@else.test', subject: 'Missed call from (555) 444-5555' })).toBeNull();
  });
});

describe('inbox polling', () => {
  let A; let B; let account; let user; let c1; let c2; let c3; let c4; let sentToC1; let sentToC3; let foreignEmail;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    const acc = await smtpAccount(A.agent);
    account = await prisma.emailAccount.update({ where: { id: acc.id }, data: { imapEnabled: true, imapHost: 'imap.dispatch.test', imapPort: 993, imapSecure: true } });
    user = await prisma.user.findUnique({ where: { id: A.user.id }, include: { teamMembership: true } });
    c1 = await makeCarrier(A.user.id, { email: 'c1@carrier.test' });
    c2 = await makeCarrier(A.user.id, { email: 'c2@carrier.test' });
    c3 = await makeCarrier(A.user.id, { email: 'c3@carrier.test' });
    c4 = await makeCarrier(A.user.id, { phone: '5551234567' });
    const s = await prisma.emailSequence.create({ data: { ownerId: A.user.id, name: 'Outreach', respectBusinessHours: false, steps: { create: [{ order: 0, dayOffset: 0, type: 'call' }, { order: 1, dayOffset: 2, type: 'call' }] } } });
    await enrollCarriers(user, s.id, [c1, c2, c3]);
    sentToC1 = (await A.agent.post('/api/email/messages').send({ carrierId: c1.id, subject: 'Loads for you', body: 'b', mode: 'send' })).body.email;
    sentToC3 = (await A.agent.post('/api/email/messages').send({ carrierId: c3.id, subject: 'Hi', body: 'b', mode: 'send' })).body.email;
    await smtpAccount(B.agent);
    foreignEmail = (await B.agent.post('/api/email/messages').send({ toEmail: 'c1@carrier.test', subject: 'B mail', body: 'b', mode: 'send' })).body.email;
    expect(sentToC1.messageId).toMatch(/^<dd\./);
  });

  it('handles replies, automatic replies, bounces and Google Voice notices', async () => {
    imap.mailbox = { uidNext: 107, exists: 6 };
    imap.messages = [
      msg(101, { from: 'c1@carrier.test', subject: 'Re: Loads for you', headers: `In-Reply-To: ${sentToC1.messageId}\r\n` }),
      msg(102, { from: 'c2@carrier.test', subject: 'Automatic reply: Loads', headers: 'Auto-Submitted: auto-replied\r\n' }),
      msg(103, { from: 'MAILER-DAEMON@mx.test', subject: 'Undelivered Mail Returned to Sender', headers: 'Content-Type: multipart/report; report-type=delivery-status; boundary="B"\r\n' }),
      msg(104, { from: 'voice-noreply@google.com', subject: 'New voicemail from (555) 123-4567 at 3:15 PM' }),
      msg(105, { from: 'random@spam.test', subject: 'Win a prize' }),
      msg(106, { from: 'x@other.test', subject: 'Re: B mail', headers: `In-Reply-To: ${foreignEmail.messageId}\r\n` }),
    ];
    imap.bodies.set(103, dsn('c3@carrier.test', sentToC3.messageId));
    imap.bodies.set(104, 'From: voice-noreply@google.com\r\nSubject: New voicemail\r\nContent-Type: text/plain\r\n\r\nHi, call me back about the load\r\nPlay message\r\n');

    const stats = await pollMailbox(account);
    expect(stats).toMatchObject({ checked: 6, replies: 1, autoReplies: 1, bounces: 1, googleVoice: 1, lastUid: 106 });
    expect(imap.opened[0]).toMatchObject({ path: 'INBOX', readOnly: true });

    // Reply: email marked, sequence stopped, follow-up created (already notified), notification sent.
    expect((await prisma.email.findUnique({ where: { id: sentToC1.id } })).repliedAt).not.toBeNull();
    const e1 = await prisma.sequenceEnrollment.findFirst({ where: { carrierId: c1.id } });
    expect(e1).toMatchObject({ status: 'stopped', stopReason: 'replied' });
    const fu = await prisma.followUp.findFirst({ where: { carrierId: c1.id, title: { startsWith: 'Reply from' } } });
    expect(fu.notifiedAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { userId: A.user.id, type: 'email_reply' } })).toBe(1);

    // Automatic reply: logged only.
    expect((await prisma.sequenceEnrollment.findFirst({ where: { carrierId: c2.id } })).status).toBe('active');
    expect(await prisma.activity.count({ where: { carrierId: c2.id, summary: { startsWith: 'Automatic reply' } } })).toBe(1);

    // Bounce: suppressed, carrier flagged, email marked, sequence stopped.
    expect(await prisma.emailSuppression.findUnique({ where: { ownerId_email: { ownerId: A.user.id, email: 'c3@carrier.test' } } })).toMatchObject({ reason: 'bounced' });
    expect((await prisma.carrier.findUnique({ where: { id: c3.id } })).doNotEmail).toBe(true);
    expect((await prisma.email.findUnique({ where: { id: sentToC3.id } })).bounceReason).toMatch(/User unknown/);
    expect((await prisma.sequenceEnrollment.findFirst({ where: { carrierId: c3.id } })).stopReason).toBe('bounced');

    // Google Voice: activity on the carrier with that phone number.
    const gv = await prisma.activity.findFirst({ where: { carrierId: c4.id } });
    expect(gv.summary).toMatch(/^Google Voice: voicemail from \(555\) 123-4567 — Hi, call me back about the load/);

    // Another user's email is never touched.
    expect((await prisma.email.findUnique({ where: { id: foreignEmail.id } })).repliedAt).toBeNull();

    const acc = await prisma.emailAccount.findUnique({ where: { id: account.id } });
    expect(acc).toMatchObject({ imapLastUid: 106, imapError: null });
    expect(acc.imapCheckedAt).not.toBeNull();

    // Nothing new: no fetch at all.
    const again = await pollMailbox(acc);
    expect(again.checked).toBe(0);
    expect(imap.fetches).toHaveLength(1);
  });

  it('ignores bounce notices for mail the user never sent (a forged DSN cannot suppress an address)', async () => {
    const acc = await prisma.emailAccount.findUnique({ where: { id: account.id } });
    const top = acc.imapLastUid;
    imap.mailbox = { uidNext: top + 2, exists: 1 };
    imap.messages = [msg(top + 1, { from: 'MAILER-DAEMON@mx.test', subject: 'Undelivered Mail Returned to Sender', headers: 'Content-Type: multipart/report; report-type=delivery-status; boundary="B"\r\n' })];
    imap.bodies.set(top + 1, dsn('c2@carrier.test', '<forged@elsewhere.test>'));
    const stats = await pollMailbox(acc);
    expect(stats).toMatchObject({ checked: 1, bounces: 0 });
    expect(await prisma.emailSuppression.findUnique({ where: { ownerId_email: { ownerId: A.user.id, email: 'c2@carrier.test' } } })).toBeNull();
    expect((await prisma.carrier.findUnique({ where: { id: c2.id } })).doNotEmail).toBe(false);
  });

  it('treats mail from a contact as a reply only when it answers something or the carrier is in a sequence', async () => {
    const acc = await prisma.emailAccount.findUnique({ where: { id: account.id } });
    await prisma.broker.create({ data: { ownerId: A.user.id, companyName: 'Load List Brokerage', email: 'loads@broker.test' } });
    const quiet = await makeCarrier(A.user.id, { email: 'customer@carrier.test' }); // a customer, no sequence, never emailed
    const top = acc.imapLastUid;
    imap.mailbox = { uidNext: top + 3, exists: 2 };
    imap.messages = [
      msg(top + 1, { from: 'loads@broker.test', subject: 'Hot loads out of Dallas' }),
      msg(top + 2, { from: 'customer@carrier.test', subject: 'BOL for load 1182' }),
    ];
    const notesBefore = await prisma.notification.count({ where: { userId: A.user.id, type: 'email_reply' } });
    const stats = await pollMailbox(acc);
    expect(stats).toMatchObject({ checked: 2, replies: 0, autoReplies: 0 });
    expect(await prisma.notification.count({ where: { userId: A.user.id, type: 'email_reply' } })).toBe(notesBefore);
    expect(await prisma.followUp.count({ where: { carrierId: quiet.id } })).toBe(0);
  });

  it('requires STARTTLS on port 143 so the password is never sent in clear text', () => {
    imapLib.createImapClient({ smtpUser: 'me@x.test', fromEmail: 'me@x.test', secretEnc: encrypt('pw') }, { host: 'imap.x.test', port: 143, secure: false });
    expect(imap.lastOpts).toMatchObject({ port: 143, secure: false, doSTARTTLS: true });
    imapLib.createImapClient({ smtpUser: 'me@x.test', fromEmail: 'me@x.test', secretEnc: encrypt('pw') }, { host: 'imap.x.test', port: 993, secure: true });
    expect(imap.lastOpts.secure).toBe(true);
    expect(imap.lastOpts).not.toHaveProperty('doSTARTTLS');
  });

  it('records sign-in failures and backs off', async () => {
    const acc = await smtpAccount(A.agent);
    await prisma.emailAccount.update({ where: { id: acc.id }, data: { imapEnabled: true, imapHost: 'imap.dispatch.test' } });
    imap.connectError = Object.assign(new Error('Authentication failed'), { authenticationFailed: true });
    const out = await imapLib.pollDueMailboxes(new Date());
    expect(out.errors).toBeGreaterThanOrEqual(1);
    const row = await prisma.emailAccount.findUnique({ where: { id: acc.id } });
    expect(row.imapError).toMatch(/^Sign-in failed/);
    expect((await dueMailboxes(new Date())).some((a) => a.id === acc.id)).toBe(false);
    expect((await dueMailboxes(new Date(Date.now() + 7 * 3600000))).some((a) => a.id === acc.id)).toBe(true);
  });
});

describe('mailbox reply-detection settings', () => {
  it('turns detection on with the provider preset, and refuses sign-in mailboxes honestly', async () => {
    const A = await registerUser();
    const acc = await smtpAccount(A.agent, { provider: 'gmail_smtp', fromEmail: `me${Date.now()}@gmail.test` });
    expect(acc).toMatchObject({ imapSupported: true, imapEnabled: false, imapHost: 'imap.gmail.com', imapPort: 993 });
    const on = await A.agent.patch(`/api/email/accounts/${acc.id}`).send({ imapEnabled: true });
    expect(on.status).toBe(200);
    expect(on.body.account).toMatchObject({ imapEnabled: true, imapHost: 'imap.gmail.com', imapSecure: true });
    // A partial PATCH changes only what was sent.
    const label = await A.agent.patch(`/api/email/accounts/${acc.id}`).send({ label: 'Main' });
    expect(label.body.account).toMatchObject({ label: 'Main', imapEnabled: true, dailyLimit: acc.dailyLimit, cooldownSeconds: acc.cooldownSeconds });

    const oauth = await prisma.emailAccount.create({ data: { userId: A.user.id, provider: 'gmail', label: 'G', fromEmail: 'g@gmail.test', status: 'connected', secretEnc: encrypt('r') } });
    const refused = await A.agent.patch(`/api/email/accounts/${oauth.id}`).send({ imapEnabled: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/app password/);
    const list = await A.agent.get('/api/email/accounts');
    expect(list.body.items.find((x) => x.id === oauth.id)).toMatchObject({ imapSupported: false });

    const B = await registerUser();
    expect((await B.agent.patch(`/api/email/accounts/${acc.id}`).send({ imapEnabled: false })).status).toBe(404);
    expect((await B.agent.post(`/api/email/accounts/${acc.id}/imap/test`).send({})).status).toBe(404);
  });

  it('tests the IMAP connection and rejects private hosts and odd ports', async () => {
    const A = await registerUser();
    const acc = await smtpAccount(A.agent, { provider: 'smtp', host: 'smtp.dispatch.test', port: 587 });
    imap.mailbox = { uidNext: 10, exists: 9 };
    const ok = await A.agent.post(`/api/email/accounts/${acc.id}/imap/test`).send({ imapHost: 'imap.dispatch.test', imapPort: 993 });
    expect(ok.status).toBe(200);
    expect(ok.body.message).toMatch(/9 messages/);
    // Connects to the address that was checked (tests/env.js resolves names to 93.184.215.14); the certificate is checked
    // against the name.
    expect(imap.lastOpts).toMatchObject({ host: '93.184.215.14', servername: 'imap.dispatch.test', port: 993, secure: true, logger: false });
    expect(imap.lastOpts.connectionTimeout).toBeGreaterThan(0);
    imap.connectError = Object.assign(new Error('Invalid credentials'), { authenticationFailed: true });
    const bad = await A.agent.post(`/api/email/accounts/${acc.id}/imap/test`).send({ imapHost: 'imap.dispatch.test' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Sign-in failed/);
    expect((await A.agent.post(`/api/email/accounts/${acc.id}/imap/test`).send({ imapHost: '127.0.0.1' })).status).toBe(400);
    expect((await A.agent.post(`/api/email/accounts/${acc.id}/imap/test`).send({ imapHost: 'localhost' })).status).toBe(400);
    expect((await A.agent.post(`/api/email/accounts/${acc.id}/imap/test`).send({ imapHost: 'imap.dispatch.test', imapPort: 25 })).status).toBe(400);
  });
});

describe('manual reply marking', () => {
  it('marks a sent email replied, stops the sequence, and is idempotent and owner-scoped', async () => {
    const A = await registerUser();
    await smtpAccount(A.agent);
    const c = await makeCarrier(A.user.id, { email: 'manual@carrier.test' });
    const s = await prisma.emailSequence.create({ data: { ownerId: A.user.id, name: 'Manual', respectBusinessHours: false, steps: { create: [{ order: 0, dayOffset: 0, type: 'call' }] } } });
    await enrollCarriers(await prisma.user.findUnique({ where: { id: A.user.id } }), s.id, [c]);
    const sent = (await A.agent.post('/api/email/messages').send({ carrierId: c.id, subject: 'Intro', body: 'b', mode: 'send' })).body.email;
    const B = await registerUser();
    expect((await B.agent.post(`/api/email/messages/${sent.id}/replied`)).status).toBe(404);
    const r = await A.agent.post(`/api/email/messages/${sent.id}/replied`);
    expect(r.status).toBe(200);
    expect(r.body.stopped).toBe(1);
    expect(r.body.email.repliedAt).not.toBeNull();
    expect((await A.agent.post(`/api/email/messages/${sent.id}/replied`)).body.already).toBe(true);
    expect(await prisma.followUp.count({ where: { carrierId: c.id, title: { startsWith: 'Reply from' } } })).toBe(1);
    const replies = await A.agent.get('/api/email/messages?filter=replied');
    expect(replies.body.items.map((m) => m.id)).toEqual([sent.id]);
    const draft = (await A.agent.post('/api/email/messages').send({ toEmail: 'd@x.test', subject: 'd', body: 'b', mode: 'draft' })).body.email;
    expect((await A.agent.post(`/api/email/messages/${draft.id}/replied`)).status).toBe(400);
  });
});
