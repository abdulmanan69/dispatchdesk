/**
 * Production entrypoint: run the API on every CPU core with Node's cluster module.
 * - The primary migrates nothing (entrypoint.sh already ran `prisma migrate deploy`), tunes SQLite and runs bootstrap once,
 *   then forks workers. Workers share the listening port; the OS spreads connections across them.
 * - Exactly one worker runs the background scheduler (DD_RUN_SCHEDULER=1); if it dies, its replacement takes the role.
 * - Rate-limit counters live in the primary (cluster-memory-store) and cache invalidations are relayed to all workers.
 * - SQLite in WAL mode allows many concurrent readers across processes; writes are serialized with a busy timeout.
 * Set WEB_CONCURRENCY to choose the worker count (default: CPU cores, max 4). WEB_CONCURRENCY=1 runs a single process.
 */
import cluster from 'node:cluster';
import os from 'node:os';

const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const count = Math.max(1, Number(process.env.WEB_CONCURRENCY) || Math.min(cores, 4));

if (!cluster.isPrimary || count === 1) {
  await import('./index.js');
} else {
  const { prisma, tuneDatabase } = await import('./db.js');
  const { bootstrap } = await import('./bootstrap.js');
  const { relayBroadcasts } = await import('./lib/broadcast.js');
  const { ClusterMemoryStorePrimary } = await import('@express-rate-limit/cluster-memory-store');

  try {
    await tuneDatabase();
    await bootstrap();
  } catch (err) {
    console.error('[cluster] startup failed', err);
    process.exit(1);
  }
  await prisma.$disconnect().catch(() => {});

  const limiterStore = new ClusterMemoryStorePrimary();
  limiterStore.init();
  relayBroadcasts();

  let schedulerId = null;
  let stopping = false;
  const recentExits = [];

  const fork = (scheduler) => {
    const w = cluster.fork({ DD_SKIP_BOOTSTRAP: '1', DD_RUN_SCHEDULER: scheduler ? '1' : '0' });
    if (scheduler) schedulerId = w.id;
    return w;
  };

  console.log(`[cluster] starting ${count} workers on ${cores} cores`);
  for (let i = 0; i < count; i++) fork(i === 0);

  cluster.on('exit', (worker, code, signal) => {
    if (stopping) {
      if (Object.keys(cluster.workers || {}).length === 0) process.exit(0);
      return;
    }
    const wasScheduler = worker.id === schedulerId;
    const now = Date.now();
    recentExits.push(now);
    while (recentExits.length && now - recentExits[0] > 60000) recentExits.shift();
    if (recentExits.length > 10) {
      console.error('[cluster] workers are crashing repeatedly; exiting so the container restarts');
      process.exit(1);
    }
    console.error(`[cluster] worker ${worker.process.pid} exited (${signal || code})${wasScheduler ? ' [scheduler]' : ''}; restarting`);
    setTimeout(() => fork(wasScheduler), 1000).unref();
  });

  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[cluster] ${signal} received, stopping workers`);
    for (const w of Object.values(cluster.workers || {})) w?.process.kill('SIGTERM');
    setTimeout(() => process.exit(0), 12000).unref();
    if (Object.keys(cluster.workers || {}).length === 0) process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
