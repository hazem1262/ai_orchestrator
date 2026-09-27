import type { LiveState } from '@orc/core';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import { recordingInbox } from '../../../test/stubs.ts';
import { inboxDedupeKey } from '../../inbox/engine.ts';
import { createScheduler, type Scheduler } from '../scheduler/scheduler.ts';
import { createReminderService } from './reminders.ts';

const NOW = new Date('2026-09-17T10:00:00.000Z');
const owned: LiveState = {
  pid: 1,
  status: 'idle',
  waitingFor: null,
  since: 't',
  ownership: 'owned',
  ptyId: 'pty-1',
  stage: null,
  currentTool: null,
  backgroundJobs: 0,
  runningSubagents: 0,
  contextFill: null,
};

// Shipped InboxUpsert carries no dedupeKey: a reminder's inbox item is keyed by
// `{ kind: 'reminder', scope: { domain: 'reminder', id } }`, one item per reminder.
const reminderKey = (id: string) => inboxDedupeKey({ kind: 'reminder', scope: { domain: 'reminder', id } });

const schedulers: Scheduler[] = [];
afterEach(() => {
  for (const s of schedulers.splice(0)) s.stop();
  vi.useRealTimers();
});

function setup(liveState: LiveState | null = owned, opts: { now?: () => Date } = { now: () => NOW }) {
  const s1 = makeSession({ id: 's1', live: liveState });
  const t = makeP5Context({ config: withWakecap('/Users/test/Wakecap'), data: { sessions: [s1] } });
  const sent: Array<[string, string]> = [];
  t.ctx.pty = { ...t.ctx.pty, sendText: async (id: string, text: string) => void sent.push([id, text]) };
  t.ctx.live = { get: () => s1 } as unknown as NonNullable<typeof t.ctx.live>;
  t.ctx.denyList = {
    check: (text: string) => ({
      denied: text.includes('rm -rf'),
      reason: text.includes('rm -rf') ? 'destructive' : null,
    }),
  };
  const inbox = recordingInbox();
  t.ctx.inbox = inbox;
  const scheduler = createScheduler({ db: t.ctx.db, log: pino({ level: 'silent' }), now: opts.now });
  schedulers.push(scheduler);
  const svc = createReminderService(t.ctx, { scheduler, now: opts.now });
  return { ...t, svc, scheduler, sent, upserts: inbox.upserts };
}

