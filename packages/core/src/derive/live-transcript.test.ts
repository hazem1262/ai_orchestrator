import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJsonLine } from '../io/jsonl-tail.ts';
import { FIXTURES_DIR } from '../test-utils/fixtures.ts';
import { createLiveReducer, emptyTranscriptLive } from './live-transcript.ts';

const lines = (name: string) =>
  readFileSync(join(FIXTURES_DIR, 'claude-home/projects/-Users-test-Wakecap', name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(parseJsonLine);

const u = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  uuid,
  parentUuid: null,
  sessionId: 's',
  timestamp: '2026-09-01T10:00:00.000Z',
  message: { role: 'user', content },
  ...extra,
});
const a = (uuid: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid,
  parentUuid: null,
  sessionId: 's',
  timestamp: '2026-09-01T10:00:01.000Z',
  message: {
    id: `m-${uuid}`,
    role: 'assistant',
    model: 'claude-opus-5',
    content,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
  ...extra,
});

describe('createLiveReducer', () => {
  it('starts empty', () => {
    expect(createLiveReducer().snapshot()).toEqual(emptyTranscriptLive());
  });

  it('tracks the first turn of s-basic up to review', () => {
    const r = createLiveReducer();
    const all = lines('s-basic.jsonl');
    const effects = all.slice(0, 7).map((v) => r.apply(v));
    expect(effects[3]?.testRecorded).toEqual({
      ts: '2026-09-01T09:00:30.000Z',
      command: 'pnpm vitest run',
      passed: 18,
      failed: 0,
      skipped: 0,
      durationMs: 1400,
    });
    expect(effects[6]?.turnEnded).toBe(1);
    const s = r.snapshot();
    expect(s).toMatchObject({
      turn: 1,
      lastPrompt: 'check the notification service tests',
      currentTool: 'Edit',
      stage: 'review',
      turnEnded: true,
      turnChangedFiles: ['/Users/test/Wakecap/Backend/svc/a.ts'],
      permissionMode: 'bypassPermissions',
    });
  });

  it('resets per turn and keeps the last test', () => {
    const r = createLiveReducer();
    for (const v of lines('s-basic.jsonl')) r.apply(v);
    const s = r.snapshot();
    expect(s.turn).toBe(3);
    expect(s.lastPrompt).toBe('/review the change');
    expect(s.turnEnded).toBe(false);
    expect(s.stage).toBeNull();
    expect(s.turnChangedFiles).toEqual([]);
    expect(s.lastTest?.passed).toBe(18);
    expect(s.contextFill).toBeCloseTo(1105 / 200_000, 6);
  });

  it('records API errors and ignores non-JSON lines', () => {
    const r = createLiveReducer();
    for (const v of lines('s-errors.jsonl')) r.apply(v);
    r.apply(undefined);
    expect(r.snapshot().lastApiError).toBe('API Error: 529 overloaded');
  });

  it('counts running subagents until their result arrives', () => {
    const r = createLiveReducer();
    for (const v of lines('s-subagents.jsonl')) r.apply(v);
    expect(r.snapshot().runningSubagents).toBe(1);
    r.apply(u('r1', [{ type: 'tool_result', tool_use_id: 'gtu1', content: 'done' }], { toolUseResult: {} }));
    expect(r.snapshot().runningSubagents).toBe(0);
  });

  it('counts background shells until they complete or are killed', () => {
    const r = createLiveReducer();
    r.apply(u('p', 'start the servers'));
    r.apply(
      a('a1', [
        { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pnpm dev', run_in_background: true } },
        {
          type: 'tool_use',
          id: 'b2',
          name: 'Bash',
          input: { command: 'pnpm worker', run_in_background: true },
        },
      ]),
    );
    r.apply(
      u(
        'r1',
        [
          { type: 'tool_result', tool_use_id: 'b1', content: 'Command running in background with ID: sh_1' },
          { type: 'tool_result', tool_use_id: 'b2', content: 'Command running in background with ID: sh_2' },
        ],
        { toolUseResult: {} },
      ),
    );
    expect(r.snapshot().backgroundJobs).toBe(2);
    r.apply(
      a('a2', [
        { type: 'tool_use', id: 'o1', name: 'BashOutput', input: { bash_id: 'sh_1' } },
        { type: 'tool_use', id: 'k1', name: 'KillShell', input: { shell_id: 'sh_2' } },
      ]),
    );
    expect(r.snapshot().backgroundJobs).toBe(1);
    r.apply(
      u('r2', [{ type: 'tool_result', tool_use_id: 'o1', content: '<status>completed</status>' }], {
        toolUseResult: {},
      }),
    );
    expect(r.snapshot().backgroundJobs).toBe(0);
  });

  it('counts PR links in the current turn and records failing tests', () => {
    const r = createLiveReducer();
    r.apply(u('p', 'ship it'));
    r.apply(a('a1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } }]));
    const eff = r.apply(
      u('r1', [{ type: 'tool_result', tool_use_id: 't1', content: '      Tests  2 failed | 5 passed (7)' }], {
        toolUseResult: {},
      }),
    );
    expect(eff.testRecorded?.failed).toBe(2);
    r.apply({
      type: 'pr-link',
      prNumber: 1,
      prUrl: 'https://github.com/example-org/r/pull/1',
      prRepository: 'example-org/r',
      sessionId: 's',
    });
    r.apply({
      type: 'system',
      subtype: 'stop_hook_summary',
      uuid: 'x',
      parentUuid: null,
      sessionId: 's',
      timestamp: '2026-09-01T10:00:05.000Z',
    });
    expect(r.snapshot()).toMatchObject({ turnPrs: 1, turnEnded: true, stage: 'test' });
  });

  /**
   * The daemon's `refoldUpTo` (LiveTracker) replays history into a rebuilt reducer up to — and
   * excluding — the record that triggered the rebuild, then applies that record itself. Its
   * off-by-one is invisible through that caller *because* re-applying one assistant record is a
   * no-op here: every write in the assistant branch is either a scalar assignment or a Set/Map
   * insert, and the one array append (`categories`) is collapsed by `inferStage` taking a max.
   * That is a property of THIS file, and nothing in this package pinned it — so the daemon's
   * argument for why its boundary is safe rested on an untested assumption. It is tested here.
   */
  it('is idempotent when the same assistant record is applied twice', () => {
    const rich = a('a1', [
      { type: 'text', text: 'working' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/a.ts' } },
      { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/w/b.ts' } },
      { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'pnpm vitest run' } },
      { type: 'tool_use', id: 't4', name: 'Task', input: { description: 'sub' } },
      { type: 'tool_use', id: 't5', name: 'Bash', input: { command: 'sleep 9', run_in_background: true } },
    ]);
    const prompt = u('u1', 'go');

    const once = createLiveReducer();
    once.apply(prompt);
    once.apply(rich);

    const twice = createLiveReducer();
    twice.apply(prompt);
    twice.apply(rich);
    const secondEffects = twice.apply(rich);

    expect(secondEffects).toEqual({ testRecorded: null, turnEnded: null });
    expect(twice.snapshot()).toEqual(once.snapshot());
  });

  it('uses the configured context window', () => {
    const r = createLiveReducer({ contextWindow: 1000 });
    r.apply(a('a1', [{ type: 'text', text: 'hi' }], {}));
    const big = a('a2', [{ type: 'text', text: 'hi' }]);
    big.message.usage = {
      input_tokens: 400,
      output_tokens: 1,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    };
    r.apply(big);
    expect(r.snapshot().contextFill).toBe(1);
  });
});
