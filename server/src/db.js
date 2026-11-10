import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { config } from './config.js';

const adapter = new PrismaBetterSqlite3({ url: config.databaseUrl });
export const prisma = new PrismaClient({ adapter });

/**
 * SQLite tuning for many concurrent users:
 * - WAL lets readers run while a write is in progress (default journal blocks everyone during writes).
 * - busy_timeout waits for a lock instead of failing with "database is locked".
 * - synchronous=NORMAL is safe with WAL and much faster than FULL.
 */
export async function tuneDatabase() {
  for (const sql of ['PRAGMA journal_mode = WAL', 'PRAGMA busy_timeout = 5000', 'PRAGMA synchronous = NORMAL', 'PRAGMA foreign_keys = ON']) {
    await prisma.$queryRawUnsafe(sql).catch((err) => console.warn(`[db] ${sql} failed: ${err.message}`));
  }
}
