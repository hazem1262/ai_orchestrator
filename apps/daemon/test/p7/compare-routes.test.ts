import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.ts';
import { API_BASE, TEST_TOKEN } from '../../src/http/p7-guard.ts';
import { createCompareService } from '../../src/services/compare/compare.ts';
import {
  createFakePty,
  fakeAudit,
  fakeLauncher,
  fakeProjects,
  fakeSessions,
  fakeUsage,
  fakeWorktrees,
  testConfig,
} from '../fakes/phase7.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

function setup(withCompare = true) {
  const cfg = testConfig();
  ctx = createTestContext({
    config: () => cfg,
    projects: fakeProjects(cfg),
    pty: createFakePty(),
    worktrees: fakeWorktrees(),
    audit: fakeAudit(),
    sessions: fakeSessions([]),
    launcher: fakeLauncher(),
    usage: fakeUsage(),
  });
  if (withCompare)
    ctx.compare = createCompareService({
      ctx,
      resolveSessionByCwd: () => null,
      diffStatFn: async () => ({ files: 0, insertions: 0, deletions: 0, untracked: 0 }),
    });
  const app = createApp({ ctx, token: TEST_TOKEN, port: () => 4317, env: {} });
  return (path: string, method = 'GET', body?: unknown) =>
    app.request(`${API_BASE}${path}`, {
      method,
      headers: {
        'x-orc-token': TEST_TOKEN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const launchBody = {
  source: 'claude',
  projectId: 'wakecap',
  cwd: '/tmp',
  prompt: 'x',
  worktree: { repo: '/tmp/repo', base: 'main', type: 'feat', slug: 'cmp' },
  compare: [
    { source: 'claude', model: 'claude-opus-5' },
    { source: 'claude', model: 'claude-sonnet-5' },
  ],
};

describe('/api/compare', () => {
  it('estimates, launches, views, picks and asks before archiving', async () => {
    const call = setup();
    const est = (await (await call('/api/compare/estimate?projectId=wakecap&n=2')).json()) as {
      multiplier: number;
    };
    expect(est.multiplier).toBe(2);
    expect((await call('/api/compare/estimate?n=0')).status).toBe(400);

    const created = await call('/api/compare', 'POST', launchBody);
    expect(created.status).toBe(201);
    const g = (await created.json()) as { id: string };
    const view = (await (await call(`/api/compare/${g.id}`)).json()) as { variants: unknown[] };
    expect(view.variants).toHaveLength(2);

    const win = (await (await call(`/api/compare/${g.id}/winner`, 'POST', { index: 1 })).json()) as {
      reviewUrl: string;
    };
    expect(win.reviewUrl).toBe('/review/claude/launched-2');

    const noConfirm = await call(`/api/compare/${g.id}/archive-losers`, 'POST', {});
    expect(noConfirm.status).toBe(409);
    expect(
      ((await noConfirm.json()) as { error: { details: { summary: string } } }).error.details.summary,
    ).toContain('archive');
    const archived = await call(`/api/compare/${g.id}/archive-losers`, 'POST', { confirm: true });
    expect(archived.status).toBe(200);
    expect((await call('/api/compare/missing')).status).toBe(404);
  });

  it('routes compare launches from /api/sessions/launch', async () => {
    const call = setup();
    const res = await call('/api/sessions/launch', 'POST', launchBody);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ compareGroupId: expect.any(String) });
  });

  it('answers not_enabled without the compare service', async () => {
    const call = setup(false);
    expect((await call('/api/sessions/launch', 'POST', launchBody)).status).toBe(409);
    expect((await call('/api/compare/estimate?n=2')).status).toBe(409);
  });
});
