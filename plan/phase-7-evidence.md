# Phase 7 — M7 exit check evidence

Checked on **2026-09-28** (local, UTC+3) on branch `phase/7-automations-compare-supervisor`.
The phase is the 24 task commits `b1d5899`…`9e02e65` for Tasks 1–24 (S4 spike commit `90385d3`
included), the two fix commits `576598b` and `f0c142c`, and the Task 25 docs commit that adds this
file and `apps/daemon/test/p7/m7-exit.test.ts`.

Evidence is automated only:
- **Unit suite:** `pnpm run test`, which includes the exit guard
  `apps/daemon/test/p7/m7-exit.test.ts` (8 tests), the 27 other files in `apps/daemon/test/p7/`,
  `apps/mcp/src/*.test.ts`, the Phase 7 web tests under `apps/web/src/features/{automations,compare,supervisor,agnc}/`
  and the `createDaemon` tests (`p2-daemon.test.ts`, `p5-daemon.test.ts`, `server.test.ts`), which now
  pass `phase7: offlinePhase7()`.
- **Playwright:** not re-run for this exit check. Phase 7 added no Playwright spec.

Safety rules held for every run: no test runs a real `claude` or `codex`, and none touches AGNC,
Linear, Slack, GitHub or the Keychain. Every test daemon passes `phase7: offlinePhase7()`
(`apps/daemon/test/fakes/phase7.ts`): a headless runner that writes one line and never spawns
`claude`, no `git diff`, a classifier that always escalates, and AGNC on the in-memory fake server
(`fakes/agnc-server.ts`) with the memory secret store. Every gate ran under `timeout` with
`ANTHROPIC_API_KEY` unset. Nothing wrote to the real `~/.claude`, `~/.codex` or `~/.orchestrator`.

**Nothing in this phase has been checked against a real `claude -p`, a real `codex`, AGNC, the
real Keychain, a real MCP client or a built Tauri app.** Every row below that needs one says
**manual — not yet run**.

| # | Criterion (`docs/05-roadmap.md` M7) | Verdict |
|---|---|---|
| 1 | Automations (F20): scheduler, GitHub/Linear/Slack triggers, suggested tasks, run history | ◐ unit only (fake runner, fake scheduler, bus events); manual — not yet run |
| 2 | Compare mode (F21) | ◐ unit only (fake launcher and worktrees); manual — not yet run |
| 3 | Supervisor (F23): opt-in, rules first, audited | ◐ unit only (fake classifier, fake PTY); manual — not yet run |
| 4 | AGNC (optional): only if spike S4 succeeds | ◐ S4 decision **GO (unconfirmed)** from read-only checks; built behind `agnc.enabled: false`; unit only (fake MCP server); live checks a–f manual — not yet run |
| 5 | Packaging: Tauri 2 shell with tray (waiting count, quota) and hotkey | ✗ code only; Rust is not installed, so the shell has never been built or run; manual — not yet run |
| 6 | Orchestrator MCP server: Claude/Codex can query, search and resume sessions | ◐ unit only (`apps/mcp/src/tools.test.ts`); registration with a real client manual — not yet run |
| 7 | F12 items, as needed | stdout notification bridge and the desktop shell (Tasks 23–24); no other F12 item was taken |
| 8 | **Exit:** each item can be turned off | ✅ `m7-exit.test.ts` › "M7 exit: everything can be turned off" (3 tests) + `phase7-wiring.test.ts` |
| 9 | **Exit:** budget and deny-list are enforced | ✅ `m7-exit.test.ts` › "M7 exit: budgets and the deny-list are enforced" (3 tests) + the service tests below |
| 10 | **Exit:** every action is audited | ✅ `m7-exit.test.ts` › "M7 exit: every action is audited" (2 tests); the `/audit` screenshot filtered to `automation` and `supervisor` is manual — not yet run |
| 11 | Every automated check is green | ✅ lint, typecheck, 2145 unit tests in 276 files, fixtures clean (builds and Playwright not re-run here) |

---

## Commits

