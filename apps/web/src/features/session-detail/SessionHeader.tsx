import type { Session } from '@orc/core';
import type { ReactNode } from 'react';
import { Badge, type BadgeVariant } from '@/components/ui/badge.tsx';
import { RestoreButton } from '@/features/archive/RestoreButton.tsx';
import { formatCost, formatDateTime, formatDuration, formatTokens, shortenPath } from '@/lib/format.ts';

const AVAILABILITY_VARIANT: Record<Session['availability'], BadgeVariant> = {
  resumable: 'success',
  archived: 'warning',
  'prompts-only': 'outline',
  remote: 'secondary',
};

export function SessionHeader({ session, actions }: { session: Session; actions?: ReactNode }) {
  const title = session.name ?? session.firstPrompt ?? session.id;
  const drift = session.cwds.filter((c) => c !== session.startCwd);
  const duration = Date.parse(session.lastActivityAt) - Date.parse(session.startedAt);
  const u = session.usage;
  const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
  return (
    <header className="flex flex-col gap-3 border-b pb-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold" title={title}>
            {title}
          </h1>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge variant="secondary">{session.source}</Badge>
            <Badge variant={AVAILABILITY_VARIANT[session.availability]}>{session.availability}</Badge>
            {session.permissionMode ? <Badge variant="outline">{session.permissionMode}</Badge> : null}
            {session.flags.touchedProd ? <Badge variant="destructive">prod</Badge> : null}
            {session.live ? (
              <Badge variant={session.live.status === 'ended' ? 'outline' : 'warning'}>
                {session.live.ownership === 'owned' ? 'open in app' : session.live.status}
              </Badge>
            ) : null}
            {session.availability === 'archived' ? (
              <RestoreButton source={session.source} id={session.id} />
            ) : null}
          </div>
        </div>
        {actions}
      </div>
      <dl className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Started</dt>
        <dd>{formatDateTime(session.startedAt)}</dd>
        <dt className="text-muted-foreground">Last activity</dt>
        <dd>{formatDateTime(session.lastActivityAt)}</dd>
        <dt className="text-muted-foreground">Duration</dt>
        <dd>{formatDuration(duration)}</dd>
        <dt className="text-muted-foreground">Models</dt>
        <dd>{session.models.join(', ') || '—'}</dd>
        <dt className="text-muted-foreground">Directory</dt>
        <dd title={session.startCwd} className="font-mono text-xs">
          {shortenPath(session.startCwd)}{' '}
          {drift.length > 0 ? (
            <span title={drift.join('\n')} className="text-warning">
              (+{drift.length} drift)
            </span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">Cost</dt>
        <dd>
          {formatCost(u.costUsd)} · {formatTokens(tokens)} tokens
        </dd>
        <dt className="text-muted-foreground">Lines</dt>
        <dd>
          {session.linesAdded === null ? '—' : `+${session.linesAdded} / −${session.linesRemoved ?? 0}`}
        </dd>
        <dt className="text-muted-foreground">Last test</dt>
        <dd>{session.lastTest ? `✓ ${session.lastTest.passed} · ✗ ${session.lastTest.failed}` : '—'}</dd>
      </dl>
      <div className="flex flex-wrap gap-1">
        {session.tickets.map((t) => (
          <Badge key={t} variant="outline">
            {t}
          </Badge>
        ))}
        {session.prs.map((pr) => (
          <a
            key={pr.url}
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-primary underline"
            title={pr.repo}
          >
            #{pr.number}
          </a>
        ))}
        {session.skills.map((s) => (
          <Badge key={s} variant="secondary">
            /{s}
          </Badge>
        ))}
      </div>
    </header>
  );
}
