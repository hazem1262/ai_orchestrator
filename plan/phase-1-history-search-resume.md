# Phase 1 — History, Search & Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Symbol ownership:** before creating any exported symbol, check `00-contracts.md` §13. Where two phases touch the same symbol, the owning phase creates the file and later phases modify it instead of redefining.

**Goal:** Ship the first usable version (M1): a daemon that indexes Claude and Codex history into SQLite + FTS5, and a web UI with a project selector, a searchable History list, a basic Session Detail (header + timeline), and one-click resume / fork / adopt / pop-out into an embedded xterm.js terminal.

**Architecture:** `@orc/core` gets pure aggregators that turn Claude/Codex JSONL records into `Session`, `TimelineEvent` and `AgentNode` values. Their state can be serialised, so the daemon can resume indexing from a byte offset. The daemon (`apps/daemon`) wires config, Drizzle/SQLite, repositories, an indexer (startup scan + chokidar), services (projects, sessions, user metadata), a node-pty manager, a Hono REST API and a `ws` PTY socket. The web app (`apps/web`) uses TanStack Router/Query/Table/Virtual, Zustand and xterm.js, and reaches the daemon only through `@orc/api-contract`.

**Tech Stack:** Node 22, TypeScript ~6.0.3, Vitest 5, Biome 2, zod 4, better-sqlite3 13 + drizzle-orm 0.45 (FTS5), chokidar 5, node-pty 1.1, hono 4 + @hono/node-server 2, ws 8, pino 10, execa 10, React 19, TanStack Router 1 / Query 5 / Table 9 / Virtual 3, Zustand 5, @xterm/xterm 6, react-resizable-panels 4, Playwright 1.63.

**Spec:** `docs/02-features.md` (F2 basic, F3, F4 resume/fork/adopt/pop-out, F13), `docs/03-architecture-and-stack.md` (Key flows 2–4, Security, Performance targets), `docs/04-data-sources.md` (A1–A3, B1), `docs/05-roadmap.md` (M1), `plan/00-contracts.md` (all sections). Spike reports `plan/spikes/S1.md`, `S2-S8.md`, `S5.md`, `S6.md` override details here (see plan/README.md, "Execution handoff").

## Global Constraints
- **Toolchain:** Node `>=22.12 <23`, pnpm `10.18.3`, TypeScript `~6.0.3` strict (plus `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Vitest 5, Biome 2. Versions come from contracts §1.
- **Local only:** the daemon binds to `127.0.0.1`. Every API/WS request needs `x-orc-token` (WS may use `?token=`). WS upgrades must pass the Origin check.
- **Read-only toward tool data:** never write to `~/.claude` or `~/.codex`. Never read `*.key`, `~/.codex/auth.json`, or auth fields in `~/.claude.json`. Claude's `messagingSocketPath` is never used.
- **Redaction:** transcript text leaves the daemon only after `redact()`, applied in the route layer. The DB keeps raw text.
- **Input to sessions:** only to **owned** sessions (spawned or resumed in the app's PTY).
- **Defaults (decided):** resume flags `--dangerously-skip-permissions`; default project `wakecap`; Codex automated sessions (`originator: codex_sdk_ts`) hidden by default.
- `@orc/core` must not import `node:fs`, `node:net` or `node:child_process` outside `src/io/*`. The web app and `@orc/api-contract` only use `import type` from `@orc/core`; value imports in the web app come from `@orc/core/browser`.
- Relative imports keep the `.ts` / `.tsx` extension (Phase 0 convention). Biome forbids `any` and non-null assertions (`!`).
- **Fixtures** are made up and redacted; `pnpm check:fixtures` must pass. Tests never touch the real home: they use `useTempHomes()` / `makeTempHomes()`.
- **Gate before every commit:** `pnpm format && pnpm lint && pnpm typecheck && pnpm test`. Commits use Conventional Commits with a scope and end with the session's attribution lines.
- Work on branch `phase/1-history-search-resume`.

---

## Contract additions

These are merged into `plan/00-contracts.md` in Task 20.

```ts
// §3 — apps/daemon/src/config.ts
export interface OrcPaths { orcHome: string; claudeHome: string; codexHome: string; dbFile: string; tokenFile: string; archiveDir: string; logFile: string; userHome: string }  // + userHome (env ORC_USER_HOME, default os.homedir())
export function ensureToken(paths: OrcPaths): string          // creates $ORC_HOME/token (0600) if missing
// env: ORC_PORT (overrides config.port), ORC_LOG_LEVEL (pino level, default info)
// env: ORC_DEV=1 also allows host/origin 127.0.0.1:5173 and localhost:5173 (Vite dev server)

// §4 — TimelineEvent: for kind 'system', `tool` holds the system subtype (e.g. 'turn_duration', 'away_summary').

// §5 — tables (Phase 1 shapes)
// events: surrogate `id INTEGER PRIMARY KEY` (FTS5 content_rowid) + UNIQUE(session_pk, agent_id, seq); agent_id '' = main session.
// events_fts: fts5(text, search_input, content='events', content_rowid='id'); rows with kind 'tool_result' | 'thinking' are not indexed.
// sessions: data_json (full Session) + filter columns; origin 'transcript' | 'history'.
// file_offsets: path, kind, session_pk, agent_id, size, mtime_ms, offset, state_json, updated_at.

// @orc/core (new exports)
export const NAME_MAX = 80;
export function truncate(text: string, max?: number): string;
export function deriveName(i: { agentName: string | null; customTitle: string | null; aiTitle: string | null; summary: string | null; firstPrompt: string | null }): string | null;
export const DEFAULT_TICKET_REGEX: string;                     // '\\b(SAF|ALU|SUPRT|SAK|TAN)-\\d+\\b'
export function compileTicketRegex(source: string | null): RegExp | null;
export function extractTickets(text: string, re: RegExp | null): string[];
export function addUnique<T>(list: T[], values: Iterable<T>): void;
export function slashCommand(prompt: string): string | null;
export function mcpServerOf(tool: string): string | null;
export function mcpToolLabel(tool: string): string;            // 'mcp__claude_ai_Linear__save_issue' → 'Linear save_issue'
export const DEFAULT_PROD_PATTERNS: string[];
export function compileProdPatterns(patterns: string[]): RegExp[];
export function matchesProd(text: string, res: RegExp[]): boolean;
export function isTestCommand(command: string): boolean;
export function parseTestOutput(command: string, output: string, ts: string): TestResult | null;
export function deriveAvailability(i: { transcriptExists: boolean; archived: boolean }): Availability;
export interface ProjectSample { cwd: string; lastActivityAt: string }
export interface DetectedProject { id: string; name: string; pathPrefix: string; lastActivityAt: string; sessionCount: number }
export function projectRootFor(cwd: string, userHome: string): string;
export function slugify(name: string): string;
export function detectProjects(samples: ProjectSample[], userHome: string): DetectedProject[];
export interface DeriveConfig { ticketRegex: RegExp | null; prodPatterns: RegExp[] }
export type ResolveDeriveConfig = (startCwd: string | null) => DeriveConfig;
export interface ClaudeAggState { version: 1; sessionId: string | null; agentId: string | null; seq: number; turn: number; /* …plus the aggregate fields; full list in Task 2 → Interfaces */ }
export function createClaudeAggState(sessionId: string | null, agentId?: string | null): ClaudeAggState;
export function ingestClaudeRecord(state: ClaudeAggState, value: unknown, resolve: ResolveDeriveConfig): TimelineEvent[];
export function claudeStateToSession(state: ClaudeAggState, o: { projectId: string | null; transcriptPath: string | null; availability: Availability; hasSubagents: boolean }): Session | null;
export interface SubagentMeta { agentType: string; description: string; toolUseId: string | null; parentAgentId: string | null; spawnDepth: number; background: boolean }
export function parseSubagentMeta(value: unknown): SubagentMeta;
export function agentIdFromPath(path: string): string | null;
export function claudeStateToAgentNode(state: ClaudeAggState, meta: SubagentMeta, o: { sessionId: string; agentId: string; transcriptPath: string }): AgentNode;
export interface AgentTreeNode { node: AgentNode; children: AgentTreeNode[] }
export function buildAgentTree(nodes: AgentNode[]): AgentTreeNode[];
export interface HistoryPrompt { sessionId: string; ts: string; display: string; project: string }
export function parseHistoryLine(value: unknown): HistoryPrompt | null;
export function historyPromptsToSession(prompts: HistoryPrompt[], o: { projectId: string | null; ticketRegex: RegExp | null }): Session | null;
export interface RegistryEntry { pid: number; sessionId: string; cwd: string; startedAt: string | null; status: string; waitingFor: string | null; name: string | null; statusUpdatedAt: string | null; procStart: string | null; kind: string | null; version: string | null }
export function parseRegistryFile(value: unknown): RegistryEntry | null;
export function registryStatusToLive(status: string): LiveStatus;
export interface CodexAggState { version: 1; sessionId: string | null; seq: number; turn: number; originator: string | null; /* …full list in Task 4 → Interfaces */ }
export function createCodexAggState(): CodexAggState;
export function ingestCodexRecord(state: CodexAggState, value: unknown, resolve: ResolveDeriveConfig): TimelineEvent[];
export function codexStateToSession(state: CodexAggState, o: { projectId: string | null; transcriptPath: string | null; availability: Availability }): Session | null;
// package export "@orc/core/browser" → src/browser.ts (everything except src/io/*)

// @orc/api-contract (new exports)
export const SNIPPET_OPEN = '⟦'; export const SNIPPET_CLOSE = '⟧';     // FTS snippet highlight markers
export const HIDDEN_LABEL = 'hidden';                                   // reserved label = "hidden in the app"
export const ALL_PROJECTS = 'all';                                      // project selector value for "All projects"
// GET /api/sessions extra query params: label, pinned, includeHidden, includeAutomated
// POST /api/sessions/:source/:id/resume body adds popOut?: boolean, cols?: number, rows?: number
//   external response is { launched: 'external'; command: string }
// POST /api/sessions/:source/:id/pin   body { pinned: boolean }   → { pinned: boolean }
// POST /api/sessions/:source/:id/label body { labels: string[] }  → { labels: string[] }
// GET /api/labels → string[] ; GET /api/views → SavedView[] ; POST /api/views body { name, query } → SavedView ; DELETE /api/views/:id → { ok: true }
// GET /bootstrap.js — loopback + allowed Host + Sec-Fetch-Site same-origin|none
// WS /pty/:ptyId — server sends the scrollback as the first binary frame (possibly empty) and a text frame {"t":"exit","code":n|null} when the process ends
export type SavedView = { id: string; name: string; query: Record<string, string>; createdAt: string };
export class ApiRequestError extends Error { status: number; code: string; details: unknown }
// ApiClient methods: healthGet, projectsList, projectsGet, projectsUpdate, sessionsList, sessionsGet, sessionsEvents, sessionsAgents,
//   sessionsResume, sessionsPin, sessionsLabel, labelsList, viewsList, viewsSave, viewsDelete, ptyList, ptyKill (signatures in Task 5 / Task 15)
// GET /api/projects/:id → ProjectConfig (404 not_found)   (Task 15)
export function toQueryString(params: Record<string, string | number | boolean | null | undefined>): string;
// schemas: SourceSchema, AvailabilitySchema, UsageSchema, PrRefSchema, TestResultSchema, LiveStateSchema, SessionSchema,
// TimelineEventSchema, AgentNodeSchema, ProjectSchema, ProjectPatchSchema, HealthResponseSchema, SessionListQuerySchema,
// SessionListItemSchema, SessionListResponseSchema, SessionEventsQuerySchema, SessionEventsResponseSchema, ResumeRequestSchema,
// ResumeResponseSchema, PinRequestSchema, LabelRequestSchema, SavedViewSchema, SaveViewRequestSchema, PtyInfoSchema,
// PtyClientMessageSchema, PtyServerControlSchema ; types SessionListFilters, ResumeRequest, ResumeResponse, PtyClientMessage, LiveEvent (moved here from §6 text)

// daemon
// §6 event bus: BusEvent adds { type: 'session.indexed'; pk: string }; createEventBus(opts?: { onError?: (err: unknown, e: BusEvent) => void })
// §7 PtyManager adds remove(id: string): void and disposeAll(): void
export type ServiceErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500;
export class ServiceError extends Error { code: string; status: ServiceErrorStatus; details?: unknown }   // services/errors.ts
// error codes added: not_resumable (409), cwd_missing (422), unsupported (400), pty_exited (409), unauthorized (401), internal (500)
export function sessionPk(source: Source, id: string): string;          // db/keys.ts, re-exported from services/sessions.ts
export type ProjectUpdate = Omit<Partial<ProjectConfig>, 'features'> & { features?: Partial<ProjectConfig['features']> };   // ProjectService.update(id, patch: ProjectUpdate) widens Partial<ProjectConfig>
export interface ProjectServiceImpl extends ProjectService { ensureDefaults(): void; ensureDetected(): { added: string[] }; deriveConfigFor(cwd: string | null): DeriveConfig; syncTable(): void }
export function projectConfigFor(d: { id: string; name: string; pathPrefix: string }): ProjectConfig;
export interface UserMetaService { setPinned(pk: string, pinned: boolean): boolean; setLabels(pk: string, labels: string[]): string[]; labels(): string[]; views(): SavedView[]; saveView(i: { name: string; query: Record<string, string> }): SavedView; deleteView(id: string): boolean }
export type ExternalLauncher = (i: { cwd: string; command: string; args: string[]; openIn: 'vscode' | 'terminal' | 'finder' }) => Promise<void>;
export interface Indexer { scanAll(): Promise<{ files: number; sessions: number; ms: number }>; indexFile(path: string): Promise<void>; watch(): Promise<void>; close(): Promise<void>; unknownTypes(): Record<string, number> }
// DaemonContext (P1) = { paths, config, db, bus, log, pty, sessions, projects: ProjectServiceImpl, userMeta: UserMetaService }
export function buildContext(o: { paths: OrcPaths; log?: Logger; launchExternal?: ExternalLauncher; isPidAlive?: (pid: number) => boolean }): { ctx: DaemonContext; raw: Database.Database; saveConfig(cfg: OrcConfig): void; close(): void };
export function createDaemon(o: { paths?: OrcPaths; log?: Logger; launchExternal?: ExternalLauncher; webDist?: string | null }): Promise<Daemon>;
export interface Daemon { ctx: DaemonContext; indexer: Indexer; token: string; start(o: { port: number; watch?: boolean }): Promise<{ port: number; close(): Promise<void> }> }
export interface ResumeOptions { mode: 'embedded' | 'external'; fork?: boolean; popOut?: boolean; cols?: number; rows?: number }   // SessionService.resume opts
// SessionService.resume resolves to { ptyId } | { launched: 'external'; command: string }
// test helpers: apps/daemon/test/homes.ts → makeTempHomes(), writeClaudeSession(), FIXTURES_DIR, FAKE_CLAUDE
//               apps/daemon/test/helpers.ts → useTempHomes(), createTestContext(overrides?) returns DaemonContext & { homes; raw; dispose() }

// web
// stores/terminals.ts adds setActive(ptyId: string): void
// api/client.ts: getApiClient(), setApiClientForTests(c), getToken()
// api/pty-socket.ts: connectPty(ptyId, handlers, opts?) → { send(msg), close() }
// components/ui/*: button, badge, input, native-select, tabs, checkbox, card, skeleton, separator (+ cn.ts)
```

---

## File Structure (created or changed in this phase)
```
packages/core/src/derive/{name,tickets,util,skills,prod,tests,availability,projects,index}.ts  + tests
packages/core/src/claude/{session-aggregate,subagents,history,registry}.ts                    + tests
packages/core/src/codex/{rollout,codex-aggregate}.ts                                          + test
packages/core/src/browser.ts ; packages/core/src/index.ts ; packages/core/package.json (exports)
packages/api-contract/src/{domain,live,client}.ts ; src/routes/{health,projects,sessions,views,pty}.ts + tests
apps/daemon/drizzle.config.ts ; apps/daemon/vitest.config.ts ; apps/daemon/vitest.perf.config.ts
apps/daemon/src/config.ts ; src/context.ts ; src/main.ts
apps/daemon/src/db/{schema,client,keys,fts}.ts ; src/db/migrations/** ; src/db/repos/{sessions,events,agents,file-offsets,history,projects,user-meta,pty-sessions}.ts
apps/daemon/src/live/{event-bus,liveness}.ts
apps/daemon/src/pty/{pty-manager,input}.ts
apps/daemon/src/indexer/{file-kinds,indexer}.ts
apps/daemon/src/services/{errors,projects,sessions,user-meta,external,snippet}.ts
apps/daemon/src/http/{types,app,auth,json,static,redact-out,ws}.ts ; src/http/routes/{health,projects,sessions,views,pty}.ts
apps/daemon/test/{homes,helpers,factories,e2e-server}.ts ; test/bin/claude ; test/perf/{seed,search.perf}.ts ; test/*.test.ts
apps/web/{package.json,vite.config.ts,vitest.config.ts,index.html,tsr.config.json,playwright.config.ts}
apps/web/src/{main.tsx,router.tsx,index.css} ; src/routes/{__root,index,history,settings}.tsx ; src/routes/sessions/$source/$id.tsx
apps/web/src/api/{client,pty-socket}.ts ; src/api/queries/{projects,sessions,views,pty}.ts
apps/web/src/stores/{project,terminals}.ts
apps/web/src/components/ui/{cn.ts,button,badge,input,native-select,tabs,checkbox,card,skeleton,separator}.tsx
apps/web/src/lib/format.ts
plan/reviews/phase-1-exit.md
apps/web/src/features/shell/{AppShell,ProjectSelector}.tsx
apps/web/src/features/settings/{project-patch.ts,ProjectSettings.tsx}
apps/web/src/features/history/{filters.ts,HistoryPage,HistoryFilters,DebouncedInput,SessionTable,SavedViews,LabelEditor,Snippet}.tsx
apps/web/src/features/session-detail/{timeline-model.ts,SessionDetailPage,SessionHeader,Timeline}.tsx
apps/web/src/features/terminal/{TerminalDock,TerminalView,ResumeActions}.tsx
apps/web/src/test/{setup.ts,render.tsx,fake-api.ts,factories.ts} ; apps/web/src/lib/source.ts
apps/web/e2e/history.spec.ts
Removed: apps/web/src/App.tsx, apps/web/src/App.test.tsx, apps/daemon/src/main.test.ts (replaced)
```

---

### Task 1: Core derivation helpers

**Files:**
- Create: `packages/core/src/derive/name.ts`, `tickets.ts`, `util.ts`, `skills.ts`, `prod.ts`, `tests.ts`, `availability.ts`, `projects.ts`, `index.ts`
- Create: `packages/core/src/derive/derive.test.ts`, `packages/core/src/derive/tests.test.ts`
- Create: `packages/core/src/browser.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/package.json`

**Interfaces:**
- Consumes: `TestResult`, `Availability` from `packages/core/src/types/session.ts` (Phase 0)
- Produces: `NAME_MAX`, `truncate`, `deriveName`, `DEFAULT_TICKET_REGEX`, `compileTicketRegex`, `extractTickets`, `addUnique`, `slashCommand`, `mcpServerOf`, `mcpToolLabel`, `DEFAULT_PROD_PATTERNS`, `compileProdPatterns`, `matchesProd`, `isTestCommand`, `parseTestOutput`, `deriveAvailability`, `ProjectSample`, `DetectedProject`, `projectRootFor`, `slugify`, `detectProjects` (signatures in "Contract additions"); package export `@orc/core/browser`.

- [ ] **Step 1: Write the failing derivation tests**

`packages/core/src/derive/derive.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { deriveAvailability } from './availability.ts';
import { deriveName, NAME_MAX, truncate } from './name.ts';
import { compileProdPatterns, DEFAULT_PROD_PATTERNS, matchesProd } from './prod.ts';
import { detectProjects, projectRootFor, slugify } from './projects.ts';
import { mcpServerOf, mcpToolLabel, slashCommand } from './skills.ts';
import { compileTicketRegex, DEFAULT_TICKET_REGEX, extractTickets } from './tickets.ts';
import { addUnique } from './util.ts';

describe('name', () => {
  it('truncates and collapses whitespace', () => {
    expect(truncate('  a \n b  ')).toBe('a b');
    const long = truncate('x'.repeat(200));
    expect(long).toHaveLength(NAME_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('prefers agent-name, then custom title, ai-title, summary, first prompt', () => {
    const base = { agentName: null, customTitle: null, aiTitle: null, summary: null, firstPrompt: null };
    expect(deriveName(base)).toBeNull();
    expect(deriveName({ ...base, firstPrompt: 'fix it' })).toBe('fix it');
    expect(deriveName({ ...base, summary: 'S', firstPrompt: 'fix it' })).toBe('S');
    expect(deriveName({ ...base, aiTitle: 'AI', summary: 'S' })).toBe('AI');
    expect(deriveName({ ...base, customTitle: 'C', aiTitle: 'AI' })).toBe('C');
    expect(deriveName({ ...base, agentName: 'A', customTitle: 'C', aiTitle: 'AI' })).toBe('A');
    expect(deriveName({ ...base, agentName: '   ', aiTitle: 'AI' })).toBe('AI');
  });
});

describe('tickets', () => {
  const re = compileTicketRegex(DEFAULT_TICKET_REGEX);
  it('extracts unique tickets in order, including from branch names', () => {
    expect(extractTickets('git checkout -b feat/SAF-1787-exclude; see SUPRT-12 and SAF-1787', re)).toEqual([
      'SAF-1787',
      'SUPRT-12',
    ]);
  });
  it('returns nothing without a regex or for invalid regex source', () => {
    expect(extractTickets('SAF-1', null)).toEqual([]);
    expect(compileTicketRegex('(')).toBeNull();
    expect(compileTicketRegex(null)).toBeNull();
  });
  it('addUnique keeps order and skips duplicates', () => {
    const list = ['a'];
    addUnique(list, ['b', 'a', 'c', 'b']);
    expect(list).toEqual(['a', 'b', 'c']);
  });
});

describe('skills and mcp', () => {
  it('reads slash commands only at the start and skips built-ins and paths', () => {
    expect(slashCommand('/review the change')).toBe('review');
    expect(slashCommand('/conductor SAF-1')).toBe('conductor');
    expect(slashCommand('  /long-scan')).toBe('long-scan');
    expect(slashCommand('/clear')).toBeNull();
    expect(slashCommand('/Users/test/Wakecap is slow')).toBeNull();
    expect(slashCommand('use /conductor')).toBeNull();
  });
  it('parses mcp tool names', () => {
    expect(mcpServerOf('mcp__claude_ai_Linear__save_issue')).toBe('claude_ai_Linear');
    expect(mcpServerOf('Bash')).toBeNull();
    expect(mcpToolLabel('mcp__claude_ai_Linear__save_issue')).toBe('Linear save_issue');
    expect(mcpToolLabel('mcp__plugin_context7_context7__query-docs')).toBe('context7 query-docs');
    expect(mcpToolLabel('Bash')).toBe('Bash');
  });
});

describe('prod patterns', () => {
  const res = compileProdPatterns([...DEFAULT_PROD_PATTERNS, '(']);
  it('matches prod skills and commands, ignores normal commands', () => {
    expect(matchesProd('production_server_db', res)).toBe(true);
    expect(matchesProd("PGPASSWORD=x psql -h prod-db.internal -c 'select 1'", res)).toBe(true);
    expect(matchesProd('kubectl --context eks-production get pods', res)).toBe(true);
    expect(matchesProd('terraform apply -auto-approve', res)).toBe(true);
    expect(matchesProd('pnpm vitest run', res)).toBe(false);
    expect(res).toHaveLength(DEFAULT_PROD_PATTERNS.length);
  });
});

describe('availability', () => {
  it('orders resumable > archived > prompts-only', () => {
    expect(deriveAvailability({ transcriptExists: true, archived: true })).toBe('resumable');
    expect(deriveAvailability({ transcriptExists: false, archived: true })).toBe('archived');
    expect(deriveAvailability({ transcriptExists: false, archived: false })).toBe('prompts-only');
  });
});

describe('projects', () => {
  it('finds the top-level folder under the user home', () => {
    expect(projectRootFor('/Users/test/Wakecap/Backend/svc', '/Users/test')).toBe('/Users/test/Wakecap');
    expect(projectRootFor('/Users/test', '/Users/test/')).toBe('/Users/test');
    expect(projectRootFor('/tmp/x/y', '/Users/test')).toBe('/tmp');
    expect(slugify('EGX Investment!')).toBe('egx-investment');
    expect(slugify('***')).toBe('project');
  });

  it('groups sessions by root and orders by recent activity', () => {
    const out = detectProjects(
      [
        { cwd: '/Users/test/Wakecap', lastActivityAt: '2026-09-01T09:07:00.000Z' },
        { cwd: '/Users/test/Forza', lastActivityAt: '2026-09-04T08:00:01.000Z' },
        { cwd: '/Users/test/Stocks/EGX Investment Research', lastActivityAt: '2026-09-01T09:06:40.000Z' },
        { cwd: '/Users/test/Wakecap/Backend/svc', lastActivityAt: '2026-09-06T08:00:02.000Z' },
        { cwd: '/Users/test', lastActivityAt: '2026-08-01T00:00:00.000Z' },
      ],
      '/Users/test',
    );
    expect(out.map((p) => [p.id, p.name, p.pathPrefix, p.sessionCount])).toEqual([
      ['wakecap', 'Wakecap', '/Users/test/Wakecap', 2],
      ['forza', 'Forza', '/Users/test/Forza', 1],
      ['stocks', 'Stocks', '/Users/test/Stocks', 1],
      ['home', 'Home', '/Users/test', 1],
    ]);
    expect(out[0]?.lastActivityAt).toBe('2026-09-06T08:00:02.000Z');
  });

  it('de-duplicates ids', () => {
    const out = detectProjects(
      [
        { cwd: '/Users/test/a b', lastActivityAt: '2026-01-02' },
        { cwd: '/Users/test/a-b', lastActivityAt: '2026-01-01' },
      ],
      '/Users/test',
    );
    expect(out.map((p) => p.id)).toEqual(['a-b', 'a-b-2']);
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
    ['pnpm --filter api test', true],
    ['dotnet test Wakecap.sln', true],
    ['flutter test', true],
    ['python -m pytest -q', true],
    ['git status', false],
    ['ls tests', false],
  ])('%s → %s', (cmd, expected) => {
    expect(isTestCommand(cmd)).toBe(expected);
  });
});

describe('parseTestOutput', () => {
  it('parses vitest summaries (with ANSI colours)', () => {
    const out = ' Test Files  3 passed (3)\n      Tests  [32m18 passed[39m (18)\n   Duration  1.40s';
    expect(parseTestOutput('pnpm vitest run', out, TS)).toEqual({
      ts: TS,
      command: 'pnpm vitest run',
      passed: 18,
      failed: 0,
      skipped: 0,
      durationMs: 1400,
    });
    const red = '      Tests  2 failed | 15 passed | 1 skipped (18)\n   Duration  900ms';
    expect(parseTestOutput('vitest', red, TS)).toMatchObject({ passed: 15, failed: 2, skipped: 1, durationMs: 900 });
  });

  it('parses jest summaries', () => {
    const out = 'Tests:       1 failed, 2 skipped, 17 passed, 20 total\nTime:        1.234 s';
    expect(parseTestOutput('npx jest', out, TS)).toMatchObject({ passed: 17, failed: 1, skipped: 2, durationMs: 1234 });
  });

  it('sums dotnet test project lines', () => {
    const out = [
      'Passed!  - Failed:     0, Passed:    42, Skipped:     1, Total:    43, Duration: 2 s - A.Tests.dll (net8.0)',
      'Failed!  - Failed:     1, Passed:     5, Skipped:     0, Total:     6, Duration: 450 ms - B.Tests.dll (net8.0)',
    ].join('\n');
    expect(parseTestOutput('dotnet test', out, TS)).toMatchObject({ passed: 47, failed: 1, skipped: 1, durationMs: 2450 });
  });

  it('parses the last flutter progress line', () => {
    const out = '00:02 +10: loading\n00:05 +42 ~1 -2: Some tests failed.';
    expect(parseTestOutput('flutter test', out, TS)).toMatchObject({ passed: 42, skipped: 1, failed: 2, durationMs: 5000 });
  });

  it('parses pytest summaries', () => {
    const out = '....\n===== 3 failed, 40 passed, 2 skipped, 1 error in 1.23s =====';
    expect(parseTestOutput('pytest -q', out, TS)).toMatchObject({ passed: 40, failed: 4, skipped: 2, durationMs: 1230 });
  });

  it('returns null when nothing looks like a summary', () => {
    expect(parseTestOutput('pnpm test', 'command not found', TS)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run packages/core/src/derive`
Expected: FAIL, `Cannot find module './availability.ts'` (and the other derive modules).

- [ ] **Step 3: Implement the helpers**

`packages/core/src/derive/util.ts`
```ts
export function addUnique<T>(list: T[], values: Iterable<T>): void {
  for (const v of values) {
    if (!list.includes(v)) list.push(v);
  }
}
```

`packages/core/src/derive/name.ts`
```ts
export const NAME_MAX = 80;

export function truncate(text: string, max: number = NAME_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

export interface NameInputs {
  agentName: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  summary: string | null;
  firstPrompt: string | null;
}

/** agent-name → custom-title → ai-title → summary → first prompt (docs/04 A2 "Derivations"). */
export function deriveName(i: NameInputs): string | null {
  for (const v of [i.agentName, i.customTitle, i.aiTitle, i.summary, i.firstPrompt]) {
    if (v !== null && v.trim().length > 0) return truncate(v);
  }
  return null;
}
```

`packages/core/src/derive/tickets.ts`
```ts
export const DEFAULT_TICKET_REGEX = '\\b(SAF|ALU|SUPRT|SAK|TAN)-\\d+\\b';

export function compileTicketRegex(source: string | null): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, 'g');
  } catch {
    return null;
  }
}

export function extractTickets(text: string, re: RegExp | null): string[] {
  if (!re || !text) return [];
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(re.source, flags))) {
    const t = String(m[0]).toUpperCase();
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
```

`packages/core/src/derive/skills.ts`
```ts
/** Claude Code built-in commands that are UI actions, not skills. */
const BUILTIN_COMMANDS = new Set([
  'add-dir', 'agents', 'bug', 'clear', 'compact', 'config', 'context', 'cost', 'doctor', 'effort', 'exit', 'fast',
  'help', 'hooks', 'ide', 'login', 'logout', 'mcp', 'memory', 'model', 'permissions', 'resume', 'rewind', 'status',
  'statusline', 'terminal-setup', 'theme', 'usage', 'vim',
]);

const MCP_NAME = /^mcp__(.+?)__(.+)$/;

export function slashCommand(prompt: string): string | null {
  const m = /^\/([A-Za-z][\w:.-]*)(?=\s|$)/.exec(prompt.trimStart());
  const name = m?.[1];
  if (!name) return null;
  const lower = name.toLowerCase();
  return BUILTIN_COMMANDS.has(lower) ? null : lower;
}

export function mcpServerOf(tool: string): string | null {
  return MCP_NAME.exec(tool)?.[1] ?? null;
}

export function mcpToolLabel(tool: string): string {
  const m = MCP_NAME.exec(tool);
  if (!m) return tool;
  const server = (m[1] ?? '').replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '');
  return `${server} ${m[2] ?? ''}`.trim();
}
```

`packages/core/src/derive/prod.ts`
```ts
/** F9 defaults. Matched case-insensitively against Skill names, MCP tool names and Bash commands. */
export const DEFAULT_PROD_PATTERNS: string[] = [
  'production_server_db',
  'production_server_logs',
  'wecare_production_db',
  '\\bkubectl\\b[^\\n]*\\b(?:prod|production)\\b',
  '\\bterraform\\s+apply\\b',
  '\\bprod(?:uction)?-db\\b',
];

export function compileProdPatterns(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, 'i'));
    } catch {
      // invalid user pattern: skipped (Settings validates on save)
    }
  }
  return out;
}

export function matchesProd(text: string, res: RegExp[]): boolean {
  return res.some((r) => r.test(text));
}
```

`packages/core/src/derive/tests.ts`
```ts
import type { TestResult } from '../types/session.ts';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const TEST_COMMAND =
  /\b(?:vitest|jest|pytest|dotnet\s+test|flutter\s+test)\b|\b(?:pnpm|npm|yarn|bun)\b[^\n|;&]*\btest\b/;

interface Counts {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number | null;
}
type Parser = (out: string) => Counts | null;

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command);
}

function toMs(value: string | undefined, unit: string | undefined): number {
  const n = Number(value ?? 0);
  if (unit === 'ms') return Math.round(n);
  if (unit === 'm') return Math.round(n * 60_000);
  return Math.round(n * 1000);
}

function countWords(s: string): Omit<Counts, 'durationMs'> {
  const c = { passed: 0, failed: 0, skipped: 0 };
  for (const m of s.matchAll(/(\d+)\s+(passed|failed|skipped|todo|errors?)\b/g)) {
    const n = Number(m[1]);
    const word = m[2];
    if (word === 'passed') c.passed += n;
    else if (word === 'failed' || word === 'error' || word === 'errors') c.failed += n;
    else c.skipped += n;
  }
  return c;
}

const parseVitest: Parser = (out) => {
  const line = /^\s*Tests\s+(\d+\s+(?:passed|failed|skipped|todo)\b.*)$/m.exec(out);
  if (!line?.[1]) return null;
  const d = /^\s*Duration\s+([\d.]+)\s*(ms|s)\b/m.exec(out);
  return { ...countWords(line[1]), durationMs: d ? toMs(d[1], d[2]) : null };
};

const parseJest: Parser = (out) => {
  const line = /^Tests:\s+(.+)$/m.exec(out);
  if (!line?.[1]) return null;
  const t = /^Time:\s+([\d.]+)\s*(ms|s)\b/m.exec(out);
  return { ...countWords(line[1]), durationMs: t ? toMs(t[1], t[2]) : null };
};

const parseDotnet: Parser = (out) => {
  const re =
    /(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+),\s+Total:\s+\d+(?:,\s+Duration:\s+([\d.]+)\s*(ms|s|m)\b)?/g;
  let found = false;
  let durationMs = 0;
  const c = { passed: 0, failed: 0, skipped: 0 };
  for (const m of out.matchAll(re)) {
    found = true;
    c.failed += Number(m[1]);
    c.passed += Number(m[2]);
    c.skipped += Number(m[3]);
    if (m[4]) durationMs += toMs(m[4], m[5]);
  }
  return found ? { ...c, durationMs: durationMs || null } : null;
};

const parseFlutter: Parser = (out) => {
  const last = [...out.matchAll(/(\d+):(\d+)\s+\+(\d+)(?:\s+~(\d+))?(?:\s+-(\d+))?:/g)].at(-1);
  if (!last) return null;
  return {
    passed: Number(last[3]),
    skipped: Number(last[4] ?? 0),
    failed: Number(last[5] ?? 0),
    durationMs: (Number(last[1]) * 60 + Number(last[2])) * 1000,
  };
};

const parsePytest: Parser = (out) => {
  const m = /^=+\s+(.*?\b(?:passed|failed|errors?|skipped)\b.*?)\s+in\s+([\d.]+)s\b.*=+\s*$/m.exec(out);
  if (!m?.[1]) return null;
  return { ...countWords(m[1]), durationMs: toMs(m[2], 's') };
};

function parsersFor(command: string): Parser[] {
  if (/\bflutter\b/.test(command)) return [parseFlutter];
  if (/\bdotnet\b/.test(command)) return [parseDotnet];
  if (/\bpytest\b/.test(command)) return [parsePytest];
  if (/\bjest\b/.test(command)) return [parseJest];
  return [parseVitest, parseJest, parsePytest, parseDotnet, parseFlutter];
}

export function parseTestOutput(command: string, output: string, ts: string): TestResult | null {
  const clean = output.replace(ANSI, '');
  for (const parse of parsersFor(command)) {
    const c = parse(clean);
    if (c && c.passed + c.failed + c.skipped > 0) {
      return { ts, command, passed: c.passed, failed: c.failed, skipped: c.skipped, durationMs: c.durationMs };
    }
  }
  return null;
}
```

`packages/core/src/derive/availability.ts`
```ts
import type { Availability } from '../types/session.ts';

export function deriveAvailability(i: { transcriptExists: boolean; archived: boolean }): Availability {
  if (i.transcriptExists) return 'resumable';
  if (i.archived) return 'archived';
  return 'prompts-only';
}
```

`packages/core/src/derive/projects.ts`
```ts
export interface ProjectSample {
  cwd: string;
  lastActivityAt: string;
}

export interface DetectedProject {
  id: string;
  name: string;
  pathPrefix: string;
  lastActivityAt: string;
  sessionCount: number;
}

export function projectRootFor(cwd: string, userHome: string): string {
  const home = userHome.replace(/\/+$/, '');
  if (cwd === home) return home;
  if (cwd.startsWith(`${home}/`)) {
    const first = cwd.slice(home.length + 1).split('/')[0] ?? '';
    return `${home}/${first}`;
  }
  const first = cwd.split('/').filter(Boolean)[0];
  return first ? `/${first}` : '/';
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'project';
}

/** F13: one project per top-level folder under the user's home, most recently active first. */
export function detectProjects(samples: ProjectSample[], userHome: string): DetectedProject[] {
  const home = userHome.replace(/\/+$/, '');
  const byRoot = new Map<string, DetectedProject>();
  for (const s of samples) {
    if (!s.cwd) continue;
    const root = projectRootFor(s.cwd, home);
    const cur = byRoot.get(root);
    if (cur) {
      cur.sessionCount += 1;
      if (s.lastActivityAt > cur.lastActivityAt) cur.lastActivityAt = s.lastActivityAt;
      continue;
    }
    const name = root === home ? 'Home' : (root.split('/').filter(Boolean).at(-1) ?? 'root');
    byRoot.set(root, { id: '', name, pathPrefix: root, lastActivityAt: s.lastActivityAt, sessionCount: 1 });
  }
  const list = [...byRoot.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const used = new Set<string>();
  for (const p of list) {
    const base = slugify(p.name);
    let id = base;
    let n = 2;
    while (used.has(id)) {
      id = `${base}-${n}`;
      n += 1;
    }
    used.add(id);
    p.id = id;
  }
  return list;
}
```

`packages/core/src/derive/index.ts`
```ts
export * from './availability.ts';
export * from './name.ts';
export * from './prod.ts';
export * from './projects.ts';
export * from './skills.ts';
export * from './tests.ts';
export * from './tickets.ts';
export * from './util.ts';
```

`packages/core/src/browser.ts` (browser-safe entry: no `src/io/*`)
```ts
export const CORE_VERSION = '0.0.0';
export * from './types/index.ts';
export * from './redact/redact.ts';
export * from './derive/index.ts';
export * from './claude/records.ts';
```

`packages/core/src/index.ts`
```ts
export const CORE_VERSION = '0.0.0';
export * from './types/index.ts';
export * from './redact/redact.ts';
export * from './io/jsonl-tail.ts';
export * from './claude/records.ts';
export * from './derive/index.ts';
```

`packages/core/package.json` — change `exports` to:
```json
"exports": { ".": "./src/index.ts", "./browser": "./src/browser.ts" }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run packages/core`
Expected: PASS (all core tests, including the new `derive` suites).

- [ ] **Step 5: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add packages/core
git commit -m "feat(core): add name, ticket, skill, prod, test-result and project derivations"
```

---
### Task 2: Claude session aggregate and timeline events

**Files:**
- Create: `packages/core/src/claude/session-aggregate.ts`, `packages/core/src/claude/session-aggregate.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/browser.ts`

**Interfaces:**
- Consumes: `classifyClaudeRecord`, `contentText`, `ClaudeMessageRecord` (Phase 0); `readJsonlFrom`, `parseJsonLine` (Phase 0, tests only); Task 1 derivations.
- Produces:
  ```ts
  export interface DeriveConfig { ticketRegex: RegExp | null; prodPatterns: RegExp[] }
  export type ResolveDeriveConfig = (startCwd: string | null) => DeriveConfig;
  export interface CostStateSnapshot { totalCostUSD: number; linesAdded: number | null; linesRemoved: number | null; usage: Usage }
  export interface ClaudeAggState { version: 1; sessionId: string | null; agentId: string | null; seq: number; turn: number; startCwd: string | null; cwds: string[]; firstPrompt: string | null; lastHumanPrompt: string | null; lastPromptMeta: string | null; agentName: string | null; customTitle: string | null; aiTitle: string | null; summary: string | null; awaySummary: string | null; startedAt: string | null; lastActivityAt: string | null; models: string[]; permissionMode: string | null; usage: Usage; seenMessageIds: string[]; costState: CostStateSnapshot | null; prs: PrRef[]; tickets: string[]; skills: string[]; mcpServers: string[]; filesTouched: string[]; promptCount: number; toolCallCount: number; apiErrorCount: number; pendingTests: Record<string, string>; lastTest: TestResult | null; touchedProd: boolean; lastEventKind: EventKind | null; unknownTypes: Record<string, number> }
  export function usageFromClaude(u: Record<string, unknown> | undefined): Usage | null
  export function createClaudeAggState(sessionId: string | null, agentId?: string | null): ClaudeAggState
  export function ingestClaudeRecord(state: ClaudeAggState, value: unknown, resolve: ResolveDeriveConfig): TimelineEvent[]   // mutates state
  export function claudeStateToSession(state: ClaudeAggState, o: { projectId: string | null; transcriptPath: string | null; availability: Availability; hasSubagents: boolean }): Session | null
  ```
  Rules: `seq` increments per emitted event (first event = 1); `turn` increments at each human prompt (events before the first prompt have turn 0); usage is counted once per `message.id` and attached to the first event of that message; the latest `cost-state` wins and replaces token totals and cost; `<synthetic>` is not a model; the state is plain JSON (safe to `JSON.stringify` and resume).

- [ ] **Step 1: Write the failing test**

`packages/core/src/claude/session-aggregate.test.ts`
```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileProdPatterns, DEFAULT_PROD_PATTERNS } from '../derive/prod.ts';
import { compileTicketRegex, DEFAULT_TICKET_REGEX } from '../derive/tickets.ts';
import { parseJsonLine, readJsonlFrom } from '../io/jsonl-tail.ts';
import { FIXTURES_DIR } from '../test-utils/fixtures.ts';
import type { TimelineEvent } from '../types/events.ts';
import {
  type ClaudeAggState,
  claudeStateToSession,
  createClaudeAggState,
  ingestClaudeRecord,
  type ResolveDeriveConfig,
} from './session-aggregate.ts';

const resolve: ResolveDeriveConfig = () => ({
  ticketRegex: compileTicketRegex(DEFAULT_TICKET_REGEX),
  prodPatterns: compileProdPatterns(DEFAULT_PROD_PATTERNS),
});
const dir = join(FIXTURES_DIR, 'claude-home/projects/-Users-test-Wakecap');

async function values(file: string): Promise<unknown[]> {
  const r = await readJsonlFrom(join(dir, file), 0);
  return r.lines.map((l) => parseJsonLine(l.text));
}

async function ingest(file: string, sessionId: string): Promise<{ state: ClaudeAggState; events: TimelineEvent[] }> {
  const state = createClaudeAggState(sessionId);
  const events: TimelineEvent[] = [];
  for (const v of await values(file)) events.push(...ingestClaudeRecord(state, v, resolve));
  return { state, events };
}

const opts = { projectId: 'wakecap', transcriptPath: '/t.jsonl', availability: 'resumable' as const, hasSubagents: false };

describe('Claude aggregate: s-basic', () => {
  it('maps records to timeline events with seq and turn', async () => {
    const { events } = await ingest('s-basic.jsonl', 's-basic');
    expect(events.map((e) => e.kind)).toEqual([
      'prompt', 'assistant_text', 'tool_call', 'tool_result', 'tool_call', 'assistant_text', 'system', 'prompt', 'prompt', 'system',
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(events.map((e) => e.turn)).toEqual([1, 1, 1, 1, 1, 1, 1, 2, 3, 3]);
    const [prompt, text, bash, result, edit, edited, duration] = events;
    expect(prompt).toMatchObject({ uuid: 'u1', parentUuid: null, text: 'check the notification service tests', agentId: null });
    expect(text).toMatchObject({ uuid: 'a1', messageId: 'msg_1', model: 'claude-opus-5', text: 'Running the tests.' });
    expect(text?.usage).toEqual({ input: 10, output: 20, cacheRead: 1000, cacheWrite: 100, costUsd: null });
    expect(bash).toMatchObject({ uuid: 'a1#1', tool: 'Bash', toolUseId: 'tu1', usage: null, mcpServer: null });
    expect(bash?.input).toEqual({ command: 'pnpm vitest run', description: 'Run tests' });
    expect(result).toMatchObject({ kind: 'tool_result', toolUseId: 'tu1' });
    expect(result?.text).toContain('18 passed');
    expect(edit?.usage).toEqual({ input: 5, output: 7, cacheRead: 1100, cacheWrite: 0, costUsd: null });
    expect(edited?.usage).toBeNull();
    expect(duration).toMatchObject({ kind: 'system', tool: 'turn_duration', durationMs: 36000, text: null });
    expect(events[9]).toMatchObject({ kind: 'system', tool: 'away_summary', text: 'Ran tests (18 passed) and edited a.ts.' });
  });

  it('builds the session', async () => {
    const { state } = await ingest('s-basic.jsonl', 's-basic');
    const s = claudeStateToSession(state, opts);
    expect(s).toMatchObject({
      id: 's-basic',
      source: 'claude',
      projectId: 'wakecap',
      startCwd: '/Users/test/Wakecap',
      cwds: ['/Users/test/Wakecap'],
      name: 'Notification service test check',
      firstPrompt: 'check the notification service tests',
      lastPrompt: '/review the change',
      awaySummary: 'Ran tests (18 passed) and edited a.ts.',
      startedAt: '2026-09-01T09:00:00.000Z',
      lastActivityAt: '2026-09-01T09:07:00.000Z',
      models: ['claude-opus-5'],
      permissionMode: 'bypassPermissions',
      usage: { input: 15, output: 27, cacheRead: 2100, cacheWrite: 100, costUsd: 0.42 },
      linesAdded: 1,
      linesRemoved: 1,
      skills: ['review'],
      filesTouched: ['/Users/test/Wakecap/Backend/svc/a.ts'],
      promptCount: 3,
      toolCallCount: 2,
      apiErrorCount: 0,
      flags: { touchedProd: false, hasSubagents: false, automated: false },
      availability: 'resumable',
      transcriptPath: '/t.jsonl',
      recap: null,
      live: null,
    });
    expect(s?.lastTest).toEqual({
      ts: '2026-09-01T09:00:30.000Z',
      command: 'pnpm vitest run',
      passed: 18,
      failed: 0,
      skipped: 0,
      durationMs: 1400,
    });
  });

  it('dedupes usage without cost-state and survives a JSON round trip mid-file', async () => {
    const all = (await values('s-basic.jsonl')).filter(
      (v) => !(typeof v === 'object' && v !== null && (v as { type?: string }).type === 'cost-state'),
    );
    const oneShot = createClaudeAggState('s-basic');
    for (const v of all) ingestClaudeRecord(oneShot, v, resolve);

    let split = createClaudeAggState('s-basic');
    for (const v of all.slice(0, 5)) ingestClaudeRecord(split, v, resolve);
    split = JSON.parse(JSON.stringify(split)) as ClaudeAggState;
    for (const v of all.slice(5)) ingestClaudeRecord(split, v, resolve);

    expect(split).toEqual(oneShot);
    expect(claudeStateToSession(split, opts)?.usage).toEqual({
      input: 15,
      output: 27,
      cacheRead: 2100,
      cacheWrite: 100,
      costUsd: null,
    });
  });
});

describe('Claude aggregate: other fixtures', () => {
  it('s-prlink: agent-name, PR, tickets, skills and MCP', async () => {
    const { state } = await ingest('s-prlink.jsonl', 's-prlink');
    const s = claudeStateToSession(state, opts);
    expect(s).toMatchObject({
      name: 'SAF-1787 SLA weekends',
      tickets: ['SAF-1787'],
      skills: ['conductor'],
      mcpServers: ['claude_ai_Linear'],
      toolCallCount: 3,
      prs: [{ repo: 'example-org/wakecap-wecare-service', number: 231, url: 'https://github.com/example-org/wakecap-wecare-service/pull/231' }],
      cwds: ['/Users/test/Wakecap', '/Users/test/Wakecap/Backend/wakecap-wecare-service'],
    });
  });

  it('s-drift: keeps the first cwd, records drift, flags prod', async () => {
    const { state } = await ingest('s-drift.jsonl', 's-drift');
    const s = claudeStateToSession(state, opts);
    expect(s?.startCwd).toBe('/Users/test/Wakecap');
    expect(s?.cwds).toEqual(['/Users/test/Wakecap', '/Users/test/Wakecap/Backend/svc', '/Users/test/Wakecap/Frontend/app']);
    expect(s?.models).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(s?.skills).toEqual(['production_server_db']);
    expect(s?.flags.touchedProd).toBe(true);
    expect(s?.name).toBe('look at the svc repo');
  });

  it('s-errors: synthetic model excluded, API error counted, truncated line ignored', async () => {
    const { state, events } = await ingest('s-errors.jsonl', 's-errors');
    expect(events.map((e) => e.kind)).toEqual(['prompt', 'error']);
    expect(events[1]?.text).toBe('API Error: 529 overloaded');
    const s = claudeStateToSession(state, opts);
    expect(s?.models).toEqual([]);
    expect(s?.apiErrorCount).toBe(1);
    expect(s?.usage.costUsd).toBeNull();
  });

  it('s-unknown: counts unknown and invalid records without events', async () => {
    const { state, events } = await ingest('s-unknown.jsonl', 's-unknown');
    expect(events.map((e) => e.kind)).toEqual(['prompt']);
    expect(state.unknownTypes).toEqual({ 'future-record-kind': 1, '(invalid)': 1 });
  });

  it('returns null until a timestamped record is seen', () => {
    const state = createClaudeAggState('x');
    ingestClaudeRecord(state, { type: 'ai-title', aiTitle: 'T', sessionId: 'x' }, resolve);
    expect(claudeStateToSession(state, opts)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/core/src/claude/session-aggregate`
Expected: FAIL, `Cannot find module './session-aggregate.ts'`

- [ ] **Step 3: Implement the aggregate**

`packages/core/src/claude/session-aggregate.ts`
```ts
import { deriveName } from '../derive/name.ts';
import { matchesProd } from '../derive/prod.ts';
import { mcpServerOf, slashCommand } from '../derive/skills.ts';
import { isTestCommand, parseTestOutput } from '../derive/tests.ts';
import { extractTickets } from '../derive/tickets.ts';
import { addUnique } from '../derive/util.ts';
import type { EventKind, TimelineEvent } from '../types/events.ts';
import type { Availability, PrRef, Session, TestResult, Usage } from '../types/session.ts';
import { emptyUsage } from '../types/session.ts';
import { type ClaudeMessageRecord, classifyClaudeRecord, contentText, type SessionMetaType } from './records.ts';

export interface DeriveConfig {
  ticketRegex: RegExp | null;
  prodPatterns: RegExp[];
}
export type ResolveDeriveConfig = (startCwd: string | null) => DeriveConfig;

export interface CostStateSnapshot {
  totalCostUSD: number;
  linesAdded: number | null;
  linesRemoved: number | null;
  usage: Usage;
}

export interface ClaudeAggState {
  version: 1;
  sessionId: string | null;
  agentId: string | null;
  seq: number;
  turn: number;
  startCwd: string | null;
  cwds: string[];
  firstPrompt: string | null;
  lastHumanPrompt: string | null;
  lastPromptMeta: string | null;
  agentName: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  summary: string | null;
  awaySummary: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  models: string[];
  permissionMode: string | null;
  usage: Usage;
  seenMessageIds: string[];
  costState: CostStateSnapshot | null;
  prs: PrRef[];
  tickets: string[];
  skills: string[];
  mcpServers: string[];
  filesTouched: string[];
  promptCount: number;
  toolCallCount: number;
  apiErrorCount: number;
  pendingTests: Record<string, string>;
  lastTest: TestResult | null;
  touchedProd: boolean;
  lastEventKind: EventKind | null;
  unknownTypes: Record<string, number>;
}

type Obj = Record<string, unknown>;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TOOL_RESULT_MAX = 4000;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function usageFromClaude(u: Obj | undefined): Usage | null {
  if (!u) return null;
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    costUsd: null,
  };
}

function addUsage(into: Usage, u: Usage): void {
  into.input += u.input;
  into.output += u.output;
  into.cacheRead += u.cacheRead;
  into.cacheWrite += u.cacheWrite;
}

export function createClaudeAggState(sessionId: string | null, agentId: string | null = null): ClaudeAggState {
  return {
    version: 1,
    sessionId,
    agentId,
    seq: 0,
    turn: 0,
    startCwd: null,
    cwds: [],
    firstPrompt: null,
    lastHumanPrompt: null,
    lastPromptMeta: null,
    agentName: null,
    customTitle: null,
    aiTitle: null,
    summary: null,
    awaySummary: null,
    startedAt: null,
    lastActivityAt: null,
    models: [],
    permissionMode: null,
    usage: emptyUsage(),
    seenMessageIds: [],
    costState: null,
    prs: [],
    tickets: [],
    skills: [],
    mcpServers: [],
    filesTouched: [],
    promptCount: 0,
    toolCallCount: 0,
    apiErrorCount: 0,
    pendingTests: {},
    lastTest: null,
    touchedProd: false,
    lastEventKind: null,
    unknownTypes: {},
  };
}

// Transient lookup cache; the serialisable source of truth is state.seenMessageIds.
const seenCache = new WeakMap<ClaudeAggState, Set<string>>();

function markSeen(state: ClaudeAggState, id: string): boolean {
  let set = seenCache.get(state);
  if (!set) {
    set = new Set(state.seenMessageIds);
    seenCache.set(state, set);
  }
  if (set.has(id)) return false;
  set.add(id);
  state.seenMessageIds.push(id);
  return true;
}

function touch(state: ClaudeAggState, rec: Obj): void {
  const ts = str(rec.timestamp);
  if (ts) {
    if (!state.startedAt || ts < state.startedAt) state.startedAt = ts;
    if (!state.lastActivityAt || ts > state.lastActivityAt) state.lastActivityAt = ts;
  }
  const cwd = str(rec.cwd);
  if (cwd) {
    if (!state.startCwd) state.startCwd = cwd;
    addUnique(state.cwds, [cwd]);
  }
}

function newEvent(state: ClaudeAggState, rec: ClaudeMessageRecord, index: number, kind: EventKind): TimelineEvent {
  state.seq += 1;
  state.lastEventKind = kind;
  const uuid = typeof rec.uuid === 'string' ? rec.uuid : `${state.sessionId ?? 'session'}-${state.seq}`;
  return {
    sessionId: state.sessionId ?? rec.sessionId,
    agentId: state.agentId,
    uuid: index === 0 ? uuid : `${uuid}#${index}`,
    parentUuid: typeof rec.parentUuid === 'string' ? rec.parentUuid : null,
    seq: state.seq,
    ts: str(rec.timestamp) ?? state.lastActivityAt ?? '',
    kind,
    turn: state.turn,
    text: null,
    tool: null,
    toolUseId: null,
    mcpServer: null,
    input: null,
    messageId: null,
    model: null,
    usage: null,
    durationMs: null,
  };
}

function repoFromUrl(url: string): string {
  return /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? '';
}

function parseCostState(rec: Obj): CostStateSnapshot | null {
  if (typeof rec.totalCostUSD !== 'number') return null;
  const usage = emptyUsage();
  if (isObj(rec.modelUsage)) {
    for (const m of Object.values(rec.modelUsage)) {
      if (!isObj(m)) continue;
      usage.input += num(m.inputTokens);
      usage.output += num(m.outputTokens);
      usage.cacheRead += num(m.cacheReadInputTokens);
      usage.cacheWrite += num(m.cacheCreationInputTokens);
    }
  }
  usage.costUsd = rec.totalCostUSD;
  return {
    totalCostUSD: rec.totalCostUSD,
    linesAdded: typeof rec.totalLinesAdded === 'number' ? rec.totalLinesAdded : null,
    linesRemoved: typeof rec.totalLinesRemoved === 'number' ? rec.totalLinesRemoved : null,
    usage,
  };
}

function applySessionMeta(state: ClaudeAggState, type: SessionMetaType, rec: Obj): void {
  if (!state.sessionId) state.sessionId = str(rec.sessionId);
  switch (type) {
    case 'agent-name':
      state.agentName = str(rec.agentName) ?? state.agentName;
      break;
    case 'ai-title':
      state.aiTitle = str(rec.aiTitle) ?? state.aiTitle;
      break;
    case 'custom-title':
      state.customTitle = str(rec.customTitle) ?? str(rec.title) ?? state.customTitle;
      break;
    case 'summary':
      state.summary = str(rec.summary) ?? state.summary;
      break;
    case 'last-prompt':
      state.lastPromptMeta = str(rec.lastPrompt) ?? state.lastPromptMeta;
      break;
    case 'permission-mode':
    case 'mode':
      state.permissionMode = str(rec.permissionMode) ?? str(rec.mode) ?? state.permissionMode;
      break;
    case 'pr-link': {
      const url = str(rec.prUrl);
      const n = typeof rec.prNumber === 'number' ? rec.prNumber : Number(rec.prNumber);
      if (url && Number.isFinite(n) && !state.prs.some((p) => p.url === url)) {
        state.prs.push({ repo: str(rec.prRepository) ?? repoFromUrl(url), number: n, url });
      }
      break;
    }
    case 'cost-state':
      state.costState = parseCostState(rec) ?? state.costState;
      break;
    default:
      break;
  }
}

function onPrompt(state: ClaudeAggState, rec: ClaudeMessageRecord, text: string, cfg: DeriveConfig): TimelineEvent {
  state.turn += 1;
  state.promptCount += 1;
  if (state.firstPrompt === null) state.firstPrompt = text;
  state.lastHumanPrompt = text;
  addUnique(state.tickets, extractTickets(text, cfg.ticketRegex));
  const cmd = slashCommand(text);
  if (cmd) addUnique(state.skills, [cmd]);
  const e = newEvent(state, rec, 0, 'prompt');
  e.text = text;
  return e;
}

function stdoutOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!isObj(v)) return '';
  return [str(v.stdout), str(v.stderr)].filter((x): x is string => Boolean(x)).join('\n');
}

function recordTest(state: ClaudeAggState, toolUseId: string | null, text: string, rec: ClaudeMessageRecord, ts: string): void {
  if (!toolUseId) return;
  const command = state.pendingTests[toolUseId];
  if (command === undefined) return;
  const { [toolUseId]: _done, ...rest } = state.pendingTests;
  state.pendingTests = rest;
  const result = parseTestOutput(command, text, ts) ?? parseTestOutput(command, stdoutOf(rec.toolUseResult), ts);
  if (result) state.lastTest = result;
}

function onToolResult(state: ClaudeAggState, rec: ClaudeMessageRecord): TimelineEvent[] {
  const content = rec.message?.content;
  const blocks = Array.isArray(content) ? content.filter((b): b is Obj => isObj(b) && b.type === 'tool_result') : [];
  const out: TimelineEvent[] = [];
  const clip = (t: string) => (t.length > TOOL_RESULT_MAX ? `${t.slice(0, TOOL_RESULT_MAX)}…` : t);
  for (const [i, b] of blocks.entries()) {
    const toolUseId = str(b.tool_use_id);
    const text = typeof b.content === 'string' ? b.content : contentText(b.content);
    const e = newEvent(state, rec, i, 'tool_result');
    e.toolUseId = toolUseId;
    e.text = clip(text);
    out.push(e);
    recordTest(state, toolUseId, text, rec, e.ts);
  }
  if (blocks.length === 0) {
    const e = newEvent(state, rec, 0, 'tool_result');
    e.text = clip(stdoutOf(rec.toolUseResult));
    out.push(e);
  }
  return out;
}

function onToolUse(state: ClaudeAggState, name: string, toolUseId: string | null, input: unknown, cfg: DeriveConfig): void {
  state.toolCallCount += 1;
  const inp = isObj(input) ? input : {};
  const server = mcpServerOf(name);
  if (server) {
    addUnique(state.mcpServers, [server]);
    addUnique(state.tickets, extractTickets(JSON.stringify(inp), cfg.ticketRegex));
    if (matchesProd(name, cfg.prodPatterns)) state.touchedProd = true;
  }
  if (name === 'Skill') {
    const skill = str(inp.skill);
    if (skill) {
      addUnique(state.skills, [skill]);
      if (matchesProd(skill, cfg.prodPatterns)) state.touchedProd = true;
    }
    addUnique(state.tickets, extractTickets(str(inp.args) ?? '', cfg.ticketRegex));
  }
  if (name === 'Bash') {
    const command = str(inp.command) ?? '';
    addUnique(state.tickets, extractTickets(command, cfg.ticketRegex));
    if (matchesProd(command, cfg.prodPatterns)) state.touchedProd = true;
    if (toolUseId && isTestCommand(command)) state.pendingTests[toolUseId] = command;
  }
  if (EDIT_TOOLS.has(name)) {
    const file = str(inp.file_path) ?? str(inp.notebook_path);
    if (file) addUnique(state.filesTouched, [file]);
  }
}

function onAssistant(state: ClaudeAggState, rec: ClaudeMessageRecord, cfg: DeriveConfig): TimelineEvent[] {
  const msg = rec.message ?? {};
  const model = str(msg.model);
  if (model && model !== '<synthetic>') addUnique(state.models, [model]);
  const isError = rec.isApiErrorMessage === true;
  if (isError) state.apiErrorCount += 1;
  if (typeof rec.attributionSkill === 'string') addUnique(state.skills, [rec.attributionSkill]);

  const messageId = str(msg.id);
  let usage: Usage | null = null;
  const u = usageFromClaude(isObj(msg.usage) ? msg.usage : undefined);
  if (u && (messageId === null || markSeen(state, messageId))) {
    addUsage(state.usage, u);
    usage = u;
  }

  const blocks: Obj[] = Array.isArray(msg.content)
    ? msg.content.filter(isObj)
    : typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }]
      : [];
  const out: TimelineEvent[] = [];
  for (const [i, b] of blocks.entries()) {
    let e: TimelineEvent | null = null;
    if (b.type === 'text') {
      e = newEvent(state, rec, i, isError ? 'error' : 'assistant_text');
      e.text = str(b.text) ?? '';
    } else if (b.type === 'thinking') {
      e = newEvent(state, rec, i, 'thinking');
      e.text = str(b.thinking) ?? '';
    } else if (b.type === 'tool_use') {
      e = newEvent(state, rec, i, 'tool_call');
      const name = str(b.name) ?? 'unknown';
      e.tool = name;
      e.toolUseId = str(b.id);
      e.input = b.input ?? null;
      e.mcpServer = mcpServerOf(name);
      onToolUse(state, name, e.toolUseId, b.input, cfg);
    }
    if (!e) continue;
    e.messageId = messageId;
    e.model = model;
    if (usage) {
      e.usage = usage;
      usage = null;
    }
    out.push(e);
  }
  return out;
}

function onSystem(state: ClaudeAggState, rec: ClaudeMessageRecord, subtype: string | null): TimelineEvent {
  const level = str((rec as unknown as Obj).level);
  const kind: EventKind = subtype === 'api_error' || level === 'error' ? 'error' : 'system';
  if (kind === 'error') state.apiErrorCount += 1;
  const e = newEvent(state, rec, 0, kind);
  e.tool = subtype;
  if (subtype === 'turn_duration') {
    e.durationMs = typeof rec.durationMs === 'number' ? rec.durationMs : null;
  } else {
    e.text = contentText(rec.content) || subtype;
  }
  if (subtype === 'away_summary') state.awaySummary = e.text;
  return e;
}

export function ingestClaudeRecord(state: ClaudeAggState, value: unknown, resolve: ResolveDeriveConfig): TimelineEvent[] {
  const c = classifyClaudeRecord(value);
  if (c.kind === 'unknown') {
    const key = c.type ?? '(invalid)';
    state.unknownTypes[key] = (state.unknownTypes[key] ?? 0) + 1;
    return [];
  }
  if (c.kind === 'ignored') return [];
  if (c.kind === 'session_meta') {
    applySessionMeta(state, c.type, c.rec);
    return [];
  }
  const rec = c.rec;
  const raw = rec as unknown as Obj;
  if (!state.sessionId && typeof rec.sessionId === 'string') state.sessionId = rec.sessionId;
  touch(state, raw);
  const pm = str(raw.permissionMode);
  if (pm) state.permissionMode = pm;
  const cfg = resolve(state.startCwd);
  switch (c.kind) {
    case 'human_prompt':
      return [onPrompt(state, rec, c.text, cfg)];
    case 'tool_result':
      return onToolResult(state, rec);
    case 'assistant':
      return onAssistant(state, rec, cfg);
    case 'system':
      return [onSystem(state, rec, c.subtype)];
    default:
      return [];
  }
}

export function claudeStateToSession(
  state: ClaudeAggState,
  o: { projectId: string | null; transcriptPath: string | null; availability: Availability; hasSubagents: boolean },
): Session | null {
  if (!state.sessionId || !state.startedAt) return null;
  const usage: Usage = state.costState ? { ...state.costState.usage } : { ...state.usage };
  return {
    id: state.sessionId,
    source: 'claude',
    projectId: o.projectId,
    startCwd: state.startCwd ?? '',
    cwds: [...state.cwds],
    name: deriveName({
      agentName: state.agentName,
      customTitle: state.customTitle,
      aiTitle: state.aiTitle,
      summary: state.summary,
      firstPrompt: state.firstPrompt,
    }),
    firstPrompt: state.firstPrompt,
    lastPrompt: state.lastPromptMeta ?? state.lastHumanPrompt,
    awaySummary: state.awaySummary,
    recap: null,
    startedAt: state.startedAt,
    lastActivityAt: state.lastActivityAt ?? state.startedAt,
    models: [...state.models],
    permissionMode: state.permissionMode,
    usage,
    linesAdded: state.costState?.linesAdded ?? null,
    linesRemoved: state.costState?.linesRemoved ?? null,
    prs: state.prs.map((p) => ({ ...p })),
    tickets: [...state.tickets],
    skills: [...state.skills],
    mcpServers: [...state.mcpServers],
    filesTouched: [...state.filesTouched],
    promptCount: state.promptCount,
    toolCallCount: state.toolCallCount,
    apiErrorCount: state.apiErrorCount,
    flags: { touchedProd: state.touchedProd, hasSubagents: o.hasSubagents, automated: false },
    availability: o.availability,
    transcriptPath: o.transcriptPath,
    lastTest: state.lastTest ? { ...state.lastTest } : null,
    live: null,
  };
}
```

Add to both `packages/core/src/index.ts` and `packages/core/src/browser.ts`:
```ts
export * from './claude/session-aggregate.ts';
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run packages/core/src/claude`
Expected: PASS (records + session-aggregate suites). If the S1 spike added record types to `records.ts`, they classify as `ignored`/`session_meta` and do not change these expectations; if S1 renamed any fixture content, update the literal expectations to match the fixture and note it in the review.

- [ ] **Step 5: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add packages/core
git commit -m "feat(core): aggregate Claude transcripts into sessions and timeline events"
```

---

### Task 3: Subagent tree, prompt history and registry parsers

**Files:**
- Create: `packages/core/src/claude/subagents.ts`, `packages/core/src/claude/history.ts`, `packages/core/src/claude/registry.ts`
- Create: `packages/core/src/claude/parsers.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/browser.ts`

**Interfaces:**
- Consumes: `ClaudeAggState`, `createClaudeAggState`, `ingestClaudeRecord` (Task 2); `deriveName`, `extractTickets`, `slashCommand`, `addUnique` (Task 1); `AgentNode`, `Session`, `LiveStatus`, `emptyUsage` (Phase 0).
- Produces: `SubagentMeta`, `parseSubagentMeta`, `agentIdFromPath`, `claudeStateToAgentNode`, `AgentTreeNode`, `buildAgentTree`, `HistoryPrompt`, `parseHistoryLine`, `historyPromptsToSession`, `RegistryEntry`, `parseRegistryFile`, `registryStatusToLive` (exact signatures in "Contract additions"). `parseRegistryFile` never copies `messagingSocketPath` or `peer*` fields.

- [ ] **Step 1: Write the failing test**

`packages/core/src/claude/parsers.test.ts`
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJsonLine, readJsonlFrom } from '../io/jsonl-tail.ts';
import { FIXTURES_DIR } from '../test-utils/fixtures.ts';
import type { AgentNode } from '../types/session.ts';
import { compileTicketRegex, DEFAULT_TICKET_REGEX } from '../derive/tickets.ts';
import { historyPromptsToSession, parseHistoryLine } from './history.ts';
import { parseRegistryFile, registryStatusToLive } from './registry.ts';
import { createClaudeAggState, ingestClaudeRecord } from './session-aggregate.ts';
import { agentIdFromPath, buildAgentTree, claudeStateToAgentNode, parseSubagentMeta } from './subagents.ts';

const home = join(FIXTURES_DIR, 'claude-home');
const subDir = join(home, 'projects/-Users-test-Wakecap/s-subagents/subagents');
const resolve = () => ({ ticketRegex: null, prodPatterns: [] });

async function agentNode(agentId: string): Promise<AgentNode> {
  const path = join(subDir, `agent-${agentId}.jsonl`);
  const state = createClaudeAggState('s-subagents', agentId);
  for (const l of (await readJsonlFrom(path, 0)).lines) ingestClaudeRecord(state, parseJsonLine(l.text), resolve);
  const meta = parseSubagentMeta(JSON.parse(readFileSync(join(subDir, `agent-${agentId}.meta.json`), 'utf8')));
  return claudeStateToAgentNode(state, meta, { sessionId: 's-subagents', agentId, transcriptPath: path });
}

describe('subagents', () => {
  it('reads agent ids from paths', () => {
    expect(agentIdFromPath('/x/subagents/agent-ag1.jsonl')).toBe('ag1');
    expect(agentIdFromPath('/x/subagents/agent-ag1.meta.json')).toBe('ag1');
    expect(agentIdFromPath('/x/s-basic.jsonl')).toBeNull();
  });

  it('parses meta with defaults', () => {
    expect(parseSubagentMeta(null)).toEqual({
      agentType: 'unknown',
      description: '',
      toolUseId: null,
      parentAgentId: null,
      spawnDepth: 1,
      background: false,
    });
  });

  it('builds a 3-level tree with the background flag', async () => {
    const nodes = await Promise.all(['ag3', 'ag1', 'ag2'].map(agentNode));
    const ag1 = nodes.find((n) => n.id === 'ag1');
    expect(ag1).toMatchObject({
      sessionId: 's-subagents',
      parentId: null,
      depth: 1,
      agentType: 'Explore',
      description: 'Explore logs',
      background: true,
      toolUseId: 'gtu1',
      startedAt: '2026-09-06T08:00:03.000Z',
      endedAt: '2026-09-06T08:00:10.000Z',
      status: 'done',
      usage: { input: 2, output: 3, cacheRead: 50, cacheWrite: 0, costUsd: null },
    });
    const tree = buildAgentTree(nodes);
    expect(tree.map((t) => t.node.id)).toEqual(['ag1']);
    expect(tree[0]?.children.map((t) => t.node.id)).toEqual(['ag2']);
    expect(tree[0]?.children[0]?.children.map((t) => [t.node.id, t.node.depth, t.node.background])).toEqual([
      ['ag3', 3, false],
    ]);
  });
});

describe('history.jsonl', () => {
  const prompts = readFileSync(join(home, 'history.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => parseHistoryLine(parseJsonLine(l)));

  it('parses lines with string or number timestamps', () => {
    expect(prompts[0]).toEqual({
      sessionId: 's-old-prompts-only',
      ts: '2025-12-25T08:06:40.000Z',
      display: 'old session from december',
      project: '/Users/test/Wakecap',
    });
    expect(parseHistoryLine({ display: 'x', timestamp: 1788253200000, project: '/p', sessionId: 's' })?.ts).toBe(
      '2026-09-01T09:00:00.000Z',
    );
    expect(parseHistoryLine({ display: 'x' })).toBeNull();
    expect(parseHistoryLine('nope')).toBeNull();
  });

  it('builds prompts-only sessions', () => {
    const basic = prompts.filter((p) => p?.sessionId === 's-basic').flatMap((p) => (p ? [p] : []));
    const s = historyPromptsToSession(basic, { projectId: 'wakecap', ticketRegex: compileTicketRegex(DEFAULT_TICKET_REGEX) });
    expect(s).toMatchObject({
      id: 's-basic',
      source: 'claude',
      projectId: 'wakecap',
      startCwd: '/Users/test/Wakecap',
      name: 'check the notification service tests',
      firstPrompt: 'check the notification service tests',
      lastPrompt: 'continue',
      startedAt: '2026-09-01T09:00:00.000Z',
      lastActivityAt: '2026-09-01T09:05:00.000Z',
      promptCount: 2,
      availability: 'prompts-only',
      transcriptPath: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null },
    });
    const stocks = prompts.filter((p) => p?.sessionId === 's-stocks').flatMap((p) => (p ? [p] : []));
    expect(historyPromptsToSession(stocks, { projectId: null, ticketRegex: null })).toMatchObject({
      startCwd: '/Users/test/Stocks/EGX Investment Research',
      skills: ['long-scan'],
      projectId: null,
    });
    expect(historyPromptsToSession([], { projectId: null, ticketRegex: null })).toBeNull();
  });
});

describe('registry', () => {
  it('parses a registry file without the messaging socket', () => {
    const raw: unknown = JSON.parse(readFileSync(join(home, 'sessions/41001.json'), 'utf8'));
    const e = parseRegistryFile(raw);
    expect(e).toEqual({
      pid: 41001,
      sessionId: 's-basic',
      cwd: '/Users/test/Wakecap',
      startedAt: '2026-09-01T09:00:00.000Z',
      status: 'waiting',
      waitingFor: 'input needed',
      name: 'notification-tests',
      statusUpdatedAt: '2026-09-01T09:06:40.000Z',
      procStart: 'Mon Sep  1 09:00:00 2026',
      kind: 'interactive',
      version: '2.1.273',
    });
    expect(JSON.stringify(e)).not.toContain('cc-socks');
    expect(parseRegistryFile({ pid: 'x' })).toBeNull();
  });

  it('maps registry status to LiveStatus', () => {
    expect(registryStatusToLive('busy')).toBe('busy');
    expect(registryStatusToLive('waiting')).toBe('waiting');
    expect(registryStatusToLive('shell')).toBe('shell');
    expect(registryStatusToLive('something-new')).toBe('idle');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/core/src/claude/parsers`
Expected: FAIL, `Cannot find module './history.ts'`

- [ ] **Step 3: Implement the parsers**

`packages/core/src/claude/subagents.ts`
```ts
import type { AgentNode } from '../types/session.ts';
import type { ClaudeAggState } from './session-aggregate.ts';

export interface SubagentMeta {
  agentType: string;
  description: string;
  toolUseId: string | null;
  parentAgentId: string | null;
  spawnDepth: number;
  background: boolean;
}

export interface AgentTreeNode {
  node: AgentNode;
  children: AgentTreeNode[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function parseSubagentMeta(value: unknown): SubagentMeta {
  const v = isObj(value) ? value : {};
  const depth = typeof v.spawnDepth === 'number' && v.spawnDepth > 0 ? v.spawnDepth : 1;
  return {
    agentType: str(v.agentType) ?? 'unknown',
    description: str(v.description) ?? '',
    toolUseId: str(v.toolUseId),
    parentAgentId: str(v.parentAgentId),
    spawnDepth: depth,
    background: v.requestShape === 'background',
  };
}

export function agentIdFromPath(path: string): string | null {
  return /agent-([^/]+?)(?:\.meta\.json|\.jsonl)$/.exec(path)?.[1] ?? null;
}

export function claudeStateToAgentNode(
  state: ClaudeAggState,
  meta: SubagentMeta,
  o: { sessionId: string; agentId: string; transcriptPath: string },
): AgentNode {
  return {
    id: o.agentId,
    sessionId: o.sessionId,
    parentId: meta.parentAgentId,
    depth: meta.spawnDepth,
    agentType: meta.agentType,
    description: meta.description,
    background: meta.background,
    toolUseId: meta.toolUseId,
    usage: { ...state.usage },
    startedAt: state.startedAt ?? '',
    endedAt: state.lastActivityAt,
    // 'running' needs liveness (Phase 2); Phase 1 reports done/error from the transcript only.
    status: state.lastEventKind === 'error' ? 'error' : 'done',
    transcriptPath: o.transcriptPath,
  };
}

export function buildAgentTree(nodes: AgentNode[]): AgentTreeNode[] {
  const byId = new Map<string, AgentTreeNode>();
  for (const n of nodes) byId.set(n.id, { node: n, children: [] });
  const roots: AgentTreeNode[] = [];
  for (const t of byId.values()) {
    const parent = t.node.parentId ? byId.get(t.node.parentId) : undefined;
    if (parent) parent.children.push(t);
    else roots.push(t);
  }
  const sortRec = (list: AgentTreeNode[]): void => {
    list.sort((a, b) => a.node.startedAt.localeCompare(b.node.startedAt));
    for (const c of list) sortRec(c.children);
  };
  sortRec(roots);
  return roots;
}
```

`packages/core/src/claude/history.ts`
```ts
import { deriveName } from '../derive/name.ts';
import { slashCommand } from '../derive/skills.ts';
import { extractTickets } from '../derive/tickets.ts';
import { addUnique } from '../derive/util.ts';
import type { Session } from '../types/session.ts';
import { emptyUsage } from '../types/session.ts';

export interface HistoryPrompt {
  sessionId: string;
  ts: string;
  display: string;
  project: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One line of ~/.claude/history.jsonl. `pastedContents` is deliberately dropped (may contain secrets). */
export function parseHistoryLine(value: unknown): HistoryPrompt | null {
  if (!isObj(value)) return null;
  const { sessionId, project, display, timestamp } = value;
  const ms = typeof timestamp === 'number' ? timestamp : typeof timestamp === 'string' ? Number(timestamp) : Number.NaN;
  if (typeof sessionId !== 'string' || typeof project !== 'string' || typeof display !== 'string') return null;
  if (!Number.isFinite(ms)) return null;
  return { sessionId, project, display, ts: new Date(ms).toISOString() };
}

export function historyPromptsToSession(
  prompts: HistoryPrompt[],
  o: { projectId: string | null; ticketRegex: RegExp | null },
): Session | null {
  const sorted = [...prompts].sort((a, b) => a.ts.localeCompare(b.ts));
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) return null;
  const cwds: string[] = [];
  const tickets: string[] = [];
  const skills: string[] = [];
  for (const p of sorted) {
    addUnique(cwds, [p.project]);
    addUnique(tickets, extractTickets(p.display, o.ticketRegex));
    const cmd = slashCommand(p.display);
    if (cmd) addUnique(skills, [cmd]);
  }
  return {
    id: first.sessionId,
    source: 'claude',
    projectId: o.projectId,
    startCwd: first.project,
    cwds,
    name: deriveName({ agentName: null, customTitle: null, aiTitle: null, summary: null, firstPrompt: first.display }),
    firstPrompt: first.display,
    lastPrompt: last.display,
    awaySummary: null,
    recap: null,
    startedAt: first.ts,
    lastActivityAt: last.ts,
    models: [],
    permissionMode: null,
    usage: emptyUsage(),
    linesAdded: null,
    linesRemoved: null,
    prs: [],
    tickets,
    skills,
    mcpServers: [],
    filesTouched: [],
    promptCount: sorted.length,
    toolCallCount: 0,
    apiErrorCount: 0,
    flags: { touchedProd: false, hasSubagents: false, automated: false },
    availability: 'prompts-only',
    transcriptPath: null,
    lastTest: null,
    live: null,
  };
}
```

`packages/core/src/claude/registry.ts`
```ts
import type { LiveStatus } from '../types/session.ts';

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: string | null;
  status: string;
  waitingFor: string | null;
  name: string | null;
  statusUpdatedAt: string | null;
  procStart: string | null;
  kind: string | null;
  version: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const msToIso = (v: unknown): string | null =>
  typeof v === 'number' && Number.isFinite(v) ? new Date(v).toISOString() : null;

/** ~/.claude/sessions/<pid>.json. Only whitelisted fields are copied; messagingSocketPath is never read. */
export function parseRegistryFile(value: unknown): RegistryEntry | null {
  if (!isObj(value)) return null;
  const { pid, sessionId, cwd } = value;
  if (typeof pid !== 'number' || typeof sessionId !== 'string' || typeof cwd !== 'string') return null;
  return {
    pid,
    sessionId,
    cwd,
    startedAt: msToIso(value.startedAt),
    status: str(value.status) ?? 'idle',
    waitingFor: str(value.waitingFor),
    name: str(value.name),
    statusUpdatedAt: msToIso(value.statusUpdatedAt),
    procStart: str(value.procStart),
    kind: str(value.kind),
    version: str(value.version),
  };
}

export function registryStatusToLive(status: string): LiveStatus {
  switch (status) {
    case 'busy':
    case 'idle':
    case 'waiting':
    case 'shell':
      return status;
    default:
      return 'idle';
  }
}
```

Add to both `packages/core/src/index.ts` and `packages/core/src/browser.ts`:
```ts
export * from './claude/subagents.ts';
export * from './claude/history.ts';
export * from './claude/registry.ts';
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run packages/core/src/claude`
Expected: PASS

- [ ] **Step 5: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add packages/core
git commit -m "feat(core): parse subagent meta, prompt history and the live registry"
```

---

### Task 4: Codex rollout aggregate

**Files:**
- Create: `packages/core/src/codex/rollout.ts`, `packages/core/src/codex/codex-aggregate.ts`, `packages/core/src/codex/codex-aggregate.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/browser.ts`

**Interfaces:**
- Consumes: `ResolveDeriveConfig`, `usage` helpers pattern (Task 2); Task 1 derivations.
- Produces:
  ```ts
  // codex/rollout.ts
  export interface CodexEnvelope { timestamp: string; ordinal: number | null; type: string; payload: Record<string, unknown> }
  export function parseCodexEnvelope(value: unknown): CodexEnvelope | null
  export function codexShellCommand(args: unknown): string | null     // joins `command`/`cmd` arrays
  // codex/codex-aggregate.ts
  export interface CodexAggState { version: 1; sessionId: string | null; seq: number; turn: number; startCwd: string | null; cwds: string[]; originator: string | null; firstPrompt: string | null; lastPrompt: string | null; startedAt: string | null; lastActivityAt: string | null; models: string[]; usage: Usage; tickets: string[]; skills: string[]; filesTouched: string[]; promptCount: number; toolCallCount: number; apiErrorCount: number; pendingTests: Record<string, string>; lastTest: TestResult | null; touchedProd: boolean; unknownTypes: Record<string, number> }
  export function createCodexAggState(): CodexAggState
  export function ingestCodexRecord(state: CodexAggState, value: unknown, resolve: ResolveDeriveConfig): TimelineEvent[]
  export function codexStateToSession(state: CodexAggState, o: { projectId: string | null; transcriptPath: string | null; availability: Availability }): Session | null
  ```
  Rules: `flags.automated = originator === 'codex_sdk_ts'`. Usage comes from the **last** `token_count` (`input = input_tokens − cached_input_tokens`, `cacheRead = cached_input_tokens`, `output = output_tokens`, `cacheWrite = 0`, `costUsd = null`). `base_instructions` is never stored. User messages that start with `<environment_context>`, `<user_instructions>` or `# AGENTS.md` are injected context and produce no event. Event uuid = `${sessionId}:${ordinal ?? seq}`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/codex/codex-aggregate.test.ts`
```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileTicketRegex, DEFAULT_TICKET_REGEX } from '../derive/tickets.ts';
import { parseJsonLine, readJsonlFrom } from '../io/jsonl-tail.ts';
import { FIXTURES_DIR } from '../test-utils/fixtures.ts';
import type { TimelineEvent } from '../types/events.ts';
import { codexStateToSession, createCodexAggState, ingestCodexRecord } from './codex-aggregate.ts';
import { codexShellCommand, parseCodexEnvelope } from './rollout.ts';

const resolve = () => ({ ticketRegex: compileTicketRegex(DEFAULT_TICKET_REGEX), prodPatterns: [] });
const BASIC = 'codex-home/sessions/2026/09/01/rollout-2026-09-01T09-00-00-c0dex000-0000-0000-0000-000000000001.jsonl';
const AUTO = 'codex-home/sessions/2026/03/10/rollout-2026-03-10T09-00-00-c0dex000-0000-0000-0000-000000000002.jsonl';
const opts = { projectId: 'wakecap', transcriptPath: '/r.jsonl', availability: 'resumable' as const };

async function ingest(rel: string) {
  const state = createCodexAggState();
  const events: TimelineEvent[] = [];
  for (const l of (await readJsonlFrom(join(FIXTURES_DIR, rel), 0)).lines) {
    events.push(...ingestCodexRecord(state, parseJsonLine(l.text), resolve));
  }
  return { state, events };
}

describe('rollout helpers', () => {
  it('parses envelopes and shell commands', () => {
    expect(parseCodexEnvelope({ timestamp: 't', type: 'x', payload: {} })).toEqual({
      timestamp: 't',
      ordinal: null,
      type: 'x',
      payload: {},
    });
    expect(parseCodexEnvelope({ type: 'x' })).toBeNull();
    expect(codexShellCommand({ command: ['rg', 'weekend'] })).toBe('rg weekend');
    expect(codexShellCommand({ cmd: 'pnpm test' })).toBe('pnpm test');
    expect(codexShellCommand('{"command":["ls"]}')).toBe('ls');
    expect(codexShellCommand(42)).toBeNull();
  });
});

describe('Codex aggregate', () => {
  it('maps codex-basic to events', async () => {
    const { events } = await ingest(BASIC);
    expect(events.map((e) => [e.kind, e.seq, e.turn])).toEqual([
      ['prompt', 1, 1],
      ['tool_call', 2, 1],
      ['tool_result', 3, 1],
      ['assistant_text', 4, 1],
    ]);
    expect(events[0]).toMatchObject({
      sessionId: 'c0dex000-0000-0000-0000-000000000001',
      uuid: 'c0dex000-0000-0000-0000-000000000001:2',
      text: 'second opinion on SAF-1787 plan',
      agentId: null,
    });
    expect(events[1]).toMatchObject({ tool: 'shell', toolUseId: 'c1', input: { command: ['rg', 'weekend'] } });
    expect(events[2]).toMatchObject({ toolUseId: 'c1', text: '3 matches' });
    expect(events[3]?.text).toBe('Plan looks fine.');
  });

  it('builds the codex-basic session', async () => {
    const { state } = await ingest(BASIC);
    expect(codexStateToSession(state, opts)).toMatchObject({
      id: 'c0dex000-0000-0000-0000-000000000001',
      source: 'codex',
      startCwd: '/Users/test/Wakecap',
      name: 'second opinion on SAF-1787 plan',
      models: ['gpt-5.5-codex'],
      tickets: ['SAF-1787'],
      toolCallCount: 1,
      promptCount: 1,
      startedAt: '2026-09-01T09:00:00.000Z',
      lastActivityAt: '2026-09-01T09:00:11.000Z',
      usage: { input: 400, output: 90, cacheRead: 800, cacheWrite: 0, costUsd: null },
      flags: { touchedProd: false, hasSubagents: false, automated: false },
    });
    expect(JSON.stringify(state)).not.toContain('LONG TEXT SKIPPED');
  });

  it('flags codex_sdk_ts sessions as automated', async () => {
    const { state } = await ingest(AUTO);
    expect(codexStateToSession(state, opts)?.flags.automated).toBe(true);
  });

  it('skips injected context messages and parses test output', () => {
    const state = createCodexAggState();
    const rec = (ordinal: number, type: string, payload: Record<string, unknown>) => ({
      timestamp: `2026-09-01T10:00:0${ordinal}.000Z`,
      ordinal,
      type,
      payload,
    });
    ingestCodexRecord(state, rec(0, 'session_meta', { id: 'c3', cwd: '/w', originator: 'codex_cli_rs' }), resolve);
    const ctx = ingestCodexRecord(
      state,
      rec(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x' }] }),
      resolve,
    );
    expect(ctx).toEqual([]);
    ingestCodexRecord(
      state,
      rec(2, 'response_item', { type: 'function_call', name: 'shell', arguments: '{"command":["pnpm","vitest","run"]}', call_id: 'k' }),
      resolve,
    );
    ingestCodexRecord(
      state,
      rec(3, 'response_item', {
        type: 'function_call_output',
        call_id: 'k',
        output: JSON.stringify({ output: '      Tests  3 passed (3)\n   Duration  10ms', metadata: {} }),
      }),
      resolve,
    );
    ingestCodexRecord(
      state,
      rec(4, 'response_item', { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: /w/a.ts\n', call_id: 'p' }),
      resolve,
    );
    const err = ingestCodexRecord(state, rec(5, 'event_msg', { type: 'error', message: 'stream disconnected' }), resolve);
    const s = codexStateToSession(state, opts);
    expect(s?.lastTest).toMatchObject({ passed: 3, failed: 0, command: 'pnpm vitest run' });
    expect(s?.filesTouched).toEqual(['/w/a.ts']);
    expect(s?.apiErrorCount).toBe(1);
    expect(err[0]).toMatchObject({ kind: 'error', text: 'stream disconnected' });
    expect(s?.promptCount).toBe(0);
    expect(s?.name).toBeNull();
  });

  it('returns null without session_meta', () => {
    expect(codexStateToSession(createCodexAggState(), opts)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/core/src/codex`
Expected: FAIL, `Cannot find module './codex-aggregate.ts'`

- [ ] **Step 3: Implement the rollout parser and aggregate**

`packages/core/src/codex/rollout.ts`
```ts
export interface CodexEnvelope {
  timestamp: string;
  ordinal: number | null;
  type: string;
  payload: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseCodexEnvelope(value: unknown): CodexEnvelope | null {
  if (!isObj(value)) return null;
  const { timestamp, type, payload, ordinal } = value;
  if (typeof timestamp !== 'string' || typeof type !== 'string' || !isObj(payload)) return null;
  return { timestamp, type, payload, ordinal: typeof ordinal === 'number' ? ordinal : null };
}

/** Parses function_call `arguments` (JSON string or object) and returns the shell command line, if any. */
export function codexShellCommand(args: unknown): string | null {
  let v: unknown = args;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!isObj(v)) return null;
  const c = v.command ?? v.cmd;
  if (Array.isArray(c)) return c.map(String).join(' ');
  return typeof c === 'string' ? c : null;
}
```

`packages/core/src/codex/codex-aggregate.ts`
```ts
import type { DeriveConfig, ResolveDeriveConfig } from '../claude/session-aggregate.ts';
import { deriveName } from '../derive/name.ts';
import { matchesProd } from '../derive/prod.ts';
import { isTestCommand, parseTestOutput } from '../derive/tests.ts';
import { extractTickets } from '../derive/tickets.ts';
import { addUnique } from '../derive/util.ts';
import type { EventKind, TimelineEvent } from '../types/events.ts';
import type { Availability, Session, TestResult, Usage } from '../types/session.ts';
import { emptyUsage } from '../types/session.ts';
import { type CodexEnvelope, codexShellCommand, parseCodexEnvelope } from './rollout.ts';

export interface CodexAggState {
  version: 1;
  sessionId: string | null;
  seq: number;
  turn: number;
  startCwd: string | null;
  cwds: string[];
  originator: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  models: string[];
  usage: Usage;
  tickets: string[];
  skills: string[];
  filesTouched: string[];
  promptCount: number;
  toolCallCount: number;
  apiErrorCount: number;
  pendingTests: Record<string, string>;
  lastTest: TestResult | null;
  touchedProd: boolean;
  unknownTypes: Record<string, number>;
}

type Obj = Record<string, unknown>;
const SHELL_TOOLS = new Set(['shell', 'exec_command', 'local_shell', 'shell_command']);
const INJECTED = ['<environment_context>', '<user_instructions>', '# AGENTS.md'];
const TOOL_RESULT_MAX = 4000;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function createCodexAggState(): CodexAggState {
  return {
    version: 1,
    sessionId: null,
    seq: 0,
    turn: 0,
    startCwd: null,
    cwds: [],
    originator: null,
    firstPrompt: null,
    lastPrompt: null,
    startedAt: null,
    lastActivityAt: null,
    models: [],
    usage: emptyUsage(),
    tickets: [],
    skills: [],
    filesTouched: [],
    promptCount: 0,
    toolCallCount: 0,
    apiErrorCount: 0,
    pendingTests: {},
    lastTest: null,
    touchedProd: false,
    unknownTypes: {},
  };
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isObj)
    .map((b) => str(b.text) ?? '')
    .filter(Boolean)
    .join('\n');
}

function outputText(output: unknown): string {
  if (isObj(output)) return str(output.output) ?? blockText(output.content);
  if (typeof output !== 'string') return '';
  try {
    const parsed: unknown = JSON.parse(output);
    if (isObj(parsed) && typeof parsed.output === 'string') return parsed.output;
  } catch {
    // plain text output
  }
  return output;
}

function newEvent(state: CodexAggState, env: CodexEnvelope, kind: EventKind): TimelineEvent {
  state.seq += 1;
  const sid = state.sessionId ?? 'codex';
  return {
    sessionId: sid,
    agentId: null,
    uuid: `${sid}:${env.ordinal ?? state.seq}`,
    parentUuid: null,
    seq: state.seq,
    ts: env.timestamp,
    kind,
    turn: state.turn,
    text: null,
    tool: null,
    toolUseId: null,
    mcpServer: null,
    input: null,
    messageId: null,
    model: null,
    usage: null,
    durationMs: null,
  };
}

interface ToolCallInput {
  name: string;
  input: unknown;
  command: string | null;
  cfg: DeriveConfig;
}

function onToolCall(state: CodexAggState, env: CodexEnvelope, t: ToolCallInput): TimelineEvent {
  const { name, input, command, cfg } = t;
  state.toolCallCount += 1;
  const e = newEvent(state, env, 'tool_call');
  e.tool = name;
  e.toolUseId = str(env.payload.call_id);
  e.input = input;
  if (command) {
    addUnique(state.tickets, extractTickets(command, cfg.ticketRegex));
    if (matchesProd(command, cfg.prodPatterns)) state.touchedProd = true;
    if (e.toolUseId && isTestCommand(command)) state.pendingTests[e.toolUseId] = command;
  }
  if (name === 'apply_patch' && typeof input === 'string') {
    for (const m of input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      if (m[1]) addUnique(state.filesTouched, [m[1].trim()]);
    }
  }
  return e;
}

function onResponseItem(state: CodexAggState, env: CodexEnvelope, cfg: DeriveConfig): TimelineEvent[] {
  const p = env.payload;
  switch (p.type) {
    case 'message': {
      const text = blockText(p.content);
      if (p.role === 'user') {
        if (INJECTED.some((prefix) => text.trimStart().startsWith(prefix))) return [];
        state.turn += 1;
        state.promptCount += 1;
        if (state.firstPrompt === null) state.firstPrompt = text;
        state.lastPrompt = text;
        addUnique(state.tickets, extractTickets(text, cfg.ticketRegex));
        const e = newEvent(state, env, 'prompt');
        e.text = text;
        return [e];
      }
      if (p.role === 'assistant') {
        const e = newEvent(state, env, 'assistant_text');
        e.text = text;
        return [e];
      }
      return [];
    }
    case 'reasoning': {
      const summary = Array.isArray(p.summary) ? blockText(p.summary) : '';
      if (!summary) return [];
      const e = newEvent(state, env, 'thinking');
      e.text = summary;
      return [e];
    }
    case 'function_call': {
      const name = str(p.name) ?? 'unknown';
      let input: unknown = p.arguments ?? null;
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          // keep raw string
        }
      }
      const command = SHELL_TOOLS.has(name) ? codexShellCommand(p.arguments) : null;
      return [onToolCall(state, env, { name, input, command, cfg })];
    }
    case 'custom_tool_call': {
      const name = str(p.name) ?? 'unknown';
      return [onToolCall(state, env, { name, input: p.input ?? null, command: null, cfg })];
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const e = newEvent(state, env, 'tool_result');
      e.toolUseId = str(p.call_id);
      const text = outputText(p.output);
      e.text = text.length > TOOL_RESULT_MAX ? `${text.slice(0, TOOL_RESULT_MAX)}…` : text;
      const command = e.toolUseId ? state.pendingTests[e.toolUseId] : undefined;
      if (e.toolUseId && command !== undefined) {
        const { [e.toolUseId]: _done, ...rest } = state.pendingTests;
        state.pendingTests = rest;
        const r = parseTestOutput(command, text, e.ts);
        if (r) state.lastTest = r;
      }
      return [e];
    }
    default:
      return [];
  }
}

function onEventMsg(state: CodexAggState, env: CodexEnvelope): TimelineEvent[] {
  const p = env.payload;
  if (p.type === 'token_count') {
    const info = isObj(p.info) ? p.info : null;
    const total = info && isObj(info.total_token_usage) ? info.total_token_usage : null;
    if (total) {
      const cached = num(total.cached_input_tokens);
      state.usage = {
        input: Math.max(0, num(total.input_tokens) - cached),
        output: num(total.output_tokens),
        cacheRead: cached,
        cacheWrite: 0,
        costUsd: null,
      };
    }
    return [];
  }
  if (p.type === 'error') {
    state.apiErrorCount += 1;
    const e = newEvent(state, env, 'error');
    e.text = str(p.message) ?? 'error';
    return [e];
  }
  return [];
}

export function ingestCodexRecord(state: CodexAggState, value: unknown, resolve: ResolveDeriveConfig): TimelineEvent[] {
  const env = parseCodexEnvelope(value);
  if (!env) {
    state.unknownTypes['(invalid)'] = (state.unknownTypes['(invalid)'] ?? 0) + 1;
    return [];
  }
  if (!state.startedAt || env.timestamp < state.startedAt) state.startedAt = env.timestamp;
  if (!state.lastActivityAt || env.timestamp > state.lastActivityAt) state.lastActivityAt = env.timestamp;
  switch (env.type) {
    case 'session_meta': {
      const p = env.payload;
      state.sessionId = str(p.id) ?? str(p.session_id) ?? state.sessionId;
      state.originator = str(p.originator) ?? state.originator;
      const cwd = str(p.cwd);
      if (cwd) {
        if (!state.startCwd) state.startCwd = cwd;
        addUnique(state.cwds, [cwd]);
      }
      return [];
    }
    case 'turn_context': {
      const model = str(env.payload.model);
      if (model) addUnique(state.models, [model]);
      const cwd = str(env.payload.cwd);
      if (cwd) addUnique(state.cwds, [cwd]);
      return [];
    }
    case 'response_item':
      return onResponseItem(state, env, resolve(state.startCwd));
    case 'event_msg':
      return onEventMsg(state, env);
    case 'world_state':
    case 'compacted':
      return [];
    default:
      state.unknownTypes[env.type] = (state.unknownTypes[env.type] ?? 0) + 1;
      return [];
  }
}

export function codexStateToSession(
  state: CodexAggState,
  o: { projectId: string | null; transcriptPath: string | null; availability: Availability },
): Session | null {
  if (!state.sessionId || !state.startedAt) return null;
  return {
    id: state.sessionId,
    source: 'codex',
    projectId: o.projectId,
    startCwd: state.startCwd ?? '',
    cwds: [...state.cwds],
    name: deriveName({ agentName: null, customTitle: null, aiTitle: null, summary: null, firstPrompt: state.firstPrompt }),
    firstPrompt: state.firstPrompt,
    lastPrompt: state.lastPrompt,
    awaySummary: null,
    recap: null,
    startedAt: state.startedAt,
    lastActivityAt: state.lastActivityAt ?? state.startedAt,
    models: [...state.models],
    permissionMode: null,
    usage: { ...state.usage },
    linesAdded: null,
    linesRemoved: null,
    prs: [],
    tickets: [...state.tickets],
    skills: [...state.skills],
    mcpServers: [],
    filesTouched: [...state.filesTouched],
    promptCount: state.promptCount,
    toolCallCount: state.toolCallCount,
    apiErrorCount: state.apiErrorCount,
    flags: { touchedProd: state.touchedProd, hasSubagents: false, automated: state.originator === 'codex_sdk_ts' },
    availability: o.availability,
    transcriptPath: o.transcriptPath,
    lastTest: state.lastTest ? { ...state.lastTest } : null,
    live: null,
  };
}
```

Add to both `packages/core/src/index.ts` and `packages/core/src/browser.ts`:
```ts
export * from './codex/rollout.ts';
export * from './codex/codex-aggregate.ts';
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run packages/core`
Expected: PASS. If spike S5 recorded different payload shapes (e.g. new tool names), add them to `SHELL_TOOLS`/the switch with a test line and note it in the review.

- [ ] **Step 5: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add packages/core
git commit -m "feat(core): aggregate Codex rollouts, flag automated sessions"
```

---

### Task 5: API contract schemas and typed client

**Files:**
- Create: `packages/api-contract/src/domain.ts`, `packages/api-contract/src/live.ts`, `packages/api-contract/src/client.ts`
- Create: `packages/api-contract/src/routes/health.ts`, `routes/projects.ts`, `routes/sessions.ts`, `routes/views.ts`, `routes/pty.ts`
- Create: `packages/api-contract/src/routes/routes.test.ts`, `packages/api-contract/src/client.test.ts`
- Modify: `packages/api-contract/src/index.ts`

**Interfaces:**
- Consumes: `OrcConfig`, `ProjectConfig`, `ApiError` (Phase 0); `import type` of `Session`, `TimelineEvent`, `AgentNode`, `Project`, `LiveState`, `InboxItem`, `Usage`, `PrRef`, `TestResult` from `@orc/core`.
- Produces: all schemas and constants listed under "Contract additions → @orc/api-contract", plus:
  ```ts
  export type SessionListFilters = z.output<typeof SessionListQuerySchema>;
  export type SessionListItem = z.output<typeof SessionListItemSchema>;
  export type SessionListResponse = z.output<typeof SessionListResponseSchema>;
  export type SessionEventsResponse = z.output<typeof SessionEventsResponseSchema>;
  export type ResumeRequest = z.output<typeof ResumeRequestSchema>;
  export type ResumeResponse = z.output<typeof ResumeResponseSchema>;
  export type PtyInfo = z.output<typeof PtyInfoSchema>;
  export type PtyClientMessage = z.output<typeof PtyClientMessageSchema>;
  export type ProjectPatch = z.output<typeof ProjectPatchSchema>;
  export type LiveEvent = /* contracts §6 union */;
  export interface ApiClientOptions { baseUrl: string; token: string; fetch?: typeof fetch }
  export interface ApiClient {
    healthGet(): Promise<HealthResponse>;
    projectsList(): Promise<Project[]>;
    projectsUpdate(id: string, patch: ProjectPatch): Promise<ProjectConfig>;
    sessionsList(filters: SessionListFilters): Promise<SessionListResponse>;
    sessionsGet(source: Source, id: string): Promise<Session>;
    sessionsEvents(source: Source, id: string, opts?: { agentId?: string; afterSeq?: number; limit?: number }): Promise<SessionEventsResponse>;
    sessionsAgents(source: Source, id: string): Promise<AgentNode[]>;
    sessionsResume(source: Source, id: string, body: ResumeRequest): Promise<ResumeResponse>;
    sessionsPin(source: Source, id: string, pinned: boolean): Promise<{ pinned: boolean }>;
    sessionsLabel(source: Source, id: string, labels: string[]): Promise<{ labels: string[] }>;
    labelsList(): Promise<string[]>;
    viewsList(): Promise<SavedView[]>;
    viewsSave(body: { name: string; query: Record<string, string> }): Promise<SavedView>;
    viewsDelete(id: string): Promise<{ ok: true }>;
    ptyList(): Promise<PtyInfo[]>;
    ptyKill(ptyId: string): Promise<{ ok: true }>;          // sends { confirm: true }
  }
  export function createApiClient(o: ApiClientOptions): ApiClient
  ```
  Only `import type` from `@orc/core` (the web bundle must not pull `node:fs`).

- [ ] **Step 1: Write the failing tests**

`packages/api-contract/src/routes/routes.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { PtyClientMessageSchema } from './pty.ts';
import { ProjectPatchSchema } from './projects.ts';
import {
  LabelRequestSchema,
  ResumeRequestSchema,
  ResumeResponseSchema,
  SessionEventsQuerySchema,
  SessionListQuerySchema,
} from './sessions.ts';

describe('SessionListQuerySchema', () => {
  it('coerces URL query strings', () => {
    const q = SessionListQuerySchema.parse({
      q: 'weekend',
      projectId: 'wakecap',
      source: 'claude',
      minCost: '0.5',
      hasSubagents: 'true',
      touchedProd: 'false',
      limit: '25',
      availability: 'prompts-only',
      pinned: 'true',
    });
    expect(q).toEqual({
      q: 'weekend',
      projectId: 'wakecap',
      source: 'claude',
      minCost: 0.5,
      hasSubagents: true,
      touchedProd: false,
      limit: 25,
      availability: 'prompts-only',
      pinned: true,
    });
  });

  it('rejects bad values', () => {
    expect(SessionListQuerySchema.safeParse({ source: 'cursor' }).success).toBe(false);
    expect(SessionListQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(SessionListQuerySchema.safeParse({ hasSubagents: 'yes' }).success).toBe(false);
  });
});

describe('other request schemas', () => {
  it('parses events query', () => {
    expect(SessionEventsQuerySchema.parse({ afterSeq: '10', limit: '50', agentId: 'ag1' })).toEqual({
      afterSeq: 10,
      limit: 50,
      agentId: 'ag1',
    });
  });

  it('parses resume bodies and responses', () => {
    expect(ResumeRequestSchema.parse({ mode: 'embedded', fork: true })).toEqual({ mode: 'embedded', fork: true });
    expect(ResumeRequestSchema.safeParse({ mode: 'tmux' }).success).toBe(false);
    expect(ResumeResponseSchema.parse({ ptyId: 'p1' })).toEqual({ ptyId: 'p1' });
    expect(ResumeResponseSchema.parse({ launched: 'external', command: 'cd /x && claude' })).toEqual({
      launched: 'external',
      command: 'cd /x && claude',
    });
  });

  it('trims labels and caps their size', () => {
    expect(LabelRequestSchema.parse({ labels: [' later '] })).toEqual({ labels: ['later'] });
    expect(LabelRequestSchema.safeParse({ labels: [''] }).success).toBe(false);
  });

  it('keeps project patches free of defaults', () => {
    expect(ProjectPatchSchema.parse({ hidden: true })).toEqual({ hidden: true });
    expect(ProjectPatchSchema.safeParse({ id: 'other' }).success).toBe(false);
    expect(ProjectPatchSchema.safeParse({ pathPrefixes: ['relative'] }).success).toBe(false);
  });

  it('validates PTY client messages', () => {
    expect(PtyClientMessageSchema.parse({ t: 'in', d: 'ls\r' })).toEqual({ t: 'in', d: 'ls\r' });
    expect(PtyClientMessageSchema.parse({ t: 'resize', cols: 120, rows: 40 })).toEqual({ t: 'resize', cols: 120, rows: 40 });
    expect(PtyClientMessageSchema.safeParse({ t: 'resize', cols: 0, rows: 40 }).success).toBe(false);
    expect(PtyClientMessageSchema.safeParse({ t: 'say', text: 'x' }).success).toBe(false);
  });
});
```

`packages/api-contract/src/client.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { ApiRequestError, createApiClient, toQueryString } from './client.ts';

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  };
  return { fn, calls };
}

describe('toQueryString', () => {
  it('drops empty values', () => {
    expect(toQueryString({ a: 'x y', b: undefined, c: null, d: '', e: false, f: 3 })).toBe('?a=x+y&e=false&f=3');
    expect(toQueryString({})).toBe('');
  });
});

describe('createApiClient', () => {
  it('sends the token and parses responses', async () => {
    const { fn, calls } = fakeFetch(200, { items: [], nextCursor: null });
    const api = createApiClient({ baseUrl: 'http://127.0.0.1:4317', token: 'tok', fetch: fn });
    await expect(api.sessionsList({ q: 'hi', touchedProd: true })).resolves.toEqual({ items: [], nextCursor: null });
    expect(calls[0]?.url).toBe('http://127.0.0.1:4317/api/sessions?q=hi&touchedProd=true');
    expect(new Headers(calls[0]?.init?.headers).get('x-orc-token')).toBe('tok');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('encodes path segments and JSON bodies', async () => {
    const { fn, calls } = fakeFetch(200, { ptyId: 'p1' });
    const api = createApiClient({ baseUrl: '', token: 't', fetch: fn });
    await api.sessionsResume('claude', 'a/b', { mode: 'embedded' });
    expect(calls[0]?.url).toBe('/api/sessions/claude/a%2Fb/resume');
    expect(calls[0]?.init?.body).toBe('{"mode":"embedded"}');
    expect(new Headers(calls[0]?.init?.headers).get('content-type')).toBe('application/json');
  });

  it('turns error bodies into ApiRequestError', async () => {
    const { fn } = fakeFetch(409, { error: { code: 'session_live', message: 'already running', details: { ptyId: 'p9' } } });
    const api = createApiClient({ baseUrl: '', token: 't', fetch: fn });
    const err = await api.sessionsResume('claude', 's', { mode: 'embedded' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 409, code: 'session_live', details: { ptyId: 'p9' } });
  });

  it('reports non-JSON failures with a generic code', async () => {
    const fn: typeof fetch = async () => new Response('oops', { status: 502 });
    const api = createApiClient({ baseUrl: '', token: 't', fetch: fn });
    await expect(api.healthGet()).rejects.toMatchObject({ status: 502, code: 'http_error' });
  });

  it('sends confirm when killing a PTY', async () => {
    const { fn, calls } = fakeFetch(200, { ok: true });
    await createApiClient({ baseUrl: '', token: 't', fetch: fn }).ptyKill('p1');
    expect(calls[0]).toMatchObject({ url: '/api/pty/p1', init: { method: 'DELETE', body: '{"confirm":true}' } });
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run packages/api-contract`
Expected: FAIL, `Cannot find module './pty.ts'` / `'./client.ts'`

- [ ] **Step 3: Implement the schemas**

`packages/api-contract/src/domain.ts`
```ts
import type { AgentNode, LiveState, PrRef, Project, Session, TestResult, TimelineEvent, Usage } from '@orc/core';
import { z } from 'zod';

export const SourceSchema = z.enum(['claude', 'codex', 'agnc']);
export const AvailabilitySchema = z.enum(['resumable', 'archived', 'prompts-only', 'remote']);
export const LiveStatusSchema = z.enum(['busy', 'idle', 'waiting', 'shell', 'review', 'blocked', 'error', 'ended']);
export const EventKindSchema = z.enum(['prompt', 'assistant_text', 'thinking', 'tool_call', 'tool_result', 'system', 'error']);

export const UsageSchema: z.ZodType<Usage> = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  costUsd: z.number().nullable(),
});

export const PrRefSchema: z.ZodType<PrRef> = z.object({ repo: z.string(), number: z.number().int(), url: z.string() });

export const TestResultSchema: z.ZodType<TestResult> = z.object({
  ts: z.string(),
  command: z.string(),
  passed: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  durationMs: z.number().nullable(),
});

export const LiveStateSchema: z.ZodType<LiveState> = z.object({
  pid: z.number().int().nullable(),
  status: LiveStatusSchema,
  waitingFor: z.string().nullable(),
  since: z.string(),
  ownership: z.enum(['observed', 'owned']),
  ptyId: z.string().nullable(),
  stage: z.enum(['understand', 'modify', 'test', 'review']).nullable(),
  currentTool: z.string().nullable(),
  backgroundJobs: z.number().int(),
  runningSubagents: z.number().int(),
  contextFill: z.number().nullable(),
});

export const SessionSchema: z.ZodType<Session> = z.object({
  id: z.string(),
  source: SourceSchema,
  projectId: z.string().nullable(),
  startCwd: z.string(),
  cwds: z.array(z.string()),
  name: z.string().nullable(),
  firstPrompt: z.string().nullable(),
  lastPrompt: z.string().nullable(),
  awaySummary: z.string().nullable(),
  recap: z.string().nullable(),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  models: z.array(z.string()),
  permissionMode: z.string().nullable(),
  usage: UsageSchema,
  linesAdded: z.number().nullable(),
  linesRemoved: z.number().nullable(),
  prs: z.array(PrRefSchema),
  tickets: z.array(z.string()),
  skills: z.array(z.string()),
  mcpServers: z.array(z.string()),
  filesTouched: z.array(z.string()),
  promptCount: z.number().int(),
  toolCallCount: z.number().int(),
  apiErrorCount: z.number().int(),
  flags: z.object({ touchedProd: z.boolean(), hasSubagents: z.boolean(), automated: z.boolean() }),
  availability: AvailabilitySchema,
  transcriptPath: z.string().nullable(),
  lastTest: TestResultSchema.nullable(),
  live: LiveStateSchema.nullable(),
});

export const TimelineEventSchema: z.ZodType<TimelineEvent> = z.object({
  sessionId: z.string(),
  agentId: z.string().nullable(),
  uuid: z.string(),
  parentUuid: z.string().nullable(),
  seq: z.number().int(),
  ts: z.string(),
  kind: EventKindSchema,
  turn: z.number().int(),
  text: z.string().nullable(),
  tool: z.string().nullable(),
  toolUseId: z.string().nullable(),
  mcpServer: z.string().nullable(),
  input: z.unknown(),
  messageId: z.string().nullable(),
  model: z.string().nullable(),
  usage: UsageSchema.nullable(),
  durationMs: z.number().nullable(),
});

export const AgentNodeSchema: z.ZodType<AgentNode> = z.object({
  id: z.string(),
  sessionId: z.string(),
  parentId: z.string().nullable(),
  depth: z.number().int(),
  agentType: z.string(),
  description: z.string(),
  background: z.boolean(),
  toolUseId: z.string().nullable(),
  usage: UsageSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: z.enum(['running', 'done', 'error']),
  transcriptPath: z.string(),
});

export const ProjectSchema: z.ZodType<Project> = z.object({
  id: z.string(),
  name: z.string(),
  pathPrefixes: z.array(z.string()),
  hidden: z.boolean(),
  lastActivityAt: z.string().nullable(),
  sessionCount: z.number().int(),
});
```

`packages/api-contract/src/live.ts`
```ts
import type { InboxItem, Session } from '@orc/core';

/** contracts §6 — WS /ws live events (the socket itself ships in Phase 2). */
export type LiveEvent =
  | { type: 'session.updated'; session: Session }
  | { type: 'session.removed'; pk: string }
  | { type: 'inbox.upserted'; item: InboxItem }
  | { type: 'pty.exited'; ptyId: string; code: number | null }
  | { type: 'index.progress'; done: number; total: number }
  | { type: 'usage.updated'; snapshot: unknown }
  | { type: 'hello'; serverTime: string };
```

`packages/api-contract/src/routes/health.ts`
```ts
import { z } from 'zod';

export const HealthResponseSchema = z.object({ ok: z.boolean(), version: z.string(), uptimeS: z.number() });
export type HealthResponse = z.output<typeof HealthResponseSchema>;
```

`packages/api-contract/src/routes/projects.ts`
```ts
import { z } from 'zod';

/** PATCH /api/projects/:id. No defaults on purpose: absent keys must stay untouched. */
export const ProjectPatchSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  pathPrefixes: z.array(z.string().startsWith('/')).min(1).optional(),
  hidden: z.boolean().optional(),
  openIn: z.enum(['vscode', 'terminal', 'finder']).optional(),
  ticketRegex: z.string().nullable().optional(),
  prodPatterns: z.array(z.string()).optional(),
  features: z
    .object({ workStreams: z.boolean(), prodBadges: z.boolean(), recaps: z.boolean() })
    .partial()
    .optional(),
});
export type ProjectPatch = z.output<typeof ProjectPatchSchema>;
```

`packages/api-contract/src/routes/sessions.ts`
```ts
import { z } from 'zod';
import {
  AvailabilitySchema,
  LiveStateSchema,
  PrRefSchema,
  SourceSchema,
  TimelineEventSchema,
} from '../domain.ts';

export const SNIPPET_OPEN = '⟦';
export const SNIPPET_CLOSE = '⟧';
export const HIDDEN_LABEL = 'hidden';
export const ALL_PROJECTS = 'all';

const boolParam = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');

export const SessionListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  projectId: z.string().optional(),
  source: SourceSchema.optional(),
  ticket: z.string().optional(),
  pr: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  model: z.string().optional(),
  minCost: z.coerce.number().min(0).optional(),
  maxCost: z.coerce.number().min(0).optional(),
  skill: z.string().optional(),
  hasSubagents: boolParam.optional(),
  touchedProd: boolParam.optional(),
  availability: AvailabilitySchema.optional(),
  label: z.string().optional(),
  pinned: boolParam.optional(),
  includeHidden: boolParam.optional(),
  includeAutomated: boolParam.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});
export type SessionListFilters = z.output<typeof SessionListQuerySchema>;

export const SessionListItemSchema = z.object({
  pk: z.string(),
  source: SourceSchema,
  id: z.string(),
  projectId: z.string().nullable(),
  name: z.string().nullable(),
  firstPrompt: z.string().nullable(),
  lastPrompt: z.string().nullable(),
  recap: z.string().nullable(),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  durationMs: z.number(),
  costUsd: z.number().nullable(),
  tickets: z.array(z.string()),
  prs: z.array(PrRefSchema),
  availability: AvailabilitySchema,
  pinned: z.boolean(),
  labels: z.array(z.string()),
  live: LiveStateSchema.nullable(),
  snippet: z.string().nullable(),
});
export type SessionListItem = z.output<typeof SessionListItemSchema>;

export const SessionListResponseSchema = z.object({
  items: z.array(SessionListItemSchema),
  nextCursor: z.string().nullable(),
});
export type SessionListResponse = z.output<typeof SessionListResponseSchema>;

export const SessionEventsQuerySchema = z.object({
  agentId: z.string().optional(),
  afterSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const SessionEventsResponseSchema = z.object({
  items: z.array(TimelineEventSchema),
  nextSeq: z.number().int().nullable(),
});
export type SessionEventsResponse = z.output<typeof SessionEventsResponseSchema>;

export const ResumeRequestSchema = z.object({
  mode: z.enum(['embedded', 'external']),
  fork: z.boolean().optional(),
  popOut: z.boolean().optional(),
  cols: z.number().int().min(20).max(500).optional(),
  rows: z.number().int().min(5).max(300).optional(),
});
export type ResumeRequest = z.output<typeof ResumeRequestSchema>;

export const ResumeResponseSchema = z.union([
  z.object({ ptyId: z.string() }),
  z.object({ launched: z.literal('external'), command: z.string() }),
]);
export type ResumeResponse = z.output<typeof ResumeResponseSchema>;

export const PinRequestSchema = z.object({ pinned: z.boolean() });
export const PinResponseSchema = PinRequestSchema;
export const LabelRequestSchema = z.object({ labels: z.array(z.string().trim().min(1).max(40)).max(20) });
export const LabelResponseSchema = z.object({ labels: z.array(z.string()) });
export const LabelsListSchema = z.array(z.string());
export const OkSchema = z.object({ ok: z.literal(true) });
```

`packages/api-contract/src/routes/views.ts`
```ts
import { z } from 'zod';

export const SavedViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  query: z.record(z.string(), z.string()),
  createdAt: z.string(),
});
export type SavedView = z.output<typeof SavedViewSchema>;

export const SaveViewRequestSchema = z.object({
  name: z.string().trim().min(1).max(60),
  query: z.record(z.string(), z.string()),
});
```

`packages/api-contract/src/routes/pty.ts`
```ts
import { z } from 'zod';

export const PtyInfoSchema = z.object({
  id: z.string(),
  sessionPk: z.string().nullable(),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  pid: z.number().int(),
  startedAt: z.string(),
  exitedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  cols: z.number().int(),
  rows: z.number().int(),
});
export type PtyInfo = z.output<typeof PtyInfoSchema>;

export const PtyClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('in'), d: z.string().max(65_536) }),
  z.object({ t: z.literal('resize'), cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(300) }),
]);
export type PtyClientMessage = z.output<typeof PtyClientMessageSchema>;

export const PtyServerControlSchema = z.object({ t: z.literal('exit'), code: z.number().int().nullable() });
export type PtyServerControl = z.output<typeof PtyServerControlSchema>;
```

- [ ] **Step 4: Implement the client**

`packages/api-contract/src/client.ts`
```ts
import type { AgentNode, Project, Session, Source } from '@orc/core';
import { z } from 'zod';
import { ProjectConfig } from './config.ts';
import { AgentNodeSchema, ProjectSchema, SessionSchema } from './domain.ts';
import { ApiError } from './errors.ts';
import { type HealthResponse, HealthResponseSchema } from './routes/health.ts';
import type { ProjectPatch } from './routes/projects.ts';
import { type PtyInfo, PtyInfoSchema } from './routes/pty.ts';
import {
  LabelResponseSchema,
  LabelsListSchema,
  OkSchema,
  PinResponseSchema,
  type ResumeRequest,
  type ResumeResponse,
  ResumeResponseSchema,
  type SessionEventsResponse,
  SessionEventsResponseSchema,
  type SessionListFilters,
  type SessionListResponse,
  SessionListResponseSchema,
} from './routes/sessions.ts';
import { type SavedView, SavedViewSchema } from './routes/views.ts';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export interface ApiClient {
  healthGet(): Promise<HealthResponse>;
  projectsList(): Promise<Project[]>;
  projectsUpdate(id: string, patch: ProjectPatch): Promise<ProjectConfig>;
  sessionsList(filters: SessionListFilters): Promise<SessionListResponse>;
  sessionsGet(source: Source, id: string): Promise<Session>;
  sessionsEvents(
    source: Source,
    id: string,
    opts?: { agentId?: string; afterSeq?: number; limit?: number },
  ): Promise<SessionEventsResponse>;
  sessionsAgents(source: Source, id: string): Promise<AgentNode[]>;
  sessionsResume(source: Source, id: string, body: ResumeRequest): Promise<ResumeResponse>;
  sessionsPin(source: Source, id: string, pinned: boolean): Promise<{ pinned: boolean }>;
  sessionsLabel(source: Source, id: string, labels: string[]): Promise<{ labels: string[] }>;
  labelsList(): Promise<string[]>;
  viewsList(): Promise<SavedView[]>;
  viewsSave(body: { name: string; query: Record<string, string> }): Promise<SavedView>;
  viewsDelete(id: string): Promise<{ ok: true }>;
  ptyList(): Promise<PtyInfo[]>;
  ptyKill(ptyId: string): Promise<{ ok: true }>;
}

export function toQueryString(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function createApiClient(o: ApiClientOptions): ApiClient {
  const doFetch: typeof fetch = o.fetch ?? ((input, init) => fetch(input, init));

  async function call<T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'x-orc-token': o.token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await doFetch(`${o.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const parsed = ApiError.safeParse(json);
      if (parsed.success) {
        const e = parsed.data.error;
        throw new ApiRequestError(res.status, e.code, e.message, e.details);
      }
      throw new ApiRequestError(res.status, 'http_error', `HTTP ${res.status}`);
    }
    return schema.parse(json);
  }

  const seg = (source: Source, id: string) => `/api/sessions/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;

  return {
    healthGet: () => call(HealthResponseSchema, 'GET', '/api/health'),
    projectsList: () => call(z.array(ProjectSchema), 'GET', '/api/projects'),
    projectsUpdate: (id, patch) => call(ProjectConfig, 'PATCH', `/api/projects/${encodeURIComponent(id)}`, patch),
    sessionsList: (filters) => call(SessionListResponseSchema, 'GET', `/api/sessions${toQueryString(filters)}`),
    sessionsGet: (source, id) => call(SessionSchema, 'GET', seg(source, id)),
    sessionsEvents: (source, id, opts = {}) =>
      call(SessionEventsResponseSchema, 'GET', `${seg(source, id)}/events${toQueryString(opts)}`),
    sessionsAgents: (source, id) => call(z.array(AgentNodeSchema), 'GET', `${seg(source, id)}/agents`),
    sessionsResume: (source, id, body) => call(ResumeResponseSchema, 'POST', `${seg(source, id)}/resume`, body),
    sessionsPin: (source, id, pinned) => call(PinResponseSchema, 'POST', `${seg(source, id)}/pin`, { pinned }),
    sessionsLabel: (source, id, labels) => call(LabelResponseSchema, 'POST', `${seg(source, id)}/label`, { labels }),
    labelsList: () => call(LabelsListSchema, 'GET', '/api/labels'),
    viewsList: () => call(z.array(SavedViewSchema), 'GET', '/api/views'),
    viewsSave: (body) => call(SavedViewSchema, 'POST', '/api/views', body),
    viewsDelete: (id) => call(OkSchema, 'DELETE', `/api/views/${encodeURIComponent(id)}`),
    ptyList: () => call(z.array(PtyInfoSchema), 'GET', '/api/pty'),
    ptyKill: (ptyId) => call(OkSchema, 'DELETE', `/api/pty/${encodeURIComponent(ptyId)}`, { confirm: true }),
  };
}
```

`packages/api-contract/src/index.ts`
```ts
export * from './config.ts';
export * from './errors.ts';
export * from './domain.ts';
export * from './live.ts';
export * from './client.ts';
export * from './routes/health.ts';
export * from './routes/projects.ts';
export * from './routes/sessions.ts';
export * from './routes/views.ts';
export * from './routes/pty.ts';
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run packages/api-contract`
Expected: PASS (config, routes and client suites). If `z.ZodType<Session>` annotations fail typecheck because zod infers `input?: unknown`, change `input: z.unknown()` to `input: z.custom<unknown>(() => true)` and re-run `pnpm typecheck`.

- [ ] **Step 6: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add packages/api-contract
git commit -m "feat(api-contract): add phase 1 route schemas and typed API client"
```

---

### Task 6: Daemon config, SQLite schema and migrations

**Files:**
- Create: `apps/daemon/src/config.ts`, `apps/daemon/src/config.test.ts`
- Create: `apps/daemon/drizzle.config.ts`, `apps/daemon/src/db/schema.ts`, `apps/daemon/src/db/client.ts`, `apps/daemon/src/db/keys.ts`, `apps/daemon/src/db/client.test.ts`
- Create (generated): `apps/daemon/src/db/migrations/0000_init.sql`, `0001_events_fts.sql`, `meta/*`
- Create: `apps/daemon/test/homes.ts`, `apps/daemon/test/helpers.ts`, `apps/daemon/test/bin/claude`
- Modify: `apps/daemon/package.json`, `apps/daemon/vitest.config.ts`

**Interfaces:**
- Consumes: `OrcConfig` (Phase 0), `Source` (core).
- Produces:
  ```ts
  // config.ts
  export interface OrcPaths { orcHome; claudeHome; codexHome; dbFile; tokenFile; archiveDir; logFile; userHome }   // all string
  export function resolvePaths(env?: NodeJS.ProcessEnv): OrcPaths
  export function loadConfig(paths: OrcPaths): OrcConfig
  export function saveConfig(paths: OrcPaths, cfg: OrcConfig): void
  export function ensureToken(paths: OrcPaths): string
  // db/client.ts
  export type OrcDb = BetterSQLite3Database<typeof schema>;
  export const MIGRATIONS_DIR: string;
  export function openDb(file: string, opts?: { migrationsFolder?: string }): { db: OrcDb; raw: Database.Database; close(): void }
  // db/keys.ts
  export const sessionPk: (source: Source, id: string) => string;
  export function splitPk(pk: string): { source: Source; id: string }
  // db/schema.ts — tables: projects, sessions, events, agents, fileOffsets, historyPrompts, labels, pins, savedViews, ptySessions
  // test/homes.ts
  export const FIXTURES_DIR: string; export const FAKE_BIN_DIR: string; export const FAKE_CLAUDE: string;
  export interface TempHomes { root: string; orcHome: string; claudeHome: string; codexHome: string; userHome: string; paths: OrcPaths; env: Record<string, string>; cleanup(): void }
  export function makeTempHomes(): TempHomes
  export function writeClaudeSession(h: TempHomes, o: { sessionId: string; cwd: string; prompt: string; timestamp?: string }): string
  // test/helpers.ts
  export function useTempHomes(): TempHomes      // fresh copy per test (beforeEach/afterEach)
  ```

- [ ] **Step 1: Add dependencies and test config**

Run:
```bash
pnpm --filter @orc/daemon add better-sqlite3@^13.0.3 drizzle-orm@^0.45.2 zod@^4.6.5 pino@^10.3.1
pnpm --filter @orc/daemon add -D drizzle-kit@^0.31.10 @types/better-sqlite3 @types/node@^22.10.0
```

`apps/daemon/package.json` — set `scripts` to:
```json
"scripts": {
  "dev": "ORC_DEV=1 tsx watch src/main.ts",
  "build": "tsup src/main.ts --format esm --platform node --target node22 --out-dir dist && rm -rf dist/migrations && cp -R src/db/migrations dist/migrations",
  "start": "node dist/main.js",
  "typecheck": "tsc -p tsconfig.json",
  "db:generate": "drizzle-kit generate",
  "perf": "vitest run --config vitest.perf.config.ts"
}
```

`apps/daemon/vitest.config.ts`
```ts
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'daemon',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // node-pty and better-sqlite3 are native addons: run test files in child processes.
    pool: 'forks',
    testTimeout: 20_000,
  },
});
```

`apps/daemon/drizzle.config.ts`
```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
});
```

`apps/daemon/test/bin/claude` (then `chmod +x apps/daemon/test/bin/claude`)
```sh
#!/bin/sh
# Fake `claude` for tests: prints its arguments and cwd, then echoes stdin until killed.
echo "fake-claude $*"
echo "cwd=$(pwd -P)"
exec cat
```

- [ ] **Step 2: Write the failing config and DB tests**

`apps/daemon/src/config.test.ts`
```ts
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { describe, expect, it } from 'vitest';
import { ensureToken, loadConfig, resolvePaths, saveConfig } from './config.ts';

describe('resolvePaths', () => {
  it('uses defaults under the home directory', () => {
    const p = resolvePaths({});
    expect(p.orcHome).toBe(join(homedir(), '.orchestrator'));
    expect(p.claudeHome).toBe(join(homedir(), '.claude'));
    expect(p.codexHome).toBe(join(homedir(), '.codex'));
    expect(p.dbFile).toBe(join(homedir(), '.orchestrator', 'index.db'));
    expect(p.userHome).toBe(homedir());
  });

  it('honours env overrides and ~ expansion', () => {
    const p = resolvePaths({ ORC_HOME: '~/x', CLAUDE_HOME: '/c', CODEX_HOME: '/d', ORC_USER_HOME: '/Users/test' });
    expect(p).toMatchObject({
      orcHome: join(homedir(), 'x'),
      claudeHome: '/c',
      codexHome: '/d',
      tokenFile: join(homedir(), 'x', 'token'),
      archiveDir: join(homedir(), 'x', 'archive'),
      logFile: join(homedir(), 'x', 'logs', 'daemon.log'),
      userHome: '/Users/test',
    });
  });
});

describe('config and token files', () => {
  const paths = () => resolvePaths({ ORC_HOME: mkdtempSync(join(tmpdir(), 'orc-cfg-')) });

  it('creates a default config on first load and round-trips saves', () => {
    const p = paths();
    const cfg = loadConfig(p);
    expect(cfg).toEqual(OrcConfig.parse({}));
    expect(existsSync(join(p.orcHome, 'config.json'))).toBe(true);
    saveConfig(p, { ...cfg, port: 5000 });
    expect(loadConfig(p).port).toBe(5000);
    expect(statSync(join(p.orcHome, 'config.json')).mode & 0o777).toBe(0o600);
  });

  it('rejects an invalid config file', () => {
    const p = paths();
    saveConfig(p, OrcConfig.parse({}));
    const file = join(p.orcHome, 'config.json');
    const bad = readFileSync(file, 'utf8').replace('"port": 4317', '"port": "nope"');
    writeFileSync(file, bad);
    expect(() => loadConfig(p)).toThrow();
  });

  it('creates a 0600 token once', () => {
    const p = paths();
    const t1 = ensureToken(p);
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(p.tokenFile).mode & 0o777).toBe(0o600);
    expect(ensureToken(p)).toBe(t1);
  });
});
```

`apps/daemon/src/db/client.test.ts`
```ts
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from './client.ts';
import { sessionPk, splitPk } from './keys.ts';

describe('openDb', () => {
  it('migrates, sets pragmas and chmods the file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'orc-db-')), 'index.db');
    const { raw, close } = openDb(file);
    const tables = (raw.prepare("select name from sqlite_master where type in ('table') order by name").all() as {
      name: string;
    }[]).map((t) => t.name);
    for (const t of ['agents', 'events', 'events_fts', 'file_offsets', 'history_prompts', 'labels', 'pins', 'projects', 'pty_sessions', 'saved_views', 'sessions']) {
      expect(tables).toContain(t);
    }
    expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(raw.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    close();
    // re-open is idempotent
    openDb(file).close();
  });

  it('indexes prompt text in FTS but not tool results', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'orc-db-')), 'index.db');
    const { raw, close } = openDb(file);
    const ins = raw.prepare(
      "insert into events (session_pk, agent_id, seq, uuid, ts, kind, turn, text, search_input) values ('claude:s', '', ?, ?, 't', ?, 1, ?, ?)",
    );
    ins.run(1, 'u1', 'prompt', 'fix the weekend deadline', null);
    ins.run(2, 'u2', 'tool_result', 'weekend output', null);
    ins.run(3, 'u3', 'tool_call', null, 'pnpm vitest run');
    const hits = (q: string) =>
      (raw.prepare('select rowid from events_fts where events_fts match ? order by rowid').all(q) as { rowid: number }[]).length;
    expect(hits('weekend')).toBe(1);
    expect(hits('vitest')).toBe(1);
    raw.prepare("delete from events where uuid = 'u1'").run();
    expect(hits('weekend')).toBe(0);
    raw.prepare("update events set search_input = 'pnpm jest' where uuid = 'u3'").run();
    expect(hits('vitest')).toBe(0);
    expect(hits('jest')).toBe(1);
    close();
  });
});

describe('keys', () => {
  it('builds and splits session pks', () => {
    expect(sessionPk('claude', 'a:b')).toBe('claude:a:b');
    expect(splitPk('codex:c0dex')).toEqual({ source: 'codex', id: 'c0dex' });
    expect(() => splitPk('nope')).toThrow();
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/config apps/daemon/src/db`
Expected: FAIL, `Cannot find module './config.ts'` / `'./client.ts'`

- [ ] **Step 4: Implement config and keys**

`apps/daemon/src/config.ts`
```ts
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';

export interface OrcPaths {
  orcHome: string;
  claudeHome: string;
  codexHome: string;
  dbFile: string;
  tokenFile: string;
  archiveDir: string;
  logFile: string;
  userHome: string;
}

function expand(p: string): string {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): OrcPaths {
  const orcHome = expand(env.ORC_HOME ?? join(homedir(), '.orchestrator'));
  return {
    orcHome,
    claudeHome: expand(env.CLAUDE_HOME ?? join(homedir(), '.claude')),
    codexHome: expand(env.CODEX_HOME ?? join(homedir(), '.codex')),
    dbFile: join(orcHome, 'index.db'),
    tokenFile: join(orcHome, 'token'),
    archiveDir: join(orcHome, 'archive'),
    logFile: join(orcHome, 'logs', 'daemon.log'),
    userHome: expand(env.ORC_USER_HOME ?? homedir()),
  };
}

function writePrivate(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const configFile = (paths: OrcPaths) => join(paths.orcHome, 'config.json');

export function loadConfig(paths: OrcPaths): OrcConfig {
  const file = configFile(paths);
  if (!existsSync(file)) {
    const cfg = OrcConfig.parse({});
    saveConfig(paths, cfg);
    return cfg;
  }
  return OrcConfig.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function saveConfig(paths: OrcPaths, cfg: OrcConfig): void {
  writePrivate(configFile(paths), `${JSON.stringify(OrcConfig.parse(cfg), null, 2)}\n`);
}

export function ensureToken(paths: OrcPaths): string {
  if (existsSync(paths.tokenFile)) {
    chmodSync(paths.tokenFile, 0o600);
    return readFileSync(paths.tokenFile, 'utf8').trim();
  }
  const token = randomBytes(32).toString('hex');
  writePrivate(paths.tokenFile, token);
  return token;
}
```

`apps/daemon/src/db/keys.ts`
```ts
import type { Source } from '@orc/core';

const SOURCES: readonly Source[] = ['claude', 'codex', 'agnc'];

export const sessionPk = (source: Source, id: string): string => `${source}:${id}`;

export function splitPk(pk: string): { source: Source; id: string } {
  const i = pk.indexOf(':');
  const source = pk.slice(0, i) as Source;
  if (i <= 0 || !SOURCES.includes(source)) throw new Error(`invalid session pk: ${pk}`);
  return { source, id: pk.slice(i + 1) };
}
```

- [ ] **Step 5: Implement the schema and client**

`apps/daemon/src/db/schema.ts`
```ts
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Mirror of config projects (the config file is the source of truth). */
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  pathPrefixesJson: text('path_prefixes_json').notNull(),
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    pk: text('pk').primaryKey(),
    source: text('source').notNull(),
    id: text('id').notNull(),
    projectId: text('project_id'),
    startCwd: text('start_cwd').notNull(),
    name: text('name'),
    firstPrompt: text('first_prompt'),
    lastPrompt: text('last_prompt'),
    recap: text('recap'),
    startedAt: text('started_at').notNull(),
    lastActivityAt: text('last_activity_at').notNull(),
    costUsd: real('cost_usd'),
    modelsJson: text('models_json').notNull().default('[]'),
    ticketsJson: text('tickets_json').notNull().default('[]'),
    prsJson: text('prs_json').notNull().default('[]'),
    skillsJson: text('skills_json').notNull().default('[]'),
    availability: text('availability').notNull(),
    hasSubagents: integer('has_subagents', { mode: 'boolean' }).notNull().default(false),
    touchedProd: integer('touched_prod', { mode: 'boolean' }).notNull().default(false),
    automated: integer('automated', { mode: 'boolean' }).notNull().default(false),
    transcriptPath: text('transcript_path'),
    origin: text('origin').notNull().default('transcript'),
    dataJson: text('data_json').notNull(),
    indexedAt: text('indexed_at').notNull(),
  },
  (t) => [
    uniqueIndex('sessions_source_id').on(t.source, t.id),
    index('sessions_activity').on(t.lastActivityAt),
    index('sessions_project_activity').on(t.projectId, t.lastActivityAt),
  ],
);

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionPk: text('session_pk').notNull(),
    agentId: text('agent_id').notNull().default(''),
    seq: integer('seq').notNull(),
    uuid: text('uuid').notNull(),
    parentUuid: text('parent_uuid'),
    ts: text('ts').notNull(),
    kind: text('kind').notNull(),
    turn: integer('turn').notNull(),
    text: text('text'),
    tool: text('tool'),
    toolUseId: text('tool_use_id'),
    mcpServer: text('mcp_server'),
    inputJson: text('input_json'),
    searchInput: text('search_input'),
    messageId: text('message_id'),
    model: text('model'),
    usageJson: text('usage_json'),
    durationMs: integer('duration_ms'),
  },
  (t) => [
    uniqueIndex('events_session_agent_seq').on(t.sessionPk, t.agentId, t.seq),
    index('events_session_turn').on(t.sessionPk, t.turn),
  ],
);

export const agents = sqliteTable(
  'agents',
  {
    sessionPk: text('session_pk').notNull(),
    id: text('id').notNull(),
    parentId: text('parent_id'),
    depth: integer('depth').notNull(),
    agentType: text('agent_type').notNull(),
    description: text('description').notNull(),
    background: integer('background', { mode: 'boolean' }).notNull().default(false),
    toolUseId: text('tool_use_id'),
    usageJson: text('usage_json').notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    status: text('status').notNull(),
    transcriptPath: text('transcript_path').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionPk, t.id] })],
);

export const fileOffsets = sqliteTable('file_offsets', {
  path: text('path').primaryKey(),
  kind: text('kind').notNull(),
  sessionPk: text('session_pk'),
  agentId: text('agent_id'),
  size: integer('size').notNull(),
  mtimeMs: integer('mtime_ms').notNull(),
  offset: integer('offset').notNull(),
  stateJson: text('state_json'),
  updatedAt: text('updated_at').notNull(),
});

export const historyPrompts = sqliteTable(
  'history_prompts',
  {
    sessionId: text('session_id').notNull(),
    ts: text('ts').notNull(),
    display: text('display').notNull(),
    project: text('project').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.ts] })],
);

export const labels = sqliteTable(
  'labels',
  {
    sessionPk: text('session_pk').notNull(),
    label: text('label').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionPk, t.label] }), index('labels_label').on(t.label)],
);

export const pins = sqliteTable('pins', {
  sessionPk: text('session_pk').primaryKey(),
  createdAt: text('created_at').notNull(),
});

export const savedViews = sqliteTable('saved_views', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  queryJson: text('query_json').notNull(),
  createdAt: text('created_at').notNull(),
});

export const ptySessions = sqliteTable('pty_sessions', {
  id: text('id').primaryKey(),
  sessionPk: text('session_pk'),
  command: text('command').notNull(),
  argsJson: text('args_json').notNull(),
  cwd: text('cwd').notNull(),
  pid: integer('pid').notNull(),
  startedAt: text('started_at').notNull(),
  exitedAt: text('exited_at'),
  exitCode: integer('exit_code'),
});
```

`apps/daemon/src/db/client.ts`
```ts
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.ts';

export type OrcDb = BetterSQLite3Database<typeof schema>;

/** src/db/migrations in dev/tests; dist/migrations in the bundle (the build script copies it). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

export function openDb(
  file: string,
  opts: { migrationsFolder?: string } = {},
): { db: OrcDb; raw: Database.Database; close(): void } {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const raw = new Database(file);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  if (file !== ':memory:') chmodSync(file, 0o600);
  const db = drizzle({ client: raw, schema });
  migrate(db, { migrationsFolder: opts.migrationsFolder ?? MIGRATIONS_DIR });
  return { db, raw, close: () => raw.close() };
}
```
(`new URL('./migrations', import.meta.url)` resolves next to `client.ts` in dev. tsup bundles into `dist/main.js`, where the same expression resolves to `dist/migrations` — which the build script creates.)

- [ ] **Step 6: Generate the migrations**

Run:
```bash
pnpm --filter @orc/daemon db:generate --name init
pnpm --filter @orc/daemon db:generate --custom --name events_fts
```
Expected: `apps/daemon/src/db/migrations/0000_init.sql`, an empty `0001_events_fts.sql` and `meta/_journal.json`.

Write `apps/daemon/src/db/migrations/0001_events_fts.sql` (drizzle-kit does not model virtual tables or triggers):
```sql
CREATE VIRTUAL TABLE `events_fts` USING fts5(`text`, `search_input`, content='events', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER `events_fts_ai` AFTER INSERT ON `events` WHEN new.kind NOT IN ('tool_result', 'thinking') BEGIN
  INSERT INTO events_fts(rowid, text, search_input) VALUES (new.id, new.text, new.search_input);
END;
--> statement-breakpoint
CREATE TRIGGER `events_fts_ad` AFTER DELETE ON `events` WHEN old.kind NOT IN ('tool_result', 'thinking') BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, search_input) VALUES ('delete', old.id, old.text, old.search_input);
END;
--> statement-breakpoint
CREATE TRIGGER `events_fts_au` AFTER UPDATE OF text, search_input ON `events` WHEN old.kind NOT IN ('tool_result', 'thinking') BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, search_input) VALUES ('delete', old.id, old.text, old.search_input);
  INSERT INTO events_fts(rowid, text, search_input) VALUES (new.id, new.text, new.search_input);
END;
```

- [ ] **Step 7: Create the shared test homes and helpers**

`apps/daemon/test/homes.ts` (no `vitest` import: also used by the e2e server)
```ts
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type OrcPaths, resolvePaths } from '../src/config.ts';

export const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
export const FAKE_BIN_DIR = fileURLToPath(new URL('./bin/', import.meta.url));
export const FAKE_CLAUDE = join(FAKE_BIN_DIR, 'claude');
export const FIXTURE_USER_HOME = '/Users/test';

export interface TempHomes {
  root: string;
  orcHome: string;
  claudeHome: string;
  codexHome: string;
  userHome: string;
  paths: OrcPaths;
  env: Record<string, string>;
  cleanup(): void;
}

export function makeTempHomes(): TempHomes {
  const root = mkdtempSync(join(tmpdir(), 'orc-test-'));
  const orcHome = join(root, 'orc');
  const claudeHome = join(root, 'claude');
  const codexHome = join(root, 'codex');
  cpSync(join(FIXTURES_DIR, 'claude-home'), claudeHome, { recursive: true });
  cpSync(join(FIXTURES_DIR, 'codex-home'), codexHome, { recursive: true });
  mkdirSync(orcHome, { recursive: true });
  const env = { ORC_HOME: orcHome, CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome, ORC_USER_HOME: FIXTURE_USER_HOME };
  return {
    root,
    orcHome,
    claudeHome,
    codexHome,
    userHome: FIXTURE_USER_HOME,
    paths: resolvePaths(env),
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Writes a minimal resumable transcript whose cwd exists on disk (fixture cwds do not). */
export function writeClaudeSession(
  h: TempHomes,
  o: { sessionId: string; cwd: string; prompt: string; timestamp?: string },
): string {
  mkdirSync(o.cwd, { recursive: true });
  const dir = join(h.claudeHome, 'projects', o.cwd.replace(/[/._ ]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${o.sessionId}.jsonl`);
  const rec = {
    type: 'user',
    uuid: `${o.sessionId}-u1`,
    parentUuid: null,
    isSidechain: false,
    sessionId: o.sessionId,
    timestamp: o.timestamp ?? new Date().toISOString(),
    cwd: o.cwd,
    message: { role: 'user', content: o.prompt },
  };
  writeFileSync(file, `${JSON.stringify(rec)}\n`);
  return file;
}
```

`apps/daemon/test/helpers.ts`
```ts
import { afterEach, beforeEach } from 'vitest';
import { makeTempHomes, type TempHomes } from './homes.ts';

export * from './homes.ts';

/** Fresh temp copies of the fixture homes for every test in the calling `describe`. */
export function useTempHomes(): TempHomes {
  const holder = {} as TempHomes;
  beforeEach(() => {
    Object.assign(holder, makeTempHomes());
  });
  afterEach(() => {
    holder.cleanup();
  });
  return holder;
}
```

- [ ] **Step 8: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon`
Expected: PASS (config, db client, keys; the Phase 0 health test still passes).

- [ ] **Step 9: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(daemon): add config, token file, SQLite schema with FTS5 and test homes"
```

---

### Task 7: Repositories and FTS search

**Files:**
- Create: `apps/daemon/src/db/fts.ts`
- Create: `apps/daemon/src/db/repos/sessions.ts`, `events.ts`, `agents.ts`, `file-offsets.ts`, `history.ts`, `projects.ts`, `user-meta.ts`, `pty-sessions.ts`
- Create: `apps/daemon/test/factories.ts`, `apps/daemon/src/db/repos/repos.test.ts`, `apps/daemon/src/db/fts.test.ts`

**Interfaces:**
- Consumes: `OrcDb`, `openDb`, schema tables, `sessionPk`, `splitPk` (Task 6); `Session`, `TimelineEvent`, `AgentNode`, `HistoryPrompt`, `Availability`, `Source` (core); `HIDDEN_LABEL`, `SNIPPET_OPEN`, `SNIPPET_CLOSE`, `SavedView` (api-contract).
- Produces (every function takes `db: OrcDb` first; routes never call these directly):
  ```ts
  // db/fts.ts
  export function toFtsQuery(input: string): string | null
  export function escapeLike(input: string): string                  // for LIKE ... ESCAPE '\'
  // repos/sessions.ts
  export type SessionRow = typeof sessions.$inferSelect;
  export type SessionOrigin = 'transcript' | 'history';
  export interface SessionQueryFilter { pks?: string[] | null; projectId?: string; source?: Source; ticket?: string; pr?: string; from?: string; to?: string; model?: string; minCost?: number; maxCost?: number; skill?: string; hasSubagents?: boolean; touchedProd?: boolean; availability?: Availability; label?: string; pinned?: boolean; includeHidden?: boolean; includeAutomated?: boolean; limit: number; cursor?: { lastActivityAt: string; pk: string } | null }
  export function upsertSession(db, s: Session, origin?: SessionOrigin): void      // never overwrites `recap`
  export function rowToSession(row: SessionRow): Session                           // live = null
  export function getSessionByPk(db, pk: string): Session | null
  export function getSessionOrigin(db, pk: string): SessionOrigin | null
  export function setSessionProject(db, pk: string, projectId: string | null): void
  export function markHasSubagents(db, pk: string): void
  export function setSessionAvailability(db, pk: string, availability: Availability, transcriptPath: string | null): void
  export function listSessionCwds(db): Array<{ pk: string; startCwd: string; lastActivityAt: string; projectId: string | null }>
  export function projectStats(db): Array<{ projectId: string; sessionCount: number; lastActivityAt: string | null }>
  export function countSessions(db): number
  export function querySessions(db, f: SessionQueryFilter): SessionRow[]          // ordered last_activity_at DESC, pk DESC
  export function searchSessionText(db, like: string): string[]                   // pks whose name/first/last prompt match
  // repos/events.ts
  export function searchableInput(e: TimelineEvent): string | null
  export function insertEvents(db, sessionPk: string, list: TimelineEvent[]): void // ignores duplicates (pk, agent, seq)
  export function deleteEventsFor(db, sessionPk: string, agentId: string | null): void
  export function listEvents(db, sessionPk: string, o: { agentId?: string | null; afterSeq?: number; limit?: number }): { items: TimelineEvent[]; nextSeq: number | null }
  export function countEvents(db, sessionPk: string): number
  export function searchEventSessions(db, match: string): Map<string, number>       // pk → representative events.id
  export function eventSnippet(db, match: string, rowid: number): string | null
  // repos/agents.ts
  export function upsertAgent(db, sessionPk: string, n: AgentNode): void
  export function listAgents(db, sessionPk: string): AgentNode[]
  // repos/file-offsets.ts
  export type FileOffsetRow = typeof fileOffsets.$inferSelect;
  export function getFileOffset(db, path: string): FileOffsetRow | null
  export function putFileOffset(db, row: FileOffsetRow): void
  export function deleteFileOffset(db, path: string): void
  // repos/history.ts
  export function insertHistoryPrompts(db, prompts: HistoryPrompt[]): void
  export function historyPromptsFor(db, sessionId: string): HistoryPrompt[]
  export function searchHistoryPrompts(db, like: string, limit?: number): Array<{ pk: string; display: string }>
  // repos/projects.ts
  export function replaceProjects(db, list: Array<{ id: string; name: string; pathPrefixes: string[]; hidden: boolean }>): void
  export function listProjectRows(db): Array<{ id: string; name: string; pathPrefixes: string[]; hidden: boolean }>
  // repos/user-meta.ts
  export function sessionExists(db, pk: string): boolean
  export function setPinned(db, pk: string, pinned: boolean): void
  export function pinnedSet(db, pks: string[]): Set<string>
  export function setLabels(db, pk: string, labels: string[]): string[]
  export function labelsFor(db, pks: string[]): Map<string, string[]>
  export function allLabels(db): string[]
  export function listViews(db): SavedView[]
  export function insertView(db, i: { name: string; query: Record<string, string> }): SavedView
  export function deleteView(db, id: string): boolean
  // repos/pty-sessions.ts
  export function insertPtySession(db, p: { id: string; sessionPk: string | null; command: string; args: string[]; cwd: string; pid: number; startedAt: string }): void
  export function markPtyExited(db, id: string, exitCode: number | null, exitedAt: string): void
  // test/factories.ts
  export function makeSession(o: Partial<Session> & { id: string }): Session
  export function makeEvent(o: Partial<TimelineEvent> & { seq: number }): TimelineEvent
  ```

- [ ] **Step 1: Write the test factories**

`apps/daemon/test/factories.ts`
```ts
import { emptyUsage, type Session, type TimelineEvent } from '@orc/core';

export function makeSession(o: Partial<Session> & { id: string }): Session {
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

export function makeEvent(o: Partial<TimelineEvent> & { seq: number }): TimelineEvent {
  return {
    sessionId: 's',
    agentId: null,
    uuid: `u${o.seq}`,
    parentUuid: null,
    ts: '2026-09-01T09:00:00.000Z',
    kind: 'prompt',
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
    ...o,
  };
}
```

- [ ] **Step 2: Write the failing tests**

`apps/daemon/src/db/fts.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { escapeLike, toFtsQuery } from './fts.ts';

describe('fts helpers', () => {
  it('builds safe prefix queries', () => {
    expect(toFtsQuery('SAF-1787 weekend')).toBe('"saf"* "1787"* "weekend"*');
    expect(toFtsQuery('"; DROP TABLE x --')).toBe('"drop"* "table"* "x"*');
    expect(toFtsQuery('مرحبا')).toBe('"مرحبا"*');
    expect(toFtsQuery('  -- ')).toBeNull();
  });

  it('escapes LIKE wildcards', () => {
    expect(escapeLike('100%_a\\b')).toBe('100\\%\\_a\\\\b');
  });
});
```

`apps/daemon/src/db/repos/repos.test.ts`
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEvent, makeSession } from '../../../test/factories.ts';
import { type OrcDb, openDb } from '../client.ts';
import { toFtsQuery } from '../fts.ts';
import { listAgents, upsertAgent } from './agents.ts';
import { countEvents, deleteEventsFor, eventSnippet, insertEvents, listEvents, searchEventSessions } from './events.ts';
import { deleteFileOffset, getFileOffset, putFileOffset } from './file-offsets.ts';
import { historyPromptsFor, insertHistoryPrompts, searchHistoryPrompts } from './history.ts';
import { listProjectRows, replaceProjects } from './projects.ts';
import {
  getSessionByPk,
  getSessionOrigin,
  listSessionCwds,
  markHasSubagents,
  projectStats,
  querySessions,
  searchSessionText,
  setSessionAvailability,
  setSessionProject,
  upsertSession,
} from './sessions.ts';
import { allLabels, deleteView, insertView, labelsFor, listViews, pinnedSet, setLabels, setPinned } from './user-meta.ts';

let db: OrcDb;
let raw: Database.Database;
let close: () => void;
beforeEach(() => {
  const opened = openDb(join(mkdtempSync(join(tmpdir(), 'orc-repo-')), 'index.db'));
  db = opened.db;
  raw = opened.raw;
  close = opened.close;
});
afterEach(() => close());

function seed() {
  upsertSession(
    db,
    makeSession({
      id: 'a',
      name: 'Weekend SLA',
      firstPrompt: 'implement SAF-1 weekend rule',
      tickets: ['SAF-1'],
      prs: [{ repo: 'o/r', number: 231, url: 'https://github.com/o/r/pull/231' }],
      models: ['claude-opus-5'],
      skills: ['conductor'],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 1.5 },
      lastActivityAt: '2026-09-01T10:00:00.000Z',
    }),
  );
  upsertSession(
    db,
    makeSession({
      id: 'b',
      source: 'codex',
      projectId: 'forza',
      startCwd: '/Users/test/Forza',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.1 },
      flags: { touchedProd: false, hasSubagents: false, automated: true },
      lastActivityAt: '2026-09-01T11:00:00.000Z',
    }),
  );
  upsertSession(
    db,
    makeSession({
      id: 'c',
      availability: 'prompts-only',
      flags: { touchedProd: true, hasSubagents: true, automated: false },
      lastActivityAt: '2026-09-01T09:00:00.000Z',
    }),
    'history',
  );
  upsertSession(db, makeSession({ id: 'd', lastActivityAt: '2026-09-01T08:00:00.000Z' }));
  setLabels(db, 'claude:d', ['hidden']);
}

const pks = (f: Parameters<typeof querySessions>[1]) => querySessions(db, f).map((r) => r.pk);

describe('sessions repo', () => {
  it('round-trips a session and keeps recap on re-upsert', () => {
    seed();
    raw.prepare("update sessions set recap = 'R' where pk = 'claude:a'").run();
    upsertSession(db, makeSession({ id: 'a', name: 'Renamed' }));
    const s = getSessionByPk(db, 'claude:a');
    expect(s).toMatchObject({ id: 'a', name: 'Renamed', recap: 'R', live: null });
    expect(getSessionByPk(db, 'claude:zzz')).toBeNull();
    expect(getSessionOrigin(db, 'claude:c')).toBe('history');
    expect(getSessionOrigin(db, 'claude:a')).toBe('transcript');
  });

  it('applies column overrides', () => {
    seed();
    setSessionProject(db, 'claude:a', 'other');
    markHasSubagents(db, 'claude:a');
    setSessionAvailability(db, 'claude:a', 'prompts-only', null);
    expect(getSessionByPk(db, 'claude:a')).toMatchObject({
      projectId: 'other',
      availability: 'prompts-only',
      transcriptPath: null,
      flags: { hasSubagents: true },
    });
    expect(listSessionCwds(db)).toHaveLength(4);
  });

  it('filters and orders', () => {
    seed();
    expect(pks({ limit: 10 })).toEqual(['claude:a', 'claude:c']);
    expect(pks({ limit: 10, includeAutomated: true })).toEqual(['codex:b', 'claude:a', 'claude:c']);
    expect(pks({ limit: 10, includeHidden: true })).toEqual(['claude:a', 'claude:c', 'claude:d']);
    expect(pks({ limit: 10, label: 'hidden' })).toEqual(['claude:d']);
    expect(pks({ limit: 10, projectId: 'forza', includeAutomated: true })).toEqual(['codex:b']);
    expect(pks({ limit: 10, source: 'claude', ticket: 'saf-1' })).toEqual(['claude:a']);
    expect(pks({ limit: 10, pr: '231' })).toEqual(['claude:a']);
    expect(pks({ limit: 10, pr: 'https://github.com/o/r/pull/231' })).toEqual(['claude:a']);
    expect(pks({ limit: 10, model: 'claude-opus-5' })).toEqual(['claude:a']);
    expect(pks({ limit: 10, skill: 'conductor' })).toEqual(['claude:a']);
    expect(pks({ limit: 10, minCost: 1, includeAutomated: true })).toEqual(['claude:a']);
    expect(pks({ limit: 10, maxCost: 1, includeAutomated: true })).toEqual(['codex:b']);
    expect(pks({ limit: 10, touchedProd: true })).toEqual(['claude:c']);
    expect(pks({ limit: 10, hasSubagents: true })).toEqual(['claude:c']);
    expect(pks({ limit: 10, availability: 'prompts-only' })).toEqual(['claude:c']);
    expect(pks({ limit: 10, from: '2026-09-01T09:30:00.000Z' })).toEqual(['claude:a']);
    expect(pks({ limit: 10, pks: ['claude:c'] })).toEqual(['claude:c']);
    expect(pks({ limit: 10, pks: [] })).toEqual([]);
    setPinned(db, 'claude:c', true);
    expect(pks({ limit: 10, pinned: true })).toEqual(['claude:c']);
  });

  it('paginates with a cursor', () => {
    seed();
    const first = querySessions(db, { limit: 1, includeAutomated: true });
    expect(first.map((r) => r.pk)).toEqual(['codex:b']);
    const row = first[0];
    if (!row) throw new Error('missing row');
    expect(pks({ limit: 5, includeAutomated: true, cursor: { lastActivityAt: row.lastActivityAt, pk: row.pk } })).toEqual([
      'claude:a',
      'claude:c',
    ]);
  });

  it('searches names and prompts with LIKE and reports project stats', () => {
    seed();
    expect(searchSessionText(db, '%weekend%')).toEqual(['claude:a']);
    expect(projectStats(db)).toEqual(
      expect.arrayContaining([
        { projectId: 'wakecap', sessionCount: 3, lastActivityAt: '2026-09-01T10:00:00.000Z' },
        { projectId: 'forza', sessionCount: 1, lastActivityAt: '2026-09-01T11:00:00.000Z' },
      ]),
    );
  });
});

describe('events repo', () => {
  const events = [
    makeEvent({ seq: 1, kind: 'prompt', text: 'fix the notification service' }),
    makeEvent({ seq: 2, kind: 'tool_call', tool: 'Bash', toolUseId: 't1', input: { command: 'PGPASSWORD=x psql -h db' } }),
    makeEvent({ seq: 3, kind: 'tool_result', toolUseId: 't1', text: 'notification rows: 3' }),
    makeEvent({
      seq: 4,
      kind: 'assistant_text',
      text: 'Done.',
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: null },
      messageId: 'm1',
      model: 'claude-opus-5',
    }),
    makeEvent({ seq: 1, agentId: 'ag1', kind: 'prompt', text: 'subagent notification task' }),
  ];

  it('inserts idempotently and pages by seq per agent', () => {
    insertEvents(db, 'claude:s', events);
    insertEvents(db, 'claude:s', events);
    expect(countEvents(db, 'claude:s')).toBe(5);
    const p1 = listEvents(db, 'claude:s', { limit: 2 });
    expect(p1.items.map((e) => e.seq)).toEqual([1, 2]);
    expect(p1.nextSeq).toBe(2);
    expect(p1.items[1]?.input).toEqual({ command: 'PGPASSWORD=x psql -h db' });
    const p2 = listEvents(db, 'claude:s', { afterSeq: 2, limit: 2 });
    expect(p2.items.map((e) => e.seq)).toEqual([3, 4]);
    expect(p2.nextSeq).toBeNull();
    expect(p2.items[1]).toMatchObject({ sessionId: 's', agentId: null, usage: { output: 2 }, model: 'claude-opus-5' });
    const sub = listEvents(db, 'claude:s', { agentId: 'ag1' });
    expect(sub.items).toHaveLength(1);
    expect(sub.items[0]?.agentId).toBe('ag1');
  });

  it('finds sessions by FTS, excludes tool results and returns snippets', () => {
    insertEvents(db, 'claude:s', events);
    insertEvents(db, 'claude:other', [makeEvent({ seq: 1, text: 'unrelated' })]);
    const match = toFtsQuery('notification') ?? '';
    const hits = searchEventSessions(db, match);
    expect([...hits.keys()]).toEqual(['claude:s']);
    const snip = eventSnippet(db, match, hits.get('claude:s') ?? -1);
    expect(snip).toContain('⟦notification⟧');
    expect(searchEventSessions(db, toFtsQuery('rows') ?? '').size).toBe(0);
    expect(searchEventSessions(db, toFtsQuery('psql') ?? '').size).toBe(1);
    deleteEventsFor(db, 'claude:s', null);
    expect(countEvents(db, 'claude:s')).toBe(1);
    expect(searchEventSessions(db, match).size).toBe(1);
    deleteEventsFor(db, 'claude:s', 'ag1');
    expect(searchEventSessions(db, match).size).toBe(0);
  });
});

describe('small repos', () => {
  it('agents', () => {
    upsertAgent(db, 'claude:s', {
      id: 'ag1',
      sessionId: 's',
      parentId: null,
      depth: 1,
      agentType: 'Explore',
      description: 'd',
      background: true,
      toolUseId: 't',
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: null },
      startedAt: '2026-09-06T08:00:03.000Z',
      endedAt: null,
      status: 'done',
      transcriptPath: '/p',
    });
    expect(listAgents(db, 'claude:s')).toEqual([
      expect.objectContaining({ id: 'ag1', background: true, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: null } }),
    ]);
  });

  it('file offsets', () => {
    const row = {
      path: '/f.jsonl',
      kind: 'claude-main',
      sessionPk: 'claude:s',
      agentId: null,
      size: 10,
      mtimeMs: 5,
      offset: 10,
      stateJson: '{}',
      updatedAt: 'now',
    };
    putFileOffset(db, row);
    putFileOffset(db, { ...row, offset: 20 });
    expect(getFileOffset(db, '/f.jsonl')?.offset).toBe(20);
    deleteFileOffset(db, '/f.jsonl');
    expect(getFileOffset(db, '/f.jsonl')).toBeNull();
  });

  it('history prompts', () => {
    const p = { sessionId: 'h', ts: '2026-01-01T00:00:00.000Z', display: 'old 100% prompt', project: '/Users/test/Wakecap' };
    insertHistoryPrompts(db, [p, p, { ...p, ts: '2026-01-02T00:00:00.000Z', display: 'second' }]);
    expect(historyPromptsFor(db, 'h').map((x) => x.display)).toEqual(['old 100% prompt', 'second']);
    expect(searchHistoryPrompts(db, '%100\\%%')).toEqual([{ pk: 'claude:h', display: 'old 100% prompt' }]);
  });

  it('projects mirror', () => {
    replaceProjects(db, [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: ['/w'], hidden: false }]);
    replaceProjects(db, [{ id: 'forza', name: 'Forza', pathPrefixes: ['/f'], hidden: true }]);
    expect(listProjectRows(db)).toEqual([{ id: 'forza', name: 'Forza', pathPrefixes: ['/f'], hidden: true }]);
  });

  it('pins, labels and saved views', () => {
    setPinned(db, 'claude:a', true);
    setPinned(db, 'claude:a', true);
    expect([...pinnedSet(db, ['claude:a', 'claude:b'])]).toEqual(['claude:a']);
    setPinned(db, 'claude:a', false);
    expect(pinnedSet(db, ['claude:a']).size).toBe(0);
    expect(setLabels(db, 'claude:a', ['later', 'bug', 'later'])).toEqual(['bug', 'later']);
    setLabels(db, 'claude:b', ['bug']);
    expect(labelsFor(db, ['claude:a', 'claude:b'])).toEqual(
      new Map([
        ['claude:a', ['bug', 'later']],
        ['claude:b', ['bug']],
      ]),
    );
    expect(allLabels(db)).toEqual(['bug', 'later']);
    expect(pinnedSet(db, []).size).toBe(0);
    const v = insertView(db, { name: 'Prod', query: { touchedProd: 'true' } });
    expect(listViews(db)).toEqual([v]);
    expect(deleteView(db, v.id)).toBe(true);
    expect(deleteView(db, v.id)).toBe(false);
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/db`
Expected: FAIL, `Cannot find module './fts.ts'` / `'./agents.ts'`

- [ ] **Step 4: Implement the FTS helpers and repositories**

`apps/daemon/src/db/fts.ts`
```ts
/** Turns free text into an FTS5 query: every word becomes a quoted prefix term, all terms must match. */
export function toFtsQuery(input: string): string | null {
  const tokens = input.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return tokens
    .slice(0, 8)
    .map((t) => `"${t}"*`)
    .join(' ');
}

export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}
```

`apps/daemon/src/db/repos/sessions.ts`
```ts
import { HIDDEN_LABEL } from '@orc/api-contract';
import type { Availability, Session, Source } from '@orc/core';
import { and, desc, eq, gte, lte, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { sessionPk } from '../keys.ts';
import { sessions } from '../schema.ts';

export type SessionRow = typeof sessions.$inferSelect;
export type SessionOrigin = 'transcript' | 'history';

export interface SessionQueryFilter {
  pks?: string[] | null;
  projectId?: string;
  source?: Source;
  ticket?: string;
  pr?: string;
  from?: string;
  to?: string;
  model?: string;
  minCost?: number;
  maxCost?: number;
  skill?: string;
  hasSubagents?: boolean;
  touchedProd?: boolean;
  availability?: Availability;
  label?: string;
  pinned?: boolean;
  includeHidden?: boolean;
  includeAutomated?: boolean;
  limit: number;
  cursor?: { lastActivityAt: string; pk: string } | null;
}

export function upsertSession(db: OrcDb, s: Session, origin: SessionOrigin = 'transcript'): void {
  const { recap: _recap, live: _live, ...data } = s;
  const row = {
    pk: sessionPk(s.source, s.id),
    source: s.source,
    id: s.id,
    projectId: s.projectId,
    startCwd: s.startCwd,
    name: s.name,
    firstPrompt: s.firstPrompt,
    lastPrompt: s.lastPrompt,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    costUsd: s.usage.costUsd,
    modelsJson: JSON.stringify(s.models),
    ticketsJson: JSON.stringify(s.tickets),
    prsJson: JSON.stringify(s.prs),
    skillsJson: JSON.stringify(s.skills),
    availability: s.availability,
    hasSubagents: s.flags.hasSubagents,
    touchedProd: s.flags.touchedProd,
    automated: s.flags.automated,
    transcriptPath: s.transcriptPath,
    origin,
    dataJson: JSON.stringify(data),
    indexedAt: new Date().toISOString(),
  };
  db.insert(sessions).values(row).onConflictDoUpdate({ target: sessions.pk, set: row }).run();
}

export function rowToSession(row: SessionRow): Session {
  const data = JSON.parse(row.dataJson) as Omit<Session, 'recap' | 'live'>;
  return {
    ...data,
    projectId: row.projectId,
    availability: row.availability as Availability,
    transcriptPath: row.transcriptPath,
    flags: { ...data.flags, hasSubagents: row.hasSubagents },
    recap: row.recap,
    live: null,
  };
}

export function getSessionByPk(db: OrcDb, pk: string): Session | null {
  const row = db.select().from(sessions).where(eq(sessions.pk, pk)).get();
  return row ? rowToSession(row) : null;
}

export function getSessionOrigin(db: OrcDb, pk: string): SessionOrigin | null {
  const row = db.select({ origin: sessions.origin }).from(sessions).where(eq(sessions.pk, pk)).get();
  return row ? (row.origin as SessionOrigin) : null;
}

export function setSessionProject(db: OrcDb, pk: string, projectId: string | null): void {
  db.update(sessions).set({ projectId }).where(eq(sessions.pk, pk)).run();
}

export function markHasSubagents(db: OrcDb, pk: string): void {
  db.update(sessions).set({ hasSubagents: true }).where(eq(sessions.pk, pk)).run();
}

export function setSessionAvailability(
  db: OrcDb,
  pk: string,
  availability: Availability,
  transcriptPath: string | null,
): void {
  db.update(sessions).set({ availability, transcriptPath }).where(eq(sessions.pk, pk)).run();
}

export function listSessionCwds(
  db: OrcDb,
): Array<{ pk: string; startCwd: string; lastActivityAt: string; projectId: string | null }> {
  return db
    .select({
      pk: sessions.pk,
      startCwd: sessions.startCwd,
      lastActivityAt: sessions.lastActivityAt,
      projectId: sessions.projectId,
    })
    .from(sessions)
    .all();
}

export function projectStats(
  db: OrcDb,
): Array<{ projectId: string; sessionCount: number; lastActivityAt: string | null }> {
  const rows = db
    .select({
      projectId: sessions.projectId,
      sessionCount: sql<number>`count(*)`,
      lastActivityAt: sql<string | null>`max(${sessions.lastActivityAt})`,
    })
    .from(sessions)
    .where(sql`${sessions.projectId} IS NOT NULL`)
    .groupBy(sessions.projectId)
    .all();
  return rows.flatMap((r) => (r.projectId === null ? [] : [{ ...r, projectId: r.projectId }]));
}

export function countSessions(db: OrcDb): number {
  return db.select({ n: sql<number>`count(*)` }).from(sessions).get()?.n ?? 0;
}

const jsonHas = (column: SQLWrapper, value: string): SQL =>
  sql`EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ${value})`;

export function querySessions(db: OrcDb, f: SessionQueryFilter): SessionRow[] {
  const c: SQL[] = [];
  if (f.pks) c.push(sql`${sessions.pk} IN (SELECT value FROM json_each(${JSON.stringify(f.pks)}))`);
  if (f.projectId) c.push(eq(sessions.projectId, f.projectId));
  if (f.source) c.push(eq(sessions.source, f.source));
  if (f.ticket) c.push(jsonHas(sessions.ticketsJson, f.ticket.toUpperCase()));
  if (f.pr) {
    c.push(
      sql`EXISTS (SELECT 1 FROM json_each(${sessions.prsJson}) WHERE json_extract(value, '$.url') = ${f.pr} OR CAST(json_extract(value, '$.number') AS TEXT) = ${f.pr})`,
    );
  }
  if (f.from) c.push(gte(sessions.lastActivityAt, f.from));
  if (f.to) c.push(lte(sessions.startedAt, f.to));
  if (f.model) c.push(jsonHas(sessions.modelsJson, f.model));
  if (f.skill) c.push(jsonHas(sessions.skillsJson, f.skill));
  if (f.minCost !== undefined) c.push(gte(sessions.costUsd, f.minCost));
  if (f.maxCost !== undefined) c.push(lte(sessions.costUsd, f.maxCost));
  if (f.hasSubagents !== undefined) c.push(eq(sessions.hasSubagents, f.hasSubagents));
  if (f.touchedProd !== undefined) c.push(eq(sessions.touchedProd, f.touchedProd));
  if (f.availability) c.push(eq(sessions.availability, f.availability));
  if (f.label) {
    c.push(sql`EXISTS (SELECT 1 FROM labels l WHERE l.session_pk = ${sessions.pk} AND l.label = ${f.label})`);
  }
  if (f.pinned) c.push(sql`EXISTS (SELECT 1 FROM pins p WHERE p.session_pk = ${sessions.pk})`);
  if (!f.includeHidden && f.label !== HIDDEN_LABEL) {
    c.push(
      sql`NOT EXISTS (SELECT 1 FROM labels l WHERE l.session_pk = ${sessions.pk} AND l.label = ${HIDDEN_LABEL})`,
    );
  }
  if (!f.includeAutomated) c.push(eq(sessions.automated, false));
  if (f.cursor) {
    const { lastActivityAt: a, pk: p } = f.cursor;
    c.push(sql`(${sessions.lastActivityAt} < ${a} OR (${sessions.lastActivityAt} = ${a} AND ${sessions.pk} < ${p}))`);
  }
  return db
    .select()
    .from(sessions)
    .where(c.length > 0 ? and(...c) : undefined)
    .orderBy(desc(sessions.lastActivityAt), desc(sessions.pk))
    .limit(f.limit)
    .all();
}

export function searchSessionText(db: OrcDb, like: string): string[] {
  return db
    .select({ pk: sessions.pk })
    .from(sessions)
    .where(
      sql`${sessions.name} LIKE ${like} ESCAPE '\\' OR ${sessions.firstPrompt} LIKE ${like} ESCAPE '\\' OR ${sessions.lastPrompt} LIKE ${like} ESCAPE '\\'`,
    )
    .all()
    .map((r) => r.pk);
}
```
`apps/daemon/src/db/repos/events.ts`
```ts
import { SNIPPET_CLOSE, SNIPPET_OPEN } from '@orc/api-contract';
import type { EventKind, TimelineEvent, Usage } from '@orc/core';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { splitPk } from '../keys.ts';
import { events } from '../schema.ts';

type EventRow = typeof events.$inferSelect;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/** What FTS indexes for a tool call: the shell command, the edited path, or compact JSON. */
export function searchableInput(e: TimelineEvent): string | null {
  if (e.kind !== 'tool_call' || typeof e.input !== 'object' || e.input === null) return null;
  const i = e.input as Record<string, unknown>;
  if (typeof i.command === 'string') return i.command.slice(0, 2000);
  if (e.tool && EDIT_TOOLS.has(e.tool) && typeof i.file_path === 'string') return i.file_path;
  return JSON.stringify(i).slice(0, 2000);
}

export function insertEvents(db: OrcDb, sessionPk: string, list: TimelineEvent[]): void {
  const rows = list.map((e) => ({
    sessionPk,
    agentId: e.agentId ?? '',
    seq: e.seq,
    uuid: e.uuid,
    parentUuid: e.parentUuid,
    ts: e.ts,
    kind: e.kind,
    turn: e.turn,
    text: e.text,
    tool: e.tool,
    toolUseId: e.toolUseId,
    mcpServer: e.mcpServer,
    inputJson: e.input === null || e.input === undefined ? null : JSON.stringify(e.input),
    searchInput: searchableInput(e),
    messageId: e.messageId,
    model: e.model,
    usageJson: e.usage ? JSON.stringify(e.usage) : null,
    durationMs: e.durationMs,
  }));
  for (let i = 0; i < rows.length; i += 200) {
    db.insert(events).values(rows.slice(i, i + 200)).onConflictDoNothing().run();
  }
}

export function deleteEventsFor(db: OrcDb, sessionPk: string, agentId: string | null): void {
  db.delete(events)
    .where(and(eq(events.sessionPk, sessionPk), eq(events.agentId, agentId ?? '')))
    .run();
}

function rowToEvent(r: EventRow): TimelineEvent {
  return {
    sessionId: splitPk(r.sessionPk).id,
    agentId: r.agentId === '' ? null : r.agentId,
    uuid: r.uuid,
    parentUuid: r.parentUuid,
    seq: r.seq,
    ts: r.ts,
    kind: r.kind as EventKind,
    turn: r.turn,
    text: r.text,
    tool: r.tool,
    toolUseId: r.toolUseId,
    mcpServer: r.mcpServer,
    input: r.inputJson === null ? null : (JSON.parse(r.inputJson) as unknown),
    messageId: r.messageId,
    model: r.model,
    usage: r.usageJson === null ? null : (JSON.parse(r.usageJson) as Usage),
    durationMs: r.durationMs,
  };
}

export function listEvents(
  db: OrcDb,
  sessionPk: string,
  o: { agentId?: string | null; afterSeq?: number; limit?: number },
): { items: TimelineEvent[]; nextSeq: number | null } {
  const limit = Math.min(Math.max(o.limit ?? 200, 1), 500);
  const rows = db
    .select()
    .from(events)
    .where(
      and(eq(events.sessionPk, sessionPk), eq(events.agentId, o.agentId ?? ''), gt(events.seq, o.afterSeq ?? 0)),
    )
    .orderBy(asc(events.seq))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit).map(rowToEvent);
  const last = page.at(-1);
  return { items: page, nextSeq: rows.length > limit && last ? last.seq : null };
}

export function countEvents(db: OrcDb, sessionPk: string): number {
  return db.select({ n: sql<number>`count(*)` }).from(events).where(eq(events.sessionPk, sessionPk)).get()?.n ?? 0;
}

/** All sessions with at least one matching event, with the first matching event id as a snippet anchor. */
export function searchEventSessions(db: OrcDb, match: string): Map<string, number> {
  const rows = db.all<{ pk: string; rid: number }>(
    sql`SELECT e.session_pk AS pk, min(e.id) AS rid FROM events_fts JOIN events e ON e.id = events_fts.rowid WHERE events_fts MATCH ${match} GROUP BY e.session_pk`,
  );
  return new Map(rows.map((r) => [r.pk, r.rid]));
}

export function eventSnippet(db: OrcDb, match: string, rowid: number): string | null {
  const row = db.get<{ snip: string } | undefined>(
    sql`SELECT snippet(events_fts, -1, ${SNIPPET_OPEN}, ${SNIPPET_CLOSE}, '…', 12) AS snip FROM events_fts WHERE events_fts MATCH ${match} AND rowid = ${rowid}`,
  );
  return row?.snip ?? null;
}
```

`apps/daemon/src/db/repos/agents.ts`
```ts
import type { AgentNode, Usage } from '@orc/core';
import { asc, eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { splitPk } from '../keys.ts';
import { agents } from '../schema.ts';

export function upsertAgent(db: OrcDb, sessionPk: string, n: AgentNode): void {
  const row = {
    sessionPk,
    id: n.id,
    parentId: n.parentId,
    depth: n.depth,
    agentType: n.agentType,
    description: n.description,
    background: n.background,
    toolUseId: n.toolUseId,
    usageJson: JSON.stringify(n.usage),
    startedAt: n.startedAt,
    endedAt: n.endedAt,
    status: n.status,
    transcriptPath: n.transcriptPath,
  };
  db.insert(agents)
    .values(row)
    .onConflictDoUpdate({ target: [agents.sessionPk, agents.id], set: row })
    .run();
}

export function listAgents(db: OrcDb, sessionPk: string): AgentNode[] {
  return db
    .select()
    .from(agents)
    .where(eq(agents.sessionPk, sessionPk))
    .orderBy(asc(agents.startedAt))
    .all()
    .map((r) => ({
      id: r.id,
      sessionId: splitPk(r.sessionPk).id,
      parentId: r.parentId,
      depth: r.depth,
      agentType: r.agentType,
      description: r.description,
      background: r.background,
      toolUseId: r.toolUseId,
      usage: JSON.parse(r.usageJson) as Usage,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      status: r.status as AgentNode['status'],
      transcriptPath: r.transcriptPath,
    }));
}
```

`apps/daemon/src/db/repos/file-offsets.ts`
```ts
import { eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { fileOffsets } from '../schema.ts';

export type FileOffsetRow = typeof fileOffsets.$inferSelect;

export function getFileOffset(db: OrcDb, path: string): FileOffsetRow | null {
  return db.select().from(fileOffsets).where(eq(fileOffsets.path, path)).get() ?? null;
}

export function putFileOffset(db: OrcDb, row: FileOffsetRow): void {
  db.insert(fileOffsets).values(row).onConflictDoUpdate({ target: fileOffsets.path, set: row }).run();
}

export function deleteFileOffset(db: OrcDb, path: string): void {
  db.delete(fileOffsets).where(eq(fileOffsets.path, path)).run();
}
```

`apps/daemon/src/db/repos/history.ts`
```ts
import type { HistoryPrompt } from '@orc/core';
import { asc, eq, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { historyPrompts } from '../schema.ts';

export function insertHistoryPrompts(db: OrcDb, prompts: HistoryPrompt[]): void {
  for (let i = 0; i < prompts.length; i += 500) {
    const chunk = prompts.slice(i, i + 500);
    if (chunk.length > 0) db.insert(historyPrompts).values(chunk).onConflictDoNothing().run();
  }
}

export function historyPromptsFor(db: OrcDb, sessionId: string): HistoryPrompt[] {
  return db
    .select()
    .from(historyPrompts)
    .where(eq(historyPrompts.sessionId, sessionId))
    .orderBy(asc(historyPrompts.ts))
    .all();
}

export function searchHistoryPrompts(db: OrcDb, like: string, limit = 500): Array<{ pk: string; display: string }> {
  return db.all<{ pk: string; display: string }>(
    sql`SELECT 'claude:' || session_id AS pk, min(display) AS display FROM history_prompts WHERE display LIKE ${like} ESCAPE '\\' GROUP BY session_id LIMIT ${limit}`,
  );
}
```

`apps/daemon/src/db/repos/projects.ts`
```ts
import { asc } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { projects } from '../schema.ts';

export interface ProjectRow {
  id: string;
  name: string;
  pathPrefixes: string[];
  hidden: boolean;
}

export function replaceProjects(db: OrcDb, list: ProjectRow[]): void {
  const now = new Date().toISOString();
  db.transaction((tx) => {
    tx.delete(projects).run();
    for (const p of list) {
      tx.insert(projects)
        .values({ id: p.id, name: p.name, pathPrefixesJson: JSON.stringify(p.pathPrefixes), hidden: p.hidden, updatedAt: now })
        .run();
    }
  });
}

export function listProjectRows(db: OrcDb): ProjectRow[] {
  return db
    .select()
    .from(projects)
    .orderBy(asc(projects.id))
    .all()
    .map((r) => ({ id: r.id, name: r.name, pathPrefixes: JSON.parse(r.pathPrefixesJson) as string[], hidden: r.hidden }));
}
```

`apps/daemon/src/db/repos/user-meta.ts`
```ts
import { randomUUID } from 'node:crypto';
import type { SavedView } from '@orc/api-contract';
import { asc, eq, inArray } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { labels, pins, savedViews, sessions } from '../schema.ts';

export function sessionExists(db: OrcDb, pk: string): boolean {
  return db.select({ pk: sessions.pk }).from(sessions).where(eq(sessions.pk, pk)).get() !== undefined;
}

export function setPinned(db: OrcDb, pk: string, pinned: boolean): void {
  if (pinned) {
    db.insert(pins).values({ sessionPk: pk, createdAt: new Date().toISOString() }).onConflictDoNothing().run();
  } else {
    db.delete(pins).where(eq(pins.sessionPk, pk)).run();
  }
}

export function pinnedSet(db: OrcDb, pks: string[]): Set<string> {
  if (pks.length === 0) return new Set();
  const rows = db.select({ pk: pins.sessionPk }).from(pins).where(inArray(pins.sessionPk, pks)).all();
  return new Set(rows.map((r) => r.pk));
}

export function setLabels(db: OrcDb, pk: string, list: string[]): string[] {
  const unique = [...new Set(list.map((l) => l.trim()).filter(Boolean))].sort();
  const now = new Date().toISOString();
  db.transaction((tx) => {
    tx.delete(labels).where(eq(labels.sessionPk, pk)).run();
    for (const label of unique) tx.insert(labels).values({ sessionPk: pk, label, createdAt: now }).run();
  });
  return unique;
}

export function labelsFor(db: OrcDb, pks: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (pks.length === 0) return out;
  const rows = db
    .select({ pk: labels.sessionPk, label: labels.label })
    .from(labels)
    .where(inArray(labels.sessionPk, pks))
    .orderBy(asc(labels.sessionPk), asc(labels.label))
    .all();
  for (const r of rows) out.set(r.pk, [...(out.get(r.pk) ?? []), r.label]);
  return out;
}

export function allLabels(db: OrcDb): string[] {
  return db
    .selectDistinct({ label: labels.label })
    .from(labels)
    .orderBy(asc(labels.label))
    .all()
    .map((r) => r.label);
}

export function listViews(db: OrcDb): SavedView[] {
  return db
    .select()
    .from(savedViews)
    .orderBy(asc(savedViews.createdAt), asc(savedViews.name))
    .all()
    .map((r) => ({ id: r.id, name: r.name, query: JSON.parse(r.queryJson) as Record<string, string>, createdAt: r.createdAt }));
}

export function insertView(db: OrcDb, i: { name: string; query: Record<string, string> }): SavedView {
  const view: SavedView = { id: randomUUID(), name: i.name, query: i.query, createdAt: new Date().toISOString() };
  db.insert(savedViews)
    .values({ id: view.id, name: view.name, queryJson: JSON.stringify(view.query), createdAt: view.createdAt })
    .run();
  return view;
}

export function deleteView(db: OrcDb, id: string): boolean {
  return db.delete(savedViews).where(eq(savedViews.id, id)).run().changes > 0;
}
```

`apps/daemon/src/db/repos/pty-sessions.ts`
```ts
import { eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { ptySessions } from '../schema.ts';

export function insertPtySession(
  db: OrcDb,
  p: { id: string; sessionPk: string | null; command: string; args: string[]; cwd: string; pid: number; startedAt: string },
): void {
  db.insert(ptySessions)
    .values({
      id: p.id,
      sessionPk: p.sessionPk,
      command: p.command,
      argsJson: JSON.stringify(p.args),
      cwd: p.cwd,
      pid: p.pid,
      startedAt: p.startedAt,
    })
    .run();
}

export function markPtyExited(db: OrcDb, id: string, exitCode: number | null, exitedAt: string): void {
  db.update(ptySessions).set({ exitCode, exitedAt }).where(eq(ptySessions.id, id)).run();
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/db`
Expected: PASS. If `db.transaction` in `replaceProjects`/`setLabels` fails when a caller already holds an outer `raw.transaction`, drizzle uses a SAVEPOINT for nested calls; if the installed version does not, replace `db.transaction((tx) => …)` with plain sequential calls on `db` (callers wrap them in a transaction).

- [ ] **Step 6: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon
git commit -m "feat(daemon): add repositories with FTS5 session search and cursor paging"
```

---

### Task 8: Event bus and PTY manager

**Files:**
- Create: `apps/daemon/src/live/event-bus.ts`, `apps/daemon/src/live/event-bus.test.ts`
- Create: `apps/daemon/src/services/errors.ts`
- Create: `apps/daemon/src/pty/input.ts`, `apps/daemon/src/pty/input.test.ts`
- Create: `apps/daemon/src/pty/pty-manager.ts`, `apps/daemon/src/pty/pty-manager.test.ts`
- Modify: `apps/daemon/package.json` (node-pty)

**Interfaces:**
- Consumes: `LiveEvent` (Task 5), `LiveStatus`, `TestResult` (core).
- Produces:
  ```ts
  // live/event-bus.ts (contracts §6 + session.indexed)
  export type BusEvent = LiveEvent
    | { type: 'hook.received'; payload: unknown }
    | { type: 'session.statusChanged'; pk: string; from: LiveStatus | null; to: LiveStatus }
    | { type: 'session.turnEnded'; pk: string; turn: number }
    | { type: 'tests.recorded'; pk: string; result: TestResult }
    | { type: 'session.indexed'; pk: string };
  export interface EventBus { emit(e: BusEvent): void; on<T extends BusEvent['type']>(type: T, fn: (e: Extract<BusEvent, { type: T }>) => void): () => void }
  export function createEventBus(opts?: { onError?: (err: unknown, e: BusEvent) => void }): EventBus
  // services/errors.ts
  export type ServiceErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500;
  export class ServiceError extends Error { readonly code: string; readonly status: ServiceErrorStatus; readonly details?: unknown; constructor(code: string, status: ServiceErrorStatus, message: string, details?: unknown) }
  // pty/input.ts (from spike S2/S8 — the S2-S8 report's submitDelayMs wins)
  export const SUBMIT_DELAY_MS: number;
  export function encodePaste(text: string): string
  export async function sendText(write: (d: string) => void, text: string, opts?: { submitDelayMs?: number }): Promise<void>
  // pty/pty-manager.ts (contracts §7 + remove/disposeAll)
  export interface PtyInfo { id; sessionPk: string | null; command; args: string[]; cwd; pid; startedAt; exitedAt: string | null; exitCode: number | null; cols; rows }
  export interface PtyManager { spawn(...): PtyInfo; write(id, data): void; sendText(id, text): Promise<void>; resize(id, cols, rows): void; kill(id, signal?): void; attach(id, onData): { scrollback: string; detach(): void }; list(): PtyInfo[]; get(id): PtyInfo | undefined; remove(id: string): void; disposeAll(): void }
  export function createPtyManager(opts: { bus: EventBus; scrollbackBytes?: number }): PtyManager
  ```
  Errors: unknown id → `ServiceError('not_found', 404)`; writing to an exited PTY → `ServiceError('pty_exited', 409)`. `scrollbackBytes` (default 256 000) is measured in UTF-16 characters. `kill` defaults to `SIGHUP`. Exits emit `{ type: 'pty.exited', ptyId, code }`.

- [ ] **Step 1: Install node-pty**

Run: `pnpm --filter @orc/daemon add node-pty@^1.1.0`
Expected: installs and builds (`node-pty` is in `onlyBuiltDependencies`). On macOS, if a later test fails with `posix_spawnp failed`, run `chmod +x node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/darwin-*/spawn-helper` and record it in the review note (the S2 spike report may already say so).

- [ ] **Step 2: Write the failing tests**

`apps/daemon/src/live/event-bus.test.ts`
```ts
import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from './event-bus.ts';

describe('event bus', () => {
  it('delivers typed events and unsubscribes', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    const off = bus.on('pty.exited', (e) => seen.push(`${e.ptyId}:${e.code}`));
    bus.on('session.indexed', (e) => seen.push(e.pk));
    bus.emit({ type: 'pty.exited', ptyId: 'p1', code: 0 });
    bus.emit({ type: 'session.indexed', pk: 'claude:s' });
    off();
    bus.emit({ type: 'pty.exited', ptyId: 'p2', code: 1 });
    expect(seen).toEqual(['p1:0', 'claude:s']);
  });

  it('isolates failing handlers', () => {
    const onError = vi.fn();
    const bus = createEventBus({ onError });
    const ok = vi.fn();
    bus.on('index.progress', () => {
      throw new Error('boom');
    });
    bus.on('index.progress', ok);
    bus.emit({ type: 'index.progress', done: 1, total: 2 });
    expect(ok).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { type: 'index.progress', done: 1, total: 2 });
  });
});
```

`apps/daemon/src/pty/input.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { encodePaste, sendText } from './input.ts';

describe('sendText', () => {
  it('wraps text in bracketed paste', () => {
    expect(encodePaste('hi\nthere')).toBe('\x1b[200~hi\nthere\x1b[201~');
  });

  it('writes paste then carriage return', async () => {
    const writes: string[] = [];
    await sendText((d) => writes.push(d), 'yes', { submitDelayMs: 0 });
    expect(writes).toEqual(['\x1b[200~yes\x1b[201~', '\r']);
  });
});
```

`apps/daemon/src/pty/pty-manager.test.ts`
```ts
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../live/event-bus.ts';
import { createPtyManager } from './pty-manager.ts';

describe('pty manager', () => {
  it('spawns, streams, replays scrollback and reports exit', async () => {
    const bus = createEventBus();
    const exits: Array<number | null> = [];
    bus.on('pty.exited', (e) => exits.push(e.code));
    const pty = createPtyManager({ bus });
    const info = pty.spawn({ command: '/bin/sh', args: ['-c', 'printf ready; exec cat'], cwd: tmpdir(), sessionPk: 'claude:s' });
    expect(info).toMatchObject({ sessionPk: 'claude:s', cols: 120, rows: 36, exitedAt: null });
    expect(info.pid).toBeGreaterThan(0);

    let out = '';
    const a = pty.attach(info.id, (d) => {
      out += d;
    });
    await vi.waitFor(() => expect(out).toContain('ready'));
    pty.write(info.id, 'hello\r');
    await vi.waitFor(() => expect(out).toContain('hello'));
    a.detach();
    expect(pty.attach(info.id, () => undefined).scrollback).toContain('ready');

    pty.resize(info.id, 100, 30);
    expect(pty.get(info.id)).toMatchObject({ cols: 100, rows: 30 });
    expect(pty.list().map((p) => p.id)).toEqual([info.id]);

    pty.kill(info.id);
    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(pty.get(info.id)?.exitedAt).not.toBeNull();
    expect(() => pty.write(info.id, 'x')).toThrow(/exited/);
    pty.remove(info.id);
    expect(pty.get(info.id)).toBeUndefined();
    expect(() => pty.write(info.id, 'x')).toThrow(/not found/);
  });

  it('caps the scrollback', async () => {
    const pty = createPtyManager({ bus: createEventBus(), scrollbackBytes: 1000 });
    const info = pty.spawn({ command: '/bin/sh', args: ['-c', 'head -c 5000 /dev/zero | tr "\\0" x; exec cat'], cwd: tmpdir() });
    await vi.waitFor(() => expect(pty.attach(info.id, () => undefined).scrollback.length).toBeGreaterThanOrEqual(900));
    await new Promise((r) => setTimeout(r, 200));
    expect(pty.attach(info.id, () => undefined).scrollback.length).toBeLessThanOrEqual(1000);
    pty.disposeAll();
    expect(pty.list()).toEqual([]);
  });

  it('sends bracketed paste through sendText', async () => {
    const pty = createPtyManager({ bus: createEventBus() });
    const info = pty.spawn({ command: '/bin/cat', args: [], cwd: tmpdir() });
    let out = '';
    pty.attach(info.id, (d) => {
      out += d;
    });
    await pty.sendText(info.id, 'multi\nline');
    await vi.waitFor(() => expect(out).toContain('line'));
    pty.disposeAll();
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/live apps/daemon/src/pty`
Expected: FAIL, `Cannot find module './event-bus.ts'` / `'./input.ts'` / `'./pty-manager.ts'`

- [ ] **Step 4: Implement the bus, errors and PTY manager**

`apps/daemon/src/live/event-bus.ts`
```ts
import type { LiveEvent } from '@orc/api-contract';
import type { LiveStatus, TestResult } from '@orc/core';

export type BusEvent =
  | LiveEvent
  | { type: 'hook.received'; payload: unknown }
  | { type: 'session.statusChanged'; pk: string; from: LiveStatus | null; to: LiveStatus }
  | { type: 'session.turnEnded'; pk: string; turn: number }
  | { type: 'tests.recorded'; pk: string; result: TestResult }
  | { type: 'session.indexed'; pk: string };

export interface EventBus {
  emit(e: BusEvent): void;
  on<T extends BusEvent['type']>(type: T, fn: (e: Extract<BusEvent, { type: T }>) => void): () => void;
}

type Handler = (e: BusEvent) => void;

export function createEventBus(opts: { onError?: (err: unknown, e: BusEvent) => void } = {}): EventBus {
  const handlers = new Map<BusEvent['type'], Set<Handler>>();
  const onError = opts.onError ?? ((err: unknown, e: BusEvent) => console.error(`event bus handler failed for ${e.type}`, err));
  return {
    emit(e) {
      const set = handlers.get(e.type);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(e);
        } catch (err) {
          onError(err, e);
        }
      }
    },
    on(type, fn) {
      const set = handlers.get(type) ?? new Set<Handler>();
      handlers.set(type, set);
      const h = fn as Handler;
      set.add(h);
      return () => {
        set.delete(h);
      };
    },
  };
}
```

`apps/daemon/src/services/errors.ts`
```ts
export type ServiceErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500;

export class ServiceError extends Error {
  readonly code: string;
  readonly status: ServiceErrorStatus;
  readonly details?: unknown;

  constructor(code: string, status: ServiceErrorStatus, message: string, details?: unknown) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
```

`apps/daemon/src/pty/input.ts`
```ts
/** From spike S2/S8. If plan/spikes/S2-S8.md recorded a different submit delay, use that value here. */
export const SUBMIT_DELAY_MS = 120;

export function encodePaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

export async function sendText(
  write: (d: string) => void,
  text: string,
  opts: { submitDelayMs?: number } = {},
): Promise<void> {
  write(encodePaste(text));
  await new Promise((r) => setTimeout(r, opts.submitDelayMs ?? SUBMIT_DELAY_MS));
  write('\r');
}
```

`apps/daemon/src/pty/pty-manager.ts`
```ts
import { randomUUID } from 'node:crypto';
import { type IPty, spawn as ptySpawn } from 'node-pty';
import type { EventBus } from '../live/event-bus.ts';
import { ServiceError } from '../services/errors.ts';
import { sendText } from './input.ts';

export interface PtyInfo {
  id: string;
  sessionPk: string | null;
  command: string;
  args: string[];
  cwd: string;
  pid: number;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
  cols: number;
  rows: number;
}

export interface PtySpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  sessionPk?: string | null;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export interface PtyManager {
  spawn(opts: PtySpawnOptions): PtyInfo;
  write(id: string, data: string): void;
  sendText(id: string, text: string): Promise<void>;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string, signal?: NodeJS.Signals): void;
  attach(id: string, onData: (chunk: string) => void): { scrollback: string; detach(): void };
  list(): PtyInfo[];
  get(id: string): PtyInfo | undefined;
  remove(id: string): void;
  disposeAll(): void;
}

interface Entry {
  info: PtyInfo;
  proc: IPty | null;
  chunks: string[];
  size: number;
  listeners: Set<(chunk: string) => void>;
}

export function createPtyManager(opts: { bus: EventBus; scrollbackBytes?: number }): PtyManager {
  const max = opts.scrollbackBytes ?? 256_000;
  const entries = new Map<string, Entry>();

  const must = (id: string): Entry => {
    const e = entries.get(id);
    if (!e) throw new ServiceError('not_found', 404, `pty ${id} not found`);
    return e;
  };
  const running = (id: string): IPty => {
    const e = must(id);
    if (!e.proc) throw new ServiceError('pty_exited', 409, `pty ${id} has exited`);
    return e.proc;
  };

  function push(e: Entry, chunk: string): void {
    e.chunks.push(chunk);
    e.size += chunk.length;
    while (e.size > max && e.chunks.length > 1) {
      const first = e.chunks.shift() ?? '';
      e.size -= first.length;
    }
    const only = e.chunks[0];
    if (e.size > max && e.chunks.length === 1 && only !== undefined) {
      const trimmed = only.slice(only.length - max);
      e.chunks[0] = trimmed;
      e.size = trimmed.length;
    }
  }

  return {
    spawn(o) {
      const id = randomUUID();
      const cols = o.cols ?? 120;
      const rows = o.rows ?? 36;
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
      Object.assign(env, o.env ?? {}, { TERM: 'xterm-256color', COLORTERM: 'truecolor' });
      const proc = ptySpawn(o.command, o.args, { name: 'xterm-256color', cols, rows, cwd: o.cwd, env });
      const info: PtyInfo = {
        id,
        sessionPk: o.sessionPk ?? null,
        command: o.command,
        args: [...o.args],
        cwd: o.cwd,
        pid: proc.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
        cols,
        rows,
      };
      const entry: Entry = { info, proc, chunks: [], size: 0, listeners: new Set() };
      entries.set(id, entry);
      proc.onData((d) => {
        push(entry, d);
        for (const l of [...entry.listeners]) l(d);
      });
      proc.onExit(({ exitCode }) => {
        entry.proc = null;
        info.exitedAt = new Date().toISOString();
        info.exitCode = exitCode;
        opts.bus.emit({ type: 'pty.exited', ptyId: id, code: exitCode });
      });
      return { ...info, args: [...info.args] };
    },
    write(id, data) {
      running(id).write(data);
    },
    async sendText(id, text) {
      running(id);
      await sendText((d) => running(id).write(d), text);
    },
    resize(id, cols, rows) {
      const e = must(id);
      if (!e.proc) return;
      e.proc.resize(cols, rows);
      e.info.cols = cols;
      e.info.rows = rows;
    },
    kill(id, signal = 'SIGHUP') {
      must(id).proc?.kill(signal);
    },
    attach(id, onData) {
      const e = must(id);
      e.listeners.add(onData);
      return {
        scrollback: e.chunks.join(''),
        detach: () => {
          e.listeners.delete(onData);
        },
      };
    },
    list() {
      return [...entries.values()]
        .map((e) => ({ ...e.info, args: [...e.info.args] }))
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    },
    get(id) {
      const e = entries.get(id);
      return e ? { ...e.info, args: [...e.info.args] } : undefined;
    },
    remove(id) {
      const e = must(id);
      e.proc?.kill('SIGHUP');
      e.listeners.clear();
      entries.delete(id);
    },
    disposeAll() {
      for (const e of entries.values()) {
        e.proc?.kill('SIGHUP');
        e.listeners.clear();
      }
      entries.clear();
    },
  };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/live apps/daemon/src/pty`
Expected: PASS (7 tests)

- [ ] **Step 6: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(daemon): add event bus and node-pty manager with scrollback"
```

---

### Task 9: Project service (F13 auto-detect)

**Files:**
- Create: `apps/daemon/src/services/projects.ts`, `apps/daemon/src/services/projects.test.ts`

**Interfaces:**
- Consumes: `OrcPaths`, `saveConfig` (Task 6); `OrcDb`, `listSessionCwds`, `projectStats`, `setSessionProject`, `replaceProjects` (Task 7); `ServiceError` (Task 8); `detectProjects`, `DEFAULT_TICKET_REGEX`, `DEFAULT_PROD_PATTERNS`, `compileTicketRegex`, `compileProdPatterns`, `DeriveConfig`, `Project` (core); `ProjectConfig`, `OrcConfig` (api-contract).
- Produces:
  ```ts
  export type ProjectUpdate = Omit<Partial<ProjectConfig>, 'features'> & { features?: Partial<ProjectConfig['features']> };
  export interface ProjectService { list(): Project[]; resolve(cwd: string): string | null; get(id: string): ProjectConfig | null; update(id: string, patch: ProjectUpdate): ProjectConfig }
  export interface ProjectServiceImpl extends ProjectService { ensureDefaults(): void; ensureDetected(): { added: string[] }; deriveConfigFor(cwd: string | null): DeriveConfig; syncTable(): void }
  export interface ProjectServiceDeps { db: OrcDb; paths: OrcPaths; config: () => OrcConfig; saveConfig: (cfg: OrcConfig) => void }
  export function projectConfigFor(d: { id: string; name: string; pathPrefix: string }): ProjectConfig
  export function createProjectService(deps: ProjectServiceDeps): ProjectServiceImpl   // calls ensureDefaults() once
  ```
  Behaviour: the `wakecap` project (`${userHome}/Wakecap`, ticket regex, prod patterns, `workStreams`/`prodBadges` on) always exists. `resolve` uses the longest matching path prefix (path-boundary aware). Sessions outside every project get `{ ticketRegex: null, prodPatterns: DEFAULT_PROD_PATTERNS }`. `list()` puts `config.defaultProjectId` first, then orders by last activity. `update` rejects unknown ids (404) and invalid results (400 `validation_failed`), and re-resolves every session when prefixes change. Nothing is ever deleted.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/services/projects.test.ts`
```ts
import { OrcConfig } from '@orc/api-contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeSession } from '../../test/factories.ts';
import { useTempHomes } from '../../test/helpers.ts';
import { loadConfig, saveConfig } from '../config.ts';
import { type OrcDb, openDb } from '../db/client.ts';
import { getSessionByPk, upsertSession } from '../db/repos/sessions.ts';
import { listProjectRows } from '../db/repos/projects.ts';
import { createProjectService, type ProjectServiceImpl } from './projects.ts';

const errorOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
};

describe('project service', () => {
  const homes = useTempHomes();
  let db: OrcDb;
  let cfg: OrcConfig;
  let svc: ProjectServiceImpl;

  beforeEach(() => {
    db = openDb(homes.paths.dbFile).db;
    cfg = loadConfig(homes.paths);
    svc = createProjectService({
      db,
      paths: homes.paths,
      config: () => cfg,
      saveConfig: (next) => {
        saveConfig(homes.paths, next);
        cfg = next;
      },
    });
  });

  it('creates the wakecap default project with its features', () => {
    expect(cfg.projects).toHaveLength(1);
    expect(svc.get('wakecap')).toMatchObject({
      id: 'wakecap',
      name: 'Wakecap',
      pathPrefixes: ['/Users/test/Wakecap'],
      ticketRegex: '\\b(SAF|ALU|SUPRT|SAK|TAN)-\\d+\\b',
      features: { workStreams: true, prodBadges: true, recaps: true },
    });
    expect(svc.get('wakecap')?.prodPatterns).toContain('production_server_db');
    expect(loadConfig(homes.paths).projects.map((p) => p.id)).toEqual(['wakecap']);
    expect(listProjectRows(db).map((p) => p.id)).toEqual(['wakecap']);
  });

  it('resolves by longest prefix on path boundaries', () => {
    svc.update('wakecap', { pathPrefixes: ['/Users/test/Wakecap', '/Users/test/Wakecap/Backend'] });
    cfg = OrcConfig.parse({
      ...cfg,
      projects: [
        ...cfg.projects,
        { id: 'backend', name: 'Backend', pathPrefixes: ['/Users/test/Wakecap/Backend/svc'] },
      ],
    });
    expect(svc.resolve('/Users/test/Wakecap/Backend/svc/src')).toBe('backend');
    expect(svc.resolve('/Users/test/Wakecap')).toBe('wakecap');
    expect(svc.resolve('/Users/test/WakecapOld')).toBeNull();
    expect(svc.resolve('')).toBeNull();
  });

  it('detects projects from session cwds and reassigns sessions', () => {
    upsertSession(db, makeSession({ id: 'w', projectId: null, startCwd: '/Users/test/Wakecap/Backend/svc', lastActivityAt: '2026-09-06T00:00:00.000Z' }));
    upsertSession(db, makeSession({ id: 'f', projectId: null, startCwd: '/Users/test/Forza', lastActivityAt: '2026-09-04T00:00:00.000Z' }));
    upsertSession(db, makeSession({ id: 's', projectId: null, startCwd: '/Users/test/Stocks/EGX', lastActivityAt: '2026-09-02T00:00:00.000Z' }));
    const { added } = svc.ensureDetected();
    expect(added).toEqual(['forza', 'stocks']);
    expect(getSessionByPk(db, 'claude:w')?.projectId).toBe('wakecap');
    expect(getSessionByPk(db, 'claude:f')?.projectId).toBe('forza');
    expect(svc.get('forza')).toMatchObject({ ticketRegex: null, prodPatterns: [], features: { workStreams: false } });
    expect(svc.list().map((p) => [p.id, p.sessionCount])).toEqual([
      ['wakecap', 1],
      ['forza', 1],
      ['stocks', 1],
    ]);
    expect(svc.ensureDetected().added).toEqual([]);
  });

  it('builds derive config per project', () => {
    const w = svc.deriveConfigFor('/Users/test/Wakecap/x');
    expect(w.ticketRegex?.source).toBe('\\b(SAF|ALU|SUPRT|SAK|TAN)-\\d+\\b');
    const other = svc.deriveConfigFor('/Users/test/Elsewhere');
    expect(other.ticketRegex).toBeNull();
    expect(other.prodPatterns.length).toBeGreaterThan(0);
    expect(svc.deriveConfigFor(null).ticketRegex).toBeNull();
  });

  it('updates, validates and hides without deleting', () => {
    const next = svc.update('wakecap', { name: 'WakeCap', hidden: true, openIn: 'terminal', features: { recaps: false } });
    expect(next).toMatchObject({ name: 'WakeCap', hidden: true, openIn: 'terminal', features: { workStreams: true, recaps: false } });
    expect(svc.list()[0]).toMatchObject({ id: 'wakecap', hidden: true });
    expect(errorOf(() => svc.update('nope', { name: 'x' }))).toMatchObject({ code: 'not_found', status: 404 });
    expect(errorOf(() => svc.update('wakecap', { pathPrefixes: [] }))).toMatchObject({
      code: 'validation_failed',
      status: 400,
    });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/projects`
Expected: FAIL, `Cannot find module './projects.ts'`

- [ ] **Step 3: Implement the service**

`apps/daemon/src/services/projects.ts`
```ts
import { type OrcConfig, ProjectConfig } from '@orc/api-contract';
import {
  compileProdPatterns,
  compileTicketRegex,
  DEFAULT_PROD_PATTERNS,
  DEFAULT_TICKET_REGEX,
  type DeriveConfig,
  detectProjects,
  type Project,
} from '@orc/core';
import type { OrcPaths } from '../config.ts';
import type { OrcDb } from '../db/client.ts';
import { replaceProjects } from '../db/repos/projects.ts';
import { listSessionCwds, projectStats, setSessionProject } from '../db/repos/sessions.ts';
import { ServiceError } from './errors.ts';

/** Partial<ProjectConfig> is assignable to this; `features` may also be partial (PATCH semantics). */
export type ProjectUpdate = Omit<Partial<ProjectConfig>, 'features'> & { features?: Partial<ProjectConfig['features']> };

export interface ProjectService {
  list(): Project[];
  resolve(cwd: string): string | null;
  get(id: string): ProjectConfig | null;
  update(id: string, patch: ProjectUpdate): ProjectConfig;
}

export interface ProjectServiceImpl extends ProjectService {
  ensureDefaults(): void;
  ensureDetected(): { added: string[] };
  deriveConfigFor(cwd: string | null): DeriveConfig;
  syncTable(): void;
}

export interface ProjectServiceDeps {
  db: OrcDb;
  paths: OrcPaths;
  config: () => OrcConfig;
  saveConfig: (cfg: OrcConfig) => void;
}

export const WAKECAP_ID = 'wakecap';

export function projectConfigFor(d: { id: string; name: string; pathPrefix: string }): ProjectConfig {
  const isWakecap = d.id === WAKECAP_ID;
  return ProjectConfig.parse({
    id: d.id,
    name: d.name,
    pathPrefixes: [d.pathPrefix],
    ticketRegex: isWakecap ? DEFAULT_TICKET_REGEX : null,
    prodPatterns: isWakecap ? DEFAULT_PROD_PATTERNS : [],
    features: isWakecap ? { workStreams: true, prodBadges: true, recaps: true } : {},
  });
}

const within = (cwd: string, prefix: string) => cwd === prefix || cwd.startsWith(`${prefix.replace(/\/+$/, '')}/`);

export function createProjectService(deps: ProjectServiceDeps): ProjectServiceImpl {
  const { db } = deps;
  const compiled = new Map<string, DeriveConfig>();
  const fallback: DeriveConfig = { ticketRegex: null, prodPatterns: compileProdPatterns(DEFAULT_PROD_PATTERNS) };

  function save(projects: ProjectConfig[]): void {
    deps.saveConfig({ ...deps.config(), projects });
    compiled.clear();
    svc.syncTable();
  }

  function resolve(cwd: string): string | null {
    if (!cwd) return null;
    let best: { id: string; len: number } | null = null;
    for (const p of deps.config().projects) {
      for (const prefix of p.pathPrefixes) {
        if (within(cwd, prefix) && (!best || prefix.length > best.len)) best = { id: p.id, len: prefix.length };
      }
    }
    return best?.id ?? null;
  }

  function reassignAll(): void {
    for (const s of listSessionCwds(db)) {
      const id = resolve(s.startCwd);
      if (id !== s.projectId) setSessionProject(db, s.pk, id);
    }
  }

  const svc: ProjectServiceImpl = {
    list() {
      const cfg = deps.config();
      const stats = new Map(projectStats(db).map((s) => [s.projectId, s]));
      return cfg.projects
        .map((p) => ({
          id: p.id,
          name: p.name,
          pathPrefixes: [...p.pathPrefixes],
          hidden: p.hidden,
          lastActivityAt: stats.get(p.id)?.lastActivityAt ?? null,
          sessionCount: stats.get(p.id)?.sessionCount ?? 0,
        }))
        .sort((a, b) => {
          if (a.id === cfg.defaultProjectId) return -1;
          if (b.id === cfg.defaultProjectId) return 1;
          return (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '');
        });
    },
    resolve,
    get(id) {
      return deps.config().projects.find((p) => p.id === id) ?? null;
    },
    update(id, patch) {
      const projects = deps.config().projects;
      const cur = projects.find((p) => p.id === id);
      if (!cur) throw new ServiceError('not_found', 404, `project ${id} not found`);
      const parsed = ProjectConfig.safeParse({
        ...cur,
        ...patch,
        id: cur.id,
        features: { ...cur.features, ...(patch.features ?? {}) },
      });
      if (!parsed.success || parsed.data.pathPrefixes.length === 0) {
        throw new ServiceError('validation_failed', 400, 'invalid project update', parsed.success ? undefined : parsed.error.issues);
      }
      const next = parsed.data;
      save(projects.map((p) => (p.id === id ? next : p)));
      if (JSON.stringify(next.pathPrefixes) !== JSON.stringify(cur.pathPrefixes)) reassignAll();
      return next;
    },
    ensureDefaults() {
      const projects = deps.config().projects;
      if (projects.some((p) => p.id === WAKECAP_ID)) {
        svc.syncTable();
        return;
      }
      const home = deps.paths.userHome.replace(/\/+$/, '');
      save([projectConfigFor({ id: WAKECAP_ID, name: 'Wakecap', pathPrefix: `${home}/Wakecap` }), ...projects]);
    },
    ensureDetected() {
      const home = deps.paths.userHome.replace(/\/+$/, '');
      const samples = listSessionCwds(db).map((s) => ({ cwd: s.startCwd, lastActivityAt: s.lastActivityAt }));
      const projects = [...deps.config().projects];
      const covered = (prefix: string) => projects.some((p) => p.pathPrefixes.some((q) => within(prefix, q)));
      const added: string[] = [];
      for (const d of detectProjects(samples, home)) {
        // Sessions started directly in the home folder stay unassigned ("All projects" shows them);
        // a home-wide project would swallow every future top-level folder.
        if (d.pathPrefix === home || covered(d.pathPrefix) || projects.some((p) => p.id === d.id)) continue;
        projects.push(projectConfigFor(d));
        added.push(d.id);
      }
      if (added.length > 0) save(projects);
      reassignAll();
      return { added };
    },
    deriveConfigFor(cwd) {
      const id = cwd ? resolve(cwd) : null;
      if (!id) return fallback;
      const hit = compiled.get(id);
      if (hit) return hit;
      const p = deps.config().projects.find((x) => x.id === id);
      const cfg: DeriveConfig = p
        ? { ticketRegex: compileTicketRegex(p.ticketRegex), prodPatterns: compileProdPatterns(p.prodPatterns) }
        : fallback;
      compiled.set(id, cfg);
      return cfg;
    },
    syncTable() {
      replaceProjects(
        db,
        deps.config().projects.map((p) => ({ id: p.id, name: p.name, pathPrefixes: p.pathPrefixes, hidden: p.hidden })),
      );
    },
  };

  svc.ensureDefaults();
  return svc;
}
```

Detection note: `detectProjects` returns roots ordered by recent activity; a root already covered by a configured prefix (e.g. `/Users/test/Wakecap`) or equal to the user home is skipped, so `added` for the fixture-like data is `['forza', 'stocks']`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run apps/daemon/src/services/projects`
Expected: PASS (5 tests)

- [ ] **Step 5: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon
git commit -m "feat(daemon): add project service with auto-detection and wakecap defaults"
```

---

### Task 10: Indexer (startup scan, byte offsets, chokidar watch)

**Files:**
- Create: `apps/daemon/src/indexer/file-kinds.ts`, `apps/daemon/src/indexer/indexer.ts`
- Create: `apps/daemon/src/indexer/file-kinds.test.ts`, `apps/daemon/src/indexer/indexer.test.ts`
- Modify: `apps/daemon/package.json` (chokidar)

**Interfaces:**
- Consumes: `readJsonlFrom`, `parseJsonLine`, Claude/Codex aggregates, `parseHistoryLine`, `historyPromptsToSession`, `parseSubagentMeta`, `claudeStateToAgentNode`, `agentIdFromPath` (core); repos from Task 7; `ProjectServiceImpl` (Task 9); `EventBus` (Task 8); `OrcPaths` (Task 6).
- Produces:
  ```ts
  // indexer/file-kinds.ts
  export type IndexedFileKind = 'claude-main' | 'claude-subagent' | 'claude-subagent-meta' | 'claude-history' | 'codex-rollout';
  export interface ClassifiedFile { kind: IndexedFileKind; sessionId: string | null; agentId: string | null }
  export function classifyPath(path: string, paths: OrcPaths): ClassifiedFile | null     // null for *.key and anything else
  export function listIndexableFiles(paths: OrcPaths): string[]                         // main, subagents, codex, then history.jsonl
  // indexer/indexer.ts
  export interface Indexer { scanAll(): Promise<{ files: number; sessions: number; ms: number }>; indexFile(path: string): Promise<void>; watch(): Promise<void>; close(): Promise<void>; unknownTypes(): Record<string, number> }
  export interface IndexerDeps { db: OrcDb; raw: Database.Database; paths: OrcPaths; projects: ProjectServiceImpl; bus: EventBus; log: Logger; debounceMs?: number }
  export function createIndexer(deps: IndexerDeps): Indexer
  ```
  Behaviour: one SQLite transaction per file batch; `(size, mtimeMs)` unchanged → skip; file shrank → re-read from 0 and replace that file's events; aggregate state is stored in `file_offsets.state_json`, so appends continue `seq`/`turn`; after each batch the bus gets `session.indexed`; `scanAll` emits `index.progress` (start, every 25 files, end) and then runs `projects.ensureDetected()`. History-only sessions are written with origin `history` and never overwrite a transcript session. A deleted transcript flips the session to `prompts-only` (events are kept). All tasks run through one serial queue. The indexer only reads under `CLAUDE_HOME`/`CODEX_HOME`.

- [ ] **Step 1: Install chokidar**

Run: `pnpm --filter @orc/daemon add chokidar@^5.0.0`

- [ ] **Step 2: Write the failing tests**

`apps/daemon/src/indexer/file-kinds.test.ts`
```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempHomes } from '../../test/helpers.ts';
import { classifyPath, listIndexableFiles } from './file-kinds.ts';

describe('file kinds', () => {
  const homes = useTempHomes();

  it('classifies known paths', () => {
    const c = (rel: string) => classifyPath(join(homes.claudeHome, rel), homes.paths);
    expect(c('projects/-Users-test-Wakecap/s-basic.jsonl')).toEqual({ kind: 'claude-main', sessionId: 's-basic', agentId: null });
    expect(c('projects/-Users-test-Wakecap/s-subagents/subagents/agent-ag2.jsonl')).toEqual({
      kind: 'claude-subagent',
      sessionId: 's-subagents',
      agentId: 'ag2',
    });
    expect(c('projects/-Users-test-Wakecap/s-subagents/subagents/agent-ag2.meta.json')?.kind).toBe('claude-subagent-meta');
    expect(c('history.jsonl')?.kind).toBe('claude-history');
    expect(c('sessions/41001.json')).toBeNull();
    expect(c('sessions/41001.abc.key')).toBeNull();
    expect(c('projects/-Users-test-Wakecap/s-basic/tool-results/x.txt')).toBeNull();
    expect(
      classifyPath(join(homes.codexHome, 'sessions/2026/09/01/rollout-2026-09-01T09-00-00-x.jsonl'), homes.paths)?.kind,
    ).toBe('codex-rollout');
    expect(classifyPath(join(homes.codexHome, 'history.jsonl'), homes.paths)).toBeNull();
  });

  it('lists files in indexing order', () => {
    const files = listIndexableFiles(homes.paths).map((f) => f.replace(`${homes.root}/`, ''));
    expect(files).toEqual([
      'claude/projects/-Users-test-Wakecap/s-basic.jsonl',
      'claude/projects/-Users-test-Wakecap/s-drift.jsonl',
      'claude/projects/-Users-test-Wakecap/s-errors.jsonl',
      'claude/projects/-Users-test-Wakecap/s-prlink.jsonl',
      'claude/projects/-Users-test-Wakecap/s-subagents.jsonl',
      'claude/projects/-Users-test-Wakecap/s-unknown.jsonl',
      'claude/projects/-Users-test-Wakecap/s-subagents/subagents/agent-ag1.jsonl',
      'claude/projects/-Users-test-Wakecap/s-subagents/subagents/agent-ag2.jsonl',
      'claude/projects/-Users-test-Wakecap/s-subagents/subagents/agent-ag3.jsonl',
      'codex/sessions/2026/03/10/rollout-2026-03-10T09-00-00-c0dex000-0000-0000-0000-000000000002.jsonl',
      'codex/sessions/2026/09/01/rollout-2026-09-01T09-00-00-c0dex000-0000-0000-0000-000000000001.jsonl',
      'claude/history.jsonl',
    ]);
  });
});
```

`apps/daemon/src/indexer/indexer.test.ts`
```ts
import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { OrcConfig } from '@orc/api-contract';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempHomes, writeClaudeSession } from '../../test/helpers.ts';
import { loadConfig, saveConfig } from '../config.ts';
import { type OrcDb, openDb } from '../db/client.ts';
import { listAgents } from '../db/repos/agents.ts';
import { countEvents, listEvents } from '../db/repos/events.ts';
import { getSessionByPk, getSessionOrigin } from '../db/repos/sessions.ts';
import { type BusEvent, createEventBus } from '../live/event-bus.ts';
import { createProjectService } from '../services/projects.ts';
import { createIndexer, type Indexer } from './indexer.ts';

const WAKE = 'projects/-Users-test-Wakecap';

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = `${statSync(p).mtimeMs}:${createHash('sha1').update(readFileSync(p)).digest('hex')}`;
    }
  };
  walk(dir);
  return out;
}

describe('indexer', () => {
  const homes = useTempHomes();
  let db: OrcDb;
  let close: () => void;
  let indexer: Indexer;
  let events: BusEvent[];

  beforeEach(() => {
    const opened = openDb(homes.paths.dbFile);
    db = opened.db;
    close = opened.close;
    let cfg: OrcConfig = loadConfig(homes.paths);
    const projects = createProjectService({
      db,
      paths: homes.paths,
      config: () => cfg,
      saveConfig: (next) => {
        saveConfig(homes.paths, next);
        cfg = next;
      },
    });
    const bus = createEventBus();
    events = [];
    bus.on('index.progress', (e) => events.push(e));
    bus.on('session.indexed', (e) => events.push(e));
    indexer = createIndexer({ db, raw: opened.raw, paths: homes.paths, projects, bus, log: pino({ level: 'silent' }), debounceMs: 20 });
  });

  afterEach(async () => {
    await indexer.close();
    close();
  });

  it('indexes the fixture homes', async () => {
    const stats = await indexer.scanAll();
    expect(stats).toMatchObject({ files: 12, sessions: 10 });
    expect(events.filter((e) => e.type === 'index.progress').at(-1)).toEqual({ type: 'index.progress', done: 12, total: 12 });
    expect(events.some((e) => e.type === 'session.indexed' && e.pk === 'claude:s-basic')).toBe(true);

    expect(getSessionByPk(db, 'claude:s-basic')).toMatchObject({
      availability: 'resumable',
      projectId: 'wakecap',
      promptCount: 3,
      name: 'Notification service test check',
    });
    expect(getSessionOrigin(db, 'claude:s-basic')).toBe('transcript');
    expect(countEvents(db, 'claude:s-basic')).toBe(10);
    expect(getSessionByPk(db, 'claude:s-old-prompts-only')).toMatchObject({
      availability: 'prompts-only',
      projectId: 'wakecap',
      name: 'old session from december',
    });
    expect(getSessionByPk(db, 'claude:s-errors')?.projectId).toBe('forza');
    expect(getSessionByPk(db, 'claude:s-stocks')?.projectId).toBe('stocks');
    expect(getSessionByPk(db, 'codex:c0dex000-0000-0000-0000-000000000002')?.flags.automated).toBe(true);
    expect(getSessionByPk(db, 'codex:c0dex000-0000-0000-0000-000000000001')?.projectId).toBe('wakecap');
    expect(getSessionByPk(db, 'claude:s-subagents')?.flags.hasSubagents).toBe(true);
    const agents = listAgents(db, 'claude:s-subagents');
    expect(agents.map((a) => [a.id, a.parentId, a.background])).toEqual([
      ['ag1', null, true],
      ['ag2', 'ag1', false],
      ['ag3', 'ag2', false],
    ]);
    expect(listEvents(db, 'claude:s-subagents', { agentId: 'ag1' }).items).toHaveLength(2);
    expect(indexer.unknownTypes()).toMatchObject({ 'future-record-kind': 1 });
  });

  it('is idempotent and never writes to the tool homes', async () => {
    const before = { ...snapshot(homes.claudeHome), ...snapshot(homes.codexHome) };
    await indexer.scanAll();
    await indexer.scanAll();
    expect(countEvents(db, 'claude:s-basic')).toBe(10);
    expect({ ...snapshot(homes.claudeHome), ...snapshot(homes.codexHome) }).toEqual(before);
  });

  it('continues from the stored offset on append', async () => {
    await indexer.scanAll();
    const file = join(homes.claudeHome, WAKE, 's-basic.jsonl');
    appendFileSync(
      file,
      `${JSON.stringify({ type: 'user', uuid: 'u5', parentUuid: 'u4', isSidechain: false, sessionId: 's-basic', timestamp: '2026-09-01T09:10:00.000Z', cwd: '/Users/test/Wakecap', message: { role: 'user', content: 'one more thing' } })}\n`,
    );
    await indexer.indexFile(file);
    const page = listEvents(db, 'claude:s-basic', { afterSeq: 10 });
    expect(page.items.map((e) => [e.seq, e.turn, e.text])).toEqual([[11, 4, 'one more thing']]);
    expect(getSessionByPk(db, 'claude:s-basic')).toMatchObject({ promptCount: 4, lastActivityAt: '2026-09-01T09:10:00.000Z' });
  });

  it('picks up a truncated line once it is completed', async () => {
    await indexer.scanAll();
    const file = join(homes.claudeHome, WAKE, 's-errors.jsonl');
    expect(countEvents(db, 'claude:s-errors')).toBe(2);
    appendFileSync(
      file,
      '5.000Z","cwd":"/Users/test/Forza","message":{"id":"em2","role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"recovered"}],"usage":{"input_tokens":1,"output_tokens":1}}}\n',
    );
    await indexer.indexFile(file);
    expect(listEvents(db, 'claude:s-errors', {}).items.at(-1)?.text).toBe('recovered');
    expect(getSessionByPk(db, 'claude:s-errors')?.models).toEqual(['claude-opus-5']);
  });

  it('keeps events when a transcript disappears and history does not clobber it', async () => {
    await indexer.scanAll();
    const file = join(homes.claudeHome, WAKE, 's-basic.jsonl');
    rmSync(file);
    await indexer.indexFile(file);
    expect(getSessionByPk(db, 'claude:s-basic')).toMatchObject({ availability: 'prompts-only', transcriptPath: null });
    expect(countEvents(db, 'claude:s-basic')).toBe(10);
    const history = join(homes.claudeHome, 'history.jsonl');
    appendFileSync(history, `${JSON.stringify({ display: 'later', pastedContents: {}, timestamp: 1788260000000, project: '/Users/test/Wakecap', sessionId: 's-basic' })}\n`);
    await indexer.indexFile(history);
    expect(getSessionByPk(db, 'claude:s-basic')).toMatchObject({ promptCount: 3, name: 'Notification service test check' });
  });

  it('re-reads a file that shrank', async () => {
    await indexer.scanAll();
    const file = join(homes.claudeHome, WAKE, 's-drift.jsonl');
    const first = readFileSync(file, 'utf8').split('\n')[0] ?? '';
    rmSync(file);
    appendFileSync(file, `${first}\n`);
    await indexer.indexFile(file);
    expect(countEvents(db, 'claude:s-drift')).toBe(1);
  });

  it('watches for new transcripts', async () => {
    await indexer.scanAll();
    await indexer.watch();
    writeClaudeSession(homes, { sessionId: 's-new', cwd: join(homes.root, 'work', 'Wakecap'), prompt: 'watched prompt' });
    await vi.waitFor(() => expect(getSessionByPk(db, 'claude:s-new')?.firstPrompt).toBe('watched prompt'), {
      timeout: 8000,
      interval: 100,
    });
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/indexer`
Expected: FAIL, `Cannot find module './file-kinds.ts'` / `'./indexer.ts'`

- [ ] **Step 4: Implement file classification**

`apps/daemon/src/indexer/file-kinds.ts`
```ts
import { type Dirent, existsSync, readdirSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { agentIdFromPath } from '@orc/core';
import type { OrcPaths } from '../config.ts';

export type IndexedFileKind = 'claude-main' | 'claude-subagent' | 'claude-subagent-meta' | 'claude-history' | 'codex-rollout';

export interface ClassifiedFile {
  kind: IndexedFileKind;
  sessionId: string | null;
  agentId: string | null;
}

const ROLLOUT = /^rollout-.*\.jsonl$/;

export function classifyPath(path: string, paths: OrcPaths): ClassifiedFile | null {
  if (path.endsWith('.key')) return null;
  if (path === join(paths.claudeHome, 'history.jsonl')) return { kind: 'claude-history', sessionId: null, agentId: null };
  const projectsDir = `${join(paths.claudeHome, 'projects')}${sep}`;
  if (path.startsWith(projectsDir)) {
    const rel = path.slice(projectsDir.length).split(sep);
    const [, second, third, fourth] = rel;
    if (rel.length === 2 && second?.endsWith('.jsonl')) {
      return { kind: 'claude-main', sessionId: basename(second, '.jsonl'), agentId: null };
    }
    if (rel.length === 4 && second && third === 'subagents' && fourth) {
      const agentId = agentIdFromPath(fourth);
      if (!agentId) return null;
      if (fourth.endsWith('.jsonl')) return { kind: 'claude-subagent', sessionId: second, agentId };
      if (fourth.endsWith('.meta.json')) return { kind: 'claude-subagent-meta', sessionId: second, agentId };
    }
    return null;
  }
  const codexDir = `${join(paths.codexHome, 'sessions')}${sep}`;
  if (path.startsWith(codexDir) && ROLLOUT.test(basename(path))) {
    return { kind: 'codex-rollout', sessionId: null, agentId: null };
  }
  return null;
}

function dirents(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function listIndexableFiles(paths: OrcPaths): string[] {
  const main: string[] = [];
  const subs: string[] = [];
  const codex: string[] = [];
  const projectsDir = join(paths.claudeHome, 'projects');
  for (const d of dirents(projectsDir)) {
    if (!d.isDirectory()) continue;
    const dir = join(projectsDir, d.name);
    for (const f of dirents(dir)) {
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        main.push(join(dir, f.name));
      } else if (f.isDirectory()) {
        const subDir = join(dir, f.name, 'subagents');
        for (const s of dirents(subDir)) {
          if (s.isFile() && /^agent-.+\.jsonl$/.test(s.name)) subs.push(join(subDir, s.name));
        }
      }
    }
  }
  const walk = (dir: string): void => {
    for (const d of dirents(dir)) {
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.isFile() && ROLLOUT.test(d.name)) codex.push(p);
    }
  };
  walk(join(paths.codexHome, 'sessions'));
  const history = join(paths.claudeHome, 'history.jsonl');
  return [...main.sort(), ...subs.sort(), ...codex.sort(), ...(existsSync(history) ? [history] : [])];
}
```

- [ ] **Step 5: Implement the indexer**

`apps/daemon/src/indexer/indexer.ts`
```ts
import { existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  type ClaudeAggState,
  type CodexAggState,
  claudeStateToAgentNode,
  claudeStateToSession,
  codexStateToSession,
  createClaudeAggState,
  createCodexAggState,
  type DeriveConfig,
  type HistoryPrompt,
  historyPromptsToSession,
  ingestClaudeRecord,
  ingestCodexRecord,
  parseHistoryLine,
  parseJsonLine,
  parseSubagentMeta,
  readJsonlFrom,
  type SubagentMeta,
  type TailResult,
  type TimelineEvent,
} from '@orc/core';
import type Database from 'better-sqlite3';
import { type FSWatcher, watch as chokidarWatch } from 'chokidar';
import type { Logger } from 'pino';
import type { OrcPaths } from '../config.ts';
import type { OrcDb } from '../db/client.ts';
import { sessionPk } from '../db/keys.ts';
import { upsertAgent } from '../db/repos/agents.ts';
import { deleteEventsFor, insertEvents } from '../db/repos/events.ts';
import { deleteFileOffset, type FileOffsetRow, getFileOffset, putFileOffset } from '../db/repos/file-offsets.ts';
import { historyPromptsFor, insertHistoryPrompts } from '../db/repos/history.ts';
import {
  countSessions,
  getSessionOrigin,
  markHasSubagents,
  setSessionAvailability,
  upsertSession,
} from '../db/repos/sessions.ts';
import type { EventBus } from '../live/event-bus.ts';
import type { ProjectServiceImpl } from '../services/projects.ts';
import { type ClassifiedFile, classifyPath, type IndexedFileKind, listIndexableFiles } from './file-kinds.ts';

export interface Indexer {
  scanAll(): Promise<{ files: number; sessions: number; ms: number }>;
  indexFile(path: string): Promise<void>;
  watch(): Promise<void>;
  close(): Promise<void>;
  unknownTypes(): Record<string, number>;
}

export interface IndexerDeps {
  db: OrcDb;
  raw: Database.Database;
  paths: OrcPaths;
  projects: ProjectServiceImpl;
  bus: EventBus;
  log: Logger;
  debounceMs?: number;
}

interface FileStat {
  size: number;
  mtimeMs: number;
}

function readMeta(jsonlPath: string): SubagentMeta {
  try {
    return parseSubagentMeta(JSON.parse(readFileSync(jsonlPath.replace(/\.jsonl$/, '.meta.json'), 'utf8')));
  } catch {
    return parseSubagentMeta(null);
  }
}

export function createIndexer(deps: IndexerDeps): Indexer {
  const { db, raw, paths, projects, bus, log } = deps;
  const unknownByFile = new Map<string, Record<string, number>>();
  const timers = new Map<string, NodeJS.Timeout>();
  let detectTimer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  let queue: Promise<void> = Promise.resolve();
  const resolveCfg = (cwd: string | null): DeriveConfig => projects.deriveConfigFor(cwd);

  function enqueue(fn: () => Promise<void> | void): Promise<void> {
    const run = queue.then(fn);
    queue = run.catch((err: unknown) => {
      log.error({ err }, 'indexing task failed');
    });
    return run;
  }

  function offsetRow(
    path: string,
    kind: IndexedFileKind,
    st: FileStat,
    tail: TailResult,
    pk: string | null,
    agentId: string | null,
    stateJson: string | null,
  ): FileOffsetRow {
    return {
      path,
      kind,
      sessionPk: pk,
      agentId,
      size: st.size,
      mtimeMs: st.mtimeMs,
      offset: tail.nextOffset,
      stateJson,
      updatedAt: new Date().toISOString(),
    };
  }

  function applyClaude(path: string, cls: ClassifiedFile, st: FileStat, tail: TailResult, prevState: string | null, reset: boolean): void {
    const sessionId = cls.sessionId;
    if (!sessionId) return;
    const pk = sessionPk('claude', sessionId);
    const state = prevState ? (JSON.parse(prevState) as ClaudeAggState) : createClaudeAggState(sessionId, cls.agentId);
    const events: TimelineEvent[] = [];
    for (const line of tail.lines) events.push(...ingestClaudeRecord(state, parseJsonLine(line.text), resolveCfg));
    unknownByFile.set(path, state.unknownTypes);
    raw.transaction(() => {
      if (reset) deleteEventsFor(db, pk, cls.agentId);
      insertEvents(db, pk, events);
      if (cls.kind === 'claude-main') {
        const session = claudeStateToSession(state, {
          projectId: projects.resolve(state.startCwd ?? ''),
          transcriptPath: path,
          availability: 'resumable',
          hasSubagents: existsSync(join(dirname(path), sessionId, 'subagents')),
        });
        if (session) upsertSession(db, session, 'transcript');
      } else if (cls.agentId) {
        const node = claudeStateToAgentNode(state, readMeta(path), { sessionId, agentId: cls.agentId, transcriptPath: path });
        upsertAgent(db, pk, node);
        markHasSubagents(db, pk);
      }
      putFileOffset(db, offsetRow(path, cls.kind, st, tail, pk, cls.agentId, JSON.stringify(state)));
    })();
    bus.emit({ type: 'session.indexed', pk });
  }

  function applyCodex(path: string, st: FileStat, tail: TailResult, prevState: string | null, reset: boolean): void {
    const state = prevState ? (JSON.parse(prevState) as CodexAggState) : createCodexAggState();
    const events: TimelineEvent[] = [];
    for (const line of tail.lines) events.push(...ingestCodexRecord(state, parseJsonLine(line.text), resolveCfg));
    unknownByFile.set(path, state.unknownTypes);
    const pk = state.sessionId ? sessionPk('codex', state.sessionId) : null;
    raw.transaction(() => {
      if (pk) {
        if (reset) deleteEventsFor(db, pk, null);
        insertEvents(db, pk, events);
        const session = codexStateToSession(state, {
          projectId: projects.resolve(state.startCwd ?? ''),
          transcriptPath: path,
          availability: 'resumable',
        });
        if (session) upsertSession(db, session, 'transcript');
      }
      putFileOffset(db, offsetRow(path, 'codex-rollout', st, tail, pk, null, JSON.stringify(state)));
    })();
    if (pk) bus.emit({ type: 'session.indexed', pk });
  }

  function applyHistory(path: string, st: FileStat, tail: TailResult): void {
    const prompts = tail.lines
      .map((l) => parseHistoryLine(parseJsonLine(l.text)))
      .filter((p): p is HistoryPrompt => p !== null);
    const touched: string[] = [];
    raw.transaction(() => {
      insertHistoryPrompts(db, prompts);
      for (const sid of new Set(prompts.map((p) => p.sessionId))) {
        const pk = sessionPk('claude', sid);
        if (getSessionOrigin(db, pk) === 'transcript') continue;
        const all = historyPromptsFor(db, sid);
        const cwd = all[0]?.project ?? null;
        const session = historyPromptsToSession(all, {
          projectId: cwd ? projects.resolve(cwd) : null,
          ticketRegex: resolveCfg(cwd).ticketRegex,
        });
        if (session) {
          upsertSession(db, session, 'history');
          touched.push(pk);
        }
      }
      putFileOffset(db, offsetRow(path, 'claude-history', st, tail, null, null, null));
    })();
    for (const pk of touched) bus.emit({ type: 'session.indexed', pk });
  }

  function refreshAgentMeta(cls: ClassifiedFile, metaPath: string): void {
    const jsonlPath = metaPath.replace(/\.meta\.json$/, '.jsonl');
    const row = getFileOffset(db, jsonlPath);
    if (!row?.stateJson || !cls.sessionId || !cls.agentId) return;
    const state = JSON.parse(row.stateJson) as ClaudeAggState;
    const pk = sessionPk('claude', cls.sessionId);
    upsertAgent(db, pk, claudeStateToAgentNode(state, readMeta(jsonlPath), { sessionId: cls.sessionId, agentId: cls.agentId, transcriptPath: jsonlPath }));
    bus.emit({ type: 'session.indexed', pk });
  }

  function onMissing(path: string, cls: ClassifiedFile): void {
    const prev = getFileOffset(db, path);
    if (!prev) return;
    raw.transaction(() => {
      if ((cls.kind === 'claude-main' || cls.kind === 'codex-rollout') && prev.sessionPk) {
        setSessionAvailability(db, prev.sessionPk, 'prompts-only', null);
      }
      deleteFileOffset(db, path);
    })();
    if (prev.sessionPk) bus.emit({ type: 'session.indexed', pk: prev.sessionPk });
  }

  async function indexNow(path: string): Promise<void> {
    const cls = classifyPath(path, paths);
    if (!cls) return;
    if (cls.kind === 'claude-subagent-meta') {
      refreshAgentMeta(cls, path);
      return;
    }
    let st: FileStat;
    try {
      const s = await stat(path);
      st = { size: s.size, mtimeMs: Math.floor(s.mtimeMs) };
    } catch {
      onMissing(path, cls);
      return;
    }
    const prev = getFileOffset(db, path);
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return;
    const start = prev && st.size >= prev.offset ? prev.offset : 0;
    const reset = start === 0;
    const prevState = reset ? null : (prev?.stateJson ?? null);
    const tail = await readJsonlFrom(path, start);
    switch (cls.kind) {
      case 'claude-history':
        applyHistory(path, st, tail);
        break;
      case 'claude-main':
      case 'claude-subagent':
        applyClaude(path, cls, st, tail, prevState, reset);
        break;
      case 'codex-rollout':
        applyCodex(path, st, tail, prevState, reset);
        break;
    }
  }

  function scheduleDetect(): void {
    if (detectTimer) clearTimeout(detectTimer);
    detectTimer = setTimeout(() => {
      detectTimer = null;
      enqueue(() => {
        projects.ensureDetected();
      }).catch(() => undefined);
    }, 2000);
  }

  return {
    async scanAll() {
      const t0 = performance.now();
      const files = listIndexableFiles(paths);
      bus.emit({ type: 'index.progress', done: 0, total: files.length });
      let done = 0;
      for (const f of files) {
        await enqueue(() => indexNow(f)).catch(() => undefined);
        done += 1;
        if (done % 25 === 0 || done === files.length) bus.emit({ type: 'index.progress', done, total: files.length });
      }
      await enqueue(() => {
        projects.ensureDetected();
      });
      return { files: files.length, sessions: countSessions(db), ms: Math.round(performance.now() - t0) };
    },
    indexFile(path) {
      return enqueue(() => indexNow(path));
    },
    async watch() {
      const targets = [
        join(paths.claudeHome, 'projects'),
        join(paths.claudeHome, 'history.jsonl'),
        join(paths.codexHome, 'sessions'),
      ].filter((p) => existsSync(p));
      if (targets.length === 0) return;
      const w = chokidarWatch(targets, {
        ignoreInitial: true,
        ignored: (p, stats) =>
          p.endsWith('.key') ||
          basename(p) === 'tool-results' ||
          (stats?.isFile() === true && !p.endsWith('.jsonl') && !p.endsWith('.meta.json')),
      });
      watcher = w;
      const schedule = (p: string): void => {
        const t = timers.get(p);
        if (t) clearTimeout(t);
        timers.set(
          p,
          setTimeout(() => {
            timers.delete(p);
            enqueue(() => indexNow(p)).catch(() => undefined);
            scheduleDetect();
          }, deps.debounceMs ?? 100),
        );
      };
      w.on('add', schedule)
        .on('change', schedule)
        .on('unlink', schedule)
        .on('error', (err: unknown) => log.warn({ err }, 'watcher error'));
      await new Promise<void>((resolve) => {
        w.once('ready', () => resolve());
      });
    },
    async close() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      if (detectTimer) clearTimeout(detectTimer);
      detectTimer = null;
      await watcher?.close();
      watcher = null;
      await queue;
    },
    unknownTypes() {
      const out: Record<string, number> = {};
      for (const counts of unknownByFile.values()) {
        for (const [k, v] of Object.entries(counts)) out[k] = (out[k] ?? 0) + v;
      }
      return out;
    },
  };
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/indexer`
Expected: PASS (2 + 7 tests). The watch test can take a few seconds on macOS (FSEvents latency).

- [ ] **Step 7: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(daemon): index Claude and Codex history with byte offsets and file watching"
```

---

### Task 11: Session service, daemon context and test helpers

**Files:**
- Create: `apps/daemon/src/live/liveness.ts`, `apps/daemon/src/live/liveness.test.ts`
- Create: `apps/daemon/src/services/external.ts`, `apps/daemon/src/services/external.test.ts`
- Create: `apps/daemon/src/services/snippet.ts`
- Create: `apps/daemon/src/services/user-meta.ts`
- Create: `apps/daemon/src/services/sessions.ts`, `apps/daemon/src/services/sessions.test.ts`
- Create: `apps/daemon/src/context.ts`
- Modify: `apps/daemon/test/helpers.ts` (add `createTestContext`, `indexFixtures`), `apps/daemon/package.json` (execa)

**Interfaces:**
- Consumes: everything from Tasks 6–10.
- Produces:
  ```ts
  // live/liveness.ts
  export function isPidAlive(pid: number): boolean
  export function readClaudeRegistry(claudeHome: string): RegistryEntry[]            // only <digits>.json; never *.key
  export function findRegistryEntry(claudeHome: string, sessionId: string, alive: (pid: number) => boolean): (RegistryEntry & { alive: boolean }) | null
  // services/external.ts
  export type ExternalLauncher = (i: { cwd: string; command: string; args: string[]; openIn: 'vscode' | 'terminal' | 'finder' }) => Promise<void>;
  export type CommandRunner = (file: string, args: string[]) => Promise<unknown>;
  export function shellQuote(parts: string[]): string
  export function resumeCommandLine(cwd: string, command: string, args: string[]): string
  export function appleScriptString(s: string): string
  export function createExternalLauncher(run?: CommandRunner): ExternalLauncher
  // services/snippet.ts
  export function highlight(text: string, needle: string, radius?: number): string
  // services/user-meta.ts
  export interface UserMetaService { setPinned(pk, pinned): boolean; setLabels(pk, labels): string[]; labels(): string[]; views(): SavedView[]; saveView(i): SavedView; deleteView(id): boolean }
  export function createUserMetaService(db: OrcDb): UserMetaService
  // services/sessions.ts (contracts §11 + additions)
  export { sessionPk } from '../db/keys.ts';
  export interface SessionListQuery { q?; projectId?; source?; ticket?; pr?; from?; to?; model?; minCost?; maxCost?; skill?; hasSubagents?; touchedProd?; availability?; label?: string; pinned?: boolean; includeHidden?: boolean; includeAutomated?: boolean; limit?; cursor? }
  export type { SessionListItem } from '@orc/api-contract';
  export interface ResumeOptions { mode: 'embedded' | 'external'; fork?: boolean; popOut?: boolean; cols?: number; rows?: number }
  export interface SessionService {
    list(q: SessionListQuery): { items: SessionListItem[]; nextCursor: string | null };
    get(source: Source, id: string): Session | null;
    getByPk(pk: string): Session | null;
    events(source: Source, id: string, opts: { agentId?: string | null; afterSeq?: number; limit?: number }): { items: TimelineEvent[]; nextSeq: number | null };
    agents(source: Source, id: string): AgentNode[];
    setLive(pk: string, live: LiveState | null): void;
    resume(source: Source, id: string, opts: ResumeOptions): Promise<{ ptyId: string } | { launched: 'external'; command: string }>;
  }
  export interface SessionServiceDeps { db: OrcDb; paths: OrcPaths; config: () => OrcConfig; bus: EventBus; pty: PtyManager; projects: ProjectServiceImpl; launchExternal: ExternalLauncher; isPidAlive?: (pid: number) => boolean }
  export function buildResumeCommand(s: Pick<Session, 'source' | 'id'>, cfg: OrcConfig, fork: boolean): { command: string; args: string[] }
  export function encodeCursor(c: { lastActivityAt: string; pk: string }): string
  export function decodeCursor(s: string): { lastActivityAt: string; pk: string }     // ServiceError 400 on garbage
  export function createSessionService(deps: SessionServiceDeps): SessionService
  // context.ts
  export interface DaemonContext { paths: OrcPaths; config: () => OrcConfig; db: OrcDb; bus: EventBus; log: Logger; pty: PtyManager; sessions: SessionService; projects: ProjectServiceImpl; userMeta: UserMetaService }
  export interface BuildContextOptions { paths: OrcPaths; log?: Logger; launchExternal?: ExternalLauncher; isPidAlive?: (pid: number) => boolean }
  export function buildContext(o: BuildContextOptions): { ctx: DaemonContext; raw: Database.Database; saveConfig(cfg: OrcConfig): void; close(): void }
  // test/helpers.ts
  export interface TestContext extends DaemonContext { homes: TempHomes; raw: Database.Database; launches: Array<Parameters<ExternalLauncher>[0]>; dispose(): void }
  export function createTestContext(opts?: Partial<DaemonContext> & { homes?: TempHomes; isPidAlive?: (pid: number) => boolean }): TestContext
  export function indexFixtures(ctx: TestContext): Promise<Indexer>
  ```
  Resume rules (docs/03 flow 3, F4): not found → 404 `not_found`; availability ≠ resumable → 409 `not_resumable`; an open owned PTY → 409 `session_live` `{ ptyId }` unless `mode: 'external', popOut: true` (then the PTY gets SIGHUP and the call waits up to 3 s for exit); a live registry entry (pid alive) → 409 `session_live` `{ pid, ownership: 'observed' }`; missing cwd → 422 `cwd_missing`. Fork skips the live guards and never marks the original session as owned. Codex: `codex resume <id>`, no fork (400 `unsupported`). External mode uses the project's `openIn` (default `terminal`) and always returns the command line so the UI can copy it. **Adopt** = resuming a session whose registry entry is dead (`live.status === 'ended'`, `ownership: 'observed'`).

- [ ] **Step 1: Install execa**

Run: `pnpm --filter @orc/daemon add execa@^10.0.1`

- [ ] **Step 2: Write the failing tests**

`apps/daemon/src/live/liveness.test.ts`
```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempHomes } from '../../test/helpers.ts';
import { findRegistryEntry, isPidAlive, readClaudeRegistry } from './liveness.ts';

describe('liveness', () => {
  const homes = useTempHomes();

  it('checks pids', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false);
  });

  it('reads registry files and ignores keys and partial writes', () => {
    const dir = join(homes.claudeHome, 'sessions');
    writeFileSync(join(dir, '41001.abcdef.key'), 'SECRET');
    writeFileSync(join(dir, '41002.json'), '{"pid":41002,"sessionId":"s-dr');
    const entries = readClaudeRegistry(homes.claudeHome);
    expect(entries.map((e) => e.pid)).toEqual([41001]);
    expect(JSON.stringify(entries)).not.toContain('SECRET');
    expect(readClaudeRegistry(join(homes.root, 'missing'))).toEqual([]);
  });

  it('finds a session entry and reports liveness', () => {
    expect(findRegistryEntry(homes.claudeHome, 's-basic', () => true)).toMatchObject({ pid: 41001, alive: true });
    expect(findRegistryEntry(homes.claudeHome, 's-basic', () => false)).toMatchObject({ pid: 41001, alive: false });
    expect(findRegistryEntry(homes.claudeHome, 's-drift', () => true)).toBeNull();
  });
});
```

`apps/daemon/src/services/external.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { appleScriptString, createExternalLauncher, resumeCommandLine, shellQuote } from './external.ts';

describe('external launcher', () => {
  it('quotes shell words', () => {
    expect(shellQuote(['claude', '--resume', 'abc-123'])).toBe('claude --resume abc-123');
    expect(shellQuote(["/tmp/it's here", 'a b'])).toBe("'/tmp/it'\\''s here' 'a b'");
    expect(resumeCommandLine('/Users/test/Stocks/EGX Research', 'claude', ['--resume', 'x'])).toBe(
      "cd '/Users/test/Stocks/EGX Research' && claude --resume x",
    );
    expect(appleScriptString('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"');
  });

  it('opens Terminal.app with the resume command', async () => {
    const calls: Array<[string, string[]]> = [];
    const launch = createExternalLauncher(async (file, args) => {
      calls.push([file, args]);
    });
    await launch({ cwd: '/w', command: 'claude', args: ['--resume', 's1'], openIn: 'terminal' });
    expect(calls).toEqual([
      [
        'osascript',
        ['-e', 'tell application "Terminal" to do script "cd /w && claude --resume s1"', '-e', 'tell application "Terminal" to activate'],
      ],
    ]);
  });

  it('opens VS Code or Finder at the cwd', async () => {
    const calls: Array<[string, string[]]> = [];
    const launch = createExternalLauncher(async (file, args) => {
      calls.push([file, args]);
    });
    await launch({ cwd: '/w', command: 'claude', args: [], openIn: 'vscode' });
    await launch({ cwd: '/w', command: 'claude', args: [], openIn: 'finder' });
    expect(calls).toEqual([
      ['code', ['--new-window', '/w']],
      ['open', ['/w']],
    ]);
  });
});
```

`apps/daemon/src/services/sessions.test.ts`
```ts
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, FAKE_CLAUDE, indexFixtures, type TestContext, writeClaudeSession } from '../../test/helpers.ts';
import type { BusEvent } from '../live/event-bus.ts';
import { resumeCommandLine } from './external.ts';
import { buildResumeCommand, decodeCursor, encodeCursor } from './sessions.ts';

const CODEX_1 = 'codex:c0dex000-0000-0000-0000-000000000001';

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

describe('session service', () => {
  let ctx: TestContext;
  afterEach(() => ctx.dispose());

  async function setup(alive = false): Promise<TestContext> {
    ctx = createTestContext({ isPidAlive: () => alive });
    await indexFixtures(ctx);
    return ctx;
  }

  it('lists a project newest first with cursor paging', async () => {
    await setup();
    const all = ctx.sessions.list({ projectId: 'wakecap' });
    expect(all.items.map((i) => i.pk)).toEqual([
      'claude:s-subagents',
      'claude:s-unknown',
      'claude:s-drift',
      'claude:s-prlink',
      'claude:s-basic',
      CODEX_1,
      'claude:s-old-prompts-only',
    ]);
    expect(all.nextCursor).toBeNull();
    const basic = all.items.find((i) => i.pk === 'claude:s-basic');
    expect(basic).toMatchObject({
      name: 'Notification service test check',
      durationMs: 420_000,
      costUsd: 0.42,
      availability: 'resumable',
      pinned: false,
      labels: [],
      live: null,
      snippet: null,
    });

    const p1 = ctx.sessions.list({ projectId: 'wakecap', limit: 3 });
    expect(p1.items).toHaveLength(3);
    const p2 = ctx.sessions.list({ projectId: 'wakecap', limit: 3, cursor: p1.nextCursor ?? '' });
    const p3 = ctx.sessions.list({ projectId: 'wakecap', limit: 3, cursor: p2.nextCursor ?? '' });
    expect([...p1.items, ...p2.items, ...p3.items].map((i) => i.pk)).toEqual(all.items.map((i) => i.pk));
    expect(p3.nextCursor).toBeNull();
    expect(() => ctx.sessions.list({ cursor: 'garbage' })).toThrow(/cursor/);
  });

  it('searches events, names and history with snippets', async () => {
    await setup();
    const n = ctx.sessions.list({ q: 'notification' });
    expect(n.items.map((i) => i.pk)).toEqual(['claude:s-basic']);
    expect(n.items[0]?.snippet).toContain('⟦notification⟧');

    const dec = ctx.sessions.list({ q: 'december' });
    expect(dec.items.map((i) => i.pk)).toEqual(['claude:s-old-prompts-only']);
    expect(dec.items[0]?.snippet).toBe('old session from ⟦december⟧');

    expect(ctx.sessions.list({ q: 'SAF-1787' }).items.map((i) => i.pk)).toEqual(['claude:s-prlink', CODEX_1]);
    expect(ctx.sessions.list({ q: 'zzzz-nothing' }).items).toEqual([]);
    expect(ctx.sessions.list({ q: 'weekends', projectId: 'forza' }).items).toEqual([]);
  });

  it('hides automated codex sessions unless asked', async () => {
    await setup();
    expect(ctx.sessions.list({ projectId: 'hackathon' }).items).toEqual([]);
    expect(ctx.sessions.list({ projectId: 'hackathon', includeAutomated: true }).items).toHaveLength(1);
  });

  it('gets sessions with observed liveness, events and agents', async () => {
    await setup(true);
    expect(ctx.sessions.get('claude', 's-basic')?.live).toMatchObject({
      pid: 41001,
      status: 'waiting',
      waitingFor: 'input needed',
      ownership: 'observed',
      ptyId: null,
    });
    expect(ctx.sessions.get('claude', 'nope')).toBeNull();
    expect(ctx.sessions.get('claude', 's-drift')?.live).toBeNull();
    const ev = ctx.sessions.events('claude', 's-basic', { limit: 4 });
    expect(ev.items).toHaveLength(4);
    expect(ev.nextSeq).toBe(4);
    expect(ctx.sessions.agents('claude', 's-subagents')).toHaveLength(3);
    expect(() => ctx.sessions.events('claude', 'nope', {})).toThrow(/not found/);
  });

  it('reports a dead registry entry as ended (adoptable)', async () => {
    await setup(false);
    expect(ctx.sessions.get('claude', 's-basic')?.live).toMatchObject({ status: 'ended', ownership: 'observed' });
  });

  it('emits session.updated on setLive and after indexing', async () => {
    await setup();
    const seen: BusEvent[] = [];
    ctx.bus.on('session.updated', (e) => seen.push(e));
    ctx.sessions.setLive('claude:s-drift', null);
    ctx.bus.emit({ type: 'session.indexed', pk: 'claude:s-prlink' });
    expect(seen.map((e) => (e.type === 'session.updated' ? e.session.id : ''))).toEqual(['s-drift', 's-prlink']);
  });

  it('rejects resumes that are not allowed', async () => {
    await setup(true);
    expect(await errorOf(ctx.sessions.resume('claude', 'nope', { mode: 'embedded' }))).toMatchObject({ status: 404 });
    expect(await errorOf(ctx.sessions.resume('claude', 's-old-prompts-only', { mode: 'embedded' }))).toMatchObject({
      code: 'not_resumable',
      status: 409,
    });
    expect(await errorOf(ctx.sessions.resume('claude', 's-basic', { mode: 'embedded' }))).toMatchObject({
      code: 'session_live',
      status: 409,
      details: { pid: 41001, ownership: 'observed' },
    });
    expect(await errorOf(ctx.sessions.resume('claude', 's-drift', { mode: 'embedded' }))).toMatchObject({
      code: 'cwd_missing',
      status: 422,
    });
    expect(await errorOf(ctx.sessions.resume('codex', CODEX_1.slice(6), { mode: 'embedded', fork: true }))).toMatchObject({
      code: 'unsupported',
    });
  });

  it('resumes into an owned PTY, guards duplicates, forks and pops out', async () => {
    await setup();
    const cwd = join(ctx.homes.root, 'work', 'live');
    const file = writeClaudeSession(ctx.homes, { sessionId: 's-live', cwd, prompt: 'resume me' });
    const indexer = await indexFixtures(ctx);
    await indexer.indexFile(file);

    const r = await ctx.sessions.resume('claude', 's-live', { mode: 'embedded', cols: 100, rows: 30 });
    if (!('ptyId' in r)) throw new Error('expected ptyId');
    let out = '';
    const a = ctx.pty.attach(r.ptyId, (d) => {
      out += d;
    });
    await vi.waitFor(() => expect(out).toContain(`fake-claude --dangerously-skip-permissions --resume s-live`));
    expect(out).toContain(`cwd=${realpathSync(cwd)}`);
    a.detach();
    expect(ctx.pty.get(r.ptyId)).toMatchObject({ sessionPk: 'claude:s-live', cols: 100, rows: 30, command: FAKE_CLAUDE });
    expect(ctx.sessions.get('claude', 's-live')?.live).toMatchObject({ ownership: 'owned', ptyId: r.ptyId, status: 'idle' });
    expect(ctx.sessions.list({ q: 'resume me' }).items[0]?.live?.ptyId).toBe(r.ptyId);

    expect(await errorOf(ctx.sessions.resume('claude', 's-live', { mode: 'embedded' }))).toMatchObject({
      code: 'session_live',
      details: { ptyId: r.ptyId, ownership: 'owned' },
    });

    const fork = await ctx.sessions.resume('claude', 's-live', { mode: 'embedded', fork: true });
    if (!('ptyId' in fork)) throw new Error('expected ptyId');
    expect(ctx.pty.get(fork.ptyId)).toMatchObject({ sessionPk: null });
    expect(ctx.pty.get(fork.ptyId)?.args).toEqual(['--dangerously-skip-permissions', '--resume', 's-live', '--fork-session']);
    expect(ctx.sessions.get('claude', 's-live')?.live?.ptyId).toBe(r.ptyId);

    const ext = await ctx.sessions.resume('claude', 's-live', { mode: 'external', popOut: true });
    expect(ext).toEqual({
      launched: 'external',
      command: resumeCommandLine(cwd, FAKE_CLAUDE, ['--dangerously-skip-permissions', '--resume', 's-live']),
    });
    expect(ctx.launches).toEqual([
      { cwd, command: FAKE_CLAUDE, args: ['--dangerously-skip-permissions', '--resume', 's-live'], openIn: 'terminal' },
    ]);
    expect(ctx.pty.get(r.ptyId)?.exitedAt).not.toBeNull();
    expect(ctx.sessions.get('claude', 's-live')?.live).toBeNull();
    await indexer.close();
  });

  it('builds resume commands and cursors', () => {
    ctx = createTestContext();
    const cfg = ctx.config();
    expect(buildResumeCommand({ source: 'codex', id: 'c1' }, cfg, false)).toEqual({ command: FAKE_CLAUDE, args: ['resume', 'c1'] });
    const c = { lastActivityAt: '2026-09-01T00:00:00.000Z', pk: 'claude:x' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/live/liveness apps/daemon/src/services`
Expected: FAIL, `Cannot find module './liveness.ts'` / `'./external.ts'` / `'./sessions.ts'` (projects tests still pass)

- [ ] **Step 4: Implement liveness, external launcher, snippet and user meta**

`apps/daemon/src/live/liveness.ts`
```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRegistryFile, type RegistryEntry } from '@orc/core';

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Reads ~/.claude/sessions/<pid>.json. The `^\d+\.json$` filter guarantees `<pid>.<hash>.key` files are never opened. */
export function readClaudeRegistry(claudeHome: string): RegistryEntry[] {
  const dir = join(claudeHome, 'sessions');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: RegistryEntry[] = [];
  for (const name of names.sort()) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const entry = parseRegistryFile(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      if (entry) out.push(entry);
    } catch {
      // partial write: the next read will see the complete file
    }
  }
  return out;
}

/** Phase 2 adds the procStart check against pid reuse. */
export function findRegistryEntry(
  claudeHome: string,
  sessionId: string,
  alive: (pid: number) => boolean,
): (RegistryEntry & { alive: boolean }) | null {
  const matches = readClaudeRegistry(claudeHome)
    .filter((e) => e.sessionId === sessionId)
    .map((e) => ({ ...e, alive: alive(e.pid) }));
  return matches.find((m) => m.alive) ?? matches[0] ?? null;
}
```

`apps/daemon/src/services/external.ts`
```ts
import { execa } from 'execa';

export type ExternalLauncher = (i: {
  cwd: string;
  command: string;
  args: string[];
  openIn: 'vscode' | 'terminal' | 'finder';
}) => Promise<void>;

export type CommandRunner = (file: string, args: string[]) => Promise<unknown>;

export function shellQuote(parts: string[]): string {
  return parts.map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`)).join(' ');
}

export function resumeCommandLine(cwd: string, command: string, args: string[]): string {
  return `cd ${shellQuote([cwd])} && ${shellQuote([command, ...args])}`;
}

export function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Pop-out / external resume (F4). VS Code and Finder cannot receive the command; the UI copies it instead. */
export function createExternalLauncher(run: CommandRunner = (file, args) => execa(file, args)): ExternalLauncher {
  return async (i) => {
    if (i.openIn === 'vscode') {
      await run('code', ['--new-window', i.cwd]);
      return;
    }
    if (i.openIn === 'finder') {
      await run('open', [i.cwd]);
      return;
    }
    const line = resumeCommandLine(i.cwd, i.command, i.args);
    await run('osascript', [
      '-e',
      `tell application "Terminal" to do script ${appleScriptString(line)}`,
      '-e',
      'tell application "Terminal" to activate',
    ]);
  };
}
```

`apps/daemon/src/services/snippet.ts`
```ts
import { SNIPPET_CLOSE, SNIPPET_OPEN } from '@orc/api-contract';

export function highlight(text: string, needle: string, radius = 40): string {
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0 || needle.length === 0) return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text;
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + needle.length + radius);
  return [
    start > 0 ? '…' : '',
    text.slice(start, i),
    SNIPPET_OPEN,
    text.slice(i, i + needle.length),
    SNIPPET_CLOSE,
    text.slice(i + needle.length, end),
    end < text.length ? '…' : '',
  ].join('');
}
```

`apps/daemon/src/services/user-meta.ts`
```ts
import type { SavedView } from '@orc/api-contract';
import type { OrcDb } from '../db/client.ts';
import * as repo from '../db/repos/user-meta.ts';
import { ServiceError } from './errors.ts';

export interface UserMetaService {
  setPinned(pk: string, pinned: boolean): boolean;
  setLabels(pk: string, labels: string[]): string[];
  labels(): string[];
  views(): SavedView[];
  saveView(i: { name: string; query: Record<string, string> }): SavedView;
  deleteView(id: string): boolean;
}

export function createUserMetaService(db: OrcDb): UserMetaService {
  const mustExist = (pk: string): void => {
    if (!repo.sessionExists(db, pk)) throw new ServiceError('not_found', 404, `session ${pk} not found`);
  };
  return {
    setPinned(pk, pinned) {
      mustExist(pk);
      repo.setPinned(db, pk, pinned);
      return pinned;
    },
    setLabels(pk, labels) {
      mustExist(pk);
      return repo.setLabels(db, pk, labels);
    },
    labels: () => repo.allLabels(db),
    views: () => repo.listViews(db),
    saveView: (i) => repo.insertView(db, i),
    deleteView: (id) => repo.deleteView(db, id),
  };
}
```

- [ ] **Step 5: Implement the session service**

`apps/daemon/src/services/sessions.ts`
```ts
import { existsSync } from 'node:fs';
import type { OrcConfig, SessionListItem } from '@orc/api-contract';
import {
  type AgentNode,
  type Availability,
  deriveAvailability,
  type LiveState,
  type PrRef,
  registryStatusToLive,
  type Session,
  type Source,
  type TimelineEvent,
} from '@orc/core';
import type { OrcPaths } from '../config.ts';
import type { OrcDb } from '../db/client.ts';
import { escapeLike, toFtsQuery } from '../db/fts.ts';
import { sessionPk } from '../db/keys.ts';
import { listAgents } from '../db/repos/agents.ts';
import { eventSnippet, listEvents, searchEventSessions } from '../db/repos/events.ts';
import { searchHistoryPrompts } from '../db/repos/history.ts';
import { insertPtySession, markPtyExited } from '../db/repos/pty-sessions.ts';
import { getSessionByPk, querySessions, type SessionRow, searchSessionText } from '../db/repos/sessions.ts';
import { labelsFor, pinnedSet } from '../db/repos/user-meta.ts';
import type { EventBus } from '../live/event-bus.ts';
import { findRegistryEntry, isPidAlive } from '../live/liveness.ts';
import type { PtyInfo, PtyManager } from '../pty/pty-manager.ts';
import { ServiceError } from './errors.ts';
import { type ExternalLauncher, resumeCommandLine } from './external.ts';
import type { ProjectServiceImpl } from './projects.ts';
import { highlight } from './snippet.ts';

export { sessionPk } from '../db/keys.ts';
export type { SessionListItem } from '@orc/api-contract';

export interface SessionListQuery {
  q?: string;
  projectId?: string;
  source?: Source;
  ticket?: string;
  pr?: string;
  from?: string;
  to?: string;
  model?: string;
  minCost?: number;
  maxCost?: number;
  skill?: string;
  hasSubagents?: boolean;
  touchedProd?: boolean;
  availability?: Availability;
  label?: string;
  pinned?: boolean;
  includeHidden?: boolean;
  includeAutomated?: boolean;
  limit?: number;
  cursor?: string;
}

export interface ResumeOptions {
  mode: 'embedded' | 'external';
  fork?: boolean;
  popOut?: boolean;
  cols?: number;
  rows?: number;
}

export type ResumeResult = { ptyId: string } | { launched: 'external'; command: string };

export interface SessionService {
  list(q: SessionListQuery): { items: SessionListItem[]; nextCursor: string | null };
  get(source: Source, id: string): Session | null;
  getByPk(pk: string): Session | null;
  events(
    source: Source,
    id: string,
    opts: { agentId?: string | null; afterSeq?: number; limit?: number },
  ): { items: TimelineEvent[]; nextSeq: number | null };
  agents(source: Source, id: string): AgentNode[];
  setLive(pk: string, live: LiveState | null): void;
  resume(source: Source, id: string, opts: ResumeOptions): Promise<ResumeResult>;
}

export interface SessionServiceDeps {
  db: OrcDb;
  paths: OrcPaths;
  config: () => OrcConfig;
  bus: EventBus;
  pty: PtyManager;
  projects: ProjectServiceImpl;
  launchExternal: ExternalLauncher;
  isPidAlive?: (pid: number) => boolean;
}

export function buildResumeCommand(
  s: Pick<Session, 'source' | 'id'>,
  cfg: OrcConfig,
  fork: boolean,
): { command: string; args: string[] } {
  const p = cfg.resumeProfile;
  if (s.source === 'codex') return { command: p.codexCommand, args: [...p.codexArgs, 'resume', s.id] };
  return { command: p.claudeCommand, args: [...p.claudeArgs, '--resume', s.id, ...(fork ? ['--fork-session'] : [])] };
}

export function encodeCursor(c: { lastActivityAt: string; pk: string }): string {
  return Buffer.from(JSON.stringify([c.lastActivityAt, c.pk])).toString('base64url');
}

export function decodeCursor(s: string): { lastActivityAt: string; pk: string } {
  try {
    const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string') {
      return { lastActivityAt: v[0], pk: v[1] };
    }
  } catch {
    // fall through to the validation error
  }
  throw new ServiceError('validation_failed', 400, 'invalid cursor');
}

function ownedLive(info: PtyInfo): LiveState {
  return {
    pid: info.pid,
    status: 'idle',
    waitingFor: null,
    since: info.startedAt,
    ownership: 'owned',
    ptyId: info.id,
    stage: null,
    currentTool: null,
    backgroundJobs: 0,
    runningSubagents: 0,
    contextFill: null,
  };
}

export function createSessionService(deps: SessionServiceDeps): SessionService {
  const { db, bus, pty, projects } = deps;
  const alive = deps.isPidAlive ?? isPidAlive;
  const live = new Map<string, LiveState>();

  function observedLive(s: Session): LiveState | null {
    if (s.source !== 'claude') return null;
    const entry = findRegistryEntry(deps.paths.claudeHome, s.id, alive);
    if (!entry) return null;
    return {
      pid: entry.pid,
      status: entry.alive ? registryStatusToLive(entry.status) : 'ended',
      waitingFor: entry.alive ? entry.waitingFor : null,
      since: entry.statusUpdatedAt ?? s.lastActivityAt,
      ownership: 'observed',
      ptyId: null,
      stage: null,
      currentTool: null,
      backgroundJobs: 0,
      runningSubagents: 0,
      contextFill: null,
    };
  }

  function load(pk: string, withRegistry: boolean): Session | null {
    const s = getSessionByPk(db, pk);
    if (!s) return null;
    const transcriptExists = s.transcriptPath !== null && existsSync(s.transcriptPath);
    const availability: Availability =
      s.availability === 'remote' ? 'remote' : deriveAvailability({ transcriptExists, archived: false });
    const withAvail = { ...s, availability };
    return { ...withAvail, live: live.get(pk) ?? (withRegistry ? observedLive(withAvail) : null) };
  }

  function getByPk(pk: string): Session | null {
    return load(pk, true);
  }

  function mustGet(source: Source, id: string): Session {
    const s = getByPk(sessionPk(source, id));
    if (!s) throw new ServiceError('not_found', 404, `session ${source}:${id} not found`);
    return s;
  }

  function setLive(pk: string, next: LiveState | null): void {
    if (next) live.set(pk, next);
    else live.delete(pk);
    const s = load(pk, false);
    if (s) bus.emit({ type: 'session.updated', session: s });
  }

  function toItem(row: SessionRow, pinned: boolean, labels: string[], snippet: string | null): SessionListItem {
    const duration = Date.parse(row.lastActivityAt) - Date.parse(row.startedAt);
    return {
      pk: row.pk,
      source: row.source as Source,
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      firstPrompt: row.firstPrompt,
      lastPrompt: row.lastPrompt,
      recap: row.recap,
      startedAt: row.startedAt,
      lastActivityAt: row.lastActivityAt,
      durationMs: Number.isFinite(duration) && duration > 0 ? duration : 0,
      costUsd: row.costUsd,
      tickets: JSON.parse(row.ticketsJson) as string[],
      prs: JSON.parse(row.prsJson) as PrRef[],
      availability: row.availability as Availability,
      pinned,
      labels,
      live: live.get(row.pk) ?? null,
      snippet,
    };
  }

  async function stopPty(ptyId: string): Promise<void> {
    await new Promise<void>((resolve) => {
      const off = bus.on('pty.exited', (e) => {
        if (e.ptyId !== ptyId) return;
        off();
        clearTimeout(timer);
        resolve();
      });
      const timer = setTimeout(() => {
        off();
        resolve();
      }, 3000);
      pty.kill(ptyId, 'SIGHUP');
    });
  }

  bus.on('pty.exited', (e) => {
    markPtyExited(db, e.ptyId, e.code, new Date().toISOString());
    for (const [pk, l] of [...live]) if (l.ptyId === e.ptyId) setLive(pk, null);
  });
  bus.on('session.indexed', (e) => {
    const s = load(e.pk, false);
    if (s) bus.emit({ type: 'session.updated', session: s });
  });

  return {
    list(q) {
      const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
      const cursor = q.cursor ? decodeCursor(q.cursor) : null;
      const text = q.q?.trim() ?? '';
      let pks: string[] | null = null;
      let match: string | null = null;
      let hits = new Map<string, number>();
      const fallback = new Map<string, string>();
      if (text) {
        match = toFtsQuery(text);
        if (match) hits = searchEventSessions(db, match);
        const like = `%${escapeLike(text)}%`;
        const set = new Set<string>(hits.keys());
        for (const pk of searchSessionText(db, like)) set.add(pk);
        for (const h of searchHistoryPrompts(db, like)) {
          set.add(h.pk);
          if (!hits.has(h.pk)) fallback.set(h.pk, highlight(h.display, text));
        }
        pks = [...set];
      }
      const { q: _q, cursor: _cursor, limit: _limit, ...filters } = q;
      const rows = querySessions(db, {
        ...filters,
        pks,
        limit: limit + 1,
        cursor,
        includeAutomated: q.includeAutomated ?? deps.config().codex.showAutomated,
      });
      const page = rows.slice(0, limit);
      const pagePks = page.map((r) => r.pk);
      const pinned = pinnedSet(db, pagePks);
      const labels = labelsFor(db, pagePks);
      const items = page.map((r) => {
        const rid = hits.get(r.pk);
        const snippet = match && rid !== undefined ? eventSnippet(db, match, rid) : (fallback.get(r.pk) ?? null);
        return toItem(r, pinned.has(r.pk), labels.get(r.pk) ?? [], snippet);
      });
      const last = page.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last ? encodeCursor({ lastActivityAt: last.lastActivityAt, pk: last.pk }) : null,
      };
    },
    get(source, id) {
      return getByPk(sessionPk(source, id));
    },
    getByPk,
    events(source, id, opts) {
      mustGet(source, id);
      return listEvents(db, sessionPk(source, id), opts);
    },
    agents(source, id) {
      mustGet(source, id);
      return listAgents(db, sessionPk(source, id));
    },
    setLive,
    async resume(source, id, opts) {
      const pk = sessionPk(source, id);
      const s = getByPk(pk);
      if (!s) throw new ServiceError('not_found', 404, `session ${pk} not found`);
      if (source === 'agnc') throw new ServiceError('unsupported', 400, 'AGNC sessions cannot be resumed locally');
      if (opts.fork && source !== 'claude') {
        throw new ServiceError('unsupported', 400, 'fork is only supported for Claude sessions');
      }
      if (s.availability !== 'resumable') {
        throw new ServiceError('not_resumable', 409, `session is ${s.availability}`, { availability: s.availability });
      }
      if (!opts.fork) {
        const owned = live.get(pk);
        if (owned?.ptyId && pty.get(owned.ptyId)?.exitedAt === null) {
          if (opts.mode === 'external' && opts.popOut) {
            await stopPty(owned.ptyId);
          } else {
            throw new ServiceError('session_live', 409, 'session is already open in the app', {
              ptyId: owned.ptyId,
              ownership: 'owned',
            });
          }
        } else if (s.live?.ownership === 'observed' && s.live.status !== 'ended') {
          throw new ServiceError('session_live', 409, 'session is running in another terminal', {
            pid: s.live.pid,
            ownership: 'observed',
          });
        }
      }
      if (!existsSync(s.startCwd)) {
        throw new ServiceError('cwd_missing', 422, `directory ${s.startCwd} no longer exists`, { cwd: s.startCwd });
      }
      const { command, args } = buildResumeCommand(s, deps.config(), opts.fork === true);
      if (opts.mode === 'external') {
        const openIn = (s.projectId ? projects.get(s.projectId)?.openIn : undefined) ?? 'terminal';
        await deps.launchExternal({ cwd: s.startCwd, command, args, openIn });
        return { launched: 'external', command: resumeCommandLine(s.startCwd, command, args) };
      }
      const info = pty.spawn({
        command,
        args,
        cwd: s.startCwd,
        sessionPk: opts.fork ? null : pk,
        cols: opts.cols,
        rows: opts.rows,
      });
      insertPtySession(db, {
        id: info.id,
        sessionPk: info.sessionPk,
        command,
        args,
        cwd: info.cwd,
        pid: info.pid,
        startedAt: info.startedAt,
      });
      if (!opts.fork) setLive(pk, ownedLive(info));
      return { ptyId: info.id };
    },
  };
}
```

Note the `openIn` default: `ProjectConfig.openIn` defaults to `'vscode'`, so external resume for a configured project opens VS Code unless the user changes it in Settings (Task 15); sessions outside any project open Terminal.app. The test session lives outside every project, so `openIn` is `'terminal'`.

- [ ] **Step 6: Implement the context and test helpers**

`apps/daemon/src/context.ts`
```ts
import { mkdirSync } from 'node:fs';
import type { OrcConfig } from '@orc/api-contract';
import type Database from 'better-sqlite3';
import { type Logger, pino } from 'pino';
import { loadConfig, type OrcPaths, saveConfig } from './config.ts';
import { type OrcDb, openDb } from './db/client.ts';
import { createEventBus, type EventBus } from './live/event-bus.ts';
import { createPtyManager, type PtyManager } from './pty/pty-manager.ts';
import { createExternalLauncher, type ExternalLauncher } from './services/external.ts';
import { createProjectService, type ProjectServiceImpl } from './services/projects.ts';
import { createSessionService, type SessionService } from './services/sessions.ts';
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
  const ctx: DaemonContext = { paths: o.paths, config, db: opened.db, bus, log, pty, sessions, projects, userMeta };
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
```

`apps/daemon/test/helpers.ts` (full file)
```ts
import { OrcConfig } from '@orc/api-contract';
import type Database from 'better-sqlite3';
import { pino } from 'pino';
import { afterEach, beforeEach } from 'vitest';
import { saveConfig } from '../src/config.ts';
import { buildContext, type DaemonContext } from '../src/context.ts';
import { createIndexer, type Indexer } from '../src/indexer/indexer.ts';
import type { ExternalLauncher } from '../src/services/external.ts';
import { FAKE_CLAUDE, makeTempHomes, type TempHomes } from './homes.ts';

export * from './homes.ts';

/** Fresh temp copies of the fixture homes for every test in the calling `describe`. */
export function useTempHomes(): TempHomes {
  const holder = {} as TempHomes;
  beforeEach(() => {
    Object.assign(holder, makeTempHomes());
  });
  afterEach(() => {
    holder.cleanup();
  });
  return holder;
}

export interface TestContext extends DaemonContext {
  homes: TempHomes;
  raw: Database.Database;
  launches: Array<Parameters<ExternalLauncher>[0]>;
  dispose(): void;
}

/**
 * Real services on temp homes: fake `claude` for resumes, a recording external launcher
 * (never runs osascript), silent logs and "every pid is dead" unless `isPidAlive` is given.
 */
export function createTestContext(
  opts: Partial<DaemonContext> & { homes?: TempHomes; isPidAlive?: (pid: number) => boolean } = {},
): TestContext {
  const { homes: given, isPidAlive, ...overrides } = opts;
  const homes = given ?? makeTempHomes();
  saveConfig(
    homes.paths,
    OrcConfig.parse({ resumeProfile: { claudeCommand: FAKE_CLAUDE, codexCommand: FAKE_CLAUDE } }),
  );
  const launches: TestContext['launches'] = [];
  const built = buildContext({
    paths: homes.paths,
    log: pino({ level: 'silent' }),
    launchExternal: async (i) => {
      launches.push(i);
    },
    isPidAlive: isPidAlive ?? (() => false),
  });
  return {
    ...built.ctx,
    ...overrides,
    homes,
    raw: built.raw,
    launches,
    dispose: () => {
      built.close();
      if (!given) homes.cleanup();
    },
  };
}

export async function indexFixtures(ctx: TestContext): Promise<Indexer> {
  const indexer = createIndexer({
    db: ctx.db,
    raw: ctx.raw,
    paths: ctx.paths,
    projects: ctx.projects,
    bus: ctx.bus,
    log: ctx.log,
  });
  await indexer.scanAll();
  return indexer;
}
```

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon`
Expected: PASS (all daemon suites, including 9 session-service tests).

- [ ] **Step 8: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(daemon): add session service with search, liveness guard and resume/fork/pop-out"
```

---

### Task 12: HTTP app, auth and REST routes

**Files:**
- Create: `apps/daemon/src/http/types.ts`, `auth.ts`, `json.ts`, `redact-out.ts`, `static.ts`, `app.ts`
- Create: `apps/daemon/src/http/routes/health.ts`, `projects.ts`, `sessions.ts`, `views.ts`, `pty.ts`
- Create: `apps/daemon/src/http/auth.test.ts`, `apps/daemon/src/http/app.test.ts`

**Interfaces:**
- Consumes: `DaemonContext` and `createTestContext`/`indexFixtures` (Task 11); `ServiceError` (Task 8); api-contract schemas and `apiError` (Task 5, Phase 0); `redact`, `CORE_VERSION`, `compileTicketRegex` (core).
- Produces:
  ```ts
  // http/types.ts
  export type OrcApp = Hono<{ Bindings: HttpBindings }>;
  // http/auth.ts
  export function allowedHosts(port: number, env?: NodeJS.ProcessEnv): string[]        // 127.0.0.1:<port>, localhost:<port> (+ :5173 when ORC_DEV=1)
  export function allowedOrigins(port: number, env?: NodeJS.ProcessEnv): string[]      // http://<host>
  export function tokenMatches(expected: string, given: string | null | undefined): boolean   // constant time
  export function isLoopback(addr: string | undefined): boolean
  // http/json.ts
  export function parseWith<T>(schema: z.ZodType<T>, value: unknown): T                // ServiceError 400 validation_failed
  export function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T>
  // http/redact-out.ts
  export function redactValue(v: unknown): unknown
  export function redactEvent(e: TimelineEvent): TimelineEvent
  export function redactSession(s: Session): Session
  export function redactSnippet(snippet: string): string
  export function redactListItem(i: SessionListItem): SessionListItem
  // http/static.ts
  export function registerStatic(app: OrcApp, root: string): void                      // SPA fallback to index.html
  // http/app.ts
  export interface AppOptions { ctx: DaemonContext; token: string; port: () => number; webDist?: string | null; env?: NodeJS.ProcessEnv }
  export function createApp(o: AppOptions): OrcApp
  // http/routes/*.ts
  export function registerHealthRoutes(app: OrcApp): void
  export function registerProjectRoutes(app: OrcApp, ctx: DaemonContext): void
  export function registerSessionRoutes(app: OrcApp, ctx: DaemonContext): void
  export function registerViewRoutes(app: OrcApp, ctx: DaemonContext): void
  export function registerPtyRoutes(app: OrcApp, ctx: DaemonContext): void
  ```
  Every `/api/*` request: Host must be allowed (403 `forbidden`, DNS-rebinding guard), a present `Origin` must be allowed (403), `x-orc-token` must match (401 `unauthorized`). Errors always use the contract shape. Transcript text (names, prompts, recaps, snippets, event text and tool inputs) is redacted here.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/http/auth.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { allowedHosts, allowedOrigins, isLoopback, tokenMatches } from './auth.ts';

describe('auth helpers', () => {
  it('allows loopback hosts on the daemon port, plus Vite in dev', () => {
    expect(allowedHosts(4317, {})).toEqual(['127.0.0.1:4317', 'localhost:4317']);
    expect(allowedHosts(4317, { ORC_DEV: '1' })).toEqual([
      '127.0.0.1:4317',
      'localhost:4317',
      '127.0.0.1:5173',
      'localhost:5173',
    ]);
    expect(allowedOrigins(4317, {})).toEqual(['http://127.0.0.1:4317', 'http://localhost:4317']);
  });

  it('compares tokens safely', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abc', 'abd')).toBe(false);
    expect(tokenMatches('abc', 'abcd')).toBe(false);
    expect(tokenMatches('abc', undefined)).toBe(false);
  });

  it('recognises loopback addresses', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('10.0.0.5')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});
```

`apps/daemon/src/http/app.test.ts`
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentNodeSchema,
  ProjectSchema,
  SessionEventsResponseSchema,
  SessionListResponseSchema,
  SessionSchema,
} from '@orc/api-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestContext, indexFixtures, type TestContext, writeClaudeSession } from '../../test/helpers.ts';
import type { Indexer } from '../indexer/indexer.ts';
import { createApp } from './app.ts';
import type { OrcApp } from './types.ts';

const TOKEN = 'a'.repeat(64);
const BASE = 'http://127.0.0.1:4317';
const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never;

let ctx: TestContext;
let indexer: Indexer;
let app: OrcApp;

beforeEach(async () => {
  ctx = createTestContext();
  indexer = await indexFixtures(ctx);
  app = createApp({ ctx, token: TOKEN, port: () => 4317, env: {} });
});
afterEach(async () => {
  await indexer.close();
  ctx.dispose();
});

function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; base?: string } = {}) {
  const headers: Record<string, string> = { 'x-orc-token': TOKEN, ...(init.headers ?? {}) };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return app.request(`${init.base ?? BASE}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function json(res: Response): Promise<unknown> {
  return res.json();
}

describe('auth and errors', () => {
  it('requires the token, an allowed host and an allowed origin', async () => {
    expect((await app.request(`${BASE}/api/health`)).status).toBe(401);
    expect((await call('/api/health', { headers: { 'x-orc-token': 'wrong' } })).status).toBe(401);
    expect((await call('/api/health', { base: 'http://evil.test:4317' })).status).toBe(403);
    expect((await call('/api/health', { headers: { origin: 'http://evil.test' } })).status).toBe(403);
    const ok = await call('/api/health', { headers: { origin: 'http://localhost:4317' } });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ ok: true, version: '0.0.0' });
  });

  it('uses the error shape', async () => {
    const res = await call('/api/nope');
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: { code: 'not_found', message: 'no such route' } });
    const bad = await call('/api/sessions?limit=9999');
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('serves bootstrap.js only to same-origin loopback requests', async () => {
    const ok = await app.request(`${BASE}/bootstrap.js`, {}, LOOPBACK_ENV);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('javascript');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.text()).toBe(`window.__ORC_TOKEN__ = "${TOKEN}";\n`);
    const cross = await app.request(`${BASE}/bootstrap.js`, { headers: { 'sec-fetch-site': 'cross-site' } }, LOOPBACK_ENV);
    expect(cross.status).toBe(403);
    const remote = await app.request(`${BASE}/bootstrap.js`, {}, { incoming: { socket: { remoteAddress: '10.0.0.5' } } } as never);
    expect(remote.status).toBe(403);
    expect((await app.request('http://evil.test:4317/bootstrap.js', {}, LOOPBACK_ENV)).status).toBe(403);
  });
});

describe('projects', () => {
  it('lists and patches projects', async () => {
    const list = z.array(ProjectSchema).parse(await json(await call('/api/projects')));
    expect(list.map((p) => p.id)).toEqual(expect.arrayContaining(['wakecap', 'forza', 'stocks', 'hackathon']));
    expect(list[0]?.id).toBe('wakecap');
    const res = await call('/api/projects/forza', { method: 'PATCH', body: { name: 'Forza App', hidden: true } });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ id: 'forza', name: 'Forza App', hidden: true });
    expect((await call('/api/projects/nope', { method: 'PATCH', body: { name: 'x' } })).status).toBe(404);
    expect((await call('/api/projects/forza', { method: 'PATCH', body: { id: 'x' } })).status).toBe(400);
    expect((await call('/api/projects/forza', { method: 'PATCH', body: { ticketRegex: '(' } })).status).toBe(400);
  });
});

describe('sessions', () => {
  it('lists with filters, search snippets and redaction', async () => {
    const list = SessionListResponseSchema.parse(await json(await call('/api/sessions?projectId=wakecap&limit=2')));
    expect(list.items.map((i) => i.pk)).toEqual(['claude:s-subagents', 'claude:s-unknown']);
    expect(list.nextCursor).not.toBeNull();
    const found = SessionListResponseSchema.parse(await json(await call('/api/sessions?q=notification')));
    expect(found.items[0]?.snippet).toContain('⟦notification⟧');
    const psql = SessionListResponseSchema.parse(await json(await call('/api/sessions?q=psql')));
    expect(psql.items.map((i) => i.pk)).toEqual(['claude:s-drift']);
    expect(psql.items[0]?.snippet).toContain('«redacted:secret»');
    expect(JSON.stringify(psql)).not.toContain('hunter2');
  });

  it('gets a session, its events and agents', async () => {
    expect((await call('/api/sessions/claude/nope')).status).toBe(404);
    expect((await call('/api/sessions/cursor/x')).status).toBe(400);
    const s = SessionSchema.parse(await json(await call('/api/sessions/claude/s-basic')));
    expect(s.name).toBe('Notification service test check');
    const ev = SessionEventsResponseSchema.parse(await json(await call('/api/sessions/claude/s-basic/events?limit=4')));
    expect(ev.items.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(ev.nextSeq).toBe(4);
    const next = SessionEventsResponseSchema.parse(await json(await call('/api/sessions/claude/s-basic/events?afterSeq=4')));
    expect(next.items[0]?.seq).toBe(5);
    const drift = await json(await call('/api/sessions/claude/s-drift/events'));
    expect(JSON.stringify(drift)).toContain('«redacted:secret»');
    expect(JSON.stringify(drift)).not.toContain('hunter2');
    const sub = SessionEventsResponseSchema.parse(await json(await call('/api/sessions/claude/s-subagents/events?agentId=ag1')));
    expect(sub.items.every((e) => e.agentId === 'ag1')).toBe(true);
    const agents = z.array(AgentNodeSchema).parse(await json(await call('/api/sessions/claude/s-subagents/agents')));
    expect(agents).toHaveLength(3);
  });

  it('pins, labels and hides sessions', async () => {
    expect(await json(await call('/api/sessions/claude/s-basic/pin', { method: 'POST', body: { pinned: true } }))).toEqual({
      pinned: true,
    });
    const pinned = SessionListResponseSchema.parse(await json(await call('/api/sessions?pinned=true')));
    expect(pinned.items.map((i) => [i.pk, i.pinned])).toEqual([['claude:s-basic', true]]);
    expect(
      await json(await call('/api/sessions/claude/s-basic/label', { method: 'POST', body: { labels: ['hidden', 'later'] } })),
    ).toEqual({ labels: ['hidden', 'later'] });
    const visible = SessionListResponseSchema.parse(await json(await call('/api/sessions?projectId=wakecap')));
    expect(visible.items.map((i) => i.pk)).not.toContain('claude:s-basic');
    const withHidden = SessionListResponseSchema.parse(await json(await call('/api/sessions?projectId=wakecap&includeHidden=true')));
    expect(withHidden.items.find((i) => i.pk === 'claude:s-basic')?.labels).toEqual(['hidden', 'later']);
    expect(await json(await call('/api/labels'))).toEqual(['hidden', 'later']);
    expect((await call('/api/sessions/claude/nope/pin', { method: 'POST', body: { pinned: true } })).status).toBe(404);
    expect((await call('/api/sessions/claude/s-basic/pin', { method: 'POST', body: { pinned: 'yes' } })).status).toBe(400);
  });

  it('saves and deletes views', async () => {
    const saved = (await json(
      await call('/api/views', { method: 'POST', body: { name: 'Prod', query: { touchedProd: 'true' } } }),
    )) as { id: string };
    expect(await json(await call('/api/views'))).toEqual([expect.objectContaining({ name: 'Prod', query: { touchedProd: 'true' } })]);
    expect(await json(await call(`/api/views/${saved.id}`, { method: 'DELETE' }))).toEqual({ ok: true });
    expect((await call(`/api/views/${saved.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('resumes into a PTY and kills it with confirmation', async () => {
    const notResumable = await call('/api/sessions/claude/s-old-prompts-only/resume', { method: 'POST', body: { mode: 'embedded' } });
    expect(notResumable.status).toBe(409);
    expect(await json(notResumable)).toMatchObject({ error: { code: 'not_resumable' } });
    expect((await call('/api/sessions/claude/s-basic/resume', { method: 'POST', body: { mode: 'tmux' } })).status).toBe(400);

    const cwd = join(ctx.homes.root, 'work', 'api');
    await indexer.indexFile(writeClaudeSession(ctx.homes, { sessionId: 's-api', cwd, prompt: 'api resume' }));
    const res = await call('/api/sessions/claude/s-api/resume', { method: 'POST', body: { mode: 'embedded' } });
    expect(res.status).toBe(200);
    const { ptyId } = (await json(res)) as { ptyId: string };
    const ptys = (await json(await call('/api/pty'))) as Array<{ id: string; sessionPk: string }>;
    expect(ptys).toEqual([expect.objectContaining({ id: ptyId, sessionPk: 'claude:s-api' })]);

    const unconfirmed = await call(`/api/pty/${ptyId}`, { method: 'DELETE' });
    expect(unconfirmed.status).toBe(409);
    expect(await json(unconfirmed)).toMatchObject({
      error: { code: 'confirmation_required', details: { summary: expect.stringContaining('--resume s-api') } },
    });
    expect(await json(await call(`/api/pty/${ptyId}`, { method: 'DELETE', body: { confirm: true } }))).toEqual({ ok: true });
    expect(await json(await call('/api/pty'))).toEqual([]);
    expect((await call('/api/pty/nope', { method: 'DELETE', body: { confirm: true } })).status).toBe(404);
  });
});

describe('static web app', () => {
  it('serves files with SPA fallback', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'orc-web-'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Orchestrator</title>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
    const web = createApp({ ctx, token: TOKEN, port: () => 4317, env: {}, webDist: dist });
    const index = await web.request(`${BASE}/`);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('Orchestrator');
    const js = await web.request(`${BASE}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(await (await web.request(`${BASE}/history?q=x`)).text()).toContain('Orchestrator');
    expect(await (await web.request(`${BASE}/assets/..%2f..%2findex.db`)).text()).toContain('Orchestrator');
    const missing = createApp({ ctx, token: TOKEN, port: () => 4317, env: {}, webDist: join(dist, 'nope') });
    expect((await missing.request(`${BASE}/`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/http`
Expected: FAIL, `Cannot find module './auth.ts'` / `'./app.ts'`

- [ ] **Step 3: Implement the HTTP helpers**

`apps/daemon/src/http/types.ts`
```ts
import type { HttpBindings } from '@hono/node-server';
import type { Hono } from 'hono';

export type OrcApp = Hono<{ Bindings: HttpBindings }>;
```

`apps/daemon/src/http/auth.ts`
```ts
import { timingSafeEqual } from 'node:crypto';

export function allowedHosts(port: number, env: NodeJS.ProcessEnv = process.env): string[] {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (env.ORC_DEV === '1') hosts.push('127.0.0.1:5173', 'localhost:5173');
  return hosts;
}

export function allowedOrigins(port: number, env: NodeJS.ProcessEnv = process.env): string[] {
  return allowedHosts(port, env).map((h) => `http://${h}`);
}

export function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
```

`apps/daemon/src/http/json.ts`
```ts
import type { Context } from 'hono';
import type { z } from 'zod';
import { ServiceError } from '../services/errors.ts';

export function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ServiceError('validation_failed', 400, 'invalid request', r.error.issues);
  return r.data;
}

export async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ServiceError('validation_failed', 400, 'request body must be JSON');
  }
  return parseWith(schema, body);
}
```

`apps/daemon/src/http/redact-out.ts`
```ts
import { SNIPPET_CLOSE, SNIPPET_OPEN, type SessionListItem } from '@orc/api-contract';
import { redact, type Session, type TimelineEvent } from '@orc/core';

const r = (t: string | null): string | null => (t === null ? null : redact(t));

export function redactValue(v: unknown): unknown {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x)]));
  }
  return v;
}

export function redactEvent(e: TimelineEvent): TimelineEvent {
  return { ...e, text: r(e.text), input: redactValue(e.input) };
}

export function redactSession(s: Session): Session {
  return {
    ...s,
    name: r(s.name),
    firstPrompt: r(s.firstPrompt),
    lastPrompt: r(s.lastPrompt),
    awaySummary: r(s.awaySummary),
    recap: r(s.recap),
  };
}

/** Highlight markers can split a secret (e.g. "⟦PGPASSWORD⟧=x"), so redaction runs on the plain text first. */
export function redactSnippet(snippet: string): string {
  const plain = snippet.replaceAll(SNIPPET_OPEN, '').replaceAll(SNIPPET_CLOSE, '');
  const clean = redact(plain);
  return clean === plain ? snippet : clean;
}

export function redactListItem(i: SessionListItem): SessionListItem {
  return {
    ...i,
    name: r(i.name),
    firstPrompt: r(i.firstPrompt),
    lastPrompt: r(i.lastPrompt),
    recap: r(i.recap),
    snippet: i.snippet === null ? null : redactSnippet(i.snippet),
  };
}
```

`apps/daemon/src/http/static.ts`
```ts
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { OrcApp } from './types.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export function registerStatic(app: OrcApp, root: string): void {
  const base = resolve(root);
  app.get('*', async (c) => {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      urlPath = '/';
    }
    const candidate = resolve(base, `.${urlPath}`);
    const inside = candidate.startsWith(`${base}${sep}`);
    const file = inside && (await isFile(candidate)) ? candidate : join(base, 'index.html');
    if (!(await isFile(file))) return c.text('web app not built: run `pnpm --filter @orc/web build`', 404);
    const body = await readFile(file);
    const isIndex = file === join(base, 'index.html');
    return c.body(body, 200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': isIndex ? 'no-store' : 'public, max-age=31536000, immutable',
    });
  });
}
```

- [ ] **Step 4: Implement the routes and the app**

`apps/daemon/src/http/routes/health.ts`
```ts
import { CORE_VERSION } from '@orc/core';
import type { OrcApp } from '../types.ts';

const startedAt = Date.now();

export function registerHealthRoutes(app: OrcApp): void {
  app.get('/api/health', (c) =>
    c.json({ ok: true, version: CORE_VERSION, uptimeS: Math.round((Date.now() - startedAt) / 1000) }),
  );
}
```

`apps/daemon/src/http/routes/projects.ts`
```ts
import { ProjectPatchSchema } from '@orc/api-contract';
import { compileTicketRegex } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import { readJson } from '../json.ts';
import type { OrcApp } from '../types.ts';

export function registerProjectRoutes(app: OrcApp, ctx: DaemonContext): void {
  app.get('/api/projects', (c) => c.json(ctx.projects.list()));
  app.patch('/api/projects/:id', async (c) => {
    const patch = await readJson(c, ProjectPatchSchema);
    if (patch.ticketRegex && compileTicketRegex(patch.ticketRegex) === null) {
      throw new ServiceError('validation_failed', 400, 'ticketRegex is not a valid regular expression');
    }
    return c.json(ctx.projects.update(c.req.param('id'), patch));
  });
}
```

`apps/daemon/src/http/routes/sessions.ts`
```ts
import {
  LabelRequestSchema,
  PinRequestSchema,
  ResumeRequestSchema,
  SessionEventsQuerySchema,
  SessionListQuerySchema,
  SourceSchema,
} from '@orc/api-contract';
import { z } from 'zod';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import { sessionPk } from '../../services/sessions.ts';
import { parseWith, readJson } from '../json.ts';
import { redactEvent, redactListItem, redactSession } from '../redact-out.ts';
import type { OrcApp } from '../types.ts';

const Params = z.object({ source: SourceSchema, id: z.string().min(1) });

export function registerSessionRoutes(app: OrcApp, ctx: DaemonContext): void {
  app.get('/api/sessions', (c) => {
    const q = parseWith(SessionListQuerySchema, c.req.query());
    const out = ctx.sessions.list(q);
    return c.json({ items: out.items.map(redactListItem), nextCursor: out.nextCursor });
  });

  app.get('/api/sessions/:source/:id', (c) => {
    const p = parseWith(Params, c.req.param());
    const s = ctx.sessions.get(p.source, p.id);
    if (!s) throw new ServiceError('not_found', 404, `session ${p.source}:${p.id} not found`);
    return c.json(redactSession(s));
  });

  app.get('/api/sessions/:source/:id/events', (c) => {
    const p = parseWith(Params, c.req.param());
    const q = parseWith(SessionEventsQuerySchema, c.req.query());
    const out = ctx.sessions.events(p.source, p.id, { agentId: q.agentId ?? null, afterSeq: q.afterSeq, limit: q.limit });
    return c.json({ items: out.items.map(redactEvent), nextSeq: out.nextSeq });
  });

  app.get('/api/sessions/:source/:id/agents', (c) => {
    const p = parseWith(Params, c.req.param());
    return c.json(ctx.sessions.agents(p.source, p.id));
  });

  app.post('/api/sessions/:source/:id/resume', async (c) => {
    const p = parseWith(Params, c.req.param());
    const body = await readJson(c, ResumeRequestSchema);
    return c.json(await ctx.sessions.resume(p.source, p.id, body));
  });

  app.post('/api/sessions/:source/:id/pin', async (c) => {
    const p = parseWith(Params, c.req.param());
    const body = await readJson(c, PinRequestSchema);
    return c.json({ pinned: ctx.userMeta.setPinned(sessionPk(p.source, p.id), body.pinned) });
  });

  app.post('/api/sessions/:source/:id/label', async (c) => {
    const p = parseWith(Params, c.req.param());
    const body = await readJson(c, LabelRequestSchema);
    return c.json({ labels: ctx.userMeta.setLabels(sessionPk(p.source, p.id), body.labels) });
  });

  app.get('/api/labels', (c) => c.json(ctx.userMeta.labels()));
}
```

`apps/daemon/src/http/routes/views.ts`
```ts
import { SaveViewRequestSchema } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import { readJson } from '../json.ts';
import type { OrcApp } from '../types.ts';

export function registerViewRoutes(app: OrcApp, ctx: DaemonContext): void {
  app.get('/api/views', (c) => c.json(ctx.userMeta.views()));
  app.post('/api/views', async (c) => c.json(ctx.userMeta.saveView(await readJson(c, SaveViewRequestSchema))));
  app.delete('/api/views/:id', (c) => {
    if (!ctx.userMeta.deleteView(c.req.param('id'))) throw new ServiceError('not_found', 404, 'view not found');
    return c.json({ ok: true as const });
  });
}
```

`apps/daemon/src/http/routes/pty.ts`
```ts
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import type { OrcApp } from '../types.ts';

export function registerPtyRoutes(app: OrcApp, ctx: DaemonContext): void {
  app.get('/api/pty', (c) => c.json(ctx.pty.list()));
  app.delete('/api/pty/:ptyId', async (c) => {
    const id = c.req.param('ptyId');
    const info = ctx.pty.get(id);
    if (!info) throw new ServiceError('not_found', 404, `pty ${id} not found`);
    const body: unknown = await c.req.json().catch(() => null);
    const confirmed = typeof body === 'object' && body !== null && (body as { confirm?: unknown }).confirm === true;
    if (!confirmed) {
      throw new ServiceError('confirmation_required', 409, 'confirm to stop this terminal', {
        summary: `Stop \`${[info.command, ...info.args].join(' ')}\` (pid ${info.pid}) in ${info.cwd}`,
      });
    }
    ctx.pty.remove(id);
    return c.json({ ok: true as const });
  });
}
```

`apps/daemon/src/http/app.ts`
```ts
import type { HttpBindings } from '@hono/node-server';
import { apiError } from '@orc/api-contract';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import type { DaemonContext } from '../context.ts';
import { ServiceError } from '../services/errors.ts';
import { allowedHosts, allowedOrigins, isLoopback, tokenMatches } from './auth.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerProjectRoutes } from './routes/projects.ts';
import { registerPtyRoutes } from './routes/pty.ts';
import { registerSessionRoutes } from './routes/sessions.ts';
import { registerViewRoutes } from './routes/views.ts';
import { registerStatic } from './static.ts';
import type { OrcApp } from './types.ts';

export interface AppOptions {
  ctx: DaemonContext;
  token: string;
  port: () => number;
  webDist?: string | null;
  env?: NodeJS.ProcessEnv;
}

export function createApp(o: AppOptions): OrcApp {
  const app: OrcApp = new Hono<{ Bindings: HttpBindings }>();
  const hostOf = (c: Context) => c.req.header('host') ?? new URL(c.req.url).host;
  const hostOk = (c: Context) => allowedHosts(o.port(), o.env).includes(hostOf(c));

  app.onError((err, c) => {
    if (err instanceof ServiceError) return c.json(apiError(err.code, err.message, err.details), err.status);
    if (err instanceof ZodError) return c.json(apiError('validation_failed', 'invalid request', err.issues), 400);
    if (err instanceof HTTPException) return c.json(apiError('bad_request', err.message), 400);
    o.ctx.log.error({ err }, 'unhandled request error');
    return c.json(apiError('internal', 'internal error'), 500);
  });

  app.use('/api/*', async (c, next) => {
    if (!hostOk(c)) return c.json(apiError('forbidden', 'host not allowed'), 403);
    const origin = c.req.header('origin');
    if (origin && !allowedOrigins(o.port(), o.env).includes(origin)) {
      return c.json(apiError('forbidden', 'origin not allowed'), 403);
    }
    if (!tokenMatches(o.token, c.req.header('x-orc-token'))) {
      return c.json(apiError('unauthorized', 'missing or invalid token'), 401);
    }
    await next();
  });

  app.get('/bootstrap.js', (c) => {
    const remote = c.env?.incoming?.socket?.remoteAddress;
    const site = c.req.header('sec-fetch-site');
    const siteOk = site === undefined || site === 'same-origin' || site === 'none';
    if (!isLoopback(remote) || !hostOk(c) || !siteOk) return c.text('forbidden', 403);
    return c.body(`window.__ORC_TOKEN__ = ${JSON.stringify(o.token)};\n`, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
    });
  });

  registerHealthRoutes(app);
  registerProjectRoutes(app, o.ctx);
  registerSessionRoutes(app, o.ctx);
  registerViewRoutes(app, o.ctx);
  registerPtyRoutes(app, o.ctx);
  app.all('/api/*', (c) => c.json(apiError('not_found', 'no such route'), 404));

  if (o.webDist) registerStatic(app, o.webDist);
  return app;
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/http`
Expected: PASS (3 + 10 tests). If Hono's `app.request` keeps a `Host` header from the URL, the evil-host case still returns 403 because `hostOf` prefers the header; both paths are covered.

- [ ] **Step 6: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon
git commit -m "feat(daemon): add token-guarded Hono API for projects, sessions, views and PTYs"
```

---

### Task 13: PTY WebSocket and daemon boot

**Files:**
- Create: `apps/daemon/src/http/ws.ts`
- Modify (replace): `apps/daemon/src/main.ts`
- Delete: `apps/daemon/src/main.test.ts` (Phase 0 health test; health is covered by `app.test.ts`)
- Create: `apps/daemon/test/server.test.ts`
- Modify: `apps/daemon/package.json` (ws)

**Interfaces:**
- Consumes: `createApp`, `allowedOrigins`, `tokenMatches` (Task 12); `buildContext` (Task 11); `createIndexer` (Task 10); `ensureToken`, `resolvePaths` (Task 6); `PtyClientMessageSchema` (Task 5).
- Produces:
  ```ts
  // http/ws.ts
  export interface PtySocketOptions { ctx: DaemonContext; token: string; origins: () => string[] }
  export function attachPtyWebSocket(server: Server, o: PtySocketOptions): { close(): Promise<void> }
  // main.ts
  export interface Daemon { ctx: DaemonContext; indexer: Indexer; token: string; start(o: { port: number; watch?: boolean }): Promise<{ port: number; close(): Promise<void> }> }
  export function createDaemon(o?: { paths?: OrcPaths; log?: Logger; launchExternal?: ExternalLauncher; webDist?: string | null }): Promise<Daemon>
  export const DEFAULT_WEB_DIST: string        // apps/web/dist
  ```
  WS protocol (`/pty/:ptyId`): token from `x-orc-token` or `?token=`, Origin must be in `allowedOrigins`, the PTY must exist. The first server frame is the scrollback (binary, possibly empty), then live output as binary frames. When the process exits the server sends the text frame `{"t":"exit","code":<n|null>}` and closes with 1000. Client frames are JSON `PtyClientMessage`; invalid frames are ignored. Rejected upgrades get a plain HTTP status (401/403/404) and the socket is destroyed. Other upgrade paths are destroyed (Phase 2 adds `/ws`).

- [ ] **Step 1: Install ws**

Run: `pnpm --filter @orc/daemon add ws@^8.21.3 && pnpm --filter @orc/daemon add -D @types/ws@^8.18.1`

- [ ] **Step 2: Write the failing server test**

`apps/daemon/test/server.test.ts`
```ts
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createDaemon, type Daemon } from '../src/main.ts';
import { makeTempHomes, type TempHomes, writeClaudeSession } from './homes.ts';
import { createTestContext } from './helpers.ts';
import { pino } from 'pino';

let homes: TempHomes;
let daemon: Daemon;
let server: { port: number; close(): Promise<void> } | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  homes?.cleanup();
});

async function boot(): Promise<number> {
  homes = makeTempHomes();
  // writes the fake-claude config into ORC_HOME, then disposes the throwaway context
  createTestContext({ homes }).dispose();
  writeClaudeSession(homes, { sessionId: 's-ws', cwd: join(homes.root, 'work', 'ws'), prompt: 'ws session' });
  daemon = await createDaemon({ paths: homes.paths, log: pino({ level: 'silent' }), launchExternal: async () => undefined, webDist: null });
  const running = await daemon.start({ port: 0, watch: false });
  server = running;
  return running.port;
}

function open(
  port: number,
  path: string,
  origin: string | undefined,
): Promise<{ ws: WebSocket; frames: Array<{ binary: boolean; text: string }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : {});
    const frames: Array<{ binary: boolean; text: string }> = [];
    ws.on('message', (data, isBinary) => {
      frames.push({ binary: isBinary, text: Buffer.isBuffer(data) ? data.toString('utf8') : String(data) });
    });
    ws.once('open', () => resolve({ ws, frames }));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('daemon server', () => {
  it('boots, indexes, resumes and streams a PTY over WebSocket with replay', async () => {
    const port = await boot();
    const base = `http://127.0.0.1:${port}`;
    const headers = { 'x-orc-token': daemon.token, 'content-type': 'application/json' };
    await waitFor(() => daemon.ctx.sessions.get('claude', 's-ws') !== null);

    const health = await fetch(`${base}/api/health`, { headers });
    expect(health.status).toBe(200);

    const res = await fetch(`${base}/api/sessions/claude/s-ws/resume`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ mode: 'embedded' }),
    });
    const { ptyId } = (await res.json()) as { ptyId: string };
    const origin = `http://127.0.0.1:${port}`;

    const first = await open(port, `/pty/${ptyId}?token=${daemon.token}`, origin);
    await waitFor(() => first.frames.map((f) => f.text).join('').includes('fake-claude'));
    expect(first.frames[0]?.binary).toBe(true);
    first.ws.send(JSON.stringify({ t: 'in', d: 'ping-from-ws\r' }));
    first.ws.send('not json');
    first.ws.send(JSON.stringify({ t: 'resize', cols: 90, rows: 20 }));
    await waitFor(() => first.frames.map((f) => f.text).join('').includes('ping-from-ws'));
    await waitFor(() => daemon.ctx.pty.get(ptyId)?.cols === 90);
    first.ws.close();

    const second = await open(port, `/pty/${ptyId}?token=${daemon.token}`, origin);
    await waitFor(() => second.frames.length > 0);
    expect(second.frames[0]?.text).toContain('fake-claude');
    expect(second.frames[0]?.text).toContain('ping-from-ws');

    const closed = new Promise<number>((r) => second.ws.once('close', (code) => r(code)));
    daemon.ctx.pty.kill(ptyId);
    expect(await closed).toBe(1000);
    expect(second.frames.at(-1)).toEqual({ binary: false, text: expect.stringMatching(/^\{"t":"exit","code":/) });
  });

  it('rejects bad tokens, origins, unknown PTYs and other paths', async () => {
    const port = await boot();
    const origin = `http://127.0.0.1:${port}`;
    await expect(open(port, '/pty/nope?token=wrong', origin)).rejects.toThrow('status 401');
    await expect(open(port, `/pty/nope?token=${daemon.token}`, 'http://evil.test')).rejects.toThrow('status 403');
    await expect(open(port, `/pty/nope?token=${daemon.token}`, undefined)).rejects.toThrow('status 403');
    await expect(open(port, `/pty/nope?token=${daemon.token}`, origin)).rejects.toThrow('status 404');
    await expect(open(port, `/other?token=${daemon.token}`, origin)).rejects.toThrow();
  });

  it('serves bootstrap.js to local same-origin requests', async () => {
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/bootstrap.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(daemon.token);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/test/server`
Expected: FAIL, `createDaemon` is not exported from `../src/main.ts`

- [ ] **Step 4: Implement the WebSocket bridge**

`apps/daemon/src/http/ws.ts`
```ts
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { PtyClientMessageSchema } from '@orc/api-contract';
import { type WebSocket, WebSocketServer } from 'ws';
import type { DaemonContext } from '../context.ts';
import { tokenMatches } from './auth.ts';

export interface PtySocketOptions {
  ctx: DaemonContext;
  token: string;
  origins: () => string[];
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachPtyWebSocket(server: Server, o: PtySocketOptions): { close(): Promise<void> } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = /^\/pty\/([^/]+)$/.exec(url.pathname);
    if (!match?.[1]) {
      socket.destroy();
      return;
    }
    const ptyId = decodeURIComponent(match[1]);
    const headerToken = req.headers['x-orc-token'];
    const token = (typeof headerToken === 'string' ? headerToken : null) ?? url.searchParams.get('token');
    if (!tokenMatches(o.token, token)) return reject(socket, 401, 'Unauthorized');
    const origin = req.headers.origin;
    if (!origin || !o.origins().includes(origin)) return reject(socket, 403, 'Forbidden');
    if (!o.ctx.pty.get(ptyId)) return reject(socket, 404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, ptyId));
  };

  function bridge(ws: WebSocket, ptyId: string): void {
    const { pty, bus } = o.ctx;
    let attached: { detach(): void } | null = null;
    const offExit = bus.on('pty.exited', (e) => {
      if (e.ptyId !== ptyId) return;
      ws.send(JSON.stringify({ t: 'exit', code: e.code }));
      ws.close(1000, 'process exited');
    });
    try {
      const a = pty.attach(ptyId, (chunk) => {
        if (ws.readyState === ws.OPEN) ws.send(Buffer.from(chunk, 'utf8'), { binary: true });
      });
      attached = a;
      ws.send(Buffer.from(a.scrollback, 'utf8'), { binary: true });
      const info = pty.get(ptyId);
      if (info?.exitedAt) {
        ws.send(JSON.stringify({ t: 'exit', code: info.exitCode }));
        ws.close(1000, 'process exited');
      }
    } catch {
      ws.close(1011, 'pty unavailable');
    }
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }
      const msg = PtyClientMessageSchema.safeParse(parsed);
      if (!msg.success) return;
      try {
        if (msg.data.t === 'in') pty.write(ptyId, msg.data.d);
        else pty.resize(ptyId, msg.data.cols, msg.data.rows);
      } catch {
        // the PTY exited between frames; the exit frame follows
      }
    });
    ws.on('close', () => {
      offExit();
      attached?.detach();
    });
  }

  server.on('upgrade', onUpgrade);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.off('upgrade', onUpgrade);
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}
```

- [ ] **Step 5: Implement daemon boot**

`apps/daemon/src/main.ts` (replaces the Phase 0 shell)
```ts
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type { Logger } from 'pino';
import { ensureToken, type OrcPaths, resolvePaths } from './config.ts';
import { buildContext, type DaemonContext } from './context.ts';
import { createApp } from './http/app.ts';
import { allowedOrigins } from './http/auth.ts';
import { attachPtyWebSocket } from './http/ws.ts';
import { createIndexer, type Indexer } from './indexer/indexer.ts';
import type { ExternalLauncher } from './services/external.ts';

export const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface Daemon {
  ctx: DaemonContext;
  indexer: Indexer;
  token: string;
  start(o: { port: number; watch?: boolean }): Promise<{ port: number; close(): Promise<void> }>;
}

export async function createDaemon(
  o: { paths?: OrcPaths; log?: Logger; launchExternal?: ExternalLauncher; webDist?: string | null } = {},
): Promise<Daemon> {
  const paths = o.paths ?? resolvePaths();
  const built = buildContext({ paths, log: o.log, launchExternal: o.launchExternal });
  const { ctx } = built;
  const token = ensureToken(paths);
  const indexer = createIndexer({ db: ctx.db, raw: built.raw, paths, projects: ctx.projects, bus: ctx.bus, log: ctx.log });
  const webDist = o.webDist === undefined ? (existsSync(DEFAULT_WEB_DIST) ? DEFAULT_WEB_DIST : null) : o.webDist;

  return {
    ctx,
    indexer,
    token,
    async start({ port, watch = true }) {
      let boundPort = port;
      const app = createApp({ ctx, token, port: () => boundPort, webDist });
      const server = await new Promise<Server>((resolve) => {
        const s = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info: AddressInfo) => {
          boundPort = info.port;
          resolve(s as Server);
        });
      });
      const sockets = attachPtyWebSocket(server, { ctx, token, origins: () => allowedOrigins(boundPort) });
      ctx.log.info({ port: boundPort }, 'daemon listening');
      const scan = indexer
        .scanAll()
        .then(async (stats) => {
          ctx.log.info(stats, 'initial index complete');
          if (watch) await indexer.watch();
        })
        .catch((err: unknown) => ctx.log.error({ err }, 'initial index failed'));
      return {
        port: boundPort,
        close: async () => {
          await scan;
          await indexer.close();
          await sockets.close();
          await new Promise<void>((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          });
          built.close();
        },
      };
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const daemon = await createDaemon();
  const port = Number(process.env.ORC_PORT ?? daemon.ctx.config().port);
  const running = await daemon.start({ port });
  console.log(`orchestrator daemon on http://127.0.0.1:${running.port}`);
  const shutdown = () => {
    running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
```

Delete the Phase 0 test: `git rm apps/daemon/src/main.test.ts`.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon`
Expected: PASS (all daemon suites including 3 server tests).

- [ ] **Step 7: Smoke-run the daemon against the fixtures**

Run:
```bash
T=$(mktemp -d) && mkdir -p "$T/claude" "$T/codex" && cp -R fixtures/claude-home/. "$T/claude" && cp -R fixtures/codex-home/. "$T/codex"
ORC_HOME="$T/orc" CLAUDE_HOME="$T/claude" CODEX_HOME="$T/codex" ORC_USER_HOME=/Users/test ORC_PORT=4399 pnpm --filter @orc/daemon exec tsx src/main.ts &
sleep 3 && curl -s -H "x-orc-token: $(cat "$T/orc/token")" 'http://127.0.0.1:4399/api/sessions?projectId=wakecap&limit=3' | head -c 400; echo
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4399/api/health
kill %1
```
Expected: a JSON page starting `{"items":[{"pk":"claude:s-subagents"` and `401` for the unauthenticated health call.

- [ ] **Step 8: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(daemon): boot HTTP server with PTY WebSocket, replay and graceful shutdown"
```

---

### Task 14: Web foundation, app shell and project selector

**Files:**
- Modify: `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/vitest.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/index.css`, `biome.json` (ignore the generated route tree)
- Create: `apps/web/tsr.config.json`, `apps/web/src/router.tsx`, `apps/web/src/routeTree.gen.ts` (generated)
- Create: `apps/web/src/routes/__root.tsx`, `apps/web/src/routes/index.tsx`, `apps/web/src/routes/history.tsx`
- Create: `apps/web/src/api/client.ts`, `apps/web/src/api/queries/projects.ts`
- Create: `apps/web/src/stores/project.ts`
- Create: `apps/web/src/components/ui/cn.ts`, `button.tsx`, `badge.tsx`, `input.tsx`, `native-select.tsx`, `tabs.tsx`, `checkbox.tsx`, `card.tsx`, `skeleton.tsx`, `separator.tsx`
- Create: `apps/web/src/lib/format.ts`, `apps/web/src/lib/format.test.ts`
- Create: `apps/web/src/features/history/filters.ts`, `apps/web/src/features/history/filters.test.ts`
- Create: `apps/web/src/features/shell/AppShell.tsx`, `ProjectSelector.tsx`, `ProjectSelector.test.tsx`
- Create: `apps/web/src/test/setup.ts`, `apps/web/src/test/render.tsx`, `apps/web/src/test/fake-api.ts`
- Delete: `apps/web/src/App.tsx`, `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: `createApiClient`, `ApiClient`, `ProjectPatch`, `SessionListFilters`, `ALL_PROJECTS` (Task 5); `import type` from `@orc/core`.
- Produces:
  ```ts
  // api/client.ts
  export function getToken(): string
  export function getApiClient(): ApiClient
  export function setApiClientForTests(c: ApiClient | null): void
  // api/queries/projects.ts
  export function useProjects(): UseQueryResult<Project[]>                        // key ['projects']
  export function useUpdateProject(): UseMutationResult<ProjectConfig, Error, { id: string; patch: ProjectPatch }>
  // stores/project.ts
  export const DEFAULT_PROJECT_ID = 'wakecap';
  export interface ProjectState { projectId: string; setProjectId(projectId: string): void }
  export const useProjectStore: UseBoundStore<StoreApi<ProjectState>>            // persisted as localStorage "orc.project"
  // components/ui (shadcn-compatible props; see Step 4 for the Wakecore switch)
  export function cn(...parts: Array<string | false | null | undefined>): string
  export function Button(p: ButtonProps): JSX.Element            // variant: default|secondary|outline|ghost|destructive; size: default|sm|icon
  export function Badge(p: BadgeProps): JSX.Element              // variant: default|secondary|outline|destructive|success|warning
  export function Input(p: ComponentProps<'input'>): JSX.Element
  export function NativeSelect(p: ComponentProps<'select'>): JSX.Element
  export function Tabs(p: { value?: string; defaultValue?: string; onValueChange?(v: string): void; className?: string; children: ReactNode }): JSX.Element
  export function TabsList / TabsTrigger({ value }) / TabsContent({ value })
  export function Checkbox(p: CheckboxProps): JSX.Element       // checked + onCheckedChange(checked: boolean)
  export function Card / CardHeader / CardTitle / CardContent; export function Skeleton; export function Separator
  // lib/format.ts
  export function formatDuration(ms: number | null): string
  export function formatCost(usd: number | null): string
  export function formatTokens(n: number): string
  export function formatDateTime(iso: string): string            // local "YYYY-MM-DD HH:mm"
  export function shortenPath(path: string): string              // /Users/<name>/… → ~/…
  // features/history/filters.ts
  export interface HistorySearch { q?; source?; ticket?; pr?; from?; to?; model?; skill?; label?; minCost?; maxCost?; hasSubagents?; touchedProd?; pinned?; includeHidden?; includeAutomated?; availability? }
  export function parseHistorySearch(raw: Record<string, unknown>): HistorySearch
  export function cleanSearch(s: HistorySearch): HistorySearch
  export function toListFilters(search: HistorySearch, projectId: string): SessionListFilters
  export function searchToViewQuery(search: HistorySearch): Record<string, string>
  export function viewQueryToSearch(q: Record<string, string>): HistorySearch
  // features/shell
  export function AppShell(p: { children: ReactNode }): JSX.Element
  export function ProjectSelector(): JSX.Element
  // test helpers
  export function createFakeApi(overrides?: Partial<ApiClient>): ApiClient
  export function renderWithProviders(ui: ReactNode, opts?: { api?: ApiClient; path?: string }): RenderResult & { queryClient: QueryClient }
  ```
  Routes: `/` redirects to `/history` (contracts §12); `/history` validates its search params with `parseHistorySearch` (its page component arrives in Task 16).

- [ ] **Step 1: Add dependencies and config**

Run:
```bash
pnpm --filter @orc/web add @orc/api-contract@workspace:* @orc/core@workspace:* @tanstack/react-query@^5.103.1 @tanstack/react-router@^1.170.38 @tanstack/react-table@^9.2.4 @tanstack/react-virtual@^3.14.13 zustand@^5.0.15 @xterm/xterm@^6.0.0 @xterm/addon-fit@^0.11.0 react-resizable-panels@^4.12.4
pnpm --filter @orc/web add -D @tanstack/router-plugin@^1.168.40 @tanstack/router-cli@^1.167.38 @testing-library/user-event@^14.6.7 @playwright/test@^1.63.0
```

`apps/web/package.json` — set `scripts` to:
```json
"scripts": {
  "dev": "vite",
  "build": "tsr generate && vite build",
  "routes:gen": "tsr generate",
  "typecheck": "tsr generate && tsc -p tsconfig.json",
  "e2e": "playwright test"
}
```

`apps/web/tsr.config.json`
```json
{ "routesDirectory": "./src/routes", "generatedRouteTree": "./src/routeTree.gen.ts", "quoteStyle": "single" }
```

`apps/web/vite.config.ts`
```ts
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const daemon = 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      '/api': daemon,
      '/bootstrap.js': daemon,
      '/ws': { target: 'ws://127.0.0.1:4317', ws: true },
      '/pty': { target: 'ws://127.0.0.1:4317', ws: true },
    },
  },
});
```
(Run the daemon with `pnpm --filter @orc/daemon dev`, which sets `ORC_DEV=1`, so the Vite host/origin `:5173` is accepted.)

`apps/web/vitest.config.ts`
```ts
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
```

`apps/web/index.html`
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Orchestrator</title>
    <!-- Sets window.__ORC_TOKEN__; served by the daemon to loopback same-origin requests only. -->
    <script src="/bootstrap.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/index.css`
```css
@import "tailwindcss";

@theme {
  --color-background: oklch(0.99 0 0);
  --color-foreground: oklch(0.22 0.02 260);
  --color-muted: oklch(0.96 0.005 260);
  --color-muted-foreground: oklch(0.52 0.02 260);
  --color-border: oklch(0.9 0.01 260);
  --color-primary: oklch(0.55 0.15 255);
  --color-primary-foreground: oklch(0.99 0 0);
  --color-destructive: oklch(0.58 0.2 27);
  --color-success: oklch(0.6 0.13 150);
  --color-warning: oklch(0.75 0.15 75);
}

@layer base {
  * {
    border-color: var(--color-border);
  }
  body {
    background: var(--color-background);
    color: var(--color-foreground);
  }
  mark {
    background: oklch(0.92 0.12 95);
    color: inherit;
    border-radius: 2px;
  }
}
```

- [ ] **Step 2: Write the test helpers and failing tests**

`apps/web/src/test/setup.ts`
```ts
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

class ResizeObserverStub {
  observe(): void {
    // jsdom has no layout; nothing to observe
  }
  unobserve(): void {
    // no-op
  }
  disconnect(): void {
    // no-op
  }
}
if (!('ResizeObserver' in globalThis)) Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });

// TanStack Virtual measures the scroll element with offsetWidth/offsetHeight; jsdom reports 0.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1200 });
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => undefined;
```

`apps/web/src/test/fake-api.ts`
```ts
import type { ApiClient } from '@orc/api-contract';
import { vi } from 'vitest';

const unexpected = (name: string) =>
  vi.fn(async (): Promise<never> => {
    throw new Error(`unexpected api call: ${name}`);
  });

export function createFakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  const base: ApiClient = {
    healthGet: vi.fn(async () => ({ ok: true, version: '0.0.0', uptimeS: 1 })),
    projectsList: vi.fn(async () => []),
    projectsUpdate: unexpected('projectsUpdate'),
    sessionsList: vi.fn(async () => ({ items: [], nextCursor: null })),
    sessionsGet: unexpected('sessionsGet'),
    sessionsEvents: vi.fn(async () => ({ items: [], nextSeq: null })),
    sessionsAgents: vi.fn(async () => []),
    sessionsResume: unexpected('sessionsResume'),
    sessionsPin: vi.fn(async (_source: string, _id: string, pinned: boolean) => ({ pinned })),
    sessionsLabel: vi.fn(async (_source: string, _id: string, labels: string[]) => ({ labels })),
    labelsList: vi.fn(async () => []),
    viewsList: vi.fn(async () => []),
    viewsSave: unexpected('viewsSave'),
    viewsDelete: vi.fn(async () => ({ ok: true as const })),
    ptyList: vi.fn(async () => []),
    ptyKill: vi.fn(async () => ({ ok: true as const })),
  };
  return { ...base, ...overrides };
}
```

`apps/web/src/test/render.tsx`
```tsx
import type { ApiClient } from '@orc/api-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { setApiClientForTests } from '../api/client.ts';
import { createFakeApi } from './fake-api.ts';

/** Renders `ui` inside a QueryClient and a memory router (so <Link> works) with a fake API client. */
export function renderWithProviders(ui: ReactNode, opts: { api?: ApiClient; path?: string } = {}) {
  setApiClientForTests(opts.api ?? createFakeApi());
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => <>{ui}</> });
  const index = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null });
  const rest = createRoute({ getParentRoute: () => rootRoute, path: '$', component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([index, rest]),
    history: createMemoryHistory({ initialEntries: [opts.path ?? '/'] }),
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, queryClient, router };
}
```

`apps/web/src/lib/format.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { formatCost, formatDateTime, formatDuration, formatTokens, shortenPath } from './format.ts';

describe('format', () => {
  it('formats durations', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(420_000)).toBe('7m');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
    expect(formatDuration(90_000_000)).toBe('1d 1h');
  });

  it('formats cost and tokens', () => {
    expect(formatCost(null)).toBe('—');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0.42)).toBe('$0.42');
    expect(formatCost(1234.5)).toBe('$1,234.50');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(1_500_000)).toBe('1.5M');
  });

  it('formats local date-times and paths', () => {
    expect(formatDateTime(new Date(2026, 8, 1, 9, 5).toISOString())).toBe('2026-09-01 09:05');
    expect(formatDateTime('not a date')).toBe('—');
    expect(shortenPath('/Users/test/Wakecap/Backend')).toBe('~/Wakecap/Backend');
    expect(shortenPath('/tmp/x')).toBe('/tmp/x');
  });
});
```

`apps/web/src/features/history/filters.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { cleanSearch, parseHistorySearch, searchToViewQuery, toListFilters, viewQueryToSearch } from './filters.ts';

describe('history search params', () => {
  it('parses router search values defensively', () => {
    expect(
      parseHistorySearch({
        q: 1787,
        source: 'codex',
        ticket: 'SAF-1',
        minCost: '0.5',
        maxCost: 3,
        touchedProd: 'true',
        pinned: true,
        hasSubagents: 'nope',
        availability: 'prompts-only',
        model: '',
        bogus: 'x',
      }),
    ).toEqual({
      q: '1787',
      source: 'codex',
      ticket: 'SAF-1',
      minCost: 0.5,
      maxCost: 3,
      touchedProd: true,
      pinned: true,
      availability: 'prompts-only',
    });
    expect(parseHistorySearch({ source: 'cursor', availability: 'gone', minCost: 'abc' })).toEqual({});
  });

  it('builds list filters for a project or all projects', () => {
    expect(toListFilters({ q: 'x' }, 'wakecap')).toEqual({ q: 'x', projectId: 'wakecap', limit: 50 });
    expect(toListFilters({ q: 'x' }, 'all')).toEqual({ q: 'x', projectId: undefined, limit: 50 });
    expect(toListFilters({ from: '2026-09-01', to: '2026-09-02' }, 'all')).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-02T23:59:59.999Z',
    });
  });

  it('round-trips saved view queries and cleans empties', () => {
    const search = { q: 'weekend', touchedProd: true, minCost: 1 };
    expect(searchToViewQuery(search)).toEqual({ q: 'weekend', touchedProd: 'true', minCost: '1' });
    expect(viewQueryToSearch(searchToViewQuery(search))).toEqual(search);
    expect(cleanSearch({ q: '', ticket: undefined, pinned: false, touchedProd: true })).toEqual({ touchedProd: true });
  });
});
```

`apps/web/src/features/shell/ProjectSelector.test.tsx`
```tsx
import type { Project } from '@orc/core';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../../stores/project.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { ProjectSelector } from './ProjectSelector.tsx';

const projects: Project[] = [
  { id: 'wakecap', name: 'Wakecap', pathPrefixes: ['/w'], hidden: false, lastActivityAt: '2026-09-06', sessionCount: 3 },
  { id: 'forza', name: 'Forza', pathPrefixes: ['/f'], hidden: false, lastActivityAt: '2026-09-04', sessionCount: 1 },
  { id: 'old', name: 'Old', pathPrefixes: ['/o'], hidden: true, lastActivityAt: null, sessionCount: 0 },
];

describe('ProjectSelector', () => {
  beforeEach(() => useProjectStore.setState({ projectId: 'wakecap' }));

  it('lists visible projects plus All projects and stores the choice', async () => {
    const api = createFakeApi({ projectsList: vi.fn(async () => projects) });
    renderWithProviders(<ProjectSelector />, { api });
    const select = await screen.findByRole('combobox', { name: 'Project' });
    await screen.findByRole('option', { name: 'Forza (1)' });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Wakecap (3)', 'Forza (1)', 'All projects']);
    await userEvent.selectOptions(select, 'forza');
    expect(useProjectStore.getState().projectId).toBe('forza');
    expect(JSON.parse(localStorage.getItem('orc.project') ?? '{}')).toMatchObject({ state: { projectId: 'forza' } });
    await userEvent.selectOptions(select, 'all');
    expect(useProjectStore.getState().projectId).toBe('all');
  });

  it('falls back to the default project when the stored one is gone', async () => {
    useProjectStore.setState({ projectId: 'deleted' });
    renderWithProviders(<ProjectSelector />, { api: createFakeApi({ projectsList: vi.fn(async () => projects) }) });
    await waitFor(() => expect(useProjectStore.getState().projectId).toBe('wakecap'));
  });
});
```

Run: `pnpm vitest run apps/web`
Expected: FAIL, `Cannot find module './format.ts'` (and the other new modules).

- [ ] **Step 3: Implement client, store, formatters and filters**

`apps/web/src/api/client.ts`
```ts
import { type ApiClient, createApiClient } from '@orc/api-contract';

declare global {
  interface Window {
    __ORC_TOKEN__?: string;
  }
}

let client: ApiClient | null = null;

export function getToken(): string {
  return typeof window === 'undefined' ? '' : (window.__ORC_TOKEN__ ?? '');
}

export function getApiClient(): ApiClient {
  client ??= createApiClient({ baseUrl: window.location.origin, token: getToken() });
  return client;
}

export function setApiClientForTests(c: ApiClient | null): void {
  client = c;
}
```

`apps/web/src/api/queries/projects.ts`
```ts
import type { ProjectPatch } from '@orc/api-contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: () => getApiClient().projectsList(), staleTime: 60_000 });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; patch: ProjectPatch }) => getApiClient().projectsUpdate(v.id, v.patch),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}
```

`apps/web/src/stores/project.ts`
```ts
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export const DEFAULT_PROJECT_ID = 'wakecap';

export interface ProjectState {
  projectId: string;
  setProjectId(projectId: string): void;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      projectId: DEFAULT_PROJECT_ID,
      setProjectId: (projectId) => set({ projectId }),
    }),
    { name: 'orc.project', storage: createJSONStorage(() => localStorage) },
  ),
);
```

`apps/web/src/lib/format.ts`
```ts
const pad = (n: number) => String(n).padStart(2, '0');

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

export function formatCost(value: number | null): string {
  if (value === null) return '—';
  if (value > 0 && value < 0.01) return '<$0.01';
  return usd.format(value);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function shortenPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~');
}
```

`apps/web/src/features/history/filters.ts`
```ts
import { ALL_PROJECTS, type SessionListFilters } from '@orc/api-contract';
import type { Availability, Source } from '@orc/core';

export interface HistorySearch {
  q?: string;
  source?: Source;
  ticket?: string;
  pr?: string;
  from?: string;
  to?: string;
  model?: string;
  skill?: string;
  label?: string;
  minCost?: number;
  maxCost?: number;
  hasSubagents?: boolean;
  touchedProd?: boolean;
  pinned?: boolean;
  includeHidden?: boolean;
  includeAutomated?: boolean;
  availability?: Availability;
}

const STRING_KEYS = ['q', 'ticket', 'pr', 'from', 'to', 'model', 'skill', 'label'] as const;
const NUMBER_KEYS = ['minCost', 'maxCost'] as const;
const BOOL_KEYS = ['hasSubagents', 'touchedProd', 'pinned', 'includeHidden', 'includeAutomated'] as const;
const SOURCES: readonly string[] = ['claude', 'codex', 'agnc'];
const AVAILABILITY: readonly string[] = ['resumable', 'archived', 'prompts-only', 'remote'];

export function parseHistorySearch(raw: Record<string, unknown>): HistorySearch {
  const out: HistorySearch = {};
  for (const k of STRING_KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim() !== '') out[k] = v;
    else if (typeof v === 'number') out[k] = String(v);
  }
  for (const k of NUMBER_KEYS) {
    const v = raw[k];
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
  }
  for (const k of BOOL_KEYS) {
    const v = raw[k];
    if (v === true || v === 'true') out[k] = true;
    else if (v === false || v === 'false') out[k] = false;
  }
  if (typeof raw.source === 'string' && SOURCES.includes(raw.source)) out.source = raw.source as Source;
  if (typeof raw.availability === 'string' && AVAILABILITY.includes(raw.availability)) {
    out.availability = raw.availability as Availability;
  }
  return out;
}

/** Drops empty strings, undefined and `false` toggles so URLs stay short. */
export function cleanSearch(s: HistorySearch): HistorySearch {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined || v === '' || v === false) continue;
    out[k] = v;
  }
  return out as HistorySearch;
}

/** Date inputs give YYYY-MM-DD; `to` must include the whole day. */
export function toListFilters(search: HistorySearch, projectId: string): SessionListFilters {
  const to = search.to && /^\d{4}-\d{2}-\d{2}$/.test(search.to) ? `${search.to}T23:59:59.999Z` : search.to;
  return { ...search, to, projectId: projectId === ALL_PROJECTS ? undefined : projectId, limit: 50 };
}

export function searchToViewQuery(search: HistorySearch): Record<string, string> {
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(cleanSearch(search))) q[k] = String(v);
  return q;
}

export function viewQueryToSearch(q: Record<string, string>): HistorySearch {
  return parseHistorySearch(q);
}
```

- [ ] **Step 4: Implement the UI re-export layer (shadcn fallback)**

This is the fallback path from spike S6 (`plan/spikes/S6.md`). Each file below is a small shadcn-compatible component (same export names and `variant`/`size` props as shadcn/ui).
- **If S6 = GO (Wakecore):** replace the body of `button.tsx`, `badge.tsx`, `input.tsx`, `tabs.tsx`, `checkbox.tsx`, `card.tsx`, `skeleton.tsx`, `separator.tsx` with a one-line re-export, e.g. `export { Button, type ButtonProps } from '@wakecap/core-ui';` (use the names the S6 report lists), install `@wakecap/core-ui@^0.17.0 @wakecap/core-tokens@^0.8.0`, and add the tokens import from the S6 report at the top of `index.css`. Keep `cn.ts` and `native-select.tsx` local (plain HTML, no Wakecore equivalent). Feature code does not change.
- **If S6 = NO-GO:** keep the files exactly as below.

`apps/web/src/components/ui/cn.ts`
```ts
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
```

`apps/web/src/components/ui/button.tsx`
```tsx
import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

export type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
export type ButtonSize = 'default' | 'sm' | 'icon';

const VARIANTS: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground hover:opacity-90',
  secondary: 'bg-muted text-foreground hover:bg-border',
  outline: 'border bg-background hover:bg-muted',
  ghost: 'hover:bg-muted',
  destructive: 'bg-destructive text-primary-foreground hover:opacity-90',
};
const SIZES: Record<ButtonSize, string> = {
  default: 'h-9 px-3 text-sm',
  sm: 'h-7 px-2 text-xs',
  icon: 'h-7 w-7 text-sm',
};

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant = 'default', size = 'default', className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1 rounded-md font-medium transition disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
}
```

`apps/web/src/components/ui/badge.tsx`
```tsx
import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

export type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive' | 'success' | 'warning';

const VARIANTS: Record<BadgeVariant, string> = {
  default: 'bg-primary text-primary-foreground',
  secondary: 'bg-muted text-foreground',
  outline: 'border text-foreground',
  destructive: 'bg-destructive text-primary-foreground',
  success: 'bg-success text-primary-foreground',
  warning: 'bg-warning text-foreground',
};

export interface BadgeProps extends ComponentProps<'span'> {
  variant?: BadgeVariant;
}

export function Badge({ variant = 'default', className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap', VARIANTS[variant], className)}
      {...rest}
    />
  );
}
```

`apps/web/src/components/ui/input.tsx`
```tsx
import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return (
    <input
      className={cn('h-8 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-primary', className)}
      {...rest}
    />
  );
}
```

`apps/web/src/components/ui/native-select.tsx`
```tsx
import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

export function NativeSelect({ className, ...rest }: ComponentProps<'select'>) {
  return (
    <select
      className={cn('h-8 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-primary', className)}
      {...rest}
    />
  );
}
```

`apps/web/src/components/ui/tabs.tsx`
```tsx
import { createContext, type ReactNode, useContext, useId, useState } from 'react';
import { cn } from './cn.ts';

interface TabsContextValue {
  value: string;
  setValue(v: string): void;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('Tabs components must be used inside <Tabs>');
  return ctx;
}

export function Tabs(props: {
  value?: string;
  defaultValue?: string;
  onValueChange?(value: string): void;
  className?: string;
  children: ReactNode;
}) {
  const [inner, setInner] = useState(props.defaultValue ?? '');
  const baseId = useId();
  const value = props.value ?? inner;
  const setValue = (v: string) => {
    setInner(v);
    props.onValueChange?.(v);
  };
  return (
    <TabsContext.Provider value={{ value, setValue, baseId }}>
      <div className={props.className}>{props.children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div role="tablist" className={cn('inline-flex gap-1 border-b', className)}>
      {children}
    </div>
  );
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  const tabs = useTabs();
  const active = tabs.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${tabs.baseId}-tab-${value}`}
      aria-selected={active}
      aria-controls={`${tabs.baseId}-panel-${value}`}
      onClick={() => tabs.setValue(value)}
      className={cn('-mb-px border-b-2 px-3 py-1.5 text-sm', active ? 'border-primary font-medium' : 'border-transparent')}
    >
      {children}
    </button>
  );
}

export function TabsContent({ value, className, children }: { value: string; className?: string; children: ReactNode }) {
  const tabs = useTabs();
  if (tabs.value !== value) return null;
  return (
    <div role="tabpanel" id={`${tabs.baseId}-panel-${value}`} aria-labelledby={`${tabs.baseId}-tab-${value}`} className={className}>
      {children}
    </div>
  );
}
```

`apps/web/src/components/ui/checkbox.tsx`
```tsx
import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

export interface CheckboxProps extends Omit<ComponentProps<'input'>, 'type' | 'checked' | 'onChange'> {
  checked?: boolean;
  onCheckedChange?(checked: boolean): void;
}

export function Checkbox({ checked, onCheckedChange, className, ...rest }: CheckboxProps) {
  return (
    <input
      type="checkbox"
      checked={checked ?? false}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      className={cn('h-4 w-4 accent-primary', className)}
      {...rest}
    />
  );
}
```

`apps/web/src/components/ui/card.tsx`
```tsx
import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

export function Card({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('rounded-lg border bg-background', className)} {...rest} />;
}

export function CardHeader({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 p-4', className)} {...rest} />;
}

export function CardTitle({ className, ...rest }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-base font-semibold', className)} {...rest} />;
}

export function CardContent({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('p-4 pt-0', className)} {...rest} />;
}
```

`apps/web/src/components/ui/skeleton.tsx`
```tsx
import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

export function Skeleton({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...rest} />;
}
```

`apps/web/src/components/ui/separator.tsx`
```tsx
import { cn } from './cn.ts';

export function Separator({ orientation = 'horizontal', className }: { orientation?: 'horizontal' | 'vertical'; className?: string }) {
  return <hr aria-orientation={orientation} className={cn('border-0 bg-border', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)} />;
}
```

- [ ] **Step 5: Implement the shell, selector, router and routes**

`apps/web/src/features/shell/ProjectSelector.tsx`
```tsx
import { ALL_PROJECTS } from '@orc/api-contract';
import { useEffect } from 'react';
import { useProjects } from '@/api/queries/projects.ts';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { useProjectStore } from '@/stores/project.ts';

export function ProjectSelector() {
  const { data: projects } = useProjects();
  const projectId = useProjectStore((s) => s.projectId);
  const setProjectId = useProjectStore((s) => s.setProjectId);

  useEffect(() => {
    if (!projects || projectId === ALL_PROJECTS) return;
    if (!projects.some((p) => p.id === projectId)) setProjectId(projects[0]?.id ?? ALL_PROJECTS);
  }, [projects, projectId, setProjectId]);

  const visible = (projects ?? []).filter((p) => !p.hidden || p.id === projectId);
  return (
    <NativeSelect aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
      {visible.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} ({p.sessionCount})
        </option>
      ))}
      <option value={ALL_PROJECTS}>All projects</option>
    </NativeSelect>
  );
}
```

`apps/web/src/features/shell/AppShell.tsx`
```tsx
import { Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Input } from '@/components/ui/input.tsx';
import { ProjectSelector } from './ProjectSelector.tsx';

function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void navigate({ to: '/history', search: q.trim() ? { q: q.trim() } : {} });
  };
  return (
    <form onSubmit={submit} className="w-72">
      <Input type="search" aria-label="Search all sessions" placeholder="Search sessions…" value={q} onChange={(e) => setQ(e.target.value)} className="w-full" />
    </form>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b px-4">
        <Link to="/history" className="font-semibold">
          Orchestrator
        </Link>
        <ProjectSelector />
        <GlobalSearch />
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Main" className="flex w-40 shrink-0 flex-col gap-1 border-r p-2 text-sm">
          <Link to="/history" className="rounded px-2 py-1 hover:bg-muted" activeProps={{ className: 'bg-muted font-medium' }}>
            History
          </Link>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="min-h-0 flex-1 overflow-auto">{children}</main>
        </div>
      </div>
    </div>
  );
}
```

`apps/web/src/router.tsx`
```tsx
import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen.ts';

export function createAppRouter() {
  return createRouter({ routeTree, defaultPreload: 'intent' });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
```

`apps/web/src/main.tsx`
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createAppRouter } from './router.tsx';
import './index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1 } } });
const router = createAppRouter();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
```

`apps/web/src/routes/__root.tsx`
```tsx
import { createRootRoute, Outlet } from '@tanstack/react-router';
import { AppShell } from '@/features/shell/AppShell.tsx';

export const Route = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
```

`apps/web/src/routes/index.tsx`
```tsx
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/history' });
  },
});
```

`apps/web/src/routes/history.tsx` (the page component is replaced in Task 16)
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { type HistorySearch, parseHistorySearch } from '@/features/history/filters.ts';

export const Route = createFileRoute('/history')({
  validateSearch: (search: Record<string, unknown>): HistorySearch => parseHistorySearch(search),
  component: () => <h1 className="p-4 text-lg font-semibold">History</h1>,
});
```

Delete the Phase 0 shell: `git rm apps/web/src/App.tsx apps/web/src/App.test.tsx`.

Generate the route tree: `pnpm --filter @orc/web routes:gen`
Expected: `apps/web/src/routeTree.gen.ts` is written. Commit it, and exclude it from Biome by adding `"!**/routeTree.gen.ts"` to `files.includes` in the root `biome.json` (generated code is never edited by hand).

- [ ] **Step 6: Run the tests, typecheck and build**

Run: `pnpm vitest run apps/web && pnpm --filter @orc/web typecheck && pnpm --filter @orc/web build`
Expected: PASS (format 3, filters 3, selector 2); typecheck exits 0; Vite writes `apps/web/dist/` without "externalized for browser compatibility" warnings (proves no `node:*` module reached the bundle).

- [ ] **Step 7: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): add router, query client, UI layer, app shell and project selector"
```

---

### Task 15: Project settings (F13)

**Files:**
- Modify: `apps/daemon/src/http/routes/projects.ts` (add `GET /api/projects/:id`)
- Create: `apps/daemon/src/http/projects-route.test.ts`
- Modify: `packages/api-contract/src/client.ts` (add `projectsGet`), `packages/api-contract/src/client.test.ts`
- Modify: `apps/web/src/test/fake-api.ts`, `apps/web/src/api/queries/projects.ts`, `apps/web/src/features/shell/AppShell.tsx`
- Create: `apps/web/src/features/settings/project-patch.ts`, `project-patch.test.ts`, `ProjectSettings.tsx`, `ProjectSettings.test.tsx`
- Create: `apps/web/src/routes/settings.tsx`

**Interfaces:**
- Consumes: `ProjectService.get/update` (Task 9), `useProjects`, `useUpdateProject` (Task 14), UI layer (Task 14).
- Produces:
  ```ts
  // contract addition: GET /api/projects/:id → ProjectConfig (404 not_found)
  ApiClient.projectsGet(id: string): Promise<ProjectConfig>
  // web
  export function useProjectConfig(id: string): UseQueryResult<ProjectConfig>          // key ['project', id]
  export interface ProjectFormValues { name: string; prefixes: string; hidden: boolean; openIn: 'vscode' | 'terminal' | 'finder'; ticketRegex: string }
  export function buildProjectPatch(cfg: ProjectConfig, v: ProjectFormValues): ProjectPatch   // only changed fields
  export function ProjectSettings(): JSX.Element                                       // route /settings
  ```
  F13 settings: rename, edit/merge path prefixes (one per line), hide (never deletes), open-in app, ticket regex. The default project stays `wakecap` (config `defaultProjectId`); the selector remembers the last choice.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/http/projects-route.test.ts`
```ts
import { ProjectConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../test/helpers.ts';
import { createApp } from './app.ts';

let ctx: TestContext;
afterEach(() => ctx.dispose());

describe('GET /api/projects/:id', () => {
  it('returns the full project config', async () => {
    ctx = createTestContext();
    const app = createApp({ ctx, token: 't', port: () => 4317, env: {} });
    const headers = { 'x-orc-token': 't' };
    const res = await app.request('http://127.0.0.1:4317/api/projects/wakecap', { headers });
    expect(res.status).toBe(200);
    expect(ProjectConfig.parse(await res.json())).toMatchObject({ id: 'wakecap', openIn: 'vscode' });
    expect((await app.request('http://127.0.0.1:4317/api/projects/nope', { headers })).status).toBe(404);
  });
});
```

Append to `packages/api-contract/src/client.test.ts` (inside the `createApiClient` describe):
```ts
  it('gets a single project config', async () => {
    const { fn, calls } = fakeFetch(200, { id: 'wakecap', name: 'Wakecap', pathPrefixes: ['/w'] });
    const cfg = await createApiClient({ baseUrl: '', token: 't', fetch: fn }).projectsGet('wakecap');
    expect(calls[0]?.url).toBe('/api/projects/wakecap');
    expect(cfg).toMatchObject({ id: 'wakecap', openIn: 'vscode', hidden: false });
  });
```

`apps/web/src/features/settings/project-patch.test.ts`
```ts
import { ProjectConfig } from '@orc/api-contract';
import { describe, expect, it } from 'vitest';
import { buildProjectPatch } from './project-patch.ts';

const cfg = ProjectConfig.parse({ id: 'forza', name: 'Forza', pathPrefixes: ['/Users/test/Forza'] });
const same = { name: 'Forza', prefixes: '/Users/test/Forza', hidden: false, openIn: 'vscode' as const, ticketRegex: '' };

describe('buildProjectPatch', () => {
  it('is empty when nothing changed', () => {
    expect(buildProjectPatch(cfg, same)).toEqual({});
    expect(buildProjectPatch(cfg, { ...same, name: '  ', prefixes: '\n' })).toEqual({});
  });

  it('includes only changed fields', () => {
    expect(
      buildProjectPatch(cfg, {
        name: ' Forza App ',
        prefixes: '/Users/test/Forza\n /Users/test/forza-web \n',
        hidden: true,
        openIn: 'terminal',
        ticketRegex: '\\bFZ-\\d+\\b',
      }),
    ).toEqual({
      name: 'Forza App',
      pathPrefixes: ['/Users/test/Forza', '/Users/test/forza-web'],
      hidden: true,
      openIn: 'terminal',
      ticketRegex: '\\bFZ-\\d+\\b',
    });
  });

  it('clears the ticket regex with an empty field', () => {
    const withRegex = ProjectConfig.parse({ ...cfg, ticketRegex: 'X-\\d+' });
    expect(buildProjectPatch(withRegex, { ...same, ticketRegex: ' ' })).toEqual({ ticketRegex: null });
  });
});
```

`apps/web/src/features/settings/ProjectSettings.test.tsx`
```tsx
import { ApiRequestError, ProjectConfig } from '@orc/api-contract';
import type { Project } from '@orc/core';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { ProjectSettings } from './ProjectSettings.tsx';

const projects: Project[] = [
  { id: 'wakecap', name: 'Wakecap', pathPrefixes: ['/Users/test/Wakecap'], hidden: false, lastActivityAt: null, sessionCount: 5 },
  { id: 'forza', name: 'Forza', pathPrefixes: ['/Users/test/Forza'], hidden: false, lastActivityAt: null, sessionCount: 1 },
];
const configs: Record<string, ProjectConfig> = {
  wakecap: ProjectConfig.parse({ id: 'wakecap', name: 'Wakecap', pathPrefixes: ['/Users/test/Wakecap'], ticketRegex: 'SAF-\\d+' }),
  forza: ProjectConfig.parse({ id: 'forza', name: 'Forza', pathPrefixes: ['/Users/test/Forza'] }),
};

function api(update = vi.fn(async (id: string) => configs[id] ?? configs.forza)) {
  return createFakeApi({
    projectsList: vi.fn(async () => projects),
    projectsGet: vi.fn(async (id: string) => {
      const c = configs[id];
      if (!c) throw new Error('missing');
      return c;
    }),
    projectsUpdate: update as never,
  });
}

describe('ProjectSettings', () => {
  it('saves only the changed fields of one project', async () => {
    const update = vi.fn(async (id: string) => configs[id] ?? configs.forza);
    renderWithProviders(<ProjectSettings />, { api: api(update) });
    const forza = within(await screen.findByRole('group', { name: /forza/i }));
    const save = forza.getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true);
    await userEvent.clear(forza.getByLabelText('Name'));
    await userEvent.type(forza.getByLabelText('Name'), 'Forza App');
    await userEvent.click(forza.getByLabelText('Hidden'));
    await userEvent.selectOptions(forza.getByLabelText('Open in'), 'terminal');
    expect(save).toHaveProperty('disabled', false);
    await userEvent.click(save);
    expect(update).toHaveBeenCalledWith('forza', { name: 'Forza App', hidden: true, openIn: 'terminal' });
    const wakecap = within(screen.getByRole('group', { name: /wakecap/i }));
    expect(wakecap.getByLabelText('Ticket regex')).toHaveProperty('value', 'SAF-\\d+');
  });

  it('shows API validation errors', async () => {
    const update = vi.fn(async () => {
      throw new ApiRequestError(400, 'validation_failed', 'ticketRegex is not a valid regular expression');
    });
    renderWithProviders(<ProjectSettings />, { api: api(update as never) });
    const forza = within(await screen.findByRole('group', { name: /forza/i }));
    await userEvent.type(forza.getByLabelText('Ticket regex'), '(');
    await userEvent.click(forza.getByRole('button', { name: 'Save' }));
    expect(await forza.findByRole('alert')).toHaveProperty('textContent', 'ticketRegex is not a valid regular expression');
  });
});
```

Run: `pnpm vitest run apps/daemon/src/http/projects-route packages/api-contract apps/web/src/features/settings`
Expected: FAIL (`projectsGet` does not exist; 404 for the new route; missing modules).

- [ ] **Step 2: Implement the daemon route and client method**

`apps/daemon/src/http/routes/projects.ts` — add inside `registerProjectRoutes`, after the list route:
```ts
  app.get('/api/projects/:id', (c) => {
    const cfg = ctx.projects.get(c.req.param('id'));
    if (!cfg) throw new ServiceError('not_found', 404, 'project not found');
    return c.json(cfg);
  });
```

`packages/api-contract/src/client.ts` — add to the `ApiClient` interface (after `projectsList`):
```ts
  projectsGet(id: string): Promise<ProjectConfig>;
```
and to the returned object (after `projectsList`):
```ts
    projectsGet: (id) => call(ProjectConfig, 'GET', `/api/projects/${encodeURIComponent(id)}`),
```

`apps/web/src/test/fake-api.ts` — add to `base` (after `projectsList`):
```ts
    projectsGet: unexpected('projectsGet'),
```

- [ ] **Step 3: Implement the web side**

`apps/web/src/api/queries/projects.ts` (full file)
```ts
import type { ProjectPatch } from '@orc/api-contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: () => getApiClient().projectsList(), staleTime: 60_000 });
}

export function useProjectConfig(id: string) {
  return useQuery({ queryKey: ['project', id], queryFn: () => getApiClient().projectsGet(id) });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; patch: ProjectPatch }) => getApiClient().projectsUpdate(v.id, v.patch),
    onSuccess: async (cfg, v) => {
      qc.setQueryData(['project', v.id], cfg);
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}
```

`apps/web/src/features/settings/project-patch.ts`
```ts
import type { ProjectConfig, ProjectPatch } from '@orc/api-contract';

export interface ProjectFormValues {
  name: string;
  prefixes: string;
  hidden: boolean;
  openIn: 'vscode' | 'terminal' | 'finder';
  ticketRegex: string;
}

export function buildProjectPatch(cfg: ProjectConfig, v: ProjectFormValues): ProjectPatch {
  const patch: ProjectPatch = {};
  const name = v.name.trim();
  if (name && name !== cfg.name) patch.name = name;
  const prefixes = v.prefixes
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);
  if (prefixes.length > 0 && JSON.stringify(prefixes) !== JSON.stringify(cfg.pathPrefixes)) patch.pathPrefixes = prefixes;
  if (v.hidden !== cfg.hidden) patch.hidden = v.hidden;
  if (v.openIn !== cfg.openIn) patch.openIn = v.openIn;
  const regex = v.ticketRegex.trim() || null;
  if (regex !== cfg.ticketRegex) patch.ticketRegex = regex;
  return patch;
}
```

`apps/web/src/features/settings/ProjectSettings.tsx`
```tsx
import type { ProjectConfig } from '@orc/api-contract';
import type { Project } from '@orc/core';
import { useId, useMemo, useState } from 'react';
import { useProjectConfig, useProjects, useUpdateProject } from '@/api/queries/projects.ts';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { buildProjectPatch, type ProjectFormValues } from './project-patch.ts';

const OPEN_IN: ProjectFormValues['openIn'][] = ['vscode', 'terminal', 'finder'];

function ProjectForm({ cfg, sessionCount }: { cfg: ProjectConfig; sessionCount: number }) {
  const update = useUpdateProject();
  const id = useId();
  const [values, setValues] = useState<ProjectFormValues>({
    name: cfg.name,
    prefixes: cfg.pathPrefixes.join('\n'),
    hidden: cfg.hidden,
    openIn: cfg.openIn,
    ticketRegex: cfg.ticketRegex ?? '',
  });
  const patch = useMemo(() => buildProjectPatch(cfg, values), [cfg, values]);
  const dirty = Object.keys(patch).length > 0;
  const set = <K extends keyof ProjectFormValues>(k: K, v: ProjectFormValues[K]) => setValues((prev) => ({ ...prev, [k]: v }));

  return (
    <fieldset className="grid grid-cols-[8rem_1fr] items-start gap-2 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">
        {cfg.id} · {sessionCount} sessions
      </legend>
      <label htmlFor={`${id}-name`} className="pt-1 text-sm">
        Name
      </label>
      <Input id={`${id}-name`} value={values.name} onChange={(e) => set('name', e.target.value)} />
      <label htmlFor={`${id}-prefixes`} className="pt-1 text-sm">
        Paths
      </label>
      <textarea
        id={`${id}-prefixes`}
        rows={Math.max(2, values.prefixes.split('\n').length)}
        className="rounded-md border bg-background px-2 py-1 font-mono text-xs"
        value={values.prefixes}
        onChange={(e) => set('prefixes', e.target.value)}
      />
      <label htmlFor={`${id}-open`} className="pt-1 text-sm">
        Open in
      </label>
      <NativeSelect
        id={`${id}-open`}
        value={values.openIn}
        onChange={(e) => set('openIn', e.target.value as ProjectFormValues['openIn'])}
        className="w-40"
      >
        {OPEN_IN.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </NativeSelect>
      <label htmlFor={`${id}-regex`} className="pt-1 text-sm">
        Ticket regex
      </label>
      <Input id={`${id}-regex`} className="font-mono" value={values.ticketRegex} onChange={(e) => set('ticketRegex', e.target.value)} />
      <label htmlFor={`${id}-hidden`} className="text-sm">
        Hidden
      </label>
      <Checkbox id={`${id}-hidden`} checked={values.hidden} onCheckedChange={(v) => set('hidden', v)} />
      <div />
      <div className="flex items-center gap-3">
        <Button disabled={!dirty || update.isPending} onClick={() => update.mutate({ id: cfg.id, patch })}>
          Save
        </Button>
        {update.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {update.error.message}
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const { data: cfg } = useProjectConfig(project.id);
  if (!cfg) return <Skeleton className="h-48" />;
  return <ProjectForm key={JSON.stringify(cfg)} cfg={cfg} sessionCount={project.sessionCount} />;
}

export function ProjectSettings() {
  const { data: projects, isLoading } = useProjects();
  return (
    <section className="flex max-w-3xl flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">Projects</h1>
      <p className="text-sm text-muted-foreground">
        Projects are detected from your session history. Hiding a project only hides it here; nothing is deleted.
      </p>
      {isLoading ? <Skeleton className="h-48" /> : null}
      {(projects ?? []).map((p) => (
        <ProjectRow key={p.id} project={p} />
      ))}
    </section>
  );
}
```

`<fieldset>` has the implicit ARIA role `group`, and its `<legend>` gives it the accessible name used by the test.

`apps/web/src/routes/settings.tsx`
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { ProjectSettings } from '@/features/settings/ProjectSettings.tsx';

export const Route = createFileRoute('/settings')({ component: ProjectSettings });
```

`apps/web/src/features/shell/AppShell.tsx` — add the Settings link right after the History link inside `<nav>`:
```tsx
          <Link to="/settings" className="rounded px-2 py-1 hover:bg-muted" activeProps={{ className: 'bg-muted font-medium' }}>
            Settings
          </Link>
```

Run: `pnpm --filter @orc/web routes:gen`

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/daemon/src/http packages/api-contract apps/web`
Expected: PASS

- [ ] **Step 5: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps packages
git commit -m "feat(web): add project settings for rename, paths, open-in, ticket regex and hide"
```

---

### Task 16: Session detail (F2 basic: header + timeline)

**Files:**
- Create: `apps/web/src/api/queries/sessions.ts`
- Create: `apps/web/src/lib/source.ts`
- Create: `apps/web/src/test/factories.ts`
- Create: `apps/web/src/features/session-detail/timeline-model.ts`, `timeline-model.test.ts`
- Create: `apps/web/src/features/session-detail/SessionHeader.tsx`, `Timeline.tsx`, `SessionDetailPage.tsx`, `SessionDetailPage.test.tsx`
- Create: `apps/web/src/routes/sessions/$source/$id.tsx`

**Interfaces:**
- Consumes: `getApiClient` (Task 14), `ApiClient.sessionsGet/sessionsEvents` (Task 5), UI layer and `lib/format.ts` (Task 14), `mcpToolLabel` from `@orc/core/browser` (Task 1).
- Produces:
  ```ts
  // api/queries/sessions.ts
  export function useSession(source: Source, id: string): UseQueryResult<Session>                          // key ['session', source, id]
  export function useSessionEvents(source: Source, id: string, agentId: string | null): UseInfiniteQueryResult<InfiniteData<SessionEventsResponse>>   // key ['session', source, id, 'events', agentId]
  export const EVENTS_PAGE_SIZE = 200;
  // lib/source.ts
  export function isSource(v: string): v is Source
  // features/session-detail/timeline-model.ts
  export interface ToolCall { call: TimelineEvent; result: TimelineEvent | null }
  export type TimelineItem = { type: 'event'; key: string; event: TimelineEvent } | { type: 'tools'; key: string; tool: string; label: string; calls: ToolCall[] };
  export interface TurnGroup { turn: number; prompt: TimelineEvent | null; items: TimelineItem[] }
  export function toolLabel(tool: string): string
  export function inputPreview(input: unknown): string
  export function groupTimeline(events: TimelineEvent[]): TurnGroup[]
  // components
  export function SessionHeader(p: { session: Session; actions?: ReactNode }): JSX.Element
  export function Timeline(p: { source: Source; id: string }): JSX.Element
  export function SessionDetailPage(p: { source: Source; id: string }): JSX.Element
  // test/factories.ts
  export function sessionFixture(o?: Partial<Session>): Session
  export function eventFixture(o: Partial<TimelineEvent> & { seq: number }): TimelineEvent
  export function listItemFixture(o: Partial<SessionListItem> & { id: string }): SessionListItem
  ```
  Timeline rules (F2): human prompts are collapsible section headers; consecutive calls of the same tool collapse into one "Bash ×N" group with their results attached by `toolUseId`; assistant text breaks a group; `thinking` is hidden in this basic view; `turn_duration` shows "Turn took …", `away_summary` shows "Recap: …", errors are highlighted. Events load 200 at a time with "Load more".

- [ ] **Step 1: Write the factories and failing tests**

`apps/web/src/test/factories.ts`
```ts
import type { SessionListItem } from '@orc/api-contract';
import type { Session, TimelineEvent } from '@orc/core';

export function sessionFixture(o: Partial<Session> = {}): Session {
  return {
    id: 's1',
    source: 'claude',
    projectId: 'wakecap',
    startCwd: '/Users/test/Wakecap',
    cwds: ['/Users/test/Wakecap'],
    name: 'Notification service test check',
    firstPrompt: 'check the notification service tests',
    lastPrompt: 'continue',
    awaySummary: null,
    recap: null,
    startedAt: '2026-09-01T09:00:00.000Z',
    lastActivityAt: '2026-09-01T09:07:00.000Z',
    models: ['claude-opus-5'],
    permissionMode: 'bypassPermissions',
    usage: { input: 15, output: 27, cacheRead: 2100, cacheWrite: 100, costUsd: 0.42 },
    linesAdded: 1,
    linesRemoved: 1,
    prs: [],
    tickets: [],
    skills: [],
    mcpServers: [],
    filesTouched: [],
    promptCount: 3,
    toolCallCount: 2,
    apiErrorCount: 0,
    flags: { touchedProd: false, hasSubagents: false, automated: false },
    availability: 'resumable',
    transcriptPath: '/t.jsonl',
    lastTest: null,
    live: null,
    ...o,
  };
}

export function eventFixture(o: Partial<TimelineEvent> & { seq: number }): TimelineEvent {
  return {
    sessionId: 's1',
    agentId: null,
    uuid: `u${o.seq}`,
    parentUuid: null,
    ts: '2026-09-01T09:00:00.000Z',
    kind: 'assistant_text',
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
    ...o,
  };
}

export function listItemFixture(o: Partial<SessionListItem> & { id: string }): SessionListItem {
  const source = o.source ?? 'claude';
  return {
    pk: `${source}:${o.id}`,
    source,
    projectId: 'wakecap',
    name: `Session ${o.id}`,
    firstPrompt: 'first prompt',
    lastPrompt: 'last prompt',
    recap: null,
    startedAt: '2026-09-01T09:00:00.000Z',
    lastActivityAt: '2026-09-01T09:07:00.000Z',
    durationMs: 420_000,
    costUsd: 0.42,
    tickets: [],
    prs: [],
    availability: 'resumable',
    pinned: false,
    labels: [],
    live: null,
    snippet: null,
    ...o,
  };
}
```

`apps/web/src/features/session-detail/timeline-model.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { eventFixture as ev } from '../../test/factories.ts';
import { groupTimeline, inputPreview, toolLabel } from './timeline-model.ts';

describe('timeline model', () => {
  it('labels tools', () => {
    expect(toolLabel('Bash')).toBe('Bash');
    expect(toolLabel('mcp__claude_ai_Linear__save_issue')).toBe('Linear save_issue');
  });

  it('previews inputs', () => {
    expect(inputPreview({ command: 'pnpm test', description: 'x' })).toBe('pnpm test');
    expect(inputPreview({ file_path: '/a.ts', old_string: 'a' })).toBe('/a.ts');
    expect(inputPreview({ id: 'SAF-1' })).toBe('{"id":"SAF-1"}');
    expect(inputPreview('x'.repeat(300))).toHaveLength(201);
    expect(inputPreview(null)).toBe('');
  });

  it('groups turns, consecutive tools and attaches results', () => {
    const turns = groupTimeline([
      ev({ seq: 1, kind: 'prompt', turn: 1, text: 'check tests' }),
      ev({ seq: 2, kind: 'assistant_text', text: 'Running.' }),
      ev({ seq: 3, kind: 'tool_call', tool: 'Bash', toolUseId: 't1', input: { command: 'pnpm test' } }),
      ev({ seq: 4, kind: 'tool_result', toolUseId: 't1', text: '18 passed' }),
      ev({ seq: 5, kind: 'thinking', text: 'hmm' }),
      ev({ seq: 6, kind: 'tool_call', tool: 'Bash', toolUseId: 't2', input: { command: 'git status' } }),
      ev({ seq: 7, kind: 'tool_call', tool: 'Edit', toolUseId: 't3', input: { file_path: '/a.ts' } }),
      ev({ seq: 8, kind: 'assistant_text', text: 'Edited.' }),
      ev({ seq: 9, kind: 'tool_call', tool: 'Bash', toolUseId: 't4' }),
      ev({ seq: 10, kind: 'system', tool: 'turn_duration', durationMs: 36000 }),
      ev({ seq: 11, kind: 'prompt', turn: 2, text: 'continue' }),
      ev({ seq: 12, kind: 'tool_result', turn: 2, toolUseId: 'from-earlier-page', text: 'orphan' }),
    ]);
    expect(turns.map((t) => [t.turn, t.prompt?.text ?? null])).toEqual([
      [1, 'check tests'],
      [2, 'continue'],
    ]);
    const first = turns[0]?.items ?? [];
    expect(first.map((i) => (i.type === 'tools' ? `${i.label}×${i.calls.length}` : i.event.kind))).toEqual([
      'assistant_text',
      'Bash×2',
      'Edit×1',
      'assistant_text',
      'Bash×1',
      'system',
    ]);
    const bash = first[1];
    expect(bash?.type === 'tools' && bash.calls.map((c) => c.result?.text ?? null)).toEqual(['18 passed', null]);
    expect(turns[1]?.items.map((i) => (i.type === 'event' ? i.event.text : ''))).toEqual(['orphan']);
  });

  it('keeps events before the first prompt in turn 0', () => {
    const turns = groupTimeline([ev({ seq: 1, turn: 0, kind: 'system', tool: 'x', text: 'boot' })]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ turn: 0, prompt: null });
  });
});
```

`apps/web/src/features/session-detail/SessionDetailPage.test.tsx`
```tsx
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createFakeApi } from '../../test/fake-api.ts';
import { eventFixture as ev, sessionFixture } from '../../test/factories.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { SessionDetailPage } from './SessionDetailPage.tsx';

const session = sessionFixture({
  cwds: ['/Users/test/Wakecap', '/Users/test/Wakecap/Backend/svc'],
  tickets: ['SAF-1787'],
  prs: [{ repo: 'example-org/svc', number: 231, url: 'https://github.com/example-org/svc/pull/231' }],
  lastTest: { ts: 't', command: 'pnpm vitest run', passed: 18, failed: 0, skipped: 0, durationMs: 1400 },
  flags: { touchedProd: true, hasSubagents: false, automated: false },
});

describe('SessionDetailPage', () => {
  it('renders the header and a grouped, paged timeline', async () => {
    const sessionsEvents = vi.fn(async (_s: string, _i: string, opts?: { afterSeq?: number }) =>
      (opts?.afterSeq ?? 0) === 0
        ? {
            items: [
              ev({ seq: 1, kind: 'prompt', text: 'check the notification service tests' }),
              ev({ seq: 2, kind: 'tool_call', tool: 'Bash', toolUseId: 't1', input: { command: 'pnpm vitest run' } }),
              ev({ seq: 3, kind: 'tool_result', toolUseId: 't1', text: 'Tests 18 passed' }),
              ev({ seq: 4, kind: 'tool_call', tool: 'Bash', toolUseId: 't2', input: { command: 'git status' } }),
            ],
            nextSeq: 4,
          }
        : {
            items: [
              ev({ seq: 5, kind: 'system', tool: 'turn_duration', durationMs: 36000 }),
              ev({ seq: 6, kind: 'error', text: 'API Error: 529 overloaded' }),
              ev({ seq: 7, kind: 'prompt', turn: 2, text: 'continue' }),
              ev({ seq: 8, kind: 'system', turn: 2, tool: 'away_summary', text: 'Ran tests.' }),
            ],
            nextSeq: null,
          },
    );
    const api = createFakeApi({ sessionsGet: vi.fn(async () => session), sessionsEvents });
    renderWithProviders(<SessionDetailPage source="claude" id="s1" />, { api });

    expect(await screen.findByRole('heading', { level: 1, name: 'Notification service test check' })).toBeTruthy();
    expect(screen.getByText('(+1 drift)')).toBeTruthy();
    expect(screen.getByRole('link', { name: '#231' }).getAttribute('href')).toBe('https://github.com/example-org/svc/pull/231');
    expect(screen.getByText('SAF-1787')).toBeTruthy();
    expect(screen.getByText('✓ 18 · ✗ 0')).toBeTruthy();
    expect(screen.getByText('prod')).toBeTruthy();
    expect(screen.getByText('$0.42 · 2.2k tokens')).toBeTruthy();

    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    expect(within(timeline).getByText('check the notification service tests')).toBeTruthy();
    expect(within(timeline).getByText('Bash ×2')).toBeTruthy();
    expect(within(timeline).getByText('pnpm vitest run')).toBeTruthy();
    expect(within(timeline).getByText('Tests 18 passed')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await within(timeline).findByText('Turn took 36s')).toBeTruthy();
    expect(within(timeline).getByText('API error: API Error: 529 overloaded')).toBeTruthy();
    expect(within(timeline).getByText('Recap: Ran tests.')).toBeTruthy();
    expect(sessionsEvents).toHaveBeenLastCalledWith('claude', 's1', { agentId: undefined, afterSeq: 4, limit: 200 });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('explains prompts-only sessions and missing sessions', async () => {
    const api = createFakeApi({
      sessionsGet: vi.fn(async () => sessionFixture({ availability: 'prompts-only', transcriptPath: null })),
    });
    renderWithProviders(<SessionDetailPage source="claude" id="s1" />, { api });
    expect(await screen.findByText(/only exists in prompt history/)).toBeTruthy();
    expect(screen.getByText('prompts-only')).toBeTruthy();
  });

  it('shows an error when the session cannot be loaded', async () => {
    const api = createFakeApi({
      sessionsGet: vi.fn(async () => {
        throw new Error('session claude:nope not found');
      }),
    });
    renderWithProviders(<SessionDetailPage source="claude" id="nope" />, { api });
    expect((await screen.findByRole('alert')).textContent).toBe('session claude:nope not found');
  });
});
```

Run: `pnpm vitest run apps/web/src/features/session-detail`
Expected: FAIL, `Cannot find module './timeline-model.ts'`

- [ ] **Step 2: Implement queries, helpers and the timeline model**

`apps/web/src/api/queries/sessions.ts`
```ts
import type { Source } from '@orc/core';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export const EVENTS_PAGE_SIZE = 200;

export function useSession(source: Source, id: string) {
  return useQuery({ queryKey: ['session', source, id], queryFn: () => getApiClient().sessionsGet(source, id) });
}

export function useSessionEvents(source: Source, id: string, agentId: string | null) {
  return useInfiniteQuery({
    queryKey: ['session', source, id, 'events', agentId],
    queryFn: ({ pageParam }) =>
      getApiClient().sessionsEvents(source, id, {
        agentId: agentId ?? undefined,
        afterSeq: pageParam,
        limit: EVENTS_PAGE_SIZE,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextSeq,
  });
}
```

`apps/web/src/lib/source.ts`
```ts
import type { Source } from '@orc/core';

const SOURCES: readonly string[] = ['claude', 'codex', 'agnc'];

export function isSource(v: string): v is Source {
  return SOURCES.includes(v);
}
```

`apps/web/src/features/session-detail/timeline-model.ts`
```ts
import { mcpToolLabel } from '@orc/core/browser';
import type { TimelineEvent } from '@orc/core';

export interface ToolCall {
  call: TimelineEvent;
  result: TimelineEvent | null;
}

export type TimelineItem =
  | { type: 'event'; key: string; event: TimelineEvent }
  | { type: 'tools'; key: string; tool: string; label: string; calls: ToolCall[] };

export interface TurnGroup {
  turn: number;
  prompt: TimelineEvent | null;
  items: TimelineItem[];
}

export function toolLabel(tool: string): string {
  return mcpToolLabel(tool);
}

export function inputPreview(input: unknown): string {
  if (input === null || input === undefined) return '';
  let text: string;
  if (typeof input === 'string') text = input;
  else if (typeof input === 'object' && !Array.isArray(input)) {
    const o = input as Record<string, unknown>;
    if (typeof o.command === 'string') text = o.command;
    else if (typeof o.file_path === 'string') text = o.file_path;
    else text = JSON.stringify(o);
  } else text = JSON.stringify(input);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export function groupTimeline(events: TimelineEvent[]): TurnGroup[] {
  const results = new Map<string, TimelineEvent>();
  const callIds = new Set<string>();
  for (const e of events) {
    if (e.kind === 'tool_result' && e.toolUseId) results.set(e.toolUseId, e);
    if (e.kind === 'tool_call' && e.toolUseId) callIds.add(e.toolUseId);
  }
  const turns: TurnGroup[] = [];
  let current: TurnGroup | null = null;
  let tools: Extract<TimelineItem, { type: 'tools' }> | null = null;
  for (const e of events) {
    if (!current || e.turn !== current.turn) {
      current = { turn: e.turn, prompt: e.kind === 'prompt' ? e : null, items: [] };
      turns.push(current);
      tools = null;
      if (e.kind === 'prompt') continue;
    }
    if (e.kind === 'thinking') continue;
    if (e.kind === 'tool_result' && e.toolUseId && callIds.has(e.toolUseId)) continue;
    if (e.kind === 'tool_call' && e.tool) {
      const call: ToolCall = { call: e, result: e.toolUseId ? (results.get(e.toolUseId) ?? null) : null };
      if (tools && tools.tool === e.tool) {
        tools.calls.push(call);
      } else {
        tools = { type: 'tools', key: `t-${e.seq}`, tool: e.tool, label: toolLabel(e.tool), calls: [call] };
        current.items.push(tools);
      }
      continue;
    }
    tools = null;
    current.items.push({ type: 'event', key: `e-${e.seq}`, event: e });
  }
  return turns;
}
```

- [ ] **Step 3: Implement the components and route**

`apps/web/src/features/session-detail/SessionHeader.tsx`
```tsx
import type { Session } from '@orc/core';
import type { ReactNode } from 'react';
import { Badge, type BadgeVariant } from '@/components/ui/badge.tsx';
import { formatCost, formatDateTime, formatDuration, formatTokens, shortenPath } from '@/lib/format.ts';

const AVAILABILITY_VARIANT: Record<Session['availability'], BadgeVariant> = {
  resumable: 'success',
  archived: 'warning',
  'prompts-only': 'outline',
  remote: 'secondary',
};

export function SessionHeader({ session, actions }: { session: Session; actions?: ReactNode }) {
  const title = session.name ?? session.firstPrompt ?? session.id;
  const drift = session.cwds.filter((c) => c !== session.startCwd);
  const duration = Date.parse(session.lastActivityAt) - Date.parse(session.startedAt);
  const u = session.usage;
  const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
  return (
    <header className="flex flex-col gap-3 border-b pb-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold" title={title}>
            {title}
          </h1>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge variant="secondary">{session.source}</Badge>
            <Badge variant={AVAILABILITY_VARIANT[session.availability]}>{session.availability}</Badge>
            {session.permissionMode ? <Badge variant="outline">{session.permissionMode}</Badge> : null}
            {session.flags.touchedProd ? <Badge variant="destructive">prod</Badge> : null}
            {session.live ? (
              <Badge variant={session.live.status === 'ended' ? 'outline' : 'warning'}>
                {session.live.ownership === 'owned' ? 'open in app' : session.live.status}
              </Badge>
            ) : null}
          </div>
        </div>
        {actions}
      </div>
      <dl className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Started</dt>
        <dd>{formatDateTime(session.startedAt)}</dd>
        <dt className="text-muted-foreground">Last activity</dt>
        <dd>{formatDateTime(session.lastActivityAt)}</dd>
        <dt className="text-muted-foreground">Duration</dt>
        <dd>{formatDuration(duration)}</dd>
        <dt className="text-muted-foreground">Models</dt>
        <dd>{session.models.join(', ') || '—'}</dd>
        <dt className="text-muted-foreground">Directory</dt>
        <dd title={session.startCwd} className="font-mono text-xs">
          {shortenPath(session.startCwd)}{' '}
          {drift.length > 0 ? (
            <span title={drift.join('\n')} className="text-warning">
              (+{drift.length} drift)
            </span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">Cost</dt>
        <dd>
          {formatCost(u.costUsd)} · {formatTokens(tokens)} tokens
        </dd>
        <dt className="text-muted-foreground">Lines</dt>
        <dd>{session.linesAdded === null ? '—' : `+${session.linesAdded} / −${session.linesRemoved ?? 0}`}</dd>
        <dt className="text-muted-foreground">Last test</dt>
        <dd>{session.lastTest ? `✓ ${session.lastTest.passed} · ✗ ${session.lastTest.failed}` : '—'}</dd>
      </dl>
      <div className="flex flex-wrap gap-1">
        {session.tickets.map((t) => (
          <Badge key={t} variant="outline">
            {t}
          </Badge>
        ))}
        {session.prs.map((pr) => (
          <a key={pr.url} href={pr.url} target="_blank" rel="noreferrer" className="text-xs text-primary underline" title={pr.repo}>
            #{pr.number}
          </a>
        ))}
        {session.skills.map((s) => (
          <Badge key={s} variant="secondary">
            /{s}
          </Badge>
        ))}
      </div>
    </header>
  );
}
```

`apps/web/src/features/session-detail/Timeline.tsx`
```tsx
import type { Source } from '@orc/core';
import { useMemo } from 'react';
import { useSessionEvents } from '@/api/queries/sessions.ts';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { formatDuration } from '@/lib/format.ts';
import { groupTimeline, inputPreview, type TimelineItem, type TurnGroup } from './timeline-model.ts';

function EventView({ item }: { item: Extract<TimelineItem, { type: 'event' }> }) {
  const e = item.event;
  if (e.kind === 'system' && e.tool === 'turn_duration') {
    return <p className="text-xs text-muted-foreground">Turn took {formatDuration(e.durationMs)}</p>;
  }
  if (e.kind === 'system' && e.tool === 'away_summary') {
    return <p className="rounded bg-muted px-2 py-1 text-sm">Recap: {e.text}</p>;
  }
  if (e.kind === 'error') {
    return <p className="text-sm text-destructive">API error: {e.text}</p>;
  }
  if (e.kind === 'tool_result') {
    return <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{e.text}</pre>;
  }
  if (e.kind === 'system') {
    return <p className="text-xs text-muted-foreground">{e.text ?? e.tool}</p>;
  }
  return <p className="text-sm whitespace-pre-wrap">{e.text}</p>;
}

function ToolsView({ item }: { item: Extract<TimelineItem, { type: 'tools' }> }) {
  return (
    <details className="rounded border px-2 py-1">
      <summary className="cursor-pointer text-sm font-medium">
        {item.label} ×{item.calls.length}
      </summary>
      <ul className="mt-1 flex flex-col gap-2">
        {item.calls.map(({ call, result }) => (
          <li key={call.seq} className="flex flex-col gap-1">
            <code className="text-xs">{inputPreview(call.input)}</code>
            {result ? (
              <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{result.text}</pre>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function TurnSection({ turn }: { turn: TurnGroup }) {
  return (
    <li className="rounded-lg border">
      <details open>
        <summary className="cursor-pointer bg-muted px-3 py-2 text-sm">
          {turn.prompt ? (
            <>
              <span className="mr-2 text-muted-foreground">#{turn.turn}</span>
              <span className="font-medium whitespace-pre-wrap">{turn.prompt.text}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Before the first prompt</span>
          )}
        </summary>
        <ul className="flex flex-col gap-2 p-3">
          {turn.items.map((item) => (
            <li key={item.key}>{item.type === 'tools' ? <ToolsView item={item} /> : <EventView item={item} />}</li>
          ))}
        </ul>
      </details>
    </li>
  );
}

export function Timeline({ source, id }: { source: Source; id: string }) {
  const q = useSessionEvents(source, id, null);
  const turns = useMemo(() => groupTimeline(q.data?.pages.flatMap((p) => p.items) ?? []), [q.data]);
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.isError) return <p role="alert">{q.error.message}</p>;
  if (turns.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No transcript events. This session only exists in prompt history (or its transcript has not been indexed yet).
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ol aria-label="Timeline" className="flex flex-col gap-3">
        {turns.map((t) => (
          <TurnSection key={`turn-${t.turn}`} turn={t} />
        ))}
      </ol>
      {q.hasNextPage ? (
        <Button variant="outline" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </div>
  );
}
```

`apps/web/src/features/session-detail/SessionDetailPage.tsx`
```tsx
import type { Source } from '@orc/core';
import { useSession } from '@/api/queries/sessions.ts';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { SessionHeader } from './SessionHeader.tsx';
import { Timeline } from './Timeline.tsx';

export function SessionDetailPage({ source, id }: { source: Source; id: string }) {
  const q = useSession(source, id);
  if (q.isLoading) {
    return (
      <div className="p-4">
        <Skeleton className="h-32" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        {q.error?.message ?? 'Session not found'}
      </p>
    );
  }
  const session = q.data;
  return (
    <div className="flex flex-col gap-4 p-4">
      <SessionHeader session={session} />
      <Tabs defaultValue="timeline">
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline" className="pt-3">
          <Timeline source={source} id={id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

`apps/web/src/routes/sessions/$source/$id.tsx`
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { SessionDetailPage } from '@/features/session-detail/SessionDetailPage.tsx';
import { isSource } from '@/lib/source.ts';

export const Route = createFileRoute('/sessions/$source/$id')({ component: SessionDetailRoute });

function SessionDetailRoute() {
  const { source, id } = Route.useParams();
  if (!isSource(source)) return <p className="p-4">Unknown source “{source}”.</p>;
  return <SessionDetailPage key={`${source}:${id}`} source={source} id={id} />;
}
```

Run: `pnpm --filter @orc/web routes:gen`

Note on the test's `'$0.42 · 2.2k tokens'`: tokens = 15 + 27 + 2100 + 100 = 2242 → `2.2k`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/web`
Expected: PASS (timeline model 4, session detail 3, plus earlier web suites).

- [ ] **Step 5: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/web
git commit -m "feat(web): add session detail header and grouped, paged timeline"
```

---

### Task 17: History page (F3)

**Files:**
- Modify: `apps/web/src/api/queries/sessions.ts` (list, pin, labels hooks)
- Create: `apps/web/src/api/queries/views.ts`
- Create: `apps/web/src/features/history/Snippet.tsx`, `DebouncedInput.tsx`, `HistoryFilters.tsx`, `SessionTable.tsx`, `SavedViews.tsx`, `LabelEditor.tsx`, `HistoryPage.tsx`
- Create: `apps/web/src/features/history/Snippet.test.tsx`, `apps/web/src/features/history/HistoryPage.test.tsx`
- Modify (replace): `apps/web/src/routes/history.tsx`

**Interfaces:**
- Consumes: `HistorySearch`, `parseHistorySearch`, `cleanSearch`, `toListFilters`, `searchToViewQuery`, `viewQueryToSearch` (Task 14); `useProjectStore` (Task 14); `ApiClient.sessionsList/sessionsPin/sessionsLabel/labelsList/viewsList/viewsSave/viewsDelete` (Task 5); `SNIPPET_OPEN`, `SNIPPET_CLOSE`, `HIDDEN_LABEL` (Task 5); `listItemFixture` (Task 16).
- Produces:
  ```ts
  // api/queries/sessions.ts (added)
  export function useSessions(filters: SessionListFilters): UseInfiniteQueryResult<InfiniteData<SessionListResponse>>   // key ['sessions', filters]
  export function usePinSession(): UseMutationResult<{ pinned: boolean }, Error, { source: Source; id: string; pinned: boolean }>
  export function useSetLabels(): UseMutationResult<{ labels: string[] }, Error, { source: Source; id: string; labels: string[] }>
  export function useLabels(): UseQueryResult<string[]>                                                                 // key ['labels']
  // api/queries/views.ts
  export function useSavedViews(): UseQueryResult<SavedView[]>                                                        // key ['views']
  export function useSaveView(): UseMutationResult<SavedView, Error, { name: string; query: Record<string, string> }>
  export function useDeleteView(): UseMutationResult<{ ok: true }, Error, string>
  // features/history
  export function Snippet(p: { text: string }): JSX.Element                         // ⟦…⟧ → <mark>
  export function DebouncedInput(p: { value: string; onCommit(v: string): void; delayMs?: number } & Omit<ComponentProps<'input'>, 'value' | 'onChange'>): JSX.Element
  export function HistoryFilters(p: { search: HistorySearch; onChange(patch: Partial<HistorySearch>): void; onReset(): void }): JSX.Element
  export interface SessionTableProps { items: SessionListItem[]; loading: boolean; hasMore: boolean; loadingMore: boolean; onEndReached(): void }
  export function SessionTable(p: SessionTableProps): JSX.Element
  export const SESSION_ROW_HEIGHT = 64;
  export function SavedViews(p: { search: HistorySearch; onApply(s: HistorySearch): void }): JSX.Element
  export function LabelEditor(p: { item: SessionListItem }): JSX.Element
  export function HideToggle(p: { item: SessionListItem }): JSX.Element
  export function HistoryPage(p: { search: HistorySearch; onSearchChange(next: HistorySearch): void }): JSX.Element
  ```
  F3: full-text search (debounced 250 ms), filters (source, availability, ticket, PR, date range, model, cost range, skill, label, has-subagents, touched-prod, pinned, show hidden, show automated Codex), rows with name/snippet or recap, first/last prompt, date, duration, cost, chips; saved views, pinning, labels and hide (reserved label `hidden`) — all stored in the app DB only. The table is TanStack Table v9 + TanStack Virtual with infinite paging.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/features/history/Snippet.test.tsx`
```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Snippet } from './Snippet.tsx';

describe('Snippet', () => {
  it('highlights marked ranges', () => {
    const { container } = render(<Snippet text="…check the ⟦notification⟧ service ⟦tests⟧" />);
    expect([...container.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['notification', 'tests']);
    expect(container.textContent).toBe('…check the notification service tests');
  });

  it('renders unmarked and unbalanced text as-is', () => {
    const { container } = render(<Snippet text="plain ⟦open" />);
    expect(container.querySelectorAll('mark')).toHaveLength(0);
    expect(container.textContent).toBe('plain open');
  });
});
```

`apps/web/src/features/history/HistoryPage.test.tsx`
```tsx
import type { SessionListFilters } from '@orc/api-contract';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../../stores/project.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { listItemFixture } from '../../test/factories.ts';
import { renderWithProviders } from '../../test/render.tsx';
import type { HistorySearch } from './filters.ts';
import { HistoryPage } from './HistoryPage.tsx';

function Harness({ initial = {} }: { initial?: HistorySearch }) {
  const [search, setSearch] = useState<HistorySearch>(initial);
  return (
    <>
      <output data-testid="search">{JSON.stringify(search)}</output>
      <HistoryPage search={search} onSearchChange={setSearch} />
    </>
  );
}

const currentSearch = () => JSON.parse(screen.getByTestId('search').textContent ?? '{}') as HistorySearch;

const items = [
  listItemFixture({
    id: 's-basic',
    name: 'Notification service test check',
    snippet: 'check the ⟦notification⟧ service',
    tickets: ['SAF-1787'],
    prs: [{ repo: 'o/r', number: 231, url: 'https://github.com/o/r/pull/231' }],
    labels: ['later'],
  }),
  listItemFixture({ id: 's-old', name: 'old session from december', availability: 'prompts-only', costUsd: null }),
];

describe('HistoryPage', () => {
  beforeEach(() => useProjectStore.setState({ projectId: 'wakecap' }));

  it('renders rows with links, snippets and chips', async () => {
    const api = createFakeApi({ sessionsList: vi.fn(async () => ({ items, nextCursor: null })) });
    renderWithProviders(<Harness />, { api });
    const link = await screen.findByRole('link', { name: 'Notification service test check' });
    expect(link.getAttribute('href')).toBe('/sessions/claude/s-basic');
    const row = link.closest('tr');
    if (!row) throw new Error('row missing');
    const r = within(row);
    expect(r.getByText('notification').tagName).toBe('MARK');
    expect(r.getByText('SAF-1787')).toBeTruthy();
    expect(r.getByRole('link', { name: '#231' })).toBeTruthy();
    expect(r.getByText('later')).toBeTruthy();
    expect(r.getByText('$0.42')).toBeTruthy();
    expect(r.getByText('7m')).toBeTruthy();
    expect(screen.getByText('prompts-only')).toBeTruthy();
    expect(api.sessionsList).toHaveBeenCalledWith({ projectId: 'wakecap', limit: 50 });
  });

  it('debounces search and applies filters to the query', async () => {
    const sessionsList = vi.fn(async (_f: SessionListFilters) => ({ items, nextCursor: null }));
    renderWithProviders(<Harness />, { api: createFakeApi({ sessionsList }) });
    await screen.findByRole('link', { name: 'Notification service test check' });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search sessions' }), 'weekend');
    await waitFor(() => expect(currentSearch()).toEqual({ q: 'weekend' }));
    await waitFor(() => expect(sessionsList).toHaveBeenLastCalledWith({ q: 'weekend', projectId: 'wakecap', limit: 50 }));

    await userEvent.click(screen.getByRole('checkbox', { name: 'Touched prod' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Source' }), 'codex');
    await waitFor(() => expect(currentSearch()).toEqual({ q: 'weekend', touchedProd: true, source: 'codex' }));
    await waitFor(() =>
      expect(sessionsList).toHaveBeenLastCalledWith({
        q: 'weekend',
        touchedProd: true,
        source: 'codex',
        projectId: 'wakecap',
        limit: 50,
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(currentSearch()).toEqual({});
    expect((screen.getByRole('searchbox', { name: 'Search sessions' }) as HTMLInputElement).value).toBe('');
  });

  it('queries all projects when "All projects" is selected', async () => {
    useProjectStore.setState({ projectId: 'all' });
    const sessionsList = vi.fn(async () => ({ items: [], nextCursor: null }));
    renderWithProviders(<Harness />, { api: createFakeApi({ sessionsList }) });
    expect(await screen.findByText('No sessions match these filters.')).toBeTruthy();
    expect(sessionsList).toHaveBeenCalledWith({ projectId: undefined, limit: 50 });
  });

  it('loads the next page when scrolled to the end', async () => {
    const sessionsList = vi.fn(async (f: SessionListFilters) =>
      f.cursor ? { items: [listItemFixture({ id: 'page-2' })], nextCursor: null } : { items, nextCursor: 'c1' },
    );
    renderWithProviders(<Harness />, { api: createFakeApi({ sessionsList }) });
    expect(await screen.findByRole('link', { name: 'Session page-2' })).toBeTruthy();
    expect(sessionsList).toHaveBeenLastCalledWith({ projectId: 'wakecap', limit: 50, cursor: 'c1' });
  });

  it('pins, labels and hides rows', async () => {
    const api = createFakeApi({ sessionsList: vi.fn(async () => ({ items, nextCursor: null })) });
    renderWithProviders(<Harness />, { api });
    const link = await screen.findByRole('link', { name: 'Notification service test check' });
    const row = within(link.closest('tr') as HTMLElement);
    await userEvent.click(row.getByRole('button', { name: 'Pin' }));
    await waitFor(() => expect(api.sessionsPin).toHaveBeenCalledWith('claude', 's-basic', true));

    await userEvent.click(row.getByRole('button', { name: 'Labels' }));
    const input = row.getByRole('textbox', { name: 'Labels' });
    await userEvent.clear(input);
    await userEvent.type(input, 'bug, later{Enter}');
    await waitFor(() => expect(api.sessionsLabel).toHaveBeenCalledWith('claude', 's-basic', ['bug', 'later']));

    await userEvent.click(row.getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(api.sessionsLabel).toHaveBeenLastCalledWith('claude', 's-basic', ['later', 'hidden']));
  });

  it('applies, saves and deletes saved views', async () => {
    const viewsSave = vi.fn(async (b: { name: string; query: Record<string, string> }) => ({
      id: 'v2',
      name: b.name,
      query: b.query,
      createdAt: 'now',
    }));
    const api = createFakeApi({
      sessionsList: vi.fn(async () => ({ items, nextCursor: null })),
      viewsList: vi.fn(async () => [{ id: 'v1', name: 'Prod', query: { touchedProd: 'true' }, createdAt: 'now' }]),
      viewsSave,
    });
    renderWithProviders(<Harness initial={{ q: 'weekend' }} />, { api });
    await userEvent.click(await screen.findByRole('button', { name: 'Prod' }));
    expect(currentSearch()).toEqual({ touchedProd: true });

    await userEvent.type(screen.getByRole('textbox', { name: 'View name' }), 'Prod sessions');
    await userEvent.click(screen.getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(viewsSave).toHaveBeenCalledWith({ name: 'Prod sessions', query: { touchedProd: 'true' } }));

    await userEvent.click(screen.getByRole('button', { name: 'Delete view Prod' }));
    await waitFor(() => expect(api.viewsDelete).toHaveBeenCalledWith('v1'));
  });
});
```

Run: `pnpm vitest run apps/web/src/features/history`
Expected: FAIL, `Cannot find module './Snippet.tsx'` / `'./HistoryPage.tsx'`

- [ ] **Step 2: Implement the query hooks**

Append to `apps/web/src/api/queries/sessions.ts` (and extend its imports to `import type { SessionListFilters } from '@orc/api-contract';` and `import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';`):
```ts
export function useSessions(filters: SessionListFilters) {
  return useInfiniteQuery({
    queryKey: ['sessions', filters],
    queryFn: ({ pageParam }) => getApiClient().sessionsList(pageParam ? { ...filters, cursor: pageParam } : filters),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function usePinSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { source: Source; id: string; pinned: boolean }) => getApiClient().sessionsPin(v.source, v.id, v.pinned),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
}

export function useSetLabels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { source: Source; id: string; labels: string[] }) => getApiClient().sessionsLabel(v.source, v.id, v.labels),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['sessions'] });
      await qc.invalidateQueries({ queryKey: ['labels'] });
    },
  });
}

export function useLabels() {
  return useQuery({ queryKey: ['labels'], queryFn: () => getApiClient().labelsList() });
}
```

`apps/web/src/api/queries/views.ts`
```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export function useSavedViews() {
  return useQuery({ queryKey: ['views'], queryFn: () => getApiClient().viewsList() });
}

export function useSaveView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; query: Record<string, string> }) => getApiClient().viewsSave(v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['views'] }),
  });
}

export function useDeleteView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApiClient().viewsDelete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['views'] }),
  });
}
```

- [ ] **Step 3: Implement the history components**

`apps/web/src/features/history/Snippet.tsx`
```tsx
import { SNIPPET_CLOSE, SNIPPET_OPEN } from '@orc/api-contract';

export function Snippet({ text }: { text: string }) {
  const parts: Array<{ key: string; marked: boolean; text: string }> = [];
  let rest = text;
  let n = 0;
  while (rest.length > 0) {
    const open = rest.indexOf(SNIPPET_OPEN);
    const close = open >= 0 ? rest.indexOf(SNIPPET_CLOSE, open) : -1;
    if (open < 0 || close < 0) {
      parts.push({ key: `p${n++}`, marked: false, text: rest.replaceAll(SNIPPET_OPEN, '').replaceAll(SNIPPET_CLOSE, '') });
      break;
    }
    if (open > 0) parts.push({ key: `p${n++}`, marked: false, text: rest.slice(0, open) });
    parts.push({ key: `p${n++}`, marked: true, text: rest.slice(open + SNIPPET_OPEN.length, close) });
    rest = rest.slice(close + SNIPPET_CLOSE.length);
  }
  return (
    <span>
      {parts.map((p) => (p.marked ? <mark key={p.key}>{p.text}</mark> : <span key={p.key}>{p.text}</span>))}
    </span>
  );
}
```

`apps/web/src/features/history/DebouncedInput.tsx`
```tsx
import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input.tsx';

export function DebouncedInput({
  value,
  onCommit,
  delayMs = 250,
  ...rest
}: { value: string; onCommit(v: string): void; delayMs?: number } & Omit<ComponentProps<'input'>, 'value' | 'onChange'>) {
  const [text, setText] = useState(value);
  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  }, [onCommit]);
  // external changes (saved view, clear filters) win unless they only differ by surrounding whitespace
  useEffect(() => {
    setText((cur) => (cur.trim() === value ? cur : value));
  }, [value]);
  useEffect(() => {
    if (text.trim() === value) return;
    const t = setTimeout(() => commit.current(text.trim()), delayMs);
    return () => clearTimeout(t);
  }, [text, value, delayMs]);
  return <Input value={text} onChange={(e) => setText(e.target.value)} {...rest} />;
}
```

`apps/web/src/features/history/HistoryFilters.tsx`
```tsx
import type { Availability, Source } from '@orc/core';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { DebouncedInput } from './DebouncedInput.tsx';
import type { HistorySearch } from './filters.ts';

type BoolKey = 'touchedProd' | 'hasSubagents' | 'pinned' | 'includeHidden' | 'includeAutomated';
const TOGGLES: Array<[BoolKey, string]> = [
  ['touchedProd', 'Touched prod'],
  ['hasSubagents', 'Has subagents'],
  ['pinned', 'Pinned'],
  ['includeHidden', 'Show hidden'],
  ['includeAutomated', 'Show automated'],
];
type TextKey = 'ticket' | 'pr' | 'model' | 'skill' | 'label';
const TEXTS: Array<[TextKey, string]> = [
  ['ticket', 'Ticket'],
  ['pr', 'PR'],
  ['model', 'Model'],
  ['skill', 'Skill'],
  ['label', 'Label'],
];

const orUndefined = (v: string) => (v === '' ? undefined : v);
const numberOrUndefined = (v: string) => (v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

export function HistoryFilters({
  search,
  onChange,
  onReset,
}: {
  search: HistorySearch;
  onChange(patch: Partial<HistorySearch>): void;
  onReset(): void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <DebouncedInput
        type="search"
        aria-label="Search sessions"
        placeholder="Search prompts, answers, commands, names…"
        value={search.q ?? ''}
        onCommit={(q) => onChange({ q: orUndefined(q) })}
        className="w-full"
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <NativeSelect
          aria-label="Source"
          value={search.source ?? ''}
          onChange={(e) => onChange({ source: orUndefined(e.target.value) as Source | undefined })}
        >
          <option value="">All sources</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </NativeSelect>
        <NativeSelect
          aria-label="Availability"
          value={search.availability ?? ''}
          onChange={(e) => onChange({ availability: orUndefined(e.target.value) as Availability | undefined })}
        >
          <option value="">Any availability</option>
          <option value="resumable">Resumable</option>
          <option value="archived">Archived</option>
          <option value="prompts-only">Prompts only</option>
        </NativeSelect>
        {TEXTS.map(([key, label]) => (
          <DebouncedInput
            key={key}
            aria-label={label}
            placeholder={label}
            value={search[key] ?? ''}
            onCommit={(v) => {
              const patch: Partial<HistorySearch> = {};
              patch[key] = orUndefined(v);
              onChange(patch);
            }}
            className="w-28"
          />
        ))}
        <Input
          type="date"
          aria-label="From"
          value={search.from ?? ''}
          onChange={(e) => onChange({ from: orUndefined(e.target.value) })}
        />
        <Input type="date" aria-label="To" value={search.to ?? ''} onChange={(e) => onChange({ to: orUndefined(e.target.value) })} />
        <Input
          type="number"
          min={0}
          step="0.01"
          aria-label="Min cost"
          placeholder="Min $"
          className="w-20"
          value={search.minCost ?? ''}
          onChange={(e) => onChange({ minCost: numberOrUndefined(e.target.value) })}
        />
        <Input
          type="number"
          min={0}
          step="0.01"
          aria-label="Max cost"
          placeholder="Max $"
          className="w-20"
          value={search.maxCost ?? ''}
          onChange={(e) => onChange({ maxCost: numberOrUndefined(e.target.value) })}
        />
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        {TOGGLES.map(([key, label]) => (
          <label key={key} className="flex items-center gap-1">
            <Checkbox
              checked={search[key] === true}
              onCheckedChange={(v) => {
                const patch: Partial<HistorySearch> = {};
                patch[key] = v || undefined;
                onChange(patch);
              }}
            />
            {label}
          </label>
        ))}
        <Button variant="ghost" size="sm" onClick={onReset}>
          Clear filters
        </Button>
      </div>
    </div>
  );
}
```

`apps/web/src/features/history/LabelEditor.tsx`
```tsx
import { HIDDEN_LABEL, type SessionListItem } from '@orc/api-contract';
import { type FormEvent, useState } from 'react';
import { useSetLabels } from '@/api/queries/sessions.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';

export function LabelEditor({ item }: { item: SessionListItem }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const setLabels = useSetLabels();
  const visible = item.labels.filter((l) => l !== HIDDEN_LABEL);

  if (!editing) {
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setValue(visible.join(', '));
          setEditing(true);
        }}
      >
        Labels
      </Button>
    );
  }

  const save = (e: FormEvent) => {
    e.preventDefault();
    const next = value
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);
    const keep = item.labels.includes(HIDDEN_LABEL) ? [HIDDEN_LABEL] : [];
    setLabels.mutate({ source: item.source, id: item.id, labels: [...new Set([...next, ...keep])] });
    setEditing(false);
  };

  return (
    <form onSubmit={save} className="flex items-center gap-1">
      <Input aria-label="Labels" value={value} onChange={(e) => setValue(e.target.value)} className="h-7 w-28" />
      <Button size="sm" type="submit">
        Save
      </Button>
    </form>
  );
}

export function HideToggle({ item }: { item: SessionListItem }) {
  const setLabels = useSetLabels();
  const hidden = item.labels.includes(HIDDEN_LABEL);
  const labels = hidden ? item.labels.filter((l) => l !== HIDDEN_LABEL) : [...item.labels, HIDDEN_LABEL];
  return (
    <Button size="sm" variant="ghost" onClick={() => setLabels.mutate({ source: item.source, id: item.id, labels })}>
      {hidden ? 'Unhide' : 'Hide'}
    </Button>
  );
}
```

`apps/web/src/features/history/SessionTable.tsx`
```tsx
import { HIDDEN_LABEL, type SessionListItem } from '@orc/api-contract';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef } from 'react';
import { usePinSession } from '@/api/queries/sessions.ts';
import { Badge, type BadgeVariant } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { formatCost, formatDateTime, formatDuration } from '@/lib/format.ts';
import { HideToggle, LabelEditor } from './LabelEditor.tsx';
import { Snippet } from './Snippet.tsx';

export const SESSION_ROW_HEIGHT = 64;
const GRID = 'grid grid-cols-[2.25rem_minmax(0,1fr)_8.5rem_4.5rem_4.5rem_13rem_11rem]';

const AVAILABILITY_VARIANT: Record<SessionListItem['availability'], BadgeVariant> = {
  resumable: 'success',
  archived: 'warning',
  'prompts-only': 'outline',
  remote: 'secondary',
};

function PinButton({ item }: { item: SessionListItem }) {
  const pin = usePinSession();
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={item.pinned ? 'Unpin' : 'Pin'}
      aria-pressed={item.pinned}
      onClick={() => pin.mutate({ source: item.source, id: item.id, pinned: !item.pinned })}
    >
      {item.pinned ? '★' : '☆'}
    </Button>
  );
}

function SessionCell({ item }: { item: SessionListItem }) {
  const title = item.name ?? item.firstPrompt ?? item.id;
  const secondary = item.recap ?? (item.lastPrompt && item.lastPrompt !== title ? item.lastPrompt : item.firstPrompt);
  return (
    <div className="flex min-w-0 flex-col py-1">
      <Link
        to="/sessions/$source/$id"
        params={{ source: item.source, id: item.id }}
        className="truncate font-medium hover:underline"
        title={title}
      >
        {title}
      </Link>
      <span className="truncate text-xs text-muted-foreground">
        {item.snippet ? <Snippet text={item.snippet} /> : (secondary ?? '')}
      </span>
    </div>
  );
}

function Chips({ item }: { item: SessionListItem }) {
  return (
    <div className="flex flex-wrap items-center gap-1 overflow-hidden">
      <Badge variant={AVAILABILITY_VARIANT[item.availability]}>{item.availability}</Badge>
      {item.source !== 'claude' ? <Badge variant="secondary">{item.source}</Badge> : null}
      {item.live ? <Badge variant="warning">{item.live.ownership === 'owned' ? 'open' : item.live.status}</Badge> : null}
      {item.tickets.slice(0, 2).map((t) => (
        <Badge key={t} variant="outline">
          {t}
        </Badge>
      ))}
      {item.prs.slice(0, 2).map((pr) => (
        <a key={pr.url} href={pr.url} target="_blank" rel="noreferrer" className="text-xs text-primary underline">
          #{pr.number}
        </a>
      ))}
      {item.labels
        .filter((l) => l !== HIDDEN_LABEL)
        .map((l) => (
          <Badge key={l} variant="secondary">
            {l}
          </Badge>
        ))}
    </div>
  );
}

function RowActions({ item }: { item: SessionListItem }) {
  return (
    <div className="flex items-center justify-end gap-1">
      <LabelEditor item={item} />
      <HideToggle item={item} />
    </div>
  );
}

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, SessionListItem>();
const columns = helper.columns([
  helper.display({ id: 'pin', header: () => <span className="sr-only">Pinned</span>, cell: (info) => <PinButton item={info.row.original} /> }),
  helper.accessor('name', { header: 'Session', cell: (info) => <SessionCell item={info.row.original} /> }),
  helper.accessor('lastActivityAt', { header: 'Last activity', cell: (info) => formatDateTime(info.getValue()) }),
  helper.accessor('durationMs', { header: 'Duration', cell: (info) => formatDuration(info.getValue()) }),
  helper.accessor('costUsd', { header: 'Cost', cell: (info) => formatCost(info.getValue()) }),
  helper.display({ id: 'chips', header: 'Links', cell: (info) => <Chips item={info.row.original} /> }),
  helper.display({ id: 'actions', header: () => <span className="sr-only">Actions</span>, cell: (info) => <RowActions item={info.row.original} /> }),
]);

export interface SessionTableProps {
  items: SessionListItem[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onEndReached(): void;
}

export function SessionTable({ items, loading, hasMore, loadingMore, onEndReached }: SessionTableProps) {
  const table = useTable({ features, columns, data: items, getRowId: (row) => row.pk });
  const rows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const endReached = useRef(onEndReached);
  useEffect(() => {
    endReached.current = onEndReached;
  }, [onEndReached]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => SESSION_ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => rows[index]?.id ?? index,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems.at(-1)?.index ?? -1;
  useEffect(() => {
    if (hasMore && !loadingMore && rows.length > 0 && lastIndex >= rows.length - 5) endReached.current();
  }, [hasMore, loadingMore, lastIndex, rows.length]);

  if (loading) return <Skeleton className="h-64" />;
  if (rows.length === 0) {
    return <p className="p-8 text-center text-sm text-muted-foreground">No sessions match these filters.</p>;
  }
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto rounded-md border">
      <table className="grid w-full text-sm">
        <thead className="sticky top-0 z-10 grid bg-background">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} className={`${GRID} border-b`}>
              {group.headers.map((header) => (
                <th key={header.id} className="px-2 py-1.5 text-left font-medium">
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody className="relative grid" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((vi) => {
            const row = rows[vi.index];
            if (!row) return null;
            return (
              <tr
                key={row.id}
                data-index={vi.index}
                className={`${GRID} absolute w-full items-center border-b`}
                style={{ transform: `translateY(${vi.start}px)`, height: SESSION_ROW_HEIGHT }}
              >
                {row.getAllCells().map((cell) => (
                  <td key={cell.id} className="min-w-0 px-2">
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {loadingMore ? <p className="p-2 text-center text-xs text-muted-foreground">Loading more…</p> : null}
    </div>
  );
}
```

`apps/web/src/features/history/SavedViews.tsx`
```tsx
import { type FormEvent, useState } from 'react';
import { useDeleteView, useSaveView, useSavedViews } from '@/api/queries/views.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { type HistorySearch, searchToViewQuery, viewQueryToSearch } from './filters.ts';

export function SavedViews({ search, onApply }: { search: HistorySearch; onApply(s: HistorySearch): void }) {
  const views = useSavedViews();
  const save = useSaveView();
  const remove = useDeleteView();
  const [name, setName] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    save.mutate({ name: name.trim(), query: searchToViewQuery(search) });
    setName('');
  };

  return (
    <section aria-label="Saved views" className="flex flex-wrap items-center gap-1">
      {(views.data ?? []).map((v) => (
        <span key={v.id} className="inline-flex items-center rounded-md border">
          <Button size="sm" variant="ghost" onClick={() => onApply(viewQueryToSearch(v.query))}>
            {v.name}
          </Button>
          <Button size="icon" variant="ghost" aria-label={`Delete view ${v.name}`} onClick={() => remove.mutate(v.id)}>
            ×
          </Button>
        </span>
      ))}
      <form onSubmit={submit} className="flex items-center gap-1">
        <Input aria-label="View name" placeholder="Save current filters as…" value={name} onChange={(e) => setName(e.target.value)} className="h-7 w-44" />
        <Button size="sm" type="submit" variant="outline" disabled={!name.trim()}>
          Save view
        </Button>
      </form>
    </section>
  );
}
```

`apps/web/src/features/history/HistoryPage.tsx`
```tsx
import type { SessionListItem } from '@orc/api-contract';
import { useCallback, useMemo } from 'react';
import { useSessions } from '@/api/queries/sessions.ts';
import { useProjectStore } from '@/stores/project.ts';
import { cleanSearch, type HistorySearch, toListFilters } from './filters.ts';
import { HistoryFilters } from './HistoryFilters.tsx';
import { SavedViews } from './SavedViews.tsx';
import { SessionTable } from './SessionTable.tsx';

const NO_ITEMS: SessionListItem[] = [];

export function HistoryPage({ search, onSearchChange }: { search: HistorySearch; onSearchChange(next: HistorySearch): void }) {
  const projectId = useProjectStore((s) => s.projectId);
  const filters = useMemo(() => toListFilters(search, projectId), [search, projectId]);
  const q = useSessions(filters);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? NO_ITEMS, [q.data]);
  const { fetchNextPage } = q;
  const loadMore = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">History</h1>
        <SavedViews search={search} onApply={(s) => onSearchChange(cleanSearch(s))} />
      </div>
      <HistoryFilters
        search={search}
        onChange={(patch) => onSearchChange(cleanSearch({ ...search, ...patch }))}
        onReset={() => onSearchChange({})}
      />
      {q.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {q.error.message}
        </p>
      ) : null}
      <SessionTable
        items={items}
        loading={q.isLoading}
        hasMore={q.hasNextPage}
        loadingMore={q.isFetchingNextPage}
        onEndReached={loadMore}
      />
    </div>
  );
}
```

`apps/web/src/routes/history.tsx` (replaces the Task 14 version)
```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { type HistorySearch, parseHistorySearch } from '@/features/history/filters.ts';
import { HistoryPage } from '@/features/history/HistoryPage.tsx';

export const Route = createFileRoute('/history')({
  validateSearch: (search: Record<string, unknown>): HistorySearch => parseHistorySearch(search),
  component: HistoryRoute,
});

function HistoryRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/history' });
  return <HistoryPage search={search} onSearchChange={(next) => void navigate({ search: next, replace: true })} />;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/web`
Expected: PASS (Snippet 2, HistoryPage 6, plus earlier suites). If the v9 column helper's `info.row.original` is typed differently in the installed version, check `node_modules/@tanstack/react-table/dist/index.d.ts` (`Row.original`) and adjust only the accessor, not the component contracts.

- [ ] **Step 5: Check the page in a browser against the fixtures**

Run the daemon on fixtures (Task 13, Step 7, with `ORC_DEV=1` and `ORC_PORT=4317`) and `pnpm --filter @orc/web dev`, open `http://localhost:5173/history`, and take a screenshot for the review note: Wakecap selected, 7 rows, search "weekend" leaves only "SAF-1787 SLA weekends".

- [ ] **Step 6: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/web
git commit -m "feat(web): add history page with FTS search, filters, saved views, pins and labels"
```

---

### Task 18: Terminal dock and resume / fork / adopt / pop-out (F4)

**Files:**
- Create: `apps/web/src/stores/terminals.ts`
- Create: `apps/web/src/api/pty-socket.ts`, `apps/web/src/api/pty-socket.test.ts`
- Create: `apps/web/src/api/queries/pty.ts`
- Create: `apps/web/src/features/terminal/TerminalView.tsx`, `TerminalDock.tsx`, `ResumeActions.tsx`
- Create: `apps/web/src/features/terminal/TerminalDock.test.tsx`, `apps/web/src/features/terminal/ResumeActions.test.tsx`
- Modify: `apps/web/src/features/shell/AppShell.tsx`, `apps/web/src/features/session-detail/SessionDetailPage.tsx`, `apps/web/src/features/history/SessionTable.tsx`

**Interfaces:**
- Consumes: `ApiClient.sessionsResume/ptyList/ptyKill`, `ApiRequestError`, `PtyClientMessage`, `ResumeRequest` (Task 5); `getToken`, `getApiClient` (Task 14); WS protocol from Task 13.
- Produces:
  ```ts
  // stores/terminals.ts (contracts §12 + setActive; persisted in sessionStorage "orc.terminals")
  export interface TerminalTab { ptyId: string; title: string }
  export interface TerminalState { tabs: TerminalTab[]; active: string | null; open(ptyId: string, title: string): void; close(ptyId: string): void; setActive(ptyId: string): void }
  export const useTerminalStore: UseBoundStore<StoreApi<TerminalState>>
  // api/pty-socket.ts
  export interface WebSocketLike { binaryType: string; readyState: number; onopen: ((ev: unknown) => void) | null; onmessage: ((ev: { data: unknown }) => void) | null; onclose: ((ev: unknown) => void) | null; send(data: string): void; close(): void }
  export type WebSocketCtor = new (url: string) => WebSocketLike;
  export type PtySocketStatus = 'connecting' | 'open' | 'closed';
  export interface PtySocketHandlers { onData(data: Uint8Array): void; onExit(code: number | null): void; onStatus?(s: PtySocketStatus): void; onReset?(): void }
  export interface PtySocket { send(msg: PtyClientMessage): void; close(): void }
  export function ptySocketUrl(ptyId: string, token: string, loc: { protocol: string; host: string }): string
  export function connectPty(ptyId: string, h: PtySocketHandlers, o?: { token?: string; WebSocketImpl?: WebSocketCtor; location?: { protocol: string; host: string }; maxDelayMs?: number }): PtySocket
  // api/queries/pty.ts
  export function usePtyList(): UseQueryResult<PtyInfo[]>                         // key ['pty'], polls every 5 s
  export function useKillPty(): UseMutationResult<{ ok: true }, Error, string>
  export function useResumeSession(): UseMutationResult<ResumeResponse, Error, { source: Source; id: string; body: ResumeRequest }>
  // features/terminal
  export function TerminalView(p: { ptyId: string; active: boolean }): JSX.Element
  export function TerminalDock(): JSX.Element | null
  export interface ResumeTarget { source: Source; id: string; availability: Availability; live: LiveState | null; title: string }
  export function ResumeActions(p: { target: ResumeTarget; compact?: boolean }): JSX.Element
  ```
  Behaviour: the reconnect backoff is 250 ms × 2ⁿ capped at 5 s; every (re)connection resets the terminal before the replayed scrollback, so reloads and reconnects show the same screen. Closing a tab only detaches; "Stop" kills the process after an inline confirmation (DELETE with `confirm: true`). Resume/Adopt/Fork open a tab; a 409 `session_live` with `ptyId` focuses the existing tab; with `pid` it explains the session is running elsewhere. Pop out opens Terminal.app/VS Code via the daemon, copies the command to the clipboard, and closes the embedded tab when the app owned it.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/api/pty-socket.test.ts`
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectPty, ptySocketUrl, type WebSocketLike } from './pty-socket.ts';

class FakeWS implements WebSocketLike {
  static instances: FakeWS[] = [];
  readonly url: string;
  binaryType = 'blob';
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.drop();
  }
  accept(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(data: unknown): void {
    this.onmessage?.({ data });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const bytes = (s: string) => new TextEncoder().encode(s).buffer;
const loc = { protocol: 'http:', host: '127.0.0.1:4317' };

describe('pty socket', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('builds the URL', () => {
    expect(ptySocketUrl('p 1', 't/k', loc)).toBe('ws://127.0.0.1:4317/pty/p%201?token=t%2Fk');
    expect(ptySocketUrl('p', 't', { protocol: 'https:', host: 'box.ts.net' })).toBe('wss://box.ts.net/pty/p?token=t');
  });

  it('streams bytes, resets before replay, sends only when open and stops after exit', () => {
    const events: string[] = [];
    const sock = connectPty(
      'p1',
      {
        onData: (d) => events.push(`data:${new TextDecoder().decode(d)}`),
        onExit: (code) => events.push(`exit:${code}`),
        onStatus: (s) => events.push(`status:${s}`),
        onReset: () => events.push('reset'),
      },
      { token: 'tok', WebSocketImpl: FakeWS, location: loc },
    );
    const ws = FakeWS.instances[0];
    if (!ws) throw new Error('no socket');
    expect(ws.binaryType).toBe('arraybuffer');
    sock.send({ t: 'in', d: 'early' });
    ws.accept();
    sock.send({ t: 'resize', cols: 80, rows: 24 });
    ws.message(bytes('scrollback'));
    ws.message(bytes('live'));
    ws.message('{"t":"exit","code":0}');
    ws.drop();
    vi.advanceTimersByTime(10_000);
    expect(ws.sent).toEqual(['{"t":"resize","cols":80,"rows":24}']);
    expect(events).toEqual([
      'status:connecting',
      'status:open',
      'reset',
      'data:scrollback',
      'data:live',
      'exit:0',
      'status:closed',
    ]);
    expect(FakeWS.instances).toHaveLength(1);
  });

  it('reconnects with backoff and replays after each reconnect', () => {
    const resets: number[] = [];
    connectPty('p1', { onData: () => undefined, onExit: () => undefined, onReset: () => resets.push(1) }, {
      WebSocketImpl: FakeWS,
      location: loc,
    });
    FakeWS.instances[0]?.drop();
    vi.advanceTimersByTime(249);
    expect(FakeWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWS.instances).toHaveLength(2);
    FakeWS.instances[1]?.drop();
    vi.advanceTimersByTime(500);
    expect(FakeWS.instances).toHaveLength(3);
    const third = FakeWS.instances[2];
    third?.accept();
    third?.message(bytes('again'));
    expect(resets).toEqual([1]);
    third?.drop();
    vi.advanceTimersByTime(250);
    expect(FakeWS.instances).toHaveLength(4);
  });

  it('stops reconnecting after close()', () => {
    const sock = connectPty('p1', { onData: () => undefined, onExit: () => undefined }, { WebSocketImpl: FakeWS, location: loc });
    sock.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeWS.instances).toHaveLength(1);
  });
});
```

`apps/web/src/features/terminal/TerminalDock.test.tsx`
```tsx
import type { PtyInfo } from '@orc/api-contract';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminals.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { TerminalDock } from './TerminalDock.tsx';

type Handlers = import('../../api/pty-socket.ts').PtySocketHandlers;

const mocks = vi.hoisted(() => ({
  sockets: [] as Array<{ ptyId: string; handlers: Handlers; sent: unknown[]; closed: boolean }>,
  writes: [] as string[],
  terminals: [] as Array<{ type(d: string): void }>,
}));

vi.mock('@/api/pty-socket.ts', () => ({
  connectPty: (ptyId: string, handlers: Handlers) => {
    const s = { ptyId, handlers, sent: [] as unknown[], closed: false };
    mocks.sockets.push(s);
    return {
      send: (m: unknown) => s.sent.push(m),
      close: () => {
        s.closed = true;
      },
    };
  },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    private handler: ((d: string) => void) | null = null;
    loadAddon = () => undefined;
    open = () => undefined;
    focus = () => undefined;
    dispose = () => undefined;
    reset = () => {
      mocks.writes.push('<reset>');
    };
    write = (d: string | Uint8Array) => {
      mocks.writes.push(typeof d === 'string' ? d : new TextDecoder().decode(d));
    };
    onData = (fn: (d: string) => void) => {
      this.handler = fn;
      mocks.terminals.push(this);
      return { dispose: () => undefined };
    };
    type(d: string): void {
      this.handler?.(d);
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = () => undefined; } }));

const pty = (id: string, exitedAt: string | null = null): PtyInfo => ({
  id,
  sessionPk: `claude:${id}`,
  command: 'claude',
  args: ['--resume', id],
  cwd: '/w',
  pid: 1,
  startedAt: 'now',
  exitedAt,
  exitCode: exitedAt ? 0 : null,
  cols: 120,
  rows: 36,
});

describe('TerminalDock', () => {
  beforeEach(() => {
    mocks.sockets.length = 0;
    mocks.writes.length = 0;
    mocks.terminals.length = 0;
    useTerminalStore.setState({ tabs: [], active: null });
  });

  it('renders nothing without tabs', () => {
    const { container } = renderWithProviders(<TerminalDock />);
    expect(container.querySelector('section')).toBeNull();
  });

  it('shows tabs, streams output, forwards input and resizes on open', async () => {
    useTerminalStore.getState().open('p1', 'Session A');
    useTerminalStore.getState().open('p2', 'Session B');
    const api = createFakeApi({ ptyList: vi.fn(async () => [pty('p1'), pty('p2')]) });
    renderWithProviders(<TerminalDock />, { api });

    expect((await screen.findByRole('tab', { name: 'Session B' })).getAttribute('aria-selected')).toBe('true');
    expect(mocks.sockets.map((s) => s.ptyId)).toEqual(['p1', 'p2']);
    const p2 = mocks.sockets[1];
    if (!p2) throw new Error('missing socket');
    act(() => {
      p2.handlers.onStatus?.('open');
      p2.handlers.onReset?.();
      p2.handlers.onData(new TextEncoder().encode('fake-claude --resume p2'));
    });
    expect(p2.sent).toContainEqual({ t: 'resize', cols: 100, rows: 30 });
    expect(mocks.writes).toEqual(['<reset>', 'fake-claude --resume p2']);
    act(() => mocks.terminals[1]?.type('ls\r'));
    expect(p2.sent).toContainEqual({ t: 'in', d: 'ls\r' });

    act(() => p2.handlers.onExit(0));
    expect(screen.getByText('Process exited (code 0)')).toBeTruthy();

    await userEvent.click(screen.getByRole('tab', { name: 'Session A' }));
    expect(useTerminalStore.getState().active).toBe('p1');
    await userEvent.click(screen.getByRole('button', { name: 'Close Session A' }));
    expect(useTerminalStore.getState().tabs.map((t) => t.ptyId)).toEqual(['p2']);
    expect(mocks.sockets[0]?.closed).toBe(true);
  });

  it('stops the active process only after confirmation', async () => {
    useTerminalStore.getState().open('p1', 'Session A');
    const api = createFakeApi({ ptyList: vi.fn(async () => [pty('p1')]) });
    renderWithProviders(<TerminalDock />, { api });
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(api.ptyKill).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm stop' }));
    await waitFor(() => expect(api.ptyKill).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(useTerminalStore.getState().tabs).toEqual([]));
  });

  it('drops tabs whose PTY no longer exists', async () => {
    useTerminalStore.getState().open('gone', 'Old');
    useTerminalStore.getState().open('p1', 'Session A');
    renderWithProviders(<TerminalDock />, { api: createFakeApi({ ptyList: vi.fn(async () => [pty('p1', 'later')]) }) });
    await waitFor(() => expect(useTerminalStore.getState().tabs.map((t) => t.ptyId)).toEqual(['p1']));
    expect(await screen.findByRole('tab', { name: 'Session A (exited)' })).toBeTruthy();
  });
});
```

`apps/web/src/features/terminal/ResumeActions.test.tsx`
```tsx
import { ApiRequestError } from '@orc/api-contract';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminals.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { ResumeActions, type ResumeTarget } from './ResumeActions.tsx';

const target: ResumeTarget = { source: 'claude', id: 's1', availability: 'resumable', live: null, title: 'Fix SLA' };
const live = (o: Partial<NonNullable<ResumeTarget['live']>>): NonNullable<ResumeTarget['live']> => ({
  pid: 41001,
  status: 'waiting',
  waitingFor: null,
  since: 'now',
  ownership: 'observed',
  ptyId: null,
  stage: null,
  currentTool: null,
  backgroundJobs: 0,
  runningSubagents: 0,
  contextFill: null,
  ...o,
});

describe('ResumeActions', () => {
  beforeEach(() => useTerminalStore.setState({ tabs: [], active: null }));

  it('resumes and forks into terminal tabs', async () => {
    const sessionsResume = vi
      .fn()
      .mockResolvedValueOnce({ ptyId: 'p1' })
      .mockResolvedValueOnce({ ptyId: 'p2' });
    renderWithProviders(<ResumeActions target={target} />, { api: createFakeApi({ sessionsResume }) });
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(useTerminalStore.getState().active).toBe('p1'));
    expect(sessionsResume).toHaveBeenCalledWith('claude', 's1', { mode: 'embedded', cols: 120, rows: 36 });
    await userEvent.click(screen.getByRole('button', { name: 'Fork' }));
    await waitFor(() => expect(useTerminalStore.getState().active).toBe('p2'));
    expect(sessionsResume).toHaveBeenLastCalledWith('claude', 's1', { mode: 'embedded', fork: true, cols: 120, rows: 36 });
    expect(useTerminalStore.getState().tabs).toEqual([
      { ptyId: 'p1', title: 'Fix SLA' },
      { ptyId: 'p2', title: 'Fork: Fix SLA' },
    ]);
  });

  it('focuses the existing tab when the app already owns the session', async () => {
    const sessionsResume = vi.fn(async () => {
      throw new ApiRequestError(409, 'session_live', 'already open', { ptyId: 'p9', ownership: 'owned' });
    });
    renderWithProviders(<ResumeActions target={target} />, { api: createFakeApi({ sessionsResume }) });
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(useTerminalStore.getState().active).toBe('p9'));
    expect(screen.getByRole('status').textContent).toContain('Already open in the app');
  });

  it('shows "Show terminal" for owned sessions and pops out with popOut', async () => {
    const user = userEvent.setup();
    useTerminalStore.getState().open('p5', 'Fix SLA');
    const sessionsResume = vi.fn(async () => ({ launched: 'external' as const, command: 'cd /w && claude --resume s1' }));
    const owned = { ...target, live: live({ ownership: 'owned', ptyId: 'p5', status: 'idle', pid: 1 }) };
    renderWithProviders(<ResumeActions target={owned} />, { api: createFakeApi({ sessionsResume }) });
    useTerminalStore.setState({ active: null });
    await user.click(screen.getByRole('button', { name: 'Show terminal' }));
    expect(useTerminalStore.getState().active).toBe('p5');
    await user.click(screen.getByRole('button', { name: 'Pop out' }));
    await waitFor(() => expect(sessionsResume).toHaveBeenCalledWith('claude', 's1', { mode: 'external', popOut: true }));
    await waitFor(() => expect(useTerminalStore.getState().tabs).toEqual([]));
    expect(await navigator.clipboard.readText()).toBe('cd /w && claude --resume s1');
    expect(screen.getByRole('status').textContent).toContain('cd /w && claude --resume s1');
  });

  it('guards sessions running elsewhere, offers adopt when ended, and disables prompts-only', () => {
    const { unmount } = renderWithProviders(<ResumeActions target={{ ...target, live: live({}) }} />);
    expect(screen.getByRole('button', { name: 'Resume' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Fork' })).toHaveProperty('disabled', false);
    expect(screen.getByText('Running in another terminal (pid 41001)')).toBeTruthy();
    unmount();

    const ended = renderWithProviders(<ResumeActions target={{ ...target, live: live({ status: 'ended' }) }} />);
    expect(screen.getByRole('button', { name: 'Adopt' })).toHaveProperty('disabled', false);
    ended.unmount();

    renderWithProviders(<ResumeActions target={{ ...target, availability: 'prompts-only' }} compact />);
    expect(screen.getByRole('button', { name: 'Resume' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull();
  });
});
```

Run: `pnpm vitest run apps/web/src/api apps/web/src/features/terminal`
Expected: FAIL, `Cannot find module './pty-socket.ts'` / `'./TerminalDock.tsx'` / `'./ResumeActions.tsx'`

- [ ] **Step 2: Implement the store, socket and query hooks**

`apps/web/src/stores/terminals.ts`
```ts
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export interface TerminalTab {
  ptyId: string;
  title: string;
}

export interface TerminalState {
  tabs: TerminalTab[];
  active: string | null;
  open(ptyId: string, title: string): void;
  close(ptyId: string): void;
  setActive(ptyId: string): void;
}

export const useTerminalStore = create<TerminalState>()(
  persist(
    (set) => ({
      tabs: [],
      active: null,
      open: (ptyId, title) =>
        set((s) => ({
          tabs: s.tabs.some((t) => t.ptyId === ptyId) ? s.tabs : [...s.tabs, { ptyId, title }],
          active: ptyId,
        })),
      close: (ptyId) =>
        set((s) => {
          const tabs = s.tabs.filter((t) => t.ptyId !== ptyId);
          return { tabs, active: s.active === ptyId ? (tabs.at(-1)?.ptyId ?? null) : s.active };
        }),
      setActive: (ptyId) => set({ active: ptyId }),
    }),
    // PTYs outlive a reload; sessionStorage keeps the tabs for this browser tab only.
    { name: 'orc.terminals', storage: createJSONStorage(() => sessionStorage) },
  ),
);
```

`apps/web/src/api/pty-socket.ts`
```ts
import type { PtyClientMessage } from '@orc/api-contract';

export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;
export type PtySocketStatus = 'connecting' | 'open' | 'closed';

export interface PtySocketHandlers {
  onData(data: Uint8Array): void;
  onExit(code: number | null): void;
  onStatus?(s: PtySocketStatus): void;
  onReset?(): void;
}

export interface PtySocket {
  send(msg: PtyClientMessage): void;
  close(): void;
}

const OPEN = 1;

export function ptySocketUrl(ptyId: string, token: string, loc: { protocol: string; host: string }): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}/pty/${encodeURIComponent(ptyId)}?token=${encodeURIComponent(token)}`;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export function connectPty(
  ptyId: string,
  h: PtySocketHandlers,
  o: { token?: string; WebSocketImpl?: WebSocketCtor; location?: { protocol: string; host: string }; maxDelayMs?: number } = {},
): PtySocket {
  const WS = o.WebSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketCtor);
  const loc = o.location ?? window.location;
  let ws: WebSocketLike | null = null;
  let stopped = false;
  let exited = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = (): void => {
    h.onStatus?.('connecting');
    const sock = new WS(ptySocketUrl(ptyId, o.token ?? '', loc));
    sock.binaryType = 'arraybuffer';
    ws = sock;
    let first = true;
    sock.onopen = () => {
      attempt = 0;
      h.onStatus?.('open');
    };
    sock.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const m = JSON.parse(ev.data) as { t?: string; code?: unknown };
          if (m.t === 'exit') {
            exited = true;
            h.onExit(typeof m.code === 'number' ? m.code : null);
          }
        } catch {
          // ignore malformed control frames
        }
        return;
      }
      const bytes = toBytes(ev.data);
      if (!bytes) return;
      if (first) {
        first = false;
        h.onReset?.();
      }
      h.onData(bytes);
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      h.onStatus?.('closed');
      if (stopped || exited) return;
      const delay = Math.min(250 * 2 ** attempt, o.maxDelayMs ?? 5000);
      attempt += 1;
      timer = setTimeout(open, delay);
    };
  };

  open();
  return {
    send(msg) {
      if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const current = ws;
      ws = null;
      current?.close();
    },
  };
}
```

In the reconnect test the third connection's first frame triggers `onReset` once; the first two connections never received data, so `resets` is `[1]`.

`apps/web/src/api/queries/pty.ts`
```ts
import type { ResumeRequest } from '@orc/api-contract';
import type { Source } from '@orc/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export function usePtyList() {
  return useQuery({ queryKey: ['pty'], queryFn: () => getApiClient().ptyList(), refetchInterval: 5000 });
}

export function useKillPty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ptyId: string) => getApiClient().ptyKill(ptyId),
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: ['pty'] });
      await qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export function useResumeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { source: Source; id: string; body: ResumeRequest }) =>
      getApiClient().sessionsResume(v.source, v.id, v.body),
    onSettled: async (_data, _err, v) => {
      await qc.invalidateQueries({ queryKey: ['session', v.source, v.id], exact: true });
      await qc.invalidateQueries({ queryKey: ['sessions'] });
      await qc.invalidateQueries({ queryKey: ['pty'] });
    },
  });
}
```

- [ ] **Step 3: Implement the terminal components**

`apps/web/src/features/terminal/TerminalView.tsx`
```tsx
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { getToken } from '@/api/client.ts';
import { connectPty, type PtySocket, type PtySocketStatus } from '@/api/pty-socket.ts';

export function TerminalView({ ptyId, active }: { ptyId: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sockRef = useRef<PtySocket | null>(null);
  const [status, setStatus] = useState<PtySocketStatus>('connecting');
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({ fontFamily: 'Menlo, Monaco, monospace', fontSize: 12, cursorBlink: true, scrollback: 5000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const sendSize = (): void => {
      try {
        fit.fit();
      } catch {
        return; // hidden or detached host
      }
      sock.send({ t: 'resize', cols: term.cols, rows: term.rows });
    };
    const sock = connectPty(
      ptyId,
      {
        onData: (d) => term.write(d),
        onExit: (code) => setExitCode(code),
        onReset: () => term.reset(),
        onStatus: (s) => {
          setStatus(s);
          if (s === 'open') sendSize();
        },
      },
      { token: getToken() },
    );
    sockRef.current = sock;
    const input = term.onData((d) => sock.send({ t: 'in', d }));
    const observer = new ResizeObserver(() => sendSize());
    observer.observe(host);
    return () => {
      observer.disconnect();
      input.dispose();
      sock.close();
      term.dispose();
      termRef.current = null;
      sockRef.current = null;
    };
  }, [ptyId]);

  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
      sockRef.current?.send({ t: 'resize', cols: term.cols, rows: term.rows });
    } catch {
      // not laid out yet; the ResizeObserver will retry
    }
    term.focus();
  }, [active]);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full p-1" data-testid={`terminal-${ptyId}`} />
      {exitCode !== undefined ? (
        <p className="absolute right-2 bottom-1 rounded bg-black/70 px-2 text-xs text-white">Process exited (code {exitCode ?? '?'})</p>
      ) : status !== 'open' ? (
        <p className="absolute right-2 bottom-1 rounded bg-black/70 px-2 text-xs text-white">
          {status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
        </p>
      ) : null}
    </div>
  );
}
```
(`sendSize` references `sock`, which is assigned before any status callback can fire because `connectPty` only reports `'open'` from the socket's asynchronous `onopen`; `'connecting'` is reported synchronously and does not call `sendSize`.)

`apps/web/src/features/terminal/TerminalDock.tsx`
```tsx
import { useEffect, useState } from 'react';
import { useKillPty, usePtyList } from '@/api/queries/pty.ts';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/components/ui/cn.ts';
import { useTerminalStore } from '@/stores/terminals.ts';
import { TerminalView } from './TerminalView.tsx';

export function TerminalDock() {
  const tabs = useTerminalStore((s) => s.tabs);
  const active = useTerminalStore((s) => s.active);
  const close = useTerminalStore((s) => s.close);
  const setActive = useTerminalStore((s) => s.setActive);
  const ptys = usePtyList();
  const kill = useKillPty();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!ptys.data) return;
    const ids = new Set(ptys.data.map((p) => p.id));
    for (const t of tabs) if (!ids.has(t.ptyId)) close(t.ptyId);
  }, [ptys.data, tabs, close]);

  useEffect(() => {
    setConfirming(false);
  }, [active]);

  if (tabs.length === 0) return null;
  const exited = new Set((ptys.data ?? []).filter((p) => p.exitedAt !== null).map((p) => p.id));

  return (
    <section aria-label="Terminals" className="flex h-full flex-col bg-[#0b0d10] text-white">
      <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1 text-xs">
        <div role="tablist" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {tabs.map((t) => {
            const title = exited.has(t.ptyId) ? `${t.title} (exited)` : t.title;
            return (
              <div key={t.ptyId} className={cn('flex items-center rounded', t.ptyId === active && 'bg-white/10')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={t.ptyId === active}
                  onClick={() => setActive(t.ptyId)}
                  className="max-w-56 truncate px-2 py-1"
                >
                  {title}
                </button>
                <button type="button" aria-label={`Close ${t.title}`} onClick={() => close(t.ptyId)} className="px-1 opacity-60 hover:opacity-100">
                  ×
                </button>
              </div>
            );
          })}
        </div>
        {active && !confirming ? (
          <Button size="sm" variant="ghost" className="text-white" onClick={() => setConfirming(true)}>
            Stop
          </Button>
        ) : null}
        {active && confirming ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => kill.mutate(active, { onSuccess: () => close(active) })}
            >
              Confirm stop
            </Button>
            <Button size="sm" variant="ghost" className="text-white" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1">
        {tabs.map((t) => (
          <div key={t.ptyId} className="absolute inset-0" hidden={t.ptyId !== active}>
            <TerminalView ptyId={t.ptyId} active={t.ptyId === active} />
          </div>
        ))}
      </div>
    </section>
  );
}
```

`apps/web/src/features/terminal/ResumeActions.tsx`
```tsx
import { ApiRequestError, type ResumeRequest } from '@orc/api-contract';
import type { Availability, LiveState, Source } from '@orc/core';
import { useState } from 'react';
import { useResumeSession } from '@/api/queries/pty.ts';
import { Button } from '@/components/ui/button.tsx';
import { useTerminalStore } from '@/stores/terminals.ts';

export interface ResumeTarget {
  source: Source;
  id: string;
  availability: Availability;
  live: LiveState | null;
  title: string;
}

const SIZE = { cols: 120, rows: 36 };

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // clipboard permission denied: the command is still shown in the status line
  }
}

export function ResumeActions({ target, compact = false }: { target: ResumeTarget; compact?: boolean }) {
  const resume = useResumeSession();
  const open = useTerminalStore((s) => s.open);
  const close = useTerminalStore((s) => s.close);
  const [message, setMessage] = useState<string | null>(null);

  const live = target.live;
  const ownedPty = live?.ownership === 'owned' ? live.ptyId : null;
  const endedElsewhere = live?.ownership === 'observed' && live.status === 'ended';
  const runningElsewhere = live?.ownership === 'observed' && live.status !== 'ended';
  const unavailable = target.availability !== 'resumable' || resume.isPending;
  const title = target.title.length > 40 ? `${target.title.slice(0, 39)}…` : target.title;

  async function run(body: ResumeRequest, prefix: string | null): Promise<void> {
    setMessage(null);
    try {
      const r = await resume.mutateAsync({ source: target.source, id: target.id, body });
      if ('ptyId' in r) {
        open(r.ptyId, prefix ? `${prefix}: ${title}` : title);
        return;
      }
      if (ownedPty) close(ownedPty);
      await copyToClipboard(r.command);
      setMessage(`Opened outside the app. Command copied: ${r.command}`);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'session_live') {
        const d = (err.details ?? {}) as { ptyId?: string; pid?: number | null };
        if (d.ptyId) {
          open(d.ptyId, title);
          setMessage('Already open in the app; switched to its terminal.');
          return;
        }
        setMessage(`Running in another terminal (pid ${d.pid ?? '?'}). Stop it there, then adopt it here.`);
        return;
      }
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1">
        {ownedPty ? (
          <Button size="sm" onClick={() => open(ownedPty, title)}>
            Show terminal
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={unavailable || runningElsewhere}
            title={target.availability !== 'resumable' ? `Not resumable (${target.availability})` : undefined}
            onClick={() => void run({ mode: 'embedded', ...SIZE }, null)}
          >
            {endedElsewhere ? 'Adopt' : 'Resume'}
          </Button>
        )}
        {compact ? null : (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={unavailable || target.source !== 'claude'}
              onClick={() => void run({ mode: 'embedded', fork: true, ...SIZE }, 'Fork')}
            >
              Fork
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={unavailable || runningElsewhere}
              onClick={() => void run(ownedPty ? { mode: 'external', popOut: true } : { mode: 'external' }, null)}
            >
              Pop out
            </Button>
          </>
        )}
      </div>
      {runningElsewhere && !compact ? (
        <p className="text-xs text-warning">Running in another terminal (pid {live?.pid ?? '?'})</p>
      ) : null}
      {message ? (
        <p role="status" className="max-w-md text-right text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Wire the dock and the actions into the app**

`apps/web/src/features/shell/AppShell.tsx` — replace the `<div className="flex min-w-0 flex-1 flex-col">…</div>` block with a resizable split, and add the imports:
```tsx
import { Group, Panel, Separator as PanelSeparator } from 'react-resizable-panels';
import { TerminalDock } from '@/features/terminal/TerminalDock.tsx';
import { useTerminalStore } from '@/stores/terminals.ts';
```
```tsx
        <Workspace>{children}</Workspace>
```
and add this component above `AppShell`:
```tsx
function Workspace({ children }: { children: ReactNode }) {
  const hasTabs = useTerminalStore((s) => s.tabs.length > 0);
  return (
    <Group orientation="vertical" className="min-w-0 flex-1">
      <Panel id="main" minSize="20">
        <main className="h-full overflow-auto">{children}</main>
      </Panel>
      {hasTabs ? (
        <>
          <PanelSeparator className="h-1 cursor-row-resize bg-border" />
          <Panel id="dock" defaultSize="40" minSize="10">
            <TerminalDock />
          </Panel>
        </>
      ) : null}
    </Group>
  );
}
```

`apps/web/src/features/session-detail/SessionDetailPage.tsx` — add the import and pass the actions to the header:
```tsx
import { ResumeActions } from '@/features/terminal/ResumeActions.tsx';
```
```tsx
      <SessionHeader
        session={session}
        actions={
          <ResumeActions
            target={{
              source: session.source,
              id: session.id,
              availability: session.availability,
              live: session.live,
              title: session.name ?? session.firstPrompt ?? session.id,
            }}
          />
        }
      />
```

`apps/web/src/features/history/SessionTable.tsx` — add the import and a compact Resume button at the start of `RowActions`:
```tsx
import { ResumeActions } from '@/features/terminal/ResumeActions.tsx';
```
```tsx
function RowActions({ item }: { item: SessionListItem }) {
  return (
    <div className="flex items-center justify-end gap-1">
      <ResumeActions
        compact
        target={{
          source: item.source,
          id: item.id,
          availability: item.availability,
          live: item.live,
          title: item.name ?? item.firstPrompt ?? item.id,
        }}
      />
      <LabelEditor item={item} />
      <HideToggle item={item} />
    </div>
  );
}
```

- [ ] **Step 5: Run the tests and build**

Run: `pnpm vitest run apps/web && pnpm --filter @orc/web build`
Expected: PASS (pty-socket 4, TerminalDock 4, ResumeActions 4, plus earlier suites); build succeeds.

- [ ] **Step 6: Manual check against a throwaway session (evidence required)**

1. `cd /tmp && mkdir -p orc-p1 && cd orc-p1 && claude -p "say hi" --output-format json` and note `session_id`.
2. Start `pnpm --filter @orc/daemon dev` (real `~/.claude`, read-only; `ORC_HOME` default) and `pnpm --filter @orc/web dev`, open `http://localhost:5173/history`, choose **All projects**, search "say hi", open the session, click **Resume**.
3. Record with a screenshot: the TUI renders in the dock; typing works; resizing the split reflows; reloading the page replays the screen; **Stop → Confirm stop** ends it; **Pop out** opens Terminal.app in `/tmp/orc-p1`.

- [ ] **Step 7: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps/web
git commit -m "feat(web): add xterm terminal dock with replay and resume, fork, adopt and pop-out actions"
```

---

### Task 19: Search performance check and Playwright end-to-end tests

**Files:**
- Create: `apps/daemon/vitest.perf.config.ts`, `apps/daemon/test/perf/seed.ts`, `apps/daemon/test/perf/search.perf.ts`
- Create: `apps/daemon/test/e2e-server.ts`
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/history.spec.ts`
- Modify: `apps/web/tsconfig.json` (typecheck e2e files), `.gitignore` (Playwright output)

**Interfaces:**
- Consumes: `createTestContext` (Task 11), `makeSession`/`makeEvent` (Task 7), `upsertSession`/`insertEvents` (Task 7), `createDaemon` (Task 13), `projectConfigFor` (Task 9), `makeTempHomes`/`writeClaudeSession`/`FAKE_CLAUDE` (Task 6), the whole web app (Tasks 14–18).
- Produces:
  ```ts
  // test/perf/seed.ts
  export function seedPerfDb(db: OrcDb, raw: Database.Database, o: { sessions: number; eventsPerSession: number }): void
  // scripts: pnpm --filter @orc/daemon perf ; pnpm --filter @orc/web e2e
  ```
  The perf check seeds 1 500 sessions × 60 events (90 000 events) and requires the p95 of 120 `sessions.list({ q })` calls to stay under 150 ms (docs/03 performance target, F3 "Done when"). The e2e suite starts the real daemon on a temp copy of the fixtures on port 4399 and drives the built web app in Chromium.

- [ ] **Step 1: Write the perf seed and check**

`apps/daemon/vitest.perf.config.ts`
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/perf/**/*.perf.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 180_000,
  },
});
```

`apps/daemon/test/perf/seed.ts`
```ts
import type Database from 'better-sqlite3';
import type { OrcDb } from '../../src/db/client.ts';
import { insertEvents } from '../../src/db/repos/events.ts';
import { upsertSession } from '../../src/db/repos/sessions.ts';
import { makeEvent, makeSession } from '../factories.ts';

const TOOLS = ['build', 'lint', 'gateway', 'migration', 'worker', 'report', 'export', 'tenant'] as const;
const TOPICS = [
  'notification service retries',
  'SLA deadline weekend rule',
  'kubectl rollout restart for api',
  'refactor repository layer',
  'flaky vitest suite',
] as const;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Deterministic synthetic history: 3 000-word vocabulary, one "topic" session in twenty, a ticket in one in seven. */
export function seedPerfDb(db: OrcDb, raw: Database.Database, o: { sessions: number; eventsPerSession: number }): void {
  const rand = rng(42);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const sentence = (n: number) => Array.from({ length: n }, () => `word${Math.floor(rand() * 3000)}`).join(' ');
  raw.transaction(() => {
    for (let i = 0; i < o.sessions; i++) {
      const id = `perf-${i}`;
      const topic = i % 20 === 0 ? pick(TOPICS) : sentence(3);
      const ticket = i % 7 === 0 ? `SAF-${1000 + i}` : '';
      const day = String(1 + (i % 28)).padStart(2, '0');
      const hour = String(8 + (i % 12)).padStart(2, '0');
      upsertSession(
        db,
        makeSession({
          id,
          name: `${topic} ${i}`,
          firstPrompt: `please look at ${topic} ${ticket}`.trim(),
          startedAt: `2026-08-${day}T08:00:00.000Z`,
          lastActivityAt: `2026-08-${day}T${hour}:00:00.000Z`,
          tickets: ticket ? [ticket] : [],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: Math.round(rand() * 2000) / 100 },
        }),
      );
      const events = Array.from({ length: o.eventsPerSession }, (_, k) => {
        const kind = k % 4 === 0 ? 'prompt' : k % 4 === 1 ? 'assistant_text' : k % 4 === 2 ? 'tool_call' : 'tool_result';
        const text = k === 0 ? `please look at ${topic} ${ticket} ${sentence(10)}` : `${sentence(12)} ${sentence(20)}`;
        return makeEvent({
          seq: k + 1,
          sessionId: id,
          turn: Math.floor(k / 4) + 1,
          kind,
          text: kind === 'tool_call' ? null : text,
          tool: kind === 'tool_call' ? 'Bash' : null,
          input: kind === 'tool_call' ? { command: `pnpm ${pick(TOOLS)} --filter ${pick(TOOLS)}` } : null,
        });
      });
      insertEvents(db, `claude:${id}`, events);
    }
  })();
}
```

`apps/daemon/test/perf/search.perf.ts`
```ts
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../helpers.ts';
import { seedPerfDb } from './seed.ts';

const QUERIES = ['notification', 'SAF-1', 'kubectl rollout', 'weekend deadline', 'word2999', 'pnpm gateway'];

describe('history search performance (F3: < 150 ms over ~1.5k sessions)', () => {
  it('keeps the p95 of sessions.list({ q }) under 150 ms', () => {
    const ctx = createTestContext();
    try {
      const t0 = performance.now();
      seedPerfDb(ctx.db, ctx.raw, { sessions: 1500, eventsPerSession: 60 });
      ctx.raw.pragma('optimize');
      console.log(`seeded 1500 sessions / 90000 events in ${Math.round(performance.now() - t0)} ms`);

      for (const q of QUERIES) ctx.sessions.list({ q, limit: 50 });
      const timings: number[] = [];
      for (let run = 0; run < 20; run++) {
        for (const q of QUERIES) {
          const start = performance.now();
          const res = ctx.sessions.list({ q, limit: 50, projectId: run % 2 === 0 ? undefined : 'wakecap' });
          timings.push(performance.now() - start);
          expect(res.items.length).toBeGreaterThan(0);
        }
      }
      timings.sort((a, b) => a - b);
      const p50 = timings[Math.floor(timings.length * 0.5)] ?? Number.POSITIVE_INFINITY;
      const p95 = timings[Math.floor(timings.length * 0.95)] ?? Number.POSITIVE_INFINITY;
      console.log(`search n=${timings.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${timings.at(-1)?.toFixed(1)}ms`);
      expect(p95).toBeLessThan(150);
    } finally {
      ctx.dispose();
    }
  });
});
```

- [ ] **Step 2: Run the perf check**

Run: `pnpm --filter @orc/daemon perf`
Expected: PASS, with a log line like `search n=120 p50=…ms p95=…ms` where p95 < 150. Paste the line into the review note. If p95 fails, profile with `EXPLAIN QUERY PLAN` on the two statements in `searchEventSessions`/`querySessions`, fix the query or index (not the threshold), and re-run.

- [ ] **Step 3: Write the e2e server**

`apps/daemon/test/e2e-server.ts`
```ts
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { saveConfig } from '../src/config.ts';
import { createDaemon } from '../src/main.ts';
import { projectConfigFor } from '../src/services/projects.ts';
import { FAKE_CLAUDE, makeTempHomes, writeClaudeSession } from './homes.ts';

const port = Number(process.env.ORC_E2E_PORT ?? 4399);
const homes = makeTempHomes();
const work = join(homes.root, 'work', 'Wakecap');
mkdirSync(work, { recursive: true });

const wakecap = projectConfigFor({ id: 'wakecap', name: 'Wakecap', pathPrefix: '/Users/test/Wakecap' });
saveConfig(
  homes.paths,
  OrcConfig.parse({
    port,
    resumeProfile: { claudeCommand: FAKE_CLAUDE, codexCommand: FAKE_CLAUDE },
    projects: [{ ...wakecap, pathPrefixes: ['/Users/test/Wakecap', work] }],
  }),
);
writeClaudeSession(homes, {
  sessionId: 'e2e-resume',
  cwd: join(work, 'e2e'),
  prompt: 'e2e resumable session',
  timestamp: '2026-09-10T08:00:00.000Z',
});

const daemon = await createDaemon({ paths: homes.paths, launchExternal: async () => undefined });
const running = await daemon.start({ port, watch: false });
console.log(`e2e daemon ready on http://127.0.0.1:${running.port}`);

const stop = () => {
  running
    .close()
    .catch(() => undefined)
    .finally(() => {
      homes.cleanup();
      process.exit(0);
    });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
```

- [ ] **Step 4: Write the Playwright config and specs**

`apps/web/playwright.config.ts`
```ts
import { defineConfig, devices } from '@playwright/test';

const port = 4399;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // builds the web app (served by the daemon), then boots the daemon on a temp copy of fixtures/
    command: 'pnpm build && pnpm --filter @orc/daemon exec tsx test/e2e-server.ts',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { ORC_E2E_PORT: String(port) },
  },
});
```
(Playwright treats the `401` from `/api/health` without a token as "server is up".)

`apps/web/e2e/history.spec.ts`
```ts
import { expect, test } from '@playwright/test';

test('finds sessions by keyword, shows prompts-only history and opens the detail view', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/history/);
  await expect(page.getByRole('combobox', { name: 'Project' })).toHaveValue('wakecap');
  await expect(page.getByRole('link', { name: 'Notification service test check' })).toBeVisible();

  const oldRow = page.locator('tr', { hasText: 'old session from december' });
  await expect(oldRow.getByText('prompts-only')).toBeVisible();
  await expect(oldRow.getByRole('button', { name: 'Resume' })).toBeDisabled();

  const search = page.getByRole('searchbox', { name: 'Search sessions' });
  await search.fill('weekends');
  await expect(page.getByRole('link', { name: 'SAF-1787 SLA weekends' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Notification service test check' })).toHaveCount(0);
  await expect(page).toHaveURL(/q=weekends/);

  await search.fill('');
  await page.getByRole('link', { name: 'Notification service test check' }).click();
  await expect(page).toHaveURL(/\/sessions\/claude\/s-basic$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Notification service test check' })).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Timeline' });
  await expect(timeline.getByText('check the notification service tests')).toBeVisible();
  await expect(timeline.getByText('Bash ×1')).toBeVisible();
  await expect(timeline.getByText('Recap: Ran tests (18 passed) and edited a.ts.')).toBeVisible();
});

test('resumes into an embedded terminal in the original cwd and replays after reload', async ({ page }) => {
  await page.goto('/history?q=e2e');
  await page.getByRole('link', { name: 'e2e resumable session' }).click();
  await page.getByRole('button', { name: 'Resume' }).click();

  const terminal = page.locator('.xterm-rows');
  await expect(terminal).toContainText('fake-claude --dangerously-skip-permissions --resume e2e-resume');
  await expect(terminal).toContainText('/work/Wakecap/e2e');
  await terminal.click();
  await page.keyboard.type('hello-e2e');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('hello-e2e');

  await page.reload();
  await expect(page.locator('.xterm-rows')).toContainText('hello-e2e');

  await page.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('button', { name: 'Confirm stop' }).click();
  await expect(page.getByRole('region', { name: 'Terminals' })).toHaveCount(0);
});

test('the API refuses requests without the token', async ({ request }) => {
  expect((await request.get('/api/sessions')).status()).toBe(401);
  expect((await request.get('/api/pty')).status()).toBe(401);
});
```

`apps/web/tsconfig.json` — set `"include": ["src", "e2e", "playwright.config.ts"]`.

`.gitignore` — append:
```
apps/web/test-results/
apps/web/playwright-report/
```

- [ ] **Step 5: Run the e2e suite**

Run: `pnpm --filter @orc/web exec playwright install chromium && pnpm --filter @orc/web e2e`
Expected: `3 passed`. On failure, open the trace with `pnpm --filter @orc/web exec playwright show-trace test-results/**/trace.zip` and attach the relevant screenshot to the review note.

- [ ] **Step 6: Gate and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`

```bash
git add apps .gitignore
git commit -m "test(repo): add 1.5k-session search perf check and Playwright e2e on fixtures"
```

---

### Task 20: Phase 1 exit check

**Files:**
- Modify: `plan/00-contracts.md` (merge this phase's "Contract additions"), `plan/README.md` (status table)
- Create: `plan/reviews/phase-1-exit.md` (evidence)

**Interfaces:**
- Consumes: everything above.
- Produces: M1 sign-off and the merged contract.

- [ ] **Step 1: Run the full automated gate**

Run:
```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm check:fixtures
pnpm --filter @orc/daemon perf
pnpm --filter @orc/web e2e
pnpm --filter @orc/web build && pnpm --filter @orc/daemon build
```
Expected: all green; the perf line shows p95 < 150 ms; Playwright `3 passed`; `apps/daemon/dist/main.js` and `apps/daemon/dist/migrations/` exist.

- [ ] **Step 2: Read-only audit of the daemon**

Run:
```bash
grep -rnE "writeFile|appendFile|mkdirSync|rmSync|unlink|renameSync|chmodSync|createWriteStream" apps/daemon/src --include=*.ts | grep -v '\.test\.ts'
grep -rn "\.key" apps/daemon/src --include=*.ts | grep -v '\.test\.ts'
grep -rn "messagingSocketPath" apps packages --include=*.ts | grep -v '\.test\.ts'
```
Expected:
- write calls only in `config.ts` (config/token under `ORC_HOME`), `db/client.ts` (DB dir/file under `ORC_HOME`), `context.ts` (`ORC_HOME` dir) — nothing that takes `claudeHome`/`codexHome`;
- `.key` only in the exclusion checks in `indexer/file-kinds.ts`, `indexer/indexer.ts` and the `^\d+\.json$` comment in `live/liveness.ts`;
- no `messagingSocketPath` hits.
The indexer test "is idempotent and never writes to the tool homes" is the executable proof.

- [ ] **Step 3: Manual check against the real `~/.claude` (read-only)**

```bash
export ORC_HOME=$(mktemp -d)
pnpm --filter @orc/daemon build
ORC_PORT=4317 node apps/daemon/dist/main.js &
sleep 60
grep '"initial index complete"' "$ORC_HOME/logs/daemon.log" | tail -1
TOKEN=$(cat "$ORC_HOME/token")
for q in conductor SAF-1787 backmerge "notification" "weekend"; do
  curl -s -o /dev/null -w "$q %{time_total}s\n" -H "x-orc-token: $TOKEN" "http://127.0.0.1:4317/api/sessions?q=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$q")"
done
curl -s -H "x-orc-token: $TOKEN" 'http://127.0.0.1:4317/api/sessions?availability=prompts-only&limit=3' | head -c 300; echo
curl -s -H "x-orc-token: $TOKEN" http://127.0.0.1:4317/api/projects | head -c 400; echo
kill %1
```
Record in `plan/reviews/phase-1-exit.md`: the index stats line (`files`, `sessions`, `ms` — must be < 60 000), each query's `time_total` (each < 0.15 s), a prompts-only sample, and the project list (Wakecap first, others auto-detected). Compare the session count with `plan/spikes/S1.md`.

Then open `http://127.0.0.1:4317/`, search for a session from the last 30 days, open it, and click **Resume** on a finished session (it must start in that session's original directory: check the prompt's cwd in the terminal), then **Stop**. Take screenshots of the History list, the Session Detail and the terminal dock.

- [ ] **Step 4: Check the M1 exit criteria**

| M1 criterion (docs/05-roadmap.md) | Evidence |
|---|---|
| Any session from the last 30 days is found by keyword in under 150 ms | `pnpm --filter @orc/daemon perf` p95 line; real-data `time_total` values; e2e test 1 |
| One click resumes it in the correct cwd | e2e test 2 (`/work/Wakecap/e2e` shown in the PTY); `sessions.test.ts` resume test (`cwd=` realpath); manual screenshot |
| Sessions that only exist in prompt history appear as `prompts-only` | e2e test 1 (`old session from december`); `indexer.test.ts`; real-data prompts-only sample |
| Daemon skeleton: Hono, SQLite/Drizzle, indexer, file offsets, token auth | `app.test.ts`, `server.test.ts`, `indexer.test.ts`, `client.test.ts` |
| Collectors: Claude transcripts + history.jsonl, Codex rollouts | core aggregate tests; `indexer.test.ts` (10 fixture sessions, automated Codex hidden) |
| F13 project selector, auto-built, default Wakecap | `ProjectSelector.test.tsx`, `projects.test.ts`, e2e (`wakecap` selected) |
| F3 history list, filters, FTS, saved views, pins, labels | `HistoryPage.test.tsx`, `repos.test.ts`, `sessions.test.ts` |
| F2 basic Session Detail (header + timeline) | `SessionDetailPage.test.tsx`, `timeline-model.test.ts`, e2e test 1 |
| F4 resume, fork, adopt, pop-out into the embedded terminal | `sessions.test.ts`, `ResumeActions.test.tsx`, `TerminalDock.test.tsx`, `server.test.ts`, e2e test 2, Task 18 manual check |
| Security: loopback bind, token, Origin/Host checks, redaction, read-only | `auth.test.ts`, `app.test.ts`, `server.test.ts`, Step 2 audit |

- [ ] **Step 5: Merge the contract additions and update the status**

- Copy every item from this plan's "Contract additions" section into the matching sections of `plan/00-contracts.md` (§3 paths/env, §4 note on `tool` for system events, §5 table shapes, §6 routes/params/WS frames and `session.indexed`, §7 `remove`/`disposeAll`, §11 `DaemonContext` P1 fields, `ProjectServiceImpl`, `ProjectUpdate`, `UserMetaService`, `ExternalLauncher`, `Indexer`, `buildContext`, `createDaemon`, §12 `setActive`, UI layer file list, `connectPty`). Also add `GET /api/projects/:id → ProjectConfig` (Task 15) under the P1 routes.
- In `plan/README.md`, set Phase 1 status to `☑ done (<date>)`.

- [ ] **Step 6: Commit and merge**

```bash
git add plan
git commit -m "docs(plan): record phase 1 exit evidence and merge contract additions"
git checkout main && git merge --no-ff phase/1-history-search-resume -m "merge: phase 1 history, search and resume"
```
