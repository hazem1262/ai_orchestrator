import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import type { LiveState } from '@orc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeGh, useFakeGh } from '../../../test/fake-gh.ts';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext, type TestContext } from '../../../test/helpers.ts';
import {
  makeSession,
  memoryAudit,
  recordingInbox,
  stubSessions,
  stubTemplates,
} from '../../../test/stubs.ts';
import { createGithubConnector } from '../../connectors/github/github.ts';
import { createPlanApprovalService } from '../../services/review/plan-approval.ts';
import { createShipService } from '../../services/ship/ship.ts';
import { createWorktreeService } from '../../services/worktree/worktree.ts';
import { planRoutes } from './plan.ts';
import { shipRoutes } from './ship.ts';

let repo: TempRepo | undefined;
let fake: FakeGh | undefined;
const contexts: TestContext[] = [];
afterEach(() => {
  for (const c of contexts.splice(0)) c.dispose();
  repo?.cleanup();
  repo = undefined;
  fake?.restore();
  fake = undefined;
});

const owned: LiveState = {
  pid: 1,
  status: 'waiting',
  waitingFor: null,
  since: '2026-09-17T10:00:00Z',
  ownership: 'owned',
  ptyId: 'pty-p',
  stage: null,
  currentTool: 'ExitPlanMode',
  backgroundJobs: 0,
  runningSubagents: 0,
  contextFill: null,
};

// SUPERSEDED CALL SHAPE: inbox items are keyed by kind + scope (+ facet); the engine composes the
// dedupe key, so the plan's `dedupeKey: 'plan:claude:p1'` becomes a session scope.
const planItem = { kind: 'plan_approval', scope: { session: 'claude:p1' } } as const;

async function setup() {
  const r = makeTempRepo({ withRemote: true });
  repo = r;
  const f = useFakeGh();
  fake = f;
  const cfg = OrcConfig.parse({
    projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [r.root], repos: [{ path: r.dir }] }],
  });
  const inbox = recordingInbox();
  const pty = recordingPty();
  const sessions = stubSessions([makeSession({ id: 'p1', live: owned })]);
  const ctx = createTestContext({
    config: () => cfg,
    sessions,
    pty,
    inbox,
    audit: memoryAudit(),
    templates: stubTemplates(),
  });
  contexts.push(ctx);
  ctx.worktrees = createWorktreeService(ctx);
  ctx.github = createGithubConnector(ctx);
  ctx.ship = createShipService(ctx, { launch: async () => ({ ptyId: 'pty-bm', sessionId: null }) });
  ctx.plans = createPlanApprovalService(ctx);
  const { view } = await ctx.worktrees.createWith(
    { repo: r.dir, base: 'main', type: 'feat', ticket: 'SAF-96', slug: 'ship' },
    { runSetup: false, actor: 'user' },
  );
  const ship = shipRoutes(ctx);
  const plan = planRoutes(ctx);
  const req = (app: typeof ship, path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { ctx, ship, plan, req, view, pty, inbox, repo: r, fake: f };
}

describe('ship routes', () => {
  it('walks suggest → commit → push → PR → merge, each behind confirm', async () => {
    const { ship, req, view, repo, fake } = await setup();
    repo.write(join('.worktrees', 'feat-SAF-96-ship', 'src/a.ts'), 'shipped\n');
    const sug = (await (await ship.request(`/ship/suggest?cwd=${encodeURIComponent(view.path)}`)).json()) as {
      message: string;
      base: string;
    };
    expect(sug.message).toBe('feat: SAF-96 ship');
    expect((await req(ship, '/ship/commit', { cwd: view.path, message: sug.message })).status).toBe(409);
    expect(
      (await req(ship, '/ship/commit', { cwd: view.path, message: sug.message, confirm: true })).status,
    ).toBe(200);
    const askPush = await req(ship, '/ship/push', { cwd: view.path });
    expect(
      ((await askPush.json()) as { error: { details: { summary: string } } }).error.details.summary,
    ).toContain('never forced');
    expect((await req(ship, '/ship/push', { cwd: view.path, confirm: true })).status).toBe(200);
    const pr = (await (
      await req(ship, '/ship/pr', {
        cwd: view.path,
        title: 'SAF-96 ship',
        body: 'b',
        base: sug.base,
        confirm: true,
      })
    ).json()) as { number: number; repo: string; url: string };
    expect(pr.number).toBe(101);
    expect((await req(ship, '/ship/merge', { pr, method: 'squash' })).status).toBe(409);
    expect(await (await req(ship, '/ship/merge', { pr, method: 'squash', confirm: true })).json()).toEqual({
      ok: true,
    });
    expect(fake.state().prs[`${pr.repo}#${pr.number}`]?.state).toBe('MERGED');
  });

  it('maps protected-branch and backmerge requests', async () => {
    const { ship, req, view, repo } = await setup();
    const r = await req(ship, '/ship/push', { cwd: repo.dir, confirm: true });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('protected_branch');
    const bm = await req(ship, '/ship/backmerge', {
      cwd: view.path,
      projectId: 'wakecap',
      ticket: 'SAF-96',
      confirm: true,
    });
    expect(await bm.json()).toEqual({ ptyId: 'pty-bm' });
  });
});

describe('plan routes', () => {
  it('approves and rejects with confirmation', async () => {
    const { plan, req, pty, inbox } = await setup();
    inbox.upsert({ ...planItem, reason: 'Plan awaiting approval' });
    expect((await req(plan, '/sessions/claude/p1/plan/approve', {})).status).toBe(409);
    expect(await (await req(plan, '/sessions/claude/p1/plan/approve', { confirm: true })).json()).toEqual({
      ok: true,
    });
    expect(pty.writes).toHaveLength(1);
    inbox.upsert({ ...planItem, reason: 'Plan awaiting approval' });
    expect((await req(plan, '/sessions/claude/p1/plan/reject', { feedback: '', confirm: true })).status).toBe(
      400,
    );
    expect(
      await (
        await req(plan, '/sessions/claude/p1/plan/reject', { feedback: 'smaller steps', confirm: true })
      ).json(),
    ).toEqual({ ok: true });
    const none = await req(plan, '/sessions/claude/p1/plan/approve', { confirm: true });
    expect(none.status).toBe(409);
  });
});
