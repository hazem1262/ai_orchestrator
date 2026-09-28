import type { Source } from '@orc/core';
import { Link } from '@tanstack/react-router';
import { FileDiff as FileDiffIcon, RotateCw } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { useCheckpointDiff, useDiff, useReview } from '@/api/queries/review.ts';
import { useSession } from '@/api/queries/sessions.ts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog.tsx';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';
import { ReadOnlyDiff } from '@/features/mobile/ReadOnlyDiff.tsx';
import { useIsMobile } from '@/features/mobile/useIsMobile.ts';
import { CommentsPanel } from './CommentsPanel.tsx';
import { FileDiff } from './FileDiff.tsx';
import { FileTree } from './FileTree.tsx';
import { ReviewCrumbs } from './ReviewCrumbs.tsx';
import { useReviewDraft } from './useReviewDraft.ts';

export type DiffSourceSel = { kind: 'worktree' } | { kind: 'checkpoint'; id: string };

type RevertVars = { cwd: string; file: string; hunkIndex?: number };

/** Session title for the breadcrumb and header; falls back to the id while it loads or on error. */
function useSessionTitle(source: Source, id: string): string {
  const session = useSession(source, id);
  return session.data?.name ?? session.data?.firstPrompt ?? `${source}:${id}`;
}

