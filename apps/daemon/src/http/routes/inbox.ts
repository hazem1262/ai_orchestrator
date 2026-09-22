import { InboxActionBody, InboxListQuery } from '@orc/api-contract';
import type { Env, Hono } from 'hono';
import type { DaemonContext } from '../../context.ts';
import { InboxError } from '../../inbox/engine.ts';
import { redactedApiError, redactInboxItem } from '../redact-out.ts';

/**
 * Error bodies are built here rather than thrown as `ServiceError`, so the routes answer the same
 * way whether or not the app they are mounted on has the daemon's `onError`. Every body still goes
 * through `redactedApiError`, and every item through `redactInboxItem`.
 */
export function registerInboxRoutes<E extends Env>(app: Hono<E>, ctx: DaemonContext): void {
  const engine = () => {
    if (!ctx.inbox) throw new Error('inbox engine not initialised');
    return ctx.inbox;
  };

  app.get('/api/inbox', (c) => {
    const q = InboxListQuery.safeParse(c.req.query());
    if (!q.success)
      return c.json(redactedApiError('validation_failed', 'invalid inbox filter', q.error.issues), 400);
    return c.json(engine().list(q.data).map(redactInboxItem));
  });

  app.post('/api/inbox/:id/:action{done|snooze|reopen}', async (c) => {
    const id = c.req.param('id');
    const action = c.req.param('action');
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim() !== '') {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json(redactedApiError('validation_failed', 'request body must be JSON'), 400);
      }
    }
    const body = InboxActionBody.safeParse(raw);
    if (!body.success)
      return c.json(redactedApiError('validation_failed', 'invalid body', body.error.issues), 400);
    try {
      if (action === 'done') return c.json(redactInboxItem(engine().markDone(id)));
      if (action === 'reopen') return c.json(redactInboxItem(engine().reopen(id)));
      if (!body.data.until)
        return c.json(redactedApiError('validation_failed', 'snooze requires "until"'), 400);
      return c.json(redactInboxItem(engine().snooze(id, body.data.until)));
    } catch (err) {
      if (err instanceof InboxError) return c.json(redactedApiError(err.code, err.message), err.status);
      throw err;
    }
  });
}
