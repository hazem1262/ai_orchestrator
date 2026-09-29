import type { Source } from '@orc/core';
import { Link } from '@tanstack/react-router';
import { useDiff, useReview } from '@/api/queries/review.ts';
import { Button } from '@/components/ui/button.tsx';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty.tsx';
import { ReadOnlyDiff } from '@/features/mobile/ReadOnlyDiff.tsx';

/** The working-tree diff of the session's directory, read-only. Comments, reverts and shipping live in Review. */
export function DiffTab({ source, id }: { source: Source; id: string }) {
  const review = useReview(source, id);
  const diff = useDiff(review.data?.cwd ?? null);

  if (review.isLoading || diff.isLoading)
    return <p className="text-sm text-muted-foreground">Loading diff…</p>;
  const error = review.error ?? diff.error;
  if (error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {error.message}
      </p>
    );
  const files = diff.data?.files ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm">
          {files.length} {files.length === 1 ? 'file' : 'files'} changed ·{' '}
          <span className="font-mono text-xs text-success">+{diff.data?.additions ?? 0}</span>{' '}
          <span className="font-mono text-xs text-destructive">−{diff.data?.deletions ?? 0}</span>
        </p>
        <Button variant="outline" size="sm" className="ml-auto" asChild>
          <Link to="/review/$source/$id" params={{ source, id }}>
            Review and comment
          </Link>
        </Button>
      </div>
      {files.length === 0 ? (
        <Empty className="rounded-lg border">
          <EmptyHeader>
            <EmptyTitle>No uncommitted changes</EmptyTitle>
            <EmptyDescription>
              The working tree of this session's directory matches its last commit.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        files.map((f, i) => (
          <details key={f.path} open={i < 2} className="group rounded-lg border">
            <summary className="flex min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-muted/50">
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>
                {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              </span>
              <span className="shrink-0 font-mono text-xs">
                <span className="text-success">+{f.additions}</span>{' '}
                <span className="text-destructive">−{f.deletions}</span>
              </span>
            </summary>
            <div className="border-t [&>pre]:rounded-none [&>pre]:border-0">
              {f.status === 'binary' ? (
                <p className="text-xs text-muted-foreground">Binary file</p>
              ) : (
                <ReadOnlyDiff unified={f.patch} />
              )}
            </div>
          </details>
        ))
      )}
    </div>
  );
}
