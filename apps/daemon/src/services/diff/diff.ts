import { createHash } from 'node:crypto';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { type DiffResult, hunkPatch, parseUnifiedDiff } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { snapshotCommit, snapshotTree } from '../checkpoint/snapshot.ts';
import { runAudited } from '../git/audit.ts';
import { GitError, git, gitOut, repoRoot } from '../git/exec.ts';

export interface DiffService {
  diff(cwd: string, opts?: { from?: string; to?: string | 'WORKTREE' }): Promise<DiffResult>;
  mergeBase(cwd: string): Promise<string>;
  revert(
    cwd: string,
    file: string,
    opts: { hunkIndex?: number; from?: string },
  ): Promise<{ reverted: string }>;
}

/** Revert safety refs are namespaced per worktree so archiving one can prune only its own. */
export function revertRefPrefix(worktreePath: string): string {
  const real = existsSync(worktreePath) ? realpathSync(worktreePath) : worktreePath;
  const key = createHash('sha1').update(real).digest('hex').slice(0, 16);
  return `refs/orchestrator/reverts/${key}/`;
}

export async function defaultBase(cwd: string): Promise<string> {
  const originHead = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    allowFail: true,
  });
  if (originHead.exitCode === 0 && originHead.stdout.trim() !== '') return originHead.stdout.trim();
  for (const name of ['main', 'master', 'develop']) {
    const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { allowFail: true });
    if (r.exitCode === 0) return name;
  }
  throw new GitError('git_failed', `cannot determine a base branch for ${cwd}`);
}

async function rootOf(cwd: string): Promise<string> {
  const root = await repoRoot(cwd);
  if (!root) throw new GitError('not_a_worktree', `${cwd} is not inside a git worktree`);
  return root;
}

function safeRelative(root: string, file: string): string {
  const rel = normalize(file);
  const abs = resolve(root, rel);
  if (isAbsolute(file) || rel.startsWith('..') || !abs.startsWith(root + sep)) {
    throw new GitError('forbidden_git_args', `path escapes the worktree: ${file}`);
  }
  return rel;
}

export function createDiffService(ctx: DaemonContext): DiffService {
  async function mergeBase(cwd: string): Promise<string> {
    const root = await rootOf(cwd);
    const wt = ctx.worktrees?.findByCwd(root) ?? null;
    const base = wt?.base ?? (await defaultBase(root));
    return gitOut(root, ['merge-base', 'HEAD', base]);
  }

  async function diff(
    cwd: string,
    opts: { from?: string; to?: string | 'WORKTREE' } = {},
  ): Promise<DiffResult> {
    const root = await rootOf(cwd);
    const from = opts.from ?? (await mergeBase(root));
    const toLabel = opts.to ?? 'WORKTREE';
    const to = toLabel === 'WORKTREE' ? await snapshotTree(root) : toLabel;
    const raw = (await git(root, ['diff', '--no-color', '--no-ext-diff', '-M', from, to])).stdout;
    const files = parseUnifiedDiff(raw).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      cwd: root,
      from,
      to: toLabel,
      files,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    };
  }

  async function revert(
    cwd: string,
    file: string,
    opts: { hunkIndex?: number; from?: string },
  ): Promise<{ reverted: string }> {
    const root = await rootOf(cwd);
    const rel = safeRelative(root, file);
    const label = opts.hunkIndex === undefined ? rel : `${rel}#${opts.hunkIndex}`;
    return runAudited(
      ctx,
      'user',
      'git.revert',
      root,
      { file: rel, hunkIndex: opts.hunkIndex ?? null },
      async () => {
        const from = opts.from ?? (await mergeBase(root));
        const { commit } = await snapshotCommit(root, `orchestrator safety before reverting ${label}`);
        await gitOut(root, ['update-ref', `${revertRefPrefix(root)}${Date.now()}`, commit]);

        if (opts.hunkIndex === undefined) {
          const inBase =
            (await git(root, ['cat-file', '-e', `${from}:${rel}`], { allowFail: true })).exitCode === 0;
          if (inBase) await gitOut(root, ['restore', `--source=${from}`, '--worktree', '--', rel]);
          else if (existsSync(join(root, rel))) rmSync(join(root, rel));
          return { reverted: label };
        }

        const tree = await snapshotTree(root);
        const raw = (
          await git(root, ['diff', '--no-color', '--no-ext-diff', '--no-renames', from, tree, '--', rel])
        ).stdout;
        const entry = parseUnifiedDiff(raw)[0];
        if (!entry?.hunks[opts.hunkIndex])
          throw new GitError('hunk_not_found', `no hunk ${opts.hunkIndex} in ${rel}`);
        await gitOut(root, ['apply', '-R', '--whitespace=nowarn', '-'], {
          input: hunkPatch(entry, opts.hunkIndex),
        });
        return { reverted: label };
      },
    );
  }

  return { diff, mergeBase, revert };
}
