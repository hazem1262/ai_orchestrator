import { OrcConfig } from '@orc/api-contract';
import { projectConfigFor } from '../src/services/projects.ts';
import { FAKE_CLAUDE } from './homes.ts';

/** The config the fixture e2e daemon (`e2e-server.ts`) saves into its temp `ORC_HOME`. */
export function e2eDaemonConfig(o: { port: number; work: string; agnc: boolean }): OrcConfig {
  const wakecap = projectConfigFor({ id: 'wakecap', name: 'Wakecap', pathPrefix: o.work });
  return OrcConfig.parse({
    port: o.port,
    resumeProfile: { claudeCommand: FAKE_CLAUDE, codexCommand: FAKE_CLAUDE },
    // No PR poller against the real `gh`: it would pull the developer's own PRs into the inbox.
    github: { enabled: false },
    // AGNC runs only on the in-memory fake (`offlinePhase7`); off unless a run asks for it.
    agnc: { enabled: o.agnc },
    // `work` comes first: it is the directory the launch dialog offers by default.
    projects: [{ ...wakecap, pathPrefixes: [o.work, '/Users/test/Wakecap'] }],
  });
}
