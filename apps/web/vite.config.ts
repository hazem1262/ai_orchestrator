import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const daemon = 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [
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
