import type { DiffFileEntry } from '../types/index.ts';

export function hunkPatch(file: DiffFileEntry, hunkIndex: number): string {
  const hunk = file.hunks[hunkIndex];
  if (!hunk) throw new Error(`hunk_not_found: ${file.path}#${hunkIndex}`);
  const lines = file.patch.split('\n');
  const firstHunk = lines.findIndex((l) => l.startsWith('@@ '));
  const header = firstHunk === -1 ? lines : lines.slice(0, firstHunk);
  return `${[...header, hunk.header, ...hunk.lines].join('\n')}\n`;
}
