import { describe, it, expect } from 'vitest';
import { registerUser, agent } from './helpers.js';

describe('guided tours state', () => {
  it('starts empty, records done/skipped per user, resets', async () => {
    const A = await registerUser();
    const B = await registerUser();
    expect((await A.agent.get('/api/tours')).body.state).toEqual({});
    const done = await A.agent.post('/api/tours/welcome').send({ status: 'done' });
    expect(done.status).toBe(200);
    expect(done.body.state.welcome.done).toBe(true);
    await A.agent.post('/api/tours/fleet').send({ status: 'skipped' });
    const s = (await A.agent.get('/api/tours')).body.state;
    expect(Object.keys(s).sort()).toEqual(['fleet', 'welcome']);
    expect(s.fleet.skipped).toBe(true);
    // other users are unaffected
    expect((await B.agent.get('/api/tours')).body.state).toEqual({});
    await A.agent.post('/api/tours/welcome').send({ status: 'reset' });
    expect(Object.keys((await A.agent.get('/api/tours')).body.state)).toEqual(['fleet']);
    await A.agent.post('/api/tours/reset');
    expect((await A.agent.get('/api/tours')).body.state).toEqual({});
  });

  it('rejects unknown tours and bad status, and requires login', async () => {
    const A = await registerUser();
    expect((await A.agent.post('/api/tours/nope').send({ status: 'done' })).status).toBe(400);
    expect((await A.agent.post('/api/tours/welcome').send({ status: 'maybe' })).status).toBe(400);
    const anon = await agent();
    expect((await anon.get('/api/tours')).status).toBe(401);
  });
});
