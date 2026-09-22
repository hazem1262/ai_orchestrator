import { existsSync } from 'node:fs';
import { ConfirmBody, LaunchRequest, OpenInBody } from '@orc/api-contract';
import type { Source } from '@orc/core';
import type { Env, Hono } from 'hono';
import type { DaemonContext } from '../../context.ts';
import type { ExecFn } from '../../live/liveness.ts';
import { LaunchError } from '../../services/launch.ts';
import { openIn } from '../../services/open-in.ts';
import { sessionPk } from '../../services/sessions.ts';
import { redactedApiError } from '../redact-out.ts';

const SOURCES = new Set<string>(['claude', 'codex', 'agnc']);

/**
 * Error bodies are built here rather than thrown, so the routes answer the same way whether or not
 * the app they are mounted on has the daemon's `onError`. Every body goes through
 * `redactedApiError`: messages and details carry cwds, session names and zod issues.
 */
export function registerLaunchRoutes<E extends Env>(
  app: Hono<E>,
  ctx: DaemonContext,
  opts: { exec?: ExecFn } = {},
): void {
  app.post('/api/sessions/launch', async (c) => {
    const parsed = LaunchRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        redactedApiError('validation_failed', 'invalid launch request', parsed.error.issues),
        400,
      );
    }
    if (!ctx.launcher)
      return c.json(redactedApiError('launcher_unavailable', 'launcher not initialised'), 503);
    try {
      return c.json(await ctx.launcher.launch(parsed.data));
    } catch (err) {
      if (err instanceof LaunchError) {
        return c.json(redactedApiError(err.code, err.message, err.details), err.status);
      }
      throw err;
    }
  });

  app.post('/api/sessions/:source/:id/kill', async (c) => {
    const source = c.req.param('source');
    const id = c.req.param('id');
    if (!SOURCES.has(source)) return c.json(redactedApiError('validation_failed', 'unknown source'), 400);
    const body = ConfirmBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json(redactedApiError('validation_failed', 'invalid body', body.error.issues), 400);
    }
    const s = ctx.live?.get(sessionPk(source as Source, id));
    if (!s?.live || s.live.status === 'ended') {
      return c.json(redactedApiError('not_live', `session ${source}:${id} is not running`), 404);
    }
    if (body.data.confirm !== true) {
      const cwd = s.cwds.at(-1) ?? s.startCwd;
      return c.json(
        redactedApiError('confirmation_required', 'confirm to stop this session', {
          summary: `Stop "${s.name ?? id}" (pid ${s.live.pid ?? '?'}) in ${cwd}?`,
        }),
        409,
      );
    }
    if (!ctx.launcher)
      return c.json(redactedApiError('launcher_unavailable', 'launcher not initialised'), 503);
    try {
      return c.json(await ctx.launcher.kill(source as Source, id));
    } catch (err) {
      if (err instanceof LaunchError) {
        return c.json(redactedApiError(err.code, err.message, err.details), err.status);
      }
      throw err;
    }
  });

  app.post('/api/sessions/:source/:id/open-in', async (c) => {
    const source = c.req.param('source');
    const id = c.req.param('id');
    if (!SOURCES.has(source)) return c.json(redactedApiError('validation_failed', 'unknown source'), 400);
    const body = OpenInBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(redactedApiError('validation_failed', 'invalid body', body.error.issues), 400);
    }
    const s = ctx.live?.get(sessionPk(source as Source, id)) ?? ctx.sessions.get(source as Source, id);
    if (!s) return c.json(redactedApiError('not_found', `session ${source}:${id} not found`), 404);
    const path = s.cwds.at(-1) ?? s.startCwd;
    if (!existsSync(path)) {
      return c.json(redactedApiError('cwd_not_found', `directory no longer exists: ${path}`), 404);
    }
    try {
      await openIn(body.data.app, path, opts.exec);
    } catch (err) {
      return c.json(
        redactedApiError('open_in_failed', err instanceof Error ? err.message : String(err)),
        500,
      );
    }
    if (body.data.remember && s.projectId) ctx.projects.update(s.projectId, { openIn: body.data.app });
    return c.json({ ok: true as const });
  });
}
