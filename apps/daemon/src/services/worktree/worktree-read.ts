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
      : findPrByHead(d.ctx.db, row.branch);
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
    const sessionPrUrl = f.isMain
      ? null
      : (linked.map((pk) => ctx.sessions.getByPk(pk)).flatMap((s) => s?.prs ?? [])[0]?.url ?? null);
    const row: WorktreeRow = {
      path: f.path,
      repo: f.repo,
      branch: f.branch,
      base: prev?.base ?? null,
      ticket: f.isMain ? null : ticketFromBranch(f.branch, regex),
      dirty: (await dirtyFiles(f.path)).length > 0,
      prUrl: prev?.prUrl ?? (f.isMain ? null : (findPrByHead(ctx.db, f.branch)?.pr.url ?? sessionPrUrl)),
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
