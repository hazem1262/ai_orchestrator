import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  noExternal: [/^@orc\//],
  banner: { js: '#!/usr/bin/env node' },
});
