import type { Automation } from '@orc/api-contract';
import { ensureCronJob, removeJobsOfType, type Scheduler } from '../scheduler/scheduler.ts';
import type { AutomationServiceImpl } from './service.ts';

export type ScheduleHost = Pick<AutomationServiceImpl, 'list' | 'get' | 'start' | 'onChange'>;

export const jobType = (automationId: string): string => `automation:${automationId}`;

export function floorToMinute(d: Date): string {
  const c = new Date(d.getTime());
  c.setUTCSeconds(0, 0);
  return c.toISOString();
}

/**
 * Keeps exactly one P5 scheduler job per enabled cron automation and starts a run when it fires.
 * The run's trigger key is the scheduled minute, so the DB unique index makes it at-most-once.
 */
export function attachAutomationSchedules(
  svc: ScheduleHost,
  scheduler: Scheduler,
  now: () => Date = () => new Date(),
): () => void {
  const sync = (id: string, a: Automation | null) => {
    if (a?.enabled && a.trigger.type === 'cron') {
      ensureCronJob(scheduler, 'automation', jobType(id), a.trigger.cron, { automationId: id });
      return;
    }
    removeJobsOfType(scheduler, 'automation', jobType(id));
  };

  const automations = svc.list();
  const known = new Set(automations.map((a) => a.id));
  for (const j of scheduler.list('automation')) {
    if (!known.has(String(j.payload.automationId))) scheduler.remove(j.id);
  }
  for (const a of automations) sync(a.id, a);

  scheduler.onFire('automation', async (job) => {
    const id = String(job.payload.automationId ?? '');
    if (job.payload.type !== jobType(id)) return;
    const a = svc.get(id);
    if (!a?.enabled || a.trigger.type !== 'cron') return;
    const scheduledFor = floorToMinute(now());
    await svc.start(id, { key: `cron:${scheduledFor}`, source: 'cron', vars: { scheduledFor } });
  });

  return svc.onChange(sync);
}
