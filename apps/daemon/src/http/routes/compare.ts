import { CompareEstimateQuery, LaunchRequest, PickWinnerBody } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import { parseWith, readJson } from '../json.ts';
import { ConfirmBody, need, requireConfirmed } from '../p7-guard.ts';
import { redactedJson } from '../redacted-json.ts';
import type { OrcApp } from '../types.ts';

/**
 * P7 compare mode. `ctx.compare` is optional (set by `createPhase7`); while unset every route
 * answers `409 not_enabled`. Groups carry the prompt, labels, worktree paths and launch errors, and
 * the view adds Claude recaps, so every body goes out through `redactedJson`.
 */
export function registerCompareRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.compare, 'compare mode');

  app.post('/api/compare', async (c) => {
    const req = await readJson(c, LaunchRequest);
    return redactedJson(c, await svc().launch(req), 201);
  });

  // `svc()` runs before the query is parsed, so a missing service answers 409 rather than 400.
  app.get('/api/compare/estimate', (c) => {
    const s = svc();
    const q = parseWith(CompareEstimateQuery, c.req.query());
    return c.json(s.estimate(q.projectId ?? null, q.n));
  });

  app.get('/api/compare/:groupId', async (c) => redactedJson(c, await svc().view(c.req.param('groupId'))));

  app.post('/api/compare/:groupId/winner', async (c) => {
    const { index } = await readJson(c, PickWinnerBody);
    return redactedJson(c, svc().pickWinner(c.req.param('groupId'), index));
  });

  app.post('/api/compare/:groupId/archive-losers', async (c) => {
    const body = await readJson(c, ConfirmBody);
    const id = c.req.param('groupId');
    const g = svc().get(id);
    if (!g) throw new ServiceError('not_found', 404, `compare group ${id} not found`);
    if (g.winnerIndex === null) {
      throw new ServiceError('invalid_state', 409, 'pick a winner before archiving the others');
    }
    const losers = g.variants.filter((v) => v.index !== g.winnerIndex);
    requireConfirmed(
      body,
      `Stop ${losers.length} losing session(s) and archive their worktrees: ${losers
        .map((v) => v.worktreePath ?? v.label)
        .join(', ')}. Worktrees with uncommitted changes are kept, and every branch stays.`,
      { losers: losers.map((v) => v.label) },
    );
    return redactedJson(c, await svc().archiveLosers(id));
  });
}
