import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseJsonLine, readJsonlFrom } from '@orc/core';
import Database from 'better-sqlite3';

const home = join(homedir(), '.codex');
function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.jsonl') ? [p] : [];
  });
}
const files = walk(join(home, 'sessions'));
const originators = new Map<string, number>();
const payloadTypes = new Map<string, number>();
for (const f of files.slice(-300)) {
  const r = await readJsonlFrom(f, 0);
  for (const l of r.lines) {
    const v = parseJsonLine(l.text) as
      | { type?: string; payload?: { type?: string; originator?: string } }
      | undefined;
    if (!v) continue;
    const k = `${v.type}:${v.payload?.type ?? ''}`;
    payloadTypes.set(k, (payloadTypes.get(k) ?? 0) + 1);
    if (v.type === 'session_meta')
      originators.set(
        String(v.payload?.originator),
        (originators.get(String(v.payload?.originator)) ?? 0) + 1,
      );
  }
}
console.log({
  files: files.length,
  originators: Object.fromEntries(originators),
  payloadTypes: Object.fromEntries(payloadTypes),
});

const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  .split('\n')
  .filter((l) => /\bcodex\b/.test(l) && !l.includes('probe.ts'));
console.log('codex processes:', ps);
for (const line of ps) {
  const pid = line.trim().split(/\s+/)[0];
  if (!pid) continue;
  try {
    const cwd = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    console.log(
      pid,
      cwd.split('\n').find((x) => x.startsWith('n')),
    );
  } catch {
    /* process gone */
  }
}

for (const dbName of ['state_5.sqlite', 'thread_history_1.sqlite']) {
  const db = new Database(join(home, dbName), { readonly: true, fileMustExist: true });
  const tables = db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[];
  console.log(
    dbName,
    tables.map((t) => t.name),
  );
  for (const t of tables) {
    const cols = db.prepare(`pragma table_info(${JSON.stringify(t.name)})`).all() as { name: string }[];
    console.log('  ', t.name, cols.map((c) => c.name).join(','));
  }
  db.close();
}
