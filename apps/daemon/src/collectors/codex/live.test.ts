import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecFn } from '../../live/liveness.ts';
import { createCodexLiveDetector, isCodexCommand, parsePsLine, readRolloutMeta } from './live.ts';

// `vi.spyOn` cannot redefine a live ESM export ("Module namespace is not configurable"), so
// `readdir` is wrapped through `vi.mock` instead. By default it's a transparent pass-through to
// the real implementation (every other test in this file relies on that); only the
// `names.sort()` test below swaps in a reversing implementation, then restores the pass-through.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

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
  home = mkdtempSync(join(tmpdir(), 'orc-codex-'));
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
      command: '/opt/homebrew/bin/codex --model gpt-5.5',
    });
    expect(parsePsLine('garbage')).toBeNull();
  });

  it.each([
    // Baseline: bare executable, session subcommands, non-session subcommands, non-codex.
    ['/opt/homebrew/bin/codex', true],
    ['codex resume abc', true],
    ['node /usr/local/lib/node_modules/@openai/codex/bin/codex.js exec "hi"', true],
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
    // Fixed instant chosen so local (this machine, UTC+3) and UTC calendar days diverge: UTC is
    // still Sep 1, local is already Sep 2. The rollout lives only under the UTC-dated directory;
    // a local-date-only lookup would miss it entirely.
    const crossMidnight = new Date('2026-09-01T22:30:00.000Z');
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

  it('reuses a bound rollout across scans without re-searching, and refreshes lastWriteMs', async () => {
    const ps = psLine(1200, T0, 'codex');
    let lsofCalls = 0;
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === 'ps') return { stdout: ps, exitCode: 0 };
      if (cmd === 'lsof') {
        lsofCalls += 1;
        const pid = args[args.indexOf('-p') + 1];
        return pid === '1200'
          ? { stdout: 'p1200\nfcwd\nn/Users/test/Wakecap\n', exitCode: 0 }
          : { stdout: '', exitCode: 1 };
      }
      throw new Error(`unexpected ${cmd}`);
    };
    const d = createCodexLiveDetector({ codexHome: home, now: () => NOW, exec });
    const first = await d.scan();
    expect(first[0]?.sessionId).toBe('c0dex000-0000-0000-0000-000000000001');
    expect(first[0]?.lastWriteMs).toBe(NOW - 10_000);

    utimesSync(
      join(dayDir, 'rollout-a-c0dex000-0000-0000-0000-000000000001.jsonl'),
      new Date(NOW),
      new Date(NOW),
    );
    const second = await d.scan();
    expect(second[0]?.sessionId).toBe('c0dex000-0000-0000-0000-000000000001');
    expect(second[0]?.lastWriteMs).toBe(NOW);
    expect(lsofCalls).toBe(2); // cwd is still resolved each scan; only the rollout search is skipped
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
    // If the binding cache were skipped, the second scan's fresh search would find and rebind to
    // the decoy (same cwd/start, much fresher mtime). Because the process is already bound after
    // the first scan, the second scan must never even look.
    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(psLine(1400, T0, 'codex'), { '1400': '/Users/test/Wakecap' }),
    });
    const first = await d.scan();
    expect(first[0]?.sessionId).toBe('c0dex000-0000-0000-0000-000000000001');

    const decoy = join(dayDir, 'rollout-decoy.jsonl');
    writeFileSync(
      decoy,
      `${JSON.stringify({ timestamp: T0.toISOString(), type: 'session_meta', payload: { id: 'c0dex-decoy', cwd: '/Users/test/Wakecap', originator: 'codex_exec' } })}\n`,
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

  it('floors mtimeMs to an integer, both when first picking a rollout and when re-stat-ing a bound one', async () => {
    // This filesystem stores mtimes with sub-millisecond precision that doesn't always round-trip
    // exactly through an integer-ms `utimesSync` write (verified independently), so a raw
    // `stat().mtimeMs` can come back fractional. `mtime_ms` is an INTEGER column downstream, so
    // both sites that surface it must floor.
    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(psLine(2100, T0, 'codex'), { '2100': '/Users/test/Wakecap' }),
    });
    const first = await d.scan();
    expect(Number.isInteger(first[0]?.lastWriteMs)).toBe(true);

    utimesSync(
      join(dayDir, 'rollout-a-c0dex000-0000-0000-0000-000000000001.jsonl'),
      new Date(NOW),
      new Date(NOW),
    );
    const second = await d.scan();
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
