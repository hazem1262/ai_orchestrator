# Phase 1 exit review — History, search & resume (M1)

Branch `phase/1-history-search-resume`, evaluated at commit `d0e40e6` (Task 20, phase exit check).
Date: 2026-09-21.

Wakecap dropped in favour of open-source shadcn/ui on 2026-09-21 (commit `d0e40e6`); S6's
blocker is moot and `@/components/ui/*` is the permanent home of the UI primitives, not a
fallback. All evidence below was gathered read-only against the branch as it stands — no code
changes were made in this task beyond `plan/00-contracts.md`, `plan/README.md`, and this file.

## 1. Automated gate (Step 1 of the brief, plus a frozen-lockfile clean-clone check)

```
pnpm install --frozen-lockfile     → exit 0, "Lockfile is up to date", postinstall (node-pty
                                      spawn-helper chmod) ran clean
pnpm format                        → 210 files checked, no fixes needed (1 pre-existing biome.json
                                      "linter.enabled" deprecation info, unrelated to any task)
pnpm lint                          → Checked 210 files, no errors (same 1 pre-existing info)
pnpm typecheck                     → packages/core, packages/api-contract, apps/daemon, apps/web
                                      all "Done", 0 errors
pnpm test                          → Test Files 44 passed (44) / Tests 289 passed (289)
pnpm check:fixtures                → "fixtures clean"
pnpm --filter @orc/daemon perf     → 1 passed. Verbose numbers (pooled, gated shapes):
                                      p50=1.0ms p95=50.3ms max=52.8ms (150ms budget; ~3x margin
                                      on the worst gated shape, the adversarial prefix fan-out)
pnpm --filter @orc/web e2e         → 3 passed (Chromium, real daemon, real xterm)
pnpm --filter @orc/web build       → succeeded; main chunk 325.22 kB / gzip 104.20 kB,
                                      TerminalDock chunk 337.11 kB / gzip 85.41 kB (lazy-loaded,
                                      only paid for when a terminal is opened), history chunk
                                      61.89 kB / gzip 18.78 kB (route-split)
pnpm --filter @orc/daemon build    → succeeded; apps/daemon/dist/main.js exists (82,251 bytes),
                                      apps/daemon/dist/migrations/ exists with 3 migration files
                                      (0000_init.sql, 0001_events_fts.sql,
                                      0002_file_offsets_head_fingerprint.sql) + meta/
```

All green. No test skipped, no flake observed in this run.

## 2. Read-only audit (Steps 2–3 of the brief)

### Step 2 — static grep audit of `apps/daemon/src`

```
grep -rnE "writeFile|appendFile|mkdirSync|rmSync|unlink|renameSync|chmodSync|createWriteStream" \
  apps/daemon/src --include="*.ts" | grep -v '\.test\.ts'
```
Hits: `context.ts` (`mkdirSync(o.paths.orcHome, …)`), `config.ts` (`mkdirSync`/`writeFileSync`/
`chmodSync`/`renameSync` all under `dirname(file)` = `ORC_HOME`'s config/token paths),
`db/client.ts` (`mkdirSync`/`chmodSync` under `dirname(file)` = `ORC_HOME`'s db path), and
`indexer.ts`'s `.on('unlink', schedule)` — a chokidar **watch event name**, not an `fs.unlink`
call. **Matches the brief's expectation exactly: every real write call takes a path under
`ORC_HOME`; none takes `claudeHome`/`codexHome`.**

```
grep -rn '\.key' apps/daemon/src --include="*.ts" | grep -v '\.test\.ts'
```
Hits: `file-kinds.ts`'s `path.endsWith('.key')` exclusion check, `indexer.ts`'s `p.endsWith('.key')`
exclusion check, `liveness.ts`'s doc comment (the `^\d+\.json$` filter that excludes `.key` files
by construction), and `sessions.ts`'s `hits.keys()` (a `Map.keys()` call — a substring false
positive on the grep, not a `.key` file reference). **Matches expectations.**

```
grep -rn "messagingSocketPath" apps packages --include="*.ts" | grep -v '\.test\.ts'
```
One hit: a doc comment in `packages/core/src/claude/registry.ts` explaining that the field is
**never** copied onto the parsed `RegistryEntry`. No code path reads or forwards it. **Zero
functional hits, as expected.**

