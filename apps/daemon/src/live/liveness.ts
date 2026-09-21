import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRegistryFile, type RegistryEntry } from '@orc/core';

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Reads ~/.claude/sessions/<pid>.json. The `^\d+\.json$` filter guarantees `<pid>.<hash>.key` files are never opened. */
export function readClaudeRegistry(claudeHome: string): RegistryEntry[] {
  const dir = join(claudeHome, 'sessions');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: RegistryEntry[] = [];
  for (const name of names.sort()) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const entry = parseRegistryFile(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      if (entry) out.push(entry);
    } catch {
      // partial write: the next read will see the complete file
    }
  }
  return out;
}

/**
 * Injectable seam over shelling out to a read-only table/lookup command (`ps`, `lsof`, ...).
 * Never rejects: a non-zero exit or a missing binary is reported as `exitCode !== 0` with
 * whatever `stdout` was captured, never as a thrown/rejected error, so a caller sweeping process
 * tables can treat a failed lookup as "nothing found" rather than an unhandled rejection.
 */
export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;

/** Real `ExecFn` over `node:child_process`. Used in production; tests inject a fake instead. */
export const defaultExec: ExecFn = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (!err) {
        resolve({ stdout, exitCode: 0 });
        return;
      }
      const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
      resolve({ stdout: stdout || '', exitCode: typeof code === 'number' ? code : 1 });
    });
  });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// `ps -axo pid=,ppid=,lstart=,command=` output, e.g.
// "  4242     1 Tue Sep  1 09:00:00 2026 codex --model x". `ppid` is required (not optional in the
// brief's original format) so the npm-shim/native-binary pair can be told apart by the Codex
// detector. Lives here rather than next to that detector because `RegistryEntry.procStart` uses the
// same calendar grammar (in a different timezone — see `parseProcStart`), so both readers share the
// grammar below while deliberately NOT sharing the timezone they resolve it in.
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/;
// The `lstart`/`procStart` calendar grammar on its own: "Mon Sep  1 09:00:00 2026" (the day is
// space-padded to two columns). Deliberately shared by both readers below, while the *timezone*
// each one resolves it in is deliberately NOT shared — see `parseLstart` / `parseProcStart`.
const CLOCK = /^(\w{3})\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/;

interface ClockParts {
  year: number;
  month: number;
  day: number;
  hh: number;
  mm: number;
  ss: number;
}

/** Splits the calendar grammar into numeric parts, with no timezone interpretation at all. */
function clockParts(text: string): ClockParts | null {
  const m = CLOCK.exec(text.trim().replace(/\s+/g, ' '));
  if (!m) return null;
  const [, , monthTok, dayTok, hhTok, mmTok, ssTok, yearTok] = m;
  const month = monthTok === undefined ? -1 : MONTHS.indexOf(monthTok);
  if (month < 0) return null;
  if (
    dayTok === undefined ||
    hhTok === undefined ||
    mmTok === undefined ||
    ssTok === undefined ||
    yearTok === undefined
  ) {
    return null;
  }
  return {
    year: Number(yearTok),
    month,
    day: Number(dayTok),
    hh: Number(hhTok),
    mm: Number(mmTok),
    ss: Number(ssTok),
  };
}

/** Parses one `ps -axo pid=,ppid=,lstart=,command=` line. `lstart` is always in LOCAL time. */
export function parsePsLine(
  line: string,
): { pid: number; ppid: number; startedAtMs: number; command: string } | null {
  const m = PS_LINE.exec(line);
  if (!m) return null;
  const [, pidTok, ppidTok, clockTok, commandTok] = m;
  if (pidTok === undefined || ppidTok === undefined || clockTok === undefined || commandTok === undefined) {
    return null;
  }
  const startedAtMs = parseLstart(clockTok);
  if (startedAtMs === null) return null;
  return {
    pid: Number(pidTok),
    ppid: Number(ppidTok),
    startedAtMs,
    command: commandTok.trim(),
  };
}

/**
 * Epoch millis for a `ps` `lstart` column, resolved in the host's LOCAL timezone — that is what
 * `ps` prints. `new Date(y, m, d, ...)` resolves the wall-clock time using whichever UTC offset
 * was in effect on that date, so a DST boundary between the process start and now is handled by
 * `Date` itself.
 */
export function parseLstart(lstart: string): number | null {
  const p = clockParts(lstart);
  return p === null ? null : new Date(p.year, p.month, p.day, p.hh, p.mm, p.ss).getTime();
}

