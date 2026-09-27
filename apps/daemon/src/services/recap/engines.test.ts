import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claudePrintArgs,
  createAnthropicApiEngine,
  createClaudeCliEngine,
  parseClaudePrintJson,
  RecapEngineError,
} from './engines.ts';

// Safety: these tests must never run the real `claude` binary or reach the Anthropic API.
// - The claude-cli engine only ever gets FAKE, an absolute path to test/bin/fake-claude-print.
// - The anthropic-api engine always gets an injected clientFactory, or has no key at all.
// - ANTHROPIC_API_KEY is removed from the process and from every child env.
const FAKE = fileURLToPath(new URL('../../../test/bin/fake-claude-print', import.meta.url));
const PRICES = { 'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } };

let savedKey: string | undefined;
beforeAll(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  expect(isAbsolute(FAKE)).toBe(true);
});
afterAll(() => {
  if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
});

const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => {
  const { ANTHROPIC_API_KEY: _drop, ...rest } = process.env;
  return { ...rest, ...extra };
};

const neverCalled = (): never => {
  throw new Error('the real Anthropic client must never be built in tests');
};

describe('parseClaudePrintJson', () => {
  it('reads result, cost and error flag from the last JSON line', () => {
    expect(parseClaudePrintJson('noise\n{"result":"ok","total_cost_usd":0.5,"is_error":false}\n')).toEqual({
      result: 'ok',
      costUsd: 0.5,
      isError: false,
    });
    expect(() => parseClaudePrintJson('nope')).toThrow(RecapEngineError);
    expect(() => parseClaudePrintJson('{"result":1}')).toThrow(/bad_output|unexpected/);
  });
});

describe('claude-cli engine', () => {
  it('passes the headless flags and the prompt on stdin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-eng-'));
    const log = join(dir, 'call');
    const engine = createClaudeCliEngine({
      command: FAKE,
      cwd: dir,
      env: childEnv({ FAKE_CLAUDE_LOG: log }),
    });
    const out = await engine.run('PROMPT-TEXT', { model: 'claude-haiku-4-5', maxBudgetUsd: 1.234 });
    expect(out).toEqual({
      text: 'Fixed the notification tests.\n**Goal:** fix tests',
      costUsd: 0.0123,
      model: 'claude-haiku-4-5',
      engine: 'claude-cli',
    });
    expect(readFileSync(`${log}.args`, 'utf8').split('\n').slice(0, -1)).toEqual(
      claudePrintArgs('claude-haiku-4-5', 1.234),
    );
    expect(claudePrintArgs('m', 1.234)).toEqual([
      '-p',
      '--model',
      'm',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--tools',
      '',
      '--strict-mcp-config',
      '--settings',
      '{"disableAllHooks":true}',
      '--max-budget-usd',
      '1.23',
    ]);
    expect(readFileSync(`${log}.stdin`, 'utf8')).toBe('PROMPT-TEXT');
  });

  it('maps failures to error codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-eng-'));
    const run = (env: Record<string, string>, command = FAKE, timeoutMs?: number) =>
      createClaudeCliEngine({ command, cwd: dir, env: childEnv(env) }).run('p', {
        model: 'm',
        maxBudgetUsd: 1,
        timeoutMs,
      });
    await expect(run({ FAKE_CLAUDE_MODE: 'error' })).rejects.toMatchObject({ code: 'engine_failed' });
    await expect(run({ FAKE_CLAUDE_MODE: 'garbage' })).rejects.toMatchObject({ code: 'bad_output' });
    await expect(run({}, join(dir, 'missing-claude'))).rejects.toMatchObject({ code: 'engine_unavailable' });
    await expect(run({ FAKE_CLAUDE_MODE: 'slow' }, FAKE, 300)).rejects.toMatchObject({
      code: 'engine_failed',
    });
    const file = join(dir, 'out.json');
    writeFileSync(file, '{"result":"x","total_cost_usd":0.1,"is_error":true}');
    await expect(run({ FAKE_CLAUDE_OUTPUT_FILE: file })).rejects.toMatchObject({ code: 'engine_failed' });
  });
});

describe('anthropic-api engine', () => {
  const message = (p: Partial<Anthropic.Message>): Anthropic.Message =>
    ({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      content: [{ type: 'text', text: 'Recap line', citations: null }],
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      ...p,
    }) as unknown as Anthropic.Message;

  it('calls messages.create and prices the usage', async () => {
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const engine = createAnthropicApiEngine({
      getApiKey: async () => 'sk-test',
      prices: () => PRICES,
      clientFactory: (key) => {
        expect(key).toBe('sk-test');
        return {
          messages: {
            create: async (b) => {
              calls.push(b);
              return message({});
            },
          },
        };
      },
    });
    const out = await engine.run('PROMPT', { model: 'claude-haiku-4-5', maxBudgetUsd: 5 });
    expect(out).toEqual({
      text: 'Recap line',
      costUsd: (1000 * 1 + 200 * 5) / 1_000_000,
      model: 'claude-haiku-4-5',
      engine: 'anthropic-api',
    });
    expect(calls[0]).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: 'PROMPT' }],
    });
  });

  it('fails without a key, on refusal and on API errors', async () => {
    const noKey = createAnthropicApiEngine({
      getApiKey: async () => null,
      prices: () => PRICES,
      clientFactory: neverCalled,
    });
    await expect(noKey.run('p', { model: 'm', maxBudgetUsd: 1 })).rejects.toMatchObject({
      code: 'engine_unavailable',
    });
    const refusal = createAnthropicApiEngine({
      getApiKey: async () => 'k',
      prices: () => PRICES,
      clientFactory: () => ({ messages: { create: async () => message({ stop_reason: 'refusal' }) } }),
    });
    await expect(refusal.run('p', { model: 'm', maxBudgetUsd: 1 })).rejects.toMatchObject({
      code: 'engine_failed',
    });
    const boom = createAnthropicApiEngine({
      getApiKey: async () => 'k',
      prices: () => PRICES,
      clientFactory: () => ({ messages: { create: async () => Promise.reject(new Error('network down')) } }),
    });
    await expect(boom.run('p', { model: 'm', maxBudgetUsd: 1 })).rejects.toMatchObject({
      code: 'engine_failed',
    });
  });
});
