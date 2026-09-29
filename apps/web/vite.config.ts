import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const daemon = 'http://127.0.0.1:4317';

/** highlight.js grammars the review diff registers (ts/tsx, js/jsx, html, sh, md, py, rs, ...). */
const DIFF_LANGUAGES = [
  'typescript',
  'javascript',
  'json',
  'css',
  'xml',
  'markdown',
  'yaml',
  'bash',
  'python',
  'go',
  'rust',
  'sql',
  'diff',
];

/**
 * @git-diff-view/lowlight builds its highlighter with `createLowlight(all)`, which bundles every
 * highlight.js grammar (~1.5 MB). This swaps its `lowlight` import for a module whose `all` holds
 * only DIFF_LANGUAGES; other files fall back to lowlight's auto-detection over that set.
 */
function diffViewLanguages(): Plugin {
  const id = '\0orc:diff-view-lowlight';
  let code = '';
  return {
    name: 'orc-diff-view-languages',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (source !== 'lowlight' || !importer?.includes('@git-diff-view/lowlight')) return null;
      const lowlight = await this.resolve('lowlight', importer, { skipSelf: true });
      if (!lowlight) return null;
      const grammars = await Promise.all(
        DIFF_LANGUAGES.map(async (lang) => {
          const r = await this.resolve(`highlight.js/lib/languages/${lang}`, lowlight.id, { skipSelf: true });
          if (!r) throw new Error(`diff-view-languages: cannot resolve highlight.js grammar ${lang}`);
          return r.id;
        }),
      );
      code = [
        `import { createLowlight } from ${JSON.stringify(lowlight.id)};`,
        ...grammars.map((g, i) => `import g${i} from ${JSON.stringify(g)};`),
        `export const all = { ${DIFF_LANGUAGES.map((l, i) => `${JSON.stringify(l)}: g${i}`).join(', ')} };`,
        'export const common = all;',
        'export { createLowlight };',
      ].join('\n');
      return id;
    },
    load(loadId) {
      return loadId === id ? code : null;
    },
  };
}

export default defineConfig({
  plugins: [
    diffViewLanguages(),
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        name: 'Orchestrator',
        short_name: 'Orchestrator',
        description: 'Local-first command centre for AI coding agents',
        start_url: '/inbox',
        scope: '/',
        display: 'standalone',
        // The light Calm --background (src/index.css); index.html sets the dark one per color scheme.
        background_color: '#fdfdfd',
        theme_color: '#fdfdfd',
        icons: [
          { src: '/icons/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      injectManifest: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'] },
      devOptions: { enabled: false },
    }),
  ],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      '/api': daemon,
      '/bootstrap.js': daemon,
      '/ws': { target: 'ws://127.0.0.1:4317', ws: true },
      '/pty': { target: 'ws://127.0.0.1:4317', ws: true },
    },
  },
});
