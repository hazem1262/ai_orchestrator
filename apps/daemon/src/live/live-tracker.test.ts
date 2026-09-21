import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrcConfig } from '@orc/api-contract';
import type { LiveState } from '@orc/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePty } from '../../test/fake-pty.ts';
import { createTestContext, indexFixtures, type TestContext, useTempHomes } from '../../test/helpers.ts';
import type { CodexLiveProc } from '../collectors/codex/live.ts';
import { latestTestResult } from '../db/repos/test-results.ts';
import type { BusEvent } from './event-bus.ts';
import { createTranscriptFinder } from './find-transcript.ts';
import {
  contextWindowForUsage,
  createLiveTracker,
  type LiveTracker,
  mapHookToStatus,
  refoldUpTo,
  usedTokensOfRecord,
} from './live-tracker.ts';
import { createRegistryWatcher } from './registry-watcher.ts';

const homes = useTempHomes();
let ctx: TestContext;
let tracker: LiveTracker;
let events: BusEvent[];
let alive: Set<number>;
let aliveChecks: Array<[number, string | null | undefined]>;
let codexProcs: CodexLiveProc[];
let nowMs: number;
let pty: ReturnType<typeof createFakePty>;
let cfg: OrcConfig;

const T0 = Date.parse('2026-09-01T09:10:00.000Z');
const EVENT_TYPES = [
  'session.updated',
  'session.removed',
  'session.statusChanged',
  'session.turnEnded',
  'tests.recorded',
] as const;

const reg = (
  pid: number,
  sessionId: string,
  status: string,
  at: number,
  extra: Record<string, unknown> = {},
) =>
  writeFileSync(
    join(homes.claudeHome, 'sessions', `${pid}.json`),
    JSON.stringify({
      pid,
      procStart: 'P',
      sessionId,
      cwd: '/Users/test/Wakecap',
      startedAt: T0,
      status,
      statusUpdatedAt: at,
      updatedAt: at,
      ...extra,
    }),
  );
const transcriptFor = (sessionId: string) =>
  join(homes.claudeHome, 'projects/-Users-test-Wakecap', `${sessionId}.jsonl`);
const transcript = () => transcriptFor('s-basic');
const line = (o: Record<string, unknown>, sessionId = 's-basic') =>
  `${JSON.stringify({ parentUuid: null, sessionId, cwd: '/Users/test/Wakecap', ...o })}\n`;
const of = <T extends BusEvent['type']>(t: T) =>
  events.filter((e): e is Extract<BusEvent, { type: T }> => e.type === t);

beforeEach(async () => {
  pty = createFakePty();
  ctx = createTestContext({ homes, pty });
  const base = ctx.config();
  // `pollMs` is pushed far out so nothing but an explicit `refresh()` drives a pass: these tests
  // control the clock, and a background tick would make their assertions order-dependent.
  cfg = { ...base, live: { ...base.live, pollMs: 60_000, endedRetentionMin: 1, codexBusyWindowMs: 10_000 } };
  ctx.config = () => cfg;
  events = [];
  for (const t of EVENT_TYPES) ctx.bus.on(t, (e) => events.push(e));
  alive = new Set([41001]);
  aliveChecks = [];
  codexProcs = [];
  nowMs = T0;
  tracker = createLiveTracker(ctx, {
    registry: createRegistryWatcher({
      dir: join(homes.claudeHome, 'sessions'),
      watch: false,
      pollMs: 60_000,
    }),
    liveness: {
      isAlive: async (pid, procStart) => {
        aliveChecks.push([pid, procStart]);
        return alive.has(pid);
      },
    },
    codex: { scan: async () => codexProcs },
    now: () => new Date(nowMs),
  });
  await tracker.start();
});
afterEach(async () => {
  await tracker.stop();
  ctx.dispose();
});

