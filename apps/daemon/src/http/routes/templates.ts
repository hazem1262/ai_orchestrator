import type { Env, Hono } from 'hono';
import type { DaemonContext } from '../../context.ts';

/** Listing has no error path; an unwired registry answers with an empty list. */
export function registerTemplateRoutes<E extends Env>(app: Hono<E>, ctx: DaemonContext): void {
  app.get('/api/templates', (c) => c.json(ctx.templates?.list(c.req.query('projectId') || undefined) ?? []));
}
