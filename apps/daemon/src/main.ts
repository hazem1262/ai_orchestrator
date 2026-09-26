import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { OrcConfig } from '@orc/api-contract';
import type { Logger } from 'pino';
import { ensureToken, type OrcPaths, resolvePaths } from './config.ts';
import { createGithubConnector } from './connectors/github/github.ts';
import { buildContext, type DaemonContext } from './context.ts';
import { createApp } from './http/app.ts';
import { allowedOrigins } from './http/auth.ts';
import { attachPtyWebSocket } from './http/ws.ts';
import { createPlanApprovalRule } from './inbox/rules/plan-approval.ts';
import { prEventRule } from './inbox/rules/pr-event.ts';
import { createIndexer, type Indexer } from './indexer/indexer.ts';
import { startPhase2 } from './phase2.ts';
import { warnIfChildSessionEnv } from './pty/pty-manager.ts';
import { createCheckpointService } from './services/checkpoint/checkpoint.ts';
import { registerCheckpointHook } from './services/checkpoint/turn-hook.ts';
import { createDiffService } from './services/diff/diff.ts';
import type { ExternalLauncher } from './services/external.ts';
import { createPlanApprovalService } from './services/review/plan-approval.ts';
import { createReviewService } from './services/review/review.ts';
import { createShipService } from './services/ship/ship.ts';
import { registerAutoArchive } from './services/worktree/auto-archive.ts';
import { createWorktreeService } from './services/worktree/worktree.ts';

export const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

const DISCOVER_EVERY_MS = 5 * 60_000;

/**
 * Creates the phase 4 services on `ctx`, registers the PR-event and plan-approval inbox rules, the
 * per-turn checkpoint hook and PR-merge auto-archive, and (unless `startPollers: false`) starts
 * worktree discovery and — only when `config.github.enabled` — the GitHub PR poller. The routes
 * are registered by `registerAllRoutes`; they read these services off `ctx` per request.
 *
 * Needs `ctx.audit` (always set) and, for the inbox rules, `ctx.inbox` from `startPhase2`. The
 * rules are registered here rather than in `registerDefaultRules`, which stays the P2 corpus.
 */
export function wirePhase4(ctx: DaemonContext, opts: { startPollers?: boolean } = {}): () => void {
  ctx.worktrees = createWorktreeService(ctx);
  ctx.checkpoints = createCheckpointService(ctx);
  ctx.diff = createDiffService(ctx);
  ctx.review = createReviewService(ctx);
  const github = createGithubConnector(ctx);
  ctx.github = github;
  ctx.ship = createShipService(ctx);
  ctx.plans = createPlanApprovalService(ctx);
  ctx.inbox?.registerRule(prEventRule);
  ctx.inbox?.registerRule(createPlanApprovalRule());
  const stops: Array<() => void> = [registerCheckpointHook(ctx), registerAutoArchive(ctx)];
  if (opts.startPollers ?? true) {
    if (ctx.config().github.enabled) stops.push(github.start());
    const worktrees = ctx.worktrees;
    const discover = () => {
      worktrees.discover().catch((err: unknown) => ctx.log.warn({ err }, 'worktree discovery failed'));
    };
    discover();
    const timer = setInterval(discover, DISCOVER_EVERY_MS);
    timer.unref();
    stops.push(() => clearInterval(timer));
  }
  return () => {
    for (const stop of stops.splice(0)) stop();
  };
}

export interface Daemon {
  ctx: DaemonContext;
  indexer: Indexer;
  token: string;
  start(o: { port: number; watch?: boolean }): Promise<{ port: number; close(): Promise<void> }>;
}

export async function createDaemon(
  o: { paths?: OrcPaths; log?: Logger; launchExternal?: ExternalLauncher; webDist?: string | null } = {},
): Promise<Daemon> {
  const paths = o.paths ?? resolvePaths();
  const built = buildContext({ paths, log: o.log, launchExternal: o.launchExternal });
  const { ctx } = built;
  const token = ensureToken(paths);
  ctx.updateConfig = (fn) => {
    const next = OrcConfig.parse(fn(ctx.config()));
    built.saveConfig(next);
    return next;
  };
  const indexer = createIndexer({
    db: ctx.db,
    raw: built.raw,
    paths,
    projects: ctx.projects,
    bus: ctx.bus,
    log: ctx.log,
  });
  const webDist =
    o.webDist === undefined ? (existsSync(DEFAULT_WEB_DIST) ? DEFAULT_WEB_DIST : null) : o.webDist;

  return {
    ctx,
    indexer,
    token,
    async start({ port, watch = true }) {
      let boundPort = port;
      const origins = () => allowedOrigins(boundPort);
      const phase2 = await startPhase2(ctx, { token, origins });
      const stopPhase4 = wirePhase4(ctx);
      const app = createApp({ ctx, token, port: () => boundPort, webDist });
      const server = await new Promise<Server>((resolve) => {
        const s = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info: AddressInfo) => {
          boundPort = info.port;
          resolve(s as Server);
        });
      });
      const sockets = attachPtyWebSocket(server, { ctx, token, origins, liveHub: phase2.hub });
      ctx.log.info({ port: boundPort }, 'daemon listening');
      const scan = indexer
        .scanAll()
        .then(async (stats) => {
          ctx.log.info(stats, 'initial index complete');
          if (watch) await indexer.watch();
        })
        .catch((err: unknown) => ctx.log.error({ err }, 'initial index failed'));
      return {
        port: boundPort,
        close: async () => {
          await scan;
          stopPhase4();
          await phase2.stop();
          await indexer.close();
          await sockets.close();
          await new Promise<void>((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          });
          built.close();
        },
      };
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  warnIfChildSessionEnv();
  const daemon = await createDaemon();
  const port = Number(process.env.ORC_PORT ?? daemon.ctx.config().port);
  const running = await daemon.start({ port });
  console.log(`orchestrator daemon on http://127.0.0.1:${running.port}`);
  const shutdown = () => {
    running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
