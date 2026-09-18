# 06 — Landscape & Inspiration

> Researched 2026-09-16 with web research. Product facts come from the vendors' public pages, READMEs and reviews. They change quickly, so check again before relying on one.

## Where the market is (Sept 2026)
Tools for running AI coding agents in parallel have become a category of their own. Most products combine four things:
1. **Isolation:** a worktree or container per task.
2. **An attention surface:** a board or inbox that shows which agent needs you.
3. **A review loop:** diff, comment, PR, merge.
4. **Remote control:** phone approvals and chat bridges.

A newer wave adds **usage-limit tracking**, **scheduled or event-triggered agents** and **multi-agent comparison**.

**What almost nobody does, and where this project is different:**
- **Ticket-centric work streams** that follow the Linear ticket → plan → PR → backmerge → release loop.
- **Cost in dollars per ticket/project**, in addition to raw token counts.
- **One history and search across tools** (Claude Code + Codex + AGNC), including sessions older than Claude's 30-day retention.
- **Workspace-root reality:** the app understands the `~/Wakecap` multi-repo workspace with cwd drift, where most tools assume one repo per session.
- **WakeCap-specific safety:** badges for prod DB/log access, and redaction.

---

## zadloop — https://zadloop.com/
**What it is:** a **single coding agent** for Arabic-speaking developers ("a programming agent that starts with Arabic").
- macOS desktop app, free alpha (v0.1.6), bring your own model keys.
- **Built on DeepSeek Harness.**
- It is not an orchestrator for many sessions.

**Notable features**
- A four-stage flow shown to the user: **Understands → Modifies → Tests → For Review**.
- **"Every change visible":** the diff and the test results (e.g. `✓ 18 passed · 0 failed 1.4s`) plus a short plain-language explanation, all shown *before* you accept.
- Task presets: "Fix the failing test", "Simplify this function", "Add the missing test".
- Two sessions side by side; projects → sessions sidebar; status lines as it works.
- Arabic text that keeps code, paths and commands left-to-right.

**What we borrow**
| Idea | Where |
|---|---|
| "Ready for review" state with evidence (diff, test results, explanation) | F1, F15, F18 |
| Stage bar on each session card | F1 |
| Test result as a first-class signal | F1, F18 |
| Task presets | F4 |
| Side-by-side sessions | F1 layouts |
| Arabic text with left-to-right code in recaps | F12 (later) |

---

## DeepSeek Harness (dsh) — https://www.deepseek.com/harness/en/
**What it is:** DeepSeek's open-source (MIT) **agent harness**, a v0.1 developer preview. "Everything is a plugin": models, tools, sessions, sandboxes, loops, scheduling and UI all run on a small plugin kernel (Cordis).
- Runs as a Node app: `npx @deepseek-ai/dsh web` serves a local web UI on `127.0.0.1`.
- Also available as a signed Electron app, a Python SDK and an ACP server.
- **Supports many model providers** (Anthropic, OpenAI, Bedrock, Gemini, DeepSeek, OpenRouter).

**Architecture choices that confirm ours**
- A local web UI on 127.0.0.1 backed by a Node process, which is the same shape as our daemon + web app.
- Sessions stored as **append-only versioned JSONL (zstd)**, with the rule "model-visible means logged". Resume, fork, search and replay all read from that log.
- SQLite full-text search over all sessions, and the model can search that history too.
- Projects are built from existing session history on first run.

**Notable features**
- **Modes:** Standard, Code (tools exposed as an SDK), Minimal and Creator.
- **Subagents:** "spawn" (starts fresh) or "fork" (copies history). Claude Code, Codex and ACP agents can run as child processes.
  - Agents can message, interrupt and list each other.
  - Experimental Agent Teams add a roster, a task board and a mailbox.
- **Workflows:** scripted fan-out. The UI shows a tree that **expands failed or running branches and collapses finished ones**.
- **Ralph loop:** runs fresh sessions in a row, passing a structured **handoff** (status, summary, evidence, next steps, blocker) between them.
- **Goals (`/goal`):** each has a phase (`active`, `paused`, `blocked` with a reason, or `complete`) and a round cap. After a resume, a human has to re-arm the goal.
- **Jobs:** background tasks, with a **running-jobs badge** in the header.
- **Schedule:** in-session reminders delivered as messages. They survive restarts.
- **Webhooks:** a signed GitHub adapter plus code rules. A matching event creates a new session.
- **Trajectory tab:** a turn/step ledger with an inspector (tokens, duration, input/output) that follows the live tail. **Session stats:** model time vs. tool time, TTFT, decoding time, tokens per second, cache hit rate.
- **Deliverables row:** the files *actually* changed during a turn, taken from real edit events. File paths in the output open in the sidebar.
- **Subagent catalog:** live status and tokens for each child, with follow-up and stop buttons per child. Typing `@` mentions a child.
- **Permission presets:** mixed settings are detected and labelled `custom`.
- **Open-in-app split button** that remembers your editor.
- **Export** a session as a ZIP. Archive and unarchive.

**Gaps (compared with this project):** no worktrees, no diff/PR review screen, no Linear or Slack, no costs in dollars, and no board for many sessions or alerts when one is waiting. Reviewers report that agents stop partway and need a manual "continue".

**What we borrow**
| Idea | Where |
|---|---|
| Step timing stats (model/tool time, TTFT, cache hit rate, tok/s) | F2 |
| Files actually changed per turn | F2, F18 |
| Goals with state and a blocked reason | F16, F1 |
| Structured handoffs | F16 |
| Running-jobs badge | F1 |
| In-session reminders | F16 |
| Webhook rules that start sessions | F20 |
| Tree that expands failed/running branches | F2 |
| Permission preset badge | F1, F9 |
| Open-in-app split button | F4 |
| Projects built from history on first run | F13 |
| Export as ZIP | F2 |
| Agents searching past sessions | F12 (MCP server) |

