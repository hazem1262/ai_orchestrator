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
| 2 | [Live board, inbox & archive](phase-2-live-board-inbox-archive.md) | M2 | F1, F15, F4 (launch, templates, presets), F5 | 20 | ☑ done (2026-09-23) — 20/20 tasks, merged as `e817f1b`; 1116 unit tests + 7 Playwright e2e, all green; exit check in [phase-2-evidence.md](phase-2-evidence.md) |
| 3 | [Session detail, safety & audit](phase-3-session-detail-safety-audit.md) | M3 | F2 (full), F9, F24, F8 | 19 | ☑ done (2026-09-24) — 19/19 tasks, merged into `main` with `--no-ff`; 1339 unit tests in 117 files + 9 Playwright e2e, all green; exit check in [phase-3-evidence.md](phase-3-evidence.md) |
| 4 | [Worktrees, review & merge](phase-4-worktrees-review-merge.md) | M4 | F17, F18, F11 (GitHub), plan approval | 22 | ☑ done (2026-09-26) — 22/22 tasks; 1509 unit tests in 156 files + 9 Playwright e2e + 1 M4 Playwright e2e, all green; plan approval not yet checked in the real TUI; exit check in [phase-4-evidence.md](phase-4-evidence.md) |
| 5 | [Streams, analytics, limits, recaps, goals](phase-5-streams-analytics-limits-recaps-goals.md) | M5 | F6, F7, F19, F14, F16, F10 | 22 | ☑ done (2026-09-27) — 22/22 tasks + 5 exit-fix commits; 1714 unit tests in 206 files + 11 Playwright e2e + 1 M4 Playwright e2e, all green; real recap engines, the real-home hook install and the official quota source not yet checked; exit check in [phase-5-evidence.md](phase-5-evidence.md) |
| 6 | [Linear, Slack & remote](phase-6-linear-slack-remote.md) | M6 | F11 (Linear, Slack), F22, spike S9 | 22 | ☑ done (2026-09-27) — 21/22 tasks (Task 21, optional Linear OAuth, skipped); 1885 unit tests in 232 files, all green; **every live check is still manual — not yet run**: spike S9 a–h (real `tailscale serve`, phone pairing, passkey, Web Push, Slack self-DM), the `Tailscale-User-Login` stripping check (NO-GO for remote access if it fails), the real Keychain, and real Linear and Slack connections; exit check in [phase-6-evidence.md](phase-6-evidence.md) |
| 7 | [Automations, compare, supervisor](phase-7-automations-compare-supervisor.md) | M7 | F20, F21, F23, AGNC (S4), Tauri, MCP server, F12 picks | 25 | ✅ done (2026-09-28) — 25/25 tasks + 2 fix commits (`576598b`, `f0c142c`); 2145 unit tests in 276 files, all green; the three M7 exit rules are guarded by `apps/daemon/test/p7/m7-exit.test.ts`; S4 is GO (unconfirmed) with AGNC off by default; **every live check is still manual — not yet run**: S4 a–f, real `claude -p`, `orc-mcp` with a real Claude/Codex, a real codex compare variant, and the whole Tauri build (Rust is not installed); exit check in [phase-7-evidence.md](phase-7-evidence.md) |

## Resume here

**Where the work stands:** Phases 0 to 7 are done in code. Phase 7 is complete on branch
`phase/7-automations-compare-supervisor` and goes into `main` with `--no-ff`. Its live checks have
not been run; see [`phase-7-evidence.md`](phase-7-evidence.md). **There is no Phase 8 plan**: every
milestone in `docs/05-roadmap.md` (M0–M7) now has a phase. The next step is to merge Phase 7, then
work through the manual checks of Phases 5, 6 and 7, then decide what comes next.