describe('reminder service', () => {
  it('creates a persisted one-shot job and validates input', () => {
    const { svc, scheduler } = setup();
    const r = svc.create({
      sessionPk: 'claude:s1',
      ticket: null,
      text: 're-check CI',
      dueAt: '2026-09-17T10:20:00.000Z',
      sendToSession: true,
    });
    expect(r).toMatchObject({ state: 'pending', sendToSession: true, firedAt: null });
    expect(scheduler.get(r.jobId)).toMatchObject({
      kind: 'reminder',
      runAt: '2026-09-17T10:20:00.000Z',
      payload: { reminderId: r.id },
    });
    expect(() =>
      svc.create({
        sessionPk: null,
        ticket: null,
        text: 'x',
        dueAt: '2026-09-17T09:00:00.000Z',
        sendToSession: false,
      }),
    ).toThrow(/future/);
    expect(() =>
      svc.create({
        sessionPk: 'claude:nope',
        ticket: null,
        text: 'x',
        dueAt: '2026-09-18T00:00:00.000Z',
        sendToSession: true,
      }),
    ).toThrow(/session/);
    expect(svc.list({ state: ['pending'] })).toHaveLength(1);
  });

  it('fires into the inbox and the owned session once', async () => {
    const { svc, sent, upserts } = setup();
    const r = svc.create({
      sessionPk: 'claude:s1',
      ticket: 'SAF-1',
      text: 're-check CI',
      dueAt: '2026-09-17T10:20:00.000Z',
      sendToSession: true,
    });
    await svc.fire(r.id);
    await svc.fire(r.id);
    expect(upserts).toEqual([
      expect.objectContaining({
        kind: 'reminder',
        sessionId: 's1',
        projectId: 'wakecap',
        ticket: 'SAF-1',
        reason: 're-check CI',
        payload: { reminderId: r.id, source: 'claude', id: 's1', sentToSession: true },
      }),
    ]);
    expect(upserts.map((u) => inboxDedupeKey(u))).toEqual([reminderKey(r.id)]);
    expect(sent).toEqual([['pty-1', 're-check CI']]);
    expect(svc.list({})[0]).toMatchObject({ state: 'fired', firedAt: NOW.toISOString() });
  });

  it('does not send to observed sessions or denied text, and can cancel', async () => {
    const observed = setup({ ...owned, ownership: 'observed', ptyId: null });
    const r1 = observed.svc.create({
      sessionPk: 'claude:s1',
      ticket: null,
      text: 'ping',
      dueAt: '2026-09-17T11:00:00.000Z',
      sendToSession: true,
    });
    await observed.svc.fire(r1.id);
    expect(observed.sent).toEqual([]);
    expect(observed.upserts[0]?.payload).toMatchObject({ sentToSession: false });

    const denied = setup();
    const r2 = denied.svc.create({
      sessionPk: 'claude:s1',
      ticket: null,
      text: 'rm -rf /',
      dueAt: '2026-09-17T11:00:00.000Z',
      sendToSession: true,
    });
    await denied.svc.fire(r2.id);
    expect(denied.sent).toEqual([]);
    expect(denied.ctx.audit?.list({ action: 'pty.input' })[0]).toMatchObject({
      result: 'denied',
      actor: 'automation',
      actorDetail: 'reminder',
    });

    const r3 = denied.svc.create({
      sessionPk: null,
      ticket: null,
      text: 'later',
      dueAt: '2026-09-17T12:00:00.000Z',
      sendToSession: false,
    });
    expect(denied.svc.cancel(r3.id).state).toBe('cancelled');
    expect(denied.scheduler.get(r3.jobId)).toBeNull();
    await denied.svc.fire(r3.id);
    expect(denied.upserts.filter((u) => inboxDedupeKey(u) === reminderKey(r3.id))).toEqual([]);
    expect(() => denied.svc.cancel('nope')).toThrow(/not found/);
  });

  it('fires through the scheduler when the job comes due, including after a restart', async () => {
    vi.useFakeTimers({ now: NOW });
    const clock = () => new Date(Date.now());
    const t = setup(owned, { now: clock });
    t.svc.start();
    t.scheduler.start();
    const r = t.svc.create({
      sessionPk: 'claude:s1',
      ticket: null,
      text: 're-check CI',
      dueAt: new Date(Date.now() + 2000).toISOString(),
      sendToSession: false,
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(t.upserts.map((u) => inboxDedupeKey(u))).toEqual([reminderKey(r.id)]);
    expect(t.svc.list({})[0]).toMatchObject({ id: r.id, state: 'fired' });

    // A reminder created before a restart is fired by the next process's scheduler.
    const pending = t.svc.create({
      sessionPk: null,
      ticket: null,
      text: 'after restart',
      dueAt: new Date(Date.now() + 60_000).toISOString(),
      sendToSession: false,
    });
    t.scheduler.stop();
    const restarted = createScheduler({ db: t.ctx.db, log: pino({ level: 'silent' }), now: clock });
    schedulers.push(restarted);
    const svc2 = createReminderService(t.ctx, { scheduler: restarted, now: clock });
    svc2.start();
    restarted.start();
    await vi.advanceTimersByTimeAsync(62_000);
    expect(t.upserts.map((u) => inboxDedupeKey(u))).toEqual([reminderKey(r.id), reminderKey(pending.id)]);
    expect(svc2.list({ state: ['pending'] })).toEqual([]);
  });
});
