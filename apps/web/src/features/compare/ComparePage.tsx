import type { ArchiveLosersResult, CompareVariantView } from '@orc/api-contract';
import { useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { compareKeys, useCompare, usePickWinner } from '@/api/queries/compare.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog.tsx';
import { type ConfirmRequest, useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';
import { formatCost, formatDuration } from '@/lib/format.ts';
import { useTerminalStore } from '@/stores/terminals.ts';
import { variantHighlights } from './compare-model.ts';

const shortLabel = (label: string) => label.split(' ')[0] ?? label;

const ARCHIVE_SUMMARY =
  'Stop the other sessions and archive their worktrees? Worktrees with uncommitted changes are kept, and every branch stays.';

/**
 * `confirm` answers the archive prompt synchronously (tests pass one); without it the page asks
 * in an in-app dialog that lists the worktrees to archive.
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
  const { data, isLoading, error } = useCompare(groupId);
  const pick = usePickWinner(groupId);
  // The client always sends `confirm: true`; the prompt below is the confirmation step.
  const archive = useConfirmedMutation<void, ArchiveLosersResult>(
    () => getApiClient().compareArchiveLosers(groupId),
    { invalidate: [compareKeys.group(groupId)] },
  );
  const openTerminal = useTerminalStore((s) => s.open);
  const [asking, setAsking] = useState<ConfirmRequest<void> | null>(null);

  if (isLoading) return <p className="p-4 text-sm text-muted-foreground">Loading comparison…</p>;
  if (error || !data) {
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        Could not load this comparison{error ? `: ${error.message}` : '.'}
      </p>
    );
  }
  const { group, variants } = data;
  const h = variantHighlights(variants);
  const losers = variants.filter((v) => v.index !== group.winnerIndex);
  const labelOf = (index: number) => {
    const v = variants.find((x) => x.index === index);
    return v ? shortLabel(v.label) : `v${index + 1}`;
  };

  const onPick = (v: CompareVariantView) =>
    pick.mutate(v.index, { onSuccess: (res) => navigate(res.reviewUrl) });

  const onArchive = () => {
    const paths = losers.map((v) => v.worktreePath ?? v.label);
    if (!confirm) {
      setAsking({ summary: ARCHIVE_SUMMARY, details: { files: paths }, vars: undefined });
      return;
    }
    if (confirm(`${ARCHIVE_SUMMARY}\n\n${paths.join('\n')}`)) void archive.runConfirmed(undefined);
  };

  const actionError = pick.error ?? archive.error;
  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">Compare</h1>
        {group.ticket ? <Badge variant="outline">{group.ticket}</Badge> : null}
        <Badge variant={group.state === 'running' ? 'default' : 'secondary'}>{group.state}</Badge>
        {group.estimateUsd !== null ? (
          <span className="text-xs text-muted-foreground">estimated {formatCost(group.estimateUsd)}</span>
        ) : null}
        {group.state === 'decided' ? (
          <Button className="sm:ml-auto" variant="outline" onClick={onArchive} disabled={archive.busy}>
            Archive the other variants
          </Button>
        ) : null}
      </header>
      <p className="whitespace-pre-wrap break-words text-sm">{group.prompt}</p>
      <GitConfirmDialog
        request={asking}
        busy={archive.busy}
        title="Archive the other variants"
        confirmLabel="Stop and archive"
        danger
        onConfirm={() => {
          setAsking(null);
          void archive.runConfirmed(undefined);
        }}
        onCancel={() => setAsking(null)}
      />
      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError.message}
        </p>
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
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-3">
        {variants.map((v) => (
          <Card
            key={v.index}
            className={`flex min-w-0 flex-col gap-2 p-3 ${group.winnerIndex === v.index ? 'ring-2 ring-primary' : ''}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 break-all font-medium">{v.label}</span>
              <Badge variant={v.error ? 'destructive' : 'secondary'}>{v.status}</Badge>
              {group.winnerIndex === v.index ? <Badge variant="success">Winner</Badge> : null}
            </div>
            <div className="flex flex-wrap gap-1">
              {h.cheapest === v.index ? <Badge variant="outline">Cheapest</Badge> : null}
              {h.greenTests.includes(v.index) ? <Badge variant="success">Tests green</Badge> : null}
              {h.smallestDiff === v.index ? <Badge variant="outline">Smallest diff</Badge> : null}
            </div>
            {v.error ? <p className="text-xs text-destructive">{v.error}</p> : null}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs">
              <dt className="text-muted-foreground">Branch</dt>
              <dd className="truncate" title={v.branch ?? undefined}>
                {v.branch ?? '—'}
              </dd>
              <dt className="text-muted-foreground">Cost</dt>
              <dd>{formatCost(v.costUsd)}</dd>
              <dt className="text-muted-foreground">Duration</dt>
              <dd>{formatDuration(v.durationMs)}</dd>
              <dt className="text-muted-foreground">Tests</dt>
              <dd>{v.tests ? `${v.tests.passed} passed · ${v.tests.failed} failed` : '—'}</dd>
              <dt className="text-muted-foreground">Diff</dt>
              <dd>{v.diff ? `+${v.diff.insertions} −${v.diff.deletions} in ${v.diff.files} files` : '—'}</dd>
            </dl>
            {v.recap ? <p className="whitespace-pre-wrap break-words text-xs">{v.recap}</p> : null}
            <div className="mt-auto flex flex-wrap gap-2 pt-1">
              {v.ptyId ? (
                <Button size="sm" variant="ghost" onClick={() => openTerminal(v.ptyId ?? '', v.label)}>
                  Terminal
                </Button>
              ) : null}
              <Button
                size="sm"
                aria-label={`Pick ${v.label}`}
                disabled={group.state === 'archived' || !v.sessionId || v.error !== null || pick.isPending}
                onClick={() => onPick(v)}
              >
                Pick as winner
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
