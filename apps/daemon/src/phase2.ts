import { join } from 'node:path';
import { createCodexLiveDetector } from './collectors/codex/live.ts';
import type { DaemonContext } from './context.ts';
import { createLiveWsHub, type LiveWsHub } from './http/live-ws.ts';
import { createInboxEngine } from './inbox/engine.ts';
import { registerDefaultRules, STATUS_KIND } from './inbox/rules/status-rules.ts';
import { createLiveTracker } from './live/live-tracker.ts';
import { createLivenessChecker } from './live/liveness.ts';
import { createRegistryWatcher } from './live/registry-watcher.ts';
import { createMacosChannel } from './notify/macos.ts';
import { createNotifier, type NotifyChannelImpl } from './notify/notifier.ts';
import { createArchiveService } from './services/archive/archive.ts';
import { createLaunchService } from './services/launch.ts';
import { sessionPk } from './services/sessions.ts';
import { createTemplateRegistry } from './services/templates.ts';

export interface Phase2Handle {
  hub: LiveWsHub;
  stop(): Promise<void>;
}

export interface Phase2Options {
  /** The daemon token; the `/ws` hub checks it exactly as the PTY socket does. */
  token: string;
  /** The allow-listed browser origins, read per upgrade because the port is bound after this runs. */
  origins: () => string[];
  notifyChannels?: NotifyChannelImpl[];
  archiveIntervalMs?: number;
}

/**
 * Creates and starts every phase 2 service and sets it on `ctx`. The routes themselves are
 * registered by `registerAllRoutes` in `http/app.ts` — the one registration path the route census
 * sees — and read these services off `ctx` per request.
 *
 * `ORC_NOTIFY=off` registers no notification channel; the tests and the e2e run set it.
 */
export async function startPhase2(ctx: DaemonContext, opts: Phase2Options): Promise<Phase2Handle> {
  const notifier = createNotifier({ config: ctx.config, log: ctx.log });
  const channels = opts.notifyChannels ?? (process.env.ORC_NOTIFY === 'off' ? [] : [createMacosChannel()]);
  for (const ch of channels) notifier.register(ch);
  ctx.notifier = notifier;

  const inbox = createInboxEngine(ctx);
  ctx.inbox = inbox;
  registerDefaultRules(inbox);
  inbox.start();

  ctx.templates = createTemplateRegistry();

  const archive = createArchiveService(ctx);
  ctx.archive = archive;

  // Warn only: the checker's verdict is unchanged. Without this the guard against a registry
  // `procStart` format change silently emptying the board reports to nobody.
  const liveness = createLivenessChecker({
    onSuspectedFormatChange: (info) =>
      ctx.log.warn(info, 'registry procStart disagrees with ps by a whole UTC offset; format change?'),
  });
  const live = createLiveTracker(ctx, {
    registry: createRegistryWatcher({ dir: join(ctx.paths.claudeHome, 'sessions'), log: ctx.log }),
    liveness,
    codex: createCodexLiveDetector({ codexHome: ctx.paths.codexHome, log: ctx.log }),
  });
  ctx.live = live;
  ctx.launcher = createLaunchService(ctx, { liveness });

  const hub = createLiveWsHub(ctx, { token: opts.token, origins: opts.origins });

  await live.start();
  // The tracker's first pass announces no status changes, so a session that became waiting,
  // review or error while the daemon was down would otherwise never get an inbox item.
  for (const s of live.list()) {
    const status = s.live?.status;
    if (status && STATUS_KIND[status])
      ctx.bus.emit({ type: 'session.statusChanged', pk: sessionPk(s.source, s.id), from: null, to: status });
  }
  archive.start(opts.archiveIntervalMs);

  return {
    hub,
    async stop() {
      const archiveStopped = archive.stop();
      inbox.stop();
      await live.stop();
      await hub.close();
      await archiveStopped;
    },
  };
}
