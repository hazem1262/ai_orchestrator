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
| react / react-dom | `^19.3.0` |
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

**UI kit:** **shadcn/ui** — primitives copied into `apps/web/src/components/ui/` and owned by this repo (MIT, no registry auth, no private dependency). All UI code imports from `@/components/ui/*` and never from a vendor path, so swapping kits later touches that one folder and nothing else.

## 2. Repository layout

```
orchestrator/
├─ package.json                 # private root; scripts: build, test, lint, typecheck, dev
├─ pnpm-workspace.yaml          # packages: apps/*, packages/*
├─ tsconfig.base.json           # strict, ES2023, moduleResolution "bundler", verbatimModuleSyntax
├─ biome.json
├─ vitest.config.ts             # root config; uses `test.projects` to run packages/* and apps/*
├─ .nvmrc  .gitignore  .npmrc
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
  tool: string | null;           // e.g. 'Bash', 'mcp__claude_ai_Linear__save_issue'; for kind:'system' events
                                  // synthesized from `command`/`compact_summary` Claude records, `tool` is
                                  // the literal string 'command' or 'compact_summary' (P1, Task 2 ruling —
                                  // these are NOT human prompts: they never increment promptCount and never
                                  // seed firstPrompt/lastPrompt/name, but they render distinctly in the
                                  // timeline via this tool value)
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

P1's route table below is the **as-built** shape (reconciled at the phase 1 exit — the code is
authoritative over the plan text it was written against):

```
P1  GET    /api/health                               → { ok, version, uptimeS }
P1  GET    /api/projects                             → Project[]
P1  GET    /api/projects/:id                          → ProjectConfig                          (Task 15 addition — was missing from the original table)
P1  PATCH  /api/projects/:id                         body ProjectUpdate (Partial<ProjectConfig> minus `features`, which is itself Partial)
P1  GET    /api/sessions?q&projectId&source&ticket&pr&from&to&model&minCost&maxCost&skill&hasSubagents&touchedProd&availability&label&pinned&includeHidden&includeAutomated&limit&cursor
                                                     → { items: SessionListItem[]; nextCursor: string | null }
                                                     (SessionListQuery gained `label`, `pinned`, `includeHidden`, `includeAutomated` beyond the original plan — all brief-mandated, additive)
P1  GET    /api/sessions/:source/:id                 → Session
P1  GET    /api/sessions/:source/:id/events?agentId&afterSeq&limit → { items: TimelineEvent[]; nextSeq: number | null }
P1  GET    /api/sessions/:source/:id/agents          → AgentNode[]
P1  POST   /api/sessions/:source/:id/resume          body ResumeRequest { mode: 'embedded'|'external'; fork?; popOut?; cols?; rows? } → ResumeResponse ({ ptyId } | { launched: 'external'; command: string })
                                                     (ResumeRequest gained `popOut`, `cols`, `rows` beyond the original plan — all brief-mandated, additive; all four write-body schemas are `z.strictObject`, see §13)
