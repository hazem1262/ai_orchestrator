import { existsSync } from 'node:fs';
import { OrcConfig } from '@orc/api-contract';
import type { WorktreeView } from '@orc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { memoryAudit, stubSessions } from '../../../test/stubs.ts';
import { upsertPrStatus } from '../../db/repos/pr-cache.ts';
import { getWorktree, upsertWorktree } from '../../db/repos/worktrees.ts';
import { createWorktreeService } from './worktree.ts';

let repo: TempRepo | undefined;
let disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers) d();
  disposers = [];
  repo?.cleanup();
  repo = undefined;
});

const PR_URL = 'https://github.com/o/r/pull/7';

/**
 * One repo whose `origin` is a GitHub URL that is never contacted: `refs/remotes/origin/*` are
 * written with `update-ref`, so no fetch or push happens. Worktrees:
 * - `merged`: its commit is in origin/main.
 * - `pr`: its commit is not in origin/main, but its linked PR is merged.
 * - `open`: its commit is not in origin/main and it has no PR.
 * - `dirty`: its commit is in origin/main, but it has an untracked file.
 * - `ext`: its commit is in origin/main and it was created outside the app.
 */
async function setup(opts: { originHead?: boolean } = {}) {
  const r = makeTempRepo();
  repo = r;
  const cfg = OrcConfig.parse({
    projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [r.root], repos: [{ path: r.dir }] }],
  });
  const audit = memoryAudit();
  const ctx = createTestContext({
    config: () => cfg,
    pty: recordingPty(),
    audit,
    sessions: stubSessions([]),
  });
  disposers.push(() => ctx.dispose());
  const removed: string[] = [];
  ctx.bus.on('worktree.removed', (e) => removed.push(e.path));
  const svc = createWorktreeService(ctx);
  ctx.worktrees = svc;

  const make = async (slug: string): Promise<WorktreeView> => {
    const { view } = await svc.createWith(
      { repo: r.dir, base: 'main', type: 'feat', ticket: null, slug },
      { runSetup: false, actor: 'user' },
    );
    r.git('-C', view.path, 'commit', '--allow-empty', '-m', `work on ${slug}`);
    return view;
  };
  const merged = await make('merged');
  const pr = await make('pr');
  const open = await make('open');
  const dirty = await make('dirty');
  const ext = await make('ext');

  for (const w of [merged, dirty, ext]) r.git('merge', '--no-ff', '-q', '-m', `merge ${w.branch}`, w.branch);
  r.git('remote', 'add', 'origin', 'https://github.com/o/r.git');
  r.git('update-ref', 'refs/remotes/origin/main', r.git('rev-parse', 'HEAD').trim());
  if (opts.originHead !== false)
    r.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  // Local main moves ahead of origin/main with `open` merged: only origin/main counts.
  r.git('merge', '--no-ff', '-q', '-m', `merge ${open.branch}`, open.branch);

  r.write('.worktrees/feat-dirty/notes.txt', 'wip\n');

  const prRow = getWorktree(ctx.db, pr.path);
  if (!prRow) throw new Error('no pr row');
  upsertWorktree(ctx.db, { ...prRow, prUrl: PR_URL });
  upsertPrStatus(
    ctx.db,
    {
      pr: { repo: 'o/r', number: 7, url: PR_URL },
      state: 'merged',
      title: 't',
      checks: 'success',
      review: 'approved',
      updatedAt: '2026-09-17T10:00:00Z',
      headRef: pr.branch,
      failedChecks: [],
    },
    '2026-09-17T10:00:00Z',
  );

  const extRow = getWorktree(ctx.db, ext.path);
  if (!extRow) throw new Error('no ext row');
  upsertWorktree(ctx.db, { ...extRow, createdByApp: false, origin: 'worktree-dir' });

  const now = new Date().toISOString();
  upsertWorktree(ctx.db, {
    path: r.dir,
    repo: r.dir,
    branch: 'main',
    base: null,
    ticket: null,
    dirty: false,
    prUrl: null,
    state: 'active',
    createdByApp: false,
    head: null,
    isMain: true,
    origin: 'config',
    sessionPks: [],
    projectId: 'wakecap',
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });

  return { ctx, svc, audit, removed, r, merged, pr, open, dirty, ext };
}

