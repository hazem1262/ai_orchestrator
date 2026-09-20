import { randomUUID } from 'node:crypto';
import { type IPty, spawn as ptySpawn } from 'node-pty';
import type { EventBus } from '../live/event-bus.ts';
import { ServiceError } from '../services/errors.ts';
import { sendText as sendTextTo } from './input.ts';

export interface PtyInfo {
  id: string;
  sessionPk: string | null;
  command: string;
  args: string[];
  cwd: string;
  pid: number;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
  cols: number;
  rows: number;
}

export interface PtySpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  sessionPk?: string | null;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export interface PtyManager {
  spawn(opts: PtySpawnOptions): PtyInfo;
  write(id: string, data: string): void;
  sendText(id: string, text: string): Promise<void>;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string, signal?: NodeJS.Signals): void;
  attach(id: string, onData: (chunk: string) => void): { scrollback: string; detach(): void };
  list(): PtyInfo[];
  get(id: string): PtyInfo | undefined;
  remove(id: string): void;
  disposeAll(): void;
}

interface Entry {
  info: PtyInfo;
  proc: IPty | null;
  chunks: string[];
  size: number;
  listeners: Set<(chunk: string) => void>;
}

/** Env marker a `claude` process checks to decide whether it's a nested/child session. */
const CHILD_SESSION_MARKER = 'CLAUDE_CODE_CHILD_SESSION';
/** Env flag that overrides the marker and forces the child to keep writing its transcript. */
const FORCE_PERSISTENCE_VAR = 'CLAUDE_CODE_FORCE_SESSION_PERSISTENCE';

/**
 * Controller ruling 2 (CRITICAL, see plan/spikes/S2-S8.md "child-session env inheritance"):
 * a `claude` process spawned from inside another Claude session inherits
 * CLAUDE_CODE_CHILD_SESSION and then writes no transcript at all, which would make every
 * session this app launches invisible to its own indexer. Strip the marker and force
 * persistence for every child this manager spawns.
 */
function sanitizedChildEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === 'string' && k !== CHILD_SESSION_MARKER) env[k] = v;
  }
  Object.assign(env, extra ?? {});
  delete env[CHILD_SESSION_MARKER];
  env[FORCE_PERSISTENCE_VAR] = '1';
  return env;
}

/**
 * Startup check (controller ruling 2): warns if the *daemon's own* process env carries the
 * child-session marker (i.e. the daemon itself was launched from inside another Claude
 * session). spawn() already sanitises what it passes to children regardless, but this is
 * a loud signal something about the daemon's own launch environment is unusual.
 */
export function warnIfChildSessionEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = console.warn,
): void {
  if (env[CHILD_SESSION_MARKER]) {
    warn(
      `orchestrator daemon started with ${CHILD_SESSION_MARKER} set in its own environment ` +
        "(it was likely launched from inside another Claude session). This doesn't affect " +
        'PTYs spawned by the daemon (their env is sanitised), but double-check anything that ' +
        "inherits the daemon's own environment directly.",
    );
  }
}

export function createPtyManager(opts: { bus: EventBus; scrollbackBytes?: number }): PtyManager {
  const max = opts.scrollbackBytes ?? 256_000;
  const entries = new Map<string, Entry>();

  const must = (id: string): Entry => {
    const e = entries.get(id);
    if (!e) throw new ServiceError('not_found', 404, `pty ${id} not found`);
    return e;
  };
  const running = (id: string): IPty => {
    const e = must(id);
    if (!e.proc) throw new ServiceError('pty_exited', 409, `pty ${id} has exited`);
    return e.proc;
  };

  function push(e: Entry, chunk: string): void {
    e.chunks.push(chunk);
    e.size += chunk.length;
    while (e.size > max && e.chunks.length > 1) {
      const first = e.chunks.shift() ?? '';
      e.size -= first.length;
    }
    const only = e.chunks[0];
    if (e.size > max && e.chunks.length === 1 && only !== undefined) {
      const trimmed = only.slice(only.length - max);
      e.chunks[0] = trimmed;
      e.size = trimmed.length;
    }
  }

  const snapshot = (info: PtyInfo): PtyInfo => ({ ...info, args: [...info.args] });

  return {
    spawn(o) {
      const id = randomUUID();
      const cols = o.cols ?? 120;
      const rows = o.rows ?? 36;
      const env = sanitizedChildEnv(process.env, o.env);
      const proc = ptySpawn(o.command, o.args, { name: 'xterm-256color', cols, rows, cwd: o.cwd, env });
      const info: PtyInfo = {
        id,
        sessionPk: o.sessionPk ?? null,
        command: o.command,
        args: [...o.args],
        cwd: o.cwd,
        pid: proc.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
        cols,
        rows,
      };
      const entry: Entry = { info, proc, chunks: [], size: 0, listeners: new Set() };
      entries.set(id, entry);
      proc.onData((d) => {
        push(entry, d);
        for (const l of [...entry.listeners]) l(d);
      });
      proc.onExit(({ exitCode }) => {
        entry.proc = null;
        info.exitedAt = new Date().toISOString();
        info.exitCode = exitCode;
        opts.bus.emit({ type: 'pty.exited', ptyId: id, code: exitCode });
      });
      return snapshot(info);
    },
    write(id, data) {
      running(id).write(data);
    },
    async sendText(id, text) {
      running(id);
      await sendTextTo((d) => running(id).write(d), text);
    },
    resize(id, cols, rows) {
      const e = must(id);
      if (!e.proc) return;
      e.proc.resize(cols, rows);
      e.info.cols = cols;
      e.info.rows = rows;
    },
    kill(id, signal = 'SIGHUP') {
      must(id).proc?.kill(signal);
    },
    attach(id, onData) {
      const e = must(id);
      e.listeners.add(onData);
      return {
        scrollback: e.chunks.join(''),
        detach: () => {
          e.listeners.delete(onData);
        },
      };
    },
    list() {
      return [...entries.values()]
        .map((e) => snapshot(e.info))
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    },
    get(id) {
      const e = entries.get(id);
      return e ? snapshot(e.info) : undefined;
    },
    remove(id) {
      const e = must(id);
      e.proc?.kill('SIGHUP');
      e.listeners.clear();
      entries.delete(id);
    },
    disposeAll() {
      for (const e of entries.values()) {
        e.proc?.kill('SIGHUP');
        e.listeners.clear();
      }
      entries.clear();
    },
  };
}
