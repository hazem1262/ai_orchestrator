import type { InboxItem, TestResult } from '@orc/core';
import { type Logger, pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, type TestContext, useTempHomes } from '../../test/helpers.ts';
import type { Notifier } from '../notify/notifier.ts';
import type { InboxKey, InboxScope } from './dedupe-key.ts';
import {
  createInboxEngine,
  type InboxEngineRuntime,
  InboxError,
  type InboxUpsert,
  inboxDedupeKey,
} from './engine.ts';

const homes = useTempHomes();
let ctx: TestContext;
let engine: InboxEngineRuntime;
let nowMs: number;
let emitted: InboxItem[];
const notify = vi.fn(async (_item: InboxItem) => {});
const notifier: Notifier = { notify, register: vi.fn(), setAway: vi.fn(), isAway: () => false };

const T0 = Date.parse('2026-09-01T09:00:00.000Z');
const PK = 'claude:s-basic';

const waiting = (reason = 'Waiting: input needed', pk = PK): InboxUpsert => ({
  kind: 'waiting',
  scope: { session: pk },
  sessionId: pk.slice(pk.indexOf(':') + 1),
  projectId: 'wakecap',
  reason,
  payload: { source: 'claude', id: pk.slice(pk.indexOf(':') + 1) },
});

const waitingKey: InboxKey = { kind: 'waiting', scope: { session: PK } };

const TEST_RESULT: TestResult = {
  ts: '2026-09-01T09:00:00.000Z',
  command: 'pnpm test',
  passed: 1,
  failed: 0,
  skipped: 0,
  durationMs: 10,
};

/**
 * Captures what the *engine* logs. `createTestContext` only swaps `ctx.log`; the event bus keeps
 * the silent logger it was built with. So anything that reaches this sink came from the engine's
 * own handling, and anything the bus swallows leaves it empty — which is what makes the two
 * isolation tests below fail if the engine stops handling those paths itself.
 */
interface LogLine {
  level: 'warn' | 'error';
  obj: Record<string, unknown>;
  msg: string;
}
let logs: LogLine[];

function recordingLog(sink: LogLine[]): Logger {
  const base = pino({ level: 'silent' });
  const capture =
    (level: LogLine['level']) =>
    (obj: Record<string, unknown>, msg: string): void => {
      sink.push({ level, obj, msg });
    };
  return Object.assign(Object.create(base) as Logger, { warn: capture('warn'), error: capture('error') });
}

beforeEach(() => {
  logs = [];
  ctx = createTestContext({ homes, log: recordingLog(logs) });
  nowMs = T0;
  engine = createInboxEngine(ctx, { now: () => new Date(nowMs), notifier });
  ctx.inbox = engine;
  emitted = [];
  ctx.bus.on('inbox.upserted', (e) => emitted.push(e.item));
  notify.mockClear();
});

afterEach(() => {
  engine.stop();
  ctx.dispose();
});

