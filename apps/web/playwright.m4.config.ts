import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /m4-.*\.spec\.ts/,
  timeout: 120_000,
  workers: 1,
  globalSetup: './e2e/support/m4-seed.ts',
  globalTeardown: './e2e/support/m4-teardown.ts',
  use: { baseURL: 'http://127.0.0.1:4418', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
