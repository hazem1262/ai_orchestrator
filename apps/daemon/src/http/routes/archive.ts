import { ArchiveRestoreBody, type ArchiveStatus, RECOMMENDED_CLEANUP_SNIPPET } from '@orc/api-contract';
import type { Env, Hono } from 'hono';
import type { DaemonContext } from '../../context.ts';
import { ArchiveError } from '../../services/archive/archive.ts';
import { redactedApiError, redactValue } from '../redact-out.ts';

const unavailable = () => redactedApiError('archive_unavailable', 'archive not initialised');

/**
 * `GET /api/archive/status`, `POST /api/archive/sync` and `POST /api/archive/restore`.
 *
 * Error bodies are built here rather than thrown, so the routes answer the same way whether or not
 * the app they are mounted on has the daemon's `onError`. Every body that carries a path goes
 * through the redaction boundary: restore targets are transcript paths, and a project directory
 * name is derived from a cwd, which can hold a credential.
 */
export function registerArchiveRoutes<E extends Env>(app: Hono<E>, ctx: DaemonContext): void {
  app.get('/api/archive/status', (c) => {
    const a = ctx.archive;
    if (!a) return c.json(unavailable(), 503);
    const body: ArchiveStatus = {
      ...a.status(),
      codec: a.codec(),
      recommendedSnippet: RECOMMENDED_CLEANUP_SNIPPET,
    };
    return c.json(body);
  });

  app.post('/api/archive/sync', async (c) => {
    const a = ctx.archive;
    if (!a) return c.json(unavailable(), 503);
    const { copied } = await a.syncAll();
    return c.json({ copied });
  });

  app.post('/api/archive/restore', async (c) => {
    const a = ctx.archive;
    if (!a) return c.json(unavailable(), 503);
    const body = ArchiveRestoreBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(redactedApiError('validation_failed', 'invalid restore request', body.error.issues), 400);
    }
    const { source, id, confirm } = body.data;
    try {
      const { targets } = a.restorePlan(source, id);
      if (confirm !== true) {
        return c.json(
          redactedApiError('confirmation_required', 'confirm to restore into ~/.claude/projects', {
            summary: `Restore ${targets.length} transcript file(s) for ${source}:${id} into ${ctx.paths.claudeHome}/projects? Existing files are never overwritten.`,
            targets,
          }),
          409,
        );
      }
      await a.restore(source, id);
      return c.json({ restored: redactValue(targets) as string[] });
    } catch (err) {
      if (err instanceof ArchiveError) {
        return c.json(redactedApiError(err.code, err.message, err.details), err.status);
      }
      throw err;
    }
  });
}
