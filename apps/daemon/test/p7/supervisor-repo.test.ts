import type { SupervisorDecisionView } from '@orc/api-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as repo from '../../src/db/repos/supervisor.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

let ctx: TestContext;
beforeEach(() => {
  ctx = createTestContext();
});
afterEach(() => ctx.dispose());

const decision = (over: Partial<SupervisorDecisionView> = {}): SupervisorDecisionView => ({
  id: 'd1',
  sessionPk: 'claude:s1',
  projectId: 'wakecap',
  question: 'Should I continue?',
  decision: 'answer',
  answer: 'Yes, continue.',
  confidence: 0.92,
  reason: 'routine continue prompt',
  intent: 'continue',
  sent: true,
  costUsd: 0.002,
  model: 'claude-haiku-4-5',
  feedback: null,
  ts: '2026-09-18T09:00:00.000Z',
  ...over,
});

describe('supervisor rules repo', () => {
  it('stores rules and returns global plus project rules', () => {
    const now = '2026-09-18T08:00:00.000Z';
    const global = repo.insertRule(
      ctx.db,
      {
        projectId: null,
        kind: 'deny',
        pattern: 'drop table',
        intent: null,
        answer: null,
        note: null,
        source: 'user',
      },
      now,
    );
    repo.insertRule(
      ctx.db,
      {
        projectId: 'wakecap',
        kind: 'allow',
        pattern: 'ship it\\?',
        intent: 'continue',
        answer: 'Yes, continue.',
        note: null,
        source: 'user',
      },
      now,
    );
    repo.insertRule(
      ctx.db,
      {
        projectId: 'other',
        kind: 'allow',
        pattern: 'nope',
        intent: 'continue',
        answer: 'x',
        note: null,
        source: 'user',
      },
      now,
    );
    expect(
      repo
        .listRules(ctx.db, 'wakecap')
        .map((r) => r.pattern)
        .sort(),
    ).toEqual(['drop table', 'ship it\\?']);
    expect(repo.listRules(ctx.db, null).map((r) => r.pattern)).toEqual(['drop table']);
    expect(repo.deleteRule(ctx.db, global.id)).toBe(true);
    expect(repo.deleteRule(ctx.db, 'nope')).toBe(false);
    expect(repo.listRules(ctx.db, 'wakecap')).toHaveLength(1);
  });
});

describe('supervisor decisions repo', () => {
  it('records decisions, counts caps and sums cost', () => {
    repo.insertDecision(ctx.db, decision());
    repo.insertDecision(ctx.db, decision({ id: 'd2', ts: '2026-09-18T09:30:00.000Z' }));
    repo.insertDecision(
      ctx.db,
      decision({ id: 'd3', sessionPk: 'claude:s2', ts: '2026-09-18T09:40:00.000Z' }),
    );
    repo.insertDecision(
      ctx.db,
      decision({
        id: 'd4',
        decision: 'escalate',
        answer: null,
        sent: false,
        confidence: 0.2,
        ts: '2026-09-18T09:50:00.000Z',
      }),
    );
    expect(repo.countAnswered(ctx.db, '2026-09-18T09:00:00.000Z')).toBe(3);
    expect(repo.countAnswered(ctx.db, '2026-09-18T09:00:00.000Z', 'claude:s1')).toBe(2);
    expect(repo.countEscalated(ctx.db, '2026-09-18T09:00:00.000Z')).toBe(1);
    expect(repo.monthCost(ctx.db, '2026-09-01T00:00:00.000Z')).toBeCloseTo(0.008);
    expect(repo.listDecisions(ctx.db, { sessionPk: 'claude:s1' }).map((d) => d.id)).toEqual([
      'd4',
      'd2',
      'd1',
    ]);
    expect(repo.listDecisions(ctx.db, { limit: 2 }).map((d) => d.id)).toEqual(['d4', 'd3']);
    expect(repo.markFeedback(ctx.db, 'd1', 'wrong').feedback).toBe('wrong');
    expect(repo.getDecision(ctx.db, 'd1')?.feedback).toBe('wrong');
  });
});

describe('supervisor targets repo', () => {
  it('upserts per-project and per-session switches', () => {
    const now = '2026-09-18T09:00:00.000Z';
    repo.setTarget(ctx.db, { targetType: 'project', targetId: 'wakecap', enabled: true }, now);
    repo.setTarget(ctx.db, { targetType: 'session', targetId: 'claude:s1', enabled: false }, now);
    repo.setTarget(ctx.db, { targetType: 'project', targetId: 'wakecap', enabled: false }, now);
    expect(repo.getTarget(ctx.db, 'project', 'wakecap')?.enabled).toBe(false);
    expect(repo.getTarget(ctx.db, 'session', 'missing')).toBeNull();
    expect(repo.listTargets(ctx.db)).toHaveLength(2);
  });
});
