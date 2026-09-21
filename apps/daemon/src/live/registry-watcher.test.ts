import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRegistryWatcher, type RegistryChange, type RegistryWatcher } from './registry-watcher.ts';

const FIXTURE = fileURLToPath(
  new URL('../../../../fixtures/claude-home/sessions/41001.json', import.meta.url),
);
let dir: string;
let w: RegistryWatcher | null = null;
const readText = vi.fn((p: string) => readFile(p, 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orc-reg-'));
  readText.mockClear();
});
afterEach(async () => {
  await w?.stop();
  w = null;
});

const entry = (status: string) =>
  JSON.stringify({ pid: 41002, procStart: 'x', sessionId: 's-two', cwd: '/Users/test/Wakecap', status });

describe('createRegistryWatcher (rescan)', () => {
  it('reads <pid>.json files, never *.key files, and reports changes', async () => {
    copyFileSync(FIXTURE, join(dir, '41001.json'));
    writeFileSync(join(dir, '41001.abcdef.key'), 'SECRET');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    w = createRegistryWatcher({ dir, watch: false, readText });
    const changes: RegistryChange[] = [];
    w.onChange((c) => changes.push(c));
    await w.rescan();
    expect(w.current().map((s) => s.entry.sessionId)).toEqual(['s-basic']);
    expect(changes).toHaveLength(1);
    expect(readText.mock.calls.map((c) => c[0])).toEqual([join(dir, '41001.json')]);

    await w.rescan();
    expect(changes).toHaveLength(1);

    writeFileSync(join(dir, '41002.json'), entry('busy'));
    await w.rescan();
    writeFileSync(join(dir, '41002.json'), entry('idle'));
    await w.rescan();
    expect(changes.filter((c) => c.kind === 'upsert')).toHaveLength(3);
    expect(w.current().find((s) => s.entry.pid === 41002)?.entry.status).toBe('idle');

    rmSync(join(dir, '41001.json'));
    await w.rescan();
    expect(changes.at(-1)).toEqual({ kind: 'remove', file: join(dir, '41001.json') });
    expect(readText.mock.calls.every((c) => !String(c[0]).endsWith('.key'))).toBe(true);
  });

  it('keeps the previous entry when a partial write is seen', async () => {
    writeFileSync(join(dir, '41002.json'), entry('busy'));
    w = createRegistryWatcher({ dir, watch: false });
    await w.rescan();
    writeFileSync(join(dir, '41002.json'), '{"pid":41002,"sessionId":"s-tw');
    await w.rescan();
    expect(w.current()[0]?.entry.status).toBe('busy');
  });

  it('logs a permanently unparseable file once, not on every rescan', async () => {
    // A session killed mid-write leaves a truncated <pid>.json that nobody will ever complete.
    // The 2 s reconciliation poll re-reads it forever, so deduping must survive a failed parse.
    writeFileSync(join(dir, '41002.json'), '{"pid":41002,"sessionId":"s-tw');
    const log = { debug: vi.fn() };
    w = createRegistryWatcher({ dir, watch: false, log });
    await w.rescan();
    for (let i = 0; i < 9; i++) await w.rescan();
    expect(log.debug).toHaveBeenCalledTimes(1);

    // Changed bytes that still don't parse are new information: worth exactly one more line.
    writeFileSync(join(dir, '41002.json'), '{"pid":41002,"sessionId":"s-two');
    await w.rescan();
    await w.rescan();
    expect(log.debug).toHaveBeenCalledTimes(2);

    // ...and the file completing is still delivered normally.
    writeFileSync(join(dir, '41002.json'), entry('busy'));
    await w.rescan();
    expect(w.current()[0]?.entry.status).toBe('busy');
  });

  it('re-emits a removed file recreated with identical bytes', async () => {
    // Guards the dedupe fix above: forgetting to clear the seen-bytes map on removal would make
    // a pid that restarts with an identical registry file invisible to the board.
    writeFileSync(join(dir, '41002.json'), entry('busy'));
    w = createRegistryWatcher({ dir, watch: false });
    const changes: RegistryChange[] = [];
    w.onChange((c) => changes.push(c));
    await w.rescan();
    rmSync(join(dir, '41002.json'));
    await w.rescan();
    writeFileSync(join(dir, '41002.json'), entry('busy'));
    await w.rescan();
    expect(changes.map((c) => c.kind)).toEqual(['upsert', 'remove', 'upsert']);
  });

  it('treats a missing directory as empty', async () => {
    w = createRegistryWatcher({ dir: join(dir, 'missing'), watch: false });
    await w.start();
    expect(w.current()).toEqual([]);
  });

  it('flags the first scan as initial and later upserts as live', async () => {
    writeFileSync(join(dir, '41002.json'), entry('busy'));
    w = createRegistryWatcher({ dir, watch: false });
    const changes: RegistryChange[] = [];
    w.onChange((c) => changes.push(c));
    await w.start(); // pre-existing file: statusUpdatedAt is the AGE of the change, not a detection delay
    expect(changes).toEqual([{ kind: 'upsert', snap: expect.anything(), initial: true }]);

    writeFileSync(join(dir, '41002.json'), entry('idle'));
    await w.rescan(); // genuine transition, seen after start()
    expect(changes.at(-1)).toMatchObject({ kind: 'upsert', initial: false });
  });
});

describe('createRegistryWatcher (fs events)', () => {
  it('notices a new registry file within 2 s', async () => {
    w = createRegistryWatcher({ dir, pollMs: 60_000 });
    await w.start();
    const seen = vi.fn();
    w.onChange(seen);
    writeFileSync(join(dir, '41002.json'), entry('busy'));
    await vi.waitFor(() => expect(seen).toHaveBeenCalled(), { timeout: 2000, interval: 50 });
  });

  it('measures detection latency for a busy -> waiting transition', async () => {
    // Synthetic measurement, not a real Claude session (S3's window never observed a real
    // `waiting` transition either): a plain fs write via chokidar exercises the exact same
    // detection path a real registry write would, so this fills the mechanism-level gap S3 left
    // even though it is not evidence about Claude's own write behavior for that status.
    writeFileSync(join(dir, '41002.json'), entry('busy'));
    w = createRegistryWatcher({ dir, pollMs: 60_000 });
    await w.start();
    const changes: RegistryChange[] = [];
    w.onChange((c) => changes.push(c));
    const t0 = performance.now();
    writeFileSync(join(dir, '41002.json'), entry('waiting'));
    await vi.waitFor(
      () => expect(changes.some((c) => c.kind === 'upsert' && c.snap.entry.status === 'waiting')).toBe(true),
      { timeout: 2000, interval: 10 },
    );
    const lagMs = performance.now() - t0;
    expect(lagMs).toBeLessThan(2000);
    console.log(`[registry-watcher] synthetic busy->waiting detection lag: ${lagMs.toFixed(1)}ms`);
  });
});
