import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { LaunchRequest, OrcConfig } from '@orc/api-contract';
import type { Source } from '@orc/core';
import type { DaemonContext } from '../context.ts';
import { createLivenessChecker, type LivenessChecker, readClaudeRegistry } from '../live/liveness.ts';
import { sessionPk } from './sessions.ts';
import { composePrompt, TemplateError } from './templates.ts';

export class LaunchError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429 | 501 | 503,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'LaunchError';
  }
}

export interface LaunchResult {
  ptyId: string;
  sessionId: string | null;
}

export interface LaunchService {
  launch(req: LaunchRequest): Promise<LaunchResult>;
  kill(source: Source, id: string): Promise<{ killed: 'pty' | 'pid' }>;
  ownedCount(projectId: string | null): number;
}

const DEFAULT_MAX_OWNED = 6;
const DEFAULT_DISCOVER_TIMEOUT_MS = 8000;

/**
 * Claude Code's subcommands and their aliases, from the `Commands:` section of `claude --help` on
 * Claude Code 2.1.278. Claude parses its argv with Commander, which dispatches a subcommand even
 * when its name follows `--` (probed: `claude -- mcp` and `claude --model sonnet -- mcp` both print
 * the `claude mcp` help), so `--` cannot protect a claude prompt. A prompt whose first word is one
 * of these names is refused instead. `help` is not in the list: `claude help` starts a session
 * with "help" as the prompt.
 */
export const CLAUDE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'agents',
  'attach',
  'auth',
  'auto-mode',
  'doctor',
  'gateway',
  'import',
  'install',
  'logs',
  'mcp',
  'plugin',
  'plugins',
  'project',
  'respawn',
  'rm',
  'setup-token',
  'stop',
  'kill',
  'ultrareview',
  'update',
  'upgrade',
]);

/**
 * argv only, no shell: `[...profileArgs, ('--model', model)?, ('--')?, prompt?]`. The prompt is one
 * argv element, always the last one, and is left out entirely when it is blank.
 *
 * Codex gets `--` before the prompt. Codex parses its argv with clap, which reads everything after
 * `--` as the `[PROMPT]` positional and never as a subcommand (probed on codex-cli 0.152.1:
 * `codex completion` prints a completion script, `codex -- completion` and
 * `codex --model gpt-5.5 -- completion` start the interactive session instead). Claude gets no
 * `--`; see `CLAUDE_SUBCOMMANDS`.
 */
