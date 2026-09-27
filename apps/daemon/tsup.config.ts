import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts', 'orc-statusline': 'src/bin/orc-statusline.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  // Workspace packages are compiled in; native and runtime deps stay external and ship in node_modules.
  noExternal: [/^@orc\//],
  sourcemap: true,
  clean: true,
});
