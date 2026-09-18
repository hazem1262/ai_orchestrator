# 00 — Shared Contracts

> **Every phase plan must follow this file.** It is the single source of truth for names, types, paths, routes and conventions. When a phase needs something new, it adds it under that phase's "Contract additions". The addition is merged into this file at the end of the phase, in the same PR.
>
> Spec: `docs/` (README, 01–06). Features are referred to by ID (`F1`–`F24`) from `docs/02-features.md`.

---

## 1. Tooling & versions (checked with `npm view`, 2026-09-17)

| Tool | Version pin | Notes |
|---|---|---|
| Node | `>=22.12 <23` (local: 22.20.0) | `engines` in root `package.json`; `.nvmrc` = `22` |
| pnpm | `10.18.3` | `packageManager` field in root `package.json` |
| TypeScript | `~6.0.3` | TS 7 (native) is `latest`, but we stay on the JS-based compiler for tool compatibility. Upgrading is a separate task later. |
| Vitest | `^5.0.1` | workspace projects |
| Biome | `^2.5.14` | lint and format (replaces ESLint and Prettier) |
| tsx | `^4.23.13` | dev runner for the daemon |
| tsup | `^8.5.1` | daemon bundle |

**Daemon runtime dependencies**

| Package | Version |
|---|---|
| hono | `^4.13.8` |
| @hono/node-server | `^2.1.1` |
| ws | `^8.21.3` |
| better-sqlite3 | `^13.0.3` |
| drizzle-orm | `^0.45.2` |
| drizzle-kit | `^0.31.10` (dev dependency) |
| node-pty | `^1.1.0` |
| chokidar | `^5.0.0` |
| zod | `^4.6.5` |
| pino | `^10.3.1` |
| execa | `^10.0.1` |
| croner | `^10.0.1` |
| web-push | `^3.6.7` |
| @simplewebauthn/server | `^14.0.2` |
| @modelcontextprotocol/sdk | `^1.30.0` |
| @linear/sdk | `^95.1.0` |
| @slack/web-api | `^8.1.1` |
| node-notifier | `^10.0.1` |
| @napi-rs/keyring | `^2.1.0` |

**Web runtime dependencies**

| Package | Version |
|---|---|
| react / react-dom | `^19.3.0` (`@wakecap/core-ui` peer is `>=18.2.0`) |
| vite | `^8.3.0` |
| @vitejs/plugin-react | latest |
| tailwindcss + @tailwindcss/vite | `^4.3.3` |
| @tanstack/react-query | `^5.103.1` |
| @tanstack/react-router | `^1.170.38` |
| @tanstack/react-table | `^9.2.4` |
| @tanstack/react-virtual | `^3.14.13` |
| zustand | `^5.0.15` |
| @xterm/xterm | `^6.0.0` |
| @xterm/addon-fit | `^0.11.0` |
| @xyflow/react | `^12.11.6` |
| echarts | `^6.1.0` |
| cmdk | `^1.1.1` |
| react-resizable-panels | `^4.12.4` |
| @git-diff-view/react | `^0.1.7` |
| vite-plugin-pwa | `^1.3.0` |
| @playwright/test | `^1.63.0` (e2e) |

**UI kit:** `@wakecap/core-ui@^0.17.0` + `@wakecap/core-tokens@^0.8.0` from `https://npm.pkg.github.com`, **if spike S6 passes**. Otherwise use shadcn/ui components copied into `apps/web/src/components/ui/`. Throughout the plans, UI code imports from `@/components/ui/*`. That file re-exports either Wakecore or shadcn, so phase code doesn't change whichever one is chosen.

## 2. Repository layout

```
orchestrator/
├─ package.json                 # private root; scripts: build, test, lint, typecheck, dev
├─ pnpm-workspace.yaml          # packages: apps/*, packages/*
├─ tsconfig.base.json           # strict, ES2023, moduleResolution "bundler", verbatimModuleSyntax
├─ biome.json
├─ vitest.workspace.ts
├─ .nvmrc  .gitignore  .npmrc   # .npmrc maps @wakecap to GitHub Packages (token from env)
├─ fixtures/                    # redacted sample data (see §9)
├─ scripts/                     # repo scripts (coverage checks, dry-runs)
├─ packages/
│  ├─ core/                     # @orc/core — pure TS: types, parsers, derivations, redaction. NO fs/net/process imports except in src/io/*
│  └─ api-contract/             # @orc/api-contract — zod schemas for HTTP/WS + typed client
├─ apps/
│  ├─ daemon/                   # @orc/daemon — Node service
│  └─ web/                      # @orc/web — React UI (Vite)
├─ spikes/                      # throwaway spike code (Phase 0), not part of the build
├─ docs/                        # design docs (spec)
└─ plan/                        # these plans; plan/spikes/<id>.md spike reports
```

### Package internals (the pattern every phase follows)
```
packages/core/src/
  index.ts                  # re-exports only
  types/                    # domain types (§4), one file per aggregate
  claude/                   # Claude parsers: records.ts, session-aggregate.ts, history.ts, registry.ts, subagents.ts
  codex/                    # rollout.ts, codex-aggregate.ts
  derive/                   # tickets.ts, skills.ts, prod.ts, name.ts, stage.ts, tests.ts, cost.ts
  redact/                   # redact.ts
  io/                       # jsonl-tail.ts (the only fs-touching module in core)
apps/daemon/src/
  main.ts                   # boot
  config.ts                 # §3
  db/                       # schema.ts, client.ts, migrations/ (drizzle-kit output), repos/*.ts
  collectors/               # claude/, codex/, agnc/
  indexer/                  # indexer.ts, file-offsets.ts
  live/                     # registry-watcher.ts, liveness.ts, event-bus.ts
  pty/                      # pty-manager.ts, input.ts
  inbox/                    # engine.ts, rules/*.ts
  notify/                   # notifier.ts, macos.ts, webpush.ts, slack-dm.ts
  services/                 # archive/, worktree/, checkpoint/, ship/, recap/, handoff/, usage/, supervisor/, scheduler/, audit/
  connectors/               # github/, linear/, slack/, agnc/
  http/                     # app.ts (Hono), auth.ts, routes/*.ts, ws.ts
apps/web/src/
  main.tsx  router.tsx
  api/                      # client.ts (from api-contract), ws.ts, queries/*.ts
  stores/                   # zustand stores
  components/ui/            # re-export layer (§1)
  features/<feature>/       # e.g. features/history/, features/live-board/, features/inbox/ …
  routes/                   # TanStack Router file routes
```

## 3. Configuration & paths

- **`ORC_HOME`** defaults to `~/.orchestrator`. Tests always set it to a temp dir.
- **`CLAUDE_HOME`** defaults to `~/.claude`, and **`CODEX_HOME`** defaults to `~/.codex`. Tests point them at `fixtures/`.

