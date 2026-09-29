import type { Source } from '@orc/core';
import { lazy, Suspense, useMemo, useState } from 'react';
import { useSessionUsageSeries } from '@/api/queries/session-detail.ts';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { formatPct, formatTokens } from '../timeline/format.ts';
import { hasCost, tokenSplitByModel, type UsageMetric } from './usage-option.ts';

// ECharts loads with the chart, not with the session page.
const UsageChart = lazy(() => import('./UsageChart.tsx').then((m) => ({ default: m.UsageChart })));

const METRICS: Array<{ id: UsageMetric; label: string }> = [
  { id: 'cost', label: 'Cost' },
  { id: 'tokens', label: 'Tokens' },
];

export function UsageTab({ source, id }: { source: Source; id: string }) {
  const q = useSessionUsageSeries(source, id);
  const points = useMemo(() => q.data ?? [], [q.data]);
  const costAvailable = hasCost(points);
  const [metric, setMetric] = useState<UsageMetric>('cost');
  const effective: UsageMetric = costAvailable ? metric : 'tokens';

  const totals = tokenSplitByModel(points).reduce(
    (t, s) => ({
      input: t.input + s.input,
      output: t.output + s.output,
      cacheRead: t.cacheRead + s.cacheRead,
      cacheWrite: t.cacheWrite + s.cacheWrite,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  const denom = totals.input + totals.cacheRead + totals.cacheWrite;

  if (q.isLoading) return <p className="p-3">Loading usage…</p>;
  if (q.isError)
    return (
      <p role="alert" className="p-3">
        Could not load usage.
      </p>
    );
  if (points.length === 0)
    return <p className="p-3 text-sm text-muted-foreground">No model usage recorded.</p>;

  return (
    <div className="p-3">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        role="radiogroup"
        aria-label="Metric"
        value={effective}
        onValueChange={(v) => {
          if (v === 'cost' || v === 'tokens') setMetric(v);
        }}
        className="mb-2"
      >
        {METRICS.map((m) => {
          const disabled = m.id === 'cost' && !costAvailable;
          return (
            <ToggleGroupItem
              key={m.id}
              value={m.id}
              disabled={disabled}
              title={disabled ? 'No cost data for this session' : undefined}
            >
              {m.label}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      <p data-testid="usage-totals" className="mb-2 text-xs text-muted-foreground">
        {`cache read ${formatTokens(totals.cacheRead)} · cache write ${formatTokens(totals.cacheWrite)} · input ${formatTokens(totals.input)} · output ${formatTokens(totals.output)} · cache hit ${formatPct(denom > 0 ? totals.cacheRead / denom : null)}`}
      </p>
      <Suspense fallback={<div data-testid="usage-chart" className="h-[420px] w-full" />}>
        <UsageChart points={points} metric={effective} />
      </Suspense>
    </div>
  );
}
