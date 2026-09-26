import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { memoryAudit, stubSessions } from '../../../test/stubs.ts';
import { createWorktreeService } from '../worktree/worktree.ts';
import { createCheckpointService } from './checkpoint.ts';

let repo: TempRepo;
let disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers) d();
  disposers = [];
  repo?.cleanup();
});

function setup(checkpointsPerSession = 200) {
  repo = makeTempRepo();
  const cfg = OrcConfig.parse({
    projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root], repos: [{ path: repo.dir }] }],
    worktrees: { checkpointsPerSession },
  });
  const audit = memoryAudit();
  const ctx = createTestContext({
    config: () => cfg,
    audit,
    pty: recordingPty(),
    sessions: stubSessions([]),
  });
  disposers.push(() => ctx.dispose());
  let tick = 0;
  const svc = createCheckpointService(ctx, { now: () => new Date(Date.UTC(2026, 8, 17, 10, 0, tick++)) });
  const state = () => ({
    head: repo.git('rev-parse', 'HEAD').trim(),
    symbolic: repo.git('symbolic-ref', 'HEAD').trim(),
    staged: repo.git('diff', '--cached'),
    status: repo.git('status', '--porcelain=v1'),
    stash: repo.git('stash', 'list'),
    indexHash: repo.git('ls-files', '-s'),
  });
  return { ctx, svc, audit, state };
}

describe('CheckpointService.create', () => {
  it('snapshots staged, unstaged and untracked files without touching HEAD, index or stash', async () => {
    const { svc, state, audit } = setup();
    repo.write('stash-me.txt', 'x\n');
    repo.git('add', 'stash-me.txt');
    repo.git('stash', 'push', '-m', 'keep me');
    repo.write('src/a.ts', 'export const a = 100;\n');
    repo.git('add', 'src/a.ts');
    repo.write('src/a.ts', 'export const a = 200;\n');
    repo.write('src/new.ts', 'export const n = 1;\n');
    repo.write('.env', 'SECRET=ignored\n');
    const before = state();

    const cp = await svc.create('claude:sess-1', repo.dir, 1);

    expect(state()).toEqual(before);
    expect(cp).toMatchObject({
      sessionId: 'sess-1',
      turn: 1,
      kind: 'turn',
      ref: 'refs/orchestrator/checkpoints/sess-1/1',
      worktreePath: repo.dir,
    });
    expect(repo.git('rev-parse', cp.ref).trim()).toBe(cp.commit);
    expect(repo.git('show', `${cp.ref}:src/a.ts`)).toBe('export const a = 200;\n');
    expect(repo.git('show', `${cp.ref}:src/new.ts`)).toBe('export const n = 1;\n');
    expect(() => repo.git('show', `${cp.ref}:.env`)).toThrow();
    expect(repo.git('rev-parse', `${cp.commit}^`).trim()).toBe(before.head);
    expect(audit.entries.map((e) => [e.action, e.actor, e.result])).toEqual([
      ['checkpoint.create', 'automation', 'ok'],
    ]);
  });

  it('replaces a checkpoint for the same turn and enforces the per-session cap', async () => {
    const { svc } = setup(2);
    await svc.create('claude:s', repo.dir, 1);
    repo.write('src/a.ts', 'v2\n');
    const again = await svc.create('claude:s', repo.dir, 1);
    expect(svc.list('claude:s')).toHaveLength(1);
    expect(repo.git('show', `${again.ref}:src/a.ts`)).toBe('v2\n');
    await svc.create('claude:s', repo.dir, 2);
    await svc.create('claude:s', repo.dir, 3);
    expect(svc.list('claude:s').map((c) => c.turn)).toEqual([2, 3]);
    expect(repo.git('for-each-ref', 'refs/orchestrator/checkpoints/s/1')).toBe('');
  });
});

describe('CheckpointService.diff', () => {
  it('diffs two checkpoints and a checkpoint against the live worktree', async () => {
    const { svc } = setup();
    const one = await svc.create('claude:s', repo.dir, 1);
    repo.write('src/a.ts', 'export const a = 2;\nexport const b = 2;\nexport const c = 3;\n');
    const two = await svc.create('claude:s', repo.dir, 2);
    const between = await svc.diff(one.ref, two.ref, repo.dir);
    expect(between).toContain('-export const a = 1;');
    expect(between).toContain('+export const a = 2;');
    repo.write('src/untracked.ts', 'u\n');
    const live = await svc.diff(two.ref, 'WORKTREE', repo.dir);
    expect(live).toContain('+++ b/src/untracked.ts');
    expect(repo.git('status', '--porcelain=v1')).toContain('?? src/untracked.ts');
  });
});

describe('CheckpointService.rewind', () => {
  it('takes a safety checkpoint, restores files and keeps HEAD and the index', async () => {
    const { svc, state, audit } = setup();
    repo.write('src/a.ts', 'turn one\n');
    const one = await svc.create('claude:s', repo.dir, 1);
    repo.write('src/a.ts', 'turn two\n');
    repo.write('src/later.ts', 'created later\n');
    repo.write('README.md', '# staged\n');
    repo.git('add', 'README.md');
    const before = state();

    const safety = await svc.rewind(one.id);

    expect(repo.read('src/a.ts')).toBe('turn one\n');
    expect(repo.exists('src/later.ts')).toBe(false);
    expect(repo.read('README.md')).toBe('# temp\n');
    expect(repo.git('show', ':README.md')).toBe('# staged\n');
    expect(safety.kind).toBe('safety');
    expect(repo.git('show', `${safety.ref}:src/later.ts`)).toBe('created later\n');
    const after = state();
    expect(after.head).toBe(before.head);
    expect(after.symbolic).toBe(before.symbolic);
    expect(after.indexHash).toBe(before.indexHash);
    expect(after.stash).toBe(before.stash);
    expect(audit.entries.map((e) => e.action)).toEqual([
      'checkpoint.create',
      'checkpoint.create',
      'checkpoint.rewind',
    ]);
  });

  it('fails for an unknown id', async () => {
    const { svc } = setup();
    await expect(svc.rewind('nope')).rejects.toThrow(/not_found/);
  });
});

describe('pruning', () => {
  it('deletes refs and rows when a worktree is archived', async () => {
    const { ctx, svc } = setup();
    const wts = createWorktreeService(ctx);
    const wt = await wts.createWith(
      { repo: repo.dir, base: 'main', type: 'feat', ticket: 'SAF-5', slug: 'prune' },
      { runSetup: false, actor: 'user' },
    );
    await svc.create('claude:p', wt.view.path, 1);
    await svc.create('claude:p', wt.view.path, 2);
    await wts.archive(wt.view.path);
    await vi.waitFor(
      () => {
        expect(svc.list('claude:p')).toEqual([]);
        expect(repo.git('for-each-ref', 'refs/orchestrator/')).toBe('');
      },
      { timeout: 5000 },
    );
  });
});
