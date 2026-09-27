import { join } from 'node:path';
import type { SupervisorRule } from '@orc/api-contract';
import { checkDenied, DEFAULT_DENY_PATTERNS } from '@orc/core';
import { describe, expect, it } from 'vitest';
import {
  buildPendingQuestion,
  lastAssistantTextFromTranscript,
  lastParagraph,
} from '../../src/services/supervisor/question.ts';
import {
  applyRules,
  compileUserPattern,
  feedbackPattern,
  inQuietHours,
  SUPERVISOR_DENY_PATTERNS,
} from '../../src/services/supervisor/rules.ts';
// Setup adaptation: FIXTURES_DIR is not re-exported from the @orc/core index; the daemon test helper exports the same path.
import { FIXTURES_DIR } from '../homes.ts';

const deny = (text: string) => checkDenied(text, DEFAULT_DENY_PATTERNS);
const rule = (over: Partial<SupervisorRule>): SupervisorRule => ({
  id: 'r',
  projectId: null,
  kind: 'allow',
  pattern: 'x',
  intent: 'continue',
  answer: 'Yes, continue.',
  source: 'user',
  enabled: true,
  note: null,
  createdAt: '2026-09-18T09:00:00.000Z',
  ...over,
});
const q = (text: string, waitingFor: string | null = 'input needed') => {
  const built = buildPendingQuestion(text, waitingFor);
  if (!built) throw new Error('no question');
  return built;
};

describe('question extraction', () => {
  it('reads the last assistant text from a transcript tail', async () => {
    const path = join(FIXTURES_DIR, 'claude-home/projects/-Users-test-Wakecap/s-basic.jsonl');
    expect(await lastAssistantTextFromTranscript(path)).toBe('Edited.');
    expect(await lastAssistantTextFromTranscript(path, { maxBytes: 64 })).toBe('Edited.');
    expect(await lastAssistantTextFromTranscript('/nope/missing.jsonl')).toBeNull();
  });

  it('builds a question from the tail plus waitingFor', () => {
    const built = buildPendingQuestion('I refactored the helper.\n\nShould I continue?', 'input needed');
    expect(built).toEqual({
      text: 'I refactored the helper.\n\nShould I continue?\n[waiting for: input needed]',
      tail: 'Should I continue?',
      waitingFor: 'input needed',
    });
    expect(buildPendingQuestion(null, null)).toBeNull();
    expect(buildPendingQuestion('   ', null)).toBeNull();
    expect(buildPendingQuestion(null, 'input needed')?.tail).toBe('[waiting for: input needed]');
    expect(lastParagraph('a\n\nb\n\n  ')).toBe('b');
  });
});

describe('applyRules', () => {
  it.each([
    ['Should I continue?', 'continue', 'Yes, continue.'],
    ['continue?', 'continue', 'Yes, continue.'],
    ['Do you want me to run the tests?', 'run_tests', 'Yes, run the tests.'],
    ['Shall I proceed with the approved plan?', 'proceed_plan', 'Yes, proceed with the approved plan.'],
  ])('matches the built-in intent in %s', (text, intent, answer) => {
    expect(applyRules(q(text), { rules: [], deny })).toEqual({
      intent,
      answer,
      matchedBy: 'builtin',
      denied: false,
      denyReason: null,
    });
  });

  it('retries only transient errors', () => {
    expect(applyRules(q('API Error: 529 overloaded. Retry?'), { rules: [], deny }).intent).toBe(
      'retry_transient',
    );
    expect(applyRules(q('The migration failed. Retry?'), { rules: [], deny }).intent).toBeNull();
  });

  it('only looks at the last paragraph for allow matches', () => {
    const text = 'Earlier I asked: should I continue?\n\nWhich database should I point the migration at?';
    expect(applyRules(q(text), { rules: [], deny }).intent).toBeNull();
  });

  it.each([
    'Should I deploy this to production?',
    'Shall I run git push --force to main?',
    'Continue? I will drop table sessions first.',
    'Should I merge the PR now?',
    'Should I continue with the prod database credentials?',
  ])('escalates dangerous questions: %s', (text) => {
    const v = applyRules(q(text), { rules: [], deny });
    expect(v.denied).toBe(true);
    expect(v.intent).toBeNull();
    expect(v.denyReason).toBeTruthy();
  });

  it('honours user allow rules and user/feedback deny rules', () => {
    const allow = rule({ pattern: 'ship it\\?$', intent: 'continue', answer: 'Yes, ship it.' });
    expect(applyRules(q('Ready. Ship it?'), { rules: [allow], deny })).toMatchObject({
      intent: 'continue',
      answer: 'Yes, ship it.',
      matchedBy: 'user',
    });
    const denyRule = rule({
      kind: 'deny',
      pattern: 'ship it',
      intent: null,
      answer: null,
      source: 'feedback',
    });
    expect(applyRules(q('Ready. Ship it?'), { rules: [allow, denyRule], deny }).denied).toBe(true);
    expect(
      applyRules(q('Should I continue?'), {
        rules: [rule({ kind: 'deny', pattern: 'continue', source: 'feedback' })],
        deny,
      }).denied,
    ).toBe(true);
  });

  it('ignores invalid user patterns instead of throwing', () => {
    expect(compileUserPattern('([')).toBeNull();
    expect(
      applyRules(q('Should I continue?'), { rules: [rule({ kind: 'deny', pattern: '([' })], deny }).denied,
    ).toBe(false);
  });

  it('keeps its own deny list in sync with the shared one', () => {
    expect(SUPERVISOR_DENY_PATTERNS.length).toBeGreaterThan(5);
    expect(checkDenied('please merge the pr', SUPERVISOR_DENY_PATTERNS).denied).toBe(true);
  });
});

describe('feedbackPattern and quiet hours', () => {
  it('escapes the question into a literal pattern', () => {
    const p = feedbackPattern('Should I continue (really)?');
    expect(new RegExp(p, 'i').test('should i continue (really)?')).toBe(true);
    expect(new RegExp(p, 'i').test('should i stop')).toBe(false);
  });

  it('handles quiet hours that wrap past midnight', () => {
    const at = (h: number, m = 0) => new Date(2026, 8, 18, h, m, 0);
    expect(inQuietHours(at(23), { start: '22:00', end: '08:00' })).toBe(true);
    expect(inQuietHours(at(3), { start: '22:00', end: '08:00' })).toBe(true);
    expect(inQuietHours(at(9), { start: '22:00', end: '08:00' })).toBe(false);
    expect(inQuietHours(at(13), { start: '12:00', end: '14:00' })).toBe(true);
    expect(inQuietHours(at(15), { start: '12:00', end: '14:00' })).toBe(false);
    expect(inQuietHours(at(3), null)).toBe(false);
  });
});
