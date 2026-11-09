import { describe, it, expect } from 'vitest';
import { registerUser, agent } from './helpers.js';

describe('call scripts', () => {
  it('requires authentication', async () => {
    const a = await agent();
    expect((await a.get('/api/call-scripts')).status).toBe(401);
  });

  it('creates, lists, updates and deletes own scripts', async () => {
    const { agent: a } = await registerUser();
    const c = await a.post('/api/call-scripts').send({ name: 'Intro', category: 'cold_call', body: 'Hi {{first_name}}' });
    expect(c.status).toBe(201);
    const id = c.body.script.id;
    expect((await a.get('/api/call-scripts')).body.items).toHaveLength(1);
    const u = await a.patch(`/api/call-scripts/${id}`).send({ name: 'Intro v2' });
    expect(u.body.script.name).toBe('Intro v2');
    expect(u.body.script.body).toBe('Hi {{first_name}}'); // partial update keeps body
    expect((await a.get(`/api/call-scripts/${id}`)).body.script.name).toBe('Intro v2');
    expect((await a.delete(`/api/call-scripts/${id}`)).status).toBe(200);
    expect((await a.get('/api/call-scripts')).body.items).toHaveLength(0);
  });

  it('validates input', async () => {
    const { agent: a } = await registerUser();
    expect((await a.post('/api/call-scripts').send({ name: '', body: 'x' })).status).toBe(400);
    expect((await a.post('/api/call-scripts').send({ name: 'x', body: 'y', category: 'nope' })).status).toBe(400);
  });

  it('adds starter scripts idempotently', async () => {
    const { agent: a } = await registerUser();
    const first = await a.post('/api/call-scripts/starter');
    expect(first.body.created).toBeGreaterThanOrEqual(7);
    const second = await a.post('/api/call-scripts/starter');
    expect(second.body.created).toBe(0);
    const list = (await a.get('/api/call-scripts')).body.items;
    expect(list).toHaveLength(first.body.created);
    expect(list.some((s) => s.category === 'onboarding' && /W-9/.test(s.body))).toBe(true);
  });

  it('isolates scripts between users', async () => {
    const { agent: a } = await registerUser();
    const { agent: b } = await registerUser();
    const id = (await a.post('/api/call-scripts').send({ name: 'Private', body: 'secret' })).body.script.id;
    expect((await b.get(`/api/call-scripts/${id}`)).status).toBe(404);
    expect((await b.patch(`/api/call-scripts/${id}`).send({ name: 'Hijack' })).status).toBe(404);
    expect((await b.delete(`/api/call-scripts/${id}`)).status).toBe(404);
    expect((await b.get('/api/call-scripts')).body.items).toHaveLength(0);
    expect((await a.get(`/api/call-scripts/${id}`)).body.script.name).toBe('Private');
  });
});