/**
 * Epoch millis for `RegistryEntry.procStart`, resolved in UTC.
 *
 * **This is deliberately a different function from `parseLstart` even though the two strings look
 * identical.** `procStart` is rendered by Claude Code in UTC; `ps` renders `lstart` in local time.
 * Fix round 1 shipped a single shared parser on the reasoning that "the host timezone cancels out
 * because both sides go through one parser in one process" — that reasoning was wrong, only the
 * `ps` side is local, and the result was that on any host with a non-zero UTC offset EVERY live
 * session compared unequal, reported `ended`, and was then retired off the board entirely.
 *
 * Measured on this host (UTC+3), three independent confirmations:
 *
 * ```
 * pid 38030  procStart "Mon Sep 21 21:30:14 2026"   ps lstart "Tue Sep 22 00:30:14 2026"
 * pid 12621  procStart "Tue Sep 15 06:52:37 2026"   ps lstart "Tue Sep 15 09:52:37 2026"
 * ```
 *
 * ...all six registry files off by exactly the host offset; the sibling `startedAt` epoch-millis
 * field (which carries no timezone ambiguity at all) renders in UTC to within one second of
 * `procStart` for every entry; and the project's own captured spike fixture pairs
 * `startedAt: 1788253200000` (= 2026-09-01T09:00:00Z) with `procStart: "Mon Sep  1 09:00:00 2026"`.
 *
 * A fixture that writes both sides of this comparison cannot falsify it. The regression test for
 * this pins a real observed (procStart, lstart) pair and the real host offset.
 */
export function parseProcStart(procStart: string): number | null {
  const p = clockParts(procStart);
  return p === null ? null : Date.UTC(p.year, p.month, p.day, p.hh, p.mm, p.ss);
}

/**
 * Async liveness with the pid-reuse guard the board depends on.
 *
 * A registry file outlives the process that wrote it — the app never deletes `~/.claude/sessions/
 * <pid>.json`, by design (see the LiveTracker's ended-entry rule). A bare `process.kill(pid, 0)`
 * therefore reports "alive" the moment the OS recycles that pid for some unrelated program, and a
 * long-dead session keeps rendering as live. `procStart` is the discriminator: it is the start
 * time of the process that wrote the file (rendered in UTC), so a pid whose current `ps` start
 * time is a different instant is a different process.
 */
export interface LivenessChecker {
  isAlive(pid: number, procStart?: string | null): Promise<boolean>;
}

export interface LivenessCheckerOptions {
  exec?: ExecFn;
  /** Injectable for tests; production uses the module's own `isPidAlive`. */
  pidAlive?: (pid: number) => boolean;
  now?: () => number;
  /** How long a verified (pid, procStart) verdict is reused before re-running `ps`. */
  cacheMs?: number;
}

/**
 * `procStart` is `string | null` (`RegistryEntry.procStart`). **Null degrades to the bare pid
 * check**, and so does an unparseable `procStart`, an unparseable `ps` line, or a `ps` that fails
 * for a reason other than "no such process". That asymmetry is deliberate: treating "cannot
 * verify" as a mismatch would mean one upstream change to the registry's date format empties the
 * user's entire board, which is far worse than the rare recycled-pid card it would prevent.
 * Only a `procStart` we successfully parsed *and* a `ps` start time we successfully parsed, that
 * disagree, count as dead.
 */
export function createLivenessChecker(opts: LivenessCheckerOptions = {}): LivenessChecker {
  const exec = opts.exec ?? defaultExec;
  const pidAlive = opts.pidAlive ?? isPidAlive;
  const now = opts.now ?? Date.now;
  const cacheMs = opts.cacheMs ?? 2000;
  const cache = new Map<string, { at: number; alive: boolean }>();

  return {
    async isAlive(pid, procStart) {
      // Cheap gate first: a pid nothing holds is dead regardless of start time, and this is the
      // overwhelmingly common answer for a stale registry file. It also means `ps` only ever runs
      // for pids that are actually in use.
      if (!pidAlive(pid)) return false;
      if (procStart === undefined || procStart === null) return true;
      // UTC: `procStart` is written by Claude Code, not by `ps`. See `parseProcStart`.
      const want = parseProcStart(procStart);
      if (want === null) return true; // unrecognised format: degrade, never blank the board

      const key = `${pid}|${procStart}`;
      const t = now();
      const hit = cache.get(key);
      if (hit && t - hit.at < cacheMs) return hit.alive;

      const r = await exec('ps', ['-o', 'pid=,ppid=,lstart=,command=', '-p', String(pid)]);
      let alive: boolean;
      if (r.exitCode !== 0) {
        // `ps -p <pid>` exits non-zero precisely when the pid is gone. It raced the check above.
        alive = false;
      } else {
        const parsed = r.stdout
          .split('\n')
          .map(parsePsLine)
          .find((p): p is NonNullable<typeof p> => p !== null && p.pid === pid);
        // No parsable line for a pid `ps` exited 0 for means the output shape changed, not that
        // the process is gone: degrade to the bare check rather than reporting a false death.
        alive = parsed === undefined ? true : parsed.startedAtMs === want;
      }
      cache.set(key, { at: t, alive });
      return alive;
    },
  };
}

/** Phase 2 adds the procStart check against pid reuse. */
export function findRegistryEntry(
  claudeHome: string,
  sessionId: string,
  alive: (pid: number) => boolean,
): (RegistryEntry & { alive: boolean }) | null {
  const matches = readClaudeRegistry(claudeHome)
    .filter((e) => e.sessionId === sessionId)
    .map((e) => ({ ...e, alive: alive(e.pid) }));
  return matches.find((m) => m.alive) ?? matches[0] ?? null;
}