const branchExists = (r: TempRepo, branch: string) => {
  try {
    r.git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};

describe('worktree clean-up preview', () => {
  it('lists merged worktrees with the reason, skips dirty ones and never the main checkout', async () => {
    const { svc, r, merged, pr, dirty, ext } = await setup();
    const preview = await svc.cleanupPreview({});
    const byPath = (p: string) => preview.candidates.find((c) => c.path === p);
    expect(preview.candidates.map((c) => c.path).sort()).toEqual([merged.path, pr.path, ext.path].sort());
    expect(byPath(merged.path)).toEqual({
      path: merged.path,
      repo: r.dir,
      repoName: 'o/r',
      branch: merged.branch,
      reason: 'in_default_branch',
    });
    expect(byPath(ext.path)?.reason).toBe('in_default_branch');
    expect(byPath(pr.path)).toMatchObject({
      reason: 'pr_merged',
      pr: { repo: 'o/r', number: 7, url: PR_URL },
    });
    expect(preview.skipped).toEqual([
      {
        path: dirty.path,
        repo: r.dir,
        repoName: 'o/r',
        branch: dirty.branch,
        why: expect.stringContaining('uncommitted'),
      },
    ]);
    const all = [...preview.candidates, ...preview.skipped].map((c) => c.path);
    expect(all).not.toContain(r.dir);
  });

  it('gives a detached worktree its short HEAD commit', async () => {
    const { svc, r, merged } = await setup();
    const tip = r.git('rev-parse', 'refs/remotes/origin/main').trim();
    const det = `${r.dir}/.worktrees/detached-a`;
    r.git('worktree', 'add', '--detach', det, tip);
    await svc.discover();
    const preview = await svc.cleanupPreview({});
    expect(preview.candidates.find((c) => c.path === det)).toMatchObject({
      branch: '(detached)',
      head: tip.slice(0, 7),
      reason: 'in_default_branch',
    });
    expect(preview.candidates.find((c) => c.path === merged.path)).not.toHaveProperty('head');
  });

  it('skips a merged, clean worktree kept inside .git by another tool', async () => {
    const { svc, r } = await setup();
    const tip = r.git('rev-parse', 'refs/remotes/origin/main').trim();
    const tool = `${r.dir}/.git/tool/x`;
    const github = `${r.dir}/.worktrees/.github/x`;
    r.git('worktree', 'add', '--detach', tool, tip);
    r.git('worktree', 'add', '--detach', github, tip);
    await svc.discover();
    const preview = await svc.cleanupPreview({});
    expect(preview.candidates.map((c) => c.path)).not.toContain(tool);
    expect(preview.skipped.find((s) => s.path === tool)).toMatchObject({
      path: tool,
      why: 'managed by another tool (inside .git)',
    });
    expect(preview.candidates.find((c) => c.path === github)?.reason).toBe('in_default_branch');
  });

  it('resolves the default branch from origin/main when origin/HEAD is not set', async () => {
    const { svc, merged } = await setup({ originHead: false });
    const preview = await svc.cleanupPreview({});
    expect(preview.candidates.find((c) => c.path === merged.path)?.reason).toBe('in_default_branch');
  });

  it('respects the project filter', async () => {
    const { ctx, svc, merged } = await setup();
    const row = getWorktree(ctx.db, merged.path);
    if (!row) throw new Error('no row');
    upsertWorktree(ctx.db, { ...row, projectId: 'other' });
    const wakecap = await svc.cleanupPreview({ projectId: 'wakecap' });
    expect(wakecap.candidates.map((c) => c.path)).not.toContain(merged.path);
    const other = await svc.cleanupPreview({ projectId: 'other' });
    expect(other.candidates.map((c) => c.path)).toEqual([merged.path]);
  });
});

describe('worktree clean-up run', () => {
  it('re-checks each path, archives the merged clean ones and keeps their branches', async () => {
    const { ctx, svc, audit, removed, r, merged, pr, open, dirty, ext } = await setup();
    // Dirtied after the preview: the run must re-check and refuse it.
    r.write('.worktrees/feat-merged/late.txt', 'late\n');
    const out = await svc.cleanup([merged.path, pr.path, open.path, dirty.path, ext.path, r.dir]);
    const res = (p: string) => out.results.find((x) => x.path === p);

    expect(res(pr.path)).toEqual({ path: pr.path, ok: true });
    expect(res(ext.path)).toEqual({ path: ext.path, ok: true });
    for (const w of [pr, ext]) {
      expect(existsSync(w.path)).toBe(false);
      expect(getWorktree(ctx.db, w.path)?.state).toBe('archived');
      expect(branchExists(r, w.branch)).toBe(true);
    }
    expect(removed.sort()).toEqual([pr.path, ext.path].sort());

    expect(res(merged.path)).toMatchObject({ ok: false, error: expect.stringContaining('uncommitted') });
    expect(res(dirty.path)).toMatchObject({ ok: false, error: expect.stringContaining('uncommitted') });
    expect(res(open.path)).toMatchObject({ ok: false, error: expect.stringContaining('not merged') });
    expect(res(r.dir)).toMatchObject({ ok: false, error: expect.stringContaining('main checkout') });
    for (const w of [merged, dirty, open]) {
      expect(existsSync(w.path)).toBe(true);
      expect(getWorktree(ctx.db, w.path)?.state).toBe('active');
    }
    expect(existsSync(r.dir)).toBe(true);
    expect(audit.entries.find((e) => e.action === 'worktree.cleanup')).toMatchObject({
      actor: 'user',
      result: 'ok',
    });
    expect(
      audit.entries.filter((e) => e.action === 'worktree.archive' && e.result === 'ok').map((e) => e.actor),
    ).toEqual(['user', 'user']);
  });

  it('refuses a worktree kept inside .git by another tool', async () => {
    const { ctx, svc, r } = await setup();
    const tip = r.git('rev-parse', 'refs/remotes/origin/main').trim();
    const tool = `${r.dir}/.git/tool/x`;
    r.git('worktree', 'add', '--detach', tool, tip);
    await svc.discover();
    const out = await svc.cleanup([tool]);
    expect(out.results).toEqual([{ path: tool, ok: false, error: 'managed by another tool (inside .git)' }]);
    expect(existsSync(tool)).toBe(true);
    expect(getWorktree(ctx.db, tool)?.state).toBe('active');
  });

  it('reports an unknown path without throwing', async () => {
    const { svc, r } = await setup();
    const out = await svc.cleanup([`${r.root}/nope`]);
    expect(out.results).toEqual([{ path: `${r.root}/nope`, ok: false, error: expect.any(String) }]);
  });
});
