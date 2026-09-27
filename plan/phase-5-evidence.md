# Phase 5 — M5 exit check evidence

Checked on **2026-09-27** (local, UTC+3) on branch `phase/5-streams-analytics-limits-recaps-goals`.
The phase is the 22 task commits `b859d12`…`7b973b7`, the exit-fix commits `5aee4e7`, `b2e4976`,
`96d71bf`, `83701db`, `5fcb119`, and the Task 22 docs commit that adds this file.

Evidence is fixture-only:
- **Unit suite:** `pnpm run test`, which includes `apps/daemon/test/p5-daemon.test.ts` (a real
  `createDaemon` on temp copies of `fixtures/`, every Phase 5 route, the ledger backfill).
- **Playwright:** `pnpm --filter @orc/web e2e` against `apps/daemon/test/e2e-server.ts`, including
  `apps/web/e2e/streams-analytics.spec.ts`, and `pnpm --filter @orc/web e2e:m4`.
- **Screenshots** taken against the fixture e2e daemon, in [`evidence/phase-5/`](evidence/phase-5/).

Safety rules held for every run: temp homes only (`ORC_HOME`, `CLAUDE_HOME`, `CODEX_HOME` and, from
`b2e4976`, `WSTACK_HOME`), `ANTHROPIC_API_KEY` removed from the environment, recaps at their default
`enabled: false` or run through a fake engine / fake `claude -p` (`apps/daemon/test/bin/fake-claude-print`),
`github.enabled: false`, and no server left listening on 4399 or 4418 afterwards. The real
`~/.claude/settings.json` mtime was `1790506528` before and after the gates.

Nothing ran against the real `~/.claude`, `~/.codex`, `~/.wstack`, a real recap engine or real
GitHub. The plan's Step 3 asked for checks "on the real home"; those were **not** run (see
*Not confirmed*).

| # | Criterion (`docs/05-roadmap.md` M5) | Verdict |
|---|---|---|
| 1 | **Exit:** "What happened on SAF-xxxx, what did it cost, and what's next" is answered on one screen | ✅ verified on fixtures (e2e + screenshot); not on a real ticket |
| 2 | **Exit:** quota warnings arrive before the limit is hit | ◐ unit only (warn at `warnPct` 0.8 and on projected exhaustion within 1 h); no live quota data |
| 3 | F6 Work streams: detection, stream view, stages, kanban | ✅ verified (unit + e2e + screenshots); after fix `5aee4e7` streams exist right after boot |
| 4 | F7 Usage analytics and weekly digest | ✅ verified (unit + e2e + screenshot); digest by unit only |
| 5 | F19 Limits & budgets: quota bars, burn rate, context fill, budgets, concurrency cap | ◐ bars, budgets and context fill verified (unit + e2e); official quota source unverified against real data |
| 6 | F14 LLM recaps | ◐ verified with fake engines only; real `claude -p` and Anthropic API never called |
| 7 | F16 Goals, handoffs, reminders, "resume fresh with handoff" | ✅ verified (unit + screenshot); resume-fresh by unit only |
| 8 | F10 Real-time bridge: hook ingest and statusline | ◐ unit + fixture-home install; the installer never ran on the real `~/.claude`, latency not measured |
| 9 | Read-only rule toward tool data | ✅ verified (p5-daemon test; real `settings.json` mtime unchanged) |
| 10 | Suite green | ✅ lint, typecheck, 1714 unit tests, fixtures clean, 11/11 Playwright, 1/1 M4 Playwright |

---

## 1 — One screen answers what happened, what it cost and what's next

- Commits: `b88175d` (stream service, `/api/streams`), `7b973b7` (`/streams`, `/streams/$ticket`),
  `5aee4e7` (streams built once the initial index completes).
- E2E: `streams-analytics.spec.ts` › "the stream detail page answers what happened, what it cost and
  what is next" opens `SAF-1787` from the list and asserts `Stage`, `Timeline`, `Goal` and
  `Next steps`. It passes without clicking Refresh; with the `index.initialComplete` emit removed
  from `apps/daemon/src/main.ts` the same spec **skips** ("fixtures produced no SAF-1787 stream").
- Screenshot: [`stream-detail-saf-1787.png`](evidence/phase-5/stream-detail-saf-1787.png) — stage
  bar (`Implementing`), `$0.00 no budget set`, goal, "What's next", linked sessions
  `claude:s-prlink` and `codex:c0dex000-…`, timeline.
