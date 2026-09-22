import { existsSync } from 'node:fs';
import type { OrcConfig, SessionListItem } from '@orc/api-contract';
import {
  type AgentNode,
  type Availability,
  type LiveState,
  type PrRef,
  registryStatusToLive,
  type Session,
  type Source,
  type TimelineEvent,
} from '@orc/core';
import type { OrcPaths } from '../config.ts';
import type { OrcDb } from '../db/client.ts';
import { escapeLike, ftsPrefixToken, toFtsQuery } from '../db/fts.ts';
import { sessionPk } from '../db/keys.ts';
import { listAgents } from '../db/repos/agents.ts';
import { archivedSessionPks } from '../db/repos/archive.ts';
import {
  eventSnippet,
  eventTextByRowid,
  ftsPrefixCardinality,
  listEvents,
  searchEventSessions,
} from '../db/repos/events.ts';
import { searchHistoryPrompts } from '../db/repos/history.ts';
import { insertPtySession, markPtyExited } from '../db/repos/pty-sessions.ts';
import {
  getSessionByPk,
  querySessions,
  type SessionQueryFilter,
  type SessionRow,
  searchSessionText,
} from '../db/repos/sessions.ts';
import { labelsFor, pinnedSet } from '../db/repos/user-meta.ts';
import type { EventBus } from '../live/event-bus.ts';
import { findRegistryEntry, isPidAlive } from '../live/liveness.ts';
import type { PtyInfo, PtyManager } from '../pty/pty-manager.ts';
import { resolveAvailability } from './archive/archive.ts';
import { ServiceError } from './errors.ts';
import { type ExternalLauncher, resumeCommandLine } from './external.ts';
import type { ProjectServiceImpl } from './projects.ts';
import { redactedHighlight } from './snippet.ts';

export type { SessionListItem } from '@orc/api-contract';
export { sessionPk } from '../db/keys.ts';

export interface SessionListQuery {
  q?: string;
  projectId?: string;
  source?: Source;
  ticket?: string;
  pr?: string;
  from?: string;
  to?: string;
  model?: string;
  minCost?: number;
  maxCost?: number;
  skill?: string;
  hasSubagents?: boolean;
  touchedProd?: boolean;
  availability?: Availability;
  label?: string;
  pinned?: boolean;
  includeHidden?: boolean;
  includeAutomated?: boolean;
  limit?: number;
  cursor?: string;
}

export interface ResumeOptions {
  mode: 'embedded' | 'external';
  fork?: boolean;
  popOut?: boolean;
  cols?: number;
  rows?: number;
}

export type ResumeResult = { ptyId: string } | { launched: 'external'; command: string };

export interface SessionService {
  list(q: SessionListQuery): { items: SessionListItem[]; nextCursor: string | null };
  get(source: Source, id: string): Session | null;
  getByPk(pk: string): Session | null;
  events(
    source: Source,
    id: string,
    opts: { agentId?: string | null; afterSeq?: number; limit?: number },
  ): { items: TimelineEvent[]; nextSeq: number | null };
  agents(source: Source, id: string): AgentNode[];
  setLive(pk: string, live: LiveState | null): void;
  resume(source: Source, id: string, opts: ResumeOptions): Promise<ResumeResult>;
}

export interface SessionServiceDeps {
  db: OrcDb;
  paths: OrcPaths;
  config: () => OrcConfig;
  bus: EventBus;
  pty: PtyManager;
  projects: ProjectServiceImpl;
  launchExternal: ExternalLauncher;
  isPidAlive?: (pid: number) => boolean;
}

export function buildResumeCommand(
  s: Pick<Session, 'source' | 'id'>,
  cfg: OrcConfig,
  fork: boolean,
): { command: string; args: string[] } {
  const p = cfg.resumeProfile;
  if (s.source === 'codex') return { command: p.codexCommand, args: [...p.codexArgs, 'resume', s.id] };
  return {
    command: p.claudeCommand,
    args: [...p.claudeArgs, '--resume', s.id, ...(fork ? ['--fork-session'] : [])],
  };
}

export function encodeCursor(c: { lastActivityAt: string; pk: string }): string {
  return Buffer.from(JSON.stringify([c.lastActivityAt, c.pk])).toString('base64url');
}

export function decodeCursor(s: string): { lastActivityAt: string; pk: string } {
  try {
    const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string') {
      return { lastActivityAt: v[0], pk: v[1] };
    }
  } catch {
    // fall through to the validation error
  }
  throw new ServiceError('validation_failed', 400, 'invalid cursor');
}

