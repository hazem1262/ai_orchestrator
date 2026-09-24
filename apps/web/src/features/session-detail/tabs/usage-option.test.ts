import type { UsagePoint } from '@orc/api-contract';
import { describe, expect, it } from 'vitest';
import { buildUsageOption, cumulativeByModel, hasCost, tokenSplitByModel } from './usage-option.ts';

const p = (ts: string, model: string, output: number, costUsd: number | null): UsagePoint => ({
  ts: `2026-09-01T09:00:${ts}.000Z`,
  agentId: null,
  model,
  input: 1,
  output,
  cacheRead: 10,
  cacheWrite: 2,
  costUsd,
});
const points = [
  p('05', 'claude-opus-5', 20, 0.1),
  p('01', 'claude-haiku-4-5', 5, null),
  p('35', 'claude-opus-5', 7, 0.2),
];

describe('usage option', () => {
  it('builds cumulative series per model in time order', () => {
    expect(cumulativeByModel(points, 'cost')).toEqual([
      { model: 'claude-haiku-4-5', points: [['2026-09-01T09:00:01.000Z', 0]] },
      {
        model: 'claude-opus-5',
        points: [
          ['2026-09-01T09:00:05.000Z', 0.1],
          ['2026-09-01T09:00:35.000Z', 0.3],
        ],
      },
    ]);
    expect(cumulativeByModel(points, 'tokens')[1]?.points.map((x) => x[1])).toEqual([33, 53]);
  });

  it('splits tokens by model', () => {
    expect(tokenSplitByModel(points)).toEqual([
      { model: 'claude-haiku-4-5', input: 1, output: 5, cacheRead: 10, cacheWrite: 2 },
      { model: 'claude-opus-5', input: 2, output: 27, cacheRead: 20, cacheWrite: 4 },
    ]);
  });

  it('detects cost availability and builds the chart option', () => {
    expect(hasCost(points)).toBe(true);
    expect(hasCost([p('01', 'm', 1, null)])).toBe(false);
    const opt = buildUsageOption(points, 'tokens');
    const series = opt.series as Array<{ type: string; name: string; stack?: string }>;
    expect(series.map((s) => [s.type, s.name])).toEqual([
      ['line', 'claude-haiku-4-5'],
      ['line', 'claude-opus-5'],
      ['bar', 'Cache read'],
      ['bar', 'Cache write'],
      ['bar', 'Input'],
      ['bar', 'Output'],
    ]);
    expect((opt.yAxis as Array<{ name?: string }>)[0]?.name).toBe('tokens');
  });
});
