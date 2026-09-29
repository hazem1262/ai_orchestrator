import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LiveState, PrStatus, WorkStream } from '@orc/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import { recordingInbox } from '../../../test/stubs.ts';
import { inboxDedupeKey } from '../../inbox/dedupe-key.ts';
import { createStreamService, type StreamService } from '../streams/streams.ts';
import { createGoalService, NEEDS_ANSWER, WAITING_BLOCK_MS } from './goals.ts';

const live = (status: LiveState['status']): LiveState => ({
  pid: 1,
  status,
  waitingFor: null,
  since: '2026-09-17T10:00:00.000Z',
  ownership: 'observed',
  ptyId: null,
  stage: null,
  currentTool: null,
  backgroundJobs: 0,
  runningSubagents: 0,
  contextFill: null,
});
const pr: PrStatus = {
  pr: { repo: 'o/r', number: 9, url: 'https://github.com/o/r/pull/9' },
  state: 'merged',
  title: 'feat: SAF-1 done',
  checks: 'success',
  review: 'approved',
  updatedAt: 't',
  headRef: 'feat/SAF-1-done',
  failedChecks: [],
};

function setup() {
  let nowMs = Date.parse('2026-09-17T10:00:00.000Z');
  const s1 = makeSession({
    id: 's1',
    tickets: ['SAF-1'],
    firstPrompt: 'implement the weekend rule',
    prs: [pr.pr],
    live: live('busy'),
  });
  const s2 = makeSession({ id: 's2', firstPrompt: 'x'.repeat(300) });
  const inbox = recordingInbox();
  const t = makeP5Context({
    overrides: { inbox },
    config: withWakecap('/Users/test/Wakecap'),
    data: { sessions: [s1, s2] },
  });
  const stream: WorkStream = {
    ticket: 'SAF-1',
    projectId: 'wakecap',
    title: 'Exclude weekends',
    stage: 'pr_open',
    sessionIds: [],
    prs: [],
    plans: [],
    worktrees: [],
    costUsd: 0,
    lastActivityAt: 't',
  };
  t.ctx.streams = { list: () => [stream] } as unknown as StreamService;
  const goals = createGoalService(t.ctx, { now: () => new Date(nowMs), sweepMs: 1_000_000 });
  return { ...t, inbox, goals, advance: (ms: number) => (nowMs += ms) };
}

describe('goal service', () => {
  it('sets, gets, lists and prefills goals', () => {
    const { goals } = setup();
    expect(goals.prefill('session', 'claude:s1')).toBe('SAF-1: Exclude weekends');
    expect(goals.prefill('session', 'claude:s2')).toBe(`${'x'.repeat(200)}…`);
    expect(goals.prefill('stream', 'SAF-1')).toBe('SAF-1: Exclude weekends');
    expect(goals.prefill('stream', 'SAF-404')).toBe('SAF-404');
    const g = goals.set({
      targetType: 'session',
      targetId: 'claude:s1',
      objective: 'ship it',
      state: 'active',
      blockedReason: null,
    });
    expect(goals.get('session', 'claude:s1')).toEqual(g);
    const g2 = goals.set({ ...g, state: 'paused' });
    expect(g2.id).toBe(g.id);
    expect(goals.list({ state: ['paused'] })).toEqual([g2]);
  });

  it('blocks goals waiting over 30 minutes and unblocks when the session moves on', () => {
    const { ctx, goals, advance } = setup();
    goals.start();
    goals.set({
      targetType: 'session',
      targetId: 'claude:s1',
      objective: 'ship it',
      state: 'active',
      blockedReason: null,
    });
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s1', from: 'busy', to: 'waiting' });
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s2', from: 'busy', to: 'waiting' });
    advance(WAITING_BLOCK_MS - 1);
    expect(goals.sweep()).toBe(0);
    advance(1);
    expect(goals.sweep()).toBe(2);
    expect(goals.get('session', 'claude:s1')).toMatchObject({
      state: 'blocked',
      blockedReason: NEEDS_ANSWER,
    });
    expect(goals.get('session', 'claude:s2')).toMatchObject({
      state: 'blocked',
      objective: `${'x'.repeat(200)}…`,
    });
    expect(goals.sweep()).toBe(0);
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s1', from: 'waiting', to: 'busy' });
    expect(goals.get('session', 'claude:s1')).toMatchObject({ state: 'active', blockedReason: null });
    goals.stop();
  });

  it('completes session and stream goals when a linked PR merges', () => {
    const { ctx, goals } = setup();
    goals.start();
    goals.set({
      targetType: 'session',
      targetId: 'claude:s1',
      objective: 'a',
      state: 'blocked',
      blockedReason: 'x',
    });
    goals.set({
      targetType: 'stream',
      targetId: 'SAF-1',
      objective: 'b',
      state: 'active',
      blockedReason: null,
    });
    goals.set({
      targetType: 'session',
      targetId: 'claude:s2',
      objective: 'c',
      state: 'active',
      blockedReason: null,
    });
    ctx.bus.emit({ type: 'pr.changed', before: { ...pr, state: 'open' }, after: pr });
    expect(goals.get('session', 'claude:s1')?.state).toBe('complete');
    expect(goals.get('stream', 'SAF-1')?.state).toBe('complete');
    expect(goals.get('session', 'claude:s2')?.state).toBe('active');
    goals.stop();
  });
});

