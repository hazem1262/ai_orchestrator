# 05 — Roadmap

Each milestone is meant to be usable on its own. Plans for each milestone go in `../plan/`. Planning uses superpowers brainstorming → writing-plans; implementation can then use `/conductor`, following the Wakecap workflow.

## M0 — Spikes (de-risk), ~2–3 days
| Spike | Question | Exit |
|---|---|---|
| S1 Parser | Can `packages/core` parse **all** current `~/.claude/projects` files with zero crashes and a known list of unknown types? | A dry-run report with counts. It matches the known numbers (153 sessions, 761 subagents, 246 PRs, about $4.7k from cost-state). |
| S2 PTY | Does `claude --resume <id>` render correctly and survive resizing in node-pty + xterm.js, including the fullscreen TUI (`tui: fullscreen`)? Does Bun's PTY work well enough to replace Node? | A demo page where resume, typing, resize and reconnect all work. |
| S3 Live status | Is watching the `sessions/*.json` registry enough for "waiting" detection, or do we need the hook bridge? | Measured latency; a decision recorded. |
| S4 AGNC (**optional, lowest priority**) | Can a local app authenticate (MCP OAuth client or API token) and list sessions and events? | A working `list_sessions` call from Node, or a documented blocker. |
| S5 Codex | Map rollouts ↔ live processes; check whether `state_5.sqlite` gives names and status. | Notes added to doc 04. |
| S6 Wakecore | Can `@wakecap/core-ui` be consumed from a standalone Vite app (package registry, peer deps, Tailwind v4 preset)? | Yes → use it; no → shadcn/ui with Wakecore tokens copied in. |
| S7 Quota data | Is there an official source for 5-hour/7-day limits (statusline input, `/usage`, API headers), or do we estimate from transcripts the way ccusage does? | Chosen data source; estimate within 10% of what Claude shows. |
| S8 Input to owned sessions | Can text be sent reliably to `claude` running in node-pty (bracketed paste, detecting the idle prompt, multi-line)? | 50/50 scripted replies land correctly, with no stray keystrokes. |
| S9 Remote | `tailscale serve` + PWA install + Web Push on iOS/Android + passkey step-up. | Phone gets a push and can answer an owned session. |

## M1 — History, Search & Resume (first usable version)
- **Daemon skeleton:** Hono, SQLite/Drizzle, indexer, file offsets, token auth.
- **Collectors:** Claude (transcripts + history.jsonl) and Codex (rollouts).
- **UI:**
  - project selector (auto-built from history, default Wakecap; F13)
  - History list with filters and full-text search (F3)
  - basic Session Detail: header + timeline (F2)
  - resume, fork and adopt into the embedded terminal, plus pop-out (F4)
- **Exit:**
  - Any session from the last 30 days is found by keyword in under 150 ms.
  - One click resumes it in the correct cwd.
  - Sessions that only exist in prompt history appear as `prompts-only`.

## M2 — Live Board, Attention Inbox & Archive
- **Live Board (F1):**
  - registry watcher and pid liveness
  - live WS events
  - card states (waiting, ready for review, error, ended)
  - background-job and permission badges
  - test-result chip
  - split layout
- **Attention Inbox (F15):** inbox engine, macOS notifications, keyboard triage.
- **Launch (F4):** launch dialog with workflow templates and task presets.
- **Transcript Archive (F5):** archiver, restore, retention warning.
- **Exit:**
  - All running Claude and Codex sessions are visible.
  - Anything that needs me shows in the inbox within 2 s.
  - No transcript is lost after 30 days.

## M3 — Session Detail, Safety & Audit
- **Session Detail (F2):**
  - timeline with step inspector and timing stats
  - deliverables row
  - Summary/Normal/Verbose modes
  - agents tree (failed/running branches expanded) and conductor rendering
  - usage chart, Files, Links and Raw tabs
  - export
- **Safety (F9):** badges, redaction, shared deny-list.
- **Audit log (F24).**
- **Command palette (F8).**
- **Exit:** a `/conductor` session can be understood without opening the terminal, and every action the app takes shows in the audit log.

## M4 — Worktrees, Review & Merge (+ GitHub)
- **Worktree Manager (F17):**
  - discovery
  - create from ticket (env copy, setup/run/archive scripts)
  - open in IDE, sync to main checkout
  - archive when the PR merges
  - coexists with `/conductor`
- **Review & Merge (F18):**
  - diff viewer and review summary card
  - inline comments sent to the agent
  - per-turn checkpoints and rewind
  - partial revert
  - commit/push/PR/checks/merge
  - backmerge action
- **GitHub connector (F11):** PR state and events → inbox.
- **Plan-approval step** in launch (F4).
- **Exit:** ticket → worktree → agent → review with inline comments → PR → merged → worktree archived, without leaving the app.

