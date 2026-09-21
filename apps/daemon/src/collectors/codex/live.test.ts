import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecFn } from '../../live/liveness.ts';
import {
  calendarDaysBetween,
  createCodexLiveDetector,
  isCodexCommand,
  localDayKey,
  localDayStart,
  parsePsLine,
  readRolloutMeta,
} from './live.ts';

// Every temp dir this file makes is tracked and removed when the file's tests finish. Without
// this the suite leaked ~100 directories per `pnpm test` run; 10,870 of them once filled the
// disk and produced dozens of failures that looked like flaky tests.
const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// `vi.spyOn` cannot redefine a live ESM export ("Module namespace is not configurable"), so
// `readdir` and `open` are wrapped through `vi.mock` instead. By default both are transparent
// pass-throughs to the real implementation (every other test in this file relies on that); only
// the `names.sort()` test below swaps in a reversing `readdir`, then restores the pass-through.
// The call logs are what the binding-cache tests assert on: a directory search *is* a `readdir`
// plus an `open` per candidate, so "did not re-search" is literally "made neither call".
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir), open: vi.fn(actual.open) };
});

type CallLog = { mock: { calls: unknown[][] }; mockClear: () => void };
const readdirCalls = fsPromises.readdir as unknown as CallLog;
const openCalls = fsPromises.open as unknown as CallLog;

/**
 * Runs `fn` with the process timezone pinned, so a TZ-sensitive test asserts the same thing on a
 * UTC CI runner as on a developer laptop. Node re-reads `process.env.TZ` on assignment, and the
 * helper restores the previous value even when `fn` throws.
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

const FIXTURE = fileURLToPath(
  new URL(
    '../../../../../fixtures/codex-home/sessions/2026/09/01/rollout-2026-09-01T09-00-00-c0dex000-0000-0000-0000-000000000001.jsonl',
    import.meta.url,
  ),
);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const lstart = (d: Date) =>
  `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`;
/** One `ps -axo pid=,ppid=,lstart=,command=` line. `ppid` defaults to 1 (no matched parent). */
const psLine = (pid: number, d: Date, command: string, ppid = 1) =>
  `  ${pid} ${ppid} ${lstart(d)} ${command}`;

const NOW = Date.parse('2026-09-01T09:05:20.000Z');
const T0 = new Date('2026-09-01T09:00:00.000Z');
const T1 = new Date('2026-09-01T09:05:00.000Z');
let home: string;
let dayDir: string;

beforeEach(() => {
  home = tmpDir('orc-codex-');
  const d = new Date(NOW);
  dayDir = join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  mkdirSync(dayDir, { recursive: true });
  const r1 = join(dayDir, 'rollout-a-c0dex000-0000-0000-0000-000000000001.jsonl');
  copyFileSync(FIXTURE, r1);
  utimesSync(r1, new Date(NOW - 10_000), new Date(NOW - 10_000));
  const r3 = join(dayDir, 'rollout-b-c0dex000-0000-0000-0000-000000000003.jsonl');
  writeFileSync(
    r3,
    `${JSON.stringify({ timestamp: T1.toISOString(), type: 'session_meta', payload: { id: 'c0dex-3', cwd: '/Users/test/Wakecap', originator: 'codex_cli_rs', base_instructions: 'x'.repeat(2_000_000) } })}\n`,
  );
  utimesSync(r3, new Date(NOW - 5_000), new Date(NOW - 5_000));
});

const fakeExec =
  (ps: string, cwds: Record<string, string | null>): ExecFn =>
  async (cmd, args) => {
    if (cmd === 'ps') return { stdout: ps, exitCode: 0 };
    if (cmd === 'lsof') {
      const pid = args[args.indexOf('-p') + 1] ?? '';
      const cwd = cwds[pid];
      return cwd ? { stdout: `p${pid}\nfcwd\nn${cwd}\n`, exitCode: 0 } : { stdout: '', exitCode: 1 };
    }
    throw new Error(`unexpected ${cmd}`);
  };

describe('parsePsLine / isCodexCommand', () => {
  it('parses pid, ppid, local start time and command', () => {
    const p = parsePsLine(`  4242 1 ${lstart(T0)} /opt/homebrew/bin/codex --model gpt-5.5`);
    expect(p).toEqual({
      pid: 4242,
      ppid: 1,
      startedAtMs: T0.getTime(),
      // Raw clock column, kept for the liveness checker's DST-safe wall-clock match.
      lstart: lstart(T0),
      command: '/opt/homebrew/bin/codex --model gpt-5.5',
    });
    expect(parsePsLine('garbage')).toBeNull();
  });

  it.each([
    // Baseline: bare executable, session subcommands, non-session subcommands, non-codex.
    ['/opt/homebrew/bin/codex', true],
    ['codex resume abc', true],
    ['node /usr/local/lib/node_modules/@openai/codex/bin/codex.js exec "hi"', true],
    // The `bun` shim is skipped exactly like the `node` one; without that, `bun` itself would be
    // read as the executable and no codex invocation launched through it would ever be seen.
    ['bun /usr/local/lib/node_modules/@openai/codex/bin/codex.js exec "hi"', true],
    ['bun /usr/local/lib/node_modules/@openai/codex/bin/codex.js app-server', false],
    ['/Applications/Codex.app/codex app-server', false],
    ['codex mcp-server', false],
    ['/usr/bin/vim codex.md', false],
    ['node server.js', false],
    // Value-taking flags: separate-value and `=`-joined forms, repeated.
    ['codex --cd /tmp mcp-server', false],
    ['codex --cd /tmp exec "hi"', true],
    ['codex -c model=x app-server', false],
    ['codex --cd=/tmp mcp-server', false],
    ['codex --yolo --cd /tmp app-server', false],
    // Value-less allow-listed flags (defense #1) directly ahead of a non-session subcommand —
    // the exact regression this round exists to fix.
    ['codex --yolo app-server', false],
    ['codex --search app-server', false],
    ['codex --full-auto mcp-server', false],
    ['codex --yolo login', false],
    ['codex --dangerously-bypass-approvals-and-sandbox mcp-server', false],
    ['codex -h app-server', false],
    ['codex --help mcp-server', false],
    ['codex -V app-server', false],
    ['codex --version mcp-server', false],
    // The only shape where the allow-list itself is load-bearing: *two* plain tokens after a
    // value-less flag. This is how `codex --yolo "fix app-server"` renders in `ps`, which joins
    // argv and drops the quotes. Without the allow-list `--yolo` eats `fix`, leaving `app-server`
    // as the apparent subcommand and the session wrongly filtered out. Defense #2 cannot help
    // here: `fix` is not a known subcommand name.
    ['codex --yolo fix app-server', true],
    // Value-less flags ahead of a session subcommand (or nothing) must not consume it either.
    ['codex --yolo exec "hi"', true],
    ['codex --yolo resume abc', true],
    ['codex --search --full-auto exec "hi"', true],
    // Defense #2 backstop: an unlisted value-less flag must still not swallow a *known*
    // subcommand, because it's a known subcommand name, not because it's on the allow-list.
    ['codex --some-future-flag app-server', false],
    ['codex --some-future-flag mcp-server', false],
    ['codex --some-future-flag exec "hi"', true],
    // `--` terminates option parsing: nothing after it is ever read as a subcommand.
    ['codex -- mcp-server', true],
    ['codex -- app-server', true],
    ['codex --yolo -- mcp-server', true],
    ['codex --cd /tmp -- app-server', true],
  ])('%s → %s', (cmd, expected) => {
    expect(isCodexCommand(cmd)).toBe(expected);
  });
});

