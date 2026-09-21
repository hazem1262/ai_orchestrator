import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'daemon',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // node-pty and better-sqlite3 are native addons: run test files in child processes.
    pool: 'forks',
    testTimeout: 20_000,
  },
});
