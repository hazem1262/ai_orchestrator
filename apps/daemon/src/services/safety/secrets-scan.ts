import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { OrcConfig, SecretsFileReport, SecretsReport } from '@orc/api-contract';
import { scanTextForSecrets } from '@orc/core';

const FORBIDDEN: ReadonlyArray<RegExp> = [/\.key$/i, /[\\/]\.codex[\\/]auth\.json$/, /[\\/]\.claude\.json$/];

export function isForbiddenPath(p: string): boolean {
  return FORBIDDEN.some((re) => re.test(p));
}

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

const globToRegex = (glob: string) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')}$`,
  );

/** Supports `~` and wildcards in the last path segment only (e.g. `~/Wakecap/.claude/commands/*.md`). */
export async function expandScanPaths(patterns: readonly string[], home: string): Promise<string[]> {
  const out = new Set<string>();
  for (const raw of patterns) {
    const p = resolve(expandHome(raw, home));
    const name = basename(p);
    if (!name.includes('*') && !name.includes('?')) {
      out.add(p);
      continue;
    }
    const dir = dirname(p);
    const re = globToRegex(name);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const n of [...names].sort()) if (re.test(n)) out.add(join(dir, n));
  }
  return [...out];
}

export interface SecretsScanner {
  scan(): Promise<SecretsReport>;
}

/**
 * Read-only secrets hygiene scan: `stat`, `realpath`, `readdir` and `readFile(…, { flag: 'r' })`
 * only. Refuses `*.key`, `~/.codex/auth.json` and `~/.claude.json`, skips files over `maxBytes`
 * (1 MB default), and reports `{ line, kind }` per finding — never the matched value.
 */
export function createSecretsScanner(deps: {
  config: () => OrcConfig;
  home?: string;
  maxBytes?: number;
  now?: () => Date;
}): SecretsScanner {
  return {
    async scan() {
      const home = deps.home ?? homedir();
      const maxBytes = deps.maxBytes ?? 1024 * 1024;
      const paths = await expandScanPaths(deps.config().safety.secretScanPaths, home);
      const files: SecretsFileReport[] = [];
      for (const path of paths) {
        const displayPath = path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
        const base = { path, displayPath };
        if (isForbiddenPath(path)) {
          files.push({ ...base, exists: false, findings: [], error: 'forbidden' });
          continue;
        }
        const st = await stat(path).catch(() => null);
        if (!st) {
          files.push({ ...base, exists: false, findings: [], error: null });
          continue;
        }
        const real = await realpath(path).catch(() => path);
        if (isForbiddenPath(real)) {
          files.push({ ...base, exists: true, findings: [], error: 'forbidden' });
          continue;
        }
        if (!st.isFile()) {
          files.push({ ...base, exists: true, findings: [], error: 'not_a_file' });
          continue;
        }
        if (st.size > maxBytes) {
          files.push({ ...base, exists: true, findings: [], error: 'too_large' });
          continue;
        }
        try {
          const text = await readFile(path, { encoding: 'utf8', flag: 'r' });
          files.push({ ...base, exists: true, findings: scanTextForSecrets(text), error: null });
        } catch (err) {
          files.push({
            ...base,
            exists: true,
            findings: [],
            error: (err as NodeJS.ErrnoException).code ?? 'read_failed',
          });
        }
      }
      return {
        scannedAt: (deps.now?.() ?? new Date()).toISOString(),
        totalFindings: files.reduce((n, f) => n + f.findings.length, 0),
        files,
      };
    },
  };
}