describe('goal service inbox items', () => {
  const blockedKey = (scope: { session: string } | { ticket: string }) =>
    inboxDedupeKey({ kind: 'blocked', scope });

  it('opens a blocked inbox item when a goal is blocked and resolves it when unblocked', () => {
    const { ctx, inbox, goals, advance } = setup();
    goals.start();
    goals.set({
      targetType: 'session',
      targetId: 'claude:s1',
      objective: 'ship it',
      state: 'active',
      blockedReason: null,
    });
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s1', from: 'busy', to: 'waiting' });
    advance(WAITING_BLOCK_MS);
    expect(goals.sweep()).toBe(1);
    expect(inbox.upserts).toContainEqual(
      expect.objectContaining({
        kind: 'blocked',
        scope: { session: 'claude:s1' },
        payload: expect.objectContaining({ source: 'claude', id: 's1', blockedReason: NEEDS_ANSWER }),
      }),
    );
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s1', from: 'waiting', to: 'busy' });
    expect(inbox.resolved).toContain(blockedKey({ session: 'claude:s1' }));
    goals.stop();
  });

  it('blocked replaces the waiting item', () => {
    const { ctx, inbox, goals, advance } = setup();
    goals.start();
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s1', from: 'busy', to: 'waiting' });
    advance(WAITING_BLOCK_MS);
    goals.sweep();
    expect(inbox.upserts.map((u) => u.kind)).toContain('blocked');
    expect(inbox.resolved).toContain(inboxDedupeKey({ kind: 'waiting', scope: { session: 'claude:s1' } }));
    goals.stop();
  });

  it('a manual blocked goal raises the item', () => {
    const { inbox, goals } = setup();
    goals.set({
      targetType: 'session',
      targetId: 'claude:s1',
      objective: 'ship it',
      state: 'blocked',
      blockedReason: 'waiting on QA',
    });
    expect(inbox.upserts).toContainEqual(
      expect.objectContaining({
        kind: 'blocked',
        scope: { session: 'claude:s1' },
        payload: expect.objectContaining({ source: 'claude', id: 's1', blockedReason: 'waiting on QA' }),
      }),
    );
  });

  it('scopes a blocked stream goal to its ticket', () => {
    const { inbox, goals } = setup();
    goals.set({
      targetType: 'stream',
      targetId: 'SAF-1',
      objective: 'exclude weekends',
      state: 'blocked',
      blockedReason: 'waiting on QA',
    });
    expect(inbox.upserts).toContainEqual(
      expect.objectContaining({ kind: 'blocked', scope: { ticket: 'SAF-1' } }),
    );
  });
});

describe('stream detail goal', () => {
  // Task 9 left `goal: null` in `StreamService.get` as the plug-in point for this task.
  let wstackHome: string;
  beforeEach(() => {
    wstackHome = mkdtempSync(join(tmpdir(), 'orc-goals-wstack-'));
    vi.stubEnv('WSTACK_HOME', wstackHome);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(wstackHome, { recursive: true, force: true });
  });

  it('ctx.streams.get(ticket) returns the ticket goal once one exists', async () => {
    const s1 = makeSession({ id: 's1', tickets: ['SAF-1'], firstPrompt: 'implement the weekend rule' });
    const t = makeP5Context({ config: withWakecap('/Users/test/Wakecap'), data: { sessions: [s1] } });
    t.ctx.streams = createStreamService(t.ctx, {
      prs: { list: () => [] },
      meter: { checkBudget: () => ({ ok: true, pct: 0, limitUsd: null }) },
      now: () => new Date('2026-09-17T10:00:00.000Z'),
    });
    t.ctx.goals = createGoalService(t.ctx, { now: () => new Date('2026-09-17T10:00:00.000Z') });
    await t.ctx.streams.refresh();
    expect((await t.ctx.streams.get('SAF-1'))?.goal).toBeNull();
    const g = t.ctx.goals.set({
      targetType: 'stream',
      targetId: 'SAF-1',
      objective: 'exclude weekends from SLA',
      state: 'active',
      blockedReason: null,
    });
    expect((await t.ctx.streams.get('SAF-1'))?.goal).toEqual(g);
  });
});
