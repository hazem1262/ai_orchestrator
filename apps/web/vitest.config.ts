import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { name: 'web', environment: 'jsdom', include: ['src/**/*.test.tsx', 'src/**/*.test.ts'] },
});
