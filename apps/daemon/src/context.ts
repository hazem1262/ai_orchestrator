import { mkdirSync } from 'node:fs';
import type { OrcConfig } from '@orc/api-contract';
import type Database from 'better-sqlite3';
import pino, { type Logger } from 'pino';
import { loadConfig, type OrcPaths, saveConfig } from './config.ts';
import { type OrcDb, openDb } from './db/client.ts';
import type { InboxEngine } from './inbox/engine.ts';
import { createEventBus, type EventBus } from './live/event-bus.ts';
import type { LiveTracker } from './live/live-tracker.ts';
import type { Notifier } from './notify/notifier.ts';
import { createPtyManager, type PtyManager } from './pty/pty-manager.ts';
import { createExternalLauncher, type ExternalLauncher } from './services/external.ts';
import type { LaunchService } from './services/launch.ts';
import { createProjectService, type ProjectServiceImpl } from './services/projects.ts';
import { createSessionService, type SessionService } from './services/sessions.ts';
import type { TemplateRegistry } from './services/templates.ts';
import { createUserMetaService, type UserMetaService } from './services/user-meta.ts';

/** contracts §11 — Phase 1 fields. Later phases add optional services. */
export interface DaemonContext {
  paths: OrcPaths;
  config: () => OrcConfig;
  db: OrcDb;
  bus: EventBus;
  log: Logger;
  pty: PtyManager;
  sessions: SessionService;
  projects: ProjectServiceImpl;
  userMeta: UserMetaService;
  /** P2 — set by the daemon entrypoint once the tracker is started (Task 8 wires the routes). */
  live?: LiveTracker;
  /** P2 — the attention inbox (Task 9). Optional so the P1 entrypoint and tests stay valid. */
  inbox?: InboxEngine;
  /** P2 — desktop/push/Slack notifications (Task 11 implements; Task 9 only calls `notify`). */
  notifier?: Notifier;
  /** P2 — replace the config and persist it (Task 11's notification prefs route; Task 16 wires it). */
  updateConfig?: (fn: (cfg: OrcConfig) => OrcConfig) => OrcConfig;
  /** P2 — workflow templates and task presets (Task 12; Task 16 wires it). */
  templates?: TemplateRegistry;
  /** P2 — app-owned session launch and kill (Task 13; Task 16 wires it). */
  launcher?: LaunchService;
}

export interface BuildContextOptions {
  paths: OrcPaths;
  log?: Logger;
  launchExternal?: ExternalLauncher;
  isPidAlive?: (pid: number) => boolean;
}

export function buildContext(o: BuildContextOptions): {
  ctx: DaemonContext;
  raw: Database.Database;
  saveConfig(cfg: OrcConfig): void;
  close(): void;
} {
  mkdirSync(o.paths.orcHome, { recursive: true, mode: 0o700 });
  const opened = openDb(o.paths.dbFile);
  let cfg = loadConfig(o.paths);
  const config = () => cfg;
  const save = (next: OrcConfig): void => {
    saveConfig(o.paths, next);
    cfg = next;
  };
  const log =
    o.log ??
    pino(
      { level: process.env.ORC_LOG_LEVEL ?? 'info' },
      pino.destination({ dest: o.paths.logFile, mkdir: true, sync: false }),
    );
  const bus = createEventBus({ onError: (err, e) => log.error({ err, type: e.type }, 'bus handler failed') });
  const pty = createPtyManager({ bus });
  const projects = createProjectService({ db: opened.db, paths: o.paths, config, saveConfig: save });
  const sessions = createSessionService({
    db: opened.db,
    paths: o.paths,
    config,
    bus,
    pty,
    projects,
    launchExternal: o.launchExternal ?? createExternalLauncher(),
    isPidAlive: o.isPidAlive,
  });
  const userMeta = createUserMetaService(opened.db);
  const ctx: DaemonContext = {
    paths: o.paths,
    config,
    db: opened.db,
    bus,
    log,
    pty,
    sessions,
    projects,
    userMeta,
  };
  return {
    ctx,
    raw: opened.raw,
    saveConfig: save,
    close: () => {
      pty.disposeAll();
      opened.close();
    },
  };
}