## M5 — Work Streams, Analytics, Limits, Recaps, Goals
- **Work Streams (F6):** ticket detection, stream view, stages, optional kanban.
- **Usage Analytics (F7).**
- **Limits & Budgets (F19):** quota bars, burn rate, context fill, budgets, concurrency cap.
- **LLM recaps (F14)** and **Goals & Handoffs (F16):** including reminders and "resume fresh with handoff".
- **Real-time bridge (F10):** hook bridge and statusline.
- **Exit:**
  - "What happened on SAF-xxxx, what did it cost, and what's next" is answered on one screen.
  - Quota warnings arrive before I hit the limit.

## M6 — Linear, Slack & Remote/Mobile
- **Linear connector** (as me): enrich streams, follow-up tickets, post recaps and handoffs as comments.
- **Slack connector** (as me): post recaps and daily updates, and the **DM bridge** (F22).
- **Remote & Mobile (F22):** Tailscale PWA, Web Push, passkey step-up, away mode.
- **Exit:**
  - A waiting session is answered from my phone (PWA or Slack DM thread).
  - The daily update is posted from the app.

## M7 — Automations, Compare, Supervisor & more
- **Automations (F20):** scheduler, GitHub/Linear/Slack triggers, suggested tasks, run history.
- **Compare Mode (F21).**
- **Supervisor Agent (F23):** opt-in, rules first, audited.
- **AGNC (optional, lowest priority):** only if spike S4 succeeds.
- **Packaging:** Tauri 2 shell (tray with waiting count and quota, hotkey).
- **Orchestrator MCP server:** Claude/Codex can query, search and resume sessions.
- **Items from F12, as needed.**
- **Exit per item:**
  - Each can be turned off.
  - Budget and deny-list are enforced.
  - Every action is audited.

## Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Claude Code transcript/registry format changes (internal, undocumented) | Parser breaks | Tolerant parsing, unknown-type counters, fixtures per version, dry-run check after each CLI update |
| Resuming a session that is live elsewhere | Two processes write one transcript | Liveness guard (409 + focus), plus a warning when the pid check is uncertain |
| PTY endpoint = local shell | Local privilege risk from malicious web pages | Bind to 127.0.0.1, per-install token, Origin check, no CORS |
| Secrets in transcripts | Leak via UI, search snippets or connectors | Display-time redaction, 0600 DB, connectors get redacted text only |
| AGNC only reachable via MCP OAuth | Integration effort | Lowest priority; spike S4 when its turn comes; fall back to a link-out or leave it out |
| Index size (hundreds of MB of text) | Disk and memory use | FTS only over prompts, assistant text and tool inputs; tool outputs stay on disk and load lazily |
| Wakecore not consumable outside the monorepo | UI delay | shadcn fallback (S6) |
| Git actions on real repos (worktrees, rewind, merge) | Lost work or bad merges | Checkpoint before every rewind; refuse to archive dirty worktrees; confirm every merge; audit everything; never force-push |
| Sending input into a TUI through a PTY | Garbled or misdirected replies | Spike S8; only owned sessions; wait for the idle prompt; bracketed paste |
| Remote exposure of a local shell | Account takeover means code execution | Tailscale only, token, Tailscale identity check, passkey step-up for actions |
| Supervisor answers wrongly | Agent goes the wrong way | Opt-in; allow-list only; deny-list; caps; audit and "that was wrong" feedback |
| Quota figures are estimates | Misleading limit bars | Label them "estimated" until S7 finds an official source |
| Automations run up cost | Budget overrun | Off by default; budgets and concurrency caps; they never merge |
| Scope growth (24 features) | Slow delivery | Each milestone is usable on its own; F20–F23 wait until M1–M5 have proven their value |

## Decisions (answered 2026-09-16)
| # | Question | Decision |
|---|---|---|
| 1 | Should the archive keep `tool-results/` and `file-history`? | **No, not initially.** Archive only the main transcript and subagent transcripts. Revisit later. |
| 2 | Default resume profile? | **`--dangerously-skip-permissions`** for every project. It can still be edited in Settings. |
| 3 | Codex `codex_sdk_ts` (automated) sessions? | **Index them but filter them out by default.** A filter toggle shows them. |
| 4 | AGNC scope? | **Only sessions I own.** |
| 5 | Slack/Linear identity? | **As me**, using my user OAuth token (not a bot). |
| 6 | Other projects (Forza, Stocks)? | **Add a project selector** (low complexity, see F13). **Wakecap is the default and main focus**; ticket-based work streams are Wakecap-only at first. |
| 7 | LLM session recaps? | **Yes, and fully configurable** (see F14). |
| 8 | Recap model defaults? | **Confirmed:** `claude-haiku-4-5` for automatic recaps and `claude-sonnet-5` for on-demand recaps. Both can be changed in Settings. |
| 9 | AGNC login from a local app? | **Unknown, and AGNC is the lowest priority.** It's treated as optional. If a local login doesn't work, AGNC shows as a link-out (or is left out) and nothing else is blocked. |
| 10 | Which ideas from the market research to adopt? | **All four groups:** review & attention inbox, worktrees + diff review, limits/budgets/automations, remote & mobile control. See [06](06-landscape-and-inspiration.md). |

## Remaining open questions
None blocking. AGNC feasibility gets checked whenever its turn comes (S4, optional).
