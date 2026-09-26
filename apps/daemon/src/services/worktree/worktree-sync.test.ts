import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { memoryAudit, stubSessions } from '../../../test/stubs.ts';
import { getWorktree, upsertWorktree } from '../../db/repos/worktrees.ts';
import { createDiffService } from '../diff/diff.ts';
import { createWorktreeService } from './worktree.ts';

let repo: TempRepo;
let disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers) d();
  disposers = [];
  repo?.cleanup();
});

async function setup() {
  repo = makeTempRepo();
  const cfg = OrcConfig.parse({
    projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root], repos: [{ path: repo.dir }] }],
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
  const svc = createWorktreeService(ctx, { now: () => new Date('2026-09-17T10:00:00.000Z') });
  const wt = await svc.create({
    repo: repo.dir,
    base: 'main',
    type: 'feat',
    ticket: 'SAF-7',
    slug: 'sync me',
  });
  const git = (...args: string[]) => repo.git('-C', wt.path, ...args);
  const write = (rel: string, body: string) =>
    repo.write(join('.worktrees', 'feat-SAF-7-sync-me', rel), body);
  return { ctx, svc, wt, audit, removed, git, write };
}

describe('sync to main', () => {
  it('previews and copies committed, uncommitted, untracked and deleted files', async () => {
    const { svc, wt, git, write } = await setup();
    write('src/a.ts', 'export const a = 42;\n');
    git('commit', '-am', 'change a');
    write('src/b.ts', 'export const b = 1;\n');
    git('rm', '-q', 'README.md');
    const preview = await svc.syncPreview(wt.path);
    expect(preview).toEqual({
      path: wt.path,
      mainPath: repo.dir,
      files: ['README.md', 'src/a.ts', 'src/b.ts'],
      mainDirty: [],
    });
    expect(await svc.syncToMain(wt.path)).toEqual({ files: 3 });
    expect(repo.read('src/a.ts')).toBe('export const a = 42;\n');
    expect(repo.read('src/b.ts')).toBe('export const b = 1;\n');
    expect(repo.exists('README.md')).toBe(false);
  });

  it('refuses when the main checkout has local edits to the same files', async () => {
    const { svc, wt, write, audit } = await setup();
    write('src/a.ts', 'from worktree\n');
    repo.write('src/a.ts', 'local edit in main\n');
    expect((await svc.syncPreview(wt.path)).mainDirty).toEqual(['src/a.ts']);
    await expect(svc.syncToMain(wt.path)).rejects.toMatchObject({ code: 'main_dirty' });
    expect(repo.read('src/a.ts')).toBe('local edit in main\n');
    expect(audit.entries.at(-1)).toMatchObject({ action: 'worktree.sync', result: 'error' });
  });
});

describe('archive', () => {
  it('refuses a dirty worktree', async () => {
    const { svc, wt, write } = await setup();
    write('src/a.ts', 'dirty\n');
    await expect(svc.archive(wt.path)).rejects.toMatchObject({ code: 'dirty_worktree' });
    expect(existsSync(wt.path)).toBe(true);
  });

  it('removes a clean worktree, keeps the branch and emits worktree.removed', async () => {
    const { ctx, svc, wt, removed, audit } = await setup();
    await svc.archive(wt.path);
    expect(existsSync(wt.path)).toBe(false);
    expect(repo.git('branch', '--list', 'feat/SAF-7-sync-me')).toContain('feat/SAF-7-sync-me');
    expect(getWorktree(ctx.db, wt.path)?.state).toBe('archived');
    expect(removed).toEqual([wt.path]);
    expect(audit.entries.map((e) => [e.action, e.result])).toContainEqual(['worktree.archive', 'ok']);
    expect(svc.list({ state: 'active' }).some((w) => w.path === wt.path)).toBe(false);
  });

  it('prunes the revert safety refs the worktree left behind', async () => {
    const { ctx, svc, wt, write } = await setup();
    write('src/a.ts', 'export const a = 42;\n');
    await createDiffService(ctx).revert(wt.path, 'src/a.ts', {});
    const reverts = () =>
      repo.git('for-each-ref', '--format=%(refname)', 'refs/orchestrator/reverts/').trim();
    expect(reverts()).toMatch(/^refs\/orchestrator\/reverts\/\S+$/);
    await svc.archive(wt.path);
    expect(existsSync(wt.path)).toBe(false);
    expect(reverts()).toBe('');
  });

  it('protects external worktrees and the main checkout', async () => {
    const { ctx, svc, wt } = await setup();
    const row = getWorktree(ctx.db, wt.path);
    if (!row) throw new Error('missing row');
    upsertWorktree(ctx.db, { ...row, createdByApp: false, origin: 'worktree-dir' });
    await expect(svc.archive(wt.path)).rejects.toMatchObject({ code: 'external_worktree' });
    await svc.archiveAs(wt.path, 'user', { allowExternal: true });
    expect(existsSync(wt.path)).toBe(false);
    upsertWorktree(ctx.db, { ...row, path: repo.dir, branch: 'main', isMain: true, createdByApp: false });
    await expect(svc.archiveAs(repo.dir, 'user', { allowExternal: true })).rejects.toMatchObject({
      code: 'is_main_checkout',
    });
    expect(readFileSync(join(repo.dir, 'README.md'), 'utf8')).toBe('# temp\n');
  });
});
