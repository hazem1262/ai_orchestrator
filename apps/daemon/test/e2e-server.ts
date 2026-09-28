import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveConfig } from '../src/config.ts';
import { createDaemon } from '../src/main.ts';
import { e2eDaemonConfig } from './e2e-config.ts';
import { offlinePhase7 } from './fakes/phase7.ts';
import { e2eRoot, makeTempHomes, writeClaudeSession } from './homes.ts';
import { offlinePhase6 } from './p6-connector-fakes.ts';

const port = Number(process.env.ORC_E2E_PORT ?? 4399);
// Unique per run unless the Playwright config pinned ORC_E2E_ROOT; the specs read the launch
// directory from ORC_E2E_WORK, which the config derives from the same root.
const root = e2eRoot();
const homes = makeTempHomes({ root });
// A launched PTY inherits the daemon's own environment (`sanitizedChildEnv`), so the temp homes
// have to be on it: without CLAUDE_HOME the fake `claude` falls back to echo mode, writes no
// registry entry, and every launch blocks for the full discovery timeout before returning a null
// sessionId. `WSTACK_HOME` rides along so the stream service reads an empty temp workflows dir,
// never the developer's real ~/.wstack.
Object.assign(process.env, homes.env);
const work = process.env.ORC_E2E_WORK ?? join(root, 'work', 'Wakecap');
mkdirSync(work, { recursive: true });

// The fixture `s-subagents` records cwd `/Users/test/Wakecap`, which does not exist here, so a
// resume of it would fail with `cwd_missing`. Point the copied transcript at `work` instead.
const subagents = join(homes.claudeHome, 'projects', '-Users-test-Wakecap', 's-subagents.jsonl');
writeFileSync(
  subagents,
  readFileSync(subagents, 'utf8').replaceAll('"cwd":"/Users/test/Wakecap"', `"cwd":${JSON.stringify(work)}`),
);

saveConfig(homes.paths, e2eDaemonConfig({ port, work, agnc: process.env.ORC_E2E_AGNC === '1' }));
writeClaudeSession(homes, {
  sessionId: 'e2e-resume',
  cwd: join(work, 'e2e'),
  prompt: 'e2e resumable session',
  timestamp: '2026-09-10T08:00:00.000Z',
});

// Phase 6 stays in the process: an in-memory secret store, fake Linear/Slack APIs, no push
// service, no `ioreg` and no `tailscale`.
const daemon = await createDaemon({
  paths: homes.paths,
  launchExternal: async () => undefined,
  phase6: offlinePhase6(),
  phase7: offlinePhase7(),
});
const running = await daemon.start({ port, watch: false });
console.log(`e2e daemon ready on http://127.0.0.1:${running.port}`);

const stop = () => {
  running
    .close()
    .catch(() => undefined)
    .finally(() => {
      homes.cleanup();
      process.exit(0);
    });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