```
$ORC_HOME/
  config.json        # user config (zod-validated, see OrcConfig)
  index.db           # SQLite (mode 0600)
  token              # per-install API token (mode 0600), 32 random bytes hex
  archive/<projectId>/<sessionId>.jsonl.zst
  archive/<projectId>/<sessionId>/subagents/agent-<id>.jsonl.zst
  logs/daemon.log
  vapid.json         # phase 6
```

```ts
// apps/daemon/src/config.ts
export interface OrcPaths { orcHome: string; claudeHome: string; codexHome: string; dbFile: string; tokenFile: string; archiveDir: string; logFile: string }
export function resolvePaths(env?: NodeJS.ProcessEnv): OrcPaths
export function loadConfig(paths: OrcPaths): OrcConfig   // creates defaults if missing
export function saveConfig(paths: OrcPaths, cfg: OrcConfig): void

// packages/api-contract/src/config.ts  (zod)
export const ProjectConfig = z.object({
  id: z.string(),                          // slug, e.g. "wakecap"
  name: z.string(),
  pathPrefixes: z.array(z.string()),       // absolute paths
  hidden: z.boolean().default(false),
  openIn: z.enum(['vscode', 'terminal', 'finder']).default('vscode'),
  ticketRegex: z.string().nullable().default(null),       // e.g. "\\b(SAF|ALU|SUPRT|SAK|TAN)-\\d+\\b"
  prodPatterns: z.array(z.string()).default([]),
  features: z.object({ workStreams: z.boolean().default(false), prodBadges: z.boolean().default(false), recaps: z.boolean().default(true) }).prefault({}),
  repos: z.array(z.object({ path: z.string(), setup: z.string().optional(), run: z.string().optional(), archive: z.string().optional(), copyGlobs: z.array(z.string()).default([]), worktreeDir: z.string().default('.worktrees') })).default([]),
  budgets: z.object({ dailyUsd: z.number().optional(), weeklyUsd: z.number().optional(), monthlyUsd: z.number().optional() }).prefault({}),
  maxConcurrentOwned: z.number().int().positive().default(6),
});
export const OrcConfig = z.object({
  port: z.number().int().default(4317),
  defaultProjectId: z.string().default('wakecap'),
  resumeProfile: z.object({ claudeCommand: z.string().default('claude'), claudeArgs: z.array(z.string()).default(['--dangerously-skip-permissions']), codexCommand: z.string().default('codex'), codexArgs: z.array(z.string()).default([]) }).prefault({}),
  projects: z.array(ProjectConfig).default([]),
  codex: z.object({ showAutomated: z.boolean().default(false) }).prefault({}),
  recaps: z.object({ enabled: z.boolean().default(false), trigger: z.enum(['manual', 'on_idle', 'daily']).default('manual'), engine: z.enum(['claude-cli', 'anthropic-api']).default('claude-cli'), autoModel: z.string().default('claude-haiku-4-5'), onDemandModel: z.string().default('claude-sonnet-5'), monthlyBudgetUsd: z.number().default(20), maxInputTokens: z.number().default(30000), minPrompts: z.number().default(2), language: z.string().default('en'), promptTemplate: z.string().nullable().default(null) }).prefault({}),
  notifications: z.record(z.string(), z.object({ enabled: z.boolean(), channels: z.array(z.enum(['macos', 'webpush', 'slack_dm'])) })).default({}),
  archive: z.object({ enabled: z.boolean().default(true), maxGb: z.number().default(10) }).prefault({}),
});
export type OrcConfig = z.infer<typeof OrcConfig>;
export type ProjectConfig = z.infer<typeof ProjectConfig>;
```


> **zod 4 note (found in Phase 0, Task 4):** `.default({})` on a nested object does **not** recurse into that object's own field defaults — it short-circuits after the parse. Use **`.prefault({})`** for every nested object that must fill its inner defaults. All nested plain-object fields above use `.prefault({})` for this reason; leaf fields keep `.default(...)`, and `z.record`/`z.array` fields keep `.default([])`/`.default({})` (they have no inner field defaults to fill).
When no projects are configured, the defaults come from Phase 1 auto-detection. The `wakecap` project gets `pathPrefixes: ["/Users/hazem/Wakecap"]`, the ticket regex above, `prodPatterns` from F9, and `features.workStreams = features.prodBadges = true`.

## 4. Domain types (`@orc/core/src/types`)

