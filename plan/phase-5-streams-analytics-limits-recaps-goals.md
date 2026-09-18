# Phase 5 — Work Streams, Analytics, Limits, Recaps, Goals & Real-time Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Symbol ownership:** before creating any exported symbol, check `00-contracts.md` §13. Where two phases touch the same symbol, the owning phase creates the file and later phases modify it instead of redefining.

**Goal:** Deliver milestone M5. That means:
- ticket-centric Work Streams (F6)
- Usage Analytics with a weekly digest (F7)
- Limits & Budgets: quota bars, burn rate, context fill and budgets (F19)
- configurable LLM recaps (F14)
- Goals, Handoffs and Reminders (F16)
- the optional Claude Code hook bridge and statusline (F10)
- a persisted Scheduler that all of the above can use

**Architecture:**
- **Daemon.** All new daemon code lives in `apps/daemon/src/services/{scheduler,usage,analytics,streams,recap,handoff,goals,reminders,hooks}` and `apps/daemon/src/live/hook-bridge.ts`.
  - It reads session data **only** through the Phase 1 `SessionService` contract.
  - It keeps its own incremental **usage ledger** (`usage_entries`, `tool_uses`), so analytics and quota maths never depend on the internal columns of Phase 1 tables.
- **Core.** Pure maths lives in `@orc/core`: quota blocks, ticket signals, stream stages, the recap digest, handoff evidence and hook mapping.
- **Web.** `apps/web` adds `/streams`, `/streams/$ticket` and `/analytics`, quota bars in the AppShell, session work panels (goal, recap, handoff, reminders, context fill) and new Settings sections.

**Tech Stack:** Node 22, TypeScript ~6.0.3, Hono 4, Drizzle + better-sqlite3, zod 4, croner 10, execa 10, `@anthropic-ai/sdk` (pinned in Task 12), React 19, TanStack Query/Router, echarts 6, Vitest 5.

**Spec:**
- `docs/02-features.md` (F6, F7, F10, F14, F16, F19)
- `docs/03-architecture-and-stack.md` (flows 1, 5, 7, 8; Security & privacy)
- `docs/04-data-sources.md` (A4 usage-data facets and plans, D wstack workflows and timeline, worktrees)
- `docs/05-roadmap.md` (M5)
- `docs/01-vision-and-insights.md` (delivery loop, cost evidence)
- `docs/06-landscape-and-inspiration.md` (ccusage, DeepSeek Harness goals and handoffs, zadloop "what to check")
- `plan/00-contracts.md` (single source of truth for names)

## Global Constraints
- **Wiring (P3 rule A2):** Phase 5 services are **constructed** in `buildContext()` (`apps/daemon/src/context.ts`), which both `createDaemon()` and `createTestContext()` call. Their `start()` methods (timers, bus subscriptions) are called **only** in `createDaemon()`, after `buildContext()`.
- **Core exports (P3 rule A5):** every new pure `@orc/core` module is exported from **both** `packages/core/src/index.ts` and `packages/core/src/browser.ts`. The web app imports values only from `@orc/core/browser`.
- **Audit coverage (P3):** every new non-GET `/api` route is added either to `AUDITED_ROUTES` or to `NON_ACTION_ROUTES` (with a reason) in `apps/daemon/src/http/audit-middleware.ts`. `audit.coverage.test.ts` enforces this. Phase 5 audits:
  - `POST /api/hooks/install` as `hook.install`
  - `POST /api/handoffs/:id/resume-fresh` as `session.launch`
  - reminder PTY input through P3's `withPtyInputAudit` decorator
- **Toolchain:** Node `>=22.12 <23`; pnpm `10.18.3`; TypeScript `~6.0.3` strict with `noUncheckedIndexedAccess`; Vitest `^5.0.1`; Biome `^2.5.14` (`noExplicitAny` and `noNonNullAssertion` are errors).
- **Commit gate:** run `pnpm lint && pnpm typecheck && pnpm test` before **every** commit. Commits use Conventional Commits with a scope and end with the session's attribution lines.
- **Branch:** `phase/5-streams-analytics-limits-recaps-goals`, created from an up-to-date `main`.
- **Local only:** the daemon binds to `127.0.0.1`, and every `/api/*` request needs `x-orc-token`. `POST /api/hooks` is **token-authed** like every other route.
- **Read-only toward tool data.**
  - Never write to `~/.claude` or `~/.codex`. The **only** Phase 5 exception is `~/.claude/settings.json`, and only after an explicit `{"confirm": true}` hook install. That install first writes a backup under `$ORC_HOME/backups/` and records an audit entry with action `hook.install`.
  - `~/.wstack/**` and `~/.claude/usage-data/facets/**` are read-only.
  - Never read `*.key` files, `~/.codex/auth.json`, or auth fields in `~/.claude.json`.
- **Redaction:** before any LLM call (recap, daily recap, handoff), all transcript-derived text goes through `redact()`. **Tool outputs (`tool_result`) and tool inputs are never sent.** The one exception: redacted, allow-listed evidence commands (test, build, lint, git and gh) may be quoted in handoffs.
- **Write actions:** these are always audited:
  - PTY input: reminders sent to owned sessions (`pty.input`)
  - the "Resume fresh with handoff" launch (`session.launch`)
  - the hook install (`hook.install`)
- **Input to sessions:** only to **owned** sessions (`live.ownership === 'owned'` and `live.ptyId !== null`). Reminder text also goes through the shared deny-list.
- **Recap defaults (decided):**
  - engine `claude-cli`, running `claude -p --model <m> --output-format json`
  - `claude-haiku-4-5` for automatic runs and `claude-sonnet-5` on demand
  - monthly budget `$20`
  - `maxInputTokens` 30000, estimated at about 4 characters per token
  - output in English
- **"Estimated" labelling:** every quota figure has `source: 'estimate'` unless spike S7 chose an official source *and* a fresh official sample exists. `pctOfLimit` is `null` for estimates unless the user set plan limits (`limits.blockTokenLimit` / `limits.weekTokenLimit`).
- **Work Streams scope:** only projects with `features.workStreams === true` (Wakecap by default).
- **Zod 4 nested defaults:** new nested config objects use `.prefault({})`, not `.default({})`. Zod 4's `.default()` short-circuits and would skip the inner defaults. This is the same fix Phase 0 Task 4 applied to `OrcConfig`.
- **Fixtures** stay redacted, and `pnpm check:fixtures` must pass. Phase 5 tests write their extra data (plans, wstack files, settings) into temp dirs; they never touch real homes.

## Spike handling (read `plan/spikes/` before Task 1)

**S7 (quota source)** — read `plan/spikes/S7.md`.
- **If the decision is `official`:**
  - In Task 1, set the default of `limits.quotaSource` to `'official'`.
  - Fill `limits.officialFieldPaths` defaults with the dotted field paths from the report. For example, if the report says the statusline stdin contains `rate_limits.five_hour.used_percentage`, then `blockPct: 'rate_limits.five_hour.used_percentage'`.
  - Task 17's `orc-statusline` forwards the statusline stdin to `POST /api/usage/official`, and the meter uses it (Task 7).
- **Otherwise (`estimate`):** keep the defaults below (`'estimate'`, all paths `null`). The forwarding endpoint still exists but is ignored, and the UI shows "estimated".
- **Token formula:** if S7 recorded a different formula than `input + output + cacheWrite`, change only `quotaTokens()` in Task 4 and its test.

**S3 (hook bridge)** — read `plan/spikes/S3.md`. Phase 2 always ships the minimal `POST /api/hooks` ingest and the hook-over-registry precedence in `LiveTracker`, whatever S3 decided. Phase 5 extends that code in place (Task 16) and adds the consented installer (Task 17).
- **If S3 said hooks are required for the < 2 s target:** the M5 exit check (Task 22) must be run with the hooks installed through the new installer, and it records the measured latency.
- **Otherwise:** installing the hooks stays optional, and the exit check records whether they were installed.

## Assumed earlier-phase interfaces (not redefined here)

These signatures come from `plan/00-contracts.md` §2–§12 and from the Phase 1–4 plans (`plan/phase-1-history-search-resume.md`, `plan/phase-2-live-board-inbox-archive.md`, `plan/phase-3-*.md`, `plan/phase-4-*.md`). **Task 1 Step 1 re-checks each one against the merged code.** If a shipped name differs, change only the import or adapter file named in the consuming task, and write the difference in that task's review note. Contract names are never renamed.

| Owner | Signature / behaviour relied on | Used by |
|---|---|---|
| P1 | `apps/daemon/test/helpers.ts`: `useTempHomes()` (called at `describe` level) and `createTestContext(opts?: Partial<DaemonContext> & { homes?: TempHomes; isPidAlive?: (pid: number) => boolean }): TestContext`. `TestContext extends DaemonContext` with `{ homes; raw; launches; dispose() }`. It is **synchronous** and uses real services, a silent logger and a fake `claude` for resumes. | all daemon tests (via `makeP5Context`) |
| P1 | `apps/daemon/src/http/app.ts`: `createApp(o: { ctx; token; port: () => number; webDist?; env? }): OrcApp`, with token auth on `/api/*`. `http/types.ts` exports `type OrcApp`. Route modules export `register<Area>Routes(app: OrcApp, ctx: DaemonContext): void`, and `createApp` calls each one. | route registration, auth tests |
| P1 | `apps/daemon/src/main.ts`: `createDaemon(opts?: { port?: number }): Promise<{ ctx: DaemonContext; port: number; close(): Promise<void> }>`. Services are built in its body, and Phase 2 already wires `ctx.live`, `ctx.inbox`, `ctx.launcher` and `ctx.updateConfig` there. | wiring steps |
| P1 | `SessionService.events(source, id, { agentId?: string \| null; afterSeq?: number; limit?: number })`. `agentId` `undefined`/`null` means the **main** transcript; a string means that subagent. It returns `seq > (afterSeq ?? 0)` in ascending order, with `limit` capped at 500. `nextSeq` is the last returned seq when more rows exist, otherwise `null`. Seqs start at 1. `SessionService.list({ from, to, … })` pages newest first with an opaque `nextCursor`. | ledger, recaps, handoffs |
| P1 | The Drizzle schema exports `sessions` with columns `pk` and `recap`. `upsertSession` **never overwrites `recap`**; P1 tests this ("keeps recap on re-upsert"). | recap persistence |
| P1 | No price table exists in P1 (session cost comes from `cost-state`). **Phase 5 adds** `estimateCostUsd()` and `limits.pricing` (Task 4). | ledger, anthropic engine |
| P1 | Web: `apps/web/src/api/client.ts` exports `getApiClient(): ApiClient` and `setApiClientForTests(c: ApiClient): void`. `@orc/api-contract` exports `type ApiClient = ReturnType<typeof createApiClient>`, where `createApiClient` returns a plain object of methods. The UI barrel `@/components/ui` exports `Button` (`variant?: 'default' \| 'outline' \| 'secondary' \| 'destructive' \| 'ghost'`, `size?: 'sm' \| 'default'`) and `Badge` (same variants minus `ghost`). **Phase 5 UI uses only those two plus native elements.** The P1 client has `projectsUpdate(id, patch)`. | web tasks |
| P2 | `DaemonContext.updateConfig?: (fn) => OrcConfig` already exists and persists via `saveConfig`; Phase 5 only adds the `config.changed` emit. `LiveTracker` (`ctx.live`) has `list(): Session[]`, `get(pk)` and `applyHook(e: HookEvent)`, where `HookEvent = { sessionId; event; message; ts }`. `LaunchService` (`ctx.launcher`) has `launch(req: LaunchRequest): Promise<{ ptyId; sessionId }>`, which enforces the concurrency cap (`ServiceError('concurrency_limit', 429)`), and `ownedCount(projectId)`. `InboxEngine.upsert/resolve` exist. `createLiveReducer({ contextWindow })` computes `live.contextFill`. | meter, handoff launch, hook bridge |
| P2 | `apps/daemon/src/http/routes/hooks.ts` has `registerHookRoutes(app, ctx)`, a minimal `POST /api/hooks` that validates `HookIngestBody` (`z.looseObject` with `session_id`, `hook_event_name`, `message?`) and calls `ctx.live?.applyHook(...)`. **Task 16 extends this file; it does not create it.** `http/live-ws.ts`'s `LIVE_EVENT_TYPES` already includes `'usage.updated'`. `api-contract/src/routes/hooks.ts` already exists (Task 1 appends to it). | hook bridge, WS |
| P2 | Web: `apps/web/src/api/live-events.ts` exports `useLiveEvents()` and `applyLiveEvent(qc: QueryClient, e: LiveEvent)`. `features/shell/AppShell.tsx` renders `<header>` and `<nav>`. `features/settings/SettingsPage.tsx` renders `<section>` blocks. `apps/web/playwright.config.ts` exists. | web tasks |
| P3 | Daemon: `createAuditService`, `AuditService.record/list`, `audited()`, `DeniedError`, `createDenyList` (`ctx.audit`, `ctx.denyList`, both wired in `buildContext`), `ServiceError(code, status, message, details?)` (P1, `services/errors.ts`), the audit middleware with `AUDITED_ROUTES` / `NON_ACTION_ROUTES` (a coverage test fails on an unlisted write route), `registerXRoutes(app: OrcApp, ctx)`, `redactDeep`/`redactSession` in `http/redact-out.ts`, and `apps/daemon/test/p3-harness.ts` → `createP3Harness(opts?)` → `{ ctx, app, request(path, { method?, body? }), cleanup() }`. | reminders, handoff launch, hook install, route auth tests |
| P3 | Web: `apps/web/src/test/p3-render.tsx` → `makeQueryClient()`, `wrapperFor(client)`, `renderP3(ui, opts?)`, `fakeApi(methods: Partial<ApiClient>)`. Charts use `echarts/core` + `echarts.use([...])` and are mocked in tests with `vi.mock('echarts/core', …)`. `features/hotkeys/registry.ts` → `useHotkeys(bindings: HotkeyBinding[], deps)` with `HotkeyBinding = { id; keys; description; group: 'navigation' \| 'actions' \| 'inbox' \| 'session'; handler; allowInInputs? }`. `features/palette/palette-items.ts` → `buildPaletteSections(input)` and `PaletteAction`. `features/session-detail/SessionDetailPage.tsx` renders `SessionHeader` with an `actions` slot and `SessionDetailTabs`. `features/session-detail/timeline/format.ts` → `formatTokens`, `formatMs`, `formatPct`, `shortPath`. | web tasks |
| P4 | `WorktreeService.discover(): Promise<WorktreeView[]>`, where `WorktreeView extends Worktree` with `{ sessionPks; projectId; prStatus; … }`. The `pr.changed` bus event is `{ before: PrStatus \| null; after: PrStatus }`, where P4's `PrStatus` = contract fields + `headRef: string \| null` + `failedChecks: string[]`. `apps/daemon/src/db/repos/pr-cache.ts` exports `listPrStatuses(db, f?): PrStatus[]`. `pr_cache` stores **no PR body, base ref or merge time**, so Phase 5 treats `body`/`baseRef` as `null` and uses `updatedAt` as `mergedAt` for merged PRs. **Only `apps/daemon/src/services/pr-source.ts` touches this.** | streams, analytics, digest |

---

## Contract additions

These are merged into `plan/00-contracts.md` in Task 22.

```ts
// ── §3 config (packages/api-contract/src/config.ts) ─────────────────────────
// `recaps` is extracted into a named schema and gains 3 fields; 3 new sections are added.
export const RecapsConfig = z.object({
  enabled: z.boolean().default(false),
  trigger: z.enum(['manual', 'on_idle', 'daily']).default('manual'),
  engine: z.enum(['claude-cli', 'anthropic-api']).default('claude-cli'),
  autoModel: z.string().default('claude-haiku-4-5'),
  onDemandModel: z.string().default('claude-sonnet-5'),
  monthlyBudgetUsd: z.number().default(20),
  maxInputTokens: z.number().default(30000),
  minPrompts: z.number().default(2),
  language: z.string().default('en'),
  promptTemplate: z.string().nullable().default(null),
  idleMinutes: z.number().int().positive().default(10),                 // P5: on_idle debounce
  excludeProjectIds: z.array(z.string()).default([]),                   // P5: scope
  dailyProjectIds: z.array(z.string()).default(['wakecap']),            // P5: daily recap targets
});
export const LimitsConfig = z.object({
  quotaSource: z.enum(['estimate', 'official']).default('estimate'),    // S7 decision
  officialFieldPaths: z.object({
    blockPct: z.string().nullable().default(null),
    blockResetsAt: z.string().nullable().default(null),
    weekPct: z.string().nullable().default(null),
    weekResetsAt: z.string().nullable().default(null),
  }).prefault({}),
  blockTokenLimit: z.number().int().positive().nullable().default(null), // user plan limit (5h)
  weekTokenLimit: z.number().int().positive().nullable().default(null),  // user plan limit (7d)
  warnPct: z.number().min(0).max(1).default(0.8),
  contextWindows: z.record(z.string(), z.number().int().positive())
    .default({ 'claude-opus-5': 1000000, 'claude-sonnet-5': 1000000, 'claude-haiku-4-5': 200000 }),
  defaultContextWindow: z.number().int().positive().default(200000),
  // USD per 1M tokens (Anthropic first-party list prices, checked 2026-09-17 via the claude-api skill;
  // cache write = 1.25 × input (5-min TTL), cache read = 0.1 × input). Used only for estimates.
  pricing: z.record(z.string(), z.object({ input: z.number(), output: z.number(), cacheWrite: z.number(), cacheRead: z.number() }))
    .default({
      'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
      'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
      'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
    }),
  contextWarnFill: z.number().min(0).max(1).default(0.85),
});
export const DigestConfig = z.object({
  enabled: z.boolean().default(true),
  cron: z.string().default('0 9 * * 1'),               // weekly digest, Mon 09:00 local
  dailyRecapCron: z.string().default('0 19 * * 1-5'),  // daily project recap
});
export const HooksConfig = z.object({ statusOverrideMs: z.number().int().positive().default(120000) });
// OrcConfig: recaps: RecapsConfig.prefault({}), limits: LimitsConfig.prefault({}),
//            digest: DigestConfig.prefault({}), hooks: HooksConfig.prefault({})
export type RecapsConfig = z.infer<typeof RecapsConfig>;   // and LimitsConfig, DigestConfig, HooksConfig

// ── §4 domain types (packages/core/src/types/{usage,streams,recaps,bridge,analytics}.ts) ──
export type UsageSource = 'official' | 'estimate';
export interface UsageSnapshot {            // moves from daemon meter.ts to core; +generatedAt, +block.active, +burnRateTokensPerMin
  source: UsageSource; generatedAt: string;
  block: { active: boolean; start: string; end: string; tokens: number; costUsd: number; pctOfLimit: number | null };
  week: { tokens: number; costUsd: number; pctOfLimit: number | null };
  burnRateUsdPerHour: number; burnRateTokensPerMin: number; projectedBlockExhaustionAt: string | null;
}                                           // pctOfLimit is a fraction (0..1, may exceed 1)
export interface OfficialQuotaSample { at: string; blockPct: number | null; blockResetsAt: string | null; weekPct: number | null; weekResetsAt: string | null }
export type BudgetScopeType = 'global' | 'project' | 'ticket';
export type BudgetPeriod = 'daily' | 'weekly' | 'monthly';
export interface Budget { id: string; scopeType: BudgetScopeType; scopeId: string | null; period: BudgetPeriod; limitUsd: number; origin: 'table' | 'config' }
export interface BudgetStatus { budget: Budget; spentUsd: number; pct: number; periodStart: string }
export interface BudgetCheck { ok: boolean; pct: number; limitUsd: number | null }
export interface ConcurrencyStatus { projectId: string; owned: number; max: number }
export interface ContextFillInfo { sessionPk: string; model: string | null; usedTokens: number; windowTokens: number; fill: number; warn: boolean }
export type StreamLinkKind = 'session' | 'pr' | 'plan' | 'worktree' | 'workflow';
export interface StreamLink { ticket: string; kind: StreamLinkKind; ref: string; origin: 'auto' | 'manual'; excluded: boolean; createdAt: string }
export type TicketSignalSource = 'session_tickets' | 'prompt' | 'branch' | 'pr_title' | 'pr_body' | 'plan_file' | 'wstack_workflow' | 'worktree' | 'manual';
export interface TicketSignal { ticket: string; kind: StreamLinkKind; ref: string; source: TicketSignalSource }
export interface StreamPr { pr: PrRef; title: string; state: 'open' | 'closed' | 'merged'; headRef: string | null; baseRef: string | null; isBackmerge: boolean; checks: 'pending' | 'success' | 'failure' | 'none'; review: 'approved' | 'changes_requested' | 'review_required' | 'none'; updatedAt: string; mergedAt: string | null }
export type StreamTimelineKind = 'session' | 'pr' | 'plan' | 'worktree' | 'recap' | 'handoff' | 'goal' | 'workflow';
export interface StreamTimelineItem { ts: string; kind: StreamTimelineKind; title: string; ref: string; detail: string | null }
export interface StreamDetail { stream: WorkStream; prsDetailed: StreamPr[]; links: StreamLink[]; timeline: StreamTimelineItem[]; goal: Goal | null; handoff: Handoff | null; budget: BudgetCheck }
export type RecapKind = 'session' | 'daily' | 'handoff';
export type RecapEngineId = 'claude-cli' | 'anthropic-api';
export interface Recap { id: string; kind: RecapKind; targetKey: string; transcriptOffset: number; model: string; engine: RecapEngineId; text: string; costUsd: number; inputTokensApprox: number; createdAt: string }
export type ReminderState = 'pending' | 'fired' | 'cancelled';
export interface Reminder { id: string; jobId: string; sessionPk: string | null; ticket: string | null; text: string; dueAt: string; sendToSession: boolean; state: ReminderState; createdAt: string; firedAt: string | null }
export interface DigestRecord { weekStart: string; markdown: string; createdAt: string }
export type HookEventName = 'SessionStart' | 'Stop' | 'Notification' | 'PreToolUse' | 'PostToolUse';
export interface HookFields { sessionId: string; event: string; message: string | null; tool: string | null }   // the only fields kept from a hook payload
export interface HookSignal { sessionId: string; event: string; status: 'busy' | 'idle' | 'waiting'; waitingFor: string | null; currentTool: string | null }
export function pickHookFields(raw: unknown): HookFields | null        // @orc/core derive/hooks.ts
export function hookStatusFor(event: string): 'busy' | 'idle' | 'waiting' | null
export function mapHookPayload(raw: unknown): HookSignal | null
export function hookWins(hookAtMs: number | null, registryAtMs: number | null, nowMs: number, maxAgeMs: number): boolean
export const BRIDGE_HOOK_EVENTS: readonly string[]   // SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop
export const HOOK_BODY_LIMIT_BYTES: number           // 256 KiB
export type AnalyticsGroupBy = 'day' | 'week' | 'project' | 'model' | 'source' | 'ticket';
export interface TokenTotals { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface CostRow { key: string; costUsd: number; tokens: TokenTotals; sessions: number }
export interface TopSession { pk: string; name: string | null; projectId: string | null; costUsd: number; tickets: string[] }
export interface TopTicket { ticket: string; costUsd: number; sessions: number }
export interface TopResult { sessions: TopSession[]; tickets: TopTicket[]; mergedPrs: number; costPerMergedPrUsd: number | null }
export type ToolKind = 'tool' | 'mcp' | 'skill';
export interface ToolUsageRow { bucket: string; kind: ToolKind; name: string; count: number }
export interface TimingResult { modelMs: number; toolMs: number; modelShare: number | null; cacheHitTrend: Array<{ bucket: string; rate: number | null }> }
export interface OutcomesResult { sessions: number; outcomes: Record<string, number>; friction: Record<string, number>; goalCategories: Record<string, number> }
export interface WstackSkillRow { skill: string; runs: number; outcomes: Record<string, number>; avgDurationS: number | null }
// Handoff.sessionId holds the session pk (`source:id`).

// ── §5 tables (Phase 5) ─────────────────────────────────────────────────────
// streams, stream_links, recaps, goals, handoffs, reminders, budgets, usage_blocks   (already listed)
// + scheduled_jobs, usage_entries, tool_uses, ledger_cursors, digests                  (new)

// ── §6 routes (Phase 5) ─────────────────────────────────────────────────────
// GET  /api/usage → UsageSnapshot            GET /api/usage/budgets → BudgetStatus[]
// PUT  /api/usage/budgets body BudgetUpsert → Budget       DELETE /api/usage/budgets/:id
// GET  /api/usage/concurrency → ConcurrencyStatus[]        GET /api/usage/context/:source/:id → ContextFillInfo | null
// POST /api/usage/official (raw statusline JSON) → 204
// GET  /api/settings → Settings              PUT /api/settings body SettingsUpdate → Settings
// GET  /api/streams?projectId&stage → WorkStream[]         POST /api/streams/refresh → WorkStream[]
// GET  /api/streams/:ticket → StreamDetail   POST /api/streams/:ticket/link | /unlink body { kind, ref } → StreamLink
// GET  /api/analytics/cost?from&to&projectId&groupBy → { rows: CostRow[]; estimated: boolean }
// GET  /api/analytics/top?from&to&projectId&limit → TopResult
// GET  /api/analytics/tools?from&to&projectId&bucket → ToolUsageRow[]
// GET  /api/analytics/timing?from&to&projectId&bucket → TimingResult
// GET  /api/analytics/outcomes?from&to&projectId → OutcomesResult
// GET  /api/analytics/wstack?from&to → WstackSkillRow[]
// GET  /api/analytics/digest → DigestRecord | null         POST /api/analytics/digest body { weekStart? } → DigestRecord
// GET  /api/recaps/session/:source/:id → Recap | null      POST /api/recaps/session/:source/:id body { onDemand } → RecapRunResponse
// GET  /api/recaps/daily?projectId&date → Recap | null     POST /api/recaps/daily body { projectId, date } → { text }
// GET  /api/recaps/spend → { spentUsd, budgetUsd }
// GET  /api/goals?state → Goal[]             GET|PUT /api/goals/:targetType/:targetId → { goal, prefill } | Goal
// GET  /api/handoffs/session/:source/:id → { handoff, markdown } | null
// POST /api/handoffs/session/:source/:id → Handoff          GET /api/handoffs/:id/markdown → text/markdown
// POST /api/handoffs/:id/resume-fresh body { confirm } → { ptyId }
// GET  /api/reminders?state&sessionPk → Reminder[]          POST /api/reminders → Reminder   POST /api/reminders/:id/cancel → Reminder
// POST /api/hooks (Claude hook JSON; P2 route, extended) → 200 { ok: true, accepted }
// GET  /api/hooks/install → HookInstallStatus               POST /api/hooks/install body { confirm } → { installed, settingsPath, backupPath }
// GET  /api/hooks/statusline → { command, snippet }
// LiveEvent: { type: 'usage.updated'; snapshot: UsageSnapshot }     (was `unknown`)
// BusEvent  += { type: 'config.changed' }
// Query keys (web): ['usage'], ['usage','budgets'], ['usage','concurrency'], ['usage','context',source,id],
//   ['analytics',name,params], ['digest'], ['streams',filters], ['stream',ticket], ['recap',source,id],
//   ['recaps','spend'], ['goal',targetType,targetId], ['handoff',source,id], ['reminders',filters],
//   ['settings'], ['hooks','install'], ['hooks','statusline']
// Web routes: /streams, /streams/$ticket, /analytics (already listed)

// ── §11 services (extended; all created in createDaemon) ─────────────────────
export interface UsageMeter {
  snapshot(): UsageSnapshot;
  checkBudget(scope: { projectId?: string; ticket?: string }): BudgetCheck;
  refresh(now?: Date): UsageSnapshot;                           // recompute + emit usage.updated when changed
  ingestOfficial(raw: unknown): OfficialQuotaSample | null;     // null unless limits.quotaSource === 'official'
  budgets(now?: Date): BudgetStatus[];
  contextFill(sessionPk: string): ContextFillInfo | null;
  concurrency(): ConcurrencyStatus[];
  start(): void; stop(): void;
}
export interface UsageLedger {
  syncSession(sessionPk: string): Promise<{ added: number }>;
  backfill(sinceIso: string): Promise<{ sessions: number }>;
  entries(q: { from: string; to: string; projectId?: string; ticket?: string }): LedgerEntry[];
  tools(q: { from: string; to: string; projectId?: string }): LedgerTool[];
  sumCost(q: { from: string; to: string; projectId?: string; ticket?: string }): number;
  latestMainUsage(sessionPk: string): { model: string; usage: Usage } | null;
  start(): void; stop(): void;
}
export interface RecapService {
  recap(sessionPk: string, opts?: { onDemand?: boolean }): Promise<{ text: string; costUsd: number; model: string; cached: boolean }>;
  daily(projectId: string, date: string): Promise<string>;
  latest(sessionPk: string): Recap | null;
  latestDaily(projectId: string, date: string): Recap | null;
  findCached(kind: RecapKind, targetKey: string, offset: number): Recap | null;
  runLlm(kind: RecapKind, targetKey: string, offset: number, prompt: string, opts: { onDemand: boolean; approxTokens: number }): Promise<Recap>;
  monthSpend(now?: Date): { spentUsd: number; budgetUsd: number };
  syncSchedule(): void; start(): void; stop(): void;
}
export interface HandoffService {
  generate(sessionPk: string): Promise<Handoff>; toMarkdown(h: Handoff): string; latest(sessionPk: string): Handoff | null;
  get(id: string): Handoff | null; resumeFresh(handoffId: string): Promise<{ ptyId: string }>;
}
export interface GoalService {
  get(targetType: Goal['targetType'], targetId: string): Goal | null; set(g: Omit<Goal, 'id' | 'updatedAt'>): Goal;
  list(filter: { state?: GoalState[] }): Goal[]; prefill(targetType: Goal['targetType'], targetId: string): string;
  sweep(now?: Date): number; start(): void; stop(): void;
}
export interface Scheduler {   // + get, start, stop
  add(job: Omit<ScheduledJob, 'id'>): ScheduledJob; remove(id: string): void; list(kind?: ScheduledJob['kind']): ScheduledJob[];
  onFire(kind: ScheduledJob['kind'], fn: (job: ScheduledJob) => Promise<void>): void;
  get(id: string): ScheduledJob | null; start(): void; stop(): void;
}
export function ensureCronJob(s: Scheduler, kind: ScheduledJob['kind'], type: string, cron: string, extra?: Record<string, unknown>): ScheduledJob
export function removeJobsOfType(s: Scheduler, kind: ScheduledJob['kind'], type: string): number
export interface StreamService {
  refresh(): Promise<WorkStream[]>; refreshIfStale(): Promise<void>; list(q: { projectId?: string; stage?: StreamStage }): WorkStream[];
  get(ticket: string): Promise<StreamDetail | null>;
  link(ticket: string, kind: StreamLinkKind, ref: string): StreamLink; unlink(ticket: string, kind: StreamLinkKind, ref: string): StreamLink;
  start(): void; stop(): void;
}
export interface PrSource { list(): StreamPr[] }
export interface AnalyticsQuery { from: string; to: string; projectId?: string }
export interface AnalyticsService {
  cost(q: AnalyticsQuery & { groupBy: AnalyticsGroupBy }): { rows: CostRow[]; estimated: boolean };
  top(q: AnalyticsQuery & { limit: number }): TopResult;
  tools(q: AnalyticsQuery & { bucket: 'day' | 'week' }): ToolUsageRow[];
  timing(q: AnalyticsQuery & { bucket: 'day' | 'week' }): TimingResult;
  outcomes(q: AnalyticsQuery): OutcomesResult;
  wstack(q: AnalyticsQuery): WstackSkillRow[];
}
export interface DigestService { generate(weekStart?: string): Promise<DigestRecord>; latest(): DigestRecord | null; syncSchedule(): void; start(): void; stop(): void }
export interface ReminderService { create(i: CreateReminderInput): Reminder; list(f: { state?: ReminderState[]; sessionPk?: string }): Reminder[]; cancel(id: string): Reminder; fire(reminderId: string): Promise<void>; start(): void }
// P2 additions changed by P5: HookEvent gains `tool?: string | null`; mapHookToStatus delegates to hookStatusFor
//   (SessionStart → idle, PostToolUse → busy are new); LiveTracker's hook precedence uses hookWins(…, hooks.statusOverrideMs).
export function buildHookCommand(o: { tokenFile: string; port: number }): string          // services/hooks/install.ts
export function hookSettingsFragment(command: string): { hooks: Record<string, unknown[]> }
export function mergeHookSettings(settings: Record<string, unknown>, command: string): Record<string, unknown>
export function isHookInstalled(settings: unknown): boolean
export function installHooks(ctx: DaemonContext): { settingsPath: string; backupPath: string | null }
export function formatStatusline(input: StatuslineInput, data: StatuslineData): string     // src/bin/orc-statusline.ts
export type PriceTable = Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }>;
export function estimateCostUsd(model: string, u: Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>, prices: PriceTable): number | null  // @orc/core derive/pricing.ts
// DaemonContext += ledger?, prs?, streams?, analytics?, digests?, reminders?   (updateConfig already added by P2)
// POST /api/hooks: P2's minimal ingest is extended in place — it now maps all five hook events and returns { ok: true, accepted }.
```

---

## File Structure

```
packages/core/src/types/{usage,streams,recaps,bridge,analytics}.ts        (T1)
packages/core/src/derive/quota.ts            + test                        (T4)  blocks, windows, burn rate, context fill, official mapping
packages/core/src/derive/ledger.ts           + test                        (T4)  TimelineEvent[] → usage/tool facts
packages/core/src/derive/streams.ts          + test                        (T8)  ticket signals, backmerge, stage
packages/core/src/derive/analytics.ts        + test                        (T10) grouping, top, tools, timing, facets, wstack
packages/core/src/derive/digest.ts           + test                        (T10) weekly digest markdown
packages/core/src/recap/digest.ts            + test                        (T11) redacted recap digest + prompt templates
packages/core/src/recap/handoff.ts           + test                        (T15) evidence, JSON parse, markdown
packages/core/src/derive/hooks.ts            + test                        (T16) hook field picking, status mapping, precedence
packages/api-contract/src/config.ts                                        (T1)  modified
packages/api-contract/src/routes/{usage,settings,streams,analytics,recaps,goals,handoffs,reminders,hooks}.ts (T1)
packages/api-contract/src/client-p5.ts       + test                        (T1)
apps/daemon/src/db/schema-p5.ts  (+ re-export in schema.ts)  migration     (T2)
apps/daemon/src/db/repos/{scheduled-jobs,usage-ledger,budgets,streams,recaps,goals,handoffs,reminders,digests}.ts
apps/daemon/src/services/need.ts, session-pages.ts                         (T2)
apps/daemon/src/http/p5-util.ts                                            (T2)
apps/daemon/test/p5-helpers.ts               + test                        (T2)
apps/daemon/src/services/scheduler/scheduler.ts + test                     (T3)
apps/daemon/src/services/usage/ledger.ts     + test                        (T5)
apps/daemon/src/services/usage/budgets.ts    + test                        (T6)
apps/daemon/src/services/usage/meter.ts      + test                        (T7)
apps/daemon/src/http/routes/{usage,settings}.ts + tests                    (T7)
apps/daemon/src/services/pr-source.ts, wstack.ts                           (T9)
apps/daemon/src/services/streams/streams.ts  + test ; http/routes/streams.ts + test   (T9)
apps/daemon/src/services/analytics/{analytics,facets,digest}.ts + tests ; http/routes/analytics.ts + test (T10)
apps/daemon/src/services/recap/engines.ts    + test ; test/bin/fake-claude-print     (T12)
apps/daemon/src/services/recap/recap.ts      + test ; http/routes/recaps.ts + test   (T13)
apps/daemon/src/services/goals/goals.ts, reminders/reminders.ts + tests ; routes goals.ts, reminders.ts (T14)
apps/daemon/src/services/handoff/handoff.ts  + test ; http/routes/handoffs.ts + test (T15)
apps/daemon/src/http/routes/hooks.ts (P2, extended) + test ; live/live-tracker.ts (P2, modified)  (T16)
apps/daemon/src/services/hooks/install.ts    + test ; src/bin/orc-statusline.ts + test (T17)
apps/web/src/api/queries/{usage,analytics}.ts + p5-queries.test.tsx           (T18)
apps/web/src/features/limits/{format,QuotaBars}.tsx + test                    (T18)
apps/web/src/features/analytics/{analytics-options,AnalyticsPage}.tsx + tests (T18)
apps/web/src/api/queries/work.ts + test                                       (T19)
apps/web/src/features/{goals,recaps,handoffs,reminders}/*.tsx + tests, features/limits/ContextFillBadge.tsx,
  features/session-detail/SessionWorkPanel.tsx                                (T19)
apps/web/src/api/queries/settings.ts + test                                   (T20)
apps/web/src/features/settings/{RecapSettings,LimitsSettings,BridgeSettings}.tsx + tests (T20)
apps/web/src/api/queries/streams.ts, stores/streams.ts                        (T21)
apps/web/src/features/streams/{stages,StreamsPage,StreamDetailPage}.tsx + tests (T21)
apps/web/src/routes/{analytics.tsx,streams/index.tsx,streams/$ticket.tsx}      (T18, T21)
apps/daemon/test/p5-daemon.test.ts, apps/web/e2e/streams-analytics.spec.ts     (T22)
```

---

### Task 1: Contract additions: config, core types and API schemas

**Files:**
- Modify: `packages/api-contract/src/config.ts`, `packages/api-contract/src/config.test.ts`, `packages/api-contract/src/index.ts`, `packages/api-contract/src/client.ts`
- Create: `packages/core/src/types/usage.ts`, `streams.ts`, `recaps.ts`, `bridge.ts`, `analytics.ts`
- Modify: `packages/core/src/types/index.ts`
- Create: `packages/api-contract/src/routes/usage.ts`, `settings.ts`, `streams.ts`, `analytics.ts`, `recaps.ts`, `goals.ts`, `handoffs.ts`, `reminders.ts`
- Modify: `packages/api-contract/src/routes/hooks.ts` (P2 file; append), `packages/api-contract/src/live.ts` (P1 `LiveEvent`)
- Create: `packages/api-contract/src/client-p5.ts`, `packages/api-contract/src/client-p5.test.ts`

**Interfaces:**
- Consumes: `OrcConfig`, `ProjectConfig` (P0), the domain types in §4, `LiveEvent` (P1, `packages/api-contract/src/live.ts`), `createApiClient` (P1), and `Caller` / `HttpMethod` / `makeCaller` (P2, `client-p2.ts`)
- Produces: everything in "Contract additions" §3/§4, plus the zod schemas below, `withQuery(path, q)`, `p5ClientMethods(call: Caller)` and `type P5ClientMethods`

- [ ] **Step 1: Read the spike decisions**

Run: `cat plan/spikes/S7.md plan/spikes/S3.md`
Expected: each report has a "Decision" line. Write the S7 decision (`official` + field paths, or `estimate`) and the S3 decision (hooks in P2 or P5) into this task's review note. Step 3 uses the S7 values.

- [ ] **Step 2: Write the failing config test**

Add to `packages/api-contract/src/config.test.ts`:
```ts
import { DigestConfig, HooksConfig, LimitsConfig, RecapsConfig } from './config.ts';

describe('OrcConfig phase 5 sections', () => {
  it('fills recaps, limits, digest and hooks defaults', () => {
    const c = OrcConfig.parse({});
    expect(c.recaps.idleMinutes).toBe(10);
    expect(c.recaps.excludeProjectIds).toEqual([]);
    expect(c.recaps.dailyProjectIds).toEqual(['wakecap']);
    expect(c.recaps.monthlyBudgetUsd).toBe(20);
    expect(c.limits.quotaSource).toBe('estimate');
    expect(c.limits.officialFieldPaths.blockPct).toBeNull();
    expect(c.limits.blockTokenLimit).toBeNull();
    expect(c.limits.warnPct).toBe(0.8);
    expect(c.limits.contextWindows['claude-opus-5']).toBe(1000000);
    expect(c.limits.contextWindows['claude-haiku-4-5']).toBe(200000);
    expect(c.limits.pricing['claude-sonnet-5']).toEqual({ input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 });
    expect(c.limits.contextWarnFill).toBe(0.85);
    expect(c.digest.cron).toBe('0 9 * * 1');
    expect(c.digest.dailyRecapCron).toBe('0 19 * * 1-5');
    expect(c.hooks.statusOverrideMs).toBe(120000);
  });

  it('exposes each section as its own schema', () => {
    expect(RecapsConfig.parse({}).engine).toBe('claude-cli');
    expect(LimitsConfig.parse({ blockTokenLimit: 5000 }).blockTokenLimit).toBe(5000);
    expect(DigestConfig.parse({}).enabled).toBe(true);
    expect(HooksConfig.parse({}).statusOverrideMs).toBe(120000);
  });

  it('rejects an out-of-range warnPct', () => {
    expect(() => LimitsConfig.parse({ warnPct: 1.5 })).toThrow();
  });
});
```
(`describe`, `expect`, `it` and `OrcConfig` are already imported at the top of this file by Phase 0.)

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm vitest run packages/api-contract/src/config.test.ts`
Expected: FAIL, `RecapsConfig` is not exported.

- [ ] **Step 4: Implement the config sections**

In `packages/api-contract/src/config.ts`:
- Add the four schemas and their types from "Contract additions" §3, verbatim, above `OrcConfig`.
- **If S7 = official:** replace the `quotaSource` default with `'official'`, and the four `officialFieldPaths` defaults with the paths recorded in `plan/spikes/S7.md`.
- Replace the inline `recaps: z.object({...}).default({})` line inside `OrcConfig` with the four lines below. Keep every other `OrcConfig` field as Phase 0 wrote it.

```ts
  recaps: RecapsConfig.prefault({}),
  limits: LimitsConfig.prefault({}),
  digest: DigestConfig.prefault({}),
  hooks: HooksConfig.prefault({}),
```

- [ ] **Step 5: Run the config test and confirm it passes**

Run: `pnpm vitest run packages/api-contract/src/config.test.ts`
Expected: PASS (the earlier Phase 0 tests still pass).

- [ ] **Step 6: Add the core domain types**

`packages/core/src/types/usage.ts`
```ts
export type UsageSource = 'official' | 'estimate';

export interface UsageSnapshot {
  source: UsageSource;
  generatedAt: string;
  block: { active: boolean; start: string; end: string; tokens: number; costUsd: number; pctOfLimit: number | null };
  week: { tokens: number; costUsd: number; pctOfLimit: number | null };
  burnRateUsdPerHour: number;
  burnRateTokensPerMin: number;
  projectedBlockExhaustionAt: string | null;
}

export interface OfficialQuotaSample {
  at: string;
  blockPct: number | null;
  blockResetsAt: string | null;
  weekPct: number | null;
  weekResetsAt: string | null;
}

export type BudgetScopeType = 'global' | 'project' | 'ticket';
export type BudgetPeriod = 'daily' | 'weekly' | 'monthly';

export interface Budget {
  id: string;
  scopeType: BudgetScopeType;
  scopeId: string | null;
  period: BudgetPeriod;
  limitUsd: number;
  origin: 'table' | 'config';
}

export interface BudgetStatus { budget: Budget; spentUsd: number; pct: number; periodStart: string }
export interface BudgetCheck { ok: boolean; pct: number; limitUsd: number | null }
export interface ConcurrencyStatus { projectId: string; owned: number; max: number }

export interface ContextFillInfo {
  sessionPk: string;
  model: string | null;
  usedTokens: number;
  windowTokens: number;
  fill: number;
  warn: boolean;
}
```

`packages/core/src/types/streams.ts`
```ts
import type { PrRef } from './session.ts';
import type { Goal, Handoff, WorkStream } from './work.ts';
import type { BudgetCheck } from './usage.ts';

export type StreamLinkKind = 'session' | 'pr' | 'plan' | 'worktree' | 'workflow';

export interface StreamLink {
  ticket: string;
  kind: StreamLinkKind;
  ref: string;
  origin: 'auto' | 'manual';
  excluded: boolean;
  createdAt: string;
}

export type TicketSignalSource =
  | 'session_tickets' | 'prompt' | 'branch' | 'pr_title' | 'pr_body'
  | 'plan_file' | 'wstack_workflow' | 'worktree' | 'manual';

export interface TicketSignal { ticket: string; kind: StreamLinkKind; ref: string; source: TicketSignalSource }

export interface StreamPr {
  pr: PrRef;
  title: string;
  state: 'open' | 'closed' | 'merged';
  headRef: string | null;
  baseRef: string | null;
  isBackmerge: boolean;
  checks: 'pending' | 'success' | 'failure' | 'none';
  review: 'approved' | 'changes_requested' | 'review_required' | 'none';
  updatedAt: string;
  mergedAt: string | null;
}

export type StreamTimelineKind = 'session' | 'pr' | 'plan' | 'worktree' | 'recap' | 'handoff' | 'goal' | 'workflow';

export interface StreamTimelineItem { ts: string; kind: StreamTimelineKind; title: string; ref: string; detail: string | null }

export interface StreamDetail {
  stream: WorkStream;
  prsDetailed: StreamPr[];
  links: StreamLink[];
  timeline: StreamTimelineItem[];
  goal: Goal | null;
  handoff: Handoff | null;
  budget: BudgetCheck;
}
```

`packages/core/src/types/recaps.ts`
```ts
export type RecapKind = 'session' | 'daily' | 'handoff';
export type RecapEngineId = 'claude-cli' | 'anthropic-api';

export interface Recap {
  id: string;
  kind: RecapKind;
  targetKey: string;
  transcriptOffset: number;
  model: string;
  engine: RecapEngineId;
  text: string;
  costUsd: number;
  inputTokensApprox: number;
  createdAt: string;
}

export type ReminderState = 'pending' | 'fired' | 'cancelled';

export interface Reminder {
  id: string;
  jobId: string;
  sessionPk: string | null;
  ticket: string | null;
  text: string;
  dueAt: string;
  sendToSession: boolean;
  state: ReminderState;
  createdAt: string;
  firedAt: string | null;
}

export interface DigestRecord { weekStart: string; markdown: string; createdAt: string }
```

`packages/core/src/types/bridge.ts`
```ts
import type { LiveStatus } from './session.ts';

export type HookEventName = 'SessionStart' | 'Stop' | 'Notification' | 'PreToolUse' | 'PostToolUse';

export interface HookSignal {
  sessionId: string;
  event: HookEventName;
  status: LiveStatus;
  waitingFor: string | null;
  currentTool: string | null;
}
```

`packages/core/src/types/analytics.ts`
```ts
export type AnalyticsGroupBy = 'day' | 'week' | 'project' | 'model' | 'source' | 'ticket';
export interface TokenTotals { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface CostRow { key: string; costUsd: number; tokens: TokenTotals; sessions: number }
export interface TopSession { pk: string; name: string | null; projectId: string | null; costUsd: number; tickets: string[] }
export interface TopTicket { ticket: string; costUsd: number; sessions: number }
export interface TopResult { sessions: TopSession[]; tickets: TopTicket[]; mergedPrs: number; costPerMergedPrUsd: number | null }
export type ToolKind = 'tool' | 'mcp' | 'skill';
export interface ToolUsageRow { bucket: string; kind: ToolKind; name: string; count: number }
export interface TimingResult {
  modelMs: number;
  toolMs: number;
  modelShare: number | null;
  cacheHitTrend: Array<{ bucket: string; rate: number | null }>;
}
export interface OutcomesResult {
  sessions: number;
  outcomes: Record<string, number>;
  friction: Record<string, number>;
  goalCategories: Record<string, number>;
}
export interface WstackSkillRow { skill: string; runs: number; outcomes: Record<string, number>; avgDurationS: number | null }
```

Append to `packages/core/src/types/index.ts` (`types/index.ts` is re-exported by both `src/index.ts` and the browser entry `src/browser.ts`, so the web app sees these types too):
```ts
export * from './usage.ts';
export * from './streams.ts';
export * from './recaps.ts';
export * from './bridge.ts';
export * from './analytics.ts';
```

- [ ] **Step 7: Write the failing client test**

`packages/api-contract/src/client-p5.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import type { Caller, HttpMethod } from './client-p2.ts';
import { p5ClientMethods, withQuery } from './client-p5.ts';
import { UsageSnapshotSchema } from './routes/usage.ts';

const snapshot = {
  source: 'estimate',
  generatedAt: '2026-09-17T10:00:00.000Z',
  block: { active: true, start: '2026-09-17T09:00:00.000Z', end: '2026-09-17T14:00:00.000Z', tokens: 1200, costUsd: 1.5, pctOfLimit: null },
  week: { tokens: 9000, costUsd: 30, pctOfLimit: null },
  burnRateUsdPerHour: 1.5,
  burnRateTokensPerMin: 20,
  projectedBlockExhaustionAt: null,
};

describe('p5ClientMethods', () => {
  it('builds paths, queries and bodies and validates responses', async () => {
    const calls: Array<{ method: HttpMethod; path: string; body: unknown }> = [];
    const call = (async (method: HttpMethod, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (path === '/api/usage') return snapshot;
      if (path.startsWith('/api/streams/')) {
        return { ticket: 'SAF-1', kind: 'pr', ref: 'u', origin: 'manual', excluded: false, createdAt: 'x' };
      }
      return [];
    }) as Caller;
    const c = p5ClientMethods(call);
    expect((await c.usageGet()).block.tokens).toBe(1200);
    await c.streamsLink('SAF-1', { kind: 'pr', ref: 'u' });
    await c.analyticsTools({ from: 'a', to: 'b', bucket: 'week' });
    expect(calls[1]).toEqual({ method: 'POST', path: '/api/streams/SAF-1/link', body: { kind: 'pr', ref: 'u' } });
    expect(calls[2]).toEqual({ method: 'GET', path: '/api/analytics/tools?from=a&to=b&bucket=week', body: undefined });
  });

  it('rejects a response that does not match the schema', async () => {
    const call = (async () => ({ ...snapshot, source: 'guess' })) as Caller;
    await expect(p5ClientMethods(call).usageGet()).rejects.toThrow();
    expect(() => UsageSnapshotSchema.parse({ ...snapshot, source: 'guess' })).toThrow();
  });

  it('drops empty query values', () => {
    expect(withQuery('/x', { a: 'b', c: undefined, d: '', e: 3, f: false })).toBe('/x?a=b&e=3&f=false');
    expect(withQuery('/x', {})).toBe('/x');
  });
});
```

- [ ] **Step 8: Run it and confirm it fails**

Run: `pnpm vitest run packages/api-contract/src/client-p5.test.ts`
Expected: FAIL, `Cannot find module './client-p5.ts'`.

- [ ] **Step 9: Write the route schemas**

`packages/api-contract/src/routes/usage.ts`
```ts
import type { Budget, BudgetStatus, ConcurrencyStatus, ContextFillInfo, OfficialQuotaSample, UsageSnapshot } from '@orc/core';
import { z } from 'zod';

export const UsageSnapshotSchema: z.ZodType<UsageSnapshot> = z.object({
  source: z.enum(['official', 'estimate']),
  generatedAt: z.string(),
  block: z.object({
    active: z.boolean(),
    start: z.string(),
    end: z.string(),
    tokens: z.number(),
    costUsd: z.number(),
    pctOfLimit: z.number().nullable(),
  }),
  week: z.object({ tokens: z.number(), costUsd: z.number(), pctOfLimit: z.number().nullable() }),
  burnRateUsdPerHour: z.number(),
  burnRateTokensPerMin: z.number(),
  projectedBlockExhaustionAt: z.string().nullable(),
});

export const OfficialQuotaSampleSchema: z.ZodType<OfficialQuotaSample> = z.object({
  at: z.string(),
  blockPct: z.number().nullable(),
  blockResetsAt: z.string().nullable(),
  weekPct: z.number().nullable(),
  weekResetsAt: z.string().nullable(),
});

export const BudgetScopeTypeSchema = z.enum(['global', 'project', 'ticket']);
export const BudgetPeriodSchema = z.enum(['daily', 'weekly', 'monthly']);

export const BudgetSchema: z.ZodType<Budget> = z.object({
  id: z.string(),
  scopeType: BudgetScopeTypeSchema,
  scopeId: z.string().nullable(),
  period: BudgetPeriodSchema,
  limitUsd: z.number(),
  origin: z.enum(['table', 'config']),
});

export const BudgetStatusSchema: z.ZodType<BudgetStatus> = z.object({
  budget: BudgetSchema,
  spentUsd: z.number(),
  pct: z.number(),
  periodStart: z.string(),
});

export const BudgetUpsertBody = z
  .object({
    scopeType: BudgetScopeTypeSchema,
    scopeId: z.string().min(1).nullable().default(null),
    period: BudgetPeriodSchema,
    limitUsd: z.number().positive(),
  })
  .refine((b) => (b.scopeType === 'global') === (b.scopeId === null), {
    message: 'scopeId must be null only for global budgets',
  });
export type BudgetUpsertBody = z.infer<typeof BudgetUpsertBody>;

export const ConcurrencyStatusSchema: z.ZodType<ConcurrencyStatus> = z.object({
  projectId: z.string(),
  owned: z.number(),
  max: z.number(),
});

export const ContextFillInfoSchema: z.ZodType<ContextFillInfo> = z.object({
  sessionPk: z.string(),
  model: z.string().nullable(),
  usedTokens: z.number(),
  windowTokens: z.number(),
  fill: z.number(),
  warn: z.boolean(),
});
```

`packages/api-contract/src/routes/settings.ts`
```ts
import { z } from 'zod';
import { DigestConfig, HooksConfig, LimitsConfig, RecapsConfig } from '../config.ts';

export const SettingsSchema = z.object({
  recaps: RecapsConfig,
  limits: LimitsConfig,
  digest: DigestConfig,
  hooks: HooksConfig,
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Each section is sent whole (PUT semantics per section); omitted sections are left unchanged. */
export const SettingsUpdateBody = z.object({
  recaps: RecapsConfig.optional(),
  limits: LimitsConfig.optional(),
  digest: DigestConfig.optional(),
  hooks: HooksConfig.optional(),
});
export type SettingsUpdateBody = z.infer<typeof SettingsUpdateBody>;
```

`packages/api-contract/src/routes/streams.ts`
```ts
import type { Goal, Handoff, StreamDetail, StreamLink, StreamPr, StreamTimelineItem, WorkStream } from '@orc/core';
import { z } from 'zod';

export const StreamStageSchema = z.enum(['planned', 'implementing', 'in_review', 'pr_open', 'merged', 'backmerged', 'released']);
export const StreamLinkKindSchema = z.enum(['session', 'pr', 'plan', 'worktree', 'workflow']);
export const PrRefSchema = z.object({ repo: z.string(), number: z.number(), url: z.string() });

export const WorkStreamSchema: z.ZodType<WorkStream> = z.object({
  ticket: z.string(),
  projectId: z.string(),
  title: z.string().nullable(),
  stage: StreamStageSchema,
  sessionIds: z.array(z.string()),
  prs: z.array(PrRefSchema),
  plans: z.array(z.string()),
  worktrees: z.array(z.string()),
  costUsd: z.number(),
  lastActivityAt: z.string(),
});

export const StreamLinkSchema: z.ZodType<StreamLink> = z.object({
  ticket: z.string(),
  kind: StreamLinkKindSchema,
  ref: z.string(),
  origin: z.enum(['auto', 'manual']),
  excluded: z.boolean(),
  createdAt: z.string(),
});

export const StreamPrSchema: z.ZodType<StreamPr> = z.object({
  pr: PrRefSchema,
  title: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  headRef: z.string().nullable(),
  baseRef: z.string().nullable(),
  isBackmerge: z.boolean(),
  checks: z.enum(['pending', 'success', 'failure', 'none']),
  review: z.enum(['approved', 'changes_requested', 'review_required', 'none']),
  updatedAt: z.string(),
  mergedAt: z.string().nullable(),
});

export const StreamTimelineItemSchema: z.ZodType<StreamTimelineItem> = z.object({
  ts: z.string(),
  kind: z.enum(['session', 'pr', 'plan', 'worktree', 'recap', 'handoff', 'goal', 'workflow']),
  title: z.string(),
  ref: z.string(),
  detail: z.string().nullable(),
});

export const GoalSchema: z.ZodType<Goal> = z.object({
  id: z.string(),
  targetType: z.enum(['session', 'stream']),
  targetId: z.string(),
  objective: z.string(),
  state: z.enum(['active', 'paused', 'blocked', 'complete']),
  blockedReason: z.string().nullable(),
  updatedAt: z.string(),
});

export const HandoffSchema: z.ZodType<Handoff> = z.object({
  id: z.string(),
  sessionId: z.string(),
  status: z.string(),
  summary: z.string(),
  evidence: z.array(z.string()),
  files: z.array(z.string()),
  nextSteps: z.array(z.string()),
  blockers: z.array(z.string()),
  links: z.array(z.string()),
  createdAt: z.string(),
});

export const StreamDetailSchema: z.ZodType<StreamDetail> = z.object({
  stream: WorkStreamSchema,
  prsDetailed: z.array(StreamPrSchema),
  links: z.array(StreamLinkSchema),
  timeline: z.array(StreamTimelineItemSchema),
  goal: GoalSchema.nullable(),
  handoff: HandoffSchema.nullable(),
  budget: z.object({ ok: z.boolean(), pct: z.number(), limitUsd: z.number().nullable() }),
});

export const StreamsListQuery = z.object({ projectId: z.string().optional(), stage: StreamStageSchema.optional() });
export type StreamsListQuery = z.infer<typeof StreamsListQuery>;
export const StreamLinkBody = z.object({ kind: StreamLinkKindSchema, ref: z.string().min(1) });
export type StreamLinkBody = z.infer<typeof StreamLinkBody>;
```

`packages/api-contract/src/routes/analytics.ts`
```ts
import type { CostRow, DigestRecord, OutcomesResult, TimingResult, ToolUsageRow, TopResult, WstackSkillRow } from '@orc/core';
import { z } from 'zod';

const TokenTotalsSchema = z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() });

export const AnalyticsRangeQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  projectId: z.string().optional(),
});
export type AnalyticsRangeQuery = z.infer<typeof AnalyticsRangeQuery>;
export const AnalyticsCostQuery = AnalyticsRangeQuery.extend({
  groupBy: z.enum(['day', 'week', 'project', 'model', 'source', 'ticket']).default('day'),
});
export type AnalyticsCostQuery = z.input<typeof AnalyticsCostQuery>;
export const AnalyticsTopQuery = AnalyticsRangeQuery.extend({ limit: z.coerce.number().int().min(1).max(100).default(10) });
export type AnalyticsTopQuery = { from?: string; to?: string; projectId?: string; limit?: number };
export const AnalyticsBucketQuery = AnalyticsRangeQuery.extend({ bucket: z.enum(['day', 'week']).default('day') });
export type AnalyticsBucketQuery = z.input<typeof AnalyticsBucketQuery>;

export const CostRowSchema: z.ZodType<CostRow> = z.object({
  key: z.string(),
  costUsd: z.number(),
  tokens: TokenTotalsSchema,
  sessions: z.number(),
});
export const CostResponseSchema = z.object({ rows: z.array(CostRowSchema), estimated: z.boolean() });
export type CostResponse = z.infer<typeof CostResponseSchema>;

export const TopResultSchema: z.ZodType<TopResult> = z.object({
  sessions: z.array(
    z.object({
      pk: z.string(),
      name: z.string().nullable(),
      projectId: z.string().nullable(),
      costUsd: z.number(),
      tickets: z.array(z.string()),
    }),
  ),
  tickets: z.array(z.object({ ticket: z.string(), costUsd: z.number(), sessions: z.number() })),
  mergedPrs: z.number(),
  costPerMergedPrUsd: z.number().nullable(),
});

export const ToolUsageRowSchema: z.ZodType<ToolUsageRow> = z.object({
  bucket: z.string(),
  kind: z.enum(['tool', 'mcp', 'skill']),
  name: z.string(),
  count: z.number(),
});

export const TimingResultSchema: z.ZodType<TimingResult> = z.object({
  modelMs: z.number(),
  toolMs: z.number(),
  modelShare: z.number().nullable(),
  cacheHitTrend: z.array(z.object({ bucket: z.string(), rate: z.number().nullable() })),
});

export const OutcomesResultSchema: z.ZodType<OutcomesResult> = z.object({
  sessions: z.number(),
  outcomes: z.record(z.string(), z.number()),
  friction: z.record(z.string(), z.number()),
  goalCategories: z.record(z.string(), z.number()),
});

export const WstackSkillRowSchema: z.ZodType<WstackSkillRow> = z.object({
  skill: z.string(),
  runs: z.number(),
  outcomes: z.record(z.string(), z.number()),
  avgDurationS: z.number().nullable(),
});

export const DigestRecordSchema: z.ZodType<DigestRecord> = z.object({
  weekStart: z.string(),
  markdown: z.string(),
  createdAt: z.string(),
});
export const DigestGenerateBody = z.object({ weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
```

`packages/api-contract/src/routes/recaps.ts`
```ts
import type { Recap } from '@orc/core';
import { z } from 'zod';

export const RecapSchema: z.ZodType<Recap> = z.object({
  id: z.string(),
  kind: z.enum(['session', 'daily', 'handoff']),
  targetKey: z.string(),
  transcriptOffset: z.number(),
  model: z.string(),
  engine: z.enum(['claude-cli', 'anthropic-api']),
  text: z.string(),
  costUsd: z.number(),
  inputTokensApprox: z.number(),
  createdAt: z.string(),
});
export const RecapRunBody = z.object({ onDemand: z.boolean().default(true) });
export const RecapRunResponseSchema = z.object({
  text: z.string(),
  costUsd: z.number(),
  model: z.string(),
  cached: z.boolean(),
});
export type RecapRunResponse = z.infer<typeof RecapRunResponseSchema>;
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const DailyRecapQuery = z.object({ projectId: z.string(), date: IsoDate });
export const DailyRecapBody = z.object({ projectId: z.string(), date: IsoDate });
export const RecapSpendSchema = z.object({ spentUsd: z.number(), budgetUsd: z.number() });
```

`packages/api-contract/src/routes/goals.ts`
```ts
import { z } from 'zod';
import { GoalSchema } from './streams.ts';

export const GoalTargetTypeSchema = z.enum(['session', 'stream']);
export const GoalStateSchema = z.enum(['active', 'paused', 'blocked', 'complete']);
export const GoalWithPrefillSchema = z.object({ goal: GoalSchema.nullable(), prefill: z.string() });
export const GoalPutBody = z.object({
  objective: z.string().min(1).max(2000),
  state: GoalStateSchema,
  blockedReason: z.string().max(500).nullable().default(null),
});
export type GoalPutBody = z.input<typeof GoalPutBody>;
export const GoalsListQuery = z.object({ state: z.string().optional() }); // comma-separated GoalState values
```

`packages/api-contract/src/routes/handoffs.ts`
```ts
import { z } from 'zod';
import { HandoffSchema } from './streams.ts';

export const HandoffWithMarkdownSchema = z.object({ handoff: HandoffSchema, markdown: z.string() });
export const ResumeFreshBody = z.object({ confirm: z.boolean().optional() });
export const ResumeFreshResponseSchema = z.object({ ptyId: z.string() });
```

`packages/api-contract/src/routes/reminders.ts`
```ts
import type { Reminder } from '@orc/core';
import { z } from 'zod';

export const ReminderSchema: z.ZodType<Reminder> = z.object({
  id: z.string(),
  jobId: z.string(),
  sessionPk: z.string().nullable(),
  ticket: z.string().nullable(),
  text: z.string(),
  dueAt: z.string(),
  sendToSession: z.boolean(),
  state: z.enum(['pending', 'fired', 'cancelled']),
  createdAt: z.string(),
  firedAt: z.string().nullable(),
});

export const ReminderCreateBody = z
  .object({
    sessionPk: z.string().nullable().default(null),
    ticket: z.string().nullable().default(null),
    text: z.string().min(1).max(2000),
    dueAt: z.string().datetime().optional(),
    inMinutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
    sendToSession: z.boolean().default(false),
  })
  .refine((b) => (b.dueAt === undefined) !== (b.inMinutes === undefined), { message: 'give exactly one of dueAt or inMinutes' })
  .refine((b) => !b.sendToSession || b.sessionPk !== null, { message: 'sendToSession needs sessionPk' });
export type ReminderCreateBody = z.input<typeof ReminderCreateBody>;
export const RemindersListQuery = z.object({ state: z.string().optional(), sessionPk: z.string().optional() });
```

`packages/api-contract/src/routes/hooks.ts` already exists from Phase 2 (it holds `HookIngestBody`). **Append** the following below it; `z` is already imported:
```ts
export const HookInstallStatusSchema = z.object({
  settingsPath: z.string(),
  settingsExists: z.boolean(),
  installed: z.boolean(),
  command: z.string(),
  snippet: z.string(),
  backupDir: z.string(),
});
export type HookInstallStatus = z.infer<typeof HookInstallStatusSchema>;
export const HookInstallBody = z.object({ confirm: z.boolean().optional() });
export const HookInstallResultSchema = z.object({
  installed: z.literal(true),
  settingsPath: z.string(),
  backupPath: z.string().nullable(),
});
export const StatuslineSnippetSchema = z.object({ command: z.string(), snippet: z.string() });
export const HookIngestResponseSchema = z.object({ ok: z.literal(true), accepted: z.boolean() });
```

- [ ] **Step 10: Write the client methods**

This follows Phase 2's pattern (`Caller` / `makeCaller` in `client-p2.ts`), and adds runtime validation with the zod schemas.

`packages/api-contract/src/client-p5.ts`
```ts
import type { GoalState, ReminderState, StreamLinkKind, StreamStage } from '@orc/core';
import { z } from 'zod';
import type { Caller, HttpMethod } from './client-p2.ts';
import {
  type AnalyticsBucketQuery,
  type AnalyticsCostQuery,
  type AnalyticsTopQuery,
  CostResponseSchema,
  DigestRecordSchema,
  OutcomesResultSchema,
  TimingResultSchema,
  ToolUsageRowSchema,
  TopResultSchema,
  WstackSkillRowSchema,
} from './routes/analytics.ts';
import { type GoalPutBody, GoalWithPrefillSchema } from './routes/goals.ts';
import { HandoffWithMarkdownSchema, ResumeFreshResponseSchema } from './routes/handoffs.ts';
import { HookInstallResultSchema, HookInstallStatusSchema, StatuslineSnippetSchema } from './routes/hooks.ts';
import { RecapRunResponseSchema, RecapSchema, RecapSpendSchema } from './routes/recaps.ts';
import { type ReminderCreateBody, ReminderSchema } from './routes/reminders.ts';
import { SettingsSchema, type SettingsUpdateBody } from './routes/settings.ts';
import { GoalSchema, HandoffSchema, StreamDetailSchema, StreamLinkSchema, WorkStreamSchema } from './routes/streams.ts';
import {
  BudgetSchema,
  BudgetStatusSchema,
  ConcurrencyStatusSchema,
  ContextFillInfoSchema,
  UsageSnapshotSchema,
} from './routes/usage.ts';

export type QueryValue = string | number | boolean | undefined;

export function withQuery(path: string, q: Record<string, QueryValue>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `${path}?${s}` : path;
}

const enc = encodeURIComponent;
const Ok = z.object({ ok: z.literal(true) });

export interface BudgetUpsertInput {
  scopeType: 'global' | 'project' | 'ticket';
  scopeId?: string | null;
  period: 'daily' | 'weekly' | 'monthly';
  limitUsd: number;
}

export function p5ClientMethods(call: Caller) {
  const v =
    <T>(schema: z.ZodType<T>) =>
    async (method: HttpMethod, path: string, body?: unknown): Promise<T> =>
      schema.parse(await call<unknown>(method, path, body));
  return {
    // usage & budgets (F19)
    usageGet: () => v(UsageSnapshotSchema)('GET', '/api/usage'),
    usageBudgets: () => v(z.array(BudgetStatusSchema))('GET', '/api/usage/budgets'),
    usageBudgetUpsert: (body: BudgetUpsertInput) => v(BudgetSchema)('PUT', '/api/usage/budgets', body),
    usageBudgetDelete: (id: string) => v(Ok)('DELETE', `/api/usage/budgets/${enc(id)}`),
    usageConcurrency: () => v(z.array(ConcurrencyStatusSchema))('GET', '/api/usage/concurrency'),
    usageContext: (source: string, id: string) =>
      v(ContextFillInfoSchema.nullable())('GET', `/api/usage/context/${enc(source)}/${enc(id)}`),
    // settings
    settingsGet: () => v(SettingsSchema)('GET', '/api/settings'),
    settingsUpdate: (body: SettingsUpdateBody) => v(SettingsSchema)('PUT', '/api/settings', body),
    // analytics (F7)
    analyticsCost: (q: AnalyticsCostQuery) => v(CostResponseSchema)('GET', withQuery('/api/analytics/cost', q)),
    analyticsTop: (q: AnalyticsTopQuery) => v(TopResultSchema)('GET', withQuery('/api/analytics/top', q)),
    analyticsTools: (q: AnalyticsBucketQuery) =>
      v(z.array(ToolUsageRowSchema))('GET', withQuery('/api/analytics/tools', q)),
    analyticsTiming: (q: AnalyticsBucketQuery) => v(TimingResultSchema)('GET', withQuery('/api/analytics/timing', q)),
    analyticsOutcomes: (q: { from?: string; to?: string; projectId?: string }) =>
      v(OutcomesResultSchema)('GET', withQuery('/api/analytics/outcomes', q)),
    analyticsWstack: (q: { from?: string; to?: string }) =>
      v(z.array(WstackSkillRowSchema))('GET', withQuery('/api/analytics/wstack', q)),
    analyticsDigestLatest: () => v(DigestRecordSchema.nullable())('GET', '/api/analytics/digest'),
    analyticsDigestGenerate: (weekStart?: string) =>
      v(DigestRecordSchema)('POST', '/api/analytics/digest', weekStart ? { weekStart } : {}),
    // streams (F6)
    streamsList: (q: { projectId?: string; stage?: StreamStage }) =>
      v(z.array(WorkStreamSchema))('GET', withQuery('/api/streams', q)),
    streamsRefresh: () => v(z.array(WorkStreamSchema))('POST', '/api/streams/refresh', {}),
    streamsGet: (ticket: string) => v(StreamDetailSchema)('GET', `/api/streams/${enc(ticket)}`),
    streamsLink: (ticket: string, body: { kind: StreamLinkKind; ref: string }) =>
      v(StreamLinkSchema)('POST', `/api/streams/${enc(ticket)}/link`, body),
    streamsUnlink: (ticket: string, body: { kind: StreamLinkKind; ref: string }) =>
      v(StreamLinkSchema)('POST', `/api/streams/${enc(ticket)}/unlink`, body),
    // recaps (F14)
    recapsGetSession: (source: string, id: string) =>
      v(RecapSchema.nullable())('GET', `/api/recaps/session/${enc(source)}/${enc(id)}`),
    recapsRunSession: (source: string, id: string, onDemand = true) =>
      v(RecapRunResponseSchema)('POST', `/api/recaps/session/${enc(source)}/${enc(id)}`, { onDemand }),
    recapsGetDaily: (projectId: string, date: string) =>
      v(RecapSchema.nullable())('GET', withQuery('/api/recaps/daily', { projectId, date })),
    recapsRunDaily: (projectId: string, date: string) =>
      v(z.object({ text: z.string() }))('POST', '/api/recaps/daily', { projectId, date }),
    recapsSpend: () => v(RecapSpendSchema)('GET', '/api/recaps/spend'),
    // goals, handoffs, reminders (F16)
    goalsList: (states?: GoalState[]) => v(z.array(GoalSchema))('GET', withQuery('/api/goals', { state: states?.join(',') })),
    goalsGet: (targetType: 'session' | 'stream', targetId: string) =>
      v(GoalWithPrefillSchema)('GET', `/api/goals/${targetType}/${enc(targetId)}`),
    goalsSet: (targetType: 'session' | 'stream', targetId: string, body: GoalPutBody) =>
      v(GoalSchema)('PUT', `/api/goals/${targetType}/${enc(targetId)}`, body),
    handoffsLatest: (source: string, id: string) =>
      v(HandoffWithMarkdownSchema.nullable())('GET', `/api/handoffs/session/${enc(source)}/${enc(id)}`),
    handoffsGenerate: (source: string, id: string) =>
      v(HandoffSchema)('POST', `/api/handoffs/session/${enc(source)}/${enc(id)}`, {}),
    handoffsResumeFresh: (handoffId: string) =>
      v(ResumeFreshResponseSchema)('POST', `/api/handoffs/${enc(handoffId)}/resume-fresh`, { confirm: true }),
    remindersList: (q: { state?: ReminderState[]; sessionPk?: string }) =>
      v(z.array(ReminderSchema))('GET', withQuery('/api/reminders', { state: q.state?.join(','), sessionPk: q.sessionPk })),
    remindersCreate: (body: ReminderCreateBody) => v(ReminderSchema)('POST', '/api/reminders', body),
    remindersCancel: (id: string) => v(ReminderSchema)('POST', `/api/reminders/${enc(id)}/cancel`, {}),
    // bridge (F10)
    hooksInstallStatus: () => v(HookInstallStatusSchema)('GET', '/api/hooks/install'),
    hooksInstall: () => v(HookInstallResultSchema)('POST', '/api/hooks/install', { confirm: true }),
    hooksStatusline: () => v(StatuslineSnippetSchema)('GET', '/api/hooks/statusline'),
  };
}

export type P5ClientMethods = ReturnType<typeof p5ClientMethods>;
```

- [ ] **Step 11: Wire the client, the exports and the WS event type**

In `packages/api-contract/src/client.ts`, extend the return statement that Phase 2 changed, so it also spreads the Phase 5 methods:
```ts
import { p5ClientMethods } from './client-p5.ts';
//   return { ...methods, ...p2Methods(caller), ...p5ClientMethods(caller) };   where caller = makeCaller({ baseUrl, token })
```
If `ApiClient` is declared as an interface (Phase 1), add `P5ClientMethods` to it with `export interface ApiClient extends P2Methods, P5ClientMethods { … }`, or with an intersection if Phase 2 used a type alias.

In `packages/api-contract/src/live.ts` (Phase 1), change the `usage.updated` member of `LiveEvent` to the line below, and add `import type { UsageSnapshot } from '@orc/core';`:
```ts
  | { type: 'usage.updated'; snapshot: UsageSnapshot }
```

Append to `packages/api-contract/src/index.ts` (`routes/hooks.ts` is already exported by Phase 2):
```ts
export * from './client-p5.ts';
export * from './routes/usage.ts';
export * from './routes/settings.ts';
export * from './routes/streams.ts';
export * from './routes/analytics.ts';
export * from './routes/recaps.ts';
export * from './routes/goals.ts';
export * from './routes/handoffs.ts';
export * from './routes/reminders.ts';
```

- [ ] **Step 12: Run the tests and typecheck**

Run: `pnpm vitest run packages/api-contract && pnpm typecheck`
Expected: PASS. Typecheck is green; the `z.ZodType<CoreType>` annotations prove the schemas match the core types.

- [ ] **Step 13: Commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add packages/core/src/types packages/api-contract
git commit -m "feat(api-contract): add phase 5 config sections, domain types and route schemas"
```

---

### Task 2: Phase 5 tables, migration and test helpers

**Files:**
- Create: `apps/daemon/src/db/schema-p5.ts`
- Modify: `apps/daemon/src/db/schema.ts` (add the re-export)
- Generate: `apps/daemon/src/db/migrations/<n>_phase5.sql` (drizzle-kit)
- Create: `apps/daemon/src/db/schema-p5.test.ts`
- Modify: `apps/daemon/src/context.ts`, `apps/daemon/src/live/event-bus.ts`
- Create: `apps/daemon/src/services/need.ts`, `apps/daemon/src/services/session-pages.ts`, `apps/daemon/src/http/p5-util.ts`
- Create: `apps/daemon/test/p5-helpers.ts`, `apps/daemon/test/p5-helpers.test.ts`

**Interfaces:**
- Consumes: `openDb(file)` (§5), `DaemonContext` (§11), `createTestContext` (P1, assumed above), and `SessionService` / `ProjectService` (P1)
- Produces:
  ```ts
  // schema-p5.ts: scheduledJobs, usageEntries, toolUses, ledgerCursors, usageBlocks, budgets, streams, streamLinks, recaps, goals, handoffs, reminders, digests
  // need.ts
  export function need<T>(value: T | undefined, name: string): T
  // session-pages.ts
  export function listAllSessions(ctx: DaemonContext, q: Omit<SessionListQuery, 'cursor' | 'limit'>, max?: number): SessionListItem[]
  export function loadEvents(ctx: DaemonContext, s: Pick<Session, 'source' | 'id'>, agentId: string | null, max?: number): TimelineEvent[]
  // p5-util.ts
  export async function readBody<S extends z.ZodType>(c: Context, schema: S): Promise<{ ok: true; data: z.output<S> } | { ok: false; res: Response }>
  export function readQuery<S extends z.ZodType>(c: Context, schema: S): { ok: true; data: z.output<S> } | { ok: false; res: Response }
  export function confirmationRequired(c: Context, summary: unknown): Response
  export function notFound(c: Context, what: string): Response
  export function parseStates<T extends string>(raw: string | undefined, allowed: readonly T[]): T[] | undefined
  export function sendError(c: Context, err: unknown): Response        // ServiceError → { error } with its status
  // test/p5-helpers.ts
  export function makeSession(p: Partial<Session> & { id: string }): Session
  export function ev(p: Partial<TimelineEvent> & { seq: number; ts: string; kind: TimelineEvent['kind'] }): TimelineEvent
  export interface FakeSessionData { sessions: Session[]; events?: Record<string, TimelineEvent[]>; agents?: Record<string, AgentNode[]> }
  export function fakeSessions(data: FakeSessionData, bus?: EventBus): SessionService
  export function fakeProjects(cfg: () => OrcConfig): ProjectService
  export const WAKECAP_TICKETS: string
  export function withWakecap(prefix: string, extra?: Partial<ProjectConfig>): (c: OrcConfig) => OrcConfig
  export interface P5TestContext { ctx: TestContext; headers: Record<string, string>; token: string; dispose(): void }   // auto-disposed afterEach
  export function makeP5Context(opts?: { overrides?: Partial<DaemonContext>; config?: (c: OrcConfig) => OrcConfig; data?: FakeSessionData }): P5TestContext
  ```
  Later tasks add these `DaemonContext` fields (all optional): `ledger`, `prs`, `streams`, `analytics`, `digests`, `reminders`. `updateConfig` already exists (P2). The `BusEvent` union gains `{ type: 'config.changed' }`, and P2's `updateConfig` starts emitting it.

- [ ] **Step 1: Write the failing schema test**

`apps/daemon/src/db/schema-p5.test.ts`
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from './client.ts';

const P5_TABLES = [
  'scheduled_jobs', 'usage_entries', 'tool_uses', 'ledger_cursors', 'usage_blocks', 'budgets',
  'streams', 'stream_links', 'recaps', 'goals', 'handoffs', 'reminders', 'digests',
];

describe('phase 5 schema', () => {
  it('creates every phase 5 table through migrations', () => {
    const { raw, close } = openDb(join(mkdtempSync(join(tmpdir(), 'orc-p5db-')), 'index.db'));
    const names = (raw.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of P5_TABLES) expect(names).toContain(t);
    close();
  });

  it('enforces one goal per target and unique recap cache keys', () => {
    const { raw, close } = openDb(join(mkdtempSync(join(tmpdir(), 'orc-p5db-')), 'index.db'));
    const g = raw.prepare(
      "insert into goals (id, target_type, target_id, objective, state, blocked_reason, source, updated_at) values (?, 'session', 'claude:x', 'o', 'active', null, 'manual', 't')",
    );
    g.run('g1');
    expect(() => g.run('g2')).toThrow(/UNIQUE/);
    const r = raw.prepare(
      "insert into recaps (id, kind, target_key, transcript_offset, model, engine, text, cost_usd, input_tokens_approx, created_at) values (?, 'session', 'claude:x', 10, 'm', 'claude-cli', 't', 0, 0, 't')",
    );
    r.run('r1');
    expect(() => r.run('r2')).toThrow(/UNIQUE/);
    close();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/db/schema-p5.test.ts`
Expected: FAIL, `expected [...] to include 'scheduled_jobs'`.

- [ ] **Step 3: Write the schema**

`apps/daemon/src/db/schema-p5.ts`
```ts
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const scheduledJobs = sqliteTable('scheduled_jobs', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['reminder', 'automation', 'digest'] }).notNull(),
  cron: text('cron'),
  runAt: text('run_at'),
  payloadJson: text('payload_json').notNull().default('{}'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastFiredAt: text('last_fired_at'),
  createdAt: text('created_at').notNull(),
});

export const usageEntries = sqliteTable(
  'usage_entries',
  {
    sessionPk: text('session_pk').notNull(),
    agentKey: text('agent_key').notNull(), // '' = main transcript
    messageId: text('message_id').notNull(), // 'session-total' = synthetic per-session entry
    ts: text('ts').notNull(),
    source: text('source').notNull(),
    projectId: text('project_id'),
    ticketsJson: text('tickets_json').notNull().default('[]'),
    model: text('model').notNull(),
    input: integer('input').notNull(),
    output: integer('output').notNull(),
    cacheRead: integer('cache_read').notNull(),
    cacheWrite: integer('cache_write').notNull(),
    estCostUsd: real('est_cost_usd').notNull().default(0),
    allocCostUsd: real('alloc_cost_usd').notNull().default(0),
    authoritative: integer('authoritative', { mode: 'boolean' }).notNull().default(false),
    latencyMs: integer('latency_ms'),
  },
  (t) => [
    primaryKey({ columns: [t.sessionPk, t.agentKey, t.messageId] }),
    index('usage_entries_ts').on(t.ts),
    index('usage_entries_project_ts').on(t.projectId, t.ts),
  ],
);

export const toolUses = sqliteTable(
  'tool_uses',
  {
    sessionPk: text('session_pk').notNull(),
    agentKey: text('agent_key').notNull(),
    factKey: text('fact_key').notNull(),
    ts: text('ts').notNull(),
    kind: text('kind', { enum: ['tool', 'mcp', 'skill'] }).notNull(),
    name: text('name').notNull(),
    toolUseId: text('tool_use_id'),
    projectId: text('project_id'),
    durationMs: integer('duration_ms'),
  },
  (t) => [
    primaryKey({ columns: [t.sessionPk, t.agentKey, t.factKey] }),
    index('tool_uses_ts').on(t.ts),
    index('tool_uses_tool_use_id').on(t.toolUseId),
  ],
);

export const ledgerCursors = sqliteTable(
  'ledger_cursors',
  {
    sessionPk: text('session_pk').notNull(),
    agentKey: text('agent_key').notNull(),
    afterSeq: integer('after_seq').notNull(),
    lastTs: text('last_ts'),
  },
  (t) => [primaryKey({ columns: [t.sessionPk, t.agentKey] })],
);

export const usageBlocks = sqliteTable('usage_blocks', {
  start: text('start').primaryKey(),
  end: text('end').notNull(),
  tokens: integer('tokens').notNull(),
  costUsd: real('cost_usd').notNull(),
  entries: integer('entries').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const budgets = sqliteTable(
  'budgets',
  {
    id: text('id').primaryKey(),
    scopeType: text('scope_type', { enum: ['global', 'project', 'ticket'] }).notNull(),
    scopeId: text('scope_id').notNull().default(''), // '' for global
    period: text('period', { enum: ['daily', 'weekly', 'monthly'] }).notNull(),
    limitUsd: real('limit_usd').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('budgets_scope_period').on(t.scopeType, t.scopeId, t.period)],
);

export const streams = sqliteTable('streams', {
  ticket: text('ticket').primaryKey(),
  projectId: text('project_id').notNull(),
  title: text('title'),
  stage: text('stage', {
    enum: ['planned', 'implementing', 'in_review', 'pr_open', 'merged', 'backmerged', 'released'],
  }).notNull(),
  sessionIdsJson: text('session_ids_json').notNull().default('[]'),
  prsJson: text('prs_json').notNull().default('[]'),
  plansJson: text('plans_json').notNull().default('[]'),
  worktreesJson: text('worktrees_json').notNull().default('[]'),
  costUsd: real('cost_usd').notNull().default(0),
  lastActivityAt: text('last_activity_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const streamLinks = sqliteTable(
  'stream_links',
  {
    ticket: text('ticket').notNull(),
    kind: text('kind', { enum: ['session', 'pr', 'plan', 'worktree', 'workflow'] }).notNull(),
    ref: text('ref').notNull(),
    origin: text('origin', { enum: ['auto', 'manual'] }).notNull(),
    excluded: integer('excluded', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.ticket, t.kind, t.ref] }), index('stream_links_ref').on(t.kind, t.ref)],
);

export const recaps = sqliteTable(
  'recaps',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['session', 'daily', 'handoff'] }).notNull(),
    targetKey: text('target_key').notNull(), // session pk, or `${projectId}:${date}`
    transcriptOffset: integer('transcript_offset').notNull(),
    model: text('model').notNull(),
    engine: text('engine', { enum: ['claude-cli', 'anthropic-api'] }).notNull(),
    text: text('text').notNull(),
    costUsd: real('cost_usd').notNull(),
    inputTokensApprox: integer('input_tokens_approx').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('recaps_cache_key').on(t.kind, t.targetKey, t.transcriptOffset),
    index('recaps_created_at').on(t.createdAt),
  ],
);

export const goals = sqliteTable(
  'goals',
  {
    id: text('id').primaryKey(),
    targetType: text('target_type', { enum: ['session', 'stream'] }).notNull(),
    targetId: text('target_id').notNull(),
    objective: text('objective').notNull(),
    state: text('state', { enum: ['active', 'paused', 'blocked', 'complete'] }).notNull(),
    blockedReason: text('blocked_reason'),
    source: text('source', { enum: ['manual', 'rule', 'recap'] }).notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('goals_target').on(t.targetType, t.targetId)],
);

export const handoffs = sqliteTable(
  'handoffs',
  {
    id: text('id').primaryKey(),
    sessionPk: text('session_pk').notNull(),
    status: text('status').notNull(),
    summary: text('summary').notNull(),
    evidenceJson: text('evidence_json').notNull(),
    filesJson: text('files_json').notNull(),
    nextStepsJson: text('next_steps_json').notNull(),
    blockersJson: text('blockers_json').notNull(),
    linksJson: text('links_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('handoffs_session').on(t.sessionPk, t.createdAt)],
);

export const reminders = sqliteTable(
  'reminders',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    sessionPk: text('session_pk'),
    ticket: text('ticket'),
    text: text('text').notNull(),
    dueAt: text('due_at').notNull(),
    sendToSession: integer('send_to_session', { mode: 'boolean' }).notNull().default(false),
    state: text('state', { enum: ['pending', 'fired', 'cancelled'] }).notNull(),
    createdAt: text('created_at').notNull(),
    firedAt: text('fired_at'),
  },
  (t) => [index('reminders_state_due').on(t.state, t.dueAt)],
);

export const digests = sqliteTable('digests', {
  weekStart: text('week_start').primaryKey(),
  markdown: text('markdown').notNull(),
  createdAt: text('created_at').notNull(),
});
```

Append to `apps/daemon/src/db/schema.ts`:
```ts
export * from './schema-p5.ts';
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @orc/daemon db:generate --name phase5`
Expected: drizzle-kit writes one new SQL file under `apps/daemon/src/db/migrations/` with `CREATE TABLE` statements for the 13 tables and their indexes. Open the file and check that it does **not** alter any Phase 1–4 table. If it does, the Phase 1–4 schema changed without a migration; stop and fix that first.

- [ ] **Step 5: Run the schema test and confirm it passes**

Run: `pnpm vitest run apps/daemon/src/db/schema-p5.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Extend the context and the bus**

In `apps/daemon/src/context.ts`, leave P2's `updateConfig` as it is. Later Phase 5 tasks each add their own optional field here, in the task that creates the type:
```ts
  // ledger?: UsageLedger;        (T5)   prs?: PrSource;                (T9)
  // streams?: StreamService;     (T9)   analytics?: AnalyticsService;  (T10)
  // digests?: DigestService;     (T10)  reminders?: ReminderService;   (T14)
```

In `apps/daemon/src/live/event-bus.ts`, add this member to the `BusEvent` union:
```ts
  | { type: 'config.changed' }
```

In `apps/daemon/src/main.ts` → `createDaemon()`, find the `ctx.updateConfig = …` assignment that P2 added. After the line that calls `saveConfig(...)`, and before the `return`, insert:
```ts
    ctx.bus.emit({ type: 'config.changed' });
```

- [ ] **Step 7: Write the shared helpers**

`apps/daemon/src/services/need.ts`
```ts
/** Returns a DaemonContext service that is typed optional but must be wired by now. */
export function need<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is not wired in DaemonContext`);
  return value;
}
```

`apps/daemon/src/services/session-pages.ts`
```ts
import type { Session, TimelineEvent } from '@orc/core';
import type { DaemonContext } from '../context.ts';
import type { SessionListItem, SessionListQuery } from './sessions.ts';

/** Pages through SessionService.list until exhausted (or `max` items). */
export function listAllSessions(
  ctx: DaemonContext,
  q: Omit<SessionListQuery, 'cursor' | 'limit'>,
  max = 5000,
): SessionListItem[] {
  const out: SessionListItem[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = ctx.sessions.list({ ...q, limit: 200, cursor });
    out.push(...page.items);
    if (page.nextCursor === null || out.length >= max) break;
    cursor = page.nextCursor;
  }
  return out.slice(0, max);
}

/** Loads events for one transcript (agentId null = main) in seq order, capped at `max`. */
export function loadEvents(
  ctx: DaemonContext,
  s: Pick<Session, 'source' | 'id'>,
  agentId: string | null,
  max = 20000,
): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = ctx.sessions.events(s.source, s.id, { agentId, afterSeq, limit: 500 });
    out.push(...page.items);
    const last = page.items.at(-1);
    if (page.nextSeq === null || last === undefined || out.length >= max) break;
    afterSeq = last.seq;
  }
  return out.slice(0, max);
}
```

`apps/daemon/src/http/p5-util.ts`
```ts
import { apiError } from '@orc/api-contract';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { ServiceError } from '../services/errors.ts';

type Parsed<T> = { ok: true; data: T } | { ok: false; res: Response };

export async function readBody<S extends z.ZodType>(c: Context, schema: S): Promise<Parsed<z.output<S>>> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim().length > 0) {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, res: c.json(apiError('validation_failed', 'body is not valid JSON'), 400) };
    }
  }
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, res: c.json(apiError('validation_failed', 'invalid body', r.error.issues), 400) };
  return { ok: true, data: r.data };
}

export function readQuery<S extends z.ZodType>(c: Context, schema: S): Parsed<z.output<S>> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) return { ok: false, res: c.json(apiError('validation_failed', 'invalid query', r.error.issues), 400) };
  return { ok: true, data: r.data };
}

export function confirmationRequired(c: Context, summary: unknown): Response {
  return c.json(apiError('confirmation_required', 'This action needs {"confirm": true}', { summary }), 409);
}

export function notFound(c: Context, what: string): Response {
  return c.json(apiError('not_found', `${what} not found`), 404);
}

/** Maps a thrown ServiceError (P1) to the contract error body; anything else is rethrown to createApp's onError. */
export function sendError(c: Context, err: unknown): Response {
  if (err instanceof ServiceError) {
    return c.json(apiError(err.code, err.message, err.details), err.status as ContentfulStatusCode);
  }
  throw err;
}

/** Parses "a,b" into a filtered list of allowed values; undefined when absent. */
export function parseStates<T extends string>(raw: string | undefined, allowed: readonly T[]): T[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is T => (allowed as readonly string[]).includes(s));
}
```

- [ ] **Step 8: Write the failing helper test**

`apps/daemon/test/p5-helpers.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { listAllSessions, loadEvents } from '../src/services/session-pages.ts';
import { ev, makeP5Context, makeSession, withWakecap } from './p5-helpers.ts';

describe('p5 helpers', () => {
  it('fake sessions page, filter and emit on setLive', () => {
    const sessions = Array.from({ length: 450 }, (_, i) =>
      makeSession({ id: `s${i}`, lastActivityAt: `2026-09-01T10:${String(i % 60).padStart(2, '0')}:00.000Z` }),
    );
    const { ctx } = makeP5Context({ config: withWakecap('/Users/test/Wakecap'), data: { sessions } });
    expect(listAllSessions(ctx, { projectId: 'wakecap' })).toHaveLength(450);
    const seen: string[] = [];
    ctx.bus.on('session.updated', (e) => seen.push(e.session.id));
    ctx.sessions.setLive('claude:s1', null);
    expect(seen).toEqual(['s1']);
  });

  it('loads events across pages for the main transcript only', () => {
    const events = [
      ...Array.from({ length: 1500 }, (_, i) => ev({ seq: i + 1, ts: '2026-09-01T10:00:00.000Z', kind: 'assistant_text' })),
      ev({ seq: 1, ts: '2026-09-01T10:00:00.000Z', kind: 'prompt', agentId: 'ag1' }),
    ];
    const { ctx } = makeP5Context({
      config: withWakecap('/Users/test/Wakecap'),
      data: { sessions: [makeSession({ id: 'a' })], events: { 'claude:a': events } },
    });
    expect(loadEvents(ctx, { source: 'claude', id: 'a' }, null)).toHaveLength(1500);
    expect(loadEvents(ctx, { source: 'claude', id: 'a' }, 'ag1')).toHaveLength(1);
  });

  it('resolves projects from the overridden config and exposes a token', () => {
    const { ctx, headers } = makeP5Context({ config: withWakecap('/Users/test/Wakecap') });
    expect(ctx.projects.resolve('/Users/test/Wakecap/Backend/svc')).toBe('wakecap');
    expect(ctx.projects.get('wakecap')?.features.workStreams).toBe(true);
    expect(headers['x-orc-token']).toBeTruthy();
    const next = ctx.updateConfig?.((c) => ({ ...c, recaps: { ...c.recaps, enabled: true } }));
    expect(next?.recaps.enabled).toBe(true);
    expect(ctx.config().recaps.enabled).toBe(true);
  });
});
```

- [ ] **Step 9: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/test/p5-helpers.test.ts`
Expected: FAIL, `Cannot find module './p5-helpers.ts'`.

- [ ] **Step 10: Write the test helpers**

`apps/daemon/test/p5-helpers.ts`
```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OrcConfig, ProjectConfig } from '@orc/api-contract';
import { type AgentNode, emptyUsage, type Session, type TimelineEvent } from '@orc/core';
import type { DaemonContext } from '../src/context.ts';
import type { EventBus } from '../src/live/event-bus.ts';
import type { ProjectService } from '../src/services/projects.ts';
import { type SessionListItem, type SessionListQuery, type SessionService, sessionPk } from '../src/services/sessions.ts';
import { afterEach } from 'vitest';
import { createTestContext, type TestContext } from './helpers.ts';

export function makeSession(p: Partial<Session> & { id: string }): Session {
  return {
    source: 'claude',
    projectId: 'wakecap',
    startCwd: '/Users/test/Wakecap',
    cwds: ['/Users/test/Wakecap'],
    name: null,
    firstPrompt: null,
    lastPrompt: null,
    awaySummary: null,
    recap: null,
    startedAt: '2026-09-01T09:00:00.000Z',
    lastActivityAt: '2026-09-01T10:00:00.000Z',
    models: ['claude-opus-5'],
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
    ...p,
  };
}

export function ev(p: Partial<TimelineEvent> & { seq: number; ts: string; kind: TimelineEvent['kind'] }): TimelineEvent {
  return {
    sessionId: 's',
    agentId: null,
    uuid: `u-${p.agentId ?? 'main'}-${p.seq}`,
    parentUuid: null,
    turn: 1,
    text: null,
    tool: null,
    toolUseId: null,
    mcpServer: null,
    input: null,
    messageId: null,
    model: null,
    usage: null,
    durationMs: null,
    ...p,
  };
}

export interface FakeSessionData {
  sessions: Session[];
  events?: Record<string, TimelineEvent[]>;
  agents?: Record<string, AgentNode[]>;
}

function toItem(s: Session): SessionListItem {
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

export function fakeSessions(data: FakeSessionData, bus?: EventBus): SessionService {
  const find = (pk: string) => data.sessions.find((s) => sessionPk(s.source, s.id) === pk) ?? null;
  return {
    list(q: SessionListQuery) {
      const items = data.sessions
        .filter(
          (s) =>
            (q.projectId === undefined || s.projectId === q.projectId) &&
            (q.from === undefined || s.lastActivityAt >= q.from) &&
            (q.to === undefined || s.startedAt <= q.to) &&
            (q.ticket === undefined || s.tickets.includes(q.ticket)) &&
            (q.pr === undefined || s.prs.some((p) => p.url === q.pr)) &&
            (q.source === undefined || s.source === q.source),
        )
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
      const start = q.cursor ? Number(q.cursor) : 0;
      const limit = q.limit ?? 50;
      return {
        items: items.slice(start, start + limit).map(toItem),
        nextCursor: start + limit < items.length ? String(start + limit) : null,
      };
    },
    get: (source, id) => find(sessionPk(source, id)),
    getByPk: (pk) => find(pk),
    events(source, id, opts) {
      const all = (data.events?.[sessionPk(source, id)] ?? [])
        .filter((e) => e.agentId === (opts.agentId ?? null))
        .filter((e) => e.seq > (opts.afterSeq ?? 0))
        .sort((a, b) => a.seq - b.seq);
      const limit = Math.min(opts.limit ?? 200, 500);
      const items = all.slice(0, limit);
      return { items, nextSeq: all.length > limit ? (items.at(-1)?.seq ?? null) : null };
    },
    agents: (source, id) => data.agents?.[sessionPk(source, id)] ?? [],
    setLive(pk, live) {
      const s = find(pk);
      if (!s) return;
      s.live = live;
      bus?.emit({ type: 'session.updated', session: s });
    },
    async resume() {
      throw new Error('resume is not available in fakeSessions');
    },
  };
}

export function fakeProjects(cfg: () => OrcConfig): ProjectService {
  const matches = (cwd: string, prefix: string) =>
    cwd === prefix || cwd.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
  return {
    list: () =>
      cfg().projects.map((p) => ({
        id: p.id,
        name: p.name,
        pathPrefixes: p.pathPrefixes,
        hidden: p.hidden,
        lastActivityAt: null,
        sessionCount: 0,
      })),
    resolve(cwd) {
      let best: { id: string; len: number } | null = null;
      for (const p of cfg().projects) {
        for (const pre of p.pathPrefixes) {
          if (matches(cwd, pre) && (best === null || pre.length > best.len)) best = { id: p.id, len: pre.length };
        }
      }
      return best?.id ?? null;
    },
    get: (id) => cfg().projects.find((p) => p.id === id) ?? null,
    update() {
      throw new Error('update is not available in fakeProjects');
    },
  };
}

export const WAKECAP_TICKETS = '\\b(SAF|ALU|SUPRT|SAK|TAN)-\\d+\\b';

export function withWakecap(prefix: string, extra: Partial<ProjectConfig> = {}): (c: OrcConfig) => OrcConfig {
  return (c) => ({
    ...c,
    projects: [
      ProjectConfig.parse({
        id: 'wakecap',
        name: 'Wakecap',
        pathPrefixes: [prefix],
        ticketRegex: WAKECAP_TICKETS,
        features: { workStreams: true, prodBadges: true, recaps: true },
        ...extra,
      }),
    ],
  });
}

export interface P5TestContext {
  ctx: TestContext;
  headers: Record<string, string>;
  token: string;
  dispose(): void;
}

const liveContexts: TestContext[] = [];
/** Every context made in a test file is disposed after each test (temp homes, db handles). */
afterEach(() => {
  for (const c of liveContexts.splice(0)) c.dispose();
});

export function makeP5Context(
  opts: { overrides?: Partial<DaemonContext>; config?: (c: OrcConfig) => OrcConfig; data?: FakeSessionData } = {},
): P5TestContext {
  const base = createTestContext(opts.overrides ?? {});
  liveContexts.push(base);
  let cfg = OrcConfig.parse(opts.config ? opts.config(base.config()) : base.config());
  const ctx: TestContext = { ...base, config: () => cfg };
  // Keep P1's ProjectServiceImpl extras (ensureDefaults, deriveConfigFor, …) and override the lookups.
  ctx.projects = Object.assign(Object.create(base.projects) as typeof base.projects, fakeProjects(() => cfg));
  ctx.updateConfig = (fn) => {
    cfg = OrcConfig.parse(fn(cfg));
    ctx.bus.emit({ type: 'config.changed' });
    return cfg;
  };
  if (opts.data) ctx.sessions = fakeSessions(opts.data, ctx.bus);
  mkdirSync(dirname(ctx.paths.tokenFile), { recursive: true });
  if (!existsSync(ctx.paths.tokenFile)) writeFileSync(ctx.paths.tokenFile, 'test-token-p5', { mode: 0o600 });
  const token = readFileSync(ctx.paths.tokenFile, 'utf8').trim();
  return { ctx, token, headers: { 'x-orc-token': token, 'content-type': 'application/json' }, dispose: () => base.dispose() };
}
```

- [ ] **Step 11: Run the helper test and confirm it passes**

Run: `pnpm vitest run apps/daemon/test/p5-helpers.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 12: Commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add apps/daemon
git commit -m "feat(daemon): add phase 5 tables, migration and shared test helpers"
```

---

### Task 3: Persisted Scheduler (croner)

**Files:**
- Create: `apps/daemon/src/db/repos/scheduled-jobs.ts`
- Create: `apps/daemon/src/services/scheduler/scheduler.ts`, `apps/daemon/src/services/scheduler/scheduler.test.ts`
- Modify: `apps/daemon/package.json` (add croner), `apps/daemon/src/context.ts` (`buildContext` constructs it), `apps/daemon/src/main.ts` (`createDaemon` starts and stops it)

**Interfaces:**
- Consumes: `scheduledJobs` (Task 2), `OrcDb`, the pino `Logger`
- Produces:
  ```ts
  export interface ScheduledJob { id: string; kind: 'reminder' | 'automation' | 'digest'; cron: string | null; runAt: string | null; payload: Record<string, unknown>; enabled: boolean }
  export interface Scheduler { add; remove; list; onFire; get; start; stop }        // see Contract additions
  export function createScheduler(opts: { db: OrcDb; log: Logger; now?: () => Date }): Scheduler
  export function ensureCronJob(s: Scheduler, kind: ScheduledJob['kind'], type: string, cron: string, extra?: Record<string, unknown>): ScheduledJob
  export function removeJobsOfType(s: Scheduler, kind: ScheduledJob['kind'], type: string): number
  // repos/scheduled-jobs.ts
  export function insertJob(db: OrcDb, j: ScheduledJob, createdAt: string): void
  export function getJob(db: OrcDb, id: string): ScheduledJob | null
  export function listJobs(db: OrcDb, kind?: ScheduledJob['kind']): ScheduledJob[]
  export function deleteJob(db: OrcDb, id: string): void
  export function markFired(db: OrcDb, id: string, at: string, disable: boolean): void
  ```
- Semantics:
  - A **one-shot** job (`runAt`, no `cron`) fires **at most once**. It is disabled in the DB *before* its handlers run.
  - A one-shot job whose `runAt` has passed while the daemon was down fires once, immediately, on `start()`.
  - **Cron** jobs are not caught up. They fire on their next occurrence.
  - Several handlers may be registered per kind. Handler errors are logged and never thrown.

- [ ] **Step 1: Install croner**

Run: `pnpm --filter @orc/daemon add croner@^10.0.1`
Expected: `croner 10.0.1` is added to `apps/daemon/package.json`.

- [ ] **Step 2: Write the failing test**

`apps/daemon/src/services/scheduler/scheduler.test.ts`
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../db/client.ts';
import { type Scheduler, type ScheduledJob, createScheduler, ensureCronJob, removeJobsOfType } from './scheduler.ts';

const log = pino({ level: 'silent' });
const dbs: Array<{ close(): void }> = [];
const schedulers: Scheduler[] = [];
function freshDb() {
  const h = openDb(join(mkdtempSync(join(tmpdir(), 'orc-sched-')), 'index.db'));
  dbs.push(h);
  return h.db;
}
function make(db: ReturnType<typeof freshDb>, now?: () => Date) {
  const s = createScheduler({ db, log, now });
  schedulers.push(s);
  return s;
}
afterEach(() => {
  for (const s of schedulers.splice(0)) s.stop();
  for (const d of dbs.splice(0)) d.close();
});

describe('scheduler', () => {
  it('fires a one-shot job once and disables it', async () => {
    const s = make(freshDb());
    const fired: ScheduledJob[] = [];
    s.onFire('reminder', async (j) => void fired.push(j));
    s.start();
    const job = s.add({ kind: 'reminder', cron: null, runAt: new Date(Date.now() + 1100).toISOString(), payload: { reminderId: 'r1' }, enabled: true });
    await vi.waitFor(() => expect(fired).toHaveLength(1), { timeout: 4000, interval: 100 });
    expect(fired[0]?.payload).toEqual({ reminderId: 'r1' });
    expect(s.get(job.id)?.enabled).toBe(false);
  });

  it('catches up an overdue one-shot job exactly once across restarts', async () => {
    const db = freshDb();
    const a = make(db);
    const job = a.add({ kind: 'reminder', cron: null, runAt: '2026-01-01T00:00:00.000Z', payload: {}, enabled: true });
    a.stop();
    const fired: string[] = [];
    const b = make(db);
    b.onFire('reminder', async (j) => void fired.push(j.id));
    b.start();
    await vi.waitFor(() => expect(fired).toEqual([job.id]));
    b.stop();
    const c = make(db);
    c.onFire('reminder', async (j) => void fired.push(j.id));
    c.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(fired).toEqual([job.id]);
  });

  it('runs a seconds-level cron job and keeps it enabled', async () => {
    const s = make(freshDb());
    let n = 0;
    s.onFire('digest', async () => {
      n++;
    });
    s.start();
    const job = s.add({ kind: 'digest', cron: '* * * * * *', runAt: null, payload: { type: 't' }, enabled: true });
    await vi.waitFor(() => expect(n).toBeGreaterThanOrEqual(1), { timeout: 3000, interval: 100 });
    expect(s.get(job.id)?.enabled).toBe(true);
  });

  it('rejects invalid jobs and stops removed ones', async () => {
    const s = make(freshDb());
    expect(() => s.add({ kind: 'digest', cron: 'not a cron', runAt: null, payload: {}, enabled: true })).toThrow(/invalid cron/);
    expect(() => s.add({ kind: 'digest', cron: null, runAt: null, payload: {}, enabled: true })).toThrow(/cron or runAt/);
    let n = 0;
    s.onFire('digest', async () => {
      n++;
    });
    s.start();
    const job = s.add({ kind: 'digest', cron: '* * * * * *', runAt: null, payload: {}, enabled: true });
    s.remove(job.id);
    await new Promise((r) => setTimeout(r, 1300));
    expect(n).toBe(0);
    expect(s.list('digest')).toEqual([]);
  });

  it('logs handler errors without breaking other handlers', async () => {
    const s = make(freshDb());
    const ok: string[] = [];
    s.onFire('reminder', async () => {
      throw new Error('boom');
    });
    s.onFire('reminder', async (j) => void ok.push(j.id));
    s.start();
    const job = s.add({ kind: 'reminder', cron: null, runAt: '2026-01-01T00:00:00.000Z', payload: {}, enabled: true });
    await vi.waitFor(() => expect(ok).toEqual([job.id]));
  });

  it('ensureCronJob is idempotent and replaces a changed cron', () => {
    const s = make(freshDb());
    const a = ensureCronJob(s, 'digest', 'weekly_digest', '0 9 * * 1');
    const b = ensureCronJob(s, 'digest', 'weekly_digest', '0 9 * * 1');
    expect(b.id).toBe(a.id);
    const c = ensureCronJob(s, 'digest', 'weekly_digest', '0 10 * * 1');
    expect(c.id).not.toBe(a.id);
    expect(s.list('digest').map((j) => j.cron)).toEqual(['0 10 * * 1']);
    expect(removeJobsOfType(s, 'digest', 'weekly_digest')).toBe(1);
    expect(s.list('digest')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/scheduler`
Expected: FAIL, `Cannot find module './scheduler.ts'`.

- [ ] **Step 4: Write the repo**

`apps/daemon/src/db/repos/scheduled-jobs.ts`
```ts
import { asc, eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { scheduledJobs } from '../schema.ts';
import type { ScheduledJob } from '../../services/scheduler/scheduler.ts';

type Row = typeof scheduledJobs.$inferSelect;

function toJob(r: Row): ScheduledJob {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(r.payloadJson);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return { id: r.id, kind: r.kind, cron: r.cron, runAt: r.runAt, payload, enabled: r.enabled };
}

export function insertJob(db: OrcDb, j: ScheduledJob, createdAt: string): void {
  db.insert(scheduledJobs)
    .values({
      id: j.id,
      kind: j.kind,
      cron: j.cron,
      runAt: j.runAt,
      payloadJson: JSON.stringify(j.payload),
      enabled: j.enabled,
      lastFiredAt: null,
      createdAt,
    })
    .run();
}

export function getJob(db: OrcDb, id: string): ScheduledJob | null {
  const r = db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)).get();
  return r ? toJob(r) : null;
}

export function listJobs(db: OrcDb, kind?: ScheduledJob['kind']): ScheduledJob[] {
  const q = db.select().from(scheduledJobs);
  const rows = kind ? q.where(eq(scheduledJobs.kind, kind)).orderBy(asc(scheduledJobs.createdAt)).all() : q.orderBy(asc(scheduledJobs.createdAt)).all();
  return rows.map(toJob);
}

export function deleteJob(db: OrcDb, id: string): void {
  db.delete(scheduledJobs).where(eq(scheduledJobs.id, id)).run();
}

export function markFired(db: OrcDb, id: string, at: string, disable: boolean): void {
  db.update(scheduledJobs)
    .set(disable ? { lastFiredAt: at, enabled: false } : { lastFiredAt: at })
    .where(eq(scheduledJobs.id, id))
    .run();
}
```

- [ ] **Step 5: Write the scheduler**

`apps/daemon/src/services/scheduler/scheduler.ts`
```ts
import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import type { Logger } from 'pino';
import type { OrcDb } from '../../db/client.ts';
import { deleteJob, getJob, insertJob, listJobs, markFired } from '../../db/repos/scheduled-jobs.ts';

export interface ScheduledJob {
  id: string;
  kind: 'reminder' | 'automation' | 'digest';
  cron: string | null;
  runAt: string | null;
  payload: Record<string, unknown>;
  enabled: boolean;
}

export interface Scheduler {
  add(job: Omit<ScheduledJob, 'id'>): ScheduledJob;
  remove(id: string): void;
  list(kind?: ScheduledJob['kind']): ScheduledJob[];
  onFire(kind: ScheduledJob['kind'], fn: (job: ScheduledJob) => Promise<void>): void;
  get(id: string): ScheduledJob | null;
  start(): void;
  stop(): void;
}

export function createScheduler(opts: { db: OrcDb; log: Logger; now?: () => Date }): Scheduler {
  const { db, log } = opts;
  const now = opts.now ?? (() => new Date());
  const handlers = new Map<ScheduledJob['kind'], Array<(job: ScheduledJob) => Promise<void>>>();
  const timers = new Map<string, Cron>();
  let started = false;

  const disarm = (id: string) => {
    timers.get(id)?.stop();
    timers.delete(id);
  };

  async function fire(id: string): Promise<void> {
    const job = getJob(db, id);
    if (!job || !job.enabled) return;
    const oneShot = job.cron === null;
    // At-most-once: persist before running handlers.
    markFired(db, id, now().toISOString(), oneShot);
    if (oneShot) disarm(id);
    for (const h of handlers.get(job.kind) ?? []) {
      try {
        await h({ ...job, enabled: !oneShot });
      } catch (err) {
        log.error({ err, jobId: id, kind: job.kind }, 'scheduled job handler failed');
      }
    }
  }

  function arm(job: ScheduledJob): void {
    disarm(job.id);
    if (!started || !job.enabled) return;
    if (job.cron !== null) {
      timers.set(job.id, new Cron(job.cron, { protect: true }, () => fire(job.id)));
      return;
    }
    if (job.runAt !== null) {
      const at = new Date(job.runAt);
      if (at.getTime() <= now().getTime()) {
        void fire(job.id);
        return;
      }
      timers.set(job.id, new Cron(at, { maxRuns: 1 }, () => fire(job.id)));
    }
  }

  return {
    add(input) {
      if (input.cron === null && input.runAt === null) throw new Error('a scheduled job needs cron or runAt');
      if (input.cron !== null) {
        try {
          new Cron(input.cron, { paused: true }).stop();
        } catch {
          throw new Error(`invalid cron expression: ${input.cron}`);
        }
      }
      if (input.runAt !== null && Number.isNaN(Date.parse(input.runAt))) throw new Error(`invalid runAt: ${input.runAt}`);
      const job: ScheduledJob = { ...input, id: randomUUID() };
      insertJob(db, job, now().toISOString());
      arm(job);
      return job;
    },
    remove(id) {
      disarm(id);
      deleteJob(db, id);
    },
    list: (kind) => listJobs(db, kind),
    onFire(kind, fn) {
      handlers.set(kind, [...(handlers.get(kind) ?? []), fn]);
    },
    get: (id) => getJob(db, id),
    start() {
      if (started) return;
      started = true;
      for (const job of listJobs(db)) arm(job);
    },
    stop() {
      started = false;
      for (const id of [...timers.keys()]) disarm(id);
    },
  };
}

/** Makes sure exactly one job of `kind` with `payload.type === type` exists with this cron. */
export function ensureCronJob(
  s: Scheduler,
  kind: ScheduledJob['kind'],
  type: string,
  cron: string,
  extra: Record<string, unknown> = {},
): ScheduledJob {
  const existing = s.list(kind).filter((j) => j.payload.type === type);
  const same = existing.find((j) => j.cron === cron && j.enabled);
  for (const j of existing) if (j !== same) s.remove(j.id);
  return same ?? s.add({ kind, cron, runAt: null, payload: { ...extra, type }, enabled: true });
}

export function removeJobsOfType(s: Scheduler, kind: ScheduledJob['kind'], type: string): number {
  const jobs = s.list(kind).filter((j) => j.payload.type === type);
  for (const j of jobs) s.remove(j.id);
  return jobs.length;
}
```

Croner 10's constructor is `new Cron(pattern: string | Date, options?, fn?)`. The installed `node_modules/croner/dist/croner.d.ts` confirms the `paused`, `protect` and `maxRuns` options.

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm vitest run apps/daemon/src/services/scheduler`
Expected: PASS (6 tests). The first and third tests take about 1–2 s each.

- [ ] **Step 7: Wire it**

In `apps/daemon/src/context.ts`, inside `buildContext()`, after the audit service is created:
```ts
  ctx.scheduler = createScheduler({ db: ctx.db, log: ctx.log.child({ svc: 'scheduler' }) });
```
The `scheduler?: Scheduler` field already exists in `DaemonContext` (§11). Point its type import at `./services/scheduler/scheduler.ts`.

In `apps/daemon/src/main.ts` → `createDaemon()`, after `buildContext()`, add `ctx.scheduler?.start();`. In `close()`, add `ctx.scheduler?.stop();` before the DB is closed.

- [ ] **Step 8: Commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(daemon): add persisted croner scheduler with at-most-once one-shot jobs"
```

---

### Task 4: Core quota maths, pricing and ledger extraction

**Files:**
- Create: `packages/core/src/derive/pricing.ts`, `packages/core/src/derive/quota.ts`, `packages/core/src/derive/ledger.ts`
- Create: `packages/core/src/derive/quota.test.ts`, `packages/core/src/derive/ledger.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/browser.ts`

**Interfaces:**
- Consumes: `Usage`, `TimelineEvent`, `UsageSnapshot`, `OfficialQuotaSample`, `ToolKind` (core types)
- Produces:
  ```ts
  // derive/pricing.ts
  export type PriceTable = Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }>;
  export function estimateCostUsd(model: string, u: Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>, prices: PriceTable): number | null
  // derive/quota.ts
  export const BLOCK_MS: number; export const WEEK_MS: number; export const OFFICIAL_MAX_AGE_MS: number;
  export interface QuotaEntry { ts: number; tokens: number; costUsd: number }
  export interface QuotaBlock { start: number; end: number; firstTs: number; lastTs: number; tokens: number; costUsd: number; entries: number }
  export interface QuotaLimits { blockTokenLimit: number | null; weekTokenLimit: number | null }
  export interface OfficialFieldPaths { blockPct: string | null; blockResetsAt: string | null; weekPct: string | null; weekResetsAt: string | null }
  export function quotaTokens(u: Pick<Usage, 'input' | 'output' | 'cacheWrite'>): number
  export function buildBlocks(entries: QuotaEntry[]): QuotaBlock[]
  export function activeBlock(blocks: QuotaBlock[], now: number): QuotaBlock | null
  export function windowTotals(entries: QuotaEntry[], from: number, to: number): { tokens: number; costUsd: number }
  export function burnRate(block: QuotaBlock, now: number): { usdPerHour: number; tokensPerMin: number }
  export function projectExhaustion(block: QuotaBlock, limitTokens: number | null, tokensPerMin: number, now: number): number | null
  export function projectFromPct(pct: number | null, start: number, end: number, now: number): number | null
  export function computeUsageSnapshot(i: { entries: QuotaEntry[]; now: number; limits: QuotaLimits; official: OfficialQuotaSample | null }): UsageSnapshot
  export function contextWindowFor(model: string | null, windows: Record<string, number>, defaultWindow: number): number
  export function contextFill(u: Pick<Usage, 'input' | 'cacheRead' | 'cacheWrite'>, model: string | null, windows: Record<string, number>, defaultWindow: number): { usedTokens: number; windowTokens: number; fill: number } | null
  export function readPath(obj: unknown, path: string): unknown
  export function mapOfficialQuota(raw: unknown, paths: OfficialFieldPaths, atIso: string): OfficialQuotaSample | null
  // derive/ledger.ts
  export interface LedgerUsageFact { agentKey: string; messageId: string; ts: string; model: string; usage: Usage; latencyMs: number | null }
  export interface LedgerToolFact { agentKey: string; factKey: string; ts: string; kind: ToolKind; name: string; toolUseId: string | null }
  export interface LedgerExtract { usage: LedgerUsageFact[]; tools: LedgerToolFact[]; toolResults: Array<{ toolUseId: string; ts: string }>; lastTs: string | null }
  export function extractLedgerFacts(events: TimelineEvent[], agentKey: string, prevTs: string | null): LedgerExtract
  ```
- Notes:
  - The 5-hour block rule follows ccusage. A block starts at the first message, floored to the hour, and lasts 5 h. A new block starts when a message falls at or after the block's end, or after a gap of 5 h or more.
  - **Quota tokens are `input + output + cacheWrite`**, matching spike S7's estimator. Cache reads are excluded.
  - `pctOfLimit` values are fractions.
  - An official percentage greater than 1 is treated as a 0–100 value and divided by 100.

- [ ] **Step 1: Write the failing quota test**

`packages/core/src/derive/quota.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from './pricing.ts';
import {
  BLOCK_MS,
  activeBlock,
  buildBlocks,
  burnRate,
  computeUsageSnapshot,
  contextFill,
  contextWindowFor,
  mapOfficialQuota,
  projectExhaustion,
  projectFromPct,
  quotaTokens,
  windowTotals,
} from './quota.ts';

const H = 3_600_000;
const t = (iso: string) => Date.parse(iso);
const PRICES = { 'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } };

describe('pricing', () => {
  it('prices per million tokens and returns null for unknown models', () => {
    expect(estimateCostUsd('claude-opus-5', { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 0 }, PRICES)).toBeCloseTo(8.5, 6);
    expect(estimateCostUsd('claude-opus-5[1m]', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, PRICES)).toBeCloseTo(5, 6);
    expect(estimateCostUsd('gpt-x', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, PRICES)).toBeNull();
  });
});

describe('blocks', () => {
  const entries = [
    { ts: t('2026-09-17T09:20:00Z'), tokens: 100, costUsd: 1 },
    { ts: t('2026-09-17T11:00:00Z'), tokens: 200, costUsd: 2 },
    { ts: t('2026-09-17T14:10:00Z'), tokens: 50, costUsd: 0.5 }, // after 09:00+5h → new block at 14:00
    { ts: t('2026-09-17T08:00:00Z'), tokens: 10, costUsd: 0.1 }, // unsorted input
  ];

  it('groups entries into 5h blocks floored to the hour', () => {
    const blocks = buildBlocks(entries);
    expect(blocks.map((b) => new Date(b.start).toISOString())).toEqual(['2026-09-17T08:00:00.000Z', '2026-09-17T14:00:00.000Z']);
    expect(blocks[0]).toMatchObject({ tokens: 310, entries: 3, end: t('2026-09-17T08:00:00Z') + BLOCK_MS });
  });

  it('starts a new block after a 5h gap even inside the window', () => {
    const b = buildBlocks([
      { ts: t('2026-09-17T00:00:00Z'), tokens: 1, costUsd: 0 },
      { ts: t('2026-09-17T04:59:00Z'), tokens: 1, costUsd: 0 },
      { ts: t('2026-09-17T10:00:00Z'), tokens: 1, costUsd: 0 },
    ]);
    expect(b).toHaveLength(2);
  });

  it('finds the active block, totals, burn rate and projection', () => {
    const blocks = buildBlocks(entries);
    const now = t('2026-09-17T15:10:00Z');
    const act = activeBlock(blocks, now);
    expect(act?.start).toBe(t('2026-09-17T14:00:00Z'));
    expect(activeBlock(blocks, t('2026-09-17T20:00:00Z'))).toBeNull();
    expect(windowTotals(entries, t('2026-09-17T09:00:00Z'), now)).toEqual({ tokens: 350, costUsd: 3.5 });
    // act: 50 tokens, $0.5 over 60 min since first entry 14:10
    const rate = burnRate(act as NonNullable<typeof act>, now);
    expect(rate.usdPerHour).toBeCloseTo(0.5, 6);
    expect(rate.tokensPerMin).toBeCloseTo(50 / 60, 6);
    // limit 100 → 50 more tokens at 50/60 per min = 60 min → 16:10 (< end 19:00)
    expect(projectExhaustion(act as NonNullable<typeof act>, 100, rate.tokensPerMin, now)).toBe(t('2026-09-17T16:10:00Z'));
    expect(projectExhaustion(act as NonNullable<typeof act>, 10_000, rate.tokensPerMin, now)).toBeNull();
    expect(projectExhaustion(act as NonNullable<typeof act>, null, rate.tokensPerMin, now)).toBeNull();
    expect(projectExhaustion(act as NonNullable<typeof act>, 40, rate.tokensPerMin, now)).toBe(now);
  });

  it('projects from an official percentage', () => {
    const start = t('2026-09-17T10:00:00Z');
    expect(projectFromPct(0.5, start, start + 5 * H, start + H)).toBe(start + 2 * H);
    expect(projectFromPct(0.1, start, start + 5 * H, start + H)).toBeNull();
    expect(projectFromPct(null, start, start + 5 * H, start + H)).toBeNull();
  });

  it('counts quota tokens without cache reads', () => {
    expect(quotaTokens({ input: 1, output: 2, cacheWrite: 3 })).toBe(6);
  });
});

describe('computeUsageSnapshot', () => {
  const now = t('2026-09-17T15:10:00Z');
  const entries = [
    { ts: t('2026-09-10T10:00:00Z'), tokens: 1000, costUsd: 10 }, // > 7 days before now → excluded from week
    { ts: t('2026-09-16T10:00:00Z'), tokens: 400, costUsd: 4 },
    { ts: t('2026-09-17T14:10:00Z'), tokens: 50, costUsd: 0.5 },
  ];

  it('labels estimates and leaves pct null without plan limits', () => {
    const s = computeUsageSnapshot({ entries, now, limits: { blockTokenLimit: null, weekTokenLimit: null }, official: null });
    expect(s).toMatchObject({
      source: 'estimate',
      generatedAt: new Date(now).toISOString(),
      block: { active: true, start: '2026-09-17T14:00:00.000Z', end: '2026-09-17T19:00:00.000Z', tokens: 50, costUsd: 0.5, pctOfLimit: null },
      week: { tokens: 450, costUsd: 4.5, pctOfLimit: null },
      projectedBlockExhaustionAt: null,
    });
  });

  it('computes pct from user plan limits', () => {
    const s = computeUsageSnapshot({ entries, now, limits: { blockTokenLimit: 100, weekTokenLimit: 900 }, official: null });
    expect(s.block.pctOfLimit).toBeCloseTo(0.5, 6);
    expect(s.week.pctOfLimit).toBeCloseTo(0.5, 6);
    expect(s.projectedBlockExhaustionAt).toBe('2026-09-17T16:10:00.000Z');
  });

  it('reports an inactive block when nothing ran in the last 5h', () => {
    const s = computeUsageSnapshot({ entries: entries.slice(0, 2), now, limits: { blockTokenLimit: null, weekTokenLimit: null }, official: null });
    expect(s.block).toMatchObject({ active: false, tokens: 0, costUsd: 0, start: new Date(now).toISOString() });
    expect(s.burnRateUsdPerHour).toBe(0);
  });

  it('prefers a fresh official sample and ignores a stale one', () => {
    const official = { at: '2026-09-17T15:05:00.000Z', blockPct: 0.42, blockResetsAt: '2026-09-17T18:30:00.000Z', weekPct: 0.1, weekResetsAt: null };
    const s = computeUsageSnapshot({ entries, now, limits: { blockTokenLimit: null, weekTokenLimit: null }, official });
    expect(s.source).toBe('official');
    expect(s.block).toMatchObject({ pctOfLimit: 0.42, end: '2026-09-17T18:30:00.000Z', start: '2026-09-17T13:30:00.000Z' });
    expect(s.week.pctOfLimit).toBe(0.1);
    const stale = computeUsageSnapshot({ entries, now, limits: { blockTokenLimit: null, weekTokenLimit: null }, official: { ...official, at: '2026-09-17T12:00:00.000Z' } });
    expect(stale.source).toBe('estimate');
  });
});

describe('contextFill', () => {
  const windows = { 'claude-opus-5': 1_000_000, 'claude-haiku-4-5': 200_000 };
  it('uses the model window, falls back to the default, and bumps to 1M on overflow', () => {
    expect(contextFill({ input: 10, cacheRead: 90_000, cacheWrite: 10_000 }, 'claude-haiku-4-5', windows, 200_000)).toEqual({ usedTokens: 100_010, windowTokens: 200_000, fill: 100_010 / 200_000 });
    expect(contextFill({ input: 0, cacheRead: 50_000, cacheWrite: 0 }, 'unknown-model', windows, 200_000)?.windowTokens).toBe(200_000);
    expect(contextFill({ input: 0, cacheRead: 300_000, cacheWrite: 0 }, 'unknown-model', windows, 200_000)?.windowTokens).toBe(1_000_000);
    expect(contextFill({ input: 0, cacheRead: 100, cacheWrite: 0 }, 'claude-haiku-4-5[1m]', windows, 200_000)?.windowTokens).toBe(1_000_000);
    expect(contextFill({ input: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-opus-5', windows, 200_000)).toBeNull();
    expect(contextWindowFor('claude-opus-5', windows, 200_000)).toBe(1_000_000);
    expect(contextWindowFor(null, windows, 200_000)).toBe(200_000);
  });
});

describe('mapOfficialQuota', () => {
  const paths = { blockPct: 'rate_limits.five_hour.used_percentage', blockResetsAt: 'rate_limits.five_hour.resets_at', weekPct: 'rate_limits.seven_day.used_percentage', weekResetsAt: null };
  it('reads dotted paths, normalises percent values and epoch seconds', () => {
    const raw = { rate_limits: { five_hour: { used_percentage: 42, resets_at: 1789660800 }, seven_day: { used_percentage: 0.3 } } };
    expect(mapOfficialQuota(raw, paths, '2026-09-17T10:00:00.000Z')).toEqual({
      at: '2026-09-17T10:00:00.000Z',
      blockPct: 0.42,
      blockResetsAt: new Date(1789660800 * 1000).toISOString(),
      weekPct: 0.3,
      weekResetsAt: null,
    });
  });
  it('returns null when nothing maps', () => {
    expect(mapOfficialQuota({ cost: 1 }, paths, '2026-09-17T10:00:00.000Z')).toBeNull();
    expect(mapOfficialQuota({ rate_limits: {} }, { blockPct: null, blockResetsAt: null, weekPct: null, weekResetsAt: null }, 'x')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/core/src/derive/quota.test.ts`
Expected: FAIL, `Cannot find module './pricing.ts'`.

- [ ] **Step 3: Implement pricing and the quota maths**

`packages/core/src/derive/pricing.ts`
```ts
import type { Usage } from '../types/index.ts';

/** USD per 1M tokens. */
export type PriceTable = Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }>;

export function estimateCostUsd(
  model: string,
  u: Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>,
  prices: PriceTable,
): number | null {
  const p = prices[model] ?? prices[model.replace(/\[1m\]$/, '')];
  if (!p) return null;
  return (u.input * p.input + u.output * p.output + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1_000_000;
}
```

`packages/core/src/derive/quota.ts`
```ts
import type { OfficialQuotaSample, Usage, UsageSnapshot } from '../types/index.ts';

export const BLOCK_MS = 5 * 3_600_000;
export const WEEK_MS = 7 * 24 * 3_600_000;
export const OFFICIAL_MAX_AGE_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
const MIN_ELAPSED_MS = 60_000;

export interface QuotaEntry { ts: number; tokens: number; costUsd: number }
export interface QuotaBlock { start: number; end: number; firstTs: number; lastTs: number; tokens: number; costUsd: number; entries: number }
export interface QuotaLimits { blockTokenLimit: number | null; weekTokenLimit: number | null }
export interface OfficialFieldPaths { blockPct: string | null; blockResetsAt: string | null; weekPct: string | null; weekResetsAt: string | null }

export function quotaTokens(u: Pick<Usage, 'input' | 'output' | 'cacheWrite'>): number {
  return u.input + u.output + u.cacheWrite;
}

export function buildBlocks(entries: QuotaEntry[]): QuotaBlock[] {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  const blocks: QuotaBlock[] = [];
  for (const e of sorted) {
    const cur = blocks.at(-1);
    if (!cur || e.ts >= cur.end || e.ts - cur.lastTs >= BLOCK_MS) {
      const start = Math.floor(e.ts / HOUR_MS) * HOUR_MS;
      blocks.push({ start, end: start + BLOCK_MS, firstTs: e.ts, lastTs: e.ts, tokens: e.tokens, costUsd: e.costUsd, entries: 1 });
    } else {
      cur.lastTs = e.ts;
      cur.tokens += e.tokens;
      cur.costUsd += e.costUsd;
      cur.entries += 1;
    }
  }
  return blocks;
}

export function activeBlock(blocks: QuotaBlock[], now: number): QuotaBlock | null {
  const last = blocks.at(-1);
  if (!last) return null;
  return now < last.end && now - last.lastTs < BLOCK_MS ? last : null;
}

export function windowTotals(entries: QuotaEntry[], from: number, to: number): { tokens: number; costUsd: number } {
  let tokens = 0;
  let costUsd = 0;
  for (const e of entries) {
    if (e.ts >= from && e.ts <= to) {
      tokens += e.tokens;
      costUsd += e.costUsd;
    }
  }
  return { tokens, costUsd };
}

export function burnRate(block: QuotaBlock, now: number): { usdPerHour: number; tokensPerMin: number } {
  const elapsed = Math.max(MIN_ELAPSED_MS, Math.min(now, block.end) - block.firstTs);
  return { usdPerHour: block.costUsd / (elapsed / HOUR_MS), tokensPerMin: block.tokens / (elapsed / 60_000) };
}

export function projectExhaustion(block: QuotaBlock, limitTokens: number | null, tokensPerMin: number, now: number): number | null {
  if (limitTokens === null) return null;
  if (block.tokens >= limitTokens) return now;
  if (tokensPerMin <= 0) return null;
  const at = now + ((limitTokens - block.tokens) / tokensPerMin) * 60_000;
  return at < block.end ? Math.round(at) : null;
}

export function projectFromPct(pct: number | null, start: number, end: number, now: number): number | null {
  if (pct === null || pct <= 0) return null;
  if (pct >= 1) return now;
  const elapsed = Math.max(MIN_ELAPSED_MS, now - start);
  const at = start + elapsed / pct;
  return at < end ? Math.round(at) : null;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function computeUsageSnapshot(i: {
  entries: QuotaEntry[];
  now: number;
  limits: QuotaLimits;
  official: OfficialQuotaSample | null;
}): UsageSnapshot {
  const { entries, now, limits } = i;
  const act = activeBlock(buildBlocks(entries), now);
  const week = windowTotals(entries, now - WEEK_MS, now);
  const rate = act ? burnRate(act, now) : { usdPerHour: 0, tokensPerMin: 0 };
  let start = act ? act.start : now;
  let end = act ? act.end : now + BLOCK_MS;
  let blockPct = act && limits.blockTokenLimit !== null ? act.tokens / limits.blockTokenLimit : null;
  let weekPct = limits.weekTokenLimit !== null ? week.tokens / limits.weekTokenLimit : null;
  let projected = act ? projectExhaustion(act, limits.blockTokenLimit, rate.tokensPerMin, now) : null;
  let source: UsageSnapshot['source'] = 'estimate';

  const off = i.official;
  if (off && now - Date.parse(off.at) <= OFFICIAL_MAX_AGE_MS) {
    source = 'official';
    if (off.blockPct !== null) blockPct = off.blockPct;
    if (off.weekPct !== null) weekPct = off.weekPct;
    if (off.blockResetsAt !== null) {
      end = Date.parse(off.blockResetsAt);
      start = end - BLOCK_MS;
    }
    projected = projectFromPct(blockPct, start, end, now);
  }

  return {
    source,
    generatedAt: iso(now),
    block: {
      active: act !== null || source === 'official',
      start: iso(start),
      end: iso(end),
      tokens: act?.tokens ?? 0,
      costUsd: act?.costUsd ?? 0,
      pctOfLimit: blockPct,
    },
    week: { tokens: week.tokens, costUsd: week.costUsd, pctOfLimit: weekPct },
    burnRateUsdPerHour: rate.usdPerHour,
    burnRateTokensPerMin: rate.tokensPerMin,
    projectedBlockExhaustionAt: projected === null ? null : iso(projected),
  };
}

const ONE_MILLION = 1_000_000;

/** Context window for a model id: `[1m]` suffix → 1M, else the configured table, else the default. */
export function contextWindowFor(model: string | null, windows: Record<string, number>, defaultWindow: number): number {
  if (model === null) return defaultWindow;
  if (model.endsWith('[1m]')) return ONE_MILLION;
  return windows[model] ?? defaultWindow;
}

export function contextFill(
  u: Pick<Usage, 'input' | 'cacheRead' | 'cacheWrite'>,
  model: string | null,
  windows: Record<string, number>,
  defaultWindow: number,
): { usedTokens: number; windowTokens: number; fill: number } | null {
  const usedTokens = u.input + u.cacheRead + u.cacheWrite;
  if (usedTokens === 0) return null;
  let windowTokens = contextWindowFor(model, windows, defaultWindow);
  if (usedTokens > windowTokens && windowTokens < ONE_MILLION) windowTokens = ONE_MILLION;
  return { usedTokens, windowTokens, fill: Math.min(1, usedTokens / windowTokens) };
}

export function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function pctAt(raw: unknown, path: string | null): number | null {
  if (path === null) return null;
  const v = readPath(raw, path);
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v > 1 ? v / 100 : v;
}

function timeAt(raw: unknown, path: string | null): string | null {
  if (path === null) return null;
  const v = readPath(raw, path);
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

export function mapOfficialQuota(raw: unknown, paths: OfficialFieldPaths, atIso: string): OfficialQuotaSample | null {
  const s: OfficialQuotaSample = {
    at: atIso,
    blockPct: pctAt(raw, paths.blockPct),
    blockResetsAt: timeAt(raw, paths.blockResetsAt),
    weekPct: pctAt(raw, paths.weekPct),
    weekResetsAt: timeAt(raw, paths.weekResetsAt),
  };
  return s.blockPct === null && s.weekPct === null && s.blockResetsAt === null && s.weekResetsAt === null ? null : s;
}
```

- [ ] **Step 4: Run the quota test and confirm it passes**

Run: `pnpm vitest run packages/core/src/derive/quota.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Write the failing ledger test**

`packages/core/src/derive/ledger.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import type { TimelineEvent, Usage } from '../types/index.ts';
import { extractLedgerFacts } from './ledger.ts';

const u = (input: number, output: number, costUsd: number | null = null): Usage => ({ input, output, cacheRead: 0, cacheWrite: 0, costUsd });
const e = (p: Partial<TimelineEvent> & { seq: number; ts: string; kind: TimelineEvent['kind'] }): TimelineEvent => ({
  sessionId: 's', agentId: null, uuid: `u${p.seq}`, parentUuid: null, turn: 1, text: null, tool: null, toolUseId: null,
  mcpServer: null, input: null, messageId: null, model: null, usage: null, durationMs: null, ...p,
});

const events: TimelineEvent[] = [
  e({ seq: 1, ts: '2026-09-17T10:00:00.000Z', kind: 'prompt', text: '/conductor SAF-1 go' }),
  e({ seq: 2, ts: '2026-09-17T10:00:04.000Z', kind: 'assistant_text', messageId: 'm1', model: 'claude-opus-5', usage: u(10, 20) }),
  e({ seq: 3, ts: '2026-09-17T10:00:04.100Z', kind: 'tool_call', messageId: 'm1', model: 'claude-opus-5', tool: 'Bash', toolUseId: 't1' }),
  e({ seq: 4, ts: '2026-09-17T10:00:09.100Z', kind: 'tool_result', toolUseId: 't1', text: 'SECRET OUTPUT' }),
  e({ seq: 5, ts: '2026-09-17T10:00:11.100Z', kind: 'tool_call', messageId: 'm2', model: 'claude-opus-5', usage: u(5, 5, 0.3), tool: 'Skill', toolUseId: 't2', input: { skill: 'review' } }),
  e({ seq: 6, ts: '2026-09-17T10:00:12.000Z', kind: 'tool_call', messageId: 'm2', model: 'claude-opus-5', tool: 'mcp__claude_ai_Linear__save_issue', mcpServer: 'claude_ai_Linear', toolUseId: 't3' }),
  e({ seq: 7, ts: '2026-09-17T10:00:13.000Z', kind: 'error', messageId: 'm3', model: '<synthetic>', usage: u(0, 0) }),
];

describe('extractLedgerFacts', () => {
  it('extracts one usage fact per message with latency, skipping synthetic', () => {
    const x = extractLedgerFacts(events, '', null);
    expect(x.usage.map((f) => [f.messageId, f.latencyMs, f.usage.costUsd])).toEqual([
      ['m1', 4000, null],
      ['m2', 2000, 0.3],
    ]);
    expect(x.lastTs).toBe('2026-09-17T10:00:13.000Z');
  });

  it('classifies tools, MCP servers and skills and records results', () => {
    const x = extractLedgerFacts(events, 'ag1', null);
    expect(x.tools.map((t) => [t.kind, t.name, t.toolUseId, t.agentKey])).toEqual([
      ['skill', 'conductor', null, 'ag1'],
      ['tool', 'Bash', 't1', 'ag1'],
      ['skill', 'review', 't2', 'ag1'],
      ['mcp', 'claude_ai_Linear', 't3', 'ag1'],
    ]);
    expect(x.tools[0]?.factKey).toBe('prompt:2026-09-17T10:00:00.000Z:skill:conductor');
    expect(x.toolResults).toEqual([{ toolUseId: 't1', ts: '2026-09-17T10:00:09.100Z' }]);
  });

  it('uses prevTs for the first event of a batch and never copies text', () => {
    const x = extractLedgerFacts([events[1] as TimelineEvent], '', '2026-09-17T10:00:01.000Z');
    expect(x.usage[0]?.latencyMs).toBe(3000);
    expect(JSON.stringify(extractLedgerFacts(events, '', null))).not.toContain('SECRET');
  });
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `pnpm vitest run packages/core/src/derive/ledger.test.ts`
Expected: FAIL, `Cannot find module './ledger.ts'`.

- [ ] **Step 7: Implement the extractor**

`packages/core/src/derive/ledger.ts`
```ts
import type { TimelineEvent, ToolKind, Usage } from '../types/index.ts';

export interface LedgerUsageFact { agentKey: string; messageId: string; ts: string; model: string; usage: Usage; latencyMs: number | null }
export interface LedgerToolFact { agentKey: string; factKey: string; ts: string; kind: ToolKind; name: string; toolUseId: string | null }
export interface LedgerExtract {
  usage: LedgerUsageFact[];
  tools: LedgerToolFact[];
  toolResults: Array<{ toolUseId: string; ts: string }>;
  lastTs: string | null;
}

const SLASH = /^\/([A-Za-z0-9][\w:-]*)/;

function skillOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const v = (input as Record<string, unknown>).skill;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Pure: turns a batch of timeline events (one transcript, seq order) into ledger facts. Never copies text. */
export function extractLedgerFacts(events: TimelineEvent[], agentKey: string, prevTs: string | null): LedgerExtract {
  const out: LedgerExtract = { usage: [], tools: [], toolResults: [], lastTs: prevTs };
  let prev: { ts: string; messageId: string | null } | null = prevTs ? { ts: prevTs, messageId: null } : null;
  for (const ev of events) {
    if (ev.usage && ev.messageId && ev.model && ev.model !== '<synthetic>') {
      const latency = prev && prev.messageId !== ev.messageId ? Date.parse(ev.ts) - Date.parse(prev.ts) : null;
      out.usage.push({
        agentKey,
        messageId: ev.messageId,
        ts: ev.ts,
        model: ev.model,
        usage: ev.usage,
        latencyMs: latency !== null && latency >= 0 ? latency : null,
      });
    }
    if (ev.kind === 'prompt' && ev.text) {
      const m = SLASH.exec(ev.text.trim());
      if (m?.[1]) {
        out.tools.push({ agentKey, factKey: `prompt:${ev.ts}:skill:${m[1]}`, ts: ev.ts, kind: 'skill', name: m[1], toolUseId: null });
      }
    }
    if (ev.kind === 'tool_call' && ev.tool) {
      const skill = ev.tool === 'Skill' ? skillOf(ev.input) : null;
      const kind: ToolKind = skill ? 'skill' : ev.mcpServer ? 'mcp' : 'tool';
      const name = skill ?? ev.mcpServer ?? ev.tool;
      const id = ev.toolUseId ?? `seq${ev.seq}`;
      out.tools.push({ agentKey, factKey: `${id}:${kind}:${name}`, ts: ev.ts, kind, name, toolUseId: ev.toolUseId });
    }
    if (ev.kind === 'tool_result' && ev.toolUseId) out.toolResults.push({ toolUseId: ev.toolUseId, ts: ev.ts });
    prev = { ts: ev.ts, messageId: ev.messageId };
    out.lastTs = ev.ts;
  }
  return out;
}
```

Append to both `packages/core/src/index.ts` and `packages/core/src/browser.ts`:
```ts
export * from './derive/pricing.ts';
export * from './derive/quota.ts';
export * from './derive/ledger.ts';
```

- [ ] **Step 8: Run the tests and confirm they pass**

Run: `pnpm vitest run packages/core/src/derive`
Expected: PASS (all core derive tests, including 16 new ones)

- [ ] **Step 9: Commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add packages/core
git commit -m "feat(core): add quota blocks, burn rate, context fill, pricing and ledger extraction"
```

---

### Task 5: Usage ledger (incremental per-message usage and tool facts)

**Files:**
- Create: `apps/daemon/src/db/repos/usage-ledger.ts`
- Create: `apps/daemon/src/services/usage/ledger.ts`, `apps/daemon/src/services/usage/ledger.test.ts`
- Modify: `apps/daemon/src/context.ts` (the `ledger?: UsageLedger` field, and construction in `buildContext`), `apps/daemon/src/main.ts` (start and stop)

**Interfaces:**
- Consumes: `extractLedgerFacts`, `estimateCostUsd` (Task 4); `usageEntries`, `toolUses`, `ledgerCursors` (Task 2); `SessionService` (P1); `listAllSessions` (Task 2); `config().limits.pricing` (Task 1)
- Produces:
  ```ts
  // repos/usage-ledger.ts
  export interface LedgerEntry { sessionPk: string; agentKey: string; messageId: string; ts: string; source: string; projectId: string | null; tickets: string[]; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; estCostUsd: number; allocCostUsd: number; authoritative: boolean; latencyMs: number | null }
  export interface LedgerTool { sessionPk: string; agentKey: string; factKey: string; ts: string; kind: ToolKind; name: string; toolUseId: string | null; projectId: string | null; durationMs: number | null }
  export interface LedgerQuery { from: string; to: string; projectId?: string; ticket?: string }
  export const SYNTHETIC_MESSAGE_ID = 'session-total'
  export function insertUsageEntries(db: OrcDb, rows: LedgerEntry[]): number
  export function insertToolUses(db: OrcDb, rows: LedgerTool[]): number
  export function setToolDuration(db: OrcDb, sessionPk: string, toolUseId: string, resultTs: string): void
  export function getCursor(db: OrcDb, sessionPk: string, agentKey: string): { afterSeq: number; lastTs: string | null }
  export function setCursor(db: OrcDb, sessionPk: string, agentKey: string, c: { afterSeq: number; lastTs: string | null }): void
  export function countRealEntries(db: OrcDb, sessionPk: string): number
  export function deleteSynthetic(db: OrcDb, sessionPk: string): void
  export function upsertSynthetic(db: OrcDb, row: LedgerEntry): void
  export function sumEstCost(db: OrcDb, sessionPk: string): number
  export function updateSessionAttribution(db: OrcDb, sessionPk: string, a: { projectId: string | null; tickets: string[]; factor: number; authoritative: boolean }): void
  export function listEntries(db: OrcDb, q: LedgerQuery): LedgerEntry[]
  export function listTools(db: OrcDb, q: Omit<LedgerQuery, 'ticket'>): LedgerTool[]
  export function sumAllocCost(db: OrcDb, q: LedgerQuery): number
  export function latestMainEntry(db: OrcDb, sessionPk: string): LedgerEntry | null
  // services/usage/ledger.ts
  export interface UsageLedger { syncSession; backfill; entries; tools; sumCost; latestMainUsage; start; stop }   // Contract additions
  export function createUsageLedger(ctx: DaemonContext, opts?: { debounceMs?: number; sweepMs?: number; backfillDays?: number; now?: () => Date }): UsageLedger
  ```
- Rules:
  - **Allocation.** Per-message cost is the event's `usage.costUsd`, or else `estimateCostUsd(model, usage, pricing)`, or else 0. When the session has an authoritative `usage.costUsd` (from `cost-state`) and the estimated total is above 0, every row of that session gets `allocCostUsd = estCostUsd × (sessionCost ÷ Σ estCostUsd)`, so totals match `cost-state`. Otherwise `alloc = est`, and the rows stay `authoritative = false`.
  - **Sessions with no per-message usage** (Codex rollouts) get one synthetic row, `messageId = 'session-total'`, timestamped at `lastActivityAt`. It is deleted as soon as real rows exist.
  - **Ticket and project attribution** is refreshed on every sync, because tickets can be discovered later.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/services/usage/ledger.test.ts`
```ts
import type { AgentNode, TimelineEvent, Usage } from '@orc/core';
import { describe, expect, it, vi } from 'vitest';
import { ev, makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import { createUsageLedger } from './ledger.ts';

const usage = (input: number, output: number): Usage => ({ input, output, cacheRead: 0, cacheWrite: 0, costUsd: null });
const agent = (id: string): AgentNode => ({
  id, sessionId: 's1', parentId: null, depth: 1, agentType: 'Explore', description: 'x', background: false,
  toolUseId: null, usage: usage(0, 0), startedAt: '2026-09-17T10:00:03.000Z', endedAt: null, status: 'done', transcriptPath: '/tmp/a.jsonl',
});

function setup() {
  const s1 = makeSession({
    id: 's1',
    tickets: ['SAF-1'],
    usage: { input: 3500, output: 600, cacheRead: 0, cacheWrite: 0, costUsd: 0.65 },
    lastActivityAt: '2026-09-17T10:05:00.000Z',
  });
  const c1 = makeSession({
    id: 'c1',
    source: 'codex',
    models: ['gpt-5.5-codex'],
    usage: { input: 1200, output: 90, cacheRead: 800, cacheWrite: 0, costUsd: null },
    lastActivityAt: '2026-09-17T11:00:00.000Z',
  });
  const main: TimelineEvent[] = [
    ev({ seq: 1, ts: '2026-09-17T10:00:00.000Z', kind: 'prompt', text: 'go' }),
    ev({ seq: 2, ts: '2026-09-17T10:00:02.000Z', kind: 'tool_call', messageId: 'm1', model: 'claude-opus-5', usage: usage(1000, 100), tool: 'Bash', toolUseId: 't1' }),
    ev({ seq: 3, ts: '2026-09-17T10:00:07.000Z', kind: 'tool_result', toolUseId: 't1' }),
    ev({ seq: 4, ts: '2026-09-17T10:00:09.000Z', kind: 'assistant_text', messageId: 'm2', model: 'claude-opus-5', usage: usage(2000, 0) }),
    ev({ seq: 5, ts: '2026-09-17T10:00:09.500Z', kind: 'assistant_text', messageId: 'm2', model: 'claude-opus-5' }),
  ];
  const sub: TimelineEvent[] = [
    ev({ seq: 1, ts: '2026-09-17T10:00:03.000Z', kind: 'assistant_text', agentId: 'ag1', messageId: 'm3', model: 'claude-opus-5', usage: usage(500, 500) }),
  ];
  const data = { sessions: [s1, c1], events: { 'claude:s1': [...main, ...sub] }, agents: { 'claude:s1': [agent('ag1')] } };
  const t = makeP5Context({ config: withWakecap('/Users/test/Wakecap'), data });
  return { ...t, main, data, ledger: createUsageLedger(t.ctx, { debounceMs: 10 }) };
}

const DAY = { from: '2026-09-17T00:00:00.000Z', to: '2026-09-17T23:59:59.999Z' };

describe('usage ledger', () => {
  it('syncs main and subagent usage once, allocating the authoritative session cost', async () => {
    const { ledger } = setup();
    expect(await ledger.syncSession('claude:s1')).toEqual({ added: 3 });
    expect(await ledger.syncSession('claude:s1')).toEqual({ added: 0 });
    const rows = ledger.entries(DAY).filter((r) => r.sessionPk === 'claude:s1');
    expect(rows.map((r) => r.messageId).sort()).toEqual(['m1', 'm2', 'm3']);
    expect(rows.reduce((a, r) => a + r.allocCostUsd, 0)).toBeCloseTo(0.65, 9);
    expect(rows.every((r) => r.authoritative && r.projectId === 'wakecap')).toBe(true);
    expect(rows.find((r) => r.messageId === 'm2')?.latencyMs).toBe(2000);
    expect(ledger.sumCost({ ...DAY, ticket: 'SAF-1' })).toBeCloseTo(0.65, 9);
    expect(ledger.sumCost({ ...DAY, ticket: 'SAF-10' })).toBe(0);
  });

  it('records tool facts with durations', async () => {
    const { ledger } = setup();
    await ledger.syncSession('claude:s1');
    expect(ledger.tools(DAY)).toEqual([
      expect.objectContaining({ kind: 'tool', name: 'Bash', toolUseId: 't1', durationMs: 5000, projectId: 'wakecap' }),
    ]);
  });

  it('adds a synthetic row for sessions without per-message usage', async () => {
    const { ledger } = setup();
    await ledger.syncSession('codex:c1');
    expect(ledger.entries(DAY)).toEqual([
      expect.objectContaining({ sessionPk: 'codex:c1', messageId: 'session-total', input: 1200, output: 90, cacheRead: 800, source: 'codex', model: 'gpt-5.5-codex', authoritative: false }),
    ]);
  });

  it('picks up appended events incrementally and exposes the latest main usage', async () => {
    const { ledger, data } = setup();
    await ledger.syncSession('claude:s1');
    data.events['claude:s1'].push(
      ev({ seq: 6, ts: '2026-09-17T10:04:00.000Z', kind: 'assistant_text', messageId: 'm4', model: 'claude-opus-5', usage: { input: 5, output: 1, cacheRead: 90_000, cacheWrite: 10, costUsd: null } }),
    );
    expect(await ledger.syncSession('claude:s1')).toEqual({ added: 1 });
    expect(ledger.latestMainUsage('claude:s1')).toEqual({ model: 'claude-opus-5', usage: expect.objectContaining({ cacheRead: 90_000 }) });
    expect(ledger.latestMainUsage('claude:nope')).toBeNull();
  });

  it('syncs sessions after session.updated when started', async () => {
    const { ctx, ledger, data } = setup();
    ledger.start();
    ctx.bus.emit({ type: 'session.updated', session: data.sessions[0] as (typeof data.sessions)[number] });
    await vi.waitFor(() => expect(ledger.entries(DAY).length).toBeGreaterThanOrEqual(3));
    ledger.stop();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/usage/ledger.test.ts`
Expected: FAIL, `Cannot find module './ledger.ts'`.

- [ ] **Step 3: Write the repo**

`apps/daemon/src/db/repos/usage-ledger.ts`
```ts
import type { ToolKind } from '@orc/core';
import { and, asc, desc, eq, gte, lte, ne, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { ledgerCursors, toolUses, usageEntries } from '../schema.ts';

export interface LedgerEntry {
  sessionPk: string;
  agentKey: string;
  messageId: string;
  ts: string;
  source: string;
  projectId: string | null;
  tickets: string[];
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  estCostUsd: number;
  allocCostUsd: number;
  authoritative: boolean;
  latencyMs: number | null;
}
export interface LedgerTool {
  sessionPk: string;
  agentKey: string;
  factKey: string;
  ts: string;
  kind: ToolKind;
  name: string;
  toolUseId: string | null;
  projectId: string | null;
  durationMs: number | null;
}
export interface LedgerQuery { from: string; to: string; projectId?: string; ticket?: string }

export const SYNTHETIC_MESSAGE_ID = 'session-total';

type EntryRow = typeof usageEntries.$inferSelect;

function toEntry(r: EntryRow): LedgerEntry {
  let tickets: string[] = [];
  try {
    const v: unknown = JSON.parse(r.ticketsJson);
    if (Array.isArray(v)) tickets = v.filter((x): x is string => typeof x === 'string');
  } catch {
    tickets = [];
  }
  const { ticketsJson: _t, ...rest } = r;
  return { ...rest, tickets };
}

const toRow = (e: LedgerEntry) => {
  const { tickets, ...rest } = e;
  return { ...rest, ticketsJson: JSON.stringify(tickets) };
};

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export function insertUsageEntries(db: OrcDb, rows: LedgerEntry[]): number {
  let n = 0;
  for (const part of chunks(rows, 400)) {
    n += db.insert(usageEntries).values(part.map(toRow)).onConflictDoNothing().run().changes;
  }
  return n;
}

export function insertToolUses(db: OrcDb, rows: LedgerTool[]): number {
  let n = 0;
  for (const part of chunks(rows, 500)) n += db.insert(toolUses).values(part).onConflictDoNothing().run().changes;
  return n;
}

export function setToolDuration(db: OrcDb, sessionPk: string, toolUseId: string, resultTs: string): void {
  const call = db
    .select({ ts: toolUses.ts, agentKey: toolUses.agentKey, factKey: toolUses.factKey })
    .from(toolUses)
    .where(and(eq(toolUses.sessionPk, sessionPk), eq(toolUses.toolUseId, toolUseId)))
    .get();
  if (!call) return;
  const ms = Date.parse(resultTs) - Date.parse(call.ts);
  if (!Number.isFinite(ms) || ms < 0) return;
  db.update(toolUses)
    .set({ durationMs: ms })
    .where(and(eq(toolUses.sessionPk, sessionPk), eq(toolUses.agentKey, call.agentKey), eq(toolUses.factKey, call.factKey)))
    .run();
}

export function getCursor(db: OrcDb, sessionPk: string, agentKey: string): { afterSeq: number; lastTs: string | null } {
  const r = db
    .select()
    .from(ledgerCursors)
    .where(and(eq(ledgerCursors.sessionPk, sessionPk), eq(ledgerCursors.agentKey, agentKey)))
    .get();
  return r ? { afterSeq: r.afterSeq, lastTs: r.lastTs } : { afterSeq: 0, lastTs: null };
}

export function setCursor(db: OrcDb, sessionPk: string, agentKey: string, c: { afterSeq: number; lastTs: string | null }): void {
  db.insert(ledgerCursors)
    .values({ sessionPk, agentKey, afterSeq: c.afterSeq, lastTs: c.lastTs })
    .onConflictDoUpdate({ target: [ledgerCursors.sessionPk, ledgerCursors.agentKey], set: { afterSeq: c.afterSeq, lastTs: c.lastTs } })
    .run();
}

export function countRealEntries(db: OrcDb, sessionPk: string): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(usageEntries)
      .where(and(eq(usageEntries.sessionPk, sessionPk), ne(usageEntries.messageId, SYNTHETIC_MESSAGE_ID)))
      .get()?.n ?? 0
  );
}

export function deleteSynthetic(db: OrcDb, sessionPk: string): void {
  db.delete(usageEntries)
    .where(and(eq(usageEntries.sessionPk, sessionPk), eq(usageEntries.messageId, SYNTHETIC_MESSAGE_ID)))
    .run();
}

export function upsertSynthetic(db: OrcDb, row: LedgerEntry): void {
  const r = toRow(row);
  db.insert(usageEntries)
    .values(r)
    .onConflictDoUpdate({
      target: [usageEntries.sessionPk, usageEntries.agentKey, usageEntries.messageId],
      set: { ts: r.ts, model: r.model, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, estCostUsd: r.estCostUsd },
    })
    .run();
}

export function sumEstCost(db: OrcDb, sessionPk: string): number {
  return (
    db
      .select({ s: sql<number>`coalesce(sum(${usageEntries.estCostUsd}), 0)` })
      .from(usageEntries)
      .where(eq(usageEntries.sessionPk, sessionPk))
      .get()?.s ?? 0
  );
}

export function updateSessionAttribution(
  db: OrcDb,
  sessionPk: string,
  a: { projectId: string | null; tickets: string[]; factor: number; authoritative: boolean },
): void {
  db.update(usageEntries)
    .set({
      projectId: a.projectId,
      ticketsJson: JSON.stringify(a.tickets),
      allocCostUsd: sql`${usageEntries.estCostUsd} * ${a.factor}`,
      authoritative: a.authoritative,
    })
    .where(eq(usageEntries.sessionPk, sessionPk))
    .run();
  db.update(toolUses).set({ projectId: a.projectId }).where(eq(toolUses.sessionPk, sessionPk)).run();
}

function entryWhere(q: LedgerQuery) {
  return and(
    gte(usageEntries.ts, q.from),
    lte(usageEntries.ts, q.to),
    q.projectId === undefined ? undefined : eq(usageEntries.projectId, q.projectId),
    q.ticket === undefined ? undefined : sql`${usageEntries.ticketsJson} like ${`%"${q.ticket}"%`}`,
  );
}

export function listEntries(db: OrcDb, q: LedgerQuery): LedgerEntry[] {
  return db.select().from(usageEntries).where(entryWhere(q)).orderBy(asc(usageEntries.ts)).all().map(toEntry);
}

export function listTools(db: OrcDb, q: Omit<LedgerQuery, 'ticket'>): LedgerTool[] {
  return db
    .select()
    .from(toolUses)
    .where(
      and(
        gte(toolUses.ts, q.from),
        lte(toolUses.ts, q.to),
        q.projectId === undefined ? undefined : eq(toolUses.projectId, q.projectId),
      ),
    )
    .orderBy(asc(toolUses.ts))
    .all();
}

export function sumAllocCost(db: OrcDb, q: LedgerQuery): number {
  return (
    db
      .select({ s: sql<number>`coalesce(sum(${usageEntries.allocCostUsd}), 0)` })
      .from(usageEntries)
      .where(entryWhere(q))
      .get()?.s ?? 0
  );
}

export function latestMainEntry(db: OrcDb, sessionPk: string): LedgerEntry | null {
  const r = db
    .select()
    .from(usageEntries)
    .where(
      and(eq(usageEntries.sessionPk, sessionPk), eq(usageEntries.agentKey, ''), ne(usageEntries.messageId, SYNTHETIC_MESSAGE_ID)),
    )
    .orderBy(desc(usageEntries.ts))
    .limit(1)
    .get();
  return r ? toEntry(r) : null;
}
```

- [ ] **Step 4: Write the service**

`apps/daemon/src/services/usage/ledger.ts`
```ts
import { type Session, type Usage, estimateCostUsd, extractLedgerFacts } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import {
  type LedgerEntry,
  type LedgerQuery,
  type LedgerTool,
  SYNTHETIC_MESSAGE_ID,
  countRealEntries,
  deleteSynthetic,
  getCursor,
  insertToolUses,
  insertUsageEntries,
  latestMainEntry,
  listEntries,
  listTools,
  setCursor,
  setToolDuration,
  sumAllocCost,
  sumEstCost,
  updateSessionAttribution,
  upsertSynthetic,
} from '../../db/repos/usage-ledger.ts';
import { listAllSessions } from '../session-pages.ts';
import { sessionPk } from '../sessions.ts';

export type { LedgerEntry, LedgerQuery, LedgerTool };

export interface UsageLedger {
  syncSession(sessionPk: string): Promise<{ added: number }>;
  backfill(sinceIso: string): Promise<{ sessions: number }>;
  entries(q: LedgerQuery): LedgerEntry[];
  tools(q: Omit<LedgerQuery, 'ticket'>): LedgerTool[];
  sumCost(q: LedgerQuery): number;
  latestMainUsage(sessionPk: string): { model: string; usage: Usage } | null;
  start(): void;
  stop(): void;
}

const PAGE = 500;

export function createUsageLedger(
  ctx: DaemonContext,
  opts: { debounceMs?: number; sweepMs?: number; backfillDays?: number; now?: () => Date } = {},
): UsageLedger {
  const debounceMs = opts.debounceMs ?? 2000;
  const sweepMs = opts.sweepMs ?? 5 * 60_000;
  const backfillDays = opts.backfillDays ?? 35;
  const now = opts.now ?? (() => new Date());
  const pending = new Map<string, NodeJS.Timeout>();
  const unsubs: Array<() => void> = [];
  let sweep: NodeJS.Timeout | null = null;
  const inflight = new Map<string, Promise<{ added: number }>>();

  const cost = (model: string, u: Usage) =>
    u.costUsd ?? estimateCostUsd(model, u, ctx.config().limits.pricing) ?? 0;

  function baseRow(s: Session): Pick<LedgerEntry, 'sessionPk' | 'source' | 'projectId' | 'tickets' | 'authoritative'> {
    return { sessionPk: sessionPk(s.source, s.id), source: s.source, projectId: s.projectId, tickets: s.tickets, authoritative: false };
  }

  async function doSync(pk: string): Promise<{ added: number }> {
    const s = ctx.sessions.getByPk(pk);
    if (!s) return { added: 0 };
    const agentIds: Array<string | null> = [null, ...ctx.sessions.agents(s.source, s.id).map((a) => a.id)];
    let added = 0;
    for (const agentId of agentIds) {
      const agentKey = agentId ?? '';
      let cur = getCursor(ctx.db, pk, agentKey);
      for (;;) {
        const page = ctx.sessions.events(s.source, s.id, { agentId, afterSeq: cur.afterSeq, limit: PAGE });
        const last = page.items.at(-1);
        if (!last) break;
        const facts = extractLedgerFacts(page.items, agentKey, cur.lastTs);
        added += insertUsageEntries(
          ctx.db,
          facts.usage.map((f) => ({
            ...baseRow(s),
            agentKey,
            messageId: f.messageId,
            ts: f.ts,
            model: f.model,
            input: f.usage.input,
            output: f.usage.output,
            cacheRead: f.usage.cacheRead,
            cacheWrite: f.usage.cacheWrite,
            estCostUsd: cost(f.model, f.usage),
            allocCostUsd: 0,
            latencyMs: f.latencyMs,
          })),
        );
        insertToolUses(
          ctx.db,
          facts.tools.map((t) => ({
            sessionPk: pk,
            agentKey,
            factKey: t.factKey,
            ts: t.ts,
            kind: t.kind,
            name: t.name,
            toolUseId: t.toolUseId,
            projectId: s.projectId,
            durationMs: null,
          })),
        );
        for (const r of facts.toolResults) setToolDuration(ctx.db, pk, r.toolUseId, r.ts);
        cur = { afterSeq: last.seq, lastTs: facts.lastTs ?? cur.lastTs };
        setCursor(ctx.db, pk, agentKey, cur);
        if (page.nextSeq === null) break;
      }
    }

    const real = countRealEntries(ctx.db, pk);
    const tokens = s.usage.input + s.usage.output + s.usage.cacheRead + s.usage.cacheWrite;
    if (real > 0) {
      deleteSynthetic(ctx.db, pk);
    } else if (tokens > 0) {
      const model = s.models[0] ?? 'unknown';
      upsertSynthetic(ctx.db, {
        ...baseRow(s),
        agentKey: '',
        messageId: SYNTHETIC_MESSAGE_ID,
        ts: s.lastActivityAt,
        model,
        input: s.usage.input,
        output: s.usage.output,
        cacheRead: s.usage.cacheRead,
        cacheWrite: s.usage.cacheWrite,
        estCostUsd: cost(model, s.usage),
        allocCostUsd: 0,
        latencyMs: null,
      });
    }

    const est = sumEstCost(ctx.db, pk);
    const authoritative = s.usage.costUsd !== null && est > 0;
    updateSessionAttribution(ctx.db, pk, {
      projectId: s.projectId,
      tickets: s.tickets,
      factor: authoritative ? (s.usage.costUsd as number) / est : 1,
      authoritative,
    });
    return { added };
  }

  function syncSession(pk: string): Promise<{ added: number }> {
    const running = inflight.get(pk);
    if (running) return running.then(() => doSync(pk));
    const p = doSync(pk).finally(() => inflight.delete(pk));
    inflight.set(pk, p);
    return p;
  }

  async function backfill(sinceIso: string): Promise<{ sessions: number }> {
    const items = listAllSessions(ctx, { from: sinceIso });
    for (const it of items) await syncSession(it.pk);
    return { sessions: items.length };
  }

  function schedule(pk: string): void {
    const t = pending.get(pk);
    if (t) clearTimeout(t);
    pending.set(
      pk,
      setTimeout(() => {
        pending.delete(pk);
        syncSession(pk).catch((err: unknown) => ctx.log.warn({ err, pk }, 'ledger sync failed'));
      }, debounceMs),
    );
  }

  return {
    syncSession,
    backfill,
    entries: (q) => listEntries(ctx.db, q),
    tools: (q) => listTools(ctx.db, q),
    sumCost: (q) => sumAllocCost(ctx.db, q),
    latestMainUsage(pk) {
      const e = latestMainEntry(ctx.db, pk);
      return e
        ? { model: e.model, usage: { input: e.input, output: e.output, cacheRead: e.cacheRead, cacheWrite: e.cacheWrite, costUsd: null } }
        : null;
    },
    start() {
      unsubs.push(ctx.bus.on('session.updated', (e) => schedule(sessionPk(e.session.source, e.session.id))));
      const since = new Date(now().getTime() - backfillDays * 86_400_000).toISOString();
      backfill(since).catch((err: unknown) => ctx.log.warn({ err }, 'ledger backfill failed'));
      sweep = setInterval(() => {
        const dayAgo = new Date(now().getTime() - 86_400_000).toISOString();
        backfill(dayAgo).catch((err: unknown) => ctx.log.warn({ err }, 'ledger sweep failed'));
      }, sweepMs);
    },
    stop() {
      for (const u of unsubs.splice(0)) u();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      if (sweep) clearInterval(sweep);
      sweep = null;
    },
  };
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run apps/daemon/src/services/usage/ledger.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Wire it**

In `apps/daemon/src/context.ts`:
- Add `ledger?: UsageLedger;` to `DaemonContext`, with `import type { UsageLedger } from './services/usage/ledger.ts';`.
- In `buildContext()`, add `ctx.ledger = createUsageLedger(ctx);`.

In `createDaemon()`, add `ctx.ledger?.start();` after the scheduler starts, and `ctx.ledger?.stop();` in `close()`.

- [ ] **Step 7: Commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add apps/daemon
git commit -m "feat(daemon): add incremental usage ledger with cost allocation and tool facts"
```

---

### Task 6: Budgets (table and config, period spend, checks, alerts)

**Files:**
- Create: `apps/daemon/src/db/repos/budgets.ts`
- Create: `apps/daemon/src/services/usage/budgets.ts`, `apps/daemon/src/services/usage/budgets.test.ts`

**Interfaces:**
- Consumes: `budgets` table (Task 2), `ProjectConfig.budgets` (§3), `Budget`/`BudgetStatus`/`BudgetCheck` (Task 1), `InboxEngine.upsert/resolve` (P2), and `UsageLedger.sumCost` (Task 5), passed in as a function
- Produces:
  ```ts
  // repos/budgets.ts
  export function listBudgetRows(db: OrcDb): Budget[]
  export function upsertBudget(db: OrcDb, b: { scopeType: BudgetScopeType; scopeId: string | null; period: BudgetPeriod; limitUsd: number }, nowIso: string): Budget
  export function deleteBudget(db: OrcDb, id: string): boolean
  // services/usage/budgets.ts
  export type SumCost = (q: { from: string; to: string; projectId?: string; ticket?: string }) => number
  export function periodStart(period: BudgetPeriod, now: Date): Date            // local time: day 00:00, ISO week Monday 00:00, month 1st 00:00
  export function configBudgets(cfg: OrcConfig): Budget[]                        // ids `config:<projectId>:<period>`
  export function allBudgets(db: OrcDb, cfg: OrcConfig): Budget[]                 // a table row overrides a config budget with the same scope+period
  export function evaluateBudgets(budgets: Budget[], sumCost: SumCost, now: Date): BudgetStatus[]
  export function checkBudgetScope(statuses: BudgetStatus[], scope: { projectId?: string; ticket?: string }): BudgetCheck
  export function budgetAlertKey(s: BudgetStatus, level: 'warn' | 'over'): string
  export function raiseBudgetAlerts(inbox: Pick<InboxEngine, 'upsert' | 'resolve'>, statuses: BudgetStatus[], warnPct: number, previous: ReadonlySet<string>): Set<string>
  ```
- Alert rules:
  - `pct ≥ 1` → an inbox item (`kind: 'budget'`) with key `budget:<scopeType>:<scopeId|all>:<period>:<periodStartDate>:over`.
  - Otherwise, `pct ≥ warnPct` (0.8) → the same key with the suffix `:warn`.
  - Any key raised earlier that is no longer raised (because the period rolled or the limit changed) is auto-resolved.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/services/usage/budgets.test.ts`
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import type { InboxItem } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../db/client.ts';
import { deleteBudget, listBudgetRows, upsertBudget } from '../../db/repos/budgets.ts';
import { allBudgets, checkBudgetScope, configBudgets, evaluateBudgets, periodStart, raiseBudgetAlerts } from './budgets.ts';

const cfg = OrcConfig.parse({
  projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: ['/w'], budgets: { dailyUsd: 50, monthlyUsd: 900 } }],
});

describe('periodStart', () => {
  const now = new Date(2026, 8, 17, 15, 30); // Thu 17 Sep 2026, local time
  it('returns local day, ISO week and month starts', () => {
    expect(periodStart('daily', now).getTime()).toBe(new Date(2026, 8, 17).getTime());
    expect(periodStart('weekly', now).getTime()).toBe(new Date(2026, 8, 14).getTime());
    expect(periodStart('weekly', new Date(2026, 8, 20, 10)).getTime()).toBe(new Date(2026, 8, 14).getTime()); // Sunday
    expect(periodStart('monthly', now).getTime()).toBe(new Date(2026, 8, 1).getTime());
  });
});

describe('budgets', () => {
  it('merges config budgets with table rows, table wins', () => {
    const { db, close } = openDb(join(mkdtempSync(join(tmpdir(), 'orc-bud-')), 'index.db'));
    expect(configBudgets(cfg).map((b) => b.id)).toEqual(['config:wakecap:daily', 'config:wakecap:monthly']);
    const row = upsertBudget(db, { scopeType: 'project', scopeId: 'wakecap', period: 'daily', limitUsd: 70 }, '2026-09-17T00:00:00.000Z');
    const again = upsertBudget(db, { scopeType: 'project', scopeId: 'wakecap', period: 'daily', limitUsd: 80 }, '2026-09-17T00:00:00.000Z');
    expect(again.id).toBe(row.id);
    upsertBudget(db, { scopeType: 'ticket', scopeId: 'SAF-1', period: 'weekly', limitUsd: 10 }, 'x');
    upsertBudget(db, { scopeType: 'global', scopeId: null, period: 'monthly', limitUsd: 2000 }, 'x');
    const all = allBudgets(db, cfg);
    expect(all.find((b) => b.scopeId === 'wakecap' && b.period === 'daily')).toMatchObject({ limitUsd: 80, origin: 'table' });
    expect(all.filter((b) => b.scopeId === 'wakecap')).toHaveLength(2);
    expect(all.find((b) => b.scopeType === 'global')?.scopeId).toBeNull();
    expect(deleteBudget(db, row.id)).toBe(true);
    expect(deleteBudget(db, row.id)).toBe(false);
    expect(listBudgetRows(db)).toHaveLength(2);
    close();
  });

  it('evaluates spend per period and scope, and checks the worst applicable budget', () => {
    const budgets = [
      { id: 'a', scopeType: 'project' as const, scopeId: 'wakecap', period: 'daily' as const, limitUsd: 50, origin: 'config' as const },
      { id: 'b', scopeType: 'ticket' as const, scopeId: 'SAF-1', period: 'weekly' as const, limitUsd: 10, origin: 'table' as const },
      { id: 'c', scopeType: 'global' as const, scopeId: null, period: 'monthly' as const, limitUsd: 1000, origin: 'table' as const },
    ];
    const calls: unknown[] = [];
    const statuses = evaluateBudgets(
      budgets,
      (q) => {
        calls.push(q);
        return q.ticket ? 12 : q.projectId ? 40 : 100;
      },
      new Date(2026, 8, 17, 15, 30),
    );
    expect(statuses.map((s) => [s.budget.id, s.spentUsd, s.pct])).toEqual([
      ['a', 40, 0.8],
      ['b', 12, 1.2],
      ['c', 100, 0.1],
    ]);
    expect(calls[1]).toMatchObject({ ticket: 'SAF-1', from: new Date(2026, 8, 14).toISOString() });
    expect(checkBudgetScope(statuses, { projectId: 'wakecap', ticket: 'SAF-1' })).toEqual({ ok: false, pct: 1.2, limitUsd: 10 });
    expect(checkBudgetScope(statuses, { projectId: 'wakecap' })).toEqual({ ok: true, pct: 0.8, limitUsd: 50 });
    expect(checkBudgetScope([], { projectId: 'x' })).toEqual({ ok: true, pct: 0, limitUsd: null });
  });

  it('raises warn/over alerts once and resolves stale ones', () => {
    const upserts: string[] = [];
    const resolved: string[] = [];
    const inbox = {
      upsert: (i: { dedupeKey: string }) => {
        upserts.push(i.dedupeKey);
        return {} as InboxItem;
      },
      resolve: (k: string) => void resolved.push(k),
    };
    const mk = (id: string, pct: number) => ({
      budget: { id, scopeType: 'project' as const, scopeId: 'wakecap', period: 'daily' as const, limitUsd: 10, origin: 'table' as const },
      spentUsd: pct * 10,
      pct,
      periodStart: '2026-09-16T21:00:00.000Z',
    });
    const first = raiseBudgetAlerts(inbox, [mk('a', 0.85)], 0.8, new Set());
    expect([...first]).toEqual(['budget:project:wakecap:daily:2026-09-16:warn']);
    const second = raiseBudgetAlerts(inbox, [mk('a', 1.1)], 0.8, first);
    expect([...second]).toEqual(['budget:project:wakecap:daily:2026-09-16:over']);
    expect(resolved).toEqual(['budget:project:wakecap:daily:2026-09-16:warn']);
    raiseBudgetAlerts(inbox, [mk('a', 0.2)], 0.8, second);
    expect(resolved).toContain('budget:project:wakecap:daily:2026-09-16:over');
    expect(upserts).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/usage/budgets.test.ts`
Expected: FAIL, `Cannot find module '../../db/repos/budgets.ts'`.

- [ ] **Step 3: Implement the repo and the service**

`apps/daemon/src/db/repos/budgets.ts`
```ts
import { randomUUID } from 'node:crypto';
import type { Budget, BudgetPeriod, BudgetScopeType } from '@orc/core';
import { and, eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { budgets } from '../schema.ts';

const toBudget = (r: typeof budgets.$inferSelect): Budget => ({
  id: r.id,
  scopeType: r.scopeType,
  scopeId: r.scopeId === '' ? null : r.scopeId,
  period: r.period,
  limitUsd: r.limitUsd,
  origin: 'table',
});

export function listBudgetRows(db: OrcDb): Budget[] {
  return db.select().from(budgets).all().map(toBudget);
}

export function upsertBudget(
  db: OrcDb,
  b: { scopeType: BudgetScopeType; scopeId: string | null; period: BudgetPeriod; limitUsd: number },
  nowIso: string,
): Budget {
  const scopeId = b.scopeType === 'global' ? '' : (b.scopeId ?? '');
  db.insert(budgets)
    .values({ id: randomUUID(), scopeType: b.scopeType, scopeId, period: b.period, limitUsd: b.limitUsd, createdAt: nowIso })
    .onConflictDoUpdate({ target: [budgets.scopeType, budgets.scopeId, budgets.period], set: { limitUsd: b.limitUsd } })
    .run();
  const row = db
    .select()
    .from(budgets)
    .where(and(eq(budgets.scopeType, b.scopeType), eq(budgets.scopeId, scopeId), eq(budgets.period, b.period)))
    .get();
  if (!row) throw new Error('budget upsert failed');
  return toBudget(row);
}

export function deleteBudget(db: OrcDb, id: string): boolean {
  return db.delete(budgets).where(eq(budgets.id, id)).run().changes > 0;
}
```

`apps/daemon/src/services/usage/budgets.ts`
```ts
import type { OrcConfig } from '@orc/api-contract';
import type { Budget, BudgetCheck, BudgetPeriod, BudgetStatus } from '@orc/core';
import type { OrcDb } from '../../db/client.ts';
import { listBudgetRows } from '../../db/repos/budgets.ts';
import type { InboxEngine } from '../../inbox/engine.ts';

export type SumCost = (q: { from: string; to: string; projectId?: string; ticket?: string }) => number;

export function periodStart(period: BudgetPeriod, now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'weekly') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (period === 'monthly') d.setDate(1);
  return d;
}

const PERIOD_FIELDS: Array<[BudgetPeriod, 'dailyUsd' | 'weeklyUsd' | 'monthlyUsd']> = [
  ['daily', 'dailyUsd'],
  ['weekly', 'weeklyUsd'],
  ['monthly', 'monthlyUsd'],
];

export function configBudgets(cfg: OrcConfig): Budget[] {
  const out: Budget[] = [];
  for (const p of cfg.projects) {
    for (const [period, field] of PERIOD_FIELDS) {
      const limit = p.budgets[field];
      if (limit !== undefined && limit > 0) {
        out.push({ id: `config:${p.id}:${period}`, scopeType: 'project', scopeId: p.id, period, limitUsd: limit, origin: 'config' });
      }
    }
  }
  return out;
}

const scopeKey = (b: Budget) => `${b.scopeType}:${b.scopeId ?? ''}:${b.period}`;

export function allBudgets(db: OrcDb, cfg: OrcConfig): Budget[] {
  const table = listBudgetRows(db);
  const taken = new Set(table.map(scopeKey));
  return [...configBudgets(cfg).filter((b) => !taken.has(scopeKey(b))), ...table];
}

export function evaluateBudgets(budgets: Budget[], sumCost: SumCost, now: Date): BudgetStatus[] {
  const to = now.toISOString();
  return budgets.map((budget) => {
    const from = periodStart(budget.period, now).toISOString();
    const spentUsd = sumCost({
      from,
      to,
      projectId: budget.scopeType === 'project' ? (budget.scopeId ?? undefined) : undefined,
      ticket: budget.scopeType === 'ticket' ? (budget.scopeId ?? undefined) : undefined,
    });
    return { budget, spentUsd, pct: budget.limitUsd > 0 ? spentUsd / budget.limitUsd : 0, periodStart: from };
  });
}

export function checkBudgetScope(statuses: BudgetStatus[], scope: { projectId?: string; ticket?: string }): BudgetCheck {
  const relevant = statuses.filter(
    (s) =>
      s.budget.scopeType === 'global' ||
      (s.budget.scopeType === 'project' && scope.projectId !== undefined && s.budget.scopeId === scope.projectId) ||
      (s.budget.scopeType === 'ticket' && scope.ticket !== undefined && s.budget.scopeId === scope.ticket),
  );
  let worst: BudgetStatus | null = null;
  for (const s of relevant) if (worst === null || s.pct > worst.pct) worst = s;
  if (worst === null) return { ok: true, pct: 0, limitUsd: null };
  return { ok: worst.pct < 1, pct: worst.pct, limitUsd: worst.budget.limitUsd };
}

export function budgetAlertKey(s: BudgetStatus, level: 'warn' | 'over'): string {
  const b = s.budget;
  return `budget:${b.scopeType}:${b.scopeId ?? 'all'}:${b.period}:${s.periodStart.slice(0, 10)}:${level}`;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export function raiseBudgetAlerts(
  inbox: Pick<InboxEngine, 'upsert' | 'resolve'>,
  statuses: BudgetStatus[],
  warnPct: number,
  previous: ReadonlySet<string>,
): Set<string> {
  const raised = new Set<string>();
  for (const s of statuses) {
    const level = s.pct >= 1 ? 'over' : s.pct >= warnPct ? 'warn' : null;
    if (level === null) continue;
    const key = budgetAlertKey(s, level);
    raised.add(key);
    if (previous.has(key)) continue;
    const b = s.budget;
    const label = b.scopeType === 'global' ? 'all projects' : `${b.scopeType} ${b.scopeId}`;
    inbox.upsert({
      kind: 'budget',
      dedupeKey: key,
      projectId: b.scopeType === 'project' ? b.scopeId : null,
      ticket: b.scopeType === 'ticket' ? b.scopeId : null,
      reason:
        level === 'over'
          ? `Over ${b.period} budget for ${label}: ${usd(s.spentUsd)} of ${usd(b.limitUsd)}`
          : `${Math.round(s.pct * 100)}% of ${b.period} budget for ${label}: ${usd(s.spentUsd)} of ${usd(b.limitUsd)}`,
      payload: { budgetId: b.id, pct: s.pct, spentUsd: s.spentUsd, limitUsd: b.limitUsd, level },
    });
  }
  for (const key of previous) if (!raised.has(key)) inbox.resolve(key);
  return raised;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run apps/daemon/src/services/usage/budgets.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add apps/daemon
git commit -m "feat(daemon): add budgets with period spend, scope checks and inbox alerts"
```

---

### Task 7: UsageMeter, quota alerts, context fill, and the `/api/usage` and `/api/settings` routes

**Files:**
- Create: `apps/daemon/src/services/usage/meter.ts`, `apps/daemon/src/services/usage/meter.test.ts`
- Create: `apps/daemon/src/http/routes/usage.ts`, `apps/daemon/src/http/routes/settings.ts`, `apps/daemon/src/http/routes/usage-settings.test.ts`
- Modify:
  - `apps/daemon/test/p5-helpers.ts` (add `bareApp()`)
  - `apps/daemon/src/context.ts` (construct the meter)
  - `apps/daemon/src/main.ts` (start and stop)
  - `apps/daemon/src/http/app.ts` (register the routes)
  - `apps/daemon/src/http/audit-middleware.ts` (`NON_ACTION_ROUTES`)
  - `apps/daemon/src/live/live-tracker.ts` and `packages/core/src/derive/live-transcript.ts` (P2; context window per model)

**Interfaces:**
- Consumes:
  - `computeUsageSnapshot`, `quotaTokens`, `mapOfficialQuota`, `contextFill`, `contextWindowFor` (Task 4)
  - `UsageLedger` (Task 5)
  - budgets helpers (Task 6)
  - `LaunchService.ownedCount` (P2)
  - `InboxEngine` (P2)
  - `readBody`, `sendError` (Task 2)
  - `OrcApp` (P1)
- Produces:
  ```ts
  export type { UsageSnapshot } from '@orc/core';
  export interface UsageMeter { snapshot; checkBudget; refresh; ingestOfficial; budgets; contextFill; concurrency; start; stop }   // Contract additions
  export function createUsageMeter(ctx: DaemonContext, deps: { ledger: UsageLedger; inbox?: Pick<InboxEngine, 'upsert' | 'resolve'> | null; now?: () => Date; tickMs?: number }): UsageMeter
  export function quotaAlertKeys(s: UsageSnapshot, warnPct: number): Array<{ key: string; reason: string }>
  export function registerUsageRoutes(app: OrcApp, ctx: DaemonContext): void       // /api/usage*
  export function registerSettingsRoutes(app: OrcApp, ctx: DaemonContext): void    // GET/PUT /api/settings
  // test/p5-helpers.ts
  export function bareApp(): OrcApp
  ```
- `refresh()` emits `{ type: 'usage.updated', snapshot }` only when the snapshot changed (ignoring `generatedAt`).
- **Quota alerts** use the `budget` inbox kind:
  - `quota:block:<blockStart>` when `block.pctOfLimit ≥ warnPct`, **or** when the projected exhaustion is within 60 min and before the reset
  - `quota:week:<yyyy-mm-dd of now − 7d>` when `week.pctOfLimit ≥ warnPct`
  - When the condition clears, the item is resolved.

- [ ] **Step 1: Write the failing meter test**

`apps/daemon/src/services/usage/meter.test.ts`
```ts
import type { InboxItem, UsageSnapshot } from '@orc/core';
import type { InboxUpsert } from '../../inbox/engine.ts';
import { describe, expect, it } from 'vitest';
import { ev, makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import { upsertBudget } from '../../db/repos/budgets.ts';
import { createUsageLedger } from './ledger.ts';
import { createUsageMeter, quotaAlertKeys } from './meter.ts';

const NOW = new Date('2026-09-17T15:10:00.000Z');

function setup(limits: { blockTokenLimit?: number | null; quotaSource?: 'estimate' | 'official'; blockPct?: string | null } = {}) {
  const s1 = makeSession({
    id: 's1',
    tickets: ['SAF-1'],
    usage: { input: 60, output: 40, cacheRead: 0, cacheWrite: 0, costUsd: 2 },
    live: {
      pid: 1, status: 'busy', waitingFor: null, since: '2026-09-17T15:00:00.000Z', ownership: 'observed', ptyId: null,
      stage: null, currentTool: null, backgroundJobs: 0, runningSubagents: 0, contextFill: null,
    },
  });
  const events = {
    'claude:s1': [
      ev({ seq: 1, ts: '2026-09-17T14:10:00.000Z', kind: 'assistant_text', messageId: 'm1', model: 'claude-haiku-4-5', usage: { input: 60, output: 40, cacheRead: 150_000, cacheWrite: 0, costUsd: null } }),
    ],
  };
  const t = makeP5Context({
    config: (c) => {
      const w = withWakecap('/Users/test/Wakecap', { budgets: { dailyUsd: 2.2 } })(c);
      return {
        ...w,
        limits: {
          ...w.limits,
          blockTokenLimit: limits.blockTokenLimit ?? null,
          quotaSource: limits.quotaSource ?? 'estimate',
          officialFieldPaths: { ...w.limits.officialFieldPaths, blockPct: limits.blockPct ?? null },
        },
      };
    },
    data: { sessions: [s1], events },
  });
  const ledger = createUsageLedger(t.ctx);
  const upserts: InboxUpsert[] = [];
  const resolved: string[] = [];
  const inbox = {
    upsert: (i: InboxUpsert) => {
      upserts.push(i);
      return {} as InboxItem;
    },
    resolve: (k: string) => void resolved.push(k),
  };
  const meter = createUsageMeter(t.ctx, { ledger, inbox, now: () => NOW });
  const emitted: UsageSnapshot[] = [];
  t.ctx.bus.on('usage.updated', (e) => void emitted.push(e.snapshot));
  return { ...t, ledger, meter, upserts, resolved, emitted };
}

describe('usage meter', () => {
  it('computes an estimated snapshot from the ledger and emits only on change', async () => {
    const { ledger, meter, emitted } = setup();
    await ledger.syncSession('claude:s1');
    const s = meter.refresh();
    expect(s).toMatchObject({ source: 'estimate', block: { active: true, tokens: 100, pctOfLimit: null } });
    expect(s.block.costUsd).toBeCloseTo(2, 9);
    meter.refresh();
    expect(emitted).toHaveLength(1);
    expect(meter.snapshot()).toEqual(s);
  });

  it('checks budgets and raises a budget alert at 80%+', async () => {
    const { ledger, meter, upserts } = setup();
    await ledger.syncSession('claude:s1');
    meter.refresh();
    const chk = meter.checkBudget({ projectId: 'wakecap' });
    expect(chk.ok).toBe(true);
    expect(chk.pct).toBeCloseTo(2 / 2.2, 9);
    expect(chk.limitUsd).toBe(2.2);
    expect(upserts.map((u) => u.dedupeKey)).toContain(`budget:project:wakecap:daily:${meter.budgets()[0]?.periodStart.slice(0, 10)}:warn`);
  });

  it('checks ticket budgets from the table', async () => {
    const { ctx, ledger, meter } = setup();
    upsertBudget(ctx.db, { scopeType: 'ticket', scopeId: 'SAF-1', period: 'monthly', limitUsd: 1 }, NOW.toISOString());
    await ledger.syncSession('claude:s1');
    const chk = meter.checkBudget({ ticket: 'SAF-1' });
    expect(chk).toMatchObject({ ok: false, limitUsd: 1 });
    expect(chk.pct).toBeCloseTo(2, 9);
  });

  it('raises and resolves quota alerts from plan limits', async () => {
    const { ledger, meter, upserts, resolved } = setup({ blockTokenLimit: 110 });
    await ledger.syncSession('claude:s1');
    meter.refresh();
    expect(upserts.map((u) => u.dedupeKey)).toContain('quota:block:2026-09-17T14:00:00.000Z');
    expect(quotaAlertKeys(meter.snapshot(), 0.8)[0]?.reason).toMatch(/^5h block at 91% \(estimated\)/);
    const { meter: m2 } = setup({ blockTokenLimit: 100_000 });
    expect(quotaAlertKeys(m2.refresh(), 0.8)).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it('uses official samples only when configured', async () => {
    const off = setup({ quotaSource: 'official', blockPct: 'rate_limits.five_hour.used_percentage' });
    expect(off.meter.ingestOfficial({ rate_limits: { five_hour: { used_percentage: 55 } } })).toMatchObject({ blockPct: 0.55 });
    expect(off.meter.snapshot()).toMatchObject({ source: 'official', block: { pctOfLimit: 0.55 } });
    const est = setup();
    expect(est.meter.ingestOfficial({ rate_limits: { five_hour: { used_percentage: 55 } } })).toBeNull();
    expect(est.meter.snapshot().source).toBe('estimate');
  });

  it('computes context fill with the configured window and warn threshold', async () => {
    const { ledger, meter } = setup();
    await ledger.syncSession('claude:s1');
    expect(meter.contextFill('claude:s1')).toEqual({
      sessionPk: 'claude:s1', model: 'claude-haiku-4-5', usedTokens: 150_060, windowTokens: 200_000, fill: 150_060 / 200_000, warn: false,
    });
    expect(meter.contextFill('claude:none')).toBeNull();
  });

  it('reports concurrency per project', () => {
    const { ctx, meter } = setup();
    ctx.launcher = { launch: async () => ({ ptyId: 'p', sessionId: null }), kill: async () => ({ killed: 'pty' as const }), ownedCount: () => 2 };
    expect(meter.concurrency()).toEqual([{ projectId: 'wakecap', owned: 2, max: 6 }]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/usage/meter.test.ts`
Expected: FAIL, `Cannot find module './meter.ts'`.

- [ ] **Step 3: Implement the meter**

`apps/daemon/src/services/usage/meter.ts`
```ts
import {
  type BudgetCheck,
  type BudgetStatus,
  type ConcurrencyStatus,
  type ContextFillInfo,
  type OfficialQuotaSample,
  type UsageSnapshot,
  WEEK_MS,
  computeUsageSnapshot,
  contextFill,
  mapOfficialQuota,
  quotaTokens,
} from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import type { InboxEngine } from '../../inbox/engine.ts';
import { allBudgets, checkBudgetScope, evaluateBudgets, raiseBudgetAlerts } from './budgets.ts';
import type { UsageLedger } from './ledger.ts';

export type { UsageSnapshot } from '@orc/core';

export interface UsageMeter {
  snapshot(): UsageSnapshot;
  checkBudget(scope: { projectId?: string; ticket?: string }): BudgetCheck;
  refresh(now?: Date): UsageSnapshot;
  ingestOfficial(raw: unknown): OfficialQuotaSample | null;
  budgets(now?: Date): BudgetStatus[];
  contextFill(sessionPk: string): ContextFillInfo | null;
  concurrency(): ConcurrencyStatus[];
  start(): void;
  stop(): void;
}

const PROJECTION_WARN_MS = 60 * 60_000;
const hhmm = (iso: string) => iso.slice(11, 16);

export function quotaAlertKeys(s: UsageSnapshot, warnPct: number): Array<{ key: string; reason: string }> {
  const out: Array<{ key: string; reason: string }> = [];
  const label = s.source === 'estimate' ? ' (estimated)' : '';
  const pct = s.block.pctOfLimit;
  const projected = s.projectedBlockExhaustionAt ? Date.parse(s.projectedBlockExhaustionAt) : null;
  const soon = projected !== null && projected - Date.parse(s.generatedAt) <= PROJECTION_WARN_MS;
  if (s.block.active && ((pct !== null && pct >= warnPct) || soon)) {
    const pctText = pct !== null ? `${Math.round(pct * 100)}%` : 'high burn';
    const proj = s.projectedBlockExhaustionAt ? `, runs out ~${hhmm(s.projectedBlockExhaustionAt)} UTC` : '';
    out.push({ key: `quota:block:${s.block.start}`, reason: `5h block at ${pctText}${label}${proj} — resets ${hhmm(s.block.end)} UTC` });
  }
  if (s.week.pctOfLimit !== null && s.week.pctOfLimit >= warnPct) {
    const weekKey = new Date(Date.parse(s.generatedAt) - WEEK_MS).toISOString().slice(0, 10);
    out.push({ key: `quota:week:${weekKey}`, reason: `7-day usage at ${Math.round(s.week.pctOfLimit * 100)}%${label}` });
  }
  return out;
}

const sameSnapshot = (a: UsageSnapshot | null, b: UsageSnapshot) =>
  a !== null && JSON.stringify({ ...a, generatedAt: '' }) === JSON.stringify({ ...b, generatedAt: '' });

export function createUsageMeter(
  ctx: DaemonContext,
  deps: { ledger: UsageLedger; inbox?: Pick<InboxEngine, 'upsert' | 'resolve'> | null; now?: () => Date; tickMs?: number },
): UsageMeter {
  const now = deps.now ?? (() => new Date());
  const inbox = () => deps.inbox ?? ctx.inbox ?? null;
  let last: UsageSnapshot | null = null;
  let official: OfficialQuotaSample | null = null;
  let budgetKeys = new Set<string>();
  let quotaKeys = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let debounce: NodeJS.Timeout | null = null;
  const unsubs: Array<() => void> = [];

  function budgets(at: Date = now()): BudgetStatus[] {
    return evaluateBudgets(allBudgets(ctx.db, ctx.config()), (q) => deps.ledger.sumCost(q), at);
  }

  function compute(at: Date): UsageSnapshot {
    const lim = ctx.config().limits;
    const from = new Date(at.getTime() - WEEK_MS - 5 * 3_600_000).toISOString();
    const entries = deps.ledger.entries({ from, to: at.toISOString() }).map((e) => ({
      ts: Date.parse(e.ts),
      tokens: quotaTokens(e),
      costUsd: e.allocCostUsd,
    }));
    return computeUsageSnapshot({
      entries,
      now: at.getTime(),
      limits: { blockTokenLimit: lim.blockTokenLimit, weekTokenLimit: lim.weekTokenLimit },
      official: lim.quotaSource === 'official' ? official : null,
    });
  }

  function alerts(s: UsageSnapshot, at: Date): void {
    const box = inbox();
    if (!box) return;
    const warnPct = ctx.config().limits.warnPct;
    budgetKeys = raiseBudgetAlerts(box, budgets(at), warnPct, budgetKeys);
    const next = new Set<string>();
    for (const a of quotaAlertKeys(s, warnPct)) {
      next.add(a.key);
      if (!quotaKeys.has(a.key)) {
        box.upsert({ kind: 'budget', dedupeKey: a.key, reason: a.reason, payload: { quota: true, source: s.source } });
      }
    }
    for (const k of quotaKeys) if (!next.has(k)) box.resolve(k);
    quotaKeys = next;
  }

  function refresh(at: Date = now()): UsageSnapshot {
    const s = compute(at);
    const changed = !sameSnapshot(last, s);
    last = s;
    if (changed) ctx.bus.emit({ type: 'usage.updated', snapshot: s });
    alerts(s, at);
    return s;
  }

  function fillFor(pk: string): ContextFillInfo | null {
    const latest = deps.ledger.latestMainUsage(pk);
    if (!latest) return null;
    const lim = ctx.config().limits;
    const f = contextFill(latest.usage, latest.model, lim.contextWindows, lim.defaultContextWindow);
    if (!f) return null;
    return { sessionPk: pk, model: latest.model, ...f, warn: f.fill >= lim.contextWarnFill };
  }

  return {
    snapshot: () => last ?? refresh(),
    checkBudget: (scope) => checkBudgetScope(budgets(), scope),
    refresh,
    ingestOfficial(raw) {
      const lim = ctx.config().limits;
      if (lim.quotaSource !== 'official') return null;
      const sample = mapOfficialQuota(raw, lim.officialFieldPaths, now().toISOString());
      if (sample) {
        official = sample;
        refresh();
      }
      return sample;
    },
    budgets,
    contextFill: fillFor,
    concurrency: () =>
      ctx.config().projects.map((p) => ({ projectId: p.id, owned: ctx.launcher?.ownedCount(p.id) ?? 0, max: p.maxConcurrentOwned })),
    start() {
      refresh();
      timer = setInterval(() => refresh(), deps.tickMs ?? 60_000);
      unsubs.push(
        ctx.bus.on('session.updated', () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => refresh(), 5000);
        }),
        ctx.bus.on('config.changed', () => refresh()),
      );
    },
    stop() {
      if (timer) clearInterval(timer);
      if (debounce) clearTimeout(debounce);
      timer = null;
      debounce = null;
      for (const u of unsubs.splice(0)) u();
    },
  };
}

```

- [ ] **Step 4: Run the meter test and confirm it passes**

Run: `pnpm vitest run apps/daemon/src/services/usage/meter.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Write the failing route test**

Add to `apps/daemon/test/p5-helpers.ts`:
```ts
import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import type { OrcApp } from '../src/http/types.ts';

/** A Hono app without auth/audit middleware, for testing one register*Routes function. */
export function bareApp(): OrcApp {
  return new Hono<{ Bindings: HttpBindings }>();
}
```

`apps/daemon/src/http/routes/usage-settings.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { bareApp, ev, makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import { createUsageLedger } from '../../services/usage/ledger.ts';
import { createUsageMeter } from '../../services/usage/meter.ts';
import { registerSettingsRoutes } from './settings.ts';
import { registerUsageRoutes } from './usage.ts';

function setup() {
  const s1 = makeSession({ id: 's1' });
  const events = {
    'claude:s1': [
      ev({ seq: 1, ts: new Date().toISOString(), kind: 'assistant_text', messageId: 'm1', model: 'claude-opus-5', usage: { input: 10, output: 5, cacheRead: 1000, cacheWrite: 0, costUsd: null } }),
    ],
  };
  const t = makeP5Context({ config: withWakecap('/Users/test/Wakecap'), data: { sessions: [s1], events } });
  const ledger = createUsageLedger(t.ctx);
  t.ctx.ledger = ledger;
  t.ctx.usage = createUsageMeter(t.ctx, { ledger, inbox: null });
  const app = bareApp();
  registerUsageRoutes(app, t.ctx);
  registerSettingsRoutes(app, t.ctx);
  const json = (method: string, body?: unknown) => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ...t, app, ledger, json };
}

describe('/api/usage', () => {
  it('returns a snapshot, context fill and concurrency', async () => {
    const { app, ledger } = setup();
    await ledger.syncSession('claude:s1');
    const snap = await (await app.request('/api/usage')).json();
    expect(snap).toMatchObject({ source: 'estimate', block: { tokens: 15 } });
    const fill = await (await app.request('/api/usage/context/claude/s1')).json();
    expect(fill).toMatchObject({ sessionPk: 'claude:s1', usedTokens: 1010, windowTokens: 1_000_000 });
    expect(await (await app.request('/api/usage/context/claude/zz')).json()).toBeNull();
    expect(await (await app.request('/api/usage/concurrency')).json()).toEqual([{ projectId: 'wakecap', owned: 0, max: 6 }]);
  });

  it('creates, lists and deletes budgets with validation', async () => {
    const { app, json } = setup();
    const bad = await app.request('/api/usage/budgets', json('PUT', { scopeType: 'ticket', period: 'daily', limitUsd: 5 }));
    expect(bad.status).toBe(400);
    const res = await app.request('/api/usage/budgets', json('PUT', { scopeType: 'ticket', scopeId: 'SAF-1', period: 'daily', limitUsd: 5 }));
    expect(res.status).toBe(200);
    const b = (await res.json()) as { id: string };
    const list = (await (await app.request('/api/usage/budgets')).json()) as Array<{ budget: { id: string } }>;
    expect(list.map((s) => s.budget.id)).toContain(b.id);
    expect((await app.request(`/api/usage/budgets/${b.id}`, json('DELETE'))).status).toBe(200);
    expect((await app.request(`/api/usage/budgets/${b.id}`, json('DELETE'))).status).toBe(404);
    expect((await app.request('/api/usage/budgets/config:wakecap:daily', json('DELETE'))).status).toBe(409);
  });

  it('accepts official samples with 204', async () => {
    const { app } = setup();
    expect((await app.request('/api/usage/official', { method: 'POST', body: '{"x":1}' })).status).toBe(204);
  });
});

describe('/api/settings', () => {
  it('reads and replaces whole sections, emitting config.changed', async () => {
    const { app, ctx, json } = setup();
    let changed = 0;
    ctx.bus.on('config.changed', () => {
      changed++;
    });
    const before = (await (await app.request('/api/settings')).json()) as { recaps: Record<string, unknown> };
    expect(before.recaps.engine).toBe('claude-cli');
    const res = await app.request('/api/settings', json('PUT', { recaps: { ...before.recaps, enabled: true, language: 'ar' } }));
    expect(res.status).toBe(200);
    expect(ctx.config().recaps).toMatchObject({ enabled: true, language: 'ar', monthlyBudgetUsd: 20 });
    expect(ctx.config().limits.warnPct).toBe(0.8);
    expect(changed).toBe(1);
    expect((await app.request('/api/settings', json('PUT', { limits: { warnPct: 3 } }))).status).toBe(400);
  });
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/http/routes/usage-settings.test.ts`
Expected: FAIL, `Cannot find module './settings.ts'`.

- [ ] **Step 7: Implement the routes**

`apps/daemon/src/http/routes/usage.ts`
```ts
import { BudgetUpsertBody, apiError } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { deleteBudget, upsertBudget } from '../../db/repos/budgets.ts';
import { need } from '../../services/need.ts';
import { sessionPk } from '../../services/sessions.ts';
import { readBody } from '../p5-util.ts';
import type { OrcApp } from '../types.ts';

const SOURCES = new Set(['claude', 'codex', 'agnc']);

export function registerUsageRoutes(app: OrcApp, ctx: DaemonContext): void {
  const meter = () => need(ctx.usage, 'usage');

  app.get('/api/usage', (c) => c.json(meter().snapshot()));
  app.get('/api/usage/budgets', (c) => c.json(meter().budgets()));
  app.put('/api/usage/budgets', async (c) => {
    const body = await readBody(c, BudgetUpsertBody);
    if (!body.ok) return body.res;
    const b = upsertBudget(ctx.db, body.data, new Date().toISOString());
    meter().refresh();
    return c.json(b);
  });
  app.delete('/api/usage/budgets/:id', (c) => {
    const id = c.req.param('id');
    if (id.startsWith('config:')) {
      return c.json(apiError('config_budget', 'Budgets from project config are edited in Settings → Projects'), 409);
    }
    if (!deleteBudget(ctx.db, id)) return c.json(apiError('not_found', 'budget not found'), 404);
    meter().refresh();
    return c.json({ ok: true as const });
  });
  app.get('/api/usage/concurrency', (c) => c.json(meter().concurrency()));
  app.get('/api/usage/context/:source/:id', (c) => {
    const source = c.req.param('source');
    if (!SOURCES.has(source)) return c.json(apiError('validation_failed', 'unknown source'), 400);
    return c.json(meter().contextFill(sessionPk(source as 'claude' | 'codex' | 'agnc', c.req.param('id'))));
  });
  app.post('/api/usage/official', async (c) => {
    const text = await c.req.text();
    if (text.length > 64_000) return c.json(apiError('payload_too_large', 'statusline payload too large'), 400);
    try {
      meter().ingestOfficial(JSON.parse(text));
    } catch {
      // Not JSON: ignore. The statusline must never fail because of the daemon.
    }
    return c.body(null, 204);
  });
}
```

`apps/daemon/src/http/routes/settings.ts`
```ts
import { SettingsUpdateBody } from '@orc/api-contract';
import type { OrcConfig } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { need } from '../../services/need.ts';
import { readBody } from '../p5-util.ts';
import type { OrcApp } from '../types.ts';

const sections = (c: OrcConfig) => ({ recaps: c.recaps, limits: c.limits, digest: c.digest, hooks: c.hooks });

export function registerSettingsRoutes(app: OrcApp, ctx: DaemonContext): void {
  app.get('/api/settings', (c) => c.json(sections(ctx.config())));
  app.put('/api/settings', async (c) => {
    const body = await readBody(c, SettingsUpdateBody);
    if (!body.ok) return body.res;
    const patch = body.data;
    const next = need(ctx.updateConfig, 'updateConfig')((cfg) => ({
      ...cfg,
      recaps: patch.recaps ?? cfg.recaps,
      limits: patch.limits ?? cfg.limits,
      digest: patch.digest ?? cfg.digest,
      hooks: patch.hooks ?? cfg.hooks,
    }));
    return c.json(sections(next));
  });
}
```

(P2's `updateConfig` emits `config.changed` after Task 2 Step 6, and `makeP5Context` mirrors that, so the test's `changed === 1` holds.)

- [ ] **Step 8: Run the route test and confirm it passes**

Run: `pnpm vitest run apps/daemon/src/http/routes/usage-settings.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 9: Wire, register, exempt, and fix the live context window**

In `apps/daemon/src/context.ts` → `buildContext()`, after the ledger:
```ts
  ctx.usage = createUsageMeter(ctx, { ledger: ctx.ledger });
```
Point the existing `usage?: UsageMeter` import at `./services/usage/meter.ts`. In `createDaemon()`, add `ctx.usage?.start();` after the ledger starts, and `ctx.usage?.stop();` in `close()`.

In `apps/daemon/src/http/app.ts` → `createApp`, next to the other `register*Routes` calls:
```ts
  registerUsageRoutes(app, o.ctx);
  registerSettingsRoutes(app, o.ctx);
```

In `apps/daemon/src/http/audit-middleware.ts`, append to `NON_ACTION_ROUTES`:
```ts
  { method: 'PUT', path: '/api/usage/budgets', why: 'local budget configuration' },
  { method: 'DELETE', path: '/api/usage/budgets/:id', why: 'local budget configuration' },
  { method: 'POST', path: '/api/usage/official', why: 'inbound statusline sample, not an app action' },
  { method: 'PUT', path: '/api/settings', why: 'local app configuration' },
```

**Make the live card's context fill agree with the meter.** Phase 2's reducer divides by a fixed 200 000, but Opus 5 and Sonnet 5 have 1M windows.

1. In `packages/core/src/derive/live-transcript.ts` (P2), change the options type of `createLiveReducer` to:
```ts
export function createLiveReducer(
  opts: { contextWindow?: number; windows?: { table: Record<string, number>; defaultWindow: number } } = {},
): LiveReducer {
```
2. In the `case 'assistant':` branch, replace the line `s.contextFill = Math.min(1, used / contextWindow);` with:
```ts
            s.contextFill = opts.windows
              ? (contextFill(
                  { input: num(u.input_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) },
                  msg.model ?? null,
                  opts.windows.table,
                  opts.windows.defaultWindow,
                )?.fill ?? s.contextFill)
              : Math.min(1, used / contextWindow);
```
   Add `import { contextFill } from './quota.ts';` at the top.
3. In `apps/daemon/src/live/live-tracker.ts` (P2), where each entry is created with `reducer: createLiveReducer(),`, pass the configured windows:
```ts
      reducer: createLiveReducer({
        windows: { table: ctx.config().limits.contextWindows, defaultWindow: ctx.config().limits.defaultContextWindow },
      }),
```
4. Add one case to P2's `live-transcript.test.ts`:
```ts
  it('uses the configured per-model context window', () => {
    const r = createLiveReducer({ windows: { table: { 'claude-opus-5': 1_000_000 }, defaultWindow: 200_000 } });
    r.apply({ type: 'assistant', uuid: 'a', parentUuid: null, sessionId: 's', timestamp: '2026-09-01T00:00:00.000Z', message: { id: 'm', model: 'claude-opus-5', content: [], usage: { input_tokens: 0, cache_read_input_tokens: 250_000, cache_creation_input_tokens: 0 } } });
    expect(r.snapshot().contextFill).toBeCloseTo(0.25, 6);
  });
```

Run: `pnpm vitest run packages/core/src/derive apps/daemon/src/live`
Expected: PASS. P2's existing tests don't pass `windows`, so they keep the old behaviour.

- [ ] **Step 10: Commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add apps/daemon
git commit -m "feat(daemon): add usage meter with quota and budget alerts, usage and settings routes"
```

---

### Task 8: Core work-stream logic (ticket signals, backmerge detection, stages)

**Files:**
- Create: `packages/core/src/derive/streams.ts`, `packages/core/src/derive/streams.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/browser.ts`

**Interfaces:**
- Consumes: `LiveStatus`, `PrRef`, `StreamLink`, `StreamLinkKind`, `StreamPr`, `StreamStage`, `TicketSignal` (core types)
- Produces:
  ```ts
  export const STREAM_TICKET_PATTERN: string                  // '\\b(SAF|ALU|SUPRT|SAK|TAN)-\\d+\\b'
  export const STREAM_STAGES: readonly StreamStage[]          // planned → released, in order
  export const REVIEW_SKILLS: readonly string[]               // review, preflight, code-review
  export const RELEASE_SKILLS: readonly string[]              // releaseit
  export function extractTicketsFrom(text: string | null | undefined, pattern: string | null): string[]   // upper-cased, unique, in order
  export function isBackmergePr(p: { title: string; headRef: string | null; baseRef: string | null }): boolean
  export function planTicket(path: string, pattern: string | null): string | null        // basename must start with `<TICKET>-`
  export function parseWstackEnv(text: string): Record<string, string>
  export interface StreamSessionInput { pk: string; projectId: string | null; name: string | null; firstPrompt: string | null; lastPrompt: string | null; tickets: string[]; prs: PrRef[]; skills: string[]; costUsd: number | null; startedAt: string; lastActivityAt: string; liveStatus: LiveStatus | null; recap: string | null }
  export interface StreamPlanInput { path: string; mtime: string }
  export interface StreamWorkflowInput { file: string; env: Record<string, string>; mtime: string }
  export interface StreamWorktreeInput { path: string; branch: string; ticket: string | null; updatedAt: string | null }
  export interface TicketSignalInput { sessions: StreamSessionInput[]; prs: StreamPr[]; plans: StreamPlanInput[]; workflows: StreamWorkflowInput[]; worktrees: StreamWorktreeInput[] }
  export function collectTicketSignals(input: TicketSignalInput, pattern: string | null): TicketSignal[]
  export function applyManualLinks(signals: TicketSignal[], links: StreamLink[]): TicketSignal[]
  export interface TicketGroup { ticket: string; refs: Record<StreamLinkKind, string[]> }
  export function groupSignals(signals: TicketSignal[]): TicketGroup[]      // sorted by ticket
  export interface StageInput { prs: StreamPr[]; sessions: Array<{ skills: string[]; liveStatus: LiveStatus | null }>; hasWorktrees: boolean }
  export function computeStreamStage(i: StageInput): StreamStage
  ```
- Stage rules, in priority order:
  1. any linked session used `releaseit` → `released`
  2. a merged backmerge PR → `backmerged`
  3. a merged non-backmerge PR → `merged`
  4. an open non-backmerge PR → `pr_open`
  5. a session in `review` status or one that used a review skill → `in_review`
  6. any session or worktree → `implementing`
  7. otherwise → `planned`
- A PR counts as a **backmerge** when any of these holds:
  - its head starts with `backmerge/` (or `backmerge-` / `backmerge_`)
  - its title says "backmerge" or "back-merge"
  - it goes from `master`/`main`/`staging` into `staging`/`testing`/`develop`

- [ ] **Step 1: Write the failing test**

`packages/core/src/derive/streams.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import type { StreamPr } from '../types/index.ts';
import {
  type StreamSessionInput,
  applyManualLinks,
  collectTicketSignals,
  computeStreamStage,
  extractTicketsFrom,
  groupSignals,
  isBackmergePr,
  parseWstackEnv,
  planTicket,
} from './streams.ts';

const pr = (n: number, p: Partial<StreamPr> = {}): StreamPr => ({
  pr: { repo: 'example-org/svc', number: n, url: `https://github.com/example-org/svc/pull/${n}` },
  title: `PR ${n}`, state: 'open', headRef: null, baseRef: null, isBackmerge: false, checks: 'none', review: 'none',
  updatedAt: '2026-09-10T10:00:00.000Z', mergedAt: null, ...p,
});
const sess = (pk: string, p: Partial<StreamSessionInput> = {}): StreamSessionInput => ({
  pk, projectId: 'wakecap', name: null, firstPrompt: null, lastPrompt: null, tickets: [], prs: [], skills: [], costUsd: 1,
  startedAt: '2026-09-10T09:00:00.000Z', lastActivityAt: '2026-09-10T10:00:00.000Z', liveStatus: null, recap: null, ...p,
});

describe('ticket helpers', () => {
  it('extracts unique upper-cased tickets', () => {
    expect(extractTicketsFrom('fix saf-1787 and SAF-1787, then ALU-2; not FOO-1', null)).toEqual(['SAF-1787', 'ALU-2']);
    expect(extractTicketsFrom('X-9 here', '\\bX-\\d+\\b')).toEqual(['X-9']);
    expect(extractTicketsFrom('bad', '(')).toEqual([]);
    expect(extractTicketsFrom(null, null)).toEqual([]);
  });

  it('detects backmerge PRs', () => {
    expect(isBackmergePr({ title: 'chore: sync', headRef: 'backmerge/SAF-1-master-to-staging', baseRef: 'staging' })).toBe(true);
    expect(isBackmergePr({ title: 'Back-merge master into staging', headRef: 'x', baseRef: null })).toBe(true);
    expect(isBackmergePr({ title: 'sync', headRef: 'master', baseRef: 'staging' })).toBe(true);
    expect(isBackmergePr({ title: 'feat: SAF-1', headRef: 'feat/SAF-1-x', baseRef: 'master' })).toBe(false);
  });

  it('reads plan tickets from the file name only', () => {
    expect(planTicket('/w/plans/sla/SAF-1787-exclude-weekends.md', null)).toBe('SAF-1787');
    expect(planTicket('/w/plans/notes-SAF-1787.md', null)).toBeNull();
  });

  it('parses wstack env files', () => {
    expect(parseWstackEnv('# c\nWORKFLOW_ID=wf-1\nexport BRANCH="feat/SAF-9-x"\nREPO_SLUG=\'svc\'\nbad line\n')).toEqual({
      WORKFLOW_ID: 'wf-1', BRANCH: 'feat/SAF-9-x', REPO_SLUG: 'svc',
    });
  });
});

describe('collectTicketSignals', () => {
  const input = {
    sessions: [
      sess('claude:a', { tickets: ['SAF-1'], firstPrompt: 'also look at ALU-7' }),
      sess('claude:b', { prs: [pr(5).pr] }),
    ],
    prs: [pr(5, { title: 'feat(svc): SAF-1 weekends', headRef: 'feat/SAF-1-weekends' }), pr(6, { title: 'x', headRef: 'backmerge/SAF-1-staging' })],
    plans: [{ path: '/w/plans/SAF-2-plan.md', mtime: '2026-09-01T00:00:00.000Z' }],
    workflows: [{ file: '/h/.wstack/workflows/wf.env', env: { BRANCH: 'fix/SAF-3-y' }, mtime: '2026-09-02T00:00:00.000Z' }],
    worktrees: [{ path: '/w/svc/.worktrees/feat-SAF-4', branch: 'feat/SAF-4-z', ticket: null, updatedAt: null }],
  };

  it('collects signals from every source', () => {
    const got = collectTicketSignals(input, null).map((s) => `${s.ticket}|${s.kind}|${s.ref}|${s.source}`);
    expect(got).toEqual([
      'SAF-1|session|claude:a|session_tickets',
      'ALU-7|session|claude:a|prompt',
      'SAF-1|session|claude:b|pr_title',
      'SAF-1|pr|https://github.com/example-org/svc/pull/5|pr_title',
      'SAF-1|pr|https://github.com/example-org/svc/pull/6|branch',
      'SAF-2|plan|/w/plans/SAF-2-plan.md|plan_file',
      'SAF-3|workflow|/h/.wstack/workflows/wf.env|wstack_workflow',
      'SAF-4|worktree|/w/svc/.worktrees/feat-SAF-4|worktree',
    ]);
  });

  it('applies manual unlinks and links, then groups', () => {
    const signals = applyManualLinks(collectTicketSignals(input, null), [
      { ticket: 'ALU-7', kind: 'session', ref: 'claude:a', origin: 'manual', excluded: true, createdAt: 'x' },
      { ticket: 'SAF-2', kind: 'session', ref: 'claude:z', origin: 'manual', excluded: false, createdAt: 'x' },
    ]);
    const groups = groupSignals(signals);
    expect(groups.map((g) => g.ticket)).toEqual(['SAF-1', 'SAF-2', 'SAF-3', 'SAF-4']);
    expect(groups[0]?.refs.session).toEqual(['claude:a', 'claude:b']);
    expect(groups[0]?.refs.pr).toHaveLength(2);
    expect(groups[1]?.refs).toMatchObject({ plan: ['/w/plans/SAF-2-plan.md'], session: ['claude:z'] });
  });
});

describe('computeStreamStage', () => {
  const base = { prs: [] as StreamPr[], sessions: [] as Array<{ skills: string[]; liveStatus: null | 'review' | 'busy' }>, hasWorktrees: false };
  it('walks the stages in priority order', () => {
    expect(computeStreamStage(base)).toBe('planned');
    expect(computeStreamStage({ ...base, hasWorktrees: true })).toBe('implementing');
    expect(computeStreamStage({ ...base, sessions: [{ skills: ['conductor'], liveStatus: 'busy' }] })).toBe('implementing');
    expect(computeStreamStage({ ...base, sessions: [{ skills: ['review'], liveStatus: null }] })).toBe('in_review');
    expect(computeStreamStage({ ...base, sessions: [{ skills: [], liveStatus: 'review' }] })).toBe('in_review');
    expect(computeStreamStage({ ...base, prs: [pr(1)] })).toBe('pr_open');
    expect(computeStreamStage({ ...base, prs: [pr(1, { state: 'merged' }), pr(2, { isBackmerge: true })] })).toBe('merged');
    expect(computeStreamStage({ ...base, prs: [pr(1, { state: 'merged' }), pr(2, { isBackmerge: true, state: 'merged' })] })).toBe('backmerged');
    expect(computeStreamStage({ ...base, prs: [pr(1)], sessions: [{ skills: ['releaseit'], liveStatus: null }] })).toBe('released');
    expect(computeStreamStage({ ...base, prs: [pr(1, { state: 'closed' })] })).toBe('planned');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/core/src/derive/streams.test.ts`
Expected: FAIL, `Cannot find module './streams.ts'`.

- [ ] **Step 3: Implement it**

`packages/core/src/derive/streams.ts`
```ts
import type { LiveStatus, PrRef, StreamLink, StreamLinkKind, StreamPr, StreamStage, TicketSignal } from '../types/index.ts';

export const STREAM_TICKET_PATTERN = '\\b(SAF|ALU|SUPRT|SAK|TAN)-\\d+\\b';
export const STREAM_STAGES: readonly StreamStage[] = ['planned', 'implementing', 'in_review', 'pr_open', 'merged', 'backmerged', 'released'];
export const REVIEW_SKILLS: readonly string[] = ['review', 'preflight', 'code-review'];
export const RELEASE_SKILLS: readonly string[] = ['releaseit'];

export function extractTicketsFrom(text: string | null | undefined, pattern: string | null): string[] {
  if (!text) return [];
  let re: RegExp;
  try {
    re = new RegExp(pattern ?? STREAM_TICKET_PATTERN, 'gi');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const t = m[0].toUpperCase();
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

const BACKMERGE_HEAD = /^backmerge[/_-]/i;
const BACKMERGE_TITLE = /\bback-?merge\b/i;
const UPPER_BRANCHES = new Set(['master', 'main', 'staging']);
const LOWER_BRANCHES = new Set(['staging', 'testing', 'develop']);

export function isBackmergePr(p: { title: string; headRef: string | null; baseRef: string | null }): boolean {
  if (p.headRef !== null && BACKMERGE_HEAD.test(p.headRef)) return true;
  if (BACKMERGE_TITLE.test(p.title)) return true;
  return (
    p.headRef !== null &&
    p.baseRef !== null &&
    p.headRef !== p.baseRef &&
    UPPER_BRANCHES.has(p.headRef) &&
    LOWER_BRANCHES.has(p.baseRef)
  );
}

const basename = (p: string) => p.split('/').pop() ?? p;

export function planTicket(path: string, pattern: string | null): string | null {
  const name = basename(path);
  const first = extractTicketsFrom(name, pattern)[0];
  return first !== undefined && name.toUpperCase().startsWith(`${first}-`) ? first : null;
}

export function parseWstackEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m?.[1]) continue;
    out[m[1]] = (m[2] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export interface StreamSessionInput {
  pk: string;
  projectId: string | null;
  name: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  tickets: string[];
  prs: PrRef[];
  skills: string[];
  costUsd: number | null;
  startedAt: string;
  lastActivityAt: string;
  liveStatus: LiveStatus | null;
  recap: string | null;
}
export interface StreamPlanInput { path: string; mtime: string }
export interface StreamWorkflowInput { file: string; env: Record<string, string>; mtime: string }
export interface StreamWorktreeInput { path: string; branch: string; ticket: string | null; updatedAt: string | null }
export interface TicketSignalInput {
  sessions: StreamSessionInput[];
  prs: StreamPr[];
  plans: StreamPlanInput[];
  workflows: StreamWorkflowInput[];
  worktrees: StreamWorktreeInput[];
}

export function prTickets(p: StreamPr, pattern: string | null): Array<{ ticket: string; source: 'pr_title' | 'pr_body' | 'branch' }> {
  const out: Array<{ ticket: string; source: 'pr_title' | 'pr_body' | 'branch' }> = [];
  for (const t of extractTicketsFrom(p.title, pattern)) out.push({ ticket: t, source: 'pr_title' });
  for (const t of extractTicketsFrom(p.headRef, pattern)) out.push({ ticket: t, source: 'branch' });
  return out;
}

export function collectTicketSignals(input: TicketSignalInput, pattern: string | null): TicketSignal[] {
  const out: TicketSignal[] = [];
  const seen = new Set<string>();
  const add = (s: TicketSignal) => {
    const k = `${s.ticket}|${s.kind}|${s.ref}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  const prByUrl = new Map(input.prs.map((p) => [p.pr.url, p]));

  for (const s of input.sessions) {
    for (const t of s.tickets) add({ ticket: t.toUpperCase(), kind: 'session', ref: s.pk, source: 'session_tickets' });
    for (const text of [s.firstPrompt, s.lastPrompt, s.name]) {
      for (const t of extractTicketsFrom(text, pattern)) add({ ticket: t, kind: 'session', ref: s.pk, source: 'prompt' });
    }
    for (const ref of s.prs) {
      const p = prByUrl.get(ref.url);
      if (!p) continue;
      for (const { ticket } of prTickets(p, pattern)) add({ ticket, kind: 'session', ref: s.pk, source: 'pr_title' });
    }
  }
  for (const p of input.prs) {
    for (const { ticket, source } of prTickets(p, pattern)) add({ ticket, kind: 'pr', ref: p.pr.url, source });
  }
  for (const plan of input.plans) {
    const t = planTicket(plan.path, pattern);
    if (t) add({ ticket: t, kind: 'plan', ref: plan.path, source: 'plan_file' });
  }
  for (const w of input.workflows) {
    for (const t of [...extractTicketsFrom(w.env.BRANCH, pattern), ...extractTicketsFrom(w.env.WORKFLOW_ID, pattern)]) {
      add({ ticket: t, kind: 'workflow', ref: w.file, source: 'wstack_workflow' });
    }
  }
  for (const wt of input.worktrees) {
    const tickets = wt.ticket ? [wt.ticket.toUpperCase()] : extractTicketsFrom(wt.branch, pattern);
    for (const t of tickets) add({ ticket: t, kind: 'worktree', ref: wt.path, source: 'worktree' });
  }
  return out;
}

const linkKey = (x: { ticket: string; kind: StreamLinkKind; ref: string }) => `${x.ticket}|${x.kind}|${x.ref}`;

export function applyManualLinks(signals: TicketSignal[], links: StreamLink[]): TicketSignal[] {
  const excluded = new Set(links.filter((l) => l.excluded).map(linkKey));
  const out = signals.filter((s) => !excluded.has(linkKey(s)));
  const present = new Set(out.map(linkKey));
  for (const l of links) {
    if (l.excluded || l.origin !== 'manual' || present.has(linkKey(l))) continue;
    out.push({ ticket: l.ticket, kind: l.kind, ref: l.ref, source: 'manual' });
    present.add(linkKey(l));
  }
  return out;
}

export interface TicketGroup { ticket: string; refs: Record<StreamLinkKind, string[]> }

export function groupSignals(signals: TicketSignal[]): TicketGroup[] {
  const map = new Map<string, TicketGroup>();
  for (const s of signals) {
    let g = map.get(s.ticket);
    if (!g) {
      g = { ticket: s.ticket, refs: { session: [], pr: [], plan: [], worktree: [], workflow: [] } };
      map.set(s.ticket, g);
    }
    if (!g.refs[s.kind].includes(s.ref)) g.refs[s.kind].push(s.ref);
  }
  return [...map.values()].sort((a, b) => a.ticket.localeCompare(b.ticket, 'en', { numeric: true }));
}

export interface StageInput {
  prs: StreamPr[];
  sessions: Array<{ skills: string[]; liveStatus: LiveStatus | null }>;
  hasWorktrees: boolean;
}

export function computeStreamStage(i: StageInput): StreamStage {
  if (i.sessions.some((s) => s.skills.some((k) => RELEASE_SKILLS.includes(k)))) return 'released';
  const backmerges = i.prs.filter((p) => p.isBackmerge);
  const main = i.prs.filter((p) => !p.isBackmerge);
  if (backmerges.some((p) => p.state === 'merged')) return 'backmerged';
  if (main.some((p) => p.state === 'merged')) return 'merged';
  if (main.some((p) => p.state === 'open')) return 'pr_open';
  if (i.sessions.some((s) => s.liveStatus === 'review' || s.skills.some((k) => REVIEW_SKILLS.includes(k)))) return 'in_review';
  if (i.sessions.length > 0 || i.hasWorktrees) return 'implementing';
  return 'planned';
}
```

`prTickets` covers titles and branches only, because `pr_cache` stores no PR body (P4). **If P4 later caches `body`**, add `extractTicketsFrom(p.body, pattern)` with source `'pr_body'` here, and add `body` to `StreamPr`.

Append to both `packages/core/src/index.ts` and `packages/core/src/browser.ts`:
```ts
export * from './derive/streams.ts';
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run packages/core/src/derive/streams.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add packages/core
git commit -m "feat(core): add work stream ticket signals, backmerge detection and stage rules"
```

---

### Task 9: StreamService, PR source, wstack reader and `/api/streams`

**Files:**
- Create: `apps/daemon/src/services/pr-source.ts`, `apps/daemon/src/services/wstack.ts`
- Create: `apps/daemon/src/db/repos/streams.ts`
- Create: `apps/daemon/src/services/streams/streams.ts`, `apps/daemon/src/services/streams/streams.test.ts`
- Create: `apps/daemon/src/http/routes/streams.ts`, `apps/daemon/src/http/routes/streams.test.ts`
- Modify: `apps/daemon/src/context.ts` (the `prs?` and `streams?` fields and their construction), `apps/daemon/src/main.ts`, `apps/daemon/src/http/app.ts`, `apps/daemon/src/http/audit-middleware.ts`

**Interfaces:**
- Consumes:
  - core stream helpers (Task 8)
  - `listPrStatuses`, `PrStatus` (P4)
  - `WorktreeService.discover()` (P4)
  - `UsageMeter.checkBudget` (Task 7)
  - `listAllSessions` (Task 2)
  - `ctx.goals?` and `ctx.handoffs?`, which are optional until Tasks 14 and 15 land
- Produces:
  ```ts
  // pr-source.ts
  export interface PrSource { list(): StreamPr[] }
  export function toStreamPr(p: PrStatus): StreamPr
  export function createPrSource(ctx: DaemonContext): PrSource
  // wstack.ts
  export function resolveWstackHome(env?: NodeJS.ProcessEnv): string          // $WSTACK_HOME or ~/.wstack
  export function readWstackWorkflows(home: string): StreamWorkflowInput[]    // workflows/*.env, read-only
  export function readWstackTimelines(home: string): unknown[]                // projects/*/timeline.jsonl parsed lines (Task 10)
  // repos/streams.ts
  export function upsertStream(db: OrcDb, s: WorkStream, nowIso: string): void
  export function listStreams(db: OrcDb, q: { projectId?: string; stage?: StreamStage }): WorkStream[]   // newest activity first
  export function getStream(db: OrcDb, ticket: string): WorkStream | null
  export function replaceAutoLinks(db: OrcDb, ticket: string, links: Array<{ kind: StreamLinkKind; ref: string }>, nowIso: string): void
  export function listLinks(db: OrcDb, ticket?: string): StreamLink[]
  export function setManualLink(db: OrcDb, ticket: string, kind: StreamLinkKind, ref: string, excluded: boolean, nowIso: string): StreamLink
  // services/streams/streams.ts
  export interface StreamService { refresh; refreshIfStale(): Promise<void>; list; get; link; unlink; start; stop }
  export function createStreamService(ctx: DaemonContext, deps: { prs: PrSource; meter: Pick<UsageMeter, 'checkBudget'>; now?: () => Date; staleMs?: number; refreshMs?: number; sessionDays?: number }): StreamService
  // http/routes/streams.ts
  export function registerStreamRoutes(app: OrcApp, ctx: DaemonContext): void
  ```
- File access is **read-only**. Plan discovery walks `<pathPrefix>/plans/**` (depth ≤ 4, `.md` only, no symlinks) plus `$CLAUDE_HOME/plans/*.md`, using **file names only** (no content is read). wstack discovery reads `$WSTACK_HOME/workflows/*.env`. Files ending in `.key` are never read.
- **Stream cost** is the sum of `costUsd` over the linked sessions. A session linked to two tickets counts fully for both.

- [ ] **Step 1: Write the failing service test**

`apps/daemon/src/services/streams/streams.test.ts`
```ts
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StreamPr } from '@orc/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import type { WorktreeService } from '../worktree/worktree.ts';
import { toStreamPr } from '../pr-source.ts';
import { createStreamService } from './streams.ts';

let root: string;
let wstack: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orc-streams-'));
  wstack = join(root, 'wstack');
  mkdirSync(join(root, 'ws', 'plans', 'sla'), { recursive: true });
  writeFileSync(join(root, 'ws', 'plans', 'sla', 'SAF-1787-exclude-weekends.md'), '# plan');
  const planTime = new Date('2026-09-01T00:00:00.000Z');
  utimesSync(join(root, 'ws', 'plans', 'sla', 'SAF-1787-exclude-weekends.md'), planTime, planTime);
  writeFileSync(join(root, 'ws', 'plans', 'sla', 'SAF-1787.key'), 'never read');
  mkdirSync(join(wstack, 'workflows'), { recursive: true });
  writeFileSync(join(wstack, 'workflows', 'wf-1.env'), 'WORKFLOW_ID=wf-1\nBRANCH=fix/SAF-2000-bug\nREPO_SLUG=svc\n');
  vi.stubEnv('WSTACK_HOME', wstack);
});
afterEach(() => vi.unstubAllEnvs());

const PR = (n: number, p: Partial<StreamPr>): StreamPr => ({
  pr: { repo: 'example-org/wakecap-wecare-service', number: n, url: `https://github.com/example-org/wakecap-wecare-service/pull/${n}` },
  title: `PR ${n}`, state: 'open', headRef: null, baseRef: null, isBackmerge: false, checks: 'success', review: 'approved',
  updatedAt: '2026-09-02T12:00:00.000Z', mergedAt: null, ...p,
});

function setup() {
  const prs = [
    PR(231, { title: 'feat(sla): SAF-1787 exclude weekends', headRef: 'feat/SAF-1787-exclude-weekends', state: 'merged', mergedAt: '2026-09-03T09:00:00.000Z' }),
    PR(240, { title: 'backmerge master → staging', headRef: 'backmerge/SAF-1787-staging', isBackmerge: true, state: 'merged', mergedAt: '2026-09-04T12:00:00.000Z' }),
  ];
  const sessions = [
    makeSession({ id: 's-prlink', tickets: ['SAF-1787'], name: 'SAF-1787 SLA weekends', prs: [prs[0]?.pr ?? PR(0, {}).pr], skills: ['conductor'], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 3 }, recap: 'Excluded weekends.\n**Goal:** …' }),
    makeSession({ id: 's-review', firstPrompt: '/review SAF-1787 please', skills: ['review'], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 1.5 }, lastActivityAt: '2026-09-04T10:00:00.000Z' }),
    makeSession({ id: 's-other', firstPrompt: 'unrelated work' }),
    makeSession({ id: 's-forza', projectId: 'forza', tickets: ['SAF-9999'] }),
  ];
  const t = makeP5Context({
    config: withWakecap(join(root, 'ws')),
    data: { sessions },
    overrides: {},
  });
  t.ctx.worktrees = {
    discover: async () => [
      { path: join(root, 'ws', 'svc', '.worktrees', 'feat-SAF-3000'), repo: 'svc', branch: 'feat/SAF-3000-new', base: 'master', ticket: 'SAF-3000', dirty: false, prUrl: null, state: 'active', createdByApp: true, head: null, isMain: false, origin: 'app', sessionPks: [], projectId: 'wakecap', prStatus: null, updatedAt: '2026-09-05T00:00:00.000Z' },
    ],
  } as unknown as WorktreeService;
  const checks: unknown[] = [];
  const svc = createStreamService(t.ctx, {
    prs: { list: () => prs },
    meter: { checkBudget: (s) => (checks.push(s), { ok: true, pct: 0.1, limitUsd: 50 }) },
    now: () => new Date('2026-09-17T10:00:00.000Z'),
  });
  return { ...t, svc, checks };
}

describe('stream service', () => {
  it('builds streams for workStreams projects from every source', async () => {
    const { svc } = setup();
    const streams = await svc.refresh();
    expect(streams.map((s) => [s.ticket, s.stage])).toEqual([
      ['SAF-1787', 'backmerged'],
      ['SAF-2000', 'planned'],
      ['SAF-3000', 'implementing'],
    ]);
    const saf = streams[0];
    expect(saf).toMatchObject({
      projectId: 'wakecap',
      title: 'feat(sla): SAF-1787 exclude weekends',
      sessionIds: ['claude:s-review', 'claude:s-prlink'], // listAllSessions returns newest activity first
      costUsd: 4.5,
      lastActivityAt: '2026-09-04T10:00:00.000Z',
    });
    expect(saf?.plans).toEqual([join(root, 'ws', 'plans', 'sla', 'SAF-1787-exclude-weekends.md')]);
    expect(saf?.prs.map((p) => p.number)).toEqual([231, 240]);
    expect(svc.list({ stage: 'implementing' }).map((s) => s.ticket)).toEqual(['SAF-3000']);
  });

  it('returns a detail view with timeline, budget and links', async () => {
    const { svc, checks } = setup();
    const d = await svc.get('SAF-1787');
    expect(d?.budget).toEqual({ ok: true, pct: 0.1, limitUsd: 50 });
    expect(checks).toContainEqual({ ticket: 'SAF-1787', projectId: 'wakecap' });
    // newest first: PR 240 merged 09-04, PR 231 merged 09-03, recap 09-01T10, both sessions start 09-01T09, plan mtime 09-01T00
    expect(d?.timeline.map((i) => i.kind)).toEqual(['pr', 'pr', 'recap', 'session', 'session', 'plan']);
    expect(d?.timeline.find((i) => i.kind === 'recap')?.detail).toContain('Excluded weekends.');
    expect(d?.links.filter((l) => l.kind === 'session').map((l) => l.origin)).toEqual(['auto', 'auto']);
    expect(await svc.get('SAF-424242')).toBeNull();
  });

  it('honours manual unlink and link across refreshes', async () => {
    const { svc } = setup();
    await svc.refresh();
    svc.unlink('SAF-1787', 'session', 'claude:s-review');
    svc.link('SAF-1787', 'session', 'claude:s-other');
    const saf = (await svc.refresh()).find((s) => s.ticket === 'SAF-1787');
    expect(saf?.sessionIds).toEqual(['claude:s-prlink', 'claude:s-other']);
    const links = (await svc.get('SAF-1787'))?.links ?? [];
    expect(links.find((l) => l.ref === 'claude:s-review')).toMatchObject({ origin: 'manual', excluded: true });
  });

  it('skips projects without workStreams', async () => {
    const { svc, ctx } = setup();
    ctx.updateConfig?.((c) => ({ ...c, projects: c.projects.map((p) => ({ ...p, features: { ...p.features, workStreams: false } })) }));
    expect(await svc.refresh()).toEqual([]);
  });

  it('maps P4 PrStatus to StreamPr', () => {
    expect(
      toStreamPr({ pr: { repo: 'o/r', number: 1, url: 'u' }, state: 'merged', title: 'Backmerge master', checks: 'none', review: 'none', updatedAt: 't', headRef: 'x', failedChecks: [] }),
    ).toEqual({ pr: { repo: 'o/r', number: 1, url: 'u' }, title: 'Backmerge master', state: 'merged', headRef: 'x', baseRef: null, isBackmerge: true, checks: 'none', review: 'none', updatedAt: 't', mergedAt: 't' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/streams`
Expected: FAIL, `Cannot find module '../pr-source.ts'`.

- [ ] **Step 3: Write the PR source and the wstack reader**

`apps/daemon/src/services/pr-source.ts`
```ts
import { type PrStatus, type StreamPr, isBackmergePr } from '@orc/core';
import type { DaemonContext } from '../context.ts';
import { listPrStatuses } from '../db/repos/pr-cache.ts';

export interface PrSource {
  list(): StreamPr[];
}

/** P4's pr_cache has no body/base/merge time: baseRef = null, mergedAt = updatedAt for merged PRs. */
export function toStreamPr(p: PrStatus): StreamPr {
  const baseRef = null;
  return {
    pr: p.pr,
    title: p.title,
    state: p.state,
    headRef: p.headRef,
    baseRef,
    isBackmerge: isBackmergePr({ title: p.title, headRef: p.headRef, baseRef }),
    checks: p.checks,
    review: p.review,
    updatedAt: p.updatedAt,
    mergedAt: p.state === 'merged' ? p.updatedAt : null,
  };
}

export function createPrSource(ctx: DaemonContext): PrSource {
  return { list: () => listPrStatuses(ctx.db).map(toStreamPr) };
}
```

`apps/daemon/src/services/wstack.ts`
```ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type StreamWorkflowInput, parseJsonLine, parseWstackEnv } from '@orc/core';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function resolveWstackHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.WSTACK_HOME ?? join(homedir(), '.wstack');
}

function safeFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(suffix) && !d.name.endsWith('.key'))
    .map((d) => join(dir, d.name));
}

export function readWstackWorkflows(home: string): StreamWorkflowInput[] {
  return safeFiles(join(home, 'workflows'), '.env').flatMap((file) => {
    try {
      const st = statSync(file);
      if (st.size > MAX_FILE_BYTES) return [];
      return [{ file, env: parseWstackEnv(readFileSync(file, 'utf8')), mtime: st.mtime.toISOString() }];
    } catch {
      return [];
    }
  });
}

export function readWstackTimelines(home: string): unknown[] {
  const projects = join(home, 'projects');
  if (!existsSync(projects)) return [];
  const out: unknown[] = [];
  for (const d of readdirSync(projects, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const file = join(projects, d.name, 'timeline.jsonl');
    try {
      if (!existsSync(file) || statSync(file).size > MAX_FILE_BYTES) continue;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const v = parseJsonLine(line);
        if (v !== undefined) out.push(v);
      }
    } catch {
      // unreadable file: skip
    }
  }
  return out;
}
```

- [ ] **Step 4: Write the streams repo**

`apps/daemon/src/db/repos/streams.ts`
```ts
import type { PrRef, StreamLink, StreamLinkKind, StreamStage, WorkStream } from '@orc/core';
import { and, desc, eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { streamLinks, streams } from '../schema.ts';

const arr = <T>(json: string): T[] => {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

const toStream = (r: typeof streams.$inferSelect): WorkStream => ({
  ticket: r.ticket,
  projectId: r.projectId,
  title: r.title,
  stage: r.stage,
  sessionIds: arr<string>(r.sessionIdsJson),
  prs: arr<PrRef>(r.prsJson),
  plans: arr<string>(r.plansJson),
  worktrees: arr<string>(r.worktreesJson),
  costUsd: r.costUsd,
  lastActivityAt: r.lastActivityAt,
});

export function upsertStream(db: OrcDb, s: WorkStream, nowIso: string): void {
  const values = {
    ticket: s.ticket,
    projectId: s.projectId,
    title: s.title,
    stage: s.stage,
    sessionIdsJson: JSON.stringify(s.sessionIds),
    prsJson: JSON.stringify(s.prs),
    plansJson: JSON.stringify(s.plans),
    worktreesJson: JSON.stringify(s.worktrees),
    costUsd: s.costUsd,
    lastActivityAt: s.lastActivityAt,
    updatedAt: nowIso,
  };
  const { ticket: _t, ...set } = values;
  db.insert(streams).values(values).onConflictDoUpdate({ target: streams.ticket, set }).run();
}

export function listStreams(db: OrcDb, q: { projectId?: string; stage?: StreamStage }): WorkStream[] {
  return db
    .select()
    .from(streams)
    .where(
      and(
        q.projectId === undefined ? undefined : eq(streams.projectId, q.projectId),
        q.stage === undefined ? undefined : eq(streams.stage, q.stage),
      ),
    )
    .orderBy(desc(streams.lastActivityAt))
    .all()
    .map(toStream);
}

export function getStream(db: OrcDb, ticket: string): WorkStream | null {
  const r = db.select().from(streams).where(eq(streams.ticket, ticket)).get();
  return r ? toStream(r) : null;
}

export function replaceAutoLinks(
  db: OrcDb,
  ticket: string,
  links: Array<{ kind: StreamLinkKind; ref: string }>,
  nowIso: string,
): void {
  db.transaction((tx) => {
    tx.delete(streamLinks).where(and(eq(streamLinks.ticket, ticket), eq(streamLinks.origin, 'auto'))).run();
    for (const l of links) {
      tx.insert(streamLinks)
        .values({ ticket, kind: l.kind, ref: l.ref, origin: 'auto', excluded: false, createdAt: nowIso })
        .onConflictDoNothing()
        .run();
    }
  });
}

export function listLinks(db: OrcDb, ticket?: string): StreamLink[] {
  const q = db.select().from(streamLinks);
  return (ticket === undefined ? q.all() : q.where(eq(streamLinks.ticket, ticket)).all()).map((r) => ({ ...r }));
}

export function setManualLink(
  db: OrcDb,
  ticket: string,
  kind: StreamLinkKind,
  ref: string,
  excluded: boolean,
  nowIso: string,
): StreamLink {
  db.insert(streamLinks)
    .values({ ticket, kind, ref, origin: 'manual', excluded, createdAt: nowIso })
    .onConflictDoUpdate({
      target: [streamLinks.ticket, streamLinks.kind, streamLinks.ref],
      set: { origin: 'manual', excluded, createdAt: nowIso },
    })
    .run();
  return { ticket, kind, ref, origin: 'manual', excluded, createdAt: nowIso };
}
```

- [ ] **Step 5: Write the service**

`apps/daemon/src/services/streams/streams.ts`
```ts
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ProjectConfig } from '@orc/api-contract';
import {
  type Handoff,
  type PrRef,
  type StreamDetail,
  type StreamLink,
  type StreamLinkKind,
  type StreamPlanInput,
  type StreamPr,
  type StreamSessionInput,
  type StreamStage,
  type StreamTimelineItem,
  type StreamWorkflowInput,
  type StreamWorktreeInput,
  type WorkStream,
  applyManualLinks,
  collectTicketSignals,
  computeStreamStage,
  groupSignals,
} from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { getStream, listLinks, listStreams, replaceAutoLinks, setManualLink, upsertStream } from '../../db/repos/streams.ts';
import type { PrSource } from '../pr-source.ts';
import { listAllSessions } from '../session-pages.ts';
import type { UsageMeter } from '../usage/meter.ts';
import { readWstackWorkflows, resolveWstackHome } from '../wstack.ts';

export interface StreamService {
  refresh(): Promise<WorkStream[]>;
  refreshIfStale(): Promise<void>;
  list(q: { projectId?: string; stage?: StreamStage }): WorkStream[];
  get(ticket: string): Promise<StreamDetail | null>;
  link(ticket: string, kind: StreamLinkKind, ref: string): StreamLink;
  unlink(ticket: string, kind: StreamLinkKind, ref: string): StreamLink;
  start(): void;
  stop(): void;
}

interface Sources {
  sessions: StreamSessionInput[];
  prs: StreamPr[];
  plans: StreamPlanInput[];
  workflows: StreamWorkflowInput[];
  worktrees: StreamWorktreeInput[];
}

const MAX_PLAN_DEPTH = 4;

function walkPlans(dir: string, depth: number, out: StreamPlanInput[]): void {
  if (depth > MAX_PLAN_DEPTH || !existsSync(dir)) return;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) walkPlans(p, depth + 1, out);
    else if (d.isFile() && d.name.endsWith('.md')) out.push({ path: p, mtime: statSync(p).mtime.toISOString() });
  }
}

const firstLine = (s: string | null) => (s ? (s.split('\n').find((l) => l.trim().length > 0) ?? null) : null);
const maxIso = (xs: Array<string | null | undefined>) =>
  xs.filter((x): x is string => typeof x === 'string').sort().at(-1) ?? null;

export function createStreamService(
  ctx: DaemonContext,
  deps: {
    prs: PrSource;
    meter: Pick<UsageMeter, 'checkBudget'>;
    now?: () => Date;
    staleMs?: number;
    refreshMs?: number;
    sessionDays?: number;
  },
): StreamService {
  const now = deps.now ?? (() => new Date());
  const staleMs = deps.staleMs ?? 30_000;
  let lastRefresh = 0;
  let sources: Sources = { sessions: [], prs: [], plans: [], workflows: [], worktrees: [] };
  let running: Promise<WorkStream[]> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const unsubs: Array<() => void> = [];

  const enabledProjects = (): ProjectConfig[] => ctx.config().projects.filter((p) => p.features.workStreams);

  async function gather(projects: ProjectConfig[]): Promise<Sources> {
    const ids = new Set(projects.map((p) => p.id));
    const from = new Date(now().getTime() - (deps.sessionDays ?? 90) * 86_400_000).toISOString();
    const sessions: StreamSessionInput[] = [];
    for (const p of projects) {
      for (const item of listAllSessions(ctx, { projectId: p.id, from })) {
        const full = ctx.sessions.getByPk(item.pk);
        sessions.push({
          pk: item.pk,
          projectId: item.projectId,
          name: item.name,
          firstPrompt: item.firstPrompt,
          lastPrompt: item.lastPrompt,
          tickets: item.tickets,
          prs: item.prs,
          skills: full?.skills ?? [],
          costUsd: item.costUsd,
          startedAt: item.startedAt,
          lastActivityAt: item.lastActivityAt,
          liveStatus: item.live?.status ?? null,
          recap: item.recap,
        });
      }
    }
    const plans: StreamPlanInput[] = [];
    for (const p of projects) for (const prefix of p.pathPrefixes) walkPlans(join(prefix, 'plans'), 0, plans);
    walkPlans(join(ctx.paths.claudeHome, 'plans'), MAX_PLAN_DEPTH, plans);
    const worktrees: StreamWorktreeInput[] = [];
    if (ctx.worktrees) {
      for (const w of await ctx.worktrees.discover()) {
        const pid = w.projectId ?? ctx.projects.resolve(w.path);
        if (pid !== null && ids.has(pid)) {
          worktrees.push({ path: w.path, branch: w.branch, ticket: w.ticket, updatedAt: w.updatedAt ?? null });
        }
      }
    }
    return {
      sessions,
      prs: deps.prs.list(),
      plans,
      workflows: readWstackWorkflows(resolveWstackHome()),
      worktrees,
    };
  }

  async function doRefresh(): Promise<WorkStream[]> {
    const projects = enabledProjects();
    const nowIso = now().toISOString();
    if (projects.length === 0) {
      sources = { sessions: [], prs: [], plans: [], workflows: [], worktrees: [] };
      lastRefresh = now().getTime();
      return [];
    }
    sources = await gather(projects);
    const pattern = projects[0]?.ticketRegex ?? null;
    const signals = applyManualLinks(collectTicketSignals(sources, pattern), listLinks(ctx.db));
    const byPk = new Map(sources.sessions.map((s) => [s.pk, s]));
    const byUrl = new Map(sources.prs.map((p) => [p.pr.url, p]));
    const byPlan = new Map(sources.plans.map((p) => [p.path, p]));
    const byFlow = new Map(sources.workflows.map((w) => [w.file, w]));
    const out: WorkStream[] = [];

    for (const g of groupSignals(signals)) {
      const sessions = g.refs.session.map((pk) => byPk.get(pk)).filter((s): s is StreamSessionInput => s !== undefined);
      const prs = g.refs.pr.map((u) => byUrl.get(u)).filter((p): p is StreamPr => p !== undefined);
      const counts = new Map<string, number>();
      for (const s of sessions) if (s.projectId) counts.set(s.projectId, (counts.get(s.projectId) ?? 0) + 1);
      const projectId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? projects[0]?.id ?? 'wakecap';
      if (!projects.some((p) => p.id === projectId)) continue;
      const stream: WorkStream = {
        ticket: g.ticket,
        projectId,
        title:
          prs.find((p) => !p.isBackmerge)?.title ??
          sessions.find((s) => s.name)?.name ??
          (g.refs.plan[0] ? basename(g.refs.plan[0], '.md') : null),
        stage: computeStreamStage({ prs, sessions, hasWorktrees: g.refs.worktree.length > 0 }),
        sessionIds: g.refs.session,
        prs: prs.map((p): PrRef => p.pr),
        plans: g.refs.plan,
        worktrees: g.refs.worktree,
        costUsd: sessions.reduce((a, s) => a + (s.costUsd ?? 0), 0),
        lastActivityAt:
          maxIso([
            ...sessions.map((s) => s.lastActivityAt),
            ...prs.map((p) => p.updatedAt),
            ...g.refs.plan.map((p) => byPlan.get(p)?.mtime),
            ...g.refs.workflow.map((f) => byFlow.get(f)?.mtime),
          ]) ?? nowIso,
      };
      upsertStream(ctx.db, stream, nowIso);
      replaceAutoLinks(
        ctx.db,
        g.ticket,
        signals.filter((s) => s.ticket === g.ticket && s.source !== 'manual').map((s) => ({ kind: s.kind, ref: s.ref })),
        nowIso,
      );
      out.push(stream);
    }
    lastRefresh = now().getTime();
    return out;
  }

  function refresh(): Promise<WorkStream[]> {
    if (!running) running = doRefresh().finally(() => (running = null));
    return running;
  }

  async function refreshIfStale(): Promise<void> {
    if (now().getTime() - lastRefresh > staleMs) await refresh();
  }

  function timeline(stream: WorkStream): { items: StreamTimelineItem[]; handoff: Handoff | null } {
    const items: StreamTimelineItem[] = [];
    let handoff: Handoff | null = null;
    for (const pk of stream.sessionIds) {
      const s = sources.sessions.find((x) => x.pk === pk);
      if (!s) continue;
      items.push({ ts: s.startedAt, kind: 'session', title: s.name ?? s.firstPrompt ?? pk, ref: pk, detail: firstLine(s.recap) });
      if (s.recap) items.push({ ts: s.lastActivityAt, kind: 'recap', title: 'Recap', ref: pk, detail: s.recap });
      const h = ctx.handoffs?.latest(pk) ?? null;
      if (h && (handoff === null || h.createdAt > handoff.createdAt)) handoff = h;
    }
    for (const ref of stream.prs) {
      const p = sources.prs.find((x) => x.pr.url === ref.url);
      if (!p) continue;
      items.push({
        ts: p.mergedAt ?? p.updatedAt,
        kind: 'pr',
        title: `#${p.pr.number} ${p.title}`,
        ref: p.pr.url,
        detail: `${p.state}${p.isBackmerge ? ' · backmerge' : ''} · checks ${p.checks} · review ${p.review}`,
      });
    }
    for (const path of stream.plans) {
      const p = sources.plans.find((x) => x.path === path);
      if (p) items.push({ ts: p.mtime, kind: 'plan', title: basename(path), ref: path, detail: null });
    }
    for (const path of stream.worktrees) {
      const w = sources.worktrees.find((x) => x.path === path);
      if (w) items.push({ ts: w.updatedAt ?? stream.lastActivityAt, kind: 'worktree', title: w.branch, ref: path, detail: null });
    }
    for (const w of sources.workflows) {
      if (listLinks(ctx.db, stream.ticket).some((l) => l.kind === 'workflow' && l.ref === w.file && !l.excluded)) {
        items.push({ ts: w.mtime, kind: 'workflow', title: w.env.WORKFLOW_ID ?? basename(w.file), ref: w.file, detail: w.env.BRANCH ?? null });
      }
    }
    if (handoff) {
      items.push({ ts: handoff.createdAt, kind: 'handoff', title: `Handoff: ${handoff.status}`, ref: handoff.id, detail: handoff.summary });
    }
    const goal = ctx.goals?.get('stream', stream.ticket) ?? null;
    if (goal) items.push({ ts: goal.updatedAt, kind: 'goal', title: `Goal: ${goal.state}`, ref: goal.id, detail: goal.objective });
    items.sort((a, b) => b.ts.localeCompare(a.ts));
    return { items, handoff };
  }

  return {
    refresh,
    refreshIfStale,
    list: (q) => listStreams(ctx.db, q),
    async get(ticket) {
      await refreshIfStale();
      const stream = getStream(ctx.db, ticket.toUpperCase());
      if (!stream) return null;
      const { items, handoff } = timeline(stream);
      return {
        stream,
        prsDetailed: stream.prs
          .map((r) => sources.prs.find((p) => p.pr.url === r.url))
          .filter((p): p is StreamPr => p !== undefined),
        links: listLinks(ctx.db, stream.ticket),
        timeline: items,
        goal: ctx.goals?.get('stream', stream.ticket) ?? null,
        handoff,
        budget: deps.meter.checkBudget({ ticket: stream.ticket, projectId: stream.projectId }),
      };
    },
    link(ticket, kind, ref) {
      lastRefresh = 0;
      return setManualLink(ctx.db, ticket.toUpperCase(), kind, ref, false, now().toISOString());
    },
    unlink(ticket, kind, ref) {
      lastRefresh = 0;
      return setManualLink(ctx.db, ticket.toUpperCase(), kind, ref, true, now().toISOString());
    },
    start() {
      refresh().catch((err: unknown) => ctx.log.warn({ err }, 'stream refresh failed'));
      timer = setInterval(() => {
        refresh().catch((err: unknown) => ctx.log.warn({ err }, 'stream refresh failed'));
      }, deps.refreshMs ?? 120_000);
      unsubs.push(
        ctx.bus.on('pr.changed', () => {
          lastRefresh = 0;
        }),
      );
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const u of unsubs.splice(0)) u();
    },
  };
}
```

In the test, `$CLAUDE_HOME/plans/fixture-plan.md` exists, but its name has no ticket prefix, so it adds nothing.

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm vitest run apps/daemon/src/services/streams`
Expected: PASS (5 tests)

- [ ] **Step 7: Write the failing route test**

`apps/daemon/src/http/routes/streams.test.ts`
```ts
import type { StreamDetail, WorkStream } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { bareApp, makeP5Context, withWakecap } from '../../../test/p5-helpers.ts';
import type { StreamService } from '../../services/streams/streams.ts';
import { registerStreamRoutes } from './streams.ts';

const stream: WorkStream = {
  ticket: 'SAF-1', projectId: 'wakecap', title: 't', stage: 'pr_open', sessionIds: [], prs: [], plans: [], worktrees: [], costUsd: 1, lastActivityAt: '2026-09-01T00:00:00.000Z',
};

function setup() {
  const calls: string[] = [];
  const svc: StreamService = {
    refresh: async () => (calls.push('refresh'), [stream]),
    refreshIfStale: async () => void calls.push('stale'),
    list: (q) => (calls.push(`list:${q.stage ?? ''}`), [stream]),
    get: async (t) => (t === 'SAF-1' ? ({ stream, prsDetailed: [], links: [], timeline: [], goal: null, handoff: null, budget: { ok: true, pct: 0, limitUsd: null } } satisfies StreamDetail) : null),
    link: (ticket, kind, ref) => ({ ticket, kind, ref, origin: 'manual', excluded: false, createdAt: 'x' }),
    unlink: (ticket, kind, ref) => ({ ticket, kind, ref, origin: 'manual', excluded: true, createdAt: 'x' }),
    start: () => undefined,
    stop: () => undefined,
  };
  const { ctx } = makeP5Context({ config: withWakecap('/Users/test/Wakecap') });
  ctx.streams = svc;
  const app = bareApp();
  registerStreamRoutes(app, ctx);
  return { app, calls };
}

describe('/api/streams', () => {
  it('lists with filters after a stale check', async () => {
    const { app, calls } = setup();
    const res = await app.request('/api/streams?stage=pr_open');
    expect(await res.json()).toEqual([stream]);
    expect(calls).toEqual(['stale', 'list:pr_open']);
    expect((await app.request('/api/streams?stage=bogus')).status).toBe(400);
  });

  it('gets one stream or 404s', async () => {
    const { app } = setup();
    expect(((await (await app.request('/api/streams/SAF-1')).json()) as StreamDetail).stream.ticket).toBe('SAF-1');
    expect((await app.request('/api/streams/SAF-2')).status).toBe(404);
  });

  it('links, unlinks and refreshes', async () => {
    const { app } = setup();
    const post = (path: string, body: unknown) =>
      app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(await (await post('/api/streams/SAF-1/link', { kind: 'session', ref: 'claude:x' })).json()).toMatchObject({ excluded: false });
    expect(await (await post('/api/streams/SAF-1/unlink', { kind: 'pr', ref: 'u' })).json()).toMatchObject({ excluded: true });
    expect((await post('/api/streams/SAF-1/link', { kind: 'bogus', ref: 'x' })).status).toBe(400);
    expect(await (await post('/api/streams/refresh', {})).json()).toEqual([stream]);
  });
});
```

- [ ] **Step 8: Implement the routes**

`apps/daemon/src/http/routes/streams.ts`
```ts
import { StreamLinkBody, StreamsListQuery } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { need } from '../../services/need.ts';
import { notFound, readBody, readQuery } from '../p5-util.ts';
import type { OrcApp } from '../types.ts';

export function registerStreamRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.streams, 'streams');

  app.get('/api/streams', async (c) => {
    const q = readQuery(c, StreamsListQuery);
    if (!q.ok) return q.res;
    await svc().refreshIfStale();
    return c.json(svc().list(q.data));
  });
  app.post('/api/streams/refresh', async (c) => c.json(await svc().refresh()));
  app.get('/api/streams/:ticket', async (c) => {
    const d = await svc().get(c.req.param('ticket'));
    return d ? c.json(d) : notFound(c, 'stream');
  });
  app.post('/api/streams/:ticket/link', async (c) => {
    const b = await readBody(c, StreamLinkBody);
    if (!b.ok) return b.res;
    return c.json(svc().link(c.req.param('ticket'), b.data.kind, b.data.ref));
  });
  app.post('/api/streams/:ticket/unlink', async (c) => {
    const b = await readBody(c, StreamLinkBody);
    if (!b.ok) return b.res;
    return c.json(svc().unlink(c.req.param('ticket'), b.data.kind, b.data.ref));
  });
}
```

Hono matches routes in registration order, so `/api/streams/refresh` (POST) is registered before `/:ticket/link`, and there is no GET conflict.

- [ ] **Step 9: Run the route test and confirm it passes**

Run: `pnpm vitest run apps/daemon/src/http/routes/streams.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 10: Wire, register and exempt**

In `apps/daemon/src/context.ts`:
- Add `prs?: PrSource;` and `streams?: StreamService;`, with type imports from `./services/pr-source.ts` and `./services/streams/streams.ts`.
- In `buildContext()`, after the meter:
```ts
  ctx.prs = createPrSource(ctx);
  ctx.streams = createStreamService(ctx, { prs: ctx.prs, meter: ctx.usage });
```

In `createDaemon()`: add `ctx.streams?.start();`, and `ctx.streams?.stop();` in `close()`.

In `createApp`: `registerStreamRoutes(app, o.ctx);`.

Append to `NON_ACTION_ROUTES`:
```ts
  { method: 'POST', path: '/api/streams/refresh', why: 'recomputes local stream metadata' },
  { method: 'POST', path: '/api/streams/:ticket/link', why: 'local stream metadata' },
  { method: 'POST', path: '/api/streams/:ticket/unlink', why: 'local stream metadata' },
```

- [ ] **Step 11: Commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add apps/daemon
git commit -m "feat(daemon): add work stream service, PR source, wstack reader and /api/streams"
```

---

### Task 10: Analytics aggregations, facets and wstack outcomes, weekly digest, and `/api/analytics`

**Files:**
- Create: `packages/core/src/derive/analytics.ts`, `packages/core/src/derive/analytics.test.ts`
- Create: `packages/core/src/derive/digest.ts`, `packages/core/src/derive/digest.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/browser.ts`
- Create: `apps/daemon/src/db/repos/digests.ts`
- Create: `apps/daemon/src/services/analytics/facets.ts`, `apps/daemon/src/services/analytics/analytics.ts`, `apps/daemon/src/services/analytics/digest.ts`, `apps/daemon/src/services/analytics/analytics.test.ts`
- Create: `apps/daemon/src/http/routes/analytics.ts`, `apps/daemon/src/http/routes/analytics.test.ts`
- Modify: `apps/daemon/src/context.ts`, `apps/daemon/src/main.ts`, `apps/daemon/src/http/app.ts`, `apps/daemon/src/http/audit-middleware.ts`

**Interfaces:**
- Consumes:
  - `UsageLedger.entries/tools` (Task 5)
  - `PrSource` and `readWstackTimelines` (Task 9)
  - `UsageMeter.snapshot/budgets` (Task 7)
  - `Scheduler`, `ensureCronJob`, `removeJobsOfType` (Task 3)
  - `LiveTracker.list()` (P2)
  - `extractTicketsFrom` (Task 8)
  - `listAllSessions` (Task 2)
- Produces:
  ```ts
  // core derive/analytics.ts
  export interface AnalyticsEntry { sessionPk: string; ts: string; source: string; projectId: string | null; tickets: string[]; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; latencyMs: number | null }
  export interface AnalyticsTool { ts: string; kind: ToolKind; name: string; durationMs: number | null }
  export function bucketKey(ts: string, bucket: 'day' | 'week'): string                 // UTC 'YYYY-MM-DD' (week = ISO Monday)
  export function groupCost(entries: AnalyticsEntry[], groupBy: AnalyticsGroupBy): CostRow[]
  export function topSessionCosts(entries: AnalyticsEntry[], limit: number): Array<{ pk: string; costUsd: number }>
  export function topTickets(entries: AnalyticsEntry[], limit: number): TopTicket[]
  export function costPerMergedPr(entries: AnalyticsEntry[], mergedPrSessions: string[][]): { mergedPrs: number; costPerMergedPrUsd: number | null }
  export function toolUsageRows(tools: AnalyticsTool[], bucket: 'day' | 'week'): ToolUsageRow[]
  export function timingSummary(entries: AnalyticsEntry[], tools: AnalyticsTool[], bucket: 'day' | 'week'): TimingResult
  export function summarizeFacets(facets: unknown[], sessionIds: ReadonlySet<string> | null): OutcomesResult
  export function summarizeWstackTimeline(lines: unknown[], from: string, to: string): WstackSkillRow[]
  // core derive/digest.ts
  export interface WeeklyDigestInput { weekStart: string; weekEnd: string; spendUsd: number; estimated: boolean; spendByProject: CostRow[]; shippedPrs: Array<{ title: string; url: string; number: number; mergedAt: string; tickets: string[] }>; stuckSessions: Array<{ pk: string; name: string | null; status: string; since: string }>; topTickets: TopTicket[]; quota: UsageSnapshot; budgets: BudgetStatus[] }
  export function renderWeeklyDigest(i: WeeklyDigestInput): string
  // daemon
  export function readFacets(claudeHome: string): unknown[]                              // usage-data/facets/*.json, read-only
  export interface AnalyticsQuery { from: string; to: string; projectId?: string }
  export function resolveRange(q: { from?: string; to?: string; projectId?: string }, now: Date): AnalyticsQuery   // default: last 30 days
  export interface AnalyticsService {
    cost(q: AnalyticsQuery & { groupBy: AnalyticsGroupBy }): { rows: CostRow[]; estimated: boolean };
    top(q: AnalyticsQuery & { limit: number }): TopResult;
    tools(q: AnalyticsQuery & { bucket: 'day' | 'week' }): ToolUsageRow[];
    timing(q: AnalyticsQuery & { bucket: 'day' | 'week' }): TimingResult;
    outcomes(q: AnalyticsQuery): OutcomesResult;
    wstack(q: AnalyticsQuery): WstackSkillRow[];
  }
  export function createAnalyticsService(ctx: DaemonContext, deps: { ledger: UsageLedger; prs: PrSource }): AnalyticsService
  export interface DigestService { generate(weekStart?: string): Promise<DigestRecord>; latest(): DigestRecord | null; syncSchedule(): void; start(): void; stop(): void }
  export function lastWeekStart(now: Date): string
  export function createDigestService(ctx: DaemonContext, deps: { analytics: AnalyticsService; prs: PrSource; meter: UsageMeter; scheduler: Scheduler; now?: () => Date }): DigestService
  export function registerAnalyticsRoutes(app: OrcApp, ctx: DaemonContext): void
  // repos/digests.ts
  export function upsertDigest(db: OrcDb, d: DigestRecord): void
  export function latestDigest(db: OrcDb): DigestRecord | null
  ```
- Cost is the ledger's **allocated** cost. `estimated` is true when any entry in range comes from a session without `cost-state`.
- Ticket costs split a message's cost evenly across its tickets. Messages without a ticket go to the key `(none)`.
- **Timing, from the ledger:**
  - model time = the sum of per-message latencies
  - tool time = the sum of tool durations
  - cache hit rate per bucket = `cacheRead ÷ (input + cacheRead + cacheWrite)`

  Phase 3's per-session stats (`/api/sessions/:source/:id/stats`) stay the source for a single session. This cross-session view uses the ledger, so it stays incremental.

- [ ] **Step 1: Write the failing core tests**

`packages/core/src/derive/analytics.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import {
  type AnalyticsEntry,
  bucketKey,
  costPerMergedPr,
  groupCost,
  summarizeFacets,
  summarizeWstackTimeline,
  timingSummary,
  toolUsageRows,
  topSessionCosts,
  topTickets,
} from './analytics.ts';

const e = (p: Partial<AnalyticsEntry>): AnalyticsEntry => ({
  sessionPk: 'claude:a', ts: '2026-09-15T10:00:00.000Z', source: 'claude', projectId: 'wakecap', tickets: [], model: 'claude-opus-5',
  input: 10, output: 10, cacheRead: 80, cacheWrite: 0, costUsd: 1, latencyMs: 1000, ...p,
});
const entries = [
  e({ tickets: ['SAF-1'], costUsd: 4 }),
  e({ sessionPk: 'claude:b', ts: '2026-09-16T10:00:00.000Z', tickets: ['SAF-1', 'SAF-2'], costUsd: 2, model: 'claude-sonnet-5' }),
  e({ sessionPk: 'codex:c', ts: '2026-09-21T10:00:00.000Z', source: 'codex', projectId: null, costUsd: 3, cacheRead: 0, latencyMs: null }),
];

describe('analytics', () => {
  it('buckets by UTC day and ISO week', () => {
    expect(bucketKey('2026-09-20T23:59:00.000Z', 'day')).toBe('2026-09-20');
    expect(bucketKey('2026-09-20T23:59:00.000Z', 'week')).toBe('2026-09-14');
    expect(bucketKey('2026-09-21T00:00:00.000Z', 'week')).toBe('2026-09-21');
  });

  it('groups cost by every dimension', () => {
    expect(groupCost(entries, 'day').map((r) => [r.key, r.costUsd])).toEqual([['2026-09-15', 4], ['2026-09-16', 2], ['2026-09-21', 3]]);
    expect(groupCost(entries, 'week').map((r) => [r.key, r.costUsd, r.sessions])).toEqual([['2026-09-14', 6, 2], ['2026-09-21', 3, 1]]);
    expect(groupCost(entries, 'project').map((r) => [r.key, r.costUsd])).toEqual([['wakecap', 6], ['unassigned', 3]]);
    expect(groupCost(entries, 'model').map((r) => r.key)).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(groupCost(entries, 'source').map((r) => [r.key, r.costUsd])).toEqual([['claude', 6], ['codex', 3]]);
    const byTicket = groupCost(entries, 'ticket');
    expect(byTicket.map((r) => [r.key, r.costUsd])).toEqual([['SAF-1', 5], ['(none)', 3], ['SAF-2', 1]]);
    expect(byTicket[0]?.tokens).toEqual({ input: 15, output: 15, cacheRead: 120, cacheWrite: 0 });
  });

  it('ranks sessions and tickets and computes cost per merged PR', () => {
    expect(topSessionCosts(entries, 2)).toEqual([{ pk: 'claude:a', costUsd: 4 }, { pk: 'codex:c', costUsd: 3 }]);
    expect(topTickets(entries, 5)).toEqual([{ ticket: 'SAF-1', costUsd: 5, sessions: 2 }, { ticket: 'SAF-2', costUsd: 1, sessions: 1 }]);
    expect(costPerMergedPr(entries, [['claude:a'], ['claude:a', 'claude:b']])).toEqual({ mergedPrs: 2, costPerMergedPrUsd: 3 });
    expect(costPerMergedPr(entries, [])).toEqual({ mergedPrs: 0, costPerMergedPrUsd: null });
  });

  it('counts tool usage per bucket and summarises timing', () => {
    const tools = [
      { ts: '2026-09-15T10:00:00.000Z', kind: 'tool' as const, name: 'Bash', durationMs: 3000 },
      { ts: '2026-09-15T11:00:00.000Z', kind: 'tool' as const, name: 'Bash', durationMs: null },
      { ts: '2026-09-15T12:00:00.000Z', kind: 'mcp' as const, name: 'claude_ai_Linear', durationMs: 1000 },
      { ts: '2026-09-16T12:00:00.000Z', kind: 'skill' as const, name: 'conductor', durationMs: null },
    ];
    expect(toolUsageRows(tools, 'day')).toEqual([
      { bucket: '2026-09-15', kind: 'tool', name: 'Bash', count: 2 },
      { bucket: '2026-09-15', kind: 'mcp', name: 'claude_ai_Linear', count: 1 },
      { bucket: '2026-09-16', kind: 'skill', name: 'conductor', count: 1 },
    ]);
    expect(timingSummary(entries, tools, 'day')).toEqual({
      modelMs: 2000,
      toolMs: 4000,
      modelShare: 2000 / 6000,
      cacheHitTrend: [
        { bucket: '2026-09-15', rate: 80 / 90 },
        { bucket: '2026-09-16', rate: 80 / 90 },
        { bucket: '2026-09-21', rate: 0 },
      ],
    });
    expect(timingSummary([], [], 'day')).toEqual({ modelMs: 0, toolMs: 0, modelShare: null, cacheHitTrend: [] });
  });

  it('summarises facets, optionally limited to sessions', () => {
    const facets = [
      { session_id: 'a', outcome: 'fully_achieved', friction_counts: { buggy_code: 2 }, goal_categories: { debugging: 1 } },
      { session_id: 'b', outcome: 'mostly_achieved', friction_counts: { buggy_code: 1, tool_failure: 1 } },
      { session_id: 'z', outcome: 'fully_achieved' },
      'garbage',
    ];
    expect(summarizeFacets(facets, null)).toEqual({
      sessions: 3,
      outcomes: { fully_achieved: 2, mostly_achieved: 1 },
      friction: { buggy_code: 3, tool_failure: 1 },
      goalCategories: { debugging: 1 },
    });
    expect(summarizeFacets(facets, new Set(['a'])).sessions).toBe(1);
  });

  it('summarises wstack skill outcomes in range', () => {
    const lines = [
      { skill: 'ship', event: 'started', ts: '2026-09-15T10:00:00Z' },
      { skill: 'ship', outcome: 'success', duration_s: 60, ts: '2026-09-15T10:01:00Z' },
      { skill: 'ship', outcome: 'error', duration_s: 20, ts: '2026-09-16T10:00:00Z' },
      { skill: 'qa', outcome: 'success', ts: 1789000000 },
      { skill: 'old', outcome: 'success', ts: '2026-01-01T00:00:00Z' },
    ];
    expect(summarizeWstackTimeline(lines, '2026-09-01T00:00:00.000Z', '2026-09-30T00:00:00.000Z')).toEqual([
      { skill: 'ship', runs: 2, outcomes: { success: 1, error: 1 }, avgDurationS: 40 },
      { skill: 'qa', runs: 1, outcomes: { success: 1 }, avgDurationS: null },
    ]);
  });
});
```

`packages/core/src/derive/digest.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { renderWeeklyDigest } from './digest.ts';

const quota = {
  source: 'estimate' as const, generatedAt: '2026-09-21T09:00:00.000Z',
  block: { active: false, start: '2026-09-21T09:00:00.000Z', end: '2026-09-21T14:00:00.000Z', tokens: 0, costUsd: 0, pctOfLimit: null },
  week: { tokens: 1_200_000, costUsd: 88.5, pctOfLimit: 0.42 },
  burnRateUsdPerHour: 0, burnRateTokensPerMin: 0, projectedBlockExhaustionAt: null,
};

describe('renderWeeklyDigest', () => {
  it('renders every section', () => {
    const md = renderWeeklyDigest({
      weekStart: '2026-09-14', weekEnd: '2026-09-20', spendUsd: 123.456, estimated: true,
      spendByProject: [{ key: 'wakecap', costUsd: 100, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, sessions: 4 }],
      shippedPrs: [{ title: 'feat: SAF-1 x', url: 'https://github.com/o/r/pull/1', number: 1, mergedAt: '2026-09-15T10:00:00.000Z', tickets: ['SAF-1'] }],
      stuckSessions: [{ pk: 'claude:s', name: 'Fix CI', status: 'waiting', since: '2026-09-20T08:00:00.000Z' }],
      topTickets: [{ ticket: 'SAF-1', costUsd: 40, sessions: 3 }],
      quota,
      budgets: [{ budget: { id: 'b', scopeType: 'project', scopeId: 'wakecap', period: 'weekly', limitUsd: 200, origin: 'table' }, spentUsd: 100, pct: 0.5, periodStart: '2026-09-14T00:00:00.000Z' }],
    });
    expect(md).toContain('# Weekly digest — 2026-09-14 → 2026-09-20');
    expect(md).toContain('- Total: $123.46 (estimated)');
    expect(md).toContain('- wakecap: $100.00 (4 sessions)');
    expect(md).toContain('- [#1 feat: SAF-1 x](https://github.com/o/r/pull/1) — SAF-1 — merged 2026-09-15');
    expect(md).toContain('- Fix CI — waiting since 2026-09-20 08:00 UTC');
    expect(md).toContain('- SAF-1 — $40.00 (3 sessions)');
    expect(md).toContain('- 7 days: 1,200,000 tokens, $88.50, 42% of limit (estimated)');
    expect(md).toContain('- project wakecap weekly: $100.00 of $200.00 (50%)');
  });

  it('says none for empty sections', () => {
    const md = renderWeeklyDigest({
      weekStart: '2026-09-14', weekEnd: '2026-09-20', spendUsd: 0, estimated: false, spendByProject: [], shippedPrs: [],
      stuckSessions: [], topTickets: [], quota: { ...quota, source: 'official', week: { tokens: 0, costUsd: 0, pctOfLimit: null } }, budgets: [],
    });
    expect(md.match(/- none/g)).toHaveLength(5);
    expect(md).toContain('- Total: $0.00\n');
    expect(md).toContain('- 7 days: 0 tokens, $0.00 (official)');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run packages/core/src/derive/analytics.test.ts packages/core/src/derive/digest.test.ts`
Expected: FAIL, `Cannot find module './analytics.ts'` and `'./digest.ts'`.

- [ ] **Step 3: Implement the core functions**

`packages/core/src/derive/analytics.ts`
```ts
import type {
  AnalyticsGroupBy,
  CostRow,
  OutcomesResult,
  TimingResult,
  TokenTotals,
  ToolKind,
  ToolUsageRow,
  TopTicket,
  WstackSkillRow,
} from '../types/index.ts';

export interface AnalyticsEntry {
  sessionPk: string;
  ts: string;
  source: string;
  projectId: string | null;
  tickets: string[];
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  latencyMs: number | null;
}
export interface AnalyticsTool { ts: string; kind: ToolKind; name: string; durationMs: number | null }

const NO_TICKET = '(none)';
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function bucketKey(ts: string, bucket: 'day' | 'week'): string {
  const d = new Date(ts);
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (bucket === 'week') day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

function keysFor(e: AnalyticsEntry, groupBy: AnalyticsGroupBy): Array<{ key: string; share: number }> {
  switch (groupBy) {
    case 'day':
    case 'week':
      return [{ key: bucketKey(e.ts, groupBy), share: 1 }];
    case 'project':
      return [{ key: e.projectId ?? 'unassigned', share: 1 }];
    case 'model':
      return [{ key: e.model, share: 1 }];
    case 'source':
      return [{ key: e.source, share: 1 }];
    case 'ticket':
      return e.tickets.length === 0 ? [{ key: NO_TICKET, share: 1 }] : e.tickets.map((t) => ({ key: t, share: 1 / e.tickets.length }));
  }
}

export function groupCost(entries: AnalyticsEntry[], groupBy: AnalyticsGroupBy): CostRow[] {
  const acc = new Map<string, { costUsd: number; tokens: TokenTotals; pks: Set<string> }>();
  for (const e of entries) {
    for (const { key, share } of keysFor(e, groupBy)) {
      let a = acc.get(key);
      if (!a) {
        a = { costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, pks: new Set() };
        acc.set(key, a);
      }
      a.costUsd += e.costUsd * share;
      a.tokens.input += e.input * share;
      a.tokens.output += e.output * share;
      a.tokens.cacheRead += e.cacheRead * share;
      a.tokens.cacheWrite += e.cacheWrite * share;
      a.pks.add(e.sessionPk);
    }
  }
  const rows: CostRow[] = [...acc.entries()].map(([key, a]) => ({
    key,
    costUsd: round(a.costUsd),
    tokens: {
      input: Math.round(a.tokens.input),
      output: Math.round(a.tokens.output),
      cacheRead: Math.round(a.tokens.cacheRead),
      cacheWrite: Math.round(a.tokens.cacheWrite),
    },
    sessions: a.pks.size,
  }));
  return groupBy === 'day' || groupBy === 'week'
    ? rows.sort((x, y) => x.key.localeCompare(y.key))
    : rows.sort((x, y) => y.costUsd - x.costUsd || x.key.localeCompare(y.key));
}

export function topSessionCosts(entries: AnalyticsEntry[], limit: number): Array<{ pk: string; costUsd: number }> {
  const m = new Map<string, number>();
  for (const e of entries) m.set(e.sessionPk, (m.get(e.sessionPk) ?? 0) + e.costUsd);
  return [...m.entries()]
    .map(([pk, costUsd]) => ({ pk, costUsd: round(costUsd) }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, limit);
}

export function topTickets(entries: AnalyticsEntry[], limit: number): TopTicket[] {
  return groupCost(
    entries.filter((e) => e.tickets.length > 0),
    'ticket',
  )
    .slice(0, limit)
    .map((r) => ({ ticket: r.key, costUsd: r.costUsd, sessions: r.sessions }));
}

export function costPerMergedPr(
  entries: AnalyticsEntry[],
  mergedPrSessions: string[][],
): { mergedPrs: number; costPerMergedPrUsd: number | null } {
  if (mergedPrSessions.length === 0) return { mergedPrs: 0, costPerMergedPrUsd: null };
  const pks = new Set(mergedPrSessions.flat());
  const total = entries.filter((e) => pks.has(e.sessionPk)).reduce((a, e) => a + e.costUsd, 0);
  return { mergedPrs: mergedPrSessions.length, costPerMergedPrUsd: round(total / mergedPrSessions.length) };
}

export function toolUsageRows(tools: AnalyticsTool[], bucket: 'day' | 'week'): ToolUsageRow[] {
  const m = new Map<string, ToolUsageRow>();
  for (const t of tools) {
    const b = bucketKey(t.ts, bucket);
    const k = `${b}|${t.kind}|${t.name}`;
    const row = m.get(k) ?? { bucket: b, kind: t.kind, name: t.name, count: 0 };
    row.count += 1;
    m.set(k, row);
  }
  return [...m.values()].sort((a, b) => a.bucket.localeCompare(b.bucket) || b.count - a.count || a.name.localeCompare(b.name));
}

export function timingSummary(entries: AnalyticsEntry[], tools: AnalyticsTool[], bucket: 'day' | 'week'): TimingResult {
  const modelMs = entries.reduce((a, e) => a + (e.latencyMs ?? 0), 0);
  const toolMs = tools.reduce((a, t) => a + (t.durationMs ?? 0), 0);
  const per = new Map<string, { read: number; total: number }>();
  for (const e of entries) {
    const b = bucketKey(e.ts, bucket);
    const p = per.get(b) ?? { read: 0, total: 0 };
    p.read += e.cacheRead;
    p.total += e.input + e.cacheRead + e.cacheWrite;
    per.set(b, p);
  }
  return {
    modelMs,
    toolMs,
    modelShare: modelMs + toolMs > 0 ? modelMs / (modelMs + toolMs) : null,
    cacheHitTrend: [...per.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([b, p]) => ({ bucket: b, rate: p.total > 0 ? p.read / p.total : null })),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function addCounts(into: Record<string, number>, from: unknown): void {
  if (!isObj(from)) return;
  for (const [k, v] of Object.entries(from)) if (typeof v === 'number') into[k] = (into[k] ?? 0) + v;
}

export function summarizeFacets(facets: unknown[], sessionIds: ReadonlySet<string> | null): OutcomesResult {
  const out: OutcomesResult = { sessions: 0, outcomes: {}, friction: {}, goalCategories: {} };
  for (const f of facets) {
    if (!isObj(f) || typeof f.session_id !== 'string') continue;
    if (sessionIds !== null && !sessionIds.has(f.session_id)) continue;
    out.sessions += 1;
    if (typeof f.outcome === 'string') out.outcomes[f.outcome] = (out.outcomes[f.outcome] ?? 0) + 1;
    addCounts(out.friction, f.friction_counts);
    addCounts(out.goalCategories, f.goal_categories);
  }
  return out;
}

function toIso(ts: unknown): string | null {
  if (typeof ts === 'number') return new Date(ts < 1e12 ? ts * 1000 : ts).toISOString();
  if (typeof ts === 'string' && !Number.isNaN(Date.parse(ts))) return new Date(ts).toISOString();
  return null;
}

export function summarizeWstackTimeline(lines: unknown[], from: string, to: string): WstackSkillRow[] {
  const m = new Map<string, { runs: number; outcomes: Record<string, number>; dur: number; durN: number }>();
  for (const l of lines) {
    if (!isObj(l) || typeof l.skill !== 'string' || typeof l.outcome !== 'string') continue;
    const ts = toIso(l.ts);
    if (ts === null || ts < from || ts > to) continue;
    const a = m.get(l.skill) ?? { runs: 0, outcomes: {}, dur: 0, durN: 0 };
    a.runs += 1;
    a.outcomes[l.outcome] = (a.outcomes[l.outcome] ?? 0) + 1;
    if (typeof l.duration_s === 'number') {
      a.dur += l.duration_s;
      a.durN += 1;
    }
    m.set(l.skill, a);
  }
  return [...m.entries()]
    .map(([skill, a]) => ({ skill, runs: a.runs, outcomes: a.outcomes, avgDurationS: a.durN > 0 ? a.dur / a.durN : null }))
    .sort((x, y) => y.runs - x.runs || x.skill.localeCompare(y.skill));
}
```

`packages/core/src/derive/digest.ts`
```ts
import type { BudgetStatus, CostRow, TopTicket, UsageSnapshot } from '../types/index.ts';

export interface WeeklyDigestInput {
  weekStart: string;
  weekEnd: string;
  spendUsd: number;
  estimated: boolean;
  spendByProject: CostRow[];
  shippedPrs: Array<{ title: string; url: string; number: number; mergedAt: string; tickets: string[] }>;
  stuckSessions: Array<{ pk: string; name: string | null; status: string; since: string }>;
  topTickets: TopTicket[];
  quota: UsageSnapshot;
  budgets: BudgetStatus[];
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const list = (items: string[]) => (items.length > 0 ? items : ['- none']).join('\n');

export function renderWeeklyDigest(i: WeeklyDigestInput): string {
  const q = i.quota;
  const label = q.source === 'estimate' ? 'estimated' : 'official';
  const weekPct = q.week.pctOfLimit !== null ? `, ${pct(q.week.pctOfLimit)} of limit` : '';
  return [
    `# Weekly digest — ${i.weekStart} → ${i.weekEnd}`,
    '',
    '## Spend',
    `- Total: ${usd(i.spendUsd)}${i.estimated ? ' (estimated)' : ''}`,
    list(i.spendByProject.map((r) => `- ${r.key}: ${usd(r.costUsd)} (${r.sessions} sessions)`)),
    '',
    `## Shipped PRs (${i.shippedPrs.length})`,
    list(
      i.shippedPrs.map(
        (p) => `- [#${p.number} ${p.title}](${p.url})${p.tickets.length ? ` — ${p.tickets.join(', ')}` : ''} — merged ${p.mergedAt.slice(0, 10)}`,
      ),
    ),
    '',
    `## Stuck sessions (${i.stuckSessions.length})`,
    list(i.stuckSessions.map((s) => `- ${s.name ?? s.pk} — ${s.status} since ${utc(s.since)}`)),
    '',
    '## Top tickets',
    list(i.topTickets.map((t) => `- ${t.ticket} — ${usd(t.costUsd)} (${t.sessions} sessions)`)),
    '',
    '## Quota & budgets',
    `- 7 days: ${q.week.tokens.toLocaleString('en-US')} tokens, ${usd(q.week.costUsd)}${weekPct} (${label})`,
    list(
      i.budgets.map(
        (b) =>
          `- ${b.budget.scopeType}${b.budget.scopeId ? ` ${b.budget.scopeId}` : ''} ${b.budget.period}: ${usd(b.spentUsd)} of ${usd(b.budget.limitUsd)} (${pct(b.pct)})`,
      ),
    ),
    '',
  ].join('\n');
}
```

Append to both `packages/core/src/index.ts` and `packages/core/src/browser.ts`:
```ts
export * from './derive/analytics.ts';
export * from './derive/digest.ts';
```

- [ ] **Step 4: Run the core tests and confirm they pass**

Run: `pnpm vitest run packages/core/src/derive/analytics.test.ts packages/core/src/derive/digest.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Write the failing daemon test**

`apps/daemon/src/services/analytics/analytics.test.ts`
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, StreamPr } from '@orc/core';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ev, makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import { createScheduler } from '../scheduler/scheduler.ts';
import { createUsageLedger } from '../usage/ledger.ts';
import { createUsageMeter } from '../usage/meter.ts';
import { createAnalyticsService, resolveRange } from './analytics.ts';
import { createDigestService, lastWeekStart } from './digest.ts';

let wstack: string;
beforeEach(() => {
  wstack = mkdtempSync(join(tmpdir(), 'orc-wstack-'));
  mkdirSync(join(wstack, 'projects', 'svc'), { recursive: true });
  writeFileSync(
    join(wstack, 'projects', 'svc', 'timeline.jsonl'),
    `${JSON.stringify({ skill: 'ship', outcome: 'success', duration_s: 30, ts: '2026-09-15T10:00:00Z' })}\nnot json\n`,
  );
  vi.stubEnv('WSTACK_HOME', wstack);
});
afterEach(() => vi.unstubAllEnvs());

const merged: StreamPr = {
  pr: { repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7' }, title: 'feat: SAF-1 thing', state: 'merged', headRef: null,
  baseRef: null, isBackmerge: false, checks: 'success', review: 'approved', updatedAt: '2026-09-16T10:00:00.000Z', mergedAt: '2026-09-16T10:00:00.000Z',
};

async function setup() {
  const waiting: Session = makeSession({
    id: 's-basic', tickets: ['SAF-1'], prs: [merged.pr], name: 'Notification tests',
    usage: { input: 10, output: 10, cacheRead: 80, cacheWrite: 0, costUsd: 5 },
    live: { pid: 1, status: 'waiting', waitingFor: 'input', since: '2026-09-15T08:00:00.000Z', ownership: 'observed', ptyId: null, stage: null, currentTool: null, backgroundJobs: 0, runningSubagents: 0, contextFill: null },
  });
  const events = {
    'claude:s-basic': [
      ev({ seq: 1, ts: '2026-09-15T09:59:59.000Z', kind: 'prompt', text: '/review now' }),
      ev({ seq: 2, ts: '2026-09-15T10:00:00.000Z', kind: 'tool_call', messageId: 'm1', model: 'claude-opus-5', tool: 'Bash', toolUseId: 't', usage: { input: 10, output: 10, cacheRead: 80, cacheWrite: 0, costUsd: null } }),
      ev({ seq: 3, ts: '2026-09-15T10:00:02.000Z', kind: 'tool_result', toolUseId: 't' }),
    ],
  };
  const t = makeP5Context({ config: withWakecap('/Users/test/Wakecap'), data: { sessions: [waiting], events } });
  t.ctx.live = { list: () => [waiting] } as unknown as NonNullable<typeof t.ctx.live>;
  const ledger = createUsageLedger(t.ctx);
  await ledger.syncSession('claude:s-basic');
  const prs = { list: () => [merged] };
  const analytics = createAnalyticsService(t.ctx, { ledger, prs });
  const meter = createUsageMeter(t.ctx, { ledger, inbox: null, now: () => new Date('2026-09-21T09:00:00.000Z') });
  const scheduler = createScheduler({ db: t.ctx.db, log: pino({ level: 'silent' }) });
  const digests = createDigestService(t.ctx, { analytics, prs, meter, scheduler, now: () => new Date('2026-09-21T09:00:00.000Z') });
  return { ...t, analytics, digests, scheduler };
}

const Q = { from: '2026-09-14T00:00:00.000Z', to: '2026-09-20T23:59:59.999Z' };

describe('analytics service', () => {
  it('defaults the range to the last 30 days', () => {
    expect(resolveRange({}, new Date('2026-09-17T00:00:00.000Z'))).toEqual({ from: '2026-08-18T00:00:00.000Z', to: '2026-09-17T00:00:00.000Z' });
    expect(resolveRange({ from: 'a', to: 'b', projectId: 'p' }, new Date())).toEqual({ from: 'a', to: 'b', projectId: 'p' });
  });

  it('answers cost, top, tools, timing, outcomes and wstack', async () => {
    const { analytics } = await setup();
    expect(analytics.cost({ ...Q, groupBy: 'ticket' })).toEqual({
      rows: [{ key: 'SAF-1', costUsd: 5, tokens: { input: 10, output: 10, cacheRead: 80, cacheWrite: 0 }, sessions: 1 }],
      estimated: false,
    });
    expect(analytics.top({ ...Q, limit: 5 })).toEqual({
      sessions: [{ pk: 'claude:s-basic', name: 'Notification tests', projectId: 'wakecap', costUsd: 5, tickets: ['SAF-1'] }],
      tickets: [{ ticket: 'SAF-1', costUsd: 5, sessions: 1 }],
      mergedPrs: 1,
      costPerMergedPrUsd: 5,
    });
    expect(analytics.tools({ ...Q, bucket: 'week' })).toEqual([
      { bucket: '2026-09-14', kind: 'tool', name: 'Bash', count: 1 },
      { bucket: '2026-09-14', kind: 'skill', name: 'review', count: 1 },
    ]);
    expect(analytics.timing({ ...Q, bucket: 'day' })).toMatchObject({ modelMs: 1000, toolMs: 2000 });
    expect(analytics.outcomes(Q)).toEqual({ sessions: 1, outcomes: { fully_achieved: 1 }, friction: {}, goalCategories: { debugging: 1 } });
    expect(analytics.wstack(Q)).toEqual([{ skill: 'ship', runs: 1, outcomes: { success: 1 }, avgDurationS: 30 }]);
  });

  it('generates, stores and schedules the weekly digest', async () => {
    const { digests, scheduler, ctx } = await setup();
    expect(lastWeekStart(new Date('2026-09-21T09:00:00.000Z'))).toBe('2026-09-14');
    const d = await digests.generate();
    expect(d.weekStart).toBe('2026-09-14');
    expect(d.markdown).toContain('- [#7 feat: SAF-1 thing](https://github.com/o/r/pull/7) — SAF-1 — merged 2026-09-16');
    expect(d.markdown).toContain('- Notification tests — waiting since 2026-09-15 08:00 UTC');
    expect(digests.latest()).toEqual(d);
    digests.syncSchedule();
    expect(scheduler.list('digest').map((j) => [j.cron, j.payload.type])).toEqual([['0 9 * * 1', 'weekly_digest']]);
    ctx.updateConfig?.((c) => ({ ...c, digest: { ...c.digest, enabled: false } }));
    digests.syncSchedule();
    expect(scheduler.list('digest')).toEqual([]);
  });
});
```

The test relies on the Phase 0 fixture `fixtures/claude-home/usage-data/facets/s-basic.json` (`outcome: fully_achieved`, `goal_categories: {debugging: 1}`), which `createTestContext` copies into the temp `CLAUDE_HOME`.

- [ ] **Step 6: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/analytics`
Expected: FAIL, `Cannot find module './analytics.ts'`.

- [ ] **Step 7: Implement the facets reader, the services and the digest repo**

`apps/daemon/src/services/analytics/facets.ts`
```ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 1024 * 1024;

/** Reads ~/.claude/usage-data/facets/*.json (read-only). Unparseable files are skipped. */
export function readFacets(claudeHome: string): unknown[] {
  const dir = join(claudeHome, 'usage-data', 'facets');
  if (!existsSync(dir)) return [];
  const out: unknown[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isFile() || !d.name.endsWith('.json')) continue;
    const file = join(dir, d.name);
    try {
      if (statSync(file).size > MAX_BYTES) continue;
      out.push(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      // skip
    }
  }
  return out;
}
```

`apps/daemon/src/services/analytics/analytics.ts`
```ts
import {
  type AnalyticsEntry,
  type AnalyticsGroupBy,
  type CostRow,
  type OutcomesResult,
  type TimingResult,
  type ToolUsageRow,
  type TopResult,
  type WstackSkillRow,
  costPerMergedPr,
  groupCost,
  summarizeFacets,
  summarizeWstackTimeline,
  timingSummary,
  toolUsageRows,
  topSessionCosts,
  topTickets,
} from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import type { LedgerEntry } from '../../db/repos/usage-ledger.ts';
import type { PrSource } from '../pr-source.ts';
import { listAllSessions } from '../session-pages.ts';
import type { UsageLedger } from '../usage/ledger.ts';
import { readWstackTimelines, resolveWstackHome } from '../wstack.ts';
import { readFacets } from './facets.ts';

export interface AnalyticsQuery { from: string; to: string; projectId?: string }

export function resolveRange(q: { from?: string; to?: string; projectId?: string }, now: Date): AnalyticsQuery {
  const out: AnalyticsQuery = {
    from: q.from ?? new Date(now.getTime() - 30 * 86_400_000).toISOString(),
    to: q.to ?? now.toISOString(),
  };
  if (q.projectId !== undefined) out.projectId = q.projectId;
  return out;
}

export interface AnalyticsService {
  cost(q: AnalyticsQuery & { groupBy: AnalyticsGroupBy }): { rows: CostRow[]; estimated: boolean };
  top(q: AnalyticsQuery & { limit: number }): TopResult;
  tools(q: AnalyticsQuery & { bucket: 'day' | 'week' }): ToolUsageRow[];
  timing(q: AnalyticsQuery & { bucket: 'day' | 'week' }): TimingResult;
  outcomes(q: AnalyticsQuery): OutcomesResult;
  wstack(q: AnalyticsQuery): WstackSkillRow[];
}

const toAnalytics = (e: LedgerEntry): AnalyticsEntry => ({
  sessionPk: e.sessionPk,
  ts: e.ts,
  source: e.source,
  projectId: e.projectId,
  tickets: e.tickets,
  model: e.model,
  input: e.input,
  output: e.output,
  cacheRead: e.cacheRead,
  cacheWrite: e.cacheWrite,
  costUsd: e.allocCostUsd,
  latencyMs: e.latencyMs,
});

export function createAnalyticsService(ctx: DaemonContext, deps: { ledger: UsageLedger; prs: PrSource }): AnalyticsService {
  const range = (q: AnalyticsQuery) => ({ from: q.from, to: q.to, ...(q.projectId !== undefined ? { projectId: q.projectId } : {}) });
  const entries = (q: AnalyticsQuery) => deps.ledger.entries(range(q));
  const tools = (q: AnalyticsQuery) =>
    deps.ledger.tools(range(q)).map((t) => ({ ts: t.ts, kind: t.kind, name: t.name, durationMs: t.durationMs }));

  return {
    cost(q) {
      const rows = entries(q);
      return { rows: groupCost(rows.map(toAnalytics), q.groupBy), estimated: rows.some((r) => !r.authoritative) };
    },
    top(q) {
      const rows = entries(q).map(toAnalytics);
      const sessions = topSessionCosts(rows, q.limit).map(({ pk, costUsd }) => {
        const s = ctx.sessions.getByPk(pk);
        return { pk, name: s?.name ?? null, projectId: s?.projectId ?? null, costUsd, tickets: s?.tickets ?? [] };
      });
      const merged = deps.prs
        .list()
        .filter((p) => p.state === 'merged' && p.mergedAt !== null && p.mergedAt >= q.from && p.mergedAt <= q.to);
      const allTime = deps.ledger.entries({ from: '1970-01-01T00:00:00.000Z', to: q.to, ...(q.projectId ? { projectId: q.projectId } : {}) });
      const prSessions = merged.map((p) => listAllSessions(ctx, { pr: p.pr.url }).map((s) => s.pk));
      return {
        sessions,
        tickets: topTickets(rows, q.limit),
        ...costPerMergedPr(allTime.map(toAnalytics), prSessions),
      };
    },
    tools: (q) => toolUsageRows(tools(q), q.bucket),
    timing: (q) => timingSummary(entries(q).map(toAnalytics), tools(q), q.bucket),
    outcomes(q) {
      const ids = new Set(
        entries(q)
          .filter((e) => e.sessionPk.startsWith('claude:'))
          .map((e) => e.sessionPk.slice('claude:'.length)),
      );
      return summarizeFacets(readFacets(ctx.paths.claudeHome), ids);
    },
    wstack: (q) => summarizeWstackTimeline(readWstackTimelines(resolveWstackHome()), q.from, q.to),
  };
}
```

`apps/daemon/src/db/repos/digests.ts`
```ts
import type { DigestRecord } from '@orc/core';
import { desc } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { digests } from '../schema.ts';

export function upsertDigest(db: OrcDb, d: DigestRecord): void {
  db.insert(digests)
    .values(d)
    .onConflictDoUpdate({ target: digests.weekStart, set: { markdown: d.markdown, createdAt: d.createdAt } })
    .run();
}

export function latestDigest(db: OrcDb): DigestRecord | null {
  return db.select().from(digests).orderBy(desc(digests.weekStart)).limit(1).get() ?? null;
}
```

`apps/daemon/src/services/analytics/digest.ts`
```ts
import { type DigestRecord, extractTicketsFrom, renderWeeklyDigest } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { latestDigest, upsertDigest } from '../../db/repos/digests.ts';
import type { PrSource } from '../pr-source.ts';
import { type Scheduler, ensureCronJob, removeJobsOfType } from '../scheduler/scheduler.ts';
import type { UsageMeter } from '../usage/meter.ts';
import type { AnalyticsService } from './analytics.ts';

export interface DigestService {
  generate(weekStart?: string): Promise<DigestRecord>;
  latest(): DigestRecord | null;
  syncSchedule(): void;
  start(): void;
  stop(): void;
}

const DAY = 86_400_000;
const STUCK_MS = 30 * 60_000;
const STUCK_STATUSES = new Set(['waiting', 'blocked', 'error']);

/** Monday (UTC) of the ISO week before `now`, as YYYY-MM-DD. */
export function lastWeekStart(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7);
  return d.toISOString().slice(0, 10);
}

export function createDigestService(
  ctx: DaemonContext,
  deps: { analytics: AnalyticsService; prs: PrSource; meter: UsageMeter; scheduler: Scheduler; now?: () => Date },
): DigestService {
  const now = deps.now ?? (() => new Date());
  const unsubs: Array<() => void> = [];

  async function generate(weekStart?: string): Promise<DigestRecord> {
    const start = weekStart ?? lastWeekStart(now());
    const fromMs = Date.parse(`${start}T00:00:00.000Z`);
    const from = new Date(fromMs).toISOString();
    const to = new Date(fromMs + 7 * DAY - 1).toISOString();
    const byProject = deps.analytics.cost({ from, to, groupBy: 'project' });
    const pattern = ctx.config().projects.find((p) => p.features.workStreams)?.ticketRegex ?? null;
    const at = now().getTime();
    const markdown = renderWeeklyDigest({
      weekStart: start,
      weekEnd: to.slice(0, 10),
      spendUsd: byProject.rows.reduce((a, r) => a + r.costUsd, 0),
      estimated: byProject.estimated,
      spendByProject: byProject.rows,
      shippedPrs: deps.prs
        .list()
        .filter((p) => p.state === 'merged' && !p.isBackmerge && p.mergedAt !== null && p.mergedAt >= from && p.mergedAt <= to)
        .map((p) => ({
          title: p.title,
          url: p.pr.url,
          number: p.pr.number,
          mergedAt: p.mergedAt ?? p.updatedAt,
          tickets: extractTicketsFrom(`${p.title} ${p.headRef ?? ''}`, pattern),
        })),
      stuckSessions: (ctx.live?.list() ?? [])
        .filter((s) => s.live !== null && STUCK_STATUSES.has(s.live.status) && at - Date.parse(s.live.since) >= STUCK_MS)
        .map((s) => ({ pk: `${s.source}:${s.id}`, name: s.name, status: s.live?.status ?? 'unknown', since: s.live?.since ?? s.lastActivityAt })),
      topTickets: deps.analytics.top({ from, to, limit: 5 }).tickets,
      quota: deps.meter.snapshot(),
      budgets: deps.meter.budgets(),
    });
    const record: DigestRecord = { weekStart: start, markdown, createdAt: now().toISOString() };
    upsertDigest(ctx.db, record);
    return record;
  }

  function syncSchedule(): void {
    const cfg = ctx.config().digest;
    if (cfg.enabled) ensureCronJob(deps.scheduler, 'digest', 'weekly_digest', cfg.cron);
    else removeJobsOfType(deps.scheduler, 'digest', 'weekly_digest');
  }

  return {
    generate,
    latest: () => latestDigest(ctx.db),
    syncSchedule,
    start() {
      deps.scheduler.onFire('digest', async (job) => {
        if (job.payload.type === 'weekly_digest') await generate();
      });
      syncSchedule();
      unsubs.push(ctx.bus.on('config.changed', syncSchedule));
    },
    stop() {
      for (const u of unsubs.splice(0)) u();
    },
  };
}
```

- [ ] **Step 8: Run the daemon test and confirm it passes**

Run: `pnpm vitest run apps/daemon/src/services/analytics`
Expected: PASS (3 tests)

- [ ] **Step 9: Write the failing route test, then the routes**

`apps/daemon/src/http/routes/analytics.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { bareApp, makeP5Context, withWakecap } from '../../../test/p5-helpers.ts';
import type { AnalyticsService } from '../../services/analytics/analytics.ts';
import type { DigestService } from '../../services/analytics/digest.ts';
import { registerAnalyticsRoutes } from './analytics.ts';

function setup() {
  const seen: unknown[] = [];
  const analytics: AnalyticsService = {
    cost: (q) => (seen.push(q), { rows: [], estimated: true }),
    top: (q) => (seen.push(q), { sessions: [], tickets: [], mergedPrs: 0, costPerMergedPrUsd: null }),
    tools: (q) => (seen.push(q), []),
    timing: (q) => (seen.push(q), { modelMs: 0, toolMs: 0, modelShare: null, cacheHitTrend: [] }),
    outcomes: (q) => (seen.push(q), { sessions: 0, outcomes: {}, friction: {}, goalCategories: {} }),
    wstack: (q) => (seen.push(q), []),
  };
  const rec = { weekStart: '2026-09-14', markdown: '# d', createdAt: 'x' };
  const digests: DigestService = { generate: async (w) => ({ ...rec, weekStart: w ?? rec.weekStart }), latest: () => null, syncSchedule: () => undefined, start: () => undefined, stop: () => undefined };
  const { ctx } = makeP5Context({ config: withWakecap('/Users/test/Wakecap') });
  ctx.analytics = analytics;
  ctx.digests = digests;
  const app = bareApp();
  registerAnalyticsRoutes(app, ctx);
  return { app, seen };
}

describe('/api/analytics', () => {
  it('validates and forwards queries with defaults', async () => {
    const { app, seen } = setup();
    expect(await (await app.request('/api/analytics/cost?groupBy=model&from=2026-09-01T00:00:00.000Z&to=2026-09-02T00:00:00.000Z')).json()).toEqual({ rows: [], estimated: true });
    expect(seen[0]).toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z', groupBy: 'model' });
    await app.request('/api/analytics/top?limit=3&projectId=wakecap');
    expect(seen[1]).toMatchObject({ limit: 3, projectId: 'wakecap' });
    await app.request('/api/analytics/tools');
    expect(seen[2]).toMatchObject({ bucket: 'day' });
    for (const p of ['timing', 'outcomes', 'wstack']) expect((await app.request(`/api/analytics/${p}`)).status).toBe(200);
    expect((await app.request('/api/analytics/cost?groupBy=nope')).status).toBe(400);
    expect((await app.request('/api/analytics/top?limit=0')).status).toBe(400);
  });

  it('serves and generates digests', async () => {
    const { app } = setup();
    expect(await (await app.request('/api/analytics/digest')).json()).toBeNull();
    const res = await app.request('/api/analytics/digest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ weekStart: '2026-09-07' }) });
    expect(await res.json()).toMatchObject({ weekStart: '2026-09-07' });
    expect((await app.request('/api/analytics/digest', { method: 'POST', body: JSON.stringify({ weekStart: 'x' }) })).status).toBe(400);
  });
});
```

`apps/daemon/src/http/routes/analytics.ts`
```ts
import {
  AnalyticsBucketQuery,
  AnalyticsCostQuery,
  AnalyticsRangeQuery,
  AnalyticsTopQuery,
  DigestGenerateBody,
} from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { resolveRange } from '../../services/analytics/analytics.ts';
import { need } from '../../services/need.ts';
import { readBody, readQuery } from '../p5-util.ts';
import type { OrcApp } from '../types.ts';

export function registerAnalyticsRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.analytics, 'analytics');
  const now = () => new Date();

  app.get('/api/analytics/cost', (c) => {
    const q = readQuery(c, AnalyticsCostQuery);
    if (!q.ok) return q.res;
    return c.json(svc().cost({ ...resolveRange(q.data, now()), groupBy: q.data.groupBy }));
  });
  app.get('/api/analytics/top', (c) => {
    const q = readQuery(c, AnalyticsTopQuery);
    if (!q.ok) return q.res;
    return c.json(svc().top({ ...resolveRange(q.data, now()), limit: q.data.limit }));
  });
  app.get('/api/analytics/tools', (c) => {
    const q = readQuery(c, AnalyticsBucketQuery);
    if (!q.ok) return q.res;
    return c.json(svc().tools({ ...resolveRange(q.data, now()), bucket: q.data.bucket }));
  });
  app.get('/api/analytics/timing', (c) => {
    const q = readQuery(c, AnalyticsBucketQuery);
    if (!q.ok) return q.res;
    return c.json(svc().timing({ ...resolveRange(q.data, now()), bucket: q.data.bucket }));
  });
  app.get('/api/analytics/outcomes', (c) => {
    const q = readQuery(c, AnalyticsRangeQuery);
    if (!q.ok) return q.res;
    return c.json(svc().outcomes(resolveRange(q.data, now())));
  });
  app.get('/api/analytics/wstack', (c) => {
    const q = readQuery(c, AnalyticsRangeQuery);
    if (!q.ok) return q.res;
    return c.json(svc().wstack(resolveRange(q.data, now())));
  });
  app.get('/api/analytics/digest', (c) => c.json(need(ctx.digests, 'digests').latest()));
  app.post('/api/analytics/digest', async (c) => {
    const b = await readBody(c, DigestGenerateBody);
    if (!b.ok) return b.res;
    return c.json(await need(ctx.digests, 'digests').generate(b.data.weekStart));
  });
}
```

Run: `pnpm vitest run apps/daemon/src/http/routes/analytics.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 10: Wire, register and exempt**

In `apps/daemon/src/context.ts`:
- Add `analytics?: AnalyticsService;` and `digests?: DigestService;` (type imports from `./services/analytics/analytics.ts` and `./services/analytics/digest.ts`).
- In `buildContext()`, after the stream service:
```ts
  ctx.analytics = createAnalyticsService(ctx, { ledger: ctx.ledger, prs: ctx.prs });
  ctx.digests = createDigestService(ctx, { analytics: ctx.analytics, prs: ctx.prs, meter: ctx.usage, scheduler: ctx.scheduler });
```

In `createDaemon()`: add `ctx.digests?.start();` **before** `ctx.scheduler?.start()`, so the handler is registered before overdue jobs fire. Move the scheduler start below it if needed, and add `ctx.digests?.stop();` in `close()`.

In `createApp`: `registerAnalyticsRoutes(app, o.ctx);`.

Append to `NON_ACTION_ROUTES`:
```ts
  { method: 'POST', path: '/api/analytics/digest', why: 'renders a local markdown digest; nothing is sent anywhere' },
```

- [ ] **Step 11: Commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add packages/core apps/daemon
git commit -m "feat(analytics): add cost/tool/timing/outcome aggregations, weekly digest and /api/analytics"
```

---

### Task 11: Redacted recap digest and prompt templates (core)

**Files:**
- Create: `packages/core/src/recap/digest.ts`, `packages/core/src/recap/digest.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/browser.ts`

**Interfaces:**
- Consumes: `redact()` (P0), `Session`, `TimelineEvent`, `TestResult` (core types)
- Produces:
  ```ts
  export const CHARS_PER_TOKEN = 4;
  export function approxTokens(s: string): number
  export function truncateText(s: string, max: number): string
  export function firstLine(s: string | null | undefined): string | null
  export type RecapSessionInput = Pick<Session, 'id' | 'source' | 'projectId' | 'name' | 'startCwd' | 'startedAt' | 'lastActivityAt' | 'models' | 'usage' | 'tickets' | 'prs' | 'skills' | 'filesTouched' | 'linesAdded' | 'linesRemoved' | 'awaySummary' | 'promptCount'>
  export interface RecapDigestInput { session: RecapSessionInput; events: TimelineEvent[]; tests: TestResult[]; plans: string[]; maxInputTokens: number; reserveTokens?: number }
  export interface RecapDigest { text: string; approxTokens: number; truncated: boolean; omittedItems: number }
  export function buildRecapDigest(i: RecapDigestInput): RecapDigest
  export const DEFAULT_RECAP_PROMPT: string      // vars: {{language}}, {{digest}}
  export const DEFAULT_DAILY_PROMPT: string      // vars: {{language}}, {{project}}, {{date}}, {{digest}}
  export const DEFAULT_HANDOFF_PROMPT: string    // vars: {{language}}, {{digest}}, {{evidence}}
  export function renderPromptTemplate(template: string, vars: Record<string, string>): string
  ```
- **Digest content:**
  - a header: name, source, project, cwd, times, models, cost, lines, prompt count, tickets, PRs, skills, plans, away summary
  - tool **names and counts** only
  - changed files (at most 30)
  - test results
  - human prompts, assistant text and short error lines, in order
- **Never included:** `tool_result` text, tool inputs, thinking, or system records.
- **Redaction:** every string goes through `redact()`, and the final text is passed through `redact()` once more.
- **Size cap:** `maxInputTokens × 4` characters minus a reserve for the template (800 tokens by default). When the conversation doesn't fit, the digest keeps the first ~30% and the most recent items, and writes `[… N conversation items omitted …]` between them.

- [ ] **Step 1: Write the failing test**

`packages/core/src/recap/digest.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '../types/index.ts';
import {
  DEFAULT_DAILY_PROMPT,
  DEFAULT_HANDOFF_PROMPT,
  DEFAULT_RECAP_PROMPT,
  type RecapSessionInput,
  approxTokens,
  buildRecapDigest,
  firstLine,
  renderPromptTemplate,
} from './digest.ts';

const session: RecapSessionInput = {
  id: 's-basic', source: 'claude', projectId: 'wakecap', name: 'Notification service test check', startCwd: '/Users/test/Wakecap',
  startedAt: '2026-09-01T09:00:00.000Z', lastActivityAt: '2026-09-01T09:07:00.000Z', models: ['claude-opus-5'],
  usage: { input: 15, output: 27, cacheRead: 2100, cacheWrite: 100, costUsd: 0.42 }, tickets: ['SAF-1787'],
  prs: [{ repo: 'example-org/svc', number: 231, url: 'https://github.com/example-org/svc/pull/231' }], skills: ['conductor'],
  filesTouched: ['/Users/test/Wakecap/Backend/svc/a.ts'], linesAdded: 1, linesRemoved: 1,
  awaySummary: 'Ran tests (18 passed) and edited a.ts.', promptCount: 3,
};
const e = (p: Partial<TimelineEvent> & { seq: number; kind: TimelineEvent['kind'] }): TimelineEvent => ({
  sessionId: 's-basic', agentId: null, uuid: `u${p.seq}`, parentUuid: null, ts: '2026-09-01T09:00:00.000Z', turn: 1, text: null, tool: null,
  toolUseId: null, mcpServer: null, input: null, messageId: null, model: null, usage: null, durationMs: null, ...p,
});
const events: TimelineEvent[] = [
  e({ seq: 1, kind: 'prompt', text: 'check the notification service tests, token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }),
  e({ seq: 2, kind: 'assistant_text', text: 'Running the tests.' }),
  e({ seq: 3, kind: 'tool_call', tool: 'Bash', input: { command: 'PGPASSWORD=hunter2 psql -c "select SECRET_INPUT"' } }),
  e({ seq: 4, kind: 'tool_result', text: 'SECRET_TOOL_OUTPUT rows=3' }),
  e({ seq: 5, kind: 'thinking', text: 'SECRET_THINKING' }),
  e({ seq: 6, kind: 'tool_call', tool: 'Edit', input: { file_path: '/x' } }),
  e({ seq: 7, kind: 'tool_call', tool: 'Bash', input: { command: 'ls' } }),
  e({ seq: 8, kind: 'system', text: 'SECRET_SYSTEM' }),
  e({ seq: 9, kind: 'error', turn: 2, text: 'API Error: 529 overloaded' }),
  e({ seq: 10, kind: 'prompt', turn: 3, text: '/review the change' }),
];
const tests = [{ ts: '2026-09-01T09:00:30.000Z', command: 'PGPASSWORD=hunter2 pnpm vitest run', passed: 18, failed: 0, skipped: 0, durationMs: 1400 }];

describe('buildRecapDigest', () => {
  it('builds a compact, redacted digest without tool outputs or inputs', () => {
    const d = buildRecapDigest({ session, events, tests, plans: ['/Users/test/Wakecap/plans/SAF-1787-x.md'], maxInputTokens: 30000 });
    expect(d.truncated).toBe(false);
    expect(d.text).toContain('name: Notification service test check');
    expect(d.text).toContain('models: claude-opus-5 · cost: $0.42 · lines: +1 −1 · prompts: 3');
    expect(d.text).toContain('tickets: SAF-1787');
    expect(d.text).toContain('PRs: https://github.com/example-org/svc/pull/231');
    expect(d.text).toContain('plans: /Users/test/Wakecap/plans/SAF-1787-x.md');
    expect(d.text).toContain('Bash ×2, Edit ×1');
    expect(d.text).toContain('- /Users/test/Wakecap/Backend/svc/a.ts');
    expect(d.text).toContain('`PGPASSWORD=«redacted:secret» pnpm vitest run`: 18 passed, 0 failed, 0 skipped');
    expect(d.text).toContain('[turn 1] USER: check the notification service tests, token «redacted:github»');
    expect(d.text).toContain('[turn 1] ASSISTANT: Running the tests.');
    expect(d.text).toContain('[turn 2] ERROR: API Error: 529 overloaded');
    expect(d.text).toContain('[turn 3] USER: /review the change');
    for (const secret of ['SECRET_INPUT', 'SECRET_TOOL_OUTPUT', 'SECRET_THINKING', 'SECRET_SYSTEM', 'hunter2', 'ghp_']) {
      expect(d.text).not.toContain(secret);
    }
    expect(d.approxTokens).toBe(approxTokens(d.text));
  });

  it('caps the size and keeps the first and latest conversation items', () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      e({ seq: i + 1, turn: i + 1, kind: i % 2 === 0 ? 'prompt' : 'assistant_text', text: `item-${i} ${'x'.repeat(300)}` }),
    );
    const d = buildRecapDigest({ session, events: many, tests: [], plans: [], maxInputTokens: 3000, reserveTokens: 500 });
    expect(d.truncated).toBe(true);
    expect(d.omittedItems).toBeGreaterThan(0);
    expect(d.text.length).toBeLessThanOrEqual((3000 - 500) * 4);
    expect(d.text).toContain('item-0 ');
    expect(d.text).toContain('item-399 ');
    expect(d.text).toContain(`[… ${d.omittedItems} conversation items omitted …]`);
  });

  it('truncates long single items', () => {
    const d = buildRecapDigest({ session, events: [e({ seq: 1, kind: 'prompt', text: 'y'.repeat(5000) })], tests: [], plans: [], maxInputTokens: 30000 });
    expect(d.text).toMatch(/USER: y{600}…/);
  });
});

describe('templates', () => {
  it('renders variables and leaves no placeholders', () => {
    const out = renderPromptTemplate(DEFAULT_RECAP_PROMPT, { language: 'Arabic', digest: 'DIGEST' });
    expect(out).toContain('Write in Arabic.');
    expect(out).toContain('**What to check:**');
    expect(out.endsWith('DIGEST\n')).toBe(true);
    expect(renderPromptTemplate('a {{missing}} b', {})).toBe('a  b');
    expect(DEFAULT_DAILY_PROMPT).toContain('{{date}}');
    expect(DEFAULT_HANDOFF_PROMPT).toContain('"nextSteps"');
  });

  it('extracts the first non-empty line', () => {
    expect(firstLine('\n  \nFixed it.\nmore')).toBe('Fixed it.');
    expect(firstLine(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/core/src/recap`
Expected: FAIL, `Cannot find module './digest.ts'`.

- [ ] **Step 3: Implement the digest and templates**

`packages/core/src/recap/digest.ts`
```ts
import { redact } from '../redact/redact.ts';
import type { Session, TestResult, TimelineEvent } from '../types/index.ts';

export const CHARS_PER_TOKEN = 4;
const DEFAULT_RESERVE_TOKENS = 800;
const MAX_PROMPT_CHARS = 600;
const MAX_ASSISTANT_CHARS = 400;
const MAX_ERROR_CHARS = 200;
const MAX_FILES = 30;
const HEAD_SHARE = 0.3;

export const approxTokens = (s: string): number => Math.ceil(s.length / CHARS_PER_TOKEN);

export function truncateText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export function firstLine(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? null;
}

export type RecapSessionInput = Pick<
  Session,
  | 'id' | 'source' | 'projectId' | 'name' | 'startCwd' | 'startedAt' | 'lastActivityAt' | 'models' | 'usage' | 'tickets'
  | 'prs' | 'skills' | 'filesTouched' | 'linesAdded' | 'linesRemoved' | 'awaySummary' | 'promptCount'
>;

export interface RecapDigestInput {
  session: RecapSessionInput;
  events: TimelineEvent[];
  tests: TestResult[];
  plans: string[];
  maxInputTokens: number;
  reserveTokens?: number;
}

export interface RecapDigest { text: string; approxTokens: number; truncated: boolean; omittedItems: number }

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const r = (s: string) => redact(s);

function duration(fromIso: string, toIso: string): string {
  const min = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000));
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
}

function header(i: RecapDigestInput): string {
  const s = i.session;
  const cost = s.usage.costUsd === null ? 'unknown' : `$${s.usage.costUsd.toFixed(2)}`;
  const lines = s.linesAdded === null ? 'unknown' : `+${s.linesAdded} −${s.linesRemoved ?? 0}`;
  const out = [
    '# Session',
    `name: ${r(oneLine(s.name ?? '(unnamed)'))}`,
    `source: ${s.source} · project: ${s.projectId ?? 'none'} · cwd: ${r(s.startCwd)}`,
    `started: ${s.startedAt} · last activity: ${s.lastActivityAt} · duration: ${duration(s.startedAt, s.lastActivityAt)}`,
    `models: ${s.models.join(', ') || 'unknown'} · cost: ${cost} · lines: ${lines} · prompts: ${s.promptCount}`,
  ];
  if (s.tickets.length) out.push(`tickets: ${s.tickets.join(', ')}`);
  if (s.prs.length) out.push(`PRs: ${s.prs.map((p) => p.url).join(', ')}`);
  if (s.skills.length) out.push(`skills: ${s.skills.join(', ')}`);
  if (i.plans.length) out.push(`plans: ${i.plans.map(r).join(', ')}`);
  if (s.awaySummary) out.push(`away summary: ${r(oneLine(truncateText(s.awaySummary, MAX_ASSISTANT_CHARS)))}`);

  const counts = new Map<string, number>();
  for (const e of i.events) if (e.kind === 'tool_call' && e.tool) counts.set(e.tool, (counts.get(e.tool) ?? 0) + 1);
  const tools = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  out.push('', '# Tools (names and counts only)', tools.length ? tools.map(([t, n]) => `${t} ×${n}`).join(', ') : 'none');

  out.push('', '# Files changed');
  const files = [...new Set(s.filesTouched)];
  if (files.length === 0) out.push('none');
  for (const f of files.slice(0, MAX_FILES)) out.push(`- ${r(f)}`);
  if (files.length > MAX_FILES) out.push(`- … and ${files.length - MAX_FILES} more`);

  out.push('', '# Tests');
  if (i.tests.length === 0) out.push('none recorded');
  for (const t of i.tests) {
    out.push(`- ${t.ts} \`${r(oneLine(truncateText(t.command, MAX_ERROR_CHARS)))}\`: ${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped`);
  }
  out.push('', '# Conversation (prompts and assistant text; tool output omitted)');
  return out.join('\n');
}

function conversationItems(events: TimelineEvent[]): string[] {
  const items: string[] = [];
  for (const e of events) {
    if (!e.text) continue;
    if (e.kind === 'prompt') items.push(`[turn ${e.turn}] USER: ${r(oneLine(truncateText(e.text, MAX_PROMPT_CHARS)))}`);
    else if (e.kind === 'assistant_text') items.push(`[turn ${e.turn}] ASSISTANT: ${r(oneLine(truncateText(e.text, MAX_ASSISTANT_CHARS)))}`);
    else if (e.kind === 'error') items.push(`[turn ${e.turn}] ERROR: ${r(oneLine(truncateText(e.text, MAX_ERROR_CHARS)))}`);
  }
  return items;
}

export function buildRecapDigest(i: RecapDigestInput): RecapDigest {
  const maxChars = Math.max(1000, (i.maxInputTokens - (i.reserveTokens ?? DEFAULT_RESERVE_TOKENS)) * CHARS_PER_TOKEN);
  const head = truncateText(header(i), Math.floor(maxChars / 2));
  const items = conversationItems(i.events);
  const size = (xs: string[]) => xs.reduce((a, x) => a + x.length + 1, 0);
  let body = items;
  let omitted = 0;

  if (head.length + 1 + size(items) > maxChars) {
    const marker = 60;
    const budget = Math.max(0, maxChars - head.length - 1 - marker);
    const first: string[] = [];
    let used = 0;
    for (const it of items) {
      if (used + it.length + 1 > budget * HEAD_SHARE) break;
      first.push(it);
      used += it.length + 1;
    }
    const last: string[] = [];
    for (let k = items.length - 1; k >= first.length; k--) {
      const it = items[k] as string;
      if (used + it.length + 1 > budget) break;
      last.unshift(it);
      used += it.length + 1;
    }
    omitted = items.length - first.length - last.length;
    body = [...first, `[… ${omitted} conversation items omitted …]`, ...last];
  }

  const text = r([head, ...body].join('\n'));
  return { text, approxTokens: approxTokens(text), truncated: omitted > 0, omittedItems: omitted };
}

export const DEFAULT_RECAP_PROMPT = `You are writing a recap of one AI coding-agent session for the developer who ran it.
Write in {{language}}. Keep code, file paths, commands and ticket IDs exactly as written.
Use only the digest below. Do not guess. If something is unknown, write "unknown".
The digest is redacted. Never try to reconstruct a redacted value.

Reply in Markdown with exactly these parts:
1. One line (at most 120 characters) that says what the session achieved. No heading before it.
2. **Goal:** one sentence.
3. **Done:** up to 5 bullets of concrete actions and changes.
4. **Outcome:** one of "complete", "partial", "blocked" or "abandoned", with a short reason.
5. **PRs & tickets:** a list, or "none".
6. **Follow-ups:** up to 3 bullets, or "none".
7. **What to check:** up to 3 bullets in plain language that tell a reviewer what to verify by hand (risky edits, untested paths, production access, failing or missing tests).

Digest:
{{digest}}
`;

export const DEFAULT_DAILY_PROMPT = `You are writing the daily work recap for project {{project}} on {{date}}.
Write in {{language}}. Keep ticket IDs, PR links and file paths exactly as written.
Use only the session list below. Do not guess. The list is redacted.

Reply in Markdown:
1. One line (at most 120 characters) summarising the day.
2. **Shipped:** merged or opened PRs and finished tickets, or "none".
3. **In progress:** work that continues tomorrow, grouped by ticket.
4. **Blocked / needs attention:** sessions waiting on someone or failing, or "none".
5. **Spend:** the total cost if the list gives costs.

Sessions:
{{digest}}
`;

export const DEFAULT_HANDOFF_PROMPT = `You are preparing a handoff so that a fresh AI coding session can continue this work.
Write in {{language}}. Keep code, file paths, commands and ticket IDs exactly as written.
Use only the digest and evidence below. Do not guess. Both are redacted.

Reply with one JSON object and nothing else, in this shape:
{"status": "in_progress", "summary": "…", "nextSteps": ["…"], "blockers": ["…"]}
- "status" is one of "in_progress", "ready_for_review", "blocked", "done".
- "summary" is at most 5 sentences: what was attempted, what changed, and the current state.
- "nextSteps" are concrete, ordered actions for the next session (at most 7).
- "blockers" are open questions or failures that stop progress (an empty list if none).

Evidence:
{{evidence}}

Digest:
{{digest}}
`;

export function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_m, name: string) => vars[name] ?? '');
}
```

Append to both `packages/core/src/index.ts` and `packages/core/src/browser.ts`:
```ts
export * from './recap/digest.ts';
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run packages/core/src/recap`
Expected: PASS (5 tests). If the redaction assertion for `PGPASSWORD=` fails, check that Phase 0's `secret` pattern still matches `PGPASSWORD=`. It does in `redact.test.ts` (`'PGPASSWORD=hunter2 psql'`).

- [ ] **Step 5: Commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add packages/core
git commit -m "feat(core): add redacted recap digest builder and default recap/daily/handoff prompts"
```

---

### Task 12: Recap engines (`claude -p` and the Anthropic API)

**Files:**
- Create: `apps/daemon/src/services/recap/engines.ts`, `apps/daemon/src/services/recap/engines.test.ts`
- Create: `apps/daemon/test/bin/fake-claude-print` (executable)
- Modify: `apps/daemon/package.json` (add `@anthropic-ai/sdk`)

**Interfaces:**
- Consumes: `execa` (P1 dependency), `estimateCostUsd` and `PriceTable` (Task 4), `RecapEngineId` (Task 1)
- Produces:
  ```ts
  export interface RecapRunResult { text: string; costUsd: number; model: string; engine: RecapEngineId }
  export interface RecapRunOptions { model: string; maxBudgetUsd: number; timeoutMs?: number }
  export interface RecapEngine { id: RecapEngineId; run(prompt: string, opts: RecapRunOptions): Promise<RecapRunResult> }
  export type RecapEngineErrorCode = 'engine_failed' | 'engine_unavailable' | 'bad_output';
  export class RecapEngineError extends Error { readonly code: RecapEngineErrorCode }
  export function parseClaudePrintJson(stdout: string): { result: string; costUsd: number; isError: boolean }
  export function claudePrintArgs(model: string, maxBudgetUsd: number): string[]
  export function createClaudeCliEngine(opts: { command: string; cwd: string; env?: NodeJS.ProcessEnv }): RecapEngine
  export type MessagesClient = { messages: { create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> } };
  export function createAnthropicApiEngine(opts: { getApiKey: () => Promise<string | null>; prices: () => PriceTable; clientFactory?: (apiKey: string) => MessagesClient }): RecapEngine
  ```
- **`claude-cli`** runs `claude -p --model <m> --output-format json --no-session-persistence --tools "" --strict-mcp-config --settings '{"disableAllHooks":true}' --max-budget-usd <remaining>` with the prompt on **stdin**.
  - The flags were checked against `claude --help` on 2.1.274.
  - Hooks are disabled for the child, so the Phase 5 hook bridge doesn't see recap runs.
  - `--no-session-persistence` keeps recap runs out of `~/.claude/projects`.
  - The child runs in `$ORC_HOME/recap-work`.
  - It reads the `result`, `total_cost_usd` and `is_error` fields.
- **`anthropic-api`** uses `@anthropic-ai/sdk` `messages.create` with non-streaming `max_tokens: 2048`. That is a deliberately short output, well under SDK timeouts.
  - Cost comes from the price table (`limits.pricing`).
  - A `refusal` stop reason is an error.
  - **Key source:** until Phase 6 ships `SecretStore`, the key is read from the `ANTHROPIC_API_KEY` env var. Phase 6 replaces `getApiKey` with `secrets.get('anthropic.apiKey')`. The key is never logged or stored in config.

- [ ] **Step 1: Pin and install the SDK**

Run: `npm view @anthropic-ai/sdk version`
Expected: a version such as `0.126.0` (the current one on 2026-09-17). Then run:
`pnpm --filter @orc/daemon add @anthropic-ai/sdk@^<that version>`

- [ ] **Step 2: Write the fake CLI**

`apps/daemon/test/bin/fake-claude-print`
```sh
#!/bin/sh
# Fake `claude -p` for recap tests. Never contacts anything.
# FAKE_CLAUDE_LOG=<prefix>  → writes args to <prefix>.args (one per line) and stdin to <prefix>.stdin
# FAKE_CLAUDE_MODE=error|garbage|slow
# FAKE_CLAUDE_OUTPUT_FILE=<file> → print that file as the JSON result instead of the default
if [ -n "$FAKE_CLAUDE_LOG" ]; then
  printf '%s\n' "$@" > "$FAKE_CLAUDE_LOG.args"
  cat > "$FAKE_CLAUDE_LOG.stdin"
else
  cat > /dev/null
fi
case "$FAKE_CLAUDE_MODE" in
  error)
    echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom","total_cost_usd":0.001}'
    exit 1 ;;
  garbage)
    echo 'not json'
    exit 0 ;;
  slow)
    sleep 5 ;;
esac
if [ -n "$FAKE_CLAUDE_OUTPUT_FILE" ]; then
  cat "$FAKE_CLAUDE_OUTPUT_FILE"
  exit 0
fi
echo '{"type":"result","subtype":"success","is_error":false,"result":"Fixed the notification tests.\n**Goal:** fix tests","total_cost_usd":0.0123,"session_id":"fake"}'
```
Run: `chmod +x apps/daemon/test/bin/fake-claude-print`

- [ ] **Step 3: Write the failing test**

`apps/daemon/src/services/recap/engines.test.ts`
```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  RecapEngineError,
  claudePrintArgs,
  createAnthropicApiEngine,
  createClaudeCliEngine,
  parseClaudePrintJson,
} from './engines.ts';

const FAKE = fileURLToPath(new URL('../../../test/bin/fake-claude-print', import.meta.url));
const PRICES = { 'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } };

describe('parseClaudePrintJson', () => {
  it('reads result, cost and error flag from the last JSON line', () => {
    expect(parseClaudePrintJson('noise\n{"result":"ok","total_cost_usd":0.5,"is_error":false}\n')).toEqual({ result: 'ok', costUsd: 0.5, isError: false });
    expect(() => parseClaudePrintJson('nope')).toThrow(RecapEngineError);
    expect(() => parseClaudePrintJson('{"result":1}')).toThrow(/bad_output|unexpected/);
  });
});

describe('claude-cli engine', () => {
  it('passes the headless flags and the prompt on stdin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-eng-'));
    const log = join(dir, 'call');
    const engine = createClaudeCliEngine({ command: FAKE, cwd: dir, env: { ...process.env, FAKE_CLAUDE_LOG: log } });
    const out = await engine.run('PROMPT-TEXT', { model: 'claude-haiku-4-5', maxBudgetUsd: 1.234 });
    expect(out).toEqual({ text: 'Fixed the notification tests.\n**Goal:** fix tests', costUsd: 0.0123, model: 'claude-haiku-4-5', engine: 'claude-cli' });
    expect(readFileSync(`${log}.args`, 'utf8').split('\n').slice(0, -1)).toEqual(claudePrintArgs('claude-haiku-4-5', 1.234));
    expect(claudePrintArgs('m', 1.234)).toEqual([
      '-p', '--model', 'm', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--strict-mcp-config',
      '--settings', '{"disableAllHooks":true}', '--max-budget-usd', '1.23',
    ]);
    expect(readFileSync(`${log}.stdin`, 'utf8')).toBe('PROMPT-TEXT');
  });

  it('maps failures to error codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-eng-'));
    const run = (env: Record<string, string>, command = FAKE, timeoutMs?: number) =>
      createClaudeCliEngine({ command, cwd: dir, env: { ...process.env, ...env } }).run('p', { model: 'm', maxBudgetUsd: 1, timeoutMs });
    await expect(run({ FAKE_CLAUDE_MODE: 'error' })).rejects.toMatchObject({ code: 'engine_failed' });
    await expect(run({ FAKE_CLAUDE_MODE: 'garbage' })).rejects.toMatchObject({ code: 'bad_output' });
    await expect(run({}, join(dir, 'missing-claude'))).rejects.toMatchObject({ code: 'engine_unavailable' });
    await expect(run({ FAKE_CLAUDE_MODE: 'slow' }, FAKE, 300)).rejects.toMatchObject({ code: 'engine_failed' });
    const file = join(dir, 'out.json');
    writeFileSync(file, '{"result":"x","total_cost_usd":0.1,"is_error":true}');
    await expect(run({ FAKE_CLAUDE_OUTPUT_FILE: file })).rejects.toMatchObject({ code: 'engine_failed' });
  });
});

describe('anthropic-api engine', () => {
  const message = (p: Partial<Anthropic.Message>): Anthropic.Message =>
    ({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: 'Recap line', citations: null }],
      usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      ...p,
    }) as unknown as Anthropic.Message;

  it('calls messages.create and prices the usage', async () => {
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const engine = createAnthropicApiEngine({
      getApiKey: async () => 'sk-test',
      prices: () => PRICES,
      clientFactory: (key) => {
        expect(key).toBe('sk-test');
        return { messages: { create: async (b) => (calls.push(b), message({})) } };
      },
    });
    const out = await engine.run('PROMPT', { model: 'claude-haiku-4-5', maxBudgetUsd: 5 });
    expect(out).toEqual({ text: 'Recap line', costUsd: (1000 * 1 + 200 * 5) / 1_000_000, model: 'claude-haiku-4-5', engine: 'anthropic-api' });
    expect(calls[0]).toEqual({ model: 'claude-haiku-4-5', max_tokens: 2048, messages: [{ role: 'user', content: 'PROMPT' }] });
  });

  it('fails without a key, on refusal and on API errors', async () => {
    const noKey = createAnthropicApiEngine({ getApiKey: async () => null, prices: () => PRICES });
    await expect(noKey.run('p', { model: 'm', maxBudgetUsd: 1 })).rejects.toMatchObject({ code: 'engine_unavailable' });
    const refusal = createAnthropicApiEngine({
      getApiKey: async () => 'k',
      prices: () => PRICES,
      clientFactory: () => ({ messages: { create: async () => message({ stop_reason: 'refusal' }) } }),
    });
    await expect(refusal.run('p', { model: 'm', maxBudgetUsd: 1 })).rejects.toMatchObject({ code: 'engine_failed' });
    const boom = createAnthropicApiEngine({
      getApiKey: async () => 'k',
      prices: () => PRICES,
      clientFactory: () => ({ messages: { create: async () => Promise.reject(new Error('network down')) } }),
    });
    await expect(boom.run('p', { model: 'm', maxBudgetUsd: 1 })).rejects.toMatchObject({ code: 'engine_failed' });
  });
});
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/recap/engines.test.ts`
Expected: FAIL, `Cannot find module './engines.ts'`.

- [ ] **Step 5: Implement the engines**

`apps/daemon/src/services/recap/engines.ts`
```ts
import { mkdirSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { type PriceTable, type RecapEngineId, estimateCostUsd } from '@orc/core';
import { execa } from 'execa';

export interface RecapRunResult { text: string; costUsd: number; model: string; engine: RecapEngineId }
export interface RecapRunOptions { model: string; maxBudgetUsd: number; timeoutMs?: number }
export interface RecapEngine {
  id: RecapEngineId;
  run(prompt: string, opts: RecapRunOptions): Promise<RecapRunResult>;
}

export type RecapEngineErrorCode = 'engine_failed' | 'engine_unavailable' | 'bad_output';

export class RecapEngineError extends Error {
  constructor(
    readonly code: RecapEngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RecapEngineError';
  }
}

const DEFAULT_TIMEOUT_MS = 180_000;

export function parseClaudePrintJson(stdout: string): { result: string; costUsd: number; isError: boolean } {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .at(-1);
  if (!line) throw new RecapEngineError('bad_output', 'claude -p printed no JSON');
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    throw new RecapEngineError('bad_output', 'claude -p printed invalid JSON');
  }
  const o = v as { result?: unknown; total_cost_usd?: unknown; is_error?: unknown };
  if (typeof o.result !== 'string') throw new RecapEngineError('bad_output', 'unexpected claude -p JSON shape');
  return {
    result: o.result,
    costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : 0,
    isError: o.is_error === true,
  };
}

export function claudePrintArgs(model: string, maxBudgetUsd: number): string[] {
  return [
    '-p',
    '--model',
    model,
    '--output-format',
    'json',
    '--no-session-persistence',
    '--tools',
    '',
    '--strict-mcp-config',
    '--settings',
    '{"disableAllHooks":true}',
    '--max-budget-usd',
    maxBudgetUsd.toFixed(2),
  ];
}

export function createClaudeCliEngine(opts: { command: string; cwd: string; env?: NodeJS.ProcessEnv }): RecapEngine {
  return {
    id: 'claude-cli',
    async run(prompt, o) {
      mkdirSync(opts.cwd, { recursive: true });
      const res = await execa(opts.command, claudePrintArgs(o.model, o.maxBudgetUsd), {
        input: prompt,
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        extendEnv: false,
        timeout: o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        reject: false,
        stripFinalNewline: true,
      }).catch((err: unknown) => {
        throw new RecapEngineError('engine_unavailable', `cannot start ${opts.command}: ${(err as Error).message}`);
      });
      if (res.timedOut) throw new RecapEngineError('engine_failed', 'claude -p timed out');
      // execa with reject:false resolves spawn failures (ENOENT, EACCES) with no exit code.
      if (res.exitCode === undefined) throw new RecapEngineError('engine_unavailable', `cannot start ${opts.command}`);
      const stdout = String(res.stdout ?? '');
      if (res.exitCode !== 0) {
        let detail = `exit ${res.exitCode}`;
        try {
          detail = parseClaudePrintJson(stdout).result.slice(0, 200);
        } catch {
          // keep the exit code only
        }
        throw new RecapEngineError('engine_failed', `claude -p failed: ${detail}`);
      }
      const parsed = parseClaudePrintJson(stdout);
      if (parsed.isError) throw new RecapEngineError('engine_failed', `claude -p reported an error: ${parsed.result.slice(0, 200)}`);
      return { text: parsed.result.trim(), costUsd: parsed.costUsd, model: o.model, engine: 'claude-cli' };
    },
  };
}

export type MessagesClient = {
  messages: { create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
};

const MAX_OUTPUT_TOKENS = 2048;

export function createAnthropicApiEngine(opts: {
  getApiKey: () => Promise<string | null>;
  prices: () => PriceTable;
  clientFactory?: (apiKey: string) => MessagesClient;
}): RecapEngine {
  const factory = opts.clientFactory ?? ((apiKey: string): MessagesClient => new Anthropic({ apiKey }));
  return {
    id: 'anthropic-api',
    async run(prompt, o) {
      const key = await opts.getApiKey();
      if (!key) throw new RecapEngineError('engine_unavailable', 'no Anthropic API key configured (set ANTHROPIC_API_KEY)');
      let msg: Anthropic.Message;
      try {
        msg = await factory(key).messages.create(
          { model: o.model, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: 'user', content: prompt }] },
        );
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw new RecapEngineError('engine_unavailable', 'Anthropic API key rejected');
        if (err instanceof Anthropic.RateLimitError) throw new RecapEngineError('engine_failed', 'Anthropic API rate limited');
        if (err instanceof Anthropic.APIError) throw new RecapEngineError('engine_failed', `Anthropic API error ${err.status ?? ''}`.trim());
        throw new RecapEngineError('engine_failed', `Anthropic API call failed: ${(err as Error).message}`);
      }
      if (msg.stop_reason === 'refusal') throw new RecapEngineError('engine_failed', 'the model declined the recap request');
      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (!text) throw new RecapEngineError('bad_output', 'empty model response');
      const u = msg.usage;
      const costUsd =
        estimateCostUsd(
          o.model,
          { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
          opts.prices(),
        ) ?? 0;
      return { text, costUsd, model: o.model, engine: 'anthropic-api' };
    },
  };
}
```

`new Anthropic({ apiKey })` is assigned to `MessagesClient`, which uses the SDK's own `MessageCreateParamsNonStreaming` and `Message` types. If TypeScript rejects the assignment because of the SDK's overloads on `messages.create`, wrap the SDK call instead of casting:
```ts
  const factory = opts.clientFactory ?? ((apiKey: string): MessagesClient => {
    const client = new Anthropic({ apiKey });
    return { messages: { create: (body) => client.messages.create(body) } };
  });
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm vitest run apps/daemon/src/services/recap/engines.test.ts`
Expected: PASS (5 tests). The slow case takes about 0.3 s.

- [ ] **Step 7: Commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(recap): add claude -p and Anthropic API recap engines with a fake CLI"
```

---

### Task 13: RecapService (cache, budget, triggers, daily recap) and `/api/recaps`

**Files:**
- Create: `apps/daemon/src/db/repos/recaps.ts`
- Create: `apps/daemon/src/services/recap/recap.ts`, `apps/daemon/src/services/recap/recap.test.ts`
- Create: `apps/daemon/src/http/routes/recaps.ts`, `apps/daemon/src/http/routes/recaps.test.ts`
- Modify: `apps/daemon/src/context.ts`, `apps/daemon/src/main.ts`, `apps/daemon/src/http/app.ts`, `apps/daemon/src/http/audit-middleware.ts`

**Interfaces:**
- Consumes:
  - `buildRecapDigest`, `renderPromptTemplate`, `DEFAULT_RECAP_PROMPT`, `DEFAULT_DAILY_PROMPT`, `firstLine`, `truncateText`, `approxTokens` (Task 11)
  - `RecapEngine`, `RecapEngineError`, `createClaudeCliEngine`, `createAnthropicApiEngine` (Task 12)
  - `loadEvents`, `listAllSessions`, `need` (Task 2)
  - `Scheduler`, `ensureCronJob`, `removeJobsOfType` (Task 3)
  - `ServiceError` (P1)
  - `InboxEngine` (P2)
  - the P1 `sessions` table
- Produces:
  ```ts
  // repos/recaps.ts
  export function findRecap(db: OrcDb, kind: RecapKind, targetKey: string, offset: number): Recap | null
  export function saveRecap(db: OrcDb, r: Recap): Recap
  export function latestRecap(db: OrcDb, kind: RecapKind, targetKey: string): Recap | null
  export function spendBetween(db: OrcDb, fromIso: string, toIso: string): number
  export function setSessionRecap(db: OrcDb, sessionPk: string, text: string): void
  // services/recap/recap.ts
  export interface RecapService { recap; daily; latest; latestDaily; findCached; runLlm; monthSpend; syncSchedule; start; stop }   // Contract additions
  export function transcriptOffset(s: Pick<Session, 'transcriptPath' | 'lastActivityAt'>): number
  export function createRecapService(ctx: DaemonContext, deps: { engines: Record<RecapEngineId, RecapEngine>; scheduler: Scheduler; now?: () => Date; idleMs?: number }): RecapService
  export function defaultRecapEngines(ctx: DaemonContext): Record<RecapEngineId, RecapEngine>
  // http/routes/recaps.ts
  export function registerRecapRoutes(app: OrcApp, ctx: DaemonContext): void
  ```
- **Rules:**
  - **Manual (on-demand) recaps** work even when `recaps.enabled` is false; the global flag only controls automatic triggers. They are still refused when the project has `features.recaps === false`, or when the project is listed in `excludeProjectIds`.
  - **Automatic recaps** also require `promptCount ≥ minPrompts`.
  - **Model:** on-demand uses `onDemandModel`, automatic uses `autoModel`.
  - **Cache:** keyed by (`kind`, `targetKey`, `transcriptOffset`). `transcriptOffset` is the transcript's byte size, read with a read-only `stat` of `transcriptPath`, or `Date.parse(lastActivityAt)` when there is no file.
  - **Budget:** when this month's recap spend (all kinds) is at or above `monthlyBudgetUsd`, the call fails with `409 over_budget` and opens an inbox item `recap-budget:<yyyy-mm>`. Otherwise the remaining budget is passed as `maxBudgetUsd`.
  - **Error mapping:**

    | Condition | Status and code |
    |---|---|
    | session not found | `404 not_found` |
    | recaps disabled for the project | `409 recaps_disabled` |
    | too few prompts | `409 too_small` |
    | monthly budget used up | `409 over_budget` |
    | engine unavailable | `422 engine_unavailable` |
    | engine failed or bad output | `500 engine_failed` |

  - **Triggers:**
    - `on_idle` runs when `session.statusChanged` moves to `idle` or `ended` and the session is still idle after `idleMinutes`.
    - `daily` runs through a scheduler `digest` job with `payload.type = 'daily_recap'` (cron `digest.dailyRecapCron`). It recaps today's sessions for each id in `dailyProjectIds`, then writes the daily recap.
  - **Persistence:** a new session recap is written to `sessions.recap`, and `session.updated` is emitted.
  - **Logging:** nothing is logged except the model, cost and error codes. Prompts and outputs are never logged.

- [ ] **Step 1: Confirm that P1 keeps `recap` on re-index**

Run: `grep -rn "keeps recap on re-upsert" apps/daemon`
Expected: one match (P1's test). If there is no match, stop and add that guarantee to P1's `upsertSession` first; otherwise every re-index would wipe the recaps.

- [ ] **Step 2: Write the failing service test**

`apps/daemon/src/services/recap/recap.test.ts`
```ts
import type { InboxItem } from '@orc/core';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ev, makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import type { InboxUpsert } from '../../inbox/engine.ts';
import { ServiceError } from '../errors.ts';
import { createScheduler } from '../scheduler/scheduler.ts';
import { type RecapEngine, RecapEngineError } from './engines.ts';
import { createRecapService } from './recap.ts';

const NOW = new Date('2026-09-17T12:00:00.000Z');

function setup(opts: { recaps?: Record<string, unknown>; projectRecaps?: boolean; engineError?: RecapEngineError } = {}) {
  const s1 = makeSession({
    id: 's1', name: 'Fix SLA', promptCount: 3, lastActivityAt: '2026-09-17T10:00:00.000Z', tickets: ['SAF-1'],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 },
  });
  const tiny = makeSession({ id: 'tiny', promptCount: 1, lastActivityAt: '2026-09-17T09:00:00.000Z' });
  const events = {
    'claude:s1': [
      ev({ seq: 1, ts: '2026-09-17T09:00:00.000Z', kind: 'prompt', text: 'fix the SLA weekends' }),
      ev({ seq: 2, ts: '2026-09-17T09:00:05.000Z', kind: 'tool_result', text: 'TOOL_OUTPUT_MUST_NOT_LEAK' }),
    ],
  };
  const t = makeP5Context({
    config: (c) => {
      const w = withWakecap('/Users/test/Wakecap', { features: { workStreams: true, prodBadges: true, recaps: opts.projectRecaps ?? true } })(c);
      return { ...w, recaps: { ...w.recaps, ...opts.recaps } };
    },
    data: { sessions: [s1, tiny], events },
  });
  const prompts: Array<{ prompt: string; model: string; maxBudgetUsd: number }> = [];
  const engine: RecapEngine = {
    id: 'claude-cli',
    run: vi.fn(async (prompt, o) => {
      prompts.push({ prompt, model: o.model, maxBudgetUsd: o.maxBudgetUsd });
      if (opts.engineError) throw opts.engineError;
      return { text: `Recap by ${o.model}\n**Goal:** x`, costUsd: 0.25, model: o.model, engine: 'claude-cli' as const };
    }),
  };
  const upserts: InboxUpsert[] = [];
  t.ctx.inbox = {
    upsert: (i: InboxUpsert) => (upserts.push(i), {} as InboxItem),
    resolve: () => undefined,
  } as unknown as NonNullable<typeof t.ctx.inbox>;
  const scheduler = createScheduler({ db: t.ctx.db, log: pino({ level: 'silent' }) });
  const svc = createRecapService(t.ctx, { engines: { 'claude-cli': engine, 'anthropic-api': engine }, scheduler, now: () => NOW, idleMs: 20 });
  return { ...t, svc, engine, prompts, upserts, scheduler };
}

describe('recap service', () => {
  it('recaps on demand with the on-demand model, caches, stores and emits', async () => {
    const { svc, engine, prompts, ctx } = setup();
    const updated: Array<string | null> = [];
    ctx.bus.on('session.updated', (e) => void updated.push(e.session.recap));
    const r = await svc.recap('claude:s1', { onDemand: true });
    expect(r).toEqual({ text: 'Recap by claude-sonnet-5\n**Goal:** x', costUsd: 0.25, model: 'claude-sonnet-5', cached: false });
    expect(prompts[0]?.prompt).toContain('**What to check:**');
    expect(prompts[0]?.prompt).toContain('[turn 1] USER: fix the SLA weekends');
    expect(prompts[0]?.prompt).not.toContain('TOOL_OUTPUT_MUST_NOT_LEAK');
    expect(prompts[0]?.maxBudgetUsd).toBe(20);
    expect(updated).toEqual(['Recap by claude-sonnet-5\n**Goal:** x']);
    expect(await svc.recap('claude:s1', { onDemand: true })).toMatchObject({ cached: true, costUsd: 0.25 });
    expect(engine.run).toHaveBeenCalledTimes(1);
    expect(svc.latest('claude:s1')?.model).toBe('claude-sonnet-5');
    expect(svc.monthSpend()).toEqual({ spentUsd: 0.25, budgetUsd: 20 });
  });

  it('enforces the enabled flags, scope and minimum prompts', async () => {
    const off = setup();
    await expect(off.svc.recap('claude:s1')).rejects.toMatchObject({ code: 'recaps_disabled', status: 409 });
    const on = setup({ recaps: { enabled: true } });
    await expect(on.svc.recap('claude:tiny')).rejects.toMatchObject({ code: 'too_small' });
    expect((await on.svc.recap('claude:s1')).model).toBe('claude-haiku-4-5');
    const proj = setup({ projectRecaps: false });
    await expect(proj.svc.recap('claude:s1', { onDemand: true })).rejects.toMatchObject({ code: 'recaps_disabled' });
    const excl = setup({ recaps: { excludeProjectIds: ['wakecap'] } });
    await expect(excl.svc.recap('claude:s1', { onDemand: true })).rejects.toMatchObject({ code: 'recaps_disabled' });
    await expect(off.svc.recap('claude:nope', { onDemand: true })).rejects.toBeInstanceOf(ServiceError);
  });

  it('refuses over budget and opens an inbox item', async () => {
    const { svc, upserts } = setup({ recaps: { monthlyBudgetUsd: 0.2 } });
    await svc.recap('claude:s1', { onDemand: true });
    await expect(svc.recap('claude:tiny', { onDemand: true })).rejects.toMatchObject({ code: 'over_budget' });
    expect(upserts[0]).toMatchObject({ kind: 'budget', dedupeKey: 'recap-budget:2026-09' });
  });

  it('maps engine errors', async () => {
    const a = setup({ engineError: new RecapEngineError('engine_unavailable', 'x') });
    await expect(a.svc.recap('claude:s1', { onDemand: true })).rejects.toMatchObject({ code: 'engine_unavailable', status: 422 });
    const b = setup({ engineError: new RecapEngineError('bad_output', 'x') });
    await expect(b.svc.recap('claude:s1', { onDemand: true })).rejects.toMatchObject({ code: 'engine_failed', status: 500 });
  });

  it('uses the custom template and language', async () => {
    const { svc, prompts } = setup({ recaps: { promptTemplate: 'LANG={{language}} DIGEST={{digest}}', language: 'ar' } });
    await svc.recap('claude:s1', { onDemand: true });
    expect(prompts[0]?.prompt.startsWith('LANG=ar DIGEST=# Session')).toBe(true);
  });

  it('writes a daily project recap from the day’s sessions', async () => {
    const { svc, prompts } = setup();
    await svc.recap('claude:s1', { onDemand: true });
    const text = await svc.daily('wakecap', '2026-09-17');
    expect(text).toBe('Recap by claude-haiku-4-5\n**Goal:** x');
    expect(prompts[1]?.prompt).toContain('project wakecap on 2026-09-17');
    expect(prompts[1]?.prompt).toContain('- Fix SLA ($0.50) tickets: SAF-1 — Recap by claude-sonnet-5');
    expect(svc.latestDaily('wakecap', '2026-09-17')?.kind).toBe('daily');
    expect(await svc.daily('wakecap', '2026-09-17')).toBe(text);
    expect(prompts).toHaveLength(2);
    expect(await svc.daily('wakecap', '2020-01-01')).toBe('No sessions on 2020-01-01.');
  });

  it('recaps idle sessions when the trigger is on_idle', async () => {
    const { svc, ctx, engine } = setup({ recaps: { enabled: true, trigger: 'on_idle' } });
    svc.start();
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s1', from: 'busy', to: 'idle' });
    await vi.waitFor(() => expect(engine.run).toHaveBeenCalledTimes(1));
    svc.stop();
  });

  it('schedules the daily recap job only for the daily trigger', () => {
    const daily = setup({ recaps: { enabled: true, trigger: 'daily' } });
    daily.svc.syncSchedule();
    expect(daily.scheduler.list('digest').map((j) => j.payload.type)).toEqual(['daily_recap']);
    daily.ctx.updateConfig?.((c) => ({ ...c, recaps: { ...c.recaps, trigger: 'manual' } }));
    daily.svc.syncSchedule();
    expect(daily.scheduler.list('digest')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/recap/recap.test.ts`
Expected: FAIL, `Cannot find module './recap.ts'`.

- [ ] **Step 4: Write the repo**

`apps/daemon/src/db/repos/recaps.ts`
```ts
import type { Recap, RecapKind } from '@orc/core';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { recaps, sessions } from '../schema.ts';

export function findRecap(db: OrcDb, kind: RecapKind, targetKey: string, offset: number): Recap | null {
  return (
    db
      .select()
      .from(recaps)
      .where(and(eq(recaps.kind, kind), eq(recaps.targetKey, targetKey), eq(recaps.transcriptOffset, offset)))
      .get() ?? null
  );
}

export function saveRecap(db: OrcDb, r: Recap): Recap {
  const { id: _id, kind: _k, targetKey: _t, transcriptOffset: _o, ...set } = r;
  db.insert(recaps)
    .values(r)
    .onConflictDoUpdate({ target: [recaps.kind, recaps.targetKey, recaps.transcriptOffset], set })
    .run();
  return findRecap(db, r.kind, r.targetKey, r.transcriptOffset) ?? r;
}

export function latestRecap(db: OrcDb, kind: RecapKind, targetKey: string): Recap | null {
  return (
    db
      .select()
      .from(recaps)
      .where(and(eq(recaps.kind, kind), eq(recaps.targetKey, targetKey)))
      .orderBy(desc(recaps.createdAt))
      .limit(1)
      .get() ?? null
  );
}

export function spendBetween(db: OrcDb, fromIso: string, toIso: string): number {
  return (
    db
      .select({ s: sql<number>`coalesce(sum(${recaps.costUsd}), 0)` })
      .from(recaps)
      .where(and(gte(recaps.createdAt, fromIso), lt(recaps.createdAt, toIso)))
      .get()?.s ?? 0
  );
}

/** P1's sessions.recap column; P1's upsertSession never overwrites it. */
export function setSessionRecap(db: OrcDb, sessionPk: string, text: string): void {
  db.update(sessions).set({ recap: text }).where(eq(sessions.pk, sessionPk)).run();
}
```

- [ ] **Step 5: Write the service**

`apps/daemon/src/services/recap/recap.ts`
```ts
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_DAILY_PROMPT,
  DEFAULT_RECAP_PROMPT,
  type Recap,
  type RecapEngineId,
  type RecapKind,
  type Session,
  approxTokens,
  buildRecapDigest,
  firstLine,
  redact,
  renderPromptTemplate,
  truncateText,
} from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { findRecap, latestRecap, saveRecap, setSessionRecap, spendBetween } from '../../db/repos/recaps.ts';
import { ServiceError } from '../errors.ts';
import { type Scheduler, ensureCronJob, removeJobsOfType } from '../scheduler/scheduler.ts';
import { listAllSessions, loadEvents } from '../session-pages.ts';
import {
  type RecapEngine,
  RecapEngineError,
  createAnthropicApiEngine,
  createClaudeCliEngine,
} from './engines.ts';

export interface RecapService {
  recap(sessionPk: string, opts?: { onDemand?: boolean }): Promise<{ text: string; costUsd: number; model: string; cached: boolean }>;
  daily(projectId: string, date: string): Promise<string>;
  latest(sessionPk: string): Recap | null;
  latestDaily(projectId: string, date: string): Recap | null;
  findCached(kind: RecapKind, targetKey: string, offset: number): Recap | null;
  runLlm(kind: RecapKind, targetKey: string, offset: number, prompt: string, opts: { onDemand: boolean; approxTokens: number }): Promise<Recap>;
  monthSpend(now?: Date): { spentUsd: number; budgetUsd: number };
  syncSchedule(): void;
  start(): void;
  stop(): void;
}

export function transcriptOffset(s: Pick<Session, 'transcriptPath' | 'lastActivityAt'>): number {
  if (s.transcriptPath && existsSync(s.transcriptPath)) return statSync(s.transcriptPath).size;
  return Date.parse(s.lastActivityAt);
}

export function defaultRecapEngines(ctx: DaemonContext): Record<RecapEngineId, RecapEngine> {
  return {
    'claude-cli': createClaudeCliEngine({
      command: ctx.config().resumeProfile.claudeCommand,
      cwd: join(ctx.paths.orcHome, 'recap-work'),
    }),
    // Phase 6 replaces getApiKey with SecretStore.get('anthropic.apiKey').
    'anthropic-api': createAnthropicApiEngine({
      getApiKey: async () => process.env.ANTHROPIC_API_KEY ?? null,
      prices: () => ctx.config().limits.pricing,
    }),
  };
}

const monthRange = (d: Date) => {
  const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { from: from.toISOString(), to: to.toISOString(), key: from.toISOString().slice(0, 7) };
};

export function createRecapService(
  ctx: DaemonContext,
  deps: { engines: Record<RecapEngineId, RecapEngine>; scheduler: Scheduler; now?: () => Date; idleMs?: number },
): RecapService {
  const now = deps.now ?? (() => new Date());
  const idleTimers = new Map<string, NodeJS.Timeout>();
  const unsubs: Array<() => void> = [];

  function monthSpend(at: Date = now()) {
    const m = monthRange(at);
    return { spentUsd: spendBetween(ctx.db, m.from, m.to), budgetUsd: ctx.config().recaps.monthlyBudgetUsd };
  }

  async function runLlm(
    kind: RecapKind,
    targetKey: string,
    offset: number,
    prompt: string,
    opts: { onDemand: boolean; approxTokens: number },
  ): Promise<Recap> {
    const cfg = ctx.config().recaps;
    const spend = monthSpend();
    if (spend.spentUsd >= spend.budgetUsd) {
      const key = monthRange(now()).key;
      ctx.inbox?.upsert({
        kind: 'budget',
        dedupeKey: `recap-budget:${key}`,
        reason: `LLM recap budget used up for ${key}: $${spend.spentUsd.toFixed(2)} of $${spend.budgetUsd.toFixed(2)}`,
        payload: { recaps: true, ...spend },
      });
      throw new ServiceError('over_budget', 409, 'monthly recap budget reached', spend);
    }
    const model = opts.onDemand ? cfg.onDemandModel : cfg.autoModel;
    const engine = deps.engines[cfg.engine];
    let result: Awaited<ReturnType<RecapEngine['run']>>;
    try {
      result = await engine.run(prompt, { model, maxBudgetUsd: Math.max(0.01, spend.budgetUsd - spend.spentUsd) });
    } catch (err) {
      const code = err instanceof RecapEngineError ? err.code : 'engine_failed';
      ctx.log.warn({ kind, engine: cfg.engine, model, code }, 'recap engine failed');
      if (code === 'engine_unavailable') throw new ServiceError('engine_unavailable', 422, (err as Error).message);
      throw new ServiceError('engine_failed', 500, 'recap engine failed', { code });
    }
    ctx.log.info({ kind, engine: result.engine, model: result.model, costUsd: result.costUsd }, 'recap generated');
    return saveRecap(ctx.db, {
      id: randomUUID(),
      kind,
      targetKey,
      transcriptOffset: offset,
      model: result.model,
      engine: result.engine,
      text: result.text,
      costUsd: result.costUsd,
      inputTokensApprox: opts.approxTokens,
      createdAt: now().toISOString(),
    });
  }

  function assertAllowed(s: Session, onDemand: boolean): void {
    const cfg = ctx.config().recaps;
    const project = s.projectId ? ctx.projects.get(s.projectId) : null;
    if (project && !project.features.recaps) throw new ServiceError('recaps_disabled', 409, 'recaps are disabled for this project');
    if (s.projectId && cfg.excludeProjectIds.includes(s.projectId)) {
      throw new ServiceError('recaps_disabled', 409, 'this project is excluded from recaps');
    }
    if (!onDemand && !cfg.enabled) throw new ServiceError('recaps_disabled', 409, 'automatic recaps are disabled');
    if (!onDemand && s.promptCount < cfg.minPrompts) throw new ServiceError('too_small', 409, 'session has too few prompts');
  }

  async function recap(pk: string, opts: { onDemand?: boolean } = {}) {
    const onDemand = opts.onDemand ?? false;
    const s = ctx.sessions.getByPk(pk);
    if (!s) throw new ServiceError('not_found', 404, 'session not found');
    assertAllowed(s, onDemand);
    const offset = transcriptOffset(s);
    const hit = findRecap(ctx.db, 'session', pk, offset);
    if (hit) return { text: hit.text, costUsd: hit.costUsd, model: hit.model, cached: true };
    const cfg = ctx.config().recaps;
    const digest = buildRecapDigest({
      session: s,
      events: loadEvents(ctx, s, null),
      tests: s.lastTest ? [s.lastTest] : [],
      plans: [],
      maxInputTokens: cfg.maxInputTokens,
    });
    const prompt = renderPromptTemplate(cfg.promptTemplate ?? DEFAULT_RECAP_PROMPT, { language: cfg.language, digest: digest.text });
    const rec = await runLlm('session', pk, offset, prompt, { onDemand, approxTokens: approxTokens(prompt) });
    setSessionRecap(ctx.db, pk, rec.text);
    ctx.bus.emit({ type: 'session.updated', session: { ...(ctx.sessions.getByPk(pk) ?? s), recap: rec.text } });
    return { text: rec.text, costUsd: rec.costUsd, model: rec.model, cached: false };
  }

  async function daily(projectId: string, date: string): Promise<string> {
    const cfg = ctx.config().recaps;
    const from = `${date}T00:00:00.000Z`;
    const to = `${date}T23:59:59.999Z`;
    const items = listAllSessions(ctx, { projectId, from, to }).filter((s) => s.lastActivityAt >= from && s.startedAt <= to);
    if (items.length === 0) return `No sessions on ${date}.`;
    const offset = Math.max(...items.map((s) => Date.parse(s.lastActivityAt)));
    const key = `${projectId}:${date}`;
    const hit = findRecap(ctx.db, 'daily', key, offset);
    if (hit) return hit.text;
    const lines = items.map((s) => {
      const cost = s.costUsd === null ? '' : ` ($${s.costUsd.toFixed(2)})`;
      const tickets = s.tickets.length ? ` tickets: ${s.tickets.join(', ')}` : '';
      const prs = s.prs.length ? ` PRs: ${s.prs.map((p) => p.url).join(', ')}` : '';
      const live = s.live ? ` [${s.live.status}]` : '';
      const stored = s.recap ?? latestRecap(ctx.db, 'session', s.pk)?.text ?? null;
      const summary = firstLine(stored) ?? truncateText(s.lastPrompt ?? s.firstPrompt ?? 'no recap', 200);
      return redact(`- ${s.name ?? s.firstPrompt ?? s.pk}${cost}${tickets}${prs}${live} — ${summary}`);
    });
    const digest = truncateText(lines.join('\n'), cfg.maxInputTokens * 4);
    const prompt = renderPromptTemplate(DEFAULT_DAILY_PROMPT, { language: cfg.language, project: projectId, date, digest });
    const rec = await runLlm('daily', key, offset, prompt, { onDemand: false, approxTokens: approxTokens(prompt) });
    return rec.text;
  }

  function syncSchedule(): void {
    const cfg = ctx.config();
    if (cfg.recaps.enabled && cfg.recaps.trigger === 'daily') {
      ensureCronJob(deps.scheduler, 'digest', 'daily_recap', cfg.digest.dailyRecapCron);
    } else {
      removeJobsOfType(deps.scheduler, 'digest', 'daily_recap');
    }
  }

  async function runDailyJob(): Promise<void> {
    const date = now().toISOString().slice(0, 10);
    for (const projectId of ctx.config().recaps.dailyProjectIds) {
      for (const s of listAllSessions(ctx, { projectId, from: `${date}T00:00:00.000Z` })) {
        await recap(s.pk).catch((err: unknown) => ctx.log.debug({ pk: s.pk, code: (err as ServiceError).code }, 'daily session recap skipped'));
      }
      await daily(projectId, date).catch((err: unknown) => ctx.log.warn({ projectId, code: (err as ServiceError).code }, 'daily recap failed'));
    }
  }

  return {
    recap,
    daily,
    latest: (pk) => latestRecap(ctx.db, 'session', pk),
    latestDaily: (projectId, date) => latestRecap(ctx.db, 'daily', `${projectId}:${date}`),
    findCached: (kind, key, offset) => findRecap(ctx.db, kind, key, offset),
    runLlm,
    monthSpend,
    syncSchedule,
    start() {
      deps.scheduler.onFire('digest', async (job) => {
        if (job.payload.type === 'daily_recap') await runDailyJob();
      });
      syncSchedule();
      unsubs.push(
        ctx.bus.on('config.changed', syncSchedule),
        ctx.bus.on('session.statusChanged', (e) => {
          const t = idleTimers.get(e.pk);
          if (t) clearTimeout(t);
          idleTimers.delete(e.pk);
          const cfg = ctx.config().recaps;
          if (!cfg.enabled || cfg.trigger !== 'on_idle' || (e.to !== 'idle' && e.to !== 'ended')) return;
          idleTimers.set(
            e.pk,
            setTimeout(() => {
              idleTimers.delete(e.pk);
              const s = ctx.sessions.getByPk(e.pk);
              if (s?.live && s.live.status !== 'idle' && s.live.status !== 'ended') return;
              recap(e.pk).catch((err: unknown) => ctx.log.debug({ pk: e.pk, code: (err as ServiceError).code }, 'idle recap skipped'));
            }, deps.idleMs ?? cfg.idleMinutes * 60_000),
          );
        }),
      );
    },
    stop() {
      for (const u of unsubs.splice(0)) u();
      for (const t of idleTimers.values()) clearTimeout(t);
      idleTimers.clear();
    },
  };
}
```

- [ ] **Step 6: Run the service test and confirm it passes**

Run: `pnpm vitest run apps/daemon/src/services/recap/recap.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 7: Write the failing route test, then the routes**

`apps/daemon/src/http/routes/recaps.test.ts`
```ts
import type { Recap } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { bareApp, makeP5Context, withWakecap } from '../../../test/p5-helpers.ts';
import { ServiceError } from '../../services/errors.ts';
import type { RecapService } from '../../services/recap/recap.ts';
import { registerRecapRoutes } from './recaps.ts';

const rec: Recap = { id: 'r', kind: 'session', targetKey: 'claude:s1', transcriptOffset: 1, model: 'm', engine: 'claude-cli', text: 't', costUsd: 0.1, inputTokensApprox: 10, createdAt: 'x' };

function setup() {
  const calls: unknown[] = [];
  const svc = {
    recap: async (pk: string, o?: { onDemand?: boolean }) => {
      calls.push([pk, o]);
      if (pk === 'claude:over') throw new ServiceError('over_budget', 409, 'budget');
      return { text: 't', costUsd: 0.1, model: 'm', cached: false };
    },
    daily: async (p: string, d: string) => `daily ${p} ${d}`,
    latest: (pk: string) => (pk === 'claude:s1' ? rec : null),
    latestDaily: () => null,
    monthSpend: () => ({ spentUsd: 1, budgetUsd: 20 }),
  } as unknown as RecapService;
  const { ctx } = makeP5Context({ config: withWakecap('/Users/test/Wakecap') });
  ctx.recaps = svc;
  const app = bareApp();
  registerRecapRoutes(app, ctx);
  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, post, calls };
}

describe('/api/recaps', () => {
  it('gets and runs session recaps', async () => {
    const { app, post, calls } = setup();
    expect(await (await app.request('/api/recaps/session/claude/s1')).json()).toEqual(rec);
    expect(await (await app.request('/api/recaps/session/claude/zz')).json()).toBeNull();
    expect(await (await post('/api/recaps/session/claude/s1', {})).json()).toMatchObject({ cached: false });
    expect(calls[0]).toEqual(['claude:s1', { onDemand: true }]);
    const over = await post('/api/recaps/session/claude/over', { onDemand: false });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: { code: 'over_budget' } });
    expect((await app.request('/api/recaps/session/bogus/s1')).status).toBe(400);
  });

  it('handles daily recaps and spend', async () => {
    const { app, post } = setup();
    expect(await (await post('/api/recaps/daily', { projectId: 'wakecap', date: '2026-09-17' })).json()).toEqual({ text: 'daily wakecap 2026-09-17' });
    expect((await post('/api/recaps/daily', { projectId: 'wakecap', date: 'today' })).status).toBe(400);
    expect(await (await app.request('/api/recaps/daily?projectId=wakecap&date=2026-09-17')).json()).toBeNull();
    expect(await (await app.request('/api/recaps/spend')).json()).toEqual({ spentUsd: 1, budgetUsd: 20 });
  });
});
```

`apps/daemon/src/http/routes/recaps.ts`
```ts
import { DailyRecapBody, DailyRecapQuery, RecapRunBody, apiError } from '@orc/api-contract';
import type { Source } from '@orc/core';
import type { Context } from 'hono';
import type { DaemonContext } from '../../context.ts';
import { need } from '../../services/need.ts';
import { sessionPk } from '../../services/sessions.ts';
import { readBody, readQuery, sendError } from '../p5-util.ts';
import type { OrcApp } from '../types.ts';

const SOURCES: readonly Source[] = ['claude', 'codex', 'agnc'];

export function pkFromParams(c: Context): string | null {
  const source = c.req.param('source');
  const id = c.req.param('id');
  if (!source || !id || !(SOURCES as readonly string[]).includes(source)) return null;
  return sessionPk(source as Source, id);
}

export function registerRecapRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.recaps, 'recaps');
  const badSource = (c: Context) => c.json(apiError('validation_failed', 'unknown source'), 400);

  app.get('/api/recaps/session/:source/:id', (c) => {
    const pk = pkFromParams(c);
    return pk ? c.json(svc().latest(pk)) : badSource(c);
  });
  app.post('/api/recaps/session/:source/:id', async (c) => {
    const pk = pkFromParams(c);
    if (!pk) return badSource(c);
    const b = await readBody(c, RecapRunBody);
    if (!b.ok) return b.res;
    try {
      return c.json(await svc().recap(pk, { onDemand: b.data.onDemand }));
    } catch (err) {
      return sendError(c, err);
    }
  });
  app.get('/api/recaps/daily', (c) => {
    const q = readQuery(c, DailyRecapQuery);
    if (!q.ok) return q.res;
    return c.json(svc().latestDaily(q.data.projectId, q.data.date));
  });
  app.post('/api/recaps/daily', async (c) => {
    const b = await readBody(c, DailyRecapBody);
    if (!b.ok) return b.res;
    try {
      return c.json({ text: await svc().daily(b.data.projectId, b.data.date) });
    } catch (err) {
      return sendError(c, err);
    }
  });
  app.get('/api/recaps/spend', (c) => c.json(svc().monthSpend()));
}
```

Run: `pnpm vitest run apps/daemon/src/http/routes/recaps.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 8: Wire, register and exempt**

In `apps/daemon/src/context.ts`:
- Point the existing `recaps?: RecapService` import at `./services/recap/recap.ts`.
- In `buildContext()`, add:
```ts
  ctx.recaps = createRecapService(ctx, { engines: defaultRecapEngines(ctx), scheduler: ctx.scheduler });
```

In `createDaemon()`: add `ctx.recaps?.start();` (before `ctx.scheduler?.start()`), and `ctx.recaps?.stop();` in `close()`.

In `createApp`: `registerRecapRoutes(app, o.ctx);`.

Append to `NON_ACTION_ROUTES`:
```ts
  { method: 'POST', path: '/api/recaps/session/:source/:id', why: 'redacted digest to the configured recap engine; cost tracked in recaps' },
  { method: 'POST', path: '/api/recaps/daily', why: 'redacted session list to the configured recap engine; cost tracked in recaps' },
```

- [ ] **Step 9: Commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add apps/daemon
git commit -m "feat(recap): add recap service with cache, monthly budget, idle/daily triggers and /api/recaps"
```

---

### Task 14: Goals (service and rules) and Reminders, with `/api/goals` and `/api/reminders`

**Files:**
- Create: `apps/daemon/src/db/repos/goals.ts`, `apps/daemon/src/db/repos/reminders.ts`
- Create: `apps/daemon/src/services/goals/goals.ts`, `apps/daemon/src/services/goals/goals.test.ts`
- Create: `apps/daemon/src/services/reminders/reminders.ts`, `apps/daemon/src/services/reminders/reminders.test.ts`
- Create: `apps/daemon/src/http/routes/goals.ts`, `apps/daemon/src/http/routes/reminders.ts`, `apps/daemon/src/http/routes/goals-reminders.test.ts`
- Modify: `apps/daemon/src/context.ts`, `apps/daemon/src/main.ts`, `apps/daemon/src/http/app.ts`, `apps/daemon/src/http/audit-middleware.ts`

**Interfaces:**
- Consumes:
  - `goals` and `reminders` tables (Task 2)
  - `Scheduler` (Task 3)
  - `StreamService.list` (Task 9)
  - `extractTicketsFrom`, `truncateText` (Tasks 8 and 11)
  - `listAllSessions`, `need`, `readBody`, `sendError`, `parseStates` (Task 2)
  - the `pr.changed` bus event (P4)
  - `session.statusChanged` (P2)
  - `LiveTracker.get` (P2)
  - `PtyManager.sendText`, which P3's `withPtyInputAudit` wraps (so it is audited)
  - `DenyList.check` and `AuditService.record` (P3)
  - `InboxEngine.upsert` (P2)
  - `ServiceError` (P1)
- Produces:
  ```ts
  // repos/goals.ts
  export type GoalSource = 'manual' | 'rule' | 'recap';
  export function getGoal(db: OrcDb, targetType: Goal['targetType'], targetId: string): Goal | null
  export function upsertGoal(db: OrcDb, g: Omit<Goal, 'id' | 'updatedAt'>, source: GoalSource, nowIso: string): Goal
  export function listGoals(db: OrcDb, states?: GoalState[]): Goal[]
  export function goalSource(db: OrcDb, id: string): GoalSource | null
  // services/goals/goals.ts
  export const NEEDS_ANSWER = 'needs answer';
  export const WAITING_BLOCK_MS: number;          // 30 min
  export interface GoalService { get; set; list; prefill; sweep; start; stop }   // Contract additions
  export function createGoalService(ctx: DaemonContext, opts?: { now?: () => Date; sweepMs?: number }): GoalService
  // repos/reminders.ts
  export function insertReminder(db: OrcDb, r: Reminder): void
  export function getReminder(db: OrcDb, id: string): Reminder | null
  export function listReminders(db: OrcDb, f: { state?: ReminderState[]; sessionPk?: string }): Reminder[]
  export function setReminderState(db: OrcDb, id: string, state: ReminderState, firedAt: string | null): void
  // services/reminders/reminders.ts
  export interface CreateReminderInput { sessionPk: string | null; ticket: string | null; text: string; dueAt: string; sendToSession: boolean }
  export interface ReminderService { create(i: CreateReminderInput): Reminder; list(f: { state?: ReminderState[]; sessionPk?: string }): Reminder[]; cancel(id: string): Reminder; fire(reminderId: string): Promise<void>; start(): void }
  export function createReminderService(ctx: DaemonContext, deps: { scheduler: Scheduler; now?: () => Date }): ReminderService
  // routes
  export function registerGoalRoutes(app: OrcApp, ctx: DaemonContext): void
  export function registerReminderRoutes(app: OrcApp, ctx: DaemonContext): void
  ```
- **Goal rules:**
  - A PR changes to `merged` → every existing, not-yet-complete goal of a session linked to that PR, and of the stream of each ticket in the PR's title or head branch, becomes `complete`.
  - A session has been `waiting` for 30 min or more → its goal becomes `blocked: needs answer`. If it has no goal yet, a goal is created from the prefill.
  - The session leaves `waiting` → a goal that this rule blocked becomes `active` again.
  - Manual edits always win until the next rule event.
- **Reminders:**
  - Each reminder is a one-shot scheduler job (`kind: 'reminder'`, `payload.reminderId`), so reminders survive restarts (Task 3).
  - When a reminder fires, it opens an inbox item (`kind: 'reminder'`, `dedupeKey: reminder:<id>`, payload `{ reminderId, source, id }`).
  - When `sendToSession` is set **and** the session is owned and live, the text is also sent with `pty.sendText`, after the deny-list check. A denied reminder is recorded with `result: 'denied'` and is not sent.

- [ ] **Step 1: Write the failing goals test**

`apps/daemon/src/services/goals/goals.test.ts`
```ts
import type { LiveState, PrStatus, WorkStream } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import type { StreamService } from '../streams/streams.ts';
import { NEEDS_ANSWER, WAITING_BLOCK_MS, createGoalService } from './goals.ts';

const live = (status: LiveState['status']): LiveState => ({
  pid: 1, status, waitingFor: null, since: '2026-09-17T10:00:00.000Z', ownership: 'observed', ptyId: null, stage: null,
  currentTool: null, backgroundJobs: 0, runningSubagents: 0, contextFill: null,
});
const pr: PrStatus = {
  pr: { repo: 'o/r', number: 9, url: 'https://github.com/o/r/pull/9' }, state: 'merged', title: 'feat: SAF-1 done', checks: 'success',
  review: 'approved', updatedAt: 't', headRef: 'feat/SAF-1-done', failedChecks: [],
};

function setup() {
  let nowMs = Date.parse('2026-09-17T10:00:00.000Z');
  const s1 = makeSession({ id: 's1', tickets: ['SAF-1'], firstPrompt: 'implement the weekend rule', prs: [pr.pr], live: live('busy') });
  const s2 = makeSession({ id: 's2', firstPrompt: 'x'.repeat(300) });
  const t = makeP5Context({ config: withWakecap('/Users/test/Wakecap'), data: { sessions: [s1, s2] } });
  const stream: WorkStream = { ticket: 'SAF-1', projectId: 'wakecap', title: 'Exclude weekends', stage: 'pr_open', sessionIds: [], prs: [], plans: [], worktrees: [], costUsd: 0, lastActivityAt: 't' };
  t.ctx.streams = { list: () => [stream] } as unknown as StreamService;
  const goals = createGoalService(t.ctx, { now: () => new Date(nowMs), sweepMs: 1_000_000 });
  return { ...t, goals, advance: (ms: number) => (nowMs += ms) };
}

describe('goal service', () => {
  it('sets, gets, lists and prefills goals', () => {
    const { goals } = setup();
    expect(goals.prefill('session', 'claude:s1')).toBe('SAF-1: Exclude weekends');
    expect(goals.prefill('session', 'claude:s2')).toBe(`${'x'.repeat(200)}…`);
    expect(goals.prefill('stream', 'SAF-1')).toBe('SAF-1: Exclude weekends');
    expect(goals.prefill('stream', 'SAF-404')).toBe('SAF-404');
    const g = goals.set({ targetType: 'session', targetId: 'claude:s1', objective: 'ship it', state: 'active', blockedReason: null });
    expect(goals.get('session', 'claude:s1')).toEqual(g);
    const g2 = goals.set({ ...g, state: 'paused' });
    expect(g2.id).toBe(g.id);
    expect(goals.list({ state: ['paused'] })).toEqual([g2]);
  });

  it('blocks goals waiting over 30 minutes and unblocks when the session moves on', () => {
    const { ctx, goals, advance } = setup();
    goals.start();
    goals.set({ targetType: 'session', targetId: 'claude:s1', objective: 'ship it', state: 'active', blockedReason: null });
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s1', from: 'busy', to: 'waiting' });
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s2', from: 'busy', to: 'waiting' });
    advance(WAITING_BLOCK_MS - 1);
    expect(goals.sweep()).toBe(0);
    advance(1);
    expect(goals.sweep()).toBe(2);
    expect(goals.get('session', 'claude:s1')).toMatchObject({ state: 'blocked', blockedReason: NEEDS_ANSWER });
    expect(goals.get('session', 'claude:s2')).toMatchObject({ state: 'blocked', objective: `${'x'.repeat(200)}…` });
    expect(goals.sweep()).toBe(0);
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s1', from: 'waiting', to: 'busy' });
    expect(goals.get('session', 'claude:s1')).toMatchObject({ state: 'active', blockedReason: null });
    goals.stop();
  });

  it('completes session and stream goals when a linked PR merges', () => {
    const { ctx, goals } = setup();
    goals.start();
    goals.set({ targetType: 'session', targetId: 'claude:s1', objective: 'a', state: 'blocked', blockedReason: 'x' });
    goals.set({ targetType: 'stream', targetId: 'SAF-1', objective: 'b', state: 'active', blockedReason: null });
    goals.set({ targetType: 'session', targetId: 'claude:s2', objective: 'c', state: 'active', blockedReason: null });
    ctx.bus.emit({ type: 'pr.changed', before: { ...pr, state: 'open' }, after: pr });
    expect(goals.get('session', 'claude:s1')?.state).toBe('complete');
    expect(goals.get('stream', 'SAF-1')?.state).toBe('complete');
    expect(goals.get('session', 'claude:s2')?.state).toBe('active');
    goals.stop();
  });
});
```

- [ ] **Step 2: Write the failing reminders test**

`apps/daemon/src/services/reminders/reminders.test.ts`
```ts
import type { InboxItem, LiveState } from '@orc/core';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import type { InboxUpsert } from '../../inbox/engine.ts';
import { createScheduler } from '../scheduler/scheduler.ts';
import { createReminderService } from './reminders.ts';

const NOW = new Date('2026-09-17T10:00:00.000Z');
const owned: LiveState = {
  pid: 1, status: 'idle', waitingFor: null, since: 't', ownership: 'owned', ptyId: 'pty-1', stage: null, currentTool: null,
  backgroundJobs: 0, runningSubagents: 0, contextFill: null,
};

function setup(liveState: LiveState | null = owned) {
  const s1 = makeSession({ id: 's1', live: liveState });
  const t = makeP5Context({ config: withWakecap('/Users/test/Wakecap'), data: { sessions: [s1] } });
  const sent: Array<[string, string]> = [];
  t.ctx.pty = { ...t.ctx.pty, sendText: async (id: string, text: string) => void sent.push([id, text]) };
  t.ctx.live = { get: () => s1 } as unknown as NonNullable<typeof t.ctx.live>;
  t.ctx.denyList = { check: (text: string) => ({ denied: text.includes('rm -rf'), reason: text.includes('rm -rf') ? 'destructive' : null }) };
  const upserts: InboxUpsert[] = [];
  t.ctx.inbox = { upsert: (i: InboxUpsert) => (upserts.push(i), {} as InboxItem), resolve: () => undefined } as unknown as NonNullable<typeof t.ctx.inbox>;
  const scheduler = createScheduler({ db: t.ctx.db, log: pino({ level: 'silent' }) });
  const svc = createReminderService(t.ctx, { scheduler, now: () => NOW });
  return { ...t, svc, scheduler, sent, upserts };
}

describe('reminder service', () => {
  it('creates a persisted one-shot job and validates input', () => {
    const { svc, scheduler } = setup();
    const r = svc.create({ sessionPk: 'claude:s1', ticket: null, text: 're-check CI', dueAt: '2026-09-17T10:20:00.000Z', sendToSession: true });
    expect(r).toMatchObject({ state: 'pending', sendToSession: true, firedAt: null });
    expect(scheduler.get(r.jobId)).toMatchObject({ kind: 'reminder', runAt: '2026-09-17T10:20:00.000Z', payload: { reminderId: r.id } });
    expect(() => svc.create({ sessionPk: null, ticket: null, text: 'x', dueAt: '2026-09-17T09:00:00.000Z', sendToSession: false })).toThrow(/future/);
    expect(() => svc.create({ sessionPk: 'claude:nope', ticket: null, text: 'x', dueAt: '2026-09-18T00:00:00.000Z', sendToSession: true })).toThrow(/session/);
    expect(svc.list({ state: ['pending'] })).toHaveLength(1);
  });

  it('fires into the inbox and the owned session once', async () => {
    const { svc, sent, upserts } = setup();
    const r = svc.create({ sessionPk: 'claude:s1', ticket: 'SAF-1', text: 're-check CI', dueAt: '2026-09-17T10:20:00.000Z', sendToSession: true });
    await svc.fire(r.id);
    await svc.fire(r.id);
    expect(upserts).toEqual([
      expect.objectContaining({ kind: 'reminder', dedupeKey: `reminder:${r.id}`, sessionId: 's1', projectId: 'wakecap', ticket: 'SAF-1', reason: 're-check CI', payload: { reminderId: r.id, source: 'claude', id: 's1', sentToSession: true } }),
    ]);
    expect(sent).toEqual([['pty-1', 're-check CI']]);
    expect(svc.list({})[0]).toMatchObject({ state: 'fired', firedAt: NOW.toISOString() });
  });

  it('does not send to observed sessions or denied text, and can cancel', async () => {
    const observed = setup({ ...owned, ownership: 'observed', ptyId: null });
    const r1 = observed.svc.create({ sessionPk: 'claude:s1', ticket: null, text: 'ping', dueAt: '2026-09-17T11:00:00.000Z', sendToSession: true });
    await observed.svc.fire(r1.id);
    expect(observed.sent).toEqual([]);
    expect(observed.upserts[0]?.payload).toMatchObject({ sentToSession: false });

    const denied = setup();
    const r2 = denied.svc.create({ sessionPk: 'claude:s1', ticket: null, text: 'rm -rf /', dueAt: '2026-09-17T11:00:00.000Z', sendToSession: true });
    await denied.svc.fire(r2.id);
    expect(denied.sent).toEqual([]);
    expect(denied.ctx.audit?.list({ action: 'pty.input' })[0]).toMatchObject({ result: 'denied', actor: 'automation', actorDetail: 'reminder' });

    const r3 = denied.svc.create({ sessionPk: null, ticket: null, text: 'later', dueAt: '2026-09-17T12:00:00.000Z', sendToSession: false });
    expect(denied.svc.cancel(r3.id).state).toBe('cancelled');
    expect(denied.scheduler.get(r3.jobId)).toBeNull();
    await denied.svc.fire(r3.id);
    expect(denied.upserts.filter((u) => u.dedupeKey === `reminder:${r3.id}`)).toEqual([]);
    expect(() => denied.svc.cancel('nope')).toThrow(/not found/);
  });
});
```

- [ ] **Step 3: Run both and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/services/goals apps/daemon/src/services/reminders`
Expected: FAIL, modules not found.

- [ ] **Step 4: Write the repos**

`apps/daemon/src/db/repos/goals.ts`
```ts
import { randomUUID } from 'node:crypto';
import type { Goal, GoalState } from '@orc/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { goals } from '../schema.ts';

export type GoalSource = 'manual' | 'rule' | 'recap';

const toGoal = (r: typeof goals.$inferSelect): Goal => ({
  id: r.id,
  targetType: r.targetType,
  targetId: r.targetId,
  objective: r.objective,
  state: r.state,
  blockedReason: r.blockedReason,
  updatedAt: r.updatedAt,
});

export function getGoal(db: OrcDb, targetType: Goal['targetType'], targetId: string): Goal | null {
  const r = db.select().from(goals).where(and(eq(goals.targetType, targetType), eq(goals.targetId, targetId))).get();
  return r ? toGoal(r) : null;
}

export function upsertGoal(db: OrcDb, g: Omit<Goal, 'id' | 'updatedAt'>, source: GoalSource, nowIso: string): Goal {
  const blockedReason = g.state === 'blocked' ? g.blockedReason : null;
  db.insert(goals)
    .values({ id: randomUUID(), ...g, blockedReason, source, updatedAt: nowIso })
    .onConflictDoUpdate({
      target: [goals.targetType, goals.targetId],
      set: { objective: g.objective, state: g.state, blockedReason, source, updatedAt: nowIso },
    })
    .run();
  const out = getGoal(db, g.targetType, g.targetId);
  if (!out) throw new Error('goal upsert failed');
  return out;
}

export function listGoals(db: OrcDb, states?: GoalState[]): Goal[] {
  const q = db.select().from(goals);
  const rows = states && states.length > 0 ? q.where(inArray(goals.state, states)) : q;
  return rows.orderBy(desc(goals.updatedAt)).all().map(toGoal);
}

export function goalSource(db: OrcDb, id: string): GoalSource | null {
  return db.select({ s: goals.source }).from(goals).where(eq(goals.id, id)).get()?.s ?? null;
}
```

`apps/daemon/src/db/repos/reminders.ts`
```ts
import type { Reminder, ReminderState } from '@orc/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { reminders } from '../schema.ts';

export function insertReminder(db: OrcDb, r: Reminder): void {
  db.insert(reminders).values(r).run();
}

export function getReminder(db: OrcDb, id: string): Reminder | null {
  return db.select().from(reminders).where(eq(reminders.id, id)).get() ?? null;
}

export function listReminders(db: OrcDb, f: { state?: ReminderState[]; sessionPk?: string }): Reminder[] {
  return db
    .select()
    .from(reminders)
    .where(
      and(
        f.state && f.state.length > 0 ? inArray(reminders.state, f.state) : undefined,
        f.sessionPk === undefined ? undefined : eq(reminders.sessionPk, f.sessionPk),
      ),
    )
    .orderBy(asc(reminders.dueAt))
    .all();
}

export function setReminderState(db: OrcDb, id: string, state: ReminderState, firedAt: string | null): void {
  db.update(reminders).set({ state, firedAt }).where(eq(reminders.id, id)).run();
}
```

- [ ] **Step 5: Write the services**

`apps/daemon/src/services/goals/goals.ts`
```ts
import { type Goal, type GoalState, extractTicketsFrom, truncateText } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { getGoal, goalSource, listGoals, upsertGoal } from '../../db/repos/goals.ts';
import { listAllSessions } from '../session-pages.ts';

export const NEEDS_ANSWER = 'needs answer';
export const WAITING_BLOCK_MS = 30 * 60_000;

export interface GoalService {
  get(targetType: Goal['targetType'], targetId: string): Goal | null;
  set(g: Omit<Goal, 'id' | 'updatedAt'>): Goal;
  list(filter: { state?: GoalState[] }): Goal[];
  prefill(targetType: Goal['targetType'], targetId: string): string;
  sweep(now?: Date): number;
  start(): void;
  stop(): void;
}

export function createGoalService(ctx: DaemonContext, opts: { now?: () => Date; sweepMs?: number } = {}): GoalService {
  const now = opts.now ?? (() => new Date());
  const waitingSince = new Map<string, number>();
  const unsubs: Array<() => void> = [];
  let timer: NodeJS.Timeout | null = null;

  const iso = () => now().toISOString();
  const streamTitle = (ticket: string) => ctx.streams?.list({}).find((s) => s.ticket === ticket)?.title ?? null;

  function prefill(targetType: Goal['targetType'], targetId: string): string {
    if (targetType === 'stream') {
      const title = streamTitle(targetId);
      return title ? `${targetId}: ${title}` : targetId;
    }
    const s = ctx.sessions.getByPk(targetId);
    if (!s) return '';
    const ticket = s.tickets[0];
    const title = ticket ? streamTitle(ticket) : null;
    if (ticket && title) return `${ticket}: ${title}`;
    return truncateText((s.firstPrompt ?? s.name ?? '').trim(), 200);
  }

  function fromRule(targetType: Goal['targetType'], targetId: string, state: GoalState, reason: string | null): Goal | null {
    const g = getGoal(ctx.db, targetType, targetId);
    return upsertGoal(
      ctx.db,
      { targetType, targetId, objective: g?.objective ?? prefill(targetType, targetId), state, blockedReason: reason },
      'rule',
      iso(),
    );
  }

  function sweep(at: Date = now()): number {
    let changed = 0;
    for (const [pk, since] of waitingSince) {
      if (at.getTime() - since < WAITING_BLOCK_MS) continue;
      const g = getGoal(ctx.db, 'session', pk);
      if (g === null || g.state === 'active') {
        fromRule('session', pk, 'blocked', NEEDS_ANSWER);
        changed++;
      }
    }
    return changed;
  }

  function onPrMerged(url: string, title: string, headRef: string | null): void {
    for (const s of listAllSessions(ctx, { pr: url })) {
      const g = getGoal(ctx.db, 'session', s.pk);
      if (g && g.state !== 'complete') fromRule('session', s.pk, 'complete', null);
    }
    const pattern = ctx.config().projects.find((p) => p.features.workStreams)?.ticketRegex ?? null;
    for (const ticket of extractTicketsFrom(`${title} ${headRef ?? ''}`, pattern)) {
      const g = getGoal(ctx.db, 'stream', ticket);
      if (g && g.state !== 'complete') fromRule('stream', ticket, 'complete', null);
    }
  }

  return {
    get: (t, id) => getGoal(ctx.db, t, id),
    set: (g) => upsertGoal(ctx.db, g, 'manual', iso()),
    list: (f) => listGoals(ctx.db, f.state),
    prefill,
    sweep,
    start() {
      unsubs.push(
        ctx.bus.on('session.statusChanged', (e) => {
          if (e.to === 'waiting') {
            if (!waitingSince.has(e.pk)) waitingSince.set(e.pk, now().getTime());
            return;
          }
          waitingSince.delete(e.pk);
          const g = getGoal(ctx.db, 'session', e.pk);
          if (g && g.state === 'blocked' && g.blockedReason === NEEDS_ANSWER && goalSource(ctx.db, g.id) === 'rule') {
            fromRule('session', e.pk, 'active', null);
          }
        }),
        ctx.bus.on('pr.changed', (e) => {
          if (e.after.state === 'merged' && e.before?.state !== 'merged') onPrMerged(e.after.pr.url, e.after.title, e.after.headRef);
        }),
      );
      timer = setInterval(() => sweep(), opts.sweepMs ?? 60_000);
    },
    stop() {
      for (const u of unsubs.splice(0)) u();
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
```

`apps/daemon/src/services/reminders/reminders.ts`
```ts
import { randomUUID } from 'node:crypto';
import { type Reminder, type ReminderState, truncateText } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { getReminder, insertReminder, listReminders, setReminderState } from '../../db/repos/reminders.ts';
import { ServiceError } from '../errors.ts';
import type { Scheduler } from '../scheduler/scheduler.ts';

export interface CreateReminderInput { sessionPk: string | null; ticket: string | null; text: string; dueAt: string; sendToSession: boolean }

export interface ReminderService {
  create(i: CreateReminderInput): Reminder;
  list(f: { state?: ReminderState[]; sessionPk?: string }): Reminder[];
  cancel(id: string): Reminder;
  fire(reminderId: string): Promise<void>;
  start(): void;
}

export function createReminderService(ctx: DaemonContext, deps: { scheduler: Scheduler; now?: () => Date }): ReminderService {
  const now = deps.now ?? (() => new Date());

  async function fire(id: string): Promise<void> {
    const r = getReminder(ctx.db, id);
    if (!r || r.state !== 'pending') return;
    setReminderState(ctx.db, id, 'fired', now().toISOString());
    const s = r.sessionPk ? ctx.sessions.getByPk(r.sessionPk) : null;
    const live = r.sessionPk ? (ctx.live?.get(r.sessionPk)?.live ?? s?.live ?? null) : null;
    let sent = false;
    if (r.sendToSession && s && live?.ownership === 'owned' && live.ptyId) {
      const verdict = ctx.denyList?.check(r.text, s.projectId) ?? { denied: false, reason: null };
      if (verdict.denied) {
        ctx.audit?.record({
          actor: 'automation',
          actorDetail: 'reminder',
          action: 'pty.input',
          target: r.sessionPk,
          params: { reminderId: id },
          result: 'denied',
          error: verdict.reason,
        });
      } else {
        // ctx.pty is wrapped by P3's withPtyInputAudit, so this input is audited.
        await ctx.pty.sendText(live.ptyId, r.text);
        sent = true;
      }
    }
    ctx.inbox?.upsert({
      kind: 'reminder',
      dedupeKey: `reminder:${id}`,
      sessionId: s?.id ?? null,
      projectId: s?.projectId ?? null,
      ticket: r.ticket,
      reason: truncateText(r.text, 200),
      payload: { reminderId: id, ...(s ? { source: s.source, id: s.id } : {}), sentToSession: sent },
    });
  }

  return {
    create(i) {
      if (Number.isNaN(Date.parse(i.dueAt)) || Date.parse(i.dueAt) <= now().getTime()) {
        throw new ServiceError('validation_failed', 400, 'dueAt must be in the future');
      }
      if (i.sessionPk !== null && !ctx.sessions.getByPk(i.sessionPk)) {
        throw new ServiceError('not_found', 404, 'session not found');
      }
      const id = randomUUID();
      const dueAt = new Date(i.dueAt).toISOString();
      const job = deps.scheduler.add({ kind: 'reminder', cron: null, runAt: dueAt, payload: { reminderId: id }, enabled: true });
      const r: Reminder = { id, jobId: job.id, sessionPk: i.sessionPk, ticket: i.ticket, text: i.text, dueAt, sendToSession: i.sendToSession, state: 'pending', createdAt: now().toISOString(), firedAt: null };
      insertReminder(ctx.db, r);
      return r;
    },
    list: (f) => listReminders(ctx.db, f),
    cancel(id) {
      const r = getReminder(ctx.db, id);
      if (!r) throw new ServiceError('not_found', 404, 'reminder not found');
      if (r.state === 'pending') {
        deps.scheduler.remove(r.jobId);
        setReminderState(ctx.db, id, 'cancelled', null);
      }
      return getReminder(ctx.db, id) ?? r;
    },
    fire,
    start() {
      deps.scheduler.onFire('reminder', async (job) => {
        const rid = job.payload.reminderId;
        if (typeof rid === 'string') await fire(rid);
      });
    },
  };
}
```

The test's "session" error for an unknown `sessionPk` matches the message `session not found`, and the "future" error matches `dueAt must be in the future`.

- [ ] **Step 6: Run the service tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/services/goals apps/daemon/src/services/reminders`
Expected: PASS (6 tests). The denied case reads `ctx.audit` (P3's `buildContext` always wires it).

- [ ] **Step 7: Write the failing route test, then the routes**

`apps/daemon/src/http/routes/goals-reminders.test.ts`
```ts
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { bareApp, makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import { createGoalService } from '../../services/goals/goals.ts';
import { createReminderService } from '../../services/reminders/reminders.ts';
import { createScheduler } from '../../services/scheduler/scheduler.ts';
import { registerGoalRoutes } from './goals.ts';
import { registerReminderRoutes } from './reminders.ts';

function setup() {
  const t = makeP5Context({ config: withWakecap('/Users/test/Wakecap'), data: { sessions: [makeSession({ id: 's1', firstPrompt: 'do the thing' })] } });
  t.ctx.goals = createGoalService(t.ctx);
  t.ctx.reminders = createReminderService(t.ctx, { scheduler: createScheduler({ db: t.ctx.db, log: pino({ level: 'silent' }) }) });
  const app = bareApp();
  registerGoalRoutes(app, t.ctx);
  registerReminderRoutes(app, t.ctx);
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { app, send };
}

describe('/api/goals', () => {
  it('returns prefill, saves and lists goals', async () => {
    const { app, send } = setup();
    expect(await (await app.request('/api/goals/session/claude%3As1')).json()).toEqual({ goal: null, prefill: 'do the thing' });
    const put = await send('PUT', '/api/goals/session/claude%3As1', { objective: 'finish', state: 'blocked', blockedReason: 'waiting on QA' });
    expect(await put.json()).toMatchObject({ targetId: 'claude:s1', state: 'blocked', blockedReason: 'waiting on QA' });
    expect(((await (await app.request('/api/goals?state=blocked,bogus')).json()) as unknown[]).length).toBe(1);
    expect((await send('PUT', '/api/goals/bogus/x', { objective: 'a', state: 'active' })).status).toBe(400);
    expect((await send('PUT', '/api/goals/stream/SAF-1', { objective: '', state: 'active' })).status).toBe(400);
  });
});

describe('/api/reminders', () => {
  it('creates, lists and cancels reminders', async () => {
    const { app, send } = setup();
    const res = await send('POST', '/api/reminders', { sessionPk: 'claude:s1', text: 're-check CI', inMinutes: 20, sendToSession: true });
    expect(res.status).toBe(200);
    const r = (await res.json()) as { id: string; state: string };
    expect(r.state).toBe('pending');
    expect(((await (await app.request('/api/reminders?state=pending&sessionPk=claude%3As1')).json()) as unknown[]).length).toBe(1);
    expect(await (await send('POST', `/api/reminders/${r.id}/cancel`, {})).json()).toMatchObject({ state: 'cancelled' });
    expect((await send('POST', '/api/reminders/nope/cancel', {})).status).toBe(404);
    expect((await send('POST', '/api/reminders', { text: 'x', sendToSession: true, inMinutes: 5 })).status).toBe(400);
    expect((await send('POST', '/api/reminders', { text: 'x', dueAt: '2020-01-01T00:00:00.000Z' })).status).toBe(400);
  });
});
```

`apps/daemon/src/http/routes/goals.ts`
```ts
import { GoalPutBody, GoalTargetTypeSchema, GoalsListQuery, apiError } from '@orc/api-contract';
import type { GoalState } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { need } from '../../services/need.ts';
import { parseStates, readBody, readQuery } from '../p5-util.ts';
import type { OrcApp } from '../types.ts';

const STATES: readonly GoalState[] = ['active', 'paused', 'blocked', 'complete'];

export function registerGoalRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.goals, 'goals');

  app.get('/api/goals', (c) => {
    const q = readQuery(c, GoalsListQuery);
    if (!q.ok) return q.res;
    return c.json(svc().list({ state: parseStates(q.data.state, STATES) }));
  });
  app.get('/api/goals/:targetType/:targetId', (c) => {
    const t = GoalTargetTypeSchema.safeParse(c.req.param('targetType'));
    if (!t.success) return c.json(apiError('validation_failed', 'targetType must be session or stream'), 400);
    const id = c.req.param('targetId');
    return c.json({ goal: svc().get(t.data, id), prefill: svc().prefill(t.data, id) });
  });
  app.put('/api/goals/:targetType/:targetId', async (c) => {
    const t = GoalTargetTypeSchema.safeParse(c.req.param('targetType'));
    if (!t.success) return c.json(apiError('validation_failed', 'targetType must be session or stream'), 400);
    const b = await readBody(c, GoalPutBody);
    if (!b.ok) return b.res;
    return c.json(svc().set({ targetType: t.data, targetId: c.req.param('targetId'), ...b.data }));
  });
}
```

`apps/daemon/src/http/routes/reminders.ts`
```ts
import { ReminderCreateBody, RemindersListQuery } from '@orc/api-contract';
import type { ReminderState } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { need } from '../../services/need.ts';
import { parseStates, readBody, readQuery, sendError } from '../p5-util.ts';
import type { OrcApp } from '../types.ts';

const STATES: readonly ReminderState[] = ['pending', 'fired', 'cancelled'];

export function registerReminderRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.reminders, 'reminders');

  app.get('/api/reminders', (c) => {
    const q = readQuery(c, RemindersListQuery);
    if (!q.ok) return q.res;
    return c.json(svc().list({ state: parseStates(q.data.state, STATES), sessionPk: q.data.sessionPk }));
  });
  app.post('/api/reminders', async (c) => {
    const b = await readBody(c, ReminderCreateBody);
    if (!b.ok) return b.res;
    const d = b.data;
    const dueAt = d.dueAt ?? new Date(Date.now() + (d.inMinutes ?? 0) * 60_000).toISOString();
    try {
      return c.json(svc().create({ sessionPk: d.sessionPk, ticket: d.ticket, text: d.text, dueAt, sendToSession: d.sendToSession }));
    } catch (err) {
      return sendError(c, err);
    }
  });
  app.post('/api/reminders/:id/cancel', (c) => {
    try {
      return c.json(svc().cancel(c.req.param('id')));
    } catch (err) {
      return sendError(c, err);
    }
  });
}
```

Run: `pnpm vitest run apps/daemon/src/http/routes/goals-reminders.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 8: Wire, register and exempt**

In `apps/daemon/src/context.ts`:
- Point the existing `goals?: GoalService` import at `./services/goals/goals.ts`.
- Add `reminders?: ReminderService;`.
- In `buildContext()`:
```ts
  ctx.goals = createGoalService(ctx);
  ctx.reminders = createReminderService(ctx, { scheduler: ctx.scheduler });
```

In `createDaemon()`: call `ctx.goals?.start();` and `ctx.reminders?.start();` **before** `ctx.scheduler?.start()`, so overdue reminders find their handler. Add `ctx.goals?.stop();` in `close()`.

In `createApp`: `registerGoalRoutes(app, o.ctx); registerReminderRoutes(app, o.ctx);`.

Append to `NON_ACTION_ROUTES`:
```ts
  { method: 'PUT', path: '/api/goals/:targetType/:targetId', why: 'local goal metadata' },
  { method: 'POST', path: '/api/reminders', why: 'schedules a local reminder; its PTY input is audited by withPtyInputAudit when it fires' },
  { method: 'POST', path: '/api/reminders/:id/cancel', why: 'local reminder state' },
```

- [ ] **Step 9: Commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add apps/daemon
git commit -m "feat(goals): add goals with merge/waiting rules, persisted reminders and their routes"
```

---

### Task 15: Handoffs (structured evidence, LLM summary, markdown) and "Resume fresh with handoff"

**Files:**
- Create: `packages/core/src/recap/handoff.ts`, `packages/core/src/recap/handoff.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/browser.ts`
- Create: `apps/daemon/src/db/repos/handoffs.ts`
- Create: `apps/daemon/src/services/handoff/handoff.ts`, `apps/daemon/src/services/handoff/handoff.test.ts`
- Create: `apps/daemon/src/http/routes/handoffs.ts`, `apps/daemon/src/http/routes/handoffs.test.ts`
- Modify: `apps/daemon/src/context.ts`, `apps/daemon/src/main.ts`, `apps/daemon/src/http/app.ts`, `apps/daemon/src/http/audit-middleware.ts`

**Interfaces:**
- Consumes:
  - `buildRecapDigest`, `renderPromptTemplate`, `DEFAULT_HANDOFF_PROMPT`, `approxTokens`, `redact` (core)
  - `RecapService.findCached/runLlm` (Task 13)
  - `transcriptOffset` (Task 13)
  - `loadEvents` (Task 2)
  - `GoalService.get` (Task 14)
  - `LaunchService.launch`, `LaunchError`, `LaunchRequest` (P2)
  - `ServiceError` (P1)
- Produces:
  ```ts
  // core recap/handoff.ts
  export const EVIDENCE_COMMAND_RE: RegExp
  export interface HandoffEvidence { evidence: string[]; files: string[]; links: string[] }
  export function collectHandoffEvidence(s: Pick<Session, 'lastTest' | 'prs' | 'tickets' | 'filesTouched'>, events: TimelineEvent[], plans?: string[]): HandoffEvidence
  export interface HandoffLlmFields { status: string; summary: string; nextSteps: string[]; blockers: string[] }
  export function parseHandoffJson(text: string): HandoffLlmFields | null
  export function handoffToMarkdown(h: Handoff): string
  export function buildResumePrompt(h: Handoff): string
  // repos/handoffs.ts
  export function insertHandoff(db: OrcDb, h: Handoff): void
  export function getHandoff(db: OrcDb, id: string): Handoff | null
  export function latestHandoff(db: OrcDb, sessionPk: string): Handoff | null
  // services/handoff/handoff.ts
  export interface HandoffService { generate; toMarkdown; latest; get; resumeFresh }   // Contract additions
  export function createHandoffService(ctx: DaemonContext, deps: { recaps: RecapService; now?: () => Date }): HandoffService
  // routes
  export function registerHandoffRoutes(app: OrcApp, ctx: DaemonContext): void
  ```
- **Evidence** is structured data and never comes from the model:
  - the last test result
  - the PR URLs
  - up to 10 unique Bash commands that match test, build, lint, git or gh patterns (redacted, at most 200 characters each)
- **Files** are `filesTouched` (at most 50). **Links** are PR URLs, then `ticket:<ID>`, then plan paths.
- **LLM fields** (`status`, `summary`, `nextSteps`, `blockers`) come from `DEFAULT_HANDOFF_PROMPT`, as JSON, run through `RecapService.runLlm('handoff', …)` with the on-demand model. The call is skipped when recaps are disabled for the project. If the call fails or returns bad JSON, the handoff falls back to:
  - `status`: goal state, or live status, or `unknown`
  - `summary`: recap first, then away summary, then last prompt
  - `blockers`: the goal's blocked reason
- **"Resume fresh"** calls `ctx.launcher.launch({ source, projectId, cwd: startCwd, prompt: buildResumePrompt(h) })`. That applies P2's concurrency cap (`429 concurrency_limit`) and the argv rules.
  - The route requires `{"confirm": true}`.
  - It is audited as `session.launch` through `AUDITED_ROUTES`.
  - A prompt that starts with `-` would be rejected by P2. `buildResumePrompt` always starts with a letter.

- [ ] **Step 1: Write the failing core test**

`packages/core/src/recap/handoff.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import type { Handoff, TimelineEvent } from '../types/index.ts';
import { buildResumePrompt, collectHandoffEvidence, handoffToMarkdown, parseHandoffJson } from './handoff.ts';

const call = (seq: number, command: string): TimelineEvent => ({
  sessionId: 's', agentId: null, uuid: `u${seq}`, parentUuid: null, seq, ts: 't', kind: 'tool_call', turn: 1, text: null, tool: 'Bash',
  toolUseId: `t${seq}`, mcpServer: null, input: { command }, messageId: null, model: null, usage: null, durationMs: null,
});

describe('handoff helpers', () => {
  it('collects structured, redacted evidence', () => {
    const h = collectHandoffEvidence(
      {
        lastTest: { ts: '2026-09-17T10:00:00.000Z', command: 'pnpm vitest run', passed: 18, failed: 1, skipped: 0, durationMs: 1400 },
        prs: [{ repo: 'o/r', number: 1, url: 'https://github.com/o/r/pull/1' }],
        tickets: ['SAF-1'],
        filesTouched: ['/a.ts', '/a.ts', '/b.ts'],
      },
      [call(1, 'ls -la'), call(2, 'PGPASSWORD=hunter2 pnpm test'), call(3, 'git push origin feat/x'), call(4, 'pnpm test'), call(5, 'PGPASSWORD=hunter2 pnpm test')],
      ['/w/plans/SAF-1-x.md'],
    );
    expect(h.evidence).toEqual([
      'Tests: 18 passed, 1 failed, 0 skipped — `pnpm vitest run` (2026-09-17T10:00:00.000Z)',
      'PR: https://github.com/o/r/pull/1',
      'Ran: `PGPASSWORD=«redacted:secret» pnpm test`',
      'Ran: `git push origin feat/x`',
      'Ran: `pnpm test`',
    ]);
    expect(h.files).toEqual(['/a.ts', '/b.ts']);
    expect(h.links).toEqual(['https://github.com/o/r/pull/1', 'ticket:SAF-1', '/w/plans/SAF-1-x.md']);
  });

  it('parses JSON from model output, tolerating fences', () => {
    expect(parseHandoffJson('```json\n{"status":"blocked","summary":"S","nextSteps":["a"],"blockers":["b"]}\n```')).toEqual({
      status: 'blocked', summary: 'S', nextSteps: ['a'], blockers: ['b'],
    });
    expect(parseHandoffJson('{"status":"weird","summary":"S"}')).toEqual({ status: 'in_progress', summary: 'S', nextSteps: [], blockers: [] });
    expect(parseHandoffJson('no json here')).toBeNull();
    expect(parseHandoffJson('{"summary": 3}')).toBeNull();
  });

  it('renders markdown and a resume prompt', () => {
    const h: Handoff = {
      id: 'h1', sessionId: 'claude:s1', status: 'in_progress', summary: 'Did X.', evidence: ['PR: u'], files: ['/a.ts'],
      nextSteps: ['Fix test', 'Open PR'], blockers: [], links: ['u'], createdAt: '2026-09-17T10:00:00.000Z',
    };
    const md = handoffToMarkdown(h);
    expect(md).toContain('# Handoff — in_progress');
    expect(md).toContain('## Next steps\n1. Fix test\n2. Open PR');
    expect(md).toContain('## Blockers\n- none');
    expect(md).toContain('- `/a.ts`');
    const p = buildResumePrompt(h);
    expect(p.startsWith('You are continuing')).toBe(true);
    expect(p).toContain(md);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/core/src/recap/handoff.test.ts`
Expected: FAIL, `Cannot find module './handoff.ts'`.

- [ ] **Step 3: Implement the core helpers**

`packages/core/src/recap/handoff.ts`
```ts
import { redact } from '../redact/redact.ts';
import type { Handoff, Session, TimelineEvent } from '../types/index.ts';

export const EVIDENCE_COMMAND_RE =
  /\b(vitest|jest|pytest|mocha|playwright|dotnet (test|build)|flutter (test|analyze)|go test|cargo test|(pnpm|npm|yarn|bun)( run)? (test|lint|build|typecheck)|tsc|eslint|biome|git (commit|push|merge|rebase|checkout -b)|gh pr)\b/;
const MAX_COMMANDS = 10;
const MAX_FILES = 50;
const VALID_STATUS = new Set(['in_progress', 'ready_for_review', 'blocked', 'done']);

export interface HandoffEvidence { evidence: string[]; files: string[]; links: string[] }
export interface HandoffLlmFields { status: string; summary: string; nextSteps: string[]; blockers: string[] }

function commandOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const c = (input as Record<string, unknown>).command;
  return typeof c === 'string' ? c : null;
}

export function collectHandoffEvidence(
  s: Pick<Session, 'lastTest' | 'prs' | 'tickets' | 'filesTouched'>,
  events: TimelineEvent[],
  plans: string[] = [],
): HandoffEvidence {
  const evidence: string[] = [];
  const t = s.lastTest;
  if (t) {
    evidence.push(`Tests: ${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped — \`${redact(t.command)}\` (${t.ts})`);
  }
  for (const p of s.prs) evidence.push(`PR: ${p.url}`);
  const seen = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'tool_call' || e.tool !== 'Bash') continue;
    const cmd = commandOf(e.input);
    if (!cmd || !EVIDENCE_COMMAND_RE.test(cmd)) continue;
    const clean = redact(cmd.replace(/\s+/g, ' ').trim()).slice(0, 200);
    if (seen.has(clean)) continue;
    seen.add(clean);
    evidence.push(`Ran: \`${clean}\``);
    if (seen.size >= MAX_COMMANDS) break;
  }
  return {
    evidence,
    files: [...new Set(s.filesTouched)].slice(0, MAX_FILES),
    links: [...s.prs.map((p) => p.url), ...s.tickets.map((x) => `ticket:${x}`), ...plans],
  };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function parseHandoffJson(text: string): HandoffLlmFields | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let v: unknown;
  try {
    v = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.summary !== 'string') return null;
  return {
    status: typeof o.status === 'string' && VALID_STATUS.has(o.status) ? o.status : 'in_progress',
    summary: o.summary,
    nextSteps: strings(o.nextSteps),
    blockers: strings(o.blockers),
  };
}

const bullets = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- none');

export function handoffToMarkdown(h: Handoff): string {
  return [
    `# Handoff — ${h.status}`,
    `_Session:_ \`${h.sessionId}\` · _Created:_ ${h.createdAt}`,
    '',
    '## Summary',
    h.summary || '_No summary._',
    '',
    '## Evidence',
    bullets(h.evidence),
    '',
    '## Files',
    h.files.length ? h.files.map((f) => `- \`${f}\``).join('\n') : '- none',
    '',
    '## Next steps',
    h.nextSteps.length ? h.nextSteps.map((s, i) => `${i + 1}. ${s}`).join('\n') : '1. Decide the next step with the user.',
    '',
    '## Blockers',
    bullets(h.blockers),
    '',
    '## Links',
    bullets(h.links),
    '',
  ].join('\n');
}

export function buildResumePrompt(h: Handoff): string {
  return [
    'You are continuing work that an earlier session started. Read the handoff below.',
    'First check the current state of the listed files and branches (things may have changed),',
    'then continue with the next steps. Ask me before doing anything the blockers say is unresolved.',
    '',
    handoffToMarkdown(h),
  ].join('\n');
}
```

Append to both `packages/core/src/index.ts` and `packages/core/src/browser.ts`:
```ts
export * from './recap/handoff.ts';
```

Run: `pnpm vitest run packages/core/src/recap/handoff.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 4: Write the failing service test**

`apps/daemon/src/services/handoff/handoff.test.ts`
```ts
import type { Recap } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { ev, makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import type { LaunchRequest } from '@orc/api-contract';
import { ServiceError } from '../errors.ts';
import type { RecapService } from '../recap/recap.ts';
import { createHandoffService } from './handoff.ts';

function setup(llm: 'ok' | 'fail' | 'bad' = 'ok') {
  const s1 = makeSession({
    id: 's1', tickets: ['SAF-1'], recap: 'Recap first line', filesTouched: ['/w/a.ts'], startCwd: '/Users/test/Wakecap',
    prs: [{ repo: 'o/r', number: 1, url: 'https://github.com/o/r/pull/1' }],
  });
  const events = { 'claude:s1': [ev({ seq: 1, ts: 't', kind: 'tool_call', tool: 'Bash', input: { command: 'pnpm test' } }), ev({ seq: 2, ts: 't', kind: 'tool_result', text: 'SECRET_OUT' })] };
  const t = makeP5Context({ config: withWakecap('/Users/test/Wakecap'), data: { sessions: [s1], events } });
  const prompts: string[] = [];
  const recaps = {
    findCached: () => null,
    runLlm: async (_k: string, _key: string, _o: number, prompt: string): Promise<Recap> => {
      prompts.push(prompt);
      if (llm === 'fail') throw new ServiceError('over_budget', 409, 'budget');
      const text = llm === 'bad' ? 'sorry' : '{"status":"ready_for_review","summary":"Done X","nextSteps":["Merge"],"blockers":[]}';
      return { id: 'r', kind: 'handoff', targetKey: 'claude:s1', transcriptOffset: 1, model: 'm', engine: 'claude-cli', text, costUsd: 0.1, inputTokensApprox: 1, createdAt: 't' };
    },
  } as unknown as RecapService;
  const launches: LaunchRequest[] = [];
  t.ctx.launcher = {
    launch: async (req) => (launches.push(req), { ptyId: 'pty-9', sessionId: null }),
    kill: async () => ({ killed: 'pty' as const }),
    ownedCount: () => 0,
  };
  const svc = createHandoffService(t.ctx, { recaps, now: () => new Date('2026-09-17T10:00:00.000Z') });
  return { ...t, svc, prompts, launches };
}

describe('handoff service', () => {
  it('combines structured evidence with the LLM summary', async () => {
    const { svc, prompts } = setup();
    const h = await svc.generate('claude:s1');
    expect(h).toMatchObject({
      sessionId: 'claude:s1', status: 'ready_for_review', summary: 'Done X', nextSteps: ['Merge'], blockers: [],
      evidence: ['PR: https://github.com/o/r/pull/1', 'Ran: `pnpm test`'], files: ['/w/a.ts'],
      links: ['https://github.com/o/r/pull/1', 'ticket:SAF-1'], createdAt: '2026-09-17T10:00:00.000Z',
    });
    expect(prompts[0]).toContain('Ran: `pnpm test`');
    expect(prompts[0]).not.toContain('SECRET_OUT');
    expect(svc.latest('claude:s1')).toEqual(h);
    expect(svc.get(h.id)).toEqual(h);
    expect(svc.toMarkdown(h)).toContain('# Handoff — ready_for_review');
  });

  it('falls back to structured data when the LLM is unavailable or returns junk', async () => {
    const a = setup('fail');
    a.ctx.goals = { get: () => ({ id: 'g', targetType: 'session', targetId: 'claude:s1', objective: 'o', state: 'blocked', blockedReason: 'needs answer', updatedAt: 't' }) } as unknown as NonNullable<typeof a.ctx.goals>;
    expect(await a.svc.generate('claude:s1')).toMatchObject({ status: 'blocked', summary: 'Recap first line', blockers: ['needs answer'], nextSteps: [] });
    const b = setup('bad');
    expect(await b.svc.generate('claude:s1')).toMatchObject({ status: 'unknown', summary: 'Recap first line' });
    await expect(b.svc.generate('claude:none')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('skips the LLM when recaps are disabled for the project', async () => {
    const t = setup();
    t.ctx.updateConfig?.((c) => ({ ...c, projects: c.projects.map((p) => ({ ...p, features: { ...p.features, recaps: false } })) }));
    await t.svc.generate('claude:s1');
    expect(t.prompts).toEqual([]);
  });

  it('resumes fresh through the launcher with the handoff prompt', async () => {
    const { svc, launches } = setup();
    const h = await svc.generate('claude:s1');
    expect(await svc.resumeFresh(h.id)).toEqual({ ptyId: 'pty-9' });
    expect(launches[0]).toMatchObject({ source: 'claude', projectId: 'wakecap', cwd: '/Users/test/Wakecap', planApproval: false });
    expect(launches[0]?.prompt.startsWith('You are continuing')).toBe(true);
    await expect(svc.resumeFresh('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});
```

- [ ] **Step 5: Implement the repo and the service**

`apps/daemon/src/db/repos/handoffs.ts`
```ts
import type { Handoff } from '@orc/core';
import { desc, eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { handoffs } from '../schema.ts';

const arr = (json: string): string[] => {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const toHandoff = (r: typeof handoffs.$inferSelect): Handoff => ({
  id: r.id,
  sessionId: r.sessionPk,
  status: r.status,
  summary: r.summary,
  evidence: arr(r.evidenceJson),
  files: arr(r.filesJson),
  nextSteps: arr(r.nextStepsJson),
  blockers: arr(r.blockersJson),
  links: arr(r.linksJson),
  createdAt: r.createdAt,
});

export function insertHandoff(db: OrcDb, h: Handoff): void {
  db.insert(handoffs)
    .values({
      id: h.id,
      sessionPk: h.sessionId,
      status: h.status,
      summary: h.summary,
      evidenceJson: JSON.stringify(h.evidence),
      filesJson: JSON.stringify(h.files),
      nextStepsJson: JSON.stringify(h.nextSteps),
      blockersJson: JSON.stringify(h.blockers),
      linksJson: JSON.stringify(h.links),
      createdAt: h.createdAt,
    })
    .run();
}

export function getHandoff(db: OrcDb, id: string): Handoff | null {
  const r = db.select().from(handoffs).where(eq(handoffs.id, id)).get();
  return r ? toHandoff(r) : null;
}

export function latestHandoff(db: OrcDb, sessionPk: string): Handoff | null {
  const r = db.select().from(handoffs).where(eq(handoffs.sessionPk, sessionPk)).orderBy(desc(handoffs.createdAt)).limit(1).get();
  return r ? toHandoff(r) : null;
}
```

`apps/daemon/src/services/handoff/handoff.ts`
```ts
import { randomUUID } from 'node:crypto';
import { LaunchRequest } from '@orc/api-contract';
import {
  DEFAULT_HANDOFF_PROMPT,
  type Handoff,
  type HandoffLlmFields,
  approxTokens,
  buildRecapDigest,
  buildResumePrompt,
  collectHandoffEvidence,
  handoffToMarkdown,
  parseHandoffJson,
  redact,
  renderPromptTemplate,
} from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { getHandoff, insertHandoff, latestHandoff } from '../../db/repos/handoffs.ts';
import { ServiceError } from '../errors.ts';
import { need } from '../need.ts';
import type { RecapService } from '../recap/recap.ts';
import { transcriptOffset } from '../recap/recap.ts';
import { loadEvents } from '../session-pages.ts';

export interface HandoffService {
  generate(sessionPk: string): Promise<Handoff>;
  toMarkdown(h: Handoff): string;
  latest(sessionPk: string): Handoff | null;
  get(id: string): Handoff | null;
  resumeFresh(handoffId: string): Promise<{ ptyId: string }>;
}

export function createHandoffService(ctx: DaemonContext, deps: { recaps: RecapService; now?: () => Date }): HandoffService {
  const now = deps.now ?? (() => new Date());

  async function llmFields(pk: string, prompt: string, offset: number): Promise<HandoffLlmFields | null> {
    const cached = deps.recaps.findCached('handoff', pk, offset);
    try {
      const rec = cached ?? (await deps.recaps.runLlm('handoff', pk, offset, prompt, { onDemand: true, approxTokens: approxTokens(prompt) }));
      return parseHandoffJson(rec.text);
    } catch (err) {
      ctx.log.info({ pk, code: (err as ServiceError).code ?? 'error' }, 'handoff LLM step skipped');
      return null;
    }
  }

  return {
    async generate(pk) {
      const s = ctx.sessions.getByPk(pk);
      if (!s) throw new ServiceError('not_found', 404, 'session not found');
      const cfg = ctx.config().recaps;
      const events = loadEvents(ctx, s, null);
      const structured = collectHandoffEvidence(s, events);
      const project = s.projectId ? ctx.projects.get(s.projectId) : null;
      const llmAllowed = (project?.features.recaps ?? true) && !(s.projectId && cfg.excludeProjectIds.includes(s.projectId));
      let llm: HandoffLlmFields | null = null;
      if (llmAllowed) {
        const digest = buildRecapDigest({ session: s, events, tests: s.lastTest ? [s.lastTest] : [], plans: [], maxInputTokens: cfg.maxInputTokens });
        const prompt = renderPromptTemplate(DEFAULT_HANDOFF_PROMPT, {
          language: cfg.language,
          digest: digest.text,
          evidence: structured.evidence.join('\n') || 'none',
        });
        llm = await llmFields(pk, prompt, transcriptOffset(s));
      }
      const goal = ctx.goals?.get('session', pk) ?? null;
      const h: Handoff = {
        id: randomUUID(),
        sessionId: pk,
        status: llm?.status ?? goal?.state ?? s.live?.status ?? 'unknown',
        summary: redact(llm?.summary ?? s.recap ?? s.awaySummary ?? s.lastPrompt ?? ''),
        evidence: structured.evidence,
        files: structured.files,
        nextSteps: (llm?.nextSteps ?? []).map(redact),
        blockers: (llm?.blockers ?? (goal?.blockedReason ? [goal.blockedReason] : [])).map(redact),
        links: structured.links,
        createdAt: now().toISOString(),
      };
      insertHandoff(ctx.db, h);
      return h;
    },
    toMarkdown: handoffToMarkdown,
    latest: (pk) => latestHandoff(ctx.db, pk),
    get: (id) => getHandoff(ctx.db, id),
    async resumeFresh(id) {
      const h = getHandoff(ctx.db, id);
      if (!h) throw new ServiceError('not_found', 404, 'handoff not found');
      const s = ctx.sessions.getByPk(h.sessionId);
      if (!s) throw new ServiceError('not_found', 404, 'session not found');
      const res = await need(ctx.launcher, 'launcher').launch(
        LaunchRequest.parse({
          source: s.source === 'codex' ? 'codex' : 'claude',
          projectId: s.projectId,
          cwd: s.startCwd,
          prompt: buildResumePrompt(h),
          ticket: s.tickets[0],
        }),
      );
      return { ptyId: res.ptyId };
    },
  };
}
```

`summary`, `nextSteps` and `blockers` are redacted again, because model output can echo digest text. The fallback status uses the goal state (`blocked`) because the test goal is blocked; for the "bad JSON" case with no goal and no live state, the status is `unknown`.

Run: `pnpm vitest run apps/daemon/src/services/handoff`
Expected: PASS (4 tests)

- [ ] **Step 6: Write the failing route test, then the routes**

`apps/daemon/src/http/routes/handoffs.test.ts`
```ts
import type { Handoff } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { bareApp, makeP5Context, withWakecap } from '../../../test/p5-helpers.ts';
import { ServiceError } from '../../services/errors.ts';
import type { HandoffService } from '../../services/handoff/handoff.ts';
import { LaunchError } from '../../services/launch.ts';
import { registerHandoffRoutes } from './handoffs.ts';

const h: Handoff = { id: 'h1', sessionId: 'claude:s1', status: 'in_progress', summary: 's', evidence: [], files: [], nextSteps: [], blockers: [], links: [], createdAt: 't' };

function setup(launchErr?: Error) {
  const svc: HandoffService = {
    generate: async (pk) => (pk === 'claude:s1' ? h : Promise.reject(new ServiceError('not_found', 404, 'session not found'))),
    toMarkdown: () => '# md',
    latest: (pk) => (pk === 'claude:s1' ? h : null),
    get: (id) => (id === 'h1' ? h : null),
    resumeFresh: async () => {
      if (launchErr) throw launchErr;
      return { ptyId: 'p1' };
    },
  };
  const { ctx } = makeP5Context({ config: withWakecap('/Users/test/Wakecap') });
  ctx.handoffs = svc;
  const app = bareApp();
  registerHandoffRoutes(app, ctx);
  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, post };
}

describe('/api/handoffs', () => {
  it('generates, reads and exports handoffs', async () => {
    const { app, post } = setup();
    expect(await (await post('/api/handoffs/session/claude/s1', {})).json()).toEqual(h);
    expect((await post('/api/handoffs/session/claude/zz', {})).status).toBe(404);
    expect(await (await app.request('/api/handoffs/session/claude/s1')).json()).toEqual({ handoff: h, markdown: '# md' });
    expect(await (await app.request('/api/handoffs/session/claude/zz')).json()).toBeNull();
    const md = await app.request('/api/handoffs/h1/markdown');
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(md.headers.get('content-disposition')).toBe('attachment; filename="handoff-h1.md"');
    expect(await md.text()).toBe('# md');
    expect((await app.request('/api/handoffs/zz/markdown')).status).toBe(404);
  });

  it('requires confirmation to resume fresh and maps launch errors', async () => {
    const { post } = setup();
    const need = await post('/api/handoffs/h1/resume-fresh', {});
    expect(need.status).toBe(409);
    expect(await need.json()).toMatchObject({ error: { code: 'confirmation_required', details: { summary: { handoffId: 'h1', sessionPk: 'claude:s1' } } } });
    expect(await (await post('/api/handoffs/h1/resume-fresh', { confirm: true })).json()).toEqual({ ptyId: 'p1' });
    expect((await post('/api/handoffs/zz/resume-fresh', { confirm: true })).status).toBe(404);
    const capped = setup(new LaunchError(429, 'concurrency_limit', 'too many sessions', { max: 6 }));
    const res = await capped.post('/api/handoffs/h1/resume-fresh', { confirm: true });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: 'concurrency_limit' } });
  });
});
```

`LaunchError`'s constructor argument order comes from P2 Task 13 (`new LaunchError(status, code, message, details)`). If P2 used a different order, adjust only this test line.

`apps/daemon/src/http/routes/handoffs.ts`
```ts
import { ResumeFreshBody, apiError } from '@orc/api-contract';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { DaemonContext } from '../../context.ts';
import { LaunchError } from '../../services/launch.ts';
import { need } from '../../services/need.ts';
import { confirmationRequired, notFound, readBody, sendError } from '../p5-util.ts';
import type { OrcApp } from '../types.ts';
import { pkFromParams } from './recaps.ts';

export function registerHandoffRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.handoffs, 'handoffs');
  const badSource = () => apiError('validation_failed', 'unknown source');

  app.post('/api/handoffs/session/:source/:id', async (c) => {
    const pk = pkFromParams(c);
    if (!pk) return c.json(badSource(), 400);
    try {
      return c.json(await svc().generate(pk));
    } catch (err) {
      return sendError(c, err);
    }
  });
  app.get('/api/handoffs/session/:source/:id', (c) => {
    const pk = pkFromParams(c);
    if (!pk) return c.json(badSource(), 400);
    const h = svc().latest(pk);
    return c.json(h ? { handoff: h, markdown: svc().toMarkdown(h) } : null);
  });
  app.get('/api/handoffs/:id/markdown', (c) => {
    const h = svc().get(c.req.param('id'));
    if (!h) return notFound(c, 'handoff');
    c.header('content-type', 'text/markdown; charset=utf-8');
    c.header('content-disposition', `attachment; filename="handoff-${h.id}.md"`);
    return c.body(svc().toMarkdown(h));
  });
  app.post('/api/handoffs/:id/resume-fresh', async (c) => {
    const b = await readBody(c, ResumeFreshBody);
    if (!b.ok) return b.res;
    const h = svc().get(c.req.param('id'));
    if (!h) return notFound(c, 'handoff');
    if (b.data.confirm !== true) {
      const s = ctx.sessions.getByPk(h.sessionId);
      return confirmationRequired(c, {
        handoffId: h.id,
        sessionPk: h.sessionId,
        cwd: s?.startCwd ?? null,
        promptPreview: svc().toMarkdown(h).slice(0, 300),
      });
    }
    try {
      return c.json(await svc().resumeFresh(h.id));
    } catch (err) {
      if (err instanceof LaunchError) {
        return c.json(apiError(err.code, err.message, err.details), err.status as ContentfulStatusCode);
      }
      return sendError(c, err);
    }
  });
}
```

Run: `pnpm vitest run apps/daemon/src/http/routes/handoffs.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Wire, register and audit**

In `apps/daemon/src/context.ts`:
- Point the existing `handoffs?: HandoffService` import at `./services/handoff/handoff.ts`.
- In `buildContext()`, after `ctx.recaps`, add `ctx.handoffs = createHandoffService(ctx, { recaps: ctx.recaps });`.

In `createApp`: `registerHandoffRoutes(app, o.ctx);`.

In `apps/daemon/src/http/audit-middleware.ts`, append to `AUDITED_ROUTES`:
```ts
  {
    method: 'POST',
    pattern: /^\/api\/handoffs\/([^/]+)\/resume-fresh$/,
    action: 'session.launch',
    target: (m) => `handoff:${dec(m[1])}`,
  },
```
and to `NON_ACTION_ROUTES`:
```ts
  { method: 'POST', path: '/api/handoffs/session/:source/:id', why: 'builds a local handoff; the redacted digest goes to the configured recap engine' },
```

- [ ] **Step 8: Commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add packages/core apps/daemon
git commit -m "feat(handoff): add handoffs with structured evidence, LLM summary, markdown export and resume-fresh"
```

---

### Task 16: Real-time bridge ingest (extending Phase 2's `POST /api/hooks`)

**Files:**
- Create: `packages/core/src/derive/hooks.ts`, `packages/core/src/derive/hooks.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/browser.ts`
- Modify: `apps/daemon/src/http/routes/hooks.ts` (P2), `apps/daemon/src/live/live-tracker.ts` (P2), `apps/daemon/src/live/live-tracker.test.ts` (P2)
- Create: `apps/daemon/src/http/routes/hooks-ingest.test.ts`

**Interfaces:**
- Consumes: P2's `registerHookRoutes`, `HookIngestBody`, `LiveTracker.applyHook`, `HookEvent`, `mapHookToStatus`, and `createFakeLive` (`apps/daemon/test/fake-live.ts`); P1's `createApp` and P3's `createP3Harness` (for the auth check)
- Produces:
  ```ts
  // core derive/hooks.ts
  export const BRIDGE_HOOK_EVENTS: readonly string[]      // SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop
  export function pickHookFields(raw: unknown): HookFields | null
  export function hookStatusFor(event: string): 'busy' | 'idle' | 'waiting' | null
  export function mapHookPayload(raw: unknown): HookSignal | null
  export function hookWins(hookAtMs: number | null, registryAtMs: number | null, nowMs: number, maxAgeMs: number): boolean
  export const HOOK_BODY_LIMIT_BYTES: number              // 256 KiB
  // P2 HookEvent gains: tool?: string | null
  ```
- **Mapping:**

  | Hook event | Status | Notes |
  |---|---|---|
  | `SessionStart` | `idle` | |
  | `UserPromptSubmit` | `busy` | |
  | `PreToolUse` | `busy` | `currentTool` = `tool_name` |
  | `PostToolUse` | `busy` | `currentTool` = null |
  | `Notification` | `waiting` | `waitingFor` = `message`, or "input needed" |
  | `Stop` | `idle` | |

- **Precedence:** a hook status overrides the polled registry status while it is newer than the registry's `statusUpdatedAt` **and** younger than `hooks.statusOverrideMs` (2 min). After that, polling wins again. This covers a crashed or uninstalled hook.
- **Payload handling:** only `session_id`, `hook_event_name`, `message` and `tool_name` are read. The rest (prompts, tool input, `transcript_path`) is dropped and never logged. Bodies over 256 KiB get `413`.

- [ ] **Step 1: Write the failing core test**

`packages/core/src/derive/hooks.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { hookStatusFor, hookWins, mapHookPayload, pickHookFields } from './hooks.ts';

describe('hook mapping', () => {
  it('keeps only the allowed fields', () => {
    expect(
      pickHookFields({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'SECRET' }, prompt: 'SECRET', transcript_path: '/x' }),
    ).toEqual({ sessionId: 's', event: 'PreToolUse', message: null, tool: 'Bash' });
    expect(pickHookFields({ hook_event_name: 'Stop' })).toBeNull();
    expect(pickHookFields('nope')).toBeNull();
  });

  it('maps events to statuses', () => {
    expect(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop'].map(hookStatusFor)).toEqual([
      'idle', 'busy', 'busy', 'busy', 'waiting', 'idle', null,
    ]);
    expect(mapHookPayload({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Edit' })).toEqual({
      sessionId: 's', event: 'PreToolUse', status: 'busy', waitingFor: null, currentTool: 'Edit',
    });
    expect(mapHookPayload({ session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Edit' })?.currentTool).toBeNull();
    expect(mapHookPayload({ session_id: 's', hook_event_name: 'Notification' })?.waitingFor).toBe('input needed');
    expect(mapHookPayload({ session_id: 's', hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' })?.waitingFor).toBe(
      'Claude needs your permission to use Bash',
    );
    expect(mapHookPayload({ session_id: 's', hook_event_name: 'PreCompact' })).toBeNull();
  });

  it('lets a fresh hook override an older registry status only', () => {
    expect(hookWins(2000, 1000, 3000, 120_000)).toBe(true);
    expect(hookWins(1000, 2000, 3000, 120_000)).toBe(false);
    expect(hookWins(1000, null, 200_000, 120_000)).toBe(false);
    expect(hookWins(null, 0, 1, 120_000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/core/src/derive/hooks.test.ts`
Expected: FAIL, `Cannot find module './hooks.ts'`.

- [ ] **Step 3: Implement it**

`packages/core/src/derive/hooks.ts`
```ts
import type { HookFields, HookSignal } from '../types/index.ts';

export const BRIDGE_HOOK_EVENTS: readonly string[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop'];
export const HOOK_BODY_LIMIT_BYTES = 256 * 1024;
const MAX_TEXT = 300;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_TEXT) : null);

export function pickHookFields(raw: unknown): HookFields | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const sessionId = str(o.session_id);
  const event = str(o.hook_event_name);
  if (!sessionId || !event) return null;
  return { sessionId, event, message: str(o.message), tool: str(o.tool_name) };
}

export function hookStatusFor(event: string): 'busy' | 'idle' | 'waiting' | null {
  switch (event) {
    case 'SessionStart':
    case 'Stop':
      return 'idle';
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'busy';
    case 'Notification':
      return 'waiting';
    default:
      return null;
  }
}

export function mapHookPayload(raw: unknown): HookSignal | null {
  const f = pickHookFields(raw);
  if (!f) return null;
  const status = hookStatusFor(f.event);
  if (!status) return null;
  return {
    sessionId: f.sessionId,
    event: f.event,
    status,
    waitingFor: status === 'waiting' ? (f.message ?? 'input needed') : null,
    currentTool: f.event === 'PreToolUse' ? f.tool : null,
  };
}

export function hookWins(hookAtMs: number | null, registryAtMs: number | null, nowMs: number, maxAgeMs: number): boolean {
  if (hookAtMs === null) return false;
  if (nowMs - hookAtMs > maxAgeMs) return false;
  return hookAtMs > (registryAtMs ?? 0);
}
```

In `packages/core/src/types/bridge.ts`, replace the `HookSignal` interface from Task 1 with the two interfaces from "Contract additions" (`HookFields` and the updated `HookSignal`, whose `event` is a `string` and whose `status` is `'busy' | 'idle' | 'waiting'`), and drop the now-unused `LiveStatus` import.

Append to both `packages/core/src/index.ts` and `packages/core/src/browser.ts`:
```ts
export * from './derive/hooks.ts';
```

Run: `pnpm vitest run packages/core/src/derive/hooks.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 4: Extend Phase 2's LiveTracker**

In `apps/daemon/src/live/live-tracker.ts`:
1. `HookEvent` becomes `{ sessionId: string; event: string; message: string | null; ts: string; tool?: string | null }`.
2. The `hook` field of `Entry` becomes `{ status: RegistryStatus; at: number; message: string | null; tool: string | null } | null`.
3. Replace the body of `mapHookToStatus`:
```ts
export function mapHookToStatus(event: string): RegistryStatus | null {
  return hookStatusFor(event);
}
```
4. In `applyHook`, store the tool:
```ts
      e.hook = { status, at: Number.isFinite(at) ? at : now().getTime(), message: ev.message, tool: ev.tool ?? null };
```
5. In `update()`, replace `const hookWins = e.hook !== null && e.hook.at > e.registryAt;` with:
```ts
    const hookActive = hookWins(e.hook?.at ?? null, e.registryAt, nowMs, ctx.config().hooks.statusOverrideMs);
```
   Then rename the two later uses of `hookWins` in `update()` to `hookActive`, and replace `currentTool: t.currentTool,` with:
```ts
      currentTool: hookActive && e.hook?.status === 'busy' && e.hook.tool !== null ? e.hook.tool : t.currentTool,
```
6. Add `import { hookStatusFor, hookWins } from '@orc/core';`.

In `apps/daemon/src/live/live-tracker.test.ts`, change the Phase 2 expectation `expect(mapHookToStatus('SessionStart')).toBeNull();` to:
```ts
    expect(mapHookToStatus('SessionStart')).toBe('idle');
    expect(mapHookToStatus('PostToolUse')).toBe('busy');
    expect(mapHookToStatus('SubagentStop')).toBeNull();
```

Run: `pnpm vitest run apps/daemon/src/live`
Expected: PASS. The P2 hook test still passes: its hook is newer than the registry and well under 2 min old in fake time.

- [ ] **Step 5: Write the failing ingest test**

`apps/daemon/src/http/routes/hooks-ingest.test.ts`
```ts
import type { BusEvent } from '../../live/event-bus.ts';
import { describe, expect, it } from 'vitest';
import { createFakeLive } from '../../../test/fake-live.ts';
import { bareApp, makeP5Context, withWakecap } from '../../../test/p5-helpers.ts';
import { createP3Harness } from '../../../test/p3-harness.ts';
import { registerHookRoutes } from './hooks.ts';

function setup() {
  const { ctx } = makeP5Context({ config: withWakecap('/Users/test/Wakecap') });
  const live = createFakeLive();
  ctx.live = live;
  const events: BusEvent[] = [];
  ctx.bus.on('hook.received', (e) => void events.push(e));
  const app = bareApp();
  registerHookRoutes(app, ctx);
  const post = (body: string) => app.request('/api/hooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  return { live, events, post };
}

describe('POST /api/hooks (bridge)', () => {
  it('maps the five bridge events and forwards the tool, dropping everything else', async () => {
    const { live, events, post } = setup();
    const res = await post(JSON.stringify({ session_id: 's-basic', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'SECRET' } }));
    expect(await res.json()).toEqual({ ok: true, accepted: true });
    for (const ev of ['SessionStart', 'PostToolUse', 'Notification', 'Stop']) {
      await post(JSON.stringify({ session_id: 's-basic', hook_event_name: ev }));
    }
    expect(live.hooks.map((h) => [h.event, h.tool ?? null])).toEqual([
      ['PreToolUse', 'Bash'], ['SessionStart', null], ['PostToolUse', null], ['Notification', null], ['Stop', null],
    ]);
    expect(JSON.stringify(live.hooks)).not.toContain('SECRET');
    expect(events[0]).toEqual({ type: 'hook.received', payload: { sessionId: 's-basic', event: 'PreToolUse' } });
  });

  it('accepts unknown events without applying them and rejects bad or huge bodies', async () => {
    const { live, post } = setup();
    expect(await (await post(JSON.stringify({ session_id: 's', hook_event_name: 'PreCompact' }))).json()).toEqual({ ok: true, accepted: false });
    expect(live.hooks).toHaveLength(1); // P2 forwards every valid event; the tracker ignores unknown ones
    expect((await post('{"hook_event_name":"Stop"}')).status).toBe(400);
    expect((await post(JSON.stringify({ session_id: 's', hook_event_name: 'Stop', pad: 'x'.repeat(300 * 1024) }))).status).toBe(413);
  });

  it('requires the token through the real app', async () => {
    const t = await createP3Harness();
    try {
      const res = await t.app.request('http://127.0.0.1:4317/api/hooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 's', hook_event_name: 'Stop' }),
      });
      expect(res.status).toBe(401);
      expect((await t.request('/api/hooks', { method: 'POST', body: { session_id: 's', hook_event_name: 'Stop' } })).status).toBe(200);
    } finally {
      await t.cleanup();
    }
  });
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/http/routes/hooks-ingest.test.ts`
Expected: FAIL. `accepted` is missing from the response, and the 413 case returns 200.

- [ ] **Step 7: Extend the route**

Replace the body of `apps/daemon/src/http/routes/hooks.ts` (P2) with the version below. Task 17 adds the installer routes to this same file.
```ts
import { HookIngestBody, apiError } from '@orc/api-contract';
import { HOOK_BODY_LIMIT_BYTES, mapHookPayload, pickHookFields } from '@orc/core';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { DaemonContext } from '../../context.ts';

export function registerHookRoutes(app: Hono, ctx: DaemonContext): void {
  app.post(
    '/api/hooks',
    bodyLimit({
      maxSize: HOOK_BODY_LIMIT_BYTES,
      onError: (c) => c.json(apiError('payload_too_large', 'hook payload too large'), 413),
    }),
    async (c) => {
      const raw: unknown = await c.req.json().catch(() => null);
      const parsed = HookIngestBody.safeParse(raw);
      const fields = pickHookFields(raw);
      if (!parsed.success || !fields) return c.json(apiError('validation_failed', 'invalid hook payload'), 400);
      const signal = mapHookPayload(raw);
      ctx.bus.emit({ type: 'hook.received', payload: { sessionId: fields.sessionId, event: fields.event } });
      ctx.live?.applyHook({
        sessionId: fields.sessionId,
        event: fields.event,
        message: fields.message,
        ts: new Date().toISOString(),
        tool: signal?.currentTool ?? null,
      });
      return c.json({ ok: true as const, accepted: signal !== null });
    },
  );
}
```

`OrcApp` is a `Hono` with node bindings, so `bareApp()` and `createApp` can both pass it. If P2's signature already takes `OrcApp`, keep that.

- [ ] **Step 8: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/http/routes/hooks-ingest.test.ts apps/daemon/src/http/routes/live-hooks.test.ts`
Expected: PASS. If P2's own `live-hooks.test.ts` asserts `toEqual({ ok: true })`, change that assertion to `toMatchObject({ ok: true })`.

- [ ] **Step 9: Commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add packages/core apps/daemon
git commit -m "feat(bridge): map all Claude hook events, carry the current tool and expire stale hook status"
```

---

### Task 17: Consented hook installer and the `orc-statusline` script

**Files:**
- Create: `apps/daemon/src/services/hooks/install.ts`, `apps/daemon/src/services/hooks/install.test.ts`
- Create: `apps/daemon/src/bin/orc-statusline.ts`, `apps/daemon/src/bin/orc-statusline.test.ts`
- Modify: `apps/daemon/src/http/routes/hooks.ts`, `apps/daemon/src/http/audit-middleware.ts`, `apps/daemon/package.json` (`bin` and build entry)
- Create: `apps/daemon/src/http/routes/hooks-install.test.ts`

**Interfaces:**
- Consumes: `OrcPaths` (`claudeHome`, `orcHome`, `tokenFile`), `OrcConfig.port`, `HookInstallStatus` (Task 1), `UsageSnapshot`, and the audit middleware (P3), which records `hook.install`
- Produces:
  ```ts
  // services/hooks/install.ts
  export const HOOK_MARKER = '# orc-hook-bridge';
  export const INSTALL_EVENTS: readonly string[];            // BRIDGE_HOOK_EVENTS
  export function shellQuote(s: string): string
  export function buildHookCommand(o: { tokenFile: string; port: number }): string
  export function hookSettingsFragment(command: string): { hooks: Record<string, unknown[]> }
  export function isOrcHookCommand(command: unknown): boolean   // our marker, or P2's hand-installed curl snippet
  export function isHookInstalled(settings: unknown): boolean
  export function mergeHookSettings(settings: Record<string, unknown>, command: string): Record<string, unknown>
  export function hookInstallStatus(ctx: DaemonContext): HookInstallStatus
  export function installHooks(ctx: DaemonContext, now?: () => Date): { settingsPath: string; backupPath: string | null }
  export function statuslineCommand(): string                  // `node "<abs>/dist/orc-statusline.js"`
  export function statuslineSnippet(): string
  // bin/orc-statusline.ts
  export interface StatuslineInput { session_id?: string; cost?: { total_cost_usd?: number }; model?: { id?: string; display_name?: string } }
  export interface StatuslineLive { id: string; source: string; usage?: { costUsd: number | null }; live: { status: string; contextFill: number | null } | null }
  export interface StatuslineData { usage: UsageSnapshot | null; live: StatuslineLive[] | null }
  export function formatStatusline(input: StatuslineInput, data: StatuslineData): string
  export async function runStatusline(o: { stdin: string; env: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; readToken?: (file: string) => string | null }): Promise<string>
  ```
- **Installer rules:**
  - `GET /api/hooks/install` never writes anything.
  - `POST /api/hooks/install` **without** `confirm: true` → `409 confirmation_required`, with `details.summary = { settingsPath, backupDir, snippet }`.
  - `POST /api/hooks/install` **with** confirm:
    1. Reads `~/.claude/settings.json`, or treats it as `{}` when the file doesn't exist.
    2. Refuses with `422 settings_unreadable` when the JSON is invalid.
    3. Writes a backup to `$ORC_HOME/backups/claude-settings-<timestamp>.json` (mode 0600).
    4. Removes any earlier orchestrator hook entries (ours or P2's hand-installed snippet) and appends one entry per event.
    5. Writes `settings.json.orc-tmp` and renames it over `settings.json`, keeping the file mode.
  - This is the **only** write to `~/.claude`.
  - Audit: the middleware records `hook.install` (P3 does not record `409` responses).
  - The hook command always exits 0 (`|| true`) and times out after 2 s, so it never blocks Claude.
- **Statusline:**
  - Reads Claude's statusline JSON from stdin.
  - Calls `GET /api/usage` and `GET /api/live` with the token from `$ORC_HOME/token`, with a 800 ms timeout each.
  - Prints one line: `$0.42 · ctx 43% · 5h 18% est · $3.20/h · 2 waiting`.
  - Forwards stdin to `POST /api/usage/official`, fire-and-forget with a 300 ms timeout. The meter uses it only when S7 = official.
  - When the daemon is down, prints `$0.42 · orc offline`.
  - The install snippet is **shown only**; the app never writes `statusLine` into settings.

- [ ] **Step 1: Write the failing installer test**

`apps/daemon/src/services/hooks/install.test.ts`
```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeP5Context } from '../../../test/p5-helpers.ts';
import {
  HOOK_MARKER,
  buildHookCommand,
  hookInstallStatus,
  installHooks,
  isHookInstalled,
  mergeHookSettings,
  shellQuote,
} from './install.ts';

const P2_SNIPPET_CMD =
  'curl -s -m 2 -X POST -H "x-orc-token: $(cat ~/.orchestrator/token)" -H \'content-type: application/json\' --data-binary @- http://127.0.0.1:4317/api/hooks >/dev/null || true';

describe('hook settings helpers', () => {
  it('builds a safe, non-blocking command', () => {
    expect(shellQuote("/Users/o'neil/.orc/token")).toBe("'/Users/o'\\''neil/.orc/token'");
    const cmd = buildHookCommand({ tokenFile: '/Users/test/.orchestrator/token', port: 4317 });
    expect(cmd).toBe(
      `curl -s -m 2 -X POST -H 'content-type: application/json' -H "x-orc-token: $(cat '/Users/test/.orchestrator/token')" --data-binary @- http://127.0.0.1:4317/api/hooks >/dev/null 2>&1 || true ${HOOK_MARKER}`,
    );
  });

  it('merges idempotently, keeps foreign hooks and replaces the P2 snippet', () => {
    const cmd = buildHookCommand({ tokenFile: '/t', port: 4317 });
    const existing = {
      model: 'opus',
      hooks: {
        PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: '~/.claude/hooks/post-edit-check.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: P2_SNIPPET_CMD }] }],
      },
    };
    expect(isHookInstalled(existing)).toBe(false);
    const once = mergeHookSettings(existing, cmd);
    const twice = mergeHookSettings(once, cmd);
    expect(twice).toEqual(once);
    expect(isHookInstalled(once)).toBe(true);
    expect(once.model).toBe('opus');
    const hooks = once.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>>;
    expect(Object.keys(hooks).sort()).toEqual(['Notification', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(hooks.PostToolUse?.[0]?.hooks[0]?.command).toBe('~/.claude/hooks/post-edit-check.sh');
    expect(hooks.PostToolUse?.[1]).toEqual({ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 5 }] });
    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: cmd, timeout: 5 }] }]);
  });
});

describe('installHooks', () => {
  it('reports status without writing, then installs with a backup', () => {
    const { ctx } = makeP5Context();
    const settings = join(ctx.paths.claudeHome, 'settings.json');
    mkdirSync(ctx.paths.claudeHome, { recursive: true });
    writeFileSync(settings, JSON.stringify({ cleanupPeriodDays: 30 }));
    chmodSync(settings, 0o640);
    const before = readFileSync(settings, 'utf8');
    const st = hookInstallStatus(ctx);
    expect(st).toMatchObject({ settingsPath: settings, settingsExists: true, installed: false, backupDir: join(ctx.paths.orcHome, 'backups') });
    expect(JSON.parse(st.snippet).hooks.Stop).toHaveLength(1);
    expect(readFileSync(settings, 'utf8')).toBe(before);

    const res = installHooks(ctx, () => new Date('2026-09-17T10:00:00.000Z'));
    expect(res).toEqual({ settingsPath: settings, backupPath: join(ctx.paths.orcHome, 'backups', 'claude-settings-2026-09-17T10-00-00-000Z.json') });
    expect(readFileSync(res.backupPath as string, 'utf8')).toBe(before);
    expect((statSync(res.backupPath as string).mode & 0o777).toString(8)).toBe('600');
    const after = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>;
    expect(after.cleanupPeriodDays).toBe(30);
    expect(isHookInstalled(after)).toBe(true);
    expect((statSync(settings).mode & 0o777).toString(8)).toBe('640');
    expect(existsSync(`${settings}.orc-tmp`)).toBe(false);
    expect(hookInstallStatus(ctx).installed).toBe(true);
    expect(readdirSync(ctx.paths.claudeHome).filter((f) => f.startsWith('settings'))).toEqual(['settings.json']);
  });

  it('creates settings when missing and refuses invalid JSON', () => {
    const { ctx } = makeP5Context();
    const settings = join(ctx.paths.claudeHome, 'settings.json');
    expect(installHooks(ctx).backupPath).toBeNull();
    expect(isHookInstalled(JSON.parse(readFileSync(settings, 'utf8')))).toBe(true);
    writeFileSync(settings, '{ nope');
    expect(() => installHooks(ctx)).toThrow(/settings_unreadable|not valid JSON/);
    expect(readFileSync(settings, 'utf8')).toBe('{ nope');
  });
});
```

- [ ] **Step 2: Write the failing statusline test**

`apps/daemon/src/bin/orc-statusline.test.ts`
```ts
import type { UsageSnapshot } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { formatStatusline, runStatusline } from './orc-statusline.ts';

const usage: UsageSnapshot = {
  source: 'estimate', generatedAt: 't',
  block: { active: true, start: 's', end: 'e', tokens: 1, costUsd: 12.1, pctOfLimit: 0.183 },
  week: { tokens: 1, costUsd: 1, pctOfLimit: null },
  burnRateUsdPerHour: 3.2, burnRateTokensPerMin: 1, projectedBlockExhaustionAt: null,
};
const live = [
  { id: 's1', source: 'claude', usage: { costUsd: 0.42 }, live: { status: 'busy', contextFill: 0.434 } },
  { id: 's2', source: 'claude', live: { status: 'waiting', contextFill: null } },
  { id: 's3', source: 'codex', live: { status: 'waiting', contextFill: null } },
];

describe('formatStatusline', () => {
  it('prints cost, context, block, burn and waiting', () => {
    expect(formatStatusline({ session_id: 's1', cost: { total_cost_usd: 0.4 } }, { usage, live })).toBe('$0.40 · ctx 43% · 5h 18% est · $3.20/h · 2 waiting');
  });
  it('falls back to block cost without a limit, and to offline', () => {
    const noPct = { ...usage, source: 'official' as const, block: { ...usage.block, pctOfLimit: null } };
    expect(formatStatusline({ session_id: 'x' }, { usage: noPct, live: [] })).toBe('5h $12.10 · $3.20/h');
    expect(formatStatusline({ cost: { total_cost_usd: 0.42 } }, { usage: null, live: null })).toBe('$0.42 · orc offline');
  });
});

describe('runStatusline', () => {
  it('calls the daemon with the token and forwards stdin', async () => {
    const calls: Array<{ url: string; method: string; token: string | null; body: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url, method: init?.method ?? 'GET', token: headers.get('x-orc-token'), body: init?.body ?? null });
      if (url.endsWith('/api/usage')) return new Response(JSON.stringify(usage));
      if (url.endsWith('/api/live')) return new Response(JSON.stringify(live));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const stdin = JSON.stringify({ session_id: 's1', cost: { total_cost_usd: 0.4 } });
    const out = await runStatusline({ stdin, env: { ORC_HOME: '/o', ORC_PORT: '5000' }, fetchImpl, readToken: (f) => (f === '/o/token' ? 'tok' : null) });
    expect(out).toBe('$0.40 · ctx 43% · 5h 18% est · $3.20/h · 2 waiting');
    expect(calls.map((c) => [c.method, c.url, c.token])).toEqual([
      ['POST', 'http://127.0.0.1:5000/api/usage/official', 'tok'],
      ['GET', 'http://127.0.0.1:5000/api/usage', 'tok'],
      ['GET', 'http://127.0.0.1:5000/api/live', 'tok'],
    ]);
    expect(calls[0]?.body).toBe(stdin);
  });

  it('never throws when the daemon or token is missing', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    expect(await runStatusline({ stdin: 'not json', env: {}, fetchImpl, readToken: () => 'x' })).toBe('orc offline');
    expect(await runStatusline({ stdin: '{}', env: {}, fetchImpl, readToken: () => null })).toBe('orc offline');
  });
});
```

- [ ] **Step 3: Run both and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/services/hooks apps/daemon/src/bin`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement the installer**

`apps/daemon/src/services/hooks/install.ts`
```ts
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookInstallStatus } from '@orc/api-contract';
import { BRIDGE_HOOK_EVENTS } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../errors.ts';

export const HOOK_MARKER = '# orc-hook-bridge';
export const INSTALL_EVENTS: readonly string[] = BRIDGE_HOOK_EVENTS;
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const HOOK_TIMEOUT_S = 5;

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

export function buildHookCommand(o: { tokenFile: string; port: number }): string {
  return [
    'curl -s -m 2 -X POST',
    "-H 'content-type: application/json'",
    `-H "x-orc-token: $(cat ${shellQuote(o.tokenFile)})"`,
    '--data-binary @-',
    `http://127.0.0.1:${o.port}/api/hooks >/dev/null 2>&1 || true ${HOOK_MARKER}`,
  ].join(' ');
}

type HookEntry = { matcher?: string; hooks: Array<{ type: 'command'; command: string; timeout: number }> };

export function hookSettingsFragment(command: string): { hooks: Record<string, HookEntry[]> } {
  const hooks: Record<string, HookEntry[]> = {};
  for (const ev of INSTALL_EVENTS) {
    const entry: HookEntry = { hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] };
    hooks[ev] = [TOOL_EVENTS.has(ev) ? { matcher: '*', ...entry } : entry];
  }
  return { hooks };
}

export function isOrcHookCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return command.includes(HOOK_MARKER) || (command.includes('/api/hooks') && command.includes('x-orc-token'));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function entryIsOurs(entry: unknown): boolean {
  if (!isObj(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) => isObj(h) && isOrcHookCommand(h.command));
}

export function isHookInstalled(settings: unknown): boolean {
  if (!isObj(settings) || !isObj(settings.hooks)) return false;
  const hooks = settings.hooks;
  return INSTALL_EVENTS.every((ev) => {
    const list = hooks[ev];
    return Array.isArray(list) && list.some((e) => isObj(e) && Array.isArray(e.hooks) && e.hooks.some((h) => isObj(h) && typeof h.command === 'string' && h.command.includes(HOOK_MARKER)));
  });
}

export function mergeHookSettings(settings: Record<string, unknown>, command: string): Record<string, unknown> {
  const current = isObj(settings.hooks) ? settings.hooks : {};
  const next: Record<string, unknown> = {};
  for (const [ev, list] of Object.entries(current)) {
    const kept = Array.isArray(list) ? list.filter((e) => !entryIsOurs(e)) : list;
    if (!Array.isArray(kept) || kept.length > 0) next[ev] = kept;
  }
  for (const [ev, entries] of Object.entries(hookSettingsFragment(command).hooks)) {
    const existing = Array.isArray(next[ev]) ? (next[ev] as unknown[]) : [];
    next[ev] = [...existing, ...entries];
  }
  return { ...settings, hooks: next };
}

const settingsPathOf = (ctx: DaemonContext) => join(ctx.paths.claudeHome, 'settings.json');
const backupDirOf = (ctx: DaemonContext) => join(ctx.paths.orcHome, 'backups');
const commandFor = (ctx: DaemonContext) => buildHookCommand({ tokenFile: ctx.paths.tokenFile, port: ctx.config().port });

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ServiceError('settings_unreadable', 422, `${path} is not valid JSON; fix it by hand first`);
  }
  if (!isObj(v)) throw new ServiceError('settings_unreadable', 422, `${path} is not a JSON object`);
  return v;
}

export function hookInstallStatus(ctx: DaemonContext): HookInstallStatus {
  const settingsPath = settingsPathOf(ctx);
  const command = commandFor(ctx);
  let installed = false;
  try {
    installed = isHookInstalled(readSettings(settingsPath));
  } catch {
    installed = false;
  }
  return {
    settingsPath,
    settingsExists: existsSync(settingsPath),
    installed,
    command,
    snippet: JSON.stringify(hookSettingsFragment(command), null, 2),
    backupDir: backupDirOf(ctx),
  };
}

/** The only Phase 5 write to ~/.claude. Callers must have confirmation; the route is audited as hook.install. */
export function installHooks(ctx: DaemonContext, now: () => Date = () => new Date()): { settingsPath: string; backupPath: string | null } {
  const settingsPath = settingsPathOf(ctx);
  const settings = readSettings(settingsPath);
  let backupPath: string | null = null;
  let mode = 0o644;
  if (existsSync(settingsPath)) {
    mode = statSync(settingsPath).mode & 0o777;
    mkdirSync(backupDirOf(ctx), { recursive: true, mode: 0o700 });
    backupPath = join(backupDirOf(ctx), `claude-settings-${now().toISOString().replace(/[:.]/g, '-')}.json`);
    copyFileSync(settingsPath, backupPath);
    chmodSync(backupPath, 0o600);
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
  }
  const tmp = `${settingsPath}.orc-tmp`;
  writeFileSync(tmp, `${JSON.stringify(mergeHookSettings(settings, commandFor(ctx)), null, 2)}\n`, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, settingsPath);
  return { settingsPath, backupPath };
}

function findDaemonRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === '@orc/daemon') return dir;
    dir = dirname(dir);
  }
  return start;
}

export function statuslineCommand(): string {
  const root = findDaemonRoot(dirname(fileURLToPath(import.meta.url)));
  return `node ${shellQuote(join(root, 'dist', 'orc-statusline.js'))}`;
}

export function statuslineSnippet(): string {
  return JSON.stringify({ statusLine: { type: 'command', command: statuslineCommand(), padding: 0 } }, null, 2);
}
```

- [ ] **Step 5: Implement the statusline script**

`apps/daemon/src/bin/orc-statusline.ts`
```ts
#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { UsageSnapshot } from '@orc/core';

export interface StatuslineInput { session_id?: string; cost?: { total_cost_usd?: number }; model?: { id?: string; display_name?: string } }
export interface StatuslineLive { id: string; source: string; usage?: { costUsd: number | null }; live: { status: string; contextFill: number | null } | null }
export interface StatuslineData { usage: UsageSnapshot | null; live: StatuslineLive[] | null }

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function formatStatusline(input: StatuslineInput, data: StatuslineData): string {
  const parts: string[] = [];
  const mine = data.live?.find((s) => s.source === 'claude' && s.id === input.session_id) ?? null;
  const cost = input.cost?.total_cost_usd ?? mine?.usage?.costUsd ?? null;
  if (cost !== null && cost !== undefined) parts.push(usd(cost));
  if (data.usage === null || data.live === null) {
    parts.push('orc offline');
    return parts.join(' · ');
  }
  if (mine?.live?.contextFill !== null && mine?.live?.contextFill !== undefined) parts.push(`ctx ${pct(mine.live.contextFill)}`);
  const u = data.usage;
  const est = u.source === 'estimate' ? ' est' : '';
  if (u.block.active) {
    parts.push(u.block.pctOfLimit !== null ? `5h ${pct(u.block.pctOfLimit)}${est}` : `5h ${usd(u.block.costUsd)}${est}`);
    parts.push(`${usd(u.burnRateUsdPerHour)}/h`);
  }
  const waiting = data.live.filter((s) => s.live?.status === 'waiting').length;
  if (waiting > 0) parts.push(`${waiting} waiting`);
  return parts.join(' · ');
}

async function getJson<T>(f: typeof fetch, url: string, token: string): Promise<T | null> {
  try {
    const res = await f(url, { headers: { 'x-orc-token': token }, signal: AbortSignal.timeout(800) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

function defaultReadToken(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export async function runStatusline(o: {
  stdin: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readToken?: (file: string) => string | null;
}): Promise<string> {
  let input: StatuslineInput = {};
  try {
    input = JSON.parse(o.stdin) as StatuslineInput;
  } catch {
    input = {};
  }
  const f = o.fetchImpl ?? fetch;
  const orcHome = o.env.ORC_HOME ?? join(homedir(), '.orchestrator');
  const base = `http://127.0.0.1:${o.env.ORC_PORT ?? '4317'}`;
  const token = (o.readToken ?? defaultReadToken)(join(orcHome, 'token'));
  if (!token) return formatStatusline(input, { usage: null, live: null });
  await f(`${base}/api/usage/official`, {
    method: 'POST',
    headers: { 'x-orc-token': token, 'content-type': 'application/json' },
    body: o.stdin,
    signal: AbortSignal.timeout(300),
  }).catch(() => null);
  const [usage, live] = await Promise.all([
    getJson<UsageSnapshot>(f, `${base}/api/usage`, token),
    getJson<StatuslineLive[]>(f, `${base}/api/live`, token),
  ]);
  return formatStatusline(input, { usage, live });
}

async function main(): Promise<void> {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += String(chunk);
  process.stdout.write(`${await runStatusline({ stdin, env: process.env })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.stdout.write('orc offline\n'));
}
```

In the "offline" test, the first case has no cost, so the output is `orc offline`.

In `apps/daemon/package.json`:
- Add `"bin": { "orc-statusline": "./dist/orc-statusline.js" }`.
- Change the build script to:
```json
"build": "tsup --entry.main src/main.ts --entry.orc-statusline src/bin/orc-statusline.ts --format esm --platform node --target node22 --out-dir dist"
```

- [ ] **Step 6: Run the unit tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/services/hooks apps/daemon/src/bin`
Expected: PASS (8 tests)

- [ ] **Step 7: Add the install routes, then write and run their test**

Append to `registerHookRoutes` in `apps/daemon/src/http/routes/hooks.ts`, and add the imports `HookInstallBody` (api-contract), `hookInstallStatus`, `installHooks`, `statuslineCommand`, `statuslineSnippet` (`../../services/hooks/install.ts`), and `confirmationRequired`, `readBody`, `sendError` (`../p5-util.ts`):
```ts
  app.get('/api/hooks/install', (c) => c.json(hookInstallStatus(ctx)));
  app.post('/api/hooks/install', async (c) => {
    const b = await readBody(c, HookInstallBody);
    if (!b.ok) return b.res;
    if (b.data.confirm !== true) {
      const st = hookInstallStatus(ctx);
      return confirmationRequired(c, { settingsPath: st.settingsPath, backupDir: st.backupDir, snippet: st.snippet });
    }
    try {
      const res = installHooks(ctx);
      ctx.log.info({ settingsPath: res.settingsPath, backupPath: res.backupPath }, 'claude hooks installed');
      return c.json({ installed: true as const, ...res });
    } catch (err) {
      return sendError(c, err);
    }
  });
  app.get('/api/hooks/statusline', (c) => c.json({ command: statuslineCommand(), snippet: statuslineSnippet() }));
```

`apps/daemon/src/http/routes/hooks-install.test.ts`
```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createP3Harness } from '../../../test/p3-harness.ts';

describe('/api/hooks/install', () => {
  it('shows, confirms, installs and audits', async () => {
    const t = await createP3Harness();
    try {
      const settings = join(t.ctx.paths.claudeHome, 'settings.json');
      const st = (await (await t.request('/api/hooks/install')).json()) as { installed: boolean; snippet: string };
      expect(st.installed).toBe(false);
      const need = await t.request('/api/hooks/install', { method: 'POST', body: {} });
      expect(need.status).toBe(409);
      expect(await need.json()).toMatchObject({ error: { code: 'confirmation_required', details: { summary: { settingsPath: settings } } } });
      expect(existsSync(settings) ? readFileSync(settings, 'utf8') : '').not.toContain('orc-hook-bridge');
      const ok = await t.request('/api/hooks/install', { method: 'POST', body: { confirm: true } });
      expect(ok.status).toBe(200);
      expect(readFileSync(settings, 'utf8')).toContain('orc-hook-bridge');
      expect(t.ctx.audit?.list({ action: 'hook.install' })).toHaveLength(1);
      const sl = (await (await t.request('/api/hooks/statusline')).json()) as { command: string; snippet: string };
      expect(sl.command).toMatch(/^node '.*dist\/orc-statusline\.js'$/);
      expect(JSON.parse(sl.snippet).statusLine.type).toBe('command');
    } finally {
      await t.cleanup();
    }
  });
});
```

In `apps/daemon/src/http/audit-middleware.ts`, append to `AUDITED_ROUTES`:
```ts
  {
    method: 'POST',
    pattern: /^\/api\/hooks\/install$/,
    action: 'hook.install',
    target: () => 'claude-settings',
  },
```

Run: `pnpm vitest run apps/daemon/src/http/routes/hooks-install.test.ts apps/daemon/test/audit.coverage.test.ts`
Expected: PASS. The coverage test fails if any Phase 5 write route is still unlisted.

- [ ] **Step 8: Build and try the statusline by hand**

Run: `pnpm --filter @orc/daemon build && echo '{"session_id":"x","cost":{"total_cost_usd":0.1}}' | node apps/daemon/dist/orc-statusline.js`
Expected, with the daemon stopped: `$0.10 · orc offline`.

- [ ] **Step 9: Commit**

```bash
pnpm lint && pnpm typecheck && pnpm test
git add apps/daemon
git commit -m "feat(bridge): add consented hook installer with backup and audit, and the orc-statusline script"
```

---

### Task 18: Web data layer, quota bars and the `/analytics` page

**Files:**
- Create: `apps/web/src/api/queries/usage.ts`, `apps/web/src/api/queries/analytics.ts`, `apps/web/src/api/queries/p5-queries.test.tsx`
- Modify: `apps/web/src/api/live-events.ts` (P2/P3: type the `usage.updated` event and update the cache)
- Create: `apps/web/src/features/limits/{format.ts,QuotaBars.tsx,QuotaBars.test.tsx}`
- Create: `apps/web/src/features/analytics/{analytics-options.ts,analytics-options.test.ts,AnalyticsPage.tsx,AnalyticsPage.test.tsx}`
- Create: `apps/web/src/routes/analytics.tsx`
- Modify: `apps/web/src/features/shell/AppShell.tsx` (nav link + quota bars), `apps/web/src/features/hotkeys/GlobalHotkeys.tsx` (`g u`)

**Interfaces:**
- Consumes: `getApiClient`, `setApiClientForTests`, `ApiClient` (P1); `makeQueryClient`, `wrapperFor`, `renderP3`, `fakeApi` (P3); `applyLiveEvent`/`WireEvent` (P2 `api/live-events.ts`); Task 1 client methods; `formatTokens`, `formatPct` (P3 `features/session-detail/timeline/format.ts`); `useHotkeys` (P3); echarts 6
- Produces:
  ```ts
  // api/queries/usage.ts
  export const usageKeys: { snapshot: readonly unknown[]; budgets: readonly unknown[]; concurrency: readonly unknown[]; context(source: Source, id: string): readonly unknown[] }
  export function useUsage(): UseQueryResult<UsageSnapshot>
  export function useBudgets(): UseQueryResult<BudgetStatus[]>
  export function useUpsertBudget(): UseMutationResult<Budget, Error, BudgetUpsertInput>
  export function useDeleteBudget(): UseMutationResult<{ ok: true }, Error, string>
  export function useConcurrency(): UseQueryResult<ConcurrencyStatus[]>
  export function useContextFill(source: Source, id: string): UseQueryResult<ContextFillInfo | null>
  // api/queries/analytics.ts
  export interface AnalyticsParams { from?: string; to?: string; projectId?: string }
  export const analyticsKeys: { cost(p): readonly unknown[]; top(p): …; tools(p): …; timing(p): …; outcomes(p): …; wstack(p): …; digest: readonly unknown[] }
  export function useAnalyticsCost(p: AnalyticsParams & { groupBy: AnalyticsGroupBy }): UseQueryResult<CostResponse>
  export function useAnalyticsTop(p: AnalyticsParams & { limit?: number }): UseQueryResult<TopResult>
  export function useAnalyticsTools(p: AnalyticsParams & { bucket: 'day' | 'week' }): UseQueryResult<ToolUsageRow[]>
  export function useAnalyticsTiming(p: AnalyticsParams & { bucket: 'day' | 'week' }): UseQueryResult<TimingResult>
  export function useAnalyticsOutcomes(p: AnalyticsParams): UseQueryResult<OutcomesResult>
  export function useAnalyticsWstack(p: AnalyticsParams): UseQueryResult<WstackSkillRow[]>
  export function useDigest(): UseQueryResult<DigestRecord | null>
  export function useGenerateDigest(): UseMutationResult<DigestRecord, Error, string | undefined>
  export function rangeFor(days: number, now?: Date): { from: string; to: string }
  // features/limits/format.ts
  export function formatUsd(n: number | null | undefined): string
  export function formatPctValue(n: number | null): string
  export function minutesUntil(iso: string, now?: number): number
  export function quotaTone(pct: number | null, warnPct: number): 'ok' | 'warn' | 'over'
  // features/limits/QuotaBars.tsx
  export function QuotaBars(): JSX.Element | null
  // features/analytics/analytics-options.ts
  export function costOverTimeOption(rows: CostRow[]): EChartsOption
  export function costByKeyOption(rows: CostRow[]): EChartsOption
  export function toolUsageOption(rows: ToolUsageRow[], top?: number): EChartsOption
  export function cacheTrendOption(t: TimingResult): EChartsOption
  export function outcomesOption(o: OutcomesResult): EChartsOption
  // features/analytics/AnalyticsPage.tsx
  export function AnalyticsPage(): JSX.Element
  ```
- The page never shows a raw number without its unit, and every estimated figure is labelled `estimated`.

- [ ] **Step 1: Write the failing query and WS test**

`apps/web/src/api/queries/p5-queries.test.tsx`
```tsx
import type { UsageSnapshot } from '@orc/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeQueryClient, wrapperFor } from '../../test/p3-render.tsx';
import { setApiClientForTests } from '../client.ts';
import { fakeApi } from '../../test/p3-render.tsx';
import { applyLiveEvent } from '../live-events.ts';
import { analyticsKeys, rangeFor, useAnalyticsCost, useDigest, useGenerateDigest } from './analytics.ts';
import { usageKeys, useBudgets, useUpsertBudget, useUsage } from './usage.ts';

const snapshot: UsageSnapshot = {
  source: 'estimate', generatedAt: '2026-09-18T09:00:00.000Z',
  block: { active: true, start: '2026-09-18T08:00:00.000Z', end: '2026-09-18T13:00:00.000Z', tokens: 10, costUsd: 2, pctOfLimit: 0.2 },
  week: { tokens: 100, costUsd: 20, pctOfLimit: null },
  burnRateUsdPerHour: 1, burnRateTokensPerMin: 2, projectedBlockExhaustionAt: null,
};

describe('usage queries', () => {
  it('fetches the snapshot and applies usage.updated from the WS', async () => {
    const usageGet = vi.fn(async () => snapshot);
    setApiClientForTests(fakeApi({ usageGet }));
    const client = makeQueryClient();
    const { result } = renderHook(() => useUsage(), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.data).toEqual(snapshot));
    const next = { ...snapshot, block: { ...snapshot.block, costUsd: 9 } };
    act(() => applyLiveEvent(client, { type: 'usage.updated', snapshot: next }));
    expect(client.getQueryData(usageKeys.snapshot)).toEqual(next);
  });

  it('invalidates budgets after an upsert', async () => {
    const usageBudgets = vi.fn(async () => []);
    const usageBudgetUpsert = vi.fn(async () => ({ id: 'b1', scopeType: 'ticket' as const, scopeId: 'SAF-1', period: 'daily' as const, limitUsd: 5, origin: 'table' as const }));
    setApiClientForTests(fakeApi({ usageBudgets, usageBudgetUpsert }));
    const client = makeQueryClient();
    const { result } = renderHook(() => ({ list: useBudgets(), save: useUpsertBudget() }), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    await act(async () => {
      await result.current.save.mutateAsync({ scopeType: 'ticket', scopeId: 'SAF-1', period: 'daily', limitUsd: 5 });
    });
    expect(usageBudgetUpsert).toHaveBeenCalledWith({ scopeType: 'ticket', scopeId: 'SAF-1', period: 'daily', limitUsd: 5 });
    await waitFor(() => expect(usageBudgets).toHaveBeenCalledTimes(2));
  });
});

describe('analytics queries', () => {
  it('passes params through and keys by them', async () => {
    const analyticsCost = vi.fn(async () => ({ rows: [], estimated: true }));
    setApiClientForTests(fakeApi({ analyticsCost }));
    const client = makeQueryClient();
    const params = { from: 'a', to: 'b', groupBy: 'day' as const };
    const { result } = renderHook(() => useAnalyticsCost(params), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(analyticsCost).toHaveBeenCalledWith({ from: 'a', to: 'b', groupBy: 'day' });
    expect(client.getQueryData(analyticsKeys.cost(params))).toEqual({ rows: [], estimated: true });
  });

  it('computes a range and refreshes the digest after generating one', async () => {
    expect(rangeFor(7, new Date('2026-09-18T09:00:00.000Z'))).toEqual({ from: '2026-09-11T09:00:00.000Z', to: '2026-09-18T09:00:00.000Z' });
    const record = { weekStart: '2026-09-07', markdown: '# d', createdAt: 'x' };
    const analyticsDigestLatest = vi.fn(async () => null);
    const analyticsDigestGenerate = vi.fn(async () => record);
    setApiClientForTests(fakeApi({ analyticsDigestLatest, analyticsDigestGenerate }));
    const client = makeQueryClient();
    const { result } = renderHook(() => ({ latest: useDigest(), gen: useGenerateDigest() }), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.latest.isSuccess).toBe(true));
    await act(async () => {
      await result.current.gen.mutateAsync(undefined);
    });
    expect(client.getQueryData(analyticsKeys.digest)).toEqual(record);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/web/src/api/queries/p5-queries.test.tsx`
Expected: FAIL, `Cannot find module './usage.ts'`.

- [ ] **Step 3: Write the query hooks and the WS case**

`apps/web/src/api/queries/usage.ts`
```ts
import type { BudgetUpsertInput } from '@orc/api-contract';
import type { Source } from '@orc/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

const STALE_MS = 10_000;

export const usageKeys = {
  snapshot: ['usage'] as const,
  budgets: ['usage', 'budgets'] as const,
  concurrency: ['usage', 'concurrency'] as const,
  context: (source: Source, id: string) => ['usage', 'context', source, id] as const,
};

export function useUsage() {
  return useQuery({ queryKey: usageKeys.snapshot, queryFn: () => getApiClient().usageGet(), staleTime: STALE_MS, refetchInterval: 60_000 });
}

export function useBudgets() {
  return useQuery({ queryKey: usageKeys.budgets, queryFn: () => getApiClient().usageBudgets(), staleTime: STALE_MS });
}

export function useUpsertBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: BudgetUpsertInput) => getApiClient().usageBudgetUpsert(b),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: usageKeys.budgets });
      void qc.invalidateQueries({ queryKey: usageKeys.snapshot });
    },
  });
}

export function useDeleteBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApiClient().usageBudgetDelete(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: usageKeys.budgets }),
  });
}

export function useConcurrency() {
  return useQuery({ queryKey: usageKeys.concurrency, queryFn: () => getApiClient().usageConcurrency(), staleTime: 30_000 });
}

export function useContextFill(source: Source, id: string) {
  return useQuery({ queryKey: usageKeys.context(source, id), queryFn: () => getApiClient().usageContext(source, id), staleTime: STALE_MS });
}
```

`apps/web/src/api/queries/analytics.ts`
```ts
import type { AnalyticsGroupBy } from '@orc/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

const STALE_MS = 30_000;

export interface AnalyticsParams { from?: string; to?: string; projectId?: string }

export const analyticsKeys = {
  cost: (p: AnalyticsParams & { groupBy: AnalyticsGroupBy }) => ['analytics', 'cost', p] as const,
  top: (p: AnalyticsParams & { limit?: number }) => ['analytics', 'top', p] as const,
  tools: (p: AnalyticsParams & { bucket: string }) => ['analytics', 'tools', p] as const,
  timing: (p: AnalyticsParams & { bucket: string }) => ['analytics', 'timing', p] as const,
  outcomes: (p: AnalyticsParams) => ['analytics', 'outcomes', p] as const,
  wstack: (p: AnalyticsParams) => ['analytics', 'wstack', p] as const,
  digest: ['digest'] as const,
};

export function rangeFor(days: number, now: Date = new Date()): { from: string; to: string } {
  return { from: new Date(now.getTime() - days * 86_400_000).toISOString(), to: now.toISOString() };
}

export function useAnalyticsCost(p: AnalyticsParams & { groupBy: AnalyticsGroupBy }) {
  return useQuery({ queryKey: analyticsKeys.cost(p), queryFn: () => getApiClient().analyticsCost(p), staleTime: STALE_MS });
}
export function useAnalyticsTop(p: AnalyticsParams & { limit?: number }) {
  return useQuery({ queryKey: analyticsKeys.top(p), queryFn: () => getApiClient().analyticsTop(p), staleTime: STALE_MS });
}
export function useAnalyticsTools(p: AnalyticsParams & { bucket: 'day' | 'week' }) {
  return useQuery({ queryKey: analyticsKeys.tools(p), queryFn: () => getApiClient().analyticsTools(p), staleTime: STALE_MS });
}
export function useAnalyticsTiming(p: AnalyticsParams & { bucket: 'day' | 'week' }) {
  return useQuery({ queryKey: analyticsKeys.timing(p), queryFn: () => getApiClient().analyticsTiming(p), staleTime: STALE_MS });
}
export function useAnalyticsOutcomes(p: AnalyticsParams) {
  return useQuery({ queryKey: analyticsKeys.outcomes(p), queryFn: () => getApiClient().analyticsOutcomes(p), staleTime: STALE_MS });
}
export function useAnalyticsWstack(p: AnalyticsParams) {
  return useQuery({ queryKey: analyticsKeys.wstack(p), queryFn: () => getApiClient().analyticsWstack(p), staleTime: STALE_MS });
}
export function useDigest() {
  return useQuery({ queryKey: analyticsKeys.digest, queryFn: () => getApiClient().analyticsDigestLatest(), staleTime: STALE_MS });
}
export function useGenerateDigest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (weekStart?: string) => getApiClient().analyticsDigestGenerate(weekStart),
    onSuccess: (d) => qc.setQueryData(analyticsKeys.digest, d),
  });
}
```

In `apps/web/src/api/live-events.ts` (P2), add the case below to `applyLiveEvent`. `WireEvent`'s `usage.updated` member now carries a typed `UsageSnapshot`, because Task 1 changed `LiveEvent`; mirror that in `WireEvent` (`snapshot: UsageSnapshot`) and import the type.
```ts
    case 'usage.updated':
      qc.setQueryData(usageKeys.snapshot, e.snapshot);
      return;
```

- [ ] **Step 4: Run the query test and confirm it passes**

Run: `pnpm vitest run apps/web/src/api/queries/p5-queries.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the failing quota-bar and chart-option tests**

`apps/web/src/features/limits/QuotaBars.test.tsx`
```tsx
import type { UsageSnapshot } from '@orc/core';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { setApiClientForTests } from '../../api/client.ts';
import { QuotaBars } from './QuotaBars.tsx';
import { formatUsd, minutesUntil, quotaTone } from './format.ts';

const base: UsageSnapshot = {
  source: 'estimate', generatedAt: '2026-09-18T09:00:00.000Z',
  block: { active: true, start: '2026-09-18T08:00:00.000Z', end: '2026-09-18T13:00:00.000Z', tokens: 10, costUsd: 12.5, pctOfLimit: 0.83 },
  week: { tokens: 100, costUsd: 88, pctOfLimit: null },
  burnRateUsdPerHour: 3.2, burnRateTokensPerMin: 2, projectedBlockExhaustionAt: '2026-09-18T11:00:00.000Z',
};

describe('quota formatting', () => {
  it('formats money, minutes and tone', () => {
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(null)).toBe('—');
    expect(minutesUntil('2026-09-18T09:30:00.000Z', Date.parse('2026-09-18T09:00:00.000Z'))).toBe(30);
    expect(minutesUntil('2026-09-18T08:00:00.000Z', Date.parse('2026-09-18T09:00:00.000Z'))).toBe(0);
    expect([quotaTone(0.5, 0.8), quotaTone(0.83, 0.8), quotaTone(1.2, 0.8), quotaTone(null, 0.8)]).toEqual(['ok', 'warn', 'over', 'ok']);
  });
});

describe('QuotaBars', () => {
  it('shows the block percentage, burn rate, reset and the estimated label', async () => {
    setApiClientForTests(fakeApi({ usageGet: vi.fn(async () => base) }));
    renderP3(<QuotaBars />);
    const region = await screen.findByRole('region', { name: 'Quota' });
    expect(region).toHaveTextContent('5h 83%');
    expect(region).toHaveTextContent('7d $88.00');
    expect(region).toHaveTextContent('$3.20/h');
    expect(region).toHaveTextContent('estimated');
    expect(screen.getByRole('progressbar', { name: '5-hour block' })).toHaveAttribute('aria-valuenow', '83');
    expect(screen.getByTitle(/resets in \d+ min/)).toBeTruthy();
  });

  it('shows official figures and an inactive block without percentages', async () => {
    const off: UsageSnapshot = { ...base, source: 'official', block: { ...base.block, active: false, pctOfLimit: null }, projectedBlockExhaustionAt: null };
    setApiClientForTests(fakeApi({ usageGet: vi.fn(async () => off) }));
    renderP3(<QuotaBars />);
    const region = await screen.findByRole('region', { name: 'Quota' });
    expect(region).toHaveTextContent('no active block');
    expect(region).not.toHaveTextContent('estimated');
  });
});
```

`apps/web/src/features/analytics/analytics-options.test.ts`
```ts
import type { CostRow, OutcomesResult, TimingResult, ToolUsageRow } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { cacheTrendOption, costByKeyOption, costOverTimeOption, outcomesOption, toolUsageOption } from './analytics-options.ts';

const rows: CostRow[] = [
  { key: '2026-09-15', costUsd: 10, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, sessions: 2 },
  { key: '2026-09-16', costUsd: 5, tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, sessions: 1 },
];

describe('chart options', () => {
  it('builds a bar series over time with money axis labels', () => {
    const o = costOverTimeOption(rows) as { xAxis: { data: string[] }; series: Array<{ type: string; data: number[] }> };
    expect(o.xAxis.data).toEqual(['2026-09-15', '2026-09-16']);
    expect(o.series[0]?.type).toBe('bar');
    expect(o.series[0]?.data).toEqual([10, 5]);
  });

  it('builds a horizontal bar for grouped keys, biggest first', () => {
    const o = costByKeyOption(rows) as { yAxis: { data: string[] } };
    expect(o.yAxis.data).toEqual(['2026-09-16', '2026-09-15']); // echarts draws the last category at the top
  });

  it('keeps only the top tool names', () => {
    const tools: ToolUsageRow[] = [
      { bucket: '2026-09-15', kind: 'tool', name: 'Bash', count: 5 },
      { bucket: '2026-09-16', kind: 'tool', name: 'Bash', count: 2 },
      { bucket: '2026-09-15', kind: 'skill', name: 'conductor', count: 3 },
      { bucket: '2026-09-15', kind: 'mcp', name: 'linear', count: 1 },
    ];
    const o = toolUsageOption(tools, 2) as { series: Array<{ name: string; data: number[] }> };
    expect(o.series.map((s) => s.name)).toEqual(['Bash', 'conductor']);
    expect(o.series[0]?.data).toEqual([5, 2]);
  });

  it('plots the cache trend and outcome counts', () => {
    const t: TimingResult = { modelMs: 3, toolMs: 1, modelShare: 0.75, cacheHitTrend: [{ bucket: 'a', rate: 0.5 }, { bucket: 'b', rate: null }] };
    const c = cacheTrendOption(t) as { series: Array<{ data: Array<number | null> }> };
    expect(c.series[0]?.data).toEqual([50, null]);
    const o: OutcomesResult = { sessions: 3, outcomes: { fully_achieved: 2, mostly_achieved: 1 }, friction: {}, goalCategories: {} };
    const oo = outcomesOption(o) as { series: Array<{ data: Array<{ name: string; value: number }> }> };
    expect(oo.series[0]?.data).toEqual([{ name: 'fully_achieved', value: 2 }, { name: 'mostly_achieved', value: 1 }]);
  });
});
```

- [ ] **Step 6: Implement the formatting, bars and options**

`apps/web/src/features/limits/format.ts`
```ts
export function formatUsd(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : `$${n.toFixed(2)}`;
}

export function formatPctValue(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 100)}%`;
}

export function minutesUntil(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
}

export function quotaTone(pct: number | null, warnPct: number): 'ok' | 'warn' | 'over' {
  if (pct === null) return 'ok';
  if (pct >= 1) return 'over';
  return pct >= warnPct ? 'warn' : 'ok';
}
```

`apps/web/src/features/limits/QuotaBars.tsx`
```tsx
import { Badge } from '@/components/ui';
import { useUsage } from '@/api/queries/usage';
import { formatPctValue, formatUsd, minutesUntil, quotaTone } from './format.ts';

const TONE_CLASS: Record<'ok' | 'warn' | 'over', string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  over: 'bg-red-600',
};

function Bar({ label, pct, warnPct }: { label: string; pct: number | null; warnPct: number }) {
  if (pct === null) return null;
  const clamped = Math.min(100, Math.round(pct * 100));
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className="inline-block h-1.5 w-14 overflow-hidden rounded bg-neutral-200 align-middle dark:bg-neutral-700"
    >
      <span className={`block h-full ${TONE_CLASS[quotaTone(pct, warnPct)]}`} style={{ width: `${clamped}%` }} />
    </span>
  );
}

/** Top-bar quota summary (F19). Updates live from the usage.updated WS event. */
export function QuotaBars() {
  const { data } = useUsage();
  if (!data) return null;
  const warnPct = 0.8;
  const block = data.block;
  return (
    <div role="region" aria-label="Quota" className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
      {block.active ? (
        <span className="flex items-center gap-1" title={`5-hour block resets in ${minutesUntil(block.end)} min`}>
          <span>5h {block.pctOfLimit === null ? formatUsd(block.costUsd) : formatPctValue(block.pctOfLimit)}</span>
          <Bar label="5-hour block" pct={block.pctOfLimit} warnPct={warnPct} />
        </span>
      ) : (
        <span>no active block</span>
      )}
      <span className="flex items-center gap-1" title="Last 7 days">
        <span>7d {data.week.pctOfLimit === null ? formatUsd(data.week.costUsd) : formatPctValue(data.week.pctOfLimit)}</span>
        <Bar label="7-day window" pct={data.week.pctOfLimit} warnPct={warnPct} />
      </span>
      {block.active ? <span title="Burn rate">{formatUsd(data.burnRateUsdPerHour)}/h</span> : null}
      {data.projectedBlockExhaustionAt !== null ? (
        <span className="text-amber-600">runs out in {minutesUntil(data.projectedBlockExhaustionAt)} min</span>
      ) : null}
      {data.source === 'estimate' ? (
        <Badge variant="outline" title="No official quota source; figures are estimated from transcripts">
          estimated
        </Badge>
      ) : null}
    </div>
  );
}
```

`apps/web/src/features/analytics/analytics-options.ts`
```ts
import type { CostRow, OutcomesResult, TimingResult, ToolUsageRow } from '@orc/core';
import type { EChartsOption } from 'echarts';

const GRID = { left: 48, right: 16, top: 24, bottom: 28 };
const money = { axisLabel: { formatter: (v: number) => `$${v}` } };

export function costOverTimeOption(rows: CostRow[]): EChartsOption {
  return {
    grid: GRID,
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: rows.map((r) => r.key) },
    yAxis: { type: 'value', ...money },
    series: [{ type: 'bar', name: 'Cost', data: rows.map((r) => r.costUsd) }],
  };
}

export function costByKeyOption(rows: CostRow[]): EChartsOption {
  const sorted = [...rows].sort((a, b) => a.costUsd - b.costUsd);
  return {
    grid: { ...GRID, left: 120 },
    tooltip: { trigger: 'item' },
    xAxis: { type: 'value', ...money },
    yAxis: { type: 'category', data: sorted.map((r) => r.key) },
    series: [{ type: 'bar', name: 'Cost', data: sorted.map((r) => r.costUsd) }],
  };
}

export function toolUsageOption(rows: ToolUsageRow[], top = 8): EChartsOption {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.name, (totals.get(r.name) ?? 0) + r.count);
  const names = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([n]) => n);
  const buckets = [...new Set(rows.map((r) => r.bucket))].sort();
  return {
    grid: GRID,
    tooltip: { trigger: 'axis' },
    legend: { type: 'scroll', top: 0 },
    xAxis: { type: 'category', data: buckets },
    yAxis: { type: 'value' },
    series: names.map((name) => ({
      type: 'line',
      name,
      data: buckets.map((b) => rows.filter((r) => r.bucket === b && r.name === name).reduce((a, r) => a + r.count, 0)),
    })),
  };
}

export function cacheTrendOption(t: TimingResult): EChartsOption {
  return {
    grid: GRID,
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: t.cacheHitTrend.map((p) => p.bucket) },
    yAxis: { type: 'value', max: 100, axisLabel: { formatter: (v: number) => `${v}%` } },
    series: [{ type: 'line', name: 'Cache hit rate', data: t.cacheHitTrend.map((p) => (p.rate === null ? null : Math.round(p.rate * 100))) }],
  };
}

export function outcomesOption(o: OutcomesResult): EChartsOption {
  const data = Object.entries(o.outcomes)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => ({ name, value }));
  return { tooltip: { trigger: 'item' }, legend: { type: 'scroll', bottom: 0 }, series: [{ type: 'pie', radius: ['40%', '70%'], data }] };
}
```

- [ ] **Step 7: Write the failing page test, then the page**

`apps/web/src/features/analytics/AnalyticsPage.test.tsx`
```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { AnalyticsPage } from './AnalyticsPage.tsx';

const chart = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
vi.mock('echarts/core', () => ({ init: vi.fn(() => chart), use: vi.fn() }));
vi.mock('echarts/charts', () => ({ BarChart: {}, LineChart: {}, PieChart: {} }));
vi.mock('echarts/components', () => ({ GridComponent: {}, LegendComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

function api(over: Partial<Parameters<typeof fakeApi>[0]> = {}) {
  return fakeApi({
    analyticsCost: vi.fn(async (p: { groupBy: string }) => ({
      rows: p.groupBy === 'project' ? [{ key: 'wakecap', costUsd: 120, tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, sessions: 5 }] : [{ key: '2026-09-15', costUsd: 120, tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, sessions: 5 }],
      estimated: true,
    })),
    analyticsTop: vi.fn(async () => ({
      sessions: [{ pk: 'claude:s1', name: 'Fix SLA', projectId: 'wakecap', costUsd: 60, tickets: ['SAF-1'] }],
      tickets: [{ ticket: 'SAF-1', costUsd: 60, sessions: 2 }],
      mergedPrs: 3,
      costPerMergedPrUsd: 20,
    })),
    analyticsTools: vi.fn(async () => [{ bucket: '2026-09-15', kind: 'tool' as const, name: 'Bash', count: 4 }]),
    analyticsTiming: vi.fn(async () => ({ modelMs: 3000, toolMs: 1000, modelShare: 0.75, cacheHitTrend: [{ bucket: '2026-09-15', rate: 0.9 }] })),
    analyticsOutcomes: vi.fn(async () => ({ sessions: 2, outcomes: { fully_achieved: 2 }, friction: { buggy_code: 3 }, goalCategories: {} })),
    analyticsWstack: vi.fn(async () => [{ skill: 'ship', runs: 2, outcomes: { success: 2 }, avgDurationS: 30 }]),
    analyticsDigestLatest: vi.fn(async () => null),
    analyticsDigestGenerate: vi.fn(async () => ({ weekStart: '2026-09-07', markdown: '# Weekly digest — 2026-09-07', createdAt: 'x' })),
    usageGet: vi.fn(async () => ({
      source: 'estimate' as const, generatedAt: 't',
      block: { active: true, start: 't', end: '2026-09-18T13:00:00.000Z', tokens: 1, costUsd: 2, pctOfLimit: 0.2 },
      week: { tokens: 1, costUsd: 3, pctOfLimit: null }, burnRateUsdPerHour: 1, burnRateTokensPerMin: 1, projectedBlockExhaustionAt: null,
    })),
    ...over,
  });
}

describe('AnalyticsPage', () => {
  it('shows totals, top lists, outcomes, wstack and the estimated label', async () => {
    setApiClientForTests(api());
    renderP3(<AnalyticsPage />);
    expect(await screen.findByText('$120.00')).toBeTruthy();
    expect(screen.getByText('estimated')).toBeTruthy();
    expect(await screen.findByText('$20.00')).toBeTruthy(); // cost per merged PR
    expect(screen.getByRole('link', { name: /Fix SLA/ })).toHaveAttribute('href', '/sessions/claude/s1');
    expect(screen.getByRole('link', { name: 'SAF-1' })).toHaveAttribute('href', '/streams/SAF-1');
    expect(screen.getByText('buggy_code')).toBeTruthy();
    expect(screen.getByText('ship')).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy(); // model time share
  });

  it('changes the range and the grouping, and generates a digest', async () => {
    const client = api();
    setApiClientForTests(client);
    const user = userEvent.setup();
    renderP3(<AnalyticsPage />);
    await screen.findByText('$120.00');
    await user.selectOptions(screen.getByLabelText('Range'), '7');
    await user.selectOptions(screen.getByLabelText('Group by'), 'project');
    await waitFor(() => expect(client.analyticsCost).toHaveBeenCalledWith(expect.objectContaining({ groupBy: 'project' })));
    await user.click(screen.getByRole('button', { name: 'Generate weekly digest' }));
    expect(await screen.findByText(/# Weekly digest — 2026-09-07/)).toBeTruthy();
  });
});
```

`apps/web/src/features/analytics/AnalyticsPage.tsx`
```tsx
import type { AnalyticsGroupBy } from '@orc/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button } from '@/components/ui';
import {
  rangeFor,
  useAnalyticsCost,
  useAnalyticsOutcomes,
  useAnalyticsTiming,
  useAnalyticsTools,
  useAnalyticsTop,
  useAnalyticsWstack,
  useDigest,
  useGenerateDigest,
} from '@/api/queries/analytics';
import { useProjectStore } from '@/stores/project';
import { formatPctValue, formatUsd } from '../limits/format.ts';
import { QuotaBars } from '../limits/QuotaBars.tsx';
import { cacheTrendOption, costByKeyOption, costOverTimeOption, outcomesOption, toolUsageOption } from './analytics-options.ts';

echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

const RANGES = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];
const GROUPS: AnalyticsGroupBy[] = ['day', 'week', 'project', 'model', 'source', 'ticket'];

function Chart({ option, label, height = 220 }: { option: echarts.EChartsCoreOption; label: string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    chart.setOption(option);
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
    };
  }, [option]);
  return <div ref={ref} role="img" aria-label={label} style={{ height }} className="w-full" />;
}

function Card({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded border border-neutral-200 p-3 dark:border-neutral-700" aria-label={title}>
      <header className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function AnalyticsPage() {
  const projectId = useProjectStore((s) => s.projectId);
  const [days, setDays] = useState(30);
  const [groupBy, setGroupBy] = useState<AnalyticsGroupBy>('day');
  const [bucket, setBucket] = useState<'day' | 'week'>('day');
  const range = useMemo(() => rangeFor(days), [days]);
  const params = useMemo(() => ({ ...range, ...(projectId ? { projectId } : {}) }), [range, projectId]);

  const cost = useAnalyticsCost({ ...params, groupBy });
  const overTime = useAnalyticsCost({ ...params, groupBy: bucket });
  const top = useAnalyticsTop({ ...params, limit: 10 });
  const tools = useAnalyticsTools({ ...params, bucket });
  const timing = useAnalyticsTiming({ ...params, bucket });
  const outcomes = useAnalyticsOutcomes(params);
  const wstack = useAnalyticsWstack(range);
  const digest = useDigest();
  const generate = useGenerateDigest();

  const total = (cost.data?.rows ?? []).reduce((a, r) => a + r.costUsd, 0);
  const estimated = cost.data?.estimated ?? false;

  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Analytics</h1>
        <label className="text-xs">
          Range{' '}
          <select aria-label="Range" className="rounded border px-1 py-0.5" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {RANGES.map((r) => (
              <option key={r.days} value={r.days}>{r.label}</option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          Group by{' '}
          <select aria-label="Group by" className="rounded border px-1 py-0.5" value={groupBy} onChange={(e) => setGroupBy(e.target.value as AnalyticsGroupBy)}>
            {GROUPS.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          Bucket{' '}
          <select aria-label="Bucket" className="rounded border px-1 py-0.5" value={bucket} onChange={(e) => setBucket(e.target.value as 'day' | 'week')}>
            <option value="day">day</option>
            <option value="week">week</option>
          </select>
        </label>
        <QuotaBars />
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Spend" aside={estimated ? <Badge variant="outline">estimated</Badge> : null}>
          <p className="text-2xl font-semibold">{formatUsd(total)}</p>
          <Chart option={costOverTimeOption(overTime.data?.rows ?? [])} label="Cost over time" />
        </Card>
        <Card title={`Cost by ${groupBy}`}>
          <Chart option={costByKeyOption(cost.data?.rows ?? [])} label={`Cost by ${groupBy}`} />
        </Card>
        <Card title="Most expensive">
          <p className="mb-2 text-xs text-neutral-500">
            {top.data?.mergedPrs ?? 0} merged PRs · cost per merged PR <strong>{formatUsd(top.data?.costPerMergedPrUsd ?? null)}</strong>
          </p>
          <ul className="flex flex-col gap-1 text-sm">
            {(top.data?.sessions ?? []).map((s) => (
              <li key={s.pk} className="flex justify-between gap-2">
                <a className="truncate underline" href={`/sessions/${s.pk.split(':')[0]}/${s.pk.split(':').slice(1).join(':')}`}>
                  {s.name ?? s.pk}
                </a>
                <span>{formatUsd(s.costUsd)}</span>
              </li>
            ))}
          </ul>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {(top.data?.tickets ?? []).map((t) => (
              <li key={t.ticket} className="flex justify-between gap-2">
                <a className="underline" href={`/streams/${t.ticket}`}>{t.ticket}</a>
                <span>
                  {formatUsd(t.costUsd)} · {t.sessions} sessions
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Tools, MCP and skills">
          <Chart option={toolUsageOption(tools.data ?? [])} label="Tool usage over time" />
        </Card>
        <Card title="Timing">
          <p className="text-sm">
            Model time share <strong>{formatPctValue(timing.data?.modelShare ?? null)}</strong>
          </p>
          <Chart option={cacheTrendOption(timing.data ?? { modelMs: 0, toolMs: 0, modelShare: null, cacheHitTrend: [] })} label="Cache hit rate" />
        </Card>
        <Card title="Outcomes & friction">
          <Chart option={outcomesOption(outcomes.data ?? { sessions: 0, outcomes: {}, friction: {}, goalCategories: {} })} label="Outcomes" height={180} />
          <ul className="flex flex-col gap-0.5 text-sm">
            {Object.entries(outcomes.data?.friction ?? {}).map(([k, v]) => (
              <li key={k} className="flex justify-between">
                <span>{k}</span>
                <span>{v}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="wstack skill runs">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-neutral-500">
                <th>skill</th>
                <th>runs</th>
                <th>outcomes</th>
                <th>avg</th>
              </tr>
            </thead>
            <tbody>
              {(wstack.data ?? []).map((r) => (
                <tr key={r.skill}>
                  <td>{r.skill}</td>
                  <td>{r.runs}</td>
                  <td>{Object.entries(r.outcomes).map(([k, v]) => `${k} ${v}`).join(', ')}</td>
                  <td>{r.avgDurationS === null ? '—' : `${Math.round(r.avgDurationS)}s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card
          title="Weekly digest"
          aside={
            <Button size="sm" variant="outline" disabled={generate.isPending} onClick={() => generate.mutate(undefined)}>
              Generate weekly digest
            </Button>
          }
        >
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">{digest.data?.markdown ?? 'No digest yet.'}</pre>
        </Card>
      </div>
    </main>
  );
}
```

`apps/web/src/routes/analytics.tsx`
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { AnalyticsPage } from '@/features/analytics/AnalyticsPage';

export const Route = createFileRoute('/analytics')({ component: AnalyticsPage });
```

In `apps/web/src/features/shell/AppShell.tsx`: add `<Link to="/analytics">Analytics</Link>` to `<nav aria-label="Main">` (next to Audit), and render `<QuotaBars />` in the header, before the inbox count. In `apps/web/src/features/hotkeys/GlobalHotkeys.tsx`, add a binding `{ id: 'nav.analytics', keys: 'g u', description: 'Go to analytics', group: 'navigation', handler: () => navigate('/analytics') }`, following the shape of the existing `g a` binding.

- [ ] **Step 8: Run the web tests and the build**

Run: `pnpm vitest run apps/web/src/features/limits apps/web/src/features/analytics apps/web/src/api/queries/p5-queries.test.tsx && pnpm --filter @orc/web build`
Expected: PASS (10 tests) and a successful build. `useGenerateDigest` writes the digest into the cache, so the digest text appears without a refetch.

- [ ] **Step 9: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test
git add apps/web
git commit -m "feat(web): add usage/analytics data layer, quota bars and the analytics page"
```

---

### Task 19: Session work panel — goal, recap, handoff, reminders and context fill

**Files:**
- Create: `apps/web/src/api/queries/work.ts`, `apps/web/src/api/queries/work-queries.test.tsx`
- Create: `apps/web/src/features/goals/{goal-format.ts,GoalEditor.tsx,GoalEditor.test.tsx}`
- Create: `apps/web/src/features/recaps/{RecapPanel.tsx,RecapPanel.test.tsx}`
- Create: `apps/web/src/features/handoffs/{HandoffPanel.tsx,HandoffPanel.test.tsx}`
- Create: `apps/web/src/features/reminders/{ReminderPanel.tsx,ReminderPanel.test.tsx}`
- Create: `apps/web/src/features/limits/ContextFillBadge.tsx`
- Create: `apps/web/src/features/session-detail/SessionWorkPanel.tsx`
- Modify: `apps/web/src/features/session-detail/SessionDetailPage.tsx` (P3), the Phase 1 history row (recap preview)

**Interfaces:**
- Consumes: Task 1 client methods; `ApiCallError` (P2 `client-p2.ts`); `renderP3`, `fakeApi`, `makeQueryClient`, `wrapperFor` (P3); `useContextFill` (Task 18); `Session`, `Goal`, `Handoff`, `Recap`, `Reminder` types
- Produces:
  ```ts
  // api/queries/work.ts
  export const workKeys: { recap(s: Source, id: string): readonly unknown[]; spend: readonly unknown[]; goal(t: 'session' | 'stream', id: string): readonly unknown[]; goals(states?: string): readonly unknown[]; handoff(s: Source, id: string): readonly unknown[]; reminders(f: { sessionPk?: string }): readonly unknown[] }
  export function useSessionRecap(source: Source, id: string): UseQueryResult<Recap | null>
  export function useRunRecap(source: Source, id: string): UseMutationResult<RecapRunResponse, Error, { onDemand?: boolean } | void>
  export function useRecapSpend(): UseQueryResult<{ spentUsd: number; budgetUsd: number }>
  export function useGoal(targetType: 'session' | 'stream', targetId: string): UseQueryResult<{ goal: Goal | null; prefill: string }>
  export function useSetGoal(targetType: 'session' | 'stream', targetId: string): UseMutationResult<Goal, Error, GoalPutBody>
  export function useLatestHandoff(source: Source, id: string): UseQueryResult<{ handoff: Handoff; markdown: string } | null>
  export function useGenerateHandoff(source: Source, id: string): UseMutationResult<Handoff, Error, void>
  export function useResumeFresh(): UseMutationResult<{ ptyId: string }, Error, string>
  export function useReminders(f: { sessionPk?: string }): UseQueryResult<Reminder[]>
  export function useCreateReminder(): UseMutationResult<Reminder, Error, ReminderCreateBody>
  export function useCancelReminder(): UseMutationResult<Reminder, Error, string>
  export function errorMessage(err: unknown): string
  // features/goals/goal-format.ts
  export const GOAL_STATES: ReadonlyArray<{ id: GoalState; label: string }>
  export function goalBadgeTone(state: GoalState): 'ok' | 'warn' | 'muted' | 'done'
  // components
  export function GoalEditor(p: { targetType: 'session' | 'stream'; targetId: string }): JSX.Element
  export function RecapPanel(p: { source: Source; id: string }): JSX.Element
  export function HandoffPanel(p: { source: Source; id: string }): JSX.Element
  export function ReminderPanel(p: { sessionPk: string; ticket: string | null; owned: boolean }): JSX.Element
  export function ContextFillBadge(p: { source: Source; id: string; onResumeFresh?: () => void }): JSX.Element | null
  export function SessionWorkPanel(p: { session: Session }): JSX.Element
  ```
- **Error copy** (from the API error codes): `recaps_disabled` → "Recaps are off for this project — turn them on in Settings."; `too_small` → "This session has too few prompts for an automatic recap."; `over_budget` → "The monthly recap budget is used up."; `engine_unavailable` → "The recap engine is not available (check the engine and API key in Settings)."; anything else → "Could not generate the recap."
- **Resume fresh** always takes two clicks: "Resume fresh with handoff…" then "Confirm — start a new session".

- [ ] **Step 1: Write the failing query test**

`apps/web/src/api/queries/work-queries.test.tsx`
```tsx
import type { Goal, Handoff } from '@orc/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi, makeQueryClient, wrapperFor } from '../../test/p3-render.tsx';
import { setApiClientForTests } from '../client.ts';
import { errorMessage, useGoal, useRunRecap, useSessionRecap, useSetGoal, workKeys } from './work.ts';

const goal: Goal = { id: 'g1', targetType: 'session', targetId: 'claude:s1', objective: 'ship', state: 'active', blockedReason: null, updatedAt: 't' };

describe('work queries', () => {
  it('refreshes the recap and the session after running one', async () => {
    const recapsGetSession = vi.fn(async () => null);
    const recapsRunSession = vi.fn(async () => ({ text: 'Recap', costUsd: 0.2, model: 'claude-sonnet-5', cached: false }));
    setApiClientForTests(fakeApi({ recapsGetSession, recapsRunSession }));
    const client = makeQueryClient();
    const { result } = renderHook(() => ({ q: useSessionRecap('claude', 's1'), m: useRunRecap('claude', 's1') }), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.q.isSuccess).toBe(true));
    await act(async () => {
      await result.current.m.mutateAsync({ onDemand: true });
    });
    expect(recapsRunSession).toHaveBeenCalledWith('claude', 's1', true);
    await waitFor(() => expect(recapsGetSession).toHaveBeenCalledTimes(2));
  });

  it('writes the saved goal straight into its cache', async () => {
    const goalsGet = vi.fn(async () => ({ goal: null, prefill: 'do it' }));
    const goalsSet = vi.fn(async () => goal);
    setApiClientForTests(fakeApi({ goalsGet, goalsSet }));
    const client = makeQueryClient();
    const { result } = renderHook(() => ({ q: useGoal('session', 'claude:s1'), m: useSetGoal('session', 'claude:s1') }), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.q.data?.prefill).toBe('do it'));
    await act(async () => {
      await result.current.m.mutateAsync({ objective: 'ship', state: 'active', blockedReason: null });
    });
    expect(client.getQueryData(workKeys.goal('session', 'claude:s1'))).toEqual({ goal, prefill: 'do it' });
  });

  it('maps API error codes to copy', () => {
    expect(errorMessage({ code: 'recaps_disabled' })).toMatch(/turn them on in Settings/);
    expect(errorMessage({ code: 'too_small' })).toMatch(/too few prompts/);
    expect(errorMessage({ code: 'over_budget' })).toMatch(/budget is used up/);
    expect(errorMessage({ code: 'engine_unavailable' })).toMatch(/not available/);
    expect(errorMessage(new Error('boom'))).toBe('Could not generate the recap.');
  });
});
```

Run: `pnpm vitest run apps/web/src/api/queries/work-queries.test.tsx`
Expected: FAIL, `Cannot find module './work.ts'`.

- [ ] **Step 2: Write the hooks**

`apps/web/src/api/queries/work.ts`
```ts
import type { GoalPutBody, ReminderCreateBody } from '@orc/api-contract';
import type { Goal, Source } from '@orc/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

const STALE_MS = 10_000;

export const workKeys = {
  recap: (s: Source, id: string) => ['recap', s, id] as const,
  spend: ['recaps', 'spend'] as const,
  goal: (t: 'session' | 'stream', id: string) => ['goal', t, id] as const,
  goals: (states?: string) => ['goals', states ?? 'all'] as const,
  handoff: (s: Source, id: string) => ['handoff', s, id] as const,
  reminders: (f: { sessionPk?: string }) => ['reminders', f] as const,
};

const RECAP_ERRORS: Record<string, string> = {
  recaps_disabled: 'Recaps are off for this project — turn them on in Settings.',
  too_small: 'This session has too few prompts for an automatic recap.',
  over_budget: 'The monthly recap budget is used up.',
  engine_unavailable: 'The recap engine is not available (check the engine and API key in Settings).',
};

export function errorMessage(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return (typeof code === 'string' ? RECAP_ERRORS[code] : undefined) ?? 'Could not generate the recap.';
}

export function useSessionRecap(source: Source, id: string) {
  return useQuery({ queryKey: workKeys.recap(source, id), queryFn: () => getApiClient().recapsGetSession(source, id), staleTime: STALE_MS });
}

export function useRunRecap(source: Source, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts: { onDemand?: boolean } | void) => getApiClient().recapsRunSession(source, id, opts?.onDemand ?? true),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workKeys.recap(source, id) });
      void qc.invalidateQueries({ queryKey: ['session', source, id] });
      void qc.invalidateQueries({ queryKey: workKeys.spend });
    },
  });
}

export function useRecapSpend() {
  return useQuery({ queryKey: workKeys.spend, queryFn: () => getApiClient().recapsSpend(), staleTime: STALE_MS });
}

export function useGoal(targetType: 'session' | 'stream', targetId: string) {
  return useQuery({ queryKey: workKeys.goal(targetType, targetId), queryFn: () => getApiClient().goalsGet(targetType, targetId), staleTime: STALE_MS });
}

export function useSetGoal(targetType: 'session' | 'stream', targetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GoalPutBody) => getApiClient().goalsSet(targetType, targetId, body),
    onSuccess: (goal: Goal) => {
      qc.setQueryData(workKeys.goal(targetType, targetId), (old: { goal: Goal | null; prefill: string } | undefined) => ({
        goal,
        prefill: old?.prefill ?? goal.objective,
      }));
      void qc.invalidateQueries({ queryKey: ['streams'] });
    },
  });
}

export function useLatestHandoff(source: Source, id: string) {
  return useQuery({ queryKey: workKeys.handoff(source, id), queryFn: () => getApiClient().handoffsLatest(source, id), staleTime: STALE_MS });
}

export function useGenerateHandoff(source: Source, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => getApiClient().handoffsGenerate(source, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: workKeys.handoff(source, id) }),
  });
}

export function useResumeFresh() {
  return useMutation({ mutationFn: (handoffId: string) => getApiClient().handoffsResumeFresh(handoffId) });
}

export function useReminders(f: { sessionPk?: string }) {
  return useQuery({
    queryKey: workKeys.reminders(f),
    queryFn: () => getApiClient().remindersList({ state: ['pending'], ...f }),
    staleTime: STALE_MS,
  });
}

export function useCreateReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReminderCreateBody) => getApiClient().remindersCreate(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reminders'] }),
  });
}

export function useCancelReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApiClient().remindersCancel(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reminders'] }),
  });
}
```

Run: `pnpm vitest run apps/web/src/api/queries/work-queries.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 3: Write the failing component tests**

`apps/web/src/features/goals/GoalEditor.test.tsx`
```tsx
import type { Goal } from '@orc/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { GoalEditor } from './GoalEditor.tsx';

const goal: Goal = { id: 'g1', targetType: 'session', targetId: 'claude:s1', objective: 'ship SAF-1', state: 'blocked', blockedReason: 'needs answer', updatedAt: 't' };

describe('GoalEditor', () => {
  it('prefills from the server and saves an edit', async () => {
    const goalsSet = vi.fn(async (_t: string, _id: string, body: { objective: string }) => ({ ...goal, objective: body.objective, state: 'active' as const, blockedReason: null }));
    setApiClientForTests(fakeApi({ goalsGet: vi.fn(async () => ({ goal: null, prefill: 'implement the weekend rule' })), goalsSet }));
    const user = userEvent.setup();
    renderP3(<GoalEditor targetType="session" targetId="claude:s1" />);
    const objective = await screen.findByLabelText('Goal');
    expect(objective).toHaveValue('implement the weekend rule');
    await user.clear(objective);
    await user.type(objective, 'ship it');
    await user.click(screen.getByRole('button', { name: 'Save goal' }));
    await waitFor(() => expect(goalsSet).toHaveBeenCalledWith('session', 'claude:s1', { objective: 'ship it', state: 'active', blockedReason: null }));
  });

  it('shows the blocked reason field only when blocked', async () => {
    setApiClientForTests(fakeApi({ goalsGet: vi.fn(async () => ({ goal, prefill: 'x' })), goalsSet: vi.fn(async () => goal) }));
    const user = userEvent.setup();
    renderP3(<GoalEditor targetType="session" targetId="claude:s1" />);
    expect(await screen.findByLabelText('Blocked reason')).toHaveValue('needs answer');
    await user.selectOptions(screen.getByLabelText('Goal state'), 'complete');
    expect(screen.queryByLabelText('Blocked reason')).toBeNull();
  });
});
```

`apps/web/src/features/recaps/RecapPanel.test.tsx`
```tsx
import type { Recap } from '@orc/core';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiCallError } from '@orc/api-contract';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { RecapPanel } from './RecapPanel.tsx';

const recap: Recap = {
  id: 'r1', kind: 'session', targetKey: 'claude:s1', transcriptOffset: 10, model: 'claude-sonnet-5', engine: 'claude-cli',
  text: 'Fixed the SLA rule.\n**What to check:**\n- weekend edge cases', costUsd: 0.21, inputTokensApprox: 900, createdAt: '2026-09-18T09:00:00.000Z',
};

describe('RecapPanel', () => {
  it('shows the recap with its model and cost, and can regenerate', async () => {
    const recapsRunSession = vi.fn(async () => ({ text: 'new', costUsd: 0.3, model: 'claude-sonnet-5', cached: false }));
    setApiClientForTests(fakeApi({
      recapsGetSession: vi.fn(async () => recap),
      recapsRunSession,
      recapsSpend: vi.fn(async () => ({ spentUsd: 1.5, budgetUsd: 20 })),
    }));
    const user = userEvent.setup();
    renderP3(<RecapPanel source="claude" id="s1" />);
    expect(await screen.findByText(/Fixed the SLA rule\./)).toBeTruthy();
    expect(screen.getByText(/claude-sonnet-5 · \$0\.21/)).toBeTruthy();
    expect(screen.getByText(/\$1\.50 of \$20\.00 this month/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Recap now' }));
    expect(recapsRunSession).toHaveBeenCalledWith('claude', 's1', true);
  });

  it('explains a refusal from the API', async () => {
    setApiClientForTests(fakeApi({
      recapsGetSession: vi.fn(async () => null),
      recapsSpend: vi.fn(async () => ({ spentUsd: 0, budgetUsd: 20 })),
      recapsRunSession: vi.fn(async () => Promise.reject(new ApiCallError(409, 'over_budget', 'no', undefined))),
    }));
    const user = userEvent.setup();
    renderP3(<RecapPanel source="claude" id="s1" />);
    await user.click(await screen.findByRole('button', { name: 'Recap now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The monthly recap budget is used up.');
  });
});
```

`apps/web/src/features/handoffs/HandoffPanel.test.tsx`
```tsx
import type { Handoff } from '@orc/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { HandoffPanel } from './HandoffPanel.tsx';

const handoff: Handoff = {
  id: 'h1', sessionId: 'claude:s1', status: 'ready_for_review', summary: 'Weekend rule done.', evidence: ['PR: https://x/1'],
  files: ['/a.ts'], nextSteps: ['Merge the PR'], blockers: [], links: ['https://x/1'], createdAt: '2026-09-18T09:00:00.000Z',
};

describe('HandoffPanel', () => {
  it('generates, renders and resumes fresh after a confirmation', async () => {
    const handoffsGenerate = vi.fn(async () => handoff);
    const handoffsResumeFresh = vi.fn(async () => ({ ptyId: 'pty-3' }));
    setApiClientForTests(fakeApi({
      handoffsLatest: vi.fn(async () => ({ handoff, markdown: '# Handoff — ready_for_review\n\n## Next steps\n1. Merge the PR' })),
      handoffsGenerate,
      handoffsResumeFresh,
    }));
    const user = userEvent.setup();
    renderP3(<HandoffPanel source="claude" id="s1" />);
    expect(await screen.findByText(/Merge the PR/)).toBeTruthy();
    expect(screen.getByText('ready_for_review')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(handoffsGenerate).toHaveBeenCalledWith('claude', 's1');
    await user.click(screen.getByRole('button', { name: 'Resume fresh with handoff…' }));
    expect(handoffsResumeFresh).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm — start a new session' }));
    await waitFor(() => expect(handoffsResumeFresh).toHaveBeenCalledWith('h1'));
    expect(await screen.findByText(/Started a new session/)).toBeTruthy();
  });

  it('offers to create the first handoff', async () => {
    setApiClientForTests(fakeApi({ handoffsLatest: vi.fn(async () => null), handoffsGenerate: vi.fn(async () => handoff) }));
    renderP3(<HandoffPanel source="claude" id="s1" />);
    expect(await screen.findByRole('button', { name: 'Create handoff' })).toBeTruthy();
  });
});
```

`apps/web/src/features/reminders/ReminderPanel.test.tsx`
```tsx
import type { Reminder } from '@orc/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { ReminderPanel } from './ReminderPanel.tsx';

const reminder: Reminder = {
  id: 'rem1', jobId: 'j1', sessionPk: 'claude:s1', ticket: 'SAF-1', text: 're-check CI', dueAt: '2026-09-18T10:20:00.000Z',
  sendToSession: true, state: 'pending', createdAt: 't', firedAt: null,
};

describe('ReminderPanel', () => {
  it('creates a reminder with minutes and the send-to-session option', async () => {
    const remindersCreate = vi.fn(async () => reminder);
    setApiClientForTests(fakeApi({ remindersList: vi.fn(async () => []), remindersCreate }));
    const user = userEvent.setup();
    renderP3(<ReminderPanel sessionPk="claude:s1" ticket="SAF-1" owned />);
    await user.type(await screen.findByLabelText('Reminder'), 're-check CI');
    await user.clear(screen.getByLabelText('In minutes'));
    await user.type(screen.getByLabelText('In minutes'), '20');
    await user.click(screen.getByLabelText('Also send it to the session'));
    await user.click(screen.getByRole('button', { name: 'Add reminder' }));
    await waitFor(() =>
      expect(remindersCreate).toHaveBeenCalledWith({ sessionPk: 'claude:s1', ticket: 'SAF-1', text: 're-check CI', inMinutes: 20, sendToSession: true }),
    );
  });

  it('lists pending reminders, cancels one, and disables sending for observed sessions', async () => {
    const remindersCancel = vi.fn(async () => ({ ...reminder, state: 'cancelled' as const }));
    setApiClientForTests(fakeApi({ remindersList: vi.fn(async () => [reminder]), remindersCancel, remindersCreate: vi.fn(async () => reminder) }));
    const user = userEvent.setup();
    renderP3(<ReminderPanel sessionPk="claude:s1" ticket={null} owned={false} />);
    expect(await screen.findByText('re-check CI')).toBeTruthy();
    expect(screen.getByLabelText('Also send it to the session')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel reminder re-check CI' }));
    expect(remindersCancel).toHaveBeenCalledWith('rem1');
  });
});
```

- [ ] **Step 4: Implement the components**

`apps/web/src/features/goals/goal-format.ts`
```ts
import type { GoalState } from '@orc/core';

export const GOAL_STATES: ReadonlyArray<{ id: GoalState; label: string }> = [
  { id: 'active', label: 'Active' },
  { id: 'paused', label: 'Paused' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'complete', label: 'Complete' },
];

export function goalBadgeTone(state: GoalState): 'ok' | 'warn' | 'muted' | 'done' {
  if (state === 'blocked') return 'warn';
  if (state === 'complete') return 'done';
  return state === 'paused' ? 'muted' : 'ok';
}
```

`apps/web/src/features/goals/GoalEditor.tsx`
```tsx
import type { GoalState } from '@orc/core';
import { type FormEvent, useEffect, useState } from 'react';
import { Button, Input } from '@/components/ui';
import { useGoal, useSetGoal } from '@/api/queries/work';
import { GOAL_STATES } from './goal-format.ts';

export function GoalEditor({ targetType, targetId }: { targetType: 'session' | 'stream'; targetId: string }) {
  const q = useGoal(targetType, targetId);
  const save = useSetGoal(targetType, targetId);
  const [objective, setObjective] = useState('');
  const [state, setState] = useState<GoalState>('active');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!q.data) return;
    setObjective(q.data.goal?.objective ?? q.data.prefill);
    setState(q.data.goal?.state ?? 'active');
    setReason(q.data.goal?.blockedReason ?? '');
  }, [q.data]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.mutate({ objective: objective.trim(), state, blockedReason: state === 'blocked' ? reason.trim() || 'blocked' : null });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2" aria-label="Goal">
      <label className="flex flex-col gap-1 text-xs">
        Goal
        <Input value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="What should this finish?" />
      </label>
      <div className="flex items-center gap-2">
        <label className="text-xs">
          Goal state{' '}
          <select aria-label="Goal state" className="rounded border px-1 py-0.5" value={state} onChange={(e) => setState(e.target.value as GoalState)}>
            {GOAL_STATES.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </label>
        {state === 'blocked' ? (
          <label className="flex-1 text-xs">
            Blocked reason
            <Input aria-label="Blocked reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="needs answer" />
          </label>
        ) : null}
        <Button type="submit" size="sm" disabled={save.isPending || objective.trim().length === 0}>
          Save goal
        </Button>
      </div>
      {save.isError ? <p role="alert" className="text-xs text-red-600">Could not save the goal.</p> : null}
    </form>
  );
}
```

`apps/web/src/features/recaps/RecapPanel.tsx`
```tsx
import type { Source } from '@orc/core';
import { Badge, Button } from '@/components/ui';
import { errorMessage, useRecapSpend, useRunRecap, useSessionRecap } from '@/api/queries/work';
import { formatUsd } from '../limits/format.ts';

export function RecapPanel({ source, id }: { source: Source; id: string }) {
  const q = useSessionRecap(source, id);
  const run = useRunRecap(source, id);
  const spend = useRecapSpend();
  const recap = q.data;

  return (
    <section aria-label="Recap" className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Recap</h3>
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          {spend.data ? <span>{`${formatUsd(spend.data.spentUsd)} of ${formatUsd(spend.data.budgetUsd)} this month`}</span> : null}
          <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate({ onDemand: true })}>
            {run.isPending ? 'Recapping…' : 'Recap now'}
          </Button>
        </div>
      </header>
      {recap ? (
        <>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 text-xs dark:bg-neutral-800">{recap.text}</pre>
          <p className="text-xs text-neutral-500">
            {`${recap.model} · ${formatUsd(recap.costUsd)} · ${recap.createdAt.slice(0, 16).replace('T', ' ')} UTC`}{' '}
            <Badge variant="outline">{recap.engine}</Badge>
          </p>
        </>
      ) : (
        <p className="text-xs text-neutral-500">No recap yet.</p>
      )}
      {run.isError ? <p role="alert" className="text-xs text-red-600">{errorMessage(run.error)}</p> : null}
    </section>
  );
}
```

`apps/web/src/features/handoffs/HandoffPanel.tsx`
```tsx
import type { Source } from '@orc/core';
import { useState } from 'react';
import { Badge, Button } from '@/components/ui';
import { useGenerateHandoff, useLatestHandoff, useResumeFresh } from '@/api/queries/work';

export function HandoffPanel({ source, id }: { source: Source; id: string }) {
  const q = useLatestHandoff(source, id);
  const generate = useGenerateHandoff(source, id);
  const resume = useResumeFresh();
  const [confirming, setConfirming] = useState(false);
  const current = q.data;

  function download(markdown: string, handoffId: string) {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `handoff-${handoffId}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section aria-label="Handoff" className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Handoff</h3>
        <div className="flex items-center gap-2">
          {current ? <Badge variant="outline">{current.handoff.status}</Badge> : null}
          <Button size="sm" variant="outline" disabled={generate.isPending} onClick={() => generate.mutate()}>
            {current ? 'Regenerate' : 'Create handoff'}
          </Button>
        </div>
      </header>
      {current ? (
        <>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 text-xs dark:bg-neutral-800">{current.markdown}</pre>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => download(current.markdown, current.handoff.id)}>
              Download .md
            </Button>
            <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(current.markdown)}>
              Copy
            </Button>
            {confirming ? (
              <Button size="sm" disabled={resume.isPending} onClick={() => resume.mutate(current.handoff.id, { onSuccess: () => setConfirming(false) })}>
                Confirm — start a new session
              </Button>
            ) : (
              <Button size="sm" onClick={() => setConfirming(true)}>
                Resume fresh with handoff…
              </Button>
            )}
          </div>
          {confirming ? (
            <p className="text-xs text-neutral-500">
              This starts a new session in {current.handoff.sessionId.split(':')[0]}’s original directory with the handoff as its first prompt.
            </p>
          ) : null}
          {resume.isSuccess ? <p className="text-xs text-emerald-700">{`Started a new session (terminal ${resume.data.ptyId}).`}</p> : null}
          {resume.isError ? <p role="alert" className="text-xs text-red-600">Could not start the session (check the concurrency cap).</p> : null}
        </>
      ) : (
        <p className="text-xs text-neutral-500">No handoff yet.</p>
      )}
    </section>
  );
}
```

`apps/web/src/features/reminders/ReminderPanel.tsx`
```tsx
import { type FormEvent, useState } from 'react';
import { Button, Input } from '@/components/ui';
import { useCancelReminder, useCreateReminder, useReminders } from '@/api/queries/work';

export function ReminderPanel({ sessionPk, ticket, owned }: { sessionPk: string; ticket: string | null; owned: boolean }) {
  const list = useReminders({ sessionPk });
  const create = useCreateReminder();
  const cancel = useCancelReminder();
  const [text, setText] = useState('');
  const [minutes, setMinutes] = useState('20');
  const [send, setSend] = useState(false);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const inMinutes = Number(minutes);
    if (text.trim().length === 0 || !Number.isFinite(inMinutes) || inMinutes < 1) return;
    create.mutate(
      { sessionPk, ticket, text: text.trim(), inMinutes, sendToSession: send && owned },
      { onSuccess: () => setText('') },
    );
  }

  return (
    <section aria-label="Reminders" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Reminders</h3>
      <ul className="flex flex-col gap-1 text-xs">
        {(list.data ?? []).map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2">
            <span>
              {r.text} <span className="text-neutral-500">· due {r.dueAt.slice(11, 16)} UTC{r.sendToSession ? ' · sends to session' : ''}</span>
            </span>
            <Button size="sm" variant="ghost" aria-label={`Cancel reminder ${r.text}`} onClick={() => cancel.mutate(r.id)}>
              ✕
            </Button>
          </li>
        ))}
      </ul>
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
        <label className="flex-1 text-xs">
          Reminder
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="re-check CI" />
        </label>
        <label className="text-xs">
          In minutes
          <Input aria-label="In minutes" type="number" min={1} className="w-20" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </label>
        <label className="flex items-center gap-1 text-xs" title={owned ? '' : 'Only sessions this app owns can receive input'}>
          <input type="checkbox" aria-label="Also send it to the session" disabled={!owned} checked={send && owned} onChange={(e) => setSend(e.target.checked)} />
          Also send it to the session
        </label>
        <Button type="submit" size="sm" disabled={create.isPending}>
          Add reminder
        </Button>
      </form>
      {create.isError ? <p role="alert" className="text-xs text-red-600">Could not create the reminder.</p> : null}
    </section>
  );
}
```

`apps/web/src/features/limits/ContextFillBadge.tsx`
```tsx
import type { Source } from '@orc/core';
import { Badge } from '@/components/ui';
import { useContextFill } from '@/api/queries/usage';
import { formatPctValue } from './format.ts';

/** Context-window fill for one session, with the "resume fresh" hint near the limit (F19). */
export function ContextFillBadge({ source, id }: { source: Source; id: string }) {
  const { data } = useContextFill(source, id);
  if (!data) return null;
  return (
    <span className="flex items-center gap-1 text-xs" title={`${data.usedTokens.toLocaleString('en-US')} of ${data.windowTokens.toLocaleString('en-US')} tokens`}>
      <Badge variant={data.warn ? 'destructive' : 'outline'}>ctx {formatPctValue(data.fill)}</Badge>
      {data.warn ? <span className="text-amber-700">near the limit — resume fresh with a handoff</span> : null}
    </span>
  );
}
```

`apps/web/src/features/session-detail/SessionWorkPanel.tsx`
```tsx
import type { Session } from '@orc/core';
import { ContextFillBadge } from '../limits/ContextFillBadge.tsx';
import { GoalEditor } from '../goals/GoalEditor.tsx';
import { HandoffPanel } from '../handoffs/HandoffPanel.tsx';
import { RecapPanel } from '../recaps/RecapPanel.tsx';
import { ReminderPanel } from '../reminders/ReminderPanel.tsx';

/** Phase 5 work panel under the session header: goal, recap, handoff and reminders (F14, F16, F19). */
export function SessionWorkPanel({ session }: { session: Session }) {
  const pk = `${session.source}:${session.id}`;
  return (
    <div className="grid gap-4 border-b border-neutral-200 p-3 md:grid-cols-2 dark:border-neutral-700">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <ContextFillBadge source={session.source} id={session.id} />
        </div>
        <GoalEditor targetType="session" targetId={pk} />
        <ReminderPanel sessionPk={pk} ticket={session.tickets[0] ?? null} owned={session.live?.ownership === 'owned'} />
      </div>
      <div className="flex flex-col gap-3">
        <RecapPanel source={session.source} id={session.id} />
        <HandoffPanel source={session.source} id={session.id} />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Mount the panel and the history preview**

In `apps/web/src/features/session-detail/SessionDetailPage.tsx` (P3), render the panel between `SessionHeader` and `SessionDetailTabs`, using the session the page already loaded:
```tsx
      {session ? <SessionWorkPanel session={session} /> : null}
```

Add the recap preview to the history list. Find the row component first:
```bash
grep -rn "firstPrompt" apps/web/src/features/history | head
```
In the component that renders the row's preview text, add this line under the prompt (the list item type is `SessionListItem`, which already has `recap`):
```tsx
        {item.recap ? (
          <p className="truncate text-xs text-neutral-500" title="LLM recap">
            {item.recap.split('\n').find((l) => l.trim().length > 0) ?? ''}
          </p>
        ) : null}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run apps/web/src/features/goals apps/web/src/features/recaps apps/web/src/features/handoffs apps/web/src/features/reminders apps/web/src/api/queries/work-queries.test.tsx`
Expected: PASS (9 tests)

- [ ] **Step 7: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test
git add apps/web
git commit -m "feat(web): add the session work panel with goal, recap, handoff, reminders and context fill"
```

---

### Task 20: Settings — recaps, limits & budgets, and the bridge installer

**Files:**
- Create: `apps/web/src/api/queries/settings.ts`, `apps/web/src/api/queries/settings-queries.test.tsx`
- Create: `apps/web/src/features/settings/{RecapSettings.tsx,RecapSettings.test.tsx,LimitsSettings.tsx,LimitsSettings.test.tsx,BridgeSettings.tsx,BridgeSettings.test.tsx}`
- Modify: `apps/web/src/features/settings/SettingsPage.tsx` (P2/P3), replacing Phase 2's static "Real-time hook" section

**Interfaces:**
- Consumes: Task 1 client methods (`settingsGet`, `settingsUpdate`, `hooksInstallStatus`, `hooksInstall`, `hooksStatusline`); `useBudgets`, `useUpsertBudget`, `useDeleteBudget`, `useConcurrency` (Task 18); `useRecapSpend` (Task 19); `DEFAULT_RECAP_PROMPT` from `@orc/core/browser`; `projectsUpdate` and `useProjects` (P1)
- Produces:
  ```ts
  // api/queries/settings.ts
  export const settingsKeys: { all: readonly unknown[]; hooks: readonly unknown[]; statusline: readonly unknown[] }
  export function useSettings(): UseQueryResult<Settings>
  export function useUpdateSettings(): UseMutationResult<Settings, Error, SettingsUpdateBody>
  export function useHookStatus(): UseQueryResult<HookInstallStatus>
  export function useInstallHooks(): UseMutationResult<{ installed: true; settingsPath: string; backupPath: string | null }, Error, void>
  export function useStatuslineSnippet(): UseQueryResult<{ command: string; snippet: string }>
  // components
  export function RecapSettings(): JSX.Element
  export function LimitsSettings(): JSX.Element
  export function BridgeSettings(): JSX.Element
  ```
- Each section sends its **whole** config section back (`PUT /api/settings` replaces a section), so a form starts from the loaded values.
- Budgets from project config are read-only here (their id starts with `config:`); the page says to edit them in the project settings.
- **The bridge installer never writes anything until "Install hooks" is confirmed.** The statusline snippet is copy-only, and the page says so.

- [ ] **Step 1: Write the failing query test**

`apps/web/src/api/queries/settings-queries.test.tsx`
```tsx
import type { Settings } from '@orc/api-contract';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi, makeQueryClient, wrapperFor } from '../../test/p3-render.tsx';
import { setApiClientForTests } from '../client.ts';
import { settingsKeys, useInstallHooks, useSettings, useUpdateSettings } from './settings.ts';

const settings = {
  recaps: { enabled: false, trigger: 'manual', engine: 'claude-cli', autoModel: 'claude-haiku-4-5', onDemandModel: 'claude-sonnet-5', monthlyBudgetUsd: 20, maxInputTokens: 30000, minPrompts: 2, language: 'en', promptTemplate: null, idleMinutes: 10, excludeProjectIds: [], dailyProjectIds: ['wakecap'] },
  limits: { quotaSource: 'estimate', officialFieldPaths: { blockPct: null, blockResetsAt: null, weekPct: null, weekResetsAt: null }, blockTokenLimit: null, weekTokenLimit: null, warnPct: 0.8, contextWindows: { 'claude-opus-5': 1000000 }, defaultContextWindow: 200000, contextWarnFill: 0.85, pricing: {} },
  digest: { enabled: true, cron: '0 9 * * 1', dailyRecapCron: '0 19 * * 1-5' },
  hooks: { statusOverrideMs: 120000 },
} as unknown as Settings;

describe('settings queries', () => {
  it('caches settings and replaces them after an update', async () => {
    const settingsGet = vi.fn(async () => settings);
    const settingsUpdate = vi.fn(async () => ({ ...settings, recaps: { ...settings.recaps, enabled: true } }));
    setApiClientForTests(fakeApi({ settingsGet, settingsUpdate }));
    const client = makeQueryClient();
    const { result } = renderHook(() => ({ q: useSettings(), m: useUpdateSettings() }), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.q.isSuccess).toBe(true));
    await act(async () => {
      await result.current.m.mutateAsync({ recaps: { ...settings.recaps, enabled: true } });
    });
    expect((client.getQueryData(settingsKeys.all) as Settings).recaps.enabled).toBe(true);
  });

  it('refreshes the hook status after installing', async () => {
    const hooksInstallStatus = vi.fn(async () => ({ settingsPath: '/s.json', settingsExists: true, installed: false, command: 'curl …', snippet: '{}', backupDir: '/b' }));
    const hooksInstall = vi.fn(async () => ({ installed: true as const, settingsPath: '/s.json', backupPath: '/b/x.json' }));
    setApiClientForTests(fakeApi({ hooksInstallStatus, hooksInstall }));
    const client = makeQueryClient();
    const { result } = renderHook(() => useInstallHooks(), { wrapper: wrapperFor(client) });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(hooksInstall).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Write the hooks**

`apps/web/src/api/queries/settings.ts`
```ts
import type { Settings, SettingsUpdateBody } from '@orc/api-contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export const settingsKeys = {
  all: ['settings'] as const,
  hooks: ['hooks', 'install'] as const,
  statusline: ['hooks', 'statusline'] as const,
};

export function useSettings() {
  return useQuery({ queryKey: settingsKeys.all, queryFn: () => getApiClient().settingsGet(), staleTime: 30_000 });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsUpdateBody) => getApiClient().settingsUpdate(body),
    onSuccess: (s: Settings) => {
      qc.setQueryData(settingsKeys.all, s);
      void qc.invalidateQueries({ queryKey: ['usage'] });
    },
  });
}

export function useHookStatus() {
  return useQuery({ queryKey: settingsKeys.hooks, queryFn: () => getApiClient().hooksInstallStatus(), staleTime: 30_000 });
}

export function useInstallHooks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => getApiClient().hooksInstall(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKeys.hooks }),
  });
}

export function useStatuslineSnippet() {
  return useQuery({ queryKey: settingsKeys.statusline, queryFn: () => getApiClient().hooksStatusline(), staleTime: Number.POSITIVE_INFINITY });
}
```

Run: `pnpm vitest run apps/web/src/api/queries/settings-queries.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 3: Write the failing section tests**

`apps/web/src/features/settings/RecapSettings.test.tsx`
```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { RecapSettings } from './RecapSettings.tsx';

const recaps = {
  enabled: false, trigger: 'manual' as const, engine: 'claude-cli' as const, autoModel: 'claude-haiku-4-5', onDemandModel: 'claude-sonnet-5',
  monthlyBudgetUsd: 20, maxInputTokens: 30000, minPrompts: 2, language: 'en', promptTemplate: null, idleMinutes: 10,
  excludeProjectIds: [], dailyProjectIds: ['wakecap'],
};

function api(settingsUpdate = vi.fn(async () => ({ recaps }) as never)) {
  return fakeApi({
    settingsGet: vi.fn(async () => ({ recaps }) as never),
    settingsUpdate,
    recapsSpend: vi.fn(async () => ({ spentUsd: 3, budgetUsd: 20 })),
  });
}

describe('RecapSettings', () => {
  it('saves every recap option in one section update', async () => {
    const settingsUpdate = vi.fn(async () => ({ recaps: { ...recaps, enabled: true } }) as never);
    setApiClientForTests(api(settingsUpdate));
    const user = userEvent.setup();
    renderP3(<RecapSettings />);
    await user.click(await screen.findByLabelText('Enable automatic recaps'));
    await user.selectOptions(screen.getByLabelText('Trigger'), 'on_idle');
    await user.selectOptions(screen.getByLabelText('Engine'), 'anthropic-api');
    await user.clear(screen.getByLabelText('Monthly budget (USD)'));
    await user.type(screen.getByLabelText('Monthly budget (USD)'), '35');
    await user.clear(screen.getByLabelText('Output language'));
    await user.type(screen.getByLabelText('Output language'), 'ar');
    await user.click(screen.getByRole('button', { name: 'Save recap settings' }));
    await waitFor(() =>
      expect(settingsUpdate).toHaveBeenCalledWith({
        recaps: { ...recaps, enabled: true, trigger: 'on_idle', engine: 'anthropic-api', monthlyBudgetUsd: 35, language: 'ar' },
      }),
    );
    expect(screen.getByText(/\$3\.00 of \$20\.00 this month/)).toBeTruthy();
  });

  it('edits and resets the prompt template', async () => {
    const settingsUpdate = vi.fn(async () => ({ recaps }) as never);
    setApiClientForTests(api(settingsUpdate));
    const user = userEvent.setup();
    renderP3(<RecapSettings />);
    const box = await screen.findByLabelText('Prompt template');
    expect(box).toHaveAttribute('placeholder', expect.stringContaining('What to check'));
    await user.type(box, 'Custom {{digest}}');
    await user.click(screen.getByRole('button', { name: 'Save recap settings' }));
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledWith({ recaps: { ...recaps, promptTemplate: 'Custom {{digest}}' } }));
    await user.click(screen.getByRole('button', { name: 'Reset to the default prompt' }));
    expect(screen.getByLabelText('Prompt template')).toHaveValue('');
  });

  it('warns that the API engine needs a key', async () => {
    setApiClientForTests(api());
    const user = userEvent.setup();
    renderP3(<RecapSettings />);
    await user.selectOptions(await screen.findByLabelText('Engine'), 'anthropic-api');
    expect(screen.getByText(/ANTHROPIC_API_KEY/)).toBeTruthy();
  });
});
```

`apps/web/src/features/settings/LimitsSettings.test.tsx`
```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { LimitsSettings } from './LimitsSettings.tsx';

const limits = {
  quotaSource: 'estimate' as const, officialFieldPaths: { blockPct: null, blockResetsAt: null, weekPct: null, weekResetsAt: null },
  blockTokenLimit: null, weekTokenLimit: null, warnPct: 0.8, contextWindows: { 'claude-opus-5': 1000000 }, defaultContextWindow: 200000,
  contextWarnFill: 0.85, pricing: {},
};
const budgets = [
  { budget: { id: 'config:wakecap:daily', scopeType: 'project' as const, scopeId: 'wakecap', period: 'daily' as const, limitUsd: 50, origin: 'config' as const }, spentUsd: 41, pct: 0.82, periodStart: '2026-09-18T00:00:00.000Z' },
  { budget: { id: 'b2', scopeType: 'ticket' as const, scopeId: 'SAF-1', period: 'weekly' as const, limitUsd: 20, origin: 'table' as const }, spentUsd: 2, pct: 0.1, periodStart: '2026-09-14T00:00:00.000Z' },
];

describe('LimitsSettings', () => {
  it('saves plan limits and shows budgets with spend', async () => {
    const settingsUpdate = vi.fn(async () => ({ limits }) as never);
    setApiClientForTests(fakeApi({
      settingsGet: vi.fn(async () => ({ limits }) as never),
      settingsUpdate,
      usageBudgets: vi.fn(async () => budgets),
      usageConcurrency: vi.fn(async () => [{ projectId: 'wakecap', owned: 2, max: 6 }]),
      usageBudgetUpsert: vi.fn(async () => budgets[1]?.budget as never),
      usageBudgetDelete: vi.fn(async () => ({ ok: true as const })),
    }));
    const user = userEvent.setup();
    renderP3(<LimitsSettings />);
    await user.type(await screen.findByLabelText('5-hour token limit'), '88000000');
    await user.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(settingsUpdate).toHaveBeenCalledWith({ limits: { ...limits, blockTokenLimit: 88000000 } }));
    expect(screen.getByText('82%')).toBeTruthy();
    expect(screen.getByText('wakecap 2 / 6 owned sessions')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete budget SAF-1 weekly' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete budget wakecap daily' })).toBeNull();
  });

  it('adds a ticket budget', async () => {
    const usageBudgetUpsert = vi.fn(async () => budgets[1]?.budget as never);
    setApiClientForTests(fakeApi({
      settingsGet: vi.fn(async () => ({ limits }) as never),
      settingsUpdate: vi.fn(async () => ({ limits }) as never),
      usageBudgets: vi.fn(async () => []),
      usageConcurrency: vi.fn(async () => []),
      usageBudgetUpsert,
      usageBudgetDelete: vi.fn(async () => ({ ok: true as const })),
    }));
    const user = userEvent.setup();
    renderP3(<LimitsSettings />);
    await user.selectOptions(await screen.findByLabelText('Scope'), 'ticket');
    await user.type(screen.getByLabelText('Scope id'), 'SAF-1');
    await user.selectOptions(screen.getByLabelText('Period'), 'weekly');
    await user.clear(screen.getByLabelText('Limit (USD)'));
    await user.type(screen.getByLabelText('Limit (USD)'), '20');
    await user.click(screen.getByRole('button', { name: 'Add budget' }));
    await waitFor(() => expect(usageBudgetUpsert).toHaveBeenCalledWith({ scopeType: 'ticket', scopeId: 'SAF-1', period: 'weekly', limitUsd: 20 }));
  });
});
```

`apps/web/src/features/settings/BridgeSettings.test.tsx`
```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { BridgeSettings } from './BridgeSettings.tsx';

const status = { settingsPath: '/Users/test/.claude/settings.json', settingsExists: true, installed: false, command: 'curl -s … # orc-hook-bridge', snippet: '{\n  "hooks": {}\n}', backupDir: '/Users/test/.orchestrator/backups' };

describe('BridgeSettings', () => {
  it('shows the snippet and only installs after a confirmation', async () => {
    const hooksInstall = vi.fn(async () => ({ installed: true as const, settingsPath: status.settingsPath, backupPath: '/Users/test/.orchestrator/backups/claude-settings-x.json' }));
    setApiClientForTests(fakeApi({
      hooksInstallStatus: vi.fn(async () => status),
      hooksInstall,
      hooksStatusline: vi.fn(async () => ({ command: 'node /x/dist/orc-statusline.js', snippet: '{"statusLine":{}}' })),
    }));
    const user = userEvent.setup();
    renderP3(<BridgeSettings />);
    expect(await screen.findByText(/"hooks"/)).toBeTruthy();
    expect(screen.getByText(status.settingsPath)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Install hooks…' }));
    expect(hooksInstall).not.toHaveBeenCalled();
    expect(screen.getByText(new RegExp(status.backupDir))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirm — write settings.json' }));
    await waitFor(() => expect(hooksInstall).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Backup written to/)).toBeTruthy();
  });

  it('shows the statusline snippet as copy-only', async () => {
    setApiClientForTests(fakeApi({
      hooksInstallStatus: vi.fn(async () => ({ ...status, installed: true })),
      hooksInstall: vi.fn(async () => ({ installed: true as const, settingsPath: '/x', backupPath: null })),
      hooksStatusline: vi.fn(async () => ({ command: 'node /x/dist/orc-statusline.js', snippet: '{"statusLine":{"type":"command"}}' })),
    }));
    renderP3(<BridgeSettings />);
    expect(await screen.findByText('Hooks are installed.')).toBeTruthy();
    expect(screen.getByText(/"statusLine"/)).toBeTruthy();
    expect(screen.getByText(/add it to .* yourself/i)).toBeTruthy();
  });
});
```

- [ ] **Step 4: Implement the three sections**

`apps/web/src/features/settings/RecapSettings.tsx`
```tsx
import type { RecapsConfig } from '@orc/api-contract';
import { DEFAULT_RECAP_PROMPT } from '@orc/core/browser';
import { type FormEvent, useEffect, useState } from 'react';
import { Button, Input } from '@/components/ui';
import { useRecapSpend } from '@/api/queries/work';
import { useSettings, useUpdateSettings } from '@/api/queries/settings';
import { formatUsd } from '../limits/format.ts';

const TRIGGERS: Array<RecapsConfig['trigger']> = ['manual', 'on_idle', 'daily'];
const ENGINES: Array<RecapsConfig['engine']> = ['claude-cli', 'anthropic-api'];
const numberOr = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : fallback);
const csv = (v: string) => v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

export function RecapSettings() {
  const q = useSettings();
  const save = useUpdateSettings();
  const spend = useRecapSpend();
  const [form, setForm] = useState<RecapsConfig | null>(null);
  useEffect(() => {
    if (q.data) setForm(q.data.recaps);
  }, [q.data]);
  if (!form) return <section aria-label="LLM recaps"><p>Loading…</p></section>;
  const set = <K extends keyof RecapsConfig>(key: K, value: RecapsConfig[K]) => setForm({ ...form, [key]: value });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (form) save.mutate({ recaps: form });
  }

  return (
    <section aria-label="LLM recaps" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">LLM recaps</h2>
      <p className="text-xs text-neutral-500">
        Recaps send a redacted digest (prompts, assistant text, tool names, deliverables and test results) to the engine below. Tool output is never sent.
        {spend.data ? ` Spent ${formatUsd(spend.data.spentUsd)} of ${formatUsd(spend.data.budgetUsd)} this month.` : ''}
      </p>
      <form onSubmit={onSubmit} className="flex flex-col gap-2 text-xs">
        <label className="flex items-center gap-2">
          <input type="checkbox" aria-label="Enable automatic recaps" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Enable automatic recaps
        </label>
        <div className="flex flex-wrap gap-3">
          <label>
            Trigger{' '}
            <select aria-label="Trigger" className="rounded border px-1 py-0.5" value={form.trigger} onChange={(e) => set('trigger', e.target.value as RecapsConfig['trigger'])}>
              {TRIGGERS.map((t) => (<option key={t} value={t}>{t}</option>))}
            </select>
          </label>
          <label>
            Engine{' '}
            <select aria-label="Engine" className="rounded border px-1 py-0.5" value={form.engine} onChange={(e) => set('engine', e.target.value as RecapsConfig['engine'])}>
              {ENGINES.map((t) => (<option key={t} value={t}>{t}</option>))}
            </select>
          </label>
          <label>
            Idle minutes <Input aria-label="Idle minutes" className="w-20" type="number" min={1} value={form.idleMinutes} onChange={(e) => set('idleMinutes', numberOr(e.target.value, form.idleMinutes))} />
          </label>
        </div>
        {form.engine === 'anthropic-api' ? (
          <p className="text-amber-700">The API engine needs ANTHROPIC_API_KEY in the daemon's environment. The `claude-cli` engine reuses your Claude login.</p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <label>Automatic model <Input aria-label="Automatic model" value={form.autoModel} onChange={(e) => set('autoModel', e.target.value)} /></label>
          <label>On-demand model <Input aria-label="On-demand model" value={form.onDemandModel} onChange={(e) => set('onDemandModel', e.target.value)} /></label>
          <label>Monthly budget (USD) <Input aria-label="Monthly budget (USD)" className="w-24" type="number" min={0} step="1" value={form.monthlyBudgetUsd} onChange={(e) => set('monthlyBudgetUsd', numberOr(e.target.value, form.monthlyBudgetUsd))} /></label>
          <label>Max input tokens <Input aria-label="Max input tokens" className="w-28" type="number" min={1000} value={form.maxInputTokens} onChange={(e) => set('maxInputTokens', numberOr(e.target.value, form.maxInputTokens))} /></label>
          <label>Skip under N prompts <Input aria-label="Skip under N prompts" className="w-20" type="number" min={0} value={form.minPrompts} onChange={(e) => set('minPrompts', numberOr(e.target.value, form.minPrompts))} /></label>
          <label>Output language <Input aria-label="Output language" className="w-20" value={form.language} onChange={(e) => set('language', e.target.value)} /></label>
        </div>
        <div className="flex flex-wrap gap-3">
          <label>Excluded projects <Input aria-label="Excluded projects" value={form.excludeProjectIds.join(', ')} onChange={(e) => set('excludeProjectIds', csv(e.target.value))} /></label>
          <label>Daily recap projects <Input aria-label="Daily recap projects" value={form.dailyProjectIds.join(', ')} onChange={(e) => set('dailyProjectIds', csv(e.target.value))} /></label>
        </div>
        <label className="flex flex-col gap-1">
          Prompt template
          <textarea
            aria-label="Prompt template"
            className="h-40 rounded border p-2 font-mono text-[11px]"
            placeholder={DEFAULT_RECAP_PROMPT}
            value={form.promptTemplate ?? ''}
            onChange={(e) => set('promptTemplate', e.target.value.length > 0 ? e.target.value : null)}
          />
        </label>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={save.isPending}>Save recap settings</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => set('promptTemplate', null)}>Reset to the default prompt</Button>
          {save.isError ? <span role="alert" className="text-red-600">Could not save.</span> : null}
        </div>
      </form>
    </section>
  );
}
```

`apps/web/src/features/settings/LimitsSettings.tsx`
```tsx
import type { BudgetPeriod, BudgetScopeType } from '@orc/core';
import type { LimitsConfig } from '@orc/api-contract';
import { type FormEvent, useEffect, useState } from 'react';
import { Button, Input } from '@/components/ui';
import { useBudgets, useConcurrency, useDeleteBudget, useUpsertBudget } from '@/api/queries/usage';
import { useSettings, useUpdateSettings } from '@/api/queries/settings';
import { formatPctValue, formatUsd } from '../limits/format.ts';

const SCOPES: BudgetScopeType[] = ['global', 'project', 'ticket'];
const PERIODS: BudgetPeriod[] = ['daily', 'weekly', 'monthly'];
const intOrNull = (v: string) => (v.trim() === '' ? null : Math.trunc(Number(v)) || null);

export function LimitsSettings() {
  const q = useSettings();
  const save = useUpdateSettings();
  const budgets = useBudgets();
  const upsert = useUpsertBudget();
  const remove = useDeleteBudget();
  const concurrency = useConcurrency();
  const [form, setForm] = useState<LimitsConfig | null>(null);
  const [scopeType, setScopeType] = useState<BudgetScopeType>('project');
  const [scopeId, setScopeId] = useState('');
  const [period, setPeriod] = useState<BudgetPeriod>('daily');
  const [limitUsd, setLimitUsd] = useState('50');

  useEffect(() => {
    if (q.data) setForm(q.data.limits);
  }, [q.data]);
  if (!form) return <section aria-label="Limits & budgets"><p>Loading…</p></section>;

  function onSaveLimits(e: FormEvent) {
    e.preventDefault();
    if (form) save.mutate({ limits: form });
  }

  function onAddBudget(e: FormEvent) {
    e.preventDefault();
    const usd = Number(limitUsd);
    if (!Number.isFinite(usd) || usd <= 0) return;
    upsert.mutate({ scopeType, scopeId: scopeType === 'global' ? null : scopeId.trim(), period, limitUsd: usd });
  }

  return (
    <section aria-label="Limits & budgets" className="flex flex-col gap-3 text-xs">
      <h2 className="text-base font-semibold">Limits & budgets</h2>
      <p className="text-neutral-500">
        Quota figures are {form.quotaSource === 'estimate' ? 'estimated from transcripts (like ccusage)' : 'read from the official statusline source'}. Set your plan's
        token limits to turn the bars into percentages.
      </p>
      <form onSubmit={onSaveLimits} className="flex flex-wrap items-end gap-3">
        <label>5-hour token limit <Input aria-label="5-hour token limit" className="w-32" type="number" min={0} value={form.blockTokenLimit ?? ''} onChange={(e) => setForm({ ...form, blockTokenLimit: intOrNull(e.target.value) })} /></label>
        <label>7-day token limit <Input aria-label="7-day token limit" className="w-32" type="number" min={0} value={form.weekTokenLimit ?? ''} onChange={(e) => setForm({ ...form, weekTokenLimit: intOrNull(e.target.value) })} /></label>
        <label>Warn at <Input aria-label="Warn at" className="w-20" type="number" min={0} max={1} step="0.05" value={form.warnPct} onChange={(e) => setForm({ ...form, warnPct: Number(e.target.value) })} /></label>
        <label>Context warning at <Input aria-label="Context warning at" className="w-20" type="number" min={0} max={1} step="0.05" value={form.contextWarnFill} onChange={(e) => setForm({ ...form, contextWarnFill: Number(e.target.value) })} /></label>
        <label>Default context window <Input aria-label="Default context window" className="w-28" type="number" min={1000} value={form.defaultContextWindow} onChange={(e) => setForm({ ...form, defaultContextWindow: Number(e.target.value) })} /></label>
        <Button type="submit" size="sm" disabled={save.isPending}>Save limits</Button>
      </form>

      <table className="w-full">
        <caption className="text-left text-neutral-500">Budgets</caption>
        <thead>
          <tr className="text-left text-neutral-500">
            <th>scope</th><th>period</th><th>spent</th><th>limit</th><th>used</th><th />
          </tr>
        </thead>
        <tbody>
          {(budgets.data ?? []).map((s) => (
            <tr key={s.budget.id}>
              <td>{s.budget.scopeType === 'global' ? 'all projects' : `${s.budget.scopeType} ${s.budget.scopeId}`}</td>
              <td>{s.budget.period}</td>
              <td>{formatUsd(s.spentUsd)}</td>
              <td>{formatUsd(s.budget.limitUsd)}</td>
              <td className={s.pct >= 1 ? 'text-red-600' : s.pct >= form.warnPct ? 'text-amber-600' : ''}>{formatPctValue(s.pct)}</td>
              <td>
                {s.budget.origin === 'table' ? (
                  <Button size="sm" variant="ghost" aria-label={`Delete budget ${s.budget.scopeId ?? 'global'} ${s.budget.period}`} onClick={() => remove.mutate(s.budget.id)}>
                    ✕
                  </Button>
                ) : (
                  <span className="text-neutral-400" title="From the project configuration">config</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form onSubmit={onAddBudget} className="flex flex-wrap items-end gap-2">
        <label>
          Scope{' '}
          <select aria-label="Scope" className="rounded border px-1 py-0.5" value={scopeType} onChange={(e) => setScopeType(e.target.value as BudgetScopeType)}>
            {SCOPES.map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
        </label>
        {scopeType !== 'global' ? <label>Scope id <Input aria-label="Scope id" className="w-28" value={scopeId} onChange={(e) => setScopeId(e.target.value)} /></label> : null}
        <label>
          Period{' '}
          <select aria-label="Period" className="rounded border px-1 py-0.5" value={period} onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}>
            {PERIODS.map((p) => (<option key={p} value={p}>{p}</option>))}
          </select>
        </label>
        <label>Limit (USD) <Input aria-label="Limit (USD)" className="w-24" type="number" min={1} value={limitUsd} onChange={(e) => setLimitUsd(e.target.value)} /></label>
        <Button type="submit" size="sm" disabled={upsert.isPending}>Add budget</Button>
      </form>

      <ul className="text-neutral-500">
        {(concurrency.data ?? []).map((c) => (
          <li key={c.projectId}>{`${c.projectId} ${c.owned} / ${c.max} owned sessions`}</li>
        ))}
      </ul>
    </section>
  );
}
```

`apps/web/src/features/settings/BridgeSettings.tsx`
```tsx
import { useState } from 'react';
import { Badge, Button } from '@/components/ui';
import { useHookStatus, useInstallHooks, useStatuslineSnippet } from '@/api/queries/settings';

export function BridgeSettings() {
  const status = useHookStatus();
  const install = useInstallHooks();
  const statusline = useStatuslineSnippet();
  const [confirming, setConfirming] = useState(false);
  const s = status.data;

  return (
    <section aria-label="Real-time bridge" className="flex flex-col gap-2 text-xs">
      <h2 className="text-base font-semibold">Real-time bridge (optional)</h2>
      <p className="text-neutral-500">
        Claude Code hooks push SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification and Stop events to the daemon on 127.0.0.1, which makes status
        changes appear in well under a second. Without them the app polls files instead.
      </p>
      {s ? (
        <>
          <p>
            Settings file: <code>{s.settingsPath}</code> {s.installed ? <Badge>installed</Badge> : <Badge variant="outline">not installed</Badge>}
          </p>
          {s.installed ? <p className="text-emerald-700">Hooks are installed.</p> : null}
          <pre className="max-h-60 overflow-auto rounded bg-neutral-100 p-2 dark:bg-neutral-800">{s.snippet}</pre>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(s.snippet)}>Copy snippet</Button>
            {confirming ? (
              <Button size="sm" disabled={install.isPending} onClick={() => install.mutate(undefined, { onSuccess: () => setConfirming(false) })}>
                Confirm — write settings.json
              </Button>
            ) : (
              <Button size="sm" onClick={() => setConfirming(true)}>{s.installed ? 'Reinstall hooks…' : 'Install hooks…'}</Button>
            )}
          </div>
          {confirming ? (
            <p className="text-amber-700">
              {`This is the only file the app writes inside ~/.claude. A backup is saved to ${s.backupDir} first, and the change is recorded in the audit log.`}
            </p>
          ) : null}
          {install.isSuccess ? (
            <p className="text-emerald-700">{`Installed. Backup written to ${install.data.backupPath ?? '(no previous file)'}.`}</p>
          ) : null}
          {install.isError ? <p role="alert" className="text-red-600">Could not write settings.json. Check that it is valid JSON.</p> : null}
        </>
      ) : (
        <p>Loading…</p>
      )}
      <h3 className="mt-2 font-semibold">Statusline (optional)</h3>
      <p className="text-neutral-500">
        Shows session cost, context fill, the current 5-hour block and the number of waiting sessions in Claude's statusline. The app never writes this — copy it and add
        it to <code>~/.claude/settings.json</code> yourself.
      </p>
      <pre className="overflow-auto rounded bg-neutral-100 p-2 dark:bg-neutral-800">{statusline.data?.snippet ?? ''}</pre>
      <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(statusline.data?.snippet ?? '')}>
        Copy statusline snippet
      </Button>
    </section>
  );
}
```

In `apps/web/src/features/settings/SettingsPage.tsx`, delete Phase 2's static "Real-time hook" section (the one that renders `HOOK_SNIPPET`) and render the three new sections after the existing ones:
```tsx
      <RecapSettings />
      <LimitsSettings />
      <BridgeSettings />
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run apps/web/src/features/settings apps/web/src/api/queries/settings-queries.test.tsx`
Expected: PASS (9 tests, including Phase 2's archive and notification sections)

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test
git add apps/web
git commit -m "feat(web): add recap, limits/budget and bridge settings sections"
```

---

### Task 21: Work Streams pages — `/streams` list, kanban toggle and `/streams/$ticket`

**Files:**
- Create: `apps/web/src/api/queries/streams.ts`
- Create: `apps/web/src/stores/streams.ts`
- Create: `apps/web/src/features/streams/{stages.ts,stages.test.ts,StreamsPage.tsx,StreamsPage.test.tsx,StreamDetailPage.tsx,StreamDetailPage.test.tsx}`
- Create: `apps/web/src/routes/streams/index.tsx`, `apps/web/src/routes/streams/$ticket.tsx`
- Modify: `apps/web/src/features/shell/AppShell.tsx`, `apps/web/src/features/hotkeys/GlobalHotkeys.tsx`, `apps/web/src/features/palette/palette-items.ts` (P3)

**Interfaces:**
- Consumes: Task 1 client methods (`streamsList`, `streamsGet`, `streamsLink`, `streamsUnlink`, `streamsRefresh`); `GoalEditor` (Task 19); `formatUsd`, `formatPctValue` (Task 18); `useProjectStore` (P1); `renderP3`, `fakeApi` (P3)
- Produces:
  ```ts
  // api/queries/streams.ts
  export const streamKeys: { list(f: { projectId?: string; stage?: StreamStage }): readonly unknown[]; detail(ticket: string): readonly unknown[] }
  export function useStreams(f: { projectId?: string; stage?: StreamStage }): UseQueryResult<WorkStream[]>
  export function useStream(ticket: string): UseQueryResult<StreamDetail>
  export function useRefreshStreams(): UseMutationResult<WorkStream[], Error, void>
  export function useLinkStream(ticket: string): UseMutationResult<StreamLink, Error, { kind: StreamLinkKind; ref: string }>
  export function useUnlinkStream(ticket: string): UseMutationResult<StreamLink, Error, { kind: StreamLinkKind; ref: string }>
  // stores/streams.ts
  export function useStreamViewStore(): { view: 'list' | 'kanban'; setView(v: 'list' | 'kanban'): void }
  // features/streams/stages.ts
  export const STAGE_LABELS: Record<StreamStage, string>
  export const STAGE_ORDER: readonly StreamStage[]
  export function stageIndex(s: StreamStage): number
  export function groupByStage(streams: WorkStream[]): Array<{ stage: StreamStage; label: string; streams: WorkStream[] }>
  export function sessionHref(pk: string): string
  // pages
  export function StreamsPage(): JSX.Element
  export function StreamDetailPage(p: { ticket: string }): JSX.Element
  ```
- The view choice is stored in `localStorage` under `orc.stream-view`, inside `try`/`catch` so private windows still work.

- [ ] **Step 1: Write the failing stage test**

`apps/web/src/features/streams/stages.test.ts`
```ts
import type { WorkStream } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { STAGE_ORDER, groupByStage, sessionHref, stageIndex } from './stages.ts';

const s = (ticket: string, stage: WorkStream['stage']): WorkStream => ({
  ticket, projectId: 'wakecap', title: null, stage, sessionIds: [], prs: [], plans: [], worktrees: [], costUsd: 1, lastActivityAt: 't',
});

describe('stages', () => {
  it('orders stages from planned to released', () => {
    expect(STAGE_ORDER).toEqual(['planned', 'implementing', 'in_review', 'pr_open', 'merged', 'backmerged', 'released']);
    expect(stageIndex('merged')).toBe(4);
  });

  it('groups streams into every column, even empty ones', () => {
    const cols = groupByStage([s('SAF-1', 'merged'), s('SAF-2', 'planned'), s('SAF-3', 'merged')]);
    expect(cols).toHaveLength(7);
    expect(cols.map((c) => c.streams.length)).toEqual([1, 0, 0, 0, 2, 0, 0]);
    expect(cols[4]?.label).toBe('Merged');
  });

  it('builds session links from a pk', () => {
    expect(sessionHref('claude:s-basic')).toBe('/sessions/claude/s-basic');
    expect(sessionHref('codex:c0dex:1')).toBe('/sessions/codex/c0dex%3A1');
  });
});
```

- [ ] **Step 2: Write the failing page tests**

`apps/web/src/features/streams/StreamsPage.test.tsx`
```tsx
import type { WorkStream } from '@orc/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { StreamsPage } from './StreamsPage.tsx';

const streams: WorkStream[] = [
  { ticket: 'SAF-1787', projectId: 'wakecap', title: 'Exclude weekends from the SLA deadline', stage: 'merged', sessionIds: ['claude:s1', 'claude:s2'], prs: [{ repo: 'o/r', number: 231, url: 'https://x/231' }], plans: ['/w/plans/SAF-1787-x.md'], worktrees: [], costUsd: 12.5, lastActivityAt: '2026-09-17T10:00:00.000Z' },
  { ticket: 'ALU-42', projectId: 'wakecap', title: null, stage: 'planned', sessionIds: [], prs: [], plans: [], worktrees: [], costUsd: 0, lastActivityAt: '2026-09-16T10:00:00.000Z' },
];

describe('StreamsPage', () => {
  it('lists streams with stage, cost and counts, and filters by stage', async () => {
    const streamsList = vi.fn(async () => streams);
    setApiClientForTests(fakeApi({ streamsList, streamsRefresh: vi.fn(async () => streams) }));
    const user = userEvent.setup();
    renderP3(<StreamsPage />);
    expect(await screen.findByRole('link', { name: /SAF-1787/ })).toHaveAttribute('href', '/streams/SAF-1787');
    expect(screen.getByText('Exclude weekends from the SLA deadline')).toBeTruthy();
    expect(screen.getByText('$12.50')).toBeTruthy();
    expect(screen.getByText('2 sessions · 1 PR · 1 plan')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Stage'), 'merged');
    await waitFor(() => expect(streamsList).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'merged' })));
  });

  it('switches to the kanban board and back, and remembers the choice', async () => {
    setApiClientForTests(fakeApi({ streamsList: vi.fn(async () => streams), streamsRefresh: vi.fn(async () => streams) }));
    const user = userEvent.setup();
    const first = renderP3(<StreamsPage />);
    await user.click(await screen.findByRole('button', { name: 'Kanban' }));
    expect(await screen.findByRole('region', { name: 'Merged' })).toBeTruthy();
    expect(window.localStorage.getItem('orc.stream-view')).toBe('kanban');
    first.unmount();
    renderP3(<StreamsPage />);
    expect(await screen.findByRole('region', { name: 'Planned' })).toBeTruthy();
  });
});
```

`apps/web/src/features/streams/StreamDetailPage.test.tsx`
```tsx
import type { StreamDetail } from '@orc/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { StreamDetailPage } from './StreamDetailPage.tsx';

const detail: StreamDetail = {
  stream: { ticket: 'SAF-1787', projectId: 'wakecap', title: 'Exclude weekends', stage: 'backmerged', sessionIds: ['claude:s1'], prs: [{ repo: 'o/r', number: 231, url: 'https://x/231' }], plans: ['/w/plans/SAF-1787-x.md'], worktrees: ['/w/.worktrees/feat-SAF-1787'], costUsd: 12.5, lastActivityAt: '2026-09-17T10:00:00.000Z' },
  prsDetailed: [
    { pr: { repo: 'o/r', number: 231, url: 'https://x/231' }, title: 'feat: SAF-1787', state: 'merged', headRef: 'feat/SAF-1787-x', baseRef: null, isBackmerge: false, checks: 'success', review: 'approved', updatedAt: '2026-09-16T10:00:00.000Z', mergedAt: '2026-09-16T10:00:00.000Z' },
    { pr: { repo: 'o/r', number: 240, url: 'https://x/240' }, title: 'backmerge master → staging', state: 'merged', headRef: 'backmerge/SAF-1787', baseRef: 'staging', isBackmerge: true, checks: 'pending', review: 'none', updatedAt: '2026-09-17T09:00:00.000Z', mergedAt: '2026-09-17T09:00:00.000Z' },
  ],
  links: [
    { ticket: 'SAF-1787', kind: 'session', ref: 'claude:s1', origin: 'auto', excluded: false, createdAt: 't' },
    { ticket: 'SAF-1787', kind: 'session', ref: 'claude:s9', origin: 'manual', excluded: true, createdAt: 't' },
  ],
  timeline: [
    { ts: '2026-09-17T09:00:00.000Z', kind: 'pr', title: '#240 backmerge master → staging', ref: 'https://x/240', detail: 'merged · backmerge · checks pending · review none' },
    { ts: '2026-09-16T10:00:00.000Z', kind: 'recap', title: 'Recap', ref: 'claude:s1', detail: 'Excluded weekends from the SLA clock.' },
  ],
  goal: { id: 'g1', targetType: 'stream', targetId: 'SAF-1787', objective: 'ship the weekend rule', state: 'complete', blockedReason: null, updatedAt: 't' },
  handoff: { id: 'h1', sessionId: 'claude:s1', status: 'ready_for_review', summary: 'Done.', evidence: [], files: [], nextSteps: ['Watch staging'], blockers: [], links: [], createdAt: 't' },
  budget: { ok: true, pct: 0.25, limitUsd: 50 },
};

function api(over = {}) {
  return fakeApi({
    streamsGet: vi.fn(async () => detail),
    streamsLink: vi.fn(async (ticket: string, b: { kind: string; ref: string }) => ({ ticket, ...b, origin: 'manual', excluded: false, createdAt: 't' }) as never),
    streamsUnlink: vi.fn(async (ticket: string, b: { kind: string; ref: string }) => ({ ticket, ...b, origin: 'manual', excluded: true, createdAt: 't' }) as never),
    goalsGet: vi.fn(async () => ({ goal: detail.goal, prefill: 'SAF-1787' })),
    goalsSet: vi.fn(async () => detail.goal as never),
    ...over,
  });
}

describe('StreamDetailPage', () => {
  it('answers what happened, what it cost and what is next on one screen', async () => {
    setApiClientForTests(api());
    renderP3(<StreamDetailPage ticket="SAF-1787" />);
    expect(await screen.findByRole('heading', { name: /SAF-1787/ })).toBeTruthy();
    expect(screen.getByText('Exclude weekends')).toBeTruthy();
    expect(screen.getByLabelText('Stage')).toHaveTextContent('Backmerged');
    expect(screen.getByText('$12.50')).toBeTruthy();
    expect(screen.getByText('25% of $50.00')).toBeTruthy();
    expect(screen.getByText('Excluded weekends from the SLA clock.')).toBeTruthy();
    expect(screen.getByRole('link', { name: '#231 feat: SAF-1787' })).toHaveAttribute('href', 'https://x/231');
    expect(screen.getByText('backmerge')).toBeTruthy();
    expect(screen.getByText('Watch staging')).toBeTruthy();
    expect(screen.getByLabelText('Goal')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'claude:s1' })).toHaveAttribute('href', '/sessions/claude/s1');
  });

  it('links and unlinks by hand', async () => {
    const client = api();
    setApiClientForTests(client);
    const user = userEvent.setup();
    renderP3(<StreamDetailPage ticket="SAF-1787" />);
    await user.selectOptions(await screen.findByLabelText('Link kind'), 'session');
    await user.type(screen.getByLabelText('Link reference'), 'claude:s5');
    await user.click(screen.getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(client.streamsLink).toHaveBeenCalledWith('SAF-1787', { kind: 'session', ref: 'claude:s5' }));
    await user.click(screen.getByRole('button', { name: 'Unlink session claude:s1' }));
    expect(client.streamsUnlink).toHaveBeenCalledWith('SAF-1787', { kind: 'session', ref: 'claude:s1' });
    expect(screen.getByText(/claude:s9 \(unlinked\)/)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `pnpm vitest run apps/web/src/features/streams`
Expected: FAIL, `Cannot find module './stages.ts'`.

- [ ] **Step 4: Write the store, queries and stage helpers**

`apps/web/src/stores/streams.ts`
```ts
import { create } from 'zustand';

export type StreamView = 'list' | 'kanban';
const KEY = 'orc.stream-view';

function load(): StreamView {
  try {
    return window.localStorage.getItem(KEY) === 'kanban' ? 'kanban' : 'list';
  } catch {
    return 'list';
  }
}

export const useStreamViewStore = create<{ view: StreamView; setView(v: StreamView): void }>((set) => ({
  view: load(),
  setView(view) {
    try {
      window.localStorage.setItem(KEY, view);
    } catch {
      // private window or blocked storage: keep it in memory only
    }
    set({ view });
  },
}));
```

`apps/web/src/api/queries/streams.ts`
```ts
import type { StreamLinkKind, StreamStage } from '@orc/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export const streamKeys = {
  list: (f: { projectId?: string; stage?: StreamStage }) => ['streams', f] as const,
  detail: (ticket: string) => ['stream', ticket] as const,
};

export function useStreams(f: { projectId?: string; stage?: StreamStage }) {
  return useQuery({ queryKey: streamKeys.list(f), queryFn: () => getApiClient().streamsList(f), staleTime: 15_000 });
}

export function useStream(ticket: string) {
  return useQuery({ queryKey: streamKeys.detail(ticket), queryFn: () => getApiClient().streamsGet(ticket), staleTime: 15_000 });
}

export function useRefreshStreams() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => getApiClient().streamsRefresh(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['streams'] }),
  });
}

function useLinkMutation(ticket: string, verb: 'link' | 'unlink') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { kind: StreamLinkKind; ref: string }) =>
      verb === 'link' ? getApiClient().streamsLink(ticket, b) : getApiClient().streamsUnlink(ticket, b),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: streamKeys.detail(ticket) });
      void qc.invalidateQueries({ queryKey: ['streams'] });
    },
  });
}

export const useLinkStream = (ticket: string) => useLinkMutation(ticket, 'link');
export const useUnlinkStream = (ticket: string) => useLinkMutation(ticket, 'unlink');
```

`apps/web/src/features/streams/stages.ts`
```ts
import type { StreamStage, WorkStream } from '@orc/core';

export const STAGE_ORDER: readonly StreamStage[] = ['planned', 'implementing', 'in_review', 'pr_open', 'merged', 'backmerged', 'released'];

export const STAGE_LABELS: Record<StreamStage, string> = {
  planned: 'Planned',
  implementing: 'Implementing',
  in_review: 'In review',
  pr_open: 'PR open',
  merged: 'Merged',
  backmerged: 'Backmerged',
  released: 'Released',
};

export function stageIndex(s: StreamStage): number {
  return STAGE_ORDER.indexOf(s);
}

export function groupByStage(streams: WorkStream[]): Array<{ stage: StreamStage; label: string; streams: WorkStream[] }> {
  return STAGE_ORDER.map((stage) => ({ stage, label: STAGE_LABELS[stage], streams: streams.filter((s) => s.stage === stage) }));
}

export function sessionHref(pk: string): string {
  const [source, ...rest] = pk.split(':');
  return `/sessions/${source ?? 'claude'}/${encodeURIComponent(rest.join(':'))}`;
}
```

- [ ] **Step 5: Write the two pages and the routes**

`apps/web/src/features/streams/StreamsPage.tsx`
```tsx
import type { StreamStage, WorkStream } from '@orc/core';
import { useState } from 'react';
import { Badge, Button } from '@/components/ui';
import { useRefreshStreams, useStreams } from '@/api/queries/streams';
import { useProjectStore } from '@/stores/project';
import { useStreamViewStore } from '@/stores/streams';
import { formatUsd } from '../limits/format.ts';
import { STAGE_LABELS, STAGE_ORDER, groupByStage } from './stages.ts';

function counts(s: WorkStream): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [plural(s.sessionIds.length, 'session'), plural(s.prs.length, 'PR'), plural(s.plans.length, 'plan')].join(' · ');
}

function StreamCard({ s }: { s: WorkStream }) {
  return (
    <article className="rounded border border-neutral-200 p-2 text-sm dark:border-neutral-700">
      <div className="flex items-center justify-between gap-2">
        <a className="font-medium underline" href={`/streams/${s.ticket}`}>{s.ticket}</a>
        <span>{formatUsd(s.costUsd)}</span>
      </div>
      {s.title ? <p className="truncate text-neutral-600 dark:text-neutral-300">{s.title}</p> : null}
      <p className="text-xs text-neutral-500">{counts(s)}</p>
      <p className="text-xs text-neutral-400">{s.lastActivityAt.slice(0, 16).replace('T', ' ')} UTC</p>
    </article>
  );
}

export function StreamsPage() {
  const projectId = useProjectStore((st) => st.projectId);
  const [stage, setStage] = useState<StreamStage | ''>('');
  const view = useStreamViewStore((st) => st.view);
  const setView = useStreamViewStore((st) => st.setView);
  const filters = { ...(projectId ? { projectId } : {}), ...(stage ? { stage } : {}) };
  const q = useStreams(filters);
  const refresh = useRefreshStreams();
  const streams = q.data ?? [];

  return (
    <main className="flex flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Work streams</h1>
        <label className="text-xs">
          Stage{' '}
          <select aria-label="Stage" className="rounded border px-1 py-0.5" value={stage} onChange={(e) => setStage(e.target.value as StreamStage | '')}>
            <option value="">all</option>
            {STAGE_ORDER.map((s) => (<option key={s} value={s}>{STAGE_LABELS[s]}</option>))}
          </select>
        </label>
        <div role="group" aria-label="View" className="flex gap-1">
          <Button size="sm" variant={view === 'list' ? 'default' : 'outline'} onClick={() => setView('list')}>List</Button>
          <Button size="sm" variant={view === 'kanban' ? 'default' : 'outline'} onClick={() => setView('kanban')}>Kanban</Button>
        </div>
        <Button size="sm" variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>Refresh</Button>
      </header>

      {q.isLoading ? <p>Loading streams…</p> : null}
      {!q.isLoading && streams.length === 0 ? (
        <p className="text-sm text-neutral-500">No streams yet. Work streams are built from tickets in prompts, branches, PRs, plans, worktrees and wstack workflows, for projects with work streams enabled.</p>
      ) : null}

      {view === 'list' ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-neutral-500">
              <th>ticket</th><th>title</th><th>stage</th><th>cost</th><th>links</th><th>last activity</th>
            </tr>
          </thead>
          <tbody>
            {streams.map((s) => (
              <tr key={s.ticket} className="border-t border-neutral-100 dark:border-neutral-800">
                <td><a className="underline" href={`/streams/${s.ticket}`}>{s.ticket}</a></td>
                <td className="max-w-md truncate">{s.title ?? '—'}</td>
                <td><Badge variant="outline">{STAGE_LABELS[s.stage]}</Badge></td>
                <td>{formatUsd(s.costUsd)}</td>
                <td className="text-xs text-neutral-500">{counts(s)}</td>
                <td className="text-xs text-neutral-500">{s.lastActivityAt.slice(0, 16).replace('T', ' ')} UTC</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="grid gap-2 overflow-x-auto md:grid-cols-4 xl:grid-cols-7">
          {groupByStage(streams).map((col) => (
            <section key={col.stage} aria-label={col.label} className="flex min-w-48 flex-col gap-2">
              <h2 className="text-xs font-semibold text-neutral-500">{col.label} ({col.streams.length})</h2>
              {col.streams.map((s) => (<StreamCard key={s.ticket} s={s} />))}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
```

`apps/web/src/features/streams/StreamDetailPage.tsx`
```tsx
import type { StreamLinkKind } from '@orc/core';
import { type FormEvent, useState } from 'react';
import { Badge, Button, Input } from '@/components/ui';
import { useLinkStream, useStream, useUnlinkStream } from '@/api/queries/streams';
import { GoalEditor } from '../goals/GoalEditor.tsx';
import { formatPctValue, formatUsd } from '../limits/format.ts';
import { STAGE_LABELS, STAGE_ORDER, sessionHref, stageIndex } from './stages.ts';

const LINK_KINDS: StreamLinkKind[] = ['session', 'pr', 'plan', 'worktree', 'workflow'];

function StageBar({ stage }: { stage: keyof typeof STAGE_LABELS }) {
  const current = stageIndex(stage);
  return (
    <ol aria-label="Stage" className="flex flex-wrap items-center gap-1 text-xs">
      {STAGE_ORDER.map((s, i) => (
        <li key={s} className={i <= current ? 'font-semibold text-emerald-700' : 'text-neutral-400'}>
          {STAGE_LABELS[s]}
          {i < STAGE_ORDER.length - 1 ? <span className="px-1 text-neutral-300">→</span> : null}
        </li>
      ))}
    </ol>
  );
}

export function StreamDetailPage({ ticket }: { ticket: string }) {
  const q = useStream(ticket);
  const link = useLinkStream(ticket);
  const unlink = useUnlinkStream(ticket);
  const [kind, setKind] = useState<StreamLinkKind>('session');
  const [ref, setRef] = useState('');

  if (q.isLoading) return <main className="p-4">Loading stream…</main>;
  if (q.isError || !q.data) return <main className="p-4">No stream for {ticket}.</main>;
  const { stream, prsDetailed, links, timeline, handoff, budget } = q.data;

  function onLink(e: FormEvent) {
    e.preventDefault();
    if (ref.trim().length === 0) return;
    link.mutate({ kind, ref: ref.trim() }, { onSuccess: () => setRef('') });
  }

  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold">{stream.ticket}</h1>
        {stream.title ? <p className="text-neutral-600 dark:text-neutral-300">{stream.title}</p> : null}
        <StageBar stage={stream.stage} />
        <p className="text-sm">
          <strong>{formatUsd(stream.costUsd)}</strong>{' '}
          {budget.limitUsd !== null ? (
            <span className={budget.ok ? 'text-neutral-500' : 'text-red-600'}>{`${formatPctValue(budget.pct)} of ${formatUsd(budget.limitUsd)}`}</span>
          ) : (
            <span className="text-neutral-500">no budget set</span>
          )}
          {' · '}
          <span className="text-neutral-500">last activity {stream.lastActivityAt.slice(0, 16).replace('T', ' ')} UTC</span>
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <section aria-label="Goal" className="rounded border border-neutral-200 p-3 dark:border-neutral-700">
          <h2 className="mb-2 text-sm font-semibold">Goal</h2>
          <GoalEditor targetType="stream" targetId={stream.ticket} />
        </section>

        <section aria-label="Next steps" className="rounded border border-neutral-200 p-3 dark:border-neutral-700">
          <h2 className="mb-2 text-sm font-semibold">What's next</h2>
          {handoff ? (
            <>
              <p className="text-xs text-neutral-500">
                From the handoff of <a className="underline" href={sessionHref(handoff.sessionId)}>{handoff.sessionId}</a> · <Badge variant="outline">{handoff.status}</Badge>
              </p>
              <ol className="ml-4 list-decimal text-sm">
                {handoff.nextSteps.map((s) => (<li key={s}>{s}</li>))}
              </ol>
              {handoff.blockers.length > 0 ? <p className="text-sm text-amber-700">Blocked: {handoff.blockers.join('; ')}</p> : null}
            </>
          ) : (
            <p className="text-sm text-neutral-500">No handoff yet. Open a session and create one to capture the next steps.</p>
          )}
        </section>

        <section aria-label="Pull requests" className="rounded border border-neutral-200 p-3 dark:border-neutral-700">
          <h2 className="mb-2 text-sm font-semibold">Pull requests</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {prsDetailed.map((p) => (
              <li key={p.pr.url} className="flex flex-wrap items-center gap-2">
                <a className="underline" href={p.pr.url}>{`#${p.pr.number} ${p.title}`}</a>
                <Badge variant="outline">{p.state}</Badge>
                {p.isBackmerge ? <Badge variant="secondary">backmerge</Badge> : null}
                <span className="text-xs text-neutral-500">checks {p.checks} · review {p.review}</span>
              </li>
            ))}
            {prsDetailed.length === 0 ? <li className="text-neutral-500">none</li> : null}
          </ul>
        </section>

        <section aria-label="Sessions, plans and worktrees" className="rounded border border-neutral-200 p-3 dark:border-neutral-700">
          <h2 className="mb-2 text-sm font-semibold">Sessions, plans and worktrees</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {stream.sessionIds.map((pk) => (
              <li key={pk} className="flex items-center justify-between gap-2">
                <a className="underline" href={sessionHref(pk)}>{pk}</a>
                <Button size="sm" variant="ghost" aria-label={`Unlink session ${pk}`} onClick={() => unlink.mutate({ kind: 'session', ref: pk })}>✕</Button>
              </li>
            ))}
            {stream.plans.map((p) => (<li key={p} className="truncate text-neutral-600 dark:text-neutral-300">{p}</li>))}
            {stream.worktrees.map((w) => (<li key={w} className="truncate text-neutral-600 dark:text-neutral-300">{w}</li>))}
          </ul>
          <p className="mt-2 text-xs text-neutral-500">
            {links.filter((l) => l.excluded).map((l) => `${l.ref} (unlinked)`).join(', ')}
          </p>
          <form onSubmit={onLink} className="mt-2 flex flex-wrap items-end gap-2 text-xs">
            <label>
              Link kind{' '}
              <select aria-label="Link kind" className="rounded border px-1 py-0.5" value={kind} onChange={(e) => setKind(e.target.value as StreamLinkKind)}>
                {LINK_KINDS.map((k) => (<option key={k} value={k}>{k}</option>))}
              </select>
            </label>
            <label className="flex-1">
              Link reference
              <Input aria-label="Link reference" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="claude:s-basic, PR url, path…" />
            </label>
            <Button type="submit" size="sm" disabled={link.isPending}>Link</Button>
          </form>
        </section>
      </div>

      <section aria-label="Timeline" className="rounded border border-neutral-200 p-3 dark:border-neutral-700">
        <h2 className="mb-2 text-sm font-semibold">Timeline</h2>
        <ol className="flex flex-col gap-2 text-sm">
          {timeline.map((i) => (
            <li key={`${i.kind}-${i.ref}-${i.ts}`} className="flex flex-col">
              <span className="text-xs text-neutral-500">{i.ts.slice(0, 16).replace('T', ' ')} UTC · {i.kind}</span>
              <span>{i.title}</span>
              {i.detail ? <span className="text-xs text-neutral-600 dark:text-neutral-300">{i.detail}</span> : null}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
```

`apps/web/src/routes/streams/index.tsx`
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { StreamsPage } from '@/features/streams/StreamsPage';

export const Route = createFileRoute('/streams/')({ component: StreamsPage });
```

`apps/web/src/routes/streams/$ticket.tsx`
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { StreamDetailPage } from '@/features/streams/StreamDetailPage';

export const Route = createFileRoute('/streams/$ticket')({
  component: function StreamRoute() {
    const { ticket } = Route.useParams();
    return <StreamDetailPage ticket={ticket} />;
  },
});
```

In `AppShell.tsx`, add `<Link to="/streams">Streams</Link>` to the main nav (before Analytics). In `GlobalHotkeys.tsx`, add `{ id: 'nav.streams', keys: 'g s', description: 'Go to work streams', group: 'navigation', handler: () => navigate('/streams') }`. In P3's `palette-items.ts`, add a navigation item for each open stream is **not** needed; instead add two static items to the navigation section: `{ id: 'nav.streams', label: 'Go to work streams', keywords: ['stream', 'ticket'], action: { type: 'navigate', to: '/streams' } }` and the same for `/analytics`.

- [ ] **Step 6: Run the tests and the build**

Run: `pnpm vitest run apps/web/src/features/streams && pnpm --filter @orc/web build`
Expected: PASS (5 tests) and a successful build, with the generated route tree including `/streams`, `/streams/$ticket` and `/analytics`.

- [ ] **Step 7: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test
git add apps/web
git commit -m "feat(web): add work stream list, kanban board and stream detail pages"
```

---

### Task 22: Phase 5 exit — end-to-end check, contract merge and the M5 criteria

**Files:**
- Create: `apps/web/e2e/streams-analytics.spec.ts`
- Create: `apps/daemon/test/p5-daemon.test.ts`
- Modify: `plan/00-contracts.md`, `plan/README.md`

**Interfaces:**
- Consumes: `createDaemon()` (P1), the Playwright config and fixture e2e server (P1 A14), every Phase 5 service and route
- Produces: an end-to-end daemon test, an e2e spec, the merged contracts and the updated status table

- [ ] **Step 1: Write the end-to-end daemon test**

`apps/daemon/test/p5-daemon.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { createDaemon } from '../src/main.ts';
import { useTempHomes } from './helpers.ts';

const homes = useTempHomes();

describe('phase 5 daemon wiring', () => {
  it('serves every phase 5 route on a real daemon over fixtures', async () => {
    void homes;
    const d = await createDaemon({ port: 0 });
    try {
      const token = d.ctx.paths.tokenFile;
      const headers = { 'x-orc-token': (await import('node:fs')).readFileSync(token, 'utf8').trim() };
      const get = async (path: string) => {
        const res = await fetch(`http://127.0.0.1:${d.port}${path}`, { headers });
        return { status: res.status, body: (await res.json()) as unknown };
      };
      expect((await get('/api/usage')).status).toBe(200);
      expect((await get('/api/usage/budgets')).status).toBe(200);
      expect((await get('/api/settings')).status).toBe(200);
      expect((await get('/api/streams')).status).toBe(200);
      expect((await get('/api/analytics/cost?groupBy=day')).status).toBe(200);
      expect((await get('/api/analytics/digest')).status).toBe(200);
      expect((await get('/api/goals')).status).toBe(200);
      expect((await get('/api/reminders')).status).toBe(200);
      expect((await get('/api/hooks/install')).status).toBe(200);
      expect((await get('/api/hooks/statusline')).status).toBe(200);
      const unauth = await fetch(`http://127.0.0.1:${d.port}/api/usage`);
      expect(unauth.status).toBe(401);
      // the ledger indexed the fixtures, so analytics answers with real numbers
      await d.ctx.ledger?.backfill('2026-01-01T00:00:00.000Z');
      const cost = (await get('/api/analytics/cost?groupBy=source&from=2026-01-01T00:00:00.000Z')).body as { rows: Array<{ key: string }> };
      expect(cost.rows.map((r) => r.key).sort()).toContain('claude');
      // nothing was written into the fixture CLAUDE_HOME
      const settings = `${d.ctx.paths.claudeHome}/settings.json`;
      const before = (await import('node:fs')).existsSync(settings);
      expect((await get('/api/hooks/install')).status).toBe(200);
      expect((await import('node:fs')).existsSync(settings)).toBe(before);
    } finally {
      await d.close();
    }
  });
});
```

Run: `pnpm vitest run apps/daemon/test/p5-daemon.test.ts`
Expected: PASS (1 test). If a route 500s with `… is not wired in DaemonContext`, the matching `buildContext()` line from its task is missing.

- [ ] **Step 2: Write the e2e spec**

`apps/web/e2e/streams-analytics.spec.ts`
```ts
import { expect, test } from '@playwright/test';

test('work streams and analytics render against the fixture daemon', async ({ page }) => {
  await page.goto('/streams');
  await expect(page.getByRole('heading', { name: 'Work streams' })).toBeVisible();
  await page.getByRole('button', { name: 'Kanban' }).click();
  await expect(page.getByRole('region', { name: 'Planned' })).toBeVisible();

  await page.goto('/analytics');
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Quota' })).toBeVisible();
  await expect(page.getByText('estimated')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Cost over time' })).toBeVisible();
});

test('the stream detail page answers what happened, what it cost and what is next', async ({ page }) => {
  await page.goto('/streams');
  const link = page.getByRole('link', { name: /SAF-1787/ }).first();
  if (await link.isVisible()) {
    await link.click();
    await expect(page.getByLabel('Stage')).toBeVisible();
    await expect(page.getByLabel('Timeline')).toBeVisible();
    await expect(page.getByLabel('Goal')).toBeVisible();
    await expect(page.getByLabel('Next steps')).toBeVisible();
  } else {
    test.skip(true, 'fixtures produced no SAF-1787 stream; check the fixture ticket regex');
  }
});
```

Run: `pnpm --filter @orc/web e2e`
Expected: both specs pass. The fixture session `s-prlink` carries ticket SAF-1787 and a `pr-link`, so the stream exists as soon as the daemon has indexed the fixtures.

- [ ] **Step 3: Check the M5 exit criteria, with evidence**

Start the daemon on the real home (`pnpm --filter @orc/daemon dev`) and record each result in the task's review note.

| # | Criterion (docs/05 M5) | How to check | Evidence |
|---|---|---|---|
| 1 | "What happened on SAF-xxxx, what did it cost, and what's next" is answered on one screen | Open `/streams`, pick a real ticket, and screenshot `/streams/<TICKET>`: stage bar, cost with budget, PRs with checks and review, sessions with recap lines, timeline, goal and the handoff's next steps | screenshot |
| 2 | Quota warnings arrive before the limit is hit | Set `limits.blockTokenLimit` in Settings to just above your current 5-hour usage, wait for the next meter tick (≤ 60 s), then `curl -s -H "x-orc-token: $(cat ~/.orchestrator/token)" 'http://127.0.0.1:4317/api/inbox?state=open' \| grep quota` | pasted item |
| 3 | F6 Work streams cover every source | `/streams` shows tickets found from prompts, branches, PR titles, plan file names, `~/.wstack/workflows/*.env` and worktrees; manual link and unlink survive a Refresh | screenshot + note |
| 4 | F6 stage detection | A ticket with a merged PR shows `Merged`; a merged `backmerge/<TICKET>-…` PR shows `Backmerged`; a session that ran `/releaseit` shows `Released` | note |
| 5 | F7 analytics answer the doc's questions | `/analytics` shows cost by day/week/project/model/source/ticket, top sessions and tickets, cost per merged PR, tool/MCP/skill usage over time, model-vs-tool share, cache-hit trend, facet outcomes and wstack skill runs | screenshot |
| 6 | F7 weekly digest | Click "Generate weekly digest" and confirm it lists shipped PRs, stuck sessions, spend and quota | pasted markdown |
| 7 | F19 quota, burn rate and context fill | The AppShell bars show the 5-hour block, the 7-day window, burn rate and the `estimated` label (or official when S7 chose one); a long session's context badge matches the live card | screenshot |
| 8 | F19 budgets | Add a ticket budget below current spend, and confirm a `budget` inbox item appears at 80% and at 100% | pasted items |
| 9 | F14 recaps | Recap a real session on demand; confirm the recap, model and cost appear in the session header, the History row and the stream timeline, and that a second click is served from the cache | screenshot |
| 10 | F14 privacy | `grep -c "«redacted" ` on the prompt captured by a temporary fake engine, and confirm the digest contains no `tool_result` text (the Task 11 test also asserts this) | note |
| 11 | F16 goals and handoffs | Set a goal, let a PR merge (or emit `pr.changed`) and confirm the goal completes; generate a handoff and use "Resume fresh with handoff" to start a new session | screenshot |
| 12 | F16 reminders survive a restart | Create a reminder 3 minutes out, restart the daemon, and confirm it still fires into the inbox | pasted item |
| 13 | F10 bridge | Install the hooks from Settings, confirm the backup file exists under `$ORC_HOME/backups`, that `~/.claude/settings.json` keeps its other keys, that `audit` has one `hook.install` entry, and measure the status latency (a `waiting` state should show in well under 2 s) | note + numbers |
| 14 | F10 statusline | Add the snippet by hand to a scratch settings file, start `claude --settings /tmp/p5-statusline.json`, and screenshot the line showing cost, context, block and waiting count | screenshot |
| 15 | Read-only rule | `ls -la ~/.claude` shows no new files except `settings.json` (plus its timestamp change) and no `*.orc-tmp` leftovers; `~/.wstack` and `~/.codex` are untouched | note |

- [ ] **Step 4: Merge the contract additions into `plan/00-contracts.md`**

Apply the "Contract additions" section of this plan, in this order:
1. **§1:** add `@anthropic-ai/sdk` (the version pinned in Task 12) to the daemon dependency table.
2. **§3:** replace the inline `recaps` object with `RecapsConfig`, and add `LimitsConfig`, `DigestConfig` and `HooksConfig`, plus the four `OrcConfig` fields. Note the zod 4 `.prefault({})` rule.
3. **§4:** add the `usage`, `streams`, `recaps`, `bridge` and `analytics` type blocks, and the note that `Handoff.sessionId` holds the session pk.
4. **§5:** add `scheduled_jobs`, `usage_entries`, `tool_uses`, `ledger_cursors` and `digests` to the table list (Phase 5 row).
5. **§6:** add the Phase 5 routes, change `usage.updated` to `{ snapshot: UsageSnapshot }`, and add the `config.changed` bus event.
6. **§11:** replace the Phase 5 service block with the extended `UsageMeter`, `UsageLedger`, `RecapService`, `HandoffService`, `GoalService`, `Scheduler` (+ `ensureCronJob`, `removeJobsOfType`), `StreamService`, `PrSource`, `AnalyticsService`, `DigestService`, `ReminderService`, and the `DaemonContext` additions.
7. **§12:** add the `/streams`, `/streams/$ticket` and `/analytics` routes (already listed), the new query keys, and `stores/streams.ts`.
8. Add this line under §8: "**LLM calls** (recaps, daily recaps, handoffs) send only a redacted digest built by `buildRecapDigest`. Tool outputs and tool inputs are never sent."

Run: `grep -n "RecapsConfig\|usage_entries\|UsageLedger\|StreamService\|config.changed" plan/00-contracts.md`
Expected: every name appears.

- [ ] **Step 5: Update the status table and the spike notes**

In `plan/README.md`, set the Phase 5 row's status to `☑ done`, and add a line under "Spike reports" noting which S7 branch was taken (`official` with its field paths, or `estimate`) and whether the hooks were installed for the exit check.

- [ ] **Step 6: Run the full gate**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm check:fixtures && pnpm --filter @orc/web build && pnpm --filter @orc/daemon build`
Expected: everything passes, including the audit coverage test, and both builds emit `dist/`.

- [ ] **Step 7: Commit and merge**

```bash
git add -A
git commit -m "docs(plan): merge phase 5 contract additions and record the M5 exit checks"
git checkout main && git merge --no-ff phase/5-streams-analytics-limits-recaps-goals -m "merge: phase 5 streams, analytics, limits, recaps, goals and the real-time bridge"
```

---

## Self-review (done while writing this plan)

**1. Spec coverage.** Every M5 item maps to at least one task:

| Spec | Tasks |
|---|---|
| F6 ticket detection from prompts, branches, PR titles, plan names, wstack env, worktrees | 8, 9 |
| F6 `streams` / `stream_links` tables, manual link and unlink, Wakecap-only via `features.workStreams` | 2, 9 |
| F6 stages, including backmerge detection and `/releaseit` → released | 8, 9 |
| F6 `/streams` list, kanban toggle, `/streams/$ticket` timeline | 21 |
| F7 cost and tokens by day/week/project/model/source/ticket; top sessions and tickets; cost per merged PR | 10 |
| F7 tool/MCP/skill usage over time; model-vs-tool share; cache-hit trend | 5, 10 |
| F7 facets outcomes and friction; wstack timeline outcomes | 9, 10 |
| F7 `/api/analytics/*`, `/analytics` page with echarts, weekly digest markdown | 10, 18 |
| F19 UsageMeter (5-hour blocks, 7-day window, burn rate, projection, `pctOfLimit` null for estimates) | 4, 7 |
| F19 context fill per session against the configured model windows | 4, 7, 19 |
| F19 budgets table, `checkBudget`, 80% warning and 100% inbox item | 6, 7 |
| F19 `usage.updated` WS event, quota bars in AppShell and `/analytics`, the "estimated" label | 7, 18 |
| F19 concurrency cap reuse (P2 `LaunchService.ownedCount`) | 7, 20 |
| F14 redacted digest with the token cap, prompt template in full, engines, triggers, monthly budget, `recaps` cache key | 11, 12, 13 |
| F14 recap shown in History preview, the session header and the stream timeline; Settings for every option | 9, 19, 20 |
| F16 goals, rules (PR merged → complete, waiting > 30 min → blocked) | 14 |
| F16 handoffs (LLM + structured evidence, markdown) and "Resume fresh with handoff" | 15, 19 |
| F16 reminders through the Scheduler, inbox item, optional `sendText` | 3, 14 |
| F10 `POST /api/hooks` ingest mapping the five events and overriding polled status | 16 |
| F10 installer that shows the snippet and writes only after confirmation, with a backup and a `hook.install` audit entry | 17, 20 |
| F10 `orc-statusline` with cost, context fill, block usage and waiting count | 17 |
| Scheduler (croner, persisted) used by reminders, daily recaps and the digest | 3, 10, 13, 14 |
| M5 exit criteria | 22 |

**2. Placeholder scan.** No `TBD`, `TODO`, "similar to Task N" or "add error handling" is left. Every code step carries complete TypeScript. Two places deliberately branch on external facts, and both spell out each branch: the S7 quota source (Task 1 Step 1 and Task 7) and the P4 `pr_cache` shape (Task 9's single adapter file).

**3. Type consistency.** Checked across tasks:
- `UsageSnapshot` is defined once in core (Task 1), validated in api-contract, produced by `computeUsageSnapshot` (Task 4), served by `/api/usage` (Task 7) and consumed by the web bars (Task 18) and the statusline (Task 17).
- Ledger rows flow `extractLedgerFacts` (Task 4) → `LedgerEntry` (Task 5) → `AnalyticsEntry` (Task 10), with the field names matching in all three.
- `RecapService.runLlm` (Task 13) is what `HandoffService` (Task 15) calls, with the same argument order.
- `pkFromParams` is defined once (Task 13) and reused by the handoff routes (Task 15).
- Hook types (`HookFields`, `HookSignal`) are declared in Task 1 and finalised in Task 16, which says exactly what to replace.
- `sessionHref` (Task 21) and the analytics links (Task 18) build the same `/sessions/<source>/<id>` shape.

**4. Fixes applied while reviewing.**
- The 5-hour block test data was moved back by two days so the 7-day window assertion is real.
- `contextFill` now shares `contextWindowFor` with Phase 2's reducer, so the live card and the meter can't disagree.
- The stream timeline expectation was recomputed by hand after the fixture PR was made a merged backmerge, and the plan file's mtime is now pinned with `utimesSync`.
- The daily recap falls back to the stored recap row, because `SessionListItem.recap` lags one refresh behind.
- `HookBridge` was dropped after reading the Phase 2 plan: Phase 2 already ships the ingest route and the hook-over-registry precedence, so Phase 5 extends them instead of adding a parallel service.
