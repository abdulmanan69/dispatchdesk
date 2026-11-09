import { defineConfig } from 'prisma/config';

const url = process.env.DATABASE_URL || 'file:./data/dev.db';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url },
});
