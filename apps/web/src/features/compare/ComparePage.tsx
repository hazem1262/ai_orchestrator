import {
  ApiRequestError,
  type ArchiveLosersResult,
  type CompareGroup,
  type CompareVariantView,
} from '@orc/api-contract';
import { Archive, CircleAlert, GitCompareArrows } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { compareKeys, useCompare, usePickWinner } from '@/api/queries/compare.ts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog.tsx';
import { Badge, type BadgeVariant } from '@/components/ui/badge.tsx';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardHeader } from '@/components/ui/card.tsx';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';
import { streamHref } from '@/features/streams/stages.ts';
import { formatCost } from '@/lib/format.ts';
import { useTerminalStore } from '@/stores/terminals.ts';
import { CompareVariantCard } from './CompareVariantCard.tsx';
import { metricMax, variantHighlights } from './compare-model.ts';

const shortLabel = (label: string) => label.split(' ')[0] ?? label;

const ARCHIVE_SUMMARY =
  'Stop the other sessions and archive their worktrees? Worktrees with uncommitted changes are kept, and every branch stays.';

const STATE_BADGE: Record<CompareGroup['state'], BadgeVariant> = {
  running: 'default',
  decided: 'success',
  archived: 'secondary',
};

function CompareBreadcrumb({ ticket }: { ticket?: string | null }) {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href="/live">Live</BreadcrumbLink>
        </BreadcrumbItem>
        {ticket ? (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href={streamHref(ticket)}>{ticket}</BreadcrumbLink>
            </BreadcrumbItem>
          </>
        ) : null}
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>Compare</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function CompareSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <CompareBreadcrumb />
      <div className="flex flex-col gap-2" role="status" aria-busy="true" aria-label="Loading comparison">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Skeleton className="h-20" />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-3">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="flex flex-col gap-3 p-3">
            <Skeleton className="h-5 w-1/2" />
            {[0, 1, 2, 3].map((k) => (
              <Skeleton key={k} className="h-6" />
            ))}
          </Card>
        ))}
      </div>
    </div>
  );
}

/**
 * `confirm` answers the archive prompt synchronously (tests pass one); without it the page asks
 * in an AlertDialog that lists the worktrees to archive. Picking a winner always asks first, in
 * its own AlertDialog.
 */
