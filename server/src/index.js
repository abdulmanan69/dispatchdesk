import cluster from 'node:cluster';
import { createApp } from './app.js';
import { config } from './config.js';
import { prisma, tuneDatabase } from './db.js';
import { bootstrap } from './bootstrap.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

async function main() {
  await tuneDatabase(); // per-connection pragmas (busy_timeout) must run in every process
  // In cluster mode the primary already ran bootstrap once; running it in every worker would race on upserts.
  if (process.env.DD_SKIP_BOOTSTRAP !== '1') await bootstrap();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[server] ${cluster.isWorker ? `worker ${cluster.worker.id} ` : ''}listening on :${config.port} (${config.env}) — ${config.appUrl}`);
  });
  // One scheduler per deployment: in cluster mode only the worker started with DD_RUN_SCHEDULER=1 runs it.
  const schedulerHere = !cluster.isWorker || process.env.DD_RUN_SCHEDULER === '1';
  if (!config.disableScheduler && schedulerHere) startScheduler();

  const shutdown = async (signal) => {
    console.log(`[server] ${signal} received, shutting down`);
    stopScheduler();
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