| Task | Commit | What |
|---|---|---|
| 1 | `b1d5899` | config blocks, git and spawn helpers, `p7-guard.ts`, test fakes |
| 2 | `5e5d063` | automation tables, repos, schemas, API client |
| 3 | `1a1966b` | guardrails and the headless stream-json runner |
| 4 | `0197931` | `AutomationService`: guards, queue, worktree, inbox results |
| 5 | `0d7a3c4` | plan approval, reject and rerun |
| 6 | `162485e` | cron automations on the persisted P5 scheduler |
| 7 | `ab4600b` | GitHub, Linear and Slack triggers (on the Phase 6 bus events) |
| 8 | `169b75e` | suggested tasks: Linear backlog and new TODO/FIXME lines |
| 9 | `fd4052c` | automation routes, `createPhase7` wiring, `offlinePhase7()` |
| 10 | `e3d0b5f`, fix `576598b` | `/automations` page; fix: Run now passes template vars |
| 11 | `6806623` | compare groups, launch across N worktrees, cost estimate |
| 12 | `5fee84b` | compare view, pick winner, archive losers, launch delegation |
| 13 | `68606a5` | compare launch section and `/compare/$groupId` page |
| 14 | `a644d1f` | supervisor rules, decisions and targets tables, schemas, client |
| 15 | `7d8aac0` | pending-question extraction and the rules engine |
| 16 | `d227e0e` | Haiku classifier through `claude -p` with strict JSON parsing |
| 17 | `a0d6874` | supervisor service: caps, budget, quiet hours, answer or escalate |
| 18 | `5c1e226` | supervisor routes, settings UI, decisions log |
| 19 | `90385d3` | spike S4: read-only AGNC MCP/OAuth checks and decision |
| 20 | `c6ef085` | AGNC MCP connector, OAuth storage, remote session collector |
| 21 | `a3bae0d`, fix `f0c142c` | AGNC routes, composer, handoff, UI; fix: hide local-only actions on AGNC sessions |
| 22 | `dce485e` | `orc-mcp` stdio server |
| 23 | `667d2d2` | stdout notification bridge, sidecar packaging, `redact()` tightening |
| 24 | `9e02e65` | Tauri 2 shell: tray, hotkey, notifications, daemon sidecar |
| 25 | this commit | exit guard test, evidence, contract merge, status |

## M7 exit guard (`apps/daemon/test/p7/m7-exit.test.ts`)

The plan's test, with two setup changes to match the shipped code:
1. The route check fills `:source` with `claude` (the same fill as `apps/daemon/test/audit.coverage.test.ts`). The plan's fill replaced every placeholder with `x`, which the `(claude|codex|agnc)` pattern of `POST /api/supervisor/evaluate/:source/:id` rejects, so the first run reported that audited route as missing. It was a test bug, not a gap.
2. The route check also covers `/api/connectors/agnc`, and asserts it found more than 20 Phase 7 write routes, so it cannot pass on an empty list.

No product code changed. After those two changes all 8 tests pass:

