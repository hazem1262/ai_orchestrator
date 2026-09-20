import { serve } from '@hono/node-server';
import { CORE_VERSION } from '@orc/core';
import { Hono } from 'hono';
import { ensureToken, resolvePaths } from './config.ts';
import { buildContext } from './context.ts';
import { createApp } from './http/app.ts';
import { warnIfChildSessionEnv } from './pty/pty-manager.ts';

const startedAt = Date.now();

export function createHealthApp(): Hono {
  const app = new Hono();
  app.get('/api/health', (c) =>
    c.json({ ok: true, version: CORE_VERSION, uptimeS: Math.round((Date.now() - startedAt) / 1000) }),
  );
  return app;
}

/**
 * Real boot: builds the daemon context and serves the full token-guarded API (Task 12 owns this
 * wiring; the Phase-0 `createHealthApp` above stays as a standalone export for `main.test.ts`).
 * Task 13 replaces this block with `createDaemon`/`start` (indexer scan+watch, PTY WebSocket,
 * graceful shutdown) — this is deliberately just enough to serve `createApp` on its own.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  warnIfChildSessionEnv();
  const paths = resolvePaths();
  const token = ensureToken(paths);
  const port = Number(process.env.ORC_PORT ?? 4317);
  const { ctx } = buildContext({ paths });
  const app = createApp({ ctx, token, port: () => port });
  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  console.log(`orchestrator daemon on http://127.0.0.1:${port}`);
}
