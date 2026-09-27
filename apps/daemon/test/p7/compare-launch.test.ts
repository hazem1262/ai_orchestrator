import { LaunchRequest } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import type { BusEvent } from '../../src/live/event-bus.ts';
import { createCompareService, median, variantLabel } from '../../src/services/compare/compare.ts';
import { ServiceError } from '../../src/services/errors.ts';
import {
  createFakePty,
  fakeAudit,
  fakeLauncher,
  fakeProjects,
  fakeSessions,
  fakeUsage,
  fakeWorktrees,
  makeSession,
  testConfig,
} from '../fakes/phase7.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

function setup(o: { usageOk?: boolean; launcherMax?: number } = {}) {
  const cfg = testConfig({ compare: { maxVariants: 3 } });
  const launcher = fakeLauncher({ max: o.launcherMax });
  const worktrees = fakeWorktrees();
  const audit = fakeAudit();
  const sessions = fakeSessions(
    [1, 3, 2, null].map((cost, i) =>
      makeSession({
        id: `hist-${i}`,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: cost },
      }),
    ),
  );
  ctx = createTestContext({
    config: () => cfg,
    projects: fakeProjects(cfg),
    launcher,
    worktrees,
    audit,
    sessions,
    pty: createFakePty(),
    usage: fakeUsage({ ok: o.usageOk ?? true }),
  });
  const events: BusEvent[] = [];
  ctx.bus.on('compare.updated', (e) => events.push(e));
  const svc = createCompareService({ ctx });
  return { svc, launcher, worktrees, audit, events };
}

const req = (over: Record<string, unknown> = {}) =>
  LaunchRequest.parse({
    source: 'claude',
    projectId: 'wakecap',
    cwd: '/Users/test/Wakecap',
    prompt: 'Make the SLA deadline skip weekends',
    ticket: 'SAF-1787',
    worktree: { repo: '/Users/test/Wakecap/Backend/svc', base: 'main', type: 'feat', slug: 'sla-weekends' },
    compare: [{ source: 'claude', model: 'claude-opus-5' }, { source: 'codex' }],
    ...over,
  });

describe('helpers', () => {
  it('labels variants and computes medians', () => {
    expect(variantLabel({ source: 'claude', model: 'claude-opus-5' }, 0)).toBe('v1 claude:claude-opus-5');
    expect(variantLabel({ source: 'codex' }, 1)).toBe('v2 codex');
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe('CompareService.launch', () => {
  it('creates one worktree and one session per variant', async () => {
    const t = setup();
    const g = await t.svc.launch(req());
    expect(g.variants.map((v) => [v.label, v.error])).toEqual([
      ['v1 claude:claude-opus-5', null],
      ['v2 codex', null],
    ]);
    expect(t.worktrees.created.map((w) => w.branch)).toEqual([
      'feat/SAF-1787-sla-weekends-v1-claude-claude-opus-5',
      'feat/SAF-1787-sla-weekends-v2-codex',
    ]);
    expect(t.launcher.requests.map((r) => [r.source, r.model, r.cwd, r.compare, r.worktree])).toEqual([
      ['claude', 'claude-opus-5', t.worktrees.created[0]?.path, undefined, undefined],
      ['codex', undefined, t.worktrees.created[1]?.path, undefined, undefined],
    ]);
    expect(g.variants[0]?.sessionPk).toBe('claude:launched-1');
    expect(g.variants[1]?.sessionPk).toBeNull();
    expect(g).toMatchObject({
      state: 'running',
      winnerIndex: null,
      estimateUsd: 4,
      repo: '/Users/test/Wakecap/Backend/svc',
      base: 'main',
    });
    expect(t.svc.get(g.id)).toEqual(g);
    expect(t.audit.entries.find((e) => e.action === 'compare.launch')).toMatchObject({
      actor: 'user',
      target: `compare:${g.id}`,
    });
    expect(t.events).toHaveLength(1);
  });

  it('records a failed variant and keeps the others', async () => {
    const t = setup({ launcherMax: 1 });
    const g = await t.svc.launch(req());
    expect(g.variants[0]?.error).toBeNull();
    expect(g.variants[1]?.error).toContain('too many');
  });

  it.each([
    ['one variant', { compare: [{ source: 'claude' }] }, 'validation_failed'],
    [
      'too many variants',
      { compare: [{ source: 'claude' }, { source: 'claude' }, { source: 'codex' }, { source: 'codex' }] },
      'validation_failed',
    ],
    ['no worktree', { worktree: undefined }, 'validation_failed'],
  ])('rejects %s', async (_name, over, code) => {
    const t = setup();
    await expect(t.svc.launch(req(over))).rejects.toMatchObject({ code });
    expect(t.launcher.requests).toHaveLength(0);
  });

  it('refuses when over budget', async () => {
    const t = setup({ usageOk: false });
    const err = await t.svc.launch(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({ code: 'over_budget', status: 409 });
    expect(t.worktrees.created).toHaveLength(0);
  });
});

describe('CompareService.estimate', () => {
  it('multiplies the median recent session cost', () => {
    const t = setup();
    expect(t.svc.estimate('wakecap', 3)).toEqual({
      variants: 3,
      multiplier: 3,
      avgSessionCostUsd: 2,
      estimatedUsd: 6,
      sample: 3,
      burnRateUsdPerHour: 2.5,
      budget: { ok: true, pct: 0.2, limitUsd: 50 },
    });
  });
});
