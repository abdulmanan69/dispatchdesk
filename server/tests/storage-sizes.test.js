import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { registerUser, prisma } from './helpers.js';
import { config } from '../src/config.js';
import { storageUsedBytes } from '../src/lib/plans.js';
import { backfillStoredSizes, jobs } from '../src/jobs/extra/size-backfill.js';
import { randomToken } from '../src/lib/crypto.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0dc4cd0b0000000049454e44ae426082', 'hex');
const PNG_BIG = Buffer.concat([PNG, Buffer.alloc(500, 0)]);
const TEXT = 'Reefer lanes from Fresno to Dallas pay well in the spring. Detention after two hours.';
const stored = (dir, name) => path.join(config.uploadDir, dir, path.basename(name));

async function listing(agent) {
  const res = await agent.post('/api/marketplace/listings').send({ title: 'Dispatch service', category: 'services', description: 'We dispatch.', priceType: 'contact' });
  expect(res.status).toBe(201);
  return res.body.listing.id;
}

describe('stored file sizes for the storage quota', () => {
  it('AI knowledge uploads record their size and count from the database, not the disk', async () => {
    const u = await registerUser();
    const up = await u.agent.post('/api/ai/knowledge').field('title', 'Lanes').attach('file', Buffer.from(TEXT), { filename: 'lanes.txt', contentType: 'text/plain' });
    expect(up.status).toBe(201);
    const row = await prisma.aIKnowledgeDocument.findUnique({ where: { id: up.body.document.id } });
    expect(row.sizeBytes).toBe(Buffer.byteLength(TEXT));
    expect(await storageUsedBytes([u.user.id])).toBe(Buffer.byteLength(TEXT));
    // The sum comes from the row: a file that is gone from disk still counts until the document is deleted.
    fs.rmSync(stored('knowledge', row.storedName), { force: true });
    expect(await storageUsedBytes([u.user.id])).toBe(Buffer.byteLength(TEXT));
    expect((await u.agent.delete(`/api/ai/knowledge/${row.id}`)).status).toBe(200);
    expect(await storageUsedBytes([u.user.id])).toBe(0);
  });

  it('marketplace images record their size; replacing updates it and removing clears it', async () => {
    const u = await registerUser();
    const other = await registerUser();
    const id = await listing(u.agent);
    expect((await u.agent.post(`/api/marketplace/listings/${id}/image`).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })).status).toBe(200);
    expect((await prisma.marketplaceListing.findUnique({ where: { id } })).sizeBytes).toBe(PNG.length);
    expect(await storageUsedBytes([u.user.id])).toBe(PNG.length);
    expect((await u.agent.post(`/api/marketplace/listings/${id}/image`).attach('file', PNG_BIG, { filename: 'b.png', contentType: 'image/png' })).status).toBe(200);
    expect((await prisma.marketplaceListing.findUnique({ where: { id } })).sizeBytes).toBe(PNG_BIG.length);
    expect(await storageUsedBytes([u.user.id])).toBe(PNG_BIG.length);
    // Another user's storage is not affected and cannot change the listing.
    expect(await storageUsedBytes([other.user.id])).toBe(0);
    expect((await other.agent.post(`/api/marketplace/listings/${id}/image`).attach('file', PNG, { filename: 'c.png', contentType: 'image/png' })).status).toBe(404);
    expect((await u.agent.delete(`/api/marketplace/listings/${id}/image`)).status).toBe(200);
    expect(await prisma.marketplaceListing.findUnique({ where: { id } })).toMatchObject({ imagePath: null, sizeBytes: 0 });
    expect(await storageUsedBytes([u.user.id])).toBe(0);
  });

  describe('one-time size backfill', () => {
    beforeEach(() => prisma.systemSetting.deleteMany({ where: { key: 'storage.sizeBackfill' } }));

    it('fills sizes of older rows from disk in batches, skips missing files and then stops', async () => {
      const u = await registerUser();
      fs.mkdirSync(path.join(config.uploadDir, 'knowledge'), { recursive: true });
      fs.mkdirSync(path.join(config.uploadDir, 'marketplace'), { recursive: true });
      const docs = [];
      for (let i = 0; i < 3; i++) {
        const storedName = `old-${randomToken(8)}.txt`;
        fs.writeFileSync(stored('knowledge', storedName), 'x'.repeat(100 + i));
        docs.push(await prisma.aIKnowledgeDocument.create({ data: { ownerId: u.user.id, title: `Old ${i}`, originalName: 'old.txt', storedName, mimeType: 'text/plain', status: 'ready' } }));
      }
      const gone = await prisma.aIKnowledgeDocument.create({ data: { ownerId: u.user.id, title: 'Gone', originalName: 'gone.txt', storedName: `gone-${randomToken(8)}.txt`, mimeType: 'text/plain', status: 'ready' } });
      const imagePath = `old-${randomToken(8)}.png`;
      fs.writeFileSync(stored('marketplace', imagePath), PNG);
      const old = await prisma.marketplaceListing.create({ data: { sellerId: u.user.id, title: 'Old listing', category: 'services', description: 'd', priceType: 'contact', imagePath } });
      expect(await storageUsedBytes([u.user.id])).toBe(0); // not recorded yet

      // Batches of 2 here, so the cursor has to carry over between batches.
      let r = await backfillStoredSizes({ batch: 2 });
      for (let i = 0; i < 50 && !r.done && !r.skipped; i++) r = await backfillStoredSizes({ batch: 2 });
      expect(r.done || r.skipped === 'done').toBe(true);
      for (const [i, d] of docs.entries()) expect((await prisma.aIKnowledgeDocument.findUnique({ where: { id: d.id } })).sizeBytes).toBe(100 + i);
      expect((await prisma.aIKnowledgeDocument.findUnique({ where: { id: gone.id } })).sizeBytes).toBe(0);
      expect((await prisma.marketplaceListing.findUnique({ where: { id: old.id } })).sizeBytes).toBe(PNG.length);
      expect(await storageUsedBytes([u.user.id])).toBe(100 + 101 + 102 + PNG.length);
      // Done for good: later runs do nothing.
      expect(await backfillStoredSizes()).toEqual({ skipped: 'done' });
    });

    it('never overwrites a size recorded by a newer upload', async () => {
      const u = await registerUser();
      const id = await listing(u.agent);
      expect((await u.agent.post(`/api/marketplace/listings/${id}/image`).attach('file', PNG_BIG, { filename: 'a.png', contentType: 'image/png' })).status).toBe(200);
      await backfillStoredSizes();
      expect((await prisma.marketplaceListing.findUnique({ where: { id } })).sizeBytes).toBe(PNG_BIG.length);
    });

    it('is registered as a maintenance job', () => {
      expect(jobs).toEqual([expect.objectContaining({ name: 'storage-size-backfill', everyMs: expect.any(Number), run: expect.any(Function) })]);
    });
  });
});
