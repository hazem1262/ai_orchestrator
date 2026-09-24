import type { UsagePoint } from '@orc/api-contract';
import type { EChartsOption } from 'echarts';

export type UsageMetric = 'cost' | 'tokens';

const byTs = (a: UsagePoint, b: UsagePoint) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function cumulativeByModel(
  points: readonly UsagePoint[],
  metric: UsageMetric,
): Array<{ model: string; points: Array<[string, number]> }> {
  const totals = new Map<string, number>();
  const series = new Map<string, Array<[string, number]>>();
  for (const p of [...points].sort(byTs)) {
    const v = metric === 'cost' ? (p.costUsd ?? 0) : p.input + p.output + p.cacheRead + p.cacheWrite;
    const t = (totals.get(p.model) ?? 0) + v;
    totals.set(p.model, t);
    const list = series.get(p.model) ?? [];
    list.push([p.ts, round4(t)]);
    series.set(p.model, list);
  }
  return [...series].map(([model, pts]) => ({ model, points: pts }));
}

export function tokenSplitByModel(
  points: readonly UsagePoint[],
): Array<{ model: string; input: number; output: number; cacheRead: number; cacheWrite: number }> {
  const map = new Map<
    string,
    { model: string; input: number; output: number; cacheRead: number; cacheWrite: number }
  >();
  for (const p of [...points].sort(byTs)) {
    const s = map.get(p.model) ?? { model: p.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    s.input += p.input;
    s.output += p.output;
    s.cacheRead += p.cacheRead;
    s.cacheWrite += p.cacheWrite;
    map.set(p.model, s);
  }
  return [...map.values()];
}

export function hasCost(points: readonly UsagePoint[]): boolean {
  return points.some((p) => p.costUsd !== null);
}

const SPLIT_KEYS = [
  ['cacheRead', 'Cache read'],
  ['cacheWrite', 'Cache write'],
  ['input', 'Input'],
  ['output', 'Output'],
] as const;

export function buildUsageOption(points: readonly UsagePoint[], metric: UsageMetric): EChartsOption {
  const cumulative = cumulativeByModel(points, metric);
  const split = tokenSplitByModel(points);
  return {
    animation: false,
    tooltip: { trigger: 'axis' },
    legend: { top: 0, type: 'scroll' },
    grid: [
      { left: 64, right: 16, top: 36, height: '46%' },
      { left: 140, right: 16, top: '66%', bottom: 24 },
    ],
    xAxis: [
      { type: 'time', gridIndex: 0 },
      { type: 'value', gridIndex: 1, name: 'tokens' },
    ],
    yAxis: [
      { type: 'value', gridIndex: 0, name: metric === 'cost' ? 'USD (cumulative)' : 'tokens' },
      { type: 'category', gridIndex: 1, data: split.map((s) => s.model) },
    ],
    series: [
      ...cumulative.map((c) => ({
        type: 'line' as const,
        name: c.model,
        step: 'end' as const,
        showSymbol: false,
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: c.points,
      })),
      ...SPLIT_KEYS.map(([key, name]) => ({
        type: 'bar' as const,
        name,
        stack: 'split',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: split.map((s) => s[key]),
      })),
    ],
  };
}
