import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURES_DIR } from '../test-utils/fixtures.ts';
import { parseJsonLine, readJsonlFrom } from './jsonl-tail.ts';

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

describe('readJsonlFrom', () => {
  it('reads complete lines and reports a partial trailing line', async () => {
    const r = await readJsonlFrom(
      join(FIXTURES_DIR, 'claude-home/projects/-Users-test-Wakecap/s-errors.jsonl'),
      0,
    );
    expect(r.lines).toHaveLength(2);
    expect(r.partial).toBe(true);
    expect(r.nextOffset).toBeLessThan(
      Buffer.byteLength(
        (await import('node:fs')).readFileSync(
          join(FIXTURES_DIR, 'claude-home/projects/-Users-test-Wakecap/s-errors.jsonl'),
        ),
      ),
    );
  });

  it('resumes from an offset and only returns new lines', async () => {
    const dir = tmpDir('orc-tail-');
    const f = join(dir, 'a.jsonl');
    writeFileSync(f, '{"n":1}\n{"n":2}\n');
    const first = await readJsonlFrom(f, 0);
    expect(first.lines.map((l) => l.text)).toEqual(['{"n":1}', '{"n":2}']);
    appendFileSync(f, '{"n":3}\n{"n":');
    const second = await readJsonlFrom(f, first.nextOffset);
    expect(second.lines.map((l) => l.text)).toEqual(['{"n":3}']);
    expect(second.partial).toBe(true);
    appendFileSync(f, '4}\n');
    const third = await readJsonlFrom(f, second.nextOffset);
    expect(third.lines.map((l) => l.text)).toEqual(['{"n":4}']);
    expect(third.partial).toBe(false);
  });

  it('handles multi-byte characters across chunk boundaries', async () => {
    const dir = tmpDir('orc-tail-');
    const f = join(dir, 'u.jsonl');
    const line = JSON.stringify({ t: 'مرحبا'.repeat(50) });
    writeFileSync(f, `${line}\n${line}\n`);
    const r = await readJsonlFrom(f, 0, 64);
    expect(r.lines.map((l) => l.text)).toEqual([line, line]);
  });

  it('recovers from truncation/replacement instead of silently returning nothing forever', async () => {
    const dir = tmpDir('orc-tail-');
    const f = join(dir, 'trunc.jsonl');
    writeFileSync(f, '{"n":1}\n{"n":2}\n{"n":3}\n');
    const first = await readJsonlFrom(f, 0);
    expect(first.lines).toHaveLength(3);
    expect(first.truncated).toBe(false);
    // Claude Code rewrites the transcript on compaction / replaces it on `/clear`: the new
    // file is shorter than the stored offset.
    writeFileSync(f, '{"n":9}\n');
    const second = await readJsonlFrom(f, first.nextOffset);
    expect(second.truncated).toBe(true);
    expect(second.nextOffset).toBe(0);
  });

  it('rejects a negative offset with a clear error instead of the raw fs error', async () => {
    const dir = tmpDir('orc-tail-');
    const f = join(dir, 'neg.jsonl');
    writeFileSync(f, '{"n":1}\n');
    await expect(readJsonlFrom(f, -1)).rejects.toThrow(RangeError);
    await expect(readJsonlFrom(f, -1)).rejects.toThrow('offset must be >= 0');
  });
});

describe('parseJsonLine', () => {
  it('returns undefined for non-JSON', () => {
    expect(parseJsonLine('this line is not json')).toBeUndefined();
    expect(parseJsonLine('{"a":1}')).toEqual({ a: 1 });
  });
});
