import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileTicketRegex, DEFAULT_TICKET_REGEX } from '../derive/tickets.ts';
import { parseJsonLine, readJsonlFrom } from '../io/jsonl-tail.ts';
import { FIXTURES_DIR } from '../test-utils/fixtures.ts';
import type { TimelineEvent } from '../types/events.ts';
import { codexStateToSession, createCodexAggState, ingestCodexRecord } from './codex-aggregate.ts';
import { codexShellCommand, parseCodexEnvelope } from './rollout.ts';

const resolve = () => ({ ticketRegex: compileTicketRegex(DEFAULT_TICKET_REGEX), prodPatterns: [] });
const BASIC =
  'codex-home/sessions/2026/09/01/rollout-2026-09-01T09-00-00-c0dex000-0000-0000-0000-000000000001.jsonl';
const AUTO =
  'codex-home/sessions/2026/03/10/rollout-2026-03-10T09-00-00-c0dex000-0000-0000-0000-000000000002.jsonl';
const SEARCH =
  'codex-home/sessions/2026/09/02/rollout-2026-09-02T10-00-00-c0dex000-0000-0000-0000-000000000003.jsonl';
const opts = { projectId: 'wakecap', transcriptPath: '/r.jsonl', availability: 'resumable' as const };

async function ingest(rel: string) {
  const state = createCodexAggState();
  const events: TimelineEvent[] = [];
  for (const l of (await readJsonlFrom(join(FIXTURES_DIR, rel), 0)).lines) {
    events.push(...ingestCodexRecord(state, parseJsonLine(l.text), resolve));
  }
  return { state, events };
}

describe('rollout helpers', () => {
  it('parses envelopes and shell commands', () => {
    expect(parseCodexEnvelope({ timestamp: 't', type: 'x', payload: {} })).toEqual({
      timestamp: 't',
      ordinal: null,
      type: 'x',
      payload: {},
    });
    expect(parseCodexEnvelope({ type: 'x' })).toBeNull();
    expect(codexShellCommand({ command: ['rg', 'weekend'] })).toBe('rg weekend');
    expect(codexShellCommand({ cmd: 'pnpm test' })).toBe('pnpm test');
    expect(codexShellCommand('{"command":["ls"]}')).toBe('ls');
    expect(codexShellCommand(42)).toBeNull();
  });
});

describe('Codex aggregate', () => {
  it('maps codex-basic to events', async () => {
    const { events } = await ingest(BASIC);
    expect(events.map((e) => [e.kind, e.seq, e.turn])).toEqual([
      ['prompt', 1, 1],
      ['tool_call', 2, 1],
      ['tool_result', 3, 1],
      ['assistant_text', 4, 1],
    ]);
    expect(events[0]).toMatchObject({
      sessionId: 'c0dex000-0000-0000-0000-000000000001',
      uuid: 'c0dex000-0000-0000-0000-000000000001:2',
      text: 'second opinion on SAF-1787 plan',
      agentId: null,
    });
    expect(events[1]).toMatchObject({
      tool: 'shell',
      toolUseId: 'c1',
      input: { command: ['rg', 'weekend'] },
    });
    expect(events[2]).toMatchObject({ toolUseId: 'c1', text: '3 matches' });
    expect(events[3]?.text).toBe('Plan looks fine.');
  });

  it('builds the codex-basic session', async () => {
    const { state } = await ingest(BASIC);
    expect(codexStateToSession(state, opts)).toMatchObject({
      id: 'c0dex000-0000-0000-0000-000000000001',
      source: 'codex',
      startCwd: '/Users/test/Wakecap',
      name: 'second opinion on SAF-1787 plan',
      models: ['gpt-5.5-codex'],
      tickets: ['SAF-1787'],
      toolCallCount: 1,
      promptCount: 1,
      startedAt: '2026-09-01T09:00:00.000Z',
      lastActivityAt: '2026-09-01T09:00:11.000Z',
      usage: { input: 400, output: 90, cacheRead: 800, cacheWrite: 0, costUsd: null },
      flags: { touchedProd: false, hasSubagents: false, automated: false },
    });
    expect(JSON.stringify(state)).not.toContain('LONG TEXT SKIPPED');
  });

  it('flags codex_sdk_ts sessions as automated', async () => {
    const { state } = await ingest(AUTO);
    expect(codexStateToSession(state, opts)?.flags.automated).toBe(true);
  });

  it('skips injected context messages and parses test output', () => {
    const state = createCodexAggState();
    const rec = (ordinal: number, type: string, payload: Record<string, unknown>) => ({
      timestamp: `2026-09-01T10:00:0${ordinal}.000Z`,
      ordinal,
      type,
      payload,
    });
    ingestCodexRecord(
      state,
      rec(0, 'session_meta', { id: 'c3', cwd: '/w', originator: 'codex_cli_rs' }),
      resolve,
    );
    const ctx = ingestCodexRecord(
      state,
      rec(1, 'response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>x' }],
      }),
      resolve,
    );
    expect(ctx).toEqual([]);
    ingestCodexRecord(
      state,
      rec(2, 'response_item', {
        type: 'function_call',
        name: 'shell',
        arguments: '{"command":["pnpm","vitest","run"]}',
        call_id: 'k',
      }),
      resolve,
    );
    ingestCodexRecord(
      state,
      rec(3, 'response_item', {
        type: 'function_call_output',
        call_id: 'k',
        output: JSON.stringify({ output: '      Tests  3 passed (3)\n   Duration  10ms', metadata: {} }),
      }),
      resolve,
    );
    ingestCodexRecord(
      state,
      rec(4, 'response_item', {
        type: 'custom_tool_call',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Update File: /w/a.ts\n',
        call_id: 'p',
      }),
      resolve,
    );
    const err = ingestCodexRecord(
      state,
      rec(5, 'event_msg', { type: 'error', message: 'stream disconnected' }),
      resolve,
    );
    const s = codexStateToSession(state, opts);
    expect(s?.lastTest).toMatchObject({ passed: 3, failed: 0, command: 'pnpm vitest run' });
    expect(s?.filesTouched).toEqual(['/w/a.ts']);
    expect(s?.apiErrorCount).toBe(1);
    expect(err[0]).toMatchObject({ kind: 'error', text: 'stream disconnected' });
    expect(s?.promptCount).toBe(0);
    expect(s?.name).toBeNull();
  });

  it('returns null without session_meta', () => {
    expect(codexStateToSession(createCodexAggState(), opts)).toBeNull();
  });

  it('maps tool_search and web_search response_item payloads (S5 payload cross-check)', async () => {
    const { state, events } = await ingest(SEARCH);
    // prompt, tool_search_call, tool_search_output, web_search_call
    expect(events.map((e) => e.kind)).toEqual(['prompt', 'tool_call', 'tool_result', 'tool_call']);
    const [, searchCall, searchOutput, webCall] = events;
    expect(searchCall).toMatchObject({ tool: 'tool_search', toolUseId: 's1' });
    expect(searchOutput).toMatchObject({ kind: 'tool_result', toolUseId: 's1', text: '2 results' });
    expect(webCall).toMatchObject({ tool: 'web_search', toolUseId: 'w1' });
    expect(state.toolCallCount).toBe(2);
  });
});
