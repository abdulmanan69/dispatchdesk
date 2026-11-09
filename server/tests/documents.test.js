import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { registerUser, prisma } from './helpers.js';
import { config } from '../src/config.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const docDir = () => path.join(config.uploadDir, 'documents');
const fileCount = () => (fs.existsSync(docDir()) ? fs.readdirSync(docDir()).length : 0);

describe('documents', () => {
  let me;
  let other;
  let carrier;
  beforeAll(async () => {
    me = await registerUser();
    other = await registerUser();
    const stage = await prisma.pipelineStage.findUnique({ where: { key: 'customer' } });
    carrier = await prisma.carrier.create({ data: { ownerId: me.user.id, stageId: stage.id, companyName: 'Docs Carrier LLC' } });
  });

  it('uploads, lists, downloads, updates, replaces and deletes a carrier document', async () => {
    const a = me.agent;
    const up = await a.post('/api/documents').field('carrierId', carrier.id).field('type', 'w9').attach('file', PDF, { filename: 'W9 form.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    const doc = up.body.document;
    expect(doc).toMatchObject({ type: 'w9', originalName: 'W9 form.pdf', mimeType: 'application/pdf', sizeBytes: PDF.length, carrierId: carrier.id });
    expect(doc).not.toHaveProperty('storedName');

    const list = await a.get(`/api/documents?carrierId=${carrier.id}`);
    expect(list.body.items.map((d) => d.id)).toContain(doc.id);
    expect((await a.get(`/api/documents?carrierId=${carrier.id}&types=coi`)).body.items).toHaveLength(0);

    const dl = await a.get(`/api/documents/${doc.id}/download`).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/attachment; filename\*=UTF-8''W9%20form\.pdf/);
    expect(Buffer.compare(dl.body, PDF)).toBe(0);

    const patched = await a.patch(`/api/documents/${doc.id}`).send({ type: 'coi', expiresAt: new Date(Date.now() + 10 * 86400000).toISOString() });
    expect(patched.body.document.type).toBe('coi');
    expect(patched.body.document.expiresAt).toBeTruthy();

    const before = await prisma.document.findUnique({ where: { id: doc.id } });
    const rep = await a.put(`/api/documents/${doc.id}`).attach('file', PNG, { filename: 'coi.png', contentType: 'image/png' });
    expect(rep.status).toBe(200);
    expect(rep.body.document).toMatchObject({ id: doc.id, originalName: 'coi.png', mimeType: 'image/png', type: 'coi' });
    expect(fs.existsSync(path.join(docDir(), before.storedName))).toBe(false);

    const after = await prisma.document.findUnique({ where: { id: doc.id } });
    const del = await a.delete(`/api/documents/${doc.id}`);
    expect(del.status).toBe(200);
    expect(await prisma.document.findUnique({ where: { id: doc.id } })).toBeNull();
    expect(fs.existsSync(path.join(docDir(), after.storedName))).toBe(false);
  });

  it('feeds the customer compliance checklist (expiring COI)', async () => {
    const a = me.agent;
    await prisma.customer.upsert({ where: { carrierId: carrier.id }, create: { carrierId: carrier.id, ownerId: me.user.id }, update: {} });
    await a.post('/api/documents').field('carrierId', carrier.id).field('type', 'coi').field('expiresAt', new Date(Date.now() + 5 * 86400000).toISOString())
      .attach('file', PDF, { filename: 'coi.pdf', contentType: 'application/pdf' });
    await a.post('/api/documents').field('carrierId', carrier.id).field('type', 'agreement').attach('file', PDF, { filename: 'agreement.pdf', contentType: 'application/pdf' });
    const cust = await prisma.customer.findUnique({ where: { carrierId: carrier.id } });
    const res = await a.get(`/api/customers/${cust.id}`);
    const byType = Object.fromEntries(res.body.checklist.map((c) => [c.type, c.status]));
    expect(byType).toEqual({ agreement: 'on_file', mc_authority: 'missing', w9: 'missing', coi: 'expiring' });
  });

  it('attaches documents to loads', async () => {
    const load = (await me.agent.post('/api/loads').send({ originCity: 'Dallas', originState: 'TX', destCity: 'Austin', destState: 'TX', loadedMiles: 195, rateCents: 65000 })).body.load;
    const up = await me.agent.post('/api/documents').field('loadId', load.id).field('type', 'rate_confirmation').attach('file', PDF, { filename: 'ratecon.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    expect((await me.agent.get(`/api/documents?loadId=${load.id}`)).body.items).toHaveLength(1);
    expect((await me.agent.get(`/api/loads/${load.id}`)).body.load.documents).toHaveLength(1);
  });

  it('rejects disallowed types and spoofed file contents without leaving files behind', async () => {
    const a = me.agent;
    const n = fileCount();
    const exe = await a.post('/api/documents').field('carrierId', carrier.id).attach('file', Buffer.from('MZ\x90\x00'), { filename: 'virus.exe', contentType: 'application/octet-stream' });
    expect(exe.status).toBe(400);
    const spoof = await a.post('/api/documents').field('carrierId', carrier.id).attach('file', Buffer.from('<html><script>alert(1)</script></html>'), { filename: 'invoice.pdf', contentType: 'application/pdf' });
    expect(spoof.status).toBe(400);
    expect(spoof.body.error).toMatch(/do not match/);
    const noParent = await a.post('/api/documents').attach('file', PDF, { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(noParent.status).toBe(400);
    expect(fileCount()).toBe(n);
  });

  it('denies other tenants every document operation', async () => {
    const doc = (await me.agent.post('/api/documents').field('carrierId', carrier.id).field('type', 'mc_authority').attach('file', PDF, { filename: 'mc.pdf', contentType: 'application/pdf' })).body.document;
    const b = other.agent;
    const n = fileCount();
    expect((await b.get(`/api/documents/${doc.id}/download`)).status).toBe(404);
    expect((await b.get(`/api/documents?carrierId=${carrier.id}`)).status).toBe(404);
    expect((await b.patch(`/api/documents/${doc.id}`).send({ type: 'other' })).status).toBe(404);
    expect((await b.delete(`/api/documents/${doc.id}`)).status).toBe(404);
    const rep = await b.put(`/api/documents/${doc.id}`).attach('file', PDF, { filename: 'evil.pdf', contentType: 'application/pdf' });
    expect(rep.status).toBe(404);
    const up = await b.post('/api/documents').field('carrierId', carrier.id).attach('file', PDF, { filename: 'evil.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(404);
    expect(fileCount()).toBe(n);
    expect((await prisma.document.findUnique({ where: { id: doc.id } })).originalName).toBe('mc.pdf');
  });
});
