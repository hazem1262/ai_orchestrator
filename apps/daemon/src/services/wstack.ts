import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseJsonLine, parseWstackEnv, type StreamWorkflowInput } from '@orc/core';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function resolveWstackHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.WSTACK_HOME ?? join(homedir(), '.wstack');
}

function entries(dir: string): Dirent[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeFiles(dir: string, suffix: string): string[] {
  return entries(dir)
    .filter((d) => d.isFile() && d.name.endsWith(suffix) && !d.name.endsWith('.key'))
    .map((d) => join(dir, d.name));
}

/** Read-only: parses `<home>/workflows/*.env`. It never writes and never reads `.key` files. */
export function readWstackWorkflows(home: string): StreamWorkflowInput[] {
  return safeFiles(join(home, 'workflows'), '.env').flatMap((file) => {
    try {
      const st = statSync(file);
      if (st.size > MAX_FILE_BYTES) return [];
      return [{ file, env: parseWstackEnv(readFileSync(file, 'utf8')), mtime: st.mtime.toISOString() }];
    } catch {
      return [];
    }
  });
}

/** Read-only: the parsed lines of every `<home>/projects/<name>/timeline.jsonl` (Task 10). */
export function readWstackTimelines(home: string): unknown[] {
  const projects = join(home, 'projects');
  const out: unknown[] = [];
  for (const d of entries(projects)) {
    if (!d.isDirectory()) continue;
    const file = join(projects, d.name, 'timeline.jsonl');
    try {
      if (!existsSync(file) || statSync(file).size > MAX_FILE_BYTES) continue;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const v = parseJsonLine(line);
        if (v !== undefined) out.push(v);
      }
    } catch {
      // unreadable file: skip
    }
  }
  return out;
}
