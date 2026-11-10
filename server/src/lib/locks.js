import { prisma } from '../db.js';

/**
 * Cross-process mutex backed by the SystemSetting table's primary key (works with several cluster workers on one SQLite file).
 * A lock older than ttlMs is considered abandoned (its process died) and can be taken over.
 * Returns fn()'s result, or throws LockBusyError when another process holds the lock.
 */
export class LockBusyError extends Error {
  constructor(key) { super(`Busy: ${key}`); this.code = 'LOCK_BUSY'; }
}

const lockKey = (name) => `lock.${name}`;

async function acquire(name, ttlMs) {
  const key = lockKey(name);
  const now = Date.now();
  try {
    await prisma.systemSetting.create({ data: { key, value: String(now), secret: false } });
    return true;
  } catch (err) {
    if (err.code !== 'P2002') throw err;
  }
  // Someone holds it: take over only if it is stale, using a compare-and-set on the old value.
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  if (!row) return acquire(name, ttlMs);
  if (now - Number(row.value) < ttlMs) return false;
  const res = await prisma.systemSetting.updateMany({ where: { key, value: row.value }, data: { value: String(now) } });
  return res.count === 1;
}

async function release(name) {
  await prisma.systemSetting.deleteMany({ where: { key: lockKey(name) } }).catch(() => {});
}

export async function withLock(name, ttlMs, fn) {
  if (!(await acquire(name, ttlMs))) throw new LockBusyError(name);
  try {
    return await fn();
  } finally {
    await release(name);
  }
}