describe('LiveTracker (claude)', () => {
  it('shows the fixture session as waiting, observed, with transcript details', () => {
    const s = tracker.get('claude:s-basic');
    expect(s?.live).toMatchObject({
      pid: 41001,
      status: 'waiting',
      waitingFor: 'input needed',
      ownership: 'observed',
      ptyId: null,
      currentTool: 'Edit',
    });
    expect(s?.lastTest?.passed).toBe(18);
    expect(tracker.list().map((x) => `${x.source}:${x.id}`)).toEqual(['claude:s-basic']);
    expect(of('session.updated').at(-1)?.session.live?.status).toBe('waiting');
  });

  it('seeds pre-existing sessions without announcing a status change or old-history effects', () => {
    // Spike S3: `statusUpdatedAt` on an entry that was already running when the daemon started is
    // the AGE of the change, not a detection delay. Announcing these would fire the whole board's
    // worth of notifications on every restart. Test rows are still written; events are not sent.
    expect(of('session.statusChanged')).toEqual([]);
    expect(of('tests.recorded')).toHaveLength(0);
    expect(of('session.turnEnded')).toHaveLength(0);
    expect(latestTestResult(ctx.db, 'claude:s-basic')?.passed).toBe(18);
  });

  it('derives review after a turn with edits and emits turn/test events', async () => {
    appendFileSync(
      transcript(),
      line({
        type: 'user',
        uuid: 'n1',
        timestamp: '2026-09-01T09:11:00.000Z',
        message: { role: 'user', content: 'fix it' },
      }),
    );
    appendFileSync(
      transcript(),
      line({
        type: 'assistant',
        uuid: 'n2',
        timestamp: '2026-09-01T09:11:05.000Z',
        message: {
          id: 'mx',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [
            { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/Users/test/Wakecap/b.ts' } },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm vitest run' } },
          ],
        },
      }),
    );
    appendFileSync(
      transcript(),
      line({
        type: 'user',
        uuid: 'n3',
        timestamp: '2026-09-01T09:11:30.000Z',
        toolUseResult: {},
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: '      Tests  1 failed | 17 passed (18)' },
          ],
        },
      }),
    );
    appendFileSync(
      transcript(),
      line({
        type: 'system',
        subtype: 'turn_duration',
        uuid: 'n4',
        timestamp: '2026-09-01T09:11:31.000Z',
        durationMs: 31000,
      }),
    );
    nowMs = T0 + 60_000;
    reg(41001, 's-basic', 'idle', nowMs);
    await tracker.refresh();
    const s = tracker.get('claude:s-basic');
    expect(s?.live).toMatchObject({
      status: 'review',
      stage: 'review',
      since: new Date(nowMs).toISOString(),
    });
    expect(s?.lastPrompt).toBe('fix it');
    expect(of('session.statusChanged').at(-1)).toEqual({
      type: 'session.statusChanged',
      pk: 'claude:s-basic',
      from: 'waiting',
      to: 'review',
    });
    expect(of('session.turnEnded')).toEqual([{ type: 'session.turnEnded', pk: 'claude:s-basic', turn: 4 }]);
    expect(of('tests.recorded')).toHaveLength(1);
    expect(of('tests.recorded')[0]?.result.failed).toBe(1);
  });

  it('marks dead pids ended and removes them after the retention window', async () => {
    alive.clear();
    nowMs = T0 + 1000;
    await tracker.refresh();
    expect(tracker.get('claude:s-basic')?.live?.status).toBe('ended');
    nowMs = T0 + 1000 + 61_000;
    await tracker.refresh();
    expect(tracker.list()).toEqual([]);
    expect(of('session.removed')).toEqual([{ type: 'session.removed', pk: 'claude:s-basic' }]);
    // The registry file is still on disk (the app never deletes it), so without the dismissed-pid
    // memory the very next pass would resurrect the card.
    await tracker.refresh();
    expect(tracker.list()).toEqual([]);
    expect(of('session.removed')).toHaveLength(1);
  });

  it('passes procStart to the liveness check so a recycled pid cannot resurrect a card', async () => {
    // The registry file outlives its process; the pid alone is not an identity.
    expect(aliveChecks).toContainEqual([41001, 'Mon Sep  1 09:00:00 2026']);
    reg(41002, 's-two', 'busy', T0, { procStart: 'Tue Sep  2 10:00:00 2026' });
    await tracker.refresh();
    expect(aliveChecks).toContainEqual([41002, 'Tue Sep  2 10:00:00 2026']);
  });

  it('builds a stub for sessions that are not indexed yet', async () => {
    reg(41009, 's-new', 'busy', T0, { name: 'brand-new' });
    alive.add(41009);
    await tracker.refresh();
    const s = tracker.get('claude:s-new');
    expect(s).toMatchObject({
      id: 's-new',
      source: 'claude',
      name: 'brand-new',
      startCwd: '/Users/test/Wakecap',
      projectId: 'wakecap',
    });
    expect(s?.live?.status).toBe('busy');
    expect(of('session.updated').some((e) => e.session.id === 's-new')).toBe(true);
  });

  it('marks sessions owned when a live PTY has the pid', async () => {
    pty.infos.push({
      id: 'pty-9',
      sessionPk: null,
      command: 'claude',
      args: [],
      cwd: '/Users/test/Wakecap',
      pid: 41001,
      startedAt: '',
      exitedAt: null,
      exitCode: null,
      cols: 80,
      rows: 24,
    });
    await tracker.refresh();
    expect(tracker.get('claude:s-basic')?.live).toMatchObject({ ownership: 'owned', ptyId: 'pty-9' });
  });

  it('marks sessions owned when a live PTY carries the sessionPk but a different pid', async () => {
    // The ownership rule has two arms and this is the one that matters in practice: `PtyInfo.pid`
    // is the pid of whatever we spawned, which for a wrapper/shim is not the `claude` process the
    // registry names. Without this arm the board would show `observed` for a terminal we own and
    // refuse to send input to it.
    pty.infos.push({
      id: 'pty-shim',
      sessionPk: 'claude:s-basic',
      command: 'claude',
      args: [],
      cwd: '/Users/test/Wakecap',
      pid: 99999,
      startedAt: '',
      exitedAt: null,
      exitCode: null,
      cols: 80,
      rows: 24,
    });
    await tracker.refresh();
    expect(tracker.get('claude:s-basic')?.live).toMatchObject({ ownership: 'owned', ptyId: 'pty-shim' });
  });

  it('ignores an exited PTY when deciding ownership', async () => {
    pty.infos.push({
      id: 'pty-dead',
      sessionPk: 'claude:s-basic',
      command: 'claude',
      args: [],
      cwd: '/Users/test/Wakecap',
      pid: 41001,
      startedAt: '',
      exitedAt: '2026-09-01T09:05:00.000Z',
      exitCode: 0,
      cols: 80,
      rows: 24,
    });
    await tracker.refresh();
    expect(tracker.get('claude:s-basic')?.live).toMatchObject({ ownership: 'observed', ptyId: null });
  });

  it('lets a newer hook override the registry status', async () => {
    reg(41001, 's-basic', 'busy', T0 + 1000);
    await tracker.refresh();
    expect(tracker.get('claude:s-basic')?.live?.status).toBe('busy');
    tracker.applyHook({
      sessionId: 's-basic',
      event: 'Notification',
      message: 'Claude needs permission',
      ts: new Date(T0 + 2000).toISOString(),
    });
    await tracker.refresh();
    expect(tracker.get('claude:s-basic')?.live).toMatchObject({
      status: 'waiting',
      waitingFor: 'Claude needs permission',
    });
    reg(41001, 's-basic', 'busy', T0 + 3000);
    await tracker.refresh();
    expect(tracker.get('claude:s-basic')?.live?.status).toBe('busy');
  });

  it('redacts waitingFor from the registry and from a hook message', async () => {
    // Free text out of a process we do not control, on the field Phase 1 already caught leaking.
    reg(41001, 's-basic', 'waiting', T0 + 1000, {
      waitingFor: 'approve: export ORC_FAKE_TOKEN=placeholder-not-real',
    });
    await tracker.refresh();
    const fromRegistry = tracker.get('claude:s-basic')?.live?.waitingFor ?? '';
    expect(fromRegistry).toContain('«redacted:secret»');
    expect(fromRegistry).not.toContain('placeholder-not-real');

    tracker.applyHook({
      sessionId: 's-basic',
      event: 'Notification',
      message: 'run with API_TOKEN=placeholder-not-real?',
      ts: new Date(T0 + 2000).toISOString(),
    });
    await tracker.refresh();
    const fromHook = tracker.get('claude:s-basic')?.live?.waitingFor ?? '';
    expect(fromHook).toContain('«redacted:secret»');
    expect(fromHook).not.toContain('placeholder-not-real');
  });

  it('clears waitingFor once the session is no longer waiting', async () => {
    expect(tracker.get('claude:s-basic')?.live?.waitingFor).toBe('input needed');
    reg(41001, 's-basic', 'busy', T0 + 1000);
    await tracker.refresh();
    expect(tracker.get('claude:s-basic')?.live?.waitingFor).toBeNull();
  });

  it('waits for a registry entry with a given pid', async () => {
    const p = tracker.waitForPid(41010, 2000);
    setTimeout(() => reg(41010, 's-launched', 'busy', T0), 150);
    alive.add(41010);
    await expect(p).resolves.toBe('s-launched');
    await expect(tracker.waitForPid(49999, 200)).resolves.toBeNull();
  });

  it('re-reads a compacted transcript from the start without re-raising its turns', async () => {
    // Claude rewrites a transcript on compaction and replaces it on `/clear`; the carried offset
    // then points past the end of a different file.
    writeFileSync(
      transcript(),
      line({
        type: 'user',
        uuid: 'c1',
        timestamp: '2026-09-01T09:12:00.000Z',
        message: { role: 'user', content: 'after compaction' },
      }),
    );
    await tracker.refresh();
    expect(tracker.get('claude:s-basic')?.lastPrompt).toBe('after compaction');
    expect(of('session.turnEnded')).toHaveLength(0);

    // Re-primed: a turn that ends *after* the replacement is a genuine event again.
    appendFileSync(
      transcript(),
      line({
        type: 'assistant',
        uuid: 'c2',
        timestamp: '2026-09-01T09:12:05.000Z',
        message: {
          id: 'mc',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [
            { type: 'tool_use', id: 'ce', name: 'Edit', input: { file_path: '/Users/test/Wakecap/c.ts' } },
          ],
        },
      }),
    );
    appendFileSync(
      transcript(),
      line({
        type: 'system',
        subtype: 'turn_duration',
        uuid: 'c3',
        timestamp: '2026-09-01T09:12:06.000Z',
        durationMs: 6000,
      }),
    );
    await tracker.refresh();
    expect(of('session.turnEnded')).toEqual([{ type: 'session.turnEnded', pk: 'claude:s-basic', turn: 1 }]);
  });
});

