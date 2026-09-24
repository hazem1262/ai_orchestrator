import { createApp } from '../src/http/app.ts';
import type { OrcApp } from '../src/http/types.ts';
import { createTestContext, indexFixtures, type TestContext } from './helpers.ts';

export const P3_TOKEN = 'b'.repeat(64);
export const P3_BASE = 'http://127.0.0.1:4317';

export interface P3Harness {
  ctx: TestContext;
  app: OrcApp;
  request(
    path: string,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<Response>;
  cleanup(): Promise<void>;
}

/** Real services on indexed fixture homes plus the real Hono app (token, host checks, audit middleware). */
export async function createP3Harness(
  opts: Parameters<typeof createTestContext>[0] = {},
): Promise<P3Harness> {
  const ctx = createTestContext(opts);
  const indexer = await indexFixtures(ctx);
  const app = createApp({ ctx, token: P3_TOKEN, port: () => 4317, env: {} });
  return {
    ctx,
    app,
    async request(path, init = {}) {
      const headers: Record<string, string> = { 'x-orc-token': P3_TOKEN, ...(init.headers ?? {}) };
      if (init.body !== undefined) headers['content-type'] = 'application/json';
      return app.request(`${P3_BASE}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    },
    async cleanup() {
      for (const p of ctx.pty.list()) if (p.exitedAt === null) ctx.pty.kill(p.id);
      await indexer.close();
      ctx.dispose();
    },
  };
}
