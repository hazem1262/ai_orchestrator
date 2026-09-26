import {
  CheckpointCreateBody,
  CheckpointRewindBody,
  DiffQuery,
  DiffRevertBody,
  ReviewCommentsBody,
} from '@orc/api-contract';
import type { Source } from '@orc/core';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { DaemonContext } from '../../context.ts';
import { getCheckpoint } from '../../db/repos/checkpoints.ts';
import { ServiceError } from '../../services/errors.ts';
import { sessionWorkdir } from '../../services/review/review.ts';
import { redactedJson } from '../redacted-json.ts';
import { parseJson, parseQuery, phase4App, requireConfirm } from './git-guard.ts';

const SourceParam = z.enum(['claude', 'codex', 'agnc']);
const SessionPkQuery = z.object({ sessionPk: z.string().min(1) });

function sourceOf(c: Context): Source {
  const r = SourceParam.safeParse(c.req.param('source'));
  if (!r.success) throw new ServiceError('validation_failed', 400, 'unknown session source');
  return r.data;
}

/**
 * Diff, checkpoint and review routes. Diffs carry file contents and review summaries carry
 * transcript-derived text (recap, cwd), so every success body goes out through `redactedJson`.
 */
export function reviewRoutes(ctx: DaemonContext): Hono {
  const app = phase4App();
  const need = <T>(v: T | undefined, name: string): T => {
    if (!v) throw new ServiceError('unavailable', 503, `${name} service is not running`);
    return v;
  };

  app.get('/diff', async (c) => {
    const q = parseQuery(c, DiffQuery);
    return redactedJson(
      c,
      await need(ctx.diff, 'diff').diff(q.cwd, {
        ...(q.from ? { from: q.from } : {}),
        ...(q.to ? { to: q.to } : {}),
      }),
    );
  });

  app.post('/diff/revert', async (c) => {
    const b = await parseJson(c, DiffRevertBody);
    const what =
      b.hunkIndex === undefined ? `all changes to ${b.file}` : `hunk ${b.hunkIndex + 1} of ${b.file}`;
    requireConfirm(
      b.confirm,
      `Revert ${what} in ${b.cwd}. A safety snapshot is kept under refs/orchestrator/reverts/.`,
    );
    return redactedJson(
      c,
      await need(ctx.diff, 'diff').revert(b.cwd, b.file, {
        ...(b.hunkIndex === undefined ? {} : { hunkIndex: b.hunkIndex }),
        ...(b.from ? { from: b.from } : {}),
      }),
    );
  });

  app.get('/checkpoints', (c) => {
    const { sessionPk } = parseQuery(c, SessionPkQuery);
    return redactedJson(c, need(ctx.checkpoints, 'checkpoint').list(sessionPk));
  });

  app.get('/checkpoints/:id/diff', async (c) => {
    const cps = need(ctx.checkpoints, 'checkpoint');
    const row = getCheckpoint(ctx.db, c.req.param('id'));
    if (!row) throw new ServiceError('not_found', 404, 'unknown checkpoint');
    // The previous non-safety checkpoint of the same session, or the snapshot's parent for the first.
    const all = cps.list(row.sessionPk);
    const idx = all.findIndex((x) => x.id === row.id);
    const earlier = all.slice(0, Math.max(0, idx)).filter((x) => x.kind !== 'safety');
    const from = earlier[earlier.length - 1]?.commit ?? `${row.commit}^`;
    return redactedJson(c, await need(ctx.diff, 'diff').diff(row.worktreePath, { from, to: row.commit }));
  });

  app.post('/checkpoints', async (c) => {
    const b = await parseJson(c, CheckpointCreateBody);
    const s = ctx.sessions.getByPk(b.sessionPk);
    if (!s) throw new ServiceError('not_found', 404, `session ${b.sessionPk} not found`);
    const wt = ctx.worktrees?.findByCwd(sessionWorkdir(s)) ?? null;
    if (!wt) throw new ServiceError('no_worktree', 404, 'the session is not inside a known worktree');
    requireConfirm(b.confirm, `Save a checkpoint of ${wt.path} (HEAD, index and stash are not touched)`);
    return redactedJson(
      c,
      await need(ctx.checkpoints, 'checkpoint').createAs(
        b.sessionPk,
        wt.path,
        s.promptCount,
        'manual',
        'user',
      ),
    );
  });

  app.post('/checkpoints/:id/rewind', async (c) => {
    const b = await parseJson(c, CheckpointRewindBody);
    const cps = need(ctx.checkpoints, 'checkpoint');
    const cp = cps.get(c.req.param('id'));
    if (!cp) throw new ServiceError('not_found', 404, 'unknown checkpoint');
    requireConfirm(
      b.confirm,
      `Restore the files in ${cp.worktreePath} to turn ${cp.turn}. The current state is saved first as a safety checkpoint.`,
      { turn: cp.turn, createdAt: cp.createdAt },
    );
    return redactedJson(c, { safety: await cps.rewind(cp.id) });
  });

  app.get('/review/:source/:id', async (c) => {
    const source = sourceOf(c);
    return redactedJson(c, await need(ctx.review, 'review').summary(source, c.req.param('id')));
  });

  app.post('/review/:source/:id/comments', async (c) => {
    const source = sourceOf(c);
    const b = await parseJson(c, ReviewCommentsBody);
    if (b.deliver === 'session')
      requireConfirm(b.confirm, `Send ${b.comments.length} review comment(s) to the running session`);
    return redactedJson(
      c,
      await need(ctx.review, 'review').sendComments(source, c.req.param('id'), b.comments, b.deliver),
    );
  });

  return app;
}
