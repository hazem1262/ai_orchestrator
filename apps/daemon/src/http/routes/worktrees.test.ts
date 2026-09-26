import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext, type TestContext } from '../../../test/helpers.ts';
import { memoryAudit, stubSessions, stubTemplates } from '../../../test/stubs.ts';
import { getWorktree, upsertWorktree } from '../../db/repos/worktrees.ts';
import { createWorktreeService } from '../../services/worktree/worktree.ts';
import { worktreesRoutes } from './worktrees.ts';

let repo: TempRepo | undefined;
let ctxs: TestContext[] = [];
afterEach(() => {
  for (const c of ctxs) c.dispose();
  ctxs = [];
  repo?.cleanup();
  repo = undefined;
});

function setup() {
  const r = makeTempRepo();
  repo = r;
  const cfg = OrcConfig.parse({
    projects: [
      { id: 'wakecap', name: 'Wakecap', pathPrefixes: [r.root], repos: [{ path: r.dir, run: 'pnpm dev' }] },
    ],
    worktrees: { scratchpadRoots: [] },
  });
  const pty = recordingPty();
  const ctx = createTestContext({
    config: () => cfg,
    pty,
    audit: memoryAudit(),
    sessions: stubSessions([]),
    templates: stubTemplates(),
  });
  ctxs.push(ctx);
  // Setup-only: the real project service reads the config saved on disk, not the `config`
  // override, so the launcher's cwd -> project check is pointed at the temp repo here.
  ctx.projects = { ...ctx.projects, resolve: (c: string) => (c.startsWith(r.root) ? 'wakecap' : null) };
  ctx.worktrees = createWorktreeService(ctx, { opener: async () => {} });
  const app = worktreesRoutes(ctx);
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { ctx, app, post, pty, repo: r };
}

const createBody = (r: TempRepo) => ({
  repo: r.dir,
  base: 'main',
  type: 'feat',
  ticket: 'SAF-90',
  slug: 'routes',
  runSetup: false,
});
const wtPath = (r: TempRepo) => join(r.dir, '.worktrees', 'feat-SAF-90-routes');

describe('POST /worktrees', () => {
  it('asks for confirmation with a summary, then creates', async () => {
    const { post, repo } = setup();
    const first = await post('/worktrees', createBody(repo));
    expect(first.status).toBe(409);
    const err = (await first.json()) as {
      error: { code: string; details: { summary: string; branch: string; path: string } };
    };
    expect(err.error.code).toBe('confirmation_required');
    expect(err.error.details.summary).toContain('feat/SAF-90-routes');
    expect(err.error.details.path).toBe(wtPath(repo));
    const ok = await post('/worktrees', { ...createBody(repo), confirm: true });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { worktree: { path: string }; setupPtyId: string | null; launch: null };
    expect(body.worktree.path).toBe(wtPath(repo));
    expect(body.launch).toBeNull();
    const dup = await post('/worktrees', { ...createBody(repo), confirm: true });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('worktree_exists');
  });

  it('rejects an invalid body', async () => {
    const { post, repo } = setup();
    const r = await post('/worktrees', { repo: repo.dir, type: 'feature' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('validation_failed');
  });

  it('creates and launches a session in one call', async () => {
    const { post, pty, repo } = setup();
    const r = await post('/worktrees', {
      ...createBody(repo),
      confirm: true,
      launch: { source: 'claude', prompt: 'go', planApproval: true },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { worktree: { path: string }; launch: { ptyId: string } };
    expect(body.worktree.path).toBe(wtPath(repo));
    expect(body.launch.ptyId).toBeTruthy();
    expect(pty.spawned.at(-1)?.cwd).toBe(wtPath(repo));
  });
});

describe('worktree listing, scripts, sync and archive', () => {
  it('lists, discovers and reads one worktree', async () => {
    const { app, post, repo } = setup();
    await post('/worktrees', { ...createBody(repo), confirm: true });
    const disc = await app.request('/worktrees/discover', { method: 'POST' });
    expect(((await disc.json()) as Array<{ path: string }>).map((w) => w.path)).toEqual([
      repo.dir,
      wtPath(repo),
    ]);
    const list = await app.request('/worktrees?state=active&projectId=wakecap');
    expect(((await list.json()) as unknown[]).length).toBe(2);
    const one = await app.request(`/worktrees/one?path=${encodeURIComponent(wtPath(repo))}`);
    expect(((await one.json()) as { branch: string }).branch).toBe('feat/SAF-90-routes');
    expect((await app.request('/worktrees/one?path=%2Fnope')).status).toBe(404);
  });

  it('runs scripts, opens, previews and syncs with confirmation', async () => {
    const { post, app, pty, repo } = setup();
    await post('/worktrees', { ...createBody(repo), confirm: true });
    expect((await post('/worktrees/script', { path: wtPath(repo), which: 'run' })).status).toBe(409);
    const run = await post('/worktrees/script', { path: wtPath(repo), which: 'run', confirm: true });
    expect(await run.json()).toEqual({ ptyId: 'pty-1' });
    expect(pty.spawned[0]?.args).toEqual(['-lc', 'pnpm dev']);
    expect(
      (await post('/worktrees/script', { path: wtPath(repo), which: 'setup', confirm: true })).status,
    ).toBe(404);
    expect((await post('/worktrees/open', { path: wtPath(repo), target: 'finder' })).status).toBe(200);

    repo.write('.worktrees/feat-SAF-90-routes/src/a.ts', 'synced\n');
    const preview = await app.request(`/worktrees/sync-preview?path=${encodeURIComponent(wtPath(repo))}`);
    expect(((await preview.json()) as { files: string[] }).files).toEqual(['src/a.ts']);
    const ask = await post('/worktrees/sync', { path: wtPath(repo) });
    expect(ask.status).toBe(409);
    expect(((await ask.json()) as { error: { details: { files: string[] } } }).error.details.files).toEqual([
      'src/a.ts',
    ]);
    expect(await (await post('/worktrees/sync', { path: wtPath(repo), confirm: true })).json()).toEqual({
      files: 1,
    });
    expect(repo.read('src/a.ts')).toBe('synced\n');
  });

  it('refuses dirty archives and needs an extra flag for external worktrees', async () => {
    const { ctx, post, repo } = setup();
    await post('/worktrees', { ...createBody(repo), confirm: true });
    repo.write('.worktrees/feat-SAF-90-routes/src/a.ts', 'dirty\n');
    const dirty = await post('/worktrees/archive', { path: wtPath(repo), confirm: true });
    expect(dirty.status).toBe(409);
    expect(((await dirty.json()) as { error: { code: string } }).error.code).toBe('dirty_worktree');
    // The test's own raw git call restores the file; the daemon never runs it.
    repo.git('-C', wtPath(repo), 'checkout', 'HEAD', 'src/a.ts');

    const row = getWorktree(ctx.db, wtPath(repo));
    if (!row) throw new Error('missing');
    upsertWorktree(ctx.db, { ...row, createdByApp: false, origin: 'worktree-dir' });
    const ask = await post('/worktrees/archive', { path: wtPath(repo) });
    expect(((await ask.json()) as { error: { details: { external: boolean } } }).error.details.external).toBe(
      true,
    );
    const ext = await post('/worktrees/archive', { path: wtPath(repo), confirm: true });
    expect(((await ext.json()) as { error: { code: string } }).error.code).toBe('external_worktree');
    const ok = await post('/worktrees/archive', { path: wtPath(repo), confirm: true, confirmExternal: true });
    expect(await ok.json()).toEqual({ ok: true });
  });
});
