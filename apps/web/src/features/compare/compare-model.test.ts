import type { CompareEstimate, CompareVariantView } from '@orc/api-contract';
import { describe, expect, it } from 'vitest';
import { budgetWarning, formatEstimate, metricMax, metricPct, variantHighlights } from './compare-model.ts';

const est = (over: Partial<CompareEstimate> = {}): CompareEstimate => ({
  variants: 3,
  multiplier: 3,
  avgSessionCostUsd: 1.5,
  estimatedUsd: 4.5,
  sample: 12,
  burnRateUsdPerHour: 2,
  budget: { ok: true, pct: 0.3, limitUsd: 50 },
  ...over,
});

const view = (index: number, over: Partial<CompareVariantView> = {}): CompareVariantView => ({
  index,
  source: 'claude',
  model: null,
  label: `v${index + 1} claude`,
  sessionId: `s${index}`,
  sessionPk: `claude:s${index}`,
  ptyId: null,
  worktreePath: `/w/${index}`,
  branch: null,
  error: null,
  status: 'review',
  costUsd: null,
  durationMs: null,
  tests: null,
  recap: null,
  diff: null,
  ...over,
});

describe('compare model', () => {
  it('formats the estimate', () => {
    expect(formatEstimate(est())).toBe(
      'Runs 3 agents · 3× the cost of one session · ≈ $4.50 (median $1.50 × 3 over 12 recent sessions)',
    );
    expect(formatEstimate(est({ estimatedUsd: null, avgSessionCostUsd: null, sample: 0 }))).toBe(
      'Runs 3 agents · 3× the cost of one session · no cost history yet',
    );
  });

  it('warns near and over budget', () => {
    expect(budgetWarning(est())).toBeNull();
    expect(budgetWarning(est({ budget: { ok: true, pct: 0.85, limitUsd: 50 } }))).toBe(
      'Budget at 85% of $50.00',
    );
    expect(budgetWarning(est({ budget: { ok: false, pct: 1.1, limitUsd: 50 } }))).toBe(
      'Budget exceeded (110%): the launch will be refused',
    );
  });

  it('highlights the cheapest, green and smallest variants', () => {
    const h = variantHighlights([
      view(0, {
        costUsd: 2,
        tests: { ts: 't', command: 'c', passed: 5, failed: 1, skipped: 0, durationMs: 1 },
        diff: { files: 3, insertions: 40, deletions: 2, untracked: 0 },
      }),
      view(1, {
        costUsd: 1,
        tests: { ts: 't', command: 'c', passed: 5, failed: 0, skipped: 0, durationMs: 1 },
        diff: { files: 1, insertions: 8, deletions: 1, untracked: 0 },
      }),
      view(2, {
        costUsd: null,
        error: 'failed',
        diff: { files: 0, insertions: 0, deletions: 0, untracked: 0 },
      }),
    ]);
    expect(h).toEqual({ cheapest: 1, greenTests: [1], smallestDiff: 1 });
  });

  it('finds the largest cost, duration and diff size across the variants', () => {
    const max = metricMax([
      view(0, {
        costUsd: 2,
        durationMs: 500,
        diff: { files: 1, insertions: 10, deletions: 0, untracked: 0 },
      }),
      view(1, { costUsd: 5, durationMs: 200, diff: { files: 1, insertions: 4, deletions: 1, untracked: 0 } }),
    ]);
    expect(max).toEqual({ cost: 5, duration: 500, diff: 10 });
  });

  it('scales a bar to the group max, and to 0 when there is nothing to compare against', () => {
    expect(metricPct(5, 10)).toBe(0.5);
    expect(metricPct(0, 0)).toBe(0);
  });
});
