import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/globalSetup.js'],
    setupFiles: ['./tests/env.js'],
    fileParallelism: false, // one SQLite file shared by all suites
    testTimeout: 30000,
    hookTimeout: 60000,
    include: ['tests/**/*.test.js'],
  },
});
