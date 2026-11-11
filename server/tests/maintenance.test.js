import { describe, it, expect, vi } from 'vitest';

// runMaintenance runs every job, including the digest and reply detection over mailboxes other suites created in the
// shared test database: mail servers are mocked so no job waits on a real network connection.
vi.mock('nodemailer', () => {
  const createTransport = vi.fn(() => ({ verify: async () => true, sendMail: async (m) => ({ messageId: '<m@test>', accepted: [m.to], rejected: [] }), close: () => {} }));
  return { default: { createTransport }, createTransport };
});
vi.mock('imapflow', () => ({
  ImapFlow: class {
    async connect() { throw new Error('IMAP is not reachable in tests'); }
    async logout() {}
    close() {}
  },
}));

const { registerUser, createAdmin, prisma } = await import('./helpers.js');
const { JOBS, isDue, runJob, runMaintenance, jobStatuses } = await import('../src/jobs/maintenance.js');
const { withLock, LockBusyError } = await import('../src/lib/locks.js');

const job = (name) => JOBS.find((j) => j.name === name);
const DAY = 86400000;

describe('maintenance jobs', () => {
  it('isDue handles interval and daily-at-UTC schedules', () => {
    const now = new Date('2026-11-10T14:00:00Z');
    expect(isDue({ everyMs: 3600000 }, null, now)).toBe(true);
    expect(isDue({ everyMs: 3600000 }, new Date(now.getTime() - 30 * 60000), now)).toBe(false);
    expect(isDue({ dailyAtUtc: 13 }, new Date('2026-11-10T13:05:00Z'), now)).toBe(false); // already ran after today's slot
    expect(isDue({ dailyAtUtc: 13 }, new Date('2026-11-10T12:00:00Z'), now)).toBe(true); // ran before today's slot
    expect(isDue({ dailyAtUtc: 15 }, new Date('2026-11-09T16:00:00Z'), now)).toBe(false); // today's 15:00 not reached; yesterday's done
  });

  it('removes expired sessions and used tokens', async () => {
    const u = await registerUser();
    await prisma.session.create({ data: { id: `old-${Date.now()}`, userId: u.user.id, expiresAt: new Date(Date.now() - DAY) } });
    await prisma.authToken.create({ data: { userId: u.user.id, type: 'reset_password', tokenHash: `t-${Date.now()}`, expiresAt: new Date(Date.now() - 3 * DAY) } });
    const r1 = await runJob(job('expired-sessions'), new Date());
    expect(r1.ok).toBe(true);
    expect(r1.result.deleted).toBeGreaterThanOrEqual(1);
    const r2 = await runJob(job('expired-tokens'), new Date());
    expect(r2.result.authTokens).toBeGreaterThanOrEqual(1);
    // the live session from registration survives
    expect((await u.agent.get('/api/auth/me')).body.user.id).toBe(u.user.id);
  });

  it('reminds once per stage about expiring documents', async () => {
    const u = await registerUser();
    const c = (await u.agent.post('/api/carriers').send({ companyName: 'Expiry Haulers LLC' })).body.carrier;
    const doc = await prisma.document.create({ data: {
      ownerId: u.user.id, uploadedById: u.user.id, carrierId: c.id, type: 'coi', originalName: 'coi.pdf',
      storedName: `coi-${Date.now()}.pdf`, mimeType: 'application/pdf', sizeBytes: 10, expiresAt: new Date(Date.now() + 5 * DAY),
    } });
    await runJob(job('document-expiry'), new Date());
    await runJob(job('document-expiry'), new Date()); // second run must not duplicate
    const notes = await prisma.notification.findMany({ where: { userId: u.user.id, type: { startsWith: 'document_expiring' } } });
    expect(notes).toHaveLength(1);
    expect(notes[0].type).toBe('document_expiring_7');
    expect(notes[0].title).toMatch(/COI for Expiry Haulers LLC expires in 7 days/);
    expect(notes[0].link).toContain(doc.id);
  });

  it("links a load document to the load's Documents tab and does not repeat an old-style reminder", async () => {
    const u = await registerUser();
    const load = await prisma.load.create({ data: { ownerId: u.user.id, originCity: 'Dallas', originState: 'TX', destCity: 'Memphis', destState: 'TN', loadedMiles: 450, rateCents: 150000 } });
    const mk = (name) => prisma.document.create({ data: {
      ownerId: u.user.id, uploadedById: u.user.id, loadId: load.id, type: 'other', originalName: name,
      storedName: `${name}-${Date.now()}`, mimeType: 'application/pdf', sizeBytes: 10, expiresAt: new Date(Date.now() + 5 * DAY),
    } });
    const fresh = await mk('permit.pdf');
    const old = await mk('old.pdf');
    // A reminder sent before this change used the plain '/app/loads?doc=' link.
    await prisma.notification.create({ data: { userId: u.user.id, type: 'document_expiring_7', title: 'old', link: `/app/loads?doc=${old.id}` } });
    await runJob(job('document-expiry'), new Date());
    const notes = await prisma.notification.findMany({ where: { userId: u.user.id, type: 'document_expiring_7' }, orderBy: { createdAt: 'asc' } });
    expect(notes).toHaveLength(2);
    expect(notes[1].link).toBe(`/app/loads?load=${load.id}&tab=documents&doc=${fresh.id}`);
  });

  it('records job status, and runMaintenance runs only due jobs', async () => {
    const now = new Date();
    await runMaintenance(now, () => {}, { maxJobs: 50 });
    const statuses = await jobStatuses();
    expect(statuses.find((s) => s.name === 'expired-sessions').lastOk).toBe(true);
    const second = await runMaintenance(now, () => {}, { maxJobs: 50 });
    expect(second).not.toContain('expired-sessions');
  });

  it('withLock blocks a second holder and allows takeover of a stale lock', async () => {
    let inner = null;
    await withLock('test.lock', 60000, async () => {
      inner = await withLock('test.lock', 60000, async () => 'no').catch((e) => e);
    });
    expect(inner).toBeInstanceOf(LockBusyError);
    await prisma.systemSetting.create({ data: { key: 'lock.test.stale', value: String(Date.now() - 10 * 60000), secret: false } });
    expect(await withLock('test.stale', 60000, async () => 'taken')).toBe('taken');
  });

  it('admin can list and run jobs; others cannot', async () => {
    const admin = await createAdmin();
    const list = await admin.agent.get('/api/admin/setup/jobs');
    expect(list.status).toBe(200);
    expect(list.body.items.map((j) => j.name)).toContain('database-optimize');
    const run = await admin.agent.post('/api/admin/setup/jobs/database-optimize/run');
    expect(run.status).toBe(200);
    expect(run.body.result.ok).toBe(true);
    const u = await registerUser();
    expect((await u.agent.post('/api/admin/setup/jobs/database-optimize/run')).status).toBe(403);
  });
});