- **Observed:** the fixture stream shows `$0.00` and `0 PRs` (fixture sessions carry no `costUsd`
  on the list item, and the PR poller is off). Cost with a budget and PR checks are covered by
  `apps/daemon/src/services/streams/streams.test.ts` and `StreamDetailPage.test.tsx`.
- **Not verified:** a real Wakecap ticket.

## 2 — Quota warnings before the limit

- Commits: `6115564` (blocks, burn rate, projection), `573d248` (meter, quota and budget alerts).
- Unit: `apps/daemon/src/services/usage/meter.test.ts` › "raises and resolves quota alerts from plan
  limits", "uses official samples only when configured"; `quotaAlertKeys` raises the block alert at
  `pctOfLimit >= warnPct` (default 0.8) **or** when projected exhaustion is within 60 minutes, and a
  week alert at `warnPct`. Items are `kind: 'budget'` with scope `{ domain: 'quota', id: 'block' | 'week' }`.
- **Not verified:** a live warning. The plan's check (set `limits.blockTokenLimit` just above real
  5-hour usage on the real home) was not run.

## 3 — F6 Work streams

- Commits: `605e544` (signals, backmerge, stages), `b88175d`, `7b973b7`, `5aee4e7`.
- Unit: `packages/core/src/derive/streams.test.ts` (prompt, branch, PR title/body, plan file,
  wstack env, worktree signals; `backmerge/<TICKET>-…` detection; `/releaseit` → released),
  `streams.test.ts` (every source, manual link/unlink across refreshes, `workStreams: false`
  projects skipped, rebuild on `index.initialComplete`), `StreamsPage.test.tsx`, `stages.test.ts`.
- E2E: list → kanban → `Planned` region visible.
- Screenshots: [`streams-list.png`](evidence/phase-5/streams-list.png),
  [`streams-kanban.png`](evidence/phase-5/streams-kanban.png) (retaken after `b2e4976`, so no
  real `~/.wstack` workflow appears).

## 4 — F7 Analytics and digest

- Commits: `2aa83eb` (ledger), `60dba8c` (aggregations, digest, `/api/analytics`), `3032ffe` (page).
- Unit: `packages/core/src/derive/analytics.test.ts`, `digest.test.ts`,
  `apps/daemon/src/services/analytics/analytics.test.ts`, `http/routes/analytics.test.ts`,
  `AnalyticsPage.test.tsx`. `p5-daemon.test.ts` backfills the ledger from the fixtures and gets a
  `claude` row from `/api/analytics/cost?groupBy=source`.
- E2E: `/analytics` shows the `Quota` region, its `estimated` badge and the `Cost over time` chart.
- Screenshot: [`analytics-page.png`](evidence/phase-5/analytics-page.png).
- **Not verified by eye:** "Generate weekly digest" output.

## 5 — F19 Limits & budgets

- Commits: `6115564`, `2aa83eb`, `85b41d0` (budgets), `573d248`, `e6e7922` (live context fill uses
  the configured window), `e3dc6b3` (settings).
- Unit: `budgets.test.ts` (periods, table over config, warn/over once, stale resolve),
  `meter.test.ts` (80% budget alert, ticket budgets, context fill, concurrency, period rollover
  after a restart), `QuotaBars.test.tsx`, `LimitsSettings.test.tsx`.
- Screenshots: [`shell-quota-bars.png`](evidence/phase-5/shell-quota-bars.png) (`no active block`,
  `7d $0.00`, `estimated`), [`settings-limits.png`](evidence/phase-5/settings-limits.png).
- **Not verified:** `limits.quotaSource` defaults to `official` (spike S7), fed by
  `POST /api/usage/official` from the statusline script; no real `rate_limits` sample was ever
  ingested, so the fixture runs show the estimate path.

## 6 — F14 Recaps

- Commits: `86614d8` (redacted digest, prompts), `8641a65` (engines + fake CLI), `ab3bdc9` (service,
  cache, budget, triggers).
- Unit: `packages/core/src/recap/digest.test.ts` › "builds a compact, redacted digest without tool
  outputs or inputs"; `engines.test.ts` (both engines against fakes); `recap.test.ts` (cache,
  on-demand model, budget refusal with an inbox item, `on_idle`, daily); `RecapPanel.test.tsx`,
  `RecapSettings.test.tsx`.
- Screenshot: [`settings-recaps.png`](evidence/phase-5/settings-recaps.png).
- **Not verified:** a real recap. `claude -p` and the Anthropic API were never called; recaps are
  off by default.

