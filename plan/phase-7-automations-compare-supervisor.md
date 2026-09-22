# Phase 7 — Automations, Compare, Supervisor, AGNC, MCP Server & Desktop Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Symbol ownership:** before creating any exported symbol, check `00-contracts.md` §13. Where two phases touch the same symbol, the owning phase creates the file and later phases modify it instead of redefining.

**Goal:** Deliver milestone M7: automations that run on a schedule or on GitHub/Linear/Slack events (F20), compare mode across agents (F21), an opt-in supervisor that answers routine questions (F23), optional AGNC sessions (F11/S4), an Orchestrator MCP server, and a Tauri 2 desktop shell (F12 picks). Each of these can be turned off, is bound by budget and deny-list, and is audited.

**Architecture:** Everything runs inside the existing daemon (`apps/daemon`) as new services attached to `DaemonContext`. Automations run `claude -p --output-format stream-json` (headless) or an owned PTY, guarded by the shared deny-list, `UsageMeter` budgets, a per-automation monthly budget, a concurrency cap and a restricted Claude tool set that never allows merges. The supervisor applies rules first, then a Haiku 4.5 classifier through `claude -p`, and only sends canned allow-listed answers to owned sessions. The MCP server (`apps/mcp`) and the Tauri shell (`apps/desktop`) are thin clients of the daemon HTTP API.

**Tech Stack:** Node 22, TypeScript ~6.0.3, Hono 4, Drizzle + better-sqlite3, execa 10, croner 10, zod 4, @modelcontextprotocol/sdk 1.30, React 19 + TanStack Query/Router, Vitest 5, Tauri 2 (Rust, `tray-icon`, `tauri-plugin-shell`, `tauri-plugin-notification`, `tauri-plugin-global-shortcut`).

**Spec:** `docs/02-features.md` (F20, F21, F23, F11 AGNC row, F12), `docs/03-architecture-and-stack.md` (flows 4, 7, 10, 11; "Later": Tauri, MCP server; Security & privacy), `docs/04-data-sources.md` §C (AGNC), `docs/05-roadmap.md` (M7, spike S4, Risks), `docs/06-landscape-and-inspiration.md` (Jules suggested tasks, Codex attempts, agent-deck conductor), `plan/00-contracts.md` (§3, §5, §6, §7, §11).

## Global Constraints
- Node `>=22.12 <23`; pnpm `10.18.3`; TypeScript `~6.0.3` strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`; Biome 2 (`noNonNullAssertion` and `noExplicitAny` are errors); Vitest 5.
- The daemon binds to `127.0.0.1` only. Every `/api/*` request needs `x-orc-token`. The only new unauthenticated path is `GET /oauth/agnc/callback`, which must validate the OAuth `state`.
- **Automations and the supervisor never merge, deploy, touch prod or run destructive git commands.** They never call `ShipService.merge`. Tests enforce this (Task 4 and Task 17).
- **Input only to owned sessions.** The supervisor sends text only when `LiveState.ownership === 'owned'` and `LiveState.ptyId` is set. Claude's `messagingSocketPath` is never used.
- **Budgets and deny-list are enforced before every automation run, every approval and every supervisor answer**, with tests.
- **Everything is audited** through `AuditService.record()` (P3 `createAuditService`) with actor `automation`, `supervisor` or `user`. Every new non-GET `/api` route is added to `AUDITED_ROUTES` or, when the service already audits it with richer parameters, to `NON_ACTION_ROUTES` — P3's `audit.coverage.test.ts` enforces this.
- **Off by default:** `automations.enabled = false`, each automation `enabled = false` on creation, `supervisor.enabled = false`, `agnc.enabled = false`. The MCP server and desktop shell are opt-in installs.
- **Redaction:** text sent to the classifier, stored in inbox payloads, returned by run-log endpoints, or posted anywhere goes through `redact()` first.
- Never write to `~/.claude` or `~/.codex`. Headless runs create normal transcripts through the `claude` CLI itself; the daemon never writes them.
- Zod 4: nested config objects use `.prefault({})`, not `.default({})`. Verified with zod 4.6.5: `.default({})` returns `{}` without applying the inner defaults.
- `claude` CLI flags verified against `claude --help` (2.1.274): `-p`, `--output-format stream-json` (needs `--verbose`), `--model`, `--permission-mode <acceptEdits|plan|…>`, `--permission-prompts none`, `--allowed-tools`/`--disallowed-tools` (variadic), `--max-budget-usd`, `--session-id <uuid>`, `--resume`, `--tools ""`, `--no-session-persistence`, `--safe-mode`. **There is no `--max-turns` flag.** Automations use `timeout` plus `--max-budget-usd` instead. Variadic flags would swallow a positional prompt, so headless prompts go through **stdin**, and PTY prompts come after `--`.
- Commits follow Conventional Commits with a scope. `pnpm lint && pnpm typecheck && pnpm test` passes before every commit.
- Branch: `phase/7-automations-compare-supervisor`. Sub-parts 7B–7F depend only on Task 1 and may be executed and merged in any order after it. Within 7A, the tasks run in order.

---

> **⚠ SUPERSEDED CALL SHAPE — read before implementing any inbox rule in this phase.**
> Phase 2 Task 9 moved dedupe-key composition into the InboxEngine (contracts §11). Callers no
> longer pass a `dedupeKey` string, and no task may declare its own key helper — the unique index
> is on the literal key, so a hand-written key shared by two scopes makes the second item vanish
> with no error anywhere.
>
> Everywhere below that shows `inbox.upsert({ …, dedupeKey: '…' })`, pass a scope instead:
> `inbox.upsert({ kind, scope: { session } | { project } | { ticket } | { domain, id } | { global: true }, facet?, … })`.
> Everywhere that shows `inbox.resolve('<string>')`, pass `{ kind, scope, facet? }`.
> Local helpers such as `prKey`/`planKey` are removed — use `{ domain: 'pr', id: … }` etc.
> `InboxItem.dedupeKey` is unchanged, so assertions reading it stay valid; compose the expected
> value with `inboxDedupeKey({ kind, scope })` rather than writing the string.

## Contract additions

These are merged into `plan/00-contracts.md` in Task 25.

```ts
// §1 — new dependencies
// apps/desktop (Rust): tauri 2 (feature "tray-icon"), tauri-build 2, tauri-plugin-shell 2, tauri-plugin-notification 2,
//   tauri-plugin-global-shortcut 2, reqwest 0.12 (json, rustls-tls), tokio 1 (time), serde 1, serde_json 1
// apps/desktop (npm): @tauri-apps/cli ^2.11.4
// apps/mcp (npm): @modelcontextprotocol/sdk ^1.30.0, zod ^4.6.5

// §2 — repository layout
//   apps/mcp/        # @orc/mcp — stdio MCP server `orc-mcp` (thin client of the daemon HTTP API)
//   apps/desktop/    # @orc/desktop — Tauri 2 shell; daemon runs as sidecar `orc-node` + resources/daemon
// apps/daemon/src/services/: automations/, compare/, supervisor/, git/, launch/  (new folders)

// §3 — OrcConfig additions (packages/api-contract/src/config.ts)
automations: z.object({
  enabled: z.boolean().default(false),                       // master switch
  maxConcurrent: z.number().int().positive().default(2),
  suggestions: z.object({ enabled: z.boolean().default(false), intervalMin: z.number().int().positive().default(60) }).prefault({}),
}).prefault({}),
supervisor: z.object({
  enabled: z.boolean().default(false),                       // master switch
  model: z.string().default('claude-haiku-4-5'),
  confidenceThreshold: z.number().min(0).max(1).default(0.85),
  maxPerSessionPerHour: z.number().int().nonnegative().default(3),
  maxPerHour: z.number().int().nonnegative().default(10),
  monthlyBudgetUsd: z.number().nonnegative().default(5),
  quietHours: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }).nullable().default(null),
  debounceMs: z.number().int().nonnegative().default(3000),
}).prefault({}),
compare: z.object({ maxVariants: z.number().int().min(2).max(6).default(4) }).prefault({}),
agnc: z.object({
  enabled: z.boolean().default(false),
  url: z.string().default('https://agnc.wakecap.ai/mcp'),
  pollSeconds: z.number().int().positive().default(30),
}).prefault({}),

// Environment variables (daemon): ORC_NOTIFY_BRIDGE=stdout (desktop shell), ORC_WEB_DIR=<dir> (static web root override)
// Environment variables (orc-mcp): ORC_HOME, ORC_PORT, ORC_URL, ORC_TOKEN

// §4 — audit action names (added)
// automation.approve, automation.reject, compare.launch, compare.pick, compare.archive,
// supervisor.escalate, supervisor.feedback, supervisor.rule, agnc.prompt, agnc.create, agnc.connect, settings.update

// §5 — tables (phase 7), owned by this phase
// automations, automation_runs (unique (automation_id, trigger_key)), automation_suggestions (unique dedupe_key),
// compare_groups, supervisor_rules, supervisor_decisions, supervisor_targets (pk (target_type, target_id))

// §6 — routes (P7)
P7  GET    /api/automations                          → AutomationWithStats[]
P7  POST   /api/automations                          body AutomationInput → Automation
P7  GET    /api/automations/settings                 → AutomationSettings { enabled, maxConcurrent, suggestionsEnabled }
P7  PATCH  /api/automations/settings                 body AutomationSettingsPatch → AutomationSettings
P7  GET    /api/automations/suggestions?state        → Suggestion[]
P7  POST   /api/automations/suggestions/refresh      → { added: number }
P7  POST   /api/automations/suggestions/:id/accept   body { confirm: true } → { ptyId, sessionPk }
P7  POST   /api/automations/suggestions/:id/dismiss  → Suggestion
P7  GET    /api/automations/runs/:runId              → AutomationRunDetail
P7  GET    /api/automations/runs/:runId/log          → { lines: string[] }            (redacted)
P7  POST   /api/automations/runs/:runId/approve      body { confirm: true } → AutomationRunDetail (202, continues in background)
P7  POST   /api/automations/runs/:runId/reject       → AutomationRunDetail
P7  POST   /api/automations/runs/:runId/rerun        → AutomationRunDetail | { deduped: true }
P7  GET    /api/automations/:id                      → AutomationWithStats
P7  DELETE /api/automations/:id                      body { confirm: true }
P7  POST   /api/automations/:id/enabled              body { enabled: boolean } → Automation
P7  POST   /api/automations/:id/run                  → AutomationRunDetail (202)
P7  GET    /api/automations/:id/runs                 → AutomationRunDetail[]
P7  POST   /api/compare                              body LaunchRequest (compare required) → CompareGroup (201)
P7  GET    /api/compare/estimate?projectId&n         → CompareEstimate
P7  GET    /api/compare/:groupId                     → CompareView
P7  POST   /api/compare/:groupId/winner              body { index } → { group: CompareGroup; reviewUrl: string }
P7  POST   /api/compare/:groupId/archive-losers      body { confirm: true } → ArchiveLosersResult
P2* POST   /api/sessions/launch  — when body.compare has ≥ 2 entries → 201 { compareGroupId: string }
P7  GET    /api/supervisor/status                    → SupervisorStatus
P7  PATCH  /api/supervisor/settings                  body SupervisorSettingsPatch → SupervisorStatus
P7  GET    /api/supervisor/targets                   → SupervisorTarget[]
P7  PUT    /api/supervisor/targets                   body SupervisorTarget → SupervisorTarget
P7  GET    /api/supervisor/rules                     → SupervisorRule[]
P7  POST   /api/supervisor/rules                     body SupervisorRuleInput → SupervisorRule
P7  DELETE /api/supervisor/rules/:id                 body { confirm: true }
P7  GET    /api/supervisor/decisions?sessionPk&limit → SupervisorDecisionView[]
P7  POST   /api/supervisor/decisions/:id/wrong       → SupervisorRule
P7  POST   /api/supervisor/evaluate/:source/:id      → SupervisorDecisionView
P7  GET    /api/connectors/agnc/status               → AgncStatus { enabled, status, url, sessions }
P7  POST   /api/connectors/agnc/connect              → { authorizationUrl: string | null }
P7  GET    /oauth/agnc/callback?code&state           (no token; state-checked) → text/html
P7  GET    /api/agnc/sessions/:id/messages           → AgncMessage[]
P7  GET    /api/agnc/sessions/:id/events?cursor      → { items: AgncEvent[]; nextCursor }
P7  POST   /api/agnc/sessions/:id/prompt             body { prompt, model?, confirm: true }
P7  POST   /api/agnc/handoff                         body { source, id, confirm: true } → AgncSession

// §6 — WS LiveEvent additions (packages/api-contract/src/live.ts; P1 moved LiveEvent there)
  | { type: 'automation.runUpdated'; run: AutomationRunDetail }
  | { type: 'supervisor.decided'; decision: SupervisorDecisionView }
  | { type: 'compare.updated'; group: CompareGroup }
// §6 — BusEvent additions (apps/daemon/src/live/event-bus.ts)
  | { type: 'linear.issueChanged'; before: LinearIssue | null; after: LinearIssue }
  | { type: 'slack.mention'; channel: string; ts: string; text: string }

// §11 — AutomationRun.status gains 'awaiting_approval' (plan approval for headless runs)
export interface AutomationRun { id: string; automationId: string; startedAt: string; endedAt: string | null; status: 'queued'|'running'|'awaiting_approval'|'success'|'failed'|'denied'|'over_budget'; sessionPk: string | null; costUsd: number | null; summary: string | null }
// Automation and AutomationRun are defined as zod in @orc/api-contract (routes/automations.ts); services/automations/types.ts re-exports them.
export type TriggerSource = 'cron' | 'github' | 'linear' | 'slack' | 'manual' | 'rerun';
export interface AutomationRunDetail extends AutomationRun { triggerKey: string; triggerSource: TriggerSource; vars: Record<string, string>; ptyId: string | null; worktreePath: string | null; prUrl: string | null; diffStat: DiffStat | null; error: string | null; rerunOf: string | null }
export interface DiffStat { files: number; insertions: number; deletions: number; untracked: number }

// §11 — DaemonContext additions (all P7)
  suggestions?: SuggestionService;
  compare?: CompareService;
  agnc?: AgncConnector;

// P7 — api-contract client extension (packages/api-contract/src/clients/phase7.ts)
export type ApiCall = <T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown) => Promise<T>;
export type Phase7Api = AutomationsApi & CompareApi & SupervisorApi & AgncApi;   // interface ApiClient extends Phase7Api
export function phase7Client(call: ApiCall): Phase7Api
// P7 — apps/daemon/src/http/p7-guard.ts
export function requireConfirmed(body: { confirm?: boolean }, summary: string, details?: Record<string, unknown>): void   // 409 confirmation_required
export function need<T>(svc: T | undefined, name: string): T                                                             // 409 not_enabled
export const ConfirmBody: z.ZodObject<{ confirm: z.ZodOptional<z.ZodBoolean> }>; export const API_BASE: string; export const TEST_TOKEN: string
// route modules: registerAutomationRoutes, registerCompareRoutes, registerSupervisorRoutes, registerAgncRoutes, registerAgncOAuthRoute — (app: OrcApp, ctx: DaemonContext) => void

// P7 — services/git/git-info.ts
export function parseShortStat(text: string): Omit<DiffStat, 'untracked'>
export function diffStat(cwd: string, base: string): Promise<DiffStat>
export function addedLinesDiff(cwd: string, base: string): Promise<string>
export function defaultBranch(repo: string): Promise<string>
export function parseRemoteSlug(url: string): { owner: string; name: string } | null
export function remoteSlug(repo: string): Promise<{ owner: string; name: string } | null>
// P7 — services/launch/spawn.ts
// capacity errors are ServiceError('capacity_exceeded', 409, …) (P1 services/errors.ts); the count comes from LaunchService.ownedCount (P2)
export function assertOwnedCapacity(ctx: DaemonContext, projectId: string | null, needed?: number): void
export interface SpawnResult { ptyId: string; sessionId: string | null; sessionPk: string | null; command: string; args: string[] }
export function spawnClaudeSession(ctx: DaemonContext, i: { cwd: string; prompt: string; model?: string | null; args: readonly string[]; sessionId?: string }): SpawnResult
export function spawnCodexSession(ctx: DaemonContext, i: { cwd: string; prompt: string; model?: string | null }): SpawnResult

// P7 — services/automations/service.ts
export interface TriggerFire { key: string; source: TriggerSource; vars: Record<string, string>; rerunOf?: string | null }
export interface AutomationServiceImpl extends AutomationService {
  get(id: string): Automation | null; listWithStats(): AutomationWithStats[]; remove(id: string): void;
  setEnabled(id: string, enabled: boolean): Automation;
  start(id: string, fire: TriggerFire): Promise<AutomationRunDetail | null>;   // null = trigger already handled
  run(runId: string): AutomationRunDetail | null; waitFor(runId: string): Promise<AutomationRunDetail>;
  approve(runId: string): Promise<AutomationRunDetail>; reject(runId: string): AutomationRunDetail;
  rerun(runId: string): Promise<AutomationRunDetail | null>; stop(): void;
}
// P7 — services/automations/suggestions.ts
export interface SuggestionService { list(state?: Suggestion['state']): Suggestion[]; refresh(): Promise<{ added: number }>; accept(id: string): Promise<{ ptyId: string; sessionPk: string | null }>; dismiss(id: string): Suggestion; start(): () => void }
// P7 — services/compare/compare.ts
export interface CompareService { launch(req: LaunchRequest): Promise<CompareGroup>; estimate(projectId: string | null, n: number): CompareEstimate; get(id: string): CompareGroup | null; view(id: string): Promise<CompareView>; pickWinner(id: string, index: number): { group: CompareGroup; reviewUrl: string }; archiveLosers(id: string): Promise<ArchiveLosersResult> }
// P7 — services/supervisor/supervisor.ts
export interface SupervisorImpl {   // superset of §11 Supervisor
  evaluate(sessionPk: string): Promise<SupervisorDecisionView>; enabledFor(sessionPk: string): boolean; start(): () => void;
  setTarget(t: SupervisorTarget): SupervisorTarget; targets(): SupervisorTarget[];
  rules(): SupervisorRule[]; addRule(r: SupervisorRuleInput): SupervisorRule; removeRule(id: string): boolean;
  decisions(q: { sessionPk?: string; limit?: number }): SupervisorDecisionView[];
  feedbackWrong(decisionId: string): SupervisorRule; status(): SupervisorStatus;
}
// P7 — connectors/agnc/agnc.ts
export interface AgncConnector { status(): Promise<'ok'|'unauthenticated'|'error'>; beginAuth(): Promise<{ authorizationUrl: string | null }>; finishAuth(code: string, state: string): Promise<void>; listMySessions(): Promise<AgncSession[]>; getSession(id: string): Promise<AgncSession | null>; listMessages(id: string): Promise<AgncMessage[]>; listEvents(id: string, cursor?: string): Promise<{ items: AgncEvent[]; nextCursor: string | null }>; sendPrompt(id: string, prompt: string, model?: string): Promise<void>; createSession(i: { repoOwner: string; repoName: string; baseBranch?: string; title?: string; initialPrompt: string; model?: string }): Promise<AgncSession>; disconnect(): Promise<void> }
// P7 — notify/stdout-bridge.ts
export function createStdoutNotifyChannel(write?: (line: string) => void): NotifyChannelImpl   // id 'macos'; line format: "ORC_NOTIFY " + JSON {title, body, url}
```

The zod schemas and inferred types `AutomationInput`, `AutomationWithStats`, `RunStats`, `Suggestion`, `AutomationSettingsPatch`, `CompareVariantInput`, `CompareVariant`, `CompareGroup`, `CompareEstimate`, `CompareVariantView`, `CompareView`, `ArchiveLosersResult`, `SupervisorRule`, `SupervisorRuleInput`, `SupervisorTarget`, `SupervisorDecisionView`, `SupervisorStatus`, `SupervisorSettingsPatch`, `AgncSession`, `AgncMessage`, `AgncEvent` are defined in full in Tasks 2, 11, 14 and 20. Those task code blocks are the canonical definitions.

---

## Assumed earlier-phase APIs

Phases 1–6 were written in parallel with this plan. This plan relies **only** on the names in `00-contracts.md` plus the items below. If an earlier phase shipped a different shape, adapt the **call site** in this phase and record the change in the task's review note. Do not change the earlier phase.

| Item | Name used in this plan (from the Phase 1/2/4 plans) | Owner |
|---|---|---|
| Errors | `ServiceError(code, status, message, details?)` from `apps/daemon/src/services/errors.ts`; `ServiceErrorStatus = 400 \| 401 \| 403 \| 404 \| 409 \| 422 \| 500`. `createApp`'s `onError` turns it into the contract error shape. Phase 7 uses 409 for `capacity_exceeded`, `over_budget`, `invalid_state`, `not_enabled`, `confirmation_required`. | P1 |
| Test context | `createTestContext(opts?: Partial<DaemonContext> & { homes?; isPidAlive? }): TestContext` from `apps/daemon/test/helpers.ts`; `TestContext = DaemonContext & { homes; raw; launches; dispose() }`. Real P1 services on temp homes; overrides replace fields. | P1 |
| Context / boot | `buildContext({ paths, log, … })` builds the P1 context; `createDaemon(…)` in `apps/daemon/src/main.ts` adds later-phase services to `ctx` and starts them. Phase 7 adds its wiring at the end of `createDaemon` (Task 9, 12, 17, 20, 23). | P1/P2 |
| Hono app | `createApp({ ctx, token, port, webDist?, env? }): OrcApp` (`apps/daemon/src/http/app.ts`); route modules export `registerXRoutes(app: OrcApp, ctx: DaemonContext): void` and are registered **before** the `app.all('/api/*')` 404 catch-all. `readJson(c, schema)` from `apps/daemon/src/http/json.ts` throws `ServiceError(400, validation_failed)`. `OrcApp` is exported from `apps/daemon/src/http/types.ts`. | P1 |
| Route tests | `const app = createApp({ ctx, token: TOKEN, port: () => 4317, env: {} }); app.request('http://127.0.0.1:4317/api/…', { headers: { 'x-orc-token': TOKEN } })`. | P1 |
| Config writes | `ctx.updateConfig?.(fn)` persists and returns the new config (P2). | P2 |
| Session pk | `sessionPk(source, id)` from `apps/daemon/src/db/keys.ts` (re-exported by `services/sessions.ts`); `splitPk(pk)` from `@orc/core`. | P1/P2 |
| Sessions repo | `apps/daemon/src/db/repos/sessions.ts` exports `upsertSession(db: OrcDb, s: Session): void` (contracts §5 example); `sessions` has `pk`, `start_cwd`, `started_at` filter columns next to `data_json`. | P1 |
| Launch | `ctx.launcher: LaunchService` with `launch(req: LaunchRequest): Promise<{ ptyId; sessionId: string \| null }>` and `ownedCount(projectId)`. Its concurrency cap throws `429 concurrency_limit`. Compare mode and accepted suggestions launch through it; only PTY-mode automations spawn directly (they need the restricted tool flags). | P2 |
| Worktrees | `ctx.worktrees.createWith(i, { runSetup: false, actor })` → `{ view: WorktreeView; setupPtyId }`; `archiveAs(path, actor)`; `findByCwd(cwd)`; plus the §11 members. Dirty worktrees are refused with `dirty_worktree`. | P4 |
| GitHub | `PrStatus` lives in `@orc/core` (with `headRef`, `failedChecks`). The bus already carries `{ type: 'pr.changed'; before: PrStatus \| null; after: PrStatus }` (P4). | P4 |
| Inbox | `ctx.inbox: InboxEngineRuntime` (`InboxEngine` + `tick/start/stop`). Every payload carries `{ source, id }` when it refers to a session. | P2 |
| WS event type | `LiveEvent` is in `packages/api-contract/src/live.ts`; `/ws` forwards every `LiveEvent` variant. Web: `apps/web/src/api/live-events.ts` → `useLiveEvents()` and `applyLiveEvent(qc, e)`. | P1/P2 |
| Deny-list semantics | `checkDenied(text, patterns)` treats each pattern as a **case-insensitive regex source**. Task 1 has a probe test for this. | P3 |
| Audit | `ctx.audit.record()` (from `createAuditService`) returns the entry, redacts `params` with `redactDeep` and emits `audit.recorded`. `audited(audit, meta, fn)` records `denied` when `fn` throws P3's `DeniedError`. `auditMiddleware` + `AUDITED_ROUTES` / `NON_ACTION_ROUTES` live in `apps/daemon/src/http/audit-middleware.ts`. | P3 |
| Deny-list | `createDenyList({ config, projects })` in `apps/daemon/src/services/safety/deny-list.ts` implements the §11 `DenyList`. `checkDenied`, `DEFAULT_DENY_PATTERNS` and `redactDeep` come from `@orc/core`. | P3 |
| Scheduler | P5's persisted `Scheduler` (`add`, `remove`, `list`, `onFire`, `get`, `start`, `stop`) already fires cron jobs with croner and supports several handlers per kind. `ensureCronJob(s, kind, type, cron, extra?)` and `removeJobsOfType(s, kind, type)` keep one job per `payload.type`. | P5 |
| Recaps | `RecapService.recap(pk)` resolves `{ text, costUsd, model, cached }`. | P5 |
| Secrets | `createSecretStore(service?)` and `createMemorySecretStore(initial?)` in `apps/daemon/src/services/secrets/secret-store.ts` implement the §11 `SecretStore`. | P6 |
| Linear / Slack events | Phase 6 **owns** `connectors/linear/assigned-poller.ts`, `connectors/slack/mention-poller.ts` and the `linear.issueChanged` / `slack.mention` bus events, in exactly the shapes Task 7 uses. Phase 7 consumes them and does not redefine them. | P6 |
| Remote requests | `remoteGuard` classifies remote requests and `REMOTE_RULES` lists the step-up routes. Phase 7 adds no remote-facing action routes. | P6 |
| Usage | `UsageSnapshot` lives in `@orc/core` (with `generatedAt`, `block.active`, `burnRateTokensPerMin`); `pctOfLimit` and `checkBudget().pct` are fractions (`1.0` = 100%). `UsageMeter` also has `refresh`, `ingestOfficial`, `budgets`, `contextFill`, `concurrency`, `start`, `stop`. `GET /api/usage` returns `UsageSnapshot`. | P5 |
| API client | `packages/api-contract/src/client.ts`: `ApiRequestError(status, code, message, details?)`, `interface ApiClient`, `createApiClient(o: ApiClientOptions): ApiClient` with an inner `call<T>(schema, method, path, body?)`, and `toQueryString(params)`. | P1 |
| Web client | `apps/web/src/api/client.ts` exports `getApiClient(): ApiClient` and `setApiClientForTests(c: ApiClient \| null)`. | P1 |
| UI kit | `@/components/ui/{button,badge,input,native-select,tabs,checkbox,card,skeleton,separator}.tsx` (imported with the `.tsx` extension). `Button` variants are `default\|secondary\|outline\|ghost\|destructive` and sizes `default\|sm\|icon`. `Badge` variants are `default\|secondary\|outline\|destructive\|success\|warning`. There is no `switch`; Phase 7 uses `Checkbox` (`checked`, `onCheckedChange(checked)`) for toggles and `NativeSelect` (native `<select>` props) for pickers. Formatting helpers: `formatCost`, `formatDuration`, `formatDateTime` from `@/lib/format.ts`. Web test helpers: `renderWithClient`, `renderInRouter`, `fakeApi(stubs)`, `makeSession` from `apps/web/src/test/query.tsx` (P2). | P1/P2 |
| Launch dialog | `apps/web/src/features/launch/LaunchDialog.tsx` builds a `LaunchRequest` and calls `getApiClient().sessionsLaunch(req)`. | P2 |
| Settings page / nav | `apps/web/src/features/settings/SettingsPage.tsx` (`SettingsPage()` renders stacked `<section>` blocks; P2). The left nav is in `apps/web/src/features/shell/AppShell.tsx`, where each entry is `<Link to="/x" className="rounded px-2 py-1 hover:bg-muted" activeProps={{ className: 'bg-muted font-medium' }}>`. | P1/P2 |
| Session header | `apps/web/src/features/session-detail/SessionHeader.tsx` receives `session: Session`. | P3 |
| Secrets | `apps/daemon/src/services/secrets/secret-store.ts` exports `createSecretStore(): SecretStore`. | P6 |
| Linear/Slack | `ctx.linear`, `ctx.slack` as in §11. If Phase 6 already emits `linear.issueChanged` / `slack.mention`, skip the Task 7 pollers and keep only the dispatcher. | P6 |

---

## File Structure (created or modified in this phase)

```
packages/api-contract/src/config.ts                               (modify: automations, supervisor, compare, agnc)
packages/api-contract/src/client.ts                               (modify: spread P7 area clients)
packages/api-contract/src/live.ts                                 (modify: 3 LiveEvent variants)
packages/api-contract/src/routes/{automations,compare,supervisor,agnc}.ts
packages/api-contract/src/clients/{automations,compare,supervisor,agnc}.ts
packages/api-contract/src/index.ts                                (modify: exports)

apps/daemon/src/context.ts                                        (modify: suggestions, compare, agnc)
apps/daemon/src/live/event-bus.ts                                 (modify: linear.issueChanged, slack.mention)
apps/daemon/src/db/schema.ts                                      (modify: 7 tables)
apps/daemon/src/db/repos/{automations,suggestions,compare,supervisor}.ts
apps/daemon/src/services/git/git-info.ts
apps/daemon/src/services/launch/spawn.ts
apps/daemon/src/services/automations/{types,guardrails,headless,pty-wait,service,triggers,dispatcher,suggestions}.ts
apps/daemon/src/services/compare/compare.ts
apps/daemon/src/services/supervisor/{rules,question,classifier,supervisor}.ts
apps/daemon/src/connectors/linear/assigned-poller.ts
apps/daemon/src/connectors/slack/mention-poller.ts
apps/daemon/src/connectors/agnc/{oauth-provider,normalize,agnc}.ts
apps/daemon/src/collectors/agnc/agnc-collector.ts
apps/daemon/src/notify/stdout-bridge.ts
apps/daemon/src/http/p7-guard.ts
apps/daemon/src/http/routes/{automations,compare,supervisor,agnc,oauth-agnc}.ts
apps/daemon/src/http/app.ts                                       (modify: mount routes, ORC_WEB_DIR)
apps/daemon/src/main.ts                                           (modify: wiring)
apps/daemon/tsup.config.ts  apps/daemon/package.json              (modify: bundle workspace pkgs, files)
apps/daemon/test/fakes/phase7.ts
apps/daemon/test/bin/fake-claude-stream.mjs
apps/daemon/test/**/*.test.ts                                     (new tests per task)

apps/web/src/api/queries/{automations,compare,supervisor,agnc}.ts
apps/web/src/features/automations/{editor-model.ts,AutomationsPage.tsx,AutomationEditor.tsx,RunHistory.tsx,SuggestionsPanel.tsx}
apps/web/src/features/compare/{compare-model.ts,ComparePage.tsx,CompareLaunchSection.tsx}
apps/web/src/features/supervisor/{SupervisorSettings.tsx,DecisionsLog.tsx,SupervisorToggle.tsx}
apps/web/src/features/agnc/{AgncConnectCard.tsx,AgncSessionPanel.tsx,HandoffToAgncButton.tsx,AgncLinkCard.tsx}
apps/web/src/routes/{automations.tsx,compare.$groupId.tsx}

apps/mcp/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts}
apps/mcp/src/{daemon-client.ts,tools.ts,server.ts,main.ts}  + tests

apps/desktop/{package.json,splash/index.html}
apps/desktop/src-tauri/{Cargo.toml,build.rs,tauri.conf.json,capabilities/default.json}
apps/desktop/src-tauri/src/{main.rs,lib.rs,bridge.rs}
scripts/build-sidecar.mjs

spikes/s4-agnc/{package.json,probe.ts}   plan/spikes/S4.md
plan/00-contracts.md  plan/README.md                               (modify in Task 25)
```

---

# 7-0 Shared foundations

### Task 1: Shared Phase 7 foundations (config, git helpers, spawn helpers, HTTP helpers, test fakes)

**Files:**
- Modify: `packages/api-contract/src/config.ts`, `packages/api-contract/src/client.ts`, `apps/daemon/src/live/event-bus.ts`, `apps/daemon/src/context.ts`
- Create: `packages/api-contract/src/clients/phase7.ts`, `packages/api-contract/src/routes/p7-common.ts`, `packages/api-contract/src/routes/p7-placeholders.ts`, `apps/daemon/src/services/git/git-info.ts`, `apps/daemon/src/services/launch/spawn.ts`, `apps/daemon/src/http/p7-guard.ts`, `apps/daemon/test/fakes/phase7.ts`
- Test: `packages/api-contract/src/config.p7.test.ts`, `apps/daemon/test/p7/git-info.test.ts`, `apps/daemon/test/p7/spawn.test.ts`, `apps/daemon/test/p7/deny-probe.test.ts`

**Interfaces:**
- Consumes: `OrcConfig` (§3), `DaemonContext` (§11), `PtyManager`/`PtyInfo` (§7), `EventBus`/`BusEvent` (§6), `checkDenied`/`DEFAULT_DENY_PATTERNS` (P3), `LinearIssue` (P6), `sessionPk` (P1), all P2–P6 service interfaces from §11 (for fakes).
- Produces: the config blocks `automations`, `supervisor`, `compare`, `agnc` (see Contract additions); BusEvent variants `linear.issueChanged` and `slack.mention`; `git-info.ts` and `spawn.ts` exactly as in Contract additions; `http/p7-guard.ts`:
  ```ts
  export function requireConfirmed(body: { confirm?: boolean }, summary: string, details?: Record<string, unknown>): void   // ServiceError 409 confirmation_required
  export function need<T>(svc: T | undefined, name: string): T                                                             // ServiceError 409 not_enabled
  export const ConfirmBody: z.ZodObject<{ confirm: z.ZodOptional<z.ZodBoolean> }>
  export const API_BASE = 'http://127.0.0.1:4317'; export const TEST_TOKEN: string                                     // for route tests
  ```
  `ApiClient` extension point in `packages/api-contract/src/client.ts`: `export type ApiCall = <T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown) => Promise<T>` and `export interface ApiClient extends Phase7Api { … }` where `Phase7Api` is declared in `packages/api-contract/src/clients/phase7.ts` and grows in Tasks 2, 11, 14 and 20.
  Test fakes in `apps/daemon/test/fakes/phase7.ts`: `makeSession`, `makeLive`, `fakeSessions`, `fakeProjects`, `createFakePty`, `fakeInbox`, `fakeAudit`, `fakeUsage`, `fakeDenyList`, `fakeRecaps`, `fakeWorktrees`, `fakeLauncher`, `fakeTemplates`, `fakeShip`, `createMemoryScheduler`, `testConfig`, `initGitRepo`.

- [ ] **Step 1: Write the failing config test**

`packages/api-contract/src/config.p7.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { OrcConfig } from './config.ts';

describe('OrcConfig phase 7 blocks', () => {
  it('defaults every phase 7 feature to off', () => {
    const c = OrcConfig.parse({});
    expect(c.automations).toEqual({ enabled: false, maxConcurrent: 2, suggestions: { enabled: false, intervalMin: 60 } });
    expect(c.supervisor.enabled).toBe(false);
    expect(c.supervisor.model).toBe('claude-haiku-4-5');
    expect(c.supervisor.confidenceThreshold).toBe(0.85);
    expect(c.supervisor.maxPerSessionPerHour).toBe(3);
    expect(c.supervisor.maxPerHour).toBe(10);
    expect(c.supervisor.monthlyBudgetUsd).toBe(5);
    expect(c.supervisor.quietHours).toBeNull();
    expect(c.compare.maxVariants).toBe(4);
    expect(c.agnc).toEqual({ enabled: false, url: 'https://agnc.wakecap.ai/mcp', pollSeconds: 30 });
  });

  it('rejects malformed quiet hours', () => {
    expect(() => OrcConfig.parse({ supervisor: { quietHours: { start: '10pm', end: '08:00' } } })).toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/api-contract/src/config.p7.test.ts`
Expected: FAIL, `expected undefined to deeply equal { enabled: false, … }`

- [ ] **Step 3: Add the config blocks**

In `packages/api-contract/src/config.ts`, add these four keys inside `OrcConfig = z.object({ … })`, after `archive`:
```ts
  automations: z
    .object({
      enabled: z.boolean().default(false),
      maxConcurrent: z.number().int().positive().default(2),
      suggestions: z
        .object({ enabled: z.boolean().default(false), intervalMin: z.number().int().positive().default(60) })
        .prefault({}),
    })
    .prefault({}),
  supervisor: z
    .object({
      enabled: z.boolean().default(false),
      model: z.string().default('claude-haiku-4-5'),
      confidenceThreshold: z.number().min(0).max(1).default(0.85),
      maxPerSessionPerHour: z.number().int().nonnegative().default(3),
      maxPerHour: z.number().int().nonnegative().default(10),
      monthlyBudgetUsd: z.number().nonnegative().default(5),
      quietHours: z
        .object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })
        .nullable()
        .default(null),
      debounceMs: z.number().int().nonnegative().default(3000),
    })
    .prefault({}),
  compare: z.object({ maxVariants: z.number().int().min(2).max(6).default(4) }).prefault({}),
  agnc: z
    .object({
      enabled: z.boolean().default(false),
      url: z.string().default('https://agnc.wakecap.ai/mcp'),
      pollSeconds: z.number().int().positive().default(30),
    })
    .prefault({}),
```

Run: `pnpm vitest run packages/api-contract/src/config.p7.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 4: Add the Phase 7 extension point to the API client**

`packages/api-contract/src/clients/phase7.ts`
```ts
import type { z } from 'zod';

/** Same shape as the inner `call` of createApiClient (P1): validates the response with `schema`, throws ApiRequestError. */
export type ApiCall = <T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown) => Promise<T>;

/** Grows in Tasks 2 (AutomationsApi), 11 (CompareApi), 14 (SupervisorApi) and 20 (AgncApi). */
export type Phase7Api = Record<never, never>;

export function phase7Client(_call: ApiCall): Phase7Api {
  return {};
}
```

`packages/api-contract/src/routes/p7-common.ts` holds the schemas that more than one Phase 7 sub-part uses:
```ts
import { z } from 'zod';

export const DiffStatSchema = z.object({
  files: z.number().int(),
  insertions: z.number().int(),
  deletions: z.number().int(),
  untracked: z.number().int(),
});
export type DiffStatView = z.infer<typeof DiffStatSchema>;
```
Add `export * from './routes/p7-common.ts';` and `export * from './routes/p7-placeholders.ts';` to `packages/api-contract/src/index.ts`.

In `packages/api-contract/src/client.ts` (P1):
1. Add `import { type Phase7Api, phase7Client } from './clients/phase7.ts';` and `export type { ApiCall } from './clients/phase7.ts';`.
2. Change `export interface ApiClient {` to `export interface ApiClient extends Phase7Api {`.
3. In `createApiClient`, change `return {` to `return {\n    ...phase7Client(call),` so the Phase 7 methods are spread first and the P1–P6 methods keep their own names.

Tasks 2, 11, 14 and 20 each change exactly two lines in `clients/phase7.ts`: they add their `…Api` type to the `Phase7Api` intersection, and they spread their `…Client(call)` factory into the returned object.

- [ ] **Step 5: Add the bus events and context fields**

`apps/daemon/src/live/event-bus.ts`: add `import type { LinearIssue } from '../connectors/linear/linear.ts';` and append two variants to the end of the existing `BusEvent` union. Keep every existing variant, including P1's `session.indexed` and P4's `pr.changed`, `plan.pending` and `pr.reviewRequested`:
```ts
  | { type: 'linear.issueChanged'; before: LinearIssue | null; after: LinearIssue }
  | { type: 'slack.mention'; channel: string; ts: string; text: string };
```
If Phase 6 already added equivalent events under these names, skip this edit.

`apps/daemon/src/context.ts`: add these imports and optional fields to `DaemonContext`. The service files are created in Tasks 8, 11 and 20; until then, create each one as a type-only stub so this compiles:
```ts
import type { AgncConnector } from './connectors/agnc/agnc.ts';
import type { SuggestionService } from './services/automations/suggestions.ts';
import type { CompareService } from './services/compare/compare.ts';
// … inside DaemonContext:
  suggestions?: SuggestionService;   // P7
  compare?: CompareService;          // P7
  agnc?: AgncConnector;              // P7
```
Stub files (replaced later by the full implementations):

`apps/daemon/src/services/automations/suggestions.ts`
```ts
import type { Suggestion } from '@orc/api-contract';
export interface SuggestionService {
  list(state?: Suggestion['state']): Suggestion[];
  refresh(): Promise<{ added: number }>;
  accept(id: string): Promise<{ ptyId: string; sessionPk: string | null }>;
  dismiss(id: string): Suggestion;
  start(): () => void;
}
```
`apps/daemon/src/services/compare/compare.ts`
```ts
import type { ArchiveLosersResult, CompareEstimate, CompareGroup, CompareView, LaunchRequest } from '@orc/api-contract';
export interface CompareService {
  launch(req: LaunchRequest): Promise<CompareGroup>;
  estimate(projectId: string | null, n: number): CompareEstimate;
  get(id: string): CompareGroup | null;
  view(id: string): Promise<CompareView>;
  pickWinner(id: string, index: number): { group: CompareGroup; reviewUrl: string };
  archiveLosers(id: string): Promise<ArchiveLosersResult>;
}
```
`apps/daemon/src/connectors/agnc/agnc.ts`
```ts
import type { AgncEvent, AgncMessage, AgncSession } from '@orc/api-contract';
export interface AgncConnector {
  status(): Promise<'ok' | 'unauthenticated' | 'error'>;
  beginAuth(): Promise<{ authorizationUrl: string | null }>;
  finishAuth(code: string, state: string): Promise<void>;
  listMySessions(): Promise<AgncSession[]>;
  getSession(id: string): Promise<AgncSession | null>;
  listMessages(id: string): Promise<AgncMessage[]>;
  listEvents(id: string, cursor?: string): Promise<{ items: AgncEvent[]; nextCursor: string | null }>;
  sendPrompt(id: string, prompt: string, model?: string): Promise<void>;
  createSession(i: { repoOwner: string; repoName: string; baseBranch?: string; title?: string; initialPrompt: string; model?: string }): Promise<AgncSession>;
  disconnect(): Promise<void>;
}
```
These stubs import types that are created in Tasks 2, 11 and 20. So that Task 1 typechecks on its own, add temporary placeholder schemas to `packages/api-contract/src/routes/p7-placeholders.ts` (exported from the index in Step 4):
```ts
import { z } from 'zod';
// Placeholders: each is replaced by the real schema in Tasks 2 / 11 / 20, which delete the line here.
export const Suggestion = z.object({ id: z.string(), state: z.enum(['new', 'accepted', 'dismissed']) });
export type Suggestion = z.infer<typeof Suggestion>;
export const CompareGroup = z.object({ id: z.string() });
export type CompareGroup = z.infer<typeof CompareGroup>;
export const CompareEstimate = z.object({ variants: z.number() });
export type CompareEstimate = z.infer<typeof CompareEstimate>;
export const CompareView = z.object({ group: CompareGroup });
export type CompareView = z.infer<typeof CompareView>;
export const ArchiveLosersResult = z.object({ results: z.array(z.unknown()) });
export type ArchiveLosersResult = z.infer<typeof ArchiveLosersResult>;
export const AgncSession = z.object({ id: z.string() });
export type AgncSession = z.infer<typeof AgncSession>;
export const AgncMessage = z.object({ id: z.string() });
export type AgncMessage = z.infer<typeof AgncMessage>;
export const AgncEvent = z.object({ id: z.string() });
export type AgncEvent = z.infer<typeof AgncEvent>;
```
Tasks 2, 11 and 20 each delete their own lines from this file. Task 20 deletes the file once it is empty, together with its export line in `index.ts`.

- [ ] **Step 6: Write the failing git-info test**

`apps/daemon/test/p7/git-info.test.ts`
```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import {
  addedLinesDiff,
  defaultBranch,
  diffStat,
  parseRemoteSlug,
  parseShortStat,
} from '../../src/services/git/git-info.ts';
import { initGitRepo } from '../fakes/phase7.ts';

describe('parseShortStat', () => {
  it('parses all parts', () => {
    expect(parseShortStat(' 3 files changed, 10 insertions(+), 2 deletions(-)')).toEqual({ files: 3, insertions: 10, deletions: 2 });
  });
  it('parses singular and missing parts', () => {
    expect(parseShortStat(' 1 file changed, 1 insertion(+)')).toEqual({ files: 1, insertions: 1, deletions: 0 });
    expect(parseShortStat('')).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });
});

describe('diffStat / defaultBranch / addedLinesDiff', () => {
  it('counts committed, uncommitted and untracked changes against the base', async () => {
    const repo = await initGitRepo();
    expect(await defaultBranch(repo)).toBe('main');
    await execa('git', ['-C', repo, 'checkout', '-q', '-b', 'feat/x']);
    writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n// TODO: remove the flag\n');
    await execa('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'change']);
    writeFileSync(join(repo, 'a.ts'), 'export const a = 3;\n// TODO: remove the flag\n');
    writeFileSync(join(repo, 'new.ts'), 'x');
    const stat = await diffStat(repo, 'main');
    expect(stat).toEqual({ files: 1, insertions: 2, deletions: 1, untracked: 1 });
    expect(await addedLinesDiff(repo, 'main')).toContain('+// TODO: remove the flag');
  });
});

describe('parseRemoteSlug', () => {
  it.each([
    ['git@github.com:example-org/svc.git', { owner: 'example-org', name: 'svc' }],
    ['https://github.com/example-org/svc', { owner: 'example-org', name: 'svc' }],
    ['https://github.com/example-org/svc.git', { owner: 'example-org', name: 'svc' }],
    ['/local/path', null],
  ])('%s', (url, expected) => {
    expect(parseRemoteSlug(url)).toEqual(expected);
  });
});
```

- [ ] **Step 7: Write the fakes module**

`apps/daemon/test/fakes/phase7.ts`
```ts
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrcConfig, type ProjectConfig } from '@orc/api-contract';
import {
  type AuditActor,
  type AuditEntry,
  type InboxItem,
  type LiveState,
  type Recap,
  type Session,
  type UsageSnapshot,
  type Worktree,
  type WorktreeView,
  checkDenied,
  DEFAULT_DENY_PATTERNS,
  emptyUsage,
} from '@orc/core';
import { execa } from 'execa';
import type { LaunchRequest } from '@orc/api-contract';
import type { InboxEngineRuntime } from '../../src/inbox/engine.ts';
import type { PtyInfo, PtyManager } from '../../src/pty/pty-manager.ts';
import type { AuditService } from '../../src/services/audit/audit.ts';
import type { DenyList } from '../../src/services/safety/deny-list.ts';
import { ServiceError } from '../../src/services/errors.ts';
import type { LaunchService } from '../../src/services/launch.ts';
import type { ProjectServiceImpl } from '../../src/services/projects.ts';
import type { RecapService } from '../../src/services/recap/recap.ts';
import type { ScheduledJob, Scheduler } from '../../src/services/scheduler/scheduler.ts';
import { type SessionListItem, type SessionService, sessionPk } from '../../src/services/sessions.ts';
import type { ShipService } from '../../src/services/ship/ship.ts';
import type { Template, TemplateRegistry } from '../../src/services/templates.ts';
import type { UsageMeter } from '../../src/services/usage/meter.ts';
import type { CreateWorktreeInput, WorktreeService } from '../../src/services/worktree/worktree.ts';

const iso = () => new Date().toISOString();

export function testConfig(input: Record<string, unknown> = {}): OrcConfig {
  return OrcConfig.parse({
    projects: [
      {
        id: 'wakecap',
        name: 'Wakecap',
        pathPrefixes: [mkdtempSync(join(tmpdir(), 'orc-p7-proj-'))],
        ticketRegex: '\\b(SAF|SUPRT)-\\d+\\b',
        maxConcurrentOwned: 3,
      },
    ],
    ...input,
  });
}

export async function initGitRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'orc-p7-git-'));
  await execa('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  await execa('git', ['-C', repo, 'add', '.']);
  await execa('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return repo;
}

export function makeSession(o: Partial<Session> & { id: string }): Session {
  return {
    source: 'claude',
    projectId: 'wakecap',
    startCwd: '/tmp',
    cwds: ['/tmp'],
    name: null,
    firstPrompt: null,
    lastPrompt: null,
    awaySummary: null,
    recap: null,
    startedAt: '2026-09-17T08:00:00.000Z',
    lastActivityAt: '2026-09-17T08:30:00.000Z',
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
    ...o,
  };
}

export function makeLive(o: Partial<LiveState> = {}): LiveState {
  return {
    pid: 4242,
    status: 'waiting',
    waitingFor: 'input needed',
    since: '2026-09-17T08:30:00.000Z',
    ownership: 'owned',
    ptyId: 'pty-1',
    stage: null,
    currentTool: null,
    backgroundJobs: 0,
    runningSubagents: 0,
    contextFill: null,
    ...o,
  };
}

function toListItem(s: Session): SessionListItem {
  return {
    pk: sessionPk(s.source, s.id),
    source: s.source,
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    firstPrompt: s.firstPrompt,
    lastPrompt: s.lastPrompt,
    recap: s.recap,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    durationMs: Date.parse(s.lastActivityAt) - Date.parse(s.startedAt),
    costUsd: s.usage.costUsd,
    tickets: s.tickets,
    prs: s.prs,
    availability: s.availability,
    pinned: false,
    labels: [],
    live: s.live,
    snippet: null,
  };
}

export function fakeSessions(list: Session[] = []): SessionService & { byPk: Map<string, Session>; add(s: Session): void } {
  const byPk = new Map(list.map((s) => [sessionPk(s.source, s.id), s] as const));
  return {
    byPk,
    add(s) {
      byPk.set(sessionPk(s.source, s.id), s);
    },
    list(q) {
      const items = [...byPk.values()].filter((s) => !q.projectId || s.projectId === q.projectId).map(toListItem);
      return { items: items.slice(0, q.limit ?? 50), nextCursor: null };
    },
    get: (source, id) => byPk.get(sessionPk(source, id)) ?? null,
    getByPk: (pk) => byPk.get(pk) ?? null,
    events: () => ({ items: [], nextSeq: null }),
    agents: () => [],
    setLive(pk, live) {
      const s = byPk.get(pk);
      if (s) s.live = live;
    },
    resume: async () => ({ launched: 'external' as const }),
  };
}

export function fakeProjects(cfg: OrcConfig): ProjectServiceImpl {
  return {
    list: () =>
      cfg.projects.map((p) => ({ id: p.id, name: p.name, pathPrefixes: p.pathPrefixes, hidden: p.hidden, lastActivityAt: null, sessionCount: 0 })),
    resolve: (cwd) => cfg.projects.find((p) => p.pathPrefixes.some((pre) => cwd.startsWith(pre)))?.id ?? null,
    get: (id) => cfg.projects.find((p) => p.id === id) ?? null,
    update: (id, patch) => {
      const p = cfg.projects.find((x) => x.id === id);
      if (!p) throw new ServiceError('not_found', 404, `unknown project ${id}`);
      const { features, ...rest } = patch;
      Object.assign(p, rest);
      if (features) Object.assign(p.features, features);
      return p as ProjectConfig;
    },
    ensureDefaults() {},
    ensureDetected: () => ({ added: [] }),
    deriveConfigFor: () => ({ ticketRegex: null, prodPatterns: [] }),
    syncTable() {},
  };
}

export type FakePty = PtyManager & {
  spawned: PtyInfo[];
  sent: Array<{ id: string; text: string }>;
  killed: string[];
  exit(id: string, code?: number): void;
};

export function createFakePty(): FakePty {
  const spawned: PtyInfo[] = [];
  const sent: Array<{ id: string; text: string }> = [];
  const killed: string[] = [];
  const get = (id: string) => spawned.find((p) => p.id === id);
  return {
    spawned,
    sent,
    killed,
    exit(id, code = 0) {
      const p = get(id);
      if (p) {
        p.exitedAt = iso();
        p.exitCode = code;
      }
    },
    spawn(opts) {
      const info: PtyInfo = {
        id: `pty-${spawned.length + 1}`,
        sessionPk: opts.sessionPk ?? null,
        command: opts.command,
        args: opts.args,
        cwd: opts.cwd,
        pid: 1000 + spawned.length,
        startedAt: iso(),
        exitedAt: null,
        exitCode: null,
        cols: opts.cols ?? 120,
        rows: opts.rows ?? 36,
      };
      spawned.push(info);
      return info;
    },
    write() {},
    async sendText(id, text) {
      sent.push({ id, text });
    },
    resize() {},
    kill(id) {
      killed.push(id);
      const p = get(id);
      if (p) p.exitedAt = iso();
    },
    attach: () => ({ scrollback: '', detach() {} }),
    list: () => spawned,
    get,
  };
}

export function fakeInbox(): InboxEngineRuntime & { items: InboxItem[]; resolved: string[] } {
  const items: InboxItem[] = [];
  const resolved: string[] = [];
  const find = (id: string): InboxItem => {
    const it = items.find((i) => i.id === id);
    if (!it) throw new Error(`inbox item ${id} not found`);
    return it;
  };
  return {
    items,
    resolved,
    upsert(u) {
      const existing = items.find((i) => i.dedupeKey === u.dedupeKey && (i.state === 'open' || i.state === 'snoozed'));
      if (existing) {
        existing.reason = u.reason;
        existing.payload = u.payload ?? {};
        existing.updatedAt = iso();
        return existing;
      }
      const item: InboxItem = {
        id: randomUUID(),
        kind: u.kind,
        sessionId: u.sessionId ?? null,
        projectId: u.projectId ?? null,
        ticket: u.ticket ?? null,
        reason: u.reason,
        dedupeKey: u.dedupeKey,
        createdAt: iso(),
        updatedAt: iso(),
        state: 'open',
        snoozeUntil: null,
        payload: u.payload ?? {},
      };
      items.push(item);
      return item;
    },
    resolve(key) {
      resolved.push(key);
      for (const i of items) if (i.dedupeKey === key && i.state === 'open') i.state = 'auto_resolved';
    },
    list: (f) =>
      items.filter(
        (i) =>
          (!f.state || f.state.includes(i.state)) &&
          (!f.kind || f.kind.includes(i.kind)) &&
          (!f.projectId || i.projectId === f.projectId),
      ),
    markDone(id) {
      const i = find(id);
      i.state = 'done';
      return i;
    },
    snooze(id, until) {
      const i = find(id);
      i.state = 'snoozed';
      i.snoozeUntil = until;
      return i;
    },
    reopen(id) {
      const i = find(id);
      i.state = 'open';
      return i;
    },
    registerRule() {},
    tick() {},
    start() {},
    stop() {},
  };
}

export function fakeAudit(): AuditService & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    record(e) {
      const full: AuditEntry = { ...e, id: randomUUID(), ts: iso() };
      entries.push(full);
      return full;
    },
    list: (f) =>
      entries
        .filter((x) => (!f.action || x.action === f.action) && (!f.actor || x.actor === f.actor))
        .slice(0, f.limit ?? 1000),
  };
}

export function fakeUsage(state: { ok: boolean } = { ok: true }): UsageMeter & { state: { ok: boolean } } {
  const snap: UsageSnapshot = {
    source: 'estimate',
    generatedAt: iso(),
    block: { active: true, start: iso(), end: iso(), tokens: 1000, costUsd: 3, pctOfLimit: 0.2 },
    week: { tokens: 10000, costUsd: 30, pctOfLimit: 0.3 },
    burnRateUsdPerHour: 2.5,
    burnRateTokensPerMin: 400,
    projectedBlockExhaustionAt: null,
  };
  return {
    state,
    snapshot: () => snap,
    refresh: () => snap,
    ingestOfficial: () => null,
    budgets: () => [],
    contextFill: () => null,
    concurrency: () => [],
    start() {},
    stop() {},
    checkBudget: () => ({ ok: state.ok, pct: state.ok ? 0.2 : 1.1, limitUsd: 50 }),
  };
}

export function fakeDenyList(): DenyList {
  return { check: (text) => checkDenied(text, DEFAULT_DENY_PATTERNS) };
}

export function fakeRecaps(text = 'Fixed the flaky test and opened a draft PR.'): RecapService & { calls: string[] } {
  const calls: string[] = [];
  const recap: Recap = {
    id: 'rec-1', kind: 'session', targetKey: 'claude:x', transcriptOffset: 0, model: 'claude-haiku-4-5',
    engine: 'claude-cli', text, costUsd: 0.01, inputTokensApprox: 1000, createdAt: iso(),
  };
  return {
    calls,
    async recap(pk) {
      calls.push(pk);
      return { text, costUsd: 0.01, model: 'claude-haiku-4-5', cached: false };
    },
    async daily() {
      return '';
    },
    latest: () => recap,
    latestDaily: () => null,
    findCached: () => null,
    async runLlm() {
      return recap;
    },
    monthSpend: () => ({ spentUsd: 0, budgetUsd: 20 }),
    syncSchedule() {},
    start() {},
    stop() {},
  };
}

export function fakeWorktrees(): WorktreeService & { created: WorktreeView[]; dirty: Set<string>; archived: Array<{ path: string; actor: AuditActor }> } {
  const root = mkdtempSync(join(tmpdir(), 'orc-p7-wt-'));
  const created: WorktreeView[] = [];
  const dirty = new Set<string>();
  const archived: Array<{ path: string; actor: AuditActor }> = [];
  const branchName = (i: Pick<CreateWorktreeInput, 'type' | 'ticket' | 'slug'>) =>
    `${i.type}/${i.ticket ? `${i.ticket}-` : ''}${i.slug.replace(/\s+/g, '-')}`;
  const make = (i: CreateWorktreeInput): WorktreeView => {
    const path = join(root, i.slug.replace(/\s+/g, '-'));
    mkdirSync(path, { recursive: true });
    const base: Worktree = { path, repo: i.repo, branch: branchName(i), base: i.base, ticket: i.ticket, dirty: false, prUrl: null, state: 'active', createdByApp: true };
    return { ...base, head: null, isMain: false, origin: 'app', sessionPks: [], projectId: 'wakecap', prStatus: null, updatedAt: iso() };
  };
  const archiveAs = async (path: string, actor: AuditActor) => {
    if (dirty.has(path)) throw new ServiceError('dirty_worktree', 409, `worktree ${path} has uncommitted changes`);
    archived.push({ path, actor });
    const wt = created.find((w) => w.path === path);
    if (wt) wt.state = 'archived';
  };
  return {
    created,
    dirty,
    archived,
    async discover() {
      return created;
    },
    async create(i) {
      const v = make(i);
      created.push(v);
      return v;
    },
    async createWith(i) {
      const v = make(i);
      created.push(v);
      return { view: v, setupPtyId: null };
    },
    async runScript() {
      return { ptyId: 'pty-script' };
    },
    async syncToMain() {
      return { files: 0 };
    },
    async syncPreview(path) {
      return { path, mainPath: path, files: [], mainDirty: [] };
    },
    archive: (path) => archiveAs(path, 'user'),
    archiveAs,
    list: () => created,
    get: (path) => created.find((w) => w.path === path) ?? null,
    findByCwd: (cwd) => created.filter((w) => w.state === 'active' && cwd.startsWith(w.path)).sort((a, b) => b.path.length - a.path.length)[0] ?? null,
    async open() {},
    branchName,
  };
}

export function fakeLauncher(opts: { max?: number } = {}): LaunchService & { requests: LaunchRequest[] } {
  const requests: LaunchRequest[] = [];
  return {
    requests,
    async launch(req) {
      if (requests.length >= (opts.max ?? 99)) {
        throw new ServiceError('capacity_exceeded', 409, 'too many owned sessions', { max: opts.max });
      }
      requests.push(req);
      const n = requests.length;
      return { ptyId: `pty-l${n}`, sessionId: req.source === 'claude' ? `launched-${n}` : null };
    },
    async kill() {
      return { killed: 'pty' as const };
    },
    ownedCount: () => requests.length,
  };
}

export function fakeTemplates(map: Record<string, string>): TemplateRegistry {
  const list: Template[] = Object.entries(map).map(([id, prompt]) => ({
    id,
    kind: 'workflow',
    label: id,
    prompt,
    vars: [],
    defaultSource: 'claude',
    projectIds: 'all',
  }));
  return {
    list: () => list,
    render(id, vars) {
      const t = map[id];
      if (t === undefined) throw new Error(`unknown template ${id}`);
      return t.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');
    },
  };
}

export function fakeShip(): ShipService & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async commit() {
      calls.push('commit');
      return { sha: 'abc123' };
    },
    async push() {
      calls.push('push');
    },
    async createPr() {
      calls.push('createPr');
      return { repo: 'example-org/svc', number: 1, url: 'https://github.com/example-org/svc/pull/1' };
    },
    async merge() {
      calls.push('merge');
    },
  };
}

/** In-memory stand-in for P5's persisted Scheduler: it stores jobs and fires them only when a test says so. */
export function createMemoryScheduler(): Scheduler & { jobs: ScheduledJob[]; fire(kind: ScheduledJob['kind'], job: ScheduledJob): Promise<void> } {
  const jobs: ScheduledJob[] = [];
  const handlers = new Map<ScheduledJob['kind'], Array<(job: ScheduledJob) => Promise<void>>>();
  return {
    jobs,
    add(job) {
      const full: ScheduledJob = { ...job, id: randomUUID() };
      jobs.push(full);
      return full;
    },
    remove(id) {
      const i = jobs.findIndex((j) => j.id === id);
      if (i >= 0) jobs.splice(i, 1);
    },
    list: (kind) => jobs.filter((j) => !kind || j.kind === kind),
    get: (id) => jobs.find((j) => j.id === id) ?? null,
    onFire(kind, fn) {
      handlers.set(kind, [...(handlers.get(kind) ?? []), fn]);
    },
    start() {},
    stop() {},
    async fire(kind, job) {
      for (const fn of handlers.get(kind) ?? []) await fn(job);
    },
  };
}
```
If an import path above differs from the real P2–P6 file, fix only the path. The interface names come from contracts §11.

- [ ] **Step 8: Run the git-info test and confirm it fails**

Run: `pnpm vitest run apps/daemon/test/p7/git-info.test.ts`
Expected: FAIL, `Cannot find module '../../src/services/git/git-info.ts'`

- [ ] **Step 9: Implement git-info**

`apps/daemon/src/services/git/git-info.ts`
```ts
import { execa } from 'execa';

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
  untracked: number;
}

export function parseShortStat(text: string): Omit<DiffStat, 'untracked'> {
  const num = (re: RegExp): number => Number(re.exec(text)?.[1] ?? 0);
  return {
    files: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?\(\+\)/),
    deletions: num(/(\d+) deletions?\(-\)/),
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await execa('git', ['-C', cwd, ...args], { stdin: 'ignore' });
  return r.stdout.trim();
}

async function mergeBase(cwd: string, base: string): Promise<string> {
  return git(cwd, ['merge-base', base, 'HEAD']);
}

/** Changes since the merge-base with `base`, including uncommitted tracked edits, plus untracked file count. */
export async function diffStat(cwd: string, base: string): Promise<DiffStat> {
  const mb = await mergeBase(cwd, base);
  const short = parseShortStat(await git(cwd, ['diff', '--shortstat', mb]));
  const others = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
  return { ...short, untracked: others ? others.split('\n').length : 0 };
}

/** Zero-context diff since the merge-base; used to find newly added TODO/FIXME lines. */
export async function addedLinesDiff(cwd: string, base: string): Promise<string> {
  const mb = await mergeBase(cwd, base);
  return git(cwd, ['diff', '-U0', '--no-color', mb]);
}

/** "origin/main" when origin/HEAD is known, else the first local main/master/develop, else "HEAD". */
export async function defaultBranch(repo: string): Promise<string> {
  try {
    const ref = await git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    if (ref) return ref.replace(/^refs\/remotes\//, '');
  } catch {
    // no origin/HEAD
  }
  for (const b of ['main', 'master', 'develop']) {
    try {
      await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]);
      return b;
    } catch {
      // try the next name
    }
  }
  return 'HEAD';
}

export function parseRemoteSlug(url: string): { owner: string; name: string } | null {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m?.[1] || !m[2]) return null;
  return { owner: m[1], name: m[2] };
}

export async function remoteSlug(repo: string): Promise<{ owner: string; name: string } | null> {
  try {
    return parseRemoteSlug(await git(repo, ['remote', 'get-url', 'origin']));
  } catch {
    return null;
  }
}
```

Run: `pnpm vitest run apps/daemon/test/p7/git-info.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 10: Write the failing spawn test and the deny-list probe**

`apps/daemon/test/p7/spawn.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { ServiceError } from '../../src/services/errors.ts';
import { assertOwnedCapacity, spawnClaudeSession, spawnCodexSession } from '../../src/services/launch/spawn.ts';
import { createTestContext } from '../helpers.ts';
import { createFakePty, fakeProjects, testConfig } from '../fakes/phase7.ts';

describe('spawn helpers', () => {
  it('spawns claude with a fixed session id and the prompt after --', () => {
    const cfg = testConfig();
    const pty = createFakePty();
    const ctx = createTestContext({ config: () => cfg, pty, projects: fakeProjects(cfg), launcher: undefined });
    const r = spawnClaudeSession(ctx, { cwd: '/tmp', prompt: '--looks-like-a-flag', model: 'claude-sonnet-5', args: ['--permission-mode', 'plan'], sessionId: '11111111-1111-4111-8111-111111111111' });
    expect(r.sessionPk).toBe('claude:11111111-1111-4111-8111-111111111111');
    expect(pty.spawned[0]?.args).toEqual([
      '--permission-mode', 'plan', '--model', 'claude-sonnet-5',
      '--session-id', '11111111-1111-4111-8111-111111111111', '--', '--looks-like-a-flag',
    ]);
    expect(pty.spawned[0]?.sessionPk).toBe(r.sessionPk);
    ctx.dispose();
  });

  it('spawns codex without a session pk', () => {
    const cfg = testConfig();
    const pty = createFakePty();
    const ctx = createTestContext({ config: () => cfg, pty, projects: fakeProjects(cfg), launcher: undefined });
    const r = spawnCodexSession(ctx, { cwd: '/tmp', prompt: 'fix it', model: 'gpt-5.5-codex' });
    expect(r.sessionPk).toBeNull();
    expect(pty.spawned[0]?.command).toBe('codex');
    expect(pty.spawned[0]?.args).toEqual(['-m', 'gpt-5.5-codex', '--', 'fix it']);
    ctx.dispose();
  });

  it('enforces the per-project owned-session cap', () => {
    const cfg = testConfig();
    const pty = createFakePty();
    const ctx = createTestContext({ config: () => cfg, pty, projects: fakeProjects(cfg), launcher: undefined });
    for (let i = 0; i < 3; i++) spawnClaudeSession(ctx, { cwd: '/tmp', prompt: 'x', args: [] });
    expect(() => assertOwnedCapacity(ctx, 'wakecap')).toThrow(ServiceError);
    pty.exit('pty-1');
    expect(() => assertOwnedCapacity(ctx, 'wakecap')).not.toThrow();
    expect(() => assertOwnedCapacity(ctx, 'wakecap', 2)).toThrow(ServiceError);
    ctx.dispose();
  });
});
```

`apps/daemon/test/p7/deny-probe.test.ts`
```ts
import { checkDenied } from '@orc/core';
import { describe, expect, it } from 'vitest';

// Probe for the P3 contract assumption: patterns are case-insensitive regex sources.
describe('checkDenied semantics', () => {
  it('treats patterns as case-insensitive regular expressions', () => {
    expect(checkDenied('Please GH PR MERGE 12', [String.raw`\bgh\s+pr\s+merge\b`]).denied).toBe(true);
    expect(checkDenied('open a draft pr', [String.raw`\bgh\s+pr\s+merge\b`]).denied).toBe(false);
  });
});
```
If the probe fails, P3 matches substrings. In that case, change `AUTOMATION_DENY_PATTERNS` (Task 3) and `SUPERVISOR_DENY_PATTERNS` (Task 15) into plain lowercase phrases, and note the change in the review.

Run: `pnpm vitest run apps/daemon/test/p7/spawn.test.ts apps/daemon/test/p7/deny-probe.test.ts`
Expected: spawn FAILS with `Cannot find module '../../src/services/launch/spawn.ts'`; the probe PASSES.

- [ ] **Step 11: Implement the spawn helpers**

`apps/daemon/src/services/launch/spawn.ts`
```ts
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
    throw new ServiceError('capacity_exceeded', 409, `owned session cap reached (${used} running, ${needed} requested, cap ${cap})`, {
      projectId,
      running: used,
      max: cap,
    });
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
```

- [ ] **Step 12: Add the route guard helpers**

`apps/daemon/src/http/p7-guard.ts`
```ts
import { z } from 'zod';
import { ServiceError } from '../services/errors.ts';

/** Body fragment for destructive endpoints (contracts §6 "Confirmation"). */
export const ConfirmBody = z.object({ confirm: z.boolean().optional() });

export function requireConfirmed(body: { confirm?: boolean }, summary: string, details: Record<string, unknown> = {}): void {
  if (body.confirm !== true) {
    throw new ServiceError('confirmation_required', 409, 'confirmation required', { summary, ...details });
  }
}

/** Optional context services: routes fail with 409 not_enabled when the feature is not wired. */
export function need<T>(svc: T | undefined, name: string): T {
  if (svc === undefined) throw new ServiceError('not_enabled', 409, `${name} is not enabled`);
  return svc;
}

/** Shared by Phase 7 route tests (createApp checks Host = 127.0.0.1:4317). */
export const API_BASE = 'http://127.0.0.1:4317';
export const TEST_TOKEN = 'b'.repeat(64);
```

Every Phase 7 route reads bodies with P1's `readJson(c, schema)`. Errors are thrown as `ServiceError`, and P1's `app.onError` turns them into the contract error shape.

- [ ] **Step 13: Run the tests, then all checks, and commit**

Run: `pnpm vitest run apps/daemon/test/p7 packages/api-contract`
Expected: PASS (git-info 7, spawn 3, probe 1, config 2, plus the existing api-contract tests)

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add packages/api-contract apps/daemon/src/services/git apps/daemon/src/services/launch apps/daemon/src/http/p7-guard.ts apps/daemon/src/live/event-bus.ts apps/daemon/src/context.ts apps/daemon/src/services/automations/suggestions.ts apps/daemon/src/services/compare/compare.ts apps/daemon/src/connectors/agnc/agnc.ts apps/daemon/test/fakes apps/daemon/test/p7
git commit -m "feat(daemon): add phase 7 foundations (config, git and spawn helpers, test fakes)"
```

---

# 7A Automations (F20)

### Task 2: Automations data layer (tables, repos, zod schemas, client, live event)

**Files:**
- Modify: `apps/daemon/src/db/schema.ts`, `packages/api-contract/src/live.ts`, `packages/api-contract/src/clients/phase7.ts`, `packages/api-contract/src/index.ts`, `packages/api-contract/src/routes/p7-placeholders.ts`, `apps/web/src/api/live-events.ts`
- Create: `packages/api-contract/src/routes/automations.ts`, `packages/api-contract/src/clients/automations.ts`, `apps/daemon/src/db/repos/automations.ts`, `apps/daemon/src/db/repos/suggestions.ts`, `apps/daemon/src/services/automations/types.ts`, migration `apps/daemon/src/db/migrations/*` (generated)
- Test: `packages/api-contract/src/routes/automations.test.ts`, `apps/daemon/test/p7/automations-repo.test.ts`

**Interfaces:**
- Consumes: `OrcDb` (§5), `createTestContext` (P1), `ApiCall`/`Phase7Api` (Task 1), `DiffStat` (Task 1).
- Produces:
  ```ts
  // @orc/api-contract (routes/automations.ts)
  AutomationTrigger, AutomationAction, Automation, AutomationInput, AutomationRunStatus, TriggerSource, AutomationRun,
  AutomationRunDetail, RunStats, AutomationWithStats, Suggestion, AutomationSettingsPatch   // zod + inferred types
  // @orc/api-contract (clients/automations.ts)
  export interface AutomationsApi {
    automationsList(): Promise<AutomationWithStats[]>; automationsGet(id: string): Promise<AutomationWithStats>;
    automationsSave(a: AutomationInput): Promise<Automation>; automationsDelete(id: string): Promise<{ ok: true }>;
    automationsSetEnabled(id: string, enabled: boolean): Promise<Automation>; automationsRun(id: string): Promise<AutomationRunDetail>;
    automationsRuns(id: string): Promise<AutomationRunDetail[]>; automationsRunGet(runId: string): Promise<AutomationRunDetail>;
    automationsRunLog(runId: string): Promise<{ lines: string[] }>; automationsApprove(runId: string): Promise<AutomationRunDetail>;
    automationsReject(runId: string): Promise<AutomationRunDetail>; automationsRerun(runId: string): Promise<AutomationRunDetail | { deduped: true }>;
    automationsSettingsGet(): Promise<AutomationSettings>; automationsSettings(patch: AutomationSettingsPatch): Promise<AutomationSettings>;
    suggestionsList(state?: Suggestion['state']): Promise<Suggestion[]>; suggestionsRefresh(): Promise<{ added: number }>;
    suggestionsAccept(id: string): Promise<{ ptyId: string; sessionPk: string | null }>; suggestionsDismiss(id: string): Promise<Suggestion>;
  }
  export function automationsClient(call: ApiCall): AutomationsApi
  // apps/daemon/src/db/repos/automations.ts
  export interface NewRun { id: string; automationId: string; triggerKey: string; triggerSource: TriggerSource; vars: Record<string, string>; startedAt: string; status: AutomationRunStatus; rerunOf: string | null }
  export type RunPatch = Partial<Pick<AutomationRunDetail, 'status' | 'endedAt' | 'sessionPk' | 'costUsd' | 'summary' | 'ptyId' | 'worktreePath' | 'prUrl' | 'diffStat' | 'error'>> & { logPath?: string | null }
  export function listAutomations(db: OrcDb): Automation[]
  export function getAutomation(db: OrcDb, id: string): Automation | null
  export function upsertAutomation(db: OrcDb, a: Automation, now: string): Automation
  export function deleteAutomation(db: OrcDb, id: string): void
  export function insertRun(db: OrcDb, r: NewRun): AutomationRunDetail | null          // null when (automationId, triggerKey) exists
  export function updateRun(db: OrcDb, id: string, patch: RunPatch): AutomationRunDetail
  export function getRun(db: OrcDb, id: string): AutomationRunDetail | null
  export function getRunLogPath(db: OrcDb, id: string): string | null
  export function listRuns(db: OrcDb, automationId: string, limit?: number): AutomationRunDetail[]
  export function monthSpend(db: OrcDb, automationId: string, sinceIso: string): number
  export function runStats(db: OrcDb, automationId: string, monthStartIso: string): RunStats   // includes monthSpendUsd
  export function failStaleRuns(db: OrcDb, now: string): number                          // queued/running → failed at boot
  // apps/daemon/src/db/repos/suggestions.ts
  export interface NewSuggestion { source: Suggestion['source']; projectId: string | null; title: string; detail: string; ticket: string | null; file: string | null; line: number | null; dedupeKey: string }
  export function insertSuggestion(db: OrcDb, s: NewSuggestion, now: string): Suggestion | null   // null when dedupeKey exists
  export function listSuggestions(db: OrcDb, state?: Suggestion['state']): Suggestion[]
  export function getSuggestion(db: OrcDb, id: string): Suggestion | null
  export function decideSuggestion(db: OrcDb, id: string, state: 'accepted' | 'dismissed', now: string, runPtyId?: string | null): Suggestion
  // apps/daemon/src/services/automations/types.ts — contracts §11 names
  export type { Automation, AutomationRun, AutomationRunDetail } from '@orc/api-contract';
  export interface AutomationService { list(): Automation[]; save(a: Automation): Automation; runNow(id: string): Promise<AutomationRun>; runs(id: string): AutomationRun[] }
  ```

- [ ] **Step 1: Write the failing schema test**

`packages/api-contract/src/routes/automations.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { Automation, AutomationInput, AutomationRunDetail } from './automations.ts';

const base = {
  name: 'Fix CI on my PRs',
  enabled: false,
  trigger: { type: 'github', event: 'check_failed' },
  action: { templateId: 'fix-ci', projectId: 'wakecap', useWorktree: true, headless: true, timeoutMin: 30, planApproval: false },
  budgetUsd: 10,
};

describe('Automation schema', () => {
  it('accepts every trigger type', () => {
    for (const trigger of [
      { type: 'cron', cron: '0 9 * * 1-5' },
      { type: 'github', event: 'review_comment' },
      { type: 'linear', event: 'labeled', label: 'agent-ok' },
      { type: 'slack', event: 'mention', channel: 'C123' },
      { type: 'manual' },
    ]) {
      expect(Automation.safeParse({ ...base, id: 'a1', trigger }).success).toBe(true);
    }
  });

  it('rejects unknown events, bad budgets and long timeouts', () => {
    expect(Automation.safeParse({ ...base, id: 'a1', trigger: { type: 'github', event: 'pr_opened' } }).success).toBe(false);
    expect(Automation.safeParse({ ...base, id: 'a1', budgetUsd: 0 }).success).toBe(false);
    expect(Automation.safeParse({ ...base, id: 'a1', action: { ...base.action, timeoutMin: 600 } }).success).toBe(false);
  });

  it('lets the input omit the id', () => {
    expect(AutomationInput.parse(base).id).toBeUndefined();
  });

  it('parses a run detail with the awaiting_approval status', () => {
    const run = AutomationRunDetail.parse({
      id: 'r1', automationId: 'a1', startedAt: '2026-09-17T09:00:00.000Z', endedAt: null, status: 'awaiting_approval',
      sessionPk: 'claude:s1', costUsd: 0.4, summary: 'plan', triggerKey: 'manual:x', triggerSource: 'manual', vars: {},
      ptyId: null, worktreePath: null, prUrl: null, diffStat: null, error: null, rerunOf: null,
    });
    expect(run.status).toBe('awaiting_approval');
  });
});
```

Run: `pnpm vitest run packages/api-contract/src/routes/automations.test.ts`
Expected: FAIL, `Cannot find module './automations.ts'`

- [ ] **Step 2: Write the schemas and the client**

`packages/api-contract/src/routes/automations.ts`
```ts
import { z } from 'zod';
import { DiffStatSchema } from './p7-common.ts';

export const AutomationTrigger = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cron'), cron: z.string().min(9).max(120) }),
  z.object({ type: z.literal('github'), event: z.enum(['review_comment', 'check_failed', 'pr_merged']) }),
  z.object({ type: z.literal('linear'), event: z.enum(['assigned', 'labeled']), label: z.string().min(1).optional() }),
  z.object({ type: z.literal('slack'), event: z.literal('mention'), channel: z.string().min(1) }),
  z.object({ type: z.literal('manual') }),
]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

export const AutomationAction = z.object({
  templateId: z.string().min(1),
  projectId: z.string().min(1),
  repo: z.string().min(1).optional(),
  useWorktree: z.boolean(),
  headless: z.boolean(),
  model: z.string().min(1).optional(),
  timeoutMin: z.number().int().min(1).max(240),
  planApproval: z.boolean(),
});
export type AutomationAction = z.infer<typeof AutomationAction>;

export const Automation = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  enabled: z.boolean(),
  trigger: AutomationTrigger,
  action: AutomationAction,
  budgetUsd: z.number().positive().max(500),
});
export type Automation = z.infer<typeof Automation>;

export const AutomationInput = Automation.extend({ id: z.string().min(1).optional() });
export type AutomationInput = z.infer<typeof AutomationInput>;

export const AutomationRunStatus = z.enum(['queued', 'running', 'awaiting_approval', 'success', 'failed', 'denied', 'over_budget']);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatus>;
export const TriggerSource = z.enum(['cron', 'github', 'linear', 'slack', 'manual', 'rerun']);
export type TriggerSource = z.infer<typeof TriggerSource>;

export const AutomationRun = z.object({
  id: z.string(),
  automationId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: AutomationRunStatus,
  sessionPk: z.string().nullable(),
  costUsd: z.number().nullable(),
  summary: z.string().nullable(),
});
export type AutomationRun = z.infer<typeof AutomationRun>;

export const AutomationRunDetail = AutomationRun.extend({
  triggerKey: z.string(),
  triggerSource: TriggerSource,
  vars: z.record(z.string(), z.string()),
  ptyId: z.string().nullable(),
  worktreePath: z.string().nullable(),
  prUrl: z.string().nullable(),
  diffStat: DiffStatSchema.nullable(),
  error: z.string().nullable(),
  rerunOf: z.string().nullable(),
});
export type AutomationRunDetail = z.infer<typeof AutomationRunDetail>;

export const RunStats = z.object({
  total: z.number().int(),
  success: z.number().int(),
  failed: z.number().int(),
  successRate: z.number().nullable(),
  lastRunAt: z.string().nullable(),
  monthSpendUsd: z.number(),
});
export type RunStats = z.infer<typeof RunStats>;

export const AutomationWithStats = Automation.extend({ stats: RunStats, nextRunAt: z.string().nullable() });
export type AutomationWithStats = z.infer<typeof AutomationWithStats>;

export const Suggestion = z.object({
  id: z.string(),
  source: z.enum(['linear', 'todo']),
  projectId: z.string().nullable(),
  title: z.string(),
  detail: z.string(),
  ticket: z.string().nullable(),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  state: z.enum(['new', 'accepted', 'dismissed']),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  runPtyId: z.string().nullable(),
});
export type Suggestion = z.infer<typeof Suggestion>;

export const AutomationSettingsPatch = z.object({
  enabled: z.boolean().optional(),
  maxConcurrent: z.number().int().min(1).max(10).optional(),
  suggestionsEnabled: z.boolean().optional(),
});
export type AutomationSettingsPatch = z.infer<typeof AutomationSettingsPatch>;

export const AutomationSettings = z.object({ enabled: z.boolean(), maxConcurrent: z.number().int(), suggestionsEnabled: z.boolean() });
export type AutomationSettings = z.infer<typeof AutomationSettings>;
```

`packages/api-contract/src/clients/automations.ts`
```ts
import { z } from 'zod';
import {
  Automation,
  type AutomationInput,
  AutomationRunDetail,
  AutomationSettings,
  type AutomationSettingsPatch,
  AutomationWithStats,
  Suggestion,
} from '../routes/automations.ts';
import type { ApiCall } from './phase7.ts';

export interface AutomationsApi {
  automationsList(): Promise<AutomationWithStats[]>;
  automationsGet(id: string): Promise<AutomationWithStats>;
  automationsSave(a: AutomationInput): Promise<Automation>;
  automationsDelete(id: string): Promise<{ ok: true }>;
  automationsSetEnabled(id: string, enabled: boolean): Promise<Automation>;
  automationsRun(id: string): Promise<AutomationRunDetail>;
  automationsRuns(id: string): Promise<AutomationRunDetail[]>;
  automationsRunGet(runId: string): Promise<AutomationRunDetail>;
  automationsRunLog(runId: string): Promise<{ lines: string[] }>;
  automationsApprove(runId: string): Promise<AutomationRunDetail>;
  automationsReject(runId: string): Promise<AutomationRunDetail>;
  automationsRerun(runId: string): Promise<AutomationRunDetail | { deduped: true }>;
  automationsSettingsGet(): Promise<AutomationSettings>;
  automationsSettings(patch: AutomationSettingsPatch): Promise<AutomationSettings>;
  suggestionsList(state?: Suggestion['state']): Promise<Suggestion[]>;
  suggestionsRefresh(): Promise<{ added: number }>;
  suggestionsAccept(id: string): Promise<{ ptyId: string; sessionPk: string | null }>;
  suggestionsDismiss(id: string): Promise<Suggestion>;
}

const Ok = z.object({ ok: z.literal(true) });
const RunLog = z.object({ lines: z.array(z.string()) });
const Added = z.object({ added: z.number().int() });
const Accepted = z.object({ ptyId: z.string(), sessionPk: z.string().nullable() });
const RerunResult = z.union([AutomationRunDetail, z.object({ deduped: z.literal(true) })]);

export function automationsClient(call: ApiCall): AutomationsApi {
  const a = (id: string) => `/api/automations/${encodeURIComponent(id)}`;
  const r = (runId: string) => `/api/automations/runs/${encodeURIComponent(runId)}`;
  const s = (id: string) => `/api/automations/suggestions/${encodeURIComponent(id)}`;
  return {
    automationsList: () => call(z.array(AutomationWithStats), 'GET', '/api/automations'),
    automationsGet: (id) => call(AutomationWithStats, 'GET', a(id)),
    automationsSave: (body) => call(Automation, 'POST', '/api/automations', body),
    automationsDelete: (id) => call(Ok, 'DELETE', a(id), { confirm: true }),
    automationsSetEnabled: (id, enabled) => call(Automation, 'POST', `${a(id)}/enabled`, { enabled }),
    automationsRun: (id) => call(AutomationRunDetail, 'POST', `${a(id)}/run`, {}),
    automationsRuns: (id) => call(z.array(AutomationRunDetail), 'GET', `${a(id)}/runs`),
    automationsRunGet: (runId) => call(AutomationRunDetail, 'GET', r(runId)),
    automationsRunLog: (runId) => call(RunLog, 'GET', `${r(runId)}/log`),
    automationsApprove: (runId) => call(AutomationRunDetail, 'POST', `${r(runId)}/approve`, { confirm: true }),
    automationsReject: (runId) => call(AutomationRunDetail, 'POST', `${r(runId)}/reject`, {}),
    automationsRerun: (runId) => call(RerunResult, 'POST', `${r(runId)}/rerun`, {}),
    automationsSettingsGet: () => call(AutomationSettings, 'GET', '/api/automations/settings'),
    automationsSettings: (patch) => call(AutomationSettings, 'PATCH', '/api/automations/settings', patch),
    suggestionsList: (state) =>
      call(z.array(Suggestion), 'GET', `/api/automations/suggestions${state ? `?state=${state}` : ''}`),
    suggestionsRefresh: () => call(Added, 'POST', '/api/automations/suggestions/refresh', {}),
    suggestionsAccept: (id) => call(Accepted, 'POST', `${s(id)}/accept`, { confirm: true }),
    suggestionsDismiss: (id) => call(Suggestion, 'POST', `${s(id)}/dismiss`, {}),
  };
}
```

In `packages/api-contract/src/clients/phase7.ts`, change the two extension lines:
```ts
import { type AutomationsApi, automationsClient } from './automations.ts';

export type Phase7Api = AutomationsApi;

export function phase7Client(call: ApiCall): Phase7Api {
  return { ...automationsClient(call) };
}
```

In `packages/api-contract/src/routes/p7-placeholders.ts`, delete the two `Suggestion` lines. In `packages/api-contract/src/index.ts`, add:
```ts
export * from './routes/automations.ts';
export * from './clients/automations.ts';
export * from './clients/phase7.ts';
```

In `packages/api-contract/src/live.ts`, add `import type { AutomationRunDetail } from './routes/automations.ts';` and append this variant to the `LiveEvent` union:
```ts
  | { type: 'automation.runUpdated'; run: AutomationRunDetail }
```

In `apps/web/src/api/live-events.ts`, add this case to the `switch (e.type)` in `applyLiveEvent`:
```ts
    case 'automation.runUpdated':
      void qc.invalidateQueries({ queryKey: ['automations'] });
      void qc.invalidateQueries({ queryKey: ['automation-runs', e.run.automationId] });
      return;
```

Run: `pnpm vitest run packages/api-contract`
Expected: PASS (automations schema 4 tests, plus the existing suites)

- [ ] **Step 3: Add the tables**

Append to `apps/daemon/src/db/schema.ts` (the `sqliteTable`, `text`, `integer`, `real`, `index` and `uniqueIndex` imports come from `drizzle-orm/sqlite-core`; add the ones that are missing):
```ts
// ── Phase 7: automations ─────────────────────────────────────────────
export const automations = sqliteTable('automations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  triggerJson: text('trigger_json').notNull(),
  actionJson: text('action_json').notNull(),
  budgetUsd: real('budget_usd').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const automationRuns = sqliteTable(
  'automation_runs',
  {
    id: text('id').primaryKey(),
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    triggerKey: text('trigger_key').notNull(),
    triggerSource: text('trigger_source').notNull(),
    varsJson: text('vars_json').notNull().default('{}'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    status: text('status').notNull(),
    sessionPk: text('session_pk'),
    ptyId: text('pty_id'),
    worktreePath: text('worktree_path'),
    costUsd: real('cost_usd'),
    summary: text('summary'),
    prUrl: text('pr_url'),
    diffStatJson: text('diff_stat_json'),
    logPath: text('log_path'),
    error: text('error'),
    rerunOf: text('rerun_of'),
  },
  (t) => [
    uniqueIndex('automation_runs_trigger_key').on(t.automationId, t.triggerKey),
    index('automation_runs_by_automation').on(t.automationId, t.startedAt),
    index('automation_runs_by_status').on(t.status),
  ],
);

export const automationSuggestions = sqliteTable(
  'automation_suggestions',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    projectId: text('project_id'),
    title: text('title').notNull(),
    detail: text('detail').notNull(),
    ticket: text('ticket'),
    file: text('file'),
    line: integer('line'),
    dedupeKey: text('dedupe_key').notNull(),
    state: text('state').notNull().default('new'),
    createdAt: text('created_at').notNull(),
    decidedAt: text('decided_at'),
    runPtyId: text('run_pty_id'),
  },
  (t) => [uniqueIndex('automation_suggestions_dedupe').on(t.dedupeKey), index('automation_suggestions_state').on(t.state, t.createdAt)],
);
```

Run: `pnpm --filter @orc/daemon db:generate`
Expected: a new SQL file in `apps/daemon/src/db/migrations/` with `CREATE TABLE automations`, `automation_runs` and `automation_suggestions`, plus the three indexes.

- [ ] **Step 4: Write the failing repo test**

`apps/daemon/test/p7/automations-repo.test.ts`
```ts
import type { Automation } from '@orc/api-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as repo from '../../src/db/repos/automations.ts';
import * as sugg from '../../src/db/repos/suggestions.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

const auto: Automation = {
  id: 'a1',
  name: 'Daily deps audit',
  enabled: false,
  trigger: { type: 'cron', cron: '0 9 * * 1' },
  action: { templateId: 'deps-audit', projectId: 'wakecap', useWorktree: true, headless: true, timeoutMin: 20, planApproval: false },
  budgetUsd: 5,
};

let ctx: TestContext;
beforeEach(() => {
  ctx = createTestContext();
});
afterEach(() => ctx.dispose());

const newRun = (id: string, key: string, startedAt = '2026-09-10T09:00:00.000Z') => ({
  id, automationId: 'a1', triggerKey: key, triggerSource: 'cron' as const, vars: { ticket: 'SAF-1' },
  startedAt, status: 'queued' as const, rerunOf: null,
});

describe('automations repo', () => {
  it('round-trips automations', () => {
    repo.upsertAutomation(ctx.db, auto, '2026-09-10T00:00:00.000Z');
    expect(repo.getAutomation(ctx.db, 'a1')).toEqual(auto);
    repo.upsertAutomation(ctx.db, { ...auto, name: 'Weekly deps audit', enabled: true }, '2026-09-11T00:00:00.000Z');
    expect(repo.listAutomations(ctx.db).map((a) => [a.name, a.enabled])).toEqual([['Weekly deps audit', true]]);
    repo.deleteAutomation(ctx.db, 'a1');
    expect(repo.getAutomation(ctx.db, 'a1')).toBeNull();
  });

  it('dedupes runs by trigger key and patches them', () => {
    repo.upsertAutomation(ctx.db, auto, '2026-09-10T00:00:00.000Z');
    const r = repo.insertRun(ctx.db, newRun('r1', 'cron:2026-09-10T09:00'));
    expect(r?.status).toBe('queued');
    expect(r?.vars).toEqual({ ticket: 'SAF-1' });
    expect(repo.insertRun(ctx.db, newRun('r2', 'cron:2026-09-10T09:00'))).toBeNull();
    const u = repo.updateRun(ctx.db, 'r1', {
      status: 'success', endedAt: '2026-09-10T09:05:00.000Z', costUsd: 1.5,
      diffStat: { files: 2, insertions: 5, deletions: 1, untracked: 0 }, logPath: '/tmp/r1.jsonl',
    });
    expect(u.diffStat).toEqual({ files: 2, insertions: 5, deletions: 1, untracked: 0 });
    expect(repo.getRunLogPath(ctx.db, 'r1')).toBe('/tmp/r1.jsonl');
    expect(repo.listRuns(ctx.db, 'a1').map((x) => x.id)).toEqual(['r1']);
  });

  it('computes spend, stats and fails stale runs', () => {
    repo.upsertAutomation(ctx.db, auto, '2026-09-10T00:00:00.000Z');
    repo.insertRun(ctx.db, newRun('old', 'k0', '2026-08-30T09:00:00.000Z'));
    repo.updateRun(ctx.db, 'old', { status: 'success', costUsd: 9 });
    repo.insertRun(ctx.db, newRun('r1', 'k1'));
    repo.updateRun(ctx.db, 'r1', { status: 'success', costUsd: 1.25 });
    repo.insertRun(ctx.db, newRun('r2', 'k2', '2026-09-11T09:00:00.000Z'));
    repo.updateRun(ctx.db, 'r2', { status: 'failed', costUsd: 0.5 });
    repo.insertRun(ctx.db, newRun('r3', 'k3', '2026-09-12T09:00:00.000Z'));
    expect(repo.monthSpend(ctx.db, 'a1', '2026-09-01T00:00:00.000Z')).toBeCloseTo(1.75);
    const stats = repo.runStats(ctx.db, 'a1', '2026-09-01T00:00:00.000Z');
    expect(stats).toMatchObject({ total: 4, success: 2, failed: 1, lastRunAt: '2026-09-12T09:00:00.000Z' });
    expect(stats.successRate).toBeCloseTo(2 / 3);
    expect(repo.failStaleRuns(ctx.db, '2026-09-12T10:00:00.000Z')).toBe(1);
    expect(repo.getRun(ctx.db, 'r3')).toMatchObject({ status: 'failed', error: 'daemon restarted while the run was active' });
  });
});

describe('suggestions repo', () => {
  it('dedupes and records decisions', () => {
    const s = { source: 'todo' as const, projectId: 'wakecap', title: 'TODO: remove the flag', detail: 'a.ts:2', ticket: null, file: 'a.ts', line: 2, dedupeKey: 'todo:/r:a.ts:remove the flag' };
    const first = sugg.insertSuggestion(ctx.db, s, '2026-09-10T00:00:00.000Z');
    expect(first?.state).toBe('new');
    expect(sugg.insertSuggestion(ctx.db, s, '2026-09-10T00:01:00.000Z')).toBeNull();
    const id = first?.id ?? '';
    expect(sugg.decideSuggestion(ctx.db, id, 'accepted', '2026-09-10T01:00:00.000Z', 'pty-9')).toMatchObject({ state: 'accepted', runPtyId: 'pty-9' });
    expect(sugg.listSuggestions(ctx.db, 'new')).toEqual([]);
    expect(sugg.listSuggestions(ctx.db).map((x) => x.id)).toEqual([id]);
  });
});
```
Run: `pnpm vitest run apps/daemon/test/p7/automations-repo.test.ts`
Expected: FAIL, `Cannot find module '../../src/db/repos/automations.ts'`

- [ ] **Step 5: Implement the repos and the types module**

`apps/daemon/src/db/repos/automations.ts`
```ts
import type { Automation, AutomationRunDetail, AutomationRunStatus, RunStats, TriggerSource } from '@orc/api-contract';
import { Automation as AutomationSchema, DiffStatSchema } from '@orc/api-contract';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { automationRuns, automations } from '../schema.ts';

export interface NewRun {
  id: string;
  automationId: string;
  triggerKey: string;
  triggerSource: TriggerSource;
  vars: Record<string, string>;
  startedAt: string;
  status: AutomationRunStatus;
  rerunOf: string | null;
}

export type RunPatch = Partial<
  Pick<AutomationRunDetail, 'status' | 'endedAt' | 'sessionPk' | 'costUsd' | 'summary' | 'ptyId' | 'worktreePath' | 'prUrl' | 'diffStat' | 'error'>
> & { logPath?: string | null };

type AutomationRow = typeof automations.$inferSelect;
type RunRow = typeof automationRuns.$inferSelect;

function toAutomation(r: AutomationRow): Automation {
  return AutomationSchema.parse({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    trigger: JSON.parse(r.triggerJson),
    action: JSON.parse(r.actionJson),
    budgetUsd: r.budgetUsd,
  });
}

function toRun(r: RunRow): AutomationRunDetail {
  return {
    id: r.id,
    automationId: r.automationId,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    status: r.status as AutomationRunStatus,
    sessionPk: r.sessionPk,
    costUsd: r.costUsd,
    summary: r.summary,
    triggerKey: r.triggerKey,
    triggerSource: r.triggerSource as TriggerSource,
    vars: JSON.parse(r.varsJson) as Record<string, string>,
    ptyId: r.ptyId,
    worktreePath: r.worktreePath,
    prUrl: r.prUrl,
    diffStat: r.diffStatJson ? DiffStatSchema.parse(JSON.parse(r.diffStatJson)) : null,
    error: r.error,
    rerunOf: r.rerunOf,
  };
}

export function listAutomations(db: OrcDb): Automation[] {
  return db.select().from(automations).orderBy(automations.name).all().map(toAutomation);
}

export function getAutomation(db: OrcDb, id: string): Automation | null {
  const row = db.select().from(automations).where(eq(automations.id, id)).get();
  return row ? toAutomation(row) : null;
}

export function upsertAutomation(db: OrcDb, a: Automation, now: string): Automation {
  const values = {
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    triggerJson: JSON.stringify(a.trigger),
    actionJson: JSON.stringify(a.action),
    budgetUsd: a.budgetUsd,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(automations)
    .values(values)
    .onConflictDoUpdate({
      target: automations.id,
      set: { name: values.name, enabled: values.enabled, triggerJson: values.triggerJson, actionJson: values.actionJson, budgetUsd: values.budgetUsd, updatedAt: now },
    })
    .run();
  const saved = getAutomation(db, a.id);
  if (!saved) throw new Error(`automation ${a.id} was not saved`);
  return saved;
}

export function deleteAutomation(db: OrcDb, id: string): void {
  db.delete(automations).where(eq(automations.id, id)).run();
}

export function insertRun(db: OrcDb, r: NewRun): AutomationRunDetail | null {
  const rows = db
    .insert(automationRuns)
    .values({
      id: r.id,
      automationId: r.automationId,
      triggerKey: r.triggerKey,
      triggerSource: r.triggerSource,
      varsJson: JSON.stringify(r.vars),
      startedAt: r.startedAt,
      status: r.status,
      rerunOf: r.rerunOf,
    })
    .onConflictDoNothing()
    .returning()
    .all();
  const row = rows[0];
  return row ? toRun(row) : null;
}

export function updateRun(db: OrcDb, id: string, patch: RunPatch): AutomationRunDetail {
  const set: Partial<RunRow> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.endedAt !== undefined) set.endedAt = patch.endedAt;
  if (patch.sessionPk !== undefined) set.sessionPk = patch.sessionPk;
  if (patch.costUsd !== undefined) set.costUsd = patch.costUsd;
  if (patch.summary !== undefined) set.summary = patch.summary;
  if (patch.ptyId !== undefined) set.ptyId = patch.ptyId;
  if (patch.worktreePath !== undefined) set.worktreePath = patch.worktreePath;
  if (patch.prUrl !== undefined) set.prUrl = patch.prUrl;
  if (patch.diffStat !== undefined) set.diffStatJson = patch.diffStat ? JSON.stringify(patch.diffStat) : null;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.logPath !== undefined) set.logPath = patch.logPath;
  if (Object.keys(set).length > 0) db.update(automationRuns).set(set).where(eq(automationRuns.id, id)).run();
  const run = getRun(db, id);
  if (!run) throw new Error(`automation run ${id} not found`);
  return run;
}

export function getRun(db: OrcDb, id: string): AutomationRunDetail | null {
  const row = db.select().from(automationRuns).where(eq(automationRuns.id, id)).get();
  return row ? toRun(row) : null;
}

export function getRunLogPath(db: OrcDb, id: string): string | null {
  return db.select({ p: automationRuns.logPath }).from(automationRuns).where(eq(automationRuns.id, id)).get()?.p ?? null;
}

export function listRuns(db: OrcDb, automationId: string, limit = 50): AutomationRunDetail[] {
  return db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.automationId, automationId))
    .orderBy(desc(automationRuns.startedAt))
    .limit(limit)
    .all()
    .map(toRun);
}

export function monthSpend(db: OrcDb, automationId: string, sinceIso: string): number {
  const row = db
    .select({ total: sql<number>`coalesce(sum(${automationRuns.costUsd}), 0)` })
    .from(automationRuns)
    .where(and(eq(automationRuns.automationId, automationId), gte(automationRuns.startedAt, sinceIso)))
    .get();
  return Number(row?.total ?? 0);
}

export function runStats(db: OrcDb, automationId: string, monthStartIso: string): RunStats {
  const rows = db
    .select({ status: automationRuns.status, startedAt: automationRuns.startedAt })
    .from(automationRuns)
    .where(eq(automationRuns.automationId, automationId))
    .all();
  const success = rows.filter((r) => r.status === 'success').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const finished = success + failed;
  const lastRunAt = rows.map((r) => r.startedAt).sort().at(-1) ?? null;
  return {
    total: rows.length,
    success,
    failed,
    successRate: finished > 0 ? success / finished : null,
    lastRunAt,
    monthSpendUsd: monthSpend(db, automationId, monthStartIso),
  };
}

export function failStaleRuns(db: OrcDb, now: string): number {
  const res = db
    .update(automationRuns)
    .set({ status: 'failed', endedAt: now, error: 'daemon restarted while the run was active' })
    .where(inArray(automationRuns.status, ['queued', 'running']))
    .run();
  return res.changes;
}
```

`apps/daemon/src/db/repos/suggestions.ts`
```ts
import { randomUUID } from 'node:crypto';
import type { Suggestion } from '@orc/api-contract';
import { desc, eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { automationSuggestions } from '../schema.ts';

export interface NewSuggestion {
  source: Suggestion['source'];
  projectId: string | null;
  title: string;
  detail: string;
  ticket: string | null;
  file: string | null;
  line: number | null;
  dedupeKey: string;
}

type Row = typeof automationSuggestions.$inferSelect;

const toSuggestion = (r: Row): Suggestion => ({
  id: r.id,
  source: r.source as Suggestion['source'],
  projectId: r.projectId,
  title: r.title,
  detail: r.detail,
  ticket: r.ticket,
  file: r.file,
  line: r.line,
  state: r.state as Suggestion['state'],
  createdAt: r.createdAt,
  decidedAt: r.decidedAt,
  runPtyId: r.runPtyId,
});

export function insertSuggestion(db: OrcDb, s: NewSuggestion, now: string): Suggestion | null {
  const row = db
    .insert(automationSuggestions)
    .values({ id: randomUUID(), ...s, state: 'new', createdAt: now })
    .onConflictDoNothing()
    .returning()
    .all()[0];
  return row ? toSuggestion(row) : null;
}

export function listSuggestions(db: OrcDb, state?: Suggestion['state']): Suggestion[] {
  const q = db.select().from(automationSuggestions);
  const rows = state
    ? q.where(eq(automationSuggestions.state, state)).orderBy(desc(automationSuggestions.createdAt)).all()
    : q.orderBy(desc(automationSuggestions.createdAt)).all();
  return rows.map(toSuggestion);
}

export function getSuggestion(db: OrcDb, id: string): Suggestion | null {
  const row = db.select().from(automationSuggestions).where(eq(automationSuggestions.id, id)).get();
  return row ? toSuggestion(row) : null;
}

export function decideSuggestion(
  db: OrcDb,
  id: string,
  state: 'accepted' | 'dismissed',
  now: string,
  runPtyId: string | null = null,
): Suggestion {
  db.update(automationSuggestions).set({ state, decidedAt: now, runPtyId }).where(eq(automationSuggestions.id, id)).run();
  const s = getSuggestion(db, id);
  if (!s) throw new Error(`suggestion ${id} not found`);
  return s;
}
```

`apps/daemon/src/services/automations/types.ts`
```ts
import type { Automation, AutomationRun } from '@orc/api-contract';

export type { Automation, AutomationRun, AutomationRunDetail } from '@orc/api-contract';

/** Contracts §11 (P7). The implementation adds more members: see AutomationServiceImpl in service.ts. */
export interface AutomationService {
  list(): Automation[];
  save(a: Automation): Automation;
  runNow(id: string): Promise<AutomationRun>;
  runs(id: string): AutomationRun[];
}
```

- [ ] **Step 6: Run the tests, then all checks, and commit**

Run: `pnpm vitest run apps/daemon/test/p7/automations-repo.test.ts packages/api-contract`
Expected: PASS (repo 4 tests, plus the api-contract suites)

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add packages/api-contract apps/daemon/src/db apps/daemon/src/services/automations/types.ts apps/daemon/test/p7/automations-repo.test.ts apps/web/src/api/live-events.ts
git commit -m "feat(automations): add automation tables, repos, schemas and API client"
```

---

### Task 3: Automation guardrails and the headless `claude -p` runner

**Files:**
- Create: `apps/daemon/src/services/automations/guardrails.ts`, `apps/daemon/src/services/automations/headless.ts`, `apps/daemon/test/bin/fake-claude-stream.mjs`
- Test: `apps/daemon/test/p7/guardrails.test.ts`, `apps/daemon/test/p7/headless.test.ts`

**Interfaces:**
- Consumes: `checkDenied`, `redact` (`@orc/core`); `DenyList` (P3); `UsageMeter` (P5); execa 10.
- Produces:
  ```ts
  // guardrails.ts
  export const AUTOMATION_PREAMBLE: string
  export const AUTOMATION_DENY_PATTERNS: string[]
  export const AUTOMATION_ALLOWED_TOOLS: readonly string[]
  export const AUTOMATION_DISALLOWED_TOOLS: readonly string[]
  export const APPROVAL_PROMPT: string
  export function automationClaudeArgs(o: { permissionMode: 'plan' | 'acceptEdits' }): string[]
  export function buildAutomationPrompt(rendered: string): string
  export interface GuardInput { masterEnabled: boolean; renderedPrompt: string; projectId: string; denyList: DenyList; usage: UsageMeter; monthSpendUsd: number; budgetUsd: number }
  export type GuardResult = { ok: true; remainingUsd: number } | { ok: false; status: 'denied' | 'over_budget'; reason: string }
  export function checkAutomationGuards(i: GuardInput): GuardResult
  // headless.ts
  export interface HeadlessRunOptions { command: string; cwd: string; prompt: string; model?: string; permissionMode: 'plan' | 'acceptEdits'; sessionId?: string; resumeSessionId?: string; maxBudgetUsd?: number; timeoutMs: number; logFile: string; env?: Record<string, string>; signal?: AbortSignal }
  export interface HeadlessRunResult { sessionId: string | null; costUsd: number | null; durationMs: number; numTurns: number | null; resultText: string; isError: boolean; subtype: string | null; timedOut: boolean; exitCode: number | null; events: number; stderrTail: string }
  export type HeadlessRunner = (o: HeadlessRunOptions) => Promise<HeadlessRunResult>
  export type StreamEvent =
    | { type: 'init'; sessionId: string; model: string | null }
    | { type: 'assistant_text'; text: string }
    | { type: 'tool_use'; name: string }
    | { type: 'result'; subtype: string; isError: boolean; text: string; sessionId: string; costUsd: number | null; durationMs: number | null; numTurns: number | null }
  export function buildHeadlessArgs(o: HeadlessRunOptions): string[]
  export function parseStreamLine(line: string): StreamEvent | null
  export function formatStreamLine(line: string): string | null     // redacted, human-readable
  export const runHeadless: HeadlessRunner
  ```

- [ ] **Step 1: Write the failing guardrail test**

`apps/daemon/test/p7/guardrails.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_DISALLOWED_TOOLS,
  AUTOMATION_PREAMBLE,
  automationClaudeArgs,
  buildAutomationPrompt,
  checkAutomationGuards,
} from '../../src/services/automations/guardrails.ts';
import { fakeDenyList, fakeUsage } from '../fakes/phase7.ts';

const input = (over: Partial<Parameters<typeof checkAutomationGuards>[0]> = {}) => ({
  masterEnabled: true,
  renderedPrompt: 'Fix the failing check on https://github.com/example-org/svc/pull/12',
  projectId: 'wakecap',
  denyList: fakeDenyList(),
  usage: fakeUsage(),
  monthSpendUsd: 2,
  budgetUsd: 10,
  ...over,
});

describe('checkAutomationGuards', () => {
  it('passes a benign prompt and reports the remaining budget', () => {
    expect(checkAutomationGuards(input())).toEqual({ ok: true, remainingUsd: 8 });
  });

  it('denies everything while the master switch is off', () => {
    expect(checkAutomationGuards(input({ masterEnabled: false }))).toMatchObject({ ok: false, status: 'denied' });
  });

  it.each([
    'then run terraform apply in infra',
    'merge the PR once checks are green',
    'gh pr merge 12 --squash',
    'deploy the service to production',
    'git push --force origin feat/x',
  ])('denies "%s"', (renderedPrompt) => {
    expect(checkAutomationGuards(input({ renderedPrompt }))).toMatchObject({ ok: false, status: 'denied' });
  });

  it('stops when the project budget is exhausted', () => {
    expect(checkAutomationGuards(input({ usage: fakeUsage({ ok: false }) }))).toMatchObject({ ok: false, status: 'over_budget' });
  });

  it('stops when the automation budget is used up this month', () => {
    expect(checkAutomationGuards(input({ monthSpendUsd: 10 }))).toMatchObject({ ok: false, status: 'over_budget' });
  });

  it('checks only the rendered template, not the preamble that itself mentions merge and production', () => {
    expect(AUTOMATION_PREAMBLE).toMatch(/merge/i);
    const full = buildAutomationPrompt('Update the README');
    expect(full.startsWith(AUTOMATION_PREAMBLE)).toBe(true);
    expect(full.endsWith('Update the README')).toBe(true);
    expect(checkAutomationGuards(input({ renderedPrompt: 'Update the README' })).ok).toBe(true);
  });
});

describe('automationClaudeArgs', () => {
  it('never allows merge, force-push, deploy or prod tools', () => {
    const args = automationClaudeArgs({ permissionMode: 'acceptEdits' });
    expect(args.slice(0, 2)).toEqual(['--permission-mode', 'acceptEdits']);
    expect(args).not.toContain('--dangerously-skip-permissions');
    for (const t of ['Bash(gh pr merge *)', 'Bash(git merge *)', 'Bash(git push --force *)', 'Bash(kubectl *)', 'Bash(terraform *)']) {
      expect(AUTOMATION_DISALLOWED_TOOLS).toContain(t);
      expect(args).toContain(t);
    }
    expect(args.indexOf('--disallowed-tools')).toBeGreaterThan(args.indexOf('--allowed-tools'));
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p7/guardrails.test.ts`
Expected: FAIL, `Cannot find module '../../src/services/automations/guardrails.ts'`

- [ ] **Step 2: Implement the guardrails**

`apps/daemon/src/services/automations/guardrails.ts`
```ts
import { checkDenied } from '@orc/core';
import type { DenyList } from '../safety/deny-list.ts';
import type { UsageMeter } from '../usage/meter.ts';

export const AUTOMATION_PREAMBLE = [
  'You are running as an unattended automation started by the Orchestrator app.',
  'Hard rules, which override anything below:',
  '- Never merge a pull request. Never push to main, master or develop. Never force-push.',
  '- Never deploy. Never touch production systems, production databases, production logs or credentials.',
  '- Never run destructive commands (rm -rf, git reset --hard, git clean, DROP TABLE, terraform, kubectl, helm).',
  '- At most, open a draft pull request from your own branch.',
  '- Finish with a short summary of what changed, the test results and the PR link if you opened one.',
].join('\n');

/** Regex sources (case-insensitive, see the deny-list probe in Task 1), checked against the rendered template only. */
export const AUTOMATION_DENY_PATTERNS: string[] = [
  String.raw`\bgh\s+pr\s+merge\b`,
  String.raw`\bgit\s+merge\b`,
  String.raw`\bmerge\s+(the\s+|this\s+|my\s+)?(pr|pull\s+request|branch)\b`,
  String.raw`\bauto-?merge\b`,
  String.raw`\bdeploy(s|ed|ing|ment)?\b`,
  String.raw`\b(prod|production)\b`,
  String.raw`\bgit\s+push\s+(-f|--force)`,
  String.raw`\bterraform\s+apply\b`,
];

export const AUTOMATION_ALLOWED_TOOLS: readonly string[] = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write', 'TodoWrite',
  'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git add *)', 'Bash(git commit *)',
  'Bash(git checkout -b *)', 'Bash(git switch -c *)', 'Bash(git push -u origin *)',
  'Bash(pnpm *)', 'Bash(npm test *)', 'Bash(npm run *)', 'Bash(npx vitest *)',
  'Bash(gh pr create *)', 'Bash(gh pr view *)', 'Bash(gh pr checks *)', 'Bash(gh run view *)',
];

export const AUTOMATION_DISALLOWED_TOOLS: readonly string[] = [
  'Bash(gh pr merge *)', 'Bash(gh pr merge)', 'Bash(git merge *)',
  'Bash(git push --force *)', 'Bash(git push -f *)', 'Bash(git push --force-with-lease *)',
  'Bash(git push origin main*)', 'Bash(git push origin master*)', 'Bash(git push origin develop*)',
  'Bash(git push -u origin main*)', 'Bash(git push -u origin master*)', 'Bash(git push -u origin develop*)',
  'Bash(git reset --hard *)', 'Bash(git clean *)', 'Bash(rm -rf *)',
  'Bash(kubectl *)', 'Bash(terraform *)', 'Bash(helm *)', 'Bash(aws *)', 'Bash(psql *)',
  'Bash(gh workflow run *)', 'Bash(gh release *)', 'Bash(npm publish *)', 'Bash(pnpm publish *)',
  'WebFetch',
];

export const APPROVAL_PROMPT =
  'The plan is approved. Implement it now, following the hard rules from the start of this conversation: never merge, never deploy, never touch production. Finish with a summary and the draft PR link if you opened one.';

export function automationClaudeArgs(o: { permissionMode: 'plan' | 'acceptEdits' }): string[] {
  return [
    '--permission-mode',
    o.permissionMode,
    '--allowed-tools',
    ...AUTOMATION_ALLOWED_TOOLS,
    '--disallowed-tools',
    ...AUTOMATION_DISALLOWED_TOOLS,
  ];
}

export function buildAutomationPrompt(rendered: string): string {
  return `${AUTOMATION_PREAMBLE}\n\n---\n\n${rendered}`;
}

export interface GuardInput {
  masterEnabled: boolean;
  renderedPrompt: string;
  projectId: string;
  denyList: DenyList;
  usage: UsageMeter;
  monthSpendUsd: number;
  budgetUsd: number;
}

export type GuardResult =
  | { ok: true; remainingUsd: number }
  | { ok: false; status: 'denied' | 'over_budget'; reason: string };

export function checkAutomationGuards(i: GuardInput): GuardResult {
  if (!i.masterEnabled) return { ok: false, status: 'denied', reason: 'Automations are turned off in Settings' };
  const shared = i.denyList.check(i.renderedPrompt, i.projectId);
  if (shared.denied) return { ok: false, status: 'denied', reason: `Deny-list: ${shared.reason ?? 'matched'}` };
  const own = checkDenied(i.renderedPrompt, AUTOMATION_DENY_PATTERNS);
  if (own.denied) return { ok: false, status: 'denied', reason: `Automation rule: ${own.reason ?? 'merge/deploy/prod'}` };
  const project = i.usage.checkBudget({ projectId: i.projectId });
  if (!project.ok) {
    return { ok: false, status: 'over_budget', reason: `Project budget at ${Math.round(project.pct * 100)}%` };
  }
  const remaining = Math.round((i.budgetUsd - i.monthSpendUsd) * 100) / 100;
  if (remaining <= 0) {
    return {
      ok: false,
      status: 'over_budget',
      reason: `Automation budget used: $${i.monthSpendUsd.toFixed(2)} of $${i.budgetUsd.toFixed(2)} this month`,
    };
  }
  return { ok: true, remainingUsd: remaining };
}
```

Run: `pnpm vitest run apps/daemon/test/p7/guardrails.test.ts`
Expected: PASS (11 tests). If the `terraform apply` case passes only because of `AUTOMATION_DENY_PATTERNS`, that is fine: both lists are checked.

- [ ] **Step 3: Write the fake `claude` and the failing runner test**

`apps/daemon/test/bin/fake-claude-stream.mjs`
```js
#!/usr/bin/env node
// Fake `claude -p --output-format stream-json`. Modes: success | plan | error | hang (env FAKE_MODE).
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
if (process.env.FAKE_ARGS_FILE) appendFileSync(process.env.FAKE_ARGS_FILE, `${JSON.stringify({ args, stdin })}\n`);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sid = flag('--resume') ?? flag('--session-id') ?? 'fake-session';
const mode = process.env.FAKE_MODE ?? 'success';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-sonnet-5', cwd: process.cwd(), tools: ['Read'] });
if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  out({
    type: 'assistant',
    session_id: sid,
    message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } }] },
  });
  out({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  process.stdout.write('this line is not json\n');
  if (mode === 'error') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, duration_ms: 500, num_turns: 1, total_cost_usd: 0.02 });
    process.exit(1);
  }
  const text =
    mode === 'plan'
      ? 'Plan:\n1. Update the flaky test\n2. Fix the retry logic'
      : 'Done. Opened https://github.com/example-org/svc/pull/12 (password=hunter2)';
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, duration_ms: 1234, num_turns: 3, total_cost_usd: 0.42 });
}
```

`apps/daemon/test/p7/headless.test.ts`
```ts
import { chmodSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildHeadlessArgs,
  formatStreamLine,
  type HeadlessRunOptions,
  parseStreamLine,
  runHeadless,
} from '../../src/services/automations/headless.ts';

const FAKE = fileURLToPath(new URL('../bin/fake-claude-stream.mjs', import.meta.url));
beforeAll(() => chmodSync(FAKE, 0o755));

const opts = (over: Partial<HeadlessRunOptions> = {}): HeadlessRunOptions => {
  const dir = mkdtempSync(join(tmpdir(), 'orc-p7-headless-'));
  return {
    command: FAKE,
    cwd: dir,
    prompt: 'PROMPT BODY',
    permissionMode: 'acceptEdits',
    sessionId: '22222222-2222-4222-8222-222222222222',
    timeoutMs: 10_000,
    logFile: join(dir, 'logs', 'run.jsonl'),
    env: { FAKE_ARGS_FILE: join(dir, 'args.jsonl') },
    ...over,
  };
};

describe('buildHeadlessArgs', () => {
  it('builds a print-mode stream-json command without a positional prompt', () => {
    const args = buildHeadlessArgs(opts({ model: 'claude-sonnet-5', maxBudgetUsd: 7.5 }));
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(args).toContain('Bash(gh pr merge *)');
    expect(args.join(' ')).toContain('--permission-prompts none');
    expect(args.join(' ')).toContain('--model claude-sonnet-5');
    expect(args.join(' ')).toContain('--max-budget-usd 7.50');
    expect(args.join(' ')).toContain('--session-id 22222222-2222-4222-8222-222222222222');
    expect(args).not.toContain('PROMPT BODY');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('resumes instead of setting a session id', () => {
    const args = buildHeadlessArgs(opts({ resumeSessionId: 'abc' }));
    expect(args.join(' ')).toContain('--resume abc');
    expect(args).not.toContain('--session-id');
  });
});

describe('parseStreamLine / formatStreamLine', () => {
  it('parses init, assistant text, tool use and result', () => {
    expect(parseStreamLine('{"type":"system","subtype":"init","session_id":"s1","model":"m"}')).toEqual({ type: 'init', sessionId: 's1', model: 'm' });
    expect(parseStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}')).toEqual({ type: 'assistant_text', text: 'hi' });
    expect(parseStreamLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]}}')).toEqual({ type: 'tool_use', name: 'Bash' });
    expect(parseStreamLine('{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1","total_cost_usd":0.1,"duration_ms":5,"num_turns":1}')).toEqual({
      type: 'result', subtype: 'success', isError: false, text: 'ok', sessionId: 's1', costUsd: 0.1, durationMs: 5, numTurns: 1,
    });
    expect(parseStreamLine('garbage')).toBeNull();
    expect(parseStreamLine('{"type":"user","message":{}}')).toBeNull();
  });

  it('formats lines for the run log with redaction', () => {
    expect(formatStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"token=abc123"}]}}')).toBe('token=«redacted:secret»');
    expect(formatStreamLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{}}]}}')).toBe('→ Edit');
    expect(formatStreamLine('{"type":"result","subtype":"success","is_error":false,"result":"x","session_id":"s","total_cost_usd":0.5}')).toBe('■ success · $0.50');
    expect(formatStreamLine('nope')).toBeNull();
  });
});

describe('runHeadless (fake claude)', () => {
  it('streams a successful run, sends the prompt on stdin and writes a private log', async () => {
    const o = opts();
    const r = await runHeadless(o);
    expect(r).toMatchObject({
      sessionId: '22222222-2222-4222-8222-222222222222',
      costUsd: 0.42,
      numTurns: 3,
      isError: false,
      subtype: 'success',
      timedOut: false,
      exitCode: 0,
    });
    expect(r.resultText).toContain('pull/12');
    expect(r.events).toBe(4);
    const call = JSON.parse(readFileSync(o.env?.FAKE_ARGS_FILE ?? '', 'utf8').trim()) as { stdin: string };
    expect(call.stdin).toBe('PROMPT BODY');
    expect(statSync(o.logFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(o.logFile, 'utf8')).toContain('"type":"result"');
  });

  it('reports claude errors', async () => {
    const r = await runHeadless(opts({ env: { FAKE_MODE: 'error' } }));
    expect(r).toMatchObject({ isError: true, costUsd: 0.02, exitCode: 1, subtype: 'error_during_execution' });
  });

  it('kills a run that exceeds the timeout', async () => {
    const r = await runHeadless(opts({ env: { FAKE_MODE: 'hang' }, timeoutMs: 400 }));
    expect(r.timedOut).toBe(true);
    expect(r.isError).toBe(true);
    expect(r.sessionId).toBe('22222222-2222-4222-8222-222222222222');
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p7/headless.test.ts`
Expected: FAIL, `Cannot find module '../../src/services/automations/headless.ts'`

- [ ] **Step 4: Implement the runner**

`apps/daemon/src/services/automations/headless.ts`
```ts
import { chmodSync, createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { redact } from '@orc/core';
import { execa } from 'execa';
import { z } from 'zod';
import { automationClaudeArgs } from './guardrails.ts';

export interface HeadlessRunOptions {
  command: string;
  cwd: string;
  prompt: string;
  model?: string;
  permissionMode: 'plan' | 'acceptEdits';
  sessionId?: string;
  resumeSessionId?: string;
  maxBudgetUsd?: number;
  timeoutMs: number;
  logFile: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface HeadlessRunResult {
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number;
  numTurns: number | null;
  resultText: string;
  isError: boolean;
  subtype: string | null;
  timedOut: boolean;
  exitCode: number | null;
  events: number;
  stderrTail: string;
}

export type HeadlessRunner = (o: HeadlessRunOptions) => Promise<HeadlessRunResult>;

export type StreamEvent =
  | { type: 'init'; sessionId: string; model: string | null }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_use'; name: string }
  | {
      type: 'result';
      subtype: string;
      isError: boolean;
      text: string;
      sessionId: string;
      costUsd: number | null;
      durationMs: number | null;
      numTurns: number | null;
    };

const InitLine = z.object({ type: z.literal('system'), subtype: z.literal('init'), session_id: z.string(), model: z.string().optional() }).loose();
const AssistantLine = z
  .object({ type: z.literal('assistant'), message: z.object({ content: z.array(z.unknown()) }).loose() })
  .loose();
const ResultLine = z
  .object({
    type: z.literal('result'),
    subtype: z.string(),
    is_error: z.boolean().default(false),
    result: z.string().optional(),
    session_id: z.string(),
    total_cost_usd: z.number().optional(),
    duration_ms: z.number().optional(),
    num_turns: z.number().optional(),
  })
  .loose();
const TextBlock = z.object({ type: z.literal('text'), text: z.string() }).loose();
const ToolBlock = z.object({ type: z.literal('tool_use'), name: z.string() }).loose();

export function parseStreamLine(line: string): StreamEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const init = InitLine.safeParse(value);
  if (init.success) return { type: 'init', sessionId: init.data.session_id, model: init.data.model ?? null };
  const res = ResultLine.safeParse(value);
  if (res.success) {
    return {
      type: 'result',
      subtype: res.data.subtype,
      isError: res.data.is_error,
      text: res.data.result ?? '',
      sessionId: res.data.session_id,
      costUsd: res.data.total_cost_usd ?? null,
      durationMs: res.data.duration_ms ?? null,
      numTurns: res.data.num_turns ?? null,
    };
  }
  const asst = AssistantLine.safeParse(value);
  if (asst.success) {
    const texts: string[] = [];
    let tool: string | null = null;
    for (const block of asst.data.message.content) {
      const t = TextBlock.safeParse(block);
      if (t.success && t.data.text.trim()) texts.push(t.data.text);
      const u = ToolBlock.safeParse(block);
      if (u.success && tool === null) tool = u.data.name;
    }
    if (texts.length > 0) return { type: 'assistant_text', text: texts.join('\n') };
    if (tool !== null) return { type: 'tool_use', name: tool };
  }
  return null;
}

export function formatStreamLine(line: string): string | null {
  const ev = parseStreamLine(line);
  if (!ev) return null;
  switch (ev.type) {
    case 'init':
      return `● session ${ev.sessionId}${ev.model ? ` (${ev.model})` : ''}`;
    case 'assistant_text':
      return redact(ev.text);
    case 'tool_use':
      return `→ ${ev.name}`;
    case 'result':
      return `■ ${ev.subtype}${ev.costUsd !== null ? ` · $${ev.costUsd.toFixed(2)}` : ''}`;
  }
}

export function buildHeadlessArgs(o: HeadlessRunOptions): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none'];
  if (o.model) args.push('--model', o.model);
  if (o.resumeSessionId) args.push('--resume', o.resumeSessionId);
  else if (o.sessionId) args.push('--session-id', o.sessionId);
  if (o.maxBudgetUsd !== undefined) args.push('--max-budget-usd', o.maxBudgetUsd.toFixed(2));
  // Variadic tool lists go last; the prompt is sent on stdin, so nothing positional follows them.
  args.push(...automationClaudeArgs({ permissionMode: o.permissionMode }));
  return args;
}

export const runHeadless: HeadlessRunner = async (o) => {
  mkdirSync(dirname(o.logFile), { recursive: true, mode: 0o700 });
  writeFileSync(o.logFile, '', { flag: 'a', mode: 0o600 });
  chmodSync(o.logFile, 0o600);
  const log = createWriteStream(o.logFile, { flags: 'a' });
  const started = Date.now();
  const sub = execa(o.command, buildHeadlessArgs(o), {
    cwd: o.cwd,
    input: o.prompt,
    timeout: o.timeoutMs,
    forceKillAfterDelay: 3_000,
    reject: false,
    buffer: { stdout: false, stderr: true },
    env: { ...o.env, ORC_AUTOMATION: '1' },
    cancelSignal: o.signal,
  });
  let sessionId: string | null = o.resumeSessionId ?? o.sessionId ?? null;
  let result: Extract<StreamEvent, { type: 'result' }> | null = null;
  let lastText = '';
  let events = 0;
  if (sub.stdout) {
    const rl = createInterface({ input: sub.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of rl) {
      if (!line.trim()) continue;
      log.write(`${line}\n`);
      const ev = parseStreamLine(line);
      if (!ev) continue;
      events++;
      if (ev.type === 'init') sessionId = ev.sessionId;
      else if (ev.type === 'assistant_text') lastText = ev.text;
      else if (ev.type === 'result') {
        result = ev;
        sessionId = ev.sessionId;
      }
    }
  }
  const done = await sub;
  await new Promise<void>((resolve) => log.end(resolve));
  const timedOut = Boolean(done.timedOut);
  return {
    sessionId,
    costUsd: result?.costUsd ?? null,
    durationMs: result?.durationMs ?? Date.now() - started,
    numTurns: result?.numTurns ?? null,
    resultText: result?.text || lastText,
    isError: timedOut || (result ? result.isError : true),
    subtype: result?.subtype ?? null,
    timedOut,
    exitCode: done.exitCode ?? null,
    events,
    stderrTail: String(done.stderr ?? '').slice(-2000),
  };
};
```
Run: `pnpm vitest run apps/daemon/test/p7/headless.test.ts`
Expected: PASS (7 tests). The timeout test takes about 0.5 s.

- [ ] **Step 5: Check the real CLI's event shape (manual, read-only, cheap)**

Run: `cd "$(mktemp -d)" && echo "Reply with the single word ok" | claude -p --output-format stream-json --verbose --no-session-persistence --model claude-haiku-4-5 --tools "" --max-budget-usd 0.05 | head -c 2000`
Expected: JSON lines. The first has `"type":"system","subtype":"init"` with `session_id`, and the last has `"type":"result"` with `total_cost_usd`, `duration_ms`, `num_turns` and `result`. If any key name differs, update `InitLine`/`ResultLine` and the fake script, and paste the redacted key list into the task review note. `--no-session-persistence` keeps this probe out of `~/.claude/projects`.

- [ ] **Step 6: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/daemon/src/services/automations apps/daemon/test/bin/fake-claude-stream.mjs apps/daemon/test/p7/guardrails.test.ts apps/daemon/test/p7/headless.test.ts
git commit -m "feat(automations): add guardrails and headless stream-json runner"
```

---

### Task 4: AutomationService core (queue, guards, worktree, headless/PTY run, result → inbox + audit)

**Files:**
- Create: `apps/daemon/src/services/automations/service.ts`, `apps/daemon/src/services/automations/pty-wait.ts`
- Test: `apps/daemon/test/p7/automation-service.test.ts`, `apps/daemon/test/p7/never-merge.test.ts`

**Interfaces:**
- Consumes: repos (Task 2); guardrails and `runHeadless` (Task 3); `diffStat`, `defaultBranch`, `spawnClaudeSession`, `assertOwnedCapacity` (Task 1); `ctx.templates.render` (P2), `ctx.denyList` (P3, `services/safety/deny-list.ts`), `ctx.usage` (P5), `ctx.worktrees.createWith` (P4), `ctx.recaps.recap` (P5), `ctx.inbox.upsert` (P2), `ctx.audit.record` (P3), `ctx.sessions.getByPk` (P1), `splitPk` (P2 core), `ServiceError` (P1); bus events `session.statusChanged`, `pty.exited`; croner 10.
- Produces:
  ```ts
  // service.ts
  export interface TriggerFire { key: string; source: TriggerSource; vars: Record<string, string>; rerunOf?: string | null }
  export interface AutomationDeps { ctx: DaemonContext; runner?: HeadlessRunner; now?: () => Date }
  export interface AutomationServiceImpl extends AutomationService {
    get(id: string): Automation | null;
    listWithStats(): AutomationWithStats[];
    remove(id: string): void;
    setEnabled(id: string, enabled: boolean): Automation;
    start(id: string, fire: TriggerFire): Promise<AutomationRunDetail | null>;
    runs(id: string): AutomationRunDetail[];                 // narrows the §11 AutomationRun[]
    run(runId: string): AutomationRunDetail | null;
    waitFor(runId: string): Promise<AutomationRunDetail>;   // resolves on success|failed|denied|over_budget|awaiting_approval
    logLines(runId: string): string[];
    onChange(fn: (id: string, a: Automation | null) => void): () => void;
    stop(): void;
  }
  export function createAutomationService(deps: AutomationDeps): AutomationServiceImpl
  export function nextRunAt(a: Automation, from?: Date): string | null
  export function validateCron(expr: string): void           // ServiceError 400 validation_failed
  export function findPrUrl(text: string): string | null
  export function monthStartIso(d: Date): string
  // pty-wait.ts
  export type PtyTurnOutcome = { kind: 'done'; status: LiveStatus } | { kind: 'exited'; code: number | null } | { kind: 'timeout' }
  export function waitForPtyTurn(bus: EventBus, pk: string, ptyId: string, timeoutMs: number): Promise<PtyTurnOutcome>
  ```
  Inbox: kind `automation_result`, dedupe key `automation-run:<runId>`, payload `{ source, id, automationId, runId, status, prUrl, diffStat, worktreePath, summary, costUsd }`. Audit: `automation.run` with actor `automation`, `actorDetail` = automation name, result `ok` / `error` / `denied`. Saving, enabling and deleting an automation are audited as `settings.update` with actor `user`.

- [ ] **Step 1: Write the failing service test**

`apps/daemon/test/p7/automation-service.test.ts`
```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Automation } from '@orc/api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as repo from '../../src/db/repos/automations.ts';
import { ServiceError } from '../../src/services/errors.ts';
import { AUTOMATION_PREAMBLE } from '../../src/services/automations/guardrails.ts';
import type { HeadlessRunner, HeadlessRunOptions, HeadlessRunResult } from '../../src/services/automations/headless.ts';
import { createAutomationService, findPrUrl, monthStartIso } from '../../src/services/automations/service.ts';
import { createTestContext, type TestContext } from '../helpers.ts';
import {
  createFakePty,
  fakeAudit,
  fakeDenyList,
  fakeInbox,
  fakeProjects,
  fakeRecaps,
  fakeShip,
  fakeTemplates,
  fakeUsage,
  fakeWorktrees,
  testConfig,
} from '../fakes/phase7.ts';

const okResult = (o: HeadlessRunOptions, over: Partial<HeadlessRunResult> = {}): HeadlessRunResult => ({
  sessionId: o.resumeSessionId ?? o.sessionId ?? 's',
  costUsd: 0.5,
  durationMs: 1000,
  numTurns: 3,
  resultText: 'Opened https://github.com/example-org/svc/pull/12',
  isError: false,
  subtype: 'success',
  timedOut: false,
  exitCode: 0,
  events: 5,
  stderrTail: '',
  ...over,
});

const auto = (over: Partial<Automation> = {}): Automation => ({
  id: 'a1',
  name: 'Fix CI',
  enabled: true,
  trigger: { type: 'manual' },
  action: { templateId: 'fix-ci', projectId: 'wakecap', useWorktree: true, headless: true, timeoutMin: 5, planApproval: false },
  budgetUsd: 10,
  ...over,
});

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

function setup(o: { cfg?: Record<string, unknown>; runner?: HeadlessRunner; usageOk?: boolean } = {}) {
  const cfg = testConfig({ automations: { enabled: true, maxConcurrent: 2 }, ...o.cfg });
  const inbox = fakeInbox();
  const audit = fakeAudit();
  const worktrees = fakeWorktrees();
  const ship = fakeShip();
  const pty = createFakePty();
  const recaps = fakeRecaps();
  ctx = createTestContext({
    config: () => cfg,
    projects: fakeProjects(cfg),
    inbox,
    audit,
    worktrees,
    ship,
    pty,
    recaps,
    launcher: undefined,
    usage: fakeUsage({ ok: o.usageOk ?? true }),
    denyList: fakeDenyList(),
    templates: fakeTemplates({ 'fix-ci': 'Fix the failing check on {{prUrl}}', danger: 'deploy the api to production' }),
  });
  const calls: HeadlessRunOptions[] = [];
  const runner: HeadlessRunner =
    o.runner ??
    (async (opts) => {
      calls.push(opts);
      return okResult(opts);
    });
  const svc = createAutomationService({ ctx, runner });
  return { ctx, svc, inbox, audit, worktrees, ship, pty, recaps, calls };
}

describe('AutomationService.runNow (headless)', () => {
  it('runs in a new worktree and reports to inbox and audit', async () => {
    const t = setup();
    t.svc.save(auto());
    const run = await t.svc.runNow('a1');
    expect(run.status).toBe('success');
    const detail = t.svc.run(run.id);
    expect(detail).toMatchObject({ costUsd: 0.5, prUrl: 'https://github.com/example-org/svc/pull/12', summary: 'Fixed the flaky test and opened a draft PR.' });
    expect(t.worktrees.created[0]?.branch).toMatch(/^chore\/auto-fix-ci-/);
    const call = t.calls[0];
    expect(call?.cwd).toBe(t.worktrees.created[0]?.path);
    expect(call?.permissionMode).toBe('acceptEdits');
    expect(call?.maxBudgetUsd).toBe(10);
    expect(call?.prompt.startsWith(AUTOMATION_PREAMBLE)).toBe(true);
    expect(call?.prompt).toContain('Fix the failing check on');
    expect(t.recaps.calls).toEqual([detail?.sessionPk]);
    const item = t.inbox.items.find((i) => i.kind === 'automation_result');
    expect(item?.dedupeKey).toBe(`automation-run:${run.id}`);
    expect(item?.payload).toMatchObject({ source: 'claude', runId: run.id, prUrl: 'https://github.com/example-org/svc/pull/12' });
    const entry = t.audit.entries.find((e) => e.action === 'automation.run');
    expect(entry).toMatchObject({ actor: 'automation', actorDetail: 'Fix CI', result: 'ok' });
  });

  it('denies every run while the master switch is off', async () => {
    const t = setup({ cfg: { automations: { enabled: false } } });
    t.svc.save(auto());
    const run = await t.svc.runNow('a1');
    expect(run.status).toBe('denied');
    expect(t.calls).toHaveLength(0);
    expect(t.worktrees.created).toHaveLength(0);
    expect(t.audit.entries.find((e) => e.action === 'automation.run')?.result).toBe('denied');
    expect(t.inbox.items[0]?.reason).toContain('turned off');
  });

  it('denies a template that asks for a deploy', async () => {
    const t = setup();
    t.svc.save(auto({ action: { ...auto().action, templateId: 'danger' } }));
    expect((await t.svc.runNow('a1')).status).toBe('denied');
    expect(t.calls).toHaveLength(0);
  });

  it('stops on project budget and on the automation monthly budget', async () => {
    const t = setup({ usageOk: false });
    t.svc.save(auto());
    expect((await t.svc.runNow('a1')).status).toBe('over_budget');

    const u = setup();
    u.svc.save(auto({ budgetUsd: 1 }));
    const prior = repo.insertRun(u.ctx.db, {
      id: 'prior', automationId: 'a1', triggerKey: 'manual:prior', triggerSource: 'manual', vars: {},
      startedAt: monthStartIso(new Date()), status: 'success', rerunOf: null,
    });
    expect(prior).not.toBeNull();
    repo.updateRun(u.ctx.db, 'prior', { costUsd: 1 });
    expect((await u.svc.runNow('a1')).status).toBe('over_budget');
    expect(u.calls).toHaveLength(0);
  });

  it('handles a trigger key only once', async () => {
    const t = setup();
    t.svc.save(auto());
    const first = await t.svc.start('a1', { key: 'github:x#1:check_failed:t1', source: 'github', vars: {} });
    const second = await t.svc.start('a1', { key: 'github:x#1:check_failed:t1', source: 'github', vars: {} });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    if (first) await t.svc.waitFor(first.id);
  });

  it('respects the concurrency cap by queueing', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const calls: HeadlessRunOptions[] = [];
    const t = setup({
      cfg: { automations: { enabled: true, maxConcurrent: 1 } },
      runner: async (o) => {
        calls.push(o);
        if (calls.length === 1) await gate;
        return okResult(o);
      },
    });
    t.svc.save(auto());
    const r1 = await t.svc.start('a1', { key: 'manual:1', source: 'manual', vars: {} });
    const r2 = await t.svc.start('a1', { key: 'manual:2', source: 'manual', vars: {} });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(t.svc.run(r2?.id ?? '')?.status).toBe('queued');
    release();
    expect((await t.svc.waitFor(r1?.id ?? '')).status).toBe('success');
    expect((await t.svc.waitFor(r2?.id ?? '')).status).toBe('success');
    expect(calls).toHaveLength(2);
  });

  it('marks timeouts and crashes as failed', async () => {
    const t = setup({ runner: async (o) => okResult(o, { isError: true, timedOut: true, resultText: '' }) });
    t.svc.save(auto());
    const run = await t.svc.runNow('a1');
    expect(run.status).toBe('failed');
    expect(t.svc.run(run.id)?.error).toBe('timed out after 5 min');
    expect(t.audit.entries.find((e) => e.action === 'automation.run')?.result).toBe('error');

    const u = setup({
      runner: async () => {
        throw new Error('spawn claude ENOENT');
      },
    });
    u.svc.save(auto());
    const crashed = await u.svc.runNow('a1');
    expect(crashed.status).toBe('failed');
    expect(u.svc.run(crashed.id)?.error).toBe('spawn claude ENOENT');
    expect(u.inbox.items.some((i) => i.kind === 'automation_result')).toBe(true);
  });

  it('turns the stream log into readable, redacted lines', async () => {
    const t = setup({
      runner: async (o) => {
        mkdirSync(dirname(o.logFile), { recursive: true });
        writeFileSync(o.logFile, '{"type":"assistant","message":{"content":[{"type":"text","text":"password=hunter2"}]}}\n');
        return okResult(o);
      },
    });
    t.svc.save(auto());
    const run = await t.svc.runNow('a1');
    expect(t.svc.logLines(run.id)).toEqual(['password=«redacted:secret»']);
  });
});

describe('AutomationService (PTY mode)', () => {
  it('spawns an owned session with restricted tools and finishes when the turn ends', async () => {
    const t = setup();
    t.svc.save(auto({ action: { ...auto().action, headless: false, useWorktree: false } }));
    const started = await t.svc.start('a1', { key: 'manual:pty', source: 'manual', vars: {} });
    await vi.waitFor(() => expect(t.pty.spawned).toHaveLength(1));
    const spawned = t.pty.spawned[0];
    expect(spawned?.args).toContain('--disallowed-tools');
    expect(spawned?.args).toContain('Bash(gh pr merge *)');
    expect(spawned?.args).not.toContain('--dangerously-skip-permissions');
    const pk = spawned?.sessionPk ?? '';
    expect(pk).toMatch(/^claude:/);
    t.ctx.bus.emit({ type: 'session.statusChanged', pk, from: null, to: 'busy' });
    t.ctx.bus.emit({ type: 'session.statusChanged', pk, from: 'busy', to: 'idle' });
    const done = await t.svc.waitFor(started?.id ?? '');
    expect(done).toMatchObject({ status: 'success', sessionPk: pk, ptyId: spawned?.id });
    expect(t.pty.killed).toEqual([]);
  });
});

describe('AutomationService management', () => {
  it('validates cron, computes the next run and audits changes', () => {
    const t = setup();
    expect(() => t.svc.save(auto({ trigger: { type: 'cron', cron: 'not a cron' } }))).toThrow(ServiceError);
    const saved = t.svc.save(auto({ trigger: { type: 'cron', cron: '0 9 * * 1-5' } }));
    expect(t.svc.listWithStats()[0]?.nextRunAt).not.toBeNull();
    expect(t.svc.setEnabled(saved.id, false).enabled).toBe(false);
    expect(t.svc.listWithStats()[0]?.nextRunAt).toBeNull();
    const changes: string[] = [];
    t.svc.onChange((id, a) => changes.push(`${id}:${a ? 'saved' : 'removed'}`));
    t.svc.remove(saved.id);
    expect(changes).toEqual(['a1:removed']);
    expect(t.audit.entries.filter((e) => e.action === 'settings.update')).toHaveLength(3);
  });

  it('fails runs left active by a previous daemon', () => {
    const t = setup();
    t.svc.save(auto());
    repo.insertRun(t.ctx.db, { id: 'stale', automationId: 'a1', triggerKey: 'manual:stale', triggerSource: 'manual', vars: {}, startedAt: '2026-09-01T00:00:00.000Z', status: 'running', rerunOf: null });
    createAutomationService({ ctx: t.ctx, runner: async (o) => okResult(o) });
    expect(repo.getRun(t.ctx.db, 'stale')?.status).toBe('failed');
  });

  it('finds PR links', () => {
    expect(findPrUrl('see https://github.com/example-org/svc/pull/7.')).toBe('https://github.com/example-org/svc/pull/7');
    expect(findPrUrl('no link')).toBeNull();
  });
});

describe('never merge (runtime)', () => {
  it('never calls ShipService.merge, even when the model talks about merging', async () => {
    const t = setup({ runner: async (o) => okResult(o, { resultText: 'Ready to merge: gh pr merge 12' }) });
    t.svc.save(auto());
    await t.svc.runNow('a1');
    expect(t.ship.calls).not.toContain('merge');
    expect(readFileSync(new URL('../../src/services/automations/guardrails.ts', import.meta.url), 'utf8')).toContain("'Bash(gh pr merge *)'");
  });
});
```

`apps/daemon/test/p7/never-merge.test.ts`
```ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
// Phase 7 code that runs without a human in the loop. It must never be able to merge or ship.
const GUARDED_DIRS = ['services/automations', 'services/supervisor', 'connectors/linear/assigned-poller.ts', 'connectors/slack/mention-poller.ts'];

function files(p: string): string[] {
  const abs = join(SRC, p);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs).flatMap((n) => files(join(p, n)));
}

describe('automation and supervisor code cannot merge', () => {
  const all = GUARDED_DIRS.flatMap(files).filter((f) => f.endsWith('.ts'));

  it('finds the guarded files', () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it.each(all.map((f) => [f.slice(SRC.length), f]))('%s has no merge or ship calls', (_name, file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/\.merge\s*\(/);
    expect(text).not.toMatch(/ctx\.ship\b/);
    expect(text).not.toMatch(/from ['"][./]*(services\/)?ship\//);
    expect(text).not.toMatch(/\bplans?\.approve\s*\(/);
  });
});
```
The last assertion stops unattended code from approving a Claude plan through P4's `PlanApprovalService`. Task 5's `approve(runId)` lives in the guarded folder, but it is only reachable from a user route with `confirm: true`, and it resumes the automation's own headless session. It never calls `plans.approve`.

Run: `pnpm vitest run apps/daemon/test/p7/automation-service.test.ts apps/daemon/test/p7/never-merge.test.ts`
Expected: FAIL, `Cannot find module '../../src/services/automations/service.ts'`

- [ ] **Step 2: Implement the PTY wait helper**

`apps/daemon/src/services/automations/pty-wait.ts`
```ts
import type { LiveStatus } from '@orc/core';
import type { EventBus } from '../../live/event-bus.ts';

export type PtyTurnOutcome =
  | { kind: 'done'; status: LiveStatus }
  | { kind: 'exited'; code: number | null }
  | { kind: 'timeout' };

const TURN_END: ReadonlySet<LiveStatus> = new Set<LiveStatus>(['idle', 'waiting', 'review', 'blocked', 'error']);

/** Resolves when the owned session has been busy and then stops (idle/waiting/review/…), exits, or times out. */
export function waitForPtyTurn(bus: EventBus, pk: string, ptyId: string, timeoutMs: number): Promise<PtyTurnOutcome> {
  return new Promise((resolve) => {
    let sawBusy = false;
    const offs: Array<() => void> = [];
    const finish = (o: PtyTurnOutcome) => {
      clearTimeout(timer);
      for (const off of offs) off();
      resolve(o);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    offs.push(
      bus.on('session.statusChanged', (e) => {
        if (e.pk !== pk) return;
        if (e.to === 'busy') sawBusy = true;
        else if (sawBusy && TURN_END.has(e.to)) finish({ kind: 'done', status: e.to });
      }),
    );
    offs.push(
      bus.on('pty.exited', (e) => {
        if (e.ptyId === ptyId) finish({ kind: 'exited', code: e.code });
      }),
    );
  });
}
```

- [ ] **Step 3: Implement the service**

`apps/daemon/src/services/automations/service.ts`
```ts
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Automation,
  type AutomationRunDetail,
  Automation as AutomationSchema,
  type AutomationWithStats,
  type TriggerSource,
} from '@orc/api-contract';
import { type AuditEntry, redact, splitPk } from '@orc/core';
import { Cron } from 'croner';
import type { DaemonContext } from '../../context.ts';
import * as repo from '../../db/repos/automations.ts';
import { ServiceError } from '../errors.ts';
import { defaultBranch, diffStat } from '../git/git-info.ts';
import { assertOwnedCapacity, spawnClaudeSession } from '../launch/spawn.ts';
import { automationClaudeArgs, buildAutomationPrompt, checkAutomationGuards, type GuardResult } from './guardrails.ts';
import { formatStreamLine, type HeadlessRunner, type HeadlessRunResult, runHeadless } from './headless.ts';
import { waitForPtyTurn } from './pty-wait.ts';
import type { AutomationService } from './types.ts';

export interface TriggerFire {
  key: string;
  source: TriggerSource;
  vars: Record<string, string>;
  rerunOf?: string | null;
}

export interface AutomationDeps {
  ctx: DaemonContext;
  runner?: HeadlessRunner;
  now?: () => Date;
}

export interface AutomationServiceImpl extends AutomationService {
  get(id: string): Automation | null;
  listWithStats(): AutomationWithStats[];
  remove(id: string): void;
  setEnabled(id: string, enabled: boolean): Automation;
  start(id: string, fire: TriggerFire): Promise<AutomationRunDetail | null>;
  runs(id: string): AutomationRunDetail[];
  run(runId: string): AutomationRunDetail | null;
  waitFor(runId: string): Promise<AutomationRunDetail>;
  logLines(runId: string): string[];
  onChange(fn: (id: string, a: Automation | null) => void): () => void;
  stop(): void;
}

const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
export function findPrUrl(text: string): string | null {
  return PR_URL_RE.exec(text)?.[0] ?? null;
}

export function monthStartIso(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export function validateCron(expr: string): void {
  try {
    new Cron(expr, { paused: true }).stop();
  } catch (e) {
    throw new ServiceError('validation_failed', 400, `invalid cron expression: ${(e as Error).message}`);
  }
}

export function nextRunAt(a: Automation, from: Date = new Date()): string | null {
  if (!a.enabled || a.trigger.type !== 'cron') return null;
  try {
    const job = new Cron(a.trigger.cron, { paused: true });
    const next = job.nextRun(from);
    job.stop();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'automation';

const TERMINAL = new Set<AutomationRunDetail['status']>(['success', 'failed', 'denied', 'over_budget', 'awaiting_approval']);

function required<T>(svc: T | undefined, name: string): T {
  if (svc === undefined) throw new ServiceError('not_enabled', 409, `${name} service is not running`);
  return svc;
}

interface Pending {
  runId: string;
  prompt: string;
  remainingUsd: number;
}

type RunOutcome = Pick<HeadlessRunResult, 'resultText' | 'isError' | 'timedOut' | 'costUsd'>;

export function createAutomationService(deps: AutomationDeps): AutomationServiceImpl {
  const { ctx } = deps;
  const runner = deps.runner ?? runHeadless;
  const now = deps.now ?? (() => new Date());
  const nowIso = () => now().toISOString();
  const queue: Pending[] = [];
  const active = new Set<string>();
  const waiters = new Map<string, Array<(r: AutomationRunDetail) => void>>();
  const listeners = new Set<(id: string, a: Automation | null) => void>();
  let stopped = false;

  repo.failStaleRuns(ctx.db, nowIso());

  const logPath = (runId: string) => join(ctx.paths.orcHome, 'logs', 'automations', `${runId}.jsonl`);

  function emit(run: AutomationRunDetail): void {
    ctx.bus.emit({ type: 'automation.runUpdated', run });
    if (!TERMINAL.has(run.status)) return;
    const ws = waiters.get(run.id);
    if (!ws) return;
    waiters.delete(run.id);
    for (const w of ws) w(run);
  }

  function update(id: string, patch: repo.RunPatch): AutomationRunDetail {
    const r = repo.updateRun(ctx.db, id, patch);
    emit(r);
    return r;
  }

  function mustGet(id: string): Automation {
    const a = repo.getAutomation(ctx.db, id);
    if (!a) throw new ServiceError('not_found', 404, `automation ${id} not found`);
    return a;
  }

  function sessionRef(pk: string | null): { source: string | null; id: string | null } {
    if (!pk) return { source: null, id: null };
    const { source, id } = splitPk(pk);
    return { source, id };
  }

  function notify(a: Automation, run: AutomationRunDetail): void {
    const ref = sessionRef(run.sessionPk);
    const firstLine = run.summary?.split('\n')[0]?.slice(0, 120);
    required(ctx.inbox, 'inbox').upsert({
      kind: 'automation_result',
      dedupeKey: `automation-run:${run.id}`,
      sessionId: ref.id,
      projectId: a.action.projectId,
      ticket: run.vars.ticket ?? null,
      reason: `${a.name}: ${run.status.replace('_', ' ')}${firstLine ? ` — ${firstLine}` : ''}`,
      payload: {
        source: ref.source,
        id: ref.id,
        automationId: a.id,
        runId: run.id,
        status: run.status,
        prUrl: run.prUrl,
        diffStat: run.diffStat,
        worktreePath: run.worktreePath,
        summary: run.summary,
        costUsd: run.costUsd,
      },
    });
  }

  function audit(a: Automation, run: AutomationRunDetail, result: AuditEntry['result'], error: string | null, extra: Record<string, unknown> = {}): void {
    required(ctx.audit, 'audit').record({
      actor: 'automation',
      actorDetail: a.name,
      action: 'automation.run',
      target: run.sessionPk ?? `automation-run:${run.id}`,
      params: {
        automationId: a.id,
        runId: run.id,
        trigger: run.triggerSource,
        triggerKey: run.triggerKey,
        status: run.status,
        costUsd: run.costUsd,
        worktreePath: run.worktreePath,
        prUrl: run.prUrl,
        headless: a.action.headless,
        ...extra,
      },
      result,
      error,
    });
  }

  function auditUser(action: string, target: string, params: Record<string, unknown>): void {
    required(ctx.audit, 'audit').record({ actor: 'user', actorDetail: null, action, target, params, result: 'ok', error: null });
  }

  function finishEarly(a: Automation, run: AutomationRunDetail, status: 'denied' | 'over_budget' | 'failed', reason: string): AutomationRunDetail {
    const r = update(run.id, { status, endedAt: nowIso(), summary: reason, error: status === 'failed' ? reason : null });
    notify(a, r);
    audit(a, r, status === 'failed' ? 'error' : 'denied', reason);
    return r;
  }

  function guard(a: Automation, rendered: string): GuardResult {
    return checkAutomationGuards({
      masterEnabled: ctx.config().automations.enabled,
      renderedPrompt: rendered,
      projectId: a.action.projectId,
      denyList: required(ctx.denyList, 'deny-list'),
      usage: required(ctx.usage, 'usage'),
      monthSpendUsd: repo.monthSpend(ctx.db, a.id, monthStartIso(now())),
      budgetUsd: a.budgetUsd,
    });
  }

  function repoPath(a: Automation): string {
    const project = ctx.projects.get(a.action.projectId);
    if (!project) throw new ServiceError('not_found', 404, `project ${a.action.projectId} not found`);
    const path = a.action.repo ?? project.repos[0]?.path ?? project.pathPrefixes[0];
    if (!path) throw new ServiceError('validation_failed', 400, `project ${project.id} has no repository path`);
    return path;
  }

  async function prepareCwd(a: Automation, run: AutomationRunDetail): Promise<string> {
    const repoDir = repoPath(a);
    if (!a.action.useWorktree) return repoDir;
    const base = await defaultBranch(repoDir);
    const { view } = await required(ctx.worktrees, 'worktrees').createWith(
      {
        repo: repoDir,
        base,
        type: run.triggerSource === 'github' ? 'fix' : 'chore',
        ticket: run.vars.ticket ?? null,
        slug: `auto-${slugify(a.name)}-${run.id.slice(0, 6)}`,
      },
      { runSetup: false, actor: 'automation' },
    );
    return view.path;
  }

  async function finalize(a: Automation, runId: string, res: RunOutcome): Promise<AutomationRunDetail> {
    const run = repo.getRun(ctx.db, runId);
    if (!run) throw new ServiceError('not_found', 404, `automation run ${runId} not found`);
    let diff: AutomationRunDetail['diffStat'] = null;
    if (run.worktreePath) {
      try {
        diff = await diffStat(run.worktreePath, await defaultBranch(run.worktreePath));
      } catch {
        diff = null;
      }
    }
    const session = run.sessionPk ? ctx.sessions.getByPk(run.sessionPk) : null;
    const prUrl = findPrUrl(res.resultText) ?? session?.prs[0]?.url ?? null;
    let summary: string | null = redact(res.resultText).slice(0, 2000) || null;
    if (run.sessionPk && ctx.recaps && !res.isError) {
      try {
        summary = (await ctx.recaps.recap(run.sessionPk)).text;
      } catch {
        // keep the redacted result text
      }
    }
    const status = res.isError ? 'failed' : 'success';
    const error = res.timedOut
      ? `timed out after ${a.action.timeoutMin} min`
      : res.isError
        ? 'claude reported an error'
        : null;
    const updated = update(run.id, { status, endedAt: nowIso(), prUrl, diffStat: diff, summary, error, costUsd: res.costUsd ?? run.costUsd });
    notify(a, updated);
    audit(a, updated, status === 'success' ? 'ok' : 'error', error);
    return updated;
  }

  async function executeHeadless(a: Automation, runId: string, cwd: string, p: Pending): Promise<void> {
    const res = await runner({
      command: ctx.config().resumeProfile.claudeCommand,
      cwd,
      prompt: p.prompt,
      model: a.action.model,
      permissionMode: a.action.planApproval ? 'plan' : 'acceptEdits',
      sessionId: randomUUID(),
      maxBudgetUsd: p.remainingUsd,
      timeoutMs: a.action.timeoutMin * 60_000,
      logFile: logPath(runId),
    });
    const sessionPk = res.sessionId ? `claude:${res.sessionId}` : null;
    const run = update(runId, { sessionPk, costUsd: res.costUsd, logPath: logPath(runId) });
    if (a.action.planApproval && !res.isError) {
      const waiting = update(run.id, { status: 'awaiting_approval', summary: redact(res.resultText).slice(0, 4000) });
      required(ctx.inbox, 'inbox').upsert({
        kind: 'plan_approval',
        dedupeKey: `automation-plan:${run.id}`,
        sessionId: res.sessionId,
        projectId: a.action.projectId,
        ticket: run.vars.ticket ?? null,
        reason: `${a.name}: plan awaiting approval`,
        payload: { source: 'claude', id: res.sessionId, automationId: a.id, runId: run.id, plan: waiting.summary },
      });
      audit(a, waiting, 'ok', null, { phase: 'plan' });
      return;
    }
    await finalize(a, run.id, res);
  }

  async function executePty(a: Automation, runId: string, cwd: string, p: Pending): Promise<void> {
    assertOwnedCapacity(ctx, a.action.projectId);
    const spawned = spawnClaudeSession(ctx, {
      cwd,
      prompt: p.prompt,
      model: a.action.model ?? null,
      args: automationClaudeArgs({ permissionMode: a.action.planApproval ? 'plan' : 'acceptEdits' }),
    });
    update(runId, { sessionPk: spawned.sessionPk, ptyId: spawned.ptyId });
    const outcome = await waitForPtyTurn(ctx.bus, spawned.sessionPk ?? '', spawned.ptyId, a.action.timeoutMin * 60_000);
    if (outcome.kind === 'timeout') ctx.pty.kill(spawned.ptyId);
    const session = spawned.sessionPk ? ctx.sessions.getByPk(spawned.sessionPk) : null;
    const waitingForPlan = outcome.kind === 'done' && outcome.status === 'waiting' && a.action.planApproval;
    await finalize(a, runId, {
      resultText: waitingForPlan
        ? 'The session is waiting for plan approval in its terminal.'
        : (session?.awaySummary ?? session?.lastPrompt ?? ''),
      isError: outcome.kind === 'timeout' || (outcome.kind === 'exited' && outcome.code !== 0),
      timedOut: outcome.kind === 'timeout',
      costUsd: session?.usage.costUsd ?? null,
    });
  }

  async function execute(p: Pending): Promise<void> {
    let a: Automation | null = null;
    try {
      const run = update(p.runId, { status: 'running' });
      a = mustGet(run.automationId);
      const cwd = await prepareCwd(a, run);
      update(run.id, { worktreePath: a.action.useWorktree ? cwd : null });
      if (a.action.headless) await executeHeadless(a, run.id, cwd, p);
      else await executePty(a, run.id, cwd, p);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const failed = update(p.runId, { status: 'failed', endedAt: nowIso(), error: msg, summary: `Failed: ${msg}` });
      if (a) {
        notify(a, failed);
        audit(a, failed, 'error', msg);
      }
    }
  }

  function drain(): void {
    if (stopped) return;
    const max = ctx.config().automations.maxConcurrent;
    while (queue.length > 0 && active.size < max) {
      const next = queue.shift();
      if (!next) break;
      active.add(next.runId);
      void execute(next).finally(() => {
        active.delete(next.runId);
        drain();
      });
    }
  }

  async function start(id: string, fire: TriggerFire): Promise<AutomationRunDetail | null> {
    const a = mustGet(id);
    const run = repo.insertRun(ctx.db, {
      id: randomUUID(),
      automationId: id,
      triggerKey: fire.key,
      triggerSource: fire.source,
      vars: fire.vars,
      startedAt: nowIso(),
      status: 'queued',
      rerunOf: fire.rerunOf ?? null,
    });
    if (!run) return null;
    emit(run);
    let rendered: string;
    try {
      rendered = required(ctx.templates, 'templates').render(a.action.templateId, fire.vars);
    } catch (e) {
      return finishEarly(a, run, 'failed', `Template error: ${(e as Error).message}`);
    }
    const g = guard(a, rendered);
    if (!g.ok) return finishEarly(a, run, g.status, g.reason);
    queue.push({ runId: run.id, prompt: buildAutomationPrompt(rendered), remainingUsd: g.remainingUsd });
    drain();
    return repo.getRun(ctx.db, run.id);
  }

  function waitFor(runId: string): Promise<AutomationRunDetail> {
    const r = repo.getRun(ctx.db, runId);
    if (!r) return Promise.reject(new ServiceError('not_found', 404, `automation run ${runId} not found`));
    if (TERMINAL.has(r.status)) return Promise.resolve(r);
    return new Promise((resolve) => {
      const list = waiters.get(runId) ?? [];
      list.push(resolve);
      waiters.set(runId, list);
    });
  }

  function save(input: Automation): Automation {
    const a = AutomationSchema.parse(input);
    if (a.trigger.type === 'cron') validateCron(a.trigger.cron);
    const saved = repo.upsertAutomation(ctx.db, a, nowIso());
    auditUser('settings.update', `automation:${saved.id}`, { op: 'save', name: saved.name, enabled: saved.enabled, trigger: saved.trigger.type });
    for (const l of listeners) l(saved.id, saved);
    return saved;
  }

  const api: AutomationServiceImpl = {
    list: () => repo.listAutomations(ctx.db),
    get: (id) => repo.getAutomation(ctx.db, id),
    listWithStats: () =>
      repo.listAutomations(ctx.db).map((a) => ({
        ...a,
        stats: repo.runStats(ctx.db, a.id, monthStartIso(now())),
        nextRunAt: nextRunAt(a, now()),
      })),
    save,
    remove(id) {
      mustGet(id);
      repo.deleteAutomation(ctx.db, id);
      auditUser('settings.update', `automation:${id}`, { op: 'delete' });
      for (const l of listeners) l(id, null);
    },
    setEnabled(id, enabled) {
      const a = mustGet(id);
      return save({ ...a, enabled });
    },
    start,
    async runNow(id) {
      const r = await start(id, { key: `manual:${randomUUID()}`, source: 'manual', vars: {} });
      if (!r) throw new ServiceError('invalid_state', 409, 'manual run was not created');
      return waitFor(r.id);
    },
    runs: (id) => repo.listRuns(ctx.db, id),
    run: (runId) => repo.getRun(ctx.db, runId),
    waitFor,
    logLines(runId) {
      const path = repo.getRunLogPath(ctx.db, runId);
      if (!path || !existsSync(path)) return [];
      return readFileSync(path, 'utf8')
        .split('\n')
        .map((l) => (l.trim() ? formatStreamLine(l) : null))
        .filter((l): l is string => l !== null)
        .slice(-2000);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stop() {
      stopped = true;
      queue.length = 0;
    },
  };
  return api;
}
```
Two notes for the implementer:
- `ctx.bus.emit({ type: 'automation.runUpdated', … })` typechecks because Task 2 added the variant to `LiveEvent`, which `BusEvent` includes.
- `required()` is local on purpose, so that the service never imports the HTTP layer.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/test/p7/automation-service.test.ts apps/daemon/test/p7/never-merge.test.ts`
Expected: PASS (automation-service 12 tests; never-merge 1 test plus 1 per guarded file)

- [ ] **Step 5: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/daemon/src/services/automations apps/daemon/test/p7/automation-service.test.ts apps/daemon/test/p7/never-merge.test.ts
git commit -m "feat(automations): run automations with guards, queue, worktree and inbox results"
```

---

### Task 5: Automation plan approval, reject and rerun

**Files:**
- Modify: `apps/daemon/src/services/automations/service.ts`
- Test: `apps/daemon/test/p7/automation-approval.test.ts`

**Interfaces:**
- Consumes: everything from Task 4; `APPROVAL_PROMPT` (Task 3); `ctx.inbox.resolve` (P2).
- Produces (added to `AutomationServiceImpl`):
  ```ts
  approve(runId: string): Promise<AutomationRunDetail>   // awaiting_approval → running → success|failed|denied|over_budget; status is 'running' synchronously once the checks pass
  reject(runId: string): AutomationRunDetail             // awaiting_approval → failed ("Plan rejected by user")
  rerun(runId: string): Promise<AutomationRunDetail | null>   // new run with the same vars, source 'rerun', rerunOf = runId
  ```
  Approval re-checks the guards: the master switch, the **re-rendered template** against both deny-lists, the **plan text** against the shared deny-list, and both budgets. It then resumes the same headless session with `--resume <id>` and `acceptEdits`. The cost of the run is the plan cost plus the implementation cost. Audit entries: `automation.approve` and `automation.reject` with actor `user`.

- [ ] **Step 1: Write the failing test**

`apps/daemon/test/p7/automation-approval.test.ts`
```ts
import type { Automation } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { ServiceError } from '../../src/services/errors.ts';
import { APPROVAL_PROMPT } from '../../src/services/automations/guardrails.ts';
import type { HeadlessRunOptions, HeadlessRunResult } from '../../src/services/automations/headless.ts';
import { createAutomationService } from '../../src/services/automations/service.ts';
import { createTestContext, type TestContext } from '../helpers.ts';
import {
  createFakePty,
  fakeAudit,
  fakeDenyList,
  fakeInbox,
  fakeProjects,
  fakeRecaps,
  fakeTemplates,
  fakeUsage,
  fakeWorktrees,
  testConfig,
} from '../fakes/phase7.ts';

const planned: Automation = {
  id: 'p1',
  name: 'Implement assigned ticket',
  enabled: true,
  trigger: { type: 'manual' },
  action: { templateId: 'impl', projectId: 'wakecap', useWorktree: false, headless: true, timeoutMin: 10, planApproval: true },
  budgetUsd: 10,
};

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

function setup(planText = 'Plan:\n1. Add the weekend check\n2. Add a test') {
  const cfg = testConfig({ automations: { enabled: true } });
  const inbox = fakeInbox();
  const audit = fakeAudit();
  const usage = fakeUsage();
  ctx = createTestContext({
    config: () => cfg,
    projects: fakeProjects(cfg),
    inbox,
    audit,
    usage,
    pty: createFakePty(),
    worktrees: fakeWorktrees(),
    recaps: fakeRecaps(),
    denyList: fakeDenyList(),
    launcher: undefined,
    templates: fakeTemplates({ impl: 'Implement {{ticket}}' }),
  });
  const calls: HeadlessRunOptions[] = [];
  const svc = createAutomationService({
    ctx,
    runner: async (o): Promise<HeadlessRunResult> => {
      calls.push(o);
      const plan = o.permissionMode === 'plan';
      return {
        sessionId: o.resumeSessionId ?? o.sessionId ?? 'x',
        costUsd: plan ? 0.25 : 0.75,
        durationMs: 10,
        numTurns: 1,
        resultText: plan ? planText : 'Implemented. https://github.com/example-org/svc/pull/31',
        isError: false,
        subtype: 'success',
        timedOut: false,
        exitCode: 0,
        events: 3,
        stderrTail: '',
      };
    },
  });
  svc.save(planned);
  return { svc, inbox, audit, usage, calls };
}

async function awaitingRun(t: ReturnType<typeof setup>) {
  const started = await t.svc.start('p1', { key: 'manual:plan', source: 'manual', vars: { ticket: 'SAF-9' } });
  const run = await t.svc.waitFor(started?.id ?? '');
  expect(run.status).toBe('awaiting_approval');
  return run;
}

describe('automation plan approval', () => {
  it('stops after planning, then resumes the same session on approval', async () => {
    const t = setup();
    const run = await awaitingRun(t);
    expect(t.calls[0]?.permissionMode).toBe('plan');
    const planItem = t.inbox.items.find((i) => i.kind === 'plan_approval');
    expect(planItem).toMatchObject({ dedupeKey: `automation-plan:${run.id}`, ticket: 'SAF-9' });
    expect(planItem?.payload).toMatchObject({ runId: run.id, plan: expect.stringContaining('weekend') });

    const pending = t.svc.approve(run.id);
    expect(t.svc.run(run.id)?.status).toBe('running');
    const done = await pending;
    expect(done).toMatchObject({ status: 'success', costUsd: 1, prUrl: 'https://github.com/example-org/svc/pull/31' });
    const resume = t.calls[1];
    expect(resume?.resumeSessionId).toBe(t.calls[0]?.sessionId);
    expect(resume?.permissionMode).toBe('acceptEdits');
    expect(resume?.prompt).toBe(APPROVAL_PROMPT);
    expect(t.inbox.resolved).toContain(`automation-plan:${run.id}`);
    expect(t.audit.entries.find((e) => e.action === 'automation.approve')).toMatchObject({ actor: 'user', result: 'ok' });
  });

  it('refuses to approve a run that is not waiting', async () => {
    const t = setup();
    const run = await awaitingRun(t);
    await t.svc.approve(run.id);
    await expect(t.svc.approve(run.id)).rejects.toBeInstanceOf(ServiceError);
  });

  it('denies approval when the plan hits the deny-list', async () => {
    const t = setup('Plan:\n1. terraform apply the new queue\n2. update code');
    const run = await awaitingRun(t);
    const res = await t.svc.approve(run.id);
    expect(res.status).toBe('denied');
    expect(t.calls).toHaveLength(1);
  });

  it('stops approval when the budget ran out in the meantime', async () => {
    const t = setup();
    const run = await awaitingRun(t);
    t.usage.state.ok = false;
    expect((await t.svc.approve(run.id)).status).toBe('over_budget');
    expect(t.calls).toHaveLength(1);
  });

  it('rejects a plan', async () => {
    const t = setup();
    const run = await awaitingRun(t);
    const r = t.svc.reject(run.id);
    expect(r).toMatchObject({ status: 'failed', summary: 'Plan rejected by user' });
    expect(t.inbox.resolved).toContain(`automation-plan:${run.id}`);
    expect(t.audit.entries.find((e) => e.action === 'automation.reject')?.actor).toBe('user');
    expect(() => t.svc.reject(run.id)).toThrow(ServiceError);
  });

  it('reruns with the same vars', async () => {
    const t = setup();
    const run = await awaitingRun(t);
    const again = await t.svc.rerun(run.id);
    expect(again).toMatchObject({ triggerSource: 'rerun', rerunOf: run.id, vars: { ticket: 'SAF-9' } });
    await t.svc.waitFor(again?.id ?? '');
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p7/automation-approval.test.ts`
Expected: FAIL, `t.svc.approve is not a function`

- [ ] **Step 2: Add approve, reject and rerun to the service**

In `apps/daemon/src/services/automations/service.ts`:

1. Import `APPROVAL_PROMPT` together with the other guardrail imports.
2. Add three members to `AutomationServiceImpl`:
```ts
  approve(runId: string): Promise<AutomationRunDetail>;
  reject(runId: string): AutomationRunDetail;
  rerun(runId: string): Promise<AutomationRunDetail | null>;
```
3. Inside `createAutomationService`, add these functions directly above `const api: AutomationServiceImpl = {`:
```ts
  function mustGetRun(runId: string): AutomationRunDetail {
    const run = repo.getRun(ctx.db, runId);
    if (!run) throw new ServiceError('not_found', 404, `automation run ${runId} not found`);
    return run;
  }

  function mustAwait(run: AutomationRunDetail): string {
    if (run.status !== 'awaiting_approval' || !run.sessionPk) {
      throw new ServiceError('invalid_state', 409, `run ${run.id} is not awaiting plan approval (status ${run.status})`);
    }
    return run.sessionPk;
  }

  async function approve(runId: string): Promise<AutomationRunDetail> {
    const run = mustGetRun(runId);
    const pk = mustAwait(run);
    const a = mustGet(run.automationId);
    required(ctx.inbox, 'inbox').resolve(`automation-plan:${run.id}`);
    auditUser('automation.approve', `automation-run:${run.id}`, { automationId: a.id, sessionPk: pk });

    let rendered: string;
    try {
      rendered = required(ctx.templates, 'templates').render(a.action.templateId, run.vars);
    } catch (e) {
      return finishEarly(a, run, 'failed', `Template error: ${(e as Error).message}`);
    }
    const g = guard(a, rendered);
    if (!g.ok) return finishEarly(a, run, g.status, g.reason);
    const planVerdict = required(ctx.denyList, 'deny-list').check(run.summary ?? '', a.action.projectId);
    if (planVerdict.denied) {
      return finishEarly(a, run, 'denied', `The plan matches the deny-list: ${planVerdict.reason ?? 'matched'}`);
    }

    update(run.id, { status: 'running' });
    active.add(run.id);
    try {
      const res = await runner({
        command: ctx.config().resumeProfile.claudeCommand,
        cwd: run.worktreePath ?? repoPath(a),
        prompt: APPROVAL_PROMPT,
        model: a.action.model,
        permissionMode: 'acceptEdits',
        resumeSessionId: splitPk(pk).id,
        maxBudgetUsd: g.remainingUsd,
        timeoutMs: a.action.timeoutMin * 60_000,
        logFile: logPath(run.id),
      });
      return await finalize(a, run.id, { ...res, costUsd: (run.costUsd ?? 0) + (res.costUsd ?? 0) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const failed = update(run.id, { status: 'failed', endedAt: nowIso(), error: msg, summary: `Failed: ${msg}` });
      notify(a, failed);
      audit(a, failed, 'error', msg, { phase: 'implement' });
      return failed;
    } finally {
      active.delete(run.id);
      drain();
    }
  }

  function reject(runId: string): AutomationRunDetail {
    const run = mustGetRun(runId);
    mustAwait(run);
    required(ctx.inbox, 'inbox').resolve(`automation-plan:${run.id}`);
    auditUser('automation.reject', `automation-run:${run.id}`, { automationId: run.automationId });
    return update(run.id, { status: 'failed', endedAt: nowIso(), summary: 'Plan rejected by user', error: null });
  }

  async function rerun(runId: string): Promise<AutomationRunDetail | null> {
    const run = mustGetRun(runId);
    return start(run.automationId, { key: `rerun:${randomUUID()}`, source: 'rerun', vars: run.vars, rerunOf: run.id });
  }
```
4. Add `approve, reject, rerun,` to the `api` object literal (next to `start,`).

`approve` is `async`, but everything before `await runner(…)` runs synchronously. So a route that calls `svc.approve(id)` without awaiting it can read `status: 'running'` (or the denial) right away. Task 9 relies on this.

- [ ] **Step 3: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/test/p7/automation-approval.test.ts apps/daemon/test/p7/automation-service.test.ts apps/daemon/test/p7/never-merge.test.ts`
Expected: PASS (approval 6 tests, and the Task 4 suites are still green)

- [ ] **Step 4: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/daemon/src/services/automations/service.ts apps/daemon/test/p7/automation-approval.test.ts
git commit -m "feat(automations): add plan approval, reject and rerun for automation runs"
```

---

### Task 6: Cron triggers (P5 scheduler jobs, fired at most once per minute)

**Files:**
- Create: `apps/daemon/src/services/automations/schedules.ts`
- Test: `apps/daemon/test/p7/automation-schedules.test.ts`

**Interfaces:**
- Consumes: P5's `Scheduler` (`add`, `remove`, `list`, `onFire`, `get`, `start`, `stop`), `ensureCronJob(s, kind, type, cron, extra?)` and `removeJobsOfType(s, kind, type)` from `apps/daemon/src/services/scheduler/scheduler.ts`; `AutomationServiceImpl` (Task 4).
- Produces:
  ```ts
  // services/automations/schedules.ts
  export type ScheduleHost = Pick<AutomationServiceImpl, 'list' | 'get' | 'start' | 'onChange'>
  export function jobType(automationId: string): string          // `automation:<id>`
  export function floorToMinute(d: Date): string                 // UTC ISO with seconds and ms zeroed
  export function attachAutomationSchedules(svc: ScheduleHost, scheduler: Scheduler, now?: () => Date): () => void
  ```
  Rules:
  - P5's scheduler already fires cron jobs with croner (`protect: true`, no catch-up after downtime) and supports several handlers per kind, so Phase 7 adds **no** scheduler machinery. It only keeps one `automation` job per enabled cron automation, through `ensureCronJob`/`removeJobsOfType`.
  - The handler computes `scheduledFor = floorToMinute(now())` and starts the run with the trigger key `cron:<scheduledFor>`. The unique index on `(automation_id, trigger_key)` from Task 2 makes the run **at most once per automation per minute**, even if two timers or two daemons fire.
  - A disabled or deleted automation loses its job immediately (through `onChange`), and the handler checks `enabled` again before starting.

- [ ] **Step 1: Write the failing test**

`apps/daemon/test/p7/automation-schedules.test.ts`
```ts
import type { Automation, AutomationRunDetail } from '@orc/api-contract';
import { describe, expect, it, vi } from 'vitest';
import { attachAutomationSchedules, floorToMinute, jobType, type ScheduleHost } from '../../src/services/automations/schedules.ts';
import type { TriggerFire } from '../../src/services/automations/service.ts';
import { createMemoryScheduler } from '../fakes/phase7.ts';

const cronAuto = (over: Partial<Automation> = {}): Automation => ({
  id: 'c1',
  name: 'Weekday digest',
  enabled: true,
  trigger: { type: 'cron', cron: '0 9 * * 1-5' },
  action: { templateId: 't', projectId: 'wakecap', useWorktree: false, headless: true, timeoutMin: 5, planApproval: false },
  budgetUsd: 2,
  ...over,
});

function host(initial: Automation[]) {
  const store = new Map(initial.map((a) => [a.id, a] as const));
  const listeners = new Set<(id: string, a: Automation | null) => void>();
  const starts: Array<{ id: string; fire: TriggerFire }> = [];
  const h: ScheduleHost = {
    list: () => [...store.values()],
    get: (id) => store.get(id) ?? null,
    async start(id, fire) {
      starts.push({ id, fire });
      return null as AutomationRunDetail | null;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const change = (a: Automation | null, id: string) => {
    if (a) store.set(id, a);
    else store.delete(id);
    for (const l of listeners) l(id, a);
  };
  return { h, change, starts };
}

describe('attachAutomationSchedules', () => {
  it('floors fire times to the minute', () => {
    expect(floorToMinute(new Date('2026-09-17T09:00:42.123Z'))).toBe('2026-09-17T09:00:00.000Z');
    expect(jobType('c1')).toBe('automation:c1');
  });

  it('reconciles jobs at boot and follows changes', () => {
    const sched = createMemoryScheduler();
    sched.add({ kind: 'automation', cron: '* * * * *', runAt: null, payload: { type: 'automation:deleted', automationId: 'deleted' }, enabled: true });
    const { h, change } = host([cronAuto(), cronAuto({ id: 'm1', trigger: { type: 'manual' } })]);
    const detach = attachAutomationSchedules(h, sched);
    expect(sched.jobs.map((j) => j.payload.automationId)).toEqual(['c1']);
    expect(sched.jobs[0]?.payload.type).toBe('automation:c1');
    change(cronAuto({ enabled: false }), 'c1');
    expect(sched.jobs).toHaveLength(0);
    change(cronAuto({ trigger: { type: 'cron', cron: '30 8 * * *' } }), 'c1');
    expect(sched.jobs.map((j) => j.cron)).toEqual(['30 8 * * *']);
    change(null, 'c1');
    expect(sched.jobs).toHaveLength(0);
    detach();
  });

  it('starts a run keyed by the scheduled minute, only for enabled automations', async () => {
    const sched = createMemoryScheduler();
    const { h, change, starts } = host([cronAuto()]);
    attachAutomationSchedules(h, sched, () => new Date('2026-09-17T09:00:07.500Z'));
    const job = sched.jobs[0];
    if (!job) throw new Error('job missing');
    await sched.fire('automation', job);
    expect(starts).toEqual([
      { id: 'c1', fire: { key: 'cron:2026-09-17T09:00:00.000Z', source: 'cron', vars: { scheduledFor: '2026-09-17T09:00:00.000Z' } } },
    ]);
    change(cronAuto({ enabled: false }), 'c1');
    await sched.fire('automation', job);
    expect(starts).toHaveLength(1);
  });

  it('ignores scheduler jobs of other kinds and other types', async () => {
    const sched = createMemoryScheduler();
    const { h, starts } = host([cronAuto()]);
    attachAutomationSchedules(h, sched);
    await sched.fire('automation', {
      id: 'x', kind: 'automation', cron: '* * * * *', runAt: null, payload: { type: 'automation:gone', automationId: 'gone' }, enabled: true,
    });
    expect(starts).toEqual([]);
    const spy = vi.fn();
    sched.onFire('digest', spy);
    await sched.fire('digest', { id: 'd', kind: 'digest', cron: null, runAt: null, payload: {}, enabled: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p7/automation-schedules.test.ts`
Expected: FAIL, `Cannot find module '../../src/services/automations/schedules.ts'`

- [ ] **Step 2: Implement the schedule sync**

`apps/daemon/src/services/automations/schedules.ts`
```ts
import type { Automation } from '@orc/api-contract';
import { ensureCronJob, removeJobsOfType, type Scheduler } from '../scheduler/scheduler.ts';
import type { AutomationServiceImpl } from './service.ts';

export type ScheduleHost = Pick<AutomationServiceImpl, 'list' | 'get' | 'start' | 'onChange'>;

export const jobType = (automationId: string): string => `automation:${automationId}`;

export function floorToMinute(d: Date): string {
  const c = new Date(d.getTime());
  c.setUTCSeconds(0, 0);
  return c.toISOString();
}

/**
 * Keeps exactly one P5 scheduler job per enabled cron automation and starts a run when it fires.
 * The run's trigger key is the scheduled minute, so the DB unique index makes it at-most-once.
 */
export function attachAutomationSchedules(svc: ScheduleHost, scheduler: Scheduler, now: () => Date = () => new Date()): () => void {
  const sync = (id: string, a: Automation | null) => {
    if (a?.enabled && a.trigger.type === 'cron') {
      ensureCronJob(scheduler, 'automation', jobType(id), a.trigger.cron, { automationId: id });
      return;
    }
    removeJobsOfType(scheduler, 'automation', jobType(id));
  };

  const known = new Set(svc.list().map((a) => a.id));
  for (const j of scheduler.list('automation')) {
    if (!known.has(String(j.payload.automationId))) scheduler.remove(j.id);
  }
  for (const a of svc.list()) sync(a.id, a);

  scheduler.onFire('automation', async (job) => {
    const id = String(job.payload.automationId ?? '');
    if (job.payload.type !== jobType(id)) return;
    const a = svc.get(id);
    if (!a?.enabled || a.trigger.type !== 'cron') return;
    const scheduledFor = floorToMinute(now());
    await svc.start(id, { key: `cron:${scheduledFor}`, source: 'cron', vars: { scheduledFor } });
  });

  return svc.onChange(sync);
}
```

- [ ] **Step 3: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/test/p7/automation-schedules.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 4: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/daemon/src/services/automations/schedules.ts apps/daemon/test/p7/automation-schedules.test.ts
git commit -m "feat(automations): schedule cron automations on the persisted scheduler"
```

---

### Task 7: Event triggers (GitHub, Linear, Slack)

**Files:**
- Create: `apps/daemon/src/services/automations/triggers.ts`, `apps/daemon/src/services/automations/dispatcher.ts`
- Create **only if Phase 6 did not**: `apps/daemon/src/connectors/linear/assigned-poller.ts`, `apps/daemon/src/connectors/slack/mention-poller.ts` (Phase 6 owns these files and the `linear.issueChanged` / `slack.mention` bus events; check with `ls apps/daemon/src/connectors/linear/assigned-poller.ts apps/daemon/src/connectors/slack/mention-poller.ts` before writing them, and skip Step 3's poller code and the poller tests when they already exist)
- Test: `apps/daemon/test/p7/triggers.test.ts`, `apps/daemon/test/p7/trigger-pollers.test.ts`

**Interfaces:**
- Consumes: bus `pr.changed` (P4, `PrStatus` from `@orc/core`); `LinearConnector.assignedToMe()` and `LinearIssue` (P6); `SlackConnector.mentions(sinceTs)` (P6); `compileTicketRegex`, `extractTickets`, `DEFAULT_TICKET_REGEX`, `redact` (`@orc/core`, P1); `AutomationServiceImpl.start` (Task 4); BusEvent `linear.issueChanged` and `slack.mention` (Task 1).
- Produces:
  ```ts
  // triggers.ts (pure)
  export type TriggerEvent =
    | { type: 'github'; event: 'review_comment' | 'check_failed' | 'pr_merged'; key: string; repo: string; vars: Record<string, string> }
    | { type: 'linear'; event: 'assigned' | 'labeled'; label: string | null; key: string; vars: Record<string, string> }
    | { type: 'slack'; event: 'mention'; channel: string; key: string; vars: Record<string, string> };
  export function githubEventsFromPrChange(before: PrStatus | null, after: PrStatus): TriggerEvent[]
  export function linearEventsFromIssueChange(before: LinearIssue | null, after: LinearIssue): TriggerEvent[]
  export function slackEventFromMention(m: { channel: string; ts: string; text: string }, ticketRe: RegExp | null): TriggerEvent
  export function repoBelongsToProject(repoFullName: string, project: ProjectConfig | null): boolean
  export function matchesTrigger(a: Automation, e: TriggerEvent, project: ProjectConfig | null): boolean
  // dispatcher.ts
  export function attachTriggerDispatcher(ctx: DaemonContext, svc: Pick<AutomationServiceImpl, 'list' | 'start'>): () => void
  // pollers
  export interface Poller { tick(): Promise<void>; start(): () => void }
  export function createLinearAssignedPoller(o: { linear: Pick<LinearConnector, 'assignedToMe'>; bus: EventBus; log: Logger; intervalMs?: number }): Poller
  export function createSlackMentionPoller(o: { slack: Pick<SlackConnector, 'mentions'>; bus: EventBus; log: Logger; intervalMs?: number; now?: () => Date }): Poller
  ```
  Trigger keys (dedupe, one run per key per automation):
  - `github:<repo>#<n>:review_comment:<updatedAt>`
  - `github:<repo>#<n>:check_failed:<updatedAt>`
  - `github:<repo>#<n>:pr_merged`
  - `linear:<ID>:assigned`
  - `linear:<ID>:label:<label>`
  - `slack:<channel>:<ts>`

  Template vars: `prUrl`, `check` (failed check names), `ticket`, `ticketUrl`, `label`, `slackText` (redacted, 500 chars max).

  GitHub events fire only on a **transition**. `before === null` (a PR seen for the first time) never fires, so a daemon restart does not replay old states. The Linear poller's first tick only seeds its state. The Slack poller starts at "now".

- [ ] **Step 1: Write the failing tests**

`apps/daemon/test/p7/triggers.test.ts`
```ts
import type { Automation } from '@orc/api-contract';
import type { PrStatus } from '@orc/core';
import { describe, expect, it } from 'vitest';
import type { LinearIssue } from '../../src/connectors/linear/linear.ts';
import {
  githubEventsFromPrChange,
  linearEventsFromIssueChange,
  matchesTrigger,
  repoBelongsToProject,
  slackEventFromMention,
} from '../../src/services/automations/triggers.ts';
import { testConfig } from '../fakes/phase7.ts';

const pr = (over: Partial<PrStatus> = {}): PrStatus => ({
  pr: { repo: 'example-org/wecare-service', number: 12, url: 'https://github.com/example-org/wecare-service/pull/12' },
  state: 'open',
  title: 'SAF-7 exclude weekends',
  checks: 'pending',
  review: 'review_required',
  updatedAt: '2026-09-17T09:00:00.000Z',
  headRef: 'feat/SAF-7-weekends',
  failedChecks: [],
  ...over,
});

const issue = (over: Partial<LinearIssue> = {}): LinearIssue => ({
  id: 'i1', identifier: 'SAF-8', title: 'Add retries', state: 'Todo', assignee: 'me', url: 'https://linear.app/x/issue/SAF-8', labels: [], ...over,
});

const auto = (trigger: Automation['trigger'], over: Partial<Automation> = {}): Automation => ({
  id: 'a', name: 'n', enabled: true, trigger,
  action: { templateId: 't', projectId: 'wakecap', useWorktree: true, headless: true, timeoutMin: 5, planApproval: false },
  budgetUsd: 5, ...over,
});

function project() {
  const cfg = testConfig();
  const p = cfg.projects[0];
  if (!p) throw new Error('no project');
  p.repos = [{ path: '/Users/test/Wakecap/Backend/wecare-service', copyGlobs: [], worktreeDir: '.worktrees' }];
  return p;
}

describe('githubEventsFromPrChange', () => {
  it('fires on transitions only', () => {
    expect(githubEventsFromPrChange(null, pr({ checks: 'failure' }))).toEqual([]);
    const failed = githubEventsFromPrChange(pr(), pr({ checks: 'failure', failedChecks: ['lint', 'test'], updatedAt: 't2' }));
    expect(failed).toEqual([
      {
        type: 'github', event: 'check_failed', repo: 'example-org/wecare-service',
        key: 'github:example-org/wecare-service#12:check_failed:t2',
        vars: { prUrl: 'https://github.com/example-org/wecare-service/pull/12', ticket: 'SAF-7', check: 'lint, test' },
      },
    ]);
    expect(githubEventsFromPrChange(pr({ checks: 'failure' }), pr({ checks: 'failure' }))).toEqual([]);
    expect(githubEventsFromPrChange(pr(), pr({ review: 'changes_requested', updatedAt: 't3' })).map((e) => e.key)).toEqual([
      'github:example-org/wecare-service#12:review_comment:t3',
    ]);
    expect(githubEventsFromPrChange(pr(), pr({ state: 'merged' })).map((e) => e.event)).toEqual(['pr_merged']);
    expect(githubEventsFromPrChange(pr({ state: 'closed' }), pr({ state: 'closed', checks: 'failure' }))).toEqual([]);
  });
});

describe('linearEventsFromIssueChange', () => {
  it('fires assigned for new issues and labeled for each added label', () => {
    expect(linearEventsFromIssueChange(null, issue()).map((e) => e.key)).toEqual(['linear:SAF-8:assigned']);
    const labeled = linearEventsFromIssueChange(issue({ labels: ['bug'] }), issue({ labels: ['bug', 'Agent-OK'] }));
    expect(labeled).toEqual([
      { type: 'linear', event: 'labeled', label: 'Agent-OK', key: 'linear:SAF-8:label:Agent-OK', vars: { ticket: 'SAF-8', ticketUrl: 'https://linear.app/x/issue/SAF-8', label: 'Agent-OK' } },
    ]);
    expect(linearEventsFromIssueChange(issue(), issue({ state: 'In Progress' }))).toEqual([]);
  });
});

describe('slackEventFromMention', () => {
  it('redacts and extracts the ticket', () => {
    const e = slackEventFromMention({ channel: 'C1', ts: '1788253200.000100', text: 'can you look at SAF-9? token=abc' }, /\bSAF-\d+\b/g);
    expect(e).toEqual({
      type: 'slack', event: 'mention', channel: 'C1', key: 'slack:C1:1788253200.000100',
      vars: { slackText: 'can you look at SAF-9? token=«redacted:secret»', ticket: 'SAF-9' },
    });
  });
});

describe('matchesTrigger', () => {
  const p = project();
  it('matches GitHub events for repos of the automation project', () => {
    const [e] = githubEventsFromPrChange(pr(), pr({ checks: 'failure' }));
    if (!e) throw new Error('no event');
    expect(matchesTrigger(auto({ type: 'github', event: 'check_failed' }), e, p)).toBe(true);
    expect(matchesTrigger(auto({ type: 'github', event: 'pr_merged' }), e, p)).toBe(false);
    expect(matchesTrigger(auto({ type: 'github', event: 'check_failed' }, { enabled: false }), e, p)).toBe(false);
    expect(repoBelongsToProject('example-org/other-repo', p)).toBe(false);
    expect(repoBelongsToProject('example-org/wecare-service', null)).toBe(false);
  });

  it('matches Linear labels case-insensitively and checks the ticket prefix', () => {
    const [e] = linearEventsFromIssueChange(issue(), issue({ labels: ['agent-ok'] }));
    if (!e) throw new Error('no event');
    expect(matchesTrigger(auto({ type: 'linear', event: 'labeled', label: 'Agent-OK' }), e, p)).toBe(true);
    expect(matchesTrigger(auto({ type: 'linear', event: 'labeled', label: 'other' }), e, p)).toBe(false);
    const [foreign] = linearEventsFromIssueChange(null, issue({ identifier: 'ENG-1' }));
    if (!foreign) throw new Error('no event');
    expect(matchesTrigger(auto({ type: 'linear', event: 'assigned' }), foreign, p)).toBe(false);
  });

  it('matches Slack mentions by channel', () => {
    const e = slackEventFromMention({ channel: 'C1', ts: '1', text: 'hi' }, null);
    expect(matchesTrigger(auto({ type: 'slack', event: 'mention', channel: 'C1' }), e, p)).toBe(true);
    expect(matchesTrigger(auto({ type: 'slack', event: 'mention', channel: 'C2' }), e, p)).toBe(false);
    expect(matchesTrigger(auto({ type: 'manual' }), e, p)).toBe(false);
  });
});
```

`apps/daemon/test/p7/trigger-pollers.test.ts`
```ts
import type { Automation, AutomationRunDetail } from '@orc/api-contract';
import type { PrStatus } from '@orc/core';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { LinearIssue } from '../../src/connectors/linear/linear.ts';
import { createLinearAssignedPoller } from '../../src/connectors/linear/assigned-poller.ts';
import { createSlackMentionPoller } from '../../src/connectors/slack/mention-poller.ts';
import { createEventBus, type BusEvent } from '../../src/live/event-bus.ts';
import { attachTriggerDispatcher } from '../../src/services/automations/dispatcher.ts';
import type { TriggerFire } from '../../src/services/automations/service.ts';
import { createTestContext, type TestContext } from '../helpers.ts';
import { fakeProjects, testConfig } from '../fakes/phase7.ts';

const log = pino({ level: 'silent' });
const issue = (identifier: string, labels: string[] = []): LinearIssue => ({
  id: identifier, identifier, title: 't', state: 'Todo', assignee: 'me', url: `https://linear.app/x/issue/${identifier}`, labels,
});

describe('createLinearAssignedPoller', () => {
  it('seeds on the first tick and then emits new issues and label changes', async () => {
    const bus = createEventBus();
    const events: BusEvent[] = [];
    bus.on('linear.issueChanged', (e) => events.push(e));
    let current = [issue('SAF-1')];
    const poller = createLinearAssignedPoller({ linear: { assignedToMe: async () => current }, bus, log });
    await poller.tick();
    expect(events).toHaveLength(0);
    current = [issue('SAF-1', ['agent-ok']), issue('SAF-2')];
    await poller.tick();
    expect(events.map((e) => (e.type === 'linear.issueChanged' ? [e.before?.identifier ?? null, e.after.identifier] : []))).toEqual([
      ['SAF-1', 'SAF-1'],
      [null, 'SAF-2'],
    ]);
    await poller.tick();
    expect(events).toHaveLength(2);
  });
});

describe('createSlackMentionPoller', () => {
  it('asks for mentions since start, emits each once and advances the cursor', async () => {
    const bus = createEventBus();
    const events: BusEvent[] = [];
    bus.on('slack.mention', (e) => events.push(e));
    const asked: string[] = [];
    const batches = [[{ channel: 'C1', ts: '1788253300.000001', text: 'hi' }], [{ channel: 'C1', ts: '1788253300.000001', text: 'hi' }, { channel: 'C2', ts: '1788253400.000002', text: 'yo' }]];
    const poller = createSlackMentionPoller({
      slack: {
        mentions: async (since) => {
          asked.push(since);
          return batches.shift() ?? [];
        },
      },
      bus,
      log,
      now: () => new Date('2026-09-17T09:00:00.000Z'),
    });
    await poller.tick();
    await poller.tick();
    expect(asked).toEqual(['1788253200.000000', '1788253300.000001']);
    expect(events).toHaveLength(2);
  });
});

describe('attachTriggerDispatcher', () => {
  let ctx: TestContext | null = null;
  afterEach(() => {
    ctx?.dispose();
    ctx = null;
  });

  it('starts matching enabled automations with the event key and vars', async () => {
    const cfg = testConfig();
    const p = cfg.projects[0];
    if (p) p.repos = [{ path: '/Users/test/Wakecap/Backend/svc', copyGlobs: [], worktreeDir: '.worktrees' }];
    ctx = createTestContext({ config: () => cfg, projects: fakeProjects(cfg) });
    const autos: Automation[] = [
      { id: 'fix', name: 'Fix CI', enabled: true, trigger: { type: 'github', event: 'check_failed' }, action: { templateId: 't', projectId: 'wakecap', useWorktree: true, headless: true, timeoutMin: 5, planApproval: false }, budgetUsd: 5 },
      { id: 'off', name: 'Off', enabled: false, trigger: { type: 'github', event: 'check_failed' }, action: { templateId: 't', projectId: 'wakecap', useWorktree: true, headless: true, timeoutMin: 5, planApproval: false }, budgetUsd: 5 },
    ];
    const starts: Array<[string, TriggerFire]> = [];
    const detach = attachTriggerDispatcher(ctx, {
      list: () => autos,
      start: async (id, fire) => {
        starts.push([id, fire]);
        return null as AutomationRunDetail | null;
      },
    });
    const before: PrStatus = {
      pr: { repo: 'example-org/svc', number: 3, url: 'https://github.com/example-org/svc/pull/3' },
      state: 'open', title: 'chore', checks: 'pending', review: 'none', updatedAt: 't1', headRef: null, failedChecks: [],
    };
    ctx.bus.emit({ type: 'pr.changed', before, after: { ...before, checks: 'failure', updatedAt: 't2', failedChecks: ['ci'] } });
    expect(starts).toEqual([
      ['fix', { key: 'github:example-org/svc#3:check_failed:t2', source: 'github', vars: { prUrl: 'https://github.com/example-org/svc/pull/3', check: 'ci' } }],
    ]);
    detach();
    ctx.bus.emit({ type: 'pr.changed', before, after: { ...before, checks: 'failure', updatedAt: 't3' } });
    expect(starts).toHaveLength(1);
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p7/triggers.test.ts apps/daemon/test/p7/trigger-pollers.test.ts`
Expected: FAIL, `Cannot find module '../../src/services/automations/triggers.ts'`. If Phase 6 already shipped the pollers, delete the two poller `describe` blocks from `trigger-pollers.test.ts` (Phase 6 tests them) and keep the dispatcher block.

- [ ] **Step 2: Implement the pure trigger mapping**

`apps/daemon/src/services/automations/triggers.ts`
```ts
import { basename } from 'node:path';
import type { Automation, ProjectConfig } from '@orc/api-contract';
import { compileTicketRegex, DEFAULT_TICKET_REGEX, extractTickets, type PrStatus, redact } from '@orc/core';
import type { LinearIssue } from '../../connectors/linear/linear.ts';

export type TriggerEvent =
  | { type: 'github'; event: 'review_comment' | 'check_failed' | 'pr_merged'; key: string; repo: string; vars: Record<string, string> }
  | { type: 'linear'; event: 'assigned' | 'labeled'; label: string | null; key: string; vars: Record<string, string> }
  | { type: 'slack'; event: 'mention'; channel: string; key: string; vars: Record<string, string> };

const DEFAULT_RE = compileTicketRegex(DEFAULT_TICKET_REGEX);

export function githubEventsFromPrChange(before: PrStatus | null, after: PrStatus): TriggerEvent[] {
  if (before === null) return [];
  const ref = `${after.pr.repo}#${after.pr.number}`;
  const ticket = extractTickets(`${after.title} ${after.headRef ?? ''}`, DEFAULT_RE)[0];
  const vars: Record<string, string> = { prUrl: after.pr.url, ...(ticket ? { ticket } : {}) };
  const repo = after.pr.repo;
  const out: TriggerEvent[] = [];
  if (after.state === 'open' && after.review === 'changes_requested' && before.review !== 'changes_requested') {
    out.push({ type: 'github', event: 'review_comment', repo, key: `github:${ref}:review_comment:${after.updatedAt}`, vars });
  }
  if (after.state === 'open' && after.checks === 'failure' && before.checks !== 'failure') {
    out.push({
      type: 'github',
      event: 'check_failed',
      repo,
      key: `github:${ref}:check_failed:${after.updatedAt}`,
      vars: { ...vars, check: after.failedChecks.join(', ') || 'failing checks' },
    });
  }
  if (after.state === 'merged' && before.state !== 'merged') {
    out.push({ type: 'github', event: 'pr_merged', repo, key: `github:${ref}:pr_merged`, vars });
  }
  return out;
}

export function linearEventsFromIssueChange(before: LinearIssue | null, after: LinearIssue): TriggerEvent[] {
  const vars: Record<string, string> = { ticket: after.identifier, ticketUrl: after.url };
  const out: TriggerEvent[] = [];
  if (before === null) {
    out.push({ type: 'linear', event: 'assigned', label: null, key: `linear:${after.identifier}:assigned`, vars });
  }
  const had = new Set((before?.labels ?? []).map((l) => l.toLowerCase()));
  for (const label of after.labels) {
    if (had.has(label.toLowerCase())) continue;
    out.push({ type: 'linear', event: 'labeled', label, key: `linear:${after.identifier}:label:${label}`, vars: { ...vars, label } });
  }
  return out;
}

export function slackEventFromMention(m: { channel: string; ts: string; text: string }, ticketRe: RegExp | null): TriggerEvent {
  const ticket = extractTickets(m.text, ticketRe)[0];
  return {
    type: 'slack',
    event: 'mention',
    channel: m.channel,
    key: `slack:${m.channel}:${m.ts}`,
    vars: { slackText: redact(m.text).slice(0, 500), ...(ticket ? { ticket } : {}) },
  };
}

export function repoBelongsToProject(repoFullName: string, project: ProjectConfig | null): boolean {
  if (!project) return false;
  const name = (repoFullName.split('/').pop() ?? '').toLowerCase();
  if (!name) return false;
  const dirs = [...project.repos.map((r) => r.path), ...project.pathPrefixes];
  return dirs.some((d) => basename(d).toLowerCase() === name);
}

function ticketBelongsToProject(ticket: string | undefined, project: ProjectConfig | null): boolean {
  if (!project || !ticket) return false;
  const re = compileTicketRegex(project.ticketRegex);
  return re === null ? true : extractTickets(ticket, re).length > 0;
}

export function matchesTrigger(a: Automation, e: TriggerEvent, project: ProjectConfig | null): boolean {
  if (!a.enabled) return false;
  const t = a.trigger;
  switch (e.type) {
    case 'github':
      return t.type === 'github' && t.event === e.event && repoBelongsToProject(e.repo, project);
    case 'linear':
      if (t.type !== 'linear' || t.event !== e.event) return false;
      if (t.event === 'labeled' && t.label && t.label.toLowerCase() !== (e.label ?? '').toLowerCase()) return false;
      return ticketBelongsToProject(e.vars.ticket, project);
    case 'slack':
      return t.type === 'slack' && t.channel === e.channel;
  }
}
```
If `project.repos` is empty and the repo is not the last segment of a path prefix, GitHub events do not match. The automation editor (Task 10) points this out next to the GitHub trigger.

- [ ] **Step 3: Implement the dispatcher and the pollers**

`apps/daemon/src/services/automations/dispatcher.ts`
```ts
import { compileTicketRegex, DEFAULT_TICKET_REGEX } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import type { AutomationServiceImpl } from './service.ts';
import {
  githubEventsFromPrChange,
  linearEventsFromIssueChange,
  matchesTrigger,
  slackEventFromMention,
  type TriggerEvent,
} from './triggers.ts';

export function attachTriggerDispatcher(ctx: DaemonContext, svc: Pick<AutomationServiceImpl, 'list' | 'start'>): () => void {
  const slackRe = compileTicketRegex(DEFAULT_TICKET_REGEX);
  const handle = (events: TriggerEvent[]) => {
    if (events.length === 0) return;
    const enabled = svc.list().filter((a) => a.enabled);
    for (const e of events) {
      for (const a of enabled) {
        if (!matchesTrigger(a, e, ctx.projects.get(a.action.projectId))) continue;
        svc.start(a.id, { key: e.key, source: e.type, vars: e.vars }).catch((err: unknown) => {
          ctx.log.warn({ err, automationId: a.id, key: e.key }, 'automation trigger failed');
        });
      }
    }
  };
  const offs = [
    ctx.bus.on('pr.changed', (e) => handle(githubEventsFromPrChange(e.before, e.after))),
    ctx.bus.on('linear.issueChanged', (e) => handle(linearEventsFromIssueChange(e.before, e.after))),
    ctx.bus.on('slack.mention', (e) => handle([slackEventFromMention(e, slackRe)])),
  ];
  return () => {
    for (const off of offs) off();
  };
}
```

`apps/daemon/src/connectors/linear/assigned-poller.ts`
```ts
import type { Logger } from 'pino';
import type { EventBus } from '../../live/event-bus.ts';
import type { LinearConnector, LinearIssue } from './linear.ts';

export interface Poller {
  tick(): Promise<void>;
  start(): () => void;
}

const sameLabels = (a: LinearIssue, b: LinearIssue) =>
  a.labels.map((l) => l.toLowerCase()).sort().join('|') === b.labels.map((l) => l.toLowerCase()).sort().join('|');

export function createLinearAssignedPoller(o: {
  linear: Pick<LinearConnector, 'assignedToMe'>;
  bus: EventBus;
  log: Logger;
  intervalMs?: number;
}): Poller {
  let seen: Map<string, LinearIssue> | null = null;
  const tick = async () => {
    const issues = await o.linear.assignedToMe();
    if (seen) {
      for (const i of issues) {
        const before = seen.get(i.identifier) ?? null;
        if (!before || !sameLabels(before, i)) o.bus.emit({ type: 'linear.issueChanged', before, after: i });
      }
    }
    seen = new Map(issues.map((i) => [i.identifier, i] as const));
  };
  return {
    tick,
    start() {
      const run = () => void tick().catch((err: unknown) => o.log.warn({ err }, 'linear assigned poll failed'));
      run();
      const timer = setInterval(run, o.intervalMs ?? 120_000);
      return () => clearInterval(timer);
    },
  };
}
```

`apps/daemon/src/connectors/slack/mention-poller.ts`
```ts
import type { Logger } from 'pino';
import type { EventBus } from '../../live/event-bus.ts';
import type { Poller } from '../linear/assigned-poller.ts';
import type { SlackConnector } from './slack.ts';

export function createSlackMentionPoller(o: {
  slack: Pick<SlackConnector, 'mentions'>;
  bus: EventBus;
  log: Logger;
  intervalMs?: number;
  now?: () => Date;
}): Poller {
  let since = ((o.now ?? (() => new Date()))().getTime() / 1000).toFixed(6);
  const seen = new Set<string>();
  const tick = async () => {
    const mentions = await o.slack.mentions(since);
    for (const m of mentions) {
      const key = `${m.channel}:${m.ts}`;
      if (seen.has(key)) continue;
      seen.add(key);
      o.bus.emit({ type: 'slack.mention', channel: m.channel, ts: m.ts, text: m.text });
      if (Number(m.ts) > Number(since)) since = m.ts;
    }
    if (seen.size > 5000) seen.clear();
  };
  return {
    tick,
    start() {
      const run = () => void tick().catch((err: unknown) => o.log.warn({ err }, 'slack mention poll failed'));
      run();
      const timer = setInterval(run, o.intervalMs ?? 120_000);
      return () => clearInterval(timer);
    },
  };
}
```
The Slack test expects the first `since` to be `1788253200.000000`, which is `2026-09-17T09:00:00Z` in seconds. The second tick asks from the newest `ts` it has seen. The duplicate in the second batch is filtered out, which is why exactly 2 events arrive.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/test/p7/triggers.test.ts apps/daemon/test/p7/trigger-pollers.test.ts apps/daemon/test/p7/never-merge.test.ts`
Expected: PASS (triggers 6 tests, pollers 3 tests; never-merge now also checks the two poller files)

- [ ] **Step 5: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/daemon/src/services/automations apps/daemon/src/connectors/linear/assigned-poller.ts apps/daemon/src/connectors/slack/mention-poller.ts apps/daemon/test/p7/triggers.test.ts apps/daemon/test/p7/trigger-pollers.test.ts
git commit -m "feat(automations): trigger automations from GitHub, Linear and Slack events"
```

---

### Task 8: Suggested tasks (Linear backlog + new TODO/FIXME), accepted by hand

**Files:**
- Modify (replace the Task 1 stub): `apps/daemon/src/services/automations/suggestions.ts`
- Test: `apps/daemon/test/p7/suggestions.test.ts`

**Interfaces:**
- Consumes: suggestion repo (Task 2); `addedLinesDiff`, `defaultBranch` (Task 1); `ctx.linear.assignedToMe()` (P6); `ctx.worktrees.list()`/`findByCwd()` (P4); `ctx.launcher.launch()` (P2); `LaunchRequest` zod (P2); `ctx.templates.list()` (P2); `ctx.audit` (P3); `sessionPk` (P1).
- Produces:
  ```ts
  export interface SuggestionService { list(state?: Suggestion['state']): Suggestion[]; refresh(): Promise<{ added: number }>; accept(id: string): Promise<{ ptyId: string; sessionPk: string | null }>; dismiss(id: string): Suggestion; start(): () => void }
  export interface SuggestionDeps { ctx: DaemonContext; now?: () => Date; addedLines?: (cwd: string, base: string) => Promise<string> }
  export interface NewTodo { file: string; line: number; kind: 'TODO' | 'FIXME'; text: string }
  export function parseNewTodos(diff: string): NewTodo[]
  export const BACKLOG_STATES: ReadonlySet<string>          // lowercase: backlog, todo, triage, unstarted
  export function createSuggestionService(deps: SuggestionDeps): SuggestionService
  ```
  Nothing runs until the user accepts. Accepting launches a normal **interactive, user-owned** session through `LaunchService`, so the user's own profile and the P2 concurrency cap apply. It is audited as `session.launch` with `params.suggestionId`. Dedupe keys are `linear:<ID>` and `todo:<repo>:<file>:<normalised text>`. `start()` refreshes every `automations.suggestions.intervalMin` minutes, but only while `automations.suggestions.enabled` is true.

- [ ] **Step 1: Write the failing test**

`apps/daemon/test/p7/suggestions.test.ts`
```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import type { LinearConnector, LinearIssue } from '../../src/connectors/linear/linear.ts';
import { ServiceError } from '../../src/services/errors.ts';
import { createSuggestionService, parseNewTodos } from '../../src/services/automations/suggestions.ts';
import { createTestContext, type TestContext } from '../helpers.ts';
import {
  fakeAudit,
  fakeLauncher,
  fakeProjects,
  fakeTemplates,
  fakeWorktrees,
  initGitRepo,
  testConfig,
} from '../fakes/phase7.ts';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -3,0 +4,2 @@ export const a = 1;',
  '+// TODO: handle weekends',
  '+const x = 1;',
  '@@ -10 +12 @@',
  '-// TODO: old one',
  '+  /* FIXME(hazem) retry on 529 */',
  'diff --git a/README.md b/README.md',
  '+++ b/README.md',
  '@@ -0,0 +1 @@',
  '+no markers here',
].join('\n');

describe('parseNewTodos', () => {
  it('finds added TODO/FIXME lines with their new line numbers', () => {
    expect(parseNewTodos(DIFF)).toEqual([
      { file: 'src/a.ts', line: 4, kind: 'TODO', text: 'handle weekends' },
      { file: 'src/a.ts', line: 12, kind: 'FIXME', text: 'retry on 529 */' },
    ]);
  });
});

const issue = (identifier: string, state: string): LinearIssue => ({
  id: identifier, identifier, title: `Title ${identifier}`, state, assignee: 'me', url: `https://linear.app/x/issue/${identifier}`, labels: [],
});

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

async function setup() {
  const cfg = testConfig({ automations: { suggestions: { enabled: true } } });
  const repo = await initGitRepo();
  await execa('git', ['-C', repo, 'checkout', '-q', '-b', 'feat/SAF-3-x']);
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n// FIXME: flaky retry\n');
  await execa('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'wip']);
  const worktrees = fakeWorktrees();
  const view = await worktrees.create({ repo, base: 'main', type: 'feat', ticket: 'SAF-3', slug: 'x' });
  view.path = repo;
  const linear = {
    status: async () => 'ok' as const,
    issue: async () => null,
    comment: async () => {},
    createIssue: async () => issue('SAF-0', 'Todo'),
    assignedToMe: async () => [issue('SAF-1', 'Todo'), issue('SAF-2', 'In Progress')],
  } as LinearConnector;
  const launcher = fakeLauncher();
  const audit = fakeAudit();
  ctx = createTestContext({
    config: () => cfg,
    projects: fakeProjects(cfg),
    worktrees,
    linear,
    launcher,
    audit,
    templates: fakeTemplates({ 'implement-ticket': '/conductor {{ticketUrl}}' }),
  });
  const svc = createSuggestionService({ ctx });
  return { svc, launcher, audit, repo };
}

describe('SuggestionService', () => {
  it('collects the Linear backlog and new FIXMEs once', async () => {
    const t = await setup();
    expect(await t.svc.refresh()).toEqual({ added: 2 });
    expect(await t.svc.refresh()).toEqual({ added: 0 });
    const list = t.svc.list('new');
    expect(list.map((s) => [s.source, s.title]).sort()).toEqual([
      ['linear', 'SAF-1: Title SAF-1'],
      ['todo', 'FIXME: flaky retry'],
    ]);
    const todo = list.find((s) => s.source === 'todo');
    expect(todo).toMatchObject({ ticket: 'SAF-3', line: 2, file: join(t.repo, 'a.ts') });
  });

  it('launches an owned session only when accepted, and only once', async () => {
    const t = await setup();
    await t.svc.refresh();
    const lin = t.svc.list('new').find((s) => s.source === 'linear');
    if (!lin) throw new Error('missing linear suggestion');
    expect(t.launcher.requests).toHaveLength(0);
    const res = await t.svc.accept(lin.id);
    expect(res).toEqual({ ptyId: 'pty-l1', sessionPk: 'claude:launched-1' });
    expect(t.launcher.requests[0]).toMatchObject({
      source: 'claude',
      projectId: 'wakecap',
      templateId: 'implement-ticket',
      ticket: 'SAF-1',
      vars: { ticket: 'SAF-1', ticketUrl: 'https://linear.app/x/issue/SAF-1' },
      planApproval: false,
    });
    expect(t.svc.list().find((s) => s.id === lin.id)).toMatchObject({ state: 'accepted', runPtyId: 'pty-l1' });
    expect(t.audit.entries.find((e) => e.action === 'session.launch')).toMatchObject({ actor: 'user', params: { suggestionId: lin.id } });
    await expect(t.svc.accept(lin.id)).rejects.toBeInstanceOf(ServiceError);
  });

  it('launches TODO fixes in the worktree and dismisses others', async () => {
    const t = await setup();
    await t.svc.refresh();
    const todo = t.svc.list('new').find((s) => s.source === 'todo');
    const lin = t.svc.list('new').find((s) => s.source === 'linear');
    if (!todo || !lin) throw new Error('missing suggestions');
    await t.svc.accept(todo.id);
    expect(t.launcher.requests[0]).toMatchObject({ cwd: t.repo, ticket: 'SAF-3' });
    expect(t.launcher.requests[0]?.prompt).toContain('FIXME: flaky retry');
    expect(t.svc.dismiss(lin.id).state).toBe('dismissed');
    expect(t.svc.list('new')).toEqual([]);
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p7/suggestions.test.ts`
Expected: FAIL, `createSuggestionService is not exported`

- [ ] **Step 2: Implement the suggestion service**

`apps/daemon/src/services/automations/suggestions.ts` (replaces the Task 1 stub)
```ts
import { dirname, join } from 'node:path';
import { LaunchRequest, type Suggestion } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import * as repo from '../../db/repos/suggestions.ts';
import { ServiceError } from '../errors.ts';
import { addedLinesDiff, defaultBranch } from '../git/git-info.ts';
import { sessionPk } from '../sessions.ts';

export interface SuggestionService {
  list(state?: Suggestion['state']): Suggestion[];
  refresh(): Promise<{ added: number }>;
  accept(id: string): Promise<{ ptyId: string; sessionPk: string | null }>;
  dismiss(id: string): Suggestion;
  start(): () => void;
}

export interface SuggestionDeps {
  ctx: DaemonContext;
  now?: () => Date;
  addedLines?: (cwd: string, base: string) => Promise<string>;
}

export interface NewTodo {
  file: string;
  line: number;
  kind: 'TODO' | 'FIXME';
  text: string;
}

export const BACKLOG_STATES: ReadonlySet<string> = new Set(['backlog', 'todo', 'triage', 'unstarted']);

const MARKER = /\b(TODO|FIXME)\b(?:\([^)]*\))?[:\s-]*(.*)$/;

export function parseNewTodos(diff: string): NewTodo[] {
  const out: NewTodo[] = [];
  let file: string | null = null;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.startsWith('+++ b/') ? raw.slice(6) : null;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) {
      const m = MARKER.exec(raw.slice(1));
      if (m?.[1]) out.push({ file, line, kind: m[1] as NewTodo['kind'], text: (m[2] ?? '').trim() });
      line++;
    } else if (!raw.startsWith('-') && !raw.startsWith('\\')) {
      line++;
    }
  }
  return out;
}

const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function createSuggestionService(deps: SuggestionDeps): SuggestionService {
  const { ctx } = deps;
  const now = deps.now ?? (() => new Date());
  const addedLines = deps.addedLines ?? addedLinesDiff;

  const projectForTicket = (ticket: string): string | null => {
    for (const p of ctx.config().projects) {
      if (p.ticketRegex && new RegExp(p.ticketRegex).test(ticket)) return p.id;
    }
    return ctx.config().defaultProjectId;
  };

  async function collectLinear(): Promise<number> {
    if (!ctx.linear) return 0;
    let added = 0;
    try {
      for (const i of await ctx.linear.assignedToMe()) {
        if (!BACKLOG_STATES.has(i.state.toLowerCase())) continue;
        const row = repo.insertSuggestion(
          ctx.db,
          {
            source: 'linear',
            projectId: projectForTicket(i.identifier),
            title: `${i.identifier}: ${i.title}`,
            detail: i.url,
            ticket: i.identifier,
            file: null,
            line: null,
            dedupeKey: `linear:${i.identifier}`,
          },
          now().toISOString(),
        );
        if (row) added++;
      }
    } catch (err) {
      ctx.log.warn({ err }, 'suggestions: linear backlog failed');
    }
    return added;
  }

  async function collectTodos(): Promise<number> {
    if (!ctx.worktrees) return 0;
    let added = 0;
    for (const wt of ctx.worktrees.list({ state: 'active' })) {
      if (!wt.createdByApp) continue;
      try {
        const base = wt.base ?? (await defaultBranch(wt.repo));
        for (const t of parseNewTodos(await addedLines(wt.path, base))) {
          const row = repo.insertSuggestion(
            ctx.db,
            {
              source: 'todo',
              projectId: wt.projectId,
              title: `${t.kind}: ${t.text}`,
              detail: `${wt.branch} · ${t.file}:${t.line}`,
              ticket: wt.ticket,
              file: join(wt.path, t.file),
              line: t.line,
              dedupeKey: `todo:${wt.repo}:${t.file}:${normalise(t.text)}`,
            },
            now().toISOString(),
          );
          if (row) added++;
        }
      } catch (err) {
        ctx.log.warn({ err, worktree: wt.path }, 'suggestions: todo scan failed');
      }
    }
    return added;
  }

  function mustBeNew(id: string): Suggestion {
    const s = repo.getSuggestion(ctx.db, id);
    if (!s) throw new ServiceError('not_found', 404, `suggestion ${id} not found`);
    if (s.state !== 'new') throw new ServiceError('invalid_state', 409, `suggestion ${id} is already ${s.state}`);
    return s;
  }

  function launchRequestFor(s: Suggestion): LaunchRequest {
    const projectId = s.projectId ?? ctx.config().defaultProjectId;
    if (s.source === 'linear') {
      const project = ctx.projects.get(projectId);
      const cwd = project?.pathPrefixes[0];
      if (!cwd) throw new ServiceError('validation_failed', 400, `project ${projectId} has no path`);
      const template = ctx.templates
        ?.list(projectId)
        .find((t) => t.id === 'implement-ticket' || t.label.toLowerCase() === 'implement ticket');
      const vars = { ticket: s.ticket ?? '', ticketUrl: s.detail };
      return LaunchRequest.parse({
        source: 'claude',
        projectId,
        cwd,
        prompt: template ? '' : `Implement ${s.title}. Ticket: ${s.detail}`,
        templateId: template?.id,
        vars,
        ticket: s.ticket ?? undefined,
      });
    }
    const file = s.file ?? '';
    const cwd = ctx.worktrees?.findByCwd(file)?.path ?? dirname(file);
    return LaunchRequest.parse({
      source: 'claude',
      projectId,
      cwd,
      prompt: `Resolve this ${s.title} at ${file}:${s.line ?? 1}. Keep the change small and add a test if behaviour changes.`,
      vars: {},
      ticket: s.ticket ?? undefined,
    });
  }

  const svc: SuggestionService = {
    list: (state) => repo.listSuggestions(ctx.db, state),
    async refresh() {
      const added = (await collectLinear()) + (await collectTodos());
      return { added };
    },
    async accept(id) {
      const s = mustBeNew(id);
      const req = launchRequestFor(s);
      const launcher = ctx.launcher;
      if (!launcher) throw new ServiceError('not_enabled', 409, 'launch service is not running');
      const res = await launcher.launch(req);
      repo.decideSuggestion(ctx.db, id, 'accepted', now().toISOString(), res.ptyId);
      ctx.audit?.record({
        actor: 'user',
        actorDetail: null,
        action: 'session.launch',
        target: res.sessionId ? sessionPk('claude', res.sessionId) : `pty:${res.ptyId}`,
        params: { suggestionId: id, source: s.source, cwd: req.cwd, ticket: s.ticket },
        result: 'ok',
        error: null,
      });
      return { ptyId: res.ptyId, sessionPk: res.sessionId ? sessionPk('claude', res.sessionId) : null };
    },
    dismiss(id) {
      mustBeNew(id);
      return repo.decideSuggestion(ctx.db, id, 'dismissed', now().toISOString());
    },
    start() {
      const cfg = ctx.config().automations.suggestions;
      if (!cfg.enabled) return () => {};
      const run = () => void svc.refresh().catch((err: unknown) => ctx.log.warn({ err }, 'suggestions refresh failed'));
      run();
      const timer = setInterval(run, cfg.intervalMin * 60_000);
      return () => clearInterval(timer);
    },
  };
  return svc;
}
```
`LaunchRequest` is the P2 zod schema, and its inferred type has the same name. `LaunchRequest.parse` fills in the defaults (`planApproval: false`, `vars: {}`, `prompt: ''`). If P2 exports the schema under another name (for example `LaunchRequestSchema`), import that name. P2 launches the template with `vars.ticketUrl`, which the Wakecap "Implement ticket" template uses.

- [ ] **Step 3: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/test/p7/suggestions.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 4: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/daemon/src/services/automations/suggestions.ts apps/daemon/test/p7/suggestions.test.ts
git commit -m "feat(automations): suggest tasks from the Linear backlog and new TODO/FIXME lines"
```

---

### Task 9: Automations HTTP routes and daemon wiring

**Files:**
- Create: `apps/daemon/src/http/routes/automations.ts`
- Modify: `apps/daemon/src/http/app.ts` (register routes), `apps/daemon/src/context.ts` (narrow `automations?` to `AutomationServiceImpl`), `apps/daemon/src/main.ts` (`createDaemon` wiring)
- Test: `apps/daemon/test/p7/automation-routes.test.ts`

**Interfaces:**
- Consumes: `createApp`, `OrcApp`, `readJson` (P1); `ServiceError` (P1); `ctx.updateConfig` (P2); `need`, `requireConfirmed`, `ConfirmBody`, `API_BASE`, `TEST_TOKEN` (Task 1); `AutomationServiceImpl` (Tasks 4–5); `SuggestionService` (Task 8); `attachAutomationSchedules` (Task 6); `attachTriggerDispatcher` and the pollers (Task 7).
- Produces: `export function registerAutomationRoutes(app: OrcApp, ctx: DaemonContext): void` with the P7 automation routes listed in Contract additions; `DaemonContext.automations?: AutomationServiceImpl`.
  - New automations are **always created disabled**, whatever the body says.
  - Delete, approve and accept need `confirm: true`.
  - Approve returns `202` with the run in `running` (or its denial), and the implementation continues in the background.

- [ ] **Step 1: Write the failing route test**

`apps/daemon/test/p7/automation-routes.test.ts`
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.ts';
import { API_BASE, TEST_TOKEN } from '../../src/http/p7-guard.ts';
import type { HeadlessRunOptions } from '../../src/services/automations/headless.ts';
import { createAutomationService } from '../../src/services/automations/service.ts';
import { createSuggestionService } from '../../src/services/automations/suggestions.ts';
import { createTestContext, type TestContext } from '../helpers.ts';
import {
  createFakePty,
  fakeAudit,
  fakeDenyList,
  fakeInbox,
  fakeLauncher,
  fakeProjects,
  fakeRecaps,
  fakeTemplates,
  fakeUsage,
  fakeWorktrees,
  testConfig,
} from '../fakes/phase7.ts';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

function setup(o: { withService?: boolean } = {}) {
  let cfg = testConfig({ automations: { enabled: true } });
  const audit = fakeAudit();
  ctx = createTestContext({
    config: () => cfg,
    updateConfig: (fn) => {
      cfg = OrcConfig.parse(fn(cfg));
      return cfg;
    },
    projects: fakeProjects(cfg),
    inbox: fakeInbox(),
    audit,
    usage: fakeUsage(),
    denyList: fakeDenyList(),
    recaps: fakeRecaps(),
    worktrees: fakeWorktrees(),
    pty: createFakePty(),
    launcher: fakeLauncher(),
    templates: fakeTemplates({ t: 'Tidy the README' }),
  });
  if (o.withService !== false) {
    ctx.automations = createAutomationService({
      ctx,
      runner: async (r: HeadlessRunOptions) => {
        mkdirSync(dirname(r.logFile), { recursive: true });
        writeFileSync(r.logFile, '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}\n');
        return {
          sessionId: r.resumeSessionId ?? r.sessionId ?? 's', costUsd: 0.1, durationMs: 1, numTurns: 1,
          resultText: r.permissionMode === 'plan' ? 'Plan: tidy' : 'Tidied', isError: false, subtype: 'success',
          timedOut: false, exitCode: 0, events: 1, stderrTail: '',
        };
      },
    });
    ctx.suggestions = createSuggestionService({ ctx });
  }
  const app = createApp({ ctx, token: TEST_TOKEN, port: () => 4317, env: {} });
  const call = (path: string, method = 'GET', body?: unknown) =>
    app.request(`${API_BASE}${path}`, {
      method,
      headers: { 'x-orc-token': TEST_TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call, audit, getCfg: () => cfg, ctx };
}

const input = (planApproval = false) => ({
  name: 'Tidy docs',
  enabled: true,
  trigger: { type: 'manual' },
  action: { templateId: 't', projectId: 'wakecap', useWorktree: false, headless: true, timeoutMin: 5, planApproval },
  budgetUsd: 3,
});

describe('/api/automations', () => {
  it('creates disabled automations, lists them with stats and toggles them', async () => {
    const t = setup();
    const created = await t.call('/api/automations', 'POST', input());
    expect(created.status).toBe(201);
    const a = (await created.json()) as { id: string; enabled: boolean };
    expect(a.enabled).toBe(false);
    const list = (await (await t.call('/api/automations')).json()) as Array<{ id: string; stats: { total: number } }>;
    expect(list).toMatchObject([{ id: a.id, stats: { total: 0 } }]);
    const on = (await (await t.call(`/api/automations/${a.id}/enabled`, 'POST', { enabled: true })).json()) as { enabled: boolean };
    expect(on.enabled).toBe(true);
    expect((await t.call(`/api/automations/${a.id}`)).status).toBe(200);
    expect((await t.call('/api/automations/nope')).status).toBe(404);
  });

  it('rejects invalid bodies', async () => {
    const t = setup();
    const res = await t.call('/api/automations', 'POST', { ...input(), budgetUsd: -1 });
    expect(res.status).toBe(400);
  });

  it('runs now, exposes the run and a redacted log', async () => {
    const t = setup();
    const a = (await (await t.call('/api/automations', 'POST', input())).json()) as { id: string };
    const started = await t.call(`/api/automations/${a.id}/run`, 'POST', {});
    expect(started.status).toBe(202);
    const run = (await started.json()) as { id: string };
    await t.ctx.automations?.waitFor(run.id);
    const detail = (await (await t.call(`/api/automations/runs/${run.id}`)).json()) as { status: string };
    expect(detail.status).toBe('success');
    expect(await (await t.call(`/api/automations/runs/${run.id}/log`)).json()).toEqual({ lines: ['done'] });
    const runs = (await (await t.call(`/api/automations/${a.id}/runs`)).json()) as unknown[];
    expect(runs).toHaveLength(1);
  });

  it('needs confirmation to delete and to approve', async () => {
    const t = setup();
    const a = (await (await t.call('/api/automations', 'POST', input(true))).json()) as { id: string };
    const del = await t.call(`/api/automations/${a.id}`, 'DELETE', {});
    expect(del.status).toBe(409);
    expect(((await del.json()) as { error: { code: string; details: { summary: string } } }).error).toMatchObject({
      code: 'confirmation_required',
      details: { summary: expect.stringContaining('Tidy docs') },
    });

    const run = (await (await t.call(`/api/automations/${a.id}/run`, 'POST', {})).json()) as { id: string };
    await t.ctx.automations?.waitFor(run.id);
    expect((await t.call(`/api/automations/runs/${run.id}/approve`, 'POST', {})).status).toBe(409);
    const approved = await t.call(`/api/automations/runs/${run.id}/approve`, 'POST', { confirm: true });
    expect(approved.status).toBe(202);
    expect(((await approved.json()) as { status: string }).status).toBe('running');
    const done = await t.ctx.automations?.waitFor(run.id);
    expect(done?.status).toBe('success');
    const again = await t.call(`/api/automations/runs/${run.id}/approve`, 'POST', { confirm: true });
    expect(again.status).toBe(409);
    expect((await t.call(`/api/automations/runs/${run.id}/reject`, 'POST', {})).status).toBe(409);
    expect((await t.call(`/api/automations/${a.id}`, 'DELETE', { confirm: true })).status).toBe(200);
  });

  it('updates the settings through updateConfig and audits it', async () => {
    const t = setup();
    expect(await (await t.call('/api/automations/settings')).json()).toEqual({ enabled: true, maxConcurrent: 2, suggestionsEnabled: false });
    const res = await t.call('/api/automations/settings', 'PATCH', { enabled: false, maxConcurrent: 3, suggestionsEnabled: true });
    expect(await res.json()).toEqual({ enabled: false, maxConcurrent: 3, suggestionsEnabled: true });
    expect(t.getCfg().automations).toMatchObject({ enabled: false, maxConcurrent: 3, suggestions: { enabled: true } });
    expect(t.audit.entries.some((e) => e.action === 'settings.update' && e.target === 'config:automations')).toBe(true);
  });

  it('lists suggestions and 404s unknown ones', async () => {
    const t = setup();
    expect(await (await t.call('/api/automations/suggestions?state=new')).json()).toEqual([]);
    expect((await t.call('/api/automations/suggestions?state=bogus')).status).toBe(400);
    expect((await t.call('/api/automations/suggestions/x/dismiss', 'POST', {})).status).toBe(404);
  });

  it('answers 409 not_enabled when the service is not wired', async () => {
    const t = setup({ withService: false });
    const res = await t.call('/api/automations');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_enabled');
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p7/automation-routes.test.ts`
Expected: FAIL, `Cannot find module '../../src/http/routes/automations.ts'`, or 404 responses once the import is fixed.

- [ ] **Step 2: Implement the routes**

`apps/daemon/src/http/routes/automations.ts`
```ts
import { randomUUID } from 'node:crypto';
import { AutomationInput, AutomationSettingsPatch, Suggestion } from '@orc/api-contract';
import { z } from 'zod';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import { readJson } from '../json.ts';
import { ConfirmBody, need, requireConfirmed } from '../p7-guard.ts';
import type { OrcApp } from '../types.ts';

const EnabledBody = z.object({ enabled: z.boolean() });
const SuggestionQuery = z.object({ state: Suggestion.shape.state.optional() });

export function registerAutomationRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.automations, 'automations');
  const sugg = () => need(ctx.suggestions, 'suggestions');
  const base = '/api/automations';

  const automationOr404 = (id: string) => {
    const a = svc().get(id);
    if (!a) throw new ServiceError('not_found', 404, `automation ${id} not found`);
    return a;
  };
  const runOr404 = (runId: string) => {
    const r = svc().run(runId);
    if (!r) throw new ServiceError('not_found', 404, `automation run ${runId} not found`);
    return r;
  };

  app.get(base, (c) => c.json(svc().listWithStats()));

  app.post(base, async (c) => {
    const body = await readJson(c, AutomationInput);
    const isNew = body.id === undefined || svc().get(body.id) === null;
    const saved = svc().save({ ...body, id: body.id ?? randomUUID(), enabled: isNew ? false : body.enabled });
    return c.json(saved, isNew ? 201 : 200);
  });

  const settingsView = () => {
    const a = ctx.config().automations;
    return { enabled: a.enabled, maxConcurrent: a.maxConcurrent, suggestionsEnabled: a.suggestions.enabled };
  };
  app.get(`${base}/settings`, (c) => c.json(settingsView()));

  app.patch(`${base}/settings`, async (c) => {
    const patch = await readJson(c, AutomationSettingsPatch);
    const updateConfig = need(ctx.updateConfig, 'config updates');
    const next = updateConfig((cfg) => ({
      ...cfg,
      automations: {
        ...cfg.automations,
        enabled: patch.enabled ?? cfg.automations.enabled,
        maxConcurrent: patch.maxConcurrent ?? cfg.automations.maxConcurrent,
        suggestions: { ...cfg.automations.suggestions, enabled: patch.suggestionsEnabled ?? cfg.automations.suggestions.enabled },
      },
    }));
    ctx.audit?.record({ actor: 'user', actorDetail: null, action: 'settings.update', target: 'config:automations', params: patch, result: 'ok', error: null });
    return c.json({
      enabled: next.automations.enabled,
      maxConcurrent: next.automations.maxConcurrent,
      suggestionsEnabled: next.automations.suggestions.enabled,
    });
  });

  app.get(`${base}/suggestions`, (c) => {
    const q = SuggestionQuery.parse(c.req.query());
    return c.json(sugg().list(q.state));
  });
  app.post(`${base}/suggestions/refresh`, async (c) => c.json(await sugg().refresh()));
  app.post(`${base}/suggestions/:id/accept`, async (c) => {
    const body = await readJson(c, ConfirmBody);
    const id = c.req.param('id');
    const s = sugg().list().find((x) => x.id === id);
    if (!s) throw new ServiceError('not_found', 404, `suggestion ${id} not found`);
    requireConfirmed(body, `Start a Claude session for "${s.title}"`, { suggestion: s });
    return c.json(await sugg().accept(id));
  });
  app.post(`${base}/suggestions/:id/dismiss`, (c) => {
    const id = c.req.param('id');
    if (!sugg().list().some((x) => x.id === id)) throw new ServiceError('not_found', 404, `suggestion ${id} not found`);
    return c.json(sugg().dismiss(id));
  });

  app.get(`${base}/runs/:runId`, (c) => c.json(runOr404(c.req.param('runId'))));
  app.get(`${base}/runs/:runId/log`, (c) => {
    const runId = c.req.param('runId');
    runOr404(runId);
    return c.json({ lines: svc().logLines(runId) });
  });
  app.post(`${base}/runs/:runId/approve`, async (c) => {
    const body = await readJson(c, ConfirmBody);
    const run = runOr404(c.req.param('runId'));
    if (run.status !== 'awaiting_approval') {
      throw new ServiceError('invalid_state', 409, `run ${run.id} is not awaiting plan approval (status ${run.status})`);
    }
    const a = automationOr404(run.automationId);
    requireConfirmed(body, `Approve the plan and let "${a.name}" implement it. It cannot merge, deploy or touch production.`, {
      plan: run.summary,
    });
    svc()
      .approve(run.id)
      .catch((err: unknown) => ctx.log.warn({ err, runId: run.id }, 'automation approval failed'));
    return c.json(runOr404(run.id), 202);
  });
  app.post(`${base}/runs/:runId/reject`, (c) => c.json(svc().reject(runOr404(c.req.param('runId')).id)));
  app.post(`${base}/runs/:runId/rerun`, async (c) => {
    const r = await svc().rerun(runOr404(c.req.param('runId')).id);
    return r ? c.json(r, 202) : c.json({ deduped: true as const });
  });

  app.get(`${base}/:id`, (c) => {
    const id = c.req.param('id');
    const a = svc().listWithStats().find((x) => x.id === id);
    if (!a) throw new ServiceError('not_found', 404, `automation ${id} not found`);
    return c.json(a);
  });
  app.delete(`${base}/:id`, async (c) => {
    const body = await readJson(c, ConfirmBody);
    const a = automationOr404(c.req.param('id'));
    requireConfirmed(body, `Delete the automation "${a.name}" and its run history`);
    svc().remove(a.id);
    return c.json({ ok: true as const });
  });
  app.post(`${base}/:id/enabled`, async (c) => {
    const { enabled } = await readJson(c, EnabledBody);
    const a = automationOr404(c.req.param('id'));
    return c.json(svc().setEnabled(a.id, enabled));
  });
  app.post(`${base}/:id/run`, async (c) => {
    const a = automationOr404(c.req.param('id'));
    const r = await svc().start(a.id, { key: `manual:${randomUUID()}`, source: 'manual', vars: {} });
    return c.json(r, 202);
  });
  app.get(`${base}/:id/runs`, (c) => c.json(svc().runs(automationOr404(c.req.param('id')).id)));
}
```
The `SuggestionQuery.parse` ZodError becomes `400 validation_failed` through P1's `app.onError`. The API client always sends a JSON body (at least `{}`) to these endpoints, and `{}` is enough to reach the confirmation check.

- [ ] **Step 3: Register the routes and narrow the context type**

`apps/daemon/src/http/app.ts`: add `import { registerAutomationRoutes } from './routes/automations.ts';` and call `registerAutomationRoutes(app, o.ctx);` right **before** the `app.all('/api/*', …)` 404 catch-all.

P3's `audit.coverage.test.ts` requires every non-GET `/api` route to be listed in `AUDITED_ROUTES` or `NON_ACTION_ROUTES`. These routes are audited **inside the services**, with the real actor (`automation`) and parameters, so add them to `NON_ACTION_ROUTES` in `apps/daemon/src/http/audit-middleware.ts`:
```ts
  { method: 'POST', path: '/api/automations', why: 'AutomationService.save records settings.update' },
  { method: 'PATCH', path: '/api/automations/settings', why: 'the handler records settings.update' },
  { method: 'POST', path: '/api/automations/suggestions/refresh', why: 'read-only collection into the local suggestions table' },
  { method: 'POST', path: '/api/automations/suggestions/:id/accept', why: 'SuggestionService.accept records session.launch' },
  { method: 'POST', path: '/api/automations/suggestions/:id/dismiss', why: 'local state only, nothing runs' },
  { method: 'POST', path: '/api/automations/runs/:runId/approve', why: 'AutomationService.approve records automation.approve and automation.run' },
  { method: 'POST', path: '/api/automations/runs/:runId/reject', why: 'AutomationService.reject records automation.reject' },
  { method: 'POST', path: '/api/automations/runs/:runId/rerun', why: 'AutomationService.start records automation.run' },
  { method: 'DELETE', path: '/api/automations/:id', why: 'AutomationService.remove records settings.update' },
  { method: 'POST', path: '/api/automations/:id/enabled', why: 'AutomationService.setEnabled records settings.update' },
  { method: 'POST', path: '/api/automations/:id/run', why: 'AutomationService.start records automation.run' },
```

`apps/daemon/src/context.ts`: change the P7 field to the implementation type:
```ts
import type { AutomationServiceImpl } from './services/automations/service.ts';
// …
  automations?: AutomationServiceImpl;   // P7 (implements §11 AutomationService)
```

- [ ] **Step 4: Wire the services in `createDaemon`**

In `apps/daemon/src/main.ts`, add these imports:
```ts
import { createSlackMentionPoller } from './connectors/slack/mention-poller.ts';
import { createLinearAssignedPoller } from './connectors/linear/assigned-poller.ts';
import { attachTriggerDispatcher } from './services/automations/dispatcher.ts';
import { attachAutomationSchedules } from './services/automations/schedules.ts';
import { createAutomationService } from './services/automations/service.ts';
import { createSuggestionService } from './services/automations/suggestions.ts';
```
Then add this block in `createDaemon` after the Phase 6 services are attached to `ctx` and before the server starts:
```ts
  // ── Phase 7A: automations ────────────────────────────────────────────
  const p7Stops: Array<() => void> = [];
  const automations = createAutomationService({ ctx });
  ctx.automations = automations;
  if (ctx.scheduler) p7Stops.push(attachAutomationSchedules(automations, ctx.scheduler));
  p7Stops.push(attachTriggerDispatcher(ctx, automations));
  if (ctx.config().automations.enabled) {
    // Event pollers run only while automations are on (restart after turning them on).
    if (ctx.linear) p7Stops.push(createLinearAssignedPoller({ linear: ctx.linear, bus: ctx.bus, log: ctx.log }).start());
    if (ctx.slack) p7Stops.push(createSlackMentionPoller({ slack: ctx.slack, bus: ctx.bus, log: ctx.log }).start());
  }
  const suggestions = createSuggestionService({ ctx });
  ctx.suggestions = suggestions;
  p7Stops.push(suggestions.start());
```
In the daemon's close path (the function returned by `start()` in P1, or the `close()` in P2's `createDaemon` result), add before the DB closes:
```ts
    for (const stop of p7Stops) stop();
    automations.stop();
```
Tasks 12, 17, 20 and 23 add their own lines to this block and push their stop functions into `p7Stops`.

- [ ] **Step 5: Run the tests and a boot smoke test**

Run: `pnpm vitest run apps/daemon/test/p7/automation-routes.test.ts`
Expected: PASS (7 tests)

Run: `pnpm vitest run apps/daemon` (this includes P1/P2's boot test, which calls `createDaemon`)
Expected: PASS. The boot test proves the new wiring does not break startup when automations are off.

- [ ] **Step 6: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/daemon/src/http apps/daemon/src/context.ts apps/daemon/src/main.ts apps/daemon/test/p7/automation-routes.test.ts
git commit -m "feat(automations): expose automation routes and wire schedules, triggers and suggestions"
```

---

### Task 10: `/automations` UI (list, editor, run history, logs, suggestions)

**Files:**
- Create: `apps/web/src/api/queries/automations.ts`, `apps/web/src/features/automations/editor-model.ts`, `AutomationEditor.tsx`, `RunHistory.tsx`, `SuggestionsPanel.tsx`, `AutomationsPage.tsx`, `apps/web/src/routes/automations.tsx`
- Modify: `apps/web/src/features/shell/AppShell.tsx` (nav link)
- Test: `apps/web/src/features/automations/editor-model.test.ts`, `apps/web/src/features/automations/AutomationsPage.test.tsx`

**Interfaces:**
- Consumes: `AutomationsApi` (Task 2); `getApiClient`, `setApiClientForTests` (P1); `useProjects` (P1); `ALL_PROJECTS` (P1 api-contract); `useProjectStore`, `useTerminalStore` (§12); `templatesList(projectId?)` (P2 client); UI kit and `@/lib/format.ts` (P1); `renderWithClient`, `fakeApi` (P2 `@/test/query.tsx`).
- Produces:
  ```ts
  // api/queries/automations.ts
  export const automationKeys: { list: readonly ['automations']; settings: readonly ['automation-settings']; runs(id: string): readonly ['automation-runs', string]; log(runId: string): readonly ['automation-run-log', string]; suggestions: readonly ['automation-suggestions'] }
  export function useAutomations(): UseQueryResult<AutomationWithStats[]>
  export function useAutomationSettingsGet(): UseQueryResult<AutomationSettings>
  export function useAutomationSettings(): UseMutationResult<AutomationSettings, Error, AutomationSettingsPatch>
  export function useSaveAutomation(): UseMutationResult<Automation, Error, AutomationInput>
  export function useDeleteAutomation(): UseMutationResult<{ ok: true }, Error, string>
  export function useSetAutomationEnabled(): UseMutationResult<Automation, Error, { id: string; enabled: boolean }>
  export function useRunAutomation(): UseMutationResult<AutomationRunDetail, Error, string>
  export function useAutomationRuns(id: string | null): UseQueryResult<AutomationRunDetail[]>
  export function useRunLog(runId: string | null): UseQueryResult<{ lines: string[] }>
  export function useRunAction(automationId: string): UseMutationResult<unknown, Error, { runId: string; action: 'approve' | 'reject' | 'rerun' }>
  export function useSuggestions(): UseQueryResult<Suggestion[]>
  export function useRefreshSuggestions(): UseMutationResult<{ added: number }, Error, void>
  export function useSuggestionAction(): UseMutationResult<unknown, Error, { id: string; action: 'accept' | 'dismiss' }>
  // features/automations/editor-model.ts
  export interface EditorForm { id?: string; name: string; enabled: boolean; triggerType: AutomationTrigger['type']; cron: string; githubEvent: 'review_comment' | 'check_failed' | 'pr_merged'; linearEvent: 'assigned' | 'labeled'; linearLabel: string; slackChannel: string; templateId: string; projectId: string; repo: string; useWorktree: boolean; headless: boolean; model: string; timeoutMin: number; planApproval: boolean; budgetUsd: number }
  export function emptyForm(projectId: string): EditorForm
  export function formFromAutomation(a: Automation): EditorForm
  export function triggerFromForm(f: EditorForm): AutomationTrigger
  export function buildAutomation(f: EditorForm): { ok: true; value: AutomationInput } | { ok: false; errors: string[] }
  export function describeTrigger(t: AutomationTrigger): string
  export function formatSuccessRate(rate: number | null): string
  // components
  export function AutomationsPage(): JSX.Element
  export function AutomationEditor(p: { projectId: string; initial?: Automation; onDone(): void }): JSX.Element
  export function RunHistory(p: { automation: AutomationWithStats; confirm?: (message: string) => boolean }): JSX.Element
  export function SuggestionsPanel(p: { confirm?: (message: string) => boolean }): JSX.Element
  ```
  The route is `/automations`. `applyLiveEvent` (Task 2) invalidates `['automations']` and `['automation-runs', id]` on `automation.runUpdated`.

- [ ] **Step 1: Write the failing model test**

`apps/web/src/features/automations/editor-model.test.ts`
```ts
import type { Automation } from '@orc/api-contract';
import { describe, expect, it } from 'vitest';
import { buildAutomation, describeTrigger, emptyForm, formatSuccessRate, formFromAutomation } from './editor-model.ts';

describe('editor model', () => {
  it('builds each trigger type', () => {
    const base = { ...emptyForm('wakecap'), name: 'Nightly', templateId: 'fix-ci' };
    const cases: Array<[Partial<typeof base>, Automation['trigger']]> = [
      [{ triggerType: 'cron', cron: ' 0 2 * * * ' }, { type: 'cron', cron: '0 2 * * *' }],
      [{ triggerType: 'github', githubEvent: 'pr_merged' }, { type: 'github', event: 'pr_merged' }],
      [{ triggerType: 'linear', linearEvent: 'labeled', linearLabel: 'agent-ok' }, { type: 'linear', event: 'labeled', label: 'agent-ok' }],
      [{ triggerType: 'linear', linearEvent: 'assigned', linearLabel: 'ignored' }, { type: 'linear', event: 'assigned' }],
      [{ triggerType: 'slack', slackChannel: ' C42 ' }, { type: 'slack', event: 'mention', channel: 'C42' }],
      [{ triggerType: 'manual' }, { type: 'manual' }],
    ];
    for (const [patch, trigger] of cases) {
      const r = buildAutomation({ ...base, ...patch });
      expect(r.ok && r.value.trigger).toEqual(trigger);
    }
  });

  it('reports validation errors', () => {
    const r = buildAutomation({ ...emptyForm('wakecap'), name: '', templateId: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/name/);
  });

  it('round-trips an automation and drops empty optionals', () => {
    const a: Automation = {
      id: 'a1', name: 'Fix CI', enabled: true, trigger: { type: 'slack', event: 'mention', channel: 'C1' },
      action: { templateId: 'fix-ci', projectId: 'wakecap', useWorktree: false, headless: false, timeoutMin: 12, planApproval: true, model: 'claude-sonnet-5' },
      budgetUsd: 4,
    };
    const r = buildAutomation(formFromAutomation(a));
    expect(r.ok && r.value).toEqual(a);
    const noModel = buildAutomation({ ...formFromAutomation(a), model: '  ', repo: '' });
    expect(noModel.ok && noModel.value.action).not.toHaveProperty('model');
    expect(noModel.ok && noModel.value.action).not.toHaveProperty('repo');
  });

  it('describes triggers and success rates', () => {
    expect(describeTrigger({ type: 'github', event: 'check_failed' })).toBe('GitHub: check failed');
    expect(describeTrigger({ type: 'linear', event: 'labeled', label: 'x' })).toBe('Linear: label x');
    expect(describeTrigger({ type: 'cron', cron: '0 9 * * 1' })).toBe('Schedule 0 9 * * 1');
    expect(formatSuccessRate(null)).toBe('—');
    expect(formatSuccessRate(2 / 3)).toBe('67%');
  });
});
```

Run: `pnpm vitest run apps/web/src/features/automations/editor-model.test.ts`
Expected: FAIL, `Cannot find module './editor-model.ts'`

- [ ] **Step 2: Implement the model**

`apps/web/src/features/automations/editor-model.ts`
```ts
import { type Automation, AutomationInput, type AutomationTrigger } from '@orc/api-contract';

export interface EditorForm {
  id?: string;
  name: string;
  enabled: boolean;
  triggerType: AutomationTrigger['type'];
  cron: string;
  githubEvent: 'review_comment' | 'check_failed' | 'pr_merged';
  linearEvent: 'assigned' | 'labeled';
  linearLabel: string;
  slackChannel: string;
  templateId: string;
  projectId: string;
  repo: string;
  useWorktree: boolean;
  headless: boolean;
  model: string;
  timeoutMin: number;
  planApproval: boolean;
  budgetUsd: number;
}

export function emptyForm(projectId: string): EditorForm {
  return {
    name: '',
    enabled: false,
    triggerType: 'manual',
    cron: '0 9 * * 1-5',
    githubEvent: 'check_failed',
    linearEvent: 'assigned',
    linearLabel: '',
    slackChannel: '',
    templateId: '',
    projectId,
    repo: '',
    useWorktree: true,
    headless: true,
    model: '',
    timeoutMin: 30,
    planApproval: false,
    budgetUsd: 5,
  };
}

export function formFromAutomation(a: Automation): EditorForm {
  const f = emptyForm(a.action.projectId);
  const t = a.trigger;
  return {
    ...f,
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    triggerType: t.type,
    cron: t.type === 'cron' ? t.cron : f.cron,
    githubEvent: t.type === 'github' ? t.event : f.githubEvent,
    linearEvent: t.type === 'linear' ? t.event : f.linearEvent,
    linearLabel: t.type === 'linear' ? (t.label ?? '') : '',
    slackChannel: t.type === 'slack' ? t.channel : '',
    templateId: a.action.templateId,
    repo: a.action.repo ?? '',
    useWorktree: a.action.useWorktree,
    headless: a.action.headless,
    model: a.action.model ?? '',
    timeoutMin: a.action.timeoutMin,
    planApproval: a.action.planApproval,
    budgetUsd: a.budgetUsd,
  };
}

export function triggerFromForm(f: EditorForm): AutomationTrigger {
  switch (f.triggerType) {
    case 'cron':
      return { type: 'cron', cron: f.cron.trim() };
    case 'github':
      return { type: 'github', event: f.githubEvent };
    case 'linear':
      return f.linearEvent === 'labeled' && f.linearLabel.trim()
        ? { type: 'linear', event: 'labeled', label: f.linearLabel.trim() }
        : { type: 'linear', event: f.linearEvent };
    case 'slack':
      return { type: 'slack', event: 'mention', channel: f.slackChannel.trim() };
    case 'manual':
      return { type: 'manual' };
  }
}

export function buildAutomation(f: EditorForm): { ok: true; value: AutomationInput } | { ok: false; errors: string[] } {
  const candidate = {
    ...(f.id ? { id: f.id } : {}),
    name: f.name.trim(),
    enabled: f.enabled,
    trigger: triggerFromForm(f),
    action: {
      templateId: f.templateId,
      projectId: f.projectId,
      ...(f.repo.trim() ? { repo: f.repo.trim() } : {}),
      useWorktree: f.useWorktree,
      headless: f.headless,
      ...(f.model.trim() ? { model: f.model.trim() } : {}),
      timeoutMin: f.timeoutMin,
      planApproval: f.planApproval,
    },
    budgetUsd: f.budgetUsd,
  };
  const r = AutomationInput.safeParse(candidate);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || 'form'}: ${i.message}`) };
}

export function describeTrigger(t: AutomationTrigger): string {
  switch (t.type) {
    case 'cron':
      return `Schedule ${t.cron}`;
    case 'github':
      return `GitHub: ${t.event.replace('_', ' ')}`;
    case 'linear':
      return t.event === 'assigned' ? 'Linear: assigned to me' : `Linear: label ${t.label ?? 'any'}`;
    case 'slack':
      return `Slack: mention in ${t.channel}`;
    case 'manual':
      return 'Manual only';
  }
}

export function formatSuccessRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}
```

Run: `pnpm vitest run apps/web/src/features/automations/editor-model.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 3: Write the failing page test**

`apps/web/src/features/automations/AutomationsPage.test.tsx`
```tsx
import type { AutomationRunDetail, AutomationWithStats, Suggestion } from '@orc/api-contract';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '@/api/client.ts';
import { fakeApi, renderWithClient } from '@/test/query.tsx';
import { AutomationsPage } from './AutomationsPage.tsx';
import { RunHistory } from './RunHistory.tsx';
import { SuggestionsPanel } from './SuggestionsPanel.tsx';

const auto: AutomationWithStats = {
  id: 'a1',
  name: 'Fix CI',
  enabled: true,
  trigger: { type: 'github', event: 'check_failed' },
  action: { templateId: 'fix-ci', projectId: 'wakecap', useWorktree: true, headless: true, timeoutMin: 30, planApproval: true },
  budgetUsd: 10,
  stats: { total: 3, success: 2, failed: 1, successRate: 2 / 3, lastRunAt: '2026-09-17T09:00:00.000Z', monthSpendUsd: 1.5 },
  nextRunAt: null,
};

const run: AutomationRunDetail = {
  id: 'r1', automationId: 'a1', startedAt: '2026-09-17T09:00:00.000Z', endedAt: null, status: 'awaiting_approval',
  sessionPk: 'claude:s1', costUsd: 0.2, summary: 'Plan: fix the lint step', triggerKey: 'k', triggerSource: 'github',
  vars: {}, ptyId: null, worktreePath: null, prUrl: null, diffStat: null, error: null, rerunOf: null,
};

afterEach(() => setApiClientForTests(null));

function api(overrides: Record<string, unknown> = {}) {
  const stubs = {
    automationsList: vi.fn(async () => [auto]),
    automationsSettingsGet: vi.fn(async () => ({ enabled: true, maxConcurrent: 2, suggestionsEnabled: false })),
    automationsSettings: vi.fn(async () => ({ enabled: false, maxConcurrent: 2, suggestionsEnabled: false })),
    automationsSetEnabled: vi.fn(async () => ({ ...auto, enabled: false })),
    automationsRun: vi.fn(async () => ({ ...run, status: 'queued' as const })),
    automationsSave: vi.fn(async () => auto),
    automationsRuns: vi.fn(async () => [run]),
    automationsRunLog: vi.fn(async () => ({ lines: ['→ Bash', 'done'] })),
    automationsApprove: vi.fn(async () => ({ ...run, status: 'running' as const })),
    automationsReject: vi.fn(async () => ({ ...run, status: 'failed' as const })),
    automationsRerun: vi.fn(async () => run),
    suggestionsList: vi.fn(async (): Promise<Suggestion[]> => []),
    suggestionsRefresh: vi.fn(async () => ({ added: 0 })),
    suggestionsAccept: vi.fn(async () => ({ ptyId: 'pty-9', sessionPk: null })),
    suggestionsDismiss: vi.fn(),
    projectsList: vi.fn(async () => [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: ['/x'], hidden: false, lastActivityAt: null, sessionCount: 0 }]),
    templatesList: vi.fn(async () => [
      { id: 'fix-ci', kind: 'preset' as const, label: 'Fix CI failure', prompt: 'fix {{prUrl}}', vars: ['prUrl' as const], defaultSource: 'claude' as const, projectIds: 'all' as const },
    ]),
    ...overrides,
  };
  setApiClientForTests(fakeApi(stubs));
  return stubs;
}

describe('AutomationsPage', () => {
  it('lists automations with trigger, success rate and spend, and runs or toggles them', async () => {
    const stubs = api();
    renderWithClient(<AutomationsPage />);
    expect(await screen.findByText('Fix CI')).toBeTruthy();
    expect(screen.getByText('GitHub: check failed')).toBeTruthy();
    expect(screen.getByText('Success 67%')).toBeTruthy();
    const runButton = screen.getByRole('button', { name: 'Run now' }) as HTMLButtonElement;
    await waitFor(() => expect(runButton.disabled).toBe(false));
    fireEvent.click(runButton);
    await waitFor(() => expect(stubs.automationsRun).toHaveBeenCalledWith('a1'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Fix CI' }));
    await waitFor(() => expect(stubs.automationsSetEnabled).toHaveBeenCalledWith('a1', false));
  });

  it('shows the master switch and disables Run now while it is off', async () => {
    const stubs = api({ automationsSettingsGet: vi.fn(async () => ({ enabled: false, maxConcurrent: 2, suggestionsEnabled: false })) });
    renderWithClient(<AutomationsPage />);
    expect(await screen.findByText('Off — nothing runs')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Run now' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Automations enabled' }));
    await waitFor(() => expect(stubs.automationsSettings).toHaveBeenCalledWith({ enabled: true }));
  });

  it('creates an automation from the editor', async () => {
    const stubs = api({ automationsList: vi.fn(async () => []) });
    renderWithClient(<AutomationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New automation' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Morning deps audit' } });
    await screen.findByRole('option', { name: 'Fix CI failure' });
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'fix-ci' } });
    fireEvent.change(screen.getByLabelText('Trigger'), { target: { value: 'cron' } });
    fireEvent.change(screen.getByLabelText('Cron'), { target: { value: '0 8 * * 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(stubs.automationsSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Morning deps audit',
          trigger: { type: 'cron', cron: '0 8 * * 1' },
          action: expect.objectContaining({ templateId: 'fix-ci', projectId: 'wakecap', useWorktree: true, headless: true }),
        }),
      ),
    );
  });

  it('shows validation errors instead of saving', async () => {
    const stubs = api({ automationsList: vi.fn(async () => []) });
    renderWithClient(<AutomationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New automation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(stubs.automationsSave).not.toHaveBeenCalled();
  });
});

describe('RunHistory', () => {
  it('approves a waiting plan only after confirmation and shows the log', async () => {
    const stubs = api();
    const confirm = vi.fn(() => false);
    const { rerender } = renderWithClient(<RunHistory automation={auto} confirm={confirm} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve plan' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Plan: fix the lint step'));
    expect(stubs.automationsApprove).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    rerender(<RunHistory automation={auto} confirm={confirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));
    await waitFor(() => expect(stubs.automationsApprove).toHaveBeenCalledWith('r1'));
    fireEvent.click(screen.getByRole('button', { name: 'Log' }));
    expect(await screen.findByText(/done/)).toBeTruthy();
  });
});

describe('SuggestionsPanel', () => {
  it('accepts a suggestion after confirmation', async () => {
    const s: Suggestion = {
      id: 's1', source: 'linear', projectId: 'wakecap', title: 'SAF-1: Add retries', detail: 'https://linear.app/x', ticket: 'SAF-1',
      file: null, line: null, state: 'new', createdAt: '2026-09-17T09:00:00.000Z', decidedAt: null, runPtyId: null,
    };
    const stubs = api({ suggestionsList: vi.fn(async () => [s]) });
    renderWithClient(<SuggestionsPanel confirm={() => true} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start SAF-1: Add retries' }));
    await waitFor(() => expect(stubs.suggestionsAccept).toHaveBeenCalledWith('s1'));
  });
});
```

Run: `pnpm vitest run apps/web/src/features/automations`
Expected: FAIL, `Cannot find module './AutomationsPage.tsx'`

- [ ] **Step 4: Implement the query hooks**

`apps/web/src/api/queries/automations.ts`
```ts
import type { AutomationInput, AutomationSettingsPatch } from '@orc/api-contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '@/api/client.ts';

export const automationKeys = {
  list: ['automations'] as const,
  settings: ['automation-settings'] as const,
  runs: (id: string) => ['automation-runs', id] as const,
  log: (runId: string) => ['automation-run-log', runId] as const,
  suggestions: ['automation-suggestions'] as const,
};

export function useAutomations() {
  return useQuery({ queryKey: automationKeys.list, queryFn: () => getApiClient().automationsList() });
}

export function useAutomationSettingsGet() {
  return useQuery({ queryKey: automationKeys.settings, queryFn: () => getApiClient().automationsSettingsGet() });
}

export function useAutomationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: AutomationSettingsPatch) => getApiClient().automationsSettings(patch),
    onSuccess: (data) => qc.setQueryData(automationKeys.settings, data),
  });
}

export function useSaveAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: AutomationInput) => getApiClient().automationsSave(a),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationKeys.list }),
  });
}

export function useDeleteAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApiClient().automationsDelete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationKeys.list }),
  });
}

export function useSetAutomationEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => getApiClient().automationsSetEnabled(v.id, v.enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationKeys.list }),
  });
}

export function useRunAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApiClient().automationsRun(id),
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: automationKeys.list });
      void qc.invalidateQueries({ queryKey: automationKeys.runs(run.automationId) });
    },
  });
}

export function useAutomationRuns(id: string | null) {
  return useQuery({
    queryKey: automationKeys.runs(id ?? ''),
    queryFn: () => getApiClient().automationsRuns(id ?? ''),
    enabled: id !== null,
  });
}

export function useRunLog(runId: string | null) {
  return useQuery({
    queryKey: automationKeys.log(runId ?? ''),
    queryFn: () => getApiClient().automationsRunLog(runId ?? ''),
    enabled: runId !== null,
    refetchInterval: 5000,
  });
}

export function useRunAction(automationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { runId: string; action: 'approve' | 'reject' | 'rerun' }) => {
      const c = getApiClient();
      if (v.action === 'approve') return c.automationsApprove(v.runId);
      if (v.action === 'reject') return c.automationsReject(v.runId);
      return c.automationsRerun(v.runId);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: automationKeys.runs(automationId) });
      void qc.invalidateQueries({ queryKey: automationKeys.list });
    },
  });
}

export function useSuggestions() {
  return useQuery({ queryKey: automationKeys.suggestions, queryFn: () => getApiClient().suggestionsList('new') });
}

export function useRefreshSuggestions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => getApiClient().suggestionsRefresh(),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationKeys.suggestions }),
  });
}

export function useSuggestionAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; action: 'accept' | 'dismiss' }) =>
      v.action === 'accept' ? getApiClient().suggestionsAccept(v.id) : getApiClient().suggestionsDismiss(v.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationKeys.suggestions }),
  });
}
```

- [ ] **Step 5: Implement the components**

`apps/web/src/features/automations/AutomationEditor.tsx`
```tsx
import { ALL_PROJECTS, type Automation } from '@orc/api-contract';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { useProjects } from '@/api/queries/projects.ts';
import { useSaveAutomation } from '@/api/queries/automations.ts';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { buildAutomation, type EditorForm, emptyForm, formFromAutomation } from './editor-model.ts';

const field = 'flex flex-col gap-1 text-sm';

export function AutomationEditor({ projectId, initial, onDone }: { projectId: string; initial?: Automation; onDone(): void }) {
  const { data: projects = [] } = useProjects();
  const startProject = projectId === ALL_PROJECTS ? 'wakecap' : projectId;
  const [form, setForm] = useState<EditorForm>(() => (initial ? formFromAutomation(initial) : emptyForm(startProject)));
  const [errors, setErrors] = useState<string[]>([]);
  const templates = useQuery({
    queryKey: ['templates', form.projectId],
    queryFn: () => getApiClient().templatesList(form.projectId),
  });
  const save = useSaveAutomation();
  const set = <K extends keyof EditorForm>(k: K, v: EditorForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = buildAutomation(form);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors([]);
    save.mutate(r.value, { onSuccess: onDone });
  };

  return (
    <form aria-label="Automation editor" onSubmit={submit} className="flex max-w-2xl flex-col gap-3">
      <h2 className="text-base font-semibold">{initial ? `Edit ${initial.name}` : 'New automation'}</h2>
      {!initial ? <p className="text-xs text-muted-foreground">New automations start turned off. Turn one on from the list once you are happy with it.</p> : null}
      <label className={field} htmlFor="auto-name">
        Name
        <Input id="auto-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className={field} htmlFor="auto-project">
          Project
          <NativeSelect id="auto-project" value={form.projectId} onChange={(e) => set('projectId', e.target.value)}>
            {projects.length === 0 ? <option value={form.projectId}>{form.projectId}</option> : null}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className={field} htmlFor="auto-template">
          Template
          <NativeSelect id="auto-template" value={form.templateId} onChange={(e) => set('templateId', e.target.value)}>
            <option value="">Choose a template…</option>
            {(templates.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>
      <label className={field} htmlFor="auto-trigger">
        Trigger
        <NativeSelect id="auto-trigger" value={form.triggerType} onChange={(e) => set('triggerType', e.target.value as EditorForm['triggerType'])}>
          <option value="manual">Manual only</option>
          <option value="cron">Schedule (cron)</option>
          <option value="github">GitHub event on my PRs</option>
          <option value="linear">Linear event</option>
          <option value="slack">Slack mention</option>
        </NativeSelect>
      </label>
      {form.triggerType === 'cron' ? (
        <label className={field} htmlFor="auto-cron">
          Cron
          <Input id="auto-cron" value={form.cron} onChange={(e) => set('cron', e.target.value)} placeholder="0 9 * * 1-5" />
        </label>
      ) : null}
      {form.triggerType === 'github' ? (
        <label className={field} htmlFor="auto-gh">
          GitHub event
          <NativeSelect id="auto-gh" value={form.githubEvent} onChange={(e) => set('githubEvent', e.target.value as EditorForm['githubEvent'])}>
            <option value="check_failed">Check failed</option>
            <option value="review_comment">Changes requested</option>
            <option value="pr_merged">PR merged (backmerge suggestion)</option>
          </NativeSelect>
          <span className="text-xs text-muted-foreground">Only PRs from repos listed in this project's settings start this automation.</span>
        </label>
      ) : null}
      {form.triggerType === 'linear' ? (
        <div className="grid grid-cols-2 gap-3">
          <label className={field} htmlFor="auto-linear">
            Linear event
            <NativeSelect id="auto-linear" value={form.linearEvent} onChange={(e) => set('linearEvent', e.target.value as EditorForm['linearEvent'])}>
              <option value="assigned">Assigned to me</option>
              <option value="labeled">Label added</option>
            </NativeSelect>
          </label>
          {form.linearEvent === 'labeled' ? (
            <label className={field} htmlFor="auto-label">
              Label
              <Input id="auto-label" value={form.linearLabel} onChange={(e) => set('linearLabel', e.target.value)} />
            </label>
          ) : null}
        </div>
      ) : null}
      {form.triggerType === 'slack' ? (
        <label className={field} htmlFor="auto-slack">
          Slack channel ID
          <Input id="auto-slack" value={form.slackChannel} onChange={(e) => set('slackChannel', e.target.value)} placeholder="C0123456" />
        </label>
      ) : null}
      <fieldset className="grid grid-cols-2 gap-2 rounded border p-3 text-sm">
        <legend className="px-1">Run</legend>
        <label className="flex items-center gap-2">
          <Checkbox aria-label="Use a new worktree" checked={form.useWorktree} onCheckedChange={(v) => set('useWorktree', v)} />
          Use a new worktree
        </label>
        <label className="flex items-center gap-2">
          <Checkbox aria-label="Headless" checked={form.headless} onCheckedChange={(v) => set('headless', v)} />
          Headless (claude -p)
        </label>
        <label className="flex items-center gap-2">
          <Checkbox aria-label="Plan approval first" checked={form.planApproval} onCheckedChange={(v) => set('planApproval', v)} />
          Plan approval first
        </label>
        <label className={field} htmlFor="auto-model">
          Model (optional)
          <Input id="auto-model" value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="claude-sonnet-5" />
        </label>
        <label className={field} htmlFor="auto-repo">
          Repo path (optional)
          <Input id="auto-repo" value={form.repo} onChange={(e) => set('repo', e.target.value)} />
        </label>
        <label className={field} htmlFor="auto-timeout">
          Timeout (minutes)
          <Input id="auto-timeout" type="number" min={1} max={240} value={form.timeoutMin} onChange={(e) => set('timeoutMin', Number(e.target.value))} />
        </label>
        <label className={field} htmlFor="auto-budget">
          Monthly budget (USD)
          <Input id="auto-budget" type="number" min={0.5} step={0.5} value={form.budgetUsd} onChange={(e) => set('budgetUsd', Number(e.target.value))} />
        </label>
      </fieldset>
      <p className="text-xs text-muted-foreground">
        Runs use a restricted tool set: no merges, no force-push, no deploy, kubectl, terraform or production access. The shared deny-list is checked before every run.
      </p>
      {errors.length > 0 ? (
        <ul role="alert" className="text-sm text-destructive">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {save.error ? <p role="alert" className="text-sm text-destructive">{save.error.message}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
```

`apps/web/src/features/automations/RunHistory.tsx`
```tsx
import type { AutomationRunDetail, AutomationWithStats } from '@orc/api-contract';
import { useState } from 'react';
import { useAutomationRuns, useRunAction, useRunLog } from '@/api/queries/automations.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { formatCost, formatDateTime } from '@/lib/format.ts';

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive' | 'success' | 'warning';
const STATUS_VARIANT: Record<AutomationRunDetail['status'], BadgeVariant> = {
  queued: 'outline',
  running: 'default',
  awaiting_approval: 'secondary',
  success: 'success',
  failed: 'destructive',
  denied: 'warning',
  over_budget: 'warning',
};

export function RunHistory({
  automation,
  confirm = (m: string) => window.confirm(m),
}: {
  automation: AutomationWithStats;
  confirm?: (message: string) => boolean;
}) {
  const { data: runs = [], isLoading } = useAutomationRuns(automation.id);
  const action = useRunAction(automation.id);
  const [logRun, setLogRun] = useState<string | null>(null);
  const log = useRunLog(logRun);

  return (
    <section className="flex flex-col gap-3" aria-label={`Runs of ${automation.name}`}>
      <h2 className="text-base font-semibold">Run history · {automation.name}</h2>
      {isLoading ? <p className="text-sm">Loading…</p> : null}
      {!isLoading && runs.length === 0 ? <p className="text-sm text-muted-foreground">No runs yet.</p> : null}
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th>Started</th>
            <th>Trigger</th>
            <th>Status</th>
            <th>Cost</th>
            <th>Result</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-t align-top">
              <td className="py-1">{formatDateTime(r.startedAt)}</td>
              <td>{r.triggerSource}</td>
              <td>
                <Badge variant={STATUS_VARIANT[r.status]}>{r.status.replace('_', ' ')}</Badge>
              </td>
              <td>{formatCost(r.costUsd)}</td>
              <td className="max-w-md">
                {r.prUrl ? (
                  <a className="underline" href={r.prUrl} target="_blank" rel="noreferrer">
                    PR
                  </a>
                ) : null}
                {r.diffStat ? (
                  <span className="ml-2 text-xs">
                    {r.diffStat.files} files +{r.diffStat.insertions} −{r.diffStat.deletions}
                  </span>
                ) : null}
                {r.summary ? <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">{r.summary}</p> : null}
                {r.error ? <p className="text-xs text-destructive">{r.error}</p> : null}
              </td>
              <td className="flex gap-1 py-1">
                {r.status === 'awaiting_approval' ? (
                  <>
                    <Button
                      size="sm"
                      onClick={() => {
                        if (confirm(`Approve the plan for "${automation.name}"? It cannot merge, deploy or touch production.\n\n${r.summary ?? ''}`)) {
                          action.mutate({ runId: r.id, action: 'approve' });
                        }
                      }}
                    >
                      Approve plan
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => action.mutate({ runId: r.id, action: 'reject' })}>
                      Reject
                    </Button>
                  </>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => action.mutate({ runId: r.id, action: 'rerun' })}>
                  Rerun
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setLogRun(logRun === r.id ? null : r.id)}>
                  Log
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {logRun ? (
        <pre aria-label="Run log" className="max-h-80 overflow-auto rounded bg-muted p-2 text-xs">
          {(log.data?.lines ?? []).join('\n') || 'No output yet.'}
        </pre>
      ) : null}
    </section>
  );
}
```

`apps/web/src/features/automations/SuggestionsPanel.tsx`
```tsx
import { useRefreshSuggestions, useSuggestionAction, useSuggestions } from '@/api/queries/automations.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useTerminalStore } from '@/stores/terminals.ts';

export function SuggestionsPanel({ confirm = (m: string) => window.confirm(m) }: { confirm?: (message: string) => boolean }) {
  const { data: suggestions = [] } = useSuggestions();
  const refresh = useRefreshSuggestions();
  const act = useSuggestionAction();
  const openTerminal = useTerminalStore((s) => s.open);

  return (
    <section className="flex flex-col gap-2" aria-label="Suggested tasks">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">Suggested tasks</h2>
        <Button size="sm" variant="outline" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          Refresh
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">From your Linear backlog and new TODO/FIXME comments in app worktrees. Nothing starts until you press Start.</p>
      {suggestions.length === 0 ? <p className="text-sm text-muted-foreground">No suggestions right now.</p> : null}
      <ul className="flex flex-col gap-1">
        {suggestions.map((s) => (
          <li key={s.id} className="flex items-center gap-2 rounded border px-2 py-1 text-sm">
            <Badge variant="outline">{s.source}</Badge>
            <span className="truncate">{s.title}</span>
            <span className="truncate text-xs text-muted-foreground">{s.detail}</span>
            <Button
              size="sm"
              className="ml-auto"
              aria-label={`Start ${s.title}`}
              onClick={() => {
                if (!confirm(`Start a Claude session for "${s.title}"?`)) return;
                act.mutate(
                  { id: s.id, action: 'accept' },
                  {
                    onSuccess: (res) => {
                      const r = res as { ptyId?: string };
                      if (r.ptyId) openTerminal(r.ptyId, s.title);
                    },
                  },
                );
              }}
            >
              Start
            </Button>
            <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: s.id, action: 'dismiss' })}>
              Dismiss
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

`apps/web/src/features/automations/AutomationsPage.tsx`
```tsx
import type { AutomationWithStats } from '@orc/api-contract';
import { useState } from 'react';
import {
  useAutomationSettings,
  useAutomationSettingsGet,
  useAutomations,
  useRunAutomation,
  useSetAutomationEnabled,
} from '@/api/queries/automations.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { formatCost, formatDateTime } from '@/lib/format.ts';
import { useProjectStore } from '@/stores/project.ts';
import { AutomationEditor } from './AutomationEditor.tsx';
import { describeTrigger, formatSuccessRate } from './editor-model.ts';
import { RunHistory } from './RunHistory.tsx';
import { SuggestionsPanel } from './SuggestionsPanel.tsx';

type Pane =
  | { kind: 'none' }
  | { kind: 'new' }
  | { kind: 'edit'; automation: AutomationWithStats }
  | { kind: 'runs'; automation: AutomationWithStats };

export function AutomationsPage() {
  const projectId = useProjectStore((s) => s.projectId);
  const { data: automations = [], isLoading } = useAutomations();
  const settings = useAutomationSettingsGet();
  const saveSettings = useAutomationSettings();
  const setEnabled = useSetAutomationEnabled();
  const runNow = useRunAutomation();
  const [pane, setPane] = useState<Pane>({ kind: 'none' });
  const masterOn = settings.data?.enabled ?? false;

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <header className="flex items-center gap-4">
        <h1 className="text-lg font-semibold">Automations</h1>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox aria-label="Automations enabled" checked={masterOn} onCheckedChange={(v) => saveSettings.mutate({ enabled: v })} />
          Automations enabled
        </label>
        {settings.data && !masterOn ? <Badge variant="warning">Off — nothing runs</Badge> : null}
        <Button className="ml-auto" onClick={() => setPane({ kind: 'new' })}>
          New automation
        </Button>
      </header>
      <p className="text-sm text-muted-foreground">
        Automations never merge, deploy or touch production. Each one has a monthly budget, and every run is audited.
      </p>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(320px,1fr)_2fr] gap-4">
        <ul className="flex flex-col gap-2 overflow-auto" aria-label="Automation list">
          {isLoading ? <li className="text-sm">Loading…</li> : null}
          {!isLoading && automations.length === 0 ? <li className="text-sm text-muted-foreground">No automations yet.</li> : null}
          {automations.map((a) => (
            <li key={a.id}>
              <Card className="flex flex-col gap-1 p-3">
                <div className="flex items-center gap-2">
                  <Checkbox aria-label={`Enable ${a.name}`} checked={a.enabled} onCheckedChange={(v) => setEnabled.mutate({ id: a.id, enabled: v })} />
                  <button type="button" className="font-medium hover:underline" onClick={() => setPane({ kind: 'edit', automation: a })}>
                    {a.name}
                  </button>
                  <span className="ml-auto text-xs text-muted-foreground">{describeTrigger(a.trigger)}</span>
                </div>
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>Success {formatSuccessRate(a.stats.successRate)}</span>
                  <span>{a.stats.total} runs</span>
                  <span>
                    {formatCost(a.stats.monthSpendUsd)} of {formatCost(a.budgetUsd)} this month
                  </span>
                  {a.nextRunAt ? <span>Next {formatDateTime(a.nextRunAt)}</span> : null}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={!masterOn || runNow.isPending} onClick={() => runNow.mutate(a.id)}>
                    Run now
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPane({ kind: 'runs', automation: a })}>
                    History
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
        <section className="min-h-0 overflow-auto">
          {pane.kind === 'new' ? <AutomationEditor projectId={projectId} onDone={() => setPane({ kind: 'none' })} /> : null}
          {pane.kind === 'edit' ? (
            <AutomationEditor key={pane.automation.id} projectId={projectId} initial={pane.automation} onDone={() => setPane({ kind: 'none' })} />
          ) : null}
          {pane.kind === 'runs' ? <RunHistory automation={pane.automation} /> : null}
          {pane.kind === 'none' ? <SuggestionsPanel /> : null}
        </section>
      </div>
    </div>
  );
}
```

`apps/web/src/routes/automations.tsx`
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { AutomationsPage } from '@/features/automations/AutomationsPage.tsx';

export const Route = createFileRoute('/automations')({ component: AutomationsPage });
```

In `apps/web/src/features/shell/AppShell.tsx`, add this after the last existing nav link:
```tsx
          <Link to="/automations" className="rounded px-2 py-1 hover:bg-muted" activeProps={{ className: 'bg-muted font-medium' }}>
            Automations
          </Link>
```

`AutomationWithStats` extends `Automation`, so passing it as `initial` typechecks.

- [ ] **Step 6: Run the tests, then all checks, and commit**

Run: `pnpm vitest run apps/web/src/features/automations`
Expected: PASS (editor-model 4, page 4, run history 1, suggestions 1)

Run: `pnpm --filter @orc/web build` (regenerates the TanStack route tree) then `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/web/src
git commit -m "feat(web): add automations page with editor, run history, logs and suggestions"
```

---

# 7B Compare Mode (F21)

### Task 11: Compare groups, launch across N worktrees, cost estimate

**Files:**
- Modify: `apps/daemon/src/db/schema.ts`, `packages/api-contract/src/live.ts`, `packages/api-contract/src/clients/phase7.ts`, `packages/api-contract/src/index.ts`, `packages/api-contract/src/routes/p7-placeholders.ts`
- Create: `packages/api-contract/src/routes/compare.ts`, `packages/api-contract/src/clients/compare.ts`, `apps/daemon/src/db/repos/compare.ts`, migration (generated)
- Modify (replace the Task 1 stub): `apps/daemon/src/services/compare/compare.ts`
- Test: `apps/daemon/test/p7/compare-launch.test.ts`

**Interfaces:**
- Consumes: `LaunchRequest` (P2 zod + type); `ctx.launcher.launch` (P2); `ctx.worktrees.createWith` (P4); `ctx.usage` (P5); `ctx.sessions.list` (P1); `assertOwnedCapacity` (Task 1); `DiffStatSchema` (Task 1); `TestResultSchema` (P1 api-contract); `ServiceError`; `sessionPk`; `ApiCall` (Task 1).
- Produces:
  ```ts
  // @orc/api-contract routes/compare.ts (zod + types)
  CompareVariantInput, CompareVariant, CompareGroup, CompareEstimate, CompareVariantView, CompareView, ArchiveLosersResult, PickWinnerBody, PickWinnerResult
  // clients/compare.ts
  export interface CompareApi {
    compareLaunch(req: LaunchRequestInput): Promise<CompareGroup>;
    compareEstimate(projectId: string | null, n: number): Promise<CompareEstimate>;
    compareGet(groupId: string): Promise<CompareView>;
    comparePickWinner(groupId: string, index: number): Promise<PickWinnerResult>;
    compareArchiveLosers(groupId: string): Promise<ArchiveLosersResult>;
  }
  export function compareClient(call: ApiCall): CompareApi
  // db/repos/compare.ts
  export function insertGroup(db: OrcDb, g: CompareGroup): CompareGroup
  export function getGroup(db: OrcDb, id: string): CompareGroup | null
  export function updateGroup(db: OrcDb, id: string, patch: Partial<Pick<CompareGroup, 'state' | 'winnerIndex' | 'variants'>>, now: string): CompareGroup
  export function listGroups(db: OrcDb, limit?: number): CompareGroup[]
  export function findSessionPkByCwd(db: OrcDb, cwd: string): string | null
  // services/compare/compare.ts
  export interface CompareDeps { ctx: DaemonContext; now?: () => Date; resolveSessionByCwd?: (cwd: string) => string | null; diffStatFn?: (cwd: string, base: string) => Promise<DiffStat> }
  export function variantLabel(v: { source: 'claude' | 'codex'; model?: string | null }, index: number): string   // "v1 claude:claude-opus-5"
  export function median(values: number[]): number | null
  export function createCompareService(deps: CompareDeps): CompareService & { list(limit?: number): CompareGroup[] }
  // live.ts: LiveEvent adds { type: 'compare.updated'; group: CompareGroup }
  ```
  Launch rules:
  - `compare` must have between 2 and `config.compare.maxVariants` entries (400 `validation_failed`).
  - `worktree` is required (400 `validation_failed`), because each variant gets its own worktree: `<slug>-v<i>-<source[-model]>`, created with `runSetup: true, actor: 'user'`.
  - `UsageMeter.checkBudget` must be ok (409 `over_budget`).
  - There must be capacity for N owned sessions (409 `capacity_exceeded`).
  - Each variant is launched through `LaunchService.launch({ ...req, source, model, cwd: worktreePath, worktree: undefined, compare: undefined })`.
  - A variant that fails is recorded with `error` and the others go ahead.
  - The launch is audited as `compare.launch`.

  Estimate: `multiplier = n`. `avgSessionCostUsd` is the median `costUsd` of the project's 50 most recent sessions that have a cost, and `estimatedUsd = median × n`. The estimate also carries `UsageSnapshot.burnRateUsdPerHour` and `checkBudget({ projectId })`.

- [ ] **Step 1: Write the schemas, client, table and repo**

`packages/api-contract/src/routes/compare.ts`
```ts
import { z } from 'zod';
import { DiffStatSchema } from './p7-common.ts';
import { TestResultSchema } from './sessions.ts';

const VariantSource = z.enum(['claude', 'codex']);

export const CompareVariantInput = z.object({ source: VariantSource, model: z.string().min(1).optional() });
export type CompareVariantInput = z.infer<typeof CompareVariantInput>;

export const CompareVariant = z.object({
  index: z.number().int().min(0),
  source: VariantSource,
  model: z.string().nullable(),
  label: z.string(),
  sessionId: z.string().nullable(),
  sessionPk: z.string().nullable(),
  ptyId: z.string().nullable(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  error: z.string().nullable(),
});
export type CompareVariant = z.infer<typeof CompareVariant>;

export const CompareGroup = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  prompt: z.string(),
  ticket: z.string().nullable(),
  repo: z.string(),
  base: z.string(),
  createdAt: z.string(),
  state: z.enum(['running', 'decided', 'archived']),
  winnerIndex: z.number().int().nullable(),
  estimateUsd: z.number().nullable(),
  variants: z.array(CompareVariant),
});
export type CompareGroup = z.infer<typeof CompareGroup>;

export const CompareEstimate = z.object({
  variants: z.number().int(),
  multiplier: z.number(),
  avgSessionCostUsd: z.number().nullable(),
  estimatedUsd: z.number().nullable(),
  sample: z.number().int(),
  burnRateUsdPerHour: z.number(),
  budget: z.object({ ok: z.boolean(), pct: z.number(), limitUsd: z.number().nullable() }),
});
export type CompareEstimate = z.infer<typeof CompareEstimate>;

export const CompareVariantView = CompareVariant.extend({
  status: z.string(),
  costUsd: z.number().nullable(),
  durationMs: z.number().nullable(),
  tests: TestResultSchema.nullable(),
  recap: z.string().nullable(),
  diff: DiffStatSchema.nullable(),
});
export type CompareVariantView = z.infer<typeof CompareVariantView>;

export const CompareView = z.object({ group: CompareGroup, variants: z.array(CompareVariantView) });
export type CompareView = z.infer<typeof CompareView>;

export const ArchiveLosersResult = z.object({
  group: CompareGroup,
  results: z.array(
    z.object({
      index: z.number().int(),
      worktreePath: z.string().nullable(),
      killed: z.boolean(),
      archived: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
});
export type ArchiveLosersResult = z.infer<typeof ArchiveLosersResult>;

export const PickWinnerBody = z.object({ index: z.number().int().min(0) });
export const PickWinnerResult = z.object({ group: CompareGroup, reviewUrl: z.string() });
export type PickWinnerResult = z.infer<typeof PickWinnerResult>;
export const CompareEstimateQuery = z.object({
  projectId: z.string().optional(),
  n: z.coerce.number().int().min(1).max(6),
});
```
If P1 exports `TestResultSchema` from a different file (for example `domain.ts`), change that one import.

`packages/api-contract/src/clients/compare.ts`
```ts
import { toQueryString } from '../client.ts';
import type { LaunchRequestInput } from '../routes/launch.ts';
import { ArchiveLosersResult, CompareEstimate, CompareGroup, CompareView, PickWinnerResult } from '../routes/compare.ts';
import type { ApiCall } from './phase7.ts';

export interface CompareApi {
  compareLaunch(req: LaunchRequestInput): Promise<CompareGroup>;
  compareEstimate(projectId: string | null, n: number): Promise<CompareEstimate>;
  compareGet(groupId: string): Promise<CompareView>;
  comparePickWinner(groupId: string, index: number): Promise<PickWinnerResult>;
  compareArchiveLosers(groupId: string): Promise<ArchiveLosersResult>;
}

export function compareClient(call: ApiCall): CompareApi {
  const g = (id: string) => `/api/compare/${encodeURIComponent(id)}`;
  return {
    compareLaunch: (req) => call(CompareGroup, 'POST', '/api/compare', req),
    compareEstimate: (projectId, n) => call(CompareEstimate, 'GET', `/api/compare/estimate${toQueryString({ projectId, n })}`),
    compareGet: (id) => call(CompareView, 'GET', g(id)),
    comparePickWinner: (id, index) => call(PickWinnerResult, 'POST', `${g(id)}/winner`, { index }),
    compareArchiveLosers: (id) => call(ArchiveLosersResult, 'POST', `${g(id)}/archive-losers`, { confirm: true }),
  };
}
```
`LaunchRequestInput` is P2's `z.input<typeof LaunchRequest>` from `routes/launch.ts`. If P2 names it differently, use `z.input<typeof LaunchRequest>` directly.

`packages/api-contract/src/clients/phase7.ts`: add `import { type CompareApi, compareClient } from './compare.ts';`, then extend `Phase7Api` with `& CompareApi` and add `...compareClient(call),` to the returned object. With 7A merged, the file reads:
```ts
export type Phase7Api = AutomationsApi & CompareApi;

export function phase7Client(call: ApiCall): Phase7Api {
  return { ...automationsClient(call), ...compareClient(call) };
}
```

`packages/api-contract/src/index.ts`: add `export * from './routes/compare.ts';` and `export * from './clients/compare.ts';`. In `routes/p7-placeholders.ts`, delete the `CompareGroup`, `CompareEstimate`, `CompareView` and `ArchiveLosersResult` lines.

`packages/api-contract/src/live.ts`: add `import type { CompareGroup } from './routes/compare.ts';` and the union variant:
```ts
  | { type: 'compare.updated'; group: CompareGroup }
```

Append to `apps/daemon/src/db/schema.ts`:
```ts
// ── Phase 7: compare mode ────────────────────────────────────────────
export const compareGroups = sqliteTable(
  'compare_groups',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id'),
    prompt: text('prompt').notNull(),
    ticket: text('ticket'),
    repo: text('repo').notNull(),
    base: text('base').notNull(),
    state: text('state').notNull().default('running'),
    winnerIndex: integer('winner_index'),
    estimateUsd: real('estimate_usd'),
    variantsJson: text('variants_json').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('compare_groups_created').on(t.createdAt)],
);
```
Run: `pnpm --filter @orc/daemon db:generate`
Expected: a migration with `CREATE TABLE compare_groups`.

`apps/daemon/src/db/repos/compare.ts`
```ts
import { type CompareGroup, CompareVariant } from '@orc/api-contract';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { OrcDb } from '../client.ts';
import { compareGroups } from '../schema.ts';

type Row = typeof compareGroups.$inferSelect;
const Variants = z.array(CompareVariant);

const toGroup = (r: Row): CompareGroup => ({
  id: r.id,
  projectId: r.projectId,
  prompt: r.prompt,
  ticket: r.ticket,
  repo: r.repo,
  base: r.base,
  createdAt: r.createdAt,
  state: r.state as CompareGroup['state'],
  winnerIndex: r.winnerIndex,
  estimateUsd: r.estimateUsd,
  variants: Variants.parse(JSON.parse(r.variantsJson)),
});

export function insertGroup(db: OrcDb, g: CompareGroup): CompareGroup {
  db.insert(compareGroups)
    .values({
      id: g.id,
      projectId: g.projectId,
      prompt: g.prompt,
      ticket: g.ticket,
      repo: g.repo,
      base: g.base,
      state: g.state,
      winnerIndex: g.winnerIndex,
      estimateUsd: g.estimateUsd,
      variantsJson: JSON.stringify(g.variants),
      createdAt: g.createdAt,
      updatedAt: g.createdAt,
    })
    .run();
  const saved = getGroup(db, g.id);
  if (!saved) throw new Error(`compare group ${g.id} was not saved`);
  return saved;
}

export function getGroup(db: OrcDb, id: string): CompareGroup | null {
  const row = db.select().from(compareGroups).where(eq(compareGroups.id, id)).get();
  return row ? toGroup(row) : null;
}

export function updateGroup(
  db: OrcDb,
  id: string,
  patch: Partial<Pick<CompareGroup, 'state' | 'winnerIndex' | 'variants'>>,
  now: string,
): CompareGroup {
  const set: Partial<Row> = { updatedAt: now };
  if (patch.state !== undefined) set.state = patch.state;
  if (patch.winnerIndex !== undefined) set.winnerIndex = patch.winnerIndex;
  if (patch.variants !== undefined) set.variantsJson = JSON.stringify(patch.variants);
  db.update(compareGroups).set(set).where(eq(compareGroups.id, id)).run();
  const g = getGroup(db, id);
  if (!g) throw new Error(`compare group ${id} not found`);
  return g;
}

export function listGroups(db: OrcDb, limit = 50): CompareGroup[] {
  return db.select().from(compareGroups).orderBy(desc(compareGroups.createdAt)).limit(limit).all().map(toGroup);
}

/** Newest indexed session whose start cwd is exactly `cwd` (used for Codex variants, which have no id at launch). */
export function findSessionPkByCwd(db: OrcDb, cwd: string): string | null {
  const row = db.get<{ pk: string } | undefined>(
    sql`select pk from sessions where start_cwd = ${cwd} order by started_at desc limit 1`,
  );
  return row?.pk ?? null;
}
```

- [ ] **Step 2: Write the failing service test**

`apps/daemon/test/p7/compare-launch.test.ts`
```ts
import { LaunchRequest } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import type { BusEvent } from '../../src/live/event-bus.ts';
import { createCompareService, median, variantLabel } from '../../src/services/compare/compare.ts';
import { ServiceError } from '../../src/services/errors.ts';
import { createTestContext, type TestContext } from '../helpers.ts';
import {
  createFakePty,
  fakeAudit,
  fakeLauncher,
  fakeProjects,
  fakeSessions,
  fakeUsage,
  fakeWorktrees,
  makeSession,
  testConfig,
} from '../fakes/phase7.ts';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

function setup(o: { usageOk?: boolean; launcherMax?: number } = {}) {
  const cfg = testConfig({ compare: { maxVariants: 3 } });
  const launcher = fakeLauncher({ max: o.launcherMax });
  const worktrees = fakeWorktrees();
  const audit = fakeAudit();
  const sessions = fakeSessions(
    [1, 3, 2, null].map((cost, i) =>
      makeSession({ id: `hist-${i}`, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: cost } }),
    ),
  );
  ctx = createTestContext({
    config: () => cfg,
    projects: fakeProjects(cfg),
    launcher,
    worktrees,
    audit,
    sessions,
    pty: createFakePty(),
    usage: fakeUsage({ ok: o.usageOk ?? true }),
  });
  const events: BusEvent[] = [];
  ctx.bus.on('compare.updated', (e) => events.push(e));
  const svc = createCompareService({ ctx });
  return { svc, launcher, worktrees, audit, events };
}

const req = (over: Record<string, unknown> = {}) =>
  LaunchRequest.parse({
    source: 'claude',
    projectId: 'wakecap',
    cwd: '/Users/test/Wakecap',
    prompt: 'Make the SLA deadline skip weekends',
    ticket: 'SAF-1787',
    worktree: { repo: '/Users/test/Wakecap/Backend/svc', base: 'main', type: 'feat', slug: 'sla-weekends' },
    compare: [{ source: 'claude', model: 'claude-opus-5' }, { source: 'codex' }],
    ...over,
  });

describe('helpers', () => {
  it('labels variants and computes medians', () => {
    expect(variantLabel({ source: 'claude', model: 'claude-opus-5' }, 0)).toBe('v1 claude:claude-opus-5');
    expect(variantLabel({ source: 'codex' }, 1)).toBe('v2 codex');
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe('CompareService.launch', () => {
  it('creates one worktree and one session per variant', async () => {
    const t = setup();
    const g = await t.svc.launch(req());
    expect(g.variants.map((v) => [v.label, v.error])).toEqual([
      ['v1 claude:claude-opus-5', null],
      ['v2 codex', null],
    ]);
    expect(t.worktrees.created.map((w) => w.branch)).toEqual([
      'feat/SAF-1787-sla-weekends-v1-claude-claude-opus-5',
      'feat/SAF-1787-sla-weekends-v2-codex',
    ]);
    expect(t.launcher.requests.map((r) => [r.source, r.model, r.cwd, r.compare, r.worktree])).toEqual([
      ['claude', 'claude-opus-5', t.worktrees.created[0]?.path, undefined, undefined],
      ['codex', undefined, t.worktrees.created[1]?.path, undefined, undefined],
    ]);
    expect(g.variants[0]?.sessionPk).toBe('claude:launched-1');
    expect(g.variants[1]?.sessionPk).toBeNull();
    expect(g).toMatchObject({ state: 'running', winnerIndex: null, estimateUsd: 4, repo: '/Users/test/Wakecap/Backend/svc', base: 'main' });
    expect(t.svc.get(g.id)).toEqual(g);
    expect(t.audit.entries.find((e) => e.action === 'compare.launch')).toMatchObject({ actor: 'user', target: `compare:${g.id}` });
    expect(t.events).toHaveLength(1);
  });

  it('records a failed variant and keeps the others', async () => {
    const t = setup({ launcherMax: 1 });
    const g = await t.svc.launch(req());
    expect(g.variants[0]?.error).toBeNull();
    expect(g.variants[1]?.error).toContain('too many');
  });

  it.each([
    ['one variant', { compare: [{ source: 'claude' }] }, 'validation_failed'],
    ['too many variants', { compare: [{ source: 'claude' }, { source: 'claude' }, { source: 'codex' }, { source: 'codex' }] }, 'validation_failed'],
    ['no worktree', { worktree: undefined }, 'validation_failed'],
  ])('rejects %s', async (_name, over, code) => {
    const t = setup();
    await expect(t.svc.launch(req(over))).rejects.toMatchObject({ code });
    expect(t.launcher.requests).toHaveLength(0);
  });

  it('refuses when over budget', async () => {
    const t = setup({ usageOk: false });
    const err = await t.svc.launch(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({ code: 'over_budget', status: 409 });
    expect(t.worktrees.created).toHaveLength(0);
  });
});

describe('CompareService.estimate', () => {
  it('multiplies the median recent session cost', () => {
    const t = setup();
    expect(t.svc.estimate('wakecap', 3)).toEqual({
      variants: 3,
      multiplier: 3,
      avgSessionCostUsd: 2,
      estimatedUsd: 6,
      sample: 3,
      burnRateUsdPerHour: 2.5,
      budget: { ok: true, pct: 0.2, limitUsd: 50 },
    });
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p7/compare-launch.test.ts`
Expected: FAIL, `createCompareService is not exported`

- [ ] **Step 3: Implement launch and estimate**

`apps/daemon/src/services/compare/compare.ts` (replaces the Task 1 stub; Task 12 adds `view`, `pickWinner` and `archiveLosers` in place of the three `notImplemented` members below)
```ts
import { randomUUID } from 'node:crypto';
import type {
  ArchiveLosersResult,
  CompareEstimate,
  CompareGroup,
  CompareVariant,
  CompareView,
  LaunchRequest,
} from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import * as repo from '../../db/repos/compare.ts';
import { ServiceError } from '../errors.ts';
import type { DiffStat } from '../git/git-info.ts';
import { assertOwnedCapacity } from '../launch/spawn.ts';
import { sessionPk } from '../sessions.ts';

export interface CompareService {
  launch(req: LaunchRequest): Promise<CompareGroup>;
  estimate(projectId: string | null, n: number): CompareEstimate;
  get(id: string): CompareGroup | null;
  view(id: string): Promise<CompareView>;
  pickWinner(id: string, index: number): { group: CompareGroup; reviewUrl: string };
  archiveLosers(id: string): Promise<ArchiveLosersResult>;
}

export interface CompareDeps {
  ctx: DaemonContext;
  now?: () => Date;
  resolveSessionByCwd?: (cwd: string) => string | null;
  diffStatFn?: (cwd: string, base: string) => Promise<DiffStat>;
}

export function variantLabel(v: { source: 'claude' | 'codex'; model?: string | null }, index: number): string {
  return `v${index + 1} ${v.source}${v.model ? `:${v.model}` : ''}`;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const hi = s[mid] ?? 0;
  if (s.length % 2 === 1) return hi;
  const lo = s[mid - 1] ?? hi;
  return (lo + hi) / 2;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const slugPart = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function required<T>(svc: T | undefined, name: string): T {
  if (svc === undefined) throw new ServiceError('not_enabled', 409, `${name} is not running`);
  return svc;
}

export function createCompareService(deps: CompareDeps): CompareService & { list(limit?: number): CompareGroup[] } {
  const { ctx } = deps;
  const now = deps.now ?? (() => new Date());

  const emit = (group: CompareGroup) => ctx.bus.emit({ type: 'compare.updated', group });

  function estimate(projectId: string | null, n: number): CompareEstimate {
    const usage = required(ctx.usage, 'usage meter');
    const costs = ctx.sessions
      .list({ projectId: projectId ?? undefined, limit: 50 })
      .items.map((i) => i.costUsd)
      .filter((c): c is number => c !== null && c > 0);
    const med = median(costs);
    return {
      variants: n,
      multiplier: n,
      avgSessionCostUsd: med === null ? null : round2(med),
      estimatedUsd: med === null ? null : round2(med * n),
      sample: costs.length,
      burnRateUsdPerHour: usage.snapshot().burnRateUsdPerHour,
      budget: usage.checkBudget({ projectId: projectId ?? undefined }),
    };
  }

  async function launch(req: LaunchRequest): Promise<CompareGroup> {
    const wanted = req.compare ?? [];
    const max = ctx.config().compare.maxVariants;
    if (wanted.length < 2) throw new ServiceError('validation_failed', 400, 'compare mode needs at least 2 variants');
    if (wanted.length > max) throw new ServiceError('validation_failed', 400, `compare mode allows at most ${max} variants`);
    const wt = req.worktree;
    if (!wt) {
      throw new ServiceError('validation_failed', 400, 'compare mode needs a worktree (repo, base, type, slug); each variant gets its own');
    }
    const budget = required(ctx.usage, 'usage meter').checkBudget({ projectId: req.projectId ?? undefined, ticket: req.ticket });
    if (!budget.ok) {
      throw new ServiceError('over_budget', 409, `budget is at ${Math.round(budget.pct * 100)}%`, budget);
    }
    assertOwnedCapacity(ctx, req.projectId, wanted.length);
    const est = estimate(req.projectId, wanted.length);
    const launcher = required(ctx.launcher, 'launch service');
    const worktrees = required(ctx.worktrees, 'worktree service');

    const variants: CompareVariant[] = [];
    for (const [index, v] of wanted.entries()) {
      const label = variantLabel(v, index);
      const base: CompareVariant = {
        index,
        source: v.source,
        model: v.model ?? null,
        label,
        sessionId: null,
        sessionPk: null,
        ptyId: null,
        worktreePath: null,
        branch: null,
        error: null,
      };
      try {
        const { view } = await worktrees.createWith(
          {
            repo: wt.repo,
            base: wt.base,
            type: wt.type,
            ticket: req.ticket ?? null,
            slug: `${wt.slug}-v${index + 1}-${slugPart(`${v.source}${v.model ? `-${v.model}` : ''}`)}`,
          },
          { runSetup: true, actor: 'user' },
        );
        base.worktreePath = view.path;
        base.branch = view.branch;
        const res = await launcher.launch({
          ...req,
          source: v.source,
          model: v.model,
          cwd: view.path,
          worktree: undefined,
          compare: undefined,
        });
        base.ptyId = res.ptyId;
        base.sessionId = res.sessionId;
        base.sessionPk = res.sessionId ? sessionPk(v.source, res.sessionId) : null;
      } catch (e) {
        base.error = e instanceof Error ? e.message : String(e);
      }
      variants.push(base);
    }

    const group = repo.insertGroup(ctx.db, {
      id: randomUUID(),
      projectId: req.projectId,
      prompt: req.prompt || (req.templateId ? `template ${req.templateId}` : ''),
      ticket: req.ticket ?? null,
      repo: wt.repo,
      base: wt.base,
      createdAt: now().toISOString(),
      state: 'running',
      winnerIndex: null,
      estimateUsd: est.estimatedUsd,
      variants,
    });
    ctx.audit?.record({
      actor: 'user',
      actorDetail: null,
      action: 'compare.launch',
      target: `compare:${group.id}`,
      params: { variants: variants.map((v) => ({ label: v.label, error: v.error })), estimateUsd: est.estimatedUsd, ticket: group.ticket },
      result: variants.every((v) => v.error) ? 'error' : 'ok',
      error: variants.every((v) => v.error) ? 'every variant failed to launch' : null,
    });
    emit(group);
    return group;
  }

  const notImplemented = (): never => {
    throw new ServiceError('not_enabled', 409, 'added in Task 12');
  };

  return {
    launch,
    estimate,
    get: (id) => repo.getGroup(ctx.db, id),
    list: (limit) => repo.listGroups(ctx.db, limit),
    view: async () => notImplemented(),
    pickWinner: () => notImplemented(),
    archiveLosers: async () => notImplemented(),
  };
}
```
`CompareDeps.resolveSessionByCwd` and `CompareDeps.diffStatFn` are read in Task 12.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/test/p7/compare-launch.test.ts`
Expected: PASS (1 + 5 + 1 = 7 tests)

- [ ] **Step 5: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add packages/api-contract apps/daemon/src/db apps/daemon/src/services/compare apps/daemon/test/p7/compare-launch.test.ts
git commit -m "feat(compare): launch a task across N agents in separate worktrees with a cost estimate"
```

---

### Task 12: Compare view, pick winner, archive losers, routes and launch delegation

**Files:**
- Modify: `apps/daemon/src/services/compare/compare.ts`
- Create: `apps/daemon/src/http/routes/compare.ts`
- Modify: `apps/daemon/src/http/app.ts`, the P2 handler for `POST /api/sessions/launch` (find it with `grep -rn "sessions/launch" apps/daemon/src/http/routes`), `packages/api-contract/src/routes/launch.ts` (response union), `apps/daemon/src/main.ts`
- Test: `apps/daemon/test/p7/compare-decide.test.ts`, `apps/daemon/test/p7/compare-routes.test.ts`

**Interfaces:**
- Consumes: Task 11; `ctx.sessions.getByPk` (P1); `ctx.pty.get/kill` (§7); `ctx.worktrees.archiveAs(path, actor)` (P4); `splitPk` (P2 core); `readJson`, `createApp` (P1); `need`, `requireConfirmed`, `ConfirmBody`, `API_BASE`, `TEST_TOKEN` (Task 1).
- Produces:
  - `CompareService.view(id)`: resolves missing session pks by worktree cwd and persists them. Each variant carries `status` (live status, or `ended`, `starting` or `error`), `costUsd`, `durationMs`, `tests`, `recap` (recap, falling back to the away summary) and `diff` (vs the group base).
  - `pickWinner(id, index)`: sets `state: 'decided'` and `winnerIndex`, audits `compare.pick`, and returns `reviewUrl = /review/<source>/<sessionId>`. It returns 409 `session_unknown` when the variant has no session and 409 `invalid_state` when the group is archived.
  - `archiveLosers(id)`: returns 409 `invalid_state` until a winner is picked. For each loser it kills a live PTY (audited `session.kill`) and archives the worktree through P4 (`archiveAs(path, 'user')`, which refuses dirty worktrees). The reason is reported per variant. The state becomes `archived` only when every loser worktree is archived. Audited as `compare.archive`.
  - `export function registerCompareRoutes(app: OrcApp, ctx: DaemonContext): void`
  - `POST /api/sessions/launch` with `compare.length ≥ 1` returns `201 { compareGroupId }` via `ctx.compare.launch`, or 409 `not_enabled` when compare is not wired. `LaunchResponse` becomes `z.union([<P2 shape>, z.object({ compareGroupId: z.string() })])`.

- [ ] **Step 1: Write the failing service test**

`apps/daemon/test/p7/compare-decide.test.ts`
```ts
import { LaunchRequest } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { createCompareService } from '../../src/services/compare/compare.ts';
import type { LaunchService } from '../../src/services/launch.ts';
import { createTestContext, type TestContext } from '../helpers.ts';
import {
  createFakePty,
  fakeAudit,
  fakeProjects,
  fakeSessions,
  fakeUsage,
  fakeWorktrees,
  makeLive,
  makeSession,
  testConfig,
} from '../fakes/phase7.ts';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

async function setup(variants = 2) {
  const cfg = testConfig({ compare: { maxVariants: 3 } });
  const pty = createFakePty();
  const worktrees = fakeWorktrees();
  const audit = fakeAudit();
  const sessions = fakeSessions([
    makeSession({
      id: 'cl-1',
      live: makeLive({ status: 'review' }),
      recap: 'Added a weekend check with tests',
      lastTest: { ts: 't', command: 'pnpm test', passed: 12, failed: 0, skipped: 0, durationMs: 900 },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 1.2 },
      startedAt: '2026-09-17T09:00:00.000Z',
      lastActivityAt: '2026-09-17T09:20:00.000Z',
    }),
    makeSession({ id: 'cx-1', source: 'codex', awaySummary: 'Codex changed the util', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null } }),
  ]);
  let n = 0;
  const launcher: LaunchService = {
    async launch(r) {
      n++;
      const info = pty.spawn({ command: r.source, args: [], cwd: r.cwd, sessionPk: null });
      return { ptyId: info.id, sessionId: r.source === 'claude' ? `cl-${n}` : null };
    },
    async kill() {
      return { killed: 'pty' as const };
    },
    ownedCount: () => 0,
  };
  ctx = createTestContext({ config: () => cfg, projects: fakeProjects(cfg), pty, worktrees, audit, sessions, launcher, usage: fakeUsage() });
  const svc = createCompareService({
    ctx,
    resolveSessionByCwd: (cwd) => (cwd.includes('-v2-') ? 'codex:cx-1' : null),
    diffStatFn: async (cwd) => ({ files: cwd.includes('-v1-') ? 3 : 1, insertions: 10, deletions: 2, untracked: 0 }),
  });
  const compare = [{ source: 'claude' }, { source: 'codex' }, { source: 'codex', model: 'gpt-5.5-codex' }].slice(0, variants);
  const group = await svc.launch(
    LaunchRequest.parse({
      source: 'claude',
      projectId: 'wakecap',
      cwd: '/Users/test/Wakecap',
      prompt: 'weekends',
      worktree: { repo: '/Users/test/Wakecap/Backend/svc', base: 'main', type: 'feat', slug: 'sla' },
      compare,
    }),
  );
  return { svc, group, pty, worktrees, audit };
}

describe('CompareService.view', () => {
  it('shows status, cost, tests, recap and diff, and remembers resolved sessions', async () => {
    const t = await setup();
    const v = await t.svc.view(t.group.id);
    expect(v.variants.map((x) => [x.label, x.status, x.costUsd, x.recap, x.diff?.files])).toEqual([
      ['v1 claude', 'review', 1.2, 'Added a weekend check with tests', 3],
      ['v2 codex', 'ended', null, 'Codex changed the util', 1],
    ]);
    expect(v.variants[0]?.tests?.passed).toBe(12);
    expect(v.variants[0]?.durationMs).toBe(20 * 60_000);
    expect(t.svc.get(t.group.id)?.variants[1]).toMatchObject({ sessionPk: 'codex:cx-1', sessionId: 'cx-1' });
  });
});

describe('CompareService.pickWinner', () => {
  it('decides the group and links to review', async () => {
    const t = await setup();
    const r = t.svc.pickWinner(t.group.id, 0);
    expect(r.reviewUrl).toBe('/review/claude/cl-1');
    expect(r.group).toMatchObject({ state: 'decided', winnerIndex: 0 });
    expect(t.audit.entries.find((e) => e.action === 'compare.pick')?.params).toMatchObject({ index: 0 });
    expect(() => t.svc.pickWinner(t.group.id, 7)).toThrow(/not found/);
  });

  it('resolves a Codex session before picking it', async () => {
    const t = await setup();
    expect(t.svc.pickWinner(t.group.id, 1).reviewUrl).toBe('/review/codex/cx-1');
  });
});

describe('CompareService.archiveLosers', () => {
  it('needs a winner first', async () => {
    const t = await setup();
    await expect(t.svc.archiveLosers(t.group.id)).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('stops losing sessions, archives clean worktrees and keeps dirty ones', async () => {
    const t = await setup(3);
    const dirtyPath = t.group.variants[2]?.worktreePath ?? '';
    t.worktrees.dirty.add(dirtyPath);
    t.svc.pickWinner(t.group.id, 0);
    const res = await t.svc.archiveLosers(t.group.id);
    expect(res.results).toEqual([
      { index: 1, worktreePath: t.group.variants[1]?.worktreePath, killed: true, archived: true, reason: null },
      { index: 2, worktreePath: dirtyPath, killed: true, archived: false, reason: expect.stringContaining('uncommitted') },
    ]);
    expect(res.group.state).toBe('decided');
    expect(t.pty.killed).toEqual(['pty-2', 'pty-3']);
    expect(t.worktrees.archived).toEqual([{ path: t.group.variants[1]?.worktreePath, actor: 'user' }]);
    expect(t.audit.entries.filter((e) => e.action === 'session.kill')).toHaveLength(2);
    expect(t.audit.entries.find((e) => e.action === 'compare.archive')).toMatchObject({ result: 'error' });

    t.worktrees.dirty.clear();
    const again = await t.svc.archiveLosers(t.group.id);
    expect(again.group.state).toBe('archived');
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p7/compare-decide.test.ts`
Expected: FAIL with `not_enabled … added in Task 12`

- [ ] **Step 2: Implement view, pickWinner and archiveLosers**

In `apps/daemon/src/services/compare/compare.ts`:

1. Change the imports to:
```ts
import { randomUUID } from 'node:crypto';
import type {
  ArchiveLosersResult,
  CompareEstimate,
  CompareGroup,
  CompareVariant,
  CompareVariantView,
  CompareView,
  LaunchRequest,
} from '@orc/api-contract';
import { splitPk } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import * as repo from '../../db/repos/compare.ts';
import { ServiceError } from '../errors.ts';
import { type DiffStat, diffStat } from '../git/git-info.ts';
import { assertOwnedCapacity } from '../launch/spawn.ts';
import { sessionPk } from '../sessions.ts';
```
2. Directly after `const now = …` inside `createCompareService`, add:
```ts
  const resolveSessionByCwd = deps.resolveSessionByCwd ?? ((cwd: string) => repo.findSessionPkByCwd(ctx.db, cwd));
  const diffStatFn = deps.diffStatFn ?? diffStat;

  function mustGet(id: string): CompareGroup {
    const g = repo.getGroup(ctx.db, id);
    if (!g) throw new ServiceError('not_found', 404, `compare group ${id} not found`);
    return g;
  }

  /** Fills sessionPk/sessionId for variants launched without an id (Codex) and persists them. */
  function resolveSessions(g: CompareGroup): CompareGroup {
    let changed = false;
    const variants = g.variants.map((v): CompareVariant => {
      if (v.sessionPk || !v.worktreePath || v.error) return v;
      const pk = resolveSessionByCwd(v.worktreePath);
      if (!pk) return v;
      changed = true;
      return { ...v, sessionPk: pk, sessionId: splitPk(pk).id };
    });
    return changed ? repo.updateGroup(ctx.db, g.id, { variants }, now().toISOString()) : g;
  }

  async function view(id: string): Promise<CompareView> {
    const group = resolveSessions(mustGet(id));
    const variants = await Promise.all(
      group.variants.map(async (v): Promise<CompareVariantView> => {
        const s = v.sessionPk ? ctx.sessions.getByPk(v.sessionPk) : null;
        let diff: DiffStat | null = null;
        if (v.worktreePath) {
          try {
            diff = await diffStatFn(v.worktreePath, group.base);
          } catch {
            diff = null;
          }
        }
        return {
          ...v,
          status: v.error ? 'error' : (s?.live?.status ?? (s ? 'ended' : 'starting')),
          costUsd: s?.usage.costUsd ?? null,
          durationMs: s ? Math.max(0, Date.parse(s.lastActivityAt) - Date.parse(s.startedAt)) : null,
          tests: s?.lastTest ?? null,
          recap: s?.recap ?? s?.awaySummary ?? null,
          diff,
        };
      }),
    );
    return { group, variants };
  }

  function pickWinner(id: string, index: number): { group: CompareGroup; reviewUrl: string } {
    const g = resolveSessions(mustGet(id));
    if (g.state === 'archived') throw new ServiceError('invalid_state', 409, 'this comparison is already archived');
    const v = g.variants.find((x) => x.index === index);
    if (!v) throw new ServiceError('not_found', 404, `variant ${index} not found`);
    if (v.error || !v.sessionId) throw new ServiceError('session_unknown', 409, `variant ${v.label} has no session yet`);
    const group = repo.updateGroup(ctx.db, id, { state: 'decided', winnerIndex: index }, now().toISOString());
    ctx.audit?.record({
      actor: 'user',
      actorDetail: null,
      action: 'compare.pick',
      target: `compare:${id}`,
      params: { index, label: v.label, sessionPk: v.sessionPk },
      result: 'ok',
      error: null,
    });
    emit(group);
    return { group, reviewUrl: `/review/${v.source}/${encodeURIComponent(v.sessionId)}` };
  }

  async function archiveLosers(id: string): Promise<ArchiveLosersResult> {
    const g = mustGet(id);
    if (g.winnerIndex === null) throw new ServiceError('invalid_state', 409, 'pick a winner before archiving the others');
    const worktrees = required(ctx.worktrees, 'worktree service');
    const results: ArchiveLosersResult['results'] = [];
    for (const v of g.variants) {
      if (v.index === g.winnerIndex) continue;
      let killed = false;
      if (v.ptyId) {
        const info = ctx.pty.get(v.ptyId);
        if (info && info.exitedAt === null) {
          ctx.pty.kill(v.ptyId);
          killed = true;
          ctx.audit?.record({
            actor: 'user',
            actorDetail: null,
            action: 'session.kill',
            target: v.sessionPk ?? `pty:${v.ptyId}`,
            params: { compareGroupId: id, index: v.index },
            result: 'ok',
            error: null,
          });
        }
      }
      if (!v.worktreePath) {
        results.push({ index: v.index, worktreePath: null, killed, archived: false, reason: 'no worktree' });
        continue;
      }
      if (worktrees.get(v.worktreePath)?.state === 'archived') {
        results.push({ index: v.index, worktreePath: v.worktreePath, killed, archived: true, reason: null });
        continue;
      }
      try {
        await worktrees.archiveAs(v.worktreePath, 'user');
        results.push({ index: v.index, worktreePath: v.worktreePath, killed, archived: true, reason: null });
      } catch (e) {
        results.push({ index: v.index, worktreePath: v.worktreePath, killed, archived: false, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    const allArchived = results.every((r) => r.archived || r.worktreePath === null);
    const group = allArchived ? repo.updateGroup(ctx.db, id, { state: 'archived' }, now().toISOString()) : mustGet(id);
    ctx.audit?.record({
      actor: 'user',
      actorDetail: null,
      action: 'compare.archive',
      target: `compare:${id}`,
      params: { results },
      result: allArchived ? 'ok' : 'error',
      error: allArchived ? null : 'some worktrees were kept (uncommitted changes or external)',
    });
    emit(group);
    return { group, results };
  }
```
3. Replace the returned object with:
```ts
  return {
    launch,
    estimate,
    get: (id) => repo.getGroup(ctx.db, id),
    list: (limit) => repo.listGroups(ctx.db, limit),
    view,
    pickWinner,
    archiveLosers,
  };
```
and delete `notImplemented`.

The `state === 'archived'` check makes a second `archiveLosers` call safe: it skips worktrees that were archived the first time and retries only the ones that were kept.

Run: `pnpm vitest run apps/daemon/test/p7/compare-decide.test.ts apps/daemon/test/p7/compare-launch.test.ts`
Expected: PASS (decide 6 tests, launch 7 tests)

- [ ] **Step 3: Write the failing route test**

`apps/daemon/test/p7/compare-routes.test.ts`
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.ts';
import { API_BASE, TEST_TOKEN } from '../../src/http/p7-guard.ts';
import { createCompareService } from '../../src/services/compare/compare.ts';
import { createTestContext, type TestContext } from '../helpers.ts';
import {
  createFakePty,
  fakeAudit,
  fakeLauncher,
  fakeProjects,
  fakeSessions,
  fakeUsage,
  fakeWorktrees,
  testConfig,
} from '../fakes/phase7.ts';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

function setup(withCompare = true) {
  const cfg = testConfig();
  ctx = createTestContext({
    config: () => cfg,
    projects: fakeProjects(cfg),
    pty: createFakePty(),
    worktrees: fakeWorktrees(),
    audit: fakeAudit(),
    sessions: fakeSessions([]),
    launcher: fakeLauncher(),
    usage: fakeUsage(),
  });
  if (withCompare) ctx.compare = createCompareService({ ctx, resolveSessionByCwd: () => null, diffStatFn: async () => ({ files: 0, insertions: 0, deletions: 0, untracked: 0 }) });
  const app = createApp({ ctx, token: TEST_TOKEN, port: () => 4317, env: {} });
  return (path: string, method = 'GET', body?: unknown) =>
    app.request(`${API_BASE}${path}`, {
      method,
      headers: { 'x-orc-token': TEST_TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const launchBody = {
  source: 'claude',
  projectId: 'wakecap',
  cwd: '/tmp',
  prompt: 'x',
  worktree: { repo: '/tmp/repo', base: 'main', type: 'feat', slug: 'cmp' },
  compare: [{ source: 'claude', model: 'claude-opus-5' }, { source: 'claude', model: 'claude-sonnet-5' }],
};

describe('/api/compare', () => {
  it('estimates, launches, views, picks and asks before archiving', async () => {
    const call = setup();
    const est = (await (await call('/api/compare/estimate?projectId=wakecap&n=2')).json()) as { multiplier: number };
    expect(est.multiplier).toBe(2);
    expect((await call('/api/compare/estimate?n=0')).status).toBe(400);

    const created = await call('/api/compare', 'POST', launchBody);
    expect(created.status).toBe(201);
    const g = (await created.json()) as { id: string };
    const view = (await (await call(`/api/compare/${g.id}`)).json()) as { variants: unknown[] };
    expect(view.variants).toHaveLength(2);

    const win = (await (await call(`/api/compare/${g.id}/winner`, 'POST', { index: 1 })).json()) as { reviewUrl: string };
    expect(win.reviewUrl).toBe('/review/claude/launched-2');

    const noConfirm = await call(`/api/compare/${g.id}/archive-losers`, 'POST', {});
    expect(noConfirm.status).toBe(409);
    expect(((await noConfirm.json()) as { error: { details: { summary: string } } }).error.details.summary).toContain('archive');
    const archived = await call(`/api/compare/${g.id}/archive-losers`, 'POST', { confirm: true });
    expect(archived.status).toBe(200);
    expect((await call('/api/compare/missing')).status).toBe(404);
  });

  it('routes compare launches from /api/sessions/launch', async () => {
    const call = setup();
    const res = await call('/api/sessions/launch', 'POST', launchBody);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ compareGroupId: expect.any(String) });
  });

  it('answers not_enabled without the compare service', async () => {
    const call = setup(false);
    expect((await call('/api/sessions/launch', 'POST', launchBody)).status).toBe(409);
    expect((await call('/api/compare/estimate?n=2')).status).toBe(409);
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p7/compare-routes.test.ts`
Expected: FAIL (404 `no such route`)

- [ ] **Step 4: Implement the routes and the launch delegation**

`apps/daemon/src/http/routes/compare.ts`
```ts
import { CompareEstimateQuery, LaunchRequest, PickWinnerBody } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import { readJson } from '../json.ts';
import { ConfirmBody, need, requireConfirmed } from '../p7-guard.ts';
import type { OrcApp } from '../types.ts';

export function registerCompareRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.compare, 'compare mode');

  app.post('/api/compare', async (c) => {
    const req = await readJson(c, LaunchRequest);
    return c.json(await svc().launch(req), 201);
  });

  app.get('/api/compare/estimate', (c) => {
    const s = svc();
    const q = CompareEstimateQuery.parse(c.req.query());
    return c.json(s.estimate(q.projectId ?? null, q.n));
  });

  app.get('/api/compare/:groupId', async (c) => c.json(await svc().view(c.req.param('groupId'))));

  app.post('/api/compare/:groupId/winner', async (c) => {
    const { index } = await readJson(c, PickWinnerBody);
    return c.json(svc().pickWinner(c.req.param('groupId'), index));
  });

  app.post('/api/compare/:groupId/archive-losers', async (c) => {
    const body = await readJson(c, ConfirmBody);
    const id = c.req.param('groupId');
    const g = svc().get(id);
    if (!g) throw new ServiceError('not_found', 404, `compare group ${id} not found`);
    const losers = g.variants.filter((v) => v.index !== g.winnerIndex);
    requireConfirmed(
      body,
      `Stop ${losers.length} losing session(s) and archive their worktrees: ${losers.map((v) => v.worktreePath ?? v.label).join(', ')}`,
      { losers: losers.map((v) => v.label) },
    );
    return c.json(await svc().archiveLosers(id));
  });
}
```
In `estimate`, `svc()` is called before the query is parsed, so a missing service gives 409 `not_enabled` rather than 400.

`apps/daemon/src/http/app.ts`: import `registerCompareRoutes` and call it next to `registerAutomationRoutes(app, o.ctx)`, before the 404 catch-all. (If 7A is not merged yet, add the call at the same place.)

Add the compare routes to `NON_ACTION_ROUTES` in `apps/daemon/src/http/audit-middleware.ts` (P3's coverage test); the service audits them with the full parameters:
```ts
  { method: 'POST', path: '/api/compare', why: 'CompareService.launch records compare.launch' },
  { method: 'POST', path: '/api/compare/:groupId/winner', why: 'CompareService.pickWinner records compare.pick' },
  { method: 'POST', path: '/api/compare/:groupId/archive-losers', why: 'CompareService.archiveLosers records compare.archive and session.kill' },
```

P2 launch handler: open the file that handles `POST /api/sessions/launch`. Right after the body is parsed into `req`, insert:
```ts
    if (req.compare && req.compare.length > 0) {
      const group = await need(ctx.compare, 'compare mode').launch(req);
      return c.json({ compareGroupId: group.id }, 201);
    }
```
with `import { need } from '../p7-guard.ts';`. The 501 guards in P2's `LaunchService.launch` and P4's launch preparation stay: they still protect direct service calls that bypass the route. P2's route test expects `501` for a `compare` body. Change that case to expect `409` with code `not_enabled` (the P2 test context has no `compare` service).

`packages/api-contract/src/routes/launch.ts` (P2): widen the response schema that `sessionsLaunch` parses. Keep the existing object as the first member:
```ts
export const LaunchResponse = z.union([
  z.object({ ptyId: z.string(), sessionId: z.string().nullable() }),
  z.object({ compareGroupId: z.string() }),
]);
export type LaunchResponse = z.infer<typeof LaunchResponse>;
```
If P2 named this schema `LaunchResponseSchema`, keep that name. Callers that read `ptyId` now narrow with `'ptyId' in res` (Task 13 updates the launch dialog).

- [ ] **Step 5: Wire the service**

In `apps/daemon/src/main.ts`, import `createCompareService` and add this inside the Phase 7 block from Task 9 (or create the block if 7A is not merged):
```ts
  // ── Phase 7B: compare mode ───────────────────────────────────────────
  ctx.compare = createCompareService({ ctx });
```

- [ ] **Step 6: Run the tests, then all checks, and commit**

Run: `pnpm vitest run apps/daemon/test/p7/compare-decide.test.ts apps/daemon/test/p7/compare-routes.test.ts apps/daemon`
Expected: PASS (decide 6, routes 3, plus the updated P2 launch-route test)

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/daemon packages/api-contract
git commit -m "feat(compare): compare view, pick winner, archive losers and launch delegation"
```

---

### Task 13: Compare UI (launch section with cost estimate, `/compare/$groupId` page)

**Files:**
- Create: `apps/web/src/api/queries/compare.ts`, `apps/web/src/features/compare/compare-model.ts`, `CompareLaunchSection.tsx`, `ComparePage.tsx`, `apps/web/src/routes/compare.$groupId.tsx`
- Modify: `apps/web/src/features/launch/LaunchDialog.tsx` (P2), `apps/web/src/api/live-events.ts`
- Test: `apps/web/src/features/compare/compare-model.test.ts`, `apps/web/src/features/compare/ComparePage.test.tsx`

**Interfaces:**
- Consumes: `CompareApi` (Task 11); `sessionsLaunch` with the widened `LaunchResponse` (Task 12); `useTerminalStore` (§12); `formatCost`, `formatDuration` (P1); UI kit; `renderWithClient`, `fakeApi` (P2).
- Produces:
  ```ts
  // api/queries/compare.ts
  export const compareKeys: { group(id: string): readonly ['compare', string]; estimate(projectId: string | null, n: number): readonly ['compare-estimate', string, number] }
  export function useCompare(groupId: string): UseQueryResult<CompareView>             // refetch every 5 s
  export function useCompareEstimate(projectId: string | null, n: number): UseQueryResult<CompareEstimate>   // enabled when n ≥ 2
  export function usePickWinner(groupId: string): UseMutationResult<PickWinnerResult, Error, number>
  export function useArchiveLosers(groupId: string): UseMutationResult<ArchiveLosersResult, Error, void>
  // features/compare/compare-model.ts
  export const VARIANT_PRESETS: ReadonlyArray<{ id: string; label: string; value: CompareVariantInput }>
  export function formatEstimate(e: CompareEstimate): string
  export function budgetWarning(e: CompareEstimate): string | null
  export interface Highlights { cheapest: number | null; greenTests: number[]; smallestDiff: number | null }
  export function variantHighlights(vs: CompareVariantView[]): Highlights
  // components
  export function CompareLaunchSection(p: { projectId: string | null; value: CompareVariantInput[]; onChange(v: CompareVariantInput[]): void }): JSX.Element
  export function ComparePage(p: { groupId: string; navigate(url: string): void; confirm?: (message: string) => boolean }): JSX.Element
  ```

- [ ] **Step 1: Write the failing tests**

`apps/web/src/features/compare/compare-model.test.ts`
```ts
import type { CompareEstimate, CompareVariantView } from '@orc/api-contract';
import { describe, expect, it } from 'vitest';
import { budgetWarning, formatEstimate, variantHighlights } from './compare-model.ts';

const est = (over: Partial<CompareEstimate> = {}): CompareEstimate => ({
  variants: 3, multiplier: 3, avgSessionCostUsd: 1.5, estimatedUsd: 4.5, sample: 12, burnRateUsdPerHour: 2,
  budget: { ok: true, pct: 0.3, limitUsd: 50 }, ...over,
});

const view = (index: number, over: Partial<CompareVariantView> = {}): CompareVariantView => ({
  index, source: 'claude', model: null, label: `v${index + 1} claude`, sessionId: `s${index}`, sessionPk: `claude:s${index}`,
  ptyId: null, worktreePath: `/w/${index}`, branch: null, error: null, status: 'review', costUsd: null, durationMs: null,
  tests: null, recap: null, diff: null, ...over,
});

describe('compare model', () => {
  it('formats the estimate', () => {
    expect(formatEstimate(est())).toBe('Runs 3 agents · 3× the cost of one session · ≈ $4.50 (median $1.50 × 3 over 12 recent sessions)');
    expect(formatEstimate(est({ estimatedUsd: null, avgSessionCostUsd: null, sample: 0 }))).toBe(
      'Runs 3 agents · 3× the cost of one session · no cost history yet',
    );
  });

  it('warns near and over budget', () => {
    expect(budgetWarning(est())).toBeNull();
    expect(budgetWarning(est({ budget: { ok: true, pct: 0.85, limitUsd: 50 } }))).toBe('Budget at 85% of $50.00');
    expect(budgetWarning(est({ budget: { ok: false, pct: 1.1, limitUsd: 50 } }))).toBe('Budget exceeded (110%): the launch will be refused');
  });

  it('highlights the cheapest, green and smallest variants', () => {
    const h = variantHighlights([
      view(0, { costUsd: 2, tests: { ts: 't', command: 'c', passed: 5, failed: 1, skipped: 0, durationMs: 1 }, diff: { files: 3, insertions: 40, deletions: 2, untracked: 0 } }),
      view(1, { costUsd: 1, tests: { ts: 't', command: 'c', passed: 5, failed: 0, skipped: 0, durationMs: 1 }, diff: { files: 1, insertions: 8, deletions: 1, untracked: 0 } }),
      view(2, { costUsd: null, error: 'failed', diff: { files: 0, insertions: 0, deletions: 0, untracked: 0 } }),
    ]);
    expect(h).toEqual({ cheapest: 1, greenTests: [1], smallestDiff: 1 });
  });
});
```

`apps/web/src/features/compare/ComparePage.test.tsx`
```tsx
import type { CompareGroup, CompareVariantInput, CompareView } from '@orc/api-contract';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '@/api/client.ts';
import { fakeApi, renderWithClient } from '@/test/query.tsx';
import { CompareLaunchSection } from './CompareLaunchSection.tsx';
import { ComparePage } from './ComparePage.tsx';

const group: CompareGroup = {
  id: 'g1', projectId: 'wakecap', prompt: 'Skip weekends in SLA', ticket: 'SAF-1787', repo: '/r', base: 'main',
  createdAt: '2026-09-17T09:00:00.000Z', state: 'running', winnerIndex: null, estimateUsd: 3, variants: [],
};

const data: CompareView = {
  group,
  variants: [
    {
      index: 0, source: 'claude', model: 'claude-opus-5', label: 'v1 claude:claude-opus-5', sessionId: 'a', sessionPk: 'claude:a',
      ptyId: 'pty-1', worktreePath: '/w/1', branch: 'feat/SAF-1787-sla-v1', error: null, status: 'review', costUsd: 2.1,
      durationMs: 600_000, tests: { ts: 't', command: 'pnpm test', passed: 20, failed: 0, skipped: 0, durationMs: 1000 },
      recap: 'Added isWeekend helper', diff: { files: 2, insertions: 30, deletions: 4, untracked: 0 },
    },
    {
      index: 1, source: 'codex', model: null, label: 'v2 codex', sessionId: null, sessionPk: null, ptyId: 'pty-2',
      worktreePath: '/w/2', branch: 'feat/SAF-1787-sla-v2', error: null, status: 'starting', costUsd: null, durationMs: null,
      tests: null, recap: null, diff: { files: 5, insertions: 90, deletions: 20, untracked: 1 },
    },
  ],
};

afterEach(() => setApiClientForTests(null));

describe('ComparePage', () => {
  it('shows variants side by side and opens review for the winner', async () => {
    const stubs = {
      compareGet: vi.fn(async () => data),
      comparePickWinner: vi.fn(async () => ({ group: { ...group, state: 'decided' as const, winnerIndex: 0 }, reviewUrl: '/review/claude/a' })),
      compareArchiveLosers: vi.fn(),
    };
    setApiClientForTests(fakeApi(stubs));
    const navigate = vi.fn();
    renderWithClient(<ComparePage groupId="g1" navigate={navigate} confirm={() => true} />);
    expect(await screen.findByText('v1 claude:claude-opus-5')).toBeTruthy();
    expect(screen.getByText('v2 codex')).toBeTruthy();
    expect(screen.getByText('20 passed · 0 failed')).toBeTruthy();
    expect(screen.getByText('+30 −4 in 2 files')).toBeTruthy();
    expect(screen.getByText('Added isWeekend helper')).toBeTruthy();
    expect(screen.getByText('Cheapest')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Pick v2 codex' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Pick v1 claude:claude-opus-5' }));
    await waitFor(() => expect(stubs.comparePickWinner).toHaveBeenCalledWith('g1', 0));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/review/claude/a'));
  });

  it('archives the other variants only after confirmation', async () => {
    const decided: CompareView = { ...data, group: { ...group, state: 'decided', winnerIndex: 0 } };
    const stubs = {
      compareGet: vi.fn(async () => decided),
      compareArchiveLosers: vi.fn(async () => ({
        group: decided.group,
        results: [{ index: 1, worktreePath: '/w/2', killed: true, archived: false, reason: 'worktree has uncommitted changes' }],
      })),
    };
    setApiClientForTests(fakeApi(stubs));
    const confirm = vi.fn(() => false);
    renderWithClient(<ComparePage groupId="g1" navigate={vi.fn()} confirm={confirm} />);
    const button = await screen.findByRole('button', { name: 'Archive the other variants' });
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('/w/2'));
    expect(stubs.compareArchiveLosers).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(button);
    expect(await screen.findByText(/v2: kept — worktree has uncommitted changes/)).toBeTruthy();
  });
});

function Harness({ onChange }: { onChange(v: CompareVariantInput[]): void }) {
  const [value, setValue] = useState<CompareVariantInput[]>([]);
  return (
    <CompareLaunchSection
      projectId="wakecap"
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

describe('CompareLaunchSection', () => {
  it('adds variants and shows the cost multiplier before launch', async () => {
    const stubs = {
      compareEstimate: vi.fn(async (_p: string | null, n: number) => ({
        variants: n, multiplier: n, avgSessionCostUsd: 2, estimatedUsd: 2 * n, sample: 5, burnRateUsdPerHour: 1,
        budget: { ok: true, pct: 0.9, limitUsd: 20 },
      })),
    };
    setApiClientForTests(fakeApi(stubs));
    const changes = vi.fn();
    renderWithClient(<Harness onChange={changes} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Claude Opus' }));
    expect(screen.queryByText(/Runs \d agents/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add Codex' }));
    expect(changes).toHaveBeenLastCalledWith([{ source: 'claude', model: 'claude-opus-5' }, { source: 'codex' }]);
    expect(await screen.findByText(/Runs 2 agents · 2× the cost/)).toBeTruthy();
    expect(screen.getByText('Budget at 90% of $20.00')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove v1' }));
    expect(changes).toHaveBeenLastCalledWith([{ source: 'codex' }]);
  });
});
```

Run: `pnpm vitest run apps/web/src/features/compare`
Expected: FAIL, `Cannot find module './compare-model.ts'`

- [ ] **Step 2: Implement the model and the query hooks**

`apps/web/src/features/compare/compare-model.ts`
```ts
import type { CompareEstimate, CompareVariantInput, CompareVariantView } from '@orc/api-contract';

export const VARIANT_PRESETS: ReadonlyArray<{ id: string; label: string; value: CompareVariantInput }> = [
  { id: 'opus', label: 'Claude Opus', value: { source: 'claude', model: 'claude-opus-5' } },
  { id: 'sonnet', label: 'Claude Sonnet', value: { source: 'claude', model: 'claude-sonnet-5' } },
  { id: 'claude', label: 'Claude (default model)', value: { source: 'claude' } },
  { id: 'codex', label: 'Codex', value: { source: 'codex' } },
];

const usd = (n: number) => `$${n.toFixed(2)}`;

export function formatEstimate(e: CompareEstimate): string {
  const cost =
    e.estimatedUsd === null || e.avgSessionCostUsd === null
      ? 'no cost history yet'
      : `≈ ${usd(e.estimatedUsd)} (median ${usd(e.avgSessionCostUsd)} × ${e.variants} over ${e.sample} recent sessions)`;
  return `Runs ${e.variants} agents · ${e.multiplier}× the cost of one session · ${cost}`;
}

export function budgetWarning(e: CompareEstimate): string | null {
  const pct = Math.round(e.budget.pct * 100);
  if (!e.budget.ok) return `Budget exceeded (${pct}%): the launch will be refused`;
  if (e.budget.pct >= 0.8) return `Budget at ${pct}%${e.budget.limitUsd !== null ? ` of ${usd(e.budget.limitUsd)}` : ''}`;
  return null;
}

export interface Highlights {
  cheapest: number | null;
  greenTests: number[];
  smallestDiff: number | null;
}

export function variantHighlights(vs: CompareVariantView[]): Highlights {
  const ok = vs.filter((v) => !v.error);
  const byCost = ok.filter((v) => v.costUsd !== null).sort((a, b) => (a.costUsd ?? 0) - (b.costUsd ?? 0));
  const size = (v: CompareVariantView) => (v.diff ? v.diff.insertions + v.diff.deletions : 0);
  const bySize = ok.filter((v) => size(v) > 0).sort((a, b) => size(a) - size(b));
  return {
    cheapest: byCost[0]?.index ?? null,
    greenTests: ok.filter((v) => v.tests && v.tests.failed === 0 && v.tests.passed > 0).map((v) => v.index),
    smallestDiff: bySize[0]?.index ?? null,
  };
}
```

`apps/web/src/api/queries/compare.ts`
```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '@/api/client.ts';

export const compareKeys = {
  group: (id: string) => ['compare', id] as const,
  estimate: (projectId: string | null, n: number) => ['compare-estimate', projectId ?? 'all', n] as const,
};

export function useCompare(groupId: string) {
  return useQuery({ queryKey: compareKeys.group(groupId), queryFn: () => getApiClient().compareGet(groupId), refetchInterval: 5000 });
}

export function useCompareEstimate(projectId: string | null, n: number) {
  return useQuery({
    queryKey: compareKeys.estimate(projectId, n),
    queryFn: () => getApiClient().compareEstimate(projectId, n),
    enabled: n >= 2,
  });
}

export function usePickWinner(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (index: number) => getApiClient().comparePickWinner(groupId, index),
    onSuccess: () => qc.invalidateQueries({ queryKey: compareKeys.group(groupId) }),
  });
}

export function useArchiveLosers(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => getApiClient().compareArchiveLosers(groupId),
    onSuccess: () => qc.invalidateQueries({ queryKey: compareKeys.group(groupId) }),
  });
}
```

In `apps/web/src/api/live-events.ts` (`applyLiveEvent`), add:
```ts
    case 'compare.updated':
      void qc.invalidateQueries({ queryKey: ['compare', e.group.id] });
      return;
```

- [ ] **Step 3: Implement the components and the route**

`apps/web/src/features/compare/CompareLaunchSection.tsx`
```tsx
import type { CompareVariantInput } from '@orc/api-contract';
import { useCompareEstimate } from '@/api/queries/compare.ts';
import { Button } from '@/components/ui/button.tsx';
import { budgetWarning, formatEstimate, VARIANT_PRESETS } from './compare-model.ts';

const describe = (v: CompareVariantInput) => `${v.source}${v.model ? ` · ${v.model}` : ''}`;

export function CompareLaunchSection({
  projectId,
  value,
  onChange,
}: {
  projectId: string | null;
  value: CompareVariantInput[];
  onChange(v: CompareVariantInput[]): void;
}) {
  const estimate = useCompareEstimate(projectId, value.length);
  const warning = estimate.data ? budgetWarning(estimate.data) : null;
  return (
    <div className="flex flex-col gap-2 text-sm" aria-label="Compare across agents">
      <p className="text-xs text-muted-foreground">
        Each variant runs the same prompt in its own new worktree, so a worktree (repo, base, slug) is required. Pick two or more.
      </p>
      <div className="flex flex-wrap gap-1">
        {VARIANT_PRESETS.map((p) => (
          <Button key={p.id} type="button" size="sm" variant="outline" aria-label={`Add ${p.label}`} onClick={() => onChange([...value, p.value])}>
            + {p.label}
          </Button>
        ))}
      </div>
      <ol className="flex flex-col gap-1">
        {value.map((v, i) => (
          <li key={`${i}-${describe(v)}`} className="flex items-center gap-2">
            <span className="w-8 text-xs text-muted-foreground">v{i + 1}</span>
            <span>{describe(v)}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Remove v${i + 1}`}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </li>
        ))}
      </ol>
      {value.length >= 2 && estimate.data ? <p className="font-medium">{formatEstimate(estimate.data)}</p> : null}
      {warning ? <p className="text-amber-600">{warning}</p> : null}
    </div>
  );
}
```

`apps/web/src/features/compare/ComparePage.tsx`
```tsx
import type { CompareVariantView } from '@orc/api-contract';
import { useArchiveLosers, useCompare, usePickWinner } from '@/api/queries/compare.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';
import { formatCost, formatDuration } from '@/lib/format.ts';
import { useTerminalStore } from '@/stores/terminals.ts';
import { variantHighlights } from './compare-model.ts';

export function ComparePage({
  groupId,
  navigate,
  confirm = (m: string) => window.confirm(m),
}: {
  groupId: string;
  navigate(url: string): void;
  confirm?: (message: string) => boolean;
}) {
  const { data, isLoading, error } = useCompare(groupId);
  const pick = usePickWinner(groupId);
  const archive = useArchiveLosers(groupId);
  const openTerminal = useTerminalStore((s) => s.open);

  if (isLoading) return <p className="p-4 text-sm">Loading comparison…</p>;
  if (error || !data) return <p className="p-4 text-sm text-destructive">Could not load this comparison.</p>;
  const { group, variants } = data;
  const h = variantHighlights(variants);
  const losers = variants.filter((v) => v.index !== group.winnerIndex);
  const labelOf = (index: number) => variants.find((v) => v.index === index)?.label.split(' ')[0] ?? `v${index + 1}`;

  const onPick = (v: CompareVariantView) =>
    pick.mutate(v.index, {
      onSuccess: (res) => navigate(res.reviewUrl),
    });

  const onArchive = () => {
    const paths = losers.map((v) => v.worktreePath ?? v.label).join('\n');
    if (!confirm(`Stop the other sessions and archive their worktrees?\n\n${paths}`)) return;
    archive.mutate();
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Compare</h1>
        {group.ticket ? <Badge variant="outline">{group.ticket}</Badge> : null}
        <Badge variant={group.state === 'running' ? 'default' : 'secondary'}>{group.state}</Badge>
        {group.estimateUsd !== null ? <span className="text-xs text-muted-foreground">estimated {formatCost(group.estimateUsd)}</span> : null}
        {group.state === 'decided' ? (
          <Button className="ml-auto" variant="outline" onClick={onArchive} disabled={archive.isPending}>
            Archive the other variants
          </Button>
        ) : null}
      </header>
      <p className="whitespace-pre-wrap text-sm">{group.prompt}</p>
      {archive.data ? (
        <ul className="text-sm">
          {archive.data.results.map((r) => (
            <li key={r.index}>
              {labelOf(r.index)}: {r.archived ? 'archived' : `kept — ${r.reason ?? 'unknown reason'}`}
              {r.killed ? ' (session stopped)' : ''}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(variants.length, 1)}, minmax(260px, 1fr))` }}>
        {variants.map((v) => (
          <Card key={v.index} className={`flex flex-col gap-2 p-3 ${group.winnerIndex === v.index ? 'ring-2 ring-primary' : ''}`}>
            <div className="flex items-center gap-2">
              <span className="font-medium">{v.label}</span>
              <Badge variant={v.error ? 'destructive' : 'secondary'}>{v.status}</Badge>
              {group.winnerIndex === v.index ? <Badge variant="success">Winner</Badge> : null}
            </div>
            <div className="flex flex-wrap gap-1">
              {h.cheapest === v.index ? <Badge variant="outline">Cheapest</Badge> : null}
              {h.greenTests.includes(v.index) ? <Badge variant="success">Tests green</Badge> : null}
              {h.smallestDiff === v.index ? <Badge variant="outline">Smallest diff</Badge> : null}
            </div>
            {v.error ? <p className="text-xs text-destructive">{v.error}</p> : null}
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
              <dt>Branch</dt>
              <dd className="truncate">{v.branch ?? '—'}</dd>
              <dt>Cost</dt>
              <dd>{formatCost(v.costUsd)}</dd>
              <dt>Duration</dt>
              <dd>{formatDuration(v.durationMs)}</dd>
              <dt>Tests</dt>
              <dd>{v.tests ? `${v.tests.passed} passed · ${v.tests.failed} failed` : '—'}</dd>
              <dt>Diff</dt>
              <dd>{v.diff ? `+${v.diff.insertions} −${v.diff.deletions} in ${v.diff.files} files` : '—'}</dd>
            </dl>
            {v.recap ? <p className="whitespace-pre-wrap text-xs">{v.recap}</p> : null}
            <div className="mt-auto flex gap-2">
              {v.ptyId ? (
                <Button size="sm" variant="ghost" onClick={() => openTerminal(v.ptyId ?? '', v.label)}>
                  Terminal
                </Button>
              ) : null}
              <Button
                size="sm"
                aria-label={`Pick ${v.label}`}
                disabled={group.state === 'archived' || !v.sessionId || v.error !== null || pick.isPending}
                onClick={() => onPick(v)}
              >
                Pick as winner
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
```

`apps/web/src/routes/compare.$groupId.tsx`
```tsx
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { ComparePage } from '@/features/compare/ComparePage.tsx';

function CompareRoute() {
  const { groupId } = Route.useParams();
  const router = useRouter();
  return <ComparePage groupId={groupId} navigate={(url) => router.history.push(url)} />;
}

export const Route = createFileRoute('/compare/$groupId')({ component: CompareRoute });
```

- [ ] **Step 4: Add the compare section to the launch dialog**

In `apps/web/src/features/launch/LaunchDialog.tsx` (P2):
1. Imports:
```tsx
import type { CompareVariantInput } from '@orc/api-contract';
import { useRouter } from '@tanstack/react-router';
import { CompareLaunchSection } from '@/features/compare/CompareLaunchSection.tsx';
```
2. State, next to the other `useState` calls: `const [compare, setCompare] = useState<CompareVariantInput[]>([]);` and `const router = useRouter();`
3. JSX, after the worktree fields (P4) and before the submit button:
```tsx
        <details className="rounded border p-2">
          <summary className="cursor-pointer text-sm">Compare across agents{compare.length >= 2 ? ` (${compare.length})` : ''}</summary>
          <CompareLaunchSection projectId={form.projectId} value={compare} onChange={setCompare} />
        </details>
```
Use whatever variable holds the dialog's current project id in place of `form.projectId`.
4. Where the dialog builds the request and calls `sessionsLaunch`, add `...(compare.length >= 2 ? { compare } : {})` to the request object. Then handle the widened response before the existing `ptyId` handling:
```tsx
      const res = await getApiClient().sessionsLaunch(req);
      if ('compareGroupId' in res) {
        hide();
        router.history.push(`/compare/${res.compareGroupId}`);
        return;
      }
```
Keep the existing `ptyId` branch unchanged after this block (inside it, `res` narrows to the `{ ptyId, sessionId }` member). If the dialog's tests render it outside a router, wrap them with P2's `renderInRouter` helper.

- [ ] **Step 5: Run the tests, then all checks, and commit**

Run: `pnpm vitest run apps/web/src/features/compare apps/web/src/features/launch`
Expected: PASS (compare-model 3, ComparePage 2, CompareLaunchSection 1, plus the P2 launch dialog tests)

Run: `pnpm --filter @orc/web build && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/web/src
git commit -m "feat(web): add compare launch section and side-by-side compare page"
```

---

# 7C Supervisor Agent (F23)

### Task 14: Supervisor data layer (rules, decisions, targets, schemas, client)

**Files:**
- Modify: `apps/daemon/src/db/schema.ts`, `packages/api-contract/src/live.ts`, `packages/api-contract/src/clients/phase7.ts`, `packages/api-contract/src/index.ts`
- Create: `packages/api-contract/src/routes/supervisor.ts`, `packages/api-contract/src/clients/supervisor.ts`, `apps/daemon/src/db/repos/supervisor.ts`, migration (generated)
- Test: `apps/daemon/test/p7/supervisor-repo.test.ts`

**Interfaces:**
- Consumes: `OrcDb` (§5); `createTestContext` (P1); `ApiCall` (Task 1); contracts §11 `SupervisorDecision`.
- Produces:
  ```ts
  // @orc/api-contract routes/supervisor.ts
  SupervisorIntent, SupervisorRule, SupervisorRuleInput, SupervisorTarget, SupervisorDecisionView,
  SupervisorStatus, SupervisorSettingsPatch, SupervisorDecisionQuery   // zod + inferred types
  // clients/supervisor.ts
  export interface SupervisorApi {
    supervisorStatus(): Promise<SupervisorStatus>;
    supervisorSettings(patch: SupervisorSettingsPatch): Promise<SupervisorStatus>;
    supervisorTargets(): Promise<SupervisorTarget[]>;
    supervisorSetTarget(t: SupervisorTarget): Promise<SupervisorTarget>;
    supervisorRules(): Promise<SupervisorRule[]>;
    supervisorAddRule(r: SupervisorRuleInput): Promise<SupervisorRule>;
    supervisorDeleteRule(id: string): Promise<{ ok: true }>;
    supervisorDecisions(q?: { sessionPk?: string; limit?: number }): Promise<SupervisorDecisionView[]>;
    supervisorMarkWrong(decisionId: string): Promise<SupervisorRule>;
    supervisorEvaluate(source: string, id: string): Promise<SupervisorDecisionView>;
  }
  export function supervisorClient(call: ApiCall): SupervisorApi
  // db/repos/supervisor.ts
  export function listRules(db: OrcDb, projectId?: string | null): SupervisorRule[]     // enabled only, project rules + global
  export function listAllRules(db: OrcDb): SupervisorRule[]                            // every rule, for the settings UI
  export function insertRule(db: OrcDb, r: SupervisorRuleInput & { source: SupervisorRule['source'] }, now: string): SupervisorRule
  export function deleteRule(db: OrcDb, id: string): boolean
  export function insertDecision(db: OrcDb, d: SupervisorDecisionView): SupervisorDecisionView
  export function getDecision(db: OrcDb, id: string): SupervisorDecisionView | null
  export function listDecisions(db: OrcDb, q: { sessionPk?: string; limit?: number }): SupervisorDecisionView[]
  export function markFeedback(db: OrcDb, id: string, feedback: 'wrong'): SupervisorDecisionView
  export function countAnswered(db: OrcDb, sinceIso: string, sessionPk?: string): number
  export function countEscalated(db: OrcDb, sinceIso: string): number
  export function monthCost(db: OrcDb, sinceIso: string): number
  export function getTarget(db: OrcDb, targetType: SupervisorTarget['targetType'], targetId: string): SupervisorTarget | null
  export function setTarget(db: OrcDb, t: SupervisorTarget, now: string): SupervisorTarget
  export function listTargets(db: OrcDb): SupervisorTarget[]
  // live.ts: LiveEvent adds { type: 'supervisor.decided'; decision: SupervisorDecisionView }
  ```

- [ ] **Step 1: Write the schemas and the client**

`packages/api-contract/src/routes/supervisor.ts`
```ts
import { z } from 'zod';

export const SupervisorIntent = z.enum(['continue', 'run_tests', 'proceed_plan', 'retry_transient']);
export type SupervisorIntent = z.infer<typeof SupervisorIntent>;

export const SupervisorRule = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  kind: z.enum(['allow', 'deny']),
  pattern: z.string(),
  intent: SupervisorIntent.nullable(),
  answer: z.string().nullable(),
  source: z.enum(['builtin', 'user', 'feedback']),
  enabled: z.boolean(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type SupervisorRule = z.infer<typeof SupervisorRule>;

export const SupervisorRuleInput = z.object({
  projectId: z.string().nullable().default(null),
  kind: z.enum(['allow', 'deny']),
  pattern: z.string().min(2).max(400),
  intent: SupervisorIntent.nullable().default(null),
  answer: z.string().max(500).nullable().default(null),
  note: z.string().max(300).nullable().default(null),
});
export type SupervisorRuleInput = z.infer<typeof SupervisorRuleInput>;

export const SupervisorTarget = z.object({
  targetType: z.enum(['project', 'session']),
  targetId: z.string().min(1),
  enabled: z.boolean(),
});
export type SupervisorTarget = z.infer<typeof SupervisorTarget>;

/** Contracts §11 SupervisorDecision plus the fields the UI and the caps need. */
export const SupervisorDecisionView = z.object({
  id: z.string(),
  sessionPk: z.string(),
  projectId: z.string().nullable(),
  question: z.string(),
  decision: z.enum(['answer', 'escalate']),
  answer: z.string().nullable(),
  confidence: z.number(),
  reason: z.string(),
  intent: SupervisorIntent.nullable(),
  sent: z.boolean(),
  costUsd: z.number().nullable(),
  model: z.string().nullable(),
  feedback: z.literal('wrong').nullable(),
  ts: z.string(),
});
export type SupervisorDecisionView = z.infer<typeof SupervisorDecisionView>;

export const QuietHours = z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) });

export const SupervisorStatus = z.object({
  enabled: z.boolean(),
  quiet: z.boolean(),
  model: z.string(),
  confidenceThreshold: z.number(),
  maxPerSessionPerHour: z.number().int(),
  maxPerHour: z.number().int(),
  quietHours: QuietHours.nullable(),
  answeredLastHour: z.number().int(),
  escalatedLastHour: z.number().int(),
  monthCostUsd: z.number(),
  monthBudgetUsd: z.number(),
});
export type SupervisorStatus = z.infer<typeof SupervisorStatus>;

export const SupervisorSettingsPatch = z.object({
  enabled: z.boolean().optional(),
  model: z.string().min(1).optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  maxPerSessionPerHour: z.number().int().min(0).max(50).optional(),
  maxPerHour: z.number().int().min(0).max(200).optional(),
  monthlyBudgetUsd: z.number().min(0).max(200).optional(),
  quietHours: QuietHours.nullable().optional(),
});
export type SupervisorSettingsPatch = z.infer<typeof SupervisorSettingsPatch>;

export const SupervisorDecisionQuery = z.object({
  sessionPk: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
```

`packages/api-contract/src/clients/supervisor.ts`
```ts
import { z } from 'zod';
import { toQueryString } from '../client.ts';
import {
  SupervisorDecisionView,
  SupervisorRule,
  type SupervisorRuleInput,
  type SupervisorSettingsPatch,
  SupervisorStatus,
  SupervisorTarget,
} from '../routes/supervisor.ts';
import type { ApiCall } from './phase7.ts';

export interface SupervisorApi {
  supervisorStatus(): Promise<SupervisorStatus>;
  supervisorSettings(patch: SupervisorSettingsPatch): Promise<SupervisorStatus>;
  supervisorTargets(): Promise<SupervisorTarget[]>;
  supervisorSetTarget(t: SupervisorTarget): Promise<SupervisorTarget>;
  supervisorRules(): Promise<SupervisorRule[]>;
  supervisorAddRule(r: SupervisorRuleInput): Promise<SupervisorRule>;
  supervisorDeleteRule(id: string): Promise<{ ok: true }>;
  supervisorDecisions(q?: { sessionPk?: string; limit?: number }): Promise<SupervisorDecisionView[]>;
  supervisorMarkWrong(decisionId: string): Promise<SupervisorRule>;
  supervisorEvaluate(source: string, id: string): Promise<SupervisorDecisionView>;
}

const Ok = z.object({ ok: z.literal(true) });

export function supervisorClient(call: ApiCall): SupervisorApi {
  const base = '/api/supervisor';
  return {
    supervisorStatus: () => call(SupervisorStatus, 'GET', `${base}/status`),
    supervisorSettings: (patch) => call(SupervisorStatus, 'PATCH', `${base}/settings`, patch),
    supervisorTargets: () => call(z.array(SupervisorTarget), 'GET', `${base}/targets`),
    supervisorSetTarget: (t) => call(SupervisorTarget, 'PUT', `${base}/targets`, t),
    supervisorRules: () => call(z.array(SupervisorRule), 'GET', `${base}/rules`),
    supervisorAddRule: (r) => call(SupervisorRule, 'POST', `${base}/rules`, r),
    supervisorDeleteRule: (id) => call(Ok, 'DELETE', `${base}/rules/${encodeURIComponent(id)}`, { confirm: true }),
    supervisorDecisions: (q = {}) => call(z.array(SupervisorDecisionView), 'GET', `${base}/decisions${toQueryString(q)}`),
    supervisorMarkWrong: (id) => call(SupervisorRule, 'POST', `${base}/decisions/${encodeURIComponent(id)}/wrong`, {}),
    supervisorEvaluate: (source, id) =>
      call(SupervisorDecisionView, 'POST', `${base}/evaluate/${encodeURIComponent(source)}/${encodeURIComponent(id)}`, {}),
  };
}
```

In `packages/api-contract/src/clients/phase7.ts` add `import { type SupervisorApi, supervisorClient } from './supervisor.ts';`, extend `Phase7Api` with `& SupervisorApi` and spread `...supervisorClient(call)`. Add both files to `packages/api-contract/src/index.ts`.

In `packages/api-contract/src/live.ts` add `import type { SupervisorDecisionView } from './routes/supervisor.ts';` and the union variant:
```ts
  | { type: 'supervisor.decided'; decision: SupervisorDecisionView }
```
Add `'supervisor.decided'` to the daemon's `LIVE_EVENT_TYPES` list (P3 added that list next to `/ws`; if it exists, every new `LiveEvent` type must be in it).

- [ ] **Step 2: Add the tables**

Append to `apps/daemon/src/db/schema.ts`:
```ts
// ── Phase 7: supervisor ──────────────────────────────────────────────
export const supervisorRules = sqliteTable(
  'supervisor_rules',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id'),
    kind: text('kind').notNull(),
    pattern: text('pattern').notNull(),
    intent: text('intent'),
    answer: text('answer'),
    source: text('source').notNull().default('user'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    note: text('note'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('supervisor_rules_kind').on(t.kind, t.enabled)],
);

export const supervisorDecisions = sqliteTable(
  'supervisor_decisions',
  {
    id: text('id').primaryKey(),
    sessionPk: text('session_pk').notNull(),
    projectId: text('project_id'),
    question: text('question').notNull(),
    decision: text('decision').notNull(),
    answer: text('answer'),
    confidence: real('confidence').notNull().default(0),
    reason: text('reason').notNull(),
    intent: text('intent'),
    sent: integer('sent', { mode: 'boolean' }).notNull().default(false),
    costUsd: real('cost_usd'),
    model: text('model'),
    feedback: text('feedback'),
    ts: text('ts').notNull(),
  },
  (t) => [index('supervisor_decisions_session').on(t.sessionPk, t.ts), index('supervisor_decisions_ts').on(t.ts)],
);

export const supervisorTargets = sqliteTable(
  'supervisor_targets',
  {
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.targetType, t.targetId] })],
);
```
Add `primaryKey` to the `drizzle-orm/sqlite-core` import if it is missing.

Run: `pnpm --filter @orc/daemon db:generate`
Expected: a migration creating `supervisor_rules`, `supervisor_decisions` and `supervisor_targets`.

- [ ] **Step 3: Write the failing repo test**

`apps/daemon/test/p7/supervisor-repo.test.ts`
```ts
import type { SupervisorDecisionView } from '@orc/api-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as repo from '../../src/db/repos/supervisor.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

let ctx: TestContext;
beforeEach(() => {
  ctx = createTestContext();
});
afterEach(() => ctx.dispose());

const decision = (over: Partial<SupervisorDecisionView> = {}): SupervisorDecisionView => ({
  id: 'd1',
  sessionPk: 'claude:s1',
  projectId: 'wakecap',
  question: 'Should I continue?',
  decision: 'answer',
  answer: 'Yes, continue.',
  confidence: 0.92,
  reason: 'routine continue prompt',
  intent: 'continue',
  sent: true,
  costUsd: 0.002,
  model: 'claude-haiku-4-5',
  feedback: null,
  ts: '2026-09-18T09:00:00.000Z',
  ...over,
});

describe('supervisor rules repo', () => {
  it('stores rules and returns global plus project rules', () => {
    const now = '2026-09-18T08:00:00.000Z';
    const global = repo.insertRule(ctx.db, { projectId: null, kind: 'deny', pattern: 'drop table', intent: null, answer: null, note: null, source: 'user' }, now);
    repo.insertRule(ctx.db, { projectId: 'wakecap', kind: 'allow', pattern: 'ship it\\?', intent: 'continue', answer: 'Yes, continue.', note: null, source: 'user' }, now);
    repo.insertRule(ctx.db, { projectId: 'other', kind: 'allow', pattern: 'nope', intent: 'continue', answer: 'x', note: null, source: 'user' }, now);
    expect(repo.listRules(ctx.db, 'wakecap').map((r) => r.pattern).sort()).toEqual(['drop table', 'ship it\\?']);
    expect(repo.listRules(ctx.db, null).map((r) => r.pattern)).toEqual(['drop table']);
    expect(repo.deleteRule(ctx.db, global.id)).toBe(true);
    expect(repo.deleteRule(ctx.db, 'nope')).toBe(false);
    expect(repo.listRules(ctx.db, 'wakecap')).toHaveLength(1);
  });
});

describe('supervisor decisions repo', () => {
  it('records decisions, counts caps and sums cost', () => {
    repo.insertDecision(ctx.db, decision());
    repo.insertDecision(ctx.db, decision({ id: 'd2', ts: '2026-09-18T09:30:00.000Z' }));
    repo.insertDecision(ctx.db, decision({ id: 'd3', sessionPk: 'claude:s2', ts: '2026-09-18T09:40:00.000Z' }));
    repo.insertDecision(ctx.db, decision({ id: 'd4', decision: 'escalate', answer: null, sent: false, confidence: 0.2, ts: '2026-09-18T09:50:00.000Z' }));
    expect(repo.countAnswered(ctx.db, '2026-09-18T09:00:00.000Z')).toBe(3);
    expect(repo.countAnswered(ctx.db, '2026-09-18T09:00:00.000Z', 'claude:s1')).toBe(2);
    expect(repo.countEscalated(ctx.db, '2026-09-18T09:00:00.000Z')).toBe(1);
    expect(repo.monthCost(ctx.db, '2026-09-01T00:00:00.000Z')).toBeCloseTo(0.008);
    expect(repo.listDecisions(ctx.db, { sessionPk: 'claude:s1' }).map((d) => d.id)).toEqual(['d4', 'd2', 'd1']);
    expect(repo.listDecisions(ctx.db, { limit: 2 }).map((d) => d.id)).toEqual(['d4', 'd3']);
    expect(repo.markFeedback(ctx.db, 'd1', 'wrong').feedback).toBe('wrong');
    expect(repo.getDecision(ctx.db, 'd1')?.feedback).toBe('wrong');
  });
});

describe('supervisor targets repo', () => {
  it('upserts per-project and per-session switches', () => {
    const now = '2026-09-18T09:00:00.000Z';
    repo.setTarget(ctx.db, { targetType: 'project', targetId: 'wakecap', enabled: true }, now);
    repo.setTarget(ctx.db, { targetType: 'session', targetId: 'claude:s1', enabled: false }, now);
    repo.setTarget(ctx.db, { targetType: 'project', targetId: 'wakecap', enabled: false }, now);
    expect(repo.getTarget(ctx.db, 'project', 'wakecap')?.enabled).toBe(false);
    expect(repo.getTarget(ctx.db, 'session', 'missing')).toBeNull();
    expect(repo.listTargets(ctx.db)).toHaveLength(2);
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p7/supervisor-repo.test.ts`
Expected: FAIL, `Cannot find module '../../src/db/repos/supervisor.ts'`

- [ ] **Step 4: Implement the repo**

`apps/daemon/src/db/repos/supervisor.ts`
```ts
import { randomUUID } from 'node:crypto';
import type { SupervisorDecisionView, SupervisorIntent, SupervisorRule, SupervisorRuleInput, SupervisorTarget } from '@orc/api-contract';
import { and, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { supervisorDecisions, supervisorRules, supervisorTargets } from '../schema.ts';

type RuleRow = typeof supervisorRules.$inferSelect;
type DecisionRow = typeof supervisorDecisions.$inferSelect;
type TargetRow = typeof supervisorTargets.$inferSelect;

const toRule = (r: RuleRow): SupervisorRule => ({
  id: r.id,
  projectId: r.projectId,
  kind: r.kind as SupervisorRule['kind'],
  pattern: r.pattern,
  intent: (r.intent as SupervisorIntent | null) ?? null,
  answer: r.answer,
  source: r.source as SupervisorRule['source'],
  enabled: r.enabled,
  note: r.note,
  createdAt: r.createdAt,
});

const toDecision = (r: DecisionRow): SupervisorDecisionView => ({
  id: r.id,
  sessionPk: r.sessionPk,
  projectId: r.projectId,
  question: r.question,
  decision: r.decision as SupervisorDecisionView['decision'],
  answer: r.answer,
  confidence: r.confidence,
  reason: r.reason,
  intent: (r.intent as SupervisorIntent | null) ?? null,
  sent: r.sent,
  costUsd: r.costUsd,
  model: r.model,
  feedback: r.feedback === 'wrong' ? 'wrong' : null,
  ts: r.ts,
});

const toTarget = (r: TargetRow): SupervisorTarget => ({
  targetType: r.targetType as SupervisorTarget['targetType'],
  targetId: r.targetId,
  enabled: r.enabled,
});

export function listRules(db: OrcDb, projectId?: string | null): SupervisorRule[] {
  const scope = projectId
    ? or(isNull(supervisorRules.projectId), eq(supervisorRules.projectId, projectId))
    : isNull(supervisorRules.projectId);
  return db
    .select()
    .from(supervisorRules)
    .where(and(eq(supervisorRules.enabled, true), scope))
    .orderBy(supervisorRules.createdAt)
    .all()
    .map(toRule);
}

export function listAllRules(db: OrcDb): SupervisorRule[] {
  return db.select().from(supervisorRules).orderBy(supervisorRules.createdAt).all().map(toRule);
}

export function insertRule(
  db: OrcDb,
  r: SupervisorRuleInput & { source: SupervisorRule['source'] },
  now: string,
): SupervisorRule {
  const row = db
    .insert(supervisorRules)
    .values({
      id: randomUUID(),
      projectId: r.projectId,
      kind: r.kind,
      pattern: r.pattern,
      intent: r.intent,
      answer: r.answer,
      source: r.source,
      enabled: true,
      note: r.note,
      createdAt: now,
    })
    .returning()
    .all()[0];
  if (!row) throw new Error('supervisor rule was not saved');
  return toRule(row);
}

export function deleteRule(db: OrcDb, id: string): boolean {
  return db.delete(supervisorRules).where(eq(supervisorRules.id, id)).run().changes > 0;
}

export function insertDecision(db: OrcDb, d: SupervisorDecisionView): SupervisorDecisionView {
  db.insert(supervisorDecisions).values({ ...d }).run();
  const saved = getDecision(db, d.id);
  if (!saved) throw new Error(`supervisor decision ${d.id} was not saved`);
  return saved;
}

export function getDecision(db: OrcDb, id: string): SupervisorDecisionView | null {
  const row = db.select().from(supervisorDecisions).where(eq(supervisorDecisions.id, id)).get();
  return row ? toDecision(row) : null;
}

export function listDecisions(db: OrcDb, q: { sessionPk?: string; limit?: number }): SupervisorDecisionView[] {
  const base = db.select().from(supervisorDecisions);
  const rows = q.sessionPk
    ? base.where(eq(supervisorDecisions.sessionPk, q.sessionPk)).orderBy(desc(supervisorDecisions.ts)).limit(q.limit ?? 100).all()
    : base.orderBy(desc(supervisorDecisions.ts)).limit(q.limit ?? 100).all();
  return rows.map(toDecision);
}

export function markFeedback(db: OrcDb, id: string, feedback: 'wrong'): SupervisorDecisionView {
  db.update(supervisorDecisions).set({ feedback }).where(eq(supervisorDecisions.id, id)).run();
  const d = getDecision(db, id);
  if (!d) throw new Error(`supervisor decision ${id} not found`);
  return d;
}

export function countAnswered(db: OrcDb, sinceIso: string, sessionPk?: string): number {
  const where = sessionPk
    ? and(eq(supervisorDecisions.sent, true), gte(supervisorDecisions.ts, sinceIso), eq(supervisorDecisions.sessionPk, sessionPk))
    : and(eq(supervisorDecisions.sent, true), gte(supervisorDecisions.ts, sinceIso));
  return Number(db.select({ n: sql<number>`count(*)` }).from(supervisorDecisions).where(where).get()?.n ?? 0);
}

export function countEscalated(db: OrcDb, sinceIso: string): number {
  return Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(supervisorDecisions)
      .where(and(eq(supervisorDecisions.decision, 'escalate'), gte(supervisorDecisions.ts, sinceIso)))
      .get()?.n ?? 0,
  );
}

export function monthCost(db: OrcDb, sinceIso: string): number {
  return Number(
    db
      .select({ total: sql<number>`coalesce(sum(${supervisorDecisions.costUsd}), 0)` })
      .from(supervisorDecisions)
      .where(gte(supervisorDecisions.ts, sinceIso))
      .get()?.total ?? 0,
  );
}

export function getTarget(db: OrcDb, targetType: SupervisorTarget['targetType'], targetId: string): SupervisorTarget | null {
  const row = db
    .select()
    .from(supervisorTargets)
    .where(and(eq(supervisorTargets.targetType, targetType), eq(supervisorTargets.targetId, targetId)))
    .get();
  return row ? toTarget(row) : null;
}

export function setTarget(db: OrcDb, t: SupervisorTarget, now: string): SupervisorTarget {
  db.insert(supervisorTargets)
    .values({ targetType: t.targetType, targetId: t.targetId, enabled: t.enabled, updatedAt: now })
    .onConflictDoUpdate({
      target: [supervisorTargets.targetType, supervisorTargets.targetId],
      set: { enabled: t.enabled, updatedAt: now },
    })
    .run();
  const saved = getTarget(db, t.targetType, t.targetId);
  if (!saved) throw new Error('supervisor target was not saved');
  return saved;
}

export function listTargets(db: OrcDb): SupervisorTarget[] {
  return db.select().from(supervisorTargets).orderBy(supervisorTargets.targetType, supervisorTargets.targetId).all().map(toTarget);
}
```

- [ ] **Step 5: Run the tests, then all checks, and commit**

Run: `pnpm vitest run apps/daemon/test/p7/supervisor-repo.test.ts packages/api-contract`
Expected: PASS (repo 3 tests, plus the api-contract suites)

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add packages/api-contract apps/daemon/src/db apps/daemon/test/p7/supervisor-repo.test.ts
git commit -m "feat(supervisor): add rules, decisions and targets tables with schemas and client"
```

---

### Task 15: Pending-question extraction and the rules engine (pure)

**Files:**
- Create: `apps/daemon/src/services/supervisor/question.ts`, `apps/daemon/src/services/supervisor/rules.ts`
- Test: `apps/daemon/test/p7/supervisor-rules.test.ts`

**Interfaces:**
- Consumes: `readJsonlFrom`, `parseJsonLine`, `classifyClaudeRecord`, `contentText`, `checkDenied`, `redact` (`@orc/core`, P0/P1); `DenyVerdict`, `DenyList` (P3); `SupervisorRule`, `SupervisorIntent` (Task 14); the fixture `fixtures/claude-home/projects/-Users-test-Wakecap/s-basic.jsonl` (P0).
- Produces:
  ```ts
  // question.ts
  export interface PendingQuestion { text: string; tail: string; waitingFor: string | null }
  export function lastParagraph(text: string): string
  export function lastAssistantTextFromTranscript(path: string, opts?: { maxBytes?: number }): Promise<string | null>
  export function buildPendingQuestion(lastAssistantText: string | null, waitingFor: string | null): PendingQuestion | null
  // rules.ts
  export interface IntentRule { intent: SupervisorIntent; pattern: RegExp; answer: string; requires?: RegExp }
  export const BUILTIN_INTENTS: readonly IntentRule[]
  export const SUPERVISOR_DENY_PATTERNS: string[]
  export interface RuleVerdict { intent: SupervisorIntent | null; answer: string | null; matchedBy: 'builtin' | 'user' | null; denied: boolean; denyReason: string | null }
  export function compileUserPattern(pattern: string): RegExp | null
  export function applyRules(q: PendingQuestion, opts: { rules: readonly SupervisorRule[]; deny: (text: string) => DenyVerdict }): RuleVerdict
  export function feedbackPattern(question: string): string
  export function inQuietHours(now: Date, quiet: { start: string; end: string } | null): boolean
  ```
  Rules:
  - The **deny** checks read the whole question (assistant text tail plus `waitingFor`): the shared `DenyList`, then `SUPERVISOR_DENY_PATTERNS`, then user/feedback `deny` rules. Any hit means escalate, and the classifier is never called.
  - The **allow** checks read only the last paragraph, so an old sentence higher up cannot trigger an answer. User `allow` rules win over the built-ins.
  - The answer that is sent is always the **canned** answer from the matched rule, never free text from the model.

- [ ] **Step 1: Write the failing test**

`apps/daemon/test/p7/supervisor-rules.test.ts`
```ts
import { join } from 'node:path';
import type { SupervisorRule } from '@orc/api-contract';
import { checkDenied, DEFAULT_DENY_PATTERNS, FIXTURES_DIR } from '@orc/core';
import { describe, expect, it } from 'vitest';
import {
  applyRules,
  compileUserPattern,
  feedbackPattern,
  inQuietHours,
  SUPERVISOR_DENY_PATTERNS,
} from '../../src/services/supervisor/rules.ts';
import { buildPendingQuestion, lastAssistantTextFromTranscript, lastParagraph } from '../../src/services/supervisor/question.ts';

const deny = (text: string) => checkDenied(text, DEFAULT_DENY_PATTERNS);
const rule = (over: Partial<SupervisorRule>): SupervisorRule => ({
  id: 'r', projectId: null, kind: 'allow', pattern: 'x', intent: 'continue', answer: 'Yes, continue.',
  source: 'user', enabled: true, note: null, createdAt: '2026-09-18T09:00:00.000Z', ...over,
});
const q = (text: string, waitingFor: string | null = 'input needed') => {
  const built = buildPendingQuestion(text, waitingFor);
  if (!built) throw new Error('no question');
  return built;
};

describe('question extraction', () => {
  it('reads the last assistant text from a transcript tail', async () => {
    const path = join(FIXTURES_DIR, 'claude-home/projects/-Users-test-Wakecap/s-basic.jsonl');
    expect(await lastAssistantTextFromTranscript(path)).toBe('Edited.');
    expect(await lastAssistantTextFromTranscript(path, { maxBytes: 64 })).toBe('Edited.');
    expect(await lastAssistantTextFromTranscript('/nope/missing.jsonl')).toBeNull();
  });

  it('builds a question from the tail plus waitingFor', () => {
    const built = buildPendingQuestion('I refactored the helper.\n\nShould I continue?', 'input needed');
    expect(built).toEqual({
      text: 'I refactored the helper.\n\nShould I continue?\n[waiting for: input needed]',
      tail: 'Should I continue?',
      waitingFor: 'input needed',
    });
    expect(buildPendingQuestion(null, null)).toBeNull();
    expect(buildPendingQuestion('   ', null)).toBeNull();
    expect(buildPendingQuestion(null, 'input needed')?.tail).toBe('[waiting for: input needed]');
    expect(lastParagraph('a\n\nb\n\n  ')).toBe('b');
  });
});

describe('applyRules', () => {
  it.each([
    ['Should I continue?', 'continue', 'Yes, continue.'],
    ['continue?', 'continue', 'Yes, continue.'],
    ['Do you want me to run the tests?', 'run_tests', 'Yes, run the tests.'],
    ['Shall I proceed with the approved plan?', 'proceed_plan', 'Yes, proceed with the approved plan.'],
  ])('matches the built-in intent in %s', (text, intent, answer) => {
    expect(applyRules(q(text), { rules: [], deny })).toEqual({ intent, answer, matchedBy: 'builtin', denied: false, denyReason: null });
  });

  it('retries only transient errors', () => {
    expect(applyRules(q('API Error: 529 overloaded. Retry?'), { rules: [], deny }).intent).toBe('retry_transient');
    expect(applyRules(q('The migration failed. Retry?'), { rules: [], deny }).intent).toBeNull();
  });

  it('only looks at the last paragraph for allow matches', () => {
    const text = 'Earlier I asked: should I continue?\n\nWhich database should I point the migration at?';
    expect(applyRules(q(text), { rules: [], deny }).intent).toBeNull();
  });

  it.each([
    'Should I deploy this to production?',
    'Shall I run git push --force to main?',
    'Continue? I will drop table sessions first.',
    'Should I merge the PR now?',
    'Should I continue with the prod database credentials?',
  ])('escalates dangerous questions: %s', (text) => {
    const v = applyRules(q(text), { rules: [], deny });
    expect(v.denied).toBe(true);
    expect(v.intent).toBeNull();
    expect(v.denyReason).toBeTruthy();
  });

  it('honours user allow rules and user/feedback deny rules', () => {
    const allow = rule({ pattern: 'ship it\\?$', intent: 'continue', answer: 'Yes, ship it.' });
    expect(applyRules(q('Ready. Ship it?'), { rules: [allow], deny })).toMatchObject({ intent: 'continue', answer: 'Yes, ship it.', matchedBy: 'user' });
    const denyRule = rule({ kind: 'deny', pattern: 'ship it', intent: null, answer: null, source: 'feedback' });
    expect(applyRules(q('Ready. Ship it?'), { rules: [allow, denyRule], deny }).denied).toBe(true);
    expect(applyRules(q('Should I continue?'), { rules: [rule({ kind: 'deny', pattern: 'continue', source: 'feedback' })], deny }).denied).toBe(true);
  });

  it('ignores invalid user patterns instead of throwing', () => {
    expect(compileUserPattern('([')).toBeNull();
    expect(applyRules(q('Should I continue?'), { rules: [rule({ kind: 'deny', pattern: '([' })], deny }).denied).toBe(false);
  });

  it('keeps its own deny list in sync with the shared one', () => {
    expect(SUPERVISOR_DENY_PATTERNS.length).toBeGreaterThan(5);
    expect(checkDenied('please merge the pr', SUPERVISOR_DENY_PATTERNS).denied).toBe(true);
  });
});

describe('feedbackPattern and quiet hours', () => {
  it('escapes the question into a literal pattern', () => {
    const p = feedbackPattern('Should I continue (really)?');
    expect(new RegExp(p, 'i').test('should i continue (really)?')).toBe(true);
    expect(new RegExp(p, 'i').test('should i stop')).toBe(false);
  });

  it('handles quiet hours that wrap past midnight', () => {
    const at = (h: number, m = 0) => new Date(2026, 8, 18, h, m, 0);
    expect(inQuietHours(at(23), { start: '22:00', end: '08:00' })).toBe(true);
    expect(inQuietHours(at(3), { start: '22:00', end: '08:00' })).toBe(true);
    expect(inQuietHours(at(9), { start: '22:00', end: '08:00' })).toBe(false);
    expect(inQuietHours(at(13), { start: '12:00', end: '14:00' })).toBe(true);
    expect(inQuietHours(at(15), { start: '12:00', end: '14:00' })).toBe(false);
    expect(inQuietHours(at(3), null)).toBe(false);
  });
});
```
`FIXTURES_DIR` comes from `@orc/core` (Phase 0 `test-utils/fixtures.ts`). If it is not re-exported from the package index, import it from `@orc/core/src/test-utils/fixtures.ts` or rebuild the path with `fileURLToPath(new URL('../../../../fixtures/…', import.meta.url))`.

Run: `pnpm vitest run apps/daemon/test/p7/supervisor-rules.test.ts`
Expected: FAIL, `Cannot find module '../../src/services/supervisor/rules.ts'`

- [ ] **Step 2: Implement the question extraction**

`apps/daemon/src/services/supervisor/question.ts`
```ts
import { stat } from 'node:fs/promises';
import { classifyClaudeRecord, contentText, parseJsonLine, readJsonlFrom } from '@orc/core';

export interface PendingQuestion {
  /** The assistant's last text (trimmed to 1200 chars) plus the registry's waitingFor line. Used for deny checks. */
  text: string;
  /** The last paragraph only (max 400 chars). Used for allow-list matching. */
  tail: string;
  waitingFor: string | null;
}

const MAX_TEXT = 1200;
const MAX_TAIL = 400;

export function lastParagraph(text: string): string {
  const parts = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.at(-1) ?? '';
}

/**
 * Reads only the tail of a transcript and returns the last non-sidechain assistant text.
 * A partial first line (the read starts mid-line) fails to parse and is skipped.
 */
export async function lastAssistantTextFromTranscript(path: string, opts: { maxBytes?: number } = {}): Promise<string | null> {
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return null;
  }
  const { lines } = await readJsonlFrom(path, Math.max(0, size - maxBytes));
  let text: string | null = null;
  for (const line of lines) {
    const value = parseJsonLine(line.text);
    if (value === undefined) continue;
    const c = classifyClaudeRecord(value);
    if (c.kind !== 'assistant' || c.rec.isSidechain === true) continue;
    const t = contentText(c.rec.message?.content).trim();
    if (t) text = t;
  }
  return text;
}

export function buildPendingQuestion(lastAssistantText: string | null, waitingFor: string | null): PendingQuestion | null {
  const body = (lastAssistantText ?? '').trim().slice(-MAX_TEXT);
  const waiting = waitingFor?.trim() ? `[waiting for: ${waitingFor.trim()}]` : '';
  if (!body && !waiting) return null;
  const text = [body, waiting].filter(Boolean).join('\n');
  const tail = (body ? lastParagraph(body) : waiting).slice(-MAX_TAIL);
  return { text, tail: tail || waiting, waitingFor: waitingFor?.trim() ? waitingFor.trim() : null };
}
```

- [ ] **Step 3: Implement the rules engine**

`apps/daemon/src/services/supervisor/rules.ts`
```ts
import type { SupervisorIntent, SupervisorRule } from '@orc/api-contract';
import { checkDenied, type DenyVerdict } from '@orc/core';
import type { PendingQuestion } from './question.ts';

export interface IntentRule {
  intent: SupervisorIntent;
  pattern: RegExp;
  answer: string;
  /** Extra condition on the whole question; used so "retry" only fires for transient errors. */
  requires?: RegExp;
}

export const BUILTIN_INTENTS: readonly IntentRule[] = [
  {
    intent: 'proceed_plan',
    pattern: /\b(proceed|go ahead|continue|start)\b[^?.]{0,40}\bwith\s+(the\s+)?(approved\s+)?plan\b/i,
    answer: 'Yes, proceed with the approved plan.',
  },
  {
    intent: 'run_tests',
    pattern: /\b(run|re-?run|execute)\b[^?.]{0,30}\btests?\b/i,
    answer: 'Yes, run the tests.',
  },
  {
    intent: 'retry_transient',
    pattern: /\b(retry|try again)\b/i,
    requires: /\b(429|503|529|overloaded|rate.?limit(ed)?|timed out|timeout|econnreset|etimedout|temporarily unavailable|api error)\b/i,
    answer: 'Yes, retry.',
  },
  {
    intent: 'continue',
    pattern: /(^|\b)(should i|shall i|do you want me to|want me to|ok to|may i)\s+(continue|proceed|keep going|go ahead)\b|^\s*(continue|proceed|keep going)\s*\??\s*$|\b(continue|proceed)\?\s*$/i,
    answer: 'Yes, continue.',
  },
];

/** Regex sources (case-insensitive). Anything matching escalates, whatever the classifier says. */
export const SUPERVISOR_DENY_PATTERNS: string[] = [
  String.raw`\b(prod|production|live\s+environment)\b`,
  String.raw`\bdeploy(s|ed|ing|ment)?\b`,
  String.raw`\brelease\b`,
  String.raw`\bmerge\b`,
  String.raw`\bgit\s+push\s+(-f|--force)`,
  String.raw`\bforce[- ]push\b`,
  String.raw`\bgit\s+reset\s+--hard\b`,
  String.raw`\brm\s+-rf\b`,
  String.raw`\bdrop\s+(table|database)\b`,
  String.raw`\btruncate\s+table\b`,
  String.raw`\bmigrat(e|ion)\b`,
  String.raw`\bterraform\b|\bkubectl\b|\bhelm\b`,
  String.raw`\b(credential|password|secret|api[_-]?key|token)s?\b`,
  String.raw`\bdelete\b[^?.]{0,20}\b(branch|data|rows|records|users)\b`,
  String.raw`\bcharge|\bpayment\b|\bbilling\b`,
];

export interface RuleVerdict {
  intent: SupervisorIntent | null;
  answer: string | null;
  matchedBy: 'builtin' | 'user' | null;
  denied: boolean;
  denyReason: string | null;
}

export function compileUserPattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

const noMatch: RuleVerdict = { intent: null, answer: null, matchedBy: null, denied: false, denyReason: null };
const denyVerdict = (reason: string): RuleVerdict => ({ intent: null, answer: null, matchedBy: null, denied: true, denyReason: reason });

export function applyRules(q: PendingQuestion, opts: { rules: readonly SupervisorRule[]; deny: (text: string) => DenyVerdict }): RuleVerdict {
  const shared = opts.deny(q.text);
  if (shared.denied) return denyVerdict(`deny-list: ${shared.reason ?? 'matched'}`);
  const own = checkDenied(q.text, SUPERVISOR_DENY_PATTERNS);
  if (own.denied) return denyVerdict(`supervisor deny-list: ${own.reason ?? 'matched'}`);
  for (const r of opts.rules) {
    if (r.kind !== 'deny') continue;
    const re = compileUserPattern(r.pattern);
    if (re?.test(q.text)) return denyVerdict(`rule: ${r.note ?? r.pattern}`);
  }
  for (const r of opts.rules) {
    if (r.kind !== 'allow' || !r.intent || !r.answer) continue;
    const re = compileUserPattern(r.pattern);
    if (re?.test(q.tail)) return { intent: r.intent, answer: r.answer, matchedBy: 'user', denied: false, denyReason: null };
  }
  for (const b of BUILTIN_INTENTS) {
    if (!b.pattern.test(q.tail)) continue;
    if (b.requires && !b.requires.test(q.text)) continue;
    return { intent: b.intent, answer: b.answer, matchedBy: 'builtin', denied: false, denyReason: null };
  }
  return noMatch;
}

/** Turns a question into a literal regex, so "that was wrong" escalates the same question next time. */
export function feedbackPattern(question: string): string {
  const normalised = question.replace(/\s+/g, ' ').trim().slice(0, 80);
  return normalised.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
}

export function inQuietHours(now: Date, quiet: { start: string; end: string } | null): boolean {
  if (!quiet) return false;
  const mins = (hhmm: string): number => {
    const [h, m] = hhmm.split(':');
    return Number(h) * 60 + Number(m);
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = mins(quiet.start);
  const end = mins(quiet.end);
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}
```
`BUILTIN_INTENTS` regexes use the `i` flag only (never `g`), so `.test` has no `lastIndex` state.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/test/p7/supervisor-rules.test.ts`
Expected: PASS (13 tests). If a "dangerous question" case passes because of `DEFAULT_DENY_PATTERNS` rather than `SUPERVISOR_DENY_PATTERNS`, that is fine — both lists are checked.

- [ ] **Step 5: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/daemon/src/services/supervisor apps/daemon/test/p7/supervisor-rules.test.ts
git commit -m "feat(supervisor): extract pending questions and match them against allow and deny rules"
```

---

### Task 16: Haiku classifier through `claude -p` with strict JSON parsing

**Files:**
- Create: `apps/daemon/src/services/supervisor/classifier.ts`, `apps/daemon/test/bin/fake-claude-json.mjs`
- Test: `apps/daemon/test/p7/supervisor-classifier.test.ts`

**Interfaces:**
- Consumes: `redact` (`@orc/core`); execa 10; zod 4; `SupervisorIntent` (Task 14); `PendingQuestion` (Task 15). It follows the same engine idea as P5's `RecapService` (`claude -p` headless, `--output-format json`), but it never reuses a recap session and never writes a transcript.
- Produces:
  ```ts
  export const ClassifierOutput: z.ZodObject<…>   // { decision: 'answer'|'escalate'; answer: string | null; confidence: 0..1; reason: string }, strict
  export type ClassifierOutput = z.infer<typeof ClassifierOutput>
  export interface ClassifyInput { question: string; context: string; intent: SupervisorIntent | null; cannedAnswer: string | null; model: string }
  export interface ClassifyResult { output: ClassifierOutput; costUsd: number | null; model: string; durationMs: number }
  export type Classifier = (i: ClassifyInput) => Promise<ClassifyResult>
  export class ClassifierError extends Error { readonly code: 'classifier_failed' }
  export function buildClassifierPrompt(i: ClassifyInput): string
  export function parseClassifierText(text: string): ClassifierOutput
  export function buildClassifierArgs(o: { model: string; maxBudgetUsd: number }): string[]
  export function createClaudeClassifier(o: { command: string; cwd: string; timeoutMs?: number; maxBudgetUsd?: number; env?: Record<string, string> }): Classifier
  ```
  The call is `claude -p --output-format json --model <m> --tools "" --no-session-persistence --safe-mode --max-budget-usd 0.05`, with the prompt on **stdin**. `--tools ""` removes every tool, `--no-session-persistence` keeps the probe out of `~/.claude/projects`, and `--safe-mode` ignores CLAUDE.md, skills, hooks and MCP servers. The prompt text is redacted again inside `buildClassifierPrompt`, so an un-redacted caller still cannot leak secrets.

- [ ] **Step 1: Write the fake CLI and the failing test**

`apps/daemon/test/bin/fake-claude-json.mjs`
```js
#!/usr/bin/env node
// Fake `claude -p --output-format json`. FAKE_RESULT is the assistant's result text; FAKE_EXIT forces a failure.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
if (process.env.FAKE_ARGS_FILE) appendFileSync(process.env.FAKE_ARGS_FILE, `${JSON.stringify({ args, stdin })}\n`);
if (process.env.FAKE_MODE === 'hang') {
  setInterval(() => {}, 1000);
} else if (process.env.FAKE_EXIT) {
  process.stderr.write('credit balance too low\n');
  process.exit(Number(process.env.FAKE_EXIT));
} else {
  process.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: process.env.FAKE_RESULT ?? '{"decision":"answer","answer":"Yes, continue.","confidence":0.93,"reason":"routine continue"}',
      session_id: 'classifier',
      duration_ms: 420,
      total_cost_usd: 0.0021,
    })}\n`,
  );
}
```

`apps/daemon/test/p7/supervisor-classifier.test.ts`
```ts
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildClassifierArgs,
  buildClassifierPrompt,
  ClassifierError,
  createClaudeClassifier,
  parseClassifierText,
} from '../../src/services/supervisor/classifier.ts';

const FAKE = fileURLToPath(new URL('../bin/fake-claude-json.mjs', import.meta.url));
beforeAll(() => chmodSync(FAKE, 0o755));

const input = {
  question: 'I updated the helper.\n\nShould I continue? token=abc123',
  context: 'session: SAF-1787 weekends · last prompt: keep going',
  intent: 'continue' as const,
  cannedAnswer: 'Yes, continue.',
  model: 'claude-haiku-4-5',
};

describe('buildClassifierPrompt', () => {
  it('redacts, states the candidate answer and demands JSON only', () => {
    const p = buildClassifierPrompt(input);
    expect(p).toContain('«redacted:secret»');
    expect(p).not.toContain('abc123');
    expect(p).toContain('Yes, continue.');
    expect(p).toContain('"decision"');
    expect(p).toMatch(/only.*JSON/i);
  });
});

describe('parseClassifierText', () => {
  it('accepts plain and fenced JSON', () => {
    expect(parseClassifierText('{"decision":"escalate","answer":null,"confidence":0.4,"reason":"ambiguous"}')).toEqual({
      decision: 'escalate', answer: null, confidence: 0.4, reason: 'ambiguous',
    });
    expect(parseClassifierText('```json\n{"decision":"answer","answer":"Yes, continue.","confidence":0.9,"reason":"ok"}\n```').decision).toBe('answer');
  });

  it.each([
    'not json at all',
    '{"decision":"maybe","answer":null,"confidence":0.5,"reason":"x"}',
    '{"decision":"answer","answer":null,"confidence":2,"reason":"x"}',
    '{"decision":"answer","answer":null,"confidence":0.5}',
    '{"decision":"answer","answer":null,"confidence":0.5,"reason":"x","extra":true}',
  ])('rejects %s', (text) => {
    expect(() => parseClassifierText(text)).toThrow(ClassifierError);
  });
});

describe('buildClassifierArgs', () => {
  it('runs headless with no tools, no persistence and a hard budget', () => {
    const args = buildClassifierArgs({ model: 'claude-haiku-4-5', maxBudgetUsd: 0.05 });
    expect(args.join(' ')).toBe('-p --output-format json --model claude-haiku-4-5 --tools  --no-session-persistence --safe-mode --max-budget-usd 0.05');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });
});

describe('createClaudeClassifier', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'orc-p7-cls-'));

  it('classifies and reports the cost', async () => {
    const argsFile = join(cwd, 'args.jsonl');
    const classify = createClaudeClassifier({ command: FAKE, cwd, env: { FAKE_ARGS_FILE: argsFile } });
    const r = await classify(input);
    expect(r.output).toEqual({ decision: 'answer', answer: 'Yes, continue.', confidence: 0.93, reason: 'routine continue' });
    expect(r.costUsd).toBe(0.0021);
    expect(r.model).toBe('claude-haiku-4-5');
    const call = JSON.parse(readFileSync(argsFile, 'utf8').trim()) as { stdin: string; args: string[] };
    expect(call.stdin).toContain('Should I continue?');
    expect(call.args).toContain('--no-session-persistence');
  });

  it('throws ClassifierError on invalid JSON, on CLI failure and on timeout', async () => {
    const bad = createClaudeClassifier({ command: FAKE, cwd, env: { FAKE_RESULT: 'I think you should continue!' } });
    await expect(bad(input)).rejects.toBeInstanceOf(ClassifierError);
    const failing = createClaudeClassifier({ command: FAKE, cwd, env: { FAKE_EXIT: '1' } });
    await expect(failing(input)).rejects.toThrow(/classifier/i);
    const hanging = createClaudeClassifier({ command: FAKE, cwd, timeoutMs: 300, env: { FAKE_MODE: 'hang' } });
    await expect(hanging(input)).rejects.toBeInstanceOf(ClassifierError);
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p7/supervisor-classifier.test.ts`
Expected: FAIL, `Cannot find module '../../src/services/supervisor/classifier.ts'`

- [ ] **Step 2: Implement the classifier**

`apps/daemon/src/services/supervisor/classifier.ts`
```ts
import { redact } from '@orc/core';
import { execa } from 'execa';
import { z } from 'zod';
import type { SupervisorIntent } from '@orc/api-contract';

export const ClassifierOutput = z
  .object({
    decision: z.enum(['answer', 'escalate']),
    answer: z.string().max(500).nullable(),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(500),
  })
  .strict();
export type ClassifierOutput = z.infer<typeof ClassifierOutput>;

export interface ClassifyInput {
  question: string;
  context: string;
  intent: SupervisorIntent | null;
  cannedAnswer: string | null;
  model: string;
}

export interface ClassifyResult {
  output: ClassifierOutput;
  costUsd: number | null;
  model: string;
  durationMs: number;
}

export type Classifier = (i: ClassifyInput) => Promise<ClassifyResult>;

export class ClassifierError extends Error {
  readonly code = 'classifier_failed' as const;
}

export function buildClassifierPrompt(i: ClassifyInput): string {
  return [
    'You are a cautious supervisor for a coding agent. Decide whether a routine question can be answered automatically.',
    '',
    'Answer ONLY when all of these hold:',
    '- the question is routine (continue, run the tests, proceed with an already approved plan, retry a transient error)',
    '- answering cannot cause a merge, a deploy, a production change, data loss or a credential change',
    '- the intended answer below is clearly the right one',
    'Otherwise escalate. When in doubt, escalate.',
    '',
    `Rule match: ${i.intent ?? 'none'}`,
    `Intended answer: ${i.cannedAnswer ?? '(none)'}`,
    '',
    'Context:',
    redact(i.context).slice(0, 800),
    '',
    'Agent question:',
    redact(i.question).slice(0, 1200),
    '',
    'Reply with only this JSON object, no prose and no code fences:',
    '{"decision":"answer"|"escalate","answer":string|null,"confidence":0.0-1.0,"reason":"short reason"}',
  ].join('\n');
}

export function parseClassifierText(text: string): ClassifierOutput {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ClassifierError(`classifier did not return JSON: ${cleaned.slice(0, 120)}`);
  let value: unknown;
  try {
    value = JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    throw new ClassifierError(`classifier returned invalid JSON: ${(e as Error).message}`);
  }
  const parsed = ClassifierOutput.safeParse(value);
  if (!parsed.success) {
    throw new ClassifierError(`classifier output failed validation: ${parsed.error.issues.map((x) => x.message).join('; ')}`);
  }
  return parsed.data;
}

export function buildClassifierArgs(o: { model: string; maxBudgetUsd: number }): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    o.model,
    '--tools',
    '',
    '--no-session-persistence',
    '--safe-mode',
    '--max-budget-usd',
    o.maxBudgetUsd.toFixed(2),
  ];
}

const CliResult = z
  .object({ type: z.literal('result'), is_error: z.boolean().default(false), result: z.string().optional(), total_cost_usd: z.number().optional(), duration_ms: z.number().optional() })
  .loose();

export function createClaudeClassifier(o: {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  env?: Record<string, string>;
}): Classifier {
  return async (i) => {
    const started = Date.now();
    const res = await execa(o.command, buildClassifierArgs({ model: i.model, maxBudgetUsd: o.maxBudgetUsd ?? 0.05 }), {
      cwd: o.cwd,
      input: buildClassifierPrompt(i),
      timeout: o.timeoutMs ?? 30_000,
      forceKillAfterDelay: 3_000,
      reject: false,
      env: o.env,
    });
    if (res.timedOut) throw new ClassifierError(`classifier timed out after ${o.timeoutMs ?? 30_000} ms`);
    if (res.exitCode !== 0) {
      throw new ClassifierError(`classifier exited with ${res.exitCode}: ${String(res.stderr ?? '').slice(-200)}`);
    }
    let payload: z.infer<typeof CliResult>;
    try {
      payload = CliResult.parse(JSON.parse(String(res.stdout)));
    } catch (e) {
      throw new ClassifierError(`classifier CLI output was not a result object: ${(e as Error).message}`);
    }
    if (payload.is_error) throw new ClassifierError('classifier reported an error');
    return {
      output: parseClassifierText(payload.result ?? ''),
      costUsd: payload.total_cost_usd ?? null,
      model: i.model,
      durationMs: payload.duration_ms ?? Date.now() - started,
    };
  };
}
```
`createClaudeClassifier` takes an `env` option so tests can drive the fake CLI; production passes nothing, and execa inherits the daemon's environment.

- [ ] **Step 3: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/test/p7/supervisor-classifier.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 4: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/daemon/src/services/supervisor/classifier.ts apps/daemon/test/bin/fake-claude-json.mjs apps/daemon/test/p7/supervisor-classifier.test.ts
git commit -m "feat(supervisor): add the Haiku classifier with strict JSON parsing"
```

---

### Task 17: Supervisor service (caps, budget, quiet hours, answer or escalate) and wiring

**Files:**
- Create: `apps/daemon/src/services/supervisor/supervisor.ts`
- Modify: `apps/daemon/src/context.ts` (`supervisor?: SupervisorImpl`), `apps/daemon/src/main.ts` (wiring)
- Test: `apps/daemon/test/p7/supervisor-service.test.ts`

**Interfaces:**
- Consumes: Tasks 14–16; `ctx.sessions.getByPk` (P1); `ctx.pty.sendText` (§7, bracketed paste from spike S8); `ctx.inbox.upsert/resolve` (P2, dedupe key `waiting:<pk>`); `ctx.audit.record` (P3); `ctx.denyList.check` (P3); `ctx.usage.checkBudget` (P5); bus `session.statusChanged` (P2); `ServiceError` (P1).
- Produces:
  ```ts
  export interface SupervisorDeps { ctx: DaemonContext; classifier?: Classifier; now?: () => Date; lastAssistantText?: (s: Session) => Promise<string | null> }
  export interface SupervisorImpl extends Supervisor {
    evaluate(sessionPk: string): Promise<SupervisorDecisionView>;
    enabledFor(sessionPk: string): boolean;
    start(): () => void;
    setTarget(t: SupervisorTarget): SupervisorTarget;
    targets(): SupervisorTarget[];
    rules(): SupervisorRule[];
    addRule(r: SupervisorRuleInput): SupervisorRule;
    removeRule(id: string): boolean;
    decisions(q: { sessionPk?: string; limit?: number }): SupervisorDecisionView[];
    feedbackWrong(decisionId: string): SupervisorRule;
    status(): SupervisorStatus;
  }
  export function createSupervisor(deps: SupervisorDeps): SupervisorImpl
  export function monthStartIso(d: Date): string
  ```
  Decision order (each step escalates and stops):
  1. the session must exist, be **owned** and have a `ptyId` (else `403 not_owned`)
  2. a pending question must be extractable
  3. deny-list (shared + supervisor + user/feedback rules) → escalate, **without** calling the model
  4. an allow-listed intent must match → otherwise escalate, **without** calling the model
  5. quiet hours → escalate
  6. caps: answers for this session in the last hour < `maxPerSessionPerHour`, answers overall < `maxPerHour`
  7. budget: supervisor month spend < `monthlyBudgetUsd`, and `UsageMeter.checkBudget` ok
  8. classifier says `answer` with `confidence ≥ confidenceThreshold`
  9. the session is still waiting on the same PTY
  10. `pty.sendText(ptyId, <canned answer>)` — never the model's free text — then audit `supervisor.answer` and resolve the `waiting:<pk>` inbox item

  When the supervisor is off for that session, `evaluate` still runs as a **dry run**: it records the decision with `sent: false` and creates no inbox item. `start()` listens for `session.statusChanged → waiting`, debounces by `supervisor.debounceMs` and cancels when the session leaves `waiting`.

- [ ] **Step 1: Write the failing test**

`apps/daemon/test/p7/supervisor-service.test.ts`
```ts
import type { SupervisorDecisionView } from '@orc/api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as repo from '../../src/db/repos/supervisor.ts';
import { ServiceError } from '../../src/services/errors.ts';
import type { Classifier } from '../../src/services/supervisor/classifier.ts';
import { ClassifierError } from '../../src/services/supervisor/classifier.ts';
import { createSupervisor, monthStartIso } from '../../src/services/supervisor/supervisor.ts';
import { createTestContext, type TestContext } from '../helpers.ts';
import {
  createFakePty,
  fakeAudit,
  fakeDenyList,
  fakeInbox,
  fakeProjects,
  fakeSessions,
  fakeUsage,
  makeLive,
  makeSession,
  testConfig,
} from '../fakes/phase7.ts';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
  vi.useRealTimers();
});

function setup(o: { text?: string; supervisor?: Record<string, unknown>; classifier?: Classifier; enabled?: boolean } = {}) {
  const cfg = testConfig({ supervisor: { enabled: true, confidenceThreshold: 0.8, maxPerSessionPerHour: 2, maxPerHour: 5, monthlyBudgetUsd: 5, ...o.supervisor } });
  const pty = createFakePty();
  const inbox = fakeInbox();
  const audit = fakeAudit();
  const usage = fakeUsage();
  const session = makeSession({
    id: 's1',
    name: 'SAF-1787 weekends',
    lastPrompt: 'keep going',
    tickets: ['SAF-1787'],
    live: makeLive({ status: 'waiting', ptyId: 'pty-1', waitingFor: 'input needed' }),
  });
  const sessions = fakeSessions([session]);
  ctx = createTestContext({
    config: () => cfg,
    projects: fakeProjects(cfg),
    pty,
    inbox,
    audit,
    usage,
    sessions,
    denyList: fakeDenyList(),
  });
  const calls: Array<{ question: string }> = [];
  const classifier: Classifier =
    o.classifier ??
    (async (i) => {
      calls.push({ question: i.question });
      return { output: { decision: 'answer', answer: 'Yes, continue (model text).', confidence: 0.95, reason: 'routine' }, costUsd: 0.002, model: i.model, durationMs: 10 };
    });
  const svc = createSupervisor({ ctx, classifier, lastAssistantText: async () => o.text ?? 'I refactored the helper.\n\nShould I continue?' });
  if (o.enabled !== false) svc.setTarget({ targetType: 'project', targetId: 'wakecap', enabled: true });
  const events: SupervisorDecisionView[] = [];
  ctx.bus.on('supervisor.decided', (e) => events.push(e.decision));
  return { svc, pty, inbox, audit, usage, sessions, session, calls, events, ctx };
}

describe('Supervisor.evaluate', () => {
  it('answers an allow-listed question with the canned answer and audits it', async () => {
    const t = setup();
    const d = await t.svc.evaluate('claude:s1');
    expect(d).toMatchObject({ decision: 'answer', answer: 'Yes, continue.', intent: 'continue', sent: true, costUsd: 0.002 });
    expect(t.pty.sent).toEqual([{ id: 'pty-1', text: 'Yes, continue.' }]);
    expect(t.audit.entries.find((e) => e.action === 'supervisor.answer')).toMatchObject({ actor: 'supervisor', result: 'ok' });
    expect(t.inbox.resolved).toContain('waiting:claude:s1');
    expect(t.events.map((e) => e.decision)).toEqual(['answer']);
    expect(repo.listDecisions(t.ctx.db, {})).toHaveLength(1);
  });

  it.each([
    ['production', 'The migration is ready.\n\nShould I deploy to production?'],
    ['destructive git', 'Ready.\n\nShould I run git push --force to main?'],
  ])('escalates %s without calling the model', async (_name, text) => {
    const t = setup({ text });
    const d = await t.svc.evaluate('claude:s1');
    expect(d.decision).toBe('escalate');
    expect(t.calls).toHaveLength(0);
    expect(t.pty.sent).toHaveLength(0);
    const item = t.inbox.items.find((i) => i.kind === 'supervisor_escalation');
    expect(item).toMatchObject({ dedupeKey: 'supervisor:claude:s1', ticket: 'SAF-1787' });
    expect(item?.payload).toMatchObject({ source: 'claude', id: 's1', decisionId: d.id });
    expect(t.audit.entries.find((e) => e.action === 'supervisor.escalate')?.actor).toBe('supervisor');
  });

  it('escalates when no intent matches, and never sends the model text', async () => {
    const t = setup({ text: 'Which database should I point the migration at?' });
    expect((await t.svc.evaluate('claude:s1')).decision).toBe('escalate');
    expect(t.calls).toHaveLength(0);

    const u = setup({
      classifier: async (i) => ({ output: { decision: 'answer', answer: 'Yes, and merge it.', confidence: 0.99, reason: 'x' }, costUsd: 0, model: i.model, durationMs: 1 }),
    });
    await u.svc.evaluate('claude:s1');
    expect(u.pty.sent[0]?.text).toBe('Yes, continue.');
  });

  it('escalates on low confidence, on escalate and when the classifier fails', async () => {
    const low = setup({ classifier: async (i) => ({ output: { decision: 'answer', answer: 'x', confidence: 0.4, reason: 'unsure' }, costUsd: 0.001, model: i.model, durationMs: 1 }) });
    const d1 = await low.svc.evaluate('claude:s1');
    expect(d1).toMatchObject({ decision: 'escalate', confidence: 0.4, costUsd: 0.001 });

    const no = setup({ classifier: async (i) => ({ output: { decision: 'escalate', answer: null, confidence: 0.9, reason: 'needs a human' }, costUsd: 0, model: i.model, durationMs: 1 }) });
    expect((await no.svc.evaluate('claude:s1')).decision).toBe('escalate');

    const broken = setup({
      classifier: async () => {
        throw new ClassifierError('bad json');
      },
    });
    const d2 = await broken.svc.evaluate('claude:s1');
    expect(d2.decision).toBe('escalate');
    expect(d2.reason).toContain('classifier');
  });

  it('respects the per-session and hourly caps', async () => {
    const t = setup({ supervisor: { maxPerSessionPerHour: 1, maxPerHour: 5 } });
    expect((await t.svc.evaluate('claude:s1')).sent).toBe(true);
    const second = await t.svc.evaluate('claude:s1');
    expect(second.decision).toBe('escalate');
    expect(second.reason).toMatch(/cap/i);
    expect(t.pty.sent).toHaveLength(1);
  });

  it('stops on the supervisor budget and on the project budget', async () => {
    const t = setup({ supervisor: { monthlyBudgetUsd: 0.001 } });
    repo.insertDecision(t.ctx.db, {
      id: 'old', sessionPk: 'claude:s1', projectId: 'wakecap', question: 'q', decision: 'answer', answer: 'a', confidence: 1,
      reason: 'r', intent: 'continue', sent: true, costUsd: 0.5, model: 'm', feedback: null, ts: monthStartIso(new Date()),
    });
    expect((await t.svc.evaluate('claude:s1')).reason).toMatch(/budget/i);

    const u = setup();
    u.usage.state.ok = false;
    expect((await u.svc.evaluate('claude:s1')).reason).toMatch(/budget/i);
  });

  it('does not answer during quiet hours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 18, 23, 30));
    const t = setup({ supervisor: { quietHours: { start: '22:00', end: '08:00' } } });
    const d = await t.svc.evaluate('claude:s1');
    expect(d.decision).toBe('escalate');
    expect(d.reason).toMatch(/quiet hours/i);
  });

  it('refuses sessions the app does not own, and dry-runs when disabled', async () => {
    const t = setup();
    t.session.live = makeLive({ ownership: 'observed', ptyId: null });
    await expect(t.svc.evaluate('claude:s1')).rejects.toBeInstanceOf(ServiceError);

    const off = setup({ enabled: false });
    const d = await off.svc.evaluate('claude:s1');
    expect(d).toMatchObject({ decision: 'answer', sent: false });
    expect(off.pty.sent).toHaveLength(0);
    expect(off.inbox.items).toHaveLength(0);
    expect(off.svc.enabledFor('claude:s1')).toBe(false);
  });

  it('prefers the session switch over the project switch', () => {
    const t = setup();
    expect(t.svc.enabledFor('claude:s1')).toBe(true);
    t.svc.setTarget({ targetType: 'session', targetId: 'claude:s1', enabled: false });
    expect(t.svc.enabledFor('claude:s1')).toBe(false);
    expect(t.svc.targets()).toHaveLength(2);
  });
});

describe('Supervisor feedback and status', () => {
  it('"that was wrong" adds a deny rule that escalates the same question next time', async () => {
    const t = setup();
    const answered = await t.svc.evaluate('claude:s1');
    const rule = t.svc.feedbackWrong(answered.id);
    expect(rule).toMatchObject({ kind: 'deny', source: 'feedback' });
    expect(t.audit.entries.find((e) => e.action === 'supervisor.feedback')?.actor).toBe('user');
    expect(t.svc.decisions({}).find((d) => d.id === answered.id)?.feedback).toBe('wrong');
    const next = await t.svc.evaluate('claude:s1');
    expect(next.decision).toBe('escalate');
    expect(t.pty.sent).toHaveLength(1);
  });

  it('reports status counters', async () => {
    const t = setup();
    await t.svc.evaluate('claude:s1');
    expect(t.svc.status()).toMatchObject({ enabled: true, quiet: false, answeredLastHour: 1, escalatedLastHour: 0, monthBudgetUsd: 5 });
    expect(t.svc.status().monthCostUsd).toBeCloseTo(0.002);
  });

  it('adds and removes user rules with an audit entry', () => {
    const t = setup();
    const r = t.svc.addRule({ projectId: null, kind: 'allow', pattern: 'ship it\\?$', intent: 'continue', answer: 'Yes, ship it.', note: null });
    expect(t.svc.rules().map((x) => x.id)).toContain(r.id);
    expect(t.audit.entries.filter((e) => e.action === 'supervisor.rule')).toHaveLength(1);
    expect(t.svc.removeRule(r.id)).toBe(true);
    expect(t.svc.removeRule('nope')).toBe(false);
  });
});

describe('Supervisor.start', () => {
  it('evaluates a waiting session after the debounce and cancels when it leaves waiting', async () => {
    vi.useFakeTimers();
    const t = setup({ supervisor: { debounceMs: 1000 } });
    const stop = t.svc.start();
    t.ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s1', from: 'busy', to: 'waiting' });
    await vi.advanceTimersByTimeAsync(1100);
    expect(t.pty.sent).toHaveLength(1);

    t.ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s1', from: 'waiting', to: 'busy' });
    t.ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s1', from: 'busy', to: 'waiting' });
    t.ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s1', from: 'waiting', to: 'busy' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.pty.sent).toHaveLength(1);
    stop();
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p7/supervisor-service.test.ts`
Expected: FAIL, `Cannot find module '../../src/services/supervisor/supervisor.ts'`

- [ ] **Step 2: Implement the service**

`apps/daemon/src/services/supervisor/supervisor.ts`
```ts
import { randomUUID } from 'node:crypto';
import type {
  SupervisorDecisionView,
  SupervisorRule,
  SupervisorRuleInput,
  SupervisorStatus,
  SupervisorTarget,
} from '@orc/api-contract';
import { redact, type Session } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import * as repo from '../../db/repos/supervisor.ts';
import { ServiceError } from '../errors.ts';
import { type Classifier, createClaudeClassifier } from './classifier.ts';
import { buildPendingQuestion, lastAssistantTextFromTranscript, type PendingQuestion } from './question.ts';
import { applyRules, feedbackPattern, inQuietHours } from './rules.ts';

export interface SupervisorDeps {
  ctx: DaemonContext;
  classifier?: Classifier;
  now?: () => Date;
  lastAssistantText?: (s: Session) => Promise<string | null>;
}

export interface SupervisorImpl {
  evaluate(sessionPk: string): Promise<SupervisorDecisionView>;
  enabledFor(sessionPk: string): boolean;
  start(): () => void;
  setTarget(t: SupervisorTarget): SupervisorTarget;
  targets(): SupervisorTarget[];
  rules(): SupervisorRule[];
  addRule(r: SupervisorRuleInput): SupervisorRule;
  removeRule(id: string): boolean;
  decisions(q: { sessionPk?: string; limit?: number }): SupervisorDecisionView[];
  feedbackWrong(decisionId: string): SupervisorRule;
  status(): SupervisorStatus;
}

const HOUR_MS = 3_600_000;

export function monthStartIso(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export function createSupervisor(deps: SupervisorDeps): SupervisorImpl {
  const { ctx } = deps;
  const now = deps.now ?? (() => new Date());
  const cfg = () => ctx.config().supervisor;
  const classifier =
    deps.classifier ??
    createClaudeClassifier({ command: ctx.config().resumeProfile.claudeCommand, cwd: ctx.paths.orcHome });
  const lastAssistantText =
    deps.lastAssistantText ??
    (async (s: Session) => (s.transcriptPath ? lastAssistantTextFromTranscript(s.transcriptPath) : null));
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function enabledFor(sessionPk: string): boolean {
    if (!cfg().enabled) return false;
    const s = ctx.sessions.getByPk(sessionPk);
    if (!s?.live || s.live.ownership !== 'owned' || !s.live.ptyId) return false;
    const session = repo.getTarget(ctx.db, 'session', sessionPk);
    if (session) return session.enabled;
    const project = s.projectId ? repo.getTarget(ctx.db, 'project', s.projectId) : null;
    return project?.enabled ?? false;
  }

  function record(d: Omit<SupervisorDecisionView, 'id' | 'ts'>): SupervisorDecisionView {
    const saved = repo.insertDecision(ctx.db, { ...d, id: randomUUID(), ts: now().toISOString() });
    ctx.bus.emit({ type: 'supervisor.decided', decision: saved });
    return saved;
  }

  interface EscalateOpts {
    intent?: SupervisorDecisionView['intent'];
    confidence?: number;
    costUsd?: number | null;
    model?: string | null;
    dryRun?: boolean;
  }

  function escalate(session: Session, q: PendingQuestion, reason: string, o: EscalateOpts = {}): SupervisorDecisionView {
    const sessionPk = `${session.source}:${session.id}`;
    const d = record({
      sessionPk,
      projectId: session.projectId,
      question: redact(q.text),
      decision: 'escalate',
      answer: null,
      confidence: o.confidence ?? 0,
      reason,
      intent: o.intent ?? null,
      sent: false,
      costUsd: o.costUsd ?? null,
      model: o.model ?? null,
      feedback: null,
    });
    if (o.dryRun) return d;
    ctx.inbox?.upsert({
      kind: 'supervisor_escalation',
      dedupeKey: `supervisor:${sessionPk}`,
      sessionId: session.id,
      projectId: session.projectId,
      ticket: session.tickets[0] ?? null,
      reason: `Supervisor escalated: ${reason}`,
      payload: { source: session.source, id: session.id, decisionId: d.id, question: d.question, intent: d.intent, reason },
    });
    ctx.audit?.record({
      actor: 'supervisor',
      actorDetail: cfg().model,
      action: 'supervisor.escalate',
      target: sessionPk,
      params: { decisionId: d.id, reason, intent: d.intent, confidence: d.confidence },
      result: 'ok',
      error: null,
    });
    return d;
  }

  async function evaluate(sessionPk: string): Promise<SupervisorDecisionView> {
    const session = ctx.sessions.getByPk(sessionPk);
    if (!session) throw new ServiceError('not_found', 404, `session ${sessionPk} not found`);
    const live = session.live;
    if (!live || live.ownership !== 'owned' || !live.ptyId) {
      throw new ServiceError('not_owned', 403, 'the supervisor only answers sessions this app owns');
    }
    const dryRun = !enabledFor(sessionPk);
    const q = buildPendingQuestion(await lastAssistantText(session), live.waitingFor);
    if (!q) {
      return escalate(session, { text: '(no question found)', tail: '', waitingFor: live.waitingFor }, 'no pending question found', { dryRun });
    }

    const verdict = applyRules(q, {
      rules: repo.listRules(ctx.db, session.projectId),
      deny: (text) => ctx.denyList?.check(text, session.projectId) ?? { denied: false, reason: null },
    });
    if (verdict.denied) return escalate(session, q, `blocked: ${verdict.denyReason ?? 'deny-list'}`, { dryRun });
    if (!verdict.intent || !verdict.answer) return escalate(session, q, 'no allow-listed intent matched', { dryRun });
    if (inQuietHours(now(), cfg().quietHours)) return escalate(session, q, 'quiet hours', { intent: verdict.intent, dryRun });

    const since = new Date(now().getTime() - HOUR_MS).toISOString();
    if (repo.countAnswered(ctx.db, since, sessionPk) >= cfg().maxPerSessionPerHour) {
      return escalate(session, q, `per-session cap reached (${cfg().maxPerSessionPerHour}/hour)`, { intent: verdict.intent, dryRun });
    }
    if (repo.countAnswered(ctx.db, since) >= cfg().maxPerHour) {
      return escalate(session, q, `hourly cap reached (${cfg().maxPerHour}/hour)`, { intent: verdict.intent, dryRun });
    }
    const spent = repo.monthCost(ctx.db, monthStartIso(now()));
    if (spent >= cfg().monthlyBudgetUsd) {
      return escalate(session, q, `supervisor budget used ($${spent.toFixed(2)} of $${cfg().monthlyBudgetUsd.toFixed(2)})`, { intent: verdict.intent, dryRun });
    }
    const projectBudget = ctx.usage?.checkBudget({ projectId: session.projectId ?? undefined });
    if (projectBudget && !projectBudget.ok) {
      return escalate(session, q, `project budget exceeded (${Math.round(projectBudget.pct * 100)}%)`, { intent: verdict.intent, dryRun });
    }

    let result: Awaited<ReturnType<Classifier>>;
    try {
      result = await classifier({
        question: q.text,
        context: `session: ${session.name ?? session.id} · last prompt: ${session.lastPrompt ?? ''}`,
        intent: verdict.intent,
        cannedAnswer: verdict.answer,
        model: cfg().model,
      });
    } catch (e) {
      return escalate(session, q, `classifier failed: ${e instanceof Error ? e.message : String(e)}`, { intent: verdict.intent, dryRun });
    }

    const { output } = result;
    if (output.decision !== 'answer' || output.confidence < cfg().confidenceThreshold) {
      return escalate(session, q, `model said ${output.decision} (confidence ${output.confidence.toFixed(2)}): ${output.reason}`, {
        intent: verdict.intent,
        confidence: output.confidence,
        costUsd: result.costUsd,
        model: result.model,
        dryRun,
      });
    }

    const fresh = ctx.sessions.getByPk(sessionPk);
    if (!fresh?.live || fresh.live.status !== 'waiting' || fresh.live.ptyId !== live.ptyId) {
      return escalate(session, q, 'the session changed while the model was thinking', {
        intent: verdict.intent,
        confidence: output.confidence,
        costUsd: result.costUsd,
        model: result.model,
        dryRun,
      });
    }

    const base = {
      sessionPk,
      projectId: session.projectId,
      question: redact(q.text),
      decision: 'answer' as const,
      answer: verdict.answer,
      confidence: output.confidence,
      intent: verdict.intent,
      costUsd: result.costUsd,
      model: result.model,
      feedback: null,
    };
    if (dryRun) return record({ ...base, sent: false, reason: `dry run (supervisor off for this session): ${output.reason}` });

    await ctx.pty.sendText(live.ptyId, verdict.answer);
    const d = record({ ...base, sent: true, reason: output.reason });
    ctx.audit?.record({
      actor: 'supervisor',
      actorDetail: result.model,
      action: 'supervisor.answer',
      target: sessionPk,
      params: {
        decisionId: d.id,
        intent: verdict.intent,
        confidence: output.confidence,
        matchedBy: verdict.matchedBy,
        question: d.question.slice(-300),
        answer: verdict.answer,
        costUsd: result.costUsd,
      },
      result: 'ok',
      error: null,
    });
    ctx.inbox?.resolve(`waiting:${sessionPk}`);
    return d;
  }

  function addRule(r: SupervisorRuleInput, source: SupervisorRule['source'] = 'user'): SupervisorRule {
    const rule = repo.insertRule(ctx.db, { ...r, source }, now().toISOString());
    ctx.audit?.record({
      actor: 'user',
      actorDetail: null,
      action: 'supervisor.rule',
      target: `supervisor-rule:${rule.id}`,
      params: { op: 'add', kind: rule.kind, pattern: rule.pattern, intent: rule.intent, source },
      result: 'ok',
      error: null,
    });
    return rule;
  }

  return {
    evaluate,
    enabledFor,
    start() {
      const off = ctx.bus.on('session.statusChanged', (e) => {
        const existing = timers.get(e.pk);
        if (existing) {
          clearTimeout(existing);
          timers.delete(e.pk);
        }
        if (e.to !== 'waiting' || !enabledFor(e.pk)) return;
        const timer = setTimeout(() => {
          timers.delete(e.pk);
          void evaluate(e.pk).catch((err: unknown) => ctx.log.warn({ err, pk: e.pk }, 'supervisor evaluation failed'));
        }, cfg().debounceMs);
        timer.unref?.();
        timers.set(e.pk, timer);
      });
      return () => {
        off();
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
      };
    },
    setTarget(t) {
      const saved = repo.setTarget(ctx.db, t, now().toISOString());
      ctx.audit?.record({
        actor: 'user',
        actorDetail: null,
        action: 'settings.update',
        target: `supervisor:${t.targetType}:${t.targetId}`,
        params: { enabled: t.enabled },
        result: 'ok',
        error: null,
      });
      return saved;
    },
    targets: () => repo.listTargets(ctx.db),
    rules: () => repo.listAllRules(ctx.db),
    addRule: (r) => addRule(r),
    removeRule(id) {
      const removed = repo.deleteRule(ctx.db, id);
      if (removed) {
        ctx.audit?.record({ actor: 'user', actorDetail: null, action: 'supervisor.rule', target: `supervisor-rule:${id}`, params: { op: 'remove' }, result: 'ok', error: null });
      }
      return removed;
    },
    decisions: (q) => repo.listDecisions(ctx.db, q),
    feedbackWrong(decisionId) {
      const d = repo.getDecision(ctx.db, decisionId);
      if (!d) throw new ServiceError('not_found', 404, `supervisor decision ${decisionId} not found`);
      repo.markFeedback(ctx.db, decisionId, 'wrong');
      const rule = addRule(
        {
          projectId: d.projectId,
          kind: 'deny',
          pattern: feedbackPattern(d.question),
          intent: null,
          answer: null,
          note: `marked wrong on ${now().toISOString()}`,
        },
        'feedback',
      );
      ctx.audit?.record({
        actor: 'user',
        actorDetail: null,
        action: 'supervisor.feedback',
        target: d.sessionPk,
        params: { decisionId, ruleId: rule.id },
        result: 'ok',
        error: null,
      });
      return rule;
    },
    status() {
      const c = cfg();
      const since = new Date(now().getTime() - HOUR_MS).toISOString();
      return {
        enabled: c.enabled,
        quiet: inQuietHours(now(), c.quietHours),
        model: c.model,
        confidenceThreshold: c.confidenceThreshold,
        maxPerSessionPerHour: c.maxPerSessionPerHour,
        maxPerHour: c.maxPerHour,
        quietHours: c.quietHours,
        answeredLastHour: repo.countAnswered(ctx.db, since),
        escalatedLastHour: repo.countEscalated(ctx.db, since),
        monthCostUsd: repo.monthCost(ctx.db, monthStartIso(now())),
        monthBudgetUsd: c.monthlyBudgetUsd,
      };
    },
  };
}
```
`feedbackWrong` stores the deny rule under the decision's project, so the same question still answers automatically in other projects. P3's `withPtyInputAudit` also records a `pty.input` entry for the text the supervisor sends; the `supervisor.answer` entry is the one that carries the reasoning, the confidence and the decision id.

- [ ] **Step 3: Wire it into the daemon**

`apps/daemon/src/context.ts`: `supervisor?: SupervisorImpl;` (import the type from `./services/supervisor/supervisor.ts`; it is a superset of contracts §11 `Supervisor`).

`apps/daemon/src/main.ts`, inside the Phase 7 block:
```ts
  // ── Phase 7C: supervisor ─────────────────────────────────────────────
  const supervisor = createSupervisor({ ctx });
  ctx.supervisor = supervisor;
  p7Stops.push(supervisor.start());
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/test/p7/supervisor-service.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/daemon/src/services/supervisor apps/daemon/src/context.ts apps/daemon/src/main.ts apps/daemon/test/p7/supervisor-service.test.ts
git commit -m "feat(supervisor): answer allow-listed questions within caps and escalate everything else"
```

---

### Task 18: Supervisor routes, settings UI and decisions log

**Files:**
- Create: `apps/daemon/src/http/routes/supervisor.ts`, `apps/web/src/api/queries/supervisor.ts`, `apps/web/src/features/supervisor/SupervisorSettings.tsx`, `DecisionsLog.tsx`, `SupervisorToggle.tsx`
- Modify: `apps/daemon/src/http/app.ts`, `apps/daemon/src/http/audit-middleware.ts` (`NON_ACTION_ROUTES`), `apps/web/src/features/settings/SettingsPage.tsx`, `apps/web/src/features/session-detail/SessionHeader.tsx`, `apps/web/src/api/live-events.ts`
- Test: `apps/daemon/test/p7/supervisor-routes.test.ts`, `apps/web/src/features/supervisor/SupervisorSettings.test.tsx`

**Interfaces:**
- Consumes: `SupervisorImpl` (Task 17); `SupervisorApi` (Task 14); `readJson`, `createApp`, `ServiceError` (P1); `need`, `requireConfirmed`, `ConfirmBody`, `API_BASE`, `TEST_TOKEN` (Task 1); `ctx.updateConfig` (P2); `getApiClient`, `setApiClientForTests` (P1); `renderWithClient`, `fakeApi` (P2).
- Produces:
  ```ts
  export function registerSupervisorRoutes(app: OrcApp, ctx: DaemonContext): void
  // api/queries/supervisor.ts
  export const supervisorKeys: { status: readonly ['supervisor-status']; targets: readonly ['supervisor-targets']; rules: readonly ['supervisor-rules']; decisions(sessionPk?: string): readonly ['supervisor-decisions', string] }
  export function useSupervisorStatus(): UseQueryResult<SupervisorStatus>
  export function useSupervisorSettings(): UseMutationResult<SupervisorStatus, Error, SupervisorSettingsPatch>
  export function useSupervisorTargets(): UseQueryResult<SupervisorTarget[]>
  export function useSetSupervisorTarget(): UseMutationResult<SupervisorTarget, Error, SupervisorTarget>
  export function useSupervisorRules(): UseQueryResult<SupervisorRule[]>
  export function useAddSupervisorRule(): UseMutationResult<SupervisorRule, Error, SupervisorRuleInput>
  export function useDeleteSupervisorRule(): UseMutationResult<{ ok: true }, Error, string>
  export function useSupervisorDecisions(sessionPk?: string): UseQueryResult<SupervisorDecisionView[]>
  export function useMarkDecisionWrong(sessionPk?: string): UseMutationResult<SupervisorRule, Error, string>
  // components
  export function SupervisorSettings(): JSX.Element
  export function DecisionsLog(p: { sessionPk?: string; limit?: number }): JSX.Element
  export function SupervisorToggle(p: { session: Session }): JSX.Element
  ```

- [ ] **Step 1: Write the failing route test**

`apps/daemon/test/p7/supervisor-routes.test.ts`
```ts
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.ts';
import { API_BASE, TEST_TOKEN } from '../../src/http/p7-guard.ts';
import { createSupervisor } from '../../src/services/supervisor/supervisor.ts';
import { createTestContext, type TestContext } from '../helpers.ts';
import {
  createFakePty,
  fakeAudit,
  fakeDenyList,
  fakeInbox,
  fakeProjects,
  fakeSessions,
  fakeUsage,
  makeLive,
  makeSession,
  testConfig,
} from '../fakes/phase7.ts';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

function setup(withService = true) {
  let cfg = testConfig({ supervisor: { enabled: true } });
  const pty = createFakePty();
  ctx = createTestContext({
    config: () => cfg,
    updateConfig: (fn) => {
      cfg = OrcConfig.parse(fn(cfg));
      return cfg;
    },
    projects: fakeProjects(cfg),
    pty,
    inbox: fakeInbox(),
    audit: fakeAudit(),
    usage: fakeUsage(),
    denyList: fakeDenyList(),
    sessions: fakeSessions([makeSession({ id: 's1', live: makeLive({ status: 'waiting', ptyId: 'pty-1' }) })]),
  });
  if (withService) {
    ctx.supervisor = createSupervisor({
      ctx,
      lastAssistantText: async () => 'Should I continue?',
      classifier: async (i) => ({ output: { decision: 'answer', answer: 'ok', confidence: 0.95, reason: 'routine' }, costUsd: 0.001, model: i.model, durationMs: 5 }),
    });
  }
  const app = createApp({ ctx, token: TEST_TOKEN, port: () => 4317, env: {} });
  const call = (path: string, method = 'GET', body?: unknown) =>
    app.request(`${API_BASE}${path}`, {
      method,
      headers: { 'x-orc-token': TEST_TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call, pty, getCfg: () => cfg };
}

describe('/api/supervisor', () => {
  it('reports status and patches the settings', async () => {
    const t = setup();
    expect(await (await t.call('/api/supervisor/status')).json()).toMatchObject({ enabled: true, answeredLastHour: 0, quiet: false });
    const patched = await t.call('/api/supervisor/settings', 'PATCH', { enabled: false, confidenceThreshold: 0.95, quietHours: { start: '22:00', end: '08:00' } });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ enabled: false, confidenceThreshold: 0.95, quiet: expect.any(Boolean) });
    expect(t.getCfg().supervisor.quietHours).toEqual({ start: '22:00', end: '08:00' });
    expect((await t.call('/api/supervisor/settings', 'PATCH', { confidenceThreshold: 5 })).status).toBe(400);
  });

  it('manages targets and rules', async () => {
    const t = setup();
    const target = await t.call('/api/supervisor/targets', 'PUT', { targetType: 'project', targetId: 'wakecap', enabled: true });
    expect(await target.json()).toEqual({ targetType: 'project', targetId: 'wakecap', enabled: true });
    expect((await (await t.call('/api/supervisor/targets')).json() as unknown[]).length).toBe(1);

    const rule = (await (await t.call('/api/supervisor/rules', 'POST', { kind: 'allow', pattern: 'ship it\\?$', intent: 'continue', answer: 'Yes, ship it.' })).json()) as { id: string };
    expect((await (await t.call('/api/supervisor/rules')).json() as unknown[]).length).toBe(1);
    expect((await t.call(`/api/supervisor/rules/${rule.id}`, 'DELETE', {})).status).toBe(409);
    expect((await t.call(`/api/supervisor/rules/${rule.id}`, 'DELETE', { confirm: true })).status).toBe(200);
    expect((await t.call('/api/supervisor/rules/missing', 'DELETE', { confirm: true })).status).toBe(404);
  });

  it('evaluates a session, lists decisions and takes feedback', async () => {
    const t = setup();
    await t.call('/api/supervisor/targets', 'PUT', { targetType: 'project', targetId: 'wakecap', enabled: true });
    const decision = (await (await t.call('/api/supervisor/evaluate/claude/s1', 'POST', {})).json()) as { id: string; decision: string };
    expect(decision.decision).toBe('answer');
    expect(t.pty.sent).toHaveLength(1);
    const list = (await (await t.call('/api/supervisor/decisions?sessionPk=claude:s1&limit=10')).json()) as unknown[];
    expect(list).toHaveLength(1);
    const rule = (await (await t.call(`/api/supervisor/decisions/${decision.id}/wrong`, 'POST', {})).json()) as { kind: string; source: string };
    expect(rule).toMatchObject({ kind: 'deny', source: 'feedback' });
    expect((await t.call('/api/supervisor/decisions/nope/wrong', 'POST', {})).status).toBe(404);
    expect((await t.call('/api/supervisor/evaluate/claude/missing', 'POST', {})).status).toBe(404);
  });

  it('answers 409 not_enabled without the service', async () => {
    const t = setup(false);
    const res = await t.call('/api/supervisor/status');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_enabled');
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p7/supervisor-routes.test.ts`
Expected: FAIL (404 `no such route`)

- [ ] **Step 2: Implement the routes**

`apps/daemon/src/http/routes/supervisor.ts`
```ts
import { SupervisorDecisionQuery, SupervisorRuleInput, SupervisorSettingsPatch, SupervisorTarget } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { sessionPk } from '../../services/sessions.ts';
import { ServiceError } from '../../services/errors.ts';
import { readJson } from '../json.ts';
import { ConfirmBody, need, requireConfirmed } from '../p7-guard.ts';
import type { OrcApp } from '../types.ts';

export function registerSupervisorRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.supervisor, 'supervisor');
  const base = '/api/supervisor';

  app.get(`${base}/status`, (c) => c.json(svc().status()));

  app.patch(`${base}/settings`, async (c) => {
    const patch = await readJson(c, SupervisorSettingsPatch);
    const s = svc();
    const updateConfig = need(ctx.updateConfig, 'config updates');
    updateConfig((cfg) => ({ ...cfg, supervisor: { ...cfg.supervisor, ...patch } }));
    ctx.audit?.record({
      actor: 'user',
      actorDetail: null,
      action: 'settings.update',
      target: 'config:supervisor',
      params: patch,
      result: 'ok',
      error: null,
    });
    return c.json(s.status());
  });

  app.get(`${base}/targets`, (c) => c.json(svc().targets()));
  app.put(`${base}/targets`, async (c) => {
    const t = await readJson(c, SupervisorTarget);
    return c.json(svc().setTarget(t));
  });

  app.get(`${base}/rules`, (c) => c.json(svc().rules()));
  app.post(`${base}/rules`, async (c) => {
    const r = await readJson(c, SupervisorRuleInput);
    return c.json(svc().addRule(r), 201);
  });
  app.delete(`${base}/rules/:id`, async (c) => {
    const body = await readJson(c, ConfirmBody);
    const id = c.req.param('id');
    const s = svc();
    const rule = s.rules().find((x) => x.id === id);
    if (!rule) throw new ServiceError('not_found', 404, `supervisor rule ${id} not found`);
    requireConfirmed(body, `Delete the supervisor ${rule.kind} rule "${rule.pattern}"`);
    s.removeRule(id);
    return c.json({ ok: true as const });
  });

  app.get(`${base}/decisions`, (c) => {
    const s = svc();
    const q = SupervisorDecisionQuery.parse(c.req.query());
    return c.json(s.decisions(q));
  });
  app.post(`${base}/decisions/:id/wrong`, (c) => c.json(svc().feedbackWrong(c.req.param('id'))));

  app.post(`${base}/evaluate/:source/:id`, async (c) => {
    const source = c.req.param('source');
    if (source !== 'claude' && source !== 'codex' && source !== 'agnc') {
      throw new ServiceError('validation_failed', 400, `unknown source ${source}`);
    }
    return c.json(await svc().evaluate(sessionPk(source, c.req.param('id'))));
  });
}
```
`app.patch` resolves `svc()` first, so a missing service gives 409 `not_enabled` before the config is touched.

`apps/daemon/src/http/app.ts`: import and call `registerSupervisorRoutes(app, o.ctx);` next to the other Phase 7 registrations.

`apps/daemon/src/http/audit-middleware.ts` — add to `NON_ACTION_ROUTES`:
```ts
  { method: 'PATCH', path: '/api/supervisor/settings', why: 'the handler records settings.update' },
  { method: 'PUT', path: '/api/supervisor/targets', why: 'Supervisor.setTarget records settings.update' },
  { method: 'POST', path: '/api/supervisor/rules', why: 'Supervisor.addRule records supervisor.rule' },
  { method: 'DELETE', path: '/api/supervisor/rules/:id', why: 'Supervisor.removeRule records supervisor.rule' },
  { method: 'POST', path: '/api/supervisor/decisions/:id/wrong', why: 'Supervisor.feedbackWrong records supervisor.feedback' },
  { method: 'POST', path: '/api/supervisor/evaluate/:source/:id', why: 'Supervisor.evaluate records supervisor.answer or supervisor.escalate' },
```

Run: `pnpm vitest run apps/daemon/test/p7/supervisor-routes.test.ts apps/daemon/test/audit.coverage.test.ts`
Expected: PASS (routes 4 tests; the coverage test stays green)

- [ ] **Step 3: Write the failing UI test**

`apps/web/src/features/supervisor/SupervisorSettings.test.tsx`
```tsx
import type { SupervisorDecisionView, SupervisorStatus, SupervisorTarget } from '@orc/api-contract';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '@/api/client.ts';
import { fakeApi, makeSession, renderWithClient } from '@/test/query.tsx';
import { DecisionsLog } from './DecisionsLog.tsx';
import { SupervisorSettings } from './SupervisorSettings.tsx';
import { SupervisorToggle } from './SupervisorToggle.tsx';

const status: SupervisorStatus = {
  enabled: true, quiet: false, model: 'claude-haiku-4-5', confidenceThreshold: 0.85, maxPerSessionPerHour: 3,
  maxPerHour: 10, quietHours: null, answeredLastHour: 2, escalatedLastHour: 1, monthCostUsd: 0.42, monthBudgetUsd: 5,
};

const decision: SupervisorDecisionView = {
  id: 'd1', sessionPk: 'claude:s1', projectId: 'wakecap', question: 'Should I continue?', decision: 'answer',
  answer: 'Yes, continue.', confidence: 0.93, reason: 'routine continue', intent: 'continue', sent: true,
  costUsd: 0.002, model: 'claude-haiku-4-5', feedback: null, ts: '2026-09-18T09:00:00.000Z',
};

afterEach(() => setApiClientForTests(null));

function api(over: Record<string, unknown> = {}) {
  const stubs = {
    supervisorStatus: vi.fn(async () => status),
    supervisorSettings: vi.fn(async () => ({ ...status, enabled: false })),
    supervisorTargets: vi.fn(async (): Promise<SupervisorTarget[]> => [{ targetType: 'project', targetId: 'wakecap', enabled: true }]),
    supervisorSetTarget: vi.fn(async (t: SupervisorTarget) => t),
    supervisorRules: vi.fn(async () => []),
    supervisorAddRule: vi.fn(),
    supervisorDeleteRule: vi.fn(),
    supervisorDecisions: vi.fn(async () => [decision]),
    supervisorMarkWrong: vi.fn(async () => ({ id: 'r1', projectId: null, kind: 'deny' as const, pattern: 'should\\s+i', intent: null, answer: null, source: 'feedback' as const, enabled: true, note: null, createdAt: 't' })),
    projectsList: vi.fn(async () => [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: ['/x'], hidden: false, lastActivityAt: null, sessionCount: 0 }]),
    ...over,
  };
  setApiClientForTests(fakeApi(stubs));
  return stubs;
}

describe('SupervisorSettings', () => {
  it('shows the status and turns the supervisor off', async () => {
    const stubs = api();
    renderWithClient(<SupervisorSettings />);
    expect(await screen.findByText(/2 answered · 1 escalated in the last hour/)).toBeTruthy();
    expect(screen.getByText('$0.42 of $5.00 this month')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Supervisor enabled' }));
    await waitFor(() => expect(stubs.supervisorSettings).toHaveBeenCalledWith({ enabled: false }));
    fireEvent.change(screen.getByLabelText('Confidence threshold'), { target: { value: '0.9' } });
    fireEvent.blur(screen.getByLabelText('Confidence threshold'));
    await waitFor(() => expect(stubs.supervisorSettings).toHaveBeenCalledWith({ confidenceThreshold: 0.9 }));
  });

  it('turns the supervisor on for a project', async () => {
    const stubs = api();
    renderWithClient(<SupervisorSettings />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Supervisor for Wakecap' }));
    await waitFor(() => expect(stubs.supervisorSetTarget).toHaveBeenCalledWith({ targetType: 'project', targetId: 'wakecap', enabled: false }));
  });
});

describe('DecisionsLog', () => {
  it('lists decisions and reports a wrong answer', async () => {
    const stubs = api();
    renderWithClient(<DecisionsLog sessionPk="claude:s1" />);
    expect(await screen.findByText('Should I continue?')).toBeTruthy();
    expect(screen.getByText('answered · 93%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'That was wrong' }));
    await waitFor(() => expect(stubs.supervisorMarkWrong).toHaveBeenCalledWith('d1'));
    expect(await screen.findByText(/added a deny rule/i)).toBeTruthy();
  });
});

describe('SupervisorToggle', () => {
  it('switches the supervisor for one session', async () => {
    const stubs = api();
    renderWithClient(<SupervisorToggle session={makeSession({ id: 's1', live: { ownership: 'owned', ptyId: 'pty-1', status: 'waiting' } })} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Supervisor for this session' }));
    await waitFor(() => expect(stubs.supervisorSetTarget).toHaveBeenCalledWith({ targetType: 'session', targetId: 'claude:s1', enabled: true }));
  });
});
```

Run: `pnpm vitest run apps/web/src/features/supervisor`
Expected: FAIL, `Cannot find module './SupervisorSettings.tsx'`

- [ ] **Step 4: Implement the hooks and the components**

`apps/web/src/api/queries/supervisor.ts`
```ts
import type { SupervisorRuleInput, SupervisorSettingsPatch, SupervisorTarget } from '@orc/api-contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '@/api/client.ts';

export const supervisorKeys = {
  status: ['supervisor-status'] as const,
  targets: ['supervisor-targets'] as const,
  rules: ['supervisor-rules'] as const,
  decisions: (sessionPk?: string) => ['supervisor-decisions', sessionPk ?? 'all'] as const,
};

export function useSupervisorStatus() {
  return useQuery({ queryKey: supervisorKeys.status, queryFn: () => getApiClient().supervisorStatus() });
}

export function useSupervisorSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SupervisorSettingsPatch) => getApiClient().supervisorSettings(patch),
    onSuccess: (s) => qc.setQueryData(supervisorKeys.status, s),
  });
}

export function useSupervisorTargets() {
  return useQuery({ queryKey: supervisorKeys.targets, queryFn: () => getApiClient().supervisorTargets() });
}

export function useSetSupervisorTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (t: SupervisorTarget) => getApiClient().supervisorSetTarget(t),
    onSuccess: () => qc.invalidateQueries({ queryKey: supervisorKeys.targets }),
  });
}

export function useSupervisorRules() {
  return useQuery({ queryKey: supervisorKeys.rules, queryFn: () => getApiClient().supervisorRules() });
}

export function useAddSupervisorRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (r: SupervisorRuleInput) => getApiClient().supervisorAddRule(r),
    onSuccess: () => qc.invalidateQueries({ queryKey: supervisorKeys.rules }),
  });
}

export function useDeleteSupervisorRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApiClient().supervisorDeleteRule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: supervisorKeys.rules }),
  });
}

export function useSupervisorDecisions(sessionPk?: string) {
  return useQuery({
    queryKey: supervisorKeys.decisions(sessionPk),
    queryFn: () => getApiClient().supervisorDecisions({ sessionPk, limit: 50 }),
  });
}

export function useMarkDecisionWrong(sessionPk?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApiClient().supervisorMarkWrong(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: supervisorKeys.decisions(sessionPk) });
      void qc.invalidateQueries({ queryKey: supervisorKeys.rules });
    },
  });
}
```
In `apps/web/src/api/live-events.ts`, add:
```ts
    case 'supervisor.decided':
      void qc.invalidateQueries({ queryKey: ['supervisor-decisions'] });
      void qc.invalidateQueries({ queryKey: ['supervisor-status'] });
      return;
```

`apps/web/src/features/supervisor/SupervisorSettings.tsx`
```tsx
import { useProjects } from '@/api/queries/projects.ts';
import {
  useSetSupervisorTarget,
  useSupervisorSettings,
  useSupervisorStatus,
  useSupervisorTargets,
} from '@/api/queries/supervisor.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { DecisionsLog } from './DecisionsLog.tsx';

const usd = (n: number) => `$${n.toFixed(2)}`;

export function SupervisorSettings() {
  const status = useSupervisorStatus();
  const save = useSupervisorSettings();
  const targets = useSupervisorTargets();
  const setTarget = useSetSupervisorTarget();
  const { data: projects = [] } = useProjects();
  const s = status.data;
  const isOn = (projectId: string) =>
    targets.data?.find((t) => t.targetType === 'project' && t.targetId === projectId)?.enabled ?? false;

  return (
    <section className="flex flex-col gap-3" aria-label="Supervisor">
      <h2 className="text-base font-semibold">Supervisor (opt-in)</h2>
      <p className="text-sm text-muted-foreground">
        Answers only allow-listed routine questions ("continue", "run the tests", "proceed with the approved plan", "retry") in sessions this app owns.
        Everything else goes to the inbox. It never merges, deploys or touches production, and every decision is audited.
      </p>
      {!s ? <p className="text-sm">Loading…</p> : null}
      {s ? (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox aria-label="Supervisor enabled" checked={s.enabled} onCheckedChange={(v) => save.mutate({ enabled: v })} />
              Supervisor enabled
            </label>
            {s.quiet ? <Badge variant="secondary">quiet hours</Badge> : null}
            <span className="text-muted-foreground">
              {s.answeredLastHour} answered · {s.escalatedLastHour} escalated in the last hour
            </span>
            <span className="text-muted-foreground">
              {usd(s.monthCostUsd)} of {usd(s.monthBudgetUsd)} this month
            </span>
          </div>
          <div className="grid max-w-xl grid-cols-2 gap-3 text-sm">
            <label className="flex flex-col gap-1" htmlFor="sup-threshold">
              Confidence threshold
              <Input
                id="sup-threshold"
                type="number"
                min={0}
                max={1}
                step={0.05}
                defaultValue={s.confidenceThreshold}
                onBlur={(e) => save.mutate({ confidenceThreshold: Number(e.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-1" htmlFor="sup-model">
              Classifier model
              <Input id="sup-model" defaultValue={s.model} onBlur={(e) => save.mutate({ model: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1" htmlFor="sup-session-cap">
              Answers per session per hour
              <Input id="sup-session-cap" type="number" min={0} defaultValue={s.maxPerSessionPerHour} onBlur={(e) => save.mutate({ maxPerSessionPerHour: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-1" htmlFor="sup-hour-cap">
              Answers per hour
              <Input id="sup-hour-cap" type="number" min={0} defaultValue={s.maxPerHour} onBlur={(e) => save.mutate({ maxPerHour: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-1" htmlFor="sup-budget">
              Monthly budget (USD)
              <Input id="sup-budget" type="number" min={0} step={0.5} defaultValue={s.monthBudgetUsd} onBlur={(e) => save.mutate({ monthlyBudgetUsd: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-1" htmlFor="sup-quiet">
              Quiet hours (start–end, empty for none)
              <Input
                id="sup-quiet"
                defaultValue={s.quietHours ? `${s.quietHours.start}-${s.quietHours.end}` : ''}
                placeholder="22:00-08:00"
                onBlur={(e) => {
                  const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(e.target.value.trim());
                  save.mutate({ quietHours: m?.[1] && m[2] ? { start: m[1], end: m[2] } : null });
                }}
              />
            </label>
          </div>
          <fieldset className="flex flex-col gap-1 rounded border p-3 text-sm">
            <legend className="px-1">Projects</legend>
            {projects.map((p) => (
              <label key={p.id} className="flex items-center gap-2">
                <Checkbox aria-label={`Supervisor for ${p.name}`} checked={isOn(p.id)} onCheckedChange={(v) => setTarget.mutate({ targetType: 'project', targetId: p.id, enabled: v })} />
                {p.name}
              </label>
            ))}
          </fieldset>
          <DecisionsLog limit={20} />
        </>
      ) : null}
    </section>
  );
}
```

`apps/web/src/features/supervisor/DecisionsLog.tsx`
```tsx
import { useMarkDecisionWrong, useSupervisorDecisions } from '@/api/queries/supervisor.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { formatCost, formatDateTime } from '@/lib/format.ts';

export function DecisionsLog({ sessionPk, limit = 50 }: { sessionPk?: string; limit?: number }) {
  const { data: decisions = [], isLoading } = useSupervisorDecisions(sessionPk);
  const markWrong = useMarkDecisionWrong(sessionPk);
  const rows = decisions.slice(0, limit);

  return (
    <section className="flex flex-col gap-2" aria-label="Supervisor decisions">
      <h3 className="text-sm font-semibold">Decisions</h3>
      {isLoading ? <p className="text-sm">Loading…</p> : null}
      {!isLoading && rows.length === 0 ? <p className="text-sm text-muted-foreground">No decisions yet.</p> : null}
      {markWrong.data ? <p className="text-xs text-muted-foreground">Thanks — added a deny rule, so this question escalates from now on.</p> : null}
      <ul className="flex flex-col gap-2">
        {rows.map((d) => (
          <li key={d.id} className="rounded border p-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={d.decision === 'answer' ? (d.sent ? 'success' : 'secondary') : 'outline'}>
                {d.decision === 'answer' ? (d.sent ? 'answered' : 'dry run') : 'escalated'} · {Math.round(d.confidence * 100)}%
              </Badge>
              <span className="text-xs text-muted-foreground">{formatDateTime(d.ts)}</span>
              <span className="text-xs text-muted-foreground">{d.sessionPk}</span>
              <span className="text-xs text-muted-foreground">{formatCost(d.costUsd)}</span>
              {d.feedback === 'wrong' ? <Badge variant="destructive">marked wrong</Badge> : null}
              {d.sent ? (
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => markWrong.mutate(d.id)} disabled={d.feedback === 'wrong'}>
                  That was wrong
                </Button>
              ) : null}
            </div>
            <p className="whitespace-pre-wrap text-xs">{d.question}</p>
            <p className="text-xs text-muted-foreground">
              {d.answer ? `→ ${d.answer} · ` : ''}
              {d.reason}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

`apps/web/src/features/supervisor/SupervisorToggle.tsx`
```tsx
import type { Session } from '@orc/core';
import { useSetSupervisorTarget, useSupervisorStatus, useSupervisorTargets } from '@/api/queries/supervisor.ts';
import { Checkbox } from '@/components/ui/checkbox.tsx';

export function SupervisorToggle({ session }: { session: Session }) {
  const status = useSupervisorStatus();
  const targets = useSupervisorTargets();
  const setTarget = useSetSupervisorTarget();
  const owned = session.live?.ownership === 'owned' && session.live.ptyId !== null;
  if (!owned) return null;
  const pk = `${session.source}:${session.id}`;
  const sessionTarget = targets.data?.find((t) => t.targetType === 'session' && t.targetId === pk);
  const projectTarget = session.projectId
    ? targets.data?.find((t) => t.targetType === 'project' && t.targetId === session.projectId)
    : undefined;
  const enabled = sessionTarget?.enabled ?? projectTarget?.enabled ?? false;

  return (
    <label className="flex items-center gap-1 text-xs" title={status.data?.enabled ? 'The supervisor may answer routine questions here' : 'The supervisor is turned off in Settings'}>
      <Checkbox
        aria-label="Supervisor for this session"
        checked={enabled}
        onCheckedChange={(v) => setTarget.mutate({ targetType: 'session', targetId: pk, enabled: v })}
      />
      Supervisor
    </label>
  );
}
```

Mount both:
- `apps/web/src/features/settings/SettingsPage.tsx`: `import { SupervisorSettings } from '@/features/supervisor/SupervisorSettings.tsx';` and render `<SupervisorSettings />` as a new section.
- `apps/web/src/features/session-detail/SessionHeader.tsx`: `import { SupervisorToggle } from '@/features/supervisor/SupervisorToggle.tsx';` and render `<SupervisorToggle session={session} />` next to the other header badges.

- [ ] **Step 5: Run the tests, then all checks, and commit**

Run: `pnpm vitest run apps/web/src/features/supervisor apps/daemon/test/p7`
Expected: PASS (UI 4 tests, plus every Phase 7 daemon suite)

Run: `pnpm --filter @orc/web build && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/daemon/src/http apps/web/src apps/daemon/test/p7/supervisor-routes.test.ts
git commit -m "feat(supervisor): add supervisor routes, settings UI and decisions log"
```

---

# 7D AGNC (optional, lowest priority)

> AGNC is the only part of Phase 7 that may end as a **link-out**. Nothing else depends on it. Run Task 19 first and record the decision in `plan/spikes/S4.md`; Tasks 20 and 21 have a GO branch and a NO-GO branch.

### Task 19: Spike S4 — can a local app talk to AGNC over MCP + OAuth?

**Files:**
- Create: `spikes/s4-agnc/package.json`, `spikes/s4-agnc/probe.ts`, `plan/spikes/S4.md`

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk@^1.30.0` (`Client`, `StreamableHTTPClientTransport`, `OAuthClientProvider`, `UnauthorizedError`), AGNC at `https://agnc.wakecap.ai/mcp`.
- Produces: `plan/spikes/S4.md` with a **GO / NO-GO** decision plus the recorded response shapes that Task 20's zod normalisers use. The spike writes its tokens to `spikes/s4-agnc/out/oauth.json` (mode 0600, already gitignored by `spikes/**/out/`), never to the repo or to `$ORC_HOME`.

- [ ] **Step 1: Create the spike package**

`spikes/s4-agnc/package.json`
```json
{
  "name": "spike-s4-agnc",
  "private": true,
  "type": "module",
  "dependencies": { "@modelcontextprotocol/sdk": "^1.30.0" },
  "devDependencies": { "tsx": "^4.23.13" }
}
```
Run: `cd spikes/s4-agnc && npm install --no-save && cd -`
Expected: installs outside the pnpm workspace, like the Phase 0 spikes.

- [ ] **Step 2: Write the probe (read-only; prints shapes, never contents)**

`spikes/s4-agnc/probe.ts`
```ts
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { type OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

const URL_ = process.env.AGNC_URL ?? 'https://agnc.wakecap.ai/mcp';
const PORT = 4318;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const OUT = fileURLToPath(new URL('./out/', import.meta.url));
mkdirSync(OUT, { recursive: true, mode: 0o700 });
const STORE = join(OUT, 'oauth.json');

type Saved = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens };
const load = (): Saved => (existsSync(STORE) ? (JSON.parse(readFileSync(STORE, 'utf8')) as Saved) : {});
const save = (patch: Saved) => writeFileSync(STORE, JSON.stringify({ ...load(), ...patch }, null, 2), { mode: 0o600 });

let verifier = '';
const state = Math.random().toString(36).slice(2);
const provider: OAuthClientProvider = {
  get redirectUrl() {
    return REDIRECT;
  },
  get clientMetadata() {
    return {
      client_name: 'Orchestrator (spike S4)',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  },
  state: () => state,
  clientInformation: () => load().client,
  saveClientInformation: (client) => save({ client }),
  tokens: () => load().tokens,
  saveTokens: (tokens) => save({ tokens }),
  redirectToAuthorization: (url) => {
    console.log('\nAuthorise here:\n', url.toString(), '\n');
    execFile('open', [url.toString()], () => {});
  },
  saveCodeVerifier: (v) => {
    verifier = v;
  },
  codeVerifier: () => verifier,
};

function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
      const code = u.searchParams.get('code');
      const got = u.searchParams.get('state');
      res.end(code ? 'S4: authorised. You can close this tab.' : 'S4: missing code');
      if (!code) return;
      server.close();
      if (got !== state) reject(new Error(`state mismatch: ${got}`));
      else resolve(code);
    });
    server.listen(PORT, '127.0.0.1');
    setTimeout(() => {
      server.close();
      reject(new Error('timed out waiting for the OAuth callback'));
    }, 180_000).unref();
  });
}

/** Keys and value types only — never values. */
function shape(v: unknown, depth = 0): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) return depth > 3 ? 'array' : [shape(v[0], depth + 1), `…${v.length} items`];
  if (typeof v === 'object') {
    if (depth > 3) return 'object';
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, shape(val, depth + 1)]));
  }
  return typeof v;
}

async function connect(): Promise<Client> {
  const make = () => {
    const transport = new StreamableHTTPClientTransport(new URL(URL_), { authProvider: provider });
    return { transport, client: new Client({ name: 'orc-spike-s4', version: '0.0.0' }) };
  };
  const first = make();
  try {
    await first.client.connect(first.transport);
    return first.client;
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
    const code = await waitForCode();
    await first.transport.finishAuth(code);
    const second = make();
    await second.client.connect(second.transport);
    return second.client;
  }
}

const textOf = (r: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown }): unknown => {
  if (r.structuredContent !== undefined) return r.structuredContent;
  const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const t0 = Date.now();
const client = await connect();
const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name));

const auth = await client.callTool({ name: 'agnc_auth_status', arguments: {} });
console.log('agnc_auth_status shape:', JSON.stringify(shape(textOf(auth)), null, 2));

const list = await client.callTool({ name: 'agnc_list_sessions', arguments: { scope: 'mine', limit: 5 } });
const listed = textOf(list);
console.log('agnc_list_sessions shape:', JSON.stringify(shape(listed), null, 2));

const first = (Array.isArray(listed) ? listed[0] : (listed as { sessions?: unknown[] })?.sessions?.[0]) as
  | { id?: string; sessionId?: string }
  | undefined;
const sessionId = first?.id ?? first?.sessionId;
if (sessionId) {
  for (const [name, args] of [
    ['agnc_get_session', { sessionId }],
    ['agnc_list_messages', { sessionId, limit: 3 }],
    ['agnc_list_events', { sessionId, limit: 3 }],
  ] as const) {
    const r = await client.callTool({ name, arguments: args });
    console.log(`${name} shape:`, JSON.stringify(shape(textOf(r)), null, 2));
  }
} else {
  console.log('no sessions of mine; detail shapes not captured');
}
console.log('tokens expire_in:', load().tokens?.expires_in ?? 'unknown', 'ms total:', Date.now() - t0);
await client.close();
```

- [ ] **Step 3: Run it**

Run: `cd spikes/s4-agnc && npx tsx probe.ts 2>&1 | tee out/s4.log`
Expected: either the tool list plus the four shapes, or a clear blocker (no dynamic client registration, redirect URI rejected, 403 for a non-browser client, …).

- [ ] **Step 4: Check that the token survives a restart**

Run: `cd spikes/s4-agnc && npx tsx probe.ts | head -5`
Expected: it connects **without** opening the browser (the stored token or refresh token is enough). Record whether a refresh happened.

- [ ] **Step 5: Write the report**

`plan/spikes/S4.md`
```markdown
# S4 — AGNC over MCP from a local app
Date: <run date> · SDK: @modelcontextprotocol/sdk 1.30.0 · endpoint: https://agnc.wakecap.ai/mcp

| Question | Result |
|---|---|
| a. Does dynamic client registration work (or is a client id needed)? | … |
| b. Is `http://127.0.0.1:4318/callback` accepted as a redirect URI? | … |
| c. Does `agnc_list_sessions { scope: 'mine' }` work? | … (n sessions) |
| d. Do `agnc_get_session` / `list_messages` / `list_events` work? | … |
| e. Does the token survive a restart (refresh, no browser)? | … |
| f. Round-trip latency for list_sessions | … ms |

## Response shapes (keys and types only)
<paste the four shapes; Task 20's normalisers are written against these>

## Decision
**GO** when a, c and e hold (b may be replaced by a different loopback port, and d may be partial).
**NO-GO** otherwise: Phase 7 ships only the link-out card (Task 20 Step "NO-GO"), `agnc.enabled` stays false, and this file records the blocker.
```

- [ ] **Step 6: Commit**

```bash
git add spikes/s4-agnc/package.json spikes/s4-agnc/probe.ts plan/spikes/S4.md
git commit -m "chore(spike): S4 AGNC MCP OAuth probe and decision"
```

---

### Task 20: AGNC connector (MCP + OAuth) and session collector

**Files:**
- Create: `packages/api-contract/src/routes/agnc.ts`, `packages/api-contract/src/clients/agnc.ts`, `apps/daemon/src/connectors/agnc/oauth-provider.ts`, `apps/daemon/src/connectors/agnc/normalize.ts`, `apps/daemon/src/collectors/agnc/agnc-collector.ts`
- Modify (replace the Task 1 stub): `apps/daemon/src/connectors/agnc/agnc.ts`
- Modify: `packages/api-contract/src/clients/phase7.ts`, `packages/api-contract/src/index.ts`, `packages/api-contract/src/routes/p7-placeholders.ts` (delete the AGNC lines; delete the file and its index export once it is empty), `apps/daemon/src/main.ts`
- Test: `apps/daemon/test/p7/agnc-connector.test.ts`, `apps/daemon/test/fakes/agnc-server.ts`

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk` (`Client`, `StreamableHTTPClientTransport`, `OAuthClientProvider`, `UnauthorizedError`, `InMemoryTransport`, `McpServer`); `createSecretStore` / `createMemorySecretStore` (P6); `upsertSession` (P1 repo); `ctx.bus.emit('session.updated')` (P2); `Session`, `LiveStatus` (§4); the shapes recorded in `plan/spikes/S4.md`.
- Produces:
  ```ts
  // @orc/api-contract routes/agnc.ts
  AgncSession, AgncMessage, AgncEvent, AgncStatus, AgncPromptBody, AgncHandoffBody, AgncEventPage   // zod + types
  // clients/agnc.ts
  export interface AgncApi {
    agncStatus(): Promise<AgncStatus>;
    agncConnect(): Promise<{ authorizationUrl: string | null }>;
    agncMessages(id: string): Promise<AgncMessage[]>;
    agncEvents(id: string, cursor?: string): Promise<AgncEventPage>;
    agncPrompt(id: string, body: { prompt: string; model?: string }): Promise<{ ok: true }>;
    agncHandoff(body: { source: 'claude' | 'codex'; id: string; repoOwner?: string; repoName?: string; baseBranch?: string; model?: string }): Promise<AgncSession>;
  }
  export function agncClient(call: ApiCall): AgncApi
  // connectors/agnc/normalize.ts
  export function toolPayload(result: unknown): unknown            // structuredContent, else parsed text content
  export function pickArray(value: unknown, keys: readonly string[]): unknown[]
  export function normalizeSession(raw: unknown): AgncSession | null
  export function normalizeMessage(raw: unknown): AgncMessage | null
  export function normalizeEvent(raw: unknown): AgncEvent | null
  // connectors/agnc/oauth-provider.ts
  export interface KeyringOAuthProvider extends OAuthClientProvider { state(): string; pendingAuthorizationUrl(): string | null; clear(): Promise<void> }
  export function createKeyringOAuthProvider(o: { secrets: SecretStore; redirectUrl: string; clientName?: string }): KeyringOAuthProvider
  // connectors/agnc/agnc.ts
  export interface AgncClientPair { client: Client; transport: Transport & { finishAuth?(code: string): Promise<void> } }
  export type AgncClientFactory = () => AgncClientPair
  export function createStreamableFactory(o: { url: string; provider: OAuthClientProvider }): AgncClientFactory
  export function createAgncConnector(deps: { factory: AgncClientFactory; log: Logger; state?: () => string }): AgncConnector
  // collectors/agnc/agnc-collector.ts
  export function agncToSession(a: AgncSession, projectId: string | null): Session
  export function createAgncCollector(deps: { ctx: DaemonContext; agnc: AgncConnector; intervalMs?: number; upsert?: (s: Session) => void }): { tick(): Promise<number>; start(): () => void }
  ```
  Scope: **only my sessions** (`agnc_list_sessions { scope: 'mine' }`, decision #4 in `docs/05-roadmap.md`). AGNC sessions are stored with `source: 'agnc'`, `availability: 'remote'` and, while they are active, `live.ownership: 'observed'` with `ptyId: null`, so the "input only to owned sessions" rule keeps the PTY paths away from them. Tokens live in the Keychain via `SecretStore` under `agnc.client` and `agnc.tokens`.

- [ ] **Step 1 (NO-GO branch): stop here and ship the link-out**

If `plan/spikes/S4.md` says NO-GO, skip Steps 2–7 and do only this:
1. Create `apps/web/src/features/agnc/AgncLinkCard.tsx`:
```tsx
import { Badge } from '@/components/ui/badge.tsx';
import { Card } from '@/components/ui/card.tsx';

export function AgncLinkCard({ reason }: { reason: string }) {
  return (
    <Card className="flex flex-col gap-1 p-3 text-sm" aria-label="AGNC">
      <div className="flex items-center gap-2">
        <span className="font-medium">AGNC</span>
        <Badge variant="outline">not connected</Badge>
      </div>
      <p className="text-xs text-muted-foreground">{reason}</p>
      <a className="text-xs underline" href="https://agnc.wakecap.ai" target="_blank" rel="noreferrer">
        Open AGNC in the browser
      </a>
    </Card>
  );
}
```
2. Render it in `SettingsPage.tsx` with the blocker from the spike report as `reason`.
3. Leave `agnc.enabled` at `false`, keep the Task 1 stub interface, and mark Tasks 20–21 "skipped (S4 NO-GO)" in the exit checklist.
4. Commit: `git commit -m "feat(web): link out to AGNC (S4 no-go)"` and continue with Task 22.

- [ ] **Step 2: Write the schemas and the client (GO branch)**

`packages/api-contract/src/routes/agnc.ts`
```ts
import { z } from 'zod';

export const AgncSession = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  branch: z.string().nullable(),
  prUrl: z.string().nullable(),
  url: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type AgncSession = z.infer<typeof AgncSession>;

export const AgncMessage = z.object({
  id: z.string(),
  role: z.string(),
  status: z.string().nullable(),
  text: z.string(),
  createdAt: z.string().nullable(),
});
export type AgncMessage = z.infer<typeof AgncMessage>;

export const AgncEvent = z.object({
  id: z.string(),
  type: z.string(),
  messageId: z.string().nullable(),
  text: z.string().nullable(),
  createdAt: z.string().nullable(),
});
export type AgncEvent = z.infer<typeof AgncEvent>;

export const AgncEventPage = z.object({ items: z.array(AgncEvent), nextCursor: z.string().nullable() });
export type AgncEventPage = z.infer<typeof AgncEventPage>;

export const AgncStatus = z.object({
  enabled: z.boolean(),
  status: z.enum(['ok', 'unauthenticated', 'error', 'disabled']),
  url: z.string(),
  sessions: z.number().int(),
});
export type AgncStatus = z.infer<typeof AgncStatus>;

export const AgncPromptBody = z.object({
  prompt: z.string().min(1).max(20000),
  model: z.string().min(1).optional(),
  confirm: z.boolean().optional(),
});
export const AgncHandoffBody = z.object({
  source: z.enum(['claude', 'codex']),
  id: z.string().min(1),
  repoOwner: z.string().min(1).optional(),
  repoName: z.string().min(1).optional(),
  baseBranch: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  confirm: z.boolean().optional(),
});
```

`packages/api-contract/src/clients/agnc.ts`
```ts
import { z } from 'zod';
import { AgncEventPage, AgncMessage, AgncSession, AgncStatus } from '../routes/agnc.ts';
import type { ApiCall } from './phase7.ts';

export interface AgncApi {
  agncStatus(): Promise<AgncStatus>;
  agncConnect(): Promise<{ authorizationUrl: string | null }>;
  agncMessages(id: string): Promise<AgncMessage[]>;
  agncEvents(id: string, cursor?: string): Promise<AgncEventPage>;
  agncPrompt(id: string, body: { prompt: string; model?: string }): Promise<{ ok: true }>;
  agncHandoff(body: { source: 'claude' | 'codex'; id: string; repoOwner?: string; repoName?: string; baseBranch?: string; model?: string }): Promise<AgncSession>;
}

const Connect = z.object({ authorizationUrl: z.string().nullable() });
const Ok = z.object({ ok: z.literal(true) });

export function agncClient(call: ApiCall): AgncApi {
  const s = (id: string) => `/api/agnc/sessions/${encodeURIComponent(id)}`;
  return {
    agncStatus: () => call(AgncStatus, 'GET', '/api/connectors/agnc/status'),
    agncConnect: () => call(Connect, 'POST', '/api/connectors/agnc/connect', {}),
    agncMessages: (id) => call(z.array(AgncMessage), 'GET', `${s(id)}/messages`),
    agncEvents: (id, cursor) => call(AgncEventPage, 'GET', `${s(id)}/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
    agncPrompt: (id, body) => call(Ok, 'POST', `${s(id)}/prompt`, { ...body, confirm: true }),
    agncHandoff: (body) => call(AgncSession, 'POST', '/api/agnc/handoff', { ...body, confirm: true }),
  };
}
```
Wire them into `clients/phase7.ts` (`& AgncApi`, `...agncClient(call)`) and `index.ts`, and delete the AGNC placeholders.

- [ ] **Step 3: Write the fake AGNC server and the failing test**

`apps/daemon/test/fakes/agnc-server.ts`
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import type { AgncClientPair } from '../../src/connectors/agnc/agnc.ts';

export interface FakeAgncState {
  sessions: Array<Record<string, unknown>>;
  messages: Record<string, Array<Record<string, unknown>>>;
  events: Record<string, Array<Record<string, unknown>>>;
  prompts: Array<{ sessionId: string; prompt: string; model?: string }>;
  created: Array<Record<string, unknown>>;
  failNext?: string;
}

export function makeFakeAgncState(): FakeAgncState {
  return {
    sessions: [
      {
        session_id: 'ag-1',
        name: 'SAF-1787 weekend SLA',
        state: 'running',
        repository: { owner: 'example-org', name: 'wecare-service' },
        branch: 'agnc/saf-1787',
        pull_request_url: 'https://github.com/example-org/wecare-service/pull/9',
        created_at: '2026-09-18T08:00:00.000Z',
        updated_at: '2026-09-18T09:00:00.000Z',
      },
      { id: 'ag-2', title: 'Docs sweep', status: 'completed', updatedAt: '2026-09-18T07:00:00.000Z' },
    ],
    messages: { 'ag-1': [{ id: 'm1', role: 'user', text: 'fix the SLA', created_at: '2026-09-18T08:00:00.000Z' }] },
    events: { 'ag-1': [{ id: 'e1', type: 'tool_call', message_id: 'm1', text: 'ran tests' }] },
    prompts: [],
    created: [],
  };
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });

/** One fresh in-memory server+client pair per call, shaped like the real AGNC tools. */
export function fakeAgncFactory(state: FakeAgncState): () => AgncClientPair {
  return () => {
    const server = new McpServer({ name: 'fake-agnc', version: '0.0.0' });
    server.registerTool('agnc_auth_status', { description: 'auth' }, async () => text({ user: 'me', scopes: ['sessions'] }));
    server.registerTool(
      'agnc_list_sessions',
      { description: 'list', inputSchema: { scope: z.string().optional(), limit: z.number().optional() } },
      async ({ scope }) => {
        if (state.failNext === 'agnc_list_sessions') {
          state.failNext = undefined;
          throw new Error('upstream exploded');
        }
        return text({ sessions: scope === 'mine' ? state.sessions : [] });
      },
    );
    server.registerTool('agnc_get_session', { description: 'get', inputSchema: { sessionId: z.string() } }, async ({ sessionId }) =>
      text(state.sessions.find((s) => (s.session_id ?? s.id) === sessionId) ?? null),
    );
    server.registerTool('agnc_list_messages', { description: 'messages', inputSchema: { sessionId: z.string(), limit: z.number().optional() } }, async ({ sessionId }) =>
      text({ messages: state.messages[sessionId] ?? [] }),
    );
    server.registerTool('agnc_list_events', { description: 'events', inputSchema: { sessionId: z.string(), cursor: z.string().optional(), limit: z.number().optional() } }, async ({ sessionId }) =>
      text({ events: state.events[sessionId] ?? [], nextCursor: 'cur-2' }),
    );
    server.registerTool('agnc_send_prompt', { description: 'prompt', inputSchema: { sessionId: z.string(), prompt: z.string(), model: z.string().optional() } }, async (args) => {
      state.prompts.push({ sessionId: args.sessionId, prompt: args.prompt, model: args.model });
      return text({ ok: true });
    });
    server.registerTool(
      'agnc_create_session',
      { description: 'create', inputSchema: { repoOwner: z.string(), repoName: z.string(), initialPrompt: z.string().optional(), title: z.string().optional(), baseBranch: z.string().optional(), model: z.string().optional() } },
      async (args) => {
        const created = { id: `ag-${state.created.length + 3}`, title: args.title ?? null, status: 'queued', repository: { owner: args.repoOwner, name: args.repoName } };
        state.created.push({ ...args });
        state.sessions.push(created);
        return text(created);
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    void server.connect(serverTransport);
    return { client: new Client({ name: 'orc-test', version: '0.0.0' }), transport: clientTransport };
  };
}
```

`apps/daemon/test/p7/agnc-connector.test.ts`
```ts
import type { AgncSession } from '@orc/api-contract';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgncConnector } from '../../src/connectors/agnc/agnc.ts';
import { normalizeSession, pickArray, toolPayload } from '../../src/connectors/agnc/normalize.ts';
import { agncToSession, createAgncCollector } from '../../src/collectors/agnc/agnc-collector.ts';
import { createTestContext, type TestContext } from '../helpers.ts';
import { fakeAgncFactory, makeFakeAgncState } from '../fakes/agnc-server.ts';
import { fakeProjects, testConfig } from '../fakes/phase7.ts';

const log = pino({ level: 'silent' });
let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

describe('normalisers', () => {
  it('reads the shapes recorded by spike S4 and tolerates unknown ones', () => {
    expect(toolPayload({ content: [{ type: 'text', text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(toolPayload({ structuredContent: { b: 2 } })).toEqual({ b: 2 });
    expect(toolPayload({ content: [{ type: 'text', text: 'plain' }] })).toBe('plain');
    expect(pickArray({ sessions: [1, 2] }, ['sessions', 'items'])).toEqual([1, 2]);
    expect(pickArray([3], ['sessions'])).toEqual([3]);
    expect(pickArray(null, ['sessions'])).toEqual([]);
    expect(normalizeSession({ session_id: 'x', name: 'T', state: 'running', repository: { owner: 'o', name: 'r' } })).toEqual({
      id: 'x', title: 'T', status: 'running', repoOwner: 'o', repoName: 'r', branch: null, prUrl: null, url: null, createdAt: null, updatedAt: null,
    });
    expect(normalizeSession({ nope: true })).toBeNull();
  });
});

describe('AgncConnector', () => {
  it('lists my sessions, reads detail and sends prompts', async () => {
    const state = makeFakeAgncState();
    const agnc = createAgncConnector({ factory: fakeAgncFactory(state), log });
    expect(await agnc.status()).toBe('ok');
    const sessions = await agnc.listMySessions();
    expect(sessions.map((s) => [s.id, s.title, s.status])).toEqual([
      ['ag-1', 'SAF-1787 weekend SLA', 'running'],
      ['ag-2', 'Docs sweep', 'completed'],
    ]);
    expect(sessions[0]).toMatchObject({ repoOwner: 'example-org', repoName: 'wecare-service', prUrl: 'https://github.com/example-org/wecare-service/pull/9' });
    expect((await agnc.getSession('ag-1'))?.branch).toBe('agnc/saf-1787');
    expect((await agnc.listMessages('ag-1')).map((m) => m.text)).toEqual(['fix the SLA']);
    const events = await agnc.listEvents('ag-1');
    expect(events).toEqual({ items: [{ id: 'e1', type: 'tool_call', messageId: 'm1', text: 'ran tests', createdAt: null }], nextCursor: 'cur-2' });
    await agnc.sendPrompt('ag-1', 'keep going', 'claude-sonnet-5');
    expect(state.prompts).toEqual([{ sessionId: 'ag-1', prompt: 'keep going', model: 'claude-sonnet-5' }]);
    const created = await agnc.createSession({ repoOwner: 'example-org', repoName: 'wecare-service', initialPrompt: 'handoff', title: 'Handoff' });
    expect(created.id).toBe('ag-3');
    expect(state.created[0]).toMatchObject({ repoOwner: 'example-org', initialPrompt: 'handoff' });
    await agnc.disconnect();
  });

  it('reports errors instead of throwing from status()', async () => {
    const state = makeFakeAgncState();
    state.failNext = 'agnc_list_sessions';
    const agnc = createAgncConnector({ factory: fakeAgncFactory(state), log });
    await expect(agnc.listMySessions()).rejects.toThrow(/upstream/);
    expect(await agnc.status()).toBe('ok');
  });
});

describe('agnc collector', () => {
  it('maps AGNC sessions into remote sessions and upserts them', async () => {
    const cfg = testConfig({ agnc: { enabled: true } });
    ctx = createTestContext({ config: () => cfg, projects: fakeProjects(cfg) });
    const upserted: Array<{ id: string; status: string | null }> = [];
    const events: string[] = [];
    ctx.bus.on('session.updated', (e) => events.push(e.session.id));
    const agnc = createAgncConnector({ factory: fakeAgncFactory(makeFakeAgncState()), log });
    const collector = createAgncCollector({
      ctx,
      agnc,
      upsert: (s) => upserted.push({ id: s.id, status: s.live?.status ?? null }),
    });
    expect(await collector.tick()).toBe(2);
    expect(upserted).toEqual([
      { id: 'ag-1', status: 'busy' },
      { id: 'ag-2', status: null },
    ]);
    expect(events).toEqual(['ag-1', 'ag-2']);
  });

  it('maps every AGNC status to a live status', () => {
    const base: AgncSession = { id: 'x', title: null, status: 'running', repoOwner: null, repoName: null, branch: null, prUrl: null, url: null, createdAt: null, updatedAt: null };
    const statusOf = (status: string) => agncToSession({ ...base, status }, 'wakecap').live?.status ?? null;
    expect(statusOf('running')).toBe('busy');
    expect(statusOf('queued')).toBe('busy');
    expect(statusOf('waiting_for_input')).toBe('waiting');
    expect(statusOf('failed')).toBe('error');
    expect(statusOf('completed')).toBeNull();
    const s = agncToSession(base, 'wakecap');
    expect(s).toMatchObject({ source: 'agnc', availability: 'remote', projectId: 'wakecap' });
    expect(s.live).toMatchObject({ ownership: 'observed', ptyId: null, pid: null });
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p7/agnc-connector.test.ts`
Expected: FAIL, `Cannot find module '../../src/connectors/agnc/normalize.ts'`

- [ ] **Step 4: Implement the normalisers**

`apps/daemon/src/connectors/agnc/normalize.ts`
```ts
import type { AgncEvent, AgncMessage, AgncSession } from '@orc/api-contract';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

const firstString = (o: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const k of keys) {
    const v = str(o[k]);
    if (v !== null) return v;
  }
  return null;
};

/** MCP tool results carry either structuredContent or a JSON string in a text block. */
export function toolPayload(result: unknown): unknown {
  if (!isObj(result)) return null;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlock = content.find((c) => isObj(c) && c.type === 'text');
  const text = isObj(textBlock) ? str(textBlock.text) : null;
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function pickArray(value: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isObj(value)) return [];
  for (const k of keys) {
    const v = value[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

export function normalizeSession(raw: unknown): AgncSession | null {
  if (!isObj(raw)) return null;
  const id = firstString(raw, ['id', 'sessionId', 'session_id']);
  if (!id) return null;
  const repo = isObj(raw.repository) ? raw.repository : {};
  return {
    id,
    title: firstString(raw, ['title', 'name', 'summary']),
    status: firstString(raw, ['status', 'state', 'phase']) ?? 'unknown',
    repoOwner: firstString(raw, ['repoOwner', 'repo_owner', 'owner']) ?? firstString(repo, ['owner', 'login']),
    repoName: firstString(raw, ['repoName', 'repo_name', 'repo']) ?? firstString(repo, ['name']),
    branch: firstString(raw, ['branch', 'headBranch', 'head_branch', 'baseBranch', 'base_branch']),
    prUrl: firstString(raw, ['prUrl', 'pr_url', 'pullRequestUrl', 'pull_request_url']),
    url: firstString(raw, ['url', 'webUrl', 'web_url', 'htmlUrl']),
    createdAt: firstString(raw, ['createdAt', 'created_at']),
    updatedAt: firstString(raw, ['updatedAt', 'updated_at']),
  };
}

export function normalizeMessage(raw: unknown): AgncMessage | null {
  if (!isObj(raw)) return null;
  const id = firstString(raw, ['id', 'messageId', 'message_id']);
  if (!id) return null;
  const content = raw.content;
  const text =
    firstString(raw, ['text', 'content', 'body']) ??
    (Array.isArray(content)
      ? content
          .map((c) => (isObj(c) ? (str(c.text) ?? '') : ''))
          .filter(Boolean)
          .join('\n')
      : '');
  return {
    id,
    role: firstString(raw, ['role', 'author', 'sender']) ?? 'assistant',
    status: firstString(raw, ['status', 'state']),
    text,
    createdAt: firstString(raw, ['createdAt', 'created_at']),
  };
}

export function normalizeEvent(raw: unknown): AgncEvent | null {
  if (!isObj(raw)) return null;
  const id = firstString(raw, ['id', 'eventId', 'event_id']);
  if (!id) return null;
  return {
    id,
    type: firstString(raw, ['type', 'kind', 'name']) ?? 'event',
    messageId: firstString(raw, ['messageId', 'message_id']),
    text: firstString(raw, ['text', 'detail', 'message', 'summary']),
    createdAt: firstString(raw, ['createdAt', 'created_at', 'ts']),
  };
}
```
Adjust the key lists to the shapes recorded in `plan/spikes/S4.md` if they differ; the fake server in the test uses two different spellings on purpose.

- [ ] **Step 5: Implement the OAuth provider and the connector**

`apps/daemon/src/connectors/agnc/oauth-provider.ts`
```ts
import { randomBytes } from 'node:crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SecretStore } from '../../services/secrets/secret-store.ts';

export const AGNC_CLIENT_KEY = 'agnc.client';
export const AGNC_TOKENS_KEY = 'agnc.tokens';

export interface KeyringOAuthProvider extends OAuthClientProvider {
  state(): string;
  pendingAuthorizationUrl(): string | null;
  clear(): Promise<void>;
}

/** Stores the OAuth client registration and tokens in the macOS Keychain through SecretStore. */
export function createKeyringOAuthProvider(o: {
  secrets: SecretStore;
  redirectUrl: string;
  clientName?: string;
}): KeyringOAuthProvider {
  let verifier = '';
  let pending: string | null = null;
  let stateValue = randomBytes(16).toString('hex');

  const readJson = async <T>(key: string): Promise<T | undefined> => {
    const raw = await o.secrets.get(key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  };

  return {
    get redirectUrl() {
      return o.redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: o.clientName ?? 'Orchestrator',
        redirect_uris: [o.redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    state() {
      return stateValue;
    },
    clientInformation: () => readJson<OAuthClientInformationMixed>(AGNC_CLIENT_KEY),
    saveClientInformation: async (client) => o.secrets.set(AGNC_CLIENT_KEY, JSON.stringify(client)),
    tokens: () => readJson<OAuthTokens>(AGNC_TOKENS_KEY),
    saveTokens: async (tokens) => o.secrets.set(AGNC_TOKENS_KEY, JSON.stringify(tokens)),
    redirectToAuthorization: (url) => {
      pending = url.toString();
    },
    saveCodeVerifier: (v) => {
      verifier = v;
    },
    codeVerifier: () => verifier,
    pendingAuthorizationUrl: () => pending,
    async clear() {
      pending = null;
      stateValue = randomBytes(16).toString('hex');
      await o.secrets.delete(AGNC_CLIENT_KEY);
      await o.secrets.delete(AGNC_TOKENS_KEY);
    },
  };
}
```

`apps/daemon/src/connectors/agnc/agnc.ts` (replaces the Task 1 stub; keep the `AgncConnector` interface exactly as it was)
```ts
import type { AgncEvent, AgncEventPage, AgncMessage, AgncSession } from '@orc/api-contract';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { type OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Logger } from 'pino';
import { ServiceError } from '../../services/errors.ts';
import { normalizeEvent, normalizeMessage, normalizeSession, pickArray, toolPayload } from './normalize.ts';

export interface AgncConnector {
  status(): Promise<'ok' | 'unauthenticated' | 'error'>;
  beginAuth(): Promise<{ authorizationUrl: string | null }>;
  finishAuth(code: string, state: string): Promise<void>;
  listMySessions(): Promise<AgncSession[]>;
  getSession(id: string): Promise<AgncSession | null>;
  listMessages(id: string): Promise<AgncMessage[]>;
  listEvents(id: string, cursor?: string): Promise<AgncEventPage>;
  sendPrompt(id: string, prompt: string, model?: string): Promise<void>;
  createSession(i: { repoOwner: string; repoName: string; baseBranch?: string; title?: string; initialPrompt: string; model?: string }): Promise<AgncSession>;
  disconnect(): Promise<void>;
}

export interface AgncClientPair {
  client: Client;
  transport: Transport & { finishAuth?(code: string): Promise<void> };
}
export type AgncClientFactory = () => AgncClientPair;

export function createStreamableFactory(o: { url: string; provider: OAuthClientProvider }): AgncClientFactory {
  return () => ({
    client: new Client({ name: 'orchestrator', version: '0.7.0' }),
    transport: new StreamableHTTPClientTransport(new URL(o.url), { authProvider: o.provider }),
  });
}

export function createAgncConnector(deps: {
  factory: AgncClientFactory;
  log: Logger;
  /** OAuth state to check on the callback (from the keyring provider). */
  state?: () => string;
  /** The authorisation URL the provider captured during the failed connect. */
  pendingUrl?: () => string | null;
}): AgncConnector {
  let live: AgncClientPair | null = null;
  let pendingAuth: AgncClientPair | null = null;

  async function getClient(): Promise<Client> {
    if (live) return live.client;
    const pair = deps.factory();
    try {
      await pair.client.connect(pair.transport);
      live = pair;
      pendingAuth = null;
      return pair.client;
    } catch (e) {
      pendingAuth = pair;
      throw e;
    }
  }

  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await getClient();
    const result = await client.callTool({ name, arguments: args });
    if ((result as { isError?: boolean }).isError) {
      throw new ServiceError('upstream_error', 502, `${name} failed: ${JSON.stringify(toolPayload(result)).slice(0, 200)}`);
    }
    return toolPayload(result);
  }

  return {
    async status() {
      try {
        await call('agnc_auth_status', {});
        return 'ok';
      } catch (e) {
        if (e instanceof UnauthorizedError) return 'unauthenticated';
        deps.log.warn({ err: e }, 'agnc status failed');
        return 'error';
      }
    },

    async beginAuth() {
      try {
        await getClient();
        return { authorizationUrl: null };   // already authorised
      } catch (e) {
        if (e instanceof UnauthorizedError) return { authorizationUrl: deps.pendingUrl?.() ?? null };
        throw e;
      }
    },

    async finishAuth(code, state) {
      if (deps.state && deps.state() !== state) throw new ServiceError('invalid_state', 400, 'OAuth state mismatch');
      const transport = pendingAuth?.transport;
      if (!transport?.finishAuth) throw new ServiceError('invalid_state', 409, 'no OAuth flow in progress');
      await transport.finishAuth(code);
      pendingAuth = null;
      live = null;
      await getClient();
    },

    async listMySessions() {
      const payload = await call('agnc_list_sessions', { scope: 'mine', limit: 50 });
      return pickArray(payload, ['sessions', 'items', 'data'])
        .map(normalizeSession)
        .filter((s): s is AgncSession => s !== null);
    },

    async getSession(id) {
      return normalizeSession(await call('agnc_get_session', { sessionId: id }));
    },

    async listMessages(id) {
      const payload = await call('agnc_list_messages', { sessionId: id, limit: 100 });
      return pickArray(payload, ['messages', 'items', 'data'])
        .map(normalizeMessage)
        .filter((m): m is AgncMessage => m !== null);
    },

    async listEvents(id, cursor) {
      const payload = await call('agnc_list_events', { sessionId: id, limit: 100, ...(cursor ? { cursor } : {}) });
      const items = pickArray(payload, ['events', 'items', 'data'])
        .map(normalizeEvent)
        .filter((e): e is AgncEvent => e !== null);
      const next =
        typeof payload === 'object' && payload !== null && 'nextCursor' in payload
          ? ((payload as { nextCursor?: unknown }).nextCursor ?? null)
          : null;
      return { items, nextCursor: typeof next === 'string' ? next : null };
    },

    async sendPrompt(id, prompt, model) {
      await call('agnc_send_prompt', { sessionId: id, prompt, ...(model ? { model } : {}) });
    },

    async createSession(i) {
      const created = normalizeSession(await call('agnc_create_session', { ...i }));
      if (!created) throw new ServiceError('upstream_error', 502, 'agnc_create_session returned no session');
      return created;
    },

    async disconnect() {
      await live?.client.close().catch(() => {});
      live = null;
      pendingAuth = null;
    },
  };
}
```
`main.ts` (Task 21) builds the connector with `state: () => provider.state()` and `pendingUrl: () => provider.pendingAuthorizationUrl()`, so the HTTP layer can hand the URL to the browser and check the `state` on the callback.

- [ ] **Step 6: Implement the collector**

`apps/daemon/src/collectors/agnc/agnc-collector.ts`
```ts
import type { AgncSession } from '@orc/api-contract';
import { emptyUsage, type LiveStatus, type Session } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { upsertSession } from '../../db/repos/sessions.ts';
import type { AgncConnector } from '../../connectors/agnc/agnc.ts';

const BUSY = new Set(['running', 'in_progress', 'queued', 'pending', 'starting']);
const WAITING = new Set(['waiting', 'waiting_for_input', 'needs_input', 'blocked', 'awaiting_review']);
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled']);

function liveStatusFor(status: string): LiveStatus | null {
  const s = status.toLowerCase();
  if (BUSY.has(s)) return 'busy';
  if (WAITING.has(s)) return 'waiting';
  if (FAILED.has(s)) return 'error';
  return null; // completed / done / unknown → not live
}

export function agncToSession(a: AgncSession, projectId: string | null): Session {
  const live = liveStatusFor(a.status);
  const updatedAt = a.updatedAt ?? a.createdAt ?? new Date(0).toISOString();
  return {
    id: a.id,
    source: 'agnc',
    projectId,
    startCwd: a.repoOwner && a.repoName ? `agnc://${a.repoOwner}/${a.repoName}` : 'agnc://remote',
    cwds: [],
    name: a.title,
    firstPrompt: null,
    lastPrompt: null,
    awaySummary: null,
    recap: null,
    startedAt: a.createdAt ?? updatedAt,
    lastActivityAt: updatedAt,
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
    availability: 'remote',
    transcriptPath: null,
    lastTest: null,
    live: live === null ? null : { pid: null, status: live, waitingFor: null, since: updatedAt, ownership: 'observed', ptyId: null, stage: null, currentTool: null, backgroundJobs: 0, runningSubagents: 0, contextFill: null },
  };
}

export function createAgncCollector(deps: {
  ctx: DaemonContext;
  agnc: AgncConnector;
  intervalMs?: number;
  upsert?: (s: Session) => void;
}): { tick(): Promise<number>; start(): () => void } {
  const { ctx } = deps;
  const upsert = deps.upsert ?? ((s: Session) => upsertSession(ctx.db, s));

  const tick = async (): Promise<number> => {
    const remote = await deps.agnc.listMySessions();
    for (const a of remote) {
      const session = agncToSession(a, ctx.config().defaultProjectId);
      upsert(session);
      ctx.bus.emit({ type: 'session.updated', session });
    }
    return remote.length;
  };

  return {
    tick,
    start() {
      if (!ctx.config().agnc.enabled) return () => {};
      const run = () => void tick().catch((err: unknown) => ctx.log.warn({ err }, 'agnc poll failed'));
      run();
      const timer = setInterval(run, deps.intervalMs ?? ctx.config().agnc.pollSeconds * 1000);
      return () => clearInterval(timer);
    },
  };
}
```
AGNC sessions carry a PR link in `prUrl`; Task 21's UI shows it. They are never added to `prs`, because that array is a `PrRef` list parsed from Claude transcripts.

- [ ] **Step 7: Run the tests, then all checks, and commit**

Run: `pnpm vitest run apps/daemon/test/p7/agnc-connector.test.ts`
Expected: PASS (normalisers 1, connector 2, collector 2)

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add packages/api-contract apps/daemon/src/connectors/agnc apps/daemon/src/collectors/agnc apps/daemon/test/fakes/agnc-server.ts apps/daemon/test/p7/agnc-connector.test.ts
git commit -m "feat(agnc): add the MCP connector, OAuth storage and remote session collector"
```

---

### Task 21: AGNC routes, composer, handoff and UI

**Files:**
- Create: `apps/daemon/src/http/routes/agnc.ts`, `apps/web/src/api/queries/agnc.ts`, `apps/web/src/features/agnc/AgncConnectCard.tsx`, `AgncSessionPanel.tsx`, `HandoffToAgncButton.tsx`
- Modify: `apps/daemon/src/http/app.ts`, `apps/daemon/src/http/audit-middleware.ts`, `apps/daemon/src/main.ts`, `apps/web/src/features/settings/SettingsPage.tsx`, `apps/web/src/features/session-detail/SessionHeader.tsx`
- Test: `apps/daemon/test/p7/agnc-routes.test.ts`, `apps/web/src/features/agnc/AgncSessionPanel.test.tsx`

**Interfaces:**
- Consumes: `AgncConnector` (Task 20); `ctx.handoffs` (P5 `HandoffService.generate/toMarkdown/latest`); `remoteSlug` (Task 1); `ctx.sessions` (P1); `readJson`, `createApp`, `ServiceError` (P1); `need`, `requireConfirmed` (Task 1); `AgncApi` (Task 20).
- Produces:
  ```ts
  export function registerAgncRoutes(app: OrcApp, ctx: DaemonContext): void        // /api/connectors/agnc/*, /api/agnc/*
  export function registerAgncOAuthRoute(app: OrcApp, ctx: DaemonContext): void    // GET /oauth/agnc/callback (no token; checks state)
  // web
  export function useAgncStatus(): UseQueryResult<AgncStatus>
  export function useAgncConnect(): UseMutationResult<{ authorizationUrl: string | null }, Error, void>
  export function useAgncMessages(id: string): UseQueryResult<AgncMessage[]>
  export function useAgncEvents(id: string): UseQueryResult<AgncEventPage>
  export function useAgncPrompt(id: string): UseMutationResult<{ ok: true }, Error, { prompt: string; model?: string }>
  export function useAgncHandoff(): UseMutationResult<AgncSession, Error, { source: 'claude' | 'codex'; id: string; repoOwner?: string; repoName?: string }>
  export function AgncConnectCard(): JSX.Element
  export function AgncSessionPanel(p: { session: Session }): JSX.Element
  export function HandoffToAgncButton(p: { session: Session; confirm?: (m: string) => boolean }): JSX.Element
  ```
  `POST /api/agnc/sessions/:id/prompt` is the only write path into AGNC; it needs `confirm: true` and is audited as `agnc.prompt`. `POST /api/agnc/handoff` generates the P5 handoff markdown, creates an AGNC session with it as the initial prompt and audits `agnc.create`. Neither path touches a local PTY, so the "owned sessions only" rule is unaffected.

- [ ] **Step 1: Write the failing route test**

`apps/daemon/test/p7/agnc-routes.test.ts`
```ts
import type { AgncSession } from '@orc/api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgncConnector } from '../../src/connectors/agnc/agnc.ts';
import { createApp } from '../../src/http/app.ts';
import { API_BASE, TEST_TOKEN } from '../../src/http/p7-guard.ts';
import type { HandoffService } from '../../src/services/handoff/handoff.ts';
import { createTestContext, type TestContext } from '../helpers.ts';
import { fakeAudit, fakeProjects, fakeSessions, makeSession, testConfig } from '../fakes/phase7.ts';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

const remote: AgncSession = {
  id: 'ag-1', title: 'SAF-1787', status: 'running', repoOwner: 'example-org', repoName: 'wecare-service',
  branch: 'agnc/saf', prUrl: null, url: null, createdAt: null, updatedAt: '2026-09-18T09:00:00.000Z',
};

function setup(o: { withConnector?: boolean } = {}) {
  const cfg = testConfig({ agnc: { enabled: true } });
  const audit = fakeAudit();
  const sessions = fakeSessions([makeSession({ id: 's1', startCwd: '/repo', tickets: ['SAF-1787'] })]);
  const handoffs: HandoffService = {
    generate: async (pk) => ({ id: 'h1', sessionId: pk, status: 'in progress', summary: 'weekend SLA', evidence: [], files: ['a.ts'], nextSteps: ['add tests'], blockers: [], links: [], createdAt: '2026-09-18T09:00:00.000Z' }),
    toMarkdown: (h) => `# Handoff\n${h.summary}`,
    latest: () => null,
  };
  const agnc = {
    status: vi.fn(async () => 'ok' as const),
    beginAuth: vi.fn(async () => ({ authorizationUrl: 'https://agnc.wakecap.ai/authorize?state=abc' })),
    finishAuth: vi.fn(async () => {}),
    listMySessions: vi.fn(async () => [remote]),
    getSession: vi.fn(async () => remote),
    listMessages: vi.fn(async () => [{ id: 'm1', role: 'user', status: null, text: 'fix it', createdAt: null }]),
    listEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
    sendPrompt: vi.fn(async () => {}),
    createSession: vi.fn(async () => ({ ...remote, id: 'ag-new' })),
    disconnect: vi.fn(async () => {}),
  } satisfies AgncConnector;
  ctx = createTestContext({ config: () => cfg, projects: fakeProjects(cfg), audit, sessions, handoffs });
  if (o.withConnector !== false) ctx.agnc = agnc;
  const app = createApp({ ctx, token: TEST_TOKEN, port: () => 4317, env: {} });
  const call = (path: string, method = 'GET', body?: unknown) =>
    app.request(`${API_BASE}${path}`, {
      method,
      headers: { 'x-orc-token': TEST_TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call, agnc, audit };
}

describe('/api/agnc', () => {
  it('reports status and starts the OAuth flow', async () => {
    const t = setup();
    expect(await (await t.call('/api/connectors/agnc/status')).json()).toMatchObject({ enabled: true, status: 'ok', url: 'https://agnc.wakecap.ai/mcp' });
    expect(await (await t.call('/api/connectors/agnc/connect', 'POST', {})).json()).toEqual({ authorizationUrl: 'https://agnc.wakecap.ai/authorize?state=abc' });
    expect(t.audit.entries.find((e) => e.action === 'agnc.connect')).toBeTruthy();
  });

  it('reads messages and events', async () => {
    const t = setup();
    expect((await (await t.call('/api/agnc/sessions/ag-1/messages')).json() as unknown[])).toHaveLength(1);
    expect(await (await t.call('/api/agnc/sessions/ag-1/events?cursor=c1')).json()).toEqual({ items: [], nextCursor: null });
    expect(t.agnc.listEvents).toHaveBeenCalledWith('ag-1', 'c1');
  });

  it('needs confirmation to send a prompt and audits it', async () => {
    const t = setup();
    expect((await t.call('/api/agnc/sessions/ag-1/prompt', 'POST', { prompt: 'keep going' })).status).toBe(409);
    expect(t.agnc.sendPrompt).not.toHaveBeenCalled();
    const ok = await t.call('/api/agnc/sessions/ag-1/prompt', 'POST', { prompt: 'keep going', confirm: true });
    expect(ok.status).toBe(200);
    expect(t.agnc.sendPrompt).toHaveBeenCalledWith('ag-1', 'keep going', undefined);
    expect(t.audit.entries.find((e) => e.action === 'agnc.prompt')).toMatchObject({ actor: 'user', target: 'agnc:ag-1' });
  });

  it('hands a local session off to AGNC with the handoff markdown', async () => {
    const t = setup();
    const res = await t.call('/api/agnc/handoff', 'POST', { source: 'claude', id: 's1', repoOwner: 'example-org', repoName: 'wecare-service', confirm: true });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: 'ag-new' });
    expect(t.agnc.createSession).toHaveBeenCalledWith(expect.objectContaining({ repoOwner: 'example-org', repoName: 'wecare-service', initialPrompt: expect.stringContaining('# Handoff') }));
    expect(t.audit.entries.find((e) => e.action === 'agnc.create')).toBeTruthy();
    expect((await t.call('/api/agnc/handoff', 'POST', { source: 'claude', id: 'missing', confirm: true })).status).toBe(404);
  });

  it('answers 409 not_enabled without the connector', async () => {
    const t = setup({ withConnector: false });
    expect((await t.call('/api/agnc/sessions/ag-1/messages')).status).toBe(409);
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p7/agnc-routes.test.ts`
Expected: FAIL (404 `no such route`)

- [ ] **Step 2: Implement the routes**

`apps/daemon/src/http/routes/agnc.ts`
```ts
import { AgncHandoffBody, AgncPromptBody } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import { remoteSlug } from '../../services/git/git-info.ts';
import { sessionPk } from '../../services/sessions.ts';
import { readJson } from '../json.ts';
import { need, requireConfirmed } from '../p7-guard.ts';
import type { OrcApp } from '../types.ts';

export function registerAgncRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.agnc, 'AGNC connector');

  app.get('/api/connectors/agnc/status', async (c) => {
    const cfg = ctx.config().agnc;
    if (!ctx.agnc) return c.json({ enabled: cfg.enabled, status: 'disabled' as const, url: cfg.url, sessions: 0 });
    const sessions = ctx.sessions.list({ source: 'agnc', limit: 200 }).items.length;
    return c.json({ enabled: cfg.enabled, status: await ctx.agnc.status(), url: cfg.url, sessions });
  });

  app.post('/api/connectors/agnc/connect', async (c) => {
    const res = await svc().beginAuth();
    ctx.audit?.record({
      actor: 'user',
      actorDetail: null,
      action: 'agnc.connect',
      target: ctx.config().agnc.url,
      params: { authorizationRequired: res.authorizationUrl !== null },
      result: 'ok',
      error: null,
    });
    return c.json(res);
  });

  app.get('/api/agnc/sessions/:id/messages', async (c) => c.json(await svc().listMessages(c.req.param('id'))));

  app.get('/api/agnc/sessions/:id/events', async (c) => {
    const cursor = c.req.query('cursor');
    return c.json(await svc().listEvents(c.req.param('id'), cursor));
  });

  app.post('/api/agnc/sessions/:id/prompt', async (c) => {
    const body = await readJson(c, AgncPromptBody);
    const id = c.req.param('id');
    requireConfirmed(body, `Send this prompt to AGNC session ${id}`);
    await svc().sendPrompt(id, body.prompt, body.model);
    ctx.audit?.record({
      actor: 'user',
      actorDetail: null,
      action: 'agnc.prompt',
      target: `agnc:${id}`,
      params: { model: body.model ?? null, chars: body.prompt.length },
      result: 'ok',
      error: null,
    });
    return c.json({ ok: true as const });
  });

  app.post('/api/agnc/handoff', async (c) => {
    const body = await readJson(c, AgncHandoffBody);
    const agnc = svc();
    const handoffs = need(ctx.handoffs, 'handoff service');
    const session = ctx.sessions.get(body.source, body.id);
    if (!session) throw new ServiceError('not_found', 404, `session ${body.source}:${body.id} not found`);
    requireConfirmed(body, `Create an AGNC session from the handoff of "${session.name ?? session.id}"`);

    const slug = body.repoOwner && body.repoName
      ? { owner: body.repoOwner, name: body.repoName }
      : ((await remoteSlug(session.startCwd).catch(() => null)) ?? null);
    if (!slug) throw new ServiceError('validation_failed', 400, 'could not work out the GitHub repo; pass repoOwner and repoName');

    const pk = sessionPk(body.source, body.id);
    const handoff = await handoffs.generate(pk);
    const created = await agnc.createSession({
      repoOwner: slug.owner,
      repoName: slug.name,
      baseBranch: body.baseBranch,
      title: session.name ?? `Handoff ${body.id}`,
      initialPrompt: handoffs.toMarkdown(handoff),
      model: body.model,
    });
    ctx.audit?.record({
      actor: 'user',
      actorDetail: null,
      action: 'agnc.create',
      target: `agnc:${created.id}`,
      params: { from: pk, repo: `${slug.owner}/${slug.name}`, handoffId: handoff.id },
      result: 'ok',
      error: null,
    });
    return c.json(created, 201);
  });
}

/** Public (no token): the OAuth redirect target. It only forwards the code to the connector, which checks the state. */
export function registerAgncOAuthRoute(app: OrcApp, ctx: DaemonContext): void {
  app.get('/oauth/agnc/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) return c.html('<p>AGNC: missing code or state.</p>', 400);
    try {
      await need(ctx.agnc, 'AGNC connector').finishAuth(code, state);
      return c.html('<p>AGNC connected. You can close this tab.</p>');
    } catch (e) {
      ctx.log.warn({ err: e }, 'agnc oauth callback failed');
      return c.html(`<p>AGNC authorisation failed: ${e instanceof Error ? e.message : 'unknown error'}</p>`, 400);
    }
  });
}
```
`registerAgncRoutes` and `registerAgncOAuthRoute` are both called from `createApp`. The callback path is outside `/api`, so P1's token middleware does not apply; the `state` check in `finishAuth` is what protects it. If P6 added a `PUBLIC_API_PATHS` list with a host check, add `/oauth/agnc/callback` there too.

Add to `NON_ACTION_ROUTES`:
```ts
  { method: 'POST', path: '/api/connectors/agnc/connect', why: 'the handler records agnc.connect' },
  { method: 'POST', path: '/api/agnc/sessions/:id/prompt', why: 'the handler records agnc.prompt' },
  { method: 'POST', path: '/api/agnc/handoff', why: 'the handler records agnc.create' },
```

- [ ] **Step 3: Wire it into the daemon**

In `apps/daemon/src/main.ts`, inside the Phase 7 block:
```ts
  // ── Phase 7D: AGNC (optional) ────────────────────────────────────────
  if (ctx.config().agnc.enabled) {
    const provider = createKeyringOAuthProvider({
      secrets: createSecretStore(),
      redirectUrl: `http://127.0.0.1:${port}/oauth/agnc/callback`,
      clientName: 'Orchestrator',
    });
    const agnc = createAgncConnector({
      factory: createStreamableFactory({ url: ctx.config().agnc.url, provider }),
      log: ctx.log,
      state: () => provider.state(),
      pendingUrl: () => provider.pendingAuthorizationUrl(),
    });
    ctx.agnc = agnc;
    p7Stops.push(createAgncCollector({ ctx, agnc }).start());
    p7Stops.push(() => void agnc.disconnect());
  }
```
Use whatever variable `createDaemon` already has for the port (the redirect URI must match the one registered with AGNC; the spike used 4318, so if AGNC pins that port, keep `4318` here and note it in `plan/spikes/S4.md`).

- [ ] **Step 4: Write the failing UI test**

`apps/web/src/features/agnc/AgncSessionPanel.test.tsx`
```tsx
import type { AgncMessage, AgncStatus } from '@orc/api-contract';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '@/api/client.ts';
import { fakeApi, makeSession, renderWithClient } from '@/test/query.tsx';
import { AgncConnectCard } from './AgncConnectCard.tsx';
import { AgncSessionPanel } from './AgncSessionPanel.tsx';
import { HandoffToAgncButton } from './HandoffToAgncButton.tsx';

const status: AgncStatus = { enabled: true, status: 'unauthenticated', url: 'https://agnc.wakecap.ai/mcp', sessions: 0 };
const messages: AgncMessage[] = [{ id: 'm1', role: 'user', status: null, text: 'fix the SLA', createdAt: '2026-09-18T09:00:00.000Z' }];

afterEach(() => setApiClientForTests(null));

function api(over: Record<string, unknown> = {}) {
  const stubs = {
    agncStatus: vi.fn(async () => status),
    agncConnect: vi.fn(async () => ({ authorizationUrl: 'https://agnc.wakecap.ai/authorize' })),
    agncMessages: vi.fn(async () => messages),
    agncEvents: vi.fn(async () => ({ items: [{ id: 'e1', type: 'tool_call', messageId: null, text: 'ran tests', createdAt: null }], nextCursor: null })),
    agncPrompt: vi.fn(async () => ({ ok: true as const })),
    agncHandoff: vi.fn(async () => ({ id: 'ag-new', title: null, status: 'queued', repoOwner: null, repoName: null, branch: null, prUrl: null, url: null, createdAt: null, updatedAt: null })),
    ...over,
  };
  setApiClientForTests(fakeApi(stubs));
  return stubs;
}

describe('AgncConnectCard', () => {
  it('opens the authorisation URL when connecting', async () => {
    const stubs = api();
    const open = vi.fn();
    renderWithClient(<AgncConnectCard openUrl={open} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect AGNC' }));
    await waitFor(() => expect(stubs.agncConnect).toHaveBeenCalled());
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://agnc.wakecap.ai/authorize'));
  });
});

describe('AgncSessionPanel', () => {
  it('shows messages and events and sends a prompt', async () => {
    const stubs = api();
    renderWithClient(<AgncSessionPanel session={makeSession({ id: 'ag-1', source: 'agnc', availability: 'remote', live: { status: 'busy', ownership: 'observed', ptyId: null } })} />);
    expect(await screen.findByText('fix the SLA')).toBeTruthy();
    expect(screen.getByText('ran tests')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'keep going' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to AGNC' }));
    await waitFor(() => expect(stubs.agncPrompt).toHaveBeenCalledWith('ag-1', { prompt: 'keep going' }));
  });
});

describe('HandoffToAgncButton', () => {
  it('hands off after confirmation', async () => {
    const stubs = api();
    const confirm = vi.fn(() => true);
    renderWithClient(<HandoffToAgncButton session={makeSession({ id: 's1' })} confirm={confirm} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hand off to AGNC' }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(stubs.agncHandoff).toHaveBeenCalledWith({ source: 'claude', id: 's1' }));
    expect(await screen.findByText(/ag-new/)).toBeTruthy();
  });
});
```

- [ ] **Step 5: Implement the hooks and the components**

`apps/web/src/api/queries/agnc.ts`
```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '@/api/client.ts';

export const agncKeys = {
  status: ['agnc-status'] as const,
  messages: (id: string) => ['agnc-messages', id] as const,
  events: (id: string) => ['agnc-events', id] as const,
};

export function useAgncStatus() {
  return useQuery({ queryKey: agncKeys.status, queryFn: () => getApiClient().agncStatus() });
}

export function useAgncConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => getApiClient().agncConnect(),
    onSuccess: () => qc.invalidateQueries({ queryKey: agncKeys.status }),
  });
}

export function useAgncMessages(id: string) {
  return useQuery({ queryKey: agncKeys.messages(id), queryFn: () => getApiClient().agncMessages(id), refetchInterval: 15_000 });
}

export function useAgncEvents(id: string) {
  return useQuery({ queryKey: agncKeys.events(id), queryFn: () => getApiClient().agncEvents(id), refetchInterval: 15_000 });
}

export function useAgncPrompt(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { prompt: string; model?: string }) => getApiClient().agncPrompt(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: agncKeys.messages(id) }),
  });
}

export function useAgncHandoff() {
  return useMutation({
    mutationFn: (body: { source: 'claude' | 'codex'; id: string; repoOwner?: string; repoName?: string }) =>
      getApiClient().agncHandoff(body),
  });
}
```

`apps/web/src/features/agnc/AgncConnectCard.tsx`
```tsx
import { useAgncConnect, useAgncStatus } from '@/api/queries/agnc.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';

export function AgncConnectCard({ openUrl = (u: string) => window.open(u, '_blank', 'noopener') }: { openUrl?: (url: string) => void }) {
  const status = useAgncStatus();
  const connect = useAgncConnect();
  const s = status.data;
  return (
    <Card className="flex flex-col gap-2 p-3 text-sm" aria-label="AGNC">
      <div className="flex items-center gap-2">
        <span className="font-medium">AGNC</span>
        <Badge variant={s?.status === 'ok' ? 'success' : s?.status === 'disabled' ? 'outline' : 'secondary'}>{s?.status ?? '…'}</Badge>
        {s ? <span className="text-xs text-muted-foreground">{s.sessions} remote sessions · {s.url}</span> : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Optional. AGNC sessions are read-only here apart from the prompt composer; they run remotely and never use a local terminal.
      </p>
      <div>
        <Button
          size="sm"
          disabled={connect.isPending}
          onClick={() =>
            connect.mutate(undefined, {
              onSuccess: (r) => {
                if (r.authorizationUrl) openUrl(r.authorizationUrl);
              },
            })
          }
        >
          Connect AGNC
        </Button>
      </div>
      {connect.error ? <p className="text-xs text-destructive">{connect.error.message}</p> : null}
    </Card>
  );
}
```

`apps/web/src/features/agnc/AgncSessionPanel.tsx`
```tsx
import type { Session } from '@orc/core';
import { useState } from 'react';
import { useAgncEvents, useAgncMessages, useAgncPrompt } from '@/api/queries/agnc.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';

export function AgncSessionPanel({ session }: { session: Session }) {
  const messages = useAgncMessages(session.id);
  const events = useAgncEvents(session.id);
  const prompt = useAgncPrompt(session.id);
  const [text, setText] = useState('');

  return (
    <section className="flex flex-col gap-3" aria-label="AGNC session">
      <div className="flex items-center gap-2 text-sm">
        <Badge variant="outline">remote</Badge>
        <span className="text-muted-foreground">This session runs in AGNC. Replies are sent through the AGNC API.</span>
      </div>
      <ul className="flex flex-col gap-2">
        {(messages.data ?? []).map((m) => (
          <li key={m.id} className="rounded border p-2 text-sm">
            <div className="text-xs text-muted-foreground">{m.role}{m.status ? ` · ${m.status}` : ''}</div>
            <p className="whitespace-pre-wrap">{m.text}</p>
          </li>
        ))}
      </ul>
      <details>
        <summary className="cursor-pointer text-sm">Events ({events.data?.items.length ?? 0})</summary>
        <ul className="flex flex-col gap-1 pt-1 text-xs">
          {(events.data?.items ?? []).map((e) => (
            <li key={e.id}>
              <span className="text-muted-foreground">{e.type}</span> {e.text}
            </li>
          ))}
        </ul>
      </details>
      <form
        className="flex flex-col gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          prompt.mutate({ prompt: text.trim() }, { onSuccess: () => setText('') });
        }}
      >
        <label className="text-sm" htmlFor="agnc-prompt">
          Prompt
        </label>
        <textarea
          id="agnc-prompt"
          className="min-h-20 rounded border p-2 text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div>
          <Button type="submit" size="sm" disabled={prompt.isPending || !text.trim()}>
            Send to AGNC
          </Button>
        </div>
        {prompt.error ? <p className="text-xs text-destructive">{prompt.error.message}</p> : null}
      </form>
    </section>
  );
}
```

`apps/web/src/features/agnc/HandoffToAgncButton.tsx`
```tsx
import type { Session } from '@orc/core';
import { useAgncHandoff, useAgncStatus } from '@/api/queries/agnc.ts';
import { Button } from '@/components/ui/button.tsx';

export function HandoffToAgncButton({
  session,
  confirm = (m: string) => window.confirm(m),
}: {
  session: Session;
  confirm?: (message: string) => boolean;
}) {
  const status = useAgncStatus();
  const handoff = useAgncHandoff();
  if (session.source === 'agnc' || status.data?.enabled === false) return null;
  const source = session.source === 'codex' ? 'codex' : 'claude';

  return (
    <span className="flex items-center gap-2 text-xs">
      <Button
        size="sm"
        variant="outline"
        disabled={handoff.isPending}
        onClick={() => {
          if (!confirm(`Create an AGNC session from this session's handoff ("${session.name ?? session.id}")?`)) return;
          handoff.mutate({ source, id: session.id });
        }}
      >
        Hand off to AGNC
      </Button>
      {handoff.data ? <span className="text-muted-foreground">created {handoff.data.id}</span> : null}
      {handoff.error ? <span className="text-destructive">{handoff.error.message}</span> : null}
    </span>
  );
}
```

Mount them:
- `SettingsPage.tsx`: render `<AgncConnectCard />` in the connectors section.
- `SessionHeader.tsx`: render `<HandoffToAgncButton session={session} />`, and in the session detail body render `<AgncSessionPanel session={session} />` when `session.source === 'agnc'` (instead of the transcript timeline, which does not exist for remote sessions).

- [ ] **Step 6: Run the tests, then all checks, and commit**

Run: `pnpm vitest run apps/daemon/test/p7/agnc-routes.test.ts apps/web/src/features/agnc apps/daemon/test/audit.coverage.test.ts`
Expected: PASS (routes 5, UI 3, coverage green)

Run: `pnpm --filter @orc/web build && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/daemon/src apps/web/src apps/daemon/test/p7/agnc-routes.test.ts
git commit -m "feat(agnc): add AGNC routes, composer, handoff and UI"
```

---

# 7E Orchestrator MCP server

### Task 22: `orc-mcp` stdio server so Claude and Codex can query the orchestrator

**Files:**
- Create: `apps/mcp/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts}`, `apps/mcp/src/{daemon-client.ts,tools.ts,server.ts,main.ts}`
- Test: `apps/mcp/src/tools.test.ts`
- Modify: `pnpm-workspace.yaml` is already `apps/*`, so nothing to change there; root `pnpm build` picks the new package up automatically.

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk` (`McpServer`, `StdioServerTransport`, `Client`, `InMemoryTransport`); the daemon HTTP API (P1 `/api/sessions`, P2 `/api/live` and `/api/inbox`, P5 `/api/streams/:ticket`, P1 `POST /api/sessions/:source/:id/resume`); `$ORC_HOME/token` (P1 `ensureToken`).
- Produces:
  ```ts
  // daemon-client.ts
  export interface DaemonClient { get<T>(path: string): Promise<T>; post<T>(path: string, body: unknown): Promise<T> }
  export class DaemonError extends Error { status: number; code: string }
  export function resolveDaemonConfig(env?: NodeJS.ProcessEnv): { baseUrl: string; token: string }
  export function createDaemonClient(o: { baseUrl: string; token: string; fetch?: typeof fetch }): DaemonClient
  // tools.ts
  export function registerOrcTools(server: McpServer, client: DaemonClient): void
  export function resumeCommand(s: { source: string; id: string; startCwd: string }): string
  // server.ts
  export function createOrcMcpServer(client: DaemonClient): McpServer
  // main.ts
  export function installSnippet(entry: string): string
  ```
  Tools: `list_live_sessions`, `list_waiting`, `search_sessions`, `get_session_summary`, `get_stream`, `resume_session`. Everything is read-only except `resume_session` with `launch: true`, which calls the daemon's own audited resume route. The server talks only to `127.0.0.1` with the install token, and it prints nothing to stdout except the MCP protocol (logs go to stderr).

- [ ] **Step 1: Create the package**

`apps/mcp/package.json`
```json
{
  "name": "@orc/mcp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "orc-mcp": "./dist/main.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "dev": "tsx src/main.ts",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "@orc/core": "workspace:*",
    "zod": "^4.6.5"
  },
  "devDependencies": { "tsup": "^8.5.1", "tsx": "^4.23.13" }
}
```
`apps/mcp/tsconfig.json`
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "types": ["node"] }, "include": ["src"] }
```
`apps/mcp/tsup.config.ts`
```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  noExternal: [/^@orc\//],
  banner: { js: '#!/usr/bin/env node' },
});
```
`apps/mcp/vitest.config.ts`
```ts
import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'mcp', environment: 'node', include: ['src/**/*.test.ts'] } });
```

Run: `pnpm install`
Expected: `@orc/mcp` joins the workspace.

- [ ] **Step 2: Write the failing test**

`apps/mcp/src/tools.test.ts`
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createDaemonClient, type DaemonClient } from './daemon-client.ts';
import { resumeCommand } from './tools.ts';
import { createOrcMcpServer } from './server.ts';

const live = [
  {
    id: 's1', source: 'claude', projectId: 'wakecap', name: 'SAF-1787 weekends', startCwd: '/Users/test/Wakecap',
    lastActivityAt: '2026-09-18T09:00:00.000Z', usage: { costUsd: 1.5 }, tickets: ['SAF-1787'], prs: [],
    live: { status: 'waiting', waitingFor: 'input needed', ownership: 'owned', ptyId: 'pty-1', since: '2026-09-18T09:00:00.000Z' },
  },
  {
    id: 's2', source: 'codex', projectId: 'forza', name: 'codex thing', startCwd: '/Users/test/Forza',
    lastActivityAt: '2026-09-18T08:00:00.000Z', usage: { costUsd: 0.2 }, tickets: [], prs: [],
    live: { status: 'busy', waitingFor: null, ownership: 'observed', ptyId: null, since: '2026-09-18T08:00:00.000Z' },
  },
];

function fakeClient(): DaemonClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get<T>(path: string): Promise<T> {
      calls.push(`GET ${path}`);
      if (path === '/api/live') return live as T;
      if (path.startsWith('/api/inbox')) {
        return [
          { id: 'i1', kind: 'waiting', sessionId: 's1', projectId: 'wakecap', ticket: 'SAF-1787', reason: 'waiting for input', state: 'open', createdAt: '2026-09-18T09:00:00.000Z', payload: { source: 'claude', id: 's1' } },
          { id: 'i2', kind: 'automation_result', sessionId: null, projectId: 'wakecap', ticket: null, reason: 'Fix CI: success', state: 'open', createdAt: '2026-09-18T08:00:00.000Z', payload: {} },
        ] as T;
      }
      if (path.startsWith('/api/sessions?')) {
        return { items: [{ pk: 'claude:s1', source: 'claude', id: 's1', name: 'SAF-1787 weekends', snippet: 'weekend ⟦SLA⟧', lastActivityAt: '2026-09-18T09:00:00.000Z', costUsd: 1.5, tickets: ['SAF-1787'], prs: [] }], nextCursor: null } as T;
      }
      if (path === '/api/sessions/claude/s1') {
        return { ...live[0], recap: 'Added the weekend check', awaySummary: null, filesTouched: ['a.ts'], lastTest: { passed: 12, failed: 0, skipped: 0, command: 'pnpm test', ts: 't', durationMs: 900 }, availability: 'resumable' } as T;
      }
      if (path === '/api/streams/SAF-1787') return { stream: { ticket: 'SAF-1787', stage: 'in_review', costUsd: 4 } } as T;
      throw new Error(`unexpected GET ${path}`);
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push(`POST ${path} ${JSON.stringify(body)}`);
      return { ptyId: 'pty-9' } as T;
    },
  };
}

async function connect(client: DaemonClient) {
  const server = createOrcMcpServer(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await mcp.connect(clientTransport);
  return mcp;
}

const payload = async (mcp: Client, name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  const res = await mcp.callTool({ name, arguments: args });
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content[0]?.text ?? 'null');
};

describe('orc-mcp tools', () => {
  it('exposes the six read tools', async () => {
    const mcp = await connect(fakeClient());
    const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_session_summary', 'get_stream', 'list_live_sessions', 'list_waiting', 'resume_session', 'search_sessions']);
    await mcp.close();
  });

  it('lists live sessions and filters by project', async () => {
    const mcp = await connect(fakeClient());
    expect(await payload(mcp, 'list_live_sessions')).toEqual([
      { pk: 'claude:s1', name: 'SAF-1787 weekends', status: 'waiting', waitingFor: 'input needed', projectId: 'wakecap', cwd: '/Users/test/Wakecap', owned: true, costUsd: 1.5, since: '2026-09-18T09:00:00.000Z' },
      { pk: 'codex:s2', name: 'codex thing', status: 'busy', waitingFor: null, projectId: 'forza', cwd: '/Users/test/Forza', owned: false, costUsd: 0.2, since: '2026-09-18T08:00:00.000Z' },
    ]);
    expect(await payload(mcp, 'list_live_sessions', { projectId: 'forza' })).toHaveLength(1);
    await mcp.close();
  });

  it('lists only attention inbox kinds for list_waiting', async () => {
    const mcp = await connect(fakeClient());
    const rows = (await payload(mcp, 'list_waiting')) as Array<{ kind: string }>;
    expect(rows.map((r) => r.kind)).toEqual(['waiting']);
    await mcp.close();
  });

  it('searches sessions and summarises one', async () => {
    const client = fakeClient();
    const mcp = await connect(client);
    const found = (await payload(mcp, 'search_sessions', { query: 'weekend', limit: 5 })) as Array<{ pk: string; snippet: string }>;
    expect(found[0]).toMatchObject({ pk: 'claude:s1', snippet: 'weekend ⟦SLA⟧' });
    expect(client.calls.some((c) => c.includes('q=weekend'))).toBe(true);
    const summary = (await payload(mcp, 'get_session_summary', { source: 'claude', id: 's1' })) as Record<string, unknown>;
    expect(summary).toMatchObject({ pk: 'claude:s1', recap: 'Added the weekend check', status: 'waiting', tests: '12 passed, 0 failed', resumeCommand: "cd '/Users/test/Wakecap' && claude --resume s1" });
    expect(await payload(mcp, 'get_stream', { ticket: 'SAF-1787' })).toMatchObject({ stream: { stage: 'in_review' } });
    await mcp.close();
  });

  it('returns a resume command, and only launches when asked', async () => {
    const client = fakeClient();
    const mcp = await connect(client);
    expect(await payload(mcp, 'resume_session', { source: 'claude', id: 's1' })).toEqual({
      command: "cd '/Users/test/Wakecap' && claude --resume s1",
      cwd: '/Users/test/Wakecap',
      launched: false,
    });
    expect(client.calls.some((c) => c.startsWith('POST'))).toBe(false);
    expect(await payload(mcp, 'resume_session', { source: 'claude', id: 's1', launch: true })).toEqual({
      command: "cd '/Users/test/Wakecap' && claude --resume s1",
      cwd: '/Users/test/Wakecap',
      launched: true,
      ptyId: 'pty-9',
      url: 'http://127.0.0.1:4317/sessions/claude/s1',
    });
    expect(client.calls).toContain('POST /api/sessions/claude/s1/resume {"mode":"embedded"}');
    await mcp.close();
  });

  it('reports daemon errors as tool errors instead of throwing', async () => {
    const broken: DaemonClient = {
      async get() {
        throw Object.assign(new Error('connection refused'), { status: 0, code: 'econnrefused' });
      },
      async post() {
        throw new Error('nope');
      },
    };
    const mcp = await connect(broken);
    const res = await mcp.callTool({ name: 'list_live_sessions', arguments: {} });
    expect((res as { isError?: boolean }).isError).toBe(true);
    await mcp.close();
  });

  it('quotes cwds safely in resume commands', () => {
    expect(resumeCommand({ source: 'codex', id: 'c1', startCwd: "/tmp/it's here" })).toBe("cd '/tmp/it'\\''s here' && codex resume c1");
  });
});

describe('createDaemonClient', () => {
  it('sends the token and turns API errors into DaemonError', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createDaemonClient({
      baseUrl: 'http://127.0.0.1:4317',
      token: 'tok',
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith('/bad')) {
          return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }), { status: 404 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await client.get('/api/health')).toEqual({ ok: true });
    expect((calls[0]?.init?.headers as Record<string, string>)['x-orc-token']).toBe('tok');
    await expect(client.get('/bad')).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});
```

Run: `pnpm vitest run apps/mcp`
Expected: FAIL, `Cannot find module './daemon-client.ts'`

- [ ] **Step 3: Implement the daemon client**

`apps/mcp/src/daemon-client.ts`
```ts
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DaemonClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export class DaemonError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'DaemonError';
    this.status = status;
    this.code = code;
  }
}

export function resolveDaemonConfig(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; token: string } {
  const orcHome = env.ORC_HOME ?? join(homedir(), '.orchestrator');
  const token = env.ORC_TOKEN ?? readFileSync(join(orcHome, 'token'), 'utf8').trim();
  const baseUrl = env.ORC_URL ?? `http://127.0.0.1:${env.ORC_PORT ?? '4317'}`;
  return { baseUrl, token };
}

export function createDaemonClient(o: { baseUrl: string; token: string; fetch?: typeof fetch }): DaemonClient {
  const doFetch = o.fetch ?? fetch;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${o.baseUrl}${path}`, {
        method,
        headers: { 'x-orc-token': o.token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new DaemonError(0, 'daemon_unreachable', `cannot reach the orchestrator daemon at ${o.baseUrl}: ${(e as Error).message}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new DaemonError(res.status, err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`);
    }
    return json as T;
  }

  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
  };
}
```

- [ ] **Step 4: Implement the tools and the server**

`apps/mcp/src/tools.ts`
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DaemonClient } from './daemon-client.ts';

interface LiveSession {
  id: string;
  source: string;
  projectId: string | null;
  name: string | null;
  startCwd: string;
  lastActivityAt: string;
  recap?: string | null;
  awaySummary?: string | null;
  usage: { costUsd: number | null };
  tickets: string[];
  prs: Array<{ url: string }>;
  filesTouched?: string[];
  availability?: string;
  lastTest?: { passed: number; failed: number; skipped: number; command: string } | null;
  live: { status: string; waitingFor: string | null; ownership: string; ptyId: string | null; since: string } | null;
}

interface InboxItem {
  id: string;
  kind: string;
  sessionId: string | null;
  projectId: string | null;
  ticket: string | null;
  reason: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

const ATTENTION_KINDS = new Set(['waiting', 'plan_approval', 'review', 'supervisor_escalation', 'blocked', 'error']);

const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export function resumeCommand(s: { source: string; id: string; startCwd: string }): string {
  const cmd = s.source === 'codex' ? `codex resume ${s.id}` : `claude --resume ${s.id}`;
  return `cd ${shellQuote(s.startCwd)} && ${cmd}`;
}

const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });
const asError = (e: unknown) => ({
  content: [{ type: 'text' as const, text: `orchestrator error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

const summariseLive = (s: LiveSession) => ({
  pk: `${s.source}:${s.id}`,
  name: s.name,
  status: s.live?.status ?? 'ended',
  waitingFor: s.live?.waitingFor ?? null,
  projectId: s.projectId,
  cwd: s.startCwd,
  owned: s.live?.ownership === 'owned',
  costUsd: s.usage.costUsd,
  since: s.live?.since ?? s.lastActivityAt,
});

export function registerOrcTools(server: McpServer, client: DaemonClient): void {
  const run = async (fn: () => Promise<unknown>) => {
    try {
      return asText(await fn());
    } catch (e) {
      return asError(e);
    }
  };

  server.registerTool(
    'list_live_sessions',
    { title: 'List live sessions', description: 'Claude and Codex sessions that are currently running on this machine.', inputSchema: { projectId: z.string().optional() } },
    async ({ projectId }) =>
      run(async () => {
        const live = await client.get<LiveSession[]>('/api/live');
        return live.filter((s) => !projectId || s.projectId === projectId).map(summariseLive);
      }),
  );

  server.registerTool(
    'list_waiting',
    { title: 'List what needs me', description: 'Open attention-inbox items: waiting sessions, plans to approve, reviews, supervisor escalations.', inputSchema: { projectId: z.string().optional() } },
    async ({ projectId }) =>
      run(async () => {
        const items = await client.get<InboxItem[]>('/api/inbox?state=open');
        return items
          .filter((i) => ATTENTION_KINDS.has(i.kind) && (!projectId || i.projectId === projectId))
          .map((i) => ({ kind: i.kind, reason: i.reason, sessionId: i.sessionId, projectId: i.projectId, ticket: i.ticket, since: i.createdAt }));
      }),
  );

  server.registerTool(
    'search_sessions',
    { title: 'Search past sessions', description: 'Full-text search over prompts, assistant text and tool inputs of every indexed session.', inputSchema: { query: z.string().min(1), projectId: z.string().optional(), limit: z.number().int().min(1).max(50).optional() } },
    async ({ query, projectId, limit }) =>
      run(async () => {
        const params = new URLSearchParams({ q: query, limit: String(limit ?? 10) });
        if (projectId) params.set('projectId', projectId);
        const res = await client.get<{ items: Array<Record<string, unknown>> }>(`/api/sessions?${params.toString()}`);
        return res.items.map((i) => ({
          pk: i.pk,
          name: i.name,
          snippet: i.snippet,
          lastActivityAt: i.lastActivityAt,
          costUsd: i.costUsd,
          tickets: i.tickets,
        }));
      }),
  );

  server.registerTool(
    'get_session_summary',
    { title: 'Summarise a session', description: 'Recap, tickets, PRs, files, tests and the command to resume a session.', inputSchema: { source: z.enum(['claude', 'codex', 'agnc']), id: z.string().min(1) } },
    async ({ source, id }) =>
      run(async () => {
        const s = await client.get<LiveSession>(`/api/sessions/${encodeURIComponent(source)}/${encodeURIComponent(id)}`);
        return {
          pk: `${source}:${id}`,
          name: s.name,
          status: s.live?.status ?? 'ended',
          projectId: s.projectId,
          cwd: s.startCwd,
          recap: s.recap ?? s.awaySummary ?? null,
          tickets: s.tickets,
          prs: s.prs.map((p) => p.url),
          files: (s.filesTouched ?? []).slice(0, 30),
          tests: s.lastTest ? `${s.lastTest.passed} passed, ${s.lastTest.failed} failed` : null,
          costUsd: s.usage.costUsd,
          availability: s.availability ?? null,
          resumeCommand: resumeCommand({ source, id, startCwd: s.startCwd }),
        };
      }),
  );

  server.registerTool(
    'get_stream',
    { title: 'Get a ticket work stream', description: 'Everything the orchestrator knows about one ticket: sessions, PRs, plans, cost and stage.', inputSchema: { ticket: z.string().min(2) } },
    async ({ ticket }) => run(async () => client.get(`/api/streams/${encodeURIComponent(ticket)}`)),
  );

  server.registerTool(
    'resume_session',
    {
      title: 'Resume a session',
      description: 'Returns the shell command that resumes a session. With launch=true the orchestrator starts it in its own terminal instead.',
      inputSchema: { source: z.enum(['claude', 'codex']), id: z.string().min(1), launch: z.boolean().optional() },
    },
    async ({ source, id, launch }) =>
      run(async () => {
        const s = await client.get<LiveSession>(`/api/sessions/${encodeURIComponent(source)}/${encodeURIComponent(id)}`);
        const command = resumeCommand({ source, id, startCwd: s.startCwd });
        if (!launch) return { command, cwd: s.startCwd, launched: false };
        const res = await client.post<{ ptyId?: string }>(`/api/sessions/${encodeURIComponent(source)}/${encodeURIComponent(id)}/resume`, { mode: 'embedded' });
        return { command, cwd: s.startCwd, launched: true, ptyId: res.ptyId ?? null, url: `http://127.0.0.1:4317/sessions/${source}/${id}` };
      }),
  );
}
```

`apps/mcp/src/server.ts`
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonClient } from './daemon-client.ts';
import { registerOrcTools } from './tools.ts';

export function createOrcMcpServer(client: DaemonClient): McpServer {
  const server = new McpServer(
    { name: 'orchestrator', version: '0.7.0' },
    { instructions: 'Read-only view of the local AI-agent orchestrator: live sessions, the attention inbox, session search and work streams. resume_session can start a session in the orchestrator when launch=true.' },
  );
  registerOrcTools(server, client);
  return server;
}
```

`apps/mcp/src/main.ts`
```ts
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDaemonClient, resolveDaemonConfig } from './daemon-client.ts';
import { createOrcMcpServer } from './server.ts';

export function installSnippet(entry: string): string {
  return [
    `claude mcp add --scope user orchestrator -- node ${entry}`,
    `codex mcp add orchestrator -- node ${entry}`,
  ].join('\n');
}

const entry = fileURLToPath(import.meta.url);

if (process.argv.includes('--print-install')) {
  process.stdout.write(`${installSnippet(entry)}\n`);
  process.exit(0);
}

const config = resolveDaemonConfig();
const server = createOrcMcpServer(createDaemonClient(config));
process.stderr.write(`orc-mcp talking to ${config.baseUrl}\n`);
await server.connect(new StdioServerTransport());
```

- [ ] **Step 5: Run the tests and the build**

Run: `pnpm vitest run apps/mcp`
Expected: PASS (tools 7 tests, client 1 test)

Run: `pnpm --filter @orc/mcp build && node apps/mcp/dist/main.js --print-install`
Expected: two lines, the `claude mcp add` and `codex mcp add` commands pointing at `apps/mcp/dist/main.js`.

- [ ] **Step 6: Install it and try it end to end (manual, with evidence)**

1. Start the daemon (`pnpm --filter @orc/daemon dev`).
2. Run the printed `claude mcp add --scope user …` command.
3. In a scratch directory run `claude -p "Use the orchestrator MCP server: which of my sessions are waiting?" --model claude-haiku-4-5 --max-budget-usd 0.05` and paste the answer into the task review note.
4. Check `codex mcp --help` for the exact Codex syntax; if it differs, fix `installSnippet` and re-run `pnpm --filter @orc/mcp build`.

- [ ] **Step 7: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/mcp
git commit -m "feat(mcp): add the orc-mcp stdio server for session queries and resume"
```

---

# 7F Tauri 2 desktop shell

### Task 23: Package the daemon as a sidecar and add the notification bridge

**Files:**
- Create: `apps/daemon/src/notify/stdout-bridge.ts`, `apps/daemon/tsup.config.ts`, `scripts/build-sidecar.mjs`
- Modify: `apps/daemon/package.json` (build script + `files`), `apps/daemon/src/main.ts` (notify channel choice, `ORC_WEB_DIR`), `.gitignore`
- Test: `apps/daemon/test/p7/stdout-bridge.test.ts`

**Interfaces:**
- Consumes: `NotifyChannelImpl`, `Notifier.register` (P2 §11); `InboxItem` (§4); `redact` (`@orc/core`); `createDaemon`'s `webDist` option (P1).
- Produces:
  ```ts
  // notify/stdout-bridge.ts
  export const NOTIFY_PREFIX = 'ORC_NOTIFY ';
  export interface NotifyLine { title: string; body: string; url: string; kind: string }
  export function notifyLine(item: InboxItem, url: string): NotifyLine
  export function createStdoutNotifyChannel(write?: (line: string) => void): NotifyChannelImpl   // id 'macos'
  ```
  Packaging decision (checked against the Node 22 docs on 2026-09-18): **Node SEA is not used.** SEA on Node 22 is "1.1 - Active development", supports only a **CommonJS** entry, and `require()` inside a SEA can load only built-in modules — so `better-sqlite3` and `node-pty` cannot be bundled. Instead the sidecar is the **Node binary itself** (`process.execPath`, copied to `binaries/orc-node-<target-triple>`), and the daemon bundle plus its production `node_modules` ship as Tauri **resources**. The native addons are therefore built for exactly the Node runtime that ships with the app.

- [ ] **Step 1: Write the failing bridge test**

`apps/daemon/test/p7/stdout-bridge.test.ts`
```ts
import type { InboxItem } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { createStdoutNotifyChannel, NOTIFY_PREFIX, notifyLine } from '../../src/notify/stdout-bridge.ts';

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'i1',
  kind: 'waiting',
  sessionId: 's1',
  projectId: 'wakecap',
  ticket: 'SAF-1787',
  reason: 'waiting for input (token=abc123)',
  dedupeKey: 'waiting:claude:s1',
  createdAt: '2026-09-18T09:00:00.000Z',
  updatedAt: '2026-09-18T09:00:00.000Z',
  state: 'open',
  snoozeUntil: null,
  payload: { source: 'claude', id: 's1' },
  ...over,
});

describe('stdout notify bridge', () => {
  it('builds a redacted, human-readable line', () => {
    expect(notifyLine(item(), 'http://127.0.0.1:4317/sessions/claude/s1')).toEqual({
      title: 'Waiting · SAF-1787',
      body: 'waiting for input (token=«redacted:secret»)',
      url: 'http://127.0.0.1:4317/sessions/claude/s1',
      kind: 'waiting',
    });
    expect(notifyLine(item({ kind: 'automation_result', ticket: null, reason: 'Fix CI: success' }), 'u').title).toBe('Automation result');
  });

  it('writes one prefixed JSON line per notification', async () => {
    const lines: string[] = [];
    const channel = createStdoutNotifyChannel((l) => lines.push(l));
    expect(channel.id).toBe('macos');
    await channel.send(item(), 'http://127.0.0.1:4317/sessions/claude/s1');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith(NOTIFY_PREFIX)).toBe(true);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse((lines[0] ?? '').slice(NOTIFY_PREFIX.length))).toMatchObject({ kind: 'waiting' });
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p7/stdout-bridge.test.ts`
Expected: FAIL, `Cannot find module '../../src/notify/stdout-bridge.ts'`

- [ ] **Step 2: Implement the bridge**

`apps/daemon/src/notify/stdout-bridge.ts`
```ts
import { type InboxItem, redact } from '@orc/core';
import type { NotifyChannelImpl } from './notifier.ts';

export const NOTIFY_PREFIX = 'ORC_NOTIFY ';

export interface NotifyLine {
  title: string;
  body: string;
  url: string;
  kind: string;
}

const TITLES: Record<string, string> = {
  waiting: 'Waiting',
  review: 'Ready for review',
  plan_approval: 'Plan awaiting approval',
  blocked: 'Blocked',
  error: 'Error',
  tests_red: 'Tests went red',
  budget: 'Budget',
  automation_result: 'Automation result',
  supervisor_escalation: 'Supervisor escalation',
  pr_event: 'Pull request',
  reminder: 'Reminder',
};

export function notifyLine(item: InboxItem, url: string): NotifyLine {
  const base = TITLES[item.kind] ?? item.kind.replace('_', ' ');
  return {
    title: item.ticket ? `${base} · ${item.ticket}` : base,
    body: redact(item.reason).slice(0, 240),
    url,
    kind: item.kind,
  };
}

/**
 * Notification channel for the Tauri shell: instead of node-notifier, print one line to stdout,
 * which the Rust side turns into a native notification. Enabled with ORC_NOTIFY_BRIDGE=stdout.
 */
export function createStdoutNotifyChannel(write: (line: string) => void = (l) => void process.stdout.write(l)): NotifyChannelImpl {
  return {
    id: 'macos',
    async send(item, url) {
      write(`${NOTIFY_PREFIX}${JSON.stringify(notifyLine(item, url))}\n`);
    },
  };
}
```

In `apps/daemon/src/main.ts`, where `createDaemon` registers the macOS notification channel (P2), choose the bridge instead when the shell asked for it:
```ts
  if (process.env.ORC_NOTIFY_BRIDGE === 'stdout') {
    ctx.notifier?.register(createStdoutNotifyChannel());
  } else {
    ctx.notifier?.register(createMacosNotifyChannel());   // the existing P2 registration
  }
```
and let the web root be overridden: `webDist: o.webDist ?? process.env.ORC_WEB_DIR ?? <existing default>`.

- [ ] **Step 3: Make the daemon bundle self-contained**

`apps/daemon/tsup.config.ts`
```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  // Workspace packages are compiled in; native and runtime deps stay external and ship in node_modules.
  noExternal: [/^@orc\//],
  sourcemap: true,
  clean: true,
});
```
In `apps/daemon/package.json`: change the build script to `"build": "tsup"` and add `"files": ["dist"]` so `pnpm deploy` copies the bundle.

- [ ] **Step 4: Write the sidecar build script**

`scripts/build-sidecar.mjs`
```js
#!/usr/bin/env node
// Builds everything the Tauri shell needs:
//   apps/desktop/src-tauri/binaries/orc-node-<triple>   the Node runtime, used as the sidecar binary
//   apps/desktop/src-tauri/resources/daemon/            the daemon bundle + production node_modules (native addons)
//   apps/desktop/src-tauri/resources/web/               the built web app
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const tauriDir = join(root, 'apps/desktop/src-tauri');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root });

const triple = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
console.log(`target triple: ${triple}`);

// 1. the Node runtime becomes the sidecar binary
const binaries = join(tauriDir, 'binaries');
mkdirSync(binaries, { recursive: true });
const nodeTarget = join(binaries, `orc-node-${triple}`);
copyFileSync(process.execPath, nodeTarget);
chmodSync(nodeTarget, 0o755);
console.log(`sidecar: ${nodeTarget} (node ${process.version})`);

// 2. daemon bundle + production dependencies (native addons match this Node)
run('pnpm', ['--filter', '@orc/daemon', 'build']);
const daemonOut = join(tauriDir, 'resources/daemon');
rmSync(daemonOut, { recursive: true, force: true });
run('pnpm', ['--filter', '@orc/daemon', 'deploy', '--prod', '--legacy', daemonOut]);

// 3. the web app
run('pnpm', ['--filter', '@orc/web', 'build']);
const webOut = join(tauriDir, 'resources/web');
rmSync(webOut, { recursive: true, force: true });
cpSync(join(root, 'apps/web/dist'), webOut, { recursive: true });

console.log('sidecar assets ready');
```
Add to `.gitignore`:
```
apps/desktop/src-tauri/target/
apps/desktop/src-tauri/binaries/
apps/desktop/src-tauri/resources/
apps/desktop/src-tauri/gen/
```

Run: `node scripts/build-sidecar.mjs` (needs `rustc`; if it is missing, install Rust first — see Task 24 Step 1)
Expected: the three paths above exist, and `apps/desktop/src-tauri/resources/daemon/dist/main.js` is present together with `node_modules/better-sqlite3` and `node_modules/node-pty`.

Run: `ORC_HOME="$(mktemp -d)" ORC_PORT=4321 ORC_NOTIFY_BRIDGE=stdout apps/desktop/src-tauri/binaries/orc-node-$(rustc --print host-tuple) apps/desktop/src-tauri/resources/daemon/dist/main.js`
Expected: the daemon starts and serves `http://127.0.0.1:4321/api/health` (check from another shell with `curl -H "x-orc-token: $(cat $ORC_HOME/token)" http://127.0.0.1:4321/api/health`). Stop it with Ctrl-C. If a native addon fails to load, re-run `pnpm --filter @orc/daemon rebuild` and then the script again.

- [ ] **Step 5: Run the tests, then all checks, and commit**

Run: `pnpm vitest run apps/daemon/test/p7/stdout-bridge.test.ts`
Expected: PASS (2 tests)

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add apps/daemon scripts/build-sidecar.mjs .gitignore
git commit -m "feat(daemon): add the stdout notification bridge and sidecar packaging"
```

---

### Task 24: Tauri 2 shell — tray with waiting count and quota, global hotkey, native notifications

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/splash/index.html`, `apps/desktop/src-tauri/{Cargo.toml,build.rs,tauri.conf.json}`, `apps/desktop/src-tauri/capabilities/default.json`, `apps/desktop/src-tauri/src/{main.rs,lib.rs,bridge.rs}`
- Test: `apps/desktop/src-tauri/src/bridge.rs` (`#[cfg(test)]` unit tests, run with `cargo test`)

**Interfaces:**
- Consumes: the sidecar assets from Task 23; the daemon API `GET /api/health`, `GET /api/live` (P2) and `GET /api/usage` (P5); `$ORC_HOME/token` (P1); the `ORC_NOTIFY ` stdout protocol (Task 23).
- Produces: a macOS app that starts the daemon as a sidecar, shows a tray item with the number of waiting sessions and the 5-hour block usage, opens the local web UI in a window, registers ⌘⇧O as a global hotkey and turns bridge lines into native notifications.
  ```rust
  // bridge.rs (pure, unit-tested)
  pub struct NotifyMsg { pub title: String, pub body: String, pub url: String, pub kind: String }
  pub fn parse_notify_line(line: &str) -> Option<NotifyMsg>
  pub fn count_waiting(live: &serde_json::Value) -> usize
  pub fn block_pct(usage: &serde_json::Value) -> Option<f64>
  pub fn tray_title(waiting: Option<usize>, pct: Option<f64>) -> String
  pub fn tray_tooltip(waiting: Option<usize>, pct: Option<f64>) -> String
  ```

- [ ] **Step 1: Check the toolchain**

Run: `rustc --version && cargo --version`
Expected: both print a version. If not, ask the user to install Rust (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`) and stop until it is available — the rest of this task cannot run without it.

Run: `pnpm --filter @orc/desktop exec tauri --version` after Step 2 installs the CLI.

- [ ] **Step 2: Create the package and the Tauri config**

`apps/desktop/package.json`
```json
{
  "name": "@orc/desktop",
  "version": "0.7.0",
  "private": true,
  "type": "module",
  "scripts": {
    "tauri": "tauri",
    "sidecar": "node ../../scripts/build-sidecar.mjs",
    "dev:app": "node ../../scripts/build-sidecar.mjs && tauri dev",
    "build:app": "node ../../scripts/build-sidecar.mjs && tauri build",
    "test:rust": "cargo test --manifest-path src-tauri/Cargo.toml"
  },
  "devDependencies": { "@tauri-apps/cli": "^2.11.4" }
}
```
The scripts are deliberately **not** called `dev` or `build`, so `pnpm -r dev` and `pnpm -r build` never need Rust.

`apps/desktop/splash/index.html`
```html
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Orchestrator</title></head>
  <body style="font-family: system-ui; padding: 24px">Starting the orchestrator daemon…</body>
</html>
```

`apps/desktop/src-tauri/tauri.conf.json`
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Orchestrator",
  "version": "0.7.0",
  "identifier": "dev.orchestrator.desktop",
  "build": { "frontendDist": "../splash" },
  "app": {
    "windows": [],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": ["app", "dmg"],
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns"],
    "externalBin": ["binaries/orc-node"],
    "resources": { "resources/daemon/": "daemon/", "resources/web/": "web/" }
  }
}
```
`app.windows` is empty on purpose: the window is created in Rust once the daemon answers, so it can point at `http://127.0.0.1:4317`.

`apps/desktop/src-tauri/Cargo.toml`
```toml
[package]
name = "orchestrator-desktop"
version = "0.7.0"
edition = "2021"

[lib]
name = "orchestrator_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-shell = "2"
tauri-plugin-notification = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
tokio = { version = "1", features = ["time"] }

[target.'cfg(any(target_os = "macos", windows, target_os = "linux"))'.dependencies]
tauri-plugin-global-shortcut = "2"
```

`apps/desktop/src-tauri/build.rs`
```rust
fn main() {
    tauri_build::build()
}
```

`apps/desktop/src-tauri/capabilities/default.json`
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "The window only loads the local daemon UI; every native call happens in Rust.",
  "windows": ["main"],
  "permissions": ["core:default", "notification:default"]
}
```
The sidecar is spawned from Rust, so no `shell:allow-execute` permission is needed for the webview. The window loads a remote (loopback) URL and gets no IPC access.

Run: `pnpm install && pnpm --filter @orc/desktop exec tauri icon ../web/public/icon-512.png`
Expected: `apps/desktop/src-tauri/icons/*` is generated. If the web app has no 512 px icon yet, point at any square PNG.

- [ ] **Step 3: Write the failing Rust unit tests**

`apps/desktop/src-tauri/src/bridge.rs`
```rust
use serde::Deserialize;

#[derive(Debug, Deserialize, PartialEq)]
pub struct NotifyMsg {
    pub title: String,
    pub body: String,
    pub url: String,
    #[serde(default)]
    pub kind: String,
}

pub const NOTIFY_PREFIX: &str = "ORC_NOTIFY ";

/// Parses one stdout line from the daemon bridge. Anything else (pino logs) is ignored.
pub fn parse_notify_line(line: &str) -> Option<NotifyMsg> {
    let json = line.trim().strip_prefix(NOTIFY_PREFIX)?;
    serde_json::from_str(json).ok()
}

pub fn count_waiting(live: &serde_json::Value) -> usize {
    live.as_array()
        .map(|rows| {
            rows.iter()
                .filter(|s| s.pointer("/live/status").and_then(|v| v.as_str()) == Some("waiting"))
                .count()
        })
        .unwrap_or(0)
}

/// `UsageSnapshot.block.pctOfLimit` is a fraction (1.0 = 100%).
pub fn block_pct(usage: &serde_json::Value) -> Option<f64> {
    usage.pointer("/block/pctOfLimit").and_then(|v| v.as_f64())
}

pub fn tray_title(waiting: Option<usize>, pct: Option<f64>) -> String {
    match (waiting, pct) {
        (None, _) => "–".to_string(),
        (Some(w), Some(p)) => format!("{w}⏳ {}%", (p * 100.0).round() as i64),
        (Some(w), None) => format!("{w}⏳"),
    }
}

pub fn tray_tooltip(waiting: Option<usize>, pct: Option<f64>) -> String {
    match (waiting, pct) {
        (None, _) => "Orchestrator: daemon not reachable".to_string(),
        (Some(w), Some(p)) => format!("Orchestrator: {w} waiting · 5-hour block {}%", (p * 100.0).round() as i64),
        (Some(w), None) => format!("Orchestrator: {w} waiting"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_only_bridge_lines() {
        let line = r#"ORC_NOTIFY {"title":"Waiting · SAF-1787","body":"waiting for input","url":"http://127.0.0.1:4317/sessions/claude/s1","kind":"waiting"}"#;
        let msg = parse_notify_line(line).expect("parsed");
        assert_eq!(msg.title, "Waiting · SAF-1787");
        assert_eq!(msg.kind, "waiting");
        assert!(parse_notify_line(r#"{"level":30,"msg":"indexed"}"#).is_none());
        assert!(parse_notify_line("ORC_NOTIFY not json").is_none());
    }

    #[test]
    fn counts_waiting_sessions() {
        let live = json!([
            { "live": { "status": "waiting" } },
            { "live": { "status": "busy" } },
            { "live": null },
            { "live": { "status": "waiting" } }
        ]);
        assert_eq!(count_waiting(&live), 2);
        assert_eq!(count_waiting(&json!({})), 0);
    }

    #[test]
    fn formats_the_tray() {
        assert_eq!(block_pct(&json!({ "block": { "pctOfLimit": 0.42 } })), Some(0.42));
        assert_eq!(block_pct(&json!({ "block": {} })), None);
        assert_eq!(tray_title(Some(3), Some(0.42)), "3⏳ 42%");
        assert_eq!(tray_title(Some(0), None), "0⏳");
        assert_eq!(tray_title(None, Some(0.5)), "–");
        assert_eq!(tray_tooltip(Some(1), Some(0.5)), "Orchestrator: 1 waiting · 5-hour block 50%");
        assert_eq!(tray_tooltip(None, None), "Orchestrator: daemon not reachable");
    }
}
```

Run: `pnpm --filter @orc/desktop test:rust`
Expected: FAIL — `main.rs`/`lib.rs` do not exist yet, so the crate does not build.

- [ ] **Step 4: Implement the shell**

`apps/desktop/src-tauri/src/main.rs`
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    orchestrator_desktop_lib::run();
}
```

`apps/desktop/src-tauri/src/lib.rs`
```rust
pub mod bridge;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DAEMON_URL: &str = "http://127.0.0.1:4317";

struct Sidecar(Mutex<Option<CommandChild>>);

fn orc_home() -> PathBuf {
    std::env::var_os("ORC_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = std::env::var_os("HOME").unwrap_or_default();
            PathBuf::from(home).join(".orchestrator")
        })
}

fn read_token() -> Option<String> {
    std::fs::read_to_string(orc_home().join("token")).ok().map(|s| s.trim().to_string())
}

async fn fetch_json(client: &reqwest::Client, path: &str, token: &str) -> Option<serde_json::Value> {
    client
        .get(format!("{DAEMON_URL}{path}"))
        .header("x-orc-token", token)
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .ok()?
        .json::<serde_json::Value>()
        .await
        .ok()
}

async fn daemon_healthy(client: &reqwest::Client) -> bool {
    let token = read_token().unwrap_or_default();
    fetch_json(client, "/api/health", &token).await.is_some()
}

fn show_window(app: &AppHandle, path: &str) {
    if let Some(window) = app.get_webview_window("main") {
        if path != "/" {
            let _ = window.eval(&format!("window.location.assign({path:?})"));
        }
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let Ok(url) = format!("{DAEMON_URL}{path}").parse::<tauri::Url>() else {
        return;
    };
    let token = read_token().unwrap_or_default();
    let script = format!("window.__ORC_TOKEN__ = {token:?};");
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Orchestrator")
        .inner_size(1400.0, 900.0)
        .initialization_script(&script)
        .build();
}

fn spawn_daemon(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let resources = app.path().resource_dir()?;
    let main_js = resources.join("daemon").join("dist").join("main.js");
    let web_dir = resources.join("web");
    let (mut rx, child) = app
        .shell()
        .sidecar("orc-node")?
        .args([main_js.to_string_lossy().to_string()])
        .env("ORC_NOTIFY_BRIDGE", "stdout")
        .env("ORC_WEB_DIR", web_dir.to_string_lossy().to_string())
        .spawn()?;
    if let Ok(mut slot) = app.state::<Sidecar>().0.lock() {
        *slot = Some(child);
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    if let Some(msg) = bridge::parse_notify_line(&line) {
                        let _ = handle.notification().builder().title(&msg.title).body(&msg.body).show();
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("daemon: {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("daemon exited: {payload:?}");
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn build_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, "open", "Open Orchestrator", true, Some("CmdOrCtrl+Shift+O"))?;
    let inbox = MenuItem::with_id(app, "inbox", "Open inbox", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &inbox, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Orchestrator")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_window(app, "/"),
            "inbox" => show_window(app, "/inbox"),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn start_tray_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        loop {
            let token = read_token().unwrap_or_default();
            let waiting = fetch_json(&client, "/api/live", &token).await.map(|v| bridge::count_waiting(&v));
            let pct = fetch_json(&client, "/api/usage", &token).await.and_then(|v| bridge::block_pct(&v));
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_title(Some(bridge::tray_title(waiting, pct)));
                let _ = tray.set_tooltip(Some(bridge::tray_tooltip(waiting, pct)));
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                let hotkey = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyO);
                let hotkey_for_handler = hotkey;
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            if shortcut == &hotkey_for_handler && event.state() == ShortcutState::Pressed {
                                show_window(app, "/");
                            }
                        })
                        .build(),
                )?;
                app.global_shortcut().register(hotkey)?;
            }

            build_tray(&handle)?;

            let boot = handle.clone();
            tauri::async_runtime::spawn(async move {
                let client = reqwest::Client::new();
                if !daemon_healthy(&client).await {
                    if let Err(err) = spawn_daemon(&boot) {
                        eprintln!("could not start the daemon sidecar: {err}");
                    }
                }
                for _ in 0..30 {
                    if daemon_healthy(&client).await {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                show_window(&boot, "/");
                start_tray_poller(boot);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Keep the daemon and the tray running; the window is only hidden.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Orchestrator app")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Ok(mut slot) = app.state::<Sidecar>().0.lock() {
                    if let Some(child) = slot.take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
```
If `daemon_healthy` succeeds at startup, the app attaches to the daemon you already run with `pnpm dev` instead of starting a second one.

Run: `pnpm --filter @orc/desktop test:rust`
Expected: PASS (3 Rust tests)

- [ ] **Step 5: Run the app (manual, with evidence)**

Run: `pnpm --filter @orc/desktop dev:app`
Check and record each one:

| # | Check | Evidence |
|---|---|---|
| a | The window opens on the orchestrator UI, logged in (no token prompt) | screenshot |
| b | The tray shows `N⏳` and the block percentage, and updates within about 5 s when a session starts waiting | screenshot |
| c | ⌘⇧O opens or focuses the window from another app | note |
| d | An inbox item raises a native notification with the right title | screenshot |
| e | Closing the window keeps the tray alive; Quit stops the daemon (`pgrep -f orc-node` prints nothing) | terminal output |
| f | With the dev daemon already running, the app does not start a second one (`pgrep -fc 'dist/main.js'` stays at 1) | terminal output |

Run: `pnpm --filter @orc/desktop build:app`
Expected: `apps/desktop/src-tauri/target/release/bundle/macos/Orchestrator.app` exists and starts with a double click.

- [ ] **Step 6: Run all checks and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @orc/desktop test:rust`
Expected: all green. Biome ignores Rust; add `apps/desktop/src-tauri/target` to `biome.json`'s ignore list if it slows linting down.

```bash
git add apps/desktop .gitignore
git commit -m "feat(desktop): add the Tauri shell with tray, hotkey, notifications and daemon sidecar"
```

---

# Phase exit

### Task 25: M7 exit check, contracts merge and README update

**Files:**
- Create: `apps/daemon/test/p7/m7-exit.test.ts`
- Modify: `plan/00-contracts.md`, `plan/README.md`

**Interfaces:**
- Consumes: everything from Tasks 1–24.
- Produces: an executable guard for the three M7 exit criteria from `docs/05-roadmap.md` ("each item can be turned off", "budget and deny-list are enforced", "every action is audited"), the merged contracts and the updated status table.

- [ ] **Step 1: Write the exit test**

`apps/daemon/test/p7/m7-exit.test.ts`
```ts
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.ts';
import { API_BASE, TEST_TOKEN } from '../../src/http/p7-guard.ts';
import { AUTOMATION_DISALLOWED_TOOLS } from '../../src/services/automations/guardrails.ts';
import { createAutomationService } from '../../src/services/automations/service.ts';
import { createCompareService } from '../../src/services/compare/compare.ts';
import { createSupervisor } from '../../src/services/supervisor/supervisor.ts';
import { createTestContext, type TestContext } from '../helpers.ts';
import {
  createFakePty,
  fakeAudit,
  fakeDenyList,
  fakeInbox,
  fakeLauncher,
  fakeProjects,
  fakeRecaps,
  fakeSessions,
  fakeShip,
  fakeTemplates,
  fakeUsage,
  fakeWorktrees,
  makeLive,
  makeSession,
  testConfig,
} from '../fakes/phase7.ts';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

const automation = {
  id: 'a1',
  name: 'Fix CI',
  enabled: true,
  trigger: { type: 'manual' as const },
  action: { templateId: 'fix', projectId: 'wakecap', useWorktree: false, headless: true, timeoutMin: 5, planApproval: false },
  budgetUsd: 5,
};

function harness(o: { cfg?: Record<string, unknown>; usageOk?: boolean } = {}) {
  let cfg = testConfig(o.cfg ?? {});
  const audit = fakeAudit();
  const inbox = fakeInbox();
  const pty = createFakePty();
  const ship = fakeShip();
  ctx = createTestContext({
    config: () => cfg,
    updateConfig: (fn) => {
      cfg = OrcConfig.parse(fn(cfg));
      return cfg;
    },
    projects: fakeProjects(cfg),
    audit,
    inbox,
    pty,
    ship,
    launcher: fakeLauncher(),
    worktrees: fakeWorktrees(),
    recaps: fakeRecaps(),
    usage: fakeUsage({ ok: o.usageOk ?? true }),
    denyList: fakeDenyList(),
    templates: fakeTemplates({ fix: 'Fix the failing check', danger: 'deploy to production' }),
    sessions: fakeSessions([makeSession({ id: 's1', live: makeLive({ status: 'waiting', ptyId: 'pty-1' }) })]),
  });
  const runnerCalls: string[] = [];
  ctx.automations = createAutomationService({
    ctx,
    runner: async (r) => {
      runnerCalls.push(r.prompt);
      return { sessionId: r.sessionId ?? 's', costUsd: 0.1, durationMs: 1, numTurns: 1, resultText: 'done', isError: false, subtype: 'success', timedOut: false, exitCode: 0, events: 1, stderrTail: '' };
    },
  });
  ctx.supervisor = createSupervisor({
    ctx,
    lastAssistantText: async () => 'Should I continue?',
    classifier: async (i) => ({ output: { decision: 'answer', answer: 'ok', confidence: 0.99, reason: 'routine' }, costUsd: 0.001, model: i.model, durationMs: 1 }),
  });
  ctx.compare = createCompareService({ ctx });
  const app = createApp({ ctx, token: TEST_TOKEN, port: () => 4317, env: {} });
  const call = (path: string, method = 'GET', body?: unknown) =>
    app.request(`${API_BASE}${path}`, {
      method,
      headers: { 'x-orc-token': TEST_TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ctx, app, call, audit, inbox, pty, ship, runnerCalls, getCfg: () => cfg };
}

describe('M7 exit: everything can be turned off', () => {
  it('ships with automations, the supervisor and AGNC off by default', () => {
    const cfg = OrcConfig.parse({});
    expect(cfg.automations.enabled).toBe(false);
    expect(cfg.automations.suggestions.enabled).toBe(false);
    expect(cfg.supervisor.enabled).toBe(false);
    expect(cfg.agnc.enabled).toBe(false);
  });

  it('runs nothing while the master switches are off', async () => {
    const t = harness();
    t.ctx.automations?.save(automation);
    expect((await t.ctx.automations?.runNow('a1'))?.status).toBe('denied');
    expect(t.runnerCalls).toHaveLength(0);

    expect(t.ctx.supervisor?.enabledFor('claude:s1')).toBe(false);
    const decision = await t.ctx.supervisor?.evaluate('claude:s1');
    expect(decision?.sent).toBe(false);
    expect(t.pty.sent).toHaveLength(0);
  });

  it('turns a single automation and a single session off again', async () => {
    const t = harness({ cfg: { automations: { enabled: true }, supervisor: { enabled: true } } });
    t.ctx.automations?.save(automation);
    expect((await t.ctx.automations?.runNow('a1'))?.status).toBe('success');
    t.ctx.automations?.setEnabled('a1', false);
    expect(t.ctx.automations?.get('a1')?.enabled).toBe(false);

    t.ctx.supervisor?.setTarget({ targetType: 'project', targetId: 'wakecap', enabled: true });
    expect(t.ctx.supervisor?.enabledFor('claude:s1')).toBe(true);
    t.ctx.supervisor?.setTarget({ targetType: 'session', targetId: 'claude:s1', enabled: false });
    expect(t.ctx.supervisor?.enabledFor('claude:s1')).toBe(false);
  });
});

describe('M7 exit: budgets and the deny-list are enforced', () => {
  it('refuses automations over budget and deny-listed prompts, and compare over budget', async () => {
    const over = harness({ cfg: { automations: { enabled: true } }, usageOk: false });
    over.ctx.automations?.save(automation);
    expect((await over.ctx.automations?.runNow('a1'))?.status).toBe('over_budget');
    await expect(
      over.ctx.compare?.launch({
        source: 'claude', projectId: 'wakecap', cwd: '/tmp', prompt: 'x', vars: {}, planApproval: false,
        worktree: { repo: '/tmp/r', base: 'main', type: 'feat', slug: 's' },
        compare: [{ source: 'claude' }, { source: 'codex' }],
      }),
    ).rejects.toMatchObject({ code: 'over_budget' });

    const denied = harness({ cfg: { automations: { enabled: true } } });
    denied.ctx.automations?.save({ ...automation, action: { ...automation.action, templateId: 'danger' } });
    expect((await denied.ctx.automations?.runNow('a1'))?.status).toBe('denied');
    expect(denied.runnerCalls).toHaveLength(0);
  });

  it('never allows merge, deploy or prod tools in an automation run', () => {
    for (const tool of ['Bash(gh pr merge *)', 'Bash(git push --force *)', 'Bash(kubectl *)', 'Bash(terraform *)']) {
      expect(AUTOMATION_DISALLOWED_TOOLS).toContain(tool);
    }
  });

  it('escalates instead of answering a deny-listed supervisor question', async () => {
    const t = harness({ cfg: { supervisor: { enabled: true } } });
    t.ctx.supervisor?.setTarget({ targetType: 'project', targetId: 'wakecap', enabled: true });
    const svc = createSupervisor({
      ctx: t.ctx,
      lastAssistantText: async () => 'Should I deploy to production?',
      classifier: async () => {
        throw new Error('the classifier must not be called');
      },
    });
    expect((await svc.evaluate('claude:s1')).decision).toBe('escalate');
    expect(t.pty.sent).toHaveLength(0);
  });
});

describe('M7 exit: every action is audited', () => {
  it('records automation, supervisor and compare actions with their actor', async () => {
    const t = harness({ cfg: { automations: { enabled: true }, supervisor: { enabled: true } } });
    t.ctx.automations?.save(automation);
    await t.ctx.automations?.runNow('a1');
    t.ctx.supervisor?.setTarget({ targetType: 'project', targetId: 'wakecap', enabled: true });
    await t.ctx.supervisor?.evaluate('claude:s1');

    const byAction = new Map(t.audit.entries.map((e) => [e.action, e]));
    expect(byAction.get('automation.run')?.actor).toBe('automation');
    expect(byAction.get('supervisor.answer')?.actor).toBe('supervisor');
    expect(byAction.has('settings.update')).toBe(true);
    expect(t.ship.calls).not.toContain('merge');
  });

  it('keeps every phase 7 write route inside the audit coverage rules', async () => {
    const t = harness();
    const { AUDITED_ROUTES, NON_ACTION_ROUTES, matchAuditedRoute } = await import('../../src/http/audit-middleware.ts');
    expect(AUDITED_ROUTES.length).toBeGreaterThan(0);
    const p7 = ['/api/automations', '/api/compare', '/api/supervisor', '/api/agnc'];
    const missing = t.app.routes
      .filter((r) => p7.some((p) => r.path.startsWith(p)) && !['GET', 'HEAD', 'OPTIONS', 'ALL'].includes(r.method))
      .filter((r) => !matchAuditedRoute(r.method, r.path.replace(/:[A-Za-z]+/g, 'x')) && !NON_ACTION_ROUTES.some((n) => n.method === r.method && n.path === r.path))
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });
});
```
The last test reads Hono's route table from the app that `harness()` returns. Phase 3's own `audit.coverage.test.ts` checks the same rule for the whole app; this one exists so the Phase 7 branch fails fast on its own.

Run: `pnpm vitest run apps/daemon/test/p7/m7-exit.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 2: Check the M7 exit criteria by hand**

| Criterion (docs/05-roadmap.md, M7) | Evidence |
|---|---|
| Automations (F20): schedule, GitHub/Linear/Slack triggers, suggested tasks, run history | Tasks 2–10; `m7-exit.test.ts`; screenshot of `/automations` with one run in the history |
| Compare mode (F21) | Tasks 11–13; screenshot of `/compare/$groupId` with two variants and a picked winner |
| Supervisor (F23): opt-in, rules first, audited | Tasks 14–18; screenshot of the decisions log with one answer and one escalation |
| AGNC (optional): only if S4 succeeded | `plan/spikes/S4.md` decision; Tasks 19–21 (or the link-out card) |
| Packaging: Tauri 2 shell with tray count and quota, hotkey | Task 24 manual table a–f |
| Orchestrator MCP server | Task 22 Step 6 transcript |
| **Each item can be turned off** | `m7-exit.test.ts` "everything can be turned off" |
| **Budget and deny-list are enforced** | `m7-exit.test.ts` "budgets and the deny-list are enforced" |
| **Every action is audited** | `m7-exit.test.ts` "every action is audited" + `/audit` screenshot filtered to actor `automation` and `supervisor` |

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @orc/web build && pnpm --filter @orc/daemon build && pnpm --filter @orc/mcp build`
Expected: all green.

- [ ] **Step 3: Merge the contract additions into `plan/00-contracts.md`**

Apply the "Contract additions" section at the top of this file:
1. §1: add the `apps/desktop` Rust and npm dependencies and the `apps/mcp` dependencies.
2. §2: add `apps/mcp/` and `apps/desktop/` to the repository layout, plus the new daemon folders (`services/automations`, `services/compare`, `services/supervisor`, `services/git`, `services/launch`).
3. §3: add the `automations`, `supervisor`, `compare` and `agnc` config blocks, and the env vars `ORC_NOTIFY_BRIDGE` and `ORC_WEB_DIR`.
4. §4: add the audit action names (`automation.approve`, `automation.reject`, `compare.launch`, `compare.pick`, `compare.archive`, `supervisor.escalate`, `supervisor.feedback`, `supervisor.rule`, `agnc.prompt`, `agnc.create`, `agnc.connect`, `settings.update`).
5. §5: mark the phase-7 tables as shipped and add `automation_suggestions` and `supervisor_targets` to the table list.
6. §6: add the P7 routes, the three `LiveEvent` variants and the note that `linear.issueChanged` / `slack.mention` come from Phase 6.
7. §11: replace the `AutomationRun.status` union with the one that includes `awaiting_approval`, and add `AutomationRunDetail`, `TriggerSource`, `DiffStat`, `SuggestionService`, `CompareService`, `SupervisorImpl`, `AgncConnector` and the `DaemonContext` fields `suggestions`, `compare`, `agnc`.
8. Note in §11 that `automations` and `supervisor` hold the implementation types (`AutomationServiceImpl`, `SupervisorImpl`), which are supersets of the original interfaces.

- [ ] **Step 4: Update the status table and the README notes**

In `plan/README.md`, set the Phase 7 row to `✅ done` and, if AGNC ended as NO-GO, change its features cell to `F20, F21, F23, Tauri, MCP server (AGNC deferred — see spikes/S4.md)`.

Add one line to the "Global constraints" list:
```markdown
- **Unattended code** (automations, supervisor) never merges, deploys or touches prod, runs with a restricted Claude tool set, and is bound by budgets, caps and the deny-list. New write routes go into `AUDITED_ROUTES` or `NON_ACTION_ROUTES`.
```

- [ ] **Step 5: Commit and merge**

```bash
git add plan apps/daemon/test/p7/m7-exit.test.ts
git commit -m "docs(plan): record phase 7 outcomes and merge the contract additions"
git checkout main && git merge --no-ff phase/7-automations-compare-supervisor -m "merge: phase 7 automations, compare, supervisor, AGNC, MCP server and desktop shell"
```

---

## Self-review

**1. Spec coverage**

| Spec item | Where |
|---|---|
| F20 triggers: cron, GitHub review comment / check failed / PR merged, Linear assigned / labeled, Slack mention, manual | Tasks 6, 7 (`triggers.ts` maps each one), Task 9 (`/run`) |
| F20 action options: project, repo, worktree, headless or PTY, model, budget, timeout, plan approval | Tasks 2 (`AutomationAction`), 4, 5, 10 |
| F20 guardrails: off by default, per-automation switch, deny-list, no prod, concurrency and budget caps, never merge | Tasks 3, 4, 9, 25 (`m7-exit.test.ts`), plus the static `never-merge.test.ts` |
| F20 output: inbox item with recap, diff and PR link; history, logs, rerun, success rate | Tasks 4, 5, 9, 10 |
| F20 suggested tasks from the Linear backlog and new TODO/FIXME, accepted by hand | Task 8 |
| F21 launch N variants, one worktree each, cost multiplier before launch | Tasks 11, 13 |
| F21 compare view: status, diff, tests, cost, duration, recap; pick winner → review; archive losers with confirmation and audit | Tasks 12, 13 |
| F23 rules first, then Haiku classifier, allow-list only, deny-list, caps, budget, quiet hours, per-project and per-session switches, feedback rule, decisions log | Tasks 14–18 |
| F11 AGNC: list/detail/send prompt/handoff/create, OAuth in the Keychain, only my sessions | Tasks 19–21 |
| F12 picks: orchestrator MCP server, Tauri tray with waiting count and quota, global hotkey, native notifications | Tasks 22–24 |
| M7 exit: each item can be turned off, budget and deny-list enforced, every action audited | Task 25 |
| Architecture flow 7 (automations), flow 10 (supervisor), flow 11 (AGNC) | Tasks 4–9, 15–17, 20–21 |

**2. Placeholder scan** — no "TBD", "TODO", "similar to Task N" or "add error handling" is left. Every code step has complete code; the only conditional branches are the S4 GO/NO-GO split (Task 20 Step 1 spells out the NO-GO work) and the "only if Phase 6 did not ship it" poller note in Task 7, which names the exact check.

**3. Type consistency** — names checked end to end: `AutomationServiceImpl.start/run/runs/waitFor/approve/reject/rerun` (Tasks 4, 5, 9, 25); `TriggerFire` (Tasks 4, 6, 7); `AutomationRunDetail` fields used by the repo, the service, the routes, the client and the UI (Tasks 2, 4, 9, 10); `CompareService.launch/estimate/get/view/pickWinner/archiveLosers` (Tasks 11, 12, 13, 25); `SupervisorImpl` members (Tasks 17, 18, 25); `AgncConnector` (Tasks 1, 20, 21); `DiffStat` from one shared schema (Tasks 1, 2, 11); `sessionPk`/`splitPk` used instead of manual string slicing; `ServiceError` codes reused by the routes (`not_enabled`, `invalid_state`, `capacity_exceeded`, `over_budget`, `session_unknown`).

**4. Fixes applied during the review**
- Task 6 was rewritten to use Phase 5's persisted scheduler (`ensureCronJob`/`removeJobsOfType`) after that plan landed, instead of a Phase 7 cron decorator.
- The test fakes were updated for the Phase 3/5/6 shapes: `InboxEngineRuntime`, `ProjectServiceImpl`, the P4 `WorktreeService` (`createWith`, `archiveAs`, `list`, `get`, `findByCwd`), the P5 `UsageMeter`/`UsageSnapshot` and `RecapService`, and a `fakeLauncher` for P2's `LaunchService`.
- Every non-GET Phase 7 route is registered in `NON_ACTION_ROUTES` (Tasks 9, 12, 18, 21), because Phase 3 enforces audit coverage with a test.
- `DiffStatSchema` moved into `routes/p7-common.ts` (Task 1) so 7B does not depend on 7A.
- Node SEA was checked against the Node 22 docs and rejected (CommonJS-only entry, no native addons); Task 23 ships the Node binary as the sidecar with the daemon as a resource instead.
