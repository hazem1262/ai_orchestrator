import type { AnalyticsGroupBy } from '@orc/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  rangeFor,
  useAnalyticsCost,
  useAnalyticsOutcomes,
  useAnalyticsTiming,
  useAnalyticsTools,
  useAnalyticsTop,
  useAnalyticsWstack,
  useDigest,
  useGenerateDigest,
} from '@/api/queries/analytics.ts';
import { scopeProject } from '@/api/queries/inbox.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { formatPctValue, formatUsd } from '@/features/limits/format.ts';
import { useProjectStore } from '@/stores/project.ts';
import {
  cacheTrendOption,
  costByKeyOption,
  costOverTimeOption,
  outcomesOption,
  toolUsageOption,
} from './analytics-options.ts';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

const RANGES = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];
const GROUPS: AnalyticsGroupBy[] = ['day', 'week', 'project', 'model', 'source', 'ticket'];
const EMPTY_TIMING = { modelMs: 0, toolMs: 0, modelShare: null, cacheHitTrend: [] };
const EMPTY_OUTCOMES = { sessions: 0, outcomes: {}, friction: {}, goalCategories: {} };

/** `claude:abc` → `/sessions/claude/abc`; the id half may itself contain colons. */
function sessionHref(pk: string): string {
  const [source, ...rest] = pk.split(':');
  return `/sessions/${source}/${rest.join(':')}`;
}

function Chart({
  option,
  label,
  height = 220,
}: {
  option: echarts.EChartsCoreOption;
  label: string;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    chart.setOption(option);
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
    };
  }, [option]);
  return <div ref={ref} role="img" aria-label={label} style={{ height }} className="w-full" />;
}

function Panel({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-lg border bg-background p-3" aria-label={title}>
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (raw: string) => void;
}) {
  const id = useId();
  return (
    <span className="flex items-center gap-1 text-xs">
      <label htmlFor={id}>{label}</label>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-7 text-xs">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    </span>
  );
}

export function AnalyticsPage() {
  const projectId = scopeProject(useProjectStore((s) => s.projectId));
  const [days, setDays] = useState(30);
  const [groupBy, setGroupBy] = useState<AnalyticsGroupBy>('day');
  const [bucket, setBucket] = useState<'day' | 'week'>('day');
  const range = useMemo(() => rangeFor(days), [days]);
  const params = useMemo(() => ({ ...range, ...(projectId ? { projectId } : {}) }), [range, projectId]);

  const cost = useAnalyticsCost({ ...params, groupBy });
  const overTime = useAnalyticsCost({ ...params, groupBy: bucket });
  const top = useAnalyticsTop({ ...params, limit: 10 });
  const tools = useAnalyticsTools({ ...params, bucket });
  const timing = useAnalyticsTiming({ ...params, bucket });
  const outcomes = useAnalyticsOutcomes(params);
  const wstack = useAnalyticsWstack(range);
  const digest = useDigest();
  const generate = useGenerateDigest();

  const overTimeOpt = useMemo(() => costOverTimeOption(overTime.data?.rows ?? []), [overTime.data]);
  const byKeyOpt = useMemo(() => costByKeyOption(cost.data?.rows ?? []), [cost.data]);
  const toolsOpt = useMemo(() => toolUsageOption(tools.data ?? []), [tools.data]);
  const cacheOpt = useMemo(() => cacheTrendOption(timing.data ?? EMPTY_TIMING), [timing.data]);
  const outcomesOpt = useMemo(() => outcomesOption(outcomes.data ?? EMPTY_OUTCOMES), [outcomes.data]);

  const total = (cost.data?.rows ?? []).reduce((a, r) => a + r.costUsd, 0);
  const estimated = cost.data?.estimated ?? false;

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Analytics</h1>
        <Select
          label="Range"
          value={days}
          options={RANGES.map((r) => ({ value: r.days, label: r.label }))}
          onChange={(v) => setDays(Number(v))}
        />
        <Select
          label="Group by"
          value={groupBy}
          options={GROUPS.map((g) => ({ value: g, label: g }))}
          onChange={(v) => setGroupBy(v as AnalyticsGroupBy)}
        />
        <Select
          label="Bucket"
          value={bucket}
          options={[
            { value: 'day', label: 'day' },
            { value: 'week', label: 'week' },
          ]}
          onChange={(v) => setBucket(v as 'day' | 'week')}
        />
      </header>

      {cost.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load analytics.
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Spend" aside={estimated ? <Badge variant="outline">estimated</Badge> : null}>
          <p className="text-2xl font-semibold">{formatUsd(total)}</p>
          <Chart option={overTimeOpt} label="Cost over time" />
        </Panel>
        <Panel title={`Cost by ${groupBy}`}>
          <Chart option={byKeyOpt} label={`Cost by ${groupBy}`} />
        </Panel>
        <Panel title="Most expensive">
          <p className="mb-2 text-xs text-muted-foreground">
            {top.data?.mergedPrs ?? 0} merged PRs · cost per merged PR{' '}
            <strong>{formatUsd(top.data?.costPerMergedPrUsd ?? null)}</strong>
          </p>
          <ul className="flex flex-col gap-1 text-sm">
            {(top.data?.sessions ?? []).map((s) => (
              <li key={s.pk} className="flex justify-between gap-2">
                <a className="truncate underline" href={sessionHref(s.pk)}>
                  {s.name ?? s.pk}
                </a>
                <span>{formatUsd(s.costUsd)}</span>
              </li>
            ))}
          </ul>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {(top.data?.tickets ?? []).map((t) => (
              <li key={t.ticket} className="flex justify-between gap-2">
                <a className="underline" href={`/streams/${encodeURIComponent(t.ticket)}`}>
                  {t.ticket}
                </a>
                <span>
                  {formatUsd(t.costUsd)} · {t.sessions} sessions
                </span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Tools, MCP and skills">
          <Chart option={toolsOpt} label="Tool usage over time" />
        </Panel>
        <Panel title="Timing">
          <p className="text-sm">
            Model time share <strong>{formatPctValue(timing.data?.modelShare ?? null)}</strong>
          </p>
          <Chart option={cacheOpt} label="Cache hit rate" />
        </Panel>
        <Panel title="Outcomes & friction">
          <Chart option={outcomesOpt} label="Outcomes" height={180} />
          <ul className="flex flex-col gap-0.5 text-sm">
            {Object.entries(outcomes.data?.friction ?? {}).map(([k, v]) => (
              <li key={k} className="flex justify-between">
                <span>{k}</span>
                <span>{v}×</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="wstack skill runs">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th>skill</th>
                <th>runs</th>
                <th>outcomes</th>
                <th>avg duration</th>
              </tr>
            </thead>
            <tbody>
              {(wstack.data ?? []).map((r) => (
                <tr key={r.skill}>
                  <td>{r.skill}</td>
                  <td>{r.runs}</td>
                  <td>
                    {Object.entries(r.outcomes)
                      .map(([k, v]) => `${k} ${v}`)
                      .join(', ')}
                  </td>
                  <td>{r.avgDurationS === null ? '—' : `${Math.round(r.avgDurationS)}s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel
          title="Weekly digest"
          aside={
            <Button
              size="sm"
              variant="outline"
              disabled={generate.isPending}
              onClick={() => generate.mutate(undefined)}
            >
              Generate weekly digest
            </Button>
          }
        >
          {generate.isError ? (
            <p role="alert" className="mb-1 text-xs text-destructive">
              Could not generate the digest.
            </p>
          ) : null}
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">
            {digest.data?.markdown ?? 'No digest yet.'}
          </pre>
        </Panel>
      </div>
    </div>
  );
}
