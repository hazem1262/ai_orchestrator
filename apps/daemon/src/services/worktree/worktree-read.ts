import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { parseStatusPorcelainZ, ticketFromBranch, type WorktreeView } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { findPrByHead, getPrStatus } from '../../db/repos/pr-cache.ts';
import {
  getWorktree,
  listWorktrees,
  markWorktreeArchived,
  upsertWorktree,
  type WorktreeRow,
} from '../../db/repos/worktrees.ts';
import { git } from '../git/exec.ts';
import { resolveWorktrees } from './discover.ts';
import { collectCandidates } from './sources.ts';

export interface WorktreeDeps {
  ctx: DaemonContext;
  now: () => Date;
  claudeJson?: string;
  /** Launches IDE/Terminal/Finder; defaults to execa in Task 8. Injected in tests. */
  opener?: (command: string, args: string[]) => Promise<void>;
}

const DAY_MS = 86_400_000;
const under = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);

export function prRepoSlug(prUrl: string | null): { repo: string; number: number } | null {
  if (!prUrl) return null;
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(prUrl);
  return m?.[1] && m[2] ? { repo: m[1], number: Number(m[2]) } : null;
}

/** `owner/name` of a GitHub remote URL (https, ssh or scp-style), or null for anything else. */
export function githubSlugFromRemote(url: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m?.[1] && m[2] ? `${m[1]}/${m[2]}` : null;
}

export const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const slugCache = new Map<string, string | null>();

/**
 * The GitHub `owner/name` of a repo checkout, read from its `origin` remote. Null when there is no
 * origin or it isn't on GitHub. Each call re-reads git and refreshes the cache `toView` reads.
 */
export async function repoSlugOf(repoPath: string): Promise<string | null> {
  const r = await git(repoPath, ['remote', 'get-url', 'origin'], { allowFail: true });
  const slug = r.exitCode === 0 ? githubSlugFromRemote(r.stdout) : null;
  slugCache.set(repoPath, slug);
  return slug;
}

export async function dirtyFiles(path: string): Promise<string[]> {
  const r = await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { allowFail: true });
  if (r.exitCode !== 0) return [];
  return parseStatusPorcelainZ(r.stdout).map((e) => e.path);
}

export function toView(d: WorktreeDeps, row: WorktreeRow): WorktreeView {
  const slug = prRepoSlug(row.prUrl);
  const prStatus = slug
    ? getPrStatus(d.ctx.db, slug.repo, slug.number)
    : row.isMain
      ? null
      : findPrByHead(d.ctx.db, row.branch, slugCache.get(row.repo) ?? null);
  const { createdAt: _c, archivedAt: _a, ...view } = row;
  return { ...view, prUrl: row.prUrl ?? prStatus?.pr.url ?? null, prStatus };
}

function sessionLinks(d: WorktreeDeps, paths: string[]): Map<string, string[]> {
  const links = new Map<string, string[]>(paths.map((p) => [p, []]));
  const from = new Date(d.now().getTime() - 30 * DAY_MS).toISOString();
  for (const item of d.ctx.sessions.list({ from, limit: 300 }).items) {
    const s = d.ctx.sessions.getByPk(item.pk);
    if (!s) continue;
    const hit = new Set<string>();
    for (const cwd of s.cwds) {
      const best = paths.filter((p) => under(cwd, p)).sort((a, b) => b.length - a.length)[0];
      if (best) hit.add(best);
    }
    for (const p of hit) links.get(p)?.push(item.pk);
  }
  return links;
}

/**
 * A worktree only links a PR from its own repo. A stored link from another repo is dropped and
 * re-derived. Without a known repo slug, only a branch match is used — never session PRs.
 */
