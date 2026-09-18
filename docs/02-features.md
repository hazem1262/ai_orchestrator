# 02 — Features

Priorities: **P0** = first usable version, **P1** = next, **P2** = later ("as we go").
Where an idea came from another product, it is marked *(↗ product)*. See [06 — Landscape & Inspiration](06-landscape-and-inspiration.md).

## Feature index
| ID | Feature | Priority | Milestone |
|---|---|---|---|
| F1 | Live Board | P0 | M2 |
| F2 | Session Detail | P0 → P1 | M1 (basic), M3 |
| F3 | History & Search | P0 | M1 |
| F4 | Resume / Fork / Launch | P0 | M1 |
| F5 | Transcript Archive | P0 | M2 |
| F6 | Work Streams | P1 | M5 |
| F7 | Usage Analytics | P1 | M5 |
| F8 | Command Palette | P1 | M3 |
| F9 | Safety Badges & Redaction | P1 | M3 |
| F10 | Real-time Bridge (hooks/statusline) | P1 | M5 |
| F11 | Integrations (GitHub, Linear, Slack, AGNC) | P1–P2 | M4, M6, M7 |
| F12 | Later / parked ideas | P2+ | — |
| F13 | Project Selector | P0 | M1 |
| F14 | LLM Session Recaps | P1 | M5 |
| F15 | Attention Inbox | P0 | M2 |
| F16 | Goals & Handoffs | P1 | M5 |
| F17 | Worktree Manager | P1 | M4 |
| F18 | Review & Merge | P1 | M4 |
| F19 | Limits & Budgets | P1 | M5 |
| F20 | Automations | P2 | M7 |
| F21 | Compare Mode | P2 | M7 |
| F22 | Remote & Mobile | P2 | M6 |
| F23 | Supervisor Agent | P2 | M7 |
| F24 | Audit Log | P1 | M3 |

---

## F1. Live Board — P0
> *As a user with many agents running, I want one screen that shows every live session and highlights the ones that need me.*

**Behaviour**
- One card per live session:
  - **Claude:** `~/.claude/sessions/<pid>.json`, shown only while the pid is alive.
  - **Codex:** running `codex` processes, matched to their rollout files.
  - **AGNC** (lowest priority, optional, added in M7 if the login works): active sessions **I own**, from `list_sessions`.
- **Card states:**
  - `busy`
  - `idle`
  - `waiting` (shows the `waitingFor` text)
  - `shell`
  - **`ready for review`**: the turn finished and the session changed files or opened a PR *(↗ zadloop)*
  - **`blocked`**: shows the reason from its goal (F16) *(↗ DeepSeek Harness)*
  - **`error`**: API error or crash
  - `ended`
- **Card contents:**
  - source icon, session name, time spent in the current state
  - cwd, shortened (a drift marker appears if it moved)
  - current or last tool, and the last prompt
  - cost so far and context-window fill (F19)
  - ticket and PR chips
  - **stage bar**: Understand → Modify → Test → Review. The stage is inferred from tool activity: reads/searches → edits → test commands → finished with changes. *(↗ zadloop)*
  - **last test result chip**, e.g. `✓ 18 · ✗ 0`. It is parsed from test-command output (vitest/jest/dotnet test/flutter test/pytest). Pass → fail changes are highlighted. *(↗ zadloop)*
  - **background jobs badge**: number of running background shells/subagents *(↗ DeepSeek Harness)*
  - **permission-mode badge**: bypass / plan / auto *(↗ DeepSeek Harness)*
  - running subagents count
- **Attention first:** `waiting` / `ready for review` / `blocked` / `error` cards sort to the top and pulse. They also create Attention Inbox items (F15) and macOS notifications, at most one per session per state change.
- **Layouts:**
  - grid
  - compact list
  - **side-by-side split** (pin 2–4 sessions, e.g. implementer + reviewer) *(↗ zadloop, Cursor)*
  - group by project, ticket or source
