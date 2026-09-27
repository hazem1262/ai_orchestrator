import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../db/client.ts';
import {
  createScheduler,
  ensureCronJob,
  removeJobsOfType,
  type ScheduledJob,
  type Scheduler,
} from './scheduler.ts';

const log = pino({ level: 'silent' });
const dbs: Array<{ close(): void }> = [];
const schedulers: Scheduler[] = [];
function freshDb() {
  const h = openDb(join(mkdtempSync(join(tmpdir(), 'orc-sched-')), 'index.db'));
  dbs.push(h);
  return h.db;
}
function make(db: ReturnType<typeof freshDb>, now?: () => Date) {
  const s = createScheduler({ db, log, now });
  schedulers.push(s);
  return s;
}
beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-27T12:00:00.000Z') });
});
afterEach(() => {
  for (const s of schedulers.splice(0)) s.stop();
  for (const d of dbs.splice(0)) d.close();
  vi.useRealTimers();
});

describe('scheduler', () => {
  it('fires a one-shot job once and disables it', async () => {
    const s = make(freshDb());
    const fired: ScheduledJob[] = [];
    s.onFire('reminder', async (j) => void fired.push(j));
    s.start();
    const job = s.add({
      kind: 'reminder',
      cron: null,
      runAt: new Date(Date.now() + 1100).toISOString(),
      payload: { reminderId: 'r1' },
      enabled: true,
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.payload).toEqual({ reminderId: 'r1' });
    expect(s.get(job.id)?.enabled).toBe(false);
  });

  it('catches up an overdue one-shot job exactly once across restarts', async () => {
    const db = freshDb();
    const a = make(db);
    const job = a.add({
      kind: 'reminder',
      cron: null,
      runAt: '2026-01-01T00:00:00.000Z',
      payload: {},
      enabled: true,
    });
    a.stop();
    const fired: string[] = [];
    const b = make(db);
    b.onFire('reminder', async (j) => void fired.push(j.id));
    b.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fired).toEqual([job.id]);
    b.stop();
    const c = make(db);
    c.onFire('reminder', async (j) => void fired.push(j.id));
    c.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(fired).toEqual([job.id]);
  });

  it('runs a seconds-level cron job and keeps it enabled', async () => {
    const s = make(freshDb());
    let n = 0;
    s.onFire('digest', async () => {
      n++;
    });
    s.start();
    const job = s.add({
      kind: 'digest',
      cron: '* * * * * *',
      runAt: null,
      payload: { type: 't' },
      enabled: true,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(s.get(job.id)?.enabled).toBe(true);
  });

  it('rejects invalid jobs and stops removed ones', async () => {
    const s = make(freshDb());
    expect(() =>
      s.add({ kind: 'digest', cron: 'not a cron', runAt: null, payload: {}, enabled: true }),
    ).toThrow(/invalid cron/);
    expect(() => s.add({ kind: 'digest', cron: null, runAt: null, payload: {}, enabled: true })).toThrow(
      /cron or runAt/,
    );
    let n = 0;
    s.onFire('digest', async () => {
      n++;
    });
    s.start();
    const job = s.add({ kind: 'digest', cron: '* * * * * *', runAt: null, payload: {}, enabled: true });
    s.remove(job.id);
    await vi.advanceTimersByTimeAsync(1300);
    expect(n).toBe(0);
    expect(s.list('digest')).toEqual([]);
  });

  it('logs handler errors without breaking other handlers', async () => {
    const s = make(freshDb());
    const ok: string[] = [];
    s.onFire('reminder', async () => {
      throw new Error('boom');
    });
    s.onFire('reminder', async (j) => void ok.push(j.id));
    s.start();
    const job = s.add({
      kind: 'reminder',
      cron: null,
      runAt: '2026-01-01T00:00:00.000Z',
      payload: {},
      enabled: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ok).toEqual([job.id]);
  });

  it('ensureCronJob is idempotent and replaces a changed cron', () => {
    const s = make(freshDb());
    const a = ensureCronJob(s, 'digest', 'weekly_digest', '0 9 * * 1');
    const b = ensureCronJob(s, 'digest', 'weekly_digest', '0 9 * * 1');
    expect(b.id).toBe(a.id);
    const c = ensureCronJob(s, 'digest', 'weekly_digest', '0 10 * * 1');
    expect(c.id).not.toBe(a.id);
    expect(s.list('digest').map((j) => j.cron)).toEqual(['0 10 * * 1']);
    expect(removeJobsOfType(s, 'digest', 'weekly_digest')).toBe(1);
    expect(s.list('digest')).toEqual([]);
  });
});
