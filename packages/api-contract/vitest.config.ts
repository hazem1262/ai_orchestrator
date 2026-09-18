import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'api-contract', environment: 'node', include: ['src/**/*.test.ts'] },
});