describe('InboxEngine', () => {
  it('opens a new item once and refreshes it without re-notifying', () => {
    const a = engine.upsert(waiting());
    expect(a).toMatchObject({
      state: 'open',
      kind: 'waiting',
      createdAt: '2026-09-01T09:00:00.000Z',
      payload: { source: 'claude', id: 's-basic' },
    });
    nowMs += 1000;
    const b = engine.upsert(waiting('Waiting: approve plan'));
    expect(b.id).toBe(a.id);
    expect(b.reason).toBe('Waiting: approve plan');
    expect(b.updatedAt).toBe('2026-09-01T09:00:01.000Z');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(emitted.map((i) => i.reason)).toEqual(['Waiting: input needed', 'Waiting: approve plan']);
  });

  it('auto-resolves and opens a fresh item (and notification) on the next state change', () => {
    const a = engine.upsert(waiting());
    engine.resolve(waitingKey);
    engine.resolve({ kind: 'waiting', scope: { session: 'claude:never-seen' } });
    expect(engine.list({ state: ['auto_resolved'] }).map((i) => i.id)).toEqual([a.id]);
    const b = engine.upsert(waiting());
    expect(b.id).not.toBe(a.id);
    expect(b.state).toBe('open');
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('marks done, snoozes, wakes up and reopens', () => {
    const a = engine.upsert(waiting());
    expect(() => engine.snooze(a.id, '2026-09-01T08:00:00.000Z')).toThrow(InboxError);
    expect(() => engine.snooze(a.id, 'tomorrow')).toThrow(InboxError);
    const s = engine.snooze(a.id, '2026-09-01T09:30:00.000Z');
    expect(s).toMatchObject({ state: 'snoozed', snoozeUntil: '2026-09-01T09:30:00.000Z' });
    // A snoozed item is refreshed in place, never silently replaced by a second open row.
    const refreshed = engine.upsert(waiting('still waiting'));
    expect(refreshed.id).toBe(a.id);
    expect(refreshed.state).toBe('snoozed');
    expect(engine.list({ state: ['open'] })).toEqual([]);
    engine.tick(new Date('2026-09-01T09:29:00.000Z'));
    expect(engine.list({ state: ['snoozed'] })).toHaveLength(1);
    engine.tick(new Date('2026-09-01T09:30:00.000Z'));
    expect(engine.list({ state: ['open'] }).map((i) => i.id)).toEqual([a.id]);
    expect(notify).toHaveBeenCalledTimes(2);
    const d = engine.markDone(a.id);
    expect(d).toMatchObject({ state: 'done', snoozeUntil: null });
    expect(() => engine.snooze(a.id, '2026-09-01T10:30:00.000Z')).toThrow(/not active/);
    expect(engine.reopen(a.id).state).toBe('open');
  });

  it('start() ticks at once and on a timer, and stop() stops the timer', () => {
    vi.useFakeTimers();
    try {
      const a = engine.upsert(waiting());
      engine.snooze(a.id, '2026-09-01T09:05:00.000Z');
      nowMs = Date.parse('2026-09-01T09:06:00.000Z');
      engine.start(1000);
      expect(engine.list({ state: ['open'] }).map((i) => i.id)).toEqual([a.id]); // the eager tick

      engine.snooze(a.id, '2026-09-01T09:10:00.000Z');
      nowMs = Date.parse('2026-09-01T09:11:00.000Z');
      vi.advanceTimersByTime(1000);
      expect(engine.list({ state: ['open'] }).map((i) => i.id)).toEqual([a.id]); // the interval

      engine.snooze(a.id, '2026-09-01T09:20:00.000Z');
      nowMs = Date.parse('2026-09-01T09:21:00.000Z');
      engine.stop();
      vi.advanceTimersByTime(5000);
      expect(engine.list({ state: ['snoozed'] }).map((i) => i.id)).toEqual([a.id]); // clearInterval
    } finally {
      vi.useRealTimers();
    }
  });

  it('wakes a due item on its own clock, and leaves a later one asleep', () => {
    const a = engine.upsert(waiting('first', 'claude:s-one'));
    const b = engine.upsert(waiting('second', 'claude:s-two'));
    engine.snooze(a.id, '2026-09-01T09:10:00.000Z');
    engine.snooze(b.id, '2026-09-01T09:20:00.000Z');
    notify.mockClear();
    nowMs = Date.parse('2026-09-01T09:15:00.000Z');
    engine.tick(); // no argument: the injected clock decides what is due
    expect(engine.list({ state: ['open'] }).map((i) => i.id)).toEqual([a.id]);
    expect(engine.list({ state: ['snoozed'] }).map((i) => i.id)).toEqual([b.id]);
    expect(notify.mock.calls.map(([i]) => i.id)).toEqual([a.id]);
    expect(emitted.at(-1)).toMatchObject({ id: a.id, state: 'open', snoozeUntil: null });
  });

  it('reopen returns the already-active item for the same key', () => {
    const a = engine.upsert(waiting());
    engine.markDone(a.id);
    const b = engine.upsert(waiting());
    expect(engine.reopen(a.id).id).toBe(b.id);
    expect(engine.list({}).find((i) => i.id === a.id)?.state).toBe('done');
  });

  it('throws not_found for unknown ids', () => {
    const err = (() => {
      try {
        engine.markDone('nope');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InboxError);
    expect(err).toMatchObject({ status: 404, code: 'not_found' });
    expect(() => engine.snooze('nope', '2026-09-01T09:30:00.000Z')).toThrow(InboxError);
    expect(() => engine.reopen('nope')).toThrow(InboxError);
  });

  it('filters by kind and project', () => {
    engine.upsert(waiting());
    engine.upsert({ kind: 'error', scope: { session: 'claude:x' }, projectId: 'forza', reason: 'API error' });
    expect(engine.list({ kind: ['error'] }).map((i) => i.projectId)).toEqual(['forza']);
    expect(engine.list({ projectId: 'wakecap' }).map((i) => i.kind)).toEqual(['waiting']);
  });

  it('rejects a snooze time that is not a zoned, four-digit-year ISO instant', () => {
    const a = engine.upsert(waiting());
    // No zone: `Date.parse` reads this as *local* time, so the same request would snooze for a
    // different duration depending on where the daemon runs.
    expect(() => engine.snooze(a.id, '2026-09-01T20:00:00')).toThrow(InboxError);
    // Expanded year: `snoozeUntil` is compared lexicographically in SQL and `'+'` sorts before
    // every digit, so this far-future snooze would come due on the very next tick.
    expect(() => engine.snooze(a.id, '+010000-01-01T00:00:00.000Z')).toThrow(InboxError);
    expect(() => engine.snooze(a.id, '2026-09-01')).toThrow(InboxError);
    expect(engine.list({ state: ['open'] }).map((i) => i.id)).toEqual([a.id]);
    // An offset zone is fine — it pins a real instant.
    expect(engine.snooze(a.id, '2026-09-01T11:30:00+01:00').snoozeUntil).toBe('2026-09-01T10:30:00.000Z');
  });

  it('keeps the item when its payload cannot be serialized', () => {
    const cyclic: Record<string, unknown> = { ok: 1 };
    cyclic.self = cyclic;
    const item = engine.upsert({ ...waiting(), payload: { ...cyclic, big: 1n } });
    // The alternative is a throw out of `upsert`, which `registerRule` would swallow as
    // `inbox rule failed` — leaving the user with no item and no visible error.
    expect(item.payload).toEqual({ ok: 1, serializationFailed: true });
    expect(engine.list({ state: ['open'] }).map((i) => i.id)).toEqual([item.id]);
    // And the same on the refresh path, which stringifies through a different call.
    const refreshed = engine.upsert({ ...waiting('again'), payload: { b: 2n, c: 3 } });
    expect(refreshed.id).toBe(item.id);
    expect(refreshed.payload).toEqual({ c: 3, serializationFailed: true });
  });

  it('refreshes only the fields the caller supplied, and lets null clear one', () => {
    const a = engine.upsert({ ...waiting(), ticket: 'SAF-1787' });
    expect(a).toMatchObject({ ticket: 'SAF-1787', projectId: 'wakecap', sessionId: 's-basic' });
    // Absent → untouched. The `?? existing.x` form this replaced behaved the same here…
    const b = engine.upsert({ kind: 'waiting', scope: { session: PK }, reason: 'thin' });
    expect(b).toMatchObject({ ticket: 'SAF-1787', projectId: 'wakecap', sessionId: 's-basic' });
    expect(b.payload).toEqual({ source: 'claude', id: 's-basic' });
    // …but an explicit null could never clear a ticket a rule had stopped being able to derive,
    // and an explicit sessionId was ignored outright.
    const c = engine.upsert({ ...waiting(), ticket: null, sessionId: 's-renamed' });
    expect(c).toMatchObject({ ticket: null, sessionId: 's-renamed', projectId: 'wakecap' });
  });

  it('survives a notifier that rejects', async () => {
    notify.mockRejectedValueOnce(new Error('osascript died'));
    const item = engine.upsert(waiting());
    expect(engine.list({ state: ['open'] }).map((i) => i.id)).toEqual([item.id]);
    // The item is already committed; the failed notification is the engine's to own and log.
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect(logs[0]).toMatchObject({ level: 'warn', msg: 'notification failed' });
    expect(logs[0]?.obj).toMatchObject({ kind: 'waiting' });
  });

  it('runs registered rules on bus events and isolates failures', () => {
    const good = vi.fn();
    engine.registerRule({
      name: 'boom',
      on: ['session.statusChanged'],
      handle: () => {
        throw new Error('boom');
      },
    });
    engine.registerRule({ name: 'good', on: ['session.statusChanged', 'tests.recorded'], handle: good });
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s', from: null, to: 'busy' });
    ctx.bus.emit({ type: 'session.turnEnded', pk: 'claude:s', turn: 1 });
    expect(good).toHaveBeenCalledTimes(1);
    expect(good.mock.calls[0]?.[1]).toBe(ctx);
    // EVERY type in `rule.on` is subscribed, not just the first. A rule wired to two events and
    // tested with one is indistinguishable from a rule that silently ignores its second event —
    // and the second event's item would then never appear, with no error and no log line.
    ctx.bus.emit({ type: 'tests.recorded', pk: 'claude:s', result: TEST_RESULT });
    expect(good).toHaveBeenCalledTimes(2);
    expect(good.mock.calls[1]?.[0]).toMatchObject({ type: 'tests.recorded' });
    // The engine catches the rule's throw itself and names the culprit. Leaving it to the bus's
    // own isolation would still keep `good` running, but would lose the rule name — and this
    // sink, which the bus does not write to, would be empty.
    expect(logs).toEqual([
      {
        level: 'error',
        obj: { err: 'Error: boom', rule: 'boom', event: 'session.statusChanged' },
        msg: 'inbox rule failed',
      },
    ]);
    engine.stop();
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s', from: 'busy', to: 'idle' });
    ctx.bus.emit({ type: 'tests.recorded', pk: 'claude:s', result: TEST_RESULT });
    expect(good).toHaveBeenCalledTimes(2);
  });
});

describe('reason hygiene', () => {
  // A 40-char token body, written out here rather than borrowed from REDACTION_PATTERNS: a seed
  // derived from the pattern list disappears with the pattern and stops asking the question.
  const TOKEN = `ghp_${'a1b2c3d4e5'.repeat(4)}`;
  const FILLER = 'x'.repeat(278);

  it('redacts before it truncates', () => {
    // Lengths are chosen so the two orders visibly disagree. Raw is 323 chars, over the 300 cut.
    // Redacting first leaves 296 (`278 + 1 + 17`), so nothing is cut and the tag is intact.
    // Truncating first would keep only the first 20 characters of the 44-char token — `ghp_`
    // plus 16 body characters, one short of the pattern's `{20,}` — so redaction would then
    // match nothing and 16 characters of the token would survive into the DB.
    const raw = `${FILLER} ${TOKEN}`;
    expect(raw.length).toBe(323);
    const item = engine.upsert(waiting(raw));
    expect(item.reason).toBe(`${FILLER} «redacted:github»`);
    expect(item.reason.length).toBe(296);
    expect(item.reason).not.toContain('ghp_');
    expect(item.reason).not.toContain('a1b2c3d4e5');
  });

  it('cuts an over-long reason to 300 without splitting a surrogate pair', () => {
    const item = engine.upsert(waiting(`${'a'.repeat(299)}😀 tail`));
    expect(item.reason.length).toBe(300);
    // `.slice(0, 300)` would end on the emoji's lone high surrogate.
    expect(item.reason).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(item.reason.endsWith('…')).toBe(true);
  });

  it('redacts the reason on a refresh too, not only on the first open', () => {
    const a = engine.upsert(waiting('quiet'));
    const b = engine.upsert(waiting(`later: ${TOKEN}`));
    expect(b.id).toBe(a.id);
    expect(b.reason).toBe('later: «redacted:github»');
  });
});

describe('dedupe key composition', () => {
  /**
   * Written by hand, not generated from the composer: the point is to pin identities the engine
   * must keep apart. The last group are the colon traps — a session pk already contains a colon,
   * so an unescaped separator lets a facet impersonate a longer pk, or a domain a longer domain.
   */
  const CORPUS: InboxKey[] = [
    { kind: 'waiting', scope: { session: 'claude:s-basic' } },
    { kind: 'waiting', scope: { session: 'codex:s-basic' } },
    { kind: 'review', scope: { session: 'claude:s-basic' } },
    { kind: 'waiting', scope: { project: 'wakecap' } },
    { kind: 'waiting', scope: { ticket: 'SAF-1787' } },
    // Same value under two different tags: collapsing the tags is a collision, and nothing else
    // in this corpus would notice it.
    { kind: 'waiting', scope: { project: 'SAF-1787' } },
    { kind: 'waiting', scope: { global: true } },
    { kind: 'reminder', scope: { global: true } },
    { kind: 'reminder', scope: { global: true }, facet: 'daily' },
    { kind: 'reminder', scope: { global: true }, facet: 'weekly' },
    { kind: 'pr_event', scope: { domain: 'pr', id: 'owner/repo#4' }, facet: 'checks' },
    { kind: 'pr_event', scope: { domain: 'pr', id: 'owner/repo#4' }, facet: 'review' },
    { kind: 'pr_event', scope: { domain: 'pr', id: 'owner/repo#5' }, facet: 'checks' },
    { kind: 'pr_event', scope: { domain: 'worktree', id: '/Users/test/wt' }, facet: 'archive_blocked' },
    { kind: 'budget', scope: { domain: 'quota', id: 'block:2026-09-01T09:00:00.000Z' } },
    { kind: 'waiting', scope: { session: 'claude:s' }, facet: 'x' },
    { kind: 'waiting', scope: { session: 'claude:s:x' } },
    { kind: 'waiting', scope: { project: 'session:claude:s' } },
    { kind: 'waiting', scope: { project: 'wakecap' }, facet: 'session:claude:s' },
    { kind: 'waiting', scope: { domain: 'a:b', id: 'c' } },
    { kind: 'waiting', scope: { domain: 'a', id: 'b' }, facet: 'c' },
    { kind: 'waiting', scope: { domain: 'a', id: 'b:c' } },
  ];

  it('maps distinct identities to distinct keys', () => {
    const keys = CORPUS.map(inboxDedupeKey);
    expect(new Set(keys).size).toBe(CORPUS.length);
  });

  it('is stable and readable for the ordinary cases', () => {
    expect(inboxDedupeKey({ kind: 'waiting', scope: { session: PK } })).toBe(
      'waiting:session:claude%3As-basic',
    );
    expect(inboxDedupeKey({ kind: 'budget', scope: { project: 'wakecap' } })).toBe('budget:project:wakecap');
    expect(inboxDedupeKey({ kind: 'review', scope: { ticket: 'SAF-1787' } })).toBe('review:ticket:SAF-1787');
    expect(inboxDedupeKey({ kind: 'reminder', scope: { global: true } })).toBe('reminder:global');
    expect(inboxDedupeKey({ kind: 'pr_event', scope: { domain: 'pr', id: 'o/r#4' }, facet: 'checks' })).toBe(
      'pr_event:pr:o%2Fr%234:checks',
    );
  });

  it('treats session/project/ticket as sugar for the domains of the same name', () => {
    // Deliberate aliasing, not a collision: these are two spellings of one identity, so one item
    // is the correct outcome. Stated here so nobody has to rediscover it from the format.
    expect(inboxDedupeKey({ kind: 'waiting', scope: { domain: 'session', id: PK } })).toBe(
      inboxDedupeKey({ kind: 'waiting', scope: { session: PK } }),
    );
  });

  it('rejects a scope that names two things at once', () => {
    // A union of single-field objects is structurally satisfied by its first member, so without
    // the `?: never` branding TypeScript accepts this and the composer silently drops `project`.
    // @ts-expect-error — a scope is about exactly one thing.
    const mixed: InboxScope = { session: PK, project: 'wakecap' };
    expect(mixed).toBeDefined();
  });

  it('a facet of the empty string still splits the key', () => {
    expect(inboxDedupeKey({ kind: 'waiting', scope: { project: 'p' }, facet: '' })).not.toBe(
      inboxDedupeKey({ kind: 'waiting', scope: { project: 'p' } }),
    );
  });

  it('keeps every identity in the corpus as its own live row', () => {
    // The unique index is on the literal key string, so a composer that collapsed two identities
    // would make the second insert throw — or, worse under the old caller-written-key contract,
    // silently refresh the first session's item and drop the second. Both fail here.
    for (const [n, key] of CORPUS.entries()) {
      engine.upsert({ ...key, reason: `item ${n}` });
    }
    const open = engine.list({ state: ['open'] });
    expect(open).toHaveLength(CORPUS.length);
    expect(new Set(open.map((i) => i.dedupeKey)).size).toBe(CORPUS.length);
    expect(new Set(open.map((i) => i.reason)).size).toBe(CORPUS.length);
    expect(notify).toHaveBeenCalledTimes(CORPUS.length);
  });

  it('gives two sessions in the same state two items', () => {
    const a = engine.upsert(waiting('one waits', 'claude:s-one'));
    const b = engine.upsert(waiting('the other waits', 'claude:s-two'));
    expect(b.id).not.toBe(a.id);
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
    expect(
      engine
        .list({ state: ['open'] })
        .map((i) => i.reason)
        .sort(),
    ).toEqual(['one waits', 'the other waits']);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('cannot be steered by any caller-supplied value', () => {
    // The behavioural half of the "never copied from free text" promise, and the only half no
    // refactor can quietly break: a source scan of the engine misses a smuggle hidden inside the
    // composer itself, because such code need not contain the string `dedupeKey` at all. Every
    // caller-controlled field carries a sentinel; none of them may reach the key.
    const SENTINEL = 'hijacked-by-the-caller';
    const item = engine.upsert({
      kind: 'waiting',
      scope: { session: PK },
      reason: SENTINEL,
      sessionId: SENTINEL,
      projectId: SENTINEL,
      ticket: SENTINEL,
      payload: { dedupeKey: SENTINEL, dedupe_key: SENTINEL, key: SENTINEL, k: SENTINEL },
    });
    expect(item.dedupeKey).toBe(inboxDedupeKey({ kind: 'waiting', scope: { session: PK } }));
    expect(item.dedupeKey).not.toContain(SENTINEL);
  });

  it('offers a caller no channel to hand-write a key', () => {
    const attempt: InboxUpsert = {
      kind: 'waiting',
      scope: { session: PK },
      reason: 'r',
      // @ts-expect-error — `InboxUpsert` deliberately has no `dedupeKey`. If one is ever added
      // back, this stops being an error and `pnpm typecheck` fails on the unused directive.
      dedupeKey: 'waiting:claude:some-other-session',
    };
    expect(engine.upsert(attempt).dedupeKey).toBe('waiting:session:claude%3As-basic');
  });
});