**Next steps, in order**
1. Merge `phase/7-automations-compare-supervisor` into `main` with `--no-ff`.
2. Decide whether automation runs strip `ANTHROPIC_API_KEY` from the child environment
   ([`phase-7-evidence.md` → *Decisions for the user*](phase-7-evidence.md#decisions-for-the-user)).
3. Run the Phase 7 manual checks: S4 a–f ([`spikes/S4.md`](spikes/S4.md)), a real `claude -p`
   automation run, `orc-mcp` with Claude and Codex, a codex compare variant, and the desktop build
   (install Rust, `node scripts/build-sidecar.mjs`, `test:rust`, `tauri icon`, `dev:app` a–f, `build:app`).
4. Run the Phase 6 live checks (spike S9 a–h, the real Keychain, Linear and Slack) and the Phase 5
   ones ([`phase-6-evidence.md`](phase-6-evidence.md), [`phase-5-evidence.md`](phase-5-evidence.md)).

**Repository state** (2026-09-28, before the Phase 7 merge)

| Fact | Value | Proof |
|---|---|---|
| Phase 7 branch head | the Task 25 docs commit `docs(plan): record phase 7 outcomes and merge the contract additions`, on top of `9e02e65` | `git log --oneline -1 phase/7-automations-compare-supervisor` |
| Phase 7 commits | `b1d5899`…`9e02e65` (24 task commits, including S4 `90385d3`, and fixes `576598b`, `f0c142c`), and the Task 25 docs commit | `git log --oneline main..phase/7-automations-compare-supervisor` |
| Unpushed | `main` matches `origin/main` at `57f69a7` (the Phase 6 merge); the 26 Phase 7 commits plus the Task 25 commit exist only on the local branch | `git rev-list --count origin/main..phase/7-automations-compare-supervisor` |
| Leftover branches | `phase/7-automations-compare-supervisor` after the merge — merged and safe to delete | `git branch --merged main` |

**Gates** (run 2026-09-28 on the Phase 7 branch with the Task 25 changes, `ANTHROPIC_API_KEY` unset):
`pnpm run lint` clean with 1 info (biome asks for `biome migrate` on its own config),
`pnpm run typecheck` clean, `pnpm run test` → 2145 tests in 276 files, `pnpm run check:fixtures`
clean. The builds and the Playwright suites were not re-run for the exit check.

**How to run the app:** `pnpm dev` from the repo root. The web app serves on
`http://localhost:5173` and the daemon on `http://127.0.0.1:4317`. Every local API and WS request
needs the token from `~/.orchestrator/token`, sent as the `x-orc-token` header. Remote access is off
by default (`remote.enabled: false`); to set up Linear, Slack and the phone, follow
[`../docs/setup-remote-and-connectors.md`](../docs/setup-remote-and-connectors.md). Automations, the
supervisor and AGNC are off by default (`automations.enabled`, `supervisor.enabled`, `agnc.enabled`);
turn them on from the Automations page and Settings, or in `~/.orchestrator/config.json`. The desktop shell (`pnpm --filter @orc/desktop dev:app`) needs Rust.

Total: **161 tasks**, roughly 1,030 individually checkable steps.

Spike reports go in [`spikes/`](spikes/); phase evidence: [`phase-2-evidence.md`](phase-2-evidence.md) … [`phase-7-evidence.md`](phase-7-evidence.md). S7 (quota) took the `official` branch: `limits.quotaSource` defaults to `official` with the `rate_limits.five_hour.*` / `rate_limits.seven_day.*` field paths from the statusline stdin. The Phase 5 exit check ran on fixtures only, so no hooks were installed on the real home and no real `rate_limits` sample was ingested. S9 (remote) recorded read-only checks only: Phase 6 ships on the plan's defaults, and its live checks a–h are still to run ([`spikes/S9.md`](spikes/S9.md)). S4 (AGNC) is GO (unconfirmed) from read-only checks: Phase 7 ships the AGNC connector behind `agnc.enabled: false`, and its live checks a–f are still to run ([`spikes/S4.md`](spikes/S4.md)).

## Global constraints (apply to every task)
- **Toolchain:** Node `>=22.12 <23`, pnpm `10.18.3`, TypeScript `~6.0.3` strict, Vitest 5, Biome 2. All versions are listed in contracts §1.
- **Local only:** the daemon binds to `127.0.0.1`. Every API/WS request needs `x-orc-token`. Remote access comes only in Phase 6, via `tailscale serve`.
- **Read-only toward tool data:** never write to `~/.claude` or `~/.codex`. The only exceptions are the confirmed archive restore (Phase 2) and the consented hook install (Phase 5). Never read `*.key`, `~/.codex/auth.json`, or auth fields in `~/.claude.json`.
- **Write actions:** git, PR, merge, PTY input and integration posts require a confirmation (or an enabled rule) and **always** get an audit entry. From Phase 3 on, every write path calls `audit.record()`.
- **Redaction:** transcript text leaves the daemon only after `redact()`. Nothing unredacted is sent to Slack, Linear or LLM recaps.
- **Input to sessions:** only to **owned** sessions (ones the app spawned or resumed in its PTY). Claude's `messagingSocketPath` is never used.
- **Automation and supervisor:** never merge, deploy, touch prod or run destructive git commands (shared deny-list, F9).
- **Unattended code** (automations, supervisor) never merges, deploys or touches prod, runs with a restricted Claude tool set, and is bound by budgets, caps and the deny-list. New write routes go into `AUDITED_ROUTES` or `NON_ACTION_ROUTES`.
- **Defaults (decided):**
  - resume flags `--dangerously-skip-permissions`
  - default project `wakecap`
  - Codex automated sessions hidden
  - AGNC optional and last
  - recaps use `claude-haiku-4-5` for automatic runs and `claude-sonnet-5` on demand
  - Slack and Linear act **as the user**
- **Fixtures** are made up and redacted, and `pnpm check:fixtures` must pass.
- **Commits** follow Conventional Commits with a scope, one per task at minimum.
