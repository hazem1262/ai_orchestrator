import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES_DIR } from '../test-utils/fixtures.ts';
import { parseJsonLine, readJsonlFrom } from './jsonl-tail.ts';

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
    const dir = mkdtempSync(join(tmpdir(), 'orc-tail-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'orc-tail-'));
    const f = join(dir, 'u.jsonl');
    const line = JSON.stringify({ t: 'مرحبا'.repeat(50) });
    writeFileSync(f, `${line}\n${line}\n`);
    const r = await readJsonlFrom(f, 0, 64);
    expect(r.lines.map((l) => l.text)).toEqual([line, line]);
  });
});

describe('parseJsonLine', () => {
  it('returns undefined for non-JSON', () => {
    expect(parseJsonLine('this line is not json')).toBeUndefined();
    expect(parseJsonLine('{"a":1}')).toEqual({ a: 1 });
  });
});
