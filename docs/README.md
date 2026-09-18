# Orchestrator

A local-first command centre for the way I actually use AI coding agents.

- **See everything:** one screen shows every running Claude Code and Codex session, with AGNC optional. An **attention inbox** collects everything that needs me.
- **Find and resume:** I can search every past session and resume it in an embedded terminal with one click.
- **Review and ship:** agent work gets its own worktree, a review screen with diffs, comments sent back to the agent, and a path to PR and merge.
- **Track limits:** cost, quota and budgets are tracked.
- **Unblock remotely:** stalled sessions can be unblocked from my phone.
- **Later:** automations, compare mode and a supervisor agent.

Linear, Slack and GitHub integrations get added over time.

> Status: **design phase**. These docs describe what to build and with what. No code exists yet.

## Decisions so far

| Topic | Decision |
|---|---|
| Form factor | **Local web app**: a Node daemon plus a React UI served on `127.0.0.1`. It can be wrapped in Tauri later. |
| Resume UX | **Embedded terminal**: `claude --resume <id>` runs in a PTY in the session's original cwd and streams to xterm.js, with a "pop out" button. |
| Sources | **Claude Code (local)** and **Codex CLI (local)** first. **AGNC (remote)** is the lowest priority and optional, depending on whether a local app can log in. |
| Integrations | Linear, Slack and GitHub come after the core works. They act **as me** (user OAuth token, no bot). |
| Projects | A **project selector**, defaulting to **Wakecap** (the main focus). Ticket-based work streams are Wakecap-only at first. |
| Resume flags | `--dangerously-skip-permissions` by default |
| AGNC scope | Only sessions I own |
| Codex automated runs | Indexed, but hidden by default |
| Archive | Main and subagent transcripts only (no `tool-results/` or `file-history` for now) |
| LLM recaps | Yes, **configurable** (on/off, trigger, engine, model, budget). Defaults: Haiku 4.5 for automatic recaps, Sonnet 5 for on-demand ones. |
| Mode | Read-only against tool data (`~/.claude`, `~/.codex`). Git, PR, merge and input actions are explicit (confirmed or allowed by a rule) and written to an **audit log**. |
| Session control | The app can send input **only to sessions it launched or resumed** in its own terminal ("owned"). Sessions started elsewhere are watched only, and can be adopted once they end. |
| Market ideas adopted | Attention inbox and review, worktrees and diff review, limits, budgets and automations, remote and mobile control (see doc 06). |
| Remote access | **Tailscale only** (`tailscale serve`), with a passkey required for actions. The app is never exposed publicly. |
| Safety for automation | Automations and the supervisor are opt-in, have budget caps, and **never** merge, deploy or touch prod. |

## Docs

1. [Vision & insights](01-vision-and-insights.md): why this exists, based on real usage data
2. [Features](02-features.md): the modules, user stories and priorities
3. [Architecture & stack](03-architecture-and-stack.md): components, technology choices and security
4. [Data sources](04-data-sources.md): parser spec for Claude, Codex and AGNC data
5. [Roadmap](05-roadmap.md): milestones, exit criteria, risks and decisions
6. [Landscape & inspiration](06-landscape-and-inspiration.md): zadloop, DeepSeek Harness and about 20 similar tools, and what we borrow from each

## Glossary

- **Session**: one agent conversation (a Claude `sessionId`, a Codex rollout, or an AGNC session).
- **Live session**: a session whose process is running right now.
- **Work stream**: all sessions, plans, PRs and backmerges that belong to one Linear ticket.
- **Resumable**: the full transcript still exists on disk (Claude deletes transcripts after 30 days by default).
- **Owned session**: a session running inside the app's terminal, which the app can send input to.
- **Inbox item**: something that needs me (waiting, ready for review, blocked, error, budget, automation result…).
- **Handoff**: a structured summary (status, evidence, next steps, blockers) used to continue work in a fresh session or post it to a ticket.
