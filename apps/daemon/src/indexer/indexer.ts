import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  type ClaudeAggState,
  type CodexAggState,
  claudeStateToAgentNode,
  claudeStateToSession,
  codexStateToSession,
  createClaudeAggState,
  createCodexAggState,
  type DeriveConfig,
  type HistoryPrompt,
  historyPromptsToSession,
  ingestClaudeRecord,
  ingestCodexRecord,
  parseHistoryLine,
  parseJsonLine,
  parseSubagentMeta,
  readJsonlFrom,
  type SubagentMeta,
  type TailResult,
  type TimelineEvent,
} from '@orc/core';
import type Database from 'better-sqlite3';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import type { Logger } from 'pino';
import type { OrcPaths } from '../config.ts';
import type { OrcDb } from '../db/client.ts';
import { sessionPk } from '../db/keys.ts';
import { upsertAgent } from '../db/repos/agents.ts';
import { deleteEventsFor, insertEvents } from '../db/repos/events.ts';
import {
  deleteFileOffset,
  type FileOffsetRow,
  getFileOffset,
  putFileOffset,
} from '../db/repos/file-offsets.ts';
import { historyPromptsFor, insertHistoryPrompts } from '../db/repos/history.ts';
import {
  countSessions,
  getSessionOrigin,
  markHasSubagents,
  setSessionAvailability,
  upsertSession,
} from '../db/repos/sessions.ts';
import type { EventBus } from '../live/event-bus.ts';
import type { ProjectServiceImpl } from '../services/projects.ts';
import { type ClassifiedFile, classifyPath, type IndexedFileKind, listIndexableFiles } from './file-kinds.ts';

export interface Indexer {
  scanAll(): Promise<{ files: number; sessions: number; ms: number }>;
  indexFile(path: string): Promise<void>;
  watch(): Promise<void>;
  close(): Promise<void>;
  unknownTypes(): Record<string, number>;
  /**
   * Runs one reconciliation pass immediately — the same backstop sweep `watch()` schedules on
   * `reconcileMs` — callable directly so tests and observability code (Task 19) don't have to
   * wait on the timer or start the chokidar watcher just to see the counts. Returns how many
   * indexable paths were actually re-checked (`swept`) versus skipped because they are
   * already-known-automated Codex rollouts (`skipped`) — see
   * `loadKnownAutomatedCodexRolloutPaths`'s doc comment for exactly what "already known" means.
   */
  reconcile(): Promise<{ swept: number; skipped: number }>;
}

export interface IndexerDeps {
  db: OrcDb;
  raw: Database.Database;
  paths: OrcPaths;
  projects: ProjectServiceImpl;
  bus: EventBus;
  log: Logger;
  debounceMs?: number;
  /**
   * How often, while `watch()` is active, to fall back to a light re-listing of every indexable
   * path as a backstop against a native filesystem-watch event that never arrives (see the
   * `watch()` doc comment). Defaults to 15000ms — the guarantee this advertises is "never stale
   * for more than ~15s even if the OS drops an event", well inside anything a human notices, at a
   * duty cycle measured against a real `~/.claude`/`~/.codex` home (see task-10-report.md's
   * "Flake fix" section). Tests override it to a small value to keep assertions fast without
   * depending on chokidar's push events actually firing.
   */
  reconcileMs?: number;
}

interface FileStat {
  size: number;
  mtimeMs: number;
  headFingerprint: string;
}

const HEAD_FINGERPRINT_BYTES = 4096;

function readMeta(jsonlPath: string): SubagentMeta {
  try {
    return parseSubagentMeta(JSON.parse(readFileSync(jsonlPath.replace(/\.jsonl$/, '.meta.json'), 'utf8')));
  } catch {
    return parseSubagentMeta(null);
  }
}

/**
 * Cheap content fingerprint for the (size, mtime) fast-path's blind spot: a file replaced with
 * different content of the *exact same byte length* (mtime moves, size doesn't, `readJsonlFrom`
 * never reports `truncated` because the stored offset never exceeds the new size). Hashes only
 * the first `HEAD_FINGERPRINT_BYTES` bytes — never a whole multi-MB transcript — combined with
 * the total size so a short file can't collide with a longer file sharing the same head.
 */
