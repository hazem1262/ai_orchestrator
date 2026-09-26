import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import type { LiveState } from '@orc/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { makeSession, memoryAudit, stubSessions } from '../../../test/stubs.ts';
import { createWorktreeService } from '../worktree/worktree.ts';
import { createCheckpointService } from './checkpoint.ts';
import { registerCheckpointHook } from './turn-hook.ts';

let repo: TempRepo;
let disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers) d();
  disposers = [];
  repo?.cleanup();
});

const live = (ownership: LiveState['ownership']): LiveState => ({
  pid: 1,
  status: 'idle',
  waitingFor: null,
  since: '2026-09-17T10:00:00.000Z',
  ownership,
  ptyId: ownership === 'owned' ? 'pty-9' : null,
  stage: null,
  currentTool: null,
  backgroundJobs: 0,
  runningSubagents: 0,
  contextFill: null,
});

const flush = () => new Promise((r) => setTimeout(r, 100));

describe('registerCheckpointHook', () => {
  it('checkpoints owned sessions inside an app worktree only', async () => {
    repo = makeTempRepo();
    const cfg = OrcConfig.parse({
      projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root], repos: [{ path: repo.dir }] }],
    });
    const wtPath = join(repo.dir, '.worktrees', 'feat-SAF-8-hook');
    const sessions = stubSessions([
      makeSession({
        id: 'owned',
        startCwd: wtPath,
        cwds: [wtPath, join(wtPath, 'src')],
        live: live('owned'),
      }),
      makeSession({ id: 'observed', startCwd: wtPath, cwds: [wtPath], live: live('observed') }),
      makeSession({ id: 'main', startCwd: repo.dir, cwds: [repo.dir], live: live('owned') }),
    ]);
    const ctx = createTestContext({ config: () => cfg, sessions, audit: memoryAudit(), pty: recordingPty() });
    disposers.push(() => ctx.dispose());
    ctx.worktrees = createWorktreeService(ctx);
    ctx.checkpoints = createCheckpointService(ctx);
    await ctx.worktrees.create({ repo: repo.dir, base: 'main', type: 'feat', ticket: 'SAF-8', slug: 'hook' });
    await ctx.worktrees.discover();
    const off = registerCheckpointHook(ctx);

    ctx.bus.emit({ type: 'session.turnEnded', pk: 'claude:owned', turn: 1 });
    ctx.bus.emit({ type: 'session.turnEnded', pk: 'claude:observed', turn: 1 });
    ctx.bus.emit({ type: 'session.turnEnded', pk: 'claude:main', turn: 1 });
    await vi.waitFor(() => expect(ctx.checkpoints?.list('claude:owned')).toHaveLength(1), { timeout: 5000 });
    await flush();

    expect(ctx.checkpoints.list('claude:owned')).toHaveLength(1);
    expect(ctx.checkpoints.list('claude:observed')).toHaveLength(0);
    expect(ctx.checkpoints.list('claude:main')).toHaveLength(0);
    off();
  });
});
