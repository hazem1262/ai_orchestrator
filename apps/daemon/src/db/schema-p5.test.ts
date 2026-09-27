import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb } from './client.ts';

// Temp dirs are tracked and removed after the file's tests, same as client.test.ts.
const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const P5_TABLES = [
  'scheduled_jobs',
  'usage_entries',
  'tool_uses',
  'ledger_cursors',
  'usage_blocks',
  'budgets',
  'streams',
  'stream_links',
  'recaps',
  'goals',
  'handoffs',
  'reminders',
  'digests',
];

describe('phase 5 schema', () => {
  it('creates every phase 5 table through migrations', () => {
    const { raw, close } = openDb(join(tmpDir('orc-p5db-'), 'index.db'));
    const names = (
      raw.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of P5_TABLES) expect(names).toContain(t);
    close();
  });

  it('enforces one goal per target and unique recap cache keys', () => {
    const { raw, close } = openDb(join(tmpDir('orc-p5db-'), 'index.db'));
    const g = raw.prepare(
      "insert into goals (id, target_type, target_id, objective, state, blocked_reason, source, updated_at) values (?, 'session', 'claude:x', 'o', 'active', null, 'manual', 't')",
    );
    g.run('g1');
    expect(() => g.run('g2')).toThrow(/UNIQUE/);
    const r = raw.prepare(
      "insert into recaps (id, kind, target_key, transcript_offset, model, engine, text, cost_usd, input_tokens_approx, created_at) values (?, 'session', 'claude:x', 10, 'm', 'claude-cli', 't', 0, 0, 't')",
    );
    r.run('r1');
    expect(() => r.run('r2')).toThrow(/UNIQUE/);
    close();
  });
});
