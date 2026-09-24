import { describe, expect, it } from 'vitest';
import { buildReviewPrompt } from './review-prompt.ts';

describe('buildReviewPrompt', () => {
  it('orders comments by file and line and indents multi-line bodies', () => {
    const text = buildReviewPrompt(
      [
        { file: 'src/b.ts', line: 4, side: 'new', body: 'rename this' },
        { file: 'src/a.ts', line: 20, side: 'old', body: 'why was this removed?\nit is used by the job' },
        { file: 'src/a.ts', line: 3, side: 'new', body: 'add a test' },
      ],
      { branch: 'feat/SAF-1-x' },
    );
    expect(text).toBe(
      [
        'Review feedback on your changes (branch feat/SAF-1-x). Address every comment below, keep the changes minimal, run the relevant tests, then reply with a short summary per comment.',
        '',
        '1. src/a.ts:3',
        '   add a test',
        '2. src/a.ts:20 (removed line)',
        '   why was this removed?',
        '   it is used by the job',
        '3. src/b.ts:4',
        '   rename this',
      ].join('\n'),
    );
  });

  it('works without a branch', () => {
    expect(
      buildReviewPrompt([{ file: 'a', line: 1, side: 'new', body: 'x' }]).startsWith(
        'Review feedback on your changes. ',
      ),
    ).toBe(true);
  });
});
