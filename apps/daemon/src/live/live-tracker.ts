import {
  createLiveReducer,
  deriveLiveStatus,
  type LiveReducer,
  type LiveState,
  type LiveStatus,
  parseJsonLine,
  type RegistryStatus,
  readJsonlFrom,
  redact,
  type Session,
  type Source,
} from '@orc/core';
import type { CodexLiveDetector } from '../collectors/codex/live.ts';
import type { DaemonContext } from '../context.ts';
import { insertTestResult } from '../db/repos/test-results.ts';
import { sessionPk } from '../services/sessions.ts';
import { createTranscriptFinder } from './find-transcript.ts';
import type { LivenessChecker } from './liveness.ts';
import type { RegistryWatcher } from './registry-watcher.ts';
import { stubSession } from './stub-session.ts';

export interface HookEvent {
  sessionId: string;
  event: string;
  message: string | null;
  ts: string;
}

export interface LiveTracker {
  start(): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<void>;
  list(): Session[];
  get(pk: string): Session | null;
  waitForPid(pid: number, timeoutMs: number): Promise<string | null>;
  applyHook(e: HookEvent): void;
}

export interface LiveTrackerDeps {
  registry: RegistryWatcher;
  liveness: LivenessChecker;
  codex: CodexLiveDetector;
  now?: () => Date;
  findTranscript?: (sessionId: string) => string | null;
}

export function mapHookToStatus(event: string): RegistryStatus | null {
  switch (event) {
    case 'Notification':
      return 'waiting';
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'SubagentStart':
      return 'busy';
    case 'Stop':
      return 'idle';
    default:
      return null;
  }
}

/** Claude's standard context window. `createLiveReducer` assumes this when told nothing. */
export const CONTEXT_WINDOW_DEFAULT = 200_000;

/**
 * Known context windows, ascending. The window is picked as the smallest rung that is at least
 * the session's observed peak usage.
 */
export const CONTEXT_WINDOW_LADDER: readonly number[] = [200_000, 1_000_000];

/**
 * The context window a session must be running, inferred from the largest token usage it has
 * actually reported.
 *
 * **The window is not recorded anywhere in a transcript.** Fix round 1 mapped a `[1m]` suffix on
 * the model id, on the assumption that a 1M-context session says so. It does not: across all 171
 * real transcripts under `~/.claude/projects` (39,993 non-synthetic assistant usage records) the
 * model id is `claude-opus-5` for every single one and no value anywhere contains `1m`. This very
 * session runs a 1M-context model and writes `"model":"claude-opus-5"`. There is no
 * `context_1m`, `contextWindow`, `betas` or `max_context` marker either — zero hits.
 *
 * So the usage numbers are the only evidence that exists, and they are sufficient: a turn cannot
 * consume more context than the window allows, so observed usage is a hard lower bound on the
 * window. In the same corpus, 25,757 of 39,993 records (64.4%) already report
 * `input + cache_read + cache_creation` above 200,000, peaking at 999,591 — so the 200k default
 * was not an edge case, it mis-scaled most real turns, clamping the board's context bar to full.
 *
 * This is self-correcting, needs no configuration, and cannot be wrong in the direction that
 * matters: it never reports a session as fuller than it is. Above the largest known rung the peak
 * itself becomes the window (and `tail` logs it once per session), so a future larger context
 * reads full-but-honest instead of being silently clamped at 1.0.
 */
export function contextWindowForUsage(peakUsedTokens: number): number {
  for (const rung of CONTEXT_WINDOW_LADDER) if (peakUsedTokens <= rung) return rung;
  return peakUsedTokens;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const numOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Context tokens an assistant record reports consuming, or null when it reports none. Mirrors
 * `createLiveReducer`'s own arithmetic exactly (`input + cache_read + cache_creation`, skipping
 * `<synthetic>`), because this number is the denominator's lower bound for the very ratio that
 * reducer computes — if the two disagreed, `contextFill` could still exceed 1.
 */