describe('readRolloutMeta', () => {
  it('reads a huge first line via the regex fallback', async () => {
    const m = await readRolloutMeta(join(dayDir, 'rollout-b-c0dex000-0000-0000-0000-000000000003.jsonl'));
    expect(m).toEqual({
      id: 'c0dex-3',
      cwd: '/Users/test/Wakecap',
      originator: 'codex_cli_rs',
      startedAtMs: T1.getTime(),
    });
  });

  it('rejects a first line whose type is not session_meta, even via the regex fallback', async () => {
    const p = join(dayDir, 'rollout-c-not-session-meta.jsonl');
    writeFileSync(
      p,
      `${JSON.stringify({ timestamp: T1.toISOString(), type: 'turn_context', payload: { id: 'nope', cwd: '/nope', originator: 'nope', huge: 'x'.repeat(2_000_000) } })}\n`,
    );
    expect(await readRolloutMeta(p)).toEqual({ id: null, cwd: null, originator: null, startedAtMs: null });
  });

  it('rejects a small, non-truncated first line whose type is not session_meta (the JSON-parse path)', async () => {
    // The "huge first line" test above only ever exercises the regex-fallback path (its line is
    // 2 MB, so JSON.parse always fails on the truncated read). This one is well under 64 KB, so
    // it parses successfully as JSON — a `turn_context` envelope must still be rejected there,
    // not just in the regex fallback.
    const p = join(dayDir, 'rollout-small-not-session-meta.jsonl');
    writeFileSync(
      p,
      `${JSON.stringify({ timestamp: T1.toISOString(), type: 'turn_context', payload: { id: 'nope', cwd: '/nope', originator: 'nope' } })}\n`,
    );
    expect(await readRolloutMeta(p)).toEqual({ id: null, cwd: null, originator: null, startedAtMs: null });
  });

  it("prefers payload.timestamp (when present) over the envelope's own, later, flush timestamp", async () => {
    // On a real machine the envelope's outer `timestamp` (when the line was flushed to disk) can
    // trail `payload.timestamp` (when the session actually started) by tens of seconds — eating
    // into the 60s fresh-window headroom. `payload.timestamp` must win when both are present.
    const p = join(dayDir, 'rollout-payload-ts.jsonl');
    const payloadTs = new Date(T0.getTime() - 30_000); // session really started 30s before flush
    writeFileSync(
      p,
      `${JSON.stringify({ timestamp: T0.toISOString(), type: 'session_meta', payload: { id: 'c0dex-payload-ts', cwd: '/Users/test/Wakecap', originator: 'codex_exec', timestamp: payloadTs.toISOString() } })}\n`,
    );
    expect(await readRolloutMeta(p)).toEqual({
      id: 'c0dex-payload-ts',
      cwd: '/Users/test/Wakecap',
      originator: 'codex_exec',
      startedAtMs: payloadTs.getTime(),
    });
  });

  it('prefers payload.timestamp on the regex path too, for a first line past the 1 MB cap', async () => {
    // The JSON-parse path is covered above, but the regex fallback has its own timestamp
    // resolution (`payloadSlice` + two `extractField` calls) and the only existing huge-line
    // fixture carries no `payload.timestamp`, so it cannot tell the two apart. This line is
    // deliberately past the 1 MB read cap, so it is *truncated* — `JSON.parse` must fail and the
    // regex fallback must be what answers.
    //
    // Two distinct behaviours ride on this: (a) the regex path consulting `payload.timestamp` at
    // all, and (b) `payloadSlice` actually slicing. The envelope's own `timestamp` appears first
    // in the line, so if `payloadSlice` returned the whole line the very first `"timestamp"`
    // match would be the envelope's and the wrong instant would win.
    const p = join(dayDir, 'rollout-huge-payload-ts.jsonl');
    const payloadTs = new Date(T0.getTime() - 30_000); // session really started 30s before flush
    writeFileSync(
      p,
      `${JSON.stringify({
        timestamp: T0.toISOString(),
        type: 'session_meta',
        payload: {
          timestamp: payloadTs.toISOString(),
          id: 'c0dex-huge-ts',
          cwd: '/Users/test/HugeTs',
          originator: 'codex_exec',
          base_instructions: 'x'.repeat(1_500_000),
        },
      })}\n`,
    );
    expect(statSync(p).size).toBeGreaterThan(1 << 20); // past the cap, so the read really truncates
    expect(await readRolloutMeta(p)).toEqual({
      id: 'c0dex-huge-ts',
      cwd: '/Users/test/HugeTs',
      originator: 'codex_exec',
      startedAtMs: payloadTs.getTime(),
    });
  });

  it('falls back to the envelope timestamp when payload has none', async () => {
    const p = join(dayDir, 'rollout-no-payload-ts.jsonl');
    writeFileSync(
      p,
      `${JSON.stringify({ timestamp: T0.toISOString(), type: 'session_meta', payload: { id: 'c0dex-envelope-ts', cwd: '/Users/test/Wakecap', originator: 'codex_exec' } })}\n`,
    );
    expect(await readRolloutMeta(p)).toMatchObject({ startedAtMs: T0.getTime() });
  });

  it('grows the read past 64 KB to find fields that land beyond the first chunk', async () => {
    // `padding` pushes id/cwd/originator past the 64 KB first-read boundary, but the whole line
    // stays well under the 1 MB cap — the escalation must kick in to find the real newline.
    const p = join(dayDir, 'rollout-escalate.jsonl');
    const payload = {
      padding: 'y'.repeat(70_000),
      id: 'c0dex-esc',
      cwd: '/Users/test/Escalate',
      originator: 'codex_exec',
    };
    writeFileSync(p, `${JSON.stringify({ timestamp: T1.toISOString(), type: 'session_meta', payload })}\n`);
    expect(await readRolloutMeta(p)).toEqual({
      id: 'c0dex-esc',
      cwd: '/Users/test/Escalate',
      originator: 'codex_exec',
      startedAtMs: T1.getTime(),
    });
  });
});

