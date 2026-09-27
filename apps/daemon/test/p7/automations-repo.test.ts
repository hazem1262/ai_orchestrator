import type { Automation } from '@orc/api-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as repo from '../../src/db/repos/automations.ts';
import * as sugg from '../../src/db/repos/suggestions.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

const auto: Automation = {
  id: 'a1',
  name: 'Daily deps audit',
  enabled: false,
  trigger: { type: 'cron', cron: '0 9 * * 1' },
  action: {
    templateId: 'deps-audit',
    projectId: 'wakecap',
    useWorktree: true,
    headless: true,
    timeoutMin: 20,
    planApproval: false,
  },
  budgetUsd: 5,
};

let ctx: TestContext;
beforeEach(() => {
  ctx = createTestContext();
});
afterEach(() => ctx.dispose());

const newRun = (id: string, key: string, startedAt = '2026-09-10T09:00:00.000Z') => ({
  id,
  automationId: 'a1',
  triggerKey: key,
  triggerSource: 'cron' as const,
  vars: { ticket: 'SAF-1' },
  startedAt,
  status: 'queued' as const,
  rerunOf: null,
});

describe('automations repo', () => {
  it('round-trips automations', () => {
    repo.upsertAutomation(ctx.db, auto, '2026-09-10T00:00:00.000Z');
    expect(repo.getAutomation(ctx.db, 'a1')).toEqual(auto);
    repo.upsertAutomation(
      ctx.db,
      { ...auto, name: 'Weekly deps audit', enabled: true },
      '2026-09-11T00:00:00.000Z',
    );
    expect(repo.listAutomations(ctx.db).map((a) => [a.name, a.enabled])).toEqual([
      ['Weekly deps audit', true],
    ]);
    repo.deleteAutomation(ctx.db, 'a1');
    expect(repo.getAutomation(ctx.db, 'a1')).toBeNull();
  });

  it('dedupes runs by trigger key and patches them', () => {
    repo.upsertAutomation(ctx.db, auto, '2026-09-10T00:00:00.000Z');
    const r = repo.insertRun(ctx.db, newRun('r1', 'cron:2026-09-10T09:00'));
    expect(r?.status).toBe('queued');
    expect(r?.vars).toEqual({ ticket: 'SAF-1' });
    expect(repo.insertRun(ctx.db, newRun('r2', 'cron:2026-09-10T09:00'))).toBeNull();
    const u = repo.updateRun(ctx.db, 'r1', {
      status: 'success',
      endedAt: '2026-09-10T09:05:00.000Z',
      costUsd: 1.5,
      diffStat: { files: 2, insertions: 5, deletions: 1, untracked: 0 },
      logPath: '/tmp/r1.jsonl',
    });
    expect(u.diffStat).toEqual({ files: 2, insertions: 5, deletions: 1, untracked: 0 });
    expect(repo.getRunLogPath(ctx.db, 'r1')).toBe('/tmp/r1.jsonl');
    expect(repo.listRuns(ctx.db, 'a1').map((x) => x.id)).toEqual(['r1']);
  });

  it('computes spend, stats and fails stale runs', () => {
    repo.upsertAutomation(ctx.db, auto, '2026-09-10T00:00:00.000Z');
    repo.insertRun(ctx.db, newRun('old', 'k0', '2026-08-30T09:00:00.000Z'));
    repo.updateRun(ctx.db, 'old', { status: 'success', costUsd: 9 });
    repo.insertRun(ctx.db, newRun('r1', 'k1'));
    repo.updateRun(ctx.db, 'r1', { status: 'success', costUsd: 1.25 });
    repo.insertRun(ctx.db, newRun('r2', 'k2', '2026-09-11T09:00:00.000Z'));
    repo.updateRun(ctx.db, 'r2', { status: 'failed', costUsd: 0.5 });
    repo.insertRun(ctx.db, newRun('r3', 'k3', '2026-09-12T09:00:00.000Z'));
    expect(repo.monthSpend(ctx.db, 'a1', '2026-09-01T00:00:00.000Z')).toBeCloseTo(1.75);
    const stats = repo.runStats(ctx.db, 'a1', '2026-09-01T00:00:00.000Z');
    expect(stats).toMatchObject({ total: 4, success: 2, failed: 1, lastRunAt: '2026-09-12T09:00:00.000Z' });
    expect(stats.successRate).toBeCloseTo(2 / 3);
    expect(repo.failStaleRuns(ctx.db, '2026-09-12T10:00:00.000Z')).toBe(1);
    expect(repo.getRun(ctx.db, 'r3')).toMatchObject({
      status: 'failed',
      error: 'daemon restarted while the run was active',
    });
  });
});

describe('suggestions repo', () => {
  it('dedupes and records decisions', () => {
    const s = {
      source: 'todo' as const,
      projectId: 'wakecap',
      title: 'TODO: remove the flag',
      detail: 'a.ts:2',
      ticket: null,
      file: 'a.ts',
      line: 2,
      dedupeKey: 'todo:/r:a.ts:remove the flag',
    };
    const first = sugg.insertSuggestion(ctx.db, s, '2026-09-10T00:00:00.000Z');
    expect(first?.state).toBe('new');
    expect(sugg.insertSuggestion(ctx.db, s, '2026-09-10T00:01:00.000Z')).toBeNull();
    const id = first?.id ?? '';
    expect(sugg.decideSuggestion(ctx.db, id, 'accepted', '2026-09-10T01:00:00.000Z', 'pty-9')).toMatchObject({
      state: 'accepted',
      runPtyId: 'pty-9',
    });
    expect(sugg.listSuggestions(ctx.db, 'new')).toEqual([]);
    expect(sugg.listSuggestions(ctx.db).map((x) => x.id)).toEqual([id]);
  });
});
