import { existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
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
}

export interface IndexerDeps {
  db: OrcDb;
  raw: Database.Database;
  paths: OrcPaths;
  projects: ProjectServiceImpl;
  bus: EventBus;
  log: Logger;
  debounceMs?: number;
}

interface FileStat {
  size: number;
  mtimeMs: number;
}

function readMeta(jsonlPath: string): SubagentMeta {
  try {
    return parseSubagentMeta(JSON.parse(readFileSync(jsonlPath.replace(/\.jsonl$/, '.meta.json'), 'utf8')));
  } catch {
    return parseSubagentMeta(null);
  }
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
  let watcher: FSWatcher | null = null;
  let queue: Promise<void> = Promise.resolve();
  const resolveCfg = (cwd: string | null): DeriveConfig => projects.deriveConfigFor(cwd);

  // Every scan/index/watch task is funneled through this single promise chain, so two file
  // events (or a scan overlapping a watch event) can never race each other into the same
  // session's transaction.
  function enqueue(fn: () => Promise<void> | void): Promise<void> {
    const run = queue.then(fn);
    queue = run.catch((err: unknown) => {
      log.error({ err }, 'indexing task failed');
    });
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
    let st: FileStat;
    try {
      const s = await stat(path);
      st = { size: s.size, mtimeMs: Math.floor(s.mtimeMs) };
    } catch {
      // ENOENT and friends are normal here: the watcher fires on delete, and a scan can race a
      // file being removed mid-pass. Skip and wait for the next event rather than erroring.
      onMissing(path, cls);
      return;
    }
    const prev = getFileOffset(db, path);
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return;
    const start = prev && st.size >= prev.offset ? prev.offset : 0;
    const reset = start === 0;
    const prevState = reset ? null : (prev?.stateJson ?? null);
    // readJsonlFrom itself detects a stored offset past the file's current size (truncation from
    // compaction or /clear) and reports `truncated: true` with `nextOffset: 0`; `start === 0`
    // here also covers a brand-new file. Either way `reset` drops the old events for this path
    // and starts a fresh aggregate state so the session reflects only the current file content.
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
    },
    async close() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      if (detectTimer) clearTimeout(detectTimer);
      detectTimer = null;
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
  };
}
