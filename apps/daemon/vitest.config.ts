import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'daemon', environment: 'node', include: ['src/**/*.test.ts', 'test/**/*.test.ts'] },
});
