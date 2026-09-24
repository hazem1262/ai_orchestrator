import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { parseWorktreePorcelain, type WorktreeOrigin } from '@orc/core';
import { git, mainCheckoutOf } from '../git/exec.ts';
import type { RepoCandidate } from './sources.ts';

export interface DiscoveredWorktree {
  path: string;
  repo: string;
  branch: string;
  head: string | null;
  isMain: boolean;
  origin: WorktreeOrigin;
  prunable: boolean;
  locked: boolean;
  detached: boolean;
}

const PRIORITY: WorktreeOrigin[] = [
  'app',
  'config',
  'worktree-dir',
  'sibling',
  'scratchpad',
  'claude-json',
  'session-cwd',
];
const better = (a: WorktreeOrigin, b: WorktreeOrigin) => (PRIORITY.indexOf(a) <= PRIORITY.indexOf(b) ? a : b);
const under = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

export async function resolveWorktrees(
  candidates: RepoCandidate[],
  opts: { scratchpadRoots?: string[] } = {},
): Promise<DiscoveredWorktree[]> {
  const mainByDir = new Map<string, string | null>();
  const repos = new Map<string, { origin: WorktreeOrigin; worktreeDir: string }>();
  const exactOrigin = new Map<string, WorktreeOrigin>();

  for (const c of candidates) {
    exactOrigin.set(
      c.dir,
      exactOrigin.has(c.dir) ? better(exactOrigin.get(c.dir) as WorktreeOrigin, c.origin) : c.origin,
    );
    let main = mainByDir.get(c.dir);
    if (main === undefined) {
      main = await mainCheckoutOf(c.dir);
      if (main !== null && existsSync(main)) main = realpathSync(main);
      mainByDir.set(c.dir, main);
    }
    if (main === null) continue;
    const prev = repos.get(main);
    const originForRepo: WorktreeOrigin =
      c.dir === main || c.origin === 'config' ? c.origin : (prev?.origin ?? c.origin);
    repos.set(main, {
      origin: prev ? better(prev.origin, originForRepo) : originForRepo,
      worktreeDir: c.origin === 'config' ? c.worktreeDir : (prev?.worktreeDir ?? c.worktreeDir),
    });
  }

  const out: DiscoveredWorktree[] = [];
  const scratchRoots = opts.scratchpadRoots ?? [];
  for (const [main, info] of repos) {
    const r = await git(main, ['worktree', 'list', '--porcelain'], { allowFail: true });
    if (r.exitCode !== 0) continue;
    for (const e of parseWorktreePorcelain(r.stdout)) {
      if (e.bare) continue;
      const path = existsSync(e.path) ? realpathSync(e.path) : e.path;
      const isMain = path === main;
      let origin: WorktreeOrigin;
      const exact = exactOrigin.get(path);
      if (isMain) origin = info.origin;
      else if (under(path, join(main, info.worktreeDir))) origin = 'worktree-dir';
      else if (scratchRoots.some((root) => under(path, root))) origin = 'scratchpad';
      else if (dirname(path) === dirname(main)) origin = 'sibling';
      else origin = exact ?? info.origin;
      if (e.prunable && !existsSync(path)) continue;
      out.push({
        path,
        repo: main,
        branch: e.branch ?? '(detached)',
        head: e.head,
        isMain,
        origin,
        prunable: e.prunable,
        locked: e.locked,
        detached: e.detached,
      });
    }
  }
  return out;
}
