import { randomUUID } from 'node:crypto';
import { type Reminder, type ReminderState, truncateText } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { getReminder, insertReminder, listReminders, setReminderState } from '../../db/repos/reminders.ts';
import { ServiceError } from '../errors.ts';
import type { Scheduler } from '../scheduler/scheduler.ts';

export interface CreateReminderInput {
  sessionPk: string | null;
  ticket: string | null;
  text: string;
  dueAt: string;
  sendToSession: boolean;
}

export interface ReminderService {
  create(i: CreateReminderInput): Reminder;
  list(f: { state?: ReminderState[]; sessionPk?: string }): Reminder[];
  cancel(id: string): Reminder;
  fire(reminderId: string): Promise<void>;
  start(): void;
}

export function createReminderService(
  ctx: DaemonContext,
  deps: { scheduler: Scheduler; now?: () => Date },
): ReminderService {
  const now = deps.now ?? (() => new Date());

  async function fire(id: string): Promise<void> {
    const r = getReminder(ctx.db, id);
    if (r?.state !== 'pending') return;
    setReminderState(ctx.db, id, 'fired', now().toISOString());
    const s = r.sessionPk ? ctx.sessions.getByPk(r.sessionPk) : null;
    const live = r.sessionPk ? (ctx.live?.get(r.sessionPk)?.live ?? s?.live ?? null) : null;
    let sent = false;
    if (r.sendToSession && s && live?.ownership === 'owned' && live.ptyId) {
      const verdict = ctx.denyList.check(r.text, s.projectId);
      if (verdict.denied) {
        ctx.audit.record({
          actor: 'automation',
          actorDetail: 'reminder',
          action: 'pty.input',
          target: r.sessionPk,
          params: { reminderId: id },
          result: 'denied',
          error: verdict.reason,
        });
      } else {
        // ctx.pty is wrapped by withPtyInputAudit, so this input is audited.
        await ctx.pty.sendText(live.ptyId, r.text);
        sent = true;
      }
    }
    ctx.inbox?.upsert({
      kind: 'reminder',
      scope: { domain: 'reminder', id },
      sessionId: s?.id ?? null,
      projectId: s?.projectId ?? null,
      ticket: r.ticket,
      reason: truncateText(r.text, 200),
      payload: { reminderId: id, ...(s ? { source: s.source, id: s.id } : {}), sentToSession: sent },
    });
  }

  return {
    create(i) {
      if (Number.isNaN(Date.parse(i.dueAt)) || Date.parse(i.dueAt) <= now().getTime()) {
        throw new ServiceError('validation_failed', 400, 'dueAt must be in the future');
      }
      if (i.sessionPk !== null && !ctx.sessions.getByPk(i.sessionPk)) {
        throw new ServiceError('not_found', 404, 'session not found');
      }
      const id = randomUUID();
      const dueAt = new Date(i.dueAt).toISOString();
      const job = deps.scheduler.add({
        kind: 'reminder',
        cron: null,
        runAt: dueAt,
        payload: { reminderId: id },
        enabled: true,
      });
      const r: Reminder = {
        id,
        jobId: job.id,
        sessionPk: i.sessionPk,
        ticket: i.ticket,
        text: i.text,
        dueAt,
        sendToSession: i.sendToSession,
        state: 'pending',
        createdAt: now().toISOString(),
        firedAt: null,
      };
      insertReminder(ctx.db, r);
      return r;
    },
    list: (f) => listReminders(ctx.db, f),
    cancel(id) {
      const r = getReminder(ctx.db, id);
      if (!r) throw new ServiceError('not_found', 404, 'reminder not found');
      if (r.state === 'pending') {
        deps.scheduler.remove(r.jobId);
        setReminderState(ctx.db, id, 'cancelled', null);
      }
      return getReminder(ctx.db, id) ?? r;
    },
    fire,
    start() {
      deps.scheduler.onFire('reminder', async (job) => {
        const rid = job.payload.reminderId;
        if (typeof rid === 'string') await fire(rid);
      });
    },
  };
}
