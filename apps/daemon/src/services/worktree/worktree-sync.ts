import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuditActor } from '@orc/core';
import { execa } from 'execa';
import { getWorktree, markWorktreeArchived, type WorktreeRow } from '../../db/repos/worktrees.ts';
import { revertRefPrefix } from '../diff/diff.ts';
import { runAudited } from '../git/audit.ts';
import { GitError, git, gitOut } from '../git/exec.ts';
import type { SyncPreviewResult } from './worktree.ts';
import { dirtyFiles, type WorktreeDeps } from './worktree-read.ts';
import { repoConfigFor } from './worktree-write.ts';

function requireRow(d: WorktreeDeps, path: string): WorktreeRow {
  const row = getWorktree(d.ctx.db, path);
  if (row?.state !== 'active') throw new GitError('not_a_worktree', `unknown worktree ${path}`);
  if (row.isMain) throw new GitError('is_main_checkout', `${path} is the main checkout`);
  return row;
}

export async function baseRef(row: WorktreeRow): Promise<string> {
  if (row.base) return row.base;
  return gitOut(row.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

const splitZ = (s: string) => s.split('\0').filter((x) => x !== '');

export async function changedFiles(path: string, base: string): Promise<string[]> {
  const mergeBase = await gitOut(path, ['merge-base', 'HEAD', base]);
  const tracked = splitZ(await gitOut(path, ['diff', '--name-only', '--no-renames', '-z', mergeBase]));
  const untracked = splitZ(await gitOut(path, ['ls-files', '--others', '--exclude-standard', '-z']));
  return [...new Set([...tracked, ...untracked])].sort();
}

export async function syncPreview(d: WorktreeDeps, path: string): Promise<SyncPreviewResult> {
  const row = requireRow(d, path);
  const files = await changedFiles(path, await baseRef(row));
  const dirtyInMain = new Set(await dirtyFiles(row.repo));
  return { path, mainPath: row.repo, files, mainDirty: files.filter((f) => dirtyInMain.has(f)) };
}

export async function syncToMain(
  d: WorktreeDeps,
  path: string,
  actor: AuditActor,
): Promise<{ files: number }> {
  return runAudited(d.ctx, actor, 'worktree.sync', path, {}, async () => {
    const preview = await syncPreview(d, path);
    if (preview.mainDirty.length > 0) {
      throw new GitError('main_dirty', `main checkout has local changes in: ${preview.mainDirty.join(', ')}`);
    }
    for (const rel of preview.files) {
      const src = join(path, rel);
      const dst = join(preview.mainPath, rel);
      if (existsSync(src) && statSync(src).isFile()) {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
      } else if (!existsSync(src) && existsSync(dst)) {
        rmSync(dst);
      }
    }
    return { files: preview.files.length };
  });
}

async function pruneRevertRefs(repo: string, prefix: string): Promise<void> {
  const refs = (await gitOut(repo, ['for-each-ref', '--format=%(refname)', prefix]))
    .split('\n')
    .filter((r) => r.startsWith(prefix));
  // Sequential: parallel `update-ref -d` calls contend for the packed-refs lock.
  for (const ref of refs) await gitOut(repo, ['update-ref', '-d', ref]);
}

export async function archiveWorktree(
  d: WorktreeDeps,
  path: string,
  actor: AuditActor,
  opts: { allowExternal?: boolean } = {},
): Promise<void> {
  const { ctx } = d;
  await runAudited(
    ctx,
    actor,
    'worktree.archive',
    path,
    { allowExternal: opts.allowExternal ?? false },
    async () => {
      const row = requireRow(d, path);
      if (!row.createdByApp && !opts.allowExternal) {
        throw new GitError(
          'external_worktree',
          `${path} was not created by the app; confirm explicitly to archive it`,
        );
      }
      const reverts = revertRefPrefix(path);
      if (existsSync(path)) {
        const dirty = await dirtyFiles(path);
        if (dirty.length > 0)
          throw new GitError(
            'dirty_worktree',
            `uncommitted changes in ${dirty.length} file(s): ${dirty.slice(0, 5).join(', ')}`,
          );
        const script = repoConfigFor(ctx, row.repo)?.archive;
        if (script)
          await execa(process.env.SHELL ?? '/bin/zsh', ['-lc', script], { cwd: path, timeout: 300_000 });
        await git(row.repo, ['worktree', 'remove', path]);
      } else {
        await git(row.repo, ['worktree', 'prune']);
      }
      await pruneRevertRefs(row.repo, reverts);
      const nowIso = d.now().toISOString();
      markWorktreeArchived(ctx.db, path, nowIso);
      ctx.bus.emit({ type: 'worktree.removed', path });
    },
  );
}
