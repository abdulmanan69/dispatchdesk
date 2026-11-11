import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerUser, prisma } from './helpers.js';
import { startOfUserDay, startOfUserMonth, usage, effectivePlan, invalidatePlans, assertLimit, remainingMany } from '../src/lib/plans.js';
import { startOfUserDay as zonedStartOfUserDay, DEFAULT_TZ } from '../src/lib/timezones.js';
import { ipKey, userOrIpKey, authKey, linkTokenKey, makeLimiter } from '../src/middleware/security.js';

describe('local day and month boundaries', () => {
  it('starts the day at the user\'s local midnight', () => {
    // 03:00 UTC on Nov 10 is 21:00 on Nov 9 in Chicago (CST, UTC-6).
    expect(startOfUserDay('America/Chicago', new Date('2026-11-10T03:00:00Z')).toISOString()).toBe('2026-11-09T06:00:00.000Z');
    expect(startOfUserDay('America/New_York', new Date('2026-11-10T15:00:00Z')).toISOString()).toBe('2026-11-10T05:00:00.000Z');
    expect(startOfUserDay('Asia/Kolkata', new Date('2026-11-10T15:00:00Z')).toISOString()).toBe('2026-11-09T18:30:00.000Z');
    // DST start day in New York: midnight is still EST (UTC-5).
    expect(startOfUserDay('America/New_York', new Date('2026-03-08T16:00:00Z')).toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });

  it('starts the month on the 1st at local midnight, and uses Central time when the user has no zone', () => {
    // Nov 1 2026: DST ends at 2 AM, so midnight is still CDT (UTC-5).
    expect(startOfUserMonth('America/Chicago', new Date('2026-11-15T12:00:00Z')).toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(startOfUserMonth('America/Los_Angeles', new Date('2026-12-01T05:00:00Z')).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(startOfUserMonth(null, new Date('2026-11-15T12:00:00Z')).toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(startOfUserDay(null, new Date('2026-11-10T03:00:00Z')).toISOString()).toBe('2026-11-09T06:00:00.000Z');
  });

  it('uses the same day boundary as the email sender (lib/timezones.js), also for unknown zones', () => {
    const now = new Date('2026-11-10T03:00:00Z');
    for (const tz of ['America/Chicago', 'Pacific/Honolulu', 'Asia/Kolkata', 'Not/AZone', null, undefined]) {
      expect(startOfUserDay(tz, now).getTime()).toBe(zonedStartOfUserDay(tz || DEFAULT_TZ, now).getTime());
    }
  });
});

describe('plan limits', () => {
  it('usage() computes only the counters asked for', async () => {
    const { user } = await registerUser();
    const u = await prisma.user.findUnique({ where: { id: user.id }, include: { teamMembership: true } });
    expect(Object.keys(await usage(u, ['carriers']))).toEqual(['carriers']);
    const all = await usage(u);
    expect(Object.keys(all).sort()).toEqual(['aiMonth', 'automations', 'carriers', 'discoveryToday', 'emailsToday', 'leadGenMonth', 'leadGenerators', 'sequences']);
  });

  it('emails sent before the user\'s local midnight do not count toward today', async () => {
    const { user } = await registerUser();
    await prisma.user.update({ where: { id: user.id }, data: { timezone: 'Pacific/Honolulu' } });
    const u = await prisma.user.findUnique({ where: { id: user.id }, include: { teamMembership: true } });
    const startToday = startOfUserDay('Pacific/Honolulu');
    await prisma.email.createMany({
      data: [
        { userId: user.id, toEmail: 'a@example.test', subject: 'yesterday', body: 'x', status: 'sent', sentAt: new Date(startToday.getTime() - 60_000) },
        { userId: user.id, toEmail: 'b@example.test', subject: 'today', body: 'x', status: 'sent', sentAt: new Date(startToday.getTime() + 60_000) },
      ],
    });
    expect((await usage(u, ['emailsToday'])).emailsToday).toBe(1);
  });

  it('caches the effective plan briefly and drops it when billing changes', async () => {
    const { user } = await registerUser();
    const u = await prisma.user.findUnique({ where: { id: user.id }, include: { teamMembership: true } });
    const first = await effectivePlan(u);
    expect(first.plan.key).toBe('free');
    expect(await effectivePlan(u)).toBe(first); // served from the cache
    const pro = await prisma.plan.findUnique({ where: { key: 'pro' } });
    await prisma.subscription.create({ data: { userId: user.id, planId: pro.id, status: 'active', seats: 1 } });
    invalidatePlans(); // what billing webhooks, admin grants and team changes call
    expect((await effectivePlan(u)).plan.key).toBe('pro');
  });

  it('assertLimit and remainingMany use one plan lookup and the needed counters', async () => {
    const { user } = await registerUser();
    const u = await prisma.user.findUnique({ where: { id: user.id }, include: { teamMembership: true } });
    const free = await prisma.plan.findUnique({ where: { key: 'free' } });
    const left = await remainingMany(u, ['carriers', 'discoveryToday']);
    expect(left).toEqual({ carriers: free.maxCarriers, discoveryToday: free.maxDiscoveryPerDay });
    await expect(assertLimit(u, 'carriers', free.maxCarriers + 1)).rejects.toMatchObject({ status: 402 });
    await expect(assertLimit(u, 'carriers', 1)).resolves.toBeUndefined();
  });
});

describe('rate-limit keys', () => {
  it('groups IPv6 by /64 and keeps IPv4 as is', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('2001:db8:abcd:12:1111:2222:3333:4444')).toBe('2001:db8:abcd:12::/64');
    expect(ipKey('2001:db8:abcd:12::99')).toBe('2001:db8:abcd:12::/64');
    expect(ipKey('2001:0db8:0000:0012::1')).toBe('2001:db8:0:12::/64');
    expect(ipKey('')).toBe('unknown');
  });

  it('keys signed-in requests by user, sign-in attempts by address + email, links by token', () => {
    expect(userOrIpKey({ user: { id: 'u1' }, ip: '1.2.3.4' })).toBe('u:u1');
    expect(userOrIpKey({ ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
    const a = authKey({ ip: '1.2.3.4', body: { email: 'Driver@Example.test ' } });
    expect(a).toMatch(/^ip:1\.2\.3\.4\|e:[\w-]{22}$/);
    expect(authKey({ ip: '1.2.3.4', body: { email: 'driver@example.test' } })).toBe(a);
    expect(authKey({ ip: '1.2.3.4', body: { email: 'other@example.test' } })).not.toBe(a);
    expect(a).not.toContain('example');
    const t1 = linkTokenKey({ baseUrl: '/api/public/track', path: '/AbCdEfGhIjKlMnOpQrStUvWx/ping', ip: '1.2.3.4' });
    const t2 = linkTokenKey({ baseUrl: '/api/public/track', path: '/ZyXwVuTsRqPoNmLkJiHgFeDc/ping', ip: '1.2.3.4' });
    expect(t1).toMatch(/^t:/);
    expect(t1).not.toBe(t2);
    expect(linkTokenKey({ baseUrl: '', path: '/api/health', ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
    // As mounted in app.js for portal, broker tracking and calendar links.
    expect(linkTokenKey({ baseUrl: '/api/public/calendar', path: '/AbCdEfGhIjKlMnOpQrSt.ics', ip: '1.2.3.4' })).toMatch(/^t:/);
    expect(linkTokenKey({ baseUrl: '/api/public/portal', path: '/AbCdEfGhIjKlMnOpQrSt', ip: '1.2.3.4' })).toMatch(/^t:/);
  });

  it('two users behind one office address have separate budgets', async () => {
    const limiter = makeLimiter('test-office', 60_000, 2, 'Too many', { force: true });
    const app = express();
    app.use((req, res, next) => { const id = req.get('x-test-user'); if (id) req.user = { id }; next(); });
    app.get('/x', limiter, (req, res) => res.json({ ok: true }));
    const as = (id) => request(app).get('/x').set('x-test-user', id);
    expect((await as('alice')).status).toBe(200);
    expect((await as('alice')).status).toBe(200);
    expect((await as('alice')).status).toBe(429);
    expect((await as('bob')).status).toBe(200); // same IP, different user
    const anon = makeLimiter('test-anon', 60_000, 1, 'Too many', { force: true });
    const app2 = express();
    app2.get('/y', anon, (req, res) => res.json({ ok: true }));
    expect((await request(app2).get('/y')).status).toBe(200);
    expect((await request(app2).get('/y')).status).toBe(429);
  });
});
