import type { InboxItem, LiveState, LiveStatus, Session, TestResult } from '@orc/core';
import { type Logger, pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeLive } from '../../../test/fake-live.ts';
import { createTestContext, indexFixtures, type TestContext, useTempHomes } from '../../../test/helpers.ts';
import { insertTestResult } from '../../db/repos/test-results.ts';
import { stubSession } from '../../live/stub-session.ts';
import { inboxDedupeKey } from '../dedupe-key.ts';
import { createInboxEngine, type InboxEngineRuntime } from '../engine.ts';
import { registerDefaultRules, STATUS_KIND, statusRule, testsRedRule } from './status-rules.ts';

let logs: LogLine[] = [];

/**
 * Registered before `useTempHomes()` so it runs after every other `afterEach` (hooks unwind in
 * reverse order). A failing assertion here would otherwise skip the temp-home cleanup.
 */
afterEach(() => {
  expect(logs.filter((l) => l.msg === 'inbox rule failed')).toEqual([]);
});

const homes = useTempHomes();
let ctx: TestContext;
let engine: InboxEngineRuntime;
let fake: ReturnType<typeof createFakeLive>;

const PK = 'claude:s-live';
const PK_B = 'claude:s-other';

/**
 * Captures what the engine logs. A rule that throws is caught by `registerRule` and logged as
 * `inbox rule failed` — the item then never appears and nothing else reports it. `afterEach`
 * fails the test on any such line, so a crashing rule cannot pass as "no item expected".
 */
interface LogLine {
  level: 'warn' | 'error';
  obj: Record<string, unknown>;
  msg: string;
}

function recordingLog(sink: LogLine[]): Logger {
  const base = pino({ level: 'silent' });
  const capture =
    (level: LogLine['level']) =>
    (obj: Record<string, unknown>, msg: string): void => {
      sink.push({ level, obj, msg });
    };
  return Object.assign(Object.create(base) as Logger, { warn: capture('warn'), error: capture('error') });
}

const live = (status: LiveStatus, waitingFor: string | null = 'approve the plan'): LiveState => ({
  pid: 1,
  status,
  waitingFor: status === 'waiting' ? waitingFor : null,
  since: '2026-09-01T09:00:00.000Z',
  ownership: 'observed',
  ptyId: null,
  stage: null,
  currentTool: null,
  backgroundJobs: 0,
  runningSubagents: 0,
  contextFill: null,
});

const session = (
  pk: string,
  status: LiveStatus,
  o: {
    name?: string;
    projectId?: string;
    tickets?: string[];
    waitingFor?: string | null;
    lastTest?: TestResult | null;
  } = {},
): Session => {
  const id = pk.slice(pk.indexOf(':') + 1);
  return {
    ...stubSession({
      source: 'claude',
      id,
      cwd: '/Users/test/Wakecap',
      startedAt: '2026-09-01T09:00:00.000Z',
      projectId: o.projectId ?? 'wakecap',
      name: o.name ?? 'SLA weekends',
    }),
    tickets: o.tickets ?? ['SAF-1787'],
    lastTest: o.lastTest ?? null,
    live: live(status, o.waitingFor ?? 'approve the plan'),
  };
};

/** Replace (or add) one session in the fake tracker, then emit its status change. */
const change = (from: LiveStatus | null, to: LiveStatus, pk = PK, o: Parameters<typeof session>[2] = {}) => {
  fake.sessions = [...fake.sessions.filter((s) => `${s.source}:${s.id}` !== pk), session(pk, to, o)];
  ctx.bus.emit({ type: 'session.statusChanged', pk, from, to });
};

const open = (): InboxItem[] => engine.list({ state: ['open'] });
const openKinds = () =>
  open()
    .map((i) => i.kind)
    .sort();
const openFor = (pk: string) => open().filter((i) => i.dedupeKey.includes(encodeURIComponent(pk)));

beforeEach(() => {
  logs = [];
  fake = createFakeLive([]);
  ctx = createTestContext({ homes, live: fake, log: recordingLog(logs) });
  engine = createInboxEngine(ctx);
  ctx.inbox = engine;
  registerDefaultRules(engine);
});

afterEach(() => {
  engine.stop();
  ctx.dispose();
});

describe('exports', () => {
  it('maps exactly waiting, review and error to inbox kinds', () => {
    expect(STATUS_KIND).toEqual({ waiting: 'waiting', review: 'review', error: 'error' });
    expect(statusRule).toMatchObject({ name: 'status', on: ['session.statusChanged'] });
    expect(testsRedRule).toMatchObject({ name: 'tests_red', on: ['tests.recorded'] });
  });
});

