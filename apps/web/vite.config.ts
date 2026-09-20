import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const daemon = 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
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
