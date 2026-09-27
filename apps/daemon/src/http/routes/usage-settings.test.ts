import { describe, expect, it } from 'vitest';
import { createP3Harness } from '../../../test/p3-harness.ts';
import { bareApp, ev, makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import { createUsageLedger } from '../../services/usage/ledger.ts';
import { createUsageMeter } from '../../services/usage/meter.ts';
import { NON_ACTION_ROUTES } from '../audit-middleware.ts';
import { registerSettingsRoutes } from './settings.ts';
import { registerUsageRoutes } from './usage.ts';

function setup() {
  const s1 = makeSession({ id: 's1' });
  const events = {
    'claude:s1': [
      ev({
        seq: 1,
        ts: new Date().toISOString(),
        kind: 'assistant_text',
        messageId: 'm1',
        model: 'claude-opus-5',
        usage: { input: 10, output: 5, cacheRead: 1000, cacheWrite: 0, costUsd: null },
      }),
    ],
  };
  const t = makeP5Context({ config: withWakecap('/Users/test/Wakecap'), data: { sessions: [s1], events } });
  const ledger = createUsageLedger(t.ctx);
  t.ctx.ledger = ledger;
  t.ctx.usage = createUsageMeter(t.ctx, { ledger, inbox: null });
  const app = bareApp();
  registerUsageRoutes(app, t.ctx);
  registerSettingsRoutes(app, t.ctx);
  const json = (method: string, body?: unknown) => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ...t, app, ledger, json };
}

describe('/api/usage', () => {
  it('returns a snapshot, context fill and concurrency', async () => {
    const { app, ledger } = setup();
    await ledger.syncSession('claude:s1');
    const snap = await (await app.request('/api/usage')).json();
    expect(snap).toMatchObject({ source: 'estimate', block: { tokens: 15 } });
    const fill = await (await app.request('/api/usage/context/claude/s1')).json();
    expect(fill).toMatchObject({ sessionPk: 'claude:s1', usedTokens: 1010, windowTokens: 1_000_000 });
    expect(await (await app.request('/api/usage/context/claude/zz')).json()).toBeNull();
    expect(await (await app.request('/api/usage/concurrency')).json()).toEqual([
      { projectId: 'wakecap', owned: 0, max: 6 },
    ]);
  });

  it('creates, lists and deletes budgets with validation', async () => {
    const { app, json } = setup();
    const bad = await app.request(
      '/api/usage/budgets',
      json('PUT', { scopeType: 'ticket', period: 'daily', limitUsd: 5 }),
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'validation_failed' } });
    const res = await app.request(
      '/api/usage/budgets',
      json('PUT', { scopeType: 'ticket', scopeId: 'SAF-1', period: 'daily', limitUsd: 5 }),
    );
    expect(res.status).toBe(200);
    const b = (await res.json()) as { id: string };
    const list = (await (await app.request('/api/usage/budgets')).json()) as Array<{
      budget: { id: string };
    }>;
    expect(list.map((s) => s.budget.id)).toContain(b.id);
    expect((await app.request(`/api/usage/budgets/${b.id}`, json('DELETE'))).status).toBe(200);
    const gone = await app.request(`/api/usage/budgets/${b.id}`, json('DELETE'));
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error: { code: 'not_found' } });
    const cfgBudget = await app.request('/api/usage/budgets/config:wakecap:daily', json('DELETE'));
    expect(cfgBudget.status).toBe(409);
    expect(await cfgBudget.json()).toMatchObject({ error: { code: 'config_budget' } });
  });

  it('accepts official samples with 204', async () => {
    const { app } = setup();
    expect((await app.request('/api/usage/official', { method: 'POST', body: '{"x":1}' })).status).toBe(204);
  });
});

describe('/api/settings', () => {
  it('reads and replaces whole sections, emitting config.changed', async () => {
    const { app, ctx, json } = setup();
    let changed = 0;
    ctx.bus.on('config.changed', () => {
      changed++;
    });
    const before = (await (await app.request('/api/settings')).json()) as { recaps: Record<string, unknown> };
    expect(before.recaps.engine).toBe('claude-cli');
    const res = await app.request(
      '/api/settings',
      json('PUT', { recaps: { ...before.recaps, enabled: true, language: 'ar' } }),
    );
    expect(res.status).toBe(200);
    expect(ctx.config().recaps).toMatchObject({ enabled: true, language: 'ar', monthlyBudgetUsd: 20 });
    expect(ctx.config().limits.warnPct).toBe(0.8);
    expect(changed).toBe(1);
    const bad = await app.request('/api/settings', json('PUT', { limits: { warnPct: 3 } }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'validation_failed' } });
  });
});

describe('usage and settings routes in the real app', () => {
  const WRITES = [
    ['PUT', '/api/usage/budgets'],
    ['DELETE', '/api/usage/budgets/:id'],
    ['POST', '/api/usage/official'],
    ['PUT', '/api/settings'],
  ] as const;

  it('are registered by registerAllRoutes and every write route is audit-exempt', async () => {
    const t = await createP3Harness();
    try {
      const registered = new Set(t.app.routes.map((r) => `${r.method} ${r.path}`));
      for (const r of [
        'GET /api/usage',
        'GET /api/usage/budgets',
        'GET /api/usage/concurrency',
        'GET /api/usage/context/:source/:id',
        'GET /api/settings',
        ...WRITES.map(([m, p]) => `${m} ${p}`),
      ]) {
        expect(registered).toContain(r);
      }
      for (const [method, path] of WRITES) {
        expect(NON_ACTION_ROUTES.some((n) => n.method === method && n.path === path)).toBe(true);
      }
      const snap = await t.request('/api/usage');
      expect(snap.status).toBe(200);
      expect(await snap.json()).toMatchObject({ source: expect.any(String), block: expect.any(Object) });
      const settings = await t.request('/api/settings');
      expect(settings.status).toBe(200);
      expect(await settings.json()).toHaveProperty('limits.warnPct', 0.8);
    } finally {
      await t.cleanup();
    }
  });
});
