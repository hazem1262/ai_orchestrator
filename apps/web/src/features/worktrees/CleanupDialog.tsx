import type {
  WorktreeCleanupCandidate,
  WorktreeCleanupPreview,
  WorktreeCleanupResult,
} from '@orc/api-contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { getApiClient } from '@/api/client.ts';
import { worktreeKeys } from '@/api/queries/worktrees.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { GitAlertDialog } from '@/features/git/GitAlertDialog.tsx';

type Candidate = z.infer<typeof WorktreeCleanupCandidate>;
type Preview = z.infer<typeof WorktreeCleanupPreview>;
type Result = z.infer<typeof WorktreeCleanupResult>;

const REASON_LABEL: Record<Candidate['reason'], string> = {
  pr_merged: 'PR merged',
  in_default_branch: 'In default branch',
};

const plural = (n: number) => `${n} worktree${n === 1 ? '' : 's'}`;

function byRepo(candidates: Candidate[]): Array<[string, Candidate[]]> {
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) groups.set(c.repoName, [...(groups.get(c.repoName) ?? []), c]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function CandidateList({ preview }: { preview: Preview }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      {preview.candidates.length === 0 && (
        <p className="text-muted-foreground">No merged worktrees to clean up.</p>
      )}
      {byRepo(preview.candidates).map(([repo, rows]) => (
        <section key={repo} className="flex flex-col gap-1">
          <h3 className="font-mono text-xs font-semibold text-muted-foreground">{repo}</h3>
          <ul aria-label={repo} className="flex flex-col gap-1">
            {rows.map((c) => (
              <li key={c.path} className="flex min-w-0 flex-wrap items-center gap-1.5" title={c.path}>
                <span className="truncate font-mono">{c.branch}</span>
                <Badge variant="outline">{REASON_LABEL[c.reason]}</Badge>
                {c.pr && (
                  <a href={c.pr.url} target="_blank" rel="noreferrer" className="underline">
                    #{c.pr.number}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {preview.skipped.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-muted-foreground">Skipped</h3>
          <ul aria-label="Skipped" className="flex flex-col gap-1">
            {preview.skipped.map((s) => (
              <li key={s.path} className="flex min-w-0 flex-wrap items-center gap-1.5" title={s.path}>
                <span className="truncate font-mono">{s.branch}</span>
                <span className="text-xs text-muted-foreground">{s.repoName}</span>
                <span className="text-xs text-destructive">{s.why}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Results({ result, preview }: { result: Result; preview: Preview | undefined }) {
  const ok = result.results.filter((r) => r.ok).length;
  const failed = result.results.filter((r) => !r.ok);
  const branchOf = (path: string) => preview?.candidates.find((c) => c.path === path)?.branch ?? path;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p role="status">{`Archived ${ok}, failed ${failed.length}`}</p>
      {failed.length > 0 && (
        <ul aria-label="Failed" className="flex flex-col gap-1">
          {failed.map((r) => (
            <li key={r.path} className="flex min-w-0 flex-wrap gap-1.5" title={r.path}>
              <span className="truncate font-mono">{branchOf(r.path)}</span>
              <span className="text-xs text-destructive">{r.error}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Lists the merged worktrees the daemon would archive (grouped by repo) and the merged ones it
 * skips, then archives exactly the listed paths on confirm. The daemon re-checks each path before
 * archiving, so a result can still report a failure for a path that was listed.
 */
export function CleanupDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ['worktrees', 'cleanup-preview', projectId],
    queryFn: () => getApiClient().worktreesCleanupPreview(projectId ? { projectId } : {}),
    gcTime: 0,
    staleTime: 0,
  });
  const run = useMutation({
    mutationFn: (paths: string[]) => getApiClient().worktreesCleanup({ paths, confirm: true }),
    onSettled: () => qc.invalidateQueries({ queryKey: worktreeKeys.all }),
  });
  const paths = preview.data?.candidates.map((c) => c.path) ?? [];
  const done = run.data !== undefined;

  return (
    <GitAlertDialog
      title="Clean up merged worktrees"
      description="Removes each worktree folder whose PR is merged or whose branch is already in the default branch. Branches are kept. Worktrees with local changes are skipped."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={run.isPending}>
            {done ? 'Close' : 'Cancel'}
          </Button>
          {!done && paths.length > 0 && (
            <Button variant="destructive" disabled={run.isPending} onClick={() => run.mutate(paths)}>
              {run.isPending ? 'Archiving…' : `Archive ${plural(paths.length)}`}
            </Button>
          )}
        </>
      }
    >
      {preview.isPending && <p className="text-sm text-muted-foreground">Checking worktrees…</p>}
      {preview.error && <p className="text-sm text-destructive">{preview.error.message}</p>}
      {run.error && <p className="text-sm text-destructive">{run.error.message}</p>}
      {run.data ? (
        <Results result={run.data} preview={preview.data} />
      ) : preview.data ? (
        <CandidateList preview={preview.data} />
      ) : null}
    </GitAlertDialog>
  );
}
