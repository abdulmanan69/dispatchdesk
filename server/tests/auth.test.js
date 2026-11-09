import { describe, it, expect } from 'vitest';
import { agent, registerUser, prisma } from './helpers.js';

describe('authentication', () => {
  it('rejects state-changing requests without a CSRF token', async () => {
    const a = await agent();
    const res = await a.raw.post('/api/auth/login').send({ email: 'x@example.test', password: 'whatever1' });
    expect(res.status).toBe(403);
  });

  it('registers, reads /me, logs out and logs back in', async () => {
    const { agent: a, email, password, user } = await registerUser();
    expect(user.email).toBe(email);
    expect(user.role).toBe('dispatcher');
    expect(user.permissions).toContain('crm.use');
    expect(user).not.toHaveProperty('passwordHash');

    const me = await a.get('/api/auth/me');
    expect(me.body.user.id).toBe(user.id);

    await a.post('/api/auth/logout');
    expect((await a.get('/api/auth/me')).body.user).toBeNull();

    const bad = await a.post('/api/auth/login').send({ email, password: 'wrongpass1' });
    expect(bad.status).toBe(401);
    const ok = await a.post('/api/auth/login').send({ email, password });
    expect(ok.status).toBe(200);
    expect(ok.body.user.id).toBe(user.id);
  });

  it('stores bcrypt hashes, never plaintext', async () => {
    const { user, password } = await registerUser();
    const row = await prisma.user.findUnique({ where: { id: user.id } });
    expect(row.passwordHash).not.toContain(password);
    expect(row.passwordHash).toMatch(/^\$2[aby]\$12\$/);
  });

  it('rejects duplicate emails and weak passwords', async () => {
    const { email } = await registerUser();
    const a = await agent();
    const dup = await a.post('/api/auth/register').send({ name: 'Dup', email, password: 'Passw0rd!x', acceptTerms: true });
    expect(dup.status).toBe(409);
    const weak = await a.post('/api/auth/register').send({ name: 'Weak', email: 'weak@example.test', password: 'short', acceptTerms: true });
    expect(weak.status).toBe(400);
  });

  it('verifies email with a one-time token', async () => {
    const a = await agent();
    const res = await a.post('/api/auth/register').send({ name: 'Ver', email: `ver${Date.now()}@example.test`, password: 'Passw0rd!x', acceptTerms: true });
    expect(res.body.user.emailVerified).toBe(false);
    const v = await a.post('/api/auth/verify-email').send({ token: res.body.devToken });
    expect(v.status).toBe(200);
    expect((await a.get('/api/auth/me')).body.user.emailVerified).toBe(true);
    const again = await a.post('/api/auth/verify-email').send({ token: res.body.devToken });
    expect(again.status).toBe(400);
  });

  it('resets a password and invalidates existing sessions', async () => {
    const { agent: a, email } = await registerUser();
    const anon = await agent();
    const f = await anon.post('/api/auth/forgot-password').send({ email });
    expect(f.status).toBe(200);
    expect(f.body.devToken).toBeTruthy();
    const unknown = await anon.post('/api/auth/forgot-password').send({ email: 'nobody@example.test' });
    expect(unknown.body.message).toBe(f.body.message); // no account enumeration
    const r = await anon.post('/api/auth/reset-password').send({ token: f.body.devToken, password: 'NewPassw0rd' });
    expect(r.status).toBe(200);
    expect((await a.get('/api/auth/me')).body.user).toBeNull();
    const login = await anon.post('/api/auth/login').send({ email, password: 'NewPassw0rd' });
    expect(login.status).toBe(200);
  });

  it('lists and revokes other sessions; change password requires the current one', async () => {
    const { agent: a, email, password } = await registerUser();
    const b = await agent();
    await b.post('/api/auth/login').send({ email, password });
    const list = await a.get('/api/auth/sessions');
    expect(list.body.items.length).toBe(2);
    await a.post('/api/auth/sessions/revoke-others');
    expect((await b.get('/api/auth/me')).body.user).toBeNull();
    const wrong = await a.post('/api/auth/change-password').send({ currentPassword: 'nope', newPassword: 'Another1pass' });
    expect(wrong.status).toBe(400);
    const ok = await a.post('/api/auth/change-password').send({ currentPassword: password, newPassword: 'Another1pass' });
    expect(ok.status).toBe(200);
  });

  it('blocks protected API routes without a session', async () => {
    const a = await agent();
    expect((await a.get('/api/carriers')).status).toBe(401);
    expect((await a.get('/api/admin/stats')).status).toBe(401);
  });

  it('updates the profile and rejects unknown time zones', async () => {
    const { agent: a } = await registerUser();
    const ok = await a.patch('/api/profile').send({ name: 'Renamed', theme: 'dark', timezone: 'America/Denver' });
    expect(ok.body.user.name).toBe('Renamed');
    expect(ok.body.user.theme).toBe('dark');
    const bad = await a.patch('/api/profile').send({ timezone: 'Mars/Olympus' });
    expect(bad.status).toBe(400);
  });

  it('health endpoint reports database status', async () => {
    const a = await agent();
    const res = await a.get('/api/health');
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok' });
  });
});
