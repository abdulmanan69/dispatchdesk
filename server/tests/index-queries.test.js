import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { registerUser, prisma } from './helpers.js';

// Plans are checked on a copy of the test database without planner statistics: the statistics other suites leave
// behind (ANALYZE on a few hundred look-alike test rows, e.g. every user in one time zone) say nothing about
// production data. Without them SQLite picks by the query shape, which is what these tests are about.
let db = null;
let copy = null;
const open = (file) => new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
beforeAll(async () => {
  copy = path.join(process.env.DATA_DIR || path.resolve('./data/test'), `plans-${process.pid}-${Date.now()}.db`);
  await prisma.$executeRawUnsafe(`VACUUM INTO '${copy.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  const raw = open(copy);
  for (const t of ['sqlite_stat1', 'sqlite_stat4']) {
    const [hit] = await raw.$queryRawUnsafe('SELECT COUNT(*) AS "n" FROM sqlite_master WHERE name = ?', t);
    if (Number(hit.n)) await raw.$executeRawUnsafe(`DELETE FROM ${t}`);
  }
  await raw.$disconnect();
  db = open(copy); // a new connection loads the (now empty) statistics
});
afterAll(async () => {
  await db?.$disconnect();
  try { if (copy) fs.rmSync(copy, { force: true }); } catch { /* locked on Windows: the run directory is removed later */ }
});

/** SQLite's plan for a statement, as one string ("SEARCH Broker USING INDEX ..."). */
async function plan(sql, ...args) {
  const rows = await db.$queryRawUnsafe(`EXPLAIN QUERY PLAN ${sql}`, ...args);
  return rows.map((r) => r.detail).join(' | ');
}

describe('query shapes use the wave 2 indexes', () => {
  it('reply and bounce matching by sender email', async () => {
    expect(await plan('SELECT "id" FROM "Carrier" WHERE "ownerId" = ? AND "email" = ? ORDER BY "updatedAt" DESC LIMIT 1', 'u', 'a@b.c')).toContain('Carrier_ownerId_email_idx');
    // Prisma joins the carrier for `carrier: { ownerId }`; the contact side is found by email.
    expect(await plan('SELECT c."id" FROM "CarrierContact" c LEFT JOIN "Carrier" j0 ON j0."id" = c."carrierId" WHERE c."email" = ? AND j0."ownerId" = ? AND j0."id" IS NOT NULL LIMIT 1', 'a@b.c', 'u'))
      .toContain('CarrierContact_email_idx');
  });

  it('watchlist walk, mailbox polling, digest time zones, replied emails and load references', async () => {
    expect(await plan('SELECT "id" FROM "Broker" WHERE "watch" = 1 AND "id" > ? ORDER BY "id" ASC LIMIT 1000', '')).toContain('Broker_watch_id_idx');
    expect(await plan('SELECT "id" FROM "EmailAccount" WHERE "imapEnabled" = 1 AND "status" = ? ORDER BY "imapCheckedAt" ASC LIMIT 20', 'connected')).toContain('EmailAccount_imapEnabled_status_idx');
    expect(await plan('SELECT "id" FROM "User" WHERE "timezone" = ? AND "notifyDigest" = 1 AND "status" = ? AND "id" > ? ORDER BY "id" LIMIT 200', 'America/Chicago', 'active', '')).toContain('User_timezone_idx');
    expect(await plan('SELECT "id" FROM "Email" WHERE "userId" = ? AND "repliedAt" IS NOT NULL ORDER BY "repliedAt" DESC LIMIT 50', 'u')).toContain('Email_userId_repliedAt_idx');
    expect(await plan('SELECT "id" FROM "Load" WHERE "ownerId" = ? AND "referenceNumber" = ?', 'u', 'R1')).toContain('Load_ownerId_referenceNumber_idx');
  });

  it('broker lookup by MC is index-driven and stays inside the workspace', async () => {
    expect(await plan('SELECT "id" FROM "Broker" WHERE "ownerId" = ? AND "mcNumber" = ?', 'u', '123')).toContain('Broker_ownerId_mcNumber_idx');
    const A = await registerUser();
    const B = await registerUser();
    for (const name of ['Zeta Freight', 'Alpha Freight']) expect((await A.agent.post('/api/brokers').send({ companyName: name, mcNumber: 'MC-445566' })).status).toBe(201);
    await A.agent.post('/api/brokers').send({ companyName: 'Other MC', mcNumber: '445567' });
    await B.agent.post('/api/brokers').send({ companyName: 'Not yours', mcNumber: '445566' });
    const res = await A.agent.get('/api/brokers?mc=445566');
    expect(res.status).toBe(200);
    expect(res.body.items.map((b) => b.companyName)).toEqual(['Alpha Freight', 'Zeta Freight']);
    expect(res.body.total).toBe(2);
    expect((await A.agent.get('/api/brokers?mc=999999')).body).toMatchObject({ items: [], total: 0 });
    expect((await B.agent.get('/api/brokers?mc=445566')).body.items.map((b) => b.companyName)).toEqual(['Not yours']);
  });
});
