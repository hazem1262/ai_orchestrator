import { join } from 'node:path';
import {
  CreateWorktreeBody,
  LaunchRequest,
  WorktreeArchiveBody,
  WorktreeListQuery,
  WorktreeOpenBody,
  WorktreePathBody,
  WorktreeScriptBody,
} from '@orc/api-contract';
import { branchName, worktreeDirName } from '@orc/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import { runAudited } from '../../services/git/audit.ts';
import { createLaunchService } from '../../services/launch.ts';
import type { WorktreeService } from '../../services/worktree/worktree.ts';
import { repoConfigFor } from '../../services/worktree/worktree-write.ts';
import { parseWith } from '../json.ts';
import { redactedJson } from '../redacted-json.ts';
import { parseJson, parseQuery, phase4App, requireConfirm } from './git-guard.ts';

const PathQuery = z.object({ path: z.string().min(1) });

/**
 * Worktree views carry paths discovered from session cwds (transcript-derived), so every body that
 * holds one goes out through `redactedJson`.
 */
export function worktreesRoutes(ctx: DaemonContext): Hono {
  const app = phase4App();
  const svc = (): WorktreeService => {
    if (!ctx.worktrees) throw new ServiceError('unavailable', 503, 'worktree service is not running');
    return ctx.worktrees;
  };

  app.get('/worktrees', (c) => redactedJson(c, svc().list(parseQuery(c, WorktreeListQuery))));

  app.post('/worktrees/discover', async (c) => {
    await svc().discover();
    return redactedJson(c, svc().list({ state: 'active' }));
  });

  app.get('/worktrees/one', (c) => {
    const { path } = parseQuery(c, PathQuery);
    const view = svc().get(path);
    if (!view) throw new ServiceError('not_found', 404, `unknown worktree ${path}`);
    return redactedJson(c, view);
  });

  app.post('/worktrees', async (c) => {
    const b = await parseJson(c, CreateWorktreeBody);
    const branch = branchName(b);
    const dir = repoConfigFor(ctx, b.repo)?.worktreeDir ?? '.worktrees';
    const path = join(b.repo, dir, worktreeDirName(branch));
    requireConfirm(
      b.confirm,
      `Create worktree ${path} on new branch ${branch} from ${b.base}${b.runSetup ? ' and run the setup script' : ''}${b.launch ? `, then launch ${b.launch.source}` : ''}`,
      { branch, path },
    );
    if (!b.launch) {
      const { view, setupPtyId } = await svc().createWith(b, { runSetup: b.runSetup, actor: 'user' });
      return redactedJson(c, { worktree: view, setupPtyId, launch: null });
    }
    // `parseWith`, not `.parse`: a zod v4 ZodError is not an `Error` and would escape `onError`.
    const req = parseWith(LaunchRequest, {
      source: b.launch.source,
      projectId: ctx.projects.resolve(b.repo),
      cwd: b.repo,
      prompt: b.launch.prompt,
      ...(b.launch.templateId ? { templateId: b.launch.templateId } : {}),
      ...(b.ticket ? { ticket: b.ticket } : {}),
      planApproval: b.launch.planApproval,
      worktree: { repo: b.repo, base: b.base, type: b.type, slug: b.slug },
    });
    const launcher = ctx.launcher ?? createLaunchService(ctx);
    const launch = await runAudited(
      ctx,
      'user',
      'session.launch',
      path,
      { source: b.launch.source, repo: b.repo, branch, ...(b.ticket ? { ticket: b.ticket } : {}) },
      () => launcher.launch(req),
    );
    const view =
      svc()
        .list({ repo: b.repo })
        .find((w) => w.branch === branch) ?? null;
    if (!view) throw new ServiceError('internal', 500, 'worktree was not recorded');
    return redactedJson(c, { worktree: view, setupPtyId: null, launch });
  });

  app.post('/worktrees/script', async (c) => {
    const b = await parseJson(c, WorktreeScriptBody);
    const row = svc().get(b.path);
    const script = row ? repoConfigFor(ctx, row.repo)?.[b.which] : undefined;
    requireConfirm(b.confirm, `Run the ${b.which} script${script ? ` (${script})` : ''} in ${b.path}`, {
      script: script ?? null,
    });
    return c.json(await svc().runScript(b.path, b.which));
  });

  app.post('/worktrees/open', async (c) => {
    const b = await parseJson(c, WorktreeOpenBody);
    await svc().open(b.path, b.target);
    return c.json({ ok: true });
  });

  app.get('/worktrees/sync-preview', async (c) => {
    const { path } = parseQuery(c, PathQuery);
    return redactedJson(c, await svc().syncPreview(path));
  });

  app.post('/worktrees/sync', async (c) => {
    const b = await parseJson(c, WorktreePathBody);
    if (!b.confirm) {
      const p = await svc().syncPreview(b.path);
      requireConfirm(false, `Copy ${p.files.length} changed file(s) from ${p.path} into ${p.mainPath}`, {
        files: p.files,
        mainDirty: p.mainDirty,
      });
    }
    return c.json(await svc().syncToMain(b.path));
  });

  app.post('/worktrees/archive', async (c) => {
    const b = await parseJson(c, WorktreeArchiveBody);
    const view = svc().get(b.path);
    if (view?.state !== 'active') throw new ServiceError('not_found', 404, `unknown worktree ${b.path}`);
    const external = !view.createdByApp;
    requireConfirm(
      b.confirm,
      `Remove worktree ${view.path}. Branch ${view.branch} is kept.${external ? ' This worktree was created outside the app.' : ''}`,
      { external, branch: view.branch },
    );
    if (external && !b.confirmExternal) {
      throw new ServiceError(
        'external_worktree',
        409,
        'this worktree was not created by the app; confirm it explicitly',
        { external: true },
      );
    }
    await svc().archiveAs(b.path, 'user', { allowExternal: b.confirmExternal });
    return c.json({ ok: true });
  });

  return app;
}