```ts
export type Source = 'claude' | 'codex' | 'agnc';
export type Availability = 'resumable' | 'archived' | 'prompts-only' | 'remote';
export type LiveStatus = 'busy' | 'idle' | 'waiting' | 'shell' | 'review' | 'blocked' | 'error' | 'ended';
export type Stage = 'understand' | 'modify' | 'test' | 'review';
export type Ownership = 'observed' | 'owned';

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number | null }
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null });

export interface PrRef { repo: string; number: number; url: string }

export interface TestResult { ts: string; command: string; passed: number; failed: number; skipped: number; durationMs: number | null }

export interface Session {
  id: string;                    // source-native id (Claude sessionId / Codex session id / AGNC id)
  source: Source;
  projectId: string | null;      // resolved via project path prefixes
  startCwd: string;              // resume dir
  cwds: string[];                // distinct cwds in first-seen order (startCwd first)
  name: string | null;           // agent-name → ai-title → first prompt (truncated 80)
  firstPrompt: string | null;
  lastPrompt: string | null;
  awaySummary: string | null;
  recap: string | null;          // LLM recap (F14)
  startedAt: string;             // ISO
  lastActivityAt: string;        // ISO
  models: string[];              // excludes '<synthetic>'
  permissionMode: string | null;
  usage: Usage;
  linesAdded: number | null;
  linesRemoved: number | null;
  prs: PrRef[];
  tickets: string[];
  skills: string[];
  mcpServers: string[];
  filesTouched: string[];
  promptCount: number;
  toolCallCount: number;
  apiErrorCount: number;
  flags: { touchedProd: boolean; hasSubagents: boolean; automated: boolean };
  availability: Availability;
  transcriptPath: string | null;
  lastTest: TestResult | null;
  live: LiveState | null;
}

export interface LiveState {
  pid: number | null;
  status: LiveStatus;
  waitingFor: string | null;
  since: string;                 // ISO, when status last changed
  ownership: Ownership;
  ptyId: string | null;          // set when owned
  stage: Stage | null;
  currentTool: string | null;
  backgroundJobs: number;
  runningSubagents: number;
  contextFill: number | null;    // 0..1
}

export interface AgentNode {
  id: string;                    // agentId
  sessionId: string;
  parentId: string | null;       // parent agentId, null = main session
  depth: number;
  agentType: string;
  description: string;
  background: boolean;
  toolUseId: string | null;
  usage: Usage;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'done' | 'error';
  transcriptPath: string;
}

export type EventKind = 'prompt' | 'assistant_text' | 'thinking' | 'tool_call' | 'tool_result' | 'system' | 'error';
export interface TimelineEvent {
  sessionId: string;
  agentId: string | null;
  uuid: string;
  parentUuid: string | null;
  seq: number;                   // monotonically increasing per file
  ts: string;
  kind: EventKind;
  turn: number;                  // increments at each human prompt
  text: string | null;           // redacted at display time, stored raw
  tool: string | null;           // e.g. 'Bash', 'mcp__claude_ai_Linear__save_issue'
  toolUseId: string | null;
  mcpServer: string | null;
  input: unknown | null;         // tool_use input (JSON)
  messageId: string | null;      // assistant message.id for usage dedupe
  model: string | null;
  usage: Usage | null;           // only on the first record per messageId
  durationMs: number | null;     // system turn_duration
}

export interface Project { id: string; name: string; pathPrefixes: string[]; hidden: boolean; lastActivityAt: string | null; sessionCount: number }

export type InboxKind = 'waiting' | 'review' | 'plan_approval' | 'blocked' | 'error' | 'tests_red' | 'budget' | 'automation_result' | 'supervisor_escalation' | 'pr_event' | 'reminder';
export type InboxState = 'open' | 'snoozed' | 'done' | 'auto_resolved';
export interface InboxItem { id: string; kind: InboxKind; sessionId: string | null; projectId: string | null; ticket: string | null; reason: string; dedupeKey: string; createdAt: string; updatedAt: string; state: InboxState; snoozeUntil: string | null; payload: Record<string, unknown> }

export type GoalState = 'active' | 'paused' | 'blocked' | 'complete';
export interface Goal { id: string; targetType: 'session' | 'stream'; targetId: string; objective: string; state: GoalState; blockedReason: string | null; updatedAt: string }
export interface Handoff { id: string; sessionId: string; status: string; summary: string; evidence: string[]; files: string[]; nextSteps: string[]; blockers: string[]; links: string[]; createdAt: string }

export interface Worktree { path: string; repo: string; branch: string; base: string | null; ticket: string | null; dirty: boolean; prUrl: string | null; state: 'active' | 'archived'; createdByApp: boolean }
export interface Checkpoint { id: string; sessionId: string; worktreePath: string; turn: number; ref: string; commit: string; createdAt: string }

export type StreamStage = 'planned' | 'implementing' | 'in_review' | 'pr_open' | 'merged' | 'backmerged' | 'released';
export interface WorkStream { ticket: string; projectId: string; title: string | null; stage: StreamStage; sessionIds: string[]; prs: PrRef[]; plans: string[]; worktrees: string[]; costUsd: number; lastActivityAt: string }

export type AuditActor = 'user' | 'automation' | 'supervisor' | 'remote';
export interface AuditEntry { id: string; ts: string; actor: AuditActor; actorDetail: string | null; action: string; target: string | null; params: Record<string, unknown>; result: 'ok' | 'error' | 'denied'; error: string | null }
```

**Audit action names** use a `<area>.<verb>` form: `session.launch`, `session.resume`, `session.fork`, `session.kill`, `pty.input`, `archive.restore`, `worktree.create`, `worktree.sync`, `worktree.archive`, `checkpoint.create`, `checkpoint.rewind`, `git.commit`, `git.push`, `pr.create`, `pr.merge`, `automation.run`, `supervisor.answer`, `linear.comment`, `slack.post`, `remote.approve`, `hook.install`.

## 5. SQLite & migrations

- **Stack:** Drizzle ORM (`drizzle-orm/better-sqlite3`). The schema lives in `apps/daemon/src/db/schema.ts`. Migrations are generated with `pnpm --filter @orc/daemon db:generate` into `apps/daemon/src/db/migrations/` and run at boot with `migrate()`.
- **Pragmas at boot:** `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`. `chmod 0600` is applied to the db file.
- **Naming:**
  - tables are `snake_case` plurals
  - columns are `snake_case`
  - timestamps are ISO text, with `_at` columns
  - JSON goes in `text` columns with the `_json` suffix
  - booleans are `integer` with `{ mode: 'boolean' }`
- **Tables** (the phase that introduces each one owns its definition):

| Table | Phase | Key |
|---|---|---|
| `projects` | 1 | `id` |
| `sessions` | 1 | `(source, id)` → column `pk` = `${source}:${id}` |
| `events` + `events_fts` (FTS5, external content) | 1 | `(session_pk, agent_id, seq)` |
| `agents` | 1 | `(session_pk, id)` |
| `file_offsets` | 1 | `path` |
| `history_prompts` | 1 | `(session_id, ts)` |
| `labels`, `pins`, `saved_views` | 1 | — |
| `pty_sessions` | 1 | `id` |
| `inbox_items` | 2 | `id`, unique `dedupe_key` where state in (open, snoozed) |
| `archive_entries` | 2 | `path` |
| `test_results` | 2 | `(session_pk, ts)` |
| `audit_log` | 3 | `id` |
| `worktrees`, `checkpoints`, `pr_cache` | 4 | — |
| `streams`, `stream_links`, `recaps`, `goals`, `handoffs`, `reminders`, `budgets`, `usage_blocks` | 5 | — |
| `connector_tokens_meta`, `push_subscriptions`, `webauthn_credentials`, `slack_threads` | 6 | — |
| `automations`, `automation_runs`, `compare_groups`, `supervisor_rules`, `supervisor_decisions` | 7 | — |

- **Repositories:** each table group has a repo module in `apps/daemon/src/db/repos/<name>.ts` that exports plain functions taking `db: OrcDb` as the first argument, e.g. `upsertSession(db, s)`. **Routes never run SQL directly.**

```ts
// apps/daemon/src/db/client.ts
export type OrcDb = BetterSQLite3Database<typeof schema>;
export function openDb(file: string): { db: OrcDb; raw: Database.Database; close(): void }  // runs migrations
```

## 6. HTTP API & WebSocket

- **Base URL:** `http://127.0.0.1:4317`. The daemon serves the built web app at `/` and the API at `/api/*`.
- **Auth:**
  - Every `/api/*` and WS request needs the header `x-orc-token: <token>`. WS can use the `?token=` query instead, because browsers can't set WS headers.
  - The web app gets the token from `GET /bootstrap.js`, which only works from a loopback address and sets `window.__ORC_TOKEN__`.
  - WS upgrades must pass an **Origin check**: `http://127.0.0.1:<port>`, `http://localhost:<port>` or the configured Tailscale origin.
- **Errors:** always `{ error: { code: string; message: string; details?: unknown } }` with a correct HTTP status. Codes are `snake_case`, e.g. `session_live`, `not_found`, `validation_failed`, `forbidden`, `confirmation_required`.
- **Confirmation:** destructive endpoints need `{"confirm": true}` in the body. Without it they return `409 confirmation_required` with a `details.summary` to show the user.
- **Validation:** every request and response schema lives in `@orc/api-contract/src/routes/<area>.ts` as zod. The client is `createApiClient({ baseUrl, token })` in `@orc/api-contract/src/client.ts` and exposes typed methods named `<area><Verb>`, e.g. `sessionsList`, `sessionsGet`, `sessionsResume`.

