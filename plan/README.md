# Orchestrator — Implementation Plans

These plans turn the design in [`../docs`](../docs/README.md) into working software, **one phase at a time**. Each phase is a self-contained plan in the superpowers *writing-plans* format: bite-sized test-first steps with real code, exact commands and a commit per task.

## How to execute a phase
1. **Read first:** [`00-contracts.md`](00-contracts.md) (shared names, types, routes, conventions), the phase file, and the doc sections the phase header links to.
2. **Branch:** `git checkout -b phase/<n>-<slug>` from an up-to-date `main`.
3. **Execute** with **superpowers:subagent-driven-development**: a fresh subagent per task, with a two-stage review between tasks. Each task already lists its files, its interfaces (Consumes/Produces), its test-first steps and its commit.
4. **Gate after every task:** `pnpm lint && pnpm typecheck && pnpm test` must be green before the commit. Never skip a failing test. Fix it, or stop and ask.
5. **Evidence rule:** a step with an "Expected:" line is done only when the actual output was observed. Manual or UI checks need a screenshot or pasted output in the task's review note.
6. **Contract changes:** when a phase needs a new shared name, it adds it under its own "Contract additions" section. The additions are merged into `00-contracts.md` in the phase's final task.
7. **Phase exit:** the last task of every phase checks the exit criteria (they come from `docs/05-roadmap.md`), updates the status table below, and merges into `main` with `--no-ff`.
8. **Execution handoff:** at the start of each phase, the executor re-reads the spike reports in `plan/spikes/`. Spike decisions override the details in these plans, and the executor records any change in the task's review note.

## Phase order & dependencies

```
Phase 0 ──▶ Phase 1 ──▶ Phase 2 ──▶ Phase 3 ──▶ Phase 4 ──▶ Phase 5 ──▶ Phase 6 ──▶ Phase 7
 setup       history      live board    detail       worktrees    streams      linear/slack  automations
 + spikes    search       inbox         safety       review/merge analytics    remote/mobile compare
             resume       archive       audit        github       limits       (PWA, push)   supervisor
             projects     launch        palette                   recaps/goals               agnc/tauri/mcp
```
Phases depend only on earlier phases. Phases 1–3 make up the **core viewer**, which is usable daily after Phase 2. Phases 4–7 add the **active orchestration** features. After Phase 3 you can pause or re-prioritise safely.

## Status

| Phase | Plan | Milestone | Features | Tasks | Status |
|---|---|---|---|---|---|
| 0 | [Foundations & spikes](phase-0-foundations-and-spikes.md) | M0 | scaffold, core parser base, spikes S1–S3, S5–S8 | 11 | ✅ done (S6 blocked on `gh auth refresh -s read:packages`) |
| 1 | [History, search & resume](phase-1-history-search-resume.md) | M1 | F3, F4 (resume/fork/adopt), F13, F2 (basic) | 20 | ☑ done (2026-09-21) — 20/20 tasks, 289 unit tests + 1 perf suite + 3 Playwright e2e, all green |
| 2 | [Live board, inbox & archive](phase-2-live-board-inbox-archive.md) | M2 | F1, F15, F4 (launch, templates, presets), F5 | 20 | ◐ in progress — 9/20 tasks, branch `phase/2-live-board-inbox-archive`, Task 9 fix round staged (uncommitted) |
| 3 | [Session detail, safety & audit](phase-3-session-detail-safety-audit.md) | M3 | F2 (full), F9, F24, F8 | 19 | ☐ |
| 4 | [Worktrees, review & merge](phase-4-worktrees-review-merge.md) | M4 | F17, F18, F11 (GitHub), plan approval | 22 | ☐ |
| 5 | [Streams, analytics, limits, recaps, goals](phase-5-streams-analytics-limits-recaps-goals.md) | M5 | F6, F7, F19, F14, F16, F10 | 22 | ☐ |
| 6 | [Linear, Slack & remote](phase-6-linear-slack-remote.md) | M6 | F11 (Linear, Slack), F22, spike S9 | 22 | ☐ |
| 7 | [Automations, compare, supervisor](phase-7-automations-compare-supervisor.md) | M7 | F20, F21, F23, AGNC (S4), Tauri, MCP server, F12 picks | 25 | ☐ |

## Phase 2 — in progress (resume here)

**Branch:** `phase/2-live-board-inbox-archive`, base `97464eb`, 32 commits. Phases 0 and 1 are merged to `main` and pushed.

