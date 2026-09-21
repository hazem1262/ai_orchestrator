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
// `ps -axo pid=,ppid=,lstart=,command=` output, e.g.
// "  4242     1 Tue Sep  1 09:00:00 2026 codex --model x". `ppid` is required (not optional in the
// brief's original format) so the npm-shim/native-binary pair can be told apart below.
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.+)$/;

/** Parses one `ps -axo pid=,ppid=,lstart=,command=` line. `lstart` is always in local time. */
export function parsePsLine(
  line: string,
): { pid: number; ppid: number; startedAtMs: number; command: string } | null {
  const m = PS_LINE.exec(line);
  if (!m) return null;
  const monthTok = m[3];
  const month = monthTok === undefined ? -1 : MONTHS.indexOf(monthTok);
  if (month < 0) return null;
  const pidTok = m[1];
  const ppidTok = m[2];
  const dayTok = m[4];
  const hhTok = m[5];
  const mmTok = m[6];
  const ssTok = m[7];
  const yearTok = m[8];
  const commandTok = m[9];
  if (
    pidTok === undefined ||
    ppidTok === undefined ||
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
  return {
    pid: Number(pidTok),
    ppid: Number(ppidTok),
    startedAtMs: started.getTime(),
    command: commandTok.trim(),
  };
}

// Codex subcommands that never write a session rollout, so a process running one is never a
// live "session" worth surfacing on the board.
const NON_SESSION_SUBCOMMANDS = new Set(['app-server', 'mcp-server', 'mcp', 'login', 'logout', 'completion']);

// Every subcommand name we know about, session-owning or not. Used as defense #2 below: a token
// that names a known subcommand is never consumed as some earlier flag's value, regardless of
// whether that flag is on the value-less allow-list.
const KNOWN_SUBCOMMANDS = new Set([...NON_SESSION_SUBCOMMANDS, 'exec', 'resume']);

// Real global flags on the installed `codex` binary that take no value. Without this, the
// generic "a `-`-flag with no `=` consumes the next token" rule swallows the subcommand right
// after it (`codex --yolo app-server` would misread `app-server` as `--yolo`'s value instead of
// the subcommand). This is defense #1: cheap, but it rots the moment upstream adds a new
// value-less flag we don't know about — defense #2 (KNOWN_SUBCOMMANDS, below) is what survives
// that.
const VALUE_LESS_FLAGS = new Set([
  '--yolo',
  '--search',
  '--full-auto',
  '--dangerously-bypass-approvals-and-sandbox',
  '-h',
  '--help',
  '-V',
  '--version',
]);

/**
 * True when `command` (the `ps` command column) is a `codex` invocation that owns a session.
 * Global options between the executable and the subcommand (`--cd DIR`, `-c key=val`, `--yolo`,
 * ...) are skipped so `codex --cd /tmp mcp-server` and `codex --yolo app-server` are both still
 * correctly recognized as their non-session subcommand, not misread as a session because a flag
 * ate the subcommand token. `codex -- mcp-server` is a session: `--` ends option parsing, so
 * nothing after it is ever read as a subcommand.
 */
export function isCodexCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const firstTok = tokens[0] ?? '';
  let i = 0;
  if (basename(firstTok) === 'node' || basename(firstTok) === 'bun') i = 1;
  const exe = basename(tokens[i] ?? '');
  if (exe !== 'codex' && exe !== 'codex.js') return false;

  // Skip leading `-`-prefixed global options. A flag with no `=` in its own token is assumed to
  // take the following token as its value (e.g. `--cd /tmp`, `-c model=x`) *unless* that
  // following token is itself another flag, a known subcommand name, or the flag is on the
  // value-less allow-list; a flag containing `=` (e.g. `--model=gpt-5.5`) is always self-contained.
  let j = i + 1;
  let terminated = false;
  for (;;) {
    const tok = tokens[j];
    if (tok === undefined) break;
    if (tok === '--') {
      terminated = true;
      j += 1;
      break;
    }
    if (!tok.startsWith('-')) break;
    if (tok.includes('=')) {
      j += 1;
      continue;
    }
    if (VALUE_LESS_FLAGS.has(tok)) {
      j += 1;
      continue;
    }
    const next = tokens[j + 1];
    const nextConsumable = next !== undefined && !next.startsWith('-') && !KNOWN_SUBCOMMANDS.has(next);
    j += nextConsumable ? 2 : 1;
  }
  const sub = terminated ? '' : (tokens[j] ?? '');
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

// `payload.timestamp` (when present) is when the session actually started; the envelope's own
// outer `timestamp` is when this line was *flushed to disk*, which on a real machine trails the
// payload's own timestamp by tens of seconds — enough to push a legitimately-fresh session out of
// the detector's fresh-rollout window. `payload` is nested inside the envelope, so the envelope's
// own `timestamp` key (which appears earlier in the line) is never mistaken for it.
function payloadSlice(text: string): string {
  const idx = text.indexOf('"payload"');
  return idx >= 0 ? text.slice(idx) : text;
}

// A rollout's first line is read at 64 KB first (real first lines on a dev machine top out
// around 49 KB) and only grown to the 1 MB cap when no newline is found in that first read —
// `base_instructions` can be enormous, but paying a 1 MB allocation on every rollout on every
// sweep is unnecessary for the overwhelming majority of files.
const FIRST_READ_BYTES = 64 * 1024;
const ROLLOUT_META_READ_CAP = 1 << 20; // 1 MB

async function readChunk(fh: import('node:fs/promises').FileHandle, size: number): Promise<string> {
  const buf = Buffer.alloc(size);
  const { bytesRead } = await fh.read(buf, 0, size, 0);
  return buf.subarray(0, bytesRead).toString('utf8');
}

async function readFirstLineCapped(path: string): Promise<string> {
  const fh = await open(path, 'r');
  try {
    let text = await readChunk(fh, FIRST_READ_BYTES);
    let nl = text.indexOf('\n');
    if (nl < 0 && FIRST_READ_BYTES < ROLLOUT_META_READ_CAP) {
      text = await readChunk(fh, ROLLOUT_META_READ_CAP);
      nl = text.indexOf('\n');
    }
    return nl >= 0 ? text.slice(0, nl) : text;
  } finally {
    await fh.close();
  }
}

type RolloutMeta = {
  id: string | null;
  cwd: string | null;
  originator: string | null;
  startedAtMs: number | null;
};
const NO_META: RolloutMeta = { id: null, cwd: null, originator: null, startedAtMs: null };

/**
 * Reads only the first line of a rollout, capped at 1 MB, since `base_instructions` in the
 * payload can be arbitrarily large. Never reads past that line, and never reads any file that
 * isn't `sessions/**\/rollout-*.jsonl`. Only a `session_meta` first line is trusted — a rollout
 * that (unusually) doesn't start with one yields no metadata rather than misreading an unrelated
 * envelope's fields.
 */
export async function readRolloutMeta(path: string): Promise<RolloutMeta> {
  const line = await readFirstLineCapped(path);
  try {
    const envelope = parseCodexEnvelope(JSON.parse(line));
    if (envelope) {
      if (envelope.type !== 'session_meta') return NO_META;
      const { id, cwd, originator, timestamp: payloadTimestamp } = envelope.payload;
      const ts = typeof payloadTimestamp === 'string' ? payloadTimestamp : envelope.timestamp;
      const startedAtMs = Date.parse(ts);
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
  if (extractField(line, 'type') !== 'session_meta') return NO_META;
  const payloadText = payloadSlice(line);
  const ts = extractField(payloadText, 'timestamp') ?? extractField(line, 'timestamp');
  const startedAtMs = ts === null ? null : Date.parse(ts);
  return {
    id: extractField(payloadText, 'id'),
    cwd: extractField(payloadText, 'cwd'),
    originator: extractField(payloadText, 'originator'),
    startedAtMs: startedAtMs === null || Number.isFinite(startedAtMs) ? startedAtMs : null,
  };
}

interface RolloutCandidate extends RolloutMeta {
  path: string;
  mtimeMs: number;
}

interface ParsedProc {
  pid: number;
  ppid: number;
  startedAtMs: number;
  command: string;
}

interface Binding {
  rolloutPath: string;
  sessionId: string | null;
  originator: string | null;
}

/**
 * Among a set of processes that all pass `isCodexCommand`, drop any process that is the parent
 * of another matched process (e.g. the `node` shim that `npm install -g @openai/codex` puts on
 * `PATH`, which execs the vendored native binary as a child) and keep only the deepest
 * descendants — the process actually holding the fd open on the rollout file.
 */
function dedupeParents(procs: ParsedProc[]): ParsedProc[] {
  const pids = new Set(procs.map((p) => p.pid));
  const hasMatchedChild = new Set(procs.filter((p) => pids.has(p.ppid)).map((p) => p.ppid));
  return procs.filter((p) => !hasMatchedChild.has(p.pid));
}

type DayKey = readonly [year: number, month: number, day: number];

export const localDayKey = (d: Date): DayKey => [d.getFullYear(), d.getMonth() + 1, d.getDate()];
export const localDayStart = (y: number, m: number, d: number): Date => new Date(y, m - 1, d);
const utcDayKey = (d: Date): DayKey => [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
const utcDayStart = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));

/**
 * Calendar days covering `[fromMs, toMs]` inclusive, in whichever order given, stepped one
 * *calendar date* at a time rather than by a fixed 86_400_000 ms — a DST transition changes how
 * many real milliseconds are in a day, so fixed-ms stepping can drift past (and entirely skip) an
 * interior day over a long enough range. Constructing the next day via `make(y, m, d + 1)` lets
 * `Date` itself normalize month/year rollover and any DST offset change, so no day is ever
 * skipped or double-counted regardless of the host's timezone.
 */
export function calendarDaysBetween(
  fromMs: number,
  toMs: number,
  key: (d: Date) => DayKey,
  make: (y: number, m: number, d: number) => Date,
): DayKey[] {
  const start = Math.min(fromMs, toMs);
  const end = Math.max(fromMs, toMs);
  const endDayMs = make(...key(new Date(end))).getTime();
  const out: DayKey[] = [];
  let cursor = make(...key(new Date(start)));
  let guard = 0;
  const GUARD_MAX = 3700; // sanity cap (~10 years), guards against bogus/garbage timestamps
  while (cursor.getTime() <= endDayMs && guard < GUARD_MAX) {
    const [y, m, d] = key(cursor);
    out.push([y, m, d]);
    cursor = make(y, m, d + 1);
    guard += 1;
  }
  return out;
}

export function createCodexLiveDetector(opts: {
  codexHome: string;
  exec?: ExecFn;
  now?: () => number;
  lookbackDays?: number;
  log?: { debug?(o: object, msg?: string): void; warn?(o: object, msg?: string): void };
}): CodexLiveDetector {
  const exec = opts.exec ?? defaultExec;
  const now = opts.now ?? Date.now;
  const lookbackDays = opts.lookbackDays ?? 2;

  // (path, mtimeMs) -> parsed meta. A rollout's content is immutable except by being appended
  // to, so an unchanged mtime means the previously parsed meta is still correct.
  const metaCache = new Map<string, { mtimeMs: number; meta: RolloutMeta }>();
  // (pid, startedAtMs) -> the rollout this process was bound to. A process's rollout doesn't
  // change identity over its lifetime, so once bound, later scans skip the directory search
  // entirely and just re-`stat` the one known path.
  const bindings = new Map<string, Binding>();
  const bindingKey = (pid: number, startedAtMs: number) => `${pid}:${startedAtMs}`;

  async function metaFor(path: string, mtimeMs: number): Promise<RolloutMeta> {
    const cached = metaCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) return cached.meta;
    const meta = await readRolloutMeta(path);
    metaCache.set(path, { mtimeMs, meta });
    return meta;
  }

  function dateDirs(startMs: number, endMs: number): string[] {
    const dirs = new Set<string>();
    for (const [y, m, d] of calendarDaysBetween(startMs, endMs, localDayKey, localDayStart)) {
      dirs.add(join(opts.codexHome, 'sessions', String(y), pad(m), pad(d)));
    }
    for (const [y, m, d] of calendarDaysBetween(startMs, endMs, utcDayKey, utcDayStart)) {
      dirs.add(join(opts.codexHome, 'sessions', String(y), pad(m), pad(d)));
    }
    return [...dirs];
  }

  // `startMs` is omitted only when there's no process to anchor the search on (scan() never
  // does this today, since it never searches with zero matched processes) — `lookbackDays`
  // remains the floor for that case so the function stays meaningful on its own.
  async function candidateRollouts(startMs?: number, endMs?: number): Promise<RolloutCandidate[]> {
    const end = endMs ?? now();
    const start = startMs ?? end - lookbackDays * 86_400_000;
    const out: RolloutCandidate[] = [];
    for (const dir of dateDirs(start, end)) {
      let names: string[];
      try {
        names = (await readdir(dir)).sort();
      } catch {
        continue; // no sessions that day (or that date-dir variant doesn't exist) — not an error
      }
      for (const name of names) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        const path = join(dir, name);
        try {
          const st = await stat(path);
          const mtimeMs = Math.floor(st.mtimeMs); // mtime_ms is an integer column downstream
          const meta = await metaFor(path, mtimeMs);
          out.push({ path, mtimeMs, ...meta });
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
      const ps = await exec('ps', ['-axo', 'pid=,ppid=,lstart=,command=']);
      if (ps.exitCode !== 0) {
        opts.log?.warn?.({ exitCode: ps.exitCode }, 'ps failed; treating this sweep as no codex processes');
        return [];
      }
      const allProcs = ps.stdout
        .split('\n')
        .map(parsePsLine)
        .filter((p): p is ParsedProc => p !== null)
        .filter((p) => p.pid !== process.pid)
        .filter((p) => isCodexCommand(p.command));
      const procs = dedupeParents(allProcs).sort((a, b) => a.startedAtMs - b.startedAtMs || a.pid - b.pid);
      if (procs.length === 0) return [];

      // Forget bindings for (pid, startedAtMs) pairs that are no longer running. Evicting by the
      // full key (not just the bare pid) matters when a pid is recycled by the OS: a new process
      // reusing pid 100 has a different startedAtMs, so its own key is absent from `liveKeys` and
      // its binding correctly starts unbound, while the *old* 100:<oldStart> entry — which would
      // otherwise survive forever, permanently holding its rollout in `claimed` and denying it to
      // the new process — is evicted here. The same key mismatch (and same fix) also covers a
      // host TZ/DST offset changing between scans, since `startedAtMs` is computed in local time.
      const liveKeys = new Set(procs.map((p) => bindingKey(p.pid, p.startedAtMs)));
      for (const key of [...bindings.keys()]) {
        if (!liveKeys.has(key)) bindings.delete(key);
      }

      // cwd is required output for every process every scan (and is what a *new* binding search
      // matches against), so it's resolved once per pid up front — unlike the rollout search,
      // this isn't something the per-pid binding cache is meant to skip.
      const cwds = new Map<number, string | null>();
      for (const p of procs) cwds.set(p.pid, await cwdOfPid(p.pid));

      const claimed = new Set([...bindings.values()].map((b) => b.rolloutPath));
      const unbound = procs.filter((p) => !bindings.has(bindingKey(p.pid, p.startedAtMs)));

      if (unbound.length > 0) {
        const startMs = Math.min(...unbound.map((p) => p.startedAtMs));
        const rollouts = await candidateRollouts(startMs, now());
        for (const p of unbound) {
          const cwd = cwds.get(p.pid) ?? null;
          if (cwd === null) continue; // lsof failed or the process has already exited

          const inCwd = rollouts.filter(
            (r) => r.cwd === cwd && r.mtimeMs >= p.startedAtMs - 2000 && !claimed.has(r.path),
          );
          // Prefer a rollout started close to the process's own start — that's a brand-new
          // session. Bounded above so a rollout minutes/hours later never masquerades as "this
          // process's session" (it can't be: it wasn't written by this process). Outside the
          // window, fall back to the newest-mtime rule, which also covers `codex resume`
          // appending to an old rollout and a long-lived process starting a new session mid-life.
          const fresh = inCwd
            .filter(
              (r) =>
                r.startedAtMs !== null &&
                r.startedAtMs >= p.startedAtMs - 5000 &&
                r.startedAtMs <= p.startedAtMs + 60_000,
            )
            .sort(
              (a, b) =>
                Math.abs((a.startedAtMs ?? 0) - p.startedAtMs) -
                Math.abs((b.startedAtMs ?? 0) - p.startedAtMs),
            );
          const newest = [...inCwd].sort((a, b) => b.mtimeMs - a.mtimeMs);
          const pick = fresh[0] ?? newest[0] ?? null;
          if (pick) {
            claimed.add(pick.path); // a rollout is claimed by at most one process
            bindings.set(bindingKey(p.pid, p.startedAtMs), {
              rolloutPath: pick.path,
              sessionId: pick.id,
              originator: pick.originator,
            });
          }
        }
      }

      const out: CodexLiveProc[] = [];
      for (const p of procs) {
        const cwd = cwds.get(p.pid) ?? null;
        if (cwd === null) continue;

        const key = bindingKey(p.pid, p.startedAtMs);
        const binding = bindings.get(key);
        if (!binding) {
          out.push({
            pid: p.pid,
            cwd,
            startedAtMs: p.startedAtMs,
            rolloutPath: null,
            sessionId: null,
            originator: null,
            lastWriteMs: null,
          });
          continue;
        }
        let lastWriteMs: number;
        try {
          lastWriteMs = Math.floor((await stat(binding.rolloutPath)).mtimeMs);
        } catch {
          // the rollout vanished between binding and this scan; drop the binding and report the
          // process as currently unresolved rather than surfacing a stale path
          bindings.delete(key);
          out.push({
            pid: p.pid,
            cwd,
            startedAtMs: p.startedAtMs,
            rolloutPath: null,
            sessionId: null,
            originator: null,
            lastWriteMs: null,
          });
          continue;
        }
        // A binding made while the rollout's first line was still being written can cache a null
        // sessionId/originator forever, since a bound path is normally never re-read. Before the
        // binding cache existed this self-healed automatically (meta was re-read every sweep), so
        // targeted re-reads here (only when something is still missing, reusing metaFor's own
        // mtime-keyed cache) restore that self-healing without giving up the cache's benefit for
        // the normal, fully-written case.
        let sessionId = binding.sessionId;
        let originator = binding.originator;
        if (sessionId === null || originator === null) {
          const meta = await metaFor(binding.rolloutPath, lastWriteMs);
          sessionId = meta.id;
          originator = meta.originator;
          bindings.set(key, { rolloutPath: binding.rolloutPath, sessionId, originator });
        }
        out.push({
          pid: p.pid,
          cwd,
          startedAtMs: p.startedAtMs,
          rolloutPath: binding.rolloutPath,
          sessionId,
          originator,
          lastWriteMs,
        });
      }
      return out;
    },
  };
}
