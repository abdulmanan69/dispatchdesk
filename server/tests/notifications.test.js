import { describe, it, expect } from 'vitest';
import { registerUser, agent } from './helpers.js';
import { notify } from '../src/lib/activity.js';

describe('notifications', () => {
  it('counts unread for the bell badge, per user', async () => {
    const A = await registerUser();
    const B = await registerUser();
    await notify(A.user.id, { type: 'team', title: 'One' });
    const second = await notify(A.user.id, { type: 'team', title: 'Two' });
    await notify(B.user.id, { type: 'team', title: 'For B' });
    // Registration may create welcome notifications; compare against the list endpoint.
    const listA = await A.agent.get('/api/notifications').query({ pageSize: 1 });
    const countA = await A.agent.get('/api/notifications/unread-count');
    expect(countA.status).toBe(200);
    expect(countA.body.unread).toBe(listA.body.unread);
    expect(countA.body.unread).toBeGreaterThanOrEqual(2);
    expect(countA.headers['cache-control']).toContain('no-store');

    expect((await A.agent.post(`/api/notifications/${second.id}/read`)).status).toBe(200);
    expect((await A.agent.get('/api/notifications/unread-count')).body.unread).toBe(countA.body.unread - 1);
    // Other users' notifications are invisible.
    expect((await B.agent.post(`/api/notifications/${second.id}/read`)).status).toBe(404);
    expect((await B.agent.delete(`/api/notifications/${second.id}`)).status).toBe(404);
    await A.agent.post('/api/notifications/read-all');
    expect((await A.agent.get('/api/notifications/unread-count')).body.unread).toBe(0);
    expect((await B.agent.get('/api/notifications/unread-count')).body.unread).toBeGreaterThanOrEqual(1);
  });

  it('requires a session', async () => {
    const anon = await agent();
    expect((await anon.get('/api/notifications/unread-count')).status).toBe(401);
  });
});
