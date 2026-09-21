# 03 — Architecture & Stack

## Overview

```
                        ┌──────────────────────────── orchestrator daemon (Node 22, 127.0.0.1:4317) ────────────────────────────┐
 ~/.claude/sessions ──┐ │ COLLECT                      INDEX / STATE                 SERVE                                       │
 ~/.claude/projects ──┼─┼─▶ claude-collector ──┐                                      Hono HTTP  /api/*                        │
 ~/.claude/history  ──┘ │                      ├─▶ normalize ─▶ SQLite (+FTS5) ─────▶ WS /ws   (live events) ─────────────────┼─▶ React UI / PWA
 ~/.codex/sessions ─────┼─▶ codex-collector  ──┤   (packages/core)   ~/.orchestrator    WS /pty/:id (terminal I/O) ──────────┼─▶ xterm.js
 AGNC (optional) ───────┼─▶ agnc-collector   ──┘                         ▲                                                     │
 CC hooks (optional) ───┼─▶ POST /api/hooks ──▶ event bus ─▶ Inbox engine ┤ (rules → inbox_items → notifier fan-out)          │
 gh / Linear / Slack ───┼─▶ event poller / webhooks ─────▶ Scheduler ────┤ (croner: automations, reminders)                   │
                        │                                                 │                                                     │
                        │ ACT (all confirmed + audited)                   │                                                     │
                        │  PTY manager (node-pty)     launch / resume / fork; input only to app-owned sessions                 │
                        │  Worktree manager (git)     create / copy env / setup scripts / sync / archive                        │
                        │  Checkpoint service         snapshot to refs/orchestrator/checkpoints/*; rewind                       │
                        │  Ship service (gh)          commit / push / PR / checks / merge                                       │
                        │  Recap & handoff service    claude -p (Haiku 4.5 / Sonnet 5), redacted digests                        │
                        │  Supervisor (opt-in)        rules + small model → auto-answer or escalate                             │
                        │  Archiver                   transcripts → ~/.orchestrator/archive (zstd)                              │
                        │  Notifier                   macOS · Web Push · Slack DM (as me)                                       │
                        │  Audit log                  append-only record of every action                                        │
                        └────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                          remote access (optional): tailscale serve ─▶ PWA on phone (passkey for actions)
```

A **single long-running daemon** owns all file access, indexing, PTYs and write actions (git, PRs, input). The **browser UI** is a thin client that talks to it over HTTP and WebSocket. Later, a **Tauri shell** or an **MCP server** can use the same API.

## Repository layout (proposed)

```
orchestrator/
├─ apps/
│  ├─ daemon/          # Hono server, collectors, indexer, PTY manager, archiver, connectors
│  └─ web/             # React + Vite UI
├─ packages/
│  ├─ core/            # source-agnostic domain model + parsers (pure TS, no I/O side effects)
│  ├─ api-contract/    # zod schemas + typed client shared by daemon and web
│  └─ ui/              # (optional) thin wrappers over the shadcn/ui primitives
├─ fixtures/           # redacted sample transcripts for parser tests
├─ docs/               # these docs
└─ plan/               # implementation plans
```

## Stack

