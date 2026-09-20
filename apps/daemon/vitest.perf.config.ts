import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/perf/**/*.perf.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 180_000,
  },
});
