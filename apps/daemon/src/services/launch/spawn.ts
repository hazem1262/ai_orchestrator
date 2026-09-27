import { randomUUID } from 'node:crypto';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../errors.ts';
import { sessionPk } from '../sessions.ts';

export interface SpawnResult {
  ptyId: string;
  sessionId: string | null;
  sessionPk: string | null;
  command: string;
  args: string[];
}

function liveOwnedCount(ctx: DaemonContext): number {
  return ctx.pty.list().filter((p) => p.exitedAt === null && p.sessionPk !== null).length;
}

/** Uses P2's LaunchService.ownedCount when wired (same rule as /api/sessions/launch), else counts live owned PTYs. */
export function assertOwnedCapacity(ctx: DaemonContext, projectId: string | null, needed = 1): void {
  const cap = (projectId ? ctx.projects.get(projectId)?.maxConcurrentOwned : undefined) ?? 6;
  const used = ctx.launcher ? ctx.launcher.ownedCount(projectId) : liveOwnedCount(ctx);
  if (used + needed > cap) {
    throw new ServiceError(
      'capacity_exceeded',
      409,
      `owned session cap reached (${used} running, ${needed} requested, cap ${cap})`,
      { projectId, running: used, max: cap },
    );
  }
}

export function spawnClaudeSession(
  ctx: DaemonContext,
  i: { cwd: string; prompt: string; model?: string | null; args: readonly string[]; sessionId?: string },
): SpawnResult {
  const sessionId = i.sessionId ?? randomUUID();
  const command = ctx.config().resumeProfile.claudeCommand;
  const args = [
    ...i.args,
    ...(i.model ? ['--model', i.model] : []),
    '--session-id',
    sessionId,
    ...(i.prompt ? ['--', i.prompt] : []),
  ];
  const pk = sessionPk('claude', sessionId);
  const info = ctx.pty.spawn({ command, args, cwd: i.cwd, sessionPk: pk });
  return { ptyId: info.id, sessionId, sessionPk: pk, command, args };
}

export function spawnCodexSession(
  ctx: DaemonContext,
  i: { cwd: string; prompt: string; model?: string | null },
): SpawnResult {
  const { codexCommand, codexArgs } = ctx.config().resumeProfile;
  const args = [...codexArgs, ...(i.model ? ['-m', i.model] : []), ...(i.prompt ? ['--', i.prompt] : [])];
  const info = ctx.pty.spawn({ command: codexCommand, args, cwd: i.cwd, sessionPk: null });
  return { ptyId: info.id, sessionId: null, sessionPk: null, command: codexCommand, args };
}