/**
 * The window a session runs with appears NOWHERE in a transcript (see `contextWindowForUsage`), so
 * these tests deliberately never write a window marker. They drive the inference the only way the
 * daemon can: through the usage numbers. The headline case is built from a real record.
 */
describe('LiveTracker persistence for indexed sessions', () => {
  const makeTracker = () =>
    createLiveTracker(ctx, {
      registry: createRegistryWatcher({
        dir: join(homes.claudeHome, 'sessions'),
        watch: false,
        pollMs: 60_000,
      }),
      liveness: { isAlive: async (pid) => alive.has(pid) },
      codex: { scan: async () => [] },
      now: () => new Date(nowMs),
    });

  it('persists live state through sessions.setLive and clears it when the entry is retired', async () => {
    await indexFixtures(ctx);
    expect(ctx.sessions.getByPk('claude:s-basic')).not.toBeNull(); // the guard's precondition
    const calls: Array<[string, LiveState | null]> = [];
    const real = ctx.sessions;
    ctx.sessions = {
      ...real,
      setLive: (pk, next) => {
        calls.push([pk, next]);
        real.setLive(pk, next);
      },
    };
    const t = makeTracker();
    try {
      await t.start();
      expect(calls.some(([pk, l]) => pk === 'claude:s-basic' && l !== null)).toBe(true);

      alive.clear();
      nowMs = T0 + 1000;
      await t.refresh();
      nowMs = T0 + 1000 + 61_000;
      await t.refresh();
      // Without this the removed session's live blob stays in the service's map and every list
      // route keeps rendering a ghost live card for a session the tracker has forgotten.
      expect(calls.at(-1)).toEqual(['claude:s-basic', null]);
    } finally {
      await t.stop();
      ctx.sessions = real;
    }
  });
});

