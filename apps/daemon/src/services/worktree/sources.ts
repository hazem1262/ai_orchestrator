import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorktreeOrigin } from '@orc/core';
import type { DaemonContext } from '../../context.ts';

export interface RepoCandidate {
  dir: string;
  origin: WorktreeOrigin;
  worktreeDir: string;
}

const DAY_MS = 86_400_000;

export function claudeJsonPath(claudeHome: string): string {
  return join(dirname(claudeHome), '.claude.json');
}

/** Reads ~/.claude.json and keeps ONLY `githubRepoPaths`. Nothing else is returned, stored or logged. */
export function readGithubRepoPaths(file: string): string[] {
  let picked: unknown;
  try {
    picked = (JSON.parse(readFileSync(file, 'utf8')) as { githubRepoPaths?: unknown }).githubRepoPaths;
  } catch {
    return [];
  }
  if (!picked || typeof picked !== 'object') return [];
  const out: string[] = [];
  for (const value of Object.values(picked as Record<string, unknown>)) {
    if (Array.isArray(value)) for (const p of value) if (typeof p === 'string') out.push(p);
  }
  return out;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function hasGitFile(dir: string): boolean {
  try {
    return statSync(join(dir, '.git')).isFile();
  } catch {
    return false;
  }
}

/** Breadth-first walk that returns folders whose `.git` is a file (linked worktrees). Does not descend into them. */
export function findGitFileDirs(
  root: string,
  opts: { maxDepth: number; namePrefix?: string; maxDirs?: number },
): string[] {
  if (!isDir(root)) return [];
  const found: string[] = [];
  const maxDirs = opts.maxDirs ?? 5000;
  let visited = 0;
  const queue: Array<{ dir: string; depth: number }> = [];
  for (const name of readdirSync(root)) {
    if (opts.namePrefix && !name.startsWith(opts.namePrefix)) continue;
    const p = join(root, name);
    if (isDir(p)) queue.push({ dir: p, depth: 1 });
  }
  while (queue.length > 0 && visited < maxDirs) {
    const next = queue.shift();
    if (!next) break;
    visited++;
    if (hasGitFile(next.dir)) {
      found.push(realpathSync(next.dir));
      continue;
    }
    if (next.depth >= opts.maxDepth) continue;
    let names: string[] = [];
    try {
      names = readdirSync(next.dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = join(next.dir, name);
      if (isDir(p)) queue.push({ dir: p, depth: next.depth + 1 });
    }
  }
  return found.sort();
}

export async function collectCandidates(
  ctx: DaemonContext,
  opts: { claudeJson?: string; now?: Date } = {},
): Promise<RepoCandidate[]> {
  const cfg = ctx.config();
  const out: RepoCandidate[] = [];
  const add = (dir: string, origin: WorktreeOrigin, worktreeDir = '.worktrees') => {
    if (existsSync(dir)) out.push({ dir: realpathSync(dir), origin, worktreeDir });
  };

  const configRepos = cfg.projects.flatMap((p) => p.repos);
  for (const r of configRepos) add(r.path, 'config', r.worktreeDir);

  for (const r of configRepos) {
    const wtRoot = join(r.path, r.worktreeDir);
    if (!isDir(wtRoot)) continue;
    for (const name of readdirSync(wtRoot)) add(join(wtRoot, name), 'worktree-dir', r.worktreeDir);
  }

  if (cfg.worktrees.scanSiblings) {
    for (const r of configRepos) {
      const parent = dirname(r.path);
      if (!isDir(parent)) continue;
      for (const name of readdirSync(parent)) {
        const p = join(parent, name);
        if (hasGitFile(p)) add(p, 'sibling');
      }
    }
  }

  for (const root of cfg.worktrees.scratchpadRoots) {
    for (const dir of findGitFileDirs(root, { maxDepth: 6, namePrefix: 'claude-' })) add(dir, 'scratchpad');
  }

  for (const p of readGithubRepoPaths(opts.claudeJson ?? claudeJsonPath(ctx.paths.claudeHome)))
    add(p, 'claude-json');

  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const seen = new Set<string>();
  for (const item of ctx.sessions.list({ from, limit: 300 }).items) {
    const s = ctx.sessions.getByPk(item.pk);
    for (const cwd of s?.cwds ?? []) {
      if (seen.has(cwd)) continue;
      seen.add(cwd);
      add(cwd, 'session-cwd');
    }
  }
  return out;
}
