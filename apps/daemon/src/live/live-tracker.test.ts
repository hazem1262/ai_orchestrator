import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrcConfig } from '@orc/api-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePty } from '../../test/fake-pty.ts';
import { createTestContext, type TestContext, useTempHomes } from '../../test/helpers.ts';
import type { CodexLiveProc } from '../collectors/codex/live.ts';
import { latestTestResult } from '../db/repos/test-results.ts';
import type { BusEvent } from './event-bus.ts';
import { createTranscriptFinder } from './find-transcript.ts';
import { createLiveTracker, type LiveTracker, mapHookToStatus } from './live-tracker.ts';
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

describe('LiveTracker context window', () => {
  const usageLine = (uuid: string, model: string, input: number, ts: string) =>
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
            input_tokens: input,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
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

  it('computes contextFill against 1M for a [1m] model id', async () => {
    const s = await startCtxSession([
      prompt,
      usageLine('c1', 'claude-opus-5[1m]', 100_000, '2026-09-01T09:10:02.000Z'),
    ]);
    expect(s?.live?.contextFill).toBeCloseTo(0.1, 10);
  });

  it('computes contextFill against 200k for an ordinary model id', async () => {
    const s = await startCtxSession([
      prompt,
      usageLine('c1', 'claude-opus-5', 100_000, '2026-09-01T09:10:02.000Z'),
    ]);
    expect(s?.live?.contextFill).toBeCloseTo(0.5, 10);
  });

  it('re-folds carried state when the model changes mid-session', async () => {
    const s1 = await startCtxSession([
      prompt,
      usageLine('c1', 'claude-opus-5', 100_000, '2026-09-01T09:10:02.000Z'),
    ]);
    expect(s1?.live?.contextFill).toBeCloseTo(0.5, 10);
    appendFileSync(
      transcriptFor('s-ctx'),
      usageLine('c2', 'claude-sonnet-5[1m]', 100_000, '2026-09-01T09:10:03.000Z'),
    );
    await tracker.refresh();
    const s2 = tracker.get('claude:s-ctx');
    expect(s2?.live?.contextFill).toBeCloseTo(0.1, 10);
    // The reducer was rebuilt, not reset: state folded before the switch survives.
    expect(s2?.lastPrompt).toBe('measure me');
  });

  it('ignores a <synthetic> model id when choosing the window', async () => {
    const s = await startCtxSession([
      prompt,
      usageLine('c1', 'claude-opus-5[1m]', 100_000, '2026-09-01T09:10:02.000Z'),
      usageLine('c2', '<synthetic>', 100_000, '2026-09-01T09:10:03.000Z'),
    ]);
    // `<synthetic>` carries no real usage and must not drag the window back to 200k.
    expect(s?.live?.contextFill).toBeCloseTo(0.1, 10);
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
 * The tracker's own poll is left at 60s so it cannot satisfy this, while the registry watcher
 * keeps its production 2000ms poll backstop so the test degrades into a slow pass rather than a
 * hang. The <1500ms bound is therefore also an assertion that the *push* path delivered: the
 * backstop alone could not have answered in that time.
 *
 * The 100ms gap before the measured write is load-bearing and is itself a finding: chokidar v5
 * (fs.watch, no fsevents) coalesces two writes to the same path ~1ms apart into a single event,
 * so a transition written immediately after another is delivered only by the poll backstop.
 * Real transitions are seconds apart; back-to-back ones only happen in a test.
 */
describe('LiveTracker waiting-transition latency (push path)', () => {
  it('detects a registry busy -> waiting transition through the fs watcher', async () => {
    const watched = createLiveTracker(ctx, {
      registry: createRegistryWatcher({ dir: join(homes.claudeHome, 'sessions') }),
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
      // Seeded as `waiting` from the fixture and announced to nobody, so drive it to `busy`
      // first; the measured edge is busy -> waiting, the one the product actually cares about.
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
      expect(elapsedMs).toBeLessThan(1500);
      if (process.env.ORC_MEASURE) {
        process.stdout.write(`[measure] busy->waiting detected in ${elapsedMs.toFixed(1)}ms\n`);
      }
    } finally {
      offEdges();
      await watched.stop();
    }
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
