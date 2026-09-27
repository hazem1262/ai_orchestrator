import { describe, expect, it } from 'vitest';
import {
  type AnalyticsEntry,
  bucketKey,
  costPerMergedPr,
  groupCost,
  summarizeFacets,
  summarizeWstackTimeline,
  timingSummary,
  toolUsageRows,
  topSessionCosts,
  topTickets,
} from './analytics.ts';

const e = (p: Partial<AnalyticsEntry>): AnalyticsEntry => ({
  sessionPk: 'claude:a',
  ts: '2026-09-15T10:00:00.000Z',
  source: 'claude',
  projectId: 'wakecap',
  tickets: [],
  model: 'claude-opus-5',
  input: 10,
  output: 10,
  cacheRead: 80,
  cacheWrite: 0,
  costUsd: 1,
  latencyMs: 1000,
  ...p,
});
const entries = [
  e({ tickets: ['SAF-1'], costUsd: 4 }),
  e({
    sessionPk: 'claude:b',
    ts: '2026-09-16T10:00:00.000Z',
    tickets: ['SAF-1', 'SAF-2'],
    costUsd: 2,
    model: 'claude-sonnet-5',
  }),
  e({
    sessionPk: 'codex:c',
    ts: '2026-09-21T10:00:00.000Z',
    source: 'codex',
    projectId: null,
    costUsd: 3,
    cacheRead: 0,
    latencyMs: null,
  }),
];

describe('analytics', () => {
  it('buckets by UTC day and ISO week', () => {
    expect(bucketKey('2026-09-20T23:59:00.000Z', 'day')).toBe('2026-09-20');
    expect(bucketKey('2026-09-20T23:59:00.000Z', 'week')).toBe('2026-09-14');
    expect(bucketKey('2026-09-21T00:00:00.000Z', 'week')).toBe('2026-09-21');
  });

  it('groups cost by every dimension', () => {
    expect(groupCost(entries, 'day').map((r) => [r.key, r.costUsd])).toEqual([
      ['2026-09-15', 4],
      ['2026-09-16', 2],
      ['2026-09-21', 3],
    ]);
    expect(groupCost(entries, 'week').map((r) => [r.key, r.costUsd, r.sessions])).toEqual([
      ['2026-09-14', 6, 2],
      ['2026-09-21', 3, 1],
    ]);
    expect(groupCost(entries, 'project').map((r) => [r.key, r.costUsd])).toEqual([
      ['wakecap', 6],
      ['unassigned', 3],
    ]);
    expect(groupCost(entries, 'model').map((r) => r.key)).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(groupCost(entries, 'source').map((r) => [r.key, r.costUsd])).toEqual([
      ['claude', 6],
      ['codex', 3],
    ]);
    const byTicket = groupCost(entries, 'ticket');
    expect(byTicket.map((r) => [r.key, r.costUsd])).toEqual([
      ['SAF-1', 5],
      ['(none)', 3],
      ['SAF-2', 1],
    ]);
    expect(byTicket[0]?.tokens).toEqual({ input: 15, output: 15, cacheRead: 120, cacheWrite: 0 });
  });

  it('ranks sessions and tickets and computes cost per merged PR', () => {
    expect(topSessionCosts(entries, 2)).toEqual([
      { pk: 'claude:a', costUsd: 4 },
      { pk: 'codex:c', costUsd: 3 },
    ]);
    expect(topTickets(entries, 5)).toEqual([
      { ticket: 'SAF-1', costUsd: 5, sessions: 2 },
      { ticket: 'SAF-2', costUsd: 1, sessions: 1 },
    ]);
    expect(costPerMergedPr(entries, [['claude:a'], ['claude:a', 'claude:b']])).toEqual({
      mergedPrs: 2,
      costPerMergedPrUsd: 3,
    });
    expect(costPerMergedPr(entries, [])).toEqual({ mergedPrs: 0, costPerMergedPrUsd: null });
  });

  it('counts tool usage per bucket and summarises timing', () => {
    const tools = [
      { ts: '2026-09-15T10:00:00.000Z', kind: 'tool' as const, name: 'Bash', durationMs: 3000 },
      { ts: '2026-09-15T11:00:00.000Z', kind: 'tool' as const, name: 'Bash', durationMs: null },
      { ts: '2026-09-15T12:00:00.000Z', kind: 'mcp' as const, name: 'claude_ai_Linear', durationMs: 1000 },
      { ts: '2026-09-16T12:00:00.000Z', kind: 'skill' as const, name: 'conductor', durationMs: null },
    ];
    expect(toolUsageRows(tools, 'day')).toEqual([
      { bucket: '2026-09-15', kind: 'tool', name: 'Bash', count: 2 },
      { bucket: '2026-09-15', kind: 'mcp', name: 'claude_ai_Linear', count: 1 },
      { bucket: '2026-09-16', kind: 'skill', name: 'conductor', count: 1 },
    ]);
    expect(timingSummary(entries, tools, 'day')).toEqual({
      modelMs: 2000,
      toolMs: 4000,
      modelShare: 2000 / 6000,
      cacheHitTrend: [
        { bucket: '2026-09-15', rate: 80 / 90 },
        { bucket: '2026-09-16', rate: 80 / 90 },
        { bucket: '2026-09-21', rate: 0 },
      ],
    });
    expect(timingSummary([], [], 'day')).toEqual({
      modelMs: 0,
      toolMs: 0,
      modelShare: null,
      cacheHitTrend: [],
    });
  });

  it('summarises facets, optionally limited to sessions', () => {
    const facets = [
      {
        session_id: 'a',
        outcome: 'fully_achieved',
        friction_counts: { buggy_code: 2 },
        goal_categories: { debugging: 1 },
      },
      { session_id: 'b', outcome: 'mostly_achieved', friction_counts: { buggy_code: 1, tool_failure: 1 } },
      { session_id: 'z', outcome: 'fully_achieved' },
      'garbage',
    ];
    expect(summarizeFacets(facets, null)).toEqual({
      sessions: 3,
      outcomes: { fully_achieved: 2, mostly_achieved: 1 },
      friction: { buggy_code: 3, tool_failure: 1 },
      goalCategories: { debugging: 1 },
    });
    expect(summarizeFacets(facets, new Set(['a'])).sessions).toBe(1);
  });

  it('summarises wstack skill outcomes in range', () => {
    const lines = [
      { skill: 'ship', event: 'started', ts: '2026-09-15T10:00:00Z' },
      { skill: 'ship', outcome: 'success', duration_s: 60, ts: '2026-09-15T10:01:00Z' },
      { skill: 'ship', outcome: 'error', duration_s: 20, ts: '2026-09-16T10:00:00Z' },
      { skill: 'qa', outcome: 'success', ts: 1789000000 },
      { skill: 'old', outcome: 'success', ts: '2026-01-01T00:00:00Z' },
    ];
    expect(summarizeWstackTimeline(lines, '2026-09-01T00:00:00.000Z', '2026-09-30T00:00:00.000Z')).toEqual([
      { skill: 'ship', runs: 2, outcomes: { success: 1, error: 1 }, avgDurationS: 40 },
      { skill: 'qa', runs: 1, outcomes: { success: 1 }, avgDurationS: null },
    ]);
  });
});