- **Card actions:**
  - open embedded terminal (F4)
  - open Session Detail (F2)
  - open diff (F18)
  - copy the resume command
  - **open in…** split button (VS Code / Terminal / Finder; remembers the choice per project) *(↗ DeepSeek Harness)*
  - kill the process (asks for confirmation)
- **Stale detection:** if the pid is dead but its registry file remains, the card shows `ended`. The app never deletes the file.

**Done when:** a new `claude` process appears within 2 s, and state changes show within 2 s.

---

## F2. Session Detail — P0 (visualizations grow in P1)
> *I want to understand what a session did without scrolling the terminal.*

**Header**
- Name (agent-name → ai-title → first prompt) and source.
- Model(s), start and last activity, duration.
- Starting cwd plus drift, permission mode.
- Total cost/tokens, lines added and removed.
- Goal and its state (F16).
- PRs, tickets and plan files.
- **Export** button: a ZIP with the transcript, subagents, recap and handoff, redacted by default *(↗ DeepSeek Harness)*.

**View modes:** Summary (recap and deliverables only) / Normal / Verbose (every tool call) *(↗ Claude Desktop)*.

**Tabs**
1. **Timeline (trajectory)**
   - Human prompts are section headers; assistant text and tool calls sit collapsed under them.
   - Tool calls are grouped: "Bash ×14", "Linear save_issue ×3".
   - `turn_duration` markers, `away_summary` recaps and API errors are shown.
   - **Step inspector** *(↗ DeepSeek Harness)*: tokens, duration, input/output.
   - **Stats per turn and per session** *(↗ DeepSeek Harness)*: model time vs. tool time, time to first token (where it can be derived), tokens/sec, cache hit rate (cache read ÷ total input).
   - Follows the live output until you scroll up; older records load lazily.
   - **Deliverables row** at the end of each turn *(↗ DeepSeek Harness)*: files actually changed in that turn, taken from Edit/Write events (not from what the model says). Clicking one opens its diff (F18).
2. **Agents tree** (@xyflow)
   - Main session → subagents → nested subagents, built from `subagents/*.meta.json`.
   - Each node shows agentType, description, background flag, tokens/cost, duration and status.
   - **Failed or running branches start expanded; finished ones collapse** *(↗ DeepSeek Harness workflows)*.
   - Clicking a node opens its transcript.
   - `/conductor` chains get their own rendering: repo-resolver → branch → code → lint → test → build → visual-verify.
   - Subagents can be `@`-referenced in the follow-up composer. This only inserts their label/summary; it cannot send to a subagent.
3. **Usage:** cumulative cost and tokens over time (echarts), per model, split into cache read, cache write and output.
4. **Files:** files edited across the session, with diffs (links to F18).
5. **Links:** PRs (`pr-link`), Linear tickets, plans (`~/.claude/plans`, repo `docs/superpowers/*`, `~/Wakecap/plans/**`), artifacts (`frame-link`), remote-control bridge.
6. **Raw:** JSONL viewer for debugging the parser.

**Rules:** large tool results (`tool-results/*.txt`) load lazily. Secrets are redacted on display (doc 03, Security).

---

## F3. History & Search — P0
> *I want to find any past session in seconds and know whether I can resume it.*

- **Coverage:** **all** of `history.jsonl` (1.4k+ sessions), plus transcripts on disk, plus the app's archive. Each session gets a badge:
  - `resumable`: the transcript exists
  - `archived`: only the app archive has it (restore first, F5)
  - `prompts-only`: only prompt history survives
- **Full-text search** (SQLite FTS5) over prompts, assistant text, tool inputs, names, titles and recaps.
- **Filters:**
  - source, project/starting cwd, repo
  - ticket, PR
  - date range, model, cost range
  - skill used
  - has-subagents
  - touched prod (F9)
  - state (e.g. ended with uncommitted changes)
