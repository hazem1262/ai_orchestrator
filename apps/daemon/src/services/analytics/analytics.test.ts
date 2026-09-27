import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, StreamPr } from '@orc/core';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ev, makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import { createScheduler } from '../scheduler/scheduler.ts';
import { createUsageLedger } from '../usage/ledger.ts';
import { createUsageMeter } from '../usage/meter.ts';
import { createAnalyticsService, resolveRange } from './analytics.ts';
import { createDigestService, lastWeekStart } from './digest.ts';

let wstack: string;
beforeEach(() => {
  wstack = mkdtempSync(join(tmpdir(), 'orc-wstack-'));
  mkdirSync(join(wstack, 'projects', 'svc'), { recursive: true });
  writeFileSync(
    join(wstack, 'projects', 'svc', 'timeline.jsonl'),
    `${JSON.stringify({ skill: 'ship', outcome: 'success', duration_s: 30, ts: '2026-09-15T10:00:00Z' })}\nnot json\n`,
  );
  vi.stubEnv('WSTACK_HOME', wstack);
});
afterEach(() => vi.unstubAllEnvs());

const merged: StreamPr = {
  pr: { repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7' },
  title: 'feat: SAF-1 thing',
  state: 'merged',
  headRef: null,
  baseRef: null,
  isBackmerge: false,
  checks: 'success',
  review: 'approved',
  updatedAt: '2026-09-16T10:00:00.000Z',
  mergedAt: '2026-09-16T10:00:00.000Z',
};

async function setup() {
  const waiting: Session = makeSession({
    id: 's-basic',
    tickets: ['SAF-1'],
    prs: [merged.pr],
    name: 'Notification tests',
    usage: { input: 10, output: 10, cacheRead: 80, cacheWrite: 0, costUsd: 5 },
    live: {
      pid: 1,
      status: 'waiting',
      waitingFor: 'input',
      since: '2026-09-15T08:00:00.000Z',
      ownership: 'observed',
      ptyId: null,
      stage: null,
      currentTool: null,
      backgroundJobs: 0,
      runningSubagents: 0,
      contextFill: null,
    },
  });
  const events = {
    'claude:s-basic': [
      ev({ seq: 1, ts: '2026-09-15T09:59:59.000Z', kind: 'prompt', text: '/review now' }),
      ev({
        seq: 2,
        ts: '2026-09-15T10:00:00.000Z',
        kind: 'tool_call',
        messageId: 'm1',
        model: 'claude-opus-5',
        tool: 'Bash',
        toolUseId: 't',
        usage: { input: 10, output: 10, cacheRead: 80, cacheWrite: 0, costUsd: null },
      }),
      ev({ seq: 3, ts: '2026-09-15T10:00:02.000Z', kind: 'tool_result', toolUseId: 't' }),
    ],
  };
  const t = makeP5Context({
    config: withWakecap('/Users/test/Wakecap'),
    data: { sessions: [waiting], events },
  });
  t.ctx.live = { list: () => [waiting] } as unknown as NonNullable<typeof t.ctx.live>;
  const ledger = createUsageLedger(t.ctx);
  await ledger.syncSession('claude:s-basic');
  const prs = { list: () => [merged] };
  const analytics = createAnalyticsService(t.ctx, { ledger, prs });
  const meter = createUsageMeter(t.ctx, {
    ledger,
    inbox: null,
    now: () => new Date('2026-09-21T09:00:00.000Z'),
  });
  const scheduler = createScheduler({ db: t.ctx.db, log: pino({ level: 'silent' }) });
  const digests = createDigestService(t.ctx, {
    analytics,
    prs,
    meter,
    scheduler,
    now: () => new Date('2026-09-21T09:00:00.000Z'),
  });
  return { ...t, analytics, digests, scheduler };
}

const Q = { from: '2026-09-14T00:00:00.000Z', to: '2026-09-20T23:59:59.999Z' };

describe('analytics service', () => {
  it('defaults the range to the last 30 days', () => {
    expect(resolveRange({}, new Date('2026-09-17T00:00:00.000Z'))).toEqual({
      from: '2026-08-18T00:00:00.000Z',
      to: '2026-09-17T00:00:00.000Z',
    });
    expect(resolveRange({ from: 'a', to: 'b', projectId: 'p' }, new Date())).toEqual({
      from: 'a',
      to: 'b',
      projectId: 'p',
    });
  });

  it('answers cost, top, tools, timing, outcomes and wstack', async () => {
    const { analytics } = await setup();
    expect(analytics.cost({ ...Q, groupBy: 'ticket' })).toEqual({
      rows: [
        {
          key: 'SAF-1',
          costUsd: 5,
          tokens: { input: 10, output: 10, cacheRead: 80, cacheWrite: 0 },
          sessions: 1,
        },
      ],
      estimated: false,
    });
    expect(analytics.top({ ...Q, limit: 5 })).toEqual({
      sessions: [
        {
          pk: 'claude:s-basic',
          name: 'Notification tests',
          projectId: 'wakecap',
          costUsd: 5,
          tickets: ['SAF-1'],
        },
      ],
      tickets: [{ ticket: 'SAF-1', costUsd: 5, sessions: 1 }],
      mergedPrs: 1,
      costPerMergedPrUsd: 5,
    });
    expect(analytics.tools({ ...Q, bucket: 'week' })).toEqual([
      { bucket: '2026-09-14', kind: 'tool', name: 'Bash', count: 1 },
      { bucket: '2026-09-14', kind: 'skill', name: 'review', count: 1 },
    ]);
    expect(analytics.timing({ ...Q, bucket: 'day' })).toMatchObject({ modelMs: 1000, toolMs: 2000 });
    expect(analytics.outcomes(Q)).toEqual({
      sessions: 1,
      outcomes: { fully_achieved: 1 },
      friction: {},
      goalCategories: { debugging: 1 },
    });
    expect(analytics.wstack(Q)).toEqual([
      { skill: 'ship', runs: 1, outcomes: { success: 1 }, avgDurationS: 30 },
    ]);
  });

  it('generates, stores and schedules the weekly digest', async () => {
    const { digests, scheduler, ctx } = await setup();
    expect(lastWeekStart(new Date('2026-09-21T09:00:00.000Z'))).toBe('2026-09-14');
    const d = await digests.generate();
    expect(d.weekStart).toBe('2026-09-14');
    expect(d.markdown).toContain(
      '- [#7 feat: SAF-1 thing](https://github.com/o/r/pull/7) — SAF-1 — merged 2026-09-16',
    );
    expect(d.markdown).toContain('- Notification tests — waiting since 2026-09-15 08:00 UTC');
    expect(digests.latest()).toEqual(d);
    digests.syncSchedule();
    expect(scheduler.list('digest').map((j) => [j.cron, j.payload.type])).toEqual([
      ['0 9 * * 1', 'weekly_digest'],
    ]);
    ctx.updateConfig?.((c) => ({ ...c, digest: { ...c.digest, enabled: false } }));
    digests.syncSchedule();
    expect(scheduler.list('digest')).toEqual([]);
  });
});