### Daemon

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Node 22 LTS** + TypeScript (run with `tsx` in dev, bundled with `tsup` to ship) | `node-pty` is a native addon and most mature on Node. Node 22 is already installed. |
| HTTP / WS | **Hono** (`@hono/node-server`) + **ws** | Small and typed. Easy to also serve the built UI. |
| File watching | **chokidar** (fsevents on macOS) | Reliable recursive watching of `~/.claude/projects` (about 900 files). |
| Incremental JSONL reading | our own tailer that stores the byte offset per file | Transcripts append only and reach tens of MB, so each file is parsed once. |
| Storage | **SQLite** via **better-sqlite3** + **Drizzle ORM**; **FTS5** for search | Zero-ops, fast, one file (`~/.orchestrator/index.db`). |
| Terminal | **node-pty** | Real TTY, so the interactive `claude` UI renders correctly. |
| Validation | **zod** | One set of schemas for parsing records and the API contract. |
| Compression | `node:zlib` zstd (gzip fallback) | Archive transcripts compress about 10×. |
| Notifications | `node-notifier` (macOS) → Tauri native later | Click-to-focus a session. |
| Logging | **pino** | Structured logs, and they can be tailed. |
| Process discovery | `ps` / `process.kill(pid, 0)` | Pid liveness checks and Codex process detection. |
| AGNC (optional, last) | **@modelcontextprotocol/sdk** client (Streamable HTTP + OAuth) | AGNC is only exposed via MCP today. It is the lowest priority, and nothing else depends on it. |
| Git / worktrees | **git CLI** via `execa` (+ `simple-git` for convenience) | Exact control over worktree, commit-tree and refs. The `gh` CLI handles PRs and checks. |
| Scheduling | **croner** | Cron automations and reminders that survive restarts (jobs are stored in SQLite). |
| Webhooks (optional) | **@octokit/webhooks** (signature verification) | GitHub events via Tailscale Funnel or a relay. The default is polling with `gh`. |
| Push | **web-push** (VAPID) | PWA notifications (F22). |
| Auth for remote actions | **@simplewebauthn/server** | Passkey step-up before sending input from a phone. |
| LLM recaps (F14) | `claude -p --model <m> --output-format json` headless (default) **or** `@anthropic-ai/sdk` with an API key | Reuses the existing Claude login and needs no extra key. Model, trigger and budget are configurable. |

> **Bun note:** Bun (1.3) is installed and used for wstack scripts. It is a good fit for tooling scripts. For the daemon, **run an M0 spike** on Bun's PTY support before choosing it over Node. The default is Node.

### Web UI

| Concern | Choice | Why |
|---|---|---|
| Framework | **React 19 + TypeScript + Vite 8** | Familiar, no SSR needed. |
| Styling | **Tailwind v4** (`@tailwindcss/vite`) | Utility-first, no runtime cost. |
| Components | **shadcn/ui** — components copied into `apps/web/src/components/ui/`, owned by this repo | Open source, MIT, no registry auth or private package to depend on. Everything imports through that one folder, so a different kit is a one-folder swap. |
| Routing | **TanStack Router** | Typed routes and search params that suit filters. |
| Server state | **TanStack Query** + WS invalidation | Live board updates are pushed, and history is fetched on demand. |
| Client state | **Zustand** | Terminal tabs, layout and selection. |
| Tables | **TanStack Table** + **TanStack Virtual** | 1.5k+ history rows; long timelines. |
| Terminal | **xterm.js** (`@xterm/xterm` + fit, web-links, search addons) | The standard choice. |
| Graphs | **@xyflow/react** (agents tree, work-stream flow) | MIT, the standard React node-graph library. |
| Charts | **echarts** (`echarts-for-react`) | Apache-2.0, handles dense time series well. |
| Command palette | **cmdk** | ⌘K. |
| Markdown | `react-markdown` + `shiki` | Assistant text and plans. |
| Diff viewer | **@git-diff-view/react** (or `react-diff-view`) | Split/unified views, inline comment widgets. |
| PWA | **vite-plugin-pwa** + responsive layouts | Installable mobile view (F22). |
| Layout | **react-resizable-panels** (dockable splits) | Side-by-side sessions, terminal and diff panes. |
| Tests | **Vitest** (+ Playwright for e2e), **Storybook** for the cards and timeline | Vitest matches the rest of the repo. |

### Tooling
- **Package manager and tasks:** pnpm workspaces. Turborepo is optional; Nx would be overkill.
- **Linting and formatting:** Biome (one tool for both, fast).
- **Quality gate:** the existing PostToolUse hook (`~/.claude/hooks/post-edit-check.sh`) already runs prettier + tsc on edited `.ts`/`.tsx` files.
- **CI (later):** GitHub Actions running typecheck, test and build.

### Later
- **Tauri 2:** menu-bar tray with the count of waiting sessions, native notifications and a global hotkey. It runs the daemon as a sidecar.
- **Orchestrator MCP server** (`@modelcontextprotocol/sdk`, stdio): tools such as `list_live_sessions`, `search_sessions`, `get_session_summary` and `resume_session`.

## Domain model (packages/core)

