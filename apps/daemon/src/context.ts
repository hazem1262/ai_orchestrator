import { mkdirSync } from 'node:fs';
import type { OrcConfig } from '@orc/api-contract';
import type Database from 'better-sqlite3';
import pino, { type Logger } from 'pino';
import { loadConfig, type OrcPaths, saveConfig } from './config.ts';
import type { AgncConnector } from './connectors/agnc/agnc.ts';
import type { GithubConnector } from './connectors/github/github.ts';
import type { LinearConnector } from './connectors/linear/linear.ts';
import type { SlackConnector } from './connectors/slack/slack.ts';
import { type OrcDb, openDb } from './db/client.ts';
import type { InboxEngine } from './inbox/engine.ts';
import { createEventBus, type EventBus } from './live/event-bus.ts';
import type { LiveTracker } from './live/live-tracker.ts';
import type { Notifier } from './notify/notifier.ts';
import type { VapidKeys } from './notify/vapid.ts';
import type { WebPushChannel } from './notify/webpush.ts';
import { withPtyInputAudit } from './pty/audited-pty.ts';
import { createPtyManager, type PtyManager } from './pty/pty-manager.ts';
import type { AwayService } from './remote/away.ts';
import type { DeviceService } from './remote/devices.ts';
import type { PairingService } from './remote/pairing.ts';
import type { StepUpStore } from './remote/step-up.ts';
import type { FunnelWatch } from './remote/tailscale.ts';
import type { WebAuthnService } from './remote/webauthn.ts';
import { type AnalyticsService, createAnalyticsService } from './services/analytics/analytics.ts';
import { createDigestService, type DigestService } from './services/analytics/digest.ts';
import type { ArchiveServiceRuntime } from './services/archive/archive.ts';
import { type AuditService, createAuditService } from './services/audit/audit.ts';
import type { AutomationServiceImpl } from './services/automations/service.ts';
import type { SuggestionService } from './services/automations/suggestions.ts';
import type { CheckpointService } from './services/checkpoint/checkpoint.ts';
import type { CompareService } from './services/compare/compare.ts';
import type { DiffService } from './services/diff/diff.ts';
import { createExternalLauncher, type ExternalLauncher } from './services/external.ts';
import { createGoalService, type GoalService } from './services/goals/goals.ts';
import { createHandoffService, type HandoffService } from './services/handoff/handoff.ts';
import type { LaunchService } from './services/launch.ts';
import { createPrSource, type PrSource } from './services/pr-source.ts';
import { createProjectService, type ProjectServiceImpl } from './services/projects.ts';
import { createRecapService, defaultRecapEngines, type RecapService } from './services/recap/recap.ts';
import { createReminderService, type ReminderService } from './services/reminders/reminders.ts';
import type { SessionActions } from './services/remote/session-actions.ts';
import type { PlanApprovalService } from './services/review/plan-approval.ts';
import type { ReviewService } from './services/review/review.ts';
import { createDenyList, type DenyList } from './services/safety/deny-list.ts';
import { createScheduler, type Scheduler } from './services/scheduler/scheduler.ts';
import type { SecretStore } from './services/secrets/secret-store.ts';
import { createSessionService, type SessionService } from './services/sessions.ts';
import type { ShareService } from './services/share/share.ts';
import type { ShipService } from './services/ship/ship.ts';
import { createStreamService, type StreamService } from './services/streams/streams.ts';
import type { SupervisorImpl } from './services/supervisor/supervisor.ts';
import type { TemplateRegistry } from './services/templates.ts';
import { createUsageLedger, type UsageLedger } from './services/usage/ledger.ts';
import { createUsageMeter, type UsageMeter } from './services/usage/meter.ts';
import { createUserMetaService, type UserMetaService } from './services/user-meta.ts';
import type { WorktreeService } from './services/worktree/worktree.ts';

