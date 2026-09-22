import type { DaemonContext } from '../../context.ts';
import { redactSession } from '../redact-out.ts';
import type { OrcApp } from '../types.ts';

/**
 * NOT YET REGISTERED IN PRODUCTION. Like every other phase-2 route (inbox, launch, archive,
 * templates, notifications), this is wired by task 16's `registerPhase2Routes`, which must call it
 * **before** `createApp`'s `app.all('/api/*')` 404 catch-all or the route stays unreachable.
 * `createApp`'s `/api/*` middleware then supplies the host, origin and token checks.
 */
export function registerLiveRoutes(app: OrcApp, ctx: DaemonContext): void {
  // `ctx.live` is optional until the daemon entrypoint starts the tracker, so an early request
  // (or a daemon running with live tracking off) answers with an empty board, not a 500.
  app.get('/api/live', (c) => {
    const projectId = c.req.query('projectId');
    const items = (ctx.live?.list() ?? [])
      .filter((s) => !projectId || s.projectId === projectId)
      .map(redactSession);
    return c.json(items);
  });
}