describe('statusRule', () => {
  it('opens a waiting item with session context and resolves it when busy again', () => {
    change(null, 'waiting');
    const [item] = open();
    expect(item).toMatchObject({
      kind: 'waiting',
      dedupeKey: inboxDedupeKey({ kind: 'waiting', scope: { session: PK } }),
      sessionId: 's-live',
      projectId: 'wakecap',
      ticket: 'SAF-1787',
      reason: 'SLA weekends: waiting — approve the plan',
      payload: { source: 'claude', id: 's-live', status: 'waiting' },
    });
    change('waiting', 'busy');
    expect(openKinds()).toEqual([]);
    expect(engine.list({ state: ['auto_resolved'] }).map((i) => i.id)).toEqual([item?.id]);
  });

  it('gives two sessions in the same status two distinct items', () => {
    change(null, 'waiting', PK);
    change(null, 'waiting', PK_B, { name: 'Other work', projectId: 'forza', tickets: ['FOR-9'] });
    const items = open();
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
    expect(items.map((i) => i.dedupeKey).sort()).toEqual(
      [
        inboxDedupeKey({ kind: 'waiting', scope: { session: PK } }),
        inboxDedupeKey({ kind: 'waiting', scope: { session: PK_B } }),
      ].sort(),
    );
    const b = items.find((i) => i.sessionId === 's-other');
    expect(b).toMatchObject({
      projectId: 'forza',
      ticket: 'FOR-9',
      reason: 'Other work: waiting — approve the plan',
      payload: { source: 'claude', id: 's-other', status: 'waiting' },
    });
  });

  it('gives two sessions in error two distinct items too', () => {
    change('busy', 'error', PK);
    change('busy', 'error', PK_B);
    expect(openKinds()).toEqual(['error', 'error']);
  });

  it('auto-resolves only the item of the session that left the status', () => {
    change(null, 'waiting', PK);
    change(null, 'waiting', PK_B);
    const bId = openFor(PK_B)[0]?.id;
    change('waiting', 'busy', PK);
    expect(open().map((i) => i.id)).toEqual([bId]);
    expect(open()[0]).toMatchObject({ sessionId: 's-other', state: 'open' });
    expect(engine.list({ state: ['auto_resolved'] }).map((i) => i.sessionId)).toEqual(['s-live']);
  });

  it('refreshes the same item in place when a session re-enters its current status', () => {
    change(null, 'waiting', PK, { waitingFor: 'approve the plan' });
    const first = open()[0];
    change('waiting', 'waiting', PK, { waitingFor: 'pick a branch' });
    const items = open();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(first?.id);
    expect(items[0]?.reason).toBe('SLA weekends: waiting — pick a branch');
    expect(engine.list({ state: ['auto_resolved'] })).toEqual([]);
  });

  it('keeps review open when the process ends, resolves it when work resumes', () => {
    change('busy', 'review');
    expect(openKinds()).toEqual(['review']);
    change('review', 'ended');
    expect(openKinds()).toEqual(['review']);
    change('ended', 'busy');
    expect(openKinds()).toEqual(['review']);
    change('busy', 'review');
    change('review', 'busy');
    expect(openKinds()).toEqual([]);
  });

  it('includes the last test result in a review reason', () => {
    const lastTest: TestResult = {
      ts: '2026-09-01T09:00:00.000Z',
      command: 'pnpm test',
      passed: 10,
      failed: 1,
      skipped: 0,
      durationMs: null,
    };
    change('busy', 'review', PK, { lastTest });
    expect(open()[0]?.reason).toBe('SLA weekends: ready for review (tests ✓10 ✗1)');
    change('review', 'busy', PK, { lastTest: null });
    change('busy', 'review', PK, { lastTest: null });
    expect(open()[0]?.reason).toBe('SLA weekends: ready for review');
  });

  it('handles error states and ignores neutral transitions', () => {
    change('busy', 'idle');
    expect(openKinds()).toEqual([]);
    change('idle', 'error');
    expect(openKinds()).toEqual(['error']);
    expect(engine.list({ kind: ['error'] })[0]?.reason).toBe('SLA weekends: API error or crash');
    change('error', 'waiting');
    expect(openKinds()).toEqual(['waiting']);
    expect(engine.list({ kind: ['error'], state: ['auto_resolved'] })).toHaveLength(1);
  });

  it('opens a fresh item when a session waits again after the user marked the last one done', () => {
    change(null, 'waiting');
    const first = open()[0];
    if (!first) throw new Error('expected an open item');
    engine.markDone(first.id);
    change('waiting', 'busy');
    change('busy', 'waiting');
    const again = open();
    expect(again).toHaveLength(1);
    expect(again[0]?.id).not.toBe(first.id);
  });

  it('falls back to the pk when the session is unknown', () => {
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'codex:c-unknown', from: null, to: 'waiting' });
    expect(engine.list({})[0]).toMatchObject({
      kind: 'waiting',
      sessionId: 'c-unknown',
      projectId: null,
      ticket: null,
      reason: 'c-unknown: waiting — input needed',
      payload: { source: 'codex', id: 'c-unknown', status: 'waiting' },
    });
  });

  it('still opens an item, without a rule failure, when the pk is malformed', () => {
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'bogus', from: null, to: 'waiting' });
    expect(open()).toHaveLength(1);
    expect(open()[0]).toMatchObject({
      kind: 'waiting',
      sessionId: 'bogus',
      reason: 'bogus: waiting — input needed',
      payload: { source: '', id: 'bogus', status: 'waiting' },
    });
    expect(logs.filter((l) => l.msg === 'inbox rule failed')).toEqual([]);
  });

  it('falls back to the indexed session when the live tracker does not know it', async () => {
    await indexFixtures(ctx);
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s-basic', from: 'busy', to: 'error' });
    expect(open()[0]).toMatchObject({
      kind: 'error',
      sessionId: 's-basic',
      projectId: 'wakecap',
      reason: 'Notification service test check: API error or crash',
    });
  });

  it('still opens items when no live tracker is wired', () => {
    ctx.live = undefined;
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s-nolive', from: null, to: 'review' });
    expect(openKinds()).toEqual(['review']);
  });
});

