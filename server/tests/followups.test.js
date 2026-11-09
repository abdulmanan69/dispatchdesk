import { describe, it, expect, beforeAll } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { nextOccurrence } from '../src/routes/followups.js';
import { runSchedulerTick } from '../src/jobs/scheduler.js';

const inMin = (m) => new Date(Date.now() + m * 60000).toISOString();

describe('follow-up workspace', () => {
  let A; let B; let carrier;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    carrier = (await A.agent.post('/api/carriers').send({ companyName: 'Follow Up Freight', phone: '6145550111', state: 'OH' })).body.carrier;
  });

  it('computes next occurrences; weekdays skips the weekend', () => {
    const fri = new Date(2026, 10, 13, 9); // Friday 13 Nov 2026
    expect(nextOccurrence(fri, 'weekdays').getDay()).toBe(1);
    expect(nextOccurrence(fri, 'daily').getDate()).toBe(14);
    expect(nextOccurrence(fri, 'biweekly').getDate()).toBe(27);
    expect(nextOccurrence(new Date(2026, 0, 31, 9), 'monthly').getDate()).toBe(28); // clamps to Feb 28
    expect(nextOccurrence(fri, 'none')).toBeNull();
  });

  it('creates with all fields and validates type', async () => {
    const res = await A.agent.post('/api/follow-ups').send({
      carrierId: carrier.id, dueAt: inMin(-30), type: 'text', title: 'Send rate sheet', note: 'Ask about reefer', priority: 2, recurrence: 'weekly', remindMinutesBefore: 15,
    });
    expect(res.status).toBe(201);
    expect(res.body.followUp).toMatchObject({ type: 'text', priority: 2, recurrence: 'weekly', remindMinutesBefore: 15, title: 'Send rate sheet' });
    expect(res.body.followUp.carrier.companyName).toBe('Follow Up Freight');
    expect((await A.agent.post('/api/follow-ups').send({ carrierId: carrier.id, dueAt: inMin(5), type: 'fax' })).status).toBe(400);
  });

  it('lists by view with counts, filters and search', async () => {
    await A.agent.post('/api/follow-ups').send({ carrierId: carrier.id, dueAt: inMin(60 * 24 * 3), type: 'call', title: 'Check trial week' });
    const overdue = await A.agent.get('/api/follow-ups?view=overdue');
    expect(overdue.body.items).toHaveLength(1);
    expect(overdue.body.counts).toMatchObject({ overdue: 1, upcoming: 1 });
    expect((await A.agent.get('/api/follow-ups?view=upcoming&type=call')).body.items[0].title).toBe('Check trial week');
    expect((await A.agent.get('/api/follow-ups?view=all&q=rate sheet')).body.items).toHaveLength(1);
    expect((await A.agent.get('/api/follow-ups?view=all&q=Follow Up Freight')).body.items).toHaveLength(2);
    expect((await A.agent.get('/api/follow-ups?view=all&priority=2')).body.items).toHaveLength(1);
    expect((await A.agent.get('/api/follow-ups?range=overdue')).body.items).toHaveLength(1); // legacy param
  });

  it('completing a recurring follow-up schedules the next one in the future', async () => {
    const fu = (await A.agent.get('/api/follow-ups?view=overdue')).body.items[0];
    const res = await A.agent.post(`/api/follow-ups/${fu.id}/complete`).send({ outcome: 'Sent', note: 'Emailed PDF' });
    expect(res.status).toBe(200);
    expect(res.body.followUp).toMatchObject({ status: 'done', outcome: 'Sent' });
    expect(res.body.next).toMatchObject({ status: 'pending', recurrence: 'weekly', priority: 2, title: 'Send rate sheet' });
    expect(new Date(res.body.next.dueAt).getTime()).toBeGreaterThan(Date.now());
    expect((await A.agent.get('/api/follow-ups?view=done')).body.items[0].id).toBe(fu.id);
  });

  it('snoozes by minutes and until, counting snoozes', async () => {
    const fu = (await A.agent.post('/api/follow-ups').send({ carrierId: carrier.id, dueAt: inMin(-5) })).body.followUp;
    const r1 = await A.agent.post(`/api/follow-ups/${fu.id}/snooze`).send({ minutes: 60 });
    expect(new Date(r1.body.followUp.dueAt).getTime()).toBeGreaterThan(Date.now() + 55 * 60000);
    const until = inMin(60 * 24);
    const r2 = await A.agent.post(`/api/follow-ups/${fu.id}/snooze`).send({ until });
    expect(r2.body.followUp.dueAt).toBe(until);
    expect(r2.body.followUp.snoozeCount).toBe(2);
    expect((await A.agent.post(`/api/follow-ups/${fu.id}/snooze`).send({})).status).toBe(400);
  });

  it('bulk actions apply only to owned rows', async () => {
    const mk = async () => (await A.agent.post('/api/follow-ups').send({ carrierId: carrier.id, dueAt: inMin(10) })).body.followUp.id;
    const ids = [await mk(), await mk(), await mk()];
    const bc = (await B.agent.post('/api/carriers').send({ companyName: 'B only' })).body.carrier;
    const foreign = (await B.agent.post('/api/follow-ups').send({ carrierId: bc.id, dueAt: inMin(10) })).body.followUp.id;

    const pr = await A.agent.post('/api/follow-ups/bulk').send({ ids: [...ids, foreign], action: 'priority', priority: 1 });
    expect(pr.body).toMatchObject({ updated: 3, notFound: 1 });
    const due = inMin(60 * 48);
    expect((await A.agent.post('/api/follow-ups/bulk').send({ ids: [ids[0]], action: 'reschedule', dueAt: due })).body.updated).toBe(1);
    expect((await prisma.followUp.findUnique({ where: { id: ids[0] } })).dueAt.toISOString()).toBe(due);
    expect((await A.agent.post('/api/follow-ups/bulk').send({ ids: [ids[1]], action: 'snooze', minutes: 30 })).body.updated).toBe(1);
    expect((await A.agent.post('/api/follow-ups/bulk').send({ ids: [ids[1], ids[2]], action: 'complete', outcome: 'Done in batch' })).body.updated).toBe(2);
    expect((await A.agent.post('/api/follow-ups/bulk').send({ ids: [ids[1]], action: 'complete' })).body.skipped).toBe(1);
    expect((await A.agent.post('/api/follow-ups/bulk').send({ ids: [ids[0], foreign], action: 'delete' })).body).toMatchObject({ updated: 1, notFound: 1 });
    expect(await prisma.followUp.findUnique({ where: { id: foreign } })).not.toBeNull();
    expect((await prisma.followUp.findUnique({ where: { id: foreign } })).priority).toBe(0);
  });

  it('isolates follow-ups between users', async () => {
    const fu = (await A.agent.post('/api/follow-ups').send({ carrierId: carrier.id, dueAt: inMin(20) })).body.followUp;
    expect((await B.agent.patch(`/api/follow-ups/${fu.id}`).send({ priority: 2 })).status).toBe(404);
    expect((await B.agent.post(`/api/follow-ups/${fu.id}/snooze`).send({ minutes: 5 })).status).toBe(404);
    expect((await B.agent.post(`/api/follow-ups/${fu.id}/complete`)).status).toBe(404);
    expect((await B.agent.delete(`/api/follow-ups/${fu.id}`)).status).toBe(404);
    expect((await B.agent.get('/api/follow-ups?view=all&q=Follow Up Freight')).body.items).toHaveLength(0);
    expect((await B.agent.get(`/api/follow-ups?carrierId=${carrier.id}`)).status).toBe(404);
  });

  it('reminds remindMinutesBefore ahead of the due time', async () => {
    const P = await registerUser();
    const c = (await P.agent.post('/api/carriers').send({ companyName: 'Remind Me Inc' })).body.carrier;
    await P.agent.post('/api/follow-ups').send({ carrierId: c.id, dueAt: inMin(20), remindMinutesBefore: 30, title: 'Call before lunch' });
    await P.agent.post('/api/follow-ups').send({ carrierId: c.id, dueAt: inMin(120), remindMinutesBefore: 30 });
    await runSchedulerTick({ quiet: true });
    const notes = await prisma.notification.findMany({ where: { userId: P.user.id, type: 'follow_up_due' } });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toMatch(/^Coming up: Remind Me Inc in \d+ min$/);
  });
});