### Routes (grouped by the phase that adds them)
```
P1  GET    /api/health                               → { ok, version, uptimeS }
P1  GET    /api/projects                             → Project[]
P1  PATCH  /api/projects/:id                         body Partial<ProjectConfig>
P1  GET    /api/sessions?q&projectId&source&ticket&pr&from&to&model&minCost&maxCost&skill&hasSubagents&touchedProd&availability&limit&cursor
                                                     → { items: SessionListItem[]; nextCursor: string | null }
P1  GET    /api/sessions/:source/:id                 → Session
P1  GET    /api/sessions/:source/:id/events?agentId&afterSeq&limit → { items: TimelineEvent[]; nextSeq: number | null }
P1  GET    /api/sessions/:source/:id/agents          → AgentNode[]
P1  POST   /api/sessions/:source/:id/resume          body { mode: 'embedded'|'external'; fork?: boolean } → { ptyId } | { launched: 'external' }
P1  POST   /api/sessions/:source/:id/pin | /label    …
P1  GET    /api/pty                                  → PtyInfo[]
P1  DELETE /api/pty/:ptyId                           body { confirm: true }
P1  WS     /pty/:ptyId                               binary out; client msgs: { t:'in', d:string } | { t:'resize', cols, rows }
P2  GET    /api/live                                 → Session[] (with live != null)
P2  POST   /api/sessions/launch                      body LaunchRequest → { ptyId, sessionId | null }
P2  POST   /api/sessions/:source/:id/kill            body { confirm: true }
P2  GET    /api/inbox?state&kind&projectId           → InboxItem[]
P2  POST   /api/inbox/:id/(done|snooze|reopen)       body { until? }
P2  GET    /api/templates                            → Template[]
P2  GET    /api/archive/status ; POST /api/archive/restore  body { source, id, confirm }
P2  WS     /ws                                       server → client LiveEvent (below)
P3  GET    /api/audit?…                              → AuditEntry[]
P3  GET    /api/sessions/:source/:id/export          → application/zip
P4  /api/worktrees…  /api/diff…  /api/checkpoints…  /api/ship…        (defined in phase 4)
P5  /api/streams…  /api/analytics…  /api/usage…  /api/recaps…  /api/goals…  /api/handoffs…  /api/reminders…  /api/hooks (bridge ingest)
P6  /api/connectors…  /api/push…  /api/webauthn…
P7  /api/automations…  /api/compare…  /api/supervisor…
```

### WS `/ws` live events
```ts
export type LiveEvent =
  | { type: 'session.updated'; session: Session }
  | { type: 'session.removed'; pk: string }
  | { type: 'inbox.upserted'; item: InboxItem }
  | { type: 'pty.exited'; ptyId: string; code: number | null }
  | { type: 'index.progress'; done: number; total: number }
  | { type: 'usage.updated'; snapshot: unknown }          // typed in phase 5
  | { type: 'hello'; serverTime: string };
```
- The server sends `hello` on connect, then deltas.
- The web app maps events onto TanStack Query cache updates with `queryClient.setQueryData`.
- Query keys: `['sessions', filters]`, `['session', source, id]`, `['live']`, `['inbox', filters]`, `['projects']`.

### Event bus (daemon-internal)
```ts
// apps/daemon/src/live/event-bus.ts
export type BusEvent = LiveEvent
  | { type: 'hook.received'; payload: unknown }
  | { type: 'session.statusChanged'; pk: string; from: LiveStatus | null; to: LiveStatus }
  | { type: 'session.turnEnded'; pk: string; turn: number }
  | { type: 'tests.recorded'; pk: string; result: TestResult };
export interface EventBus { emit(e: BusEvent): void; on<T extends BusEvent['type']>(type: T, fn: (e: Extract<BusEvent, { type: T }>) => void): () => void }
export function createEventBus(): EventBus
```

## 7. PTY & session ownership
```ts
// apps/daemon/src/pty/pty-manager.ts
export interface PtyInfo { id: string; sessionPk: string | null; command: string; args: string[]; cwd: string; pid: number; startedAt: string; exitedAt: string | null; exitCode: number | null; cols: number; rows: number }
export interface PtyManager {
  spawn(opts: { command: string; args: string[]; cwd: string; sessionPk?: string | null; cols?: number; rows?: number; env?: Record<string, string> }): PtyInfo;
  write(id: string, data: string): void;              // raw
  sendText(id: string, text: string): Promise<void>;   // bracketed paste + Enter, waits for idle (from spike S8)
  resize(id: string, cols: number, rows: number): void;
  kill(id: string, signal?: NodeJS.Signals): void;
  attach(id: string, onData: (chunk: string) => void): { scrollback: string; detach(): void };
  list(): PtyInfo[];
  get(id: string): PtyInfo | undefined;
}
export function createPtyManager(opts: { bus: EventBus; scrollbackBytes?: number }): PtyManager
```
- **Owned** means `LiveState.ownership = 'owned'`. The session pk maps to a live `PtyInfo`.
- Only owned sessions accept input. Anything else returns `403 not_owned`.

## 8. Redaction, logging, IDs
- `@orc/core/src/redact/redact.ts` exports `redact(text: string): string` and `REDACTION_PATTERNS`. The patterns cover:
  - `ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `sk-`
  - `xox[abposr]-`
  - `AKIA[0-9A-Z]{16}`
  - `postgres(ql)?://user:pass@`, `mongodb(+srv)?://…@`
  - `password=`, `pwd=`, `secret=`, `token=`
  - `Authorization: Bearer …`

  Matches are replaced with `«redacted:<kind>»`.
- **Where redaction happens:** API responses that carry transcript text (`events`, `sessions` list snippets, export) are redacted **in the route layer**. The DB keeps the raw text.
- **Logging:** pino writes JSON to `$ORC_HOME/logs/daemon.log`, and pretty output in dev. Transcript text is never logged.
- **IDs:** `crypto.randomUUID()`, except that the session pk is `${source}:${id}`.

## 9. Testing conventions
- **Vitest workspace:** `packages/*` and `apps/daemon` use the `node` environment. `apps/web` uses `jsdom` for units and Playwright for e2e (`apps/web/e2e`).
- **Fixtures (`fixtures/`)**, all redacted and small:
  - `fixtures/claude-home/`, which mirrors the real layout:
    - `projects/-Users-test-Wakecap/…`
    - `sessions/`
    - `history.jsonl`
    - `usage-data/`
    - `plans/`
  - `fixtures/codex-home/`
  - Tests set `CLAUDE_HOME`, `CODEX_HOME` and `ORC_HOME` to temp copies using the `useTempHomes()` helper from `apps/daemon/test/helpers.ts`.