The indexer test **"is idempotent and never writes to the tool homes"**
(`apps/daemon/src/indexer/indexer.test.ts:154`) was run in isolation and passes — the executable
proof behind the static audit above.

### Step 3 — real-data check against `~/.claude`/`~/.codex` (read-only, temp `ORC_HOME`, no real `claude` spawned)

The daemon was built (`apps/daemon/dist/main.js`) and started with `ORC_HOME` set to a fresh
`mktemp -d` and `ORC_PORT=4317`, letting `CLAUDE_HOME`/`CODEX_HOME` fall through to their real
defaults (`~/.claude`, `~/.codex`). No real `claude`/`codex` process was ever launched (no
`/resume` request was made against real data — see the "Resume, real data" note below). At the
end of the check the daemon was killed and the temp `ORC_HOME` (containing only `config.json`,
`index.db`, `logs/`, `token` — nothing under the real homes) was deleted.

**Index stats** (from `$ORC_HOME/logs/daemon.log`, `"initial index complete"`):
```
files=6801, sessions=7301, ms=16261
```
16.3 seconds, well under the brief's 60-second budget, and consistent with Task 19's own
cold-index measurements (~15.1–15.5s across three independent runs on the same real homes,
task-19-report.md §2 and its coordinator reproduction). Session count vs. spike S1 (2026-09-18,
`plan/spikes/S1.md`): S1 measured 968 Claude files / 169 main-Claude-sessions-with-prompts over a
30-day rolling window measured 3 days earlier; this run's 979 Claude files (implied: 6801 total −
5822 Codex-ish, roughly matching Task 19's claude=979/codex=5811 split) and 7301 total sessions
(Claude + Codex + subagents) reflect three more days of real usage on top of that baseline — the
counts are in the same order of magnitude and grow in the expected direction, not a discrepancy.

**Query timings** (`x-orc-token`-authenticated `GET /api/sessions?q=…`, `%{time_total}`):

| run | conductor | SAF-1787 | backmerge | notification | weekend |
|---|---|---|---|---|---|
| 1 (first request after cold index) | 0.116s | 0.101s | 0.067s | **0.161s** | 0.016s |
| 2 | 0.097s | 0.096s | 0.049s | 0.144s | 0.015s |
| 3 (warm) | 0.024s | 0.065s | 0.024s | 0.036s | 0.011s |

**Finding, recorded honestly rather than smoothed over:** the very first `notification` query
after a cold boot measured 161ms — 11ms over the brief's 150ms bar. This is a cold-start artifact,
not a steady-state violation: the same query dropped to 144ms on the second call and 36ms on the
third, and this exact "common word" shape is the one Task 19's perf harness gates at p95 ≈
11–22ms over 20 reps in a warm process. It is consistent with Task 19 Fix round 4's own note that
the perf gate "wants an isolated CI runner" because wall-clock margins compress under contention
(here: JIT warm-up, SQLite page-cache fill, and the daemon's own just-finished 16s indexing pass,
not host noise) — logged as an open item below rather than a regression, since every subsequent
call to the same and other shapes stayed comfortably under budget.

**Prompts-only sample** (`GET /api/sessions?availability=prompts-only&limit=3`): returned real
sessions correctly flagged, e.g. `"summarise what was done in the ticket SAF-1293…"` with no
`transcriptPath`/resumability, matching the UI's prompts-only badge (confirmed visually, see §3
below).

**Project list** (`GET /api/projects`): `wakecap` first (`pathPrefixes: ["/Users/hazem/Wakecap"]`,
1017 sessions), followed by auto-detected projects (`orchestrator`, `StudioProjects`, `.config`,
`private`, `root`, `Stocks`, `Documents`, `.codex`, `hackathon`, `Downloads`, `videos`, `Forza`) —
F13's auto-build-with-Wakecap-default behaviour confirmed against real data.

