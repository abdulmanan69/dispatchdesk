import { prisma } from '../db.js';
import { notify } from '../lib/activity.js';
import { withLock, LockBusyError } from '../lib/locks.js';
import { prunePings } from '../services/fleet/track.js';
import { runBackup } from '../services/backup.js';

/**
 * Maintenance jobs ("cron") that keep the database small and the app fast.
 * - Each job has a schedule: every N minutes, or once a day at a UTC hour (heavy work runs at night, US time).
 * - Last run, duration, result and error are stored in SystemSetting under `job.<name>`, so a restart does not re-run
 *   everything and admins can see the status.
 * - Each run holds a database lock, so even several app processes or containers never run the same job twice.
 * - Deletes are batched to keep write locks short.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BATCH = 500;

/** Delete matching rows in small batches (short write transactions). Returns the number deleted. */
async function deleteInBatches(model, where, max = 50_000) {
  let total = 0;
  while (total < max) {
    const rows = await prisma[model].findMany({ where, select: { id: true }, take: BATCH });
    if (!rows.length) break;
    const res = await prisma[model].deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    total += res.count;
    if (rows.length < BATCH) break;
  }
  return total;
}

async function documentExpiry(now) {
  const soon = new Date(now.getTime() + 31 * DAY);
  const docs = await prisma.document.findMany({
    where: { expiresAt: { not: null, lte: soon, gte: new Date(now.getTime() - 2 * DAY) } },
    select: { id: true, ownerId: true, type: true, originalName: true, expiresAt: true, carrierId: true, carrier: { select: { companyName: true } } },
    take: 5000,
  });
  let sent = 0;
  for (const d of docs) {
    const days = Math.ceil((d.expiresAt.getTime() - now.getTime()) / DAY);
    const stage = days <= 0 ? 'expired' : days <= 1 ? '1' : days <= 7 ? '7' : days <= 30 ? '30' : null;
    if (!stage) continue;
    const type = `document_expiring_${stage}`;
    const link = d.carrierId ? `/app/carriers/${d.carrierId}?doc=${d.id}` : `/app/loads?doc=${d.id}`;
    const already = await prisma.notification.findFirst({ where: { userId: d.ownerId, type, link }, select: { id: true } });
    if (already) continue;
    const what = `${d.type.replace(/_/g, ' ').toUpperCase()}${d.carrier ? ` for ${d.carrier.companyName}` : ''}`;
    await notify(d.ownerId, {
      type,
      title: stage === 'expired' ? `${what} has expired` : `${what} expires in ${stage === '1' ? '1 day' : `${stage} days`}`,
      body: `${d.originalName} · expires ${d.expiresAt.toISOString().slice(0, 10)}. Ask the carrier for an updated copy.`,
      link,
    });
    sent++;
  }
  return { checked: docs.length, notified: sent };
}

export const JOBS = [
  {
    name: 'expired-sessions', label: 'Remove expired sign-in sessions', everyMs: 6 * HOUR,
    run: async (now) => ({ deleted: await deleteInBatches('session', { expiresAt: { lt: now } }) }),
  },
  {
    name: 'expired-tokens', label: 'Remove used or expired email/password tokens and old invitations', everyMs: 6 * HOUR,
    run: async (now) => ({
      authTokens: await deleteInBatches('authToken', { OR: [{ expiresAt: { lt: new Date(now.getTime() - DAY) } }, { usedAt: { lt: new Date(now.getTime() - 7 * DAY) } }] }),
      invitations: (await prisma.invitation.updateMany({ where: { status: 'pending', expiresAt: { lt: now } }, data: { status: 'expired' } })).count,
    }),
  },
  {
    name: 'gps-pings', label: 'Delete GPS points older than 30 days and expire old location links', everyMs: HOUR,
    run: async (now) => { const r = await prunePings(now); return typeof r === 'object' && r ? r : { deleted: r ?? 0 }; },
  },
  {
    name: 'document-expiry', label: 'Remind about documents expiring in 30, 7 and 1 days', dailyAtUtc: 13, // 8 AM Central
    run: documentExpiry,
  },
  {
    name: 'notifications', label: 'Delete read notifications after 90 days and unread after a year', dailyAtUtc: 8,
    run: async (now) => ({
      read: await deleteInBatches('notification', { readAt: { lt: new Date(now.getTime() - 90 * DAY) } }),
      unread: await deleteInBatches('notification', { readAt: null, createdAt: { lt: new Date(now.getTime() - 365 * DAY) } }),
    }),
  },
  {
    name: 'old-records', label: 'Trim old lead-generator runs and dial attempts', dailyAtUtc: 8,
    run: async (now) => ({
      leadGenRuns: await deleteInBatches('leadGenRun', { createdAt: { lt: new Date(now.getTime() - 180 * DAY) } }),
      callAttempts: await deleteInBatches('callAttempt', { createdAt: { lt: new Date(now.getTime() - 180 * DAY) } }),
    }),
  },
  {
    name: 'audit-retention', label: `Delete audit log entries older than ${Number(process.env.AUDIT_RETENTION_DAYS || 365)} days`, dailyAtUtc: 8,
    run: async (now) => ({ deleted: await deleteInBatches('auditLog', { createdAt: { lt: new Date(now.getTime() - Number(process.env.AUDIT_RETENTION_DAYS || 365) * DAY) } }) }),
  },
  {
    name: 'database-backup', label: 'Daily database backup (keeps the newest 7)', dailyAtUtc: 9, // 3-4 AM Central
    run: async (now) => {
      if (process.env.BACKUP_DISABLED === 'true') return { skipped: 'BACKUP_DISABLED' };
      const b = await runBackup({ now });
      return b ? { created: b.name, sizeBytes: b.size } : { skipped: 'already backed up today' };
    },
  },
  {
    name: 'database-optimize', label: 'SQLite optimize and WAL checkpoint', dailyAtUtc: 10,
    run: async () => {
      await prisma.$queryRawUnsafe('PRAGMA optimize');
      const rows = await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
      return { checkpoint: rows?.[0] ?? null };
    },
  },
];

