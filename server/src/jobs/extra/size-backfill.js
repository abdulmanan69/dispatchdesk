import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../../db.js';
import { config } from '../../config.js';

/**
 * storage-size-backfill: one-time pass that records the stored file size (sizeBytes) of AI knowledge files and
 * marketplace listing images uploaded before the column existed, so storage use is one SUM per table (lib/plans.js
 * storageUsedBytes) instead of reading the disk.
 *
 * Each table is walked by id from a saved cursor, in batches of 200 rows that still have sizeBytes = 0; sizes are read
 * from disk a few at a time and written in one transaction per batch. A row is only written while it still has
 * sizeBytes = 0 and the same file, so a newer upload is never overwritten. Files missing on disk stay at 0 (nothing
 * is stored for them). Once both tables are walked the job marks itself done, and later runs are one key lookup.
 * Like every maintenance job it runs under the database job lock (one worker at a time).
 */
const MIN = 60_000;
const STATE_KEY = 'storage.sizeBackfill';
export const SIZE_BACKFILL_BATCH = 200;
const STAT_CONCURRENCY = 8;

const TABLES = [
  { key: 'knowledge', model: 'aIKnowledgeDocument', dir: 'knowledge', file: 'storedName', where: {} },
  { key: 'listings', model: 'marketplaceListing', dir: 'marketplace', file: 'imagePath', where: { imagePath: { not: null } } },
];

async function readState() {
  const row = await prisma.systemSetting.findUnique({ where: { key: STATE_KEY } });
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}
async function writeState(state) {
  const value = JSON.stringify(state);
  await prisma.systemSetting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value, secret: false }, update: { value } });
}

async function sizeOf(dir, name) {
  if (!name) return 0;
  try { return (await fs.stat(path.join(config.uploadDir, dir, path.basename(name)))).size; } catch { return 0; }
}

/** One batch of a table: the rows after `after` that still have no size. Returns { rows, updated, missing }. */
async function fillBatch(t, after, batch) {
  const rows = await prisma[t.model].findMany({
    where: { ...t.where, sizeBytes: 0, ...(after ? { id: { gt: after } } : {}) },
    orderBy: { id: 'asc' }, take: batch, select: { id: true, [t.file]: true },
  });
  const writes = [];
  let missing = 0;
  for (let i = 0; i < rows.length; i += STAT_CONCURRENCY) {
    const part = rows.slice(i, i + STAT_CONCURRENCY);
    const sizes = await Promise.all(part.map((r) => sizeOf(t.dir, r[t.file])));
    part.forEach((r, k) => {
      if (sizes[k] > 0) writes.push(prisma[t.model].updateMany({ where: { id: r.id, sizeBytes: 0, [t.file]: r[t.file] }, data: { sizeBytes: sizes[k] } }));
      else missing++;
    });
  }
  const results = writes.length ? await prisma.$transaction(writes) : [];
  return { rows, updated: results.reduce((s, r) => s + r.count, 0), missing };
}

/** Fill sizes within a time budget. Returns { updated, missing, done } or { skipped: 'done' }. */
export async function backfillStoredSizes({ budgetMs = 5000, batch = SIZE_BACKFILL_BATCH } = {}) {
  const state = await readState();
  if (state.done) return { skipped: 'done' };
  const started = Date.now();
  let updated = 0;
  let missing = 0;
  for (const t of TABLES) {
    const s = (state[t.key] ||= {});
    while (!s.done && Date.now() - started < budgetMs) {
      const res = await fillBatch(t, s.after || null, batch);
      updated += res.updated;
      missing += res.missing;
      if (res.rows.length) s.after = res.rows[res.rows.length - 1].id;
      if (res.rows.length < batch) s.done = true;
    }
  }
  const done = TABLES.every((t) => state[t.key]?.done);
  await writeState({ ...state, done, ...(done ? { finishedAt: new Date().toISOString() } : {}) });
  return { updated, missing, done };
}

export const jobs = [
  {
    name: 'storage-size-backfill', label: 'Record file sizes of AI knowledge files and marketplace images for the storage quota (one-time)',
    everyMs: 10 * MIN, run: () => backfillStoredSizes(),
  },
];