- **Rows show:** name or recap, first and last prompt, date, duration, cost, chips.
- **Saved views**, pinning and custom labels are kept in the app DB. The tool's own files are never touched.
- Hide or archive a session in the app without deleting anything.

**Done when:** search over about 1.5k sessions returns in under 150 ms.

---

## F4. Resume / Fork / Launch — P0
> *One click and I'm back in the session, in the right directory, with my usual flags.*

### Resume (Claude)
- Runs `claude --resume <sessionId>` in the session's **original cwd**: the first record's `cwd`, which equals history.jsonl `project`.
- Default profile: `--dangerously-skip-permissions` for every project (decided). This can be changed in Settings.
- Runs in a daemon-managed PTY rendered by **xterm.js**. Several terminals can be open as tabs or splits.
- **Pop out** to Terminal.app or the VS Code terminal. The embedded PTY closes when you do.
- **Guard:** if the session is already live somewhere else, the app focuses its card instead of starting a second process. Such a session can be **adopted** after it ends: resuming it inside the app gives the app control of it (doc 03, Session control model).

### Other resume paths
- **Fork:** `claude --resume <id> --fork-session`.
- **Resume from PR:** `claude --from-pr <number|url>`, available from any PR chip.
- **Resume fresh with a handoff:** start a new session seeded with the structured handoff from F16. This is useful when the context is bloated *(↗ DeepSeek Harness Ralph handoff)*.
- **Codex:** `codex resume <id>` in the rollout's `cwd` (checked against the installed CLI).
- **AGNC** (optional): a composer that calls `send_prompt`. Messages and events appear in Session Detail.

### Launch a new session
- **Dialog fields:**
  - source (Claude / Codex / AGNC)
  - project and cwd, or **new worktree for a ticket** (F17)
  - initial prompt
  - template (optional)
  - ticket (optional)
  - **require plan approval first** (optional): starts in plan mode, and the plan shows up in the inbox for approval *(↗ Conductor, Agent HQ, Jules)*
  - **compare across N agents** (optional; F21)
- **Workflow templates:**
  - `Implement ticket` → `/conductor <ticket url>`
  - `Investigate` → `/investigate …`
  - `Backmerge` → `/backmerge …`
  - `Plan` → superpowers brainstorming
  - `Review PR` → `review this pr <url>`
- **Task presets** *(↗ zadloop)*:
  - "Fix the failing test"
  - "Add the missing test"
  - "Simplify this function/file"
  - "Address PR review comments"
  - "Fix CI failure"
  - Presets can be filled from the selected ticket, PR or failing check.
- **Hand off to AGNC** (optional): repo, branch, ticket/PR, relevant files and what was already checked (the F16 handoff format).

---

## F5. Transcript Archive — P0
> *Don't lose history to the 30-day cleanup.*

- **What gets archived:** the daemon copies main and subagent transcripts (not `tool-results/` or `file-history` for now) into `~/.orchestrator/archive/<project>/<sessionId>.jsonl.zst`. It re-copies whenever the source grows.
- **Retention status:** Settings shows it, together with a recommended `cleanupPeriodDays` snippet. The app shows the snippet and never edits Claude's settings itself.
- **Restore:** writes the transcript back into `~/.claude/projects/...` so the session can be resumed. It needs explicit confirmation and is recorded in the audit log (F24).
- **Size and pruning:** both are configurable.

---

## F6. Work Streams — P1
> *Show me everything that happened for SAF-1787.*

- **One stream per ticket.** Tickets are detected from:
  - prompts
  - branch names (`<type>/<TICKET>-<slug>`)
  - PR titles and bodies
  - plan file names
  - wstack `workflows/*.env`
  - worktrees (F17)
- **Stream view:**
  - sessions (all sources), plans, worktrees
  - PRs with CI status and review state
  - backmerge PRs (master → staging → testing)
  - automation runs (F20), AGNC runs
  - goal and handoff (F16)
  - cost total and budget (F19)
  - timeline
