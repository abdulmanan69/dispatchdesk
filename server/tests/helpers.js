import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';

export const app = createApp();
let counter = 0;

/**
 * A supertest agent that keeps cookies and sends the CSRF header automatically.
 * Usage: const a = await agent(); await a.post('/api/x').send({...})
 */
export async function agent() {
  const a = request.agent(app);
  const res = await a.get('/api/auth/csrf');
  const cookie = (res.headers['set-cookie'] || []).find((c) => c.startsWith('dd_csrf='));
  const token = decodeURIComponent(cookie.split(';')[0].split('=')[1]);
  const wrap = (method) => (url) => a[method](url).set('X-CSRF-Token', token);
  return { raw: a, csrf: token, get: (url) => a.get(url), post: wrap('post'), put: wrap('put'), patch: wrap('patch'), delete: wrap('delete') };
}

/** Register a fresh user (role dispatcher) and return { agent, user }. */
export async function registerUser(overrides = {}) {
  const a = await agent();
  counter += 1;
  const email = overrides.email || `user${Date.now()}${counter}@example.test`;
  const res = await a.post('/api/auth/register').send({ name: overrides.name || `Test User ${counter}`, email, password: 'Passw0rd!x', acceptTerms: true });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${JSON.stringify(res.body)}`);
  if (overrides.role) {
    const role = await prisma.role.findUnique({ where: { key: overrides.role } });
    await prisma.user.update({ where: { id: res.body.user.id }, data: { roleId: role.id } });
  }
  return { agent: a, user: res.body.user, email, password: 'Passw0rd!x' };
}

export async function createAdmin() {
  return registerUser({ role: 'super_admin' });
}

export { prisma };
