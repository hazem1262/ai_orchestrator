import type { LaunchRequest } from '@orc/api-contract';
import type { DaemonContext } from '../context.ts';
import { LaunchError } from './launch.ts';

export type LaunchRequestT = LaunchRequest;

const SETUP_TIMEOUT_MS = 10 * 60_000;

/** Resolves with the PTY's exit code, or `null` when it is still running after `timeoutMs`. */
export function waitForPtyExit(ctx: DaemonContext, ptyId: string, timeoutMs: number): Promise<number | null> {
  const info = ctx.pty.get(ptyId);
  if (info?.exitedAt) return Promise.resolve(info.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(null);
    }, timeoutMs);
    const off = ctx.bus.on('pty.exited', (e) => {
      if (e.ptyId !== ptyId) return;
      clearTimeout(timer);
      off();
      resolve(e.code);
    });
  });
}

/**
 * Turns the Phase 4 launch fields into a plain launch: refuses plan approval for Codex, and for a
 * `worktree` request creates the worktree, waits for its setup script and moves the cwd into it.
 * The returned request has no `worktree` field.
 */
export async function prepareLaunch(ctx: DaemonContext, req: LaunchRequestT): Promise<LaunchRequestT> {
  if (req.planApproval && req.source !== 'claude') {
    throw new LaunchError(400, 'validation_failed', 'plan approval is only supported for Claude sessions', {
      field: 'planApproval',
    });
  }
  if (!req.worktree) return req;
  if (!ctx.worktrees) throw new LaunchError(503, 'worktrees_unavailable', 'worktree service not initialised');
  const { worktree, ...rest } = req;
  const { view, setupPtyId } = await ctx.worktrees.createWith(
    {
      repo: worktree.repo,
      base: worktree.base,
      type: worktree.type,
      ticket: req.ticket ?? null,
      slug: worktree.slug,
    },
    { runSetup: true, actor: 'user' },
  );
  if (setupPtyId) {
    const code = await waitForPtyExit(ctx, setupPtyId, SETUP_TIMEOUT_MS);
    if (code !== 0) {
      ctx.log.warn(
        { code, path: view.path },
        'worktree setup script did not finish cleanly; launching anyway',
      );
    }
  }
  return { ...rest, cwd: view.path, projectId: rest.projectId ?? view.projectId };
}
