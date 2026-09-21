import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileProdPatterns, DEFAULT_PROD_PATTERNS } from '../derive/prod.ts';
import { compileTicketRegex, DEFAULT_TICKET_REGEX } from '../derive/tickets.ts';
import { parseJsonLine, readJsonlFrom } from '../io/jsonl-tail.ts';
import { FIXTURES_DIR } from '../test-utils/fixtures.ts';
import type { TimelineEvent } from '../types/events.ts';
import {
  type ClaudeAggState,
  claudeStateToSession,
  createClaudeAggState,
  ingestClaudeRecord,
  type ResolveDeriveConfig,
} from './session-aggregate.ts';

const resolve: ResolveDeriveConfig = () => ({
  ticketRegex: compileTicketRegex(DEFAULT_TICKET_REGEX),
  prodPatterns: compileProdPatterns(DEFAULT_PROD_PATTERNS),
});
const dir = join(FIXTURES_DIR, 'claude-home/projects/-Users-test-Wakecap');

async function values(file: string): Promise<unknown[]> {
  const r = await readJsonlFrom(join(dir, file), 0);
  return r.lines.map((l) => parseJsonLine(l.text));
}

async function ingest(
  file: string,
  sessionId: string,
): Promise<{ state: ClaudeAggState; events: TimelineEvent[] }> {
  const state = createClaudeAggState(sessionId);
  const events: TimelineEvent[] = [];
  for (const v of await values(file)) events.push(...ingestClaudeRecord(state, v, resolve));
  return { state, events };
}

const opts = {
  projectId: 'wakecap',
  transcriptPath: '/t.jsonl',
  availability: 'resumable' as const,
  hasSubagents: false,
};

