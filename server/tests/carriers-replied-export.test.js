import { describe, it, expect, beforeAll } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { withLock } from '../src/lib/locks.js';

let leadStage;
const makeCarrier = (ownerId, data = {}) => prisma.carrier.create({ data: { ownerId, stageId: leadStage.id, companyName: 'Reply Freight', ...data } });

beforeAll(async () => {
  leadStage = await prisma.pipelineStage.findUnique({ where: { key: 'lead' } });
});

describe('POST /api/carriers/:id/replied (carrier-level "Mark replied")', () => {
  let A; let B;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
  });

  it('stops running sequences, marks the newest sent email, logs the reply and adds one follow-up', async () => {
    const c = await makeCarrier(A.user.id, { email: 'ops@reply.test' });
    const seq = await prisma.emailSequence.create({ data: { ownerId: A.user.id, name: 'Intro', respectBusinessHours: false, steps: { create: [{ order: 0, dayOffset: 0, type: 'call' }] } } });
    const enr = await prisma.sequenceEnrollment.create({ data: { sequenceId: seq.id, carrierId: c.id, userId: A.user.id, status: 'active', currentStep: 0, nextStepAt: new Date() } });
    const sent = (subject, daysAgo) => prisma.email.create({ data: { userId: A.user.id, carrierId: c.id, toEmail: 'ops@reply.test', subject, body: 'b', status: 'sent', sentAt: new Date(Date.now() - daysAgo * 86400000) } });
    const older = await sent('First touch', 3);
    const newer = await sent('Second touch', 1);

    // Another user's carrier: 404 and nothing changes.
    expect((await B.agent.post(`/api/carriers/${c.id}/replied`)).status).toBe(404);
    expect((await prisma.sequenceEnrollment.findUnique({ where: { id: enr.id } })).status).toBe('active');

    const r = await A.agent.post(`/api/carriers/${c.id}/replied`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, stopped: 1, emailId: newer.id });
    expect(await prisma.sequenceEnrollment.findUnique({ where: { id: enr.id } })).toMatchObject({ status: 'stopped', stopReason: 'replied' });
    expect((await prisma.email.findUnique({ where: { id: newer.id } })).repliedAt).not.toBeNull();
    expect((await prisma.email.findUnique({ where: { id: older.id } })).repliedAt).toBeNull();
    expect(await prisma.activity.count({ where: { carrierId: c.id, summary: { startsWith: 'Reply from Reply Freight' } } })).toBe(1);
    const pendingReplyFollowUps = () => prisma.followUp.count({ where: { carrierId: c.id, status: 'pending', title: { startsWith: 'Reply from' } } });
    expect(await pendingReplyFollowUps()).toBe(1);

    // A second reply later does not stack a second open "Reply from" follow-up.
    const again = await A.agent.post(`/api/carriers/${c.id}/replied`);
    expect(again.status).toBe(200);
    expect(again.body.stopped).toBe(0);
    expect(await pendingReplyFollowUps()).toBe(1);
  });

  it('works for a reply by phone or text when no email was sent', async () => {
    const c = await makeCarrier(A.user.id, { companyName: 'Phone Only Lines', phone: '6145550111' });
    const r = await A.agent.post(`/api/carriers/${c.id}/replied`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, stopped: 0, emailId: null });
    expect(await prisma.followUp.count({ where: { carrierId: c.id, title: { startsWith: 'Reply from Phone Only Lines' } } })).toBe(1);
  });
});

describe('GET /api/carriers/export.csv', () => {
  let U;
  beforeAll(async () => {
    U = await registerUser();
    // More than one 1,000-row page, so the export has to stream several pages.
    await prisma.carrier.createMany({
      data: Array.from({ length: 1205 }, (_, i) => ({ ownerId: U.user.id, stageId: leadStage.id, companyName: `Export Co ${String(i).padStart(4, '0')}`, state: 'TX' })),
    });
  });

  it('streams every matching row across pages in the order of the list', async () => {
    const res = await U.agent.get('/api/carriers/export.csv?sort=companyName&dir=desc');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="carriers-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = res.text.trim().split(/\r?\n/);
    expect(lines).toHaveLength(1206);
    expect(lines[0]).toMatch(/^Company name,DBA,USDOT,MC,/);
    expect(lines[1]).toMatch(/^Export Co 1204,/);
    expect(lines[1000]).toMatch(/^Export Co 0205,/);
    expect(lines[1001]).toMatch(/^Export Co 0204,/);
    expect(lines[1205]).toMatch(/^Export Co 0000,/);
    const log = await prisma.auditLog.findFirst({ where: { actorId: U.user.id, action: 'carriers.export' }, orderBy: { createdAt: 'desc' } });
    expect(JSON.parse(log.details)).toEqual({ count: 1205 });
  });

  it('refuses an export over the row limit instead of cutting the file short', async () => {
    process.env.CARRIER_EXPORT_MAX_ROWS = '1000';
    try {
      const res = await U.agent.get('/api/carriers/export.csv');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/More than 1,000 carriers match these filters/);
      expect((await U.agent.get('/api/carriers/export.csv?q=Export Co 00')).status).toBe(200);
    } finally {
      delete process.env.CARRIER_EXPORT_MAX_ROWS;
    }
  });

  it('exports only the caller\'s carriers', async () => {
    const other = await registerUser();
    const res = await other.agent.get('/api/carriers/export.csv');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Export Co');
  });

  it('runs one export per account at a time (409 while one is running, across workers)', async () => {
    await withLock(`carriers-export.${U.user.id}`, 60_000, async () => {
      const busy = await U.agent.get('/api/carriers/export.csv');
      expect(busy.status).toBe(409);
      expect(busy.body.error).toMatch(/already running/);
    });
    expect((await U.agent.get('/api/carriers/export.csv?state=TX')).status).toBe(200);
  });
});
