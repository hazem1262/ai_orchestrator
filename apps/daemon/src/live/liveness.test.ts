import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { useTempHomes } from '../../test/helpers.ts';
import {
  createLivenessChecker,
  defaultExec,
  type ExecFn,
  findRegistryEntry,
  isPidAlive,
  parseLstart,
  parseProcStart,
  readClaudeRegistry,
} from './liveness.ts';

describe('liveness', () => {
  const homes = useTempHomes();

  it('checks pids', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false);
  });

  it('reads registry files and ignores keys and partial writes', () => {
    const dir = join(homes.claudeHome, 'sessions');
    writeFileSync(join(dir, '41001.abcdef.key'), 'SECRET');
    writeFileSync(join(dir, '41002.json'), '{"pid":41002,"sessionId":"s-dr');
    const entries = readClaudeRegistry(homes.claudeHome);
    expect(entries.map((e) => e.pid)).toEqual([41001]);
    expect(JSON.stringify(entries)).not.toContain('SECRET');
    expect(readClaudeRegistry(join(homes.root, 'missing'))).toEqual([]);
  });

  it('finds a session entry and reports liveness', () => {
    expect(findRegistryEntry(homes.claudeHome, 's-basic', () => true)).toMatchObject({
      pid: 41001,
      alive: true,
    });
    expect(findRegistryEntry(homes.claudeHome, 's-basic', () => false)).toMatchObject({
      pid: 41001,
      alive: false,
    });
    expect(findRegistryEntry(homes.claudeHome, 's-drift', () => true)).toBeNull();
  });
});

describe('defaultExec', () => {
  it('runs a harmless command and captures stdout', async () => {
    const r = await defaultExec('echo', ['hello']);
    expect(r).toEqual({ stdout: 'hello\n', exitCode: 0 });
  });

  it('reports a non-zero exit instead of rejecting', async () => {
    const r = await defaultExec('sh', ['-c', 'exit 3']);
    expect(r.exitCode).toBe(3);
  });

  it('reports a missing binary instead of rejecting', async () => {
    const r = await defaultExec('orc-definitely-not-a-real-binary', []);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe('');
  });
});

/**
 * Runs `fn` with the process timezone pinned, so a TZ-sensitive assertion means the same thing on
 * a UTC CI runner as on a developer laptop. Node re-reads `process.env.TZ` on assignment, and the
 * previous value is restored even when `fn` throws. (Same idiom as `collectors/codex/live.test.ts`.)
 */
const withTZ = async <T>(tz: string, fn: () => Promise<T> | T): Promise<T> => {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
};

/**
 * Real `(procStart, ps lstart)` pairs captured on 2026-09-22 from this machine's own
 * `~/.claude/sessions/<pid>.json` and `ps -o lstart= -p <pid>`, on a host at UTC+3. They are
 * written down verbatim, from two different producers, precisely so that this file cannot supply
 * both sides of the comparison from one constant — which is what made the previous version of
 * these tests pass under every timezone while the real board showed every session as dead.
 *
 * The first pair crosses both midnight and the calendar date, so a "same wall clock, different
 * zone" bug cannot hide in it.
 */
const REAL_PAIRS_UTC_PLUS_3 = [
  { pid: 38030, procStart: 'Mon Sep 21 21:30:14 2026', lstart: 'Tue Sep 22 00:30:14 2026' },
  { pid: 12621, procStart: 'Tue Sep 15 06:52:37 2026', lstart: 'Tue Sep 15 09:52:37 2026' },
] as const;

describe('parseLstart / parseProcStart', () => {
  it('reads a `ps` lstart column in local time', async () => {
    await withTZ('UTC', () => {
      expect(parseLstart('Mon Sep  1 09:00:00 2026')).toBe(Date.UTC(2026, 8, 1, 9, 0, 0));
    });
    await withTZ('Asia/Riyadh', () => {
      // UTC+3 year-round: 09:00 local is 06:00Z.
      expect(parseLstart('Mon Sep  1 09:00:00 2026')).toBe(Date.UTC(2026, 8, 1, 6, 0, 0));
    });
  });

  it('reads a registry procStart in UTC regardless of the host timezone', async () => {
    for (const tz of ['UTC', 'Asia/Riyadh', 'America/New_York']) {
      await withTZ(tz, () => {
        expect(parseProcStart('Mon Sep  1 09:00:00 2026')).toBe(Date.UTC(2026, 8, 1, 9, 0, 0));
      });
    }
  });

  it('resolves a real procStart/lstart pair to the same instant on its own host', async () => {
    await withTZ('Asia/Riyadh', () => {
      for (const r of REAL_PAIRS_UTC_PLUS_3) {
        expect(parseProcStart(r.procStart)).toBe(parseLstart(r.lstart));
      }
    });
  });

  it('handles the double-space day padding and rejects non-clock input', () => {
    expect(parseProcStart('Tue Sep 15 23:59:59 2026')).toBe(Date.UTC(2026, 8, 15, 23, 59, 59));
    expect(parseProcStart('Mon Sep  1 09:00:00 2026')).toBe(Date.UTC(2026, 8, 1, 9, 0, 0));
    for (const bad of ['', '2026-09-01T09:00:00Z', 'Mon Zzz  1 09:00:00 2026']) {
      expect(parseProcStart(bad)).toBeNull();
      expect(parseLstart(bad)).toBeNull();
    }
  });
});