/** P6 — the remote-access services the remote, WebAuthn and push routes read per request. */
export interface RemoteAccess {
  devices: DeviceService;
  pairing: PairingService;
  stepUp: StepUpStore;
  funnel: FunnelWatch;
  webauthn: WebAuthnService;
  vapid: VapidKeys;
  webpush: WebPushChannel;
}

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
  /** P5 — PR rows for work streams, read from the P4 `pr_cache`; set by `buildContext()`. */
  prs?: PrSource;
  /** P5 — ticket-keyed work streams; set by `buildContext()`, started by `createDaemon().start()`. */
  streams?: StreamService;
  /** P5 — cost, tool, timing, outcome and wstack aggregations over the ledger; set by `buildContext()`. */
  analytics?: AnalyticsService;
  /** P5 — the weekly markdown digest and its scheduled job; set by `buildContext()`, started by `createDaemon().start()`. */
  digests?: DigestService;
  /** P5 — LLM session and daily recaps with a cache and a monthly budget; set by `buildContext()`, started by `createDaemon().start()`. */
  recaps?: RecapService;
  /** P5 — session and stream goals with the merge and waiting rules; set by `buildContext()`, started by `createDaemon().start()`. */
  goals?: GoalService;
  /** P5 — persisted one-shot reminders on the scheduler; set by `buildContext()`, started by `createDaemon().start()`. */
  reminders?: ReminderService;
  /** P5 — handoffs (structured evidence plus an LLM summary), markdown export and resume-fresh; set by `buildContext()`. */
  handoffs?: HandoffService;
  /** P6 — Linear/Slack tokens and OAuth client secrets in the macOS Keychain. */
  secrets?: SecretStore;
  /** P6 — redact → confirm → audit posts to Linear and Slack. */
  share?: ShareService;
  /** P6 — reply and approve for owned sessions from the PWA or the Slack DM bridge. */
  sessionActions?: SessionActions;
  /** P6 — away mode (manual toggle and macOS idle) that routes notifications to the phone. */
  away?: AwayService;
  /** P6 — Linear, acting as the user. */
  linear?: LinearConnector;
  /** P6 — Slack, acting as the user through a user token. */
  slack?: SlackConnector;
  /** P6 — paired devices, pairing codes, step-up grants, the Funnel watch, passkeys and web push; set by `createPhase6`. */
  remoteAccess?: RemoteAccess;
  /** P7 — scheduled and event-triggered automations (implements contracts §11 `AutomationService`); set by `createPhase7`. */
  automations?: AutomationServiceImpl;
  /** P7 — automation suggestions (Jules-style suggested tasks). */
  suggestions?: SuggestionService;
  /** P7 — compare mode across agents. */
  compare?: CompareService;
  /** P7 — the supervisor that answers routine questions from owned sessions (a superset of contracts §11 `Supervisor`); set by `createPhase7`. */
  supervisor?: SupervisorImpl;
  /** P7 — optional AGNC sessions. */
  agnc?: AgncConnector;
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
  const prs = createPrSource(ctx);
  ctx.prs = prs;
  const streams = createStreamService(ctx, { prs, meter: usage });
  ctx.streams = streams;
  const analytics = createAnalyticsService(ctx, { ledger, prs });
  ctx.analytics = analytics;
  const digests = createDigestService(ctx, { analytics, prs, meter: usage, scheduler });
  ctx.digests = digests;
  const recaps = createRecapService(ctx, { engines: defaultRecapEngines(ctx), scheduler });
  ctx.recaps = recaps;
  ctx.handoffs = createHandoffService(ctx, { recaps });
  const goals = createGoalService(ctx);
  ctx.goals = goals;
  ctx.reminders = createReminderService(ctx, { scheduler });
  return {
    ctx,
    raw: opened.raw,
    saveConfig: save,
    close: () => {
      scheduler.stop();
      goals.stop();
      recaps.stop();
      digests.stop();
      streams.stop();
      usage.stop();
      ledger.stop();
      pty.disposeAll();
      opened.close();
    },
  };
}
