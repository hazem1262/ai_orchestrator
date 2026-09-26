import type { PrStatus } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { listWorktrees, type WorktreeRow } from '../../db/repos/worktrees.ts';
import { GitError } from '../git/exec.ts';

export function worktreesForPr(ctx: DaemonContext, s: PrStatus): WorktreeRow[] {
  return listWorktrees(ctx.db, { state: 'active' }).filter(
    (w) =>
      !w.isMain &&
      (w.prUrl === s.pr.url || (w.prUrl === null && s.headRef !== null && w.branch === s.headRef)),
  );
}

/**
 * Archives app-created worktrees when their PR transitions to merged. It never forces: a dirty
 * worktree makes `archiveAs` refuse, and an external one is skipped before archiving is tried.
 * Either way the worktree stays and an inbox item says why.
 */
export function registerAutoArchive(ctx: DaemonContext): () => void {
  const blocked = (w: WorktreeRow, s: PrStatus, why: string) =>
    ctx.inbox?.upsert({
      kind: 'pr_event',
      scope: { domain: 'worktree', id: w.path },
      facet: 'archive_blocked',
      sessionId: w.sessionPks[0] ?? null,
      projectId: w.projectId,
      ticket: w.ticket,
      reason: `${s.pr.repo}#${s.pr.number} merged; worktree kept because ${why}`,
      payload: { pr: s.pr, event: 'archive_blocked', path: w.path, presetId: null, vars: {} },
    });

  return ctx.bus.on('pr.changed', (e) => {
    if (e.after.state !== 'merged' || e.before?.state === 'merged') return;
    if (!ctx.config().worktrees.autoArchiveOnMerge || !ctx.worktrees) return;
    const worktrees = ctx.worktrees;
    for (const w of worktreesForPr(ctx, e.after)) {
      if (!w.createdByApp) {
        blocked(w, e.after, 'it was not created by the app (archive it yourself)');
        continue;
      }
      worktrees.archiveAs(w.path, 'automation', { allowExternal: false }).catch((err: unknown) => {
        if (err instanceof GitError && err.code === 'dirty_worktree') {
          blocked(w, e.after, 'it has uncommitted changes');
          return;
        }
        ctx.log.warn({ err: String(err), path: w.path }, 'auto-archive failed');
        blocked(w, e.after, `archiving failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  });
}