describe('LiveTracker context window', () => {
  /**
   * Verbatim `message.usage` from the largest real assistant record in this machine's
   * `~/.claude/projects` (171 transcripts, 39,993 non-synthetic usage records). Note the model id:
   * plain `claude-opus-5`, no `[1m]`, on a record that consumed 999,591 context tokens.
   */
  const REAL_PEAK_USAGE = {
    input_tokens: 2,
    cache_read_input_tokens: 999_050,
    cache_creation_input_tokens: 539,
    output_tokens: 484,
  } as const;
  const REAL_PEAK_USED =
    REAL_PEAK_USAGE.input_tokens +
    REAL_PEAK_USAGE.cache_read_input_tokens +
    REAL_PEAK_USAGE.cache_creation_input_tokens;

  const usageLine = (uuid: string, used: number, ts: string, model = 'claude-opus-5') =>
    line(
      {
        type: 'assistant',
        uuid,
        timestamp: ts,
        message: {
          id: `m-${uuid}`,
          role: 'assistant',
          model,
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: used,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      's-ctx',
    );
  const realUsageLine = (uuid: string, ts: string) =>
    line(
      {
        type: 'assistant',
        uuid,
        timestamp: ts,
        message: {
          id: `m-${uuid}`,
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'ok' }],
          usage: REAL_PEAK_USAGE,
        },
      },
      's-ctx',
    );
  const prompt = line(
    {
      type: 'user',
      uuid: 'c0',
      timestamp: '2026-09-01T09:10:01.000Z',
      message: { role: 'user', content: 'measure me' },
    },
    's-ctx',
  );

  const startCtxSession = async (lines: string[]) => {
    writeFileSync(transcriptFor('s-ctx'), lines.join(''));
    reg(41020, 's-ctx', 'idle', T0);
    alive.add(41020);
    await tracker.refresh();
    return tracker.get('claude:s-ctx');
  };

  it('scales a real 999,591-token record against 1M instead of pinning the bar to full', async () => {
    // The regression test for fix round 1: with the window pinned at 200k this record computes
    // 999_591/200_000 = 5.0 and clamps to 1.0 — the board reads "out of context" on a session
    // that is 99.96% of the way through a 1M window, and read full for 64.4% of all real records.
    const s = await startCtxSession([prompt, realUsageLine('c1', '2026-09-01T09:10:02.000Z')]);
    expect(s?.live?.contextFill).toBeCloseTo(REAL_PEAK_USED / 1_000_000, 6);
    expect(s?.live?.contextFill).toBeLessThan(1);
  });

  it('uses the 200k rung while usage stays under it', async () => {
    const s = await startCtxSession([prompt, usageLine('c1', 150_000, '2026-09-01T09:10:02.000Z')]);
    expect(s?.live?.contextFill).toBeCloseTo(0.75, 10);
  });

  it('widens to the next rung on the very record that outgrows the current one', async () => {
    const s1 = await startCtxSession([prompt, usageLine('c1', 100_000, '2026-09-01T09:10:02.000Z')]);
    expect(s1?.live?.contextFill).toBeCloseTo(0.5, 10); // 100k / 200k
    appendFileSync(transcriptFor('s-ctx'), usageLine('c2', 300_000, '2026-09-01T09:10:03.000Z'));
    await tracker.refresh();
    const s2 = tracker.get('claude:s-ctx');
    expect(s2?.live?.contextFill).toBeCloseTo(0.3, 10); // 300k / 1M, not clamped to 1
    // The reducer was rebuilt, not reset: state folded before the switch survives.
    expect(s2?.lastPrompt).toBe('measure me');
  });

  it('never narrows the window when a later turn uses less', async () => {
    const s = await startCtxSession([
      prompt,
      usageLine('c1', 300_000, '2026-09-01T09:10:02.000Z'),
      usageLine('c2', 50_000, '2026-09-01T09:10:03.000Z'),
    ]);
    // Peak is sticky: 50k against the 1M window the session has proved it has, not against 200k.
    expect(s?.live?.contextFill).toBeCloseTo(0.05, 10);
  });

  it('uses the observed peak itself, and warns once, above the largest known window', async () => {
    const warnings: object[] = [];
    ctx.log = { ...ctx.log, warn: (o: object) => warnings.push(o) } as typeof ctx.log;
    // TWO over-ladder records, each of which widens the window again (1.1M -> 1.25M, 1.4M -> 1.5M),
    // so the dedupe is actually exercised rather than trivially satisfied by there being one.
    const s = await startCtxSession([
      prompt,
      usageLine('c1', 1_100_000, '2026-09-01T09:10:02.000Z'),
      usageLine('c2', 1_400_000, '2026-09-01T09:10:03.000Z'),
    ]);
    // Rounded up to the next 250k step, so this is honest headroom rather than a silent clamp.
    expect(s?.live?.contextFill).toBeCloseTo(1_400_000 / 1_500_000, 10);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ pk: 'claude:s-ctx', peakUsed: 1_100_000 });
  });

  it('reports an honest 1.0 only when the peak lands exactly on a step', async () => {
    const s = await startCtxSession([prompt, usageLine('c1', 2_500_000, '2026-09-01T09:10:02.000Z')]);
    expect(s?.live?.contextFill).toBe(1);
  });

  it('keeps the peak across a pid change, so `claude --resume` cannot narrow the window', async () => {
    // `upsertEntry` builds a fresh Entry when the pid changes for the same sessionId — which is
    // every `--resume`. It carries the reducer and the window; if it dropped `peakUsed`, the next
    // small turn would look like a brand-new session and RATCHET THE WINDOW BACK DOWN, breaking
    // the one guarantee this design has.
    const s1 = await startCtxSession([prompt, usageLine('c1', 300_000, '2026-09-01T09:10:02.000Z')]);
    expect(s1?.live?.contextFill).toBeCloseTo(0.3, 10); // 300k / 1M

    rmSync(join(homes.claudeHome, 'sessions', '41020.json'));
    reg(41021, 's-ctx', 'idle', T0);
    alive.add(41021);
    await tracker.refresh();
    expect(tracker.get('claude:s-ctx')?.live?.pid).toBe(41021); // the pid really did change

    appendFileSync(transcriptFor('s-ctx'), usageLine('c2', 50_000, '2026-09-01T09:10:04.000Z'));
    await tracker.refresh();
    // 50k against the 1M window the session already proved it has — not 0.25 against a reset 200k.
    expect(tracker.get('claude:s-ctx')?.live?.contextFill).toBeCloseTo(0.05, 10);
  });

  it('does not re-apply the record that triggered the widen', async () => {
    // `refoldUpTo`'s end is exclusive, and the integration-level symptom of getting it wrong by a
    // whole batch is a *missing* turn event: the widened reducer would already have folded the
    // turn_duration record, so applying it again is a no-op and `turnEnded` never fires.
    writeFileSync(
      transcriptFor('s-ctx'),
      [
        prompt,
        usageLine('c1', 300_000, '2026-09-01T09:10:02.000Z'),
        line(
          {
            type: 'system',
            subtype: 'turn_duration',
            uuid: 'c9',
            timestamp: '2026-09-01T09:10:03.000Z',
            durationMs: 2000,
          },
          's-ctx',
        ),
      ].join(''),
    );
    reg(41020, 's-ctx', 'idle', T0);
    alive.add(41020);
    await tracker.refresh();
    expect(of('session.turnEnded')).toEqual([{ type: 'session.turnEnded', pk: 'claude:s-ctx', turn: 1 }]);
    expect(tracker.get('claude:s-ctx')?.live?.contextFill).toBeCloseTo(0.3, 10);
  });

  it('warns again for a session retired and re-created under a new pid', async () => {
    // `overLadderLogged` gates a one-shot warn per pk. Left populated by `remove()` it would grow
    // for the daemon's lifetime and, worse, permanently silence a session that comes back.
    const warnings: object[] = [];
    ctx.log = { ...ctx.log, warn: (o: object) => warnings.push(o) } as typeof ctx.log;
    await startCtxSession([prompt, usageLine('c1', 1_100_000, '2026-09-01T09:10:02.000Z')]);
    expect(warnings).toHaveLength(1);

    alive.delete(41020);
    nowMs = T0 + 1000;
    await tracker.refresh();
    nowMs = T0 + 1000 + 61_000;
    await tracker.refresh();
    expect(tracker.get('claude:s-ctx')).toBeNull();

    rmSync(join(homes.claudeHome, 'sessions', '41020.json'));
    reg(41021, 's-ctx', 'idle', nowMs);
    alive.add(41021);
    await tracker.refresh();
    expect(tracker.get('claude:s-ctx')?.live?.pid).toBe(41021);
    expect(warnings).toHaveLength(2);
  });

  it('ignores a <synthetic> record when sizing the window', async () => {
    const s = await startCtxSession([
      prompt,
      usageLine('c1', 100_000, '2026-09-01T09:10:02.000Z'),
      usageLine('c2', 900_000, '2026-09-01T09:10:03.000Z', '<synthetic>'),
    ]);
    // `<synthetic>` usage is not real context, and `createLiveReducer` ignores it too.
    expect(s?.live?.contextFill).toBeCloseTo(0.5, 10);
  });

  it('maps peak usage onto the ladder, then onto a coarse step above it', () => {
    expect(contextWindowForUsage(0)).toBe(200_000);
    expect(contextWindowForUsage(200_000)).toBe(200_000);
    expect(contextWindowForUsage(200_001)).toBe(1_000_000);
    expect(contextWindowForUsage(999_591)).toBe(1_000_000);
    // Above the ladder the peak is rounded UP to the next 250k step, so the window changes about
    // once per 250k tokens of growth rather than on every record — each change re-reads the whole
    // transcript. Rounding up keeps window >= peak, so the guarantee is untouched.
    expect(contextWindowForUsage(1_000_001)).toBe(1_250_000);
    expect(contextWindowForUsage(1_250_000)).toBe(1_250_000);
    expect(contextWindowForUsage(1_250_001)).toBe(1_500_000);
    expect(contextWindowForUsage(2_500_000)).toBe(2_500_000);
    for (const peak of [1_000_001, 1_300_000, 2_000_123, 9_999_999]) {
      expect(contextWindowForUsage(peak)).toBeGreaterThanOrEqual(peak);
    }
  });

  it('reads context tokens off a record the same way the reducer does', () => {
    expect(usedTokensOfRecord(JSON.parse(realUsageLine('x', 'T')))).toBe(REAL_PEAK_USED);
    expect(usedTokensOfRecord(JSON.parse(usageLine('x', 5, 'T', '<synthetic>')))).toBeNull();
    expect(usedTokensOfRecord(JSON.parse(prompt))).toBeNull();
    expect(usedTokensOfRecord(undefined)).toBeNull();
  });
});

