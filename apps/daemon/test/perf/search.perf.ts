import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../helpers.ts';
import { seedPerfDb } from './seed.ts';

/**
 * Query shapes, each labelled with what it actually exercises against the seeded corpus (see
 * `seed.ts`: 1,500 sessions, ~1,900 word-draws each from a 3,000-word vocabulary — at that
 * density no single vocabulary token is genuinely rare, so shapes are labelled by their measured
 * match rate, not by assumption). `toFtsQuery` (`src/db/fts.ts`) prefix-matches only the last
 * (still-being-typed) token of a query; earlier tokens are exact matches (search-as-you-type
 * convention — see `fts.ts`'s doc comment).
 *
 * `prefix fan-out` (`word1 word2`) is the adversarial shape from "Fix round 1"/"Fix round 2":
 * "word1"/"word2" each expand to ~1,111 of 3,000 distinct vocabulary terms (word1, word10-19,
 * word100-199, word1000-1999 all share the "1" prefix). Before "Fix round 2" this cost ~4 s —
 * 25x+ the F3 budget, root-caused to FTS5's `snippet()` aux function scaling with a prefix's
 * matching-term cardinality, paid once per result row. It is now gated like every other shape:
 * `toFtsQuery` prefixing only the last token, plus `sessions.list()`'s cardinality-gated fallback
 * to an application-level highlight (`ftsPrefixCardinality`/`FTS_PREFIX_CARDINALITY_CAP` in
 * `services/sessions.ts`), bring it to ~60-90 ms — see task-19-report.md's "Fix round 2" for the
 * full before/after numbers and the fix's design.
 */
const QUERIES: Array<{ label: string; q: string; expectMatch: boolean }> = [
  { label: 'common word', q: 'notification', expectMatch: true },
  { label: 'ticket prefix', q: 'SAF-1', expectMatch: true },
  { label: 'two-word phrase', q: 'kubectl rollout', expectMatch: true },
  { label: 'topic phrase', q: 'weekend deadline', expectMatch: true },
  // Not actually rare: measured at 415/1500 sessions (27.7%) — a single vocabulary token has
  // good odds of appearing at least once per session at this word density. Kept as a realistic
  // "single common-ish token" shape, relabelled honestly.
  { label: 'single vocab token (not rare: ~28% of sessions)', q: 'word2999', expectMatch: true },
  // Not actually a no-match query: measured at 1480/1500 sessions (98.7%) — "pnpm" and "gateway"
  // are both drawn from the small TOOLS list every tool_call event uses, so this shape is close
  // to a full-table scan. Kept, relabelled honestly.
  { label: 'tool command (near-universal: ~99% of sessions)', q: 'pnpm gateway', expectMatch: true },
  // The adversarial worst case — see the block comment above `QUERIES`. Now gated like every
  // other shape.
  { label: 'prefix fan-out (two short numeric-prefix tokens)', q: 'word1 word2', expectMatch: true },
  // The genuine no-result path: never exercised by the original suite, whose loop asserted
  // `items.length > 0` on every call.
  { label: 'zero-hit', q: 'zzz-nonexistent-term', expectMatch: false },
];

describe('history search performance (F3: < 150 ms over ~1.5k sessions)', () => {
  it('keeps the p95 of sessions.list({ q }) under 150 ms for every query shape, including the adversarial one', () => {
    const ctx = createTestContext();
    try {
      const t0 = performance.now();
      seedPerfDb(ctx.db, ctx.raw, { sessions: 1500, eventsPerSession: 60 });
      ctx.raw.pragma('optimize');
      console.log(`seeded 1500 sessions / 90000 events in ${Math.round(performance.now() - t0)} ms`);

      for (const { q } of QUERIES) ctx.sessions.list({ q, limit: 50 });
      const timingsByLabel = new Map<string, number[]>(QUERIES.map((q) => [q.label, []]));
      const pooled: number[] = [];
      for (let run = 0; run < 20; run++) {
        for (const { label, q, expectMatch } of QUERIES) {
          const start = performance.now();
          const res = ctx.sessions.list({ q, limit: 50, projectId: run % 2 === 0 ? undefined : 'wakecap' });
          const elapsed = performance.now() - start;
          timingsByLabel.get(label)?.push(elapsed);
          pooled.push(elapsed);
          expect(Array.isArray(res.items)).toBe(true);
          if (expectMatch) expect(res.items.length).toBeGreaterThan(0);
          else expect(res.items.length).toBe(0);
        }
      }

      const stats = (timings: number[]) => {
        const sorted = [...timings].sort((a, b) => a - b);
        const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? Number.POSITIVE_INFINITY;
        const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? Number.POSITIVE_INFINITY;
        const max = sorted.at(-1) ?? Number.POSITIVE_INFINITY;
        return { p50, p95, max };
      };

      for (const { label } of QUERIES) {
        const timings = timingsByLabel.get(label) ?? [];
        const { p50, p95, max } = stats(timings);
        console.log(
          `search[${label}] n=${timings.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`,
        );
        // Every shape, including the adversarial fan-out one, must individually stay inside the
        // F3 budget — a pooled average can hide a single shape that's uncomfortably close to it.
        expect(p95).toBeLessThan(150);
      }

      const pooledStats = stats(pooled);
      console.log(
        `search[pooled] n=${pooled.length} p50=${pooledStats.p50.toFixed(1)}ms p95=${pooledStats.p95.toFixed(1)}ms max=${pooledStats.max.toFixed(1)}ms`,
      );
      expect(pooledStats.p95).toBeLessThan(150);
    } finally {
      ctx.dispose();
    }
  });
});
