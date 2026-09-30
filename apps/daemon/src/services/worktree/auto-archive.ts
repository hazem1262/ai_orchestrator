import type { PrRef, PrStatus } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { getPrStatus } from '../../db/repos/pr-cache.ts';
import { getWorktree, listWorktrees, type WorktreeRow } from '../../db/repos/worktrees.ts';
import { GitError } from '../git/exec.ts';
import { addExternal, dropExternal, EXTERNAL_EVENT, externalEntries, externalRows } from './archive-rows.ts';
import { prRepoSlug, repoSlugOf, sameRepo } from './worktree-read.ts';

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
 * Either way the worktree stays and an inbox item says why: one item per worktree for an app
 * worktree, and one item per repo listing every external worktree. A worktree whose link is set
 * to a PR that pr_cache already holds as merged never sees that transition, so a new link to a
 * merged PR is handled the same way, and at startup any active external worktree linked to a
 * merged PR but missing from its repo row is added to it.
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

  const resolveBlocked = (path: string) =>
    ctx.inbox?.resolve({
      kind: 'pr_event',
      scope: { domain: 'worktree', id: path },
      facet: 'archive_blocked',
    });

  const external = (w: WorktreeRow, pr: PrRef) => {
    resolveBlocked(w.path);
    addExternal(ctx, w, pr);
  };

  const unblock = (path: string) => {
    resolveBlocked(path);
    dropExternal(ctx, (e) => e.path === path);
  };

  const enabled = () => ctx.config().worktrees.autoArchiveOnMerge && !!ctx.worktrees;

  const onMerged = (w: WorktreeRow, s: PrStatus) => {
    if (!w.createdByApp) {
      external(w, s.pr);
      return;
    }
    ctx.worktrees?.archiveAs(w.path, 'automation', { allowExternal: false }).catch((err: unknown) => {
      if (err instanceof GitError && err.code === 'dirty_worktree') {
        blocked(w, s, 'it has uncommitted changes');
        return;
      }
      ctx.log.warn({ err: String(err), path: w.path }, 'auto-archive failed');
      blocked(w, s, `archiving failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  /** Runs the merge handling for the worktrees linked to `s`, limited to `paths` when given. */
  const handleMerged = (s: PrStatus, paths?: Set<string>) =>
    worktreesForPr(ctx, s)
      .then((ws) => {
        for (const w of ws) if (!paths || paths.has(w.path)) onMerged(w, s);
      })
      .catch((err: unknown) => ctx.log.warn({ err: String(err) }, 'auto-archive lookup failed'));

  // `worktree.removed` only fires for worktrees still active in the DB, so rows whose worktree
  // went away while the daemon was down are swept here.
  // Rows raised for a PR from another repo (a bad cross-repo link) are swept too.
  // Per-worktree rows for external worktrees are folded into their repo's grouped row.
  const active = new Set(listWorktrees(ctx.db, { state: 'active' }).map((w) => w.path));
  const crossRepoChecks: Array<{ path: string; prRepo: string }> = [];
  for (const item of ctx.inbox?.list({ state: ['open', 'snoozed'], kind: ['pr_event'] }) ?? []) {
    const path = item.payload.path;
    if (item.payload.event !== 'archive_blocked' || typeof path !== 'string') continue;
    if (!active.has(path)) {
      unblock(path);
      continue;
    }
    const pr = item.payload.pr as Partial<PrRef> | undefined;
    const w = getWorktree(ctx.db, path);
    if (
      w &&
      !w.createdByApp &&
      item.reason.includes('not created by the app') &&
      typeof pr?.repo === 'string' &&
      typeof pr.number === 'number' &&
      typeof pr.url === 'string'
    ) {
      external(w, { repo: pr.repo, number: pr.number, url: pr.url });
      continue;
    }
    if (typeof pr?.repo === 'string') crossRepoChecks.push({ path, prRepo: pr.repo });
  }
  dropExternal(ctx, (e) => !active.has(e.path));
  for (const item of externalRows(ctx)) {
    for (const e of externalEntries(item.payload)) {
      if (typeof e.pr?.repo === 'string') crossRepoChecks.push({ path: e.path, prRepo: e.pr.repo });
    }
  }
  void (async () => {
    for (const { path, prRepo } of crossRepoChecks) {
      const w = getWorktree(ctx.db, path);
      const slug = w ? await repoSlugOf(w.repo) : null;
      if (slug && !sameRepo(slug, prRepo)) unblock(path);
    }
    if (enabled()) await sweepMissingExternal();
  })().catch((err: unknown) =>
    ctx.log.warn({ err: String(err) }, `archive_blocked/${EXTERNAL_EVENT} repo sweep failed`),
  );

  async function sweepMissingExternal() {
    const listed = new Set<string>();
    for (const item of ctx.inbox?.list({ state: ['open', 'snoozed'], kind: ['pr_event'] }) ?? []) {
      if (item.payload.event === 'archive_blocked' && typeof item.payload.path === 'string')
        listed.add(item.payload.path);
    }
    for (const item of externalRows(ctx)) for (const e of externalEntries(item.payload)) listed.add(e.path);
    const missing = new Map<string, { s: PrStatus; paths: Set<string> }>();
    for (const w of listWorktrees(ctx.db, { state: 'active' })) {
      if (w.isMain || w.createdByApp || listed.has(w.path)) continue;
      const ref = prRepoSlug(w.prUrl);
      const s = ref ? getPrStatus(ctx.db, ref.repo, ref.number) : null;
      if (s?.state !== 'merged') continue;
      const group = missing.get(s.pr.url) ?? { s, paths: new Set<string>() };
      group.paths.add(w.path);
      missing.set(s.pr.url, group);
    }
    for (const { s, paths } of missing.values()) await handleMerged(s, paths);
  }

  const linkedTo = new Map(listWorktrees(ctx.db, { state: 'active' }).map((w) => [w.path, w.prUrl]));

  const offRemoved = ctx.bus.on('worktree.removed', (e) => {
    linkedTo.delete(e.path);
    unblock(e.path);
  });

  const offUpdated = ctx.bus.on('worktree.updated', ({ worktree: v }) => {
    const prev = linkedTo.get(v.path);
    linkedTo.set(v.path, v.prUrl);
    if (prev === v.prUrl || v.isMain || v.state !== 'active') return;
    const s = v.prStatus;
    if (s?.state !== 'merged' || s.pr.url !== v.prUrl || !enabled()) return;
    void handleMerged(s, new Set([v.path]));
  });

  const offChanged = ctx.bus.on('pr.changed', (e) => {
    if (e.after.state !== 'merged' || e.before?.state === 'merged') return;
    if (!enabled()) return;
    void handleMerged(e.after);
  });

  return () => {
    offRemoved();
    offUpdated();
    offChanged();
  };
}
