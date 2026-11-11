import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import { app, agent, registerUser, createAdmin, prisma } from './helpers.js';
import { getSetting, setSetting, invalidateSettings } from '../src/lib/settings.js';
import { platformMailLimits } from '../src/services/email/system.js';

// Cross-group integration of wave 1 into the platform/security files: token blocklist, platform mail budget setting,
// settings cache scope, Admin → Setup mail status, profile response shape, document types and upload signatures,
// and the password-reset audit trail.

const BUDGET_KEY = 'mail.platformBudget';
const utcDay = () => new Date().toISOString().slice(0, 10);

describe('personal API tokens', () => {
  it('are refused by the middleware on push subscriptions and the private calendar link', async () => {
    const { agent: a } = await registerUser();
    const token = (await a.post('/api/tokens').send({ name: 'extension', expiresInDays: null })).body.token;
    expect(token).toMatch(/^ddk_/);
    const bearer = { Authorization: `Bearer ${token}` };

    // The token itself works on ordinary CRM routes.
    expect((await request(app).get('/api/carriers').set(bearer)).status).toBe(200);

    const blocked = [
      ['get', '/api/push/subscriptions'],
      ['get', '/api/push/vapid-public-key'],
      ['post', '/api/push/subscriptions'],
      ['get', '/api/calendar'],
      ['post', '/api/calendar/token'],
      ['delete', '/api/calendar/token'],
      ['get', '/api//calendar'],
    ];
    for (const [method, path] of blocked) {
      const res = await request(app)[method](path).set(bearer).send({});
      expect(res.status, `${method} ${path}`).toBe(403);
      // The shared blocklist answers before the routers' own checks.
      expect(res.body.error, `${method} ${path}`).toBe('API tokens cannot access this endpoint');
    }
  });
});

describe('platform mail budget setting', () => {
  let admin;
  beforeAll(async () => { admin = await createAdmin(); });
  afterEach(async () => { await setSetting('smtp.dailyLimit', ''); });

  it('is listed under Email with the environment default and can be changed by admins only', async () => {
    const list = await admin.agent.get('/api/admin/settings');
    expect(list.status).toBe(200);
    const s = list.body.settings.find((x) => x.key === 'smtp.dailyLimit');
    expect(s).toMatchObject({ group: 'email', type: 'string', secret: false, value: process.env.PLATFORM_MAIL_DAILY_LIMIT || '300' });

    for (const bad of ['0', '-5', '12.5', 'lots']) {
      // A bad value refuses the whole save: the other field in the group is not written either.
      const res = await admin.agent.put('/api/admin/settings').send({ values: { 'smtp.from': 'Not Saved <x@example.test>', 'smtp.dailyLimit': bad } });
      expect(res.status, bad).toBe(400);
      expect(await getSetting('smtp.from')).toBe('');
    }
    const ok = await admin.agent.put('/api/admin/settings').send({ values: { 'smtp.dailyLimit': '120' } });
    expect(ok.status).toBe(200);
    expect(ok.body.settings.find((x) => x.key === 'smtp.dailyLimit')).toMatchObject({ value: '120', source: 'database' });
    const limits = await platformMailLimits();
    expect(limits.limit).toBe(120);
    expect(limits.reserve).toBeGreaterThan(0);
    expect(limits.reserve + limits.otherLimit).toBe(120);

    // Clearing it falls back to the environment default again.
    await admin.agent.put('/api/admin/settings').send({ clear: ['smtp.dailyLimit'] });
    expect((await platformMailLimits()).limit).toBe(Number(process.env.PLATFORM_MAIL_DAILY_LIMIT) || 300);

    const { agent: user } = await registerUser();
    expect((await user.put('/api/admin/settings').send({ values: { 'smtp.dailyLimit': '5' } })).status).toBe(403);
  });
});

describe('settings cache', () => {
  afterEach(async () => {
    await prisma.systemSetting.deleteMany({ where: { key: 'user.integration-test.spotRates' } });
    await setSetting('app.name', '');
  });

  it('loads only defined platform settings, not per-user, lock or job rows', async () => {
    await prisma.systemSetting.create({ data: { key: 'user.integration-test.spotRates', value: '{"rate":1}', secret: false } });
    invalidateSettings();
    expect(await getSetting('user.integration-test.spotRates')).toBe('');

    await setSetting('app.name', 'Integration Desk');
    expect(await getSetting('app.name')).toBe('Integration Desk');
    await setSetting('app.name', '');
    expect(await getSetting('app.name')).toBe('DispatchDesk');
  });
});