- **Minimum fixture sessions** (created in Phase 0 Task 2):

  | Fixture | Content |
  |---|---|
  | `s-basic` | 3 prompts, Bash + Edit, cost-state, ai-title |
  | `s-subagents` | 3-level nesting, background agent |
  | `s-prlink` | pr-link + ticket SAF-1787 in prompt |
  | `s-drift` | cwd drift from `/Users/test/Wakecap` → `/Users/test/Wakecap/Backend/svc` |
  | `s-errors` | API error, `<synthetic>` model, truncated last line |
  | `s-unknown` | unknown record types |
  | `codex-basic` | rollout with session_meta, token_count |
  | `codex-automated` | `originator: codex_sdk_ts` |

- **Daemon HTTP tests** use `app.request()` (Hono) without opening a port. WS/PTY tests use a real ephemeral port (`port: 0`).
- **External CLIs** (`claude`, `codex`, `gh`, `git`) are faked in unit tests with small shell scripts in `apps/daemon/test/bin/`, prepended to `PATH`. Real `git` is used in temp repos for worktree and checkpoint tests.

## 10. Git & commit conventions
- **Branches:** one per phase, `phase/<n>-<slug>` (e.g. `phase/1-history-search-resume`), merged to `main` when the phase exit check passes.
- **Commits:** Conventional Commits with a scope, e.g. `feat(core): parse cost-state records`, `test(daemon): …`, `chore(repo): …`, `docs(plan): …`. Every commit made by an agent ends with the attribution lines required by the session.
- **Before every commit:** `pnpm lint && pnpm typecheck && pnpm test` must pass. Each task's last step runs this.

## 11. Cross-phase service interfaces

Later phases call these services. The **owning phase** implements the exact signature, and **consuming phases** use it without redefining it. Every service is created in `apps/daemon/src/main.ts` → `createDaemon()` and passed through `DaemonContext`.

```ts
// apps/daemon/src/context.ts  (Phase 1 creates; later phases add optional fields)
export interface DaemonContext {
  paths: OrcPaths;
  config: () => OrcConfig;                 // live getter (config can change at runtime)
  db: OrcDb;
  bus: EventBus;
  log: import('pino').Logger;
  pty: PtyManager;                         // P1
  sessions: SessionService;                // P1
  projects: ProjectService;                // P1
  inbox?: InboxEngine;                     // P2
  notifier?: Notifier;                     // P2
  templates?: TemplateRegistry;            // P2
  archive?: ArchiveService;                // P2
  audit?: AuditService;                    // P3
  denyList?: DenyList;                     // P3
  worktrees?: WorktreeService;             // P4
  checkpoints?: CheckpointService;         // P4
  ship?: ShipService;                      // P4
  github?: GithubConnector;                // P4
  usage?: UsageMeter;                      // P5
  recaps?: RecapService;                   // P5
  handoffs?: HandoffService;               // P5
  goals?: GoalService;                     // P5
  scheduler?: Scheduler;                   // P5 (reminders) — extended in P7
  linear?: LinearConnector;                // P6
  slack?: SlackConnector;                  // P6
  automations?: AutomationService;         // P7
  supervisor?: Supervisor;                 // P7
}
```
Once its phase has shipped, code must treat an optional service as present. Tests build a context with `createTestContext(overrides)` from `apps/daemon/test/helpers.ts` (created in P1 and extended by each phase).

