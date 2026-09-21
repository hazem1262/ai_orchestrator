import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRegistryFile, type RegistryEntry } from '@orc/core';

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Reads ~/.claude/sessions/<pid>.json. The `^\d+\.json$` filter guarantees `<pid>.<hash>.key` files are never opened. */
export function readClaudeRegistry(claudeHome: string): RegistryEntry[] {
  const dir = join(claudeHome, 'sessions');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: RegistryEntry[] = [];
  for (const name of names.sort()) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const entry = parseRegistryFile(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      if (entry) out.push(entry);
    } catch {
      // partial write: the next read will see the complete file
    }
  }
  return out;
}

/** Phase 2 adds the procStart check against pid reuse. */
export function findRegistryEntry(
  claudeHome: string,
  sessionId: string,
  alive: (pid: number) => boolean,
): (RegistryEntry & { alive: boolean }) | null {
  const matches = readClaudeRegistry(claudeHome)
    .filter((e) => e.sessionId === sessionId)
    .map((e) => ({ ...e, alive: alive(e.pid) }));
  return matches.find((m) => m.alive) ?? matches[0] ?? null;
}