export function ComparePage({
  groupId,
  navigate,
  confirm,
}: {
  groupId: string;
  navigate(url: string): void;
  confirm?: (message: string) => boolean;
}) {
  const { data, isLoading, isFetching, error, refetch } = useCompare(groupId);
  const pick = usePickWinner(groupId);
  // The client always sends `confirm: true`; the dialog below is the confirmation step.
  const archive = useConfirmedMutation<void, ArchiveLosersResult>(
    () => getApiClient().compareArchiveLosers(groupId),
    { invalidate: [compareKeys.group(groupId)] },
  );
  const openTerminal = useTerminalStore((s) => s.open);
  const [picking, setPicking] = useState<CompareVariantView | null>(null);
  const [archiving, setArchiving] = useState(false);

  if (isLoading) return <CompareSkeleton />;

  if (error) {
    const notFound = error instanceof ApiRequestError && error.status === 404;
    if (notFound) {
      return (
        <div className="flex min-w-0 flex-col gap-4 p-4">
          <CompareBreadcrumb />
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GitCompareArrows />
              </EmptyMedia>
              <EmptyTitle>Comparison not found</EmptyTitle>
              <EmptyDescription>
                There is no compare group “{groupId}”. Start one from the launch dialog with “Compare agents”.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" asChild>
                <a href="/live">Go to Live</a>
              </Button>
            </EmptyContent>
          </Empty>
        </div>
      );
    }
    return (
      <div className="flex min-w-0 flex-col gap-4 p-4">
        <CompareBreadcrumb />
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Could not load this comparison</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
        <Button variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!data) return null;

  const { group, variants } = data;
  const h = variantHighlights(variants);
  const max = metricMax(variants);
  const losers = variants.filter((v) => v.index !== group.winnerIndex);
  const labelOf = (index: number) => {
    const v = variants.find((x) => x.index === index);
    return v ? shortLabel(v.label) : `v${index + 1}`;
  };

  const onPick = (v: CompareVariantView) =>
    pick.mutate(v.index, { onSuccess: (res) => navigate(res.reviewUrl) });

  const onArchiveClick = () => {
    if (confirm) {
      const paths = losers.map((v) => v.worktreePath ?? v.label);
      if (confirm(`${ARCHIVE_SUMMARY}\n\n${paths.join('\n')}`)) void archive.runConfirmed(undefined);
      return;
    }
    setArchiving(true);
  };

  const actionError = pick.error ?? archive.error;

  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <CompareBreadcrumb ticket={group.ticket} />
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">Compare</h1>
        {group.ticket ? <Badge variant="outline">{group.ticket}</Badge> : null}
        <Badge variant={STATE_BADGE[group.state]}>{group.state}</Badge>
        {group.estimateUsd !== null ? (
          <span className="text-xs text-muted-foreground">estimated {formatCost(group.estimateUsd)}</span>
        ) : null}
        {group.state === 'decided' ? (
          <Button
            className="sm:ml-auto"
            variant="outline"
            size="sm"
            onClick={onArchiveClick}
            disabled={archive.busy}
          >
            <Archive />
            Archive the other variants
          </Button>
        ) : null}
      </header>

      <Card>
        <CardHeader className="gap-1">
          <p className="text-xs font-medium text-muted-foreground">Prompt given to every agent</p>
        </CardHeader>
        <CardContent>
          <p className="whitespace-pre-wrap break-words text-sm">{group.prompt}</p>
        </CardContent>
      </Card>

      {actionError ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>{actionError.message}</AlertTitle>
        </Alert>
      ) : null}

      {archive.data ? (
        <ul className="text-sm" aria-label="Archive results">
          {archive.data.results.map((r) => (
            <li key={r.index} className="break-words">
              {labelOf(r.index)}: {r.archived ? 'archived' : `kept — ${r.reason ?? 'unknown reason'}`}
              {r.killed ? ' (session stopped)' : ''}
            </li>
          ))}
        </ul>
      ) : null}

      {variants.length === 0 ? (
        <p className="text-sm text-muted-foreground">No variants in this comparison.</p>
      ) : null}

      <section
        aria-label="Variants"
        className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-3"
      >
        {variants.map((v) => (
          <CompareVariantCard
            key={v.index}
            variant={v}
            won={group.winnerIndex === v.index}
            archived={group.state === 'archived'}
            pickPending={pick.isPending}
            highlights={h}
            max={max}
            onOpenTerminal={(ptyId, label) => openTerminal(ptyId, label)}
            onRequestPick={setPicking}
          />
        ))}
      </section>

      <AlertDialog
        open={picking !== null}
        onOpenChange={(open) => {
          if (!open) setPicking(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Pick {picking ? shortLabel(picking.label) : ''} as the winner?
            </AlertDialogTitle>
            <AlertDialogDescription>
              You'll go to its review. The other variants keep running until you archive them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (picking) onPick(picking);
              }}
            >
              Pick winner
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={archiving} onOpenChange={setArchiving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive the other variants</AlertDialogTitle>
            <AlertDialogDescription>{ARCHIVE_SUMMARY}</AlertDialogDescription>
          </AlertDialogHeader>
          <ul
            aria-label="Files"
            className="flex max-h-48 flex-col gap-1 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-xs"
          >
            {losers.map((v) => (
              <li key={v.index} className="break-all">
                {v.worktreePath ?? v.label}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={archive.busy}
              onClick={() => void archive.runConfirmed(undefined)}
            >
              Stop and archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
