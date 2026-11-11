import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { registerUser, prisma } from './helpers.js';
import { config } from '../src/config.js';
import { STORAGE_MB, storageStatus } from '../src/lib/plans.js';
import { randomToken } from '../src/lib/crypto.js';

const MB = 1024 * 1024;
const PDF = (size = 2048) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(size, 0x20), Buffer.from('\n%%EOF\n')]);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0dc4cd0b0000000049454e44ae426082', 'hex');
const docDir = () => path.join(config.uploadDir, 'documents');
const files = () => (fs.existsSync(docDir()) ? fs.readdirSync(docDir()).length : 0);

/** Pretend the account already stores `bytes` (a document row without a file; only its size counts). */
async function fillStorage(userId, bytes) {
  return prisma.document.create({ data: { ownerId: userId, uploadedById: userId, type: 'other', originalName: 'filler.pdf', storedName: `filler-${randomToken(8)}.pdf`, mimeType: 'application/pdf', sizeBytes: bytes } });
}

describe('storage quota', () => {
  let stage;
  beforeAll(async () => {
    stage = (await prisma.pipelineStage.findUnique({ where: { key: 'customer' } })).id;
  });

  async function carrierFor(user) {
    return prisma.carrier.create({ data: { ownerId: user.id, stageId: stage, companyName: `Quota Carrier ${randomToken(4)}` } });
  }

  it('defaults: Free 500 MB, paid 5 GB, Teams 20 GB per member', () => {
    expect(STORAGE_MB).toEqual({ free: 500, paid: 5120, teamPerMember: 20480 });
  });

  it('refuses an upload that does not fit, with a clear 402, and writes nothing', async () => {
    const u = await registerUser();
    const carrier = await carrierFor(u.user);
    await fillStorage(u.user.id, STORAGE_MB.free * MB - 1000); // 1000 bytes left
    const before = files();
    const res = await u.agent.post('/api/documents').field('carrierId', carrier.id).field('type', 'w9').attach('file', PDF(4096), { filename: 'w9.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('STORAGE_FULL');
    expect(res.body.error).toMatch(/Not enough file storage\. Your Free plan includes 500 MB/);
    expect(res.body.error).toMatch(/Delete files you no longer need or upgrade/);
    expect(files()).toBe(before);
    expect(await prisma.document.count({ where: { carrierId: carrier.id } })).toBe(0);
  });

  it('refuses before reading the body when the account is already full', async () => {
    const u = await registerUser();
    const carrier = await carrierFor(u.user);
    await fillStorage(u.user.id, STORAGE_MB.free * MB);
    const res = await u.agent.post('/api/documents').field('carrierId', carrier.id).attach('file', PDF(), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(402);
    // Avatars count toward the same quota.
    const av = await u.agent.post('/api/profile/avatar').attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(av.status).toBe(402);
  });

  it('accepts uploads that fit and shows usage on Billing', async () => {
    const u = await registerUser();
    const carrier = await carrierFor(u.user);
    const up = await u.agent.post('/api/documents').field('carrierId', carrier.id).attach('file', PDF(3000), { filename: 'coi.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    const me = await u.agent.get('/api/billing/me');
    expect(me.body.storage).toEqual({ usedBytes: up.body.document.sizeBytes, limitBytes: STORAGE_MB.free * MB, scope: 'user' });
    expect(me.body.plan.limits.storageMb).toBe(500);
    expect(me.body.plan.features).toContain('500 MB file storage');
  });

  it('replacing a document only counts the size difference', async () => {
    const u = await registerUser();
    const carrier = await carrierFor(u.user);
    const doc = (await u.agent.post('/api/documents').field('carrierId', carrier.id).attach('file', PDF(6000), { filename: 'big.pdf', contentType: 'application/pdf' })).body.document;
    const used = (await storageStatus({ ...u.user, id: u.user.id })).usedBytes;
    await fillStorage(u.user.id, STORAGE_MB.free * MB - used - 100); // 100 bytes free
    const replace = await u.agent.put(`/api/documents/${doc.id}`).attach('file', PDF(5000), { filename: 'smaller.pdf', contentType: 'application/pdf' });
    expect(replace.status).toBe(200);
    const extra = await u.agent.post('/api/documents').field('carrierId', carrier.id).attach('file', PDF(5000), { filename: 'new.pdf', contentType: 'application/pdf' });
    expect(extra.status).toBe(402);
  });

  it('paid plans get 5 GB; Teams subscriptions pool 20 GB per member', async () => {
    const solo = await registerUser();
    const pro = await prisma.plan.findUnique({ where: { key: 'pro' } });
    await prisma.subscription.create({ data: { userId: solo.user.id, planId: pro.id, status: 'active', seats: 1 } });
    expect((await solo.agent.get('/api/billing/me')).body.storage).toMatchObject({ limitBytes: 5120 * MB, scope: 'user' });

    const owner = await registerUser();
    const member = await registerUser();
    const team = (await owner.agent.post('/api/teams').send({ name: `Storage Team ${randomToken(4)}` })).body.team;
    await prisma.teamMember.create({ data: { teamId: team.id, userId: member.user.id, role: 'dispatcher' } });
    const teams = await prisma.plan.findUnique({ where: { key: 'teams' } });
    await prisma.subscription.create({ data: { userId: owner.user.id, teamId: team.id, planId: teams.id, status: 'active', seats: 3 } });
    await fillStorage(owner.user.id, 10 * MB);
    await fillStorage(member.user.id, 5 * MB);
    const s = (await member.agent.get('/api/billing/me')).body.storage;
    expect(s).toEqual({ scope: 'team', limitBytes: 3 * 20480 * MB, usedBytes: 15 * MB });
  });

  it('other tenants never see or use someone else\'s storage', async () => {
    const a = await registerUser();
    const b = await registerUser();
    await fillStorage(a.user.id, 50 * MB);
    expect((await b.agent.get('/api/billing/me')).body.storage.usedBytes).toBe(0);
  });
});
