import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isRegistryFileName, parseRegistryEntry, type RegistryEntry } from '@orc/core';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';

export interface RegistrySnapshot {
  file: string;
  entry: RegistryEntry;
}

/**
 * `initial` distinguishes an upsert produced by the watcher's own first scan (this process just
 * started and is discovering sessions that were already running) from a genuine live transition
 * seen afterwards. Per spike S3 (contracts §14), `statusUpdatedAt` on a pre-existing entry is the
 * *age* of its last status change, not a detection delay — a consumer that treated every upsert
 * as "just happened" would misreport an hours-old session as a fresh transition. Downstream code
 * (Tasks 6-8) should use `initial: true` upserts only to seed state, never to fire a
 * `session.statusChanged` notification or measure latency against.
 */
export type RegistryChange =
  | { kind: 'upsert'; snap: RegistrySnapshot; initial: boolean }
  | { kind: 'remove'; file: string };

export interface RegistryWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  rescan(): Promise<void>;
  current(): RegistrySnapshot[];
  onChange(fn: (c: RegistryChange) => void): () => void;
}

/**
 * Watches `$CLAUDE_HOME/sessions/` (chokidar, `depth: 0`) for registry files (`^\d+\.json$`
 * only, via `isRegistryFileName` — `*.key` lock files are never opened, matching spike S3 and
 * `parseRegistryEntry`'s own contract) and turns adds/changes/removals into `RegistryChange`
 * events.
 *
 * Reconciliation backstop: like the Phase 1 indexer (`indexer.ts`'s `reconcileSweep`), chokidar's
 * native backend can silently drop an event under load, so this watcher never relies on push
 * notifications alone. `start()` runs an initial `rescan()`, then a `setInterval(rescan, pollMs)`
 * (default 2000ms) keeps re-listing the directory independently of whatever chokidar reports —
 * `rescan()`'s own diffing (byte-for-byte raw comparison in `readOne`, presence-set comparison
 * for removals) makes a redundant sweep cheap and side-effect-free when nothing changed, so the
 * poll is a correctness guarantee, not a performance cost.
 *
 * Partial writes and `ENOENT` are normal (S3: 1 of 6 real transitions hit `ENOENT` because the
 * file was mid-replace) — a failed read or a JSON parse failure is never an error, just "skip and
 * wait for the next scan"; the previous snapshot (if any) is left in place.
 */
export function createRegistryWatcher(opts: {
  dir: string;
  pollMs?: number;
  watch?: boolean;
  readText?: (path: string) => Promise<string>;
  log?: { debug(o: object, msg?: string): void };
}): RegistryWatcher {
  const readText = opts.readText ?? ((p: string) => readFile(p, 'utf8'));
  const snaps = new Map<string, { snap: RegistrySnapshot; raw: string }>();
  const listeners = new Set<(c: RegistryChange) => void>();
  let fsw: FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  let scannedOnce = false;

  const emit = (c: RegistryChange) => {
    for (const fn of listeners) fn(c);
  };

  async function readOne(file: string, initial: boolean): Promise<void> {
    if (!isRegistryFileName(basename(file))) return; // never touches *.key
    let raw: string;
    try {
      raw = await readText(file);
    } catch {
      return; // vanished between listing and reading (ENOENT); the next scan reports the removal
    }
    if (snaps.get(file)?.raw === raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      opts.log?.debug({ file }, 'registry file not parseable yet (partial write)');
      return;
    }
    const entry = parseRegistryEntry(parsed);
    if (!entry) return;
    const snap = { file, entry };
    snaps.set(file, { snap, raw });
    emit({ kind: 'upsert', snap, initial });
  }

  function removeOne(file: string): void {
    if (snaps.delete(file)) emit({ kind: 'remove', file });
  }

  async function rescan(): Promise<void> {
    const initial = !scannedOnce;
    let names: string[] = [];
    try {
      names = await readdir(opts.dir);
    } catch {
      names = []; // missing directory: treat as an empty registry
    }
    const files = names.filter(isRegistryFileName).map((n) => join(opts.dir, n));
    const present = new Set(files);
    for (const f of files) await readOne(f, initial);
    for (const f of [...snaps.keys()]) if (!present.has(f)) removeOne(f);
    scannedOnce = true;
  }

  return {
    async start() {
      await rescan();
      if (opts.watch !== false) {
        const w = chokidarWatch(opts.dir, {
          ignoreInitial: true,
          depth: 0,
          ignored: (p: string, stats?: { isFile(): boolean }) =>
            stats?.isFile() === true && !isRegistryFileName(basename(p)),
        });
        w.on('add', (p: string) => void readOne(p, false));
        w.on('change', (p: string) => void readOne(p, false));
        w.on('unlink', (p: string) => removeOne(p));
        w.on('error', (err: unknown) => opts.log?.debug({ err: String(err) }, 'registry watcher error'));
        // Written files must never race chokidar's own initial directory scan: with
        // `ignoreInitial: true`, a write that lands before `ready` can be folded into that scan
        // and silently swallowed rather than reported as an `add`.
        await new Promise<void>((resolve) => {
          w.once('ready', () => resolve());
        });
        fsw = w;
      }
      timer = setInterval(() => void rescan(), opts.pollMs ?? 2000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await fsw?.close();
      fsw = null;
    },
    rescan,
    current: () => [...snaps.values()].map((v) => v.snap),
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