describe('refoldUpTo', () => {
  it('excludes the line that starts exactly at upToOffset', async () => {
    // The contract the tracker depends on: the caller widens the window on a record it has not
    // applied yet, so folding that record here would apply it twice. Pinned directly because the
    // reducer's assistant branch is idempotent, which makes the off-by-one invisible through the
    // only caller that exists — a mutant flipping `>=` to `>` survives every integration test.
    const path = transcriptFor('s-fold');
    const first = line(
      {
        type: 'user',
        uuid: 'f1',
        timestamp: '2026-09-01T09:10:01.000Z',
        message: { role: 'user', content: 'first' },
      },
      's-fold',
    );
    const second = line(
      {
        type: 'user',
        uuid: 'f2',
        timestamp: '2026-09-01T09:10:02.000Z',
        message: { role: 'user', content: 'second' },
      },
      's-fold',
    );
    writeFileSync(path, first + second);
    const boundary = Buffer.byteLength(first);

    const upTo = (await refoldUpTo(path, boundary, 200_000)).snapshot();
    expect(upTo.turn).toBe(1);
    expect(upTo.lastPrompt).toBe('first');

    const whole = (await refoldUpTo(path, boundary + Buffer.byteLength(second), 200_000)).snapshot();
    expect(whole.turn).toBe(2);
    expect(whole.lastPrompt).toBe('second');
  });

  it('returns an empty reducer at offset 0 and survives an unreadable file', async () => {
    const empty = (await refoldUpTo(transcriptFor('s-basic'), 0, 200_000)).snapshot();
    expect(empty.turn).toBe(0);
    const missing = (await refoldUpTo(join(homes.root, 'nope.jsonl'), 500, 200_000)).snapshot();
    expect(missing.turn).toBe(0);
  });
});