```ts
type Source = 'claude' | 'codex' | 'agnc';

interface Session {
  id: string;                 // source-native id
  source: Source;
  projectId: string;          // project selector (F13), e.g. 'wakecap'
  startCwd: string;           // original cwd (resume dir)
  cwds: string[];             // drift, in order
  name?: string;              // agent-name → ai-title → first prompt
  firstPrompt?: string; lastPrompt?: string; awaySummary?: string; recap?: string;  // recap = LLM recap (F14)
  startedAt: string; lastActivityAt: string;
  models: string[]; permissionMode?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd?: number };
  linesAdded?: number; linesRemoved?: number;
  prs: { repo: string; number: number; url: string }[];
  tickets: string[];          // SAF-1787 …
  skills: string[];           // conductor, backmerge …
  flags: { touchedProd: boolean; hasSubagents: boolean };
  availability: 'resumable' | 'archived' | 'prompts-only' | 'remote';
  live?: { pid?: number; status: 'busy'|'idle'|'waiting'|'shell'|'ended'; waitingFor?: string; since: string };
}

interface AgentNode { id: string; sessionId: string; parentId?: string; depth: number;
  agentType: string; description: string; background: boolean; usage: Session['usage'];
  startedAt: string; endedAt?: string; }

interface Event { sessionId: string; uuid: string; parentUuid?: string; ts: string;
  kind: 'prompt'|'assistant_text'|'tool_call'|'tool_result'|'system'|'error';
  tool?: string; mcpServer?: string; text?: string; agentId?: string; }

interface InboxItem { id: string; kind: 'waiting'|'review'|'plan_approval'|'blocked'|'error'|'tests_red'
  |'budget'|'automation_result'|'supervisor_escalation'|'pr_event'; sessionId?: string; ticket?: string;
  reason: string; createdAt: string; state: 'open'|'snoozed'|'done'|'auto_resolved'; snoozeUntil?: string; }

interface Goal { targetId: string; objective: string; state: 'active'|'paused'|'blocked'|'complete'; blockedReason?: string }

interface Handoff { sessionId: string; status: string; summary: string; evidence: string[]; files: string[];
  nextSteps: string[]; blockers: string[]; links: string[]; createdAt: string }

interface Worktree { path: string; repo: string; branch: string; base: string; ticket?: string;
  dirty: boolean; prUrl?: string; state: 'active'|'archived' }

interface WorkStream { ticket: string; sessions: string[]; prs: …; plans: string[]; stage: … }
```

SQLite tables mirror these types: `projects` (id, name, path prefixes, feature flags, scripts, budgets), `sessions` (with `project_id`, `owned_by_app`), `recaps`, `goals`, `handoffs`, `reminders`, `inbox_items`, `worktrees`, `checkpoints`, `test_results`, `budgets`, `automations`, `automation_runs`, `supervisor_rules`, `audit_log`, `push_subscriptions`, `agents`, `events`, `prs`, `tickets`, `session_tickets`, `files_touched`, `file_offsets`, `labels`, `pins`, `saved_views`, plus `events_fts` for search.

## Key flows

### 1. Live status detection (Claude)
1. Watch `~/.claude/sessions/*.json`. For each file, parse it and check `process.kill(pid, 0)`, which reports whether the pid is alive.
2. Use `status`, `waitingFor` and `statusUpdatedAt` directly. If the pid is dead, show "ended".
3. Tail the session's transcript to get the current tool, last prompt and running cost.
4. If the optional hook bridge (F10) is installed, its events override the polled state, which cuts latency to under 100 ms.
5. Emit a `session.updated` event on the WS. The UI applies it through TanStack Query cache updates.
6. A state change (`waiting`, `ready for review`, `blocked`, `error`) is passed to the inbox engine (flow 5), which creates the item and sends the notification, debounced per session.

### 2. Incremental indexing
- **Startup:** scan `history.jsonl`, all `projects/**.jsonl`, the Codex rollouts and the archive. For each file, compare `(size, mtime)` against `file_offsets`.
- **Parsing:** read only from the stored offset, parse line by line (tolerating a partial final line), map records to `Event`s, and update the `Session` aggregates in one transaction.
- **Unknown record types** are counted and skipped (the counts show on a debug page), so a new Claude Code version does not break the app.
- **Budget:** the first full index of about 800 MB should take under 60 s (a Python prototype read all main sessions in 4.6 s).

