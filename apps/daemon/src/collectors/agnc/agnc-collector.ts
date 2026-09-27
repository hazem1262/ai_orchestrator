import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { AgncSession } from '@orc/api-contract';
import { emptyUsage, type LiveStatus, redact, type Session } from '@orc/core';
import type { AgncConnector } from '../../connectors/agnc/agnc.ts';
import type { DaemonContext } from '../../context.ts';
import { upsertSession } from '../../db/repos/sessions.ts';

const BUSY = new Set(['running', 'in_progress', 'queued', 'pending', 'starting']);
const WAITING = new Set(['waiting', 'waiting_for_input', 'needs_input', 'blocked', 'awaiting_review']);
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled']);

function liveStatusFor(status: string): LiveStatus | null {
  const s = status.toLowerCase();
  if (BUSY.has(s)) return 'busy';
  if (WAITING.has(s)) return 'waiting';
  if (FAILED.has(s)) return 'error';
  return null; // completed / done / unknown → not live
}

/**
 * Maps an AGNC session to a remote `Session`. While it is active it is `observed` with no PTY, so
 * the "input only to owned sessions" rule keeps the PTY paths away from it. The title is redacted
 * because it is stored and broadcast.
 */
export function agncToSession(a: AgncSession, projectId: string | null): Session {
  const live = liveStatusFor(a.status);
  const updatedAt = a.updatedAt ?? a.createdAt ?? new Date(0).toISOString();
  return {
    id: a.id,
    source: 'agnc',
    projectId,
    startCwd: a.repoOwner && a.repoName ? `agnc://${a.repoOwner}/${a.repoName}` : 'agnc://remote',
    cwds: [],
    name: a.title === null ? null : redact(a.title),
    firstPrompt: null,
    lastPrompt: null,
    awaySummary: null,
    recap: null,
    startedAt: a.createdAt ?? updatedAt,
    lastActivityAt: updatedAt,
    models: [],
    permissionMode: null,
    usage: emptyUsage(),
    linesAdded: null,
    linesRemoved: null,
    prs: [],
    tickets: [],
    skills: [],
    mcpServers: [],
    filesTouched: [],
    promptCount: 0,
    toolCallCount: 0,
    apiErrorCount: 0,
    flags: { touchedProd: false, hasSubagents: false, automated: false },
    availability: 'remote',
    transcriptPath: null,
    lastTest: null,
    live:
      live === null
        ? null
        : {
            pid: null,
            status: live,
            waitingFor: null,
            since: updatedAt,
            ownership: 'observed',
            ptyId: null,
            stage: null,
            currentTool: null,
            backgroundJobs: 0,
            runningSubagents: 0,
            contextFill: null,
          },
  };
}

/** Polls `agnc_list_sessions { scope: 'mine' }` and upserts each session with `source: 'agnc'`. */
export function createAgncCollector(deps: {
  ctx: DaemonContext;
  agnc: AgncConnector;
  intervalMs?: number;
  upsert?: (s: Session) => void;
}): { tick(): Promise<number>; start(): () => void } {
  const { ctx } = deps;
  const upsert = deps.upsert ?? ((s: Session) => upsertSession(ctx.db, s));

  const tick = async (): Promise<number> => {
    const remote = await deps.agnc.listMySessions();
    for (const a of remote) {
      const session = agncToSession(a, ctx.config().defaultProjectId);
      upsert(session);
      ctx.bus.emit({ type: 'session.updated', session });
    }
    return remote.length;
  };

  return {
    tick,
    start() {
      if (!ctx.config().agnc.enabled) return () => {};
      const run = () =>
        void tick().catch((err: unknown) => {
          if (err instanceof UnauthorizedError) ctx.log.debug('agnc poll skipped: not authorised');
          else ctx.log.warn({ err }, 'agnc poll failed');
        });
      run();
      const timer = setInterval(run, deps.intervalMs ?? ctx.config().agnc.pollSeconds * 1000);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