export function usedTokensOfRecord(value: unknown): number | null {
  if (!isObj(value) || value.type !== 'assistant') return null;
  const msg = value.message;
  if (!isObj(msg) || msg.model === '<synthetic>') return null;
  const u = msg.usage;
  if (!isObj(u)) return null;
  return numOf(u.input_tokens) + numOf(u.cache_read_input_tokens) + numOf(u.cache_creation_input_tokens);
}

interface Entry {
  pk: string;
  source: Source;
  id: string;
  pid: number;
  cwd: string;
  startedAt: string;
  name: string | null;
  registryStatus: RegistryStatus | null;
  registryAt: number;
  waitingFor: string | null;
  hook: { status: RegistryStatus; at: number; message: string | null } | null;
  transcriptPath: string | null;
  offset: number;
  reducer: LiveReducer;
  contextWindow: number;
  peakUsed: number;
  primed: boolean;
  status: LiveStatus | null;
  since: string;
  endedAt: number | null;
  live: LiveState | null;
  lastPublished: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createLiveTracker(ctx: DaemonContext, deps: LiveTrackerDeps): LiveTracker {
  const now = deps.now ?? (() => new Date());
  const findTranscript = deps.findTranscript ?? createTranscriptFinder(ctx.paths.claudeHome);
  const entries = new Map<string, Entry>();
  const dismissed = new Map<string, number>(); // pk -> pid of a removed ended entry
  const unresolvedCodexLogged = new Set<string>();
  const overLadderLogged = new Set<string>();
  let initialPassDone = false;
  let running: Promise<void> | null = null;
  let rerun = false;
  let timer: NodeJS.Timeout | null = null;
  const unsubs: Array<() => void> = [];

  function newEntry(
    source: Source,
    id: string,
    pid: number,
    cwd: string,
    startedAtMs: number | null,
    name: string | null,
  ): Entry {
    return {
      pk: sessionPk(source, id),
      source,
      id,
      pid,
      cwd,
      startedAt: new Date(startedAtMs ?? now().getTime()).toISOString(),
      name,
      registryStatus: null,
      registryAt: 0,
      waitingFor: null,
      hook: null,
      transcriptPath: null,
      offset: 0,
      reducer: createLiveReducer({ contextWindow: CONTEXT_WINDOW_DEFAULT }),
      contextWindow: CONTEXT_WINDOW_DEFAULT,
      peakUsed: 0,
      primed: initialPassDone,
      status: null,
      since: now().toISOString(),
      endedAt: null,
      live: null,
      lastPublished: '',
    };
  }

  function merged(e: Entry): Session {
    const t = e.reducer.snapshot();
    const base =
      ctx.sessions.getByPk(e.pk) ??
      stubSession({
        source: e.source,
        id: e.id,
        cwd: e.cwd,
        startedAt: e.startedAt,
        projectId: ctx.projects.resolve(e.cwd),
        name: e.name,
      });
    const lastActivityAt =
      t.lastActivityAt && t.lastActivityAt > base.lastActivityAt ? t.lastActivityAt : base.lastActivityAt;
    return {
      ...base,
      lastPrompt: t.lastPrompt ?? base.lastPrompt,
      lastTest: t.lastTest ?? base.lastTest,
      permissionMode: t.permissionMode ?? base.permissionMode,
      lastActivityAt,
      cwds: base.cwds.includes(e.cwd) ? base.cwds : [...base.cwds, e.cwd],
      transcriptPath: base.transcriptPath ?? e.transcriptPath,
      live: e.live,
    };
  }

  /**
   * Replays `path` from byte 0 up to (not including) `upToOffset` into a brand-new reducer with a
   * different context window, emitting nothing. This is what makes the window a *per-session,
   * re-derivable* property: `createLiveReducer` takes `contextWindow` at construction, but the
   * model id is only discovered while reading lines and `TranscriptLive` never exposes it, so the
   * only honest way to react to a `[1m]` model (or a mid-run model change) is to rebuild the
   * reducer and re-fold everything read so far. Model ids appear on the first assistant record,
   * so in practice this runs once per session, a few lines in.
   */
  async function refold(path: string, upToOffset: number, contextWindow: number): Promise<LiveReducer> {
    const reducer = createLiveReducer({ contextWindow });
    if (upToOffset <= 0) return reducer;
    try {
      const res = await readJsonlFrom(path, 0);
      for (const l of res.lines) {
        if (l.offset >= upToOffset) break;
        reducer.apply(parseJsonLine(l.text));
      }
    } catch {
      // unreadable mid-flight: the caller keeps the fresh reducer and re-converges on the next tail
    }
    return reducer;
  }

  async function tail(e: Entry): Promise<void> {
    if (e.source !== 'claude') return;
    if (!e.transcriptPath)
      e.transcriptPath = ctx.sessions.getByPk(e.pk)?.transcriptPath ?? findTranscript(e.id);
    if (!e.transcriptPath) return;
    const path = e.transcriptPath;
    let res: Awaited<ReturnType<typeof readJsonlFrom>>;
    try {
      res = await readJsonlFrom(path, e.offset);
    } catch {
      return;
    }
    if (res.truncated) {
      // The carried offset is past EOF, so the file on disk is not the one it describes. Measured
      // across 171 real transcripts, neither compaction nor `/clear` actually produces this:
      // compaction is append-only (all 9 `isCompactSummary` records sit mid-file, thousands of
      // lines from either end, and no transcript begins with one) and `/clear` starts a new
      // sessionId in a new file. So this is defensive, not a path with a known trigger — it is
      // kept because the recovery is cheap and the alternative is a permanently stuck offset.
      // The replacement is re-read from the start as catch-up, silently, for the same reason the
      // first pass is silent: it is history, not a new turn, and must not raise inbox items.
      e.offset = 0;
      e.reducer = createLiveReducer({ contextWindow: CONTEXT_WINDOW_DEFAULT });
      e.contextWindow = CONTEXT_WINDOW_DEFAULT;
      e.peakUsed = 0; // a different file's peak says nothing about this one
      e.primed = false;
      try {
        res = await readJsonlFrom(path, 0);
      } catch {
        return;
      }
    }
    for (const l of res.lines) {
      const value = parseJsonLine(l.text);
      // Widen the window *before* the record that proves it is too narrow reaches the reducer,
      // so the very turn that broke 200k is the first one scaled correctly.
      const used = usedTokensOfRecord(value);
      if (used !== null && used > e.peakUsed) {
        e.peakUsed = used;
        const w = contextWindowForUsage(used);
        if (w !== e.contextWindow) {
          if (w > (CONTEXT_WINDOW_LADDER.at(-1) ?? CONTEXT_WINDOW_DEFAULT) && !overLadderLogged.has(e.pk)) {
            overLadderLogged.add(e.pk);
            ctx.log.warn(
              { pk: e.pk, peakUsed: used, largestKnownWindow: CONTEXT_WINDOW_LADDER.at(-1) },
              'session usage exceeds every known context window; using observed peak as the window',
            );
          }
          e.contextWindow = w;
          e.reducer = await refold(path, l.offset, w);
        }
      }
      const eff = e.reducer.apply(value);
      if (eff.testRecorded) {
        const inserted = insertTestResult(ctx.db, e.pk, eff.testRecorded);
        if (inserted && e.primed)
          ctx.bus.emit({ type: 'tests.recorded', pk: e.pk, result: eff.testRecorded });
      }
      if (eff.turnEnded !== null && e.primed) {
        ctx.bus.emit({ type: 'session.turnEnded', pk: e.pk, turn: eff.turnEnded });
      }
    }
    e.offset = res.nextOffset;
    e.primed = true;
  }

  function update(e: Entry, alive: boolean, nowMs: number): void {
    const t = e.reducer.snapshot();
    const hookWins = e.hook !== null && e.hook.at > e.registryAt;
    const registryStatus = hookWins && e.hook ? e.hook.status : e.registryStatus;
    const status = deriveLiveStatus({ alive, registryStatus, transcript: t });
    let change: { from: LiveStatus | null; to: LiveStatus } | null = null;
    if (status !== e.status) {
      change = { from: e.status, to: status };
      e.status = status;
      e.since = new Date(nowMs).toISOString();
      e.endedAt = status === 'ended' ? nowMs : null;
    }
    const owner = ctx.pty
      .list()
      .find((p) => p.exitedAt === null && (p.pid === e.pid || p.sessionPk === e.pk));
    // `waitingFor` is copied verbatim out of Claude Code's own registry file (or a hook payload):
    // free text from a process we do not control, and a field Phase 1 already caught leaking once.
    // It is redacted here, at the point it enters our own state, as well as at the HTTP boundary.
    const waitingText = hookWins && e.hook?.message ? e.hook.message : (e.waitingFor ?? 'input needed');
    e.live = {
      pid: e.pid,
      status,
      waitingFor: status === 'waiting' ? redact(waitingText) : null,
      since: e.since,
      ownership: owner ? 'owned' : 'observed',
      ptyId: owner?.id ?? null,
      stage: t.stage,
      currentTool: t.currentTool,
      backgroundJobs: t.backgroundJobs,
      runningSubagents: t.runningSubagents,
      contextFill: t.contextFill,
    };
    const key = `${JSON.stringify(e.live)}|${t.lastPrompt ?? ''}|${t.lastTest?.ts ?? ''}`;
    if (key !== e.lastPublished) {
      e.lastPublished = key;
      if (ctx.sessions.getByPk(e.pk)) ctx.sessions.setLive(e.pk, e.live);
      ctx.bus.emit({ type: 'session.updated', session: merged(e) });
    }
    // Seeding, not a transition. The first pass discovers sessions that were *already* running
    // when the daemon started; per spike S3 their `statusUpdatedAt` is the AGE of the last change,
    // not a detection delay. Announcing those as `session.statusChanged` would fire the whole
    // board's worth of notifications on every daemon restart and would poison any latency
    // measurement taken against them. The status itself is still recorded, so the first *real*
    // transition afterwards reports an accurate `from`.
    if (change && initialPassDone) {
      ctx.bus.emit({ type: 'session.statusChanged', pk: e.pk, from: change.from, to: change.to });
    }
  }

  function remove(e: Entry): void {
    entries.delete(e.pk);
    dismissed.set(e.pk, e.pid);
    if (ctx.sessions.getByPk(e.pk)) ctx.sessions.setLive(e.pk, null);
    ctx.bus.emit({ type: 'session.removed', pk: e.pk });
  }

  function upsertEntry(
    source: Source,
    id: string,
    pid: number,
    cwd: string,
    startedAtMs: number | null,
    name: string | null,
  ): Entry | null {
    const pk = sessionPk(source, id);
    if (dismissed.get(pk) === pid) return null;
    dismissed.delete(pk);
    let e = entries.get(pk);
    if (!e || e.pid !== pid) {
      const fresh = newEntry(source, id, pid, cwd, startedAtMs, name);
      if (e) {
        fresh.transcriptPath = e.transcriptPath;
        fresh.offset = e.offset;
        fresh.reducer = e.reducer;
        fresh.contextWindow = e.contextWindow;
        fresh.peakUsed = e.peakUsed;
        fresh.primed = e.primed;
        fresh.status = e.status;
      }
      e = fresh;
      entries.set(pk, e);
    }
    e.cwd = cwd;
    if (name) e.name = name;
    return e;
  }

  async function pass(): Promise<void> {
    const nowMs = now().getTime();
    const cfg = ctx.config();
    const seen = new Set<string>();

    // Cheap (a handful of small files); makes refresh() authoritative even when fs events are late.
    await deps.registry.rescan();
    for (const snap of deps.registry.current()) {
      const r = snap.entry;
      const e = upsertEntry('claude', r.sessionId, r.pid, r.cwd, r.startedAt, r.name);
      if (!e) continue;
      seen.add(e.pk);
      e.registryStatus = r.status;
      e.registryAt = r.statusUpdatedAt ?? r.updatedAt ?? 0;
      e.waitingFor = r.waitingFor;
      // Two arguments: a registry file outlives its process, so `procStart` is what stops a
      // recycled pid from keeping a dead session on the board. See `createLivenessChecker`.
      const alive = await deps.liveness.isAlive(r.pid, r.procStart);
      await tail(e);
      update(e, alive, nowMs);
    }

    let procs: Awaited<ReturnType<CodexLiveDetector['scan']>> = [];
    try {
      procs = await deps.codex.scan();
    } catch (err) {
      ctx.log.warn({ err: String(err) }, 'codex live scan failed');
    }
    for (const p of procs) {
      if (!p.sessionId) {
        // A running `codex` whose rollout could not be matched. It is skipped rather than shown
        // as a degraded card because every downstream identity — the `<source>:<id>` pk,
        // `sessions.setLive`, the WS event stream — is keyed on the session id, and a synthetic
        // stand-in would have to be replaced (card disappears, different card appears) the moment
        // the rollout resolves. The detector re-searches unbound processes on every sweep and
        // re-reads meta it cached as null, so this state is normally transient; it is logged once
        // per process, at `warn` so it is visible at the daemon's default level (`info`) — a
        // `debug` here would make the stated mitigation invisible in practice.
        const key = `${p.pid}:${p.startedAtMs}`;
        if (!unresolvedCodexLogged.has(key)) {
          unresolvedCodexLogged.add(key);
          ctx.log.warn({ pid: p.pid, cwd: p.cwd }, 'codex process has no matched rollout; not shown');
        }
        continue;
      }
      if (p.originator === 'codex_sdk_ts' && !cfg.codex.showAutomated) continue;
      const e = upsertEntry('codex', p.sessionId, p.pid, p.cwd, p.startedAtMs, null);
      if (!e) continue;
      seen.add(e.pk);
      e.registryStatus =
        p.lastWriteMs !== null && nowMs - p.lastWriteMs < cfg.live.codexBusyWindowMs ? 'busy' : 'idle';
      e.registryAt = p.lastWriteMs ?? 0;
      update(e, true, nowMs);
    }

    const retentionMs = cfg.live.endedRetentionMin * 60_000;
    for (const e of [...entries.values()]) {
      if (!seen.has(e.pk)) {
        if (e.status !== 'ended') update(e, false, nowMs);
      }
      if (e.status === 'ended' && e.endedAt !== null && nowMs - e.endedAt > retentionMs) remove(e);
    }
  }

  async function refresh(): Promise<void> {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      do {
        rerun = false;
        await pass();
      } while (rerun);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    async start() {
      await deps.registry.start();
      unsubs.push(deps.registry.onChange(() => void refresh()));
      unsubs.push(ctx.bus.on('pty.exited', () => void refresh()));
      await refresh();
      initialPassDone = true;
      timer = setInterval(() => void refresh(), ctx.config().live.pollMs);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const u of unsubs.splice(0)) u();
      await deps.registry.stop();
      if (running) await running;
    },
    refresh,
    list: () => [...entries.values()].filter((e) => e.live !== null).map(merged),
    get(pk) {
      const e = entries.get(pk);
      return e?.live ? merged(e) : null;
    },
    async waitForPid(pid, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await deps.registry.rescan();
        const snap = deps.registry.current().find((s) => s.entry.pid === pid);
        if (snap) {
          await refresh();
          return snap.entry.sessionId;
        }
        await sleep(100);
      }
      return null;
    },
    applyHook(ev) {
      const status = mapHookToStatus(ev.event);
      const e = entries.get(sessionPk('claude', ev.sessionId));
      if (!status || !e) return;
      const at = Date.parse(ev.ts);
      e.hook = { status, at: Number.isFinite(at) ? at : now().getTime(), message: ev.message };
      void refresh();
    },
  };
}
