import {
  ShipBackmergeBody,
  ShipCommitBody,
  ShipMergeBody,
  ShipPrBody,
  ShipPushBody,
} from '@orc/api-contract';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { DaemonContext } from '../../context.ts';
import { getPrStatus } from '../../db/repos/pr-cache.ts';
import { ServiceError } from '../../services/errors.ts';
import { currentBranch, type ShipService } from '../../services/ship/ship.ts';
import { dirtyFiles } from '../../services/worktree/worktree-read.ts';
import { redactedJson } from '../redacted-json.ts';
import { parseJson, parseQuery, phase4App, requireConfirm } from './git-guard.ts';

const SuggestQuery = z.object({ cwd: z.string().min(1), sessionPk: z.string().optional() });

export function shipRoutes(ctx: DaemonContext): Hono {
  const app = phase4App();
  const ship = (): ShipService => {
    if (!ctx.ship) throw new ServiceError('unavailable', 503, 'ship service is not running');
    return ctx.ship;
  };

  // The suggestion is built from the session's recap and prompts, so it is transcript-derived.
  app.get('/ship/suggest', async (c) => {
    const q = parseQuery(c, SuggestQuery);
    return redactedJson(c, await ship().suggest(q.cwd, q.sessionPk ?? null));
  });

  app.post('/ship/commit', async (c) => {
    const b = await parseJson(c, ShipCommitBody);
    if (!b.confirm) {
      const files = await dirtyFiles(b.cwd);
      requireConfirm(
        false,
        `Commit ${files.length} changed file(s) in ${b.cwd} as "${b.message.split('\n')[0]}"`,
        {
          files,
        },
      );
    }
    return c.json(await ship().commit(b.cwd, b.message));
  });

  app.post('/ship/push', async (c) => {
    const b = await parseJson(c, ShipPushBody);
    if (!b.confirm) {
      const branch = await currentBranch(b.cwd);
      requireConfirm(false, `Push ${branch} to origin (never forced)`, { branch });
    }
    await ship().push(b.cwd);
    return c.json({ ok: true });
  });

  app.post('/ship/pr', async (c) => {
    const b = await parseJson(c, ShipPrBody);
    requireConfirm(b.confirm, `Open ${b.draft ? 'a draft' : 'a'} pull request "${b.title}" into ${b.base}`);
    return c.json(
      await ship().createPr(b.cwd, { title: b.title, body: b.body, base: b.base, draft: b.draft }),
    );
  });

  app.post('/ship/merge', async (c) => {
    const b = await parseJson(c, ShipMergeBody);
    const cached = getPrStatus(ctx.db, b.pr.repo, b.pr.number);
    requireConfirm(
      b.confirm,
      `Merge ${b.pr.repo}#${b.pr.number} with ${b.method}. Branch protection still applies.`,
      {
        checks: cached?.checks ?? null,
        review: cached?.review ?? null,
      },
    );
    await ship().merge(b.pr, b.method);
    return c.json({ ok: true });
  });

  app.post('/ship/backmerge', async (c) => {
    const b = await parseJson(c, ShipBackmergeBody);
    requireConfirm(b.confirm, `Launch the /backmerge workflow in ${b.cwd}`);
    return c.json(await ship().backmerge(b.cwd, b.projectId, b.ticket));
  });

  return app;
}
