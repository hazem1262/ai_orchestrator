# 01 — Vision & Insights

## The one-liner
**A cockpit for many AI agents running in parallel.** It shows what is running, what needs me, what it cost and what it shipped. I can get back into any session in one click, review and ship its work, and unblock it from my phone.

## How I actually work (evidence, snapshot 2026-09-16)

These numbers come from `~/.claude`, `~/.codex`, `~/.wstack` and `~/Wakecap`, gathered read-only.

### Volume and parallelism
- **Many sessions at once.** 6–12 interactive Claude processes are usually alive together (`~/.claude/sessions/<pid>.json`). All of them run with `--dangerously-skip-permissions`.
- **Prompt history.** 7,065 prompts across 1,447 sessions since 2025-12-25 (`~/.claude/history.jsonl`).
- **Recent sessions.** In the last 30 days there were 153 main sessions and 761 subagent transcripts, taking 789 MB.
  - Weekly load was 22–44 sessions.
  - Activity peaks on Tuesday and Thursday, around 11:00–12:00, and continues until about 22:00.
- **Sessions last a long time.** The median session spans 52 min, the p75 spans 5 h and the p90 spans **32 h** (max 196 h). A single turn takes a median of 112 s; the p90 turn takes about 20 min.
  - *Consequence:* sessions are **left open for days** and I switch between them. Knowing which one needs me is the core problem.
- **Short prompts.** The median prompt is 54 characters: "continue", "retry", "where is the pr url?", "/backmerge the backend service then do phase 4 using /conductor".
  - *Consequence:* the context lives in the session, not in my head, so finding the right session again matters.

### Where the work happens
- **Almost everything starts from the `~/Wakecap` workspace root** (3.6k of 7k prompts). That directory is *not* a git repo; it contains about 30 repos.
  - `gitBranch` is therefore `HEAD` in most records. **Git branch is a useless grouping key.**
  - `cwd` drifts during 109 of 153 sessions as Claude `cd`s into sub-repos.
- **Other active projects:**
  - `~/Forza` (565 prompts)
  - `~/Stocks/EGX Investment Research` (525; uses `/long-scan`, `/short-scan`, `/value-scan`)
  - `wakecap-wecare-service` (515)
  - `Mobile/flutter_wakecap` (463)
  - a hackathon repo (267)

### The delivery loop (the real grouping key is the ticket)
```
Linear ticket (SAF-/ALU-/SUPRT-xxxx)
  → plan  (superpowers brainstorming → writing-plans; ~/.claude/plans, ~/Wakecap/plans/<area>/<TICKET>-*.md)
  → /conductor  (65 runs in 30 days; subagent chains up to 3 levels deep)
  → PR  (246 distinct PRs linked from sessions via `pr-link` records)
  → /backmerge  (master → staging → testing; 20 runs)
  → /releaseit, /demoit → Slack
```
- **Branches follow a pattern:** `<type>/<TICKET>-<slug>`, and commits are conventional and include the ticket ID.
- **Worktrees are used heavily.** For example, `Backend/infrastructure/.worktrees` has 37 of them, and some worktrees live inside Claude scratchpads.
- **Skills Claude actually ran (30 days):**
  - conductor 65, backmerge 20, investigate 20, preflight 11, review_plan 11
  - production_server_db 11, wecare_production_db 8, production_server_logs 6

### Tools and cost
- **Tool calls:**
  - Bash 11.3k
  - browser automation about 3.4k (claude-in-chrome 2.1k, playwright 1.4k)
  - Agent 717, Linear MCP 669, WebFetch 430, AskUserQuestion 228, Slack MCP 48
- **Models:** almost entirely `claude-opus-5`, in both main sessions and subagents.
- **Tokens (30 days):** 12.6B cache-read and 38M output in main sessions, plus 4.7B cache-read in subagents.
- **Cost:** about **$4,700** in 30 days (sum of the latest `cost-state` per session; the most expensive session was $505).
- **Outcomes (`~/.claude/usage-data/facets`):** 61 sessions "fully" achieved their goal and 41 "mostly" did. The top friction sources were buggy_code (24), tool_failure (20) and wrong_approach (19).

### Other agents
- **Codex CLI:** 5.8k rollouts in `~/.codex/sessions`, mostly `codex exec` used for second opinions (44 in September).
- **AGNC** (`agnc.wakecap.ai`): WakeCap's hosted background coding-agent service, reached via MCP.
- **Cursor and Gemini** are installed but not a focus.

## Pain points this solves

