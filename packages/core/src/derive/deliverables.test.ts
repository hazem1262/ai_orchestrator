import { describe, expect, it } from 'vitest';
import { ev } from '../test-utils/events.ts';
import { deliverablesByTurn, extractFileChanges, summarizeFiles } from './deliverables.ts';

const T = (s: string) => `2026-09-01T10:${s}Z`;
const patch = [
  '*** Begin Patch',
  '*** Update File: src/x.ts',
  '@@',
  '-a',
  '+b',
  '*** Add File: src/y.ts',
  '+new',
  '*** End Patch',
].join('\n');

const events = [
  ev({ seq: 1, ts: T('00:00.000'), kind: 'prompt', turn: 1 }),
  ev({ seq: 2, ts: T('00:01.000'), kind: 'assistant_text', turn: 1, text: 'I changed c.ts' }),
  ev({
    seq: 3,
    ts: T('00:02.000'),
    kind: 'tool_call',
    turn: 1,
    tool: 'Edit',
    toolUseId: 'e1',
    input: { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' },
  }),
  ev({ seq: 4, ts: T('00:03.000'), kind: 'tool_result', turn: 1, toolUseId: 'e1', text: 'ok' }),
  ev({
    seq: 5,
    ts: T('00:04.000'),
    kind: 'tool_call',
    turn: 1,
    tool: 'Write',
    toolUseId: 'w1',
    input: { file_path: '/r/b.ts', content: 'x' },
  }),
  ev({
    seq: 6,
    ts: T('00:05.000'),
    kind: 'tool_result',
    turn: 1,
    toolUseId: 'w1',
    text: '<tool_use_error>File has not been read yet</tool_use_error>',
  }),
  ev({
    seq: 7,
    ts: T('00:06.000'),
    kind: 'tool_call',
    turn: 1,
    tool: 'Edit',
    toolUseId: 'e2',
    input: { file_path: '/r/a.ts', old_string: 'b', new_string: 'c' },
  }),
  ev({
    seq: 8,
    ts: T('00:07.000'),
    kind: 'tool_call',
    turn: 1,
    tool: 'Bash',
    toolUseId: 'b1',
    input: { command: "sed -i '' s/a/b/ /r/z.ts" },
  }),
  ev({ seq: 9, ts: T('01:00.000'), kind: 'prompt', turn: 2 }),
  ev({
    seq: 10,
    ts: T('01:01.000'),
    kind: 'tool_call',
    turn: 2,
    tool: 'MultiEdit',
    toolUseId: 'm1',
    input: {
      file_path: '/r/a.ts',
      edits: [
        { old_string: 'c', new_string: 'd' },
        { old_string: 'e', new_string: 'f' },
      ],
    },
  }),
  ev({ seq: 11, ts: T('01:02.000'), kind: 'tool_result', turn: 2, toolUseId: 'm1', text: 'ok' }),
  ev({
    seq: 12,
    ts: T('01:03.000'),
    kind: 'tool_call',
    turn: 2,
    tool: 'NotebookEdit',
    toolUseId: 'n1',
    input: { notebook_path: '/r/nb.ipynb', new_source: 'print(1)' },
  }),
  ev({ seq: 13, ts: T('01:04.000'), kind: 'tool_result', turn: 2, toolUseId: 'n1', text: 'ok' }),
  ev({
    seq: 14,
    ts: T('01:05.000'),
    kind: 'tool_call',
    turn: 2,
    tool: 'apply_patch',
    toolUseId: 'p1',
    input: patch,
    agentId: null,
  }),
  ev({ seq: 15, ts: T('01:06.000'), kind: 'tool_result', turn: 2, toolUseId: 'p1', text: 'Done' }),
];

describe('extractFileChanges', () => {
  it('uses tool inputs only and resolves status from results', () => {
    const changes = extractFileChanges(events);
    expect(changes.map((c) => [c.path, c.tool, c.status])).toEqual([
      ['/r/a.ts', 'Edit', 'applied'],
      ['/r/b.ts', 'Write', 'failed'],
      ['/r/a.ts', 'Edit', 'pending'],
      ['/r/a.ts', 'MultiEdit', 'applied'],
      ['/r/nb.ipynb', 'NotebookEdit', 'applied'],
      ['src/x.ts', 'apply_patch', 'applied'],
      ['src/y.ts', 'apply_patch', 'applied'],
    ]);
    expect(changes[0]).toMatchObject({ oldText: 'a', newText: 'b', turn: 1, seq: 3 });
    expect(changes[3]).toMatchObject({ oldText: 'c\n…\ne', newText: 'd\n…\nf' });
    expect(changes.some((c) => c.path.endsWith('c.ts') || c.path.endsWith('z.ts'))).toBe(false);
  });

  it('clips long texts', () => {
    const big = 'x'.repeat(5000);
    const [c] = extractFileChanges([
      ev({
        seq: 1,
        ts: T('00:00.000'),
        kind: 'tool_call',
        tool: 'Write',
        toolUseId: 'w',
        input: { file_path: '/f', content: big },
      }),
    ]);
    expect(c?.newText).toHaveLength(4001);
    expect(c?.status).toBe('pending');
  });
});

describe('deliverablesByTurn', () => {
  it('groups by turn and path with the best status', () => {
    const d = deliverablesByTurn(events);
    expect(d).toEqual([
      {
        turn: 1,
        agentId: null,
        files: [
          { path: '/r/a.ts', tools: ['Edit'], ops: 2, status: 'applied', lastTs: T('00:06.000') },
          { path: '/r/b.ts', tools: ['Write'], ops: 1, status: 'failed', lastTs: T('00:04.000') },
        ],
      },
      {
        turn: 2,
        agentId: null,
        files: [
          { path: '/r/a.ts', tools: ['MultiEdit'], ops: 1, status: 'applied', lastTs: T('01:01.000') },
          { path: '/r/nb.ipynb', tools: ['NotebookEdit'], ops: 1, status: 'applied', lastTs: T('01:03.000') },
          { path: 'src/x.ts', tools: ['apply_patch'], ops: 1, status: 'applied', lastTs: T('01:05.000') },
          { path: 'src/y.ts', tools: ['apply_patch'], ops: 1, status: 'applied', lastTs: T('01:05.000') },
        ],
      },
    ]);
  });
});

describe('summarizeFiles', () => {
  it('aggregates across turns, newest first', () => {
    const s = summarizeFiles(extractFileChanges(events));
    expect(s.map((f) => f.path)).toEqual(['src/x.ts', 'src/y.ts', '/r/nb.ipynb', '/r/a.ts', '/r/b.ts']);
    const a = s.find((f) => f.path === '/r/a.ts');
    expect(a).toMatchObject({
      ops: 3,
      failedOps: 0,
      turns: [1, 2],
      agentIds: [null],
      firstTs: T('00:02.000'),
      lastTs: T('01:01.000'),
    });
    expect(a?.changes).toHaveLength(3);
    expect(s.find((f) => f.path === '/r/b.ts')?.failedOps).toBe(1);
  });
});
