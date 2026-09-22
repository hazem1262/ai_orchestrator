# Phase 2 — M2 exit check evidence

Checked on **2026-09-23** (local, UTC+3) against the daemon running on the real `~/.claude` and
`~/.codex` at `http://127.0.0.1:4317`, branch `phase/2-live-board-inbox-archive`, HEAD `189a569`.
`T=$(cat ~/.orchestrator/token)` in every command below; the header is `x-orc-token: $T`.

Screenshots referenced here live in [`evidence/`](evidence/).

Three probe sessions were launched and killed during this check (pids 51155, 66112, 91069). They
appear as `ended` cards in the screenshots and in the `/api/live` output below. The daemon never
wrote to `~/.claude` or `~/.codex`; criterion 7 is the check for that.

| # | Criterion | Verdict |
|---|---|---|
| 1 | All running Claude and Codex sessions are visible | ✅ verified |
| 2 | Anything that needs me shows in the inbox within 2 s | ✅ verified — 49 ms measured |
| 3 | No transcript is lost after 30 days | ✅ verified (restore round trip on a copy) |
| 4 | F1 card fields and states | ✅ verified, except the agents badge (no subagents were running) |
| 5 | F15 notifications and triage | ◐ partly — triage and tab count verified; the macOS banner was not seen by a human, and one banner send failed in the daemon log |
| 6 | F4 launch | ✅ verified (empty-prompt launches; the 429 was produced on a second daemon with `maxConcurrentOwned: 1`) |
| 7 | Read-only toward tool data | ✅ verified |
| 8 | Suite green | ❌ `pnpm --filter @orc/web e2e` is 6/7 — the P1 spec `history.spec.ts` still expects `/` → `/history` |

---

## 1 — All running Claude and Codex sessions are visible

```
$ ps -axo pid,command | grep "claude --dangerously-skip-permissions" | grep -v grep
 7785 claude --dangerously-skip-permissions
59904 claude --dangerously-skip-permissions
83786 claude --dangerously-skip-permissions
12621 claude --dangerously-skip-permissions
10181 claude --dangerously-skip-permissions
24734 claude --dangerously-skip-permissions

$ ps -axo pid,command | grep -i codex | grep -v grep
28501 …/.codex/plugins/cache/openai-bundled/chrome/…/ChatGPT for Chrome …     (not a session)
85369 node /Users/hazem/.npm-global/bin/codex                                  (npm wrapper)
85370 …/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex       (the session)
```

The plan's `grep -E '(^| )(claude|codex)( |$)'` misses codex, which runs from an absolute path, so
the two greps above were used instead.

```
$ curl -s -H "x-orc-token: $T" http://127.0.0.1:4317/api/live | …   # pid, source, id, status, ownership
10181 claude 1b23a79a idle   observed
12621 claude a112d76e waiting observed
24734 claude 7799cc71 idle   observed
59904 claude 17e9f3f1 idle   observed
 7785 claude ae5213a2 busy   observed
83786 claude cbcdb93a idle   observed
85370 codex  01a0a99c idle   observed
51155 claude bfd96d47 ended  observed
66112 claude 73f72a6d ended  owned
91069 claude 3a0be0c4 ended  observed
```

The seven live rows are exactly the six `claude` pids plus codex pid 85370 — a 1:1 match with `ps`.
The three `ended` rows are this check's own probe sessions, retained for `live.endedRetentionMin`
(10 min) after they were killed, which is the behaviour the criterion asks for.

Screenshot: [`evidence/live-board-all-projects.png`](evidence/live-board-all-projects.png).

## 2 — Anything that needs me shows in the inbox within 2 s

A poller sampled `~/.claude/sessions/*.json` and `GET /api/inbox?state=open` every 250 ms and caught
a real status flip to `waiting` (a launched session that asked for input):

```
WAITING-FLIP bfd96d47-47a8-46a7-a5ae-99e04076ce4f pid=51155 statusUpdatedAt=1790112792719
INBOX waiting:session:claude%3Abfd96d47-… createdAt=2026-09-22T21:33:12.768Z
```

```
registry statusUpdatedAt : 1790112792719 ms
inbox item createdAt     : 1790112792768 ms
detection latency        :            49 ms   (budget 2000 ms)
```