export function ReviewPage({
  source,
  id,
  aside,
}: {
  source: Source;
  id: string;
  aside?: (ctx: { cwd: string; select: (s: DiffSourceSel) => void; selected: DiffSourceSel }) => ReactNode;
}) {
  const review = useReview(source, id);
  const sessionTitle = useSessionTitle(source, id);
  const [sel, setSel] = useState<DiffSourceSel>({ kind: 'worktree' });
  const cwd = review.data?.cwd ?? null;
  const live = useDiff(sel.kind === 'worktree' ? cwd : null);
  const turn = useCheckpointDiff(sel.kind === 'checkpoint' ? sel.id : null);
  const diff = sel.kind === 'worktree' ? live : turn;
  const draft = useReviewDraft(`${source}:${id}`);
  const [mode, setMode] = useState<'split' | 'unified'>('split');
  const [selected, setSelected] = useState<string | null>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    const files = diff.data?.files ?? [];
    if (files.length && !files.some((f) => f.path === selected)) setSelected(files[0]?.path ?? null);
  }, [diff.data, selected]);

  const revert = useConfirmedMutation(
    (v: RevertVars, confirm: boolean) => getApiClient().diffRevert({ ...v, confirm }),
    { invalidate: [['diff'], ['review']] },
  );

  if (review.isLoading) {
    return (
      <div className="flex flex-col gap-3 p-3">
        <ReviewCrumbs source={source} id={id} sessionTitle={sessionTitle} current="Review" />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }
  if (review.error || !review.data) {
    return (
      <div className="flex flex-col gap-3 p-3">
        <ReviewCrumbs source={source} id={id} sessionTitle={sessionTitle} current="Review" />
        <Alert variant="destructive">
          <FileDiffIcon aria-hidden />
          <AlertTitle>Couldn't load the review</AlertTitle>
          <AlertDescription>
            <p>{review.error?.message ?? 'Not found'}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void review.refetch()}>
                <RotateCw aria-hidden />
                Retry
              </Button>
              <Button size="sm" variant="ghost" asChild>
                <Link to="/sessions/$source/$id" params={{ source, id }}>
                  Back to the session
                </Link>
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  const summary = review.data;
  const file = diff.data?.files.find((f) => f.path === selected) ?? null;

  if (isMobile) {
    return (
      <div className="flex flex-col gap-3 p-3">
        <ReviewCrumbs source={source} id={id} sessionTitle={sessionTitle} current="Review" />
        <Alert>
          <AlertDescription>
            Read-only on a phone. Comments, reverts and shipping are on the Mac.
          </AlertDescription>
        </Alert>
        {sel.kind === 'checkpoint' && (
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() => setSel({ kind: 'worktree' })}
          >
            Back to full diff
          </Button>
        )}
        {diff.isLoading && <p className="text-sm text-muted-foreground">Loading diff…</p>}
        {diff.error && (
          <p role="alert" className="text-sm text-destructive">
            {diff.error.message}
          </p>
        )}
        {diff.data && diff.data.files.length === 0 && (
          <p className="text-sm text-muted-foreground">No changes.</p>
        )}
        {(diff.data?.files ?? []).map((f) => (
          <section key={f.path} aria-label={`Diff of ${f.path}`} className="flex flex-col gap-1">
            <h2 className="break-all font-mono text-xs font-semibold">
              {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
            </h2>
            {f.status === 'binary' ? (
              <p className="text-sm text-muted-foreground">Binary file changed.</p>
            ) : (
              <ReadOnlyDiff unified={f.patch} />
            )}
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <ReviewCrumbs source={source} id={id} sessionTitle={sessionTitle} current="Review" />
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Review</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            {summary.worktree && (
              <span className="font-mono text-xs">
                {summary.worktree.branch} → {summary.worktree.base}
              </span>
            )}
            <span>
              {diff.data?.files.length ?? 0} {(diff.data?.files.length ?? 0) === 1 ? 'file' : 'files'} · +
              {diff.data?.additions ?? 0} −{diff.data?.deletions ?? 0}
            </span>
            {sel.kind === 'checkpoint' && <Badge variant="secondary">Single turn</Badge>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {sel.kind === 'checkpoint' && (
            <Button size="sm" variant="ghost" onClick={() => setSel({ kind: 'worktree' })}>
              Back to full diff
            </Button>
          )}
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={mode}
            onValueChange={(v) => {
              if (v === 'split' || v === 'unified') setMode(v);
            }}
          >
            <ToggleGroupItem value="split">Split</ToggleGroupItem>
            <ToggleGroupItem value="unified">Unified</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 gap-3">
        <FileTree
          files={diff.data?.files ?? []}
          selected={selected}
          viewed={draft.viewed}
          onSelect={setSelected}
          onToggleViewed={draft.toggleViewed}
        />
        <main className="flex min-w-0 flex-1 flex-col gap-2 overflow-auto">
          {diff.isLoading && <p className="text-sm text-muted-foreground">Loading diff…</p>}
          {diff.error && (
            <p role="alert" className="text-sm text-destructive">
              {diff.error.message}
            </p>
          )}
          {diff.data && diff.data.files.length === 0 && (
            <p className="text-sm text-muted-foreground">No changes.</p>
          )}
          {file && (
            <FileDiff
              key={`${sel.kind}:${file.path}`}
              file={file}
              mode={mode}
              comments={draft.comments.filter((c) => c.file === file.path)}
              canRevert={sel.kind === 'worktree'}
              onAddComment={draft.add}
              onRevertFile={() => void revert.run({ cwd: summary.cwd, file: file.path })}
              onRevertHunk={(i) => void revert.run({ cwd: summary.cwd, file: file.path, hunkIndex: i })}
            />
          )}
          {revert.error && (
            <p role="alert" className="text-sm text-destructive">
              {revert.error.message}
            </p>
          )}
        </main>
        <aside className="w-80 shrink-0 space-y-3 overflow-auto">
          {aside?.({ cwd: summary.cwd, select: setSel, selected: sel })}
          <CommentsPanel
            source={source}
            id={id}
            cwd={summary.cwd}
            projectId={summary.worktree?.projectId ?? null}
            owned={summary.owned}
            draft={draft}
          />
        </aside>
      </div>
      <GitConfirmDialog
        request={revert.pending}
        busy={revert.busy}
        title="Revert changes?"
        confirmLabel="Revert"
        danger
        onConfirm={() => void revert.confirm()}
        onCancel={revert.cancel}
      />
    </div>
  );
}
