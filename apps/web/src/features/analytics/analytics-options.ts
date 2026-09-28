import type { CostRow, OutcomesResult, TimingResult, ToolUsageRow } from '@orc/core';
import type { EChartsOption } from 'echarts';
import { type ChartTheme, readChartTheme } from './chart-theme.ts';
import { humanizeLabel } from './labels.ts';

const GRID = { left: 48, right: 16, top: 24, bottom: 28 };

const axisLine = (theme: ChartTheme) => ({ lineStyle: { color: theme.border } });
const splitLine = (theme: ChartTheme) => ({ lineStyle: { color: theme.border } });
const axisLabel = (theme: ChartTheme) => ({ color: theme.mutedForeground });
const moneyAxisLabel = (theme: ChartTheme) => ({
  color: theme.mutedForeground,
  formatter: (v: number) => `$${v}`,
});
const pctAxisLabel = (theme: ChartTheme) => ({
  color: theme.mutedForeground,
  formatter: (v: number) => `${v}%`,
});
const legendTheme = (theme: ChartTheme) => ({ textStyle: { color: theme.mutedForeground } });

export function costOverTimeOption(rows: CostRow[], theme: ChartTheme = readChartTheme()): EChartsOption {
  return {
    grid: GRID,
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: rows.map((r) => r.key),
      axisLine: axisLine(theme),
      axisLabel: axisLabel(theme),
    },
    yAxis: {
      type: 'value',
      axisLine: axisLine(theme),
      splitLine: splitLine(theme),
      axisLabel: moneyAxisLabel(theme),
    },
    series: [
      {
        type: 'bar',
        name: 'Cost',
        data: rows.map((r) => r.costUsd),
        itemStyle: { color: theme.colors[0] },
      },
    ],
  };
}

export function costByKeyOption(rows: CostRow[], theme: ChartTheme = readChartTheme()): EChartsOption {
  const sorted = [...rows].sort((a, b) => a.costUsd - b.costUsd);
  return {
    grid: { ...GRID, left: 120 },
    tooltip: { trigger: 'item' },
    xAxis: {
      type: 'value',
      axisLine: axisLine(theme),
      splitLine: splitLine(theme),
      axisLabel: moneyAxisLabel(theme),
    },
    yAxis: {
      type: 'category',
      data: sorted.map((r) => r.key),
      axisLine: axisLine(theme),
      axisLabel: axisLabel(theme),
    },
    series: [
      {
        type: 'bar',
        name: 'Cost',
        data: sorted.map((r) => r.costUsd),
        itemStyle: { color: theme.colors[1] },
      },
    ],
  };
}

export function toolUsageOption(
  rows: ToolUsageRow[],
  top = 8,
  theme: ChartTheme = readChartTheme(),
): EChartsOption {
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
    legend: { type: 'scroll', top: 0, ...legendTheme(theme) },
    xAxis: { type: 'category', data: buckets, axisLine: axisLine(theme), axisLabel: axisLabel(theme) },
    yAxis: {
      type: 'value',
      axisLine: axisLine(theme),
      splitLine: splitLine(theme),
      axisLabel: axisLabel(theme),
    },
    series: names.map((name, i) => {
      const color = theme.colors[i % theme.colors.length];
      return {
        type: 'line',
        name,
        data: buckets.map((b) => cells.get(`${b}\u0000${name}`) ?? 0),
        lineStyle: { color },
        itemStyle: { color },
      };
    }),
  };
}

export function cacheTrendOption(t: TimingResult, theme: ChartTheme = readChartTheme()): EChartsOption {
  return {
    grid: GRID,
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: t.cacheHitTrend.map((p) => p.bucket),
      axisLine: axisLine(theme),
      axisLabel: axisLabel(theme),
    },
    yAxis: {
      type: 'value',
      max: 100,
      axisLine: axisLine(theme),
      splitLine: splitLine(theme),
      axisLabel: pctAxisLabel(theme),
    },
    series: [
      {
        type: 'line',
        name: 'Cache hit rate',
        data: t.cacheHitTrend.map((p) => (p.rate === null ? null : Math.round(p.rate * 100))),
        lineStyle: { color: theme.colors[0] },
        itemStyle: { color: theme.colors[0] },
      },
    ],
  };
}

export function outcomesOption(o: OutcomesResult, theme: ChartTheme = readChartTheme()): EChartsOption {
  const data = Object.entries(o.outcomes)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value], i) => ({
      name: humanizeLabel(name),
      value,
      itemStyle: { color: theme.colors[i % theme.colors.length] },
    }));
  return {
    tooltip: { trigger: 'item' },
    legend: { type: 'scroll', bottom: 0, ...legendTheme(theme) },
    series: [{ type: 'pie', radius: ['40%', '70%'], label: { show: false }, data }],
  };
}