describe('platform email status in Admin → Setup', () => {
  let admin;
  beforeAll(async () => { admin = await createAdmin(); });
  afterEach(async () => {
    await setSetting('smtp.host', '');
    await setSetting('smtp.from', '');
    await prisma.systemSetting.deleteMany({ where: { key: BUDGET_KEY } });
  });

  it("shows today's sent, held back and failed counts with the last error", async () => {
    await setSetting('smtp.host', 'smtp.example.test');
    await setSetting('smtp.from', 'DispatchDesk <no-reply@example.test>');
    await prisma.systemSetting.create({
      data: { key: BUDGET_KEY, secret: false, value: JSON.stringify({ day: utcDay(), sent: 4, other: 1, refused: 2, failed: 1, lastError: 'Greeting never received' }) },
    });
    const res = await admin.agent.get('/api/admin/setup');
    expect(res.status).toBe(200);
    const item = res.body.items.find((i) => i.key === 'platform_email');
    const limits = await platformMailLimits();
    expect(item.mail).toMatchObject({ ...limits, sent: 4, other: 1, refused: 2, failed: 1, lastError: 'Greeting never received' });
    expect(item.summary).toContain(`Today: 4 of ${limits.limit} sent`);
    expect(item.summary).toContain('2 held back by the daily budget');
    expect(item.summary).toContain('1 failed (last error: Greeting never received)');
    expect(item.status).toBe('partial'); // no SMTP user and password yet
  });

  it("ignores yesterday's counters", async () => {
    await prisma.systemSetting.create({
      data: { key: BUDGET_KEY, secret: false, value: JSON.stringify({ day: '2000-01-01', sent: 99, other: 0, refused: 0, failed: 9, lastError: 'old' }) },
    });
    const res = await admin.agent.get('/api/admin/setup');
    const item = res.body.items.find((i) => i.key === 'platform_email');
    expect(item.mail).toMatchObject({ day: utcDay(), sent: 0, failed: 0 });
    expect(item.mail.lastError).toBeUndefined();
    expect(item.status).toBe('todo'); // SMTP not configured
  });
});

describe('profile responses', () => {
  it('carry the push and digest preferences and the same verification flags as /api/auth/me', async () => {
    const { agent: a } = await registerUser();
    const me = (await a.get('/api/auth/me')).body.user;
    expect(typeof me.mailConfigured).toBe('boolean');
    expect(typeof me.verificationRequired).toBe('boolean');
    expect(me).toHaveProperty('notifyPush');
    expect(me).toHaveProperty('notifyDigest');

    const res = await a.patch('/api/profile').send({ notifyPush: false, notifyDigest: false });
    expect(res.status).toBe(200);
    // The client replaces its user with this object, so the verification banner must not lose its state.
    expect(res.body.user).toMatchObject({ notifyPush: false, notifyDigest: false, mailConfigured: me.mailConfigured, verificationRequired: me.verificationRequired });
    const again = (await a.get('/api/auth/me')).body.user;
    expect(again).toMatchObject({ notifyPush: false, notifyDigest: false });
  });
});

describe('document uploads', () => {
  it('accept the driver paperwork types, and refuse a RIFF file that is not a WebP image', async () => {
    const me = await registerUser();
    const stage = await prisma.pipelineStage.findUnique({ where: { key: 'customer' } });
    const carrier = await prisma.carrier.create({ data: { ownerId: me.user.id, stageId: stage.id, companyName: 'Paperwork Carrier LLC' } });
    const riff = (form) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from(form), Buffer.alloc(28, 0)]);
    const upload = (buf) => me.agent.post('/api/documents').field('carrierId', carrier.id).field('type', 'lumper_receipt')
      .attach('file', buf, { filename: 'receipt.webp', contentType: 'image/webp' });

    const wav = await upload(riff('WAVEfmt '));
    expect(wav.status).toBe(400);
    expect(wav.body.error).toBe('File contents do not match its type');

    const ok = await upload(riff('WEBPVP8 '));
    expect(ok.status).toBe(201);
    expect(ok.body.document).toMatchObject({ type: 'lumper_receipt', source: 'upload', mimeType: 'image/webp' });
    const id = ok.body.document.id;
    expect((await me.agent.patch(`/api/documents/${id}`).send({ type: 'scale_ticket' })).body.document.type).toBe('scale_ticket');
    expect((await me.agent.patch(`/api/documents/${id}`).send({ type: 'fuel_receipt' })).body.document.type).toBe('fuel_receipt');
    const list = await me.agent.get(`/api/documents?carrierId=${carrier.id}&types=fuel_receipt,scale_ticket`);
    expect(list.body.items.map((d) => d.id)).toEqual([id]);
  });
});

describe('password reset email', () => {
  it('audits a reset email that could not be sent, with the same answer to the caller', async () => {
    const u = await registerUser();
    const anon = await agent();
    const known = await anon.post('/api/auth/forgot-password').send({ email: u.email });
    const unknown = await anon.post('/api/auth/forgot-password').send({ email: `nobody-${Date.now()}@example.test` });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body.message).toBe(unknown.body.message);

    const row = await prisma.auditLog.findFirst({ where: { action: 'auth.password_reset_requested', entityId: u.user.id }, orderBy: { createdAt: 'desc' } });
    expect(row).toBeTruthy();
    expect(JSON.parse(row.details)).toEqual({ emailSent: false, reason: 'Platform email (SMTP or Brevo) is not configured' });
  });
});