The same item auto-resolved when the session was killed:

```json
{ "kind": "waiting", "dedupeKey": "waiting:session:claude%3Abfd96d47-…",
  "createdAt": "2026-09-22T21:33:12.768Z", "updatedAt": "2026-09-22T21:33:24.327Z",
  "state": "auto_resolved" }
```

Hooks were not installed for this measurement: 49 ms comes from the registry watcher alone, so per
spike S3 the hook bridge is not needed to meet the 2 s budget. The automated equivalent is the
waiting test in `apps/daemon/test/p2-daemon.test.ts` and `apps/web/e2e/live-inbox.spec.ts:32`.

## 3 — No transcript is lost after 30 days

**File counts match.**

```
$ curl -s -H "x-orc-token: $T" http://127.0.0.1:4317/api/archive/sync -X POST
{"copied":3}
$ curl -s -H "x-orc-token: $T" http://127.0.0.1:4317/api/archive/status
{"enabled":true,"files":1142,"bytes":230842809,"oldestTranscript":"2026-08-24T08:29:32.192Z",
 "cleanupPeriodDays":null,"codec":"zstd","recommendedSnippet":"{\n  \"cleanupPeriodDays\": 3650\n}"}
$ find ~/.claude/projects -name '*.jsonl' -not -path '*/tool-results/*' | wc -l
    1142
```

**Restore round trip.** Run on a copy, not on `~/.claude`. The copy holds two real transcripts
rather than all 1142, because `~/.claude` is 1.9 GB:

```
CLAUDE_HOME=<scratch>/claude-copy  ORC_HOME=<scratch>/orc-home  ORC_PORT=4399
```

```
sync                       → archive holds 2 files, 77115 bytes, codec zstd
rm <copy>/…/5ba99897-….jsonl
GET /api/sessions/claude/5ba99897-…  → "availability": "archived"
POST /api/archive/restore {source,id}                → 409 confirmation_required
    details.summary: Restore 1 transcript file(s) … Existing files are never overwritten.
POST /api/archive/restore {source,id,confirm:true}   → 200 {"restored":["…/5ba99897-….jsonl"]}
cmp <restored> <original in ~/.claude/projects/…>    → identical
POST /api/archive/restore {source,id,confirm:true}   → 409 restore_target_exists
```

**Retention warning.** `http://127.0.0.1:4317/settings`, screenshot
[`evidence/settings-prod.png`](evidence/settings-prod.png):

```
Transcript archive
1143 files · 220.9 MB · zstd            ← 1143, not 1142: one more transcript was written
                                          between the count above and this reading
Oldest transcript on disk: 2026-08-24 (29 days ago)
Claude cleanupPeriodDays: not set (30 days)
Claude deletes transcripts after 30 days (default). Keep the archive on, or raise cleanupPeriodDays.
Recommended addition to ~/.claude/settings.json — the app never edits that file:
{ "cleanupPeriodDays": 3650 }
```

## 4 — F1 card fields and states

Screenshots: [`evidence/live-board-all-projects.png`](evidence/live-board-all-projects.png) (grid),
[`evidence/live-board-list-grouped.png`](evidence/live-board-list-grouped.png) (list),
[`evidence/live-board-split-grouped.png`](evidence/live-board-split-grouped.png) (split),
[`evidence/live-board-grouped-by-project.png`](evidence/live-board-grouped-by-project.png).

Read off the grid screenshot:

| Field | Seen as |
|---|---|
| status | `Waiting`, `Busy`, `Idle`, `Ended` chips |
| time in state | `2h 05m`, `10m`, `5m`, `4m` |
| cwd plus drift | `~/Wakecap/agent-conductor` with the drift icon; `~/…/veagle/.worktrees/profile-phase-1` |
| tool | `tool Bash`, `tool AskUserQuestion` |
| last prompt | `commit, push and create a pr`, `go ahead with Task 2` |
| cost | `$0.29` on the one card with a recorded cost |
| ticket / PR chips | `SAF-1781 … ALU-1360`, `#602 … #55` |
| stage bar | four segments, current one filled (`Understand` / `Test`) |
| test chip | `✓ 31 · ✗ 0`, `✓ 1111 · ✗ 0`, `✓ 4 · ✗ 1` |
| jobs | `37 jobs`, `2 jobs`, `3 jobs` |
| permission badge | `bypass` |
| card actions | `Details`, `Diff` (disabled until P4), `Copy resume`, `Open in VS Code` + app select, `Pin`, `Stop`; `Terminal` on the owned card |
| attention-first ordering | the `Waiting` card is first and ringed |
| grid / list / split | the three radios; split with nothing pinned shows `Pin 2–4 sessions to compare them side by side.` |
| group by | `Group by project` produced the headings `wakecap`, `orchestrator`, `stocks`, `studioprojects`, `private` |

