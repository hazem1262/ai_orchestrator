import type { Source } from '@orc/core';
import { type ReactNode, useEffect, useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { useCheckpointDiff, useDiff, useReview } from '@/api/queries/review.ts';
import { Button } from '@/components/ui/button.tsx';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog.tsx';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';
import { ReadOnlyDiff } from '@/features/mobile/ReadOnlyDiff.tsx';
import { useIsMobile } from '@/features/mobile/useIsMobile.ts';
import { CommentsPanel } from './CommentsPanel.tsx';
import { FileDiff } from './FileDiff.tsx';
import { FileTree } from './FileTree.tsx';
import { useReviewDraft } from './useReviewDraft.ts';

export type DiffSourceSel = { kind: 'worktree' } | { kind: 'checkpoint'; id: string };

type RevertVars = { cwd: string; file: string; hunkIndex?: number };

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

  if (review.isLoading) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (review.error || !review.data)
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        {review.error?.message ?? 'Not found'}
      </p>
    );
  const summary = review.data;
  const file = diff.data?.files.find((f) => f.path === selected) ?? null;

  if (isMobile) {
    return (
      <div className="flex flex-col gap-3 p-3">
        <p className="text-xs text-muted-foreground">
          Read-only on a phone. Comments, reverts and shipping are on the Mac.
        </p>
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
    <div className="flex h-full min-h-0">
      <FileTree
        files={diff.data?.files ?? []}
        selected={selected}
        viewed={draft.viewed}
        onSelect={setSelected}
        onToggleViewed={draft.toggleViewed}
      />
      <main className="min-w-0 flex-1 space-y-2 overflow-auto p-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono">{sel.kind === 'worktree' ? 'base … working tree' : 'single turn'}</span>
          {sel.kind === 'checkpoint' && (
            <Button size="sm" variant="ghost" onClick={() => setSel({ kind: 'worktree' })}>
              Back to full diff
            </Button>
          )}
          <span className="ml-auto" />
          <Button size="sm" variant={mode === 'split' ? 'default' : 'ghost'} onClick={() => setMode('split')}>
            Split
          </Button>
          <Button
            size="sm"
            variant={mode === 'unified' ? 'default' : 'ghost'}
            onClick={() => setMode('unified')}
          >
            Unified
          </Button>
        </div>
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
      <aside className="w-80 shrink-0 space-y-4 overflow-auto border-l p-2">
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
