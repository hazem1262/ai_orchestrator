import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import type { LiveState } from '@orc/core';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext, type TestContext } from '../../../test/helpers.ts';
import { makeSession, memoryAudit, stubSessions } from '../../../test/stubs.ts';
import { createCheckpointService } from '../../services/checkpoint/checkpoint.ts';
import { createDiffService } from '../../services/diff/diff.ts';
import { createReviewService } from '../../services/review/review.ts';
import { createWorktreeService } from '../../services/worktree/worktree.ts';
import { reviewRoutes } from './review.ts';

let repo: TempRepo | undefined;
const contexts: TestContext[] = [];
afterEach(() => {
  for (const c of contexts.splice(0)) c.dispose();
  repo?.cleanup();
  repo = undefined;
});

const owned: LiveState = {
  pid: 1,
  status: 'idle',
  waitingFor: null,
  since: '2026-09-17T10:00:00Z',
  ownership: 'owned',
  ptyId: 'pty-r',
  stage: null,
  currentTool: null,
  backgroundJobs: 0,
  runningSubagents: 0,
  contextFill: null,
};

async function setup() {
  const r = makeTempRepo();
  repo = r;
  const cfg = OrcConfig.parse({
    projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [r.root], repos: [{ path: r.dir }] }],
  });
  const wt = join(r.dir, '.worktrees', 'feat-SAF-95-review');
  const sessions = stubSessions([
    makeSession({ id: 'r1', startCwd: wt, cwds: [wt], promptCount: 3, live: owned }),
  ]);
  const pty = recordingPty();
  const ctx = createTestContext({ config: () => cfg, sessions, pty, audit: memoryAudit() });
  contexts.push(ctx);
  ctx.worktrees = createWorktreeService(ctx);
  ctx.checkpoints = createCheckpointService(ctx);
  ctx.diff = createDiffService(ctx);
  ctx.review = createReviewService(ctx);
  await ctx.worktrees.createWith(
    { repo: r.dir, base: 'main', type: 'feat', ticket: 'SAF-95', slug: 'review' },
    { runSetup: false, actor: 'user' },
  );
  const app: Hono = reviewRoutes(ctx);
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const write = (rel: string, body: string) => r.write(join('.worktrees', 'feat-SAF-95-review', rel), body);
  return { ctx, app, post, wt, write, pty, repo: r };
}

describe('diff routes', () => {
  it('returns the worktree diff and reverts with confirmation', async () => {
    const { app, post, wt, write, repo } = await setup();
    write('src/a.ts', 'changed\n');
    const d = await app.request(`/diff?cwd=${encodeURIComponent(wt)}`);
    const body = (await d.json()) as { files: Array<{ path: string }>; to: string };
    expect(body.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(body.to).toBe('WORKTREE');
    const ask = await post('/diff/revert', { cwd: wt, file: 'src/a.ts' });
    expect(ask.status).toBe(409);
    expect(
      ((await ask.json()) as { error: { details: { summary: string } } }).error.details.summary,
    ).toContain('src/a.ts');
    expect(await (await post('/diff/revert', { cwd: wt, file: 'src/a.ts', confirm: true })).json()).toEqual({
      reverted: 'src/a.ts',
    });
    expect(repo.read('.worktrees/feat-SAF-95-review/src/a.ts')).toContain('export const a = 1;');
  });
});

describe('checkpoint routes', () => {
  it('creates, lists, diffs and rewinds checkpoints', async () => {
    const { app, post, write, repo } = await setup();
    expect((await post('/checkpoints', { sessionPk: 'claude:r1' })).status).toBe(409);
    write('src/a.ts', 'turn A\n');
    const first = (await (await post('/checkpoints', { sessionPk: 'claude:r1', confirm: true })).json()) as {
      id: string;
      kind: string;
      turn: number;
    };
    expect(first).toMatchObject({ kind: 'manual', turn: 3 });
    write('src/a.ts', 'turn B\n');
    const second = (await (await post('/checkpoints', { sessionPk: 'claude:r1', confirm: true })).json()) as {
      id: string;
    };
    const list = (await (await app.request('/checkpoints?sessionPk=claude%3Ar1')).json()) as unknown[];
    expect(list).toHaveLength(2);
    const d = (await (await app.request(`/checkpoints/${second.id}/diff`)).json()) as {
      files: Array<{ path: string; additions: number }>;
    };
    expect(d.files).toEqual([expect.objectContaining({ path: 'src/a.ts', additions: 1 })]);
    expect((await post(`/checkpoints/${first.id}/rewind`, {})).status).toBe(409);
    const rw = (await (await post(`/checkpoints/${first.id}/rewind`, { confirm: true })).json()) as {
      safety: { kind: string };
    };
    expect(rw.safety.kind).toBe('safety');
    expect(repo.read('.worktrees/feat-SAF-95-review/src/a.ts')).toBe('turn A\n');
    expect((await post('/checkpoints/nope/rewind', { confirm: true })).status).toBe(404);
  });
});

describe('review routes', () => {
  it('returns the summary and sends comments only with confirmation', async () => {
    const { app, post, write, pty } = await setup();
    write('src/a.ts', 'x\n');
    const s = (await (await app.request('/review/claude/r1')).json()) as { owned: boolean; files: unknown[] };
    expect(s.owned).toBe(true);
    expect(s.files).toHaveLength(1);
    const comments = [{ file: 'src/a.ts', line: 1, side: 'new', body: 'why x?' }];
    const text = (await (await post('/review/claude/r1/comments', { comments, deliver: 'text' })).json()) as {
      sent: boolean;
      text: string;
    };
    expect(text.sent).toBe(false);
    expect((await post('/review/claude/r1/comments', { comments, deliver: 'session' })).status).toBe(409);
    const sent = (await (
      await post('/review/claude/r1/comments', { comments, deliver: 'session', confirm: true })
    ).json()) as { sent: boolean };
    expect(sent.sent).toBe(true);
    expect(pty.texts).toHaveLength(1);
    expect((await app.request('/review/claude/missing')).status).toBe(404);
  });
});
