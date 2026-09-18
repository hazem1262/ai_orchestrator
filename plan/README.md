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
| 1 | [History, search & resume](phase-1-history-search-resume.md) | M1 | F3, F4 (resume/fork/adopt), F13, F2 (basic) | 20 | ☐ |
| 2 | [Live board, inbox & archive](phase-2-live-board-inbox-archive.md) | M2 | F1, F15, F4 (launch, templates, presets), F5 | 20 | ☐ |
| 3 | [Session detail, safety & audit](phase-3-session-detail-safety-audit.md) | M3 | F2 (full), F9, F24, F8 | 19 | ☐ |
| 4 | [Worktrees, review & merge](phase-4-worktrees-review-merge.md) | M4 | F17, F18, F11 (GitHub), plan approval | 22 | ☐ |
| 5 | [Streams, analytics, limits, recaps, goals](phase-5-streams-analytics-limits-recaps-goals.md) | M5 | F6, F7, F19, F14, F16, F10 | 22 | ☐ |
| 6 | [Linear, Slack & remote](phase-6-linear-slack-remote.md) | M6 | F11 (Linear, Slack), F22, spike S9 | 22 | ☐ |
| 7 | [Automations, compare, supervisor](phase-7-automations-compare-supervisor.md) | M7 | F20, F21, F23, AGNC (S4), Tauri, MCP server, F12 picks | 25 | ☐ |

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
