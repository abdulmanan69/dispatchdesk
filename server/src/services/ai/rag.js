import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { prisma } from '../../db.js';
import { filePath } from '../../middleware/upload.js';
import { embed } from './llm.js';

const CHUNK = 1200;
const OVERLAP = 200;

// Ingestion bounds: file size (the upload limit is 20 MB), extracted text and chunk count per document.
export const RAG_LIMITS = {
  maxFileBytes: 20 * 1024 * 1024,
  maxChars: 2_000_000,
  maxChunks: 2000,
  pdfTimeoutMs: 60000,
  // Retrieval bounds: candidates scored per question (never the whole knowledge base).
  maxDocs: 500,
  keywordCandidates: 400,
  vectorCandidates: 600,
};

let pdfSlots = 2; // at most two PDF workers at once per process
const pdfQueue = [];
async function withPdfSlot(fn) {
  if (pdfSlots <= 0) await new Promise((resolve) => pdfQueue.push(resolve));
  pdfSlots--;
  try {
    return await fn();
  } finally {
    pdfSlots++;
    pdfQueue.shift()?.();
  }
}

/** Parse a PDF in a worker thread (CPU-heavy work off the event loop), with a time limit. */
function parsePdfInWorker(file) {
  return withPdfSlot(() => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdfWorker.js', import.meta.url), {
      workerData: { file, maxChars: RAG_LIMITS.maxChars },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      execArgv: process.execArgv.filter((a) => !a.startsWith('--input-type')),
    });
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(reject, new Error('Reading this PDF took too long'));
    }, RAG_LIMITS.pdfTimeoutMs);
    worker.once('message', (m) => {
      if (m?.error) finish(reject, new Error(`Could not read this PDF: ${m.error}`));
      else finish(resolve, m?.text || '');
      worker.terminate().catch(() => {});
    });
    worker.once('error', (err) => finish(reject, new Error(`Could not read this PDF: ${err.message}`)));
    worker.once('exit', (code) => finish(reject, new Error(`PDF reader stopped (code ${code})`)));
  }));
}

export async function extractText(file, originalName) {
  const ext = path.extname(originalName || file).toLowerCase();
  const size = fs.statSync(file).size;
  if (size > RAG_LIMITS.maxFileBytes) throw new Error(`This file is larger than ${RAG_LIMITS.maxFileBytes / 1024 / 1024} MB`);
  if (ext === '.pdf') return parsePdfInWorker(file);
  return (await fs.promises.readFile(file)).toString('utf8').slice(0, RAG_LIMITS.maxChars);
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
    const chunks = chunkText(text).slice(0, RAG_LIMITS.maxChunks);
    if (!chunks.length) throw new Error('No readable text found in this file');
    let vectors = null;
    try { vectors = await embed(chunks); } catch (err) { console.warn('[rag] embeddings unavailable, using keyword retrieval:', err.message); }
    await prisma.aIKnowledgeChunk.deleteMany({ where: { documentId: doc.id } });
    for (let i = 0; i < chunks.length; i += 200) {
      await prisma.aIKnowledgeChunk.createMany({
        data: chunks.slice(i, i + 200).map((content, j) => ({ documentId: doc.id, idx: i + j, content, embedding: vectors ? JSON.stringify(vectors[i + j]) : null })),
      });
    }
    vectorCache.clear();
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

// Parsed embeddings by chunk id (Float32Array), bounded; cleared whenever a document is (re)ingested.
const VECTOR_CACHE_MAX = 3000;
const vectorCache = new Map();
function vectorOf(chunk) {
  let v = vectorCache.get(chunk.id);
  if (!v) {
    v = Float32Array.from(JSON.parse(chunk.embedding));
    if (vectorCache.size >= VECTOR_CACHE_MAX) vectorCache.delete(vectorCache.keys().next().value);
    vectorCache.set(chunk.id, v);
  }
  return v;
}

/** The longest distinct query words, used for a SQL prefilter (LIKE runs inside SQLite, rows stay there). */
function keywordTerms(query) {
  return [...new Set(tokenize(query).filter((t) => t.length >= 3))].sort((a, b) => b.length - a.length).slice(0, 6);
}

/**
 * Top-k chunks for a query, restricted to documents the user may access.
 * Bounded per question: documents are listed (max 500, the user's own first), then at most a few hundred candidate
 * chunks are loaded: chunks containing query words (SQL prefilter), plus for vector search the first chunks of the
 * user's documents. Scoring runs only on those candidates.
 */
export async function retrieve(userId, query, k = 5) {
  const docs = await prisma.aIKnowledgeDocument.findMany({
    where: accessibleDocsWhere(userId), select: { id: true, title: true, updatedAt: true, scope: true },
    orderBy: [{ scope: 'desc' }, { updatedAt: 'desc' }], take: RAG_LIMITS.maxDocs, // 'private' sorts before 'global'
  });
  if (!docs.length) return [];
  const docById = new Map(docs.map((d) => [d.id, d]));
  const docIds = docs.map((d) => d.id);
  const terms = keywordTerms(query);
  const embedded = !(await prisma.aIKnowledgeChunk.findFirst({ where: { documentId: { in: docIds }, embedding: null }, select: { id: true } }));

  const select = { id: true, documentId: true, content: true, ...(embedded ? { embedding: true } : {}) };
  const keyword = terms.length
    ? await prisma.aIKnowledgeChunk.findMany({
      where: { documentId: { in: docIds }, OR: terms.map((t) => ({ content: { contains: t } })) },
      select, take: RAG_LIMITS.keywordCandidates,
    })
    : [];

  let scores = null;
  let candidates = keyword;
  if (embedded) {
    try {
      const [qv] = (await embed([query])) || [];
      if (qv) {
        const seen = new Set(keyword.map((c) => c.id));
        const extra = await prisma.aIKnowledgeChunk.findMany({
          where: { documentId: { in: docIds }, id: { notIn: [...seen].slice(0, 500) } },
          select, orderBy: [{ documentId: 'asc' }, { idx: 'asc' }], take: Math.max(0, RAG_LIMITS.vectorCandidates - keyword.length),
        });
        candidates = [...keyword, ...extra];
        scores = candidates.map((c) => cosine(qv, vectorOf(c)));
      }
    } catch { scores = null; candidates = keyword; }
  }
  if (!scores) {
    const qt = tokenize(query);
    if (!qt.length || !candidates.length) return [];
    scores = bm25(qt, candidates.map((c) => ({ tokens: tokenize(c.content) })));
  }
  return candidates
    .map((c, i) => {
      const d = docById.get(c.documentId);
      return { score: scores[i], content: c.content, documentId: c.documentId, title: d?.title, date: d?.updatedAt, scope: d?.scope };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
