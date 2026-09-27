import { ReminderCreateBody, RemindersListQuery } from '@orc/api-contract';
import type { ReminderState } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { need } from '../../services/need.ts';
import { parseStates, readBody, readQuery, sendError } from '../p5-util.ts';
import { redactedJson } from '../redacted-json.ts';
import type { OrcApp } from '../types.ts';

const STATES: readonly ReminderState[] = ['pending', 'fired', 'cancelled'];

export function registerReminderRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.reminders, 'reminders');

  // Reminder text is user-typed free text that may be sent to a session, so it goes out through redactedJson.
  app.get('/api/reminders', (c) => {
    const q = readQuery(c, RemindersListQuery);
    if (!q.ok) return q.res;
    return redactedJson(
      c,
      svc().list({ state: parseStates(q.data.state, STATES), sessionPk: q.data.sessionPk }),
    );
  });
  app.post('/api/reminders', async (c) => {
    const b = await readBody(c, ReminderCreateBody);
    if (!b.ok) return b.res;
    const d = b.data;
    const dueAt = d.dueAt ?? new Date(Date.now() + (d.inMinutes ?? 0) * 60_000).toISOString();
    try {
      return redactedJson(
        c,
        svc().create({
          sessionPk: d.sessionPk,
          ticket: d.ticket,
          text: d.text,
          dueAt,
          sendToSession: d.sendToSession,
        }),
      );
    } catch (err) {
      return sendError(c, err);
    }
  });
  app.post('/api/reminders/:id/cancel', (c) => {
    try {
      return redactedJson(c, svc().cancel(c.req.param('id')));
    } catch (err) {
      return sendError(c, err);
    }
  });
}
