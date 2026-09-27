import { mkdirSync } from 'node:fs';
import type { OrcConfig } from '@orc/api-contract';
import type Database from 'better-sqlite3';
import pino, { type Logger } from 'pino';
import { loadConfig, type OrcPaths, saveConfig } from './config.ts';
import type { GithubConnector } from './connectors/github/github.ts';
import { type OrcDb, openDb } from './db/client.ts';
import type { InboxEngine } from './inbox/engine.ts';
import { createEventBus, type EventBus } from './live/event-bus.ts';
import type { LiveTracker } from './live/live-tracker.ts';
import type { Notifier } from './notify/notifier.ts';
import { withPtyInputAudit } from './pty/audited-pty.ts';
import { createPtyManager, type PtyManager } from './pty/pty-manager.ts';
import type { ArchiveServiceRuntime } from './services/archive/archive.ts';
import { type AuditService, createAuditService } from './services/audit/audit.ts';
import type { CheckpointService } from './services/checkpoint/checkpoint.ts';
import type { DiffService } from './services/diff/diff.ts';
import { createExternalLauncher, type ExternalLauncher } from './services/external.ts';
import type { LaunchService } from './services/launch.ts';
import { createProjectService, type ProjectServiceImpl } from './services/projects.ts';
import type { PlanApprovalService } from './services/review/plan-approval.ts';
import type { ReviewService } from './services/review/review.ts';
import { createDenyList, type DenyList } from './services/safety/deny-list.ts';
import { createScheduler, type Scheduler } from './services/scheduler/scheduler.ts';
import { createSessionService, type SessionService } from './services/sessions.ts';
import type { ShipService } from './services/ship/ship.ts';
import type { TemplateRegistry } from './services/templates.ts';
import { createUsageLedger, type UsageLedger } from './services/usage/ledger.ts';
import { createUsageMeter, type UsageMeter } from './services/usage/meter.ts';
import { createUserMetaService, type UserMetaService } from './services/user-meta.ts';
import type { WorktreeService } from './services/worktree/worktree.ts';

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
  /** P3 — the append-only audit log; always set by `buildContext()`. */
  audit: AuditService;
  /** P3 — the shared prod/destructive deny-list; always set by `buildContext()`. */
  denyList: DenyList;
  /** P2 — set by the daemon entrypoint once the tracker is started (Task 8 wires the routes). */
  live?: LiveTracker;
  /** P2 — the attention inbox (Task 9). Optional so the P1 entrypoint and tests stay valid. */
  inbox?: InboxEngine;
  /** P2 — desktop/push/Slack notifications (Task 11 implements; Task 9 only calls `notify`). */
  notifier?: Notifier;
  /** P2 — replace the config and persist it (Task 11's notification prefs route; set by `createDaemon`). */
  updateConfig?: (fn: (cfg: OrcConfig) => OrcConfig) => OrcConfig;
  /** P2 — workflow templates and task presets (Task 12; set by `startPhase2`). */
  templates?: TemplateRegistry;
  /** P2 — app-owned session launch and kill (Task 13; set by `startPhase2`). */
  launcher?: LaunchService;
  /**
   * P2 — the transcript archive (Tasks 14-15; set by `startPhase2`). The `/api/archive` routes answer
   * 503 `archive_unavailable` while it is unset.
   */
  archive?: ArchiveServiceRuntime | undefined;
  /** P4 — git worktree discovery, creation, sync and archive. */
  worktrees?: WorktreeService;
  /** P4 — per-turn commit-tree checkpoints and rewind. */
  checkpoints?: CheckpointService;
  /** P4 — base-to-worktree diffs and file or hunk revert. */
  diff?: DiffService;
  /** P4 — review summary card data and inline comments sent to owned sessions. */
  review?: ReviewService;
  /** P4 — GitHub PR status through `gh`, with the PR poller. */
  github?: GithubConnector;
  /** P4 — commit, push, PR create/merge, ship suggestions and backmerge. */
  ship?: ShipService;
  /** P4 — approve or reject a plan an owned Claude session presented through ExitPlanMode. */
  plans?: PlanApprovalService;
  /** P5 — the persisted cron and one-shot scheduler; set by `buildContext()`, started by `createDaemon().start()`. */
  scheduler?: Scheduler;
  /** P5 — the incremental per-message usage and tool ledger; set by `buildContext()`, started by `createDaemon().start()`. */
  ledger?: UsageLedger;
  /** P5 — quota snapshot, budgets, context fill and quota/budget alerts; set by `buildContext()`, started by `createDaemon().start()`. */
  usage?: UsageMeter;
  // P5 — later tasks add their own optional fields here, in the task that creates the type:
  // prs and streams (T9), analytics and digests (T10), reminders (T14).
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
  const audit = createAuditService({ db: opened.db, bus });
  const scheduler = createScheduler({ db: opened.db, log: log.child({ svc: 'scheduler' }) });
  const pty = withPtyInputAudit(createPtyManager({ bus }), audit);
  bus.on('pty.exited', () => pty.flushAll());
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
    audit,
    denyList: createDenyList({ config, projects }),
    scheduler,
  };
  const ledger = createUsageLedger(ctx);
  ctx.ledger = ledger;
  const usage = createUsageMeter(ctx, { ledger });
  ctx.usage = usage;
  return {
    ctx,
    raw: opened.raw,
    saveConfig: save,
    close: () => {
      scheduler.stop();
      usage.stop();
      ledger.stop();
      pty.disposeAll();
      opened.close();
    },
  };
}
