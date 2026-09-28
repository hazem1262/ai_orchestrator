import type { AnalyticsGroupBy } from '@orc/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { BarChart3 } from 'lucide-react';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { cn } from '@/components/ui/cn.ts';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { Separator } from '@/components/ui/separator.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { formatPctValue, formatUsd } from '@/features/limits/format.ts';
import { useProjectStore } from '@/stores/project.ts';
import {
  cacheTrendOption,
  costByKeyOption,
  costOverTimeOption,
  outcomesOption,
  toolUsageOption,
} from './analytics-options.ts';
import { useChartTheme } from './chart-theme.ts';
import { humanizeLabel } from './labels.ts';

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
  { days: 7, value: '7', label: '7d', full: 'Last 7 days' },
  { days: 30, value: '30', label: '30d', full: 'Last 30 days' },
  { days: 90, value: '90', label: '90d', full: 'Last 90 days' },
];
// Day/week were dropped from "group by": grouping the same range by day duplicated the spend
// chart just below it (the analytics audit's snake_case/duplicate-chart finding).
const GROUPS: Array<{ id: AnalyticsGroupBy; label: string }> = [
  { id: 'project', label: 'Project' },
  { id: 'model', label: 'Model' },
  { id: 'source', label: 'Source' },
  { id: 'ticket', label: 'Ticket' },
];
const BUCKETS: Array<{ id: 'day' | 'week'; label: string }> = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
];
const EMPTY_TIMING = { modelMs: 0, toolMs: 0, modelShare: null, cacheHitTrend: [] };
const EMPTY_OUTCOMES = { sessions: 0, outcomes: {}, friction: {}, goalCategories: {} };

/** `claude:abc` → `/sessions/claude/abc`; the id half may itself contain colons. */
function sessionHref(pk: string): string {
  const [source, ...rest] = pk.split(':');
  return `/sessions/${source}/${rest.join(':')}`;
}

