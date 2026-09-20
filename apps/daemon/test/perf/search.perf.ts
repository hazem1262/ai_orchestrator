import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../helpers.ts';
import { seedPerfDb } from './seed.ts';

const QUERIES = ['notification', 'SAF-1', 'kubectl rollout', 'weekend deadline', 'word2999', 'pnpm gateway'];

describe('history search performance (F3: < 150 ms over ~1.5k sessions)', () => {
  it('keeps the p95 of sessions.list({ q }) under 150 ms', () => {
    const ctx = createTestContext();
    try {
      const t0 = performance.now();
      seedPerfDb(ctx.db, ctx.raw, { sessions: 1500, eventsPerSession: 60 });
      ctx.raw.pragma('optimize');
      console.log(`seeded 1500 sessions / 90000 events in ${Math.round(performance.now() - t0)} ms`);

      for (const q of QUERIES) ctx.sessions.list({ q, limit: 50 });
      const timings: number[] = [];
      for (let run = 0; run < 20; run++) {
        for (const q of QUERIES) {
          const start = performance.now();
          const res = ctx.sessions.list({ q, limit: 50, projectId: run % 2 === 0 ? undefined : 'wakecap' });
          timings.push(performance.now() - start);
          expect(res.items.length).toBeGreaterThan(0);
        }
      }
      timings.sort((a, b) => a - b);
      const p50 = timings[Math.floor(timings.length * 0.5)] ?? Number.POSITIVE_INFINITY;
      const p95 = timings[Math.floor(timings.length * 0.95)] ?? Number.POSITIVE_INFINITY;
      console.log(
        `search n=${timings.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${timings.at(-1)?.toFixed(1)}ms`,
      );
      expect(p95).toBeLessThan(150);
    } finally {
      ctx.dispose();
    }
  });
});
