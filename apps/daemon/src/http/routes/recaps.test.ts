import type { Recap } from '@orc/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createP3Harness } from '../../../test/p3-harness.ts';
import { bareApp, makeP5Context, withWakecap } from '../../../test/p5-helpers.ts';
import { ServiceError } from '../../services/errors.ts';
import type { RecapService } from '../../services/recap/recap.ts';
import { NON_ACTION_ROUTES } from '../audit-middleware.ts';
import { registerRecapRoutes } from './recaps.ts';

// Safety: the route tests use a fake RecapService (no engine at all), and the real-app block only
// inspects the registered route table — it sends no request that could reach an engine.
// ANTHROPIC_API_KEY is removed from the process for the whole file.
let savedKey: string | undefined;
beforeAll(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});
afterAll(() => {
  if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
});

const rec: Recap = {
  id: 'r',
  kind: 'session',
  targetKey: 'claude:s1',
  transcriptOffset: 1,
  model: 'm',
  engine: 'claude-cli',
  text: 't',
  costUsd: 0.1,
  inputTokensApprox: 10,
  createdAt: 'x',
};

// A GitHub token shape that core `redact` masks; recap text is model output over a transcript
// digest, so it leaves the daemon through redactedJson like every other transcript-derived body.
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

function setup() {
  const calls: unknown[] = [];
  const svc = {
    recap: async (pk: string, o?: { onDemand?: boolean }) => {
      calls.push([pk, o]);
      if (pk === 'claude:over') throw new ServiceError('over_budget', 409, 'budget');
      if (pk === 'claude:leak') return { text: `use ${SECRET}`, costUsd: 0.1, model: 'm', cached: false };
      return { text: 't', costUsd: 0.1, model: 'm', cached: false };
    },
    daily: async (p: string, d: string) => (p === 'leak' ? `daily ${SECRET}` : `daily ${p} ${d}`),
    latest: (pk: string) =>
      pk === 'claude:s1' ? rec : pk === 'claude:leak' ? { ...rec, text: `use ${SECRET}` } : null,
    latestDaily: () => null,
    monthSpend: () => ({ spentUsd: 1, budgetUsd: 20 }),
  } as unknown as RecapService;
  const { ctx } = makeP5Context({ config: withWakecap('/Users/test/Wakecap') });
  ctx.recaps = svc;
  const app = bareApp();
  registerRecapRoutes(app, ctx);
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { app, post, calls };
}

describe('/api/recaps', () => {
  it('gets and runs session recaps', async () => {
    const { app, post, calls } = setup();
    expect(await (await app.request('/api/recaps/session/claude/s1')).json()).toEqual(rec);
    expect(await (await app.request('/api/recaps/session/claude/zz')).json()).toBeNull();
    expect(await (await post('/api/recaps/session/claude/s1', {})).json()).toMatchObject({ cached: false });
    expect(calls[0]).toEqual(['claude:s1', { onDemand: true }]);
    const over = await post('/api/recaps/session/claude/over', { onDemand: false });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: { code: 'over_budget' } });
    expect((await app.request('/api/recaps/session/bogus/s1')).status).toBe(400);
  });

  it('handles daily recaps and spend', async () => {
    const { app, post } = setup();
    expect(
      await (await post('/api/recaps/daily', { projectId: 'wakecap', date: '2026-09-17' })).json(),
    ).toEqual({
      text: 'daily wakecap 2026-09-17',
    });
    expect((await post('/api/recaps/daily', { projectId: 'wakecap', date: 'today' })).status).toBe(400);
    expect(
      await (await app.request('/api/recaps/daily?projectId=wakecap&date=2026-09-17')).json(),
    ).toBeNull();
    expect(await (await app.request('/api/recaps/spend')).json()).toEqual({ spentUsd: 1, budgetUsd: 20 });
  });

  it('redacts recap text on the way out', async () => {
    const { app, post } = setup();
    const got = await (await app.request('/api/recaps/session/claude/leak')).text();
    expect(got).not.toContain(SECRET);
    const ran = await (await post('/api/recaps/session/claude/leak', {})).text();
    expect(ran).not.toContain(SECRET);
    const daily = await (await post('/api/recaps/daily', { projectId: 'leak', date: '2026-09-17' })).text();
    expect(daily).not.toContain(SECRET);
  });
});

describe('/api/recaps in the real app', () => {
  // Plan Task 13 Step 8: both generating routes are audit-exempt (NON_ACTION_ROUTES) — they send a
  // redacted digest to the configured engine, and every call's cost is recorded in the recaps table.
  const WRITES = [
    ['POST', '/api/recaps/session/:source/:id'],
    ['POST', '/api/recaps/daily'],
  ] as const;

  it('are registered by registerAllRoutes and every write route is audit-exempt', async () => {
    const t = await createP3Harness();
    try {
      const registered = new Set(t.app.routes.map((r) => `${r.method} ${r.path}`));
      for (const r of [
        'GET /api/recaps/session/:source/:id',
        'GET /api/recaps/daily',
        'GET /api/recaps/spend',
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