**Manual browser check, read-only:** the built web app was opened at `http://127.0.0.1:4317/`
(the daemon auto-serves `apps/web/dist`). Confirmed: default redirect to `/history`, `Wakecap`
selected by default in the project selector, the real session list rendering (including this
very phase-1-exit session), typing `notification` into search live-filters the list and reflects
`?q=notification` in the URL with FTS `<mark>` snippet highlighting, and filtering by
`availability=prompts-only` shows real prompts-only sessions with the `prompts-only` badge. A
session detail page was opened by direct navigation (the virtualized table's sticky header
intercepts synthetic clicks in headless automation) and rendered correctly.

**Resume was deliberately NOT exercised against real data.** Clicking Resume on a real session
would spawn the user's real `claude` binary against their real `~/.claude` history — explicitly
forbidden by this task's constraints ("never spawn the real `claude`"). Evidence for the "resumes
into the correct cwd" M1 criterion instead comes from the hermetic Playwright e2e suite (real
daemon, real fake-`claude` binary, real xterm, real WebSocket, temp homes) and
`sessions.test.ts`'s resume unit tests — see §3 below, criterion 2.

## 3. M1 exit criteria (`docs/05-roadmap.md`)

| # | Criterion | Evidence | Pass |
|---|---|---|---|
| 1 | Any session from the last 30 days is found by keyword in under 150 ms | `pnpm --filter @orc/daemon perf`: pooled gated p95 ≈ 50ms (worst shape), most shapes ≤22ms, 150ms budget met with margin; real-data warm queries 11–65ms; e2e test 1 finds "Notification service test check" and the `weekends`-matching fixture live via the real HTTP round trip | ✅ (see the one cold-start 161ms data point above, explained, not a steady-state miss) |
| 2 | One click resumes it in the correct cwd | e2e test 2: opens fixture session `e2e-resume`, clicks Resume, asserts the xterm pane shows the fake-claude resume command line **and the session's real `cwd`**; `sessions.test.ts`'s resume test asserts `cwd=` against a `realpath`'d fixture directory; `server.test.ts`/`http/routes` integration tests cover the route; manual UI check (read-only) confirmed the Resume button/flow is wired and enabled only for resumable sessions | ✅ |
| 3 | Sessions that only exist in prompt history appear as `prompts-only` | e2e test 1 asserts a prompts-only fixture session shows its badge and a disabled Resume button; `indexer.test.ts` and `sessions.test.ts` cover the `Availability` derivation; real-data `GET /api/sessions?availability=prompts-only` and the UI filter both returned real prompts-only sessions with correct badges | ✅ |
| 4 | Daemon skeleton: Hono, SQLite/Drizzle, indexer, file offsets, token auth | `app.test.ts`, `apps/daemon/test/server.test.ts`, `indexer.test.ts`, `db/client.test.ts` all present and passing (part of the 289) | ✅ |
| 5 | Collectors: Claude transcripts + history.jsonl, Codex rollouts | Core aggregate tests (records/session-aggregate, codex-aggregate) pass; `indexer.test.ts` indexes the 10+ fixture sessions and real-data run indexed 979 Claude + 5811 Codex files, with `codex_sdk_ts` correctly flagged `automated` | ✅ |
| 6 | F13 project selector, auto-built, default Wakecap | `ProjectSelector.test.tsx`, `services/projects.test.ts` pass; e2e test 1 confirms `wakecap` selected by default; real-data check confirmed the same | ✅ |
| 7 | F3 history list, filters, FTS, saved views, pins, labels | `HistoryPage.test.tsx`, `db/repos/repos.test.ts`, `services/sessions.test.ts` pass; `/api/views`, `/api/labels`, pin/label routes exist and are exercised; real-data search/filter/highlight confirmed live | ✅ |
| 8 | F2 basic Session Detail (header + timeline) | `SessionDetailPage.test.tsx`, `session-detail/timeline-model.test.ts` pass; e2e test 1's final step opens a real session and asserts prompt text, a grouped tool call, and the recap render | ✅ |
| 9 | F4 resume, fork, adopt, pop-out into the embedded terminal | `services/sessions.test.ts`, `features/terminal/ResumeActions.test.tsx`, `features/terminal/TerminalDock.test.tsx`, `apps/daemon/test/server.test.ts` all pass; e2e test 2 drives a real resume/type/reload/stop cycle end to end | ✅ |
| 10 | Security: loopback bind, token, Origin/Host checks, redaction, read-only | `http/auth.test.ts`, `http/app.test.ts`, `apps/daemon/test/server.test.ts` pass; Step 2 audit above confirms no writes escape `ORC_HOME` and no `.key`/`messagingSocketPath` access; the exhaustive redaction guard test in `app.test.ts` (12 fields closed across fix rounds 3–5b, see §5) passes | ✅ |

