# 04 — Data Sources (parser spec)

> Everything below was observed on this machine on 2026-09-16, with Claude Code **2.1.273** and Codex CLI **0.152.1**.
> These are **internal, undocumented formats**. Parse them defensively: accept unknown fields and record types, and never crash on them.

## A. Claude Code

### A1. Live session registry: `~/.claude/sessions/<pid>.json`
- One file per interactive process. A `<pid>.<hash>.key` file sits next to each one. **Never read the `.key` files.**
- Fields:
  - identity: `pid`, `pidDomain`, `procStart`, `sessionId`, `cwd`, `startedAt`, `version`, `kind` (`interactive`), `entrypoint`
  - naming: `name`, `nameSource` (`auto`/`derived`), `nameSince`
  - status: `status` (`busy` | `idle` | `waiting` | `shell`), `waitingFor` (e.g. `"input needed"`), `statusUpdatedAt`, `updatedAt`
  - peer messaging: `messagingSocketPath` (`/tmp/cc-socks/<pid>.sock`), `peerProtocol`, `peerFeatures`
- **Liveness:** check `process.kill(pid, 0)` together with `procStart`, because pids can be reused. Files for dead processes can linger.
- The messaging socket is Claude Code's internal peer channel. **Do not write to it in v1.** Only look into it as a possible future "send message to session" feature.

### A2. Transcripts: `~/.claude/projects/<encoded-cwd>/`
```
<encoded-cwd>/
├─ <sessionId>.jsonl                      # main transcript (append-only)
└─ <sessionId>/
   ├─ subagents/agent-<agentId>.jsonl     # subagent transcript
   ├─ subagents/agent-<agentId>.meta.json # {agentType, description, toolUseId, parentAgentId, spawnDepth, requestShape?, requestNonInteractive}
   └─ tool-results/*.txt                  # large tool outputs spilled to disk
```
- **Path encoding** replaces `/ . _ space` with `-`, so it **can't be reversed** (`frontend-2.0` → `frontend-2-0`). Never decode the directory name. Take the real path from the records' `cwd` instead.
- **Subagents** nest up to 3 levels deep (719 / 38 / 4 files at depths 1 / 2 / 3). Build the tree with `parentAgentId`. `toolUseId` links a subagent to the `Agent` tool_use in its parent.

#### Message records (`type` ∈ `user`, `assistant`, `system`, `attachment`)
- **Common fields:** `uuid`, `parentUuid`, `isSidechain`, `sessionId`, `timestamp` (ISO), `cwd`, `gitBranch`, `version`, `entrypoint` (`cli` | `sdk-cli`), `userType`, `slug`. Subagent records also carry `agentId`.
- **user:**
  - `message.content` is either a string or an array of blocks.
  - Other fields: `promptId`, `permissionMode`, `origin.kind`, `promptSource`, `isMeta`.
  - A record is a **tool result** when it has `toolUseResult` + `sourceToolAssistantUUID`.
  - A record is a **real human prompt** when it has no `toolUseResult`, `isMeta` is not true, and the content is not a tool_result block.
- **assistant:**
  - `message.id` and `message.model`.
  - `message.content[]` holds blocks of type `thinking`, `text` or `tool_use` (`name`, `input`, `id`).
  - `message.usage` holds `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens_details.thinking_tokens` and `cache_creation.ephemeral_1h/5m`.
  - Other fields: `requestId`, `effort`, `attributionSkill`, `attributionMcpServer`, `isApiErrorMessage`, `apiBlockIndex`.
  - ⚠️ **One API message is split across several records.** Deduplicate usage by `message.id`.
  - The model can be `<synthetic>`; exclude it from model stats.
- **system:** read the `subtype`.
  - `turn_duration` (`durationMs`, `messageCount`)
  - `stop_hook_summary`
  - `away_summary`: free-text recap, useful as a preview
- **attachment:** context attachments. Index only their metadata.

