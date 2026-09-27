import { describe, expect, it } from 'vitest';
import { ev as e, usage } from '../test-utils/events.ts';
import type { TimelineEvent, Usage } from '../types/index.ts';
import { extractLedgerFacts } from './ledger.ts';

const u = (input: number, output: number, costUsd: number | null = null): Usage => ({
  ...usage(input, output, 0, 0),
  costUsd,
});

const events: TimelineEvent[] = [
  e({ seq: 1, ts: '2026-09-17T10:00:00.000Z', kind: 'prompt', text: '/conductor SAF-1 go' }),
  e({
    seq: 2,
    ts: '2026-09-17T10:00:04.000Z',
    kind: 'assistant_text',
    messageId: 'm1',
    model: 'claude-opus-5',
    usage: u(10, 20),
  }),
  e({
    seq: 3,
    ts: '2026-09-17T10:00:04.100Z',
    kind: 'tool_call',
    messageId: 'm1',
    model: 'claude-opus-5',
    tool: 'Bash',
    toolUseId: 't1',
  }),
  e({ seq: 4, ts: '2026-09-17T10:00:09.100Z', kind: 'tool_result', toolUseId: 't1', text: 'SECRET OUTPUT' }),
  e({
    seq: 5,
    ts: '2026-09-17T10:00:11.100Z',
    kind: 'tool_call',
    messageId: 'm2',
    model: 'claude-opus-5',
    usage: u(5, 5, 0.3),
    tool: 'Skill',
    toolUseId: 't2',
    input: { skill: 'review' },
  }),
  e({
    seq: 6,
    ts: '2026-09-17T10:00:12.000Z',
    kind: 'tool_call',
    messageId: 'm2',
    model: 'claude-opus-5',
    tool: 'mcp__claude_ai_Linear__save_issue',
    mcpServer: 'claude_ai_Linear',
    toolUseId: 't3',
  }),
  e({
    seq: 7,
    ts: '2026-09-17T10:00:13.000Z',
    kind: 'error',
    messageId: 'm3',
    model: '<synthetic>',
    usage: u(0, 0),
  }),
];

describe('extractLedgerFacts', () => {
  it('extracts one usage fact per message with latency, skipping synthetic', () => {
    const x = extractLedgerFacts(events, '', null);
    expect(x.usage.map((f) => [f.messageId, f.latencyMs, f.usage.costUsd])).toEqual([
      ['m1', 4000, null],
      ['m2', 2000, 0.3],
    ]);
    expect(x.lastTs).toBe('2026-09-17T10:00:13.000Z');
  });

  it('classifies tools, MCP servers and skills and records results', () => {
    const x = extractLedgerFacts(events, 'ag1', null);
    expect(x.tools.map((t) => [t.kind, t.name, t.toolUseId, t.agentKey])).toEqual([
      ['skill', 'conductor', null, 'ag1'],
      ['tool', 'Bash', 't1', 'ag1'],
      ['skill', 'review', 't2', 'ag1'],
      ['mcp', 'claude_ai_Linear', 't3', 'ag1'],
    ]);
    expect(x.tools[0]?.factKey).toBe('prompt:2026-09-17T10:00:00.000Z:skill:conductor');
    expect(x.toolResults).toEqual([{ toolUseId: 't1', ts: '2026-09-17T10:00:09.100Z' }]);
  });

  it('uses prevTs for the first event of a batch and never copies text', () => {
    const x = extractLedgerFacts([events[1] as TimelineEvent], '', '2026-09-17T10:00:01.000Z');
    expect(x.usage[0]?.latencyMs).toBe(3000);
    expect(JSON.stringify(extractLedgerFacts(events, '', null))).not.toContain('SECRET');
  });
});