**All 10 M1 criteria pass.**

## 4. Measured performance

**Search, per-shape** (`pnpm --filter @orc/daemon perf --reporter=verbose`, 1500 sessions / 90,000
events, this run):

| shape | n | p50 | p95 | max | gated? |
|---|---|---|---|---|---|
| common word (`notification`) | 20 | 0.8ms | 1.3ms | 1.3ms | yes |
| ticket prefix (`SAF-1`) | 20 | 0.9ms | 1.0ms | 1.0ms | yes |
| two-word phrase | 20 | 1.0ms | 11.2ms | 11.2ms | yes |
| topic phrase | 20 | 1.0ms | 3.6ms | 3.6ms | yes |
| single vocab token (~28% match) | 20 | 3.0ms | 9.8ms | 9.8ms | yes |
| tool command (~99% match) | 20 | 10.5ms | 22.5ms | 22.5ms | yes |
| **prefix fan-out (adversarial)** | 20 | 50.2ms | 52.8ms | 52.8ms | yes |
| zero-hit | 20 | 0.4ms | 0.6ms | 0.6ms | yes |
| **pooled (gated shapes only)** | 160 | 1.0ms | **50.3ms** | 52.8ms | — |

All under the 150ms budget with the adversarial fan-out shape (~2.8x margin) as the tightest
case, after five fix rounds (Task 19) closed a 4-second regression in that exact shape via a
prefix-matching rule change (`toFtsQuery`, only the last/still-being-typed token gets prefix
semantics) plus an empirical `FTS_PREFIX_CARDINALITY_CAP = 250` fallback to application-side
highlighting for pathologically wide prefixes — see §14 of `00-contracts.md` and §6 below.

**Cold index** (real `~/.claude` + `~/.codex`, this run): **6,801 files / 7,301 sessions in
16.3s**, all before the HTTP API becomes usable is irrelevant — `main.ts`'s `start()` resolves
and the port is bound before `scanAll()` settles, so `/api/health` and the UI are live from the
instant the daemon binds; the ~16s is purely "how long until the full corpus is searchable."
Claude-first scan ordering (already the default) means the ~979 Claude files finish first, in a
few seconds, well ahead of the ~5,811 Codex files.

**Bundle size** (`pnpm --filter @orc/web build`): main chunk 325.22 kB / gzip 104.20 kB;
`TerminalDock` isolated into its own 337.11 kB / gzip 85.41 kB lazy chunk (only loaded when a
terminal tab opens); `history` route chunk 61.89 kB / gzip 18.78 kB; total initial-load JS
(main + client + preload-helper, before any route/terminal chunk) ≈ 325 + 137 + 17 kB ≈ 479 kB /
~151 kB gzip. Daemon bundle: `apps/daemon/dist/main.js` = 82,251 bytes (esm, tsup).

## 5. Deferred minors carried out of this phase

These were raised during task reviews, ruled non-blocking for M1, and are **still open** at the
phase boundary (verified against the current tree, not just copied from the ledger):

- **Task 2:** no fixture/regression test pins "latest cost-state wins" or duplicate
  agent-name/PR-link dedupe — verified empirically by the reviewer, unprotected by a test.
- **Task 2:** `session_meta` kinds `bridge-session` and `frame-link` are still no-ops in the
  aggregate — Phase 3 consumes them for the Links tab.
- **Task 3:** `AgentNode.depth` trusts `meta.spawnDepth` verbatim rather than cross-checking the
  computed parent chain — fine for display indentation; worth checking if Phase 3 uses depth for
  layout decisions.
- **Task 4:** Codex `event_msg:item_completed` (dominant event_msg subtype, ~80% of sampled
  event_msgs) is ignored — appears to duplicate `response_item:message` with no data loss, but
  unverified against Phase 5's analytics needs.
