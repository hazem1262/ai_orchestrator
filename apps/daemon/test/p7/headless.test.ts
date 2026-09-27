import { chmodSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildHeadlessArgs,
  formatStreamLine,
  type HeadlessRunOptions,
  parseStreamLine,
  runHeadless,
} from '../../src/services/automations/headless.ts';

const FAKE = fileURLToPath(new URL('../bin/fake-claude-stream.mjs', import.meta.url));
beforeAll(() => chmodSync(FAKE, 0o755));

const opts = (over: Partial<HeadlessRunOptions> = {}): HeadlessRunOptions => {
  const dir = mkdtempSync(join(tmpdir(), 'orc-p7-headless-'));
  return {
    command: FAKE,
    cwd: dir,
    prompt: 'PROMPT BODY',
    permissionMode: 'acceptEdits',
    sessionId: '22222222-2222-4222-8222-222222222222',
    timeoutMs: 10_000,
    logFile: join(dir, 'logs', 'run.jsonl'),
    env: { FAKE_ARGS_FILE: join(dir, 'args.jsonl') },
    ...over,
  };
};

describe('buildHeadlessArgs', () => {
  it('builds a print-mode stream-json command without a positional prompt', () => {
    const args = buildHeadlessArgs(opts({ model: 'claude-sonnet-5', maxBudgetUsd: 7.5 }));
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(args).toContain('Bash(gh pr merge *)');
    expect(args.join(' ')).toContain('--permission-prompts none');
    expect(args.join(' ')).toContain('--model claude-sonnet-5');
    expect(args.join(' ')).toContain('--max-budget-usd 7.50');
    expect(args.join(' ')).toContain('--session-id 22222222-2222-4222-8222-222222222222');
    expect(args).not.toContain('PROMPT BODY');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('resumes instead of setting a session id', () => {
    const args = buildHeadlessArgs(opts({ resumeSessionId: 'abc' }));
    expect(args.join(' ')).toContain('--resume abc');
    expect(args).not.toContain('--session-id');
  });
});

describe('parseStreamLine / formatStreamLine', () => {
  it('parses init, assistant text, tool use and result', () => {
    expect(parseStreamLine('{"type":"system","subtype":"init","session_id":"s1","model":"m"}')).toEqual({
      type: 'init',
      sessionId: 's1',
      model: 'm',
    });
    expect(
      parseStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}'),
    ).toEqual({ type: 'assistant_text', text: 'hi' });
    expect(
      parseStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]}}',
      ),
    ).toEqual({ type: 'tool_use', name: 'Bash' });
    expect(
      parseStreamLine(
        '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1","total_cost_usd":0.1,"duration_ms":5,"num_turns":1}',
      ),
    ).toEqual({
      type: 'result',
      subtype: 'success',
      isError: false,
      text: 'ok',
      sessionId: 's1',
      costUsd: 0.1,
      durationMs: 5,
      numTurns: 1,
    });
    expect(parseStreamLine('garbage')).toBeNull();
    expect(parseStreamLine('{"type":"user","message":{}}')).toBeNull();
  });

  it('formats lines for the run log with redaction', () => {
    expect(
      formatStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"token=abc123"}]}}'),
    ).toBe('token=«redacted:secret»');
    expect(
      formatStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{}}]}}',
      ),
    ).toBe('→ Edit');
    expect(
      formatStreamLine(
        '{"type":"result","subtype":"success","is_error":false,"result":"x","session_id":"s","total_cost_usd":0.5}',
      ),
    ).toBe('■ success · $0.50');
    expect(formatStreamLine('nope')).toBeNull();
  });
});

describe('runHeadless (fake claude)', () => {
  it('streams a successful run, sends the prompt on stdin and writes a private log', async () => {
    const o = opts();
    const r = await runHeadless(o);
    expect(r).toMatchObject({
      sessionId: '22222222-2222-4222-8222-222222222222',
      costUsd: 0.42,
      numTurns: 3,
      isError: false,
      subtype: 'success',
      timedOut: false,
      exitCode: 0,
    });
    expect(r.resultText).toContain('pull/12');
    expect(r.events).toBe(4);
    const call = JSON.parse(readFileSync(o.env?.FAKE_ARGS_FILE ?? '', 'utf8').trim()) as { stdin: string };
    expect(call.stdin).toBe('PROMPT BODY');
    expect(statSync(o.logFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(o.logFile, 'utf8')).toContain('"type":"result"');
  });

  it('reports claude errors', async () => {
    const r = await runHeadless(opts({ env: { FAKE_MODE: 'error' } }));
    expect(r).toMatchObject({ isError: true, costUsd: 0.02, exitCode: 1, subtype: 'error_during_execution' });
  });

  it('kills a run that exceeds the timeout', async () => {
    const r = await runHeadless(opts({ env: { FAKE_MODE: 'hang' }, timeoutMs: 400 }));
    expect(r.timedOut).toBe(true);
    expect(r.isError).toBe(true);
    expect(r.sessionId).toBe('22222222-2222-4222-8222-222222222222');
  });
});