### 3. Resume
```
UI "Resume"  →  POST /api/sessions/:id/resume {mode: 'embedded'|'external', fork?: bool}
daemon: if session.live → 409 {focus: pid}
        cwd = session.project ; assert exists
        cmd = profile.claude.command  (default: claude --dangerously-skip-permissions)
        args = ['--resume', id, ...(fork ? ['--fork-session'] : [])]
        embedded → pty.spawn(cmd, args, {cwd, env: process.env, cols, rows}) → ptyId
        external → osascript Terminal / `code --new-window cwd` + send text
UI opens WS /pty/:ptyId  (binary frames; resize messages)
```
- PTYs outlive a browser refresh. A scrollback ring buffer is replayed when the UI reconnects.
- When the daemon shuts down, it sends SIGHUP to child PTYs after asking for confirmation if any are busy.

### 4. Session control model
The CLIs don't offer an official way to send input to a running interactive session from outside, so the app uses clear ownership levels:

| Level | Which sessions | What the app can do |
|---|---|---|
| **Observed** | started outside the app (your terminals, VS Code) | read status and transcript, notify, open diff, copy resume command |
| **Owned** | launched, resumed or forked by the app in its own PTY | everything above **plus** send input (replies, review comments, reminders, supervisor answers), stop, checkpoint per turn |
| **Adopt** | an observed session whose process has ended | one click resumes it inside the app, which makes it owned |

- Claude's internal `messagingSocketPath` is **not used**, because it is an internal protocol.
- Input goes to owned sessions by writing to the PTY. Spike S8 checks this against the TUI (bracketed paste, waiting for the prompt to be idle).
- Headless automations use `claude -p … --output-format stream-json` (with `--resume` to continue) instead of a PTY.

### 5. Attention inbox engine
- **Inputs:** live status changes, hook events, test-result parsing, the budget meter, the scheduler, the GitHub/Linear/Slack pollers and the supervisor.
- **Rules:** they turn those inputs into `inbox_items`. Items are deduplicated per session and kind, and **resolved automatically** when the condition clears.
- **Notifier:** fans items out by per-kind preferences to macOS notifications, Web Push, or a Slack DM when away mode is on.

### 6. Worktrees, checkpoints and shipping
- **Create:**
  1. `git -C <repo> worktree add -b <type>/<TICKET>-<slug> <path> <base>`
  2. Copy the configured gitignored globs.
  3. Run the `setup` script in a PTY and stream its output.
- **Checkpoint** (owned sessions, at each `Stop`/turn end):
  1. Use a temporary index: `GIT_INDEX_FILE=tmp git add -A`, then `git write-tree`, then `git commit-tree`.
  2. Point `refs/orchestrator/checkpoints/<session>/<n>` at the result.
  3. HEAD, the real index and the stash stay untouched.
  4. Old checkpoints are pruned after the PR merges.
- **Rewind:**
  1. Take a checkpoint of the current state.
  2. `git restore --source=<ckpt> --worktree -- .`
  3. Needs confirmation and is audited.
