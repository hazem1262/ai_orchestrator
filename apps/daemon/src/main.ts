import { serve } from '@hono/node-server';
import { CORE_VERSION } from '@orc/core';
import { Hono } from 'hono';
import { warnIfChildSessionEnv } from './pty/pty-manager.ts';

const startedAt = Date.now();

export function createHealthApp(): Hono {
  const app = new Hono();
  app.get('/api/health', (c) =>
    c.json({ ok: true, version: CORE_VERSION, uptimeS: Math.round((Date.now() - startedAt) / 1000) }),
  );
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  warnIfChildSessionEnv();
  const port = Number(process.env.ORC_PORT ?? 4317);
  serve({ fetch: createHealthApp().fetch, port, hostname: '127.0.0.1' });
  console.log(`orchestrator daemon on http://127.0.0.1:${port}`);
}
