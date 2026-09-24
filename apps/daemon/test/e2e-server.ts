import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { saveConfig } from '../src/config.ts';
import { createDaemon } from '../src/main.ts';
import { projectConfigFor } from '../src/services/projects.ts';
import { FAKE_CLAUDE, makeTempHomes, writeClaudeSession } from './homes.ts';

const port = Number(process.env.ORC_E2E_PORT ?? 4399);
// A fixed root, resolved through realpath because a launched child reports its physical cwd on
// macOS: the Playwright spec computes the same path and asserts the launch dialog offers it.
const root = join(realpathSync(tmpdir()), 'orc-e2e');
const homes = makeTempHomes({ root });
// A launched PTY inherits the daemon's own environment (`sanitizedChildEnv`), so the temp homes
// have to be on it: without CLAUDE_HOME the fake `claude` falls back to echo mode, writes no
// registry entry, and every launch blocks for the full discovery timeout before returning a null
// sessionId.
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

const wakecap = projectConfigFor({ id: 'wakecap', name: 'Wakecap', pathPrefix: work });
saveConfig(
  homes.paths,
  OrcConfig.parse({
    port,
    resumeProfile: { claudeCommand: FAKE_CLAUDE, codexCommand: FAKE_CLAUDE },
    // `work` comes first: it is the directory the launch dialog offers by default.
    projects: [{ ...wakecap, pathPrefixes: [work, '/Users/test/Wakecap'] }],
  }),
);
writeClaudeSession(homes, {
  sessionId: 'e2e-resume',
  cwd: join(work, 'e2e'),
  prompt: 'e2e resumable session',
  timestamp: '2026-09-10T08:00:00.000Z',
});

const daemon = await createDaemon({ paths: homes.paths, launchExternal: async () => undefined });
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
