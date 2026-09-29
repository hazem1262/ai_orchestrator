import type { CompareVariantView } from '@orc/api-contract';
import { GitBranch, SquareTerminal, Trophy } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card.tsx';
import { formatCost, formatDuration } from '@/lib/format.ts';
import { diffSize, type Highlights, type MetricMax, metricPct } from './compare-model.ts';

/** One metric row: a label/value line over a bar scaled to the largest value in the group. */
function Metric({ label, value, pct }: { label: string; value: ReactNode; pct: number }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="font-mono text-xs tabular-nums">{value}</dd>
      </div>
      <div aria-hidden className="h-1 rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary/60"
          style={{ width: `${Math.max(4, Math.round((Number.isFinite(pct) ? pct : 0) * 100))}%` }}
        />
      </div>
    </div>
  );
}

/**
 * A single variant's card in the Compare grid. Every card lists the same metrics in the same
 * order — Cost, Duration, Diff, Tests, Branch — each with a bar scaled to `max` so a row reads
 * across the cards, per the Calm Compare spike.
 */
export function CompareVariantCard({
  variant: v,
  won,
  archived,
  pickPending,
  highlights: h,
  max,
  onOpenTerminal,
  onRequestPick,
}: {
  variant: CompareVariantView;
  won: boolean;
  archived: boolean;
  pickPending: boolean;
  highlights: Highlights;
  max: MetricMax;
  onOpenTerminal: (ptyId: string, label: string) => void;
  onRequestPick: (v: CompareVariantView) => void;
}) {
  return (
    <Card aria-label={v.label} className={`flex min-w-0 flex-col gap-2 ${won ? 'ring-2 ring-primary' : ''}`}>
      <CardHeader className="gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 break-all font-medium">{v.label}</span>
          {won ? (
            <Badge variant="success" className="ml-auto">
              Winner
            </Badge>
          ) : (
            <Badge variant={v.error ? 'destructive' : 'secondary'} className="ml-auto">
              {v.error ? 'failed' : v.status}
            </Badge>
          )}
        </div>
        <div className="flex min-h-5 flex-wrap gap-1">
          {h.cheapest === v.index ? <Badge variant="outline">Cheapest</Badge> : null}
          {h.greenTests.includes(v.index) ? <Badge variant="success">Tests green</Badge> : null}
          {h.smallestDiff === v.index ? <Badge variant="outline">Smallest diff</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {v.error ? <p className="text-xs text-destructive">{v.error}</p> : null}
        <dl className="flex flex-col gap-2 text-xs">
          <Metric label="Cost" value={formatCost(v.costUsd)} pct={metricPct(v.costUsd ?? 0, max.cost)} />
          <Metric
            label="Duration"
            value={formatDuration(v.durationMs)}
            pct={metricPct(v.durationMs ?? 0, max.duration)}
          />
          <Metric
            label="Diff"
            value={v.diff ? `+${v.diff.insertions} −${v.diff.deletions} in ${v.diff.files} files` : '—'}
            pct={metricPct(diffSize(v), max.diff)}
          />
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">Tests</dt>
            <dd className="font-mono">
              {v.tests ? `${v.tests.passed} passed · ${v.tests.failed} failed` : '—'}
            </dd>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <dt className="text-muted-foreground">Branch</dt>
            <dd className="flex min-w-0 items-center gap-1" title={v.branch ?? undefined}>
              <GitBranch className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{v.branch ?? '—'}</span>
            </dd>
          </div>
        </dl>
        {v.recap ? (
          <p className="whitespace-pre-wrap break-words border-t pt-2 text-xs text-muted-foreground">
            {v.recap}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="flex-wrap gap-1.5">
        {v.ptyId ? (
          <Button size="sm" variant="ghost" onClick={() => onOpenTerminal(v.ptyId ?? '', v.label)}>
            <SquareTerminal />
            Terminal
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={won ? 'secondary' : 'default'}
          className="ml-auto"
          aria-label={`Pick ${v.label}`}
          disabled={won || archived || !v.sessionId || v.error !== null || pickPending}
          onClick={() => onRequestPick(v)}
        >
          <Trophy />
          {won ? 'Picked' : 'Pick as winner'}
        </Button>
      </CardFooter>
    </Card>
  );
}