P1  POST   /api/sessions/:source/:id/pin             body { pinned: boolean } → { pinned: boolean }
P1  POST   /api/sessions/:source/:id/label           body { labels: string[] } → { labels: string[] }
P1  GET    /api/labels                               → string[]                                (not in the original route table)
P1  GET    /api/views                                → SavedView[]                              (not in the original route table)
P1  POST   /api/views                                body { name; query: Record<string,string> } → SavedView
P1  DELETE /api/views/:id                            → { ok: true }
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
  | { type: 'session.indexed'; pk: string }   // P1: emitted by the indexer whenever a session's rows change (new file, append, truncation-recovery re-read); daemon-internal only, not on the /ws LiveEvent wire
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
  remove(id: string): void;        // P1 addition: drops a PTY's entry (e.g. after DELETE /api/pty/:ptyId once exited)
  disposeAll(): void;              // P1 addition: kills every live PTY, used on daemon shutdown (close())
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
// As-built P1 note: there is NO `sessions.owned_by_app` column anywhere in the schema (§5's
// `sessions` table has no such column) — ownership ('observed' | 'owned', see §4's `Ownership`
// type) is a route/service-level concept computed from whether a live PtyInfo exists for the
// session's pk, not a persisted column. §11's DaemonContext note that implied a column was wrong;
// reconciled at the phase 1 exit (Task 6/20 ruling).
export interface DaemonContext {
  paths: OrcPaths;
  config: () => OrcConfig;                 // live getter (config can change at runtime)
  db: OrcDb;
  bus: EventBus;
  log: import('pino').Logger;
  pty: PtyManager;                         // P1
  sessions: SessionService;                // P1
  projects: ProjectServiceImpl;            // P1 — as-built name; ProjectService is the narrower public interface it extends (see below)
  userMeta: UserMetaService;               // P1 — pins/labels/saved views; not anticipated by the original §11 draft
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
// P1 — apps/daemon/src/services/sessions.ts (as-built; SessionListQuery/ResumeRequest gained fields beyond the original plan — see §6)
export interface SessionListQuery { q?: string; projectId?: string; source?: Source; ticket?: string; pr?: string; from?: string; to?: string; model?: string; minCost?: number; maxCost?: number; skill?: string; hasSubagents?: boolean; touchedProd?: boolean; availability?: Availability; label?: string; pinned?: boolean; includeHidden?: boolean; includeAutomated?: boolean; limit?: number; cursor?: string }
export interface SessionListItem { pk: string; source: Source; id: string; projectId: string | null; name: string | null; firstPrompt: string | null; lastPrompt: string | null; recap: string | null; startedAt: string; lastActivityAt: string; durationMs: number; costUsd: number | null; tickets: string[]; prs: PrRef[]; availability: Availability; pinned: boolean; labels: string[]; live: LiveState | null; snippet: string | null }
export interface SessionService {
  list(q: SessionListQuery): { items: SessionListItem[]; nextCursor: string | null };
  get(source: Source, id: string): Session | null;
  getByPk(pk: string): Session | null;
  events(source: Source, id: string, opts: { agentId?: string | null; afterSeq?: number; limit?: number }): { items: TimelineEvent[]; nextSeq: number | null };
  agents(source: Source, id: string): AgentNode[];
  setLive(pk: string, live: LiveState | null): void;      // emits session.updated
  resume(source: Source, id: string, opts: { mode: 'embedded' | 'external'; fork?: boolean; popOut?: boolean; cols?: number; rows?: number }): Promise<{ ptyId: string } | { launched: 'external'; command: string }>;
}
export const sessionPk = (source: Source, id: string) => `${source}:${id}`;

// P1 — apps/daemon/src/services/user-meta.ts (as-built; not anticipated by the original plan)
export interface UserMetaService {
  setPinned(pk: string, pinned: boolean): boolean;
  setLabels(pk: string, labels: string[]): string[];
  labels(): string[];
  views(): SavedView[];
  saveView(i: { name: string; query: Record<string, string> }): SavedView;
  deleteView(id: string): boolean;
}

// P1 — apps/daemon/src/services/external.ts (as-built home for the resume/launch external-process helpers; §13's `shellQuote`/`resumeCommandLine` entries point here)
export type ExternalLauncher = (i: { cwd: string; command: string; args: string[]; openIn: 'vscode' | 'terminal' | 'finder' }) => Promise<void>;
export function createExternalLauncher(run?: CommandRunner): ExternalLauncher

// P1 — apps/daemon/src/indexer/indexer.ts (as-built; not in the original §11 draft)
export interface Indexer {
  scanAll(): Promise<{ files: number; sessions: number; ms: number }>;
  indexFile(path: string): Promise<void>;
  watch(): Promise<void>;
  close(): Promise<void>;
  unknownTypes(): Record<string, number>;
  reconcile(): Promise<{ swept: number; skipped: number }>;   // periodic reconciliation backstop against a dropped chokidar event, see Task 10's "Flake fix"
}
export function createIndexer(deps: { db: OrcDb; raw: Database.Database; paths: OrcPaths; projects: ProjectServiceImpl; bus: EventBus; log: Logger; debounceMs?: number; reconcileMs?: number }): Indexer

// P1 — apps/daemon/src/context.ts (as-built)
export function buildContext(o: { paths: OrcPaths; log?: Logger; launchExternal?: ExternalLauncher; isPidAlive?: (pid: number) => boolean }): { ctx: DaemonContext; raw: Database.Database; saveConfig(cfg: OrcConfig): void; close(): void }

// P1 — apps/daemon/src/main.ts (as-built)
export const DEFAULT_WEB_DIST: string;   // apps/web/dist, resolved relative to the daemon package; serveStatic mounts it at '/' iff it exists and o.webDist isn't explicitly overridden
export interface Daemon { ctx: DaemonContext; indexer: Indexer; token: string; start(o: { port: number; watch?: boolean }): Promise<{ port: number; close(): Promise<void> }> }
export function createDaemon(o?: { paths?: OrcPaths; log?: Logger; launchExternal?: ExternalLauncher; webDist?: string | null }): Promise<Daemon>

// P1 — apps/daemon/src/services/projects.ts (as-built)
/** Partial<ProjectConfig> is assignable; `features` is itself Partial for PATCH semantics. */
export type ProjectUpdate = Omit<Partial<ProjectConfig>, 'features'> & { features?: Partial<ProjectConfig['features']> };
export interface ProjectService { list(): Project[]; resolve(cwd: string): string | null; get(id: string): ProjectConfig | null; update(id: string, patch: ProjectUpdate): ProjectConfig }
export interface ProjectServiceImpl extends ProjectService {
  ensureDefaults(): void;
  ensureDetected(): { added: string[] };
  deriveConfigFor(cwd: string | null): DeriveConfig;
  syncTable(): void;
}   // DaemonContext.projects is typed as ProjectServiceImpl, not the narrower ProjectService — the indexer and other P1-internal callers need the extra methods

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
  - `stores/terminals.ts` → `useTerminalStore` `{ tabs: {ptyId,title}[], active, open(ptyId,title), close(ptyId), setActive(ptyId) }` — `setActive` is a P1 addition over the original draft (switches the focused terminal tab without opening/closing one); persisted to **sessionStorage** (not localStorage — tabs are meant to outlive a reload within the same browser tab, not follow the user across tabs/devices)
- **API access** only through hooks in `api/queries/*.ts`: `useSessions(filters)`, `useSession(source,id)`, `useSessionEvents(...)`, `useLive()`, `useInbox(filters)`, etc. The WS hook `useLiveEvents()` is mounted once in `AppShell` and applies cache updates.
- **PTY transport (P1, as-built — `api/pty-socket.ts`, not in the original §12 draft):**
  ```ts
  export function ptySocketUrl(ptyId: string, token: string, loc: { protocol: string; host: string }): string
  export function connectPty(ptyId: string, h: PtySocketHandlers, o?: { token?: string; WebSocketImpl?: WebSocketCtor; location?: { protocol: string; host: string }; maxDelayMs?: number }): PtySocket
  // PtySocketHandlers: onData(Uint8Array), onExit(code), onStatus?(status), onReset?()
  // PtySocket: send(msg: PtyClientMessage), close()
  ```
  `connectPty` owns reconnect/backoff and realm-safe binary-frame decoding (a plain `instanceof ArrayBuffer`/`DataView` check fails across a jsdom-vs-Node realm boundary — Task 18's fix round; see the tag-based `toBytes()` helper).
- **P1 web feature directories (as-built):** `features/history/` (F3), `features/session-detail/` (F2), `features/terminal/` (F4 — `TerminalDock.tsx`, `TerminalView.tsx`, `ResumeActions.tsx`), `features/settings/` (F13 project settings), `features/shell/` (`AppShell.tsx`, `ProjectSelector.tsx`).
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
| `encodePaste`, `sendText` | **P0** `packages/core/src/pty/paste.ts` (real, pure module — amended from the brief's original throwaway-spike-file plan; see Task 6 ruling) | The S2 spike server (`spikes/s2-pty/server.ts`, outside the pnpm workspace) imports this module by relative path. P1's `apps/daemon/src/pty/input.ts` wraps it rather than re-implementing it. |
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

| `Indexer`, `createIndexer` | **P1** `apps/daemon/src/indexer/indexer.ts` | Not in the original §11 draft. Later phases that need indexing hooks modify this file rather than creating a parallel indexer. |
| `UserMetaService`, `createUserMetaService` | **P1** `apps/daemon/src/services/user-meta.ts` | Owns pins/labels/saved views (F3). Not anticipated by the original plan; later phases extend by modifying this file. |
| `ExternalLauncher`, `createExternalLauncher`, `resumeCommandLine`, `appleScriptString` | **P1** `apps/daemon/src/services/external.ts` | `resumeCommandLine`/`shellQuote` were originally drafted under `services/sessions/external.ts`; the as-built path is `services/external.ts` (no `sessions/` subdirectory). P2/P7 import from this path. |

**Unknown request-body keys → HTTP 422 everywhere (P1, Task 12 ruling, reconciled at the phase exit).** Every write-body schema (`ResumeRequestSchema`, `PinRequestSchema`, `LabelRequestSchema`, `SaveViewRequestSchema`, `ProjectPatchSchema`) is a `z.strictObject`. `apps/daemon/src/http/json.ts`'s `readJson()` inspects the Zod error: an `unrecognized_keys` issue (a typo'd or extra key) returns **422** `validation_failed`; every other validation failure (wrong type, failed refinement, malformed JSON) returns **400** `validation_failed`. Query-string schemas stay permissive (unknown query params are silently ignored, never 422) — only request bodies are strict. This single rule replaced an earlier inconsistent 400-for-everything convention found during Task 12's review.

**Execution rule:** when a task says "Create" for a file that an earlier phase already created, the executor changes it to "Modify", keeps the existing exports, and adapts the surrounding code. If the two shapes genuinely conflict, the **later** phase adapts to the earlier one unless this table says otherwise, and the change is noted in the task's review note.

## 14. Spike outcomes that bind later phases

Phase 0's spikes settled several questions the phase plans left open. These override the plan text where they differ.

| Spike | Outcome | What it binds |
|---|---|---|
| **S1** parser | GO. 968 files / 852 MB / 210,285 lines parsed in 3.3 s, 0 bad JSON, 0 partial files, **0 unknown record types** (Claude Code 2.1.275). | The `classifyClaudeRecord` type lists are complete for this version. `docs/04-data-sources.md`'s claim that a tool result needs `toolUseResult` **and** `sourceToolAssistantUUID` is wrong: all 42,408 records with `toolUseResult` also have the UUID, and the 808 with only the UUID carry a `tool_result` content block and classify correctly. `records.ts` stands as written. |
| **S3** live status | GO, **watch-only**. Live transitions detected in 3–107 ms (median 27, n=6). | Phase 2 builds the Live Board on the chokidar registry watcher alone; the hook bridge (F10) stays a Phase 5 optimisation. Registry reads must swallow `ENOENT`/parse errors (partial writes are normal). `statusUpdatedAt` is status *age* at first scan, not a detection delay. A `waiting` transition was never observed in the window — Phase 2 must measure that case and record it. |
| **S5** codex | Rollouts parse cleanly; originators observed: `codex_exec`, `codex_sdk_ts`, `codex-tui`, `Codex Desktop`. | Phase 1's Codex aggregate filters `codex_sdk_ts` by default (decision 3). The `automated` flag keys on originator. The report's actual decision also carries: read the Codex SQLite read-only as well; the rollout-mtime<10s process-matching rule is untested under load; and the originator list came from a 5.2% recency-biased sample. |
| **S7** quota | **official** source found. | `LimitsConfig.quotaSource` defaults to `'official'`, with `officialFieldPaths` defaulting to `rate_limits.five_hour.used_percentage`, `rate_limits.five_hour.resets_at`, `rate_limits.seven_day.used_percentage`, `rate_limits.seven_day.resets_at`. These arrive on the **statusline command's stdin JSON**, so Phase 5's `POST /api/usage/official` is fed by the orchestrator statusline wrapper. The ccusage-style estimator stays as the labelled-"estimated" fallback for when no statusline is installed. Phase 5 must not overwrite a user's existing statusline — it merges or wraps. Caveats: n=1 on one Max account; `/usage` parity was never checked; and `rate_limits` may be absent on some plan tiers or before the first API response, so Phase 5 must fall back to the estimator when the field is missing. |
| ~~**S6** Wakecore~~ | **Dropped by the user (2026-09-21):** this is a personal project, so it uses open-source shadcn/ui outright instead of a private work package. The spike's blocked-on-`read:packages` finding is moot. | `@/components/ui/*` is the permanent home of the primitives, not a fallback. |
| **P1 Task 19, redaction boundary** | Not a Phase-0 spike, but binds later phases the same way. Five fix rounds (3, 4, 5, 5b — round 1-2 were the perf fix, unrelated) found and closed **12 distinct raw (unredacted) transcript-text paths** that the original §8/route-layer redaction design believed were already covered: (1) the wide-fan-out `eventSnippet` fallback, (2) the `history_prompts` search-fallback highlight, then five more found by an explicit sweep (`TimelineEvent.tool`, `TimelineEvent.mcpServer`, `AgentNode.agentType`, `Session.cwds`, `Session.mcpServers`), then five more found by an *adversarial* re-verification of that sweep (`Session.startCwd`, `Session.skills[]`, `Session.filesTouched[]`, `Session.live.waitingFor`, `Session.tickets[]`/`SessionListItem.tickets[]`). The final boundary is `apps/daemon/src/http/redact-out.ts`'s `redactSession`/`redactListItem`/`redactEvent`/`redactAgent`/`redactSnippet` — every field either routes through `redact()` (a no-op on ordinary values, so tickets/paths/skill names stay matchable) or is deliberately excluded with a stated reason (`transcriptPath` — daemon-derived; `labels`/saved-view/project names — user-authored in-app; `models`/`permissionMode` — fixed vocabularies; `prs` — extraction unimplemented this phase). **Two of the 12 were a redact/truncate ORDER bug** (`highlight()` truncates by raw character offset, so a naive `redact(highlight(text))` can bisect a secret pattern across the truncation boundary and let it survive) — fixed once via a shared `redactedHighlight(text, needle, radius) = highlight(redact(text), needle, radius)` helper in `services/snippet.ts`. **The lesson recorded for later phases:** each round's manual sweep table missed fields the next round's exhaustive guard test found — the guard test (one seeded secret-bearing session + subagent + history-prompt row, checked against all four session-returning routes at once) is what actually holds this boundary, not the sweep table. Any new fallback path added to `sessions.ts`'s `list()` must default to `redactedHighlight()` rather than assuming the route-layer pass will catch it. **AMENDED BY P2 TASK 8 (fix rounds 1-2)** — see the row below. |
| **P2 Task 8, redaction boundary (amends the row above)** | The exhaustive guard test the row above calls "what actually holds this boundary" **did not exist** — it was cited in rulings from Task 1 onward and was first written in P2 Task 8 (`apps/daemon/src/http/redact-out.test.ts`). Writing it, and two adversarial review rounds on it, changed four things that bind later phases. **(1) Three of the P1 exclusions are reversed.** `labels`, saved-view names/queries and project *list* names/`pathPrefixes` are now redacted, and so are `models`, `permissionMode`, `transcriptPath`, `prs[].repo`/`url`, `LiveState.currentTool`, `TimelineEvent.model` and `AgentNode.transcriptPath`. "User-authored in-app" is not a safety property: a user pastes a token into a label, and `pathPrefixes` are literally the cwd prefixes `Session.startCwd` is redacted for. `redact()` is a no-op on ordinary values, so nothing user-facing changed. **(2) One deliberate exception remains, `GET /api/projects/:id` and its `PATCH`**, because they are the settings editor's round trip: a tag written into the GET is PATCHed back into the user's own `config.json`, where `firstRelativePrefix` rejects `«redacted:…»` as non-absolute and the user can no longer save. The exposure is the whole `ProjectConfig`, including `repos[].setup`/`run`/`archive` — user-authored shell command lines. Nothing displays or forwards them today; the fix when that changes is to redact the GET and make PATCH treat any incoming field still containing `«redacted:` as "unchanged". **(3) Redaction is no longer value-only.** `redactValue` is key-aware (a key naming a credential redacts its value whatever the value looks like), carries that flag down through nested objects, handles the `{name,value}`/`{key,value}` pair form, and redacts object keys as well as values — because `redact()`'s patterns need `KEYWORD=VALUE` inside ONE string and JSON splits the two apart, so `{"env":{"PGPASSWORD":"hunter2"}}` was served raw. It over-redacts `*token*` keys; `usage.updated` is the one wire shape whose subject is token counts and may need its own redactor. **(4) Error bodies are part of the boundary.** `ServiceError.message` and `.details` are redacted in `app.ts`'s `onError`; `cwd_missing` was serving `startCwd` raw. The guard is now a chain — routes (registered only via `registerAllRoutes`) → census → redactor → schema walk → route-level sentinel test in `app.test.ts` — and every link fails closed. **Any new response shape or route in phases 3+ must be added to the census in the same task that introduces it.** |
| **P1 Task 14, browser type-import boundary** | Not a spike — a deliberate P1 tradeoff recorded here per the ledger's explicit instruction. `apps/web/tsconfig.json` keeps `types: ["vite/client", "node"]` rather than rewriting every `apps/web` and `api-contract` type-only import to a `@orc/core/browser` subpath entry point. This means `apps/web`'s **typecheck** can see `@types/node` (TS type-checks the whole transitive graph reached by any `import type` from the full `@orc/core` barrel, and contracts §11 sanctions importing types from that barrel), so a careless future `import { readFile } from 'node:fs'` in a web component would typecheck — it is only the Vite **build** that would catch it (verified: the built `apps/web/dist` bundle greps clean for `node:` imports). If a later phase wants strict per-file browser/Node isolation enforced at typecheck time, that is a phase-level decision to point `api-contract` and `apps/web` at `@orc/core/browser` everywhere — a five-site change across two packages (three in `api-contract`, two in brief-authored `apps/web` files), not attempted in P1. |
| **P1 Task 19, search-perf cardinality cap** | A synthetic-then-real two-stage tuning exercise, not a spike, but the empirical constant it produced binds the search-quality/perf tradeoff for later phases. `toFtsQuery` prefix-matches only the *last* (still-being-typed) token of a query, 3+ characters; every earlier token becomes an exact term. FTS5's native `snippet()` cost scales with the prefixed token's *matched-term cardinality*, not row count — a synthetic worst case (a numbered vocabulary where one 4-char prefix matched ~1,111 of 3,000 terms) took ~4s per search before this was found. Above `FTS_PREFIX_CARDINALITY_CAP = 250` (`apps/daemon/src/services/sessions.ts`), a search skips native `snippet()` and highlights the raw row text in application code instead (via `redactedHighlight`, so the secret-leak fix applies uniformly). **250 is empirical, not derived**: measured directly against the real `~/.claude`/`~/.codex` corpus's actual term cardinality and `snippet()` cost per common English 3-character prefix (`con`→489 terms/188ms was the one real-world case that exceeded the 150ms budget; every measured case ≤244 terms stayed under ~75ms). Real-text cost is **not monotonic in cardinality alone** (`con` cost 4-6x more than `get` at nearly the same cardinality) — a future corpus with different vocabulary characteristics could still occasionally exceed the cap's safety margin; the perf suite's gated per-shape assertions (not this cap alone) are the regression backstop. Phase 2+ should re-measure this cap if the indexed corpus's vocabulary shape changes materially (e.g. adding a new source with very different token distributions). |
| **S2/S8** PTY | Scripted input **50/50** complete and in order; send-while-busy is queued by Claude's own TUI (not garbled); multi-line arrives as one prompt. `submitDelayMs` 120 ms works, and no idle detection is needed before sending. Browser render, typing, resize and scrollback replay all verified in headless Chrome. **GO.** | `encodePaste`/`sendText` live in `packages/core/src/pty/paste.ts`; Phase 1's `apps/daemon/src/pty/input.ts` wraps that module. **Two Phase 1 setup gotchas:** (1) node-pty 1.1.0's darwin-arm64 prebuild ships `spawn-helper` without the executable bit, and every `pty.spawn()` fails until it is `chmod +x`'d — the daemon package needs a postinstall step. (2) **A child session inherits `CLAUDE_CODE_CHILD_SESSION` and then writes NO transcript.** `PtyManager.spawn()` must delete that marker from the child env and set `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`, with a test asserting it; otherwise every session the app launches is invisible to its own indexer. |