describe('Claude aggregate: s-basic', () => {
  it('maps records to timeline events with seq and turn', async () => {
    const { events } = await ingest('s-basic.jsonl', 's-basic');
    expect(events.map((e) => e.kind)).toEqual([
      'prompt',
      'assistant_text',
      'tool_call',
      'tool_result',
      'tool_call',
      'assistant_text',
      'system',
      'prompt',
      'prompt',
      'system',
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(events.map((e) => e.turn)).toEqual([1, 1, 1, 1, 1, 1, 1, 2, 3, 3]);
    const [prompt, text, bash, result, edit, edited, duration] = events;
    expect(prompt).toMatchObject({
      uuid: 'u1',
      parentUuid: null,
      text: 'check the notification service tests',
      agentId: null,
    });
    expect(text).toMatchObject({
      uuid: 'a1',
      messageId: 'msg_1',
      model: 'claude-opus-5',
      text: 'Running the tests.',
    });
    expect(text?.usage).toEqual({ input: 10, output: 20, cacheRead: 1000, cacheWrite: 100, costUsd: null });
    expect(bash).toMatchObject({
      uuid: 'a1#1',
      tool: 'Bash',
      toolUseId: 'tu1',
      usage: null,
      mcpServer: null,
    });
    expect(bash?.input).toEqual({ command: 'pnpm vitest run', description: 'Run tests' });
    expect(result).toMatchObject({ kind: 'tool_result', toolUseId: 'tu1' });
    expect(result?.text).toContain('18 passed');
    expect(edit?.usage).toEqual({ input: 5, output: 7, cacheRead: 1100, cacheWrite: 0, costUsd: null });
    expect(edited?.usage).toBeNull();
    expect(duration).toMatchObject({ kind: 'system', tool: 'turn_duration', durationMs: 36000, text: null });
    expect(events[9]).toMatchObject({
      kind: 'system',
      tool: 'away_summary',
      text: 'Ran tests (18 passed) and edited a.ts.',
    });
  });

  it('builds the session', async () => {
    const { state } = await ingest('s-basic.jsonl', 's-basic');
    const s = claudeStateToSession(state, opts);
    expect(s).toMatchObject({
      id: 's-basic',
      source: 'claude',
      projectId: 'wakecap',
      startCwd: '/Users/test/Wakecap',
      cwds: ['/Users/test/Wakecap'],
      name: 'Notification service test check',
      firstPrompt: 'check the notification service tests',
      lastPrompt: '/review the change',
      awaySummary: 'Ran tests (18 passed) and edited a.ts.',
      startedAt: '2026-09-01T09:00:00.000Z',
      lastActivityAt: '2026-09-01T09:07:00.000Z',
      models: ['claude-opus-5'],
      permissionMode: 'bypassPermissions',
      usage: { input: 15, output: 27, cacheRead: 2100, cacheWrite: 100, costUsd: 0.42 },
      linesAdded: 1,
      linesRemoved: 1,
      skills: ['review'],
      filesTouched: ['/Users/test/Wakecap/Backend/svc/a.ts'],
      promptCount: 3,
      toolCallCount: 2,
      apiErrorCount: 0,
      flags: { touchedProd: false, hasSubagents: false, automated: false },
      availability: 'resumable',
      transcriptPath: '/t.jsonl',
      recap: null,
      live: null,
    });
    expect(s?.lastTest).toEqual({
      ts: '2026-09-01T09:00:30.000Z',
      command: 'pnpm vitest run',
      passed: 18,
      failed: 0,
      skipped: 0,
      durationMs: 1400,
    });
  });

  it('dedupes usage without cost-state and survives a JSON round trip mid-file', async () => {
    const all = (await values('s-basic.jsonl')).filter(
      (v) => !(typeof v === 'object' && v !== null && (v as { type?: string }).type === 'cost-state'),
    );
    const oneShot = createClaudeAggState('s-basic');
    for (const v of all) ingestClaudeRecord(oneShot, v, resolve);

    let split = createClaudeAggState('s-basic');
    for (const v of all.slice(0, 5)) ingestClaudeRecord(split, v, resolve);
    split = JSON.parse(JSON.stringify(split)) as ClaudeAggState;
    for (const v of all.slice(5)) ingestClaudeRecord(split, v, resolve);

    expect(split).toEqual(oneShot);
    expect(claudeStateToSession(split, opts)?.usage).toEqual({
      input: 15,
      output: 27,
      cacheRead: 2100,
      cacheWrite: 100,
      costUsd: null,
    });
  });
});

describe('Claude aggregate: other fixtures', () => {
  it('s-prlink: agent-name, PR, tickets, skills and MCP', async () => {
    const { state } = await ingest('s-prlink.jsonl', 's-prlink');
    const s = claudeStateToSession(state, opts);
    expect(s).toMatchObject({
      name: 'SAF-1787 SLA weekends',
      tickets: ['SAF-1787'],
      skills: ['conductor'],
      mcpServers: ['claude_ai_Linear'],
      toolCallCount: 3,
      prs: [
        {
          repo: 'example-org/wakecap-wecare-service',
          number: 231,
          url: 'https://github.com/example-org/wakecap-wecare-service/pull/231',
        },
      ],
      cwds: ['/Users/test/Wakecap', '/Users/test/Wakecap/Backend/wakecap-wecare-service'],
    });
  });

  it('s-drift: keeps the first cwd, records drift, flags prod', async () => {
    const { state } = await ingest('s-drift.jsonl', 's-drift');
    const s = claudeStateToSession(state, opts);
    expect(s?.startCwd).toBe('/Users/test/Wakecap');
    expect(s?.cwds).toEqual([
      '/Users/test/Wakecap',
      '/Users/test/Wakecap/Backend/svc',
      '/Users/test/Wakecap/Frontend/app',
    ]);
    expect(s?.models).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(s?.skills).toEqual(['production_server_db']);
    expect(s?.flags.touchedProd).toBe(true);
    expect(s?.name).toBe('look at the svc repo');
  });

  it('s-errors: synthetic model excluded, API error counted, truncated line ignored', async () => {
    const { state, events } = await ingest('s-errors.jsonl', 's-errors');
    expect(events.map((e) => e.kind)).toEqual(['prompt', 'error']);
    expect(events[1]?.text).toBe('API Error: 529 overloaded');
    const s = claudeStateToSession(state, opts);
    expect(s?.models).toEqual([]);
    expect(s?.apiErrorCount).toBe(1);
    expect(s?.usage.costUsd).toBeNull();
  });

  // NOTE on the two tests below: phase 0 added a `<command-name>` record (uuid 'k-cmd') and an
  // `isCompactSummary` record (uuid 'k-compact') to s-unknown.jsonl, just before its final
  // non-JSON line. classifyClaudeRecord (phase 0) now classifies these as `command` and
  // `compact_summary` rather than `unknown` or `human_prompt`. Per controller ruling, they must
  // NOT increment promptCount, become firstPrompt/lastPrompt, or seed the session name, but they
  // DO belong in the timeline as `system` events tagged with `tool: 'command'` /
  // `tool: 'compact_summary'`. This diverges from the brief's original expectation of
  // `events.map(kind) === ['prompt']`.
  it('s-unknown: counts unknown and invalid records without events, but emits command/compact_summary as system events', async () => {
    const { state, events } = await ingest('s-unknown.jsonl', 's-unknown');
    expect(events.map((e) => e.kind)).toEqual(['prompt', 'system', 'system']);
    expect(state.unknownTypes).toEqual({ 'future-record-kind': 1, '(invalid)': 1 });
    expect(state.promptCount).toBe(1);
    expect(state.firstPrompt).toBe('hello');
    expect(state.lastHumanPrompt).toBe('hello');
  });

  it('s-unknown: a <command-name> record emits a system/command event, not a prompt', async () => {
    const { events } = await ingest('s-unknown.jsonl', 's-unknown');
    const e = events[1];
    expect(e).toMatchObject({ kind: 'system', tool: 'command', turn: 1 });
    expect(e?.text).toContain('<command-name>/clear</command-name>');
  });

  it('s-unknown: an isCompactSummary record emits a system/compact_summary event, not a prompt', async () => {
    const { events } = await ingest('s-unknown.jsonl', 's-unknown');
    const e = events[2];
    expect(e).toMatchObject({ kind: 'system', tool: 'compact_summary', turn: 1 });
    expect(e?.text).toContain('Conversation compacted');
  });

  it('returns null until a timestamped record is seen', () => {
    const state = createClaudeAggState('x');
    ingestClaudeRecord(state, { type: 'ai-title', aiTitle: 'T', sessionId: 'x' }, resolve);
    expect(claudeStateToSession(state, opts)).toBeNull();
  });
});