- **Stage indicator:** Planned → Implementing → In review → PR open → Merged → Backmerged → Released.
- **Linking:** tickets can be linked and unlinked by hand. The Linear title, status and assignee come from F11.
- **Scope:** Wakecap only at first (F13).
- Optional **kanban view** of streams by stage *(↗ Vibe Kanban, Nimbalyst)*.

---

## F7. Usage Analytics — P1
- **Cost and tokens:** per day, week, project, model, source and ticket.
- **Most expensive:** the top sessions and tickets, plus cost per merged PR.
- **Tool, MCP and skill usage over time.**
- **Timing:** the share of model time vs. tool time (from F2 stats) and cache hit rate trends.
- **Outcomes and friction:** from `~/.claude/usage-data/facets`, where present.
- **Weekly digest:** shipped PRs, stuck sessions, spend and quota use (F19). It can be posted to Slack (F11).
- **wstack:** skill-run outcomes from `~/.wstack/projects/*/timeline.jsonl`.

---

## F8. Command Palette & Quick Actions — P1
- ⌘K (cmdk) to jump to a session, ticket, PR, worktree or plan.
- **Actions from the palette:**
  - resume the latest session per project
  - launch from a template or preset
  - create a worktree
  - open the inbox
- **Keyboard shortcuts:**
  - `g i` opens the inbox
  - `g w` shows waiting sessions
  - `g h` opens history
  - `n` starts a new session
  - `j/k` + `e` (done) + `s` (snooze) triage inbox items

---

## F9. Safety Badges & Redaction — P1
- **Prod flags:** sessions that ran prod-touching commands or skills are flagged. Examples: `production_server_db`, `production_server_logs`, `wecare_production_db`, `kubectl` against prod contexts, `terraform apply`.
- **Permission-mode badge:** bypass / plan / auto. Unusual combinations are labelled `custom` *(↗ DeepSeek Harness)*.
- **Redaction:** tokens (`ghp_`, `sk-`, `xox*`, AWS keys), connection strings and `password=` values are hidden on screen and in search snippets. The raw text stays local.
- **Secrets hygiene panel:** points to risky files, such as the plaintext PAT in `~/Wakecap/.mcp.json` and credentials in `.claude/commands/*`. It never shows the values.
- **Shared deny-list:** the same prod/destructive patterns block the Supervisor (F23) and Automations (F20).

---

## F10. Real-time Bridge — P1
- **Optional Claude Code hook**, installed only with consent and after showing the snippet.
  - Sends SessionStart, Stop, Notification, PreToolUse and PostToolUse events to the daemon on `127.0.0.1`.
  - This gives exact waiting/finished timing without polling.
- **Optional statusline:** session cost, context fill, the current 5-hour block usage (F19), and the number of sessions waiting across all projects.
- **Fallback:** without the bridge, the app watches files instead.

---

## F11. Integrations — P1–P2 ("as we go")
Each integration is a plugin behind a common connector interface (doc 03). Linear and Slack act **as me**, using my user token; there is no bot.

| Integration | Priority | Capabilities |
|---|---|---|
| **GitHub** (`gh`) | P1 (M4) | PR create/state/checks/review; merge (with confirmation); backmerge PR detection; `--from-pr` resume; PR-comment and CI-failure events for F20 |
| **Linear** | P2 (M6) | ticket title/status/assignee on streams; create follow-up ticket; comment recaps, plans and handoffs; "assigned to me / label" events for F20; backlog for suggested tasks |
| **Slack** | P2 (M6) | post recaps and daily updates; **DM bridge** (F22); mention events for F20 |
| **AGNC** | lowest (M7, optional) | list and detail, then create session, create PR, model defaults |
| **Langfuse / Mixpanel** | later | links to traces and dashboards |

---

## F13. Project Selector — P0
> *Wakecap is my main project, but I also want to switch to Forza, Stocks and others.*

