import { describe, expect, it } from 'vitest';
import { humanizeLabel } from './labels.ts';

describe('humanizeLabel', () => {
  it('turns a snake_case category into a sentence-case label', () => {
    expect(humanizeLabel('fully_achieved')).toBe('Fully achieved');
    expect(humanizeLabel('buggy_code')).toBe('Buggy code');
    expect(humanizeLabel('ran_out_of_context')).toBe('Ran out of context');
  });

  it('leaves an already human name alone apart from the leading letter', () => {
    expect(humanizeLabel('Bash')).toBe('Bash');
    expect(humanizeLabel('linear')).toBe('Linear');
  });

  it('falls back to the original key when there is nothing to humanize', () => {
    expect(humanizeLabel('')).toBe('');
  });
});