## 7 — F16 Goals, handoffs, reminders

- Commits: `92ba31a` (goals, reminders), `6a3bee2` (handoffs, resume-fresh), `0c0ad77` (work panel),
  `96d71bf` (export ZIP carries the latest handoff, redacted).
- Unit: `goals.test.ts` (PR merged → complete, waiting > 30 min → blocked), `reminders.test.ts`
  (fires through the scheduler after a restart; only to owned sessions; deny-list), `handoff.test.ts`,
  `routes/handoffs.test.ts`, `apps/daemon/test/export.test.ts` › "includes the session's latest
  handoff, redacted", `GoalEditor.test.tsx`, `HandoffPanel.test.tsx`, `ReminderPanel.test.tsx`.
- Screenshot: [`session-work-panel.png`](evidence/phase-5/session-work-panel.png) — goal
  `Blocked` with a reason, a pending reminder, recap spend `$0.00 of $20.00 this month`.
- **Not verified:** "Resume fresh with handoff" in the browser; a reminder surviving a real daemon
  restart outside the unit test.

## 8 — F10 Bridge

- Commits: `7d46ec5` (all hook events, current tool, stale hook expiry), `d3d5df8` (installer,
  backup, audit, `orc-statusline`).
- Unit: `packages/core/src/derive/hooks.test.ts`, `routes/hooks-ingest.test.ts`,
  `services/hooks/install.test.ts` (idempotent merge, foreign hooks kept, backup, invalid JSON
  refused), `routes/hooks-install.test.ts`, `bin/orc-statusline.test.ts`, `BridgeSettings.test.tsx`.
  `p5-daemon.test.ts` checks `GET /api/hooks/install` writes nothing.
- The Task 20 run installed hooks into a **fixture** `CLAUDE_HOME` only. Its screenshots are not
  copied here because they show the repo's absolute path under the user's home directory.
- **Not verified:** install on the real `~/.claude/settings.json`, status latency, and the
  statusline inside a real `claude`.

## 9 — Read-only rule

- `p5-daemon.test.ts`: the fixture `CLAUDE_HOME/settings.json` existence is unchanged after
  `GET /api/hooks/install`.
- `stat -f %m ~/.claude/settings.json` → `1790506528` before Part A and after both e2e gates.
- From `b2e4976`, tests and both e2e daemons read wstack workflows from an empty temp
  `WSTACK_HOME`; before it they read the real `~/.wstack/workflows` (read-only).

## 10 — Suite green

Branch at `5fcb119`, each gate under `timeout 900`, `ANTHROPIC_API_KEY` unset:

```
$ pnpm run lint            → 0   Checked 687 files in 214ms. No fixes applied. Found 1 info.
$ pnpm run typecheck       → 0   packages/api-contract, apps/daemon, apps/web: Done
$ pnpm run test            → 0   Test Files 206 passed (206) · Tests 1714 passed (1714)
$ pnpm run check:fixtures  → 0   fixtures clean
$ pnpm --filter @orc/web e2e     → 0   11 passed (13.0s)
$ pnpm --filter @orc/web e2e:m4  → 0   1 passed (19.5s)
```

The lint info is biome asking for `biome migrate` on its own config. The web build still warns
about chunks over 500 kB.

## Per-feature summary

| Feature | Commits | Tests | E2E / screenshot | Unconfirmed |
|---|---|---|---|---|
| F6 Work streams | `605e544`, `b88175d`, `7b973b7`, `5aee4e7` | core `streams.test.ts`, daemon `streams.test.ts`, `routes/streams.test.ts`, web `StreamsPage`/`StreamDetailPage`/`stages` | `streams-analytics.spec.ts`; `streams-list.png`, `streams-kanban.png`, `stream-detail-saf-1787.png` | real tickets, PR data |
| F7 Analytics | `2aa83eb`, `60dba8c`, `3032ffe` | core `analytics`/`digest`, daemon `analytics.test.ts`, `routes/analytics.test.ts`, `AnalyticsPage.test.tsx` | spec test 1; `analytics-page.png` | weekly digest by eye |
| F19 Limits | `6115564`, `85b41d0`, `573d248`, `e6e7922`, `e3dc6b3` | `quota.test.ts`, `budgets.test.ts`, `meter.test.ts`, `QuotaBars`, `LimitsSettings` | `shell-quota-bars.png`, `settings-limits.png` | official quota source on real data; live warning |
| F14 Recaps | `86614d8`, `8641a65`, `ab3bdc9`, `e3dc6b3` | `recap/digest.test.ts`, `engines.test.ts`, `recap.test.ts`, `routes/recaps.test.ts` | `settings-recaps.png` | real engines never called |
| F16 Goals & handoffs | `92ba31a`, `6a3bee2`, `0c0ad77`, `96d71bf` | `goals`, `reminders`, `handoff`, `routes/handoffs`, `goals-reminders`, `export.test.ts` | `session-work-panel.png` | resume-fresh in the browser |
| F10 Bridge | `7d46ec5`, `d3d5df8`, `e3dc6b3` | `hooks.test.ts`, `hooks-ingest`, `install.test.ts`, `hooks-install`, `orc-statusline.test.ts` | — | real-home install, latency, real statusline |