- **What a project is:** an original cwd, or a root path that covers its sub-paths. For example, `Wakecap` covers `~/Wakecap/**`, so sub-repos and worktrees count toward it.
- **Auto-built:** on first run, the project list is **built from past session history**, ordered by recent activity *(↗ DeepSeek Harness)*.
- **Selector:** a global control in the top bar with `Wakecap` (default), `All projects` and any other projects. The last choice is remembered. It scopes the Live Board, Inbox, History, Analytics, Worktrees and the launcher.
- **Settings:** rename, merge paths, hide (never deletes anything), set the default, and pick the **open-in** app per project.
- **Per-project config:**
  - ticket regex
  - prod patterns
  - templates and presets
  - setup/run/archive scripts (F17)
  - budgets (F19)
  - recap on/off (F14)

  Work Streams and prod badges are **Wakecap-only at first**.
- **Complexity:** low; it is included in M1.

---

## F14. LLM Session Recaps — P1 (configurable)
> *Give me a 3-line summary of what a session or a day accomplished, without reading it.*

- **Output:**
  - **Session recap:** goal, what was done, outcome, PRs/tickets, follow-ups, **"what to check"** (a plain-language review note) *(↗ zadloop)*.
  - **Daily/weekly recap** per project, which can feed the Slack daily update.
- **Settings:**
  - **Enabled:** globally and per project.
  - **Trigger:** manual, on idle/end, or daily.
  - **Engine:** `claude -p` headless (default, reuses the Claude login) or an Anthropic API key.
  - **Model (confirmed):** `claude-haiku-4-5` for automatic recaps, `claude-sonnet-5` for on-demand ones. Any model can be set.
  - **Budget:** monthly cap and max input tokens per recap.
  - **Prompt template:** editable.
  - **Scope:** skip sessions under N prompts; exclude projects.
  - **Output language** (English by default).
- **Input:** a **redacted compact digest** (prompts, assistant text, tool names and counts, deliverables, test results, links, `away_summary`). Tool outputs are never sent.
- **Storage:** cached per session and transcript offset, and regenerated only when the session has grown. Each recap shows its cost and model.

---

## F15. Attention Inbox — P0
> *One place that tells me what needs me, and it doesn't vanish like a toast.* *(↗ Warp mailbox, Codex review queue)*

- **Item types:**
  - `waiting for input`
  - `ready for review`
  - `plan awaiting approval`
  - `blocked`
  - `error / API failure`
  - `tests went red`
  - `over budget / near quota` (F19)
  - `automation result` (F20)
  - `supervisor escalation` (F23)
  - `PR check failed / review requested` (F11)
- **Item contents:** source session, project, ticket, age, a one-line reason, and quick actions. Actions:
  - open terminal
  - open diff
  - approve plan
  - reply (for sessions the app owns)
  - snooze
  - done
- **Lifecycle:** an item closes automatically when its condition clears (the session gets busy again, or the checks pass). Items are persisted in SQLite.
- **Notifications:** macOS notifications (and later push/Slack DM, F22) are *views* of inbox items. Each type has its own setting: on/off, quiet hours, per project.
- **Triage by keyboard** (F8). The unread count appears in the tab title, the statusline and, later, the Tauri tray.

---

## F16. Goals & Handoffs — P1
> *Keep track of what each session is trying to achieve, and move work cleanly between sessions.* *(↗ DeepSeek Harness goals and Ralph handoff)*

- **Goal:**
  - Attached to a session or work stream: an objective, plus a state of `active` / `paused` / `blocked` (reason) / `complete`.
  - Stored as app metadata. It is prefilled from the ticket title or the first prompt, and can be edited.
  - The state can be updated by hand, by the recap (F14) or by rules. For example, "PR merged → complete", or "waiting on a question for > 30 min → blocked: needs answer".