**Uncommitted work — commit this first on resume.** Task 9's fix round is complete and verified but staged, not committed: `apps/daemon/src/inbox/engine.ts`, `apps/daemon/src/inbox/dedupe-key.ts`, `apps/daemon/src/inbox/engine.test.ts`, `apps/daemon/src/db/repos/inbox.ts`, `apps/daemon/src/http/redact-out.test.ts`, `plan/00-contracts.md`, plus untracked `.conductor-repo-worktree-mechanism`. It was blocked by a conductor hook that refuses `git commit` from the orchestrator — not by any test or gate failure. Suggested subject: `fix(daemon): close the inbox engine's remaining silent-suppression paths`.

**Tasks done:**

| Task | What | Commits |
|---|---|---|
| 1 | inbox_items / test_results / archive_entries tables + repos, migration 0003 | `d02f938` |
| 2 | api-contract phase-2 route schemas, live config, client methods | `b240018` |
| 3 | stage inference from tool activity | `36b2cc0`, `59d5e0f` |
| 4 | live reducer + status derivation | `ebbbe9d` |
| 5 | registry watcher (chokidar + reconciliation backstop) | `3294e88`, `1363cba` |
| 6 | Codex live process detection + rollout matching | `5beba39` → `8345329` |
| 7 | LiveTracker (status, ownership, transcript tail, events) | `76524ad` → `21d7036` |
| 8 | `GET /api/live`, `/ws` hub, hook ingest, redaction boundary | `22e03e4` → `4191dfc` |
| 9 | InboxEngine (upsert, resolve, triage, snooze, rules) | `bde6889`, `e4119c3`, + staged fix round |

**Tasks remaining:** 10 (inbox status rules), 11 (Notifier), 12 (TemplateRegistry), 13 (LaunchService), 14–15 (archive sync + restore), 16 (daemon wiring), 17–20 (web: queries, live board, inbox, settings), then the phase exit check and PR.

**Test count:** 289 at Phase 1 exit → 658 committed → 666 with the staged fix round.

**Before starting Task 16** — five pieces of deliberate friction were left for it, each surfacing as a test failure rather than silence:
1. Wire `onSuspectedFormatChange` → `ctx.log.warn` at the `createLivenessChecker` construction site, or the guard against a silently-emptying board protects nothing.
2. Register Phase 2 routes through `registerAllRoutes`, **before** the `app.all('/api/*')` catch-all, or every Phase 2 route 404s.
3. Add `/ws` upgrade dispatch alongside the PTY socket without regressing its auth, origin and 1 MiB frame guards.
4. Add its registration file to the registrar allowlist in the route census.
5. Add its routes to `test/route-census.ts`.

Also re-check `usage.updated` against key-aware over-redaction when that event is first produced.

**Deferred, not defects:**
- `repos[].setup/run/archive` are served unredacted on `GET /api/projects/:id` — a declared round-trip exemption; revisit when Phase 4 starts executing those commands.
- Pair-form redaction gaps listed in `redact-out.ts`: `{name,val}`, `{k,v}`, `{header,value}`, OpenAPI `schema.default`, tuple pairs, sibling-object splits.
- Phases 4, 5 and 7 plan files carry roughly 31 stale `inbox.upsert({ dedupeKey })` call sites; each file has a SUPERSEDED banner at the top rather than a rewrite.

**Full detail:** the SDD ledger at `.superpowers/sdd/phase-2-live-board-inbox-archive/progress.md` (git-ignored) records every ruling, review finding and carry-forward. It is the recovery map — trust it and `git log` over recollection.

Total: **161 tasks**, roughly 1,030 individually checkable steps.

Spike reports go in [`spikes/`](spikes/).

## Global constraints (apply to every task)
- **Toolchain:** Node `>=22.12 <23`, pnpm `10.18.3`, TypeScript `~6.0.3` strict, Vitest 5, Biome 2. All versions are listed in contracts §1.
- **Local only:** the daemon binds to `127.0.0.1`. Every API/WS request needs `x-orc-token`. Remote access comes only in Phase 6, via `tailscale serve`.
- **Read-only toward tool data:** never write to `~/.claude` or `~/.codex`. The only exceptions are the confirmed archive restore (Phase 2) and the consented hook install (Phase 5). Never read `*.key`, `~/.codex/auth.json`, or auth fields in `~/.claude.json`.
- **Write actions:** git, PR, merge, PTY input and integration posts require a confirmation (or an enabled rule) and **always** get an audit entry. From Phase 3 on, every write path calls `audit.record()`.
- **Redaction:** transcript text leaves the daemon only after `redact()`. Nothing unredacted is sent to Slack, Linear or LLM recaps.
- **Input to sessions:** only to **owned** sessions (ones the app spawned or resumed in its PTY). Claude's `messagingSocketPath` is never used.
- **Automation and supervisor:** never merge, deploy, touch prod or run destructive git commands (shared deny-list, F9).
- **Defaults (decided):**
  - resume flags `--dangerously-skip-permissions`
  - default project `wakecap`
  - Codex automated sessions hidden
  - AGNC optional and last
  - recaps use `claude-haiku-4-5` for automatic runs and `claude-sonnet-5` on demand
  - Slack and Linear act **as the user**
- **Fixtures** are made up and redacted, and `pnpm check:fixtures` must pass.
- **Commits** follow Conventional Commits with a scope, one per task at minimum.
