import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJsonLine } from '../io/jsonl-tail.ts';
import { FIXTURES_DIR } from '../test-utils/fixtures.ts';
import { classifyClaudeRecord, contentText } from './records.ts';

const load = (name: string) =>
  readFileSync(join(FIXTURES_DIR, 'claude-home/projects/-Users-test-Wakecap', name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(parseJsonLine);

describe('classifyClaudeRecord', () => {
  it('classifies the basic session', () => {
    const kinds = load('s-basic.jsonl').map((v) => classifyClaudeRecord(v).kind);
    expect(kinds).toEqual([
      'session_meta',
      'human_prompt',
      'assistant',
      'tool_result',
      'assistant',
      'assistant',
      'system',
      'human_prompt',
      'meta',
      'human_prompt',
      'session_meta',
      'session_meta',
      'system',
      'session_meta',
    ]);
  });

  it('extracts human prompt text', () => {
    const c = classifyClaudeRecord(load('s-basic.jsonl')[1]);
    expect(c.kind === 'human_prompt' && c.text).toBe('check the notification service tests');
  });

  it('marks known noise as ignored and new types as unknown', () => {
    const out = load('s-unknown.jsonl').map((v) => classifyClaudeRecord(v));
    expect(out.map((c) => c.kind)).toEqual([
      'human_prompt',
      'unknown',
      'ignored',
      'ignored',
      'ignored',
      'session_meta',
      'session_meta',
      'unknown',
    ]);
    expect(out[1]).toEqual({ kind: 'unknown', type: 'future-record-kind' });
    expect(out[7]).toEqual({ kind: 'unknown', type: null });
  });

  it('exposes session meta type', () => {
    const c = classifyClaudeRecord(load('s-prlink.jsonl')[2]);
    expect(c.kind === 'session_meta' && c.type).toBe('pr-link');
  });
});

describe('contentText', () => {
  it('joins text blocks and passes strings through', () => {
    expect(contentText('hi')).toBe('hi');
    expect(
      contentText([{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }]),
    ).toBe('a\nb');
    expect(contentText(undefined)).toBe('');
  });
});
