---
description: Start the orchestrator daemon (4317) and web UI (5173) for local use
---

Start the orchestrator system locally. Work from `/Users/hazem/orchestrator`. Do NOT start `apps/mcp` (it is a stdio MCP server) and do NOT use root `pnpm dev` (it starts mcp too).

1. Check which ports are already listening. Skip starting whichever is already up.

   ```bash
   for p in 4317 5173; do lsof -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && echo "$p: up" || echo "$p: free"; done
   ```

2. Start each server that is not up, each in its own Bash call with `run_in_background: true`:
   - Daemon: `cd /Users/hazem/orchestrator && pnpm --filter ./apps/daemon dev`
   - Web UI: `cd /Users/hazem/orchestrator && pnpm --filter ./apps/web dev`

3. Wait for readiness in ONE Bash command (foreground `sleep` alone is blocked, so use this bounded loop, up to ~60s). Any HTTP response counts as up.

   ```bash
   for url in http://127.0.0.1:4317/ http://localhost:5173/; do
     n=0
     until curl -s -o /dev/null "$url" || [ "$n" -ge 60 ]; do n=$((n+1)); sleep 1; done
     if curl -s -o /dev/null "$url"; then echo "UP   $url"; else echo "DOWN $url"; fi
   done
   ```

4. If either is DOWN, read the last ~30 lines of that server's background output and state the cause (for example: port in use, missing dependencies — run `pnpm install`, TypeScript or Vite error).

5. Finish by printing:
   - Web UI: http://localhost:5173
   - Daemon API: http://127.0.0.1:4317
   - To stop both: `lsof -ti:4317,5173 | xargs kill`
