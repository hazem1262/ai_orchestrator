import type { LiveStatus, Session } from '@orc/core';
import { Hand } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSessionRecap } from '@/api/queries/work.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Card, CardContent } from '@/components/ui/card.tsx';
import { cn } from '@/components/ui/cn.ts';
import { RestoreButton } from '@/features/archive/RestoreButton.tsx';
import { ContextFillBadge } from '@/features/limits/ContextFillBadge.tsx';
import { StageBar } from '@/features/live-board/StageBar.tsx';
import { ReplyComposer } from '@/features/mobile/ReplyComposer.tsx';
import { useIsMobile } from '@/features/mobile/useIsMobile.ts';
import { SupervisorToggle } from '@/features/supervisor/SupervisorToggle.tsx';
import { formatCost, formatDateTime, formatDuration, formatTokens, shortenPath } from '@/lib/format.ts';
import { isRemoteSession } from '@/lib/source.ts';
import { SafetyBadges } from './SafetyBadges.tsx';

const SOFT = {
  neutral: 'border-transparent bg-secondary text-secondary-foreground',
  info: 'border-transparent bg-info/15 text-info',
  success: 'border-transparent bg-success/15 text-success',
  warning: 'border-transparent bg-warning/15 text-warning',
  danger: 'border-transparent bg-destructive/15 text-destructive',
} as const;

const AVAILABILITY_TONE: Record<Session['availability'], keyof typeof SOFT> = {
  resumable: 'success',
  archived: 'warning',
  'prompts-only': 'neutral',
  remote: 'info',
};

const LIVE_TONE: Record<LiveStatus, keyof typeof SOFT> = {
  busy: 'info',
  idle: 'neutral',
  waiting: 'warning',
  shell: 'neutral',
  review: 'success',
  blocked: 'danger',
  error: 'danger',
  ended: 'neutral',
};

export function SessionHeader({ session, actions }: { session: Session; actions?: ReactNode }) {
  const title = session.name ?? session.firstPrompt ?? session.id;
  const isMobile = useIsMobile();
  const remote = isRemoteSession(session);
  const live = session.live;
  return (
    <>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <h1
            className="min-w-0 flex-1 basis-64 text-xl font-semibold tracking-tight break-words line-clamp-2 md:text-2xl"
            title={title}
          >
            {title}
          </h1>
          {actions ? <div className="ml-auto shrink-0">{actions}</div> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-mono">
            {session.source}
          </Badge>
          {live ? (
            <Badge variant="outline" className={SOFT[LIVE_TONE[live.status]]}>
              {live.ownership === 'owned' ? 'open in app' : live.status}
            </Badge>
          ) : null}
          <Badge variant="outline" className={SOFT[AVAILABILITY_TONE[session.availability]]}>
            {session.availability}
          </Badge>
          <SafetyBadges source={session.source} id={session.id} />
          {session.flags.touchedProd ? (
            <Badge variant="outline" className={SOFT.danger}>
              prod
            </Badge>
          ) : null}
          <ContextFillBadge source={session.source} id={session.id} />
          {session.tickets.map((t) => (
            <Badge key={t} variant="outline" className="font-mono">
              {t}
            </Badge>
          ))}
          {session.prs.map((pr) => (
            <Badge key={pr.url} variant="outline" className="font-mono" asChild>
              <a href={pr.url} target="_blank" rel="noreferrer" title={pr.repo}>
                #{pr.number}
              </a>
            </Badge>
          ))}
          {session.skills.map((s) => (
            <Badge key={s} variant="secondary" className="font-mono">
              /{s}
            </Badge>
          ))}
          <SupervisorToggle session={session} />
          {session.availability === 'archived' ? (
            <RestoreButton source={session.source} id={session.id} />
          ) : null}
        </div>
      </header>
      {isMobile && !remote ? <ReplyComposer session={session} /> : null}
      <SessionSummary session={session} />
    </>
  );
}

/** Recap or "waiting for" line, the stage bar, and the facts strip. */
function SessionSummary({ session }: { session: Session }) {
  const recap =
    useSessionRecap(session.source, session.id).data?.text ?? session.recap ?? session.awaySummary;
  const live = session.live;
  const drift = session.cwds.filter((c) => c !== session.startCwd);
  const duration = Date.parse(session.lastActivityAt) - Date.parse(session.startedAt);
  const u = session.usage;
  const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
  const running = live !== null && live.status !== 'ended';
  const waitingFor = running ? live.waitingFor : null;

  return (
    <Card className="gap-3 py-3">
      <CardContent className="flex flex-col gap-3 px-3">
        {waitingFor || recap || running ? (
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_16rem] md:items-center">
            {waitingFor ? (
              <p
                className={cn(
                  'flex items-start gap-2 rounded-md px-2.5 py-2 text-sm font-medium',
                  SOFT[LIVE_TONE[live?.status ?? 'waiting']],
                )}
              >
                <Hand className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="min-w-0 break-words">Waiting for: {waitingFor}</span>
              </p>
            ) : recap ? (
              <p className="line-clamp-3 text-sm break-words text-muted-foreground" title={recap}>
                <span className="font-medium text-foreground">Recap · </span>
                {recap}
              </p>
            ) : (
              <span />
            )}
            {running ? (
              <div className="flex flex-col gap-1">
                <StageBar stage={live.stage} />
                <p className="text-right font-mono text-xs text-muted-foreground tabular-nums">
                  in state {formatDuration(Date.now() - Date.parse(live.since))}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
        <dl
          className={cn(
            'grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4',
            (waitingFor || recap || running) && 'border-t pt-3',
          )}
        >
          <Fact label="Started">{formatDateTime(session.startedAt)}</Fact>
          <Fact label="Last activity">{formatDateTime(session.lastActivityAt)}</Fact>
          <Fact label="Duration" mono>
            {formatDuration(duration)}
          </Fact>
          <Fact label="Cost" mono>
            {formatCost(u.costUsd)} · {formatTokens(tokens)} tokens
          </Fact>
          <Fact label="Lines" mono>
            {session.linesAdded === null ? (
              '—'
            ) : (
              <>
                <span className="text-success">+{session.linesAdded}</span>
                {' / '}
                <span className="text-destructive">−{session.linesRemoved ?? 0}</span>
              </>
            )}
          </Fact>
          <Fact label="Last test" mono>
            {session.lastTest ? `✓ ${session.lastTest.passed} · ✗ ${session.lastTest.failed}` : '—'}
          </Fact>
          <Fact label="Models" mono>
            {session.models.join(', ') || '—'}
          </Fact>
          <Fact label="Directory" mono title={session.startCwd}>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{shortenPath(session.startCwd)}</span>
              {drift.length > 0 ? (
                <span title={drift.join('\n')} className={cn('shrink-0 rounded-sm px-1', SOFT.warning)}>
                  (+{drift.length} drift)
                </span>
              ) : null}
            </span>
          </Fact>
        </dl>
      </CardContent>
    </Card>
  );
}

function Fact({
  label,
  children,
  mono,
  title,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('truncate', mono && 'font-mono text-xs leading-5')} title={title}>
        {children}
      </dd>
    </div>
  );
}
