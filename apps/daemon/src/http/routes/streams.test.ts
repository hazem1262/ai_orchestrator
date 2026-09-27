import type { StreamDetail, WorkStream } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { createP3Harness } from '../../../test/p3-harness.ts';
import { bareApp, makeP5Context, withWakecap } from '../../../test/p5-helpers.ts';
import type { StreamService } from '../../services/streams/streams.ts';
import { NON_ACTION_ROUTES } from '../audit-middleware.ts';
import { registerStreamRoutes } from './streams.ts';

const stream: WorkStream = {
  ticket: 'SAF-1',
  projectId: 'wakecap',
  title: 't',
  stage: 'pr_open',
  sessionIds: [],
  prs: [],
  plans: [],
  worktrees: [],
  costUsd: 1,
  lastActivityAt: '2026-09-01T00:00:00.000Z',
};

function setup() {
  const calls: string[] = [];
  const svc: StreamService = {
    refresh: async () => {
      calls.push('refresh');
      return [stream];
    },
    refreshIfStale: async () => void calls.push('stale'),
    list: (q) => {
      calls.push(`list:${q.stage ?? ''}`);
      return [stream];
    },
    get: async (t) =>
      t === 'SAF-1'
        ? ({
            stream,
            prsDetailed: [],
            links: [],
            timeline: [],
            goal: null,
            handoff: null,
            budget: { ok: true, pct: 0, limitUsd: null },
          } satisfies StreamDetail)
        : null,
    link: (ticket, kind, ref) => ({ ticket, kind, ref, origin: 'manual', excluded: false, createdAt: 'x' }),
    unlink: (ticket, kind, ref) => ({ ticket, kind, ref, origin: 'manual', excluded: true, createdAt: 'x' }),
    start: () => undefined,
    stop: () => undefined,
  };
  const { ctx } = makeP5Context({ config: withWakecap('/Users/test/Wakecap') });
  ctx.streams = svc;
  const app = bareApp();
  registerStreamRoutes(app, ctx);
  return { app, calls };
}

describe('/api/streams', () => {
  it('lists with filters after a stale check', async () => {
    const { app, calls } = setup();
    const res = await app.request('/api/streams?stage=pr_open');
    expect(await res.json()).toEqual([stream]);
    expect(calls).toEqual(['stale', 'list:pr_open']);
    expect((await app.request('/api/streams?stage=bogus')).status).toBe(400);
  });

  it('gets one stream or 404s', async () => {
    const { app } = setup();
    expect(((await (await app.request('/api/streams/SAF-1')).json()) as StreamDetail).stream.ticket).toBe(
      'SAF-1',
    );
    expect((await app.request('/api/streams/SAF-2')).status).toBe(404);
  });

  it('links, unlinks and refreshes', async () => {
    const { app } = setup();
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect(
      await (await post('/api/streams/SAF-1/link', { kind: 'session', ref: 'claude:x' })).json(),
    ).toMatchObject({ excluded: false });
    expect(await (await post('/api/streams/SAF-1/unlink', { kind: 'pr', ref: 'u' })).json()).toMatchObject({
      excluded: true,
    });
    expect((await post('/api/streams/SAF-1/link', { kind: 'bogus', ref: 'x' })).status).toBe(400);
    expect(await (await post('/api/streams/refresh', {})).json()).toEqual([stream]);
  });
});

describe('/api/streams in the real app', () => {
  const WRITES = [
    ['POST', '/api/streams/refresh'],
    ['POST', '/api/streams/:ticket/link'],
    ['POST', '/api/streams/:ticket/unlink'],
  ] as const;

  it('are registered by registerAllRoutes and every write route is audit-exempt', async () => {
    const t = await createP3Harness();
    try {
      const registered = new Set(t.app.routes.map((r) => `${r.method} ${r.path}`));
      for (const r of [
        'GET /api/streams',
        'GET /api/streams/:ticket',
        ...WRITES.map(([m, p]) => `${m} ${p}`),
      ]) {
        expect(registered).toContain(r);
      }
      for (const [method, path] of WRITES) {
        expect(NON_ACTION_ROUTES.some((n) => n.method === method && n.path === path)).toBe(true);
      }
    } finally {
      await t.cleanup();
    }
  });
});