describe('LiveTracker (codex)', () => {
  it('shows codex sessions as busy while the rollout is being written', async () => {
    codexProcs = [
      {
        pid: 700,
        cwd: '/Users/test/Wakecap',
        startedAtMs: T0,
        rolloutPath: '/r1',
        sessionId: 'c0dex000-0000-0000-0000-000000000001',
        originator: 'codex_exec',
        lastWriteMs: T0 - 1000,
      },
      {
        pid: 701,
        cwd: '/Users/test/hackathon',
        startedAtMs: T0,
        rolloutPath: '/r2',
        sessionId: 'auto-1',
        originator: 'codex_sdk_ts',
        lastWriteMs: T0,
      },
      {
        pid: 702,
        cwd: '/Users/test/Wakecap',
        startedAtMs: T0,
        rolloutPath: null,
        sessionId: null,
        originator: null,
        lastWriteMs: null,
      },
    ];
    await tracker.refresh();
    expect(tracker.get('codex:c0dex000-0000-0000-0000-000000000001')?.live?.status).toBe('busy');
    expect(tracker.get('codex:auto-1')).toBeNull();
    // The unresolved process (702) is skipped entirely: no card, no synthetic pk.
    expect(tracker.list().map((s) => `${s.source}:${s.id}`)).toEqual([
      'claude:s-basic',
      'codex:c0dex000-0000-0000-0000-000000000001',
    ]);
    nowMs = T0 + 20_000;
    await tracker.refresh();
    expect(tracker.get('codex:c0dex000-0000-0000-0000-000000000001')?.live?.status).toBe('idle');
    codexProcs = [];
    await tracker.refresh();
    expect(tracker.get('codex:c0dex000-0000-0000-0000-000000000001')?.live?.status).toBe('ended');
  });

  it('warns once per unresolved codex process, at a level the daemon actually logs', async () => {
    // The stated mitigation for "skipped, so it renders as nothing" is a log line. At `debug` it
    // is invisible at the daemon's default level (`ORC_LOG_LEVEL ?? 'info'`), i.e. not a
    // mitigation at all.
    const warnings: object[] = [];
    ctx.log = { ...ctx.log, warn: (o: object) => warnings.push(o) } as typeof ctx.log;
    codexProcs = [
      {
        pid: 702,
        cwd: '/Users/test/Wakecap',
        startedAtMs: T0,
        rolloutPath: null,
        sessionId: null,
        originator: null,
        lastWriteMs: null,
      },
    ];
    await tracker.refresh();
    await tracker.refresh();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ pid: 702, cwd: '/Users/test/Wakecap' });
  });

  it('warns again once an unresolved codex process goes away and comes back', async () => {
    // The dedupe set is keyed on processes that never become entries, so `remove()` can never
    // prune it. Pruned against what each sweep saw instead: bounded, and not permanently silent.
    const warnings: object[] = [];
    ctx.log = { ...ctx.log, warn: (o: object) => warnings.push(o) } as typeof ctx.log;
    const unresolved = {
      pid: 702,
      cwd: '/Users/test/Wakecap',
      startedAtMs: T0,
      rolloutPath: null,
      sessionId: null,
      originator: null,
      lastWriteMs: null,
    } satisfies CodexLiveProc;
    codexProcs = [unresolved];
    await tracker.refresh();
    codexProcs = [];
    await tracker.refresh();
    codexProcs = [unresolved];
    await tracker.refresh();
    expect(warnings).toHaveLength(2);
  });

  it('shows an automated codex session when codex.showAutomated is on', async () => {
    cfg = { ...cfg, codex: { ...cfg.codex, showAutomated: true } };
    codexProcs = [
      {
        pid: 701,
        cwd: '/Users/test/hackathon',
        startedAtMs: T0,
        rolloutPath: '/r2',
        sessionId: 'auto-1',
        originator: 'codex_sdk_ts',
        lastWriteMs: T0,
      },
    ];
    await tracker.refresh();
    expect(tracker.get('codex:auto-1')?.live?.status).toBe('busy');
  });

  it('survives a failing codex scan without losing the claude sessions', async () => {
    const failing = createLiveTracker(ctx, {
      registry: createRegistryWatcher({
        dir: join(homes.claudeHome, 'sessions'),
        watch: false,
        pollMs: 60_000,
      }),
      liveness: { isAlive: async (pid) => alive.has(pid) },
      codex: {
        scan: async () => {
          throw new Error('ps exploded');
        },
      },
      now: () => new Date(nowMs),
    });
    await failing.start();
    expect(failing.get('claude:s-basic')?.live?.status).toBe('waiting');
    await failing.stop();
  });
});