describe('calendarDaysBetween', () => {
  // These pin `TZ` themselves rather than reading the host's, so they assert the same thing on a
  // UTC CI runner as on a developer laptop — a DST-stepping test that only bites in one timezone
  // protects nothing where it actually runs. The offset assertions below fail loudly (rather
  // than going quietly vacuous) if a host ever ignores a runtime `TZ` change.

  it('steps one calendar day at a time across a spring-forward transition, skipping no day', async () => {
    await withTZ('America/New_York', () => {
      // The offsets of the two local midnights the stepping actually starts and ends on.
      expect(new Date(2026, 2, 7).getTimezoneOffset()).toBe(300); // EST, before the jump
      expect(new Date(2026, 2, 9).getTimezoneOffset()).toBe(240); // EDT, after it
      // Sun 2026-03-08 loses an hour locally. A fixed 86_400_000 ms step starting from local
      // midnight on 03-07 lands an hour *past* local midnight on 03-09, overshoots the end-of-
      // range comparison and drops 03-09 entirely — the session directory for the day the
      // process is running in.
      const from = new Date(2026, 2, 7, 12, 0, 0).getTime();
      const to = new Date(2026, 2, 9, 12, 0, 0).getTime();
      expect(calendarDaysBetween(from, to, localDayKey, localDayStart)).toEqual([
        [2026, 3, 7],
        [2026, 3, 8],
        [2026, 3, 9],
      ]);
    });
  });

  it('steps one calendar day at a time across a fall-back transition, double-counting no day', async () => {
    await withTZ('America/New_York', () => {
      expect(new Date(2026, 10, 1).getTimezoneOffset()).toBe(240); // EDT, before the repeat
      expect(new Date(2026, 10, 3).getTimezoneOffset()).toBe(300); // EST, after it
      // Sun 2026-11-01 gains an hour locally, so a fixed-ms step from local midnight on 11-01
      // lands back inside 11-01, yielding 11-01, 11-01, 11-02: one day enumerated twice and the
      // last day of the range never reached.
      const from = new Date(2026, 10, 1, 12, 0, 0).getTime();
      const to = new Date(2026, 10, 3, 12, 0, 0).getTime();
      expect(calendarDaysBetween(from, to, localDayKey, localDayStart)).toEqual([
        [2026, 11, 1],
        [2026, 11, 2],
        [2026, 11, 3],
      ]);
    });
  });

  it('accepts its endpoints in either order and covers a single-day range once', async () => {
    await withTZ('America/New_York', () => {
      const from = new Date(2026, 2, 7, 12, 0, 0).getTime();
      const to = new Date(2026, 2, 9, 12, 0, 0).getTime();
      expect(calendarDaysBetween(to, from, localDayKey, localDayStart)).toEqual(
        calendarDaysBetween(from, to, localDayKey, localDayStart),
      );
      expect(calendarDaysBetween(from, from, localDayKey, localDayStart)).toEqual([[2026, 3, 7]]);
    });
  });
});

