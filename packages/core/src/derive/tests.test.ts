import { describe, expect, it } from 'vitest';
import { isTestCommand, parseTestOutput } from './tests.ts';

const TS = '2026-09-01T09:00:30.000Z';

describe('isTestCommand', () => {
  it.each([
    ['pnpm vitest run', true],
    ['npx jest --ci', true],
    ['pnpm --filter api test', true],
    ['dotnet test Wakecap.sln', true],
    ['flutter test', true],
    ['python -m pytest -q', true],
    ['git status', false],
    ['ls tests', false],
  ])('%s → %s', (cmd, expected) => {
    expect(isTestCommand(cmd)).toBe(expected);
  });
});

describe('parseTestOutput', () => {
  it('parses vitest summaries (with ANSI colours)', () => {
    const out = ' Test Files  3 passed (3)\n      Tests  [32m18 passed[39m (18)\n   Duration  1.40s';
    expect(parseTestOutput('pnpm vitest run', out, TS)).toEqual({
      ts: TS,
      command: 'pnpm vitest run',
      passed: 18,
      failed: 0,
      skipped: 0,
      durationMs: 1400,
    });
    const red = '      Tests  2 failed | 15 passed | 1 skipped (18)\n   Duration  900ms';
    expect(parseTestOutput('vitest', red, TS)).toMatchObject({
      passed: 15,
      failed: 2,
      skipped: 1,
      durationMs: 900,
    });
  });

  it('parses jest summaries', () => {
    const out = 'Tests:       1 failed, 2 skipped, 17 passed, 20 total\nTime:        1.234 s';
    expect(parseTestOutput('npx jest', out, TS)).toMatchObject({
      passed: 17,
      failed: 1,
      skipped: 2,
      durationMs: 1234,
    });
  });

  it('sums dotnet test project lines', () => {
    const out = [
      'Passed!  - Failed:     0, Passed:    42, Skipped:     1, Total:    43, Duration: 2 s - A.Tests.dll (net8.0)',
      'Failed!  - Failed:     1, Passed:     5, Skipped:     0, Total:     6, Duration: 450 ms - B.Tests.dll (net8.0)',
    ].join('\n');
    expect(parseTestOutput('dotnet test', out, TS)).toMatchObject({
      passed: 47,
      failed: 1,
      skipped: 1,
      durationMs: 2450,
    });
  });

  it('parses the last flutter progress line', () => {
    const out = '00:02 +10: loading\n00:05 +42 ~1 -2: Some tests failed.';
    expect(parseTestOutput('flutter test', out, TS)).toMatchObject({
      passed: 42,
      skipped: 1,
      failed: 2,
      durationMs: 5000,
    });
  });

  it('parses pytest summaries', () => {
    const out = '....\n===== 3 failed, 40 passed, 2 skipped, 1 error in 1.23s =====';
    expect(parseTestOutput('pytest -q', out, TS)).toMatchObject({
      passed: 40,
      failed: 4,
      skipped: 2,
      durationMs: 1230,
    });
  });

  it('returns null when nothing looks like a summary', () => {
    expect(parseTestOutput('pnpm test', 'command not found', TS)).toBeNull();
  });
});
