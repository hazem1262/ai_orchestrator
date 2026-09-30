import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type {
  WorktreeCleanupCandidate,
  WorktreeCleanupPreview,
  WorktreeCleanupResult,
  WorktreeCleanupSkipped,
} from '@orc/api-contract';
import type { WorktreeView } from '@orc/core';
import type { z } from 'zod';
import { getWorktree } from '../../db/repos/worktrees.ts';
import { runAudited } from '../git/audit.ts';
import { git } from '../git/exec.ts';
import { dirtyFiles, listWorktreeViews, repoSlugOf, toView, type WorktreeDeps } from './worktree-read.ts';

type Candidate = z.infer<typeof WorktreeCleanupCandidate>;
type Skipped = z.infer<typeof WorktreeCleanupSkipped>;
type Preview = z.infer<typeof WorktreeCleanupPreview>;
type Result = z.infer<typeof WorktreeCleanupResult>;
type Reason = Candidate['reason'];

const DETACHED = '(detached)';

export type ArchiveFn = (path: string) => Promise<void>;

/** `origin/<default>` of a repo: `refs/remotes/origin/HEAD`, else `origin/main` or `origin/master`. Never fetches. */
async function originDefault(repo: string): Promise<string | null> {
  const head = await git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (head.exitCode === 0 && head.stdout.trim() !== '') return head.stdout.trim();
  for (const name of ['main', 'master']) {
    const ref = `refs/remotes/origin/${name}`;
    const r = await git(repo, ['rev-parse', '--verify', '--quiet', ref], { allowFail: true });
    if (r.exitCode === 0) return ref;
  }
  return null;
}

async function branchTip(w: WorktreeView): Promise<string | null> {
  const [cwd, ref] = existsSync(w.path) ? [w.path, 'HEAD'] : [w.repo, `refs/heads/${w.branch}`];
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/** Short HEAD commit of a detached worktree, so identical `(detached)` rows can be told apart. */
async function detachedHead(w: WorktreeView): Promise<string | null> {
  if (w.branch !== DETACHED) return null;
  const sha = w.head ?? (existsSync(w.path) ? await branchTip(w) : null);
  return sha ? sha.slice(0, 7) : null;
}

/** Per-call caches, so one preview or run resolves each repo's default branch and name once. */
function memo<T>(fn: (repo: string) => Promise<T>): (repo: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (repo) => {
    const hit = cache.get(repo);
    if (hit) return hit;
    const p = fn(repo);
    cache.set(repo, p);
    return p;
  };
}

function repoInfo() {
  return {
    defaultRef: memo(originDefault),
    name: memo(async (repo) => (await repoSlugOf(repo)) ?? basename(repo)),
  };
}

async function mergedReason(w: WorktreeView, info: ReturnType<typeof repoInfo>): Promise<Reason | null> {
  if (w.prStatus?.state === 'merged') return 'pr_merged';
  const target = await info.defaultRef(w.repo);
  if (!target) return null;
  const tip = await branchTip(w);
  if (!tip) return null;
  const r = await git(w.repo, ['merge-base', '--is-ancestor', tip, target], { allowFail: true });
  return r.exitCode === 0 ? 'in_default_branch' : null;
}

async function dirtyReason(w: WorktreeView): Promise<string | null> {
  if (!existsSync(w.path)) return null;
  const dirty = await dirtyFiles(w.path);
  return dirty.length > 0 ? `uncommitted changes in ${dirty.length} file(s)` : null;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Active, non-main worktrees whose linked PR is merged or whose branch tip is already in the
 * repo's `origin/<default>`. Merged worktrees with uncommitted or untracked changes are listed
 * under `skipped` instead. Worktrees that are not merged appear in neither list.
 */
export async function cleanupPreview(d: WorktreeDeps, f: { projectId?: string }): Promise<Preview> {
  const views = listWorktreeViews(d, { state: 'active', ...(f.projectId ? { projectId: f.projectId } : {}) });
  const info = repoInfo();
  const checked = await mapLimit(
    views.filter((w) => !w.isMain),
    8,
    async (w) => {
      const reason = await mergedReason(w, info);
      if (!reason) return null;
      const head = await detachedHead(w);
      const base = {
        path: w.path,
        repo: w.repo,
        repoName: await info.name(w.repo),
        branch: w.branch,
        ...(head ? { head } : {}),
      };
      const why = await dirtyReason(w);
      if (why) return { skipped: { ...base, why } };
      const pr = reason === 'pr_merged' ? w.prStatus?.pr : undefined;
      return { candidate: { ...base, reason, ...(pr ? { pr } : {}) } };
    },
  );
  const candidates: Candidate[] = [];
  const skipped: Skipped[] = [];
  for (const c of checked) {
    if (c?.candidate) candidates.push(c.candidate);
    if (c?.skipped) skipped.push(c.skipped);
  }
  return { candidates, skipped };
}

/** Why `path` can't be cleaned up now, or null when it is still an active, merged, clean worktree. */
async function refusal(
  d: WorktreeDeps,
  path: string,
  info: ReturnType<typeof repoInfo>,
): Promise<string | null> {
  const row = getWorktree(d.ctx.db, path);
  if (row?.state !== 'active') return `unknown worktree ${path}`;
  if (row.isMain) return `${path} is the main checkout`;
  const w = toView(d, row);
  if (!(await mergedReason(w, info))) return `${w.branch} is not merged`;
  return dirtyReason(w);
}

/**
 * Archives each path in order after re-checking it is still merged and clean. Every path gets a
 * result; a refusal or a failed archive never stops the rest.
 */
export async function runCleanup(d: WorktreeDeps, paths: string[], archive: ArchiveFn): Promise<Result> {
  return runAudited(d.ctx, 'user', 'worktree.cleanup', null, { paths }, async () => {
    const info = repoInfo();
    const results: Result['results'] = [];
    for (const path of paths) {
      try {
        const why = await refusal(d, path, info);
        if (why) {
          results.push({ path, ok: false, error: why });
          continue;
        }
        await archive(path);
        results.push({ path, ok: true });
      } catch (err) {
        results.push({ path, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { results };
  });
}
