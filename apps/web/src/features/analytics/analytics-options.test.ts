import type { CostRow, OutcomesResult, TimingResult, ToolUsageRow } from '@orc/core';
import { describe, expect, it } from 'vitest';
import {
  cacheTrendOption,
  costByKeyOption,
  costOverTimeOption,
  outcomesOption,
  toolUsageOption,
} from './analytics-options.ts';

const rows: CostRow[] = [
  {
    key: '2026-09-15',
    costUsd: 10,
    tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    sessions: 2,
  },
  {
    key: '2026-09-16',
    costUsd: 5,
    tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    sessions: 1,
  },
];

describe('chart options', () => {
  it('builds a bar series over time with money axis labels', () => {
    const o = costOverTimeOption(rows) as {
      xAxis: { data: string[] };
      series: Array<{ type: string; data: number[] }>;
    };
    expect(o.xAxis.data).toEqual(['2026-09-15', '2026-09-16']);
    expect(o.series[0]?.type).toBe('bar');
    expect(o.series[0]?.data).toEqual([10, 5]);
  });

  it('builds a horizontal bar for grouped keys, biggest first', () => {
    const o = costByKeyOption(rows) as { yAxis: { data: string[] } };
    expect(o.yAxis.data).toEqual(['2026-09-16', '2026-09-15']); // echarts draws the last category at the top
  });

  it('keeps only the top tool names', () => {
    const tools: ToolUsageRow[] = [
      { bucket: '2026-09-15', kind: 'tool', name: 'Bash', count: 5 },
      { bucket: '2026-09-16', kind: 'tool', name: 'Bash', count: 2 },
      { bucket: '2026-09-15', kind: 'skill', name: 'conductor', count: 3 },
      { bucket: '2026-09-15', kind: 'mcp', name: 'linear', count: 1 },
    ];
    const o = toolUsageOption(tools, 2) as { series: Array<{ name: string; data: number[] }> };
    expect(o.series.map((s) => s.name)).toEqual(['Bash', 'conductor']);
    expect(o.series[0]?.data).toEqual([5, 2]);
  });

  it('plots the cache trend and outcome counts', () => {
    const t: TimingResult = {
      modelMs: 3,
      toolMs: 1,
      modelShare: 0.75,
      cacheHitTrend: [
        { bucket: 'a', rate: 0.5 },
        { bucket: 'b', rate: null },
      ],
    };
    const c = cacheTrendOption(t) as { series: Array<{ data: Array<number | null> }> };
    expect(c.series[0]?.data).toEqual([50, null]);
    const o: OutcomesResult = {
      sessions: 3,
      outcomes: { fully_achieved: 2, mostly_achieved: 1 },
      friction: {},
      goalCategories: {},
    };
    // Names are humanized (sentence case, no underscores) now instead of the raw snake_case
    // recap keys — that was the analytics audit's snake_case-labels finding.
    const oo = outcomesOption(o) as {
      series: Array<{ data: Array<{ name: string; value: number }> }>;
    };
    expect(oo.series[0]?.data.map((d) => ({ name: d.name, value: d.value }))).toEqual([
      { name: 'Fully achieved', value: 2 },
      { name: 'Mostly achieved', value: 1 },
    ]);
  });
});
