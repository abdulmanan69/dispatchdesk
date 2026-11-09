// The extension's call panel uses a personal access token. These are the endpoints it needs.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import zlib from 'node:zlib';
import { app, registerUser, prisma } from './helpers.js';

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

describe('extension call panel over a bearer token', () => {
  let A; let token; let carrier;
  beforeAll(async () => {
    A = await registerUser();
    token = (await A.agent.post('/api/tokens').send({ name: 'panel', expiresInDays: null })).body.token;
    const stage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
    carrier = await prisma.carrier.create({ data: { ownerId: A.user.id, stageId: stage.id, companyName: 'Panel Freight LLC', phone: '2145550101', state: 'TX', priority: 1, email: 'ops@panel.test' } });
  });

  it('reads the queue, scripts, templates, settings and carrier', async () => {
    const q = await request(app).get('/api/prospecting/queue?includeHot=true').set(bearer(token));
    expect(q.status).toBe(200);
    expect(q.body.items.some((i) => i.carrier.id === carrier.id)).toBe(true);
    for (const path of ['/api/call-scripts', '/api/email/templates', '/api/telephony/settings', `/api/carriers/${carrier.id}`, '/api/auth/me']) {
      expect((await request(app).get(path).set(bearer(token))).status, path).toBe(200);
    }
  });

  it('settings report whether a provider was chosen', async () => {
    const before = await request(app).get('/api/telephony/settings').set(bearer(token));
    expect(before.body.settings).toMatchObject({ provider: 'tel', configured: false });
    await A.agent.put('/api/telephony/settings').send({ provider: 'google_voice' });
    const after = await request(app).get('/api/telephony/settings').set(bearer(token));
    expect(after.body.settings).toMatchObject({ provider: 'google_voice', configured: true });
  });

  it('dials through Google Voice, then logs the outcome with the attempt and a follow-up', async () => {
    const d = await request(app).post('/api/telephony/dial').set(bearer(token)).send({ carrierId: carrier.id, force: true });
    expect(d.status).toBe(201);
    expect(d.body.url).toMatch(/^https:\/\/voice\.google\.com\/u\/0\/calls\?a=nc,%2B12145550101/);
    expect(d.body.attempt.carrier.id).toBe(carrier.id);
    const followUpAt = new Date(Date.now() + 86400000).toISOString();
    const call = await request(app).post('/api/calls').set(bearer(token)).send({ carrierId: carrier.id, outcome: 'voicemail', notes: 'Left VM', attemptId: d.body.attempt.id, followUpAt });
    expect(call.status).toBe(201);
    expect(call.body.followUp).toBeTruthy();
    const attempt = await prisma.callAttempt.findUnique({ where: { id: d.body.attempt.id } });
    expect(attempt.callId).toBe(call.body.call.id);
  });

  it('can try to send a template email (needs a mailbox) but stays blocked from settings and tokens', async () => {
    const t = await A.agent.post('/api/email/templates').send({ name: 'Intro', subject: 'Hi {{company}}', body: 'Hello' });
    const send = await request(app).post('/api/email/messages').set(bearer(token)).send({ carrierId: carrier.id, templateId: t.body.template?.id || t.body.item?.id, mode: 'send' });
    expect(send.status).toBe(400);
    expect(send.body.error).toMatch(/mailbox/i);
    expect((await request(app).put('/api/settings/profile').set(bearer(token)).send({})).status).toBe(403);
    expect((await request(app).get('/api/tokens').set(bearer(token))).status).toBe(403);
  });

  it('ships the side panel and workspace command in the extension zip', async () => {
    const res = await A.agent.get('/api/extension/download').buffer(true).parse((r, cb) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    const buf = res.body;
    const names = [];
    let p = buf.readUInt32LE(buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) + 16);
    let manifest = null;
    while (buf.readUInt32LE(p) === 0x02014b50) {
      const method = buf.readUInt16LE(p + 10);
      const compSize = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const off = buf.readUInt32LE(p + 42);
      const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      names.push(name);
      if (name.endsWith('manifest.json')) {
        const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
        const data = buf.subarray(start, start + compSize);
        manifest = JSON.parse((method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8'));
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    expect(names.some((n) => n.endsWith('sidepanel.html'))).toBe(true);
    expect(names.some((n) => n.endsWith('sidepanel.js'))).toBe(true);
    expect(manifest.side_panel.default_path).toBe('sidepanel.html');
    expect(manifest.commands['open-workspace'].suggested_key.default).toBe('Alt+Shift+D');
    expect(manifest.permissions).toEqual(expect.arrayContaining(['sidePanel', 'system.display']));
  });
});
