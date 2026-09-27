import type { UsageSnapshot } from '@orc/core';
import { describe, expect, it, vi } from 'vitest';
import { ev, makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import { recordingInbox } from '../../../test/stubs.ts';
import { upsertBudget } from '../../db/repos/budgets.ts';
import { createInboxEngine, inboxDedupeKey } from '../../inbox/engine.ts';
import { createUsageLedger } from './ledger.ts';
import { createUsageMeter, quotaAlertKeys } from './meter.ts';

const NOW = new Date('2026-09-17T15:10:00.000Z');

// Shipped inbox API (contracts §11): callers pass { kind, scope, facet } and the engine composes the
// dedupe key.
//   - Budget alerts: the plan's `budget:project:wakecap:daily:<date>:<level>` maps to
//     scope { project: 'wakecap' } + facet `daily:<date>:<level>` (as in budgets.test.ts).
//   - Quota alerts: the plan's `quota:block:<blockStart>` / `quota:week:<date>` map to
//     scope { domain: 'quota', id: 'block' | 'week' } + facet `<blockStart>` / `<date>` — the
//     `domain` scope that dedupe-key.ts names for "a quota window".
const budgetKey = (facet: string) => inboxDedupeKey({ kind: 'budget', scope: { project: 'wakecap' }, facet });
const quotaKey = (id: 'block' | 'week', facet: string) =>
  inboxDedupeKey({ kind: 'budget', scope: { domain: 'quota', id }, facet });

function setup(
  limits: {
    blockTokenLimit?: number | null;
    quotaSource?: 'estimate' | 'official';
    blockPct?: string | null;
  } = {},
) {
  const s1 = makeSession({
    id: 's1',
    tickets: ['SAF-1'],
    usage: { input: 60, output: 40, cacheRead: 0, cacheWrite: 0, costUsd: 2 },
    live: {
      pid: 1,
      status: 'busy',
      waitingFor: null,
      since: '2026-09-17T15:00:00.000Z',
      ownership: 'observed',
      ptyId: null,
      stage: null,
      currentTool: null,
      backgroundJobs: 0,
      runningSubagents: 0,
      contextFill: null,
    },
  });
  const events = {
    'claude:s1': [
      ev({
        seq: 1,
        ts: '2026-09-17T14:10:00.000Z',
        kind: 'assistant_text',
        messageId: 'm1',
        model: 'claude-haiku-4-5',
        usage: { input: 60, output: 40, cacheRead: 150_000, cacheWrite: 0, costUsd: null },
      }),
    ],
  };
  const t = makeP5Context({
    config: (c) => {
      const w = withWakecap('/Users/test/Wakecap', { budgets: { dailyUsd: 2.2 } })(c);
      return {
        ...w,
        limits: {
          ...w.limits,
          blockTokenLimit: limits.blockTokenLimit ?? null,
          quotaSource: limits.quotaSource ?? 'estimate',
          officialFieldPaths: { ...w.limits.officialFieldPaths, blockPct: limits.blockPct ?? null },
        },
      };
    },
    data: { sessions: [s1], events },
  });
  const ledger = createUsageLedger(t.ctx);
  const inbox = recordingInbox();
  const meter = createUsageMeter(t.ctx, { ledger, inbox, now: () => NOW });
  const emitted: UsageSnapshot[] = [];
  t.ctx.bus.on('usage.updated', (e) => void emitted.push(e.snapshot));
  return { ...t, ledger, meter, inbox, upserts: inbox.upserts, resolved: inbox.resolved, emitted };
}

describe('usage meter', () => {
  it('computes an estimated snapshot from the ledger and emits only on change', async () => {
    const { ledger, meter, emitted } = setup();
    await ledger.syncSession('claude:s1');
    const s = meter.refresh();
    expect(s).toMatchObject({ source: 'estimate', block: { active: true, tokens: 100, pctOfLimit: null } });
    expect(s.block.costUsd).toBeCloseTo(2, 9);
    meter.refresh();
    expect(emitted).toHaveLength(1);
    expect(meter.snapshot()).toEqual(s);
  });

  it('checks budgets and raises a budget alert at 80%+', async () => {
    const { ledger, meter, upserts } = setup();
    await ledger.syncSession('claude:s1');
    meter.refresh();
    const chk = meter.checkBudget({ projectId: 'wakecap' });
    expect(chk.ok).toBe(true);
    expect(chk.pct).toBeCloseTo(2 / 2.2, 9);
    expect(chk.limitUsd).toBe(2.2);
    const day = meter.budgets()[0]?.periodStart.slice(0, 10);
    expect(upserts.map((u) => inboxDedupeKey(u))).toContain(budgetKey(`daily:${day}:warn`));
  });

  it('checks ticket budgets from the table', async () => {
    const { ctx, ledger, meter } = setup();
    upsertBudget(
      ctx.db,
      { scopeType: 'ticket', scopeId: 'SAF-1', period: 'monthly', limitUsd: 1 },
      NOW.toISOString(),
    );
    await ledger.syncSession('claude:s1');
    const chk = meter.checkBudget({ ticket: 'SAF-1' });
    expect(chk).toMatchObject({ ok: false, limitUsd: 1 });
    expect(chk.pct).toBeCloseTo(2, 9);
  });

  it('raises and resolves quota alerts from plan limits', async () => {
    const { ctx, ledger, meter, upserts, resolved } = setup({ blockTokenLimit: 110 });
    await ledger.syncSession('claude:s1');
    meter.refresh();
    const blockKey = quotaKey('block', '2026-09-17T14:00:00.000Z');
    expect(upserts.map((u) => inboxDedupeKey(u))).toContain(blockKey);
    expect(quotaAlertKeys(meter.snapshot(), 0.8)[0]?.reason).toMatch(/^5h block at 91% \(estimated\)/);
    const { meter: m2 } = setup({ blockTokenLimit: 100_000 });
    expect(quotaAlertKeys(m2.refresh(), 0.8)).toEqual([]);
    expect(resolved).toEqual([]);
    // Raising the plan limit clears the condition, which resolves the open quota item.
    ctx.updateConfig?.((c) => ({ ...c, limits: { ...c.limits, blockTokenLimit: 100_000 } }));
    meter.refresh();
    expect(resolved).toContain(blockKey);
  });

  it('uses official samples only when configured', async () => {
    const off = setup({ quotaSource: 'official', blockPct: 'rate_limits.five_hour.used_percentage' });
    expect(off.meter.ingestOfficial({ rate_limits: { five_hour: { used_percentage: 55 } } })).toMatchObject({
      blockPct: 0.55,
    });
    expect(off.meter.snapshot()).toMatchObject({ source: 'official', block: { pctOfLimit: 0.55 } });
    const est = setup();
    expect(est.meter.ingestOfficial({ rate_limits: { five_hour: { used_percentage: 55 } } })).toBeNull();
    expect(est.meter.snapshot().source).toBe('estimate');
  });

  it('computes context fill with the configured window and warn threshold', async () => {
    const { ledger, meter } = setup();
    await ledger.syncSession('claude:s1');
    expect(meter.contextFill('claude:s1')).toEqual({
      sessionPk: 'claude:s1',
      model: 'claude-haiku-4-5',
      usedTokens: 150_060,
      windowTokens: 200_000,
      fill: 150_060 / 200_000,
      warn: false,
    });
    expect(meter.contextFill('claude:none')).toBeNull();
  });

  it('reports concurrency per project', () => {
    const { ctx, meter } = setup();
    ctx.launcher = {
      launch: async () => ({ ptyId: 'p', sessionId: null }),
      kill: async () => ({ killed: 'pty' as const }),
      ownedCount: () => 2,
    };
    expect(meter.concurrency()).toEqual([{ projectId: 'wakecap', owned: 2, max: 6 }]);
  });

  it('resolves a budget alert raised before a restart once its period rolls over', async () => {
    const { ctx, ledger } = setup();
    await ledger.syncSession('claude:s1');
    const inbox = createInboxEngine(ctx, { now: () => NOW });
    const before = createUsageMeter(ctx, { ledger, inbox, now: () => NOW });
    before.refresh();
    const day = before.budgets()[0]?.periodStart.slice(0, 10);
    const stale = budgetKey(`daily:${day}:warn`);
    expect(inbox.list({ state: ['open'], kind: ['budget'] }).map((i) => i.dedupeKey)).toEqual([stale]);
    before.stop();

    // Restart: fresh module state (nothing in-memory survives), a fresh inbox engine and meter over
    // the same database, and a clock one day later so the daily period has rolled over.
    vi.resetModules();
    const fresh = await import('./meter.ts');
    const { createInboxEngine: freshInbox } = await import('../../inbox/engine.ts');
    const later = new Date(NOW.getTime() + 24 * 3_600_000);
    const inbox2 = freshInbox(ctx, { now: () => later });
    const after = fresh.createUsageMeter(ctx, { ledger, inbox: inbox2, now: () => later });
    after.refresh();
    expect(inbox2.list({ state: ['open'], kind: ['budget'] })).toEqual([]);
    expect(inbox2.list({ kind: ['budget'] }).find((i) => i.dedupeKey === stale)?.state).toBe('auto_resolved');
  });
});
