import { checkDenied } from '@orc/core';
import { describe, expect, it } from 'vitest';

// Probe for the P3 contract assumption: patterns are case-insensitive regex sources.
describe('checkDenied semantics', () => {
  it('treats patterns as case-insensitive regular expressions', () => {
    expect(checkDenied('Please GH PR MERGE 12', [String.raw`\bgh\s+pr\s+merge\b`]).denied).toBe(true);
    expect(checkDenied('open a draft pr', [String.raw`\bgh\s+pr\s+merge\b`]).denied).toBe(false);
  });
});
