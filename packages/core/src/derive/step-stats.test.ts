import { describe, expect, it } from 'vitest';
import { ev, usage } from '../test-utils/events.ts';
import { cacheHitRate, computeSessionStats, computeTurnStats, median, unionMs } from './step-stats.ts';

const T = (s: string) => `2026-09-01T09:${s}Z`;

const events = [
  ev({ seq: 1, ts: T('00:00.000'), kind: 'prompt', turn: 1, text: 'check tests' }),
  ev({
    seq: 2,
    ts: T('00:05.000'),
    kind: 'tool_call',
    turn: 1,
    tool: 'Bash',
    toolUseId: 'tu1',
    messageId: 'm1',
    model: 'claude-opus-5',
    usage: usage(10, 20, 1000, 100),
  }),
  ev({ seq: 3, ts: T('00:30.000'), kind: 'tool_result', turn: 1, toolUseId: 'tu1', text: 'Tests 18 passed' }),
  ev({
    seq: 4,
    ts: T('00:35.000'),
    kind: 'tool_call',
    turn: 1,
    tool: 'Edit',
    toolUseId: 'tu2',
    messageId: 'm2',
    model: 'claude-opus-5',
    usage: usage(5, 7, 1100, 0),
  }),
  ev({
    seq: 5,
    ts: T('00:35.200'),
    kind: 'tool_result',
    turn: 1,
    toolUseId: 'tu2',
    text: '<tool_use_error>String not found</tool_use_error>',
  }),
  ev({ seq: 6, ts: T('00:35.500'), kind: 'assistant_text', turn: 1, text: 'Edited.', messageId: 'm2' }),
  ev({ seq: 7, ts: T('00:36.000'), kind: 'system', turn: 1, durationMs: 36000 }),
  ev({ seq: 8, ts: T('05:00.000'), kind: 'prompt', turn: 2, text: 'continue' }),
];

describe('computeTurnStats', () => {
  it('splits model time and tool time and derives rates', () => {
    const [t1, t2] = computeTurnStats(events);
    expect(t1).toMatchObject({
      turn: 1,
      agentId: null,
      startedAt: '2026-09-01T09:00:00.000Z',
      endedAt: '2026-09-01T09:00:36.000Z',
      wallMs: 36000,
      toolMs: 25200,
      modelMs: 10800,
      reportedMs: 36000,
      ttftMs: 5000,
      toolCalls: 2,
      toolErrors: 1,
      apiErrors: 0,
      usage: { input: 15, output: 27, cacheRead: 2100, cacheWrite: 100, costUsd: null },
    });
    expect(t1?.tokensPerSec).toBeCloseTo(2.5, 6);
    expect(t1?.cacheHitRate).toBeCloseTo(2100 / 2215, 6);
    expect(t2).toMatchObject({
      turn: 2,
      wallMs: 0,
      modelMs: 0,
      toolMs: 0,
      ttftMs: null,
      tokensPerSec: null,
      cacheHitRate: null,
    });
  });

  it('does not double-count parallel tool calls and ignores unanswered calls', () => {
    const par = [
      ev({ seq: 1, ts: T('00:00.000'), kind: 'prompt' }),
      ev({ seq: 2, ts: T('00:01.000'), kind: 'tool_call', tool: 'Read', toolUseId: 'a' }),
      ev({ seq: 3, ts: T('00:01.000'), kind: 'tool_call', tool: 'Read', toolUseId: 'b' }),
      ev({ seq: 4, ts: T('00:01.000'), kind: 'tool_call', tool: 'Read', toolUseId: 'c' }),
      ev({ seq: 5, ts: T('00:11.000'), kind: 'tool_result', toolUseId: 'a' }),
      ev({ seq: 6, ts: T('00:21.000'), kind: 'tool_result', toolUseId: 'b' }),
    ];
    const [t] = computeTurnStats(par);
    expect(t?.toolMs).toBe(20000);
    expect(t?.modelMs).toBe(1000);
    expect(t?.toolCalls).toBe(3);
  });

  it('groups subagent turns separately and counts API errors', () => {
    const mixed = [
      ev({ seq: 1, ts: T('00:00.000'), kind: 'assistant_text', turn: 0, agentId: 'ag1' }),
      ev({ seq: 2, ts: T('00:02.000'), kind: 'error', turn: 0, agentId: 'ag1', text: 'API Error: 529' }),
      ev({ seq: 3, ts: T('00:00.000'), kind: 'prompt', turn: 1 }),
    ];
    const stats = computeTurnStats(mixed);
    expect(stats.map((s) => [s.agentId, s.turn, s.apiErrors, s.ttftMs])).toEqual([
      ['ag1', 0, 1, null],
      [null, 1, 0, null],
    ]);
  });
});

describe('computeSessionStats', () => {
  it('aggregates turns', () => {
    const s = computeSessionStats(computeTurnStats(events));
    expect(s).toMatchObject({
      turns: 2,
      wallMs: 36000,
      toolMs: 25200,
      modelMs: 10800,
      ttftMs: 5000,
      toolCalls: 2,
      toolErrors: 1,
    });
    expect(s.tokensPerSec).toBeCloseTo(2.5, 6);
    expect(s.usage.output).toBe(27);
  });

  it('handles an empty session', () => {
    expect(computeSessionStats([])).toMatchObject({
      turns: 0,
      ttftMs: null,
      tokensPerSec: null,
      cacheHitRate: null,
    });
  });
});

describe('helpers', () => {
  it('unionMs merges overlapping and adjacent intervals', () => {
    expect(
      unionMs([
        [0, 10],
        [5, 15],
        [15, 20],
        [30, 31],
      ]),
    ).toBe(21);
    expect(unionMs([])).toBe(0);
  });
  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
  it('cacheHitRate', () => {
    expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(cacheHitRate({ input: 50, cacheRead: 150, cacheWrite: 0 })).toBe(0.75);
  });
});