```ts
// P1 — apps/daemon/src/services/sessions.ts
export interface SessionListQuery { q?: string; projectId?: string; source?: Source; ticket?: string; pr?: string; from?: string; to?: string; model?: string; minCost?: number; maxCost?: number; skill?: string; hasSubagents?: boolean; touchedProd?: boolean; availability?: Availability; limit?: number; cursor?: string }
export interface SessionListItem { pk: string; source: Source; id: string; projectId: string | null; name: string | null; firstPrompt: string | null; lastPrompt: string | null; recap: string | null; startedAt: string; lastActivityAt: string; durationMs: number; costUsd: number | null; tickets: string[]; prs: PrRef[]; availability: Availability; pinned: boolean; labels: string[]; live: LiveState | null; snippet: string | null }
export interface SessionService {
  list(q: SessionListQuery): { items: SessionListItem[]; nextCursor: string | null };
  get(source: Source, id: string): Session | null;
  getByPk(pk: string): Session | null;
  events(source: Source, id: string, opts: { agentId?: string | null; afterSeq?: number; limit?: number }): { items: TimelineEvent[]; nextSeq: number | null };
  agents(source: Source, id: string): AgentNode[];
  setLive(pk: string, live: LiveState | null): void;      // emits session.updated
  resume(source: Source, id: string, opts: { mode: 'embedded' | 'external'; fork?: boolean }): Promise<{ ptyId: string } | { launched: 'external' }>;
}
export const sessionPk = (source: Source, id: string) => `${source}:${id}`;

// P1 — apps/daemon/src/services/projects.ts
export interface ProjectService { list(): Project[]; resolve(cwd: string): string | null; get(id: string): ProjectConfig | null; update(id: string, patch: Partial<ProjectConfig>): ProjectConfig }

// P2 — apps/daemon/src/inbox/engine.ts
export interface InboxUpsert { kind: InboxKind; dedupeKey: string; sessionId?: string | null; projectId?: string | null; ticket?: string | null; reason: string; payload?: Record<string, unknown> }
export interface InboxEngine {
  upsert(item: InboxUpsert): InboxItem;                // open or refresh; emits inbox.upserted; triggers notifier
  resolve(dedupeKey: string): void;                    // auto_resolved
  list(filter: { state?: InboxState[]; kind?: InboxKind[]; projectId?: string }): InboxItem[];
  markDone(id: string): InboxItem; snooze(id: string, until: string): InboxItem; reopen(id: string): InboxItem;
  registerRule(rule: InboxRule): void;
}
export interface InboxRule { name: string; on: BusEvent['type'][]; handle(e: BusEvent, ctx: DaemonContext): void }

// P2 — apps/daemon/src/notify/notifier.ts
export type NotifyChannel = 'macos' | 'webpush' | 'slack_dm';
export interface NotifyChannelImpl { id: NotifyChannel; send(item: InboxItem, url: string): Promise<void> }
export interface Notifier { notify(item: InboxItem): Promise<void>; register(channel: NotifyChannelImpl): void; setAway(away: boolean): void; isAway(): boolean }

// P2 — apps/daemon/src/services/templates.ts
export interface Template { id: string; kind: 'workflow' | 'preset'; label: string; prompt: string; vars: Array<'ticket' | 'ticketUrl' | 'prUrl' | 'file' | 'check'>; defaultSource: Source; projectIds: string[] | 'all' }
export interface TemplateRegistry { list(projectId?: string): Template[]; render(id: string, vars: Record<string, string>): string }
// api-contract
export const LaunchRequest = z.object({ source: z.enum(['claude','codex']), projectId: z.string().nullable(), cwd: z.string(), prompt: z.string().default(''), templateId: z.string().optional(), vars: z.record(z.string(), z.string()).default({}), ticket: z.string().optional(), model: z.string().optional(), planApproval: z.boolean().default(false), worktree: z.object({ repo: z.string(), base: z.string(), type: z.enum(['feat','fix','chore','docs','refactor']), slug: z.string() }).optional(), compare: z.array(z.object({ source: z.enum(['claude','codex']), model: z.string().optional() })).optional() });

// P2 — apps/daemon/src/services/archive/archive.ts
export interface ArchiveService { syncAll(): Promise<{ copied: number }>; status(): { enabled: boolean; files: number; bytes: number; oldestTranscript: string | null; cleanupPeriodDays: number | null }; restore(source: Source, id: string): Promise<void> }

// P3 — apps/daemon/src/services/audit/audit.ts
export interface AuditService { record(e: Omit<AuditEntry, 'id' | 'ts'>): AuditEntry; list(filter: { sessionPk?: string; action?: string; actor?: AuditActor; from?: string; to?: string; limit?: number }): AuditEntry[] }
export async function audited<T>(audit: AuditService, meta: Omit<AuditEntry, 'id' | 'ts' | 'result' | 'error'>, fn: () => Promise<T>): Promise<T>   // records ok/error

// P3 — packages/core/src/derive/deny-list.ts  (pure) + apps/daemon wrapper
export interface DenyVerdict { denied: boolean; reason: string | null }
export function checkDenied(text: string, patterns: string[]): DenyVerdict
export const DEFAULT_DENY_PATTERNS: string[]   // prod skills, kubectl prod ctx, terraform apply, git push --force, git reset --hard, rm -rf, DROP TABLE, deploy
export interface DenyList { check(text: string, projectId: string | null): DenyVerdict }

// P4 — apps/daemon/src/services/worktree/worktree.ts
export interface CreateWorktreeInput { repo: string; base: string; type: 'feat'|'fix'|'chore'|'docs'|'refactor'; ticket: string | null; slug: string }
export interface WorktreeService { discover(): Promise<Worktree[]>; create(i: CreateWorktreeInput): Promise<Worktree>; runScript(path: string, which: 'setup'|'run'|'archive'): Promise<{ ptyId: string }>; syncToMain(path: string): Promise<{ files: number }>; archive(path: string): Promise<void>; branchName(i: Pick<CreateWorktreeInput,'type'|'ticket'|'slug'>): string }
// P4 — services/checkpoint/checkpoint.ts
export interface CheckpointService { create(sessionPk: string, worktreePath: string, turn: number): Promise<Checkpoint>; list(sessionPk: string): Checkpoint[]; rewind(checkpointId: string): Promise<Checkpoint /* safety checkpoint */> ; diff(fromRef: string, toRef: string | 'WORKTREE', cwd: string): Promise<string /* unified diff */> }
// P4 — services/ship/ship.ts
export interface ShipService { commit(cwd: string, message: string): Promise<{ sha: string }>; push(cwd: string): Promise<void>; createPr(cwd: string, i: { title: string; body: string; base: string; draft?: boolean }): Promise<PrRef>; merge(pr: PrRef, method: 'merge'|'squash'|'rebase'): Promise<void> }
// P4 — connectors/github/github.ts
export interface PrStatus { pr: PrRef; state: 'open'|'closed'|'merged'; title: string; checks: 'pending'|'success'|'failure'|'none'; review: 'approved'|'changes_requested'|'review_required'|'none'; updatedAt: string }
export interface GithubConnector { status(): Promise<'ok'|'unauthenticated'|'error'>; prStatus(pr: PrRef): Promise<PrStatus>; myOpenPrs(): Promise<PrStatus[]>; poll(): Promise<void> /* emits pr events on bus */ }
// bus additions (P4): { type: 'pr.changed'; before: PrStatus | null; after: PrStatus }

// P5 — services/usage/meter.ts
export interface UsageSnapshot { source: 'official' | 'estimate'; block: { start: string; end: string; tokens: number; costUsd: number; pctOfLimit: number | null }; week: { tokens: number; costUsd: number; pctOfLimit: number | null }; burnRateUsdPerHour: number; projectedBlockExhaustionAt: string | null }
export interface UsageMeter { snapshot(): UsageSnapshot; checkBudget(scope: { projectId?: string; ticket?: string }): { ok: boolean; pct: number; limitUsd: number | null } }
// P5 — services/recap/recap.ts ; services/handoff/handoff.ts ; services/goals.ts
export interface RecapService { recap(sessionPk: string, opts?: { onDemand?: boolean }): Promise<{ text: string; costUsd: number; model: string }>; daily(projectId: string, date: string): Promise<string> }
export interface HandoffService { generate(sessionPk: string): Promise<Handoff>; toMarkdown(h: Handoff): string; latest(sessionPk: string): Handoff | null }
export interface GoalService { get(targetType: Goal['targetType'], targetId: string): Goal | null; set(g: Omit<Goal, 'id' | 'updatedAt'>): Goal }
// P5 — services/scheduler/scheduler.ts
export interface ScheduledJob { id: string; kind: 'reminder' | 'automation' | 'digest'; cron: string | null; runAt: string | null; payload: Record<string, unknown>; enabled: boolean }
export interface Scheduler { add(job: Omit<ScheduledJob, 'id'>): ScheduledJob; remove(id: string): void; list(kind?: ScheduledJob['kind']): ScheduledJob[]; onFire(kind: ScheduledJob['kind'], fn: (job: ScheduledJob) => Promise<void>): void }

// P6 — connectors/linear/linear.ts ; connectors/slack/slack.ts
export interface LinearIssue { id: string; identifier: string; title: string; state: string; assignee: string | null; url: string; labels: string[] }
export interface LinearConnector { status(): Promise<'ok'|'unauthenticated'|'error'>; issue(identifier: string): Promise<LinearIssue | null>; comment(identifier: string, markdown: string): Promise<void>; createIssue(i: { teamKey: string; title: string; description: string; assignToMe?: boolean }): Promise<LinearIssue>; assignedToMe(): Promise<LinearIssue[]> }
export interface SlackConnector { status(): Promise<'ok'|'unauthenticated'|'error'>; me(): Promise<{ userId: string; dmChannelId: string }>; post(channel: string, text: string, threadTs?: string): Promise<{ ts: string }>; replies(channel: string, threadTs: string, afterTs?: string): Promise<Array<{ ts: string; user: string; text: string }>>; mentions(sinceTs: string): Promise<Array<{ channel: string; ts: string; text: string }>> }
// P6 — secrets
export interface SecretStore { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }   // @napi-rs/keyring, service "orchestrator"

// P7 — services/automations ; services/supervisor
export interface AutomationService { list(): Automation[]; save(a: Automation): Automation; runNow(id: string): Promise<AutomationRun>; runs(id: string): AutomationRun[] }
export interface Automation { id: string; name: string; enabled: boolean; trigger: { type: 'cron'; cron: string } | { type: 'github'; event: 'review_comment'|'check_failed'|'pr_merged' } | { type: 'linear'; event: 'assigned'|'labeled'; label?: string } | { type: 'slack'; event: 'mention'; channel: string } | { type: 'manual' }; action: { templateId: string; projectId: string; repo?: string; useWorktree: boolean; headless: boolean; model?: string; timeoutMin: number; planApproval: boolean }; budgetUsd: number }
export interface AutomationRun { id: string; automationId: string; startedAt: string; endedAt: string | null; status: 'queued'|'running'|'success'|'failed'|'denied'|'over_budget'; sessionPk: string | null; costUsd: number | null; summary: string | null }
export interface SupervisorDecision { id: string; sessionPk: string; question: string; decision: 'answer'|'escalate'; answer: string | null; confidence: number; reason: string; ts: string }
export interface Supervisor { evaluate(sessionPk: string): Promise<SupervisorDecision>; enabledFor(sessionPk: string): boolean }
```

