import { describe, expect, it } from 'vitest';
import { bareApp, makeP5Context, withWakecap } from '../../../test/p5-helpers.ts';
import type { AnalyticsService } from '../../services/analytics/analytics.ts';
import type { DigestService } from '../../services/analytics/digest.ts';
import { registerAnalyticsRoutes } from './analytics.ts';

function setup() {
  const seen: unknown[] = [];
  const record = <T>(q: unknown, v: T): T => {
    seen.push(q);
    return v;
  };
  const analytics: AnalyticsService = {
    cost: (q) => record(q, { rows: [], estimated: true }),
    top: (q) => record(q, { sessions: [], tickets: [], mergedPrs: 0, costPerMergedPrUsd: null }),
    tools: (q) => record(q, []),
    timing: (q) => record(q, { modelMs: 0, toolMs: 0, modelShare: null, cacheHitTrend: [] }),
    outcomes: (q) => record(q, { sessions: 0, outcomes: {}, friction: {}, goalCategories: {} }),
    wstack: (q) => record(q, []),
  };
  const rec = { weekStart: '2026-09-14', markdown: '# d', createdAt: 'x' };
  const digests: DigestService = {
    generate: async (w) => ({ ...rec, weekStart: w ?? rec.weekStart }),
    latest: () => null,
    syncSchedule: () => undefined,
    start: () => undefined,
    stop: () => undefined,
  };
  const { ctx } = makeP5Context({ config: withWakecap('/Users/test/Wakecap') });
  ctx.analytics = analytics;
  ctx.digests = digests;
  const app = bareApp();
  registerAnalyticsRoutes(app, ctx);
  return { app, seen };
}

describe('/api/analytics', () => {
  it('validates and forwards queries with defaults', async () => {
    const { app, seen } = setup();
    expect(
      await (
        await app.request(
          '/api/analytics/cost?groupBy=model&from=2026-09-01T00:00:00.000Z&to=2026-09-02T00:00:00.000Z',
        )
      ).json(),
    ).toEqual({ rows: [], estimated: true });
    expect(seen[0]).toEqual({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-02T00:00:00.000Z',
      groupBy: 'model',
    });
    await app.request('/api/analytics/top?limit=3&projectId=wakecap');
    expect(seen[1]).toMatchObject({ limit: 3, projectId: 'wakecap' });
    await app.request('/api/analytics/tools');
    expect(seen[2]).toMatchObject({ bucket: 'day' });
    for (const p of ['timing', 'outcomes', 'wstack'])
      expect((await app.request(`/api/analytics/${p}`)).status).toBe(200);
    expect((await app.request('/api/analytics/cost?groupBy=nope')).status).toBe(400);
    expect((await app.request('/api/analytics/top?limit=0')).status).toBe(400);
  });

  it('serves and generates digests', async () => {
    const { app } = setup();
    expect(await (await app.request('/api/analytics/digest')).json()).toBeNull();
    const res = await app.request('/api/analytics/digest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ weekStart: '2026-09-07' }),
    });
    expect(await res.json()).toMatchObject({ weekStart: '2026-09-07' });
    expect(
      (
        await app.request('/api/analytics/digest', {
          method: 'POST',
          body: JSON.stringify({ weekStart: 'x' }),
        })
      ).status,
    ).toBe(400);
  });
});
