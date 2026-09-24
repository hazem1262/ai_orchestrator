import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJsonlPage } from './raw.ts';

function file(content: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'orc-raw-')), 'x.jsonl');
  writeFileSync(p, content);
  return p;
}

const line = 'a'.repeat(20);

describe('readJsonlPage', () => {
  it('reads lines longer than the window by growing it', async () => {
    const p = file(`${line}\n${line}\n${line}\n`);
    const page = await readJsonlPage(p, 0, 10, { windowBytes: 8 });
    expect(page.items.map((i) => i.offset)).toEqual([0, 21, 42]);
    expect(page.nextOffset).toBeNull();
  });

  it('pages with nextOffset', async () => {
    const p = file(`${line}\n${line}\n${line}\n`);
    const first = await readJsonlPage(p, 0, 2);
    expect(first.items).toHaveLength(2);
    expect(first.nextOffset).toBe(42);
    const second = await readJsonlPage(p, 42, 2);
    expect(second.items.map((i) => i.offset)).toEqual([42]);
    expect(second.nextOffset).toBeNull();
  });

  it('returns a trailing partial line flagged as partial', async () => {
    const p = file('{"a":1}\n{"b":');
    const page = await readJsonlPage(p, 0, 10);
    expect(page.items).toEqual([
      { offset: 0, text: '{"a":1}', truncated: false, partial: false },
      { offset: 8, text: '{"b":', truncated: false, partial: true },
    ]);
    expect(page.nextOffset).toBeNull();
  });

  it('truncates long lines and redacts', async () => {
    const p = file(`${line}\nPGPASSWORD=hunter2 psql\n`);
    const page = await readJsonlPage(p, 0, 10, { maxLineChars: 5 });
    expect(page.items[0]).toMatchObject({ text: 'aaaaa', truncated: true });
    const full = await readJsonlPage(p, 0, 10);
    expect(full.items[1]?.text).toBe('PGPASSWORD=«redacted:secret» psql');
  });

  it('returns nothing past the end', async () => {
    const p = file(`${line}\n`);
    expect(await readJsonlPage(p, 999, 10)).toEqual({ path: p, items: [], nextOffset: null });
  });
});
