import type { TimelineEvent } from '@orc/core';
import { describe, expect, it } from 'vitest';
import {
  formatMs,
  formatPct,
  formatTokens,
  inputSummary,
  shortPath,
  statsSummary,
  toolLabel,
} from './format.ts';
import { buildTurnViews } from './group-events.ts';

let seq = 0;
const ev = (p: Partial<TimelineEvent> & Pick<TimelineEvent, 'kind'>): TimelineEvent => {
  seq += 1;
  return {
    sessionId: 's',
    agentId: null,
    uuid: `u${seq}`,
    parentUuid: null,
    seq,
    ts: `2026-09-01T09:00:${String(seq).padStart(2, '0')}.000Z`,
    turn: 1,
    text: null,
    tool: null,
    toolUseId: null,
    mcpServer: null,
    input: null,
    messageId: null,
    model: null,
    usage: null,
    durationMs: null,
    ...p,
  };
};

function sample(): TimelineEvent[] {
  seq = 0;
  return [
    ev({ kind: 'prompt', text: 'check tests' }),
    ev({ kind: 'assistant_text', text: 'Running' }),
    ev({ kind: 'tool_call', tool: 'Bash', toolUseId: 'b1', input: { command: 'pnpm test' } }),
    ev({ kind: 'tool_result', toolUseId: 'b1', text: 'ok' }),
    ev({ kind: 'tool_call', tool: 'Bash', toolUseId: 'b2', input: { command: 'pnpm lint' } }),
    ev({ kind: 'tool_result', toolUseId: 'b2', text: 'ok' }),
    ev({ kind: 'thinking', text: 'hmm' }),
    ev({
      kind: 'tool_call',
      tool: 'mcp__claude_ai_Linear__save_issue',
      toolUseId: 'l1',
      input: { id: 'SAF-1' },
    }),
    ev({ kind: 'system', durationMs: 36000 }),
    ev({ kind: 'prompt', turn: 2, text: 'continue' }),
  ];
}

describe('buildTurnViews', () => {
  it('groups consecutive same-tool calls in normal mode', () => {
    const [t1, t2] = buildTurnViews(sample(), 'normal');
    expect(t1?.key).toBe('main:1');
    expect(t1?.prompt?.text).toBe('check tests');
    expect(t1?.items.map((i) => (i.kind === 'tool_group' ? `${i.label}×${i.calls.length}` : i.kind))).toEqual(
      ['text', 'Bash×2', 'Linear save_issue×1', 'marker'],
    );
    const group = t1?.items[1];
    expect(group?.kind === 'tool_group' && group.calls[0]?.result?.text).toBe('ok');
    const linear = t1?.items[2];
    expect(linear?.kind === 'tool_group' && linear.calls[0]?.result).toBeNull();
    expect(t2).toMatchObject({ key: 'main:2', items: [] });
  });

  it('shows every step and thinking in verbose mode', () => {
    const [t1] = buildTurnViews(sample(), 'verbose');
    expect(t1?.items.map((i) => i.kind)).toEqual(['text', 'tool', 'tool', 'thinking', 'tool', 'marker']);
  });

  it('keeps only prompts in summary mode', () => {
    const views = buildTurnViews(sample(), 'summary');
    expect(views.map((v) => [v.prompt?.text, v.items.length])).toEqual([
      ['check tests', 0],
      ['continue', 0],
    ]);
  });

  it('separates agent transcripts', () => {
    seq = 0;
    const views = buildTurnViews(
      [ev({ kind: 'assistant_text', agentId: 'ag1', turn: 0, text: 'x' })],
      'normal',
    );
    expect(views[0]).toMatchObject({ key: 'ag1:0', prompt: null });
  });
});

describe('format helpers', () => {
  it.each([
    [null, '—'],
    [950, '950ms'],
    [10800, '10.8s'],
    [125000, '2m 5s'],
  ] as const)('formatMs(%s) = %s', (ms, out) => {
    expect(formatMs(ms)).toBe(out);
  });

  it('formats other values', () => {
    expect(formatPct(0.948)).toBe('95%');
    expect(formatPct(null)).toBe('—');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(2100)).toBe('2.1k');
    expect(formatTokens(3_400_000)).toBe('3.40M');
    expect(
      statsSummary({ modelMs: 10800, toolMs: 25200, ttftMs: 5000, tokensPerSec: 2.5, cacheHitRate: 0.948 }),
    ).toEqual(['model 10.8s', 'tools 25.2s', 'TTFT ≈5.0s', '2.5 tok/s', 'cache 95%']);
  });

  it('labels tools and summarizes inputs', () => {
    expect(toolLabel('mcp__claude_ai_Linear__save_issue')).toBe('Linear save_issue');
    expect(toolLabel('Bash')).toBe('Bash');
    seq = 0;
    expect(inputSummary(ev({ kind: 'tool_call', input: { command: 'pnpm test' } }))).toBe('pnpm test');
    expect(inputSummary(ev({ kind: 'tool_call', input: { file_path: '/a/b.ts', old_string: 'x' } }))).toBe(
      '/a/b.ts',
    );
    expect(inputSummary(ev({ kind: 'tool_call', input: { id: 'SAF-1' } }))).toBe('{"id":"SAF-1"}');
    expect(shortPath('/Users/test/Wakecap/Backend/svc/a.ts')).toBe('…/svc/a.ts');
    expect(shortPath('a.ts')).toBe('a.ts');
  });
});
