import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { createLiveTracker } from '../../src/live/live-tracker.ts';
import { createRegistryWatcher } from '../../src/live/registry-watcher.ts';
import { createTestContext } from '../helpers.ts';

/**
 * Regression test for "Fix round 2": the cost of the above-ladder context-window fallback.
 *
 * `contextWindowForUsage` returns the observed peak once usage passes the largest known rung. The
 * peak is rounded UP to `CONTEXT_WINDOW_STEP` (250k) specifically so the window changes about once
 * per 250k tokens of growth. Without that rounding the window changes on nearly every assistant
 * record — `cache_read` grows almost monotonically — and every change rebuilds the reducer through
 * `refoldUpTo`, which re-reads and re-parses the whole transcript from byte 0. Real transcripts on
 * a working machine reach 31 MB.
 *
 * The rounding itself is pinned by unit tests. What is pinned *here* is the mechanism that makes
 * the rounding pay off: the `if (w !== e.contextWindow)` gate in `tail`. Replacing that gate with
 * `if (true)` reinstates a refold per record and passes every correctness test in the suite, while
 * restoring the full regression.
 *
 * Both assertions are RATIOS measured in the same process on the same machine, not wall-clock
 * budgets, so they mean the same thing on a fast laptop and a loaded CI box. Measured on this
 * machine, with each variant run through this exact test:
 *
 * ```
 *                        n=100    n=400   under n=400   ratio   growth
 *   as shipped            6.8ms    6.9ms        3.4ms    2.0x    1.01x
 *   rounding removed     32.2ms  250.8ms        2.5ms  101.3x    7.79x
 *   gate removed         33.9ms  250.2ms      246.8ms    1.0x    7.38x
 * ```
 *
 * **Both assertions are needed, and the second is the one that matters.** Removing the gate slows
 * the under-ladder baseline down by exactly as much as the above-ladder case, so the ratio reads a
 * healthy 1.0x and the ratio assertion alone would pass. Only `growth` — cost against record count,
 * which is the actual property — catches it. A single-number perf test here would have been a test
 * that passes for the wrong reason.
 */
const T0 = Date.parse('2026-09-01T09:10:00.000Z');
const SESSION = 's-perf-window';
const PID = 42_000;

const usageRecord = (i: number, used: number): string =>
  `${JSON.stringify({
    type: 'assistant',
    uuid: `p${i}`,
    parentUuid: null,
    sessionId: SESSION,
    cwd: '/Users/test/Wakecap',
    timestamp: new Date(T0 + i * 1000).toISOString(),
    message: {
      id: `m${i}`,
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'x'.repeat(200) }],
      usage: {
        input_tokens: used,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  })}\n`;

/** Times the tracker's first full pass over a transcript of `n` ascending-usage records. */
async function timeFirstPass(n: number, baseTokens: number, stepTokens: number): Promise<number> {
  const ctx = createTestContext();
  try {
    const file = join(ctx.homes.claudeHome, 'projects/-Users-test-Wakecap', `${SESSION}.jsonl`);
    writeFileSync(file, '');
    for (let i = 0; i < n; i++) appendFileSync(file, usageRecord(i, baseTokens + i * stepTokens));
    writeFileSync(
      join(ctx.homes.claudeHome, 'sessions', `${PID}.json`),
      JSON.stringify({
        pid: PID,
        procStart: null,
        sessionId: SESSION,
        cwd: '/Users/test/Wakecap',
        status: 'idle',
      }),
    );
    const tracker = createLiveTracker(ctx, {
      registry: createRegistryWatcher({
        dir: join(ctx.homes.claudeHome, 'sessions'),
        watch: false,
        pollMs: 600_000,
      }),
      liveness: { isAlive: async () => true },
      codex: { scan: async () => [] },
      now: () => new Date(T0),
    });
    const started = performance.now();
    await tracker.start();
    const elapsed = performance.now() - started;
    expect(tracker.get(`claude:${SESSION}`)?.live?.contextFill).not.toBeNull();
    await tracker.stop();
    return elapsed;
  } finally {
    ctx.dispose(); // also removes the temp homes this context created
  }
}

describe('LiveTracker above-ladder context window cost', () => {
  it('stays close to the under-ladder cost and does not grow with record count', async () => {
    // 1.1M and climbing: every record sets a new peak, which is the adversarial shape.
    const above100 = await timeFirstPass(100, 1_100_000, 3_000);
    const above400 = await timeFirstPass(400, 1_100_000, 3_000);
    // The same record counts with usage that never leaves the 200k rung: no refold at all.
    const under400 = await timeFirstPass(400, 10_000, 100);

    console.log(
      `above-ladder n=100 ${above100.toFixed(1)}ms | n=400 ${above400.toFixed(1)}ms | ` +
        `under-ladder n=400 ${under400.toFixed(1)}ms | ` +
        `ratio ${(above400 / under400).toFixed(1)}x | growth ${(above400 / above100).toFixed(2)}x`,
    );

    // Catches the rounding being removed (101.3x measured); 2.0x as shipped, so 20x is decisive.
    // Note this one does NOT catch the gate being removed — see the block comment.
    expect(above400 / under400).toBeLessThan(20);
    // The real property: flat in record count. 4x the records cost 7.4-7.8x with either mutation
    // and 1.01x as shipped. This is the assertion that catches both.
    expect(above400 / above100).toBeLessThan(3);
  });
});
