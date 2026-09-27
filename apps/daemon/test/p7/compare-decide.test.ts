import { LaunchRequest } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { createCompareService } from '../../src/services/compare/compare.ts';
import type { LaunchService } from '../../src/services/launch.ts';
import {
  createFakePty,
  fakeAudit,
  fakeProjects,
  fakeSessions,
  fakeUsage,
  fakeWorktrees,
  makeLive,
  makeSession,
  testConfig,
} from '../fakes/phase7.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

async function setup(variants = 2) {
  const cfg = testConfig({ compare: { maxVariants: 3 } });
  const pty = createFakePty();
  const worktrees = fakeWorktrees();
  const audit = fakeAudit();
  const sessions = fakeSessions([
    makeSession({
      id: 'cl-1',
      live: makeLive({ status: 'review' }),
      recap: 'Added a weekend check with tests',
      lastTest: { ts: 't', command: 'pnpm test', passed: 12, failed: 0, skipped: 0, durationMs: 900 },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 1.2 },
      startedAt: '2026-09-17T09:00:00.000Z',
      lastActivityAt: '2026-09-17T09:20:00.000Z',
    }),
    makeSession({
      id: 'cx-1',
      source: 'codex',
      awaySummary: 'Codex changed the util',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null },
    }),
  ]);
  let n = 0;
  const launcher: LaunchService = {
    async launch(r) {
      n++;
      const info = pty.spawn({ command: r.source, args: [], cwd: r.cwd, sessionPk: null });
      return { ptyId: info.id, sessionId: r.source === 'claude' ? `cl-${n}` : null };
    },
    async kill() {
      return { killed: 'pty' as const };
    },
    ownedCount: () => 0,
  };
  ctx = createTestContext({
    config: () => cfg,
    projects: fakeProjects(cfg),
    pty,
    worktrees,
    audit,
    sessions,
    launcher,
    usage: fakeUsage(),
  });
  const svc = createCompareService({
    ctx,
    resolveSessionByCwd: (cwd) => (cwd.includes('-v2-') ? 'codex:cx-1' : null),
    diffStatFn: async (cwd) => ({
      files: cwd.includes('-v1-') ? 3 : 1,
      insertions: 10,
      deletions: 2,
      untracked: 0,
    }),
  });
  const compare = [
    { source: 'claude' },
    { source: 'codex' },
    { source: 'codex', model: 'gpt-5.5-codex' },
  ].slice(0, variants);
  const group = await svc.launch(
    LaunchRequest.parse({
      source: 'claude',
      projectId: 'wakecap',
      cwd: '/Users/test/Wakecap',
      prompt: 'weekends',
      worktree: { repo: '/Users/test/Wakecap/Backend/svc', base: 'main', type: 'feat', slug: 'sla' },
      compare,
    }),
  );
  return { svc, group, pty, worktrees, audit };
}

describe('CompareService.view', () => {
  it('shows status, cost, tests, recap and diff, and remembers resolved sessions', async () => {
    const t = await setup();
    const v = await t.svc.view(t.group.id);
    expect(v.variants.map((x) => [x.label, x.status, x.costUsd, x.recap, x.diff?.files])).toEqual([
      ['v1 claude', 'review', 1.2, 'Added a weekend check with tests', 3],
      ['v2 codex', 'ended', null, 'Codex changed the util', 1],
    ]);
    expect(v.variants[0]?.tests?.passed).toBe(12);
    expect(v.variants[0]?.durationMs).toBe(20 * 60_000);
    expect(t.svc.get(t.group.id)?.variants[1]).toMatchObject({ sessionPk: 'codex:cx-1', sessionId: 'cx-1' });
  });
});

describe('CompareService.pickWinner', () => {
  it('decides the group and links to review', async () => {
    const t = await setup();
    const r = t.svc.pickWinner(t.group.id, 0);
    expect(r.reviewUrl).toBe('/review/claude/cl-1');
    expect(r.group).toMatchObject({ state: 'decided', winnerIndex: 0 });
    expect(t.audit.entries.find((e) => e.action === 'compare.pick')?.params).toMatchObject({ index: 0 });
    expect(() => t.svc.pickWinner(t.group.id, 7)).toThrow(/not found/);
  });

  it('resolves a Codex session before picking it', async () => {
    const t = await setup();
    expect(t.svc.pickWinner(t.group.id, 1).reviewUrl).toBe('/review/codex/cx-1');
  });
});

describe('CompareService.archiveLosers', () => {
  it('needs a winner first', async () => {
    const t = await setup();
    await expect(t.svc.archiveLosers(t.group.id)).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('stops losing sessions, archives clean worktrees and keeps dirty ones', async () => {
    const t = await setup(3);
    const dirtyPath = t.group.variants[2]?.worktreePath ?? '';
    t.worktrees.dirty.add(dirtyPath);
    t.svc.pickWinner(t.group.id, 0);
    const res = await t.svc.archiveLosers(t.group.id);
    expect(res.results).toEqual([
      {
        index: 1,
        worktreePath: t.group.variants[1]?.worktreePath,
        killed: true,
        archived: true,
        reason: null,
      },
      {
        index: 2,
        worktreePath: dirtyPath,
        killed: true,
        archived: false,
        reason: expect.stringContaining('uncommitted'),
      },
    ]);
    expect(res.group.state).toBe('decided');
    expect(t.pty.killed).toEqual(['pty-2', 'pty-3']);
    expect(t.worktrees.archived).toEqual([{ path: t.group.variants[1]?.worktreePath, actor: 'user' }]);
    expect(t.audit.entries.filter((e) => e.action === 'session.kill')).toHaveLength(2);
    expect(t.audit.entries.find((e) => e.action === 'compare.archive')).toMatchObject({ result: 'error' });

    t.worktrees.dirty.clear();
    const again = await t.svc.archiveLosers(t.group.id);
    expect(again.group.state).toBe('archived');
  });
});