**Not verified:** the agents badge. No session had a running subagent during the check, so the badge
never rendered. It is covered by `apps/web/src/features/live-board/SessionCard.test.tsx`.

## 5 — F15 notifications and triage

**Inbox count and tab title** — screenshot [`evidence/inbox.png`](evidence/inbox.png): the top bar
shows `Inbox 1`, the browser tab title is `(1) Orchestrator`, and the page shows the
`Open / Snoozed / Done` tabs with the legend `j/k move · e done · s snooze 1h · Enter open`.

**Keyboard triage** — `j`, `e`, `s` and the snoozed tab are exercised end to end by
`apps/web/e2e/live-inbox.spec.ts:55`, which passed in this run (see criterion 8).

**macOS banner — NOT verified as seen.** Two observations:

1. The daemon log holds one failed send:
   ```
   {"level":40,"time":1790106895692,"channel":"macos","kind":"waiting",
    "err":"SyntaxError: Unexpected non-whitespace character after JSON at position 154 (line 6 column 2)",
    "msg":"notification channel failed"}
   ```
   The error comes out of `node-notifier` parsing its helper's output, not out of
   `apps/daemon/src/notify/macos.ts`.
2. A direct send through the same channel during this check resolved without error:
   ```
   createMacosChannel().send(<waiting item>, 'http://127.0.0.1:4317/sessions/claude/probe')
   → OK: macos channel resolved
   ```

Nobody watched the screen, so neither the banner's appearance nor the click-through to the session
URL was observed. `GET /api/config/notifications` returns all six kinds enabled on the `macos`
channel.

## 6 — F4 launch

Every launch below used an **empty prompt**, so the spawned CLI sat at its prompt and consumed no
model tokens. Each process was killed within the minute and `ps` was clean afterwards.

**Launch, ownership and sessionId** (real daemon, scratch cwd):

```
POST /api/sessions/launch {"source":"claude","projectId":null,"cwd":"<scratch>/launch-probe","prompt":""}
→ 200 {"ptyId":"5611bf2f-…","sessionId":"73f72a6d-461a-42ad-a641-aa6d9ba446cf"}

GET /api/live → the new card
{"pid":66112,"status":"idle","ownership":"owned","ptyId":"5611bf2f-…","since":"2026-09-22T21:34:06.274Z"}
```

`sessionId` was resolved from the registry by pid, and the card carries a `Terminal` button
(`launch-probe-70` in [`evidence/live-board-all-projects.png`](evidence/live-board-all-projects.png)).

**Kill with confirmation:**

```
POST /api/sessions/claude/73f72a6d-…/kill {}                → 409 confirmation_required
    details.summary: Stop "launch-probe-70" (pid 66112) in <scratch>/launch-probe?
POST /api/sessions/claude/73f72a6d-…/kill {"confirm":true}  → 200 {"killed":"pty"}
ps -p 66112                                                 → gone
GET /api/live                                               → status "ended"
```

**Templates** — `GET /api/templates` returns the 5 workflows and 5 presets:
`wf-implement-ticket`, `wf-investigate`, `wf-backmerge`, `wf-plan`, `wf-review-pr`,
`preset-fix-failing-test`, `preset-add-missing-test`, `preset-simplify`, `preset-address-review`,
`preset-fix-ci`.

**Error paths** (second daemon, isolated homes):

```
cwd /no/such/dir                                  → 400 cwd_not_found
templateId "nope"                                 → 404 template_not_found
templateId "wf-implement-ticket", vars {}         → 400 template_var_missing {"missing":["ticketUrl"]}
planApproval: true                                → 501 not_implemented {"field":"planApproval"}
worktree: {…}                                     → 501 not_implemented {"field":"worktree"}
compare: [{…}]                                    → 501 not_implemented {"field":"compare"}
```