describe('createCodexLiveDetector', () => {
  it('matches each codex process to its own rollout, claiming one rollout per process', async () => {
    const ps = [
      psLine(100, T0, 'codex'),
      psLine(200, T1, '/opt/homebrew/bin/codex'),
      psLine(300, T1, 'node server.js'),
      psLine(400, T1, 'codex app-server'),
      psLine(500, T1, 'codex'),
    ].join('\n');
    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(ps, { '100': '/Users/test/Wakecap', '200': '/Users/test/Wakecap', '500': null }),
    });
    const out = await d.scan();
    expect(out.map((p) => [p.pid, p.sessionId])).toEqual([
      [100, 'c0dex000-0000-0000-0000-000000000001'],
      [200, 'c0dex-3'],
    ]);
    expect(out[0]).toMatchObject({
      cwd: '/Users/test/Wakecap',
      originator: 'codex_exec',
      lastWriteMs: NOW - 10_000,
    });
  });

  it('reports a process without a rollout yet', async () => {
    const later = new Date(NOW + 60_000);
    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(psLine(700, later, 'codex'), { '700': '/Users/test/Forza' }),
    });
    expect(await d.scan()).toEqual([
      {
        pid: 700,
        cwd: '/Users/test/Forza',
        startedAtMs: later.getTime(),
        rolloutPath: null,
        sessionId: null,
        originator: null,
        lastWriteMs: null,
      },
    ]);
  });

  it('only claims a rollout for one process even when a second process would otherwise pick it too', async () => {
    // Both start at T0 (same second) in a cwd with exactly one candidate rollout. Without the
    // claiming rule, both processes would independently "win" that same rollout; the rule must
    // make the second process fall through to nothing instead of duplicating the binding.
    const cwd = '/Users/test/OnlyOne';
    const only = join(dayDir, 'rollout-only-c0dex000-0000-0000-0000-000000000077.jsonl');
    writeFileSync(
      only,
      `${JSON.stringify({ timestamp: T0.toISOString(), type: 'session_meta', payload: { id: 'c0dex-only', cwd, originator: 'codex_exec' } })}\n`,
    );
    utimesSync(only, new Date(NOW - 10_000), new Date(NOW - 10_000));

    const ps = [psLine(801, T0, 'codex'), psLine(802, T0, 'codex')].join('\n');
    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(ps, { '801': cwd, '802': cwd }),
    });
    const out = await d.scan();
    const withRollout = out.filter((p) => p.rolloutPath !== null);
    const withoutRollout = out.filter((p) => p.rolloutPath === null);
    expect(withRollout).toHaveLength(1);
    expect(withoutRollout).toHaveLength(1);
    expect(withRollout[0]?.sessionId).toBe('c0dex-only');
  });

  it('never matches a rollout from a different cwd even when timing would otherwise fit', async () => {
    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(psLine(900, T0, 'codex'), { '900': '/Users/test/SomewhereElse' }),
    });
    const out = await d.scan();
    expect(out).toEqual([
      {
        pid: 900,
        cwd: '/Users/test/SomewhereElse',
        startedAtMs: T0.getTime(),
        rolloutPath: null,
        sessionId: null,
        originator: null,
        lastWriteMs: null,
      },
    ]);
  });

  it('finds a rollout under the UTC date directory when it differs from the local one', async () => {
    // `TZ` is pinned rather than inherited: this test is only meaningful where the local and UTC
    // calendar days actually diverge at the chosen instant, and on a UTC host (i.e. CI) an
    // inherited timezone makes the two date directories identical and the whole UTC enumeration
    // deletable with the suite still green. Asia/Dubai is UTC+4 year-round, so 22:30Z is already
    // Sep 2 locally while UTC is still Sep 1. The rollout lives only under the UTC-dated
    // directory; a local-date-only lookup would miss it entirely.
    await withTZ('Asia/Dubai', async () => {
      const crossMidnight = new Date('2026-09-01T22:30:00.000Z');
      expect(crossMidnight.getDate()).not.toBe(crossMidnight.getUTCDate()); // the divergence itself
      const utcDir = join(
        home,
        'sessions',
        String(crossMidnight.getUTCFullYear()),
        pad(crossMidnight.getUTCMonth() + 1),
        pad(crossMidnight.getUTCDate()),
      );
      mkdirSync(utcDir, { recursive: true });
      const rUtc = join(utcDir, 'rollout-utc-c0dex000-0000-0000-0000-000000000099.jsonl');
      writeFileSync(
        rUtc,
        `${JSON.stringify({ timestamp: crossMidnight.toISOString(), type: 'session_meta', payload: { id: 'c0dex-utc', cwd: '/Users/test/Utc', originator: 'codex_exec' } })}\n`,
      );
      utimesSync(rUtc, crossMidnight, crossMidnight);

      const d = createCodexLiveDetector({
        codexHome: home,
        now: () => crossMidnight.getTime(),
        lookbackDays: 0,
        exec: fakeExec(psLine(950, crossMidnight, 'codex'), { '950': '/Users/test/Utc' }),
      });
      const out = await d.scan();
      expect(out).toMatchObject([{ pid: 950, sessionId: 'c0dex-utc' }]);
    });
  });

  it('finds a rollout under the local date directory when it differs from the UTC one', async () => {
    // The mirror of the test above, and the more common half in practice: codex names its
    // session directories by *local* date, so a rollout started just after local midnight lives
    // under a date the UTC enumeration never visits. Same pinned Asia/Dubai timezone, an instant
    // chosen so local is already Sep 3 while UTC is still Sep 2.
    await withTZ('Asia/Dubai', async () => {
      const crossMidnight = new Date('2026-09-02T21:00:00.000Z');
      expect(crossMidnight.getDate()).not.toBe(crossMidnight.getUTCDate());
      const localDir = join(
        home,
        'sessions',
        String(crossMidnight.getFullYear()),
        pad(crossMidnight.getMonth() + 1),
        pad(crossMidnight.getDate()),
      );
      mkdirSync(localDir, { recursive: true });
      const rLocal = join(localDir, 'rollout-local-c0dex000-0000-0000-0000-000000000098.jsonl');
      writeFileSync(
        rLocal,
        `${JSON.stringify({ timestamp: crossMidnight.toISOString(), type: 'session_meta', payload: { id: 'c0dex-local', cwd: '/Users/test/Local', originator: 'codex_exec' } })}\n`,
      );
      utimesSync(rLocal, crossMidnight, crossMidnight);

      const d = createCodexLiveDetector({
        codexHome: home,
        now: () => crossMidnight.getTime(),
        lookbackDays: 0,
        exec: fakeExec(psLine(951, crossMidnight, 'codex'), { '951': '/Users/test/Local' }),
      });
      const out = await d.scan();
      expect(out).toMatchObject([{ pid: 951, sessionId: 'c0dex-local' }]);
    });
  });

  it('derives the search window from the earliest matched process, reaching further back than lookbackDays', async () => {
    // The rollout lives 10 days before NOW. lookbackDays is left at its tiny default-defeating
    // value (0) so only the process's own startedAtMs can be what makes the search reach back
    // far enough to find it.
    const old = new Date(NOW - 10 * 86_400_000);
    const oldDir = join(
      home,
      'sessions',
      String(old.getFullYear()),
      pad(old.getMonth() + 1),
      pad(old.getDate()),
    );
    mkdirSync(oldDir, { recursive: true });
    const rOld = join(oldDir, 'rollout-old-c0dex000-0000-0000-0000-000000000042.jsonl');
    writeFileSync(
      rOld,
      `${JSON.stringify({ timestamp: old.toISOString(), type: 'session_meta', payload: { id: 'c0dex-old', cwd: '/Users/test/Old', originator: 'codex_exec' } })}\n`,
    );
    utimesSync(rOld, old, old);

    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      lookbackDays: 0,
      exec: fakeExec(psLine(960, old, 'codex'), { '960': '/Users/test/Old' }),
    });
    const out = await d.scan();
    expect(out).toMatchObject([{ pid: 960, sessionId: 'c0dex-old' }]);
  });

  it('excludes non-session codex subcommands even when lsof would happily resolve their cwd', async () => {
    // Unlike the brief's original fixture (where 300/400/500 were excluded because the fake
    // lsof failed for them), here every pid resolves a cwd successfully — only isCodexCommand's
    // subcommand filter can keep app-server/mcp-server/plain-node out of the result.
    const ps = [
      psLine(971, T1, 'codex app-server'),
      psLine(972, T1, 'codex mcp-server'),
      psLine(973, T1, 'node server.js'),
      psLine(974, T1, 'codex'),
    ].join('\n');
    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(ps, {
        '971': '/Users/test/Wakecap',
        '972': '/Users/test/Wakecap',
        '973': '/Users/test/Wakecap',
        '974': '/Users/test/Wakecap',
      }),
    });
    const out = await d.scan();
    expect(out.map((p) => p.pid)).toEqual([974]);
  });

  it('keeps only the deepest descendant when an npm shim execs the real codex binary as a child', async () => {
    // Same pattern as the real `@openai/codex` npm install: a `node` shim (parent) execs the
    // vendored native binary (child, ppid = the shim's pid). Both independently pass
    // isCodexCommand and share a cwd/start second; only the child actually holds the rollout fd.
    const ps = [
      psLine(1001, T0, 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js', 50),
      psLine(1002, T0, '/usr/local/lib/node_modules/@openai/codex/vendor/bin/codex', 1001),
    ].join('\n');
    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(ps, { '1001': '/Users/test/Wakecap', '1002': '/Users/test/Wakecap' }),
    });
    const out = await d.scan();
    expect(out.map((p) => p.pid)).toEqual([1002]);
    expect(out[0]?.sessionId).toBe('c0dex000-0000-0000-0000-000000000001');
  });

  it('bounds the fresh window above: prefers newest-mtime over merely-closer-in-start-time once both exceed it', async () => {
    // Two same-cwd rollouts, neither anywhere near this process's own start (+3h and +5h later)
    // — a stale, unbounded "closest by start time" rule would prefer the +3h one (closer in
    // absolute distance) even though the +5h one was written far more recently and is the one
    // actually still active. Bounding the fresh window forces both through the newest-mtime
    // fallback instead, which picks correctly by recency.
    const cwd = '/Users/test/BoundTest';
    const rFar = join(dayDir, 'rollout-far-c0dex000-0000-0000-0000-000000000201.jsonl');
    const farStart = new Date(T0.getTime() + 3 * 3_600_000);
    writeFileSync(
      rFar,
      `${JSON.stringify({ timestamp: farStart.toISOString(), type: 'session_meta', payload: { id: 'c0dex-far', cwd, originator: 'codex_exec' } })}\n`,
    );
    utimesSync(rFar, new Date(NOW - 5 * 60_000), new Date(NOW - 5 * 60_000));

    const rFarther = join(dayDir, 'rollout-farther-c0dex000-0000-0000-0000-000000000202.jsonl');
    const fartherStart = new Date(T0.getTime() + 5 * 3_600_000);
    writeFileSync(
      rFarther,
      `${JSON.stringify({ timestamp: fartherStart.toISOString(), type: 'session_meta', payload: { id: 'c0dex-farther', cwd, originator: 'codex_exec' } })}\n`,
    );
    utimesSync(rFarther, new Date(NOW - 60_000), new Date(NOW - 60_000));

    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(psLine(1300, T0, 'codex'), { '1300': cwd }),
    });
    const out = await d.scan();
    expect(out[0]?.sessionId).toBe('c0dex-farther');
  });

  it('reuses a bound rollout across scans without re-enumerating the session directories, and refreshes lastWriteMs', async () => {
    // "Does not re-search" is measured where the search actually happens: the directory
    // enumeration (`readdir`) and the per-candidate first-line read (`open`). Counting `lsof`
    // calls would prove nothing — cwd is required output for every process on every scan and is
    // resolved unconditionally, so its count is 2 whether or not the binding cache exists.
    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(psLine(1200, T0, 'codex'), { '1200': '/Users/test/Wakecap' }),
    });
    readdirCalls.mockClear();
    openCalls.mockClear();
    const first = await d.scan();
    expect(first[0]?.sessionId).toBe('c0dex000-0000-0000-0000-000000000001');
    expect(first[0]?.lastWriteMs).toBe(NOW - 10_000);
    // The first scan is unbound, so it must genuinely search — otherwise the second scan's zero
    // counts below would be trivially satisfied by a detector that never searches at all.
    expect(readdirCalls.mock.calls.length).toBeGreaterThan(0);
    expect(openCalls.mock.calls.length).toBeGreaterThan(0);

    // The bound rollout is appended to, so its mtime moves and its cached meta is invalidated: a
    // re-search would be forced to re-`readdir` and re-`open` it, not silently reuse a cache.
    utimesSync(
      join(dayDir, 'rollout-a-c0dex000-0000-0000-0000-000000000001.jsonl'),
      new Date(NOW),
      new Date(NOW),
    );
    readdirCalls.mockClear();
    openCalls.mockClear();
    const second = await d.scan();
    expect(second[0]?.sessionId).toBe('c0dex000-0000-0000-0000-000000000001');
    expect(second[0]?.lastWriteMs).toBe(NOW);
    expect(readdirCalls.mock.calls.length).toBe(0);
    expect(openCalls.mock.calls.length).toBe(0);
  });

  it('returns nothing and does not throw when ps itself fails', async () => {
    const exec: ExecFn = async (cmd) => {
      if (cmd === 'ps') return { stdout: '', exitCode: 1 };
      throw new Error(`unexpected ${cmd}`);
    };
    const d = createCodexLiveDetector({ codexHome: home, now: () => NOW, exec });
    await expect(d.scan()).resolves.toEqual([]);
  });

  it('warns via the log hook when ps fails, instead of failing silently', async () => {
    const warn = vi.fn();
    const exec: ExecFn = async (cmd) => {
      if (cmd === 'ps') return { stdout: '', exitCode: 7 };
      throw new Error(`unexpected ${cmd}`);
    };
    const d = createCodexLiveDetector({ codexHome: home, now: () => NOW, exec, log: { warn } });
    await d.scan();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ exitCode: 7 });
  });

  it('excludes its own process id even if ps somehow reports it as a codex process', async () => {
    const ps = [psLine(process.pid, T0, 'codex'), psLine(2000, T0, 'codex')].join('\n');
    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(ps, { [String(process.pid)]: '/Users/test/Wakecap', '2000': '/Users/test/Wakecap' }),
    });
    const out = await d.scan();
    expect(out.map((p) => p.pid)).toEqual([2000]);
  });

  it('excludes a rollout that started more than 5s before the process from the fresh preference', async () => {
    // Without the -5s lower bound, the "too soon" rollout (6s before the process's own start)
    // would win on raw start-time distance (6s) over the legitimately-fresh one (50s after,
    // within the +60s upper bound) — the lower bound is what forces it through the newest-mtime
    // fallback instead, where it loses to the actually-fresh candidate.
    const cwd = '/Users/test/LowerBoundTest';
    const rTooSoon = join(dayDir, 'rollout-toosoon.jsonl');
    const tooSoonStart = new Date(T0.getTime() - 6_000);
    writeFileSync(
      rTooSoon,
      `${JSON.stringify({ timestamp: tooSoonStart.toISOString(), type: 'session_meta', payload: { id: 'c0dex-toosoon', cwd, originator: 'codex_exec' } })}\n`,
    );
    utimesSync(rTooSoon, new Date(NOW), new Date(NOW));

    const rCorrect = join(dayDir, 'rollout-correct.jsonl');
    const correctStart = new Date(T0.getTime() + 50_000);
    writeFileSync(
      rCorrect,
      `${JSON.stringify({ timestamp: correctStart.toISOString(), type: 'session_meta', payload: { id: 'c0dex-correct', cwd, originator: 'codex_exec' } })}\n`,
    );
    utimesSync(rCorrect, new Date(NOW - 60_000), new Date(NOW - 60_000));

    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(psLine(1900, T0, 'codex'), { '1900': cwd }),
    });
    const out = await d.scan();
    expect(out[0]?.sessionId).toBe('c0dex-correct');
  });

  it('does not re-search once bound, even when a more "attractive" rollout later appears', async () => {
    // The process starts 3s after the incumbent rollout's own session start, so the incumbent
    // sits at fresh-distance 3000 — deliberately *not* zero. The decoy that appears afterwards
    // starts at exactly the process's own start (distance 0) and has a newer mtime, so on every
    // tie-break the search offers it would beat the incumbent outright. Only the binding cache
    // can explain the incumbent still winning the second scan.
    const procStart = new Date(T0.getTime() + 3_000);
    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(psLine(1400, procStart, 'codex'), { '1400': '/Users/test/Wakecap' }),
    });
    const first = await d.scan();
    expect(first[0]?.sessionId).toBe('c0dex000-0000-0000-0000-000000000001');

    const decoy = join(dayDir, 'rollout-decoy.jsonl');
    writeFileSync(
      decoy,
      `${JSON.stringify({ timestamp: procStart.toISOString(), type: 'session_meta', payload: { id: 'c0dex-decoy', cwd: '/Users/test/Wakecap', originator: 'codex_exec' } })}\n`,
    );
    utimesSync(decoy, new Date(NOW), new Date(NOW));

    const second = await d.scan();
    expect(second[0]?.sessionId).toBe('c0dex000-0000-0000-0000-000000000001');
  });

  it('evicts a binding when its pid exits, freeing the rollout for a different process afterward', async () => {
    let currentPs = psLine(1500, T0, 'codex');
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === 'ps') return { stdout: currentPs, exitCode: 0 };
      if (cmd === 'lsof') {
        const pid = args[args.indexOf('-p') + 1];
        return pid === '1500' || pid === '1501'
          ? { stdout: `p${pid}\nfcwd\nn/Users/test/Wakecap\n`, exitCode: 0 }
          : { stdout: '', exitCode: 1 };
      }
      throw new Error(`unexpected ${cmd}`);
    };
    const d = createCodexLiveDetector({ codexHome: home, now: () => NOW, exec });
    const first = await d.scan();
    expect(first[0]?.rolloutPath).not.toBeNull();

    currentPs = ''; // 1500 exits
    const second = await d.scan();
    expect(second).toEqual([]);

    currentPs = psLine(1501, T0, 'codex'); // a different pid wants the now-freed rollout
    const third = await d.scan();
    expect(third[0]?.sessionId).toBe('c0dex000-0000-0000-0000-000000000001');
  });

  it('frees a stale binding for reclaim when its pid is recycled (same pid, different startedAtMs)', async () => {
    let currentPs = psLine(1600, T0, 'codex');
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === 'ps') return { stdout: currentPs, exitCode: 0 };
      if (cmd === 'lsof') {
        const pid = args[args.indexOf('-p') + 1];
        return pid === '1600' || pid === '1601'
          ? { stdout: `p${pid}\nfcwd\nn/Users/test/Wakecap\n`, exitCode: 0 }
          : { stdout: '', exitCode: 1 };
      }
      throw new Error(`unexpected ${cmd}`);
    };
    const d = createCodexLiveDetector({ codexHome: home, now: () => NOW, exec });
    const first = await d.scan();
    expect(first[0]?.sessionId).toBe('c0dex000-0000-0000-0000-000000000001'); // 1600 binds to r1

    // The OS recycles pid 1600 for an unrelated process (different start time). A second,
    // genuinely different process (1601) starts at r1's own original time/cwd and should be
    // able to claim r1 — which only happens if the stale 1600:T0 binding is evicted by its full
    // (pid, startedAtMs) key rather than by bare pid (1600 is still "present" in ps either way).
    currentPs = [psLine(1600, T1, 'codex'), psLine(1601, T0, 'codex')].join('\n');
    const second = await d.scan();
    const byPid = new Map(second.map((p) => [p.pid, p]));
    expect(byPid.get(1601)?.sessionId).toBe('c0dex000-0000-0000-0000-000000000001');
  });

  it('seeds the claimed set from existing bindings so a newly-unbound process cannot steal an already-bound rollout', async () => {
    const cwd = '/Users/test/SeedTest';
    const only = join(dayDir, 'rollout-seed.jsonl');
    writeFileSync(
      only,
      `${JSON.stringify({ timestamp: T0.toISOString(), type: 'session_meta', payload: { id: 'c0dex-seed', cwd, originator: 'codex_exec' } })}\n`,
    );
    utimesSync(only, new Date(NOW - 10_000), new Date(NOW - 10_000));

    let currentPs = psLine(1700, T0, 'codex');
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === 'ps') return { stdout: currentPs, exitCode: 0 };
      if (cmd === 'lsof') {
        const pid = args[args.indexOf('-p') + 1];
        return pid === '1700' || pid === '1701'
          ? { stdout: `p${pid}\nfcwd\nn${cwd}\n`, exitCode: 0 }
          : { stdout: '', exitCode: 1 };
      }
      throw new Error(`unexpected ${cmd}`);
    };
    const d = createCodexLiveDetector({ codexHome: home, now: () => NOW, exec });
    const first = await d.scan();
    expect(first[0]?.sessionId).toBe('c0dex-seed');

    currentPs = [psLine(1700, T0, 'codex'), psLine(1701, T0, 'codex')].join('\n');
    const second = await d.scan();
    const byPid = new Map(second.map((p) => [p.pid, p]));
    expect(byPid.get(1700)?.sessionId).toBe('c0dex-seed');
    expect(byPid.get(1701)?.rolloutPath).toBeNull();
  });

  it('drops a binding and reports unresolved when the bound rollout file vanishes', async () => {
    const cwd = '/Users/test/VanishTest';
    const path = join(dayDir, 'rollout-vanish.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify({ timestamp: T0.toISOString(), type: 'session_meta', payload: { id: 'c0dex-vanish', cwd, originator: 'codex_exec' } })}\n`,
    );
    utimesSync(path, new Date(NOW - 10_000), new Date(NOW - 10_000));

    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(psLine(1800, T0, 'codex'), { '1800': cwd }),
    });
    const first = await d.scan();
    expect(first[0]?.sessionId).toBe('c0dex-vanish');

    rmSync(path);
    const second = await d.scan();
    expect(second[0]).toMatchObject({
      rolloutPath: null,
      sessionId: null,
      originator: null,
      lastWriteMs: null,
    });

    // Reporting nulls once is true whether or not the binding was actually *dropped* — a
    // detector that kept the dead binding would report nulls too, simply because the `stat`
    // keeps failing. What discriminates is a third scan after a rollout is back at that path:
    // only a genuinely dropped binding sends the process back through the search and picks up
    // the new session's identity, instead of replaying the stale cached one.
    writeFileSync(
      path,
      `${JSON.stringify({ timestamp: T0.toISOString(), type: 'session_meta', payload: { id: 'c0dex-vanish-restored', cwd, originator: 'codex_exec' } })}\n`,
    );
    utimesSync(path, new Date(NOW), new Date(NOW));
    const third = await d.scan();
    expect(third[0]).toMatchObject({ rolloutPath: path, sessionId: 'c0dex-vanish-restored' });
  });

  it('re-reads a bound rollout whose cached sessionId/originator are still null, self-healing a partial-write binding', async () => {
    const cwd = '/Users/test/HealTest';
    const path = join(dayDir, 'rollout-partial.jsonl');
    // Simulates a first line caught mid-write: `cwd` (and `type`/`timestamp`) have been flushed,
    // but the `id`/`originator` keys haven't been written yet — enough for the regex fallback to
    // bind against (matches this process's cwd), but not enough to know the session's identity.
    const partial = `{"timestamp":"${T0.toISOString()}","type":"session_meta","payload":{"cwd":"${cwd}"`;
    writeFileSync(path, `${partial}\n`);
    utimesSync(path, new Date(NOW - 10_000), new Date(NOW - 10_000));

    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(psLine(2300, T0, 'codex'), { '2300': cwd }),
    });
    const first = await d.scan();
    expect(first[0]).toMatchObject({ rolloutPath: path, sessionId: null, originator: null });

    // The write completes and the mtime advances; a bound-but-null binding must re-read.
    writeFileSync(
      path,
      `${JSON.stringify({ timestamp: T0.toISOString(), type: 'session_meta', payload: { id: 'c0dex-healed', cwd, originator: 'codex_exec' } })}\n`,
    );
    utimesSync(path, new Date(NOW), new Date(NOW));
    const second = await d.scan();
    expect(second[0]).toMatchObject({ sessionId: 'c0dex-healed', originator: 'codex_exec' });
  });

  it('re-reads a bound rollout when only its originator is still null, not just when both fields are', async () => {
    // The test above truncates before *both* `id` and `originator`, so it passes under either
    // `sessionId === null || originator === null` or an `&&`. A real first line writes its keys
    // in the fixture's order (id, session_id, cwd, cli_version, model_provider, originator), so
    // the much more likely mid-write snapshot is one truncated *after* `cwd` and before
    // `originator`: sessionId already known, originator not. Only `||` heals that.
    const cwd = '/Users/test/HealOrTest';
    const path = join(dayDir, 'rollout-partial-originator.jsonl');
    const partial =
      `{"timestamp":"${T0.toISOString()}","type":"session_meta","payload":` +
      `{"id":"c0dex-half","session_id":"c0dex-half","cwd":"${cwd}","cli_version":"0.152.1","model_provider":"openai"`;
    writeFileSync(path, `${partial}\n`);
    utimesSync(path, new Date(NOW - 10_000), new Date(NOW - 10_000));

    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(psLine(2310, T0, 'codex'), { '2310': cwd }),
    });
    const first = await d.scan();
    expect(first[0]).toMatchObject({ rolloutPath: path, sessionId: 'c0dex-half', originator: null });

    writeFileSync(
      path,
      `${JSON.stringify({ timestamp: T0.toISOString(), type: 'session_meta', payload: { id: 'c0dex-half', session_id: 'c0dex-half', cwd, cli_version: '0.152.1', model_provider: 'openai', originator: 'codex_exec' } })}\n`,
    );
    utimesSync(path, new Date(NOW), new Date(NOW));
    const second = await d.scan();
    expect(second[0]).toMatchObject({ sessionId: 'c0dex-half', originator: 'codex_exec' });
  });

  it('resolves a contested rollout for the earliest-started process, whatever order ps listed them in', async () => {
    // One rollout, two same-cwd processes, and `ps` deliberately lists the *later*-started one
    // first — the opposite of the order `scan` sorts into. The rollout was started at the same
    // instant as the earlier process, so it is that process's session; the later process can only
    // reach it through the newest-mtime fallback, and does so if bindings are assigned in raw
    // `ps` order instead of start-time order.
    const cwd = '/Users/test/ProcSortTest';
    const only = join(dayDir, 'rollout-procsort.jsonl');
    writeFileSync(
      only,
      `${JSON.stringify({ timestamp: T0.toISOString(), type: 'session_meta', payload: { id: 'c0dex-procsort', cwd, originator: 'codex_exec' } })}\n`,
    );
    utimesSync(only, new Date(NOW - 5_000), new Date(NOW - 5_000));

    const ps = [psLine(2500, T1, 'codex'), psLine(2400, T0, 'codex')].join('\n');
    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(ps, { '2400': cwd, '2500': cwd }),
    });
    const out = await d.scan();
    const bound = out.filter((p) => p.rolloutPath !== null);
    expect(bound.map((p) => p.pid)).toEqual([2400]);
    expect(bound[0]?.sessionId).toBe('c0dex-procsort');
  });

  it('breaks a same-start-time contest by the lower pid, whatever order ps listed them in', async () => {
    // Same setup, but both processes started in the same second, so only the `|| a.pid - b.pid`
    // tie-break decides. `ps` lists the higher pid first; without the tie-break the sort is
    // stable on equal start times and that raw order would decide instead.
    const cwd = '/Users/test/PidSortTest';
    const only = join(dayDir, 'rollout-pidsort.jsonl');
    writeFileSync(
      only,
      `${JSON.stringify({ timestamp: T0.toISOString(), type: 'session_meta', payload: { id: 'c0dex-pidsort', cwd, originator: 'codex_exec' } })}\n`,
    );
    utimesSync(only, new Date(NOW - 5_000), new Date(NOW - 5_000));

    const ps = [psLine(2601, T0, 'codex'), psLine(2600, T0, 'codex')].join('\n');
    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(ps, { '2600': cwd, '2601': cwd }),
    });
    const out = await d.scan();
    const bound = out.filter((p) => p.rolloutPath !== null);
    expect(bound.map((p) => p.pid)).toEqual([2600]);
    expect(bound[0]?.sessionId).toBe('c0dex-pidsort');
  });

  it('floors mtimeMs to an integer, both when first picking a rollout and when re-stat-ing a bound one', async () => {
    // A whole-millisecond `utimesSync` write round-trips back through `stat` as an exact integer
    // on this filesystem (measured), so every rollout this file stamps with `utimesSync` has an
    // integer `mtimeMs` and can never show a missing `Math.floor`. Only a *natural* mtime — the
    // one the kernel stamps on a plain `writeFileSync` — carries the sub-millisecond precision
    // that makes `stat().mtimeMs` fractional, so this rollout is deliberately left untouched.
    // `mtime_ms` is an INTEGER column downstream, so both sites that surface it must floor.
    const cwd = '/Users/test/FloorTest';
    const path = join(dayDir, 'rollout-floor.jsonl');
    // A partial first line (`cwd` flushed, `id`/`originator` not yet) is enough to bind on but
    // leaves the binding's identity null, which forces the bound-but-null re-read through
    // `metaFor` below — the only place the candidate-side floor is observable.
    const partial = `{"timestamp":"${T0.toISOString()}","type":"session_meta","payload":{"cwd":"${cwd}"`;
    let naturalMtimeMs = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      writeFileSync(path, `${partial}\n`);
      naturalMtimeMs = statSync(path).mtimeMs;
      if (!Number.isInteger(naturalMtimeMs)) break;
    }
    // Stated as an assertion, not a comment, so the day this stops being true the test fails
    // loudly instead of quietly passing for no reason.
    expect(Number.isInteger(naturalMtimeMs)).toBe(false);

    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(psLine(2100, T0, 'codex'), { '2100': cwd }),
    });
    openCalls.mockClear();
    const first = await d.scan();
    expect(first[0]?.rolloutPath).toBe(path); // it really bound to the fractional-mtime rollout
    expect(first[0]?.lastWriteMs).toBe(Math.floor(naturalMtimeMs));
    expect(Number.isInteger(first[0]?.lastWriteMs)).toBe(true);
    expect(first[0]?.sessionId).toBeNull();
    // The candidate sweep keys `metaFor`'s cache by the floored mtime and the bound re-read looks
    // it up by the floored re-`stat` — the same integer, so this rollout is opened exactly once.
    // Drop either floor and the two keys disagree by a fraction of a millisecond, the cache
    // misses, and the file is read a second time on this very scan.
    expect(openCalls.mock.calls.filter((c) => c[0] === path)).toHaveLength(1);

    const second = await d.scan();
    expect(second[0]?.lastWriteMs).toBe(Math.floor(naturalMtimeMs));
    expect(Number.isInteger(second[0]?.lastWriteMs)).toBe(true);
  });

  it('sorts directory entries before iterating, so a tie is broken deterministically rather than by readdir order', async () => {
    const cwd = '/Users/test/SortTest';
    const entries: Array<[string, string]> = [
      [join(dayDir, 'rollout-zzz.jsonl'), 'c0dex-zzz'],
      [join(dayDir, 'rollout-aaa.jsonl'), 'c0dex-aaa'],
    ];
    for (const [path, id] of entries) {
      writeFileSync(
        path,
        `${JSON.stringify({ timestamp: T0.toISOString(), type: 'session_meta', payload: { id, cwd, originator: 'codex_exec' } })}\n`,
      );
      utimesSync(path, new Date(NOW - 10_000), new Date(NOW - 10_000));
    }
    // Force readdir to report the alphabetically-later entry first — the opposite of what
    // `names.sort()` would produce — so the tie-break can only land on 'aaa' if the code
    // actually sorts, not because of whatever order the real filesystem happens to return.
    type ReaddirFn = (dir: string) => Promise<string[]>;
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const actualReaddir = actualFs.readdir as ReaddirFn;
    const mockedReaddir = fsPromises.readdir as unknown as { mockImplementation: (fn: ReaddirFn) => void };
    mockedReaddir.mockImplementation(async (dir) => {
      const names = await actualReaddir(dir);
      return [...names].reverse();
    });
    try {
      const d = createCodexLiveDetector({
        codexHome: home,
        now: () => NOW,
        exec: fakeExec(psLine(2200, T0, 'codex'), { '2200': cwd }),
      });
      const out = await d.scan();
      expect(out[0]?.sessionId).toBe('c0dex-aaa');
    } finally {
      mockedReaddir.mockImplementation(actualReaddir);
    }
  });
});
