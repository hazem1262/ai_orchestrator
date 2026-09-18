# Phase 2 — Live Board, Attention Inbox, Launch & Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Symbol ownership:** before creating any exported symbol, check `00-contracts.md` §13. Where two phases touch the same symbol, the owning phase creates the file and later phases modify it instead of redefining.

**Goal:** Show every running Claude and Codex session live, with derived states. Put everything that needs the user into a persisted Attention Inbox with macOS notifications. Launch new sessions from workflow templates and task presets. Archive transcripts so nothing is lost to Claude's 30-day cleanup (M2).

**Architecture:** Pure derivations live in `@orc/core`: the registry parser, test-output parser, stage inference, live transcript reducer and status derivation. The daemon adds five pieces:
- a `LiveTracker`, which combines the registry watcher, pid liveness, Codex process detection, transcript tails and PTY ownership, and emits bus events
- an `InboxEngine` with rules and a `Notifier`
- a `TemplateRegistry` and `LaunchService`
- an `ArchiveService`
- routes plus a `/ws` hub

The web app gets a WS-driven cache (`useLiveEvents`), the Live Board, the Inbox, the Launch dialog and Settings sections.

**Tech Stack:** Node 22, TypeScript ~6.0.3, Hono 4, ws 8, better-sqlite3 + Drizzle, chokidar 5, execa 10, node-notifier 10, node-pty 1.1, `node:zlib` (zstd with gzip fallback), React 19, TanStack Query/Router, zustand, Vitest 5, Testing Library, Playwright.

**Spec:** `docs/02-features.md` (F1, F4 "Launch a new session", F5, F15), `docs/03-architecture-and-stack.md` (Key flows 1, 4, 5; Security; Performance targets), `docs/04-data-sources.md` (A1, A2, A4, B1, B2), `docs/05-roadmap.md` (M2), `docs/06-landscape-and-inspiration.md` (zadloop stage bar/test chip/presets, DeepSeek Harness jobs badge/open-in), `plan/00-contracts.md` (§3, §4, §5, §6, §7, §11, §12)

## Global Constraints
- **Toolchain:** Node `>=22.12 <23`, pnpm `10.18.3`, TypeScript `~6.0.3` strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Vitest 5, Biome 2. All versions are listed in contracts §1.
- **Local only:** the daemon binds to `127.0.0.1`. Every API/WS request needs `x-orc-token` (WS may use `?token=`). WS upgrades must pass the Origin check.
- **Read-only toward tool data:** never write to `~/.claude` or `~/.codex`. The only exception in this phase is the **confirmed archive restore**, which never overwrites an existing file. Never read `*.key`, `~/.codex/auth.json`, or auth fields in `~/.claude.json`. Claude's `messagingSocketPath` is never used.
- **Write actions** (launch, kill, restore, PTY input) need a confirmation where the contract says so (`{"confirm": true}` → otherwise `409 confirmation_required` with `details.summary`). The audit log arrives in Phase 3; Phase 3 wraps these paths with `audit.record()`.
- **Input to sessions:** only to **owned** sessions (spawned by the app's PTY).
- **Redaction:** transcript text leaves the daemon only after `redact()`. In this phase that covers `lastPrompt`, `reason` strings built from transcript text, and `waitingFor`.
- `@orc/core` must not import `node:fs`, `node:net` or `node:child_process` anywhere except `src/io/*`.
- **Defaults (decided):** resume/launch flags `--dangerously-skip-permissions`, default project `wakecap`, Codex automated sessions hidden.
- **Fixtures** are made up and redacted, and `pnpm check:fixtures` must pass. Tests set `ORC_HOME`, `CLAUDE_HOME` and `CODEX_HOME` to temp copies. Writes to a temp `CLAUDE_HOME` by the fake `claude` binary are allowed.
- **Commits:** Conventional Commits with a scope. Run `pnpm lint && pnpm typecheck && pnpm test` before every commit.
- **Branch:** `phase/2-live-board-inbox-archive`.

---

## Phase-1 interfaces this plan assumes

These come from `plan/00-contracts.md` §11 or from Phase 1. Where the contract doesn't spell out a signature, this plan assumes the one below. **Task 1 Step 1 verifies each one.** If Phase 1 differs, adapt the call site in the consuming task and write the difference in the task's review note. Never rename a contract name.

| Item | Assumed signature / behaviour |
|---|---|
| `apps/daemon/src/context.ts` | `DaemonContext` exactly as contracts §11. Fields are mutable, so `ctx.inbox = engine` is allowed. |
| `apps/daemon/src/db/client.ts` | `openDb(file: string): { db: OrcDb; raw: Database.Database; close(): void }` runs migrations. |
| `apps/daemon/src/db/schema.ts` | Drizzle `sqliteTable` definitions. `pnpm --filter @orc/daemon db:generate` writes migrations to `src/db/migrations/`. |
| `apps/daemon/src/services/sessions.ts` | `SessionService` (contracts §11). `setLive(pk, live)` stores the live state for an **indexed** session and emits `session.updated`. For an unknown pk it is a no-op. `getByPk` returns the session with its stored `live`. Availability is computed in one place (the "availability expression" that Task 15 edits). |
| `apps/daemon/src/services/projects.ts` | `ProjectService` (contracts §11). |
| `apps/daemon/src/pty/pty-manager.ts` | `PtyManager` (contracts §7). `spawn` merges `process.env` with `opts.env` and emits `pty.exited` on the bus. |
| `apps/daemon/src/live/event-bus.ts` | `createEventBus()` / `EventBus` / `BusEvent` (contracts §6). |
| `apps/daemon/src/http/app.ts` | `createApp(ctx: DaemonContext): Hono`. It applies token auth to `/api/*` and calls `register<Area>Routes(app, ctx)` for each route module. |
| `apps/daemon/src/http/ws.ts` | `attachWebSockets(server: import('node:http').Server, ctx: DaemonContext): void`. It installs one `upgrade` listener, checks token and Origin with `authorizeUpgrade(req: IncomingMessage, ctx: DaemonContext): boolean`, and routes `/pty/:ptyId`. |
| `apps/daemon/src/main.ts` | `createDaemon(opts?: { port?: number }): Promise<{ ctx: DaemonContext; port: number; close(): Promise<void> }>`. Paths come from `resolvePaths(process.env)`. It writes `paths.tokenFile`. |
| `apps/daemon/src/config.ts` | `resolvePaths`, `loadConfig`, `saveConfig` (contracts §3). |
| `apps/daemon/test/helpers.ts` | `useTempHomes(): () => OrcPaths`, called at `describe` level. It registers `beforeEach`/`afterEach` hooks that copy `fixtures/` into a fresh temp dir, set `ORC_HOME`/`CLAUDE_HOME`/`CODEX_HOME`, and restore the env afterwards. `createTestContext(overrides?: Partial<DaemonContext>): DaemonContext` resolves paths from the current env, opens a migrated db, and builds a real bus, a silent logger, `loadConfig`, real `ProjectService`/`SessionService` (the fixtures indexed once) and a real `createPtyManager`. |
| `packages/api-contract/src/client.ts` | `createApiClient({ baseUrl, token }): ApiClient`, which returns a plain object of methods. `export type ApiClient = ReturnType<typeof createApiClient>`. |
| `apps/web/src/api/client.ts` | `getApiClient(): ApiClient` and `setApiClientForTests(c: ApiClient): void`. |
| `apps/web/src/features/shell/AppShell.tsx` | `export function AppShell({ children }: { children: ReactNode })` renders the top bar (`<header>`), the left nav (`<nav>`) and the terminal dock. |
| `apps/web/src/features/settings/SettingsPage.tsx` | `export function SettingsPage()` renders `<section>` blocks, and `routes/settings.tsx` renders it. |
| `apps/web/src/stores/project.ts` / `stores/terminals.ts` | `useProjectStore`, `useTerminalStore` (contracts §12). |
| `apps/web/playwright.config.ts` | Exists, with `testDir: './e2e'`. |
| `@/components/ui` | Its index re-exports `Button` (`variant?: 'default' \| 'outline' \| 'secondary' \| 'destructive' \| 'ghost'`, `size?: 'sm' \| 'default'`) and `Badge` (`variant?: 'default' \| 'secondary' \| 'destructive' \| 'outline'`). Everything else in this phase uses native elements, so the UI kit choice from S6 doesn't matter. |

**Spike decisions:** before Task 5, read `plan/spikes/S3.md` and `plan/spikes/S5.md`.
- **S3:** if it says the hook bridge is required for <2 s, the hook-ingest steps in Task 8 are **mandatory**. Otherwise they still ship (they are small), but the user installs the hook by hand, and nothing in the exit criteria depends on it.
- **S5:** if it chose "also read `state_5.sqlite`", keep the rollout-mtime heuristic from Task 6 as the fallback, and write the difference in the review note.

---

## Contract additions

These are merged into `plan/00-contracts.md` in Task 20.

**§3 config (`packages/api-contract/src/config.ts`)**, new field on `OrcConfig`:
```ts
live: z.object({ pollMs: z.number().int().positive().default(1000), endedRetentionMin: z.number().int().positive().default(10), codexBusyWindowMs: z.number().int().positive().default(10000) }).default({ pollMs: 1000, endedRetentionMin: 10, codexBusyWindowMs: 10000 }),
```

Env: `ORC_NOTIFY=off` disables every notification channel (tests, e2e).

**§4 core additions (`@orc/core`)**
```ts
// claude/registry.ts
export type RegistryStatus = 'busy' | 'idle' | 'waiting' | 'shell';
export interface RegistryEntry { pid: number; procStart: string | null; sessionId: string; cwd: string; startedAt: number | null; version: string | null; kind: string | null; name: string | null; status: RegistryStatus | null; waitingFor: string | null; statusUpdatedAt: number | null; updatedAt: number | null }
export function parseRegistryEntry(value: unknown): RegistryEntry | null;   // never copies messagingSocketPath
export function isRegistryFileName(name: string): boolean;                  // /^\d+\.json$/ — never matches *.key
// derive/tests.ts
export function isTestCommand(command: string): boolean;
export function parseTestOutput(command: string, output: string, ts: string): TestResult | null;
// derive/stage.ts
export type ToolCategory = 'read' | 'edit' | 'test' | 'other';
export function categorizeTool(tool: string, input: unknown): ToolCategory;
export function inferStage(s: { categories: ToolCategory[]; turnEnded: boolean; changedFiles: number }): Stage | null;
// derive/live-transcript.ts
export interface TranscriptLive { turn: number; lastPrompt: string | null; currentTool: string | null; stage: Stage | null; backgroundJobs: number; runningSubagents: number; contextFill: number | null; lastTest: TestResult | null; turnEnded: boolean; turnChangedFiles: string[]; turnPrs: number; lastApiError: string | null; permissionMode: string | null; lastActivityAt: string | null }
export interface LiveReducerEffects { testRecorded: TestResult | null; turnEnded: number | null }
export interface LiveReducer { apply(value: unknown): LiveReducerEffects; snapshot(): TranscriptLive }
export function emptyTranscriptLive(): TranscriptLive;
export function createLiveReducer(opts?: { contextWindow?: number }): LiveReducer;
// derive/live-status.ts
export interface DeriveStatusInput { alive: boolean; registryStatus: RegistryStatus | null; transcript: TranscriptLive }
export function deriveLiveStatus(i: DeriveStatusInput): LiveStatus;
export function splitPk(pk: string): { source: Source; id: string };
```

**§5 tables (owned by Phase 2)**
| Table | Columns |
|---|---|
| `inbox_items` | `id` text pk, `kind`, `session_id`, `project_id`, `ticket`, `reason`, `dedupe_key`, `created_at`, `updated_at`, `state`, `snooze_until`, `payload_json` (default `'{}'`). Unique index `inbox_items_active_dedupe` on `dedupe_key` `WHERE state in ('open','snoozed')`. Index `inbox_items_state_idx` (`state`, `updated_at`). |
| `test_results` | `session_pk`, `ts`, `command`, `passed`, `failed`, `skipped`, `duration_ms`. PK (`session_pk`, `ts`). No FK, because live sessions may not be indexed yet. |
| `archive_entries` | `path` text pk (source transcript path), `session_pk`, `agent_id`, `project_id`, `archive_path`, `codec` (`'zstd'\|'gzip'`), `source_size`, `source_mtime_ms`, `bytes`, `archived_at`. Index on `session_pk`. |

Repos: `db/repos/inbox.ts`, `db/repos/test-results.ts`, `db/repos/archive.ts` (signatures in Task 1).

**§6 routes (Phase 2, final list)**
```
P2  GET    /api/live                                   → Session[] (live != null)
P2  POST   /api/sessions/launch                        body LaunchRequest → { ptyId, sessionId | null }   errors: 400 validation_failed|cwd_not_found|template_var_missing, 404 template_not_found, 429 concurrency_limit, 501 not_implemented
P2  POST   /api/sessions/:source/:id/kill              body { confirm?: boolean } → { killed: 'pty' | 'pid' }   409 confirmation_required, 404 not_live
P2  POST   /api/sessions/:source/:id/open-in           body { app: 'vscode'|'terminal'|'finder'; remember?: boolean } → { ok: true }
P2  GET    /api/inbox?state=open,snoozed&kind=a,b&projectId → InboxItem[]
P2  POST   /api/inbox/:id/done | /snooze | /reopen     body { until?: string } → InboxItem   (snooze requires a future ISO `until`)
P2  GET    /api/templates?projectId                    → Template[]
P2  GET    /api/archive/status                         → ArchiveStatus
P2  POST   /api/archive/restore                        body { source, id, confirm? } → { restored: string[] }   409 confirmation_required|restore_target_exists, 404 not_archived, 400 unsupported_source
P2  POST   /api/archive/sync                           → { copied: number }
P2  GET    /api/config/notifications                   → NotificationPrefs
P2  PUT    /api/config/notifications                   body NotificationPrefs → NotificationPrefs
P2  POST   /api/hooks                                  body HookIngestBody → { ok: true }   (minimal ingest; the full bridge is P5)
P2  WS     /ws                                         hello, then LiveEvent deltas
```
The zod schemas live in `packages/api-contract/src/routes/{live,launch,inbox,templates,archive,notifications,hooks}.ts` (Task 2). `export type LaunchRequest = z.infer<typeof LaunchRequest>`. `ArchiveStatus = z.object({ enabled, files, bytes, oldestTranscript, cleanupPeriodDays, codec, recommendedSnippet })`.

New client methods: `liveList`, `sessionsLaunch`, `sessionsKill`, `sessionsOpenIn`, `inboxList`, `inboxDone`, `inboxSnooze`, `inboxReopen`, `templatesList`, `archiveStatus`, `archiveRestore`, `archiveSync`, `notificationsGet`, `notificationsPut`.

**§6 BusEvent additions:** none. Phase 2 emits the existing `session.statusChanged`, `session.turnEnded`, `tests.recorded`, `hook.received`, `session.updated`, `session.removed` and `inbox.upserted`.

**§11 DaemonContext additions**
```ts
live?: LiveTracker;                                              // P2
launcher?: LaunchService;                                        // P2
updateConfig?: (fn: (cfg: OrcConfig) => OrcConfig) => OrcConfig; // P2 — persists via saveConfig
archive?: ArchiveServiceRuntime;                                 // P2 — narrows the contract's ArchiveService (superset)
```

**§11 new daemon interfaces**
```ts
// apps/daemon/src/live/live-tracker.ts
export interface HookEvent { sessionId: string; event: string; message: string | null; ts: string }
export interface LiveTracker { start(): Promise<void>; stop(): Promise<void>; refresh(): Promise<void>; list(): Session[]; get(pk: string): Session | null; waitForPid(pid: number, timeoutMs: number): Promise<string | null>; applyHook(e: HookEvent): void }
// apps/daemon/src/services/launch.ts
export interface LaunchResult { ptyId: string; sessionId: string | null }
export interface LaunchService { launch(req: LaunchRequest): Promise<LaunchResult>; kill(source: Source, id: string): Promise<{ killed: 'pty' | 'pid' }>; ownedCount(projectId: string | null): number }
// apps/daemon/src/inbox/engine.ts
export interface InboxEngineRuntime extends InboxEngine { tick(now?: Date): void; start(intervalMs?: number): void; stop(): void }
// apps/daemon/src/collectors/codex/live.ts
export interface CodexLiveProc { pid: number; cwd: string; startedAtMs: number; rolloutPath: string | null; sessionId: string | null; originator: string | null; lastWriteMs: number | null }
export interface CodexLiveDetector { scan(): Promise<CodexLiveProc[]> }
// apps/daemon/src/services/archive/archive.ts
export interface ArchiveServiceRuntime extends ArchiveService { restorePlan(source: Source, id: string): { targets: string[] }; codec(): ArchiveCodec; start(intervalMs?: number): void; stop(): void }
export function resolveAvailability(i: { transcriptExists: boolean; archived: boolean; hasPrompts: boolean; remote?: boolean }): Availability
```

**Inbox dedupe keys:** `${kind}:${sessionPk}`, e.g. `waiting:claude:s-basic`. Every inbox item's payload carries `{ source, id }` so notification URLs can be built as `http://127.0.0.1:<port>/sessions/<source>/<id>`.

**§12 web additions**
- Query keys: `['templates', projectId]`, `['archive-status']`, `['notification-prefs']`.
- Stores: `stores/live-layout.ts` → `useLiveLayoutStore` `{ layout: 'grid'|'list'|'split'; pinned: string[]; groupBy: 'none'|'project'|'ticket'|'source'; openInByProject: Record<string, OpenInApp>; setLayout; togglePin; setGroupBy; setOpenIn }` (persisted, key `orc.live-layout`). `stores/launch.ts` → `useLaunchStore` `{ open: boolean; preset: Partial<LaunchRequestInput> | null; show(preset?); hide() }`.
- Hook: `api/live-events.ts` → `useLiveEvents()` and `applyLiveEvent(qc, e)`.

---

## File Structure (created or modified in this phase)
```
packages/core/src/claude/registry.ts (+test)
packages/core/src/derive/{tests,stage,live-transcript,live-status}.ts (+tests)
packages/core/src/index.ts                                   (modify: exports)
packages/api-contract/src/config.ts                          (modify: live)
packages/api-contract/src/routes/{live,launch,inbox,templates,archive,notifications,hooks}.ts
packages/api-contract/src/client-p2.ts (+test)  src/client.ts (modify)  src/index.ts (modify)
apps/daemon/src/db/schema.ts                                 (modify) + migrations
apps/daemon/src/db/repos/{inbox,test-results,archive}.ts (+tests)
apps/daemon/src/live/{liveness,registry-watcher,find-transcript,stub-session,live-tracker}.ts (+tests)
apps/daemon/src/collectors/codex/live.ts (+test)
apps/daemon/src/inbox/engine.ts  inbox/rules/status-rules.ts (+tests)
apps/daemon/src/notify/{notifier,macos}.ts (+tests)
apps/daemon/src/services/{templates,launch,open-in}.ts (+tests)
apps/daemon/src/services/archive/{compress,archive}.ts (+tests)
apps/daemon/src/services/sessions.ts                         (modify: availability)
apps/daemon/src/http/routes/{live,hooks,inbox,templates,launch,archive,notifications}.ts (+tests)
apps/daemon/src/http/live-ws.ts (+test)  http/ws.ts (modify)  http/app.ts (modify)
apps/daemon/src/context.ts  main.ts                          (modify)
apps/daemon/test/bin/{claude,codex}  test/p2-daemon.test.ts  test/e2e-daemon.ts
apps/web/src/api/{live-events.ts,queries/live.ts,queries/inbox.ts,queries/templates.ts,queries/launch.ts,queries/archive.ts} (+tests)
apps/web/src/stores/{live-layout,launch}.ts
apps/web/src/features/live-board/{LiveBoard,SessionCard,StageBar,TestChip,OpenInButton}.tsx  sort.ts (+tests)
apps/web/src/features/inbox/{InboxPage.tsx,useInboxKeys.ts,InboxCount.tsx} (+tests)
apps/web/src/features/launch/LaunchDialog.tsx (+test)
apps/web/src/features/settings/{ArchiveSettings,NotificationSettings}.tsx (+test)  SettingsPage.tsx (modify)
apps/web/src/features/shell/AppShell.tsx (modify)
apps/web/src/routes/{index,live,inbox}.tsx
apps/web/src/test/query.tsx
apps/web/e2e/live-inbox.spec.ts   apps/web/playwright.config.ts (modify)
plan/00-contracts.md  plan/README.md  plan/phase-2-evidence.md
```

---

### Task 1: Phase-2 tables and repositories

**Files:**
- Modify: `apps/daemon/src/db/schema.ts` (append three tables)
- Create: `apps/daemon/src/db/migrations/<generated>` (drizzle-kit output)
- Create: `apps/daemon/src/db/repos/inbox.ts`, `apps/daemon/src/db/repos/test-results.ts`, `apps/daemon/src/db/repos/archive.ts`
- Test: `apps/daemon/src/db/repos/p2-repos.test.ts`

**Interfaces:**
- Consumes: `openDb(file)` and `OrcDb` (P1, contracts §5); `InboxItem`, `InboxKind`, `InboxState`, `TestResult` (`@orc/core`)
- Produces:
  ```ts
  // db/repos/inbox.ts
  export interface InboxFilter { state?: InboxState[]; kind?: InboxKind[]; projectId?: string }
  export type InboxPatch = Partial<Pick<InboxItem, 'reason' | 'state' | 'snoozeUntil' | 'payload' | 'ticket' | 'projectId'>> & { updatedAt: string };
  export function insertInboxItem(db: OrcDb, item: InboxItem): void
  export function getInboxItem(db: OrcDb, id: string): InboxItem | null
  export function findActiveByDedupe(db: OrcDb, dedupeKey: string): InboxItem | null
  export function updateInboxItem(db: OrcDb, id: string, patch: InboxPatch): InboxItem
  export function listInboxItems(db: OrcDb, f: InboxFilter): InboxItem[]          // newest updatedAt first
  export function listDueSnoozed(db: OrcDb, nowIso: string): InboxItem[]
  // db/repos/test-results.ts
  export function insertTestResult(db: OrcDb, sessionPk: string, r: TestResult): boolean   // false when (pk, ts) exists
  export function previousTestResult(db: OrcDb, sessionPk: string, beforeTs: string): TestResult | null
  export function latestTestResult(db: OrcDb, sessionPk: string): TestResult | null
  // db/repos/archive.ts
  export type ArchiveCodecName = 'zstd' | 'gzip';
  export interface ArchiveEntry { path: string; sessionPk: string; agentId: string | null; projectId: string; archivePath: string; codec: ArchiveCodecName; sourceSize: number; sourceMtimeMs: number; bytes: number; archivedAt: string }
  export function getArchiveEntry(db: OrcDb, path: string): ArchiveEntry | null
  export function upsertArchiveEntry(db: OrcDb, e: ArchiveEntry): void
  export function listArchiveEntries(db: OrcDb, sessionPk?: string): ArchiveEntry[]
  export function archiveTotals(db: OrcDb): { files: number; bytes: number }
  export function archivedSessionPks(db: OrcDb): Set<string>
  ```

- [ ] **Step 1: Branch and verify the Phase-1 assumptions**

```bash
cd /Users/hazem/orchestrator
git checkout main && git pull --ff-only || true
git checkout -b phase/2-live-board-inbox-archive
grep -n "export function openDb\|export type OrcDb" apps/daemon/src/db/client.ts
grep -n "export interface DaemonContext" -A 30 apps/daemon/src/context.ts
grep -n "setLive\|getByPk\|availability" apps/daemon/src/services/sessions.ts
grep -n "export function createApp\|register.*Routes" apps/daemon/src/http/app.ts
grep -n "export function attachWebSockets\|authorizeUpgrade\|upgrade" apps/daemon/src/http/ws.ts
grep -n "export async function createDaemon\|export function createDaemon" apps/daemon/src/main.ts
grep -n "export function useTempHomes\|export function createTestContext" apps/daemon/test/helpers.ts
grep -n "export function createApiClient\|export type ApiClient" packages/api-contract/src/client.ts
grep -n "getApiClient\|setApiClientForTests" apps/web/src/api/client.ts
grep -n "export function AppShell" apps/web/src/features/shell/AppShell.tsx
cat plan/spikes/S3.md plan/spikes/S5.md
```
Expected: every grep prints at least one line. Write any signature that differs from the "Phase-1 interfaces this plan assumes" table into the review note, together with the adaptation you will use.

- [ ] **Step 2: Write the failing repo test**

`apps/daemon/src/db/repos/p2-repos.test.ts`
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboxItem } from '@orc/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../client.ts';
import {
  archiveTotals,
  archivedSessionPks,
  getArchiveEntry,
  listArchiveEntries,
  upsertArchiveEntry,
} from './archive.ts';
import {
  findActiveByDedupe,
  getInboxItem,
  insertInboxItem,
  listDueSnoozed,
  listInboxItems,
  updateInboxItem,
} from './inbox.ts';
import { insertTestResult, latestTestResult, previousTestResult } from './test-results.ts';

let handle: ReturnType<typeof openDb>;
beforeEach(() => {
  handle = openDb(join(mkdtempSync(join(tmpdir(), 'orc-p2db-')), 'index.db'));
});
afterEach(() => handle.close());

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'i1',
  kind: 'waiting',
  sessionId: 's-basic',
  projectId: 'wakecap',
  ticket: null,
  reason: 'Waiting: input needed',
  dedupeKey: 'waiting:claude:s-basic',
  createdAt: '2026-09-01T09:00:00.000Z',
  updatedAt: '2026-09-01T09:00:00.000Z',
  state: 'open',
  snoozeUntil: null,
  payload: { source: 'claude', id: 's-basic' },
  ...over,
});

describe('inbox repo', () => {
  it('inserts, reads and finds active items by dedupe key', () => {
    insertInboxItem(handle.db, item());
    expect(getInboxItem(handle.db, 'i1')?.payload).toEqual({ source: 'claude', id: 's-basic' });
    expect(findActiveByDedupe(handle.db, 'waiting:claude:s-basic')?.id).toBe('i1');
  });

  it('allows only one active item per dedupe key', () => {
    insertInboxItem(handle.db, item());
    expect(() => insertInboxItem(handle.db, item({ id: 'i2' }))).toThrow();
    updateInboxItem(handle.db, 'i1', { state: 'done', updatedAt: '2026-09-01T09:01:00.000Z' });
    expect(findActiveByDedupe(handle.db, 'waiting:claude:s-basic')).toBeNull();
    insertInboxItem(handle.db, item({ id: 'i2' }));
    expect(findActiveByDedupe(handle.db, 'waiting:claude:s-basic')?.id).toBe('i2');
  });

  it('filters by state, kind and project, newest first', () => {
    insertInboxItem(handle.db, item());
    insertInboxItem(handle.db, item({ id: 'i2', kind: 'review', dedupeKey: 'review:claude:x', updatedAt: '2026-09-01T10:00:00.000Z' }));
    insertInboxItem(handle.db, item({ id: 'i3', kind: 'error', dedupeKey: 'error:claude:y', projectId: 'forza', state: 'done' }));
    expect(listInboxItems(handle.db, {}).map((i) => i.id)).toEqual(['i2', 'i1', 'i3']);
    expect(listInboxItems(handle.db, { state: ['open'] }).map((i) => i.id)).toEqual(['i2', 'i1']);
    expect(listInboxItems(handle.db, { kind: ['error'] }).map((i) => i.id)).toEqual(['i3']);
    expect(listInboxItems(handle.db, { projectId: 'forza' }).map((i) => i.id)).toEqual(['i3']);
  });

  it('lists snoozed items that are due', () => {
    insertInboxItem(handle.db, item({ state: 'snoozed', snoozeUntil: '2026-09-01T09:30:00.000Z' }));
    expect(listDueSnoozed(handle.db, '2026-09-01T09:29:59.000Z')).toHaveLength(0);
    expect(listDueSnoozed(handle.db, '2026-09-01T09:30:00.000Z').map((i) => i.id)).toEqual(['i1']);
  });

  it('updates payload and reason', () => {
    insertInboxItem(handle.db, item());
    const out = updateInboxItem(handle.db, 'i1', { reason: 'changed', payload: { a: 1 }, updatedAt: '2026-09-01T09:05:00.000Z' });
    expect(out.reason).toBe('changed');
    expect(out.payload).toEqual({ a: 1 });
    expect(() => updateInboxItem(handle.db, 'missing', { updatedAt: 'x' })).toThrow(/not found/);
  });
});

describe('test_results repo', () => {
  const r = (ts: string, failed: number) => ({ ts, command: 'pnpm vitest run', passed: 3, failed, skipped: 0, durationMs: 1400 });

  it('inserts idempotently and finds previous/latest', () => {
    expect(insertTestResult(handle.db, 'claude:s', r('2026-09-01T09:00:00.000Z', 0))).toBe(true);
    expect(insertTestResult(handle.db, 'claude:s', r('2026-09-01T09:00:00.000Z', 0))).toBe(false);
    insertTestResult(handle.db, 'claude:s', r('2026-09-01T09:10:00.000Z', 2));
    expect(previousTestResult(handle.db, 'claude:s', '2026-09-01T09:10:00.000Z')?.failed).toBe(0);
    expect(previousTestResult(handle.db, 'claude:s', '2026-09-01T09:00:00.000Z')).toBeNull();
    expect(latestTestResult(handle.db, 'claude:s')?.failed).toBe(2);
    expect(latestTestResult(handle.db, 'claude:other')).toBeNull();
  });
});

describe('archive repo', () => {
  it('upserts entries and totals them', () => {
    const e = {
      path: '/c/projects/p/s-basic.jsonl',
      sessionPk: 'claude:s-basic',
      agentId: null,
      projectId: 'wakecap',
      archivePath: '/o/archive/wakecap/s-basic.jsonl.zst',
      codec: 'zstd' as const,
      sourceSize: 100,
      sourceMtimeMs: 1,
      bytes: 10,
      archivedAt: '2026-09-01T09:00:00.000Z',
    };
    upsertArchiveEntry(handle.db, e);
    upsertArchiveEntry(handle.db, { ...e, sourceSize: 200, bytes: 20 });
    upsertArchiveEntry(handle.db, { ...e, path: '/c/projects/p/s-basic/subagents/agent-a.jsonl', agentId: 'a', bytes: 5 });
    expect(getArchiveEntry(handle.db, e.path)?.sourceSize).toBe(200);
    expect(listArchiveEntries(handle.db, 'claude:s-basic')).toHaveLength(2);
    expect(listArchiveEntries(handle.db)).toHaveLength(2);
    expect(archiveTotals(handle.db)).toEqual({ files: 2, bytes: 25 });
    expect([...archivedSessionPks(handle.db)]).toEqual(['claude:s-basic']);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/db/repos/p2-repos.test.ts`
Expected: FAIL, `Cannot find module './archive.ts'`

- [ ] **Step 4: Add the tables to the schema**

Append to `apps/daemon/src/db/schema.ts`. Merge the imports with the existing import lines from `drizzle-orm` and `drizzle-orm/sqlite-core`, and don't duplicate them.
```ts
import type { InboxKind, InboxState } from '@orc/core';
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const inboxItems = sqliteTable(
  'inbox_items',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<InboxKind>().notNull(),
    sessionId: text('session_id'),
    projectId: text('project_id'),
    ticket: text('ticket'),
    reason: text('reason').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    state: text('state').$type<InboxState>().notNull(),
    snoozeUntil: text('snooze_until'),
    payloadJson: text('payload_json').notNull().default('{}'),
  },
  (t) => [
    uniqueIndex('inbox_items_active_dedupe').on(t.dedupeKey).where(sql`state in ('open', 'snoozed')`),
    index('inbox_items_state_idx').on(t.state, t.updatedAt),
  ],
);

export const testResults = sqliteTable(
  'test_results',
  {
    sessionPk: text('session_pk').notNull(),
    ts: text('ts').notNull(),
    command: text('command').notNull(),
    passed: integer('passed').notNull(),
    failed: integer('failed').notNull(),
    skipped: integer('skipped').notNull(),
    durationMs: integer('duration_ms'),
  },
  (t) => [primaryKey({ columns: [t.sessionPk, t.ts] })],
);

export const archiveEntries = sqliteTable(
  'archive_entries',
  {
    path: text('path').primaryKey(),
    sessionPk: text('session_pk').notNull(),
    agentId: text('agent_id'),
    projectId: text('project_id').notNull(),
    archivePath: text('archive_path').notNull(),
    codec: text('codec').$type<'zstd' | 'gzip'>().notNull(),
    sourceSize: integer('source_size').notNull(),
    sourceMtimeMs: integer('source_mtime_ms').notNull(),
    bytes: integer('bytes').notNull(),
    archivedAt: text('archived_at').notNull(),
  },
  (t) => [index('archive_entries_session_idx').on(t.sessionPk)],
);
```

Generate the migration:

Run: `pnpm --filter @orc/daemon db:generate`
Expected: a new SQL file under `apps/daemon/src/db/migrations/` containing `CREATE TABLE \`inbox_items\``, `CREATE UNIQUE INDEX \`inbox_items_active_dedupe\` ... WHERE state in ('open', 'snoozed')`, `test_results` and `archive_entries`.

- [ ] **Step 5: Implement the repos**

`apps/daemon/src/db/repos/inbox.ts`
```ts
import type { InboxItem, InboxKind, InboxState } from '@orc/core';
import { type SQL, and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { inboxItems } from '../schema.ts';

type Row = typeof inboxItems.$inferSelect;
const ACTIVE: InboxState[] = ['open', 'snoozed'];

export interface InboxFilter {
  state?: InboxState[];
  kind?: InboxKind[];
  projectId?: string;
}

export type InboxPatch = Partial<Pick<InboxItem, 'reason' | 'state' | 'snoozeUntil' | 'payload' | 'ticket' | 'projectId'>> & {
  updatedAt: string;
};

function toItem(r: Row): InboxItem {
  return {
    id: r.id,
    kind: r.kind,
    sessionId: r.sessionId,
    projectId: r.projectId,
    ticket: r.ticket,
    reason: r.reason,
    dedupeKey: r.dedupeKey,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    state: r.state,
    snoozeUntil: r.snoozeUntil,
    payload: JSON.parse(r.payloadJson) as Record<string, unknown>,
  };
}

export function insertInboxItem(db: OrcDb, item: InboxItem): void {
  const { payload, ...rest } = item;
  db.insert(inboxItems).values({ ...rest, payloadJson: JSON.stringify(payload) }).run();
}

export function getInboxItem(db: OrcDb, id: string): InboxItem | null {
  const r = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get();
  return r ? toItem(r) : null;
}

export function findActiveByDedupe(db: OrcDb, dedupeKey: string): InboxItem | null {
  const r = db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.dedupeKey, dedupeKey), inArray(inboxItems.state, ACTIVE)))
    .get();
  return r ? toItem(r) : null;
}

export function updateInboxItem(db: OrcDb, id: string, patch: InboxPatch): InboxItem {
  const { payload, ...rest } = patch;
  db.update(inboxItems)
    .set({ ...rest, ...(payload ? { payloadJson: JSON.stringify(payload) } : {}) })
    .where(eq(inboxItems.id, id))
    .run();
  const out = getInboxItem(db, id);
  if (!out) throw new Error(`inbox item ${id} not found`);
  return out;
}

export function listInboxItems(db: OrcDb, f: InboxFilter): InboxItem[] {
  const conds: SQL[] = [];
  if (f.state?.length) conds.push(inArray(inboxItems.state, f.state));
  if (f.kind?.length) conds.push(inArray(inboxItems.kind, f.kind));
  if (f.projectId) conds.push(eq(inboxItems.projectId, f.projectId));
  return db
    .select()
    .from(inboxItems)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(inboxItems.updatedAt), sql`rowid asc`)
    .all()
    .map(toItem);
}

export function listDueSnoozed(db: OrcDb, nowIso: string): InboxItem[] {
  return db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.state, 'snoozed'), lte(inboxItems.snoozeUntil, nowIso)))
    .orderBy(asc(inboxItems.snoozeUntil))
    .all()
    .map(toItem);
}
```

Items with the same `updatedAt` keep insertion order (`rowid asc`). The test relies on this.

`apps/daemon/src/db/repos/test-results.ts`
```ts
import type { TestResult } from '@orc/core';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { testResults } from '../schema.ts';

type Row = typeof testResults.$inferSelect;
const toResult = (r: Row): TestResult => ({
  ts: r.ts,
  command: r.command,
  passed: r.passed,
  failed: r.failed,
  skipped: r.skipped,
  durationMs: r.durationMs,
});

export function insertTestResult(db: OrcDb, sessionPk: string, r: TestResult): boolean {
  const res = db
    .insert(testResults)
    .values({ sessionPk, ...r })
    .onConflictDoNothing()
    .run();
  return res.changes > 0;
}

export function previousTestResult(db: OrcDb, sessionPk: string, beforeTs: string): TestResult | null {
  const r = db
    .select()
    .from(testResults)
    .where(and(eq(testResults.sessionPk, sessionPk), lt(testResults.ts, beforeTs)))
    .orderBy(desc(testResults.ts))
    .get();
  return r ? toResult(r) : null;
}

export function latestTestResult(db: OrcDb, sessionPk: string): TestResult | null {
  const r = db.select().from(testResults).where(eq(testResults.sessionPk, sessionPk)).orderBy(desc(testResults.ts)).get();
  return r ? toResult(r) : null;
}
```

`apps/daemon/src/db/repos/archive.ts`
```ts
import { eq, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { archiveEntries } from '../schema.ts';

export type ArchiveCodecName = 'zstd' | 'gzip';
export interface ArchiveEntry {
  path: string;
  sessionPk: string;
  agentId: string | null;
  projectId: string;
  archivePath: string;
  codec: ArchiveCodecName;
  sourceSize: number;
  sourceMtimeMs: number;
  bytes: number;
  archivedAt: string;
}

export function getArchiveEntry(db: OrcDb, path: string): ArchiveEntry | null {
  return db.select().from(archiveEntries).where(eq(archiveEntries.path, path)).get() ?? null;
}

export function upsertArchiveEntry(db: OrcDb, e: ArchiveEntry): void {
  const { path, ...rest } = e;
  db.insert(archiveEntries).values(e).onConflictDoUpdate({ target: archiveEntries.path, set: rest }).run();
  void path;
}

export function listArchiveEntries(db: OrcDb, sessionPk?: string): ArchiveEntry[] {
  const q = db.select().from(archiveEntries);
  return (sessionPk ? q.where(eq(archiveEntries.sessionPk, sessionPk)) : q).all();
}

export function archiveTotals(db: OrcDb): { files: number; bytes: number } {
  const r = db
    .select({ files: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${archiveEntries.bytes}), 0)` })
    .from(archiveEntries)
    .get();
  return { files: Number(r?.files ?? 0), bytes: Number(r?.bytes ?? 0) };
}

export function archivedSessionPks(db: OrcDb): Set<string> {
  return new Set(
    db
      .selectDistinct({ pk: archiveEntries.sessionPk })
      .from(archiveEntries)
      .all()
      .map((r) => r.pk),
  );
}
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm vitest run apps/daemon/src/db/repos/p2-repos.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 7: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/daemon/src/db
git commit -m "feat(daemon): add inbox_items, test_results and archive_entries tables with repos"
```

---

### Task 2: api-contract — Phase-2 route schemas, config and client methods

**Files:**
- Modify: `packages/api-contract/src/config.ts` (add `live`)
- Create: `packages/api-contract/src/routes/live.ts`, `launch.ts`, `inbox.ts`, `templates.ts`, `archive.ts`, `notifications.ts`, `hooks.ts`
- Create: `packages/api-contract/src/client-p2.ts`
- Modify: `packages/api-contract/src/client.ts`, `packages/api-contract/src/index.ts`
- Test: `packages/api-contract/src/p2-contract.test.ts`

**Interfaces:**
- Consumes: `OrcConfig` (contracts §3); `Session`, `InboxItem`, `InboxKind`, `InboxState`, `Source` (`@orc/core`); `createApiClient` (P1)
- Produces:
  ```ts
  // routes/launch.ts
  export const LaunchRequest: z.ZodObject<...>    // exactly contracts §11
  export type LaunchRequest = z.infer<typeof LaunchRequest>
  export type LaunchRequestInput = z.input<typeof LaunchRequest>
  export const LaunchResponse = z.object({ ptyId: z.string(), sessionId: z.string().nullable() })
  export const ConfirmBody = z.object({ confirm: z.boolean().optional() })
  export const KillResponse = z.object({ killed: z.enum(['pty', 'pid']) })
  export const OpenInBody = z.object({ app: z.enum(['vscode', 'terminal', 'finder']), remember: z.boolean().default(true) })
  // routes/inbox.ts
  export const InboxListQuery  // { state?: InboxState[]; kind?: InboxKind[]; projectId?: string } parsed from comma lists
  export const InboxActionBody = z.object({ until: z.string().optional() })
  // routes/templates.ts
  export const TemplateSchema; export type TemplateDto = z.infer<typeof TemplateSchema>
  // routes/archive.ts
  export const ArchiveStatus; export type ArchiveStatus; export const ArchiveRestoreBody; export const ArchiveRestoreResponse
  export const RECOMMENDED_CLEANUP_SNIPPET: string
  // routes/notifications.ts
  export const NotificationPrefs; export type NotificationPrefs
  // routes/hooks.ts
  export const HookIngestBody; export type HookIngestBody
  // client-p2.ts
  export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  export class ApiCallError extends Error { status: number; code: string; details: unknown }
  export type Caller = <T>(method: HttpMethod, path: string, body?: unknown) => Promise<T>
  export function makeCaller(opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch }): Caller
  export function p2Methods(call: Caller): { liveList; sessionsLaunch; sessionsKill; sessionsOpenIn; inboxList; inboxDone; inboxSnooze; inboxReopen; templatesList; archiveStatus; archiveRestore; archiveSync; notificationsGet; notificationsPut }
  ```

- [ ] **Step 1: Write the failing contract test**

`packages/api-contract/src/p2-contract.test.ts`
```ts
import { describe, expect, it, vi } from 'vitest';
import { ApiCallError, makeCaller, p2Methods } from './client-p2.ts';
import { OrcConfig } from './config.ts';
import { HookIngestBody } from './routes/hooks.ts';
import { InboxListQuery } from './routes/inbox.ts';
import { LaunchRequest, OpenInBody } from './routes/launch.ts';

describe('phase 2 contract', () => {
  it('fills live config defaults', () => {
    expect(OrcConfig.parse({}).live).toEqual({ pollMs: 1000, endedRetentionMin: 10, codexBusyWindowMs: 10000 });
  });

  it('parses a launch request with defaults', () => {
    const r = LaunchRequest.parse({ source: 'claude', projectId: 'wakecap', cwd: '/tmp' });
    expect(r).toMatchObject({ prompt: '', vars: {}, planApproval: false });
    expect(LaunchRequest.safeParse({ source: 'agnc', projectId: null, cwd: '/tmp' }).success).toBe(false);
  });

  it('defaults open-in remember to true', () => {
    expect(OpenInBody.parse({ app: 'finder' })).toEqual({ app: 'finder', remember: true });
  });

  it('parses comma-separated inbox filters', () => {
    expect(InboxListQuery.parse({ state: 'open,snoozed', kind: 'waiting' })).toEqual({
      state: ['open', 'snoozed'],
      kind: ['waiting'],
    });
    expect(InboxListQuery.safeParse({ state: 'bogus' }).success).toBe(false);
  });

  it('keeps unknown hook fields', () => {
    const h = HookIngestBody.parse({ session_id: 's', hook_event_name: 'Notification', cwd: '/x' });
    expect(h).toMatchObject({ session_id: 's', cwd: '/x' });
  });

  it('calls the API with the token and parses errors', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'concurrency_limit', message: 'too many', details: { max: 1 } } }), {
          status: 429,
        }),
      );
    const api = p2Methods(makeCaller({ baseUrl: 'http://127.0.0.1:4317', token: 't0k', fetchImpl }));
    await expect(api.inboxList({ state: ['open'], projectId: 'wakecap' })).resolves.toEqual([]);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://127.0.0.1:4317/api/inbox?state=open&projectId=wakecap');
    expect((init?.headers as Record<string, string>)['x-orc-token']).toBe('t0k');
    const err = await api.sessionsLaunch({ source: 'claude', projectId: null, cwd: '/tmp' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiCallError);
    expect(err).toMatchObject({ status: 429, code: 'concurrency_limit', details: { max: 1 } });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/api-contract/src/p2-contract.test.ts`
Expected: FAIL, `Cannot find module './client-p2.ts'`

- [ ] **Step 3: Add the `live` config block**

In `packages/api-contract/src/config.ts`, add this field inside `OrcConfig = z.object({ … })`, after `archive`:
```ts
  live: z
    .object({
      pollMs: z.number().int().positive().default(1000),
      endedRetentionMin: z.number().int().positive().default(10),
      codexBusyWindowMs: z.number().int().positive().default(10000),
    })
    .default({ pollMs: 1000, endedRetentionMin: 10, codexBusyWindowMs: 10000 }),
```

- [ ] **Step 4: Write the route schemas**

`packages/api-contract/src/routes/live.ts`
```ts
import type { Session } from '@orc/core';
import { z } from 'zod';

export const LiveListResponse = z.array(z.custom<Session>((v) => typeof v === 'object' && v !== null));
export type LiveListResponse = z.infer<typeof LiveListResponse>;
```

`packages/api-contract/src/routes/launch.ts`
```ts
import { z } from 'zod';

export const LaunchRequest = z.object({
  source: z.enum(['claude', 'codex']),
  projectId: z.string().nullable(),
  cwd: z.string(),
  prompt: z.string().default(''),
  templateId: z.string().optional(),
  vars: z.record(z.string(), z.string()).default({}),
  ticket: z.string().optional(),
  model: z.string().optional(),
  planApproval: z.boolean().default(false),
  worktree: z
    .object({
      repo: z.string(),
      base: z.string(),
      type: z.enum(['feat', 'fix', 'chore', 'docs', 'refactor']),
      slug: z.string(),
    })
    .optional(),
  compare: z.array(z.object({ source: z.enum(['claude', 'codex']), model: z.string().optional() })).optional(),
});
export type LaunchRequest = z.infer<typeof LaunchRequest>;
export type LaunchRequestInput = z.input<typeof LaunchRequest>;

export const LaunchResponse = z.object({ ptyId: z.string(), sessionId: z.string().nullable() });
export type LaunchResponse = z.infer<typeof LaunchResponse>;

export const ConfirmBody = z.object({ confirm: z.boolean().optional() });
export const KillResponse = z.object({ killed: z.enum(['pty', 'pid']) });
export type KillResponse = z.infer<typeof KillResponse>;

export const OpenInApp = z.enum(['vscode', 'terminal', 'finder']);
export type OpenInApp = z.infer<typeof OpenInApp>;
export const OpenInBody = z.object({ app: OpenInApp, remember: z.boolean().default(true) });
```

`packages/api-contract/src/routes/inbox.ts`
```ts
import { z } from 'zod';

export const InboxKindSchema = z.enum([
  'waiting', 'review', 'plan_approval', 'blocked', 'error', 'tests_red', 'budget',
  'automation_result', 'supervisor_escalation', 'pr_event', 'reminder',
]);
export const InboxStateSchema = z.enum(['open', 'snoozed', 'done', 'auto_resolved']);

const csv = <T extends z.ZodType>(item: T) =>
  z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(item));

export const InboxListQuery = z.object({
  state: csv(InboxStateSchema).optional(),
  kind: csv(InboxKindSchema).optional(),
  projectId: z.string().optional(),
});
export type InboxListQuery = z.infer<typeof InboxListQuery>;

export const InboxActionBody = z.object({ until: z.string().optional() });
```

`packages/api-contract/src/routes/templates.ts`
```ts
import { z } from 'zod';

export const TemplateSchema = z.object({
  id: z.string(),
  kind: z.enum(['workflow', 'preset']),
  label: z.string(),
  prompt: z.string(),
  vars: z.array(z.enum(['ticket', 'ticketUrl', 'prUrl', 'file', 'check'])),
  defaultSource: z.enum(['claude', 'codex', 'agnc']),
  projectIds: z.union([z.array(z.string()), z.literal('all')]),
});
export type TemplateDto = z.infer<typeof TemplateSchema>;
```

`packages/api-contract/src/routes/archive.ts`
```ts
import { z } from 'zod';

export const RECOMMENDED_CLEANUP_SNIPPET = '{\n  "cleanupPeriodDays": 3650\n}';

export const ArchiveStatus = z.object({
  enabled: z.boolean(),
  files: z.number(),
  bytes: z.number(),
  oldestTranscript: z.string().nullable(),
  cleanupPeriodDays: z.number().nullable(),
  codec: z.enum(['zstd', 'gzip']),
  recommendedSnippet: z.string(),
});
export type ArchiveStatus = z.infer<typeof ArchiveStatus>;

export const ArchiveRestoreBody = z.object({
  source: z.enum(['claude', 'codex', 'agnc']),
  id: z.string().min(1),
  confirm: z.boolean().optional(),
});
export const ArchiveRestoreResponse = z.object({ restored: z.array(z.string()) });
export type ArchiveRestoreResponse = z.infer<typeof ArchiveRestoreResponse>;
```

`packages/api-contract/src/routes/notifications.ts`
```ts
import { z } from 'zod';

export const NotificationPrefs = z.record(
  z.string(),
  z.object({ enabled: z.boolean(), channels: z.array(z.enum(['macos', 'webpush', 'slack_dm'])) }),
);
export type NotificationPrefs = z.infer<typeof NotificationPrefs>;
```

`packages/api-contract/src/routes/hooks.ts`
```ts
import { z } from 'zod';

export const HookIngestBody = z.looseObject({
  session_id: z.string().min(1),
  hook_event_name: z.string().min(1),
  message: z.string().optional(),
});
export type HookIngestBody = z.infer<typeof HookIngestBody>;
```

- [ ] **Step 5: Write the typed client methods**

`packages/api-contract/src/client-p2.ts`
```ts
import type { InboxItem, InboxKind, InboxState, Session, Source } from '@orc/core';
import type { ArchiveRestoreResponse, ArchiveStatus } from './routes/archive.ts';
import type { KillResponse, LaunchRequestInput, LaunchResponse, OpenInApp } from './routes/launch.ts';
import type { NotificationPrefs } from './routes/notifications.ts';
import type { TemplateDto } from './routes/templates.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class ApiCallError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

export type Caller = <T>(method: HttpMethod, path: string, body?: unknown) => Promise<T>;

export function makeCaller(opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch }): Caller {
  const f = opts.fetchImpl ?? fetch;
  return async <T>(method: HttpMethod, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { 'x-orc-token': opts.token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await f(`${opts.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      throw new ApiCallError(res.status, e?.code ?? 'http_error', e?.message ?? res.statusText, e?.details);
    }
    return json as T;
  };
}

function qs(params: Record<string, string | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

export function p2Methods(call: Caller) {
  return {
    liveList: () => call<Session[]>('GET', '/api/live'),
    sessionsLaunch: (req: LaunchRequestInput) => call<LaunchResponse>('POST', '/api/sessions/launch', req),
    sessionsKill: (source: Source, id: string, confirm: boolean) =>
      call<KillResponse>('POST', `/api/sessions/${source}/${enc(id)}/kill`, { confirm }),
    sessionsOpenIn: (source: Source, id: string, app: OpenInApp, remember = true) =>
      call<{ ok: true }>('POST', `/api/sessions/${source}/${enc(id)}/open-in`, { app, remember }),
    inboxList: (f: { state?: InboxState[]; kind?: InboxKind[]; projectId?: string } = {}) =>
      call<InboxItem[]>(
        'GET',
        `/api/inbox${qs({ state: f.state?.join(','), kind: f.kind?.join(','), projectId: f.projectId })}`,
      ),
    inboxDone: (id: string) => call<InboxItem>('POST', `/api/inbox/${enc(id)}/done`, {}),
    inboxSnooze: (id: string, until: string) => call<InboxItem>('POST', `/api/inbox/${enc(id)}/snooze`, { until }),
    inboxReopen: (id: string) => call<InboxItem>('POST', `/api/inbox/${enc(id)}/reopen`, {}),
    templatesList: (projectId?: string) => call<TemplateDto[]>('GET', `/api/templates${qs({ projectId })}`),
    archiveStatus: () => call<ArchiveStatus>('GET', '/api/archive/status'),
    archiveRestore: (source: Source, id: string, confirm: boolean) =>
      call<ArchiveRestoreResponse>('POST', '/api/archive/restore', { source, id, confirm }),
    archiveSync: () => call<{ copied: number }>('POST', '/api/archive/sync', {}),
    notificationsGet: () => call<NotificationPrefs>('GET', '/api/config/notifications'),
    notificationsPut: (prefs: NotificationPrefs) => call<NotificationPrefs>('PUT', '/api/config/notifications', prefs),
  };
}
export type P2Methods = ReturnType<typeof p2Methods>;
```

In `packages/api-contract/src/client.ts`, merge the Phase-2 methods into the object that `createApiClient` returns. Keep every Phase-1 method and change only the return statement:
```ts
import { makeCaller, p2Methods } from './client-p2.ts';
// inside createApiClient({ baseUrl, token }):
//   return { ...<existing phase-1 methods object>, ...p2Methods(makeCaller({ baseUrl, token })) };
```
For example, if Phase 1 ends with `return methods;`, change it to `return { ...methods, ...p2Methods(makeCaller({ baseUrl, token })) };`.

Append to `packages/api-contract/src/index.ts`:
```ts
export * from './client-p2.ts';
export * from './routes/archive.ts';
export * from './routes/hooks.ts';
export * from './routes/inbox.ts';
export * from './routes/launch.ts';
export * from './routes/live.ts';
export * from './routes/notifications.ts';
export * from './routes/templates.ts';
```
If Phase 1 already exported a `LaunchRequest` from a different file, delete that copy and keep this one, because the definition is identical to contracts §11.

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm vitest run packages/api-contract`
Expected: PASS (all api-contract tests, including 6 new ones)

- [ ] **Step 7: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add packages/api-contract
git commit -m "feat(api-contract): add phase 2 route schemas, live config and client methods"
```

---

### Task 3: core — registry parser, test-output parser and stage inference

**Files:**
- Create: `packages/core/src/claude/registry.ts`, `packages/core/src/claude/registry.test.ts`
- Create: `packages/core/src/derive/tests.ts`, `packages/core/src/derive/tests.test.ts`
- Create: `packages/core/src/derive/stage.ts`, `packages/core/src/derive/stage.test.ts`
- Modify: `packages/core/src/index.ts`

If Phase 1 already created any of these files, keep its exports and add the ones below. The names below are the contract.

**Interfaces:**
- Consumes: `TestResult`, `Stage` (`@orc/core` types); `FIXTURES_DIR` (P0 test utils)
- Produces: `RegistryStatus`, `RegistryEntry`, `parseRegistryEntry`, `isRegistryFileName`, `isTestCommand`, `parseTestOutput`, `ToolCategory`, `categorizeTool`, `inferStage` (exact signatures in "Contract additions")

- [ ] **Step 1: Write the failing tests**

`packages/core/src/claude/registry.test.ts`
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES_DIR } from '../test-utils/fixtures.ts';
import { isRegistryFileName, parseRegistryEntry } from './registry.ts';

describe('parseRegistryEntry', () => {
  it('parses the fixture and drops the messaging socket', () => {
    const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, 'claude-home/sessions/41001.json'), 'utf8'));
    const e = parseRegistryEntry(raw);
    expect(e).toEqual({
      pid: 41001,
      procStart: 'Mon Sep  1 09:00:00 2026',
      sessionId: 's-basic',
      cwd: '/Users/test/Wakecap',
      startedAt: 1788253200000,
      version: '2.1.273',
      kind: 'interactive',
      name: 'notification-tests',
      status: 'waiting',
      waitingFor: 'input needed',
      statusUpdatedAt: 1788253600000,
      updatedAt: 1788253600000,
    });
    expect(JSON.stringify(e)).not.toContain('cc-socks');
  });

  it('rejects entries without pid, sessionId or cwd and ignores unknown statuses', () => {
    expect(parseRegistryEntry({ sessionId: 's', cwd: '/x' })).toBeNull();
    expect(parseRegistryEntry({ pid: 1, cwd: '/x' })).toBeNull();
    expect(parseRegistryEntry({ pid: 1, sessionId: 's' })).toBeNull();
    expect(parseRegistryEntry('nope')).toBeNull();
    expect(parseRegistryEntry({ pid: 1, sessionId: 's', cwd: '/x', status: 'dreaming' })?.status).toBeNull();
  });
});

describe('isRegistryFileName', () => {
  it('matches only <pid>.json', () => {
    expect(isRegistryFileName('41001.json')).toBe(true);
    expect(isRegistryFileName('41001.abc123.key')).toBe(false);
    expect(isRegistryFileName('41001.json.tmp')).toBe(false);
    expect(isRegistryFileName('notes.json')).toBe(false);
  });
});
```

`packages/core/src/derive/tests.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { isTestCommand, parseTestOutput } from './tests.ts';

const TS = '2026-09-01T09:00:30.000Z';

describe('isTestCommand', () => {
  it.each([
    ['pnpm vitest run', true],
    ['npx jest --ci', true],
    ['pnpm test', true],
    ['npm run test -- --watch=false', true],
    ['python -m pytest -q', true],
    ['dotnet test Backend.sln', true],
    ['flutter test', true],
    ['go test ./...', true],
    ['git status', false],
    ['cat test.txt', false],
  ])('%s → %s', (cmd, expected) => {
    expect(isTestCommand(cmd)).toBe(expected);
  });
});

describe('parseTestOutput', () => {
  it('parses vitest', () => {
    const out = ' Test Files  3 passed (3)\n      Tests  2 failed | 16 passed | 1 skipped (19)\n   Duration  1.40s (transform 20ms)';
    expect(parseTestOutput('pnpm vitest run', out, TS)).toEqual({
      ts: TS, command: 'pnpm vitest run', passed: 16, failed: 2, skipped: 1, durationMs: 1400,
    });
  });

  it('parses jest', () => {
    const out = 'Tests:       1 failed, 2 skipped, 17 passed, 20 total\nTime:        1.2 s';
    expect(parseTestOutput('npx jest', out, TS)).toMatchObject({ passed: 17, failed: 1, skipped: 2, durationMs: 1200 });
  });

  it('parses pytest', () => {
    const out = '....F\n===== 2 failed, 16 passed, 1 skipped in 1.40s =====';
    expect(parseTestOutput('pytest', out, TS)).toMatchObject({ passed: 16, failed: 2, skipped: 1, durationMs: 1400 });
  });

  it('parses dotnet test', () => {
    const out = 'Passed!  - Failed:     0, Passed:    18, Skipped:     0, Total:    18, Duration: 950 ms - Svc.Tests.dll';
    expect(parseTestOutput('dotnet test', out, TS)).toMatchObject({ passed: 18, failed: 0, skipped: 0, durationMs: 950 });
  });

  it('parses flutter test', () => {
    const out = '00:01 +3: loading\n00:02 +16 ~1 -2: Some tests failed.';
    expect(parseTestOutput('flutter test', out, TS)).toMatchObject({ passed: 16, failed: 2, skipped: 1, durationMs: 2000 });
  });

  it('returns null for unrelated output', () => {
    expect(parseTestOutput('pnpm test', 'error: command not found', TS)).toBeNull();
  });
});
```

`packages/core/src/derive/stage.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { categorizeTool, inferStage } from './stage.ts';

describe('categorizeTool', () => {
  it.each([
    ['Read', {}, 'read'],
    ['Grep', {}, 'read'],
    ['Edit', {}, 'edit'],
    ['MultiEdit', {}, 'edit'],
    ['Write', {}, 'edit'],
    ['Bash', { command: 'pnpm vitest run' }, 'test'],
    ['Bash', { command: 'rg weekend src' }, 'read'],
    ['Bash', { command: 'git diff --stat' }, 'read'],
    ['Bash', { command: 'pnpm install' }, 'other'],
    ['mcp__claude_ai_Linear__save_issue', {}, 'other'],
  ] as const)('%s %j → %s', (tool, input, expected) => {
    expect(categorizeTool(tool, input)).toBe(expected);
  });
});

describe('inferStage', () => {
  it('is null with no activity', () => {
    expect(inferStage({ categories: [], turnEnded: false, changedFiles: 0 })).toBeNull();
  });
  it('reports the furthest stage reached in the turn', () => {
    expect(inferStage({ categories: ['other'], turnEnded: false, changedFiles: 0 })).toBe('understand');
    expect(inferStage({ categories: ['read', 'read'], turnEnded: false, changedFiles: 0 })).toBe('understand');
    expect(inferStage({ categories: ['read', 'edit', 'read'], turnEnded: false, changedFiles: 1 })).toBe('modify');
    expect(inferStage({ categories: ['edit', 'test', 'edit'], turnEnded: false, changedFiles: 1 })).toBe('test');
  });
  it('is review when the turn ended with changes', () => {
    expect(inferStage({ categories: ['edit'], turnEnded: true, changedFiles: 1 })).toBe('review');
    expect(inferStage({ categories: ['read'], turnEnded: true, changedFiles: 0 })).toBe('understand');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run packages/core/src/claude/registry.test.ts packages/core/src/derive/tests.test.ts packages/core/src/derive/stage.test.ts`
Expected: FAIL, `Cannot find module './registry.ts'` (and the same for `tests.ts` and `stage.ts`)

- [ ] **Step 3: Implement the registry parser**

`packages/core/src/claude/registry.ts`
```ts
export type RegistryStatus = 'busy' | 'idle' | 'waiting' | 'shell';

export interface RegistryEntry {
  pid: number;
  procStart: string | null;
  sessionId: string;
  cwd: string;
  startedAt: number | null;
  version: string | null;
  kind: string | null;
  name: string | null;
  status: RegistryStatus | null;
  waitingFor: string | null;
  statusUpdatedAt: number | null;
  updatedAt: number | null;
}

const STATUSES = new Set<string>(['busy', 'idle', 'waiting', 'shell']);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Parses `~/.claude/sessions/<pid>.json`. Only whitelisted fields are copied, so `messagingSocketPath` never leaves this function. */
export function parseRegistryEntry(value: unknown): RegistryEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const pid = num(v.pid);
  const sessionId = str(v.sessionId);
  const cwd = str(v.cwd);
  if (pid === null || !Number.isInteger(pid) || pid <= 0 || !sessionId || !cwd) return null;
  const status = str(v.status);
  return {
    pid,
    procStart: str(v.procStart),
    sessionId,
    cwd,
    startedAt: num(v.startedAt),
    version: str(v.version),
    kind: str(v.kind),
    name: str(v.name),
    status: status !== null && STATUSES.has(status) ? (status as RegistryStatus) : null,
    waitingFor: str(v.waitingFor),
    statusUpdatedAt: num(v.statusUpdatedAt),
    updatedAt: num(v.updatedAt),
  };
}

/** `<pid>.json` only. Never matches the `<pid>.<hash>.key` files, which must not be read. */
export function isRegistryFileName(name: string): boolean {
  return /^\d+\.json$/.test(name);
}
```

- [ ] **Step 4: Implement the test-output parser**

`packages/core/src/derive/tests.ts`
```ts
import type { TestResult } from '../types/index.ts';

const TEST_CMD =
  /(?:^|[\s;&|/])(?:vitest|jest|pytest|py\.test|(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+test(?::\S+)?|dotnet\s+test|flutter\s+test|go\s+test|cargo\s+test|mocha|playwright\s+test)(?=$|[\s;&|])/;

export function isTestCommand(command: string): boolean {
  return TEST_CMD.test(command);
}

interface Counts { passed: number; failed: number; skipped: number; durationMs: number | null }

function countWords(text: string): { passed: number; failed: number; skipped: number; matched: boolean } {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let matched = false;
  for (const m of text.matchAll(/(\d+)\s+(passed|failed|skipped|todo|errors?)\b/g)) {
    matched = true;
    const n = Number(m[1]);
    const w = m[2];
    if (w === 'passed') passed += n;
    else if (w === 'failed' || w === 'error' || w === 'errors') failed += n;
    else skipped += n;
  }
  return { passed, failed, skipped, matched };
}

const toMs = (value: string, unit: string): number => Math.round(Number(value) * (unit === 'ms' ? 1 : 1000));

function vitest(out: string): Counts | null {
  const lines = [...out.matchAll(/^\s*Tests\s+(.+?)\s*\(\d+\)\s*$/gm)];
  const last = lines.at(-1);
  if (!last?.[1]) return null;
  const c = countWords(last[1]);
  if (!c.matched) return null;
  const d = [...out.matchAll(/Duration\s+([\d.]+)\s*(ms|s)\b/g)].at(-1);
  return { ...c, durationMs: d?.[1] && d[2] ? toMs(d[1], d[2]) : null };
}

function jest(out: string): Counts | null {
  const line = [...out.matchAll(/^\s*Tests:\s+(.+?),\s*\d+\s+total\s*$/gm)].at(-1);
  if (!line?.[1]) return null;
  const c = countWords(line[1]);
  if (!c.matched) return null;
  const d = [...out.matchAll(/^\s*Time:\s+([\d.]+)\s*(ms|s)\b/gm)].at(-1);
  return { ...c, durationMs: d?.[1] && d[2] ? toMs(d[1], d[2]) : null };
}

function pytest(out: string): Counts | null {
  const line = [...out.matchAll(/^=+\s+(.+?)\s+in\s+([\d.]+)s\b.*=+\s*$/gm)].at(-1);
  if (!line?.[1] || !line[2]) return null;
  const c = countWords(line[1]);
  if (!c.matched) return null;
  return { ...c, durationMs: toMs(line[2], 's') };
}

function dotnet(out: string): Counts | null {
  const all = [...out.matchAll(/Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*\d+(?:,\s*Duration:\s*([\d.]+)\s*(ms|s))?/g)];
  if (all.length === 0) return null;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let durationMs: number | null = null;
  for (const m of all) {
    failed += Number(m[1]);
    passed += Number(m[2]);
    skipped += Number(m[3]);
    if (m[4] && m[5]) durationMs = (durationMs ?? 0) + toMs(m[4], m[5]);
  }
  return { passed, failed, skipped, durationMs };
}

function flutter(out: string): Counts | null {
  const m = [...out.matchAll(/(\d+):(\d+)\s+\+(\d+)(?:\s+~(\d+))?(?:\s+-(\d+))?:\s+(?:All tests passed!|Some tests failed\.)/g)].at(-1);
  if (!m) return null;
  return {
    passed: Number(m[3]),
    skipped: Number(m[4] ?? 0),
    failed: Number(m[5] ?? 0),
    durationMs: (Number(m[1]) * 60 + Number(m[2])) * 1000,
  };
}

const PARSERS = [vitest, jest, pytest, dotnet, flutter];

export function parseTestOutput(command: string, output: string, ts: string): TestResult | null {
  for (const p of PARSERS) {
    const c = p(output);
    if (c) return { ts, command, passed: c.passed, failed: c.failed, skipped: c.skipped, durationMs: c.durationMs };
  }
  return null;
}
```

- [ ] **Step 5: Implement stage inference**

`packages/core/src/derive/stage.ts`
```ts
import type { Stage } from '../types/index.ts';
import { isTestCommand } from './tests.ts';

export type ToolCategory = 'read' | 'edit' | 'test' | 'other';

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_BASH = /^\s*(?:rg|grep|cat|head|tail|ls|find|fd|tree|wc|git\s+(?:log|diff|status|show|blame)|gh\s+(?:pr|issue)\s+view)\b/;

export function categorizeTool(tool: string, input: unknown): ToolCategory {
  if (READ_TOOLS.has(tool)) return 'read';
  if (EDIT_TOOLS.has(tool)) return 'edit';
  if (tool === 'Bash') {
    const cmd =
      typeof input === 'object' && input !== null && typeof (input as { command?: unknown }).command === 'string'
        ? (input as { command: string }).command
        : '';
    if (isTestCommand(cmd)) return 'test';
    if (READ_BASH.test(cmd)) return 'read';
  }
  return 'other';
}

const RANK: Record<Exclude<ToolCategory, 'other'>, { rank: number; stage: Stage }> = {
  read: { rank: 1, stage: 'understand' },
  edit: { rank: 2, stage: 'modify' },
  test: { rank: 3, stage: 'test' },
};

/** Furthest stage reached in the current turn. `review` once the turn has ended with file changes. */
export function inferStage(s: { categories: ToolCategory[]; turnEnded: boolean; changedFiles: number }): Stage | null {
  if (s.categories.length === 0) return null;
  if (s.turnEnded && s.changedFiles > 0) return 'review';
  let best: { rank: number; stage: Stage } = { rank: 0, stage: 'understand' };
  for (const c of s.categories) {
    if (c === 'other') continue;
    const r = RANK[c];
    if (r.rank > best.rank) best = r;
  }
  return best.stage;
}
```

Add to `packages/core/src/index.ts`:
```ts
export * from './claude/registry.ts';
export * from './derive/stage.ts';
export * from './derive/tests.ts';
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm vitest run packages/core`
Expected: PASS (all core tests)

- [ ] **Step 7: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add packages/core
git commit -m "feat(core): parse session registry and test output, infer work stage"
```

---

### Task 4: core — live transcript reducer and status derivation

**Files:**
- Create: `packages/core/src/derive/live-transcript.ts`, `packages/core/src/derive/live-transcript.test.ts`
- Create: `packages/core/src/derive/live-status.ts`, `packages/core/src/derive/live-status.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `classifyClaudeRecord`, `contentText` (P0); `categorizeTool`, `inferStage`, `isTestCommand`, `parseTestOutput`, `RegistryStatus` (Task 3); `redact` (P0)
- Produces: `TranscriptLive`, `LiveReducerEffects`, `LiveReducer`, `emptyTranscriptLive()`, `createLiveReducer(opts?)`, `DeriveStatusInput`, `deriveLiveStatus(i)`, `splitPk(pk)` (exact signatures in "Contract additions")

Heuristics (documented in the code):
- `backgroundJobs`: background shells that are still running. A `Bash` with `input.run_in_background === true` registers the shell id parsed from its tool result (`ID: <id>`). The shell is removed by `KillShell`/`KillBash` (`input.shell_id`), or by a `BashOutput` result containing `<status>completed|killed|failed</status>`.
- `runningSubagents`: foreground `Agent`/`Task` tool_uses without a tool_result yet.
- `contextFill`: `(input + cacheRead + cacheWrite) / contextWindow` of the last real assistant usage. The default window is 200 000; the LiveTracker passes 1 000 000 when the model id ends with `[1m]`.
- The turn ends at `system` `turn_duration` or `stop_hook_summary`.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/derive/live-transcript.test.ts`
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJsonLine } from '../io/jsonl-tail.ts';
import { FIXTURES_DIR } from '../test-utils/fixtures.ts';
import { createLiveReducer, emptyTranscriptLive } from './live-transcript.ts';

const lines = (name: string) =>
  readFileSync(join(FIXTURES_DIR, 'claude-home/projects/-Users-test-Wakecap', name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(parseJsonLine);

const u = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user', uuid, parentUuid: null, sessionId: 's', timestamp: '2026-09-01T10:00:00.000Z', message: { role: 'user', content }, ...extra,
});
const a = (uuid: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant', uuid, parentUuid: null, sessionId: 's', timestamp: '2026-09-01T10:00:01.000Z',
  message: { id: `m-${uuid}`, role: 'assistant', model: 'claude-opus-5', content, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  ...extra,
});

describe('createLiveReducer', () => {
  it('starts empty', () => {
    expect(createLiveReducer().snapshot()).toEqual(emptyTranscriptLive());
  });

  it('tracks the first turn of s-basic up to review', () => {
    const r = createLiveReducer();
    const all = lines('s-basic.jsonl');
    const effects = all.slice(0, 7).map((v) => r.apply(v));
    expect(effects[3]?.testRecorded).toEqual({
      ts: '2026-09-01T09:00:30.000Z', command: 'pnpm vitest run', passed: 18, failed: 0, skipped: 0, durationMs: 1400,
    });
    expect(effects[6]?.turnEnded).toBe(1);
    const s = r.snapshot();
    expect(s).toMatchObject({
      turn: 1,
      lastPrompt: 'check the notification service tests',
      currentTool: 'Edit',
      stage: 'review',
      turnEnded: true,
      turnChangedFiles: ['/Users/test/Wakecap/Backend/svc/a.ts'],
      permissionMode: 'bypassPermissions',
    });
  });

  it('resets per turn and keeps the last test', () => {
    const r = createLiveReducer();
    for (const v of lines('s-basic.jsonl')) r.apply(v);
    const s = r.snapshot();
    expect(s.turn).toBe(3);
    expect(s.lastPrompt).toBe('/review the change');
    expect(s.turnEnded).toBe(false);
    expect(s.stage).toBeNull();
    expect(s.turnChangedFiles).toEqual([]);
    expect(s.lastTest?.passed).toBe(18);
    expect(s.contextFill).toBeCloseTo(1105 / 200_000, 6);
  });

  it('records API errors and ignores non-JSON lines', () => {
    const r = createLiveReducer();
    for (const v of lines('s-errors.jsonl')) r.apply(v);
    r.apply(undefined);
    expect(r.snapshot().lastApiError).toBe('API Error: 529 overloaded');
  });

  it('counts running subagents until their result arrives', () => {
    const r = createLiveReducer();
    for (const v of lines('s-subagents.jsonl')) r.apply(v);
    expect(r.snapshot().runningSubagents).toBe(1);
    r.apply(u('r1', [{ type: 'tool_result', tool_use_id: 'gtu1', content: 'done' }], { toolUseResult: {} }));
    expect(r.snapshot().runningSubagents).toBe(0);
  });

  it('counts background shells until they complete or are killed', () => {
    const r = createLiveReducer();
    r.apply(u('p', 'start the servers'));
    r.apply(a('a1', [
      { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pnpm dev', run_in_background: true } },
      { type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'pnpm worker', run_in_background: true } },
    ]));
    r.apply(u('r1', [
      { type: 'tool_result', tool_use_id: 'b1', content: 'Command running in background with ID: sh_1' },
      { type: 'tool_result', tool_use_id: 'b2', content: 'Command running in background with ID: sh_2' },
    ], { toolUseResult: {} }));
    expect(r.snapshot().backgroundJobs).toBe(2);
    r.apply(a('a2', [
      { type: 'tool_use', id: 'o1', name: 'BashOutput', input: { bash_id: 'sh_1' } },
      { type: 'tool_use', id: 'k1', name: 'KillShell', input: { shell_id: 'sh_2' } },
    ]));
    expect(r.snapshot().backgroundJobs).toBe(1);
    r.apply(u('r2', [{ type: 'tool_result', tool_use_id: 'o1', content: '<status>completed</status>' }], { toolUseResult: {} }));
    expect(r.snapshot().backgroundJobs).toBe(0);
  });

  it('counts PR links in the current turn and records failing tests', () => {
    const r = createLiveReducer();
    r.apply(u('p', 'ship it'));
    r.apply(a('a1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } }]));
    const eff = r.apply(u('r1', [{ type: 'tool_result', tool_use_id: 't1', content: '      Tests  2 failed | 5 passed (7)' }], { toolUseResult: {} }));
    expect(eff.testRecorded?.failed).toBe(2);
    r.apply({ type: 'pr-link', prNumber: 1, prUrl: 'https://github.com/example-org/r/pull/1', prRepository: 'example-org/r', sessionId: 's' });
    r.apply({ type: 'system', subtype: 'stop_hook_summary', uuid: 'x', parentUuid: null, sessionId: 's', timestamp: '2026-09-01T10:00:05.000Z' });
    expect(r.snapshot()).toMatchObject({ turnPrs: 1, turnEnded: true, stage: 'test' });
  });

  it('uses the configured context window', () => {
    const r = createLiveReducer({ contextWindow: 1000 });
    r.apply(a('a1', [{ type: 'text', text: 'hi' }], {}));
    const big = a('a2', [{ type: 'text', text: 'hi' }]);
    big.message.usage = { input_tokens: 400, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 };
    r.apply(big);
    expect(r.snapshot().contextFill).toBe(1);
  });
});
```

`packages/core/src/derive/live-status.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { emptyTranscriptLive } from './live-transcript.ts';
import { deriveLiveStatus, splitPk } from './live-status.ts';

const t = (over: Partial<ReturnType<typeof emptyTranscriptLive>> = {}) => ({ ...emptyTranscriptLive(), ...over });

describe('deriveLiveStatus', () => {
  it('is ended when the process is dead', () => {
    expect(deriveLiveStatus({ alive: false, registryStatus: 'waiting', transcript: t() })).toBe('ended');
  });
  it('passes through busy, waiting and shell', () => {
    expect(deriveLiveStatus({ alive: true, registryStatus: 'busy', transcript: t({ lastApiError: 'x' }) })).toBe('busy');
    expect(deriveLiveStatus({ alive: true, registryStatus: 'waiting', transcript: t() })).toBe('waiting');
    expect(deriveLiveStatus({ alive: true, registryStatus: 'shell', transcript: t() })).toBe('shell');
  });
  it('derives error, review and idle when idle', () => {
    expect(deriveLiveStatus({ alive: true, registryStatus: 'idle', transcript: t({ lastApiError: 'API Error: 529' }) })).toBe('error');
    expect(deriveLiveStatus({ alive: true, registryStatus: 'idle', transcript: t({ turnEnded: true, turnChangedFiles: ['a.ts'] }) })).toBe('review');
    expect(deriveLiveStatus({ alive: true, registryStatus: 'idle', transcript: t({ turnEnded: true, turnPrs: 1 }) })).toBe('review');
    expect(deriveLiveStatus({ alive: true, registryStatus: 'idle', transcript: t({ turnEnded: true }) })).toBe('idle');
    expect(deriveLiveStatus({ alive: true, registryStatus: null, transcript: t() })).toBe('idle');
  });
});

describe('splitPk', () => {
  it('splits on the first colon only', () => {
    expect(splitPk('claude:s-basic')).toEqual({ source: 'claude', id: 's-basic' });
    expect(splitPk('agnc:a:b')).toEqual({ source: 'agnc', id: 'a:b' });
    expect(() => splitPk('bogus')).toThrow(/invalid session pk/);
    expect(() => splitPk('cursor:x')).toThrow(/invalid session pk/);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run packages/core/src/derive/live-transcript.test.ts packages/core/src/derive/live-status.test.ts`
Expected: FAIL, `Cannot find module './live-transcript.ts'`

- [ ] **Step 3: Implement the reducer**

`packages/core/src/derive/live-transcript.ts`
```ts
import { classifyClaudeRecord, contentText } from '../claude/records.ts';
import { redact } from '../redact/redact.ts';
import type { Stage, TestResult } from '../types/index.ts';
import { type ToolCategory, categorizeTool, inferStage } from './stage.ts';
import { isTestCommand, parseTestOutput } from './tests.ts';

export interface TranscriptLive {
  turn: number;
  lastPrompt: string | null;
  currentTool: string | null;
  stage: Stage | null;
  backgroundJobs: number;
  runningSubagents: number;
  contextFill: number | null;
  lastTest: TestResult | null;
  turnEnded: boolean;
  turnChangedFiles: string[];
  turnPrs: number;
  lastApiError: string | null;
  permissionMode: string | null;
  lastActivityAt: string | null;
}

export interface LiveReducerEffects {
  testRecorded: TestResult | null;
  turnEnded: number | null;
}

export interface LiveReducer {
  apply(value: unknown): LiveReducerEffects;
  snapshot(): TranscriptLive;
}

export const emptyTranscriptLive = (): TranscriptLive => ({
  turn: 0,
  lastPrompt: null,
  currentTool: null,
  stage: null,
  backgroundJobs: 0,
  runningSubagents: 0,
  contextFill: null,
  lastTest: null,
  turnEnded: false,
  turnChangedFiles: [],
  turnPrs: 0,
  lastApiError: null,
  permissionMode: null,
  lastActivityAt: null,
});

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const TURN_END = new Set(['turn_duration', 'stop_hook_summary']);

interface Pending { name: string; command: string | null; backgroundShell: boolean; watchShell: string | null }

export function createLiveReducer(opts: { contextWindow?: number } = {}): LiveReducer {
  const contextWindow = opts.contextWindow ?? 200_000;
  const s = emptyTranscriptLive();
  let categories: ToolCategory[] = [];
  const changed = new Set<string>();
  const pending = new Map<string, Pending>();
  const pendingAgents = new Set<string>();
  const shells = new Set<string>();

  const recompute = () => {
    s.turnChangedFiles = [...changed];
    s.stage = inferStage({ categories, turnEnded: s.turnEnded, changedFiles: changed.size });
    s.runningSubagents = pendingAgents.size;
    s.backgroundJobs = shells.size;
  };

  const resultText = (block: Obj): string => {
    const c = block.content;
    return typeof c === 'string' ? c : contentText(c);
  };

  return {
    apply(value: unknown): LiveReducerEffects {
      const effects: LiveReducerEffects = { testRecorded: null, turnEnded: null };
      const c = classifyClaudeRecord(value);
      switch (c.kind) {
        case 'human_prompt': {
          s.turn += 1;
          s.lastPrompt = redact(c.text).slice(0, 500);
          s.turnEnded = false;
          s.turnPrs = 0;
          s.lastApiError = null;
          s.lastActivityAt = c.rec.timestamp;
          categories = [];
          changed.clear();
          const mode = isObj(value) ? str(value.permissionMode) : null;
          if (mode) s.permissionMode = mode;
          break;
        }
        case 'assistant': {
          const msg = c.rec.message;
          s.lastActivityAt = c.rec.timestamp;
          if (c.rec.isApiErrorMessage === true) {
            s.lastApiError = redact(contentText(msg?.content)).slice(0, 300) || 'API error';
            break;
          }
          s.lastApiError = null;
          if (msg?.usage && msg.model !== '<synthetic>') {
            const u = msg.usage;
            const used = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
            s.contextFill = Math.min(1, used / contextWindow);
          }
          const content = msg?.content;
          const blocks: unknown[] = Array.isArray(content) ? content : [];
          for (const b of blocks) {
            if (!isObj(b) || b.type !== 'tool_use') continue;
            const name = str(b.name) ?? 'unknown';
            const id = str(b.id) ?? '';
            const input = isObj(b.input) ? b.input : {};
            s.currentTool = name;
            categories.push(categorizeTool(name, input));
            if (EDIT_TOOLS.has(name)) {
              const fp = str(input.file_path) ?? str(input.notebook_path);
              if (fp) changed.add(fp);
            }
            if (AGENT_TOOLS.has(name) && input.run_in_background !== true) pendingAgents.add(id);
            if (name === 'KillShell' || name === 'KillBash') {
              const sid = str(input.shell_id) ?? str(input.bash_id);
              if (sid) shells.delete(sid);
            }
            const command = name === 'Bash' ? str(input.command) : null;
            pending.set(id, {
              name,
              command: command && isTestCommand(command) ? command : null,
              backgroundShell: name === 'Bash' && input.run_in_background === true,
              watchShell: name === 'BashOutput' ? (str(input.bash_id) ?? str(input.shell_id)) : null,
            });
          }
          break;
        }
        case 'tool_result': {
          s.lastActivityAt = c.rec.timestamp;
          const content = c.rec.message?.content;
          const blocks: unknown[] = Array.isArray(content) ? content : [];
          for (const b of blocks) {
            if (!isObj(b) || b.type !== 'tool_result') continue;
            const id = str(b.tool_use_id) ?? '';
            pendingAgents.delete(id);
            const p = pending.get(id);
            pending.delete(id);
            if (!p) continue;
            const text = resultText(b);
            if (p.command) {
              const r = parseTestOutput(redact(p.command), text, c.rec.timestamp);
              if (r) {
                s.lastTest = r;
                effects.testRecorded = r;
              }
            }
            if (p.backgroundShell) {
              const m = /ID:\s*([A-Za-z0-9_-]+)/.exec(text);
              if (m?.[1]) shells.add(m[1]);
            }
            if (p.watchShell && /<status>(?:completed|killed|failed)<\/status>/.test(text)) shells.delete(p.watchShell);
          }
          break;
        }
        case 'system': {
          if (c.subtype && TURN_END.has(c.subtype) && !s.turnEnded && s.turn > 0) {
            s.turnEnded = true;
            effects.turnEnded = s.turn;
          }
          break;
        }
        case 'session_meta': {
          if (c.type === 'pr-link') s.turnPrs += 1;
          if (c.type === 'permission-mode' || c.type === 'mode') {
            const mode = str(c.rec.permissionMode) ?? str(c.rec.mode);
            if (mode) s.permissionMode = mode;
          }
          break;
        }
        default:
          break;
      }
      recompute();
      return effects;
    },
    snapshot(): TranscriptLive {
      return { ...s, turnChangedFiles: [...s.turnChangedFiles], lastTest: s.lastTest ? { ...s.lastTest } : null };
    },
  };
}
```

Note on the `stop_hook_summary` test: it expects `stage: 'test'`. The turn has no file changes, so `inferStage` returns the furthest stage (`test`), not `review`.

Note on "uses the configured context window": the first record (`a1`) sets `contextFill` to `1/1000`. The second sets it to `min(1, 1300/1000) = 1`.

- [ ] **Step 4: Implement status derivation**

`packages/core/src/derive/live-status.ts`
```ts
import type { RegistryStatus } from '../claude/registry.ts';
import type { LiveStatus, Source } from '../types/index.ts';
import type { TranscriptLive } from './live-transcript.ts';

export interface DeriveStatusInput {
  alive: boolean;
  registryStatus: RegistryStatus | null;
  transcript: TranscriptLive;
}

/**
 * Precedence: ended > waiting/busy/shell (from the registry or a hook) > error > review > idle.
 * `blocked` needs goals, so it arrives in Phase 5.
 */
export function deriveLiveStatus(i: DeriveStatusInput): LiveStatus {
  if (!i.alive) return 'ended';
  if (i.registryStatus === 'waiting' || i.registryStatus === 'busy' || i.registryStatus === 'shell') return i.registryStatus;
  if (i.transcript.lastApiError) return 'error';
  if (i.transcript.turnEnded && (i.transcript.turnChangedFiles.length > 0 || i.transcript.turnPrs > 0)) return 'review';
  return 'idle';
}

const SOURCES = new Set<string>(['claude', 'codex', 'agnc']);

export function splitPk(pk: string): { source: Source; id: string } {
  const at = pk.indexOf(':');
  const source = at > 0 ? pk.slice(0, at) : '';
  const id = at > 0 ? pk.slice(at + 1) : '';
  if (!SOURCES.has(source) || !id) throw new Error(`invalid session pk: ${pk}`);
  return { source: source as Source, id };
}
```

Add to `packages/core/src/index.ts`:
```ts
export * from './derive/live-status.ts';
export * from './derive/live-transcript.ts';
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run packages/core`
Expected: PASS (all core tests)

- [ ] **Step 6: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add packages/core
git commit -m "feat(core): reduce transcript tail to live state and derive live status"
```

---

### Task 5: daemon — pid liveness and registry watcher

**Files:**
- Create: `apps/daemon/src/live/liveness.ts`, `apps/daemon/src/live/liveness.test.ts`
- Create: `apps/daemon/src/live/registry-watcher.ts`, `apps/daemon/src/live/registry-watcher.test.ts`
- Modify: `apps/daemon/package.json` (make sure `chokidar` and `execa` are dependencies)

**Interfaces:**
- Consumes: `parseRegistryEntry`, `isRegistryFileName`, `RegistryEntry` (Task 3); `FIXTURES_DIR` equivalent path (`fixtures/claude-home/sessions/41001.json`)
- Produces:
  ```ts
  // live/liveness.ts
  export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>
  export const defaultExec: ExecFn
  export function normalizeProcStart(s: string): string
  export interface LivenessChecker { isAlive(pid: number, procStart: string | null): Promise<boolean> }
  export function createLivenessChecker(opts?: { exec?: ExecFn; kill?: (pid: number, signal: 0) => void; reverifyMs?: number; now?: () => number }): LivenessChecker
  // live/registry-watcher.ts
  export interface RegistrySnapshot { file: string; entry: RegistryEntry }
  export type RegistryChange = { kind: 'upsert'; snap: RegistrySnapshot } | { kind: 'remove'; file: string }
  export interface RegistryWatcher { start(): Promise<void>; stop(): Promise<void>; rescan(): Promise<void>; current(): RegistrySnapshot[]; onChange(fn: (c: RegistryChange) => void): () => void }
  export function createRegistryWatcher(opts: { dir: string; pollMs?: number; watch?: boolean; readText?: (path: string) => Promise<string>; log?: { debug(o: object, msg?: string): void } }): RegistryWatcher
  ```

**Liveness rule** (docs/04 A1): `process.kill(pid, 0)` must succeed or fail with `EPERM`, **and** `ps -o lstart= -p <pid>` must equal the registry `procStart` (after whitespace normalisation), because pids get reused. A pid/procStart pair that passed is trusted for `reverifyMs` (default 30 s) with only the cheap `kill(0)` check, so the 1 s poll doesn't spawn `ps` for every session every second. If spike S3 recorded a different `procStart` format, adapt `normalizeProcStart` and add that format to the test.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/live/liveness.test.ts`
```ts
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { type ExecFn, createLivenessChecker, normalizeProcStart } from './liveness.ts';

const errno = (code: string) => Object.assign(new Error(code), { code });

describe('createLivenessChecker', () => {
  it('is dead when kill(0) fails with ESRCH', async () => {
    const exec = vi.fn<ExecFn>();
    const c = createLivenessChecker({ exec, kill: () => { throw errno('ESRCH'); } });
    expect(await c.isAlive(123, 'Mon Sep  1 09:00:00 2026')).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('treats EPERM as alive and then checks procStart', async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue({ stdout: 'Mon Sep 1 09:00:00 2026\n', exitCode: 0 });
    const c = createLivenessChecker({ exec, kill: () => { throw errno('EPERM'); } });
    expect(await c.isAlive(123, 'Mon Sep  1 09:00:00 2026')).toBe(true);
    expect(exec).toHaveBeenCalledWith('ps', ['-o', 'lstart=', '-p', '123']);
  });

  it('is dead when the pid was reused (procStart differs) or ps finds nothing', async () => {
    const exec = vi
      .fn<ExecFn>()
      .mockResolvedValueOnce({ stdout: 'Tue Sep  2 10:00:00 2026', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', exitCode: 1 });
    const c = createLivenessChecker({ exec, kill: () => undefined });
    expect(await c.isAlive(5, 'Mon Sep  1 09:00:00 2026')).toBe(false);
    expect(await c.isAlive(6, 'Mon Sep  1 09:00:00 2026')).toBe(false);
  });

  it('skips the procStart check when the registry has none', async () => {
    const exec = vi.fn<ExecFn>();
    const c = createLivenessChecker({ exec, kill: () => undefined });
    expect(await c.isAlive(7, null)).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it('caches a verified pair for reverifyMs', async () => {
    let now = 0;
    const exec = vi.fn<ExecFn>().mockResolvedValue({ stdout: 'Mon Sep  1 09:00:00 2026', exitCode: 0 });
    const c = createLivenessChecker({ exec, kill: () => undefined, reverifyMs: 1000, now: () => now });
    await c.isAlive(8, 'Mon Sep  1 09:00:00 2026');
    now = 999;
    await c.isAlive(8, 'Mon Sep  1 09:00:00 2026');
    expect(exec).toHaveBeenCalledTimes(1);
    now = 1000;
    await c.isAlive(8, 'Mon Sep  1 09:00:00 2026');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('recognises the current process with the real ps', async () => {
    const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    const c = createLivenessChecker();
    expect(await c.isAlive(process.pid, lstart)).toBe(true);
    expect(await c.isAlive(process.pid, 'Thu Jan  1 00:00:00 1970')).toBe(false);
  });

  it('normalises whitespace', () => {
    expect(normalizeProcStart('  Mon Sep  1 09:00:00 2026\n')).toBe('Mon Sep 1 09:00:00 2026');
  });
});
```

`apps/daemon/src/live/registry-watcher.test.ts`
```ts
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RegistryChange, type RegistryWatcher, createRegistryWatcher } from './registry-watcher.ts';

const FIXTURE = fileURLToPath(new URL('../../../../fixtures/claude-home/sessions/41001.json', import.meta.url));
let dir: string;
let w: RegistryWatcher | null = null;
const readText = vi.fn((p: string) => readFile(p, 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orc-reg-'));
  readText.mockClear();
});
afterEach(async () => {
  await w?.stop();
  w = null;
});

const entry = (status: string) =>
  JSON.stringify({ pid: 41002, procStart: 'x', sessionId: 's-two', cwd: '/Users/test/Wakecap', status });

describe('createRegistryWatcher (rescan)', () => {
  it('reads <pid>.json files, never *.key files, and reports changes', async () => {
    copyFileSync(FIXTURE, join(dir, '41001.json'));
    writeFileSync(join(dir, '41001.abcdef.key'), 'SECRET');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    w = createRegistryWatcher({ dir, watch: false, readText });
    const changes: RegistryChange[] = [];
    w.onChange((c) => changes.push(c));
    await w.rescan();
    expect(w.current().map((s) => s.entry.sessionId)).toEqual(['s-basic']);
    expect(changes).toHaveLength(1);
    expect(readText.mock.calls.map((c) => c[0])).toEqual([join(dir, '41001.json')]);

    await w.rescan();
    expect(changes).toHaveLength(1);

    writeFileSync(join(dir, '41002.json'), entry('busy'));
    await w.rescan();
    writeFileSync(join(dir, '41002.json'), entry('idle'));
    await w.rescan();
    expect(changes.filter((c) => c.kind === 'upsert')).toHaveLength(3);
    expect(w.current().find((s) => s.entry.pid === 41002)?.entry.status).toBe('idle');

    rmSync(join(dir, '41001.json'));
    await w.rescan();
    expect(changes.at(-1)).toEqual({ kind: 'remove', file: join(dir, '41001.json') });
    expect(readText.mock.calls.every((c) => !String(c[0]).endsWith('.key'))).toBe(true);
  });

  it('keeps the previous entry when a partial write is seen', async () => {
    writeFileSync(join(dir, '41002.json'), entry('busy'));
    w = createRegistryWatcher({ dir, watch: false });
    await w.rescan();
    writeFileSync(join(dir, '41002.json'), '{"pid":41002,"sessionId":"s-tw');
    await w.rescan();
    expect(w.current()[0]?.entry.status).toBe('busy');
  });

  it('treats a missing directory as empty', async () => {
    w = createRegistryWatcher({ dir: join(dir, 'missing'), watch: false });
    await w.start();
    expect(w.current()).toEqual([]);
  });
});

describe('createRegistryWatcher (fs events)', () => {
  it('notices a new registry file within 2 s', async () => {
    w = createRegistryWatcher({ dir, pollMs: 60_000 });
    await w.start();
    const seen = vi.fn();
    w.onChange(seen);
    writeFileSync(join(dir, '41002.json'), entry('busy'));
    await vi.waitFor(() => expect(seen).toHaveBeenCalled(), { timeout: 2000, interval: 50 });
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/live/liveness.test.ts apps/daemon/src/live/registry-watcher.test.ts`
Expected: FAIL, `Cannot find module './liveness.ts'`

- [ ] **Step 3: Implement liveness**

Run: `pnpm --filter @orc/daemon add chokidar@^5.0.0 execa@^10.0.1` (it's a no-op if Phase 1 already added them).

`apps/daemon/src/live/liveness.ts`
```ts
import { execa } from 'execa';

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;

export const defaultExec: ExecFn = async (cmd, args) => {
  const r = await execa(cmd, args, { reject: false, env: { LC_ALL: 'C' }, timeout: 5000 });
  return { stdout: typeof r.stdout === 'string' ? r.stdout : '', exitCode: r.exitCode ?? 1 };
};

export function normalizeProcStart(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

export interface LivenessChecker {
  isAlive(pid: number, procStart: string | null): Promise<boolean>;
}

export function createLivenessChecker(
  opts: { exec?: ExecFn; kill?: (pid: number, signal: 0) => void; reverifyMs?: number; now?: () => number } = {},
): LivenessChecker {
  const exec = opts.exec ?? defaultExec;
  const kill = opts.kill ?? ((pid: number, signal: 0) => void process.kill(pid, signal));
  const reverifyMs = opts.reverifyMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const verified = new Map<number, { procStart: string; at: number }>();

  return {
    async isAlive(pid, procStart) {
      try {
        kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EPERM') {
          verified.delete(pid);
          return false;
        }
      }
      if (!procStart) return true;
      const want = normalizeProcStart(procStart);
      const hit = verified.get(pid);
      if (hit && hit.procStart === want && now() - hit.at < reverifyMs) return true;
      const r = await exec('ps', ['-o', 'lstart=', '-p', String(pid)]);
      const got = r.exitCode === 0 ? normalizeProcStart(r.stdout) : '';
      if (got !== '' && got === want) {
        verified.set(pid, { procStart: want, at: now() });
        return true;
      }
      verified.delete(pid);
      return false;
    },
  };
}
```

- [ ] **Step 4: Implement the registry watcher**

`apps/daemon/src/live/registry-watcher.ts`
```ts
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type RegistryEntry, isRegistryFileName, parseRegistryEntry } from '@orc/core';
import { type FSWatcher, watch as chokidarWatch } from 'chokidar';

export interface RegistrySnapshot {
  file: string;
  entry: RegistryEntry;
}
export type RegistryChange = { kind: 'upsert'; snap: RegistrySnapshot } | { kind: 'remove'; file: string };

export interface RegistryWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  rescan(): Promise<void>;
  current(): RegistrySnapshot[];
  onChange(fn: (c: RegistryChange) => void): () => void;
}

export function createRegistryWatcher(opts: {
  dir: string;
  pollMs?: number;
  watch?: boolean;
  readText?: (path: string) => Promise<string>;
  log?: { debug(o: object, msg?: string): void };
}): RegistryWatcher {
  const readText = opts.readText ?? ((p: string) => readFile(p, 'utf8'));
  const snaps = new Map<string, { snap: RegistrySnapshot; raw: string }>();
  const listeners = new Set<(c: RegistryChange) => void>();
  let fsw: FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;

  const emit = (c: RegistryChange) => {
    for (const fn of listeners) fn(c);
  };

  async function readOne(file: string): Promise<void> {
    if (!isRegistryFileName(basename(file))) return; // never touches *.key
    let raw: string;
    try {
      raw = await readText(file);
    } catch {
      return; // vanished between listing and reading; the next rescan reports the removal
    }
    if (snaps.get(file)?.raw === raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      opts.log?.debug({ file }, 'registry file not parseable yet (partial write)');
      return;
    }
    const entry = parseRegistryEntry(parsed);
    if (!entry) return;
    const snap = { file, entry };
    snaps.set(file, { snap, raw });
    emit({ kind: 'upsert', snap });
  }

  function removeOne(file: string): void {
    if (snaps.delete(file)) emit({ kind: 'remove', file });
  }

  async function rescan(): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(opts.dir);
    } catch {
      names = [];
    }
    const files = names.filter(isRegistryFileName).map((n) => join(opts.dir, n));
    const present = new Set(files);
    for (const f of files) await readOne(f);
    for (const f of [...snaps.keys()]) if (!present.has(f)) removeOne(f);
  }

  return {
    async start() {
      await rescan();
      if (opts.watch !== false) {
        fsw = chokidarWatch(opts.dir, {
          ignoreInitial: true,
          depth: 0,
          ignored: (p: string, stats?: { isFile(): boolean }) => stats?.isFile() === true && !isRegistryFileName(basename(p)),
        });
        fsw.on('add', (p: string) => void readOne(p));
        fsw.on('change', (p: string) => void readOne(p));
        fsw.on('unlink', (p: string) => removeOne(p));
        fsw.on('error', (err: unknown) => opts.log?.debug({ err: String(err) }, 'registry watcher error'));
      }
      timer = setInterval(() => void rescan(), opts.pollMs ?? 2000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await fsw?.close();
      fsw = null;
    },
    rescan,
    current: () => [...snaps.values()].map((v) => v.snap),
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/live/liveness.test.ts apps/daemon/src/live/registry-watcher.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 6: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon/src/live apps/daemon/package.json pnpm-lock.yaml
git commit -m "feat(daemon): watch the Claude session registry and verify pid liveness"
```

---

### Task 6: daemon — Codex live process detection

**Files:**
- Create: `apps/daemon/src/collectors/codex/live.ts`, `apps/daemon/src/collectors/codex/live.test.ts`

**Interfaces:**
- Consumes: `ExecFn`, `defaultExec` (Task 5); the fixture rollout `fixtures/codex-home/sessions/2026/09/01/rollout-2026-09-01T09-00-00-c0dex000-0000-0000-0000-000000000001.jsonl`
- Produces:
  ```ts
  export interface CodexLiveProc { pid: number; cwd: string; startedAtMs: number; rolloutPath: string | null; sessionId: string | null; originator: string | null; lastWriteMs: number | null }
  export interface CodexLiveDetector { scan(): Promise<CodexLiveProc[]> }
  export function createCodexLiveDetector(opts: { codexHome: string; exec?: ExecFn; now?: () => number; lookbackDays?: number }): CodexLiveDetector
  export function parsePsLine(line: string): { pid: number; startedAtMs: number; command: string } | null
  export function isCodexCommand(command: string): boolean
  export function readRolloutMeta(path: string): Promise<{ id: string | null; cwd: string | null; originator: string | null; startedAtMs: number | null }>
  ```

**Detection (spike S5):**
1. `ps -axo pid=,lstart=,command=` lists processes. Keep the ones whose executable is `codex`, or `node …/codex(.js)`. Skip the non-session subcommands `app-server`, `mcp-server`, `mcp`, `login`, `logout`, `completion`.
2. Read each process's cwd with `lsof -a -p <pid> -d cwd -Fn`.
3. Look for candidate rollouts under `~/.codex/sessions/YYYY/MM/DD`, for today and the previous `lookbackDays` days (both local and UTC dates). A rollout is a candidate when its `session_meta` cwd equals the process cwd and its mtime is at least the process start minus 2 s.
4. Pick among the candidates:
   - Prefer a rollout whose `session_meta.timestamp` is at least the process start minus 5 s, and closest to it (a new session).
   - Otherwise take the newest mtime (`codex resume` appends to an old rollout).
   - A rollout is claimed by at most one process.
5. The first line is read with a 1 MB cap, because `base_instructions` can be huge. If the line is longer than that, `cwd`, `id`, `originator` and `timestamp` are pulled out with a regex. The rest of the file is never read here.

Nothing in `~/.codex` is written, and `auth.json` is never opened (only `sessions/**/rollout-*.jsonl` files are opened).

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/collectors/codex/live.test.ts`
```ts
import { copyFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExecFn } from '../../live/liveness.ts';
import { createCodexLiveDetector, isCodexCommand, parsePsLine, readRolloutMeta } from './live.ts';

const FIXTURE = fileURLToPath(
  new URL(
    '../../../../../fixtures/codex-home/sessions/2026/09/01/rollout-2026-09-01T09-00-00-c0dex000-0000-0000-0000-000000000001.jsonl',
    import.meta.url,
  ),
);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const lstart = (d: Date) =>
  `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`;

const NOW = Date.parse('2026-09-01T09:05:20.000Z');
const T0 = new Date('2026-09-01T09:00:00.000Z');
const T1 = new Date('2026-09-01T09:05:00.000Z');
let home: string;
let dayDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orc-codex-'));
  const d = new Date(NOW);
  dayDir = join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  mkdirSync(dayDir, { recursive: true });
  const r1 = join(dayDir, 'rollout-a-c0dex000-0000-0000-0000-000000000001.jsonl');
  copyFileSync(FIXTURE, r1);
  utimesSync(r1, new Date(NOW - 10_000), new Date(NOW - 10_000));
  const r3 = join(dayDir, 'rollout-b-c0dex000-0000-0000-0000-000000000003.jsonl');
  writeFileSync(
    r3,
    `${JSON.stringify({ timestamp: T1.toISOString(), type: 'session_meta', payload: { id: 'c0dex-3', cwd: '/Users/test/Wakecap', originator: 'codex_cli_rs', base_instructions: 'x'.repeat(2_000_000) } })}\n`,
  );
  utimesSync(r3, new Date(NOW - 5_000), new Date(NOW - 5_000));
});

const fakeExec = (ps: string, cwds: Record<string, string | null>): ExecFn => async (cmd, args) => {
  if (cmd === 'ps') return { stdout: ps, exitCode: 0 };
  if (cmd === 'lsof') {
    const pid = args[args.indexOf('-p') + 1] ?? '';
    const cwd = cwds[pid];
    return cwd ? { stdout: `p${pid}\nfcwd\nn${cwd}\n`, exitCode: 0 } : { stdout: '', exitCode: 1 };
  }
  throw new Error(`unexpected ${cmd}`);
};

describe('parsePsLine / isCodexCommand', () => {
  it('parses pid, local start time and command', () => {
    const p = parsePsLine(`  4242 ${lstart(T0)} /opt/homebrew/bin/codex --model gpt-5.5`);
    expect(p).toEqual({ pid: 4242, startedAtMs: T0.getTime(), command: '/opt/homebrew/bin/codex --model gpt-5.5' });
    expect(parsePsLine('garbage')).toBeNull();
  });

  it.each([
    ['/opt/homebrew/bin/codex', true],
    ['codex resume abc', true],
    ['node /usr/local/lib/node_modules/@openai/codex/bin/codex.js exec "hi"', true],
    ['/Applications/Codex.app/codex app-server', false],
    ['codex mcp-server', false],
    ['/usr/bin/vim codex.md', false],
    ['node server.js', false],
  ])('%s → %s', (cmd, expected) => {
    expect(isCodexCommand(cmd)).toBe(expected);
  });
});

describe('readRolloutMeta', () => {
  it('reads a huge first line via the regex fallback', async () => {
    const m = await readRolloutMeta(join(dayDir, 'rollout-b-c0dex000-0000-0000-0000-000000000003.jsonl'));
    expect(m).toEqual({ id: 'c0dex-3', cwd: '/Users/test/Wakecap', originator: 'codex_cli_rs', startedAtMs: T1.getTime() });
  });
});

describe('createCodexLiveDetector', () => {
  it('matches each codex process to its own rollout', async () => {
    const ps = [
      `  100 ${lstart(T0)} codex`,
      `  200 ${lstart(T1)} /opt/homebrew/bin/codex`,
      `  300 ${lstart(T1)} node server.js`,
      `  400 ${lstart(T1)} codex app-server`,
      `  500 ${lstart(T1)} codex`,
    ].join('\n');
    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(ps, { '100': '/Users/test/Wakecap', '200': '/Users/test/Wakecap', '500': null }),
    });
    const out = await d.scan();
    expect(out.map((p) => [p.pid, p.sessionId])).toEqual([
      [100, 'c0dex000-0000-0000-0000-000000000001'],
      [200, 'c0dex-3'],
    ]);
    expect(out[0]).toMatchObject({ cwd: '/Users/test/Wakecap', originator: 'codex_exec', lastWriteMs: NOW - 10_000 });
  });

  it('reports a process without a rollout yet', async () => {
    const later = new Date(NOW + 60_000);
    const d = createCodexLiveDetector({
      codexHome: home,
      now: () => NOW,
      exec: fakeExec(`  700 ${lstart(later)} codex`, { '700': '/Users/test/Forza' }),
    });
    expect(await d.scan()).toEqual([
      { pid: 700, cwd: '/Users/test/Forza', startedAtMs: later.getTime(), rolloutPath: null, sessionId: null, originator: null, lastWriteMs: null },
    ]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/collectors/codex/live.test.ts`
Expected: FAIL, `Cannot find module './live.ts'`

- [ ] **Step 3: Implement the detector**

`apps/daemon/src/collectors/codex/live.ts`
```ts
import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type ExecFn, defaultExec } from '../../live/liveness.ts';

export interface CodexLiveProc {
  pid: number;
  cwd: string;
  startedAtMs: number;
  rolloutPath: string | null;
  sessionId: string | null;
  originator: string | null;
  lastWriteMs: number | null;
}

export interface CodexLiveDetector {
  scan(): Promise<CodexLiveProc[]>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PS_LINE = /^\s*(\d+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.+)$/;

export function parsePsLine(line: string): { pid: number; startedAtMs: number; command: string } | null {
  const m = PS_LINE.exec(line);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2] ?? '');
  if (month < 0) return null;
  const started = new Date(Number(m[7]), month, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return { pid: Number(m[1]), startedAtMs: started.getTime(), command: (m[8] ?? '').trim() };
}

const NON_SESSION = new Set(['app-server', 'mcp-server', 'mcp', 'login', 'logout', 'completion']);

export function isCodexCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  let i = 0;
  const first = basename(tokens[0] ?? '');
  if (first === 'node' || first === 'bun') i = 1;
  const exe = basename(tokens[i] ?? '');
  if (exe !== 'codex' && exe !== 'codex.js') return false;
  const sub = tokens[i + 1] ?? '';
  return !NON_SESSION.has(sub);
}

const pad = (n: number) => String(n).padStart(2, '0');
const unescapeJson = (s: string): string => {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
};
const field = (text: string, name: string): string | null => {
  const m = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  return m?.[1] !== undefined ? unescapeJson(m[1]) : null;
};

export async function readRolloutMeta(
  path: string,
): Promise<{ id: string | null; cwd: string | null; originator: string | null; startedAtMs: number | null }> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const nl = text.indexOf('\n');
    const line = nl >= 0 ? text.slice(0, nl) : text;
    try {
      const v = JSON.parse(line) as { timestamp?: string; payload?: { id?: string; cwd?: string; originator?: string } };
      return {
        id: v.payload?.id ?? null,
        cwd: v.payload?.cwd ?? null,
        originator: v.payload?.originator ?? null,
        startedAtMs: v.timestamp ? Date.parse(v.timestamp) : null,
      };
    } catch {
      const ts = field(line, 'timestamp');
      return { id: field(line, 'id'), cwd: field(line, 'cwd'), originator: field(line, 'originator'), startedAtMs: ts ? Date.parse(ts) : null };
    }
  } finally {
    await fh.close();
  }
}

interface Rollout { path: string; mtimeMs: number; id: string | null; cwd: string | null; originator: string | null; startedAtMs: number | null }

export function createCodexLiveDetector(opts: {
  codexHome: string;
  exec?: ExecFn;
  now?: () => number;
  lookbackDays?: number;
}): CodexLiveDetector {
  const exec = opts.exec ?? defaultExec;
  const now = opts.now ?? Date.now;
  const lookback = opts.lookbackDays ?? 2;
  const metaCache = new Map<string, Awaited<ReturnType<typeof readRolloutMeta>>>();

  function dayDirs(): string[] {
    const out = new Set<string>();
    for (let d = 0; d <= lookback; d++) {
      const t = new Date(now() - d * 86_400_000);
      out.add(join(opts.codexHome, 'sessions', String(t.getFullYear()), pad(t.getMonth() + 1), pad(t.getDate())));
      out.add(join(opts.codexHome, 'sessions', String(t.getUTCFullYear()), pad(t.getUTCMonth() + 1), pad(t.getUTCDate())));
    }
    return [...out];
  }

  async function recentRollouts(): Promise<Rollout[]> {
    const out: Rollout[] = [];
    for (const dir of dayDirs()) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.startsWith('rollout-') || !n.endsWith('.jsonl')) continue;
        const path = join(dir, n);
        try {
          const st = await stat(path);
          let meta = metaCache.get(path);
          if (!meta) {
            meta = await readRolloutMeta(path);
            metaCache.set(path, meta);
          }
          out.push({ path, mtimeMs: st.mtimeMs, ...meta });
        } catch {
          // the file disappeared; ignore it
        }
      }
    }
    return out;
  }

  async function cwdOf(pid: number): Promise<string | null> {
    const r = await exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    if (r.exitCode !== 0) return null;
    const line = r.stdout.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : null;
  }

  return {
    async scan() {
      const ps = await exec('ps', ['-axo', 'pid=,lstart=,command=']);
      const procs = ps.stdout
        .split('\n')
        .map(parsePsLine)
        .filter((p): p is NonNullable<typeof p> => p !== null && p.pid !== process.pid && isCodexCommand(p.command))
        .sort((a, b) => a.startedAtMs - b.startedAtMs || a.pid - b.pid);
      if (procs.length === 0) return [];
      const rollouts = await recentRollouts();
      const claimed = new Set<string>();
      const out: CodexLiveProc[] = [];
      for (const p of procs) {
        const cwd = await cwdOf(p.pid);
        if (!cwd) continue;
        const cands = rollouts.filter((r) => r.cwd === cwd && r.mtimeMs >= p.startedAtMs - 2000 && !claimed.has(r.path));
        const fresh = cands
          .filter((r) => r.startedAtMs !== null && r.startedAtMs >= p.startedAtMs - 5000)
          .sort((a, b) => Math.abs((a.startedAtMs ?? 0) - p.startedAtMs) - Math.abs((b.startedAtMs ?? 0) - p.startedAtMs));
        const pick = fresh[0] ?? cands.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
        if (pick) claimed.add(pick.path);
        out.push({
          pid: p.pid,
          cwd,
          startedAtMs: p.startedAtMs,
          rolloutPath: pick?.path ?? null,
          sessionId: pick?.id ?? null,
          originator: pick?.originator ?? null,
          lastWriteMs: pick?.mtimeMs ?? null,
        });
      }
      return out;
    },
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run apps/daemon/src/collectors/codex/live.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Check it against real processes (read-only, manual)**

Start `codex` in another terminal in any repo and send one prompt. Then run:
```bash
cd /Users/hazem/orchestrator && pnpm dlx tsx -e "import('./apps/daemon/src/collectors/codex/live.ts').then(async m => console.log(await m.createCodexLiveDetector({ codexHome: process.env.HOME + '/.codex' }).scan()))"
```
Expected: one entry with the right `cwd` and a non-null `sessionId`. Paste the output (session ids are fine; no prompt text is printed) into the review note.

- [ ] **Step 6: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon/src/collectors/codex
git commit -m "feat(daemon): detect live codex processes and match them to rollouts"
```

---

### Task 7: daemon — LiveTracker (status, ownership, transcript tail, events)

**Files:**
- Create: `apps/daemon/src/live/find-transcript.ts`, `apps/daemon/src/live/stub-session.ts`
- Create: `apps/daemon/src/live/live-tracker.ts`, `apps/daemon/src/live/live-tracker.test.ts`
- Create: `apps/daemon/test/fake-pty.ts`
- Modify: `apps/daemon/src/context.ts` (add `live?`, `launcher?`, `updateConfig?`, per the contract additions; `LaunchService` is imported as a type from `../services/launch.ts`, which Task 13 creates. Until then, add the `live?` field only.)

**Interfaces:**
- Consumes:
  - `DaemonContext`, `SessionService.getByPk/setLive`, `ProjectService.resolve`, `PtyManager.list`, `EventBus` (P1 / contracts §6, §7, §11)
  - `sessionPk` (P1 `services/sessions.ts`)
  - `createLiveReducer`, `deriveLiveStatus`, `readJsonlFrom`, `parseJsonLine`, `redact`, `emptyUsage` (core)
  - `RegistryWatcher` (Task 5), `LivenessChecker` (Task 5), `CodexLiveDetector` (Task 6)
  - `insertTestResult`, `latestTestResult` (Task 1)
  - Test helpers `useTempHomes(): () => OrcPaths` and `createTestContext(overrides?: Partial<DaemonContext>): DaemonContext` (assumed P1, see the table at the top)
- Produces:
  ```ts
  // live/find-transcript.ts
  export function createTranscriptFinder(claudeHome: string): (sessionId: string) => string | null
  // live/stub-session.ts
  export function stubSession(i: { source: Source; id: string; cwd: string; startedAt: string; projectId: string | null; name: string | null }): Session
  // live/live-tracker.ts
  export interface HookEvent { sessionId: string; event: string; message: string | null; ts: string }
  export function mapHookToStatus(event: string): RegistryStatus | null
  export interface LiveTracker { start(): Promise<void>; stop(): Promise<void>; refresh(): Promise<void>; list(): Session[]; get(pk: string): Session | null; waitForPid(pid: number, timeoutMs: number): Promise<string | null>; applyHook(e: HookEvent): void }
  export interface LiveTrackerDeps { registry: RegistryWatcher; liveness: LivenessChecker; codex: CodexLiveDetector; now?: () => Date; findTranscript?: (sessionId: string) => string | null }
  export function createLiveTracker(ctx: DaemonContext, deps: LiveTrackerDeps): LiveTracker
  // test/fake-pty.ts
  export function createFakePty(initial?: PtyInfo[]): PtyManager & { infos: PtyInfo[]; spawned: Array<Parameters<PtyManager['spawn']>[0]>; killed: Array<{ id: string; signal?: NodeJS.Signals }> }
  ```
- Events emitted:
  - `session.updated` (merged session) on every visible change. For indexed sessions, `sessions.setLive` is also called, which persists the state and emits too; the second event carries the merged fields and wins in the UI cache.
  - `session.statusChanged` (after the update is published)
  - `session.turnEnded`
  - `tests.recorded` (after the row is inserted)
  - `session.removed` once an ended session is older than `config.live.endedRetentionMin`

**Rules:**
- **Initial catch-up:** on the first pass after `start()`, transcripts are read to the end without emitting `tests.recorded` or `session.turnEnded`. Old history must not raise inbox items. Test rows are still inserted. Entries first seen after that pass emit normally.
- **Hook override:** a hook status wins only while it is newer than the registry's `statusUpdatedAt`.
- **Ownership:** a session is `owned` when a PTY that hasn't exited has `pid === entry.pid` or `sessionPk === pk`.
- **Codex:**
  - A process is `busy` when its rollout was written within `config.live.codexBusyWindowMs`, and `idle` otherwise.
  - Processes without a matched rollout are skipped.
  - `originator: codex_sdk_ts` is skipped unless `config.codex.showAutomated`.
- **Ended entries:** an entry that has been ended for longer than the retention window is dropped and remembered by pid. A stale registry file for the same pid therefore doesn't bring the card back, and the app never deletes that file.

- [ ] **Step 1: Write the fake PTY helper**

`apps/daemon/test/fake-pty.ts`
```ts
import type { PtyInfo, PtyManager } from '../src/pty/pty-manager.ts';

export function createFakePty(initial: PtyInfo[] = []): PtyManager & {
  infos: PtyInfo[];
  spawned: Array<Parameters<PtyManager['spawn']>[0]>;
  killed: Array<{ id: string; signal?: NodeJS.Signals }>;
} {
  const infos = [...initial];
  const spawned: Array<Parameters<PtyManager['spawn']>[0]> = [];
  const killed: Array<{ id: string; signal?: NodeJS.Signals }> = [];
  let next = 90000;
  return {
    infos,
    spawned,
    killed,
    spawn(opts) {
      spawned.push(opts);
      const info: PtyInfo = {
        id: `pty-${infos.length + 1}`,
        sessionPk: opts.sessionPk ?? null,
        command: opts.command,
        args: opts.args,
        cwd: opts.cwd,
        pid: next++,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
        cols: opts.cols ?? 120,
        rows: opts.rows ?? 36,
      };
      infos.push(info);
      return info;
    },
    write() {},
    async sendText() {},
    resize() {},
    kill(id, signal) {
      killed.push({ id, signal });
      const i = infos.find((p) => p.id === id);
      if (i) i.exitedAt = new Date().toISOString();
    },
    attach() {
      return { scrollback: '', detach() {} };
    },
    list: () => infos,
    get: (id) => infos.find((p) => p.id === id),
  };
}
```

- [ ] **Step 2: Write the failing tracker test**

`apps/daemon/src/live/live-tracker.test.ts`
```ts
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrcConfig } from '@orc/api-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePty } from '../../test/fake-pty.ts';
import { createTestContext, useTempHomes } from '../../test/helpers.ts';
import type { CodexLiveProc } from '../collectors/codex/live.ts';
import type { DaemonContext } from '../context.ts';
import { latestTestResult } from '../db/repos/test-results.ts';
import type { BusEvent } from './event-bus.ts';
import { type LiveTracker, createLiveTracker, mapHookToStatus } from './live-tracker.ts';
import { createRegistryWatcher } from './registry-watcher.ts';

const homes = useTempHomes();
let ctx: DaemonContext;
let tracker: LiveTracker;
let events: BusEvent[];
let alive: Set<number>;
let codexProcs: CodexLiveProc[];
let nowMs: number;
let pty: ReturnType<typeof createFakePty>;
let cfg: OrcConfig;

const T0 = Date.parse('2026-09-01T09:10:00.000Z');
const reg = (pid: number, sessionId: string, status: string, at: number, extra: Record<string, unknown> = {}) =>
  writeFileSync(
    join(homes().claudeHome, 'sessions', `${pid}.json`),
    JSON.stringify({ pid, procStart: 'P', sessionId, cwd: '/Users/test/Wakecap', startedAt: T0, status, statusUpdatedAt: at, updatedAt: at, ...extra }),
  );
const transcript = () => join(homes().claudeHome, 'projects/-Users-test-Wakecap/s-basic.jsonl');
const line = (o: Record<string, unknown>) => `${JSON.stringify({ parentUuid: null, sessionId: 's-basic', cwd: '/Users/test/Wakecap', ...o })}\n`;
const of = <T extends BusEvent['type']>(t: T) => events.filter((e): e is Extract<BusEvent, { type: T }> => e.type === t);

beforeEach(async () => {
  pty = createFakePty();
  ctx = createTestContext({ pty });
  const base = ctx.config();
  cfg = { ...base, live: { ...base.live, endedRetentionMin: 1, codexBusyWindowMs: 10_000 } };
  ctx.config = () => cfg;
  events = [];
  for (const t of ['session.updated', 'session.removed', 'session.statusChanged', 'session.turnEnded', 'tests.recorded'] as const) {
    ctx.bus.on(t, (e) => events.push(e));
  }
  alive = new Set([41001]);
  codexProcs = [];
  nowMs = T0;
  tracker = createLiveTracker(ctx, {
    registry: createRegistryWatcher({ dir: join(homes().claudeHome, 'sessions'), watch: false }),
    liveness: { isAlive: async (pid) => alive.has(pid) },
    codex: { scan: async () => codexProcs },
    now: () => new Date(nowMs),
  });
  await tracker.start();
});
afterEach(async () => tracker.stop());

describe('LiveTracker (claude)', () => {
  it('shows the fixture session as waiting, observed, with transcript details', () => {
    const s = tracker.get('claude:s-basic');
    expect(s?.live).toMatchObject({
      pid: 41001, status: 'waiting', waitingFor: 'input needed', ownership: 'observed', ptyId: null, currentTool: 'Edit',
    });
    expect(s?.lastTest?.passed).toBe(18);
    expect(tracker.list().map((x) => `${x.source}:${x.id}`)).toEqual(['claude:s-basic']);
    expect(of('session.statusChanged')).toEqual([{ type: 'session.statusChanged', pk: 'claude:s-basic', from: null, to: 'waiting' }]);
    expect(of('tests.recorded')).toHaveLength(0);
    expect(of('session.turnEnded')).toHaveLength(0);
    expect(latestTestResult(ctx.db, 'claude:s-basic')?.passed).toBe(18);
    expect(of('session.updated').at(-1)?.session.live?.status).toBe('waiting');
  });

  it('derives review after a turn with edits and emits turn/test events', async () => {
    appendFileSync(transcript(), line({ type: 'user', uuid: 'n1', timestamp: '2026-09-01T09:11:00.000Z', message: { role: 'user', content: 'fix it' } }));
    appendFileSync(transcript(), line({ type: 'assistant', uuid: 'n2', timestamp: '2026-09-01T09:11:05.000Z', message: { id: 'mx', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/Users/test/Wakecap/b.ts' } }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm vitest run' } }] } }));
    appendFileSync(transcript(), line({ type: 'user', uuid: 'n3', timestamp: '2026-09-01T09:11:30.000Z', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '      Tests  1 failed | 17 passed (18)' }] } }));
    appendFileSync(transcript(), line({ type: 'system', subtype: 'turn_duration', uuid: 'n4', timestamp: '2026-09-01T09:11:31.000Z', durationMs: 31000 }));
    nowMs = T0 + 60_000;
    reg(41001, 's-basic', 'idle', nowMs);
    await tracker.refresh();
    const s = tracker.get('claude:s-basic');
    expect(s?.live).toMatchObject({ status: 'review', stage: 'review', since: new Date(nowMs).toISOString() });
    expect(s?.lastPrompt).toBe('fix it');
    expect(of('session.statusChanged').at(-1)).toEqual({ type: 'session.statusChanged', pk: 'claude:s-basic', from: 'waiting', to: 'review' });
    expect(of('session.turnEnded')).toEqual([{ type: 'session.turnEnded', pk: 'claude:s-basic', turn: 4 }]);
    expect(of('tests.recorded')).toHaveLength(1);
    expect(of('tests.recorded')[0]?.result.failed).toBe(1);
  });

  it('marks dead pids ended and removes them after the retention window', async () => {
    alive.clear();
    nowMs = T0 + 1000;
    await tracker.refresh();
    expect(tracker.get('claude:s-basic')?.live?.status).toBe('ended');
    nowMs = T0 + 1000 + 61_000;
    await tracker.refresh();
    expect(tracker.list()).toEqual([]);
    expect(of('session.removed')).toEqual([{ type: 'session.removed', pk: 'claude:s-basic' }]);
    await tracker.refresh();
    expect(tracker.list()).toEqual([]);
  });

  it('builds a stub for sessions that are not indexed yet', async () => {
    reg(41009, 's-new', 'busy', T0, { name: 'brand-new' });
    alive.add(41009);
    await tracker.refresh();
    const s = tracker.get('claude:s-new');
    expect(s).toMatchObject({ id: 's-new', source: 'claude', name: 'brand-new', startCwd: '/Users/test/Wakecap', projectId: 'wakecap' });
    expect(s?.live?.status).toBe('busy');
    expect(of('session.updated').some((e) => e.session.id === 's-new')).toBe(true);
  });

  it('marks sessions owned when a live PTY has the pid', async () => {
    pty.infos.push({ id: 'pty-9', sessionPk: null, command: 'claude', args: [], cwd: '/Users/test/Wakecap', pid: 41001, startedAt: '', exitedAt: null, exitCode: null, cols: 80, rows: 24 });
    await tracker.refresh();
    expect(tracker.get('claude:s-basic')?.live).toMatchObject({ ownership: 'owned', ptyId: 'pty-9' });
  });

  it('lets a newer hook override the registry status', async () => {
    reg(41001, 's-basic', 'busy', T0 + 1000);
    await tracker.refresh();
    expect(tracker.get('claude:s-basic')?.live?.status).toBe('busy');
    tracker.applyHook({ sessionId: 's-basic', event: 'Notification', message: 'Claude needs permission', ts: new Date(T0 + 2000).toISOString() });
    await tracker.refresh();
    expect(tracker.get('claude:s-basic')?.live).toMatchObject({ status: 'waiting', waitingFor: 'Claude needs permission' });
    reg(41001, 's-basic', 'busy', T0 + 3000);
    await tracker.refresh();
    expect(tracker.get('claude:s-basic')?.live?.status).toBe('busy');
  });

  it('waits for a registry entry with a given pid', async () => {
    const p = tracker.waitForPid(41010, 2000);
    setTimeout(() => reg(41010, 's-launched', 'busy', T0), 150);
    alive.add(41010);
    await expect(p).resolves.toBe('s-launched');
    await expect(tracker.waitForPid(49999, 200)).resolves.toBeNull();
  });
});

describe('LiveTracker (codex)', () => {
  it('shows codex sessions as busy while the rollout is being written', async () => {
    codexProcs = [
      { pid: 700, cwd: '/Users/test/Wakecap', startedAtMs: T0, rolloutPath: '/r1', sessionId: 'c0dex000-0000-0000-0000-000000000001', originator: 'codex_exec', lastWriteMs: T0 - 1000 },
      { pid: 701, cwd: '/Users/test/hackathon', startedAtMs: T0, rolloutPath: '/r2', sessionId: 'auto-1', originator: 'codex_sdk_ts', lastWriteMs: T0 },
      { pid: 702, cwd: '/Users/test/Wakecap', startedAtMs: T0, rolloutPath: null, sessionId: null, originator: null, lastWriteMs: null },
    ];
    await tracker.refresh();
    expect(tracker.get('codex:c0dex000-0000-0000-0000-000000000001')?.live?.status).toBe('busy');
    expect(tracker.get('codex:auto-1')).toBeNull();
    nowMs = T0 + 20_000;
    await tracker.refresh();
    expect(tracker.get('codex:c0dex000-0000-0000-0000-000000000001')?.live?.status).toBe('idle');
    codexProcs = [];
    await tracker.refresh();
    expect(tracker.get('codex:c0dex000-0000-0000-0000-000000000001')?.live?.status).toBe('ended');
  });
});

describe('mapHookToStatus', () => {
  it('maps hook events', () => {
    expect(mapHookToStatus('Notification')).toBe('waiting');
    expect(mapHookToStatus('UserPromptSubmit')).toBe('busy');
    expect(mapHookToStatus('PreToolUse')).toBe('busy');
    expect(mapHookToStatus('Stop')).toBe('idle');
    expect(mapHookToStatus('SessionStart')).toBeNull();
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/live/live-tracker.test.ts`
Expected: FAIL, `Cannot find module './live-tracker.ts'`

- [ ] **Step 4: Implement the helpers**

`apps/daemon/src/live/find-transcript.ts`
```ts
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Finds `<claudeHome>/projects/<any>/<sessionId>.jsonl`. The encoded dir name is never decoded (docs/04 A2). */
export function createTranscriptFinder(claudeHome: string): (sessionId: string) => string | null {
  const cache = new Map<string, string>();
  return (sessionId) => {
    if (!SAFE_ID.test(sessionId) || sessionId.includes('..')) return null;
    const hit = cache.get(sessionId);
    if (hit && existsSync(hit)) return hit;
    const root = join(claudeHome, 'projects');
    let dirs: string[];
    try {
      dirs = readdirSync(root);
    } catch {
      return null;
    }
    for (const d of dirs) {
      const p = join(root, d, `${sessionId}.jsonl`);
      if (existsSync(p)) {
        cache.set(sessionId, p);
        return p;
      }
    }
    return null;
  };
}
```

`apps/daemon/src/live/stub-session.ts`
```ts
import { type Session, type Source, emptyUsage } from '@orc/core';

export function stubSession(i: {
  source: Source;
  id: string;
  cwd: string;
  startedAt: string;
  projectId: string | null;
  name: string | null;
}): Session {
  return {
    id: i.id,
    source: i.source,
    projectId: i.projectId,
    startCwd: i.cwd,
    cwds: [i.cwd],
    name: i.name,
    firstPrompt: null,
    lastPrompt: null,
    awaySummary: null,
    recap: null,
    startedAt: i.startedAt,
    lastActivityAt: i.startedAt,
    models: [],
    permissionMode: null,
    usage: emptyUsage(),
    linesAdded: null,
    linesRemoved: null,
    prs: [],
    tickets: [],
    skills: [],
    mcpServers: [],
    filesTouched: [],
    promptCount: 0,
    toolCallCount: 0,
    apiErrorCount: 0,
    flags: { touchedProd: false, hasSubagents: false, automated: false },
    availability: 'resumable',
    transcriptPath: null,
    lastTest: null,
    live: null,
  };
}
```

- [ ] **Step 5: Implement the tracker**

`apps/daemon/src/live/live-tracker.ts`
```ts
import {
  type LiveReducer,
  type LiveState,
  type LiveStatus,
  type RegistryStatus,
  type Session,
  type Source,
  createLiveReducer,
  deriveLiveStatus,
  parseJsonLine,
  readJsonlFrom,
  redact,
} from '@orc/core';
import type { CodexLiveDetector } from '../collectors/codex/live.ts';
import type { DaemonContext } from '../context.ts';
import { insertTestResult } from '../db/repos/test-results.ts';
import { sessionPk } from '../services/sessions.ts';
import { createTranscriptFinder } from './find-transcript.ts';
import type { LivenessChecker } from './liveness.ts';
import type { RegistryWatcher } from './registry-watcher.ts';
import { stubSession } from './stub-session.ts';

export interface HookEvent {
  sessionId: string;
  event: string;
  message: string | null;
  ts: string;
}

export interface LiveTracker {
  start(): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<void>;
  list(): Session[];
  get(pk: string): Session | null;
  waitForPid(pid: number, timeoutMs: number): Promise<string | null>;
  applyHook(e: HookEvent): void;
}

export interface LiveTrackerDeps {
  registry: RegistryWatcher;
  liveness: LivenessChecker;
  codex: CodexLiveDetector;
  now?: () => Date;
  findTranscript?: (sessionId: string) => string | null;
}

export function mapHookToStatus(event: string): RegistryStatus | null {
  switch (event) {
    case 'Notification':
      return 'waiting';
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'SubagentStart':
      return 'busy';
    case 'Stop':
      return 'idle';
    default:
      return null;
  }
}

interface Entry {
  pk: string;
  source: Source;
  id: string;
  pid: number;
  cwd: string;
  startedAt: string;
  name: string | null;
  registryStatus: RegistryStatus | null;
  registryAt: number;
  waitingFor: string | null;
  hook: { status: RegistryStatus; at: number; message: string | null } | null;
  transcriptPath: string | null;
  offset: number;
  reducer: LiveReducer;
  primed: boolean;
  status: LiveStatus | null;
  since: string;
  endedAt: number | null;
  live: LiveState | null;
  lastPublished: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createLiveTracker(ctx: DaemonContext, deps: LiveTrackerDeps): LiveTracker {
  const now = deps.now ?? (() => new Date());
  const findTranscript = deps.findTranscript ?? createTranscriptFinder(ctx.paths.claudeHome);
  const entries = new Map<string, Entry>();
  const dismissed = new Map<string, number>(); // pk -> pid of a removed ended entry
  let initialPassDone = false;
  let running: Promise<void> | null = null;
  let rerun = false;
  let timer: NodeJS.Timeout | null = null;
  const unsubs: Array<() => void> = [];

  function newEntry(source: Source, id: string, pid: number, cwd: string, startedAtMs: number | null, name: string | null): Entry {
    return {
      pk: sessionPk(source, id),
      source,
      id,
      pid,
      cwd,
      startedAt: new Date(startedAtMs ?? now().getTime()).toISOString(),
      name,
      registryStatus: null,
      registryAt: 0,
      waitingFor: null,
      hook: null,
      transcriptPath: null,
      offset: 0,
      reducer: createLiveReducer(),
      primed: initialPassDone,
      status: null,
      since: now().toISOString(),
      endedAt: null,
      live: null,
      lastPublished: '',
    };
  }

  function merged(e: Entry): Session {
    const t = e.reducer.snapshot();
    const base =
      ctx.sessions.getByPk(e.pk) ??
      stubSession({ source: e.source, id: e.id, cwd: e.cwd, startedAt: e.startedAt, projectId: ctx.projects.resolve(e.cwd), name: e.name });
    const lastActivityAt = t.lastActivityAt && t.lastActivityAt > base.lastActivityAt ? t.lastActivityAt : base.lastActivityAt;
    return {
      ...base,
      lastPrompt: t.lastPrompt ?? base.lastPrompt,
      lastTest: t.lastTest ?? base.lastTest,
      permissionMode: t.permissionMode ?? base.permissionMode,
      lastActivityAt,
      cwds: base.cwds.includes(e.cwd) ? base.cwds : [...base.cwds, e.cwd],
      live: e.live,
    };
  }

  async function tail(e: Entry): Promise<void> {
    if (e.source !== 'claude') return;
    if (!e.transcriptPath) e.transcriptPath = ctx.sessions.getByPk(e.pk)?.transcriptPath ?? findTranscript(e.id);
    if (!e.transcriptPath) return;
    let res: Awaited<ReturnType<typeof readJsonlFrom>>;
    try {
      res = await readJsonlFrom(e.transcriptPath, e.offset);
    } catch {
      return;
    }
    for (const l of res.lines) {
      const eff = e.reducer.apply(parseJsonLine(l.text));
      if (eff.testRecorded) {
        const inserted = insertTestResult(ctx.db, e.pk, eff.testRecorded);
        if (inserted && e.primed) ctx.bus.emit({ type: 'tests.recorded', pk: e.pk, result: eff.testRecorded });
      }
      if (eff.turnEnded !== null && e.primed) ctx.bus.emit({ type: 'session.turnEnded', pk: e.pk, turn: eff.turnEnded });
    }
    e.offset = res.nextOffset;
    e.primed = true;
  }

  function update(e: Entry, alive: boolean, nowMs: number): void {
    const t = e.reducer.snapshot();
    const hookWins = e.hook !== null && e.hook.at > e.registryAt;
    const registryStatus = hookWins && e.hook ? e.hook.status : e.registryStatus;
    const status = deriveLiveStatus({ alive, registryStatus, transcript: t });
    let change: { from: LiveStatus | null; to: LiveStatus } | null = null;
    if (status !== e.status) {
      change = { from: e.status, to: status };
      e.status = status;
      e.since = new Date(nowMs).toISOString();
      e.endedAt = status === 'ended' ? nowMs : null;
    }
    const owner = ctx.pty.list().find((p) => p.exitedAt === null && (p.pid === e.pid || p.sessionPk === e.pk));
    const waitingText = hookWins && e.hook?.message ? e.hook.message : (e.waitingFor ?? 'input needed');
    e.live = {
      pid: e.pid,
      status,
      waitingFor: status === 'waiting' ? redact(waitingText) : null,
      since: e.since,
      ownership: owner ? 'owned' : 'observed',
      ptyId: owner?.id ?? null,
      stage: t.stage,
      currentTool: t.currentTool,
      backgroundJobs: t.backgroundJobs,
      runningSubagents: t.runningSubagents,
      contextFill: t.contextFill,
    };
    const key = `${JSON.stringify(e.live)}|${t.lastPrompt ?? ''}|${t.lastTest?.ts ?? ''}`;
    if (key !== e.lastPublished) {
      e.lastPublished = key;
      if (ctx.sessions.getByPk(e.pk)) ctx.sessions.setLive(e.pk, e.live);
      ctx.bus.emit({ type: 'session.updated', session: merged(e) });
    }
    if (change) ctx.bus.emit({ type: 'session.statusChanged', pk: e.pk, from: change.from, to: change.to });
  }

  function remove(e: Entry): void {
    entries.delete(e.pk);
    dismissed.set(e.pk, e.pid);
    if (ctx.sessions.getByPk(e.pk)) ctx.sessions.setLive(e.pk, null);
    ctx.bus.emit({ type: 'session.removed', pk: e.pk });
  }

  function upsertEntry(source: Source, id: string, pid: number, cwd: string, startedAtMs: number | null, name: string | null): Entry | null {
    const pk = sessionPk(source, id);
    if (dismissed.get(pk) === pid) return null;
    dismissed.delete(pk);
    let e = entries.get(pk);
    if (!e || e.pid !== pid) {
      const fresh = newEntry(source, id, pid, cwd, startedAtMs, name);
      if (e) {
        fresh.transcriptPath = e.transcriptPath;
        fresh.offset = e.offset;
        fresh.reducer = e.reducer;
        fresh.status = e.status;
      }
      e = fresh;
      entries.set(pk, e);
    }
    e.cwd = cwd;
    if (name) e.name = name;
    return e;
  }

  async function pass(): Promise<void> {
    const nowMs = now().getTime();
    const cfg = ctx.config();
    const seen = new Set<string>();

    await deps.registry.rescan(); // cheap (a handful of small files); makes refresh() authoritative even when fs events are late
    for (const snap of deps.registry.current()) {
      const r = snap.entry;
      const e = upsertEntry('claude', r.sessionId, r.pid, r.cwd, r.startedAt, r.name);
      if (!e) continue;
      seen.add(e.pk);
      e.registryStatus = r.status;
      e.registryAt = r.statusUpdatedAt ?? r.updatedAt ?? 0;
      e.waitingFor = r.waitingFor;
      const alive = await deps.liveness.isAlive(r.pid, r.procStart);
      await tail(e);
      update(e, alive, nowMs);
    }

    let procs: Awaited<ReturnType<CodexLiveDetector['scan']>> = [];
    try {
      procs = await deps.codex.scan();
    } catch (err) {
      ctx.log.warn({ err: String(err) }, 'codex live scan failed');
    }
    for (const p of procs) {
      if (!p.sessionId) continue;
      if (p.originator === 'codex_sdk_ts' && !cfg.codex.showAutomated) continue;
      const e = upsertEntry('codex', p.sessionId, p.pid, p.cwd, p.startedAtMs, null);
      if (!e) continue;
      seen.add(e.pk);
      e.registryStatus = p.lastWriteMs !== null && nowMs - p.lastWriteMs < cfg.live.codexBusyWindowMs ? 'busy' : 'idle';
      e.registryAt = p.lastWriteMs ?? 0;
      update(e, true, nowMs);
    }

    const retentionMs = cfg.live.endedRetentionMin * 60_000;
    for (const e of [...entries.values()]) {
      if (!seen.has(e.pk)) {
        if (e.status !== 'ended') update(e, false, nowMs);
      }
      if (e.status === 'ended' && e.endedAt !== null && nowMs - e.endedAt > retentionMs) remove(e);
    }
  }

  async function refresh(): Promise<void> {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      do {
        rerun = false;
        await pass();
      } while (rerun);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    async start() {
      await deps.registry.start();
      unsubs.push(deps.registry.onChange(() => void refresh()));
      unsubs.push(ctx.bus.on('pty.exited', () => void refresh()));
      await refresh();
      initialPassDone = true;
      timer = setInterval(() => void refresh(), ctx.config().live.pollMs);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const u of unsubs.splice(0)) u();
      await deps.registry.stop();
      if (running) await running;
    },
    refresh,
    list: () => [...entries.values()].filter((e) => e.live !== null).map(merged),
    get(pk) {
      const e = entries.get(pk);
      return e?.live ? merged(e) : null;
    },
    async waitForPid(pid, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await deps.registry.rescan();
        const snap = deps.registry.current().find((s) => s.entry.pid === pid);
        if (snap) {
          await refresh();
          return snap.entry.sessionId;
        }
        await sleep(100);
      }
      return null;
    },
    applyHook(ev) {
      const status = mapHookToStatus(ev.event);
      const e = entries.get(sessionPk('claude', ev.sessionId));
      if (!status || !e) return;
      const at = Date.parse(ev.ts);
      e.hook = { status, at: Number.isFinite(at) ? at : now().getTime(), message: ev.message };
      void refresh();
    },
  };
}
```

Notes on the tests:
- `waitForPid` uses real time. The file is written after 150 ms, and the loop rescans every 100 ms.
- In the "hook" test, the registry is rewritten with `statusUpdatedAt = T0 + 3000`, which is newer than the hook, so the registry wins again.

Add to `apps/daemon/src/context.ts` (inside `DaemonContext`, after `archive?`):
```ts
  live?: import('./live/live-tracker.ts').LiveTracker;                                        // P2
  updateConfig?: (fn: (cfg: import('@orc/api-contract').OrcConfig) => import('@orc/api-contract').OrcConfig) => import('@orc/api-contract').OrcConfig; // P2
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm vitest run apps/daemon/src/live/live-tracker.test.ts`
Expected: PASS (9 tests). If `createTestContext` doesn't index the fixtures, `getByPk` returns null and the stub path is used. Every assertion above still holds except `projectId: 'wakecap'` in the stub test, which needs `ProjectService.resolve('/Users/test/Wakecap') === 'wakecap'`. Write that down if it happens.

- [ ] **Step 7: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon/src/live apps/daemon/src/context.ts apps/daemon/test/fake-pty.ts
git commit -m "feat(daemon): track live Claude and Codex sessions with derived status and ownership"
```

---

### Task 8: daemon — `GET /api/live`, the `/ws` hub and the minimal hook ingest

**Files:**
- Create: `apps/daemon/src/http/redact-session.ts`
- Create: `apps/daemon/src/http/routes/live.ts`, `apps/daemon/src/http/routes/hooks.ts`, `apps/daemon/src/http/routes/live-hooks.test.ts`
- Create: `apps/daemon/src/http/live-ws.ts`, `apps/daemon/src/http/live-ws.test.ts`
- Create: `apps/daemon/test/fake-live.ts`

**Interfaces:**
- Consumes: `LiveTracker`, `HookEvent` (Task 7); `HookIngestBody`, `apiError` (api-contract); `EventBus`/`BusEvent` (contracts §6); `redact`, `Session` (core); `stubSession` (Task 7); `ws` package
- Produces:
  ```ts
  // http/redact-session.ts
  export function redactSession(s: Session): Session
  // http/routes/live.ts
  export function registerLiveRoutes(app: Hono, ctx: DaemonContext): void        // GET /api/live?projectId
  // http/routes/hooks.ts
  export function registerHookRoutes(app: Hono, ctx: DaemonContext): void        // POST /api/hooks
  // http/live-ws.ts
  export const LIVE_EVENT_TYPES: readonly ['session.updated', 'session.removed', 'inbox.upserted', 'pty.exited', 'index.progress', 'usage.updated']
  export type WireEvent = Extract<BusEvent, { type: (typeof LIVE_EVENT_TYPES)[number] }> | { type: 'hello'; serverTime: string }
  export interface LiveWsHub { handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void; clientCount(): number; close(): Promise<void> }
  export function createLiveWsHub(ctx: DaemonContext, opts?: { now?: () => Date; maxBufferedBytes?: number }): LiveWsHub
  // test/fake-live.ts
  export function createFakeLive(sessions?: Session[]): LiveTracker & { sessions: Session[]; hooks: HookEvent[]; pids: Map<number, string> }
  ```

**S3 decision:**
- If `plan/spikes/S3.md` requires the hook bridge, the ingest route below is **required** for the "inbox within 2 s" exit criterion. Task 20 then includes the manual hook setup in its evidence.
- Otherwise the route ships unchanged and the setup stays optional.

The daemon **never** edits `~/.claude/settings.json` (the consented install comes in Phase 5). The user adds the hook by hand, using the snippet that Task 20's Settings section shows:
```json
{
  "hooks": {
    "Notification": [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H \"x-orc-token: $(cat ~/.orchestrator/token)\" -H 'content-type: application/json' --data-binary @- http://127.0.0.1:4317/api/hooks >/dev/null || true" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H \"x-orc-token: $(cat ~/.orchestrator/token)\" -H 'content-type: application/json' --data-binary @- http://127.0.0.1:4317/api/hooks >/dev/null || true" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "curl -s -m 2 -X POST -H \"x-orc-token: $(cat ~/.orchestrator/token)\" -H 'content-type: application/json' --data-binary @- http://127.0.0.1:4317/api/hooks >/dev/null || true" }] }]
  }
}
```
The ingest keeps only `session_id`, `hook_event_name` and `message`. The rest of the hook payload (prompts, tool input) is dropped and never logged. The `hook.received` bus payload is `{ sessionId, event }`.

- [ ] **Step 1: Write the fake live tracker**

`apps/daemon/test/fake-live.ts`
```ts
import type { Session } from '@orc/core';
import type { HookEvent, LiveTracker } from '../src/live/live-tracker.ts';

export function createFakeLive(
  sessions: Session[] = [],
): LiveTracker & { sessions: Session[]; hooks: HookEvent[]; pids: Map<number, string> } {
  const hooks: HookEvent[] = [];
  const pids = new Map<number, string>();
  const state = { sessions };
  return {
    get sessions() {
      return state.sessions;
    },
    set sessions(v: Session[]) {
      state.sessions = v;
    },
    hooks,
    pids,
    async start() {},
    async stop() {},
    async refresh() {},
    list: () => state.sessions,
    get: (pk) => state.sessions.find((s) => `${s.source}:${s.id}` === pk) ?? null,
    waitForPid: async (pid) => pids.get(pid) ?? null,
    applyHook: (e) => void hooks.push(e),
  };
}
```

- [ ] **Step 2: Write the failing tests**

`apps/daemon/src/http/routes/live-hooks.test.ts`
```ts
import type { LiveState, Session } from '@orc/core';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeLive } from '../../../test/fake-live.ts';
import { createTestContext, useTempHomes } from '../../../test/helpers.ts';
import type { DaemonContext } from '../../context.ts';
import type { BusEvent } from '../../live/event-bus.ts';
import { stubSession } from '../../live/stub-session.ts';
import { registerHookRoutes } from './hooks.ts';
import { registerLiveRoutes } from './live.ts';

useTempHomes();
const live: LiveState = {
  pid: 1, status: 'waiting', waitingFor: 'token=abc123', since: '2026-09-01T09:00:00.000Z', ownership: 'observed',
  ptyId: null, stage: null, currentTool: null, backgroundJobs: 0, runningSubagents: 0, contextFill: null,
};
const session = (id: string, projectId: string | null, lastPrompt: string): Session => ({
  ...stubSession({ source: 'claude', id, cwd: '/Users/test/Wakecap', startedAt: '2026-09-01T09:00:00.000Z', projectId, name: id }),
  lastPrompt,
  live,
});

let ctx: DaemonContext;
let app: Hono;
let fake: ReturnType<typeof createFakeLive>;
beforeEach(() => {
  ctx = createTestContext();
  fake = createFakeLive([
    session('a', 'wakecap', 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 please'),
    session('b', 'forza', 'hello'),
  ]);
  ctx.live = fake;
  app = new Hono();
  registerLiveRoutes(app, ctx);
  registerHookRoutes(app, ctx);
});

describe('GET /api/live', () => {
  it('returns live sessions, redacted, filtered by project', async () => {
    const res = await app.request('/api/live');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Session[];
    expect(body.map((s) => s.id)).toEqual(['a', 'b']);
    expect(body[0]?.lastPrompt).toBe('use «redacted:github» please');
    expect(body[0]?.live?.waitingFor).toBe('token=«redacted:secret»');
    const filtered = (await (await app.request('/api/live?projectId=forza')).json()) as Session[];
    expect(filtered.map((s) => s.id)).toEqual(['b']);
  });

  it('returns an empty list before the tracker exists', async () => {
    ctx.live = undefined;
    expect(await (await app.request('/api/live')).json()).toEqual([]);
  });
});

describe('POST /api/hooks', () => {
  it('forwards a minimal event to the tracker and the bus', async () => {
    const seen: BusEvent[] = [];
    ctx.bus.on('hook.received', (e) => seen.push(e));
    const res = await app.request('/api/hooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 's-basic', hook_event_name: 'Notification', message: 'needs you', prompt: 'SECRET PROMPT' }),
    });
    expect(res.status).toBe(200);
    expect(fake.hooks).toHaveLength(1);
    expect(fake.hooks[0]).toMatchObject({ sessionId: 's-basic', event: 'Notification', message: 'needs you' });
    expect(seen).toEqual([{ type: 'hook.received', payload: { sessionId: 's-basic', event: 'Notification' } }]);
    expect(JSON.stringify(seen)).not.toContain('SECRET');
  });

  it('rejects invalid payloads', async () => {
    const res = await app.request('/api/hooks', { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_failed');
  });
});
```

`apps/daemon/src/http/live-ws.test.ts`
```ts
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createTestContext, useTempHomes } from '../../test/helpers.ts';
import type { DaemonContext } from '../context.ts';
import { stubSession } from '../live/stub-session.ts';
import { type LiveWsHub, createLiveWsHub } from './live-ws.ts';

useTempHomes();
let ctx: DaemonContext;
let hub: LiveWsHub;
let server: Server;
let url: string;

beforeEach(async () => {
  ctx = createTestContext();
  hub = createLiveWsHub(ctx, { now: () => new Date('2026-09-01T09:00:00.000Z') });
  server = createServer();
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});
afterEach(async () => {
  await hub.close();
  await new Promise((r) => server.close(r));
});

function connect(): Promise<{ ws: WebSocket; messages: unknown[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: unknown[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(String(d))));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

describe('live WS hub', () => {
  it('sends hello, then forwards live events (redacted) but not internal ones', async () => {
    const { ws, messages } = await connect();
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toEqual({ type: 'hello', serverTime: '2026-09-01T09:00:00.000Z' });
    const s = { ...stubSession({ source: 'claude', id: 'x', cwd: '/w', startedAt: 't', projectId: null, name: null }), lastPrompt: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAA' };
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:x', from: null, to: 'busy' });
    ctx.bus.emit({ type: 'session.updated', session: s });
    ctx.bus.emit({ type: 'session.removed', pk: 'claude:x' });
    await expect.poll(() => messages.length).toBe(3);
    expect(messages[1]).toMatchObject({ type: 'session.updated', session: { id: 'x', lastPrompt: '«redacted:anthropic»' } });
    expect(messages[2]).toEqual({ type: 'session.removed', pk: 'claude:x' });
    expect(hub.clientCount()).toBe(1);
    ws.close();
    await expect.poll(() => hub.clientCount()).toBe(0);
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/http/routes/live-hooks.test.ts apps/daemon/src/http/live-ws.test.ts`
Expected: FAIL, `Cannot find module './live.ts'` / `'./live-ws.ts'`

- [ ] **Step 4: Implement the routes and the hub**

`apps/daemon/src/http/redact-session.ts`
```ts
import { type Session, redact } from '@orc/core';

const r = (v: string | null): string | null => (v === null ? null : redact(v));

/** Redacts every free-text field of a Session before it leaves the daemon (contracts §8). */
export function redactSession(s: Session): Session {
  return {
    ...s,
    name: r(s.name),
    firstPrompt: r(s.firstPrompt),
    lastPrompt: r(s.lastPrompt),
    awaySummary: r(s.awaySummary),
    recap: r(s.recap),
    live: s.live ? { ...s.live, waitingFor: r(s.live.waitingFor) } : null,
  };
}
```
If Phase 1 already has an equivalent helper, keep one of them: re-export the Phase 1 function under this name.

`apps/daemon/src/http/routes/live.ts`
```ts
import type { Hono } from 'hono';
import type { DaemonContext } from '../../context.ts';
import { redactSession } from '../redact-session.ts';

export function registerLiveRoutes(app: Hono, ctx: DaemonContext): void {
  app.get('/api/live', (c) => {
    const projectId = c.req.query('projectId');
    const items = (ctx.live?.list() ?? [])
      .filter((s) => !projectId || s.projectId === projectId)
      .map(redactSession);
    return c.json(items);
  });
}
```

`apps/daemon/src/http/routes/hooks.ts`
```ts
import { HookIngestBody, apiError } from '@orc/api-contract';
import type { Hono } from 'hono';
import type { DaemonContext } from '../../context.ts';

export function registerHookRoutes(app: Hono, ctx: DaemonContext): void {
  app.post('/api/hooks', async (c) => {
    const raw: unknown = await c.req.json().catch(() => null);
    const parsed = HookIngestBody.safeParse(raw);
    if (!parsed.success) return c.json(apiError('validation_failed', 'invalid hook payload', parsed.error.issues), 400);
    const b = parsed.data;
    ctx.bus.emit({ type: 'hook.received', payload: { sessionId: b.session_id, event: b.hook_event_name } });
    ctx.live?.applyHook({
      sessionId: b.session_id,
      event: b.hook_event_name,
      message: b.message ?? null,
      ts: new Date().toISOString(),
    });
    return c.json({ ok: true });
  });
}
```

`apps/daemon/src/http/live-ws.ts`
```ts
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { DaemonContext } from '../context.ts';
import type { BusEvent } from '../live/event-bus.ts';
import { redactSession } from './redact-session.ts';

export const LIVE_EVENT_TYPES = [
  'session.updated',
  'session.removed',
  'inbox.upserted',
  'pty.exited',
  'index.progress',
  'usage.updated',
] as const;
type LiveType = (typeof LIVE_EVENT_TYPES)[number];
export type WireEvent = Extract<BusEvent, { type: LiveType }> | { type: 'hello'; serverTime: string };

export interface LiveWsHub {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  clientCount(): number;
  close(): Promise<void>;
}

export function createLiveWsHub(
  ctx: DaemonContext,
  opts: { now?: () => Date; maxBufferedBytes?: number } = {},
): LiveWsHub {
  const now = opts.now ?? (() => new Date());
  const maxBuffered = opts.maxBufferedBytes ?? 5 * 1024 * 1024;
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    const hello: WireEvent = { type: 'hello', serverTime: now().toISOString() };
    ws.send(JSON.stringify(hello));
  });

  const toWire = (e: Extract<BusEvent, { type: LiveType }>): WireEvent =>
    e.type === 'session.updated' ? { type: 'session.updated', session: redactSession(e.session) } : e;

  const broadcast = (e: Extract<BusEvent, { type: LiveType }>) => {
    const msg = JSON.stringify(toWire(e));
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > maxBuffered) {
        client.terminate(); // a slow client resyncs on reconnect (it refetches after hello)
        continue;
      }
      client.send(msg);
    }
  };

  const unsubs = LIVE_EVENT_TYPES.map((t) => ctx.bus.on(t, (e) => broadcast(e)));

  return {
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
    clientCount: () => [...wss.clients].filter((c) => c.readyState === WebSocket.OPEN).length,
    async close() {
      for (const u of unsubs) u();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/http/routes/live-hooks.test.ts apps/daemon/src/http/live-ws.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon/src/http apps/daemon/test/fake-live.ts
git commit -m "feat(daemon): serve live sessions over GET /api/live and WS /ws, add hook ingest"
```

---

### Task 9: daemon — InboxEngine (upsert, resolve, triage, snooze wake-up, rules)

**Files:**
- Create: `apps/daemon/src/inbox/engine.ts`, `apps/daemon/src/inbox/engine.test.ts`
- Modify: `apps/daemon/src/context.ts` (the `inbox?` field type now resolves to this file; `notifier?` resolves to Task 11's file. If the P1 context declared placeholder types, replace them with imports.)

**Interfaces:**
- Consumes: the inbox repo functions (Task 1); `DaemonContext`, `EventBus`, `BusEvent` (contracts); `redact`, `InboxItem`, `InboxKind`, `InboxState` (core); the `Notifier` type from `apps/daemon/src/notify/notifier.ts`. The engine only needs the contract shape, and Task 11 creates the file. For this task, create `apps/daemon/src/notify/notifier.ts` with **only** the contract types (the code block in Step 3); Task 11 adds the implementation below them.
- Produces (contracts §11 exactly, plus the runtime extension):
  ```ts
  export interface InboxUpsert { kind: InboxKind; dedupeKey: string; sessionId?: string | null; projectId?: string | null; ticket?: string | null; reason: string; payload?: Record<string, unknown> }
  export interface InboxEngine { upsert(item: InboxUpsert): InboxItem; resolve(dedupeKey: string): void; list(filter: { state?: InboxState[]; kind?: InboxKind[]; projectId?: string }): InboxItem[]; markDone(id: string): InboxItem; snooze(id: string, until: string): InboxItem; reopen(id: string): InboxItem; registerRule(rule: InboxRule): void }
  export interface InboxRule { name: string; on: BusEvent['type'][]; handle(e: BusEvent, ctx: DaemonContext): void }
  export interface InboxEngineRuntime extends InboxEngine { tick(now?: Date): void; start(intervalMs?: number): void; stop(): void }
  export class InboxError extends Error { readonly status: 400 | 404; readonly code: 'not_found' | 'validation_failed' }
  export function createInboxEngine(ctx: DaemonContext, opts?: { now?: () => Date; notifier?: Notifier }): InboxEngineRuntime
  ```

**Semantics:**
- `upsert`:
  - When an **active** (open or snoozed) item with the same `dedupeKey` exists, it refreshes `reason`, `payload`, `ticket`, `projectId` and `updatedAt`, keeps the state (a snoozed item stays snoozed), emits `inbox.upserted`, and **does not notify**.
  - Otherwise it inserts a new `open` item, emits, and notifies **once**. This is the "one notification per session per state change" debounce: a state change resolves the old key and opens a new item.
  - `reason` is redacted and cut to 300 characters.
- `resolve`: active item → `auto_resolved`; nothing happens if there is none.
- `markDone`: → `done`.
- `snooze(until)`: `until` must be a valid ISO time in the future, and the item must be active. Otherwise it throws `InboxError(400, 'validation_failed')`.
- `reopen`: → `open`. If another active item has the same key, it returns that item instead (the unique index allows only one).
- `tick(now)`: snoozed items whose `snoozeUntil <= now` become `open`; each one is emitted and notified.
- `start(intervalMs = 15000)` runs `tick` on a timer.
- **Rules:** each rule subscribes to its `on` events. A throwing rule is logged and never breaks the bus or the other rules.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/inbox/engine.test.ts`
```ts
import type { InboxItem } from '@orc/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, useTempHomes } from '../../test/helpers.ts';
import type { DaemonContext } from '../context.ts';
import type { Notifier } from '../notify/notifier.ts';
import { type InboxEngineRuntime, InboxError, createInboxEngine } from './engine.ts';

useTempHomes();
let ctx: DaemonContext;
let engine: InboxEngineRuntime;
let nowMs: number;
let emitted: InboxItem[];
const notify = vi.fn(async (_item: InboxItem) => {});
const notifier: Notifier = { notify, register: vi.fn(), setAway: vi.fn(), isAway: () => false };

const T0 = Date.parse('2026-09-01T09:00:00.000Z');
const waiting = (reason = 'Waiting: input needed') => ({
  kind: 'waiting' as const,
  dedupeKey: 'waiting:claude:s-basic',
  sessionId: 's-basic',
  projectId: 'wakecap',
  reason,
  payload: { source: 'claude', id: 's-basic' },
});

beforeEach(() => {
  ctx = createTestContext();
  nowMs = T0;
  engine = createInboxEngine(ctx, { now: () => new Date(nowMs), notifier });
  ctx.inbox = engine;
  emitted = [];
  ctx.bus.on('inbox.upserted', (e) => emitted.push(e.item));
  notify.mockClear();
});

describe('InboxEngine', () => {
  it('opens a new item once and refreshes it without re-notifying', () => {
    const a = engine.upsert(waiting());
    expect(a).toMatchObject({ state: 'open', kind: 'waiting', createdAt: '2026-09-01T09:00:00.000Z', payload: { source: 'claude', id: 's-basic' } });
    nowMs += 1000;
    const b = engine.upsert(waiting('Waiting: approve plan'));
    expect(b.id).toBe(a.id);
    expect(b.reason).toBe('Waiting: approve plan');
    expect(b.updatedAt).toBe('2026-09-01T09:00:01.000Z');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(emitted.map((i) => i.reason)).toEqual(['Waiting: input needed', 'Waiting: approve plan']);
  });

  it('redacts and truncates the reason', () => {
    const a = engine.upsert(waiting(`key ghp_abcdefghijklmnopqrstuvwxyz0123456789 ${'x'.repeat(400)}`));
    expect(a.reason.startsWith('key «redacted:github»')).toBe(true);
    expect(a.reason.length).toBe(300);
  });

  it('auto-resolves and opens a fresh item (and notification) on the next state change', () => {
    const a = engine.upsert(waiting());
    engine.resolve('waiting:claude:s-basic');
    engine.resolve('waiting:claude:unknown');
    expect(engine.list({ state: ['auto_resolved'] }).map((i) => i.id)).toEqual([a.id]);
    const b = engine.upsert(waiting());
    expect(b.id).not.toBe(a.id);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('marks done, snoozes, wakes up and reopens', () => {
    const a = engine.upsert(waiting());
    expect(() => engine.snooze(a.id, '2026-09-01T08:00:00.000Z')).toThrow(InboxError);
    expect(() => engine.snooze(a.id, 'tomorrow')).toThrow(InboxError);
    const s = engine.snooze(a.id, '2026-09-01T09:30:00.000Z');
    expect(s).toMatchObject({ state: 'snoozed', snoozeUntil: '2026-09-01T09:30:00.000Z' });
    const refreshed = engine.upsert(waiting('still waiting'));
    expect(refreshed.state).toBe('snoozed');
    engine.tick(new Date('2026-09-01T09:29:00.000Z'));
    expect(engine.list({ state: ['snoozed'] })).toHaveLength(1);
    engine.tick(new Date('2026-09-01T09:30:00.000Z'));
    expect(engine.list({ state: ['open'] }).map((i) => i.id)).toEqual([a.id]);
    expect(notify).toHaveBeenCalledTimes(2);
    const d = engine.markDone(a.id);
    expect(d).toMatchObject({ state: 'done', snoozeUntil: null });
    expect(() => engine.snooze(a.id, '2026-09-01T10:30:00.000Z')).toThrow(/not active/);
    expect(engine.reopen(a.id).state).toBe('open');
  });

  it('reopen returns the already-active item for the same key', () => {
    const a = engine.upsert(waiting());
    engine.markDone(a.id);
    const b = engine.upsert(waiting());
    expect(engine.reopen(a.id).id).toBe(b.id);
    expect(engine.list({}).find((i) => i.id === a.id)?.state).toBe('done');
  });

  it('throws not_found for unknown ids', () => {
    const err = (() => {
      try {
        engine.markDone('nope');
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(InboxError);
    expect(err).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('filters by kind and project', () => {
    engine.upsert(waiting());
    engine.upsert({ kind: 'error', dedupeKey: 'error:claude:x', projectId: 'forza', reason: 'API error' });
    expect(engine.list({ kind: ['error'] }).map((i) => i.dedupeKey)).toEqual(['error:claude:x']);
    expect(engine.list({ projectId: 'wakecap' }).map((i) => i.kind)).toEqual(['waiting']);
  });

  it('runs registered rules on bus events and isolates failures', () => {
    const good = vi.fn();
    engine.registerRule({ name: 'boom', on: ['session.statusChanged'], handle: () => { throw new Error('boom'); } });
    engine.registerRule({ name: 'good', on: ['session.statusChanged', 'tests.recorded'], handle: good });
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s', from: null, to: 'busy' });
    ctx.bus.emit({ type: 'session.turnEnded', pk: 'claude:s', turn: 1 });
    expect(good).toHaveBeenCalledTimes(1);
    expect(good.mock.calls[0]?.[1]).toBe(ctx);
    engine.stop();
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s', from: 'busy', to: 'idle' });
    expect(good).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/inbox/engine.test.ts`
Expected: FAIL, `Cannot find module './engine.ts'`

- [ ] **Step 3: Create the notifier contract types (implementation in Task 11)**

`apps/daemon/src/notify/notifier.ts`
```ts
import type { InboxItem } from '@orc/core';

export type NotifyChannel = 'macos' | 'webpush' | 'slack_dm';
export interface NotifyChannelImpl {
  id: NotifyChannel;
  send(item: InboxItem, url: string): Promise<void>;
}
export interface Notifier {
  notify(item: InboxItem): Promise<void>;
  register(channel: NotifyChannelImpl): void;
  setAway(away: boolean): void;
  isAway(): boolean;
}
```

- [ ] **Step 4: Implement the engine**

`apps/daemon/src/inbox/engine.ts`
```ts
import { randomUUID } from 'node:crypto';
import { type InboxItem, type InboxKind, type InboxState, redact } from '@orc/core';
import type { DaemonContext } from '../context.ts';
import {
  findActiveByDedupe,
  getInboxItem,
  insertInboxItem,
  listDueSnoozed,
  listInboxItems,
  updateInboxItem,
} from '../db/repos/inbox.ts';
import type { BusEvent } from '../live/event-bus.ts';
import type { Notifier } from '../notify/notifier.ts';

export interface InboxUpsert {
  kind: InboxKind;
  dedupeKey: string;
  sessionId?: string | null;
  projectId?: string | null;
  ticket?: string | null;
  reason: string;
  payload?: Record<string, unknown>;
}

export interface InboxRule {
  name: string;
  on: BusEvent['type'][];
  handle(e: BusEvent, ctx: DaemonContext): void;
}

export interface InboxEngine {
  upsert(item: InboxUpsert): InboxItem;
  resolve(dedupeKey: string): void;
  list(filter: { state?: InboxState[]; kind?: InboxKind[]; projectId?: string }): InboxItem[];
  markDone(id: string): InboxItem;
  snooze(id: string, until: string): InboxItem;
  reopen(id: string): InboxItem;
  registerRule(rule: InboxRule): void;
}

export interface InboxEngineRuntime extends InboxEngine {
  tick(now?: Date): void;
  start(intervalMs?: number): void;
  stop(): void;
}

export class InboxError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: 'not_found' | 'validation_failed',
    message: string,
  ) {
    super(message);
    this.name = 'InboxError';
  }
}

const ACTIVE = new Set<InboxState>(['open', 'snoozed']);

export function createInboxEngine(
  ctx: DaemonContext,
  opts: { now?: () => Date; notifier?: Notifier } = {},
): InboxEngineRuntime {
  const clock = opts.now ?? (() => new Date());
  const nowIso = () => clock().toISOString();
  const unsubs: Array<() => void> = [];
  let timer: NodeJS.Timeout | null = null;

  const emit = (item: InboxItem) => ctx.bus.emit({ type: 'inbox.upserted', item });
  const fire = (item: InboxItem) => {
    const n = opts.notifier ?? ctx.notifier;
    if (!n) return;
    n.notify(item).catch((err: unknown) => ctx.log.warn({ err: String(err), kind: item.kind }, 'notification failed'));
  };
  const mustGet = (id: string): InboxItem => {
    const it = getInboxItem(ctx.db, id);
    if (!it) throw new InboxError(404, 'not_found', `inbox item ${id} not found`);
    return it;
  };

  const engine: InboxEngineRuntime = {
    upsert(u) {
      const ts = nowIso();
      const reason = redact(u.reason).slice(0, 300);
      const existing = findActiveByDedupe(ctx.db, u.dedupeKey);
      if (existing) {
        const updated = updateInboxItem(ctx.db, existing.id, {
          reason,
          payload: u.payload ?? existing.payload,
          ticket: u.ticket ?? existing.ticket,
          projectId: u.projectId ?? existing.projectId,
          updatedAt: ts,
        });
        emit(updated);
        return updated;
      }
      const item: InboxItem = {
        id: randomUUID(),
        kind: u.kind,
        sessionId: u.sessionId ?? null,
        projectId: u.projectId ?? null,
        ticket: u.ticket ?? null,
        reason,
        dedupeKey: u.dedupeKey,
        createdAt: ts,
        updatedAt: ts,
        state: 'open',
        snoozeUntil: null,
        payload: u.payload ?? {},
      };
      insertInboxItem(ctx.db, item);
      emit(item);
      fire(item);
      return item;
    },

    resolve(dedupeKey) {
      const existing = findActiveByDedupe(ctx.db, dedupeKey);
      if (!existing) return;
      emit(updateInboxItem(ctx.db, existing.id, { state: 'auto_resolved', snoozeUntil: null, updatedAt: nowIso() }));
    },

    list: (filter) => listInboxItems(ctx.db, filter),

    markDone(id) {
      mustGet(id);
      const out = updateInboxItem(ctx.db, id, { state: 'done', snoozeUntil: null, updatedAt: nowIso() });
      emit(out);
      return out;
    },

    snooze(id, until) {
      const it = mustGet(id);
      const untilMs = Date.parse(until);
      if (!Number.isFinite(untilMs) || untilMs <= clock().getTime()) {
        throw new InboxError(400, 'validation_failed', 'snooze "until" must be a future ISO timestamp');
      }
      if (!ACTIVE.has(it.state)) throw new InboxError(400, 'validation_failed', 'item is not active');
      const out = updateInboxItem(ctx.db, id, {
        state: 'snoozed',
        snoozeUntil: new Date(untilMs).toISOString(),
        updatedAt: nowIso(),
      });
      emit(out);
      return out;
    },

    reopen(id) {
      const it = mustGet(id);
      if (it.state === 'open') return it;
      const active = findActiveByDedupe(ctx.db, it.dedupeKey);
      if (active && active.id !== id) return active;
      const out = updateInboxItem(ctx.db, id, { state: 'open', snoozeUntil: null, updatedAt: nowIso() });
      emit(out);
      return out;
    },

    registerRule(rule) {
      for (const type of rule.on) {
        unsubs.push(
          ctx.bus.on(type, (e) => {
            try {
              rule.handle(e, ctx);
            } catch (err) {
              ctx.log.error({ err: String(err), rule: rule.name, event: type }, 'inbox rule failed');
            }
          }),
        );
      }
    },

    tick(at) {
      const now = at ?? clock();
      for (const due of listDueSnoozed(ctx.db, now.toISOString())) {
        const out = updateInboxItem(ctx.db, due.id, { state: 'open', snoozeUntil: null, updatedAt: now.toISOString() });
        emit(out);
        fire(out);
      }
    },

    start(intervalMs = 15_000) {
      engine.tick();
      timer = setInterval(() => engine.tick(), intervalMs);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const u of unsubs.splice(0)) u();
    },
  };
  return engine;
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run apps/daemon/src/inbox/engine.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon/src/inbox apps/daemon/src/notify/notifier.ts apps/daemon/src/context.ts
git commit -m "feat(daemon): add attention inbox engine with dedupe, snooze and rules"
```

---

### Task 10: daemon — inbox rules (waiting, review, error, tests_red, auto-resolve) and `/api/inbox` routes

**Files:**
- Create: `apps/daemon/src/inbox/rules/status-rules.ts`, `apps/daemon/src/inbox/rules/status-rules.test.ts`
- Create: `apps/daemon/src/http/routes/inbox.ts`, `apps/daemon/src/http/routes/inbox.test.ts`

**Interfaces:**
- Consumes: `InboxEngine`, `InboxRule`, `InboxError`, `createInboxEngine` (Task 9); `previousTestResult`, `insertTestResult` (Task 1); `LiveTracker.get` (Task 7); `createFakeLive` (Task 8); `splitPk` (Task 4); `InboxListQuery`, `InboxActionBody`, `apiError` (Task 2)
- Produces:
  ```ts
  // inbox/rules/status-rules.ts
  export const STATUS_KIND: Partial<Record<LiveStatus, InboxKind>>   // waiting→waiting, review→review, error→error
  export function dedupeKeyFor(kind: InboxKind, pk: string): string   // `${kind}:${pk}`
  export const statusRule: InboxRule                                    // name 'status', on ['session.statusChanged']
  export const testsRedRule: InboxRule                                  // name 'tests_red', on ['tests.recorded']
  export function registerDefaultRules(engine: InboxEngine): void
  // http/routes/inbox.ts
  export function registerInboxRoutes(app: Hono, ctx: DaemonContext): void
  ```

**Rules:**
- **statusRule:**
  - Entering `waiting`, `review` or `error` upserts that kind with key `${kind}:${pk}`.
  - Leaving one of these states resolves its key. The exception is `review → ended`: work that is ready for review still needs the user after the process exits.
  - The payload is `{ source, id, status }`. `projectId` and `ticket` (first ticket) come from `ctx.live.get(pk) ?? ctx.sessions.getByPk(pk)`.
- **testsRedRule:**
  - A result with `failed > 0` whose **previous** result for the session (strictly earlier `ts`) had `failed === 0` opens `tests_red` (pass → fail).
  - A result with `failed === 0` resolves it.
  - A session's first-ever failing run does not open an item, because it isn't a pass → fail change.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/inbox/rules/status-rules.test.ts`
```ts
import type { LiveState, LiveStatus, Session } from '@orc/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeLive } from '../../../test/fake-live.ts';
import { createTestContext, useTempHomes } from '../../../test/helpers.ts';
import type { DaemonContext } from '../../context.ts';
import { insertTestResult } from '../../db/repos/test-results.ts';
import { stubSession } from '../../live/stub-session.ts';
import { type InboxEngineRuntime, createInboxEngine } from '../engine.ts';
import { dedupeKeyFor, registerDefaultRules } from './status-rules.ts';

useTempHomes();
let ctx: DaemonContext;
let engine: InboxEngineRuntime;
const PK = 'claude:s-live';

const live = (status: LiveStatus): LiveState => ({
  pid: 1, status, waitingFor: status === 'waiting' ? 'approve the plan' : null, since: '2026-09-01T09:00:00.000Z',
  ownership: 'observed', ptyId: null, stage: null, currentTool: null, backgroundJobs: 0, runningSubagents: 0, contextFill: null,
});
const session = (status: LiveStatus): Session => ({
  ...stubSession({ source: 'claude', id: 's-live', cwd: '/Users/test/Wakecap', startedAt: '2026-09-01T09:00:00.000Z', projectId: 'wakecap', name: 'SLA weekends' }),
  tickets: ['SAF-1787'],
  live: live(status),
});

let fake: ReturnType<typeof createFakeLive>;
const change = (from: LiveStatus | null, to: LiveStatus) => {
  fake.sessions = [session(to)];
  ctx.bus.emit({ type: 'session.statusChanged', pk: PK, from, to });
};
const openKinds = () => engine.list({ state: ['open'] }).map((i) => i.kind).sort();

beforeEach(() => {
  ctx = createTestContext();
  fake = createFakeLive([]);
  ctx.live = fake;
  engine = createInboxEngine(ctx);
  ctx.inbox = engine;
  registerDefaultRules(engine);
});

describe('statusRule', () => {
  it('opens a waiting item with session context and resolves it when busy again', () => {
    change(null, 'waiting');
    const [item] = engine.list({ state: ['open'] });
    expect(item).toMatchObject({
      kind: 'waiting',
      dedupeKey: dedupeKeyFor('waiting', PK),
      sessionId: 's-live',
      projectId: 'wakecap',
      ticket: 'SAF-1787',
      reason: 'SLA weekends: waiting — approve the plan',
      payload: { source: 'claude', id: 's-live', status: 'waiting' },
    });
    change('waiting', 'busy');
    expect(openKinds()).toEqual([]);
    expect(engine.list({ state: ['auto_resolved'] })).toHaveLength(1);
  });

  it('keeps review open when the process ends, resolves it when work resumes', () => {
    change('busy', 'review');
    expect(openKinds()).toEqual(['review']);
    change('review', 'ended');
    expect(openKinds()).toEqual(['review']);
    change('ended', 'busy');
    expect(openKinds()).toEqual(['review']);
    change('busy', 'review');
    change('review', 'busy');
    expect(openKinds()).toEqual([]);
  });

  it('handles error states and ignores neutral transitions', () => {
    change('busy', 'idle');
    expect(openKinds()).toEqual([]);
    change('idle', 'error');
    expect(openKinds()).toEqual(['error']);
    expect(engine.list({ kind: ['error'] })[0]?.reason).toBe('SLA weekends: API error or crash');
    change('error', 'waiting');
    expect(openKinds()).toEqual(['waiting']);
  });

  it('falls back to the pk when the session is unknown', () => {
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'codex:c-unknown', from: null, to: 'waiting' });
    expect(engine.list({})[0]).toMatchObject({ sessionId: 'c-unknown', reason: 'c-unknown: waiting — input needed', payload: { source: 'codex', id: 'c-unknown' } });
  });
});

describe('testsRedRule', () => {
  const rec = (ts: string, failed: number) => {
    const result = { ts, command: 'pnpm test', passed: 10, failed, skipped: 0, durationMs: null };
    insertTestResult(ctx.db, PK, result);
    ctx.bus.emit({ type: 'tests.recorded', pk: PK, result });
  };

  it('opens on pass→fail, refreshes while red, resolves when green', () => {
    fake.sessions = [session('busy')];
    rec('2026-09-01T09:00:00.000Z', 0);
    expect(openKinds()).toEqual([]);
    rec('2026-09-01T09:05:00.000Z', 2);
    expect(openKinds()).toEqual(['tests_red']);
    expect(engine.list({ kind: ['tests_red'] })[0]?.reason).toBe('SLA weekends: tests went red (✗2 · ✓10)');
    rec('2026-09-01T09:06:00.000Z', 3);
    expect(engine.list({ kind: ['tests_red'] })).toHaveLength(1);
    rec('2026-09-01T09:07:00.000Z', 0);
    expect(openKinds()).toEqual([]);
  });

  it('ignores a first-ever failing run', () => {
    rec('2026-09-01T09:05:00.000Z', 2);
    expect(openKinds()).toEqual([]);
  });
});
```

`apps/daemon/src/http/routes/inbox.test.ts`
```ts
import type { InboxItem } from '@orc/core';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, useTempHomes } from '../../../test/helpers.ts';
import type { DaemonContext } from '../../context.ts';
import { createInboxEngine } from '../../inbox/engine.ts';
import { registerInboxRoutes } from './inbox.ts';

useTempHomes();
let ctx: DaemonContext;
let app: Hono;
let id: string;
const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  ctx = createTestContext();
  ctx.inbox = createInboxEngine(ctx);
  id = ctx.inbox.upsert({ kind: 'waiting', dedupeKey: 'waiting:claude:a', projectId: 'wakecap', reason: 'r' }).id;
  ctx.inbox.upsert({ kind: 'error', dedupeKey: 'error:claude:b', projectId: 'forza', reason: 'r' });
  app = new Hono();
  registerInboxRoutes(app, ctx);
});

describe('/api/inbox', () => {
  it('lists with comma filters', async () => {
    const all = (await (await app.request('/api/inbox')).json()) as InboxItem[];
    expect(all).toHaveLength(2);
    const w = (await (await app.request('/api/inbox?state=open,snoozed&kind=waiting&projectId=wakecap')).json()) as InboxItem[];
    expect(w.map((i) => i.id)).toEqual([id]);
    expect((await app.request('/api/inbox?state=bogus')).status).toBe(400);
  });

  it('marks done, snoozes and reopens', async () => {
    const done = await post(`/api/inbox/${id}/done`, {});
    expect(((await done.json()) as InboxItem).state).toBe('done');
    const reopened = await post(`/api/inbox/${id}/reopen`, {});
    expect(((await reopened.json()) as InboxItem).state).toBe('open');
    const until = new Date(Date.now() + 3600_000).toISOString();
    const snoozed = await post(`/api/inbox/${id}/snooze`, { until });
    expect(await snoozed.json()).toMatchObject({ state: 'snoozed', snoozeUntil: until });
  });

  it('validates snooze and unknown ids', async () => {
    expect((await post(`/api/inbox/${id}/snooze`, {})).status).toBe(400);
    const past = await post(`/api/inbox/${id}/snooze`, { until: '2000-01-01T00:00:00.000Z' });
    expect(past.status).toBe(400);
    const missing = await post('/api/inbox/nope/done', {});
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('not_found');
    expect((await post(`/api/inbox/${id}/explode`, {})).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/inbox/rules apps/daemon/src/http/routes/inbox.test.ts`
Expected: FAIL, `Cannot find module './status-rules.ts'` / `'./inbox.ts'`

- [ ] **Step 3: Implement the rules**

`apps/daemon/src/inbox/rules/status-rules.ts`
```ts
import { type InboxKind, type LiveStatus, type Session, splitPk } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { previousTestResult } from '../../db/repos/test-results.ts';
import type { InboxEngine, InboxRule } from '../engine.ts';

export const STATUS_KIND: Partial<Record<LiveStatus, InboxKind>> = {
  waiting: 'waiting',
  review: 'review',
  error: 'error',
};

export const dedupeKeyFor = (kind: InboxKind, pk: string): string => `${kind}:${pk}`;

function lookup(ctx: DaemonContext, pk: string): { s: Session | null; source: string; id: string; label: string } {
  const { source, id } = splitPk(pk);
  const s = ctx.live?.get(pk) ?? ctx.sessions.getByPk(pk);
  return { s, source, id, label: s?.name ?? id };
}

function reasonFor(kind: InboxKind, label: string, s: Session | null): string {
  switch (kind) {
    case 'waiting':
      return `${label}: waiting — ${s?.live?.waitingFor ?? 'input needed'}`;
    case 'review': {
      const t = s?.lastTest;
      return `${label}: ready for review${t ? ` (tests ✓${t.passed} ✗${t.failed})` : ''}`;
    }
    case 'error':
      return `${label}: API error or crash`;
    default:
      return `${label}: ${kind}`;
  }
}

export const statusRule: InboxRule = {
  name: 'status',
  on: ['session.statusChanged'],
  handle(e, ctx) {
    if (e.type !== 'session.statusChanged' || !ctx.inbox) return;
    const fromKind = e.from ? STATUS_KIND[e.from] : undefined;
    const toKind = STATUS_KIND[e.to];
    const keepReviewAfterExit = fromKind === 'review' && e.to === 'ended';
    if (fromKind && fromKind !== toKind && !keepReviewAfterExit) ctx.inbox.resolve(dedupeKeyFor(fromKind, e.pk));
    if (!toKind) return;
    const { s, source, id, label } = lookup(ctx, e.pk);
    ctx.inbox.upsert({
      kind: toKind,
      dedupeKey: dedupeKeyFor(toKind, e.pk),
      sessionId: id,
      projectId: s?.projectId ?? null,
      ticket: s?.tickets[0] ?? null,
      reason: reasonFor(toKind, label, s),
      payload: { source, id, status: e.to },
    });
  },
};

export const testsRedRule: InboxRule = {
  name: 'tests_red',
  on: ['tests.recorded'],
  handle(e, ctx) {
    if (e.type !== 'tests.recorded' || !ctx.inbox) return;
    const key = dedupeKeyFor('tests_red', e.pk);
    if (e.result.failed === 0) {
      ctx.inbox.resolve(key);
      return;
    }
    const prev = previousTestResult(ctx.db, e.pk, e.result.ts);
    const alreadyRed = ctx.inbox.list({ state: ['open', 'snoozed'], kind: ['tests_red'] }).some((i) => i.dedupeKey === key);
    if (!alreadyRed && (!prev || prev.failed > 0)) return;
    const { s, source, id, label } = lookup(ctx, e.pk);
    ctx.inbox.upsert({
      kind: 'tests_red',
      dedupeKey: key,
      sessionId: id,
      projectId: s?.projectId ?? null,
      ticket: s?.tickets[0] ?? null,
      reason: `${label}: tests went red (✗${e.result.failed} · ✓${e.result.passed})`,
      payload: { source, id, command: e.result.command, previous: prev },
    });
  },
};

export function registerDefaultRules(engine: InboxEngine): void {
  engine.registerRule(statusRule);
  engine.registerRule(testsRedRule);
}
```

In the "refreshes while red" case, the second failing run's previous result also failed. `alreadyRed` keeps the item refreshed instead of skipping it.

- [ ] **Step 4: Implement the routes**

`apps/daemon/src/http/routes/inbox.ts`
```ts
import { InboxActionBody, InboxListQuery, apiError } from '@orc/api-contract';
import type { Hono } from 'hono';
import type { DaemonContext } from '../../context.ts';
import { InboxError } from '../../inbox/engine.ts';

export function registerInboxRoutes(app: Hono, ctx: DaemonContext): void {
  const engine = () => {
    if (!ctx.inbox) throw new Error('inbox engine not initialised');
    return ctx.inbox;
  };

  app.get('/api/inbox', (c) => {
    const q = InboxListQuery.safeParse(c.req.query());
    if (!q.success) return c.json(apiError('validation_failed', 'invalid inbox filter', q.error.issues), 400);
    return c.json(engine().list(q.data));
  });

  app.post('/api/inbox/:id/:action{done|snooze|reopen}', async (c) => {
    const id = c.req.param('id');
    const action = c.req.param('action');
    const body = InboxActionBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json(apiError('validation_failed', 'invalid body', body.error.issues), 400);
    try {
      if (action === 'done') return c.json(engine().markDone(id));
      if (action === 'reopen') return c.json(engine().reopen(id));
      if (!body.data.until) return c.json(apiError('validation_failed', 'snooze requires "until"'), 400);
      return c.json(engine().snooze(id, body.data.until));
    } catch (err) {
      if (err instanceof InboxError) return c.json(apiError(err.code, err.message), err.status);
      throw err;
    }
  });
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/inbox apps/daemon/src/http/routes/inbox.test.ts`
Expected: PASS (all inbox tests; 6 rule tests + 3 route tests are new)

- [ ] **Step 6: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon/src/inbox apps/daemon/src/http/routes/inbox.ts apps/daemon/src/http/routes/inbox.test.ts
git commit -m "feat(daemon): add inbox rules for waiting, review, error and red tests plus inbox routes"
```

---

### Task 11: daemon — Notifier, macOS channel and notification preferences

**Files:**
- Modify: `apps/daemon/src/notify/notifier.ts` (add the implementation below the Task 9 types)
- Create: `apps/daemon/src/notify/macos.ts`
- Create: `apps/daemon/src/notify/notify.test.ts`
- Create: `apps/daemon/src/http/routes/notifications.ts`, `apps/daemon/src/http/routes/notifications.test.ts`
- Modify: `apps/daemon/package.json` (`node-notifier`, `@types/node-notifier`)

**Interfaces:**
- Consumes: `OrcConfig` (contracts §3; `config.notifications` = `Record<string, { enabled; channels }>`, `config.port`); `InboxItem`, `InboxKind` (core); `NotificationPrefs`, `InboxKindSchema`, `apiError` (Task 2); `DaemonContext.updateConfig` (contract addition)
- Produces:
  ```ts
  // notify/notifier.ts (in addition to the contract types)
  export interface NotifyPref { enabled: boolean; channels: NotifyChannel[] }
  export const DEFAULT_NOTIFY_PREFS: Partial<Record<InboxKind, NotifyPref>>
  export function prefFor(cfg: OrcConfig, kind: InboxKind): NotifyPref
  export function notificationUrl(item: InboxItem, port: number): string
  export function createNotifier(opts: { config: () => OrcConfig; log?: { warn(o: object, msg?: string): void }; debounceMs?: number; now?: () => number }): Notifier
  // notify/macos.ts
  export interface NodeNotifierLike { notify(o: { title: string; message: string; open?: string; sound?: boolean; wait?: boolean; group?: string }, cb?: (err: Error | null) => void): unknown }
  export const KIND_TITLE: Record<InboxKind, string>
  export function createMacosChannel(opts?: { impl?: NodeNotifierLike; platform?: NodeJS.Platform }): NotifyChannelImpl
  // http/routes/notifications.ts
  export function effectivePrefs(cfg: OrcConfig): NotificationPrefs
  export function registerNotificationRoutes(app: Hono, ctx: DaemonContext): void
  ```

**Behaviour:**
- **Preferences:** `config.notifications[kind]` wins. Otherwise the default is `{ enabled: true, channels: ['macos'] }` for `waiting`, `review`, `error`, `tests_red`, `plan_approval` and `blocked`. Every other kind is off.
- **Debounce:** at most one notification per `dedupeKey` per `debounceMs` (default 30 s). This covers a session flapping waiting→busy→waiting, which creates a new inbox item each time.
- **Away mode:** `setAway(true)` suppresses the `macos` channel. The away channels (web push, Slack DM) come in Phase 6.
- **Click target:** `http://127.0.0.1:<config.port>/sessions/<payload.source>/<payload.id>`, or `/inbox` when the item has no session.
- **Failures:** a channel failure is logged and swallowed.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/notify/notify.test.ts`
```ts
import { OrcConfig } from '@orc/api-contract';
import type { InboxItem } from '@orc/core';
import { describe, expect, it, vi } from 'vitest';
import { type NodeNotifierLike, createMacosChannel } from './macos.ts';
import { type NotifyChannelImpl, createNotifier, notificationUrl } from './notifier.ts';

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'i1', kind: 'waiting', sessionId: 's-basic', projectId: 'wakecap', ticket: null, reason: 'Waiting',
  dedupeKey: 'waiting:claude:s-basic', createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-01T09:00:00.000Z',
  state: 'open', snoozeUntil: null, payload: { source: 'claude', id: 's-basic' }, ...over,
});

function setup(cfgInput: unknown = {}) {
  let now = 0;
  const cfg = OrcConfig.parse(cfgInput);
  const send = vi.fn<NotifyChannelImpl['send']>(async () => {});
  const warn = vi.fn();
  const n = createNotifier({ config: () => cfg, log: { warn }, now: () => now, debounceMs: 30_000 });
  n.register({ id: 'macos', send });
  return { n, send, warn, tick: (ms: number) => { now += ms; } };
}

describe('notificationUrl', () => {
  it('links to the session or the inbox', () => {
    expect(notificationUrl(item(), 4317)).toBe('http://127.0.0.1:4317/sessions/claude/s-basic');
    expect(notificationUrl(item({ sessionId: null, payload: {} }), 4317)).toBe('http://127.0.0.1:4317/inbox');
  });
});

describe('createNotifier', () => {
  it('sends enabled kinds to their channels with the click URL', async () => {
    const { n, send } = setup();
    await n.notify(item());
    expect(send).toHaveBeenCalledWith(item(), 'http://127.0.0.1:4317/sessions/claude/s-basic');
  });

  it('skips disabled kinds and kinds without defaults', async () => {
    const { n, send } = setup({ notifications: { waiting: { enabled: false, channels: ['macos'] } } });
    await n.notify(item());
    await n.notify(item({ kind: 'reminder', dedupeKey: 'reminder:x' }));
    expect(send).not.toHaveBeenCalled();
  });

  it('debounces per dedupe key', async () => {
    const { n, send, tick } = setup();
    await n.notify(item());
    tick(10_000);
    await n.notify(item({ id: 'i2' }));
    await n.notify(item({ id: 'i3', dedupeKey: 'review:claude:s-basic', kind: 'review' }));
    expect(send).toHaveBeenCalledTimes(2);
    tick(20_000);
    await n.notify(item({ id: 'i4' }));
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('suppresses macOS while away and ignores unregistered channels', async () => {
    const { n, send } = setup({ notifications: { review: { enabled: true, channels: ['webpush', 'macos'] } } });
    n.setAway(true);
    expect(n.isAway()).toBe(true);
    await n.notify(item({ kind: 'review', dedupeKey: 'review:x' }));
    expect(send).not.toHaveBeenCalled();
    n.setAway(false);
    await n.notify(item({ kind: 'review', dedupeKey: 'review:y' }));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('logs channel failures without throwing', async () => {
    const { n, send, warn } = setup();
    send.mockRejectedValueOnce(new Error('denied'));
    await expect(n.notify(item())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('createMacosChannel', () => {
  it('does nothing off macOS', async () => {
    const impl: NodeNotifierLike = { notify: vi.fn() };
    await createMacosChannel({ impl, platform: 'linux' }).send(item(), 'http://x');
    expect(impl.notify).not.toHaveBeenCalled();
  });

  it('posts a grouped notification that opens the URL', async () => {
    const notify = vi.fn((_o: Parameters<NodeNotifierLike['notify']>[0], cb?: (err: Error | null) => void) => cb?.(null));
    await createMacosChannel({ impl: { notify }, platform: 'darwin' }).send(item({ reason: 'SLA: waiting — input needed' }), 'http://127.0.0.1:4317/sessions/claude/s-basic');
    expect(notify.mock.calls[0]?.[0]).toEqual({
      title: 'Orchestrator · Waiting for you',
      message: 'SLA: waiting — input needed',
      open: 'http://127.0.0.1:4317/sessions/claude/s-basic',
      sound: true,
      wait: false,
      group: 'waiting:claude:s-basic',
    });
  });

  it('rejects when node-notifier reports an error', async () => {
    const impl: NodeNotifierLike = { notify: (_o, cb) => cb?.(new Error('no permission')) };
    await expect(createMacosChannel({ impl, platform: 'darwin' }).send(item(), 'u')).rejects.toThrow('no permission');
  });
});
```

`apps/daemon/src/http/routes/notifications.test.ts`
```ts
import type { OrcConfig } from '@orc/api-contract';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, useTempHomes } from '../../../test/helpers.ts';
import type { DaemonContext } from '../../context.ts';
import { registerNotificationRoutes } from './notifications.ts';

useTempHomes();
let ctx: DaemonContext;
let app: Hono;
let cfg: OrcConfig;
const put = (body: unknown) =>
  app.request('/api/config/notifications', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  ctx = createTestContext();
  cfg = ctx.config();
  ctx.config = () => cfg;
  ctx.updateConfig = (fn) => {
    cfg = fn(cfg);
    return cfg;
  };
  app = new Hono();
  registerNotificationRoutes(app, ctx);
});

describe('/api/config/notifications', () => {
  it('returns defaults merged with config', async () => {
    const body = (await (await app.request('/api/config/notifications')).json()) as Record<string, { enabled: boolean }>;
    expect(body.waiting).toEqual({ enabled: true, channels: ['macos'] });
    expect(body.tests_red?.enabled).toBe(true);
  });

  it('saves preferences through updateConfig', async () => {
    const res = await put({ waiting: { enabled: false, channels: [] }, review: { enabled: true, channels: ['macos'] } });
    expect(res.status).toBe(200);
    expect(cfg.notifications.waiting).toEqual({ enabled: false, channels: [] });
    const body = (await res.json()) as Record<string, { enabled: boolean }>;
    expect(body.waiting?.enabled).toBe(false);
    expect(body.error?.enabled).toBe(true);
  });

  it('rejects unknown kinds and bad channels', async () => {
    expect((await put({ sleeping: { enabled: true, channels: [] } })).status).toBe(400);
    expect((await put({ waiting: { enabled: true, channels: ['fax'] } })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/notify apps/daemon/src/http/routes/notifications.test.ts`
Expected: FAIL, `Cannot find module './macos.ts'` / `createNotifier is not a function`

- [ ] **Step 3: Implement the notifier**

Run: `pnpm --filter @orc/daemon add node-notifier@^10.0.1 && pnpm --filter @orc/daemon add -D @types/node-notifier`

Replace `apps/daemon/src/notify/notifier.ts` with this (it keeps the Task 9 types):
```ts
import type { OrcConfig } from '@orc/api-contract';
import type { InboxItem, InboxKind } from '@orc/core';

export type NotifyChannel = 'macos' | 'webpush' | 'slack_dm';
export interface NotifyChannelImpl {
  id: NotifyChannel;
  send(item: InboxItem, url: string): Promise<void>;
}
export interface Notifier {
  notify(item: InboxItem): Promise<void>;
  register(channel: NotifyChannelImpl): void;
  setAway(away: boolean): void;
  isAway(): boolean;
}

export interface NotifyPref {
  enabled: boolean;
  channels: NotifyChannel[];
}

const ON: NotifyPref = { enabled: true, channels: ['macos'] };
export const DEFAULT_NOTIFY_PREFS: Partial<Record<InboxKind, NotifyPref>> = {
  waiting: ON,
  review: ON,
  error: ON,
  tests_red: ON,
  plan_approval: ON,
  blocked: ON,
};

export function prefFor(cfg: OrcConfig, kind: InboxKind): NotifyPref {
  return cfg.notifications[kind] ?? DEFAULT_NOTIFY_PREFS[kind] ?? { enabled: false, channels: [] };
}

export function notificationUrl(item: InboxItem, port: number): string {
  const base = `http://127.0.0.1:${port}`;
  const source = typeof item.payload.source === 'string' ? item.payload.source : null;
  const id = typeof item.payload.id === 'string' ? item.payload.id : item.sessionId;
  return source && id ? `${base}/sessions/${source}/${encodeURIComponent(id)}` : `${base}/inbox`;
}

export function createNotifier(opts: {
  config: () => OrcConfig;
  log?: { warn(o: object, msg?: string): void };
  debounceMs?: number;
  now?: () => number;
}): Notifier {
  const channels = new Map<NotifyChannel, NotifyChannelImpl>();
  const lastSent = new Map<string, number>();
  const debounceMs = opts.debounceMs ?? 30_000;
  const now = opts.now ?? Date.now;
  let away = false;

  return {
    register(ch) {
      channels.set(ch.id, ch);
    },
    setAway(v) {
      away = v;
    },
    isAway: () => away,
    async notify(item) {
      const cfg = opts.config();
      const pref = prefFor(cfg, item.kind);
      if (!pref.enabled || pref.channels.length === 0) return;
      const t = now();
      const prev = lastSent.get(item.dedupeKey);
      if (prev !== undefined && t - prev < debounceMs) return;
      lastSent.set(item.dedupeKey, t);
      if (lastSent.size > 2000) lastSent.delete(lastSent.keys().next().value as string);
      const url = notificationUrl(item, cfg.port);
      for (const id of pref.channels) {
        if (away && id === 'macos') continue;
        const ch = channels.get(id);
        if (!ch) continue;
        try {
          await ch.send(item, url);
        } catch (err) {
          opts.log?.warn({ err: String(err), channel: id, kind: item.kind }, 'notification channel failed');
        }
      }
    },
  };
}
```

`apps/daemon/src/notify/macos.ts`
```ts
import type { InboxKind } from '@orc/core';
import nodeNotifier from 'node-notifier';
import type { NotifyChannelImpl } from './notifier.ts';

export interface NodeNotifierLike {
  notify(
    o: { title: string; message: string; open?: string; sound?: boolean; wait?: boolean; group?: string },
    cb?: (err: Error | null) => void,
  ): unknown;
}

export const KIND_TITLE: Record<InboxKind, string> = {
  waiting: 'Waiting for you',
  review: 'Ready for review',
  plan_approval: 'Plan awaiting approval',
  blocked: 'Blocked',
  error: 'Error',
  tests_red: 'Tests went red',
  budget: 'Budget',
  automation_result: 'Automation finished',
  supervisor_escalation: 'Supervisor escalation',
  pr_event: 'Pull request',
  reminder: 'Reminder',
};

export function createMacosChannel(opts: { impl?: NodeNotifierLike; platform?: NodeJS.Platform } = {}): NotifyChannelImpl {
  const impl = opts.impl ?? (nodeNotifier as unknown as NodeNotifierLike);
  const platform = opts.platform ?? process.platform;
  return {
    id: 'macos',
    send(item, url) {
      if (platform !== 'darwin') return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        impl.notify(
          {
            title: `Orchestrator · ${KIND_TITLE[item.kind]}`,
            message: item.reason,
            open: url,
            sound: item.kind === 'waiting',
            wait: false,
            group: item.dedupeKey,
          },
          (err) => (err ? reject(err) : resolve()),
        );
      });
    },
  };
}
```

`apps/daemon/src/http/routes/notifications.ts`
```ts
import { InboxKindSchema, NotificationPrefs, type OrcConfig, apiError } from '@orc/api-contract';
import type { Hono } from 'hono';
import type { DaemonContext } from '../../context.ts';
import { DEFAULT_NOTIFY_PREFS } from '../../notify/notifier.ts';

const KINDS = new Set<string>(InboxKindSchema.options);

export function effectivePrefs(cfg: OrcConfig): NotificationPrefs {
  const out: NotificationPrefs = {};
  for (const [k, v] of Object.entries(DEFAULT_NOTIFY_PREFS)) if (v) out[k] = { enabled: v.enabled, channels: [...v.channels] };
  return { ...out, ...cfg.notifications };
}

export function registerNotificationRoutes(app: Hono, ctx: DaemonContext): void {
  app.get('/api/config/notifications', (c) => c.json(effectivePrefs(ctx.config())));

  app.put('/api/config/notifications', async (c) => {
    const parsed = NotificationPrefs.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(apiError('validation_failed', 'invalid notification preferences', parsed.error.issues), 400);
    const unknown = Object.keys(parsed.data).filter((k) => !KINDS.has(k));
    if (unknown.length) return c.json(apiError('validation_failed', `unknown inbox kinds: ${unknown.join(', ')}`), 400);
    if (!ctx.updateConfig) return c.json(apiError('config_readonly', 'config cannot be updated'), 503);
    const next = ctx.updateConfig((cur) => ({ ...cur, notifications: parsed.data }));
    return c.json(effectivePrefs(next));
  });
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/notify apps/daemon/src/http/routes/notifications.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Check a real macOS notification (manual)**

```bash
cd /Users/hazem/orchestrator && pnpm dlx tsx -e "import('./apps/daemon/src/notify/macos.ts').then(m => m.createMacosChannel().send({ id:'x', kind:'waiting', sessionId:'demo', projectId:null, ticket:null, reason:'Demo: waiting — input needed', dedupeKey:'waiting:claude:demo', createdAt:'', updatedAt:'', state:'open', snoozeUntil:null, payload:{} }, 'http://127.0.0.1:4317/inbox'))"
```
Expected: a macOS notification titled "Orchestrator · Waiting for you". Clicking it opens the URL in the browser (a "can't connect" page is fine if the daemon isn't running). Put a screenshot in the review note. If macOS blocks it, allow `terminal-notifier` in System Settings → Notifications, and write that down.

- [ ] **Step 6: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon/src/notify apps/daemon/src/http/routes/notifications.ts apps/daemon/src/http/routes/notifications.test.ts apps/daemon/package.json pnpm-lock.yaml
git commit -m "feat(daemon): add notifier with macOS channel, debounce and per-kind preferences"
```

---

### Task 12: daemon — TemplateRegistry (workflow templates + task presets) and `GET /api/templates`

**Files:**
- Create: `apps/daemon/src/services/templates.ts`, `apps/daemon/src/services/templates.test.ts`
- Create: `apps/daemon/src/http/routes/templates.ts`, `apps/daemon/src/http/routes/templates.test.ts`

**Interfaces:**
- Consumes: `Source` (core); `apiError` (api-contract)
- Produces (contracts §11, plus helpers):
  ```ts
  export interface Template { id: string; kind: 'workflow' | 'preset'; label: string; prompt: string; vars: Array<'ticket' | 'ticketUrl' | 'prUrl' | 'file' | 'check'>; defaultSource: Source; projectIds: string[] | 'all' }
  export interface TemplateRegistry { list(projectId?: string): Template[]; render(id: string, vars: Record<string, string>): string }
  export class TemplateError extends Error { readonly status: 400 | 404; readonly code: 'template_not_found' | 'template_var_missing'; readonly missing: string[] }
  export const BUILTIN_TEMPLATES: readonly Template[]
  export function createTemplateRegistry(opts?: { extra?: Template[] }): TemplateRegistry
  export function composePrompt(rendered: string | null, userPrompt: string): string
  export function registerTemplateRoutes(app: Hono, ctx: DaemonContext): void
  ```

**Built-ins (docs/02 F4):**

| id | kind | label | prompt |
|---|---|---|---|
| `wf-implement-ticket` | workflow | Implement ticket | `/conductor {{ticketUrl}}` |
| `wf-investigate` | workflow | Investigate | `/investigate {{ticket}}` |
| `wf-backmerge` | workflow | Backmerge | `/backmerge {{prUrl}}` |
| `wf-plan` | workflow | Plan | `Use superpowers:brainstorming to plan {{ticket}}.` |
| `wf-review-pr` | workflow | Review PR | `review this pr {{prUrl}}` |
| `preset-fix-failing-test` | preset | Fix the failing test | see code |
| `preset-add-missing-test` | preset | Add the missing test | see code |
| `preset-simplify` | preset | Simplify this function/file | see code |
| `preset-address-review` | preset | Address PR review comments | see code |
| `preset-fix-ci` | preset | Fix CI failure | see code |

`{{ticketUrl}}` falls back to `{{ticket}}` when no URL is given, so "Implement ticket" works with just `SAF-1787`.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/services/templates.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES, TemplateError, composePrompt, createTemplateRegistry } from './templates.ts';

describe('TemplateRegistry', () => {
  const reg = createTemplateRegistry({
    extra: [{ id: 'forza-only', kind: 'preset', label: 'Forza', prompt: 'x', vars: [], defaultSource: 'codex', projectIds: ['forza'] }],
  });

  it('lists the five workflows and five presets from the spec', () => {
    const builtins = BUILTIN_TEMPLATES.map((t) => `${t.kind}:${t.label}`);
    expect(builtins).toEqual([
      'workflow:Implement ticket',
      'workflow:Investigate',
      'workflow:Backmerge',
      'workflow:Plan',
      'workflow:Review PR',
      'preset:Fix the failing test',
      'preset:Add the missing test',
      'preset:Simplify this function/file',
      'preset:Address PR review comments',
      'preset:Fix CI failure',
    ]);
  });

  it('filters by project', () => {
    expect(reg.list('wakecap').some((t) => t.id === 'forza-only')).toBe(false);
    expect(reg.list('forza').some((t) => t.id === 'forza-only')).toBe(true);
    expect(reg.list()).toHaveLength(11);
  });

  it('renders variables', () => {
    expect(reg.render('wf-implement-ticket', { ticketUrl: 'https://linear.app/wakecap/issue/SAF-1787' })).toBe(
      '/conductor https://linear.app/wakecap/issue/SAF-1787',
    );
    expect(reg.render('wf-implement-ticket', { ticket: 'SAF-1787' })).toBe('/conductor SAF-1787');
    expect(reg.render('wf-review-pr', { prUrl: 'https://github.com/example-org/r/pull/1' })).toBe(
      'review this pr https://github.com/example-org/r/pull/1',
    );
    expect(reg.render('preset-fix-ci', { prUrl: 'https://github.com/example-org/r/pull/1', check: 'build' })).toContain(
      'Fix the CI failure "build" on https://github.com/example-org/r/pull/1',
    );
  });

  it('reports missing variables and unknown templates', () => {
    const missing = (() => {
      try {
        reg.render('preset-fix-ci', { prUrl: 'u', check: '  ' });
      } catch (e) {
        return e;
      }
    })();
    expect(missing).toBeInstanceOf(TemplateError);
    expect(missing).toMatchObject({ status: 400, code: 'template_var_missing', missing: ['check'] });
    const notFound = (() => {
      try {
        reg.render('nope', {});
      } catch (e) {
        return e;
      }
    })();
    expect(notFound).toMatchObject({ status: 404, code: 'template_not_found' });
  });
});

describe('composePrompt', () => {
  it('joins the rendered template and the user prompt', () => {
    expect(composePrompt('/conductor SAF-1', 'focus on the API')).toBe('/conductor SAF-1\n\nfocus on the API');
    expect(composePrompt(null, ' hi ')).toBe('hi');
    expect(composePrompt('/x', '')).toBe('/x');
    expect(composePrompt(null, '')).toBe('');
  });
});
```

`apps/daemon/src/http/routes/templates.test.ts`
```ts
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createTestContext, useTempHomes } from '../../../test/helpers.ts';
import { createTemplateRegistry } from '../../services/templates.ts';
import { registerTemplateRoutes } from './templates.ts';

useTempHomes();

describe('GET /api/templates', () => {
  it('returns the templates for a project', async () => {
    const ctx = createTestContext();
    ctx.templates = createTemplateRegistry();
    const app = new Hono();
    registerTemplateRoutes(app, ctx);
    const body = (await (await app.request('/api/templates?projectId=wakecap')).json()) as Array<{ id: string }>;
    expect(body.map((t) => t.id)).toContain('wf-implement-ticket');
    expect(body).toHaveLength(10);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/services/templates.test.ts apps/daemon/src/http/routes/templates.test.ts`
Expected: FAIL, `Cannot find module './templates.ts'`

- [ ] **Step 3: Implement the registry and the route**

`apps/daemon/src/services/templates.ts`
```ts
import type { Source } from '@orc/core';

export type TemplateVar = 'ticket' | 'ticketUrl' | 'prUrl' | 'file' | 'check';
export interface Template {
  id: string;
  kind: 'workflow' | 'preset';
  label: string;
  prompt: string;
  vars: TemplateVar[];
  defaultSource: Source;
  projectIds: string[] | 'all';
}
export interface TemplateRegistry {
  list(projectId?: string): Template[];
  render(id: string, vars: Record<string, string>): string;
}

export class TemplateError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: 'template_not_found' | 'template_var_missing',
    message: string,
    readonly missing: string[] = [],
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

const wf = (id: string, label: string, prompt: string, vars: TemplateVar[]): Template => ({
  id, kind: 'workflow', label, prompt, vars, defaultSource: 'claude', projectIds: 'all',
});
const preset = (id: string, label: string, prompt: string, vars: TemplateVar[]): Template => ({
  id, kind: 'preset', label, prompt, vars, defaultSource: 'claude', projectIds: 'all',
});

export const BUILTIN_TEMPLATES: readonly Template[] = [
  wf('wf-implement-ticket', 'Implement ticket', '/conductor {{ticketUrl}}', ['ticketUrl']),
  wf('wf-investigate', 'Investigate', '/investigate {{ticket}}', ['ticket']),
  wf('wf-backmerge', 'Backmerge', '/backmerge {{prUrl}}', ['prUrl']),
  wf('wf-plan', 'Plan', 'Use superpowers:brainstorming to plan {{ticket}}.', ['ticket']),
  wf('wf-review-pr', 'Review PR', 'review this pr {{prUrl}}', ['prUrl']),
  preset(
    'preset-fix-failing-test',
    'Fix the failing test',
    'Fix the failing test in {{file}}. Run it first to see the failure, find the root cause, fix the code (change the test only if the test itself is wrong), and re-run until it passes.',
    ['file'],
  ),
  preset(
    'preset-add-missing-test',
    'Add the missing test',
    'Add the missing test for {{file}}. Follow the existing test conventions in this repo, cover the main behaviour and the edge cases, and run the tests.',
    ['file'],
  ),
  preset(
    'preset-simplify',
    'Simplify this function/file',
    'Simplify {{file}} without changing its behaviour. Keep the public API, remove duplication and dead code, and run the tests before and after.',
    ['file'],
  ),
  preset(
    'preset-address-review',
    'Address PR review comments',
    'Address the review comments on {{prUrl}}. Read every unresolved comment with `gh`, fix each one, run the tests, and summarise what changed for each comment.',
    ['prUrl'],
  ),
  preset(
    'preset-fix-ci',
    'Fix CI failure',
    'Fix the CI failure "{{check}}" on {{prUrl}}. Read the failing logs with `gh pr checks` and `gh run view --log-failed`, reproduce it locally, fix it, and re-run the check.',
    ['prUrl', 'check'],
  ),
];

const ALIASES: Partial<Record<TemplateVar, TemplateVar>> = { ticketUrl: 'ticket' };

export function createTemplateRegistry(opts: { extra?: Template[] } = {}): TemplateRegistry {
  const all: Template[] = [...BUILTIN_TEMPLATES, ...(opts.extra ?? [])];
  return {
    list(projectId) {
      return all.filter((t) => t.projectIds === 'all' || (projectId !== undefined ? t.projectIds.includes(projectId) : true));
    },
    render(id, vars) {
      const t = all.find((x) => x.id === id);
      if (!t) throw new TemplateError(404, 'template_not_found', `template ${id} not found`);
      const value = (name: TemplateVar): string => {
        const direct = vars[name]?.trim();
        if (direct) return direct;
        const alias = ALIASES[name];
        return alias ? (vars[alias]?.trim() ?? '') : '';
      };
      const missing = t.vars.filter((v) => value(v) === '');
      if (missing.length) {
        throw new TemplateError(400, 'template_var_missing', `missing template variables: ${missing.join(', ')}`, missing);
      }
      return t.prompt.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => value(name as TemplateVar));
    },
  };
}

export function composePrompt(rendered: string | null, userPrompt: string): string {
  return [rendered?.trim() ?? '', userPrompt.trim()].filter(Boolean).join('\n\n');
}
```

`apps/daemon/src/http/routes/templates.ts`
```ts
import type { Hono } from 'hono';
import type { DaemonContext } from '../../context.ts';

export function registerTemplateRoutes(app: Hono, ctx: DaemonContext): void {
  app.get('/api/templates', (c) => c.json(ctx.templates?.list(c.req.query('projectId') || undefined) ?? []));
}
```

Make sure `DaemonContext.templates?` imports `TemplateRegistry` from `./services/templates.ts`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/services/templates.test.ts apps/daemon/src/http/routes/templates.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon/src/services/templates.ts apps/daemon/src/services/templates.test.ts apps/daemon/src/http/routes/templates.ts apps/daemon/src/http/routes/templates.test.ts apps/daemon/src/context.ts
git commit -m "feat(daemon): add workflow templates and task presets"
```

---

### Task 13: daemon — fake CLIs, LaunchService, and the launch / kill / open-in routes

**Files:**
- Create: `apps/daemon/test/bin/claude`, `apps/daemon/test/bin/codex` (executable)
- Create: `apps/daemon/src/services/launch.ts`, `apps/daemon/src/services/launch.test.ts`
- Create: `apps/daemon/src/services/open-in.ts`
- Create: `apps/daemon/src/http/routes/launch.ts`, `apps/daemon/src/http/routes/launch.test.ts`
- Create: `apps/daemon/test/launch-integration.test.ts`
- Modify: `apps/daemon/src/context.ts` (add `launcher?: LaunchService`)

**Interfaces:**
- Consumes:
  - `LaunchRequest`, `ConfirmBody`, `OpenInBody`, `OpenInApp`, `apiError` (Task 2)
  - `OrcConfig.resumeProfile` and `ProjectConfig.maxConcurrentOwned`/`openIn` (contracts §3)
  - `PtyManager.spawn/list/kill` (contracts §7)
  - `ProjectService.resolve/get/update`, `SessionService.get` (contracts §11)
  - `LiveTracker.get/waitForPid` (Task 7); `TemplateRegistry`, `TemplateError`, `composePrompt`, `createTemplateRegistry` (Task 12)
  - `ExecFn`, `defaultExec`, `createLivenessChecker` (Task 5); `createRegistryWatcher` (Task 5); `createLiveTracker` (Task 7)
  - `createFakePty` (Task 7), `createFakeLive` (Task 8)
- Produces:
  ```ts
  // services/launch.ts
  export class LaunchError extends Error { readonly status: 400 | 404 | 409 | 429 | 501 | 503; readonly code: string; readonly details?: unknown }
  export function buildLaunchCommand(cfg: OrcConfig, req: { source: 'claude' | 'codex'; model?: string; prompt: string }): { command: string; args: string[] }
  export interface LaunchResult { ptyId: string; sessionId: string | null }
  export interface LaunchService { launch(req: LaunchRequest): Promise<LaunchResult>; kill(source: Source, id: string): Promise<{ killed: 'pty' | 'pid' }>; ownedCount(projectId: string | null): number }
  export function createLaunchService(ctx: DaemonContext, opts?: { discoverTimeoutMs?: number; killPid?: (pid: number) => void }): LaunchService
  // services/open-in.ts
  export function openInCommand(app: OpenInApp, path: string, platform?: NodeJS.Platform): { command: string; args: string[] }
  export async function openIn(app: OpenInApp, path: string, exec?: ExecFn): Promise<void>
  // http/routes/launch.ts
  export function registerLaunchRoutes(app: Hono, ctx: DaemonContext, opts?: { exec?: ExecFn }): void
  ```

**Decisions:**
- **Concurrency cap → `429 concurrency_limit`, no queue.** The count covers PTYs that haven't exited, whose command is the configured `claude` or `codex` command, and whose cwd resolves to the same project. The cap is that project's `maxConcurrentOwned` (default 6). `details = { projectId, max, running }`. The check and the spawn run in the same synchronous block, so two concurrent requests can't both slip under the cap.
- **Phases 4/7 fields:** `planApproval: true`, `worktree` and `compare` → `501 not_implemented` with `details.field`.
- **Prompt:** the composed prompt (rendered template + `\n\n` + user prompt) becomes the **last argv element**. No shell is involved. A prompt starting with `-` is rejected (`400 validation_failed`) so it can't be read as a flag.
- **Command lines:**
  - Claude: `[...resumeProfile.claudeArgs, ('--model', model)?, prompt?]`
  - Codex: `[...resumeProfile.codexArgs, ('--model', model)?, prompt?]`
- **Session id discovery:**
  - Claude: `ctx.live.waitForPid(pty.pid, discoverTimeoutMs = 8000)`. On timeout the response has `sessionId: null`; the card still appears once the registry file shows up.
  - Codex: `sessionId: null`, because the rollout id is only known after the first write.
- **Kill:**
  - `confirm` is required.
  - Owned sessions → `pty.kill(ptyId, 'SIGTERM')`.
  - Observed sessions → `process.kill(pid, 'SIGTERM')`. The pid was verified alive with its `procStart` by the tracker in its last pass.
  - A session that isn't live or has ended → `404 not_live`.
  - Phase 3 wraps this with `audit.record({ action: 'session.kill' })`, and launches with `session.launch`.
- **Open-in:**
  - Uses the session's latest known cwd (`cwds.at(-1)`).
  - `vscode` → `code <path>`, `terminal` → `open -a Terminal <path>`, `finder` → `open <path>`.
  - With `remember` (the default), it saves the choice as the project's `openIn` through `ProjectService.update`.

- [ ] **Step 1: Write the fake CLIs**

`apps/daemon/test/bin/claude`
```bash
#!/usr/bin/env bash
# Fake `claude` for tests. It emulates what the real CLI leaves on disk:
# a registry entry in $CLAUDE_HOME/sessions/<pid>.json and a transcript under
# $CLAUDE_HOME/projects/-fake-project/<sessionId>.jsonl. It only ever writes into
# $CLAUDE_HOME, which tests point at a temp dir.
# The scenario is picked from the prompt (the last non-flag argument):
#   contains "wait" → registry status "waiting"
#   contains "fail" → an edit, a passing test run, then a failing run, then idle
#   anything else   → an edit, then idle (→ review)
set -u
home="${CLAUDE_HOME:?CLAUDE_HOME must be set}"
pid=$$
sid="fake-${pid}"
cwd="$(pwd -P)"
prompt=""
skip_next=0
for a in "$@"; do
  if [ "$skip_next" = 1 ]; then skip_next=0; continue; fi
  case "$a" in
    --model|--resume|-r) skip_next=1 ;;
    -*) ;;
    *) prompt="$a" ;;
  esac
done

reg_dir="$home/sessions"
proj_dir="$home/projects/-fake-project"
mkdir -p "$reg_dir" "$proj_dir"
reg="$reg_dir/$pid.json"
tr="$proj_dir/$sid.jsonl"
json() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }
iso() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
proc_start_j="$(json "$(LC_ALL=C ps -o lstart= -p "$pid" | sed 's/^ *//')")"
cwd_j="$(json "$cwd")"
prompt_j="$(json "$prompt")"
file_j="$(json "$cwd/file.txt")"
started="$(date +%s)000"

write_reg() { # $1 = status, $2 = waitingFor as JSON (or null)
  local now
  now="$(date +%s)000"
  printf '{"pid":%s,"procStart":%s,"sessionId":"%s","cwd":%s,"startedAt":%s,"version":"fake","kind":"interactive","entrypoint":"cli","name":"fake session","status":"%s","waitingFor":%s,"statusUpdatedAt":%s,"updatedAt":%s}' \
    "$pid" "$proc_start_j" "$sid" "$cwd_j" "$started" "$1" "$2" "$now" "$now" > "$reg.tmp"
  mv "$reg.tmp" "$reg"
}
append() { printf '%s\n' "$1" >> "$tr"; }
bash_run() { # $1 = tool id, $2 = output text
  append "{\"type\":\"assistant\",\"uuid\":\"a-$1\",\"parentUuid\":null,\"sessionId\":\"$sid\",\"timestamp\":\"$(iso)\",\"cwd\":$cwd_j,\"message\":{\"id\":\"m-$1\",\"role\":\"assistant\",\"model\":\"fake-model\",\"content\":[{\"type\":\"tool_use\",\"id\":\"$1\",\"name\":\"Bash\",\"input\":{\"command\":\"pnpm vitest run\"}}]}}"
  append "{\"type\":\"user\",\"uuid\":\"r-$1\",\"parentUuid\":null,\"sessionId\":\"$sid\",\"timestamp\":\"$(iso)\",\"cwd\":$cwd_j,\"toolUseResult\":{},\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"$1\",\"content\":\"$2\"}]}}"
}
cleanup() { rm -f "$reg" "$reg.tmp"; exit 0; }
trap cleanup TERM HUP INT

echo "fake claude $sid in $cwd"
write_reg busy null
append "{\"type\":\"user\",\"uuid\":\"u1\",\"parentUuid\":null,\"sessionId\":\"$sid\",\"timestamp\":\"$(iso)\",\"cwd\":$cwd_j,\"message\":{\"role\":\"user\",\"content\":$prompt_j}}"
append "{\"type\":\"agent-name\",\"agentName\":\"fake session\",\"sessionId\":\"$sid\"}"
sleep 1
case "$prompt" in
  *wait*)
    write_reg waiting '"input needed"'
    ;;
  *)
    append "{\"type\":\"assistant\",\"uuid\":\"a1\",\"parentUuid\":\"u1\",\"sessionId\":\"$sid\",\"timestamp\":\"$(iso)\",\"cwd\":$cwd_j,\"message\":{\"id\":\"m1\",\"role\":\"assistant\",\"model\":\"fake-model\",\"content\":[{\"type\":\"tool_use\",\"id\":\"e1\",\"name\":\"Edit\",\"input\":{\"file_path\":$file_j}}]}}"
    case "$prompt" in
      *fail*)
        bash_run t1 "      Tests  3 passed (3)"
        sleep 1
        bash_run t2 "      Tests  1 failed | 2 passed (3)"
        ;;
    esac
    append "{\"type\":\"system\",\"subtype\":\"turn_duration\",\"uuid\":\"s1\",\"parentUuid\":null,\"sessionId\":\"$sid\",\"timestamp\":\"$(iso)\",\"durationMs\":1000}"
    write_reg idle null
    ;;
esac
while true; do sleep 1 & wait $!; done
```

`apps/daemon/test/bin/codex`
```bash
#!/usr/bin/env bash
# Fake `codex` for tests: prints its arguments and idles until killed.
echo "fake codex in $(pwd -P) args: $*"
trap 'exit 0' TERM HUP INT
while true; do sleep 1 & wait $!; done
```

Run: `chmod +x apps/daemon/test/bin/claude apps/daemon/test/bin/codex`

- [ ] **Step 2: Write the failing unit tests**

`apps/daemon/src/services/launch.test.ts`
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrcConfig } from '@orc/api-contract';
import { LaunchRequest } from '@orc/api-contract';
import type { LiveState, Session } from '@orc/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLive } from '../../test/fake-live.ts';
import { createFakePty } from '../../test/fake-pty.ts';
import { createTestContext, useTempHomes } from '../../test/helpers.ts';
import type { DaemonContext } from '../context.ts';
import { stubSession } from '../live/stub-session.ts';
import { LaunchError, buildLaunchCommand, createLaunchService } from './launch.ts';
import { createTemplateRegistry } from './templates.ts';

useTempHomes();
let ctx: DaemonContext;
let pty: ReturnType<typeof createFakePty>;
let live: ReturnType<typeof createFakeLive>;
let cwd: string;
let cap: number;
const killPid = vi.fn();

const req = (over: Record<string, unknown> = {}) => LaunchRequest.parse({ source: 'claude', projectId: 'wakecap', cwd, ...over });
const errOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

beforeEach(() => {
  pty = createFakePty();
  ctx = createTestContext({ pty });
  live = createFakeLive();
  ctx.live = live;
  ctx.templates = createTemplateRegistry();
  cwd = mkdtempSync(join(tmpdir(), 'orc-launch-'));
  cap = 6;
  const real = ctx.projects;
  ctx.projects = {
    list: () => real.list(),
    resolve: () => 'wakecap',
    get: (id) => {
      const p = real.get(id);
      return p ? { ...p, maxConcurrentOwned: cap } : null;
    },
    update: (id, patch) => real.update(id, patch),
  };
  const base = ctx.config();
  const cfg: OrcConfig = { ...base, resumeProfile: { ...base.resumeProfile, claudeCommand: 'claude', codexCommand: 'codex' } };
  ctx.config = () => cfg;
  killPid.mockClear();
});

describe('buildLaunchCommand', () => {
  it('uses the resume profile, model and prompt', () => {
    const cfg = ctx.config();
    expect(buildLaunchCommand(cfg, { source: 'claude', model: 'claude-opus-5', prompt: 'hi' })).toEqual({
      command: 'claude',
      args: ['--dangerously-skip-permissions', '--model', 'claude-opus-5', 'hi'],
    });
    expect(buildLaunchCommand(cfg, { source: 'codex', prompt: '' })).toEqual({ command: 'codex', args: [] });
  });
});

describe('LaunchService.launch', () => {
  it('spawns claude in the cwd and discovers the session id', async () => {
    live.pids.set(90000, 's-new');
    const svc = createLaunchService(ctx, { discoverTimeoutMs: 50 });
    const out = await svc.launch(req({ templateId: 'wf-implement-ticket', ticket: 'SAF-1787', prompt: 'keep it small' }));
    expect(out).toEqual({ ptyId: 'pty-1', sessionId: 's-new' });
    expect(pty.spawned[0]).toMatchObject({
      command: 'claude',
      cwd,
      args: ['--dangerously-skip-permissions', '/conductor SAF-1787\n\nkeep it small'],
    });
  });

  it('launches codex without waiting for a session id', async () => {
    const out = await createLaunchService(ctx).launch(req({ source: 'codex', prompt: 'second opinion', model: 'gpt-5.5' }));
    expect(out.sessionId).toBeNull();
    expect(pty.spawned[0]).toMatchObject({ command: 'codex', args: ['--model', 'gpt-5.5', 'second opinion'] });
  });

  it('returns sessionId null when discovery times out', async () => {
    const out = await createLaunchService(ctx, { discoverTimeoutMs: 10 }).launch(req({ prompt: 'x' }));
    expect(out.sessionId).toBeNull();
  });

  it.each([
    [{ planApproval: true }, 'planApproval'],
    [{ worktree: { repo: '/r', base: 'main', type: 'feat', slug: 'x' } }, 'worktree'],
    [{ compare: [{ source: 'claude' }] }, 'compare'],
  ])('rejects %j with 501 until later phases', async (over, field) => {
    const err = await errOf(createLaunchService(ctx).launch(req(over)));
    expect(err).toBeInstanceOf(LaunchError);
    expect(err).toMatchObject({ status: 501, code: 'not_implemented', details: { field } });
    expect(pty.spawned).toHaveLength(0);
  });

  it('validates cwd, prompt and template variables', async () => {
    const svc = createLaunchService(ctx);
    expect(await errOf(svc.launch(req({ cwd: join(cwd, 'missing') })))).toMatchObject({ status: 400, code: 'cwd_not_found' });
    expect(await errOf(svc.launch(req({ cwd: 'relative/path' })))).toMatchObject({ status: 400, code: 'cwd_not_found' });
    expect(await errOf(svc.launch(req({ prompt: '--help' })))).toMatchObject({ status: 400, code: 'validation_failed' });
    expect(await errOf(svc.launch(req({ templateId: 'wf-review-pr' })))).toMatchObject({
      status: 400, code: 'template_var_missing', details: { missing: ['prUrl'] },
    });
    expect(await errOf(svc.launch(req({ templateId: 'nope' })))).toMatchObject({ status: 404, code: 'template_not_found' });
    expect(pty.spawned).toHaveLength(0);
  });

  it('enforces the per-project concurrency cap with 429', async () => {
    cap = 1;
    const svc = createLaunchService(ctx, { discoverTimeoutMs: 10 });
    const first = await svc.launch(req({ prompt: 'one' }));
    expect(svc.ownedCount('wakecap')).toBe(1);
    const err = await errOf(svc.launch(req({ prompt: 'two' })));
    expect(err).toMatchObject({ status: 429, code: 'concurrency_limit', details: { projectId: 'wakecap', max: 1, running: 1 } });
    pty.kill(first.ptyId);
    await expect(svc.launch(req({ prompt: 'three' }))).resolves.toMatchObject({ ptyId: 'pty-2' });
  });

  it('does not count non-agent PTYs', () => {
    pty.spawn({ command: 'bash', args: ['-lc', 'pnpm dev'], cwd });
    expect(createLaunchService(ctx).ownedCount('wakecap')).toBe(0);
  });
});

describe('LaunchService.kill', () => {
  const liveState = (over: Partial<LiveState>): LiveState => ({
    pid: 4242, status: 'busy', waitingFor: null, since: '', ownership: 'observed', ptyId: null, stage: null,
    currentTool: null, backgroundJobs: 0, runningSubagents: 0, contextFill: null, ...over,
  });
  const s = (id: string, l: Partial<LiveState>): Session => ({
    ...stubSession({ source: 'claude', id, cwd, startedAt: '', projectId: 'wakecap', name: id }),
    live: liveState(l),
  });

  it('kills owned sessions through the PTY and observed ones by pid', async () => {
    const info = pty.spawn({ command: 'claude', args: [], cwd });
    live.sessions = [s('owned', { ownership: 'owned', ptyId: info.id, pid: info.pid }), s('observed', {}), s('gone', { status: 'ended' })];
    const svc = createLaunchService(ctx, { killPid });
    await expect(svc.kill('claude', 'owned')).resolves.toEqual({ killed: 'pty' });
    expect(pty.killed).toEqual([{ id: info.id, signal: 'SIGTERM' }]);
    await expect(svc.kill('claude', 'observed')).resolves.toEqual({ killed: 'pid' });
    expect(killPid).toHaveBeenCalledWith(4242);
    expect(await errOf(svc.kill('claude', 'gone'))).toMatchObject({ status: 404, code: 'not_live' });
    expect(await errOf(svc.kill('claude', 'unknown'))).toMatchObject({ status: 404, code: 'not_live' });
  });
});
```

`apps/daemon/src/http/routes/launch.test.ts`
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@orc/core';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLive } from '../../../test/fake-live.ts';
import { createFakePty } from '../../../test/fake-pty.ts';
import { createTestContext, useTempHomes } from '../../../test/helpers.ts';
import type { DaemonContext } from '../../context.ts';
import type { ExecFn } from '../../live/liveness.ts';
import { stubSession } from '../../live/stub-session.ts';
import { createLaunchService } from '../../services/launch.ts';
import { createTemplateRegistry } from '../../services/templates.ts';
import { registerLaunchRoutes } from './launch.ts';

useTempHomes();
let ctx: DaemonContext;
let app: Hono;
let pty: ReturnType<typeof createFakePty>;
let cwd: string;
const exec = vi.fn<ExecFn>(async () => ({ stdout: '', exitCode: 0 }));
const update = vi.fn();
const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  pty = createFakePty();
  ctx = createTestContext({ pty });
  cwd = mkdtempSync(join(tmpdir(), 'orc-lr-'));
  const session: Session = {
    ...stubSession({ source: 'claude', id: 's-live', cwd, startedAt: '', projectId: 'wakecap', name: 'SLA weekends' }),
    live: { pid: 4242, status: 'busy', waitingFor: null, since: '', ownership: 'observed', ptyId: null, stage: null, currentTool: null, backgroundJobs: 0, runningSubagents: 0, contextFill: null },
  };
  ctx.live = createFakeLive([session]);
  ctx.templates = createTemplateRegistry();
  const real = ctx.projects;
  update.mockReset();
  update.mockImplementation((id: string, patch: object) => ({ ...real.get(id), ...patch }));
  ctx.projects = { list: () => real.list(), resolve: () => 'wakecap', get: (id) => real.get(id), update };
  ctx.launcher = createLaunchService(ctx, { discoverTimeoutMs: 10, killPid: vi.fn() });
  exec.mockClear();
  app = new Hono();
  registerLaunchRoutes(app, ctx, { exec });
});

describe('POST /api/sessions/launch', () => {
  it('launches and maps errors', async () => {
    const ok = await post('/api/sessions/launch', { source: 'claude', projectId: 'wakecap', cwd, prompt: 'hi' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ptyId: 'pty-1', sessionId: null });
    expect((await post('/api/sessions/launch', { source: 'agnc', cwd })).status).toBe(400);
    const nyi = await post('/api/sessions/launch', { source: 'claude', projectId: null, cwd, planApproval: true });
    expect(nyi.status).toBe(501);
    expect(((await nyi.json()) as { error: { code: string } }).error.code).toBe('not_implemented');
  });
});

describe('POST /api/sessions/:source/:id/kill', () => {
  it('requires confirmation and then kills', async () => {
    const first = await post('/api/sessions/claude/s-live/kill', {});
    expect(first.status).toBe(409);
    const body = (await first.json()) as { error: { code: string; details: { summary: string } } };
    expect(body.error.code).toBe('confirmation_required');
    expect(body.error.details.summary).toBe(`Stop "SLA weekends" (pid 4242) in ${cwd}?`);
    const ok = await post('/api/sessions/claude/s-live/kill', { confirm: true });
    expect(await ok.json()).toEqual({ killed: 'pid' });
    expect((await post('/api/sessions/claude/nope/kill', { confirm: true })).status).toBe(404);
    expect((await post('/api/sessions/cursor/x/kill', { confirm: true })).status).toBe(400);
  });
});

describe('POST /api/sessions/:source/:id/open-in', () => {
  it('opens the cwd and remembers the choice for the project', async () => {
    const res = await post('/api/sessions/claude/s-live/open-in', { app: 'vscode' });
    expect(res.status).toBe(200);
    expect(exec).toHaveBeenCalledWith('code', [cwd]);
    expect(update).toHaveBeenCalledWith('wakecap', { openIn: 'vscode' });
    await post('/api/sessions/claude/s-live/open-in', { app: 'finder', remember: false });
    expect(update).toHaveBeenCalledTimes(1);
    expect((await post('/api/sessions/claude/unknown/open-in', { app: 'finder' })).status).toBe(404);
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/services/launch.test.ts apps/daemon/src/http/routes/launch.test.ts`
Expected: FAIL, `Cannot find module './launch.ts'`

- [ ] **Step 4: Implement the service, open-in and the routes**

`apps/daemon/src/services/launch.ts`
```ts
import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import type { LaunchRequest, OrcConfig } from '@orc/api-contract';
import type { Source } from '@orc/core';
import type { DaemonContext } from '../context.ts';
import { sessionPk } from './sessions.ts';
import { TemplateError, composePrompt } from './templates.ts';

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

export function buildLaunchCommand(
  cfg: OrcConfig,
  req: { source: 'claude' | 'codex'; model?: string; prompt: string },
): { command: string; args: string[] } {
  const p = cfg.resumeProfile;
  const tail = [...(req.model ? ['--model', req.model] : []), ...(req.prompt ? [req.prompt] : [])];
  return req.source === 'claude'
    ? { command: p.claudeCommand, args: [...p.claudeArgs, ...tail] }
    : { command: p.codexCommand, args: [...p.codexArgs, ...tail] };
}

function isDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function createLaunchService(
  ctx: DaemonContext,
  opts: { discoverTimeoutMs?: number; killPid?: (pid: number) => void } = {},
): LaunchService {
  const discoverTimeoutMs = opts.discoverTimeoutMs ?? 8000;
  const killPid = opts.killPid ?? ((pid: number) => process.kill(pid, 'SIGTERM'));

  const agentCommands = (): Set<string> => {
    const p = ctx.config().resumeProfile;
    return new Set([basename(p.claudeCommand), basename(p.codexCommand)]);
  };

  const ownedCount = (projectId: string | null): number => {
    const agents = agentCommands();
    return ctx.pty
      .list()
      .filter((p) => p.exitedAt === null && agents.has(basename(p.command)) && ctx.projects.resolve(p.cwd) === projectId).length;
  };

  return {
    ownedCount,

    async launch(req) {
      if (req.planApproval) throw new LaunchError(501, 'not_implemented', 'plan approval arrives in phase 4', { field: 'planApproval' });
      if (req.worktree) throw new LaunchError(501, 'not_implemented', 'worktree launch arrives in phase 4', { field: 'worktree' });
      if (req.compare?.length) throw new LaunchError(501, 'not_implemented', 'compare mode arrives in phase 7', { field: 'compare' });
      if (!isAbsolute(req.cwd) || !isDir(req.cwd)) {
        throw new LaunchError(400, 'cwd_not_found', `cwd does not exist or is not a directory: ${req.cwd}`);
      }

      let rendered: string | null = null;
      if (req.templateId) {
        if (!ctx.templates) throw new LaunchError(503, 'templates_unavailable', 'template registry not initialised');
        try {
          rendered = ctx.templates.render(req.templateId, { ...(req.ticket ? { ticket: req.ticket } : {}), ...req.vars });
        } catch (err) {
          if (err instanceof TemplateError) throw new LaunchError(err.status, err.code, err.message, { missing: err.missing });
          throw err;
        }
      }
      const prompt = composePrompt(rendered, req.prompt);
      if (prompt.startsWith('-')) throw new LaunchError(400, 'validation_failed', 'prompt must not start with "-"');

      const projectId = req.projectId ?? ctx.projects.resolve(req.cwd);
      const max = (projectId ? ctx.projects.get(projectId)?.maxConcurrentOwned : undefined) ?? 6;
      const running = ownedCount(projectId);
      if (running >= max) {
        throw new LaunchError(429, 'concurrency_limit', `project ${projectId ?? '(none)'} already runs ${running} app-owned sessions`, {
          projectId,
          max,
          running,
        });
      }

      const { command, args } = buildLaunchCommand(ctx.config(), { source: req.source, model: req.model, prompt });
      const info = ctx.pty.spawn({ command, args, cwd: req.cwd, sessionPk: null });
      ctx.log.info({ ptyId: info.id, source: req.source, projectId, templateId: req.templateId ?? null }, 'session launched');

      const sessionId =
        req.source === 'claude' && ctx.live ? await ctx.live.waitForPid(info.pid, discoverTimeoutMs) : null;
      return { ptyId: info.id, sessionId };
    },

    async kill(source, id) {
      const s = ctx.live?.get(sessionPk(source, id));
      const live = s?.live;
      if (!live || live.status === 'ended') throw new LaunchError(404, 'not_live', `session ${source}:${id} is not running`);
      if (live.ownership === 'owned' && live.ptyId) {
        ctx.pty.kill(live.ptyId, 'SIGTERM');
        return { killed: 'pty' };
      }
      if (live.pid === null) throw new LaunchError(404, 'not_live', 'no pid known for this session');
      killPid(live.pid);
      return { killed: 'pid' };
    },
  };
}
```

`apps/daemon/src/services/open-in.ts`
```ts
import type { OpenInApp } from '@orc/api-contract';
import { type ExecFn, defaultExec } from '../live/liveness.ts';

export function openInCommand(app: OpenInApp, path: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  const mac = platform === 'darwin';
  switch (app) {
    case 'vscode':
      return { command: 'code', args: [path] };
    case 'terminal':
      return mac ? { command: 'open', args: ['-a', 'Terminal', path] } : { command: 'x-terminal-emulator', args: ['--working-directory', path] };
    case 'finder':
      return mac ? { command: 'open', args: [path] } : { command: 'xdg-open', args: [path] };
  }
}

export async function openIn(app: OpenInApp, path: string, exec: ExecFn = defaultExec): Promise<void> {
  const c = openInCommand(app, path);
  const r = await exec(c.command, c.args);
  if (r.exitCode !== 0) throw new Error(`${c.command} exited with ${r.exitCode}`);
}
```

`apps/daemon/src/http/routes/launch.ts`
```ts
import { existsSync } from 'node:fs';
import { ConfirmBody, LaunchRequest, OpenInBody, apiError } from '@orc/api-contract';
import type { Source } from '@orc/core';
import type { Hono } from 'hono';
import type { DaemonContext } from '../../context.ts';
import type { ExecFn } from '../../live/liveness.ts';
import { LaunchError } from '../../services/launch.ts';
import { openIn } from '../../services/open-in.ts';
import { sessionPk } from '../../services/sessions.ts';

const SOURCES = new Set<string>(['claude', 'codex', 'agnc']);

export function registerLaunchRoutes(app: Hono, ctx: DaemonContext, opts: { exec?: ExecFn } = {}): void {
  app.post('/api/sessions/launch', async (c) => {
    const parsed = LaunchRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(apiError('validation_failed', 'invalid launch request', parsed.error.issues), 400);
    if (!ctx.launcher) return c.json(apiError('launcher_unavailable', 'launcher not initialised'), 503);
    try {
      return c.json(await ctx.launcher.launch(parsed.data));
    } catch (err) {
      if (err instanceof LaunchError) return c.json(apiError(err.code, err.message, err.details), err.status);
      throw err;
    }
  });

  app.post('/api/sessions/:source/:id/kill', async (c) => {
    const source = c.req.param('source');
    const id = c.req.param('id');
    if (!SOURCES.has(source)) return c.json(apiError('validation_failed', `unknown source ${source}`), 400);
    const body = ConfirmBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json(apiError('validation_failed', 'invalid body', body.error.issues), 400);
    const s = ctx.live?.get(sessionPk(source as Source, id));
    if (!s?.live || s.live.status === 'ended') return c.json(apiError('not_live', `session ${source}:${id} is not running`), 404);
    if (body.data.confirm !== true) {
      const cwd = s.cwds.at(-1) ?? s.startCwd;
      return c.json(
        apiError('confirmation_required', 'confirm to stop this session', {
          summary: `Stop "${s.name ?? id}" (pid ${s.live.pid ?? '?'}) in ${cwd}?`,
        }),
        409,
      );
    }
    if (!ctx.launcher) return c.json(apiError('launcher_unavailable', 'launcher not initialised'), 503);
    try {
      return c.json(await ctx.launcher.kill(source as Source, id));
    } catch (err) {
      if (err instanceof LaunchError) return c.json(apiError(err.code, err.message, err.details), err.status);
      throw err;
    }
  });

  app.post('/api/sessions/:source/:id/open-in', async (c) => {
    const source = c.req.param('source');
    const id = c.req.param('id');
    if (!SOURCES.has(source)) return c.json(apiError('validation_failed', `unknown source ${source}`), 400);
    const body = OpenInBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(apiError('validation_failed', 'invalid body', body.error.issues), 400);
    const s = ctx.live?.get(sessionPk(source as Source, id)) ?? ctx.sessions.get(source as Source, id);
    if (!s) return c.json(apiError('not_found', `session ${source}:${id} not found`), 404);
    const path = s.cwds.at(-1) ?? s.startCwd;
    if (!existsSync(path)) return c.json(apiError('cwd_not_found', `directory no longer exists: ${path}`), 404);
    await openIn(body.data.app, path, opts.exec);
    if (body.data.remember && s.projectId) ctx.projects.update(s.projectId, { openIn: body.data.app });
    return c.json({ ok: true as const });
  });
}
```

Add to `DaemonContext`: `launcher?: import('./services/launch.ts').LaunchService; // P2`.

- [ ] **Step 5: Run the unit tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/services/launch.test.ts apps/daemon/src/http/routes/launch.test.ts`
Expected: PASS (14 tests)

- [ ] **Step 6: Write the integration test with the fake `claude`**

`apps/daemon/test/launch-integration.test.ts`
```ts
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LaunchRequest } from '@orc/api-contract';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonContext } from '../src/context.ts';
import { createLiveTracker, type LiveTracker } from '../src/live/live-tracker.ts';
import { createLivenessChecker } from '../src/live/liveness.ts';
import { createRegistryWatcher } from '../src/live/registry-watcher.ts';
import { createLaunchService } from '../src/services/launch.ts';
import { createTemplateRegistry } from '../src/services/templates.ts';
import { createTestContext, useTempHomes } from './helpers.ts';

const BIN = fileURLToPath(new URL('./bin', import.meta.url));
const homes = useTempHomes();
const originalPath = process.env.PATH;
let ctx: DaemonContext;
let tracker: LiveTracker;

beforeAll(() => {
  process.env.PATH = `${BIN}:${originalPath}`;
});
afterAll(() => {
  process.env.PATH = originalPath;
});
beforeEach(async () => {
  ctx = createTestContext();
  tracker = createLiveTracker(ctx, {
    registry: createRegistryWatcher({ dir: join(homes().claudeHome, 'sessions'), pollMs: 200 }),
    liveness: createLivenessChecker(),
    codex: { scan: async () => [] },
  });
  ctx.live = tracker;
  ctx.templates = createTemplateRegistry();
  await tracker.start();
});
afterEach(async () => {
  for (const p of ctx.pty.list()) if (p.exitedAt === null) ctx.pty.kill(p.id, 'SIGKILL');
  await tracker.stop();
});

describe('launch with the fake claude binary', () => {
  it('discovers the session, reaches review, and can be killed', { timeout: 20_000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orc-int-'));
    const svc = createLaunchService(ctx);
    const out = await svc.launch(LaunchRequest.parse({ source: 'claude', projectId: null, cwd, prompt: 'do the thing' }));
    const info = ctx.pty.get(out.ptyId);
    expect(out.sessionId).toBe(`fake-${info?.pid}`);
    const pk = `claude:${out.sessionId}`;
    await expect.poll(() => tracker.get(pk)?.live?.status, { timeout: 8000, interval: 100 }).toBe('review');
    expect(tracker.get(pk)?.live).toMatchObject({ ownership: 'owned', ptyId: out.ptyId, stage: 'review' });
    expect(tracker.get(pk)?.lastPrompt).toBe('do the thing');

    await svc.kill('claude', out.sessionId ?? '');
    await expect.poll(() => tracker.get(pk)?.live?.status, { timeout: 5000, interval: 100 }).toBe('ended');
    expect(existsSync(join(homes().claudeHome, 'sessions', `${info?.pid}.json`))).toBe(false);
    expect(readdirSync(join(homes().claudeHome, 'projects', '-fake-project'))).toEqual([`${out.sessionId}.jsonl`]);
  });
});
```

Run: `pnpm vitest run apps/daemon/test/launch-integration.test.ts`
Expected: PASS (1 test, about 3–6 s). If the PTY started by P1's `createPtyManager` doesn't inherit `process.env.PATH` at spawn time, pass `env: { PATH: process.env.PATH ?? '' }` from `LaunchService.launch` to `ctx.pty.spawn`, and write that down.

- [ ] **Step 7: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon/test/bin apps/daemon/test/launch-integration.test.ts apps/daemon/src/services/launch.ts apps/daemon/src/services/launch.test.ts apps/daemon/src/services/open-in.ts apps/daemon/src/http/routes/launch.ts apps/daemon/src/http/routes/launch.test.ts apps/daemon/src/context.ts
git commit -m "feat(daemon): launch sessions from templates with a concurrency cap, add kill and open-in"
```

---

### Task 14: daemon — archive compression, sync and status

**Files:**
- Create: `apps/daemon/src/services/archive/compress.ts`, `apps/daemon/src/services/archive/compress.test.ts`
- Create: `apps/daemon/src/services/archive/archive.ts`, `apps/daemon/src/services/archive/archive.test.ts`

**Interfaces:**
- Consumes: the archive repo (Task 1); `OrcPaths.archiveDir/claudeHome`, `config.archive` (contracts §3); `SessionService.getByPk`, `sessionPk` (P1); `EventBus` (`session.statusChanged`)
- Produces:
  ```ts
  // services/archive/compress.ts
  export type ArchiveCodec = 'zstd' | 'gzip'
  export interface ZstdApi { zstdCompress?: unknown; zstdDecompress?: unknown }
  export function availableCodec(z?: ZstdApi): ArchiveCodec
  export function codecExtension(c: ArchiveCodec): '.zst' | '.gz'
  export function compressBuffer(buf: Buffer, codec: ArchiveCodec): Promise<Buffer>
  export function decompressBuffer(buf: Buffer, codec: ArchiveCodec): Promise<Buffer>
  // services/archive/archive.ts
  export interface TranscriptFile { path: string; sessionId: string; agentId: string | null; size: number; mtimeMs: number }
  export function listClaudeTranscripts(claudeHome: string): TranscriptFile[]
  export function readCleanupPeriodDays(claudeHome: string): number | null
  export interface ArchiveService { syncAll(): Promise<{ copied: number }>; status(): { enabled: boolean; files: number; bytes: number; oldestTranscript: string | null; cleanupPeriodDays: number | null }; restore(source: Source, id: string): Promise<void> }
  export interface ArchiveServiceRuntime extends ArchiveService { restorePlan(source: Source, id: string): { targets: string[] }; codec(): ArchiveCodec; start(intervalMs?: number): void; stop(): void }
  export class ArchiveError extends Error { readonly status: 400 | 404 | 409; readonly code: string; readonly details?: unknown }
  export function createArchiveService(ctx: DaemonContext, opts?: { codec?: ArchiveCodec; now?: () => Date }): ArchiveServiceRuntime
  ```
  `restore`, `restorePlan` and `resolveAvailability` are completed in Task 15. In this task, `restore` and `restorePlan` throw `ArchiveError(400, 'not_ready', …)`.

**Behaviour (docs/02 F5; decision #1 in docs/05):**
- **What:** only main transcripts (`projects/<dir>/<sessionId>.jsonl`) and subagent transcripts (`projects/<dir>/<sessionId>/subagents/agent-<id>.jsonl`). Not `tool-results/` or `file-history/`.
- **Where:** `$ORC_HOME/archive/<projectId>/<sessionId>.jsonl.zst` and `…/<sessionId>/subagents/agent-<id>.jsonl.zst` (`.gz` with gzip). `projectId` is the indexed session's `projectId`, or `_unassigned`.
- **When to copy:**
  - Copy when there is no entry, or when the source **grew** (`size > entry.sourceSize`).
  - A same-size mtime change is ignored.
  - A shrunk source is **not** copied over the archive, because that would lose history. It's logged at `warn`.
  - Files are written as `<path>.tmp`, then renamed.
- **Codec:** `zstd` when `node:zlib` exposes `zstdCompress`/`zstdDecompress` (Node ≥ 22.15), otherwise `gzip`. Existing entries keep their codec; each entry records its own.
- **Status:**
  - `files`/`bytes` come from `archive_entries`.
  - `oldestTranscript` is the ISO mtime of the oldest **main** transcript still in `~/.claude/projects`.
  - `cleanupPeriodDays` is read (read-only) from `~/.claude/settings.json`, or `null`.
- **Size:** when the total passes `config.archive.maxGb`, a warning is logged. Pruning is intentionally not built in this phase.
- **Schedule:** `start(intervalMs = 600000)` syncs now, then on the interval, and also 5 s after any session changes to `ended` (debounced). A sync already in progress is reused.
- **Read-only:** nothing under `claudeHome` is ever written by `syncAll`.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/services/archive/compress.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { availableCodec, codecExtension, compressBuffer, decompressBuffer } from './compress.ts';

describe('compress', () => {
  it('detects zstd support', () => {
    expect(availableCodec({})).toBe('gzip');
    expect(availableCodec({ zstdCompress: () => undefined, zstdDecompress: () => undefined })).toBe('zstd');
    expect(['zstd', 'gzip']).toContain(availableCodec());
  });

  it('maps codecs to extensions', () => {
    expect(codecExtension('zstd')).toBe('.zst');
    expect(codecExtension('gzip')).toBe('.gz');
  });

  it.each(['gzip', availableCodec()] as const)('round-trips with %s', async (codec) => {
    const input = Buffer.from('{"type":"user"}\n'.repeat(500));
    const packed = await compressBuffer(input, codec);
    expect(packed.length).toBeLessThan(input.length / 5);
    expect((await decompressBuffer(packed, codec)).equals(input)).toBe(true);
  });
});
```

`apps/daemon/src/services/archive/archive.test.ts`
```ts
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { OrcConfig } from '@orc/api-contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, useTempHomes } from '../../../test/helpers.ts';
import type { DaemonContext } from '../../context.ts';
import { getArchiveEntry } from '../../db/repos/archive.ts';
import { type ArchiveServiceRuntime, createArchiveService, listClaudeTranscripts, readCleanupPeriodDays } from './archive.ts';
import { availableCodec, codecExtension, decompressBuffer } from './compress.ts';

const homes = useTempHomes();
let ctx: DaemonContext;
let svc: ArchiveServiceRuntime;
let cfg: OrcConfig;
const codec = availableCodec();
const proj = () => join(homes().claudeHome, 'projects/-Users-test-Wakecap');
const archived = (sessionId: string) => {
  const projectId = ctx.sessions.getByPk(`claude:${sessionId}`)?.projectId ?? '_unassigned';
  return join(homes().archiveDir, projectId, `${sessionId}.jsonl${codecExtension(codec)}`);
};

function snapshot(dir: string): string[] {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      const st = statSync(p);
      return st.isDirectory() ? walk(p) : [`${relative(dir, p)}:${st.size}:${st.mtimeMs}`];
    });
  return walk(dir).sort();
}

beforeEach(() => {
  ctx = createTestContext();
  cfg = ctx.config();
  ctx.config = () => cfg;
  svc = createArchiveService(ctx, { codec });
});

describe('listClaudeTranscripts', () => {
  it('finds main and subagent transcripts only', () => {
    const files = listClaudeTranscripts(homes().claudeHome);
    const names = files.map((f) => `${f.sessionId}/${f.agentId ?? '-'}`).sort();
    expect(names).toEqual([
      's-basic/-', 's-drift/-', 's-errors/-', 's-prlink/-',
      's-subagents/-', 's-subagents/ag1', 's-subagents/ag2', 's-subagents/ag3', 's-unknown/-',
    ]);
  });
});

describe('ArchiveService.syncAll', () => {
  it('copies every transcript once, compressed, without touching ~/.claude', async () => {
    const before = snapshot(homes().claudeHome);
    expect(await svc.syncAll()).toEqual({ copied: 9 });
    expect(snapshot(homes().claudeHome)).toEqual(before);
    const src = readFileSync(join(proj(), 's-basic.jsonl'));
    const out = await decompressBuffer(readFileSync(archived('s-basic')), codec);
    expect(out.equals(src)).toBe(true);
    expect(getArchiveEntry(ctx.db, join(proj(), 's-subagents/subagents/agent-ag2.jsonl'))).toMatchObject({
      sessionPk: 'claude:s-subagents',
      agentId: 'ag2',
      codec,
    });
    expect(existsSync(join(homes().archiveDir, ctx.sessions.getByPk('claude:s-subagents')?.projectId ?? '_unassigned', 's-subagents/subagents', `agent-ag2.jsonl${codecExtension(codec)}`))).toBe(true);
    expect(await svc.syncAll()).toEqual({ copied: 0 });
  });

  it('re-copies a transcript that grew and ignores one that shrank', async () => {
    await svc.syncAll();
    appendFileSync(join(proj(), 's-basic.jsonl'), '{"type":"user","uuid":"z","sessionId":"s-basic","timestamp":"2026-09-02T00:00:00.000Z","message":{"role":"user","content":"more"}}\n');
    expect(await svc.syncAll()).toEqual({ copied: 1 });
    const grown = readFileSync(join(proj(), 's-basic.jsonl'));
    expect((await decompressBuffer(readFileSync(archived('s-basic')), codec)).equals(grown)).toBe(true);
    expect(getArchiveEntry(ctx.db, join(proj(), 's-basic.jsonl'))?.sourceSize).toBe(grown.length);

    writeFileSync(join(proj(), 's-basic.jsonl'), '{}\n');
    expect(await svc.syncAll()).toEqual({ copied: 0 });
    expect((await decompressBuffer(readFileSync(archived('s-basic')), codec)).equals(grown)).toBe(true);
  });

  it('does nothing when disabled', async () => {
    cfg = { ...cfg, archive: { ...cfg.archive, enabled: false } };
    expect(await svc.syncAll()).toEqual({ copied: 0 });
    expect(svc.status().enabled).toBe(false);
  });

  it('shares a sync that is already running', async () => {
    const [a, b] = await Promise.all([svc.syncAll(), svc.syncAll()]);
    expect(a).toEqual({ copied: 9 });
    expect(b).toBe(a);
  });

  it('can be forced to gzip', async () => {
    const gz = createArchiveService(ctx, { codec: 'gzip' });
    await gz.syncAll();
    expect(gz.codec()).toBe('gzip');
    expect(getArchiveEntry(ctx.db, join(proj(), 's-basic.jsonl'))?.archivePath.endsWith('.jsonl.gz')).toBe(true);
  });
});

describe('ArchiveService.status', () => {
  it('reports totals, oldest transcript and cleanupPeriodDays', async () => {
    expect(svc.status()).toMatchObject({ enabled: true, files: 0, bytes: 0, cleanupPeriodDays: null });
    utimesSync(join(proj(), 's-drift.jsonl'), new Date('2026-08-16T00:00:00.000Z'), new Date('2026-08-16T00:00:00.000Z'));
    writeFileSync(join(homes().claudeHome, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 45, hooks: {} }));
    await svc.syncAll();
    const s = svc.status();
    expect(s.files).toBe(9);
    expect(s.bytes).toBeGreaterThan(0);
    expect(s.oldestTranscript).toBe('2026-08-16T00:00:00.000Z');
    expect(s.cleanupPeriodDays).toBe(45);
  });

  it('reads cleanupPeriodDays defensively', () => {
    writeFileSync(join(homes().claudeHome, 'settings.json'), '{ not json');
    expect(readCleanupPeriodDays(homes().claudeHome)).toBeNull();
    writeFileSync(join(homes().claudeHome, 'settings.json'), JSON.stringify({ cleanupPeriodDays: '30' }));
    expect(readCleanupPeriodDays(homes().claudeHome)).toBeNull();
  });
});
```

The test relies on `OrcPaths.archiveDir` being exposed by the `useTempHomes()` getter (contracts §3 `OrcPaths`).

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/services/archive`
Expected: FAIL, `Cannot find module './compress.ts'`

- [ ] **Step 3: Implement compression**

`apps/daemon/src/services/archive/compress.ts`
```ts
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';

export type ArchiveCodec = 'zstd' | 'gzip';

type Cb = (err: Error | null, out: Buffer) => void;
export interface ZstdApi {
  zstdCompress?: unknown;
  zstdDecompress?: unknown;
}
interface ZstdFns {
  zstdCompress: (buf: Buffer, cb: Cb) => void;
  zstdDecompress: (buf: Buffer, cb: Cb) => void;
}

const zlibAny = zlib as unknown as ZstdApi;

/** zstd ships in node:zlib from Node 22.15 (experimental). The feature is detected at runtime, and gzip is the fallback. */
export function availableCodec(z: ZstdApi = zlibAny): ArchiveCodec {
  return typeof z.zstdCompress === 'function' && typeof z.zstdDecompress === 'function' ? 'zstd' : 'gzip';
}

export function codecExtension(c: ArchiveCodec): '.zst' | '.gz' {
  return c === 'zstd' ? '.zst' : '.gz';
}

function zstd(): ZstdFns {
  if (availableCodec() !== 'zstd') throw new Error('zstd is not available in this Node build');
  return zlibAny as unknown as ZstdFns;
}

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export function compressBuffer(buf: Buffer, codec: ArchiveCodec): Promise<Buffer> {
  if (codec === 'gzip') return gzip(buf, { level: 6 });
  const z = zstd();
  return new Promise((resolve, reject) => z.zstdCompress(buf, (err, out) => (err ? reject(err) : resolve(out))));
}

export function decompressBuffer(buf: Buffer, codec: ArchiveCodec): Promise<Buffer> {
  if (codec === 'gzip') return gunzip(buf);
  const z = zstd();
  return new Promise((resolve, reject) => z.zstdDecompress(buf, (err, out) => (err ? reject(err) : resolve(out))));
}
```

- [ ] **Step 4: Implement sync and status**

`apps/daemon/src/services/archive/archive.ts`
```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Source } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { type ArchiveEntry, archiveTotals, getArchiveEntry, upsertArchiveEntry } from '../../db/repos/archive.ts';
import { sessionPk } from '../sessions.ts';
import { type ArchiveCodec, availableCodec, codecExtension, compressBuffer } from './compress.ts';

export interface TranscriptFile {
  path: string;
  sessionId: string;
  agentId: string | null;
  size: number;
  mtimeMs: number;
}

export interface ArchiveService {
  syncAll(): Promise<{ copied: number }>;
  status(): { enabled: boolean; files: number; bytes: number; oldestTranscript: string | null; cleanupPeriodDays: number | null };
  restore(source: Source, id: string): Promise<void>;
}

export interface ArchiveServiceRuntime extends ArchiveService {
  restorePlan(source: Source, id: string): { targets: string[] };
  codec(): ArchiveCodec;
  start(intervalMs?: number): void;
  stop(): void;
}

export class ArchiveError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

const safeReaddir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
const safeStat = (p: string) => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};

export function listClaudeTranscripts(claudeHome: string): TranscriptFile[] {
  const root = join(claudeHome, 'projects');
  const out: TranscriptFile[] = [];
  for (const dirName of safeReaddir(root)) {
    const dir = join(root, dirName);
    if (!safeStat(dir)?.isDirectory()) continue;
    for (const name of safeReaddir(dir)) {
      const p = join(dir, name);
      const st = safeStat(p);
      if (!st) continue;
      if (st.isFile() && name.endsWith('.jsonl')) {
        out.push({ path: p, sessionId: name.slice(0, -'.jsonl'.length), agentId: null, size: st.size, mtimeMs: st.mtimeMs });
      } else if (st.isDirectory()) {
        const subDir = join(p, 'subagents');
        for (const sub of safeReaddir(subDir)) {
          const m = /^agent-(.+)\.jsonl$/.exec(sub);
          if (!m?.[1]) continue;
          const sp = join(subDir, sub);
          const sst = safeStat(sp);
          if (sst?.isFile()) out.push({ path: sp, sessionId: name, agentId: m[1], size: sst.size, mtimeMs: sst.mtimeMs });
        }
      }
    }
  }
  return out;
}

/** Reads only `cleanupPeriodDays` from ~/.claude/settings.json (read-only). */
export function readCleanupPeriodDays(claudeHome: string): number | null {
  try {
    const v = JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf8')) as { cleanupPeriodDays?: unknown };
    return typeof v.cleanupPeriodDays === 'number' && Number.isFinite(v.cleanupPeriodDays) ? v.cleanupPeriodDays : null;
  } catch {
    return null;
  }
}

export function createArchiveService(
  ctx: DaemonContext,
  opts: { codec?: ArchiveCodec; now?: () => Date } = {},
): ArchiveServiceRuntime {
  const codec = opts.codec ?? availableCodec();
  const now = opts.now ?? (() => new Date());
  let inFlight: Promise<{ copied: number }> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let endedTimer: NodeJS.Timeout | null = null;
  let unsub: (() => void) | null = null;

  const projectFor = (sessionId: string): string =>
    ctx.sessions.getByPk(sessionPk('claude', sessionId))?.projectId ?? '_unassigned';

  const archivePathFor = (projectId: string, f: TranscriptFile): string => {
    const ext = `.jsonl${codecExtension(codec)}`;
    return f.agentId
      ? join(ctx.paths.archiveDir, projectId, f.sessionId, 'subagents', `agent-${f.agentId}${ext}`)
      : join(ctx.paths.archiveDir, projectId, `${f.sessionId}${ext}`);
  };

  async function copyOne(f: TranscriptFile, prev: ArchiveEntry | null): Promise<void> {
    const buf = await readFile(f.path);
    const packed = await compressBuffer(buf, codec);
    const target = prev && prev.codec === codec ? prev.archivePath : archivePathFor(projectFor(f.sessionId), f);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, packed, { mode: 0o600 });
    await rename(tmp, target);
    if (prev && prev.archivePath !== target && prev.archivePath.startsWith(ctx.paths.archiveDir)) {
      await rm(prev.archivePath, { force: true });
    }
    upsertArchiveEntry(ctx.db, {
      path: f.path,
      sessionPk: sessionPk('claude', f.sessionId),
      agentId: f.agentId,
      projectId: prev?.projectId ?? projectFor(f.sessionId),
      archivePath: target,
      codec,
      sourceSize: buf.length,
      sourceMtimeMs: Math.trunc(f.mtimeMs),
      bytes: packed.length,
      archivedAt: now().toISOString(),
    });
  }

  async function runSync(): Promise<{ copied: number }> {
    const cfg = ctx.config();
    if (!cfg.archive.enabled) return { copied: 0 };
    let copied = 0;
    for (const f of listClaudeTranscripts(ctx.paths.claudeHome)) {
      const prev = getArchiveEntry(ctx.db, f.path);
      if (prev && f.size <= prev.sourceSize) {
        if (f.size < prev.sourceSize) ctx.log.warn({ path: f.path }, 'transcript shrank; keeping the archived copy');
        continue;
      }
      try {
        await copyOne(f, prev);
        copied++;
      } catch (err) {
        ctx.log.warn({ err: String(err), path: f.path }, 'archive copy failed');
      }
    }
    const totals = archiveTotals(ctx.db);
    if (totals.bytes > cfg.archive.maxGb * 1024 ** 3) {
      ctx.log.warn({ bytes: totals.bytes, maxGb: cfg.archive.maxGb }, 'archive is over its size limit (pruning is not automatic)');
    }
    return { copied };
  }

  const svc: ArchiveServiceRuntime = {
    syncAll() {
      if (!inFlight) {
        inFlight = runSync().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },

    status() {
      const totals = archiveTotals(ctx.db);
      let oldest: number | null = null;
      for (const f of listClaudeTranscripts(ctx.paths.claudeHome)) {
        if (f.agentId === null && (oldest === null || f.mtimeMs < oldest)) oldest = f.mtimeMs;
      }
      return {
        enabled: ctx.config().archive.enabled,
        files: totals.files,
        bytes: totals.bytes,
        oldestTranscript: oldest === null ? null : new Date(oldest).toISOString(),
        cleanupPeriodDays: readCleanupPeriodDays(ctx.paths.claudeHome),
      };
    },

    restorePlan() {
      throw new ArchiveError(400, 'not_ready', 'restore is implemented in the next task');
    },

    async restore() {
      throw new ArchiveError(400, 'not_ready', 'restore is implemented in the next task');
    },

    codec: () => codec,

    start(intervalMs = 600_000) {
      void svc.syncAll();
      timer = setInterval(() => void svc.syncAll(), intervalMs);
      timer.unref();
      unsub = ctx.bus.on('session.statusChanged', (e) => {
        if (e.to !== 'ended') return;
        if (endedTimer) clearTimeout(endedTimer);
        endedTimer = setTimeout(() => void svc.syncAll(), 5000);
        endedTimer.unref();
      });
    },

    stop() {
      if (timer) clearInterval(timer);
      if (endedTimer) clearTimeout(endedTimer);
      timer = null;
      endedTimer = null;
      unsub?.();
      unsub = null;
    },
  };
  return svc;
}
```


- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/services/archive`
Expected: PASS (12 tests)

- [ ] **Step 6: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon/src/services/archive
git commit -m "feat(daemon): archive transcripts with zstd (gzip fallback) and report retention status"
```

---

### Task 15: daemon — confirmed restore, the `archived` availability and `/api/archive` routes

**Files:**
- Modify: `apps/daemon/src/services/archive/archive.ts` (implement `restorePlan`/`restore`, add `resolveAvailability`)
- Modify: `apps/daemon/src/services/sessions.ts` (availability expression)
- Create: `apps/daemon/src/services/archive/restore.test.ts`
- Create: `apps/daemon/src/http/routes/archive.ts`, `apps/daemon/src/http/routes/archive.test.ts`

**Interfaces:**
- Consumes: `listArchiveEntries`, `archivedSessionPks`, `upsertArchiveEntry` (Task 1); `decompressBuffer` (Task 14); `ArchiveStatus`, `ArchiveRestoreBody`, `RECOMMENDED_CLEANUP_SNIPPET`, `apiError` (Task 2); `SessionService.get/list` (P1)
- Produces:
  ```ts
  export function resolveAvailability(i: { transcriptExists: boolean; archived: boolean; hasPrompts: boolean; remote?: boolean }): Availability
  // ArchiveServiceRuntime.restorePlan / restore, now implemented
  export function registerArchiveRoutes(app: Hono, ctx: DaemonContext): void   // GET /api/archive/status, POST /api/archive/restore, POST /api/archive/sync
  ```

**Restore rules.** This is the **only** place in the app that writes into `~/.claude`.
1. Only `source === 'claude'`. Anything else → `400 unsupported_source`.
2. The session must have archive entries, otherwise `404 not_archived`.
3. Every target (the original transcript path) must resolve inside `<claudeHome>/projects/`, otherwise `400 invalid_target`.
4. If **any** target already exists → `409 restore_target_exists` with `details.paths`, and **nothing** is written. Existing files are never overwritten.
5. Everything is decompressed before the first write, so a corrupt archive writes nothing. Files are written with `flag: 'wx'` and mode `0600`, and missing directories are created.
6. The route requires `{"confirm": true}`. Without it the route returns `409 confirmation_required` with `details.summary` and `details.targets`. Phase 3 adds `audit.record({ action: 'archive.restore' })`.

**Availability** (docs/02 F3), computed when read:
- `remote` for AGNC
- `resumable` if the transcript file exists
- `archived` if only the archive has it
- `prompts-only` otherwise

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/services/archive/restore.test.ts`
```ts
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, useTempHomes } from '../../../test/helpers.ts';
import type { DaemonContext } from '../../context.ts';
import { upsertArchiveEntry } from '../../db/repos/archive.ts';
import { type ArchiveServiceRuntime, createArchiveService, resolveAvailability } from './archive.ts';

const homes = useTempHomes();
let ctx: DaemonContext;
let svc: ArchiveServiceRuntime;
const proj = () => join(homes().claudeHome, 'projects/-Users-test-Wakecap');
const errOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
const syncErr = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};

beforeEach(async () => {
  ctx = createTestContext();
  svc = createArchiveService(ctx);
  ctx.archive = svc;
  await svc.syncAll();
});

describe('resolveAvailability', () => {
  it('orders remote > resumable > archived > prompts-only', () => {
    expect(resolveAvailability({ transcriptExists: true, archived: true, hasPrompts: true, remote: true })).toBe('remote');
    expect(resolveAvailability({ transcriptExists: true, archived: true, hasPrompts: true })).toBe('resumable');
    expect(resolveAvailability({ transcriptExists: false, archived: true, hasPrompts: true })).toBe('archived');
    expect(resolveAvailability({ transcriptExists: false, archived: false, hasPrompts: true })).toBe('prompts-only');
  });
});

describe('restore', () => {
  it('plans only claude sessions that are archived', () => {
    expect(syncErr(() => svc.restorePlan('codex', 'x'))).toMatchObject({ status: 400, code: 'unsupported_source' });
    expect(syncErr(() => svc.restorePlan('claude', 'nope'))).toMatchObject({ status: 404, code: 'not_archived' });
    expect(svc.restorePlan('claude', 's-subagents').targets).toEqual([
      join(proj(), 's-subagents.jsonl'),
      join(proj(), 's-subagents/subagents/agent-ag1.jsonl'),
      join(proj(), 's-subagents/subagents/agent-ag2.jsonl'),
      join(proj(), 's-subagents/subagents/agent-ag3.jsonl'),
    ]);
  });

  it('restores deleted transcripts byte-for-byte and flips availability', async () => {
    const original = readFileSync(join(proj(), 's-basic.jsonl'));
    rmSync(join(proj(), 's-basic.jsonl'));
    expect(ctx.sessions.get('claude', 's-basic')?.availability).toBe('archived');
    expect(ctx.sessions.list({ availability: 'archived' }).items.map((i) => i.pk)).toContain('claude:s-basic');
    await svc.restore('claude', 's-basic');
    expect(readFileSync(join(proj(), 's-basic.jsonl')).equals(original)).toBe(true);
    expect(ctx.sessions.get('claude', 's-basic')?.availability).toBe('resumable');
    expect(await svc.syncAll()).toEqual({ copied: 0 });
  });

  it('refuses to overwrite and writes nothing when any target exists', async () => {
    rmSync(join(proj(), 's-subagents.jsonl'));
    const err = await errOf(svc.restore('claude', 's-subagents'));
    expect(err).toMatchObject({ status: 409, code: 'restore_target_exists' });
    expect((err as { details: { paths: string[] } }).details.paths).toHaveLength(3);
    expect(existsSync(join(proj(), 's-subagents.jsonl'))).toBe(false);
  });

  it('rejects targets outside ~/.claude/projects', async () => {
    upsertArchiveEntry(ctx.db, {
      path: '/tmp/evil.jsonl', sessionPk: 'claude:evil', agentId: null, projectId: 'x', archivePath: '/tmp/evil.zst',
      codec: 'gzip', sourceSize: 1, sourceMtimeMs: 1, bytes: 1, archivedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(await errOf(svc.restore('claude', 'evil'))).toMatchObject({ status: 400, code: 'invalid_target' });
  });
});
```

`apps/daemon/src/http/routes/archive.test.ts`
```ts
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, useTempHomes } from '../../../test/helpers.ts';
import type { DaemonContext } from '../../context.ts';
import { createArchiveService } from '../../services/archive/archive.ts';
import { registerArchiveRoutes } from './archive.ts';

const homes = useTempHomes();
let ctx: DaemonContext;
let app: Hono;
const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  ctx = createTestContext();
  ctx.archive = createArchiveService(ctx, { codec: 'gzip' });
  app = new Hono();
  registerArchiveRoutes(app, ctx);
});

describe('/api/archive', () => {
  it('syncs and reports status with the recommended snippet', async () => {
    expect(await (await post('/api/archive/sync', {})).json()).toEqual({ copied: 9 });
    const status = (await (await app.request('/api/archive/status')).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ enabled: true, files: 9, codec: 'gzip', cleanupPeriodDays: null });
    expect(status.recommendedSnippet).toContain('"cleanupPeriodDays"');
  });

  it('requires confirmation, restores, then refuses to overwrite', async () => {
    await post('/api/archive/sync', {});
    const target = join(homes().claudeHome, 'projects/-Users-test-Wakecap/s-basic.jsonl');
    rmSync(target);
    const ask = await post('/api/archive/restore', { source: 'claude', id: 's-basic' });
    expect(ask.status).toBe(409);
    const askBody = (await ask.json()) as { error: { code: string; details: { summary: string; targets: string[] } } };
    expect(askBody.error.code).toBe('confirmation_required');
    expect(askBody.error.details.targets).toEqual([target]);
    expect(askBody.error.details.summary).toContain('Restore 1 transcript file');
    const ok = await post('/api/archive/restore', { source: 'claude', id: 's-basic', confirm: true });
    expect(await ok.json()).toEqual({ restored: [target] });
    const again = await post('/api/archive/restore', { source: 'claude', id: 's-basic', confirm: true });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('restore_target_exists');
  });

  it('maps validation and plan errors', async () => {
    expect((await post('/api/archive/restore', { source: 'claude' })).status).toBe(400);
    expect((await post('/api/archive/restore', { source: 'codex', id: 'x', confirm: true })).status).toBe(400);
    expect((await post('/api/archive/restore', { source: 'claude', id: 'nope' })).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/services/archive/restore.test.ts apps/daemon/src/http/routes/archive.test.ts`
Expected: FAIL, `resolveAvailability is not a function` / `Cannot find module './archive.ts'`

- [ ] **Step 3: Implement restore and availability**

In `apps/daemon/src/services/archive/archive.ts`:

Extend the imports:
```ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Availability, Source } from '@orc/core';
import { type ArchiveEntry, archiveTotals, getArchiveEntry, listArchiveEntries, upsertArchiveEntry } from '../../db/repos/archive.ts';
import { type ArchiveCodec, availableCodec, codecExtension, compressBuffer, decompressBuffer } from './compress.ts';
```

Add this export (below `readCleanupPeriodDays`):
```ts
export function resolveAvailability(i: { transcriptExists: boolean; archived: boolean; hasPrompts: boolean; remote?: boolean }): Availability {
  if (i.remote) return 'remote';
  if (i.transcriptExists) return 'resumable';
  if (i.archived) return 'archived';
  return 'prompts-only';
}
```

Replace the two placeholder methods inside `svc` with:
```ts
    restorePlan(source, id) {
      if (source !== 'claude') throw new ArchiveError(400, 'unsupported_source', 'only Claude transcripts can be restored');
      const entries = listArchiveEntries(ctx.db, sessionPk(source, id));
      if (entries.length === 0) throw new ArchiveError(404, 'not_archived', `no archived transcript for ${source}:${id}`);
      return { targets: entries.map((e) => e.path).sort() };
    },

    async restore(source, id) {
      const { targets } = svc.restorePlan(source, id);
      const projectsRoot = `${resolve(ctx.paths.claudeHome, 'projects')}${sep}`;
      const outside = targets.filter((t) => !resolve(t).startsWith(projectsRoot));
      if (outside.length) {
        throw new ArchiveError(400, 'invalid_target', 'archived path is outside ~/.claude/projects', { paths: outside });
      }
      const existing = targets.filter((t) => existsSync(t));
      if (existing.length) {
        throw new ArchiveError(409, 'restore_target_exists', 'refusing to overwrite existing transcripts', { paths: existing });
      }
      const entries = listArchiveEntries(ctx.db, sessionPk(source, id));
      const payloads = await Promise.all(
        entries.map(async (e) => ({ e, buf: await decompressBuffer(await readFile(e.archivePath), e.codec) })),
      );
      for (const { e, buf } of payloads) {
        await mkdir(dirname(e.path), { recursive: true });
        await writeFile(e.path, buf, { flag: 'wx', mode: 0o600 });
      }
      ctx.log.info({ sessionPk: sessionPk(source, id), files: payloads.length }, 'archive restored into ~/.claude/projects');
    },
```

In `apps/daemon/src/services/sessions.ts`, find the single place where Phase 1 sets `availability` for a `Session` and a `SessionListItem`, and replace it with the computed value. Load the archived set once per `list()`/`get()` call:
```ts
import { existsSync } from 'node:fs';
import { archivedSessionPks } from '../db/repos/archive.ts';
import { resolveAvailability } from './archive/archive.ts';

// inside list()/get(), before mapping rows:
const archived = archivedSessionPks(db);
// where each row is mapped:
availability: resolveAvailability({
  transcriptExists: row.transcriptPath !== null && existsSync(row.transcriptPath),
  archived: archived.has(row.pk),
  hasPrompts: true,
  remote: row.source === 'agnc',
}),
```
If Phase 1 filters `availability` in SQL against a stored column, change that filter to run on the computed value after mapping (the `q.availability` filter), so `list({ availability: 'archived' })` works. Use the Phase 1 variable names (`row`, `db`) that are in scope, and write down the exact lines you changed in the review note.

- [ ] **Step 4: Implement the routes**

`apps/daemon/src/http/routes/archive.ts`
```ts
import { ArchiveRestoreBody, type ArchiveStatus, RECOMMENDED_CLEANUP_SNIPPET, apiError } from '@orc/api-contract';
import type { Hono } from 'hono';
import type { DaemonContext } from '../../context.ts';
import { ArchiveError, type ArchiveServiceRuntime } from '../../services/archive/archive.ts';

export function registerArchiveRoutes(app: Hono, ctx: DaemonContext): void {
  const svc = (): ArchiveServiceRuntime | null => (ctx.archive as ArchiveServiceRuntime | undefined) ?? null;

  app.get('/api/archive/status', (c) => {
    const a = svc();
    if (!a) return c.json(apiError('archive_unavailable', 'archive not initialised'), 503);
    const body: ArchiveStatus = { ...a.status(), codec: a.codec(), recommendedSnippet: RECOMMENDED_CLEANUP_SNIPPET };
    return c.json(body);
  });

  app.post('/api/archive/sync', async (c) => {
    const a = svc();
    if (!a) return c.json(apiError('archive_unavailable', 'archive not initialised'), 503);
    return c.json(await a.syncAll());
  });

  app.post('/api/archive/restore', async (c) => {
    const a = svc();
    if (!a) return c.json(apiError('archive_unavailable', 'archive not initialised'), 503);
    const body = ArchiveRestoreBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(apiError('validation_failed', 'invalid restore request', body.error.issues), 400);
    const { source, id, confirm } = body.data;
    try {
      const { targets } = a.restorePlan(source, id);
      if (confirm !== true) {
        return c.json(
          apiError('confirmation_required', 'confirm to restore into ~/.claude/projects', {
            summary: `Restore ${targets.length} transcript file(s) for ${source}:${id} into ${ctx.paths.claudeHome}/projects? Existing files are never overwritten.`,
            targets,
          }),
          409,
        );
      }
      await a.restore(source, id);
      return c.json({ restored: targets });
    } catch (err) {
      if (err instanceof ArchiveError) return c.json(apiError(err.code, err.message, err.details), err.status);
      throw err;
    }
  });
}
```

Change the `archive?` field of `DaemonContext` to `archive?: import('./services/archive/archive.ts').ArchiveServiceRuntime; // P2 (extends the contract's ArchiveService)`. With that, the cast in `svc()` is a no-op; keep it for readability.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/services apps/daemon/src/http/routes/archive.test.ts`
Expected: PASS (all service tests, including 5 restore tests and 3 route tests; P1's session tests stay green)

- [ ] **Step 6: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon/src/services apps/daemon/src/http/routes/archive.ts apps/daemon/src/http/routes/archive.test.ts apps/daemon/src/context.ts
git commit -m "feat(daemon): restore archived transcripts with confirmation and mark sessions archived"
```

---

### Task 16: daemon — wire Phase 2 into `createDaemon`, `/ws` upgrade and an end-to-end daemon test

**Files:**
- Create: `apps/daemon/src/phase2.ts`
- Modify: `apps/daemon/src/main.ts` (`createDaemon`), `apps/daemon/src/http/app.ts`, `apps/daemon/src/http/ws.ts`
- Create: `apps/daemon/test/p2-daemon.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–15; P1 `createDaemon`, `createApp`, `attachWebSockets`, `authorizeUpgrade`, `saveConfig`; `OrcConfig` zod
- Produces:
  ```ts
  // phase2.ts
  export interface Phase2Handle { hub: LiveWsHub; stop(): Promise<void> }
  export function startPhase2(ctx: DaemonContext, opts?: { notifyChannels?: NotifyChannelImpl[]; archiveIntervalMs?: number }): Promise<Phase2Handle>
  export function registerPhase2Routes(app: Hono, ctx: DaemonContext): void
  // http/ws.ts (changed signature)
  export function attachWebSockets(server: import('node:http').Server, ctx: DaemonContext, extras?: { liveHub?: LiveWsHub }): void
  ```
- New env var: `ORC_NOTIFY=off` disables all notification channels. Tests and e2e set it.

- [ ] **Step 1: Write the failing end-to-end daemon test**

`apps/daemon/test/p2-daemon.test.ts`
```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InboxItem, Session } from '@orc/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createDaemon } from '../src/main.ts';
import { useTempHomes } from './helpers.ts';

const BIN = fileURLToPath(new URL('./bin', import.meta.url));
const homes = useTempHomes();
const saved = { PATH: process.env.PATH, ORC_NOTIFY: process.env.ORC_NOTIFY };
let daemon: Awaited<ReturnType<typeof createDaemon>>;
let base: string;
let token: string;

beforeAll(() => {
  process.env.PATH = `${BIN}:${saved.PATH}`;
  process.env.ORC_NOTIFY = 'off';
});
afterAll(() => {
  process.env.PATH = saved.PATH;
  if (saved.ORC_NOTIFY === undefined) delete process.env.ORC_NOTIFY;
  else process.env.ORC_NOTIFY = saved.ORC_NOTIFY;
});
beforeEach(async () => {
  daemon = await createDaemon({ port: 0 });
  base = `http://127.0.0.1:${daemon.port}`;
  token = readFileSync(homes().tokenFile, 'utf8').trim();
});
afterEach(async () => daemon.close());

const api = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'x-orc-token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
};

function openWs(withToken: boolean): Promise<{ ws: WebSocket; messages: Array<{ type: string; item?: InboxItem }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws${withToken ? `?token=${token}` : ''}`, {
      headers: { origin: `http://127.0.0.1:${daemon.port}` },
    });
    const messages: Array<{ type: string; item?: InboxItem }> = [];
    ws.on('message', (d) => messages.push(JSON.parse(String(d))));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
  });
}

describe('phase 2 daemon end to end (fake claude)', () => {
  it('rejects unauthenticated API and WS calls', async () => {
    expect((await fetch(`${base}/api/live`)).status).toBe(401);
    await expect(openWs(false)).rejects.toThrow(/401/);
  });

  it('launch → waiting inbox item within 2 s → kill → auto-resolved', { timeout: 30_000 }, async () => {
    const { ws, messages } = await openWs(true);
    await expect.poll(() => messages[0]?.type).toBe('hello');
    const cwd = mkdtempSync(join(tmpdir(), 'orc-e2e-'));
    const launched = await api<{ ptyId: string; sessionId: string }>('POST', '/api/sessions/launch', {
      source: 'claude', projectId: null, cwd, prompt: 'please wait for me',
    });
    expect(launched.status).toBe(200);
    const pk = `claude:${launched.json.sessionId}`;
    const pid = Number(launched.json.sessionId.replace('fake-', ''));

    await expect
      .poll(async () => (await api<InboxItem[]>('GET', '/api/inbox?state=open&kind=waiting')).json.length, { timeout: 5000, interval: 100 })
      .toBe(1);
    const reg = JSON.parse(readFileSync(join(homes().claudeHome, 'sessions', `${pid}.json`), 'utf8')) as { statusUpdatedAt: number };
    const [item] = (await api<InboxItem[]>('GET', '/api/inbox?state=open&kind=waiting')).json;
    // registry timestamps have 1 s resolution in the fake, so allow 1 s of slack on top of the 2 s budget
    expect(Date.parse(item?.createdAt ?? '') - reg.statusUpdatedAt).toBeLessThan(3000);
    expect(item?.payload).toMatchObject({ source: 'claude', id: launched.json.sessionId });
    expect(messages.some((m) => m.type === 'inbox.upserted' && m.item?.kind === 'waiting')).toBe(true);

    const live = await api<Session[]>('GET', '/api/live');
    expect(live.json.find((s) => `${s.source}:${s.id}` === pk)?.live).toMatchObject({ status: 'waiting', ownership: 'owned' });

    expect((await api('POST', `/api/sessions/claude/${launched.json.sessionId}/kill`, {})).status).toBe(409);
    expect((await api('POST', `/api/sessions/claude/${launched.json.sessionId}/kill`, { confirm: true })).json).toEqual({ killed: 'pty' });
    await expect
      .poll(async () => (await api<InboxItem[]>('GET', '/api/inbox?state=auto_resolved')).json.map((i) => i.kind), { timeout: 5000, interval: 100 })
      .toContain('waiting');
    ws.close();
  });

  it('review and tests_red items from a failing run', { timeout: 30_000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orc-e2e-'));
    const launched = await api<{ sessionId: string }>('POST', '/api/sessions/launch', {
      source: 'claude', projectId: null, cwd, prompt: 'fix it and fail',
    });
    expect(launched.status).toBe(200);
    await expect
      .poll(async () => (await api<InboxItem[]>('GET', '/api/inbox?state=open')).json.map((i) => i.kind).sort(), { timeout: 8000, interval: 100 })
      .toEqual(['review', 'tests_red']);
  });

  it('serves templates, notification prefs and archive status', async () => {
    expect((await api<unknown[]>('GET', '/api/templates')).json).toHaveLength(10);
    expect((await api<Record<string, unknown>>('GET', '/api/config/notifications')).json).toHaveProperty('waiting');
    const synced = await api<{ copied: number }>('POST', '/api/archive/sync', {});
    expect(synced.status).toBe(200);
    const status = await api<{ files: number; recommendedSnippet: string }>('GET', '/api/archive/status');
    expect(status.json.files).toBeGreaterThanOrEqual(9);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/test/p2-daemon.test.ts`
Expected: FAIL. `/api/live` returns 404, or the launch returns 404, because nothing is wired yet.

- [ ] **Step 3: Write the Phase-2 wiring module**

`apps/daemon/src/phase2.ts`
```ts
import { join } from 'node:path';
import type { Hono } from 'hono';
import { createCodexLiveDetector } from './collectors/codex/live.ts';
import type { DaemonContext } from './context.ts';
import { type LiveWsHub, createLiveWsHub } from './http/live-ws.ts';
import { registerArchiveRoutes } from './http/routes/archive.ts';
import { registerHookRoutes } from './http/routes/hooks.ts';
import { registerInboxRoutes } from './http/routes/inbox.ts';
import { registerLaunchRoutes } from './http/routes/launch.ts';
import { registerLiveRoutes } from './http/routes/live.ts';
import { registerNotificationRoutes } from './http/routes/notifications.ts';
import { registerTemplateRoutes } from './http/routes/templates.ts';
import { createInboxEngine } from './inbox/engine.ts';
import { registerDefaultRules } from './inbox/rules/status-rules.ts';
import { createLiveTracker } from './live/live-tracker.ts';
import { createLivenessChecker } from './live/liveness.ts';
import { createRegistryWatcher } from './live/registry-watcher.ts';
import { createMacosChannel } from './notify/macos.ts';
import { type NotifyChannelImpl, createNotifier } from './notify/notifier.ts';
import { createArchiveService } from './services/archive/archive.ts';
import { createLaunchService } from './services/launch.ts';
import { createTemplateRegistry } from './services/templates.ts';

export interface Phase2Handle {
  hub: LiveWsHub;
  stop(): Promise<void>;
}

/** Creates and starts every Phase 2 service on ctx. Call after the P1 services exist and before the server listens. */
export async function startPhase2(
  ctx: DaemonContext,
  opts: { notifyChannels?: NotifyChannelImpl[]; archiveIntervalMs?: number } = {},
): Promise<Phase2Handle> {
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

  const live = createLiveTracker(ctx, {
    registry: createRegistryWatcher({ dir: join(ctx.paths.claudeHome, 'sessions'), log: ctx.log }),
    liveness: createLivenessChecker(),
    codex: createCodexLiveDetector({ codexHome: ctx.paths.codexHome }),
  });
  ctx.live = live;
  ctx.launcher = createLaunchService(ctx);

  await live.start();
  archive.start(opts.archiveIntervalMs);
  const hub = createLiveWsHub(ctx);

  return {
    hub,
    async stop() {
      archive.stop();
      inbox.stop();
      await live.stop();
      await hub.close();
    },
  };
}

/** Registers the Phase 2 routes. Call before any SPA fallback route. */
export function registerPhase2Routes(app: Hono, ctx: DaemonContext): void {
  registerLiveRoutes(app, ctx);
  registerHookRoutes(app, ctx);
  registerInboxRoutes(app, ctx);
  registerTemplateRoutes(app, ctx);
  registerLaunchRoutes(app, ctx);
  registerArchiveRoutes(app, ctx);
  registerNotificationRoutes(app, ctx);
}
```

- [ ] **Step 4: Wire it into the app, the WS upgrade and `createDaemon`**

In `apps/daemon/src/http/app.ts`, inside `createApp(ctx)`, add this after the P1 route registrations and **before** the static/SPA fallback:
```ts
import { registerPhase2Routes } from '../phase2.ts';
// ...
registerPhase2Routes(app, ctx);
```
The token middleware on `/api/*` already covers these routes. `POST /api/hooks` needs the token too; the hook snippet sends it.

In `apps/daemon/src/http/ws.ts`, add the optional `extras` parameter and route `/ws` **before** the `/pty/:ptyId` branch, inside the existing `upgrade` listener:
```ts
import type { LiveWsHub } from './live-ws.ts';

export function attachWebSockets(server: Server, ctx: DaemonContext, extras: { liveHub?: LiveWsHub } = {}): void {
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (pathname === '/ws') {
      if (!extras.liveHub || !authorizeUpgrade(req, ctx)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      extras.liveHub.handleUpgrade(req, socket, head);
      return;
    }
    // … the existing Phase 1 /pty/:ptyId handling stays below, unchanged …
  });
}
```
If Phase 1 registered the listener differently, keep its structure and add the same `/ws` branch at the top of its handler.

In `apps/daemon/src/main.ts` (`createDaemon`):
1. **Config setter:** Phase 1 keeps the current config in a variable that `ctx.config` reads (e.g. `let currentConfig = loadConfig(paths)`). Add a setter next to it:
   ```ts
   ctx.updateConfig = (fn) => {
     const next = OrcConfig.parse(fn(currentConfig));
     saveConfig(paths, next);
     currentConfig = next;
     return next;
   };
   ```
   (`OrcConfig` is imported from `@orc/api-contract`.)
2. **Start Phase 2:** after the P1 services (`pty`, `sessions`, `projects`, the indexer) are created and **before** `createApp(ctx)` / `serve(...)`:
   ```ts
   const phase2 = await startPhase2(ctx);
   ```
3. **Pass the hub:** `attachWebSockets(server, ctx, { liveHub: phase2.hub });`
4. **Stop on close:** in the returned `close()`, call `await phase2.stop();` **before** the server and db close.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run apps/daemon/test/p2-daemon.test.ts`
Expected: PASS (4 tests). Then run the whole daemon suite: `pnpm vitest run apps/daemon`. Expected: all green.

- [ ] **Step 6: Smoke test against the real `~/.claude` (read-only, manual)**

```bash
cd /Users/hazem/orchestrator && ORC_HOME=$(mktemp -d) pnpm --filter @orc/daemon dev
# in another terminal, with at least one real claude session running:
TOKEN=$(cat "$ORC_HOME/token")   # use the same ORC_HOME value as the daemon
curl -s -H "x-orc-token: $TOKEN" http://127.0.0.1:4317/api/live | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).map(x=>[x.source,x.id,x.live.status,x.live.ownership])))'
```
Expected: one row per running `claude`/`codex` process with plausible statuses. Paste the output (ids and statuses only) into the review note. Before and after, confirm that `ls -la ~/.claude/sessions ~/.claude/settings.json` shows unchanged mtimes.

- [ ] **Step 7: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon/src/phase2.ts apps/daemon/src/main.ts apps/daemon/src/http/app.ts apps/daemon/src/http/ws.ts apps/daemon/test/p2-daemon.test.ts
git commit -m "feat(daemon): wire live tracker, inbox, notifier, launcher and archive into the daemon"
```

---

### Task 17: web — live data layer (queries, `useLiveEvents`, cache updates, tab title)

**Files:**
- Create: `apps/web/src/test/query.tsx`
- Create: `apps/web/src/api/queries/live.ts`, `apps/web/src/api/queries/inbox.ts`, `apps/web/src/api/queries/templates.ts`, `apps/web/src/api/queries/launch.ts`, `apps/web/src/api/queries/archive.ts`
- Create: `apps/web/src/api/live-events.ts`, `apps/web/src/api/live-events.test.tsx`, `apps/web/src/api/queries/inbox.test.tsx`
- Create: `apps/web/src/features/inbox/useInboxTitle.ts`
- Modify: `apps/web/src/features/shell/AppShell.tsx`, `apps/web/package.json` (make sure `@orc/core` and `@orc/api-contract` are `workspace:*` dependencies)

**Interfaces:**
- Consumes: `getApiClient()`, `setApiClientForTests()` (P1 `api/client.ts`); the P2 client methods (Task 2); `useProjectStore` (contracts §12); `Session`, `InboxItem`, `InboxKind`, `InboxState`, `Source` (core); `LaunchRequestInput`, `NotificationPrefs`, `ArchiveStatus`, `TemplateDto`, `OpenInApp` (api-contract)
- Produces:
  ```ts
  // test/query.tsx
  export function makeQueryClient(): QueryClient
  export function renderWithClient(ui: ReactElement, opts?: { queryClient?: QueryClient }): RenderResult & { queryClient: QueryClient }
  export function renderInRouter(ui: ReactElement, opts?: { queryClient?: QueryClient; path?: string }): Promise<RenderResult & { queryClient: QueryClient; router: AnyRouter }>
  export function fakeApi(stubs: Partial<ApiClient>): ApiClient
  export function makeSession(over?: Partial<Session> & { live?: Partial<LiveState> | null }): Session
  export function makeInboxItem(over?: Partial<InboxItem>): InboxItem
  // api/queries/live.ts
  export const liveKey: readonly ['live']
  export function useLive(): UseQueryResult<Session[]>
  // api/queries/inbox.ts
  export interface InboxFilters { state?: InboxState[]; kind?: InboxKind[]; projectId?: string }
  export const inboxKey: (f: InboxFilters) => readonly ['inbox', InboxFilters]
  export function scopeProject(projectId: string | null | undefined): string | undefined     // null/'all' → undefined
  export function matchesInboxFilter(item: InboxItem, f: InboxFilters): boolean
  export function upsertInboxItemInCache(qc: QueryClient, item: InboxItem): void
  export function useInbox(f: InboxFilters): UseQueryResult<InboxItem[]>
  export type InboxAction = { id: string; action: 'done' } | { id: string; action: 'reopen' } | { id: string; action: 'snooze'; until: string }
  export function useInboxAction(): UseMutationResult<InboxItem, Error, InboxAction>
  export function useOpenInboxCount(projectId?: string): number
  // api/queries/templates.ts
  export function useTemplates(projectId?: string): UseQueryResult<TemplateDto[]>
  // api/queries/launch.ts
  export function useLaunch(): UseMutationResult<{ ptyId: string; sessionId: string | null }, Error, LaunchRequestInput>
  export function useKill(): UseMutationResult<{ killed: 'pty' | 'pid' }, Error, { source: Source; id: string }>
  export function useOpenIn(): UseMutationResult<{ ok: true }, Error, { source: Source; id: string; app: OpenInApp }>
  // api/queries/archive.ts
  export const archiveStatusKey: readonly ['archive-status']
  export const notificationPrefsKey: readonly ['notification-prefs']
  export function useArchiveStatus(): UseQueryResult<ArchiveStatus>
  export function useArchiveRestore(): UseMutationResult<{ restored: string[] }, Error, { source: Source; id: string }>
  export function useNotificationPrefs(): UseQueryResult<NotificationPrefs>
  export function useSaveNotificationPrefs(): UseMutationResult<NotificationPrefs, Error, NotificationPrefs>
  // api/live-events.ts
  export type WireEvent = …   // hello | session.updated | session.removed | inbox.upserted | pty.exited | index.progress | usage.updated
  export const pkOf: (s: { source: Source; id: string }) => string
  export function applyLiveEvent(qc: QueryClient, e: WireEvent): void
  export function liveWsUrl(loc: Pick<Location, 'protocol' | 'host'>, token: string): string
  export function useLiveEvents(opts?: { url?: string; WebSocketImpl?: typeof WebSocket }): { connected: boolean }
  // features/inbox/useInboxTitle.ts
  export function inboxTitle(count: number): string
  export function useInboxTitle(count: number): void
  ```

**Cache rules:**
- `hello` (first connect and every reconnect) invalidates `['live']` and `['inbox']`, so a reconnecting client resyncs.
- `session.updated`:
  - `['live']`: replaces the session in place, appends it if it's new and live, or removes it when `live === null`.
  - `['session', source, id]`: merged into it if that entry is cached.
- `session.removed`: drops the session from `['live']`.
- `inbox.upserted`: for **every** cached `['inbox', filters]` entry, the item is removed and then re-added at the top only if it matches the filters. This is how a done item leaves the "open" list.
- `pty.exited`: invalidates `['live']`.
- **Reconnect:** backoff of `min(30 s, 500 ms × 2^attempt)`, reset once the connection opens.

- [ ] **Step 1: Write the test helpers**

`apps/web/src/test/query.tsx`
```tsx
import type { ApiClient } from '@orc/api-contract';
import type { InboxItem, LiveState, Session } from '@orc/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type AnyRouter, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { type RenderResult, render } from '@testing-library/react';
import type { ReactElement } from 'react';

export function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY }, mutations: { retry: false } } });
}

export function renderWithClient(ui: ReactElement, opts: { queryClient?: QueryClient } = {}) {
  const queryClient = opts.queryClient ?? makeQueryClient();
  const result: RenderResult = render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return { ...result, queryClient };
}

/** Renders `ui` at `path` inside a throwaway memory router, so `<Link>` and `useNavigate` work. */
export async function renderInRouter(ui: ReactElement, opts: { queryClient?: QueryClient; path?: string } = {}) {
  const root = createRootRoute();
  const page = createRoute({ getParentRoute: () => root, path: opts.path ?? '/', component: () => ui });
  const catchAll = createRoute({ getParentRoute: () => root, path: '$', component: () => <div data-testid="navigated" /> });
  const router = createRouter({
    routeTree: root.addChildren([page, catchAll]),
    history: createMemoryHistory({ initialEntries: [opts.path ?? '/'] }),
  }) as unknown as AnyRouter;
  const r = renderWithClient(<RouterProvider router={router} />, opts);
  await router.load();
  return { ...r, router };
}

export function fakeApi(stubs: Partial<ApiClient>): ApiClient {
  return new Proxy(stubs, {
    get(target, key) {
      if (key in target) return target[key as keyof ApiClient];
      return () => Promise.reject(new Error(`fakeApi: ${String(key)} is not stubbed`));
    },
  }) as ApiClient;
}

const baseLive: LiveState = {
  pid: 4242, status: 'busy', waitingFor: null, since: '2026-09-01T09:00:00.000Z', ownership: 'observed', ptyId: null,
  stage: null, currentTool: null, backgroundJobs: 0, runningSubagents: 0, contextFill: null,
};

export function makeSession(over: Partial<Omit<Session, 'live'>> & { live?: Partial<LiveState> | null } = {}): Session {
  const { live, ...rest } = over;
  return {
    id: 's1', source: 'claude', projectId: 'wakecap', startCwd: '/Users/test/Wakecap', cwds: ['/Users/test/Wakecap'],
    name: 'Session one', firstPrompt: 'first', lastPrompt: 'last prompt', awaySummary: null, recap: null,
    startedAt: '2026-09-01T08:00:00.000Z', lastActivityAt: '2026-09-01T09:00:00.000Z', models: ['claude-opus-5'],
    permissionMode: 'bypassPermissions',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 1.25 }, linesAdded: null, linesRemoved: null,
    prs: [], tickets: [], skills: [], mcpServers: [], filesTouched: [], promptCount: 1, toolCallCount: 0, apiErrorCount: 0,
    flags: { touchedProd: false, hasSubagents: false, automated: false }, availability: 'resumable', transcriptPath: null,
    lastTest: null,
    ...rest,
    live: live === null ? null : { ...baseLive, ...live },
  };
}

export function makeInboxItem(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'i1', kind: 'waiting', sessionId: 's1', projectId: 'wakecap', ticket: null, reason: 'Session one: waiting — input needed',
    dedupeKey: 'waiting:claude:s1', createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-01T09:00:00.000Z',
    state: 'open', snoozeUntil: null, payload: { source: 'claude', id: 's1' }, ...over,
  };
}
```

- [ ] **Step 2: Write the failing tests**

`apps/web/src/api/live-events.test.tsx`
```tsx
import type { Session } from '@orc/core';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeInboxItem, makeQueryClient, makeSession } from '../test/query.tsx';
import { applyLiveEvent, liveWsUrl, useLiveEvents } from './live-events.ts';
import { inboxKey } from './queries/inbox.ts';
import { liveKey } from './queries/live.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('applyLiveEvent', () => {
  it('replaces, appends and removes live sessions', () => {
    const qc = makeQueryClient();
    qc.setQueryData(liveKey, [makeSession({ id: 'a' }), makeSession({ id: 'b' })]);
    applyLiveEvent(qc, { type: 'session.updated', session: makeSession({ id: 'a', live: { status: 'waiting' } }) });
    applyLiveEvent(qc, { type: 'session.updated', session: makeSession({ id: 'c' }) });
    let live = qc.getQueryData<Session[]>(liveKey) ?? [];
    expect(live.map((s) => [s.id, s.live?.status])).toEqual([['a', 'waiting'], ['b', 'busy'], ['c', 'busy']]);
    applyLiveEvent(qc, { type: 'session.updated', session: makeSession({ id: 'b', live: null }) });
    applyLiveEvent(qc, { type: 'session.removed', pk: 'claude:c' });
    live = qc.getQueryData<Session[]>(liveKey) ?? [];
    expect(live.map((s) => s.id)).toEqual(['a']);
  });

  it('merges into a cached session detail', () => {
    const qc = makeQueryClient();
    qc.setQueryData(['session', 'claude', 'a'], makeSession({ id: 'a', name: 'old' }));
    applyLiveEvent(qc, { type: 'session.updated', session: makeSession({ id: 'a', name: 'new', live: { status: 'review' } }) });
    expect(qc.getQueryData<Session>(['session', 'claude', 'a'])).toMatchObject({ name: 'new', live: { status: 'review' } });
  });

  it('moves inbox items between filtered caches', () => {
    const qc = makeQueryClient();
    qc.setQueryData(inboxKey({ state: ['open'] }), [makeInboxItem({ id: 'x' })]);
    qc.setQueryData(inboxKey({ state: ['done'] }), []);
    qc.setQueryData(inboxKey({ state: ['open'], projectId: 'forza' }), []);
    applyLiveEvent(qc, { type: 'inbox.upserted', item: makeInboxItem({ id: 'y', updatedAt: '2026-09-01T10:00:00.000Z' }) });
    expect(qc.getQueryData<unknown[]>(inboxKey({ state: ['open'] }))).toHaveLength(2);
    expect(qc.getQueryData<unknown[]>(inboxKey({ state: ['open'], projectId: 'forza' }))).toHaveLength(0);
    applyLiveEvent(qc, { type: 'inbox.upserted', item: makeInboxItem({ id: 'x', state: 'done' }) });
    expect(qc.getQueryData<Array<{ id: string }>>(inboxKey({ state: ['open'] }))?.map((i) => i.id)).toEqual(['y']);
    expect(qc.getQueryData<Array<{ id: string }>>(inboxKey({ state: ['done'] }))?.map((i) => i.id)).toEqual(['x']);
  });

  it('invalidates on hello', () => {
    const qc = makeQueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    applyLiveEvent(qc, { type: 'hello', serverTime: '2026-09-01T09:00:00.000Z' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['live'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['inbox'] });
  });
});

describe('liveWsUrl', () => {
  it('builds ws/wss URLs with the token', () => {
    expect(liveWsUrl({ protocol: 'http:', host: '127.0.0.1:4317' }, 'a b')).toBe('ws://127.0.0.1:4317/ws?token=a%20b');
    expect(liveWsUrl({ protocol: 'https:', host: 'mac.tailnet.ts.net' }, 't')).toBe('wss://mac.tailnet.ts.net/ws?token=t');
  });
});

class FakeWS {
  static instances: FakeWS[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.instances.push(this);
  }
  close() {
    this.onclose?.();
  }
}

describe('useLiveEvents', () => {
  it('connects, applies messages and reconnects with backoff', () => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    const qc = makeQueryClient();
    qc.setQueryData(liveKey, []);
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result, unmount } = renderHook(
      () => useLiveEvents({ url: 'ws://x/ws?token=t', WebSocketImpl: FakeWS as unknown as typeof WebSocket }),
      { wrapper },
    );
    const first = FakeWS.instances[0];
    expect(first?.url).toBe('ws://x/ws?token=t');
    act(() => first?.onopen?.());
    expect(result.current.connected).toBe(true);
    act(() => first?.onmessage?.({ data: JSON.stringify({ type: 'session.updated', session: makeSession({ id: 'z' }) }) }));
    act(() => first?.onmessage?.({ data: 'not json' }));
    expect(qc.getQueryData<Session[]>(liveKey)?.map((s) => s.id)).toEqual(['z']);
    act(() => first?.close());
    expect(result.current.connected).toBe(false);
    act(() => vi.advanceTimersByTime(499));
    expect(FakeWS.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeWS.instances).toHaveLength(2);
    act(() => FakeWS.instances[1]?.close());
    act(() => vi.advanceTimersByTime(999));
    expect(FakeWS.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeWS.instances).toHaveLength(3);
    unmount();
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWS.instances).toHaveLength(3);
  });
});
```

`apps/web/src/api/queries/inbox.test.tsx`
```tsx
import type { InboxItem } from '@orc/core';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, makeInboxItem, makeQueryClient } from '../../test/query.tsx';
import { setApiClientForTests } from '../client.ts';
import { inboxKey, matchesInboxFilter, scopeProject, useInboxAction, useOpenInboxCount } from './inbox.ts';
import { inboxTitle } from '../../features/inbox/useInboxTitle.ts';

afterEach(cleanup);

describe('inbox helpers', () => {
  it('scopes projects and matches filters', () => {
    expect(scopeProject(null)).toBeUndefined();
    expect(scopeProject('all')).toBeUndefined();
    expect(scopeProject('wakecap')).toBe('wakecap');
    const item = makeInboxItem();
    expect(matchesInboxFilter(item, {})).toBe(true);
    expect(matchesInboxFilter(item, { state: ['done'] })).toBe(false);
    expect(matchesInboxFilter(item, { kind: ['waiting', 'review'], projectId: 'wakecap' })).toBe(true);
    expect(matchesInboxFilter(item, { projectId: 'forza' })).toBe(false);
  });

  it('formats the tab title', () => {
    expect(inboxTitle(0)).toBe('Orchestrator');
    expect(inboxTitle(3)).toBe('(3) Orchestrator');
  });
});

describe('inbox hooks', () => {
  it('counts open items and updates caches after an action', async () => {
    const done: InboxItem = makeInboxItem({ state: 'done', updatedAt: '2026-09-01T09:05:00.000Z' });
    const inboxList = vi.fn(async () => [makeInboxItem()]);
    const inboxDone = vi.fn(async () => done);
    setApiClientForTests(fakeApi({ inboxList, inboxDone }));
    const qc = makeQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const count = renderHook(() => useOpenInboxCount('wakecap'), { wrapper });
    await waitFor(() => expect(count.result.current).toBe(1));
    expect(inboxList).toHaveBeenCalledWith({ state: ['open'], projectId: 'wakecap' });
    const action = renderHook(() => useInboxAction(), { wrapper });
    await act(() => action.result.current.mutateAsync({ id: 'i1', action: 'done' }));
    expect(inboxDone).toHaveBeenCalledWith('i1');
    expect(qc.getQueryData(inboxKey({ state: ['open'], projectId: 'wakecap' }))).toEqual([]);
    await waitFor(() => expect(count.result.current).toBe(0));
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `pnpm vitest run apps/web/src/api`
Expected: FAIL, `Cannot find module './live-events.ts'`

- [ ] **Step 4: Implement the queries**

`apps/web/src/api/queries/live.ts`
```ts
import type { Session } from '@orc/core';
import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export const liveKey = ['live'] as const;

export function useLive() {
  return useQuery<Session[]>({ queryKey: liveKey, queryFn: () => getApiClient().liveList(), staleTime: 30_000 });
}
```

`apps/web/src/api/queries/inbox.ts`
```ts
import type { InboxItem, InboxKind, InboxState } from '@orc/core';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export interface InboxFilters {
  state?: InboxState[];
  kind?: InboxKind[];
  projectId?: string;
}

export const inboxKey = (f: InboxFilters) => ['inbox', f] as const;

export function scopeProject(projectId: string | null | undefined): string | undefined {
  return projectId && projectId !== 'all' ? projectId : undefined;
}

export function matchesInboxFilter(item: InboxItem, f: InboxFilters): boolean {
  if (f.state?.length && !f.state.includes(item.state)) return false;
  if (f.kind?.length && !f.kind.includes(item.kind)) return false;
  if (f.projectId && item.projectId !== f.projectId) return false;
  return true;
}

export function upsertInboxItemInCache(qc: QueryClient, item: InboxItem): void {
  for (const [key, data] of qc.getQueriesData<InboxItem[]>({ queryKey: ['inbox'] })) {
    if (!data) continue;
    const filters = (key[1] ?? {}) as InboxFilters;
    const rest = data.filter((i) => i.id !== item.id);
    const next = matchesInboxFilter(item, filters) ? [item, ...rest] : rest;
    next.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    qc.setQueryData(key, next);
  }
}

export function useInbox(f: InboxFilters) {
  return useQuery<InboxItem[]>({ queryKey: inboxKey(f), queryFn: () => getApiClient().inboxList(f) });
}

export type InboxAction =
  | { id: string; action: 'done' }
  | { id: string; action: 'reopen' }
  | { id: string; action: 'snooze'; until: string };

export function useInboxAction() {
  const qc = useQueryClient();
  return useMutation<InboxItem, Error, InboxAction>({
    mutationFn: (a) => {
      const api = getApiClient();
      if (a.action === 'done') return api.inboxDone(a.id);
      if (a.action === 'reopen') return api.inboxReopen(a.id);
      return api.inboxSnooze(a.id, a.until);
    },
    onSuccess: (item) => upsertInboxItemInCache(qc, item),
  });
}

export function useOpenInboxCount(projectId?: string): number {
  return useInbox({ state: ['open'], projectId }).data?.length ?? 0;
}
```

In the test, `useOpenInboxCount('wakecap')` produces `{ state: ['open'], projectId: 'wakecap' }`. `inboxList` receives exactly that object.

`apps/web/src/api/queries/templates.ts`
```ts
import type { TemplateDto } from '@orc/api-contract';
import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export function useTemplates(projectId?: string) {
  return useQuery<TemplateDto[]>({
    queryKey: ['templates', projectId ?? null],
    queryFn: () => getApiClient().templatesList(projectId),
    staleTime: 5 * 60_000,
  });
}
```

`apps/web/src/api/queries/launch.ts`
```ts
import type { LaunchRequestInput, OpenInApp } from '@orc/api-contract';
import type { Source } from '@orc/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export function useLaunch() {
  const qc = useQueryClient();
  return useMutation<{ ptyId: string; sessionId: string | null }, Error, LaunchRequestInput>({
    mutationFn: (req) => getApiClient().sessionsLaunch(req),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['live'] }),
  });
}

export function useKill() {
  return useMutation<{ killed: 'pty' | 'pid' }, Error, { source: Source; id: string }>({
    mutationFn: ({ source, id }) => getApiClient().sessionsKill(source, id, true),
  });
}

export function useOpenIn() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { source: Source; id: string; app: OpenInApp }>({
    mutationFn: ({ source, id, app }) => getApiClient().sessionsOpenIn(source, id, app, true),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}
```

`apps/web/src/api/queries/archive.ts`
```ts
import type { ArchiveStatus, NotificationPrefs } from '@orc/api-contract';
import type { Source } from '@orc/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export const archiveStatusKey = ['archive-status'] as const;
export const notificationPrefsKey = ['notification-prefs'] as const;

export function useArchiveStatus() {
  return useQuery<ArchiveStatus>({ queryKey: archiveStatusKey, queryFn: () => getApiClient().archiveStatus() });
}

export function useArchiveRestore() {
  const qc = useQueryClient();
  return useMutation<{ restored: string[] }, Error, { source: Source; id: string }>({
    mutationFn: ({ source, id }) => getApiClient().archiveRestore(source, id, true),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: archiveStatusKey });
      void qc.invalidateQueries({ queryKey: ['session', v.source, v.id] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export function useNotificationPrefs() {
  return useQuery<NotificationPrefs>({ queryKey: notificationPrefsKey, queryFn: () => getApiClient().notificationsGet() });
}

export function useSaveNotificationPrefs() {
  const qc = useQueryClient();
  return useMutation<NotificationPrefs, Error, NotificationPrefs>({
    mutationFn: (p) => getApiClient().notificationsPut(p),
    onSuccess: (p) => qc.setQueryData(notificationPrefsKey, p),
  });
}
```

- [ ] **Step 5: Implement the WS hook and the title hook**

`apps/web/src/api/live-events.ts`
```ts
import type { InboxItem, Session, Source } from '@orc/core';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { upsertInboxItemInCache } from './queries/inbox.ts';
import { liveKey } from './queries/live.ts';

export type WireEvent =
  | { type: 'hello'; serverTime: string }
  | { type: 'session.updated'; session: Session }
  | { type: 'session.removed'; pk: string }
  | { type: 'inbox.upserted'; item: InboxItem }
  | { type: 'pty.exited'; ptyId: string; code: number | null }
  | { type: 'index.progress'; done: number; total: number }
  | { type: 'usage.updated'; snapshot: unknown };

export const pkOf = (s: { source: Source; id: string }): string => `${s.source}:${s.id}`;

export function applyLiveEvent(qc: QueryClient, e: WireEvent): void {
  switch (e.type) {
    case 'hello':
      void qc.invalidateQueries({ queryKey: ['live'] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
      return;
    case 'session.updated': {
      const s = e.session;
      const pk = pkOf(s);
      qc.setQueryData<Session[]>(liveKey, (old) => {
        if (!old) return old;
        if (!s.live) return old.filter((x) => pkOf(x) !== pk);
        const idx = old.findIndex((x) => pkOf(x) === pk);
        if (idx === -1) return [...old, s];
        const next = old.slice();
        next[idx] = s;
        return next;
      });
      qc.setQueryData<Session>(['session', s.source, s.id], (old) => (old ? { ...old, ...s } : old));
      return;
    }
    case 'session.removed':
      qc.setQueryData<Session[]>(liveKey, (old) => old?.filter((x) => pkOf(x) !== e.pk));
      return;
    case 'inbox.upserted':
      upsertInboxItemInCache(qc, e.item);
      return;
    case 'pty.exited':
      void qc.invalidateQueries({ queryKey: ['live'] });
      return;
    default:
      return;
  }
}

export function liveWsUrl(loc: Pick<Location, 'protocol' | 'host'>, token: string): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}/ws?token=${encodeURIComponent(token)}`;
}

export function useLiveEvents(opts: { url?: string; WebSocketImpl?: typeof WebSocket } = {}): { connected: boolean } {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const { url, WebSocketImpl } = opts;

  useEffect(() => {
    const Impl = WebSocketImpl ?? WebSocket;
    const token = (window as unknown as { __ORC_TOKEN__?: string }).__ORC_TOKEN__ ?? '';
    const target = url ?? liveWsUrl(window.location, token);
    let ws: WebSocket | null = null;
    let disposed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      ws = new Impl(target);
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = (m: MessageEvent) => {
        try {
          applyLiveEvent(qc, JSON.parse(String(m.data)) as WireEvent);
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (disposed) return;
        const delay = Math.min(30_000, 500 * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [qc, url, WebSocketImpl]);

  return { connected };
}
```

`apps/web/src/features/inbox/useInboxTitle.ts`
```ts
import { useEffect } from 'react';

export function inboxTitle(count: number): string {
  return count > 0 ? `(${count}) Orchestrator` : 'Orchestrator';
}

export function useInboxTitle(count: number): void {
  useEffect(() => {
    document.title = inboxTitle(count);
  }, [count]);
}
```

In `apps/web/src/features/shell/AppShell.tsx`, add these at the top of the `AppShell` function body. Keep everything else.
```tsx
import { useLiveEvents } from '@/api/live-events';
import { scopeProject, useOpenInboxCount } from '@/api/queries/inbox';
import { useInboxTitle } from '@/features/inbox/useInboxTitle';
import { useProjectStore } from '@/stores/project';

// inside AppShell():
useLiveEvents();
const scopedProjectId = scopeProject(useProjectStore((s) => s.projectId));
const openInboxCount = useOpenInboxCount(scopedProjectId);
useInboxTitle(openInboxCount);
```
Task 19 renders `openInboxCount` in the top bar.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/web/src/api`
Expected: PASS (8 new tests, plus the existing P1 ones)

- [ ] **Step 7: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/web/src/api apps/web/src/test/query.tsx apps/web/src/features/inbox/useInboxTitle.ts apps/web/src/features/shell/AppShell.tsx apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): add live/inbox/launch/archive queries and the /ws cache bridge"
```

---

### Task 18: web — Live Board (`/live`): cards, attention-first sort, layouts, grouping, card actions

**Files:**
- Create: `apps/web/src/stores/live-layout.ts`
- Create: `apps/web/src/features/live-board/sort.ts`, `apps/web/src/features/live-board/sort.test.ts`
- Create: `apps/web/src/features/live-board/StageBar.tsx`, `TestChip.tsx`, `OpenInButton.tsx`, `SessionCard.tsx`, `LiveBoard.tsx`
- Create: `apps/web/src/features/live-board/SessionCard.test.tsx`, `apps/web/src/features/live-board/LiveBoard.test.tsx`
- Create: `apps/web/src/routes/live.tsx`
- Modify: `apps/web/src/features/shell/AppShell.tsx` (nav link "Live")

**Interfaces:**
- Consumes: `useLive`, `useKill`, `useOpenIn` (Task 17); `scopeProject` (Task 17); `useProjectStore`, `useTerminalStore` (contracts §12); `Button`, `Badge` from `@/components/ui`; `renderInRouter`, `fakeApi`, `makeSession` (Task 17); `OpenInApp` (Task 2)
- Produces:
  ```ts
  // stores/live-layout.ts
  export type LiveLayout = 'grid' | 'list' | 'split'
  export type LiveGroupBy = 'none' | 'project' | 'ticket' | 'source'
  export const MAX_PINNED = 4
  export const useLiveLayoutStore: UseBoundStore<StoreApi<{ layout: LiveLayout; pinned: string[]; groupBy: LiveGroupBy; openInByProject: Record<string, OpenInApp>; setLayout(l: LiveLayout): void; togglePin(pk: string): void; setGroupBy(g: LiveGroupBy): void; setOpenIn(projectId: string, app: OpenInApp): void }>>
  // features/live-board/sort.ts
  export const STATUS_LABEL: Record<LiveStatus, string>
  export function attentionRank(status: LiveStatus): number
  export function isAttention(status: LiveStatus): boolean
  export function sortLive(sessions: Session[]): Session[]
  export function filterByProject(sessions: Session[], projectId?: string): Session[]
  export function groupLive(sessions: Session[], by: LiveGroupBy): Array<{ key: string; label: string; sessions: Session[] }>
  export function formatDuration(ms: number): string
  export function permissionBadge(mode: string | null): 'bypass' | 'plan' | 'auto' | 'default' | 'custom' | null
  export function hasDrift(s: Session): boolean
  export function shortPath(p: string): string
  export function resumeCommand(s: Session): string
  export function testChipText(t: TestResult): string
  // components
  export function StageBar(props: { stage: Stage | null }): JSX.Element
  export function TestChip(props: { result: TestResult | null }): JSX.Element | null
  export function OpenInButton(props: { session: Session }): JSX.Element
  export function SessionCard(props: { session: Session; now: number; compact?: boolean; pinned: boolean; onTogglePin: () => void }): JSX.Element | null
  export function LiveBoard(props: { now?: () => number }): JSX.Element
  ```

**UI rules (docs/02 F1):**
- **Sort:** `waiting` → `review` → `blocked` → `error` → `busy` → `shell` → `idle` → `ended`. Within a status, the card that has been in that state longest comes first.
- **Attention cards** carry `data-attention="true"` and pulse (`animate-pulse` on the status badge).
- **Time in state** ticks every second.
- **Layouts:**
  - `grid`: responsive cards
  - `list`: compact cards
  - `split`: only the pinned sessions (2–4), side by side in equal columns; it shows a hint when fewer than 2 are pinned
- **Pins:** keep the most recent 4.
- **Group by:** none / project / ticket (first ticket, or "No ticket") / source.
- **Project scope:** the global project selector filters the board (`all` shows everything).
- **Card actions:**
  - Terminal (owned sessions only; opens the dock tab)
  - Details
  - Diff (disabled, "Available in Phase 4")
  - Copy resume command
  - Open in… split button: it remembers the app per project, locally and on the server via `remember: true`
  - Pin
  - Stop (after `window.confirm`)

- [ ] **Step 1: Write the failing tests**

`apps/web/src/features/live-board/sort.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { makeSession } from '../../test/query.tsx';
import {
  attentionRank, filterByProject, formatDuration, groupLive, hasDrift, permissionBadge, resumeCommand, shortPath, sortLive, testChipText,
} from './sort.ts';

describe('live board helpers', () => {
  it('sorts attention first, longest-waiting first', () => {
    const list = [
      makeSession({ id: 'busy', live: { status: 'busy', since: '2026-09-01T08:00:00.000Z' } }),
      makeSession({ id: 'w-new', live: { status: 'waiting', since: '2026-09-01T09:30:00.000Z' } }),
      makeSession({ id: 'review', live: { status: 'review' } }),
      makeSession({ id: 'w-old', live: { status: 'waiting', since: '2026-09-01T09:00:00.000Z' } }),
      makeSession({ id: 'ended', live: { status: 'ended' } }),
      makeSession({ id: 'err', live: { status: 'error' } }),
    ];
    expect(sortLive(list).map((s) => s.id)).toEqual(['w-old', 'w-new', 'review', 'err', 'busy', 'ended']);
    expect(attentionRank('blocked')).toBeLessThan(attentionRank('error'));
  });

  it('filters and groups', () => {
    const list = [
      makeSession({ id: 'a', projectId: 'wakecap', tickets: ['SAF-1'] }),
      makeSession({ id: 'b', projectId: 'forza', source: 'codex' }),
    ];
    expect(filterByProject(list, 'forza').map((s) => s.id)).toEqual(['b']);
    expect(filterByProject(list, undefined)).toHaveLength(2);
    expect(groupLive(list, 'none')).toEqual([{ key: 'all', label: 'All sessions', sessions: list }]);
    expect(groupLive(list, 'project').map((g) => [g.label, g.sessions.map((s) => s.id)])).toEqual([['wakecap', ['a']], ['forza', ['b']]]);
    expect(groupLive(list, 'ticket').map((g) => g.label)).toEqual(['SAF-1', 'No ticket']);
    expect(groupLive(list, 'source').map((g) => g.label)).toEqual(['Claude', 'Codex']);
  });

  it('formats durations, badges, paths and commands', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration(3 * 3600_000 + 5 * 60_000)).toBe('3h 05m');
    expect(formatDuration(2 * 86400_000 + 4 * 3600_000)).toBe('2d 4h');
    expect(formatDuration(-5)).toBe('0s');
    expect(permissionBadge('bypassPermissions')).toBe('bypass');
    expect(permissionBadge('plan')).toBe('plan');
    expect(permissionBadge('acceptEdits')).toBe('auto');
    expect(permissionBadge('weird')).toBe('custom');
    expect(permissionBadge(null)).toBeNull();
    expect(hasDrift(makeSession({ cwds: ['/a', '/a/b'] }))).toBe(true);
    expect(hasDrift(makeSession())).toBe(false);
    expect(shortPath('/Users/test/Wakecap/Backend/svc')).toBe('~/Wakecap/Backend/svc');
    expect(shortPath('/Users/test/a/b/c/d/e/f')).toBe('~/…/d/e/f');
    expect(resumeCommand(makeSession({ id: 's-1', startCwd: "/Users/test/it's" }))).toBe("cd '/Users/test/it'\\''s' && claude --resume s-1");
    expect(resumeCommand(makeSession({ id: 'c-1', source: 'codex' }))).toBe("cd '/Users/test/Wakecap' && codex resume c-1");
    expect(testChipText({ ts: '', command: '', passed: 18, failed: 0, skipped: 0, durationMs: null })).toBe('✓ 18 · ✗ 0');
  });
});
```

`apps/web/src/features/live-board/SessionCard.test.tsx`
```tsx
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { useLiveLayoutStore } from '../../stores/live-layout.ts';
import { useTerminalStore } from '../../stores/terminals.ts';
import { fakeApi, makeSession, renderInRouter } from '../../test/query.tsx';
import { SessionCard } from './SessionCard.tsx';

const NOW = Date.parse('2026-09-01T09:10:00.000Z');
const sessionsKill = vi.fn(async () => ({ killed: 'pty' as const }));
const sessionsOpenIn = vi.fn(async () => ({ ok: true as const }));

beforeEach(() => {
  setApiClientForTests(fakeApi({ sessionsKill, sessionsOpenIn }));
  useLiveLayoutStore.setState({ openInByProject: {} });
  sessionsKill.mockClear();
  sessionsOpenIn.mockClear();
});
afterEach(cleanup);

const full = makeSession({
  id: 's-live',
  name: 'SLA weekends',
  cwds: ['/Users/test/Wakecap', '/Users/test/Wakecap/Backend/svc'],
  lastPrompt: 'run the tests again',
  tickets: ['SAF-1787'],
  prs: [{ repo: 'example-org/svc', number: 231, url: 'https://github.com/example-org/svc/pull/231' }],
  lastTest: { ts: '', command: 'pnpm test', passed: 16, failed: 2, skipped: 0, durationMs: 1400 },
  live: {
    status: 'waiting', waitingFor: 'input needed', since: '2026-09-01T09:05:00.000Z', ownership: 'owned', ptyId: 'pty-1',
    stage: 'test', currentTool: 'Bash', backgroundJobs: 2, runningSubagents: 3, contextFill: 0.42,
  },
});

describe('SessionCard', () => {
  it('shows every F1 field', async () => {
    await renderInRouter(<SessionCard session={full} now={NOW} pinned={false} onTogglePin={() => {}} />);
    const card = await screen.findByRole('article', { name: 'SLA weekends — Waiting' });
    const c = within(card);
    expect(card.dataset.attention).toBe('true');
    expect(c.getByText('Claude')).toBeTruthy();
    expect(c.getByText('5m')).toBeTruthy();
    expect(c.getByText('input needed')).toBeTruthy();
    expect(c.getByText('~/Wakecap/Backend/svc')).toBeTruthy();
    expect(c.getByLabelText('cwd drift')).toBeTruthy();
    expect(c.getByText('Bash')).toBeTruthy();
    expect(c.getByText('run the tests again')).toBeTruthy();
    expect(c.getByText('$1.25')).toBeTruthy();
    expect(c.getByText('ctx 42%')).toBeTruthy();
    expect(c.getByText('SAF-1787')).toBeTruthy();
    expect(c.getByRole('link', { name: '#231' }).getAttribute('href')).toBe('https://github.com/example-org/svc/pull/231');
    expect(c.getByRole('list', { name: 'Stage' }).querySelector('[aria-current="step"]')?.textContent).toBe('Test');
    expect(c.getByText('✓ 16 · ✗ 2').closest('[data-failed]')?.getAttribute('data-failed')).toBe('true');
    expect(c.getByText('2 jobs')).toBeTruthy();
    expect(c.getByText('bypass')).toBeTruthy();
    expect(c.getByText('3 agents')).toBeTruthy();
    expect((c.getByRole('button', { name: 'Diff' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the terminal for owned sessions and stops after confirmation', async () => {
    const open = vi.fn();
    useTerminalStore.setState({ open });
    await renderInRouter(<SessionCard session={full} now={NOW} pinned={false} onTogglePin={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Terminal' }));
    expect(open).toHaveBeenCalledWith('pty-1', 'SLA weekends');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(sessionsKill).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await vi.waitFor(() => expect(sessionsKill).toHaveBeenCalledWith('claude', 's-live', true));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('hides the terminal button for observed sessions and remembers open-in per project', async () => {
    const observed = makeSession({ live: { ownership: 'observed' } });
    await renderInRouter(<SessionCard session={observed} now={NOW} pinned onTogglePin={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Unpin' })).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Open in app' }), { target: { value: 'finder' } });
    expect(useLiveLayoutStore.getState().openInByProject.wakecap).toBe('finder');
    fireEvent.click(screen.getByRole('button', { name: 'Open in Finder' }));
    await vi.waitFor(() => expect(sessionsOpenIn).toHaveBeenCalledWith('claude', 's1', 'finder', true));
  });
});
```

`apps/web/src/features/live-board/LiveBoard.test.tsx`
```tsx
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { useLiveLayoutStore } from '../../stores/live-layout.ts';
import { useProjectStore } from '../../stores/project.ts';
import { fakeApi, makeSession, renderInRouter } from '../../test/query.tsx';
import { LiveBoard } from './LiveBoard.tsx';

const sessions = [
  makeSession({ id: 'a', name: 'Alpha', live: { status: 'busy' } }),
  makeSession({ id: 'b', name: 'Bravo', live: { status: 'waiting' } }),
  makeSession({ id: 'c', name: 'Charlie', live: { status: 'review' } }),
  makeSession({ id: 'd', name: 'Delta', projectId: 'forza', live: { status: 'idle' } }),
];

beforeEach(() => {
  setApiClientForTests(fakeApi({ liveList: async () => sessions }));
  useLiveLayoutStore.setState({ layout: 'grid', pinned: [], groupBy: 'none', openInByProject: {} });
  useProjectStore.setState({ projectId: 'all' });
});
afterEach(cleanup);

const names = () => screen.getAllByRole('article').map((a) => a.getAttribute('aria-label')?.split(' — ')[0]);

describe('LiveBoard', () => {
  it('lists live sessions attention-first and respects the project scope', async () => {
    await renderInRouter(<LiveBoard now={() => Date.parse('2026-09-01T09:10:00.000Z')} />);
    await screen.findByRole('article', { name: /Bravo/ });
    expect(names()).toEqual(['Bravo', 'Charlie', 'Alpha', 'Delta']);
    cleanup();
    useProjectStore.setState({ projectId: 'wakecap' });
    await renderInRouter(<LiveBoard />);
    await screen.findByRole('article', { name: /Bravo/ });
    expect(names()).toEqual(['Bravo', 'Charlie', 'Alpha']);
  });

  it('groups by project', async () => {
    await renderInRouter(<LiveBoard />);
    await screen.findByRole('article', { name: /Bravo/ });
    fireEvent.change(screen.getByRole('combobox', { name: 'Group by' }), { target: { value: 'project' } });
    const groups = screen.getAllByRole('region');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['wakecap', 'forza']);
    expect(within(groups[1] as HTMLElement).getAllByRole('article')).toHaveLength(1);
  });

  it('shows pinned sessions side by side in split layout', async () => {
    await renderInRouter(<LiveBoard />);
    await screen.findByRole('article', { name: /Bravo/ });
    fireEvent.click(screen.getByRole('radio', { name: 'Split' }));
    expect(screen.getByText('Pin 2–4 sessions to compare them side by side.')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Grid' }));
    fireEvent.click(within(screen.getByRole('article', { name: /Bravo/ })).getByRole('button', { name: 'Pin' }));
    fireEvent.click(within(screen.getByRole('article', { name: /Alpha/ })).getByRole('button', { name: 'Pin' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Split' }));
    const split = screen.getByRole('region', { name: 'Split view' });
    expect(split.dataset.columns).toBe('2');
    expect(within(split).getAllByRole('article').map((a) => a.getAttribute('aria-label')?.split(' — ')[0])).toEqual(['Bravo', 'Alpha']);
  });

  it('shows an empty state', async () => {
    setApiClientForTests(fakeApi({ liveList: async () => [] }));
    await renderInRouter(<LiveBoard />);
    expect(await screen.findByText('No live sessions right now.')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run apps/web/src/features/live-board`
Expected: FAIL, `Cannot find module './sort.ts'`

- [ ] **Step 3: Implement the store and the helpers**

`apps/web/src/stores/live-layout.ts`
```ts
import type { OpenInApp } from '@orc/api-contract';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type LiveLayout = 'grid' | 'list' | 'split';
export type LiveGroupBy = 'none' | 'project' | 'ticket' | 'source';
export const MAX_PINNED = 4;

interface LiveLayoutState {
  layout: LiveLayout;
  pinned: string[];
  groupBy: LiveGroupBy;
  openInByProject: Record<string, OpenInApp>;
  setLayout(l: LiveLayout): void;
  togglePin(pk: string): void;
  setGroupBy(g: LiveGroupBy): void;
  setOpenIn(projectId: string, app: OpenInApp): void;
}

const safeStorage = createJSONStorage(() => {
  try {
    return window.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
});

export const useLiveLayoutStore = create<LiveLayoutState>()(
  persist(
    (set) => ({
      layout: 'grid',
      pinned: [],
      groupBy: 'none',
      openInByProject: {},
      setLayout: (layout) => set({ layout }),
      togglePin: (pk) =>
        set((s) => (s.pinned.includes(pk) ? { pinned: s.pinned.filter((p) => p !== pk) } : { pinned: [...s.pinned, pk].slice(-MAX_PINNED) })),
      setGroupBy: (groupBy) => set({ groupBy }),
      setOpenIn: (projectId, app) => set((s) => ({ openInByProject: { ...s.openInByProject, [projectId]: app } })),
    }),
    { name: 'orc.live-layout', storage: safeStorage },
  ),
);
```

`apps/web/src/features/live-board/sort.ts`
```ts
import type { LiveStatus, Session, TestResult } from '@orc/core';
import type { LiveGroupBy } from '../../stores/live-layout.ts';

export const STATUS_LABEL: Record<LiveStatus, string> = {
  busy: 'Busy',
  idle: 'Idle',
  waiting: 'Waiting',
  shell: 'Shell',
  review: 'Ready for review',
  blocked: 'Blocked',
  error: 'Error',
  ended: 'Ended',
};

const RANK: Record<LiveStatus, number> = { waiting: 0, review: 1, blocked: 2, error: 3, busy: 4, shell: 5, idle: 6, ended: 7 };
const SOURCE_LABEL: Record<Session['source'], string> = { claude: 'Claude', codex: 'Codex', agnc: 'AGNC' };

export const attentionRank = (status: LiveStatus): number => RANK[status];
export const isAttention = (status: LiveStatus): boolean => RANK[status] <= RANK.error;

export function sortLive(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const ra = RANK[a.live?.status ?? 'ended'];
    const rb = RANK[b.live?.status ?? 'ended'];
    if (ra !== rb) return ra - rb;
    return (a.live?.since ?? '').localeCompare(b.live?.since ?? '');
  });
}

export function filterByProject(sessions: Session[], projectId?: string): Session[] {
  return projectId ? sessions.filter((s) => s.projectId === projectId) : sessions;
}

export function groupLive(sessions: Session[], by: LiveGroupBy): Array<{ key: string; label: string; sessions: Session[] }> {
  if (by === 'none') return [{ key: 'all', label: 'All sessions', sessions }];
  const groups = new Map<string, { key: string; label: string; sessions: Session[] }>();
  for (const s of sessions) {
    const [key, label] =
      by === 'project'
        ? [s.projectId ?? '_none', s.projectId ?? 'No project']
        : by === 'ticket'
          ? [s.tickets[0] ?? '_none', s.tickets[0] ?? 'No ticket']
          : [s.source, SOURCE_LABEL[s.source]];
    const g = groups.get(key) ?? { key, label, sessions: [] };
    g.sessions.push(s);
    groups.set(key, g);
  }
  return [...groups.values()];
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function permissionBadge(mode: string | null): 'bypass' | 'plan' | 'auto' | 'default' | 'custom' | null {
  if (!mode) return null;
  if (mode === 'bypassPermissions') return 'bypass';
  if (mode === 'plan') return 'plan';
  if (mode === 'acceptEdits' || mode === 'auto') return 'auto';
  if (mode === 'default') return 'default';
  return 'custom';
}

export function hasDrift(s: Session): boolean {
  const last = s.cwds.at(-1);
  return last !== undefined && last !== s.startCwd;
}

export function shortPath(p: string): string {
  const home = p.replace(/^\/Users\/[^/]+/, '~');
  const parts = home.split('/');
  return parts.length > 5 ? [parts[0], '…', ...parts.slice(-3)].join('/') : home;
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function resumeCommand(s: Session): string {
  const cmd = s.source === 'codex' ? `codex resume ${s.id}` : `claude --resume ${s.id}`;
  return `cd ${shq(s.startCwd)} && ${cmd}`;
}

export function testChipText(t: TestResult): string {
  return `✓ ${t.passed} · ✗ ${t.failed}`;
}
```

`shortPath('/Users/test/a/b/c/d/e/f')` gives `~/a/b/c/d/e/f`, which has 7 parts, so it becomes `~/…/d/e/f`. `~/Wakecap/Backend/svc` has 4 parts and stays as it is.

- [ ] **Step 4: Implement the components**

`apps/web/src/features/live-board/StageBar.tsx`
```tsx
import type { Stage } from '@orc/core';

const STAGES: Array<{ id: Stage; label: string }> = [
  { id: 'understand', label: 'Understand' },
  { id: 'modify', label: 'Modify' },
  { id: 'test', label: 'Test' },
  { id: 'review', label: 'Review' },
];

export function StageBar({ stage }: { stage: Stage | null }) {
  const current = stage ? STAGES.findIndex((s) => s.id === stage) : -1;
  return (
    <ol aria-label="Stage" className="flex gap-0.5 text-[10px]">
      {STAGES.map((s, i) => (
        <li
          key={s.id}
          aria-current={i === current ? 'step' : undefined}
          className={`flex-1 rounded px-1 text-center ${i < current ? 'bg-emerald-600/40' : i === current ? 'bg-emerald-600 text-white' : 'bg-neutral-200 dark:bg-neutral-800'}`}
        >
          {s.label}
        </li>
      ))}
    </ol>
  );
}
```

`apps/web/src/features/live-board/TestChip.tsx`
```tsx
import type { TestResult } from '@orc/core';
import { testChipText } from './sort.ts';

export function TestChip({ result }: { result: TestResult | null }) {
  if (!result) return null;
  const failed = result.failed > 0;
  return (
    <span
      data-failed={failed ? 'true' : 'false'}
      title={result.command}
      className={`rounded px-1.5 py-0.5 font-mono ${failed ? 'bg-red-600 text-white' : 'bg-emerald-600/20 text-emerald-700 dark:text-emerald-300'}`}
    >
      {testChipText(result)}
    </span>
  );
}
```

`apps/web/src/features/live-board/OpenInButton.tsx`
```tsx
import type { OpenInApp } from '@orc/api-contract';
import type { Session } from '@orc/core';
import { Button } from '@/components/ui';
import { useOpenIn } from '../../api/queries/launch.ts';
import { useLiveLayoutStore } from '../../stores/live-layout.ts';

const APP_LABEL: Record<OpenInApp, string> = { vscode: 'VS Code', terminal: 'Terminal', finder: 'Finder' };

export function OpenInButton({ session }: { session: Session }) {
  const projectKey = session.projectId ?? '_none';
  const app = useLiveLayoutStore((s) => s.openInByProject[projectKey] ?? 'vscode');
  const setOpenIn = useLiveLayoutStore((s) => s.setOpenIn);
  const openIn = useOpenIn();
  return (
    <span className="inline-flex items-center">
      <Button size="sm" variant="outline" onClick={() => openIn.mutate({ source: session.source, id: session.id, app })}>
        {`Open in ${APP_LABEL[app]}`}
      </Button>
      <select
        aria-label="Open in app"
        className="ml-0.5 rounded border bg-transparent px-1 text-xs"
        value={app}
        onChange={(e) => setOpenIn(projectKey, e.target.value as OpenInApp)}
      >
        {(Object.keys(APP_LABEL) as OpenInApp[]).map((k) => (
          <option key={k} value={k}>
            {APP_LABEL[k]}
          </option>
        ))}
      </select>
    </span>
  );
}
```

`apps/web/src/features/live-board/SessionCard.tsx`
```tsx
import type { Session } from '@orc/core';
import { Link } from '@tanstack/react-router';
import { Badge, Button } from '@/components/ui';
import { useKill } from '../../api/queries/launch.ts';
import { useTerminalStore } from '../../stores/terminals.ts';
import { OpenInButton } from './OpenInButton.tsx';
import { STATUS_LABEL, formatDuration, hasDrift, isAttention, permissionBadge, resumeCommand, shortPath } from './sort.ts';
import { StageBar } from './StageBar.tsx';
import { TestChip } from './TestChip.tsx';

const SOURCE_LABEL: Record<Session['source'], string> = { claude: 'Claude', codex: 'Codex', agnc: 'AGNC' };

export interface SessionCardProps {
  session: Session;
  now: number;
  compact?: boolean;
  pinned: boolean;
  onTogglePin: () => void;
}

export function SessionCard({ session: s, now, compact = false, pinned, onTogglePin }: SessionCardProps) {
  const kill = useKill();
  const openTerminal = useTerminalStore((t) => t.open);
  const live = s.live;
  if (!live) return null;
  const attention = isAttention(live.status);
  const title = s.name ?? s.id;
  const cwd = s.cwds.at(-1) ?? s.startCwd;
  const perm = permissionBadge(s.permissionMode);

  const onStop = () => {
    if (window.confirm(`Stop "${title}" (pid ${live.pid ?? '?'}) in ${cwd}?`)) kill.mutate({ source: s.source, id: s.id });
  };

  return (
    <article
      aria-label={`${title} — ${STATUS_LABEL[live.status]}`}
      data-status={live.status}
      data-attention={attention ? 'true' : 'false'}
      className={`flex flex-col gap-1.5 rounded-lg border p-3 ${attention ? 'border-amber-500 shadow-sm' : ''}`}
    >
      <header className="flex items-center gap-2">
        <Badge variant="outline">{SOURCE_LABEL[s.source]}</Badge>
        <Link to="/sessions/$source/$id" params={{ source: s.source, id: s.id }} className="min-w-0 flex-1 truncate font-medium">
          {title}
        </Link>
        <Badge variant={attention ? 'destructive' : 'secondary'} className={attention ? 'animate-pulse' : undefined}>
          {STATUS_LABEL[live.status]}
        </Badge>
        <span className="text-xs tabular-nums text-neutral-500" title={live.since}>
          {formatDuration(now - Date.parse(live.since))}
        </span>
      </header>

      {live.status === 'waiting' && live.waitingFor && <p className="text-sm text-amber-700 dark:text-amber-300">{live.waitingFor}</p>}

      <p className="truncate text-xs text-neutral-500" title={cwd}>
        {shortPath(cwd)}
        {hasDrift(s) && (
          <span aria-label="cwd drift" title={`moved from ${s.startCwd}`}>
            {' ↪'}
          </span>
        )}
      </p>

      {!compact && (
        <>
          {live.currentTool && (
            <p className="text-xs">
              <span className="text-neutral-500">tool </span>
              <code>{live.currentTool}</code>
            </p>
          )}
          {s.lastPrompt && <p className="line-clamp-2 text-sm">{s.lastPrompt}</p>}
          {(s.tickets.length > 0 || s.prs.length > 0) && (
            <div className="flex flex-wrap gap-1 text-xs">
              {s.tickets.map((t) => (
                <Badge key={t} variant="outline">
                  {t}
                </Badge>
              ))}
              {s.prs.map((p) => (
                <a key={p.url} href={p.url} target="_blank" rel="noreferrer" className="rounded border px-1.5">
                  {`#${p.number}`}
                </a>
              ))}
            </div>
          )}
          <StageBar stage={live.stage} />
        </>
      )}

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {s.usage.costUsd !== null && <span>{`$${s.usage.costUsd.toFixed(2)}`}</span>}
        {live.contextFill !== null && <span>{`ctx ${Math.round(live.contextFill * 100)}%`}</span>}
        <TestChip result={s.lastTest} />
        {live.backgroundJobs > 0 && <Badge variant="secondary">{`${live.backgroundJobs} jobs`}</Badge>}
        {perm && <Badge variant={perm === 'bypass' ? 'destructive' : 'outline'}>{perm}</Badge>}
        {live.runningSubagents > 0 && <Badge variant="secondary">{`${live.runningSubagents} agents`}</Badge>}
      </div>

      <footer className="flex flex-wrap items-center gap-1 pt-1">
        {live.ownership === 'owned' && live.ptyId && (
          <Button size="sm" variant="default" onClick={() => live.ptyId && openTerminal(live.ptyId, title)}>
            Terminal
          </Button>
        )}
        <Link to="/sessions/$source/$id" params={{ source: s.source, id: s.id }} className="text-xs underline">
          Details
        </Link>
        <Button size="sm" variant="ghost" disabled title="Available in Phase 4">
          Diff
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(resumeCommand(s))}>
          Copy resume
        </Button>
        <OpenInButton session={s} />
        <Button size="sm" variant="ghost" onClick={onTogglePin}>
          {pinned ? 'Unpin' : 'Pin'}
        </Button>
        {live.status !== 'ended' && (
          <Button size="sm" variant="destructive" onClick={onStop}>
            Stop
          </Button>
        )}
      </footer>
    </article>
  );
}
```

`apps/web/src/features/live-board/LiveBoard.tsx`
```tsx
import type { Session } from '@orc/core';
import { useEffect, useMemo, useState } from 'react';
import { pkOf } from '../../api/live-events.ts';
import { scopeProject } from '../../api/queries/inbox.ts';
import { useLive } from '../../api/queries/live.ts';
import { type LiveGroupBy, type LiveLayout, useLiveLayoutStore } from '../../stores/live-layout.ts';
import { useProjectStore } from '../../stores/project.ts';
import { SessionCard } from './SessionCard.tsx';
import { filterByProject, groupLive, sortLive } from './sort.ts';

const LAYOUTS: Array<{ id: LiveLayout; label: string }> = [
  { id: 'grid', label: 'Grid' },
  { id: 'list', label: 'List' },
  { id: 'split', label: 'Split' },
];

function useNow(now?: () => number): number {
  const clock = now ?? Date.now;
  const [t, setT] = useState(clock());
  useEffect(() => {
    const id = setInterval(() => setT(clock()), 1000);
    return () => clearInterval(id);
  }, [clock]);
  return t;
}

export function LiveBoard({ now }: { now?: () => number }) {
  const { data, isLoading } = useLive();
  const projectId = scopeProject(useProjectStore((s) => s.projectId));
  const { layout, pinned, groupBy, setLayout, togglePin, setGroupBy } = useLiveLayoutStore();
  const t = useNow(now);

  const sessions = useMemo(() => sortLive(filterByProject(data ?? [], projectId)), [data, projectId]);
  const card = (s: Session, compact = false) => (
    <SessionCard
      key={pkOf(s)}
      session={s}
      now={t}
      compact={compact}
      pinned={pinned.includes(pkOf(s))}
      onTogglePin={() => togglePin(pkOf(s))}
    />
  );

  const pinnedSessions = pinned.map((pk) => sessions.find((s) => pkOf(s) === pk)).filter((s): s is Session => !!s);

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Live</h1>
        <div role="radiogroup" aria-label="Layout" className="flex gap-1">
          {LAYOUTS.map((l) => (
            <label key={l.id} className="flex items-center gap-1 text-sm">
              <input type="radio" name="live-layout" checked={layout === l.id} onChange={() => setLayout(l.id)} />
              {l.label}
            </label>
          ))}
        </div>
        <label className="flex items-center gap-1 text-sm">
          Group by
          <select
            aria-label="Group by"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as LiveGroupBy)}
            className="rounded border bg-transparent px-1"
          >
            <option value="none">None</option>
            <option value="project">Project</option>
            <option value="ticket">Ticket</option>
            <option value="source">Source</option>
          </select>
        </label>
      </div>

      {isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
      {!isLoading && sessions.length === 0 && <p className="text-sm text-neutral-500">No live sessions right now.</p>}

      {layout === 'split' ? (
        pinnedSessions.length < 2 ? (
          <p className="text-sm text-neutral-500">Pin 2–4 sessions to compare them side by side.</p>
        ) : (
          <section
            aria-label="Split view"
            data-columns={pinnedSessions.length}
            className="grid gap-3"
            style={{ gridTemplateColumns: `repeat(${pinnedSessions.length}, minmax(0, 1fr))` }}
          >
            {pinnedSessions.map((s) => card(s))}
          </section>
        )
      ) : (
        groupLive(sessions, groupBy).map((g) => {
          const body = (
            <div className={layout === 'grid' ? 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3' : 'flex flex-col gap-2'}>
              {g.sessions.map((s) => card(s, layout === 'list'))}
            </div>
          );
          return groupBy === 'none' ? (
            <div key={g.key}>{body}</div>
          ) : (
            <section key={g.key} aria-label={g.label} className="flex flex-col gap-2">
              <h2 className="text-sm font-medium text-neutral-500">{g.label}</h2>
              {body}
            </section>
          );
        })
      )}
    </div>
  );
}
```

`apps/web/src/routes/live.tsx`
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { LiveBoard } from '../features/live-board/LiveBoard.tsx';

export const Route = createFileRoute('/live')({ component: () => <LiveBoard /> });
```

In `AppShell.tsx`, add a nav entry next to the P1 History link: `<Link to="/live">Live</Link>`, using the same classes as the existing nav links.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/web/src/features/live-board`
Expected: PASS (10 tests). Then run `pnpm --filter @orc/web build` so the router plugin regenerates `routeTree.gen.ts` with `/live`.

- [ ] **Step 6: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/web/src/stores/live-layout.ts apps/web/src/features/live-board apps/web/src/routes/live.tsx apps/web/src/routeTree.gen.ts apps/web/src/features/shell/AppShell.tsx
git commit -m "feat(web): add the Live Board with attention-first cards, layouts and card actions"
```

---

### Task 19: web — Inbox (`/inbox`) with keyboard triage, top-bar count, `/` redirect and the Launch dialog

**Files:**
- Create: `apps/web/src/features/inbox/snooze.ts`, `apps/web/src/features/inbox/useInboxKeys.ts`, `apps/web/src/features/inbox/InboxPage.tsx`, `apps/web/src/features/inbox/InboxCount.tsx`
- Create: `apps/web/src/features/inbox/InboxPage.test.tsx`
- Create: `apps/web/src/stores/launch.ts`
- Create: `apps/web/src/features/launch/LaunchDialog.tsx`, `apps/web/src/features/launch/LaunchDialog.test.tsx`
- Create: `apps/web/src/routes/inbox.tsx`
- Modify: `apps/web/src/routes/index.tsx` (redirect to `/inbox`), `apps/web/src/features/shell/AppShell.tsx`

**Interfaces:**
- Consumes:
  - `useInbox`, `useInboxAction`, `scopeProject`, `useLive`, `useLaunch`, `useTemplates`, `pkOf` (Task 17)
  - `useTerminalStore`, `useProjectStore` (contracts §12)
  - P1 `useProjects(): UseQueryResult<Project[]>` from `api/queries/projects.ts`, backed by `projectsList()`
  - `ApiCallError`, `LaunchRequestInput`, `TemplateDto` (Task 2)
  - `Button`, `Badge` (`@/components/ui`)
  - `renderInRouter`, `fakeApi`, `makeInboxItem`, `makeSession` (Task 17)
- Produces:
  ```ts
  // features/inbox/snooze.ts
  export function snoozePresets(now: Date): Array<{ label: string; until: string }>   // 1 hour, Tomorrow 9:00, Next Monday 9:00
  // features/inbox/useInboxKeys.ts
  export function isTypingTarget(t: EventTarget | null): boolean
  export function useInboxKeys(o: { count: number; onDone(i: number): void; onSnooze(i: number): void; onOpen(i: number): void }): { selected: number; setSelected(i: number): void }
  // features/inbox/InboxPage.tsx
  export const KIND_LABEL: Record<InboxKind, string>
  export function InboxPage(props: { now?: () => number }): JSX.Element
  // features/inbox/InboxCount.tsx
  export function InboxCount(props: { count: number }): JSX.Element
  // stores/launch.ts
  export const useLaunchStore: UseBoundStore<StoreApi<{ open: boolean; preset: Partial<LaunchRequestInput> | null; show(preset?: Partial<LaunchRequestInput>): void; hide(): void }>>
  // features/launch/LaunchDialog.tsx
  export function describeLaunchError(err: unknown): string
  export function LaunchDialog(): JSX.Element | null
  ```

**Keyboard triage (docs/02 F8/F15):**
- `j`/`k` move the selection.
- `e` marks the item done.
- `s` snoozes it for 1 hour.
- `Enter` opens the item's session.
- Keys are ignored while typing in an input, textarea or select, when a modifier is held, or while the Launch dialog is open.

The tabs are Open / Snoozed / Done (`done` + `auto_resolved`), and the global project selector scopes the list. Each item shows its kind, reason, age and ticket. Its actions are Open, Terminal (when the session is live and owned), Done, Snooze (preset select) and Reopen (in the Done tab).

- [ ] **Step 1: Write the failing tests**

`apps/web/src/features/inbox/InboxPage.test.tsx`
```tsx
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { useLaunchStore } from '../../stores/launch.ts';
import { useProjectStore } from '../../stores/project.ts';
import { useTerminalStore } from '../../stores/terminals.ts';
import { fakeApi, makeInboxItem, makeSession, renderInRouter } from '../../test/query.tsx';
import { InboxCount } from './InboxCount.tsx';
import { InboxPage } from './InboxPage.tsx';
import { snoozePresets } from './snooze.ts';

const NOW = new Date(2026, 8, 2, 14, 0, 0); // Wed 2 Sep 2026 14:00 local
const open = [
  makeInboxItem({ id: 'a', reason: 'Alpha: waiting — input needed', payload: { source: 'claude', id: 's1' }, ticket: 'SAF-1787' }),
  makeInboxItem({ id: 'b', kind: 'review', reason: 'Bravo: ready for review', dedupeKey: 'review:claude:s2', payload: { source: 'claude', id: 's2' } }),
];
const inboxList = vi.fn(async (f?: { state?: string[] }) => (f?.state?.includes('done') ? [makeInboxItem({ id: 'z', state: 'done', reason: 'Old' })] : open));
const byId = (id: string) => open.find((i) => i.id === id) ?? makeInboxItem({ id });
const inboxDone = vi.fn(async (id: string) => ({ ...byId(id), state: 'done' as const }));
const inboxSnooze = vi.fn(async (id: string, until: string) => ({ ...byId(id), state: 'snoozed' as const, snoozeUntil: until }));
const inboxReopen = vi.fn(async (id: string) => makeInboxItem({ id }));

beforeEach(() => {
  for (const f of [inboxList, inboxDone, inboxSnooze, inboxReopen]) f.mockClear();
  setApiClientForTests(
    fakeApi({
      inboxList,
      inboxDone,
      inboxSnooze,
      inboxReopen,
      liveList: async () => [makeSession({ id: 's1', live: { ownership: 'owned', ptyId: 'pty-7', status: 'waiting' } })],
    }),
  );
  useProjectStore.setState({ projectId: 'all' });
  useLaunchStore.setState({ open: false });
});
afterEach(cleanup);

const rows = () => screen.getAllByRole('listitem');
const selectedReason = () => rows().find((r) => r.getAttribute('aria-current') === 'true')?.querySelector('[data-reason]')?.textContent;

describe('snoozePresets', () => {
  it('offers 1 hour, tomorrow 9:00 and next Monday 9:00', () => {
    expect(snoozePresets(NOW).map((p) => [p.label, p.until])).toEqual([
      ['1 hour', new Date(2026, 8, 2, 15, 0, 0).toISOString()],
      ['Tomorrow 9:00', new Date(2026, 8, 3, 9, 0, 0).toISOString()],
      ['Next Monday 9:00', new Date(2026, 8, 7, 9, 0, 0).toISOString()],
    ]);
  });
});

describe('InboxPage', () => {
  it('lists open items with details and triages with j/k/e/s', async () => {
    await renderInRouter(<InboxPage now={() => NOW.getTime()} />);
    await screen.findByText('Alpha: waiting — input needed');
    expect(within(rows()[0] as HTMLElement).getByText('Waiting')).toBeTruthy();
    expect(within(rows()[0] as HTMLElement).getByText('SAF-1787')).toBeTruthy();
    expect(selectedReason()).toBe('Alpha: waiting — input needed');
    fireEvent.keyDown(window, { key: 'j' });
    expect(selectedReason()).toBe('Bravo: ready for review');
    fireEvent.keyDown(window, { key: 'j' });
    expect(selectedReason()).toBe('Bravo: ready for review');
    fireEvent.keyDown(window, { key: 'k' });
    fireEvent.keyDown(window, { key: 'e' });
    await vi.waitFor(() => expect(inboxDone).toHaveBeenCalledWith('a'));
    await vi.waitFor(() => expect(screen.queryByText('Alpha: waiting — input needed')).toBeNull());
    fireEvent.keyDown(window, { key: 's' });
    await vi.waitFor(() => expect(inboxSnooze).toHaveBeenCalledWith('b', new Date(2026, 8, 2, 15, 0, 0).toISOString()));
  });

  it('ignores keys while typing, with modifiers, or while the launch dialog is open', async () => {
    await renderInRouter(
      <>
        <input aria-label="search" />
        <InboxPage now={() => NOW.getTime()} />
      </>,
    );
    await screen.findByText('Alpha: waiting — input needed');
    fireEvent.keyDown(screen.getByLabelText('search'), { key: 'e' });
    fireEvent.keyDown(window, { key: 'e', metaKey: true });
    useLaunchStore.setState({ open: true });
    fireEvent.keyDown(window, { key: 'e' });
    expect(inboxDone).not.toHaveBeenCalled();
  });

  it('opens the session with Enter and the terminal for owned sessions', async () => {
    const openTerminal = vi.fn();
    useTerminalStore.setState({ open: openTerminal });
    await renderInRouter(<InboxPage now={() => NOW.getTime()} />);
    await screen.findByText('Alpha: waiting — input needed');
    fireEvent.click(await within(rows()[0] as HTMLElement).findByRole('button', { name: 'Terminal' }));
    expect(openTerminal).toHaveBeenCalledWith('pty-7', 'Alpha: waiting — input needed');
    expect(within(rows()[1] as HTMLElement).queryByRole('button', { name: 'Terminal' })).toBeNull();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(await screen.findByTestId('navigated')).toBeTruthy();
  });

  it('shows done items with Reopen', async () => {
    await renderInRouter(<InboxPage now={() => NOW.getTime()} />);
    await screen.findByText('Alpha: waiting — input needed');
    fireEvent.click(screen.getByRole('tab', { name: 'Done' }));
    await screen.findByText('Old');
    expect(inboxList).toHaveBeenLastCalledWith({ state: ['done', 'auto_resolved'], projectId: undefined });
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await vi.waitFor(() => expect(inboxReopen).toHaveBeenCalledWith('z'));
  });
});

describe('InboxCount', () => {
  it('links to the inbox with the open count', async () => {
    await renderInRouter(<InboxCount count={3} />);
    const link = await screen.findByRole('link', { name: 'Inbox, 3 open' });
    expect(link.getAttribute('href')).toBe('/inbox');
    expect(within(link).getByText('3')).toBeTruthy();
  });
});
```

`apps/web/src/features/launch/LaunchDialog.test.tsx`
```tsx
import { ApiCallError } from '@orc/api-contract';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { useLaunchStore } from '../../stores/launch.ts';
import { useProjectStore } from '../../stores/project.ts';
import { useTerminalStore } from '../../stores/terminals.ts';
import { fakeApi, renderInRouter } from '../../test/query.tsx';
import { LaunchDialog, describeLaunchError } from './LaunchDialog.tsx';

const templates = [
  { id: 'wf-implement-ticket', kind: 'workflow' as const, label: 'Implement ticket', prompt: '/conductor {{ticketUrl}}', vars: ['ticketUrl' as const], defaultSource: 'claude' as const, projectIds: 'all' as const },
  { id: 'preset-fix-ci', kind: 'preset' as const, label: 'Fix CI failure', prompt: 'x', vars: ['prUrl' as const, 'check' as const], defaultSource: 'claude' as const, projectIds: 'all' as const },
];
const projects = [
  { id: 'wakecap', name: 'Wakecap', pathPrefixes: ['/Users/test/Wakecap'], hidden: false, lastActivityAt: null, sessionCount: 3 },
  { id: 'forza', name: 'Forza', pathPrefixes: ['/Users/test/Forza'], hidden: false, lastActivityAt: null, sessionCount: 1 },
];
const sessionsLaunch = vi.fn();
const open = vi.fn();

beforeEach(() => {
  sessionsLaunch.mockReset();
  open.mockReset();
  setApiClientForTests(fakeApi({ sessionsLaunch, templatesList: async () => templates, projectsList: async () => projects }));
  useProjectStore.setState({ projectId: 'wakecap' });
  useTerminalStore.setState({ open });
  useLaunchStore.setState({ open: true, preset: null });
});
afterEach(cleanup);

describe('LaunchDialog', () => {
  it('renders nothing when closed', async () => {
    useLaunchStore.setState({ open: false });
    await renderInRouter(<LaunchDialog />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('launches a workflow template with its variables and opens the terminal', async () => {
    sessionsLaunch.mockResolvedValue({ ptyId: 'pty-3', sessionId: 's-9' });
    await renderInRouter(<LaunchDialog />);
    await screen.findByRole('dialog', { name: 'New session' });
    await screen.findByRole('option', { name: 'Implement ticket' });
    await vi.waitFor(() => expect((screen.getByLabelText('Working directory') as HTMLInputElement).placeholder).toBe('/Users/test/Wakecap'));
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'wf-implement-ticket' } });
    fireEvent.change(screen.getByLabelText('Ticket URL'), { target: { value: 'https://linear.app/x/issue/SAF-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    await vi.waitFor(() =>
      expect(sessionsLaunch).toHaveBeenCalledWith({
        source: 'claude',
        projectId: 'wakecap',
        cwd: '/Users/test/Wakecap',
        prompt: '',
        templateId: 'wf-implement-ticket',
        vars: { ticketUrl: 'https://linear.app/x/issue/SAF-1' },
      }),
    );
    expect(open).toHaveBeenCalledWith('pty-3', 'Implement ticket');
    expect(useLaunchStore.getState().open).toBe(false);
  });

  it('launches codex with a plain prompt, model and custom cwd', async () => {
    sessionsLaunch.mockResolvedValue({ ptyId: 'pty-4', sessionId: null });
    await renderInRouter(<LaunchDialog />);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'forza' } });
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/Users/test/Forza/app' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.5' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'second opinion on the plan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    await vi.waitFor(() =>
      expect(sessionsLaunch).toHaveBeenCalledWith({
        source: 'codex', projectId: 'forza', cwd: '/Users/test/Forza/app', prompt: 'second opinion on the plan', vars: {}, model: 'gpt-5.5',
      }),
    );
    expect(open).toHaveBeenCalledWith('pty-4', 'second opinion on the plan');
  });

  it('shows server errors and stays open', async () => {
    sessionsLaunch.mockRejectedValue(new ApiCallError(429, 'concurrency_limit', 'too many', { projectId: 'wakecap', max: 6, running: 6 }));
    await renderInRouter(<LaunchDialog />);
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Concurrency limit reached: 6/6 app-owned sessions in this project.');
    expect(useLaunchStore.getState().open).toBe(true);
    expect((screen.getByLabelText('Require plan approval (Phase 4)') as HTMLInputElement).disabled).toBe(true);
  });

  it('describes errors', () => {
    expect(describeLaunchError(new ApiCallError(400, 'template_var_missing', 'x', { missing: ['prUrl', 'check'] }))).toBe('Missing template fields: prUrl, check');
    expect(describeLaunchError(new ApiCallError(501, 'not_implemented', 'plan approval arrives in phase 4'))).toBe('Not available yet: plan approval arrives in phase 4');
    expect(describeLaunchError(new ApiCallError(400, 'cwd_not_found', 'cwd does not exist'))).toBe('cwd does not exist');
    expect(describeLaunchError(new Error('boom'))).toBe('boom');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run apps/web/src/features/inbox apps/web/src/features/launch`
Expected: FAIL, `Cannot find module './InboxCount.tsx'` / `'./LaunchDialog.tsx'`

- [ ] **Step 3: Implement the inbox pieces**

`apps/web/src/features/inbox/snooze.ts`
```ts
export function snoozePresets(now: Date): Array<{ label: string; until: string }> {
  const hour = new Date(now.getTime() + 3600_000);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const monday = new Date(now);
  monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  monday.setHours(9, 0, 0, 0);
  return [
    { label: '1 hour', until: hour.toISOString() },
    { label: 'Tomorrow 9:00', until: tomorrow.toISOString() },
    { label: 'Next Monday 9:00', until: monday.toISOString() },
  ];
}
```

`apps/web/src/features/inbox/useInboxKeys.ts`
```ts
import { useEffect, useState } from 'react';
import { useLaunchStore } from '../../stores/launch.ts';

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export function useInboxKeys(o: {
  count: number;
  onDone(i: number): void;
  onSnooze(i: number): void;
  onOpen(i: number): void;
}): { selected: number; setSelected(i: number): void } {
  const [selected, setSelected] = useState(0);
  const { count, onDone, onSnooze, onOpen } = o;

  useEffect(() => {
    if (selected > Math.max(0, count - 1)) setSelected(Math.max(0, count - 1));
  }, [count, selected]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || count === 0) return;
      if (isTypingTarget(e.target) || useLaunchStore.getState().open) return;
      switch (e.key) {
        case 'j':
          setSelected((s) => Math.min(count - 1, s + 1));
          break;
        case 'k':
          setSelected((s) => Math.max(0, s - 1));
          break;
        case 'e':
          onDone(selected);
          break;
        case 's':
          onSnooze(selected);
          break;
        case 'Enter':
          onOpen(selected);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [count, selected, onDone, onSnooze, onOpen]);

  return { selected, setSelected };
}
```

`apps/web/src/features/inbox/InboxCount.tsx`
```tsx
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui';

export function InboxCount({ count }: { count: number }) {
  return (
    <Link to="/inbox" aria-label={`Inbox, ${count} open`} className="inline-flex items-center gap-1 text-sm">
      <span aria-hidden="true">Inbox</span>
      {count > 0 && <Badge variant="destructive">{count}</Badge>}
    </Link>
  );
}
```

`apps/web/src/features/inbox/InboxPage.tsx`
```tsx
import type { InboxItem, InboxKind, InboxState, Source } from '@orc/core';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { Badge, Button } from '@/components/ui';
import { pkOf } from '../../api/live-events.ts';
import { scopeProject, useInbox, useInboxAction } from '../../api/queries/inbox.ts';
import { useLive } from '../../api/queries/live.ts';
import { useProjectStore } from '../../stores/project.ts';
import { useTerminalStore } from '../../stores/terminals.ts';
import { formatDuration } from '../live-board/sort.ts';
import { snoozePresets } from './snooze.ts';
import { useInboxKeys } from './useInboxKeys.ts';

export const KIND_LABEL: Record<InboxKind, string> = {
  waiting: 'Waiting',
  review: 'Ready for review',
  plan_approval: 'Plan approval',
  blocked: 'Blocked',
  error: 'Error',
  tests_red: 'Tests red',
  budget: 'Budget',
  automation_result: 'Automation',
  supervisor_escalation: 'Supervisor',
  pr_event: 'Pull request',
  reminder: 'Reminder',
};

type Tab = 'open' | 'snoozed' | 'done';
const TABS: Array<{ id: Tab; label: string; states: InboxState[] }> = [
  { id: 'open', label: 'Open', states: ['open'] },
  { id: 'snoozed', label: 'Snoozed', states: ['snoozed'] },
  { id: 'done', label: 'Done', states: ['done', 'auto_resolved'] },
];

const sessionRef = (item: InboxItem): { source: Source; id: string } | null => {
  const { source, id } = item.payload;
  return typeof source === 'string' && typeof id === 'string' ? { source: source as Source, id } : null;
};

export function InboxPage({ now }: { now?: () => number }) {
  const clock = now ?? Date.now;
  const [tab, setTab] = useState<Tab>('open');
  const states = TABS.find((t) => t.id === tab)?.states ?? ['open'];
  const projectId = scopeProject(useProjectStore((s) => s.projectId));
  const { data: items = [], isLoading } = useInbox({ state: states, projectId });
  const liveSessions = useLive().data ?? [];
  const action = useInboxAction();
  const navigate = useNavigate();
  const openTerminal = useTerminalStore((t) => t.open);

  const ownedPty = (item: InboxItem): string | null => {
    const ref = sessionRef(item);
    if (!ref) return null;
    const s = liveSessions.find((x) => pkOf(x) === `${ref.source}:${ref.id}`);
    return s?.live?.ownership === 'owned' && s.live.status !== 'ended' ? s.live.ptyId : null;
  };

  const onOpen = useCallback(
    (i: number) => {
      const it = items[i];
      const ref = it ? sessionRef(it) : null;
      if (ref) void navigate({ to: '/sessions/$source/$id', params: ref });
    },
    [items, navigate],
  );
  const onDone = useCallback(
    (i: number) => {
      const it = items[i];
      if (it && (it.state === 'open' || it.state === 'snoozed')) action.mutate({ id: it.id, action: 'done' });
    },
    [items, action],
  );
  const snooze = useCallback(
    (i: number, until: string) => {
      const it = items[i];
      if (it && (it.state === 'open' || it.state === 'snoozed')) action.mutate({ id: it.id, action: 'snooze', until });
    },
    [items, action],
  );
  const onSnooze = useCallback((i: number) => {
    const first = snoozePresets(new Date(clock()))[0];
    if (first) snooze(i, first.until);
  }, [clock, snooze]);

  const { selected, setSelected } = useInboxKeys({ count: items.length, onDone, onSnooze, onOpen });

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold">Inbox</h1>
        <div role="tablist" aria-label="Inbox state" className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => {
                setTab(t.id);
                setSelected(0);
              }}
              className={`rounded px-2 py-0.5 text-sm ${tab === t.id ? 'bg-neutral-200 dark:bg-neutral-800' : ''}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="ml-auto text-xs text-neutral-500">j/k move · e done · s snooze 1h · Enter open</p>
      </div>

      {isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
      {!isLoading && items.length === 0 && <p className="text-sm text-neutral-500">Nothing needs you right now.</p>}

      <ul aria-label="Inbox items" className="flex flex-col gap-1">
        {items.map((it, i) => {
          const pty = ownedPty(it);
          const active = it.state === 'open' || it.state === 'snoozed';
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled globally by useInboxKeys
            <li
              key={it.id}
              aria-current={i === selected ? 'true' : undefined}
              onClick={() => setSelected(i)}
              className={`flex flex-wrap items-center gap-2 rounded border px-3 py-2 ${i === selected ? 'ring-2 ring-sky-500' : ''}`}
            >
              <Badge variant={it.kind === 'error' || it.kind === 'tests_red' ? 'destructive' : 'secondary'}>{KIND_LABEL[it.kind]}</Badge>
              <span data-reason className="min-w-0 flex-1 truncate">
                {it.reason}
              </span>
              {it.ticket && <Badge variant="outline">{it.ticket}</Badge>}
              <span className="text-xs tabular-nums text-neutral-500" title={it.createdAt}>
                {formatDuration(clock() - Date.parse(it.createdAt))}
              </span>
              {it.snoozeUntil && <span className="text-xs text-neutral-500">{`until ${new Date(it.snoozeUntil).toLocaleString()}`}</span>}
              {sessionRef(it) && (
                <Button size="sm" variant="outline" onClick={() => onOpen(i)}>
                  Open
                </Button>
              )}
              {pty && (
                <Button size="sm" variant="default" onClick={() => openTerminal(pty, it.reason)}>
                  Terminal
                </Button>
              )}
              {active ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => onDone(i)}>
                    Done
                  </Button>
                  <select
                    aria-label="Snooze"
                    className="rounded border bg-transparent px-1 text-xs"
                    value=""
                    onChange={(e) => e.target.value && snooze(i, e.target.value)}
                  >
                    <option value="">Snooze…</option>
                    {snoozePresets(new Date(clock())).map((p) => (
                      <option key={p.label} value={p.until}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => action.mutate({ id: it.id, action: 'reopen' })}>
                  Reopen
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

`apps/web/src/routes/inbox.tsx`
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { InboxPage } from '../features/inbox/InboxPage.tsx';

export const Route = createFileRoute('/inbox')({ component: () => <InboxPage /> });
```

Replace the body of `apps/web/src/routes/index.tsx` (P1 redirected to `/history`):
```tsx
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/inbox' });
  },
});
```

- [ ] **Step 4: Implement the launch store and dialog**

`apps/web/src/stores/launch.ts`
```ts
import type { LaunchRequestInput } from '@orc/api-contract';
import { create } from 'zustand';

interface LaunchState {
  open: boolean;
  preset: Partial<LaunchRequestInput> | null;
  show(preset?: Partial<LaunchRequestInput>): void;
  hide(): void;
}

export const useLaunchStore = create<LaunchState>()((set) => ({
  open: false,
  preset: null,
  show: (preset) => set({ open: true, preset: preset ?? null }),
  hide: () => set({ open: false, preset: null }),
}));
```

`apps/web/src/features/launch/LaunchDialog.tsx`
```tsx
import { ApiCallError, type LaunchRequestInput, type TemplateDto } from '@orc/api-contract';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui';
import { scopeProject } from '../../api/queries/inbox.ts';
import { useLaunch } from '../../api/queries/launch.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { useTemplates } from '../../api/queries/templates.ts';
import { useLaunchStore } from '../../stores/launch.ts';
import { useProjectStore } from '../../stores/project.ts';
import { useTerminalStore } from '../../stores/terminals.ts';

const VAR_LABEL: Record<TemplateDto['vars'][number], string> = {
  ticket: 'Ticket',
  ticketUrl: 'Ticket URL',
  prUrl: 'PR URL',
  file: 'File',
  check: 'Failing check',
};

export function describeLaunchError(err: unknown): string {
  if (err instanceof ApiCallError) {
    const d = (err.details ?? {}) as { missing?: string[]; max?: number; running?: number };
    switch (err.code) {
      case 'concurrency_limit':
        return `Concurrency limit reached: ${d.running ?? '?'}/${d.max ?? '?'} app-owned sessions in this project.`;
      case 'template_var_missing':
        return `Missing template fields: ${(d.missing ?? []).join(', ')}`;
      case 'not_implemented':
        return `Not available yet: ${err.message}`;
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export function LaunchDialog() {
  const open = useLaunchStore((s) => s.open);
  const preset = useLaunchStore((s) => s.preset);
  const hide = useLaunchStore((s) => s.hide);
  if (!open) return null;
  return <LaunchForm preset={preset} onClose={hide} />;
}

function LaunchForm({ preset, onClose }: { preset: Partial<LaunchRequestInput> | null; onClose: () => void }) {
  const ids = useId();
  const globalProject = scopeProject(useProjectStore((s) => s.projectId));
  const projects = useProjects().data ?? [];
  const [source, setSource] = useState<'claude' | 'codex'>(preset?.source ?? 'claude');
  const [projectId, setProjectId] = useState<string>(preset?.projectId ?? globalProject ?? '');
  const [cwd, setCwd] = useState(preset?.cwd ?? '');
  const [templateId, setTemplateId] = useState(preset?.templateId ?? '');
  const [vars, setVars] = useState<Record<string, string>>(preset?.vars ?? {});
  const [ticket, setTicket] = useState(preset?.ticket ?? '');
  const [model, setModel] = useState(preset?.model ?? '');
  const [prompt, setPrompt] = useState(preset?.prompt ?? '');
  const templates = useTemplates(projectId || undefined).data ?? [];
  const launch = useLaunch();
  const openTerminal = useTerminalStore((t) => t.open);

  const project = projects.find((p) => p.id === projectId);
  const defaultCwd = project?.pathPrefixes[0] ?? '';
  const template = templates.find((t) => t.id === templateId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const req: LaunchRequestInput = {
      source,
      projectId: projectId || null,
      cwd: cwd || defaultCwd,
      prompt,
      ...(templateId ? { templateId } : {}),
      vars,
      ...(ticket ? { ticket } : {}),
      ...(model ? { model } : {}),
    };
    try {
      const res = await launch.mutateAsync(req);
      openTerminal(res.ptyId, template?.label ?? (prompt.slice(0, 40) || 'New session'));
      onClose();
    } catch {
      // the error is rendered from launch.error
    }
  };

  const field = 'flex flex-col gap-1 text-sm';
  const input = 'rounded border bg-transparent px-2 py-1';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-8">
      <div role="dialog" aria-modal="true" aria-labelledby={`${ids}-title`} className="w-full max-w-xl rounded-lg bg-white p-4 shadow-xl dark:bg-neutral-900">
        <h2 id={`${ids}-title`} className="mb-3 text-lg font-semibold">
          New session
        </h2>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div role="radiogroup" aria-label="Source" className="flex gap-3 text-sm">
            {(['claude', 'codex'] as const).map((s) => (
              <label key={s} className="flex items-center gap-1">
                <input type="radio" name="source" checked={source === s} onChange={() => setSource(s)} />
                {s === 'claude' ? 'Claude' : 'Codex'}
              </label>
            ))}
          </div>

          <label className={field}>
            Project
            <select className={input} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">(none)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className={field}>
            Working directory
            <input className={input} value={cwd} placeholder={defaultCwd} onChange={(e) => setCwd(e.target.value)} />
          </label>

          <label className={field}>
            Template
            <select className={input} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">(none)</option>
              <optgroup label="Workflows">
                {templates.filter((t) => t.kind === 'workflow').map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Presets">
                {templates.filter((t) => t.kind === 'preset').map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>

          {template?.vars.map((v) => (
            <label key={v} className={field}>
              {VAR_LABEL[v]}
              <input className={input} value={vars[v] ?? ''} onChange={(e) => setVars({ ...vars, [v]: e.target.value })} />
            </label>
          ))}

          <div className="grid grid-cols-2 gap-3">
            <label className={field}>
              Ticket
              <input className={input} value={ticket} placeholder="SAF-1787" onChange={(e) => setTicket(e.target.value)} />
            </label>
            <label className={field}>
              Model
              <input className={input} value={model} placeholder="default" onChange={(e) => setModel(e.target.value)} />
            </label>
          </div>

          <label className={field}>
            Prompt
            <textarea className={`${input} min-h-24`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>

          <label className="flex items-center gap-2 text-sm text-neutral-500">
            <input type="checkbox" disabled />
            Require plan approval (Phase 4)
          </label>

          {launch.error && (
            <p role="alert" className="text-sm text-red-600">
              {describeLaunchError(launch.error)}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={launch.isPending}>
              Launch
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

Label matching: Testing Library leaves out the text of nested `select`/`input`/`textarea` elements when it computes a wrapping label's text. `getByLabelText('Template')` and `getByLabelText('Ticket URL')` therefore match exactly, and the separate "Ticket" field doesn't clash with "Ticket URL".

- [ ] **Step 5: Update the app shell**

In `apps/web/src/features/shell/AppShell.tsx`, reuse `openInboxCount` from Task 17:
```tsx
import { Button } from '@/components/ui';
import { InboxCount } from '@/features/inbox/InboxCount';
import { LaunchDialog } from '@/features/launch/LaunchDialog';
import { useLaunchStore } from '@/stores/launch';

// inside AppShell():
const showLaunch = useLaunchStore((s) => s.show);

// in the top bar (<header>), after the search box:
<InboxCount count={openInboxCount} />
<Button size="sm" onClick={() => showLaunch()}>New session</Button>

// in the left nav, next to History and Live:
<Link to="/inbox">Inbox</Link>

// once, at the end of the shell's root element:
<LaunchDialog />
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/web/src/features/inbox apps/web/src/features/launch`
Expected: PASS (11 tests). Then run `pnpm --filter @orc/web build` to regenerate the route tree with `/inbox`.

- [ ] **Step 7: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/web/src/features/inbox apps/web/src/features/launch apps/web/src/stores/launch.ts apps/web/src/routes apps/web/src/routeTree.gen.ts apps/web/src/features/shell/AppShell.tsx
git commit -m "feat(web): add the attention inbox with keyboard triage, inbox count and launch dialog"
```

---

### Task 20: web — Settings (archive, retention, notifications, hook), restore button, Playwright e2e and the phase exit

**Files:**
- Create: `apps/web/src/features/settings/format.ts`, `ArchiveSettings.tsx`, `NotificationSettings.tsx`, `HookSetup.tsx`, `settings.test.tsx` (all under `apps/web/src/features/settings/`)
- Create: `apps/web/src/features/archive/RestoreButton.tsx`, `apps/web/src/features/archive/RestoreButton.test.tsx`
- Modify: `apps/web/src/features/settings/SettingsPage.tsx`; the P1 session detail header (the component that renders the availability badge, e.g. `features/session-detail/SessionHeader.tsx`)
- Create: `apps/daemon/test/e2e-daemon.ts`, `apps/web/e2e/live-inbox.spec.ts`
- Modify: `apps/web/playwright.config.ts`
- Create: `plan/phase-2-evidence.md`
- Modify: `plan/00-contracts.md`, `plan/README.md`

**Interfaces:**
- Consumes: `useArchiveStatus`, `useArchiveRestore`, `useNotificationPrefs`, `useSaveNotificationPrefs`, `archiveStatusKey` (Task 17); `ArchiveStatus`, `NotificationPrefs`, `RECOMMENDED_CLEANUP_SNIPPET` (Task 2); `createDaemon` (Task 16); the fake CLIs (Task 13)
- Produces:
  ```ts
  // features/settings/format.ts
  export function formatBytes(n: number): string
  export function daysAgo(iso: string, now: number): number
  export function retentionWarning(s: Pick<ArchiveStatus, 'cleanupPeriodDays' | 'enabled'>): string | null
  export const NOTIFY_KINDS: ReadonlyArray<{ kind: InboxKind; label: string }>
  export const HOOK_SNIPPET: string
  // components
  export function ArchiveSettings(props: { now?: () => number }): JSX.Element
  export function NotificationSettings(): JSX.Element
  export function HookSetup(): JSX.Element
  export function RestoreButton(props: { source: Source; id: string }): JSX.Element
  ```

**Retention warning:**
- If the archive is disabled: "Archive is off — transcripts older than Claude's cleanup period will be lost."
- If `cleanupPeriodDays` is `null`: "Claude deletes transcripts after 30 days (default). Keep the archive on, or raise cleanupPeriodDays."
- If it's below 90: "Claude deletes transcripts after N days. Keep the archive on, or raise cleanupPeriodDays."
- Otherwise there is no warning.

The recommended snippet is shown with a Copy button. The app **never** edits `~/.claude/settings.json`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/features/settings/settings.test.tsx`
```tsx
import type { ArchiveStatus, NotificationPrefs } from '@orc/api-contract';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderWithClient } from '../../test/query.tsx';
import { ArchiveSettings } from './ArchiveSettings.tsx';
import { daysAgo, formatBytes, retentionWarning } from './format.ts';
import { HookSetup } from './HookSetup.tsx';
import { NotificationSettings } from './NotificationSettings.tsx';

const status: ArchiveStatus = {
  enabled: true, files: 812, bytes: 73_400_000, oldestTranscript: '2026-08-16T00:00:00.000Z', cleanupPeriodDays: null,
  codec: 'zstd', recommendedSnippet: '{\n  "cleanupPeriodDays": 3650\n}',
};
const prefs: NotificationPrefs = {
  waiting: { enabled: true, channels: ['macos'] },
  review: { enabled: true, channels: ['macos'] },
  error: { enabled: true, channels: ['macos'] },
  tests_red: { enabled: true, channels: ['macos'] },
};
const archiveStatus = vi.fn(async () => status);
const archiveSync = vi.fn(async () => ({ copied: 3 }));
const notificationsGet = vi.fn(async () => prefs);
const notificationsPut = vi.fn(async (p: NotificationPrefs) => p);
const writeText = vi.fn(async () => {});

beforeEach(() => {
  for (const f of [archiveStatus, archiveSync, notificationsGet, notificationsPut, writeText]) f.mockClear();
  setApiClientForTests(fakeApi({ archiveStatus, archiveSync, notificationsGet, notificationsPut }));
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(cleanup);

describe('format helpers', () => {
  it('formats sizes, ages and warnings', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(73_400_000)).toBe('70.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(daysAgo('2026-08-16T00:00:00.000Z', Date.parse('2026-09-17T12:00:00.000Z'))).toBe(32);
    expect(retentionWarning({ enabled: false, cleanupPeriodDays: 3650 })).toMatch(/Archive is off/);
    expect(retentionWarning({ enabled: true, cleanupPeriodDays: null })).toMatch(/after 30 days \(default\)/);
    expect(retentionWarning({ enabled: true, cleanupPeriodDays: 45 })).toMatch(/after 45 days/);
    expect(retentionWarning({ enabled: true, cleanupPeriodDays: 365 })).toBeNull();
  });
});

describe('ArchiveSettings', () => {
  it('shows status, warning and snippet, and syncs on demand', async () => {
    renderWithClient(<ArchiveSettings now={() => Date.parse('2026-09-17T12:00:00.000Z')} />);
    expect(await screen.findByText('812 files · 70.0 MB · zstd')).toBeTruthy();
    expect(screen.getByText('Oldest transcript on disk: 2026-08-16 (32 days ago)')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/30 days \(default\)/);
    expect(screen.getByText(/"cleanupPeriodDays": 3650/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy snippet' }));
    expect(writeText).toHaveBeenCalledWith(status.recommendedSnippet);
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await vi.waitFor(() => expect(archiveSync).toHaveBeenCalled());
    expect(await screen.findByText('Copied 3 new or grown transcripts.')).toBeTruthy();
  });
});

describe('NotificationSettings', () => {
  it('toggles kinds and channels and saves', async () => {
    renderWithClient(<NotificationSettings />);
    const waiting = await screen.findByRole('checkbox', { name: 'Waiting for input: enabled' });
    fireEvent.click(waiting);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ready for review: macOS' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Plan awaiting approval: enabled' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save notifications' }));
    await vi.waitFor(() => expect(notificationsPut).toHaveBeenCalled());
    const saved = notificationsPut.mock.calls[0]?.[0];
    expect(saved?.waiting).toEqual({ enabled: false, channels: ['macos'] });
    expect(saved?.review).toEqual({ enabled: true, channels: [] });
    expect(saved?.plan_approval).toEqual({ enabled: true, channels: ['macos'] });
  });
});

describe('HookSetup', () => {
  it('shows the optional hook snippet with a copy button', () => {
    renderWithClient(<HookSetup />);
    expect(screen.getByText(/api\/hooks/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy hook snippet' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"Notification"'));
  });
});
```

`apps/web/src/features/archive/RestoreButton.test.tsx`
```tsx
import { ApiCallError } from '@orc/api-contract';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderWithClient } from '../../test/query.tsx';
import { RestoreButton } from './RestoreButton.tsx';

afterEach(cleanup);

describe('RestoreButton', () => {
  it('asks for confirmation, restores and reports the result', async () => {
    const archiveRestore = vi.fn(async () => ({ restored: ['/a.jsonl', '/b.jsonl'] }));
    setApiClientForTests(fakeApi({ archiveRestore }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderWithClient(<RestoreButton source="claude" id="s-old" />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore transcript' }));
    expect(archiveRestore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restore transcript' }));
    await vi.waitFor(() => expect(archiveRestore).toHaveBeenCalledWith('claude', 's-old', true));
    expect(await screen.findByText('Restored 2 file(s). The session can be resumed now.')).toBeTruthy();
    expect(confirm.mock.calls[0]?.[0]).toBe(
      'Restore the archived transcript for s-old into ~/.claude/projects? Existing files are never overwritten.',
    );
  });

  it('shows a conflict error', async () => {
    setApiClientForTests(
      fakeApi({ archiveRestore: async () => { throw new ApiCallError(409, 'restore_target_exists', 'refusing to overwrite existing transcripts'); } }),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithClient(<RestoreButton source="claude" id="s-old" />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore transcript' }));
    expect((await screen.findByRole('alert')).textContent).toBe('refusing to overwrite existing transcripts');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run apps/web/src/features/settings apps/web/src/features/archive`
Expected: FAIL, `Cannot find module './ArchiveSettings.tsx'`

- [ ] **Step 3: Implement the settings pieces**

`apps/web/src/features/settings/format.ts`
```ts
import type { ArchiveStatus } from '@orc/api-contract';
import type { InboxKind } from '@orc/core';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function daysAgo(iso: string, now: number): number {
  return Math.floor((now - Date.parse(iso)) / 86_400_000);
}

export function retentionWarning(s: Pick<ArchiveStatus, 'cleanupPeriodDays' | 'enabled'>): string | null {
  if (!s.enabled) return "Archive is off — transcripts older than Claude's cleanup period will be lost.";
  if (s.cleanupPeriodDays === null) {
    return 'Claude deletes transcripts after 30 days (default). Keep the archive on, or raise cleanupPeriodDays.';
  }
  if (s.cleanupPeriodDays < 90) {
    return `Claude deletes transcripts after ${s.cleanupPeriodDays} days. Keep the archive on, or raise cleanupPeriodDays.`;
  }
  return null;
}

export const NOTIFY_KINDS: ReadonlyArray<{ kind: InboxKind; label: string }> = [
  { kind: 'waiting', label: 'Waiting for input' },
  { kind: 'review', label: 'Ready for review' },
  { kind: 'plan_approval', label: 'Plan awaiting approval' },
  { kind: 'blocked', label: 'Blocked' },
  { kind: 'error', label: 'Error / API failure' },
  { kind: 'tests_red', label: 'Tests went red' },
  { kind: 'budget', label: 'Over budget / near quota' },
  { kind: 'automation_result', label: 'Automation result' },
  { kind: 'supervisor_escalation', label: 'Supervisor escalation' },
  { kind: 'pr_event', label: 'PR check failed / review requested' },
  { kind: 'reminder', label: 'Reminder' },
];

const hookCmd =
  'curl -s -m 2 -X POST -H \\"x-orc-token: $(cat ~/.orchestrator/token)\\" -H \'content-type: application/json\' --data-binary @- http://127.0.0.1:4317/api/hooks >/dev/null || true';
const hookEntry = `[{ "hooks": [{ "type": "command", "command": "${hookCmd}" }] }]`;
export const HOOK_SNIPPET = `{
  "hooks": {
    "Notification": ${hookEntry},
    "Stop": ${hookEntry},
    "UserPromptSubmit": ${hookEntry}
  }
}`;
```

`apps/web/src/features/settings/ArchiveSettings.tsx`
```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui';
import { getApiClient } from '../../api/client.ts';
import { archiveStatusKey, useArchiveStatus } from '../../api/queries/archive.ts';
import { daysAgo, formatBytes, retentionWarning } from './format.ts';

export function ArchiveSettings({ now }: { now?: () => number }) {
  const clock = now ?? Date.now;
  const qc = useQueryClient();
  const { data: s } = useArchiveStatus();
  const sync = useMutation({
    mutationFn: () => getApiClient().archiveSync(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: archiveStatusKey }),
  });
  if (!s) return <section aria-label="Transcript archive">Loading archive status…</section>;
  const warning = retentionWarning(s);
  return (
    <section aria-label="Transcript archive" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">Transcript archive</h2>
      <p>{`${s.files} files · ${formatBytes(s.bytes)} · ${s.codec}`}</p>
      {s.oldestTranscript && (
        <p className="text-sm">{`Oldest transcript on disk: ${s.oldestTranscript.slice(0, 10)} (${daysAgo(s.oldestTranscript, clock())} days ago)`}</p>
      )}
      <p className="text-sm">
        {`Claude cleanupPeriodDays: ${s.cleanupPeriodDays === null ? 'not set (30 days)' : s.cleanupPeriodDays}`}
      </p>
      {warning && (
        <p role="status" className="rounded bg-amber-100 p-2 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
          {warning}
        </p>
      )}
      <p className="text-sm">
        Recommended addition to <code>~/.claude/settings.json</code> (the app never edits it):
      </p>
      <pre className="rounded bg-neutral-100 p-2 text-xs dark:bg-neutral-800">{s.recommendedSnippet}</pre>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(s.recommendedSnippet)}>
          Copy snippet
        </Button>
        <Button size="sm" onClick={() => sync.mutate()} disabled={sync.isPending}>
          Sync now
        </Button>
      </div>
      {sync.data && <p className="text-sm">{`Copied ${sync.data.copied} new or grown transcripts.`}</p>}
    </section>
  );
}
```

`apps/web/src/features/settings/NotificationSettings.tsx`
```tsx
import type { NotificationPrefs } from '@orc/api-contract';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { useNotificationPrefs, useSaveNotificationPrefs } from '../../api/queries/archive.ts';
import { NOTIFY_KINDS } from './format.ts';

export function NotificationSettings() {
  const { data } = useNotificationPrefs();
  const save = useSaveNotificationPrefs();
  const [draft, setDraft] = useState<NotificationPrefs>({});
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const pref = (kind: string) => draft[kind] ?? { enabled: false, channels: [] };
  const setEnabled = (kind: string, enabled: boolean) => {
    const p = pref(kind);
    setDraft({ ...draft, [kind]: { enabled, channels: enabled && p.channels.length === 0 ? ['macos'] : p.channels } });
  };
  const setMacos = (kind: string, on: boolean) => {
    const p = pref(kind);
    const channels = on ? [...new Set([...p.channels, 'macos' as const])] : p.channels.filter((c) => c !== 'macos');
    setDraft({ ...draft, [kind]: { ...p, channels } });
  };

  return (
    <section aria-label="Notifications" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">Notifications</h2>
      <p className="text-xs text-neutral-500">One notification per session per state change. Web push and Slack DM arrive in Phase 6.</p>
      <table className="text-sm">
        <thead>
          <tr>
            <th className="text-left">Item type</th>
            <th>On</th>
            <th>macOS</th>
          </tr>
        </thead>
        <tbody>
          {NOTIFY_KINDS.map(({ kind, label }) => {
            const p = pref(kind);
            return (
              <tr key={kind}>
                <td>{label}</td>
                <td className="text-center">
                  <input type="checkbox" aria-label={`${label}: enabled`} checked={p.enabled} onChange={(e) => setEnabled(kind, e.target.checked)} />
                </td>
                <td className="text-center">
                  <input
                    type="checkbox"
                    aria-label={`${label}: macOS`}
                    checked={p.channels.includes('macos')}
                    disabled={!p.enabled}
                    onChange={(e) => setMacos(kind, e.target.checked)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div>
        <Button size="sm" onClick={() => save.mutate(draft)} disabled={save.isPending}>
          Save notifications
        </Button>
        {save.isSuccess && <span className="ml-2 text-sm">Saved.</span>}
      </div>
    </section>
  );
}
```

`apps/web/src/features/settings/HookSetup.tsx`
```tsx
import { Button } from '@/components/ui';
import { HOOK_SNIPPET } from './format.ts';

export function HookSetup() {
  return (
    <section aria-label="Real-time hook" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">Real-time hook (optional)</h2>
      <p className="text-sm">
        The Live Board polls Claude's session registry every second. For faster "waiting" alerts, add these hooks to{' '}
        <code>~/.claude/settings.json</code> yourself. The app never edits that file.
      </p>
      <pre className="overflow-x-auto rounded bg-neutral-100 p-2 text-xs dark:bg-neutral-800">{HOOK_SNIPPET}</pre>
      <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(HOOK_SNIPPET)}>
        Copy hook snippet
      </Button>
    </section>
  );
}
```

`apps/web/src/features/archive/RestoreButton.tsx`
```tsx
import type { Source } from '@orc/core';
import { Button } from '@/components/ui';
import { useArchiveRestore } from '../../api/queries/archive.ts';
import { describeLaunchError } from '../launch/LaunchDialog.tsx';

export function RestoreButton({ source, id }: { source: Source; id: string }) {
  const restore = useArchiveRestore();
  const onClick = () => {
    const ok = window.confirm(`Restore the archived transcript for ${id} into ~/.claude/projects? Existing files are never overwritten.`);
    if (ok) restore.mutate({ source, id });
  };
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={onClick} disabled={restore.isPending}>
        Restore transcript
      </Button>
      {restore.data && <span className="text-sm">{`Restored ${restore.data.restored.length} file(s). The session can be resumed now.`}</span>}
      {restore.error && (
        <span role="alert" className="text-sm text-red-600">
          {describeLaunchError(restore.error)}
        </span>
      )}
    </span>
  );
}
```

`describeLaunchError` falls back to `err.message` for codes it doesn't know, which is the message the conflict test expects.

In `SettingsPage.tsx`, render `<ArchiveSettings />`, `<NotificationSettings />` and `<HookSetup />` as new sections after the P1 sections.

In the P1 session detail header, next to the availability badge, add:
```tsx
{session.availability === 'archived' && <RestoreButton source={session.source} id={session.id} />}
```

- [ ] **Step 4: Run the unit tests and confirm they pass**

Run: `pnpm vitest run apps/web/src/features/settings apps/web/src/features/archive`
Expected: PASS (6 tests)

Run: `pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/web/src/features
git commit -m "feat(web): add archive, retention, notification and hook settings plus restore button"
```

- [ ] **Step 5: Write the e2e daemon launcher and the Playwright spec**

`apps/daemon/test/e2e-daemon.ts`
```ts
// Starts a daemon on fixtures for Playwright. Everything lives under $TMPDIR/orc-e2e and is reset on start.
import { cpSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// realpath: on macOS tmpdir() is /var/… but a child's `pwd -P` reports /private/var/…; project prefixes must match the physical path
const ROOT = join(realpathSync(tmpdir()), 'orc-e2e');
const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const BIN = fileURLToPath(new URL('./bin', import.meta.url));
const PORT = 4318;

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'orc'), { recursive: true });
mkdirSync(join(ROOT, 'work', 'Wakecap'), { recursive: true });
cpSync(join(FIXTURES, 'claude-home'), join(ROOT, 'claude'), { recursive: true });
cpSync(join(FIXTURES, 'codex-home'), join(ROOT, 'codex'), { recursive: true });
writeFileSync(
  join(ROOT, 'orc', 'config.json'),
  JSON.stringify({
    port: PORT,
    defaultProjectId: 'wakecap',
    projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [join(ROOT, 'work', 'Wakecap')] }],
  }),
);

process.env.ORC_HOME = join(ROOT, 'orc');
process.env.CLAUDE_HOME = join(ROOT, 'claude');
process.env.CODEX_HOME = join(ROOT, 'codex');
process.env.ORC_NOTIFY = 'off';
process.env.PATH = `${BIN}:${process.env.PATH ?? ''}`;

const { createDaemon } = await import('../src/main.ts');
const daemon = await createDaemon({ port: PORT });
console.log(`e2e daemon on http://127.0.0.1:${daemon.port}`);
const shutdown = () => void daemon.close().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

In `apps/web/playwright.config.ts`, point `webServer` and `use.baseURL` at this daemon. This replaces the P1 web server command; P1 specs keep working because the daemon still serves the fixture history.
```ts
webServer: {
  command: 'pnpm --filter @orc/web build && pnpm dlx tsx ../daemon/test/e2e-daemon.ts',
  url: 'http://127.0.0.1:4318/',
  reuseExistingServer: false,
  timeout: 120_000,
},
use: { baseURL: 'http://127.0.0.1:4318' },
```

`apps/web/e2e/live-inbox.spec.ts`
```ts
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const WORK = join(realpathSync(tmpdir()), 'orc-e2e', 'work', 'Wakecap');

test.describe.configure({ mode: 'serial' });

async function launch(page: import('@playwright/test').Page, prompt: string) {
  await page.getByRole('button', { name: 'New session' }).click();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await expect(dialog.getByLabel('Working directory')).toHaveAttribute('placeholder', WORK);
  await dialog.getByLabel('Prompt').fill(prompt);
  await dialog.getByRole('button', { name: 'Launch' }).click();
  await expect(dialog).toBeHidden();
}

test('root redirects to the inbox', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
});

test('a waiting session shows on the board and in the inbox within seconds', async ({ page }) => {
  await page.goto('/inbox');
  await launch(page, 'please wait for me');
  const item = page.getByRole('listitem').filter({ hasText: 'fake session: waiting — input needed' });
  await expect(item).toBeVisible({ timeout: 5000 });
  await expect(page).toHaveTitle('(1) Orchestrator');
  await expect(page.getByRole('link', { name: 'Inbox, 1 open' })).toBeVisible();

  await page.getByRole('link', { name: 'Live' }).click();
  const card = page.getByRole('article', { name: 'fake session — Waiting' });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-attention', 'true');
  await expect(card.getByRole('button', { name: 'Terminal' })).toBeVisible();

  page.once('dialog', (d) => void d.accept());
  await card.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('article', { name: 'fake session — Ended' })).toBeVisible({ timeout: 5000 });
  await page.getByRole('link', { name: /Inbox,/ }).click();
  await expect(page.getByText('Nothing needs you right now.')).toBeVisible({ timeout: 5000 });
});

test('review and red tests are triaged with the keyboard', async ({ page }) => {
  await page.goto('/inbox');
  await launch(page, 'fix it and fail');
  await expect(page.getByRole('listitem')).toHaveCount(2, { timeout: 8000 });
  await expect(page.getByRole('listitem').filter({ hasText: 'Tests red' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Ready for review' })).toBeVisible();
  await page.keyboard.press('j');
  await page.keyboard.press('e');
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await page.keyboard.press('s');
  await expect(page.getByRole('listitem')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Snoozed' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(1);
});

test('settings show archive status and retention warning', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText(/^\d+ files · /)).toBeVisible();
  await expect(page.getByRole('status')).toContainText('30 days (default)');
  await expect(page.getByText('"cleanupPeriodDays": 3650')).toBeVisible();
});
```

Run: `pnpm --filter @orc/web e2e -- live-inbox.spec.ts`
Expected: 4 passed. On a failure, open the trace with `pnpm --filter @orc/web exec playwright show-trace`.

```bash
git add apps/daemon/test/e2e-daemon.ts apps/web/e2e/live-inbox.spec.ts apps/web/playwright.config.ts
git commit -m "test(web): add live board and inbox e2e on fixtures with the fake claude"
```

- [ ] **Step 6: Check the M2 exit criteria and record the evidence**

Create `plan/phase-2-evidence.md` and fill in every row with pasted output or a screenshot path. The manual checks run against the **real** `~/.claude` and `~/.codex`, **read-only**.

| # | M2 exit criterion (docs/05) | How to show it | Evidence |
|---|---|---|---|
| 1 | All running Claude and Codex sessions are visible | 1. Start the daemon with the normal homes: `pnpm --filter @orc/daemon dev`. 2. Open 2+ `claude` sessions and 1 `codex` session in terminals. 3. Compare `ps -axo pid,command \| grep -E '(^\| )(claude\|codex)( \|$)'` with the `/live` board. They must match 1:1; ended ones show `ended`. 4. Take a screenshot of the board. | |
| 2 | Anything that needs me shows in the inbox within 2 s | 1. In an observed real `claude` session, ask something that makes it ask back (or use plan mode). 2. Compare `statusUpdatedAt` in `~/.claude/sessions/<pid>.json` (read it with `cat`) with the inbox item's `createdAt` from `curl -H "x-orc-token: …" http://127.0.0.1:4317/api/inbox?state=open`. 3. Record the difference; it must be < 2000 ms. Automated: `p2-daemon.test.ts`, the waiting test. If S3 required hooks, repeat with the hook snippet installed by hand and record both numbers. | |
| 3 | No transcript is lost after 30 days | 1. `find ~/.claude/projects -name '*.jsonl' -not -path '*/tool-results/*' \| wc -l` equals `files` in `GET /api/archive/status` after "Sync now". 2. Restore round trip on a **copy**: `cp -R ~/.claude /tmp/claude-copy`, start the daemon with `CLAUDE_HOME=/tmp/claude-copy ORC_HOME=$(mktemp -d)`, sync, delete one transcript in the copy, check the session shows `archived`, restore it from Session Detail, then `cmp` the file with the original. 3. The Settings warning shows the current `cleanupPeriodDays`. | |
| 4 | F1 card fields and states | A screenshot showing: status, time in state, cwd plus drift, tool, last prompt, cost, ticket/PR chips, stage bar, test chip, jobs, permission and agents badges; attention-first ordering; grid/list/split; group by | |
| 5 | F15 notifications and triage | A macOS notification screenshot (click opens the session); j/k/e/s in `/inbox`; the tab title count | |
| 6 | F4 launch | Launch "Implement ticket" with `SAF-xxxx` in a scratch directory, or a real repo with a harmless prompt, then cancel. The terminal tab opens and the card becomes `owned`. The 429 appears when `maxConcurrentOwned` is 1. | |
| 7 | Read-only toward tool data | Run `find ~/.claude ~/.codex -newer /tmp/phase2-start -not -path '*/projects/*' -not -path '*/sessions/*' -not -path '*/history.jsonl' -print`, where `touch /tmp/phase2-start` ran before the checks. The output must contain only files the CLIs themselves wrote. No `.key` file shows up in `lsof -p <daemon pid> \| grep '\.key'`. | |
| 8 | Suite green | `pnpm lint && pnpm typecheck && pnpm test && pnpm check:fixtures && pnpm --filter @orc/web e2e` | |

- [ ] **Step 7: Merge the contract additions and update the status**

1. Merge the "Contract additions" section of this plan into `plan/00-contracts.md`:
   - §3: add the `live` block to `OrcConfig` and the `ORC_NOTIFY=off` env note.
   - §4: add the core additions list.
   - §5: add the column notes for `inbox_items`, `test_results` and `archive_entries`.
   - §6: replace the `P2` route lines with the final list, and add the new client method names.
   - §11:
     - add `live?`, `launcher?` and `updateConfig?` to `DaemonContext`
     - change `archive?` to `ArchiveServiceRuntime`
     - add `LiveTracker`, `HookEvent`, `LaunchService`, `LaunchResult`, `InboxEngineRuntime`, `ArchiveServiceRuntime` and `resolveAvailability`
   - §12: add the query keys, stores and hook.
2. In `plan/README.md`, set Phase 2's status to `☑ done (<date>)`.
3. Commit and merge:

```bash
pnpm lint && pnpm typecheck && pnpm test
git add plan/00-contracts.md plan/README.md plan/phase-2-evidence.md
git commit -m "docs(plan): record phase 2 exit evidence and merge contract additions"
git checkout main && git merge --no-ff phase/2-live-board-inbox-archive -m "merge: phase 2 live board, inbox, launch and archive"
```

---

## Self-review (done while writing this plan)

**Spec coverage**

| Requirement | Task |
|---|---|
| Registry watcher, `*.key` ignored | 5 (`isRegistryFileName`, a test asserts no `.key` read) |
| Pid liveness with `procStart` | 5 |
| Codex live detection (ps + lsof + rollout mtime, S5) | 6, 7 |
| Transcript tail → currentTool/stage/backgroundJobs/runningSubagents/contextFill/lastTest | 4, 7 |
| Derived review / error / ended | 4, 7 |
| Ownership via PtyManager | 7, 13 (integration) |
| `session.statusChanged` / `session.updated` / `turnEnded` / `tests.recorded` | 7 |
| `GET /api/live`, WS `/ws` hello + deltas | 8, 16 |
| S3 hook ingest (minimal `POST /api/hooks`) | 8, snippet in 20 |
| `inbox_items` + repo, InboxEngine per contract, snooze wake-up | 1, 9 |
| Rules waiting / review / error / tests_red (pass→fail) + auto-resolve | 10 |
| `/api/inbox` routes | 10 |
| Notifier + macOS (click URL), per-kind prefs, debounce | 9 (once per state change), 11 |
| TemplateRegistry: 5 workflows + 5 presets | 12 |
| `POST /api/sessions/launch` (claude/codex in PTY, resumeProfile, prompt arg, sessionId via registry pid) | 13 |
| Kill with confirm | 13 |
| Concurrency cap → **429** (decided; tested) | 13 |
| planApproval / worktree / compare → 501 (tested) | 13, 16 |
| ArchiveService (zstd feature detection, gzip fallback), `archive_entries`, re-copy on growth | 1, 14 |
| Status incl. `cleanupPeriodDays` and oldest transcript | 14, 20 |
| Confirmed restore, no overwrite | 15, 20 |
| Availability `archived` in SessionService | 15 |
| Periodic sync | 14 (`start`), 16 |
| Live Board with every F1 field, attention-first, grid/list/split, group-by, card actions, open-in remembered per project | 18 |
| `/inbox` keyboard triage, AppShell count + `document.title`, `/` → `/inbox` | 17, 19 |
| Launch dialog (source, project/cwd, template/preset + vars, prompt) | 19 |
| `useLiveEvents` cache updates | 17 |
| Settings: archive status, snippet, notification prefs | 20 |
| Exit mapping with manual evidence (real sessions, read-only) + e2e on fixtures with the fake `claude` in `apps/daemon/test/bin` | 13, 16, 20 |

**Deliberately out of scope:**
- `blocked` status and goals (Phase 5)
- the audit wrapper (Phase 3; the call sites are named in Tasks 13 and 15)
- archive pruning (only a warning above `maxGb`)
- quiet hours per kind (the contract config has no field for them yet)
- web push and Slack DM channels (Phase 6)
- the Diff button (Phase 4)
- plan approval, worktree launch and compare mode (501 until Phases 4/7)

**Placeholder scan:** no "TBD", "TODO" or "similar to Task N". Every code step has complete code. The only non-code edits are the named changes to Phase-1 files (`sessions.ts` availability, the `app.ts` registration, the `ws.ts` branch, `createDaemon`, `AppShell`, `SettingsPage`, the session header). Each comes with its exact snippet, and Task 1 Step 1 verifies the P1 names first.

**Type consistency, checked across tasks:**
- `LiveTracker.waitForPid` (7) is used by `LaunchService` (13) and `createFakeLive` (8).
- `InboxEngineRuntime` (9) is used by the rules (10) and `startPhase2` (16).
- `ArchiveServiceRuntime.restorePlan/codec` (14/15) is used by the routes (15).
- `LaunchError` statuses (13) map through `apiError` (2).
- `dedupeKeyFor` produces `${kind}:${pk}` (10), which is what the engine tests (9) and the notifier debounce (11) use.
- `WireEvent` exists in the daemon (8) and the web (17) with the same variants.
- The query keys `['live']`, `['inbox', filters]`, `['archive-status']` and `['notification-prefs']` are the same in 17–20.
- `useLiveLayoutStore.openInByProject` (18) is used by `OpenInButton` (18).
- `useLaunchStore.open` is read by `useInboxKeys` (19).
- `describeLaunchError` (19) is reused by `RestoreButton` (20).
