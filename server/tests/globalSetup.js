import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Fresh SQLite database with all migrations applied, once per test run.
 * Each run gets its own directory; workers inherit DD_TEST_DIR from this process.
 */
export default async function setup() {
  const dir = path.resolve(`./data/test-${process.pid}`);
  process.env.DD_TEST_DIR = dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await import('./env.js');
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env } });
  const { bootstrap } = await import('../src/bootstrap.js');
  await bootstrap({ quiet: true });
  const { prisma } = await import('../src/db.js');
  await prisma.$disconnect();
  return () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* file may be locked on Windows */ } };
}