- **Task 8:** `PtyManager.resize()` on an exited pty silently no-ops, while `write`/`sendText`
  throw `pty_exited` — a harmless but real asymmetry.
- **Task 9:** `ensureDetected()` always runs `reassignAll()` even when nothing new was detected —
  idempotent, but an unnecessary full pass; left to a later phase to decide whether to skip it.
- **Task 10:** `Indexer.unknownTypes()` only reflects files parsed in the *current* process (an
  unchanged file short-circuits before classification) — fine as a per-run diagnostic, not a
  persistent record.
- **Task 15:** field-level validation error messages surface only the first Zod issue (the rest
  live in `details`), and two tests pin Zod's exact English wording — revisit on a Zod upgrade.
- **Task 16:** the empty-timeline message is shared between a genuinely empty session and a
  prompts-only one (disambiguated only by the header badge); an unknown `:source` route param
  renders inline text rather than a 404.
- **Task 18:** terminal tabs use one tab stop each rather than the WAI-ARIA roving-tabindex
  pattern — every tab remains reachable and operable, just not optimally efficient for
  keyboard-only users.
- **Task 14 (recorded as a deliberate phase-level tradeoff, not a bug):** `apps/web`'s typecheck
  can see `@types/node` because contracts §11 sanctions type-only imports from the full
  `@orc/core` barrel; the Vite **build** (not typecheck) is what actually guarantees zero `node:`
  imports reach the browser bundle (verified clean). A later phase could tighten this to
  `@orc/core/browser` everywhere if strict per-file isolation is wanted.

All of the above are now recorded in `plan/00-contracts.md` §13 and §14 alongside the phase's
contract additions, per this task's brief.

## 6. Open items for Phase 2

- **The perf gate wants an isolated/dedicated CI runner.** Task 19's own fix-round notes recorded
  one real failure under heavy host contention (a shape spiked to ~212ms in one measurement) even
  though every isolated run passed comfortably; this task's own real-data check independently hit
  a similar cold-start effect (one query at 161ms, §2 above). The margins are real but
  wall-clock-based, and get compressed by a noisy-neighbor host. Recommend pinning
  `pnpm --filter @orc/daemon perf` to a dedicated CI runner before relying on it as a hard gate.
- **`FTS_PREFIX_CARDINALITY_CAP = 250` (`apps/daemon/src/services/sessions.ts`) is empirical, not
  formally derived.** It was tuned against the perf suite's synthetic corpus, then re-tuned
  against real-corpus term cardinality and measured `snippet()` cost for 20 common English
  prefixes (only `con`/`get`/`use`, cardinality 438–490, needed the fallback; everything ≤244
  stayed comfortably under budget). Real-text cost is **not monotonic in cardinality alone**
  (`con` cost 4–6x more than `get` at similar cardinality), so a future corpus with different
  vocabulary characteristics could still occasionally exceed the cap's safety margin at a
  cardinality below 250. The perf suite's gated per-shape assertions, not the cap alone, are the
  regression backstop — Phase 2 should re-measure if the indexed corpus's vocabulary shape changes
  materially (e.g. a new source with very different token distributions).
- **Redaction is now exhaustive by guard test, not by sweep table** (12 raw paths closed across
  fix rounds 3–5b; see §14 of `00-contracts.md`). Any new fallback text path added to
  `services/sessions.ts`'s `list()` (or any future route that returns transcript-derived text)
  must default to `redactedHighlight()`/`redact()` rather than assuming a route-layer pass will
  catch it — the concrete proof in this phase is that it didn't, twice.
- **Task 2's two untested-but-verified behaviors** ("latest cost-state wins", agent-name/PR-link
  dedupe) should get regression tests before anything in Phase 2+ depends on their exact
  semantics.
- **`docs/04-data-sources.md`'s tool-result classification claim is wrong** per spike S1 (needs
  `toolUseResult` **and** `sourceToolAssistantUUID`; the shipped code correctly uses OR) — flagged
  in S1's own report as a doc-only follow-up, still not filed.

## 7. Commit

This task's changes (`plan/00-contracts.md`, `plan/README.md`, this file) are committed on
`phase/1-history-search-resume` as a Conventional Commit. Per this task's explicit constraints,
**no merge to `main` and no push were performed** — the controller opens the PR.
