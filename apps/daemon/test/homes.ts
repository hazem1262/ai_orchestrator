import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type OrcPaths, resolvePaths } from '../src/config.ts';

export const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
export const FAKE_BIN_DIR = fileURLToPath(new URL('./bin/', import.meta.url));
export const FAKE_CLAUDE = join(FAKE_BIN_DIR, 'claude');
export const FIXTURE_USER_HOME = '/Users/test';

export interface TempHomes {
  root: string;
  orcHome: string;
  claudeHome: string;
  codexHome: string;
  userHome: string;
  paths: OrcPaths;
  env: Record<string, string>;
  cleanup(): void;
}

export function makeTempHomes(): TempHomes {
  const root = mkdtempSync(join(tmpdir(), 'orc-test-'));
  const orcHome = join(root, 'orc');
  const claudeHome = join(root, 'claude');
  const codexHome = join(root, 'codex');
  cpSync(join(FIXTURES_DIR, 'claude-home'), claudeHome, { recursive: true });
  cpSync(join(FIXTURES_DIR, 'codex-home'), codexHome, { recursive: true });
  mkdirSync(orcHome, { recursive: true });
  const env = {
    ORC_HOME: orcHome,
    CLAUDE_HOME: claudeHome,
    CODEX_HOME: codexHome,
    ORC_USER_HOME: FIXTURE_USER_HOME,
  };
  return {
    root,
    orcHome,
    claudeHome,
    codexHome,
    userHome: FIXTURE_USER_HOME,
    paths: resolvePaths(env),
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Writes a minimal resumable transcript whose cwd exists on disk (fixture cwds do not). */
export function writeClaudeSession(
  h: TempHomes,
  o: { sessionId: string; cwd: string; prompt: string; timestamp?: string },
): string {
  mkdirSync(o.cwd, { recursive: true });
  const dir = join(h.claudeHome, 'projects', o.cwd.replace(/[/._ ]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${o.sessionId}.jsonl`);
  const rec = {
    type: 'user',
    uuid: `${o.sessionId}-u1`,
    parentUuid: null,
    isSidechain: false,
    sessionId: o.sessionId,
    timestamp: o.timestamp ?? new Date().toISOString(),
    cwd: o.cwd,
    message: { role: 'user', content: o.prompt },
  };
  writeFileSync(file, `${JSON.stringify(rec)}\n`);
  return file;
}