function linkedPrUrl(
  d: WorktreeDeps,
  f: { branch: string; isMain: boolean },
  slug: string | null,
  prevUrl: string | null,
  sessionPrs: Array<{ repo: string; url: string }>,
): string | null {
  if (f.isMain) return null;
  if (prevUrl) {
    const prev = prRepoSlug(prevUrl);
    if (!slug || (prev && sameRepo(prev.repo, slug))) return prevUrl;
  }
  const byBranch = findPrByHead(d.ctx.db, f.branch, slug);
  if (byBranch) return byBranch.pr.url;
  if (!slug) return null;
  return sessionPrs.find((p) => sameRepo(p.repo, slug))?.url ?? null;
}

const fingerprint = (v: WorktreeView) =>
  JSON.stringify([
    v.branch,
    v.head,
    v.dirty,
    v.state,
    v.ticket,
    v.prUrl,
    v.sessionPks,
    v.createdByApp,
    v.origin,
    v.prStatus?.updatedAt ?? null,
  ]);

export async function discoverWorktrees(d: WorktreeDeps): Promise<WorktreeView[]> {
  const { ctx } = d;
  const cfg = ctx.config();
  const candidates = await collectCandidates(ctx, {
    ...(d.claudeJson ? { claudeJson: d.claudeJson } : {}),
    now: d.now(),
  });
  const found = await resolveWorktrees(candidates, { scratchpadRoots: cfg.worktrees.scratchpadRoots });
  const links = sessionLinks(
    d,
    found.map((f) => f.path),
  );
  const slugs = new Map<string, string | null>();
  for (const repo of new Set(found.map((f) => f.repo))) slugs.set(repo, await repoSlugOf(repo));
  const nowIso = d.now().toISOString();
  const seen = new Set<string>();
  const views: WorktreeView[] = [];

  for (const f of found) {
    seen.add(f.path);
    const prev = getWorktree(ctx.db, f.path);
    const before = prev ? toView(d, prev) : null;
    const projectId = ctx.projects.resolve(f.path);
    const regex = projectId ? (ctx.projects.get(projectId)?.ticketRegex ?? null) : null;
    const linked = links.get(f.path) ?? [];
    const sessionPrs = linked.flatMap((pk) => ctx.sessions.getByPk(pk)?.prs ?? []);
    const row: WorktreeRow = {
      path: f.path,
      repo: f.repo,
      branch: f.branch,
      base: prev?.base ?? null,
      ticket: f.isMain ? null : ticketFromBranch(f.branch, regex),
      dirty: (await dirtyFiles(f.path)).length > 0,
      prUrl: linkedPrUrl(d, f, slugs.get(f.repo) ?? null, prev?.prUrl ?? null, sessionPrs),
      state: 'active',
      createdByApp: prev?.createdByApp ?? false,
      head: f.head,
      isMain: f.isMain,
      origin: prev?.createdByApp ? 'app' : f.origin,
      sessionPks: linked,
      projectId,
      createdAt: prev?.createdAt ?? nowIso,
      updatedAt: nowIso,
      archivedAt: null,
    };
    const view = toView(d, row);
    if (!before || fingerprint(before) !== fingerprint(view)) {
      upsertWorktree(ctx.db, row);
      ctx.bus.emit({ type: 'worktree.updated', worktree: view });
    }
    views.push(view);
  }

  for (const row of listWorktrees(ctx.db, { state: 'active' })) {
    if (seen.has(row.path) || existsSync(row.path)) continue;
    markWorktreeArchived(ctx.db, row.path, nowIso);
    ctx.bus.emit({ type: 'worktree.removed', path: row.path });
  }
  return views;
}

export function listWorktreeViews(
  d: WorktreeDeps,
  f: { projectId?: string; state?: 'active' | 'archived'; repo?: string } = {},
): WorktreeView[] {
  return listWorktrees(d.ctx.db, f).map((r) => toView(d, r));
}

export function getWorktreeView(d: WorktreeDeps, path: string): WorktreeView | null {
  const r = getWorktree(d.ctx.db, path);
  return r ? toView(d, r) : null;
}

export function findWorktreeByCwd(d: WorktreeDeps, cwd: string): WorktreeView | null {
  const best = listWorktrees(d.ctx.db, { state: 'active' })
    .filter((r) => under(cwd, r.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return best ? toView(d, best) : null;
}
