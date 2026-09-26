import { cpSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectConfig } from '@orc/api-contract';
import {
  type AuditActor,
  branchName,
  parseWorktreePorcelain,
  type WorktreeView,
  worktreeDirName,
} from '@orc/core';
import { execa } from 'execa';
import type { DaemonContext } from '../../context.ts';
import { getWorktree, upsertWorktree } from '../../db/repos/worktrees.ts';
import { runAudited } from '../git/audit.ts';
import { GitError, git, gitOut, mainCheckoutOf } from '../git/exec.ts';
import { globToRegExp } from './glob.ts';
import type { CreateWorktreeInput } from './worktree.ts';
import { toView, type WorktreeDeps } from './worktree-read.ts';

const shell = () => process.env.SHELL ?? '/bin/zsh';

export function repoConfigFor(ctx: DaemonContext, repo: string): ProjectConfig['repos'][number] | null {
  for (const p of ctx.config().projects) {
    for (const r of p.repos) {
      const real = existsSync(r.path) ? realpathSync(r.path) : r.path;
      if (real === repo) return r;
    }
  }
  return null;
}

export async function copyIgnoredFiles(
  mainPath: string,
  worktreePath: string,
  globs: string[],
  worktreeDir: string,
): Promise<string[]> {
  if (globs.length === 0) return [];
  const out = await gitOut(mainPath, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '-z',
  ]);
  const matchers = globs.map(globToRegExp);
  const copied: string[] = [];
  for (const entry of out.split('\0')) {
    if (entry === '') continue;
    const rel = entry.replace(/\/$/, '');
    if (rel === worktreeDir || rel.startsWith(`${worktreeDir}/`)) continue;
    if (!matchers.some((m) => m.test(rel))) continue;
    const dst = join(worktreePath, rel);
    if (existsSync(dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(join(mainPath, rel), dst, { recursive: true, errorOnExist: false, force: false });
    copied.push(rel);
  }
  return copied;
}

export async function createWorktree(
  d: WorktreeDeps,
  i: CreateWorktreeInput,
  opts: { runSetup: boolean; actor: AuditActor },
): Promise<{ view: WorktreeView; setupPtyId: string | null }> {
  const { ctx } = d;
  const branch = branchName(i);
  return runAudited(
    ctx,
    opts.actor,
    'worktree.create',
    i.repo,
    { ...i, branch, runSetup: opts.runSetup },
    async () => {
      const repo = existsSync(i.repo) ? realpathSync(i.repo) : i.repo;
      const main = await mainCheckoutOf(repo);
      if (!main || realpathSync(main) !== repo)
        throw new GitError('not_a_worktree', `${i.repo} is not the main checkout of a git repository`);
      const rc = repoConfigFor(ctx, repo);
      const worktreeDir = rc?.worktreeDir ?? '.worktrees';
      const path = join(repo, worktreeDir, worktreeDirName(branch));

      const listed = parseWorktreePorcelain(await gitOut(repo, ['worktree', 'list', '--porcelain']));
      const clash = listed.find((w) => w.branch === branch || w.path === path);
      if (clash)
        throw new GitError('worktree_exists', `a worktree for ${branch} already exists at ${clash.path}`);
      if (existsSync(path)) throw new GitError('worktree_exists', `folder already exists at ${path}`);

      const branchExists =
        (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }))
          .exitCode === 0;
      mkdirSync(join(repo, worktreeDir), { recursive: true });
      if (branchExists) await git(repo, ['worktree', 'add', path, branch]);
      else await git(repo, ['worktree', 'add', '-b', branch, path, i.base]);

      const realPath = realpathSync(path);
      await copyIgnoredFiles(repo, realPath, rc?.copyGlobs ?? [], worktreeDir);
      const nowIso = d.now().toISOString();
      const head = await gitOut(realPath, ['rev-parse', 'HEAD']);
      const row = {
        path: realPath,
        repo,
        branch,
        base: i.base,
        ticket: i.ticket ? i.ticket.toUpperCase() : null,
        dirty: false,
        prUrl: null,
        state: 'active' as const,
        createdByApp: true,
        head,
        isMain: false,
        origin: 'app' as const,
        sessionPks: [],
        projectId: ctx.projects.resolve(realPath),
        createdAt: getWorktree(ctx.db, realPath)?.createdAt ?? nowIso,
        updatedAt: nowIso,
        archivedAt: null,
      };
      upsertWorktree(ctx.db, row);
      const view = toView(d, row);
      ctx.bus.emit({ type: 'worktree.updated', worktree: view });

      let setupPtyId: string | null = null;
      if (opts.runSetup && rc?.setup) {
        setupPtyId = ctx.pty.spawn({ command: shell(), args: ['-lc', rc.setup], cwd: realPath }).id;
      }
      return { view, setupPtyId };
    },
  );
}

export async function runWorktreeScript(
  d: WorktreeDeps,
  path: string,
  which: 'setup' | 'run' | 'archive',
  actor: AuditActor,
): Promise<{ ptyId: string }> {
  const { ctx } = d;
  return runAudited(ctx, actor, 'worktree.script', path, { which }, async () => {
    const row = getWorktree(ctx.db, path);
    if (row?.state !== 'active') throw new GitError('not_a_worktree', `unknown worktree ${path}`);
    const script = repoConfigFor(ctx, row.repo)?.[which];
    if (!script) throw new GitError('no_script', `no ${which} script configured for ${row.repo}`);
    return { ptyId: ctx.pty.spawn({ command: shell(), args: ['-lc', script], cwd: path }).id };
  });
}

const defaultOpener = async (command: string, args: string[]) => {
  await execa(command, args, { detached: true, stdio: 'ignore' });
};

export async function openWorktree(
  d: WorktreeDeps,
  path: string,
  target: 'vscode' | 'terminal' | 'finder',
): Promise<void> {
  const { ctx } = d;
  await runAudited(ctx, 'user', 'worktree.open', path, { target }, async () => {
    if (!getWorktree(ctx.db, path)) throw new GitError('not_a_worktree', `unknown worktree ${path}`);
    const open = d.opener ?? defaultOpener;
    if (target === 'vscode') await open('code', ['--new-window', path]);
    else if (target === 'terminal') await open('open', ['-a', 'Terminal', path]);
    else await open('open', [path]);
  });
}
