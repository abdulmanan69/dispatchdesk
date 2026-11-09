import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs/,
  timeout: 120000,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'results-ui.json' }]],
  use: { headless: true, trace: 'retain-on-failure' },
});
