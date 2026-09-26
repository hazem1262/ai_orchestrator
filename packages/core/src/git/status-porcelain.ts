export interface StatusEntry {
  path: string;
  origPath: string | null;
  x: string;
  y: string;
  untracked: boolean;
}

/** Parses `git status --porcelain=v1 -z` output. */
export function parseStatusPorcelainZ(out: string): StatusEntry[] {
  const parts = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part.length < 4) continue;
    const x = part[0] ?? ' ';
    const y = part[1] ?? ' ';
    const path = part.slice(3);
    let origPath: string | null = null;
    if (x === 'R' || x === 'C') {
      origPath = parts[i + 1] ?? null;
      i++;
    }
    entries.push({ path, origPath, x, y, untracked: x === '?' && y === '?' });
  }
  return entries;
}
