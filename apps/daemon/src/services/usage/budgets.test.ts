import { describe, expect, it } from 'vitest';
import { makeP5Context, withWakecap } from '../../../test/p5-helpers.ts';
import { recordingInbox } from '../../../test/stubs.ts';
import { deleteBudget, listBudgetRows, upsertBudget } from '../../db/repos/budgets.ts';
import { inboxDedupeKey } from '../../inbox/engine.ts';
import {
  allBudgets,
  checkBudgetScope,
  configBudgets,
  evaluateBudgets,
  periodStart,
  raiseBudgetAlerts,
} from './budgets.ts';

function setup() {
  const p5 = makeP5Context({ config: withWakecap('/w', { budgets: { dailyUsd: 50, monthlyUsd: 900 } }) });
  return { db: p5.ctx.db, cfg: p5.ctx.config() };
}

describe('periodStart', () => {
  const now = new Date(2026, 8, 17, 15, 30); // Thu 17 Sep 2026, local time
  it('returns local day, ISO week and month starts', () => {
    expect(periodStart('daily', now).getTime()).toBe(new Date(2026, 8, 17).getTime());
    expect(periodStart('weekly', now).getTime()).toBe(new Date(2026, 8, 14).getTime());
    expect(periodStart('weekly', new Date(2026, 8, 20, 10)).getTime()).toBe(new Date(2026, 8, 14).getTime()); // Sunday
    expect(periodStart('monthly', now).getTime()).toBe(new Date(2026, 8, 1).getTime());
  });
});

describe('budgets', () => {
  it('merges config budgets with table rows, table wins', () => {
    const { db, cfg } = setup();
    expect(configBudgets(cfg).map((b) => b.id)).toEqual(['config:wakecap:daily', 'config:wakecap:monthly']);
    const row = upsertBudget(
      db,
      { scopeType: 'project', scopeId: 'wakecap', period: 'daily', limitUsd: 70 },
      '2026-09-17T00:00:00.000Z',
    );
    const again = upsertBudget(
      db,
      { scopeType: 'project', scopeId: 'wakecap', period: 'daily', limitUsd: 80 },
      '2026-09-17T00:00:00.000Z',
    );
    expect(again.id).toBe(row.id);
    upsertBudget(db, { scopeType: 'ticket', scopeId: 'SAF-1', period: 'weekly', limitUsd: 10 }, 'x');
    upsertBudget(db, { scopeType: 'global', scopeId: null, period: 'monthly', limitUsd: 2000 }, 'x');
    const all = allBudgets(db, cfg);
    expect(all.find((b) => b.scopeId === 'wakecap' && b.period === 'daily')).toMatchObject({
      limitUsd: 80,
      origin: 'table',
    });
    expect(all.filter((b) => b.scopeId === 'wakecap')).toHaveLength(2);
    expect(all.find((b) => b.scopeType === 'global')?.scopeId).toBeNull();
    expect(deleteBudget(db, row.id)).toBe(true);
    expect(deleteBudget(db, row.id)).toBe(false);
    expect(listBudgetRows(db)).toHaveLength(2);
  });

  it('evaluates spend per period and scope, and checks the worst applicable budget', () => {
    const budgets = [
      {
        id: 'a',
        scopeType: 'project' as const,
        scopeId: 'wakecap',
        period: 'daily' as const,
        limitUsd: 50,
        origin: 'config' as const,
      },
      {
        id: 'b',
        scopeType: 'ticket' as const,
        scopeId: 'SAF-1',
        period: 'weekly' as const,
        limitUsd: 10,
        origin: 'table' as const,
      },
      {
        id: 'c',
        scopeType: 'global' as const,
        scopeId: null,
        period: 'monthly' as const,
        limitUsd: 1000,
        origin: 'table' as const,
      },
    ];
    const calls: unknown[] = [];
    const statuses = evaluateBudgets(
      budgets,
      (q) => {
        calls.push(q);
        return q.ticket ? 12 : q.projectId ? 40 : 100;
      },
      new Date(2026, 8, 17, 15, 30),
    );
    expect(statuses.map((s) => [s.budget.id, s.spentUsd, s.pct])).toEqual([
      ['a', 40, 0.8],
      ['b', 12, 1.2],
      ['c', 100, 0.1],
    ]);
    expect(calls[1]).toMatchObject({ ticket: 'SAF-1', from: new Date(2026, 8, 14).toISOString() });
    expect(checkBudgetScope(statuses, { projectId: 'wakecap', ticket: 'SAF-1' })).toEqual({
      ok: false,
      pct: 1.2,
      limitUsd: 10,
    });
    expect(checkBudgetScope(statuses, { projectId: 'wakecap' })).toEqual({
      ok: true,
      pct: 0.8,
      limitUsd: 50,
    });
    expect(checkBudgetScope([], { projectId: 'x' })).toEqual({ ok: true, pct: 0, limitUsd: null });
  });

  it('raises warn/over alerts once and resolves stale ones', () => {
    // Shipped inbox API (contracts §11): callers pass { kind, scope, facet } and the engine composes
    // the dedupe key. The plan's `budget:project:wakecap:daily:<date>:<level>` maps to
    // scope { project: 'wakecap' } + facet `daily:<date>:<level>`.
    const inbox = recordingInbox();
    const key = (level: 'warn' | 'over') =>
      inboxDedupeKey({ kind: 'budget', scope: { project: 'wakecap' }, facet: `daily:2026-09-16:${level}` });
    const mk = (id: string, pct: number) => ({
      budget: {
        id,
        scopeType: 'project' as const,
        scopeId: 'wakecap',
        period: 'daily' as const,
        limitUsd: 10,
        origin: 'table' as const,
      },
      spentUsd: pct * 10,
      pct,
      periodStart: '2026-09-16T21:00:00.000Z',
    });
    const first = raiseBudgetAlerts(inbox, [mk('a', 0.85)], 0.8, new Set());
    expect([...first]).toEqual(['budget:project:wakecap:daily:2026-09-16:warn']);
    const second = raiseBudgetAlerts(inbox, [mk('a', 1.1)], 0.8, first);
    expect([...second]).toEqual(['budget:project:wakecap:daily:2026-09-16:over']);
    expect(inbox.resolved).toEqual([key('warn')]);
    raiseBudgetAlerts(inbox, [mk('a', 0.2)], 0.8, second);
    expect(inbox.resolved).toContain(key('over'));
    expect(inbox.upserts).toHaveLength(2);
    expect(inbox.upserts.map((u) => inboxDedupeKey(u))).toEqual([key('warn'), key('over')]);
  });
});