- **Handoff document** (markdown + JSON), with these fields:
  - `status`
  - `summary`
  - `evidence` (tests, PRs, commands run)
  - `files`
  - `next steps`
  - `blockers`
  - `links`

  It is generated from the session (LLM + structured data) and can be used to:
  - resume in a fresh session (F4)
  - comment on the Linear ticket (F11)
  - hand off to AGNC
  - attach to the work stream
- **Reminders:** e.g. "re-check CI in 20 min". When one is due, the app creates an inbox item, and for app-owned sessions it can optionally send the reminder text as a prompt. Reminders survive daemon restarts.

---

## F17. Worktree Manager — P1
> *Start work on a ticket in an isolated, ready-to-run checkout in one click.* *(↗ Conductor, Vibe Kanban, agent-deck, Emdash)*

- **Discover:**
  - `git worktree list` across known repos
  - existing `.worktrees/` folders (e.g. `Backend/infrastructure/.worktrees`)
  - sibling-folder worktrees
  - worktrees created in Claude scratchpads

  Each is shown with its repo, branch, ticket, linked sessions, dirty state and PR.
- **Create from a ticket:**
  1. Pick the repo(s) and base branch.
  2. The branch is named `<type>/<TICKET>-<slug>`, following the existing convention.
  3. The location follows the per-repo setting (`.worktrees/<branch>`).
  4. **Gitignored files are copied** (`.env`, `appsettings.Development.json`… configurable globs).
  5. The **setup script** runs (e.g. `pnpm install`, `dotnet restore`).
  6. Optionally, a session launches in the new worktree (F4).
- **Per-repo scripts:** `setup`, `run` (dev server / tests) and `archive`, stored in the app config. A committed `orchestrator.json` in the repo is optional.
- **Actions:**
  - open in IDE
  - open terminal
  - run script
  - **sync to main checkout** (copy changes to the main worktree for local testing, asks for confirmation) *(↗ Conductor Spotlight)*
  - archive or prune (confirmation; blocked if there are uncommitted changes)
- **Auto-archive when the PR merges.** Sessions and history stay linked.
- **Works alongside `/conductor`:**
  - When conductor creates the branch or worktree itself, the app detects it and links it rather than creating a duplicate.
  - The "Implement ticket" template can either pre-create the worktree or let conductor do it (a setting).
- All git writes are confirmed and audited (F24).

---

## F18. Review & Merge — P1
> *Review what the agent did, send feedback, and ship without leaving the app.* *(↗ Vibe Kanban, Conductor, Nimbalyst, Emdash, zadloop)*

- **Diff viewer:**
  - Compares the worktree or branch with its base, or shows **per-turn** diffs (via checkpoints).
  - File tree with +/− counts, split or unified view, syntax highlighting.
  - "Viewed" checkboxes per file.
- **Review summary card:** changed files, last test results, recap "what to check", CI status *(↗ zadloop "every change visible")*.
- **Inline comments → agent:**
  - Comments on lines are collected into one structured follow-up prompt (file:line + comment).
  - For **app-owned** sessions the prompt is sent to the session.
  - Otherwise it is copied to the clipboard, or a new session is started with it.
- **Checkpoints:**
  - After each turn in app-owned sessions, the app snapshots the worktree to `refs/orchestrator/checkpoints/<session>/<turn>` using a commit-tree snapshot. HEAD and the index are not touched.
  - **Rewind** restores the files of a checkpoint (confirmation required; a checkpoint of the current state is created first) *(↗ Conductor, opcode)*.
- **Partial acceptance:** revert individual files or hunks before committing *(↗ Nimbalyst)*.
- **Ship:**
  - commit (message suggested from the recap)
  - push
  - **create PR** via `gh`, with an AI-written description using the repo's PR template and the ticket link
  - watch **CI checks** and review state
  - **merge** (confirmation; respects branch protection)
  - **Backmerge** runs the `/backmerge` template (master → staging → testing)