```
$ env -u ANTHROPIC_API_KEY timeout 300 pnpm --filter @orc/daemon exec vitest run test/p7/m7-exit.test.ts
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

| describe › it | What it proves |
|---|---|
| everything can be turned off › ships with automations, the supervisor and AGNC off by default | `automations.enabled`, `automations.suggestions.enabled`, `supervisor.enabled`, `agnc.enabled` default to `false` |
| › runs nothing while the master switches are off | `runNow` → `denied`, runner never called; supervisor `enabledFor` false, nothing sent to the PTY |
| › turns a single automation and a single session off again | per-automation `setEnabled(false)`; a session target overrides a project target |
| budgets and the deny-list are enforced › refuses automations over budget and deny-listed prompts, and compare over budget | `over_budget` run status, compare `409 over_budget`, `denied` for a deploy prompt |
| › never allows merge, deploy or prod tools in an automation run | `AUTOMATION_DISALLOWED_TOOLS` has `gh pr merge`, `git push --force`, `kubectl`, `terraform` |
| › escalates instead of answering a deny-listed supervisor question | escalates before the classifier is called |
| every action is audited › records automation, supervisor and compare actions with their actor | `automation.run` actor `automation`, `supervisor.answer` actor `supervisor`, `settings.update`; `ShipService.merge` never called |
| › keeps every phase 7 write route inside the audit coverage rules | every non-GET route under `/api/automations`, `/api/compare`, `/api/supervisor`, `/api/agnc`, `/api/connectors/agnc` matches `AUDITED_ROUTES` or `NON_ACTION_ROUTES` |

## M7-1 Automations (F20)

Automated:
- `apps/daemon/test/p7/automation-service.test.ts` › "runs in a new worktree and reports to inbox and audit", "denies every run while the master switch is off", "denies a template that asks for a deploy", "stops on project budget and on the automation monthly budget", "handles a trigger key only once", "respects the concurrency cap by queueing", "spawns an owned session with restricted tools and finishes when the turn ends".
- `guardrails.test.ts` › "never allows merge, force-push, deploy or prod tools", "checks only the rendered template, not the preamble …"; `never-merge.test.ts` (no merge or ship call in `services/automations`, `services/supervisor` or the two pollers).
- `automation-approval.test.ts` › "denies approval when the plan hits the deny-list", "stops approval when the budget ran out in the meantime".
- `headless.test.ts`, `automation-schedules.test.ts`, `triggers.test.ts`, `trigger-pollers.test.ts`, `suggestions.test.ts`, `automation-routes.test.ts`, `automation-run-now-vars.test.ts`, `phase7-wiring.test.ts`.
- Web: `apps/web/src/features/automations/{AutomationsPage,confirm-flow,run-now-vars}.test.tsx`, `editor-model.test.ts`.

| step | evidence |
|---|---|
| A cron automation fires and a run appears in the `/automations` history (screenshot) | manual — not yet run |
| A real headless `claude -p` run: stream-json key names (`session_id`, `total_cost_usd`, `duration_ms`, `num_turns`, `is_error`, `subtype`, `result`) match what `parseStreamEvents` reads | manual — not yet run (the parser follows the plan's key names; unit tests use made-up lines) |
| GitHub / Linear / Slack events start a matching automation | manual — not yet run |
| Suggestions from a real Linear backlog | manual — not yet run |

## M7-2 Compare mode (F21)

Automated: `compare-launch.test.ts` › "creates one worktree and one session per variant", "records a failed variant and keeps the others", "refuses when over budget"; `compare-decide.test.ts` › "needs a winner first", "stops losing sessions, archives clean worktrees and keeps dirty ones"; `compare-routes.test.ts` › "routes compare launches from /api/sessions/launch"; `apps/daemon/src/http/routes/launch.test.ts`; web `apps/web/src/features/compare/*.test.tsx`, `LaunchDialog.test.tsx`.

| step | evidence |
|---|---|
| `/compare/$groupId` with two variants and a picked winner (screenshot) | manual — not yet run |
| A codex variant with a real `codex`: the task agents reported it may stay in `starting`; not checked | manual — not yet run |

## M7-3 Supervisor (F23)

Automated: `supervisor-service.test.ts` › "answers an allow-listed question with the canned answer and audits it", "escalates when no intent matches, and never sends the model text", "respects the per-session and hourly caps", "stops on the supervisor budget and on the project budget", "does not answer during quiet hours", "refuses sessions the app does not own, and dry-runs when disabled", "prefers the session switch over the project switch"; `supervisor-rules.test.ts` › "keeps its own deny list in sync with the shared one"; `supervisor-classifier.test.ts`, `supervisor-routes.test.ts`, `supervisor-repo.test.ts`; web `SupervisorSettings.test.tsx`.

| step | evidence |
|---|---|
| Decisions log with one answer and one escalation (screenshot) | manual — not yet run |
| The real Haiku classifier through `claude -p` | manual — not yet run |

## M7-4 AGNC (spike S4)

Automated: `agnc-connector.test.ts` › "starts OAuth from beginAuth() when connect succeeds but the first tool request is unauthorised", "reports "already authorised" from beginAuth() only when an authenticated request succeeds"; `agnc-callback.test.ts` › "rejects a wrong or missing state before the code reaches AGNC", "keeps the host check and the token check on every other /oauth path and method", "redacts the prompt before it leaves, and keeps the text out of the audit log"; `agnc-routes.test.ts`; web `AgncSessionPanel.test.tsx`, `agnc-confirm.test.tsx`, `SessionHeader.agnc.test.tsx`.

From [`spikes/S4.md`](spikes/S4.md) → *Manual steps*. Each is **manual — not yet run**:

| # | Check | If it fails |
|---|---|---|
| a | Dynamic client registration works | NO-GO |
| b | `http://127.0.0.1:<port>/…` accepted as a redirect URI | try `localhost`; NO-GO if no loopback URI works |
| c | `agnc_list_sessions { scope: 'mine' }` works | NO-GO for the collector |
| d | `agnc_get_session` / `agnc_list_messages` / `agnc_list_events` work; key spellings match `normalize.ts` | add the observed spellings |
| e | The token survives a restart (refresh, no browser) | NO-GO |
| f | Round-trip latency for `agnc_list_sessions` | — |
| — | Where the first 401 comes from (`tools/list` or `tools/call`) | the connector handles both |

## M7-5 Orchestrator MCP server

Automated: `apps/mcp/src/tools.test.ts` › "exposes the six read tools", "lists only attention inbox kinds for list_waiting", "returns a resume command, and only launches when asked", "reports daemon errors as tool errors instead of throwing", "quotes cwds safely in resume commands"; `apps/mcp/src/config.test.ts`.

| step | evidence |
|---|---|
| `pnpm --filter @orc/mcp build`, then `claude mcp add --scope user …` | manual — not yet run |
| `claude -p "Use the orchestrator MCP server: which of my sessions are waiting?" --model claude-haiku-4-5 --max-budget-usd 0.05` | manual — not yet run |
| `codex mcp --help` syntax checked; Codex lists and calls the tools | manual — not yet run |

## M7-6 Desktop shell (Tasks 23–24)

Automated: `apps/daemon/test/p7/stdout-bridge.test.ts` › "builds a redacted, human-readable line", "writes one prefixed JSON line per notification". The Rust code has no automated run: Rust is not installed.

| step | evidence |
|---|---|
| Install Rust (`rustup`) | manual — not yet run |
| `node scripts/build-sidecar.mjs` (needs `rustc` for the target triple) | manual — not yet run |
| Packaged daemon check: `resources/daemon` starts with `orc-node` and answers `/api/health` | manual — not yet run |
| `pnpm --filter @orc/desktop test:rust` | manual — not yet run |
| `pnpm --filter @orc/desktop exec tauri icon ../web/public/icons/pwa-512x512.png` | manual — not yet run |
| `dev:app` (a) window opens on the UI, logged in | manual — not yet run |
| `dev:app` (b) tray shows `N⏳` and the block percentage, updates within about 5 s | manual — not yet run |
| `dev:app` (c) ⌘⇧O opens or focuses the window | manual — not yet run |
| `dev:app` (d) an inbox item raises a native notification with the right title | manual — not yet run |
| `dev:app` (e) closing the window keeps the tray; Quit stops the daemon (`pgrep -f orc-node` empty) | manual — not yet run |
| `dev:app` (f) with a dev daemon running, no second daemon starts (`pgrep -fc 'dist/main.js'` = 1) | manual — not yet run |
| `pnpm --filter @orc/desktop build:app` | manual — not yet run |

## Decisions for the user

- **`ANTHROPIC_API_KEY` in automation runs.** `runHeadless` (`services/automations/headless.ts`) passes `env: { ...o.env, ORC_AUTOMATION: '1' }` to execa, which extends the daemon's environment. If the daemon runs with `ANTHROPIC_API_KEY` set, every headless automation run inherits it, and `claude -p` may then bill that API key instead of the Claude subscription (the supervisor classifier's `execa` call also inherits the parent environment). Whether to strip it from the child environment is your call; nothing was changed.

## Suite green

Branch at `9e02e65` plus the Task 25 changes, each gate under `timeout`, `ANTHROPIC_API_KEY` unset:

```
$ pnpm run lint            → 0   Checked 917 files. No fixes applied. Found 1 info.
$ pnpm run typecheck       → 0   packages/api-contract, apps/daemon, apps/web: Done
$ pnpm run test            → 0   Test Files 276 passed (276) · Tests 2145 passed (2145)
$ pnpm run check:fixtures  → 0   fixtures clean
```

The first lint run failed only on the import order of the new `m7-exit.test.ts`; `biome check --write` fixed it. Not re-run for this check: `pnpm --filter @orc/web build`, `pnpm --filter @orc/daemon build`, `pnpm --filter @orc/mcp build`, `pnpm --filter @orc/web e2e`, `pnpm --filter @orc/web e2e:m4`. Test count over time: 1885 at the Phase 6 exit → 2137 before Task 25 → 2145 at Phase 7.

## Deviations from the Phase 7 plan text

1. **Run-now vars (fix `576598b`).** `POST /api/automations/:id/run` ignored its body and always ran with `vars: {}`, so a template with variables could never run from "Run now". It now takes `AutomationRunRequest { vars? }` (known template var names, string values; anything else is `400 validation_failed`), `automationsRun(id, vars?)` sends it, and the page asks for the vars in a dialog first.
2. **AGNC session header (fix `f0c142c`).** AGNC sessions have no local transcript, so Resume, Fork, Pop out, the share actions and the phone reply composer did nothing there. One `isRemoteSession` predicate hides them; the AGNC panel's own composer is unchanged.
3. **S4 finding → AGNC connector auth.** AGNC answers `initialize` with no token, so the plan's `getClient()` would have treated a bare `connect()` as authorised and `beginAuth()` would never start OAuth. The connector sends `listTools()` after `connect()` before it marks the client live, and an `UnauthorizedError` from a later `callTool` also starts the flow. The fake AGNC server allows `initialize` without a token so the tests cover this. `GET /oauth/agnc/callback` is in `PUBLIC_API_PATHS` (GET only, `state` checked before the code reaches AGNC).
4. **Audit registration.** Every Phase 7 write route is in `AUDITED_ROUTES` with `recordedBy: 'service'`, not in `NON_ACTION_ROUTES` as the plan's Global Constraints suggest for service-audited routes. The service records the entry with the real actor and params; the middleware records only a request that fails before the service does. Only `POST /api/automations/suggestions/refresh` and `…/:id/dismiss` are in `NON_ACTION_ROUTES`.
5. **`redact()` tightening (`667d2d2`).** An unquoted `KEY=value` secret value now stops at `)`, `]`, `}`, `'` and `"` as well as whitespace, `&` and `;`, so `(token=abc)` and `{"env":"API_KEY=abc"}` keep their closing punctuation (`packages/core/src/redact/redact.test.ts`).
6. **Pollers reused from Phase 6.** Task 7 wrote no pollers. `services/automations/dispatcher.ts` subscribes to P4's `pr.changed` and P6's `linear.issueChanged` and `slack.mention` bus events, and Phase 7 adds no `BusEvent` variant.
7. **Compare archive safety.** `archiveLosers` needs a picked winner (`409 invalid_state`), kills running loser sessions (each audited as `session.kill`), and archives only the worktrees the group created, through `worktrees.archiveAs`. Dirty and external worktrees are refused and reported per variant, and `git worktree remove` keeps the branch, so unpushed commits are never lost. A second call retries only the kept ones.
8. **Supervisor deny re-check.** Besides checking the question before the classifier, the supervisor re-checks the canned answer against `ctx.denyList` and `SUPERVISOR_DENY_PATTERNS` right before sending it, and escalates if either matches.
9. **Wiring.** `createPhase7(ctx, o)` (`apps/daemon/src/phase7.ts`) is the only wiring point, with no `register` hook; routes are in `registerAllRoutes` and answer `409 not_enabled` while their service is unset. `LaunchResponse` is a union (`{ ptyId, sessionId } | { compareGroupId }`).
10. **Dependencies.** Installed: `@modelcontextprotocol/sdk` 1.30.1, `@tauri-apps/cli` 2.12.0 (range `^2.11.4`), `tsup` 8.5.1, `zod` 4.6.5. No Rust crate version is resolved (no Rust toolchain, no `Cargo.lock`).

## Open follow-ups

- `apps/web/e2e/session-detail-conductor.spec.ts:62` ("palette jumps to the session and every app action is in the audit log") is flaky.
- `apps/web/e2e/live-inbox.spec.ts:37` sees an inbox item leaked from `history.spec.ts` (shared e2e daemon state; carried).
- `apps/web/src/features/worktrees/WorktreesPage.test.tsx` › "archives an external worktree only after both confirmations" is flaky (carried).
- Settings panels other than Remote overflow the viewport at phone width (carried; the new Automations and Supervisor settings were not checked at phone width).
- Under heavy machine load, Vitest workers can hit the worker start timeout and fail a file that passes on rerun; reported by the task agents, not seen in this exit run.
- Every manual check above: S4 a–f, real `claude -p` stream-json keys, the `ANTHROPIC_API_KEY` decision, `orc-mcp` registration with Claude and Codex, the codex compare variant, and the whole desktop build and run.

The exit run's full suite passed on the first try, so none of the flaky tests showed up.