/**
 * Spike S3 never observed a real `waiting` transition and Task 5 deferred the measurement here.
 * What this measures is the half of the path this repo owns and can measure honestly without
 * spawning a real `claude`: registry bytes hitting disk -> fs watcher -> tracker pass ->
 * `session.statusChanged`. The upstream half (Claude deciding it is waiting, then writing the
 * file) is NOT measured and cannot be from fixtures alone.
 *
 * Both tests below pin exactly one delivery path by disabling the other, so each one's bound means
 * something on its own. The previous version ran both paths at once and claimed a `< 1500ms` bound
 * proved the push path had delivered; it did not — the 2000ms poll is free-running, so a tick
 * landing early in the window could satisfy that bound too, and the test would have passed for the
 * wrong reason.
 *
 * The 100ms gap before the measured write is load-bearing and is itself a finding: chokidar v5
 * (fs.watch, no fsevents) coalesces two writes to the same path ~1ms apart into a single event, so
 * a transition written immediately after another is delivered only by the poll backstop. Real
 * transitions are seconds apart; back-to-back ones only happen in a test.
 */
describe('LiveTracker waiting-transition latency', () => {
  const driveToBusyThenMeasureWaiting = async (
    watcherOpts: { watch?: boolean; pollMs?: number },
    assertElapsed: (ms: number) => void,
  ) => {
    const watched = createLiveTracker(ctx, {
      registry: createRegistryWatcher({ dir: join(homes.claudeHome, 'sessions'), ...watcherOpts }),
      liveness: { isAlive: async (pid) => alive.has(pid) },
      codex: { scan: async () => [] },
    });
    const edges: string[] = [];
    const offEdges = ctx.bus.on('session.statusChanged', (e) => {
      if (e.pk === 'claude:s-basic') edges.push(e.to);
    });
    const nextStatus = (to: string) =>
      new Promise<number>((resolve, reject) => {
        const started = performance.now();
        const deadline = setTimeout(() => reject(new Error(`no ${to} within 8s`)), 8000);
        const stop = ctx.bus.on('session.statusChanged', (e) => {
          if (e.pk !== 'claude:s-basic' || e.to !== to) return;
          clearTimeout(deadline);
          stop();
          resolve(performance.now() - started);
        });
      });
    try {
      await watched.start();
      // Seeded as `waiting` from the fixture and announced to nobody, so drive it to `busy` first;
      // the measured edge is busy -> waiting, the one the product actually cares about.
      const toBusy = nextStatus('busy');
      reg(41001, 's-basic', 'busy', Date.now());
      await toBusy;
      await new Promise((r) => setTimeout(r, 100));

      const toWaiting = nextStatus('waiting');
      reg(41001, 's-basic', 'waiting', Date.now(), { waitingFor: 'input needed' });
      const elapsedMs = await toWaiting;

      expect(edges).toEqual(['busy', 'waiting']);
      expect(watched.get('claude:s-basic')?.live).toMatchObject({
        status: 'waiting',
        waitingFor: 'input needed',
      });
      assertElapsed(elapsedMs);
      if (process.env.ORC_MEASURE) {
        process.stdout.write(`[measure] busy->waiting detected in ${elapsedMs.toFixed(1)}ms\n`);
      }
    } finally {
      offEdges();
      await watched.stop();
    }
  };

  it('detects the transition through the fs watcher with the poll backstop disabled', async () => {
    // `pollMs: 60_000` removes the backstop entirely, so nothing but chokidar can answer inside
    // the bound. Measured repeatedly on this machine at 0.7-1.6ms; 500ms is ~300x headroom.
    await driveToBusyThenMeasureWaiting({ pollMs: 60_000 }, (ms) => expect(ms).toBeLessThan(500));
  });

  it('detects the transition through the poll backstop with the fs watcher disabled', async () => {
    // The mirror image, and the one that matters when chokidar coalesces or drops an event:
    // `watch: false` means there is no push path at all. Bounded below as well as above, so a
    // stray push path sneaking back in would fail this rather than silently satisfy it.
    await driveToBusyThenMeasureWaiting({ watch: false, pollMs: 250 }, (ms) => {
      expect(ms).toBeGreaterThan(1);
      expect(ms).toBeLessThan(2000);
    });
  });
});

