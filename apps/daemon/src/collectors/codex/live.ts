import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseCodexEnvelope } from '@orc/core';
import { defaultExec, type ExecFn } from '../../live/liveness.ts';

export interface CodexLiveProc {
  pid: number;
  cwd: string;
  startedAtMs: number;
  rolloutPath: string | null;
  sessionId: string | null;
  originator: string | null;
  lastWriteMs: number | null;
}

export interface CodexLiveDetector {
  scan(): Promise<CodexLiveProc[]>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// `ps -axo pid=,lstart=,command=` output, e.g. "  4242 Tue Sep  1 09:00:00 2026 codex --model x".
const PS_LINE = /^\s*(\d+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.+)$/;

/** Parses one `ps -axo pid=,lstart=,command=` line. `lstart` is always in local time. */
export function parsePsLine(line: string): { pid: number; startedAtMs: number; command: string } | null {
  const m = PS_LINE.exec(line);
  if (!m) return null;
  const monthTok = m[2];
  const month = monthTok === undefined ? -1 : MONTHS.indexOf(monthTok);
  if (month < 0) return null;
  const pidTok = m[1];
  const dayTok = m[3];
  const hhTok = m[4];
  const mmTok = m[5];
  const ssTok = m[6];
  const yearTok = m[7];
  const commandTok = m[8];
  if (
    pidTok === undefined ||
    dayTok === undefined ||
    hhTok === undefined ||
    mmTok === undefined ||
    ssTok === undefined ||
    yearTok === undefined ||
    commandTok === undefined
  ) {
    return null;
  }
  const started = new Date(
    Number(yearTok),
    month,
    Number(dayTok),
    Number(hhTok),
    Number(mmTok),
    Number(ssTok),
  );
  return { pid: Number(pidTok), startedAtMs: started.getTime(), command: commandTok.trim() };
}

// Codex subcommands that never write a session rollout, so a process running one is never a
// live "session" worth surfacing on the board.
const NON_SESSION_SUBCOMMANDS = new Set(['app-server', 'mcp-server', 'mcp', 'login', 'logout', 'completion']);

/** True when `command` (the `ps` command column) is a `codex` invocation that owns a session. */
export function isCodexCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const firstTok = tokens[0] ?? '';
  let i = 0;
  if (basename(firstTok) === 'node' || basename(firstTok) === 'bun') i = 1;
  const exe = basename(tokens[i] ?? '');
  if (exe !== 'codex' && exe !== 'codex.js') return false;
  const sub = tokens[i + 1] ?? '';
  return !NON_SESSION_SUBCOMMANDS.has(sub);
}

const pad = (n: number) => String(n).padStart(2, '0');

const unescapeJsonString = (s: string): string => {
  try {
    const parsed: unknown = JSON.parse(`"${s}"`);
    return typeof parsed === 'string' ? parsed : s;
  } catch {
    return s;
  }
};

/** Regex fallback for a `session_meta` first line too large to `JSON.parse` after the read cap. */
function extractField(text: string, name: string): string | null {
  const m = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  const raw = m?.[1];
  return raw === undefined ? null : unescapeJsonString(raw);
}

const ROLLOUT_META_READ_CAP = 1 << 20; // 1 MB: base_instructions can be enormous.

async function readFirstLineCapped(path: string): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(ROLLOUT_META_READ_CAP);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(0, nl) : text;
  } finally {
    await fh.close();
  }
}

/**
 * Reads only the first line of a rollout (a `session_meta` envelope), capped at 1 MB, since
 * `base_instructions` in the payload can be arbitrarily large. Never reads past that line, and
 * never reads any file that isn't `sessions/**\/rollout-*.jsonl`.
 */
export async function readRolloutMeta(
  path: string,
): Promise<{ id: string | null; cwd: string | null; originator: string | null; startedAtMs: number | null }> {
  const line = await readFirstLineCapped(path);
  try {
    const envelope = parseCodexEnvelope(JSON.parse(line));
    if (envelope) {
      const { id, cwd, originator } = envelope.payload;
      const startedAtMs = Date.parse(envelope.timestamp);
      return {
        id: typeof id === 'string' ? id : null,
        cwd: typeof cwd === 'string' ? cwd : null,
        originator: typeof originator === 'string' ? originator : null,
        startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
      };
    }
  } catch {
    // fall through: the line was truncated by the read cap and isn't valid JSON
  }
  const ts = extractField(line, 'timestamp');
  const startedAtMs = ts === null ? null : Date.parse(ts);
  return {
    id: extractField(line, 'id'),
    cwd: extractField(line, 'cwd'),
    originator: extractField(line, 'originator'),
    startedAtMs: startedAtMs === null || Number.isFinite(startedAtMs) ? startedAtMs : null,
  };
}