## Deviations from the Phase 5 plan text

1. **Exit check location:** Step 3's real-home checks were replaced by fixture runs; nothing ran on
   the real `~/.claude`, `~/.codex` or `~/.wstack`.
2. **`p5-daemon.test.ts`:** the plan's version called `createDaemon({ port: 0 })`; the shipped test
   uses `createDaemon({ paths, log, launchExternal, webDist: null })` then `start({ port: 0, watch:
   false })`, removes `ANTHROPIC_API_KEY`, and waits for `initial index complete` before the backfill.
3. **`streams-analytics.spec.ts`:** switches to the List view before looking for `SAF-1787`, uses
   `getByLabel('Goal', { exact: true })`, and scopes the `estimated` check to the `Quota` region
   (`5fcb119`: the Spend panel carries its own badge once earlier specs launched sessions).
4. **Inbox keys:** budget, quota, recap-budget and reminder items use `{ kind, scope, facet }`:
   `budget` with `{ project | ticket | global }` and facet `<period>:<periodStart>:<warn|over>`;
   quota as `budget` with `{ domain: 'quota', id: 'block' | 'week' }`; recap budget as `budget`
   with `{ domain: 'recap-budget', id }`; reminders as `reminder` with `{ domain: 'reminder', id }`.
5. **Audit:** `POST /api/handoffs/:id/resume-fresh` is audited as `session.launch` (target
   `handoff:<id>`); `POST /api/hooks/install` as `hook.install`; the other Phase 5 writes are in
   `NON_ACTION_ROUTES` with a reason each.
6. **Redaction:** every Phase 5 route that returns transcript-derived text answers through
   `redactedJson`.
7. **Dependencies:** `@anthropic-ai/sdk ^0.128.0` and `croner ^10.0.1` (daemon),
   `@testing-library/jest-dom ^7.0.1` (web dev).
8. **Client:** Phase 5 methods live in `packages/api-contract/src/client-p5.ts`
   (`p5ClientMethods`); `analyticsCost` requires `groupBy`.
9. **Hook installer:** `services/hooks/install.ts` exports `shellQuote(s)` for single-argument
   quoting, not the `quoteArg` name §13 suggested.
10. **Bus:** `index.initialComplete` (daemon-internal) was added in `5aee4e7`.

## Findings raised by this check

1. `/api/streams` was empty right after boot: the start-up refresh ran before the first index scan
   and the next refresh was 2 minutes away. Fixed in `5aee4e7`.
2. Tests and the fixture e2e daemon read the real `~/.wstack/workflows`. Fixed in `b2e4976`
   (daemon vitest setup file, `makeTempHomes().env.WSTACK_HOME`, the M4 seed).
3. The export ZIP never carried a handoff (`handoffs: undefined`). Fixed in `96d71bf`.
4. The fixture e2e server used a fixed `$TMPDIR/orc-e2e` root and was stopped with `SIGKILL`, so two
   runs could delete each other's homes and every run leaked its root. Fixed in `83701db`: one
   `mkdtemp` root per run via `ORC_E2E_ROOT`/`ORC_E2E_WORK`, and `gracefulShutdown: SIGTERM`.

## Not confirmed

- Real recap engines (`claude -p`, Anthropic API) were never called.
- The hook installer never ran on the real `~/.claude/settings.json`; hook status latency not measured.
- The official quota source (`rate_limits.*` from the statusline stdin) is unverified against real data.
- A quota warning on real usage; a real Wakecap ticket's stream; the weekly digest by eye;
  "Resume fresh with handoff" in the browser; the statusline inside a real `claude` session.
