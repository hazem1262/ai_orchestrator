import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const port = 4399;
// One temp root per run, created by the runner process: workers inherit its env (so they reuse the
// same root instead of creating their own) and the e2e daemon is started on it, so concurrent runs
// never share, or tear down, each other's homes.
process.env.ORC_E2E_ROOT ??= realpathSync(mkdtempSync(join(tmpdir(), 'orc-e2e-')));
process.env.ORC_E2E_WORK ??= join(process.env.ORC_E2E_ROOT, 'work', 'Wakecap');

export default defineConfig({
  testDir: './e2e',
  // Runs under playwright.m4.config.ts (`pnpm e2e:m4`), which seeds its own daemon.
  testIgnore: /m4-.*\.spec\.ts/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // builds the web app (served by the daemon), then boots the daemon on a temp copy of fixtures/
    command: 'pnpm build && pnpm --filter @orc/daemon exec tsx test/e2e-server.ts',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    // SIGTERM (not the default SIGKILL) so the e2e server closes the daemon and removes its temp root.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    env: {
      ORC_E2E_PORT: String(port),
      ORC_E2E_ROOT: process.env.ORC_E2E_ROOT,
      ORC_E2E_WORK: process.env.ORC_E2E_WORK,
    },
  },
});
