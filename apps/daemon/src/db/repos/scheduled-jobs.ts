import { asc, eq } from 'drizzle-orm';
import type { ScheduledJob } from '../../services/scheduler/scheduler.ts';
import type { OrcDb } from '../client.ts';
import { scheduledJobs } from '../schema.ts';

type Row = typeof scheduledJobs.$inferSelect;

function toJob(r: Row): ScheduledJob {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(r.payloadJson);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return { id: r.id, kind: r.kind, cron: r.cron, runAt: r.runAt, payload, enabled: r.enabled };
}

export function insertJob(db: OrcDb, j: ScheduledJob, createdAt: string): void {
  db.insert(scheduledJobs)
    .values({
      id: j.id,
      kind: j.kind,
      cron: j.cron,
      runAt: j.runAt,
      payloadJson: JSON.stringify(j.payload),
      enabled: j.enabled,
      lastFiredAt: null,
      createdAt,
    })
    .run();
}

export function getJob(db: OrcDb, id: string): ScheduledJob | null {
  const r = db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)).get();
  return r ? toJob(r) : null;
}

export function listJobs(db: OrcDb, kind?: ScheduledJob['kind']): ScheduledJob[] {
  const q = db.select().from(scheduledJobs);
  const rows = kind
    ? q.where(eq(scheduledJobs.kind, kind)).orderBy(asc(scheduledJobs.createdAt)).all()
    : q.orderBy(asc(scheduledJobs.createdAt)).all();
  return rows.map(toJob);
}

export function deleteJob(db: OrcDb, id: string): void {
  db.delete(scheduledJobs).where(eq(scheduledJobs.id, id)).run();
}

export function markFired(db: OrcDb, id: string, at: string, disable: boolean): void {
  db.update(scheduledJobs)
    .set(disable ? { lastFiredAt: at, enabled: false } : { lastFiredAt: at })
    .where(eq(scheduledJobs.id, id))
    .run();
}