export function buildLaunchCommand(
  cfg: OrcConfig,
  req: { source: 'claude' | 'codex'; model?: string; prompt: string },
): { command: string; args: string[] } {
  const p = cfg.resumeProfile;
  const model = req.model ? ['--model', req.model] : [];
  const hasPrompt = req.prompt.trim() !== '';
  return req.source === 'claude'
    ? { command: p.claudeCommand, args: [...p.claudeArgs, ...model, ...(hasPrompt ? [req.prompt] : [])] }
    : { command: p.codexCommand, args: [...p.codexArgs, ...model, ...(hasPrompt ? ['--', req.prompt] : [])] };
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function createLaunchService(
  ctx: DaemonContext,
  opts: {
    discoverTimeoutMs?: number;
    killPid?: (pid: number) => void;
    liveness?: LivenessChecker;
  } = {},
): LaunchService {
  const discoverTimeoutMs = opts.discoverTimeoutMs ?? DEFAULT_DISCOVER_TIMEOUT_MS;
  const killPid = opts.killPid ?? ((pid: number) => process.kill(pid, 'SIGTERM'));
  const liveness = opts.liveness ?? createLivenessChecker();

  /**
   * The registry `procStart` of a claude session's pid, so the pre-kill check can tell the session's
   * process from a recycled pid. Codex has no registry, and the tracker's codex `startedAt` is the
   * rollout's timestamp rather than the process start, so codex degrades to the bare pid check.
   */
  const procStartOf = (source: Source, id: string, pid: number): string | null =>
    source === 'claude'
      ? (readClaudeRegistry(ctx.paths.claudeHome).find((e) => e.sessionId === id && e.pid === pid)
          ?.procStart ?? null)
      : null;

  /** Live PTYs running the configured `claude` or `codex` command whose cwd resolves to the project. */
  const ownedCount = (projectId: string | null): number => {
    const p = ctx.config().resumeProfile;
    const agents = new Set([p.claudeCommand, p.codexCommand]);
    return ctx.pty
      .list()
      .filter(
        (i) => i.exitedAt === null && agents.has(i.command) && ctx.projects.resolve(i.cwd) === projectId,
      ).length;
  };

  const renderTemplate = (req: LaunchRequest): string | null => {
    if (!req.templateId) return null;
    if (!ctx.templates)
      throw new LaunchError(503, 'templates_unavailable', 'template registry not initialised');
    try {
      return ctx.templates.render(req.templateId, {
        ...(req.ticket ? { ticket: req.ticket } : {}),
        ...req.vars,
      });
    } catch (err) {
      if (err instanceof TemplateError) {
        throw new LaunchError(
          err.status,
          err.code,
          err.message,
          err.missing.length ? { missing: err.missing } : undefined,
        );
      }
      throw err;
    }
  };

  return {
    ownedCount,

    async launch(req) {
      if (req.planApproval) {
        throw new LaunchError(501, 'not_implemented', 'plan approval is not implemented yet', {
          field: 'planApproval',
        });
      }
      if (req.worktree) {
        throw new LaunchError(501, 'not_implemented', 'worktree launch is not implemented yet', {
          field: 'worktree',
        });
      }
      if (req.compare?.length) {
        throw new LaunchError(501, 'not_implemented', 'compare mode is not implemented yet', {
          field: 'compare',
        });
      }
      if (!isAbsolute(req.cwd) || !isDir(req.cwd)) {
        throw new LaunchError(400, 'cwd_not_found', `cwd does not exist or is not a directory: ${req.cwd}`);
      }

      const prompt = composePrompt(renderTemplate(req), req.prompt);
      if (prompt.trimStart().startsWith('-')) {
        throw new LaunchError(400, 'validation_failed', 'prompt must not start with "-"');
      }
      const firstWord = prompt.trim().split(/\s+/)[0] ?? '';
      if (req.source === 'claude' && CLAUDE_SUBCOMMANDS.has(firstWord)) {
        throw new LaunchError(
          400,
          'validation_failed',
          `prompt must not start with the claude subcommand "${firstWord}"`,
        );
      }

      // The cap's limit and its count both come from the project the cwd resolves to, the same
      // way `ownedCount` groups PTYs. A request-supplied projectId only has to agree with it.
      const projectId = ctx.projects.resolve(req.cwd);
      if (req.projectId !== null && req.projectId !== projectId) {
        throw new LaunchError(
          400,
          'validation_failed',
          `projectId "${req.projectId}" does not match the project its cwd resolves to (${projectId === null ? 'none' : `"${projectId}"`})`,
        );
      }

      // The cap check and the spawn stay in one synchronous block: no await may sit between them,
      // or two concurrent launches could both pass the check.
      const max =
        (projectId ? ctx.projects.get(projectId)?.maxConcurrentOwned : undefined) ?? DEFAULT_MAX_OWNED;
      const running = ownedCount(projectId);
      if (running >= max) {
        throw new LaunchError(
          429,
          'concurrency_limit',
          `project ${projectId ?? '(none)'} already runs ${running} app-owned sessions`,
          { projectId, max, running },
        );
      }
      const { command, args } = buildLaunchCommand(ctx.config(), {
        source: req.source,
        model: req.model,
        prompt,
      });
      const info = ctx.pty.spawn({ command, args, cwd: req.cwd, sessionPk: null });
      ctx.log.info(
        { ptyId: info.id, source: req.source, projectId, templateId: req.templateId ?? null },
        'session launched',
      );

      // Codex only knows its rollout id after the first write, so there is nothing to wait for.
      const sessionId =
        req.source === 'claude' && ctx.live ? await ctx.live.waitForPid(info.pid, discoverTimeoutMs) : null;
      return { ptyId: info.id, sessionId };
    },

    async kill(source, id) {
      const live = ctx.live?.get(sessionPk(source, id))?.live;
      if (!live || live.status === 'ended') {
        throw new LaunchError(404, 'not_live', `session ${source}:${id} is not running`);
      }
      if (live.ownership === 'owned' && live.ptyId) {
        ctx.pty.kill(live.ptyId, 'SIGTERM');
        return { killed: 'pty' };
      }
      // The pid comes from the tracker, never from the request. The tracker's last pass may be
      // seconds old, so the pid is checked again right before the signal: a recycled pid must not
      // be killed.
      const pid = live.pid;
      if (pid === null) throw new LaunchError(404, 'not_live', 'no pid known for this session');
      if (!(await liveness.isAlive(pid, procStartOf(source, id, pid)))) {
        throw new LaunchError(404, 'not_live', `session ${source}:${id} is not running`);
      }
      try {
        killPid(pid);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          throw new LaunchError(404, 'not_live', `session ${source}:${id} is not running`);
        }
        throw err;
      }
      return { killed: 'pid' };
    },
  };
}