## 12. Web app conventions
- **Routes** (TanStack Router, file-based under `apps/web/src/routes/`):
  - `/` redirects to `/inbox` from P2 on (`/history` before that)
  - `/history`, `/sessions/$source/$id`, `/live`, `/inbox`, `/worktrees` (P4), `/review/$source/$id` (P4), `/streams` and `/streams/$ticket` (P5), `/analytics` (P5), `/audit` (P3), `/automations` (P7), `/compare/$groupId` (P7), `/settings`
- **Global layout:** `apps/web/src/features/shell/AppShell.tsx`:
  - top bar with the project selector (F13), a search box and the inbox count
  - left nav
  - a resizable bottom/right terminal dock (`features/terminal/TerminalDock.tsx`)
- **Stores:**
  - `stores/project.ts` → `useProjectStore` `{ projectId, setProjectId }`, persisted in localStorage
  - `stores/terminals.ts` → `useTerminalStore` `{ tabs: {ptyId,title}[], active, open(ptyId,title), close(ptyId) }`
- **API access** only through hooks in `api/queries/*.ts`: `useSessions(filters)`, `useSession(source,id)`, `useSessionEvents(...)`, `useLive()`, `useInbox(filters)`, etc. The WS hook `useLiveEvents()` is mounted once in `AppShell` and applies cache updates.
- **Tests:** component tests with Testing Library and an MSW-free fake client (`api/client.ts` exports `setApiClientForTests`). E2E runs with Playwright against the daemon started on fixtures (`apps/web/e2e/*.spec.ts`, via `pnpm --filter @orc/web e2e`).

## 13. Symbol ownership & de-duplication

The phase plans were written in parallel, so several symbols appear in more than one plan. **The owning phase creates the file. A later phase that needs a different shape MODIFIES the owner's file (its task lists the file under `Modify:`) and never re-creates the symbol.** Before creating any exported symbol, check this table.

| Symbol | Canonical owner & location | Rule for later phases |
|---|---|---|
| `RegistryEntry`, `parseRegistryFile`, `registryStatusToLive`, `isRegistryFileName` | **P1** `packages/core/src/claude/registry.ts` | The canonical shape is the **P2 superset**: `{ pid, procStart: string \| null, sessionId, cwd, startedAt: number \| null, version, kind, name, status: RegistryStatus \| null, waitingFor, statusUpdatedAt: number \| null, updatedAt: number \| null }` with `export type RegistryStatus = 'busy'\|'idle'\|'waiting'\|'shell'`. P1 implements that shape and exports both `parseRegistryEntry` and the alias `parseRegistryFile`. P2 adds only `isRegistryFileName`. Neither ever copies `messagingSocketPath`. |
| `isTestCommand`, `parseTestOutput` | **P1** `packages/core/src/derive/tests.ts` | P2 imports them; its Task 3 covers stage inference only. |
| `splitPk`, `sessionPk` | **P1** `apps/daemon/src/db/keys.ts` (re-exported from `services/sessions.ts`) | P2/P4/P7 import. |
| `slugify` | **P1** `packages/core/src/derive/name.ts` — `slugify(name: string): string` for project ids | P4's branch slug is a **different** function: `slugifyBranch(text: string, maxLen = 30)` in `packages/core/src/git/branch.ts`. |
| `shellQuote` | **P1** `apps/daemon/src/services/sessions/external.ts` — `shellQuote(parts: string[]): string` | P5 needs single-argument quoting: name it `quoteArg(s: string): string` in `apps/daemon/src/services/hooks/install.ts`. |
| `permissionBadge`, `PermissionBadge` | **P3** `packages/core/src/derive/prod.ts` — `permissionBadge(modes: readonly (string \| null \| undefined)[]): PermissionBadge` | P2's card helper takes one mode: name it `badgeForMode(mode: string \| null)` in `apps/web/src/features/live-board/format.ts`, or call the P3 function with `[mode]` once P3 has shipped. |
| `createLiveReducer`, `LiveReducer`, `TranscriptLive` | **P2** `packages/core/src/derive/live-transcript.ts` | P5 extends the options (`windows`) by **modifying** that file; its context-window table lives in config. |
| `registerHookRoutes`, `mapHookToStatus` | **P2** `apps/daemon/src/http/routes/hooks.ts` (minimal ingest) | P5 replaces the body by **modifying** the same file; the route path stays `POST /api/hooks`. |
| `redactSnippet`, `redactValue`, `redactSession`, `redactListItem` | **P1** `apps/daemon/src/http/redact-out.ts` | P2/P3 extend by modifying that file. P3 adds `redactDeep`/`redactPartialTokens` in `packages/core/src/redact/redact.ts`. |
| `ApiRequestError` | **P1** `packages/api-contract/src/client.ts` | P2/P3 must use it. `ApiCallError` is not a separate class; delete that name where a plan uses it. |
| `ConfirmBody` | **P2** `packages/api-contract/src/routes/common.ts` | P4 (`Confirm`), P6 and P7 import `ConfirmBody`. |
| `PrRefSchema`, `PrStatusSchema` | **P1** `packages/api-contract/src/routes/sessions.ts` (PrRef), **P4** `routes/ship.ts` (PrStatus) | P4/P5/P7 import; never redeclare. |
| `UsageSchema`, `SessionSchema`, `TimelineEventSchema`, `AgentNodeSchema` | **P1** `packages/api-contract/src/routes/sessions.ts` | All later phases import. |
| `LaunchRequest`, `LaunchResponse`, `Template` | **P2** `packages/api-contract/src/routes/launch.ts` / `templates.ts` | P4 and P7 extend `LaunchRequest` by modifying that file (P4 enables `planApproval`/`worktree`, P7 enables `compare`). |
| `PrStatus` (domain type) | **P4** `packages/core/src/types/work.ts` | The `connectors/github/github.ts` file re-exports it; §11's inline copy is superseded by P4's (adds `headRef`, `failedChecks`). |
| `createLinearAssignedPoller`, `createSlackMentionPoller` | **P6** `apps/daemon/src/connectors/{linear,slack}/poller.ts` | P7 imports them for automation triggers. |
| `LIVE_EVENT_TYPES` | **P2** `apps/daemon/src/http/live-ws.ts` | Every later phase that adds a `LiveEvent` variant appends to this array in the same file (P3 `audit.recorded`; P4 `worktree.updated`, `worktree.removed`, `pr.updated`, `checkpoint.created`; P5 `usage.updated` payload typing). |
| `Route`, `OrcApp`, `registerXRoutes` | **P1** `apps/daemon/src/http/app.ts` | The `Route`/`OrcApp` types are declared once in P1; each phase adds its own `registerXRoutes(app: OrcApp, ctx: DaemonContext)` file. |
| `DaemonContext`, `buildContext`, `createDaemon`, `ServiceError` | **P1** `apps/daemon/src/context.ts`, `services/errors.ts` | Later phases add optional fields to `DaemonContext` by modifying that file (see §11). |
| `CORE_VERSION`, `FIXTURES_DIR` | **P0** `packages/core/src/index.ts`, `src/test-utils/fixtures.ts` | P1 reuses them. |
| `encodePaste`, `sendText` | **P0** spike `spikes/s2-pty/send-text.ts` (throwaway) → **P1** `apps/daemon/src/pty/input.ts` (real) | P1 copies the validated algorithm from the spike report; the spike file is not imported by the build. |
| `SessionDetailPage` and any other web page component | The phase that **creates** the route file owns it (P1 for `/sessions/$source/$id`) | P3 and later **modify** it; they never create a second component with the same name. |
| `useInboxKeys` | **P2** `apps/web/src/features/inbox/keys.ts` | P3 modifies it to register through the `hotkeys` registry. |
| Web formatting helpers: `formatDuration`, `formatTokens`, `formatCost`, `shortPath`, `toolLabel`, `hasDrift` | **P1** `apps/web/src/lib/format.ts` | Every later phase imports from there and adds new helpers to the same file. |
| Stats helpers `median`, `percentile` | **P3** `packages/core/src/derive/stats-math.ts` | P5/P7 import. |
| Test factories: `makeSession`, `makeInboxItem`, `createFakePty`, `fakeApi`, `fakeSessions`, `fakeProjects`, `fakeInbox`, `makeQueryClient`, `ev`, `need` | **Daemon:** P1 `apps/daemon/test/factories.ts`; **web:** P1 `apps/web/src/test/factories.ts` | Each later phase adds new factories to those files and imports the existing ones instead of redefining. `createTestContext`/`useTempHomes` stay in `apps/daemon/test/helpers.ts`. |

