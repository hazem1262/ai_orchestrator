import { describe, expect, it } from 'vitest';
import { eventFixture as ev } from '../../test/factories.ts';
import { groupTimeline, inputPreview, toolLabel } from './timeline-model.ts';

describe('timeline model', () => {
  it('labels tools', () => {
    expect(toolLabel('Bash')).toBe('Bash');
    expect(toolLabel('mcp__claude_ai_Linear__save_issue')).toBe('Linear save_issue');
  });

  it('previews inputs', () => {
    expect(inputPreview({ command: 'pnpm test', description: 'x' })).toBe('pnpm test');
    expect(inputPreview({ file_path: '/a.ts', old_string: 'a' })).toBe('/a.ts');
    expect(inputPreview({ id: 'SAF-1' })).toBe('{"id":"SAF-1"}');
    expect(inputPreview('x'.repeat(300))).toHaveLength(201);
    expect(inputPreview(null)).toBe('');
  });

  it('groups turns, consecutive tools and attaches results', () => {
    const turns = groupTimeline([
      ev({ seq: 1, kind: 'prompt', turn: 1, text: 'check tests' }),
      ev({ seq: 2, kind: 'assistant_text', text: 'Running.' }),
      ev({ seq: 3, kind: 'tool_call', tool: 'Bash', toolUseId: 't1', input: { command: 'pnpm test' } }),
      ev({ seq: 4, kind: 'tool_result', toolUseId: 't1', text: '18 passed' }),
      ev({ seq: 5, kind: 'thinking', text: 'hmm' }),
      ev({ seq: 6, kind: 'tool_call', tool: 'Bash', toolUseId: 't2', input: { command: 'git status' } }),
      ev({ seq: 7, kind: 'tool_call', tool: 'Edit', toolUseId: 't3', input: { file_path: '/a.ts' } }),
      ev({ seq: 8, kind: 'assistant_text', text: 'Edited.' }),
      ev({ seq: 9, kind: 'tool_call', tool: 'Bash', toolUseId: 't4' }),
      ev({ seq: 10, kind: 'system', tool: 'turn_duration', durationMs: 36000 }),
      ev({ seq: 11, kind: 'prompt', turn: 2, text: 'continue' }),
      ev({ seq: 12, kind: 'tool_result', turn: 2, toolUseId: 'from-earlier-page', text: 'orphan' }),
    ]);
    expect(turns.map((t) => [t.turn, t.prompt?.text ?? null])).toEqual([
      [1, 'check tests'],
      [2, 'continue'],
    ]);
    const first = turns[0]?.items ?? [];
    expect(first.map((i) => (i.type === 'tools' ? `${i.label}×${i.calls.length}` : i.event.kind))).toEqual([
      'assistant_text',
      'Bash×2',
      'Edit×1',
      'assistant_text',
      'Bash×1',
      'system',
    ]);
    const bash = first[1];
    expect(bash?.type === 'tools' && bash.calls.map((c) => c.result?.text ?? null)).toEqual([
      '18 passed',
      null,
    ]);
    expect(turns[1]?.items.map((i) => (i.type === 'event' ? i.event.text : ''))).toEqual(['orphan']);
  });

  it('keeps events before the first prompt in turn 0', () => {
    const turns = groupTimeline([ev({ seq: 1, turn: 0, kind: 'system', tool: 'x', text: 'boot' })]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ turn: 0, prompt: null });
  });
});