- **Events:** checks failing or a review being requested creates an inbox item (F15). "Fix CI failure" and "Address review comments" presets are one click away.

---

## F19. Limits & Budgets — P1
> *Plan work around rate limits and spend, not just look at them afterwards.* *(↗ ccusage, CodexBar/ClaudeBar, agent-deck)*

- **Quota bars:**
  - **5-hour block** and **7-day** usage for the Claude subscription, with a reset countdown.
  - Estimated from transcript usage the way ccusage does it, until an official source is found (spike S7).
  - Codex usage is shown where it is available.
- **Burn rate:** $/hr and tokens/min, overall and per session, with a projection of when the current block runs out.
- **Context-window fill** per session, with a warning near the limit and a suggestion to "resume fresh with handoff" (F16).
- **Budgets:**
  - Daily, weekly and monthly limits per project or ticket, in dollars.
  - Warning at 80%, inbox item at 100%.
  - Automations (F20) and the Supervisor (F23) stop when their budget is exceeded.
- **Concurrency cap** per project (e.g. at most 6 app-launched sessions). Extra launches are queued.
- **Statusline** option shows block usage and burn rate (F10).

---

## F20. Automations — P2
> *Let agents pick up routine work on a schedule or when something happens, and review the results in the inbox.* *(↗ Codex automations, Cursor, Jules, Superset, Emdash, DeepSeek Harness webhooks)*

- **Triggers:**
  - **Schedule** (cron): e.g. "every weekday 09:00: daily-update draft", "Mon: dependency audit".
  - **GitHub:** PR review comment on my PR, check failed, PR merged (which triggers the backmerge suggestion).
  - **Linear:** ticket assigned to me or a label added.
  - **Slack:** a mention in a chosen channel.
  - **Manual:** "run now".
- **Action:** launch a template or preset session. Options:
  - project, repo, worktree
  - headless `claude -p` or an interactive PTY
  - model
  - budget
  - timeout
  - optional plan approval before the session writes
- **Guardrails:**
  - Off by default, and each automation is enabled separately.
  - The shared deny-list applies (F9); no prod access.
  - Concurrency and budget caps apply (F19).
  - Automations never merge; they only open a PR or a draft.
- **Output:** an `automation result` inbox item with recap, diff and PR link. Run history, logs, reruns and a success rate are kept.
- **Suggested tasks:** a list built from the Linear backlog and new `TODO/FIXME` comments in changed code. Nothing runs until I accept it *(↗ Jules)*.
- **Event source:** GitHub events are polled with `gh` by default. Webhooks via Tailscale Funnel or a relay are optional.

---

## F21. Compare Mode — P2
> *For hard tasks, run the same prompt on several agents or models and keep the best result.* *(↗ Conductor multi-model, GitHub Agent HQ, Codex attempts)*

- **Launch:** pick N from Claude (opus/sonnet), Codex, or several Claude runs. Each gets its **own worktree** (F17).
- **Compare view:** side-by-side status, diffs, test results, cost, duration and recap.
- **Pick a winner:** it goes to Review & Merge (F18). The other worktrees are archived.
- **Cost guard:** the estimated cost multiplier is shown before launch, and the budget applies (F19).

---

## F22. Remote & Mobile — P2
> *See and unblock my agents from my phone when I'm away from the desk.* *(↗ Happy, Omnara, Claude Code UI, Nimbalyst iOS, agent-deck bridges)*

- **Responsive PWA:**
  - Screens: Inbox, Live Board, Session Detail (Summary view), diff viewer (read-only), and a reply composer.
  - Can be installed to the home screen.
- **Access:**
  - Only over **Tailscale** (`tailscale serve`), never exposed to the public internet.
  - The daemon token is still required.
  - Sending input or approving from a remote device needs a **passkey (WebAuthn)**.
- **Push:**
  - Web Push (VAPID) for inbox items.
  - Alternatively, a **Slack DM to myself** (sent with my user token).
