import type { PrRef } from '@orc/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { DaemonContext } from '../../context.ts';
import { getPrStatus, upsertPrStatus } from '../../db/repos/pr-cache.ts';
import { ServiceError } from '../../services/errors.ts';
import { GitError } from '../../services/git/exec.ts';
import { parseQuery, phase4App } from './git-guard.ts';

const PrQuery = z.object({
  repo: z.string().min(1),
  number: z.coerce.number().int().positive(),
});

export function githubRoutes(ctx: DaemonContext): Hono {
  const app = phase4App();
  const gh = () => {
    if (!ctx.github) throw new ServiceError('gh_unavailable', 503, 'GitHub connector is not running');
    return ctx.github;
  };

  app.get('/github/status', async (c) => {
    if (!ctx.config().github.enabled) return c.json({ status: 'disabled' });
    return c.json({ status: await gh().status() });
  });

  app.get('/github/pr', async (c) => {
    const q = parseQuery(c, PrQuery);
    const ref: PrRef = {
      repo: q.repo,
      number: q.number,
      url: `https://github.com/${q.repo}/pull/${q.number}`,
    };
    try {
      const s = await gh().prStatus(ref);
      upsertPrStatus(ctx.db, s, new Date().toISOString());
      return c.json(s);
    } catch (err) {
      const cached = getPrStatus(ctx.db, q.repo, q.number);
      if (cached) return c.json(cached);
      throw err;
    }
  });

  app.get('/github/prs/mine', async (c) => {
    try {
      return c.json(await gh().myOpenPrs());
    } catch (err) {
      if (err instanceof GitError) throw new GitError('gh_unavailable', err.message, err.stderr);
      throw err;
    }
  });

  return app;
}