describe('createTranscriptFinder', () => {
  it('finds a transcript under any encoded project dir and returns the same path on a repeat lookup', () => {
    const find = createTranscriptFinder(homes.claudeHome);
    expect(find('s-basic')).toBe(transcriptFor('s-basic'));
    expect(find('s-basic')).toBe(transcriptFor('s-basic'));
    expect(find('s-nope')).toBeNull();
  });

  it('refuses ids that could escape the projects directory', () => {
    // The id comes out of a file we do not own, and it is joined onto a path. `escaped.jsonl` is
    // placed exactly where `projects/<encoded>/../../escaped.jsonl` would resolve to, so dropping
    // the guard really would return it.
    writeFileSync(join(homes.claudeHome, 'escaped.jsonl'), '');
    expect(existsSync(join(homes.claudeHome, 'escaped.jsonl'))).toBe(true);
    const find = createTranscriptFinder(homes.claudeHome);
    expect(find('../../escaped')).toBeNull();
    expect(find('..')).toBeNull();
    expect(find('/absolute')).toBeNull();
    expect(find('')).toBeNull();
  });

  it('returns null when there is no projects directory at all', () => {
    expect(createTranscriptFinder(join(homes.root, 'missing'))('s-basic')).toBeNull();
  });
});

describe('mapHookToStatus', () => {
  it('maps hook events', () => {
    expect(mapHookToStatus('Notification')).toBe('waiting');
    expect(mapHookToStatus('UserPromptSubmit')).toBe('busy');
    expect(mapHookToStatus('PreToolUse')).toBe('busy');
    expect(mapHookToStatus('Stop')).toBe('idle');
    expect(mapHookToStatus('SessionStart')).toBeNull();
  });
});