- **Actions from the phone:**
  - answer a waiting session
  - approve a plan
  - approve or reject automation output
  - snooze
  - stop a session
  - Answering and approving work only on **app-owned** sessions.
- **Slack DM bridge:**
  - The inbox item is posted as a DM thread.
  - Replying in the thread sends the text to the app-owned session.
  - Emoji reactions work as shortcuts (✅ approve, 💤 snooze).
- **Away mode:** turned on by hand, or automatically when the Mac is idle. In this mode notifications go to push/Slack instead of macOS.

---

## F23. Supervisor Agent — P2 (opt-in)
> *Don't make me answer "continue?" twelve times a day.* *(↗ agent-deck conductor, claude-squad autoyes — made safer)*

- **What it watches:** app-owned sessions in the `waiting` state. It classifies the pending question using rules first, then a small model (Haiku 4.5).
- **What it answers automatically:** only allow-listed routine prompts, such as "continue", "yes, run the tests", "proceed with the approved plan", and retrying after transient errors.
- **What it escalates:** everything else goes to the inbox with its reasoning, including anything that matches the deny-list (prod, destructive git, infra apply, deploys, credentials) or where confidence is low.
- **Limits:**
  - enabled per project and per session
  - a cap on automatic answers per session and per hour
  - a budget cap (F19)
  - quiet hours
- **Logging:** every automatic answer is recorded in the audit log (F24), with a one-click "that was wrong" to improve the rules.

---

## F24. Audit Log — P1
> *Every action the app takes on my behalf is traceable.* *(↗ Omnara)*

- **What is logged (append-only):**
  - session launch, resume, fork and kill
  - input sent to a PTY (redacted)
  - archive restore
  - worktree create, sync, archive
  - checkpoint and rewind
  - commit, push, PR, merge
  - automation runs
  - supervisor answers
  - integration writes (Linear comment, Slack post)
  - remote approvals (with the device)
- **Each entry:** timestamp, actor (me / automation / supervisor / remote device), target, parameters (redacted) and result.
- **Where it is shown:** a searchable view, filterable per session, stream and project. It is included in the export (F2).

---

## F12. Later / parked (P2+)
- **Orchestrator MCP server:** Claude and Codex can ask "which sessions are waiting?", "summarize yesterday's SAF-1787 work", "search past sessions for X", or "resume the session that touched Y" *(↗ DeepSeek Harness session search tools)*.
- **Tauri desktop wrapper:** menu-bar count of waiting sessions and quota, native notifications, global hotkey.
- **Team mode:** opt-in sharing of work-stream metadata only; multiplayer workspaces.
- **Prompt library:** most-reused prompts from history.jsonl turned into presets.
- **Per-session MCP/skill switches** and a **CLAUDE.md / skills manager** *(↗ agent-deck, opcode)*.
- **Container/devcontainer sandbox** per agent *(↗ Sculptor, CCManager)*.
- **Built-in preview browser** with devtools *(↗ Vibe Kanban, Emdash)*.
- **Voice control** *(↗ Happy)*.
- **Remote hosts over SSH**, to run agents on other machines *(↗ Emdash, Superset)*.
- **Arabic support in recaps and messages**, keeping code and paths left-to-right *(↗ zadloop)*.
- **Orchestrator CLI** (`orc ls / resume / inbox`) *(↗ Superset, Jules)*.
- **MCP process pooling**, if memory becomes a problem *(↗ agent-deck)*.

## Non-goals (for now)
- Replacing the Claude/Codex CLI UI or re-implementing chat. The app wraps the CLIs.
- Sending input to sessions the app didn't launch. Claude's internal messaging socket is not used.
- Editing Claude/Codex settings or transcripts. The only exception is the confirmed archive restore.
- A cloud service or multi-user server. Remote access is only via my own Tailscale network.
- Auto-merging or touching prod from automations or the supervisor.
- Cursor or Gemini sessions.
