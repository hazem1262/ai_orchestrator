import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import type { LiveState } from '@orc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { makeSession, memoryAudit, stubSessions } from '../../../test/stubs.ts';
import { upsertPrStatus } from '../../db/repos/pr-cache.ts';
import { createCheckpointService } from '../checkpoint/checkpoint.ts';
import { createDiffService } from '../diff/diff.ts';
import { createWorktreeService } from '../worktree/worktree.ts';
import { createReviewService } from './review.ts';

let repo: TempRepo | undefined;
let disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers) d();
  disposers = [];
  repo?.cleanup();
  repo = undefined;
});

const owned: LiveState = {
  pid: 1,
  status: 'idle',
  waitingFor: null,
  since: '2026-09-17T10:00:00.000Z',
  ownership: 'owned',
  ptyId: 'pty-7',
  stage: 'review',
  currentTool: null,
  backgroundJobs: 0,
  runningSubagents: 0,
  contextFill: 0.2,
};

async function setup() {
  repo = makeTempRepo();
  const cfg = OrcConfig.parse({
    projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root], repos: [{ path: repo.dir }] }],
  });
  const wtPath = join(repo.dir, '.worktrees', 'feat-SAF-20-review');
  const sessions = stubSessions([
    makeSession({
      id: 'own',
      startCwd: wtPath,
      cwds: [wtPath],
      recap: 'Changed a.ts; token ghp_abcdefghijklmnopqrstuvwxyz0123456789 used',
      lastTest: {
        ts: '2026-09-17T10:00:00.000Z',
        command: 'pnpm test',
        passed: 10,
        failed: 1,
        skipped: 0,
        durationMs: 1200,
      },
      prs: [{ repo: 'o/r', number: 20, url: 'https://github.com/o/r/pull/20' }],
      live: owned,
    }),
    makeSession({
      id: 'watch',
      startCwd: wtPath,
      cwds: [wtPath],
      live: { ...owned, ownership: 'observed', ptyId: null },
    }),
    makeSession({ id: 'nogit', startCwd: repo.root, cwds: [repo.root] }),
  ]);
  const pty = recordingPty();
  const audit = memoryAudit();
  const ctx = createTestContext({ config: () => cfg, sessions, pty, audit });
  disposers.push(() => ctx.dispose());
  ctx.worktrees = createWorktreeService(ctx);
  ctx.checkpoints = createCheckpointService(ctx);
  ctx.diff = createDiffService(ctx);
  await ctx.worktrees.createWith(
    { repo: repo.dir, base: 'main', type: 'feat', ticket: 'SAF-20', slug: 'review' },
    { runSetup: false, actor: 'user' },
  );
  repo.write('.worktrees/feat-SAF-20-review/src/a.ts', 'export const a = 5;\n');
  upsertPrStatus(
    ctx.db,
    {
      pr: { repo: 'o/r', number: 20, url: 'https://github.com/o/r/pull/20' },
      state: 'open',
      title: 'SAF-20',
      checks: 'failure',
      review: 'changes_requested',
      updatedAt: '2026-09-17T10:00:00Z',
      headRef: 'feat/SAF-20-review',
      failedChecks: ['unit'],
    },
    '2026-09-17T10:00:00Z',
  );
  await ctx.checkpoints.create('claude:own', wtPath, 1);
  return { ctx, pty, audit, svc: createReviewService(ctx), wtPath };
}

describe('ReviewService.summary', () => {
  it('collects files, totals, tests, redacted recap, PR, ownership and checkpoints', async () => {
    const { svc, wtPath } = await setup();
    const s = await svc.summary('claude', 'own');
    expect(s.sessionPk).toBe('claude:own');
    expect(s.cwd).toBe(wtPath);
    expect(s.worktree?.branch).toBe('feat/SAF-20-review');
    expect(s.files).toEqual([{ path: 'src/a.ts', additions: 1, deletions: 3 }]);
    expect(s.additions).toBe(1);
    expect(s.deletions).toBe(3);
    expect(s.lastTest?.failed).toBe(1);
    expect(s.recap).toBe('Changed a.ts; token «redacted:github» used');
    expect(s.pr).toMatchObject({ checks: 'failure', failedChecks: ['unit'] });
    expect(s.owned).toBe(true);
    expect(s.checkpoints).toHaveLength(1);
  });

  it('handles a missing recap and an observed session', async () => {
    const { svc } = await setup();
    const s = await svc.summary('claude', 'watch');
    expect(s.recap).toBeNull();
    expect(s.owned).toBe(false);
    expect(s.pr?.pr.number).toBe(20);
  });

  it('fails clearly for unknown sessions and non-git cwds', async () => {
    const { svc } = await setup();
    await expect(svc.summary('claude', 'missing')).rejects.toMatchObject({ code: 'not_found' });
    await expect(svc.summary('claude', 'nogit')).rejects.toMatchObject({ code: 'no_worktree' });
  });
});

describe('ReviewService.sendComments', () => {
  const comments = [{ file: 'src/a.ts', line: 1, side: 'new' as const, body: 'use a constant' }];

  it('sends the structured prompt to an owned session and audits it', async () => {
    const { svc, pty, audit } = await setup();
    const r = await svc.sendComments('claude', 'own', comments, 'session');
    expect(r.sent).toBe(true);
    expect(r.text).toContain('1. src/a.ts:1\n   use a constant');
    expect(r.text).toContain('(branch feat/SAF-20-review)');
    expect(pty.texts).toEqual([{ id: 'pty-7', text: r.text }]);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'review.send', target: 'claude:own', result: 'ok' });
  });

  it('returns text for observed sessions and for text delivery', async () => {
    const { svc, pty } = await setup();
    expect((await svc.sendComments('claude', 'watch', comments, 'session')).sent).toBe(false);
    expect((await svc.sendComments('claude', 'own', comments, 'text')).sent).toBe(false);
    expect(pty.texts).toEqual([]);
  });
});
