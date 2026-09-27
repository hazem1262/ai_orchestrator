import type { CostRow, OutcomesResult, TimingResult, ToolUsageRow } from '@orc/core';
import type { EChartsOption } from 'echarts';

const GRID = { left: 48, right: 16, top: 24, bottom: 28 };
const money = { axisLabel: { formatter: (v: number) => `$${v}` } };

export function costOverTimeOption(rows: CostRow[]): EChartsOption {
  return {
    grid: GRID,
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: rows.map((r) => r.key) },
    yAxis: { type: 'value', ...money },
    series: [{ type: 'bar', name: 'Cost', data: rows.map((r) => r.costUsd) }],
  };
}

export function costByKeyOption(rows: CostRow[]): EChartsOption {
  const sorted = [...rows].sort((a, b) => a.costUsd - b.costUsd);
  return {
    grid: { ...GRID, left: 120 },
    tooltip: { trigger: 'item' },
    xAxis: { type: 'value', ...money },
    yAxis: { type: 'category', data: sorted.map((r) => r.key) },
    series: [{ type: 'bar', name: 'Cost', data: sorted.map((r) => r.costUsd) }],
  };
}

export function toolUsageOption(rows: ToolUsageRow[], top = 8): EChartsOption {
  const totals = new Map<string, number>();
  const cells = new Map<string, number>();
  for (const r of rows) {
    totals.set(r.name, (totals.get(r.name) ?? 0) + r.count);
    const k = `${r.bucket}\u0000${r.name}`;
    cells.set(k, (cells.get(k) ?? 0) + r.count);
  }
  const names = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([n]) => n);
  const buckets = [...new Set(rows.map((r) => r.bucket))].sort();
  return {
    grid: GRID,
    tooltip: { trigger: 'axis' },
    legend: { type: 'scroll', top: 0 },
    xAxis: { type: 'category', data: buckets },
    yAxis: { type: 'value' },
    series: names.map((name) => ({
      type: 'line',
      name,
      data: buckets.map((b) => cells.get(`${b}\u0000${name}`) ?? 0),
    })),
  };
}

export function cacheTrendOption(t: TimingResult): EChartsOption {
  return {
    grid: GRID,
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: t.cacheHitTrend.map((p) => p.bucket) },
    yAxis: { type: 'value', max: 100, axisLabel: { formatter: (v: number) => `${v}%` } },
    series: [
      {
        type: 'line',
        name: 'Cache hit rate',
        data: t.cacheHitTrend.map((p) => (p.rate === null ? null : Math.round(p.rate * 100))),
      },
    ],
  };
}

export function outcomesOption(o: OutcomesResult): EChartsOption {
  const data = Object.entries(o.outcomes)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => ({ name, value }));
  return {
    tooltip: { trigger: 'item' },
    legend: { type: 'scroll', bottom: 0 },
    series: [{ type: 'pie', radius: ['40%', '70%'], label: { show: false }, data }],
  };
}