---

## Other tools (summary)
| Tool | Distinctive features | Borrowed as |
|---|---|---|
| **Conductor** (conductor.build) | Worktree per workspace; git checkpoint every turn with rollback; setup/run scripts; "Spotlight" copies changes to the main checkout; diff review with comments; multi-model mode; Linear/GitHub | F17, F18, F21 |
| **Nimbalyst** (formerly Crystal) | Kanban of sessions; worktree in one click; per-file accept/reject; iOS app for reviews and answers | F18, F22 |
| **opcode** (formerly Claudia) | Timeline of checkpoints you can branch from; MCP and CLAUDE.md management; usage dashboard | F18, F12 |
| **claude-squad** | tmux + worktree per agent; `--autoyes` | F23 (safer version) |
| **Vibe Kanban** (now community-maintained) | Issue → workspace; inline diff comments go back to the agent; preview browser with devtools; AI-written PR descriptions | F18, F12 |
| **Sculptor** (Imbue) | Container per agent; two-way "pairing" sync with the local IDE | F12 (containers) |
| **Omnara** | Phone/web/Watch approvals; audit trail; approval gates; Slack | F22, F24 |
| **Happy** | End-to-end encrypted phone ↔ desktop handoff; push for permission requests; voice | F22, F12 |
| **CCManager** | Waiting/busy/idle detection for 8 CLIs; devcontainers | F1 |
| **agent-deck** | Status detection; group concurrency limits; fork with worktree; per-session MCP/skills on/off; MCP pooling; supervisor "conductor" that answers or escalates; Telegram/Slack bridge; budgets | F19, F22, F23, F12 |
| **ccusage** + CodexBar / ClaudeBar / Usage4Claude | 5-hour billing blocks, time left, burn rate, context fill; menu-bar quotas | F19 |
| **Claude Code UI / CloudCLI** | Mobile-first PWA with chat, shell, files and git | F22 |
| **Warp** | Agent management panel; notification mailbox; OS alerts when in the background | F15 |
| **Cursor cloud agents** | Event- and schedule-triggered agents; grid layout | F20, F1 |
| **Codex app / cloud** | Worktree per thread; scheduled runs that report to a review queue; `--attempts` best-of-N | F20, F21 |
| **GitHub Agent HQ** | Claude/Codex/Copilot on one task side by side; plan mode that assigns agents | F21, F4 |
| **Jules** | Scheduled tasks; suggested tasks from TODO comments; automatic fixes for failed deploys | F20 |
| **Claude Code Desktop / Agent View** | Session sidebar with filters; auto-archive when the PR merges; side chat; Verbose/Normal/Summary views; Remote Control and Dispatch | F17, F2, F22 |
| **Superset** | Built for 10–100+ agents; automations that open PRs; open in IDE in one click | F20, F4 |
| **Emdash** (YC W26) | Pulls tickets from Linear/Jira/GitHub; shows CI checks and merges; remote over SSH; recurring automations with reruns | F18, F20, F6 |

**Products that died or changed:** Terragon shut down (Feb 2026; now terragon-oss). Crystal became Nimbalyst. BloopAI shut down, and Vibe Kanban is now maintained by the community. opcode is reportedly no longer actively developed.

## Ideas considered and parked
| Idea | Why parked | Where |
|---|---|---|
| Container/devcontainer sandbox per agent | Heavy; worktrees + safety badges are enough for now | F12 |
| Built-in preview browser with devtools | Chrome/Playwright MCPs already cover this | F12 |
| Voice control | Nice to have | F12 |
| Multiplayer / team workspaces | Personal tool first | F12 |
| End-to-end encrypted relay (Happy-style) | Tailscale-only access avoids needing a relay | F22 |
| Sending input to externally started sessions via Claude's internal socket | Internal protocol; unsafe | 03 → Session control model |
| MCP process pooling | Optimization; do it only if memory becomes a problem | F12 |

## Sources
- zadloop: https://zadloop.com/ · https://zadloop.com/download
- DeepSeek Harness: https://www.deepseek.com/harness/en/ · https://github.com/deepseek-ai/deepseek-harness · docs/architecture.md · https://thenewstack.io/deepseek-harness-open-source-plugins/ · https://www.datacamp.com/tutorial/deepseek-harness · https://wavect.io/blog/deepseek-harness-enterprise-review/
- Conductor https://www.conductor.build/docs/ · Nimbalyst https://nimbalyst.com/ · opcode https://github.com/winfunc/opcode · claude-squad https://github.com/smtg-ai/claude-squad · Vibe Kanban https://github.com/BloopAI/vibe-kanban · Sculptor https://imbue.com/blog/sculptor-announce · Omnara https://www.omnara.com/ · Happy https://github.com/slopus/happy · CCManager https://github.com/kbwo/ccmanager · agent-deck https://github.com/asheshgoplani/agent-deck · ccusage https://github.com/ryoppippi/ccusage · Claude Code UI https://github.com/siteboon/claudecodeui · Warp https://docs.warp.dev/agents/using-agents/managing-agents · Cursor https://cursor.com/changelog · Codex app https://openai.com/index/introducing-the-codex-app/ · Agent HQ https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/ · Jules https://jules.google/docs/scheduled-tasks/ · Superset https://superset.sh/ · Emdash https://github.com/generalaction/emdash
