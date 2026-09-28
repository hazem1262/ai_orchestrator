import type { Session } from '@orc/core';
import { Link } from '@tanstack/react-router';
import { Bot, CornerDownRight, FolderGit2, Hand, Layers, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge.tsx';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card.tsx';
import { cn } from '@/components/ui/cn.ts';
import { formatCost } from '@/lib/format.ts';
import { PrChip } from './PrChip.tsx';
import { SessionActions } from './SessionActions.tsx';
import { StageBar } from './StageBar.tsx';
import { formatDuration, hasDrift, isAttention, permissionBadge, STATUS_LABEL, shortPath } from './sort.ts';
import { EDGE, SOFT, SourceBadge, STATUS_TONE, StatusBadge } from './status.tsx';
import { TestChip } from './TestChip.tsx';

export interface SessionCardProps {
  session: Session;
  now: number;
  compact?: boolean;
  pinned: boolean;
  onTogglePin: () => void;
}

export function SessionCard({ session: s, now, compact = false, pinned, onTogglePin }: SessionCardProps) {
  const live = s.live;
  if (!live) return null;

  const attention = isAttention(live.status);
  const tone = STATUS_TONE[live.status];
  const title = s.name ?? s.id;
  const cwd = s.cwds.at(-1) ?? s.startCwd;
  const perm = permissionBadge(s.permissionMode);
  const hasChips = s.tickets.length > 0 || s.prs.length > 0 || s.lastTest !== null;

  return (
    <Card
      role="article"
      aria-label={`${title} — ${STATUS_LABEL[live.status]}`}
      data-status={live.status}
      data-attention={attention ? 'true' : 'false'}
      className={cn('relative flex min-w-0 flex-col', attention && EDGE[tone])}
    >
      <CardHeader className={cn('gap-2', compact && 'pb-2')}>
        <div className="flex min-w-0 items-center gap-2">
          <SourceBadge source={s.source} />
          <StatusBadge status={live.status} />
          <span
            className="ml-auto font-mono text-xs tabular-nums text-muted-foreground"
            title={`since ${live.since}`}
          >
            {formatDuration(now - Date.parse(live.since))}
          </span>
        </div>
        <Link
          to="/sessions/$source/$id"
          params={{ source: s.source, id: s.id }}
          className="line-clamp-2 min-w-0 rounded-sm text-base leading-snug font-semibold tracking-tight break-words hover:underline"
          title={title}
        >
          {title}
        </Link>
      </CardHeader>

      <CardContent className={cn('flex flex-1 flex-col gap-3', compact && 'gap-2 pb-3')}>
        {live.waitingFor ? (
          <p
            className={cn(
              'flex items-start gap-2 rounded-md px-2.5 py-2 text-sm font-medium',
              SOFT[tone === 'neutral' || tone === 'info' ? 'warning' : tone],
            )}
          >
            <Hand className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{live.waitingFor}</span>
          </p>
        ) : null}

        <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
          <p className="flex min-w-0 items-center gap-1.5 font-mono" title={cwd}>
            <FolderGit2 className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{shortPath(cwd)}</span>
            {hasDrift(s) ? (
              <span
                role="img"
                aria-label="cwd drift"
                title={`moved from ${s.startCwd}`}
                className="shrink-0 text-warning"
              >
                <CornerDownRight className="size-3.5" aria-hidden />
              </span>
            ) : null}
          </p>
          {!compact && live.currentTool ? (
            <p className="flex items-center gap-1.5">
              <Wrench className="size-3.5 shrink-0" aria-hidden />
              <span>tool</span>
              <code className="rounded-sm bg-muted px-1 font-mono text-foreground">{live.currentTool}</code>
            </p>
          ) : null}
        </div>

        {compact ? null : (
          <>
            {s.lastPrompt ? (
              <p className="line-clamp-2 text-sm break-words text-muted-foreground">{s.lastPrompt}</p>
            ) : null}
            {hasChips ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {s.tickets.map((t) => (
                  <Badge key={t} variant="outline" className="font-mono">
                    {t}
                  </Badge>
                ))}
                {s.prs.map((p) => (
                  <PrChip key={p.url} pr={p} />
                ))}
                <TestChip result={s.lastTest} />
              </div>
            ) : null}
            <StageBar stage={live.stage} />
          </>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
          {s.usage.costUsd === null ? null : (
            <span className="text-foreground">{formatCost(s.usage.costUsd)}</span>
          )}
          {live.contextFill === null ? null : (
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
                <span
                  className={cn(
                    'block h-full rounded-full',
                    live.contextFill > 0.7 ? 'bg-warning' : 'bg-primary/70',
                  )}
                  style={{ width: `${Math.round(live.contextFill * 100)}%` }}
                />
              </span>
              <span>{`ctx ${Math.round(live.contextFill * 100)}%`}</span>
            </span>
          )}
          {compact ? <TestChip result={s.lastTest} /> : null}
          {live.runningSubagents > 0 ? (
            <span className="flex items-center gap-1">
              <Bot className="size-3.5" aria-hidden />
              <span>{`${live.runningSubagents} agents`}</span>
            </span>
          ) : null}
          {live.backgroundJobs > 0 ? (
            <span className="flex items-center gap-1">
              <Layers className="size-3.5" aria-hidden />
              <span>{`${live.backgroundJobs} jobs`}</span>
            </span>
          ) : null}
          {perm ? (
            <Badge variant="secondary" className={perm === 'bypass' ? SOFT.danger : SOFT.neutral}>
              {perm}
            </Badge>
          ) : null}
        </div>
      </CardContent>

      <CardFooter className="px-4 py-2.5">
        <SessionActions session={s} pinned={pinned} onTogglePin={onTogglePin} />
      </CardFooter>
    </Card>
  );
}
