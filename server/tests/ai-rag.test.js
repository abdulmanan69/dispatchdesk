import { describe, it, expect } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { extractText, retrieve, chunkText } from '../src/services/ai/rag.js';

async function doc(ownerId, { scope = 'private', approved = true, title = 'Doc', chunks = [] } = {}) {
  const d = await prisma.aIKnowledgeDocument.create({
    data: { ownerId, scope, approved, title, originalName: `${title}.txt`, storedName: `rag-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`, mimeType: 'text/plain', status: 'ready', chunkCount: chunks.length },
  });
  await prisma.aIKnowledgeChunk.createMany({ data: chunks.map((content, idx) => ({ documentId: d.id, idx, content })) });
  return d;
}

describe('knowledge retrieval', () => {
  it('parses PDFs in a worker thread', async () => {
    const text = await extractText('node_modules/pdf-parse/test/data/01-valid.pdf', 'paper.pdf');
    expect(text).toMatch(/Trace-based Just-in-Time/);
    await expect(extractText('node_modules/pdf-parse/test/data/03-invalid.pdf', 'bad.pdf')).rejects.toThrow(/Could not read this PDF/);
  });

  it('finds the matching chunk among many, from accessible documents only', async () => {
    const A = await registerUser();
    const B = await registerUser();
    const filler = Array.from({ length: 300 }, (_, i) => `General dispatch note number ${i} about paperwork and detention.`);
    await doc(A.user.id, { title: 'Big binder', chunks: [...filler, 'The Fresno to Dallas reefer lane uses quartzline pricing.'] });
    await doc(B.user.id, { title: 'B secret', chunks: ['Quartzline pricing secret for B only.'] });
    await doc(B.user.id, { title: 'Shared guide', scope: 'global', approved: true, chunks: ['Quartzline basics everyone may read.'] });
    await doc(B.user.id, { title: 'Unapproved', scope: 'global', approved: false, chunks: ['Quartzline draft guidance.'] });
    const hits = await retrieve(A.user.id, 'How does quartzline pricing work?', 5);
    const titles = hits.map((h) => h.title);
    expect(titles).toContain('Big binder');
    expect(titles).toContain('Shared guide');
    expect(titles).not.toContain('B secret');
    expect(titles).not.toContain('Unapproved');
    expect(hits[0].content).toMatch(/quartzline/i);
    expect(await retrieve(A.user.id, 'zzzunmatched', 5)).toEqual([]);
  });

  it('chunks text with overlap', () => {
    const chunks = chunkText(`${'a'.repeat(1000)}\n\n${'b'.repeat(1000)}`);
    expect(chunks).toHaveLength(2);
  });
});