#### Session-level records (no `uuid`, repeated often; **last one wins**)
| type | fields | use |
|---|---|---|
| `agent-name` | `agentName` | display name (highest priority) |
| `ai-title` | `aiTitle` | display name (fallback) |
| `last-prompt` | `lastPrompt`, `leafUuid` | preview + resume leaf |
| `permission-mode` / `mode` | mode value | badge (bypassPermissions is dominant) |
| `pr-link` | `prNumber`, `prUrl`, `prRepository` | PR chips, work streams (246 distinct PRs) |
| `bridge-session` | `bridgeSessionId` | remote-control link |
| `frame-link` | `path`, `frameUrl`, `title` | artifacts |
| `cost-state` | `totalCostUSD`, `totalDuration`, `totalAPIDuration`, `totalToolDuration`, `totalLinesAdded/Removed`, `startTime`, `modelUsage{model:{…tokens, costUSD}}` | authoritative **running totals** |
| `queue-operation`, `file-history-snapshot/-delta`, `atis-latch`, `artifact-*` | — | store raw or skip |

No `summary` or `custom-title` records were seen in this version, but support them if they appear.

#### Derivations
- **Resume cwd** = the `cwd` of the first record that has one. It equals history.jsonl `project` and matches the encoded directory. Don't use the last `cwd`, because it drifts in about 70% of sessions.
- **Name** = last `agent-name` → last `ai-title` → first human prompt (truncated).
- **Cost:** use the latest `cost-state` when present. Otherwise estimate it from the deduplicated usage × the price table (kept in config).
- **Tickets** = the regex `\b(SAF|ALU|SUPRT|SAK|TAN)-\d+\b` over human prompts, tool inputs (Linear MCP args, `gh` commands, branch names in Bash) and PR data. The prefix list is configurable.
- **Skills used** = `Skill` tool_use `input.skill` + `attributionSkill` + slash commands in human prompts.
- **MCP server** = `tool_use.name` matching `mcp__<server>__<tool>`.
- **Touched prod** = a skill in the prod list, or a Bash command matching the configured prod patterns.
- **Git branch:** `gitBranch` is usually `HEAD` because the root is `~/Wakecap`, which is not a repo. Treat it as low-signal and prefer branch names found in Bash commands and PRs.
- **Files touched** = `Edit` / `Write` / `MultiEdit` `input.file_path`, plus `file-history-snapshot` records.

### A3. Prompt history: `~/.claude/history.jsonl`
- One line per prompt: `{display, pastedContents, timestamp (ms), project (real cwd), sessionId}`.
- 7,065 lines and 1,447 sessions since 2025-12-25. This is the **only** source for sessions older than the transcript retention window, which gives them availability `prompts-only`.
- `pastedContents` can be large and may contain secrets, so store it redacted or leave it out.

### A4. Other Claude files
| Path | Content | Use |
|---|---|---|
| `~/.claude/usage-data/session-meta/*.json` | per-session duration, message and tool counts, git commits and pushes, lines, first_prompt | analytics enrichment |
| `~/.claude/usage-data/facets/*.json` | goal category, outcome, friction, brief_summary | outcomes/friction panel |
| `~/.claude/plans/*.md` | plan-mode plans (26) | link to sessions by time and content |
| `~/.claude/file-history/<sessionId>/` | file snapshots | Files tab |
| `~/.claude.json` → `projects{}` | per-project `lastSessionId`, `lastCost`, `lastModelUsage`…; `githubRepoPaths` | launcher cwd suggestions, repo map (**read only these keys; the file contains auth state**) |
| `~/.claude/settings.json` | `cleanupPeriodDays`, hooks, statusLine, enabledPlugins | retention warning, bridge install check |
| `~/.claude/ide/*.lock` | IDE connection (VS Code, workspace) | "open in IDE" |
| `~/.claude/.last-cleanup` | last retention sweep timestamp | archive urgency |
| `~/.claude/hooks/check-log.jsonl` | the user's post-edit check results `{ts, stack, verdict, ms, errs, file}` | optional quality panel |

**Retention:** transcripts older than about 30 days are deleted (oldest on disk: 2026-08-16). That is why the archive (F5) and a `cleanupPeriodDays` recommendation exist.

## B. Codex CLI

