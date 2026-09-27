# @orc/mcp — `orc-mcp`

A stdio MCP (Model Context Protocol) server that lets Claude Code and Codex query the local
orchestrator daemon. It is a thin client of the daemon HTTP API and is an opt-in install.

## Tools

| Tool | Daemon route | Writes? |
|---|---|---|
| `list_live_sessions` | `GET /api/live` | no |
| `list_waiting` | `GET /api/inbox?state=open` | no |
| `search_sessions` | `GET /api/sessions?q=…` | no |
| `get_session_summary` | `GET /api/sessions/:source/:id` | no |
| `get_stream` | `GET /api/streams/:ticket` | no |
| `resume_session` | `GET /api/sessions/:source/:id`, and with `launch: true` `POST /api/sessions/:source/:id/resume` | only with `launch: true` (audited by the daemon) |

Daemon errors come back as MCP tool errors (`isError: true`). stdout carries only the MCP protocol;
logs go to stderr.

## Daemon discovery

- Token: `ORC_TOKEN`, else `$ORC_HOME/token` (written by the daemon on first start).
- URL: `ORC_URL`, else `http://127.0.0.1:$ORC_PORT`, else the `port` in `$ORC_HOME/config.json`,
  else `http://127.0.0.1:4317`.
- `ORC_HOME` defaults to `~/.orchestrator`. orc-mcp only reads these files.

## Build and install

```bash
pnpm --filter @orc/mcp build
node apps/mcp/dist/main.js --print-install
```

`--print-install` prints the two registration commands and runs neither:

```bash
claude mcp add --scope user orchestrator -- node /abs/path/apps/mcp/dist/main.js
codex mcp add orchestrator -- node /abs/path/apps/mcp/dist/main.js
```

Run them yourself to register the server. They write to your Claude Code and Codex config.

## Try it

1. Start the daemon: `pnpm --filter @orc/daemon dev`.
2. Register the server with the printed `claude mcp add` command.
3. In a scratch directory:
   `claude -p "Use the orchestrator MCP server: which of my sessions are waiting?" --model claude-haiku-4-5 --max-budget-usd 0.05`