| `ApiCallError` | — (does not exist) | P2/P3 use **P1**'s `ApiRequestError`. Delete the name wherever a plan mentions it. |
| `AppOptions`, `createApp`, `getToken` | **P1** `apps/daemon/src/http/app.ts`, `apps/web/src/api/client.ts` | P6 extends them by modifying those files: `AppOptions` gains the remote guard, and `getToken()` delegates to `resolveToken()` in `api/token.ts`. |
| `BusEvent`, `LiveEvent` | **P1** `apps/daemon/src/live/event-bus.ts`, `packages/api-contract/src/live.ts` | Every later phase appends variants to the same unions in those files (P4 worktree/PR/checkpoint, P5 `config.changed` and the typed `usage.updated`, P6 Linear/Slack/away, P7 automation/supervisor/compare). P6 owns `linear.issueChanged` and `slack.mention`; P7 imports them instead of re-adding them. |
| `DEFAULT_TICKET_REGEX` | **P1** `packages/core/src/derive/tickets.ts` | P4 imports it. |
| `resumeCommand`, `resumeCommandLine` | **P1** `apps/daemon/src/services/sessions/external.ts` | P2 and P7 import; P7's compare/automation launches go through `spawnClaudeSession`. |

**Execution rule:** when a task says "Create" for a file that an earlier phase already created, the executor changes it to "Modify", keeps the existing exports, and adapts the surrounding code. If the two shapes genuinely conflict, the **later** phase adapts to the earlier one unless this table says otherwise, and the change is noted in the task's review note.

## 14. Spike outcomes that bind later phases

Phase 0's spikes settled several questions the phase plans left open. These override the plan text where they differ.

| Spike | Outcome | What it binds |
|---|---|---|
| **S1** parser | GO. 968 files / 852 MB / 210,285 lines parsed in 3.3 s, 0 bad JSON, 0 partial files, **0 unknown record types** (Claude Code 2.1.275). | The `classifyClaudeRecord` type lists are complete for this version. `docs/04-data-sources.md`'s claim that a tool result needs `toolUseResult` **and** `sourceToolAssistantUUID` is wrong: all 42,408 records with `toolUseResult` also have the UUID, and the 808 with only the UUID carry a `tool_result` content block and classify correctly. `records.ts` stands as written. |
| **S3** live status | GO, **watch-only**. Live transitions detected in 3–107 ms (median 27, n=6). | Phase 2 builds the Live Board on the chokidar registry watcher alone; the hook bridge (F10) stays a Phase 5 optimisation. Registry reads must swallow `ENOENT`/parse errors (partial writes are normal). `statusUpdatedAt` is status *age* at first scan, not a detection delay. A `waiting` transition was never observed in the window — Phase 2 must measure that case and record it. |
| **S5** codex | Rollouts parse cleanly; originators observed: `codex_exec`, `codex_sdk_ts`, `codex-tui`, `Codex Desktop`. | Phase 1's Codex aggregate filters `codex_sdk_ts` by default (decision 3). The `automated` flag keys on originator. |
| **S7** quota | **official** source found. | `LimitsConfig.quotaSource` defaults to `'official'`, with `officialFieldPaths` defaulting to `rate_limits.five_hour.used_percentage`, `rate_limits.five_hour.resets_at`, `rate_limits.seven_day.used_percentage`, `rate_limits.seven_day.resets_at`. These arrive on the **statusline command's stdin JSON**, so Phase 5's `POST /api/usage/official` is fed by the orchestrator statusline wrapper. The ccusage-style estimator stays as the labelled-"estimated" fallback for when no statusline is installed. Phase 5 must not overwrite a user's existing statusline — it merges or wraps. |
| **S6** Wakecore | **BLOCKED** pending `gh auth refresh -s read:packages`. | Phase 1's `@/components/ui/*` re-export layer starts on the **shadcn/ui fallback** so Phase 1 is not blocked. Swapping to `@wakecap/core-ui` later touches only that layer. |
| **S2/S8** PTY | pending (Task 6). | Phase 1's `PtyManager.sendText` and the resume UX depend on it. |
