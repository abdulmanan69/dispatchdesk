import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import { bootstrap } from './bootstrap.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

async function main() {
  await bootstrap();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[server] listening on :${config.port} (${config.env}) — ${config.appUrl}`);
  });
  if (!config.disableScheduler) startScheduler();

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
