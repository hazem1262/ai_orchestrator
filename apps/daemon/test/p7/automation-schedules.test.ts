import type { Automation, AutomationRunDetail } from '@orc/api-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  attachAutomationSchedules,
  floorToMinute,
  jobType,
  type ScheduleHost,
} from '../../src/services/automations/schedules.ts';
import type { TriggerFire } from '../../src/services/automations/service.ts';
import { createMemoryScheduler } from '../fakes/phase7.ts';

const cronAuto = (over: Partial<Automation> = {}): Automation => ({
  id: 'c1',
  name: 'Weekday digest',
  enabled: true,
  trigger: { type: 'cron', cron: '0 9 * * 1-5' },
  action: {
    templateId: 't',
    projectId: 'wakecap',
    useWorktree: false,
    headless: true,
    timeoutMin: 5,
    planApproval: false,
  },
  budgetUsd: 2,
  ...over,
});

function host(initial: Automation[]) {
  const store = new Map(initial.map((a) => [a.id, a] as const));
  const listeners = new Set<(id: string, a: Automation | null) => void>();
  const starts: Array<{ id: string; fire: TriggerFire }> = [];
  const h: ScheduleHost = {
    list: () => [...store.values()],
    get: (id) => store.get(id) ?? null,
    async start(id, fire) {
      starts.push({ id, fire });
      return null as AutomationRunDetail | null;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const change = (a: Automation | null, id: string) => {
    if (a) store.set(id, a);
    else store.delete(id);
    for (const l of listeners) l(id, a);
  };
  return { h, change, starts };
}

describe('attachAutomationSchedules', () => {
  it('floors fire times to the minute', () => {
    expect(floorToMinute(new Date('2026-09-17T09:00:42.123Z'))).toBe('2026-09-17T09:00:00.000Z');
    expect(jobType('c1')).toBe('automation:c1');
  });

  it('reconciles jobs at boot and follows changes', () => {
    const sched = createMemoryScheduler();
    sched.add({
      kind: 'automation',
      cron: '* * * * *',
      runAt: null,
      payload: { type: 'automation:deleted', automationId: 'deleted' },
      enabled: true,
    });
    const { h, change } = host([cronAuto(), cronAuto({ id: 'm1', trigger: { type: 'manual' } })]);
    const detach = attachAutomationSchedules(h, sched);
    expect(sched.jobs.map((j) => j.payload.automationId)).toEqual(['c1']);
    expect(sched.jobs[0]?.payload.type).toBe('automation:c1');
    change(cronAuto({ enabled: false }), 'c1');
    expect(sched.jobs).toHaveLength(0);
    change(cronAuto({ trigger: { type: 'cron', cron: '30 8 * * *' } }), 'c1');
    expect(sched.jobs.map((j) => j.cron)).toEqual(['30 8 * * *']);
    change(null, 'c1');
    expect(sched.jobs).toHaveLength(0);
    detach();
  });

  it('starts a run keyed by the scheduled minute, only for enabled automations', async () => {
    const sched = createMemoryScheduler();
    const { h, change, starts } = host([cronAuto()]);
    attachAutomationSchedules(h, sched, () => new Date('2026-09-17T09:00:07.500Z'));
    const job = sched.jobs[0];
    if (!job) throw new Error('job missing');
    await sched.fire('automation', job);
    expect(starts).toEqual([
      {
        id: 'c1',
        fire: {
          key: 'cron:2026-09-17T09:00:00.000Z',
          source: 'cron',
          vars: { scheduledFor: '2026-09-17T09:00:00.000Z' },
        },
      },
    ]);
    change(cronAuto({ enabled: false }), 'c1');
    await sched.fire('automation', job);
    expect(starts).toHaveLength(1);
  });

  it('ignores scheduler jobs of other kinds and other types', async () => {
    const sched = createMemoryScheduler();
    const { h, starts } = host([cronAuto()]);
    attachAutomationSchedules(h, sched);
    await sched.fire('automation', {
      id: 'x',
      kind: 'automation',
      cron: '* * * * *',
      runAt: null,
      payload: { type: 'automation:gone', automationId: 'gone' },
      enabled: true,
    });
    expect(starts).toEqual([]);
    const spy = vi.fn();
    sched.onFire('digest', spy);
    await sched.fire('digest', {
      id: 'd',
      kind: 'digest',
      cron: null,
      runAt: null,
      payload: {},
      enabled: true,
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