### B1. Rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
- **Envelope:** `{timestamp, ordinal, type, payload}`.
- **Record types:**
  - `session_meta` (first line). Payload: `id`, `session_id`, `cwd`, `cli_version`, `model_provider`, `originator`, `source`, `thread_source`, `context_window`, `history_mode`, `base_instructions`. **Skip `base_instructions` when indexing.**
  - `turn_context`: model and settings for each turn.
  - `response_item` with `payload.type` of `message`, `reasoning`, `function_call`, `function_call_output`, `custom_tool_call` or `custom_tool_call_output`.
  - `event_msg` with `payload.type` of `task_started`, `task_complete`, `item_completed`, `token_count` or `thread_settings_applied`.
  - `world_state`.
- **Filtering:** the 5.6k March rollouts came from `originator: codex_sdk_ts` (automated). They are **indexed but filtered out by default** (decided); a toggle shows them. Recent sessions are mostly `codex_exec` (second-opinion runs) plus a few interactive ones.
- **Usage:** read the last `token_count` event.

### B2. Other Codex files
- `~/.codex/session_index.jsonl`: a quick index of sessions.
- `~/.codex/history.jsonl`: typed prompts (88).
- `~/.codex/state_5.sqlite` and `thread_history_1.sqlite`: open them **read-only** (`?mode=ro`) during the M0 spike. They may hold thread names and status.
- **Live detection:** match running `codex` processes (`ps`) to their cwd and to the newest rollout file being written.
- **Resume (confirmed):** `codex resume [SESSION_ID] [PROMPT]`, run in the rollout's `cwd`. It accepts a UUID or a session name.
- **Never read** `~/.codex/auth.json`.

## C. AGNC (remote) — lowest priority, optional
- **Endpoint:** MCP server `https://agnc.wakecap.ai/mcp`, OAuth. It is configured in `~/.codex/config.toml` and appears as a claude.ai connector in Claude Code.
- **Tools, which define the data model:**
  - sessions: `agnc_list_sessions`, `agnc_get_session`, `agnc_create_session`
  - messages: `agnc_list_messages`, `agnc_send_prompt`
  - events: `agnc_list_events`
  - PRs: `agnc_create_pr`
  - model defaults: `agnc_get_model_default` / `agnc_set_model_default` (per-call `model` + `reasoningEffort`)
  - health and auth: `agnc_health`, `agnc_auth_status`
- **Handoff contract** (from the AGNC skill): repo, branch, issue/PR URL, relevant files, and what was already checked.
- **Scope:** only sessions I own (decided).
- **Unknown:** is there a REST API or a token type meant for a local app, or must we act as an MCP OAuth client? Checked by spike S4 when AGNC's turn comes. If neither works, AGNC is shown as a link-out or left out, and nothing else depends on it.

## D. Workflow context (optional enrichers)
| Path | Content | Use |
|---|---|---|
| `~/.wstack/workflows/*.env` | `WORKFLOW_ID`, `LAST_SEEN`, `REPO_SLUG`, `BRANCH` | work-stream seeds |
| `~/.wstack/projects/<slug>/timeline.jsonl` | skill started/completed events `{skill, branch, outcome, duration_s, session, ts}` | skill-run outcomes |
| `~/.wstack/projects/<slug>/checkpoints/` | context-save checkpoints | "restore context" links |
| `~/.wstack/analytics/skill-usage.jsonl` | skill usage events | analytics |
| `~/Wakecap/plans/**/<TICKET>-*.md`, `<repo>/docs/superpowers/{specs,plans}/` | plans/specs | work-stream plans |
| `~/Wakecap/agent-conductor/agents/*.md` | conductor sub-agent roles | label conductor subagents in the tree |
| git worktrees (`git worktree list`) | branch ↔ path | map cwd → repo/branch/ticket |

## E. Fixtures & tests
- Build `fixtures/` from **redacted** real samples:
  - a short session
  - a session with 3-level subagents
  - a `pr-link` session
  - a cwd-drift session
  - a session with API errors
  - a Codex rollout
- Add a test for every record type in the tables above, plus "unknown type" and "truncated last line" cases.
- Add a version matrix test: when Claude Code updates, run the parser over the live `~/.claude/projects` in `--dry-run` mode and report counts of unknown types and fields.