export async function readHeadFingerprint(path: string, size: number): Promise<string> {
  const len = Math.min(HEAD_FINGERPRINT_BYTES, size);
  const buf = Buffer.alloc(len);
  if (len > 0) {
    const fh = await open(path, 'r');
    try {
      await fh.read(buf, 0, len, 0);
    } finally {
      await fh.close();
    }
  }
  return `${size}:${createHash('sha1').update(buf).digest('hex')}`;
}

/**
 * Startup scan plus live chokidar watch that keeps the SQLite index in step with `~/.claude` and
 * `~/.codex`. Every file is tracked by byte offset in `file_offsets`, so re-scans and watch
 * events only ever read what was appended since the last time this path was indexed — except
 * when `readJsonlFrom` reports `truncated: true` (the stored offset is past the file's current
 * size), which means Claude Code rewrote or replaced the file (compaction, `/clear`). That case
 * resets the offset to 0 and re-indexes the file from scratch instead of silently going quiet.
 */
export function createIndexer(deps: IndexerDeps): Indexer {
  const { db, raw, paths, projects, bus, log } = deps;
  const unknownByFile = new Map<string, Record<string, number>>();
  const timers = new Map<string, NodeJS.Timeout>();
  let detectTimer: NodeJS.Timeout | null = null;
  let reconcileTimer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  let queue: Promise<void> = Promise.resolve();
  const resolveCfg = (cwd: string | null): DeriveConfig => projects.deriveConfigFor(cwd);
  // One bulk lookup per sweep for the reconcile-sweep narrowing below, not a per-file query.
  // Measured iteration (see task-10-report.md's "Flake fix"): a per-file `getSessionByPk` check
  // (fetches + JSON.parses the whole session row) regressed the sweep from ~342ms to ~705ms on a
  // real ~/.codex; a per-file lean single-column statement only marginally improved on that
  // (~326ms), because ~6,700 individual prepared-statement round-trips is itself the dominant
  // cost, not what each one reads. A single JOIN, turned into an in-memory `Set` the sweep loop
  // checks with O(1) lookups, pays that cost exactly once per sweep instead of once per file.
  const knownAutomatedCodexRolloutsStmt = raw.prepare<[], { path: string }>(
    `SELECT fo.path AS path
       FROM file_offsets fo
       JOIN sessions s ON s.pk = fo.session_pk
      WHERE fo.kind = 'codex-rollout' AND s.automated = 1`,
  );

  // Every scan/index/watch task is funneled through this single promise chain, so two file
  // events (or a scan overlapping a watch event) can never race each other into the same
  // session's transaction. Generic so a task (like reconcileSweep) can hand its result back to
  // its own caller while the internal `queue` chain itself always settles to void — a failure in
  // one task is logged and never stalls the tasks queued after it.
  function enqueue<T = void>(fn: () => Promise<T> | T): Promise<T> {
    const run = queue.then(fn);
    queue = run.then(
      () => undefined,
      (err: unknown) => {
        log.error({ err }, 'indexing task failed');
      },
    );
    return run;
  }

  function offsetRow(
    path: string,
    kind: IndexedFileKind,
    st: FileStat,
    tail: TailResult,
    pk: string | null,
    agentId: string | null,
    stateJson: string | null,
  ): FileOffsetRow {
    return {
      path,
      kind,
      sessionPk: pk,
      agentId,
      size: st.size,
      mtimeMs: st.mtimeMs,
      offset: tail.nextOffset,
      stateJson,
      headFingerprint: st.headFingerprint,
      updatedAt: new Date().toISOString(),
    };
  }

  function applyClaude(
    path: string,
    cls: ClassifiedFile,
    st: FileStat,
    tail: TailResult,
    prevState: string | null,
    reset: boolean,
  ): void {
    const sessionId = cls.sessionId;
    if (!sessionId) return;
    const pk = sessionPk('claude', sessionId);
    const state = prevState
      ? (JSON.parse(prevState) as ClaudeAggState)
      : createClaudeAggState(sessionId, cls.agentId);
    const eventsOut: TimelineEvent[] = [];
    for (const line of tail.lines)
      eventsOut.push(...ingestClaudeRecord(state, parseJsonLine(line.text), resolveCfg));
    unknownByFile.set(path, state.unknownTypes);
    raw.transaction(() => {
      if (reset) deleteEventsFor(db, pk, cls.agentId);
      insertEvents(db, pk, eventsOut);
      if (cls.kind === 'claude-main') {
        const session = claudeStateToSession(state, {
          projectId: projects.resolve(state.startCwd ?? ''),
          transcriptPath: path,
          availability: 'resumable',
          hasSubagents: existsSync(join(dirname(path), sessionId, 'subagents')),
        });
        if (session) upsertSession(db, session, 'transcript');
      } else if (cls.agentId) {
        const node = claudeStateToAgentNode(state, readMeta(path), {
          sessionId,
          agentId: cls.agentId,
          transcriptPath: path,
        });
        upsertAgent(db, pk, node);
        markHasSubagents(db, pk);
      }
      putFileOffset(db, offsetRow(path, cls.kind, st, tail, pk, cls.agentId, JSON.stringify(state)));
    })();
    bus.emit({ type: 'session.indexed', pk });
  }

  function applyCodex(
    path: string,
    st: FileStat,
    tail: TailResult,
    prevState: string | null,
    reset: boolean,
  ): void {
    const state = prevState ? (JSON.parse(prevState) as CodexAggState) : createCodexAggState();
    const eventsOut: TimelineEvent[] = [];
    for (const line of tail.lines)
      eventsOut.push(...ingestCodexRecord(state, parseJsonLine(line.text), resolveCfg));
    unknownByFile.set(path, state.unknownTypes);
    const pk = state.sessionId ? sessionPk('codex', state.sessionId) : null;
    raw.transaction(() => {
      if (pk) {
        if (reset) deleteEventsFor(db, pk, null);
        insertEvents(db, pk, eventsOut);
        const session = codexStateToSession(state, {
          projectId: projects.resolve(state.startCwd ?? ''),
          transcriptPath: path,
          availability: 'resumable',
        });
        if (session) upsertSession(db, session, 'transcript');
      }
      putFileOffset(db, offsetRow(path, 'codex-rollout', st, tail, pk, null, JSON.stringify(state)));
    })();
    if (pk) bus.emit({ type: 'session.indexed', pk });
  }

  function applyHistory(path: string, st: FileStat, tail: TailResult): void {
    const prompts = tail.lines
      .map((l) => parseHistoryLine(parseJsonLine(l.text)))
      .filter((p): p is HistoryPrompt => p !== null);
    const touched: string[] = [];
    raw.transaction(() => {
      insertHistoryPrompts(db, prompts);
      for (const sid of new Set(prompts.map((p) => p.sessionId))) {
        const pk = sessionPk('claude', sid);
        // History must never clobber a real transcript session: it only fills in sessions the
        // indexer has no transcript for at all.
        if (getSessionOrigin(db, pk) === 'transcript') continue;
        const all = historyPromptsFor(db, sid);
        const cwd = all[0]?.project ?? null;
        const session = historyPromptsToSession(all, {
          projectId: cwd ? projects.resolve(cwd) : null,
          ticketRegex: resolveCfg(cwd).ticketRegex,
        });
        if (session) {
          upsertSession(db, session, 'history');
          touched.push(pk);
        }
      }
      putFileOffset(db, offsetRow(path, 'claude-history', st, tail, null, null, null));
    })();
    for (const pk of touched) bus.emit({ type: 'session.indexed', pk });
  }

  function refreshAgentMeta(cls: ClassifiedFile, metaPath: string): void {
    const jsonlPath = metaPath.replace(/\.meta\.json$/, '.jsonl');
    const row = getFileOffset(db, jsonlPath);
    if (!row?.stateJson || !cls.sessionId || !cls.agentId) return;
    const state = JSON.parse(row.stateJson) as ClaudeAggState;
    const pk = sessionPk('claude', cls.sessionId);
    upsertAgent(
      db,
      pk,
      claudeStateToAgentNode(state, readMeta(jsonlPath), {
        sessionId: cls.sessionId,
        agentId: cls.agentId,
        transcriptPath: jsonlPath,
      }),
    );
    bus.emit({ type: 'session.indexed', pk });
  }

  function onMissing(path: string, cls: ClassifiedFile): void {
    const prev = getFileOffset(db, path);
    if (!prev) return;
    raw.transaction(() => {
      if ((cls.kind === 'claude-main' || cls.kind === 'codex-rollout') && prev.sessionPk) {
        setSessionAvailability(db, prev.sessionPk, 'prompts-only', null);
      }
      deleteFileOffset(db, path);
    })();
    if (prev.sessionPk) bus.emit({ type: 'session.indexed', pk: prev.sessionPk });
  }

  async function indexNow(path: string): Promise<void> {
    const cls = classifyPath(path, paths);
    if (!cls) return;
    if (cls.kind === 'claude-subagent-meta') {
      refreshAgentMeta(cls, path);
      return;
    }
    let basic: { size: number; mtimeMs: number };
    try {
      const s = await stat(path);
      basic = { size: s.size, mtimeMs: Math.floor(s.mtimeMs) };
    } catch {
      // ENOENT and friends are normal here: the watcher fires on delete, and a scan can race a
      // file being removed mid-pass. Skip and wait for the next event rather than erroring.
      onMissing(path, cls);
      return;
    }
    const prev = getFileOffset(db, path);
    // The common, cheap case: neither size nor mtime moved since we last indexed this path.
    if (prev && prev.size === basic.size && prev.mtimeMs === basic.mtimeMs) return;

    // Past this point the file actually changed (by size or mtime), so the extra small head read
    // below is never on the hot "nothing changed" path.
    const headFingerprint = await readHeadFingerprint(path, basic.size);
    const st: FileStat = { ...basic, headFingerprint };

    // Second, independent trigger for "reset and re-index from scratch", alongside
    // `readJsonlFrom`'s own `truncated` flag: a file replaced with *different* content of the
    // *exact same byte length* moves mtime but not size, so the stored offset never exceeds the
    // new size and `truncated` never fires. A row written before this fingerprint existed has
    // `headFingerprint: null`; that's treated as "unknown" and falls through to the pre-existing
    // (size, offset) logic below rather than forcing an unnecessary re-index.
    const contentChangedAtSameSize =
      prev !== null &&
      prev.size === st.size &&
      prev.headFingerprint !== null &&
      prev.headFingerprint !== st.headFingerprint;

    const start = prev && st.size >= prev.offset && !contentChangedAtSameSize ? prev.offset : 0;
    const reset = start === 0;
    const prevState = reset ? null : (prev?.stateJson ?? null);
    // readJsonlFrom itself detects a stored offset past the file's current size (truncation from
    // compaction or /clear) and reports `truncated: true` with `nextOffset: 0`; `start === 0`
    // here also covers a brand-new file and the same-size-different-content case above. Either
    // way `reset` drops the old events for this path and starts a fresh aggregate state so the
    // session reflects only the current file content.
    const tail = await readJsonlFrom(path, start);
    switch (cls.kind) {
      case 'claude-history':
        applyHistory(path, st, tail);
        break;
      case 'claude-main':
      case 'claude-subagent':
        applyClaude(path, cls, st, tail, prevState, reset || tail.truncated);
        break;
      case 'codex-rollout':
        applyCodex(path, st, tail, prevState, reset || tail.truncated);
        break;
    }
  }

  function scheduleDetect(): void {
    if (detectTimer) clearTimeout(detectTimer);
    detectTimer = setTimeout(() => {
      detectTimer = null;
      enqueue(() => {
        projects.ensureDetected();
      }).catch(() => undefined);
    }, 2000);
  }

  /**
   * "Already known automated" Codex rollout paths, for the reconcile-sweep narrowing below: a
   * path is only in this set when `file_offsets` already has a `codex-rollout` row for it (it
   * was indexed at least once before — a path the index has never seen is never "known", so a
   * brand-new automated session can't go invisible until the next full scan) AND that row's
   * session is already flagged `automated` in the `sessions` table. Decided entirely from what
   * the index already persisted via one query — never by re-opening or re-parsing any file,
   * which would defeat the point of skipping it.
   */
  function loadKnownAutomatedCodexRolloutPaths(): Set<string> {
    return new Set(knownAutomatedCodexRolloutsStmt.all().map((r) => r.path));
  }

  /**
   * Backstop for chokidar's push notifications: a light re-listing of every indexable path, run
   * on `indexNow`'s existing (size, mtime) fast-skip so an already-current file costs one cheap
   * stat(). Native filesystem watch backends are not fully reliable under contention — an event
   * for a real change can be delayed well past any reasonable timeout or simply never arrive, for
   * both brand-new and already-watched directories (see the "Flake fix" section of
   * task-10-report.md for the reproduction). `watch()` runs this on `reconcileMs` so a session is
   * never stale for longer than that, independent of whether the underlying OS ever tells us.
   *
   * Narrowing: on a real `~/.codex`, the large majority of rollout files are already-known
   * `codex_sdk_ts` ("automated") sessions, hidden from the UI by default — measured at 5,637 of
   * 6,773 total indexable files (83.2%) against the author's real home, dominating the sweep's
   * cost (see task-10-report.md's "Flake fix"). Those specific paths are skipped by THIS sweep
   * only — never by `scanAll()`, and never by the watcher's own chokidar-triggered `indexNow`
   * call when an event does arrive, so a real edit to one of them is still picked up normally the
   * moment the OS tells us about it. Missing a change to one of them between OS events, bounded
   * by the next full `scanAll()`, is an accepted trade since these sessions are hidden by
   * default anyway.
   */
  function reconcileSweep(): Promise<{ swept: number; skipped: number }> {
    return enqueue(async () => {
      const knownAutomated = loadKnownAutomatedCodexRolloutPaths();
      let swept = 0;
      let skipped = 0;
      for (const f of listIndexableFiles(paths)) {
        if (knownAutomated.has(f)) {
          skipped += 1;
          continue;
        }
        swept += 1;
        try {
          await indexNow(f);
        } catch (err) {
          // One bad path must not abort the rest of the sweep.
          log.warn({ err, path: f }, 'reconcile sweep failed for path');
        }
      }
      if (skipped > 0) {
        log.debug({ swept, skipped }, 'reconcile sweep skipped known-automated codex rollouts');
      }
      return { swept, skipped };
    }).catch((err: unknown) => {
      log.error({ err }, 'reconcile sweep failed');
      return { swept: 0, skipped: 0 };
    });
  }

  return {
    async scanAll() {
      const t0 = performance.now();
      const files = listIndexableFiles(paths);
      bus.emit({ type: 'index.progress', done: 0, total: files.length });
      let done = 0;
      for (const f of files) {
        await enqueue(() => indexNow(f)).catch(() => undefined);
        done += 1;
        if (done % 25 === 0 || done === files.length)
          bus.emit({ type: 'index.progress', done, total: files.length });
      }
      await enqueue(() => {
        projects.ensureDetected();
      });
      return { files: files.length, sessions: countSessions(db), ms: Math.round(performance.now() - t0) };
    },
    indexFile(path) {
      return enqueue(() => indexNow(path));
    },
    async watch() {
      const targets = [
        join(paths.claudeHome, 'projects'),
        join(paths.claudeHome, 'history.jsonl'),
        join(paths.codexHome, 'sessions'),
      ].filter((p) => existsSync(p));
      if (targets.length === 0) return;
      const w = chokidarWatch(targets, {
        ignoreInitial: true,
        ignored: (p, stats) =>
          p.endsWith('.key') ||
          basename(p) === 'tool-results' ||
          (stats?.isFile() === true && !p.endsWith('.jsonl') && !p.endsWith('.meta.json')),
      });
      watcher = w;
      const schedule = (p: string): void => {
        // Debounce per-path: transcripts get appended line-by-line during a live turn, and a
        // partial write mid-append is normal (spike S3) — coalescing bursts into one indexNow
        // call means we mostly read complete lines instead of chasing every fsync.
        const t = timers.get(p);
        if (t) clearTimeout(t);
        timers.set(
          p,
          setTimeout(() => {
            timers.delete(p);
            enqueue(() => indexNow(p)).catch(() => undefined);
            scheduleDetect();
          }, deps.debounceMs ?? 100),
        );
      };
      w.on('add', schedule)
        .on('change', schedule)
        .on('unlink', schedule)
        .on('error', (err: unknown) => log.warn({ err }, 'watcher error'));
      await new Promise<void>((resolve) => {
        w.once('ready', () => resolve());
      });
      // Belt-and-suspenders against missed native fs events (see reconcileSweep's doc comment):
      // this only starts once chokidar itself is confirmed ready, and every tick is cheap thanks
      // to indexNow's existing fast-skip for files that haven't actually changed.
      reconcileTimer = setInterval(() => {
        reconcileSweep();
      }, deps.reconcileMs ?? 15000);
      reconcileTimer.unref();
    },
    async close() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      if (detectTimer) clearTimeout(detectTimer);
      detectTimer = null;
      if (reconcileTimer) clearInterval(reconcileTimer);
      reconcileTimer = null;
      await watcher?.close();
      watcher = null;
      await queue;
    },
    unknownTypes() {
      const out: Record<string, number> = {};
      for (const counts of unknownByFile.values()) {
        for (const [k, v] of Object.entries(counts)) out[k] = (out[k] ?? 0) + v;
      }
      return out;
    },
    reconcile() {
      return reconcileSweep();
    },
  };
}