interface RolloutCandidate {
  path: string;
  mtimeMs: number;
  id: string | null;
  cwd: string | null;
  originator: string | null;
  startedAtMs: number | null;
}

export function createCodexLiveDetector(opts: {
  codexHome: string;
  exec?: ExecFn;
  now?: () => number;
  lookbackDays?: number;
}): CodexLiveDetector {
  const exec = opts.exec ?? defaultExec;
  const now = opts.now ?? Date.now;
  const lookbackDays = opts.lookbackDays ?? 2;

  // Session start and directory-of-day can land on different sides of midnight depending on
  // whether the machine's local clock or UTC is used, so both are searched for every lookback day.
  function dateDirs(): string[] {
    const dirs = new Set<string>();
    for (let back = 0; back <= lookbackDays; back++) {
      const t = new Date(now() - back * 86_400_000);
      dirs.add(
        join(opts.codexHome, 'sessions', String(t.getFullYear()), pad(t.getMonth() + 1), pad(t.getDate())),
      );
      dirs.add(
        join(
          opts.codexHome,
          'sessions',
          String(t.getUTCFullYear()),
          pad(t.getUTCMonth() + 1),
          pad(t.getUTCDate()),
        ),
      );
    }
    return [...dirs];
  }

  async function candidateRollouts(): Promise<RolloutCandidate[]> {
    const out: RolloutCandidate[] = [];
    for (const dir of dateDirs()) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue; // no sessions that day (or that date-dir variant doesn't exist) — not an error
      }
      for (const name of names) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        const path = join(dir, name);
        try {
          const st = await stat(path);
          const meta = await readRolloutMeta(path);
          out.push({ path, mtimeMs: st.mtimeMs, ...meta });
        } catch {
          // vanished, or an unreadable/malformed first line — never fatal to the sweep
        }
      }
    }
    return out;
  }

  async function cwdOfPid(pid: number): Promise<string | null> {
    const r = await exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    if (r.exitCode !== 0) return null;
    const nLine = r.stdout.split('\n').find((l) => l.startsWith('n'));
    return nLine ? nLine.slice(1) : null;
  }

  return {
    async scan() {
      const ps = await exec('ps', ['-axo', 'pid=,lstart=,command=']);
      const procs = ps.stdout
        .split('\n')
        .map(parsePsLine)
        .filter((p): p is { pid: number; startedAtMs: number; command: string } => p !== null)
        .filter((p) => isCodexCommand(p.command))
        .sort((a, b) => a.startedAtMs - b.startedAtMs || a.pid - b.pid);
      if (procs.length === 0) return [];

      const rollouts = await candidateRollouts();
      const claimed = new Set<string>();
      const out: CodexLiveProc[] = [];

      for (const p of procs) {
        const cwd = await cwdOfPid(p.pid);
        if (!cwd) continue; // lsof failed or the process has already exited

        const inCwd = rollouts.filter(
          (r) => r.cwd === cwd && r.mtimeMs >= p.startedAtMs - 2000 && !claimed.has(r.path),
        );
        // Prefer a rollout started close to (and no more than 5s before) the process's own
        // start — that's a brand-new session. `codex resume` instead appends to an old rollout,
        // so fall back to the most recently written candidate.
        const fresh = inCwd
          .filter((r) => r.startedAtMs !== null && r.startedAtMs >= p.startedAtMs - 5000)
          .sort(
            (a, b) =>
              Math.abs((a.startedAtMs ?? 0) - p.startedAtMs) - Math.abs((b.startedAtMs ?? 0) - p.startedAtMs),
          );
        const newest = [...inCwd].sort((a, b) => b.mtimeMs - a.mtimeMs);
        const pick = fresh[0] ?? newest[0] ?? null;
        if (pick) claimed.add(pick.path); // a rollout is claimed by at most one process

        out.push({
          pid: p.pid,
          cwd,
          startedAtMs: p.startedAtMs,
          rolloutPath: pick?.path ?? null,
          sessionId: pick?.id ?? null,
          originator: pick?.originator ?? null,
          lastWriteMs: pick?.mtimeMs ?? null,
        });
      }
      return out;
    },
  };
}