const stateKey = (name) => `job.${name}`;

async function readState(name) {
  const row = await prisma.systemSetting.findUnique({ where: { key: stateKey(name) } });
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}

async function writeState(name, state) {
  // PRAGMA results come back as BigInt; store them as numbers.
  const value = JSON.stringify(state, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
  await prisma.systemSetting.upsert({ where: { key: stateKey(name) }, create: { key: stateKey(name), value, secret: false }, update: { value } });
}

/** True when the job should run at `now`, given when it last started. */
export function isDue(job, lastRunAt, now) {
  const last = lastRunAt ? new Date(lastRunAt).getTime() : 0;
  if (job.everyMs) return now.getTime() - last >= job.everyMs;
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), job.dailyAtUtc, 0, 0));
  if (now < slot) slot.setUTCDate(slot.getUTCDate() - 1); // today's slot not reached yet: compare with yesterday's
  return last < slot.getTime();
}

export async function runJob(job, now = new Date()) {
  const started = Date.now();
  try {
    return await withLock(stateKey(job.name), 2 * HOUR, async () => {
      const prev = await readState(job.name);
      try {
        // Normalize (PRAGMA rows contain BigInt, which JSON cannot carry).
        const result = JSON.parse(JSON.stringify((await job.run(now)) ?? null, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
        await writeState(job.name, { ...prev, lastRunAt: now.toISOString(), lastOk: true, lastError: null, durationMs: Date.now() - started, result });
        return { ok: true, result };
      } catch (err) {
        await writeState(job.name, { ...prev, lastRunAt: now.toISOString(), lastOk: false, lastError: String(err.message || err).slice(0, 500), durationMs: Date.now() - started });
        return { ok: false, error: err.message };
      }
    });
  } catch (err) {
    if (err instanceof LockBusyError) return { ok: false, skipped: 'already running' };
    throw err;
  }
}

/** Called from every scheduler tick: runs at most a few due jobs so a tick never takes long. */
export async function runMaintenance(now = new Date(), log = () => {}, { maxJobs = 3 } = {}) {
  const ran = [];
  for (const job of JOBS) {
    if (ran.length >= maxJobs) break;
    const state = await readState(job.name);
    if (!isDue(job, state.lastRunAt, now)) continue;
    const r = await runJob(job, now);
    if (!r.ok && r.error) log('job', job.name, r.error);
    ran.push(job.name);
  }
  return ran;
}

export async function jobStatuses() {
  const now = new Date();
  const out = [];
  for (const job of JOBS) {
    const s = await readState(job.name);
    out.push({
      name: job.name, label: job.label,
      schedule: job.everyMs ? `every ${job.everyMs >= HOUR ? `${job.everyMs / HOUR} h` : `${job.everyMs / MIN} min`}` : `daily at ${String(job.dailyAtUtc).padStart(2, '0')}:00 UTC`,
      lastRunAt: s.lastRunAt || null, lastOk: s.lastOk ?? null, lastError: s.lastError || null, durationMs: s.durationMs ?? null, result: s.result ?? null,
      due: isDue(job, s.lastRunAt, now),
    });
  }
  return out;
}
