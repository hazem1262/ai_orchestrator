import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb } from './client.ts';
import { sessionPk, splitPk } from './keys.ts';

// Every temp dir this file makes is tracked and removed when the file's tests finish. Without
// this the suite leaked ~100 directories per `pnpm test` run; 10,870 of them once filled the
// disk and produced dozens of failures that looked like flaky tests.
const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('openDb', () => {
  it('migrates, sets pragmas and chmods the file', () => {
    const file = join(tmpDir('orc-db-'), 'index.db');
    const { raw, close } = openDb(file);
    const tables = (
      raw.prepare("select name from sqlite_master where type in ('table') order by name").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    for (const t of [
      'agents',
      'events',
      'events_fts',
      'file_offsets',
      'history_prompts',
      'labels',
      'pins',
      'projects',
      'pty_sessions',
      'saved_views',
      'sessions',
    ]) {
      expect(tables).toContain(t);
    }
    expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(raw.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    close();
    // re-open is idempotent
    openDb(file).close();
  });

  it('indexes prompt text in FTS but not tool results', () => {
    const file = join(tmpDir('orc-db-'), 'index.db');
    const { raw, close } = openDb(file);
    const ins = raw.prepare(
      "insert into events (session_pk, agent_id, seq, uuid, ts, kind, turn, text, search_input) values ('claude:s', '', ?, ?, 't', ?, 1, ?, ?)",
    );
    ins.run(1, 'u1', 'prompt', 'fix the weekend deadline', null);
    ins.run(2, 'u2', 'tool_result', 'weekend output', null);
    ins.run(3, 'u3', 'tool_call', null, 'pnpm vitest run');
    const hits = (q: string) =>
      (
        raw.prepare('select rowid from events_fts where events_fts match ? order by rowid').all(q) as {
          rowid: number;
        }[]
      ).length;
    expect(hits('weekend')).toBe(1);
    expect(hits('vitest')).toBe(1);
    raw.prepare("delete from events where uuid = 'u1'").run();
    expect(hits('weekend')).toBe(0);
    raw.prepare("update events set search_input = 'pnpm jest' where uuid = 'u3'").run();
    expect(hits('vitest')).toBe(0);
    expect(hits('jest')).toBe(1);
    close();
  });
});

describe('keys', () => {
  it('builds and splits session pks', () => {
    expect(sessionPk('claude', 'a:b')).toBe('claude:a:b');
    expect(splitPk('codex:c0dex')).toEqual({ source: 'codex', id: 'c0dex' });
    expect(() => splitPk('nope')).toThrow();
  });
});