describe('createLivenessChecker', () => {
  const psLine = (pid: number, lstart: string) => `  ${pid}     1 ${lstart} claude\n`;
  const execFor = (lstart: string | null): { exec: ExecFn; calls: string[][] } => {
    const calls: string[][] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args]);
      const pid = Number(args[args.length - 1]);
      return lstart === null ? { stdout: '', exitCode: 1 } : { stdout: psLine(pid, lstart), exitCode: 0 };
    };
    return { exec, calls };
  };
  // Hand-paired, never derived from each other: 09:00Z written by Claude Code, 12:00 local as
  // `ps` would print it on a UTC+3 host.
  const PROC_START = 'Mon Sep  1 09:00:00 2026';
  const PS_LSTART_PLUS_3 = 'Mon Sep  1 12:00:00 2026';
  const PS_LSTART_OTHER_PROCESS = 'Tue Sep  2 11:22:33 2026';

  it('keeps every real running session alive on a UTC+3 host', async () => {
    // The regression test for fix round 1: with one shared local-time parser, all six of this
    // machine's genuinely-running sessions compared unequal and the whole board went `ended`.
    await withTZ('Asia/Riyadh', async () => {
      for (const r of REAL_PAIRS_UTC_PLUS_3) {
        const { exec } = execFor(r.lstart);
        const c = createLivenessChecker({ exec, pidAlive: () => true });
        expect(await c.isAlive(r.pid, r.procStart)).toBe(true);
      }
    });
  });

  it('keeps a real running session alive on a DST host at a negative offset', async () => {
    // 2026-09-21T21:30:14Z is 17:30:14 EDT (UTC-4) the same day.
    await withTZ('America/New_York', async () => {
      const { exec } = execFor('Mon Sep 21 17:30:14 2026');
      const c = createLivenessChecker({ exec, pidAlive: () => true });
      expect(await c.isAlive(38030, 'Mon Sep 21 21:30:14 2026')).toBe(true);
    });
  });

  it('rejects a `ps` start time that could not have come from this host', async () => {
    // The same real UTC+3 pair, replayed on a UTC host: 00:30 local there is not 21:30Z, so this
    // is a different process wearing a recycled pid. The guard must still bite after the fix.
    await withTZ('UTC', async () => {
      const { exec } = execFor('Tue Sep 22 00:30:14 2026');
      const c = createLivenessChecker({ exec, pidAlive: () => true });
      expect(await c.isAlive(38030, 'Mon Sep 21 21:30:14 2026')).toBe(false);
    });
  });

  it('accepts a pid whose start time matches procStart', async () => {
    await withTZ('Asia/Riyadh', async () => {
      const { exec, calls } = execFor(PS_LSTART_PLUS_3);
      const c = createLivenessChecker({ exec, pidAlive: () => true });
      expect(await c.isAlive(41001, PROC_START)).toBe(true);
      expect(calls).toEqual([['ps', '-o', 'pid=,ppid=,lstart=,command=', '-p', '41001']]);
    });
  });

  it('rejects a recycled pid whose start time does not match procStart', async () => {
    // The whole point of the second argument: the registry file outlives its process, so an
    // unrelated program that inherits the pid must not keep a dead session on the board.
    await withTZ('Asia/Riyadh', async () => {
      const { exec } = execFor(PS_LSTART_OTHER_PROCESS);
      const c = createLivenessChecker({ exec, pidAlive: () => true });
      expect(await c.isAlive(41001, PROC_START)).toBe(false);
    });
  });

  it('degrades to the bare pid check when procStart is null', async () => {
    const { exec, calls } = execFor(PS_LSTART_OTHER_PROCESS);
    const c = createLivenessChecker({ exec, pidAlive: () => true });
    expect(await c.isAlive(41001, null)).toBe(true);
    expect(await c.isAlive(41001)).toBe(true);
    expect(calls).toEqual([]); // no `ps` at all: there is nothing to compare against
  });

  it('degrades to the bare pid check when procStart is in an unrecognised format', async () => {
    const { exec, calls } = execFor(PS_LSTART_OTHER_PROCESS);
    const c = createLivenessChecker({ exec, pidAlive: () => true });
    expect(await c.isAlive(41001, '2026-09-01T09:00:00Z')).toBe(true);
    expect(calls).toEqual([]);
  });

  it('degrades to the bare pid check when `ps` succeeds but its output does not parse', async () => {
    const exec: ExecFn = async () => ({ stdout: 'PID  STARTED\nnot a ps line\n', exitCode: 0 });
    const c = createLivenessChecker({ exec, pidAlive: () => true });
    expect(await c.isAlive(41001, PROC_START)).toBe(true);
  });

  it('reports a dead pid without running `ps`', async () => {
    const { exec, calls } = execFor(PS_LSTART_PLUS_3);
    const c = createLivenessChecker({ exec, pidAlive: () => false });
    expect(await c.isAlive(41001, PROC_START)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('treats a non-zero `ps` exit as dead', async () => {
    const { exec } = execFor(null);
    const c = createLivenessChecker({ exec, pidAlive: () => true });
    expect(await c.isAlive(41001, PROC_START)).toBe(false);
  });

  it('caches a verdict for cacheMs and re-runs `ps` once it expires', async () => {
    await withTZ('Asia/Riyadh', async () => {
      const { exec, calls } = execFor(PS_LSTART_PLUS_3);
      let t = 1000;
      const c = createLivenessChecker({ exec, pidAlive: () => true, now: () => t, cacheMs: 2000 });
      expect(await c.isAlive(41001, PROC_START)).toBe(true);
      t = 2500;
      expect(await c.isAlive(41001, PROC_START)).toBe(true);
      expect(calls).toHaveLength(1);
      t = 3001;
      expect(await c.isAlive(41001, PROC_START)).toBe(true);
      expect(calls).toHaveLength(2);
    });
  });

  it('matches a process started in the repeated hour of a DST fall-back', async () => {
    // `ps` prints one wall clock for both passes of the repeated hour, and `new Date(y,m,d,...)`
    // always resolves it to the earlier (still-DST) instant. Comparing epochs made a process that
    // really started in the SECOND pass mismatch by exactly 3_600_000ms -> dead -> removed ->
    // pid-dismissed, one hour a year on every DST host. The match is on wall clocks instead.
    await withTZ('America/New_York', async () => {
      const AMBIGUOUS_LOCAL = 'Sun Nov  1 01:30:00 2026';
      const FIRST_PASS_UTC = 'Sun Nov  1 05:30:00 2026'; // EDT, UTC-4
      const SECOND_PASS_UTC = 'Sun Nov  1 06:30:00 2026'; // EST, UTC-5
      expect(new Date(2026, 10, 1, 1, 30, 0).toISOString()).toBe('2026-11-01T05:30:00.000Z');
      const { exec } = execFor(AMBIGUOUS_LOCAL);
      const c = createLivenessChecker({ exec, pidAlive: () => true, cacheMs: 0 });
      expect(await c.isAlive(41001, FIRST_PASS_UTC)).toBe(true);
      expect(await c.isAlive(41001, SECOND_PASS_UTC)).toBe(true);
      // And an hour that is genuinely a different wall clock is still rejected.
      expect(await c.isAlive(41001, 'Sun Nov  1 07:30:00 2026')).toBe(false);
    });
  });

  it('warns on a mismatch that looks like a timezone/format change', async () => {
    // The signature of `procStart` flipping to local time: every entry off by exactly one real UTC
    // offset. Warn only — the verdict is unchanged, so the pid-reuse guard is not weakened.
    await withTZ('Asia/Riyadh', async () => {
      const seen: Array<{ pid: number; procStart: string; psStartMs: number; wantMs: number }> = [];
      const { exec } = execFor('Mon Sep 21 21:30:14 2026'); // `ps` says 21:30:14 local (= 18:30:14Z)
      const c = createLivenessChecker({
        exec,
        pidAlive: () => true,
        onSuspectedFormatChange: (i) => seen.push(i),
      });
      // procStart read as UTC is 21:30:14Z; the delta is exactly the +3h host offset.
      expect(await c.isAlive(38030, 'Mon Sep 21 21:30:14 2026')).toBe(false);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ pid: 38030, procStart: 'Mon Sep 21 21:30:14 2026' });
      expect((seen[0]?.psStartMs ?? 0) - (seen[0]?.wantMs ?? 0)).toBe(-3 * 3_600_000);
    });
  });

  it('does not warn on an ordinary recycled-pid mismatch', async () => {
    await withTZ('Asia/Riyadh', async () => {
      const seen: unknown[] = [];
      // 37 minutes and 11 seconds off: not a multiple of 15 minutes, so not an offset.
      const { exec } = execFor('Mon Sep  1 12:37:11 2026');
      const c = createLivenessChecker({
        exec,
        pidAlive: () => true,
        onSuspectedFormatChange: (i) => seen.push(i),
      });
      expect(await c.isAlive(41001, PROC_START)).toBe(false);
      expect(seen).toEqual([]);
    });
  });

  it('defaults to the real process table', async () => {
    const c = createLivenessChecker();
    expect(await c.isAlive(2 ** 22 + 12345, null)).toBe(false);
    // Never kills, never signals: this only reads `ps` for a pid we already know is ours.
    const spy = vi.spyOn(process, 'kill');
    expect(await c.isAlive(process.pid, null)).toBe(true);
    expect(spy.mock.calls.every(([, sig]) => sig === 0)).toBe(true);
    spy.mockRestore();
  });
});
