import { join } from 'node:path';
import { type LiveEvent, OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { makeSession, stubSessions } from '../../../test/stubs.ts';
import { upsertPrStatus } from '../../db/repos/pr-cache.ts';
import { getWorktree, upsertWorktree } from '../../db/repos/worktrees.ts';
import type { ProjectServiceImpl } from '../projects.ts';
import {
  discoverWorktrees,
  findWorktreeByCwd,
  getWorktreeView,
  listWorktreeViews,
  prRepoSlug,
  type WorktreeDeps,
} from './worktree-read.ts';

let repo: TempRepo;
let disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers) d();
  disposers = [];
  repo.cleanup();
});

function setup() {
  repo = makeTempRepo();
  const wt = join(repo.dir, '.worktrees', 'feat-SAF-9-thing');
  repo.git('worktree', 'add', '-b', 'feat/SAF-9-thing', wt, 'main');
  const cfg = OrcConfig.parse({
    projects: [
      {
        id: 'wakecap',
        name: 'Wakecap',
        pathPrefixes: [repo.root],
        ticketRegex: '\\bSAF-\\d+\\b',
        repos: [{ path: repo.dir }],
      },
    ],
    worktrees: { scratchpadRoots: [], scanSiblings: false },
  });
  const unused = () => {
    throw new Error('unused');
  };
  const projects: ProjectServiceImpl = {
    list: () => [],
    resolve: (cwd) => (cwd.startsWith(repo.root) ? 'wakecap' : null),
    get: (id) => (id === 'wakecap' ? (cfg.projects[0] ?? null) : null),
    update: unused,
    ensureDefaults: unused,
    ensureDetected: unused,
    deriveConfigFor: unused,
    syncTable: unused,
  };
  const sessions = stubSessions([
    makeSession({ id: 'in-wt', startCwd: join(wt, 'src'), cwds: [join(wt, 'src')] }),
    makeSession({ id: 'in-main', startCwd: repo.dir, cwds: [repo.dir] }),
  ]);
  const ctx = createTestContext({ config: () => cfg, sessions, projects });
  disposers.push(() => ctx.dispose());
  const events: LiveEvent[] = [];
  ctx.bus.on('worktree.updated', (e) => events.push(e));
  ctx.bus.on('worktree.removed', (e) => events.push(e));
  const d: WorktreeDeps = {
    ctx,
    now: () => new Date('2026-09-17T10:00:00.000Z'),
    claudeJson: join(repo.root, 'none.json'),
  };
  return { ctx, d, wt, events };
}

describe('discoverWorktrees', () => {
  it('persists views with ticket, project, dirty state and linked sessions', async () => {
    const { d, wt, events } = setup();
    repo.write('.worktrees/feat-SAF-9-thing/src/a.ts', 'changed\n');
    const views = await discoverWorktrees(d);
    const view = views.find((v) => v.path === wt);
    expect(view).toMatchObject({
      repo: repo.dir,
      branch: 'feat/SAF-9-thing',
      ticket: 'SAF-9',
      projectId: 'wakecap',
      dirty: true,
      createdByApp: false,
      origin: 'worktree-dir',
      sessionPks: ['claude:in-wt'],
      state: 'active',
    });
    expect(views.find((v) => v.isMain)?.sessionPks).toEqual(['claude:in-main']);
    expect(events.filter((e) => e.type === 'worktree.updated')).toHaveLength(2);

    await discoverWorktrees(d);
    expect(events.filter((e) => e.type === 'worktree.updated')).toHaveLength(2);
  });

  it('keeps app ownership and base, and links a cached PR by branch', async () => {
    const { ctx, d, wt } = setup();
    upsertWorktree(ctx.db, {
      path: wt,
      repo: repo.dir,
      branch: 'feat/SAF-9-thing',
      base: 'main',
      ticket: 'SAF-9',
      dirty: false,
      prUrl: null,
      state: 'active',
      createdByApp: true,
      head: null,
      isMain: false,
      origin: 'app',
      sessionPks: [],
      projectId: 'wakecap',
      createdAt: '2026-09-17T09:00:00.000Z',
      updatedAt: '2026-09-17T09:00:00.000Z',
      archivedAt: null,
    });
    upsertPrStatus(
      ctx.db,
      {
        pr: { repo: 'o/r', number: 5, url: 'https://github.com/o/r/pull/5' },
        state: 'open',
        title: 't',
        checks: 'success',
        review: 'approved',
        updatedAt: '2026-09-17T09:30:00Z',
        headRef: 'feat/SAF-9-thing',
        failedChecks: [],
      },
      '2026-09-17T09:30:00Z',
    );
    await discoverWorktrees(d);
    const v = getWorktreeView(d, wt);
    expect(v).toMatchObject({
      createdByApp: true,
      base: 'main',
      origin: 'app',
      prUrl: 'https://github.com/o/r/pull/5',
    });
    expect(v?.prStatus?.checks).toBe('success');
  });

  it('archives rows whose folder disappeared and emits worktree.removed', async () => {
    const { ctx, d, wt, events } = setup();
    await discoverWorktrees(d);
    repo.git('worktree', 'remove', wt);
    await discoverWorktrees(d);
    expect(getWorktree(ctx.db, wt)?.state).toBe('archived');
    expect(events.some((e) => e.type === 'worktree.removed' && e.path === wt)).toBe(true);
    expect(listWorktreeViews(d, { state: 'active' }).map((v) => v.path)).toEqual([repo.dir]);
  });
});

describe('findWorktreeByCwd', () => {
  it('picks the longest active worktree prefix', async () => {
    const { d, wt } = setup();
    await discoverWorktrees(d);
    expect(findWorktreeByCwd(d, join(wt, 'src'))?.path).toBe(wt);
    expect(findWorktreeByCwd(d, join(repo.dir, 'src'))?.path).toBe(repo.dir);
    expect(findWorktreeByCwd(d, '/elsewhere')).toBeNull();
  });
});

describe('prRepoSlug', () => {
  it('parses GitHub PR URLs', () => {
    expect(prRepoSlug('https://github.com/o/r/pull/5')).toEqual({ repo: 'o/r', number: 5 });
    expect(prRepoSlug(null)).toBeNull();
    expect(prRepoSlug('https://example.com/x')).toBeNull();
  });
});