function ownedLive(info: PtyInfo): LiveState {
  return {
    pid: info.pid,
    status: 'idle',
    waitingFor: null,
    since: info.startedAt,
    ownership: 'owned',
    ptyId: info.id,
    stage: null,
    currentTool: null,
    backgroundJobs: 0,
    runningSubagents: 0,
    contextFill: null,
  };
}

export function createSessionService(deps: SessionServiceDeps): SessionService {
  const { db, bus, pty, projects } = deps;
  const alive = deps.isPidAlive ?? isPidAlive;
  const live = new Map<string, LiveState>();

  function observedLive(s: Session): LiveState | null {
    if (s.source !== 'claude') return null;
    const entry = findRegistryEntry(deps.paths.claudeHome, s.id, alive);
    if (!entry) return null;
    return {
      pid: entry.pid,
      status: entry.alive ? (entry.status ? registryStatusToLive(entry.status) : 'idle') : 'ended',
      waitingFor: entry.alive ? entry.waitingFor : null,
      since:
        entry.statusUpdatedAt !== null ? new Date(entry.statusUpdatedAt).toISOString() : s.lastActivityAt,
      ownership: 'observed',
      ptyId: null,
      stage: null,
      currentTool: null,
      backgroundJobs: 0,
      runningSubagents: 0,
      contextFill: null,
    };
  }

  /** Computed when read (docs/02 F3): the stored column cannot know a transcript was deleted. */
  function availabilityOf(
    row: { pk: string; availability: string; transcriptPath: string | null },
    archived: ReadonlySet<string>,
  ): Availability {
    return resolveAvailability({
      transcriptExists: row.transcriptPath !== null && existsSync(row.transcriptPath),
      archived: archived.has(row.pk),
      hasPrompts: true,
      remote: row.availability === 'remote',
    });
  }

  /**
   * `availability` other than `remote` depends on the filesystem, so it is filtered after the
   * query rather than in SQL: rows are read in order, in batches, until `want` matches are found.
   * `archived` narrows the query to sessions that have archive entries at all.
   */
  function scanByAvailability(
    base: Omit<SessionQueryFilter, 'limit' | 'cursor'>,
    wanted: Availability,
    archived: ReadonlySet<string>,
    want: number,
    cursor: SessionQueryFilter['cursor'],
  ): SessionRow[] {
    const BATCH = 200;
    const pks =
      wanted === 'archived' ? (base.pks ?? [...archived]).filter((pk) => archived.has(pk)) : base.pks;
    const out: SessionRow[] = [];
    let at = cursor;
    for (;;) {
      const chunk = querySessions(db, { ...base, pks, limit: BATCH, cursor: at });
      for (const r of chunk) {
        if (availabilityOf(r, archived) === wanted) out.push(r);
        if (out.length >= want) return out;
      }
      const last = chunk.at(-1);
      if (chunk.length < BATCH || !last) return out;
      at = { lastActivityAt: last.lastActivityAt, pk: last.pk };
    }
  }

  function load(pk: string, withRegistry: boolean): Session | null {
    const s = getSessionByPk(db, pk);
    if (!s) return null;
    const availability = availabilityOf({ ...s, pk }, archivedSessionPks(db));
    const withAvail = { ...s, availability };
    return { ...withAvail, live: live.get(pk) ?? (withRegistry ? observedLive(withAvail) : null) };
  }

  function getByPk(pk: string): Session | null {
    return load(pk, true);
  }

  function mustGet(source: Source, id: string): Session {
    const s = getByPk(sessionPk(source, id));
    if (!s) throw new ServiceError('not_found', 404, `session ${source}:${id} not found`);
    return s;
  }

  function setLive(pk: string, next: LiveState | null): void {
    if (next) live.set(pk, next);
    else live.delete(pk);
    const s = load(pk, false);
    if (s) bus.emit({ type: 'session.updated', session: s });
  }

  // Above this many distinct dictionary terms, FTS5's snippet() cost (which scales with term
  // cardinality, not row count — see events.ts's `ftsPrefixCardinality` doc comment) is no
  // longer safe to pay per result row. Fix round 2's original value (40) was tuned against the
  // perf suite's synthetic numbered vocabulary and turned out to be far too conservative: Fix
  // round 3 measured real cardinality for common short prefixes against the user's actual
  // `~/.claude`/`~/.codex` (read-only, temp ORC_HOME) and found ordinary 3-char prefixes like
  // "get" (~438), "con" (~489), "use" (~490), "def" (~124) routinely exceed 40 — a cap that low
  // made the fallback the common path, not the safety-net exception it was designed as. Directly
  // timing FTS5 `snippet()` at each of those real cardinalities (not extrapolated) showed cost is
  // NOT cleanly monotonic in cardinality alone (real text's posting-list sizes vary): every
  // measured cardinality up to 244 stayed under ~75 ms for a full 50-row page, but at ~489 one
  // real prefix ("con") measured 188 ms — over budget — while another at a similar cardinality
  // ("get", ~438) measured only 31 ms. 250 is set just above the highest cardinality with a
  // consistent safety margin in that measurement (keeping the great majority of real short
  // prefixes — 17 of 20 measured common English prefixes — on the FTS5-native `snippet()` path,
  // which gives better phrase-aware highlighting than the fallback), while still routing the few
  // widest, riskiest prefixes to the bounded fallback. See task-19-report.md's "Fix round 3" for
  // the full measured table.
  const FTS_PREFIX_CARDINALITY_CAP = 250;

  function toItem(
    row: SessionRow,
    pinned: boolean,
    labels: string[],
    snippet: string | null,
    availability: Availability,
  ): SessionListItem {
    const duration = Date.parse(row.lastActivityAt) - Date.parse(row.startedAt);
    return {
      pk: row.pk,
      source: row.source as Source,
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      firstPrompt: row.firstPrompt,
      lastPrompt: row.lastPrompt,
      recap: row.recap,
      startedAt: row.startedAt,
      lastActivityAt: row.lastActivityAt,
      durationMs: Number.isFinite(duration) && duration > 0 ? duration : 0,
      costUsd: row.costUsd,
      tickets: JSON.parse(row.ticketsJson) as string[],
      prs: JSON.parse(row.prsJson) as PrRef[],
      availability,
      pinned,
      labels,
      live: live.get(row.pk) ?? null,
      snippet,
    };
  }

  async function stopPty(ptyId: string): Promise<void> {
    await new Promise<void>((resolve) => {
      const off = bus.on('pty.exited', (e) => {
        if (e.ptyId !== ptyId) return;
        off();
        clearTimeout(timer);
        resolve();
      });
      const timer = setTimeout(() => {
        off();
        resolve();
      }, 3000);
      pty.kill(ptyId, 'SIGHUP');
    });
  }

  bus.on('pty.exited', (e) => {
    markPtyExited(db, e.ptyId, e.code, new Date().toISOString());
    for (const [pk, l] of [...live]) if (l.ptyId === e.ptyId) setLive(pk, null);
  });
  bus.on('session.indexed', (e) => {
    const s = load(e.pk, false);
    if (s) bus.emit({ type: 'session.updated', session: s });
  });

  return {
    list(q) {
      const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
      const cursor = q.cursor ? decodeCursor(q.cursor) : null;
      const text = q.q?.trim() ?? '';
      let pks: string[] | null = null;
      let match: string | null = null;
      let hits = new Map<string, number>();
      const fallback = new Map<string, string>();
      if (text) {
        match = toFtsQuery(text);
        if (match) hits = searchEventSessions(db, match);
        const like = `%${escapeLike(text)}%`;
        const set = new Set<string>(hits.keys());
        for (const pk of searchSessionText(db, like)) set.add(pk);
        for (const h of searchHistoryPrompts(db, like)) {
          set.add(h.pk);
          // redactedHighlight, not highlight: h.display is raw, transcript-derived prompt text —
          // exactly where a pasted credential lands ("here's the token, go fix the deploy") — and
          // must be redacted before truncation for the same reason the wide-fan-out event-snippet
          // fallback was (Fix round 3): highlight()'s ±40-char truncation can bisect a secret
          // pattern's anchor or length gate, and the HTTP-boundary redaction pass
          // (`redactSnippet` in http/redact-out.ts) runs on the *already-truncated* text, so it
          // cannot recover a secret that truncation has already made unrecognizable to `redact()`.
          if (!hits.has(h.pk)) fallback.set(h.pk, redactedHighlight(h.display, text));
        }
        pks = [...set];
      }
      const { q: _q, cursor: _cursor, limit: _limit, availability: wanted, ...filters } = q;
      const archived = archivedSessionPks(db);
      const base = {
        ...filters,
        pks,
        includeAutomated: q.includeAutomated ?? deps.config().codex.showAutomated,
      };
      const rows =
        wanted === undefined || wanted === 'remote'
          ? querySessions(db, { ...base, availability: wanted, limit: limit + 1, cursor })
          : scanByAvailability(base, wanted, archived, limit + 1, cursor);
      const page = rows.slice(0, limit);
      const pagePks = page.map((r) => r.pk);
      const pinned = pinnedSet(db, pagePks);
      const labels = labelsFor(db, pagePks);
      // Decided once per search, not once per result row: a query's prefix term either is or
      // isn't a wide-cardinality fan-out risk regardless of how many rows end up on the page.
      const prefixToken = match ? ftsPrefixToken(text) : null;
      const wideFanout =
        prefixToken !== null && ftsPrefixCardinality(db, prefixToken) > FTS_PREFIX_CARDINALITY_CAP;
      const items = page.map((r) => {
        const rid = hits.get(r.pk);
        let snippet: string | null;
        if (match && rid !== undefined) {
          if (wideFanout) {
            // Skip FTS5's snippet() (its cost scales with the prefix's term cardinality) and
            // highlight the already-fetched raw text in application code instead — same
            // redaction guarantee, bounded cost regardless of how wide the prefix fans out.
            const row = eventTextByRowid(db, rid);
            const raw = row?.text ?? row?.searchInput ?? null;
            // redactedHighlight redacts the full raw text BEFORE truncating it for display — see
            // its doc comment (services/snippet.ts) for why the order matters (Fix round 3: the
            // reverse order let a secret survive when highlight()'s ±40-char truncation bisected
            // the pattern redact() anchors on).
            snippet = raw === null ? null : redactedHighlight(raw, prefixToken ?? text);
          } else {
            snippet = eventSnippet(db, match, rid);
          }
        } else {
          snippet = fallback.get(r.pk) ?? null;
        }
        return toItem(r, pinned.has(r.pk), labels.get(r.pk) ?? [], snippet, availabilityOf(r, archived));
      });
      const last = page.at(-1);
      return {
        items,
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ lastActivityAt: last.lastActivityAt, pk: last.pk })
            : null,
      };
    },
    get(source, id) {
      return getByPk(sessionPk(source, id));
    },
    getByPk,
    events(source, id, opts) {
      mustGet(source, id);
      return listEvents(db, sessionPk(source, id), opts);
    },
    agents(source, id) {
      mustGet(source, id);
      return listAgents(db, sessionPk(source, id));
    },
    setLive,
    async resume(source, id, opts) {
      const pk = sessionPk(source, id);
      const s = getByPk(pk);
      if (!s) throw new ServiceError('not_found', 404, `session ${pk} not found`);
      if (source === 'agnc')
        throw new ServiceError('unsupported', 400, 'AGNC sessions cannot be resumed locally');
      if (opts.fork && source !== 'claude') {
        throw new ServiceError('unsupported', 400, 'fork is only supported for Claude sessions');
      }
      if (s.availability !== 'resumable') {
        throw new ServiceError('not_resumable', 409, `session is ${s.availability}`, {
          availability: s.availability,
        });
      }
      if (!opts.fork) {
        const owned = live.get(pk);
        if (owned?.ptyId && pty.get(owned.ptyId)?.exitedAt === null) {
          if (opts.mode === 'external' && opts.popOut) {
            await stopPty(owned.ptyId);
          } else {
            throw new ServiceError('session_live', 409, 'session is already open in the app', {
              ptyId: owned.ptyId,
              ownership: 'owned',
            });
          }
        } else if (s.live?.ownership === 'observed' && s.live.status !== 'ended') {
          throw new ServiceError('session_live', 409, 'session is running in another terminal', {
            pid: s.live.pid,
            ownership: 'observed',
          });
        }
      }
      if (!existsSync(s.startCwd)) {
        throw new ServiceError('cwd_missing', 422, `directory ${s.startCwd} no longer exists`, {
          cwd: s.startCwd,
        });
      }
      const { command, args } = buildResumeCommand(s, deps.config(), opts.fork === true);
      if (opts.mode === 'external') {
        const openIn = (s.projectId ? projects.get(s.projectId)?.openIn : undefined) ?? 'terminal';
        await deps.launchExternal({ cwd: s.startCwd, command, args, openIn });
        return { launched: 'external', command: resumeCommandLine(s.startCwd, command, args) };
      }
      const info = pty.spawn({
        command,
        args,
        cwd: s.startCwd,
        sessionPk: opts.fork ? null : pk,
        cols: opts.cols,
        rows: opts.rows,
      });
      insertPtySession(db, {
        id: info.id,
        sessionPk: info.sessionPk,
        command,
        args,
        cwd: info.cwd,
        pid: info.pid,
        startedAt: info.startedAt,
      });
      if (!opts.fork) setLive(pk, ownedLive(info));
      return { ptyId: info.id };
    },
  };
}
