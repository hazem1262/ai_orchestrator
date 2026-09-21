import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { saveConfig } from '../src/config.ts';
import { createDaemon } from '../src/main.ts';
import { projectConfigFor } from '../src/services/projects.ts';
import { FAKE_CLAUDE, makeTempHomes, writeClaudeSession } from './homes.ts';

const port = Number(process.env.ORC_E2E_PORT ?? 4399);
const homes = makeTempHomes();
const work = join(homes.root, 'work', 'Wakecap');
mkdirSync(work, { recursive: true });

const wakecap = projectConfigFor({ id: 'wakecap', name: 'Wakecap', pathPrefix: '/Users/test/Wakecap' });
saveConfig(
  homes.paths,
  OrcConfig.parse({
    port,
    resumeProfile: { claudeCommand: FAKE_CLAUDE, codexCommand: FAKE_CLAUDE },
    projects: [{ ...wakecap, pathPrefixes: ['/Users/test/Wakecap', work] }],
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
