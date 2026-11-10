import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { withLock, LockBusyError } from '../lib/locks.js';

/**
 * Daily SQLite backups inside the data volume.
 * `VACUUM INTO` writes a consistent, compacted copy while the app keeps running (WAL readers are not blocked).
 * The newest KEEP copies are kept. Uploaded files are not copied here; they already live in the same volume.
 */
export const BACKUP_DIR = path.join(config.dataDir, 'backups');
const KEEP = Number(process.env.BACKUP_KEEP || 7);
const NAME = /^app-\d{4}-\d{2}-\d{2}(?:-\d{6})?\.db$/;

const day = (d) => d.toISOString().slice(0, 10);

export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => NAME.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, size: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Resolve a backup file name safely (no path traversal). Returns the absolute path or null. */
export function backupPath(name) {
  if (!NAME.test(String(name))) return null;
  const p = path.join(BACKUP_DIR, name);
  return fs.existsSync(p) ? p : null;
}

function prune() {
  const all = listBackups();
  for (const b of all.slice(KEEP)) fs.rmSync(path.join(BACKUP_DIR, b.name), { force: true });
}

/** Make a backup now (manual) or once per day (scheduled). Returns the backup info or null when skipped. */
export async function runBackup({ now = new Date(), force = false } = {}) {
  if (!config.databaseUrl.startsWith('file:')) return null; // only SQLite files are backed up this way
  try {
    return await withLock('backup', 30 * 60_000, () => backupUnlocked(now, force));
  } catch (err) {
    if (err instanceof LockBusyError) return null;
    throw err;
  }
}

async function backupUnlocked(now, force) {
  {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const todays = listBackups().find((b) => b.name.startsWith(`app-${day(now)}`));
    if (todays && !force) return null;
    const stamp = force ? `-${now.toISOString().slice(11, 19).replace(/:/g, '')}` : '';
    const file = path.join(BACKUP_DIR, `app-${day(now)}${stamp}.db`);
    const tmp = `${file}.partial`;
    fs.rmSync(tmp, { force: true });
    // Path is built from our own directory and a date; quotes are escaped for SQL anyway.
    await prisma.$executeRawUnsafe(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    fs.renameSync(tmp, file);
    prune();
    const st = fs.statSync(file);
    return { name: path.basename(file), size: st.size, createdAt: st.mtime.toISOString() };
  }
}
