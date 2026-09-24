import { resolve } from 'node:path';
import { PlanContentQuery, PlansQuery } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { createLinksService, type LinksService } from '../../services/links/links.ts';
import { createPlanFinderFromContext, type PlanFinder } from '../../services/links/plans.ts';
import { redactedApiError } from '../redact-out.ts';
import { redactedJson } from '../redacted-json.ts';
import type { OrcApp } from '../types.ts';
import { sessionParams } from './session-detail.ts';

export function registerLinksRoutes(
  app: OrcApp,
  ctx: DaemonContext,
  opts: { home?: string; finder?: PlanFinder } = {},
): void {
  // Built on first request, not at registration: the route census builds the app from a stub
  // context that has no `paths`, and the finder reads `paths.claudeHome` when it is created.
  let state: { finder: PlanFinder; links: LinksService } | null = null;
  const get = () => {
    if (!state) {
      const finder = opts.finder ?? createPlanFinderFromContext(ctx, opts.home);
      state = { finder, links: createLinksService(ctx, finder) };
    }
    return state;
  };

  app.get('/api/sessions/:source/:id/links', async (c) => {
    const p = sessionParams(c);
    const body = p ? await get().links.forSession(p.source, p.id) : null;
    if (!body) return c.json(redactedApiError('not_found', 'session not found'), 404);
    return redactedJson(c, body);
  });

  app.get('/api/plans', async (c) => {
    const q = PlansQuery.safeParse(c.req.query());
    if (!q.success)
      return c.json(redactedApiError('validation_failed', 'invalid plans query', q.error.issues), 400);
    return redactedJson(c, await get().finder.search(q.data.q, q.data.limit));
  });

  app.get('/api/plans/content', async (c) => {
    const q = PlanContentQuery.safeParse(c.req.query());
    if (!q.success)
      return c.json(redactedApiError('validation_failed', 'path is required', q.error.issues), 400);
    if (!get().finder.isAllowed(q.data.path))
      return c.json(redactedApiError('forbidden', 'path is outside the plan roots'), 403);
    const text = await get().finder.read(q.data.path);
    if (text === null) return c.json(redactedApiError('not_found', 'plan not found'), 404);
    return redactedJson(c, { path: resolve(q.data.path), text });
  });
}
