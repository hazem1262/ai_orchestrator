import { defineConfig, devices } from '@playwright/test';

const port = 4399;

export default defineConfig({
  testDir: './e2e',
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
    env: { ORC_E2E_PORT: String(port) },
  },
});