**Concurrency cap → 429.** The real config has `maxConcurrentOwned: 6` for every project, so the cap
was produced on the second daemon with the project patched to `1`:

```
launch 1 → 200 {"ptyId":"ffb54319-…","sessionId":null}
launch 2 → 429 {"code":"concurrency_limit","message":"project private already runs 1 app-owned sessions",
                "details":{"projectId":"private","max":1,"running":1}}
```

**Not verified:** launching an "Implement ticket" template against a real ticket with a real prompt.
Such a launch spends model tokens on the user's account, so it was replaced by the template-render
and error-path checks above plus the empty-prompt launch. The rendered-prompt path is covered by
`apps/daemon/test/launch-integration.test.ts`.

## 7 — Read-only toward tool data

`touch <scratch>/phase2-start` ran before every check above.

```
$ find ~/.claude ~/.codex -newer <scratch>/phase2-start \
      -not -path '*/projects/*' -not -path '*/sessions/*' -not -path '*/history.jsonl' -print | wc -l
      55
```

Every path falls into a directory the CLIs write for themselves. Grouped:

```
.claude/plugins/{synced,cache,.trash}/**      36    plugin sync and cache
.claude/backups/.claude.json.backup.<ms>       5    the CLI's own config backups
.claude/session-env/<sessionId>                3    written by the claude CLI in the PTY, one per probe session
.claude/cache/{model-catalog/**,changelog.md}  3
.claude/state/**, skills/synced, telemetry,
  shell-snapshots, hooks/check-log.jsonl,
  mcp-needs-auth-cache.json                    6
.codex/{models_cache.json,logs_2.sqlite*}      4
```

The three `session-env/<sessionId>` files are this check's own probe sessions; the `claude` CLI
inside the PTY wrote them, not the daemon. The count keeps growing while the CLIs run — 55 was the
reading taken right after the checks above.

```
$ lsof -p 63275 | grep '\.key'        # 63275 is the daemon
(no output, exit 1)
```

Six `*.key` files sit next to the `*.json` registry files in `~/.claude/sessions/`; the daemon has
none of them open.

## 8 — Suite green

```
$ pnpm lint            → 0   Checked 326 files in 122ms. No fixes applied. Found 1 info.
$ pnpm typecheck       → 0   4 of 5 workspace projects, all Done
$ pnpm test            → 0   Test Files 87 passed (87) · Tests 1111 passed (1111) · 9.05s
$ pnpm check:fixtures  → 0   fixtures clean
$ pnpm --filter @orc/web e2e → 1   6 passed, 1 failed
```

The four `live-inbox.spec.ts` tests all pass. The failure is the Phase-1 spec
`apps/web/e2e/history.spec.ts:5`, which still asserts the pre-Phase-2 landing route:

```
Error: expect(page).toHaveURL(expected) failed
  Expected pattern: /\/history/
  Received string:  "http://127.0.0.1:4399/inbox"
```

Phase 2 deliberately changed `/` to redirect to `/inbox` (contracts §12, and
`live-inbox.spec.ts:26` asserts the new behaviour), so the app is correct and the P1 assertion is
stale. The fix is `page.goto('/history')` in place of `page.goto('/')` on line 4 of that spec. It is
a code change and is left for a separate commit.

## Findings raised by this check

1. **`history.spec.ts` is stale** — criterion 8 above. One line.
2. **`/settings` is broken on the vite dev server** (`pnpm --filter @orc/web dev`, port 5173). The
   route renders the error boundary with
   `Module "node:fs/promises" has been externalized for browser compatibility. Cannot access "node:fs/promises.open" in client code.`
   The chain is `packages/core/src/index.ts:12` → `export * from './io/jsonl-tail.ts'` →
   `node:fs/promises`. `/history`, `/live` and `/inbox` render clean in dev, and the production
   build the daemon serves renders `/settings` with no page error, so this is dev-server only. The
   same import prints a warning during `pnpm --filter @orc/web build`.
3. **One macOS notification send failed** — criterion 5 above.