describe('testsRedRule', () => {
  const rec = (ts: string, failed: number, pk = PK) => {
    const result: TestResult = { ts, command: 'pnpm test', passed: 10, failed, skipped: 0, durationMs: null };
    insertTestResult(ctx.db, pk, result);
    ctx.bus.emit({ type: 'tests.recorded', pk, result });
  };
  const red = () => engine.list({ kind: ['tests_red'] });

  it('opens on pass→fail, refreshes while red, resolves when green', () => {
    fake.sessions = [session(PK, 'busy')];
    rec('2026-09-01T09:00:00.000Z', 0);
    expect(openKinds()).toEqual([]);
    rec('2026-09-01T09:05:00.000Z', 2);
    expect(openKinds()).toEqual(['tests_red']);
    expect(red()[0]).toMatchObject({
      dedupeKey: inboxDedupeKey({ kind: 'tests_red', scope: { session: PK } }),
      sessionId: 's-live',
      projectId: 'wakecap',
      ticket: 'SAF-1787',
      reason: 'SLA weekends: tests went red (✗2 · ✓10)',
    });
    const id = red()[0]?.id;
    rec('2026-09-01T09:06:00.000Z', 3);
    expect(red()).toHaveLength(1);
    expect(red()[0]).toMatchObject({ id, state: 'open', reason: 'SLA weekends: tests went red (✗3 · ✓10)' });
    rec('2026-09-01T09:07:00.000Z', 0);
    expect(openKinds()).toEqual([]);
    expect(red()[0]?.state).toBe('auto_resolved');
  });

  it('refreshes a snoozed red item without waking it', () => {
    fake.sessions = [session(PK, 'busy')];
    rec('2026-09-01T09:00:00.000Z', 0);
    rec('2026-09-01T09:05:00.000Z', 2);
    const id = red()[0]?.id ?? '';
    const until = new Date(Date.now() + 3_600_000).toISOString();
    engine.snooze(id, until);
    rec('2026-09-01T09:06:00.000Z', 4);
    expect(red()).toHaveLength(1);
    expect(red()[0]).toMatchObject({
      id,
      state: 'snoozed',
      reason: 'SLA weekends: tests went red (✗4 · ✓10)',
    });
  });

  it('ignores a first-ever failing run', () => {
    rec('2026-09-01T09:05:00.000Z', 2);
    expect(openKinds()).toEqual([]);
  });

  it('ignores fail→fail when no red item is active', () => {
    rec('2026-09-01T09:00:00.000Z', 1);
    rec('2026-09-01T09:05:00.000Z', 2);
    expect(openKinds()).toEqual([]);
  });

  it('compares against the same session only', () => {
    rec('2026-09-01T09:00:00.000Z', 0, PK_B);
    rec('2026-09-01T09:05:00.000Z', 2, PK);
    expect(openKinds()).toEqual([]);
  });

  it('gives two sessions going red two distinct items and resolves only the one that went green', () => {
    fake.sessions = [session(PK, 'busy'), session(PK_B, 'busy', { name: 'Other work' })];
    rec('2026-09-01T09:00:00.000Z', 0, PK);
    rec('2026-09-01T09:00:00.000Z', 0, PK_B);
    rec('2026-09-01T09:05:00.000Z', 2, PK);
    rec('2026-09-01T09:05:00.000Z', 1, PK_B);
    expect(openKinds()).toEqual(['tests_red', 'tests_red']);
    expect(
      open()
        .map((i) => i.sessionId)
        .sort(),
    ).toEqual(['s-live', 's-other']);
    rec('2026-09-01T09:06:00.000Z', 0, PK);
    expect(open().map((i) => i.sessionId)).toEqual(['s-other']);
    expect(open()[0]?.reason).toBe('Other work: tests went red (✗1 · ✓10)');
  });

  it('keeps tests_red and status items for one session independent', () => {
    fake.sessions = [session(PK, 'busy')];
    rec('2026-09-01T09:00:00.000Z', 0);
    rec('2026-09-01T09:05:00.000Z', 2);
    change('busy', 'waiting');
    change('waiting', 'busy');
    expect(openKinds()).toEqual(['tests_red']);
    rec('2026-09-01T09:06:00.000Z', 0);
    change('busy', 'review');
    expect(openKinds()).toEqual(['review']);
  });
});