| # | Pain | Evidence | Answer |
|---|---|---|---|
| P1 | "Which of my 8 terminals is waiting for me?" | 6–12 live sessions; `status: waiting` exists in the registry | **Live Board** with a waiting-for-input alert and notification |
| P2 | "Where was that session where I fixed X?" | 1.4k sessions, short prompts, no git branch | **History & Search** (full text, ticket, PR, project) |
| P3 | "Resume it — but from which dir, with which flags?" | cwd drift; resume must start in the *original* cwd | **One-click resume** in an embedded PTY |
| P4 | Old transcripts disappear | Only 30 days kept; 1,300 sessions are no longer resumable | **Transcript Archive** + a `cleanupPeriodDays` recommendation |
| P5 | No ticket view of the work | Loop is ticket → plan → conductor → PR → backmerge | **Work Streams** grouped by ticket |
| P6 | Conductor/subagent runs are opaque | 761 subagent files, up to 3 levels deep, 233 in the background | **Subagent tree** in Session Detail |
| P7 | Cost is invisible until the bill | $4.7k in 30 days, $505 for one session | **Usage Analytics** + a per-session cost meter |
| P8 | Manual hopping between Linear, GitHub and Slack | 669 Linear calls; `/daily-update`; Slack posts | **Integrations** (GitHub P1; Linear/Slack P2) |
| P9 | Prod actions buried in transcripts | prod DB and log commands used frequently in bypass mode | **Safety badges** + **Audit log** |
| P10 | Reviewing agent output means switching between terminal, editor and GitHub | 246 PRs in 30 days; `/review`, `review this pr` prompts | **Review & Merge** (diff, inline comments to agent, PR, CI, merge) |
| P11 | Setting up an isolated checkout per ticket is manual | 37 worktrees in `infrastructure` alone; scratchpad worktrees go stale | **Worktree Manager** |
| P12 | Hitting rate limits mid-work; no view of burn rate | 12.6B cache-read tokens / 30 days, all Opus | **Limits & Budgets** |
| P13 | Sessions stall while I'm away from the desk | sessions stay open for days; `waiting` for hours | **Remote & Mobile** (Tailscale PWA, Slack DM bridge) + **Supervisor** |
| P14 | Routine work (CI fixes, review comments, daily update) always needs me to start it | `/daily-update`, "fix CI", "address comments" repeated | **Automations** + task presets |
| P15 | Notifications are easy to miss and nothing tracks them | — | **Attention Inbox** |

## Market context
Parallel-agent managers are now a crowded category (Conductor, Nimbalyst, Vibe Kanban, agent-deck, Warp, Codex app, Agent HQ, …). DeepSeek Harness (the base of zadloop) shows the same architecture choices we made: a local web UI backed by a Node process, append-only JSONL sessions, and SQLite search. What is missing across the market is **ticket-centric work streams, cost in dollars, cross-tool history, and multi-repo workspace awareness**. This project leads with those and borrows the proven ideas: inbox, worktrees, review loop, limits, automations and remote control. See [06 — Landscape & Inspiration](06-landscape-and-inspiration.md).

## Personas
1. **Me: an agent power user.** I run many sessions at once, drive them by ticket, and care most about speed of switching and recall.
2. **Squad teammates (later).** Same stack and skills (wstack, engkit, conductor). Would benefit from a shared view of work streams and AGNC runs.

## Guiding principles
1. **Local-first & private.** Everything runs on my machine and binds to `127.0.0.1`, with no telemetry. Remote access is optional and only over my own Tailscale network. Transcripts contain credentials and prod data.
2. **Read-only toward tool data; explicit and audited when acting.**
   - The app never edits `~/.claude` or `~/.codex`, except the confirmed archive restore.
   - It launches the official CLIs.
   - Git, PR, merge and input actions are **explicit** (confirmed, or allowed by a rule I enabled) and **audited**.
   - It never touches prod on its own.
3. **Zero-config discovery.** It works on first run by scanning the known locations.
4. **Tickets over branches.** Group work the way I actually deliver it.
5. **Tolerant parsing.** The Claude Code transcript format is internal and changes between versions. Unknown records are kept and ignored, never fatal.
6. **Don't replace the CLI, wrap it.** The interactive `claude` experience stays exactly the same inside the embedded terminal.
7. **Attention is the scarce resource.** Everything that needs me goes into one inbox. Everything else stays quiet.
8. **Show evidence, not claims.** Review cards show the files actually changed, test results and CI status, not what the model says it did.
