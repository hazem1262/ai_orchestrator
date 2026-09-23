# Phase 3 — Session Detail, Safety & Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Symbol ownership:** before creating any exported symbol, check `00-contracts.md` §13. Where two phases touch the same symbol, the owning phase creates the file and later phases modify it instead of redefining.

**Goal:** Deliver milestone M3. This covers the full Session Detail (F2), safety badges, redaction and the shared deny-list (F9), the append-only audit log that every write path goes through (F24), and the ⌘K command palette with global shortcuts (F8). At the end, a `/conductor` session can be understood without opening a terminal, and every action the app takes shows up in `/audit`.

**Architecture:** All derivations are pure functions in `@orc/core/src/derive/*`: step timing, deliverables, prod detection, the permission badge, the deny-list and the secret scan. The daemon wraps them in small services (`session-detail`, `links`, `export`, `audit`, `safety`) and exposes them through new Hono routes. These routes redact everything in the route layer. Auditing is added in two places, so no Phase 1/2 handler needs rewriting:
- (a) an HTTP middleware that audits a declared table of write routes, with a test that fails when a new write route is neither audited nor explicitly exempt
- (b) a `PtyManager` decorator that audits input sent to sessions

The web app adds a tabbed Session Detail (Timeline, Agents, Usage, Files, Links, Raw), an `/audit` page, a secrets-hygiene panel, and a shared hotkey registry used by the cmdk palette.

**Tech Stack:** TypeScript ~6.0.3, Hono 4, Drizzle + better-sqlite3, zod 4, React 19, TanStack Query/Router, @xyflow/react 12, echarts 6, cmdk 1, **fflate 0.8.3** (new), @testing-library/user-event 14.6.7 (new, dev), Vitest 5, Playwright 1.63.

**Spec:** `docs/02-features.md` (F2, F8, F9, F24), `docs/03-architecture-and-stack.md` (Security & privacy), `docs/04-data-sources.md` (A2 derivations, A4, D), `docs/05-roadmap.md` (M3), `docs/06-landscape-and-inspiration.md` (DeepSeek Harness, Omnara), `plan/00-contracts.md` (§4, §5, §6, §8, §11, §12)

## Starting state (what Phase 3 builds on)

**Branch:** cut `phase/3-session-detail-safety-audit` from `main`. Phases 0, 1 and 2 are done and
merged; Phase 2 merged as `e817f1b`.

**Read first:** [`00-contracts.md`](00-contracts.md) — Phase 2's contract additions are already
merged into §3, §4, §5, §6, §11 and §12 — this file, and the spike reports in [`spikes/`](spikes/).

**Baseline on `main`** (measured 2026-09-23 at `036e5c0`):

| Check | Command | Result |
|---|---|---|
| Lint | `pnpm run lint` | clean — `Checked 326 files`, 1 info (biome asks for `biome migrate` on its own config) |
| Typecheck | `pnpm run typecheck` | clean, 4 of 5 workspace projects |
| Unit tests | `pnpm run test` | `Test Files 87 passed (87)`, `Tests 1116 passed (1116)` |
| Fixtures | `pnpm run check:fixtures` | clean |
| E2E | `pnpm --filter @orc/web e2e` | 7 passed across `apps/web/e2e/history.spec.ts` and `apps/web/e2e/live-inbox.spec.ts` |

Test count over time: 289 at the Phase 1 exit → 1116 at the Phase 2 exit.

**Call sites waiting on this phase:** Phase 3 wraps every write path with `audit.record()`. The
Phase 2 routes waiting for it are launch, kill and archive-restore, in
`apps/daemon/src/http/routes/`.

**Deferred, not defects** — each is a known gap Phase 3 inherits rather than causes:
- `repos[].setup/run/archive` are served unredacted on `GET /api/projects/:id`. This is a declared
  round-trip exemption; revisit when Phase 4 starts executing those commands.
- Pair-form redaction gaps are listed in `apps/daemon/src/http/redact-out.ts`: `{name,val}`,
  `{k,v}`, `{header,value}`, OpenAPI `schema.default`, tuple pairs, sibling-object splits.
- `apps/daemon/src/services/sessions.test.ts:237` fails under parallel load and passes when run
  alone — a timing race in the test, not a product regression. It passed in the full run above.
- The Phase 4, 5 and 7 plan files carry roughly 31 stale `inbox.upsert({ dedupeKey })` call sites.
  Each of those files carries a `SUPERSEDED CALL SHAPE` banner at the top rather than a rewrite:
  `plan/phase-4-worktrees-review-merge.md:30`, `plan/phase-5-streams-analytics-limits-recaps-goals.md:102`,
  `plan/phase-7-automations-compare-supervisor.md:32`.
- `usage.updated` still needs a key-aware over-redaction check when that event is first produced
  (Phase 5).

**Phase 2 exit criteria still unconfirmed by eye** — recorded in
[`phase-2-evidence.md`](phase-2-evidence.md), carried forward rather than blocking:
- Criterion 5: a macOS notification banner has never been confirmed by a human. A probe was fired
  on 2026-09-23 at 10:06:30 +03 with the title `Orchestrator · Waiting for you`.
- Criterion 4: the card agents badge was never seen with a live subagent running.
- Criterion 6: no template launch with a real prompt was run, because it spends model tokens on the
  user's account. `apps/daemon/test/launch-integration.test.ts` covers the rendered-prompt path.

**Checkbox state in [`phase-2-live-board-inbox-archive.md`](phase-2-live-board-inbox-archive.md) is
not a progress signal.** 126 step checkboxes there were never ticked even though all 20 tasks
shipped. The shipped state is the commit history and [`phase-2-evidence.md`](phase-2-evidence.md).

## Global Constraints
- Node `>=22.12 <23`, pnpm `10.18.3`, TypeScript `~6.0.3` strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Vitest `^5.0.1`, Biome `^2.5.14`.
- `@orc/core` stays pure: no `node:fs`/`node:net`/`node:child_process` imports outside `src/io/*`. Every new core module is exported from **both** `src/index.ts` and `src/browser.ts`. The web app imports core **values** from `@orc/core/browser`, and types from `@orc/core`.
- Reuse the Phase 1 helpers rather than re-creating them: `DEFAULT_PROD_PATTERNS`, `DEFAULT_TICKET_REGEX`, `compileTicketRegex`, `mcpToolLabel` (core); `ServiceError`, `parseWith`, `redact-out.ts` (daemon).
- **Read-only toward `~/.claude`, `~/.codex` and the scanned secret files** (`~/Wakecap/.mcp.json`, `~/Wakecap/.claude/commands/*.md`). This phase opens files only with `readFile`/`open(path, 'r')`/`readdir`/`stat`. Never read `*.key`, `~/.codex/auth.json` or `~/.claude.json`.
- **Secrets panel reports file + kind + line number only, never values.** Tests check that the serialized report does not contain the secret.
- **Redaction:** every response that carries transcript text (events, session, list snippets, raw, files, links, plans, export, audit params, WS `session.updated`) passes through `redact`/`redactDeep`/`redactSnippet` in the route layer. The DB keeps the raw text.
- **Audit:** from this phase on, every write path produces an `AuditEntry` (`<area>.<verb>` action names, contracts §4). The `audit_log` table is append-only and enforced by SQLite triggers.
- Destructive or sensitive endpoints need `confirm: true` (a body field, or a query parameter for GET export). Without it they return `409 confirmation_required` with `details.summary`.
- The daemon binds to `127.0.0.1` and every request needs `x-orc-token`. UI code imports kit components only from `@/components/ui/*`.
- Test code never contains a literal token-shaped secret. Build it at runtime (`'gh' + 'p_' + 'a'.repeat(36)`) so push protection and `pnpm check:fixtures` stay quiet.
- Conventional Commits with a scope. `pnpm lint && pnpm typecheck && pnpm test` must be green before every commit. Branch: `phase/3-session-detail-safety-audit`.
- New dependencies are pinned to versions checked with `npm view` on 2026-09-17: `fflate@^0.8.3` (daemon and api-contract tests), `@testing-library/user-event@^14.6.7` (web, dev).
  - **Why fflate:** it has no dependencies, is pure JS (no native build), ships its own TypeScript types, provides the sync `zipSync`/`unzipSync` we need for export and for tests, and is about 8 kB. `jszip@3.10.2` is heavier and promise-only. `archiver@8.0.0` is stream-based and pulls in about 10 transitive packages.
  - **Agents-tree layout:** a small tiered layout of our own (depth → x, DFS leaf order → y). Trees are at most 3 levels deep with tens of nodes, so `@dagrejs/dagre@3.1.1` is not needed.

## Phase 1/2 interfaces this plan builds on (checked against `plan/phase-1-*.md` and `plan/phase-2-*.md`)

These names come from the Phase 1/2 plans. If the shipped code differs, change **only** the call site in this plan's code, and write the difference in the task's review note.

| # | Interface (owner) | Used by tasks |
|---|---|---|
| A1 | **HTTP (P1):** `apps/daemon/src/http/app.ts` → `createApp(o: AppOptions): OrcApp` with `AppOptions { ctx; token; port: () => number; webDist?; env? }`. It registers the token/host/origin middleware on `/api/*`, calls `register<Area>Routes(app: OrcApp, ctx)` (routes use absolute `/api/...` paths), then a catch-all `app.all('/api/*')` 404, then static files. `app.onError` maps `ServiceError` (`services/errors.ts`) and `ZodError` to the error shape. `OrcApp = Hono<{ Bindings: HttpBindings }>` (`http/types.ts`). `http/json.ts` → `parseWith`, `readJson`. `http/redact-out.ts` → `redactValue`, `redactEvent`, `redactSession`, `redactSnippet` (marker-aware), `redactListItem` | 7–12 |
| A2 | **Context (P1, extended by P2):** `apps/daemon/src/context.ts` → `buildContext(o: BuildContextOptions): { ctx; raw; saveConfig; close }`. It creates every service, and **both** `createDaemon()` and `createTestContext()` call it, so Phase 3 services are wired in `buildContext` only. P1's `PtyManager` adds `remove(id)` and `disposeAll()` | 6–8 |
| A3 | **Daemon tests (P1):** `apps/daemon/test/helpers.ts` → `createTestContext(opts?): TestContext` (sync; `TestContext extends DaemonContext { homes; raw; launches; dispose() }`, fake `claude` via `FAKE_CLAUDE`, and `isPidAlive` defaults to always false) and `indexFixtures(ctx): Promise<Indexer>`. P1 route tests call `createApp({ ctx, token, port: () => 4317, env: {} })` and `app.request('http://127.0.0.1:4317/api/...', { headers: { 'x-orc-token': TOKEN } })`. Phase 3 wraps this in `apps/daemon/test/p3-harness.ts` (Task 6) | 6–12 |
| A4 | **Events (P1):** `SessionService.events(source, id, { agentId: null })` returns main-session events, and `nextSeq` is passed back as `afterSeq`. `turn` starts at 1 on the first human prompt (0 before it). Usage is attached to the first event per `message.id`. `tool_result` events carry `toolUseId`. `usage.costUsd` on events is `null` (cost comes from `cost-state` at session level) | 3, 4, 9 |
| A5 | **Core (P1):** `DEFAULT_PROD_PATTERNS: string[]` (includes the prod skill names) in `derive/prod.ts`; `DEFAULT_TICKET_REGEX`, `compileTicketRegex(source): RegExp \| null`; `mcpToolLabel(tool)`. The web app imports **values** only from `@orc/core/browser`, and every new core module is exported from both `src/index.ts` and `src/browser.ts` | 1–4, 10, 14 |
| A6 | Codex `custom_tool_call` patch events have `tool === 'apply_patch'` and a string `input` (or `{ input: string }`) (P1 codex aggregate) | 4 |
| A7 | **Write routes:** P1 `POST /api/sessions/:source/:id/resume` (body `{ mode, fork? }` → `{ ptyId } \| { launched: 'external' }`), `DELETE /api/pty/:ptyId` (body `{ confirm }`), pin/label/views. P2 `POST /api/sessions/launch`, `POST /api/sessions/:source/:id/kill` (`409 confirmation_required`, `404 not_live`), `POST /api/archive/restore` (`409 confirmation_required\|restore_target_exists`, `404 not_archived`), `POST /api/archive/sync`, inbox actions, notification prefs, hooks | 7 |
| A8 | **Live (P1/P2):** `LiveEvent` lives in `packages/api-contract/src/live.ts`. The daemon hub is `apps/daemon/src/http/live-ws.ts` → `createLiveWsHub(ctx)`. It forwards the bus types listed in `LIVE_EVENT_TYPES` through a local `toWire()` (which already applies `redactSession`). Web: `apps/web/src/api/live-events.ts` → `useLiveEvents()` and `applyLiveEvent(qc, e)` | 5, 6, 11, 13 |
| A9 | **Web client (P1):** `apps/web/src/api/client.ts` → `getApiClient()` and `setApiClientForTests(c)`. `@orc/api-contract` → `createApiClient({ baseUrl, token })` and `type ApiClient = ReturnType<typeof createApiClient>`. Methods include `sessionsList(filters)`, `sessionsAgents(source, id)` and `sessionsResume(source, id, body)` | 5, 13, 18 |
| A10 | **Web queries (P1/P2):** `api/queries/sessions.ts` → `useSessions(filters)`, `useSession(source, id)` and `useSessionEvents(source, id, agentId: string \| null)` (an infinite query; pages `{ items: TimelineEvent[]; nextSeq }`). `api/queries/projects.ts` → `useProjects()`. P2 `api/queries/templates.ts` → `useTemplates(projectId?)`. Phase 3 adds `useSessionAgents` (Task 13) | 13–18 |
| A11 | **Session detail (P1):** `features/session-detail/SessionDetailPage.tsx` (`{ source, id }`) renders `SessionHeader` (with an `actions` slot) and `Timeline`. P1's `timeline-model.ts` has `groupTimeline`/`toolLabel`/`inputPreview`. The route file is `apps/web/src/routes/sessions/$source/$id.tsx`. The router uses `tsr.config.json` + the generated `routeTree.gen.ts` | 14, 16 |
| A12 | **Shell (P1):** `features/shell/AppShell.tsx` has `<nav aria-label="Main">` with `<Link>` items, plus `GlobalSearch` in the header. `features/settings/SettingsPage.tsx` renders `<section>` blocks | 17, 18 |
| A13 | **P2 web:** `stores/launch.ts` → `useLaunchStore` `{ open; preset; show(preset?: Partial<LaunchRequestInput>); hide() }`. `features/inbox/useInboxKeys.ts` currently attaches its own `window` keydown listener (j/k/e/s/Enter). The `/live` route accepts search `{ status?: LiveStatus }` | 18 |
| A14 | **E2E (P1):** `apps/web/playwright.config.ts` starts `apps/daemon/test/e2e-server.ts` on fixture homes, with the fake CLIs and `baseURL` set. The page receives its token from `/bootstrap.js` as `window.__ORC_TOKEN__` | 19 |

## Contract additions

These are merged into `plan/00-contracts.md` in Task 19.

```ts
// §4 additions — @orc/core/src/derive/*  (pure)
export interface TurnStats { turn: number; agentId: string | null; startedAt: string; endedAt: string; wallMs: number; modelMs: number; toolMs: number; reportedMs: number | null; ttftMs: number | null; toolCalls: number; toolErrors: number; apiErrors: number; usage: Usage; tokensPerSec: number | null; cacheHitRate: number | null }
export interface SessionStats { turns: number; wallMs: number; modelMs: number; toolMs: number; ttftMs: number | null; toolCalls: number; toolErrors: number; apiErrors: number; usage: Usage; tokensPerSec: number | null; cacheHitRate: number | null }
export function computeTurnStats(events: readonly TimelineEvent[]): TurnStats[]
export function computeSessionStats(turns: readonly TurnStats[]): SessionStats
export function cacheHitRate(u: Pick<Usage, 'input' | 'cacheRead' | 'cacheWrite'>): number | null   // cacheRead / (input + cacheRead + cacheWrite)

export type DeliverableStatus = 'applied' | 'failed' | 'pending';
export interface FileChange { path: string; tool: string; toolUseId: string | null; turn: number; seq: number; ts: string; agentId: string | null; status: DeliverableStatus; oldText: string | null; newText: string | null }
export interface DeliverableFile { path: string; tools: string[]; ops: number; status: DeliverableStatus; lastTs: string }
export interface TurnDeliverables { turn: number; agentId: string | null; files: DeliverableFile[] }
export interface FileSummary { path: string; ops: number; failedOps: number; turns: number[]; agentIds: Array<string | null>; firstTs: string; lastTs: string; changes: FileChange[] }
export const FILE_EDIT_TOOLS: readonly ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']
export function extractFileChanges(events: readonly TimelineEvent[]): FileChange[]
export function deliverablesByTurn(events: readonly TimelineEvent[]): TurnDeliverables[]
export function summarizeFiles(changes: readonly FileChange[]): FileSummary[]

export const DEFAULT_PROD_SKILLS: readonly string[]      // production_server_db, production_server_logs, wecare_production_db
// (command patterns reuse the Phase 1 DEFAULT_PROD_PATTERNS from derive/prod.ts)
export interface ProdTouch { seq: number; ts: string; agentId: string | null; kind: 'skill' | 'command'; tool: string; detail: string }  // detail is redacted
export function detectProdTouches(events: readonly TimelineEvent[], opts?: { prodSkills?: readonly string[]; prodPatterns?: readonly string[] }): ProdTouch[]
export type PermissionBadge = 'bypass' | 'plan' | 'auto' | 'default' | 'custom' | 'unknown';
export function permissionBadge(modes: readonly (string | null | undefined)[]): PermissionBadge
export function compilePattern(pattern: string): RegExp  // case-insensitive; invalid regex → escaped literal
export interface SecretFinding { line: number; kind: string }
export function scanTextForSecrets(text: string): SecretFinding[]
// deny-list (contracts §11 names, unchanged): DenyVerdict, checkDenied, DEFAULT_DENY_PATTERNS

// §8 additions — @orc/core/src/redact/redact.ts
export function redactDeep<T>(value: T): T        // redacts every string; values under sensitive keys (…password|passwd|secret|api_key|authorization|token) become «redacted:secret»
export function redactPartialTokens(text: string): string // masks token prefixes cut off by FTS snippets as «redacted:partial»; used by the daemon's redactSnippet (redact-out.ts)

// §3 additions — OrcConfig
safety: z.object({
  extraDenyPatterns: z.array(z.string()).default([]),
  prodSkills: z.array(z.string()).default(['production_server_db', 'production_server_logs', 'wecare_production_db']),
  secretScanPaths: z.array(z.string()).default(['~/Wakecap/.mcp.json', '~/Wakecap/.claude/commands/*.md']),
}).default({}),
links: z.object({
  linearWorkspace: z.string().nullable().default(null),
  planRoots: z.array(z.string()).default(['~/Wakecap/plans']),
}).default({}),

// §4 audit additions
// new action names: 'session.export', 'session.open', 'archive.sync'
// §11 audit additions — apps/daemon/src/services/audit/audit.ts
export interface AuditListFilter { sessionPk?: string; action?: string /* exact, or 'area.*' */; actor?: AuditActor; from?: string; to?: string; limit?: number; q?: string; projectId?: string }
// AuditService.list(filter: AuditListFilter) — a superset of the §11 inline filter
export class DeniedError extends Error { readonly verdict: DenyVerdict }   // audited() records result 'denied' when fn throws it
export function createAuditService(opts: { db: OrcDb; bus?: EventBus; now?: () => Date }): AuditService
// apps/daemon/src/http/audit-middleware.ts
export interface AuditedRoute { method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT'; pattern: RegExp; action: string | ((body: Record<string, unknown>) => string); target: (m: RegExpExecArray, body: Record<string, unknown>) => string | null; before?: (m: RegExpExecArray, ctx: DaemonContext) => Record<string, unknown> }
export const AUDITED_ROUTES: AuditedRoute[]
export const NON_ACTION_ROUTES: Array<{ method: string; path: string; why: string }>
export function auditMiddleware(ctx: DaemonContext): MiddlewareHandler   // mounted in createApp right after the token middleware
// route registration (P1 pattern): registerAuditRoutes, registerSafetyRoutes, registerSessionDetailRoutes, registerLinksRoutes, registerExportRoutes — each (app: OrcApp, ctx: DaemonContext, …)
// apps/daemon/src/pty/audited-pty.ts
export function withPtyInputAudit(pty: PtyManager, audit: AuditService, opts?: { idleMs?: number; actor?: AuditActor }): PtyManager & { flushAll(): void }   // wired in buildContext
// apps/daemon/src/services/safety/deny-list.ts (the §11 DenyList interface lives here)
export function createDenyList(deps: { config: () => OrcConfig; projects: Pick<ProjectService, 'get'> }): DenyList

// §6 WS addition (api-contract/src/live.ts; also added to the daemon's LIVE_EVENT_TYPES)
| { type: 'audit.recorded'; entry: AuditEntry }

// §6 route additions (P3)
GET  /api/sessions/:source/:id/stats                → SessionStatsResponse { session: SessionStats; turns: TurnStats[]; agents: { agentId: string; stats: SessionStats }[] }
GET  /api/sessions/:source/:id/deliverables         → TurnDeliverables[]
GET  /api/sessions/:source/:id/files                → FileSummary[]
GET  /api/sessions/:source/:id/usage-series         → UsagePoint[] { ts; agentId; model; input; output; cacheRead; cacheWrite; costUsd }
GET  /api/sessions/:source/:id/safety               → SessionSafety { permissionMode; permissionBadge; touchedProd; prodTouches: ProdTouch[] }
GET  /api/sessions/:source/:id/links                → SessionLinks { prs; tickets: {id,url}[]; plans: PlanRef[]; artifacts: {title,url,path}[]; bridgeSessionId }
GET  /api/sessions/:source/:id/raw?agentId&offset&limit → RawPage { path; items: { offset; text; truncated; partial }[]; nextOffset: number | null }
GET  /api/sessions/:source/:id/export?redact=false&confirm=true → application/zip   (audited as session.export)
GET  /api/plans?q&limit                             → PlanRef[] { path; title; source: 'claude-plans'|'wakecap-plans'|'repo-docs'; mtime; reason: 'ticket'|'time'|'query'; tickets }
GET  /api/plans/content?path                        → { path; text }  (403 forbidden outside plan roots)
GET  /api/audit?sessionPk&action&actor&from&to&q&projectId&limit → AuditEntry[]
GET  /api/safety/secrets                            → SecretsReport { scannedAt; totalFindings; files: { path; displayPath; exists; findings: SecretFinding[]; error }[] }
POST /api/safety/deny-check   body { text; projectId }  → DenyVerdict
// client methods (api-contract/src/client-p3.ts): sessionsStats, sessionsDeliverables, sessionsFiles, sessionsUsageSeries,
// sessionsSafety, sessionsLinks, sessionsRaw, sessionsExport, plansList, plansContent, auditList, safetySecrets, safetyDenyCheck

// §12 additions (web)
// stores/view-mode.ts → useViewModeStore { mode: 'summary' | 'normal' | 'verbose'; setMode(m) } (persisted)
// stores/palette.ts   → usePaletteStore { open: boolean; setOpen(v: boolean); toggle() }
// api/queries/session-detail.ts → useSessionAgents(source, id) (key ['session', source, id, 'agents']) and the detail hooks below
// features/hotkeys/registry.ts → hotkeys (singleton HotkeyRegistry), useHotkeys(bindings: HotkeyBinding[], deps: unknown[]), <HotkeysListener/>
export interface HotkeyBinding { id: string; keys: string /* 'g i' | 'mod+k' | 'j' */; description: string; group: 'navigation' | 'actions' | 'inbox' | 'session'; handler: () => void; allowInInputs?: boolean }
// query keys: ['session', source, id, 'stats'|'deliverables'|'files'|'usage'|'safety'|'links'|'raw', …], ['audit', filter], ['plans', q], ['plan', path], ['safety', 'secrets']
// routes: /sessions/$source/$id?tab=timeline|agents|usage|files|links|raw&agent=<agentId>&file=<path>
// global shortcuts: mod+k palette, g i inbox, g w waiting, g h history, g a audit, n new session; inbox j/k/e/s are owned by Phase 2 and registered through useHotkeys
```

---

## File Structure (this phase)
```
packages/core/src/derive/{patterns.ts,deny-list.ts,prod-detect.ts,permission.ts,secret-scan.ts,step-stats.ts,deliverables.ts}  + *.test.ts
packages/core/src/redact/redact.ts                      (modify: redactDeep, redactPartialTokens)   + redact-deep.test.ts
packages/core/src/index.ts, packages/core/src/browser.ts (modify)
packages/api-contract/src/routes/{session-detail.ts,links.ts,audit.ts,safety.ts}
packages/api-contract/src/client-p3.ts + client-p3.test.ts
packages/api-contract/src/{client.ts,config.ts,index.ts,live.ts}   (modify)
apps/daemon/src/db/schema.ts                            (modify: audit_log)
apps/daemon/src/db/migrations/*                         (generated + custom trigger migration)
apps/daemon/src/db/repos/audit.ts
apps/daemon/src/services/audit/{audit.ts,redact-params.ts}         + test/audit.service.test.ts
apps/daemon/test/p3-harness.ts
apps/daemon/src/http/audit-middleware.ts                + test/audit.routes.test.ts, test/audit.coverage.test.ts
apps/daemon/src/pty/audited-pty.ts                      + audited-pty.test.ts
apps/daemon/src/services/safety/{deny-list.ts,secrets-scan.ts}     + tests
apps/daemon/src/services/session-detail/{collect.ts,detail.ts,raw.ts}  + tests
apps/daemon/src/services/links/{plans.ts,links.ts}      + tests
apps/daemon/src/services/export/export-zip.ts           + test
apps/daemon/src/http/redacted-json.ts
apps/daemon/src/http/routes/{audit.ts,safety.ts,session-detail.ts,links.ts,export.ts}
apps/daemon/src/http/{app.ts,live-ws.ts,redact-out.ts}, apps/daemon/src/context.ts   (modify)
apps/daemon/test/redaction.routes.test.ts
apps/web/src/api/queries/{session-detail.ts,audit.ts,safety.ts} + tests
apps/web/src/api/live-events.ts                         (modify)
apps/web/src/stores/{view-mode.ts,palette.ts}
apps/web/src/test/p3-render.tsx
apps/web/src/features/session-detail/timeline/{group-events.ts,format.ts,StepInspector.tsx,TurnStatsBar.tsx,DeliverablesRow.tsx,TrajectoryTimeline.tsx,ViewModeToggle.tsx} + tests
apps/web/src/features/session-detail/agents/{layout.ts,conductor.ts,AgentCard.tsx,AgentsTree.tsx,ConductorChain.tsx} + tests
apps/web/src/features/session-detail/tabs/{SessionDetailTabs.tsx,UsageTab.tsx,usage-option.ts,FilesTab.tsx,LinksTab.tsx,RawTab.tsx} + tests
apps/web/src/features/session-detail/{SafetyBadges.tsx,ExportButton.tsx}
apps/web/src/features/session-detail/SessionDetailPage.tsx, apps/web/src/routes/sessions/$source/$id.tsx   (modify)
apps/web/src/features/audit/{AuditPage.tsx,AuditPage.test.tsx}, apps/web/src/routes/audit.tsx
apps/web/src/features/safety/{SecretsHygienePanel.tsx,SecretsHygienePanel.test.tsx}
apps/web/src/features/hotkeys/{registry.ts,registry.test.ts,HotkeysListener.tsx,GlobalHotkeys.tsx}
apps/web/src/features/palette/{palette-items.ts,palette-items.test.ts,CommandPalette.tsx,CommandPalette.test.tsx}
apps/web/src/features/shell/AppShell.tsx, apps/web/src/features/settings/SettingsPage.tsx, apps/web/src/features/inbox/useInboxKeys.ts  (modify)
apps/web/e2e/session-detail-conductor.spec.ts
plan/00-contracts.md, plan/README.md                    (modify, Task 19)
```

---

### Task 1: Core redaction helpers, pattern compiler and shared deny-list

**Files:**
- Create: `packages/core/src/derive/patterns.ts`, `packages/core/src/derive/deny-list.ts`, `packages/core/src/derive/deny-list.test.ts`, `packages/core/src/redact/redact-deep.test.ts`
- Modify: `packages/core/src/redact/redact.ts` (append), `packages/core/src/index.ts`, `packages/core/src/browser.ts`

**Interfaces:**
- Consumes: `redact`, `REDACTION_PATTERNS` (Phase 0)
- Produces (exported from `packages/core/src/index.ts` **and** `packages/core/src/browser.ts`):
  ```ts
  export function compilePattern(pattern: string): RegExp
  export function firstMatch(text: string, patterns: readonly string[]): { pattern: string; match: string } | null
  export interface DenyVerdict { denied: boolean; reason: string | null }
  export const DEFAULT_DENY_PATTERNS: string[]
  export function checkDenied(text: string, patterns: string[]): DenyVerdict
  export function redactDeep<T>(value: T): T
  export function redactPartialTokens(text: string): string
  ```

- [ ] **Step 1: Create the branch**

```bash
cd /Users/hazem/orchestrator
git checkout main && git pull --ff-only || true
git checkout -b phase/3-session-detail-safety-audit
```

- [ ] **Step 2: Write the failing tests**

`packages/core/src/derive/deny-list.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_DENY_PATTERNS, checkDenied } from './deny-list.ts';
import { compilePattern, firstMatch } from './patterns.ts';

describe('checkDenied with DEFAULT_DENY_PATTERNS', () => {
  it.each([
    'rm -rf /tmp/build',
    'rm -Rf ./dist',
    'rm -r -f node_modules',
    'rm -fr x',
    'git push --force origin main',
    'git push -f',
    'git push --force-with-lease',
    'git reset --hard HEAD~1',
    'git clean -fdx',
    'terraform apply -auto-approve',
    'terraform destroy',
    'kubectl --context=wakecap-prod get pods',
    'kubectl config use-context eks-prod',
    'psql -c "DROP TABLE users"',
    'truncate table events',
    'gh pr merge 231 --squash',
    'helm upgrade api ./chart',
    'please deploy the service',
    'use the production_server_db skill',
  ])('denies %s', (text) => {
    const v = checkDenied(text, DEFAULT_DENY_PATTERNS);
    expect(v.denied).toBe(true);
    expect(v.reason).toMatch(/^matches deny pattern /);
  });

  it.each([
    'git status',
    'git push origin feat/SAF-1787-x-fix',
    'rm -f stale.lock',
    'rm -r build',
    'kubectl --context stage get pods',
    'pnpm vitest run',
    'the deployment doc',
    'firm -rf',
  ])('allows %s', (text) => {
    expect(checkDenied(text, DEFAULT_DENY_PATTERNS)).toEqual({ denied: false, reason: null });
  });

  it('merges extra project patterns', () => {
    expect(checkDenied('run make release', [...DEFAULT_DENY_PATTERNS, 'make\\s+release']).denied).toBe(true);
  });

  it('redacts the matched text inside the reason', () => {
    const v = checkDenied('deploy with password=hunter2', ['password=\\S+']);
    expect(v.reason).not.toContain('hunter2');
    expect(v.reason).toContain('«redacted:secret»');
  });
});

describe('compilePattern', () => {
  it('is case-insensitive and caches', () => {
    expect(compilePattern('abc').test('xABCx')).toBe(true);
    expect(compilePattern('abc')).toBe(compilePattern('abc'));
  });

  it('treats an invalid regex as a literal', () => {
    expect(compilePattern('foo(').test('call foo( now')).toBe(true);
    expect(firstMatch('call foo( now', ['nope', 'foo('])).toEqual({ pattern: 'foo(', match: 'foo(' });
  });
});
```

`packages/core/src/redact/redact-deep.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { redact, redactDeep, redactPartialTokens } from './redact.ts';

const ghp = `gh${'p_'}${'a'.repeat(36)}`;

describe('redactDeep', () => {
  it('redacts nested strings and sensitive keys, keeps other values', () => {
    const input = {
      command: `PGPASSWORD=hunter2 psql`,
      env: { PGPASSWORD: 'hunter2', client_secret: 'abc', access_token: 'zzz', tokens: 5, maxTokens: 10 },
      list: [`token ${ghp}`, 3, null, true],
      nested: { deeper: { text: 'plain' } },
    };
    const out = redactDeep(input);
    expect(out.command).toBe('PGPASSWORD=«redacted:secret» psql');
    expect(out.env).toEqual({
      PGPASSWORD: '«redacted:secret»',
      client_secret: '«redacted:secret»',
      access_token: '«redacted:secret»',
      tokens: 5,
      maxTokens: 10,
    });
    expect(out.list).toEqual(['token «redacted:github»', 3, null, true]);
    expect(out.nested.deeper.text).toBe('plain');
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(input.env.PGPASSWORD).toBe('hunter2'); // input not mutated
  });
});

describe('redactPartialTokens', () => {
  it('masks token prefixes cut off by an FTS snippet', () => {
    expect(redactPartialTokens('…export GH=ghp_abc12')).toBe('…export GH=«redacted:partial»');
    expect(redactPartialTokens('key AKIAABCD…')).toBe('key «redacted:partial»…');
    expect(redactPartialTokens('slack xoxb-12')).toBe('slack «redacted:partial»');
  });

  it('composes with full redaction and leaves plain text alone', () => {
    expect(redactPartialTokens(redact(`x ${ghp}`))).toBe('x «redacted:github»');
    expect(redactPartialTokens('ran pnpm test')).toBe('ran pnpm test');
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `pnpm vitest run packages/core/src/derive/deny-list.test.ts packages/core/src/redact/redact-deep.test.ts`
Expected: FAIL. `Cannot find module './deny-list.ts'`, and `redactDeep` / `redactPartialTokens` are missing exports.

- [ ] **Step 4: Implement**

`packages/core/src/derive/patterns.ts`
```ts
const cache = new Map<string, RegExp>();

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compiles a user/config pattern as a case-insensitive regex. Invalid regex source is matched literally. */
export function compilePattern(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    re = new RegExp(escapeRegex(pattern), 'i');
  }
  cache.set(pattern, re);
  return re;
}

export function firstMatch(text: string, patterns: readonly string[]): { pattern: string; match: string } | null {
  for (const pattern of patterns) {
    const m = compilePattern(pattern).exec(text);
    if (m) return { pattern, match: m[0] };
  }
  return null;
}
```

`packages/core/src/derive/deny-list.ts`
```ts
import { redact } from '../redact/redact.ts';
import { firstMatch } from './patterns.ts';

export interface DenyVerdict {
  denied: boolean;
  reason: string | null;
}

/** Shared prod/destructive deny-list (F9). Used by automations (P7), the supervisor (P7) and /api/safety/deny-check. */
export const DEFAULT_DENY_PATTERNS: string[] = [
  '\\b(?:production_server_db|production_server_logs|wecare_production_db)\\b',
  '\\bkubectl\\b[^\\n]*(?:--context[= ]\\S*prod|use-context\\s+\\S*prod)',
  '\\bterraform\\s+(?:apply|destroy)\\b',
  '\\bgit\\s+push\\b[^\\n]*(?:--force(?:-with-lease)?\\b|\\s-f\\b)',
  '\\bgit\\s+reset\\s+--hard\\b',
  '\\bgit\\s+clean\\s+-[a-z]*f',
  '\\brm\\s+(?:-\\S+\\s+)*-[a-z]*(?:r[a-z]*f|f[a-z]*r)',
  '\\brm\\s+(?:-\\S+\\s+)*-[a-z]*r[a-z]*\\s+(?:\\S+\\s+)*?-[a-z]*f',
  '\\bdrop\\s+(?:table|database|schema)\\b',
  '\\btruncate\\s+table\\b',
  '\\bgh\\s+pr\\s+merge\\b',
  '\\bhelm\\s+(?:upgrade|install|uninstall)\\b',
  '\\bdeploy\\b',
];

export function checkDenied(text: string, patterns: string[]): DenyVerdict {
  const hit = firstMatch(text, patterns);
  if (!hit) return { denied: false, reason: null };
  return { denied: true, reason: `matches deny pattern ${hit.pattern}: "${redact(hit.match).slice(0, 80)}"` };
}
```

Append to `packages/core/src/redact/redact.ts`:
```ts
const SENSITIVE_KEY = /(password|passwd|secret|api[_-]?key|authorization|token)$/i;

/** Returns a deep copy with every string redacted; string values under sensitive keys are fully masked. */
export function redactDeep<T>(value: T): T {
  return redactValue(value, null) as T;
}

function redactValue(value: unknown, key: string | null): unknown {
  if (typeof value === 'string') {
    return key !== null && SENSITIVE_KEY.test(key) ? '«redacted:secret»' : redact(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, null));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v, k);
    return out;
  }
  return value;
}

const PARTIAL_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]*/g,
  /\bgithub_pat_[A-Za-z0-9_]*/g,
  /\bsk-[A-Za-z0-9_-]{4,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]*/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{4,}/g,
];

/**
 * FTS snippets can cut a token short, so the full patterns miss it. Masks known token prefixes.
 * Apply after redact(); the daemon's redactSnippet (http/redact-out.ts) composes both.
 */
export function redactPartialTokens(text: string): string {
  let out = text;
  for (const re of PARTIAL_PATTERNS) out = out.replace(re, '«redacted:partial»');
  return out;
}
```

Add these lines to **both** `packages/core/src/index.ts` and `packages/core/src/browser.ts` (`redact.ts` is already exported from both):
```ts
export * from './derive/patterns.ts';
export * from './derive/deny-list.ts';
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run packages/core`
Expected: PASS. All core tests are green, including 19 + 8 deny cases, 2 compile cases and 3 redactDeep/redactPartialTokens cases.

- [ ] **Step 6: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add packages/core
git commit -m "feat(core): add shared deny-list, pattern compiler, redactDeep and redactPartialTokens"
```

---

### Task 2: Core prod detection, permission badge and secret scan

**Files:**
- Create: `packages/core/src/derive/prod-detect.ts`, `packages/core/src/derive/permission.ts`, `packages/core/src/derive/secret-scan.ts`, `packages/core/src/derive/safety.test.ts`, `packages/core/src/test-utils/events.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/browser.ts`

**Interfaces:**
- Consumes: `TimelineEvent`, `emptyUsage`, `redact`, `REDACTION_PATTERNS`, `compilePattern` (Task 1), and Phase 1's `DEFAULT_PROD_PATTERNS` from `./prod.ts` (A5)
- Produces (exported from `index.ts` and `browser.ts`):
  ```ts
  export const DEFAULT_PROD_SKILLS: readonly string[]
  export interface ProdTouch { seq: number; ts: string; agentId: string | null; kind: 'skill' | 'command'; tool: string; detail: string }
  export function commandOf(e: TimelineEvent): string | null
  export function detectProdTouches(events: readonly TimelineEvent[], opts?: { prodSkills?: readonly string[]; prodPatterns?: readonly string[] }): ProdTouch[]
  export type PermissionBadge = 'bypass' | 'plan' | 'auto' | 'default' | 'custom' | 'unknown'
  export function permissionBadge(modes: readonly (string | null | undefined)[]): PermissionBadge
  export interface SecretFinding { line: number; kind: string }
  export function scanTextForSecrets(text: string): SecretFinding[]
  // test-utils/events.ts (test-only, not exported from index)
  export function ev(p: Partial<TimelineEvent> & Pick<TimelineEvent, 'seq' | 'ts' | 'kind'>): TimelineEvent
  export function usage(input: number, output: number, cacheRead: number, cacheWrite: number): Usage
  ```

- [ ] **Step 1: Create the event builder used by core tests**

`packages/core/src/test-utils/events.ts`
```ts
import type { TimelineEvent, Usage } from '../types/index.ts';

export function ev(p: Partial<TimelineEvent> & Pick<TimelineEvent, 'seq' | 'ts' | 'kind'>): TimelineEvent {
  return {
    sessionId: 's-test',
    agentId: null,
    uuid: `u-${p.seq}`,
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

export function usage(input: number, output: number, cacheRead: number, cacheWrite: number): Usage {
  return { input, output, cacheRead, cacheWrite, costUsd: null };
}
```

- [ ] **Step 2: Write the failing tests**

`packages/core/src/derive/safety.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { ev } from '../test-utils/events.ts';
import { permissionBadge } from './permission.ts';
import { commandOf, detectProdTouches } from './prod-detect.ts';
import { scanTextForSecrets } from './secret-scan.ts';

const driftEvents = [
  ev({ seq: 1, ts: '2026-09-03T08:00:00.000Z', kind: 'prompt', text: 'look at the svc repo' }),
  ev({
    seq: 2, ts: '2026-09-03T08:00:05.000Z', kind: 'tool_call', tool: 'Bash', toolUseId: 'dtu1',
    input: { command: "PGPASSWORD=hunter2 psql -h prod-db.internal -c 'select 1'" },
  }),
  ev({ seq: 3, ts: '2026-09-03T08:00:09.000Z', kind: 'tool_call', tool: 'Skill', toolUseId: 'dtu2', input: { skill: 'production_server_db' }, agentId: 'ag9' }),
  ev({ seq: 4, ts: '2026-09-03T08:00:10.000Z', kind: 'tool_call', tool: 'Bash', toolUseId: 'dtu3', input: { command: 'pnpm test' } }),
];

describe('detectProdTouches', () => {
  it('finds prod skills and prod commands, with redacted detail', () => {
    const touches = detectProdTouches(driftEvents);
    expect(touches.map((t) => [t.seq, t.kind, t.tool, t.agentId])).toEqual([
      [2, 'command', 'Bash', null],
      [3, 'skill', 'Skill', 'ag9'],
    ]);
    expect(touches[0]?.detail).toContain('«redacted:secret»');
    expect(JSON.stringify(touches)).not.toContain('hunter2');
    expect(touches[1]?.detail).toBe('production_server_db');
  });

  it('uses project patterns and custom skill lists', () => {
    const touches = detectProdTouches(driftEvents, { prodSkills: [], prodPatterns: ['pnpm\\s+test'] });
    expect(touches.map((t) => t.seq)).toEqual([2, 4]);
  });

  it('reads codex shell commands given as arrays', () => {
    const e = ev({ seq: 1, ts: '2026-09-01T00:00:00.000Z', kind: 'tool_call', tool: 'shell', input: { command: ['terraform', 'apply'] } });
    expect(commandOf(e)).toBe('terraform apply');
    expect(detectProdTouches([e])).toHaveLength(1);
  });
});

describe('permissionBadge', () => {
  it.each([
    [[], 'unknown'],
    [[null, undefined, ''], 'unknown'],
    [['bypassPermissions'], 'bypass'],
    [['plan'], 'plan'],
    [['acceptEdits'], 'auto'],
    [['default'], 'default'],
    [['plan', 'bypassPermissions'], 'bypass'],
    [['default', 'acceptEdits'], 'auto'],
    [['plan', 'default'], 'default'],
    [['acceptEdits', 'bypassPermissions'], 'custom'],
    [['weird-mode'], 'custom'],
    [['never'], 'bypass'],
    [['on-request'], 'default'],
  ] as const)('%j → %s', (modes, expected) => {
    expect(permissionBadge(modes)).toBe(expected);
  });
});

describe('scanTextForSecrets', () => {
  it('reports line and kind only', () => {
    const pat = `gh${'p_'}${'b'.repeat(36)}`;
    const text = [
      '{',
      `  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${pat}" },`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal env reference in a JSON file
      '  "other": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },',
      '  "db": "postgres://admin:hunter2@db.internal:5432/app",',
      '  "API_KEY": "abcdefghijkl"',
      '}',
      'PGPASSWORD=hunter2 psql',
    ].join('\n');
    const findings = scanTextForSecrets(text);
    expect(findings).toEqual([
      { line: 2, kind: 'github' },
      { line: 2, kind: 'json-secret-field' },
      { line: 4, kind: 'credentials' },
      { line: 5, kind: 'json-secret-field' },
      { line: 7, kind: 'secret' },
    ]);
    const s = JSON.stringify(findings);
    expect(s).not.toContain(pat);
    expect(s).not.toContain('hunter2');
  });

  it('returns nothing for clean text', () => {
    expect(scanTextForSecrets('# /review\nRun the review skill.')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `pnpm vitest run packages/core/src/derive/safety.test.ts`
Expected: FAIL, `Cannot find module './permission.ts'`

- [ ] **Step 4: Implement**

`packages/core/src/derive/prod-detect.ts`
```ts
import { redact } from '../redact/redact.ts';
import type { TimelineEvent } from '../types/index.ts';
import { compilePattern } from './patterns.ts';
import { DEFAULT_PROD_PATTERNS } from './prod.ts';

export const DEFAULT_PROD_SKILLS: readonly string[] = [
  'production_server_db',
  'production_server_logs',
  'wecare_production_db',
];

export interface ProdTouch {
  seq: number;
  ts: string;
  agentId: string | null;
  kind: 'skill' | 'command';
  tool: string;
  detail: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Shell command text of a Bash (Claude) or shell (Codex) tool call. */
export function commandOf(e: TimelineEvent): string | null {
  if (e.kind !== 'tool_call' || !isObj(e.input)) return null;
  const cmd = e.input.command;
  if (typeof cmd === 'string') return cmd;
  if (Array.isArray(cmd) && cmd.every((c) => typeof c === 'string')) return cmd.join(' ');
  return null;
}

export function detectProdTouches(
  events: readonly TimelineEvent[],
  opts: { prodSkills?: readonly string[]; prodPatterns?: readonly string[] } = {},
): ProdTouch[] {
  const skills = new Set(opts.prodSkills ?? DEFAULT_PROD_SKILLS);
  const patterns = [...DEFAULT_PROD_PATTERNS, ...(opts.prodPatterns ?? [])];
  const out: ProdTouch[] = [];
  for (const e of events) {
    if (e.kind !== 'tool_call' || e.tool === null) continue;
    const base = { seq: e.seq, ts: e.ts, agentId: e.agentId, tool: e.tool };
    if (e.tool === 'Skill' && isObj(e.input) && typeof e.input.skill === 'string' && skills.has(e.input.skill)) {
      out.push({ ...base, kind: 'skill', detail: e.input.skill });
      continue;
    }
    const cmd = commandOf(e);
    if (cmd !== null && patterns.some((p) => compilePattern(p).test(cmd))) {
      out.push({ ...base, kind: 'command', detail: redact(cmd).slice(0, 160) });
    }
  }
  return out;
}
```

`packages/core/src/derive/permission.ts`
```ts
export type PermissionBadge = 'bypass' | 'plan' | 'auto' | 'default' | 'custom' | 'unknown';
type Known = Exclude<PermissionBadge, 'custom' | 'unknown'>;

const KNOWN: Record<string, Known> = {
  // Claude Code
  bypassPermissions: 'bypass',
  plan: 'plan',
  acceptEdits: 'auto',
  auto: 'auto',
  default: 'default',
  // Codex approval policies
  never: 'bypass',
  'on-failure': 'auto',
  'on-request': 'default',
  untrusted: 'default',
};

/**
 * Badge for the permission modes seen in a session.
 * Plan → X and default → X are normal transitions, so the badge is X.
 * An unknown mode, or two distinct non-plan/default modes, is 'custom'.
 */
export function permissionBadge(modes: readonly (string | null | undefined)[]): PermissionBadge {
  const distinct = [...new Set(modes.filter((m): m is string => typeof m === 'string' && m.length > 0))];
  if (distinct.length === 0) return 'unknown';
  const mapped: Known[] = [];
  for (const m of distinct) {
    const k = KNOWN[m];
    if (k === undefined) return 'custom';
    mapped.push(k);
  }
  const set = new Set(mapped);
  if (set.size === 1) return mapped[0] ?? 'unknown';
  set.delete('plan');
  if (set.size === 1) return [...set][0] ?? 'unknown';
  set.delete('default');
  if (set.size === 0) return 'default';
  if (set.size === 1) return [...set][0] ?? 'unknown';
  return 'custom';
}
```

`packages/core/src/derive/secret-scan.ts`
```ts
import { REDACTION_PATTERNS } from '../redact/redact.ts';

export interface SecretFinding {
  line: number;
  kind: string;
}

const LINE_PATTERNS = REDACTION_PATTERNS.map((p) => ({
  kind: p.kind,
  re: new RegExp(p.re.source, p.re.flags.replace('g', '')),
}));

// "SOME_TOKEN": "literal-value" (8+ chars) — env references like "${X}" are fine.
const JSON_SECRET_FIELD = /"[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY|PAT)"\s*:\s*"([^"]{8,})"/i;

/** Finds secret-like content. Returns only line numbers (1-based) and kinds — never the values. */
export function scanTextForSecrets(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const kinds = new Set<string>();
    for (const p of LINE_PATTERNS) if (p.re.test(line)) kinds.add(p.kind);
    const m = JSON_SECRET_FIELD.exec(line);
    if (m?.[1] && !m[1].startsWith('${') && !m[1].startsWith('«redacted')) kinds.add('json-secret-field');
    for (const kind of kinds) out.push({ line: i + 1, kind });
  });
  return out;
}
```

Line 2 of the test matches `github` (the token), and also `json-secret-field`. The redaction `secret` pattern needs `token\s*[=:]` directly next to the key, and the JSON quote breaks that, so it does not match. The order within a line follows `REDACTION_PATTERNS`, then `json-secret-field`. That is why the expected array lists `github` before `json-secret-field`.

Add to **both** `packages/core/src/index.ts` and `packages/core/src/browser.ts`:
```ts
export * from './derive/prod-detect.ts';
export * from './derive/permission.ts';
export * from './derive/secret-scan.ts';
```
`DEFAULT_PROD_PATTERNS` keeps its single Phase 1 definition in `derive/prod.ts`. That list already covers `kubectl … prod`, `terraform apply` and `prod-db`, which is what this test relies on.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run packages/core/src/derive/safety.test.ts`
Expected: PASS (3 + 13 + 2 tests)

- [ ] **Step 6: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add packages/core
git commit -m "feat(core): add prod detection, permission badge and secret scanner"
```

---

### Task 3: Core step-timing stats

**Files:**
- Create: `packages/core/src/derive/step-stats.ts`, `packages/core/src/derive/step-stats.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/browser.ts`

**Interfaces:**
- Consumes: `TimelineEvent`, `Usage`, `emptyUsage` (§4); `ev`, `usage` test builders (Task 2); assumption A4
- Produces:
  ```ts
  export interface TurnStats { turn: number; agentId: string | null; startedAt: string; endedAt: string; wallMs: number; modelMs: number; toolMs: number; reportedMs: number | null; ttftMs: number | null; toolCalls: number; toolErrors: number; apiErrors: number; usage: Usage; tokensPerSec: number | null; cacheHitRate: number | null }
  export interface SessionStats { turns: number; wallMs: number; modelMs: number; toolMs: number; ttftMs: number | null; toolCalls: number; toolErrors: number; apiErrors: number; usage: Usage; tokensPerSec: number | null; cacheHitRate: number | null }
  export function unionMs(intervals: ReadonlyArray<readonly [number, number]>): number
  export function isToolError(result: TimelineEvent): boolean
  export function cacheHitRate(u: Pick<Usage, 'input' | 'cacheRead' | 'cacheWrite'>): number | null
  export function tokensPerSec(outputTokens: number, modelMs: number): number | null
  export function median(xs: readonly number[]): number | null
  export function addUsage(a: Usage, b: Usage): Usage
  export function computeTurnStats(events: readonly TimelineEvent[]): TurnStats[]
  export function computeSessionStats(turns: readonly TurnStats[]): SessionStats
  ```

**How the numbers are defined** (show this in the UI tooltip, Task 14):
- **wall** is the last event ts minus the first event ts of the turn.
- **tool time** is the *union* of the `[tool_use.ts, tool_result.ts]` intervals, so parallel tool calls are not double-counted.
- **model time** is `max(0, wall − tool time)`.
- **TTFT ≈** is the prompt ts minus the first assistant block ts (text, thinking or tool_use). Claude writes a record when a block completes, so this is an upper bound. It is `null` when the turn has no human prompt (for example, subagent turn 0).
- **tokens/sec** is output tokens ÷ model seconds.
- **cache hit rate** is `cacheRead / (input + cacheRead + cacheWrite)`.
- **reportedMs** is the `system` `turn_duration.durationMs`, when present.

- [ ] **Step 1: Write the failing test**

`packages/core/src/derive/step-stats.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { ev, usage } from '../test-utils/events.ts';
import { cacheHitRate, computeSessionStats, computeTurnStats, median, unionMs } from './step-stats.ts';

const T = (s: string) => `2026-09-01T09:${s}Z`;

const events = [
  ev({ seq: 1, ts: T('00:00.000'), kind: 'prompt', turn: 1, text: 'check tests' }),
  ev({ seq: 2, ts: T('00:05.000'), kind: 'tool_call', turn: 1, tool: 'Bash', toolUseId: 'tu1', messageId: 'm1', model: 'claude-opus-5', usage: usage(10, 20, 1000, 100) }),
  ev({ seq: 3, ts: T('00:30.000'), kind: 'tool_result', turn: 1, toolUseId: 'tu1', text: 'Tests 18 passed' }),
  ev({ seq: 4, ts: T('00:35.000'), kind: 'tool_call', turn: 1, tool: 'Edit', toolUseId: 'tu2', messageId: 'm2', model: 'claude-opus-5', usage: usage(5, 7, 1100, 0) }),
  ev({ seq: 5, ts: T('00:35.200'), kind: 'tool_result', turn: 1, toolUseId: 'tu2', text: '<tool_use_error>String not found</tool_use_error>' }),
  ev({ seq: 6, ts: T('00:35.500'), kind: 'assistant_text', turn: 1, text: 'Edited.', messageId: 'm2' }),
  ev({ seq: 7, ts: T('00:36.000'), kind: 'system', turn: 1, durationMs: 36000 }),
  ev({ seq: 8, ts: T('05:00.000'), kind: 'prompt', turn: 2, text: 'continue' }),
];

describe('computeTurnStats', () => {
  it('splits model time and tool time and derives rates', () => {
    const [t1, t2] = computeTurnStats(events);
    expect(t1).toMatchObject({
      turn: 1,
      agentId: null,
      startedAt: '2026-09-01T09:00:00.000Z',
      endedAt: '2026-09-01T09:00:36.000Z',
      wallMs: 36000,
      toolMs: 25200,
      modelMs: 10800,
      reportedMs: 36000,
      ttftMs: 5000,
      toolCalls: 2,
      toolErrors: 1,
      apiErrors: 0,
      usage: { input: 15, output: 27, cacheRead: 2100, cacheWrite: 100, costUsd: null },
    });
    expect(t1?.tokensPerSec).toBeCloseTo(2.5, 6);
    expect(t1?.cacheHitRate).toBeCloseTo(2100 / 2215, 6);
    expect(t2).toMatchObject({ turn: 2, wallMs: 0, modelMs: 0, toolMs: 0, ttftMs: null, tokensPerSec: null, cacheHitRate: null });
  });

  it('does not double-count parallel tool calls and ignores unanswered calls', () => {
    const par = [
      ev({ seq: 1, ts: T('00:00.000'), kind: 'prompt' }),
      ev({ seq: 2, ts: T('00:01.000'), kind: 'tool_call', tool: 'Read', toolUseId: 'a' }),
      ev({ seq: 3, ts: T('00:01.000'), kind: 'tool_call', tool: 'Read', toolUseId: 'b' }),
      ev({ seq: 4, ts: T('00:01.000'), kind: 'tool_call', tool: 'Read', toolUseId: 'c' }),
      ev({ seq: 5, ts: T('00:11.000'), kind: 'tool_result', toolUseId: 'a' }),
      ev({ seq: 6, ts: T('00:21.000'), kind: 'tool_result', toolUseId: 'b' }),
    ];
    const [t] = computeTurnStats(par);
    expect(t?.toolMs).toBe(20000);
    expect(t?.modelMs).toBe(1000);
    expect(t?.toolCalls).toBe(3);
  });

  it('groups subagent turns separately and counts API errors', () => {
    const mixed = [
      ev({ seq: 1, ts: T('00:00.000'), kind: 'assistant_text', turn: 0, agentId: 'ag1' }),
      ev({ seq: 2, ts: T('00:02.000'), kind: 'error', turn: 0, agentId: 'ag1', text: 'API Error: 529' }),
      ev({ seq: 3, ts: T('00:00.000'), kind: 'prompt', turn: 1 }),
    ];
    const stats = computeTurnStats(mixed);
    expect(stats.map((s) => [s.agentId, s.turn, s.apiErrors, s.ttftMs])).toEqual([
      ['ag1', 0, 1, null],
      [null, 1, 0, null],
    ]);
  });
});

describe('computeSessionStats', () => {
  it('aggregates turns', () => {
    const s = computeSessionStats(computeTurnStats(events));
    expect(s).toMatchObject({ turns: 2, wallMs: 36000, toolMs: 25200, modelMs: 10800, ttftMs: 5000, toolCalls: 2, toolErrors: 1 });
    expect(s.tokensPerSec).toBeCloseTo(2.5, 6);
    expect(s.usage.output).toBe(27);
  });

  it('handles an empty session', () => {
    expect(computeSessionStats([])).toMatchObject({ turns: 0, ttftMs: null, tokensPerSec: null, cacheHitRate: null });
  });
});

describe('helpers', () => {
  it('unionMs merges overlapping and adjacent intervals', () => {
    expect(unionMs([[0, 10], [5, 15], [15, 20], [30, 31]])).toBe(21);
    expect(unionMs([])).toBe(0);
  });
  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
  it('cacheHitRate', () => {
    expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(cacheHitRate({ input: 50, cacheRead: 150, cacheWrite: 0 })).toBe(0.75);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/core/src/derive/step-stats.test.ts`
Expected: FAIL, `Cannot find module './step-stats.ts'`

- [ ] **Step 3: Implement**

`packages/core/src/derive/step-stats.ts`
```ts
import { type TimelineEvent, type Usage, emptyUsage } from '../types/index.ts';

export interface TurnStats {
  turn: number;
  agentId: string | null;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  modelMs: number;
  toolMs: number;
  reportedMs: number | null;
  ttftMs: number | null;
  toolCalls: number;
  toolErrors: number;
  apiErrors: number;
  usage: Usage;
  tokensPerSec: number | null;
  cacheHitRate: number | null;
}

export interface SessionStats {
  turns: number;
  wallMs: number;
  modelMs: number;
  toolMs: number;
  ttftMs: number | null;
  toolCalls: number;
  toolErrors: number;
  apiErrors: number;
  usage: Usage;
  tokensPerSec: number | null;
  cacheHitRate: number | null;
}

const ASSISTANT_KINDS = new Set<TimelineEvent['kind']>(['assistant_text', 'thinking', 'tool_call']);

export function unionMs(intervals: ReadonlyArray<readonly [number, number]>): number {
  const sorted = intervals
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a)
    .map(([a, b]) => [a, b] as const)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curStart = Number.NEGATIVE_INFINITY;
  let curEnd = Number.NEGATIVE_INFINITY;
  for (const [s, e] of sorted) {
    if (s > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

export function isToolError(result: TimelineEvent): boolean {
  if (result.kind === 'error') return true;
  return typeof result.text === 'string' && result.text.trimStart().startsWith('<tool_use_error>');
}

export function cacheHitRate(u: Pick<Usage, 'input' | 'cacheRead' | 'cacheWrite'>): number | null {
  const denom = u.input + u.cacheRead + u.cacheWrite;
  return denom > 0 ? u.cacheRead / denom : null;
}

export function tokensPerSec(outputTokens: number, modelMs: number): number | null {
  return outputTokens > 0 && modelMs > 0 ? outputTokens / (modelMs / 1000) : null;
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const hi = s[mid] ?? 0;
  if (s.length % 2 === 1) return hi;
  const lo = s[mid - 1] ?? hi;
  return (lo + hi) / 2;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

function statsForGroup(group: readonly TimelineEvent[], results: ReadonlyMap<string, TimelineEvent>): TurnStats | null {
  const first = group[0];
  if (!first) return null;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const e of group) {
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    if (t < start) start = t;
    if (t > end) end = t;
  }
  if (!Number.isFinite(start)) return null;

  const intervals: Array<[number, number]> = [];
  let toolCalls = 0;
  let toolErrors = 0;
  let apiErrors = 0;
  let reportedMs: number | null = null;
  let u = emptyUsage();
  for (const e of group) {
    if (e.usage) u = addUsage(u, e.usage);
    if (e.kind === 'system' && e.durationMs !== null) reportedMs = e.durationMs;
    if (e.kind === 'error' && e.toolUseId === null) apiErrors++;
    if (e.kind !== 'tool_call') continue;
    toolCalls++;
    const r = e.toolUseId ? results.get(e.toolUseId) : undefined;
    if (!r) continue;
    intervals.push([Date.parse(e.ts), Date.parse(r.ts)]);
    if (isToolError(r)) toolErrors++;
  }
  const toolMs = unionMs(intervals);
  const wallMs = end - start;
  const modelMs = Math.max(0, wallMs - toolMs);
  const prompt = group.find((e) => e.kind === 'prompt');
  const firstAssistant = group.find((e) => ASSISTANT_KINDS.has(e.kind));
  const ttftMs =
    prompt && firstAssistant ? Math.max(0, Date.parse(firstAssistant.ts) - Date.parse(prompt.ts)) : null;

  return {
    turn: first.turn,
    agentId: first.agentId,
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(end).toISOString(),
    wallMs,
    modelMs,
    toolMs,
    reportedMs,
    ttftMs,
    toolCalls,
    toolErrors,
    apiErrors,
    usage: u,
    tokensPerSec: tokensPerSec(u.output, modelMs),
    cacheHitRate: cacheHitRate(u),
  };
}

/** One entry per (agentId, turn), in order of first appearance (by seq). */
export function computeTurnStats(events: readonly TimelineEvent[]): TurnStats[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const results = new Map<string, TimelineEvent>();
  for (const e of sorted) {
    if ((e.kind === 'tool_result' || e.kind === 'error') && e.toolUseId) results.set(e.toolUseId, e);
  }
  const groups = new Map<string, TimelineEvent[]>();
  for (const e of sorted) {
    const key = `${e.agentId ?? ''}|${e.turn}`;
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }
  const out: TurnStats[] = [];
  for (const g of groups.values()) {
    const s = statsForGroup(g, results);
    if (s) out.push(s);
  }
  return out;
}

export function computeSessionStats(turns: readonly TurnStats[]): SessionStats {
  let u = emptyUsage();
  let wallMs = 0;
  let modelMs = 0;
  let toolMs = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let apiErrors = 0;
  const ttfts: number[] = [];
  for (const t of turns) {
    u = addUsage(u, t.usage);
    wallMs += t.wallMs;
    modelMs += t.modelMs;
    toolMs += t.toolMs;
    toolCalls += t.toolCalls;
    toolErrors += t.toolErrors;
    apiErrors += t.apiErrors;
    if (t.ttftMs !== null) ttfts.push(t.ttftMs);
  }
  return {
    turns: turns.length,
    wallMs,
    modelMs,
    toolMs,
    ttftMs: median(ttfts),
    toolCalls,
    toolErrors,
    apiErrors,
    usage: u,
    tokensPerSec: tokensPerSec(u.output, modelMs),
    cacheHitRate: cacheHitRate(u),
  };
}
```

Add `export * from './derive/step-stats.ts';` to both `packages/core/src/index.ts` and `packages/core/src/browser.ts`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run packages/core/src/derive/step-stats.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add packages/core
git commit -m "feat(core): derive per-turn and per-session step timing stats"
```

---

### Task 4: Core deliverables and file summaries

**Files:**
- Create: `packages/core/src/derive/deliverables.ts`, `packages/core/src/derive/deliverables.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/browser.ts`

**Interfaces:**
- Consumes: `TimelineEvent`; `isToolError` (Task 3); assumptions A4 and A6
- Produces:
  ```ts
  export type DeliverableStatus = 'applied' | 'failed' | 'pending'
  export interface FileChange { path: string; tool: string; toolUseId: string | null; turn: number; seq: number; ts: string; agentId: string | null; status: DeliverableStatus; oldText: string | null; newText: string | null }
  export interface DeliverableFile { path: string; tools: string[]; ops: number; status: DeliverableStatus; lastTs: string }
  export interface TurnDeliverables { turn: number; agentId: string | null; files: DeliverableFile[] }
  export interface FileSummary { path: string; ops: number; failedOps: number; turns: number[]; agentIds: Array<string | null>; firstTs: string; lastTs: string; changes: FileChange[] }
  export const FILE_EDIT_TOOLS: readonly ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']
  export function extractFileChanges(events: readonly TimelineEvent[]): FileChange[]
  export function deliverablesByTurn(events: readonly TimelineEvent[]): TurnDeliverables[]
  export function summarizeFiles(changes: readonly FileChange[]): FileSummary[]
  ```

Deliverables come **only** from file-editing tool_use inputs, never from what the model says. A change's status is:
- `applied` when its tool_result exists and is not an error
- `failed` when the result is `<tool_use_error>…` or an `error` event
- `pending` when there is no result yet

The texts are clipped to 4,000 characters. The route layer redacts them (Task 9).

- [ ] **Step 1: Write the failing test**

`packages/core/src/derive/deliverables.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { ev } from '../test-utils/events.ts';
import { deliverablesByTurn, extractFileChanges, summarizeFiles } from './deliverables.ts';

const T = (s: string) => `2026-09-01T10:${s}Z`;
const patch = ['*** Begin Patch', '*** Update File: src/x.ts', '@@', '-a', '+b', '*** Add File: src/y.ts', '+new', '*** End Patch'].join('\n');

const events = [
  ev({ seq: 1, ts: T('00:00.000'), kind: 'prompt', turn: 1 }),
  ev({ seq: 2, ts: T('00:01.000'), kind: 'assistant_text', turn: 1, text: 'I changed c.ts' }),
  ev({ seq: 3, ts: T('00:02.000'), kind: 'tool_call', turn: 1, tool: 'Edit', toolUseId: 'e1', input: { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' } }),
  ev({ seq: 4, ts: T('00:03.000'), kind: 'tool_result', turn: 1, toolUseId: 'e1', text: 'ok' }),
  ev({ seq: 5, ts: T('00:04.000'), kind: 'tool_call', turn: 1, tool: 'Write', toolUseId: 'w1', input: { file_path: '/r/b.ts', content: 'x' } }),
  ev({ seq: 6, ts: T('00:05.000'), kind: 'tool_result', turn: 1, toolUseId: 'w1', text: '<tool_use_error>File has not been read yet</tool_use_error>' }),
  ev({ seq: 7, ts: T('00:06.000'), kind: 'tool_call', turn: 1, tool: 'Edit', toolUseId: 'e2', input: { file_path: '/r/a.ts', old_string: 'b', new_string: 'c' } }),
  ev({ seq: 8, ts: T('00:07.000'), kind: 'tool_call', turn: 1, tool: 'Bash', toolUseId: 'b1', input: { command: "sed -i '' s/a/b/ /r/z.ts" } }),
  ev({ seq: 9, ts: T('01:00.000'), kind: 'prompt', turn: 2 }),
  ev({ seq: 10, ts: T('01:01.000'), kind: 'tool_call', turn: 2, tool: 'MultiEdit', toolUseId: 'm1', input: { file_path: '/r/a.ts', edits: [{ old_string: 'c', new_string: 'd' }, { old_string: 'e', new_string: 'f' }] } }),
  ev({ seq: 11, ts: T('01:02.000'), kind: 'tool_result', turn: 2, toolUseId: 'm1', text: 'ok' }),
  ev({ seq: 12, ts: T('01:03.000'), kind: 'tool_call', turn: 2, tool: 'NotebookEdit', toolUseId: 'n1', input: { notebook_path: '/r/nb.ipynb', new_source: 'print(1)' } }),
  ev({ seq: 13, ts: T('01:04.000'), kind: 'tool_result', turn: 2, toolUseId: 'n1', text: 'ok' }),
  ev({ seq: 14, ts: T('01:05.000'), kind: 'tool_call', turn: 2, tool: 'apply_patch', toolUseId: 'p1', input: patch, agentId: null }),
  ev({ seq: 15, ts: T('01:06.000'), kind: 'tool_result', turn: 2, toolUseId: 'p1', text: 'Done' }),
];

describe('extractFileChanges', () => {
  it('uses tool inputs only and resolves status from results', () => {
    const changes = extractFileChanges(events);
    expect(changes.map((c) => [c.path, c.tool, c.status])).toEqual([
      ['/r/a.ts', 'Edit', 'applied'],
      ['/r/b.ts', 'Write', 'failed'],
      ['/r/a.ts', 'Edit', 'pending'],
      ['/r/a.ts', 'MultiEdit', 'applied'],
      ['/r/nb.ipynb', 'NotebookEdit', 'applied'],
      ['src/x.ts', 'apply_patch', 'applied'],
      ['src/y.ts', 'apply_patch', 'applied'],
    ]);
    expect(changes[0]).toMatchObject({ oldText: 'a', newText: 'b', turn: 1, seq: 3 });
    expect(changes[3]).toMatchObject({ oldText: 'c\n…\ne', newText: 'd\n…\nf' });
    expect(changes.some((c) => c.path.endsWith('c.ts') || c.path.endsWith('z.ts'))).toBe(false);
  });

  it('clips long texts', () => {
    const big = 'x'.repeat(5000);
    const [c] = extractFileChanges([
      ev({ seq: 1, ts: T('00:00.000'), kind: 'tool_call', tool: 'Write', toolUseId: 'w', input: { file_path: '/f', content: big } }),
    ]);
    expect(c?.newText).toHaveLength(4001);
    expect(c?.status).toBe('pending');
  });
});

describe('deliverablesByTurn', () => {
  it('groups by turn and path with the best status', () => {
    const d = deliverablesByTurn(events);
    expect(d).toEqual([
      {
        turn: 1,
        agentId: null,
        files: [
          { path: '/r/a.ts', tools: ['Edit'], ops: 2, status: 'applied', lastTs: T('00:06.000') },
          { path: '/r/b.ts', tools: ['Write'], ops: 1, status: 'failed', lastTs: T('00:04.000') },
        ],
      },
      {
        turn: 2,
        agentId: null,
        files: [
          { path: '/r/a.ts', tools: ['MultiEdit'], ops: 1, status: 'applied', lastTs: T('01:01.000') },
          { path: '/r/nb.ipynb', tools: ['NotebookEdit'], ops: 1, status: 'applied', lastTs: T('01:03.000') },
          { path: 'src/x.ts', tools: ['apply_patch'], ops: 1, status: 'applied', lastTs: T('01:05.000') },
          { path: 'src/y.ts', tools: ['apply_patch'], ops: 1, status: 'applied', lastTs: T('01:05.000') },
        ],
      },
    ]);
  });
});

describe('summarizeFiles', () => {
  it('aggregates across turns, newest first', () => {
    const s = summarizeFiles(extractFileChanges(events));
    expect(s.map((f) => f.path)).toEqual(['src/x.ts', 'src/y.ts', '/r/nb.ipynb', '/r/a.ts', '/r/b.ts']);
    const a = s.find((f) => f.path === '/r/a.ts');
    expect(a).toMatchObject({ ops: 3, failedOps: 0, turns: [1, 2], agentIds: [null], firstTs: T('00:02.000'), lastTs: T('01:01.000') });
    expect(a?.changes).toHaveLength(3);
    expect(s.find((f) => f.path === '/r/b.ts')?.failedOps).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/core/src/derive/deliverables.test.ts`
Expected: FAIL, `Cannot find module './deliverables.ts'`

- [ ] **Step 3: Implement**

`packages/core/src/derive/deliverables.ts`
```ts
import type { TimelineEvent } from '../types/index.ts';
import { isToolError } from './step-stats.ts';

export type DeliverableStatus = 'applied' | 'failed' | 'pending';

export interface FileChange {
  path: string;
  tool: string;
  toolUseId: string | null;
  turn: number;
  seq: number;
  ts: string;
  agentId: string | null;
  status: DeliverableStatus;
  oldText: string | null;
  newText: string | null;
}

export interface DeliverableFile {
  path: string;
  tools: string[];
  ops: number;
  status: DeliverableStatus;
  lastTs: string;
}

export interface TurnDeliverables {
  turn: number;
  agentId: string | null;
  files: DeliverableFile[];
}

export interface FileSummary {
  path: string;
  ops: number;
  failedOps: number;
  turns: number[];
  agentIds: Array<string | null>;
  firstTs: string;
  lastTs: string;
  changes: FileChange[];
}

export const FILE_EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'] as const;
const TOOL_SET = new Set<string>(FILE_EDIT_TOOLS);
const MAX_TEXT = 4000;
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const STATUS_RANK: Record<DeliverableStatus, number> = { failed: 0, pending: 1, applied: 2 };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const clip = (v: string | null): string | null => (v !== null && v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v);

function patchText(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (isObj(input)) return str(input.input) ?? str(input.patch);
  return null;
}

function joinEdits(edits: unknown, key: 'old_string' | 'new_string'): string | null {
  if (!Array.isArray(edits)) return null;
  const parts = edits.filter(isObj).map((e) => str(e[key]) ?? '');
  return parts.length ? parts.join('\n…\n') : null;
}

function targets(e: TimelineEvent): Array<{ path: string; oldText: string | null; newText: string | null }> {
  const input = e.input;
  switch (e.tool) {
    case 'Edit': {
      const path = isObj(input) ? str(input.file_path) : null;
      return path && isObj(input) ? [{ path, oldText: str(input.old_string), newText: str(input.new_string) }] : [];
    }
    case 'Write': {
      const path = isObj(input) ? str(input.file_path) : null;
      return path && isObj(input) ? [{ path, oldText: null, newText: str(input.content) }] : [];
    }
    case 'MultiEdit': {
      const path = isObj(input) ? str(input.file_path) : null;
      return path && isObj(input)
        ? [{ path, oldText: joinEdits(input.edits, 'old_string'), newText: joinEdits(input.edits, 'new_string') }]
        : [];
    }
    case 'NotebookEdit': {
      const path = isObj(input) ? str(input.notebook_path) : null;
      return path && isObj(input) ? [{ path, oldText: null, newText: str(input.new_source) }] : [];
    }
    case 'apply_patch': {
      const text = patchText(input);
      if (!text) return [];
      return [...text.matchAll(PATCH_FILE)]
        .map((m) => m[1]?.trim())
        .filter((p): p is string => Boolean(p))
        .map((path) => ({ path, oldText: null, newText: text }));
    }
    default:
      return [];
  }
}

export function extractFileChanges(events: readonly TimelineEvent[]): FileChange[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const results = new Map<string, TimelineEvent>();
  for (const e of sorted) {
    if ((e.kind === 'tool_result' || e.kind === 'error') && e.toolUseId) results.set(e.toolUseId, e);
  }
  const out: FileChange[] = [];
  for (const e of sorted) {
    if (e.kind !== 'tool_call' || e.tool === null || !TOOL_SET.has(e.tool)) continue;
    const r = e.toolUseId ? results.get(e.toolUseId) : undefined;
    const status: DeliverableStatus = !r ? 'pending' : isToolError(r) ? 'failed' : 'applied';
    for (const t of targets(e)) {
      out.push({
        path: t.path,
        tool: e.tool,
        toolUseId: e.toolUseId,
        turn: e.turn,
        seq: e.seq,
        ts: e.ts,
        agentId: e.agentId,
        status,
        oldText: clip(t.oldText),
        newText: clip(t.newText),
      });
    }
  }
  return out;
}

export function deliverablesByTurn(events: readonly TimelineEvent[]): TurnDeliverables[] {
  const groups = new Map<string, { turn: number; agentId: string | null; files: Map<string, DeliverableFile> }>();
  for (const c of extractFileChanges(events)) {
    const key = `${c.agentId ?? ''}|${c.turn}`;
    let g = groups.get(key);
    if (!g) {
      g = { turn: c.turn, agentId: c.agentId, files: new Map() };
      groups.set(key, g);
    }
    const f = g.files.get(c.path);
    if (!f) {
      g.files.set(c.path, { path: c.path, tools: [c.tool], ops: 1, status: c.status, lastTs: c.ts });
      continue;
    }
    f.ops++;
    if (!f.tools.includes(c.tool)) f.tools.push(c.tool);
    if (STATUS_RANK[c.status] > STATUS_RANK[f.status]) f.status = c.status;
    if (c.ts > f.lastTs) f.lastTs = c.ts;
  }
  return [...groups.values()].map((g) => ({ turn: g.turn, agentId: g.agentId, files: [...g.files.values()] }));
}

export function summarizeFiles(changes: readonly FileChange[]): FileSummary[] {
  const byPath = new Map<string, FileSummary>();
  for (const c of changes) {
    let s = byPath.get(c.path);
    if (!s) {
      s = { path: c.path, ops: 0, failedOps: 0, turns: [], agentIds: [], firstTs: c.ts, lastTs: c.ts, changes: [] };
      byPath.set(c.path, s);
    }
    s.ops++;
    if (c.status === 'failed') s.failedOps++;
    if (!s.turns.includes(c.turn)) s.turns.push(c.turn);
    if (!s.agentIds.includes(c.agentId)) s.agentIds.push(c.agentId);
    if (c.ts < s.firstTs) s.firstTs = c.ts;
    if (c.ts > s.lastTs) s.lastTs = c.ts;
    s.changes.push(c);
  }
  return [...byPath.values()].sort((a, b) => (a.lastTs === b.lastTs ? 0 : a.lastTs < b.lastTs ? 1 : -1));
}
```

`summarizeFiles` sorts with a stable sort, so `src/x.ts` and `src/y.ts` (same `lastTs`) keep their insertion order. That matches the expected order in the test.

Add `export * from './derive/deliverables.ts';` to both `packages/core/src/index.ts` and `packages/core/src/browser.ts`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run packages/core/src/derive/deliverables.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add packages/core
git commit -m "feat(core): derive per-turn deliverables and file summaries from edit tool inputs"
```

---

### Task 5: API contract for Phase 3 (schemas, client methods, config, WS event)

**Files:**
- Create: `packages/api-contract/src/routes/session-detail.ts`, `packages/api-contract/src/routes/links.ts`, `packages/api-contract/src/routes/audit.ts`, `packages/api-contract/src/routes/safety.ts`
- Create: `packages/api-contract/src/client-p3.ts`, `packages/api-contract/src/client-p3.test.ts`, `packages/api-contract/src/schemas-p3.test.ts`
- Modify: `packages/api-contract/src/config.ts`, `packages/api-contract/src/config.test.ts`, `packages/api-contract/src/client.ts`, `packages/api-contract/src/live.ts` (A8), `packages/api-contract/src/index.ts`

**Interfaces:**
- Consumes: core types `TurnStats`, `SessionStats`, `DeliverableFile`, `TurnDeliverables`, `FileChange`, `FileSummary`, `ProdTouch`, `PermissionBadge`, `SecretFinding`, `DenyVerdict`, `AuditEntry`, `Source` (Tasks 1–4, §4). `createApiClient` (A9)
- Produces: the zod schemas below and their inferred types. `UsagePoint`, `SessionSafety`, `RawLine`, `RawPage`, `PlanRef`, `SessionLinks`, `PlanContent`, `SecretsFileReport`, `SecretsReport`, `AuditQuery` and `DenyCheckRequest` are **defined only here**, and the daemon imports them. Also produces `createP3Methods(o: P3ClientOptions)`, `ApiCallError`, the `OrcConfig.safety` / `OrcConfig.links` fields, and the `LiveEvent` member `{ type: 'audit.recorded'; entry: AuditEntry }`.

- [ ] **Step 1: Write the failing tests**

`packages/api-contract/src/schemas-p3.test.ts`
```ts
import type { DeliverableFile, FileSummary, SessionStats, TurnStats } from '@orc/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { AuditQuery } from './routes/audit.ts';
import { DenyCheckRequest } from './routes/safety.ts';
import {
  DeliverableFileSchema,
  ExportQuery,
  FileSummarySchema,
  RawQuery,
  SessionStatsSchema,
  TurnStatsSchema,
} from './routes/session-detail.ts';

describe('phase 3 schemas', () => {
  it('match the core types exactly', () => {
    expectTypeOf<z.infer<typeof TurnStatsSchema>>().toEqualTypeOf<TurnStats>();
    expectTypeOf<z.infer<typeof SessionStatsSchema>>().toEqualTypeOf<SessionStats>();
    expectTypeOf<z.infer<typeof DeliverableFileSchema>>().toEqualTypeOf<DeliverableFile>();
    expectTypeOf<z.infer<typeof FileSummarySchema>>().toEqualTypeOf<FileSummary>();
  });

  it('coerces query strings with defaults', () => {
    expect(RawQuery.parse({ offset: '10' })).toEqual({ offset: 10, limit: 200 });
    expect(() => RawQuery.parse({ limit: '5000' })).toThrow();
    expect(AuditQuery.parse({ limit: '5', actor: 'user' })).toEqual({ limit: 5, actor: 'user' });
    expect(() => AuditQuery.parse({ actor: 'hacker' })).toThrow();
    expect(ExportQuery.parse({})).toEqual({ redact: 'true', confirm: 'false' });
    expect(DenyCheckRequest.parse({ text: 'rm -rf /' })).toEqual({ text: 'rm -rf /', projectId: null });
  });
});
```

`packages/api-contract/src/client-p3.test.ts`
```ts
import { describe, expect, it, vi } from 'vitest';
import { ApiCallError, createP3Methods } from './client-p3.ts';

function fakeFetch(status: number, body: unknown, contentType = 'application/json') {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': contentType } }),
  );
}

const stats = {
  session: { turns: 0, wallMs: 0, modelMs: 0, toolMs: 0, ttftMs: null, toolCalls: 0, toolErrors: 0, apiErrors: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null }, tokensPerSec: null, cacheHitRate: null },
  turns: [],
  agents: [],
};

describe('createP3Methods', () => {
  it('sends the token and parses the response', async () => {
    const f = fakeFetch(200, stats);
    const m = createP3Methods({ baseUrl: 'http://127.0.0.1:4317', token: 't0k', fetch: f });
    await expect(m.sessionsStats('claude', 's 1')).resolves.toEqual(stats);
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:4317/api/sessions/claude/s%201/stats');
    expect((init?.headers as Record<string, string>)['x-orc-token']).toBe('t0k');
  });

  it('builds query strings and skips empty values', async () => {
    const f = fakeFetch(200, []);
    const m = createP3Methods({ baseUrl: '', token: 't', fetch: f });
    await m.auditList({ sessionPk: 'claude:s-basic', action: undefined, limit: 50 });
    expect(f.mock.calls[0]?.[0]).toBe('/api/audit?sessionPk=claude%3As-basic&limit=50');
  });

  it('posts JSON for deny-check', async () => {
    const f = fakeFetch(200, { denied: true, reason: 'x' });
    const m = createP3Methods({ baseUrl: '', token: 't', fetch: f });
    await expect(m.safetyDenyCheck({ text: 'rm -rf /', projectId: null })).resolves.toEqual({ denied: true, reason: 'x' });
    const init = f.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ text: 'rm -rf /', projectId: null }));
  });

  it('requests an unredacted export with confirm', async () => {
    const f = fakeFetch(200, 'PK', 'application/zip');
    const m = createP3Methods({ baseUrl: '', token: 't', fetch: f });
    const blob = await m.sessionsExport('claude', 's-basic', { redact: false });
    expect(blob.size).toBe(2);
    expect(f.mock.calls[0]?.[0]).toBe('/api/sessions/claude/s-basic/export?redact=false&confirm=true');
  });

  it('throws ApiCallError with the server error code', async () => {
    const f = fakeFetch(404, { error: { code: 'not_found', message: 'no such session' } });
    const m = createP3Methods({ baseUrl: '', token: 't', fetch: f });
    const err = await m.sessionsLinks('claude', 'nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiCallError);
    expect(err).toMatchObject({ status: 404, code: 'not_found', message: 'no such session' });
  });
});
```

Append to `packages/api-contract/src/config.test.ts` (inside the existing `describe('OrcConfig', …)`):
```ts
  it('fills phase 3 safety and links defaults', () => {
    const c = OrcConfig.parse({});
    expect(c.safety.extraDenyPatterns).toEqual([]);
    expect(c.safety.prodSkills).toEqual(['production_server_db', 'production_server_logs', 'wecare_production_db']);
    expect(c.safety.secretScanPaths).toEqual(['~/Wakecap/.mcp.json', '~/Wakecap/.claude/commands/*.md']);
    expect(c.links).toEqual({ linearWorkspace: null, planRoots: ['~/Wakecap/plans'] });
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run packages/api-contract`
Expected: FAIL. The modules `./client-p3.ts` and `./routes/session-detail.ts` are missing, and `c.safety` is undefined.

- [ ] **Step 3: Write the schemas**

`packages/api-contract/src/routes/session-detail.ts`
```ts
import { z } from 'zod';

export const SourceParam = z.enum(['claude', 'codex', 'agnc']);

export const UsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  costUsd: z.number().nullable(),
});

export const TurnStatsSchema = z.object({
  turn: z.number(),
  agentId: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
  wallMs: z.number(),
  modelMs: z.number(),
  toolMs: z.number(),
  reportedMs: z.number().nullable(),
  ttftMs: z.number().nullable(),
  toolCalls: z.number(),
  toolErrors: z.number(),
  apiErrors: z.number(),
  usage: UsageSchema,
  tokensPerSec: z.number().nullable(),
  cacheHitRate: z.number().nullable(),
});

export const SessionStatsSchema = z.object({
  turns: z.number(),
  wallMs: z.number(),
  modelMs: z.number(),
  toolMs: z.number(),
  ttftMs: z.number().nullable(),
  toolCalls: z.number(),
  toolErrors: z.number(),
  apiErrors: z.number(),
  usage: UsageSchema,
  tokensPerSec: z.number().nullable(),
  cacheHitRate: z.number().nullable(),
});

export const SessionStatsResponse = z.object({
  session: SessionStatsSchema,
  turns: z.array(TurnStatsSchema),
  agents: z.array(z.object({ agentId: z.string(), stats: SessionStatsSchema })),
});
export type SessionStatsResponse = z.infer<typeof SessionStatsResponse>;

export const DeliverableStatusSchema = z.enum(['applied', 'failed', 'pending']);

export const DeliverableFileSchema = z.object({
  path: z.string(),
  tools: z.array(z.string()),
  ops: z.number(),
  status: DeliverableStatusSchema,
  lastTs: z.string(),
});

export const TurnDeliverablesSchema = z.object({
  turn: z.number(),
  agentId: z.string().nullable(),
  files: z.array(DeliverableFileSchema),
});

export const FileChangeSchema = z.object({
  path: z.string(),
  tool: z.string(),
  toolUseId: z.string().nullable(),
  turn: z.number(),
  seq: z.number(),
  ts: z.string(),
  agentId: z.string().nullable(),
  status: DeliverableStatusSchema,
  oldText: z.string().nullable(),
  newText: z.string().nullable(),
});

export const FileSummarySchema = z.object({
  path: z.string(),
  ops: z.number(),
  failedOps: z.number(),
  turns: z.array(z.number()),
  agentIds: z.array(z.string().nullable()),
  firstTs: z.string(),
  lastTs: z.string(),
  changes: z.array(FileChangeSchema),
});

export const UsagePointSchema = z.object({
  ts: z.string(),
  agentId: z.string().nullable(),
  model: z.string(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  costUsd: z.number().nullable(),
});
export type UsagePoint = z.infer<typeof UsagePointSchema>;

export const ProdTouchSchema = z.object({
  seq: z.number(),
  ts: z.string(),
  agentId: z.string().nullable(),
  kind: z.enum(['skill', 'command']),
  tool: z.string(),
  detail: z.string(),
});

export const PermissionBadgeSchema = z.enum(['bypass', 'plan', 'auto', 'default', 'custom', 'unknown']);

export const SessionSafetySchema = z.object({
  permissionMode: z.string().nullable(),
  permissionBadge: PermissionBadgeSchema,
  touchedProd: z.boolean(),
  prodTouches: z.array(ProdTouchSchema),
});
export type SessionSafety = z.infer<typeof SessionSafetySchema>;

export const RawLineSchema = z.object({
  offset: z.number(),
  text: z.string(),
  truncated: z.boolean(),
  partial: z.boolean(),
});
export type RawLine = z.infer<typeof RawLineSchema>;

export const RawPageSchema = z.object({
  path: z.string(),
  items: z.array(RawLineSchema),
  nextOffset: z.number().nullable(),
});
export type RawPage = z.infer<typeof RawPageSchema>;

export const RawQuery = z.object({
  agentId: z.string().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export const ExportQuery = z.object({
  redact: z.enum(['true', 'false']).default('true'),
  confirm: z.enum(['true', 'false']).default('false'),
});
```

`packages/api-contract/src/routes/links.ts`
```ts
import { z } from 'zod';

const PrRefP3 = z.object({ repo: z.string(), number: z.number(), url: z.string() });

export const PlanSourceSchema = z.enum(['claude-plans', 'wakecap-plans', 'repo-docs']);

export const PlanRefSchema = z.object({
  path: z.string(),
  title: z.string(),
  source: PlanSourceSchema,
  mtime: z.string(),
  reason: z.enum(['ticket', 'time', 'query']),
  tickets: z.array(z.string()),
});
export type PlanRef = z.infer<typeof PlanRefSchema>;

export const SessionLinksSchema = z.object({
  prs: z.array(PrRefP3),
  tickets: z.array(z.object({ id: z.string(), url: z.string().nullable() })),
  plans: z.array(PlanRefSchema),
  artifacts: z.array(z.object({ title: z.string().nullable(), url: z.string().nullable(), path: z.string().nullable() })),
  bridgeSessionId: z.string().nullable(),
});
export type SessionLinks = z.infer<typeof SessionLinksSchema>;

export const PlansQuery = z.object({
  q: z.string().default(''),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const PlanContentQuery = z.object({ path: z.string().min(1) });

export const PlanContentSchema = z.object({ path: z.string(), text: z.string() });
export type PlanContent = z.infer<typeof PlanContentSchema>;
```

`packages/api-contract/src/routes/audit.ts`
```ts
import { z } from 'zod';

export const AuditActorSchema = z.enum(['user', 'automation', 'supervisor', 'remote']);

export const AuditEntrySchema = z.object({
  id: z.string(),
  ts: z.string(),
  actor: AuditActorSchema,
  actorDetail: z.string().nullable(),
  action: z.string(),
  target: z.string().nullable(),
  params: z.record(z.string(), z.unknown()),
  result: z.enum(['ok', 'error', 'denied']),
  error: z.string().nullable(),
});

export const AuditQuery = z.object({
  sessionPk: z.string().optional(),
  action: z.string().optional(),
  actor: AuditActorSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  q: z.string().optional(),
  projectId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export type AuditQuery = z.infer<typeof AuditQuery>;
```

`packages/api-contract/src/routes/safety.ts`
```ts
import { z } from 'zod';

export const SecretFindingSchema = z.object({ line: z.number(), kind: z.string() });

export const SecretsFileReportSchema = z.object({
  path: z.string(),
  displayPath: z.string(),
  exists: z.boolean(),
  findings: z.array(SecretFindingSchema),
  error: z.string().nullable(),
});
export type SecretsFileReport = z.infer<typeof SecretsFileReportSchema>;

export const SecretsReportSchema = z.object({
  scannedAt: z.string(),
  totalFindings: z.number(),
  files: z.array(SecretsFileReportSchema),
});
export type SecretsReport = z.infer<typeof SecretsReportSchema>;

export const DenyCheckRequest = z.object({
  text: z.string().max(100_000),
  projectId: z.string().nullable().default(null),
});
export type DenyCheckRequest = z.infer<typeof DenyCheckRequest>;

export const DenyVerdictSchema = z.object({ denied: z.boolean(), reason: z.string().nullable() });
```

- [ ] **Step 4: Write the client methods**

`packages/api-contract/src/client-p3.ts`
```ts
import type { AuditEntry, DenyVerdict, Source } from '@orc/core';
import { z } from 'zod';
import { AuditEntrySchema, type AuditQuery } from './routes/audit.ts';
import { PlanContentSchema, PlanRefSchema, SessionLinksSchema } from './routes/links.ts';
import { type DenyCheckRequest, DenyVerdictSchema, SecretsReportSchema } from './routes/safety.ts';
import {
  FileSummarySchema,
  RawPageSchema,
  SessionSafetySchema,
  SessionStatsResponse,
  TurnDeliverablesSchema,
  UsagePointSchema,
} from './routes/session-detail.ts';

export interface P3ClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

/** If Phase 1 already exports an equivalent error class from client.ts, re-export that one here instead. */
export class ApiCallError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiCallError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

function qs(q: Query): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;
const base = (source: Source, id: string) => `/api/sessions/${enc(source)}/${enc(id)}`;

export function createP3Methods(o: P3ClientOptions) {
  const doFetch = o.fetch ?? fetch;

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { 'x-orc-token': o.token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await doFetch(`${o.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
      throw new ApiCallError(res.status, j?.error?.code ?? 'http_error', j?.error?.message ?? res.statusText, j?.error?.details);
    }
    return res;
  }

  async function json<S extends z.ZodType>(schema: S, method: 'GET' | 'POST', path: string, body?: unknown): Promise<z.output<S>> {
    const res = await call(method, path, body);
    return schema.parse(await res.json()) as z.output<S>;
  }

  return {
    sessionsStats: (source: Source, id: string) => json(SessionStatsResponse, 'GET', `${base(source, id)}/stats`),
    sessionsDeliverables: (source: Source, id: string) =>
      json(z.array(TurnDeliverablesSchema), 'GET', `${base(source, id)}/deliverables`),
    sessionsFiles: (source: Source, id: string) => json(z.array(FileSummarySchema), 'GET', `${base(source, id)}/files`),
    sessionsUsageSeries: (source: Source, id: string) =>
      json(z.array(UsagePointSchema), 'GET', `${base(source, id)}/usage-series`),
    sessionsSafety: (source: Source, id: string) => json(SessionSafetySchema, 'GET', `${base(source, id)}/safety`),
    sessionsLinks: (source: Source, id: string) => json(SessionLinksSchema, 'GET', `${base(source, id)}/links`),
    sessionsRaw: (source: Source, id: string, q: { agentId?: string | null; offset?: number; limit?: number }) =>
      json(RawPageSchema, 'GET', `${base(source, id)}/raw${qs({ agentId: q.agentId, offset: q.offset, limit: q.limit })}`),
    sessionsExport: async (source: Source, id: string, opts: { redact: boolean }): Promise<Blob> => {
      const query = opts.redact ? '' : qs({ redact: 'false', confirm: 'true' });
      const res = await call('GET', `${base(source, id)}/export${query}`);
      return res.blob();
    },
    plansList: (q: string, limit = 20) => json(z.array(PlanRefSchema), 'GET', `/api/plans${qs({ q, limit })}`),
    plansContent: (path: string) => json(PlanContentSchema, 'GET', `/api/plans/content${qs({ path })}`),
    auditList: (f: Partial<AuditQuery>): Promise<AuditEntry[]> =>
      json(z.array(AuditEntrySchema), 'GET', `/api/audit${qs(f)}`),
    safetySecrets: () => json(SecretsReportSchema, 'GET', '/api/safety/secrets'),
    safetyDenyCheck: (body: DenyCheckRequest): Promise<DenyVerdict> =>
      json(DenyVerdictSchema, 'POST', '/api/safety/deny-check', body),
  };
}

export type P3Methods = ReturnType<typeof createP3Methods>;
```

`packages/api-contract/src/client.ts`: inside `createApiClient({ baseUrl, token })`, spread the Phase 3 methods into the returned object:
```ts
import { createP3Methods } from './client-p3.ts';
// …inside createApiClient, at the return statement:
return {
  ...existingMethods, // the Phase 1/2 object literal, unchanged
  ...createP3Methods({ baseUrl, token }),
};
```
If Phase 1 returns an object literal directly, add `...createP3Methods({ baseUrl, token }),` as its last property.

`packages/api-contract/src/index.ts`: add
```ts
export * from './routes/session-detail.ts';
export * from './routes/links.ts';
export * from './routes/audit.ts';
export * from './routes/safety.ts';
export * from './client-p3.ts';
```

- [ ] **Step 5: Add the config fields and the WS event**

In `packages/api-contract/src/config.ts`, add two properties to the `OrcConfig` object, after `archive`:
```ts
  safety: z.object({
    extraDenyPatterns: z.array(z.string()).default([]),
    prodSkills: z.array(z.string()).default(['production_server_db', 'production_server_logs', 'wecare_production_db']),
    secretScanPaths: z.array(z.string()).default(['~/Wakecap/.mcp.json', '~/Wakecap/.claude/commands/*.md']),
  }).default({}),
  links: z.object({
    linearWorkspace: z.string().nullable().default(null),
    planRoots: z.array(z.string()).default(['~/Wakecap/plans']),
  }).default({}),
```

In `packages/api-contract/src/live.ts` (A8), add this member to the `LiveEvent` union (with `import type { AuditEntry } from '@orc/core'`):
```ts
  | { type: 'audit.recorded'; entry: AuditEntry }
```
If `live.ts` also defines a zod schema for live events, add `z.object({ type: z.literal('audit.recorded'), entry: AuditEntrySchema })` next to the others (import `AuditEntrySchema` from `./routes/audit.ts`).

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm install && pnpm vitest run packages/api-contract && pnpm typecheck`
Expected: PASS (2 + 5 + 1 new tests). Typecheck is green; the `expectTypeOf` assertions are checked by `tsc`.

- [ ] **Step 7: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add packages/api-contract
git commit -m "feat(api-contract): add phase 3 schemas, client methods, safety/links config and audit ws event"
```

---

### Task 6: Audit log table, AuditService and `audited()`

**Files:**
- Modify: `apps/daemon/src/db/schema.ts`, `apps/daemon/src/context.ts` (A2)
- Create: `apps/daemon/src/db/migrations/<generated>_audit_log.sql`, `apps/daemon/src/db/migrations/<generated>_audit_append_only.sql`
- Create: `apps/daemon/src/db/repos/audit.ts`, `apps/daemon/src/services/audit/audit.ts`, `apps/daemon/src/services/audit/redact-params.ts`
- Create: `apps/daemon/test/p3-harness.ts` (the shared HTTP test harness for Tasks 7–12)
- Test: `apps/daemon/test/audit.service.test.ts`

**Interfaces:**
- Consumes: `openDb`, `OrcDb` (§5), `createEventBus`, `EventBus` (§6), `AuditEntry`, `AuditActor`, `DenyVerdict`, `redact`, `redactDeep` (core); `createTestContext`, `indexFixtures`, `TestContext` (A3); `createApp`, `OrcApp` (A1)
- Produces (contracts §11 plus additions):
  ```ts
  export interface AuditListFilter { sessionPk?: string; action?: string; actor?: AuditActor; from?: string; to?: string; limit?: number; q?: string; projectId?: string }
  export interface AuditService { record(e: Omit<AuditEntry, 'id' | 'ts'>): AuditEntry; list(filter: AuditListFilter): AuditEntry[] }
  export class DeniedError extends Error { readonly verdict: DenyVerdict }
  export function createAuditService(opts: { db: OrcDb; bus?: EventBus; now?: () => Date }): AuditService
  export async function audited<T>(audit: AuditService, meta: Omit<AuditEntry, 'id' | 'ts' | 'result' | 'error'>, fn: () => Promise<T>): Promise<T>
  export function sessionPkOf(target: string | null, params: Record<string, unknown>): string | null
  export function redactParams(params: Record<string, unknown>): Record<string, unknown>
  // repos/audit.ts
  export function insertAudit(db: OrcDb, row: AuditEntry & { sessionPk: string | null }): void
  export function queryAudit(db: OrcDb, f: AuditListFilter): AuditEntry[]
  // DaemonContext.audit is now always set by buildContext() (so by createDaemon() and createTestContext())
  // test/p3-harness.ts
  export const P3_TOKEN: string
  export const P3_BASE: string                      // 'http://127.0.0.1:4317'
  export interface P3Harness { ctx: TestContext; app: OrcApp; request(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<Response>; cleanup(): Promise<void> }
  export function createP3Harness(opts?: Parameters<typeof createTestContext>[0]): Promise<P3Harness>
  ```

- [ ] **Step 1: Write the failing test**

`apps/daemon/test/audit.service.test.ts`
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry } from '@orc/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { createEventBus } from '../src/live/event-bus.ts';
import { DeniedError, audited, createAuditService, sessionPkOf } from '../src/services/audit/audit.ts';

let handle: ReturnType<typeof openDb>;
let clock: number;
const now = () => new Date(Date.UTC(2026, 8, 17, 10, 0, 0) + clock++ * 1000);

beforeEach(() => {
  clock = 0;
  handle = openDb(join(mkdtempSync(join(tmpdir(), 'orc-audit-')), 'index.db'));
});
afterEach(() => handle.close());

const base = { actor: 'user' as const, actorDetail: null, params: {} };

describe('AuditService', () => {
  it('records, redacts params, derives sessionPk and emits a bus event', () => {
    const bus = createEventBus();
    const seen: AuditEntry[] = [];
    bus.on('audit.recorded', (e) => seen.push(e.entry));
    const audit = createAuditService({ db: handle.db, bus, now });
    const e = audit.record({
      ...base,
      action: 'pty.input',
      target: 'claude:s-basic',
      params: { text: 'PGPASSWORD=hunter2 psql', env: { API_KEY: 'abc' }, long: 'x'.repeat(3000) },
      result: 'ok',
      error: null,
    });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.ts).toBe('2026-09-17T10:00:00.000Z');
    expect(e.params).toEqual({ text: 'PGPASSWORD=«redacted:secret» psql', env: { API_KEY: '«redacted:secret»' }, long: `${'x'.repeat(2000)}…` });
    expect(seen).toEqual([e]);
    expect(audit.list({ sessionPk: 'claude:s-basic' })).toEqual([e]);
  });

  it('filters by action (exact and area.*), actor, time and text, newest first', () => {
    const audit = createAuditService({ db: handle.db, now });
    audit.record({ ...base, action: 'session.resume', target: 'claude:a', result: 'ok', error: null });
    audit.record({ ...base, action: 'session.kill', target: 'claude:b', result: 'error', error: 'not_found: gone' });
    audit.record({ ...base, actor: 'automation', action: 'pty.input', target: 'pty:1', params: { sessionPk: 'codex:c' }, result: 'ok', error: null });
    expect(audit.list({}).map((e) => e.action)).toEqual(['pty.input', 'session.kill', 'session.resume']);
    expect(audit.list({ action: 'session.*' }).map((e) => e.action)).toEqual(['session.kill', 'session.resume']);
    expect(audit.list({ action: 'session.kill' })).toHaveLength(1);
    expect(audit.list({ actor: 'automation' })).toHaveLength(1);
    expect(audit.list({ sessionPk: 'codex:c' })).toHaveLength(1);
    expect(audit.list({ from: '2026-09-17T10:00:01.000Z', to: '2026-09-17T10:00:01.999Z' }).map((e) => e.action)).toEqual(['session.kill']);
    expect(audit.list({ q: 'gone' })).toHaveLength(1);
    expect(audit.list({ limit: 1 })).toHaveLength(1);
  });

  it('is append-only at the database level', () => {
    const audit = createAuditService({ db: handle.db, now });
    audit.record({ ...base, action: 'session.launch', target: null, result: 'ok', error: null });
    expect(() => handle.raw.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
    expect(() => handle.raw.prepare("UPDATE audit_log SET result = 'error'").run()).toThrow(/append-only/);
  });
});

describe('audited()', () => {
  it('records ok, error and denied results', async () => {
    const audit = createAuditService({ db: handle.db, now });
    const meta = { ...base, action: 'session.resume', target: 'claude:s-basic' };
    await expect(audited(audit, meta, async () => 42)).resolves.toBe(42);
    await expect(audited(audit, meta, async () => { throw new Error('spawn failed token=abc'); })).rejects.toThrow('spawn failed');
    await expect(audited(audit, meta, async () => { throw new DeniedError({ denied: true, reason: 'matches deny pattern x' }); })).rejects.toBeInstanceOf(DeniedError);
    const results = audit.list({}).map((e) => [e.result, e.error]);
    expect(results).toEqual([
      ['denied', 'matches deny pattern x'],
      ['error', 'spawn failed token=«redacted:secret»'],
      ['ok', null],
    ]);
  });
});

describe('sessionPkOf', () => {
  it.each([
    ['claude:s-basic', {}, 'claude:s-basic'],
    ['pty:abc', { sessionPk: 'codex:x' }, 'codex:x'],
    ['/Users/test/Wakecap', {}, null],
    [null, { sessionPk: 'nope' }, null],
  ] as const)('%s', (target, params, expected) => {
    expect(sessionPkOf(target, params)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/test/audit.service.test.ts`
Expected: FAIL, `Cannot find module '../src/services/audit/audit.ts'`

- [ ] **Step 3: Add the table and migrations**

Append to `apps/daemon/src/db/schema.ts` (reuse the existing `sqliteTable`/`text`/`index` imports, and add any that are missing):
```ts
import type { AuditActor, AuditEntry } from '@orc/core';

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    ts: text('ts').notNull(),
    actor: text('actor').$type<AuditActor>().notNull(),
    actorDetail: text('actor_detail'),
    action: text('action').notNull(),
    target: text('target'),
    sessionPk: text('session_pk'),
    paramsJson: text('params_json').notNull().default('{}'),
    result: text('result').$type<AuditEntry['result']>().notNull(),
    error: text('error'),
  },
  (t) => [
    index('audit_log_ts_idx').on(t.ts),
    index('audit_log_session_pk_idx').on(t.sessionPk),
    index('audit_log_action_idx').on(t.action),
  ],
);
```

Run:
```bash
pnpm --filter @orc/daemon db:generate --name audit_log
pnpm --filter @orc/daemon exec drizzle-kit generate --custom --name audit_append_only
```
Expected: two new files under `apps/daemon/src/db/migrations/`. The first contains `CREATE TABLE \`audit_log\``. The second is empty.

Put this in the generated `…_audit_append_only.sql`:
```sql
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
```

- [ ] **Step 4: Implement the repo and the service**

`apps/daemon/src/db/repos/audit.ts`
```ts
import type { AuditEntry } from '@orc/core';
import { type SQL, and, desc, eq, gte, like, lte, or, sql } from 'drizzle-orm';
import type { AuditListFilter } from '../../services/audit/audit.ts';
import type { OrcDb } from '../client.ts';
import { auditLog } from '../schema.ts';

export function insertAudit(db: OrcDb, row: AuditEntry & { sessionPk: string | null }): void {
  db.insert(auditLog)
    .values({
      id: row.id,
      ts: row.ts,
      actor: row.actor,
      actorDetail: row.actorDetail,
      action: row.action,
      target: row.target,
      sessionPk: row.sessionPk,
      paramsJson: JSON.stringify(row.params),
      result: row.result,
      error: row.error,
    })
    .run();
}

function parseParams(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function queryAudit(db: OrcDb, f: AuditListFilter): AuditEntry[] {
  const conds: SQL[] = [];
  if (f.sessionPk) conds.push(eq(auditLog.sessionPk, f.sessionPk));
  if (f.action) {
    conds.push(f.action.endsWith('.*') ? like(auditLog.action, `${f.action.slice(0, -1)}%`) : eq(auditLog.action, f.action));
  }
  if (f.actor) conds.push(eq(auditLog.actor, f.actor));
  if (f.from) conds.push(gte(auditLog.ts, f.from));
  if (f.to) conds.push(lte(auditLog.ts, f.to));
  if (f.q) {
    const pat = `%${f.q}%`;
    const text = or(like(auditLog.action, pat), like(auditLog.target, pat), like(auditLog.paramsJson, pat), like(auditLog.error, pat));
    if (text) conds.push(text);
  }
  // Assumes the Phase 1 `sessions` table has columns `pk` and `project_id` (contracts §5 naming).
  if (f.projectId) conds.push(sql`${auditLog.sessionPk} IN (SELECT pk FROM sessions WHERE project_id = ${f.projectId})`);
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 1000);
  const rows = db
    .select()
    .from(auditLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditLog.ts), sql`rowid DESC`)
    .limit(limit)
    .all();
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    actor: r.actor,
    actorDetail: r.actorDetail,
    action: r.action,
    target: r.target,
    params: parseParams(r.paramsJson),
    result: r.result,
    error: r.error,
  }));
}
```

`apps/daemon/src/services/audit/redact-params.ts`
```ts
import { redactDeep } from '@orc/core';

const MAX_STRING = 2000;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;

function clamp(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  if (Array.isArray(v)) {
    if (depth >= MAX_DEPTH) return '«truncated»';
    return v.slice(0, MAX_ARRAY).map((x) => clamp(x, depth + 1));
  }
  if (v !== null && typeof v === 'object') {
    if (depth >= MAX_DEPTH) return '«truncated»';
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, clamp(x, depth + 1)]));
  }
  return v;
}

/** Audit params are redacted (values and sensitive keys) and size-bounded before storage. */
export function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  return clamp(redactDeep(params), 0) as Record<string, unknown>;
}
```

`apps/daemon/src/services/audit/audit.ts`
```ts
import { randomUUID } from 'node:crypto';
import { type AuditActor, type AuditEntry, type DenyVerdict, redact } from '@orc/core';
import type { OrcDb } from '../../db/client.ts';
import { insertAudit, queryAudit } from '../../db/repos/audit.ts';
import type { EventBus } from '../../live/event-bus.ts';
import { redactParams } from './redact-params.ts';

export interface AuditListFilter {
  sessionPk?: string;
  action?: string;
  actor?: AuditActor;
  from?: string;
  to?: string;
  limit?: number;
  q?: string;
  projectId?: string;
}

export interface AuditService {
  record(e: Omit<AuditEntry, 'id' | 'ts'>): AuditEntry;
  list(filter: AuditListFilter): AuditEntry[];
}

export class DeniedError extends Error {
  readonly verdict: DenyVerdict;
  constructor(verdict: DenyVerdict) {
    super(verdict.reason ?? 'denied by deny-list');
    this.name = 'DeniedError';
    this.verdict = verdict;
  }
}

const PK_RE = /^(?:claude|codex|agnc):\S+$/;

export function sessionPkOf(target: string | null, params: Record<string, unknown>): string | null {
  if (target && PK_RE.test(target)) return target;
  const p = params.sessionPk;
  return typeof p === 'string' && PK_RE.test(p) ? p : null;
}

export function createAuditService(opts: { db: OrcDb; bus?: EventBus; now?: () => Date }): AuditService {
  const now = opts.now ?? (() => new Date());
  return {
    record(e) {
      const entry: AuditEntry = {
        id: randomUUID(),
        ts: now().toISOString(),
        actor: e.actor,
        actorDetail: e.actorDetail === null ? null : redact(e.actorDetail).slice(0, 200),
        action: e.action,
        target: e.target === null ? null : redact(e.target),
        params: redactParams(e.params),
        result: e.result,
        error: e.error === null ? null : redact(e.error).slice(0, 1000),
      };
      insertAudit(opts.db, { ...entry, sessionPk: sessionPkOf(entry.target, entry.params) });
      opts.bus?.emit({ type: 'audit.recorded', entry });
      return entry;
    },
    list(filter) {
      return queryAudit(opts.db, filter);
    },
  };
}

export async function audited<T>(
  audit: AuditService,
  meta: Omit<AuditEntry, 'id' | 'ts' | 'result' | 'error'>,
  fn: () => Promise<T>,
): Promise<T> {
  let value: T;
  try {
    value = await fn();
  } catch (err) {
    audit.record({
      ...meta,
      result: err instanceof DeniedError ? 'denied' : 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  audit.record({ ...meta, result: 'ok', error: null });
  return value;
}
```

- [ ] **Step 5: Wire it into the context and add the HTTP test harness**

In `apps/daemon/src/context.ts` → `buildContext()` (A2), create the service as soon as `db` and `bus` exist, and add it to the returned context:
```ts
import { createAuditService } from './services/audit/audit.ts';
// …right after db and bus are created:
const audit = createAuditService({ db, bus });
// …in the DaemonContext object literal:
audit,
```
`createDaemon()` and `createTestContext()` both call `buildContext()`, so neither needs editing. If `context.ts` declares a placeholder `AuditService` type, replace it with `import type { AuditService } from './services/audit/audit.ts';`.

`apps/daemon/test/p3-harness.ts`
```ts
import { createApp } from '../src/http/app.ts';
import type { OrcApp } from '../src/http/types.ts';
import { type TestContext, createTestContext, indexFixtures } from './helpers.ts';

export const P3_TOKEN = 'b'.repeat(64);
export const P3_BASE = 'http://127.0.0.1:4317';

export interface P3Harness {
  ctx: TestContext;
  app: OrcApp;
  request(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<Response>;
  cleanup(): Promise<void>;
}

/** Real services on indexed fixture homes plus the real Hono app (token, host checks, audit middleware). */
export async function createP3Harness(opts: Parameters<typeof createTestContext>[0] = {}): Promise<P3Harness> {
  const ctx = createTestContext(opts);
  const indexer = await indexFixtures(ctx);
  const app = createApp({ ctx, token: P3_TOKEN, port: () => 4317, env: {} });
  return {
    ctx,
    app,
    async request(path, init = {}) {
      const headers: Record<string, string> = { 'x-orc-token': P3_TOKEN, ...(init.headers ?? {}) };
      if (init.body !== undefined) headers['content-type'] = 'application/json';
      return app.request(`${P3_BASE}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    },
    async cleanup() {
      for (const p of ctx.pty.list()) if (p.exitedAt === null) ctx.pty.kill(p.id);
      await indexer.close();
      ctx.dispose();
    },
  };
}
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm vitest run apps/daemon/test/audit.service.test.ts && pnpm typecheck`
Expected: PASS (8 tests). Typecheck is green, including `p3-harness.ts`.

- [ ] **Step 7: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon
git commit -m "feat(daemon): add append-only audit log, AuditService and audited()"
```

---

### Task 7: Audit every write path (middleware + PTY input decorator), `/api/audit`, and the coverage guard

**Files:**
- Create: `apps/daemon/src/http/audit-middleware.ts`, `apps/daemon/src/pty/audited-pty.ts`, `apps/daemon/src/pty/audited-pty.test.ts`, `apps/daemon/src/http/routes/audit.ts`
- Create: `apps/daemon/test/audit.routes.test.ts`, `apps/daemon/test/audit.coverage.test.ts`
- Modify: `apps/daemon/src/http/app.ts` (A1), `apps/daemon/src/context.ts` (A2)

**Interfaces:**
- Consumes: `AuditService`, `audited`, `createP3Harness` (Task 6); `AuditQuery` (Task 5); `PtyManager` (§7 + P1 `remove`/`disposeAll`); `apiError` (Phase 0); `OrcApp` (A1); `redactDeep`, `redact` (core); the route paths in A7
- Produces:
  ```ts
  export interface AuditedRoute { method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT'; pattern: RegExp; action: string | ((body: Record<string, unknown>) => string); target: (m: RegExpExecArray, body: Record<string, unknown>) => string | null; before?: (m: RegExpExecArray, ctx: DaemonContext) => Record<string, unknown> }
  export const AUDITED_ROUTES: AuditedRoute[]
  export const NON_ACTION_ROUTES: Array<{ method: string; path: string; why: string }>
  export function matchAuditedRoute(method: string, path: string): { route: AuditedRoute; m: RegExpExecArray } | null
  export function auditMiddleware(ctx: DaemonContext): MiddlewareHandler
  export function stripControl(s: string): string
  export function withPtyInputAudit(pty: PtyManager, audit: AuditService, opts?: { idleMs?: number; actor?: AuditActor }): PtyManager & { flushAll(): void }
  export function registerAuditRoutes(app: OrcApp, ctx: DaemonContext): void   // GET /api/audit
  ```

**Retrofitted call sites.** These come from Phases 1–2. The middleware covers them by path, so their handlers are not edited.

| Action | Call site (assumed, A7) | Recorded by |
|---|---|---|
| `session.resume` | `POST /api/sessions/:source/:id/resume` with `fork` falsy → `SessionService.resume` | middleware |
| `session.fork` | the same route with `fork: true` | middleware |
| `session.launch` | `POST /api/sessions/launch` → the Phase 2 launch handler | middleware |
| `session.kill` | `POST /api/sessions/:source/:id/kill` (confirmed) and `DELETE /api/pty/:ptyId` (confirmed) | middleware |
| `archive.restore` | `POST /api/archive/restore` (confirmed) → `ArchiveService.restore` | middleware |
| `pty.input` | WS `/pty/:ptyId` `{ t:'in' }` → `ctx.pty.write`; Phase 2 inbox reply → `ctx.pty.sendText` | `withPtyInputAudit` |
| `session.open` | `POST /api/sessions/:source/:id/open-in` (P2, launches VS Code/Terminal/Finder) | middleware |
| `archive.sync` | `POST /api/archive/sync` (P2) | middleware |
| `session.export` | `GET /api/sessions/:source/:id/export` (Task 12) | middleware |

Rules:
- A `409 confirmation_required` response is **not** an action, so it is not recorded.
- `403` is recorded as `denied`. Any other status ≥ 400 is recorded as `error`.
- Keystrokes are merged into one entry per line: the buffer flushes on `\r`/`\n`, after 1.5 s of idle time, on kill, or on PTY exit. Control sequences are stripped, and the preview is redacted and capped at 500 characters.

- [ ] **Step 1: Write the failing decorator test**

`apps/daemon/src/pty/audited-pty.test.ts`
```ts
import type { AuditEntry } from '@orc/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../services/audit/audit.ts';
import { stripControl, withPtyInputAudit } from './audited-pty.ts';
import type { PtyInfo, PtyManager } from './pty-manager.ts';

function fakes() {
  const recorded: Array<Omit<AuditEntry, 'id' | 'ts'>> = [];
  const audit: AuditService = {
    record: (e) => {
      recorded.push(e);
      return { ...e, id: 'x', ts: 't' };
    },
    list: () => [],
  };
  const info = { id: 'p1', sessionPk: 'claude:s-basic' } as PtyInfo;
  const writes: string[] = [];
  const pty: PtyManager = {
    spawn: vi.fn(() => info),
    write: vi.fn((id: string, d: string) => {
      if (id === 'bad') throw new Error('not_owned');
      writes.push(d);
    }),
    sendText: vi.fn(async () => undefined),
    resize: vi.fn(),
    kill: vi.fn(),
    attach: vi.fn(() => ({ scrollback: '', detach: () => undefined })),
    list: vi.fn(() => [info]),
    get: vi.fn((id: string) => (id === 'p1' ? info : undefined)),
    remove: vi.fn(),
    disposeAll: vi.fn(),
  };
  return { recorded, audit, pty, writes };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('withPtyInputAudit', () => {
  it('coalesces keystrokes into one entry per line and passes data through', () => {
    const f = fakes();
    const p = withPtyInputAudit(f.pty, f.audit);
    for (const ch of 'yes') p.write('p1', ch);
    expect(f.recorded).toHaveLength(0);
    p.write('p1', '\r');
    expect(f.writes.join('')).toBe('yes\r');
    expect(f.recorded).toEqual([
      {
        actor: 'user',
        actorDetail: null,
        action: 'pty.input',
        target: 'claude:s-basic',
        params: { via: 'keys', ptyId: 'p1', bytes: 4, text: 'yes' },
        result: 'ok',
        error: null,
      },
    ]);
  });

  it('flushes after idle time and on kill, and redacts', () => {
    const f = fakes();
    const p = withPtyInputAudit(f.pty, f.audit, { idleMs: 1000 });
    p.write('p1', 'token=abc');
    vi.advanceTimersByTime(999);
    expect(f.recorded).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(f.recorded[0]?.params.text).toBe('token=«redacted:secret»');
    p.write('p1', 'ab');
    p.kill('p1');
    expect(f.recorded).toHaveLength(2);
    expect(f.pty.kill).toHaveBeenCalledWith('p1', undefined);
  });

  it('records failed writes as errors and rethrows', () => {
    const f = fakes();
    const p = withPtyInputAudit(f.pty, f.audit);
    expect(() => p.write('bad', 'x')).toThrow('not_owned');
    expect(f.recorded[0]).toMatchObject({ target: 'pty:bad', result: 'error', error: 'not_owned' });
  });

  it('audits sendText via audited()', async () => {
    const f = fakes();
    const p = withPtyInputAudit(f.pty, f.audit);
    await p.sendText('p1', 'approve the plan');
    expect(f.pty.sendText).toHaveBeenCalledWith('p1', 'approve the plan');
    expect(f.recorded[0]).toMatchObject({ action: 'pty.input', params: { via: 'paste', text: 'approve the plan' }, result: 'ok' });
  });
});

describe('stripControl', () => {
  it('removes escape sequences and applies backspace', () => {
    const ESC = String.fromCharCode(27);
    expect(stripControl(`${ESC}[200~hi${ESC}[201~`)).toBe('hi');
    expect(stripControl(`ab${String.fromCharCode(127)}c${ESC}[A`)).toBe('ac');
    expect(stripControl('a\rb')).toBe('a\nb');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/pty/audited-pty.test.ts`
Expected: FAIL, `Cannot find module './audited-pty.ts'`

- [ ] **Step 3: Implement the decorator**

`apps/daemon/src/pty/audited-pty.ts`
```ts
import { type AuditActor, redact } from '@orc/core';
import { type AuditService, audited } from '../services/audit/audit.ts';
import type { PtyManager } from './pty-manager.ts';

const PREVIEW = 500;

/** Removes ANSI escape sequences and control chars; applies backspace/delete; maps CR/LF to newline. */
export function stripControl(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 27) {
      if (s[i + 1] === '[') {
        i += 2;
        while (i < s.length) {
          const c = s.charCodeAt(i);
          if (c >= 0x40 && c <= 0x7e) break;
          i++;
        }
      } else {
        i += 1;
      }
      continue;
    }
    if (code === 127 || code === 8) {
      out = out.slice(0, -1);
      continue;
    }
    if (code === 13 || code === 10) {
      out += '\n';
      continue;
    }
    if (code < 32 && code !== 9) continue;
    out += s[i];
  }
  return out;
}

export function withPtyInputAudit(
  pty: PtyManager,
  audit: AuditService,
  opts: { idleMs?: number; actor?: AuditActor } = {},
): PtyManager & { flushAll(): void } {
  const idleMs = opts.idleMs ?? 1500;
  const actor = opts.actor ?? 'user';
  const buffers = new Map<string, { raw: string; timer: ReturnType<typeof setTimeout> | null }>();
  const targetOf = (id: string) => pty.get(id)?.sessionPk ?? `pty:${id}`;

  const flush = (id: string) => {
    const b = buffers.get(id);
    if (!b) return;
    if (b.timer) clearTimeout(b.timer);
    buffers.delete(id);
    const text = stripControl(b.raw).trimEnd();
    audit.record({
      actor,
      actorDetail: null,
      action: 'pty.input',
      target: targetOf(id),
      params: { via: 'keys', ptyId: id, bytes: b.raw.length, text: redact(text).slice(0, PREVIEW) },
      result: 'ok',
      error: null,
    });
  };

  return {
    spawn: (o) => pty.spawn(o),
    write(id, data) {
      try {
        pty.write(id, data);
      } catch (err) {
        flush(id);
        audit.record({
          actor,
          actorDetail: null,
          action: 'pty.input',
          target: targetOf(id),
          params: { via: 'keys', ptyId: id, bytes: data.length },
          result: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      const b = buffers.get(id) ?? { raw: '', timer: null };
      b.raw += data;
      buffers.set(id, b);
      if (/[\r\n]/.test(data)) {
        flush(id);
        return;
      }
      if (b.timer) clearTimeout(b.timer);
      b.timer = setTimeout(() => flush(id), idleMs);
      b.timer.unref?.();
    },
    sendText(id, text) {
      return audited(
        audit,
        {
          actor,
          actorDetail: null,
          action: 'pty.input',
          target: targetOf(id),
          params: { via: 'paste', ptyId: id, bytes: text.length, text: redact(text).slice(0, PREVIEW) },
        },
        () => pty.sendText(id, text),
      );
    },
    resize: (id, cols, rows) => pty.resize(id, cols, rows),
    kill(id, signal) {
      flush(id);
      pty.kill(id, signal);
    },
    attach: (id, onData) => pty.attach(id, onData),
    list: () => pty.list(),
    get: (id) => pty.get(id),
    remove(id) {
      flush(id);
      pty.remove(id);
    },
    disposeAll() {
      for (const id of [...buffers.keys()]) flush(id);
      pty.disposeAll();
    },
    flushAll() {
      for (const id of [...buffers.keys()]) flush(id);
    },
  };
}
```

Run: `pnpm vitest run apps/daemon/src/pty/audited-pty.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 4: Write the failing route and coverage tests**

`apps/daemon/test/audit.routes.test.ts`
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { P3_BASE, type P3Harness, createP3Harness } from './p3-harness.ts';

let t: P3Harness;

beforeEach(async () => {
  t = await createP3Harness();
});
afterEach(async () => {
  await t.cleanup();
});

const send = (method: 'POST' | 'DELETE', path: string, body: unknown) => t.request(path, { method, body });
const entries = (action: string) => t.ctx.audit?.list({ action }) ?? [];

async function resumeBasic(fork = false): Promise<string> {
  const res = await send('POST', '/api/sessions/claude/s-basic/resume', { mode: 'embedded', fork });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ptyId: string };
  return body.ptyId;
}

describe('write paths are audited', () => {
  it('session.resume records target, params and the new ptyId', async () => {
    const ptyId = await resumeBasic();
    const [e] = entries('session.resume');
    expect(e).toMatchObject({
      actor: 'user',
      target: 'claude:s-basic',
      result: 'ok',
      error: null,
      params: { mode: 'embedded', fork: false, status: 200, ptyId },
    });
    expect(entries('session.fork')).toHaveLength(0);
  });

  it('session.fork is a separate action', async () => {
    await resumeBasic(true);
    expect(entries('session.fork')).toHaveLength(1);
    expect(entries('session.resume')).toHaveLength(0);
  });

  it('session.launch records the cwd as target', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orc-launch-'));
    const res = await send('POST', '/api/sessions/launch', { source: 'claude', projectId: null, cwd, prompt: 'hello' });
    const [e] = entries('session.launch');
    expect(e?.target).toBe(cwd);
    expect(e?.result).toBe(res.status < 400 ? 'ok' : 'error');
    expect(e?.params.prompt).toBe('hello');
  });

  it('session.kill: unconfirmed requests are not recorded, confirmed ones are', async () => {
    const unconfirmed = await send('POST', '/api/sessions/claude/s-basic/kill', {});
    expect(unconfirmed.status).toBe(409);
    expect(entries('session.kill')).toHaveLength(0);
    const confirmed = await send('POST', '/api/sessions/claude/s-basic/kill', { confirm: true });
    const [e] = entries('session.kill');
    expect(e?.target).toBe('claude:s-basic');
    expect(e?.result).toBe(confirmed.status < 400 ? 'ok' : confirmed.status === 403 ? 'denied' : 'error');
    expect(e?.params).not.toHaveProperty('confirm');
  });

  it('DELETE /api/pty/:id is a session.kill linked to the session', async () => {
    const ptyId = await resumeBasic();
    const res = await send('DELETE', `/api/pty/${ptyId}`, { confirm: true });
    expect(res.status).toBeLessThan(400);
    const killed = t.ctx.audit?.list({ sessionPk: 'claude:s-basic', action: 'session.kill' }) ?? [];
    expect(killed).toHaveLength(1);
    expect(killed[0]?.target).toBe(`pty:${ptyId}`);
  });

  it('archive.restore is recorded (not archived → error entry)', async () => {
    const res = await send('POST', '/api/archive/restore', { source: 'claude', id: 's-basic', confirm: true });
    const [e] = entries('archive.restore');
    expect(e?.target).toBe('claude:s-basic');
    expect(e?.result).toBe(res.status < 400 ? 'ok' : 'error');
  });

  it('pty.input is recorded for owned sessions', async () => {
    const ptyId = await resumeBasic();
    t.ctx.pty.write(ptyId, 'yes\r');
    expect(entries('pty.input')[0]).toMatchObject({ target: 'claude:s-basic', params: { text: 'yes', via: 'keys' } });
  });
});

describe('GET /api/audit', () => {
  it('filters by session and validates the query', async () => {
    await resumeBasic();
    const ok = await t.request('/api/audit?sessionPk=claude%3As-basic&limit=10');
    expect(ok.status).toBe(200);
    const items = (await ok.json()) as Array<{ action: string }>;
    expect(items.map((i) => i.action)).toEqual(['session.resume']);
    expect((await t.request('/api/audit?actor=hacker')).status).toBe(400);
    expect((await t.app.request(`${P3_BASE}/api/audit`)).status).toBe(401);
  });
});
```

`apps/daemon/test/audit.coverage.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { AUDITED_ROUTES, NON_ACTION_ROUTES, matchAuditedRoute } from '../src/http/audit-middleware.ts';
import { createP3Harness } from './p3-harness.ts';

const samplePath = (p: string) =>
  p.replace(/:([A-Za-z]+)(?:\{[^}]*\})?/g, (_m, name: string) => (name === 'source' ? 'claude' : 'x'));

describe('audit coverage (M3 exit: every app action appears in the audit log)', () => {
  it('every non-GET /api route is audited or explicitly exempt', async () => {
    const t = await createP3Harness();
    try {
      const missing = t.app.routes
        .filter((r) => r.path.startsWith('/api/') && !['ALL', 'GET', 'HEAD', 'OPTIONS'].includes(r.method))
        .filter(
          (r) =>
            !matchAuditedRoute(r.method, samplePath(r.path)) &&
            !NON_ACTION_ROUTES.some((n) => n.method === r.method && n.path === r.path),
        )
        .map((r) => `${r.method} ${r.path}`);
      expect([...new Set(missing)]).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });

  it('uses <area>.<verb> action names', () => {
    for (const r of AUDITED_ROUTES) {
      const name = typeof r.action === 'string' ? r.action : r.action({});
      expect(name).toMatch(/^[a-z]+\.[a-z]+$/);
    }
  });
});
```

Run: `pnpm vitest run apps/daemon/test/audit.routes.test.ts apps/daemon/test/audit.coverage.test.ts`
Expected: FAIL, `Cannot find module '../src/http/audit-middleware.ts'`

- [ ] **Step 5: Implement the middleware and the route**

`apps/daemon/src/http/audit-middleware.ts`
```ts
import type { AuditActor } from '@orc/core';
import type { Context, MiddlewareHandler } from 'hono';
import type { DaemonContext } from '../context.ts';

export interface AuditedRoute {
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT';
  pattern: RegExp;
  action: string | ((body: Record<string, unknown>) => string);
  target: (m: RegExpExecArray, body: Record<string, unknown>) => string | null;
  /** Runs before the handler (e.g. to capture state the handler destroys). */
  before?: (m: RegExpExecArray, ctx: DaemonContext) => Record<string, unknown>;
}

const SRC = '(claude|codex|agnc)';
const dec = (s: string | undefined) => decodeURIComponent(s ?? '');
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sessionTarget = (m: RegExpExecArray) => `${m[1]}:${dec(m[2])}`;

export const AUDITED_ROUTES: AuditedRoute[] = [
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SRC}/([^/]+)/resume$`),
    action: (b) => (b.fork === true ? 'session.fork' : 'session.resume'),
    target: sessionTarget,
  },
  {
    method: 'POST',
    pattern: /^\/api\/sessions\/launch$/,
    action: 'session.launch',
    target: (_m, b) => str(b.cwd),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SRC}/([^/]+)/kill$`),
    action: 'session.kill',
    target: sessionTarget,
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/pty\/([^/]+)$/,
    action: 'session.kill',
    target: (m) => `pty:${dec(m[1])}`,
    before: (m, ctx) => ({ sessionPk: ctx.pty.get(dec(m[1]))?.sessionPk ?? null }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/archive\/restore$/,
    action: 'archive.restore',
    target: (_m, b) => {
      const source = str(b.source);
      const id = str(b.id);
      return source && id ? `${source}:${id}` : null;
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/sessions/${SRC}/([^/]+)/open-in$`),
    action: 'session.open',
    target: sessionTarget,
  },
  {
    method: 'POST',
    pattern: /^\/api\/archive\/sync$/,
    action: 'archive.sync',
    target: () => null,
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sessions/${SRC}/([^/]+)/export$`),
    action: 'session.export',
    target: sessionTarget,
  },
];

/** Write routes that are local UI/config state, not actions on sessions or external systems. Every entry needs a reason. */
export const NON_ACTION_ROUTES: Array<{ method: string; path: string; why: string }> = [
  { method: 'PATCH', path: '/api/projects/:id', why: 'local app configuration' },
  { method: 'POST', path: '/api/sessions/:source/:id/pin', why: 'local UI state' },
  { method: 'POST', path: '/api/sessions/:source/:id/label', why: 'local UI state' },
  { method: 'POST', path: '/api/views', why: 'local UI state (saved views)' },
  { method: 'DELETE', path: '/api/views/:id', why: 'local UI state (saved views)' },
  { method: 'POST', path: '/api/inbox/:id/:action{done|snooze|reopen}', why: 'local triage state' },
  { method: 'PUT', path: '/api/config/notifications', why: 'local app configuration' },
  { method: 'POST', path: '/api/hooks', why: 'inbound events from Claude hooks, not an app action' },
  { method: 'POST', path: '/api/safety/deny-check', why: 'read-only evaluation' },
];

export function matchAuditedRoute(method: string, path: string): { route: AuditedRoute; m: RegExpExecArray } | null {
  for (const route of AUDITED_ROUTES) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(path);
    if (m) return { route, m };
  }
  return null;
}

function actorOf(c: Context): AuditActor {
  // Phase 6 sets this header server-side for remote requests; automations/supervisor record through audited() directly.
  const h = c.req.header('x-orc-actor');
  return h === 'automation' || h === 'supervisor' || h === 'remote' ? h : 'user';
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  if (!(c.req.header('content-type') ?? '').includes('application/json')) return {};
  try {
    // Hono caches the parsed body, so the handler can still call c.req.json().
    const v: unknown = await c.req.json();
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

export function auditMiddleware(ctx: DaemonContext): MiddlewareHandler {
  return async (c, next) => {
    const hit = matchAuditedRoute(c.req.method, c.req.path);
    if (!hit) {
      await next();
      return;
    }
    const audit = ctx.audit;
    if (!audit) throw new Error('audit service missing from DaemonContext');
    const body = await readJsonBody(c);
    const before = hit.route.before?.(hit.m, ctx) ?? {};

    await next();

    const res = c.res;
    const parsed: unknown = (res.headers.get('content-type') ?? '').includes('application/json')
      ? await res.clone().json().catch(() => null)
      : null;
    const obj = isObj(parsed) ? parsed : null;
    const err = obj && isObj(obj.error) ? obj.error : null;
    const code = err ? str(err.code) : null;
    if (res.status === 409 && code === 'confirmation_required') return;

    const { confirm: _confirm, ...rest } = body;
    const result = res.status < 400 ? 'ok' : res.status === 403 ? 'denied' : 'error';
    const outcome: Record<string, unknown> = {};
    if (result === 'ok' && obj) {
      for (const k of ['ptyId', 'sessionId', 'launched']) if (k in obj) outcome[k] = obj[k];
    }
    const message = err ? (str(err.message) ?? '') : '';
    audit.record({
      actor: actorOf(c),
      actorDetail: c.req.header('user-agent')?.slice(0, 120) ?? null,
      action: typeof hit.route.action === 'string' ? hit.route.action : hit.route.action(body),
      target: hit.route.target(hit.m, body),
      params: { ...rest, ...c.req.query(), ...before, ...outcome, status: res.status },
      result,
      error: result === 'ok' ? null : `${code ?? `http_${res.status}`}: ${message}`.trim(),
    });
  };
}
```

`apps/daemon/src/http/routes/audit.ts`
```ts
import { AuditQuery, apiError } from '@orc/api-contract';
import { redactDeep } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import type { OrcApp } from '../types.ts';

export function registerAuditRoutes(app: OrcApp, ctx: DaemonContext): void {
  app.get('/api/audit', (c) => {
    const parsed = AuditQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json(apiError('validation_failed', 'invalid audit query', parsed.error.issues), 400);
    if (!ctx.audit) return c.json(apiError('unavailable', 'audit service missing'), 503);
    return c.json(redactDeep(ctx.audit.list(parsed.data)));
  });
}
```

- [ ] **Step 6: Wire everything**

`apps/daemon/src/http/app.ts` → `createApp(o)` (A1). Add the middleware **directly after** the existing token middleware (`app.use('/api/*', …)`), and the route registration **before** the `app.all('/api/*', …)` catch-all:
```ts
import { auditMiddleware } from './audit-middleware.ts';
import { registerAuditRoutes } from './routes/audit.ts';
// after the token/host/origin middleware:
app.use('/api/*', auditMiddleware(o.ctx));
// with the other register calls:
registerAuditRoutes(app, o.ctx);
```

`apps/daemon/src/context.ts` → `buildContext()` (A2). Wrap the PTY manager with the `audit` created in Task 6, and use the wrapped manager everywhere P1 used the raw one (the session service, the WS handler and the context field):
```ts
import { withPtyInputAudit } from './pty/audited-pty.ts';
// replace: const pty = createPtyManager({ bus });
const pty = withPtyInputAudit(createPtyManager({ bus }), audit);
bus.on('pty.exited', () => pty.flushAll());
```
Keep whatever options P1 passes to `createPtyManager`.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon`
Expected: PASS. If the coverage test lists routes that Phases 1–2 added under other paths (for example `POST /api/inbox/:id/:action`, or an inbox reply route), classify each one:
- Add it to `AUDITED_ROUTES` if it acts on a session, git or an external system (a reply that writes to a PTY is already audited by the decorator, so exempt the route with `why: 'input audited by withPtyInputAudit'`).
- Otherwise add it to `NON_ACTION_ROUTES` with a reason.

Re-run until the test is green, and list the classification in the review note.

- [ ] **Step 8: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon
git commit -m "feat(daemon): audit all write routes and PTY input, add /api/audit and coverage guard"
```

---

### Task 8: DenyList service, secrets-hygiene scanner and safety routes

**Files:**
- Create: `apps/daemon/src/services/safety/deny-list.ts`, `apps/daemon/src/services/safety/secrets-scan.ts`, `apps/daemon/src/http/routes/safety.ts`
- Test: `apps/daemon/test/safety.test.ts`
- Modify: `apps/daemon/src/context.ts` (A2), `apps/daemon/src/http/app.ts` (A1)

**Interfaces:**
- Consumes: `checkDenied`, `DEFAULT_DENY_PATTERNS`, `scanTextForSecrets` (Tasks 1–2). `OrcConfig.safety`, `SecretsReport`, `SecretsFileReport`, `DenyCheckRequest` (Task 5). `ProjectService.get` (§11); `createP3Harness` (Task 6); `OrcApp` (A1)
- Produces:
  ```ts
  export function createDenyList(deps: { config: () => OrcConfig; projects: Pick<ProjectService, 'get'> }): DenyList
  export function isForbiddenPath(p: string): boolean
  export function expandHome(p: string, home: string): string
  export function expandScanPaths(patterns: readonly string[], home: string): Promise<string[]>
  export interface SecretsScanner { scan(): Promise<SecretsReport> }
  export function createSecretsScanner(deps: { config: () => OrcConfig; home?: string; maxBytes?: number; now?: () => Date }): SecretsScanner
  export function registerSafetyRoutes(app: OrcApp, ctx: DaemonContext, opts?: { home?: string }): void   // GET /api/safety/secrets, POST /api/safety/deny-check
  // DaemonContext.denyList is now always set
  ```

The scanner is **read-only**. It uses `stat` + `readFile(…, { flag: 'r' })` + `readdir` only. It refuses `*.key`, `~/.codex/auth.json` and `~/.claude.json`, skips files over 1 MB, and returns only `{ line, kind }`.

- [ ] **Step 1: Write the failing test**

`apps/daemon/test/safety.test.ts`
```ts
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { OrcConfig } from '@orc/api-contract';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerSafetyRoutes } from '../src/http/routes/safety.ts';
import { createDenyList } from '../src/services/safety/deny-list.ts';
import { createSecretsScanner, expandScanPaths, isForbiddenPath } from '../src/services/safety/secrets-scan.ts';
import { type P3Harness, createP3Harness } from './p3-harness.ts';

const pat = `gh${'p_'}${'c'.repeat(36)}`;
const pw = `hunt${'er2'}`;

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'orc-home-'));
  mkdirSync(join(home, 'Wakecap/.claude/commands'), { recursive: true });
  writeFileSync(
    join(home, 'Wakecap/.mcp.json'),
    `{\n  "mcpServers": {\n    "github": { "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${pat}" } }\n  }\n}\n`,
  );
  writeFileSync(join(home, 'Wakecap/.claude/commands/db.md'), `Connect with\nPGPASSWORD=${pw} psql\n`);
  writeFileSync(join(home, 'Wakecap/.claude/commands/clean.md'), '# clean\nnothing here\n');
  writeFileSync(join(home, 'Wakecap/.claude/commands/notes.txt'), `PGPASSWORD=${pw}\n`);
  return home;
}

const scanPaths = ['~/Wakecap/.mcp.json', '~/Wakecap/.claude/commands/*.md', '~/missing.json', '~/.codex/auth.json'];

describe('createDenyList', () => {
  it('merges defaults, config extras and project prodPatterns', () => {
    const cfg = OrcConfig.parse({
      safety: { extraDenyPatterns: ['make\\s+release'] },
      projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: ['/x'], prodPatterns: ['wecare-prod'] }],
    });
    const dl = createDenyList({ config: () => cfg, projects: { get: (id) => cfg.projects.find((p) => p.id === id) ?? null } });
    expect(dl.check('rm -rf /', null).denied).toBe(true);
    expect(dl.check('make release', null).denied).toBe(true);
    expect(dl.check('ssh wecare-prod', 'wakecap').denied).toBe(true);
    expect(dl.check('ssh wecare-prod', null).denied).toBe(false);
    expect(dl.check('ssh wecare-prod', 'other').denied).toBe(false);
  });
});

describe('secrets scanner', () => {
  let home: string;
  beforeEach(() => {
    home = makeHome();
  });

  it('expands ~ and *.md globs in pattern order', async () => {
    const paths = await expandScanPaths(scanPaths, home);
    expect(paths).toEqual([
      join(home, 'Wakecap/.mcp.json'),
      join(home, 'Wakecap/.claude/commands/clean.md'),
      join(home, 'Wakecap/.claude/commands/db.md'),
      join(home, 'missing.json'),
      join(home, '.codex/auth.json'),
    ]);
  });

  it('reports file, kind and line only, never values, and never writes', async () => {
    const mcp = join(home, 'Wakecap/.mcp.json');
    const before = statSync(mcp).mtimeMs;
    const cfg = OrcConfig.parse({ safety: { secretScanPaths: scanPaths } });
    const report = await createSecretsScanner({ config: () => cfg, home, now: () => new Date('2026-09-17T00:00:00Z') }).scan();
    expect(report.scannedAt).toBe('2026-09-17T00:00:00.000Z');
    expect(report.files.map((f) => [f.displayPath, f.exists, f.findings, f.error])).toEqual([
      ['~/Wakecap/.mcp.json', true, [{ line: 3, kind: 'github' }, { line: 3, kind: 'json-secret-field' }], null],
      ['~/Wakecap/.claude/commands/clean.md', true, [], null],
      ['~/Wakecap/.claude/commands/db.md', true, [{ line: 2, kind: 'secret' }], null],
      ['~/missing.json', false, [], null],
      ['~/.codex/auth.json', false, [], 'forbidden'],
    ]);
    expect(report.totalFindings).toBe(3);
    const json = JSON.stringify(report);
    expect(json).not.toContain(pat);
    expect(json).not.toContain(pw);
    expect(statSync(mcp).mtimeMs).toBe(before);
  });

  it('skips files that are too large', async () => {
    writeFileSync(join(home, 'big.json'), 'x'.repeat(2048));
    const cfg = OrcConfig.parse({ safety: { secretScanPaths: ['~/big.json'] } });
    const report = await createSecretsScanner({ config: () => cfg, home, maxBytes: 1024 }).scan();
    expect(report.files[0]?.error).toBe('too_large');
  });

  it.each([
    ['/Users/x/.claude/sessions/1.abc.key', true],
    ['/Users/x/.codex/auth.json', true],
    ['/Users/x/.claude.json', true],
    ['/Users/x/Wakecap/.mcp.json', false],
  ])('isForbiddenPath(%s) = %s', (p, expected) => {
    expect(isForbiddenPath(p)).toBe(expected);
  });
});

describe('safety routes', () => {
  let t: P3Harness;
  beforeEach(async () => {
    t = await createP3Harness();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('GET /api/safety/secrets returns the report', async () => {
    const home = makeHome();
    const cfg = OrcConfig.parse({ safety: { secretScanPaths: ['~/Wakecap/.mcp.json'] } });
    const app = new Hono<{ Bindings: HttpBindings }>();
    registerSafetyRoutes(app, { ...t.ctx, config: () => cfg }, { home });
    const res = await app.request('/api/safety/secrets');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"kind":"github"');
    expect(text).not.toContain(pat);
  });

  it('POST /api/safety/deny-check evaluates through the context deny-list', async () => {
    const post = (body: unknown) => t.request('/api/safety/deny-check', { method: 'POST', body });
    const denied = await post({ text: 'git push --force', projectId: null });
    expect(await denied.json()).toMatchObject({ denied: true });
    const allowed = await post({ text: 'git status' });
    expect(await allowed.json()).toEqual({ denied: false, reason: null });
    expect((await post({ nope: 1 })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/test/safety.test.ts`
Expected: FAIL, `Cannot find module '../src/http/routes/safety.ts'`

- [ ] **Step 3: Implement**

`apps/daemon/src/services/safety/deny-list.ts`
```ts
import type { OrcConfig } from '@orc/api-contract';
import { DEFAULT_DENY_PATTERNS, type DenyVerdict, checkDenied } from '@orc/core';
import type { ProjectService } from '../projects.ts';

export interface DenyList {
  check(text: string, projectId: string | null): DenyVerdict;
}

export function createDenyList(deps: { config: () => OrcConfig; projects: Pick<ProjectService, 'get'> }): DenyList {
  return {
    check(text, projectId) {
      const project = projectId ? deps.projects.get(projectId) : null;
      return checkDenied(text, [
        ...DEFAULT_DENY_PATTERNS,
        ...deps.config().safety.extraDenyPatterns,
        ...(project?.prodPatterns ?? []),
      ]);
    },
  };
}
```
If `apps/daemon/src/context.ts` declares its own `DenyList`, delete that declaration and import this one. Keep one definition only.

`apps/daemon/src/services/safety/secrets-scan.ts`
```ts
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { OrcConfig, SecretsFileReport, SecretsReport } from '@orc/api-contract';
import { scanTextForSecrets } from '@orc/core';

const FORBIDDEN: ReadonlyArray<RegExp> = [/\.key$/i, /[\\/]\.codex[\\/]auth\.json$/, /[\\/]\.claude\.json$/];

export function isForbiddenPath(p: string): boolean {
  return FORBIDDEN.some((re) => re.test(p));
}

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

const globToRegex = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);

/** Supports `~` and wildcards in the last path segment only (e.g. `~/Wakecap/.claude/commands/*.md`). */
export async function expandScanPaths(patterns: readonly string[], home: string): Promise<string[]> {
  const out = new Set<string>();
  for (const raw of patterns) {
    const p = resolve(expandHome(raw, home));
    const name = basename(p);
    if (!name.includes('*') && !name.includes('?')) {
      out.add(p);
      continue;
    }
    const dir = dirname(p);
    const re = globToRegex(name);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const n of [...names].sort()) if (re.test(n)) out.add(join(dir, n));
  }
  return [...out];
}

export interface SecretsScanner {
  scan(): Promise<SecretsReport>;
}

export function createSecretsScanner(deps: {
  config: () => OrcConfig;
  home?: string;
  maxBytes?: number;
  now?: () => Date;
}): SecretsScanner {
  return {
    async scan() {
      const home = deps.home ?? homedir();
      const maxBytes = deps.maxBytes ?? 1024 * 1024;
      const paths = await expandScanPaths(deps.config().safety.secretScanPaths, home);
      const files: SecretsFileReport[] = [];
      for (const path of paths) {
        const displayPath = path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
        const base = { path, displayPath };
        if (isForbiddenPath(path)) {
          files.push({ ...base, exists: false, findings: [], error: 'forbidden' });
          continue;
        }
        const st = await stat(path).catch(() => null);
        if (!st) {
          files.push({ ...base, exists: false, findings: [], error: null });
          continue;
        }
        const real = await realpath(path).catch(() => path);
        if (isForbiddenPath(real)) {
          files.push({ ...base, exists: true, findings: [], error: 'forbidden' });
          continue;
        }
        if (!st.isFile()) {
          files.push({ ...base, exists: true, findings: [], error: 'not_a_file' });
          continue;
        }
        if (st.size > maxBytes) {
          files.push({ ...base, exists: true, findings: [], error: 'too_large' });
          continue;
        }
        try {
          const text = await readFile(path, { encoding: 'utf8', flag: 'r' });
          files.push({ ...base, exists: true, findings: scanTextForSecrets(text), error: null });
        } catch (err) {
          files.push({ ...base, exists: true, findings: [], error: (err as NodeJS.ErrnoException).code ?? 'read_failed' });
        }
      }
      return {
        scannedAt: (deps.now?.() ?? new Date()).toISOString(),
        totalFindings: files.reduce((n, f) => n + f.findings.length, 0),
        files,
      };
    },
  };
}
```

`apps/daemon/src/http/routes/safety.ts`
```ts
import { DenyCheckRequest, apiError } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { createSecretsScanner } from '../../services/safety/secrets-scan.ts';
import type { OrcApp } from '../types.ts';

export function registerSafetyRoutes(app: OrcApp, ctx: DaemonContext, opts: { home?: string } = {}): void {
  const scanner = createSecretsScanner({ config: ctx.config, home: opts.home });

  app.get('/api/safety/secrets', async (c) => c.json(await scanner.scan()));

  app.post('/api/safety/deny-check', async (c) => {
    const parsed = DenyCheckRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(apiError('validation_failed', 'invalid deny-check body', parsed.error.issues), 400);
    if (!ctx.denyList) return c.json(apiError('unavailable', 'deny-list missing'), 503);
    return c.json(ctx.denyList.check(parsed.data.text, parsed.data.projectId));
  });
}
```

- [ ] **Step 4: Wire it**

`apps/daemon/src/context.ts` → `buildContext()` (A2), in the context literal:
```ts
import { createDenyList } from './services/safety/deny-list.ts';
// …
denyList: createDenyList({ config, projects }),
```
(`config` is the live getter and `projects` is the `ProjectServiceImpl` already built there.)

`apps/daemon/src/http/app.ts` → `createApp(o)` (A1), before the `/api/*` catch-all:
```ts
import { registerSafetyRoutes } from './routes/safety.ts';
registerSafetyRoutes(app, o.ctx);
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/test/safety.test.ts apps/daemon/test/audit.coverage.test.ts`
Expected: PASS (10 + 2 tests). The coverage test stays green because `POST /api/safety/deny-check` is listed in `NON_ACTION_ROUTES`.

- [ ] **Step 6: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon
git commit -m "feat(daemon): add shared DenyList, read-only secrets hygiene scanner and safety routes"
```

---

### Task 9: Session detail service and routes (stats, deliverables, files, usage series, safety, raw)

**Files:**
- Create: `apps/daemon/src/services/session-detail/collect.ts`, `apps/daemon/src/services/session-detail/detail.ts`, `apps/daemon/src/services/session-detail/raw.ts`, `apps/daemon/src/services/session-detail/raw.test.ts`
- Create: `apps/daemon/src/http/redacted-json.ts`, `apps/daemon/src/http/routes/session-detail.ts`
- Test: `apps/daemon/test/session-detail.routes.test.ts`
- Modify: `apps/daemon/src/http/app.ts` (A1)

**Interfaces:**
- Consumes: `SessionService.get/agents/events` (§11, A4: `events(…, { agentId: null })` returns main-session events only, and `nextSeq` is passed back as `afterSeq`). `ProjectService.get`. `computeTurnStats`, `computeSessionStats`, `deliverablesByTurn`, `extractFileChanges`, `summarizeFiles`, `detectProdTouches`, `permissionBadge`, `redact`, `redactDeep` (core); `createP3Harness` (Task 6); `OrcApp` (A1). `SourceParam`, `RawQuery`, `SessionStatsResponse`, `UsagePoint`, `SessionSafety`, `RawPage`, `RawLine` (Task 5)
- Produces:
  ```ts
  export function collectEvents(sessions: Pick<SessionService, 'events'>, source: Source, id: string, agentId: string | null): TimelineEvent[]
  export interface SessionEventsBundle { session: Session; main: TimelineEvent[]; agents: Array<{ agentId: string; events: TimelineEvent[] }> }
  export interface SessionDetailService {
    bundle(source: Source, id: string): SessionEventsBundle | null;
    stats(source: Source, id: string): SessionStatsResponse | null;
    deliverables(source: Source, id: string): TurnDeliverables[] | null;
    files(source: Source, id: string): FileSummary[] | null;
    usageSeries(source: Source, id: string): UsagePoint[] | null;
    safety(source: Source, id: string): SessionSafety | null;
  }
  export function createSessionDetailService(ctx: Pick<DaemonContext, 'sessions' | 'projects' | 'config'>): SessionDetailService
  export function costWeight(p: Pick<UsagePoint, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): number   // input + 5·output + 1.25·cacheWrite + 0.1·cacheRead
  export function apportionCost(points: UsagePoint[], totalUsd: number | null): UsagePoint[]
  export function readJsonlPage(path: string, offset: number, limit: number, opts?: { maxLineChars?: number; windowBytes?: number }): Promise<RawPage>
  export function redactedJson(c: Context, body: unknown, status?: ContentfulStatusCode): Response
  export function sessionParams(c: Context): { source: Source; id: string } | null
  export function registerSessionDetailRoutes(app: OrcApp, ctx: DaemonContext, svc?: SessionDetailService): void
  ```

**Cost per usage point.** Phase 1 events carry no per-message cost (A4); the authoritative cost is the session's `cost-state` total. The usage series therefore **apportions** `session.usage.costUsd` across points by token weight, using the relative Anthropic price ratios: input 1, output 5, cache write 1.25, cache read 0.1. The UI labels the result "apportioned". If the session has no cost, every `costUsd` is `null`, and the Usage tab shows tokens only. Phase 5's usage meter can later replace this with priced per-message cost.

- [ ] **Step 1: Write the failing raw-reader test**

`apps/daemon/src/services/session-detail/raw.test.ts`
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJsonlPage } from './raw.ts';

function file(content: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'orc-raw-')), 'x.jsonl');
  writeFileSync(p, content);
  return p;
}

const line = 'a'.repeat(20);

describe('readJsonlPage', () => {
  it('reads lines longer than the window by growing it', async () => {
    const p = file(`${line}\n${line}\n${line}\n`);
    const page = await readJsonlPage(p, 0, 10, { windowBytes: 8 });
    expect(page.items.map((i) => i.offset)).toEqual([0, 21, 42]);
    expect(page.nextOffset).toBeNull();
  });

  it('pages with nextOffset', async () => {
    const p = file(`${line}\n${line}\n${line}\n`);
    const first = await readJsonlPage(p, 0, 2);
    expect(first.items).toHaveLength(2);
    expect(first.nextOffset).toBe(42);
    const second = await readJsonlPage(p, 42, 2);
    expect(second.items.map((i) => i.offset)).toEqual([42]);
    expect(second.nextOffset).toBeNull();
  });

  it('returns a trailing partial line flagged as partial', async () => {
    const p = file('{"a":1}\n{"b":');
    const page = await readJsonlPage(p, 0, 10);
    expect(page.items).toEqual([
      { offset: 0, text: '{"a":1}', truncated: false, partial: false },
      { offset: 8, text: '{"b":', truncated: false, partial: true },
    ]);
    expect(page.nextOffset).toBeNull();
  });

  it('truncates long lines and redacts', async () => {
    const p = file(`${line}\nPGPASSWORD=hunter2 psql\n`);
    const page = await readJsonlPage(p, 0, 10, { maxLineChars: 5 });
    expect(page.items[0]).toMatchObject({ text: 'aaaaa', truncated: true });
    const full = await readJsonlPage(p, 0, 10);
    expect(full.items[1]?.text).toBe('PGPASSWORD=«redacted:secret» psql');
  });

  it('returns nothing past the end', async () => {
    const p = file(`${line}\n`);
    expect(await readJsonlPage(p, 999, 10)).toEqual({ path: p, items: [], nextOffset: null });
  });
});
```

Run: `pnpm vitest run apps/daemon/src/services/session-detail/raw.test.ts`
Expected: FAIL, `Cannot find module './raw.ts'`

- [ ] **Step 2: Implement the raw reader**

`apps/daemon/src/services/session-detail/raw.ts`
```ts
import { open } from 'node:fs/promises';
import type { RawLine, RawPage } from '@orc/api-contract';
import { redact } from '@orc/core';

function toLine(offset: number, text: string, max: number, partial: boolean): RawLine {
  const red = redact(text);
  return { offset, text: red.length > max ? red.slice(0, max) : red, truncated: red.length > max, partial };
}

/** Read-only page of JSONL lines starting at a byte offset. Lines are redacted and clipped. */
export async function readJsonlPage(
  path: string,
  offset: number,
  limit: number,
  opts: { maxLineChars?: number; windowBytes?: number } = {},
): Promise<RawPage> {
  const maxLineChars = opts.maxLineChars ?? 20_000;
  let windowBytes = opts.windowBytes ?? 1 << 20;
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const items: RawLine[] = [];
    let pos = Math.min(offset, size);
    while (items.length < limit && pos < size) {
      const len = Math.min(windowBytes, size - pos);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      let start = 0;
      for (let i = 0; i < chunk.length && items.length < limit; i++) {
        if (chunk[i] !== 0x0a) continue;
        const text = chunk.subarray(start, i).toString('utf8').replace(/\r$/, '');
        if (text.length > 0) items.push(toLine(pos + start, text, maxLineChars, false));
        start = i + 1;
      }
      if (start === 0) {
        if (pos + bytesRead >= size) {
          const text = chunk.toString('utf8');
          if (text.length > 0) items.push(toLine(pos, text, maxLineChars, true));
          pos = size;
          break;
        }
        windowBytes *= 2;
        continue;
      }
      pos += start;
    }
    return { path, items, nextOffset: pos < size ? pos : null };
  } finally {
    await fh.close();
  }
}
```

Run: `pnpm vitest run apps/daemon/src/services/session-detail/raw.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 3: Write the failing route test**

`apps/daemon/test/session-detail.routes.test.ts`
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apportionCost } from '../src/services/session-detail/detail.ts';
import { type P3Harness, createP3Harness } from './p3-harness.ts';

let t: P3Harness;
beforeAll(async () => {
  t = await createP3Harness();
});
afterAll(async () => {
  await t.cleanup();
});

async function get<T>(path: string, status = 200): Promise<T> {
  const res = await t.request(path);
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

type Stats = {
  session: { toolCalls: number; toolMs: number; cacheHitRate: number | null; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } };
  turns: Array<{ turn: number; toolMs: number; ttftMs: number | null; reportedMs: number | null }>;
  agents: Array<{ agentId: string }>;
};

describe('GET /api/sessions/:source/:id/stats', () => {
  it('computes s-basic timing and token stats', async () => {
    const s = await get<Stats>('/api/sessions/claude/s-basic/stats');
    expect(s.turns.map((x) => x.turn)).toEqual([1, 2, 3]);
    expect(s.turns[0]).toMatchObject({ toolMs: 25000, ttftMs: 5000, reportedMs: 36000 });
    expect(s.session.toolCalls).toBe(2);
    expect(s.session.usage).toMatchObject({ input: 15, output: 27, cacheRead: 2100, cacheWrite: 100 });
    expect(s.session.cacheHitRate).toBeCloseTo(2100 / 2215, 6);
  });

  it('includes one entry per subagent', async () => {
    const s = await get<Stats>('/api/sessions/claude/s-subagents/stats');
    expect(s.agents.map((a) => a.agentId).sort()).toEqual(['ag1', 'ag2', 'ag3']);
  });

  it('404s for unknown sessions and sources', async () => {
    await get('/api/sessions/claude/nope/stats', 404);
    await get('/api/sessions/foo/s-basic/stats', 404);
  });
});

describe('deliverables, files, usage series', () => {
  it('lists the Edit in turn 1 as a deliverable', async () => {
    const d = await get<Array<{ turn: number; agentId: string | null; files: Array<{ path: string; status: string; tools: string[] }> }>>(
      '/api/sessions/claude/s-basic/deliverables',
    );
    expect(d).toEqual([
      {
        turn: 1,
        agentId: null,
        files: [{ path: '/Users/test/Wakecap/Backend/svc/a.ts', tools: ['Edit'], ops: 1, status: 'pending', lastTs: '2026-09-01T09:00:35.000Z' }],
      },
    ]);
  });

  it('summarizes files with edit snippets', async () => {
    const f = await get<Array<{ path: string; changes: Array<{ oldText: string | null; newText: string | null }> }>>(
      '/api/sessions/claude/s-basic/files',
    );
    expect(f[0]?.path).toBe('/Users/test/Wakecap/Backend/svc/a.ts');
    expect(f[0]?.changes[0]).toMatchObject({ oldText: 'a', newText: 'b' });
  });

  it('returns one usage point per deduplicated message with apportioned cost', async () => {
    const u = await get<Array<{ model: string; output: number; costUsd: number | null }>>('/api/sessions/claude/s-basic/usage-series');
    expect(u.map((p) => [p.model, p.output])).toEqual([
      ['claude-opus-5', 20],
      ['claude-opus-5', 7],
    ]);
    // weights: 10 + 5·20 + 1.25·100 + 0.1·1000 = 335 ; 5 + 5·7 + 0 + 0.1·1100 = 150 ; cost-state total 0.42
    expect(u[0]?.costUsd).toBeCloseTo((0.42 * 335) / 485, 9);
    expect(u[1]?.costUsd).toBeCloseTo((0.42 * 150) / 485, 9);
  });

  it('apportionCost leaves costs null without a total', () => {
    const p = { ts: 't', agentId: null, model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: null };
    expect(apportionCost([p], null)).toEqual([p]);
    expect(apportionCost([{ ...p, input: 0, output: 0 }], 1)[0]?.costUsd).toBe(0);
  });
});

describe('GET /api/sessions/:source/:id/safety', () => {
  it('flags prod touches without leaking secrets', async () => {
    const res = await t.request('/api/sessions/claude/s-drift/safety');
    const text = await res.text();
    expect(text).not.toContain('hunter2');
    const s = JSON.parse(text) as { touchedProd: boolean; prodTouches: Array<{ kind: string }>; permissionBadge: string };
    expect(s.touchedProd).toBe(true);
    expect(s.prodTouches.map((p) => p.kind).sort()).toEqual(['command', 'skill']);
    expect(s.permissionBadge).toBe('unknown');
  });

  it('maps bypassPermissions to the bypass badge', async () => {
    const s = await get<{ permissionBadge: string }>('/api/sessions/claude/s-basic/safety');
    expect(s.permissionBadge).toBe('bypass');
  });
});

describe('GET /api/sessions/:source/:id/raw', () => {
  type Page = { items: Array<{ offset: number; text: string; partial: boolean }>; nextOffset: number | null };

  it('pages through the transcript', async () => {
    const first = await get<Page>('/api/sessions/claude/s-basic/raw?limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.nextOffset).not.toBeNull();
    const second = await get<Page>(`/api/sessions/claude/s-basic/raw?limit=2&offset=${first.nextOffset}`);
    expect(second.items[0]?.offset).toBe(first.nextOffset);
  });

  it('shows the truncated last line of s-errors as partial', async () => {
    const page = await get<Page>('/api/sessions/claude/s-errors/raw');
    expect(page.items).toHaveLength(3);
    expect(page.items[2]?.partial).toBe(true);
    expect(page.nextOffset).toBeNull();
  });

  it('redacts and supports subagent transcripts', async () => {
    const drift = await get<Page>('/api/sessions/claude/s-drift/raw');
    expect(JSON.stringify(drift)).not.toContain('hunter2');
    const agent = await get<Page>('/api/sessions/claude/s-subagents/raw?agentId=ag1');
    expect(agent.items).toHaveLength(2);
    await get('/api/sessions/claude/s-subagents/raw?agentId=nope', 404);
    await get('/api/sessions/claude/s-basic/raw?limit=0', 400);
  });
});
```

Run: `pnpm vitest run apps/daemon/test/session-detail.routes.test.ts`
Expected: FAIL, 404s for every new route (they don't exist yet).

- [ ] **Step 4: Implement the service, helper and routes**

`apps/daemon/src/services/session-detail/collect.ts`
```ts
import type { Source, TimelineEvent } from '@orc/core';
import type { SessionService } from '../sessions.ts';

const PAGE = 1000;
const MAX_EVENTS = 200_000;

export function collectEvents(
  sessions: Pick<SessionService, 'events'>,
  source: Source,
  id: string,
  agentId: string | null,
): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  let afterSeq: number | undefined;
  for (;;) {
    const page = sessions.events(source, id, { agentId, afterSeq, limit: PAGE });
    for (const e of page.items) out.push(e);
    if (page.nextSeq === null || page.items.length === 0 || out.length >= MAX_EVENTS) break;
    afterSeq = page.nextSeq;
  }
  return out;
}
```

`apps/daemon/src/services/session-detail/detail.ts`
```ts
import type { SessionSafety, SessionStatsResponse, UsagePoint } from '@orc/api-contract';
import {
  type FileSummary,
  type Session,
  type Source,
  type TimelineEvent,
  type TurnDeliverables,
  computeSessionStats,
  computeTurnStats,
  deliverablesByTurn,
  detectProdTouches,
  extractFileChanges,
  permissionBadge,
  summarizeFiles,
} from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { collectEvents } from './collect.ts';

export interface SessionEventsBundle {
  session: Session;
  main: TimelineEvent[];
  agents: Array<{ agentId: string; events: TimelineEvent[] }>;
}

export interface SessionDetailService {
  bundle(source: Source, id: string): SessionEventsBundle | null;
  stats(source: Source, id: string): SessionStatsResponse | null;
  deliverables(source: Source, id: string): TurnDeliverables[] | null;
  files(source: Source, id: string): FileSummary[] | null;
  usageSeries(source: Source, id: string): UsagePoint[] | null;
  safety(source: Source, id: string): SessionSafety | null;
}

const CACHE_SIZE = 20;

export function costWeight(p: Pick<UsagePoint, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): number {
  return p.input + 5 * p.output + 1.25 * p.cacheWrite + 0.1 * p.cacheRead;
}

/** Splits the session's cost-state total across usage points by token weight (see the note above). */
export function apportionCost(points: UsagePoint[], totalUsd: number | null): UsagePoint[] {
  if (totalUsd === null) return points;
  const total = points.reduce((sum, p) => sum + costWeight(p), 0);
  return points.map((p) => ({ ...p, costUsd: total > 0 ? (totalUsd * costWeight(p)) / total : 0 }));
}

export function createSessionDetailService(
  ctx: Pick<DaemonContext, 'sessions' | 'projects' | 'config'>,
): SessionDetailService {
  const cache = new Map<string, { key: string; bundle: SessionEventsBundle }>();

  function bundle(source: Source, id: string): SessionEventsBundle | null {
    const session = ctx.sessions.get(source, id);
    if (!session) return null;
    const agents = ctx.sessions.agents(source, id);
    const key = `${session.lastActivityAt}|${agents.map((a) => `${a.id}:${a.endedAt ?? 'running'}`).join(',')}`;
    const pk = `${source}:${id}`;
    const hit = cache.get(pk);
    if (hit && hit.key === key) return hit.bundle;
    const b: SessionEventsBundle = {
      session,
      main: collectEvents(ctx.sessions, source, id, null),
      agents: agents.map((a) => ({ agentId: a.id, events: collectEvents(ctx.sessions, source, id, a.id) })),
    };
    cache.delete(pk);
    cache.set(pk, { key, bundle: b });
    if (cache.size > CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return b;
  }

  const allEvents = (b: SessionEventsBundle) => [...b.main, ...b.agents.flatMap((a) => a.events)];

  return {
    bundle,
    stats(source, id) {
      const b = bundle(source, id);
      if (!b) return null;
      const turns = computeTurnStats(b.main);
      return {
        session: computeSessionStats(turns),
        turns,
        agents: b.agents.map((a) => ({ agentId: a.agentId, stats: computeSessionStats(computeTurnStats(a.events)) })),
      };
    },
    deliverables(source, id) {
      const b = bundle(source, id);
      if (!b) return null;
      return [...deliverablesByTurn(b.main), ...b.agents.flatMap((a) => deliverablesByTurn(a.events))];
    },
    files(source, id) {
      const b = bundle(source, id);
      if (!b) return null;
      return summarizeFiles([...extractFileChanges(b.main), ...b.agents.flatMap((a) => extractFileChanges(a.events))]);
    },
    usageSeries(source, id) {
      const b = bundle(source, id);
      if (!b) return null;
      const points: UsagePoint[] = [];
      for (const e of allEvents(b)) {
        if (!e.usage || !e.model || e.model === '<synthetic>') continue;
        points.push({
          ts: e.ts,
          agentId: e.agentId,
          model: e.model,
          input: e.usage.input,
          output: e.usage.output,
          cacheRead: e.usage.cacheRead,
          cacheWrite: e.usage.cacheWrite,
          costUsd: null,
        });
      }
      points.sort((a, c) => (a.ts < c.ts ? -1 : a.ts > c.ts ? 1 : 0));
      return apportionCost(points, b.session.usage.costUsd);
    },
    safety(source, id) {
      const b = bundle(source, id);
      if (!b) return null;
      const project = b.session.projectId ? ctx.projects.get(b.session.projectId) : null;
      const opts = { prodSkills: ctx.config().safety.prodSkills, prodPatterns: project?.prodPatterns ?? [] };
      const prodTouches = [...detectProdTouches(b.main, opts), ...b.agents.flatMap((a) => detectProdTouches(a.events, opts))];
      return {
        permissionMode: b.session.permissionMode,
        permissionBadge: permissionBadge([b.session.permissionMode]),
        touchedProd: b.session.flags.touchedProd || prodTouches.length > 0,
        prodTouches,
      };
    },
  };
}
```

`apps/daemon/src/http/redacted-json.ts`
```ts
import { redactDeep } from '@orc/core';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { JSONValue } from 'hono/utils/types';

/** The only way transcript-bearing JSON leaves the daemon (contracts §8). */
export function redactedJson(c: Context, body: unknown, status: ContentfulStatusCode = 200): Response {
  return c.json(redactDeep(body) as JSONValue, status);
}
```

`apps/daemon/src/http/routes/session-detail.ts`
```ts
import { RawQuery, SourceParam, apiError } from '@orc/api-contract';
import type { Source } from '@orc/core';
import type { Context } from 'hono';
import type { DaemonContext } from '../../context.ts';
import { type SessionDetailService, createSessionDetailService } from '../../services/session-detail/detail.ts';
import { readJsonlPage } from '../../services/session-detail/raw.ts';
import { redactedJson } from '../redacted-json.ts';
import type { OrcApp } from '../types.ts';

export function sessionParams(c: Context): { source: Source; id: string } | null {
  const s = SourceParam.safeParse(c.req.param('source'));
  const id = String(c.req.param('id') ?? '');
  return s.success && id ? { source: s.data, id } : null;
}

const notFound = (c: Context, what = 'session') => c.json(apiError('not_found', `${what} not found`), 404);

export function registerSessionDetailRoutes(
  app: OrcApp,
  ctx: DaemonContext,
  svc: SessionDetailService = createSessionDetailService(ctx),
): void {
  const handler = (fn: (source: Source, id: string) => unknown | null) => (c: Context) => {
    const p = sessionParams(c);
    if (!p) return notFound(c);
    const body = fn(p.source, p.id);
    return body === null ? notFound(c) : redactedJson(c, body);
  };

  app.get('/api/sessions/:source/:id/stats', handler((s, i) => svc.stats(s, i)));
  app.get('/api/sessions/:source/:id/deliverables', handler((s, i) => svc.deliverables(s, i)));
  app.get('/api/sessions/:source/:id/files', handler((s, i) => svc.files(s, i)));
  app.get('/api/sessions/:source/:id/usage-series', handler((s, i) => svc.usageSeries(s, i)));
  app.get('/api/sessions/:source/:id/safety', handler((s, i) => svc.safety(s, i)));

  app.get('/api/sessions/:source/:id/raw', async (c) => {
    const p = sessionParams(c);
    if (!p) return notFound(c);
    const q = RawQuery.safeParse(c.req.query());
    if (!q.success) return c.json(apiError('validation_failed', 'invalid raw query', q.error.issues), 400);
    const session = ctx.sessions.get(p.source, p.id);
    if (!session) return notFound(c);
    let path = session.transcriptPath;
    if (q.data.agentId) {
      const agent = ctx.sessions.agents(p.source, p.id).find((a) => a.id === q.data.agentId);
      if (!agent) return notFound(c, 'agent');
      path = agent.transcriptPath;
    }
    if (!path || !path.endsWith('.jsonl')) {
      return c.json(apiError('raw_unavailable', 'transcript is not available as plain JSONL (archived or remote)'), 409);
    }
    try {
      return redactedJson(c, await readJsonlPage(path, q.data.offset, q.data.limit));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return notFound(c, 'transcript file');
      throw err;
    }
  });
}
```

`apps/daemon/src/http/app.ts` → `createApp(o)` (A1), before the `/api/*` catch-all:
```ts
import { registerSessionDetailRoutes } from './routes/session-detail.ts';
registerSessionDetailRoutes(app, o.ctx);
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/test/session-detail.routes.test.ts apps/daemon/src/services/session-detail`
Expected: PASS (12 + 5 tests). If an s-basic number differs, check what Phase 1 emits for the fixture (`GET /api/sessions/claude/s-basic/events`) against assumption A4, fix the Phase 1 mapping if it breaks the §4 contract, and note it in the review note. Do **not** loosen the test.

- [ ] **Step 6: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon
git commit -m "feat(daemon): add session detail stats, deliverables, files, usage, safety and raw routes"
```

---

### Task 10: Links service — PRs, tickets, plans (read-only) and artifacts

**Files:**
- Create: `apps/daemon/src/services/links/plans.ts`, `apps/daemon/src/services/links/links.ts`, `apps/daemon/src/http/routes/links.ts`
- Test: `apps/daemon/test/links.test.ts`
- Modify: `apps/daemon/src/http/app.ts` (A1)

**Interfaces:**
- Consumes: `SessionService.get` (§11), `readJsonlFrom`, `parseJsonLine`, `redact`, `Session`, `DEFAULT_TICKET_REGEX`, `compileTicketRegex` (core, A5), `createP3Harness` (Task 6), `OrcApp` (A1), `expandHome` (Task 8), `sessionParams`, `redactedJson` (Task 9), `PlansQuery`, `PlanContentQuery`, `PlanRef`, `SessionLinks` (Task 5), `OrcConfig.links` (Task 5)
- Produces:
  ```ts
  export interface PlanIndexEntry { path: string; title: string; source: PlanRef['source']; mtimeMs: number; tickets: string[] }
  export interface PlanFinderOptions { claudeHome: string; home: string; planRoots: () => string[]; repoRoots: () => string[]; ticketRegex: () => RegExp; maxDepth?: number; cacheMs?: number; now?: () => number }
  export interface PlanFinder { index(extraRepoRoots?: string[]): Promise<PlanIndexEntry[]>; forSession(s: Session): Promise<PlanRef[]>; search(q: string, limit: number): Promise<PlanRef[]>; read(path: string): Promise<string | null>; isAllowed(path: string): boolean }
  export function findRepoRoot(cwd: string, home: string): string | null
  export function createPlanFinder(o: PlanFinderOptions): PlanFinder
  export function createPlanFinderFromContext(ctx: Pick<DaemonContext, 'paths' | 'config'>, home?: string): PlanFinder
  export interface LinksService { forSession(source: Source, id: string): Promise<SessionLinks | null> }
  export function scanTranscriptMeta(path: string | null): Promise<{ artifacts: SessionLinks['artifacts']; bridgeSessionId: string | null }>
  export function createLinksService(ctx: Pick<DaemonContext, 'sessions' | 'config'>, finder: PlanFinder): LinksService
  export function registerLinksRoutes(app: OrcApp, ctx: DaemonContext, opts?: { home?: string; finder?: PlanFinder }): void
  ```

Plan sources:
- `$CLAUDE_HOME/plans/*.md` (`claude-plans`). These match by ticket, or by mtime within `[startedAt − 1 h, lastActivityAt + 1 h]`.
- every `config.links.planRoots` (default `~/Wakecap/plans/**`, depth 4, `wakecap-plans`). These match by ticket.
- `<repo>/docs/superpowers/{specs,plans}/*.md` for the repo root of every session cwd and every configured `projects[].repos[].path` (`repo-docs`). These match by ticket.

A ticket counts as matching when it appears in the file name or in the first 4 KB of the file. Plan content is served only from those roots, only for `.md` files, capped at 512 KB, and redacted. The service only reads files.

- [ ] **Step 1: Write the failing test**

`apps/daemon/test/links.test.ts`
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { OrcConfig } from '@orc/api-contract';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerLinksRoutes } from '../src/http/routes/links.ts';
import { createPlanFinderFromContext, findRepoRoot } from '../src/services/links/plans.ts';
import { type P3Harness, createP3Harness } from './p3-harness.ts';

let t: P3Harness;
let app: Hono<{ Bindings: HttpBindings }>;
let home: string;
let planRoot: string;
let repo: string;

beforeAll(async () => {
  t = await createP3Harness();
  home = mkdtempSync(join(tmpdir(), 'orc-links-home-'));
  planRoot = join(home, 'Wakecap/plans');
  mkdirSync(join(planRoot, '2026'), { recursive: true });
  writeFileSync(join(planRoot, '2026/SAF-1787-sla.md'), '# SLA weekends plan\nUse token=abc for nothing.\n');
  writeFileSync(join(planRoot, 'other.md'), '# Unrelated\n');
  repo = join(home, 'Wakecap/Backend/svc');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'docs/superpowers/plans'), { recursive: true });
  writeFileSync(join(repo, 'docs/superpowers/plans/2026-09-01-weekends.md'), '# Weekends\nTicket: SAF-1787\n');
  const cfg = OrcConfig.parse({ links: { planRoots: [planRoot], linearWorkspace: 'acme' } });
  app = new Hono<{ Bindings: HttpBindings }>();
  registerLinksRoutes(app, { ...t.ctx, config: () => cfg }, { home });
});
afterAll(async () => {
  await t.cleanup();
});

const get = (path: string) => app.request(path);

describe('GET /api/sessions/:source/:id/links', () => {
  it('returns PRs, ticket URLs and ticket-matched plans', async () => {
    const res = await get('/api/sessions/claude/s-prlink/links');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      prs: Array<{ number: number }>;
      tickets: Array<{ id: string; url: string | null }>;
      plans: Array<{ title: string; source: string; reason: string }>;
    };
    expect(body.prs.map((p) => p.number)).toEqual([231]);
    expect(body.tickets).toContainEqual({ id: 'SAF-1787', url: 'https://linear.app/acme/issue/SAF-1787' });
    expect(body.plans.map((p) => [p.source, p.reason, p.title]).sort()).toEqual([
      ['claude-plans', 'ticket', 'Plan: SAF-1787 exclude weekends'],
      ['wakecap-plans', 'ticket', 'SLA weekends plan'],
    ]);
  });

  it('returns artifacts and the bridge session from transcript meta', async () => {
    const body = (await (await get('/api/sessions/claude/s-unknown/links')).json()) as {
      artifacts: unknown[];
      bridgeSessionId: string | null;
    };
    expect(body.artifacts).toEqual([{ title: 'Artifact', url: 'https://example.test/a', path: '/tmp/x.html' }]);
    expect(body.bridgeSessionId).toBe('b-1');
  });

  it('404s for unknown sessions', async () => {
    expect((await get('/api/sessions/claude/nope/links')).status).toBe(404);
  });
});

describe('repo docs', () => {
  it('finds the repo root under home and matches its superpowers plans', async () => {
    expect(findRepoRoot(join(repo, 'src/deep'), home)).toBe(repo);
    expect(findRepoRoot('/definitely/not/home', home)).toBeNull();
    const cfg = OrcConfig.parse({ links: { planRoots: [] } });
    const finder = createPlanFinderFromContext({ paths: t.ctx.paths, config: () => cfg }, home);
    const base = t.ctx.sessions.get('claude', 's-prlink');
    if (!base) throw new Error('fixture s-prlink missing');
    const refs = await finder.forSession({ ...base, cwds: [join(repo, 'src')], tickets: ['SAF-1787'] });
    expect(refs.map((r) => r.source)).toContain('repo-docs');
  });
});

describe('plans routes', () => {
  it('searches by title and ticket', async () => {
    const byTitle = (await (await get('/api/plans?q=sla')).json()) as Array<{ title: string; reason: string }>;
    expect(byTitle.map((p) => p.title)).toEqual(['SLA weekends plan']);
    expect(byTitle[0]?.reason).toBe('query');
    const byTicket = (await (await get('/api/plans?q=SAF-1787')).json()) as unknown[];
    expect(byTicket.length).toBeGreaterThanOrEqual(2);
  });

  it('serves plan content from allowed roots only, redacted', async () => {
    const ok = await get(`/api/plans/content?path=${encodeURIComponent(join(planRoot, '2026/SAF-1787-sla.md'))}`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { text: string };
    expect(body.text).toContain('token=«redacted:secret»');
    expect((await get('/api/plans/content?path=%2Fetc%2Fpasswd')).status).toBe(403);
    expect((await get(`/api/plans/content?path=${encodeURIComponent(`${planRoot}/../../secret.md`)}`)).status).toBe(403);
    expect((await get(`/api/plans/content?path=${encodeURIComponent(join(planRoot, 'missing.md'))}`)).status).toBe(404);
    expect((await get('/api/plans/content')).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/test/links.test.ts`
Expected: FAIL, `Cannot find module '../src/http/routes/links.ts'`

- [ ] **Step 3: Implement the plan finder**

`apps/daemon/src/services/links/plans.ts`
```ts
import { type Dirent, existsSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { PlanRef } from '@orc/api-contract';
import { DEFAULT_TICKET_REGEX, type Session, compileTicketRegex, redact } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { expandHome } from '../safety/secrets-scan.ts';

export interface PlanIndexEntry {
  path: string;
  title: string;
  source: PlanRef['source'];
  mtimeMs: number;
  tickets: string[];
}

export interface PlanFinderOptions {
  claudeHome: string;
  home: string;
  planRoots: () => string[];
  repoRoots: () => string[];
  ticketRegex: () => RegExp;
  maxDepth?: number;
  cacheMs?: number;
  now?: () => number;
}

export interface PlanFinder {
  index(extraRepoRoots?: string[]): Promise<PlanIndexEntry[]>;
  forSession(s: Session): Promise<PlanRef[]>;
  search(q: string, limit: number): Promise<PlanRef[]>;
  read(path: string): Promise<string | null>;
  isAllowed(path: string): boolean;
}

const HEAD_BYTES = 4096;
const MAX_READ = 512 * 1024;
const TIME_SLACK_MS = 3_600_000;
const REPO_DOC_DIRS = ['docs/superpowers/specs', 'docs/superpowers/plans'];

const within = (p: string, root: string) => p === root || p.startsWith(`${root}${sep}`);

async function walkMd(dir: string, depth: number, maxDepth: number): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < maxDepth) out.push(...(await walkMd(p, depth + 1, maxDepth)));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(p);
    }
  }
  return out;
}

async function readBytes(path: string, max: number): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

function titleOf(head: string, path: string): string {
  const m = /^#\s+(.+)$/m.exec(head);
  return (m?.[1] ?? basename(path, '.md')).trim().slice(0, 200);
}

function ticketsIn(text: string, re: RegExp): string[] {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return [...new Set([...text.matchAll(g)].map((m) => m[0].toUpperCase()))];
}

export function findRepoRoot(cwd: string, home: string): string | null {
  let dir = resolve(cwd);
  while (within(dir, home) && dir !== home) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function createPlanFinder(o: PlanFinderOptions): PlanFinder {
  const maxDepth = o.maxDepth ?? 4;
  const cacheMs = o.cacheMs ?? 30_000;
  const now = o.now ?? Date.now;
  let cached: { at: number; key: string; entries: PlanIndexEntry[] } | null = null;

  const claudePlans = () => join(o.claudeHome, 'plans');
  const planRoots = () => o.planRoots().map((r) => resolve(r));

  function roots(extra: string[]) {
    const list: Array<{ dir: string; source: PlanRef['source']; depth: number }> = [
      { dir: claudePlans(), source: 'claude-plans', depth: 0 },
    ];
    for (const r of planRoots()) list.push({ dir: r, source: 'wakecap-plans', depth: maxDepth });
    for (const repo of new Set([...o.repoRoots(), ...extra])) {
      for (const d of REPO_DOC_DIRS) list.push({ dir: join(repo, d), source: 'repo-docs', depth: 1 });
    }
    return list;
  }

  async function index(extra: string[] = []): Promise<PlanIndexEntry[]> {
    const list = roots(extra);
    const key = list.map((r) => r.dir).join('|');
    if (cached && cached.key === key && now() - cached.at < cacheMs) return cached.entries;
    const re = o.ticketRegex();
    const entries: PlanIndexEntry[] = [];
    const seen = new Set<string>();
    for (const r of list) {
      for (const p of await walkMd(r.dir, 0, r.depth)) {
        if (seen.has(p)) continue;
        seen.add(p);
        const st = await stat(p).catch(() => null);
        if (!st) continue;
        const head = await readBytes(p, HEAD_BYTES).catch(() => '');
        entries.push({
          path: p,
          title: titleOf(head, p),
          source: r.source,
          mtimeMs: st.mtimeMs,
          tickets: ticketsIn(`${basename(p)}\n${head}`, re),
        });
      }
    }
    cached = { at: now(), key, entries };
    return entries;
  }

  function isAllowed(path: string): boolean {
    const p = resolve(path);
    if (!p.endsWith('.md')) return false;
    if ([claudePlans(), ...planRoots()].some((r) => p.startsWith(`${r}${sep}`))) return true;
    return within(p, o.home) && REPO_DOC_DIRS.some((d) => p.includes(`${sep}${d.split('/').join(sep)}${sep}`));
  }

  const toRef = (e: PlanIndexEntry, reason: PlanRef['reason']): PlanRef => ({
    path: e.path,
    title: redact(e.title),
    source: e.source,
    mtime: new Date(e.mtimeMs).toISOString(),
    reason,
    tickets: e.tickets,
  });

  const byMtimeDesc = (a: PlanRef, b: PlanRef) => (a.mtime === b.mtime ? 0 : a.mtime < b.mtime ? 1 : -1);

  return {
    index,
    async forSession(s) {
      const repos = s.cwds.map((c) => findRepoRoot(c, o.home)).filter((x): x is string => x !== null);
      const entries = await index(repos);
      const tickets = new Set(s.tickets.map((t) => t.toUpperCase()));
      const from = Date.parse(s.startedAt) - TIME_SLACK_MS;
      const to = Date.parse(s.lastActivityAt) + TIME_SLACK_MS;
      const byTicket: PlanRef[] = [];
      const byTime: PlanRef[] = [];
      for (const e of entries) {
        if (e.tickets.some((t) => tickets.has(t))) byTicket.push(toRef(e, 'ticket'));
        else if (e.source === 'claude-plans' && e.mtimeMs >= from && e.mtimeMs <= to) byTime.push(toRef(e, 'time'));
      }
      return [...byTicket.sort(byMtimeDesc), ...byTime.sort(byMtimeDesc)];
    },
    async search(q, limit) {
      const needle = q.trim().toLowerCase();
      const entries = await index();
      return entries
        .filter(
          (e) =>
            needle === '' ||
            e.title.toLowerCase().includes(needle) ||
            e.path.toLowerCase().includes(needle) ||
            e.tickets.some((t) => t.toLowerCase() === needle),
        )
        .map((e) => toRef(e, 'query'))
        .sort(byMtimeDesc)
        .slice(0, limit);
    },
    async read(path) {
      if (!isAllowed(path)) return null;
      const p = resolve(path);
      const st = await stat(p).catch(() => null);
      if (!st?.isFile()) return null;
      return redact(await readBytes(p, Math.min(st.size, MAX_READ)));
    },
    isAllowed,
  };
}

export function createPlanFinderFromContext(ctx: Pick<DaemonContext, 'paths' | 'config'>, home: string = homedir()): PlanFinder {
  return createPlanFinder({
    claudeHome: ctx.paths.claudeHome,
    home,
    planRoots: () => ctx.config().links.planRoots.map((r) => expandHome(r, home)),
    repoRoots: () => ctx.config().projects.flatMap((p) => p.repos.map((r) => r.path)),
    ticketRegex: () => {
      const cfg = ctx.config();
      const project = cfg.projects.find((p) => p.id === cfg.defaultProjectId);
      return (
        compileTicketRegex(project?.ticketRegex ?? DEFAULT_TICKET_REGEX) ??
        (compileTicketRegex(DEFAULT_TICKET_REGEX) as RegExp)
      );
    },
  });
}
```

`readBytes(p, 0)` for an empty file allocates a zero-length buffer and returns `''`, which is fine.

- [ ] **Step 4: Implement the links service and routes**

`apps/daemon/src/services/links/links.ts`
```ts
import type { SessionLinks } from '@orc/api-contract';
import { type Source, parseJsonLine, readJsonlFrom } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import type { PlanFinder } from './plans.ts';

export interface LinksService {
  forSession(source: Source, id: string): Promise<SessionLinks | null>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export async function scanTranscriptMeta(
  path: string | null,
): Promise<{ artifacts: SessionLinks['artifacts']; bridgeSessionId: string | null }> {
  const empty = { artifacts: [], bridgeSessionId: null };
  if (!path || !path.endsWith('.jsonl')) return empty;
  const r = await readJsonlFrom(path, 0).catch(() => null);
  if (!r) return empty;
  const artifacts = new Map<string, SessionLinks['artifacts'][number]>();
  let bridgeSessionId: string | null = null;
  for (const l of r.lines) {
    if (!l.text.includes('"frame-link"') && !l.text.includes('"bridge-session"')) continue;
    const v = parseJsonLine(l.text);
    if (!isObj(v)) continue;
    if (v.type === 'frame-link') {
      const a = { title: str(v.title), url: str(v.frameUrl), path: str(v.path) };
      artifacts.set(`${a.url ?? ''}|${a.path ?? ''}`, a);
    } else if (v.type === 'bridge-session') {
      bridgeSessionId = str(v.bridgeSessionId) ?? bridgeSessionId;
    }
  }
  return { artifacts: [...artifacts.values()], bridgeSessionId };
}

export function createLinksService(ctx: Pick<DaemonContext, 'sessions' | 'config'>, finder: PlanFinder): LinksService {
  return {
    async forSession(source, id) {
      const s = ctx.sessions.get(source, id);
      if (!s) return null;
      const ws = ctx.config().links.linearWorkspace;
      const meta = await scanTranscriptMeta(s.transcriptPath);
      return {
        prs: s.prs,
        tickets: s.tickets.map((t) => ({ id: t, url: ws ? `https://linear.app/${ws}/issue/${t}` : null })),
        plans: await finder.forSession(s),
        artifacts: meta.artifacts,
        bridgeSessionId: meta.bridgeSessionId,
      };
    },
  };
}
```

`apps/daemon/src/http/routes/links.ts`
```ts
import { resolve } from 'node:path';
import { PlanContentQuery, PlansQuery, apiError } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { createLinksService } from '../../services/links/links.ts';
import { type PlanFinder, createPlanFinderFromContext } from '../../services/links/plans.ts';
import { redactedJson } from '../redacted-json.ts';
import type { OrcApp } from '../types.ts';
import { sessionParams } from './session-detail.ts';

export function registerLinksRoutes(
  app: OrcApp,
  ctx: DaemonContext,
  opts: { home?: string; finder?: PlanFinder } = {},
): void {
  const finder = opts.finder ?? createPlanFinderFromContext(ctx, opts.home);
  const links = createLinksService(ctx, finder);

  app.get('/api/sessions/:source/:id/links', async (c) => {
    const p = sessionParams(c);
    const body = p ? await links.forSession(p.source, p.id) : null;
    if (!body) return c.json(apiError('not_found', 'session not found'), 404);
    return redactedJson(c, body);
  });

  app.get('/api/plans', async (c) => {
    const q = PlansQuery.safeParse(c.req.query());
    if (!q.success) return c.json(apiError('validation_failed', 'invalid plans query', q.error.issues), 400);
    return redactedJson(c, await finder.search(q.data.q, q.data.limit));
  });

  app.get('/api/plans/content', async (c) => {
    const q = PlanContentQuery.safeParse(c.req.query());
    if (!q.success) return c.json(apiError('validation_failed', 'path is required', q.error.issues), 400);
    if (!finder.isAllowed(q.data.path)) return c.json(apiError('forbidden', 'path is outside the plan roots'), 403);
    const text = await finder.read(q.data.path);
    if (text === null) return c.json(apiError('not_found', 'plan not found'), 404);
    return redactedJson(c, { path: resolve(q.data.path), text });
  });
}
```

`apps/daemon/src/http/app.ts` → `createApp(o)` (A1), before the `/api/*` catch-all:
```ts
import { registerLinksRoutes } from './routes/links.ts';
registerLinksRoutes(app, o.ctx);
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/test/links.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon
git commit -m "feat(daemon): add read-only links service for PRs, tickets, plans and artifacts"
```

---

### Task 11: Enforce redaction on every transcript-bearing response (routes, FTS snippets, WS)

**Files:**
- Create: `apps/daemon/src/http/ws-redact.ts`, `apps/daemon/test/redaction.routes.test.ts`
- Modify: `apps/daemon/src/http/redact-out.ts` (A1), `apps/daemon/src/http/live-ws.ts` (A8), and, only where the test fails, the Phase 1/2 route files (`routes/sessions.ts`, the P2 live and inbox routes)

**Interfaces:**
- Consumes: `redactedJson` (Task 9); `redactDeep`, `redactPartialTokens` (Task 1); P1 `redactValue`, `redactSnippet`, `redactSession` (A1); P2 `createLiveWsHub`, `LIVE_EVENT_TYPES` (A8); `LiveEvent` (Task 5); `createP3Harness` (Task 6)
- Produces:
  ```ts
  export function toWireEvent(e: LiveEvent): LiveEvent   // session/inbox/audit payloads redacted before WS send
  // P1 redact-out.ts after this task:
  //   redactValue(v) === redactDeep(v)   (adds sensitive-key masking)
  //   redactSnippet(s) also applies redactPartialTokens
  ```
- This task also guarantees that every GET listed in the test never returns the fixture secret `hunter2`, and that snippets are stable under the daemon's `redactSnippet`.

- [ ] **Step 1: Write the failing test**

`apps/daemon/test/redaction.routes.test.ts`
```ts
import type { LiveEvent } from '@orc/api-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redactSnippet, redactValue } from '../src/http/redact-out.ts';
import { toWireEvent } from '../src/http/ws-redact.ts';
import { type P3Harness, createP3Harness } from './p3-harness.ts';

const SECRET = 'hunter2';
let t: P3Harness;

beforeAll(async () => {
  t = await createP3Harness();
});
afterAll(async () => {
  await t.cleanup();
});

const getText = async (path: string) => {
  const res = await t.request(path);
  expect(res.status).toBeLessThan(500);
  return res.text();
};

const PATHS = [
  '/api/sessions',
  '/api/sessions?q=psql',
  '/api/sessions?q=PGPASSWORD',
  '/api/sessions/claude/s-drift',
  '/api/sessions/claude/s-drift/events?limit=500',
  '/api/sessions/claude/s-drift/agents',
  '/api/sessions/claude/s-drift/stats',
  '/api/sessions/claude/s-drift/deliverables',
  '/api/sessions/claude/s-drift/files',
  '/api/sessions/claude/s-drift/usage-series',
  '/api/sessions/claude/s-drift/safety',
  '/api/sessions/claude/s-drift/raw',
  '/api/sessions/claude/s-drift/links',
  '/api/live',
  '/api/inbox',
  '/api/audit',
];

describe('no raw secret leaves the daemon', () => {
  it.each(PATHS)('%s', async (path) => {
    expect(await getText(path)).not.toContain(SECRET);
  });

  it('events carry the redaction marker instead', async () => {
    expect(await getText('/api/sessions/claude/s-drift/events?limit=500')).toContain('«redacted:secret»');
  });

  it('search snippets are stable under redactSnippet, which also masks cut-off tokens', async () => {
    const body = JSON.parse(await getText('/api/sessions?q=psql')) as { items: Array<{ snippet: string | null }> };
    for (const i of body.items) if (i.snippet !== null) expect(i.snippet).toBe(redactSnippet(i.snippet));
    expect(redactSnippet('…export GH=ghp_abc12')).toBe('…export GH=«redacted:partial»');
  });

  it('redactValue masks sensitive keys', () => {
    expect(redactValue({ env: { PGPASSWORD: SECRET } })).toEqual({ env: { PGPASSWORD: '«redacted:secret»' } });
  });

  it('audit params for PTY input are redacted', async () => {
    const res = await t.request('/api/sessions/claude/s-basic/resume', { method: 'POST', body: { mode: 'embedded' } });
    const { ptyId } = (await res.json()) as { ptyId: string };
    t.ctx.pty.write(ptyId, `export PGPASSWORD=${SECRET}\r`);
    const audit = await getText('/api/audit?action=pty.input');
    expect(audit).toContain('«redacted:secret»');
    expect(audit).not.toContain(SECRET);
  });
});

describe('toWireEvent', () => {
  it('redacts session, inbox and audit payloads and passes others through', () => {
    const base = t.ctx.sessions.get('claude', 's-drift');
    if (!base) throw new Error('fixture s-drift missing');
    const session = { ...base, lastPrompt: `PGPASSWORD=${SECRET} psql` };
    expect(JSON.stringify(toWireEvent({ type: 'session.updated', session }))).not.toContain(SECRET);
    const audit = toWireEvent({
      type: 'audit.recorded',
      entry: { id: 'a', ts: 't', actor: 'user', actorDetail: null, action: 'pty.input', target: null, params: { text: `password=${SECRET}` }, result: 'ok', error: null },
    });
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    const hello: LiveEvent = { type: 'hello', serverTime: '2026-09-17T00:00:00.000Z' };
    expect(toWireEvent(hello)).toBe(hello);
  });
});
```

- [ ] **Step 2: Run it and list the failures**

Run: `pnpm vitest run apps/daemon/test/redaction.routes.test.ts`
Expected: FAIL, at least with `Cannot find module '../src/http/ws-redact.ts'`, and on the `redactSnippet` partial-token and `redactValue` sensitive-key assertions. After Steps 3–4, re-run and write down every path that still leaks; each one is fixed in Step 5.

- [ ] **Step 3: Strengthen the Phase 1 redaction helpers**

In `apps/daemon/src/http/redact-out.ts` (A1), make `redactValue` delegate to `redactDeep`, and add partial-token masking to `redactSnippet`. The marker handling stays as Phase 1 wrote it:
```ts
import { redact, redactDeep, redactPartialTokens } from '@orc/core';

export function redactValue(v: unknown): unknown {
  return redactDeep(v);
}

/** Highlight markers can split a secret (e.g. "⟦PGPASSWORD⟧=x"), so redaction runs on the plain text first. */
export function redactSnippet(snippet: string): string {
  const plain = snippet.replaceAll(SNIPPET_OPEN, '').replaceAll(SNIPPET_CLOSE, '');
  const clean = redactPartialTokens(redact(plain));
  return clean !== plain ? clean : redactPartialTokens(snippet);
}
```
For a clean snippet, `redactPartialTokens(snippet)` returns the snippet unchanged, markers included, so the function stays idempotent.

- [ ] **Step 4: Add the WS redactor and forward audit events**

`apps/daemon/src/http/ws-redact.ts`
```ts
import type { LiveEvent } from '@orc/api-contract';
import { redactDeep } from '@orc/core';

export function toWireEvent(e: LiveEvent): LiveEvent {
  switch (e.type) {
    case 'session.updated':
      return { ...e, session: redactDeep(e.session) };
    case 'inbox.upserted':
      return { ...e, item: redactDeep(e.item) };
    case 'audit.recorded':
      return { ...e, entry: redactDeep(e.entry) };
    default:
      return e;
  }
}
```

In `apps/daemon/src/http/live-ws.ts` (A8):
- add `'audit.recorded'` to `LIVE_EVENT_TYPES`
- replace the body of the local `toWire` with a call to `toWireEvent`, keeping `WireEvent` as the return type (cast if P2 typed `WireEvent` narrower than `LiveEvent`)

```ts
import { toWireEvent } from './ws-redact.ts';
const toWire = (e: Extract<BusEvent, { type: LiveType }>): WireEvent => toWireEvent(e) as WireEvent;
```
If P2's hub test asserts that exactly the P2 event types are forwarded, add `'audit.recorded'` to its expected list.

- [ ] **Step 5: Fix each leaking route**

For every path that still fails, change the handler's `c.json(body)` to `redactedJson(c, body)` (import from `../redacted-json.ts`). Phase 1's `GET /api/sessions/:source/:id/agents` currently returns `c.json(ctx.sessions.agents(...))` unredacted, and agent `description`s can hold prompt text:
```ts
import { redactedJson } from '../redacted-json.ts';
// GET /api/sessions/:source/:id/agents
return redactedJson(c, ctx.sessions.agents(p.source, p.id));
```
Apply the same change to the Phase 2 `GET /api/live` and `GET /api/inbox` handlers if they fail.

Run: `pnpm vitest run apps/daemon/test/redaction.routes.test.ts apps/daemon/src/http`
Expected: PASS (21 tests in the new file, plus Phase 1's `app.test.ts` still green).

- [ ] **Step 6: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon
git commit -m "fix(daemon): redact every transcript-bearing response, partial tokens in snippets and ws events"
```

---

### Task 12: Export ZIP (redacted by default)

**Files:**
- Create: `apps/daemon/src/services/export/export-zip.ts`, `apps/daemon/src/http/routes/export.ts`
- Test: `apps/daemon/test/export.test.ts`
- Modify: `apps/daemon/package.json` (add `fflate`), `apps/daemon/src/http/app.ts` (A1)

**Interfaces:**
- Consumes: `SessionService.get/agents`, `SessionDetailService` (Task 9), `LinksService`, `createPlanFinderFromContext` (Task 10), `AuditService`, `createP3Harness` (Task 6), `sessionParams` (Task 9), `OrcApp` (A1), `ExportQuery` (Task 5), `Handoff`, `CORE_VERSION`, `redact`, `redactDeep` (core). Optional `ctx.handoffs` (P5, null-safe). `fflate@^0.8.3`: `zipSync`, `strToU8`, `unzipSync`, `strFromU8`, `type Zippable`
- Produces:
  ```ts
  export interface ExportDeps { sessions: Pick<SessionService, 'get' | 'agents'>; detail: SessionDetailService; links: LinksService; audit: AuditService; handoffs?: { latest(sessionPk: string): Handoff | null; toMarkdown(h: Handoff): string }; version: string; now?: () => Date }
  export interface ExportManifest { formatVersion: 1; sessionPk: string; source: Source; id: string; exportedAt: string; appVersion: string; redacted: boolean; files: string[]; notes: string[] }
  export interface ExportResult { filename: string; bytes: Uint8Array; manifest: ExportManifest }
  export class ExportTooLargeError extends Error {}
  export function buildSessionExport(deps: ExportDeps, source: Source, id: string, opts: { redact: boolean; maxBytes?: number }): Promise<ExportResult | null>
  export function registerExportRoutes(app: OrcApp, ctx: DaemonContext): void   // GET /api/sessions/:source/:id/export
  ```

ZIP layout:
- `manifest.json`
- `session.json`
- `transcript.jsonl`
- `subagents/agent-<id>.jsonl` and `subagents/agent-<id>.meta.json`
- `agents.json`, `stats.json`, `deliverables.json`, `files.json`, `links.json`, `audit.json`
- `recap.md`, only when `session.recap` is set
- `handoff.md`, only when `ctx.handoffs?.latest()` returns one

Missing pieces become `manifest.notes`. With `redact=false`, the request also needs `confirm=true`, otherwise it returns 409. Every export is audited as `session.export` (Task 7 middleware). The total size is capped at 200 MB; above that the route returns `413 export_too_large`.

- [ ] **Step 1: Add the dependency**

Run: `npm view fflate version && pnpm --filter @orc/daemon add fflate@^0.8.3`
Expected: prints `0.8.3` (or a newer 0.8.x), and `apps/daemon/package.json` lists `"fflate": "^0.8.3"`.

- [ ] **Step 2: Write the failing test**

`apps/daemon/test/export.test.ts`
```ts
import type { Handoff } from '@orc/core';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLinksService } from '../src/services/links/links.ts';
import { createPlanFinderFromContext } from '../src/services/links/plans.ts';
import { ExportTooLargeError, buildSessionExport } from '../src/services/export/export-zip.ts';
import { createSessionDetailService } from '../src/services/session-detail/detail.ts';
import { type P3Harness, createP3Harness } from './p3-harness.ts';

let t: P3Harness;
beforeAll(async () => {
  t = await createP3Harness();
});
afterAll(async () => {
  await t.cleanup();
});

function deps(extra: { handoffs?: { latest(pk: string): Handoff | null; toMarkdown(h: Handoff): string } } = {}) {
  const audit = t.ctx.audit;
  if (!audit) throw new Error('audit missing');
  return {
    sessions: t.ctx.sessions,
    detail: createSessionDetailService(t.ctx),
    links: createLinksService(t.ctx, createPlanFinderFromContext(t.ctx)),
    audit,
    version: '0.0.0',
    now: () => new Date('2026-09-17T12:00:00Z'),
    ...extra,
  };
}

describe('buildSessionExport', () => {
  it('bundles transcript, subagents and derived data', async () => {
    const r = await buildSessionExport(deps(), 'claude', 's-subagents', { redact: true });
    if (!r) throw new Error('expected export');
    const files = unzipSync(r.bytes);
    expect(Object.keys(files).sort()).toEqual([
      'agents.json',
      'audit.json',
      'deliverables.json',
      'files.json',
      'links.json',
      'manifest.json',
      'session.json',
      'stats.json',
      'subagents/agent-ag1.jsonl',
      'subagents/agent-ag1.meta.json',
      'subagents/agent-ag2.jsonl',
      'subagents/agent-ag2.meta.json',
      'subagents/agent-ag3.jsonl',
      'subagents/agent-ag3.meta.json',
      'transcript.jsonl',
    ]);
    const manifest = JSON.parse(strFromU8(files['manifest.json'] ?? new Uint8Array())) as { redacted: boolean; exportedAt: string; files: string[] };
    expect(manifest).toMatchObject({ redacted: true, exportedAt: '2026-09-17T12:00:00.000Z' });
    expect(manifest.files).toContain('transcript.jsonl');
    expect(r.filename).toBe('claude-s-subagents.zip');
  });

  it('includes a redacted handoff when a handoff service is present', async () => {
    const handoff: Handoff = {
      id: 'h1', sessionId: 's-basic', status: 'done', summary: 's', evidence: [], files: [], nextSteps: [], blockers: [], links: [], createdAt: '2026-09-17T00:00:00Z',
    };
    const r = await buildSessionExport(
      deps({ handoffs: { latest: () => handoff, toMarkdown: () => '# Handoff\nPGPASSWORD=hunter2' } }),
      'claude',
      's-basic',
      { redact: true },
    );
    const files = unzipSync(r?.bytes ?? new Uint8Array());
    expect(strFromU8(files['handoff.md'] ?? new Uint8Array())).toBe('# Handoff\nPGPASSWORD=«redacted:secret»');
    expect(files['recap.md']).toBeUndefined();
  });

  it('returns null for unknown sessions and enforces the size cap', async () => {
    expect(await buildSessionExport(deps(), 'claude', 'nope', { redact: true })).toBeNull();
    await expect(buildSessionExport(deps(), 'claude', 's-basic', { redact: true, maxBytes: 10 })).rejects.toBeInstanceOf(ExportTooLargeError);
  });
});

describe('GET /api/sessions/:source/:id/export', () => {
  const req = (query = '') => t.request(`/api/sessions/claude/s-drift/export${query}`);

  it('is redacted by default', async () => {
    const res = await req();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="claude-s-drift.zip"');
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const transcript = strFromU8(files['transcript.jsonl'] ?? new Uint8Array());
    expect(transcript).toContain('«redacted:secret»');
    expect(transcript).not.toContain('hunter2');
  });

  it('requires confirmation for an unredacted export, and audits both exports', async () => {
    const unconfirmed = await req('?redact=false');
    expect(unconfirmed.status).toBe(409);
    const body = (await unconfirmed.json()) as { error: { code: string; details: { summary: string } } };
    expect(body.error.code).toBe('confirmation_required');
    expect(body.error.details.summary).toContain('WITHOUT redaction');

    const confirmed = await req('?redact=false&confirm=true');
    expect(confirmed.status).toBe(200);
    const files = unzipSync(new Uint8Array(await confirmed.arrayBuffer()));
    expect(strFromU8(files['transcript.jsonl'] ?? new Uint8Array())).toContain('hunter2');

    const exports = t.ctx.audit?.list({ action: 'session.export', sessionPk: 'claude:s-drift' }) ?? [];
    expect(exports.map((e) => e.params.redact ?? 'true')).toEqual(['false', 'true']);
  });

  it('404s for unknown sessions', async () => {
    const res = await t.request('/api/sessions/claude/nope/export');
    expect(res.status).toBe(404);
  });
});
```

Run: `pnpm vitest run apps/daemon/test/export.test.ts`
Expected: FAIL, `Cannot find module '../src/services/export/export-zip.ts'`

- [ ] **Step 3: Implement the builder**

`apps/daemon/src/services/export/export-zip.ts`
```ts
import { readFile } from 'node:fs/promises';
import { type Handoff, type Source, redact, redactDeep } from '@orc/core';
import { type Zippable, strToU8, zipSync } from 'fflate';
import type { AuditService } from '../audit/audit.ts';
import type { LinksService } from '../links/links.ts';
import type { SessionDetailService } from '../session-detail/detail.ts';
import type { SessionService } from '../sessions.ts';

export interface ExportDeps {
  sessions: Pick<SessionService, 'get' | 'agents'>;
  detail: SessionDetailService;
  links: LinksService;
  audit: AuditService;
  handoffs?: { latest(sessionPk: string): Handoff | null; toMarkdown(h: Handoff): string };
  version: string;
  now?: () => Date;
}

export interface ExportManifest {
  formatVersion: 1;
  sessionPk: string;
  source: Source;
  id: string;
  exportedAt: string;
  appVersion: string;
  redacted: boolean;
  files: string[];
  notes: string[];
}

export interface ExportResult {
  filename: string;
  bytes: Uint8Array;
  manifest: ExportManifest;
}

export class ExportTooLargeError extends Error {
  constructor(bytes: number, max: number) {
    super(`export would be ${bytes} bytes, above the ${max} byte limit`);
    this.name = 'ExportTooLargeError';
  }
}

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

async function readJsonl(path: string, doRedact: boolean): Promise<string | null> {
  if (!path.endsWith('.jsonl')) return null;
  try {
    const text = await readFile(path, 'utf8');
    return doRedact ? text.split('\n').map((l) => redact(l)).join('\n') : text;
  } catch {
    return null;
  }
}

export async function buildSessionExport(
  deps: ExportDeps,
  source: Source,
  id: string,
  opts: { redact: boolean; maxBytes?: number },
): Promise<ExportResult | null> {
  const session = deps.sessions.get(source, id);
  if (!session) return null;
  const pk = `${source}:${id}`;
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = deps.now?.() ?? new Date();
  const clean = <T>(v: T): T => (opts.redact ? redactDeep(v) : v);
  const json = (v: unknown) => strToU8(`${JSON.stringify(clean(v), null, 2)}\n`);

  const files: Zippable = {};
  const notes: string[] = [];
  let total = 0;
  const add = (name: string, data: Uint8Array) => {
    total += data.byteLength;
    if (total > max) throw new ExportTooLargeError(total, max);
    files[name] = data;
  };

  add('session.json', json(session));

  const transcript = session.transcriptPath ? await readJsonl(session.transcriptPath, opts.redact) : null;
  if (transcript !== null) add('transcript.jsonl', strToU8(transcript));
  else {
    notes.push(
      session.transcriptPath
        ? 'transcript is archived or unreadable; restore it to include it'
        : 'no transcript on disk (prompts-only or remote session)',
    );
  }

  const agents = deps.sessions.agents(source, id);
  for (const a of agents) {
    const text = await readJsonl(a.transcriptPath, opts.redact);
    if (text !== null) add(`subagents/agent-${a.id}.jsonl`, strToU8(text));
    else notes.push(`subagent ${a.id} transcript unavailable`);
    const meta = await readFile(a.transcriptPath.replace(/\.jsonl$/, '.meta.json'), 'utf8').catch(() => null);
    if (meta !== null) add(`subagents/agent-${a.id}.meta.json`, strToU8(opts.redact ? redact(meta) : meta));
  }
  add('agents.json', json(agents));

  const stats = deps.detail.stats(source, id);
  if (stats) add('stats.json', json(stats));
  const deliverables = deps.detail.deliverables(source, id);
  if (deliverables) add('deliverables.json', json(deliverables));
  const fileSummaries = deps.detail.files(source, id);
  if (fileSummaries) add('files.json', json(fileSummaries));
  const links = await deps.links.forSession(source, id);
  if (links) add('links.json', json(links));
  add('audit.json', json(deps.audit.list({ sessionPk: pk, limit: 1000 })));

  if (session.recap) add('recap.md', strToU8(`${clean(session.recap)}\n`));
  const handoff = deps.handoffs?.latest(pk) ?? null;
  if (handoff && deps.handoffs) add('handoff.md', strToU8(clean(deps.handoffs.toMarkdown(handoff))));

  const manifest: ExportManifest = {
    formatVersion: 1,
    sessionPk: pk,
    source,
    id,
    exportedAt: now.toISOString(),
    appVersion: deps.version,
    redacted: opts.redact,
    files: [...Object.keys(files), 'manifest.json'].sort(),
    notes,
  };
  files['manifest.json'] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);

  return {
    filename: `${source}-${id.replace(/[^A-Za-z0-9._-]/g, '_')}.zip`,
    bytes: zipSync(files, { level: 6, mtime: now }),
    manifest,
  };
}
```

- [ ] **Step 4: Implement the route**

`apps/daemon/src/http/routes/export.ts`
```ts
import { ExportQuery, apiError } from '@orc/api-contract';
import { CORE_VERSION } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { ExportTooLargeError, buildSessionExport } from '../../services/export/export-zip.ts';
import { createLinksService } from '../../services/links/links.ts';
import { createPlanFinderFromContext } from '../../services/links/plans.ts';
import { createSessionDetailService } from '../../services/session-detail/detail.ts';
import type { OrcApp } from '../types.ts';
import { sessionParams } from './session-detail.ts';

export function registerExportRoutes(app: OrcApp, ctx: DaemonContext): void {
  const detail = createSessionDetailService(ctx);
  const links = createLinksService(ctx, createPlanFinderFromContext(ctx));

  app.get('/api/sessions/:source/:id/export', async (c) => {
    const p = sessionParams(c);
    if (!p) return c.json(apiError('not_found', 'session not found'), 404);
    const q = ExportQuery.safeParse(c.req.query());
    if (!q.success) return c.json(apiError('validation_failed', 'invalid export query', q.error.issues), 400);
    const redact = q.data.redact === 'true';
    if (!redact && q.data.confirm !== 'true') {
      return c.json(
        apiError('confirmation_required', 'an unredacted export needs confirmation', {
          summary: `Export ${p.source}:${p.id} WITHOUT redaction. The ZIP may contain tokens and passwords.`,
        }),
        409,
      );
    }
    if (!ctx.audit) return c.json(apiError('unavailable', 'audit service missing'), 503);
    try {
      const r = await buildSessionExport(
        { sessions: ctx.sessions, detail, links, audit: ctx.audit, handoffs: ctx.handoffs, version: CORE_VERSION },
        p.source,
        p.id,
        { redact },
      );
      if (!r) return c.json(apiError('not_found', 'session not found'), 404);
      const body = r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength) as ArrayBuffer;
      return c.body(body, 200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${r.filename}"`,
        'cache-control': 'no-store',
      });
    } catch (err) {
      if (err instanceof ExportTooLargeError) return c.json(apiError('export_too_large', err.message), 413);
      throw err;
    }
  });
}
```

`apps/daemon/src/http/app.ts` → `createApp(o)` (A1), before the `/api/*` catch-all:
```ts
import { registerExportRoutes } from './routes/export.ts';
registerExportRoutes(app, o.ctx);
```

If `ctx.handoffs` is typed in `context.ts` as a Phase 5 interface that isn't declared yet, keep it `unknown` there and pass `handoffs: undefined` here with a one-line comment `// wired in Phase 5`. The builder is already null-safe.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/test/export.test.ts apps/daemon/test/audit.coverage.test.ts`
Expected: PASS (6 + 2 tests)

- [ ] **Step 6: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(daemon): add redacted-by-default session export zip with fflate"
```

---

### Task 13: Web data layer — query hooks, live invalidation, view-mode and palette stores

**Files:**
- Create: `apps/web/src/api/queries/session-detail.ts`, `apps/web/src/api/queries/audit.ts`, `apps/web/src/api/queries/safety.ts`, `apps/web/src/api/live-p3.ts`
- Create: `apps/web/src/stores/view-mode.ts`, `apps/web/src/stores/palette.ts`, `apps/web/src/test/p3-render.tsx`
- Test: `apps/web/src/api/queries/p3-queries.test.tsx`
- Modify: `apps/web/src/api/live-events.ts` (A8), `apps/web/package.json`

**Interfaces:**
- Consumes: `getApiClient`, `setApiClientForTests`, `ApiClient`, `sessionsAgents` (A9); Task 5 client methods; `AuditQuery`, `LiveEvent` (api-contract); P2 `applyLiveEvent` (A8)
- Produces:
  ```ts
  // api/queries/session-detail.ts
  export const detailKeys: { agents(s: Source, id: string): readonly unknown[]; stats(...); deliverables(...); files(...); usage(...); safety(...); links(...); raw(s: Source, id: string, agentId: string | null): readonly unknown[] }
  export function useSessionAgents(source: Source, id: string): UseQueryResult<AgentNode[]>
  export function useSessionStats(source: Source, id: string): UseQueryResult<SessionStatsResponse>
  export function useSessionDeliverables(source: Source, id: string): UseQueryResult<TurnDeliverables[]>
  export function useSessionFiles(source: Source, id: string): UseQueryResult<FileSummary[]>
  export function useSessionUsageSeries(source: Source, id: string): UseQueryResult<UsagePoint[]>
  export function useSessionSafety(source: Source, id: string): UseQueryResult<SessionSafety>
  export function useSessionLinks(source: Source, id: string): UseQueryResult<SessionLinks>
  export function useSessionRaw(source: Source, id: string, agentId: string | null): UseInfiniteQueryResult<InfiniteData<RawPage, number>>
  export function downloadSessionExport(source: Source, id: string, opts: { redact: boolean }): Promise<void>
  // api/queries/audit.ts
  export type AuditFilter = Partial<AuditQuery>
  export function useAudit(filter: AuditFilter): UseQueryResult<AuditEntry[]>
  // api/queries/safety.ts
  export function useSecretsReport(): UseQueryResult<SecretsReport>
  export function usePlans(q: string): UseQueryResult<PlanRef[]>
  export function usePlanContent(path: string | null): UseQueryResult<PlanContent>
  // api/live-p3.ts
  export function applyP3LiveEvent(qc: QueryClient, e: LiveEvent): void
  // stores
  export type ViewMode = 'summary' | 'normal' | 'verbose'
  export const useViewModeStore: UseBoundStore<StoreApi<{ mode: ViewMode; setMode(m: ViewMode): void }>>
  export const usePaletteStore: UseBoundStore<StoreApi<{ open: boolean; setOpen(v: boolean): void; toggle(): void }>>
  // test/p3-render.tsx
  export function makeQueryClient(): QueryClient
  export function wrapperFor(client: QueryClient): (p: { children: ReactNode }) => ReactElement
  export function renderP3(ui: ReactElement, opts?: { client?: QueryClient }): RenderResult & { client: QueryClient }
  export function fakeApi(methods: Partial<ApiClient>): ApiClient
  ```

- [ ] **Step 1: Add the dependencies**

Run:
```bash
npm view @testing-library/user-event version
pnpm --filter @orc/web add @xyflow/react@^12.11.6 echarts@^6.1.0 cmdk@^1.1.1 zod@^4.6.5
```
Expected: `14.6.7` is printed; Phase 1 already added `@testing-library/user-event@^14.6.7`. The packages that Phases 1–2 already added (`@orc/*`, `zustand`, TanStack) are left unchanged.

- [ ] **Step 2: Write the test helper and the failing test**

`apps/web/src/test/p3-render.tsx`
```tsx
import type { ApiClient } from '@orc/api-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';

export function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } } });
}

export function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }): ReactElement {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

export function renderP3(ui: ReactElement, opts: { client?: QueryClient } = {}): RenderResult & { client: QueryClient } {
  const client = opts.client ?? makeQueryClient();
  return { client, ...render(ui, { wrapper: wrapperFor(client) }) };
}

export function fakeApi(methods: Partial<ApiClient>): ApiClient {
  return methods as ApiClient;
}
```

`apps/web/src/api/queries/p3-queries.test.tsx`
```tsx
import type { RawPage, SessionStatsResponse } from '@orc/api-contract';
import type { Session } from '@orc/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useViewModeStore } from '../../stores/view-mode.ts';
import { fakeApi, makeQueryClient, wrapperFor } from '../../test/p3-render.tsx';
import { setApiClientForTests } from '../client.ts';
import { applyP3LiveEvent } from '../live-p3.ts';
import { usePlans } from './safety.ts';
import { detailKeys, useSessionRaw, useSessionStats } from './session-detail.ts';

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null };
const stats: SessionStatsResponse = {
  session: { turns: 1, wallMs: 1, modelMs: 1, toolMs: 0, ttftMs: null, toolCalls: 0, toolErrors: 0, apiErrors: 0, usage: emptyUsage, tokensPerSec: null, cacheHitRate: null },
  turns: [],
  agents: [],
};

describe('session detail hooks', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('useSessionStats fetches and caches under the session key', async () => {
    const sessionsStats = vi.fn(async () => stats);
    setApiClientForTests(fakeApi({ sessionsStats }));
    const client = makeQueryClient();
    const { result } = renderHook(() => useSessionStats('claude', 's-basic'), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(stats);
    expect(sessionsStats).toHaveBeenCalledWith('claude', 's-basic');
    expect(client.getQueryData(detailKeys.stats('claude', 's-basic'))).toEqual(stats);
  });

  it('useSessionRaw pages by byte offset', async () => {
    const pages: RawPage[] = [
      { path: '/x', items: [{ offset: 0, text: '{}', truncated: false, partial: false }], nextOffset: 10 },
      { path: '/x', items: [{ offset: 10, text: '{}', truncated: false, partial: false }], nextOffset: null },
    ];
    const sessionsRaw = vi.fn(async (_s: string, _i: string, q: { offset?: number }) => (q.offset === 10 ? pages[1] : pages[0]) as RawPage);
    setApiClientForTests(fakeApi({ sessionsRaw }));
    const { result } = renderHook(() => useSessionRaw('claude', 's-basic', 'ag1'), { wrapper: wrapperFor(makeQueryClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(result.current.data?.pages).toHaveLength(2);
    expect(result.current.hasNextPage).toBe(false);
    expect(sessionsRaw).toHaveBeenLastCalledWith('claude', 's-basic', { agentId: 'ag1', offset: 10, limit: 200 });
  });

  it('usePlans waits for two characters', async () => {
    const plansList = vi.fn(async () => []);
    setApiClientForTests(fakeApi({ plansList }));
    const { result, rerender } = renderHook(({ q }) => usePlans(q), {
      wrapper: wrapperFor(makeQueryClient()),
      initialProps: { q: 'a' },
    });
    expect(result.current.fetchStatus).toBe('idle');
    rerender({ q: 'sa' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(plansList).toHaveBeenCalledWith('sa', 10);
  });
});

describe('applyP3LiveEvent', () => {
  it('invalidates derived session queries and audit lists', async () => {
    const qc = makeQueryClient();
    qc.setQueryData(['session', 'claude', 's1'], { id: 's1' });
    qc.setQueryData(detailKeys.stats('claude', 's1'), stats);
    qc.setQueryData(['audit', {}], []);
    const session = { id: 's1', source: 'claude' } as Session;
    applyP3LiveEvent(qc, { type: 'session.updated', session });
    expect(qc.getQueryState(detailKeys.stats('claude', 's1'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['session', 'claude', 's1'])?.isInvalidated).toBe(false);
    applyP3LiveEvent(qc, {
      type: 'audit.recorded',
      entry: { id: 'a', ts: 't', actor: 'user', actorDetail: null, action: 'session.resume', target: null, params: {}, result: 'ok', error: null },
    });
    expect(qc.getQueryState(['audit', {}])?.isInvalidated).toBe(true);
  });
});

describe('useViewModeStore', () => {
  it('defaults to normal and switches', () => {
    expect(useViewModeStore.getState().mode).toBe('normal');
    act(() => useViewModeStore.getState().setMode('verbose'));
    expect(useViewModeStore.getState().mode).toBe('verbose');
  });
});
```

Run: `pnpm vitest run apps/web/src/api/queries/p3-queries.test.tsx`
Expected: FAIL, `Cannot find module '../live-p3.ts'`

- [ ] **Step 3: Implement the hooks, stores and live handler**

`apps/web/src/api/queries/session-detail.ts`
```ts
import type { Source } from '@orc/core';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

const STALE_MS = 5_000;

export const detailKeys = {
  agents: (s: Source, id: string) => ['session', s, id, 'agents'] as const,
  stats: (s: Source, id: string) => ['session', s, id, 'stats'] as const,
  deliverables: (s: Source, id: string) => ['session', s, id, 'deliverables'] as const,
  files: (s: Source, id: string) => ['session', s, id, 'files'] as const,
  usage: (s: Source, id: string) => ['session', s, id, 'usage'] as const,
  safety: (s: Source, id: string) => ['session', s, id, 'safety'] as const,
  links: (s: Source, id: string) => ['session', s, id, 'links'] as const,
  raw: (s: Source, id: string, agentId: string | null) => ['session', s, id, 'raw', agentId ?? 'main'] as const,
};

export function useSessionAgents(source: Source, id: string) {
  return useQuery({ queryKey: detailKeys.agents(source, id), queryFn: () => getApiClient().sessionsAgents(source, id), staleTime: STALE_MS });
}

export function useSessionStats(source: Source, id: string) {
  return useQuery({ queryKey: detailKeys.stats(source, id), queryFn: () => getApiClient().sessionsStats(source, id), staleTime: STALE_MS });
}

export function useSessionDeliverables(source: Source, id: string) {
  return useQuery({
    queryKey: detailKeys.deliverables(source, id),
    queryFn: () => getApiClient().sessionsDeliverables(source, id),
    staleTime: STALE_MS,
  });
}

export function useSessionFiles(source: Source, id: string) {
  return useQuery({ queryKey: detailKeys.files(source, id), queryFn: () => getApiClient().sessionsFiles(source, id), staleTime: STALE_MS });
}

export function useSessionUsageSeries(source: Source, id: string) {
  return useQuery({
    queryKey: detailKeys.usage(source, id),
    queryFn: () => getApiClient().sessionsUsageSeries(source, id),
    staleTime: STALE_MS,
  });
}

export function useSessionSafety(source: Source, id: string) {
  return useQuery({ queryKey: detailKeys.safety(source, id), queryFn: () => getApiClient().sessionsSafety(source, id), staleTime: STALE_MS });
}

export function useSessionLinks(source: Source, id: string) {
  return useQuery({ queryKey: detailKeys.links(source, id), queryFn: () => getApiClient().sessionsLinks(source, id), staleTime: 30_000 });
}

export function useSessionRaw(source: Source, id: string, agentId: string | null) {
  return useInfiniteQuery({
    queryKey: detailKeys.raw(source, id, agentId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getApiClient().sessionsRaw(source, id, { agentId, offset: pageParam, limit: 200 }),
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  });
}

export async function downloadSessionExport(source: Source, id: string, opts: { redact: boolean }): Promise<void> {
  const blob = await getApiClient().sessionsExport(source, id, opts);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${source}-${id}${opts.redact ? '' : '-UNREDACTED'}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
```

`apps/web/src/api/queries/audit.ts`
```ts
import type { AuditQuery } from '@orc/api-contract';
import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export type AuditFilter = Partial<AuditQuery>;

export function useAudit(filter: AuditFilter) {
  return useQuery({ queryKey: ['audit', filter], queryFn: () => getApiClient().auditList(filter), staleTime: 2_000 });
}
```

`apps/web/src/api/queries/safety.ts`
```ts
import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export function useSecretsReport() {
  return useQuery({ queryKey: ['safety', 'secrets'], queryFn: () => getApiClient().safetySecrets(), staleTime: 60_000 });
}

export function usePlans(q: string) {
  const query = q.trim();
  return useQuery({
    queryKey: ['plans', query],
    queryFn: () => getApiClient().plansList(query, 10),
    enabled: query.length >= 2,
    staleTime: 30_000,
  });
}

export function usePlanContent(path: string | null) {
  return useQuery({
    queryKey: ['plan', path],
    queryFn: () => getApiClient().plansContent(path ?? ''),
    enabled: path !== null,
    staleTime: 30_000,
  });
}
```

`apps/web/src/api/live-p3.ts`
```ts
import type { LiveEvent } from '@orc/api-contract';
import type { QueryClient } from '@tanstack/react-query';

/** Phase 3 cache effects of live events. Called by useLiveEvents() after its own Phase 2 handling. */
export function applyP3LiveEvent(qc: QueryClient, e: LiveEvent): void {
  switch (e.type) {
    case 'session.updated':
      void qc.invalidateQueries({
        queryKey: ['session', e.session.source, e.session.id],
        predicate: (q) => q.queryKey.length > 3,
      });
      return;
    case 'audit.recorded':
      void qc.invalidateQueries({ queryKey: ['audit'] });
      return;
    default:
      return;
  }
}
```

`apps/web/src/stores/view-mode.ts`
```ts
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ViewMode = 'summary' | 'normal' | 'verbose';

interface ViewModeState {
  mode: ViewMode;
  setMode(mode: ViewMode): void;
}

export const useViewModeStore = create<ViewModeState>()(
  persist((set) => ({ mode: 'normal', setMode: (mode) => set({ mode }) }), {
    name: 'orc.viewMode',
    storage: createJSONStorage(() => localStorage),
  }),
);
```

`apps/web/src/stores/palette.ts`
```ts
import { create } from 'zustand';

interface PaletteState {
  open: boolean;
  setOpen(open: boolean): void;
  toggle(): void;
}

export const usePaletteStore = create<PaletteState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
```

In `apps/web/src/api/live-events.ts` (A8), call the Phase 3 handler at the end of `applyLiveEvent(qc, e)`, so that both `useLiveEvents()` and its tests go through it:
```ts
import { applyP3LiveEvent } from './live-p3.ts';
// …last statement of applyLiveEvent(qc, e):
applyP3LiveEvent(qc, e);
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run apps/web/src/api/queries/p3-queries.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): add session detail, audit and safety query hooks, view-mode and palette stores"
```

---

### Task 14: Trajectory timeline — view modes, grouped tools, step inspector, turn stats, deliverables row

**Files:**
- Create: `apps/web/src/features/session-detail/timeline/format.ts`, `apps/web/src/features/session-detail/timeline/group-events.ts`, `apps/web/src/features/session-detail/timeline/timeline-pure.test.ts`
- Create: `apps/web/src/features/session-detail/timeline/StepInspector.tsx`, `TurnStatsBar.tsx`, `DeliverablesRow.tsx`, `ViewModeToggle.tsx`, `TrajectoryTimeline.tsx`, `TrajectoryTimeline.test.tsx`

**Interfaces:**
- Consumes: `useSessionEvents(source, id, agentId)` (A10); `mcpToolLabel` (`@orc/core/browser`, A5); `useSessionStats`, `useSessionDeliverables`, `useViewModeStore`, `ViewMode` (Task 13); core types `TimelineEvent`, `TurnStats`, `SessionStats`, `DeliverableFile`
- Produces:
  ```ts
  // format.ts
  export function formatMs(ms: number | null): string
  export function formatPct(r: number | null): string
  export function formatRate(tps: number | null): string
  export function formatTokens(n: number): string
  export function statsSummary(s: Pick<SessionStats, 'modelMs' | 'toolMs' | 'ttftMs' | 'tokensPerSec' | 'cacheHitRate'>): string[]
  export function toolLabel(tool: string): string                 // delegates to P1 mcpToolLabel: mcp__claude_ai_Linear__save_issue → "Linear save_issue"
  export function inputSummary(e: TimelineEvent): string
  export function shortPath(p: string): string
  // group-events.ts
  export interface ToolStep { call: TimelineEvent; result: TimelineEvent | null }
  export type TrajectoryItem =
    | { kind: 'text'; key: string; event: TimelineEvent }
    | { kind: 'thinking'; key: string; event: TimelineEvent }
    | { kind: 'tool_group'; key: string; label: string; calls: ToolStep[] }
    | { kind: 'tool'; key: string; label: string; step: ToolStep }
    | { kind: 'marker'; key: string; event: TimelineEvent }
  export interface TurnView { key: string; turn: number; agentId: string | null; prompt: TimelineEvent | null; items: TrajectoryItem[] }
  export const turnKey: (agentId: string | null, turn: number) => string   // "main:1" | "ag1:0"
  export function buildTurnViews(events: readonly TimelineEvent[], mode: ViewMode): TurnView[]
  // components
  export function StepInspector(props: { step: ToolStep; onClose: () => void }): JSX.Element
  export function TurnStatsBar(props: { stats: TurnStats | undefined }): JSX.Element | null
  export function DeliverablesRow(props: { files: DeliverableFile[]; onOpenFile: (path: string) => void }): JSX.Element | null
  export function ViewModeToggle(): JSX.Element
  export function TrajectoryTimeline(props: { source: Source; id: string; agentId: string | null; onOpenFile: (path: string) => void }): JSX.Element
  ```

The three view modes:
- **Summary** shows prompts, turn stats and deliverables only.
- **Normal** shows text, consecutive same-tool calls collapsed into "Bash ×N" groups, and markers.
- **Verbose** also shows every tool call on its own and all thinking blocks.

Clicking a tool step opens the inspector with its tokens, duration, model, input and output. The timeline follows new output until you scroll up.

- [ ] **Step 1: Write the failing pure-function test**

`apps/web/src/features/session-detail/timeline/timeline-pure.test.ts`
```ts
import type { TimelineEvent } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { formatMs, formatPct, formatTokens, inputSummary, shortPath, statsSummary, toolLabel } from './format.ts';
import { buildTurnViews } from './group-events.ts';

let seq = 0;
const ev = (p: Partial<TimelineEvent> & Pick<TimelineEvent, 'kind'>): TimelineEvent => {
  seq += 1;
  return {
    sessionId: 's', agentId: null, uuid: `u${seq}`, parentUuid: null, seq, ts: `2026-09-01T09:00:${String(seq).padStart(2, '0')}.000Z`,
    turn: 1, text: null, tool: null, toolUseId: null, mcpServer: null, input: null, messageId: null, model: null, usage: null, durationMs: null,
    ...p,
  };
};

function sample(): TimelineEvent[] {
  seq = 0;
  return [
    ev({ kind: 'prompt', text: 'check tests' }),
    ev({ kind: 'assistant_text', text: 'Running' }),
    ev({ kind: 'tool_call', tool: 'Bash', toolUseId: 'b1', input: { command: 'pnpm test' } }),
    ev({ kind: 'tool_result', toolUseId: 'b1', text: 'ok' }),
    ev({ kind: 'tool_call', tool: 'Bash', toolUseId: 'b2', input: { command: 'pnpm lint' } }),
    ev({ kind: 'tool_result', toolUseId: 'b2', text: 'ok' }),
    ev({ kind: 'thinking', text: 'hmm' }),
    ev({ kind: 'tool_call', tool: 'mcp__claude_ai_Linear__save_issue', toolUseId: 'l1', input: { id: 'SAF-1' } }),
    ev({ kind: 'system', durationMs: 36000 }),
    ev({ kind: 'prompt', turn: 2, text: 'continue' }),
  ];
}

describe('buildTurnViews', () => {
  it('groups consecutive same-tool calls in normal mode', () => {
    const [t1, t2] = buildTurnViews(sample(), 'normal');
    expect(t1?.key).toBe('main:1');
    expect(t1?.prompt?.text).toBe('check tests');
    expect(t1?.items.map((i) => (i.kind === 'tool_group' ? `${i.label}×${i.calls.length}` : i.kind))).toEqual([
      'text',
      'Bash×2',
      'Linear save_issue×1',
      'marker',
    ]);
    const group = t1?.items[1];
    expect(group?.kind === 'tool_group' && group.calls[0]?.result?.text).toBe('ok');
    const linear = t1?.items[2];
    expect(linear?.kind === 'tool_group' && linear.calls[0]?.result).toBeNull();
    expect(t2).toMatchObject({ key: 'main:2', items: [] });
  });

  it('shows every step and thinking in verbose mode', () => {
    const [t1] = buildTurnViews(sample(), 'verbose');
    expect(t1?.items.map((i) => i.kind)).toEqual(['text', 'tool', 'tool', 'thinking', 'tool', 'marker']);
  });

  it('keeps only prompts in summary mode', () => {
    const views = buildTurnViews(sample(), 'summary');
    expect(views.map((v) => [v.prompt?.text, v.items.length])).toEqual([
      ['check tests', 0],
      ['continue', 0],
    ]);
  });

  it('separates agent transcripts', () => {
    seq = 0;
    const views = buildTurnViews([ev({ kind: 'assistant_text', agentId: 'ag1', turn: 0, text: 'x' })], 'normal');
    expect(views[0]).toMatchObject({ key: 'ag1:0', prompt: null });
  });
});

describe('format helpers', () => {
  it.each([
    [null, '—'],
    [950, '950ms'],
    [10800, '10.8s'],
    [125000, '2m 5s'],
  ] as const)('formatMs(%s) = %s', (ms, out) => {
    expect(formatMs(ms)).toBe(out);
  });

  it('formats other values', () => {
    expect(formatPct(0.948)).toBe('95%');
    expect(formatPct(null)).toBe('—');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(2100)).toBe('2.1k');
    expect(formatTokens(3_400_000)).toBe('3.40M');
    expect(statsSummary({ modelMs: 10800, toolMs: 25200, ttftMs: 5000, tokensPerSec: 2.5, cacheHitRate: 0.948 })).toEqual([
      'model 10.8s',
      'tools 25.2s',
      'TTFT ≈5.0s',
      '2.5 tok/s',
      'cache 95%',
    ]);
  });

  it('labels tools and summarizes inputs', () => {
    expect(toolLabel('mcp__claude_ai_Linear__save_issue')).toBe('Linear save_issue');
    expect(toolLabel('Bash')).toBe('Bash');
    seq = 0;
    expect(inputSummary(ev({ kind: 'tool_call', input: { command: 'pnpm test' } }))).toBe('pnpm test');
    expect(inputSummary(ev({ kind: 'tool_call', input: { file_path: '/a/b.ts', old_string: 'x' } }))).toBe('/a/b.ts');
    expect(inputSummary(ev({ kind: 'tool_call', input: { id: 'SAF-1' } }))).toBe('{"id":"SAF-1"}');
    expect(shortPath('/Users/test/Wakecap/Backend/svc/a.ts')).toBe('…/svc/a.ts');
    expect(shortPath('a.ts')).toBe('a.ts');
  });
});
```

Run: `pnpm vitest run apps/web/src/features/session-detail/timeline/timeline-pure.test.ts`
Expected: FAIL, `Cannot find module './format.ts'`

- [ ] **Step 2: Implement the pure modules**

`apps/web/src/features/session-detail/timeline/format.ts`
```ts
import type { SessionStats, TimelineEvent } from '@orc/core';
import { mcpToolLabel } from '@orc/core/browser';

export function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function formatPct(r: number | null): string {
  return r === null ? '—' : `${Math.round(r * 100)}%`;
}

export function formatRate(tps: number | null): string {
  return tps === null ? '— tok/s' : `${tps.toFixed(1)} tok/s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function statsSummary(
  s: Pick<SessionStats, 'modelMs' | 'toolMs' | 'ttftMs' | 'tokensPerSec' | 'cacheHitRate'>,
): string[] {
  return [
    `model ${formatMs(s.modelMs)}`,
    `tools ${formatMs(s.toolMs)}`,
    `TTFT ≈${formatMs(s.ttftMs)}`,
    formatRate(s.tokensPerSec),
    `cache ${formatPct(s.cacheHitRate)}`,
  ];
}

/** One labelling rule for the whole app (Phase 1 core). */
export function toolLabel(tool: string): string {
  return mcpToolLabel(tool);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function inputSummary(e: TimelineEvent): string {
  const input = e.input;
  if (isObj(input)) {
    for (const k of ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'description', 'skill']) {
      const v = input[k];
      if (typeof v === 'string') return v.slice(0, 120);
      if (k === 'command' && Array.isArray(v)) return v.join(' ').slice(0, 120);
    }
  }
  if (typeof input === 'string') return input.slice(0, 120);
  return input === null ? '' : JSON.stringify(input).slice(0, 120);
}

export function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}
```

`apps/web/src/features/session-detail/timeline/group-events.ts`
```ts
import type { TimelineEvent } from '@orc/core';
import type { ViewMode } from '../../../stores/view-mode.ts';
import { toolLabel } from './format.ts';

export interface ToolStep {
  call: TimelineEvent;
  result: TimelineEvent | null;
}

export type TrajectoryItem =
  | { kind: 'text'; key: string; event: TimelineEvent }
  | { kind: 'thinking'; key: string; event: TimelineEvent }
  | { kind: 'tool_group'; key: string; label: string; calls: ToolStep[] }
  | { kind: 'tool'; key: string; label: string; step: ToolStep }
  | { kind: 'marker'; key: string; event: TimelineEvent };

export interface TurnView {
  key: string;
  turn: number;
  agentId: string | null;
  prompt: TimelineEvent | null;
  items: TrajectoryItem[];
}

export const turnKey = (agentId: string | null, turn: number) => `${agentId ?? 'main'}:${turn}`;

export function buildTurnViews(events: readonly TimelineEvent[], mode: ViewMode): TurnView[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const results = new Map<string, TimelineEvent>();
  for (const e of sorted) {
    if ((e.kind === 'tool_result' || e.kind === 'error') && e.toolUseId) results.set(e.toolUseId, e);
  }
  const turns: TurnView[] = [];
  let cur: TurnView | null = null;
  for (const e of sorted) {
    if (!cur || cur.turn !== e.turn || cur.agentId !== e.agentId) {
      cur = { key: turnKey(e.agentId, e.turn), turn: e.turn, agentId: e.agentId, prompt: null, items: [] };
      turns.push(cur);
    }
    if (e.kind === 'prompt') {
      if (cur.prompt === null) cur.prompt = e;
      else cur.items.push({ kind: 'text', key: `p-${e.seq}`, event: e });
      continue;
    }
    if (mode === 'summary') continue;
    switch (e.kind) {
      case 'assistant_text':
        cur.items.push({ kind: 'text', key: `x-${e.seq}`, event: e });
        break;
      case 'thinking':
        if (mode === 'verbose') cur.items.push({ kind: 'thinking', key: `k-${e.seq}`, event: e });
        break;
      case 'tool_call': {
        const step: ToolStep = { call: e, result: e.toolUseId ? (results.get(e.toolUseId) ?? null) : null };
        const label = toolLabel(e.tool ?? 'tool');
        if (mode === 'verbose') {
          cur.items.push({ kind: 'tool', key: `t-${e.seq}`, label, step });
          break;
        }
        const last = cur.items.at(-1);
        if (last && last.kind === 'tool_group' && last.label === label) last.calls.push(step);
        else cur.items.push({ kind: 'tool_group', key: `g-${e.seq}`, label, calls: [step] });
        break;
      }
      case 'system':
        cur.items.push({ kind: 'marker', key: `m-${e.seq}`, event: e });
        break;
      case 'error':
        if (!e.toolUseId) cur.items.push({ kind: 'marker', key: `m-${e.seq}`, event: e });
        break;
      default:
        break;
    }
  }
  return turns;
}
```

Run: `pnpm vitest run apps/web/src/features/session-detail/timeline/timeline-pure.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 3: Write the failing component test**

`apps/web/src/features/session-detail/timeline/TrajectoryTimeline.test.tsx`
```tsx
import type { SessionStatsResponse } from '@orc/api-contract';
import type { TimelineEvent, TurnDeliverables } from '@orc/core';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionDeliverables, useSessionStats } from '@/api/queries/session-detail';
import { useSessionEvents } from '@/api/queries/sessions';
import { useViewModeStore } from '@/stores/view-mode';
import { renderP3 } from '@/test/p3-render';
import { TrajectoryTimeline } from './TrajectoryTimeline.tsx';

vi.mock('@/api/queries/sessions', () => ({ useSessionEvents: vi.fn() }));
vi.mock('@/api/queries/session-detail', () => ({ useSessionStats: vi.fn(), useSessionDeliverables: vi.fn() }));

const base = { sessionId: 's-basic', agentId: null, parentUuid: null, turn: 1, text: null, tool: null, toolUseId: null, mcpServer: null, input: null, messageId: null, model: null, usage: null, durationMs: null };
const events: TimelineEvent[] = [
  { ...base, uuid: 'u1', seq: 1, ts: '2026-09-01T09:00:00.000Z', kind: 'prompt', text: 'check the notification service tests' },
  { ...base, uuid: 'a1', seq: 2, ts: '2026-09-01T09:00:05.000Z', kind: 'tool_call', tool: 'Bash', toolUseId: 'tu1', input: { command: 'pnpm vitest run' }, model: 'claude-opus-5', usage: { input: 10, output: 20, cacheRead: 1000, cacheWrite: 100, costUsd: null } },
  { ...base, uuid: 'u2', seq: 3, ts: '2026-09-01T09:00:30.000Z', kind: 'tool_result', toolUseId: 'tu1', text: 'Tests 18 passed (18)' },
  { ...base, uuid: 'a2', seq: 4, ts: '2026-09-01T09:00:35.000Z', kind: 'thinking', text: 'secret plan' },
];
const turnStats = {
  turn: 1, agentId: null, startedAt: '', endedAt: '', wallMs: 36000, modelMs: 10800, toolMs: 25200, reportedMs: 36000, ttftMs: 5000,
  toolCalls: 1, toolErrors: 0, apiErrors: 0, usage: { input: 10, output: 20, cacheRead: 1000, cacheWrite: 100, costUsd: null }, tokensPerSec: 2.5, cacheHitRate: 0.9,
};
const stats: SessionStatsResponse = { session: { ...turnStats, turns: 1 }, turns: [turnStats], agents: [] };
const deliverables: TurnDeliverables[] = [
  { turn: 1, agentId: null, files: [{ path: '/Users/test/Wakecap/Backend/svc/a.ts', tools: ['Edit'], ops: 1, status: 'applied', lastTs: '' }] },
];

beforeEach(() => {
  useViewModeStore.setState({ mode: 'normal' });
  vi.mocked(useSessionEvents).mockReturnValue({
    data: { pages: [{ items: events, nextSeq: null }], pageParams: [0] },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  } as unknown as ReturnType<typeof useSessionEvents>);
  vi.mocked(useSessionStats).mockReturnValue({ data: stats } as unknown as ReturnType<typeof useSessionStats>);
  vi.mocked(useSessionDeliverables).mockReturnValue({ data: deliverables } as unknown as ReturnType<typeof useSessionDeliverables>);
});

describe('TrajectoryTimeline', () => {
  it('renders prompts as headers with stats, grouped tools and deliverables', async () => {
    const onOpenFile = vi.fn();
    renderP3(<TrajectoryTimeline source="claude" id="s-basic" agentId={null} onOpenFile={onOpenFile} />);
    expect(screen.getByRole('heading', { name: 'check the notification service tests' })).toBeDefined();
    expect(screen.getByTestId('turn-stats').textContent).toBe('model 10.8s · tools 25.2s · TTFT ≈5.0s · 2.5 tok/s · cache 90%');
    expect(screen.getByRole('button', { name: 'Bash ×1' })).toBeDefined();
    expect(screen.queryByText('secret plan')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /…\/svc\/a\.ts/ }));
    expect(onOpenFile).toHaveBeenCalledWith('/Users/test/Wakecap/Backend/svc/a.ts');
  });

  it('opens the step inspector from an expanded group', async () => {
    renderP3(<TrajectoryTimeline source="claude" id="s-basic" agentId={null} onOpenFile={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Bash ×1' }));
    await userEvent.click(screen.getByRole('button', { name: 'pnpm vitest run' }));
    const inspector = screen.getByRole('complementary', { name: 'Step inspector' });
    expect(inspector.textContent).toContain('25.0s');
    expect(inspector.textContent).toContain('claude-opus-5');
    expect(screen.getByTestId('step-input').textContent).toContain('"command": "pnpm vitest run"');
    expect(screen.getByTestId('step-output').textContent).toBe('Tests 18 passed (18)');
    await userEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(screen.queryByRole('complementary', { name: 'Step inspector' })).toBeNull();
  });

  it('hides tools in summary mode and shows thinking in verbose mode', () => {
    useViewModeStore.setState({ mode: 'summary' });
    const { rerender } = renderP3(<TrajectoryTimeline source="claude" id="s-basic" agentId={null} onOpenFile={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Bash ×1' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Deliverables' })).toBeDefined();
    useViewModeStore.setState({ mode: 'verbose' });
    rerender(<TrajectoryTimeline source="claude" id="s-basic" agentId={null} onOpenFile={vi.fn()} />);
    expect(screen.getByText('secret plan')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Bash: pnpm vitest run' })).toBeDefined();
  });
});
```

Run: `pnpm vitest run apps/web/src/features/session-detail/timeline/TrajectoryTimeline.test.tsx`
Expected: FAIL, `Cannot find module './TrajectoryTimeline.tsx'`

- [ ] **Step 4: Implement the components**

`apps/web/src/features/session-detail/timeline/StepInspector.tsx`
```tsx
import { formatMs, formatTokens } from './format.ts';
import type { ToolStep } from './group-events.ts';

const MAX_OUTPUT = 20_000;

export function StepInspector({ step, onClose }: { step: ToolStep; onClose: () => void }) {
  const { call, result } = step;
  const duration = result ? Math.max(0, Date.parse(result.ts) - Date.parse(call.ts)) : null;
  const u = call.usage;
  return (
    <aside aria-label="Step inspector" className="w-[420px] shrink-0 overflow-auto border-l border-neutral-200 p-3 text-sm">
      <header className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">{call.tool ?? 'tool'}</h3>
        <button type="button" aria-label="Close inspector" onClick={onClose} className="px-2">
          ×
        </button>
      </header>
      <dl className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-1">
        <dt>Started</dt>
        <dd>{new Date(call.ts).toLocaleTimeString()}</dd>
        <dt>Duration</dt>
        <dd>{result ? formatMs(duration) : 'no result yet'}</dd>
        <dt>Model</dt>
        <dd>{call.model ?? '—'}</dd>
        <dt>Tokens</dt>
        <dd>
          {u
            ? `in ${formatTokens(u.input)} · out ${formatTokens(u.output)} · cache read ${formatTokens(u.cacheRead)} · cache write ${formatTokens(u.cacheWrite)}`
            : 'counted on the first block of this message'}
        </dd>
        {call.mcpServer && (
          <>
            <dt>MCP server</dt>
            <dd>{call.mcpServer}</dd>
          </>
        )}
        {result?.kind === 'error' || result?.text?.trimStart().startsWith('<tool_use_error>') ? (
          <>
            <dt>Status</dt>
            <dd className="text-red-600">failed</dd>
          </>
        ) : null}
      </dl>
      <h4 className="mt-3 font-medium">Input</h4>
      <pre data-testid="step-input" className="whitespace-pre-wrap break-all rounded bg-neutral-50 p-2">
        {JSON.stringify(call.input, null, 2)}
      </pre>
      <h4 className="mt-3 font-medium">Output</h4>
      <pre data-testid="step-output" className="whitespace-pre-wrap break-all rounded bg-neutral-50 p-2">
        {result?.text ? result.text.slice(0, MAX_OUTPUT) : '—'}
      </pre>
    </aside>
  );
}
```

`apps/web/src/features/session-detail/timeline/TurnStatsBar.tsx`
```tsx
import type { TurnStats } from '@orc/core';
import { statsSummary } from './format.ts';

const EXPLAIN =
  'model = wall time − tool time · TTFT ≈ prompt → first recorded assistant block (upper bound) · tok/s = output ÷ model time · cache = read ÷ (input + read + write)';

export function TurnStatsBar({ stats }: { stats: TurnStats | undefined }) {
  if (!stats) return null;
  return (
    <p data-testid="turn-stats" title={EXPLAIN} className="text-xs text-neutral-500">
      {statsSummary(stats).join(' · ')}
    </p>
  );
}
```

`apps/web/src/features/session-detail/timeline/DeliverablesRow.tsx`
```tsx
import type { DeliverableFile } from '@orc/core';
import { shortPath } from './format.ts';

const MARK: Record<DeliverableFile['status'], string> = { applied: '', failed: ' ✗', pending: ' …' };
const TONE: Record<DeliverableFile['status'], string> = {
  applied: 'border-emerald-300 bg-emerald-50',
  failed: 'border-red-300 bg-red-50 line-through',
  pending: 'border-amber-300 bg-amber-50',
};

export function DeliverablesRow({ files, onOpenFile }: { files: DeliverableFile[]; onOpenFile: (path: string) => void }) {
  if (files.length === 0) return null;
  return (
    <ul aria-label="Deliverables" className="mt-2 flex flex-wrap gap-1">
      {files.map((f) => (
        <li key={f.path}>
          <button
            type="button"
            onClick={() => onOpenFile(f.path)}
            title={`${f.path} — ${f.tools.join(', ')} ×${f.ops} — ${f.status}`}
            className={`rounded border px-2 py-0.5 font-mono text-xs ${TONE[f.status]}`}
          >
            {shortPath(f.path)}
            {MARK[f.status]}
          </button>
        </li>
      ))}
    </ul>
  );
}
```

`apps/web/src/features/session-detail/timeline/ViewModeToggle.tsx`
```tsx
import { type ViewMode, useViewModeStore } from '../../../stores/view-mode.ts';

const MODES: Array<{ id: ViewMode; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'normal', label: 'Normal' },
  { id: 'verbose', label: 'Verbose' },
];

export function ViewModeToggle() {
  const mode = useViewModeStore((s) => s.mode);
  const setMode = useViewModeStore((s) => s.setMode);
  return (
    <div role="radiogroup" aria-label="View mode" className="inline-flex rounded border border-neutral-200 text-xs">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={mode === m.id}
          onClick={() => setMode(m.id)}
          className={`px-2 py-1 ${mode === m.id ? 'bg-neutral-900 text-white' : ''}`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
```

`apps/web/src/features/session-detail/timeline/TrajectoryTimeline.tsx`
```tsx
import type { DeliverableFile, Source, TurnStats } from '@orc/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSessionDeliverables, useSessionStats } from '@/api/queries/session-detail';
import { useSessionEvents } from '@/api/queries/sessions';
import { useViewModeStore } from '@/stores/view-mode';
import { DeliverablesRow } from './DeliverablesRow.tsx';
import { StepInspector } from './StepInspector.tsx';
import { TurnStatsBar } from './TurnStatsBar.tsx';
import { formatMs, inputSummary, statsSummary } from './format.ts';
import { type TrajectoryItem, type ToolStep, buildTurnViews, turnKey } from './group-events.ts';

interface Props {
  source: Source;
  id: string;
  agentId: string | null;
  onOpenFile: (path: string) => void;
}

const PROMPT_MAX = 300;

function ItemView({
  item,
  open,
  onToggle,
  onSelect,
}: {
  item: TrajectoryItem;
  open: boolean;
  onToggle: () => void;
  onSelect: (s: ToolStep) => void;
}) {
  switch (item.kind) {
    case 'text':
      return <p className="whitespace-pre-wrap">{item.event.text}</p>;
    case 'thinking':
      return <p className="whitespace-pre-wrap italic text-neutral-500">{item.event.text}</p>;
    case 'tool':
      return (
        <button type="button" className="font-mono text-xs" onClick={() => onSelect(item.step)}>
          {`${item.label}: ${inputSummary(item.step.call)}`}
        </button>
      );
    case 'tool_group':
      return (
        <div>
          <button type="button" aria-expanded={open} onClick={onToggle} className="font-mono text-xs">
            {`${item.label} ×${item.calls.length}`}
          </button>
          {open && (
            <ul className="ml-4">
              {item.calls.map((s) => (
                <li key={s.call.seq}>
                  <button type="button" className="font-mono text-xs" onClick={() => onSelect(s)}>
                    {inputSummary(s.call)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    case 'marker': {
      const e = item.event;
      if (e.kind === 'error') return <p className="text-red-600">API error: {e.text}</p>;
      if (e.durationMs !== null) return <p className="text-xs text-neutral-400">⏱ turn took {formatMs(e.durationMs)}</p>;
      return <p className="text-xs italic text-neutral-500">{e.text}</p>;
    }
  }
}

export function TrajectoryTimeline({ source, id, agentId, onOpenFile }: Props) {
  const mode = useViewModeStore((s) => s.mode);
  const events = useSessionEvents(source, id, agentId);
  const stats = useSessionStats(source, id);
  const deliverables = useSessionDeliverables(source, id);
  const [selected, setSelected] = useState<ToolStep | null>(null);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  const all = useMemo(() => events.data?.pages.flatMap((p) => p.items) ?? [], [events.data]);
  const turns = useMemo(() => buildTurnViews(all, mode), [all, mode]);
  const statsByKey = useMemo(() => {
    const m = new Map<string, TurnStats>();
    for (const t of stats.data?.turns ?? []) m.set(turnKey(t.agentId, t.turn), t);
    return m;
  }, [stats.data]);
  const delivByKey = useMemo(() => {
    const m = new Map<string, DeliverableFile[]>();
    for (const d of deliverables.data ?? []) m.set(turnKey(d.agentId, d.turn), d.files);
    return m;
  }, [deliverables.data]);
  const agentStats = agentId ? stats.data?.agents.find((a) => a.agentId === agentId)?.stats : undefined;
  const headerStats = agentId ? agentStats : stats.data?.session;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow.current && turns.length > 0) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const toggle = (key: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (events.isLoading) return <p>Loading timeline…</p>;
  if (events.isError) return <p role="alert">Could not load the timeline.</p>;

  return (
    <div className="flex h-full min-h-0">
      <div ref={scrollRef} onScroll={onScroll} data-testid="timeline-scroll" className="min-w-0 flex-1 overflow-auto p-3">
        {headerStats && (
          <p data-testid="session-stats" className="mb-3 text-xs text-neutral-600">
            {agentId ? 'Agent' : 'Session'}: {statsSummary(headerStats).join(' · ')}
          </p>
        )}
        {turns.map((t) => {
          const promptText = t.prompt?.text ?? (t.turn === 0 ? 'Agent start' : `Turn ${t.turn}`);
          return (
            <section key={t.key} aria-label={`Turn ${t.turn}`} className="mb-4 border-b border-neutral-100 pb-3">
              <h3 title={promptText} className="font-medium">
                {promptText.length > PROMPT_MAX ? `${promptText.slice(0, PROMPT_MAX)}…` : promptText}
              </h3>
              <TurnStatsBar stats={statsByKey.get(t.key)} />
              {mode !== 'summary' && (
                <ol className="mt-2 space-y-1">
                  {t.items.map((item) => (
                    <li key={item.key}>
                      <ItemView
                        item={item}
                        open={openGroups.has(item.key)}
                        onToggle={() => toggle(item.key)}
                        onSelect={setSelected}
                      />
                    </li>
                  ))}
                </ol>
              )}
              <DeliverablesRow files={delivByKey.get(t.key) ?? []} onOpenFile={onOpenFile} />
            </section>
          );
        })}
        {events.hasNextPage && (
          <button type="button" disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
            {events.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
      {selected && <StepInspector step={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
```

The tool-group button's accessible name is its text, `Bash ×1`. In verbose mode the button text is `Bash: pnpm vitest run`, which is what the test queries.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/web/src/features/session-detail/timeline`
Expected: PASS (10 + 3 tests). `TrajectoryTimeline` replaces Phase 1's `Timeline` in the session page (Task 16). Phase 1's `timeline-model.ts` stays in place for any other users, and this task does not change it.

- [ ] **Step 6: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/web
git commit -m "feat(web): add trajectory timeline with view modes, step inspector, turn stats and deliverables"
```

---

### Task 15: Agents tree (@xyflow/react) with default expansion and conductor chain

**Files:**
- Create: `apps/web/src/features/session-detail/agents/conductor.ts`, `apps/web/src/features/session-detail/agents/layout.ts`, `apps/web/src/features/session-detail/agents/agents-pure.test.ts`
- Create: `apps/web/src/features/session-detail/agents/AgentCard.tsx`, `AgentOutline.tsx`, `AgentsTree.tsx`, `ConductorChain.tsx`, `AgentsTree.test.tsx`
- Create: `apps/web/src/test/flow-stubs.ts`

**Interfaces:**
- Consumes: `AgentNode` (§4); `formatMs`, `formatTokens` (Task 14); `@xyflow/react@^12.11.6` (`ReactFlow`, `Background`, `Controls`, `Handle`, `Position`, `type Node`, `type Edge`, `type NodeProps`)
- Produces:
  ```ts
  // conductor.ts
  export const CONDUCTOR_STEPS: readonly ['repo-resolver', 'branch', 'code', 'lint', 'test', 'build', 'visual-verify']
  export type ConductorStep = (typeof CONDUCTOR_STEPS)[number]
  export function conductorStep(a: Pick<AgentNode, 'agentType' | 'description'>): ConductorStep | null
  export function isConductorSession(skills: readonly string[]): boolean
  export type ChainStatus = 'pending' | 'running' | 'done' | 'error'
  export interface ChainStepView { step: ConductorStep; agents: AgentNode[]; status: ChainStatus }
  export function conductorChain(agents: readonly AgentNode[], opts: { isConductor: boolean }): ChainStepView[] | null
  // layout.ts
  export const ROOT_ID = 'main'
  export interface AgentNodeData extends Record<string, unknown> { agent: AgentNode | null; label: string; childCount: number; collapsed: boolean; step: ConductorStep | null }
  export function childrenIndex(agents: readonly AgentNode[]): Map<string, AgentNode[]>
  export function defaultCollapsed(agents: readonly AgentNode[]): Set<string>
  export function layoutAgentTree(agents: readonly AgentNode[], collapsed: ReadonlySet<string>, rootLabel: string): { nodes: Node<AgentNodeData, 'agent'>[]; edges: Edge[] }
  // components
  export function AgentsTree(props: { agents: AgentNode[]; rootLabel: string; onOpenAgent: (agentId: string | null) => void }): JSX.Element
  export function AgentOutline(props: { agents: AgentNode[]; collapsed: ReadonlySet<string>; onToggle: (id: string) => void; onOpenAgent: (id: string) => void }): JSX.Element
  export function ConductorChain(props: { chain: ChainStepView[]; onOpenAgent: (id: string) => void }): JSX.Element
  // test/flow-stubs.ts
  export function stubReactFlowDom(): void
  ```

Tree rules:
- A node with children starts **collapsed only if its whole subtree is `done`**, so failed or running branches start expanded.
- Clicking a node opens that agent's transcript (`onOpenAgent`). Double-clicking a node, or using its outline button, toggles the node.
- Layout is tiered: depth × 300 px across, and DFS leaf order × 96 px down. A parent is centered on its visible children.
- The conductor chain applies when the session used the `conductor` skill and at least two agents map to steps. Each agent is mapped by exact `agentType` first (`repo-resolver`, `conductor:lint`, `test-agent`), then by keyword rules on `agentType` and then on `description`.

- [ ] **Step 1: Write the failing pure test**

`apps/web/src/features/session-detail/agents/agents-pure.test.ts`
```ts
import type { AgentNode } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { conductorChain, conductorStep, isConductorSession } from './conductor.ts';
import { ROOT_ID, defaultCollapsed, layoutAgentTree } from './layout.ts';

const agent = (p: Partial<AgentNode> & Pick<AgentNode, 'id'>): AgentNode => ({
  sessionId: 's-subagents', parentId: null, depth: 1, agentType: 'general-purpose', description: '', background: false,
  toolUseId: null, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: null },
  startedAt: '2026-09-06T08:00:03.000Z', endedAt: '2026-09-06T08:00:20.000Z', status: 'done', transcriptPath: `/x/agent-${p.id}.jsonl`,
  ...p,
});

const tree = (leafStatus: AgentNode['status']) => [
  agent({ id: 'ag1', agentType: 'Explore', description: 'Explore logs', background: true }),
  agent({ id: 'ag2', parentId: 'ag1', depth: 2, description: 'Deep dive' }),
  agent({ id: 'ag3', parentId: 'ag2', depth: 3, description: 'Leaf', status: leafStatus, endedAt: leafStatus === 'running' ? null : '2026-09-06T08:00:20.000Z' }),
];

describe('conductorStep', () => {
  it.each([
    [{ agentType: 'repo-resolver', description: '' }, 'repo-resolver'],
    [{ agentType: 'conductor:lint', description: '' }, 'lint'],
    [{ agentType: 'test-agent', description: '' }, 'test'],
    [{ agentType: 'general-purpose', description: 'Create feature branch for SAF-1787' }, 'branch'],
    [{ agentType: 'general-purpose', description: 'Implement the SLA change' }, 'code'],
    [{ agentType: 'general-purpose', description: 'Run lint and build' }, 'lint'],
    [{ agentType: 'general-purpose', description: 'Run the unit tests' }, 'test'],
    [{ agentType: 'general-purpose', description: 'Build the service' }, 'build'],
    [{ agentType: 'general-purpose', description: 'Visual verify with playwright screenshot' }, 'visual-verify'],
    [{ agentType: 'Explore', description: 'Explore logs' }, null],
  ] as const)('%j → %s', (a, step) => {
    expect(conductorStep(a)).toBe(step);
  });
});

describe('conductorChain', () => {
  const agents = [
    agent({ id: 'c1', agentType: 'repo-resolver' }),
    agent({ id: 'c2', description: 'create branch' }),
    agent({ id: 'c3', description: 'implement code', status: 'running', endedAt: null }),
    agent({ id: 'c4', description: 'run tests', status: 'error' }),
  ];

  it('returns null when not a conductor session or too few agents map', () => {
    expect(conductorChain(agents, { isConductor: false })).toBeNull();
    expect(conductorChain(tree('done'), { isConductor: true })).toBeNull();
  });

  it('orders steps and derives status', () => {
    const chain = conductorChain(agents, { isConductor: true });
    expect(chain?.map((s) => [s.step, s.status, s.agents.map((a) => a.id)])).toEqual([
      ['repo-resolver', 'done', ['c1']],
      ['branch', 'done', ['c2']],
      ['code', 'running', ['c3']],
      ['lint', 'pending', []],
      ['test', 'error', ['c4']],
      ['build', 'pending', []],
      ['visual-verify', 'pending', []],
    ]);
  });

  it('detects conductor sessions from skills', () => {
    expect(isConductorSession(['review', 'conductor'])).toBe(true);
    expect(isConductorSession(['wstack:conductor'])).toBe(true);
    expect(isConductorSession(['review'])).toBe(false);
  });
});

describe('defaultCollapsed', () => {
  it('keeps running/error branches expanded and collapses finished ones', () => {
    expect([...defaultCollapsed(tree('running'))]).toEqual([]);
    expect([...defaultCollapsed(tree('error'))]).toEqual([]);
    expect([...defaultCollapsed(tree('done'))].sort()).toEqual(['ag1', 'ag2']);
  });
});

describe('layoutAgentTree', () => {
  it('places depth on x and leaves on rows', () => {
    const { nodes, edges } = layoutAgentTree(tree('running'), new Set(), 's-subagents');
    const pos = Object.fromEntries(nodes.map((n) => [n.id, [n.position.x, n.position.y]]));
    expect(pos).toEqual({ [ROOT_ID]: [0, 0], ag1: [300, 0], ag2: [600, 0], ag3: [900, 0] });
    expect(edges.map((e) => [e.source, e.target, e.animated])).toEqual([
      [ROOT_ID, 'ag1', false],
      ['ag1', 'ag2', false],
      ['ag2', 'ag3', true],
    ]);
    expect(nodes.find((n) => n.id === ROOT_ID)?.data.label).toBe('s-subagents');
    expect(nodes.find((n) => n.id === 'ag1')?.data.label).toBe('Explore logs');
  });

  it('hides collapsed descendants and centers parents', () => {
    const agents = [...tree('done'), agent({ id: 'ag4', description: 'Other' })];
    const { nodes, edges } = layoutAgentTree(agents, new Set(['ag1']), 'root');
    expect(nodes.map((n) => n.id).sort()).toEqual(['ag1', 'ag4', ROOT_ID]);
    expect(edges).toHaveLength(2);
    const ag1 = nodes.find((n) => n.id === 'ag1');
    expect(ag1?.data).toMatchObject({ collapsed: true, childCount: 1 });
    expect(nodes.find((n) => n.id === ROOT_ID)?.position.y).toBe(48);
  });

  it('attaches orphans to the root', () => {
    const { edges } = layoutAgentTree([agent({ id: 'x', parentId: 'missing' })], new Set(), 'root');
    expect(edges.map((e) => e.source)).toEqual([ROOT_ID]);
  });
});
```

Run: `pnpm vitest run apps/web/src/features/session-detail/agents/agents-pure.test.ts`
Expected: FAIL, `Cannot find module './conductor.ts'`

- [ ] **Step 2: Implement the pure modules**

`apps/web/src/features/session-detail/agents/conductor.ts`
```ts
import type { AgentNode } from '@orc/core';

export const CONDUCTOR_STEPS = ['repo-resolver', 'branch', 'code', 'lint', 'test', 'build', 'visual-verify'] as const;
export type ConductorStep = (typeof CONDUCTOR_STEPS)[number];

// Order matters: more specific steps first.
const RULES: ReadonlyArray<{ step: ConductorStep; re: RegExp }> = [
  { step: 'repo-resolver', re: /repo[-_ ]?resolv|resolve (?:the )?repo/i },
  { step: 'visual-verify', re: /visual[-_ ]?verif|screenshot|playwright/i },
  { step: 'branch', re: /\bbranch\b|worktree/i },
  { step: 'lint', re: /\blint(?:er|ing)?\b|biome|eslint/i },
  { step: 'test', re: /\btests?\b|vitest|jest|pytest|\bqa\b/i },
  { step: 'build', re: /\bbuild\b|compile/i },
  { step: 'code', re: /\bcode(?:r)?\b|implement|developer|\bfix\b/i },
];

export function conductorStep(a: Pick<AgentNode, 'agentType' | 'description'>): ConductorStep | null {
  const type = a.agentType.toLowerCase().replace(/^conductor[:/_-]/, '');
  const exact = CONDUCTOR_STEPS.find((s) => type === s || type === `${s}-agent` || type.endsWith(`:${s}`));
  if (exact) return exact;
  for (const r of RULES) if (r.re.test(a.agentType)) return r.step;
  for (const r of RULES) if (r.re.test(a.description)) return r.step;
  return null;
}

export function isConductorSession(skills: readonly string[]): boolean {
  return skills.some((s) => s === 'conductor' || s.endsWith(':conductor'));
}

export type ChainStatus = 'pending' | 'running' | 'done' | 'error';

export interface ChainStepView {
  step: ConductorStep;
  agents: AgentNode[];
  status: ChainStatus;
}

export function conductorChain(agents: readonly AgentNode[], opts: { isConductor: boolean }): ChainStepView[] | null {
  if (!opts.isConductor) return null;
  const buckets = new Map<ConductorStep, AgentNode[]>(CONDUCTOR_STEPS.map((s) => [s, []]));
  let mapped = 0;
  for (const a of agents) {
    const s = conductorStep(a);
    if (!s) continue;
    buckets.get(s)?.push(a);
    mapped++;
  }
  if (mapped < 2) return null;
  return CONDUCTOR_STEPS.map((step) => {
    const list = buckets.get(step) ?? [];
    const status: ChainStatus =
      list.length === 0
        ? 'pending'
        : list.some((a) => a.status === 'error')
          ? 'error'
          : list.some((a) => a.status === 'running')
            ? 'running'
            : 'done';
    return { step, agents: list, status };
  });
}
```

Check the rule order against the test cases:
- `'Run lint and build'` matches `lint` before `build`.
- `'Create feature branch for SAF-1787'` matches `branch`.
- `'Implement the SLA change'` matches `code`.
- `'Explore logs'` matches nothing, so its step is `null`.

`apps/web/src/features/session-detail/agents/layout.ts`
```ts
import type { AgentNode } from '@orc/core';
import type { Edge, Node } from '@xyflow/react';
import { type ConductorStep, conductorStep } from './conductor.ts';

export const ROOT_ID = 'main';
const COL_W = 300;
const ROW_H = 96;

export interface AgentNodeData extends Record<string, unknown> {
  agent: AgentNode | null;
  label: string;
  childCount: number;
  collapsed: boolean;
  step: ConductorStep | null;
}

export function childrenIndex(agents: readonly AgentNode[]): Map<string, AgentNode[]> {
  const ids = new Set(agents.map((a) => a.id));
  const map = new Map<string, AgentNode[]>();
  for (const a of agents) {
    const parent = a.parentId !== null && ids.has(a.parentId) ? a.parentId : ROOT_ID;
    const list = map.get(parent);
    if (list) list.push(a);
    else map.set(parent, [a]);
  }
  for (const list of map.values()) list.sort((x, y) => (x.startedAt < y.startedAt ? -1 : x.startedAt > y.startedAt ? 1 : 0));
  return map;
}

export function defaultCollapsed(agents: readonly AgentNode[]): Set<string> {
  const kids = childrenIndex(agents);
  const hot = (a: AgentNode): boolean => a.status !== 'done' || (kids.get(a.id) ?? []).some(hot);
  const out = new Set<string>();
  for (const a of agents) if ((kids.get(a.id) ?? []).length > 0 && !hot(a)) out.add(a.id);
  return out;
}

export function layoutAgentTree(
  agents: readonly AgentNode[],
  collapsed: ReadonlySet<string>,
  rootLabel: string,
): { nodes: Node<AgentNodeData, 'agent'>[]; edges: Edge[] } {
  const kids = childrenIndex(agents);
  const nodes: Node<AgentNodeData, 'agent'>[] = [];
  const edges: Edge[] = [];
  let row = 0;

  const place = (id: string, agent: AgentNode | null, depth: number): number => {
    const children = kids.get(id) ?? [];
    const isCollapsed = collapsed.has(id);
    const visible = isCollapsed ? [] : children;
    let y: number;
    if (visible.length === 0) {
      y = row * ROW_H;
      row++;
    } else {
      const ys = visible.map((c) => {
        edges.push({ id: `${id}->${c.id}`, source: id, target: c.id, animated: c.status === 'running' });
        return place(c.id, c, depth + 1);
      });
      const first = ys[0] ?? 0;
      const last = ys[ys.length - 1] ?? first;
      y = (first + last) / 2;
    }
    nodes.push({
      id,
      type: 'agent',
      position: { x: depth * COL_W, y },
      data: {
        agent,
        label: agent ? agent.description || agent.agentType : rootLabel,
        childCount: children.length,
        collapsed: isCollapsed,
        step: agent ? conductorStep(agent) : null,
      },
    });
    return y;
  };

  place(ROOT_ID, null, 0);
  return { nodes, edges };
}
```

Edges are pushed in pre-order, before recursing, so the test's edge order is `main→ag1`, `ag1→ag2`, `ag2→ag3`. With `ag1` collapsed plus `ag4`, the rows are `ag1` = 0 and `ag4` = 1, so the root sits at (0 + 96) / 2 = 48.

Run: `pnpm vitest run apps/web/src/features/session-detail/agents/agents-pure.test.ts`
Expected: PASS (17 tests)

- [ ] **Step 3: Write the failing component test**

`apps/web/src/test/flow-stubs.ts`
```ts
import { vi } from 'vitest';

/** React Flow needs ResizeObserver and DOMMatrixReadOnly, which jsdom lacks (see React Flow testing docs). */
export function stubReactFlowDom(): void {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  class DOMMatrixReadOnlyStub {
    m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([1-9.]+)\)/)?.[1];
      this.m22 = scale !== undefined ? Number(scale) : 1;
    }
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub);
}
```

`apps/web/src/features/session-detail/agents/AgentsTree.test.tsx`
```tsx
import type { AgentNode } from '@orc/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { stubReactFlowDom } from '@/test/flow-stubs';
import { AgentsTree } from './AgentsTree.tsx';
import { ConductorChain } from './ConductorChain.tsx';
import { conductorChain } from './conductor.ts';

beforeAll(() => stubReactFlowDom());

const agent = (p: Partial<AgentNode> & Pick<AgentNode, 'id'>): AgentNode => ({
  sessionId: 's-subagents', parentId: null, depth: 1, agentType: 'general-purpose', description: '', background: false,
  toolUseId: null, usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, costUsd: 0.12 },
  startedAt: '2026-09-06T08:00:03.000Z', endedAt: '2026-09-06T08:00:20.000Z', status: 'done', transcriptPath: '/x.jsonl',
  ...p,
});

const done = [
  agent({ id: 'ag1', agentType: 'Explore', description: 'Explore logs', background: true }),
  agent({ id: 'ag2', parentId: 'ag1', depth: 2, description: 'Deep dive' }),
  agent({ id: 'ag3', parentId: 'ag2', depth: 3, description: 'Leaf' }),
];

describe('AgentsTree', () => {
  it('renders nodes and collapses finished branches in the outline', async () => {
    const onOpenAgent = vi.fn();
    render(<AgentsTree agents={done} rootLabel="s-subagents" onOpenAgent={onOpenAgent} />);
    expect(await screen.findByTestId('agent-node-ag1')).toBeDefined();
    const outline = screen.getByRole('tree', { name: 'Agents outline' });
    expect(outline.textContent).toContain('Explore logs');
    expect(screen.queryByRole('button', { name: 'Open Deep dive' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Expand Explore logs' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open Deep dive' }));
    expect(onOpenAgent).toHaveBeenCalledWith('ag2');
  });

  it('starts running branches expanded', () => {
    const running = done.map((a) => (a.id === 'ag3' ? { ...a, status: 'running' as const, endedAt: null } : a));
    render(<AgentsTree agents={running} rootLabel="s-subagents" onOpenAgent={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Open Leaf' })).toBeDefined();
  });
});

describe('ConductorChain', () => {
  it('renders steps in order with status and agent links', async () => {
    const chain = conductorChain(
      [agent({ id: 'c1', agentType: 'repo-resolver', description: 'Resolve repo' }), agent({ id: 'c2', description: 'run tests', status: 'error' })],
      { isConductor: true },
    );
    if (!chain) throw new Error('expected chain');
    const onOpenAgent = vi.fn();
    render(<ConductorChain chain={chain} onOpenAgent={onOpenAgent} />);
    const steps = screen.getAllByRole('listitem');
    expect(steps.map((s) => s.getAttribute('data-status'))).toEqual(['done', 'pending', 'pending', 'pending', 'error', 'pending', 'pending']);
    expect(steps[0]?.textContent).toContain('1. repo-resolver');
    await userEvent.click(screen.getByRole('button', { name: 'run tests' }));
    expect(onOpenAgent).toHaveBeenCalledWith('c2');
  });
});
```

Run: `pnpm vitest run apps/web/src/features/session-detail/agents/AgentsTree.test.tsx`
Expected: FAIL, `Cannot find module './AgentsTree.tsx'`

- [ ] **Step 4: Implement the components**

`apps/web/src/features/session-detail/agents/AgentCard.tsx`
```tsx
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { formatMs, formatTokens } from '../timeline/format.ts';
import type { AgentNodeData } from './layout.ts';

export type AgentFlowNode = Node<AgentNodeData, 'agent'>;

const TONE: Record<string, string> = {
  running: 'border-sky-400 bg-sky-50',
  error: 'border-red-400 bg-red-50',
  done: 'border-neutral-300 bg-white',
};

export function AgentCard({ data }: NodeProps<AgentFlowNode>) {
  const a = data.agent;
  const duration = a?.endedAt ? Date.parse(a.endedAt) - Date.parse(a.startedAt) : null;
  return (
    <div
      data-testid={`agent-node-${a?.id ?? 'main'}`}
      className={`w-[260px] rounded border p-2 text-xs shadow-sm ${TONE[a?.status ?? 'done'] ?? ''}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="truncate text-sm font-medium" title={data.label}>
        {data.label}
      </div>
      {a && (
        <>
          <div className="text-neutral-500">
            {a.agentType}
            {a.background ? ' · background' : ''}
            {data.step ? ` · ${data.step}` : ''}
          </div>
          <div>
            {a.status} · {formatTokens(a.usage.input + a.usage.output)} tok
            {a.usage.costUsd !== null ? ` · $${a.usage.costUsd.toFixed(2)}` : ''} · {a.endedAt ? formatMs(duration) : 'running'}
          </div>
        </>
      )}
      {data.collapsed && <div className="text-neutral-500">+{data.childCount} hidden (double-click)</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
```

`apps/web/src/features/session-detail/agents/AgentOutline.tsx`
```tsx
import type { AgentNode } from '@orc/core';
import { ROOT_ID, childrenIndex } from './layout.ts';

interface Props {
  agents: AgentNode[];
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onOpenAgent: (id: string) => void;
}

export function AgentOutline({ agents, collapsed, onToggle, onOpenAgent }: Props) {
  const kids = childrenIndex(agents);
  const renderLevel = (parent: string) => (
    <ul role="group" className="ml-4">
      {(kids.get(parent) ?? []).map((a) => {
        const label = a.description || a.agentType;
        const children = kids.get(a.id) ?? [];
        const isCollapsed = collapsed.has(a.id);
        return (
          <li key={a.id} role="treeitem" aria-expanded={children.length ? !isCollapsed : undefined} aria-selected={false}>
            {children.length > 0 && (
              <button type="button" aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${label}`} onClick={() => onToggle(a.id)}>
                {isCollapsed ? '▸' : '▾'}
              </button>
            )}
            <button type="button" aria-label={`Open ${label}`} onClick={() => onOpenAgent(a.id)} className="ml-1">
              {label}
            </button>
            <span className="ml-2 text-xs text-neutral-500">{a.status}</span>
            {children.length > 0 && !isCollapsed && renderLevel(a.id)}
          </li>
        );
      })}
    </ul>
  );
  return (
    <div role="tree" aria-label="Agents outline" className="text-sm">
      {renderLevel(ROOT_ID)}
    </div>
  );
}
```

`apps/web/src/features/session-detail/agents/AgentsTree.tsx`
```tsx
import type { AgentNode } from '@orc/core';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useState } from 'react';
import { AgentCard } from './AgentCard.tsx';
import { AgentOutline } from './AgentOutline.tsx';
import { ROOT_ID, defaultCollapsed, layoutAgentTree } from './layout.ts';

const nodeTypes = { agent: AgentCard };

interface Props {
  agents: AgentNode[];
  rootLabel: string;
  onOpenAgent: (agentId: string | null) => void;
}

export function AgentsTree({ agents, rootLabel, onOpenAgent }: Props) {
  // Reset default expansion only when the set of agents or their statuses change.
  const shape = agents.map((a) => `${a.id}:${a.status}`).join('|');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => defaultCollapsed(agents));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shape` captures the relevant changes of `agents`
  useEffect(() => setCollapsed(defaultCollapsed(agents)), [shape]);

  const { nodes, edges } = useMemo(() => layoutAgentTree(agents, collapsed, rootLabel), [agents, collapsed, rootLabel]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (agents.length === 0) return <p className="p-3 text-sm text-neutral-500">This session started no subagents.</p>;

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-[1fr_280px]">
      <div className="h-[560px] rounded border border-neutral-200" data-testid="agents-tree">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_e, n) => onOpenAgent(n.id === ROOT_ID ? null : n.id)}
          onNodeDoubleClick={(_e, n) => {
            if (n.id !== ROOT_ID) toggle(n.id);
          }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <AgentOutline agents={agents} collapsed={collapsed} onToggle={toggle} onOpenAgent={(id) => onOpenAgent(id)} />
    </div>
  );
}
```

`apps/web/src/features/session-detail/agents/ConductorChain.tsx`
```tsx
import type { ChainStepView } from './conductor.ts';

const TONE: Record<ChainStepView['status'], string> = {
  pending: 'border-dashed border-neutral-300 text-neutral-400',
  running: 'border-sky-400 bg-sky-50',
  done: 'border-emerald-400 bg-emerald-50',
  error: 'border-red-400 bg-red-50',
};

export function ConductorChain({ chain, onOpenAgent }: { chain: ChainStepView[]; onOpenAgent: (id: string) => void }) {
  return (
    <ol aria-label="Conductor chain" className="flex flex-wrap gap-2 p-3">
      {chain.map((s, i) => (
        <li key={s.step} data-status={s.status} className={`min-w-[130px] rounded border p-2 text-xs ${TONE[s.status]}`}>
          <div className="font-medium">
            {i + 1}. {s.step}
          </div>
          <div>{s.status}</div>
          {s.agents.map((a) => (
            <button key={a.id} type="button" className="block truncate underline" onClick={() => onOpenAgent(a.id)}>
              {a.description || a.agentType}
            </button>
          ))}
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/web/src/features/session-detail/agents`
Expected: PASS (17 + 3 tests). React Flow renders node wrappers even before they are measured, so `findByTestId('agent-node-ag1')` resolves in jsdom with the stubs.

- [ ] **Step 6: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/web
git commit -m "feat(web): add agents tree with default expansion, outline and conductor chain"
```

---

### Task 16: Session Detail tabs — Usage, Files, Links, Raw, safety badges, export, and page wiring

**Files:**
- Create: `apps/web/src/features/session-detail/tabs/usage-option.ts`, `apps/web/src/features/session-detail/tabs/usage-option.test.ts`
- Create: `apps/web/src/features/session-detail/tabs/UsageTab.tsx`, `FilesTab.tsx`, `LinksTab.tsx`, `RawTab.tsx`, `SessionDetailTabs.tsx`, `tabs.test.tsx`
- Create: `apps/web/src/features/session-detail/SafetyBadges.tsx`, `apps/web/src/features/session-detail/ExportButton.tsx`, `apps/web/src/features/session-detail/header-actions.test.tsx`
- Modify: `apps/web/src/features/session-detail/SessionDetailPage.tsx` (A11), `apps/web/src/routes/sessions/$source/$id.tsx` (A11)

**Interfaces:**
- Consumes: Task 13 hooks (`useSessionUsageSeries`, `useSessionFiles`, `useSessionLinks`, `usePlanContent`, `useSessionRaw`, `useSessionSafety`, `useSessionStats`, `downloadSessionExport`, `useSessionAgents`); P1 `SessionHeader` (`actions` slot) and `useSession` (A10, A11); `TrajectoryTimeline`, `ViewModeToggle`, `formatTokens`, `formatMs`, `shortPath` (Task 14); `AgentsTree`, `ConductorChain`, `conductorChain`, `isConductorSession` (Task 15); echarts 6 (`echarts/core`, `echarts/charts`, `echarts/components`, `echarts/renderers`)
- Produces:
  ```ts
  export type UsageMetric = 'cost' | 'tokens'
  export function cumulativeByModel(points: readonly UsagePoint[], metric: UsageMetric): Array<{ model: string; points: Array<[string, number]> }>
  export function tokenSplitByModel(points: readonly UsagePoint[]): Array<{ model: string; input: number; output: number; cacheRead: number; cacheWrite: number }>
  export function hasCost(points: readonly UsagePoint[]): boolean
  export function buildUsageOption(points: readonly UsagePoint[], metric: UsageMetric): EChartsOption
  export type DetailTab = 'timeline' | 'agents' | 'usage' | 'files' | 'links' | 'raw'
  export const DETAIL_TABS: ReadonlyArray<{ id: DetailTab; label: string }>
  export interface DetailNavigation { tab?: DetailTab; agent?: string | null; file?: string | null }
  export function SessionDetailTabs(p: { session: Session; tab: DetailTab; agentId: string | null; file: string | null; onNavigate: (n: DetailNavigation) => void }): JSX.Element
  export function UsageTab(p: { source: Source; id: string }): JSX.Element
  export function FilesTab(p: { source: Source; id: string; startCwd: string; selectedPath: string | null; onSelect: (path: string | null) => void }): JSX.Element
  export function LinksTab(p: { source: Source; id: string }): JSX.Element
  export function RawTab(p: { source: Source; id: string; agents: AgentNode[] }): JSX.Element
  export function SafetyBadges(p: { source: Source; id: string }): JSX.Element | null
  export function ExportButton(p: { source: Source; id: string }): JSX.Element
  // route search: { tab: DetailTab; agent?: string; file?: string }
  ```

- [ ] **Step 1: Write the failing option test**

`apps/web/src/features/session-detail/tabs/usage-option.test.ts`
```ts
import type { UsagePoint } from '@orc/api-contract';
import { describe, expect, it } from 'vitest';
import { buildUsageOption, cumulativeByModel, hasCost, tokenSplitByModel } from './usage-option.ts';

const p = (ts: string, model: string, output: number, costUsd: number | null): UsagePoint => ({
  ts: `2026-09-01T09:00:${ts}.000Z`, agentId: null, model, input: 1, output, cacheRead: 10, cacheWrite: 2, costUsd,
});
const points = [p('05', 'claude-opus-5', 20, 0.1), p('01', 'claude-haiku-4-5', 5, null), p('35', 'claude-opus-5', 7, 0.2)];

describe('usage option', () => {
  it('builds cumulative series per model in time order', () => {
    expect(cumulativeByModel(points, 'cost')).toEqual([
      { model: 'claude-haiku-4-5', points: [['2026-09-01T09:00:01.000Z', 0]] },
      { model: 'claude-opus-5', points: [['2026-09-01T09:00:05.000Z', 0.1], ['2026-09-01T09:00:35.000Z', 0.3]] },
    ]);
    expect(cumulativeByModel(points, 'tokens')[1]?.points.map((x) => x[1])).toEqual([33, 53]);
  });

  it('splits tokens by model', () => {
    expect(tokenSplitByModel(points)).toEqual([
      { model: 'claude-haiku-4-5', input: 1, output: 5, cacheRead: 10, cacheWrite: 2 },
      { model: 'claude-opus-5', input: 2, output: 27, cacheRead: 20, cacheWrite: 4 },
    ]);
  });

  it('detects cost availability and builds the chart option', () => {
    expect(hasCost(points)).toBe(true);
    expect(hasCost([p('01', 'm', 1, null)])).toBe(false);
    const opt = buildUsageOption(points, 'tokens');
    const series = opt.series as Array<{ type: string; name: string; stack?: string }>;
    expect(series.map((s) => [s.type, s.name])).toEqual([
      ['line', 'claude-haiku-4-5'],
      ['line', 'claude-opus-5'],
      ['bar', 'Cache read'],
      ['bar', 'Cache write'],
      ['bar', 'Input'],
      ['bar', 'Output'],
    ]);
    expect((opt.yAxis as Array<{ name?: string }>)[0]?.name).toBe('tokens');
  });
});
```

Run: `pnpm vitest run apps/web/src/features/session-detail/tabs/usage-option.test.ts`
Expected: FAIL, `Cannot find module './usage-option.ts'`

- [ ] **Step 2: Implement the option builder**

`apps/web/src/features/session-detail/tabs/usage-option.ts`
```ts
import type { UsagePoint } from '@orc/api-contract';
import type { EChartsOption } from 'echarts';

export type UsageMetric = 'cost' | 'tokens';

const byTs = (a: UsagePoint, b: UsagePoint) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function cumulativeByModel(
  points: readonly UsagePoint[],
  metric: UsageMetric,
): Array<{ model: string; points: Array<[string, number]> }> {
  const totals = new Map<string, number>();
  const series = new Map<string, Array<[string, number]>>();
  for (const p of [...points].sort(byTs)) {
    const v = metric === 'cost' ? (p.costUsd ?? 0) : p.input + p.output + p.cacheRead + p.cacheWrite;
    const t = (totals.get(p.model) ?? 0) + v;
    totals.set(p.model, t);
    const list = series.get(p.model) ?? [];
    list.push([p.ts, round4(t)]);
    series.set(p.model, list);
  }
  return [...series].map(([model, pts]) => ({ model, points: pts }));
}

export function tokenSplitByModel(
  points: readonly UsagePoint[],
): Array<{ model: string; input: number; output: number; cacheRead: number; cacheWrite: number }> {
  const map = new Map<string, { model: string; input: number; output: number; cacheRead: number; cacheWrite: number }>();
  for (const p of [...points].sort(byTs)) {
    const s = map.get(p.model) ?? { model: p.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    s.input += p.input;
    s.output += p.output;
    s.cacheRead += p.cacheRead;
    s.cacheWrite += p.cacheWrite;
    map.set(p.model, s);
  }
  return [...map.values()];
}

export function hasCost(points: readonly UsagePoint[]): boolean {
  return points.some((p) => p.costUsd !== null);
}

const SPLIT_KEYS = [
  ['cacheRead', 'Cache read'],
  ['cacheWrite', 'Cache write'],
  ['input', 'Input'],
  ['output', 'Output'],
] as const;

export function buildUsageOption(points: readonly UsagePoint[], metric: UsageMetric): EChartsOption {
  const cumulative = cumulativeByModel(points, metric);
  const split = tokenSplitByModel(points);
  return {
    animation: false,
    tooltip: { trigger: 'axis' },
    legend: { top: 0, type: 'scroll' },
    grid: [
      { left: 64, right: 16, top: 36, height: '46%' },
      { left: 140, right: 16, top: '66%', bottom: 24 },
    ],
    xAxis: [
      { type: 'time', gridIndex: 0 },
      { type: 'value', gridIndex: 1, name: 'tokens' },
    ],
    yAxis: [
      { type: 'value', gridIndex: 0, name: metric === 'cost' ? 'USD (cumulative)' : 'tokens' },
      { type: 'category', gridIndex: 1, data: split.map((s) => s.model) },
    ],
    series: [
      ...cumulative.map((c) => ({
        type: 'line' as const,
        name: c.model,
        step: 'end' as const,
        showSymbol: false,
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: c.points,
      })),
      ...SPLIT_KEYS.map(([key, name]) => ({
        type: 'bar' as const,
        name,
        stack: 'split',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: split.map((s) => s[key]),
      })),
    ],
  };
}
```

In the test, the cost y-axis name is `USD (cumulative)`. The test checks the `tokens` variant only.

Run: `pnpm vitest run apps/web/src/features/session-detail/tabs/usage-option.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 3: Write the failing component tests**

`apps/web/src/features/session-detail/tabs/tabs.test.tsx`
```tsx
import type { SessionLinks, UsagePoint } from '@orc/api-contract';
import type { FileSummary, Session } from '@orc/core';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useSessionAgents,
  useSessionFiles,
  useSessionLinks,
  useSessionRaw,
  useSessionStats,
  useSessionUsageSeries,
} from '@/api/queries/session-detail';
import { usePlanContent } from '@/api/queries/safety';
import { renderP3 } from '@/test/p3-render';
import { FilesTab } from './FilesTab.tsx';
import { LinksTab } from './LinksTab.tsx';
import { RawTab } from './RawTab.tsx';
import { SessionDetailTabs } from './SessionDetailTabs.tsx';
import { UsageTab } from './UsageTab.tsx';

const chart = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
vi.mock('echarts/core', () => ({ init: vi.fn(() => chart), use: vi.fn() }));
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }));
vi.mock('echarts/components', () => ({ GridComponent: {}, LegendComponent: {}, TooltipComponent: {} }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));
vi.mock('@/api/queries/session-detail', () => ({
  useSessionAgents: vi.fn(),
  useSessionUsageSeries: vi.fn(),
  useSessionFiles: vi.fn(),
  useSessionLinks: vi.fn(),
  useSessionRaw: vi.fn(),
  useSessionStats: vi.fn(),
}));
vi.mock('@/api/queries/safety', () => ({ usePlanContent: vi.fn() }));
vi.mock('../timeline/TrajectoryTimeline.tsx', () => ({
  TrajectoryTimeline: (p: { agentId: string | null; onOpenFile: (f: string) => void }) => (
    <button type="button" onClick={() => p.onOpenFile('/r/a.ts')}>
      timeline:{p.agentId ?? 'main'}
    </button>
  ),
}));
vi.mock('../agents/AgentsTree.tsx', () => ({
  AgentsTree: (p: { onOpenAgent: (id: string | null) => void }) => (
    <button type="button" onClick={() => p.onOpenAgent('ag2')}>
      tree
    </button>
  ),
}));

const q = <T,>(data: T) => ({ data, isLoading: false, isError: false }) as never;

const usage: UsagePoint[] = [
  { ts: '2026-09-01T09:00:05.000Z', agentId: null, model: 'claude-opus-5', input: 10, output: 20, cacheRead: 1000, cacheWrite: 100, costUsd: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useSessionAgents).mockReturnValue(q([]));
  vi.mocked(useSessionStats).mockReturnValue(q(undefined));
});

describe('UsageTab', () => {
  it('draws token charts when no cost is known and disposes on unmount', () => {
    vi.mocked(useSessionUsageSeries).mockReturnValue(q(usage));
    const { unmount } = renderP3(<UsageTab source="claude" id="s-basic" />);
    expect(screen.getByRole('radio', { name: 'Cost' }).hasAttribute('disabled')).toBe(true);
    const option = chart.setOption.mock.calls[0]?.[0] as { yAxis: Array<{ name?: string }> };
    expect(option.yAxis[0]?.name).toBe('tokens');
    expect(screen.getByTestId('usage-totals').textContent).toBe('cache read 1.0k · cache write 100 · input 10 · output 20 · cache hit 90%');
    unmount();
    expect(chart.dispose).toHaveBeenCalled();
  });
});

describe('FilesTab', () => {
  const files: FileSummary[] = [
    {
      path: '/Users/test/Wakecap/Backend/svc/a.ts', ops: 2, failedOps: 1, turns: [1, 2], agentIds: [null, 'ag1'],
      firstTs: '2026-09-01T09:00:35.000Z', lastTs: '2026-09-01T09:05:00.000Z',
      changes: [{ path: '/Users/test/Wakecap/Backend/svc/a.ts', tool: 'Edit', toolUseId: 'tu2', turn: 1, seq: 4, ts: '2026-09-01T09:00:35.000Z', agentId: null, status: 'applied', oldText: 'old line', newText: 'new line' }],
    },
  ];

  it('lists files relative to the start cwd and shows edit snippets for the selection', async () => {
    vi.mocked(useSessionFiles).mockReturnValue(q(files));
    const onSelect = vi.fn();
    const { rerender } = renderP3(
      <FilesTab source="claude" id="s-basic" startCwd="/Users/test/Wakecap" selectedPath={null} onSelect={onSelect} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Backend/svc/a.ts' }));
    expect(onSelect).toHaveBeenCalledWith('/Users/test/Wakecap/Backend/svc/a.ts');
    expect(screen.getByRole('row', { name: /Backend\/svc\/a\.ts 2 1 1, 2 main, ag1/ })).toBeDefined();
    rerender(
      <FilesTab source="claude" id="s-basic" startCwd="/Users/test/Wakecap" selectedPath="/Users/test/Wakecap/Backend/svc/a.ts" onSelect={onSelect} />,
    );
    expect(screen.getByTestId('change-old').textContent).toBe('old line');
    expect(screen.getByTestId('change-new').textContent).toBe('new line');
  });
});

describe('LinksTab', () => {
  const links: SessionLinks = {
    prs: [{ repo: 'example-org/svc', number: 231, url: 'https://github.com/example-org/svc/pull/231' }],
    tickets: [{ id: 'SAF-1787', url: 'https://linear.app/acme/issue/SAF-1787' }],
    plans: [{ path: '/p/SAF-1787.md', title: 'SLA plan', source: 'wakecap-plans', mtime: '2026-09-01T00:00:00.000Z', reason: 'ticket', tickets: ['SAF-1787'] }],
    artifacts: [{ title: 'Artifact', url: 'https://example.test/a', path: null }],
    bridgeSessionId: 'b-1',
  };

  it('shows every link kind and opens plan content', async () => {
    vi.mocked(useSessionLinks).mockReturnValue(q(links));
    vi.mocked(usePlanContent).mockImplementation((path) => q(path ? { path, text: '# SLA plan body' } : undefined));
    renderP3(<LinksTab source="claude" id="s-prlink" />);
    expect(screen.getByRole('link', { name: 'example-org/svc#231' }).getAttribute('href')).toBe('https://github.com/example-org/svc/pull/231');
    expect(screen.getByRole('link', { name: 'SAF-1787' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Artifact' })).toBeDefined();
    expect(screen.getByText('b-1')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'SLA plan' }));
    expect(screen.getByTestId('plan-content').textContent).toBe('# SLA plan body');
  });
});

describe('RawTab', () => {
  it('lists lines, switches agent and loads more', async () => {
    const fetchNextPage = vi.fn();
    vi.mocked(useSessionRaw).mockReturnValue({
      data: { pages: [{ path: '/x', items: [{ offset: 0, text: '{"type":"user"}', truncated: false, partial: false }, { offset: 16, text: '{"type":', truncated: false, partial: true }], nextOffset: 30 }], pageParams: [0] },
      isLoading: false,
      isError: false,
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage,
    } as never);
    const agents = [{ id: 'ag1', description: 'Explore logs', agentType: 'Explore' }] as never;
    renderP3(<RawTab source="claude" id="s-basic" agents={agents} />);
    expect(screen.getByText('{"type":"user"}')).toBeDefined();
    expect(screen.getByText('partial')).toBeDefined();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Transcript' }), 'ag1');
    expect(vi.mocked(useSessionRaw)).toHaveBeenLastCalledWith('claude', 's-basic', 'ag1');
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(fetchNextPage).toHaveBeenCalled();
  });
});

describe('SessionDetailTabs', () => {
  const session = { id: 's-subagents', source: 'claude', startCwd: '/Users/test/Wakecap', name: 's-subagents', skills: [] } as unknown as Session;

  it('navigates between tabs and from agents to the agent timeline', async () => {
    const onNavigate = vi.fn();
    const { rerender } = renderP3(<SessionDetailTabs session={session} tab="timeline" agentId={null} file={null} onNavigate={onNavigate} />);
    expect(screen.getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'timeline:main' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ tab: 'files', file: '/r/a.ts' });
    await userEvent.click(screen.getByRole('tab', { name: 'Agents' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ tab: 'agents' });
    rerender(<SessionDetailTabs session={session} tab="agents" agentId={null} file={null} onNavigate={onNavigate} />);
    await userEvent.click(screen.getByRole('button', { name: 'tree' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ tab: 'timeline', agent: 'ag2' });
    rerender(<SessionDetailTabs session={session} tab="timeline" agentId="ag2" file={null} onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'timeline:ag2' })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Back to main session' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ agent: null });
  });
});
```

`apps/web/src/features/session-detail/header-actions.test.tsx`
```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadSessionExport, useSessionSafety } from '@/api/queries/session-detail';
import { renderP3 } from '@/test/p3-render';
import { ExportButton } from './ExportButton.tsx';
import { SafetyBadges } from './SafetyBadges.tsx';

vi.mock('@/api/queries/session-detail', () => ({ useSessionSafety: vi.fn(), downloadSessionExport: vi.fn(async () => undefined) }));

beforeEach(() => vi.clearAllMocks());

describe('SafetyBadges', () => {
  it('shows the permission badge and prod touches', () => {
    vi.mocked(useSessionSafety).mockReturnValue({
      data: {
        permissionMode: 'bypassPermissions',
        permissionBadge: 'bypass',
        touchedProd: true,
        prodTouches: [
          { seq: 2, ts: '', agentId: null, kind: 'command', tool: 'Bash', detail: 'PGPASSWORD=«redacted:secret» psql -h prod-db' },
          { seq: 3, ts: '', agentId: null, kind: 'skill', tool: 'Skill', detail: 'production_server_db' },
        ],
      },
    } as never);
    renderP3(<SafetyBadges source="claude" id="s-drift" />);
    expect(screen.getByText('bypass').getAttribute('title')).toBe('permission mode: bypassPermissions');
    const prod = screen.getByText('PROD ×2');
    expect(prod.getAttribute('title')).toContain('production_server_db');
  });

  it('labels unusual modes as custom', () => {
    vi.mocked(useSessionSafety).mockReturnValue({
      data: { permissionMode: 'weird', permissionBadge: 'custom', touchedProd: false, prodTouches: [] },
    } as never);
    renderP3(<SafetyBadges source="claude" id="s-x" />);
    expect(screen.getByText('custom')).toBeDefined();
    expect(screen.queryByText(/PROD/)).toBeNull();
  });
});

describe('ExportButton', () => {
  it('exports redacted by default and asks before an unredacted export', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    renderP3(<ExportButton source="claude" id="s-drift" />);
    await userEvent.click(screen.getByRole('button', { name: 'Export ZIP' }));
    expect(downloadSessionExport).toHaveBeenLastCalledWith('claude', 's-drift', { redact: true });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Include secrets (unredacted)' }));
    confirm.mockReturnValueOnce(false);
    await userEvent.click(screen.getByRole('button', { name: 'Export ZIP' }));
    expect(downloadSessionExport).toHaveBeenCalledTimes(1);

    confirm.mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: 'Export ZIP' }));
    expect(downloadSessionExport).toHaveBeenLastCalledWith('claude', 's-drift', { redact: false });
  });
});
```

Run: `pnpm vitest run apps/web/src/features/session-detail/tabs/tabs.test.tsx apps/web/src/features/session-detail/header-actions.test.tsx`
Expected: FAIL, the component modules are missing.

- [ ] **Step 4: Implement the tabs and header actions**

`apps/web/src/features/session-detail/tabs/UsageTab.tsx`
```tsx
import type { Source } from '@orc/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSessionUsageSeries } from '@/api/queries/session-detail';
import { formatPct, formatTokens } from '../timeline/format.ts';
import { type UsageMetric, buildUsageOption, hasCost, tokenSplitByModel } from './usage-option.ts';

echarts.use([LineChart, BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export function UsageTab({ source, id }: { source: Source; id: string }) {
  const q = useSessionUsageSeries(source, id);
  const points = useMemo(() => q.data ?? [], [q.data]);
  const costAvailable = hasCost(points);
  const [metric, setMetric] = useState<UsageMetric>('cost');
  const effective: UsageMetric = costAvailable ? metric : 'tokens';
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || points.length === 0) return;
    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    chart.setOption(buildUsageOption(points, effective));
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
    };
  }, [points, effective]);

  const totals = tokenSplitByModel(points).reduce(
    (t, s) => ({ input: t.input + s.input, output: t.output + s.output, cacheRead: t.cacheRead + s.cacheRead, cacheWrite: t.cacheWrite + s.cacheWrite }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  const denom = totals.input + totals.cacheRead + totals.cacheWrite;

  if (q.isLoading) return <p className="p-3">Loading usage…</p>;
  if (q.isError) return <p role="alert" className="p-3">Could not load usage.</p>;
  if (points.length === 0) return <p className="p-3 text-sm text-neutral-500">No model usage recorded.</p>;

  return (
    <div className="p-3">
      <div role="radiogroup" aria-label="Metric" className="mb-2 inline-flex rounded border border-neutral-200 text-xs">
        {(['cost', 'tokens'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={effective === m}
            disabled={m === 'cost' && !costAvailable}
            title={m === 'cost' && !costAvailable ? 'No cost data for this session' : undefined}
            onClick={() => setMetric(m)}
            className={`px-2 py-1 ${effective === m ? 'bg-neutral-900 text-white' : ''}`}
          >
            {m === 'cost' ? 'Cost' : 'Tokens'}
          </button>
        ))}
      </div>
      <p data-testid="usage-totals" className="mb-2 text-xs text-neutral-600">
        {`cache read ${formatTokens(totals.cacheRead)} · cache write ${formatTokens(totals.cacheWrite)} · input ${formatTokens(totals.input)} · output ${formatTokens(totals.output)} · cache hit ${formatPct(denom > 0 ? totals.cacheRead / denom : null)}`}
      </p>
      <div ref={ref} data-testid="usage-chart" className="h-[420px] w-full" />
    </div>
  );
}
```

For the test data, the cache hit rate is 1000 / (10 + 1000 + 100) ≈ 0.9009, which renders as `90%`, and 1000 tokens renders as `1.0k`.

`apps/web/src/features/session-detail/tabs/FilesTab.tsx`
```tsx
import type { Source } from '@orc/core';
import { useSessionFiles } from '@/api/queries/session-detail';

interface Props {
  source: Source;
  id: string;
  startCwd: string;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
}

const rel = (p: string, cwd: string) => (p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p);

export function FilesTab({ source, id, startCwd, selectedPath, onSelect }: Props) {
  const q = useSessionFiles(source, id);
  if (q.isLoading) return <p className="p-3">Loading files…</p>;
  if (q.isError) return <p role="alert" className="p-3">Could not load files.</p>;
  const files = q.data ?? [];
  if (files.length === 0) return <p className="p-3 text-sm text-neutral-500">No files were edited by tools in this session.</p>;
  const selected = files.find((f) => f.path === selectedPath) ?? null;

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-neutral-500">
            <th>File</th>
            <th>Edits</th>
            <th>Failed</th>
            <th>Turns</th>
            <th>Agents</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.path} className={f.path === selectedPath ? 'bg-neutral-100' : ''}>
              <td>
                <button type="button" className="font-mono text-xs" title={f.path} onClick={() => onSelect(f.path)}>
                  {rel(f.path, startCwd)}
                </button>
              </td>
              <td>{f.ops}</td>
              <td>{f.failedOps}</td>
              <td>{f.turns.join(', ')}</td>
              <td>{f.agentIds.map((a) => a ?? 'main').join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected && (
        <section aria-label="File changes" className="text-xs">
          <h3 className="mb-1 font-mono">{selected.path}</h3>
          <p className="mb-2 text-neutral-500">Tool-level edit snippets. The full diff view arrives with Review &amp; Merge (Phase 4).</p>
          {selected.changes.map((c) => (
            <article key={`${c.agentId ?? 'main'}-${c.seq}-${c.path}`} className="mb-3 rounded border border-neutral-200 p-2">
              <header className="mb-1">
                turn {c.turn} · {c.tool} · {c.status} · {new Date(c.ts).toLocaleTimeString()}
              </header>
              {c.oldText !== null && (
                <pre data-testid="change-old" className="whitespace-pre-wrap bg-red-50 p-1">
                  {c.oldText}
                </pre>
              )}
              {c.newText !== null && (
                <pre data-testid="change-new" className="whitespace-pre-wrap bg-emerald-50 p-1">
                  {c.newText}
                </pre>
              )}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
```

`apps/web/src/features/session-detail/tabs/LinksTab.tsx`
```tsx
import type { Source } from '@orc/core';
import { type ReactNode, useState } from 'react';
import { usePlanContent } from '@/api/queries/safety';
import { useSessionLinks } from '@/api/queries/session-detail';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mb-4">
      <h3 className="mb-1 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

const Empty = () => <p className="text-xs text-neutral-500">None</p>;

export function LinksTab({ source, id }: { source: Source; id: string }) {
  const q = useSessionLinks(source, id);
  const [planPath, setPlanPath] = useState<string | null>(null);
  const plan = usePlanContent(planPath);
  if (q.isLoading) return <p className="p-3">Loading links…</p>;
  if (q.isError || !q.data) return <p role="alert" className="p-3">Could not load links.</p>;
  const l = q.data;

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div>
        <Section title="Pull requests">
          {l.prs.length === 0 ? <Empty /> : (
            <ul>
              {l.prs.map((p) => (
                <li key={p.url}>
                  <a href={p.url} target="_blank" rel="noreferrer">{`${p.repo}#${p.number}`}</a>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Tickets">
          {l.tickets.length === 0 ? <Empty /> : (
            <ul>
              {l.tickets.map((t) => (
                <li key={t.id}>
                  {t.url ? <a href={t.url} target="_blank" rel="noreferrer">{t.id}</a> : <span>{t.id}</span>}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Plans">
          {l.plans.length === 0 ? <Empty /> : (
            <ul>
              {l.plans.map((p) => (
                <li key={p.path}>
                  <button type="button" className="underline" title={p.path} onClick={() => setPlanPath(p.path)}>
                    {p.title}
                  </button>
                  <span className="ml-2 text-xs text-neutral-500">
                    {p.source} · matched by {p.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Artifacts">
          {l.artifacts.length === 0 ? <Empty /> : (
            <ul>
              {l.artifacts.map((a) => (
                <li key={`${a.url ?? ''}|${a.path ?? ''}`}>
                  {a.url ? <a href={a.url} target="_blank" rel="noreferrer">{a.title ?? a.url}</a> : <span>{a.title ?? a.path}</span>}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Remote-control bridge">
          {l.bridgeSessionId ? <code>{l.bridgeSessionId}</code> : <Empty />}
        </Section>
      </div>
      {planPath && (
        <section aria-label="Plan" className="text-xs">
          <h3 className="mb-1 font-mono">{planPath}</h3>
          <pre data-testid="plan-content" className="whitespace-pre-wrap rounded bg-neutral-50 p-2">
            {plan.data?.text ?? (plan.isError ? 'Could not load the plan.' : 'Loading…')}
          </pre>
        </section>
      )}
    </div>
  );
}
```

`apps/web/src/features/session-detail/tabs/RawTab.tsx`
```tsx
import type { AgentNode, Source } from '@orc/core';
import { useState } from 'react';
import { useSessionRaw } from '@/api/queries/session-detail';

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function RawTab({ source, id, agents }: { source: Source; id: string; agents: AgentNode[] }) {
  const [agentId, setAgentId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const q = useSessionRaw(source, id, agentId);
  const lines = q.data?.pages.flatMap((p) => p.items) ?? [];

  const toggle = (offset: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(offset)) next.delete(offset);
      else next.add(offset);
      return next;
    });

  return (
    <div className="p-3 text-xs">
      <label className="mb-2 block">
        <span className="mr-2">Transcript</span>
        <select
          aria-label="Transcript"
          value={agentId ?? ''}
          onChange={(e) => {
            setExpanded(new Set());
            setAgentId(e.target.value === '' ? null : e.target.value);
          }}
        >
          <option value="">main session</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.description || a.agentType}
            </option>
          ))}
        </select>
      </label>
      {q.isError && <p role="alert">Raw transcript unavailable (archived or remote session).</p>}
      <ol className="space-y-1 font-mono">
        {lines.map((l) => (
          <li key={l.offset} className="border-b border-neutral-100">
            <button type="button" className="mr-2 text-neutral-400" onClick={() => toggle(l.offset)} aria-label={`Toggle line at ${l.offset}`}>
              {l.offset}
            </button>
            {l.partial && <span className="mr-1 rounded bg-amber-100 px-1">partial</span>}
            {l.truncated && <span className="mr-1 rounded bg-amber-100 px-1">truncated</span>}
            {expanded.has(l.offset) ? <pre className="whitespace-pre-wrap">{pretty(l.text)}</pre> : <span className="break-all">{l.text}</span>}
          </li>
        ))}
      </ol>
      {q.hasNextPage && (
        <button type="button" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          Load more
        </button>
      )}
    </div>
  );
}
```

`apps/web/src/features/session-detail/tabs/SessionDetailTabs.tsx`
```tsx
import type { Session } from '@orc/core';
import { useState } from 'react';
import { useSessionAgents } from '@/api/queries/session-detail';
import { AgentsTree } from '../agents/AgentsTree.tsx';
import { ConductorChain } from '../agents/ConductorChain.tsx';
import { conductorChain, isConductorSession } from '../agents/conductor.ts';
import { TrajectoryTimeline } from '../timeline/TrajectoryTimeline.tsx';
import { FilesTab } from './FilesTab.tsx';
import { LinksTab } from './LinksTab.tsx';
import { RawTab } from './RawTab.tsx';
import { UsageTab } from './UsageTab.tsx';

export type DetailTab = 'timeline' | 'agents' | 'usage' | 'files' | 'links' | 'raw';
export const DETAIL_TABS: ReadonlyArray<{ id: DetailTab; label: string }> = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'agents', label: 'Agents' },
  { id: 'usage', label: 'Usage' },
  { id: 'files', label: 'Files' },
  { id: 'links', label: 'Links' },
  { id: 'raw', label: 'Raw' },
];

export interface DetailNavigation {
  tab?: DetailTab;
  agent?: string | null;
  file?: string | null;
}

interface Props {
  session: Session;
  tab: DetailTab;
  agentId: string | null;
  file: string | null;
  onNavigate: (n: DetailNavigation) => void;
}

export function SessionDetailTabs({ session, tab, agentId, file, onNavigate }: Props) {
  const { source, id } = session;
  const agentsQ = useSessionAgents(source, id);
  const agents = agentsQ.data ?? [];
  const chain = conductorChain(agents, { isConductor: isConductorSession(session.skills) });
  const [agentView, setAgentView] = useState<'tree' | 'chain'>('tree');
  const currentAgent = agentId ? agents.find((a) => a.id === agentId) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Session detail" className="flex gap-1 border-b border-neutral-200 px-3">
        {DETAIL_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => onNavigate({ tab: t.id })}
            className={`px-3 py-2 text-sm ${tab === t.id ? 'border-b-2 border-neutral-900 font-medium' : 'text-neutral-500'}`}
          >
            {t.label}
            {t.id === 'agents' && agents.length > 0 ? ` (${agents.length})` : ''}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-auto">
        {tab === 'timeline' && (
          <>
            {agentId && (
              <p className="flex items-center gap-2 px-3 pt-2 text-xs">
                <span>Subagent: {currentAgent ? currentAgent.description || currentAgent.agentType : agentId}</span>
                <button type="button" className="underline" onClick={() => onNavigate({ agent: null })}>
                  Back to main session
                </button>
              </p>
            )}
            <TrajectoryTimeline
              source={source}
              id={id}
              agentId={agentId}
              onOpenFile={(path) => onNavigate({ tab: 'files', file: path })}
            />
          </>
        )}
        {tab === 'agents' && (
          <>
            {chain && (
              <div role="radiogroup" aria-label="Agents view" className="px-3 pt-2 text-xs">
                {(['tree', 'chain'] as const).map((v) => (
                  <button key={v} type="button" role="radio" aria-checked={agentView === v} onClick={() => setAgentView(v)} className="mr-2 underline">
                    {v === 'tree' ? 'Tree' : 'Conductor chain'}
                  </button>
                ))}
              </div>
            )}
            {chain && agentView === 'chain' ? (
              <ConductorChain chain={chain} onOpenAgent={(a) => onNavigate({ tab: 'timeline', agent: a })} />
            ) : (
              <AgentsTree
                agents={agents}
                rootLabel={session.name ?? id}
                onOpenAgent={(a) => onNavigate({ tab: 'timeline', agent: a })}
              />
            )}
          </>
        )}
        {tab === 'usage' && <UsageTab source={source} id={id} />}
        {tab === 'files' && (
          <FilesTab source={source} id={id} startCwd={session.startCwd} selectedPath={file} onSelect={(p) => onNavigate({ file: p })} />
        )}
        {tab === 'links' && <LinksTab source={source} id={id} />}
        {tab === 'raw' && <RawTab source={source} id={id} agents={agents} />}
      </div>
    </div>
  );
}
```

`apps/web/src/features/session-detail/SafetyBadges.tsx`
```tsx
import type { Source } from '@orc/core';
import { useSessionSafety } from '@/api/queries/session-detail';

const TONE: Record<string, string> = {
  bypass: 'bg-amber-100 text-amber-900',
  plan: 'bg-sky-100 text-sky-900',
  auto: 'bg-violet-100 text-violet-900',
  default: 'bg-neutral-100 text-neutral-700',
  custom: 'bg-fuchsia-100 text-fuchsia-900',
  unknown: 'bg-neutral-100 text-neutral-500',
};

export function SafetyBadges({ source, id }: { source: Source; id: string }) {
  const q = useSessionSafety(source, id);
  const s = q.data;
  if (!s) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span title={`permission mode: ${s.permissionMode ?? 'unknown'}`} className={`rounded px-1.5 py-0.5 ${TONE[s.permissionBadge] ?? ''}`}>
        {s.permissionBadge}
      </span>
      {s.touchedProd && (
        <span
          title={s.prodTouches.map((t) => `${t.kind}: ${t.detail}`).join('\n') || 'flagged by the indexer'}
          className="rounded bg-red-600 px-1.5 py-0.5 font-semibold text-white"
        >
          {`PROD ×${s.prodTouches.length}`}
        </span>
      )}
    </span>
  );
}
```

`apps/web/src/features/session-detail/ExportButton.tsx`
```tsx
import type { Source } from '@orc/core';
import { useState } from 'react';
import { downloadSessionExport } from '@/api/queries/session-detail';

export function ExportButton({ source, id }: { source: Source; id: string }) {
  const [unredacted, setUnredacted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (unredacted && !window.confirm('Export WITHOUT redaction? The ZIP may contain tokens and passwords.')) return;
    setBusy(true);
    setError(null);
    try {
      await downloadSessionExport(source, id, { redact: !unredacted });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <button type="button" disabled={busy} onClick={() => void run()} className="rounded border px-2 py-1">
        Export ZIP
      </button>
      <label className="inline-flex items-center gap-1">
        <input type="checkbox" checked={unredacted} onChange={(e) => setUnredacted(e.target.checked)} />
        Include secrets (unredacted)
      </label>
      {error && <span role="alert" className="text-red-600">{error}</span>}
    </span>
  );
}
```

- [ ] **Step 5: Wire the route and the page**

`apps/web/src/routes/sessions/$source/$id.tsx` (A11). Replace the file with the following (it keeps the Phase 1 route id `/sessions/$source/$id`; if Phase 1 validates `source` with `isSource`, keep that guard and render its not-found state):
```tsx
import type { Source } from '@orc/core';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { SessionDetailPage } from '@/features/session-detail/SessionDetailPage';
import type { DetailNavigation } from '@/features/session-detail/tabs/SessionDetailTabs';

const DetailSearch = z.object({
  tab: z.enum(['timeline', 'agents', 'usage', 'files', 'links', 'raw']).default('timeline').catch('timeline'),
  agent: z.string().optional().catch(undefined),
  file: z.string().optional().catch(undefined),
});

export const Route = createFileRoute('/sessions/$source/$id')({
  validateSearch: (search: Record<string, unknown>) => DetailSearch.parse(search),
  component: SessionDetailRoute,
});

function SessionDetailRoute() {
  const { source, id } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const onNavigate = (n: DetailNavigation) =>
    void navigate({
      search: (prev) => ({
        ...prev,
        ...(n.tab !== undefined ? { tab: n.tab } : {}),
        ...(n.agent !== undefined ? { agent: n.agent ?? undefined } : {}),
        ...(n.file !== undefined ? { file: n.file ?? undefined } : {}),
      }),
    });
  return (
    <SessionDetailPage
      source={source as Source}
      id={id}
      tab={search.tab}
      agentId={search.agent ?? null}
      file={search.file ?? null}
      onNavigate={onNavigate}
    />
  );
}
```

`apps/web/src/features/session-detail/SessionDetailPage.tsx` (A11). Change the props, pass the header actions through `SessionHeader`'s `actions` slot, and replace the Phase 1 `<Timeline …/>` with the tabs. Keep Phase 1's loading and not-found handling:
```tsx
import type { Source } from '@orc/core';
import { useSession } from '@/api/queries/sessions';
import { ResumeActions } from '@/features/terminal/ResumeActions';
import { ExportButton } from './ExportButton.tsx';
import { SafetyBadges } from './SafetyBadges.tsx';
import { SessionHeader } from './SessionHeader.tsx';
import { type DetailNavigation, type DetailTab, SessionDetailTabs } from './tabs/SessionDetailTabs.tsx';
import { ViewModeToggle } from './timeline/ViewModeToggle.tsx';

export interface SessionDetailPageProps {
  source: Source;
  id: string;
  tab: DetailTab;
  agentId: string | null;
  file: string | null;
  onNavigate: (n: DetailNavigation) => void;
}

export function SessionDetailPage({ source, id, tab, agentId, file, onNavigate }: SessionDetailPageProps) {
  const q = useSession(source, id);
  if (q.isLoading) return <p className="p-4">Loading session…</p>;
  if (q.isError || !q.data) return <p role="alert" className="p-4">Session not found.</p>;
  const session = q.data;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SessionHeader
        session={session}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SafetyBadges source={source} id={id} />
            <ViewModeToggle />
            <a href={`/audit?sessionPk=${encodeURIComponent(`${source}:${id}`)}`} className="text-xs underline">
              Audit
            </a>
            <ExportButton source={source} id={id} />
            <ResumeActions session={session} />
          </div>
        }
      />
      <SessionDetailTabs session={session} tab={tab} agentId={agentId} file={file} onNavigate={onNavigate} />
    </div>
  );
}
```
If Phase 1 passed other elements (resume/fork/pop-out buttons) into `actions` under a different name than `ResumeActions`, keep those elements in the slot as Phase 1 had them. Update Phase 1's `SessionDetailPage.test.tsx` to render the page with `tab="timeline" agentId={null} file={null} onNavigate={() => {}}`. Delete `Timeline.tsx` only if nothing else imports it (`grep -rn "session-detail/Timeline" apps/web/src`).

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/web/src/features/session-detail`
Expected: PASS. That covers the Task 14/15 tests plus 3 option tests, 5 tab tests and 3 header-action tests. Then run `pnpm --filter @orc/web build` and confirm the build succeeds, with echarts tree-shaken to the core plus line/bar charts.

- [ ] **Step 7: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): add usage, files, links and raw tabs, safety badges, export and tabbed session detail"
```

---

### Task 17: `/audit` page and secrets-hygiene panel

**Files:**
- Create: `apps/web/src/features/audit/AuditPage.tsx`, `apps/web/src/features/audit/AuditPage.test.tsx`, `apps/web/src/routes/audit.tsx`
- Create: `apps/web/src/features/safety/SecretsHygienePanel.tsx`, `apps/web/src/features/safety/SecretsHygienePanel.test.tsx`
- Modify: `apps/web/src/features/shell/AppShell.tsx` (A12), `apps/web/src/features/settings/SettingsPage.tsx` (A12)

**Interfaces:**
- Consumes: `useAudit`, `AuditFilter`, `useSecretsReport` (Task 13); `useProjectStore` (§12); `AuditEntry`, `AuditActor` (core); TanStack Router `createFileRoute`
- Produces:
  ```ts
  export interface AuditSearch { sessionPk?: string; action?: string; actor?: AuditActor; from?: string; to?: string; q?: string; projectId?: string }
  export function AuditPage(p: { search: AuditSearch; onSearch: (next: AuditSearch) => void }): JSX.Element
  export function SecretsHygienePanel(): JSX.Element
  export function localDayToIso(day: string, edge: 'start' | 'end'): string   // 'YYYY-MM-DD' (local) → ISO
  export function isoToLocalDay(iso: string): string
  // route /audit with validated search AuditSearch; an "Audit" <Link> in the AppShell main nav
  ```

- [ ] **Step 1: Write the failing tests**

`apps/web/src/features/audit/AuditPage.test.tsx`
```tsx
import type { AuditEntry } from '@orc/core';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAudit } from '@/api/queries/audit';
import { useProjectStore } from '@/stores/project';
import { renderP3 } from '@/test/p3-render';
import { AuditPage, isoToLocalDay, localDayToIso } from './AuditPage.tsx';

vi.mock('@/api/queries/audit', () => ({ useAudit: vi.fn() }));

const entries: AuditEntry[] = [
  {
    id: 'e1', ts: '2026-09-17T10:00:02.000Z', actor: 'user', actorDetail: 'Mozilla', action: 'pty.input', target: 'claude:s-basic',
    params: { via: 'keys', text: 'PGPASSWORD=«redacted:secret»' }, result: 'ok', error: null,
  },
  {
    id: 'e2', ts: '2026-09-17T10:00:01.000Z', actor: 'automation', actorDetail: null, action: 'session.kill', target: 'pty:abc',
    params: { status: 403 }, result: 'denied', error: 'not_owned: session is not owned',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAudit).mockReturnValue({ data: entries, isLoading: false, isError: false } as never);
  useProjectStore.setState({ projectId: 'wakecap' });
});

describe('AuditPage', () => {
  it('lists entries with session links and expandable redacted params', async () => {
    renderP3(<AuditPage search={{}} onSearch={vi.fn()} />);
    expect(vi.mocked(useAudit)).toHaveBeenCalledWith({ limit: 500 });
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'claude:s-basic' }).getAttribute('href')).toBe('/sessions/claude/s-basic');
    expect(screen.getByText('pty:abc')).toBeDefined();
    expect(screen.getByText('denied')).toBeDefined();
    await userEvent.click(screen.getAllByRole('button', { name: 'Details' })[0] as HTMLElement);
    expect(screen.getByTestId('audit-params-e1').textContent).toContain('«redacted:secret»');
    await userEvent.click(screen.getAllByRole('button', { name: 'Details' })[1] as HTMLElement);
    expect(screen.getByTestId('audit-error-e2').textContent).toBe('not_owned: session is not owned');
  });

  it('pushes filter changes into the search', async () => {
    const onSearch = vi.fn();
    renderP3(<AuditPage search={{ q: 'x' }} onSearch={onSearch} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Actor' }), 'automation');
    expect(onSearch).toHaveBeenLastCalledWith({ q: 'x', actor: 'automation' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Current project only' }));
    expect(onSearch).toHaveBeenLastCalledWith({ q: 'x', projectId: 'wakecap' });
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onSearch).toHaveBeenLastCalledWith({});
  });

  it('shows an empty state', () => {
    vi.mocked(useAudit).mockReturnValue({ data: [], isLoading: false, isError: false } as never);
    renderP3(<AuditPage search={{ sessionPk: 'claude:x' }} onSearch={vi.fn()} />);
    expect(screen.getByText('No audit entries match these filters.')).toBeDefined();
  });
});

describe('day conversion', () => {
  it('round-trips local days', () => {
    const start = localDayToIso('2026-09-17', 'start');
    const end = localDayToIso('2026-09-17', 'end');
    expect(Date.parse(end) - Date.parse(start)).toBe(24 * 3600 * 1000 - 1);
    expect(isoToLocalDay(start)).toBe('2026-09-17');
  });
});
```

`apps/web/src/features/safety/SecretsHygienePanel.test.tsx`
```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useSecretsReport } from '@/api/queries/safety';
import { renderP3 } from '@/test/p3-render';
import { SecretsHygienePanel } from './SecretsHygienePanel.tsx';

vi.mock('@/api/queries/safety', () => ({ useSecretsReport: vi.fn() }));

describe('SecretsHygienePanel', () => {
  it('lists findings by file, kind and line, and can rescan', async () => {
    const refetch = vi.fn();
    vi.mocked(useSecretsReport).mockReturnValue({
      data: {
        scannedAt: '2026-09-17T10:00:00.000Z',
        totalFindings: 3,
        files: [
          { path: '/h/Wakecap/.mcp.json', displayPath: '~/Wakecap/.mcp.json', exists: true, findings: [{ line: 3, kind: 'github' }, { line: 3, kind: 'json-secret-field' }], error: null },
          { path: '/h/Wakecap/.claude/commands/db.md', displayPath: '~/Wakecap/.claude/commands/db.md', exists: true, findings: [{ line: 2, kind: 'secret' }], error: null },
          { path: '/h/Wakecap/.claude/commands/clean.md', displayPath: '~/Wakecap/.claude/commands/clean.md', exists: true, findings: [], error: null },
          { path: '/h/missing.json', displayPath: '~/missing.json', exists: false, findings: [], error: null },
        ],
      },
      isError: false,
      isFetching: false,
      refetch,
    } as never);
    renderP3(<SecretsHygienePanel />);
    expect(screen.getByTestId('secrets-summary').textContent).toContain('3 findings in 2 files');
    expect(screen.getByRole('row', { name: /~\/Wakecap\/\.mcp\.json.*line 3 · github.*line 3 · json-secret-field/ })).toBeDefined();
    expect(screen.getByRole('row', { name: /clean\.md.*clean/ })).toBeDefined();
    expect(screen.getByRole('row', { name: /missing\.json.*not found/ })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    expect(refetch).toHaveBeenCalled();
  });
});
```

Run: `pnpm vitest run apps/web/src/features/audit apps/web/src/features/safety`
Expected: FAIL, the modules are missing.

- [ ] **Step 2: Implement the audit page and route**

`apps/web/src/features/audit/AuditPage.tsx`
```tsx
import type { AuditActor, AuditEntry } from '@orc/core';
import { Fragment, useMemo, useState } from 'react';
import { useAudit } from '@/api/queries/audit';
import { useProjectStore } from '@/stores/project';

export interface AuditSearch {
  sessionPk?: string;
  action?: string;
  actor?: AuditActor;
  from?: string;
  to?: string;
  q?: string;
  projectId?: string;
}

const ACTORS: AuditActor[] = ['user', 'automation', 'supervisor', 'remote'];
const PK_RE = /^(claude|codex|agnc):(.+)$/;
const RESULT_TONE: Record<AuditEntry['result'], string> = {
  ok: 'text-emerald-700',
  error: 'text-red-700',
  denied: 'text-amber-700',
};

const pad = (n: number) => String(n).padStart(2, '0');

export function localDayToIso(day: string, edge: 'start' | 'end'): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = edge === 'start'
    ? new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0)
    : new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999);
  return date.toISOString();
}

export function isoToLocalDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function without<K extends keyof AuditSearch>(s: AuditSearch, key: K, value: AuditSearch[K] | undefined): AuditSearch {
  const next: AuditSearch = { ...s };
  if (value === undefined || value === '') delete next[key];
  else next[key] = value;
  return next;
}

export function AuditPage({ search, onSearch }: { search: AuditSearch; onSearch: (next: AuditSearch) => void }) {
  const filter = useMemo(() => ({ ...search, limit: 500 }), [search]);
  const q = useAudit(filter);
  const currentProject = useProjectStore((s) => s.projectId);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="p-4">
      <h1 className="mb-3 text-lg font-semibold">Audit log</h1>
      <form role="search" aria-label="Audit filters" className="mb-3 flex flex-wrap items-end gap-2 text-sm" onSubmit={(e) => e.preventDefault()}>
        <input aria-label="Search" placeholder="Search target, params, errors" value={search.q ?? ''} onChange={(e) => onSearch(without(search, 'q', e.target.value))} />
        <select aria-label="Actor" value={search.actor ?? ''} onChange={(e) => onSearch(without(search, 'actor', (e.target.value || undefined) as AuditActor | undefined))}>
          <option value="">any actor</option>
          {ACTORS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input aria-label="Action" placeholder="session.*" value={search.action ?? ''} onChange={(e) => onSearch(without(search, 'action', e.target.value))} />
        <input aria-label="Session" placeholder="claude:<id>" value={search.sessionPk ?? ''} onChange={(e) => onSearch(without(search, 'sessionPk', e.target.value))} />
        <input aria-label="From" type="date" value={search.from ? isoToLocalDay(search.from) : ''} onChange={(e) => onSearch(without(search, 'from', e.target.value ? localDayToIso(e.target.value, 'start') : undefined))} />
        <input aria-label="To" type="date" value={search.to ? isoToLocalDay(search.to) : ''} onChange={(e) => onSearch(without(search, 'to', e.target.value ? localDayToIso(e.target.value, 'end') : undefined))} />
        <label className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            checked={search.projectId !== undefined}
            onChange={(e) => onSearch(without(search, 'projectId', e.target.checked && currentProject ? currentProject : undefined))}
          />
          Current project only
        </label>
        <button type="button" onClick={() => onSearch({})}>
          Clear filters
        </button>
      </form>

      {q.isLoading && <p>Loading…</p>}
      {q.isError && <p role="alert">Could not load the audit log.</p>}
      {q.data && q.data.length === 0 && <p>No audit entries match these filters.</p>}
      {q.data && q.data.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-neutral-500">
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
              <th>Result</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.map((e) => {
              const pk = e.target ? PK_RE.exec(e.target) : null;
              return (
                <Fragment key={e.id}>
                  <tr>
                    <td title={e.ts}>{new Date(e.ts).toLocaleString()}</td>
                    <td title={e.actorDetail ?? undefined}>{e.actor}</td>
                    <td className="font-mono">{e.action}</td>
                    <td className="font-mono">
                      {pk ? <a href={`/sessions/${pk[1]}/${encodeURIComponent(pk[2] ?? '')}`}>{e.target}</a> : (e.target ?? '—')}
                    </td>
                    <td className={RESULT_TONE[e.result]}>{e.result}</td>
                    <td>
                      <button type="button" aria-expanded={open.has(e.id)} onClick={() => toggle(e.id)}>
                        Details
                      </button>
                    </td>
                  </tr>
                  {open.has(e.id) && (
                    <tr>
                      <td colSpan={6}>
                        {e.error && (
                          <p data-testid={`audit-error-${e.id}`} className="text-red-700">
                            {e.error}
                          </p>
                        )}
                        <pre data-testid={`audit-params-${e.id}`} className="whitespace-pre-wrap rounded bg-neutral-50 p-2 text-xs">
                          {JSON.stringify(e.params, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

In the first test, the rows are the header row plus 2 entries = 3 (the details rows are closed). The checkbox test runs with `search = { q: 'x' }`, so checking it produces `{ q: 'x', projectId: 'wakecap' }`. The actor test shows that the filter-change call does not carry over the earlier actor selection, because `search` is a prop the test does not update.

`apps/web/src/routes/audit.tsx`
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { AuditPage } from '@/features/audit/AuditPage';

const AuditSearchSchema = z.object({
  sessionPk: z.string().optional().catch(undefined),
  action: z.string().optional().catch(undefined),
  actor: z.enum(['user', 'automation', 'supervisor', 'remote']).optional().catch(undefined),
  from: z.string().optional().catch(undefined),
  to: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  projectId: z.string().optional().catch(undefined),
});

export const Route = createFileRoute('/audit')({
  validateSearch: (search: Record<string, unknown>) => AuditSearchSchema.parse(search),
  component: AuditRoute,
});

function AuditRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <AuditPage search={search} onSearch={(next) => void navigate({ search: next, replace: true })} />;
}
```

After adding the file, regenerate the route tree with the Phase 1 generator (`pnpm --filter @orc/web exec tsr generate`, configured by `tsr.config.json`), so that `routeTree.gen.ts` includes `/audit`.

- [ ] **Step 3: Implement the secrets panel and wire the nav and settings**

`apps/web/src/features/safety/SecretsHygienePanel.tsx`
```tsx
import { useSecretsReport } from '@/api/queries/safety';

export function SecretsHygienePanel() {
  const q = useSecretsReport();
  const report = q.data;
  const filesWithFindings = report ? report.files.filter((f) => f.findings.length > 0).length : 0;

  return (
    <section aria-label="Secrets hygiene" className="rounded border border-neutral-200 p-3 text-sm">
      <h2 className="mb-1 font-semibold">Secrets hygiene</h2>
      <p className="mb-2 text-xs text-neutral-600">
        Read-only scan of files known to hold plaintext credentials. Values are never shown. Rotate anything listed here and
        move it to the Keychain or an environment variable. Paths are configured in <code>safety.secretScanPaths</code>.
      </p>
      <button type="button" disabled={q.isFetching} onClick={() => void q.refetch()} className="mb-2 rounded border px-2 py-1">
        Rescan
      </button>
      {q.isError && <p role="alert">Scan failed.</p>}
      {report && (
        <>
          <p data-testid="secrets-summary" className="mb-2">
            {report.totalFindings === 0
              ? 'No secret-like values found.'
              : `${report.totalFindings} findings in ${filesWithFindings} files`}{' '}
            · scanned {new Date(report.scannedAt).toLocaleString()}
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-neutral-500">
                <th>File</th>
                <th>Status</th>
                <th>Findings</th>
              </tr>
            </thead>
            <tbody>
              {report.files.map((f) => {
                const status = !f.exists
                  ? f.error === 'forbidden'
                    ? 'skipped (never read)'
                    : 'not found'
                  : f.error
                    ? `error: ${f.error}`
                    : f.findings.length === 0
                      ? 'clean'
                      : `${f.findings.length} findings`;
                return (
                  <tr key={f.path}>
                    <td className="font-mono">{f.displayPath}</td>
                    <td>{status}</td>
                    <td>
                      {f.findings.map((x) => (
                        <div key={`${x.line}-${x.kind}`}>{`line ${x.line} · ${x.kind}`}</div>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
```

`apps/web/src/features/shell/AppShell.tsx` (A12): inside `<nav aria-label="Main">`, add after the last existing link (Phase 1/2 History, Live, Inbox and Settings links):
```tsx
<Link to="/audit" className="rounded px-2 py-1 hover:bg-muted" activeProps={{ className: 'bg-muted font-medium' }}>
  Audit
</Link>
```

`apps/web/src/features/settings/SettingsPage.tsx` (A12): render the panel as its own section:
```tsx
import { SecretsHygienePanel } from '@/features/safety/SecretsHygienePanel';
// …inside the page body:
<SecretsHygienePanel />
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/web/src/features/audit apps/web/src/features/safety`
Expected: PASS (4 + 1 tests)

- [ ] **Step 5: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/web
git commit -m "feat(web): add audit log page with filters and secrets hygiene panel"
```

---

### Task 18: Shared hotkey registry, global shortcuts and the ⌘K command palette

**Files:**
- Create: `apps/web/src/features/hotkeys/registry.ts`, `apps/web/src/features/hotkeys/registry.test.ts`, `apps/web/src/features/hotkeys/HotkeysListener.tsx`, `apps/web/src/features/hotkeys/GlobalHotkeys.tsx`
- Create: `apps/web/src/features/palette/palette-items.ts`, `apps/web/src/features/palette/palette-items.test.ts`, `apps/web/src/features/palette/CommandPalette.tsx`, `apps/web/src/features/palette/CommandPalette.test.tsx`
- Modify: `apps/web/src/features/shell/AppShell.tsx` (A12), `apps/web/src/features/inbox/useInboxKeys.ts` (A13) and the Phase 2 inbox test wrapper

**Interfaces:**
- Consumes: `usePaletteStore` (Task 13); `useSessions`, `useProjects`, `useTemplates` (A10); `usePlans`, `usePlanContent` (Task 13); `getApiClient().sessionsList/sessionsResume` (A9); `useTerminalStore`, `useProjectStore` (§12); `useLaunchStore` (`show`, `open`) (A13); `cmdk@^1.1.1` (`Command`); `useNavigate` (TanStack Router); `stubReactFlowDom` (Task 15, for `ResizeObserver`)
- Produces:
  ```ts
  // registry.ts
  export interface HotkeyBinding { id: string; keys: string; description: string; group: 'navigation' | 'actions' | 'inbox' | 'session'; handler: () => void; allowInInputs?: boolean }
  export interface KeyLike { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: EventTarget | null; preventDefault(): void }
  export interface HotkeyRegistry { register(b: HotkeyBinding): () => void; handle(e: KeyLike): boolean; list(): HotkeyBinding[]; reset(): void }
  export function createHotkeyRegistry(now?: () => number): HotkeyRegistry
  export const hotkeys: HotkeyRegistry
  export function useHotkeys(bindings: HotkeyBinding[], deps: unknown[]): void
  export function formatKeys(keys: string, mac?: boolean): string
  export function HotkeysListener(): null
  export function GlobalHotkeys(): null
  // palette-items.ts
  export type PaletteAction =
    | { type: 'navigate'; to: string; search?: Record<string, string> }
    | { type: 'openSession'; source: Source; id: string }
    | { type: 'resumeLast'; projectId: string }
    | { type: 'launch'; templateId?: string; projectId?: string }
    | { type: 'openUrl'; url: string }
    | { type: 'openPlan'; path: string; title: string }
  export interface PaletteItem { id: string; label: string; hint?: string; keywords: string[]; shortcut?: string; action: PaletteAction }
  export interface PaletteSection { heading: string; items: PaletteItem[] }
  export interface PaletteSession { source: Source; id: string; name: string | null; firstPrompt: string | null; projectId: string | null; tickets: string[]; prs: PrRef[] }
  export interface PaletteInput { sessions: PaletteSession[]; projects: Array<{ id: string; name: string }>; templates: Array<{ id: string; label: string }>; plans: PlanRef[]; currentProjectId: string | null }
  export function buildPaletteSections(input: PaletteInput): PaletteSection[]
  export interface PaletteDeps { navigate(to: string, search?: Record<string, string>): void; openLaunch(prefill?: { templateId?: string; projectId?: string }): void; resumeLast(projectId: string): Promise<void>; openUrl(url: string): void; openPlan(path: string, title: string): void }
  export function runPaletteAction(a: PaletteAction, d: PaletteDeps): Promise<void>
  // CommandPalette.tsx
  export function resumeLastInProject(projectId: string): Promise<void>
  export function CommandPalette(): JSX.Element
  ```

Global shortcuts: `mod+k` opens the palette (also from inputs), `g i` goes to the inbox, `g w` shows waiting sessions, `g h` goes to history, `g a` goes to the audit log, and `n` starts a new session. **Phase 2 owns inbox triage.** Its `j/k/e/s` keys are registered through `useHotkeys` with `group: 'inbox'`, so every shortcut goes through one registry. Later registrations take precedence, and unregistering restores the previous binding.

- [ ] **Step 1: Write the failing registry test**

`apps/web/src/features/hotkeys/registry.test.ts`
```ts
import { describe, expect, it, vi } from 'vitest';
import { type KeyLike, createHotkeyRegistry, formatKeys } from './registry.ts';

const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key: k, metaKey: false, ctrlKey: false, altKey: false, target: null, preventDefault: vi.fn(), ...extra,
});

function setup() {
  let t = 0;
  const reg = createHotkeyRegistry(() => t);
  const advance = (ms: number) => {
    t += ms;
  };
  return { reg, advance };
}

describe('hotkey registry', () => {
  it('handles two-key sequences within the timeout', () => {
    const { reg, advance } = setup();
    const inbox = vi.fn();
    reg.register({ id: 'go-inbox', keys: 'g i', description: 'Inbox', group: 'navigation', handler: inbox });
    const g = key('g');
    expect(reg.handle(g)).toBe(true);
    expect(g.preventDefault).toHaveBeenCalled();
    advance(500);
    expect(reg.handle(key('i'))).toBe(true);
    expect(inbox).toHaveBeenCalledTimes(1);
    reg.handle(key('g'));
    advance(1500);
    expect(reg.handle(key('i'))).toBe(false);
    expect(inbox).toHaveBeenCalledTimes(1);
  });

  it('matches mod+k with meta or ctrl, even inside inputs when allowed', () => {
    const { reg } = setup();
    const palette = vi.fn();
    const n = vi.fn();
    reg.register({ id: 'palette', keys: 'mod+k', description: 'Palette', group: 'actions', handler: palette, allowInInputs: true });
    reg.register({ id: 'new', keys: 'n', description: 'New', group: 'actions', handler: n });
    const input = document.createElement('input');
    expect(reg.handle(key('k', { metaKey: true, target: input }))).toBe(true);
    expect(reg.handle(key('K', { ctrlKey: true }))).toBe(true);
    expect(palette).toHaveBeenCalledTimes(2);
    expect(reg.handle(key('n', { target: input }))).toBe(false);
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);
    expect(reg.handle(key('n', { target: editor }))).toBe(false);
    expect(reg.handle(key('n'))).toBe(true);
    expect(n).toHaveBeenCalledTimes(1);
  });

  it('lets later bindings override and restores on unregister', () => {
    const { reg } = setup();
    const a = vi.fn();
    const b = vi.fn();
    reg.register({ id: 'a', keys: 'j', description: 'A', group: 'session', handler: a });
    const off = reg.register({ id: 'b', keys: 'j', description: 'B', group: 'inbox', handler: b });
    reg.handle(key('j'));
    expect(b).toHaveBeenCalledTimes(1);
    expect(reg.list().map((x) => x.id)).toEqual(['b']);
    off();
    reg.handle(key('j'));
    expect(a).toHaveBeenCalledTimes(1);
    expect(reg.list().map((x) => x.id)).toEqual(['a']);
  });

  it('ignores bare modifier presses and unknown keys', () => {
    const { reg } = setup();
    expect(reg.handle(key('Shift'))).toBe(false);
    expect(reg.handle(key('x'))).toBe(false);
  });

  it('formats keys for display', () => {
    expect(formatKeys('mod+k', true)).toBe('⌘K');
    expect(formatKeys('mod+k', false)).toBe('Ctrl+K');
    expect(formatKeys('g i', true)).toBe('G then I');
    expect(formatKeys('n', true)).toBe('N');
  });
});
```

Run: `pnpm vitest run apps/web/src/features/hotkeys`
Expected: FAIL, `Cannot find module './registry.ts'`

- [ ] **Step 2: Implement the registry, listener and global shortcuts**

`apps/web/src/features/hotkeys/registry.ts`
```ts
import { useEffect } from 'react';

export interface HotkeyBinding {
  id: string;
  keys: string;
  description: string;
  group: 'navigation' | 'actions' | 'inbox' | 'session';
  handler: () => void;
  allowInInputs?: boolean;
}

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  preventDefault(): void;
}

export interface HotkeyRegistry {
  register(b: HotkeyBinding): () => void;
  handle(e: KeyLike): boolean;
  list(): HotkeyBinding[];
  reset(): void;
}

const SEQUENCE_TIMEOUT_MS = 1000;
const MODIFIER_KEYS = new Set(['shift', 'meta', 'control', 'alt', 'capslock']);

function normalize(e: KeyLike): string {
  const k = e.key.toLowerCase();
  return `${e.metaKey || e.ctrlKey ? 'mod+' : ''}${e.altKey ? 'alt+' : ''}${k}`;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable || target.getAttribute('contenteditable') === 'true') return true;
  return target.closest('.xterm') !== null;
}

export function createHotkeyRegistry(now: () => number = Date.now): HotkeyRegistry {
  let stack: HotkeyBinding[] = [];
  let pending: { key: string; at: number } | null = null;

  return {
    register(b) {
      stack.push(b);
      return () => {
        stack = stack.filter((x) => x !== b);
      };
    },
    list() {
      const seen = new Set<string>();
      const out: HotkeyBinding[] = [];
      for (const b of [...stack].reverse()) {
        if (seen.has(b.keys)) continue;
        seen.add(b.keys);
        out.push(b);
      }
      return out.reverse();
    },
    reset() {
      stack = [];
      pending = null;
    },
    handle(e) {
      if (MODIFIER_KEYS.has(e.key.toLowerCase())) return false;
      const key = normalize(e);
      const editable = isEditable(e.target);
      const t = now();
      const combos: string[] = [];
      if (pending && t - pending.at <= SEQUENCE_TIMEOUT_MS) combos.push(`${pending.key} ${key}`);
      combos.push(key);
      for (const combo of combos) {
        const b = stack.findLast((x) => x.keys === combo && (!editable || x.allowInInputs === true));
        if (b) {
          pending = null;
          e.preventDefault();
          b.handler();
          return true;
        }
      }
      const isPrefix = !editable && stack.some((x) => x.keys.startsWith(`${key} `));
      pending = isPrefix ? { key, at: t } : null;
      if (isPrefix) e.preventDefault();
      return isPrefix;
    },
  };
}

export const hotkeys = createHotkeyRegistry();

export function useHotkeys(bindings: HotkeyBinding[], deps: unknown[]): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: callers pass the handler dependencies explicitly
  useEffect(() => {
    const offs = bindings.map((b) => hotkeys.register(b));
    return () => {
      for (const off of offs) off();
    };
  }, deps);
}

const isMacPlatform = () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

export function formatKeys(keys: string, mac: boolean = isMacPlatform()): string {
  return keys
    .split(' ')
    .map((part) =>
      part
        .split('+')
        .map((p) => (p === 'mod' ? (mac ? '⌘' : 'Ctrl+') : p === 'alt' ? (mac ? '⌥' : 'Alt+') : p.toUpperCase()))
        .join(''),
    )
    .join(' then ');
}
```

`apps/web/src/features/hotkeys/HotkeysListener.tsx`
```tsx
import { useEffect } from 'react';
import { hotkeys } from './registry.ts';

/** Mounted once in AppShell; the only global keydown listener in the app. */
export function HotkeysListener(): null {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      hotkeys.handle(e);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  return null;
}
```

`apps/web/src/features/hotkeys/GlobalHotkeys.tsx`
```tsx
import { useNavigate } from '@tanstack/react-router';
import { useLaunchStore } from '@/stores/launch';
import { usePaletteStore } from '@/stores/palette';
import { useHotkeys } from './registry.ts';

export function GlobalHotkeys(): null {
  const navigate = useNavigate();
  const togglePalette = usePaletteStore((s) => s.toggle);
  const openLaunch = useLaunchStore((s) => s.show);
  useHotkeys(
    [
      { id: 'palette', keys: 'mod+k', description: 'Command palette', group: 'actions', handler: togglePalette, allowInInputs: true },
      { id: 'go-inbox', keys: 'g i', description: 'Go to inbox', group: 'navigation', handler: () => void navigate({ to: '/inbox' }) },
      {
        id: 'go-waiting',
        keys: 'g w',
        description: 'Show waiting sessions',
        group: 'navigation',
        handler: () => void navigate({ to: '/live', search: { status: 'waiting' } } as never),
      },
      { id: 'go-history', keys: 'g h', description: 'Go to history', group: 'navigation', handler: () => void navigate({ to: '/history' }) },
      { id: 'go-audit', keys: 'g a', description: 'Go to audit log', group: 'navigation', handler: () => void navigate({ to: '/audit' }) },
      { id: 'new-session', keys: 'n', description: 'New session', group: 'actions', handler: () => openLaunch() },
    ],
    [navigate, togglePalette, openLaunch],
  );
  return null;
}
```

Run: `pnpm vitest run apps/web/src/features/hotkeys`
Expected: PASS (5 tests)

- [ ] **Step 3: Write the failing palette tests**

`apps/web/src/features/palette/palette-items.test.ts`
```ts
import type { PlanRef } from '@orc/api-contract';
import { describe, expect, it, vi } from 'vitest';
import { type PaletteInput, buildPaletteSections, runPaletteAction } from './palette-items.ts';

const plan: PlanRef = { path: '/p/SAF-1787.md', title: 'SLA plan', source: 'wakecap-plans', mtime: '', reason: 'query', tickets: ['SAF-1787'] };

const input: PaletteInput = {
  sessions: [
    { source: 'claude', id: 's-prlink', name: 'SAF-1787 SLA weekends', firstPrompt: null, projectId: 'wakecap', tickets: ['SAF-1787'], prs: [{ repo: 'example-org/svc', number: 231, url: 'https://github.com/example-org/svc/pull/231' }] },
    { source: 'claude', id: 's-basic', name: null, firstPrompt: 'check the notification service tests', projectId: 'wakecap', tickets: ['SAF-1787'], prs: [] },
  ],
  projects: [{ id: 'stocks', name: 'Stocks' }, { id: 'wakecap', name: 'Wakecap' }],
  templates: [{ id: 'implement', label: 'Implement ticket' }],
  plans: [plan],
  currentProjectId: 'wakecap',
};

describe('buildPaletteSections', () => {
  it('builds navigation, actions and jump targets', () => {
    const sections = buildPaletteSections(input);
    expect(sections.map((s) => s.heading)).toEqual(['Navigation', 'Actions', 'Sessions', 'Tickets', 'Pull requests', 'Plans']);
    const nav = sections[0]?.items.map((i) => [i.label, i.shortcut]);
    expect(nav).toEqual([
      ['Open inbox', 'g i'],
      ['Waiting sessions', 'g w'],
      ['History', 'g h'],
      ['Live board', undefined],
      ['Audit log', 'g a'],
      ['Settings', undefined],
    ]);
    expect(sections[1]?.items.map((i) => i.label)).toEqual([
      'New session',
      'Resume last session in Wakecap',
      'Resume last session in Stocks',
      'Launch: Implement ticket',
    ]);
    expect(sections[2]?.items.map((i) => [i.label, i.keywords])).toEqual([
      ['SAF-1787 SLA weekends', ['s-prlink', 'SAF-1787', 'example-org/svc#231']],
      ['check the notification service tests', ['s-basic', 'SAF-1787']],
    ]);
    expect(sections[3]?.items).toEqual([
      { id: 'ticket:SAF-1787', label: 'SAF-1787', hint: 'filter history', keywords: ['ticket'], action: { type: 'navigate', to: '/history', search: { ticket: 'SAF-1787' } } },
    ]);
    expect(sections[4]?.items[0]?.action).toEqual({ type: 'openUrl', url: 'https://github.com/example-org/svc/pull/231' });
    expect(sections[5]?.items[0]?.action).toEqual({ type: 'openPlan', path: '/p/SAF-1787.md', title: 'SLA plan' });
  });

  it('drops empty sections', () => {
    const sections = buildPaletteSections({ ...input, sessions: [], plans: [] });
    expect(sections.map((s) => s.heading)).toEqual(['Navigation', 'Actions']);
  });
});

describe('runPaletteAction', () => {
  it('dispatches each action type', async () => {
    const d = { navigate: vi.fn(), openLaunch: vi.fn(), resumeLast: vi.fn(async () => undefined), openUrl: vi.fn(), openPlan: vi.fn() };
    await runPaletteAction({ type: 'openSession', source: 'claude', id: 's 1' }, d);
    expect(d.navigate).toHaveBeenLastCalledWith('/sessions/claude/s%201', undefined);
    await runPaletteAction({ type: 'navigate', to: '/live', search: { status: 'waiting' } }, d);
    expect(d.navigate).toHaveBeenLastCalledWith('/live', { status: 'waiting' });
    await runPaletteAction({ type: 'launch', templateId: 'implement', projectId: 'wakecap' }, d);
    expect(d.openLaunch).toHaveBeenCalledWith({ templateId: 'implement', projectId: 'wakecap' });
    await runPaletteAction({ type: 'resumeLast', projectId: 'wakecap' }, d);
    expect(d.resumeLast).toHaveBeenCalledWith('wakecap');
    await runPaletteAction({ type: 'openUrl', url: 'https://x' }, d);
    expect(d.openUrl).toHaveBeenCalledWith('https://x');
    await runPaletteAction({ type: 'openPlan', path: '/p', title: 'T' }, d);
    expect(d.openPlan).toHaveBeenCalledWith('/p', 'T');
  });
});
```

`apps/web/src/features/palette/CommandPalette.test.tsx`
```tsx
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePaletteStore } from '@/stores/palette';
import { useProjectStore } from '@/stores/project';
import { stubReactFlowDom } from '@/test/flow-stubs';
import { renderP3 } from '@/test/p3-render';
import { CommandPalette } from './CommandPalette.tsx';

const m = vi.hoisted(() => ({
  navigate: vi.fn(),
  openLaunch: vi.fn(),
  openTerminal: vi.fn(),
  sessionsList: vi.fn(),
  sessionsResume: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => m.navigate }));
vi.mock('@/stores/launch', () => ({
  useLaunchStore: (sel: (s: { show: typeof m.openLaunch }) => unknown) => sel({ show: m.openLaunch }),
}));
vi.mock('@/stores/terminals', () => ({ useTerminalStore: { getState: () => ({ open: m.openTerminal }) } }));
vi.mock('@/api/client', () => ({ getApiClient: () => ({ sessionsList: m.sessionsList, sessionsResume: m.sessionsResume }) }));
vi.mock('@/api/queries/sessions', () => ({
  useSessions: () => ({
    data: {
      items: [
        { source: 'claude', id: 's-prlink', name: 'SAF-1787 SLA weekends', firstPrompt: null, projectId: 'wakecap', tickets: ['SAF-1787'], prs: [{ repo: 'example-org/svc', number: 231, url: 'https://github.com/example-org/svc/pull/231' }] },
      ],
      nextCursor: null,
    },
  }),
}));
vi.mock('@/api/queries/projects', () => ({ useProjects: () => ({ data: [{ id: 'wakecap', name: 'Wakecap' }] }) }));
vi.mock('@/api/queries/templates', () => ({ useTemplates: () => ({ data: [{ id: 'implement', label: 'Implement ticket' }] }) }));
vi.mock('@/api/queries/safety', () => ({
  usePlans: () => ({ data: [{ path: '/p/SAF-1787.md', title: 'SLA plan', source: 'wakecap-plans', mtime: '', reason: 'query', tickets: ['SAF-1787'] }] }),
  usePlanContent: (path: string | null) => ({ data: path ? { path, text: '# SLA plan body' } : undefined }),
}));

beforeAll(() => {
  stubReactFlowDom();
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({ projectId: 'wakecap' });
  act(() => usePaletteStore.setState({ open: true }));
});

const item = (name: string | RegExp) => screen.getByRole('option', { name });

describe('CommandPalette', () => {
  it('navigates and closes', async () => {
    renderP3(<CommandPalette />);
    await userEvent.click(item(/Open inbox/));
    expect(m.navigate).toHaveBeenCalledWith({ to: '/inbox', search: undefined });
    expect(usePaletteStore.getState().open).toBe(false);
  });

  it('jumps to a session found by ticket keyword', async () => {
    renderP3(<CommandPalette />);
    await userEvent.type(screen.getByRole('combobox'), 'SAF-1787');
    await userEvent.click(item(/SAF-1787 SLA weekends/));
    expect(m.navigate).toHaveBeenCalledWith({ to: '/sessions/claude/s-prlink', search: undefined });
  });

  it('resumes the last session in a project into the terminal dock', async () => {
    m.sessionsList.mockResolvedValue({ items: [{ source: 'claude', id: 's-basic', name: 'notification-tests' }], nextCursor: null });
    m.sessionsResume.mockResolvedValue({ ptyId: 'p1' });
    renderP3(<CommandPalette />);
    await userEvent.click(item(/Resume last session in Wakecap/));
    await waitFor(() => expect(m.openTerminal).toHaveBeenCalledWith('p1', 'notification-tests'));
    expect(m.sessionsList).toHaveBeenCalledWith({ projectId: 'wakecap', availability: 'resumable', limit: 1 });
    expect(m.sessionsResume).toHaveBeenCalledWith('claude', 's-basic', { mode: 'embedded' });
  });

  it('shows an error when there is nothing to resume', async () => {
    m.sessionsList.mockResolvedValue({ items: [], nextCursor: null });
    renderP3(<CommandPalette />);
    await userEvent.click(item(/Resume last session in Wakecap/));
    expect((await screen.findByRole('alert')).textContent).toBe('No resumable session in this project');
  });

  it('opens the launch dialog with a template', async () => {
    renderP3(<CommandPalette />);
    await userEvent.click(item(/Launch: Implement ticket/));
    expect(m.openLaunch).toHaveBeenCalledWith({ templateId: 'implement', projectId: 'wakecap' });
  });

  it('previews a plan and opens PRs in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderP3(<CommandPalette />);
    await userEvent.click(item(/example-org\/svc#231/));
    expect(open).toHaveBeenCalledWith('https://github.com/example-org/svc/pull/231', '_blank', 'noopener');
    act(() => usePaletteStore.setState({ open: true }));
    await userEvent.click(item(/SLA plan/));
    expect(screen.getByTestId('palette-plan').textContent).toBe('# SLA plan body');
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('combobox')).toBeDefined();
  });
});
```

Run: `pnpm vitest run apps/web/src/features/palette`
Expected: FAIL, `Cannot find module './palette-items.ts'`

- [ ] **Step 4: Implement the palette**

`apps/web/src/features/palette/palette-items.ts`
```ts
import type { PlanRef } from '@orc/api-contract';
import type { PrRef, Source } from '@orc/core';

export type PaletteAction =
  | { type: 'navigate'; to: string; search?: Record<string, string> }
  | { type: 'openSession'; source: Source; id: string }
  | { type: 'resumeLast'; projectId: string }
  | { type: 'launch'; templateId?: string; projectId?: string }
  | { type: 'openUrl'; url: string }
  | { type: 'openPlan'; path: string; title: string };

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  keywords: string[];
  shortcut?: string;
  action: PaletteAction;
}

export interface PaletteSection {
  heading: string;
  items: PaletteItem[];
}

export interface PaletteSession {
  source: Source;
  id: string;
  name: string | null;
  firstPrompt: string | null;
  projectId: string | null;
  tickets: string[];
  prs: PrRef[];
}

export interface PaletteInput {
  sessions: PaletteSession[];
  projects: Array<{ id: string; name: string }>;
  templates: Array<{ id: string; label: string }>;
  plans: PlanRef[];
  currentProjectId: string | null;
}

const NAVIGATION: PaletteItem[] = [
  { id: 'nav:inbox', label: 'Open inbox', keywords: ['attention'], shortcut: 'g i', action: { type: 'navigate', to: '/inbox' } },
  { id: 'nav:waiting', label: 'Waiting sessions', keywords: ['live', 'input'], shortcut: 'g w', action: { type: 'navigate', to: '/live', search: { status: 'waiting' } } },
  { id: 'nav:history', label: 'History', keywords: ['search', 'sessions'], shortcut: 'g h', action: { type: 'navigate', to: '/history' } },
  { id: 'nav:live', label: 'Live board', keywords: ['running'], action: { type: 'navigate', to: '/live' } },
  { id: 'nav:audit', label: 'Audit log', keywords: ['actions'], shortcut: 'g a', action: { type: 'navigate', to: '/audit' } },
  { id: 'nav:settings', label: 'Settings', keywords: ['config', 'secrets'], action: { type: 'navigate', to: '/settings' } },
];

export function buildPaletteSections(input: PaletteInput): PaletteSection[] {
  const projects = [...input.projects].sort((a, b) =>
    a.id === input.currentProjectId ? -1 : b.id === input.currentProjectId ? 1 : a.name.localeCompare(b.name),
  );
  const actions: PaletteItem[] = [
    { id: 'act:new', label: 'New session', keywords: ['launch', 'start'], shortcut: 'n', action: { type: 'launch' } },
    ...projects.map((p) => ({
      id: `act:resume:${p.id}`,
      label: `Resume last session in ${p.name}`,
      keywords: ['resume', p.id],
      action: { type: 'resumeLast', projectId: p.id } as const,
    })),
    ...input.templates.map((t) => ({
      id: `act:launch:${t.id}`,
      label: `Launch: ${t.label}`,
      keywords: ['template', 'launch', t.id],
      action: {
        type: 'launch',
        templateId: t.id,
        ...(input.currentProjectId ? { projectId: input.currentProjectId } : {}),
      } as PaletteAction,
    })),
  ];

  const sessions: PaletteItem[] = input.sessions.map((s) => ({
    id: `session:${s.source}:${s.id}`,
    label: s.name ?? s.firstPrompt?.slice(0, 80) ?? s.id,
    hint: `${s.source}${s.projectId ? ` · ${s.projectId}` : ''}`,
    keywords: [s.id, ...s.tickets, ...s.prs.map((p) => `${p.repo}#${p.number}`)],
    action: { type: 'openSession', source: s.source, id: s.id },
  }));

  const tickets = [...new Set(input.sessions.flatMap((s) => s.tickets))].map<PaletteItem>((t) => ({
    id: `ticket:${t}`,
    label: t,
    hint: 'filter history',
    keywords: ['ticket'],
    action: { type: 'navigate', to: '/history', search: { ticket: t } },
  }));

  const prMap = new Map<string, PrRef>();
  for (const s of input.sessions) for (const p of s.prs) prMap.set(p.url, p);
  const prs = [...prMap.values()].map<PaletteItem>((p) => ({
    id: `pr:${p.url}`,
    label: `${p.repo}#${p.number}`,
    hint: 'open on GitHub',
    keywords: ['pr', 'pull request'],
    action: { type: 'openUrl', url: p.url },
  }));

  const plans = input.plans.map<PaletteItem>((p) => ({
    id: `plan:${p.path}`,
    label: p.title,
    hint: p.source,
    keywords: ['plan', ...p.tickets],
    action: { type: 'openPlan', path: p.path, title: p.title },
  }));

  return [
    { heading: 'Navigation', items: NAVIGATION },
    { heading: 'Actions', items: actions },
    { heading: 'Sessions', items: sessions },
    { heading: 'Tickets', items: tickets },
    { heading: 'Pull requests', items: prs },
    { heading: 'Plans', items: plans },
  ].filter((s) => s.items.length > 0);
}

export interface PaletteDeps {
  navigate(to: string, search?: Record<string, string>): void;
  openLaunch(prefill?: { templateId?: string; projectId?: string }): void;
  resumeLast(projectId: string): Promise<void>;
  openUrl(url: string): void;
  openPlan(path: string, title: string): void;
}

export async function runPaletteAction(a: PaletteAction, d: PaletteDeps): Promise<void> {
  switch (a.type) {
    case 'navigate':
      d.navigate(a.to, a.search);
      return;
    case 'openSession':
      d.navigate(`/sessions/${a.source}/${encodeURIComponent(a.id)}`, undefined);
      return;
    case 'launch': {
      const prefill: { templateId?: string; projectId?: string } = {};
      if (a.templateId) prefill.templateId = a.templateId;
      if (a.projectId) prefill.projectId = a.projectId;
      d.openLaunch(Object.keys(prefill).length ? prefill : undefined);
      return;
    }
    case 'resumeLast':
      await d.resumeLast(a.projectId);
      return;
    case 'openUrl':
      d.openUrl(a.url);
      return;
    case 'openPlan':
      d.openPlan(a.path, a.title);
      return;
  }
}
```

In the palette-items test the projects are `Stocks` and `Wakecap`. The current project `wakecap` sorts first, which is why the actions list shows `Resume last session in Wakecap` before `Stocks`.

`apps/web/src/features/palette/CommandPalette.tsx`
```tsx
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { useMemo, useState } from 'react';
import { getApiClient } from '@/api/client';
import { useProjects } from '@/api/queries/projects';
import { usePlanContent, usePlans } from '@/api/queries/safety';
import { useSessions } from '@/api/queries/sessions';
import { useTemplates } from '@/api/queries/templates';
import { formatKeys } from '@/features/hotkeys/registry';
import { useLaunchStore } from '@/stores/launch';
import { usePaletteStore } from '@/stores/palette';
import { useProjectStore } from '@/stores/project';
import { useTerminalStore } from '@/stores/terminals';
import { type PaletteAction, buildPaletteSections, runPaletteAction } from './palette-items.ts';

export async function resumeLastInProject(projectId: string): Promise<void> {
  const api = getApiClient();
  const list = await api.sessionsList({ projectId, availability: 'resumable', limit: 1 });
  const s = list.items[0];
  if (!s) throw new Error('No resumable session in this project');
  const r = await api.sessionsResume(s.source, s.id, { mode: 'embedded' });
  if ('ptyId' in r) useTerminalStore.getState().open(r.ptyId, s.name ?? s.id);
}

export function CommandPalette() {
  const open = usePaletteStore((s) => s.open);
  const setOpen = usePaletteStore((s) => s.setOpen);
  const projectId = useProjectStore((s) => s.projectId);
  const openLaunch = useLaunchStore((s) => s.show);
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [plan, setPlan] = useState<{ path: string; title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trimmed = query.trim();
  // Jumping searches every project; the project selector only scopes the actions list order.
  const sessions = useSessions({ q: trimmed || undefined, limit: 20 });
  const projects = useProjects();
  const templates = useTemplates(projectId ?? undefined);
  const plans = usePlans(trimmed);
  const planContent = usePlanContent(plan?.path ?? null);

  const sections = useMemo(
    () =>
      buildPaletteSections({
        sessions: sessions.data?.items ?? [],
        projects: projects.data ?? [],
        templates: templates.data ?? [],
        plans: plans.data ?? [],
        currentProjectId: projectId ?? null,
      }),
    [sessions.data, projects.data, templates.data, plans.data, projectId],
  );

  const close = () => {
    setOpen(false);
    setQuery('');
    setPlan(null);
    setError(null);
  };

  const run = (a: PaletteAction) => {
    setError(null);
    runPaletteAction(a, {
      navigate: (to, search) => {
        close();
        void navigate({ to, search } as never);
      },
      openLaunch: (prefill) => {
        close();
        openLaunch(prefill);
      },
      resumeLast: async (pid) => {
        await resumeLastInProject(pid);
        close();
      },
      openUrl: (url) => {
        window.open(url, '_blank', 'noopener');
        close();
      },
      openPlan: (path, title) => setPlan({ path, title }),
    }).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Action failed'));
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(v) => (v ? setOpen(true) : close())}
      label="Command palette"
      className="fixed left-1/2 top-24 z-50 w-[640px] max-w-[95vw] -translate-x-1/2 rounded-lg border border-neutral-200 bg-white shadow-xl"
    >
      {plan ? (
        <div className="p-3 text-sm">
          <button type="button" onClick={() => setPlan(null)} className="mb-2 underline">
            Back
          </button>
          <h2 className="mb-1 font-semibold">{plan.title}</h2>
          <pre data-testid="palette-plan" className="max-h-[60vh] overflow-auto whitespace-pre-wrap text-xs">
            {planContent.data?.text ?? 'Loading…'}
          </pre>
        </div>
      ) : (
        <>
          <Command.Input
            value={query}
            onValueChange={setQuery}
            placeholder="Jump to a session, ticket, PR or plan, or run an action…"
            className="w-full border-b border-neutral-200 px-3 py-2 outline-none"
          />
          {error && (
            <p role="alert" className="px-3 py-1 text-xs text-red-600">
              {error}
            </p>
          )}
          <Command.List className="max-h-[60vh] overflow-auto p-1">
            <Command.Empty className="p-3 text-sm text-neutral-500">No results.</Command.Empty>
            {sections.map((section) => (
              <Command.Group key={section.heading} heading={section.heading} className="text-xs text-neutral-500">
                {section.items.map((it) => (
                  <Command.Item
                    key={it.id}
                    value={`${it.label} ${it.id}`}
                    keywords={it.keywords}
                    onSelect={() => run(it.action)}
                    className="flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-sm text-neutral-900 data-[selected=true]:bg-neutral-100"
                  >
                    <span>{it.label}</span>
                    <span className="ml-2 flex items-center gap-2 text-xs text-neutral-500">
                      {it.hint && <span>{it.hint}</span>}
                      {it.shortcut && <kbd>{formatKeys(it.shortcut)}</kbd>}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </>
      )}
    </Command.Dialog>
  );
}
```

A cmdk item has `role="option"`, and its accessible name comes from its text (label + hint + shortcut). That is why the tests match names with regexes. `Command.Input` has `role="combobox"`.

- [ ] **Step 5: Mount everything in the shell and move inbox keys onto the registry**

`apps/web/src/features/shell/AppShell.tsx`: render these once, next to the existing `useLiveEvents()` call site:
```tsx
import { GlobalHotkeys } from '@/features/hotkeys/GlobalHotkeys';
import { HotkeysListener } from '@/features/hotkeys/HotkeysListener';
import { CommandPalette } from '@/features/palette/CommandPalette';
import { usePaletteStore } from '@/stores/palette';
// …inside the returned JSX (top level):
<HotkeysListener />
<GlobalHotkeys />
<CommandPalette />
// make the top-bar search box open the palette:
<button type="button" onClick={() => usePaletteStore.getState().setOpen(true)} aria-label="Open command palette">Search… ⌘K</button>
```

`apps/web/src/features/inbox/useInboxKeys.ts` (A13): replace Phase 2's own `window` listener with registry bindings. The signature and behaviour stay the same (the registry already skips typing targets):
```ts
import { useEffect, useState } from 'react';
import { useHotkeys } from '@/features/hotkeys/registry';
import { useLaunchStore } from '../../stores/launch.ts';

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

  const guard = (fn: () => void) => () => {
    if (count === 0 || useLaunchStore.getState().open) return;
    fn();
  };

  useHotkeys(
    [
      { id: 'inbox-next', keys: 'j', description: 'Next item', group: 'inbox', handler: guard(() => setSelected((s) => Math.min(count - 1, s + 1))) },
      { id: 'inbox-prev', keys: 'k', description: 'Previous item', group: 'inbox', handler: guard(() => setSelected((s) => Math.max(0, s - 1))) },
      { id: 'inbox-done', keys: 'e', description: 'Mark done', group: 'inbox', handler: guard(() => onDone(selected)) },
      { id: 'inbox-snooze', keys: 's', description: 'Snooze', group: 'inbox', handler: guard(() => onSnooze(selected)) },
      { id: 'inbox-open', keys: 'enter', description: 'Open item', group: 'inbox', handler: guard(() => onOpen(selected)) },
    ],
    [count, selected, onDone, onSnooze, onOpen],
  );

  return { selected, setSelected };
}
```
Phase 2's inbox tests dispatch `keydown` on `window`, so they now need the single listener. Add `<HotkeysListener />` next to the component under test in their render call (or in `apps/web/src/test/render.tsx` if that wrapper is shared). The assertions stay unchanged.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/web/src/features/hotkeys apps/web/src/features/palette apps/web/src/features/inbox`
Expected: PASS (5 + 3 + 6 tests, plus the unchanged Phase 2 inbox tests)

- [ ] **Step 7: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/web
git commit -m "feat(web): add shared hotkey registry, global shortcuts and cmdk command palette"
```

---

### Task 19: M3 exit — end-to-end check, contract merge and phase close

**Files:**
- Create: `apps/web/e2e/session-detail-conductor.spec.ts`
- Modify: `plan/00-contracts.md` (merge the Contract additions), `plan/README.md` (status table)

**Interfaces:**
- Consumes: everything above; Playwright global setup (A14); fixture `s-subagents` (contracts §9)
- Produces: M3 exit evidence, and an updated contracts file that later phases rely on

- [ ] **Step 1: Write the end-to-end spec**

`apps/web/e2e/session-detail-conductor.spec.ts`
```ts
import { type Page, expect, test } from '@playwright/test';

// baseURL and the fixture daemon come from apps/web/playwright.config.ts (A14).
async function tokenOf(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __ORC_TOKEN__: string }).__ORC_TOKEN__);
}

async function expandIfCollapsed(page: Page, labels: string[]) {
  for (const label of labels) {
    const button = page.getByRole('button', { name: `Expand ${label}` });
    if ((await button.count()) > 0) await button.click();
  }
}

test.describe('M3 exit: a subagent session is understandable without the terminal', () => {
  test.describe.configure({ mode: 'serial' });

  test('timeline, stats, agents, usage, files, links, raw and export', async ({ page }) => {
    await page.goto('/sessions/claude/s-subagents');
    await expect(page.getByRole('heading', { name: 'investigate SUPRT-1557' })).toBeVisible();
    await expect(page.getByTestId('session-stats')).toContainText('model');
    await expect(page.getByRole('button', { name: 'Agent ×1' })).toBeVisible();

    await page.getByRole('radio', { name: 'Verbose' }).click();
    await expect(page.getByRole('button', { name: 'Agent: Explore logs' })).toBeVisible();
    await page.getByRole('button', { name: 'Agent: Explore logs' }).click();
    await expect(page.getByRole('complementary', { name: 'Step inspector' })).toContainText('"subagent_type": "Explore"');
    await page.getByRole('radio', { name: 'Normal' }).click();

    await page.getByRole('tab', { name: /Agents/ }).click();
    await expect(page.getByTestId('agent-node-ag1')).toBeVisible();
    await expect(page.getByTestId('agent-node-ag1')).toContainText('background');
    await expandIfCollapsed(page, ['Explore logs', 'Deep dive']);
    await page.getByRole('button', { name: 'Open Leaf' }).click();
    await expect(page).toHaveURL(/tab=timeline/);
    await expect(page).toHaveURL(/agent=ag3/);
    await expect(page.getByText('Subagent: Leaf')).toBeVisible();
    await expect(page.getByText('done', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to main session' }).click();

    await page.getByRole('tab', { name: 'Usage' }).click();
    await expect(page.getByTestId('usage-chart').locator('canvas')).toBeVisible();

    await page.getByRole('tab', { name: 'Files' }).click();
    await expect(page.getByText('No files were edited by tools in this session.')).toBeVisible();

    await page.getByRole('tab', { name: 'Links' }).click();
    await expect(page.getByRole('region', { name: 'Tickets' })).toContainText('SUPRT-1557');

    await page.getByRole('tab', { name: 'Raw' }).click();
    await expect(page.getByText('"sessionId":"s-subagents"').first()).toBeVisible();
    await page.getByRole('combobox', { name: 'Transcript' }).selectOption('ag1');
    await expect(page.getByText('"agentId":"ag1"').first()).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export ZIP' }).click();
    expect((await download).suggestedFilename()).toBe('claude-s-subagents.zip');
  });

  test('palette jumps to the session and every app action is in the audit log', async ({ page, request }) => {
    await page.goto('/history');
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('combobox').fill('SUPRT-1557');
    await page.getByRole('option', { name: /investigate SUPRT-1557/ }).click();
    await expect(page).toHaveURL(/\/sessions\/claude\/s-subagents/);

    const auth = { 'x-orc-token': await tokenOf(page) };
    const resumed = await request.post('/api/sessions/claude/s-subagents/resume', {
      headers: auth,
      data: { mode: 'embedded' },
    });
    expect(resumed.ok()).toBeTruthy();
    const { ptyId } = (await resumed.json()) as { ptyId: string };
    const killed = await request.delete(`/api/pty/${ptyId}`, { headers: auth, data: { confirm: true } });
    expect(killed.ok()).toBeTruthy();

    await page.goto('/audit?sessionPk=claude%3As-subagents');
    await expect(page.getByRole('cell', { name: 'session.resume' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'session.kill' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'session.export' })).toBeVisible();

    await page.locator('body').click();
    await page.keyboard.press('g');
    await page.keyboard.press('i');
    await expect(page).toHaveURL(/\/inbox/);
  });
});
```

The `session.export` row comes from the first test's download, so the two tests share one daemon and run in order (`mode: 'serial'`). The e2e server's fake `claude` (A14) makes the resume succeed without a real CLI.

- [ ] **Step 2: Run the end-to-end spec**

Run: `pnpm --filter @orc/web build && pnpm --filter @orc/web e2e session-detail-conductor`
Expected: `2 passed`. If the Phase 1 turn numbering puts the `s-subagents` subagent text under a different heading, keep the `done` assertion and adjust only the heading lookup. Record that in the review note.

- [ ] **Step 3: Manual check against a real `/conductor` session (read-only, with evidence)**

1. `pnpm dev`, then open the app on the real `~/.claude` (the daemon only reads it).
2. Press ⌘K, type `conductor`, and open the most recent session whose skills include `conductor`.
3. Check each item and take a screenshot of each:
   - **(a)** Agents tab → *Conductor chain* shows the steps in order with statuses. Every subagent maps to a step, or stays visible in the tree view.
   - **(b)** Timeline → Summary mode shows every turn's stats and deliverables.
   - **(c)** Links tab shows the ticket, the PR and the matched plan.
   - **(d)** The header shows the permission badge, and a PROD badge if prod was touched.
   - **(e)** Export ZIP opens and contains no token (`unzip -p <zip> transcript.jsonl | grep -E 'ghp_|sk-ant-|xox[bp]-' || echo clean` prints `clean`).
   - **(f)** Settings → Secrets hygiene lists `~/Wakecap/.mcp.json` with line numbers and no values.

   If an agent maps to the wrong step, add a rule to `RULES` in `conductor.ts` (from `~/Wakecap/agent-conductor/agents/*.md`, read-only) together with a test case, then re-run Task 15's tests.

Save the screenshots under `plan/spikes/evidence/phase-3/` and reference them in the review note.

- [ ] **Step 4: Check the exit criteria**

| Criterion (docs/05-roadmap.md M3) | Evidence |
|---|---|
| Timeline with step inspector and timing stats | Task 14 tests; e2e test 1 |
| Deliverables row | Task 4 + Task 14 tests; manual (b) |
| Summary/Normal/Verbose modes | Task 14 tests; e2e test 1 |
| Agents tree (failed/running expanded) + conductor rendering | Task 15 tests; e2e test 1; manual (a) |
| Usage chart, Files, Links, Raw tabs | Task 16 tests; e2e test 1 |
| Export | Task 12 tests; e2e test 1; manual (e) |
| Safety: badges, redaction, shared deny-list | Tasks 1, 2, 8, 11 tests; manual (d), (f) |
| Audit log (F24) | Tasks 6, 7 tests; e2e test 2 |
| Command palette (F8) | Task 18 tests; e2e test 2 |
| **Exit:** a `/conductor` session can be understood without the terminal | e2e test 1 + manual (a)–(d) |
| **Exit:** every app action appears in the audit log | `audit.coverage.test.ts` (every non-GET route classified) + `audit.routes.test.ts` + e2e test 2 |
| `pnpm lint && pnpm typecheck && pnpm test` green; `pnpm check:fixtures` clean | command output |

- [ ] **Step 5: Merge the contract additions**

Edit `plan/00-contracts.md`. Copy each block **verbatim** from this plan's "Contract additions" section:
- **§3:** add the `safety` and `links` properties to the `OrcConfig` zod block.
- **§4:**
  - add the derived types and functions under a new sub-heading "Derived (Phase 3, `@orc/core/src/derive/*`)"
  - add `session.export`, `session.open` and `archive.sync` to the audit action list
- **§6:**
  - add the P3 routes (replacing the two existing P3 lines with the full list)
  - add `| { type: 'audit.recorded'; entry: AuditEntry }` to `LiveEvent`
  - add the P3 client method names
- **§8:** add `redactDeep` and `redactPartialTokens` next to `redact`. Also add: "Routes send transcript JSON through `redactedJson`. FTS snippets use the daemon's `redactSnippet` (which composes `redactPartialTokens`). WS events pass through `toWireEvent`."
- **§11:**
  - replace the P3 audit block with the version that includes `AuditListFilter`, `DeniedError`, `createAuditService`, `AuditedRoute`, `AUDITED_ROUTES`, `NON_ACTION_ROUTES`, `auditMiddleware` and `withPtyInputAudit`
  - add `createDenyList`
  - add the rule: "**A new write route must be added to `AUDITED_ROUTES` or `NON_ACTION_ROUTES` (enforced by `audit.coverage.test.ts`).**"
- **§12:** add the view-mode and palette stores, the hotkey registry, the query keys, the `/sessions/$source/$id` search params and the global shortcuts.

Run: `grep -n "redactPartialTokens\|AUDITED_ROUTES\|audit.recorded\|useHotkeys\|session.export" plan/00-contracts.md`
Expected: at least one hit for each name.

- [ ] **Step 6: Update the status, commit and merge**

In `plan/README.md`, set the Phase 3 row's Status to `☑ done (YYYY-MM-DD)`.

```bash
git add apps/web/e2e plan
git commit -m "docs(plan): merge phase 3 contract additions and record M3 exit evidence"
git checkout main
git merge --no-ff phase/3-session-detail-safety-audit -m "merge: phase 3 session detail, safety and audit"
```

---

## Self-review

**Spec coverage**

| Requirement | Task |
|---|---|
| F2 step timing: model vs tool time, TTFT, tokens/sec, cache hit rate (per turn + session) | 3 (core), 9 (route), 14 (UI) |
| F2 deliverables per turn from Edit/Write/MultiEdit/NotebookEdit inputs (+ Codex apply_patch) | 4, 9, 14 |
| F2 stats/deliverables API routes | 5, 9 |
| F2 timeline step inspector; Summary/Normal/Verbose; grouped tools; live follow; lazy load | 14 |
| F2 agents tree (@xyflow, tiered layout, failed/running expanded, node → transcript) | 15, 16 |
| F2 conductor chain rendering | 15, 16, 19 (manual) |
| F2 Usage tab (cumulative cost/tokens per model, cache split) | 9, 16 |
| F2 Files tab | 4, 9, 16 |
| F2 Links tab (PRs, tickets, `~/.claude/plans`, `~/Wakecap/plans/**`, repo `docs/superpowers/*`, artifacts, bridge; read-only) | 10, 16 |
| F2 Raw tab (paged JSONL, subagents, partial lines) | 9, 16 |
| F2 Export ZIP (fflate, redacted by default, subagents, recap/handoff null-safe, confirm for unredacted) | 12, 16 |
| F9 prod detection (skills + configurable patterns) and badge | 2, 9, 16 |
| F9 permission-mode badge incl. `custom` | 2, 9, 16 |
| F9 `DEFAULT_DENY_PATTERNS` + `checkDenied` (pure) + `DenyList` (project prodPatterns merged) | 1, 8 |
| F9 redaction on all transcript-bearing responses, FTS snippets, WS | 1, 9, 10, 11, 12 |
| F9 secrets hygiene panel (file + kind + line, never values, read-only, configurable list) | 2, 8, 17 |
| F24 `audit_log` table (append-only), `AuditService`, `audited()` | 6 |
| F24 retrofit: session.resume/fork/launch/kill, pty.input, archive.restore (+ export), with route tests | 7, 12 |
| F24 `/api/audit` + `/audit` page with filters; redacted params | 6, 7, 17 |
| F8 ⌘K palette: sessions, tickets, PRs, plans; resume last per project; launch template; open inbox | 18 |
| F8 shortcuts g i / g w / g h / n (+ g a); shared `useHotkeys` registry; inbox j/k/e/s stay in Phase 2 | 18 |
| M3 exit criteria | 19 |

**Placeholder scan:** there is no "TBD", "TODO" or "similar to Task N". Every code step contains complete code. The Phase 1/2 touch points (A1–A14) were checked against `plan/phase-1-history-search-resume.md` and `plan/phase-2-live-board-inbox-archive.md`. That check changed several names in this plan:
- `register<Area>Routes(app, ctx)` and `createApp(o)`
- `buildContext` wiring
- the sync `createTestContext` + `indexFixtures` (wrapped in `p3-harness.ts`)
- `useSessionEvents(source, id, agentId)`
- `useLaunchStore.show`
- `useInboxKeys`
- `live.ts` / `live-events.ts` / `live-ws.ts`
- `routes/sessions/$source/$id.tsx`
- reuse of `DEFAULT_PROD_PATTERNS`, `DEFAULT_TICKET_REGEX`/`compileTicketRegex`, `mcpToolLabel` and `redact-out.ts`

There is no price table in Phase 1, so the usage chart apportions the `cost-state` total instead.

**Type consistency, checked:**
- `TurnStats` and `SessionStats` fields match between core (Task 3), the zod schemas (Task 5, enforced by `expectTypeOf`) and the UI (Task 14).
- The `turnKey` format `main:<turn>` / `<agentId>:<turn>` is used by both the stats and deliverables maps.
- `DeliverableFile`, `FileSummary` and `FileChange` share one definition in core. The schemas mirror it.
- `UsagePoint`, `SessionSafety`, `RawPage`, `RawLine`, `PlanRef`, `SessionLinks`, `SecretsReport` and `AuditQuery` are defined once in api-contract. The daemon and web import them.
- `AuditService.list(filter: AuditListFilter)` is a superset of contracts §11. `audited()` has the exact §11 signature.
- `DenyVerdict`, `checkDenied` and `DEFAULT_DENY_PATTERNS` use the exact §11 names. `DenyList.check(text, projectId)` matches §11.
- The `ViewMode` union is shared by the store (Task 13) and `buildTurnViews` (Task 14).
- `DetailTab` and `DetailNavigation` are shared by the route file and `SessionDetailTabs`.
- `HotkeyBinding.keys` uses the `mod+k` / `g i` syntax in the registry, `GlobalHotkeys`, the palette items and `formatKeys`.
- `sessionParams` (Task 9) is reused by the links (Task 10) and export (Task 12) routes.
- Every route module uses the Phase 1 `register<Area>Routes(app: OrcApp, ctx)` form with absolute `/api/...` paths, and is registered before the `/api/*` catch-all.
- Every daemon HTTP test uses `createP3Harness()`, which goes through the real `createApp` (token, host checks, audit middleware).
- `redactedJson` (Task 9) is reused in Tasks 10 and 11.
- `expandHome` (Task 8) is reused in Task 10.
- `stubReactFlowDom` (Task 15) is reused in Task 18.