/** Mean of the non-null rates in a cache-hit trend, as a single headline figure. */
function averageRate(trend: Array<{ rate: number | null }>): number | null {
  const rates = trend.map((p) => p.rate).filter((r): r is number => r !== null);
  if (rates.length === 0) return null;
  return rates.reduce((a, b) => a + b, 0) / rates.length;
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

function ChartCard({
  title,
  description,
  action,
  className,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function KpiTile({
  label,
  value,
  hint,
  delta = null,
}: {
  label: string;
  value: string;
  hint?: string;
  /** A positive delta is treated as a worse outcome (this page only ever deltas spend). */
  delta?: number | null;
}) {
  const up = (delta ?? 0) >= 0;
  return (
    <Card>
      <CardContent className="flex min-w-0 flex-col gap-1 p-3">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          {delta !== null ? (
            <span className={cn('shrink-0 font-mono', up ? 'text-destructive' : 'text-success')}>
              {up ? '+' : '−'}
              {Math.abs(Math.round(delta * 100))}%
            </span>
          ) : null}
          {hint ? <span className="truncate">{hint}</span> : null}
        </p>
      </CardContent>
    </Card>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy="true" aria-label="Loading analytics">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <CardContent className="flex flex-col gap-2 p-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-7 w-20" />
              <Skeleton className="h-3 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-4 w-32" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-56 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function PeriodToggle({ days, onChange }: { days: number; onChange(days: number): void }) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      value={String(days)}
      onValueChange={(v) => {
        if (v) onChange(Number(v));
      }}
      aria-label="Range"
    >
      {RANGES.map((r) => (
        <ToggleGroupItem key={r.value} value={r.value} aria-label={r.full}>
          {r.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function LabeledSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onChange(raw: string): void;
}) {
  const id = useId();
  return (
    <span className="flex items-center gap-1 text-xs">
      <label htmlFor={id} className="text-muted-foreground">
        {label}
      </label>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-7 text-xs">
        {options.map((o) => (
          <option key={o.id} value={o.id}>
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
  const [groupBy, setGroupBy] = useState<AnalyticsGroupBy>('project');
  const [bucket, setBucket] = useState<'day' | 'week'>('day');
  const range = useMemo(() => rangeFor(days), [days]);
  const params = useMemo(() => ({ ...range, ...(projectId ? { projectId } : {}) }), [range, projectId]);
  const prevRange = useMemo(() => ({ from: rangeFor(2 * days).from, to: range.from }), [days, range.from]);
  const prevParams = useMemo(
    () => ({ ...prevRange, ...(projectId ? { projectId } : {}) }),
    [prevRange, projectId],
  );

  const overTime = useAnalyticsCost({ ...params, groupBy: bucket });
  const prevOverTime = useAnalyticsCost({ ...prevParams, groupBy: bucket });
  const split = useAnalyticsCost({ ...params, groupBy });
  const top = useAnalyticsTop({ ...params, limit: 10 });
  const tools = useAnalyticsTools({ ...params, bucket });
  const timing = useAnalyticsTiming({ ...params, bucket });
  const outcomes = useAnalyticsOutcomes(params);
  const wstack = useAnalyticsWstack(range);
  const digest = useDigest();
  const generate = useGenerateDigest();

  const chartTheme = useChartTheme();
  const overTimeOpt = useMemo(
    () => costOverTimeOption(overTime.data?.rows ?? [], chartTheme),
    [overTime.data, chartTheme],
  );
  const byKeyOpt = useMemo(
    () => costByKeyOption(split.data?.rows ?? [], chartTheme),
    [split.data, chartTheme],
  );
  const toolsOpt = useMemo(() => toolUsageOption(tools.data ?? [], 8, chartTheme), [tools.data, chartTheme]);
  const cacheOpt = useMemo(
    () => cacheTrendOption(timing.data ?? EMPTY_TIMING, chartTheme),
    [timing.data, chartTheme],
  );
  const outcomesOpt = useMemo(
    () => outcomesOption(outcomes.data ?? EMPTY_OUTCOMES, chartTheme),
    [outcomes.data, chartTheme],
  );

  const rows = overTime.data?.rows ?? [];
  const total = rows.reduce((a, r) => a + r.costUsd, 0);
  const sessions = rows.reduce((a, r) => a + r.sessions, 0);
  const prevTotal = (prevOverTime.data?.rows ?? []).reduce((a, r) => a + r.costUsd, 0);
  const spendDelta = prevTotal > 0 ? (total - prevTotal) / prevTotal : null;
  const estimated = overTime.data?.estimated ?? false;
  const cacheHitRate = averageRate(timing.data?.cacheHitTrend ?? []);
  const rangeLabel = RANGES.find((r) => r.days === days)?.full ?? `Last ${days} days`;

  const isLoading = overTime.isLoading;
  const isError = overTime.isError || split.isError;
  const isEmpty = !isLoading && !isError && rows.length === 0;

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Analytics</h1>
          <p className="text-sm text-muted-foreground">Spend, tool use and outcomes across every session.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <PeriodToggle days={days} onChange={setDays} />
          <LabeledSelect
            label="By"
            value={groupBy}
            options={GROUPS}
            onChange={(v) => setGroupBy(v as AnalyticsGroupBy)}
          />
          <LabeledSelect
            label="Bucket"
            value={bucket}
            options={BUCKETS}
            onChange={(v) => setBucket(v as 'day' | 'week')}
          />
        </div>
      </header>

      {isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load analytics</AlertTitle>
          <AlertDescription>Try changing the range or reloading the page.</AlertDescription>
        </Alert>
      ) : null}

      {isLoading ? (
        <AnalyticsSkeleton />
      ) : isEmpty ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BarChart3 />
            </EmptyMedia>
            <EmptyTitle>No usage in this range</EmptyTitle>
            <EmptyDescription>
              Spend and tool charts fill in once sessions run. Claude and Codex sessions from any terminal
              count.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <section aria-label="Key figures" className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiTile
              label="Spend"
              value={formatUsd(total)}
              delta={spendDelta}
              hint={estimated ? `estimated · vs previous ${days} days` : `vs previous ${days} days`}
            />
            <KpiTile
              label="Sessions"
              value={String(sessions)}
              hint={sessions > 0 ? `${formatUsd(total / sessions)} per session` : undefined}
            />
            <KpiTile
              label="Cost per merged PR"
              value={formatUsd(top.data?.costPerMergedPrUsd ?? null)}
              hint={`${top.data?.mergedPrs ?? 0} PRs merged`}
            />
            <KpiTile
              label="Cache hit rate"
              value={formatPctValue(cacheHitRate)}
              hint={`Model time ${formatPctValue(timing.data?.modelShare ?? null)} of wall clock`}
            />
          </section>

          <div className="grid gap-4 md:grid-cols-2">
            <ChartCard
              title="Spend per day"
              description={`${rangeLabel} · ${formatUsd(total)}`}
              className="md:col-span-2"
            >
              <Chart option={overTimeOpt} label="Cost over time" />
            </ChartCard>

            <ChartCard title={`Spend by ${groupBy}`} description="Same range, split instead of over time.">
              <Chart option={byKeyOpt} label={`Cost by ${groupBy}`} />
            </ChartCard>

            <ChartCard title="Tools, MCP and skills" description="Top tools, MCP servers and skills.">
              <Chart option={toolsOpt} label="Tool usage over time" />
            </ChartCard>

            <ChartCard
              title="Most expensive sessions"
              action={<Badge variant="secondary">{top.data?.mergedPrs ?? 0} PRs merged</Badge>}
            >
              <ul className="flex flex-col divide-y text-sm">
                {(top.data?.sessions ?? []).map((s) => (
                  <li key={s.pk} className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
                    <a className="min-w-0 flex-1 truncate underline" href={sessionHref(s.pk)}>
                      {s.name ?? s.pk}
                    </a>
                    <span className="shrink-0 tabular-nums">{formatUsd(s.costUsd)}</span>
                  </li>
                ))}
              </ul>
              {(top.data?.tickets ?? []).length > 0 ? (
                <>
                  <Separator className="my-2" />
                  <h3 className="mb-1 text-xs font-medium text-muted-foreground">By ticket</h3>
                  <ul className="flex flex-col divide-y text-sm">
                    {(top.data?.tickets ?? []).map((t) => (
                      <li key={t.ticket} className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
                        <a
                          className="min-w-0 flex-1 truncate underline"
                          href={`/streams/${encodeURIComponent(t.ticket)}`}
                        >
                          {t.ticket}
                        </a>
                        <span className="shrink-0 tabular-nums">
                          {formatUsd(t.costUsd)} · {t.sessions} sessions
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </ChartCard>

            <ChartCard title="Cache hit rate over time" description="Share of tokens served from cache.">
              <Chart option={cacheOpt} label="Cache hit rate" height={180} />
            </ChartCard>

            <ChartCard
              title="Outcomes & friction"
              description={`${(outcomes.data ?? EMPTY_OUTCOMES).sessions} sessions with a recorded outcome.`}
            >
              <Chart option={outcomesOpt} label="Outcomes" height={180} />
              <ul className="flex flex-col gap-0.5 text-sm">
                {Object.entries(outcomes.data?.friction ?? {}).map(([k, v]) => (
                  <li key={k} className="flex justify-between gap-2">
                    <span className="text-muted-foreground">{humanizeLabel(k)}</span>
                    <span className="tabular-nums">{v}×</span>
                  </li>
                ))}
              </ul>
            </ChartCard>

            <ChartCard title="wstack skill runs" className="md:col-span-2">
              {(wstack.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No skill runs recorded in this range.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Skill</TableHead>
                      <TableHead>Runs</TableHead>
                      <TableHead>Outcomes</TableHead>
                      <TableHead>Avg duration</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(wstack.data ?? []).map((r) => (
                      <TableRow key={r.skill}>
                        <TableCell className="font-medium">{r.skill}</TableCell>
                        <TableCell>{r.runs}</TableCell>
                        <TableCell>
                          {Object.entries(r.outcomes)
                            .map(([k, v]) => `${humanizeLabel(k)} ${v}`)
                            .join(', ')}
                        </TableCell>
                        <TableCell>
                          {r.avgDurationS === null ? '—' : `${Math.round(r.avgDurationS)}s`}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </ChartCard>

            <ChartCard
              title="Weekly digest"
              className="md:col-span-2"
              action={
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
                <Alert variant="destructive" className="mb-2">
                  <AlertTitle>Could not generate the digest.</AlertTitle>
                </Alert>
              ) : null}
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">
                {digest.data?.markdown ?? 'No digest yet.'}
              </pre>
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}
