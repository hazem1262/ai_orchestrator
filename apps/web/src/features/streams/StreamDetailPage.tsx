import type { StreamLinkKind, StreamStage } from '@orc/core';
import {
  AlertTriangle,
  Check,
  FileText,
  FolderGit2,
  GitMerge,
  Link2,
  TerminalSquare,
  Waves,
  X,
} from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { useLinkStream, useStream, useUnlinkStream } from '@/api/queries/streams.ts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardTitle } from '@/components/ui/card.tsx';
import { cn } from '@/components/ui/cn.ts';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { GoalEditor } from '@/features/goals/GoalEditor.tsx';
import { formatPctValue, formatUsd } from '@/features/limits/format.ts';
import { LinearIssueChip } from '@/features/linear/LinearIssueChip.tsx';
import {
  cleanTitle,
  formatActivity,
  STAGE_BADGE_VARIANT,
  STAGE_LABELS,
  STAGE_ORDER,
  sessionHref,
  stageIndex,
} from './stages.ts';

const LINK_KINDS: StreamLinkKind[] = ['session', 'pr', 'plan', 'worktree', 'workflow'];
const REVIEW_LABEL: Record<string, string> = {
  approved: 'approved',
  changes_requested: 'changes requested',
  review_required: 'review required',
  none: 'no review',
};

