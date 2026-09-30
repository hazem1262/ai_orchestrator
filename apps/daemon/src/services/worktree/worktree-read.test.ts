import { join } from 'node:path';
import { type LiveEvent, OrcConfig } from '@orc/api-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeGh, type FakePr, useFakeGh } from '../../../test/fake-gh.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { makeSession, recordingInbox, stubSessions } from '../../../test/stubs.ts';
import { upsertPrStatus } from '../../db/repos/pr-cache.ts';
import { getWorktree, upsertWorktree } from '../../db/repos/worktrees.ts';
import type { ProjectServiceImpl } from '../projects.ts';
import {
  discoverWorktrees,
  findWorktreeByCwd,
  getWorktreeView,
  githubSlugFromRemote,
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

type PrRef = { repo: string; number: number; url: string };
const ref = (repo: string, number: number): PrRef => ({
  repo,
  number,
  url: `https://github.com/${repo}/pull/${number}`,
});

function setup(opts: { origin?: string; prs?: PrRef[]; inbox?: ReturnType<typeof recordingInbox> } = {}) {
  repo = makeTempRepo();
  if (opts.origin) repo.git('remote', 'add', 'origin', opts.origin);
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
    makeSession({ id: 'in-wt', startCwd: join(wt, 'src'), cwds: [join(wt, 'src')], prs: opts.prs ?? [] }),
    makeSession({ id: 'in-main', startCwd: repo.dir, cwds: [repo.dir] }),
  ]);
  const ctx = createTestContext({
    config: () => cfg,
    sessions,
    projects,
    ...(opts.inbox ? { inbox: opts.inbox } : {}),
  });
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

