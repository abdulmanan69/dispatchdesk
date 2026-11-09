import fs from 'node:fs';
import path from 'node:path';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { prisma } from '../../db.js';
import { filePath } from '../../middleware/upload.js';
import { embed } from './llm.js';

const CHUNK = 1200;
const OVERLAP = 200;

export async function extractText(file, originalName) {
  const ext = path.extname(originalName || file).toLowerCase();
  const buf = fs.readFileSync(file);
  if (ext === '.pdf') {
    const out = await pdfParse(buf);
    return out.text || '';
  }
  return buf.toString('utf8');
}

/** Paragraph-aware chunking with overlap. */
export function chunkText(text, size = CHUNK, overlap = OVERLAP) {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const paras = clean.split(/\n\n/);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length <= size) { cur = cur ? `${cur}\n\n${p}` : p; continue; }
    if (cur) chunks.push(cur);
    if (p.length <= size) { cur = p; continue; }
    for (let i = 0; i < p.length; i += size - overlap) chunks.push(p.slice(i, i + size));
    cur = '';
  }
  if (cur) chunks.push(cur);
  // add a little trailing context from the previous chunk for continuity
  return chunks.map((c, i) => (i > 0 && overlap ? `${chunks[i - 1].slice(-Math.min(overlap, 150))}\n${c}` : c));
}

/** Extract, chunk and (optionally) embed a knowledge document. Marks it ready or error. */
export async function ingestDocument(docId) {
  const doc = await prisma.aIKnowledgeDocument.findUnique({ where: { id: docId } });
  if (!doc) return null;
  try {
    const text = await extractText(filePath('knowledge', doc.storedName), doc.originalName);
    const chunks = chunkText(text);
    if (!chunks.length) throw new Error('No readable text found in this file');
    let vectors = null;
    try { vectors = await embed(chunks); } catch (err) { console.warn('[rag] embeddings unavailable, using keyword retrieval:', err.message); }
    await prisma.aIKnowledgeChunk.deleteMany({ where: { documentId: doc.id } });
    await prisma.aIKnowledgeChunk.createMany({
      data: chunks.map((content, idx) => ({ documentId: doc.id, idx, content, embedding: vectors ? JSON.stringify(vectors[idx]) : null })),
    });
    return prisma.aIKnowledgeDocument.update({ where: { id: doc.id }, data: { status: 'ready', chunkCount: chunks.length, error: null } });
  } catch (err) {
    return prisma.aIKnowledgeDocument.update({ where: { id: doc.id }, data: { status: 'error', error: err.message.slice(0, 500) } });
  }
}

/** Documents a user may retrieve from: their own private docs + approved global docs. */
export const accessibleDocsWhere = (userId) => ({
  status: 'ready',
  OR: [{ ownerId: userId, scope: 'private' }, { scope: 'global', approved: true }],
});

const tokenize = (s) => (String(s).toLowerCase().match(/[a-z0-9]{2,}/g) || []).filter((w) => !STOP.has(w));
const STOP = new Set('the and for are but not you your with this that from have has was were will can what how why when who which into about our they them their there then than its also just more most some such only very do does did of to in on at by an or as is it be if so no'.split(' '));

function bm25(queryTokens, docs) {
  const N = docs.length;
  const avgdl = docs.reduce((s, d) => s + d.tokens.length, 0) / (N || 1);
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) || 0) + 1);
  const k1 = 1.4;
  const b = 0.75;
  return docs.map((d) => {
    const tf = new Map();
    for (const t of d.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const q of new Set(queryTokens)) {
      const f = tf.get(q);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(q) + 0.5) / (df.get(q) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.tokens.length) / avgdl)));
    }
    return score;
  });
}

const cosine = (a, b) => {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** Top-k chunks for a query, restricted to documents the user may access. */
export async function retrieve(userId, query, k = 5) {
  const chunks = await prisma.aIKnowledgeChunk.findMany({
    where: { document: accessibleDocsWhere(userId) },
    include: { document: { select: { id: true, title: true, updatedAt: true, scope: true } } },
    take: 8000,
  });
  if (!chunks.length) return [];
  let scores = null;
  if (chunks.every((c) => c.embedding)) {
    try {
      const [qv] = (await embed([query])) || [];
      if (qv) scores = chunks.map((c) => cosine(qv, JSON.parse(c.embedding)));
    } catch { scores = null; }
  }
  if (!scores) {
    const qt = tokenize(query);
    if (!qt.length) return [];
    scores = bm25(qt, chunks.map((c) => ({ tokens: tokenize(c.content) })));
  }
  return chunks
    .map((c, i) => ({ score: scores[i], content: c.content, documentId: c.document.id, title: c.document.title, date: c.document.updatedAt, scope: c.document.scope }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