- **Ship:**
  - `gh pr create` (body from the repo's template + recap + ticket), `gh pr checks --watch` in the poller, and `gh pr merge` (with confirmation).
  - Backmerge launches the `/backmerge` template in a session.

### 7. Automations and events
- **Scheduler:** croner jobs stored in SQLite, fired at most once even across restarts.
- **Event pollers:**
  - GitHub via `gh api` (notifications, my PRs' checks and reviews), every 60–120 s.
  - Linear via the SDK (assigned issues).
  - Slack via `conversations.history`/search for mentions.
  - Webhooks are optional later.
- **Run:**
  1. Check concurrency and budget (F19).
  2. Create a worktree if the automation needs one.
  3. Launch headless or in a PTY.
  4. Stream the output.
  5. Recap it.
  6. Create an `automation_result` inbox item.
  7. Write the audit entry.

### 8. Limits and budgets
- The usage meter adds up deduplicated usage from transcripts into rolling **5-hour blocks** and **7-day** windows, like ccusage, and computes burn rate and projections.
- An official limit source (e.g. statusline input or the `/usage` data) replaces the estimate if spike S7 finds one.
- Budgets are checked before launches and during runs. An automation or supervisor that goes over budget is paused.

### 9. Remote access
- The daemon still binds to `127.0.0.1`. `tailscale serve` exposes it only inside the tailnet, over HTTPS.
- **Every request needs the token.** Actions that change state (send input, approve, merge) from a device other than the local browser also need a passkey (WebAuthn) session.
- **Checks on remote requests:** the Tailscale identity headers (`Tailscale-User-Login`) must match the configured user.
- **Slack DM bridge:** polls the DM thread for my replies. Only messages from my own user ID are accepted.

### 10. Supervisor
- **Rules come first:** regex/intent allow-list and deny-list.
- **Classifier:** a Haiku 4.5 call gets the redacted pending question plus recent context and returns `{answer|escalate, confidence, reason}`.
- **Decision:** the supervisor answers automatically only on an allow-list match with high confidence and no deny-list match, and only within its caps.
- **Logging:** every decision is audited.

### 11. AGNC (optional, lowest priority)
- Connect with the MCP client over Streamable HTTP to `https://agnc.wakecap.ai/mcp` using OAuth (browser flow, with the token stored in the macOS Keychain via `keytar` or `@napi-rs/keyring`).
- Poll `agnc_list_sessions` every 30 s, and poll `list_events` and `list_messages` for opened sessions only.
- Actions: `send_prompt`, and later `create_session` and `create_pr`.

### 12. Connectors
```ts
interface Connector {
  id: 'linear'|'github'|'slack'|'agnc';
  status(): Promise<'ok'|'unauthenticated'|'error'>;
  enrich?(s: Session): Promise<Partial<Session>>;   // e.g. PR state, ticket title
  actions?: Record<string, (input: unknown) => Promise<unknown>>;
}
```
- **GitHub:** wraps the `gh` CLI, which is already authenticated.
- **Linear and Slack act as me** (decided): no bot identity.
  - **Linear:** `@linear/sdk` with my personal API key or a user OAuth token.
  - **Slack:** `@slack/web-api` with a **user token** (`xoxp`, user scopes such as `chat:write`, `channels:read`), obtained through a one-time OAuth flow. Alternatively, connect to Slack's or Linear's hosted MCP servers as an MCP OAuth client, using the same client as AGNC.
  - The claude.ai connectors used inside Claude Code **can't be reused** by the daemon, so it needs its own token.
  - All tokens are stored in the macOS Keychain.

## Security & privacy
- **Bind to `127.0.0.1` only.** A random per-install token is required on every HTTP and WS request. It is injected into the served UI and a CSRF-safe header is checked. This matters because the PTY endpoint is effectively a local shell.
- **Origin check** on WebSocket upgrades.
- **No outbound traffic** except through connectors the user has enabled. No telemetry.
- **Read-only** access to `~/.claude` and `~/.codex`. The only writes are the explicit archive restore, which requires confirmation, and hook installation, which shows the diff and needs approval.
- **Write actions** (git, PRs, merges, PTY input, integration posts) are **explicit**: either confirmed in the UI or allowed by a rule I enabled. **Every one is written to the audit log** (F24).
  - Merges always need confirmation.
  - Automations and the supervisor **never** merge, deploy, touch prod or run destructive git commands (shared deny-list, F9).
- **Remote:** Tailscale only, with no public exposure. Remote actions need a passkey. The PWA caches no transcript content offline.
- **Redaction** is applied at display time and in FTS snippets: GitHub/OpenAI/Anthropic/Slack/AWS token patterns, `postgres://…:pass@`, and `password=`/`secret=`. The raw data is still in the local DB, so the DB file uses `0600` permissions.
- **Secrets never go to connectors.** Slack and Linear summaries are generated from redacted text only.
- **Known local risks found during research** (fix them outside this project):
  - `~/Wakecap/.mcp.json` contains a plaintext GitHub PAT. Rotate it and move it to the Keychain or an env var.
  - About 8 files in `~/Wakecap/.claude/commands/` contain plaintext credentials.
  - Every live session runs with `--dangerously-skip-permissions`. The Safety badges (F9) make this visible.

## Performance targets
| Metric | Target |
|---|---|
| Cold index of about 800 MB | < 60 s |
| Incremental update after an append | < 200 ms |
| Live status latency (polling / hook) | < 2 s / < 100 ms |
| History search (FTS, 1.5k sessions) | < 150 ms |
| Daemon idle memory | < 150 MB |
| Inbox item created after a state change | < 2 s |
| Checkpoint snapshot (typical repo) | < 1 s |