describe('discoverWorktrees PR linking across repos', () => {
  let fake: FakeGh;
  beforeEach(() => {
    fake = useFakeGh({ prs: {} });
  });
  afterEach(() => fake.restore());

  const ghPr = (number: number, headRefName: string, state: FakePr['state'] = 'OPEN'): FakePr => ({
    repo: 'o/r',
    number,
    url: `https://github.com/o/r/pull/${number}`,
    title: `pr ${number}`,
    state,
    headRefName,
    baseRefName: 'main',
    body: '',
    updatedAt: '2026-09-17T08:00:00Z',
    reviewDecision: '',
    statusCheckRollup: [],
  });
  const prListCalls = () => fake.calls().filter((c) => c[0] === 'pr' && c[1] === 'list');

  const cached = (ctx: ReturnType<typeof setup>['ctx'], r: PrRef, updatedAt: string) =>
    upsertPrStatus(
      ctx.db,
      {
        pr: r,
        state: 'open',
        title: 't',
        checks: 'success',
        review: 'approved',
        updatedAt,
        headRef: 'feat/SAF-9-thing',
        failedChecks: [],
      },
      updatedAt,
    );

  it('does not stamp a session PR from a different repo on the worktree', async () => {
    const { d, wt } = setup({ origin: 'git@github.com:o/r.git', prs: [ref('o/other', 93)] });
    await discoverWorktrees(d);
    expect(getWorktreeView(d, wt)?.prUrl).toBeNull();
  });

  it('stamps the first session PR from the worktree own repo', async () => {
    const { d, wt } = setup({
      origin: 'https://github.com/o/r.git',
      prs: [ref('o/other', 93), ref('o/r', 7), ref('o/r', 8)],
    });
    await discoverWorktrees(d);
    expect(getWorktreeView(d, wt)?.prUrl).toBe('https://github.com/o/r/pull/7');
  });

  it('does not use session PRs when the worktree repo slug is unknown', async () => {
    const { d, wt } = setup({ prs: [ref('o/r', 7)] });
    await discoverWorktrees(d);
    expect(getWorktreeView(d, wt)?.prUrl).toBeNull();
  });

  it('only links a branch-matched PR from the worktree own repo', async () => {
    const { ctx, d, wt } = setup({ origin: 'git@github.com:o/r.git' });
    cached(ctx, ref('o/r', 5), '2026-09-17T09:00:00Z');
    cached(ctx, ref('o/other', 6), '2026-09-17T09:30:00Z');
    await discoverWorktrees(d);
    expect(getWorktreeView(d, wt)?.prUrl).toBe('https://github.com/o/r/pull/5');
    expect(getWorktreeView(d, wt)?.prStatus?.pr.repo).toBe('o/r');
  });

  it('drops a stored PR link from a different repo and re-derives it', async () => {
    const { ctx, d, wt } = setup({ origin: 'git@github.com:o/r.git' });
    await discoverWorktrees(d);
    const row = getWorktree(ctx.db, wt);
    if (!row) throw new Error('no row');
    upsertWorktree(ctx.db, { ...row, prUrl: 'https://github.com/o/other/pull/93' });
    await discoverWorktrees(d);
    expect(getWorktree(ctx.db, wt)?.prUrl).toBeNull();

    upsertWorktree(ctx.db, { ...row, prUrl: 'https://github.com/o/other/pull/93' });
    cached(ctx, ref('o/r', 5), '2026-09-17T09:00:00Z');
    await discoverWorktrees(d);
    expect(getWorktree(ctx.db, wt)?.prUrl).toBe('https://github.com/o/r/pull/5');
  });

  it("links the branch's own PR from GitHub over a same-repo session PR", async () => {
    const { d, wt } = setup({ origin: 'git@github.com:o/r.git', prs: [ref('o/r', 7)] });
    fake.setPr(ghPr(7, 'feat/SAF-9-other'));
    fake.setPr(ghPr(12, 'feat/SAF-9-thing', 'MERGED'));
    await discoverWorktrees(d);
    expect(getWorktreeView(d, wt)?.prUrl).toBe('https://github.com/o/r/pull/12');
  });

  it('asks GitHub once per worktree branch, not on every discovery', async () => {
    const { d, wt } = setup({ origin: 'git@github.com:o/r.git', prs: [ref('o/r', 7)] });
    await discoverWorktrees(d);
    await discoverWorktrees(d);
    expect(getWorktreeView(d, wt)?.prUrl).toBe('https://github.com/o/r/pull/7');
    expect(prListCalls()).toEqual([
      [
        'pr',
        'list',
        '-R',
        'o/r',
        '--head',
        'feat/SAF-9-thing',
        '--state',
        'all',
        '--limit',
        '1',
        '--json',
        expect.any(String),
      ],
    ]);
  });

  it('re-derives a stored link whose PR head is another branch and resolves its archive_blocked row', async () => {
    const inbox = recordingInbox();
    const { ctx, d, wt } = setup({ origin: 'git@github.com:o/r.git', inbox });
    await discoverWorktrees(d);
    const row = getWorktree(ctx.db, wt);
    if (!row) throw new Error('no row');
    const wrong = ref('o/r', 7);
    upsertWorktree(ctx.db, { ...row, prUrl: wrong.url });
    upsertPrStatus(
      ctx.db,
      {
        pr: wrong,
        state: 'merged',
        title: 't',
        checks: 'success',
        review: 'approved',
        updatedAt: '2026-09-17T09:00:00Z',
        headRef: 'feat/SAF-9-other',
        failedChecks: [],
      },
      '2026-09-17T09:00:00Z',
    );
    inbox.upsert({
      kind: 'pr_event',
      scope: { domain: 'worktree', id: wt },
      facet: 'archive_blocked',
      reason: 'o/r#7 merged; worktree kept',
      payload: { pr: wrong, event: 'archive_blocked', path: wt, presetId: null, vars: {} },
    });
    fake.setPr(ghPr(12, 'feat/SAF-9-thing'));
    await discoverWorktrees(d);
    expect(getWorktree(ctx.db, wt)?.prUrl).toBe('https://github.com/o/r/pull/12');
    expect(inbox.list({ state: ['open'], kind: ['pr_event'] })).toEqual([]);

    await discoverWorktrees(d);
    expect(prListCalls()).toHaveLength(2);
  });

  it('keeps the session PR when gh is unavailable', async () => {
    const { d, wt } = setup({ origin: 'git@github.com:o/r.git', prs: [ref('o/r', 7)] });
    fake.setState({ authed: false });
    fake.setPr(ghPr(12, 'feat/SAF-9-thing'));
    await discoverWorktrees(d);
    expect(getWorktreeView(d, wt)?.prUrl).toBe('https://github.com/o/r/pull/7');
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

describe('githubSlugFromRemote', () => {
  it('parses GitHub remote URLs', () => {
    expect(githubSlugFromRemote('git@github.com:o/r.git')).toBe('o/r');
    expect(githubSlugFromRemote('https://github.com/o/r.git')).toBe('o/r');
    expect(githubSlugFromRemote('https://github.com/o/r')).toBe('o/r');
    expect(githubSlugFromRemote('ssh://git@github.com/o/r.git')).toBe('o/r');
    expect(githubSlugFromRemote('/tmp/remote.git')).toBeNull();
    expect(githubSlugFromRemote('')).toBeNull();
  });
});

describe('prRepoSlug', () => {
  it('parses GitHub PR URLs', () => {
    expect(prRepoSlug('https://github.com/o/r/pull/5')).toEqual({ repo: 'o/r', number: 5 });
    expect(prRepoSlug(null)).toBeNull();
    expect(prRepoSlug('https://example.com/x')).toBeNull();
  });
});
