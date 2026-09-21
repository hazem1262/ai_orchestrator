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
  it('parses pid, local start time and command', () => {
    const p = parsePsLine(`  4242 ${lstart(T0)} /opt/homebrew/bin/codex --model gpt-5.5`);
    expect(p).toEqual({
      pid: 4242,
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
});

describe('createCodexLiveDetector', () => {
  it('matches each codex process to its own rollout', async () => {
    const ps = [
      `  100 ${lstart(T0)} codex`,
      `  200 ${lstart(T1)} /opt/homebrew/bin/codex`,
      `  300 ${lstart(T1)} node server.js`,
      `  400 ${lstart(T1)} codex app-server`,
      `  500 ${lstart(T1)} codex`,
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
      exec: fakeExec(`  700 ${lstart(later)} codex`, { '700': '/Users/test/Forza' }),
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
});
