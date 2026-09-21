Phase 1 of the orchestrator: the app can now index every Claude Code and Codex session on this machine, search them, and resume any one of them in a real terminal.

Built with one subagent per task and an adversarial review after each — 19 implementation tasks plus a phase exit check, each gated on `lint && typecheck && test && check:fixtures`.

## What works now

- **Indexes both tools.** 6,791 files / 7,300 sessions in ~15 s, most recent Claude session searchable in ~25 ms. Survives compaction, `/clear`, same-size rewrites, and OS file events the kernel drops under load.
- **Search.** SQLite FTS5 over prompts, assistant text and tool inputs. p95 ≈ 50 ms on the worst adversarial shape against 1,500 sessions (150 ms budget).
- **History UI.** 2,000 sessions render as ~21 DOM rows. Filters round-trip through the URL; saved views, pins, labels.
- **Session detail.** Header plus a paged timeline with grouped tool calls.
- **Resume / fork / adopt / pop-out.** Always in the session's *original* cwd, never the drifted one. A live session can't be double-launched.
- **Terminal dock.** xterm.js over a WebSocket, with server-held scrollback replayed on reload.

## Security posture

- Binds `127.0.0.1` only; every `/api/*` call needs a token (timing-safe compare); WS checks Origin; the bootstrap endpoint answers loopback only.
- **Read-only toward `~/.claude` and `~/.codex`** — audited, with an executable test as proof.
- **Redaction at the boundary.** 12 distinct leaking fields were found and closed across four adversarial rounds, including two secret-leaking snippet paths, and `startCwd`/`skills`/`filesTouched`/`mcpServers`/`waitingFor`/`tickets`. An exhaustive guard test seeds one sentinel into every field and asserts it appears in no response — that test, not a sweep table, is what holds this boundary.
- All twelve redaction patterns are now case-insensitive (a mixed-case `Ghp_` token previously passed through in clear).

## Notable bugs caught by review, not by tests

| Bug | Impact if shipped |
|---|---|
| Oversized WS frame crashed the **whole daemon** | One client kills every session + the API |
| Prefix fan-out search took **4 s** | UI freeze on ordinary two-word searches |
| Truncate-then-redact in snippets | Passwords in plain text in search results |
| History-prompt fallback had **no redaction at all** | Raw prompt text, where pasted tokens live |
| Subagents in a parent cycle vanished silently | Missing agents, no error |
| `truncate()` split a UTF-16 surrogate pair | Emoji corrupting session names |
| xterm bundled eagerly | +130% initial download for users who never open a terminal |

## Changes in this PR

- `apps/daemon` — config, SQLite + FTS5, repos, indexer, PTY manager, session service, Hono API, WS
- `apps/web` — shell, project selector, settings, session detail, history, terminal dock
- `packages/core` — parsers, aggregates, derivations, redaction
- `packages/api-contract` — zod schemas + typed client
- `plan/reviews/phase-1-exit.md` — the evidence record for every M1 criterion
- Wakecore dropped for open-source **shadcn/ui**; removed a dead `.npmrc` line that was silently disabling the whole file

## Verification

`pnpm install --frozen-lockfile` → clean · 289 unit tests · 1 perf suite · 3 Playwright e2e · both builds green.

## Known / deferred

- `FTS_PREFIX_CARDINALITY_CAP = 250` is empirical; real-text cost isn't monotonic in cardinality.
- The perf gate wants an isolated CI runner (it failed once under heavy local contention).
- Two Task 2 behaviours (cost-state precedence, PR/agent-name dedupe) are correct but unprotected by regression tests.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
