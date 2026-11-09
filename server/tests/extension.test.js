import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import request from 'supertest';
import { app, registerUser, prisma } from './helpers.js';

/** Parse a zip buffer's central directory: [{ name, method, compSize, size, localOffset }] */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(0);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    out.push({ name, method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function entryData(buf, e) {
  const nameLen = buf.readUInt16LE(e.localOffset + 26);
  const extraLen = buf.readUInt16LE(e.localOffset + 28);
  const start = e.localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compSize);
  return e.method === 8 ? zlib.inflateRawSync(data) : data;
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

describe('personal API tokens', () => {
  it('creates, lists (without secrets) and revokes tokens', async () => {
    const { agent: a } = await registerUser();
    const created = await a.post('/api/tokens').send({ name: 'Chrome at office', expiresInDays: 30 });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^ddk_/);
    expect(created.body.item.prefix).toBe(created.body.token.slice(0, 12));

    const list = await a.get('/api/tokens');
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(created.body.token);
    expect(list.body.items[0].active).toBe(true);

    const row = await prisma.apiToken.findUnique({ where: { id: created.body.item.id } });
    expect(row.tokenHash).not.toContain(created.body.token);

    expect((await a.delete(`/api/tokens/${created.body.item.id}`)).status).toBe(200);
    const after = await request(app).get('/api/carriers').set(bearer(created.body.token));
    expect(after.status).toBe(401);
  });

  it('authenticates bearer requests without cookies or CSRF', async () => {
    const { agent: a, user } = await registerUser();
    const { body } = await a.post('/api/tokens').send({ name: 'ext', expiresInDays: null });
    const me = await request(app).get('/api/auth/me').set(bearer(body.token));
    expect(me.body.user.id).toBe(user.id);
    // POST without a CSRF header works for bearer auth
    const c = await request(app).post('/api/carriers').set(bearer(body.token)).send({ companyName: 'Bearer Freight', state: 'TX' });
    expect(c.status).toBe(201);
    const list = await request(app).get('/api/carriers').set(bearer(body.token));
    expect(list.body.items.map((x) => x.companyName)).toContain('Bearer Freight');
    const row = await prisma.apiToken.findUnique({ where: { id: body.item.id } });
    expect(row.lastUsedAt).not.toBeNull();
  });

  it('blocks admin, token and account-security routes for bearer tokens', async () => {
    const { agent: a } = await registerUser({ role: 'super_admin' });
    const { body } = await a.post('/api/tokens').send({ name: 'admin ext' });
    expect((await request(app).get('/api/admin/stats').set(bearer(body.token))).status).toBe(403);
    expect((await request(app).get('/api/tokens').set(bearer(body.token))).status).toBe(403);
    expect((await request(app).post('/api/tokens').set(bearer(body.token)).send({ name: 'x' })).status).toBe(403);
    expect((await request(app).get('/api/settings/export').set(bearer(body.token))).status).toBe(403);
    expect((await request(app).post('/api/auth/change-password').set(bearer(body.token)).send({})).status).toBe(403);
  });

  it('rejects unknown and expired tokens', async () => {
    expect((await request(app).get('/api/carriers').set(bearer('ddk_not-a-real-token'))).status).toBe(401);
    const { agent: a } = await registerUser();
    const { body } = await a.post('/api/tokens').send({ name: 'short' });
    await prisma.apiToken.update({ where: { id: body.item.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).get('/api/carriers').set(bearer(body.token))).status).toBe(401);
  });

  it('limits active tokens and scopes revocation to the owner', async () => {
    const { agent: a } = await registerUser();
    for (let i = 0; i < 10; i++) expect((await a.post('/api/tokens').send({ name: `t${i}` })).status).toBe(201);
    expect((await a.post('/api/tokens').send({ name: 'one too many' })).status).toBe(400);
    const { agent: b } = await registerUser();
    const id = (await a.get('/api/tokens')).body.items[0].id;
    expect((await b.delete(`/api/tokens/${id}`)).status).toBe(404);
  });
});

describe('browser extension download', () => {
  it('requires a session', async () => {
    expect((await request(app).get('/api/extension/download')).status).toBe(401);
  });

  it('serves a valid zip with manifest.json and a generated config.json', async () => {
    const { agent: a } = await registerUser();
    const info = await a.get('/api/extension/info');
    expect(info.status).toBe(200);
    expect(info.body.version).toMatch(/^\d+\.\d+\.\d+$/);

    const res = await a.get('/api/extension/download').buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const buf = res.body;
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const entries = readZip(buf);
    const names = entries.map((e) => e.name.split('/').slice(1).join('/'));
    expect(names).toEqual(expect.arrayContaining(['manifest.json', 'config.json', 'background.js', 'popup.html', 'options.html', 'icons/icon128.png']));

    const manifest = JSON.parse(entryData(buf, entries.find((e) => e.name.endsWith('/manifest.json'))).toString('utf8'));
    expect(manifest.manifest_version).toBe(3);
    const cfg = JSON.parse(entryData(buf, entries.find((e) => e.name.endsWith('/config.json'))).toString('utf8'));
    expect(cfg.appUrl).toBe('http://localhost:3999');
    // at least one entry is deflated and round-trips
    const deflated = entries.find((e) => e.method === 8);
    expect(deflated).toBeTruthy();
    expect(entryData(buf, deflated).length).toBe(deflated.size);
  });
});
