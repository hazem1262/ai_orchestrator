import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import type { Logger } from 'pino';
import type { OrcDb } from '../../db/client.ts';
import { deleteJob, getJob, insertJob, listJobs, markFired } from '../../db/repos/scheduled-jobs.ts';

export interface ScheduledJob {
  id: string;
  kind: 'reminder' | 'automation' | 'digest';
  cron: string | null;
  runAt: string | null;
  payload: Record<string, unknown>;
  enabled: boolean;
}

export interface Scheduler {
  add(job: Omit<ScheduledJob, 'id'>): ScheduledJob;
  remove(id: string): void;
  list(kind?: ScheduledJob['kind']): ScheduledJob[];
  onFire(kind: ScheduledJob['kind'], fn: (job: ScheduledJob) => Promise<void>): void;
  get(id: string): ScheduledJob | null;
  start(): void;
  stop(): void;
}

export function createScheduler(opts: { db: OrcDb; log: Logger; now?: () => Date }): Scheduler {
  const { db, log } = opts;
  const now = opts.now ?? (() => new Date());
  const handlers = new Map<ScheduledJob['kind'], Array<(job: ScheduledJob) => Promise<void>>>();
  const timers = new Map<string, Cron>();
  let started = false;

  const disarm = (id: string) => {
    timers.get(id)?.stop();
    timers.delete(id);
  };

  async function fire(id: string): Promise<void> {
    const job = getJob(db, id);
    if (!job?.enabled) return;
    const oneShot = job.cron === null;
    // At-most-once: persist before running handlers.
    markFired(db, id, now().toISOString(), oneShot);
    if (oneShot) disarm(id);
    for (const h of handlers.get(job.kind) ?? []) {
      try {
        await h({ ...job, enabled: !oneShot });
      } catch (err) {
        log.error({ err, jobId: id, kind: job.kind }, 'scheduled job handler failed');
      }
    }
  }

  function arm(job: ScheduledJob): void {
    disarm(job.id);
    if (!started || !job.enabled) return;
    if (job.cron !== null) {
      timers.set(job.id, new Cron(job.cron, { protect: true }, () => fire(job.id)));
      return;
    }
    if (job.runAt !== null) {
      const at = new Date(job.runAt);
      if (at.getTime() <= now().getTime()) {
        void fire(job.id);
        return;
      }
      timers.set(job.id, new Cron(at, { maxRuns: 1 }, () => fire(job.id)));
    }
  }

  return {
    add(input) {
      if (input.cron === null && input.runAt === null) throw new Error('a scheduled job needs cron or runAt');
      if (input.cron !== null) {
        try {
          new Cron(input.cron, { paused: true }).stop();
        } catch {
          throw new Error(`invalid cron expression: ${input.cron}`);
        }
      }
      if (input.runAt !== null && Number.isNaN(Date.parse(input.runAt)))
        throw new Error(`invalid runAt: ${input.runAt}`);
      const job: ScheduledJob = { ...input, id: randomUUID() };
      insertJob(db, job, now().toISOString());
      arm(job);
      return job;
    },
    remove(id) {
      disarm(id);
      deleteJob(db, id);
    },
    list: (kind) => listJobs(db, kind),
    onFire(kind, fn) {
      handlers.set(kind, [...(handlers.get(kind) ?? []), fn]);
    },
    get: (id) => getJob(db, id),
    start() {
      if (started) return;
      started = true;
      for (const job of listJobs(db)) arm(job);
    },
    stop() {
      started = false;
      for (const id of [...timers.keys()]) disarm(id);
    },
  };
}

/** Makes sure exactly one job of `kind` with `payload.type === type` exists with this cron. */
export function ensureCronJob(
  s: Scheduler,
  kind: ScheduledJob['kind'],
  type: string,
  cron: string,
  extra: Record<string, unknown> = {},
): ScheduledJob {
  const existing = s.list(kind).filter((j) => j.payload.type === type);
  const same = existing.find((j) => j.cron === cron && j.enabled);
  for (const j of existing) if (j !== same) s.remove(j.id);
  return same ?? s.add({ kind, cron, runAt: null, payload: { ...extra, type }, enabled: true });
}

export function removeJobsOfType(s: Scheduler, kind: ScheduledJob['kind'], type: string): number {
  const jobs = s.list(kind).filter((j) => j.payload.type === type);
  for (const j of jobs) s.remove(j.id);
  return jobs.length;
}
