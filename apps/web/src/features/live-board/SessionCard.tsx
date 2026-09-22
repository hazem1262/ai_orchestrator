import type { Session, Source } from '@orc/core';
import { Link } from '@tanstack/react-router';
import { useKill } from '@/api/queries/launch.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/components/ui/cn.ts';
import { formatCost } from '@/lib/format.ts';
import { useTerminalStore } from '@/stores/terminals.ts';
import { OpenInButton } from './OpenInButton.tsx';
import { StageBar } from './StageBar.tsx';
import {
  formatDuration,
  hasDrift,
  isAttention,
  permissionBadge,
  resumeCommand,
  STATUS_LABEL,
  shortPath,
} from './sort.ts';
import { TestChip } from './TestChip.tsx';

const SOURCE_LABEL: Record<Source, string> = { claude: 'Claude', codex: 'Codex', agnc: 'AGNC' };

export interface SessionCardProps {
  session: Session;
  now: number;
  compact?: boolean;
  pinned: boolean;
  onTogglePin: () => void;
}

export function SessionCard({ session: s, now, compact = false, pinned, onTogglePin }: SessionCardProps) {
  const kill = useKill();
  const openTerminal = useTerminalStore((t) => t.open);
  const live = s.live;
  if (!live) return null;

  const attention = isAttention(live.status);
  const title = s.name ?? s.id;
  const cwd = s.cwds.at(-1) ?? s.startCwd;
  const perm = permissionBadge(s.permissionMode);
  const ptyId = live.ptyId;

  const onStop = () => {
    if (window.confirm(`Stop "${title}" (pid ${live.pid ?? '?'}) in ${cwd}?`)) {
      kill.mutate({ source: s.source, id: s.id });
    }
  };

  return (
    <article
      aria-label={`${title} — ${STATUS_LABEL[live.status]}`}
      data-status={live.status}
      data-attention={attention ? 'true' : 'false'}
      className={cn('flex flex-col gap-1.5 rounded-lg border p-3', attention && 'border-warning shadow-sm')}
    >
      <header className="flex items-center gap-2">
        <Badge variant="outline">{SOURCE_LABEL[s.source]}</Badge>
        <Link
          to="/sessions/$source/$id"
          params={{ source: s.source, id: s.id }}
          className="min-w-0 flex-1 truncate font-medium hover:underline"
          title={title}
        >
          {title}
        </Link>
        <Badge
          variant={attention ? 'warning' : 'secondary'}
          className={attention ? 'animate-pulse' : undefined}
        >
          {STATUS_LABEL[live.status]}
        </Badge>
        <span className="text-xs tabular-nums text-muted-foreground" title={live.since}>
          {formatDuration(now - Date.parse(live.since))}
        </span>
      </header>

      {live.waitingFor ? <p className="text-sm text-foreground">{live.waitingFor}</p> : null}

      <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground" title={cwd}>
        <span className="truncate">{shortPath(cwd)}</span>
        {hasDrift(s) ? (
          <span role="img" aria-label="cwd drift" title={`moved from ${s.startCwd}`}>
            ↪
          </span>
        ) : null}
      </p>

      {compact ? null : (
        <>
          {live.currentTool ? (
            <p className="text-xs">
              <span className="text-muted-foreground">tool </span>
              <code>{live.currentTool}</code>
            </p>
          ) : null}
          {s.lastPrompt ? <p className="line-clamp-2 text-sm">{s.lastPrompt}</p> : null}
          {s.tickets.length > 0 || s.prs.length > 0 ? (
            <div className="flex flex-wrap gap-1 text-xs">
              {s.tickets.map((t) => (
                <Badge key={t} variant="outline">
                  {t}
                </Badge>
              ))}
              {s.prs.map((p) => (
                <a
                  key={p.url}
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border px-1.5 hover:bg-muted"
                >
                  {`#${p.number}`}
                </a>
              ))}
            </div>
          ) : null}
          <StageBar stage={live.stage} />
        </>
      )}

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {s.usage.costUsd === null ? null : <span>{formatCost(s.usage.costUsd)}</span>}
        {live.contextFill === null ? null : <span>{`ctx ${Math.round(live.contextFill * 100)}%`}</span>}
        <TestChip result={s.lastTest} />
        {live.backgroundJobs > 0 ? <Badge variant="secondary">{`${live.backgroundJobs} jobs`}</Badge> : null}
        {perm ? <Badge variant={perm === 'bypass' ? 'destructive' : 'outline'}>{perm}</Badge> : null}
        {live.runningSubagents > 0 ? (
          <Badge variant="secondary">{`${live.runningSubagents} agents`}</Badge>
        ) : null}
      </div>

      <footer className="flex flex-wrap items-center gap-1 pt-1">
        {live.ownership === 'owned' && ptyId ? (
          <Button size="sm" onClick={() => openTerminal(ptyId, title)}>
            Terminal
          </Button>
        ) : null}
        <Link
          to="/sessions/$source/$id"
          params={{ source: s.source, id: s.id }}
          className="px-2 text-xs underline"
        >
          Details
        </Link>
        <Button size="sm" variant="ghost" disabled title="Available in Phase 4">
          Diff
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void navigator.clipboard?.writeText(resumeCommand(s))}
        >
          Copy resume
        </Button>
        <OpenInButton session={s} />
        <Button size="sm" variant="ghost" onClick={onTogglePin}>
          {pinned ? 'Unpin' : 'Pin'}
        </Button>
        {live.status === 'ended' ? null : (
          <Button size="sm" variant="destructive" onClick={onStop}>
            Stop
          </Button>
        )}
      </footer>
    </article>
  );
}
