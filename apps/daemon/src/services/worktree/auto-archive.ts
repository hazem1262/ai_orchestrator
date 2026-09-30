import type { PrStatus } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { getWorktree, listWorktrees, type WorktreeRow } from '../../db/repos/worktrees.ts';
import { GitError } from '../git/exec.ts';
import { repoSlugOf, sameRepo } from './worktree-read.ts';

/** Worktrees linked to the PR. A worktree whose repo slug is known must be in the PR's repo. */
export async function worktreesForPr(ctx: DaemonContext, s: PrStatus): Promise<WorktreeRow[]> {
  const linked = listWorktrees(ctx.db, { state: 'active' }).filter(
    (w) =>
      !w.isMain &&
      (w.prUrl === s.pr.url || (w.prUrl === null && s.headRef !== null && w.branch === s.headRef)),
  );
  const slugs = new Map<string, string | null>();
  const out: WorktreeRow[] = [];
  for (const w of linked) {
    if (!slugs.has(w.repo)) slugs.set(w.repo, await repoSlugOf(w.repo));
    const slug = slugs.get(w.repo);
    if (!slug || sameRepo(slug, s.pr.repo)) out.push(w);
  }
  return out;
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

  const unblock = (path: string) =>
    ctx.inbox?.resolve({
      kind: 'pr_event',
      scope: { domain: 'worktree', id: path },
      facet: 'archive_blocked',
    });

  // `worktree.removed` only fires for worktrees still active in the DB, so rows whose worktree
  // went away while the daemon was down are swept here.
  // Rows raised for a PR from another repo (a bad cross-repo link) are swept too.
  const active = new Set(listWorktrees(ctx.db, { state: 'active' }).map((w) => w.path));
  const crossRepoChecks: Array<{ path: string; prRepo: string }> = [];
  for (const item of ctx.inbox?.list({ state: ['open', 'snoozed'], kind: ['pr_event'] }) ?? []) {
    const path = item.payload.path;
    if (item.payload.event !== 'archive_blocked' || typeof path !== 'string') continue;
    if (!active.has(path)) {
      unblock(path);
      continue;
    }
    const prRepo = (item.payload.pr as { repo?: unknown } | undefined)?.repo;
    if (typeof prRepo === 'string') crossRepoChecks.push({ path, prRepo });
  }
  void (async () => {
    for (const { path, prRepo } of crossRepoChecks) {
      const w = getWorktree(ctx.db, path);
      const slug = w ? await repoSlugOf(w.repo) : null;
      if (slug && !sameRepo(slug, prRepo)) unblock(path);
    }
  })().catch((err: unknown) => ctx.log.warn({ err: String(err) }, 'archive_blocked repo sweep failed'));

  const offRemoved = ctx.bus.on('worktree.removed', (e) => unblock(e.path));

  const offChanged = ctx.bus.on('pr.changed', (e) => {
    if (e.after.state !== 'merged' || e.before?.state === 'merged') return;
    if (!ctx.config().worktrees.autoArchiveOnMerge || !ctx.worktrees) return;
    const worktrees = ctx.worktrees;
    void worktreesForPr(ctx, e.after)
      .then((ws) => {
        for (const w of ws) {
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
      })
      .catch((err: unknown) => ctx.log.warn({ err: String(err) }, 'auto-archive lookup failed'));
  });

  return () => {
    offRemoved();
    offChanged();
  };
}
