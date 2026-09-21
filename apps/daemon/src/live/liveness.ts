import { execFile } from 'node:child_process';
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

/**
 * Injectable seam over shelling out to a read-only table/lookup command (`ps`, `lsof`, ...).
 * Never rejects: a non-zero exit or a missing binary is reported as `exitCode !== 0` with
 * whatever `stdout` was captured, never as a thrown/rejected error, so a caller sweeping process
 * tables can treat a failed lookup as "nothing found" rather than an unhandled rejection.
 */
export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;

/** Real `ExecFn` over `node:child_process`. Used in production; tests inject a fake instead. */
export const defaultExec: ExecFn = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (!err) {
        resolve({ stdout, exitCode: 0 });
        return;
      }
      const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
      resolve({ stdout: stdout || '', exitCode: typeof code === 'number' ? code : 1 });
    });
  });

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
