import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildClassifierArgs,
  buildClassifierPrompt,
  ClassifierError,
  createClaudeClassifier,
  parseClassifierText,
} from '../../src/services/supervisor/classifier.ts';

const FAKE = fileURLToPath(new URL('../bin/fake-claude-json.mjs', import.meta.url));
beforeAll(() => chmodSync(FAKE, 0o755));

const input = {
  question: 'I updated the helper.\n\nShould I continue? token=abc123',
  context: 'session: SAF-1787 weekends · last prompt: keep going',
  intent: 'continue' as const,
  cannedAnswer: 'Yes, continue.',
  model: 'claude-haiku-4-5',
};

describe('buildClassifierPrompt', () => {
  it('redacts, states the candidate answer and demands JSON only', () => {
    const p = buildClassifierPrompt(input);
    expect(p).toContain('«redacted:secret»');
    expect(p).not.toContain('abc123');
    expect(p).toContain('Yes, continue.');
    expect(p).toContain('"decision"');
    expect(p).toMatch(/only.*JSON/i);
  });
});

describe('parseClassifierText', () => {
  it('accepts plain and fenced JSON', () => {
    expect(
      parseClassifierText('{"decision":"escalate","answer":null,"confidence":0.4,"reason":"ambiguous"}'),
    ).toEqual({
      decision: 'escalate',
      answer: null,
      confidence: 0.4,
      reason: 'ambiguous',
    });
    expect(
      parseClassifierText(
        '```json\n{"decision":"answer","answer":"Yes, continue.","confidence":0.9,"reason":"ok"}\n```',
      ).decision,
    ).toBe('answer');
  });

  it.each([
    'not json at all',
    '{"decision":"maybe","answer":null,"confidence":0.5,"reason":"x"}',
    '{"decision":"answer","answer":null,"confidence":2,"reason":"x"}',
    '{"decision":"answer","answer":null,"confidence":0.5}',
    '{"decision":"answer","answer":null,"confidence":0.5,"reason":"x","extra":true}',
  ])('rejects %s', (text) => {
    expect(() => parseClassifierText(text)).toThrow(ClassifierError);
  });
});

describe('buildClassifierArgs', () => {
  it('runs headless with no tools, no persistence and a hard budget', () => {
    const args = buildClassifierArgs({ model: 'claude-haiku-4-5', maxBudgetUsd: 0.05 });
    expect(args.join(' ')).toBe(
      '-p --output-format json --model claude-haiku-4-5 --tools  --no-session-persistence --safe-mode --max-budget-usd 0.05',
    );
    expect(args).not.toContain('--dangerously-skip-permissions');
  });
});

describe('createClaudeClassifier', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'orc-p7-cls-'));

  it('classifies and reports the cost', async () => {
    const argsFile = join(cwd, 'args.jsonl');
    const classify = createClaudeClassifier({ command: FAKE, cwd, env: { FAKE_ARGS_FILE: argsFile } });
    const r = await classify(input);
    expect(r.output).toEqual({
      decision: 'answer',
      answer: 'Yes, continue.',
      confidence: 0.93,
      reason: 'routine continue',
    });
    expect(r.costUsd).toBe(0.0021);
    expect(r.model).toBe('claude-haiku-4-5');
    const call = JSON.parse(readFileSync(argsFile, 'utf8').trim()) as { stdin: string; args: string[] };
    expect(call.stdin).toContain('Should I continue?');
    expect(call.args).toContain('--no-session-persistence');
  });

  it('throws ClassifierError on invalid JSON, on CLI failure and on timeout', async () => {
    const bad = createClaudeClassifier({
      command: FAKE,
      cwd,
      env: { FAKE_RESULT: 'I think you should continue!' },
    });
    await expect(bad(input)).rejects.toBeInstanceOf(ClassifierError);
    const failing = createClaudeClassifier({ command: FAKE, cwd, env: { FAKE_EXIT: '1' } });
    await expect(failing(input)).rejects.toThrow(/classifier/i);
    const hanging = createClaudeClassifier({
      command: FAKE,
      cwd,
      timeoutMs: 300,
      env: { FAKE_MODE: 'hang' },
    });
    await expect(hanging(input)).rejects.toBeInstanceOf(ClassifierError);
  });
});
