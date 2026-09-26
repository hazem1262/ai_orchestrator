import { type Context, Hono } from 'hono';
import type { z } from 'zod';
import { ServiceError, type ServiceErrorStatus } from '../../services/errors.ts';
import { GitError } from '../../services/git/exec.ts';
import { LaunchError } from '../../services/launch.ts';
import { redactedApiError } from '../redact-out.ts';

export const GIT_ERROR_STATUS: Readonly<Record<string, ServiceErrorStatus>> = {
  not_found: 404,
  not_a_worktree: 404,
  no_worktree: 404,
  hunk_not_found: 404,
  no_script: 404,
  not_owned: 403,
  forbidden_git_args: 400,
  dirty_worktree: 409,
  main_dirty: 409,
  external_worktree: 409,
  worktree_exists: 409,
  is_main_checkout: 409,
  nothing_to_commit: 409,
  protected_branch: 409,
  push_rejected: 409,
  no_pending_plan: 409,
  gh_unavailable: 503,
  git_failed: 502,
};

/** Maps a service-layer error onto a `ServiceError` carrying its HTTP status; anything else is returned as is. */
export function toHttpError(err: unknown): unknown {
  if (err instanceof GitError)
    return new ServiceError(err.code, GIT_ERROR_STATUS[err.code] ?? 500, err.message);
  if (err instanceof Error && /^not_found:/.test(err.message))
    return new ServiceError('not_found', 404, err.message);
  return err;
}

/** Throws `409 confirmation_required` with a human summary unless the caller confirmed. */
export function requireConfirm(
  confirm: boolean,
  summary: string,
  details: Record<string, unknown> = {},
): void {
  if (!confirm) throw new ServiceError('confirmation_required', 409, summary, { summary, ...details });
}

export async function parseJson<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ServiceError('validation_failed', 400, 'request body must be JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new ServiceError('validation_failed', 400, 'invalid request body', r.error.issues);
  return r.data;
}

export function parseQuery<T>(c: Context, schema: z.ZodType<T>): T {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw new ServiceError('validation_failed', 400, 'invalid query', r.error.issues);
  return r.data;
}

/**
 * A Hono sub-app whose `onError` renders §6 error bodies, so the phase 4 routes answer the same way
 * whether or not they are mounted under the daemon's own `onError`. Every body goes through
 * `redactedApiError`: messages and details carry paths, branch names and git stderr.
 */
export function phase4App(): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    const mapped = toHttpError(err);
    if (mapped instanceof ServiceError) {
      return c.json(redactedApiError(mapped.code, mapped.message, mapped.details), mapped.status);
    }
    if (mapped instanceof LaunchError) {
      return c.json(redactedApiError(mapped.code, mapped.message, mapped.details), mapped.status);
    }
    return c.json(redactedApiError('internal', 'internal error'), 500);
  });
  return app;
}