function StreamCrumbs({ ticket }: { ticket: string }) {
  return (
    <Breadcrumb>
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem className="shrink-0">
          <BreadcrumbLink asChild>
            <a href="/streams">Streams</a>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="truncate">{ticket}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/** Seven-step stepper: done steps get a check, the current step is solid. */
function StageStepper({ stage }: { stage: StreamStage }) {
  const current = stageIndex(stage);
  return (
    <ol aria-label="Stage" className="flex w-full items-center gap-1">
      {STAGE_ORDER.map((s, i) => {
        const done = i < current;
        const now = i === current;
        return (
          <li
            key={s}
            aria-current={now ? 'step' : undefined}
            className="flex min-w-0 flex-1 items-center gap-1.5"
          >
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.625rem] font-semibold',
                done && 'border-primary/40 bg-primary/15 text-primary',
                now && 'border-primary bg-primary text-primary-foreground',
                !done && !now && 'text-muted-foreground',
              )}
            >
              {done ? <Check className="size-3" aria-hidden /> : i + 1}
            </span>
            <span
              className={cn(
                'truncate text-xs',
                now ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {STAGE_LABELS[s]}
            </span>
            {i < STAGE_ORDER.length - 1 ? (
              <span aria-hidden className={cn('h-px min-w-2 flex-1', done ? 'bg-primary/40' : 'bg-border')} />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function BudgetBar({ budget }: { budget: { ok: boolean; pct: number; limitUsd: number } }) {
  const pct = Math.min(100, Math.round(budget.pct * 100));
  return (
    <span
      role="progressbar"
      aria-label="Budget"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="block h-1.5 w-full overflow-hidden rounded bg-muted"
    >
      <span
        className={cn('block h-full', budget.ok ? 'bg-success' : 'bg-destructive')}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

function LinkForm({ ticket }: { ticket: string }) {
  const id = useId();
  const link = useLinkStream(ticket);
  const [kind, setKind] = useState<StreamLinkKind>('session');
  const [ref, setRef] = useState('');

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const value = ref.trim();
    if (value.length === 0) return;
    link.mutate({ kind, ref: value }, { onSuccess: () => setRef('') });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2 border-t pt-3 text-xs">
      <span className="flex flex-col gap-0.5">
        <label htmlFor={`${id}-kind`}>Link kind</label>
        <NativeSelect
          id={`${id}-kind`}
          className="h-7 text-xs"
          value={kind}
          onChange={(e) => setKind(e.target.value as StreamLinkKind)}
        >
          {LINK_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </NativeSelect>
      </span>
      <span className="flex flex-1 flex-col gap-0.5">
        <label htmlFor={`${id}-ref`}>Link reference</label>
        <Input
          id={`${id}-ref`}
          className="h-7 text-xs"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="claude:s-basic, PR url, path…"
        />
      </span>
      <Button type="submit" size="sm" variant="outline" disabled={link.isPending}>
        <Link2 />
        Link
      </Button>
      {link.isError ? (
        <p role="alert" className="w-full text-destructive">
          Could not link {ref.trim()}.
        </p>
      ) : null}
    </form>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <div role="status" aria-label="Loading stream" className="flex flex-col gap-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Card className="flex flex-col gap-3 p-4">
        <Skeleton className="h-5" />
        <Skeleton className="h-2" />
      </Card>
      <div className="grid gap-3 lg:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="flex flex-col gap-2 p-4">
            <Skeleton className="h-4 w-32" />
            {[0, 1, 2].map((k) => (
              <Skeleton key={k} className="h-4" style={{ width: `${80 - k * 15}%` }} />
            ))}
          </Card>
        ))}
      </div>
    </div>
  );
}

export function StreamDetailPage({ ticket }: { ticket: string }) {
  const q = useStream(ticket);
  const unlink = useUnlinkStream(ticket);

  if (q.isLoading) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <StreamCrumbs ticket={ticket} />
        <DetailSkeleton />
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <StreamCrumbs ticket={ticket} />
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle>Could not load {ticket}.</AlertTitle>
          <AlertDescription>
            <Button variant="outline" size="sm" onClick={() => q.refetch()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!q.data) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <StreamCrumbs ticket={ticket} />
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Waves />
            </EmptyMedia>
            <EmptyTitle>No stream for {ticket}</EmptyTitle>
            <EmptyDescription>
              Nothing links to this ticket yet. Mention it in a prompt, branch name or PR title, or link a
              session by hand.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" asChild>
              <a href="/streams">Back to Streams</a>
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  const { stream, prsDetailed, links, timeline, handoff, budget } = q.data;
  const unlinked = links.filter((l) => l.excluded);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-2">
        <StreamCrumbs ticket={stream.ticket} />
        <header className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold">{stream.ticket}</h1>
            <Badge variant={STAGE_BADGE_VARIANT[stream.stage]}>{STAGE_LABELS[stream.stage]}</Badge>
            <LinearIssueChip identifier={stream.ticket} />
          </div>
          <p className="text-muted-foreground">{cleanTitle(stream.title) || 'Untitled stream'}</p>
        </header>
      </div>

      <Card className="flex flex-col gap-3 p-4">
        <StageStepper stage={stream.stage} />
        <div className="grid gap-3 border-t pt-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="flex flex-col gap-1.5">
            <p className="text-sm">
              <strong>{formatUsd(stream.costUsd)}</strong>{' '}
              {budget.limitUsd !== null ? (
                <span className={budget.ok ? 'text-muted-foreground' : 'text-destructive'}>
                  {`${formatPctValue(budget.pct)} of ${formatUsd(budget.limitUsd)}`}
                </span>
              ) : (
                <span className="text-muted-foreground">no budget set</span>
              )}
            </p>
            {budget.limitUsd !== null ? (
              <BudgetBar budget={{ ok: budget.ok, pct: budget.pct, limitUsd: budget.limitUsd }} />
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            last activity {formatActivity(stream.lastActivityAt)}
          </p>
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <section aria-label="Stream goal">
          <Card className="flex flex-col gap-2 p-4">
            <GoalEditor targetType="stream" targetId={stream.ticket} />
          </Card>
        </section>

        <section aria-label="Next steps">
          <Card className="flex flex-col gap-2 p-4">
            <CardTitle>What's next</CardTitle>
            {handoff ? (
              <div className="flex flex-col gap-2 text-sm">
                <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  From the handoff of {handoff.sessionId} <Badge variant="outline">{handoff.status}</Badge>
                </p>
                <ol className="ml-4 list-decimal">
                  {handoff.nextSteps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                {handoff.blockers.length > 0 ? (
                  <p className="flex items-start gap-2 rounded-md bg-warning/15 px-2.5 py-2 font-medium text-warning-foreground">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span className="min-w-0 break-words">Blocked: {handoff.blockers.join('; ')}</span>
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No handoff yet. Open a session and create one to capture the next steps.
              </p>
            )}
          </Card>
        </section>

        <section aria-label="Pull requests">
          <Card className="flex flex-col gap-2 p-4">
            <CardTitle className="flex items-center gap-2">
              Pull requests <Badge variant="secondary">{prsDetailed.length}</Badge>
            </CardTitle>
            <ul className="flex flex-col gap-2 text-sm">
              {prsDetailed.map((p) => (
                <li key={p.pr.url} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <a className="underline" href={p.pr.url} target="_blank" rel="noreferrer">
                      {`#${p.pr.number} ${p.title}`}
                    </a>
                    <Badge variant="outline">{p.state}</Badge>
                    {p.isBackmerge ? (
                      <Badge variant="secondary">
                        <GitMerge />
                        backmerge
                      </Badge>
                    ) : null}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    checks {p.checks} · review {REVIEW_LABEL[p.review] ?? p.review}
                  </span>
                </li>
              ))}
              {prsDetailed.length === 0 ? <li className="text-muted-foreground">No PRs yet.</li> : null}
            </ul>
          </Card>
        </section>

        <section aria-label="Linked work">
          <Card className="flex flex-col gap-2 p-4">
            <CardTitle>Linked work</CardTitle>
            <ul className="flex flex-col gap-1 text-sm">
              {stream.sessionIds.map((pk) => (
                <li key={pk} className="flex min-w-0 items-center gap-2">
                  <TerminalSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <a className="min-w-0 flex-1 truncate underline" href={sessionHref(pk)}>
                    {pk}
                  </a>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Unlink session ${pk}`}
                    disabled={unlink.isPending}
                    onClick={() => unlink.mutate({ kind: 'session', ref: pk })}
                  >
                    <X />
                  </Button>
                </li>
              ))}
              {stream.plans.map((p) => (
                <li key={p} className="flex min-w-0 items-center gap-2 text-muted-foreground">
                  <FileText className="size-4 shrink-0" aria-hidden />
                  <span className="truncate" title={p}>
                    {p}
                  </span>
                </li>
              ))}
              {stream.worktrees.map((w) => (
                <li key={w} className="flex min-w-0 items-center gap-2 text-muted-foreground">
                  <FolderGit2 className="size-4 shrink-0" aria-hidden />
                  <span className="truncate" title={w}>
                    {w}
                  </span>
                </li>
              ))}
            </ul>
            {unlinked.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {unlinked.map((l) => `${l.ref} (unlinked)`).join(', ')}
              </p>
            ) : null}
            <LinkForm ticket={stream.ticket} />
          </Card>
        </section>
      </div>

      <section aria-label="Timeline">
        <Card className="flex flex-col gap-2 p-4">
          <CardTitle>Timeline</CardTitle>
          <ol className="flex flex-col gap-2 text-sm">
            {timeline.map((i) => (
              <li key={`${i.kind}-${i.ref}-${i.ts}`} className="flex flex-col">
                <span className="text-xs text-muted-foreground">
                  {formatActivity(i.ts)} · {i.kind}
                </span>
                <span>{i.title}</span>
                {i.detail ? <span className="text-xs text-muted-foreground">{i.detail}</span> : null}
              </li>
            ))}
            {timeline.length === 0 ? <li className="text-muted-foreground">nothing yet</li> : null}
          </ol>
        </Card>
      </section>
    </div>
  );
}
