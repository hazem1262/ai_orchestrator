import { copyFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExecFn } from '../../live/liveness.ts';
import { createCodexLiveDetector, isCodexCommand, parsePsLine, readRolloutMeta } from './live.ts';

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
    ['/opt/homebrew/bin/codex', true],
    ['codex resume abc', true],
    ['node /usr/local/lib/node_modules/@openai/codex/bin/codex.js exec "hi"', true],
    ['/Applications/Codex.app/codex app-server', false],
    ['codex mcp-server', false],
    ['/usr/bin/vim codex.md', false],
    ['node server.js', false],
    ['codex --cd /tmp mcp-server', false],
    ['codex -c model=x app-server', false],
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
});
