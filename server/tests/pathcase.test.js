import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, registerUser, prisma } from './helpers.js';

describe('path case and slash tricks cannot bypass security checks', () => {
  it('API tokens stay blocked from sensitive routes with upper-case or doubled-slash paths', async () => {
    const { agent: a } = await registerUser();
    const token = (await a.post('/api/tokens').send({ name: 'ext', expiresInDays: null })).body.token;
    expect(token).toMatch(/^ddk_/);
    for (const p of ['/api/tokens', '/API/TOKENS', '/Api/Tokens', '/api//tokens', '/api/SETTINGS/export', '/API/admin/users', '/api/Admin/users']) {
      const res = await request(app).get(p).set('Authorization', `Bearer ${token}`);
      expect([401, 403, 404], `${p} -> ${res.status}`).toContain(res.status);
      expect(res.status, p).not.toBe(200);
    }
    const mint = await request(app).post('/API/TOKENS').set('Authorization', `Bearer ${token}`).send({ name: 'x' });
    expect(mint.status).not.toBe(200);
    expect(mint.status).not.toBe(201);
  });

  it('CSRF is enforced for upper-case /API paths with a session cookie', async () => {
    const u = await registerUser();
    const before = await prisma.carrier.count({ where: { ownerId: u.user.id } });
    // raw agent: has the session cookie but sends no X-CSRF-Token header
    const res = await u.agent.raw.post('/API/carriers').send({ companyName: 'Should Not Exist LLC' });
    expect([403, 404]).toContain(res.status);
    const res2 = await u.agent.raw.post('/api/carriers').send({ companyName: 'Should Not Exist LLC' });
    expect(res2.status).toBe(403);
    expect(await prisma.carrier.count({ where: { ownerId: u.user.id } })).toBe(before);
  });
});
