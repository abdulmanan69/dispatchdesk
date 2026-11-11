import { describe, it, expect } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { nextOccurrence, nextOccurrenceAfter, snapRemind } from '../src/routes/followups.js';
import { endOfUserDay, localParts } from '../src/lib/timezones.js';

const CHI = 'America/Chicago';

describe('recurrence on the owner\'s wall clock', () => {
  it('weekdays keeps the local weekday for evening times', () => {
    const thu = new Date('2026-11-13T01:30:00Z'); // Thursday 7:30 PM CST
    const next = nextOccurrence(thu, 'weekdays', CHI);
    expect(next.toISOString()).toBe('2026-11-14T01:30:00.000Z'); // Friday 7:30 PM, not Sunday
    expect(localParts(CHI, nextOccurrence(next, 'weekdays', CHI)).weekday).toBe('Mon');
  });

  it('keeps 9:00 AM across the DST change', () => {
    expect(nextOccurrence(new Date('2026-03-07T15:00:00Z'), 'daily', CHI).toISOString()).toBe('2026-03-08T14:00:00.000Z');
    expect(nextOccurrence(new Date('2026-03-02T15:00:00Z'), 'weekly', CHI).toISOString()).toBe('2026-03-09T14:00:00.000Z');
    expect(nextOccurrence(new Date('2026-01-31T15:00:00Z'), 'monthly', CHI).toISOString()).toBe('2026-02-28T15:00:00.000Z');
  });

  it('jumps to the first occurrence after now in bounded time, whatever the start date', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    for (const rule of ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly']) {
      const t0 = performance.now();
      const next = nextOccurrenceAfter(new Date('1900-01-01T15:00:00Z'), rule, now, CHI);
      expect(performance.now() - t0).toBeLessThan(50);
      expect(next > now).toBe(true);
      expect(next.getTime() - now.getTime()).toBeLessThan(32 * 86400000);
      expect(localParts(CHI, next).hour).toBe(9); // 15:00 UTC in January = 9:00 CST
    }
  });

  it('snaps reminder lead times to the offered choices', () => {
    expect(snapRemind(45)).toBe(30);
    expect(snapRemind(1500)).toBe(1440);
    expect(snapRemind(0)).toBe(0);
  });
});

describe('follow-up API', () => {
  it('rejects absurd due dates and completes old recurring rows quickly', async () => {
    const A = await registerUser();
    const c = (await A.agent.post('/api/carriers').send({ companyName: 'Recurring Freight', state: 'TX' })).body.carrier;
    expect((await A.agent.post('/api/follow-ups').send({ carrierId: c.id, dueAt: '0001-01-01T00:00:00Z', recurrence: 'daily' })).status).toBe(400);
    expect((await A.agent.post('/api/follow-ups').send({ carrierId: c.id, dueAt: new Date(Date.now() + 6 * 366 * 86400000).toISOString() })).status).toBe(400);
    const fu = (await A.agent.post('/api/follow-ups').send({ carrierId: c.id, dueAt: new Date(Date.now() + 3600000).toISOString(), recurrence: 'daily', remindMinutesBefore: 45 })).body.followUp;
    expect(fu.remindMinutesBefore).toBe(30);
    // A row that is already far behind (older data): completing it is still instant and lands in the future.
    await prisma.followUp.update({ where: { id: fu.id }, data: { dueAt: new Date('1950-06-01T15:00:00Z') } });
    const t0 = Date.now();
    const done = await A.agent.post(`/api/follow-ups/${fu.id}/complete`).send({});
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(done.status).toBe(200);
    const next = new Date(done.body.next.dueAt);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getTime()).toBeLessThan(Date.now() + 2 * 86400000);
  });

  it('splits Today and Upcoming at the user\'s midnight', async () => {
    const A = await registerUser();
    const now = new Date();
    const server = endOfUserDay(Intl.DateTimeFormat().resolvedOptions().timeZone, now);
    const zone = ['Pacific/Kiritimati', 'Asia/Tokyo', 'Europe/Berlin', 'America/New_York', 'Pacific/Honolulu', 'Pacific/Pago_Pago', 'Asia/Kolkata', 'America/Sao_Paulo']
      .find((z) => { const h = localParts(z, now).hour; return h >= 3 && h <= 19 && Math.abs(endOfUserDay(z, now) - server) >= 2 * 3600000; });
    await prisma.user.update({ where: { id: A.user.id }, data: { timezone: zone } });
    const c = (await A.agent.post('/api/carriers').send({ companyName: 'Night Owl Hauling' })).body.carrier;
    const end = endOfUserDay(zone, now);
    const today = (await A.agent.post('/api/follow-ups').send({ carrierId: c.id, dueAt: new Date(end.getTime() - 3600000).toISOString(), title: 'tonight' })).body.followUp;
    const tomorrow = (await A.agent.post('/api/follow-ups').send({ carrierId: c.id, dueAt: new Date(end.getTime() + 3600000).toISOString(), title: 'tomorrow' })).body.followUp;
    const t = await A.agent.get('/api/follow-ups?view=today');
    expect(t.body.items.map((f) => f.id)).toEqual([today.id]);
    const u = await A.agent.get('/api/follow-ups?view=upcoming');
    expect(u.body.items.map((f) => f.id)).toEqual([tomorrow.id]);
    expect(t.body.counts).toMatchObject({ today: 1, upcoming: 1 });
  });

  it('logging a call completes due call follow-ups and keeps recurring ones going', async () => {
    const A = await registerUser();
    const c = (await A.agent.post('/api/carriers').send({ companyName: 'Weekly Check Inc', state: 'OH', phone: '6145550199' })).body.carrier;
    const weekly = (await A.agent.post('/api/follow-ups').send({ carrierId: c.id, dueAt: new Date(Date.now() - 600000).toISOString(), type: 'call', recurrence: 'weekly', title: 'Weekly check-in' })).body.followUp;
    const mail = (await A.agent.post('/api/follow-ups').send({ carrierId: c.id, dueAt: new Date(Date.now() - 600000).toISOString(), type: 'email', title: 'Send packet' })).body.followUp;
    const res = await A.agent.post('/api/calls').send({ carrierId: c.id, outcome: 'call_back', autoFollowUp: false });
    expect(res.status).toBe(201);
    expect((await prisma.followUp.findUnique({ where: { id: weekly.id } })).status).toBe('done');
    expect((await prisma.followUp.findUnique({ where: { id: mail.id } })).status).toBe('pending');
    const next = await prisma.followUp.findFirst({ where: { carrierId: c.id, status: 'pending', title: 'Weekly check-in' } });
    expect(next).not.toBeNull();
    expect(next.dueAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86400000);
    expect((await prisma.carrier.findUnique({ where: { id: c.id } })).nextFollowUpAt).not.toBeNull();
  });
});
