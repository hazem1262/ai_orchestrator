import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './diff-parse.ts';
import { hunkPatch } from './hunk-select.ts';

const PATCH = [
  'diff --git a/a.ts b/a.ts',
  'index 1111111..2222222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,2 +1,2 @@',
  '-one',
  '+ONE',
  ' two',
  '@@ -8,2 +8,2 @@',
  ' eight',
  '-nine',
  '+NINE',
  '',
].join('\n');

describe('hunkPatch', () => {
  const file = parseUnifiedDiff(PATCH)[0];
  if (!file) throw new Error('fixture did not parse');

  it('keeps the header and only the chosen hunk', () => {
    expect(hunkPatch(file, 1)).toBe(
      [
        'diff --git a/a.ts b/a.ts',
        'index 1111111..2222222 100644',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -8,2 +8,2 @@',
        ' eight',
        '-nine',
        '+NINE',
        '',
      ].join('\n'),
    );
  });

  it('throws for a missing hunk', () => {
    expect(() => hunkPatch(file, 5)).toThrow(/hunk_not_found/);
  });
});
