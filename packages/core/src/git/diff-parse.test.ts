import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './diff-parse.ts';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' export { a, b };',
  '@@ -10,2 +10,3 @@ function f() {',
  ' x();',
  '+y();',
  ' z();',
  'diff --git a/new file.ts b/new file.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/new file.ts',
  '@@ -0,0 +1 @@',
  '+export const n = 1;',
  'diff --git a/old.ts b/old.ts',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/old.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  'diff --git a/r1.ts b/r2.ts',
  'similarity index 100%',
  'rename from r1.ts',
  'rename to r2.ts',
  'diff --git a/img.png b/img.png',
  'index 5555555..6666666 100644',
  'Binary files a/img.png and b/img.png differ',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  const files = parseUnifiedDiff(PATCH);

  it('finds every file with its status', () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['src/a.ts', 'modified'],
      ['new file.ts', 'added'],
      ['old.ts', 'deleted'],
      ['r2.ts', 'renamed'],
      ['img.png', 'binary'],
    ]);
    expect(files[3]?.oldPath).toBe('r1.ts');
  });

  it('counts additions and deletions inside hunks only', () => {
    expect(files[0]).toMatchObject({ additions: 2, deletions: 1 });
    expect(files[1]).toMatchObject({ additions: 1, deletions: 0 });
    expect(files[2]).toMatchObject({ additions: 0, deletions: 1 });
  });

  it('parses hunk headers, including omitted counts', () => {
    expect(files[0]?.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 3, 1, 3],
      [10, 2, 10, 3],
    ]);
    expect(files[1]?.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 });
    expect(files[0]?.hunks[1]?.lines).toEqual([' x();', '+y();', ' z();']);
  });

  it('keeps each file patch self-contained', () => {
    expect(files[0]?.patch.startsWith('diff --git a/src/a.ts b/src/a.ts\n')).toBe(true);
    expect(files[0]?.patch.endsWith(' z();\n')).toBe(true);
    expect(files[0]?.patch.includes('new file.ts')).toBe(false);
  });

  it('returns [] for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});
