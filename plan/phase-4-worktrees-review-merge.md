# Phase 4 — Worktrees, Review & Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Symbol ownership:** before creating any exported symbol, check `00-contracts.md` §13. Where two phases touch the same symbol, the owning phase creates the file and later phases modify it instead of redefining.

**Goal:** Deliver milestone M4: take a ticket to a worktree, run an agent in it, review its diff with inline comments and per-turn checkpoints, then commit, push, open a PR, merge it and archive the worktree automatically, without leaving the app.

**Architecture:** The daemon gets four services, `WorktreeService`, `CheckpointService`, `ShipService` and `GithubConnector`, plus a `DiffService` and a `ReviewService`. They sit on a thin `git()`/`gh()` execa layer that refuses force pushes and hard resets. Pure parsing (worktree porcelain, branch names, unified diffs, hunk selection, review prompts) lives in `@orc/core/src/git/`. The GitHub connector polls `gh` every 90 s and emits `pr.changed` on the bus. Inbox rules and the worktree auto-archiver react to that event. Every write goes through `audited()` and every route that writes needs `confirm: true`. The web app gets a `/worktrees` page and a `/review/$source/$id` page built on `@git-diff-view/react`.

**Tech Stack:** Node 22, execa 10, git ≥ 2.40 (`git worktree`, `git restore`, `git commit-tree`), GitHub CLI `gh` ≥ 2.50, Hono 4, Drizzle + better-sqlite3, zod 4, React 19, TanStack Query/Router, `@git-diff-view/react` ^0.1.7, Vitest 5, Playwright.

**Spec:** `docs/02-features.md` (F17, F18, F11 GitHub row, F4 "require plan approval", F15 PR items), `docs/03-architecture-and-stack.md` (flow 4 session control model, flow 6 worktrees/checkpoints/shipping, Security & privacy), `docs/01-vision-and-insights.md` (P11, worktree evidence), `docs/05-roadmap.md` (M4), `docs/06-landscape-and-inspiration.md` (Conductor, Nimbalyst rows), `plan/00-contracts.md` (§3, §4, §5, §6, §7, §9, §11).

## Global Constraints
- Node `>=22.12 <23`; pnpm `10.18.3`; TypeScript `~6.0.3` strict with `noUncheckedIndexedAccess`; Vitest `^5.0.1`; Biome `^2.5.14`; execa `^10.0.1`; `@git-diff-view/react` `^0.1.7`.
- Daemon binds to `127.0.0.1`; every `/api/*` request needs `x-orc-token` (already enforced by the Phase 1 app).
- **Every git or PR write** (worktree add/remove, script run, sync, checkpoint, rewind, revert, commit, push, PR create, PR merge, plan approve/reject, review send) needs `{"confirm": true}` at the route (otherwise `409 confirmation_required` with `details.summary`) **and** is wrapped in `audited()` inside the service.
- **Never force push.** No code path passes `--force`, `-f`, `--force-with-lease` or `+refspec` to `git push`. No `git reset --hard`, no `git clean`, no `git worktree remove --force`, no `git checkout -- .`.
- **Archive refuses dirty worktrees** (`409 dirty_worktree`). Worktrees the app did not create (`createdByApp = false`) are never archived automatically and need `confirmExternal: true` in addition to `confirm: true`.
- **Checkpoints never move HEAD** and never touch the real index or the stash. Tests prove it.
- **Input only to owned sessions** (`LiveState.ownership === 'owned'` and `ptyId != null`); otherwise the review prompt is returned as text (`sent: false`).
- Read-only toward `~/.claude`: from `~/.claude.json` read **only** the `githubRepoPaths` key and discard the rest in the same function.
- Tests use **real git in temp repos** (`makeTempRepo()`), a **fake `gh`** in `apps/daemon/test/bin/gh`, and never touch a real repository or the real `gh` account. `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` point to `/dev/null` in tests.
- Transcript text shown in the review page (recap, plan text) goes through `redact()`.
- Commits: Conventional Commits with scope; `pnpm lint && pnpm typecheck && pnpm test` green before each commit. Branch `phase/4-worktrees-review-merge`.

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

These are merged into `plan/00-contracts.md` in Task 22.

### §2 layout
```
packages/core/src/git/            # pure: worktree-porcelain.ts, branch.ts, diff-parse.ts, hunk-select.ts, review-prompt.ts, status-porcelain.ts
apps/daemon/src/services/git/     # exec.ts (git/gh wrappers + force guard)
apps/daemon/src/services/diff/    # diff.ts
apps/daemon/src/services/review/  # review.ts, plan-approval.ts, plan-keys.ts
apps/daemon/src/services/worktree/# sources.ts, discover.ts, worktree-read.ts, worktree-write.ts, worktree-sync.ts, glob.ts, worktree.ts, auto-archive.ts
apps/daemon/src/services/launch/  # + plan-mode.ts, prepare.ts (P4)
apps/daemon/src/http/routes/      # + git-guard.ts, worktrees.ts, github.ts, review.ts, ship.ts, plan.ts (P4)
apps/web/src/features/worktrees/  apps/web/src/features/review/  apps/web/src/features/git/
```

### §3 config (added to `OrcConfig`)
```ts
github: z.object({
  enabled: z.boolean().default(true),
  pollSeconds: z.number().int().min(30).default(90),
  ticketUrlTemplate: z.string().default('https://linear.app/wakecap/issue/{ticket}'),   // used in PR bodies
  protectedBranches: z.array(z.string()).default(['main', 'master', 'develop', 'staging', 'testing', 'production']),
}).default({}),
worktrees: z.object({
  autoArchiveOnMerge: z.boolean().default(true),
  scratchpadRoots: z.array(z.string()).default(['/private/tmp']),   // scans <root>/claude-*/… up to depth 6
  scanSiblings: z.boolean().default(true),
  implementTicketMode: z.enum(['precreate', 'conductor']).default('conductor'),
  checkpointsPerSession: z.number().int().positive().default(200),
}).default({}),
```

### §4 domain types (added to `packages/core/src/types/work.ts`)
```ts
export type WorktreeOrigin = 'app' | 'config' | 'session-cwd' | 'claude-json' | 'worktree-dir' | 'sibling' | 'scratchpad';
export interface WorktreeView extends Worktree { head: string | null; isMain: boolean; origin: WorktreeOrigin; sessionPks: string[]; projectId: string | null; prStatus: PrStatus | null; updatedAt: string }
export interface PrStatus { pr: PrRef; state: 'open' | 'closed' | 'merged'; title: string; checks: 'pending' | 'success' | 'failure' | 'none'; review: 'approved' | 'changes_requested' | 'review_required' | 'none'; updatedAt: string; headRef: string | null; failedChecks: string[] }
export interface DiffHunk { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
export interface DiffFileEntry { path: string; oldPath: string | null; status: 'added' | 'modified' | 'deleted' | 'renamed' | 'binary'; additions: number; deletions: number; patch: string; hunks: DiffHunk[] }
export interface DiffResult { cwd: string; from: string; to: string; files: DiffFileEntry[]; additions: number; deletions: number }
export interface ReviewComment { file: string; line: number; side: 'old' | 'new'; body: string }
export interface ReviewSummary { sessionPk: string; cwd: string; worktree: WorktreeView | null; files: Array<{ path: string; additions: number; deletions: number }>; additions: number; deletions: number; lastTest: TestResult | null; recap: string | null; pr: PrStatus | null; owned: boolean; checkpoints: CheckpointRecord[] }
export interface CheckpointRecord extends Checkpoint { kind: 'turn' | 'safety' | 'manual' }
```
`PrStatus` moves from the connector file into core types (same shape as §11 plus `headRef` and `failedChecks`); `connectors/github/github.ts` re-exports it.

### §4 audit action names (added)
`worktree.script`, `worktree.open`, `worktree.prune`, `git.revert`, `review.send`, `plan.approve`, `plan.reject`, `ship.backmerge`.

### §5 tables (Phase 4)
| Table | Key | Columns |
|---|---|---|
| `worktrees` | `path` | `repo, branch, base, ticket, dirty, pr_url, state, created_by_app, head, is_main, origin, session_pks_json, project_id, created_at, updated_at, archived_at` |
| `checkpoints` | `id` | `session_pk, worktree_path, turn, ref, commit, kind, created_at`; unique `ref`. `Checkpoint.sessionId` is the source-native id; refs are `refs/orchestrator/checkpoints/<sessionId>/<turn>` for `turn`, `…/<turn>-safety-<epochMs>-<rand8>` and `…/<turn>-manual-<epochMs>-<rand8>` for the other kinds |
| `pr_cache` | `key` = `${repo}#${number}` | `repo, number, url, state, title, checks, review, head_ref, failed_checks_json, updated_at, fetched_at` |

### §6 routes (Phase 4)
```
P4  GET    /api/worktrees?projectId&state&repo          → WorktreeView[]
P4  POST   /api/worktrees/discover                      → WorktreeView[]
P4  GET    /api/worktrees/one?path                       → WorktreeView
P4  POST   /api/worktrees                               body CreateWorktreeBody → { worktree: WorktreeView; setupPtyId: string | null; launch: { ptyId: string; sessionId: string | null } | null } (confirm)
P4  POST   /api/worktrees/script                        body { path, which, confirm } → { ptyId }            (confirm)
P4  POST   /api/worktrees/open                          body { path, target } → { ok: true }
P4  GET    /api/worktrees/sync-preview?path             → SyncPreview
P4  POST   /api/worktrees/sync                          body { path, confirm } → { files }                   (confirm)
P4  POST   /api/worktrees/archive                       body { path, confirm, confirmExternal? } → { ok: true } (confirm)
P4  GET    /api/diff?cwd&from&to                        → DiffResult      (from default = merge-base with base; to default = 'WORKTREE')
P4  POST   /api/diff/revert                             body { cwd, file, hunkIndex?, from?, confirm } → { reverted: string } (confirm)
P4  GET    /api/checkpoints?sessionPk                   → CheckpointRecord[]
P4  GET    /api/checkpoints/:id/diff                    → DiffResult      (checkpoint vs previous checkpoint of the session)
P4  POST   /api/checkpoints                             body { sessionPk, confirm } → CheckpointRecord       (confirm)
P4  POST   /api/checkpoints/:id/rewind                  body { confirm } → { safety: CheckpointRecord }      (confirm)
P4  GET    /api/review/:source/:id                      → ReviewSummary
P4  POST   /api/review/:source/:id/comments             body { comments: ReviewComment[], deliver: 'session'|'text', confirm? } → { sent: boolean; text: string }
P4  GET    /api/ship/suggest?cwd&sessionPk              → ShipSuggestion
P4  POST   /api/ship/commit                             body { cwd, message, confirm } → { sha }             (confirm)
P4  POST   /api/ship/push                               body { cwd, confirm } → { ok: true }                 (confirm)
P4  POST   /api/ship/pr                                 body { cwd, title, body, base, draft, confirm } → PrRef (confirm)
P4  POST   /api/ship/merge                              body { pr, method, confirm } → { ok: true }          (confirm)
P4  POST   /api/ship/backmerge                          body { cwd, projectId, ticket?, confirm } → { ptyId } (confirm)
P4  GET    /api/github/status                           → { status: 'ok'|'unauthenticated'|'error'|'disabled' }
P4  GET    /api/github/pr?repo&number                   → PrStatus
P4  GET    /api/github/prs/mine                         → PrStatus[]
P4  POST   /api/sessions/:source/:id/plan/approve       body { confirm } → { ok: true }                      (confirm)
P4  POST   /api/sessions/:source/:id/plan/reject        body { feedback, confirm } → { ok: true }            (confirm)
```
New error codes: `nothing_to_commit`, `protected_branch`, `push_rejected`, `no_script`, `dirty_worktree`, `main_dirty`, `external_worktree`, `worktree_exists`, `not_a_worktree`, `is_main_checkout`, `no_worktree`, `gh_unavailable`, `git_failed`, `forbidden_git_args`, `hunk_not_found`, `no_pending_plan`, `unavailable` (503, service not wired).

API client methods (added to `createApiClient`): `worktreesList`, `worktreesDiscover`, `worktreesGet`, `worktreesCreate`, `worktreesScript`, `worktreesOpen`, `worktreesSyncPreview`, `worktreesSync`, `worktreesArchive`, `diffGet`, `diffRevert`, `checkpointsList`, `checkpointsDiff`, `checkpointsCreate`, `checkpointsRewind`, `reviewGet`, `reviewComments`, `shipSuggest`, `shipCommit`, `shipPush`, `shipPr`, `shipMerge`, `shipBackmerge`, `githubStatus`, `githubPr`, `githubMine`, `planApprove`, `planReject`.

zod schemas in `packages/api-contract/src/routes/`: `worktrees.ts` (`WorktreeViewSchema`, `CreateWorktreeBody`, `CreateWorktreeResult`, `WorktreeListQuery`, `WorktreeScriptBody`, `WorktreeOpenBody`, `SyncPreview`, `WorktreePathBody`, `WorktreeArchiveBody`), `review.ts` (`DiffResultSchema`, `DiffRevertBody`, `CheckpointRecordSchema`, `ReviewCommentSchema`, `ReviewCommentsBody`, `ReviewSummarySchema`), `ship.ts` (`PrRefSchema`, `PrStatusSchema`, `ShipSuggestion`, `ShipCommitBody`, `ShipPushBody`, `ShipPrBody`, `ShipMergeBody`, `ShipBackmergeBody`), `plan.ts` (`PlanApproveBody`, `PlanRejectBody`), and `common.ts` (`Confirm`).

### §6 WS / bus
```ts
// LiveEvent additions (forwarded to /ws)
| { type: 'worktree.updated'; worktree: WorktreeView }
| { type: 'worktree.removed'; path: string }
| { type: 'pr.updated'; status: PrStatus }
| { type: 'checkpoint.created'; checkpoint: CheckpointRecord }
// BusEvent additions (daemon-internal)
| { type: 'pr.changed'; before: PrStatus | null; after: PrStatus }          // already announced in §11
| { type: 'plan.pending'; pk: string; plan: string; toolUseId: string }
| { type: 'pr.reviewRequested'; pr: PrRef; title: string; active: boolean }  // active=false when the request goes away
```
Web query keys: `['worktrees', filters]`, `['diff', cwd, from, to]`, `['checkpoints', sessionPk]`, `['review', source, id]`, `['pr', repo, number]`, `['github', 'mine']`.

### §11 interface additions (additive; the §11 members are unchanged)
```ts
// services/worktree/worktree.ts
export interface SyncPreviewResult { path: string; mainPath: string; files: string[]; mainDirty: string[] }
export interface WorktreeService {           // §11 members +
  list(filter?: { projectId?: string; state?: Worktree['state']; repo?: string }): WorktreeView[];
  get(path: string): WorktreeView | null;
  findByCwd(cwd: string): WorktreeView | null;               // longest path prefix, active only
  syncPreview(path: string): Promise<SyncPreviewResult>;
  archiveAs(path: string, actor: AuditActor, opts?: { allowExternal?: boolean }): Promise<void>;  // archive(path) = archiveAs(path, 'user', { allowExternal: false })
  createWith(i: CreateWorktreeInput, opts: { runSetup: boolean; actor: AuditActor }): Promise<{ view: WorktreeView; setupPtyId: string | null }>;  // create(i) = createWith(i, { runSetup: true, actor: 'user' }).view
  open(path: string, target: 'vscode' | 'terminal' | 'finder'): Promise<void>;
}
// services/checkpoint/checkpoint.ts
export interface CheckpointService {         // §11 members +
  get(id: string): CheckpointRecord | null;
  createAs(sessionPk: string, worktreePath: string, turn: number, kind: CheckpointRecord['kind'], actor: AuditActor): Promise<CheckpointRecord>;
  pruneForWorktree(worktreePath: string): Promise<number>;
}
// connectors/github/github.ts
export interface GithubConnector {           // §11 members +
  watch(pr: PrRef): void;                    // add a PR to the poll set (after create/merge)
  start(): () => void;                       // poll now and every cfg.github.pollSeconds; returns stop()
}
// services/diff/diff.ts
export interface DiffService {
  diff(cwd: string, opts?: { from?: string; to?: string | 'WORKTREE' }): Promise<DiffResult>;
  mergeBase(cwd: string): Promise<string>;
  revert(cwd: string, file: string, opts: { hunkIndex?: number; from?: string }): Promise<{ reverted: string }>;
}
// services/review/review.ts
export interface ReviewService {
  summary(source: Source, id: string): Promise<ReviewSummary>;
  sendComments(source: Source, id: string, comments: ReviewComment[], deliver: 'session' | 'text'): Promise<{ sent: boolean; text: string }>;
}
// services/review/plan-approval.ts
export interface PlanApprovalService { approve(pk: string): Promise<void>; reject(pk: string, feedback: string): Promise<void> }
// services/ship/ship.ts
export interface ShipSuggestionResult { message: string; title: string; body: string; base: string; branch: string; ticket: string | null }
export interface ShipService {               // §11 members +
  suggest(cwd: string, sessionPk: string | null): Promise<ShipSuggestionResult>;
  backmerge(cwd: string, projectId: string, ticket: string | null): Promise<{ ptyId: string }>;
}
// DaemonContext additions: diff?: DiffService; review?: ReviewService; plans?: PlanApprovalService;
```

### Inbox rules and dedupe keys
- `pr-event` (on `pr.changed` and `pr.reviewRequested`): `pr:${repo}#${n}:checks` (kind `pr_event`, opened when `checks` becomes `failure`, resolved when it becomes `success`/`pending`), `pr:${repo}#${n}:review` (opened on `changes_requested`, resolved on any other review state or when the PR closes/merges), `pr:${repo}#${n}:review_requested` (on `pr.reviewRequested`; resolved when `active` is false).
- `worktree-archive-blocked`: `worktree:${path}:archive_blocked` (kind `pr_event`, raised by the auto-archiver when a merged PR's worktree is dirty or external).
- `plan-approval` (on `session.statusChanged`; scans the transcript for a pending `ExitPlanMode` tool call and emits `plan.pending`): `plan:${pk}` (kind `plan_approval`, resolved when the session status leaves `waiting` or after approve/reject).

---

## Assumed from earlier phases

Phases 1–3 were written in parallel. This phase relies only on the §11 interfaces plus the items below. If an earlier phase used a different local name, keep that name and adapt the import; the behaviour in this plan does not change. Record any rename in the task's review note.

| Item | Assumed signature | Phase |
|---|---|---|
| Test context | `createTestContext(overrides?: Partial<DaemonContext>): DaemonContext` and `useTempHomes(): { orcHome: string; claudeHome: string; codexHome: string }` in `apps/daemon/test/helpers.ts` (temp dirs removed in `afterEach`) | P1 |
| Route modules | each area exports `function <area>Routes(ctx: DaemonContext): Hono`, mounted in `apps/daemon/src/http/app.ts` → `createApp(ctx)` via `app.route('/api', <area>Routes(ctx))` after the auth middleware | P1 |
| Service wiring | `apps/daemon/src/main.ts` → `createDaemon(paths): Promise<DaemonContext & { app: Hono; close(): Promise<void> }>` builds the context in order and assigns optional services | P1 |
| WS forwarder | `apps/daemon/src/live/event-bus.ts` exports `LIVE_EVENT_TYPES: ReadonlySet<LiveEvent['type']>`; `http/ws.ts` forwards bus events whose type is in it | P2 |
| Launch | `apps/daemon/src/services/launch/launch.ts` exports `launchSession(ctx: DaemonContext, req: LaunchRequest): Promise<{ ptyId: string; sessionId: string \| null }>` and, before spawning, calls `assertLaunchSupported(req)` which throws `HttpError(501, 'not_implemented', …)` for `planApproval` / `worktree` / `compare`. Args are built by `buildLaunchArgs(cfg: OrcConfig, req: LaunchRequest): { command: string; args: string[] }` in `services/launch/args.ts` | P2 |
| HTTP errors | `apps/daemon/src/http/errors.ts` exports `class HttpError extends Error { readonly status: number; readonly code: string; readonly details?: unknown; constructor(status: number, code: string, message: string, details?: unknown) }`; `createApp` turns it into the §6 error body | P1 |
| Templates | `TemplateRegistry` has ids `implement-ticket`, `investigate`, `backmerge`, `plan`, `review-pr`, `preset-fix-test`, `preset-add-test`, `preset-simplify`, `preset-address-comments`, `preset-fix-ci` | P2 |
| Audit | `createAuditService(db: OrcDb): AuditService` and `audited()` in `apps/daemon/src/services/audit/audit.ts` | P3 |
| Web client | `apps/web/src/api/client.ts` exports `getApiClient(): ApiClient`, `setApiClientForTests(c: ApiClient)`, and `class ApiRequestError extends Error { readonly status: number; readonly code: string; readonly details?: unknown; constructor(status: number, code: string, message: string, details?: unknown) }` | P1 |
| Web live events | `apps/web/src/api/live-events.ts` exports `applyLiveEvent(qc: QueryClient, e: LiveEvent): void` (a `switch` on `e.type`), used by `useLiveEvents()` | P2 |
| Web shell | `apps/web/src/features/shell/AppShell.tsx` builds the left nav from `NAV_ITEMS: Array<{ to: string; label: string }>`; `useTerminalStore` as in contracts §12 | P2 |
| Test render helper | `apps/web/src/test/render.tsx` exports `renderWithProviders(ui: ReactElement): RenderResult & { qc: QueryClient }` (fresh `QueryClient`, retries off) | P1 |
| API client builder | `packages/api-contract/src/client.ts` builds the client from area factories `(<area>Client)(req: ApiRequester)` where `type ApiRequester = <T>(method: 'GET'\|'POST'\|'PATCH'\|'DELETE', path: string, opts?: { query?: Record<string, string \| number \| boolean \| undefined>; body?: unknown; schema?: z.ZodType<T> }) => Promise<T>` | P1 |
| UI kit | `@/components/ui/button` → `Button`; `@/components/ui/dialog` → `Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter`; `@/components/ui/badge` → `Badge` | P0/P1 |
| Session card | `apps/web/src/features/live-board/SessionCard.tsx` renders `session.prs` chips via `features/live-board/PrChip.tsx` → `PrChip({ pr }: { pr: PrRef })` | P2 |
| Launch dialog | `apps/web/src/features/launch/LaunchDialog.tsx` holds a `LaunchRequest` draft in `useState` and has a disabled "Plan approval" checkbox and "New worktree" section behind `const P4_ENABLED = false` | P2 |
| Inbox actions | `apps/web/src/features/inbox/InboxItemActions.tsx` switches on `item.kind` | P2 |

---

## File Structure (created or modified in this phase)
```
packages/core/src/types/work.ts                               (modify: Phase 4 types)
packages/core/src/git/{index.ts,worktree-porcelain.ts,branch.ts,status-porcelain.ts,diff-parse.ts,hunk-select.ts,review-prompt.ts} + *.test.ts
packages/core/src/index.ts                                    (modify)
packages/api-contract/src/config.ts                            (modify: github, worktrees)
packages/api-contract/src/routes/{common.ts,worktrees.ts,review.ts,ship.ts,plan.ts} + phase4.test.ts
packages/api-contract/src/client.ts, src/index.ts, src/live.ts (modify)
apps/daemon/src/db/schema.ts                                   (modify) + migrations/000N_phase4.sql (generated)
apps/daemon/src/db/repos/{worktrees.ts,checkpoints.ts,pr-cache.ts} + repos/phase4.test.ts
apps/daemon/src/services/git/exec.ts + exec.test.ts
apps/daemon/src/services/worktree/{sources.ts,discover.ts,worktree.ts,auto-archive.ts} + tests
apps/daemon/src/services/checkpoint/checkpoint.ts + checkpoint.test.ts + turn-hook.ts
apps/daemon/src/services/diff/diff.ts + diff.test.ts
apps/daemon/src/services/review/{review.ts,plan-approval.ts,plan-keys.ts} + tests
apps/daemon/src/services/ship/ship.ts + ship.test.ts
apps/daemon/src/connectors/github/github.ts + github.test.ts
apps/daemon/src/inbox/rules/{pr-event.ts,plan-approval.ts} + tests
apps/daemon/src/services/launch/{launch.ts,args.ts}           (modify)
apps/daemon/src/http/routes/{git-guard.ts,worktrees.ts,review.ts,ship.ts,github.ts,plan.ts} + tests
apps/daemon/src/http/app.ts, src/main.ts, src/context.ts, src/live/event-bus.ts (modify)
apps/daemon/test/{git-fixture.ts,fake-gh.ts,stubs.ts,fake-pty.ts}, apps/daemon/test/bin/gh
apps/web/src/api/queries/{worktrees.ts,review.ts,ship.ts,github.ts}, src/api/live-events.ts (modify)
apps/web/src/features/git/{GitConfirmDialog.tsx,useConfirmedMutation.ts} + test
apps/web/src/features/worktrees/{WorktreesPage.tsx,WorktreeRow.tsx,CreateWorktreeDialog.tsx} + test
apps/web/src/features/review/{ReviewPage.tsx,FileTree.tsx,FileDiff.tsx,CommentComposer.tsx,useReviewDraft.ts,CheckpointTimeline.tsx,ShipPanel.tsx,SummaryCard.tsx,PresetButtons.tsx} + tests
apps/web/src/routes/{worktrees.tsx,review.$source.$id.tsx}
apps/web/src/features/live-board/PrChip.tsx, features/launch/LaunchDialog.tsx, features/inbox/InboxItemActions.tsx (modify)
apps/web/e2e/m4-ticket-to-merge.spec.ts, apps/web/e2e/support/m4-seed.ts
```

---
### Task 1: Phase 4 types, config and API schemas

**Files:**
- Modify: `packages/core/src/types/work.ts`, `packages/api-contract/src/config.ts`, `packages/api-contract/src/index.ts`, `packages/api-contract/src/live.ts` (the file where P2 declared `LiveEvent`), `apps/daemon/src/live/event-bus.ts`
- Create: `packages/api-contract/src/routes/common.ts`, `routes/worktrees.ts`, `routes/review.ts`, `routes/ship.ts`, `routes/plan.ts`
- Test: `packages/api-contract/src/routes/phase4.test.ts`

**Interfaces:**
- Consumes: `Worktree`, `Checkpoint`, `PrRef`, `TestResult`, `Source` (core §4); `OrcConfig` (§3); `LiveEvent`, `BusEvent`, `LIVE_EVENT_TYPES` (P2).
- Produces: core types `WorktreeOrigin`, `WorktreeView`, `PrStatus`, `DiffHunk`, `DiffFileEntry`, `DiffResult`, `ReviewComment`, `ReviewSummary`, `CheckpointRecord`; zod `Confirm`, `WorktreeViewSchema`, `CreateWorktreeBody`, `WorktreeScriptBody`, `WorktreeOpenBody`, `WorktreePathBody`, `WorktreeArchiveBody`, `SyncPreview`, `DiffResultSchema`, `DiffRevertBody`, `CheckpointRecordSchema`, `ReviewCommentSchema`, `ReviewCommentsBody`, `ReviewSummarySchema`, `PrRefSchema`, `PrStatusSchema`, `ShipSuggestion`, `ShipCommitBody`, `ShipPushBody`, `ShipPrBody`, `ShipMergeBody`, `ShipBackmergeBody`, `PlanApproveBody`, `PlanRejectBody`; config `cfg.github`, `cfg.worktrees`; bus events `pr.changed`, `plan.pending`; live events `worktree.updated`, `worktree.removed`, `pr.updated`, `checkpoint.created`.

- [ ] **Step 1: Write the failing schema test**

`packages/api-contract/src/routes/phase4.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { OrcConfig } from '../config.ts';
import { CreateWorktreeBody, WorktreeArchiveBody, WorktreeViewSchema } from './worktrees.ts';
import { DiffRevertBody, ReviewCommentsBody } from './review.ts';
import { PrStatusSchema, ShipMergeBody, ShipPrBody } from './ship.ts';
import { PlanRejectBody } from './plan.ts';

describe('phase 4 schemas', () => {
  it('adds github and worktrees config defaults', () => {
    const c = OrcConfig.parse({});
    expect(c.github).toEqual({
      enabled: true,
      pollSeconds: 90,
      ticketUrlTemplate: 'https://linear.app/wakecap/issue/{ticket}',
      protectedBranches: ['main', 'master', 'develop', 'staging', 'testing', 'production'],
    });
    expect(c.worktrees.autoArchiveOnMerge).toBe(true);
    expect(c.worktrees.scratchpadRoots).toEqual(['/private/tmp']);
    expect(c.worktrees.implementTicketMode).toBe('conductor');
    expect(c.worktrees.checkpointsPerSession).toBe(200);
  });

  it('rejects a poll interval under 30 s', () => {
    expect(() => OrcConfig.parse({ github: { pollSeconds: 5 } })).toThrow();
  });

  it('parses a create body with an optional launch', () => {
    const b = CreateWorktreeBody.parse({ repo: '/r', base: 'main', type: 'feat', ticket: 'SAF-1', slug: 'x', confirm: true });
    expect(b.launch).toBeUndefined();
    expect(b.runSetup).toBe(true);
    expect(() => CreateWorktreeBody.parse({ repo: '/r', base: 'main', type: 'feature', ticket: null, slug: 'x' })).toThrow();
  });

  it('defaults confirm flags to false', () => {
    const a = WorktreeArchiveBody.parse({ path: '/r/.worktrees/x' });
    expect(a.confirm).toBe(false);
    expect(a.confirmExternal).toBe(false);
  });

  it('parses a worktree view', () => {
    const v = WorktreeViewSchema.parse({
      path: '/r/.worktrees/feat-SAF-1-x', repo: '/r', branch: 'feat/SAF-1-x', base: 'main', ticket: 'SAF-1', dirty: false,
      prUrl: null, state: 'active', createdByApp: true, head: 'abc', isMain: false, origin: 'app', sessionPks: [],
      projectId: 'wakecap', prStatus: null, updatedAt: '2026-09-17T00:00:00.000Z',
    });
    expect(v.origin).toBe('app');
  });

  it('limits review comments and requires text', () => {
    expect(() => ReviewCommentsBody.parse({ comments: [], deliver: 'text' })).toThrow();
    expect(() => ReviewCommentsBody.parse({ comments: [{ file: 'a.ts', line: 1, side: 'new', body: '' }], deliver: 'text' })).toThrow();
    const ok = ReviewCommentsBody.parse({ comments: [{ file: 'a.ts', line: 1, side: 'new', body: 'rename' }], deliver: 'session' });
    expect(ok.confirm).toBe(false);
  });

  it('parses revert, PR, merge and plan bodies', () => {
    expect(DiffRevertBody.parse({ cwd: '/r', file: 'a.ts', confirm: true }).hunkIndex).toBeUndefined();
    expect(ShipPrBody.parse({ cwd: '/r', title: 't', body: 'b', base: 'main', confirm: true }).draft).toBe(false);
    expect(() => ShipMergeBody.parse({ pr: { repo: 'o/r', number: 1, url: 'u' }, method: 'fast-forward', confirm: true })).toThrow();
    expect(() => PlanRejectBody.parse({ feedback: '', confirm: true })).toThrow();
  });

  it('parses a PR status', () => {
    const s = PrStatusSchema.parse({
      pr: { repo: 'o/r', number: 3, url: 'https://github.com/o/r/pull/3' }, state: 'merged', title: 't', checks: 'success',
      review: 'approved', updatedAt: '2026-09-17T00:00:00Z', headRef: 'feat/SAF-1-x', failedChecks: [],
    });
    expect(s.state).toBe('merged');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/api-contract/src/routes/phase4.test.ts`
Expected: FAIL, `Cannot find module './worktrees.ts'`

- [ ] **Step 3: Add the core types**

Append to `packages/core/src/types/work.ts` (it already imports `PrRef` and `TestResult` from `./session.ts`; add that import if missing):
```ts
export type WorktreeOrigin = 'app' | 'config' | 'session-cwd' | 'claude-json' | 'worktree-dir' | 'sibling' | 'scratchpad';

export interface PrStatus {
  pr: PrRef;
  state: 'open' | 'closed' | 'merged';
  title: string;
  checks: 'pending' | 'success' | 'failure' | 'none';
  review: 'approved' | 'changes_requested' | 'review_required' | 'none';
  updatedAt: string;
  headRef: string | null;
  failedChecks: string[];
}

export interface WorktreeView extends Worktree {
  head: string | null;
  isMain: boolean;
  origin: WorktreeOrigin;
  sessionPks: string[];
  projectId: string | null;
  prStatus: PrStatus | null;
  updatedAt: string;
}

export interface CheckpointRecord extends Checkpoint {
  kind: 'turn' | 'safety' | 'manual';
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface DiffFileEntry {
  path: string;
  oldPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'binary';
  additions: number;
  deletions: number;
  patch: string;
  hunks: DiffHunk[];
}

export interface DiffResult {
  cwd: string;
  from: string;
  to: string;
  files: DiffFileEntry[];
  additions: number;
  deletions: number;
}

export interface ReviewComment {
  file: string;
  line: number;
  side: 'old' | 'new';
  body: string;
}

export interface ReviewSummary {
  sessionPk: string;
  cwd: string;
  worktree: WorktreeView | null;
  files: Array<{ path: string; additions: number; deletions: number }>;
  additions: number;
  deletions: number;
  lastTest: TestResult | null;
  recap: string | null;
  pr: PrStatus | null;
  owned: boolean;
  checkpoints: CheckpointRecord[];
}
```

- [ ] **Step 4: Add the config fields**

In `packages/api-contract/src/config.ts`, add these two keys inside `OrcConfig = z.object({ … })`, after `archive`:
```ts
  github: z
    .object({
      enabled: z.boolean().default(true),
      pollSeconds: z.number().int().min(30).default(90),
      ticketUrlTemplate: z.string().default('https://linear.app/wakecap/issue/{ticket}'),
      protectedBranches: z.array(z.string()).default(['main', 'master', 'develop', 'staging', 'testing', 'production']),
    })
    .default({}),
  worktrees: z
    .object({
      autoArchiveOnMerge: z.boolean().default(true),
      scratchpadRoots: z.array(z.string()).default(['/private/tmp']),
      scanSiblings: z.boolean().default(true),
      implementTicketMode: z.enum(['precreate', 'conductor']).default('conductor'),
      checkpointsPerSession: z.number().int().positive().default(200),
    })
    .default({}),
```

- [ ] **Step 5: Write the route schemas**

`packages/api-contract/src/routes/common.ts`
```ts
import { z } from 'zod';

export const Confirm = z.boolean().default(false);
export const IsoString = z.string().min(1);
```

`packages/api-contract/src/routes/ship.ts`
```ts
import { z } from 'zod';
import { Confirm, IsoString } from './common.ts';

export const PrRefSchema = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive(), url: z.string() });

export const PrStatusSchema = z.object({
  pr: PrRefSchema,
  state: z.enum(['open', 'closed', 'merged']),
  title: z.string(),
  checks: z.enum(['pending', 'success', 'failure', 'none']),
  review: z.enum(['approved', 'changes_requested', 'review_required', 'none']),
  updatedAt: IsoString,
  headRef: z.string().nullable(),
  failedChecks: z.array(z.string()),
});

export const ShipSuggestion = z.object({
  message: z.string(),
  title: z.string(),
  body: z.string(),
  base: z.string(),
  branch: z.string(),
  ticket: z.string().nullable(),
});

export const ShipCommitBody = z.object({ cwd: z.string().min(1), message: z.string().min(1).max(5000), confirm: Confirm });
export const ShipPushBody = z.object({ cwd: z.string().min(1), confirm: Confirm });
export const ShipPrBody = z.object({
  cwd: z.string().min(1),
  title: z.string().min(1).max(250),
  body: z.string().max(60000),
  base: z.string().min(1),
  draft: z.boolean().default(false),
  confirm: Confirm,
});
export const ShipMergeBody = z.object({ pr: PrRefSchema, method: z.enum(['merge', 'squash', 'rebase']), confirm: Confirm });
export const ShipBackmergeBody = z.object({
  cwd: z.string().min(1),
  projectId: z.string().min(1),
  ticket: z.string().nullable().default(null),
  confirm: Confirm,
});
```

`packages/api-contract/src/routes/worktrees.ts`
```ts
import { z } from 'zod';
import { Confirm, IsoString } from './common.ts';
import { PrStatusSchema } from './ship.ts';

export const WorktreeType = z.enum(['feat', 'fix', 'chore', 'docs', 'refactor']);

export const WorktreeViewSchema = z.object({
  path: z.string(),
  repo: z.string(),
  branch: z.string(),
  base: z.string().nullable(),
  ticket: z.string().nullable(),
  dirty: z.boolean(),
  prUrl: z.string().nullable(),
  state: z.enum(['active', 'archived']),
  createdByApp: z.boolean(),
  head: z.string().nullable(),
  isMain: z.boolean(),
  origin: z.enum(['app', 'config', 'session-cwd', 'claude-json', 'worktree-dir', 'sibling', 'scratchpad']),
  sessionPks: z.array(z.string()),
  projectId: z.string().nullable(),
  prStatus: PrStatusSchema.nullable(),
  updatedAt: IsoString,
});

export const WorktreeListQuery = z.object({
  projectId: z.string().optional(),
  state: z.enum(['active', 'archived']).optional(),
  repo: z.string().optional(),
});

export const CreateWorktreeBody = z.object({
  repo: z.string().min(1),
  base: z.string().min(1),
  type: WorktreeType,
  ticket: z.string().nullable(),
  slug: z.string().min(1).max(80),
  runSetup: z.boolean().default(true),
  launch: z
    .object({ source: z.enum(['claude', 'codex']), prompt: z.string().default(''), templateId: z.string().optional(), planApproval: z.boolean().default(false) })
    .optional(),
  confirm: Confirm,
});

export const WorktreeScriptBody = z.object({ path: z.string().min(1), which: z.enum(['setup', 'run', 'archive']), confirm: Confirm });
export const WorktreeOpenBody = z.object({ path: z.string().min(1), target: z.enum(['vscode', 'terminal', 'finder']) });
export const WorktreePathBody = z.object({ path: z.string().min(1), confirm: Confirm });
export const WorktreeArchiveBody = z.object({ path: z.string().min(1), confirm: Confirm, confirmExternal: z.boolean().default(false) });
export const SyncPreview = z.object({ path: z.string(), mainPath: z.string(), files: z.array(z.string()), mainDirty: z.array(z.string()) });
export const CreateWorktreeResult = z.object({
  worktree: WorktreeViewSchema,
  setupPtyId: z.string().nullable(),
  launch: z.object({ ptyId: z.string(), sessionId: z.string().nullable() }).nullable(),
});
```

`packages/api-contract/src/routes/review.ts`
```ts
import { z } from 'zod';
import { Confirm, IsoString } from './common.ts';
import { PrStatusSchema } from './ship.ts';
import { WorktreeViewSchema } from './worktrees.ts';

const Hunk = z.object({
  header: z.string(),
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  lines: z.array(z.string()),
});

export const DiffFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'binary']),
  additions: z.number().int(),
  deletions: z.number().int(),
  patch: z.string(),
  hunks: z.array(Hunk),
});

export const DiffResultSchema = z.object({
  cwd: z.string(),
  from: z.string(),
  to: z.string(),
  files: z.array(DiffFileSchema),
  additions: z.number().int(),
  deletions: z.number().int(),
});

export const DiffQuery = z.object({ cwd: z.string().min(1), from: z.string().optional(), to: z.string().optional() });

export const DiffRevertBody = z.object({
  cwd: z.string().min(1),
  file: z.string().min(1),
  hunkIndex: z.number().int().nonnegative().optional(),
  from: z.string().optional(),
  confirm: Confirm,
});

export const CheckpointRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  worktreePath: z.string(),
  turn: z.number().int(),
  ref: z.string(),
  commit: z.string(),
  createdAt: IsoString,
  kind: z.enum(['turn', 'safety', 'manual']),
});

export const CheckpointCreateBody = z.object({ sessionPk: z.string().min(1), confirm: Confirm });
export const CheckpointRewindBody = z.object({ confirm: Confirm });

export const ReviewCommentSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  side: z.enum(['old', 'new']),
  body: z.string().trim().min(1).max(4000),
});

export const ReviewCommentsBody = z.object({
  comments: z.array(ReviewCommentSchema).min(1).max(200),
  deliver: z.enum(['session', 'text']),
  confirm: Confirm,
});

const TestResultSchema = z.object({
  ts: z.string(),
  command: z.string(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  durationMs: z.number().nullable(),
});

export const ReviewSummarySchema = z.object({
  sessionPk: z.string(),
  cwd: z.string(),
  worktree: WorktreeViewSchema.nullable(),
  files: z.array(z.object({ path: z.string(), additions: z.number(), deletions: z.number() })),
  additions: z.number(),
  deletions: z.number(),
  lastTest: TestResultSchema.nullable(),
  recap: z.string().nullable(),
  pr: PrStatusSchema.nullable(),
  owned: z.boolean(),
  checkpoints: z.array(CheckpointRecordSchema),
});
```

`packages/api-contract/src/routes/plan.ts`
```ts
import { z } from 'zod';
import { Confirm } from './common.ts';

export const PlanApproveBody = z.object({ confirm: Confirm });
export const PlanRejectBody = z.object({ feedback: z.string().trim().min(1).max(8000), confirm: Confirm });
```

Append to `packages/api-contract/src/index.ts`:
```ts
export * from './routes/common.ts';
export * from './routes/worktrees.ts';
export * from './routes/review.ts';
export * from './routes/ship.ts';
export * from './routes/plan.ts';
```

- [ ] **Step 6: Extend live events, bus events and the context**

In the file that declares `LiveEvent` (P2: `packages/api-contract/src/live.ts`), add `import type { CheckpointRecord, PrStatus, WorktreeView } from '@orc/core';` and these union members:
```ts
  | { type: 'worktree.updated'; worktree: WorktreeView }
  | { type: 'worktree.removed'; path: string }
  | { type: 'pr.updated'; status: PrStatus }
  | { type: 'checkpoint.created'; checkpoint: CheckpointRecord }
```

In `apps/daemon/src/live/event-bus.ts` extend `BusEvent` and the forwarder set:
```ts
export type BusEvent =
  | LiveEvent
  | { type: 'hook.received'; payload: unknown }
  | { type: 'session.statusChanged'; pk: string; from: LiveStatus | null; to: LiveStatus }
  | { type: 'session.turnEnded'; pk: string; turn: number }
  | { type: 'tests.recorded'; pk: string; result: TestResult }
  | { type: 'pr.changed'; before: PrStatus | null; after: PrStatus }
  | { type: 'plan.pending'; pk: string; plan: string; toolUseId: string }
  | { type: 'pr.reviewRequested'; pr: PrRef; title: string; active: boolean };
```
and add `'worktree.updated'`, `'worktree.removed'`, `'pr.updated'`, `'checkpoint.created'` to the `LIVE_EVENT_TYPES` set literal. Import `PrRef` and `PrStatus` from `@orc/core`.

In `apps/daemon/src/context.ts`, the optional P4 fields are typed by the files that later tasks create. Each task that creates a service also updates its `DaemonContext` field and import in the same commit, so `pnpm typecheck` stays green:
- Task 10: `worktrees?: WorktreeService` (from `./services/worktree/worktree.ts`) and `checkpoints?: CheckpointService` (from `./services/checkpoint/checkpoint.ts`)
- Task 11: `diff?: DiffService` (new field, from `./services/diff/diff.ts`)
- Task 12: `review?: ReviewService` (new field, from `./services/review/review.ts`)
- Task 13: `github?: GithubConnector` (from `./connectors/github/github.ts`)
- Task 15: `ship?: ShipService` (from `./services/ship/ship.ts`)
- Task 16: `plans?: PlanApprovalService` (new field, from `./services/review/plan-approval.ts`)

If Phase 1 declared placeholder types for `worktrees`, `checkpoints`, `ship` or `github`, those tasks replace the placeholder import with the real one.

- [ ] **Step 7: Run the tests and the typecheck**

Run: `pnpm vitest run packages/api-contract && pnpm typecheck`
Expected: PASS (8 new tests plus the Phase 0 config tests); typecheck exits 0.

- [ ] **Step 8: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add packages/core/src/types packages/api-contract/src apps/daemon/src/live/event-bus.ts
git commit -m "feat(api-contract): add phase 4 worktree, review, ship and plan schemas"
```

---
### Task 2: Pure git parsers — worktree porcelain, status, branch names

**Files:**
- Create: `packages/core/src/git/worktree-porcelain.ts`, `packages/core/src/git/status-porcelain.ts`, `packages/core/src/git/branch.ts`, `packages/core/src/git/index.ts`
- Test: `packages/core/src/git/worktree-porcelain.test.ts`, `packages/core/src/git/status-porcelain.test.ts`, `packages/core/src/git/branch.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```ts
  export interface PorcelainWorktree { path: string; head: string | null; branch: string | null; detached: boolean; bare: boolean; locked: boolean; prunable: boolean }
  export function parseWorktreePorcelain(out: string): PorcelainWorktree[]
  export interface StatusEntry { path: string; origPath: string | null; x: string; y: string; untracked: boolean }
  export function parseStatusPorcelainZ(out: string): StatusEntry[]
  export type BranchType = 'feat' | 'fix' | 'chore' | 'docs' | 'refactor'
  export function slugify(text: string, maxLen?: number): string          // default 30
  export function branchName(i: { type: BranchType; ticket: string | null; slug: string }): string
  export function worktreeDirName(branch: string): string
  export function ticketFromBranch(branch: string, ticketRegex: string | null): string | null
  export const DEFAULT_TICKET_REGEX: string
  ```

- [ ] **Step 1: Write the failing tests**

`packages/core/src/git/worktree-porcelain.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { parseWorktreePorcelain } from './worktree-porcelain.ts';

const OUT = [
  'worktree /Users/test/Wakecap/Backend/infra',
  'HEAD 242bb89333c9f62b76cae3955f6c40ef2a4595a8',
  'branch refs/heads/master',
  '',
  'worktree /Users/test/Wakecap/Backend/infra/.worktrees/feat-ALU-1293-obs-failed-routes',
  'HEAD a04f9ef774f4aba5772385ded34b85fdb69955b0',
  'branch refs/heads/feat/ALU-1293-obs-failed-routes',
  '',
  'worktree /private/tmp/claude-501/x/scratch',
  'HEAD 1111111111111111111111111111111111111111',
  'detached',
  'locked in use',
  '',
  'worktree /gone/away',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/chore/old',
  'prunable gitdir file points to non-existent location',
  '',
].join('\n');

describe('parseWorktreePorcelain', () => {
  it('parses every block', () => {
    const w = parseWorktreePorcelain(OUT);
    expect(w).toHaveLength(4);
    expect(w[0]).toEqual({
      path: '/Users/test/Wakecap/Backend/infra', head: '242bb89333c9f62b76cae3955f6c40ef2a4595a8', branch: 'master',
      detached: false, bare: false, locked: false, prunable: false,
    });
    expect(w[1]?.branch).toBe('feat/ALU-1293-obs-failed-routes');
    expect(w[2]).toMatchObject({ branch: null, detached: true, locked: true });
    expect(w[3]?.prunable).toBe(true);
  });

  it('handles a bare main repo and CRLF', () => {
    const w = parseWorktreePorcelain('worktree /srv/r.git\r\nbare\r\n\r\n');
    expect(w).toEqual([{ path: '/srv/r.git', head: null, branch: null, detached: false, bare: true, locked: false, prunable: false }]);
  });

  it('returns [] for empty output', () => {
    expect(parseWorktreePorcelain('')).toEqual([]);
  });
});
```

`packages/core/src/git/status-porcelain.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { parseStatusPorcelainZ } from './status-porcelain.ts';

describe('parseStatusPorcelainZ', () => {
  it('parses modified, untracked and renamed entries', () => {
    const out = ' M src/a.ts\0?? new file.ts\0R  src/b2.ts\0src/b.ts\0D  gone.ts\0';
    expect(parseStatusPorcelainZ(out)).toEqual([
      { path: 'src/a.ts', origPath: null, x: ' ', y: 'M', untracked: false },
      { path: 'new file.ts', origPath: null, x: '?', y: '?', untracked: true },
      { path: 'src/b2.ts', origPath: 'src/b.ts', x: 'R', y: ' ', untracked: false },
      { path: 'gone.ts', origPath: null, x: 'D', y: ' ', untracked: false },
    ]);
  });

  it('returns [] for a clean tree', () => {
    expect(parseStatusPorcelainZ('')).toEqual([]);
  });
});
```

`packages/core/src/git/branch.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { branchName, slugify, ticketFromBranch, worktreeDirName } from './branch.ts';

describe('slugify', () => {
  it('kebab-cases, drops filler words and accents', () => {
    expect(slugify('Exclude the Weekends from SLA déadline!')).toBe('exclude-weekends-sla-deadline');
  });
  it('cuts at a word boundary within 30 chars', () => {
    const s = slugify('mobile sdui mvp on device ai authored screen runtime tracer');
    expect(s.length).toBeLessThanOrEqual(30);
    expect(s).toBe('mobile-sdui-mvp-device-ai');
  });
  it('falls back to "work"', () => {
    expect(slugify('  the / a  ')).toBe('work');
  });
});

describe('branchName', () => {
  it('uses <type>/<TICKET>-<slug> with an uppercase ticket', () => {
    expect(branchName({ type: 'feat', ticket: 'saf-1787', slug: 'Exclude weekends SLA' })).toBe('feat/SAF-1787-exclude-weekends-sla');
  });
  it('omits the ticket when there is none', () => {
    expect(branchName({ type: 'chore', ticket: null, slug: 'bump deps' })).toBe('chore/bump-deps');
  });
  it('rejects a ticket with unsafe characters', () => {
    expect(() => branchName({ type: 'fix', ticket: 'SAF 1; rm', slug: 'x' })).toThrow(/invalid ticket/);
  });
});

describe('worktreeDirName', () => {
  it('flattens slashes like the existing .worktrees folders', () => {
    expect(worktreeDirName('feat/ALU-1293-obs-failed-routes')).toBe('feat-ALU-1293-obs-failed-routes');
  });
});

describe('ticketFromBranch', () => {
  it('uses the project regex when given', () => {
    expect(ticketFromBranch('feat/SAF-1787-x', '\\b(SAF|ALU)-\\d+\\b')).toBe('SAF-1787');
    expect(ticketFromBranch('feat/TAN-1-x', '\\b(SAF|ALU)-\\d+\\b')).toBeNull();
  });
  it('falls back to the default regex', () => {
    expect(ticketFromBranch('docs/alu-1293-pin', null)).toBe('ALU-1293');
    expect(ticketFromBranch('master', null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run packages/core/src/git`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the parsers**

`packages/core/src/git/worktree-porcelain.ts`
```ts
export interface PorcelainWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export function parseWorktreePorcelain(out: string): PorcelainWorktree[] {
  const result: PorcelainWorktree[] = [];
  let cur: PorcelainWorktree | null = null;
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      if (cur) result.push(cur);
      cur = null;
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree') {
      if (cur) result.push(cur);
      cur = { path: value, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
      continue;
    }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  if (cur) result.push(cur);
  return result;
}
```

`packages/core/src/git/status-porcelain.ts`
```ts
export interface StatusEntry {
  path: string;
  origPath: string | null;
  x: string;
  y: string;
  untracked: boolean;
}

/** Parses `git status --porcelain=v1 -z` output. */
export function parseStatusPorcelainZ(out: string): StatusEntry[] {
  const parts = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part.length < 4) continue;
    const x = part[0] ?? ' ';
    const y = part[1] ?? ' ';
    const path = part.slice(3);
    let origPath: string | null = null;
    if (x === 'R' || x === 'C') {
      origPath = parts[i + 1] ?? null;
      i++;
    }
    entries.push({ path, origPath, x, y, untracked: x === '?' && y === '?' });
  }
  return entries;
}
```

`packages/core/src/git/branch.ts`
```ts
export type BranchType = 'feat' | 'fix' | 'chore' | 'docs' | 'refactor';

export const DEFAULT_TICKET_REGEX = '\\b([A-Za-z][A-Za-z0-9]{1,9}-\\d+)\\b';

const FILLER = new Set(['the', 'a', 'an', 'for', 'on', 'with', 'of', 'to', 'and', 'in', 'from']);

export function slugify(text: string, maxLen = 30): string {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !FILLER.has(w));
  let out = '';
  for (const w of words) {
    const next = out === '' ? w : `${out}-${w}`;
    if (next.length > maxLen) {
      if (out === '') out = w.slice(0, maxLen);
      break;
    }
    out = next;
  }
  return out === '' ? 'work' : out;
}

export function branchName(i: { type: BranchType; ticket: string | null; slug: string }): string {
  const slug = slugify(i.slug);
  if (i.ticket === null || i.ticket.trim() === '') return `${i.type}/${slug}`;
  const ticket = i.ticket.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,9}-\d+$/.test(ticket)) throw new Error(`invalid ticket: ${i.ticket}`);
  return `${i.type}/${ticket}-${slug}`;
}

export function worktreeDirName(branch: string): string {
  return branch.replace(/\//g, '-');
}

export function ticketFromBranch(branch: string, ticketRegex: string | null): string | null {
  const re = new RegExp(ticketRegex ?? DEFAULT_TICKET_REGEX, 'i');
  const m = re.exec(branch);
  if (!m) return null;
  const hit = m[0];
  if (ticketRegex === null && !/-\d+$/.test(hit)) return null;
  return hit.toUpperCase();
}
```

`packages/core/src/git/index.ts`
```ts
export * from './branch.ts';
export * from './status-porcelain.ts';
export * from './worktree-porcelain.ts';
```

Append to `packages/core/src/index.ts`:
```ts
export * from './git/index.ts';
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/core/src/git`
Expected: PASS (13 tests). If `ticketFromBranch('master', null)` matches (it cannot, there is no `-\d+`), recheck the regex.

- [ ] **Step 5: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add packages/core/src
git commit -m "feat(core): parse worktree/status porcelain and build branch names"
```

---
### Task 3: Pure diff parser, hunk selection and review prompt

**Files:**
- Create: `packages/core/src/git/diff-parse.ts`, `packages/core/src/git/hunk-select.ts`, `packages/core/src/git/review-prompt.ts`
- Test: `packages/core/src/git/diff-parse.test.ts`, `packages/core/src/git/hunk-select.test.ts`, `packages/core/src/git/review-prompt.test.ts`
- Modify: `packages/core/src/git/index.ts`

**Interfaces:**
- Consumes: `DiffFileEntry`, `DiffHunk`, `ReviewComment` (Task 1)
- Produces:
  ```ts
  export function parseUnifiedDiff(patch: string): DiffFileEntry[]
  export function hunkPatch(file: DiffFileEntry, hunkIndex: number): string     // header + one hunk, ends with '\n'
  export function buildReviewPrompt(comments: ReviewComment[], opts?: { branch?: string | null }): string
  ```

- [ ] **Step 1: Write the failing tests**

`packages/core/src/git/diff-parse.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './diff-parse.ts';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' export { a, b };',
  '@@ -10,2 +10,3 @@ function f() {',
  ' x();',
  '+y();',
  ' z();',
  'diff --git a/new file.ts b/new file.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/new file.ts',
  '@@ -0,0 +1 @@',
  '+export const n = 1;',
  'diff --git a/old.ts b/old.ts',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/old.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  'diff --git a/r1.ts b/r2.ts',
  'similarity index 100%',
  'rename from r1.ts',
  'rename to r2.ts',
  'diff --git a/img.png b/img.png',
  'index 5555555..6666666 100644',
  'Binary files a/img.png and b/img.png differ',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  const files = parseUnifiedDiff(PATCH);

  it('finds every file with its status', () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['src/a.ts', 'modified'],
      ['new file.ts', 'added'],
      ['old.ts', 'deleted'],
      ['r2.ts', 'renamed'],
      ['img.png', 'binary'],
    ]);
    expect(files[3]?.oldPath).toBe('r1.ts');
  });

  it('counts additions and deletions inside hunks only', () => {
    expect(files[0]).toMatchObject({ additions: 2, deletions: 1 });
    expect(files[1]).toMatchObject({ additions: 1, deletions: 0 });
    expect(files[2]).toMatchObject({ additions: 0, deletions: 1 });
  });

  it('parses hunk headers, including omitted counts', () => {
    expect(files[0]?.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 3, 1, 3],
      [10, 2, 10, 3],
    ]);
    expect(files[1]?.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 });
    expect(files[0]?.hunks[1]?.lines).toEqual([' x();', '+y();', ' z();']);
  });

  it('keeps each file patch self-contained', () => {
    expect(files[0]?.patch.startsWith('diff --git a/src/a.ts b/src/a.ts\n')).toBe(true);
    expect(files[0]?.patch.endsWith(' z();\n')).toBe(true);
    expect(files[0]?.patch.includes('new file.ts')).toBe(false);
  });

  it('returns [] for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});
```

`packages/core/src/git/hunk-select.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './diff-parse.ts';
import { hunkPatch } from './hunk-select.ts';

const PATCH = [
  'diff --git a/a.ts b/a.ts',
  'index 1111111..2222222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,2 +1,2 @@',
  '-one',
  '+ONE',
  ' two',
  '@@ -8,2 +8,2 @@',
  ' eight',
  '-nine',
  '+NINE',
  '',
].join('\n');

describe('hunkPatch', () => {
  const file = parseUnifiedDiff(PATCH)[0];
  if (!file) throw new Error('fixture did not parse');

  it('keeps the header and only the chosen hunk', () => {
    expect(hunkPatch(file, 1)).toBe(
      ['diff --git a/a.ts b/a.ts', 'index 1111111..2222222 100644', '--- a/a.ts', '+++ b/a.ts', '@@ -8,2 +8,2 @@', ' eight', '-nine', '+NINE', ''].join('\n'),
    );
  });

  it('throws for a missing hunk', () => {
    expect(() => hunkPatch(file, 5)).toThrow(/hunk_not_found/);
  });
});
```

`packages/core/src/git/review-prompt.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { buildReviewPrompt } from './review-prompt.ts';

describe('buildReviewPrompt', () => {
  it('orders comments by file and line and indents multi-line bodies', () => {
    const text = buildReviewPrompt(
      [
        { file: 'src/b.ts', line: 4, side: 'new', body: 'rename this' },
        { file: 'src/a.ts', line: 20, side: 'old', body: 'why was this removed?\nit is used by the job' },
        { file: 'src/a.ts', line: 3, side: 'new', body: 'add a test' },
      ],
      { branch: 'feat/SAF-1-x' },
    );
    expect(text).toBe(
      [
        'Review feedback on your changes (branch feat/SAF-1-x). Address every comment below, keep the changes minimal, run the relevant tests, then reply with a short summary per comment.',
        '',
        '1. src/a.ts:3',
        '   add a test',
        '2. src/a.ts:20 (removed line)',
        '   why was this removed?',
        '   it is used by the job',
        '3. src/b.ts:4',
        '   rename this',
      ].join('\n'),
    );
  });

  it('works without a branch', () => {
    expect(buildReviewPrompt([{ file: 'a', line: 1, side: 'new', body: 'x' }]).startsWith('Review feedback on your changes. ')).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run packages/core/src/git`
Expected: FAIL for the three new files (modules not found); Task 2 tests still pass.

- [ ] **Step 3: Implement**

`packages/core/src/git/diff-parse.ts`
```ts
import type { DiffFileEntry, DiffHunk } from '../types/index.ts';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, '');
}

function parseSection(lines: string[]): DiffFileEntry {
  const header = lines[0] ?? '';
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
  let oldPath: string | null = m?.[1] ?? null;
  let path = m?.[2] ?? '';
  let status: DiffFileEntry['status'] = 'modified';
  let renamed = false;
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let current: DiffHunk | null = null;

  for (const line of lines.slice(1)) {
    if (current) {
      const hm = HUNK_RE.exec(line);
      if (hm) {
        current = pushHunk(hunks, line, hm);
        continue;
      }
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
      current.lines.push(line);
      continue;
    }
    const hm = HUNK_RE.exec(line);
    if (hm) {
      current = pushHunk(hunks, line, hm);
    } else if (line.startsWith('new file mode')) status = 'added';
    else if (line.startsWith('deleted file mode')) status = 'deleted';
    else if (line.startsWith('rename from ')) {
      oldPath = line.slice('rename from '.length);
      renamed = true;
    } else if (line.startsWith('rename to ')) path = line.slice('rename to '.length);
    else if (line.startsWith('Binary files ')) status = 'binary';
    else if (line.startsWith('+++ ') && line !== '+++ /dev/null') path = stripPrefix(line.slice(4));
    else if (line.startsWith('--- ') && line !== '--- /dev/null') oldPath = stripPrefix(line.slice(4));
  }
  if (renamed && status === 'modified') status = 'renamed';
  const body = lines.join('\n');
  return {
    path,
    oldPath: status === 'renamed' ? oldPath : null,
    status,
    additions,
    deletions,
    patch: `${body}\n`,
    hunks,
  };
}

function pushHunk(hunks: DiffHunk[], line: string, hm: RegExpExecArray): DiffHunk {
  const h: DiffHunk = {
    header: line,
    oldStart: Number(hm[1]),
    oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
    newStart: Number(hm[3]),
    newLines: hm[4] === undefined ? 1 : Number(hm[4]),
    lines: [],
  };
  hunks.push(h);
  return h;
}

export function parseUnifiedDiff(patch: string): DiffFileEntry[] {
  if (patch.trim() === '') return [];
  const all = patch.replace(/\r\n/g, '\n').split('\n');
  if (all[all.length - 1] === '') all.pop();
  const sections: string[][] = [];
  for (const line of all) {
    if (line.startsWith('diff --git ')) sections.push([line]);
    else sections[sections.length - 1]?.push(line);
  }
  return sections.map(parseSection);
}
```

`packages/core/src/git/hunk-select.ts`
```ts
import type { DiffFileEntry } from '../types/index.ts';

export function hunkPatch(file: DiffFileEntry, hunkIndex: number): string {
  const hunk = file.hunks[hunkIndex];
  if (!hunk) throw new Error(`hunk_not_found: ${file.path}#${hunkIndex}`);
  const lines = file.patch.split('\n');
  const firstHunk = lines.findIndex((l) => l.startsWith('@@ '));
  const header = firstHunk === -1 ? lines : lines.slice(0, firstHunk);
  return `${[...header, hunk.header, ...hunk.lines].join('\n')}\n`;
}
```

`packages/core/src/git/review-prompt.ts`
```ts
import type { ReviewComment } from '../types/index.ts';

export function buildReviewPrompt(comments: ReviewComment[], opts: { branch?: string | null } = {}): string {
  const sorted = [...comments].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  const where = opts.branch ? ` (branch ${opts.branch})` : '';
  const out = [
    `Review feedback on your changes${where}. Address every comment below, keep the changes minimal, run the relevant tests, then reply with a short summary per comment.`,
    '',
  ];
  sorted.forEach((c, i) => {
    const suffix = c.side === 'old' ? ' (removed line)' : '';
    out.push(`${i + 1}. ${c.file}:${c.line}${suffix}`);
    for (const bodyLine of c.body.trim().split('\n')) out.push(`   ${bodyLine}`);
  });
  return out.join('\n');
}
```

Append to `packages/core/src/git/index.ts`:
```ts
export * from './diff-parse.ts';
export * from './hunk-select.ts';
export * from './review-prompt.ts';
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/core/src/git`
Expected: PASS (22 tests in `src/git`).

- [ ] **Step 5: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add packages/core/src/git
git commit -m "feat(core): parse unified diffs, select hunks and build review prompts"
```

---
### Task 4: git/gh exec layer with a force guard, plus test fixtures (temp repos, fake gh, stubs)

**Files:**
- Create: `apps/daemon/src/services/git/exec.ts`
- Create: `apps/daemon/test/git-fixture.ts`, `apps/daemon/test/fake-gh.ts`, `apps/daemon/test/bin/gh` (executable), `apps/daemon/test/stubs.ts`, `apps/daemon/test/fake-pty.ts`
- Test: `apps/daemon/src/services/git/exec.test.ts`
- Modify: `apps/daemon/package.json` (add `execa` if Phase 1 did not)

**Interfaces:**
- Consumes: `PtyManager`, `PtyInfo` (§7), `SessionService`, `InboxEngine`, `InboxUpsert`, `TemplateRegistry`, `AuditService` (§11), `Session`, `InboxItem`, `AuditEntry` (§4)
- Produces:
  ```ts
  // apps/daemon/src/services/git/exec.ts
  export class GitError extends Error { readonly code: string; readonly stderr: string }
  export interface ExecResult { stdout: string; stderr: string; exitCode: number }
  export function assertSafeGitArgs(args: readonly string[]): void          // throws GitError('forbidden_git_args')
  export function git(cwd: string, args: readonly string[], opts?: { env?: Record<string, string>; input?: string; allowFail?: boolean }): Promise<ExecResult>
  export function gitOut(cwd: string, args: readonly string[], opts?: { env?: Record<string, string>; input?: string }): Promise<string>
  export function gh(args: readonly string[], opts?: { cwd?: string; input?: string }): Promise<ExecResult>
  export function repoRoot(dir: string): Promise<string | null>
  export function mainCheckoutOf(dir: string): Promise<string | null>
  // apps/daemon/test/git-fixture.ts
  export function isolateGitEnv(): void
  export interface TempRepo { root: string; dir: string; remote: string | null; git(...args: string[]): string; write(rel: string, content: string): void; read(rel: string): string; exists(rel: string): boolean; commitAll(message: string): string; cleanup(): void }
  export function makeTempRepo(opts?: { withRemote?: boolean }): TempRepo
  // apps/daemon/test/fake-gh.ts
  export interface FakePr { repo: string; number: number; url: string; title: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; reviewRequested?: boolean; headRefName: string; baseRefName: string; body: string; updatedAt: string; reviewDecision: '' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'; statusCheckRollup: Array<{ __typename: 'CheckRun'; name: string; status: string; conclusion: string } | { __typename: 'StatusContext'; context: string; state: string }> }
  export interface FakeGhState { authed: boolean; repo: string; nextNumber: number; prs: Record<string, FakePr> }
  export interface FakeGh { dir: string; state(): FakeGhState; setState(patch: Partial<FakeGhState>): void; setPr(pr: FakePr): void; calls(): string[][]; restore(): void }
  export function useFakeGh(initial?: Partial<FakeGhState>): FakeGh
  // apps/daemon/test/stubs.ts
  export function makeSession(p: Partial<Session> & { id: string }): Session
  export function stubSessions(sessions: Session[], opts?: { onResume?: (id: string) => void }): SessionService & { sessions: Session[] }
  export function recordingInbox(): InboxEngine & { upserts: InboxUpsert[]; resolved: string[]; rules: InboxRule[] }
  export function stubTemplates(): TemplateRegistry
  export function memoryAudit(): AuditService & { entries: AuditEntry[] }
  // apps/daemon/test/fake-pty.ts
  export function recordingPty(): PtyManager & { spawned: Array<Parameters<PtyManager['spawn']>[0]>; texts: Array<{ id: string; text: string }>; writes: Array<{ id: string; data: string }> }
  ```

- [ ] **Step 1: Write the test fixtures**

`apps/daemon/test/git-fixture.ts`
```ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function isolateGitEnv(): void {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_NAME = 'Orc Test';
  process.env.GIT_AUTHOR_EMAIL = 'orc-test@example.com';
  process.env.GIT_COMMITTER_NAME = 'Orc Test';
  process.env.GIT_COMMITTER_EMAIL = 'orc-test@example.com';
  process.env.GIT_TERMINAL_PROMPT = '0';
}

export interface TempRepo {
  root: string;
  dir: string;
  remote: string | null;
  git(...args: string[]): string;
  write(rel: string, content: string): void;
  read(rel: string): string;
  exists(rel: string): boolean;
  commitAll(message: string): string;
  cleanup(): void;
}

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function makeTempRepo(opts: { withRemote?: boolean } = {}): TempRepo {
  isolateGitEnv();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orc-git-')));
  const dir = join(root, 'repo');
  mkdirSync(dir);
  run(dir, ['init', '-b', 'main']);
  run(dir, ['config', 'user.name', 'Orc Test']);
  run(dir, ['config', 'user.email', 'orc-test@example.com']);
  run(dir, ['config', 'commit.gpgsign', 'false']);
  const write = (rel: string, content: string) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  write('README.md', '# temp\n');
  write('src/a.ts', 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  write('.gitignore', '.env\nnode_modules/\n.worktrees/\n');
  run(dir, ['add', '-A']);
  run(dir, ['commit', '-m', 'initial']);
  let remote: string | null = null;
  if (opts.withRemote) {
    remote = join(root, 'remote.git');
    run(root, ['init', '--bare', '-b', 'main', remote]);
    run(dir, ['remote', 'add', 'origin', remote]);
    run(dir, ['push', '-u', 'origin', 'main']);
  }
  return {
    root,
    dir,
    remote,
    git: (...args) => run(dir, args),
    write,
    read: (rel) => readFileSync(join(dir, rel), 'utf8'),
    exists: (rel) => existsSync(join(dir, rel)),
    commitAll: (message) => {
      run(dir, ['add', '-A']);
      run(dir, ['commit', '-m', message]);
      return run(dir, ['rev-parse', 'HEAD']).trim();
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
```

`apps/daemon/test/bin/gh` (then `chmod +x apps/daemon/test/bin/gh`)
```js
#!/usr/bin/env node
// Fake GitHub CLI for tests. State lives in $FAKE_GH_DIR/state.json; every call is appended to calls.jsonl.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_GH_DIR;
if (!dir) {
  process.stderr.write('FAKE_GH_DIR not set\n');
  process.exit(3);
}
const args = process.argv.slice(2);
appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify(args)}\n`);
const statePath = join(dir, 'state.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const has = (name) => args.includes(name);
const fail = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};
const keyOf = (ref) => {
  const repo = flag('--repo') ?? state.repo;
  const m = /\/pull\/(\d+)/.exec(ref);
  const number = m ? Number(m[1]) : Number(ref);
  const urlRepo = /github\.com\/([^/]+\/[^/]+)\/pull/.exec(ref);
  return `${urlRepo ? urlRepo[1] : repo}#${number}`;
};

const [cmd, sub] = args;
if (cmd === 'auth' && sub === 'status') {
  if (!state.authed) fail('You are not logged into any GitHub hosts.');
  process.stdout.write('Logged in to github.com as tester\n');
  process.exit(0);
}
if (!state.authed) fail('gh: not authenticated', 4);

if (cmd === 'repo' && sub === 'view') {
  process.stdout.write(`${JSON.stringify({ nameWithOwner: state.repo })}\n`);
  process.exit(0);
}
if (cmd === 'pr' && sub === 'view') {
  const pr = state.prs[keyOf(args[2] ?? '')];
  if (!pr) fail('no pull requests found');
  process.stdout.write(`${JSON.stringify(pr)}\n`);
  process.exit(0);
}
if (cmd === 'search' && sub === 'prs') {
  const wantReview = has('--review-requested=@me');
  const open = Object.values(state.prs)
    .filter((p) => p.state === 'OPEN' && Boolean(p.reviewRequested) === wantReview)
    .map((p) => ({ number: p.number, url: p.url, title: p.title, updatedAt: p.updatedAt, repository: { nameWithOwner: p.repo } }));
  process.stdout.write(`${JSON.stringify(open)}\n`);
  process.exit(0);
}
if (cmd === 'pr' && sub === 'create') {
  const number = state.nextNumber;
  state.nextNumber += 1;
  const bodyFile = flag('--body-file');
  const pr = {
    repo: state.repo,
    number,
    url: `https://github.com/${state.repo}/pull/${number}`,
    title: flag('--title') ?? '',
    state: 'OPEN',
    headRefName: flag('--head') ?? '',
    baseRefName: flag('--base') ?? 'main',
    body: bodyFile ? readFileSync(bodyFile, 'utf8') : (flag('--body') ?? ''),
    draft: has('--draft'),
    updatedAt: new Date().toISOString(),
    reviewDecision: 'REVIEW_REQUIRED',
    statusCheckRollup: [],
  };
  state.prs[`${state.repo}#${number}`] = pr;
  save();
  process.stdout.write(`${pr.url}\n`);
  process.exit(0);
}
if (cmd === 'pr' && sub === 'merge') {
  if (has('--admin')) fail('--admin is not allowed in tests', 5);
  const key = keyOf(args[2] ?? '');
  const pr = state.prs[key];
  if (!pr) fail('no pull requests found');
  if (pr.state !== 'OPEN') fail('pull request is not open');
  pr.state = 'MERGED';
  pr.updatedAt = new Date().toISOString();
  save();
  process.exit(0);
}
fail(`fake gh: unsupported command ${args.join(' ')}`, 2);
```

`apps/daemon/test/fake-gh.ts`
```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FakePr {
  repo: string;
  number: number;
  url: string;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  /** true = someone else's PR that requests my review (returned only by `search prs --review-requested=@me`) */
  reviewRequested?: boolean;
  headRefName: string;
  baseRefName: string;
  body: string;
  updatedAt: string;
  reviewDecision: '' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
  statusCheckRollup: Array<
    | { __typename: 'CheckRun'; name: string; status: string; conclusion: string }
    | { __typename: 'StatusContext'; context: string; state: string }
  >;
}
export interface FakeGhState { authed: boolean; repo: string; nextNumber: number; prs: Record<string, FakePr> }
export interface FakeGh {
  dir: string;
  state(): FakeGhState;
  setState(patch: Partial<FakeGhState>): void;
  setPr(pr: FakePr): void;
  calls(): string[][];
  restore(): void;
}

const BIN = fileURLToPath(new URL('./bin', import.meta.url));

export function useFakeGh(initial: Partial<FakeGhState> = {}): FakeGh {
  const dir = mkdtempSync(join(tmpdir(), 'orc-gh-'));
  const statePath = join(dir, 'state.json');
  const write = (s: FakeGhState) => writeFileSync(statePath, JSON.stringify(s, null, 2));
  write({ authed: true, repo: 'example-org/temp-repo', nextNumber: 101, prs: {}, ...initial });
  writeFileSync(join(dir, 'calls.jsonl'), '');
  const prevPath = process.env.PATH;
  const prevDir = process.env.FAKE_GH_DIR;
  process.env.PATH = `${BIN}${delimiter}${prevPath ?? ''}`;
  process.env.FAKE_GH_DIR = dir;
  const read = (): FakeGhState => JSON.parse(readFileSync(statePath, 'utf8')) as FakeGhState;
  return {
    dir,
    state: read,
    setState: (patch) => write({ ...read(), ...patch }),
    setPr: (pr) => {
      const s = read();
      s.prs[`${pr.repo}#${pr.number}`] = pr;
      write(s);
    },
    calls: () =>
      readFileSync(join(dir, 'calls.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as string[]),
    restore: () => {
      process.env.PATH = prevPath;
      if (prevDir === undefined) delete process.env.FAKE_GH_DIR;
      else process.env.FAKE_GH_DIR = prevDir;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
```

`apps/daemon/test/fake-pty.ts`
```ts
import type { PtyInfo, PtyManager } from '../src/pty/pty-manager.ts';

type SpawnOpts = Parameters<PtyManager['spawn']>[0];

export function recordingPty(): PtyManager & {
  spawned: SpawnOpts[];
  texts: Array<{ id: string; text: string }>;
  writes: Array<{ id: string; data: string }>;
} {
  const infos = new Map<string, PtyInfo>();
  const spawned: SpawnOpts[] = [];
  const texts: Array<{ id: string; text: string }> = [];
  const writes: Array<{ id: string; data: string }> = [];
  let n = 0;
  return {
    spawned,
    texts,
    writes,
    spawn(opts) {
      spawned.push(opts);
      n += 1;
      const info: PtyInfo = {
        id: `pty-${n}`,
        sessionPk: opts.sessionPk ?? null,
        command: opts.command,
        args: opts.args,
        cwd: opts.cwd,
        pid: 10_000 + n,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
        cols: opts.cols ?? 120,
        rows: opts.rows ?? 36,
      };
      infos.set(info.id, info);
      return info;
    },
    write(id, data) {
      writes.push({ id, data });
    },
    async sendText(id, text) {
      texts.push({ id, text });
    },
    resize() {},
    kill(id) {
      const info = infos.get(id);
      if (info) infos.set(id, { ...info, exitedAt: new Date().toISOString(), exitCode: 0 });
    },
    attach() {
      return { scrollback: '', detach() {} };
    },
    list: () => [...infos.values()],
    get: (id) => infos.get(id),
  };
}
```

`apps/daemon/test/stubs.ts`
```ts
import { randomUUID } from 'node:crypto';
import { emptyUsage } from '@orc/core';
import type { AuditEntry, InboxItem, Session } from '@orc/core';
import type { InboxEngine, InboxRule, InboxUpsert } from '../src/inbox/engine.ts';
import type { AuditService } from '../src/services/audit/audit.ts';
import { type SessionService, sessionPk } from '../src/services/sessions.ts';
import type { TemplateRegistry } from '../src/services/templates.ts';

export function makeSession(p: Partial<Session> & { id: string }): Session {
  const now = '2026-09-17T10:00:00.000Z';
  return {
    source: 'claude',
    projectId: 'wakecap',
    startCwd: '/tmp',
    cwds: [p.startCwd ?? '/tmp'],
    name: null,
    firstPrompt: null,
    lastPrompt: null,
    awaySummary: null,
    recap: null,
    startedAt: now,
    lastActivityAt: now,
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
    ...p,
  };
}

export function stubSessions(sessions: Session[], opts: { onResume?: (id: string) => void } = {}): SessionService & { sessions: Session[] } {
  const byPk = (pk: string) => sessions.find((s) => sessionPk(s.source, s.id) === pk) ?? null;
  return {
    sessions,
    list: () => ({
      items: sessions.map((s) => ({
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
        durationMs: 0,
        costUsd: s.usage.costUsd,
        tickets: s.tickets,
        prs: s.prs,
        availability: s.availability,
        pinned: false,
        labels: [],
        live: s.live,
        snippet: null,
      })),
      nextCursor: null,
    }),
    get: (source, id) => sessions.find((s) => s.source === source && s.id === id) ?? null,
    getByPk: byPk,
    events: () => ({ items: [], nextSeq: null }),
    agents: () => [],
    setLive: (pk, live) => {
      const s = byPk(pk);
      if (s) s.live = live;
    },
    resume: async (_source, id) => {
      opts.onResume?.(id);
      return { ptyId: `pty-resume-${id}` };
    },
  };
}

export function recordingInbox(): InboxEngine & { upserts: InboxUpsert[]; resolved: string[]; rules: InboxRule[] } {
  const upserts: InboxUpsert[] = [];
  const resolved: string[] = [];
  const rules: InboxRule[] = [];
  const items = new Map<string, InboxItem>();
  const toItem = (u: InboxUpsert): InboxItem => ({
    id: items.get(u.dedupeKey)?.id ?? randomUUID(),
    kind: u.kind,
    sessionId: u.sessionId ?? null,
    projectId: u.projectId ?? null,
    ticket: u.ticket ?? null,
    reason: u.reason,
    dedupeKey: u.dedupeKey,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: 'open',
    snoozeUntil: null,
    payload: u.payload ?? {},
  });
  const find = (id: string) => {
    const it = [...items.values()].find((i) => i.id === id);
    if (!it) throw new Error('not_found');
    return it;
  };
  return {
    upserts,
    resolved,
    rules,
    upsert(u) {
      upserts.push(u);
      const item = toItem(u);
      items.set(u.dedupeKey, item);
      return item;
    },
    resolve(key) {
      resolved.push(key);
      const it = items.get(key);
      if (it) items.set(key, { ...it, state: 'auto_resolved' });
    },
    list: (f) => [...items.values()].filter((i) => !f.state || f.state.includes(i.state)).filter((i) => !f.kind || f.kind.includes(i.kind)),
    markDone: (id) => ({ ...find(id), state: 'done' }),
    snooze: (id, until) => ({ ...find(id), state: 'snoozed', snoozeUntil: until }),
    reopen: (id) => ({ ...find(id), state: 'open' }),
    registerRule: (r) => {
      rules.push(r);
    },
  };
}

export function stubTemplates(): TemplateRegistry {
  const prompts: Record<string, string> = {
    backmerge: '/backmerge {{ticket}}',
    'preset-fix-ci': 'Fix the failing CI check {{check}} on {{prUrl}}',
    'preset-address-comments': 'Address the review comments on {{prUrl}}',
  };
  return {
    list: () =>
      Object.entries(prompts).map(([id, prompt]) => ({
        id,
        kind: id.startsWith('preset-') ? ('preset' as const) : ('workflow' as const),
        label: id,
        prompt,
        vars: [],
        defaultSource: 'claude' as const,
        projectIds: 'all' as const,
      })),
    render: (id, vars) => {
      const tpl = prompts[id];
      if (tpl === undefined) throw new Error(`unknown template ${id}`);
      return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');
    },
  };
}

export function memoryAudit(): AuditService & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    record(e) {
      const full: AuditEntry = { ...e, id: randomUUID(), ts: new Date().toISOString() };
      entries.push(full);
      return full;
    },
    list: (f) => entries.filter((e) => !f.action || e.action === f.action),
  };
}
```

- [ ] **Step 2: Write the failing exec test**

`apps/daemon/src/services/git/exec.test.ts`
```ts
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isolateGitEnv, makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { useFakeGh, type FakeGh } from '../../../test/fake-gh.ts';
import { GitError, assertSafeGitArgs, gh, git, gitOut, mainCheckoutOf, repoRoot } from './exec.ts';

beforeAll(() => isolateGitEnv());

describe('assertSafeGitArgs', () => {
  it.each([
    [['push', '--force']],
    [['push', '-f', 'origin', 'x']],
    [['push', '--force-with-lease']],
    [['push', 'origin', '+main']],
    [['push', 'origin', '--delete', 'main']],
    [['push', '--mirror']],
    [['reset', '--hard', 'HEAD~1']],
    [['clean', '-fd']],
    [['worktree', 'remove', '--force', '/x']],
    [['checkout', '--', '.']],
    [['branch', '-D', 'x']],
    [['stash', 'push']],
    [['update-ref', 'refs/heads/main', 'abc']],
  ])('refuses %j', (args) => {
    expect(() => assertSafeGitArgs(args)).toThrow(GitError);
  });

  it.each([
    [['push', '-u', 'origin', 'HEAD']],
    [['worktree', 'remove', '/x']],
    [['update-ref', 'refs/orchestrator/checkpoints/s/1', 'abc']],
    [['update-ref', '-d', 'refs/orchestrator/checkpoints/s/1']],
    [['stash', 'list']],
    [['status', '--porcelain']],
  ])('allows %j', (args) => {
    expect(() => assertSafeGitArgs(args)).not.toThrow();
  });
});

describe('git helpers in a temp repo', () => {
  let repo: TempRepo;
  afterEach(() => repo.cleanup());

  it('runs git and resolves roots', async () => {
    repo = makeTempRepo();
    expect(await gitOut(repo.dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(await repoRoot(`${repo.dir}/src`)).toBe(repo.dir);
    expect(await repoRoot(repo.root)).toBeNull();
    repo.git('worktree', 'add', '-b', 'feat/x', `${repo.root}/wt`, 'main');
    expect(await mainCheckoutOf(`${repo.root}/wt`)).toBe(repo.dir);
  });

  it('throws GitError with stderr on failure unless allowFail', async () => {
    repo = makeTempRepo();
    await expect(gitOut(repo.dir, ['rev-parse', 'nope'])).rejects.toMatchObject({ code: 'git_failed' });
    const r = await git(repo.dir, ['rev-parse', 'nope'], { allowFail: true });
    expect(r.exitCode).not.toBe(0);
  });

  it('refuses a force push before spawning', async () => {
    repo = makeTempRepo();
    await expect(git(repo.dir, ['push', '--force'])).rejects.toMatchObject({ code: 'forbidden_git_args' });
  });
});

describe('gh', () => {
  let fake: FakeGh;
  afterEach(() => fake.restore());

  it('uses the fake gh on PATH', async () => {
    fake = useFakeGh({ authed: false });
    const r = await gh(['auth', 'status']);
    expect(r.exitCode).toBe(1);
    expect(fake.calls()).toEqual([['auth', 'status']]);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `chmod +x apps/daemon/test/bin/gh && pnpm vitest run apps/daemon/src/services/git`
Expected: FAIL, `Cannot find module './exec.ts'`

- [ ] **Step 4: Implement `exec.ts`**

`apps/daemon/src/services/git/exec.ts`
```ts
import { execa } from 'execa';

export class GitError extends Error {
  readonly code: string;
  readonly stderr: string;
  constructor(code: string, message: string, stderr = '') {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr;
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const PUSH_FORBIDDEN = new Set(['--force', '-f', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '-d', '--prune']);

export function assertSafeGitArgs(args: readonly string[]): void {
  const [cmd, ...rest] = args;
  const deny = (why: string) => {
    throw new GitError('forbidden_git_args', `refused git ${args.join(' ')}: ${why}`);
  };
  if (cmd === 'push') {
    for (const a of rest) {
      if (PUSH_FORBIDDEN.has(a) || a.startsWith('--force') || a.startsWith('+') || a.includes(':+')) deny('force or destructive push');
      if (a.startsWith(':')) deny('ref deletion');
    }
  }
  if (cmd === 'reset' && rest.includes('--hard')) deny('hard reset');
  if (cmd === 'clean') deny('git clean');
  if (cmd === 'worktree' && rest[0] === 'remove' && (rest.includes('--force') || rest.includes('-f'))) deny('forced worktree removal');
  if (cmd === 'checkout' && rest.includes('--')) deny('checkout of paths discards changes; use restore with a checkpoint');
  if (cmd === 'branch' && (rest.includes('-D') || rest.includes('--delete') || rest.includes('-d'))) deny('branch deletion');
  if (cmd === 'stash' && rest[0] !== 'list') deny('stash is never touched');
  if (cmd === 'update-ref') {
    const ref = rest.find((a) => !a.startsWith('-'));
    if (!ref?.startsWith('refs/orchestrator/')) deny('only refs/orchestrator/* may be updated');
  }
}

const BASE_ENV = { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };

export async function git(
  cwd: string,
  args: readonly string[],
  opts: { env?: Record<string, string>; input?: string; allowFail?: boolean } = {},
): Promise<ExecResult> {
  assertSafeGitArgs(args);
  const r = await execa('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    reject: false,
    stripFinalNewline: false,
    env: { ...BASE_ENV, ...opts.env },
    ...(opts.input === undefined ? {} : { input: opts.input }),
  });
  const res: ExecResult = { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), exitCode: r.exitCode ?? 1 };
  if (res.exitCode !== 0 && !opts.allowFail) {
    throw new GitError('git_failed', `git ${args[0] ?? ''} failed: ${res.stderr.trim()}`, res.stderr);
  }
  return res;
}

export async function gitOut(cwd: string, args: readonly string[], opts: { env?: Record<string, string>; input?: string } = {}): Promise<string> {
  const r = await git(cwd, args, opts);
  return r.stdout.replace(/\n$/, '');
}

export async function gh(args: readonly string[], opts: { cwd?: string; input?: string } = {}): Promise<ExecResult> {
  try {
    const r = await execa('gh', [...args], {
      reject: false,
      env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      ...(opts.input === undefined ? {} : { input: opts.input }),
    });
    return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), exitCode: r.exitCode ?? 1 };
  } catch (err) {
    throw new GitError('gh_unavailable', `gh could not be started: ${(err as Error).message}`);
  }
}

export async function repoRoot(dir: string): Promise<string | null> {
  try {
    const r = await git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

export async function mainCheckoutOf(dir: string): Promise<string | null> {
  const r = await git(dir, ['worktree', 'list', '--porcelain'], { allowFail: true }).catch(() => null);
  if (!r || r.exitCode !== 0) return null;
  const first = r.stdout.split('\n').find((l) => l.startsWith('worktree '));
  return first ? first.slice('worktree '.length) : null;
}
```
`repoRoot` on a non-existent `cwd` makes execa throw (spawn `ENOENT` on cwd); the `try/catch` returns `null` in that case.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run apps/daemon/src/services/git`
Expected: PASS (23 tests). On macOS `tmpdir()` is a symlink under `/var`; `makeTempRepo` uses `realpathSync`, so `repoRoot` matches.

- [ ] **Step 6: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon/src/services/git apps/daemon/test apps/daemon/package.json pnpm-lock.yaml
git update-index --chmod=+x apps/daemon/test/bin/gh
git commit -m "feat(daemon): add guarded git/gh exec layer and phase 4 test fixtures"
```

---
### Task 5: Tables `worktrees`, `checkpoints`, `pr_cache` and their repos

**Files:**
- Modify: `apps/daemon/src/db/schema.ts`
- Create: `apps/daemon/src/db/migrations/<generated>_phase4.sql` (drizzle-kit output), `apps/daemon/src/db/repos/worktrees.ts`, `apps/daemon/src/db/repos/checkpoints.ts`, `apps/daemon/src/db/repos/pr-cache.ts`
- Test: `apps/daemon/src/db/repos/phase4.test.ts`

**Interfaces:**
- Consumes: `openDb(file)` and `OrcDb` (§5), `WorktreeView`, `CheckpointRecord`, `PrStatus` (Task 1)
- Produces:
  ```ts
  // repos/worktrees.ts
  export type WorktreeRow = Omit<WorktreeView, 'prStatus'> & { createdAt: string; archivedAt: string | null }
  export function upsertWorktree(db: OrcDb, w: WorktreeRow): void
  export function getWorktree(db: OrcDb, path: string): WorktreeRow | null
  export function listWorktrees(db: OrcDb, f?: { projectId?: string; state?: 'active' | 'archived'; repo?: string }): WorktreeRow[]
  export function markWorktreeArchived(db: OrcDb, path: string, at: string): void
  // repos/checkpoints.ts
  export type CheckpointInsert = CheckpointRecord & { sessionPk: string }
  export function insertCheckpoint(db: OrcDb, c: CheckpointInsert): void
  export function getCheckpoint(db: OrcDb, id: string): CheckpointInsert | null
  export function listCheckpoints(db: OrcDb, sessionPk: string): CheckpointInsert[]              // oldest first
  export function listCheckpointsForWorktree(db: OrcDb, worktreePath: string): CheckpointInsert[]
  export function deleteCheckpoint(db: OrcDb, id: string): void
  // repos/pr-cache.ts
  export function upsertPrStatus(db: OrcDb, s: PrStatus, fetchedAt: string): void
  export function getPrStatus(db: OrcDb, repo: string, number: number): PrStatus | null
  export function findPrByHead(db: OrcDb, headRef: string, repo?: string | null): PrStatus | null   // most recently updated
  export function listPrStatuses(db: OrcDb, f?: { state?: PrStatus['state'] }): PrStatus[]
  ```

- [ ] **Step 1: Write the failing repo test**

`apps/daemon/src/db/repos/phase4.test.ts`
```ts
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrStatus } from '@orc/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type OrcDb } from '../client.ts';
import { deleteCheckpoint, getCheckpoint, insertCheckpoint, listCheckpoints, listCheckpointsForWorktree } from './checkpoints.ts';
import { findPrByHead, getPrStatus, listPrStatuses, upsertPrStatus } from './pr-cache.ts';
import { getWorktree, listWorktrees, markWorktreeArchived, upsertWorktree, type WorktreeRow } from './worktrees.ts';

let dir: string;
let db: OrcDb;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orc-db4-'));
  const opened = openDb(join(dir, 'index.db'));
  db = opened.db;
  close = opened.close;
});
afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const row = (p: Partial<WorktreeRow> = {}): WorktreeRow => ({
  path: '/r/.worktrees/feat-SAF-1-x',
  repo: '/r',
  branch: 'feat/SAF-1-x',
  base: 'main',
  ticket: 'SAF-1',
  dirty: false,
  prUrl: null,
  state: 'active',
  createdByApp: true,
  head: 'abc',
  isMain: false,
  origin: 'app',
  sessionPks: ['claude:s1'],
  projectId: 'wakecap',
  updatedAt: '2026-09-17T10:00:00.000Z',
  createdAt: '2026-09-17T09:00:00.000Z',
  archivedAt: null,
  ...p,
});

const pr = (p: Partial<PrStatus> = {}): PrStatus => ({
  pr: { repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7' },
  state: 'open',
  title: 'SAF-1 x',
  checks: 'pending',
  review: 'review_required',
  updatedAt: '2026-09-17T10:00:00Z',
  headRef: 'feat/SAF-1-x',
  failedChecks: [],
  ...p,
});

describe('worktrees repo', () => {
  it('upserts, reads, filters and archives', () => {
    upsertWorktree(db, row());
    upsertWorktree(db, row({ path: '/r', branch: 'main', isMain: true, origin: 'config', createdByApp: false, ticket: null, sessionPks: [] }));
    upsertWorktree(db, row({ dirty: true, sessionPks: ['claude:s1', 'claude:s2'] }));
    expect(getWorktree(db, '/r/.worktrees/feat-SAF-1-x')).toMatchObject({ dirty: true, sessionPks: ['claude:s1', 'claude:s2'] });
    expect(listWorktrees(db, { repo: '/r' })).toHaveLength(2);
    markWorktreeArchived(db, '/r/.worktrees/feat-SAF-1-x', '2026-09-18T00:00:00.000Z');
    expect(listWorktrees(db, { state: 'active' }).map((w) => w.path)).toEqual(['/r']);
    expect(getWorktree(db, '/r/.worktrees/feat-SAF-1-x')?.archivedAt).toBe('2026-09-18T00:00:00.000Z');
    expect(getWorktree(db, '/missing')).toBeNull();
  });
});

describe('checkpoints repo', () => {
  it('inserts and lists in creation order', () => {
    const base = { sessionPk: 'claude:s1', sessionId: 's1', worktreePath: '/r/wt', commit: 'c', kind: 'turn' as const };
    insertCheckpoint(db, { ...base, id: 'b', turn: 2, ref: 'refs/orchestrator/checkpoints/s1/2', createdAt: '2026-09-17T10:02:00.000Z' });
    insertCheckpoint(db, { ...base, id: 'a', turn: 1, ref: 'refs/orchestrator/checkpoints/s1/1', createdAt: '2026-09-17T10:01:00.000Z' });
    expect(listCheckpoints(db, 'claude:s1').map((c) => c.id)).toEqual(['a', 'b']);
    expect(listCheckpointsForWorktree(db, '/r/wt')).toHaveLength(2);
    expect(getCheckpoint(db, 'a')?.ref).toBe('refs/orchestrator/checkpoints/s1/1');
    expect(() =>
      insertCheckpoint(db, { ...base, id: 'c', turn: 1, ref: 'refs/orchestrator/checkpoints/s1/1', createdAt: '2026-09-17T10:03:00.000Z' }),
    ).toThrow();
    deleteCheckpoint(db, 'a');
    expect(getCheckpoint(db, 'a')).toBeNull();
  });
});

describe('pr_cache repo', () => {
  it('upserts and finds by head', () => {
    upsertPrStatus(db, pr(), '2026-09-17T10:00:01Z');
    upsertPrStatus(db, pr({ checks: 'failure', failedChecks: ['build'] }), '2026-09-17T10:01:31Z');
    expect(getPrStatus(db, 'o/r', 7)).toMatchObject({ checks: 'failure', failedChecks: ['build'] });
    expect(findPrByHead(db, 'feat/SAF-1-x')?.pr.number).toBe(7);
    expect(findPrByHead(db, 'feat/SAF-1-x', 'other/repo')).toBeNull();
    expect(listPrStatuses(db, { state: 'merged' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/db/repos/phase4.test.ts`
Expected: FAIL, `Cannot find module './checkpoints.ts'`

- [ ] **Step 3: Add the tables to the schema**

Append to `apps/daemon/src/db/schema.ts` (the file already imports `sqliteTable`, `text`, `integer`, `index`, `uniqueIndex` from `drizzle-orm/sqlite-core`; add any that are missing):
```ts
export const worktrees = sqliteTable(
  'worktrees',
  {
    path: text('path').primaryKey(),
    repo: text('repo').notNull(),
    branch: text('branch').notNull(),
    base: text('base'),
    ticket: text('ticket'),
    dirty: integer('dirty', { mode: 'boolean' }).notNull().default(false),
    prUrl: text('pr_url'),
    state: text('state', { enum: ['active', 'archived'] }).notNull().default('active'),
    createdByApp: integer('created_by_app', { mode: 'boolean' }).notNull().default(false),
    head: text('head'),
    isMain: integer('is_main', { mode: 'boolean' }).notNull().default(false),
    origin: text('origin').notNull(),
    sessionPksJson: text('session_pks_json').notNull().default('[]'),
    projectId: text('project_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    archivedAt: text('archived_at'),
  },
  (t) => [index('worktrees_repo_idx').on(t.repo), index('worktrees_branch_idx').on(t.branch)],
);

export const checkpoints = sqliteTable(
  'checkpoints',
  {
    id: text('id').primaryKey(),
    sessionPk: text('session_pk').notNull(),
    sessionId: text('session_id').notNull(),
    worktreePath: text('worktree_path').notNull(),
    turn: integer('turn').notNull(),
    ref: text('ref').notNull(),
    commit: text('commit').notNull(),
    kind: text('kind', { enum: ['turn', 'safety', 'manual'] }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('checkpoints_ref_uq').on(t.ref),
    index('checkpoints_session_idx').on(t.sessionPk),
    index('checkpoints_worktree_idx').on(t.worktreePath),
  ],
);

export const prCache = sqliteTable(
  'pr_cache',
  {
    key: text('key').primaryKey(),
    repo: text('repo').notNull(),
    number: integer('number').notNull(),
    url: text('url').notNull(),
    state: text('state', { enum: ['open', 'closed', 'merged'] }).notNull(),
    title: text('title').notNull(),
    checks: text('checks', { enum: ['pending', 'success', 'failure', 'none'] }).notNull(),
    review: text('review', { enum: ['approved', 'changes_requested', 'review_required', 'none'] }).notNull(),
    headRef: text('head_ref'),
    failedChecksJson: text('failed_checks_json').notNull().default('[]'),
    updatedAt: text('updated_at').notNull(),
    fetchedAt: text('fetched_at').notNull(),
  },
  (t) => [index('pr_cache_head_idx').on(t.headRef)],
);
```

Run: `pnpm --filter @orc/daemon db:generate --name phase4`
Expected: a new SQL file in `apps/daemon/src/db/migrations/` containing `CREATE TABLE \`worktrees\``, `CREATE TABLE \`checkpoints\``, `CREATE TABLE \`pr_cache\`` and the four indexes.

- [ ] **Step 4: Implement the repos**

`apps/daemon/src/db/repos/worktrees.ts`
```ts
import type { WorktreeOrigin, WorktreeView } from '@orc/core';
import { and, asc, eq, type SQL } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { worktrees } from '../schema.ts';

export type WorktreeRow = Omit<WorktreeView, 'prStatus'> & { createdAt: string; archivedAt: string | null };

type Db = typeof worktrees.$inferSelect;

function fromDb(r: Db): WorktreeRow {
  return {
    path: r.path,
    repo: r.repo,
    branch: r.branch,
    base: r.base,
    ticket: r.ticket,
    dirty: r.dirty,
    prUrl: r.prUrl,
    state: r.state,
    createdByApp: r.createdByApp,
    head: r.head,
    isMain: r.isMain,
    origin: r.origin as WorktreeOrigin,
    sessionPks: JSON.parse(r.sessionPksJson) as string[],
    projectId: r.projectId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    archivedAt: r.archivedAt,
  };
}

export function upsertWorktree(db: OrcDb, w: WorktreeRow): void {
  const values = {
    path: w.path,
    repo: w.repo,
    branch: w.branch,
    base: w.base,
    ticket: w.ticket,
    dirty: w.dirty,
    prUrl: w.prUrl,
    state: w.state,
    createdByApp: w.createdByApp,
    head: w.head,
    isMain: w.isMain,
    origin: w.origin,
    sessionPksJson: JSON.stringify(w.sessionPks),
    projectId: w.projectId,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    archivedAt: w.archivedAt,
  };
  const { path: _path, createdAt: _createdAt, ...update } = values;
  db.insert(worktrees).values(values).onConflictDoUpdate({ target: worktrees.path, set: update }).run();
}

export function getWorktree(db: OrcDb, path: string): WorktreeRow | null {
  const r = db.select().from(worktrees).where(eq(worktrees.path, path)).get();
  return r ? fromDb(r) : null;
}

export function listWorktrees(db: OrcDb, f: { projectId?: string; state?: 'active' | 'archived'; repo?: string } = {}): WorktreeRow[] {
  const conds: SQL[] = [];
  if (f.projectId) conds.push(eq(worktrees.projectId, f.projectId));
  if (f.state) conds.push(eq(worktrees.state, f.state));
  if (f.repo) conds.push(eq(worktrees.repo, f.repo));
  return db
    .select()
    .from(worktrees)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(worktrees.repo), asc(worktrees.path))
    .all()
    .map(fromDb);
}

export function markWorktreeArchived(db: OrcDb, path: string, at: string): void {
  db.update(worktrees).set({ state: 'archived', archivedAt: at, updatedAt: at, dirty: false }).where(eq(worktrees.path, path)).run();
}
```

`apps/daemon/src/db/repos/checkpoints.ts`
```ts
import type { CheckpointRecord } from '@orc/core';
import { asc, eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { checkpoints } from '../schema.ts';

export type CheckpointInsert = CheckpointRecord & { sessionPk: string };

const toRec = (r: typeof checkpoints.$inferSelect): CheckpointInsert => ({
  id: r.id,
  sessionPk: r.sessionPk,
  sessionId: r.sessionId,
  worktreePath: r.worktreePath,
  turn: r.turn,
  ref: r.ref,
  commit: r.commit,
  kind: r.kind,
  createdAt: r.createdAt,
});

export function insertCheckpoint(db: OrcDb, c: CheckpointInsert): void {
  db.insert(checkpoints).values(c).run();
}

export function getCheckpoint(db: OrcDb, id: string): CheckpointInsert | null {
  const r = db.select().from(checkpoints).where(eq(checkpoints.id, id)).get();
  return r ? toRec(r) : null;
}

export function listCheckpoints(db: OrcDb, sessionPk: string): CheckpointInsert[] {
  return db.select().from(checkpoints).where(eq(checkpoints.sessionPk, sessionPk)).orderBy(asc(checkpoints.createdAt)).all().map(toRec);
}

export function listCheckpointsForWorktree(db: OrcDb, worktreePath: string): CheckpointInsert[] {
  return db
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.worktreePath, worktreePath))
    .orderBy(asc(checkpoints.createdAt))
    .all()
    .map(toRec);
}

export function deleteCheckpoint(db: OrcDb, id: string): void {
  db.delete(checkpoints).where(eq(checkpoints.id, id)).run();
}
```

`apps/daemon/src/db/repos/pr-cache.ts`
```ts
import type { PrStatus } from '@orc/core';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { prCache } from '../schema.ts';

const toStatus = (r: typeof prCache.$inferSelect): PrStatus => ({
  pr: { repo: r.repo, number: r.number, url: r.url },
  state: r.state,
  title: r.title,
  checks: r.checks,
  review: r.review,
  updatedAt: r.updatedAt,
  headRef: r.headRef,
  failedChecks: JSON.parse(r.failedChecksJson) as string[],
});

export function upsertPrStatus(db: OrcDb, s: PrStatus, fetchedAt: string): void {
  const values = {
    key: `${s.pr.repo}#${s.pr.number}`,
    repo: s.pr.repo,
    number: s.pr.number,
    url: s.pr.url,
    state: s.state,
    title: s.title,
    checks: s.checks,
    review: s.review,
    headRef: s.headRef,
    failedChecksJson: JSON.stringify(s.failedChecks),
    updatedAt: s.updatedAt,
    fetchedAt,
  };
  const { key: _key, ...update } = values;
  db.insert(prCache).values(values).onConflictDoUpdate({ target: prCache.key, set: update }).run();
}

export function getPrStatus(db: OrcDb, repo: string, number: number): PrStatus | null {
  const r = db.select().from(prCache).where(eq(prCache.key, `${repo}#${number}`)).get();
  return r ? toStatus(r) : null;
}

export function findPrByHead(db: OrcDb, headRef: string, repo?: string | null): PrStatus | null {
  const conds: SQL[] = [eq(prCache.headRef, headRef)];
  if (repo) conds.push(eq(prCache.repo, repo));
  const r = db.select().from(prCache).where(and(...conds)).orderBy(desc(prCache.updatedAt)).get();
  return r ? toStatus(r) : null;
}

export function listPrStatuses(db: OrcDb, f: { state?: PrStatus['state'] } = {}): PrStatus[] {
  return db
    .select()
    .from(prCache)
    .where(f.state ? eq(prCache.state, f.state) : undefined)
    .orderBy(desc(prCache.updatedAt))
    .all()
    .map(toStatus);
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run apps/daemon/src/db/repos/phase4.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon/src/db
git commit -m "feat(daemon): add worktrees, checkpoints and pr_cache tables"
```

---
### Task 6: Worktree discovery sources and resolution

**Files:**
- Create: `apps/daemon/src/services/worktree/sources.ts`, `apps/daemon/src/services/worktree/discover.ts`
- Test: `apps/daemon/src/services/worktree/discover.test.ts`

**Interfaces:**
- Consumes: `DaemonContext` (`config()`, `paths.claudeHome`, `sessions.list`, `sessions.getByPk`), `parseWorktreePorcelain` (Task 2), `git`, `mainCheckoutOf` (Task 4), `WorktreeOrigin` (Task 1)
- Produces:
  ```ts
  // sources.ts
  export interface RepoCandidate { dir: string; origin: WorktreeOrigin; worktreeDir: string }
  export function claudeJsonPath(claudeHome: string): string                 // <dirname(claudeHome)>/.claude.json
  export function readGithubRepoPaths(file: string): string[]                // ONLY the githubRepoPaths key
  export function findGitFileDirs(root: string, opts: { maxDepth: number; namePrefix?: string; maxDirs?: number }): string[]
  export async function collectCandidates(ctx: DaemonContext, opts?: { claudeJson?: string; now?: Date }): Promise<RepoCandidate[]>
  // discover.ts
  export interface DiscoveredWorktree { path: string; repo: string; branch: string; head: string | null; isMain: boolean; origin: WorktreeOrigin; prunable: boolean; locked: boolean; detached: boolean }
  export async function resolveWorktrees(candidates: RepoCandidate[], opts?: { scratchpadRoots?: string[] }): Promise<DiscoveredWorktree[]>
  ```

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/services/worktree/discover.test.ts`
```ts
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { makeSession, stubSessions } from '../../../test/stubs.ts';
import { resolveWorktrees } from './discover.ts';
import { collectCandidates, findGitFileDirs, readGithubRepoPaths } from './sources.ts';

let repo: TempRepo;
afterEach(() => repo.cleanup());

function setup() {
  repo = makeTempRepo();
  const other = makeTempRepo();
  // worktree inside .worktrees
  repo.git('worktree', 'add', '-b', 'feat/SAF-1-inside', join(repo.dir, '.worktrees', 'feat-SAF-1-inside'), 'main');
  // sibling worktree next to the main checkout
  repo.git('worktree', 'add', '-b', 'fix/SAF-2-sibling', join(repo.root, 'repo-sibling'), 'main');
  // scratchpad worktree
  const scratchRoot = join(repo.root, 'tmp');
  const scratchWt = join(scratchRoot, 'claude-501', '-Users-test-Wakecap', 'uuid-1', 'scratchpad', 'wt');
  mkdirSync(join(scratchWt, '..'), { recursive: true });
  repo.git('worktree', 'add', '--detach', scratchWt, 'main');
  // a stale folder in .worktrees that git no longer knows
  mkdirSync(join(repo.dir, '.worktrees', 'stale'), { recursive: true });
  writeFileSync(join(repo.dir, '.worktrees', 'stale', '.git'), 'gitdir: /nowhere/at/all\n');
  // ~/.claude.json with an auth-looking key that must be ignored
  const claudeJson = join(repo.root, 'claude.json');
  writeFileSync(
    claudeJson,
    JSON.stringify({ oauthAccount: { emailAddress: 'x@example.com' }, githubRepoPaths: { 'o/other': [other.dir, '/does/not/exist'] } }),
  );
  const cfg = OrcConfig.parse({
    projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root], repos: [{ path: repo.dir }] }],
    worktrees: { scratchpadRoots: [scratchRoot] },
  });
  const sessions = stubSessions([makeSession({ id: 's1', startCwd: join(other.dir, 'src'), cwds: [join(other.dir, 'src')] })]);
  const ctx = createTestContext({ config: () => cfg, sessions });
  return { ctx, claudeJson, other, scratchRoot, scratchWt: realpathSync(scratchWt) };
}

describe('readGithubRepoPaths', () => {
  it('returns only the githubRepoPaths values', () => {
    const { claudeJson, other } = setup();
    expect(readGithubRepoPaths(claudeJson)).toEqual([other.dir, '/does/not/exist']);
    other.cleanup();
  });

  it('returns [] when the file is missing or malformed', () => {
    repo = makeTempRepo();
    expect(readGithubRepoPaths(join(repo.root, 'nope.json'))).toEqual([]);
    writeFileSync(join(repo.root, 'bad.json'), '{not json');
    expect(readGithubRepoPaths(join(repo.root, 'bad.json'))).toEqual([]);
  });
});

describe('findGitFileDirs', () => {
  it('finds linked worktrees under claude-* folders only', () => {
    const { scratchRoot, scratchWt, other } = setup();
    mkdirSync(join(scratchRoot, 'unrelated', 'x'), { recursive: true });
    writeFileSync(join(scratchRoot, 'unrelated', 'x', '.git'), 'gitdir: /x\n');
    expect(findGitFileDirs(scratchRoot, { maxDepth: 6, namePrefix: 'claude-' })).toEqual([scratchWt]);
    other.cleanup();
  });
});

describe('collectCandidates + resolveWorktrees', () => {
  it('discovers config, worktree-dir, sibling, scratchpad, claude-json and session repos', async () => {
    const { ctx, claudeJson, other, scratchRoot, scratchWt } = setup();
    const candidates = await collectCandidates(ctx, { claudeJson });
    const found = await resolveWorktrees(candidates, { scratchpadRoots: [scratchRoot] });
    const byPath = Object.fromEntries(found.map((w) => [w.path, w]));

    expect(byPath[repo.dir]).toMatchObject({ isMain: true, origin: 'config', branch: 'main', repo: repo.dir });
    expect(byPath[join(repo.dir, '.worktrees', 'feat-SAF-1-inside')]).toMatchObject({ origin: 'worktree-dir', branch: 'feat/SAF-1-inside', repo: repo.dir });
    expect(byPath[join(repo.root, 'repo-sibling')]).toMatchObject({ origin: 'sibling', branch: 'fix/SAF-2-sibling' });
    expect(byPath[scratchWt]).toMatchObject({ origin: 'scratchpad', detached: true, branch: '(detached)' });
    expect(byPath[other.dir]).toMatchObject({ isMain: true, origin: 'claude-json' });
    expect(found.some((w) => w.path.endsWith('stale'))).toBe(false);
    expect(found.filter((w) => w.path === other.dir)).toHaveLength(1);
    other.cleanup();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/worktree/discover.test.ts`
Expected: FAIL, `Cannot find module './discover.ts'`

- [ ] **Step 3: Implement the sources**

`apps/daemon/src/services/worktree/sources.ts`
```ts
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorktreeOrigin } from '@orc/core';
import type { DaemonContext } from '../../context.ts';

export interface RepoCandidate {
  dir: string;
  origin: WorktreeOrigin;
  worktreeDir: string;
}

const DAY_MS = 86_400_000;

export function claudeJsonPath(claudeHome: string): string {
  return join(dirname(claudeHome), '.claude.json');
}

/** Reads ~/.claude.json and keeps ONLY `githubRepoPaths`. Nothing else is returned, stored or logged. */
export function readGithubRepoPaths(file: string): string[] {
  let picked: unknown;
  try {
    picked = (JSON.parse(readFileSync(file, 'utf8')) as { githubRepoPaths?: unknown }).githubRepoPaths;
  } catch {
    return [];
  }
  if (!picked || typeof picked !== 'object') return [];
  const out: string[] = [];
  for (const value of Object.values(picked as Record<string, unknown>)) {
    if (Array.isArray(value)) for (const p of value) if (typeof p === 'string') out.push(p);
  }
  return out;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function hasGitFile(dir: string): boolean {
  try {
    return statSync(join(dir, '.git')).isFile();
  } catch {
    return false;
  }
}

/** Breadth-first walk that returns folders whose `.git` is a file (linked worktrees). Does not descend into them. */
export function findGitFileDirs(root: string, opts: { maxDepth: number; namePrefix?: string; maxDirs?: number }): string[] {
  if (!isDir(root)) return [];
  const found: string[] = [];
  const maxDirs = opts.maxDirs ?? 5000;
  let visited = 0;
  const queue: Array<{ dir: string; depth: number }> = [];
  for (const name of readdirSync(root)) {
    if (opts.namePrefix && !name.startsWith(opts.namePrefix)) continue;
    const p = join(root, name);
    if (isDir(p)) queue.push({ dir: p, depth: 1 });
  }
  while (queue.length > 0 && visited < maxDirs) {
    const next = queue.shift();
    if (!next) break;
    visited++;
    if (hasGitFile(next.dir)) {
      found.push(realpathSync(next.dir));
      continue;
    }
    if (next.depth >= opts.maxDepth) continue;
    let names: string[] = [];
    try {
      names = readdirSync(next.dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = join(next.dir, name);
      if (isDir(p)) queue.push({ dir: p, depth: next.depth + 1 });
    }
  }
  return found.sort();
}

export async function collectCandidates(ctx: DaemonContext, opts: { claudeJson?: string; now?: Date } = {}): Promise<RepoCandidate[]> {
  const cfg = ctx.config();
  const out: RepoCandidate[] = [];
  const add = (dir: string, origin: WorktreeOrigin, worktreeDir = '.worktrees') => {
    if (existsSync(dir)) out.push({ dir: realpathSync(dir), origin, worktreeDir });
  };

  const configRepos = cfg.projects.flatMap((p) => p.repos);
  for (const r of configRepos) add(r.path, 'config', r.worktreeDir);

  for (const r of configRepos) {
    const wtRoot = join(r.path, r.worktreeDir);
    if (!isDir(wtRoot)) continue;
    for (const name of readdirSync(wtRoot)) add(join(wtRoot, name), 'worktree-dir', r.worktreeDir);
  }

  if (cfg.worktrees.scanSiblings) {
    for (const r of configRepos) {
      const parent = dirname(r.path);
      if (!isDir(parent)) continue;
      for (const name of readdirSync(parent)) {
        const p = join(parent, name);
        if (hasGitFile(p)) add(p, 'sibling');
      }
    }
  }

  for (const root of cfg.worktrees.scratchpadRoots) {
    for (const dir of findGitFileDirs(root, { maxDepth: 6, namePrefix: 'claude-' })) add(dir, 'scratchpad');
  }

  for (const p of readGithubRepoPaths(opts.claudeJson ?? claudeJsonPath(ctx.paths.claudeHome))) add(p, 'claude-json');

  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const seen = new Set<string>();
  for (const item of ctx.sessions.list({ from, limit: 300 }).items) {
    const s = ctx.sessions.getByPk(item.pk);
    for (const cwd of s?.cwds ?? []) {
      if (seen.has(cwd)) continue;
      seen.add(cwd);
      add(cwd, 'session-cwd');
    }
  }
  return out;
}
```

- [ ] **Step 4: Implement the resolution**

`apps/daemon/src/services/worktree/discover.ts`
```ts
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { parseWorktreePorcelain, type WorktreeOrigin } from '@orc/core';
import { git, mainCheckoutOf } from '../git/exec.ts';
import type { RepoCandidate } from './sources.ts';

export interface DiscoveredWorktree {
  path: string;
  repo: string;
  branch: string;
  head: string | null;
  isMain: boolean;
  origin: WorktreeOrigin;
  prunable: boolean;
  locked: boolean;
  detached: boolean;
}

const PRIORITY: WorktreeOrigin[] = ['app', 'config', 'worktree-dir', 'sibling', 'scratchpad', 'claude-json', 'session-cwd'];
const better = (a: WorktreeOrigin, b: WorktreeOrigin) => (PRIORITY.indexOf(a) <= PRIORITY.indexOf(b) ? a : b);
const under = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

export async function resolveWorktrees(candidates: RepoCandidate[], opts: { scratchpadRoots?: string[] } = {}): Promise<DiscoveredWorktree[]> {
  const mainByDir = new Map<string, string | null>();
  const repos = new Map<string, { origin: WorktreeOrigin; worktreeDir: string }>();
  const exactOrigin = new Map<string, WorktreeOrigin>();

  for (const c of candidates) {
    exactOrigin.set(c.dir, exactOrigin.has(c.dir) ? better(exactOrigin.get(c.dir) as WorktreeOrigin, c.origin) : c.origin);
    let main = mainByDir.get(c.dir);
    if (main === undefined) {
      main = await mainCheckoutOf(c.dir);
      if (main !== null && existsSync(main)) main = realpathSync(main);
      mainByDir.set(c.dir, main);
    }
    if (main === null) continue;
    const prev = repos.get(main);
    const originForRepo: WorktreeOrigin = c.dir === main || c.origin === 'config' ? c.origin : prev?.origin ?? c.origin;
    repos.set(main, {
      origin: prev ? better(prev.origin, originForRepo) : originForRepo,
      worktreeDir: c.origin === 'config' ? c.worktreeDir : (prev?.worktreeDir ?? c.worktreeDir),
    });
  }

  const out: DiscoveredWorktree[] = [];
  const scratchRoots = opts.scratchpadRoots ?? [];
  for (const [main, info] of repos) {
    const r = await git(main, ['worktree', 'list', '--porcelain'], { allowFail: true });
    if (r.exitCode !== 0) continue;
    for (const e of parseWorktreePorcelain(r.stdout)) {
      if (e.bare) continue;
      const path = existsSync(e.path) ? realpathSync(e.path) : e.path;
      const isMain = path === main;
      let origin: WorktreeOrigin;
      const exact = exactOrigin.get(path);
      if (isMain) origin = info.origin;
      else if (under(path, join(main, info.worktreeDir))) origin = 'worktree-dir';
      else if (scratchRoots.some((root) => under(path, root))) origin = 'scratchpad';
      else if (dirname(path) === dirname(main)) origin = 'sibling';
      else origin = exact ?? info.origin;
      if (e.prunable && !existsSync(path)) continue;
      out.push({
        path,
        repo: main,
        branch: e.branch ?? '(detached)',
        head: e.head,
        isMain,
        origin,
        prunable: e.prunable,
        locked: e.locked,
        detached: e.detached,
      });
    }
  }
  return out;
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run apps/daemon/src/services/worktree/discover.test.ts`
Expected: PASS (4 tests). The `other` repo is found through `claude.json` and through the session cwd; it appears once with origin `claude-json` because that source ranks higher than `session-cwd`.

- [ ] **Step 6: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon/src/services/worktree
git commit -m "feat(daemon): discover worktrees from config, sessions, claude.json and scratchpads"
```

---
### Task 7: WorktreeService read side — discover, persist, link, list

**Files:**
- Create: `apps/daemon/src/services/worktree/worktree-read.ts`
- Test: `apps/daemon/src/services/worktree/worktree-read.test.ts`

**Interfaces:**
- Consumes: `collectCandidates`, `resolveWorktrees` (Task 6); `upsertWorktree`, `getWorktree`, `listWorktrees`, `markWorktreeArchived`, `findPrByHead`, `getPrStatus` (Task 5); `ticketFromBranch`, `parseStatusPorcelainZ` (Task 2); `git` (Task 4); `ctx.projects.resolve/get`, `ctx.sessions.list/getByPk`, `ctx.bus.emit` (§6, §11)
- Produces:
  ```ts
  export interface WorktreeDeps { ctx: DaemonContext; now: () => Date; claudeJson?: string; opener?: (command: string, args: string[]) => Promise<void> }
  export async function dirtyFiles(path: string): Promise<string[]>
  export function toView(d: WorktreeDeps, row: WorktreeRow): WorktreeView
  export async function discoverWorktrees(d: WorktreeDeps): Promise<WorktreeView[]>
  export function listWorktreeViews(d: WorktreeDeps, f?: { projectId?: string; state?: 'active' | 'archived'; repo?: string }): WorktreeView[]
  export function getWorktreeView(d: WorktreeDeps, path: string): WorktreeView | null
  export function findWorktreeByCwd(d: WorktreeDeps, cwd: string): WorktreeView | null
  export function prRepoSlug(prUrl: string | null): { repo: string; number: number } | null
  ```

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/services/worktree/worktree-read.test.ts`
```ts
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import type { LiveEvent } from '@orc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { makeSession, stubSessions } from '../../../test/stubs.ts';
import { upsertPrStatus } from '../../db/repos/pr-cache.ts';
import { getWorktree, upsertWorktree } from '../../db/repos/worktrees.ts';
import type { ProjectService } from '../projects.ts';
import { discoverWorktrees, findWorktreeByCwd, getWorktreeView, listWorktreeViews, prRepoSlug, type WorktreeDeps } from './worktree-read.ts';

let repo: TempRepo;
afterEach(() => repo.cleanup());

function setup() {
  repo = makeTempRepo();
  const wt = join(repo.dir, '.worktrees', 'feat-SAF-9-thing');
  repo.git('worktree', 'add', '-b', 'feat/SAF-9-thing', wt, 'main');
  const cfg = OrcConfig.parse({
    projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root], ticketRegex: '\\bSAF-\\d+\\b', repos: [{ path: repo.dir }] }],
    worktrees: { scratchpadRoots: [], scanSiblings: false },
  });
  const projects: ProjectService = {
    list: () => [],
    resolve: (cwd) => (cwd.startsWith(repo.root) ? 'wakecap' : null),
    get: (id) => (id === 'wakecap' ? (cfg.projects[0] ?? null) : null),
    update: () => {
      throw new Error('unused');
    },
  };
  const sessions = stubSessions([
    makeSession({ id: 'in-wt', startCwd: join(wt, 'src'), cwds: [join(wt, 'src')] }),
    makeSession({ id: 'in-main', startCwd: repo.dir, cwds: [repo.dir] }),
  ]);
  const ctx = createTestContext({ config: () => cfg, sessions, projects });
  const events: LiveEvent[] = [];
  ctx.bus.on('worktree.updated', (e) => events.push(e));
  ctx.bus.on('worktree.removed', (e) => events.push(e));
  const d: WorktreeDeps = { ctx, now: () => new Date('2026-09-17T10:00:00.000Z'), claudeJson: join(repo.root, 'none.json') };
  return { ctx, d, wt, events };
}

describe('discoverWorktrees', () => {
  it('persists views with ticket, project, dirty state and linked sessions', async () => {
    const { d, wt, events } = setup();
    repo.write('.worktrees/feat-SAF-9-thing/src/a.ts', 'changed\n');
    const views = await discoverWorktrees(d);
    const view = views.find((v) => v.path === wt);
    expect(view).toMatchObject({
      repo: repo.dir, branch: 'feat/SAF-9-thing', ticket: 'SAF-9', projectId: 'wakecap', dirty: true,
      createdByApp: false, origin: 'worktree-dir', sessionPks: ['claude:in-wt'], state: 'active',
    });
    expect(views.find((v) => v.isMain)?.sessionPks).toEqual(['claude:in-main']);
    expect(events.filter((e) => e.type === 'worktree.updated')).toHaveLength(2);

    await discoverWorktrees(d);
    expect(events.filter((e) => e.type === 'worktree.updated')).toHaveLength(2);
  });

  it('keeps app ownership and base, and links a cached PR by branch', async () => {
    const { ctx, d, wt } = setup();
    upsertWorktree(ctx.db, {
      path: wt, repo: repo.dir, branch: 'feat/SAF-9-thing', base: 'main', ticket: 'SAF-9', dirty: false, prUrl: null,
      state: 'active', createdByApp: true, head: null, isMain: false, origin: 'app', sessionPks: [], projectId: 'wakecap',
      createdAt: '2026-09-17T09:00:00.000Z', updatedAt: '2026-09-17T09:00:00.000Z', archivedAt: null,
    });
    upsertPrStatus(ctx.db, {
      pr: { repo: 'o/r', number: 5, url: 'https://github.com/o/r/pull/5' }, state: 'open', title: 't', checks: 'success',
      review: 'approved', updatedAt: '2026-09-17T09:30:00Z', headRef: 'feat/SAF-9-thing', failedChecks: [],
    }, '2026-09-17T09:30:00Z');
    await discoverWorktrees(d);
    const v = getWorktreeView(d, wt);
    expect(v).toMatchObject({ createdByApp: true, base: 'main', origin: 'app', prUrl: 'https://github.com/o/r/pull/5' });
    expect(v?.prStatus?.checks).toBe('success');
  });

  it('archives rows whose folder disappeared and emits worktree.removed', async () => {
    const { ctx, d, wt, events } = setup();
    await discoverWorktrees(d);
    repo.git('worktree', 'remove', wt);
    await discoverWorktrees(d);
    expect(getWorktree(ctx.db, wt)?.state).toBe('archived');
    expect(events.some((e) => e.type === 'worktree.removed' && e.path === wt)).toBe(true);
    expect(listWorktreeViews(d, { state: 'active' }).map((v) => v.path)).toEqual([repo.dir]);
  });
});

describe('findWorktreeByCwd', () => {
  it('picks the longest active worktree prefix', async () => {
    const { d, wt } = setup();
    await discoverWorktrees(d);
    expect(findWorktreeByCwd(d, join(wt, 'src'))?.path).toBe(wt);
    expect(findWorktreeByCwd(d, join(repo.dir, 'src'))?.path).toBe(repo.dir);
    expect(findWorktreeByCwd(d, '/elsewhere')).toBeNull();
  });
});

describe('prRepoSlug', () => {
  it('parses GitHub PR URLs', () => {
    expect(prRepoSlug('https://github.com/o/r/pull/5')).toEqual({ repo: 'o/r', number: 5 });
    expect(prRepoSlug(null)).toBeNull();
    expect(prRepoSlug('https://example.com/x')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/worktree/worktree-read.test.ts`
Expected: FAIL, `Cannot find module './worktree-read.ts'`

- [ ] **Step 3: Implement**

`apps/daemon/src/services/worktree/worktree-read.ts`
```ts
import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { parseStatusPorcelainZ, ticketFromBranch, type WorktreeView } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { findPrByHead, getPrStatus } from '../../db/repos/pr-cache.ts';
import { getWorktree, listWorktrees, markWorktreeArchived, upsertWorktree, type WorktreeRow } from '../../db/repos/worktrees.ts';
import { git } from '../git/exec.ts';
import { resolveWorktrees } from './discover.ts';
import { collectCandidates } from './sources.ts';

export interface WorktreeDeps {
  ctx: DaemonContext;
  now: () => Date;
  claudeJson?: string;
  /** Launches IDE/Terminal/Finder; defaults to execa in Task 8. Injected in tests. */
  opener?: (command: string, args: string[]) => Promise<void>;
}

const DAY_MS = 86_400_000;
const under = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);

export function prRepoSlug(prUrl: string | null): { repo: string; number: number } | null {
  if (!prUrl) return null;
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(prUrl);
  return m?.[1] && m[2] ? { repo: m[1], number: Number(m[2]) } : null;
}

export async function dirtyFiles(path: string): Promise<string[]> {
  const r = await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { allowFail: true });
  if (r.exitCode !== 0) return [];
  return parseStatusPorcelainZ(r.stdout).map((e) => e.path);
}

export function toView(d: WorktreeDeps, row: WorktreeRow): WorktreeView {
  const slug = prRepoSlug(row.prUrl);
  const prStatus = slug
    ? getPrStatus(d.ctx.db, slug.repo, slug.number)
    : row.isMain
      ? null
      : findPrByHead(d.ctx.db, row.branch);
  const { createdAt: _c, archivedAt: _a, ...view } = row;
  return { ...view, prUrl: row.prUrl ?? prStatus?.pr.url ?? null, prStatus };
}

function sessionLinks(d: WorktreeDeps, paths: string[]): Map<string, string[]> {
  const links = new Map<string, string[]>(paths.map((p) => [p, []]));
  const from = new Date(d.now().getTime() - 30 * DAY_MS).toISOString();
  for (const item of d.ctx.sessions.list({ from, limit: 300 }).items) {
    const s = d.ctx.sessions.getByPk(item.pk);
    if (!s) continue;
    const hit = new Set<string>();
    for (const cwd of s.cwds) {
      const best = paths.filter((p) => under(cwd, p)).sort((a, b) => b.length - a.length)[0];
      if (best) hit.add(best);
    }
    for (const p of hit) links.get(p)?.push(item.pk);
  }
  return links;
}

const fingerprint = (v: WorktreeView) =>
  JSON.stringify([v.branch, v.head, v.dirty, v.state, v.ticket, v.prUrl, v.sessionPks, v.createdByApp, v.origin, v.prStatus?.updatedAt ?? null]);

export async function discoverWorktrees(d: WorktreeDeps): Promise<WorktreeView[]> {
  const { ctx } = d;
  const cfg = ctx.config();
  const candidates = await collectCandidates(ctx, { ...(d.claudeJson ? { claudeJson: d.claudeJson } : {}), now: d.now() });
  const found = await resolveWorktrees(candidates, { scratchpadRoots: cfg.worktrees.scratchpadRoots });
  const links = sessionLinks(d, found.map((f) => f.path));
  const nowIso = d.now().toISOString();
  const seen = new Set<string>();
  const views: WorktreeView[] = [];

  for (const f of found) {
    seen.add(f.path);
    const prev = getWorktree(ctx.db, f.path);
    const before = prev ? toView(d, prev) : null;
    const projectId = ctx.projects.resolve(f.path);
    const regex = projectId ? (ctx.projects.get(projectId)?.ticketRegex ?? null) : null;
    const linked = links.get(f.path) ?? [];
    const sessionPrUrl = f.isMain
      ? null
      : (linked.map((pk) => ctx.sessions.getByPk(pk)).flatMap((s) => s?.prs ?? [])[0]?.url ?? null);
    const row: WorktreeRow = {
      path: f.path,
      repo: f.repo,
      branch: f.branch,
      base: prev?.base ?? null,
      ticket: f.isMain ? null : ticketFromBranch(f.branch, regex),
      dirty: (await dirtyFiles(f.path)).length > 0,
      prUrl: prev?.prUrl ?? (f.isMain ? null : (findPrByHead(ctx.db, f.branch)?.pr.url ?? sessionPrUrl)),
      state: 'active',
      createdByApp: prev?.createdByApp ?? false,
      head: f.head,
      isMain: f.isMain,
      origin: prev?.createdByApp ? 'app' : f.origin,
      sessionPks: linked,
      projectId,
      createdAt: prev?.createdAt ?? nowIso,
      updatedAt: nowIso,
      archivedAt: null,
    };
    const view = toView(d, row);
    if (!before || fingerprint(before) !== fingerprint(view)) {
      upsertWorktree(ctx.db, row);
      ctx.bus.emit({ type: 'worktree.updated', worktree: view });
    }
    views.push(view);
  }

  for (const row of listWorktrees(ctx.db, { state: 'active' })) {
    if (seen.has(row.path) || existsSync(row.path)) continue;
    markWorktreeArchived(ctx.db, row.path, nowIso);
    ctx.bus.emit({ type: 'worktree.removed', path: row.path });
  }
  return views;
}

export function listWorktreeViews(d: WorktreeDeps, f: { projectId?: string; state?: 'active' | 'archived'; repo?: string } = {}): WorktreeView[] {
  return listWorktrees(d.ctx.db, f).map((r) => toView(d, r));
}

export function getWorktreeView(d: WorktreeDeps, path: string): WorktreeView | null {
  const r = getWorktree(d.ctx.db, path);
  return r ? toView(d, r) : null;
}

export function findWorktreeByCwd(d: WorktreeDeps, cwd: string): WorktreeView | null {
  const best = listWorktrees(d.ctx.db, { state: 'active' })
    .filter((r) => under(cwd, r.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return best ? toView(d, best) : null;
}
```
Note: when an unchanged row is skipped, its `updatedAt` is not bumped; that keeps the `worktree.updated` stream quiet.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/daemon/src/services/worktree`
Expected: PASS (Task 6 tests plus 5 new tests).

- [ ] **Step 5: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon/src/services/worktree
git commit -m "feat(daemon): persist discovered worktrees with tickets, sessions and PR links"
```

---
### Task 8: WorktreeService write side — create, scripts, open

**Files:**
- Create: `apps/daemon/src/services/git/audit.ts`, `apps/daemon/src/services/worktree/glob.ts`, `apps/daemon/src/services/worktree/worktree-write.ts`
- Test: `apps/daemon/src/services/worktree/worktree-write.test.ts`

**Interfaces:**
- Consumes: `WorktreeDeps`, `toView`, `getWorktreeView` (Task 7); `branchName`, `worktreeDirName` (Task 2); `git`, `gitOut`, `mainCheckoutOf`, `GitError` (Task 4); `upsertWorktree` (Task 5); `audited(audit, meta, fn)` (P3); `ctx.pty.spawn` (§7); `CreateWorktreeInput` (§11)
- Produces:
  ```ts
  // services/git/audit.ts
  export function auditOf(ctx: DaemonContext): AuditService                       // throws if Phase 3 audit is missing
  export function runAudited<T>(ctx: DaemonContext, actor: AuditActor, action: string, target: string | null, params: Record<string, unknown>, fn: () => Promise<T>): Promise<T>
  // services/worktree/glob.ts
  export function globToRegExp(glob: string): RegExp
  // services/worktree/worktree-write.ts
  export function repoConfigFor(ctx: DaemonContext, repo: string): ProjectConfig['repos'][number] | null
  export async function createWorktree(d: WorktreeDeps, i: CreateWorktreeInput, opts: { runSetup: boolean; actor: AuditActor }): Promise<{ view: WorktreeView; setupPtyId: string | null }>
  export async function copyIgnoredFiles(mainPath: string, worktreePath: string, globs: string[], worktreeDir: string): Promise<string[]>
  export async function runWorktreeScript(d: WorktreeDeps, path: string, which: 'setup' | 'run' | 'archive', actor: AuditActor): Promise<{ ptyId: string }>
  export async function openWorktree(d: WorktreeDeps, path: string, target: 'vscode' | 'terminal' | 'finder'): Promise<void>
  ```
  `GitError` codes used here: `not_a_worktree`, `worktree_exists` (message includes the existing path), `no_script`.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/services/worktree/worktree-write.test.ts`
```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { memoryAudit, stubSessions } from '../../../test/stubs.ts';
import { getWorktree } from '../../db/repos/worktrees.ts';
import { globToRegExp } from './glob.ts';
import type { WorktreeDeps } from './worktree-read.ts';
import { createWorktree, openWorktree, runWorktreeScript } from './worktree-write.ts';

let repo: TempRepo;
afterEach(() => repo.cleanup());

function setup(repoOverrides: Record<string, unknown> = {}) {
  repo = makeTempRepo();
  repo.write('.gitignore', '.env\nnode_modules/\n.worktrees/\nconfig/*.Development.json\n');
  repo.commitAll('ignore dev settings');
  repo.write('.env', 'API_URL=http://localhost\n');
  repo.write('config/appsettings.Development.json', '{"x":1}\n');
  repo.write('node_modules/big/index.js', 'module.exports = 1;\n');
  const cfg = OrcConfig.parse({
    projects: [{
      id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root],
      repos: [{ path: repo.dir, setup: 'pnpm install', run: 'pnpm dev', copyGlobs: ['.env', 'config/*.Development.json'], ...repoOverrides }],
    }],
  });
  const pty = recordingPty();
  const audit = memoryAudit();
  const opened: Array<[string, string[]]> = [];
  const ctx = createTestContext({ config: () => cfg, pty, audit, sessions: stubSessions([]) });
  const d: WorktreeDeps = {
    ctx,
    now: () => new Date('2026-09-17T10:00:00.000Z'),
    opener: async (c, a) => {
      opened.push([c, a]);
    },
  };
  return { ctx, d, pty, audit, opened };
}

describe('globToRegExp', () => {
  it('handles *, ** and ?', () => {
    expect(globToRegExp('config/*.json').test('config/a.json')).toBe(true);
    expect(globToRegExp('config/*.json').test('config/x/a.json')).toBe(false);
    expect(globToRegExp('**/.env').test('apps/api/.env')).toBe(true);
    expect(globToRegExp('**/.env').test('.env')).toBe(true);
    expect(globToRegExp('file?.txt').test('file1.txt')).toBe(true);
  });
});

describe('createWorktree', () => {
  it('adds the branch in .worktrees, copies ignored files, runs setup and audits', async () => {
    const { ctx, d, pty, audit } = setup();
    const { view, setupPtyId } = await createWorktree(
      d,
      { repo: repo.dir, base: 'main', type: 'feat', ticket: 'saf-12', slug: 'Exclude weekends from SLA' },
      { runSetup: true, actor: 'user' },
    );
    const expected = join(repo.dir, '.worktrees', 'feat-SAF-12-exclude-weekends-sla');
    expect(view).toMatchObject({ path: expected, branch: 'feat/SAF-12-exclude-weekends-sla', base: 'main', ticket: 'SAF-12', createdByApp: true, origin: 'app' });
    expect(readFileSync(join(expected, '.env'), 'utf8')).toBe('API_URL=http://localhost\n');
    expect(existsSync(join(expected, 'config/appsettings.Development.json'))).toBe(true);
    expect(existsSync(join(expected, 'node_modules'))).toBe(false);
    expect(setupPtyId).toBe('pty-1');
    expect(pty.spawned[0]).toMatchObject({ cwd: expected, args: ['-lc', 'pnpm install'] });
    expect(getWorktree(ctx.db, expected)?.createdByApp).toBe(true);
    expect(audit.entries.map((e) => [e.action, e.result])).toEqual([['worktree.create', 'ok']]);
  });

  it('refuses to create a second worktree for the same branch', async () => {
    const { d, audit } = setup();
    const input = { repo: repo.dir, base: 'main', type: 'fix' as const, ticket: 'SAF-3', slug: 'dup' };
    await createWorktree(d, input, { runSetup: false, actor: 'user' });
    await expect(createWorktree(d, input, { runSetup: false, actor: 'user' })).rejects.toMatchObject({ code: 'worktree_exists' });
    expect(audit.entries.at(-1)).toMatchObject({ action: 'worktree.create', result: 'error' });
  });

  it('reuses a branch that /conductor already created', async () => {
    const { d } = setup();
    repo.git('branch', 'feat/SAF-4-by-conductor', 'main');
    const { view } = await createWorktree(d, { repo: repo.dir, base: 'main', type: 'feat', ticket: 'SAF-4', slug: 'by conductor' }, { runSetup: false, actor: 'user' });
    expect(view.branch).toBe('feat/SAF-4-by-conductor');
    expect(repo.git('worktree', 'list')).toContain('feat-SAF-4-by-conductor');
  });

  it('refuses a path that is not a main checkout', async () => {
    const { d } = setup();
    await expect(
      createWorktree(d, { repo: join(repo.dir, 'src'), base: 'main', type: 'feat', ticket: null, slug: 'x' }, { runSetup: false, actor: 'user' }),
    ).rejects.toMatchObject({ code: 'not_a_worktree' });
  });
});

describe('runWorktreeScript and openWorktree', () => {
  it('runs the configured script in a PTY and opens VS Code', async () => {
    const { d, pty, audit, opened } = setup();
    const { view } = await createWorktree(d, { repo: repo.dir, base: 'main', type: 'chore', ticket: null, slug: 'scripts' }, { runSetup: false, actor: 'user' });
    const { ptyId } = await runWorktreeScript(d, view.path, 'run', 'user');
    expect(ptyId).toBe('pty-1');
    expect(pty.spawned[0]?.args).toEqual(['-lc', 'pnpm dev']);
    await expect(runWorktreeScript(d, view.path, 'archive', 'user')).rejects.toMatchObject({ code: 'no_script' });
    await openWorktree(d, view.path, 'vscode');
    expect(opened).toEqual([['code', ['--new-window', view.path]]]);
    expect(audit.entries.map((e) => e.action)).toEqual(['worktree.create', 'worktree.script', 'worktree.script', 'worktree.open']);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/worktree/worktree-write.test.ts`
Expected: FAIL, `Cannot find module './glob.ts'`

- [ ] **Step 3: Implement the audit helper and glob matcher**

`apps/daemon/src/services/git/audit.ts`
```ts
import type { AuditActor } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { type AuditService, audited } from '../audit/audit.ts';

export function auditOf(ctx: DaemonContext): AuditService {
  if (!ctx.audit) throw new Error('audit service missing: Phase 3 must be wired before Phase 4 write paths');
  return ctx.audit;
}

export function runAudited<T>(
  ctx: DaemonContext,
  actor: AuditActor,
  action: string,
  target: string | null,
  params: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  return audited(auditOf(ctx), { actor, actorDetail: null, action, target, params }, fn);
}
```

`apps/daemon/src/services/worktree/glob.ts`
```ts
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
```

- [ ] **Step 4: Implement the write side**

`apps/daemon/src/services/worktree/worktree-write.ts`
```ts
import { cpSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectConfig } from '@orc/api-contract';
import { branchName, parseWorktreePorcelain, worktreeDirName, type AuditActor, type WorktreeView } from '@orc/core';
import { execa } from 'execa';
import type { DaemonContext } from '../../context.ts';
import { getWorktree, upsertWorktree } from '../../db/repos/worktrees.ts';
import { runAudited } from '../git/audit.ts';
import { GitError, git, gitOut, mainCheckoutOf } from '../git/exec.ts';
import type { CreateWorktreeInput } from './worktree.ts';
import { globToRegExp } from './glob.ts';
import { toView, type WorktreeDeps } from './worktree-read.ts';

const shell = () => process.env.SHELL ?? '/bin/zsh';

export function repoConfigFor(ctx: DaemonContext, repo: string): ProjectConfig['repos'][number] | null {
  for (const p of ctx.config().projects) {
    for (const r of p.repos) {
      const real = existsSync(r.path) ? realpathSync(r.path) : r.path;
      if (real === repo) return r;
    }
  }
  return null;
}

export async function copyIgnoredFiles(mainPath: string, worktreePath: string, globs: string[], worktreeDir: string): Promise<string[]> {
  if (globs.length === 0) return [];
  const out = await gitOut(mainPath, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
  const matchers = globs.map(globToRegExp);
  const copied: string[] = [];
  for (const entry of out.split('\0')) {
    if (entry === '') continue;
    const rel = entry.replace(/\/$/, '');
    if (rel === worktreeDir || rel.startsWith(`${worktreeDir}/`)) continue;
    if (!matchers.some((m) => m.test(rel))) continue;
    const dst = join(worktreePath, rel);
    if (existsSync(dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(join(mainPath, rel), dst, { recursive: true, errorOnExist: false, force: false });
    copied.push(rel);
  }
  return copied;
}

export async function createWorktree(
  d: WorktreeDeps,
  i: CreateWorktreeInput,
  opts: { runSetup: boolean; actor: AuditActor },
): Promise<{ view: WorktreeView; setupPtyId: string | null }> {
  const { ctx } = d;
  const branch = branchName(i);
  return runAudited(ctx, opts.actor, 'worktree.create', i.repo, { ...i, branch, runSetup: opts.runSetup }, async () => {
    const repo = existsSync(i.repo) ? realpathSync(i.repo) : i.repo;
    const main = await mainCheckoutOf(repo);
    if (!main || realpathSync(main) !== repo) throw new GitError('not_a_worktree', `${i.repo} is not the main checkout of a git repository`);
    const rc = repoConfigFor(ctx, repo);
    const worktreeDir = rc?.worktreeDir ?? '.worktrees';
    const path = join(repo, worktreeDir, worktreeDirName(branch));

    const listed = parseWorktreePorcelain(await gitOut(repo, ['worktree', 'list', '--porcelain']));
    const clash = listed.find((w) => w.branch === branch || w.path === path);
    if (clash) throw new GitError('worktree_exists', `a worktree for ${branch} already exists at ${clash.path}`);
    if (existsSync(path)) throw new GitError('worktree_exists', `folder already exists at ${path}`);

    const branchExists = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).exitCode === 0;
    mkdirSync(join(repo, worktreeDir), { recursive: true });
    if (branchExists) await git(repo, ['worktree', 'add', path, branch]);
    else await git(repo, ['worktree', 'add', '-b', branch, path, i.base]);

    const realPath = realpathSync(path);
    await copyIgnoredFiles(repo, realPath, rc?.copyGlobs ?? [], worktreeDir);
    const nowIso = d.now().toISOString();
    const head = await gitOut(realPath, ['rev-parse', 'HEAD']);
    const row = {
      path: realPath,
      repo,
      branch,
      base: i.base,
      ticket: i.ticket ? i.ticket.toUpperCase() : null,
      dirty: false,
      prUrl: null,
      state: 'active' as const,
      createdByApp: true,
      head,
      isMain: false,
      origin: 'app' as const,
      sessionPks: [],
      projectId: ctx.projects.resolve(realPath),
      createdAt: getWorktree(ctx.db, realPath)?.createdAt ?? nowIso,
      updatedAt: nowIso,
      archivedAt: null,
    };
    upsertWorktree(ctx.db, row);
    const view = toView(d, row);
    ctx.bus.emit({ type: 'worktree.updated', worktree: view });

    let setupPtyId: string | null = null;
    if (opts.runSetup && rc?.setup) {
      setupPtyId = ctx.pty.spawn({ command: shell(), args: ['-lc', rc.setup], cwd: realPath }).id;
    }
    return { view, setupPtyId };
  });
}

export async function runWorktreeScript(d: WorktreeDeps, path: string, which: 'setup' | 'run' | 'archive', actor: AuditActor): Promise<{ ptyId: string }> {
  const { ctx } = d;
  return runAudited(ctx, actor, 'worktree.script', path, { which }, async () => {
    const row = getWorktree(ctx.db, path);
    if (!row || row.state !== 'active') throw new GitError('not_a_worktree', `unknown worktree ${path}`);
    const script = repoConfigFor(ctx, row.repo)?.[which];
    if (!script) throw new GitError('no_script', `no ${which} script configured for ${row.repo}`);
    return { ptyId: ctx.pty.spawn({ command: shell(), args: ['-lc', script], cwd: path }).id };
  });
}

const defaultOpener = async (command: string, args: string[]) => {
  await execa(command, args, { detached: true, stdio: 'ignore' });
};

export async function openWorktree(d: WorktreeDeps, path: string, target: 'vscode' | 'terminal' | 'finder'): Promise<void> {
  const { ctx } = d;
  await runAudited(ctx, 'user', 'worktree.open', path, { target }, async () => {
    if (!getWorktree(ctx.db, path)) throw new GitError('not_a_worktree', `unknown worktree ${path}`);
    const open = d.opener ?? defaultOpener;
    if (target === 'vscode') await open('code', ['--new-window', path]);
    else if (target === 'terminal') await open('open', ['-a', 'Terminal', path]);
    else await open('open', [path]);
  });
}
```
`CreateWorktreeInput` is imported from `worktree.ts`, which Task 9 creates. In this task, add the interface there now so the import resolves:

`apps/daemon/src/services/worktree/worktree.ts` (initial content; Task 9 replaces the file with the full service)
```ts
export interface CreateWorktreeInput {
  repo: string;
  base: string;
  type: 'feat' | 'fix' | 'chore' | 'docs' | 'refactor';
  ticket: string | null;
  slug: string;
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run apps/daemon/src/services/worktree`
Expected: PASS (5 new tests). `node_modules/` is not in `copyGlobs`, so it is not copied even though it is ignored.

- [ ] **Step 6: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon/src/services/worktree apps/daemon/src/services/git/audit.ts
git commit -m "feat(daemon): create worktrees from tickets with env copy and setup scripts"
```

---
### Task 9: Sync to main, archive/prune, and the composed WorktreeService

**Files:**
- Create: `apps/daemon/src/services/worktree/worktree-sync.ts`
- Modify: `apps/daemon/src/services/worktree/worktree.ts` (full service; Task 8 created it with only `CreateWorktreeInput`)
- Test: `apps/daemon/src/services/worktree/worktree-sync.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 5, 7, 8; `ctx.bus`
- Produces:
  ```ts
  // worktree-sync.ts
  export async function baseRef(row: WorktreeRow): Promise<string>                         // row.base ?? main checkout's current branch
  export async function changedFiles(path: string, base: string): Promise<string[]>        // committed + uncommitted + untracked vs merge-base
  export async function syncPreview(d: WorktreeDeps, path: string): Promise<SyncPreviewResult>
  export async function syncToMain(d: WorktreeDeps, path: string, actor: AuditActor): Promise<{ files: number }>
  export async function archiveWorktree(d: WorktreeDeps, path: string, actor: AuditActor, opts?: { allowExternal?: boolean }): Promise<void>
  // worktree.ts
  export interface SyncPreviewResult { path: string; mainPath: string; files: string[]; mainDirty: string[] }
  export interface WorktreeService { /* §11 members + Contract additions members */ }
  export function createWorktreeService(ctx: DaemonContext, opts?: { now?: () => Date; claudeJson?: string; opener?: WorktreeDeps['opener'] }): WorktreeService
  ```
  Archive emits `worktree.removed` after `git worktree remove` (never `--force`) and never deletes the branch. `GitError` codes: `is_main_checkout`, `external_worktree`, `dirty_worktree`, `main_dirty`.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/services/worktree/worktree-sync.test.ts`
```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { memoryAudit, stubSessions } from '../../../test/stubs.ts';
import { getWorktree, upsertWorktree } from '../../db/repos/worktrees.ts';
import { createWorktreeService } from './worktree.ts';

let repo: TempRepo;
afterEach(() => repo.cleanup());

async function setup() {
  repo = makeTempRepo();
  const cfg = OrcConfig.parse({ projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root], repos: [{ path: repo.dir }] }] });
  const audit = memoryAudit();
  const ctx = createTestContext({ config: () => cfg, pty: recordingPty(), audit, sessions: stubSessions([]) });
  const removed: string[] = [];
  ctx.bus.on('worktree.removed', (e) => removed.push(e.path));
  const svc = createWorktreeService(ctx, { now: () => new Date('2026-09-17T10:00:00.000Z') });
  const wt = await svc.create({ repo: repo.dir, base: 'main', type: 'feat', ticket: 'SAF-7', slug: 'sync me' });
  const git = (...args: string[]) => repo.git('-C', wt.path, ...args);
  const write = (rel: string, body: string) => repo.write(join('.worktrees', 'feat-SAF-7-sync-me', rel), body);
  return { ctx, svc, wt, audit, removed, git, write };
}

describe('sync to main', () => {
  it('previews and copies committed, uncommitted, untracked and deleted files', async () => {
    const { svc, wt, git, write } = await setup();
    write('src/a.ts', 'export const a = 42;\n');
    git('commit', '-am', 'change a');
    write('src/b.ts', 'export const b = 1;\n');
    git('rm', '-q', 'README.md');
    const preview = await svc.syncPreview(wt.path);
    expect(preview).toEqual({ path: wt.path, mainPath: repo.dir, files: ['README.md', 'src/a.ts', 'src/b.ts'], mainDirty: [] });
    expect(await svc.syncToMain(wt.path)).toEqual({ files: 3 });
    expect(repo.read('src/a.ts')).toBe('export const a = 42;\n');
    expect(repo.read('src/b.ts')).toBe('export const b = 1;\n');
    expect(repo.exists('README.md')).toBe(false);
  });

  it('refuses when the main checkout has local edits to the same files', async () => {
    const { svc, wt, write, audit } = await setup();
    write('src/a.ts', 'from worktree\n');
    repo.write('src/a.ts', 'local edit in main\n');
    expect((await svc.syncPreview(wt.path)).mainDirty).toEqual(['src/a.ts']);
    await expect(svc.syncToMain(wt.path)).rejects.toMatchObject({ code: 'main_dirty' });
    expect(repo.read('src/a.ts')).toBe('local edit in main\n');
    expect(audit.entries.at(-1)).toMatchObject({ action: 'worktree.sync', result: 'error' });
  });
});

describe('archive', () => {
  it('refuses a dirty worktree', async () => {
    const { svc, wt, write } = await setup();
    write('src/a.ts', 'dirty\n');
    await expect(svc.archive(wt.path)).rejects.toMatchObject({ code: 'dirty_worktree' });
    expect(existsSync(wt.path)).toBe(true);
  });

  it('removes a clean worktree, keeps the branch and emits worktree.removed', async () => {
    const { ctx, svc, wt, removed, audit } = await setup();
    await svc.archive(wt.path);
    expect(existsSync(wt.path)).toBe(false);
    expect(repo.git('branch', '--list', 'feat/SAF-7-sync-me')).toContain('feat/SAF-7-sync-me');
    expect(getWorktree(ctx.db, wt.path)?.state).toBe('archived');
    expect(removed).toEqual([wt.path]);
    expect(audit.entries.map((e) => [e.action, e.result])).toContainEqual(['worktree.archive', 'ok']);
    expect(svc.list({ state: 'active' }).some((w) => w.path === wt.path)).toBe(false);
  });

  it('protects external worktrees and the main checkout', async () => {
    const { ctx, svc, wt } = await setup();
    const row = getWorktree(ctx.db, wt.path);
    if (!row) throw new Error('missing row');
    upsertWorktree(ctx.db, { ...row, createdByApp: false, origin: 'worktree-dir' });
    await expect(svc.archive(wt.path)).rejects.toMatchObject({ code: 'external_worktree' });
    await svc.archiveAs(wt.path, 'user', { allowExternal: true });
    expect(existsSync(wt.path)).toBe(false);
    upsertWorktree(ctx.db, { ...row, path: repo.dir, branch: 'main', isMain: true, createdByApp: false });
    await expect(svc.archiveAs(repo.dir, 'user', { allowExternal: true })).rejects.toMatchObject({ code: 'is_main_checkout' });
    expect(readFileSync(join(repo.dir, 'README.md'), 'utf8')).toBe('# temp\n');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/worktree/worktree-sync.test.ts`
Expected: FAIL, `createWorktreeService is not exported`

- [ ] **Step 3: Implement sync and archive**

`apps/daemon/src/services/worktree/worktree-sync.ts`
```ts
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuditActor } from '@orc/core';
import { execa } from 'execa';
import { getWorktree, markWorktreeArchived, type WorktreeRow } from '../../db/repos/worktrees.ts';
import { runAudited } from '../git/audit.ts';
import { GitError, git, gitOut } from '../git/exec.ts';
import type { SyncPreviewResult } from './worktree.ts';
import { dirtyFiles, type WorktreeDeps } from './worktree-read.ts';
import { repoConfigFor } from './worktree-write.ts';

function requireRow(d: WorktreeDeps, path: string): WorktreeRow {
  const row = getWorktree(d.ctx.db, path);
  if (!row || row.state !== 'active') throw new GitError('not_a_worktree', `unknown worktree ${path}`);
  if (row.isMain) throw new GitError('is_main_checkout', `${path} is the main checkout`);
  return row;
}

export async function baseRef(row: WorktreeRow): Promise<string> {
  if (row.base) return row.base;
  return gitOut(row.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

const splitZ = (s: string) => s.split('\0').filter((x) => x !== '');

export async function changedFiles(path: string, base: string): Promise<string[]> {
  const mergeBase = await gitOut(path, ['merge-base', 'HEAD', base]);
  const tracked = splitZ(await gitOut(path, ['diff', '--name-only', '--no-renames', '-z', mergeBase]));
  const untracked = splitZ(await gitOut(path, ['ls-files', '--others', '--exclude-standard', '-z']));
  return [...new Set([...tracked, ...untracked])].sort();
}

export async function syncPreview(d: WorktreeDeps, path: string): Promise<SyncPreviewResult> {
  const row = requireRow(d, path);
  const files = await changedFiles(path, await baseRef(row));
  const dirtyInMain = new Set(await dirtyFiles(row.repo));
  return { path, mainPath: row.repo, files, mainDirty: files.filter((f) => dirtyInMain.has(f)) };
}

export async function syncToMain(d: WorktreeDeps, path: string, actor: AuditActor): Promise<{ files: number }> {
  return runAudited(d.ctx, actor, 'worktree.sync', path, {}, async () => {
    const preview = await syncPreview(d, path);
    if (preview.mainDirty.length > 0) {
      throw new GitError('main_dirty', `main checkout has local changes in: ${preview.mainDirty.join(', ')}`);
    }
    for (const rel of preview.files) {
      const src = join(path, rel);
      const dst = join(preview.mainPath, rel);
      if (existsSync(src) && statSync(src).isFile()) {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
      } else if (!existsSync(src) && existsSync(dst)) {
        rmSync(dst);
      }
    }
    return { files: preview.files.length };
  });
}

export async function archiveWorktree(d: WorktreeDeps, path: string, actor: AuditActor, opts: { allowExternal?: boolean } = {}): Promise<void> {
  const { ctx } = d;
  await runAudited(ctx, actor, 'worktree.archive', path, { allowExternal: opts.allowExternal ?? false }, async () => {
    const row = requireRow(d, path);
    if (!row.createdByApp && !opts.allowExternal) {
      throw new GitError('external_worktree', `${path} was not created by the app; confirm explicitly to archive it`);
    }
    if (existsSync(path)) {
      const dirty = await dirtyFiles(path);
      if (dirty.length > 0) throw new GitError('dirty_worktree', `uncommitted changes in ${dirty.length} file(s): ${dirty.slice(0, 5).join(', ')}`);
      const script = repoConfigFor(ctx, row.repo)?.archive;
      if (script) await execa(process.env.SHELL ?? '/bin/zsh', ['-lc', script], { cwd: path, timeout: 300_000 });
      await git(row.repo, ['worktree', 'remove', path]);
    } else {
      await git(row.repo, ['worktree', 'prune']);
    }
    const nowIso = d.now().toISOString();
    markWorktreeArchived(ctx.db, path, nowIso);
    ctx.bus.emit({ type: 'worktree.removed', path });
  });
}
```

- [ ] **Step 4: Compose the service**

Replace `apps/daemon/src/services/worktree/worktree.ts` with:
```ts
import { branchName as coreBranchName, type AuditActor, type Worktree, type WorktreeView } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { discoverWorktrees, findWorktreeByCwd, getWorktreeView, listWorktreeViews, type WorktreeDeps } from './worktree-read.ts';
import { archiveWorktree, syncPreview, syncToMain } from './worktree-sync.ts';
import { createWorktree, openWorktree, runWorktreeScript } from './worktree-write.ts';

export interface CreateWorktreeInput {
  repo: string;
  base: string;
  type: 'feat' | 'fix' | 'chore' | 'docs' | 'refactor';
  ticket: string | null;
  slug: string;
}

export interface SyncPreviewResult {
  path: string;
  mainPath: string;
  files: string[];
  mainDirty: string[];
}

export interface WorktreeService {
  discover(): Promise<Worktree[]>;
  create(i: CreateWorktreeInput): Promise<Worktree>;
  runScript(path: string, which: 'setup' | 'run' | 'archive'): Promise<{ ptyId: string }>;
  syncToMain(path: string): Promise<{ files: number }>;
  archive(path: string): Promise<void>;
  branchName(i: Pick<CreateWorktreeInput, 'type' | 'ticket' | 'slug'>): string;
  list(filter?: { projectId?: string; state?: Worktree['state']; repo?: string }): WorktreeView[];
  get(path: string): WorktreeView | null;
  findByCwd(cwd: string): WorktreeView | null;
  syncPreview(path: string): Promise<SyncPreviewResult>;
  archiveAs(path: string, actor: AuditActor, opts?: { allowExternal?: boolean }): Promise<void>;
  createWith(i: CreateWorktreeInput, opts: { runSetup: boolean; actor: AuditActor }): Promise<{ view: WorktreeView; setupPtyId: string | null }>;
  open(path: string, target: 'vscode' | 'terminal' | 'finder'): Promise<void>;
}

export function createWorktreeService(
  ctx: DaemonContext,
  opts: { now?: () => Date; claudeJson?: string; opener?: WorktreeDeps['opener'] } = {},
): WorktreeService {
  const d: WorktreeDeps = {
    ctx,
    now: opts.now ?? (() => new Date()),
    ...(opts.claudeJson ? { claudeJson: opts.claudeJson } : {}),
    ...(opts.opener ? { opener: opts.opener } : {}),
  };
  let running: Promise<WorktreeView[]> | null = null;
  return {
    discover: () => {
      running ??= discoverWorktrees(d).finally(() => {
        running = null;
      });
      return running;
    },
    create: async (i) => (await createWorktree(d, i, { runSetup: true, actor: 'user' })).view,
    createWith: (i, o) => createWorktree(d, i, o),
    runScript: (path, which) => runWorktreeScript(d, path, which, 'user'),
    syncToMain: (path) => syncToMain(d, path, 'user'),
    syncPreview: (path) => syncPreview(d, path),
    archive: (path) => archiveWorktree(d, path, 'user', { allowExternal: false }),
    archiveAs: (path, actor, o) => archiveWorktree(d, path, actor, o),
    branchName: (i) => coreBranchName(i),
    list: (f) => listWorktreeViews(d, f),
    get: (path) => getWorktreeView(d, path),
    findByCwd: (cwd) => findWorktreeByCwd(d, cwd),
    open: (path, target) => openWorktree(d, path, target),
  };
}
```
The imports between `worktree.ts`, `worktree-write.ts` and `worktree-sync.ts` are type-only in one direction (`import type { CreateWorktreeInput }`, `import type { SyncPreviewResult }`), so there is no runtime import cycle.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run apps/daemon/src/services/worktree`
Expected: PASS (5 new tests; all earlier worktree tests still pass). The sync test relies on `.worktrees/` being ignored in the temp repo, so the main checkout is clean.

- [ ] **Step 6: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon/src/services/worktree
git commit -m "feat(daemon): sync worktree changes to main and archive clean worktrees"
```

---
### Task 10: CheckpointService — commit-tree snapshots, rewind, per-turn hook

**Files:**
- Create: `apps/daemon/src/services/checkpoint/snapshot.ts`, `apps/daemon/src/services/checkpoint/checkpoint.ts`, `apps/daemon/src/services/checkpoint/turn-hook.ts`
- Modify: `apps/daemon/src/context.ts` (type `worktrees?` and `checkpoints?` with the Phase 4 interfaces)
- Test: `apps/daemon/src/services/checkpoint/checkpoint.test.ts`, `apps/daemon/src/services/checkpoint/turn-hook.test.ts`

**Interfaces:**
- Consumes: `git`, `gitOut`, `GitError` (Task 4); `runAudited` (Task 8); checkpoint repos (Task 5); `getWorktree` (Task 5); `WorktreeService.findByCwd` (Task 9); bus events `session.turnEnded`, `worktree.removed`; `ctx.sessions.getByPk`
- Produces:
  ```ts
  // snapshot.ts
  export async function snapshotTree(cwd: string): Promise<string>                         // tree sha of the working tree incl. untracked, via a temp index
  export async function snapshotCommit(cwd: string, message: string): Promise<{ commit: string; tree: string }>
  export function checkpointRef(sessionId: string, turn: number, kind: CheckpointRecord['kind'], at: Date): string
  // checkpoint.ts
  export interface CheckpointService {
    create(sessionPk: string, worktreePath: string, turn: number): Promise<CheckpointRecord>;
    list(sessionPk: string): CheckpointRecord[];
    rewind(checkpointId: string): Promise<CheckpointRecord>;
    diff(fromRef: string, toRef: string | 'WORKTREE', cwd: string): Promise<string>;
    get(id: string): CheckpointRecord | null;
    createAs(sessionPk: string, worktreePath: string, turn: number, kind: CheckpointRecord['kind'], actor: AuditActor): Promise<CheckpointRecord>;
    pruneForWorktree(worktreePath: string): Promise<number>;
  }
  export function createCheckpointService(ctx: DaemonContext, opts?: { now?: () => Date }): CheckpointService
  // turn-hook.ts
  export function registerCheckpointHook(ctx: DaemonContext): () => void
  ```
  `create()` records kind `turn` with actor `automation`; `rewind()` records a `safety` checkpoint with actor `user` first, then `git restore --source=<commit> --worktree -- .` and removes files that did not exist in the checkpoint (they stay recoverable from the safety checkpoint). `checkpoint.created` is emitted for every new record.

- [ ] **Step 1: Write the failing service test**

`apps/daemon/src/services/checkpoint/checkpoint.test.ts`
```ts
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { memoryAudit, stubSessions } from '../../../test/stubs.ts';
import { createWorktreeService } from '../worktree/worktree.ts';
import { createCheckpointService } from './checkpoint.ts';

let repo: TempRepo;
afterEach(() => repo.cleanup());

function setup(checkpointsPerSession = 200) {
  repo = makeTempRepo();
  const cfg = OrcConfig.parse({
    projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root], repos: [{ path: repo.dir }] }],
    worktrees: { checkpointsPerSession },
  });
  const audit = memoryAudit();
  const ctx = createTestContext({ config: () => cfg, audit, pty: recordingPty(), sessions: stubSessions([]) });
  let tick = 0;
  const svc = createCheckpointService(ctx, { now: () => new Date(Date.UTC(2026, 8, 17, 10, 0, tick++)) });
  const state = () => ({
    head: repo.git('rev-parse', 'HEAD').trim(),
    symbolic: repo.git('symbolic-ref', 'HEAD').trim(),
    staged: repo.git('diff', '--cached'),
    status: repo.git('status', '--porcelain=v1'),
    stash: repo.git('stash', 'list'),
    indexHash: repo.git('ls-files', '-s'),
  });
  return { ctx, svc, audit, state };
}

describe('CheckpointService.create', () => {
  it('snapshots staged, unstaged and untracked files without touching HEAD, index or stash', async () => {
    const { svc, state, audit } = setup();
    repo.write('stash-me.txt', 'x\n');
    repo.git('add', 'stash-me.txt');
    repo.git('stash', 'push', '-m', 'keep me');
    repo.write('src/a.ts', 'export const a = 100;\n');
    repo.git('add', 'src/a.ts');
    repo.write('src/a.ts', 'export const a = 200;\n');
    repo.write('src/new.ts', 'export const n = 1;\n');
    repo.write('.env', 'SECRET=ignored\n');
    const before = state();

    const cp = await svc.create('claude:sess-1', repo.dir, 1);

    expect(state()).toEqual(before);
    expect(cp).toMatchObject({ sessionId: 'sess-1', turn: 1, kind: 'turn', ref: 'refs/orchestrator/checkpoints/sess-1/1', worktreePath: repo.dir });
    expect(repo.git('rev-parse', cp.ref).trim()).toBe(cp.commit);
    expect(repo.git('show', `${cp.ref}:src/a.ts`)).toBe('export const a = 200;\n');
    expect(repo.git('show', `${cp.ref}:src/new.ts`)).toBe('export const n = 1;\n');
    expect(() => repo.git('show', `${cp.ref}:.env`)).toThrow();
    expect(repo.git('rev-parse', `${cp.commit}^`).trim()).toBe(before.head);
    expect(audit.entries.map((e) => [e.action, e.actor, e.result])).toEqual([['checkpoint.create', 'automation', 'ok']]);
  });

  it('replaces a checkpoint for the same turn and enforces the per-session cap', async () => {
    const { svc } = setup(2);
    await svc.create('claude:s', repo.dir, 1);
    repo.write('src/a.ts', 'v2\n');
    const again = await svc.create('claude:s', repo.dir, 1);
    expect(svc.list('claude:s')).toHaveLength(1);
    expect(repo.git('show', `${again.ref}:src/a.ts`)).toBe('v2\n');
    await svc.create('claude:s', repo.dir, 2);
    await svc.create('claude:s', repo.dir, 3);
    expect(svc.list('claude:s').map((c) => c.turn)).toEqual([2, 3]);
    expect(repo.git('for-each-ref', 'refs/orchestrator/checkpoints/s/1')).toBe('');
  });
});

describe('CheckpointService.diff', () => {
  it('diffs two checkpoints and a checkpoint against the live worktree', async () => {
    const { svc } = setup();
    const one = await svc.create('claude:s', repo.dir, 1);
    repo.write('src/a.ts', 'export const a = 2;\nexport const b = 2;\nexport const c = 3;\n');
    const two = await svc.create('claude:s', repo.dir, 2);
    const between = await svc.diff(one.ref, two.ref, repo.dir);
    expect(between).toContain('-export const a = 1;');
    expect(between).toContain('+export const a = 2;');
    repo.write('src/untracked.ts', 'u\n');
    const live = await svc.diff(two.ref, 'WORKTREE', repo.dir);
    expect(live).toContain('+++ b/src/untracked.ts');
    expect(repo.git('status', '--porcelain=v1')).toContain('?? src/untracked.ts');
  });
});

describe('CheckpointService.rewind', () => {
  it('takes a safety checkpoint, restores files and keeps HEAD and the index', async () => {
    const { svc, state, audit } = setup();
    repo.write('src/a.ts', 'turn one\n');
    const one = await svc.create('claude:s', repo.dir, 1);
    repo.write('src/a.ts', 'turn two\n');
    repo.write('src/later.ts', 'created later\n');
    repo.write('README.md', '# staged\n');
    repo.git('add', 'README.md');
    const before = state();

    const safety = await svc.rewind(one.id);

    expect(repo.read('src/a.ts')).toBe('turn one\n');
    expect(repo.exists('src/later.ts')).toBe(false);
    expect(repo.read('README.md')).toBe('# temp\n');
    expect(repo.git('show', ':README.md')).toBe('# staged\n');
    expect(safety.kind).toBe('safety');
    expect(repo.git('show', `${safety.ref}:src/later.ts`)).toBe('created later\n');
    const after = state();
    expect(after.head).toBe(before.head);
    expect(after.symbolic).toBe(before.symbolic);
    expect(after.indexHash).toBe(before.indexHash);
    expect(after.stash).toBe(before.stash);
    expect(audit.entries.map((e) => e.action)).toEqual(['checkpoint.create', 'checkpoint.create', 'checkpoint.rewind']);
  });

  it('fails for an unknown id', async () => {
    const { svc } = setup();
    await expect(svc.rewind('nope')).rejects.toThrow(/not_found/);
  });
});

describe('pruning', () => {
  it('deletes refs and rows when a worktree is archived', async () => {
    const { ctx, svc } = setup();
    const wts = createWorktreeService(ctx);
    const wt = await wts.createWith({ repo: repo.dir, base: 'main', type: 'feat', ticket: 'SAF-5', slug: 'prune' }, { runSetup: false, actor: 'user' });
    await svc.create('claude:p', wt.view.path, 1);
    await svc.create('claude:p', wt.view.path, 2);
    await wts.archive(wt.view.path);
    await new Promise((r) => setTimeout(r, 50));
    expect(svc.list('claude:p')).toEqual([]);
    expect(repo.git('for-each-ref', 'refs/orchestrator/')).toBe('');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/checkpoint`
Expected: FAIL, `Cannot find module './checkpoint.ts'`

- [ ] **Step 3: Implement the snapshot helpers**

`apps/daemon/src/services/checkpoint/snapshot.ts`
```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckpointRecord } from '@orc/core';
import { gitOut } from '../git/exec.ts';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Orchestrator',
  GIT_AUTHOR_EMAIL: 'orchestrator@localhost',
  GIT_COMMITTER_NAME: 'Orchestrator',
  GIT_COMMITTER_EMAIL: 'orchestrator@localhost',
};

/** Writes the full working tree (tracked + untracked, minus ignored) into a tree object using a throwaway index. */
export async function snapshotTree(cwd: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'orc-idx-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    await gitOut(cwd, ['read-tree', 'HEAD'], { env });
    await gitOut(cwd, ['add', '-A', '--', '.'], { env });
    return await gitOut(cwd, ['write-tree'], { env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function snapshotCommit(cwd: string, message: string): Promise<{ commit: string; tree: string }> {
  const tree = await snapshotTree(cwd);
  const parent = await gitOut(cwd, ['rev-parse', 'HEAD']);
  const commit = await gitOut(cwd, ['commit-tree', tree, '-p', parent, '-m', message], { env: IDENTITY });
  return { commit, tree };
}

const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');

export function checkpointRef(sessionId: string, turn: number, kind: CheckpointRecord['kind'], at: Date): string {
  const base = `refs/orchestrator/checkpoints/${safeSegment(sessionId)}/${turn}`;
  return kind === 'turn' ? base : `${base}-${kind}-${at.getTime()}-${randomUUID().slice(0, 8)}`;
}
```
`git add -A -- .` runs from `cwd`, which is always a worktree root here, so it covers the whole worktree. The temp index starts from `HEAD`, so unchanged files are not re-hashed.

- [ ] **Step 4: Implement the service**

`apps/daemon/src/services/checkpoint/checkpoint.ts`
```ts
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { AuditActor, CheckpointRecord } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import {
  type CheckpointInsert,
  deleteCheckpoint,
  getCheckpoint,
  insertCheckpoint,
  listCheckpoints,
  listCheckpointsForWorktree,
} from '../../db/repos/checkpoints.ts';
import { getWorktree } from '../../db/repos/worktrees.ts';
import { runAudited } from '../git/audit.ts';
import { git, gitOut } from '../git/exec.ts';
import { checkpointRef, snapshotCommit, snapshotTree } from './snapshot.ts';

export interface CheckpointService {
  create(sessionPk: string, worktreePath: string, turn: number): Promise<CheckpointRecord>;
  list(sessionPk: string): CheckpointRecord[];
  rewind(checkpointId: string): Promise<CheckpointRecord>;
  diff(fromRef: string, toRef: string | 'WORKTREE', cwd: string): Promise<string>;
  get(id: string): CheckpointRecord | null;
  createAs(sessionPk: string, worktreePath: string, turn: number, kind: CheckpointRecord['kind'], actor: AuditActor): Promise<CheckpointRecord>;
  pruneForWorktree(worktreePath: string): Promise<number>;
}

const strip = ({ sessionPk: _pk, ...rest }: CheckpointInsert): CheckpointRecord => rest;
const nativeId = (pk: string) => pk.slice(pk.indexOf(':') + 1);

export function createCheckpointService(ctx: DaemonContext, opts: { now?: () => Date } = {}): CheckpointService {
  const now = opts.now ?? (() => new Date());

  async function dropRef(cwd: string, ref: string): Promise<void> {
    await git(cwd, ['update-ref', '-d', ref], { allowFail: true });
  }

  async function createAs(sessionPk: string, worktreePath: string, turn: number, kind: CheckpointRecord['kind'], actor: AuditActor) {
    return runAudited(ctx, actor, 'checkpoint.create', worktreePath, { sessionPk, turn, kind }, async () => {
      const at = now();
      const sessionId = nativeId(sessionPk);
      const ref = checkpointRef(sessionId, turn, kind, at);
      const { commit } = await snapshotCommit(worktreePath, `orchestrator checkpoint ${sessionId} turn ${turn} (${kind})`);
      await gitOut(worktreePath, ['update-ref', ref, commit]);
      const existing = listCheckpoints(ctx.db, sessionPk).find((c) => c.ref === ref);
      if (existing) deleteCheckpoint(ctx.db, existing.id);
      const rec: CheckpointInsert = { id: randomUUID(), sessionPk, sessionId, worktreePath, turn, ref, commit, kind, createdAt: at.toISOString() };
      insertCheckpoint(ctx.db, rec);

      const cap = ctx.config().worktrees.checkpointsPerSession;
      const turns = listCheckpoints(ctx.db, sessionPk).filter((c) => c.kind === 'turn');
      for (const old of turns.slice(0, Math.max(0, turns.length - cap))) {
        await dropRef(worktreePath, old.ref);
        deleteCheckpoint(ctx.db, old.id);
      }
      const out = strip(rec);
      ctx.bus.emit({ type: 'checkpoint.created', checkpoint: out });
      return out;
    });
  }

  async function diff(fromRef: string, toRef: string | 'WORKTREE', cwd: string): Promise<string> {
    const to = toRef === 'WORKTREE' ? await snapshotTree(cwd) : toRef;
    const r = await git(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', fromRef, to]);
    return r.stdout;
  }

  async function rewind(checkpointId: string): Promise<CheckpointRecord> {
    const cp = getCheckpoint(ctx.db, checkpointId);
    if (!cp) throw new Error(`not_found: checkpoint ${checkpointId}`);
    return runAudited(ctx, 'user', 'checkpoint.rewind', cp.worktreePath, { checkpointId, ref: cp.ref }, async () => {
      const safety = await createAs(cp.sessionPk, cp.worktreePath, cp.turn, 'safety', 'user');
      await gitOut(cp.worktreePath, ['restore', `--source=${cp.commit}`, '--worktree', '--', '.']);
      const added = (await gitOut(cp.worktreePath, ['diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', cp.commit, safety.commit]))
        .split('\0')
        .filter((f) => f !== '');
      const root = resolve(cp.worktreePath);
      for (const rel of added) {
        const abs = resolve(join(root, rel));
        if (abs.startsWith(root + sep) && existsSync(abs)) rmSync(abs);
      }
      return safety;
    });
  }

  async function pruneForWorktree(worktreePath: string): Promise<number> {
    const rows = listCheckpointsForWorktree(ctx.db, worktreePath);
    const cwd = existsSync(worktreePath) ? worktreePath : (getWorktree(ctx.db, worktreePath)?.repo ?? null);
    for (const row of rows) {
      if (cwd) await dropRef(cwd, row.ref);
      deleteCheckpoint(ctx.db, row.id);
    }
    return rows.length;
  }

  ctx.bus.on('worktree.removed', (e) => {
    pruneForWorktree(e.path).catch((err: unknown) => ctx.log.warn({ err, path: e.path }, 'checkpoint prune failed'));
  });

  return {
    create: (pk, path, turn) => createAs(pk, path, turn, 'turn', 'automation'),
    createAs,
    list: (pk) => listCheckpoints(ctx.db, pk).map(strip),
    get: (id) => {
      const c = getCheckpoint(ctx.db, id);
      return c ? strip(c) : null;
    },
    diff,
    rewind,
    pruneForWorktree,
  };
}
```
`git restore --worktree` never writes the index, and `git update-ref` only touches `refs/orchestrator/*` (enforced by `assertSafeGitArgs`).

- [ ] **Step 5: Run the service tests**

Run: `pnpm vitest run apps/daemon/src/services/checkpoint/checkpoint.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Write the failing turn-hook test**

`apps/daemon/src/services/checkpoint/turn-hook.test.ts`
```ts
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import type { LiveState } from '@orc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { makeSession, memoryAudit, stubSessions } from '../../../test/stubs.ts';
import { createWorktreeService } from '../worktree/worktree.ts';
import { createCheckpointService } from './checkpoint.ts';
import { registerCheckpointHook } from './turn-hook.ts';

let repo: TempRepo;
afterEach(() => repo.cleanup());

const live = (ownership: LiveState['ownership']): LiveState => ({
  pid: 1, status: 'idle', waitingFor: null, since: '2026-09-17T10:00:00.000Z', ownership,
  ptyId: ownership === 'owned' ? 'pty-9' : null, stage: null, currentTool: null, backgroundJobs: 0, runningSubagents: 0, contextFill: null,
});

const flush = () => new Promise((r) => setTimeout(r, 100));

describe('registerCheckpointHook', () => {
  it('checkpoints owned sessions inside an app worktree only', async () => {
    repo = makeTempRepo();
    const cfg = OrcConfig.parse({ projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root], repos: [{ path: repo.dir }] }] });
    const wtPath = join(repo.dir, '.worktrees', 'feat-SAF-8-hook');
    const sessions = stubSessions([
      makeSession({ id: 'owned', startCwd: wtPath, cwds: [wtPath, join(wtPath, 'src')], live: live('owned') }),
      makeSession({ id: 'observed', startCwd: wtPath, cwds: [wtPath], live: live('observed') }),
      makeSession({ id: 'main', startCwd: repo.dir, cwds: [repo.dir], live: live('owned') }),
    ]);
    const ctx = createTestContext({ config: () => cfg, sessions, audit: memoryAudit(), pty: recordingPty() });
    ctx.worktrees = createWorktreeService(ctx);
    ctx.checkpoints = createCheckpointService(ctx);
    await ctx.worktrees.create({ repo: repo.dir, base: 'main', type: 'feat', ticket: 'SAF-8', slug: 'hook' });
    await ctx.worktrees.discover();
    const off = registerCheckpointHook(ctx);

    ctx.bus.emit({ type: 'session.turnEnded', pk: 'claude:owned', turn: 1 });
    ctx.bus.emit({ type: 'session.turnEnded', pk: 'claude:observed', turn: 1 });
    ctx.bus.emit({ type: 'session.turnEnded', pk: 'claude:main', turn: 1 });
    await flush();

    expect(ctx.checkpoints.list('claude:owned')).toHaveLength(1);
    expect(ctx.checkpoints.list('claude:observed')).toHaveLength(0);
    expect(ctx.checkpoints.list('claude:main')).toHaveLength(0);
    off();
  });
});
```

- [ ] **Step 7: Implement the hook**

`apps/daemon/src/services/checkpoint/turn-hook.ts`
```ts
import type { DaemonContext } from '../../context.ts';

export function registerCheckpointHook(ctx: DaemonContext): () => void {
  const queue = new Map<string, Promise<void>>();
  return ctx.bus.on('session.turnEnded', (e) => {
    const s = ctx.sessions.getByPk(e.pk);
    if (!s?.live || s.live.ownership !== 'owned') return;
    const cwd = s.cwds[s.cwds.length - 1] ?? s.startCwd;
    const wt = ctx.worktrees?.findByCwd(cwd) ?? null;
    if (!wt || wt.isMain || !ctx.checkpoints) return;
    const checkpoints = ctx.checkpoints;
    const prev = queue.get(wt.path) ?? Promise.resolve();
    const next = prev
      .then(() => checkpoints.create(e.pk, wt.path, e.turn))
      .then(() => undefined)
      .catch((err: unknown) => ctx.log.warn({ err, pk: e.pk, turn: e.turn }, 'turn checkpoint failed'));
    queue.set(wt.path, next);
  });
}
```
The per-worktree queue keeps two quick turns from racing on the same temp-index snapshot.

In `apps/daemon/src/context.ts`, set the two field types:
```ts
import type { CheckpointService } from './services/checkpoint/checkpoint.ts';
import type { WorktreeService } from './services/worktree/worktree.ts';
// in DaemonContext
  worktrees?: WorktreeService;             // P4
  checkpoints?: CheckpointService;         // P4
```

- [ ] **Step 8: Run all checkpoint tests**

Run: `pnpm vitest run apps/daemon/src/services/checkpoint`
Expected: PASS (7 tests).

- [ ] **Step 9: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon/src/services/checkpoint apps/daemon/src/context.ts
git commit -m "feat(daemon): per-turn commit-tree checkpoints with safe rewind"
```

---
### Task 11: DiffService — base…worktree diffs and partial revert

**Files:**
- Create: `apps/daemon/src/services/diff/diff.ts`
- Modify: `apps/daemon/src/context.ts` (add `diff?: DiffService`)
- Test: `apps/daemon/src/services/diff/diff.test.ts`

**Interfaces:**
- Consumes: `snapshotTree`, `snapshotCommit` (Task 10); `parseUnifiedDiff`, `hunkPatch` (Task 3); `git`, `gitOut`, `repoRoot`, `GitError` (Task 4); `runAudited` (Task 8); `ctx.worktrees?.findByCwd` (Task 9)
- Produces:
  ```ts
  export interface DiffService {
    diff(cwd: string, opts?: { from?: string; to?: string | 'WORKTREE' }): Promise<DiffResult>;
    mergeBase(cwd: string): Promise<string>;
    revert(cwd: string, file: string, opts: { hunkIndex?: number; from?: string }): Promise<{ reverted: string }>;
  }
  export async function defaultBase(cwd: string): Promise<string>     // origin/HEAD → main → master
  export function createDiffService(ctx: DaemonContext): DiffService
  ```
  `revert` first stores the current worktree as `refs/orchestrator/reverts/<epochMs>` so nothing is lost, then either `git restore --source=<from> --worktree -- <file>` (whole file; files that do not exist in `from` are deleted) or `git apply -R` of one hunk. It never touches HEAD or the index. Audit action `git.revert`.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/services/diff/diff.test.ts`
```ts
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { memoryAudit, stubSessions } from '../../../test/stubs.ts';
import { createDiffService } from './diff.ts';

let repo: TempRepo;
afterEach(() => repo.cleanup());

const lines = (n: number, change: Record<number, string> = {}) =>
  `${Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n')}\n`;

function setup() {
  repo = makeTempRepo();
  repo.write('src/long.ts', lines(30));
  repo.commitAll('add long file');
  const wt = join(repo.root, 'wt');
  repo.git('worktree', 'add', '-b', 'feat/SAF-11-diff', wt, 'main');
  const g = (...args: string[]) => repo.git('-C', wt, ...args);
  const w = (rel: string, body: string) => repo.write(join('..', 'wt', rel), body);
  const cfg = OrcConfig.parse({});
  const audit = memoryAudit();
  const ctx = createTestContext({ config: () => cfg, audit, sessions: stubSessions([]) });
  return { svc: createDiffService(ctx), wt, g, w, audit };
}

describe('DiffService.diff', () => {
  it('compares merge-base with the live worktree, including commits and untracked files', async () => {
    const { svc, wt, g, w } = setup();
    w('src/a.ts', 'export const a = 9;\nexport const b = 2;\nexport const c = 3;\n');
    g('commit', '-qam', 'change a');
    w('src/long.ts', lines(30, { 2: 'CHANGED 2' }));
    w('src/fresh.ts', 'export const fresh = true;\n');
    const d = await svc.diff(wt);
    expect(d.to).toBe('WORKTREE');
    expect(d.from).toBe(await svc.mergeBase(wt));
    expect(d.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['src/a.ts', 'modified', 1, 1],
      ['src/fresh.ts', 'added', 1, 0],
      ['src/long.ts', 'modified', 1, 1],
    ]);
    expect(d.additions).toBe(3);
    expect(d.deletions).toBe(2);
    expect(g('status', '--porcelain=v1')).toContain('?? src/fresh.ts');
  });

  it('diffs two explicit refs', async () => {
    const { svc, wt, g, w } = setup();
    const base = g('rev-parse', 'HEAD').trim();
    w('README.md', '# changed\n');
    g('commit', '-qam', 'readme');
    const d = await svc.diff(wt, { from: base, to: 'HEAD' });
    expect(d.files.map((f) => f.path)).toEqual(['README.md']);
  });
});

describe('DiffService.revert', () => {
  it('reverts a single hunk and leaves the other one', async () => {
    const { svc, wt, g, w, audit } = setup();
    const head = g('rev-parse', 'HEAD').trim();
    w('src/long.ts', lines(30, { 2: 'CHANGED 2', 28: 'CHANGED 28' }));
    const before = await svc.diff(wt);
    expect(before.files[0]?.hunks).toHaveLength(2);
    await expect(svc.revert(wt, 'src/long.ts', { hunkIndex: 0 })).resolves.toEqual({ reverted: 'src/long.ts#0' });
    const after = repo.read('../wt/src/long.ts');
    expect(after).toContain('line 2\n');
    expect(after).toContain('CHANGED 28');
    expect(g('rev-parse', 'HEAD').trim()).toBe(head);
    expect(g('for-each-ref', '--format=%(refname)', 'refs/orchestrator/reverts/')).toMatch(/refs\/orchestrator\/reverts\/\d+/);
    expect(audit.entries.map((e) => [e.action, e.result])).toContainEqual(['git.revert', 'ok']);
  });

  it('reverts a whole file, including committed changes, and deletes added files', async () => {
    const { svc, wt, g, w } = setup();
    w('src/a.ts', 'committed change\n');
    g('commit', '-qam', 'change');
    w('src/added.ts', 'new\n');
    await svc.revert(wt, 'src/a.ts', {});
    await svc.revert(wt, 'src/added.ts', {});
    expect(repo.read('../wt/src/a.ts')).toBe('export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
    expect(repo.exists('../wt/src/added.ts')).toBe(false);
    expect(g('status', '--porcelain=v1')).toContain(' M src/a.ts');
  });

  it('refuses paths outside the worktree and missing hunks', async () => {
    const { svc, wt, w } = setup();
    await expect(svc.revert(wt, '../repo/README.md', {})).rejects.toMatchObject({ code: 'forbidden_git_args' });
    w('src/long.ts', lines(30, { 5: 'x' }));
    await expect(svc.revert(wt, 'src/long.ts', { hunkIndex: 3 })).rejects.toMatchObject({ code: 'hunk_not_found' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/diff`
Expected: FAIL, `Cannot find module './diff.ts'`

- [ ] **Step 3: Implement**

`apps/daemon/src/services/diff/diff.ts`
```ts
import { existsSync, rmSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { hunkPatch, parseUnifiedDiff, type DiffResult } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { snapshotCommit, snapshotTree } from '../checkpoint/snapshot.ts';
import { runAudited } from '../git/audit.ts';
import { GitError, git, gitOut, repoRoot } from '../git/exec.ts';

export interface DiffService {
  diff(cwd: string, opts?: { from?: string; to?: string | 'WORKTREE' }): Promise<DiffResult>;
  mergeBase(cwd: string): Promise<string>;
  revert(cwd: string, file: string, opts: { hunkIndex?: number; from?: string }): Promise<{ reverted: string }>;
}

export async function defaultBase(cwd: string): Promise<string> {
  const originHead = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (originHead.exitCode === 0 && originHead.stdout.trim() !== '') return originHead.stdout.trim();
  for (const name of ['main', 'master', 'develop']) {
    const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { allowFail: true });
    if (r.exitCode === 0) return name;
  }
  throw new GitError('git_failed', `cannot determine a base branch for ${cwd}`);
}

async function rootOf(cwd: string): Promise<string> {
  const root = await repoRoot(cwd);
  if (!root) throw new GitError('not_a_worktree', `${cwd} is not inside a git worktree`);
  return root;
}

function safeRelative(root: string, file: string): string {
  const rel = normalize(file);
  const abs = resolve(root, rel);
  if (isAbsolute(file) || rel.startsWith('..') || !abs.startsWith(root + sep)) {
    throw new GitError('forbidden_git_args', `path escapes the worktree: ${file}`);
  }
  return rel;
}

export function createDiffService(ctx: DaemonContext): DiffService {
  async function mergeBase(cwd: string): Promise<string> {
    const root = await rootOf(cwd);
    const wt = ctx.worktrees?.findByCwd(root) ?? null;
    const base = wt?.base ?? (await defaultBase(root));
    return gitOut(root, ['merge-base', 'HEAD', base]);
  }

  async function diff(cwd: string, opts: { from?: string; to?: string | 'WORKTREE' } = {}): Promise<DiffResult> {
    const root = await rootOf(cwd);
    const from = opts.from ?? (await mergeBase(root));
    const toLabel = opts.to ?? 'WORKTREE';
    const to = toLabel === 'WORKTREE' ? await snapshotTree(root) : toLabel;
    const raw = (await git(root, ['diff', '--no-color', '--no-ext-diff', '-M', from, to])).stdout;
    const files = parseUnifiedDiff(raw).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      cwd: root,
      from,
      to: toLabel,
      files,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    };
  }

  async function revert(cwd: string, file: string, opts: { hunkIndex?: number; from?: string }): Promise<{ reverted: string }> {
    const root = await rootOf(cwd);
    const rel = safeRelative(root, file);
    const label = opts.hunkIndex === undefined ? rel : `${rel}#${opts.hunkIndex}`;
    return runAudited(ctx, 'user', 'git.revert', root, { file: rel, hunkIndex: opts.hunkIndex ?? null }, async () => {
      const from = opts.from ?? (await mergeBase(root));
      const { commit } = await snapshotCommit(root, `orchestrator safety before reverting ${label}`);
      await gitOut(root, ['update-ref', `refs/orchestrator/reverts/${Date.now()}`, commit]);

      if (opts.hunkIndex === undefined) {
        const inBase = (await git(root, ['cat-file', '-e', `${from}:${rel}`], { allowFail: true })).exitCode === 0;
        if (inBase) await gitOut(root, ['restore', `--source=${from}`, '--worktree', '--', rel]);
        else if (existsSync(join(root, rel))) rmSync(join(root, rel));
        return { reverted: label };
      }

      const tree = await snapshotTree(root);
      const raw = (await git(root, ['diff', '--no-color', '--no-ext-diff', '--no-renames', from, tree, '--', rel])).stdout;
      const entry = parseUnifiedDiff(raw)[0];
      if (!entry || !entry.hunks[opts.hunkIndex]) throw new GitError('hunk_not_found', `no hunk ${opts.hunkIndex} in ${rel}`);
      await gitOut(root, ['apply', '-R', '--whitespace=nowarn', '-'], { input: hunkPatch(entry, opts.hunkIndex) });
      return { reverted: label };
    });
  }

  return { diff, mergeBase, revert };
}
```
The path check runs before `runAudited`, so a refused path is not recorded as an attempted write; the route still returns `400`.

In `apps/daemon/src/context.ts` add `import type { DiffService } from './services/diff/diff.ts';` and the field `diff?: DiffService; // P4`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/daemon/src/services/diff`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon/src/services/diff apps/daemon/src/context.ts
git commit -m "feat(daemon): diff worktrees against their base and revert files or hunks"
```

---
### Task 12: ReviewService — summary card data and inline comments to the agent

**Files:**
- Create: `apps/daemon/src/services/review/review.ts`
- Modify: `apps/daemon/src/context.ts` (add `review?: ReviewService`)
- Test: `apps/daemon/src/services/review/review.test.ts`

**Interfaces:**
- Consumes: `DiffService` (Task 11), `WorktreeService.findByCwd` (Task 9), `CheckpointService.list` (Task 10), `getPrStatus` (Task 5), `buildReviewPrompt`, `redact` (core), `repoRoot`, `GitError` (Task 4), `runAudited` (Task 8), `ctx.pty.sendText` (§7), `sessionPk` (§11)
- Produces:
  ```ts
  export interface ReviewService {
    summary(source: Source, id: string): Promise<ReviewSummary>;
    sendComments(source: Source, id: string, comments: ReviewComment[], deliver: 'session' | 'text'): Promise<{ sent: boolean; text: string }>;
  }
  export function isOwned(s: Session): s is Session & { live: LiveState & { ptyId: string } }
  export function sessionWorkdir(s: Session): string                  // last cwd, else startCwd
  export function createReviewService(ctx: DaemonContext): ReviewService
  ```
  `GitError` codes: `not_found` (unknown session), `no_worktree` (session cwd is not in a git checkout). Delivery to a session that is not owned falls back to `{ sent: false, text }`. Audit action `review.send`.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/services/review/review.test.ts`
```ts
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import type { LiveState } from '@orc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { makeSession, memoryAudit, stubSessions } from '../../../test/stubs.ts';
import { upsertPrStatus } from '../../db/repos/pr-cache.ts';
import { createCheckpointService } from '../checkpoint/checkpoint.ts';
import { createDiffService } from '../diff/diff.ts';
import { createWorktreeService } from '../worktree/worktree.ts';
import { createReviewService } from './review.ts';

let repo: TempRepo;
afterEach(() => repo.cleanup());

const owned: LiveState = {
  pid: 1, status: 'idle', waitingFor: null, since: '2026-09-17T10:00:00.000Z', ownership: 'owned', ptyId: 'pty-7',
  stage: 'review', currentTool: null, backgroundJobs: 0, runningSubagents: 0, contextFill: 0.2,
};

async function setup() {
  repo = makeTempRepo();
  const cfg = OrcConfig.parse({ projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root], repos: [{ path: repo.dir }] }] });
  const wtPath = join(repo.dir, '.worktrees', 'feat-SAF-20-review');
  const sessions = stubSessions([
    makeSession({
      id: 'own', startCwd: wtPath, cwds: [wtPath],
      recap: 'Changed a.ts; token ghp_abcdefghijklmnopqrstuvwxyz0123456789 used',
      lastTest: { ts: '2026-09-17T10:00:00.000Z', command: 'pnpm test', passed: 10, failed: 1, skipped: 0, durationMs: 1200 },
      prs: [{ repo: 'o/r', number: 20, url: 'https://github.com/o/r/pull/20' }],
      live: owned,
    }),
    makeSession({ id: 'watch', startCwd: wtPath, cwds: [wtPath], live: { ...owned, ownership: 'observed', ptyId: null } }),
    makeSession({ id: 'nogit', startCwd: repo.root, cwds: [repo.root] }),
  ]);
  const pty = recordingPty();
  const audit = memoryAudit();
  const ctx = createTestContext({ config: () => cfg, sessions, pty, audit });
  ctx.worktrees = createWorktreeService(ctx);
  ctx.checkpoints = createCheckpointService(ctx);
  ctx.diff = createDiffService(ctx);
  await ctx.worktrees.createWith({ repo: repo.dir, base: 'main', type: 'feat', ticket: 'SAF-20', slug: 'review' }, { runSetup: false, actor: 'user' });
  repo.write('.worktrees/feat-SAF-20-review/src/a.ts', 'export const a = 5;\n');
  upsertPrStatus(ctx.db, {
    pr: { repo: 'o/r', number: 20, url: 'https://github.com/o/r/pull/20' }, state: 'open', title: 'SAF-20', checks: 'failure',
    review: 'changes_requested', updatedAt: '2026-09-17T10:00:00Z', headRef: 'feat/SAF-20-review', failedChecks: ['unit'],
  }, '2026-09-17T10:00:00Z');
  await ctx.checkpoints.create('claude:own', wtPath, 1);
  return { ctx, pty, audit, svc: createReviewService(ctx), wtPath };
}

describe('ReviewService.summary', () => {
  it('collects files, totals, tests, redacted recap, PR, ownership and checkpoints', async () => {
    const { svc, wtPath } = await setup();
    const s = await svc.summary('claude', 'own');
    expect(s.sessionPk).toBe('claude:own');
    expect(s.cwd).toBe(wtPath);
    expect(s.worktree?.branch).toBe('feat/SAF-20-review');
    expect(s.files).toEqual([{ path: 'src/a.ts', additions: 1, deletions: 3 }]);
    expect(s.additions).toBe(1);
    expect(s.deletions).toBe(3);
    expect(s.lastTest?.failed).toBe(1);
    expect(s.recap).toBe('Changed a.ts; token «redacted:github» used');
    expect(s.pr).toMatchObject({ checks: 'failure', failedChecks: ['unit'] });
    expect(s.owned).toBe(true);
    expect(s.checkpoints).toHaveLength(1);
  });

  it('handles a missing recap and an observed session', async () => {
    const { svc } = await setup();
    const s = await svc.summary('claude', 'watch');
    expect(s.recap).toBeNull();
    expect(s.owned).toBe(false);
    expect(s.pr?.pr.number).toBe(20);
  });

  it('fails clearly for unknown sessions and non-git cwds', async () => {
    const { svc } = await setup();
    await expect(svc.summary('claude', 'missing')).rejects.toMatchObject({ code: 'not_found' });
    await expect(svc.summary('claude', 'nogit')).rejects.toMatchObject({ code: 'no_worktree' });
  });
});

describe('ReviewService.sendComments', () => {
  const comments = [{ file: 'src/a.ts', line: 1, side: 'new' as const, body: 'use a constant' }];

  it('sends the structured prompt to an owned session and audits it', async () => {
    const { svc, pty, audit } = await setup();
    const r = await svc.sendComments('claude', 'own', comments, 'session');
    expect(r.sent).toBe(true);
    expect(r.text).toContain('1. src/a.ts:1\n   use a constant');
    expect(r.text).toContain('(branch feat/SAF-20-review)');
    expect(pty.texts).toEqual([{ id: 'pty-7', text: r.text }]);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'review.send', target: 'claude:own', result: 'ok' });
  });

  it('returns text for observed sessions and for text delivery', async () => {
    const { svc, pty } = await setup();
    expect((await svc.sendComments('claude', 'watch', comments, 'session')).sent).toBe(false);
    expect((await svc.sendComments('claude', 'own', comments, 'text')).sent).toBe(false);
    expect(pty.texts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/review/review.test.ts`
Expected: FAIL, `Cannot find module './review.ts'`

- [ ] **Step 3: Implement**

`apps/daemon/src/services/review/review.ts`
```ts
import {
  buildReviewPrompt,
  redact,
  type LiveState,
  type PrStatus,
  type ReviewComment,
  type ReviewSummary,
  type Session,
  type Source,
} from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { getPrStatus } from '../../db/repos/pr-cache.ts';
import { runAudited } from '../git/audit.ts';
import { GitError, repoRoot } from '../git/exec.ts';
import { sessionPk } from '../sessions.ts';

export interface ReviewService {
  summary(source: Source, id: string): Promise<ReviewSummary>;
  sendComments(source: Source, id: string, comments: ReviewComment[], deliver: 'session' | 'text'): Promise<{ sent: boolean; text: string }>;
}

export function isOwned(s: Session): s is Session & { live: LiveState & { ptyId: string } } {
  return s.live?.ownership === 'owned' && typeof s.live.ptyId === 'string' && s.live.ptyId !== '';
}

export function sessionWorkdir(s: Session): string {
  return s.cwds[s.cwds.length - 1] ?? s.startCwd;
}

export function createReviewService(ctx: DaemonContext): ReviewService {
  function load(source: Source, id: string): Session {
    const s = ctx.sessions.get(source, id);
    if (!s) throw new GitError('not_found', `session ${source}:${id} not found`);
    return s;
  }

  function prFor(s: Session, fromWorktree: PrStatus | null): PrStatus | null {
    if (fromWorktree) return fromWorktree;
    const ref = s.prs[s.prs.length - 1];
    return ref ? getPrStatus(ctx.db, ref.repo, ref.number) : null;
  }

  async function summary(source: Source, id: string): Promise<ReviewSummary> {
    const s = load(source, id);
    const pk = sessionPk(source, id);
    const workdir = sessionWorkdir(s);
    const wt = ctx.worktrees?.findByCwd(workdir) ?? null;
    const cwd = wt?.path ?? (await repoRoot(workdir));
    if (!cwd) throw new GitError('no_worktree', `${workdir} is not inside a git checkout`);
    if (!ctx.diff) throw new Error('diff service missing');
    const d = await ctx.diff.diff(cwd);
    const recapSource = s.recap ?? null;
    return {
      sessionPk: pk,
      cwd,
      worktree: wt,
      files: d.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
      additions: d.additions,
      deletions: d.deletions,
      lastTest: s.lastTest,
      recap: recapSource === null ? null : redact(recapSource),
      pr: prFor(s, wt?.prStatus ?? null),
      owned: isOwned(s),
      checkpoints: ctx.checkpoints?.list(pk) ?? [],
    };
  }

  async function sendComments(source: Source, id: string, comments: ReviewComment[], deliver: 'session' | 'text') {
    const s = load(source, id);
    const pk = sessionPk(source, id);
    const wt = ctx.worktrees?.findByCwd(sessionWorkdir(s)) ?? null;
    const text = buildReviewPrompt(comments, { branch: wt?.branch ?? null });
    if (deliver === 'text' || !isOwned(s)) return { sent: false, text };
    const ptyId = s.live.ptyId;
    await runAudited(ctx, 'user', 'review.send', pk, { comments: comments.length, ptyId }, () => ctx.pty.sendText(ptyId, text));
    return { sent: true, text };
  }

  return { summary, sendComments };
}
```

In `apps/daemon/src/context.ts` add `import type { ReviewService } from './services/review/review.ts';` and `review?: ReviewService; // P4`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/daemon/src/services/review`
Expected: PASS (5 tests). `src/a.ts` goes from 3 lines to 1, so the file shows `+1 −3`.

- [ ] **Step 5: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon/src/services/review apps/daemon/src/context.ts
git commit -m "feat(daemon): review summary and inline comments sent to owned sessions"
```

---
### Task 13: GithubConnector via `gh` with a 90 s poller and `pr_cache`

**Files:**
- Create: `apps/daemon/src/connectors/github/github.ts`
- Modify: `apps/daemon/src/context.ts` (type `github?` with this connector)
- Test: `apps/daemon/src/connectors/github/github.test.ts`

**Interfaces:**
- Consumes: `gh`, `GitError` (Task 4); `upsertPrStatus`, `getPrStatus`, `listPrStatuses`, `listWorktrees` (Task 5); `prRepoSlug` (Task 7); `ctx.bus`, `ctx.config().github`
- Produces:
  ```ts
  export type { PrStatus } from '@orc/core';
  export interface GithubConnector {
    status(): Promise<'ok' | 'unauthenticated' | 'error'>;
    prStatus(pr: PrRef): Promise<PrStatus>;
    myOpenPrs(): Promise<PrStatus[]>;
    poll(): Promise<void>;
    watch(pr: PrRef): void;          // adds a PR to the poll set (used by ShipService after create)
    start(): () => void;             // poll now and every cfg.github.pollSeconds; returns stop()
  }
  export interface GhPrJson { number: number; url: string; title: string; state: string; headRefName?: string; updatedAt: string; reviewDecision?: string | null; statusCheckRollup?: Array<Record<string, unknown>> | null }
  export function mapPrJson(repo: string, j: GhPrJson): PrStatus
  export const GH_PR_FIELDS: string        // 'number,url,title,state,headRefName,updatedAt,reviewDecision,statusCheckRollup'
  export function createGithubConnector(ctx: DaemonContext): GithubConnector
  ```
  `poll()` also emits `{ type: 'pr.reviewRequested', pr, title, active }` when a PR starts or stops requesting my review. `poll()` emits `{ type: 'pr.changed', before, after }` and `{ type: 'pr.updated', status }` only when state, checks, review, failed checks or `updatedAt` changed. Polls never overlap.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/connectors/github/github.test.ts`
```ts
import { OrcConfig } from '@orc/api-contract';
import type { PrStatus } from '@orc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeGh, type FakePr, useFakeGh } from '../../../test/fake-gh.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { stubSessions } from '../../../test/stubs.ts';
import { getPrStatus, upsertPrStatus } from '../../db/repos/pr-cache.ts';
import { createGithubConnector, mapPrJson } from './github.ts';

let fake: FakeGh;
afterEach(() => fake.restore());

const fakePr = (p: Partial<FakePr> = {}): FakePr => ({
  repo: 'example-org/temp-repo', number: 7, url: 'https://github.com/example-org/temp-repo/pull/7', title: 'SAF-1 thing',
  state: 'OPEN', headRefName: 'feat/SAF-1-thing', baseRefName: 'main', body: '', updatedAt: '2026-09-17T10:00:00Z',
  reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [], ...p,
});

function setup(initial: Parameters<typeof useFakeGh>[0] = {}, github = {}) {
  fake = useFakeGh(initial);
  const cfg = OrcConfig.parse({ github });
  const ctx = createTestContext({ config: () => cfg, sessions: stubSessions([]) });
  const changes: Array<{ before: PrStatus | null; after: PrStatus }> = [];
  ctx.bus.on('pr.changed', (e) => changes.push({ before: e.before, after: e.after }));
  return { ctx, gh: createGithubConnector(ctx), changes };
}

describe('mapPrJson', () => {
  const base = { number: 1, url: 'u', title: 't', state: 'OPEN', headRefName: 'h', updatedAt: 'x' };
  it('maps failing, pending, passing and missing checks', () => {
    expect(mapPrJson('o/r', { ...base, statusCheckRollup: [
      { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'StatusContext', context: 'lint', state: 'ERROR' },
      { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '' },
    ] })).toMatchObject({ checks: 'failure', failedChecks: ['unit', 'lint'] });
    expect(mapPrJson('o/r', { ...base, statusCheckRollup: [{ __typename: 'StatusContext', context: 'ci', state: 'PENDING' }] }).checks).toBe('pending');
    expect(mapPrJson('o/r', { ...base, statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SKIPPED' }] }).checks).toBe('success');
    expect(mapPrJson('o/r', { ...base, statusCheckRollup: null }).checks).toBe('none');
  });
  it('maps state and review decision', () => {
    expect(mapPrJson('o/r', { ...base, state: 'MERGED', reviewDecision: 'APPROVED' })).toMatchObject({ state: 'merged', review: 'approved' });
    expect(mapPrJson('o/r', { ...base, state: 'CLOSED', reviewDecision: '' })).toMatchObject({ state: 'closed', review: 'none' });
    expect(mapPrJson('o/r', { ...base, reviewDecision: 'CHANGES_REQUESTED' }).review).toBe('changes_requested');
  });
});

describe('GithubConnector', () => {
  it('reports auth status', async () => {
    expect(await setup({ authed: false }).gh.status()).toBe('unauthenticated');
    fake.restore();
    expect(await setup().gh.status()).toBe('ok');
  });

  it('reads one PR and my open PRs', async () => {
    const { gh } = setup();
    fake.setPr(fakePr());
    fake.setPr(fakePr({ number: 8, url: 'https://github.com/example-org/temp-repo/pull/8', state: 'MERGED' }));
    const one = await gh.prStatus({ repo: 'example-org/temp-repo', number: 7, url: '' });
    expect(one).toMatchObject({ state: 'open', review: 'review_required', headRef: 'feat/SAF-1-thing' });
    expect((await gh.myOpenPrs()).map((p) => p.pr.number)).toEqual([7]);
    expect(fake.calls().some((c) => c[0] === 'search' && c.includes('--author=@me'))).toBe(true);
  });

  it('emits pr.changed only on real changes, including PRs that left my open list', async () => {
    const { ctx, gh, changes } = setup();
    fake.setPr(fakePr());
    await gh.poll();
    expect(changes).toHaveLength(1);
    expect(changes[0]?.before).toBeNull();
    await gh.poll();
    expect(changes).toHaveLength(1);
    fake.setPr(fakePr({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }], updatedAt: '2026-09-17T10:05:00Z' }));
    await gh.poll();
    expect(changes[1]?.after.checks).toBe('failure');
    fake.setPr(fakePr({ state: 'MERGED', updatedAt: '2026-09-17T11:00:00Z' }));
    await gh.poll();
    expect(changes[2]).toMatchObject({ before: { state: 'open' }, after: { state: 'merged' } });
    expect(getPrStatus(ctx.db, 'example-org/temp-repo', 7)?.state).toBe('merged');
    await gh.poll();
    expect(changes).toHaveLength(3);
  });

  it('polls watched PRs that are not mine and skips when disabled', async () => {
    const { gh, changes } = setup();
    fake.setPr(fakePr({ number: 9, url: 'https://github.com/example-org/temp-repo/pull/9', state: 'CLOSED' }));
    gh.watch({ repo: 'example-org/temp-repo', number: 9, url: 'https://github.com/example-org/temp-repo/pull/9' });
    await gh.poll();
    expect(changes.map((c) => c.after.pr.number)).toEqual([9]);
    fake.restore();
    const off = setup({}, { enabled: false });
    fake.setPr(fakePr());
    await off.gh.poll();
    expect(off.changes).toEqual([]);
    expect(fake.calls()).toEqual([]);
  });

  it('emits review requests when they appear and disappear', async () => {
    const { ctx, gh } = setup();
    const seen: Array<[number, boolean]> = [];
    ctx.bus.on('pr.reviewRequested', (e) => seen.push([e.pr.number, e.active]));
    fake.setPr(fakePr({ number: 30, url: 'https://github.com/example-org/temp-repo/pull/30', reviewRequested: true }));
    await gh.poll();
    await gh.poll();
    expect(seen).toEqual([[30, true]]);
    fake.setPr(fakePr({ number: 30, url: 'https://github.com/example-org/temp-repo/pull/30', reviewRequested: true, state: 'MERGED' }));
    await gh.poll();
    expect(seen).toEqual([[30, true], [30, false]]);
  });

  it('keeps polling cached open PRs', async () => {
    const { ctx, gh, changes } = setup();
    upsertPrStatus(ctx.db, mapPrJson('example-org/temp-repo', { number: 7, url: 'https://github.com/example-org/temp-repo/pull/7', title: 't', state: 'OPEN', headRefName: 'feat/SAF-1-thing', updatedAt: '2026-09-17T09:00:00Z' }), '2026-09-17T09:00:00Z');
    fake.setPr(fakePr({ state: 'MERGED' }));
    await gh.poll();
    expect(changes[0]?.after.state).toBe('merged');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/connectors/github`
Expected: FAIL, `Cannot find module './github.ts'`

- [ ] **Step 3: Implement**

`apps/daemon/src/connectors/github/github.ts`
```ts
import type { PrRef, PrStatus } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { getPrStatus, listPrStatuses, upsertPrStatus } from '../../db/repos/pr-cache.ts';
import { listWorktrees } from '../../db/repos/worktrees.ts';
import { GitError, gh } from '../../services/git/exec.ts';
import { prRepoSlug } from '../../services/worktree/worktree-read.ts';

export type { PrStatus } from '@orc/core';

export interface GithubConnector {
  status(): Promise<'ok' | 'unauthenticated' | 'error'>;
  prStatus(pr: PrRef): Promise<PrStatus>;
  myOpenPrs(): Promise<PrStatus[]>;
  poll(): Promise<void>;
  watch(pr: PrRef): void;
  start(): () => void;
}

export interface GhPrJson {
  number: number;
  url: string;
  title: string;
  state: string;
  headRefName?: string;
  updatedAt: string;
  reviewDecision?: string | null;
  statusCheckRollup?: Array<Record<string, unknown>> | null;
}

export const GH_PR_FIELDS = 'number,url,title,state,headRefName,updatedAt,reviewDecision,statusCheckRollup';

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function mapPrJson(repo: string, j: GhPrJson): PrStatus {
  const rollup = j.statusCheckRollup ?? [];
  const failed: string[] = [];
  let pending = false;
  for (const c of rollup) {
    if (c.__typename === 'StatusContext') {
      const state = str(c.state);
      if (state === 'FAILURE' || state === 'ERROR') failed.push(str(c.context));
      else if (state === 'PENDING' || state === 'EXPECTED') pending = true;
    } else {
      if (str(c.status) !== 'COMPLETED') pending = true;
      else if (FAILED_CONCLUSIONS.has(str(c.conclusion))) failed.push(str(c.name));
    }
  }
  const checks: PrStatus['checks'] = rollup.length === 0 ? 'none' : failed.length > 0 ? 'failure' : pending ? 'pending' : 'success';
  const review: PrStatus['review'] =
    j.reviewDecision === 'APPROVED'
      ? 'approved'
      : j.reviewDecision === 'CHANGES_REQUESTED'
        ? 'changes_requested'
        : j.reviewDecision === 'REVIEW_REQUIRED'
          ? 'review_required'
          : 'none';
  const state: PrStatus['state'] = j.state === 'MERGED' ? 'merged' : j.state === 'CLOSED' ? 'closed' : 'open';
  return {
    pr: { repo, number: j.number, url: j.url },
    state,
    title: j.title,
    checks,
    review,
    updatedAt: j.updatedAt,
    headRef: j.headRefName ?? null,
    failedChecks: failed,
  };
}

const keyOf = (p: PrRef) => `${p.repo}#${p.number}`;
const signature = (s: PrStatus) => JSON.stringify([s.state, s.checks, s.review, s.failedChecks, s.updatedAt]);

export function createGithubConnector(ctx: DaemonContext): GithubConnector {
  const watched = new Map<string, PrRef>();
  let lastRequested = new Map<string, PrRef & { title: string }>();
  let polling: Promise<void> | null = null;

  async function status(): Promise<'ok' | 'unauthenticated' | 'error'> {
    try {
      const r = await gh(['auth', 'status']);
      return r.exitCode === 0 ? 'ok' : 'unauthenticated';
    } catch {
      return 'error';
    }
  }

  async function prStatus(pr: PrRef): Promise<PrStatus> {
    const r = await gh(['pr', 'view', String(pr.number), '--repo', pr.repo, '--json', GH_PR_FIELDS]);
    if (r.exitCode !== 0) {
      const code = /not logged|authenticat/i.test(r.stderr) ? 'gh_unavailable' : 'git_failed';
      throw new GitError(code, `gh pr view ${pr.repo}#${pr.number} failed: ${r.stderr.trim()}`, r.stderr);
    }
    return mapPrJson(pr.repo, JSON.parse(r.stdout) as GhPrJson);
  }

  async function myOpenRefs(): Promise<PrRef[]> {
    const r = await gh(['search', 'prs', '--author=@me', '--state=open', '--json', 'number,repository,url,title,updatedAt', '--limit', '50']);
    if (r.exitCode !== 0) throw new GitError('gh_unavailable', `gh search prs failed: ${r.stderr.trim()}`, r.stderr);
    const rows = JSON.parse(r.stdout) as Array<{ number: number; url: string; repository: { nameWithOwner: string } }>;
    return rows.map((x) => ({ repo: x.repository.nameWithOwner, number: x.number, url: x.url }));
  }

  async function reviewRequestedRefs(): Promise<Array<PrRef & { title: string }>> {
    const r = await gh(['search', 'prs', '--review-requested=@me', '--state=open', '--json', 'number,repository,url,title', '--limit', '50']);
    if (r.exitCode !== 0) throw new GitError('gh_unavailable', `gh search prs failed: ${r.stderr.trim()}`, r.stderr);
    const rows = JSON.parse(r.stdout) as Array<{ number: number; url: string; title: string; repository: { nameWithOwner: string } }>;
    return rows.map((x) => ({ repo: x.repository.nameWithOwner, number: x.number, url: x.url, title: x.title }));
  }

  async function myOpenPrs(): Promise<PrStatus[]> {
    const refs = await myOpenRefs();
    return Promise.all(refs.map(prStatus));
  }

  async function pollOnce(): Promise<void> {
    if (!ctx.config().github.enabled) return;
    const refs = new Map<string, PrRef>();
    try {
      for (const ref of await myOpenRefs()) refs.set(keyOf(ref), ref);
    } catch (err) {
      ctx.log.warn({ err }, 'github: listing my PRs failed');
      return;
    }
    for (const s of listPrStatuses(ctx.db, { state: 'open' })) refs.set(keyOf(s.pr), s.pr);
    for (const w of listWorktrees(ctx.db, { state: 'active' })) {
      const slug = prRepoSlug(w.prUrl);
      if (slug && w.prUrl) refs.set(`${slug.repo}#${slug.number}`, { ...slug, url: w.prUrl });
    }
    for (const [k, ref] of watched) refs.set(k, ref);

    for (const ref of refs.values()) {
      let after: PrStatus;
      try {
        after = await prStatus(ref);
      } catch (err) {
        ctx.log.warn({ err, pr: keyOf(ref) }, 'github: PR status failed');
        continue;
      }
      const before = getPrStatus(ctx.db, ref.repo, ref.number);
      if (after.state !== 'open') watched.delete(keyOf(ref));
      if (before && signature(before) === signature(after)) continue;
      upsertPrStatus(ctx.db, after, new Date().toISOString());
      ctx.bus.emit({ type: 'pr.changed', before, after });
      ctx.bus.emit({ type: 'pr.updated', status: after });
    }

    try {
      const now = new Map((await reviewRequestedRefs()).map((r) => [keyOf(r), r]));
      for (const [k, r] of now) {
        if (!lastRequested.has(k)) ctx.bus.emit({ type: 'pr.reviewRequested', pr: { repo: r.repo, number: r.number, url: r.url }, title: r.title, active: true });
      }
      for (const [k, r] of lastRequested) {
        if (!now.has(k)) ctx.bus.emit({ type: 'pr.reviewRequested', pr: { repo: r.repo, number: r.number, url: r.url }, title: r.title, active: false });
      }
      lastRequested = now;
    } catch (err) {
      ctx.log.warn({ err }, 'github: listing review requests failed');
    }
  }

  function poll(): Promise<void> {
    polling ??= pollOnce().finally(() => {
      polling = null;
    });
    return polling;
  }

  function start(): () => void {
    const run = () => {
      poll().catch((err: unknown) => ctx.log.warn({ err }, 'github poll failed'));
    };
    run();
    const timer = setInterval(run, ctx.config().github.pollSeconds * 1000);
    timer.unref();
    return () => clearInterval(timer);
  }

  return {
    status,
    prStatus,
    myOpenPrs,
    poll,
    watch: (pr) => {
      watched.set(keyOf(pr), pr);
    },
    start,
  };
}
```

In `apps/daemon/src/context.ts` set `github?: GithubConnector;` with `import type { GithubConnector } from './connectors/github/github.ts';`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/daemon/src/connectors/github`
Expected: PASS (8 tests). The disabled case makes no `gh` calls at all.

- [ ] **Step 5: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon/src/connectors/github apps/daemon/src/context.ts
git commit -m "feat(daemon): GitHub connector polling PR checks and reviews through gh"
```

---
### Task 14: PR inbox rule and auto-archive when a PR merges

**Files:**
- Create: `apps/daemon/src/inbox/rules/pr-event.ts`, `apps/daemon/src/services/worktree/auto-archive.ts`
- Test: `apps/daemon/src/inbox/rules/pr-event.test.ts`, `apps/daemon/src/services/worktree/auto-archive.test.ts`

**Interfaces:**
- Consumes: `InboxRule`, `InboxEngine` (§11 P2); bus events `pr.changed`, `pr.reviewRequested` (Tasks 1, 13); `listWorktrees` (Task 5); `ticketFromBranch` (Task 2); `WorktreeService.archiveAs` (Task 9); `GitError` (Task 4)
- Produces:
  ```ts
  // inbox/rules/pr-event.ts
  export const prEventRule: InboxRule                 // name 'pr-event', on ['pr.changed', 'pr.reviewRequested']
  export function prKey(pr: PrRef, kind: 'checks' | 'review' | 'review_requested'): string
  // services/worktree/auto-archive.ts
  export function registerAutoArchive(ctx: DaemonContext): () => void
  export function worktreesForPr(ctx: DaemonContext, s: PrStatus): WorktreeRow[]
  ```
  Inbox items set `sessionId` to the linked session **pk** (the same convention P2 rules use) and `payload` to `{ pr, cwd, event, failedChecks?, headRef, presetId, vars }` (`cwd` is the linked worktree path or `null`), where `presetId` is `preset-fix-ci` or `preset-address-comments` so the UI can offer the one-click preset.

- [ ] **Step 1: Write the failing rule test**

`apps/daemon/src/inbox/rules/pr-event.test.ts`
```ts
import type { BusEvent } from '../../live/event-bus.ts';
import type { PrStatus } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../../../test/helpers.ts';
import { recordingInbox, stubSessions } from '../../../test/stubs.ts';
import { upsertWorktree } from '../../db/repos/worktrees.ts';
import { prEventRule, prKey } from './pr-event.ts';

const pr = { repo: 'o/r', number: 4, url: 'https://github.com/o/r/pull/4' };
const status = (p: Partial<PrStatus> = {}): PrStatus => ({
  pr, state: 'open', title: 'SAF-44 thing', checks: 'pending', review: 'review_required',
  updatedAt: '2026-09-17T10:00:00Z', headRef: 'feat/SAF-44-thing', failedChecks: [], ...p,
});

function setup() {
  const inbox = recordingInbox();
  const ctx = createTestContext({ inbox, sessions: stubSessions([]) });
  upsertWorktree(ctx.db, {
    path: '/r/.worktrees/feat-SAF-44-thing', repo: '/r', branch: 'feat/SAF-44-thing', base: 'main', ticket: 'SAF-44', dirty: false,
    prUrl: pr.url, state: 'active', createdByApp: true, head: null, isMain: false, origin: 'app', sessionPks: ['claude:s44'],
    projectId: 'wakecap', createdAt: '2026-09-17T09:00:00Z', updatedAt: '2026-09-17T09:00:00Z', archivedAt: null,
  });
  const fire = (e: BusEvent) => prEventRule.handle(e, ctx);
  return { inbox, fire };
}

describe('prEventRule', () => {
  it('opens a checks item with the failing checks and the fix-CI preset', () => {
    const { inbox, fire } = setup();
    fire({ type: 'pr.changed', before: status(), after: status({ checks: 'failure', failedChecks: ['unit', 'lint'] }) });
    expect(inbox.upserts).toEqual([
      {
        kind: 'pr_event',
        dedupeKey: prKey(pr, 'checks'),
        sessionId: 'claude:s44',
        projectId: 'wakecap',
        ticket: 'SAF-44',
        reason: 'CI failed on o/r#4: unit, lint',
        payload: {
          pr, cwd: '/r/.worktrees/feat-SAF-44-thing', event: 'checks_failed', failedChecks: ['unit', 'lint'], headRef: 'feat/SAF-44-thing',
          presetId: 'preset-fix-ci', vars: { prUrl: pr.url, check: 'unit', ticket: 'SAF-44' },
        },
      },
    ]);
  });

  it('resolves the checks item when checks recover and opens a review item on changes requested', () => {
    const { inbox, fire } = setup();
    fire({ type: 'pr.changed', before: status({ checks: 'failure' }), after: status({ checks: 'success', review: 'changes_requested' }) });
    expect(inbox.resolved).toEqual([prKey(pr, 'checks')]);
    expect(inbox.upserts[0]).toMatchObject({
      dedupeKey: 'pr:o/r#4:review',
      reason: 'Changes requested on o/r#4',
      payload: { event: 'changes_requested', presetId: 'preset-address-comments' },
    });
  });

  it('resolves everything when the PR merges', () => {
    const { inbox, fire } = setup();
    fire({ type: 'pr.changed', before: status({ checks: 'failure', review: 'changes_requested' }), after: status({ state: 'merged', checks: 'success', review: 'approved' }) });
    expect(inbox.upserts).toEqual([]);
    expect(inbox.resolved.sort()).toEqual(['pr:o/r#4:checks', 'pr:o/r#4:review']);
  });

  it('does nothing for a first sighting that is healthy', () => {
    const { inbox, fire } = setup();
    fire({ type: 'pr.changed', before: null, after: status() });
    expect(inbox.upserts).toEqual([]);
    expect(inbox.resolved).toEqual([]);
  });

  it('tracks review requests from other people', () => {
    const { inbox, fire } = setup();
    const other = { repo: 'o/x', number: 9, url: 'https://github.com/o/x/pull/9' };
    fire({ type: 'pr.reviewRequested', pr: other, title: 'TAN-9 new api', active: true });
    expect(inbox.upserts[0]).toMatchObject({
      kind: 'pr_event', dedupeKey: 'pr:o/x#9:review_requested', ticket: 'TAN-9', sessionId: null,
      reason: 'Review requested: TAN-9 new api (o/x#9)', payload: { event: 'review_requested', presetId: null },
    });
    fire({ type: 'pr.reviewRequested', pr: other, title: 'TAN-9 new api', active: false });
    expect(inbox.resolved).toEqual(['pr:o/x#9:review_requested']);
  });
});
```

- [ ] **Step 2: Implement the rule**

`apps/daemon/src/inbox/rules/pr-event.ts`
```ts
import { ticketFromBranch, type PrRef, type PrStatus } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { listWorktrees } from '../../db/repos/worktrees.ts';
import type { InboxRule } from '../engine.ts';

export function prKey(pr: PrRef, kind: 'checks' | 'review' | 'review_requested'): string {
  return `pr:${pr.repo}#${pr.number}:${kind}`;
}

function linkFor(ctx: DaemonContext, s: PrStatus) {
  const wt = listWorktrees(ctx.db, { state: 'active' }).find((w) => w.prUrl === s.pr.url || (s.headRef !== null && w.branch === s.headRef));
  return {
    cwd: wt?.path ?? null,
    sessionId: wt?.sessionPks[0] ?? null,
    projectId: wt?.projectId ?? null,
    ticket: wt?.ticket ?? (s.headRef ? ticketFromBranch(s.headRef, null) : null) ?? ticketFromBranch(s.title, null),
  };
}

export const prEventRule: InboxRule = {
  name: 'pr-event',
  on: ['pr.changed', 'pr.reviewRequested'],
  handle(e, ctx) {
    const inbox = ctx.inbox;
    if (!inbox) return;

    if (e.type === 'pr.reviewRequested') {
      const key = prKey(e.pr, 'review_requested');
      if (!e.active) {
        inbox.resolve(key);
        return;
      }
      inbox.upsert({
        kind: 'pr_event',
        dedupeKey: key,
        sessionId: null,
        projectId: null,
        ticket: ticketFromBranch(e.title, null),
        reason: `Review requested: ${e.title} (${e.pr.repo}#${e.pr.number})`,
        payload: { pr: e.pr, cwd: null, event: 'review_requested', presetId: null, vars: { prUrl: e.pr.url } },
      });
      return;
    }
    if (e.type !== 'pr.changed') return;

    const { before, after } = e;
    const label = `${after.pr.repo}#${after.pr.number}`;
    const checksKey = prKey(after.pr, 'checks');
    const reviewKey = prKey(after.pr, 'review');

    if (after.state !== 'open') {
      if (before?.checks === 'failure') inbox.resolve(checksKey);
      if (before?.review === 'changes_requested') inbox.resolve(reviewKey);
      return;
    }

    const { cwd, ...link } = linkFor(ctx, after);
    const vars = { prUrl: after.pr.url, ...(link.ticket ? { ticket: link.ticket } : {}) };

    if (after.checks === 'failure') {
      inbox.upsert({
        kind: 'pr_event',
        dedupeKey: checksKey,
        ...link,
        reason: `CI failed on ${label}: ${after.failedChecks.join(', ') || 'unknown check'}`,
        payload: {
          pr: after.pr,
          cwd,
          event: 'checks_failed',
          failedChecks: after.failedChecks,
          headRef: after.headRef,
          presetId: 'preset-fix-ci',
          vars: { prUrl: after.pr.url, check: after.failedChecks[0] ?? '', ...(link.ticket ? { ticket: link.ticket } : {}) },
        },
      });
    } else if (before?.checks === 'failure') {
      inbox.resolve(checksKey);
    }

    if (after.review === 'changes_requested') {
      inbox.upsert({
        kind: 'pr_event',
        dedupeKey: reviewKey,
        ...link,
        reason: `Changes requested on ${label}`,
        payload: { pr: after.pr, cwd, event: 'changes_requested', headRef: after.headRef, presetId: 'preset-address-comments', vars },
      });
    } else if (before?.review === 'changes_requested') {
      inbox.resolve(reviewKey);
    }
  },
};
```

- [ ] **Step 3: Run the rule test**

Run: `pnpm vitest run apps/daemon/src/inbox/rules/pr-event.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 4: Write the failing auto-archive test**

`apps/daemon/src/services/worktree/auto-archive.test.ts`
```ts
import { existsSync } from 'node:fs';
import { OrcConfig } from '@orc/api-contract';
import type { PrStatus } from '@orc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { memoryAudit, recordingInbox, stubSessions } from '../../../test/stubs.ts';
import { getWorktree, upsertWorktree } from '../../db/repos/worktrees.ts';
import { registerAutoArchive } from './auto-archive.ts';
import { createWorktreeService } from './worktree.ts';

let repo: TempRepo;
afterEach(() => repo.cleanup());

const merged = (url: string, headRef: string, beforeState: PrStatus['state'] = 'open') => {
  const base: PrStatus = {
    pr: { repo: 'o/r', number: 1, url }, state: beforeState, title: 't', checks: 'success', review: 'approved',
    updatedAt: '2026-09-17T10:00:00Z', headRef, failedChecks: [],
  };
  return { type: 'pr.changed' as const, before: base, after: { ...base, state: 'merged' as const, updatedAt: '2026-09-17T11:00:00Z' } };
};
const flush = () => new Promise((r) => setTimeout(r, 150));

async function setup(autoArchiveOnMerge = true) {
  repo = makeTempRepo();
  const cfg = OrcConfig.parse({
    projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root], repos: [{ path: repo.dir }] }],
    worktrees: { autoArchiveOnMerge },
  });
  const audit = memoryAudit();
  const inbox = recordingInbox();
  const ctx = createTestContext({ config: () => cfg, audit, inbox, pty: recordingPty(), sessions: stubSessions([]) });
  ctx.worktrees = createWorktreeService(ctx);
  const { view } = await ctx.worktrees.createWith({ repo: repo.dir, base: 'main', type: 'feat', ticket: 'SAF-50', slug: 'merge me' }, { runSetup: false, actor: 'user' });
  const url = 'https://github.com/o/r/pull/1';
  const row = getWorktree(ctx.db, view.path);
  if (!row) throw new Error('no row');
  upsertWorktree(ctx.db, { ...row, prUrl: url });
  const off = registerAutoArchive(ctx);
  return { ctx, view, url, audit, inbox, off, row: { ...row, prUrl: url } };
}

describe('registerAutoArchive', () => {
  it('archives an app worktree when its PR merges, as the automation actor', async () => {
    const { ctx, view, url, audit, off } = await setup();
    ctx.bus.emit(merged(url, view.branch));
    await flush();
    expect(existsSync(view.path)).toBe(false);
    expect(audit.entries.find((e) => e.action === 'worktree.archive')).toMatchObject({ actor: 'automation', result: 'ok' });
    off();
  });

  it('leaves dirty and external worktrees in place and raises an inbox item', async () => {
    const { ctx, view, url, inbox, row, off } = await setup();
    repo.write('.worktrees/feat-SAF-50-merge-me/src/a.ts', 'dirty\n');
    ctx.bus.emit(merged(url, view.branch));
    await flush();
    expect(existsSync(view.path)).toBe(true);
    expect(inbox.upserts.at(-1)).toMatchObject({ kind: 'pr_event', dedupeKey: `worktree:${view.path}:archive_blocked` });
    expect(inbox.upserts.at(-1)?.reason).toContain('uncommitted changes');

    upsertWorktree(ctx.db, { ...row, createdByApp: false, origin: 'worktree-dir' });
    ctx.bus.emit(merged(url, view.branch));
    await flush();
    expect(existsSync(view.path)).toBe(true);
    expect(inbox.upserts.at(-1)?.reason).toContain('not created by the app');
    off();
  });

  it('respects the setting and ignores non-transitions', async () => {
    const { ctx, view, url, off } = await setup(false);
    ctx.bus.emit(merged(url, view.branch));
    await flush();
    expect(existsSync(view.path)).toBe(true);
    off();
    const again = await (async () => {
      repo.cleanup();
      return setup(true);
    })();
    again.ctx.bus.emit(merged(again.url, again.view.branch, 'merged'));
    await flush();
    expect(existsSync(again.view.path)).toBe(true);
    again.off();
  });
});
```

- [ ] **Step 5: Implement the auto-archiver**

`apps/daemon/src/services/worktree/auto-archive.ts`
```ts
import type { PrStatus } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { listWorktrees, type WorktreeRow } from '../../db/repos/worktrees.ts';
import { GitError } from '../git/exec.ts';

export function worktreesForPr(ctx: DaemonContext, s: PrStatus): WorktreeRow[] {
  return listWorktrees(ctx.db, { state: 'active' }).filter(
    (w) => !w.isMain && (w.prUrl === s.pr.url || (w.prUrl === null && s.headRef !== null && w.branch === s.headRef)),
  );
}

export function registerAutoArchive(ctx: DaemonContext): () => void {
  const blocked = (w: WorktreeRow, s: PrStatus, why: string) =>
    ctx.inbox?.upsert({
      kind: 'pr_event',
      dedupeKey: `worktree:${w.path}:archive_blocked`,
      sessionId: w.sessionPks[0] ?? null,
      projectId: w.projectId,
      ticket: w.ticket,
      reason: `${s.pr.repo}#${s.pr.number} merged; worktree kept because ${why}`,
      payload: { pr: s.pr, event: 'archive_blocked', path: w.path, presetId: null, vars: {} },
    });

  return ctx.bus.on('pr.changed', (e) => {
    if (e.after.state !== 'merged' || e.before?.state === 'merged') return;
    if (!ctx.config().worktrees.autoArchiveOnMerge || !ctx.worktrees) return;
    const worktrees = ctx.worktrees;
    for (const w of worktreesForPr(ctx, e.after)) {
      if (!w.createdByApp) {
        blocked(w, e.after, 'it was not created by the app (archive it yourself)');
        continue;
      }
      worktrees.archiveAs(w.path, 'automation', { allowExternal: false }).catch((err: unknown) => {
        if (err instanceof GitError && err.code === 'dirty_worktree') blocked(w, e.after, 'it has uncommitted changes');
        else {
          ctx.log.warn({ err, path: w.path }, 'auto-archive failed');
          blocked(w, e.after, `archiving failed: ${(err as Error).message}`);
        }
      });
    }
  });
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run apps/daemon/src/inbox/rules/pr-event.test.ts apps/daemon/src/services/worktree/auto-archive.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 7: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon/src/inbox/rules/pr-event.ts apps/daemon/src/inbox/rules/pr-event.test.ts apps/daemon/src/services/worktree/auto-archive.ts apps/daemon/src/services/worktree/auto-archive.test.ts
git commit -m "feat(daemon): PR inbox items and worktree auto-archive on merge"
```

---
### Task 15: ShipService — commit, push, PR, merge, suggestions, backmerge

**Files:**
- Create: `apps/daemon/src/services/ship/ship.ts`
- Modify: `apps/daemon/src/context.ts` (type `ship?` with this service)
- Test: `apps/daemon/src/services/ship/ship.test.ts`

**Interfaces:**
- Consumes: `git`, `gitOut`, `gh`, `GitError` (Task 4); `runAudited` (Task 8); `WorktreeService.findByCwd` (Task 9); `upsertWorktree`, `getWorktree` (Task 5); `defaultBase` (Task 11); `sessionWorkdir` (Task 12); `GithubConnector.watch`, `.poll` (Task 13); `ticketFromBranch`, `redact` (core); `TemplateRegistry.render` (P2); `launchSession(ctx, req)` and `LaunchRequest` (P2)
- Produces:
  ```ts
  export interface ShipSuggestionResult { message: string; title: string; body: string; base: string; branch: string; ticket: string | null }
  export interface ShipService {
    commit(cwd: string, message: string): Promise<{ sha: string }>;
    push(cwd: string): Promise<void>;
    createPr(cwd: string, i: { title: string; body: string; base: string; draft?: boolean }): Promise<PrRef>;
    merge(pr: PrRef, method: 'merge' | 'squash' | 'rebase'): Promise<void>;
    suggest(cwd: string, sessionPk: string | null): Promise<ShipSuggestionResult>;
    backmerge(cwd: string, projectId: string, ticket: string | null): Promise<{ ptyId: string }>;
  }
  export type Launcher = (req: z.infer<typeof LaunchRequest>) => Promise<{ ptyId: string; sessionId: string | null }>;
  export const PR_TEMPLATE_PATHS: readonly string[]
  export async function readPrTemplate(root: string): Promise<string | null>
  export async function currentBranch(cwd: string): Promise<string>
  export function createShipService(ctx: DaemonContext, opts?: { launch?: Launcher }): ShipService
  ```
  Audit actions: `git.commit`, `git.push`, `pr.create`, `pr.merge`, `ship.backmerge`. `GitError` codes: `nothing_to_commit`, `protected_branch`, `push_rejected`. `push` only ever runs `git push -u origin <branch>`; `merge` only ever runs `gh pr merge <n> --repo <r> --merge|--squash|--rebase` (no `--admin`, no `--delete-branch`).

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/services/ship/ship.test.ts`
```ts
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeGh, useFakeGh } from '../../../test/fake-gh.ts';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { makeSession, memoryAudit, stubSessions, stubTemplates } from '../../../test/stubs.ts';
import { createGithubConnector } from '../../connectors/github/github.ts';
import { getWorktree } from '../../db/repos/worktrees.ts';
import { createWorktreeService } from '../worktree/worktree.ts';
import { createShipService, type Launcher } from './ship.ts';

let repo: TempRepo;
let fake: FakeGh;
afterEach(() => {
  repo.cleanup();
  fake.restore();
});

async function setup() {
  repo = makeTempRepo({ withRemote: true });
  fake = useFakeGh({ repo: 'example-org/temp-repo' });
  const cfg = OrcConfig.parse({ projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root], repos: [{ path: repo.dir }] }] });
  const audit = memoryAudit();
  const wtPath = join(repo.dir, '.worktrees', 'feat-SAF-60-ship-it');
  const sessions = stubSessions([
    makeSession({ id: 'ship', startCwd: wtPath, cwds: [wtPath], recap: 'Excluded weekends from the SLA deadline. Added tests.', name: 'SAF-60 ship it' }),
  ]);
  const ctx = createTestContext({ config: () => cfg, audit, sessions, pty: recordingPty(), templates: stubTemplates() });
  ctx.worktrees = createWorktreeService(ctx);
  ctx.github = createGithubConnector(ctx);
  const launched: Array<Parameters<Launcher>[0]> = [];
  const ship = createShipService(ctx, {
    launch: async (req) => {
      launched.push(req);
      return { ptyId: 'pty-bm', sessionId: null };
    },
  });
  const { view } = await ctx.worktrees.createWith({ repo: repo.dir, base: 'main', type: 'feat', ticket: 'SAF-60', slug: 'ship it' }, { runSetup: false, actor: 'user' });
  const write = (rel: string, body: string) => repo.write(join('.worktrees', 'feat-SAF-60-ship-it', rel), body);
  return { ctx, ship, audit, view, write, launched };
}

describe('ShipService.commit and push', () => {
  it('commits all changes, pushes the branch and audits both', async () => {
    const { ship, view, write, audit } = await setup();
    write('src/a.ts', 'export const a = 60;\n');
    write('src/new.ts', 'export const n = 60;\n');
    const { sha } = await ship.commit(view.path, 'feat: SAF-60 ship it');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(repo.git('-C', view.path, 'log', '-1', '--format=%s').trim()).toBe('feat: SAF-60 ship it');
    expect(repo.git('-C', view.path, 'status', '--porcelain')).toBe('');
    await ship.push(view.path);
    const remote = execFileSync('git', ['--git-dir', repo.remote ?? '', 'rev-parse', 'refs/heads/feat/SAF-60-ship-it'], { encoding: 'utf8' }).trim();
    expect(remote).toBe(sha);
    expect(audit.entries.map((e) => [e.action, e.result])).toEqual([
      ['worktree.create', 'ok'],
      ['git.commit', 'ok'],
      ['git.push', 'ok'],
    ]);
  });

  it('refuses empty commits and protected branches', async () => {
    const { ship, view } = await setup();
    await expect(ship.commit(view.path, 'nothing')).rejects.toMatchObject({ code: 'nothing_to_commit' });
    repo.write('src/a.ts', 'on main\n');
    await expect(ship.commit(repo.dir, 'x')).rejects.toMatchObject({ code: 'protected_branch' });
    await expect(ship.push(repo.dir)).rejects.toMatchObject({ code: 'protected_branch' });
  });

  it('reports a rejected push instead of forcing it', async () => {
    const { ship, view, write } = await setup();
    write('src/a.ts', 'one\n');
    await ship.commit(view.path, 'one');
    await ship.push(view.path);
    const other = join(repo.root, 'other');
    execFileSync('git', ['clone', '-q', '-b', 'feat/SAF-60-ship-it', repo.remote ?? '', other]);
    execFileSync('git', ['-C', other, 'commit', '-q', '--allow-empty', '-m', 'someone else'], { encoding: 'utf8' });
    execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'feat/SAF-60-ship-it']);
    write('src/a.ts', 'two\n');
    const mine = (await ship.commit(view.path, 'two')).sha;
    await expect(ship.push(view.path)).rejects.toMatchObject({ code: 'push_rejected' });
    const remote = execFileSync('git', ['--git-dir', repo.remote ?? '', 'rev-parse', 'refs/heads/feat/SAF-60-ship-it'], { encoding: 'utf8' }).trim();
    expect(remote).not.toBe(mine);
  });
});

describe('ShipService.suggest and createPr', () => {
  it('suggests message, title and body from the branch, recap and PR template', async () => {
    const { ship, view, write } = await setup();
    write('.github/pull_request_template.md', '## What\n\n## Testing\n');
    const s = await ship.suggest(view.path, 'claude:ship');
    expect(s).toMatchObject({ branch: 'feat/SAF-60-ship-it', base: 'main', ticket: 'SAF-60' });
    expect(s.message).toBe('feat: SAF-60 Excluded weekends from the SLA deadline');
    expect(s.title).toBe('SAF-60 Excluded weekends from the SLA deadline');
    expect(s.body).toContain('## What');
    expect(s.body).toContain('Excluded weekends from the SLA deadline. Added tests.');
    expect(s.body).toContain('Ticket: [SAF-60](https://linear.app/wakecap/issue/SAF-60)');
  });

  it('falls back to the branch slug without a recap or template', async () => {
    const { ship, view } = await setup();
    const s = await ship.suggest(view.path, null);
    expect(s.message).toBe('feat: SAF-60 ship it');
    expect(s.body.startsWith('## Summary')).toBe(true);
  });

  it('creates the PR with a body file, links it to the worktree and watches it', async () => {
    const { ctx, ship, view, write, audit } = await setup();
    write('src/a.ts', 'pr\n');
    await ship.commit(view.path, 'feat: SAF-60 pr');
    await ship.push(view.path);
    const pr = await ship.createPr(view.path, { title: 'SAF-60 pr', body: 'Body with `code`', base: 'main' });
    expect(pr).toEqual({ repo: 'example-org/temp-repo', number: 101, url: 'https://github.com/example-org/temp-repo/pull/101' });
    const created = fake.state().prs['example-org/temp-repo#101'];
    expect(created).toMatchObject({ title: 'SAF-60 pr', body: 'Body with `code`', headRefName: 'feat/SAF-60-ship-it', baseRefName: 'main' });
    expect(getWorktree(ctx.db, view.path)?.prUrl).toBe(pr.url);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'pr.create', result: 'ok' });
    const call = fake.calls().find((c) => c[0] === 'pr' && c[1] === 'create');
    expect(call).toContain('--body-file');
  });
});

describe('ShipService.merge and backmerge', () => {
  it('merges with the chosen method, never with --admin, and refreshes status', async () => {
    const { ctx, ship, audit } = await setup();
    const changes: string[] = [];
    ctx.bus.on('pr.changed', (e) => changes.push(e.after.state));
    fake.setPr({
      repo: 'example-org/temp-repo', number: 5, url: 'https://github.com/example-org/temp-repo/pull/5', title: 't', state: 'OPEN',
      headRefName: 'feat/x', baseRefName: 'main', body: '', updatedAt: '2026-09-17T10:00:00Z', reviewDecision: 'APPROVED', statusCheckRollup: [],
    });
    const pr = { repo: 'example-org/temp-repo', number: 5, url: 'https://github.com/example-org/temp-repo/pull/5' };
    ctx.github?.watch(pr);
    await ship.merge(pr, 'squash');
    const call = fake.calls().find((c) => c[0] === 'pr' && c[1] === 'merge');
    expect(call).toEqual(['pr', 'merge', '5', '--repo', 'example-org/temp-repo', '--squash']);
    expect(fake.state().prs['example-org/temp-repo#5']?.state).toBe('MERGED');
    expect(changes).toContain('merged');
    expect(audit.entries.at(-1)).toMatchObject({ action: 'pr.merge', result: 'ok' });
  });

  it('launches the backmerge template in a session', async () => {
    const { ship, view, launched, audit } = await setup();
    await expect(ship.backmerge(view.path, 'wakecap', 'SAF-60')).resolves.toEqual({ ptyId: 'pty-bm' });
    expect(launched[0]).toMatchObject({ source: 'claude', projectId: 'wakecap', cwd: view.path, prompt: '/backmerge SAF-60', templateId: 'backmerge' });
    expect(audit.entries.at(-1)).toMatchObject({ action: 'ship.backmerge', result: 'ok' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/ship`
Expected: FAIL, `Cannot find module './ship.ts'`

- [ ] **Step 3: Implement**

`apps/daemon/src/services/ship/ship.ts`
```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchRequest } from '@orc/api-contract';
import { redact, ticketFromBranch, type PrRef } from '@orc/core';
import type { z } from 'zod';
import type { DaemonContext } from '../../context.ts';
import { getWorktree, upsertWorktree } from '../../db/repos/worktrees.ts';
import { defaultBase } from '../diff/diff.ts';
import { runAudited } from '../git/audit.ts';
import { GitError, gh, git, gitOut, repoRoot } from '../git/exec.ts';
import { launchSession } from '../launch/launch.ts';

export interface ShipSuggestionResult { message: string; title: string; body: string; base: string; branch: string; ticket: string | null }

export interface ShipService {
  commit(cwd: string, message: string): Promise<{ sha: string }>;
  push(cwd: string): Promise<void>;
  createPr(cwd: string, i: { title: string; body: string; base: string; draft?: boolean }): Promise<PrRef>;
  merge(pr: PrRef, method: 'merge' | 'squash' | 'rebase'): Promise<void>;
  suggest(cwd: string, sessionPk: string | null): Promise<ShipSuggestionResult>;
  backmerge(cwd: string, projectId: string, ticket: string | null): Promise<{ ptyId: string }>;
}

export type Launcher = (req: z.infer<typeof LaunchRequest>) => Promise<{ ptyId: string; sessionId: string | null }>;

export const PR_TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'pull_request_template.md',
] as const;

export async function readPrTemplate(root: string): Promise<string | null> {
  for (const rel of PR_TEMPLATE_PATHS) {
    const p = join(root, rel);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
}

export async function currentBranch(cwd: string): Promise<string> {
  const b = await gitOut(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (b === 'HEAD') throw new GitError('protected_branch', 'detached HEAD: check out a branch first');
  return b;
}

const firstSentence = (text: string) => (text.split(/(?<=[.!?])\s|\n/)[0] ?? '').replace(/[.!?]$/, '').trim().slice(0, 72);

export function createShipService(ctx: DaemonContext, opts: { launch?: Launcher } = {}): ShipService {
  const launch: Launcher = opts.launch ?? ((req) => launchSession(ctx, req));

  async function rootOf(cwd: string): Promise<string> {
    const root = await repoRoot(cwd);
    if (!root) throw new GitError('not_a_worktree', `${cwd} is not inside a git checkout`);
    return root;
  }

  async function assertNotProtected(root: string): Promise<string> {
    const branch = await currentBranch(root);
    if (ctx.config().github.protectedBranches.includes(branch)) {
      throw new GitError('protected_branch', `refusing to commit or push directly to ${branch}`);
    }
    return branch;
  }

  async function commit(cwd: string, message: string): Promise<{ sha: string }> {
    return runAudited(ctx, 'user', 'git.commit', cwd, { message }, async () => {
      const root = await rootOf(cwd);
      await assertNotProtected(root);
      await gitOut(root, ['add', '-A']);
      const staged = await git(root, ['diff', '--cached', '--quiet'], { allowFail: true });
      if (staged.exitCode === 0) throw new GitError('nothing_to_commit', 'there are no changes to commit');
      await gitOut(root, ['commit', '-m', message]);
      return { sha: await gitOut(root, ['rev-parse', 'HEAD']) };
    });
  }

  async function push(cwd: string): Promise<void> {
    await runAudited(ctx, 'user', 'git.push', cwd, {}, async () => {
      const root = await rootOf(cwd);
      const branch = await assertNotProtected(root);
      const r = await git(root, ['push', '-u', 'origin', branch], { allowFail: true });
      if (r.exitCode !== 0) {
        const rejected = /rejected|non-fast-forward|fetch first/i.test(r.stderr);
        throw new GitError(rejected ? 'push_rejected' : 'git_failed', rejected ? `push rejected: pull and reconcile ${branch} first` : r.stderr.trim(), r.stderr);
      }
    });
  }

  async function createPr(cwd: string, i: { title: string; body: string; base: string; draft?: boolean }): Promise<PrRef> {
    return runAudited(ctx, 'user', 'pr.create', cwd, { title: i.title, base: i.base, draft: i.draft ?? false }, async () => {
      const root = await rootOf(cwd);
      const branch = await assertNotProtected(root);
      const dir = mkdtempSync(join(tmpdir(), 'orc-pr-'));
      try {
        const bodyFile = join(dir, 'body.md');
        writeFileSync(bodyFile, i.body);
        const args = ['pr', 'create', '--title', i.title, '--body-file', bodyFile, '--base', i.base, '--head', branch];
        if (i.draft) args.push('--draft');
        const r = await gh(args, { cwd: root });
        if (r.exitCode !== 0) throw new GitError('git_failed', `gh pr create failed: ${r.stderr.trim()}`, r.stderr);
        const url = r.stdout.trim().split('\n').pop() ?? '';
        const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
        if (!m?.[1] || !m[2]) throw new GitError('git_failed', `could not read the PR URL from gh output: ${url}`);
        const pr: PrRef = { repo: m[1], number: Number(m[2]), url };
        const wt = ctx.worktrees?.findByCwd(root) ?? null;
        const row = wt ? getWorktree(ctx.db, wt.path) : null;
        if (row) {
          upsertWorktree(ctx.db, { ...row, prUrl: url, updatedAt: new Date().toISOString() });
          const view = ctx.worktrees?.get(row.path);
          if (view) ctx.bus.emit({ type: 'worktree.updated', worktree: view });
        }
        ctx.github?.watch(pr);
        return pr;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  async function merge(pr: PrRef, method: 'merge' | 'squash' | 'rebase'): Promise<void> {
    await runAudited(ctx, 'user', 'pr.merge', `${pr.repo}#${pr.number}`, { method }, async () => {
      const r = await gh(['pr', 'merge', String(pr.number), '--repo', pr.repo, `--${method}`]);
      if (r.exitCode !== 0) throw new GitError('git_failed', `gh pr merge failed: ${r.stderr.trim()}`, r.stderr);
    });
    ctx.github?.watch(pr);
    await ctx.github?.poll();
  }

  async function suggest(cwd: string, sessionPk: string | null): Promise<ShipSuggestionResult> {
    const root = await rootOf(cwd);
    const branch = await currentBranch(root);
    const wt = ctx.worktrees?.findByCwd(root) ?? null;
    const ticket = wt?.ticket ?? ticketFromBranch(branch, null);
    const type = /^(feat|fix|chore|docs|refactor)\//.exec(branch)?.[1] ?? 'chore';
    const base = wt?.base ?? (await defaultBase(root)).replace(/^origin\//, '');
    const session = sessionPk ? ctx.sessions.getByPk(sessionPk) : null;
    const recap = session?.recap ? redact(session.recap) : null;
    const slugWords = branch.replace(/^[^/]+\//, '').replace(/^[A-Za-z][A-Za-z0-9]*-\d+-?/, '').replace(/-/g, ' ').trim();
    const summary = recap ? firstSentence(recap) : slugWords || 'update';
    const subject = ticket ? `${ticket} ${summary}` : summary;
    const ticketUrl = ticket ? ctx.config().github.ticketUrlTemplate.replace('{ticket}', ticket) : null;
    const template = await readPrTemplate(root);
    const summaryBlock = `## Summary\n\n${recap ?? summary}\n`;
    const footer = ticketUrl ? `\n---\nTicket: [${ticket}](${ticketUrl})\n` : '';
    const body = template ? `${summaryBlock}\n${template.trimEnd()}\n${footer}` : `${summaryBlock}${footer}`;
    return { message: `${type}: ${subject}`, title: subject, body, base, branch, ticket };
  }

  async function backmerge(cwd: string, projectId: string, ticket: string | null): Promise<{ ptyId: string }> {
    return runAudited(ctx, 'user', 'ship.backmerge', cwd, { projectId, ticket }, async () => {
      if (!ctx.templates) throw new Error('template registry missing');
      const vars = ticket ? { ticket } : {};
      const prompt = ctx.templates.render('backmerge', vars);
      const req = LaunchRequest.parse({ source: 'claude', projectId, cwd, prompt, templateId: 'backmerge', vars, ...(ticket ? { ticket } : {}) });
      const { ptyId } = await launch(req);
      return { ptyId };
    });
  }

  return { commit, push, createPr, merge, suggest, backmerge };
}
```

In `apps/daemon/src/context.ts` set `ship?: ShipService;` with `import type { ShipService } from './services/ship/ship.ts';`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/daemon/src/services/ship`
Expected: PASS (8 tests). The rejected-push test shows the remote still points at the other clone's commit.

- [ ] **Step 5: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon/src/services/ship apps/daemon/src/context.ts
git commit -m "feat(daemon): ship service for commit, push, PR create/merge and backmerge"
```

---
### Task 16: Plan approval and worktree launches (removes the Phase 2 `501`)

**Files:**
- Create: `apps/daemon/src/services/launch/plan-mode.ts`, `apps/daemon/src/services/launch/prepare.ts`, `apps/daemon/src/services/review/plan-keys.ts`, `apps/daemon/src/services/review/plan-approval.ts`, `apps/daemon/src/inbox/rules/plan-approval.ts`
- Modify: `apps/daemon/src/services/launch/args.ts`, `apps/daemon/src/services/launch/launch.ts`, `apps/daemon/src/context.ts` (add `plans?`)
- Test: `apps/daemon/src/services/launch/phase4-launch.test.ts`, `apps/daemon/src/services/review/plan-approval.test.ts`, `apps/daemon/src/inbox/rules/plan-approval.test.ts`
- Modify (test): the P2 launch test that asserted `501` for `planApproval` / `worktree` (delete those two cases; `compare` keeps its `501`)

**Interfaces:**
- Consumes: `launchSession`, `buildLaunchArgs`, `assertLaunchSupported`, `HttpError` (P2/P1, see "Assumed"); `WorktreeService.createWith` (Task 9); `isOwned` (Task 12); `runAudited` (Task 8); `ctx.sessions.events` (§11); `ctx.inbox` (P2); `ctx.pty.write/sendText` (§7); bus `session.statusChanged`, `pty.exited`
- Produces:
  ```ts
  // launch/plan-mode.ts
  export function applyPlanMode(args: string[]): string[]      // drops --dangerously-skip-permissions and any --permission-mode pair, appends --permission-mode plan
  // launch/prepare.ts
  export async function prepareLaunch(ctx: DaemonContext, req: LaunchRequestT): Promise<LaunchRequestT>
  export function waitForPtyExit(ctx: DaemonContext, ptyId: string, timeoutMs: number): Promise<number | null>
  export type LaunchRequestT = z.infer<typeof LaunchRequest>
  // review/plan-keys.ts
  export const PLAN_KEYS: { approve: string; reject: string; rejectSettleMs: number }
  export function rejectionPrompt(feedback: string): string
  // review/plan-approval.ts
  export interface PlanApprovalService { approve(pk: string): Promise<void>; reject(pk: string, feedback: string): Promise<void> }
  export function planKey(pk: string): string                  // `plan:${pk}`
  export function createPlanApprovalService(ctx: DaemonContext): PlanApprovalService
  // inbox/rules/plan-approval.ts
  export interface PendingPlan { toolUseId: string; plan: string }
  export function createPlanApprovalRule(): InboxRule & { pending(pk: string): PendingPlan | null }
  ```
  `GitError` codes: `not_owned`, `no_pending_plan`. Audit actions `plan.approve`, `plan.reject`. Codex launches with `planApproval: true` return `400 validation_failed`.

- [ ] **Step 1: Write the failing launch tests**

`apps/daemon/src/services/launch/phase4-launch.test.ts`
```ts
import { join } from 'node:path';
import { LaunchRequest, OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { memoryAudit, stubSessions, stubTemplates } from '../../../test/stubs.ts';
import { createWorktreeService } from '../worktree/worktree.ts';
import { launchSession } from './launch.ts';
import { applyPlanMode } from './plan-mode.ts';
import { prepareLaunch } from './prepare.ts';

let repo: TempRepo;
afterEach(() => repo?.cleanup());

describe('applyPlanMode', () => {
  it('swaps bypass mode for plan mode', () => {
    expect(applyPlanMode(['--dangerously-skip-permissions', '--model', 'opus'])).toEqual(['--model', 'opus', '--permission-mode', 'plan']);
    expect(applyPlanMode(['--permission-mode', 'acceptEdits'])).toEqual(['--permission-mode', 'plan']);
    expect(applyPlanMode(['--permission-mode=bypassPermissions'])).toEqual(['--permission-mode', 'plan']);
  });
});

function setup(setupScript?: string) {
  repo = makeTempRepo();
  const cfg = OrcConfig.parse({
    projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root], repos: [{ path: repo.dir, ...(setupScript ? { setup: setupScript } : {}) }] }],
  });
  const pty = recordingPty();
  const ctx = createTestContext({ config: () => cfg, pty, audit: memoryAudit(), sessions: stubSessions([]), templates: stubTemplates() });
  ctx.worktrees = createWorktreeService(ctx);
  return { ctx, pty };
}

describe('prepareLaunch', () => {
  it('creates the worktree and moves the cwd into it', async () => {
    const { ctx } = setup();
    const req = LaunchRequest.parse({
      source: 'claude', projectId: 'wakecap', cwd: repo.dir, ticket: 'SAF-70',
      worktree: { repo: repo.dir, base: 'main', type: 'feat', slug: 'plan flow' },
    });
    const out = await prepareLaunch(ctx, req);
    expect(out.cwd).toBe(join(repo.dir, '.worktrees', 'feat-SAF-70-plan-flow'));
    expect(out.worktree).toBeUndefined();
  });

  it('waits for the setup script to exit before returning', async () => {
    const { ctx, pty } = setup('pnpm install');
    const req = LaunchRequest.parse({
      source: 'claude', projectId: 'wakecap', cwd: repo.dir, ticket: 'SAF-71',
      worktree: { repo: repo.dir, base: 'main', type: 'fix', slug: 'wait setup' },
    });
    let done = false;
    const p = prepareLaunch(ctx, req).then((r) => {
      done = true;
      return r;
    });
    for (let i = 0; i < 100 && pty.spawned.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(pty.spawned[0]?.args).toEqual(['-lc', 'pnpm install']);
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false);
    ctx.bus.emit({ type: 'pty.exited', ptyId: 'pty-1', code: 0 });
    await p;
    expect(done).toBe(true);
  });

  it('rejects plan approval for Codex', async () => {
    const { ctx } = setup();
    const req = LaunchRequest.parse({ source: 'codex', projectId: 'wakecap', cwd: repo.dir, planApproval: true });
    await expect(prepareLaunch(ctx, req)).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('launchSession with Phase 4 fields', () => {
  it('launches Claude in plan mode inside the new worktree', async () => {
    const { ctx, pty } = setup();
    const req = LaunchRequest.parse({
      source: 'claude', projectId: 'wakecap', cwd: repo.dir, prompt: 'plan SAF-72', ticket: 'SAF-72', planApproval: true,
      worktree: { repo: repo.dir, base: 'main', type: 'feat', slug: 'launch' },
    });
    await launchSession(ctx, req);
    const spawn = pty.spawned.at(-1);
    expect(spawn?.cwd).toBe(join(repo.dir, '.worktrees', 'feat-SAF-72-launch'));
    expect(spawn?.args).toContain('--permission-mode');
    expect(spawn?.args[spawn.args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(spawn?.args).not.toContain('--dangerously-skip-permissions');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/daemon/src/services/launch/phase4-launch.test.ts`
Expected: FAIL, `Cannot find module './plan-mode.ts'`

- [ ] **Step 3: Implement plan mode and launch preparation**

`apps/daemon/src/services/launch/plan-mode.ts`
```ts
export function applyPlanMode(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--dangerously-skip-permissions') continue;
    if (a === '--permission-mode') {
      i++;
      continue;
    }
    if (a.startsWith('--permission-mode=')) continue;
    out.push(a);
  }
  return [...out, '--permission-mode', 'plan'];
}
```

`apps/daemon/src/services/launch/prepare.ts`
```ts
import type { LaunchRequest } from '@orc/api-contract';
import type { z } from 'zod';
import type { DaemonContext } from '../../context.ts';
import { HttpError } from '../../http/errors.ts';

export type LaunchRequestT = z.infer<typeof LaunchRequest>;

const SETUP_TIMEOUT_MS = 10 * 60_000;

export function waitForPtyExit(ctx: DaemonContext, ptyId: string, timeoutMs: number): Promise<number | null> {
  const info = ctx.pty.get(ptyId);
  if (info?.exitedAt) return Promise.resolve(info.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(null);
    }, timeoutMs);
    const off = ctx.bus.on('pty.exited', (e) => {
      if (e.ptyId !== ptyId) return;
      clearTimeout(timer);
      off();
      resolve(e.code);
    });
  });
}

export async function prepareLaunch(ctx: DaemonContext, req: LaunchRequestT): Promise<LaunchRequestT> {
  if (req.planApproval && req.source !== 'claude') {
    throw new HttpError(400, 'validation_failed', 'plan approval is only supported for Claude sessions');
  }
  if (!req.worktree) return req;
  if (!ctx.worktrees) throw new Error('worktree service missing');
  const { worktree, ...rest } = req;
  const { view, setupPtyId } = await ctx.worktrees.createWith(
    { repo: worktree.repo, base: worktree.base, type: worktree.type, ticket: req.ticket ?? null, slug: worktree.slug },
    { runSetup: true, actor: 'user' },
  );
  if (setupPtyId) {
    const code = await waitForPtyExit(ctx, setupPtyId, SETUP_TIMEOUT_MS);
    if (code !== 0) ctx.log.warn({ code, path: view.path }, 'worktree setup script did not finish cleanly; launching anyway');
  }
  return { ...rest, cwd: view.path, projectId: rest.projectId ?? view.projectId };
}
```
`HttpError` exposes `code`; the test's `toMatchObject({ code: 'validation_failed' })` relies on that (P1 contract: `HttpError(status, code, message, details?)`).

In `apps/daemon/src/services/launch/args.ts`, at the end of `buildLaunchArgs`, before `return`, add (with `import { applyPlanMode } from './plan-mode.ts';`):
```ts
  if (req.source === 'claude' && req.planApproval) args = applyPlanMode(args);
```
(`args` must be declared with `let`; change `const args` to `let args` if needed.)

In `apps/daemon/src/services/launch/launch.ts`:
1. Replace `assertLaunchSupported` with:
```ts
export function assertLaunchSupported(req: LaunchRequestT): void {
  if (req.compare && req.compare.length > 0) {
    throw new HttpError(501, 'not_implemented', 'compare mode arrives in Phase 7');
  }
}
```
2. At the top of `launchSession`, after `assertLaunchSupported(req)`, add:
```ts
  req = await prepareLaunch(ctx, req);
```
(the parameter becomes `let`-style: rename the parameter to `input` and write `let req = input;` if Biome flags parameter reassignment), with `import { prepareLaunch, type LaunchRequestT } from './prepare.ts';`.

- [ ] **Step 4: Run the launch tests**

Run: `pnpm vitest run apps/daemon/src/services/launch`
Expected: PASS (5 new tests plus the remaining P2 launch tests, after removing the two obsolete `501` cases).

- [ ] **Step 5: Write the failing plan rule and approval tests**

`apps/daemon/src/inbox/rules/plan-approval.test.ts`
```ts
import type { TimelineEvent } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../../../test/helpers.ts';
import { makeSession, recordingInbox, stubSessions } from '../../../test/stubs.ts';
import { createPlanApprovalRule } from './plan-approval.ts';

const ev = (seq: number, p: Partial<TimelineEvent>): TimelineEvent => ({
  sessionId: 'p1', agentId: null, uuid: `u${seq}`, parentUuid: null, seq, ts: '2026-09-17T10:00:00Z', kind: 'assistant_text',
  turn: 1, text: null, tool: null, toolUseId: null, mcpServer: null, input: null, messageId: null, model: null, usage: null, durationMs: null, ...p,
});

function setup(events: TimelineEvent[]) {
  const inbox = recordingInbox();
  const base = stubSessions([makeSession({ id: 'p1', projectId: 'wakecap', tickets: ['SAF-80'] })]);
  const calls: Array<number | undefined> = [];
  const sessions = {
    ...base,
    events: (_s: string, _id: string, opts: { afterSeq?: number; limit?: number }) => {
      calls.push(opts.afterSeq);
      const items = events.filter((e) => e.seq > (opts.afterSeq ?? -1)).slice(0, opts.limit ?? 500);
      return { items, nextSeq: items.length === (opts.limit ?? 500) ? (items.at(-1)?.seq ?? null) : null };
    },
  };
  const ctx = createTestContext({ inbox, sessions });
  const plans: string[] = [];
  ctx.bus.on('plan.pending', (e) => plans.push(e.plan));
  const rule = createPlanApprovalRule();
  return { ctx, inbox, rule, calls, plans, events };
}

describe('plan approval rule', () => {
  it('opens an item when the session waits on ExitPlanMode and resolves it when it moves on', () => {
    const { ctx, inbox, rule, plans } = setup([
      ev(1, { kind: 'prompt', text: 'plan it' }),
      ev(2, { kind: 'tool_call', tool: 'ExitPlanMode', toolUseId: 'tu-plan', input: { plan: '1. Do X\n2. token ghp_abcdefghijklmnopqrstuvwxyz0123456789' } }),
    ]);
    rule.handle({ type: 'session.statusChanged', pk: 'claude:p1', from: 'busy', to: 'waiting' }, ctx);
    expect(inbox.upserts[0]).toMatchObject({
      kind: 'plan_approval', dedupeKey: 'plan:claude:p1', sessionId: 'claude:p1', projectId: 'wakecap', ticket: 'SAF-80',
      reason: 'Plan awaiting approval',
      payload: { toolUseId: 'tu-plan', plan: '1. Do X\n2. token «redacted:github»' },
    });
    expect(plans).toEqual(['1. Do X\n2. token «redacted:github»']);
    rule.handle({ type: 'session.statusChanged', pk: 'claude:p1', from: 'waiting', to: 'busy' }, ctx);
    expect(inbox.resolved).toEqual(['plan:claude:p1']);
  });

  it('ignores waits that are not about a plan and plans that were already answered', () => {
    const { ctx, inbox, rule, events } = setup([ev(1, { kind: 'tool_call', tool: 'Bash', toolUseId: 'b1' })]);
    rule.handle({ type: 'session.statusChanged', pk: 'claude:p1', from: 'busy', to: 'waiting' }, ctx);
    events.push(ev(2, { kind: 'tool_call', tool: 'ExitPlanMode', toolUseId: 'tu2', input: { plan: 'p' } }));
    events.push(ev(3, { kind: 'tool_result', toolUseId: 'tu2' }));
    rule.handle({ type: 'session.statusChanged', pk: 'claude:p1', from: 'busy', to: 'waiting' }, ctx);
    expect(inbox.upserts).toEqual([]);
    expect(rule.pending('claude:p1')).toBeNull();
  });

  it('reads the transcript incrementally', () => {
    const { ctx, rule, calls, events } = setup([ev(1, { kind: 'prompt' })]);
    rule.handle({ type: 'session.statusChanged', pk: 'claude:p1', from: 'busy', to: 'waiting' }, ctx);
    events.push(ev(2, { kind: 'tool_call', tool: 'ExitPlanMode', toolUseId: 'tu3', input: { plan: 'later' } }));
    rule.handle({ type: 'session.statusChanged', pk: 'claude:p1', from: 'busy', to: 'waiting' }, ctx);
    expect(calls).toEqual([undefined, 1]);
    expect(rule.pending('claude:p1')?.plan).toBe('later');
  });
});
```

`apps/daemon/src/services/review/plan-approval.test.ts`
```ts
import type { LiveState } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { makeSession, memoryAudit, recordingInbox, stubSessions } from '../../../test/stubs.ts';
import { PLAN_KEYS, rejectionPrompt } from './plan-keys.ts';
import { createPlanApprovalService, planKey } from './plan-approval.ts';

const live = (ownership: LiveState['ownership']): LiveState => ({
  pid: 1, status: 'waiting', waitingFor: 'plan approval', since: '2026-09-17T10:00:00Z', ownership,
  ptyId: ownership === 'owned' ? 'pty-plan' : null, stage: null, currentTool: 'ExitPlanMode', backgroundJobs: 0, runningSubagents: 0, contextFill: null,
});

function setup(withItem = true) {
  const inbox = recordingInbox();
  const pty = recordingPty();
  const audit = memoryAudit();
  const sessions = stubSessions([makeSession({ id: 'own', live: live('owned') }), makeSession({ id: 'obs', live: live('observed') })]);
  const ctx = createTestContext({ inbox, pty, audit, sessions });
  if (withItem) {
    inbox.upsert({ kind: 'plan_approval', dedupeKey: planKey('claude:own'), reason: 'Plan awaiting approval' });
    inbox.upsert({ kind: 'plan_approval', dedupeKey: planKey('claude:obs'), reason: 'Plan awaiting approval' });
  }
  return { svc: createPlanApprovalService(ctx), inbox, pty, audit };
}

describe('PlanApprovalService', () => {
  it('approves an owned session by selecting the approve option', async () => {
    const { svc, inbox, pty, audit } = setup();
    await svc.approve('claude:own');
    expect(pty.writes).toEqual([{ id: 'pty-plan', data: PLAN_KEYS.approve }]);
    expect(inbox.resolved).toEqual(['plan:claude:own']);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'plan.approve', target: 'claude:own', result: 'ok' });
  });

  it('rejects with feedback: dismisses the dialog, then sends the feedback', async () => {
    const { svc, pty, audit } = setup();
    await svc.reject('claude:own', 'Split step 2 into two PRs');
    expect(pty.writes).toEqual([{ id: 'pty-plan', data: PLAN_KEYS.reject }]);
    expect(pty.texts).toEqual([{ id: 'pty-plan', text: rejectionPrompt('Split step 2 into two PRs') }]);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'plan.reject', result: 'ok' });
  });

  it('refuses observed sessions and sessions with no pending plan', async () => {
    await expect(setup().svc.approve('claude:obs')).rejects.toMatchObject({ code: 'not_owned' });
    await expect(setup(false).svc.approve('claude:own')).rejects.toMatchObject({ code: 'no_pending_plan' });
  });
});
```

- [ ] **Step 6: Implement the rule, the keys and the service**

`apps/daemon/src/services/review/plan-keys.ts`
```ts
/**
 * Keys for Claude Code's ExitPlanMode dialog. Verified manually in Task 22 Step 3;
 * if the TUI changes, update only this file.
 * - approve: option "1" ("Yes, …") is selected by its number key.
 * - reject: Escape dismisses the dialog ("No, keep planning") and returns to the prompt.
 */
export const PLAN_KEYS = { approve: '1', reject: '\x1b', rejectSettleMs: 300 } as const;

export function rejectionPrompt(feedback: string): string {
  return `The plan is not approved yet. Do not start implementing. Revise the plan using this feedback, then present it again:\n\n${feedback.trim()}`;
}
```

`apps/daemon/src/services/review/plan-approval.ts`
```ts
import type { DaemonContext } from '../../context.ts';
import { runAudited } from '../git/audit.ts';
import { GitError } from '../git/exec.ts';
import { PLAN_KEYS, rejectionPrompt } from './plan-keys.ts';
import { isOwned } from './review.ts';

export interface PlanApprovalService {
  approve(pk: string): Promise<void>;
  reject(pk: string, feedback: string): Promise<void>;
}

export const planKey = (pk: string) => `plan:${pk}`;

export function createPlanApprovalService(ctx: DaemonContext): PlanApprovalService {
  function ownedPty(pk: string): string {
    const s = ctx.sessions.getByPk(pk);
    if (!s) throw new GitError('not_found', `session ${pk} not found`);
    if (!isOwned(s)) throw new GitError('not_owned', 'plans can only be answered for sessions the app owns');
    const pending = ctx.inbox?.list({ state: ['open', 'snoozed'], kind: ['plan_approval'] }).some((i) => i.dedupeKey === planKey(pk));
    if (!pending) throw new GitError('no_pending_plan', `no plan is waiting for approval in ${pk}`);
    return s.live.ptyId;
  }

  return {
    async approve(pk) {
      const ptyId = ownedPty(pk);
      await runAudited(ctx, 'user', 'plan.approve', pk, { ptyId }, async () => {
        ctx.pty.write(ptyId, PLAN_KEYS.approve);
      });
      ctx.inbox?.resolve(planKey(pk));
    },
    async reject(pk, feedback) {
      const ptyId = ownedPty(pk);
      await runAudited(ctx, 'user', 'plan.reject', pk, { ptyId, feedbackChars: feedback.length }, async () => {
        ctx.pty.write(ptyId, PLAN_KEYS.reject);
        await new Promise((r) => setTimeout(r, PLAN_KEYS.rejectSettleMs));
        await ctx.pty.sendText(ptyId, rejectionPrompt(feedback));
      });
      ctx.inbox?.resolve(planKey(pk));
    },
  };
}
```

`apps/daemon/src/inbox/rules/plan-approval.ts`
```ts
import { redact, type Source } from '@orc/core';
import type { InboxRule } from '../engine.ts';

export interface PendingPlan {
  toolUseId: string;
  plan: string;
}

const PAGE = 500;
const MAX_PLAN_CHARS = 20_000;

export function createPlanApprovalRule(): InboxRule & { pending(pk: string): PendingPlan | null } {
  const cursor = new Map<string, number>();
  const pendingByPk = new Map<string, PendingPlan | null>();

  function scan(ctx: Parameters<InboxRule['handle']>[1], pk: string): PendingPlan | null {
    const idx = pk.indexOf(':');
    const source = pk.slice(0, idx) as Source;
    const id = pk.slice(idx + 1);
    let pending = pendingByPk.get(pk) ?? null;
    let after = cursor.get(pk);
    for (;;) {
      const page = ctx.sessions.events(source, id, { ...(after === undefined ? {} : { afterSeq: after }), limit: PAGE });
      for (const e of page.items) {
        after = e.seq;
        if (e.kind === 'tool_call' && e.tool === 'ExitPlanMode' && e.toolUseId) {
          const input = e.input as { plan?: unknown } | null;
          const plan = typeof input?.plan === 'string' ? input.plan : '';
          pending = { toolUseId: e.toolUseId, plan: redact(plan).slice(0, MAX_PLAN_CHARS) };
        } else if (e.kind === 'tool_result' && pending && e.toolUseId === pending.toolUseId) {
          pending = null;
        }
      }
      if (page.nextSeq === null || page.items.length === 0) break;
    }
    if (after !== undefined) cursor.set(pk, after);
    pendingByPk.set(pk, pending);
    return pending;
  }

  return {
    name: 'plan-approval',
    on: ['session.statusChanged'],
    pending: (pk) => pendingByPk.get(pk) ?? null,
    handle(e, ctx) {
      if (e.type !== 'session.statusChanged' || !ctx.inbox) return;
      const key = `plan:${e.pk}`;
      if (e.to !== 'waiting') {
        if (e.from === 'waiting') ctx.inbox.resolve(key);
        return;
      }
      const plan = scan(ctx, e.pk);
      if (!plan) return;
      const s = ctx.sessions.getByPk(e.pk);
      ctx.inbox.upsert({
        kind: 'plan_approval',
        dedupeKey: key,
        sessionId: e.pk,
        projectId: s?.projectId ?? null,
        ticket: s?.tickets[0] ?? null,
        reason: 'Plan awaiting approval',
        payload: { toolUseId: plan.toolUseId, plan: plan.plan, owned: s?.live?.ownership === 'owned' },
      });
      ctx.bus.emit({ type: 'plan.pending', pk: e.pk, plan: plan.plan, toolUseId: plan.toolUseId });
    },
  };
}
```
The first test's `toMatchObject` on `payload` ignores the extra `owned` key.

In `apps/daemon/src/context.ts` add `plans?: PlanApprovalService; // P4` with `import type { PlanApprovalService } from './services/review/plan-approval.ts';`.

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run apps/daemon/src/inbox/rules/plan-approval.test.ts apps/daemon/src/services/review/plan-approval.test.ts apps/daemon/src/services/launch`
Expected: PASS (3 + 3 + launch tests).

- [ ] **Step 8: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon/src/services/launch apps/daemon/src/services/review apps/daemon/src/inbox/rules/plan-approval.ts apps/daemon/src/inbox/rules/plan-approval.test.ts apps/daemon/src/context.ts
git commit -m "feat(daemon): plan-approval launches, ExitPlanMode inbox items and worktree launches"
```

---
### Task 17: HTTP routes — worktrees and GitHub (with the confirm/error guard)

**Files:**
- Create: `apps/daemon/src/http/routes/git-guard.ts`, `apps/daemon/src/http/routes/worktrees.ts`, `apps/daemon/src/http/routes/github.ts`
- Test: `apps/daemon/src/http/routes/worktrees.test.ts`, `apps/daemon/src/http/routes/github.test.ts`

**Interfaces:**
- Consumes: zod schemas (Task 1); `WorktreeService` (Task 9); `GithubConnector` (Task 13); `getPrStatus` (Task 5); `GitError` (Task 4); `HttpError` (P1); `apiError` (P0); `launchSession`, `LaunchRequest` (P2); `branchName` (core)
- Produces:
  ```ts
  // git-guard.ts
  export const GIT_ERROR_STATUS: Readonly<Record<string, number>>
  export function toHttpError(err: unknown): unknown
  export function requireConfirm(confirm: boolean, summary: string, details?: Record<string, unknown>): void   // 409 confirmation_required
  export async function parseJson<T>(c: Context, schema: z.ZodType<T>): Promise<T>                              // 400 validation_failed
  export function parseQuery<T>(c: Context, schema: z.ZodType<T>): T
  export function phase4App(): Hono                                                                              // Hono with onError rendering §6 errors
  // routes
  export function worktreesRoutes(ctx: DaemonContext): Hono
  export function githubRoutes(ctx: DaemonContext): Hono
  ```
  Routes are relative to `/api` (mounted in Task 18). Error status map: `not_found`, `not_a_worktree`, `no_worktree`, `hunk_not_found`, `no_script` → 404; `not_owned` → 403; `forbidden_git_args` → 400; `dirty_worktree`, `main_dirty`, `external_worktree`, `worktree_exists`, `is_main_checkout`, `nothing_to_commit`, `protected_branch`, `push_rejected`, `no_pending_plan` → 409; `gh_unavailable` → 503; `git_failed` → 502.

- [ ] **Step 1: Write the failing route tests**

`apps/daemon/src/http/routes/worktrees.test.ts`
```ts
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { memoryAudit, stubSessions, stubTemplates } from '../../../test/stubs.ts';
import { getWorktree, upsertWorktree } from '../../db/repos/worktrees.ts';
import { createWorktreeService } from '../../services/worktree/worktree.ts';
import { worktreesRoutes } from './worktrees.ts';

let repo: TempRepo;
afterEach(() => repo.cleanup());

function setup() {
  repo = makeTempRepo();
  const cfg = OrcConfig.parse({
    projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root], repos: [{ path: repo.dir, run: 'pnpm dev' }] }],
    worktrees: { scratchpadRoots: [] },
  });
  const pty = recordingPty();
  const ctx = createTestContext({ config: () => cfg, pty, audit: memoryAudit(), sessions: stubSessions([]), templates: stubTemplates() });
  ctx.worktrees = createWorktreeService(ctx, { opener: async () => {} });
  const app = worktreesRoutes(ctx);
  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ctx, app, post, pty };
}

const createBody = () => ({ repo: repo.dir, base: 'main', type: 'feat', ticket: 'SAF-90', slug: 'routes', runSetup: false });
const wtPath = () => join(repo.dir, '.worktrees', 'feat-SAF-90-routes');

describe('POST /worktrees', () => {
  it('asks for confirmation with a summary, then creates', async () => {
    const { post } = setup();
    const first = await post('/worktrees', createBody());
    expect(first.status).toBe(409);
    const err = (await first.json()) as { error: { code: string; details: { summary: string; branch: string; path: string } } };
    expect(err.error.code).toBe('confirmation_required');
    expect(err.error.details.summary).toContain('feat/SAF-90-routes');
    expect(err.error.details.path).toBe(wtPath());
    const ok = await post('/worktrees', { ...createBody(), confirm: true });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { worktree: { path: string }; setupPtyId: string | null; launch: null };
    expect(body.worktree.path).toBe(wtPath());
    expect(body.launch).toBeNull();
    const dup = await post('/worktrees', { ...createBody(), confirm: true });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('worktree_exists');
  });

  it('rejects an invalid body', async () => {
    const { post } = setup();
    const r = await post('/worktrees', { repo: repo.dir, type: 'feature' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('validation_failed');
  });

  it('creates and launches a session in one call', async () => {
    const { post, pty } = setup();
    const r = await post('/worktrees', { ...createBody(), confirm: true, launch: { source: 'claude', prompt: 'go', planApproval: true } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { worktree: { path: string }; launch: { ptyId: string } };
    expect(body.worktree.path).toBe(wtPath());
    expect(body.launch.ptyId).toBeTruthy();
    expect(pty.spawned.at(-1)?.cwd).toBe(wtPath());
  });
});

describe('worktree listing, scripts, sync and archive', () => {
  it('lists, discovers and reads one worktree', async () => {
    const { app, post } = setup();
    await post('/worktrees', { ...createBody(), confirm: true });
    const disc = await app.request('/worktrees/discover', { method: 'POST' });
    expect(((await disc.json()) as Array<{ path: string }>).map((w) => w.path)).toEqual([repo.dir, wtPath()]);
    const list = await app.request('/worktrees?state=active&projectId=wakecap');
    expect(((await list.json()) as unknown[]).length).toBe(2);
    const one = await app.request(`/worktrees/one?path=${encodeURIComponent(wtPath())}`);
    expect(((await one.json()) as { branch: string }).branch).toBe('feat/SAF-90-routes');
    expect((await app.request('/worktrees/one?path=%2Fnope')).status).toBe(404);
  });

  it('runs scripts, opens, previews and syncs with confirmation', async () => {
    const { post, app, pty } = setup();
    await post('/worktrees', { ...createBody(), confirm: true });
    expect((await post('/worktrees/script', { path: wtPath(), which: 'run' })).status).toBe(409);
    const run = await post('/worktrees/script', { path: wtPath(), which: 'run', confirm: true });
    expect(await run.json()).toEqual({ ptyId: 'pty-1' });
    expect(pty.spawned[0]?.args).toEqual(['-lc', 'pnpm dev']);
    expect((await post('/worktrees/script', { path: wtPath(), which: 'setup', confirm: true })).status).toBe(404);
    expect((await post('/worktrees/open', { path: wtPath(), target: 'finder' })).status).toBe(200);

    repo.write('.worktrees/feat-SAF-90-routes/src/a.ts', 'synced\n');
    const preview = await app.request(`/worktrees/sync-preview?path=${encodeURIComponent(wtPath())}`);
    expect(((await preview.json()) as { files: string[] }).files).toEqual(['src/a.ts']);
    const ask = await post('/worktrees/sync', { path: wtPath() });
    expect(ask.status).toBe(409);
    expect(((await ask.json()) as { error: { details: { files: string[] } } }).error.details.files).toEqual(['src/a.ts']);
    expect(await (await post('/worktrees/sync', { path: wtPath(), confirm: true })).json()).toEqual({ files: 1 });
    expect(repo.read('src/a.ts')).toBe('synced\n');
  });

  it('refuses dirty archives and needs an extra flag for external worktrees', async () => {
    const { ctx, post } = setup();
    await post('/worktrees', { ...createBody(), confirm: true });
    repo.write('.worktrees/feat-SAF-90-routes/src/a.ts', 'dirty\n');
    const dirty = await post('/worktrees/archive', { path: wtPath(), confirm: true });
    expect(dirty.status).toBe(409);
    expect(((await dirty.json()) as { error: { code: string } }).error.code).toBe('dirty_worktree');
    repo.git('-C', wtPath(), 'checkout', 'HEAD', 'src/a.ts');

    const row = getWorktree(ctx.db, wtPath());
    if (!row) throw new Error('missing');
    upsertWorktree(ctx.db, { ...row, createdByApp: false, origin: 'worktree-dir' });
    const ask = await post('/worktrees/archive', { path: wtPath() });
    expect(((await ask.json()) as { error: { details: { external: boolean } } }).error.details.external).toBe(true);
    const ext = await post('/worktrees/archive', { path: wtPath(), confirm: true });
    expect(((await ext.json()) as { error: { code: string } }).error.code).toBe('external_worktree');
    const ok = await post('/worktrees/archive', { path: wtPath(), confirm: true, confirmExternal: true });
    expect(await ok.json()).toEqual({ ok: true });
  });
});
```
`git checkout HEAD <file>` in the test restores the file through the test's own raw git call; the daemon never runs it.

`apps/daemon/src/http/routes/github.test.ts`
```ts
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeGh, useFakeGh } from '../../../test/fake-gh.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { stubSessions } from '../../../test/stubs.ts';
import { createGithubConnector } from '../../connectors/github/github.ts';
import { githubRoutes } from './github.ts';

let fake: FakeGh;
afterEach(() => fake.restore());

function setup(enabled = true) {
  fake = useFakeGh();
  const cfg = OrcConfig.parse({ github: { enabled } });
  const ctx = createTestContext({ config: () => cfg, sessions: stubSessions([]) });
  ctx.github = createGithubConnector(ctx);
  fake.setPr({
    repo: 'example-org/temp-repo', number: 3, url: 'https://github.com/example-org/temp-repo/pull/3', title: 'SAF-3', state: 'OPEN',
    headRefName: 'feat/SAF-3-x', baseRefName: 'main', body: '', updatedAt: '2026-09-17T10:00:00Z', reviewDecision: 'APPROVED', statusCheckRollup: [],
  });
  return githubRoutes(ctx);
}

describe('github routes', () => {
  it('reports status, including disabled', async () => {
    expect(await (await setup().request('/github/status')).json()).toEqual({ status: 'ok' });
    fake.restore();
    expect(await (await setup(false).request('/github/status')).json()).toEqual({ status: 'disabled' });
  });

  it('returns one PR and my PRs', async () => {
    const app = setup();
    const one = await app.request('/github/pr?repo=example-org/temp-repo&number=3');
    expect(((await one.json()) as { review: string }).review).toBe('approved');
    const mine = await app.request('/github/prs/mine');
    expect(((await mine.json()) as unknown[]).length).toBe(1);
    expect((await app.request('/github/pr?repo=bad&number=x')).status).toBe(400);
  });

  it('maps gh failures to 503', async () => {
    const app = setup();
    fake.setState({ authed: false });
    const r = await app.request('/github/prs/mine');
    expect(r.status).toBe(503);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/http/routes/worktrees.test.ts apps/daemon/src/http/routes/github.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the guard**

`apps/daemon/src/http/routes/git-guard.ts`
```ts
import { apiError } from '@orc/api-contract';
import { type Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { GitError } from '../../services/git/exec.ts';
import { HttpError } from '../errors.ts';

export const GIT_ERROR_STATUS: Readonly<Record<string, number>> = {
  not_found: 404,
  not_a_worktree: 404,
  no_worktree: 404,
  hunk_not_found: 404,
  no_script: 404,
  not_owned: 403,
  forbidden_git_args: 400,
  dirty_worktree: 409,
  main_dirty: 409,
  external_worktree: 409,
  worktree_exists: 409,
  is_main_checkout: 409,
  nothing_to_commit: 409,
  protected_branch: 409,
  push_rejected: 409,
  no_pending_plan: 409,
  gh_unavailable: 503,
  git_failed: 502,
};

export function toHttpError(err: unknown): unknown {
  if (err instanceof GitError) return new HttpError(GIT_ERROR_STATUS[err.code] ?? 500, err.code, err.message);
  if (err instanceof Error && /^not_found:/.test(err.message)) return new HttpError(404, 'not_found', err.message);
  return err;
}

export function requireConfirm(confirm: boolean, summary: string, details: Record<string, unknown> = {}): void {
  if (!confirm) throw new HttpError(409, 'confirmation_required', summary, { summary, ...details });
}

export async function parseJson<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'validation_failed', 'request body must be JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(400, 'validation_failed', 'invalid request body', r.error.issues);
  return r.data;
}

export function parseQuery<T>(c: Context, schema: z.ZodType<T>): T {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw new HttpError(400, 'validation_failed', 'invalid query', r.error.issues);
  return r.data;
}

export function phase4App(): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    const mapped = toHttpError(err);
    if (mapped instanceof HttpError) {
      return c.json(apiError(mapped.code, mapped.message, mapped.details), mapped.status as ContentfulStatusCode);
    }
    return c.json(apiError('internal', (err as Error).message), 500);
  });
  return app;
}
```

- [ ] **Step 4: Implement the worktree routes**

`apps/daemon/src/http/routes/worktrees.ts`
```ts
import { join } from 'node:path';
import {
  CreateWorktreeBody,
  LaunchRequest,
  WorktreeArchiveBody,
  WorktreeListQuery,
  WorktreeOpenBody,
  WorktreePathBody,
  WorktreeScriptBody,
} from '@orc/api-contract';
import { branchName, worktreeDirName } from '@orc/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { DaemonContext } from '../../context.ts';
import { launchSession } from '../../services/launch/launch.ts';
import type { WorktreeService } from '../../services/worktree/worktree.ts';
import { repoConfigFor } from '../../services/worktree/worktree-write.ts';
import { HttpError } from '../errors.ts';
import { parseJson, parseQuery, phase4App, requireConfirm } from './git-guard.ts';

const PathQuery = z.object({ path: z.string().min(1) });

export function worktreesRoutes(ctx: DaemonContext): Hono {
  const app = phase4App();
  const svc = (): WorktreeService => {
    if (!ctx.worktrees) throw new HttpError(503, 'unavailable', 'worktree service is not running');
    return ctx.worktrees;
  };

  app.get('/worktrees', (c) => c.json(svc().list(parseQuery(c, WorktreeListQuery))));

  app.post('/worktrees/discover', async (c) => {
    await svc().discover();
    return c.json(svc().list({ state: 'active' }));
  });

  app.get('/worktrees/one', (c) => {
    const { path } = parseQuery(c, PathQuery);
    const view = svc().get(path);
    if (!view) throw new HttpError(404, 'not_found', `unknown worktree ${path}`);
    return c.json(view);
  });

  app.post('/worktrees', async (c) => {
    const b = await parseJson(c, CreateWorktreeBody);
    const branch = branchName(b);
    const dir = repoConfigFor(ctx, b.repo)?.worktreeDir ?? '.worktrees';
    const path = join(b.repo, dir, worktreeDirName(branch));
    requireConfirm(b.confirm, `Create worktree ${path} on new branch ${branch} from ${b.base}${b.runSetup ? ' and run the setup script' : ''}${b.launch ? `, then launch ${b.launch.source}` : ''}`, {
      branch,
      path,
    });
    if (!b.launch) {
      const { view, setupPtyId } = await svc().createWith(b, { runSetup: b.runSetup, actor: 'user' });
      return c.json({ worktree: view, setupPtyId, launch: null });
    }
    const req = LaunchRequest.parse({
      source: b.launch.source,
      projectId: ctx.projects.resolve(b.repo),
      cwd: b.repo,
      prompt: b.launch.prompt,
      ...(b.launch.templateId ? { templateId: b.launch.templateId } : {}),
      ...(b.ticket ? { ticket: b.ticket } : {}),
      planApproval: b.launch.planApproval,
      worktree: { repo: b.repo, base: b.base, type: b.type, slug: b.slug },
    });
    const launch = await launchSession(ctx, req);
    const view = svc().list({ repo: b.repo }).find((w) => w.branch === branch) ?? null;
    if (!view) throw new HttpError(500, 'internal', 'worktree was not recorded');
    return c.json({ worktree: view, setupPtyId: null, launch });
  });

  app.post('/worktrees/script', async (c) => {
    const b = await parseJson(c, WorktreeScriptBody);
    const script = (() => {
      const row = svc().get(b.path);
      return row ? repoConfigFor(ctx, row.repo)?.[b.which] : undefined;
    })();
    requireConfirm(b.confirm, `Run the ${b.which} script${script ? ` (${script})` : ''} in ${b.path}`, { script: script ?? null });
    return c.json(await svc().runScript(b.path, b.which));
  });

  app.post('/worktrees/open', async (c) => {
    const b = await parseJson(c, WorktreeOpenBody);
    await svc().open(b.path, b.target);
    return c.json({ ok: true });
  });

  app.get('/worktrees/sync-preview', async (c) => {
    const { path } = parseQuery(c, PathQuery);
    return c.json(await svc().syncPreview(path));
  });

  app.post('/worktrees/sync', async (c) => {
    const b = await parseJson(c, WorktreePathBody);
    if (!b.confirm) {
      const p = await svc().syncPreview(b.path);
      requireConfirm(false, `Copy ${p.files.length} changed file(s) from ${p.path} into ${p.mainPath}`, { files: p.files, mainDirty: p.mainDirty });
    }
    return c.json(await svc().syncToMain(b.path));
  });

  app.post('/worktrees/archive', async (c) => {
    const b = await parseJson(c, WorktreeArchiveBody);
    const view = svc().get(b.path);
    if (!view || view.state !== 'active') throw new HttpError(404, 'not_found', `unknown worktree ${b.path}`);
    const external = !view.createdByApp;
    requireConfirm(
      b.confirm,
      `Remove worktree ${view.path}. Branch ${view.branch} is kept.${external ? ' This worktree was created outside the app.' : ''}`,
      { external, branch: view.branch },
    );
    if (external && !b.confirmExternal) {
      throw new HttpError(409, 'external_worktree', 'this worktree was not created by the app; confirm it explicitly', { external: true });
    }
    await svc().archiveAs(b.path, 'user', { allowExternal: b.confirmExternal });
    return c.json({ ok: true });
  });

  return app;
}
```

- [ ] **Step 5: Implement the GitHub routes**

`apps/daemon/src/http/routes/github.ts`
```ts
import { PrRefSchema } from '@orc/api-contract';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { DaemonContext } from '../../context.ts';
import { getPrStatus, upsertPrStatus } from '../../db/repos/pr-cache.ts';
import { GitError } from '../../services/git/exec.ts';
import { HttpError } from '../errors.ts';
import { parseQuery, phase4App } from './git-guard.ts';

const PrQuery = z.object({ repo: PrRefSchema.shape.repo, number: z.coerce.number().int().positive() });

export function githubRoutes(ctx: DaemonContext): Hono {
  const app = phase4App();
  const gh = () => {
    if (!ctx.github) throw new HttpError(503, 'gh_unavailable', 'GitHub connector is not running');
    return ctx.github;
  };

  app.get('/github/status', async (c) => {
    if (!ctx.config().github.enabled) return c.json({ status: 'disabled' });
    return c.json({ status: await gh().status() });
  });

  app.get('/github/pr', async (c) => {
    const q = parseQuery(c, PrQuery);
    const ref = { repo: q.repo, number: q.number, url: `https://github.com/${q.repo}/pull/${q.number}` };
    try {
      const s = await gh().prStatus(ref);
      upsertPrStatus(ctx.db, s, new Date().toISOString());
      return c.json(s);
    } catch (err) {
      const cached = getPrStatus(ctx.db, q.repo, q.number);
      if (cached) return c.json(cached);
      throw err;
    }
  });

  app.get('/github/prs/mine', async (c) => {
    try {
      return c.json(await gh().myOpenPrs());
    } catch (err) {
      if (err instanceof GitError) throw new GitError('gh_unavailable', err.message, err.stderr);
      throw err;
    }
  });

  return app;
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run apps/daemon/src/http/routes/worktrees.test.ts apps/daemon/src/http/routes/github.test.ts`
Expected: PASS (6 + 3 tests).

- [ ] **Step 7: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon/src/http/routes
git commit -m "feat(daemon): worktree and GitHub API routes with confirmation guard"
```

---
### Task 18: HTTP routes — diff, checkpoints, review, ship, plan; daemon wiring; API client

**Files:**
- Create: `apps/daemon/src/http/routes/review.ts`, `apps/daemon/src/http/routes/ship.ts`, `apps/daemon/src/http/routes/plan.ts`, `packages/api-contract/src/client-phase4.ts`
- Modify: `apps/daemon/src/http/app.ts`, `apps/daemon/src/main.ts`, `packages/api-contract/src/client.ts`, `packages/api-contract/src/index.ts`
- Test: `apps/daemon/src/http/routes/review.test.ts`, `apps/daemon/src/http/routes/ship-plan.test.ts`, `apps/daemon/src/http/phase4-mount.test.ts`, `packages/api-contract/src/client-phase4.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 9–17
- Produces:
  ```ts
  export function reviewRoutes(ctx: DaemonContext): Hono      // /diff, /diff/revert, /checkpoints…, /review/:source/:id…
  export function shipRoutes(ctx: DaemonContext): Hono        // /ship/…
  export function planRoutes(ctx: DaemonContext): Hono        // /sessions/:source/:id/plan/(approve|reject)
  export function wirePhase4(ctx: DaemonContext): () => void  // in main.ts; creates services, registers rules/hooks, starts pollers; returns stop()
  // api-contract
  export type ApiRequester = <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, opts?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; schema?: z.ZodType<T> }) => Promise<T>
  export function worktreesClient(req: ApiRequester): { worktreesList; worktreesDiscover; worktreesGet; worktreesCreate; worktreesScript; worktreesOpen; worktreesSyncPreview; worktreesSync; worktreesArchive }
  export function reviewClient(req: ApiRequester): { diffGet; diffRevert; checkpointsList; checkpointsDiff; checkpointsCreate; checkpointsRewind; reviewGet; reviewComments }
  export function shipClient(req: ApiRequester): { shipSuggest; shipCommit; shipPush; shipPr; shipMerge; shipBackmerge; planApprove; planReject }
  export function githubClient(req: ApiRequester): { githubStatus; githubPr; githubMine }
  export type Phase4Client = ReturnType<typeof worktreesClient> & ReturnType<typeof reviewClient> & ReturnType<typeof shipClient> & ReturnType<typeof githubClient>
  ```
  (Full method signatures are in `client-phase4.ts` below.) If P1 already exports `ApiRequester`, import it instead of redeclaring.

- [ ] **Step 1: Write the failing route tests**

`apps/daemon/src/http/routes/review.test.ts`
```ts
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import type { LiveState } from '@orc/core';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { makeSession, memoryAudit, stubSessions } from '../../../test/stubs.ts';
import { createCheckpointService } from '../../services/checkpoint/checkpoint.ts';
import { createDiffService } from '../../services/diff/diff.ts';
import { createReviewService } from '../../services/review/review.ts';
import { createWorktreeService } from '../../services/worktree/worktree.ts';
import { reviewRoutes } from './review.ts';

let repo: TempRepo;
afterEach(() => repo.cleanup());

const owned: LiveState = {
  pid: 1, status: 'idle', waitingFor: null, since: '2026-09-17T10:00:00Z', ownership: 'owned', ptyId: 'pty-r',
  stage: null, currentTool: null, backgroundJobs: 0, runningSubagents: 0, contextFill: null,
};

async function setup() {
  repo = makeTempRepo();
  const cfg = OrcConfig.parse({ projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root], repos: [{ path: repo.dir }] }] });
  const wt = join(repo.dir, '.worktrees', 'feat-SAF-95-review');
  const sessions = stubSessions([makeSession({ id: 'r1', startCwd: wt, cwds: [wt], promptCount: 3, live: owned })]);
  const pty = recordingPty();
  const ctx = createTestContext({ config: () => cfg, sessions, pty, audit: memoryAudit() });
  ctx.worktrees = createWorktreeService(ctx);
  ctx.checkpoints = createCheckpointService(ctx);
  ctx.diff = createDiffService(ctx);
  ctx.review = createReviewService(ctx);
  await ctx.worktrees.createWith({ repo: repo.dir, base: 'main', type: 'feat', ticket: 'SAF-95', slug: 'review' }, { runSetup: false, actor: 'user' });
  const app: Hono = reviewRoutes(ctx);
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const write = (rel: string, body: string) => repo.write(join('.worktrees', 'feat-SAF-95-review', rel), body);
  return { ctx, app, post, wt, write, pty };
}

describe('diff routes', () => {
  it('returns the worktree diff and reverts with confirmation', async () => {
    const { app, post, wt, write } = await setup();
    write('src/a.ts', 'changed\n');
    const d = await app.request(`/diff?cwd=${encodeURIComponent(wt)}`);
    const body = (await d.json()) as { files: Array<{ path: string }>; to: string };
    expect(body.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(body.to).toBe('WORKTREE');
    const ask = await post('/diff/revert', { cwd: wt, file: 'src/a.ts' });
    expect(ask.status).toBe(409);
    expect(((await ask.json()) as { error: { details: { summary: string } } }).error.details.summary).toContain('src/a.ts');
    expect(await (await post('/diff/revert', { cwd: wt, file: 'src/a.ts', confirm: true })).json()).toEqual({ reverted: 'src/a.ts' });
    expect(repo.read('.worktrees/feat-SAF-95-review/src/a.ts')).toContain('export const a = 1;');
  });
});

describe('checkpoint routes', () => {
  it('creates, lists, diffs and rewinds checkpoints', async () => {
    const { app, post, write } = await setup();
    expect((await post('/checkpoints', { sessionPk: 'claude:r1' })).status).toBe(409);
    write('src/a.ts', 'turn A\n');
    const first = (await (await post('/checkpoints', { sessionPk: 'claude:r1', confirm: true })).json()) as { id: string; kind: string; turn: number };
    expect(first).toMatchObject({ kind: 'manual', turn: 3 });
    write('src/a.ts', 'turn B\n');
    const second = (await (await post('/checkpoints', { sessionPk: 'claude:r1', confirm: true })).json()) as { id: string };
    const list = (await (await app.request('/checkpoints?sessionPk=claude%3Ar1')).json()) as unknown[];
    expect(list).toHaveLength(2);
    const d = (await (await app.request(`/checkpoints/${second.id}/diff`)).json()) as { files: Array<{ path: string; additions: number }> };
    expect(d.files).toEqual([expect.objectContaining({ path: 'src/a.ts', additions: 1 })]);
    expect((await post(`/checkpoints/${first.id}/rewind`, {})).status).toBe(409);
    const rw = (await (await post(`/checkpoints/${first.id}/rewind`, { confirm: true })).json()) as { safety: { kind: string } };
    expect(rw.safety.kind).toBe('safety');
    expect(repo.read('.worktrees/feat-SAF-95-review/src/a.ts')).toBe('turn A\n');
    expect((await post('/checkpoints/nope/rewind', { confirm: true })).status).toBe(404);
  });
});

describe('review routes', () => {
  it('returns the summary and sends comments only with confirmation', async () => {
    const { app, post, write, pty } = await setup();
    write('src/a.ts', 'x\n');
    const s = (await (await app.request('/review/claude/r1')).json()) as { owned: boolean; files: unknown[] };
    expect(s.owned).toBe(true);
    expect(s.files).toHaveLength(1);
    const comments = [{ file: 'src/a.ts', line: 1, side: 'new', body: 'why x?' }];
    const text = (await (await post('/review/claude/r1/comments', { comments, deliver: 'text' })).json()) as { sent: boolean; text: string };
    expect(text.sent).toBe(false);
    expect((await post('/review/claude/r1/comments', { comments, deliver: 'session' })).status).toBe(409);
    const sent = (await (await post('/review/claude/r1/comments', { comments, deliver: 'session', confirm: true })).json()) as { sent: boolean };
    expect(sent.sent).toBe(true);
    expect(pty.texts).toHaveLength(1);
    expect((await app.request('/review/claude/missing')).status).toBe(404);
  });
});
```

`apps/daemon/src/http/routes/ship-plan.test.ts`
```ts
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import type { LiveState } from '@orc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeGh, useFakeGh } from '../../../test/fake-gh.ts';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { makeSession, memoryAudit, recordingInbox, stubSessions, stubTemplates } from '../../../test/stubs.ts';
import { createGithubConnector } from '../../connectors/github/github.ts';
import { createPlanApprovalService } from '../../services/review/plan-approval.ts';
import { createShipService } from '../../services/ship/ship.ts';
import { createWorktreeService } from '../../services/worktree/worktree.ts';
import { planRoutes } from './plan.ts';
import { shipRoutes } from './ship.ts';

let repo: TempRepo;
let fake: FakeGh;
afterEach(() => {
  repo.cleanup();
  fake.restore();
});

const owned: LiveState = {
  pid: 1, status: 'waiting', waitingFor: null, since: '2026-09-17T10:00:00Z', ownership: 'owned', ptyId: 'pty-p',
  stage: null, currentTool: 'ExitPlanMode', backgroundJobs: 0, runningSubagents: 0, contextFill: null,
};

async function setup() {
  repo = makeTempRepo({ withRemote: true });
  fake = useFakeGh();
  const cfg = OrcConfig.parse({ projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root], repos: [{ path: repo.dir }] }] });
  const inbox = recordingInbox();
  const pty = recordingPty();
  const sessions = stubSessions([makeSession({ id: 'p1', live: owned })]);
  const ctx = createTestContext({ config: () => cfg, sessions, pty, inbox, audit: memoryAudit(), templates: stubTemplates() });
  ctx.worktrees = createWorktreeService(ctx);
  ctx.github = createGithubConnector(ctx);
  ctx.ship = createShipService(ctx, { launch: async () => ({ ptyId: 'pty-bm', sessionId: null }) });
  ctx.plans = createPlanApprovalService(ctx);
  const { view } = await ctx.worktrees.createWith({ repo: repo.dir, base: 'main', type: 'feat', ticket: 'SAF-96', slug: 'ship' }, { runSetup: false, actor: 'user' });
  const ship = shipRoutes(ctx);
  const plan = planRoutes(ctx);
  const req = (app: typeof ship, path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ctx, ship, plan, req, view, pty, inbox };
}

describe('ship routes', () => {
  it('walks suggest → commit → push → PR → merge, each behind confirm', async () => {
    const { ship, req, view } = await setup();
    repo.write(join('.worktrees', 'feat-SAF-96-ship', 'src/a.ts'), 'shipped\n');
    const sug = (await (await ship.request(`/ship/suggest?cwd=${encodeURIComponent(view.path)}`)).json()) as { message: string; base: string };
    expect(sug.message).toBe('feat: SAF-96 ship');
    expect((await req(ship, '/ship/commit', { cwd: view.path, message: sug.message })).status).toBe(409);
    expect((await req(ship, '/ship/commit', { cwd: view.path, message: sug.message, confirm: true })).status).toBe(200);
    const askPush = await req(ship, '/ship/push', { cwd: view.path });
    expect(((await askPush.json()) as { error: { details: { summary: string } } }).error.details.summary).toContain('never forced');
    expect((await req(ship, '/ship/push', { cwd: view.path, confirm: true })).status).toBe(200);
    const pr = (await (await req(ship, '/ship/pr', { cwd: view.path, title: 'SAF-96 ship', body: 'b', base: sug.base, confirm: true })).json()) as { number: number; repo: string; url: string };
    expect(pr.number).toBe(101);
    expect((await req(ship, '/ship/merge', { pr, method: 'squash' })).status).toBe(409);
    expect(await (await req(ship, '/ship/merge', { pr, method: 'squash', confirm: true })).json()).toEqual({ ok: true });
    expect(fake.state().prs[`${pr.repo}#${pr.number}`]?.state).toBe('MERGED');
  });

  it('maps protected-branch and backmerge requests', async () => {
    const { ship, req, view } = await setup();
    const r = await req(ship, '/ship/push', { cwd: repo.dir, confirm: true });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('protected_branch');
    const bm = await req(ship, '/ship/backmerge', { cwd: view.path, projectId: 'wakecap', ticket: 'SAF-96', confirm: true });
    expect(await bm.json()).toEqual({ ptyId: 'pty-bm' });
  });
});

describe('plan routes', () => {
  it('approves and rejects with confirmation', async () => {
    const { plan, req, pty, inbox } = await setup();
    inbox.upsert({ kind: 'plan_approval', dedupeKey: 'plan:claude:p1', reason: 'Plan awaiting approval' });
    expect((await req(plan, '/sessions/claude/p1/plan/approve', {})).status).toBe(409);
    expect(await (await req(plan, '/sessions/claude/p1/plan/approve', { confirm: true })).json()).toEqual({ ok: true });
    expect(pty.writes).toHaveLength(1);
    inbox.upsert({ kind: 'plan_approval', dedupeKey: 'plan:claude:p1', reason: 'Plan awaiting approval' });
    expect((await req(plan, '/sessions/claude/p1/plan/reject', { feedback: '', confirm: true })).status).toBe(400);
    expect(await (await req(plan, '/sessions/claude/p1/plan/reject', { feedback: 'smaller steps', confirm: true })).json()).toEqual({ ok: true });
    const none = await req(plan, '/sessions/claude/p1/plan/approve', { confirm: true });
    expect(none.status).toBe(409);
  });
});
```

`apps/daemon/src/http/phase4-mount.test.ts`
```ts
import { readFileSync } from 'node:fs';
import { OrcConfig } from '@orc/api-contract';
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../../test/helpers.ts';
import { stubSessions } from '../../test/stubs.ts';
import { wirePhase4 } from '../main.ts';
import { createApp } from './app.ts';

describe('phase 4 mount', () => {
  it('serves phase 4 routes behind the token', async () => {
    const cfg = OrcConfig.parse({ github: { enabled: false } });
    const ctx = createTestContext({ config: () => cfg, sessions: stubSessions([]) });
    const stop = wirePhase4(ctx, { startPollers: false });
    const app = createApp(ctx);
    expect((await app.request('/api/worktrees')).status).toBe(401);
    const token = readFileSync(ctx.paths.tokenFile, 'utf8').trim();
    const ok = await app.request('/api/worktrees', { headers: { 'x-orc-token': token } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual([]);
    const gh = await app.request('/api/github/status', { headers: { 'x-orc-token': token } });
    expect(await gh.json()).toEqual({ status: 'disabled' });
    stop();
  });
});
```

`packages/api-contract/src/client-phase4.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { type ApiRequester, githubClient, reviewClient, shipClient, worktreesClient } from './client-phase4.ts';

describe('phase 4 client', () => {
  it('maps methods to routes', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const req: ApiRequester = async (method, path, opts) => {
      calls.push([method, path, opts?.body ?? opts?.query ?? null]);
      return undefined as never;
    };
    const c = { ...worktreesClient(req), ...reviewClient(req), ...shipClient(req), ...githubClient(req) };
    await c.worktreesArchive({ path: '/w', confirm: true, confirmExternal: false });
    await c.diffGet({ cwd: '/w' });
    await c.checkpointsRewind('id1', { confirm: true });
    await c.reviewComments('claude', 's1', { comments: [{ file: 'a', line: 1, side: 'new', body: 'x' }], deliver: 'text', confirm: false });
    await c.planReject('claude', 's1', { feedback: 'no', confirm: true });
    await c.githubPr('o/r', 3);
    expect(calls).toEqual([
      ['POST', '/api/worktrees/archive', { path: '/w', confirm: true, confirmExternal: false }],
      ['GET', '/api/diff', { cwd: '/w' }],
      ['POST', '/api/checkpoints/id1/rewind', { confirm: true }],
      ['POST', '/api/review/claude/s1/comments', { comments: [{ file: 'a', line: 1, side: 'new', body: 'x' }], deliver: 'text', confirm: false }],
      ['POST', '/api/sessions/claude/s1/plan/reject', { feedback: 'no', confirm: true }],
      ['GET', '/api/github/pr', { repo: 'o/r', number: 3 }],
    ]);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run apps/daemon/src/http packages/api-contract/src/client-phase4.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the review routes**

`apps/daemon/src/http/routes/review.ts`
```ts
import {
  CheckpointCreateBody,
  CheckpointRewindBody,
  DiffQuery,
  DiffRevertBody,
  ReviewCommentsBody,
} from '@orc/api-contract';
import type { Source } from '@orc/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { DaemonContext } from '../../context.ts';
import { getCheckpoint } from '../../db/repos/checkpoints.ts';
import { sessionWorkdir } from '../../services/review/review.ts';
import { HttpError } from '../errors.ts';
import { parseJson, parseQuery, phase4App, requireConfirm } from './git-guard.ts';

const SourceParam = z.enum(['claude', 'codex', 'agnc']);

export function reviewRoutes(ctx: DaemonContext): Hono {
  const app = phase4App();
  const need = <T>(v: T | undefined, name: string): T => {
    if (!v) throw new HttpError(503, 'unavailable', `${name} service is not running`);
    return v;
  };

  app.get('/diff', async (c) => {
    const q = parseQuery(c, DiffQuery);
    return c.json(await need(ctx.diff, 'diff').diff(q.cwd, { ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}) }));
  });

  app.post('/diff/revert', async (c) => {
    const b = await parseJson(c, DiffRevertBody);
    const what = b.hunkIndex === undefined ? `all changes to ${b.file}` : `hunk ${b.hunkIndex + 1} of ${b.file}`;
    requireConfirm(b.confirm, `Revert ${what} in ${b.cwd}. A safety snapshot is kept under refs/orchestrator/reverts/.`);
    return c.json(await need(ctx.diff, 'diff').revert(b.cwd, b.file, { ...(b.hunkIndex === undefined ? {} : { hunkIndex: b.hunkIndex }), ...(b.from ? { from: b.from } : {}) }));
  });

  app.get('/checkpoints', (c) => {
    const { sessionPk } = parseQuery(c, z.object({ sessionPk: z.string().min(1) }));
    return c.json(need(ctx.checkpoints, 'checkpoint').list(sessionPk));
  });

  app.get('/checkpoints/:id/diff', async (c) => {
    const cps = need(ctx.checkpoints, 'checkpoint');
    const cp = cps.get(c.req.param('id'));
    if (!cp) throw new HttpError(404, 'not_found', 'unknown checkpoint');
    const pk = getCheckpoint(ctx.db, cp.id)?.sessionPk ?? '';
    const earlier = cps.list(pk).filter((x) => x.createdAt < cp.createdAt && x.kind !== 'safety');
    const from = earlier[earlier.length - 1]?.commit ?? `${cp.commit}^`;
    return c.json(await need(ctx.diff, 'diff').diff(cp.worktreePath, { from, to: cp.commit }));
  });

  app.post('/checkpoints', async (c) => {
    const b = await parseJson(c, CheckpointCreateBody);
    const s = ctx.sessions.getByPk(b.sessionPk);
    if (!s) throw new HttpError(404, 'not_found', `session ${b.sessionPk} not found`);
    const wt = ctx.worktrees?.findByCwd(sessionWorkdir(s)) ?? null;
    if (!wt) throw new HttpError(404, 'no_worktree', 'the session is not inside a known worktree');
    requireConfirm(b.confirm, `Save a checkpoint of ${wt.path} (HEAD, index and stash are not touched)`);
    return c.json(await need(ctx.checkpoints, 'checkpoint').createAs(b.sessionPk, wt.path, s.promptCount, 'manual', 'user'));
  });

  app.post('/checkpoints/:id/rewind', async (c) => {
    const b = await parseJson(c, CheckpointRewindBody);
    const cps = need(ctx.checkpoints, 'checkpoint');
    const cp = cps.get(c.req.param('id'));
    if (!cp) throw new HttpError(404, 'not_found', 'unknown checkpoint');
    requireConfirm(b.confirm, `Restore the files in ${cp.worktreePath} to turn ${cp.turn}. The current state is saved first as a safety checkpoint.`, {
      turn: cp.turn,
      createdAt: cp.createdAt,
    });
    return c.json({ safety: await cps.rewind(cp.id) });
  });

  app.get('/review/:source/:id', async (c) => {
    const source = SourceParam.parse(c.req.param('source')) as Source;
    return c.json(await need(ctx.review, 'review').summary(source, c.req.param('id')));
  });

  app.post('/review/:source/:id/comments', async (c) => {
    const source = SourceParam.parse(c.req.param('source')) as Source;
    const b = await parseJson(c, ReviewCommentsBody);
    if (b.deliver === 'session') requireConfirm(b.confirm, `Send ${b.comments.length} review comment(s) to the running session`);
    return c.json(await need(ctx.review, 'review').sendComments(source, c.req.param('id'), b.comments, b.deliver));
  });

  return app;
}
```
The checkpoint diff reads the session pk from the stored row (`CheckpointRecord` only carries the native `sessionId`), then diffs against the previous non-safety checkpoint of that session, or the checkpoint's parent commit for the first one.

- [ ] **Step 4: Implement the ship and plan routes**

`apps/daemon/src/http/routes/ship.ts`
```ts
import { ShipBackmergeBody, ShipCommitBody, ShipMergeBody, ShipPrBody, ShipPushBody } from '@orc/api-contract';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { DaemonContext } from '../../context.ts';
import { getPrStatus } from '../../db/repos/pr-cache.ts';
import { currentBranch } from '../../services/ship/ship.ts';
import { dirtyFiles } from '../../services/worktree/worktree-read.ts';
import { HttpError } from '../errors.ts';
import { parseJson, parseQuery, phase4App, requireConfirm } from './git-guard.ts';

const SuggestQuery = z.object({ cwd: z.string().min(1), sessionPk: z.string().optional() });

export function shipRoutes(ctx: DaemonContext): Hono {
  const app = phase4App();
  const ship = () => {
    if (!ctx.ship) throw new HttpError(503, 'unavailable', 'ship service is not running');
    return ctx.ship;
  };

  app.get('/ship/suggest', async (c) => {
    const q = parseQuery(c, SuggestQuery);
    return c.json(await ship().suggest(q.cwd, q.sessionPk ?? null));
  });

  app.post('/ship/commit', async (c) => {
    const b = await parseJson(c, ShipCommitBody);
    if (!b.confirm) {
      const files = await dirtyFiles(b.cwd);
      requireConfirm(false, `Commit ${files.length} changed file(s) in ${b.cwd} as "${b.message.split('\n')[0]}"`, { files });
    }
    return c.json(await ship().commit(b.cwd, b.message));
  });

  app.post('/ship/push', async (c) => {
    const b = await parseJson(c, ShipPushBody);
    if (!b.confirm) {
      const branch = await currentBranch(b.cwd);
      requireConfirm(false, `Push ${branch} to origin (never forced)`, { branch });
    }
    await ship().push(b.cwd);
    return c.json({ ok: true });
  });

  app.post('/ship/pr', async (c) => {
    const b = await parseJson(c, ShipPrBody);
    requireConfirm(b.confirm, `Open ${b.draft ? 'a draft' : 'a'} pull request "${b.title}" into ${b.base}`);
    return c.json(await ship().createPr(b.cwd, { title: b.title, body: b.body, base: b.base, draft: b.draft }));
  });

  app.post('/ship/merge', async (c) => {
    const b = await parseJson(c, ShipMergeBody);
    const cached = getPrStatus(ctx.db, b.pr.repo, b.pr.number);
    requireConfirm(b.confirm, `Merge ${b.pr.repo}#${b.pr.number} with ${b.method}. Branch protection still applies.`, {
      checks: cached?.checks ?? null,
      review: cached?.review ?? null,
    });
    await ship().merge(b.pr, b.method);
    return c.json({ ok: true });
  });

  app.post('/ship/backmerge', async (c) => {
    const b = await parseJson(c, ShipBackmergeBody);
    requireConfirm(b.confirm, `Launch the /backmerge workflow in ${b.cwd}`);
    return c.json(await ship().backmerge(b.cwd, b.projectId, b.ticket));
  });

  return app;
}
```

`apps/daemon/src/http/routes/plan.ts`
```ts
import { PlanApproveBody, PlanRejectBody } from '@orc/api-contract';
import type { Hono } from 'hono';
import type { DaemonContext } from '../../context.ts';
import { HttpError } from '../errors.ts';
import { parseJson, phase4App, requireConfirm } from './git-guard.ts';

export function planRoutes(ctx: DaemonContext): Hono {
  const app = phase4App();
  const plans = () => {
    if (!ctx.plans) throw new HttpError(503, 'unavailable', 'plan approval service is not running');
    return ctx.plans;
  };
  const pkOf = (source: string, id: string) => {
    if (source !== 'claude') throw new HttpError(400, 'validation_failed', 'plan approval is only available for Claude sessions');
    return `${source}:${id}`;
  };

  app.post('/sessions/:source/:id/plan/approve', async (c) => {
    const b = await parseJson(c, PlanApproveBody);
    const pk = pkOf(c.req.param('source'), c.req.param('id'));
    requireConfirm(b.confirm, 'Approve the plan and let the agent start implementing');
    await plans().approve(pk);
    return c.json({ ok: true });
  });

  app.post('/sessions/:source/:id/plan/reject', async (c) => {
    const b = await parseJson(c, PlanRejectBody);
    const pk = pkOf(c.req.param('source'), c.req.param('id'));
    requireConfirm(b.confirm, 'Reject the plan and send your feedback to the agent');
    await plans().reject(pk, b.feedback);
    return c.json({ ok: true });
  });

  return app;
}
```

- [ ] **Step 5: Wire the daemon and mount the routes**

In `apps/daemon/src/main.ts` add and export:
```ts
import { createGithubConnector } from './connectors/github/github.ts';
import { createPlanApprovalRule } from './inbox/rules/plan-approval.ts';
import { prEventRule } from './inbox/rules/pr-event.ts';
import { createCheckpointService } from './services/checkpoint/checkpoint.ts';
import { registerCheckpointHook } from './services/checkpoint/turn-hook.ts';
import { createDiffService } from './services/diff/diff.ts';
import { createPlanApprovalService } from './services/review/plan-approval.ts';
import { createReviewService } from './services/review/review.ts';
import { createShipService } from './services/ship/ship.ts';
import { registerAutoArchive } from './services/worktree/auto-archive.ts';
import { createWorktreeService } from './services/worktree/worktree.ts';

const DISCOVER_EVERY_MS = 5 * 60_000;

export function wirePhase4(ctx: DaemonContext, opts: { startPollers?: boolean } = {}): () => void {
  ctx.worktrees = createWorktreeService(ctx);
  ctx.checkpoints = createCheckpointService(ctx);
  ctx.diff = createDiffService(ctx);
  ctx.review = createReviewService(ctx);
  ctx.github = createGithubConnector(ctx);
  ctx.ship = createShipService(ctx);
  ctx.plans = createPlanApprovalService(ctx);
  ctx.inbox?.registerRule(prEventRule);
  ctx.inbox?.registerRule(createPlanApprovalRule());
  const stops: Array<() => void> = [registerCheckpointHook(ctx), registerAutoArchive(ctx)];
  if (opts.startPollers ?? true) {
    stops.push(ctx.github.start());
    const discover = () => {
      ctx.worktrees?.discover().catch((err: unknown) => ctx.log.warn({ err }, 'worktree discovery failed'));
    };
    discover();
    const timer = setInterval(discover, DISCOVER_EVERY_MS);
    timer.unref();
    stops.push(() => clearInterval(timer));
  }
  return () => {
    for (const stop of stops) stop();
  };
}
```
In `createDaemon`, call `const stopPhase4 = wirePhase4(ctx);` right after the Phase 3 services are assigned (audit and deny-list must exist first), and call `stopPhase4()` inside `close()` before the PTYs are stopped.

In `apps/daemon/src/http/app.ts`, next to the other `app.route('/api', …)` lines:
```ts
  app.route('/api', worktreesRoutes(ctx));
  app.route('/api', githubRoutes(ctx));
  app.route('/api', reviewRoutes(ctx));
  app.route('/api', shipRoutes(ctx));
  app.route('/api', planRoutes(ctx));
```
with the matching imports from `./routes/*.ts`. Mount `planRoutes` **before** any P1/P2 catch-all `/sessions/:source/:id/*` handler.

- [ ] **Step 6: Write the API client factories**

`packages/api-contract/src/client-phase4.ts`
```ts
import type { CheckpointRecord, DiffResult, PrRef, PrStatus, ReviewComment, ReviewSummary, Source, WorktreeView } from '@orc/core';
import type { z } from 'zod';
import type { CreateWorktreeBody, CreateWorktreeResult, SyncPreview, WorktreeListQuery } from './routes/worktrees.ts';
import type { ShipSuggestion } from './routes/ship.ts';

export type ApiRequester = <T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; schema?: z.ZodType<T> },
) => Promise<T>;

type In<T extends z.ZodType> = z.input<T>;
const enc = encodeURIComponent;

export function worktreesClient(req: ApiRequester) {
  return {
    worktreesList: (q: z.infer<typeof WorktreeListQuery> = {}) => req<WorktreeView[]>('GET', '/api/worktrees', { query: q }),
    worktreesDiscover: () => req<WorktreeView[]>('POST', '/api/worktrees/discover', { body: {} }),
    worktreesGet: (path: string) => req<WorktreeView>('GET', '/api/worktrees/one', { query: { path } }),
    worktreesCreate: (body: In<typeof CreateWorktreeBody>) => req<z.infer<typeof CreateWorktreeResult>>('POST', '/api/worktrees', { body }),
    worktreesScript: (body: { path: string; which: 'setup' | 'run' | 'archive'; confirm: boolean }) => req<{ ptyId: string }>('POST', '/api/worktrees/script', { body }),
    worktreesOpen: (body: { path: string; target: 'vscode' | 'terminal' | 'finder' }) => req<{ ok: true }>('POST', '/api/worktrees/open', { body }),
    worktreesSyncPreview: (path: string) => req<z.infer<typeof SyncPreview>>('GET', '/api/worktrees/sync-preview', { query: { path } }),
    worktreesSync: (body: { path: string; confirm: boolean }) => req<{ files: number }>('POST', '/api/worktrees/sync', { body }),
    worktreesArchive: (body: { path: string; confirm: boolean; confirmExternal: boolean }) => req<{ ok: true }>('POST', '/api/worktrees/archive', { body }),
  };
}

export function reviewClient(req: ApiRequester) {
  return {
    diffGet: (q: { cwd: string; from?: string; to?: string }) => req<DiffResult>('GET', '/api/diff', { query: q }),
    diffRevert: (body: { cwd: string; file: string; hunkIndex?: number; from?: string; confirm: boolean }) =>
      req<{ reverted: string }>('POST', '/api/diff/revert', { body }),
    checkpointsList: (sessionPk: string) => req<CheckpointRecord[]>('GET', '/api/checkpoints', { query: { sessionPk } }),
    checkpointsDiff: (id: string) => req<DiffResult>('GET', `/api/checkpoints/${enc(id)}/diff`),
    checkpointsCreate: (body: { sessionPk: string; confirm: boolean }) => req<CheckpointRecord>('POST', '/api/checkpoints', { body }),
    checkpointsRewind: (id: string, body: { confirm: boolean }) => req<{ safety: CheckpointRecord }>('POST', `/api/checkpoints/${enc(id)}/rewind`, { body }),
    reviewGet: (source: Source, id: string) => req<ReviewSummary>('GET', `/api/review/${source}/${enc(id)}`),
    reviewComments: (source: Source, id: string, body: { comments: ReviewComment[]; deliver: 'session' | 'text'; confirm: boolean }) =>
      req<{ sent: boolean; text: string }>('POST', `/api/review/${source}/${enc(id)}/comments`, { body }),
  };
}

export function shipClient(req: ApiRequester) {
  return {
    shipSuggest: (q: { cwd: string; sessionPk?: string }) => req<z.infer<typeof ShipSuggestion>>('GET', '/api/ship/suggest', { query: q }),
    shipCommit: (body: { cwd: string; message: string; confirm: boolean }) => req<{ sha: string }>('POST', '/api/ship/commit', { body }),
    shipPush: (body: { cwd: string; confirm: boolean }) => req<{ ok: true }>('POST', '/api/ship/push', { body }),
    shipPr: (body: { cwd: string; title: string; body: string; base: string; draft: boolean; confirm: boolean }) => req<PrRef>('POST', '/api/ship/pr', { body }),
    shipMerge: (body: { pr: PrRef; method: 'merge' | 'squash' | 'rebase'; confirm: boolean }) => req<{ ok: true }>('POST', '/api/ship/merge', { body }),
    shipBackmerge: (body: { cwd: string; projectId: string; ticket: string | null; confirm: boolean }) => req<{ ptyId: string }>('POST', '/api/ship/backmerge', { body }),
    planApprove: (source: Source, id: string, body: { confirm: boolean }) => req<{ ok: true }>('POST', `/api/sessions/${source}/${enc(id)}/plan/approve`, { body }),
    planReject: (source: Source, id: string, body: { feedback: string; confirm: boolean }) =>
      req<{ ok: true }>('POST', `/api/sessions/${source}/${enc(id)}/plan/reject`, { body }),
  };
}

export function githubClient(req: ApiRequester) {
  return {
    githubStatus: () => req<{ status: 'ok' | 'unauthenticated' | 'error' | 'disabled' }>('GET', '/api/github/status'),
    githubPr: (repo: string, number: number) => req<PrStatus>('GET', '/api/github/pr', { query: { repo, number } }),
    githubMine: () => req<PrStatus[]>('GET', '/api/github/prs/mine'),
  };
}

export type Phase4Client = ReturnType<typeof worktreesClient> &
  ReturnType<typeof reviewClient> &
  ReturnType<typeof shipClient> &
  ReturnType<typeof githubClient>;
```
In `packages/api-contract/src/client.ts`, spread the four factories into the object `createApiClient` returns (`...worktreesClient(req), ...reviewClient(req), ...shipClient(req), ...githubClient(req)`) and add `Phase4Client` to the `ApiClient` type. Export `./client-phase4.ts` from `index.ts`.

- [ ] **Step 7: Run everything**

Run: `pnpm vitest run apps/daemon/src/http packages/api-contract`
Expected: PASS (review 3, ship/plan 3, mount 1, client 1, plus the Task 17 route tests).

- [ ] **Step 8: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/daemon/src packages/api-contract/src
git commit -m "feat(daemon): review, checkpoint, ship and plan routes; wire phase 4 services"
```

---
### Task 19: Web — query hooks, live events, confirm flow and the `/worktrees` page

**Files:**
- Modify: `packages/core/package.json` (add the `./git` subpath export), `apps/web/src/api/live-events.ts`, `apps/web/src/features/shell/AppShell.tsx` (`NAV_ITEMS`)
- Create: `apps/web/src/api/queries/worktrees.ts`, `apps/web/src/api/queries/review.ts`, `apps/web/src/api/queries/ship.ts`, `apps/web/src/api/queries/github.ts`
- Create: `apps/web/src/features/git/useConfirmedMutation.ts`, `apps/web/src/features/git/GitConfirmDialog.tsx`
- Create: `apps/web/src/features/worktrees/WorktreesPage.tsx`, `apps/web/src/features/worktrees/WorktreeRow.tsx`, `apps/web/src/features/worktrees/CreateWorktreeDialog.tsx`, `apps/web/src/routes/worktrees.tsx`
- Test: `apps/web/src/features/git/useConfirmedMutation.test.tsx`, `apps/web/src/features/worktrees/WorktreesPage.test.tsx`, `apps/web/src/api/live-events.phase4.test.ts`

**Interfaces:**
- Consumes: `Phase4Client` methods (Task 18), `getApiClient`, `setApiClientForTests`, `ApiRequestError`, `applyLiveEvent`, `useTerminalStore`, `renderWithProviders` (assumed), `branchName` from `@orc/core/git`
- Produces:
  ```ts
  // api/queries/worktrees.ts
  export const worktreeKeys: { all: readonly ['worktrees']; list: (f: WorktreeFilter) => readonly ['worktrees', WorktreeFilter] }
  export type WorktreeFilter = { projectId?: string; state?: 'active' | 'archived'; repo?: string }
  export function useWorktrees(f: WorktreeFilter): UseQueryResult<WorktreeView[]>
  export function useDiscoverWorktrees(): UseMutationResult<WorktreeView[], Error, void>
  // api/queries/review.ts
  export function useDiff(cwd: string | null, from?: string, to?: string): UseQueryResult<DiffResult>
  export function useCheckpoints(sessionPk: string): UseQueryResult<CheckpointRecord[]>
  export function useCheckpointDiff(id: string | null): UseQueryResult<DiffResult>
  export function useReview(source: Source, id: string): UseQueryResult<ReviewSummary>
  // api/queries/ship.ts
  export function useShipSuggest(cwd: string | null, sessionPk: string | null): UseQueryResult<ShipSuggestionResult>
  // api/queries/github.ts
  export function usePrStatus(pr: PrRef | null): UseQueryResult<PrStatus>
  export function useGithubStatus(): UseQueryResult<{ status: 'ok' | 'unauthenticated' | 'error' | 'disabled' }>
  // features/git/useConfirmedMutation.ts
  export interface ConfirmRequest<V> { summary: string; details: Record<string, unknown>; vars: V }
  export function useConfirmedMutation<V, R>(fn: (vars: V, confirm: boolean) => Promise<R>, opts?: { onSuccess?: (r: R, vars: V) => void; invalidate?: ReadonlyArray<readonly unknown[]> }): {
    run(vars: V): Promise<void>; confirm(patch?: Partial<V>): Promise<void>; cancel(): void;
    pending: ConfirmRequest<V> | null; busy: boolean; error: ApiRequestError | Error | null; data: R | null;
  }
  // features/git/GitConfirmDialog.tsx
  export function GitConfirmDialog<V>(props: { request: ConfirmRequest<V> | null; busy: boolean; title: string; confirmLabel: string; danger?: boolean; onConfirm: (patch?: Partial<V>) => void; onCancel: () => void }): JSX.Element | null
  ```

- [ ] **Step 1: Add the core subpath export**

In `packages/core/package.json` change `exports` to:
```json
"exports": { ".": "./src/index.ts", "./git": "./src/git/index.ts" }
```
`src/git/*` only imports types, so the web bundle does not pull in `node:fs`.

- [ ] **Step 2: Write the failing tests**

`apps/web/src/features/git/useConfirmedMutation.test.tsx`
```tsx
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/api/client';
import { useConfirmedMutation } from './useConfirmedMutation';

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

describe('useConfirmedMutation', () => {
  it('turns a 409 confirmation_required into a pending request, then retries with confirm', async () => {
    const fn = vi.fn(async (vars: { path: string; confirmExternal?: boolean }, confirm: boolean) => {
      if (!confirm) throw new ApiRequestError(409, 'confirmation_required', 'x', { summary: 'Remove worktree /w', external: true });
      return { ok: true, vars };
    });
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useConfirmedMutation(fn, { onSuccess }), { wrapper });
    await act(() => result.current.run({ path: '/w' }));
    expect(result.current.pending).toEqual({ summary: 'Remove worktree /w', details: { summary: 'Remove worktree /w', external: true }, vars: { path: '/w' } });
    await act(() => result.current.confirm({ confirmExternal: true }));
    await waitFor(() => expect(result.current.data).toEqual({ ok: true, vars: { path: '/w', confirmExternal: true } }));
    expect(fn).toHaveBeenLastCalledWith({ path: '/w', confirmExternal: true }, true);
    expect(result.current.pending).toBeNull();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('surfaces other errors and supports cancel', async () => {
    const fn = vi.fn(async (_v: number, confirm: boolean) => {
      if (!confirm) throw new ApiRequestError(409, 'confirmation_required', 'x', { summary: 's' });
      throw new ApiRequestError(409, 'dirty_worktree', 'uncommitted changes');
    });
    const { result } = renderHook(() => useConfirmedMutation(fn), { wrapper });
    await act(() => result.current.run(1));
    act(() => result.current.cancel());
    expect(result.current.pending).toBeNull();
    await act(() => result.current.run(1));
    await act(() => result.current.confirm());
    expect((result.current.error as ApiRequestError).code).toBe('dirty_worktree');
  });
});
```

`apps/web/src/features/worktrees/WorktreesPage.test.tsx`
```tsx
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { WorktreeView } from '@orc/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, type ApiClient, setApiClientForTests } from '@/api/client';
import { renderWithProviders } from '@/test/render';
import { WorktreesPage } from './WorktreesPage';

const view = (p: Partial<WorktreeView>): WorktreeView => ({
  path: '/r/.worktrees/feat-SAF-1-x', repo: '/r', branch: 'feat/SAF-1-x', base: 'main', ticket: 'SAF-1', dirty: false, prUrl: null,
  state: 'active', createdByApp: true, head: 'abc', isMain: false, origin: 'app', sessionPks: ['claude:s1'], projectId: 'wakecap',
  prStatus: null, updatedAt: '2026-09-17T10:00:00Z', ...p,
});

let archive: ReturnType<typeof vi.fn>;

beforeEach(() => {
  archive = vi.fn(async (body: { confirm: boolean; confirmExternal: boolean }) => {
    if (!body.confirm) throw new ApiRequestError(409, 'confirmation_required', 'c', { summary: 'Remove worktree /r/.worktrees/ext', external: true });
    if (!body.confirmExternal) throw new ApiRequestError(409, 'external_worktree', 'external');
    return { ok: true };
  });
  setApiClientForTests({
    worktreesList: async () => [
      view({ path: '/r', branch: 'main', isMain: true, origin: 'config', createdByApp: false, ticket: null, sessionPks: [] }),
      view({}),
      view({ path: '/r/.worktrees/ext', branch: 'fix/SAF-2-ext', ticket: 'SAF-2', createdByApp: false, origin: 'worktree-dir', dirty: true,
        prStatus: { pr: { repo: 'o/r', number: 2, url: 'https://github.com/o/r/pull/2' }, state: 'open', title: 't', checks: 'failure', review: 'none', updatedAt: 'x', headRef: 'fix/SAF-2-ext', failedChecks: ['unit'] } }),
    ],
    worktreesDiscover: async () => [],
    worktreesArchive: archive,
    worktreesOpen: async () => ({ ok: true }),
    worktreesScript: async () => ({ ptyId: 'pty-1' }),
    worktreesSync: async () => ({ files: 0 }),
  } as unknown as ApiClient);
});

describe('WorktreesPage', () => {
  it('groups by repo and shows ticket, origin, dirty and PR state', async () => {
    renderWithProviders(<WorktreesPage />);
    expect(await screen.findByText('feat/SAF-1-x')).toBeDefined();
    expect(screen.getByRole('heading', { name: '/r' })).toBeDefined();
    expect(screen.getByText('external')).toBeDefined();
    expect(screen.getByText('dirty')).toBeDefined();
    expect(screen.getByText('#2 · checks failing')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Archive main' })).toBeNull();
  });

  it('archives an external worktree only after both confirmations', async () => {
    renderWithProviders(<WorktreesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive fix/SAF-2-ext' }));
    expect(await screen.findByText('Remove worktree /r/.worktrees/ext')).toBeDefined();
    const confirm = screen.getByRole('button', { name: 'Archive' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('I understand this worktree was created outside the app'));
    fireEvent.click(confirm);
    await waitFor(() => expect(archive).toHaveBeenLastCalledWith({ path: '/r/.worktrees/ext', confirm: true, confirmExternal: true }));
  });
});
```

`apps/web/src/api/live-events.phase4.test.ts`
```ts
import { QueryClient } from '@tanstack/react-query';
import type { PrStatus, WorktreeView } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { applyLiveEvent } from './live-events';

describe('applyLiveEvent (phase 4)', () => {
  it('upserts and removes worktrees in every cached list and updates PR status', () => {
    const qc = new QueryClient();
    const w = { path: '/w', branch: 'feat/x', state: 'active' } as WorktreeView;
    qc.setQueryData(['worktrees', { state: 'active' }], [] as WorktreeView[]);
    applyLiveEvent(qc, { type: 'worktree.updated', worktree: w });
    expect(qc.getQueryData(['worktrees', { state: 'active' }])).toEqual([w]);
    applyLiveEvent(qc, { type: 'worktree.updated', worktree: { ...w, branch: 'feat/y' } });
    expect((qc.getQueryData(['worktrees', { state: 'active' }]) as WorktreeView[])[0]?.branch).toBe('feat/y');
    applyLiveEvent(qc, { type: 'worktree.removed', path: '/w' });
    expect(qc.getQueryData(['worktrees', { state: 'active' }])).toEqual([]);
    const s = { pr: { repo: 'o/r', number: 1, url: 'u' }, state: 'merged' } as PrStatus;
    applyLiveEvent(qc, { type: 'pr.updated', status: s });
    expect(qc.getQueryData(['pr', 'o/r', 1])).toEqual(s);
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `pnpm vitest run apps/web/src/features/git apps/web/src/features/worktrees apps/web/src/api/live-events.phase4.test.ts`
Expected: FAIL, modules not found / `applyLiveEvent` ignores the new types.

- [ ] **Step 4: Implement the query hooks**

`apps/web/src/api/queries/worktrees.ts`
```ts
import type { WorktreeView } from '@orc/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client';

export type WorktreeFilter = { projectId?: string; state?: 'active' | 'archived'; repo?: string };

export const worktreeKeys = {
  all: ['worktrees'] as const,
  list: (f: WorktreeFilter) => ['worktrees', f] as const,
};

export function useWorktrees(f: WorktreeFilter) {
  return useQuery<WorktreeView[]>({ queryKey: worktreeKeys.list(f), queryFn: () => getApiClient().worktreesList(f) });
}

export function useDiscoverWorktrees() {
  const qc = useQueryClient();
  return useMutation<WorktreeView[], Error, void>({
    mutationFn: () => getApiClient().worktreesDiscover(),
    onSuccess: () => qc.invalidateQueries({ queryKey: worktreeKeys.all }),
  });
}
```

`apps/web/src/api/queries/review.ts`
```ts
import type { CheckpointRecord, DiffResult, ReviewSummary, Source } from '@orc/core';
import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client';

export function useDiff(cwd: string | null, from?: string, to?: string) {
  return useQuery<DiffResult>({
    queryKey: ['diff', cwd, from ?? null, to ?? null],
    enabled: cwd !== null,
    queryFn: () => getApiClient().diffGet({ cwd: cwd ?? '', ...(from ? { from } : {}), ...(to ? { to } : {}) }),
  });
}

export function useCheckpoints(sessionPk: string) {
  return useQuery<CheckpointRecord[]>({ queryKey: ['checkpoints', sessionPk], queryFn: () => getApiClient().checkpointsList(sessionPk) });
}

export function useCheckpointDiff(id: string | null) {
  return useQuery<DiffResult>({
    queryKey: ['checkpoint-diff', id],
    enabled: id !== null,
    queryFn: () => getApiClient().checkpointsDiff(id ?? ''),
  });
}

export function useReview(source: Source, id: string) {
  return useQuery<ReviewSummary>({ queryKey: ['review', source, id], queryFn: () => getApiClient().reviewGet(source, id) });
}
```

`apps/web/src/api/queries/ship.ts`
```ts
import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client';

export interface ShipSuggestionResult { message: string; title: string; body: string; base: string; branch: string; ticket: string | null }

export function useShipSuggest(cwd: string | null, sessionPk: string | null) {
  return useQuery<ShipSuggestionResult>({
    queryKey: ['ship-suggest', cwd, sessionPk],
    enabled: cwd !== null,
    queryFn: () => getApiClient().shipSuggest({ cwd: cwd ?? '', ...(sessionPk ? { sessionPk } : {}) }),
  });
}
```

`apps/web/src/api/queries/github.ts`
```ts
import type { PrRef, PrStatus } from '@orc/core';
import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client';

export function usePrStatus(pr: PrRef | null) {
  return useQuery<PrStatus>({
    queryKey: ['pr', pr?.repo ?? null, pr?.number ?? null],
    enabled: pr !== null,
    staleTime: 60_000,
    queryFn: () => getApiClient().githubPr(pr?.repo ?? '', pr?.number ?? 0),
  });
}

export function useGithubStatus() {
  return useQuery({ queryKey: ['github', 'status'], queryFn: () => getApiClient().githubStatus(), staleTime: 300_000 });
}
```

- [ ] **Step 5: Handle the new live events**

In `apps/web/src/api/live-events.ts`, add these cases to the `switch` in `applyLiveEvent` (import `WorktreeView` from `@orc/core`):
```ts
    case 'worktree.updated': {
      for (const [key, list] of qc.getQueriesData<WorktreeView[]>({ queryKey: ['worktrees'] })) {
        if (!list) continue;
        const i = list.findIndex((w) => w.path === e.worktree.path);
        qc.setQueryData(key, i === -1 ? [...list, e.worktree] : list.map((w, j) => (j === i ? e.worktree : w)));
      }
      qc.invalidateQueries({ queryKey: ['review'] });
      break;
    }
    case 'worktree.removed': {
      for (const [key, list] of qc.getQueriesData<WorktreeView[]>({ queryKey: ['worktrees'] })) {
        if (list) qc.setQueryData(key, list.filter((w) => w.path !== e.path));
      }
      break;
    }
    case 'pr.updated': {
      qc.setQueryData(['pr', e.status.pr.repo, e.status.pr.number], e.status);
      qc.invalidateQueries({ queryKey: ['review'] });
      break;
    }
    case 'checkpoint.created': {
      qc.invalidateQueries({ queryKey: ['checkpoints'] });
      break;
    }
```
The `worktree.updated` case appends to every cached list, including filtered ones; the lists refetch on focus, so a filtered list briefly showing an extra row is acceptable.

- [ ] **Step 6: Implement the confirm flow**

`apps/web/src/features/git/useConfirmedMutation.ts`
```ts
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { ApiRequestError } from '@/api/client';

export interface ConfirmRequest<V> {
  summary: string;
  details: Record<string, unknown>;
  vars: V;
}

export function useConfirmedMutation<V, R>(
  fn: (vars: V, confirm: boolean) => Promise<R>,
  opts: { onSuccess?: (r: R, vars: V) => void; invalidate?: ReadonlyArray<readonly unknown[]> } = {},
) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<ConfirmRequest<V> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | Error | null>(null);
  const [data, setData] = useState<R | null>(null);

  const exec = useCallback(
    async (vars: V, confirm: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const r = await fn(vars, confirm);
        setData(r);
        setPending(null);
        for (const key of opts.invalidate ?? []) await qc.invalidateQueries({ queryKey: [...key] });
        opts.onSuccess?.(r, vars);
      } catch (err) {
        if (!confirm && err instanceof ApiRequestError && err.status === 409 && err.code === 'confirmation_required') {
          const details = (err.details ?? {}) as Record<string, unknown>;
          setPending({ summary: String(details.summary ?? err.message), details, vars });
        } else {
          setPending(null);
          setError(err as Error);
        }
      } finally {
        setBusy(false);
      }
    },
    [fn, opts, qc],
  );

  return {
    pending,
    busy,
    error,
    data,
    run: (vars: V) => exec(vars, false),
    confirm: async (patch?: Partial<V>) => {
      if (!pending) return;
      const vars = patch ? ({ ...pending.vars, ...patch } as V) : pending.vars;
      await exec(vars, true);
    },
    cancel: () => setPending(null),
  };
}
```

`apps/web/src/features/git/GitConfirmDialog.tsx`
```tsx
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ConfirmRequest } from './useConfirmedMutation';

interface Props<V> {
  request: ConfirmRequest<V> | null;
  busy: boolean;
  title: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: (patch?: Partial<V>) => void;
  onCancel: () => void;
}

export function GitConfirmDialog<V>({ request, busy, title, confirmLabel, danger, onConfirm, onCancel }: Props<V>) {
  const [ack, setAck] = useState(false);
  useEffect(() => setAck(false), [request]);
  if (!request) return null;
  const external = request.details.external === true;
  const files = Array.isArray(request.details.files) ? (request.details.files as string[]) : [];
  const mainDirty = Array.isArray(request.details.mainDirty) ? (request.details.mainDirty as string[]) : [];
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{request.summary}</DialogDescription>
        </DialogHeader>
        {files.length > 0 && (
          <ul className="max-h-48 overflow-auto font-mono text-xs" aria-label="Files">
            {files.map((f) => (
              <li key={f} className={mainDirty.includes(f) ? 'text-red-600' : ''}>
                {f}
              </li>
            ))}
          </ul>
        )}
        {external && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            I understand this worktree was created outside the app
          </label>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'destructive' : 'default'}
            disabled={busy || (external && !ack)}
            onClick={() => onConfirm(external ? ({ confirmExternal: true } as unknown as Partial<V>) : undefined)}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 7: Implement the worktrees page**

`apps/web/src/features/worktrees/WorktreeRow.tsx`
```tsx
import type { WorktreeView } from '@orc/core';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export type WorktreeAction = 'vscode' | 'terminal' | 'run' | 'sync' | 'archive';

function prLabel(w: WorktreeView): string | null {
  const s = w.prStatus;
  if (!s) return w.prUrl ? 'PR' : null;
  if (s.state !== 'open') return `#${s.pr.number} · ${s.state}`;
  const checks = s.checks === 'failure' ? 'checks failing' : s.checks === 'pending' ? 'checks running' : s.checks === 'success' ? 'checks passing' : 'no checks';
  return `#${s.pr.number} · ${checks}`;
}

export function WorktreeRow({ w, onAction }: { w: WorktreeView; onAction: (a: WorktreeAction, w: WorktreeView) => void }) {
  const pr = prLabel(w);
  return (
    <tr className="border-b text-sm">
      <td className="py-2 font-mono">{w.branch}</td>
      <td>{w.ticket ?? '—'}</td>
      <td className="space-x-1">
        {w.isMain && <Badge variant="secondary">main checkout</Badge>}
        {!w.isMain && <Badge variant={w.createdByApp ? 'default' : 'outline'}>{w.createdByApp ? 'app' : 'external'}</Badge>}
        {w.dirty && <Badge variant="destructive">dirty</Badge>}
      </td>
      <td>
        {pr && w.prStatus ? (
          <a href={w.prStatus.pr.url} target="_blank" rel="noreferrer" className="underline">
            {pr}
          </a>
        ) : (
          (pr ?? '—')
        )}
      </td>
      <td>{w.sessionPks.length}</td>
      <td className="space-x-1 whitespace-nowrap text-right">
        <Button size="sm" variant="ghost" onClick={() => onAction('vscode', w)} aria-label={`Open ${w.branch} in VS Code`}>
          IDE
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onAction('terminal', w)} aria-label={`Open terminal in ${w.branch}`}>
          Terminal
        </Button>
        {!w.isMain && (
          <>
            <Button size="sm" variant="ghost" onClick={() => onAction('run', w)} aria-label={`Run ${w.branch}`}>
              Run
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onAction('sync', w)} aria-label={`Sync ${w.branch} to main checkout`}>
              Sync
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onAction('archive', w)} aria-label={`Archive ${w.branch}`}>
              Archive
            </Button>
          </>
        )}
      </td>
    </tr>
  );
}
```

`apps/web/src/features/worktrees/CreateWorktreeDialog.tsx`
```tsx
import { branchName } from '@orc/core/git';
import { useState } from 'react';
import { getApiClient } from '@/api/client';
import { worktreeKeys } from '@/api/queries/worktrees';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation';
import { useTerminalStore } from '@/stores/terminals';

type WtType = 'feat' | 'fix' | 'chore' | 'docs' | 'refactor';
interface Vars {
  repo: string;
  base: string;
  type: WtType;
  ticket: string | null;
  slug: string;
  runSetup: boolean;
  launch?: { source: 'claude' | 'codex'; prompt: string; planApproval: boolean };
}

export function CreateWorktreeDialog({ repos, open, onClose }: { repos: string[]; open: boolean; onClose: () => void }) {
  const [repo, setRepo] = useState(repos[0] ?? '');
  const [base, setBase] = useState('main');
  const [type, setType] = useState<WtType>('feat');
  const [ticket, setTicket] = useState('');
  const [slug, setSlug] = useState('');
  const [runSetup, setRunSetup] = useState(true);
  const [launch, setLaunch] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [planApproval, setPlanApproval] = useState(false);
  const openTerminal = useTerminalStore((s) => s.open);

  const m = useConfirmedMutation((vars: Vars, confirm: boolean) => getApiClient().worktreesCreate({ ...vars, confirm }), {
    invalidate: [worktreeKeys.all],
    onSuccess: (r) => {
      if (r.setupPtyId) openTerminal(r.setupPtyId, `setup ${r.worktree.branch}`);
      if (r.launch) openTerminal(r.launch.ptyId, r.worktree.branch);
      onClose();
    },
  });

  let preview = '';
  try {
    preview = slug ? branchName({ type, ticket: ticket || null, slug }) : '';
  } catch (err) {
    preview = (err as Error).message;
  }

  const submit = () =>
    m.run({
      repo,
      base,
      type,
      ticket: ticket.trim() || null,
      slug,
      runSetup,
      ...(launch ? { launch: { source: 'claude' as const, prompt, planApproval } } : {}),
    });

  return (
    <>
      <Dialog open={open && !m.pending} onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New worktree</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2 text-sm">
            <label>
              Repository
              <select className="block w-full" value={repo} onChange={(e) => setRepo(e.target.value)}>
                {repos.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Base branch
              <input className="block w-full" value={base} onChange={(e) => setBase(e.target.value)} />
            </label>
            <label>
              Type
              <select className="block w-full" value={type} onChange={(e) => setType(e.target.value as WtType)}>
                {(['feat', 'fix', 'chore', 'docs', 'refactor'] as const).map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            <label>
              Ticket
              <input className="block w-full" value={ticket} placeholder="SAF-1787" onChange={(e) => setTicket(e.target.value)} />
            </label>
            <label>
              Short description
              <input className="block w-full" value={slug} placeholder="exclude weekends sla" onChange={(e) => setSlug(e.target.value)} />
            </label>
            <p className="font-mono text-xs" aria-label="Branch preview">
              {preview}
            </p>
            <label className="flex gap-2">
              <input type="checkbox" checked={runSetup} onChange={(e) => setRunSetup(e.target.checked)} /> Run setup script
            </label>
            <label className="flex gap-2">
              <input type="checkbox" checked={launch} onChange={(e) => setLaunch(e.target.checked)} /> Launch Claude in the new worktree
            </label>
            {launch && (
              <>
                <textarea className="block w-full" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Prompt" />
                <label className="flex gap-2">
                  <input type="checkbox" checked={planApproval} onChange={(e) => setPlanApproval(e.target.checked)} /> Require plan approval first
                </label>
              </>
            )}
            {m.error && <p className="text-red-600">{m.error.message}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!repo || !slug || m.busy} onClick={submit}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <GitConfirmDialog request={m.pending} busy={m.busy} title="Create worktree?" confirmLabel="Create" onConfirm={(p) => m.confirm(p)} onCancel={m.cancel} />
    </>
  );
}
```

`apps/web/src/features/worktrees/WorktreesPage.tsx`
```tsx
import type { WorktreeView } from '@orc/core';
import { useMemo, useState } from 'react';
import { getApiClient } from '@/api/client';
import { useDiscoverWorktrees, useWorktrees, worktreeKeys } from '@/api/queries/worktrees';
import { Button } from '@/components/ui/button';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation';
import { useProjectStore } from '@/stores/project';
import { useTerminalStore } from '@/stores/terminals';
import { CreateWorktreeDialog } from './CreateWorktreeDialog';
import { type WorktreeAction, WorktreeRow } from './WorktreeRow';

type ArchiveVars = { path: string; confirmExternal: boolean };

export function WorktreesPage() {
  const projectId = useProjectStore((s) => s.projectId);
  const list = useWorktrees({ state: 'active', ...(projectId ? { projectId } : {}) });
  const discover = useDiscoverWorktrees();
  const openTerminal = useTerminalStore((s) => s.open);
  const [creating, setCreating] = useState(false);

  const archive = useConfirmedMutation(
    (v: ArchiveVars, confirm: boolean) => getApiClient().worktreesArchive({ path: v.path, confirm, confirmExternal: v.confirmExternal }),
    { invalidate: [worktreeKeys.all] },
  );
  const sync = useConfirmedMutation((v: { path: string }, confirm: boolean) => getApiClient().worktreesSync({ path: v.path, confirm }));
  const script = useConfirmedMutation(
    (v: { path: string; title: string }, confirm: boolean) => getApiClient().worktreesScript({ path: v.path, which: 'run', confirm }),
    { onSuccess: (r, v) => openTerminal(r.ptyId, v.title) },
  );

  const groups = useMemo(() => {
    const byRepo = new Map<string, WorktreeView[]>();
    for (const w of list.data ?? []) byRepo.set(w.repo, [...(byRepo.get(w.repo) ?? []), w]);
    return [...byRepo.entries()];
  }, [list.data]);

  const onAction = (a: WorktreeAction, w: WorktreeView) => {
    if (a === 'vscode') void getApiClient().worktreesOpen({ path: w.path, target: 'vscode' });
    if (a === 'terminal') void getApiClient().worktreesOpen({ path: w.path, target: 'terminal' });
    if (a === 'run') void script.run({ path: w.path, title: `run ${w.branch}` });
    if (a === 'sync') void sync.run({ path: w.path });
    if (a === 'archive') void archive.run({ path: w.path, confirmExternal: false });
  };

  const error = archive.error ?? sync.error ?? script.error;
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Worktrees</h1>
        <Button size="sm" variant="outline" disabled={discover.isPending} onClick={() => discover.mutate()}>
          {discover.isPending ? 'Scanning…' : 'Discover'}
        </Button>
        <Button size="sm" onClick={() => setCreating(true)}>
          New worktree
        </Button>
      </div>
      {error && <p className="text-sm text-red-600">{error.message}</p>}
      {list.isLoading && <p>Loading…</p>}
      {groups.map(([repo, rows]) => (
        <section key={repo}>
          <h2 className="font-mono text-sm font-semibold">{repo}</h2>
          <table className="w-full">
            <thead>
              <tr className="text-left text-xs text-gray-500">
                <th>Branch</th>
                <th>Ticket</th>
                <th>State</th>
                <th>PR</th>
                <th>Sessions</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <WorktreeRow key={w.path} w={w} onAction={onAction} />
              ))}
            </tbody>
          </table>
        </section>
      ))}
      <CreateWorktreeDialog
        open={creating}
        onClose={() => setCreating(false)}
        repos={(list.data ?? []).filter((w) => w.isMain).map((w) => w.path)}
      />
      <GitConfirmDialog
        request={archive.pending}
        busy={archive.busy}
        title="Archive worktree?"
        confirmLabel="Archive"
        danger
        onConfirm={(p) => archive.confirm(p)}
        onCancel={archive.cancel}
      />
      <GitConfirmDialog request={sync.pending} busy={sync.busy} title="Sync to main checkout?" confirmLabel="Copy files" onConfirm={() => sync.confirm()} onCancel={sync.cancel} />
      <GitConfirmDialog request={script.pending} busy={script.busy} title="Run script?" confirmLabel="Run" onConfirm={() => script.confirm()} onCancel={script.cancel} />
    </div>
  );
}
```
The "Terminal" action uses `worktreesOpen` with `target: 'terminal'` (Terminal.app). An embedded shell tab is a later nicety.

`apps/web/src/routes/worktrees.tsx`
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { WorktreesPage } from '@/features/worktrees/WorktreesPage';

export const Route = createFileRoute('/worktrees')({ component: WorktreesPage });
```

In `AppShell.tsx`, add `{ to: '/worktrees', label: 'Worktrees' }` to `NAV_ITEMS` after the Live entry.

- [ ] **Step 8: Run the tests**

Run: `pnpm vitest run apps/web/src/features/git apps/web/src/features/worktrees apps/web/src/api/live-events.phase4.test.ts`
Expected: PASS (2 + 2 + 1 tests). The external-archive test confirms that the Archive button stays disabled until the checkbox is ticked, and that the retry sends both flags.

- [ ] **Step 9: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add packages/core/package.json apps/web/src
git commit -m "feat(web): worktrees page with confirmed git actions and live updates"
```

---
### Task 20: Web — `/review/$source/$id` diff viewer with file tree, viewed marks and inline comments

**Files:**
- Modify: `apps/web/package.json` (add `@git-diff-view/react@^0.1.7`)
- Create: `apps/web/src/features/review/useReviewDraft.ts`, `apps/web/src/features/review/FileTree.tsx`, `apps/web/src/features/review/CommentComposer.tsx`, `apps/web/src/features/review/FileDiff.tsx`, `apps/web/src/features/review/CommentsPanel.tsx`, `apps/web/src/features/review/ReviewPage.tsx`, `apps/web/src/routes/review.$source.$id.tsx`
- Test: `apps/web/src/features/review/ReviewPage.test.tsx`, `apps/web/src/features/review/useReviewDraft.test.ts`

**Interfaces:**
- Consumes: `useReview`, `useDiff`, `useCheckpointDiff` (Task 19); `useConfirmedMutation`, `GitConfirmDialog` (Task 19); client `reviewComments`, `diffRevert` (Task 18) and P2's `sessionsLaunch(req: LaunchRequest)`; `useTerminalStore`
- Produces:
  ```ts
  export interface ReviewDraft { comments: ReviewComment[]; viewed: string[]; add(c: ReviewComment): void; remove(index: number): void; clear(): void; clearComments(): void; toggleViewed(path: string): void }
  export function useReviewDraft(key: string): ReviewDraft                       // persisted in localStorage under `orc.review.<key>`
  export function FileTree(p: { files: DiffFileEntry[]; selected: string | null; viewed: string[]; onSelect(path: string): void; onToggleViewed(path: string): void }): JSX.Element
  export function CommentComposer(p: { onSubmit(body: string): void; onCancel(): void }): JSX.Element
  export function FileDiff(p: { file: DiffFileEntry; mode: 'split' | 'unified'; comments: ReviewComment[]; canRevert: boolean; onAddComment(c: ReviewComment): void; onRevertFile(): void; onRevertHunk(index: number): void }): JSX.Element
  export function CommentsPanel(p: { source: Source; id: string; cwd: string; projectId: string | null; owned: boolean; draft: ReviewDraft }): JSX.Element
  export function ReviewPage(p: { source: Source; id: string; aside?: (ctx: { cwd: string; select(s: DiffSourceSel): void; selected: DiffSourceSel }) => ReactNode }): JSX.Element
  export type DiffSourceSel = { kind: 'worktree' } | { kind: 'checkpoint'; id: string }
  ```
  `ReviewPage` renders a right-hand column slot `aside` that Task 21 fills (`SummaryCard`, `CheckpointTimeline`, `ShipPanel`).

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @orc/web add @git-diff-view/react@^0.1.7`
Expected: `apps/web/package.json` lists `@git-diff-view/react`. Check the installed API with `grep -n "renderWidgetLine\|extendData\|onAddWidgetClick" apps/web/node_modules/@git-diff-view/react/index.d.ts | head` and record any prop rename in the review note.

- [ ] **Step 2: Write the failing tests**

`apps/web/src/features/review/useReviewDraft.test.ts`
```ts
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useReviewDraft } from './useReviewDraft';

beforeEach(() => localStorage.clear());

describe('useReviewDraft', () => {
  it('adds, removes and persists comments and viewed files', () => {
    const { result, unmount } = renderHook(() => useReviewDraft('claude:s1'));
    act(() => result.current.add({ file: 'a.ts', line: 3, side: 'new', body: 'x' }));
    act(() => result.current.add({ file: 'b.ts', line: 1, side: 'old', body: 'y' }));
    act(() => result.current.toggleViewed('a.ts'));
    act(() => result.current.remove(0));
    unmount();
    const again = renderHook(() => useReviewDraft('claude:s1')).result;
    expect(again.current.comments).toEqual([{ file: 'b.ts', line: 1, side: 'old', body: 'y' }]);
    expect(again.current.viewed).toEqual(['a.ts']);
    act(() => again.current.toggleViewed('a.ts'));
    act(() => again.current.clear());
    expect(again.current.comments).toEqual([]);
    expect(again.current.viewed).toEqual([]);
  });
});
```

`apps/web/src/features/review/ReviewPage.test.tsx`
```tsx
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { DiffResult, ReviewSummary } from '@orc/core';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, type ApiClient, setApiClientForTests } from '@/api/client';
import { renderWithProviders } from '@/test/render';
import { ReviewPage } from './ReviewPage';

vi.mock('@git-diff-view/react', () => ({
  DiffModeEnum: { Split: 1, Unified: 2 },
  SplitSide: { old: 1, new: 2 },
  DiffView: (p: {
    diffViewMode: number;
    renderWidgetLine: (a: { side: number; lineNumber: number; onClose: () => void }) => ReactNode;
    renderExtendLine: (a: { data: unknown }) => ReactNode;
    extendData: { newFile: Record<string, { data: unknown }> };
  }) => (
    <div data-testid="diffview" data-mode={p.diffViewMode}>
      {p.renderWidgetLine({ side: 2, lineNumber: 1, onClose: () => {} })}
      {Object.values(p.extendData.newFile).map((v, i) => (
        <div key={i}>{p.renderExtendLine({ data: v.data })}</div>
      ))}
    </div>
  ),
}));

const diff: DiffResult = {
  cwd: '/w', from: 'base', to: 'WORKTREE', additions: 2, deletions: 1,
  files: [
    { path: 'src/a.ts', oldPath: null, status: 'modified', additions: 1, deletions: 1, hunks: [
      { header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
    ], patch: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n' },
    { path: 'src/new.ts', oldPath: null, status: 'added', additions: 1, deletions: 0, hunks: [], patch: 'diff --git a/src/new.ts b/src/new.ts\n' },
  ],
};

const summary = (owned: boolean): ReviewSummary => ({
  sessionPk: 'claude:s1', cwd: '/w', worktree: null, files: [], additions: 2, deletions: 1, lastTest: null, recap: null, pr: null, owned, checkpoints: [],
});

let reviewComments: ReturnType<typeof vi.fn>;
let diffRevert: ReturnType<typeof vi.fn>;

function client(owned: boolean) {
  reviewComments = vi.fn(async (_s: string, _i: string, body: { deliver: string; confirm: boolean }) => {
    if (body.deliver === 'session' && !body.confirm) throw new ApiRequestError(409, 'confirmation_required', 'c', { summary: 'Send 1 review comment(s)' });
    return { sent: body.deliver === 'session', text: 'PROMPT TEXT' };
  });
  diffRevert = vi.fn(async (body: { confirm: boolean }) => {
    if (!body.confirm) throw new ApiRequestError(409, 'confirmation_required', 'c', { summary: 'Revert hunk 1 of src/a.ts' });
    return { reverted: 'src/a.ts#0' };
  });
  setApiClientForTests({
    reviewGet: async () => summary(owned),
    diffGet: async () => diff,
    checkpointsList: async () => [],
    reviewComments,
    diffRevert,
    sessionsLaunch: vi.fn(async () => ({ ptyId: 'pty-new', sessionId: null })),
  } as unknown as ApiClient);
}

beforeEach(() => localStorage.clear());

describe('ReviewPage', () => {
  it('shows the file tree with counts and toggles split/unified', async () => {
    client(true);
    renderWithProviders(<ReviewPage source="claude" id="s1" />);
    const tree = await screen.findByRole('navigation', { name: 'Changed files' });
    expect(within(tree).getByText('src/a.ts')).toBeDefined();
    expect(within(tree).getByText('+1 −1')).toBeDefined();
    fireEvent.click(within(tree).getByLabelText('Viewed src/a.ts'));
    expect((within(tree).getByLabelText('Viewed src/a.ts') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('diffview').dataset.mode).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Unified' }));
    expect(screen.getByTestId('diffview').dataset.mode).toBe('2');
  });

  it('collects an inline comment and sends it to the owned session after confirmation', async () => {
    client(true);
    renderWithProviders(<ReviewPage source="claude" id="s1" />);
    fireEvent.change(await screen.findByLabelText('Comment'), { target: { value: 'rename b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(await screen.findByText('src/a.ts:1')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
    expect(await screen.findByText('Send 1 review comment(s)')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(reviewComments).toHaveBeenLastCalledWith('claude', 's1', {
        comments: [{ file: 'src/a.ts', line: 1, side: 'new', body: 'rename b' }],
        deliver: 'session',
        confirm: true,
      }),
    );
    await waitFor(() => expect(screen.queryByText('src/a.ts:1')).toBeNull());
  });

  it('offers copy and new-session delivery for observed sessions', async () => {
    client(false);
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    renderWithProviders(<ReviewPage source="claude" id="s1" />);
    fireEvent.change(await screen.findByLabelText('Comment'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(screen.queryByRole('button', { name: 'Send to agent' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('PROMPT TEXT'));
  });

  it('reverts a hunk only after confirmation', async () => {
    client(true);
    renderWithProviders(<ReviewPage source="claude" id="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revert hunk 1' }));
    expect(await screen.findByText('Revert hunk 1 of src/a.ts')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(diffRevert).toHaveBeenLastCalledWith({ cwd: '/w', file: 'src/a.ts', hunkIndex: 0, confirm: true }));
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `pnpm vitest run apps/web/src/features/review`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement the draft store, tree and composer**

`apps/web/src/features/review/useReviewDraft.ts`
```ts
import type { ReviewComment } from '@orc/core';
import { useCallback, useEffect, useState } from 'react';

export interface ReviewDraft {
  comments: ReviewComment[];
  viewed: string[];
  add(c: ReviewComment): void;
  remove(index: number): void;
  clear(): void;
  clearComments(): void;
  toggleViewed(path: string): void;
}

interface Stored {
  comments: ReviewComment[];
  viewed: string[];
}

const storageKey = (key: string) => `orc.review.${key}`;

function load(key: string): Stored {
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return { comments: [], viewed: [] };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return { comments: parsed.comments ?? [], viewed: parsed.viewed ?? [] };
  } catch {
    return { comments: [], viewed: [] };
  }
}

export function useReviewDraft(key: string): ReviewDraft {
  const [state, setState] = useState<Stored>(() => load(key));
  useEffect(() => setState(load(key)), [key]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(key), JSON.stringify(state));
    } catch {
      // storage can be unavailable (private mode); the draft still works in memory
    }
  }, [key, state]);

  const add = useCallback((c: ReviewComment) => setState((s) => ({ ...s, comments: [...s.comments, c] })), []);
  const remove = useCallback((i: number) => setState((s) => ({ ...s, comments: s.comments.filter((_, j) => j !== i) })), []);
  const clear = useCallback(() => setState({ comments: [], viewed: [] }), []);
  const clearComments = useCallback(() => setState((s) => ({ ...s, comments: [] })), []);
  const toggleViewed = useCallback(
    (path: string) =>
      setState((s) => ({ ...s, viewed: s.viewed.includes(path) ? s.viewed.filter((p) => p !== path) : [...s.viewed, path] })),
    [],
  );
  return { comments: state.comments, viewed: state.viewed, add, remove, clear, clearComments, toggleViewed };
}
```
`clear()` resets comments and viewed marks; the send flow uses `clearComments()` so viewed marks survive a send.

`apps/web/src/features/review/FileTree.tsx`
```tsx
import type { DiffFileEntry } from '@orc/core';

const STATUS_MARK: Record<DiffFileEntry['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', binary: 'B' };

export function FileTree(p: {
  files: DiffFileEntry[];
  selected: string | null;
  viewed: string[];
  onSelect(path: string): void;
  onToggleViewed(path: string): void;
}) {
  return (
    <nav aria-label="Changed files" className="w-64 shrink-0 overflow-auto border-r text-sm">
      <p className="px-2 py-1 text-xs text-gray-500">
        {p.viewed.filter((v) => p.files.some((f) => f.path === v)).length}/{p.files.length} viewed
      </p>
      <ul>
        {p.files.map((f) => (
          <li key={f.path} className={`flex items-center gap-2 px-2 py-1 ${p.selected === f.path ? 'bg-gray-100 dark:bg-gray-800' : ''}`}>
            <input type="checkbox" aria-label={`Viewed ${f.path}`} checked={p.viewed.includes(f.path)} onChange={() => p.onToggleViewed(f.path)} />
            <span className="w-3 font-mono text-xs">{STATUS_MARK[f.status]}</span>
            <button type="button" className="flex-1 truncate text-left font-mono" onClick={() => p.onSelect(f.path)} title={f.path}>
              {f.path}
            </button>
            <span className="font-mono text-xs">{`+${f.additions} −${f.deletions}`}</span>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

`apps/web/src/features/review/CommentComposer.tsx`
```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function CommentComposer({ onSubmit, onCancel }: { onSubmit(body: string): void; onCancel(): void }) {
  const [body, setBody] = useState('');
  return (
    <div className="space-y-1 border-y bg-yellow-50 p-2 dark:bg-yellow-950">
      <textarea aria-label="Comment" className="w-full text-sm" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="flex gap-1">
        <Button size="sm" disabled={body.trim() === ''} onClick={() => onSubmit(body.trim())}>
          Add comment
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Implement the diff renderer**

`apps/web/src/features/review/FileDiff.tsx`
```tsx
import { DiffModeEnum, DiffView, SplitSide } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view-pure.css';
import type { DiffFileEntry, ReviewComment } from '@orc/core';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { CommentComposer } from './CommentComposer';

type LineNotes = Record<string, { data: ReviewComment[] }>;

export function FileDiff(p: {
  file: DiffFileEntry;
  mode: 'split' | 'unified';
  comments: ReviewComment[];
  canRevert: boolean;
  onAddComment(c: ReviewComment): void;
  onRevertFile(): void;
  onRevertHunk(index: number): void;
}) {
  const { file } = p;
  const extendData = useMemo(() => {
    const oldFile: LineNotes = {};
    const newFile: LineNotes = {};
    for (const c of p.comments) {
      const target = c.side === 'old' ? oldFile : newFile;
      const key = String(c.line);
      target[key] = { data: [...(target[key]?.data ?? []), c] };
    }
    return { oldFile, newFile };
  }, [p.comments]);

  return (
    <section aria-label={`Diff of ${file.path}`} className="space-y-2">
      <header className="flex items-center gap-2 text-sm">
        <span className="font-mono font-semibold">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
        {p.canRevert && (
          <Button size="sm" variant="ghost" onClick={p.onRevertFile}>
            Revert file
          </Button>
        )}
        {p.canRevert &&
          file.hunks.map((h, i) => (
            <Button key={h.header} size="sm" variant="ghost" title={h.header} onClick={() => p.onRevertHunk(i)}>
              {`Revert hunk ${i + 1}`}
            </Button>
          ))}
      </header>
      {file.status === 'binary' ? (
        <p className="text-sm text-gray-500">Binary file changed.</p>
      ) : (
        <DiffView<ReviewComment[]>
          data={{ oldFile: { fileName: file.oldPath ?? file.path }, newFile: { fileName: file.path }, hunks: [file.patch] }}
          diffViewMode={p.mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
          diffViewHighlight
          diffViewWrap
          diffViewAddWidget
          extendData={extendData}
          renderExtendLine={({ data }) => (
            <ul className="border-y bg-blue-50 p-2 text-sm dark:bg-blue-950">
              {data.map((c, i) => (
                <li key={`${c.line}-${i}`}>{c.body}</li>
              ))}
            </ul>
          )}
          renderWidgetLine={({ side, lineNumber, onClose }) => (
            <CommentComposer
              onCancel={onClose}
              onSubmit={(body) => {
                p.onAddComment({ file: file.path, line: lineNumber, side: side === SplitSide.old ? 'old' : 'new', body });
                onClose();
              }}
            />
          )}
        />
      )}
    </section>
  );
}
```
If the installed version does not accept the generic `DiffView<T>` form, drop `<ReviewComment[]>` and cast `data` inside `renderExtendLine` with `(data as ReviewComment[])`.

- [ ] **Step 6: Implement the comments panel and the page**

`apps/web/src/features/review/CommentsPanel.tsx`
```tsx
import type { ReviewComment, Source } from '@orc/core';
import { getApiClient } from '@/api/client';
import { Button } from '@/components/ui/button';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation';
import { useTerminalStore } from '@/stores/terminals';
import type { ReviewDraft } from './useReviewDraft';

export function CommentsPanel(p: { source: Source; id: string; cwd: string; projectId: string | null; owned: boolean; draft: ReviewDraft }) {
  const openTerminal = useTerminalStore((s) => s.open);
  const send = useConfirmedMutation(
    (comments: ReviewComment[], confirm: boolean) => getApiClient().reviewComments(p.source, p.id, { comments, deliver: 'session', confirm }),
    { onSuccess: (r) => r.sent && p.draft.clearComments() },
  );
  const asText = () => getApiClient().reviewComments(p.source, p.id, { comments: p.draft.comments, deliver: 'text', confirm: false });

  const copy = async () => {
    const { text } = await asText();
    await navigator.clipboard.writeText(text);
  };
  const newSession = async () => {
    const { text } = await asText();
    const r = await getApiClient().sessionsLaunch({ source: 'claude', projectId: p.projectId, cwd: p.cwd, prompt: text, vars: {}, planApproval: false });
    openTerminal(r.ptyId, 'review follow-up');
    p.draft.clearComments();
  };

  return (
    <section aria-label="Review comments" className="space-y-2 text-sm">
      <h3 className="font-semibold">Comments ({p.draft.comments.length})</h3>
      <ul className="space-y-1">
        {p.draft.comments.map((c, i) => (
          <li key={`${c.file}:${c.line}:${i}`} className="rounded border p-1">
            <div className="flex justify-between font-mono text-xs">
              <span>{`${c.file}:${c.line}`}</span>
              <button type="button" aria-label={`Remove comment ${i + 1}`} onClick={() => p.draft.remove(i)}>
                ×
              </button>
            </div>
            <p>{c.body}</p>
          </li>
        ))}
      </ul>
      {p.draft.comments.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {p.owned && (
            <Button size="sm" disabled={send.busy} onClick={() => send.run(p.draft.comments)}>
              Send to agent
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            Copy prompt
          </Button>
          <Button size="sm" variant="outline" onClick={() => void newSession()}>
            New session with feedback
          </Button>
        </div>
      )}
      {send.error && <p className="text-red-600">{send.error.message}</p>}
      <GitConfirmDialog request={send.pending} busy={send.busy} title="Send review to the agent?" confirmLabel="Send" onConfirm={() => send.confirm()} onCancel={send.cancel} />
    </section>
  );
}
```

`apps/web/src/features/review/ReviewPage.tsx`
```tsx
import type { Source } from '@orc/core';
import { type ReactNode, useEffect, useState } from 'react';
import { getApiClient } from '@/api/client';
import { useCheckpointDiff, useDiff, useReview } from '@/api/queries/review';
import { Button } from '@/components/ui/button';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation';
import { CommentsPanel } from './CommentsPanel';
import { FileDiff } from './FileDiff';
import { FileTree } from './FileTree';
import { useReviewDraft } from './useReviewDraft';

export type DiffSourceSel = { kind: 'worktree' } | { kind: 'checkpoint'; id: string };

type RevertVars = { cwd: string; file: string; hunkIndex?: number };

export function ReviewPage({ source, id, aside }: { source: Source; id: string; aside?: (ctx: { cwd: string; select: (s: DiffSourceSel) => void; selected: DiffSourceSel }) => ReactNode }) {
  const review = useReview(source, id);
  const [sel, setSel] = useState<DiffSourceSel>({ kind: 'worktree' });
  const cwd = review.data?.cwd ?? null;
  const live = useDiff(sel.kind === 'worktree' ? cwd : null);
  const turn = useCheckpointDiff(sel.kind === 'checkpoint' ? sel.id : null);
  const diff = sel.kind === 'worktree' ? live : turn;
  const draft = useReviewDraft(`${source}:${id}`);
  const [mode, setMode] = useState<'split' | 'unified'>('split');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const files = diff.data?.files ?? [];
    if (files.length && !files.some((f) => f.path === selected)) setSelected(files[0]?.path ?? null);
  }, [diff.data, selected]);

  const revert = useConfirmedMutation((v: RevertVars, confirm: boolean) => getApiClient().diffRevert({ ...v, confirm }), {
    invalidate: [['diff'], ['review']],
  });

  if (review.isLoading) return <p className="p-4">Loading…</p>;
  if (review.error || !review.data) return <p className="p-4 text-red-600">{review.error?.message ?? 'Not found'}</p>;
  const summary = review.data;
  const file = diff.data?.files.find((f) => f.path === selected) ?? null;

  return (
    <div className="flex h-full">
      <FileTree
        files={diff.data?.files ?? []}
        selected={selected}
        viewed={draft.viewed}
        onSelect={setSelected}
        onToggleViewed={draft.toggleViewed}
      />
      <main className="min-w-0 flex-1 space-y-2 overflow-auto p-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono">{sel.kind === 'worktree' ? 'base … working tree' : 'single turn'}</span>
          {sel.kind === 'checkpoint' && (
            <Button size="sm" variant="ghost" onClick={() => setSel({ kind: 'worktree' })}>
              Back to full diff
            </Button>
          )}
          <span className="ml-auto" />
          <Button size="sm" variant={mode === 'split' ? 'default' : 'ghost'} onClick={() => setMode('split')}>
            Split
          </Button>
          <Button size="sm" variant={mode === 'unified' ? 'default' : 'ghost'} onClick={() => setMode('unified')}>
            Unified
          </Button>
        </div>
        {diff.isLoading && <p>Loading diff…</p>}
        {diff.data && diff.data.files.length === 0 && <p className="text-sm text-gray-500">No changes.</p>}
        {file && (
          <FileDiff
            key={`${sel.kind}:${file.path}`}
            file={file}
            mode={mode}
            comments={draft.comments.filter((c) => c.file === file.path)}
            canRevert={sel.kind === 'worktree'}
            onAddComment={draft.add}
            onRevertFile={() => void revert.run({ cwd: summary.cwd, file: file.path })}
            onRevertHunk={(i) => void revert.run({ cwd: summary.cwd, file: file.path, hunkIndex: i })}
          />
        )}
        {revert.error && <p className="text-sm text-red-600">{revert.error.message}</p>}
      </main>
      <aside className="w-80 shrink-0 space-y-4 overflow-auto border-l p-2">
        {aside?.({ cwd: summary.cwd, select: setSel, selected: sel })}
        <CommentsPanel
          source={source}
          id={id}
          cwd={summary.cwd}
          projectId={summary.worktree?.projectId ?? null}
          owned={summary.owned}
          draft={draft}
        />
      </aside>
      <GitConfirmDialog request={revert.pending} busy={revert.busy} title="Revert changes?" confirmLabel="Revert" danger onConfirm={() => revert.confirm()} onCancel={revert.cancel} />
    </div>
  );
}
```

`apps/web/src/routes/review.$source.$id.tsx`
```tsx
import type { Source } from '@orc/core';
import { createFileRoute } from '@tanstack/react-router';
import { ReviewPage } from '@/features/review/ReviewPage';

export const Route = createFileRoute('/review/$source/$id')({
  component: function ReviewRoute() {
    const { source, id } = Route.useParams();
    return <ReviewPage source={source as Source} id={id} />;
  },
});
```
Task 21 replaces this component body to pass the `aside` slot.

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run apps/web/src/features/review`
Expected: PASS (1 + 4 tests). In the tests the mocked `DiffView` always renders one composer for line 1 on the new side, so "Comment" and "Add comment" are present.

- [ ] **Step 8: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): review page with diff viewer, viewed marks and inline comments"
```

---
### Task 21: Web — summary card, checkpoint timeline, ship panel, PR chips, presets, launch fields, inbox actions

**Files:**
- Create: `apps/web/src/features/review/SummaryCard.tsx`, `apps/web/src/features/review/CheckpointTimeline.tsx`, `apps/web/src/features/review/ShipPanel.tsx`, `apps/web/src/features/review/PresetButtons.tsx`, `apps/web/src/features/review/ReviewAside.tsx`
- Create: `apps/web/src/features/launch/LaunchPhase4Fields.tsx`, `apps/web/src/features/inbox/PlanApprovalActions.tsx`, `apps/web/src/features/inbox/PrEventActions.tsx`
- Modify: `apps/web/src/features/live-board/PrChip.tsx` (replace body), `apps/web/src/features/launch/LaunchDialog.tsx`, `apps/web/src/features/inbox/InboxItemActions.tsx`, `apps/web/src/routes/review.$source.$id.tsx`
- Test: `apps/web/src/features/review/aside.test.tsx`, `apps/web/src/features/inbox/phase4-actions.test.tsx`, `apps/web/src/features/live-board/PrChip.test.tsx`

**Interfaces:**
- Consumes: Tasks 18–20; P2 `sessionsLaunch`, `useWorktrees`
- Produces:
  ```ts
  export function SummaryCard(p: { summary: ReviewSummary }): JSX.Element
  export function CheckpointTimeline(p: { sessionPk: string; selected: DiffSourceSel; onSelect(s: DiffSourceSel): void }): JSX.Element
  export function ShipPanel(p: { summary: ReviewSummary }): JSX.Element
  export async function launchPreset(presetId: string, i: { cwd: string; projectId: string | null; vars: Record<string, string> }): Promise<{ ptyId: string }>
  export function PresetButtons(p: { summary: ReviewSummary }): JSX.Element | null
  export function ReviewAside(p: { source: Source; id: string; select(s: DiffSourceSel): void; selected: DiffSourceSel }): JSX.Element | null
  export function LaunchPhase4Fields(p: { draft: LaunchDraft; onChange(d: LaunchDraft): void; repos: string[] }): JSX.Element
  export type LaunchDraft = z.input<typeof LaunchRequest>
  export function PlanApprovalActions(p: { item: InboxItem }): JSX.Element
  export function PrEventActions(p: { item: InboxItem }): JSX.Element
  export function PrChip(p: { pr: PrRef }): JSX.Element
  export function splitPk(pk: string): { source: Source; id: string }
  ```

- [ ] **Step 1: Write the failing tests**

`apps/web/src/features/review/aside.test.tsx`
```tsx
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { CheckpointRecord, ReviewSummary } from '@orc/core';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, type ApiClient, setApiClientForTests } from '@/api/client';
import { renderWithProviders } from '@/test/render';
import { CheckpointTimeline } from './CheckpointTimeline';
import { PresetButtons } from './PresetButtons';
import { ShipPanel } from './ShipPanel';
import { SummaryCard } from './SummaryCard';

const summary = (p: Partial<ReviewSummary> = {}): ReviewSummary => ({
  sessionPk: 'claude:s1', cwd: '/w',
  worktree: { path: '/w', repo: '/r', branch: 'feat/SAF-1-x', base: 'main', ticket: 'SAF-1', dirty: true, prUrl: null, state: 'active', createdByApp: true, head: 'h', isMain: false, origin: 'app', sessionPks: ['claude:s1'], projectId: 'wakecap', prStatus: null, updatedAt: 'x' },
  files: [{ path: 'src/a.ts', additions: 3, deletions: 1 }], additions: 3, deletions: 1,
  lastTest: { ts: 'x', command: 'pnpm test', passed: 10, failed: 2, skipped: 0, durationMs: 100 },
  recap: null, pr: null, owned: true, checkpoints: [], ...p,
});

const needConfirm = (summaryText: string) => new ApiRequestError(409, 'confirmation_required', 'c', { summary: summaryText });

describe('SummaryCard', () => {
  it('shows files, tests, a missing recap and no PR', () => {
    renderWithProviders(<SummaryCard summary={summary()} />);
    expect(screen.getByText('1 file · +3 −1')).toBeDefined();
    expect(screen.getByText('Tests: 10 passed, 2 failed')).toBeDefined();
    expect(screen.getByText('No recap yet')).toBeDefined();
    expect(screen.getByText('No PR yet')).toBeDefined();
  });
});

describe('CheckpointTimeline', () => {
  it('selects a turn and rewinds after confirmation', async () => {
    const cps: CheckpointRecord[] = [
      { id: 'c1', sessionId: 's1', worktreePath: '/w', turn: 1, ref: 'r1', commit: 'a', createdAt: '2026-09-17T10:00:00Z', kind: 'turn' },
      { id: 'c2', sessionId: 's1', worktreePath: '/w', turn: 2, ref: 'r2', commit: 'b', createdAt: '2026-09-17T10:05:00Z', kind: 'turn' },
    ];
    const rewind = vi.fn(async (_id: string, b: { confirm: boolean }) => {
      if (!b.confirm) throw needConfirm('Restore the files in /w to turn 1.');
      return { safety: { ...cps[1], id: 'c3', kind: 'safety' } };
    });
    setApiClientForTests({ checkpointsList: async () => cps, checkpointsRewind: rewind } as unknown as ApiClient);
    const onSelect = vi.fn();
    renderWithProviders(<CheckpointTimeline sessionPk="claude:s1" selected={{ kind: 'worktree' }} onSelect={onSelect} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn 2' }));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'checkpoint', id: 'c2' });
    fireEvent.click(screen.getByRole('button', { name: 'Rewind to turn 1' }));
    expect(await screen.findByText('Restore the files in /w to turn 1.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Rewind' }));
    await waitFor(() => expect(rewind).toHaveBeenLastCalledWith('c1', { confirm: true }));
  });
});

describe('ShipPanel', () => {
  it('prefills from the suggestion and commits, pushes and opens a PR with confirmation', async () => {
    const calls: string[] = [];
    const confirmable = <T,>(name: string, result: T) =>
      vi.fn(async (b: { confirm: boolean }) => {
        if (!b.confirm) throw needConfirm(`${name}?`);
        calls.push(name);
        return result;
      });
    const shipPr = confirmable('pr', { repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7' });
    setApiClientForTests({
      shipSuggest: async () => ({ message: 'feat: SAF-1 x', title: 'SAF-1 x', body: '## Summary', base: 'main', branch: 'feat/SAF-1-x', ticket: 'SAF-1' }),
      shipCommit: confirmable('commit', { sha: 'abc' }),
      shipPush: confirmable('push', { ok: true }),
      shipPr,
      githubPr: async () => ({ pr: { repo: 'o/r', number: 7, url: 'u' }, state: 'open', title: 't', checks: 'pending', review: 'review_required', updatedAt: 'x', headRef: 'feat/SAF-1-x', failedChecks: [] }),
    } as unknown as ApiClient);
    renderWithProviders(<ShipPanel summary={summary()} />);
    expect(((await screen.findByLabelText('Commit message')) as HTMLTextAreaElement).value).toBe('feat: SAF-1 x');
    for (const [button, confirmLabel] of [['Commit', 'Commit'], ['Push', 'Push'], ['Create PR', 'Create PR']] as const) {
      fireEvent.click(screen.getByRole('button', { name: button }));
      await screen.findByRole('dialog');
      fireEvent.click(screen.getAllByRole('button', { name: confirmLabel }).at(-1) as HTMLElement);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    expect(calls).toEqual(['commit', 'push', 'pr']);
    expect(shipPr).toHaveBeenLastCalledWith({ cwd: '/w', title: 'SAF-1 x', body: '## Summary', base: 'main', draft: false, confirm: true });
    expect(await screen.findByText('#7 · open · checks pending')).toBeDefined();
  });
});

describe('PresetButtons', () => {
  it('launches Fix CI with the failing check in the worktree', async () => {
    const launch = vi.fn(async () => ({ ptyId: 'pty-9', sessionId: null }));
    setApiClientForTests({ sessionsLaunch: launch } as unknown as ApiClient);
    const pr = { pr: { repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7' }, state: 'open' as const, title: 't', checks: 'failure' as const, review: 'none' as const, updatedAt: 'x', headRef: 'h', failedChecks: ['unit'] };
    renderWithProviders(<PresetButtons summary={summary({ pr })} />);
    expect(screen.queryByRole('button', { name: 'Address comments' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Fix CI' }));
    await waitFor(() =>
      expect(launch).toHaveBeenCalledWith({
        source: 'claude', projectId: 'wakecap', cwd: '/w', prompt: '', templateId: 'preset-fix-ci',
        vars: { prUrl: 'https://github.com/o/r/pull/7', check: 'unit', ticket: 'SAF-1' }, planApproval: false,
      }),
    );
  });
});
```

`apps/web/src/features/inbox/phase4-actions.test.tsx`
```tsx
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { InboxItem } from '@orc/core';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, type ApiClient, setApiClientForTests } from '@/api/client';
import { renderWithProviders } from '@/test/render';
import { PlanApprovalActions } from './PlanApprovalActions';
import { PrEventActions } from './PrEventActions';

const item = (p: Partial<InboxItem>): InboxItem => ({
  id: 'i1', kind: 'plan_approval', sessionId: 'claude:s1', projectId: 'wakecap', ticket: 'SAF-1', reason: 'Plan awaiting approval',
  dedupeKey: 'plan:claude:s1', createdAt: 'x', updatedAt: 'x', state: 'open', snoozeUntil: null, payload: {}, ...p,
});

describe('PlanApprovalActions', () => {
  it('shows the plan and approves or rejects with confirmation', async () => {
    const approve = vi.fn(async (_s: string, _i: string, b: { confirm: boolean }) => {
      if (!b.confirm) throw new ApiRequestError(409, 'confirmation_required', 'c', { summary: 'Approve the plan' });
      return { ok: true };
    });
    const reject = vi.fn(async (_s: string, _i: string, b: { confirm: boolean }) => {
      if (!b.confirm) throw new ApiRequestError(409, 'confirmation_required', 'c', { summary: 'Reject the plan' });
      return { ok: true };
    });
    setApiClientForTests({ planApprove: approve, planReject: reject } as unknown as ApiClient);
    renderWithProviders(<PlanApprovalActions item={item({ payload: { plan: '1. Do X', owned: true } })} />);
    expect(screen.getByText('1. Do X')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approve).toHaveBeenLastCalledWith('claude', 's1', { confirm: true }));
    expect((screen.getByRole('button', { name: 'Reject plan' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Feedback'), { target: { value: 'smaller steps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject plan' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(reject).toHaveBeenLastCalledWith('claude', 's1', { feedback: 'smaller steps', confirm: true }));
  });

  it('explains when the session is not owned', () => {
    setApiClientForTests({} as unknown as ApiClient);
    renderWithProviders(<PlanApprovalActions item={item({ payload: { plan: 'p', owned: false } })} />);
    expect(screen.getByText('Resume this session in the app to answer the plan.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve plan' })).toBeNull();
  });
});

describe('PrEventActions', () => {
  it('links the PR and the review and offers the preset', async () => {
    const launch = vi.fn(async () => ({ ptyId: 'p', sessionId: null }));
    setApiClientForTests({ sessionsLaunch: launch } as unknown as ApiClient);
    renderWithProviders(
      <PrEventActions
        item={item({
          kind: 'pr_event', dedupeKey: 'pr:o/r#4:checks',
          payload: { pr: { repo: 'o/r', number: 4, url: 'https://github.com/o/r/pull/4' }, cwd: '/w', event: 'checks_failed', presetId: 'preset-fix-ci', vars: { prUrl: 'https://github.com/o/r/pull/4', check: 'unit' } },
        })}
      />,
    );
    expect(screen.getByRole('link', { name: 'Open PR #4' }).getAttribute('href')).toBe('https://github.com/o/r/pull/4');
    expect(screen.getByRole('link', { name: 'Review' }).getAttribute('href')).toBe('/review/claude/s1');
    fireEvent.click(screen.getByRole('button', { name: 'Fix CI' }));
    await waitFor(() => expect(launch).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/w', templateId: 'preset-fix-ci' })));
  });
});
```

`apps/web/src/features/live-board/PrChip.test.tsx`
```tsx
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type ApiClient, setApiClientForTests } from '@/api/client';
import { renderWithProviders } from '@/test/render';
import { PrChip } from './PrChip';

describe('PrChip', () => {
  it('shows live PR state and checks', async () => {
    setApiClientForTests({
      githubPr: async () => ({ pr: { repo: 'o/r', number: 12, url: 'https://github.com/o/r/pull/12' }, state: 'open', title: 't', checks: 'failure', review: 'approved', updatedAt: 'x', headRef: null, failedChecks: ['unit'] }),
    } as unknown as ApiClient);
    renderWithProviders(<PrChip pr={{ repo: 'o/r', number: 12, url: 'https://github.com/o/r/pull/12' }} />);
    const chip = await screen.findByRole('link', { name: 'PR #12: open, checks failure, review approved' });
    expect(chip.textContent).toBe('#12 ✗');
    expect(chip.getAttribute('href')).toBe('https://github.com/o/r/pull/12');
  });

  it('falls back to the plain number while loading', () => {
    setApiClientForTests({ githubPr: () => new Promise(() => {}) } as unknown as ApiClient);
    renderWithProviders(<PrChip pr={{ repo: 'o/r', number: 13, url: 'u' }} />);
    expect(screen.getByRole('link').textContent).toBe('#13');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run apps/web/src/features/review/aside.test.tsx apps/web/src/features/inbox/phase4-actions.test.tsx apps/web/src/features/live-board/PrChip.test.tsx`
Expected: FAIL, modules not found (PrChip test fails on the old P2 markup).

- [ ] **Step 3: Implement the summary card, presets and timeline**

`apps/web/src/features/review/SummaryCard.tsx`
```tsx
import type { ReviewSummary } from '@orc/core';
import { Badge } from '@/components/ui/badge';

export function SummaryCard({ summary: s }: { summary: ReviewSummary }) {
  const t = s.lastTest;
  return (
    <section aria-label="Review summary" className="space-y-1 rounded border p-2 text-sm">
      <div className="flex flex-wrap items-center gap-1">
        {s.worktree && <span className="font-mono text-xs">{s.worktree.branch}</span>}
        {s.worktree?.ticket && <Badge variant="secondary">{s.worktree.ticket}</Badge>}
        <Badge variant={s.owned ? 'default' : 'outline'}>{s.owned ? 'owned' : 'observed'}</Badge>
      </div>
      <p>{`${s.files.length} ${s.files.length === 1 ? 'file' : 'files'} · +${s.additions} −${s.deletions}`}</p>
      <p className={t && t.failed > 0 ? 'text-red-600' : ''}>{t ? `Tests: ${t.passed} passed, ${t.failed} failed` : 'Tests: not run'}</p>
      <p className="whitespace-pre-wrap text-gray-700 dark:text-gray-300">{s.recap ?? 'No recap yet'}</p>
      <p>
        {s.pr
          ? `PR #${s.pr.pr.number} · ${s.pr.state} · checks ${s.pr.checks} · review ${s.pr.review.replace('_', ' ')}`
          : 'No PR yet'}
      </p>
    </section>
  );
}
```

`apps/web/src/features/review/PresetButtons.tsx`
```tsx
import type { ReviewSummary } from '@orc/core';
import { getApiClient } from '@/api/client';
import { Button } from '@/components/ui/button';
import { useTerminalStore } from '@/stores/terminals';

export async function launchPreset(presetId: string, i: { cwd: string; projectId: string | null; vars: Record<string, string> }) {
  const r = await getApiClient().sessionsLaunch({
    source: 'claude',
    projectId: i.projectId,
    cwd: i.cwd,
    prompt: '',
    templateId: presetId,
    vars: i.vars,
    planApproval: false,
  });
  useTerminalStore.getState().open(r.ptyId, presetId.replace('preset-', ''));
  return { ptyId: r.ptyId };
}

export function PresetButtons({ summary: s }: { summary: ReviewSummary }) {
  const pr = s.pr;
  if (!pr || pr.state !== 'open') return null;
  const base = { prUrl: pr.pr.url, ...(s.worktree?.ticket ? { ticket: s.worktree.ticket } : {}) };
  const projectId = s.worktree?.projectId ?? null;
  return (
    <div className="flex gap-1">
      {pr.checks === 'failure' && (
        <Button size="sm" variant="outline" onClick={() => void launchPreset('preset-fix-ci', { cwd: s.cwd, projectId, vars: { prUrl: base.prUrl, check: pr.failedChecks[0] ?? '', ...(base.ticket ? { ticket: base.ticket } : {}) } })}>
          Fix CI
        </Button>
      )}
      {pr.review === 'changes_requested' && (
        <Button size="sm" variant="outline" onClick={() => void launchPreset('preset-address-comments', { cwd: s.cwd, projectId, vars: base })}>
          Address comments
        </Button>
      )}
    </div>
  );
}
```

`apps/web/src/features/review/CheckpointTimeline.tsx`
```tsx
import { getApiClient } from '@/api/client';
import { useCheckpoints } from '@/api/queries/review';
import { Button } from '@/components/ui/button';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation';
import type { DiffSourceSel } from './ReviewPage';

export function CheckpointTimeline({ sessionPk, selected, onSelect }: { sessionPk: string; selected: DiffSourceSel; onSelect(s: DiffSourceSel): void }) {
  const list = useCheckpoints(sessionPk);
  const invalidate = [['checkpoints'], ['diff'], ['review']] as const;
  const rewind = useConfirmedMutation((id: string, confirm: boolean) => getApiClient().checkpointsRewind(id, { confirm }), { invalidate });
  const save = useConfirmedMutation((pk: string, confirm: boolean) => getApiClient().checkpointsCreate({ sessionPk: pk, confirm }), { invalidate });
  const turns = (list.data ?? []).filter((c) => c.kind !== 'safety');
  return (
    <section aria-label="Checkpoints" className="space-y-1 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Checkpoints</h3>
        <Button size="sm" variant="ghost" onClick={() => void save.run(sessionPk)}>
          Save now
        </Button>
      </div>
      {turns.length === 0 && <p className="text-gray-500">No checkpoints yet.</p>}
      <ol className="space-y-1">
        {turns.map((c) => (
          <li key={c.id} className="flex items-center gap-1">
            <button
              type="button"
              className={`flex-1 text-left ${selected.kind === 'checkpoint' && selected.id === c.id ? 'font-semibold' : ''}`}
              onClick={() => onSelect({ kind: 'checkpoint', id: c.id })}
            >
              {c.kind === 'manual' ? `Manual (turn ${c.turn})` : `Turn ${c.turn}`}
            </button>
            <time className="text-xs text-gray-500" dateTime={c.createdAt}>
              {new Date(c.createdAt).toLocaleTimeString()}
            </time>
            <Button size="sm" variant="ghost" aria-label={`Rewind to turn ${c.turn}`} onClick={() => void rewind.run(c.id)}>
              ↺
            </Button>
          </li>
        ))}
      </ol>
      {(rewind.error ?? save.error) && <p className="text-red-600">{(rewind.error ?? save.error)?.message}</p>}
      <GitConfirmDialog request={rewind.pending} busy={rewind.busy} title="Rewind files?" confirmLabel="Rewind" danger onConfirm={() => rewind.confirm()} onCancel={rewind.cancel} />
      <GitConfirmDialog request={save.pending} busy={save.busy} title="Save checkpoint?" confirmLabel="Save" onConfirm={() => save.confirm()} onCancel={save.cancel} />
    </section>
  );
}
```
The manual row's accessible name is "Manual (turn N)", so the test's `Turn 2` button is unique.

- [ ] **Step 4: Implement the ship panel and the aside**

`apps/web/src/features/review/ShipPanel.tsx`
```tsx
import type { PrRef, ReviewSummary } from '@orc/core';
import { useEffect, useState } from 'react';
import { getApiClient } from '@/api/client';
import { usePrStatus } from '@/api/queries/github';
import { useShipSuggest } from '@/api/queries/ship';
import { Button } from '@/components/ui/button';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation';
import { useTerminalStore } from '@/stores/terminals';

type Method = 'merge' | 'squash' | 'rebase';

export function ShipPanel({ summary: s }: { summary: ReviewSummary }) {
  const suggest = useShipSuggest(s.cwd, s.sessionPk);
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const [draft, setDraft] = useState(false);
  const [method, setMethod] = useState<Method>('squash');
  const [created, setCreated] = useState<PrRef | null>(null);
  const openTerminal = useTerminalStore((st) => st.open);

  useEffect(() => {
    if (!suggest.data) return;
    setMessage(suggest.data.message);
    setTitle(suggest.data.title);
    setBody(suggest.data.body);
    setBase(suggest.data.base);
  }, [suggest.data]);

  const prRef = created ?? s.pr?.pr ?? null;
  const pr = usePrStatus(prRef);
  const invalidate = [['review'], ['diff'], ['worktrees']] as const;
  const commit = useConfirmedMutation((m: string, confirm: boolean) => getApiClient().shipCommit({ cwd: s.cwd, message: m, confirm }), { invalidate });
  const push = useConfirmedMutation((_: null, confirm: boolean) => getApiClient().shipPush({ cwd: s.cwd, confirm }), { invalidate });
  const open = useConfirmedMutation(
    (v: { title: string; body: string; base: string; draft: boolean }, confirm: boolean) => getApiClient().shipPr({ cwd: s.cwd, ...v, confirm }),
    { invalidate, onSuccess: (r) => setCreated(r) },
  );
  const merge = useConfirmedMutation((v: { pr: PrRef; method: Method }, confirm: boolean) => getApiClient().shipMerge({ ...v, confirm }), { invalidate });
  const backmerge = useConfirmedMutation(
    (_: null, confirm: boolean) =>
      getApiClient().shipBackmerge({ cwd: s.cwd, projectId: s.worktree?.projectId ?? '', ticket: s.worktree?.ticket ?? null, confirm }),
    { onSuccess: (r) => openTerminal(r.ptyId, 'backmerge') },
  );

  const status = pr.data;
  const error = commit.error ?? push.error ?? open.error ?? merge.error ?? backmerge.error;
  const all = [
    { m: commit, title: 'Commit changes?', label: 'Commit' },
    { m: push, title: 'Push branch?', label: 'Push' },
    { m: open, title: 'Open pull request?', label: 'Create PR' },
    { m: merge, title: 'Merge pull request?', label: 'Merge' },
    { m: backmerge, title: 'Start backmerge?', label: 'Start' },
  ] as const;

  return (
    <section aria-label="Ship" className="space-y-2 text-sm">
      <h3 className="font-semibold">Ship</h3>
      <label className="block">
        <span className="sr-only">Commit message</span>
        <textarea aria-label="Commit message" className="w-full font-mono text-xs" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>
      <div className="flex gap-1">
        <Button size="sm" disabled={!message || commit.busy} onClick={() => void commit.run(message)}>
          Commit
        </Button>
        <Button size="sm" variant="outline" disabled={push.busy} onClick={() => void push.run(null)}>
          Push
        </Button>
      </div>
      {!prRef && (
        <div className="space-y-1">
          <input aria-label="PR title" className="w-full" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea aria-label="PR body" className="w-full font-mono text-xs" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="flex items-center gap-2">
            <input aria-label="Base branch" className="w-24" value={base} onChange={(e) => setBase(e.target.value)} />
            <label className="flex gap-1">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft
            </label>
            <Button size="sm" disabled={!title || !base || open.busy} onClick={() => void open.run({ title, body, base, draft })}>
              Create PR
            </Button>
          </div>
        </div>
      )}
      {prRef && (
        <div className="space-y-1">
          <a href={prRef.url} target="_blank" rel="noreferrer" className="underline">
            {status ? `#${prRef.number} · ${status.state} · checks ${status.checks}` : `#${prRef.number}`}
          </a>
          {status?.failedChecks.length ? <p className="text-red-600">Failing: {status.failedChecks.join(', ')}</p> : null}
          {status?.state === 'open' && (
            <div className="flex items-center gap-1">
              <select aria-label="Merge method" value={method} onChange={(e) => setMethod(e.target.value as Method)}>
                <option value="squash">squash</option>
                <option value="merge">merge</option>
                <option value="rebase">rebase</option>
              </select>
              <Button size="sm" variant="destructive" disabled={merge.busy} onClick={() => void merge.run({ pr: prRef, method })}>
                Merge
              </Button>
            </div>
          )}
          {status?.state === 'merged' && s.worktree?.projectId && (
            <Button size="sm" variant="outline" onClick={() => void backmerge.run(null)}>
              Backmerge
            </Button>
          )}
        </div>
      )}
      {error && <p className="text-red-600">{error.message}</p>}
      {all.map(({ m, title: t, label }) =>
        m.pending ? (
          <GitConfirmDialog key={label} request={m.pending} busy={m.busy} title={t} confirmLabel={label} danger={label === 'Merge'} onConfirm={() => m.confirm()} onCancel={m.cancel} />
        ) : null,
      )}
    </section>
  );
}
```
The three confirm dialogs reuse the button labels (`Commit`, `Push`, `Create PR`); the test clicks the last matching button, which is the one inside the open dialog.

`apps/web/src/features/review/ReviewAside.tsx`
```tsx
import type { Source } from '@orc/core';
import { useReview } from '@/api/queries/review';
import { CheckpointTimeline } from './CheckpointTimeline';
import { PresetButtons } from './PresetButtons';
import type { DiffSourceSel } from './ReviewPage';
import { ShipPanel } from './ShipPanel';
import { SummaryCard } from './SummaryCard';

export function ReviewAside({ source, id, select, selected }: { source: Source; id: string; select(s: DiffSourceSel): void; selected: DiffSourceSel }) {
  const review = useReview(source, id);
  if (!review.data) return null;
  return (
    <>
      <SummaryCard summary={review.data} />
      <PresetButtons summary={review.data} />
      <CheckpointTimeline sessionPk={review.data.sessionPk} selected={selected} onSelect={select} />
      {review.data.worktree && !review.data.worktree.isMain && <ShipPanel summary={review.data} />}
    </>
  );
}
```

Replace `apps/web/src/routes/review.$source.$id.tsx` with:
```tsx
import type { Source } from '@orc/core';
import { createFileRoute } from '@tanstack/react-router';
import { ReviewAside } from '@/features/review/ReviewAside';
import { ReviewPage } from '@/features/review/ReviewPage';

export const Route = createFileRoute('/review/$source/$id')({
  component: function ReviewRoute() {
    const { source, id } = Route.useParams();
    const src = source as Source;
    return <ReviewPage source={src} id={id} aside={({ select, selected }) => <ReviewAside source={src} id={id} select={select} selected={selected} />} />;
  },
});
```

- [ ] **Step 5: Implement the PR chip, launch fields and inbox actions**

Replace `apps/web/src/features/live-board/PrChip.tsx` with:
```tsx
import type { PrRef } from '@orc/core';
import { usePrStatus } from '@/api/queries/github';

const CHECK_MARK = { success: ' ✓', failure: ' ✗', pending: ' …', none: '' } as const;
const COLOR = { open: 'border-green-600', merged: 'border-purple-600', closed: 'border-gray-400' } as const;

export function PrChip({ pr }: { pr: PrRef }) {
  const q = usePrStatus(pr);
  const s = q.data;
  const label = s ? `PR #${pr.number}: ${s.state}, checks ${s.checks}, review ${s.review.replace('_', ' ')}` : `PR #${pr.number}`;
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={s?.title ?? pr.repo}
      className={`rounded border px-1 font-mono text-xs ${s ? COLOR[s.state] : 'border-gray-300'}`}
    >
      {`#${pr.number}${s ? CHECK_MARK[s.checks] : ''}`}
    </a>
  );
}
```

`apps/web/src/features/launch/LaunchPhase4Fields.tsx`
```tsx
import type { LaunchRequest } from '@orc/api-contract';
import { branchName } from '@orc/core/git';
import type { z } from 'zod';

export type LaunchDraft = z.input<typeof LaunchRequest>;
type WtType = 'feat' | 'fix' | 'chore' | 'docs' | 'refactor';

export function LaunchPhase4Fields({ draft, onChange, repos }: { draft: LaunchDraft; onChange(d: LaunchDraft): void; repos: string[] }) {
  const wt = draft.worktree;
  const setWt = (patch: Partial<NonNullable<LaunchDraft['worktree']>>) =>
    onChange({ ...draft, worktree: { repo: repos[0] ?? '', base: 'main', type: 'feat', slug: '', ...wt, ...patch } });
  let preview = '';
  if (wt?.slug) {
    try {
      preview = branchName({ type: wt.type, ticket: draft.ticket ?? null, slug: wt.slug });
    } catch (err) {
      preview = (err as Error).message;
    }
  }
  return (
    <fieldset className="space-y-2 text-sm">
      <label className="flex gap-2">
        <input
          type="checkbox"
          disabled={draft.source !== 'claude'}
          checked={draft.planApproval ?? false}
          onChange={(e) => onChange({ ...draft, planApproval: e.target.checked })}
        />
        Require plan approval first
      </label>
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={wt !== undefined}
          onChange={(e) => {
            if (e.target.checked) setWt({});
            else {
              const { worktree: _drop, ...rest } = draft;
              onChange(rest);
            }
          }}
        />
        New worktree for this ticket
      </label>
      {wt && (
        <div className="grid grid-cols-2 gap-2">
          <select aria-label="Worktree repository" value={wt.repo} onChange={(e) => setWt({ repo: e.target.value })}>
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <input aria-label="Worktree base" value={wt.base} onChange={(e) => setWt({ base: e.target.value })} />
          <select aria-label="Worktree type" value={wt.type} onChange={(e) => setWt({ type: e.target.value as WtType })}>
            {(['feat', 'fix', 'chore', 'docs', 'refactor'] as const).map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <input aria-label="Worktree description" value={wt.slug} onChange={(e) => setWt({ slug: e.target.value })} />
          <p className="col-span-2 font-mono text-xs">{preview}</p>
        </div>
      )}
    </fieldset>
  );
}
```
In `LaunchDialog.tsx`: delete `P4_ENABLED` and the disabled placeholder block, and render in its place
```tsx
<LaunchPhase4Fields draft={draft} onChange={setDraft} repos={(worktrees.data ?? []).filter((w) => w.isMain).map((w) => w.path)} />
```
with `const worktrees = useWorktrees({ state: 'active' });` at the top of the component and the imports for `LaunchPhase4Fields` and `useWorktrees`. When `draft.worktree` is set, the dialog's confirm text must say "creates a worktree"; the daemon's `POST /api/sessions/launch` already audits `worktree.create`.

`apps/web/src/features/inbox/PlanApprovalActions.tsx`
```tsx
import type { InboxItem, Source } from '@orc/core';
import { useState } from 'react';
import { getApiClient } from '@/api/client';
import { Button } from '@/components/ui/button';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation';

export function splitPk(pk: string): { source: Source; id: string } {
  const i = pk.indexOf(':');
  return { source: pk.slice(0, i) as Source, id: pk.slice(i + 1) };
}

export function PlanApprovalActions({ item }: { item: InboxItem }) {
  const [feedback, setFeedback] = useState('');
  const plan = typeof item.payload.plan === 'string' ? item.payload.plan : '';
  const owned = item.payload.owned === true;
  const target = item.sessionId ? splitPk(item.sessionId) : null;
  const invalidate = [['inbox']] as const;
  const approve = useConfirmedMutation((_: null, confirm: boolean) => {
    if (!target) throw new Error('missing session');
    return getApiClient().planApprove(target.source, target.id, { confirm });
  }, { invalidate });
  const reject = useConfirmedMutation((text: string, confirm: boolean) => {
    if (!target) throw new Error('missing session');
    return getApiClient().planReject(target.source, target.id, { feedback: text, confirm });
  }, { invalidate });

  return (
    <div className="space-y-2 text-sm">
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 dark:bg-gray-900">{plan}</pre>
      {!owned && <p className="text-gray-500">Resume this session in the app to answer the plan.</p>}
      {owned && (
        <>
          <div className="flex gap-1">
            <Button size="sm" disabled={approve.busy} onClick={() => void approve.run(null)}>
              Approve plan
            </Button>
          </div>
          <textarea aria-label="Feedback" className="w-full" rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          <Button size="sm" variant="outline" disabled={feedback.trim() === '' || reject.busy} onClick={() => void reject.run(feedback.trim())}>
            Reject plan
          </Button>
          {(approve.error ?? reject.error) && <p className="text-red-600">{(approve.error ?? reject.error)?.message}</p>}
        </>
      )}
      <GitConfirmDialog request={approve.pending} busy={approve.busy} title="Approve plan?" confirmLabel="Approve" onConfirm={() => approve.confirm()} onCancel={approve.cancel} />
      <GitConfirmDialog request={reject.pending} busy={reject.busy} title="Reject plan?" confirmLabel="Reject" onConfirm={() => reject.confirm()} onCancel={reject.cancel} />
    </div>
  );
}
```

`apps/web/src/features/inbox/PrEventActions.tsx`
```tsx
import type { InboxItem, PrRef } from '@orc/core';
import { Button } from '@/components/ui/button';
import { launchPreset } from '@/features/review/PresetButtons';
import { splitPk } from './PlanApprovalActions';

const PRESET_LABEL: Record<string, string> = { 'preset-fix-ci': 'Fix CI', 'preset-address-comments': 'Address comments' };

export function PrEventActions({ item }: { item: InboxItem }) {
  const p = item.payload as { pr?: PrRef; cwd?: string | null; presetId?: string | null; vars?: Record<string, string> };
  const review = item.sessionId ? splitPk(item.sessionId) : null;
  return (
    <div className="flex flex-wrap gap-2 text-sm">
      {p.pr && (
        <a href={p.pr.url} target="_blank" rel="noreferrer" className="underline">
          {`Open PR #${p.pr.number}`}
        </a>
      )}
      {review && (
        <a href={`/review/${review.source}/${review.id}`} className="underline">
          Review
        </a>
      )}
      {p.presetId && p.cwd && (
        <Button size="sm" variant="outline" onClick={() => void launchPreset(p.presetId as string, { cwd: p.cwd as string, projectId: item.projectId, vars: p.vars ?? {} })}>
          {PRESET_LABEL[p.presetId] ?? p.presetId}
        </Button>
      )}
    </div>
  );
}
```

In `InboxItemActions.tsx`, add to the `switch (item.kind)`:
```tsx
    case 'plan_approval':
      return <PlanApprovalActions item={item} />;
    case 'pr_event':
      return <PrEventActions item={item} />;
```
Keep the shared snooze/done buttons that P2 renders around the switch.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run apps/web/src/features`
Expected: PASS (5 + 3 + 2 new tests, all earlier web tests still green, including P2's `SessionCard` tests now that `PrChip` fetches status — if a P2 test renders `PrChip` without a `githubPr` stub, add `githubPr: () => new Promise(() => {})` to that test's fake client).

- [ ] **Step 7: Commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/web/src
git commit -m "feat(web): ship panel, checkpoint timeline, PR chips, presets and plan approval actions"
```

---
### Task 22: M4 end-to-end test, manual scratch-repo check, contract merge and phase exit

**Files:**
- Create: `apps/web/e2e/support/bin/claude` (executable fake agent), `apps/web/e2e/support/m4-seed.ts`, `apps/web/e2e/support/m4-teardown.ts`, `apps/web/e2e/m4-ticket-to-merge.spec.ts`, `apps/web/playwright.m4.config.ts`
- Modify: `apps/web/package.json` (script `e2e:m4`), `plan/00-contracts.md`, `plan/README.md`
- Create: `plan/spikes/M4-manual.md` (evidence of the manual check)

**Interfaces:**
- Consumes: the whole phase; the daemon build (`pnpm --filter @orc/daemon build` → `apps/daemon/dist/main.js`), `apps/daemon/test/bin/gh` (Task 4), `ORC_HOME` / `CLAUDE_HOME` / `CODEX_HOME` / `ORC_PORT` env (§3)
- Produces: `pnpm --filter @orc/web e2e:m4` (green), the M4 exit evidence, Phase 4 contract additions merged into `plan/00-contracts.md`

- [ ] **Step 1: Write the fake agent**

`apps/web/e2e/support/bin/claude` (then `chmod +x`)
```js
#!/usr/bin/env node
// Fake Claude for the M4 e2e: writes a transcript + registry entry, edits one file, then echoes stdin to a log.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.CLAUDE_HOME;
const e2eDir = process.env.E2E_DIR;
if (!home || !e2eDir) {
  process.stderr.write('CLAUDE_HOME and E2E_DIR are required\n');
  process.exit(2);
}
const sessionId = process.env.FAKE_CLAUDE_SESSION_ID ?? 'e2e-session-1';
const cwd = process.cwd();
const prompt = process.argv.slice(2).filter((a) => !a.startsWith('-')).at(-1) ?? '';
const now = () => new Date().toISOString();

const projectDir = join(home, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
mkdirSync(projectDir, { recursive: true });
const transcript = join(projectDir, `${sessionId}.jsonl`);
const base = { sessionId, cwd, isSidechain: false, version: 'e2e', gitBranch: 'HEAD' };
const lines = [
  { ...base, type: 'user', uuid: 'e2e-u1', parentUuid: null, timestamp: now(), message: { role: 'user', content: prompt || 'implement SAF-4242' } },
  {
    ...base, type: 'assistant', uuid: 'e2e-a1', parentUuid: 'e2e-u1', timestamp: now(),
    message: { id: 'e2e-m1', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'e2e-t1', name: 'Edit', input: { file_path: join(cwd, 'src/a.ts'), old_string: '', new_string: 'agent edit' } }], usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  },
];
writeFileSync(transcript, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

const file = join(cwd, 'src/a.ts');
writeFileSync(file, `${readFileSync(file, 'utf8')}export const agentEdit = true; // agent edit\n`);

// Registry entry: keep the field names identical to plan/spikes/S3.md.
const registry = join(home, 'sessions', `${process.pid}.json`);
mkdirSync(join(home, 'sessions'), { recursive: true });
writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId, cwd, startedAt: Date.now(), status: 'idle', waitingFor: null, statusUpdatedAt: Date.now() }));

process.stdout.write('\x1b[1mfake claude ready\x1b[0m\r\n> ');
process.stdin.setRawMode?.(true);
process.stdin.on('data', (chunk) => {
  appendFileSync(join(e2eDir, 'agent-input.log'), chunk.toString('utf8'));
  process.stdout.write('\r\n> ');
});
const bye = () => {
  rmSync(registry, { force: true });
  process.exit(0);
};
process.on('SIGTERM', bye);
process.on('SIGHUP', bye);
```

- [ ] **Step 2: Write the seed, teardown, config and spec**

`apps/web/e2e/support/m4-seed.ts`
```ts
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const PORT = 4418;
export const STATE_FILE = resolve(HERE, '../.m4-state.json');
const ROOT = resolve(HERE, '../../../..');

export interface M4State { dir: string; repo: string; orcHome: string; ghDir: string; pid: number; token: string }

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

export default async function globalSetup(): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orc-m4-')));
  const repo = join(dir, 'repo');
  const orcHome = join(dir, 'orc');
  const claudeHome = join(dir, 'claude');
  const codexHome = join(dir, 'codex');
  const ghDir = join(dir, 'gh');
  for (const d of [repo, orcHome, claudeHome, codexHome, ghDir]) mkdirSync(d, { recursive: true });

  const gitEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' };
  Object.assign(process.env, gitEnv);
  git(repo, 'init', '-b', 'main');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'initial');
  git(dir, 'init', '--bare', '-b', 'main', join(dir, 'remote.git'));
  git(repo, 'remote', 'add', 'origin', join(dir, 'remote.git'));
  git(repo, 'push', '-u', 'origin', 'main');

  writeFileSync(join(ghDir, 'state.json'), JSON.stringify({ authed: true, repo: 'example-org/e2e-repo', nextNumber: 101, prs: {} }));
  writeFileSync(join(ghDir, 'calls.jsonl'), '');
  writeFileSync(
    join(orcHome, 'config.json'),
    JSON.stringify({
      port: PORT,
      defaultProjectId: 'e2e',
      resumeProfile: { claudeCommand: 'claude', claudeArgs: ['--dangerously-skip-permissions'] },
      projects: [{ id: 'e2e', name: 'E2E', pathPrefixes: [dir], ticketRegex: '\\bSAF-\\d+\\b', repos: [{ path: repo }] }],
      github: { enabled: true, pollSeconds: 30 },
      worktrees: { scratchpadRoots: [], autoArchiveOnMerge: true },
      archive: { enabled: false },
    }),
  );

  const bins = [resolve(ROOT, 'apps/web/e2e/support/bin'), resolve(ROOT, 'apps/daemon/test/bin')];
  const child: ChildProcess = spawn('node', [resolve(ROOT, 'apps/daemon/dist/main.js')], {
    env: {
      ...process.env,
      ...gitEnv,
      PATH: `${bins.join(delimiter)}${delimiter}${process.env.PATH ?? ''}`,
      ORC_HOME: orcHome,
      CLAUDE_HOME: claudeHome,
      CODEX_HOME: codexHome,
      ORC_PORT: String(PORT),
      FAKE_GH_DIR: ghDir,
      E2E_DIR: dir,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  });
  child.unref();

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const token = readFileSync(join(orcHome, 'token'), 'utf8').trim();
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: { 'x-orc-token': token } });
      if (r.ok) {
        const state: M4State = { dir, repo, orcHome, ghDir, pid: child.pid ?? 0, token };
        writeFileSync(STATE_FILE, JSON.stringify(state));
        return;
      }
    } catch {
      // daemon not up yet
    }
    if (Date.now() > deadline) throw new Error('daemon did not start');
    await new Promise((r) => setTimeout(r, 250));
  }
}
```

`apps/web/e2e/support/m4-teardown.ts`
```ts
import { readFileSync, rmSync } from 'node:fs';
import { type M4State, STATE_FILE } from './m4-seed';

export default async function globalTeardown(): Promise<void> {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as M4State;
  try {
    process.kill(-state.pid, 'SIGTERM');
  } catch {
    process.kill(state.pid, 'SIGTERM');
  }
  await new Promise((r) => setTimeout(r, 500));
  rmSync(state.dir, { recursive: true, force: true });
  rmSync(STATE_FILE, { force: true });
}
```

`apps/web/playwright.m4.config.ts`
```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /m4-.*\.spec\.ts/,
  timeout: 120_000,
  workers: 1,
  globalSetup: './e2e/support/m4-seed.ts',
  globalTeardown: './e2e/support/m4-teardown.ts',
  use: { baseURL: 'http://127.0.0.1:4418', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
```
Add to `apps/web/package.json` scripts: `"e2e:m4": "pnpm --filter @orc/daemon build && pnpm build && playwright test -c playwright.m4.config.ts"`.

`apps/web/e2e/m4-ticket-to-merge.spec.ts`
```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type M4State, STATE_FILE } from './support/m4-seed';

const state = () => JSON.parse(readFileSync(STATE_FILE, 'utf8')) as M4State;
const BRANCH = 'feat/SAF-4242-e2e-flow';

async function api<T>(path: string): Promise<T> {
  const r = await fetch(`http://127.0.0.1:4418${path}`, { headers: { 'x-orc-token': state().token } });
  return (await r.json()) as T;
}

async function confirmDialog(page: import('@playwright/test').Page, label: string) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('ticket → worktree → agent → review with inline comment → PR → merged → worktree archived', async ({ page }) => {
  const s = state();
  const wtPath = join(s.repo, '.worktrees', 'feat-SAF-4242-e2e-flow');

  // 1. ticket → worktree + agent
  await page.goto('/worktrees');
  await page.getByRole('button', { name: 'New worktree' }).click();
  await page.getByLabel('Ticket').fill('SAF-4242');
  await page.getByLabel('Short description').fill('e2e flow');
  await expect(page.getByLabel('Branch preview')).toHaveText(BRANCH);
  await page.getByLabel('Launch Claude in the new worktree').check();
  await page.getByLabel('Prompt').fill('implement SAF-4242');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await confirmDialog(page, 'Create');
  await expect(page.getByText(BRANCH)).toBeVisible();

  // 2. the (fake) agent edits a file
  await expect.poll(() => existsSync(join(wtPath, 'src/a.ts')) && readFileSync(join(wtPath, 'src/a.ts'), 'utf8').includes('agent edit')).toBe(true);
  await expect.poll(async () => (await api<{ owned: boolean }>('/api/review/claude/e2e-session-1')).owned, { timeout: 30_000 }).toBe(true);

  // 3. review with an inline comment sent to the agent
  await page.goto('/review/claude/e2e-session-1');
  await expect(page.getByRole('navigation', { name: 'Changed files' }).getByText('src/a.ts')).toBeVisible();
  await page.getByRole('navigation', { name: 'Changed files' }).getByLabel('Viewed src/a.ts').check();
  const addedLine = page.locator('tr', { hasText: 'agentEdit' }).first();
  await addedLine.hover();
  await addedLine.locator('.diff-add-widget').first().click();
  await page.getByLabel('Comment').fill('name this constant AGENT_EDIT');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(page.getByText('src/a.ts:2')).toBeVisible();
  await page.getByRole('button', { name: 'Send to agent' }).click();
  await confirmDialog(page, 'Send');
  await expect.poll(() => {
    const log = join(s.dir, 'agent-input.log');
    return existsSync(log) ? readFileSync(log, 'utf8') : '';
  }).toContain('src/a.ts:2');

  // 4. commit → push → PR
  await expect(page.getByLabel('Commit message')).toHaveValue(/SAF-4242/);
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await confirmDialog(page, 'Commit');
  await page.getByRole('button', { name: 'Push', exact: true }).click();
  await confirmDialog(page, 'Push');
  await page.getByRole('button', { name: 'Create PR', exact: true }).click();
  await confirmDialog(page, 'Create PR');
  await expect(page.getByRole('link', { name: /#101/ })).toBeVisible();

  // 5. merge → auto-archive
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await confirmDialog(page, 'Merge');
  await expect.poll(() => existsSync(wtPath), { timeout: 30_000 }).toBe(false);
  const active = await api<Array<{ branch: string }>>('/api/worktrees?state=active');
  expect(active.map((w) => w.branch)).not.toContain(BRANCH);

  // 6. every write is audited, archive by automation
  const audit = await api<Array<{ action: string; actor: string; result: string }>>('/api/audit?limit=200');
  const actions = audit.filter((e) => e.result === 'ok').map((e) => e.action);
  for (const a of ['worktree.create', 'session.launch', 'review.send', 'git.commit', 'git.push', 'pr.create', 'pr.merge', 'worktree.archive']) {
    expect(actions).toContain(a);
  }
  expect(audit.find((e) => e.action === 'worktree.archive')?.actor).toBe('automation');
  const ghCalls = readFileSync(join(s.ghDir, 'calls.jsonl'), 'utf8');
  expect(ghCalls).not.toContain('--admin');
  expect(ghCalls).not.toContain('--force');
});
```
The `.diff-add-widget` selector is the add-comment button that `@git-diff-view/react` renders on hover. If the installed version uses another class, find it with the Playwright inspector and update this one line; record it in the review note. The added line is line 2 of `src/a.ts` (line 1 is the original export).

- [ ] **Step 3: Run the e2e**

Run: `chmod +x apps/web/e2e/support/bin/claude && pnpm --filter @orc/web e2e:m4`
Expected: `1 passed`. If the review step times out on `owned`, check that the fake registry fields match `plan/spikes/S3.md` and that P2's launch maps the PTY pid to the session.

- [ ] **Step 4: Manual check on a scratch repo (evidence required)**

This step uses the real `claude` and `gh`. The GitHub part writes to a **private scratch repository** that the user creates for this purpose; ask the user before running it, and never point it at a work repository.

1. `mkdir -p ~/scratch/orc-m4 && cd ~/scratch/orc-m4 && git init -b main && echo "# scratch" > README.md && git add -A && git commit -m init`. If the user agreed: `gh repo create <user>/orc-m4-scratch --private --source . --push`.
2. Add the repo to Settings → Projects → repos (path `~/scratch/orc-m4`, `setup: "echo setup-ran"`, `copyGlobs: [".env"]`), create `~/scratch/orc-m4/.env` (ignored via `.gitignore`).
3. In the app, check each item and record pass/fail with a screenshot or pasted output:

| # | Check | How |
|---|---|---|
| a | Create worktree from ticket `SCR-1`, `.env` copied, setup output visible in the terminal tab | `/worktrees` → New worktree |
| b | Launch with **plan approval**: plan appears in the inbox; **Approve** starts implementation (keys in `plan-keys.ts` work) | Launch dialog |
| c | Second run: **Reject** with feedback; Claude revises the plan instead of implementing | Inbox |
| d | Each finished turn adds a checkpoint; `git -C <wt> log -1` and `git -C <wt> stash list` are unchanged | Review page timeline + terminal |
| e | Rewind to turn 1 restores files; a safety checkpoint appears | Review page |
| f | Revert one hunk; the other hunk stays | Review page |
| g | Inline comment → Send to agent → Claude addresses it | Review page |
| h | Sync to main copies the changed files; with a local edit in main the sync is refused | `/worktrees` |
| i | Archive with uncommitted changes is refused | `/worktrees` |
| j | A worktree made by `/conductor` (or `git worktree add` by hand) shows as `external`; archive asks for the extra confirmation | `/worktrees` |
| k | (scratch GitHub only) Commit → Push → PR (template used if `.github/pull_request_template.md` exists) → Merge → worktree archived within one poll | Review page |
| l | Every action above appears in `/audit` | `/audit` |

Write the table with results to `plan/spikes/M4-manual.md`. If check b or c fails, update `PLAN_KEYS` in `apps/daemon/src/services/review/plan-keys.ts`, rerun Task 16's tests and the check, and note the change.

- [ ] **Step 5: Merge the contract additions**

Copy every block of this plan's "Contract additions" section into `plan/00-contracts.md`:
- §2: the new folders
- §3: the `github` and `worktrees` config blocks inside `OrcConfig`
- §4: the new types, and the new audit action names appended to the list
- §5: replace the Phase 4 row of the table with the three table rows (keys and columns)
- §6: replace the `P4  /api/worktrees…` line with the full Phase 4 route list; add the new error codes to the "Errors" bullet; add the `LiveEvent` and `BusEvent` members and the Phase 4 query keys
- §11: replace the P4 interface block with the full interfaces from this plan (the §11 members stay identical; the additions are appended) and add the `DaemonContext` fields `diff`, `review`, `plans`; note the inbox rules and dedupe keys under the P2 `InboxEngine` block

- [ ] **Step 6: Check the exit criteria**

| Criterion (docs/05-roadmap.md M4) | Evidence |
|---|---|
| `pnpm lint && pnpm typecheck && pnpm test` all green | command output |
| ticket → worktree → agent → review with inline comments → PR → merged → worktree archived, without leaving the app | `pnpm --filter @orc/web e2e:m4` output (1 passed) |
| Discovery finds config repos, `.worktrees`, siblings, scratchpads, `githubRepoPaths`, session cwds | Task 6 tests + `/worktrees` screenshot on the real machine (read-only) |
| Checkpoints never move HEAD / index / stash | Task 10 tests + manual check d |
| No force push, no `--admin`, dirty archive refused, external worktrees protected | Task 4, 9, 15, 17 tests + manual i, j + e2e gh-call assertion |
| Plan approval works in the real TUI | manual b, c |
| Every write audited | e2e audit assertion + manual l |
| Contract additions merged | `plan/00-contracts.md` diff |

- [ ] **Step 7: Update the README status, commit and merge**

In `plan/README.md`, set the Phase 4 row status to `☑ done` (with the date).

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add apps/web/e2e apps/web/playwright.m4.config.ts apps/web/package.json plan
git update-index --chmod=+x apps/web/e2e/support/bin/claude
git commit -m "test(web): add M4 ticket-to-merge e2e and merge phase 4 contracts"
git checkout main && git merge --no-ff phase/4-worktrees-review-merge -m "merge: phase 4 worktrees, review and merge"
```

---
## Self-review

**Spec coverage** (docs/02-features.md, docs/03 flows 4 and 6, docs/05 M4, and the scope list for this phase):

| Requirement | Task |
|---|---|
| F17 discovery: `git worktree list --porcelain` over config repos, session cwds, `githubRepoPaths` (only that key), `.worktrees`, siblings, `/private/tmp/claude-*` scratchpads | 2, 6, 7 |
| Link worktrees to tickets, sessions, PRs; `worktrees` table; dirty state | 5, 7 |
| Create: `<type>/<TICKET>-<slug>` (slugified, uppercase ticket, ≤30-char slug), `git worktree add -b`, copy ignored globs, setup script in a PTY | 2, 8 |
| Run/archive scripts; open in IDE/Terminal/Finder | 8, 9, 17, 19 |
| Sync to main with confirmation; refuse when main has local edits to those files | 9, 17, 19 |
| Archive/prune: refuse dirty; confirm; never `--force`; branch kept | 4, 9, 17, 19 |
| Auto-archive on `pr.changed` → merged; external worktrees never auto-removed | 14 |
| Coexistence with `/conductor`: external worktrees `createdByApp=false`, extra confirmation; existing branch reused, duplicate worktree refused | 7, 8, 9, 17, 19 |
| `/api/worktrees…` routes; audit on every write | 8, 9, 17 |
| F18 diff service (base…worktree, per-file stats, unified patch, per-turn via checkpoints) | 3, 11, 18 |
| CheckpointService: temp index + write-tree + commit-tree + update-ref `refs/orchestrator/checkpoints/<sessionId>/<turn>`; HEAD/index/stash untouched (tested); created on `session.turnEnded` for owned sessions in a worktree | 10 |
| Rewind with safety checkpoint + `git restore --source` | 10, 18, 21 |
| Partial revert per file/hunk (`git apply -R`) with safety ref | 3, 11, 18, 20 |
| Inline comments → structured prompt → `sendText` to owned session, else text (clipboard / new session) | 3, 12, 18, 20 |
| Review summary card (files, ±, last test, recap null-safe, CI) | 12, 21 |
| ShipService: suggested message, commit, push (never forced), `gh pr create` with repo template + ticket link, `gh pr merge` with confirm, backmerge template | 15, 18, 21 |
| F11 GitHub via `gh`: status, prStatus, myOpenPrs, 90 s poll emitting `pr.changed`; `pr_cache` | 5, 13 |
| Inbox `pr_event` rules (checks failed, changes requested, review requested) + tests | 13, 14 |
| F4 plan approval: `--permission-mode plan`, ExitPlanMode detection → `plan_approval` item → approve / reject with feedback | 16, 18, 21 |
| `LaunchRequest.worktree` supported; Phase 2 `501` removed for both fields | 16 |
| Web: `/worktrees`, `/review/$source/$id` (split/unified, file tree, viewed, inline comments, send to agent), checkpoint timeline with rewind confirm, ship panel, live PR chips, Fix CI / Address comments presets | 19, 20, 21 |
| Tests with real git in temp repos, fake `gh` in `apps/daemon/test/bin`, no real repos | 4 and every service task |
| M4 exit: e2e ticket → worktree → agent → review → PR → merged → archived; manual scratch-repo check | 22 |

**Placeholder scan:** searched for "TODO", "TBD", "implement later", "fill in", "similar to Task" — none. The only deliberately variable items are named and bounded: `PLAN_KEYS` (verified in Task 22 Step 4), the `.diff-add-widget` selector (checked in Task 22 Step 2), the fake registry fields (must match `plan/spikes/S3.md`), and the earlier-phase names in "Assumed from earlier phases".

**Type consistency** (checked across tasks):
- `WorktreeService` members `discover/create/createWith/runScript/syncToMain/syncPreview/archive/archiveAs/branchName/list/get/findByCwd/open` are identical in Contract additions, Task 9 and every consumer (Tasks 10–18).
- `CheckpointService.create/createAs/list/get/diff/rewind/pruneForWorktree`; `CheckpointRecord.kind` is `'turn' | 'safety' | 'manual'` everywhere; `Checkpoint.sessionId` is the native id and the pk is read from the row (Task 18).
- `GithubConnector.status/prStatus/myOpenPrs/poll/watch/start`; `PrStatus` has `headRef` and `failedChecks` in core, zod, `pr_cache` and fake-gh mapping.
- Bus events `pr.changed`, `pr.reviewRequested`, `plan.pending`; live events `worktree.updated`, `worktree.removed`, `pr.updated`, `checkpoint.created` are declared in Task 1 and handled in Tasks 10, 13, 14, 16, 19.
- Inbox dedupe keys `pr:<repo>#<n>:checks|review|review_requested`, `plan:<pk>`, `worktree:<path>:archive_blocked` match between rules, services, tests and Contract additions; inbox `sessionId` carries the session pk throughout.
- Client method names in Task 18 match every call site in Tasks 19–21 (`worktreesArchive`, `diffRevert`, `checkpointsRewind`, `reviewComments`, `shipPr`, `planApprove`, `githubPr`, …).
- Error codes used by services are all present in `GIT_ERROR_STATUS` (Task 17) and in the Contract additions list.

**Safety review:** `assertSafeGitArgs` blocks force pushes, ref deletion pushes, hard resets, `git clean`, forced worktree removal, `checkout -- <paths>`, branch deletion, any `stash` write and `update-ref` outside `refs/orchestrator/`. Every write route requires `confirm: true`; external worktrees also require `confirmExternal: true`; merges never pass `--admin`; every write runs inside `audited()`; checkpoints use a throwaway index and never move HEAD.
