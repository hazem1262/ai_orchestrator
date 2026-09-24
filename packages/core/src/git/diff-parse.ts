import type { DiffFileEntry, DiffHunk } from '../types/index.ts';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, '');
}

function parseSection(lines: string[]): DiffFileEntry {
  const header = lines[0] ?? '';
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
  let oldPath: string | null = m?.[1] ?? null;
  let path = m?.[2] ?? '';
  let status: DiffFileEntry['status'] = 'modified';
  let renamed = false;
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let current: DiffHunk | null = null;

  for (const line of lines.slice(1)) {
    if (current) {
      const hm = HUNK_RE.exec(line);
      if (hm) {
        current = pushHunk(hunks, line, hm);
        continue;
      }
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
      current.lines.push(line);
      continue;
    }
    const hm = HUNK_RE.exec(line);
    if (hm) {
      current = pushHunk(hunks, line, hm);
    } else if (line.startsWith('new file mode')) status = 'added';
    else if (line.startsWith('deleted file mode')) status = 'deleted';
    else if (line.startsWith('rename from ')) {
      oldPath = line.slice('rename from '.length);
      renamed = true;
    } else if (line.startsWith('rename to ')) path = line.slice('rename to '.length);
    else if (line.startsWith('Binary files ')) status = 'binary';
    else if (line.startsWith('+++ ') && line !== '+++ /dev/null') path = stripPrefix(line.slice(4));
    else if (line.startsWith('--- ') && line !== '--- /dev/null') oldPath = stripPrefix(line.slice(4));
  }
  if (renamed && status === 'modified') status = 'renamed';
  const body = lines.join('\n');
  return {
    path,
    oldPath: status === 'renamed' ? oldPath : null,
    status,
    additions,
    deletions,
    patch: `${body}\n`,
    hunks,
  };
}

function pushHunk(hunks: DiffHunk[], line: string, hm: RegExpExecArray): DiffHunk {
  const h: DiffHunk = {
    header: line,
    oldStart: Number(hm[1]),
    oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
    newStart: Number(hm[3]),
    newLines: hm[4] === undefined ? 1 : Number(hm[4]),
    lines: [],
  };
  hunks.push(h);
  return h;
}

export function parseUnifiedDiff(patch: string): DiffFileEntry[] {
  if (patch.trim() === '') return [];
  const all = patch.replace(/\r\n/g, '\n').split('\n');
  if (all[all.length - 1] === '') all.pop();
  const sections: string[][] = [];
  for (const line of all) {
    if (line.startsWith('diff --git ')) sections.push([line]);
    else sections[sections.length - 1]?.push(line);
  }
  return sections.map(parseSection);
}
